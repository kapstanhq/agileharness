// sentinel-run.ts — o LAÇO da Sentinela: acha as causas, tenta o conserto determinístico, e só então decide (por causa)
// se nasce uma sessão. A decisão é PURA (sentinel.ts); aqui é o controle de fluxo, com DI para o teste (`runSentinelBoard`)
// e a fábrica das deps de produção (`productionSentinelDeps`) + os gatilhos (`requestSentinelSweep`).
//
// QUEM A ACORDA (por evento, não por relógio): um card que muda (o canal de notificações → orchestrator-wake), um run que
// termina (o `onIdle` do engine → orchestrator-wake) e a varredura periódica do serviço (o timer do orquestrador, que
// agora custa $0: um LLM só nasce para uma causa NOVA). Toda varredura é idempotente — uma causa já tratada nas últimas
// 24h não acorda de novo —, então acordar muitas vezes é barato.
//
// A ORDEM, por board:
//   1. as causas do board (o cockpit: run parado, merge/deploy que falhou, condutor morto, card esquecido…);
//   2. as NOVAS (sem despertar na janela). Nenhuma ⇒ fim, $0;
//   3. o passe DETERMINÍSTICO ($0: zelador, recuperação, card de conserto pela regra) e uma releitura — o que sumiu foi
//      resolvido sem LLM e é registrado assim;
//   4. para o que sobrou, a decisão pura (teto do dia do board e do host com as reservas em voo, cota, o interruptor
//      geral, o modo da caixa e a prontidão do conserto) — no máximo UMA sessão por board por varredura (as demais causas
//      esperam a próxima: o custo não explode numa rajada);
//   5. o registro antes de nascer, RESERVANDO o teto do despertar (o «um disparo por causa» e o teto sobrevivem a um
//      restart no meio), cada comando ENQUANTO a sessão roda, e o desfecho ao morrer. Um despertar que ficou órfão (o
//      serviço reiniciou) é fechado na varredura seguinte ({@link reconcileOrphanWakes}).
//
// O PASSE DETERMINÍSTICO NÃO FURA OS PORTÕES DO BOARD. Ele move, re-tenta e fecha ciclos em cards: antes ele rodava só
// dentro do tique, depois dos portões de modo autônomo, do `orchestrator.enabled` e do lease do humano. A Sentinela roda
// em todo board — então o passe só roda onde aqueles portões deixam ({@link SentinelRunDeps.deterministicAllowed}); num
// board pareado ou com o dono no comando, ela só diagnostica.

import { appendSentinelEntry, readSentinelLog, type AppendSentinelInput } from "./sentinel-log";
import {
  SENTINEL_HOST_BOARD,
  SENTINEL_IN_PROGRESS,
  causeAlreadyWoken,
  causeFromCapacity,
  causesFromCockpit,
  causesFromHealth,
  causesFromHostConfig,
  decideSentinelWake,
  orphanedWakes,
  type SentinelCause,
  type SentinelCockpitItem,
  type SentinelLogEntry,
  type SentinelMode,
  type SentinelNoLlmWhy,
  type SentinelRepairReadiness,
} from "./sentinel";
import type { SentinelRunResult } from "./sentinel-spawn";

/** O que o laço ouve de uma sessão em voo (o registro não espera o fim). */
export interface SentinelWakeHooks {
  onStart?: (pid: number | undefined, mode: SentinelMode, downgraded?: string) => void;
  onCommands?: (commands: string[]) => void;
}

