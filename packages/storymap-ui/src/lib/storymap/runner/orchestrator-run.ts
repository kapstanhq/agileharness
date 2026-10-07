// Item 2 — a FÁBRICA das deps do tick do orquestrador, extraída do instrumentation.ts p/ ter UMA fonte só,
// reusada por (a) o timer global do boot, (b) o tick IMEDIATO ao ativar autonomous num board e (c) o WAKE por
// evento (orchestrator-wake). Assim ligar o modo autônomo — ou um card travar — não espera até 30min pelo
// próximo tick global: age na hora, respeitando os MESMOS gates (enabled global, lease de humano, run em voo,
// budget, hasWork, backoff, e o token ORCH; sem o token o spawn é pulado → inerte, como todo o resto).

import { loadRunnerConfig } from "./config";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { runBusinessRecoveryPass, type BusinessRecoveryDeps } from "./business-recovery";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";
import { recoveryFixCardEntry } from "@/lib/storymap/system-decisions";
import {
  readOrchestratorState,
  writeOrchestratorState,
  applyTick,
  applyTickOutcome,
  itemsInNoopBackoff,
  itemsInRecoveryBackoff,
  leaseHeldByHuman,
  leaseHeldByTick,
  spawnBreakerOpen,
  PER_ITEM_NOOP_MAX,
} from "./orchestrator-state";
import { getCapacityGovernor } from "./capacity-service";
import { getCardClaims } from "./claims";
import { hasLiveCopilotTurnForBoard } from "@/lib/storymap/copilot/agent-session";
import { appendCopilotActivity, tickOutcomeText } from "@/lib/storymap/copilot/activity";
import { collectActionableCockpit, collectBoardCockpitItems } from "@/lib/storymap/cockpit-collect";
import { runBoardRecoveryPass, runBoardStewardPass } from "./steward-deps";
import { runOrchestratorTick, type ActiveBoard, type OrchestratorTickDeps } from "./orchestrator-tick";
import { paceAllowsBackground } from "./board-pace-store";

/**
 * As deps de produção do passe de recuperação só-negócio (runner/business-recovery.ts): o card de conserto nasce pela
 * porta de sempre (createCardAction — na Triagem, onde o juiz o aceita pelo PRD).
 */
