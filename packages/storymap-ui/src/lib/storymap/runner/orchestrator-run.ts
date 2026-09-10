// Item 2 — a FÁBRICA das deps do tick do orquestrador, extraída do instrumentation.ts p/ ter UMA fonte só,
// reusada por (a) o timer global do boot, (b) o tick IMEDIATO ao ativar autonomous num board e (c) o WAKE por
// evento (orchestrator-wake). Assim ligar o modo autônomo — ou um card travar — não espera até 30min pelo
// próximo tick global: age na hora, respeitando os MESMOS gates (enabled global, lease de humano, run em voo,
// budget, hasWork, backoff, e o token ORCH; sem o token o spawn é pulado → inerte, como todo o resto).

import { loadRunnerConfig } from "./config";
import { listBoards, readBoardConfig } from "@/lib/storymap/repo";
import {
  readOrchestratorState,
  writeOrchestratorState,
  applyTick,
  applyTickOutcome,
  applyLease,
  applyRunResult,
  budgetOk,
  bumpNoopByAttempt,
  itemsInNoopBackoff,
  leaseHeldByHuman,
  leaseHeldByTick,
  releaseLease,
  spawnBreakerOpen,
  PER_ITEM_NOOP_MAX,
  type OrchestratorState,
} from "./orchestrator-state";
import { spawnOrchestrator } from "./orchestrator-spawn";
import { flushAgentActions, readAgentActions } from "./agent-actions";
import { deriveRunAttempt } from "./noop-attribution";
import { getCardClaims } from "./claims";
import { hasLiveCopilotTurnForBoard } from "@/lib/storymap/copilot/agent-session";
import { appendCopilotActivity, tickOutcomeText } from "@/lib/storymap/copilot/activity";
import { collectActionableCockpit } from "@/lib/storymap/cockpit-collect";
import { runBoardRecoveryPass, runBoardStewardPass } from "./steward-deps";
import { runOrchestratorTick, type ActiveBoard, type OrchestratorTickDeps } from "./orchestrator-tick";
import { resolvedClaudeBin } from "./claude-bin";

/**
 * TTL do lease que o tick pega ao spawnar. É um BACKSTOP, não o mecanismo: o lease normalmente é solto quando
 * o processo morre (onResult). O TTL só importa quando o serviço cai no meio de um run — sem ele o lease
 * ficaria preso p/ sempre e o board nunca mais rodaria (um fail-closed silencioso, o pior tipo).
 */
export const TICK_LEASE_TTL_MS = 20 * 60_000;

/**
 * WS-12 (D16) — o ator do LEDGER sob o qual o run DESTE tick escreve suas ações, resolvido pela MESMA busca que
 * a route.ts faz (valor do token → a entrada de `mcpTokens` que o segura), para não poder divergir do que o
 * spawn realmente usa. É o que impede creditar a ESTE run a ação de um OUTRO agente escopado na mesma janela —
 * a misattribution que o WS-12 existe para fechar. Sem o token o tick nem spawna (undefined ⇒ nada a atribuir).
 */
function orchLedgerActor(): string | undefined {
  const token = process.env.AGILEHARNESS_MCP_TOKEN_ORCH?.trim();
  if (!token) return undefined;
  const hit = (loadRunnerConfig().mcpTokens ?? []).find((t) => process.env[t.tokenEnv]?.trim() === token);
  return hit?.tokenEnv ?? "AGILEHARNESS_MCP_TOKEN_ORCH";
}

/**
 * WS-12 (D16) — a transição do streak anti-noop por TENTATIVA deste run, pronta para ser dobrada no mesmo
 * read-modify-write do resultado. O que ela lê, nesta ordem:
 *
 *  1. o LEDGER drenado (flushAgentActions) — o guard faz `void appendAgentAction(...)`, então a ÚLTIMA ação de
 *     um run pode ainda estar na fila quando ele morre; lê-la tarde demais soaria como "não mutou nada", que é
 *     justamente o veredito que pune todo mundo;
 *  2. os itens AINDA acionáveis ao fim do run (o que o run moveu já saiu do set → é podado);
 *  3. as ações mutantes DESTE ator na janela [spawnAt, agora] → quem foi TENTADO (noop-attribution.ts).
 *
 * `died && sem mutação` ⇒ NENHUM bump: morte não é evidência de que não havia trabalho (é a mesma regra que o
 * applyRunResult já aplica ao streak global — em 2026-07-13 o spawn morria no arranque e contá-lo como "olhou e
 * não agiu" calou o Jido exatamente quando ele estava quebrado). Perda do onResult (restart no meio) ⇒ nada
 * a aplicar ⇒ fail-open para re-tentativa, limitado pelo budget do dia + o backoff global por assinatura.
 * Qualquer erro ⇒ identidade (o estado do backoff nunca derruba o registro do resultado).
 */