export interface SentinelRunDeps {
  /** as causas ATUAIS de um board (ou do host, com {@link SENTINEL_HOST_BOARD}). */
  collect: (board: string) => Promise<SentinelCause[]>;
  /** o conserto determinístico ($0) do board; o host não tem. Nunca deve lançar. */
  deterministicPass: (board: string) => Promise<void>;
  /**
   * O passe determinístico pode rodar NESTE board agora? Os portões que o tique aplicava antes dele: o copiloto ligado
   * (`orchestrator.enabled`), o board em modo autônomo e nenhum humano no comando (lease). Ausente ⇒ pode (o contrato
   * antigo dos testes).
   */
  deterministicAllowed?: (board: string) => Promise<boolean>;
  /** a caixa `sentinel` do perfil de autonomia (true ⇒ conserto). */
  sentinelBox: (board: string) => Promise<boolean>;
  /** o conserto tem a casa em ordem (trava dura + contenção)? Ausente ⇒ não medido ⇒ diagnóstico. */
  repairReady?: () => Promise<SentinelRepairReadiness>;
  /** o interruptor geral do autorun (`autorun.enabled`). Ausente ⇒ ligado. */
  autorunEnabled?: () => boolean;
  /** a cota segura o trabalho automático agora? */
  capacityHeld: () => boolean;
  readLog: () => Promise<SentinelLogEntry[]>;
  append: (e: AppendSentinelInput) => Promise<void>;
  /** lança a sessão; resolve quando ela morre (null = não nasceu). */
  spawn: (cause: SentinelCause, mode: SentinelMode, budgetUSD: number, hooks?: SentinelWakeHooks) => Promise<SentinelRunResult | null>;
  /** mata o processo de um despertar órfão (só se ainda for ele) e revoga a credencial dele. Best-effort. */
  reapOrphan?: (entry: SentinelLogEntry) => Promise<void>;
  now: () => number;
  /** o id do despertar (o teste fixa). */
  newWakeId?: () => string;
}

export type SentinelWakeAction = "skipped" | "deterministic-fix" | "diagnosis-only" | "spawned" | "deferred";

export interface SentinelWakeReport {
  causeKey: string;
  action: SentinelWakeAction;
  mode?: SentinelMode;
  /** a sessão em voo (o teste a espera; a produção não). */
  done?: Promise<void>;
}

/** Quantas sessões um board pode abrir numa varredura (as outras causas esperam a próxima). */
export const SENTINEL_SPAWNS_PER_SWEEP = 1;