export function businessRecoveryDeps(): BusinessRecoveryDeps {
  return {
    readBoardConfig: (board) => readBoardConfig(board).catch(() => null),
    readCards: (board) => readCards(board),
    collectItems: (board) => collectBoardCockpitItems(board),
    readState: (board) => readOrchestratorState(board),
    writeState: (board, s) => writeOrchestratorState(board, s),
    createCard: async (board, card) => {
      const { createCardAction } = await import("@/app/actions");
      const r = await createCardAction({ boardId: board, card, via: "triage", system: true });
      return r.ok ? (r.data?.card ?? null) : null;
    },
    // o registro do que o Jido decidiu em nome do dono, com o «Desfazer» (descartar o card de conserto).
    record: (board, item, fix) =>
      appendSystemDecision(
        recoveryFixCardEntry(board, { itemId: item.id, cardId: item.cardId, cardTitle: item.cardTitle, fixCardId: fix.id }, { at: new Date().toISOString(), id: newSystemDecisionId() }),
      ),
  };
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
  // O motivo do governador de capacidade, por board, para a frase do stand-down (per-tick, como sigByBoard).
  const capacityDetailByBoard = new Map<string, string>();
  // FASE 6 — os boards que a varredura da Sentinela deste tique JÁ olhou: o `spawn` de um board autônomo não os varre
  // de novo (per-tick, como sigByBoard).
  const sentinelSwept = new Set<string>();
  return {
    enabled: loadRunnerConfig().orchestrator?.enabled === true, // re-read → um toggle vale sem restart
    reason,
    // a varredura da Sentinela só no tique GLOBAL (o timer); o imediato/wake de um board vai pelo `spawn` abaixo
    ...(overrideBoards
      ? {}
      : {
          sentinel: async () => {
            const { runSentinelSweep, sentinelSweepBoards } = await import("./sentinel-run");
            const { SENTINEL_HOST_BOARD } = await import("./sentinel");
            const boards = await sentinelSweepBoards().catch(() => [] as string[]);
            for (const b of boards) sentinelSwept.add(b);
            await runSentinelSweep(undefined, [...boards, SENTINEL_HOST_BOARD]);
            // o contrato de sinais (settings.yaml `signals.sources`): a entrada determinística, no máximo a cada 30 min
            const { maybeRunSignalsIntake } = await import("./signals-deps");
            await maybeRunSignalsIntake().catch(() => null);
          },
        }),
    activeBoards: overrideBoards
      ? () => overrideBoards
      : async () => {
          const boards = await listBoards();
          const out: ActiveBoard[] = [];
          for (const b of boards) {
            const mode = (await readBoardConfig(b.id)).orchestrator?.mode ?? "off";
            // o copiloto é trabalho de FUNDO: board pausado ou devagar (board-pace.ts) não recebe tick
            if (mode !== "off" && paceAllowsBackground(b.id)) out.push({ board: b.id, mode });
          }
          return out;
        },
    hasWork: async (board) => {
      const { sig, ids, itemCards, businessOnly } = await collectActionableCockpit(board);
      sigByBoard.set(board, sig);
      idsByBoard.set(board, ids); // the FULL set — recordTick grows the per-item streak against it on a spawn
      // WS-5.4 — an item that already absorbed its quota of spawns without its own progress leaves the
      // actionable set even if the rest of the board churned (which resets the global sig). It stays on
      // Inbox for the human; the tick just stops re-driving it. "Work" is the set MINUS those in backoff.
      // SÓ-NEGÓCIO (política só-negócio) — o teto é o do TIPO (o efeito que não rodou: 1; o resto: 2), e o item que já
      // ganhou o card de conserto não volta: o passe de recuperação ($0) abriu o card e o fluxo seguiu.
      const state = await readOrchestratorState(board);
      const backoff = businessOnly
        ? new Set([...itemsInRecoveryBackoff(state, itemCards), ...Object.keys(state.recoveryHandoffs ?? {})])
        : itemsInNoopBackoff(state);
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
    // FASE 6 — o «spawn» do tique é a Sentinela OLHANDO o board ($0; a sessão dela, quando nasce, tem teto diário
    // próprio — sentinel.ts). O teto de tiques do copiloto antigo não tem mais o que medir: aplicá-lo mostrava um falso
    // «sem budget» depois de N olhadas grátis. O legado (`budgetOk`) segue para quem lê o estado antigo.
    budgetOk: async () => true,
    spawnBroken: async (board) => spawnBreakerOpen(await readOrchestratorState(board), Date.now()),
    // WS-8 (D11) — o passe determinístico do STEWARD, a $0, imediatamente antes do spawn. Ele destrava o que é
    // FATO (conflito parqueado devolvido ao train, ciclo de sessão morta fechado por convergência, card parado
    // num gate que já passa) e escala o resto COM a análise. `runBoardStewardPass` já é best-effort por
    // contrato — nunca lança —, então isto não pode transformar um spawn num `error`.
    stewardPass: async (board) => {
      await runBoardStewardPass(board);
      // SÓ-NEGÓCIO: o item que esgotou o limite do tipo ganha o card de conserto (a $0, uma vez) — o fluxo segue.
      await runBusinessRecoveryPass(businessRecoveryDeps(), board);
    },
    // O passe de recuperação do caminho sem-trabalho: $0, sem spawn, só sob prova (ver runDeployRecoveryPass).
    // SÓ-NEGÓCIO: é AQUI que o card de conserto nasce no caso comum — quando TODO item de recuperação esgotou o
    // limite, `hasWork` fica false e o tick cai neste caminho.
    recoveryPass: async (board) => {
      await runBoardRecoveryPass(board);
      await runBusinessRecoveryPass(businessRecoveryDeps(), board);
    },
    // O tick é trabalho AUTOMÁTICO: o spawn do LLM passa pela janela da conta (capacity-governor). O re-arme é a
    // própria cadência do tick + o wake — nada fica para trás, só espera.
    capacityHeld: (board) => {
      const gate = getCapacityGovernor().admission("automation");
      if (gate.admit) return null;
      capacityDetailByBoard.set(board, gate.detail);
      return gate.detail;
    },
    // FASE 6 — o tique NÃO retoma mais a conversa do chat (Opus, ~200 mil tokens) para «avançar o board». Quem age aqui
    // é a SENTINELA (sentinel-run.ts): sessão nova e enxuta, só para causa NOVA, com o poder da caixa `sentinel` e o teto
    // dela. O steward ($0) já rodou acima; a Sentinela relê as causas e só abre sessão para o que sobrou. «Rodou» =
    // a Sentinela olhou o board (o custo dela vai no registro dela, não no budget do tique).
    spawn: async (board, _mode, spawnReason) => {
      if (sentinelSwept.has(board)) return true; // a varredura deste tique já olhou o board
      const { runSentinelSweep } = await import("./sentinel-run");
      await runSentinelSweep(undefined, [board]);
      if (spawnReason) console.log(`[orchestrator ${board}] Sentinela olhou o board: ${spawnReason}`);
      return true;
    },
    recordTick: async (board) => {
      const s = await readOrchestratorState(board);
      // WS-12 (D16) — o SPAWN não mexe mais no streak por-item. Ele bumpava aqui todo item acionável PRESENTE,
      // o que entregava "duas spawns por board enquanto o item existir" no lugar de "duas TENTATIVAS por item"
      // (num caso real, um card limpo chegou a um streak alto sem nunca ter sido tentado). Quem bumpa
      // agora é o RESULTADO do run (noopAttributionFor), que sabe o que ele de fato tentou. O streak GLOBAL
      // (workSig/ranStreak) segue aqui: é o limitador de ritmo do board, e mede outra coisa.
      // fase 6: registra a olhada (o carimbo e o streak do board) SEM debitar o teto de tiques — a olhada é $0
      await writeOrchestratorState(board, applyTick(s, Date.now(), "autonomous", 0, sigByBoard.get(board) ?? "", false));
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
      // frase hoje, e o operador não tem como saber que a divisão de trabalho mudou (num caso real o board passou o dia
      // dizendo "nada acionável" com itens à vista). O dado já existe em noopByItem — só não era contado.
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
        capacityDetail: capacityDetailByBoard.get(board),
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
    if (mode !== "autonomous" || !paceAllowsBackground(board)) return; // só autônomo, em ritmo normal, dispara um tick imediato
    await runOrchestratorTick(buildTickDeps([{ board, mode }], reason));
  } catch {
    /* best-effort — nunca quebra o toggle/evento que o chamou */
  } finally {
    immediateInFlight.delete(board);
  }
}