async function noopAttributionFor(
  board: string,
  spawnAt: number,
  died: boolean,
): Promise<(s: OrchestratorState) => OrchestratorState> {
  const identity = (s: OrchestratorState) => s;
  try {
    const actor = orchLedgerActor();
    if (!actor) return identity; // sem token não há run — nada a atribuir
    await flushAgentActions();
    const resultAt = Date.now();
    const [{ itemCards }, actions] = await Promise.all([
      collectActionableCockpit(board),
      // SEM filtro de board aqui: quem decide o que pertence a este board é deriveRunAttempt (uma ação mutante
      // sem board é evidência de que o run AGIU, ainda que não atribuível a card — ver o doc de lá).
      readAgentActions({ since: spawnAt, until: resultAt }),
    ]);
    const attempt = deriveRunAttempt(actions, { board, from: spawnAt, to: resultAt, actor });
    if (died && !attempt.anyMutation) return identity;
    return (s) => bumpNoopByAttempt(s, itemCards, attempt);
  } catch {
    return identity;
  }
}

/**
 * Monta as deps de UM tick (fresh a cada chamada — o `sigByBoard` é por-tick). `overrideBoards` restringe o
 * tick a um conjunto fixo de boards (o tick imediato/wake passa só o board alvo); ausente ⇒ varre todos os
 * boards ativos (o timer global). `reason` = o evento que acordou o Jido (vai no prompt do run).
 */