/** O que a Sentinela faz pelas causas de UM board (ou do host). Nunca lança. */
export async function runSentinelBoard(board: string, deps: SentinelRunDeps): Promise<SentinelWakeReport[]> {
  const out: SentinelWakeReport[] = [];
  try {
    const causes = await deps.collect(board);
    if (causes.length === 0) return out;
    const entries = [...(await deps.readLog())];
    const now = deps.now();
    const fresh = causes.filter((c) => {
      if (!causeAlreadyWoken(entries, c.key, now)) return true;
      out.push({ causeKey: c.key, action: "skipped" });
      return false;
    });
    if (fresh.length === 0) return out;

    // 3) o determinístico primeiro — e a releitura diz o que ele resolveu. Só onde os portões do board deixam.
    let remaining = fresh;
    const deterministicOk = board !== SENTINEL_HOST_BOARD && (deps.deterministicAllowed ? await deps.deterministicAllowed(board).catch(() => false) : true);
    if (deterministicOk) {
      await deps.deterministicPass(board).catch(() => {});
      const after = new Map((await deps.collect(board)).map((c) => [c.key, c]));
      remaining = [];
      for (const c of fresh) {
        const still = after.get(c.key);
        if (still) {
          remaining.push(still);
          continue;
        }
        const e: AppendSentinelInput = {
          board: c.board,
          causeKey: c.key,
          kind: c.kind,
          reason: c.summary,
          cardIds: c.cardIds,
          mode: "diagnose",
          did: "deterministic-fix",
          costUSD: 0,
          outcome: "resolved",
          diagnosis: "Resolvido pelo conserto automático sem custo (zelador/recuperação), sem abrir sessão.",
        };
        await deps.append(e);
        entries.push({ v: 1, at: new Date(now).toISOString(), ...e });
        out.push({ causeKey: c.key, action: "deterministic-fix" });
      }
    }

    // 4) a decisão pura, causa a causa
    const box = remaining.length ? await deps.sentinelBox(board).catch(() => false) : false;
    const repairReady = box && deps.repairReady ? await deps.repairReady().catch((err): SentinelRepairReadiness => ({ ok: false, why: String(err) })) : null;
    const autorunEnabled = deps.autorunEnabled ? deps.autorunEnabled() : true;
    let spawned = 0;
    for (const cause of remaining) {
      const decision = decideSentinelWake({ cause, entries, now, sentinelBox: box, repairReady, capacityHeld: deps.capacityHeld(), autorunEnabled });
      if (decision.action === "skip") {
        out.push({ causeKey: cause.key, action: "skipped" });
        continue;
      }
      const base = { board: cause.board, causeKey: cause.key, kind: cause.kind, reason: cause.summary, cardIds: cause.cardIds, mode: decision.mode };
      if (decision.action === "diagnosis-only") {
        const e: AppendSentinelInput = {
          ...base,
          did: "diagnosis-only",
          costUSD: 0,
          outcome: "open",
          why: decision.why,
          diagnosis: diagnosisOnlyText(cause, decision.why),
        };
        await deps.append(e);
        entries.push({ v: 1, at: new Date(now).toISOString(), ...e });
        out.push({ causeKey: cause.key, action: "diagnosis-only", mode: decision.mode });
        continue;
      }
      if (spawned >= SENTINEL_SPAWNS_PER_SWEEP) {
        out.push({ causeKey: cause.key, action: "deferred", mode: decision.mode });
        continue;
      }
      spawned++;
      // 5) o registro ANTES de nascer, RESERVANDO o teto do despertar: um restart no meio não faz a mesma causa acordar
      //    de novo, e a próxima varredura já vê o dinheiro deste despertar como gasto até o desfecho trazer o custo real
      const did = decision.mode === "repair" ? "repaired" : "diagnosed";
      const wakeId = deps.newWakeId?.() ?? `w-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const start: AppendSentinelInput = {
        ...base,
        did,
        costUSD: 0,
        reservedUSD: decision.budgetUSD,
        wakeId,
        outcome: "open",
        why: SENTINEL_IN_PROGRESS,
        ...(decision.downgraded ? { diagnosis: `O conserto ficou em diagnóstico: ${decision.downgraded}.` } : {}),
      };
      await deps.append(start);
      entries.push({ v: 1, at: new Date(now).toISOString(), ...start });
      // o PROGRESSO: o pid e cada comando pedido entram no registro ENQUANTO a sessão roda — um restart do serviço no
      // meio não apaga o que o shell já fez
      const progress: AppendSentinelInput = { ...base, did, costUSD: 0, outcome: "open", why: SENTINEL_IN_PROGRESS, wakeId };
      const hooks: SentinelWakeHooks = {
        onStart: (pid, mode) => {
          if (pid) void deps.append({ ...progress, did: mode === "repair" ? "repaired" : "diagnosed", mode, pid }).catch(() => {});
        },
        onCommands: (commands) => {
          if (commands.length) void deps.append({ ...progress, commands }).catch(() => {});
        },
      };
      const done = (async () => {
        const r = await deps.spawn(cause, decision.mode, decision.budgetUSD, hooks).catch(() => null);
        if (!r) {
          await deps.append({ ...base, did: "spawn-failed", costUSD: 0, outcome: "failed", why: "a sessão não nasceu", wakeId });
          return;
        }
        const ranMode = r.mode ?? decision.mode;
        // o desfecho pelo MUNDO, não pela palavra da sessão: a causa sumiu da releitura ⇒ resolvida
        const stillThere = (await deps.collect(board).catch(() => [] as SentinelCause[])).some((c) => c.key === cause.key);
        const resolved = ranMode === "repair" && !stillThere;
        const why = r.downgraded ? `o conserto ficou em diagnóstico: ${r.downgraded}` : r.stop;
        await deps.append({
          ...base,
          mode: ranMode,
          did: ranMode === "repair" ? "repaired" : "diagnosed",
          costUSD: r.costUSD,
          outcome: resolved ? "resolved" : r.exitCode === 0 || r.finalText ? "open" : "failed",
          ...(r.finalText ? { diagnosis: r.finalText } : {}),
          ...(r.commands.length ? { commands: r.commands } : {}),
          ...(why ? { why } : {}),
          sessionId: r.sessionId,
          wakeId,
        });
      })().catch(() => {});
      out.push({ causeKey: cause.key, action: "spawned", mode: decision.mode, done });
    }
  } catch (err) {
    console.error(`[sentinel ${board}] varredura falhou:`, err instanceof Error ? err.message : err);
  }
  return out;
}

/** O diagnóstico SEM LLM (teto, cota, interruptor, configuração): o que o próprio sinal diz, e por que não houve sessão. PURA. */
export function diagnosisOnlyText(cause: Pick<SentinelCause, "summary" | "detail">, why: SentinelNoLlmWhy): string {
  // a causa de configuração é o próprio diagnóstico (texto fixo do serviço): não há sessão que faltou
  if (why === "config") return (cause.detail ?? cause.summary).trim();
  const reason =
    why === "ceiling"
      ? "O teto de gasto do dia da Sentinela (do board ou do host) acabou, então ela não abriu sessão."
      : why === "capacity"
        ? "A cota segura o trabalho automático agora, então ela não abriu sessão."
        : why === "autorun-off"
          ? "O autorun está desligado no interruptor geral, então ela não abriu sessão (só o diagnóstico do sinal)."
          : "A causa não é de um board, então ela não abriu sessão.";
  return `${cause.detail ?? cause.summary} ${reason}`.trim();
}

/**
 * Fecha os despertares ÓRFÃOS: a sessão nasceu (há linha de abertura), o serviço reiniciou e o desfecho nunca chegou. O
 * processo é morto (se ainda for ele) e a credencial dele revogada; a linha de desfecho entra como falha, cobrando o teto
 * reservado (o lado seguro de um orçamento) — sem ela a causa ficava «em andamento» para sempre e sumia do Inbox. Nunca lança.
 */
export async function reconcileOrphanWakes(deps: Pick<SentinelRunDeps, "readLog" | "append" | "reapOrphan" | "now">): Promise<number> {
  try {
    const orphans = orphanedWakes(await deps.readLog(), deps.now());
    for (const o of orphans) {
      await deps.reapOrphan?.(o).catch(() => {});
      await deps.append({
        board: o.board,
        causeKey: o.causeKey,
        kind: o.kind,
        reason: o.reason,
        cardIds: o.cardIds,
        mode: o.mode,
        did: o.did,
        costUSD: Number.isFinite(o.reservedUSD) ? Math.max(0, o.reservedUSD ?? 0) : 0,
        outcome: "failed",
        why: "despertar órfão: o serviço reiniciou antes do desfecho (o processo foi encerrado e a credencial revogada)",
        ...(o.wakeId ? { wakeId: o.wakeId } : {}),
      });
    }
    return orphans.length;
  } catch {
    return 0;
  }
}

// ── produção ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Uma leitura de saúde mais velha que isto não acorda ninguém (o tick de saúde parou: isso é outra causa). */
const HEALTH_MAX_AGE_MS = 2 * 60 * 60_000;

/** As deps de produção, montadas sob demanda (os imports pesados só carregam quando a Sentinela roda). */
export async function productionSentinelDeps(): Promise<SentinelRunDeps> {
  const [
    { collectBoardCockpitItems },
    { runBoardRecoveryPass, runBoardStewardPass },
    { runBusinessRecoveryPass },
    run,
    repo,
    profile,
    health,
    cap,
    spawnMod,
    cfgMod,
    bin,
    self,
    orchState,
    sandbox,
    claudeSettings,
    paths,
    sessionSpawn,
    fsMod,
    pathMod,
  ] = await Promise.all([
    import("@/lib/storymap/cockpit-collect"),
    import("./steward-deps"),
    import("./business-recovery"),
    import("./orchestrator-run"),
    import("@/lib/storymap/repo"),
    import("@/lib/storymap/autonomy-profile"),
    import("@/lib/storymap/health/health-deps"),
    import("./capacity-service"),
    import("./sentinel-spawn"),
    import("./config"),
    import("./claude-bin"),
    import("@/lib/storymap/self-board"),
    import("./orchestrator-state"),
    import("./autonomy-sandbox"),
    import("./claude-settings"),
    import("@/lib/storymap/paths"),
    import("./session-spawn"),
    import("node:fs"),
    import("node:path"),
  ]);
  const automation = () => cap.getCapacityGovernor().admission("automation");
  return {
    collect: async (board) => {
      if (board === SENTINEL_HOST_BOARD) {
        const rec = await health.readLastHealthRecord().catch(() => null);
        const fresh = rec && Date.now() - Date.parse(rec.at) < HEALTH_MAX_AGE_MS ? rec : null;
        const latch = causeFromCapacity(automation());
        // a CONFIGURAÇÃO do host: a trava dura (para a sessão sem projeto da Sentinela) e a skill do condutor do alvo
        const root = paths.findRepoRoot();
        const skillDir = pathMod.join(root, ".claude", "skills", "harness-conductor");
        const staleConductorSkill = fsMod.existsSync(pathMod.join(skillDir, "SKILL.md")) && !fsMod.existsSync(pathMod.join(root, sessionSpawn.CONDUCTOR_SKILL_REF_DIR));
        const config = causesFromHostConfig({ hardDenyInstalled: claudeSettings.hardDenyHookInstalled(null), staleConductorSkill });
        return [...causesFromHealth(fresh), ...(latch ? [latch] : []), ...config];
      }
      const items = await collectBoardCockpitItems(board);
      return causesFromCockpit(board, items as unknown as SentinelCockpitItem[]);
    },
    deterministicPass: async (board) => {
      await runBoardStewardPass(board);
      await runBoardRecoveryPass(board);
      await runBusinessRecoveryPass(run.businessRecoveryDeps(), board);
    },
    // os portões que o tique aplicava antes do steward: o copiloto ligado, o board autônomo e nenhum humano no comando
    deterministicAllowed: async (board) => {
      if (cfgMod.loadRunnerConfig().orchestrator?.enabled !== true) return false;
      const config = await repo.readBoardConfig(board).catch(() => null);
      if ((config?.orchestrator?.mode ?? "off") !== "autonomous") return false;
      return !orchState.leaseHeldByHuman(await orchState.readOrchestratorState(board), Date.now());
    },
    sentinelBox: async (board) => {
      const id = board === SENTINEL_HOST_BOARD ? self.selfBoardId() : board;
      if (!id) return false;
      const config = await repo.readBoardConfig(id).catch(() => null);
      return profile.autonomyProfileOf(config).sentinel === true;
    },
    // a casa em ordem para o conserto: a trava dura (sessão sem projeto) e a contenção do SO disponível — ou a válvula
    // que o operador declarou por escrito. A postura de verdade é resolvida no spawn, que rebaixa com o motivo se recusar.
    repairReady: async () => {
      if (!claudeSettings.hardDenyHookInstalled(null)) return { ok: false, why: "a trava dura do host (hook PreToolUse de Bash) não está instalada" };
      if (sandbox.unsandboxedFullAllowed(process.env)) return { ok: true };
      const support = sandbox.suporteDoHost();
      if (!support.available) return { ok: false, why: `sem contenção do sistema neste host (${support.reason})` };
      if (sandbox.resolveSandboxMode(process.env) === "off") return { ok: false, why: "a contenção do sistema foi desligada (AGILEHARNESS_SANDBOX_MODE=off)" };
      return { ok: true };
    },
    autorunEnabled: () => cfgMod.loadRunnerConfig().autorun.enabled === true,
    capacityHeld: () => !automation().admit,
    readLog: () => readSentinelLog(),
    append: (e) => appendSentinelEntry(e),
    spawn: (cause, mode, budgetUSD, hooks) => {
      const cfg = cfgMod.loadRunnerConfig();
      return spawnMod.spawnSentinel(cause, mode, budgetUSD, {
        claudeBin: bin.resolvedClaudeBin({ name: cfg.autorun.claudeBin }),
        port: Number(process.env.AGILEHARNESS_PORT || process.env.PORT) || 3008,
        ...(hooks?.onStart ? { onStart: hooks.onStart } : {}),
        ...(hooks?.onCommands ? { onCommands: hooks.onCommands } : {}),
      });
    },
    reapOrphan: async (entry) => {
      // o processo: só se o pid ainda for uma sessão da Sentinela (o argv dela traz o prompt de sistema do despertar)
      if (entry.pid) {
        const cmdline = await fsMod.promises.readFile(`/proc/${entry.pid}/cmdline`, "utf8").catch(() => "");
        if (cmdline.includes("--append-system-prompt-file") && cmdline.includes("sentinel")) {
          try {
            process.kill(-entry.pid, "SIGKILL");
          } catch {
            /* já morto */
          }
        }
      }
      // a credencial: todo handle da Sentinela vivo há mais que o relógio de um despertar
      const { listMcpHandles, revokeMcpHandle } = await import("@/lib/auth/mcp-handle");
      const limit = Date.now() - spawnMod.SENTINEL_HANDLE_MAX_AGE_MS;
      for (const h of await listMcpHandles().catch(() => [])) {
        if (!h.revokedAt && h.label?.startsWith(spawnMod.SENTINEL_HANDLE_LABEL_PREFIX) && Date.parse(h.createdAt) < limit) await revokeMcpHandle(h.id).catch(() => undefined);
      }
    },
    now: () => Date.now(),
  };
}

/**
 * Os boards que a Sentinela olha: todos os que não estão pausados/devagar (ritmo do board) nem «só organização» (o board
 * que só se organiza não tem ator automático — organize-only.ts).
 */
export async function sentinelSweepBoards(): Promise<string[]> {
  const [{ listBoards }, { paceAllowsBackground }, { organizeOnlyNow }] = await Promise.all([
    import("@/lib/storymap/repo"),
    import("./board-pace-store"),
    import("@/lib/storymap/organize-only"),
  ]);
  return (await listBoards()).map((b) => b.id).filter((id) => paceAllowsBackground(id) && !organizeOnlyNow(id));
}

/** Uma varredura inteira: cada board e, por fim, o host. Nunca lança. */
export async function runSentinelSweep(deps?: SentinelRunDeps, boards?: string[]): Promise<SentinelWakeReport[]> {
  try {
    const d = deps ?? (await productionSentinelDeps());
    const out: SentinelWakeReport[] = [];
    // antes de olhar as causas: os despertares que ficaram órfãos num restart (processo, credencial e desfecho)
    await reconcileOrphanWakes(d);
    // um board pedido por nome (o wake de um evento) passa pela MESMA régua da varredura: pausado ou «só organização»
    // não tem Sentinela; o host não é board e sempre passa
    const allowed = boards ? await sentinelSweepBoards().then((ok) => new Set([...ok, SENTINEL_HOST_BOARD])).catch(() => new Set<string>()) : null;
    for (const b of boards ? boards.filter((x) => allowed!.has(x)) : await sentinelSweepBoards()) out.push(...(await runSentinelBoard(b, d)));
    if (!boards) out.push(...(await runSentinelBoard(SENTINEL_HOST_BOARD, d)));
    return out;
  } catch (err) {
    console.error("[sentinel] varredura falhou:", err instanceof Error ? err.message : err);
    return [];
  }
}

// ── os gatilhos: debounce por board (uma rajada de eventos = UMA varredura) ─────────────────────────────────────

/** A janela de coalescência de eventos. */
export const SENTINEL_DEBOUNCE_MS = 45_000;

interface SentinelTimers {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  running: Set<string>;
}
const KEY = Symbol.for("storymap.sentinel.timers");
const store = globalThis as unknown as { [KEY]?: SentinelTimers };
const timers = (): SentinelTimers => (store[KEY] ??= { timers: new Map(), running: new Set() });

/**
 * Pede uma varredura de `board` (ou de tudo, sem board) depois da janela de coalescência. Fire-and-forget, nunca lança.
 * Um pedido que chega com outro já agendado para o mesmo alvo não re-arma (o horário mais cedo vence).
 */
export function requestSentinelSweep(board?: string, reason?: string, delayMs = SENTINEL_DEBOUNCE_MS): void {
  try {
    const key = board ?? "*all";
    const t = timers();
    if (t.timers.has(key)) return;
    const handle = setTimeout(() => {
      t.timers.delete(key);
      if (t.running.has(key)) return;
      t.running.add(key);
      void runSentinelSweep(undefined, board ? [board] : undefined)
        .catch(() => [])
        .finally(() => t.running.delete(key));
    }, Math.max(0, delayMs));
    (handle as unknown as { unref?: () => void }).unref?.();
    t.timers.set(key, handle);
    if (reason) console.log(`[sentinel] varredura agendada${board ? ` (${board})` : ""}: ${reason}`);
  } catch {
    /* best-effort */
  }
}

/** Só p/ teste: cancela os pedidos agendados. */
export function resetSentinelTimers(): void {
  const t = timers();
  for (const h of t.timers.values()) clearTimeout(h);
  t.timers.clear();
  t.running.clear();
}