export function buildTickDeps(overrideBoards?: ActiveBoard[], reason?: string): OrchestratorTickDeps {
  const sigByBoard = new Map<string, string>();
  // WS-5.4 — the FULL actionable ids this tick saw per board (before the per-item backoff filter), captured in
  // hasWork. WS-12 — consumed by recordOutcome for the honest stand-down; the per-item BUMP no longer reads it
  // (it re-collects at the run's END and attributes by the ledger). Per-tick (like sigByBoard).
  const idsByBoard = new Map<string, string[]>();
  return {
    enabled: loadRunnerConfig().orchestrator?.enabled === true, // re-read → um toggle vale sem restart
    reason,
    activeBoards: overrideBoards
      ? () => overrideBoards
      : async () => {
          const boards = await listBoards();
          const out: ActiveBoard[] = [];
          for (const b of boards) {
            const mode = (await readBoardConfig(b.id)).orchestrator?.mode ?? "off";
            if (mode !== "off") out.push({ board: b.id, mode });
          }
          return out;
        },
    hasWork: async (board) => {
      const { sig, ids, itemCards } = await collectActionableCockpit(board);
      sigByBoard.set(board, sig);
      idsByBoard.set(board, ids); // the FULL set — recordTick grows the per-item streak against it on a spawn
      // WS-5.4 — an item that already absorbed its quota of spawns without its own progress leaves the
      // actionable set even if the rest of the board churned (which resets the global sig). It stays on
      // Inbox for the human; the tick just stops re-driving it. "Work" is the set MINUS those in backoff.
      const backoff = itemsInNoopBackoff(await readOrchestratorState(board));
      // WS-4.2 (parallel-work) — …MINUS the items whose CARD another actor already holds (a live claim): an
      // agent session or a run is on it, so spawning the copiloto onto it would duplicate work and collide.
      // A CONSULT, never an acquire — the tick reserves nothing by looking. Fail-open: if the claim registry
      // is unreadable the tick behaves exactly as before (claims are anti-waste, never a gate).
      const claimed = await getCardClaims()
        .claimedCardIds(board, "copilot:tick")
        .catch(() => new Set<string>());
      const cardOf = new Map(itemCards.map((i) => [i.id, i.cardId]));
      const live = ids.filter((id) => {
        if (backoff.has(id)) return false;
        const cardId = cardOf.get(id);
        return !(cardId && claimed.has(cardId));
      });
      return live.length > 0;
    },
    shouldBackoff: async (board) => {
      const sig = sigByBoard.get(board) ?? "";
      if (!sig) return false;
      const s = await readOrchestratorState(board);
      return (s.noop?.ranStreak ?? 0) >= 2 && (s.noop?.workSig ?? "") === sig;
    },
    leaseHeldByHuman: async (board) => leaseHeldByHuman(await readOrchestratorState(board), Date.now()),
    // Wake — trava anti-concorrência: com o timer E os eventos podendo cair juntos, um run em voo bloqueia o
    // próximo spawn (dois copilotos escrevendo o mesmo board seria a corrida óbvia). WS2A — inclui também um
    // TURNO DE CHAT vivo: agora que o tick RETOMA a sessão do board, um turno pareado ainda terminando no
    // servidor (o turno sobrevive a fechar/refresh o painel) não pode ter o tick resumindo a MESMA sessão em
    // paralelo. `hasLiveCopilotTurnForBoard` vê o registro in-process do chat (mesmo serviço) e fecha a janela.
    runInFlight: async (board) =>
      leaseHeldByTick(await readOrchestratorState(board), Date.now()) || hasLiveCopilotTurnForBoard(board),
    budgetOk: async (board) => {
      const s = loadRunnerConfig().orchestrator!;
      return budgetOk(await readOrchestratorState(board), s, Date.now());
    },
    spawnBroken: async (board) => spawnBreakerOpen(await readOrchestratorState(board), Date.now()),
    // WS-8 (D11) — o passe determinístico do STEWARD, a $0, imediatamente antes do spawn. Ele destrava o que é
    // FATO (conflito parqueado devolvido ao train, ciclo de sessão morta fechado por convergência, card parado
    // num gate que já passa) e escala o resto COM a análise. `runBoardStewardPass` já é best-effort por
    // contrato — nunca lança —, então isto não pode transformar um spawn num `error`.
    stewardPass: async (board) => {
      await runBoardStewardPass(board);
    },
    // O passe de recuperação do caminho sem-trabalho: $0, sem spawn, só sob prova (ver runDeployRecoveryPass).
    recoveryPass: async (board) => {
      await runBoardRecoveryPass(board);
    },
    spawn: async (board, mode, spawnReason) => {
      // pega o lease do tick ANTES de spawnar (o run em voo bloqueia o próximo) e o solta se o spawn não sair.
      await writeOrchestratorState(
        board,
        applyLease(await readOrchestratorState(board), "tick", Date.now(), TICK_LEASE_TTL_MS),
      );
      // WS-12 — o início da JANELA de atribuição: as ações do ledger entre isto e a morte do run são as deste
      // run. Marcado antes do spawn (nunca depois): uma ação da 1a chamada de tool não pode cair fora.
      const spawnAt = Date.now();
      const started = await spawnOrchestrator(board, mode, {
        claudeBin: resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin }),
        // tick usa o token SCOPED do orquestrador (não o full). Ausente ⇒ spawnOrchestrator pula (inerte, seguro).
        token: process.env.AGILEHARNESS_MCP_TOKEN_ORCH,
        reason: spawnReason,
        // o run TERMINOU: cobra o custo REAL no budget do dia, guarda o resumo do que ele fez, solta o lease,
        // e ATRIBUI o streak anti-noop por TENTATIVA (WS-12) — tudo num único read-modify-write do estado.
        onResult: (r) => {
          void (async () => {
            const applyNoop = await noopAttributionFor(r.board, spawnAt, (r.exitCode ?? 0) !== 0);
            const s = await readOrchestratorState(r.board);
            await writeOrchestratorState(r.board, applyRunResult(applyNoop(s), Date.now(), r));
            // o operador vê no chat O QUE ele fez — não só que "rodou".
            const cost = r.costUSD > 0 ? `$${r.costUSD.toFixed(2)} · ${Math.round(r.durationMs / 1000)}s` : undefined;
            await appendCopilotActivity(r.board, {
              kind: r.exitCode === 0 ? "finished" : "error",
              text: r.exitCode === 0 ? r.summary || "Terminei o ciclo (sem resumo)." : `Meu ciclo falhou (exit ${r.exitCode ?? "?"}).`,
              // a CAUSA vem antes do custo: um ciclo que morre no arranque custa $0, e "exit 1" sem porquê fez o
              // operador olhar horas de falha sem nada onde pegar. Com causa, a primeira linha já é acionável.
              detail: r.failure ? (cost ? `${r.failure} · ${cost}` : r.failure) : cost,
            });
          })().catch(() => {});
        },
      });
      if (!started) {
        // sem token / falha de spawn: NÃO deixe o lease preso (o board ficaria inerte por 20min à toa).
        await writeOrchestratorState(board, releaseLease(await readOrchestratorState(board)));
      }
      return started; // false ⇒ o tick não debita budget (o run não nasceu)
    },
    recordTick: async (board) => {
      const s = await readOrchestratorState(board);
      // WS-12 (D16) — o SPAWN não mexe mais no streak por-item. Ele bumpava aqui todo item acionável PRESENTE,
      // o que entregava "duas spawns por board enquanto o item existir" no lugar de "duas TENTATIVAS por item"
      // (colisão #7: o card limpo acme/story-xfleex chegou a streak 4 sem nunca ter sido tentado). Quem bumpa
      // agora é o RESULTADO do run (noopAttributionFor), que sabe o que ele de fato tentou. O streak GLOBAL
      // (workSig/ranStreak) segue aqui: é o limitador de ritmo do board, e mede outra coisa.
      await writeOrchestratorState(board, applyTick(s, Date.now(), "autonomous", 0, sigByBoard.get(board) ?? ""));
      const said = tickOutcomeText("ran", { reason });
      if (said) await appendCopilotActivity(board, said);
    },
    recordOutcome: async (board, outcome) => {
      const s = await readOrchestratorState(board);
      const base = outcome === "skipped-backoff" ? { ...s, noop: { ...s.noop, ranStreak: 0 } } : s;
      await writeOrchestratorState(board, applyTickOutcome(base, Date.now(), "skipped", outcome));
      // TODA decisão é comunicada — inclusive a de NÃO agir. Um "pulei" invisível é o que fazia o Jido
      // parecer quebrado quando ele só estava sendo disciplinado (sem trabalho, sem budget, em backoff). E cada
      // mensagem responde "o que aconteceu, por quê, e o que significa pra mim" com os DADOS reais do estado.
      const budget = loadRunnerConfig().orchestrator?.budget;
      // "O que eu FARIA": no stand-down PAREADO o tick recua ANTES de olhar o trabalho (o gate de lease vem antes
      // do hasWork), então computamos AQUI o mesmo pre-check ZERO-TOKEN só p/ a mensagem dizer quantos itens
      // acionáveis esperam. Best-effort — a mensagem só perde o "N itens" se a leitura falhar.
      let actionableCount: number | undefined;
      if (outcome === "skipped-leased") {
        try {
          actionableCount = (await collectActionableCockpit(board)).count;
        } catch {
          /* best-effort */
        }
      }
      // WS-12.2 (D16) — DESISTIR É UM EVENTO. "Nada acionável" e "N acionáveis, desisti de todos" são a mesma
      // frase hoje, e o operador não tem como saber que a divisão de trabalho mudou (o board acme passou o dia
      // dizendo "nada acionável" com 6 itens à vista). O dado já existe em noopByItem — só não era contado.
      // Os ids vêm do que ESTE tick viu em hasWork (idsByBoard), então a mensagem nomeia itens reais e atuais.
      let backoffItemIds: string[] | undefined;
      if (outcome === "skipped-no-work") {
        const inBackoff = itemsInNoopBackoff(s);
        backoffItemIds = (idsByBoard.get(board) ?? []).filter((id) => inBackoff.has(id));
      }
      const said = tickOutcomeText(outcome, {
        reason,
        backoffItemIds,
        perItemNoopMax: PER_ITEM_NOOP_MAX,
        ticksToday: s.budget.ticksToday,
        maxTicks: budget?.maxTicksPerDay,
        // budget concreto: os DOIS tetos (ticks + custo) que já gastei hoje, não um "budget" abstrato.
        costToday: s.budget.costToday,
        maxCostUSD: budget?.maxCostPerDay,
        // backoff concreto: quantos ciclos seguidos gastaram sem mover o mesmo trabalho.
        noopStreak: s.noop?.ranStreak,
        // o breaker fala com NÚMERO e CAUSA (quantos ciclos morreram, e o porquê do último) — sem isso a
        // mensagem seria só mais um "não rodei" genérico, que é como o defeito passou um dia despercebido.
        failureStreak: s.failures?.streak,
        failureReason: s.failures?.reason,
        // WS-4.3: um ciclo autônomo pode estar EM VOO (tickLease vivo) enquanto o humano pareia → o
        // stand-down por lease diz a verdade completa em vez de "só fiquei de fora".
        tickInFlight: leaseHeldByTick(s, Date.now()),
        actionableCount,
      });
      if (said) await appendCopilotActivity(board, said);
    },
  };
}

// Guarda contra o tick imediato empilhar em si mesmo (toggles rápidos off→auto→off→auto, ou uma rajada de
// wakes). A trava DURÁVEL contra dois runs no mesmo board é o lease `tick` (runInFlight); esta é só a trava
// in-process que cobre a janela entre decidir spawnar e o lease ser escrito.
const immediateInFlight = new Set<string>();

/**
 * Dispara UM tick só para `board`, AGORA — ao ativar autonomous (toggle) ou ao acordar por evento (wake).
 * Fire-and-forget, best-effort. Só age se o board é `autonomous` (senão no-op). Respeita todos os gates via
 * buildTickDeps; inerte sem token ORCH. `reason` = o evento que o acordou (vai no prompt e nos logs).
 */
export async function runBoardTickNow(board: string, reason?: string): Promise<void> {
  if (immediateInFlight.has(board)) return;
  immediateInFlight.add(board);
  try {
    const mode = (await readBoardConfig(board)).orchestrator?.mode ?? "off";
    if (mode !== "autonomous") return; // só autônomo dispara um tick imediato
    await runOrchestratorTick(buildTickDeps([{ board, mode }], reason));
  } catch {
    /* best-effort — nunca quebra o toggle/evento que o chamou */
  } finally {
    immediateInFlight.delete(board);
  }
}
