// O JUIZ DA TRIAGEM — o dispatcher. Núcleo DI (sem IO próprio; as deps de produção moram em triage-judge-deps.ts),
// irmão do dispatcher do proxy (proxy.ts) e com as mesmas travas, pelos mesmos motivos:
//   • só em só-negócio (`ultra`): um board human nunca chama o modelo (triageJudgeWork devolve vazio);
//   • os MESMOS interruptores do autorun: o master, o portão do board (board-pace.ts) e a admissão da máquina/janela da
//     conta seguram o juiz — nada é descartado, a próxima varredura tenta;
//   • LIMITADO: tentativas contadas ANTES da chamada, no máximo {@link TRIAGE_JUDGE_MAX_ATTEMPTS} por card; esgotado,
//     o card vai ao DONO com o motivo (`hold`) — nunca some da vista;
//   • o ESCRITOR re-planeja sobre o card FRESCO, sob o lock: um card que saiu da Triagem enquanto o juiz pensava, ou
//     que já tem veredito, não é tocado.
// Duas portas, ambas idempotentes: `nudgeTriageJudge` (logo depois de um card entrar na Triagem) e a varredura do
// tick da frota (`sweepTriageJudge`, no máximo a cada 5 min — pega o que um restart interrompeu).

import { deferredAnchor } from "@/lib/storymap/deferral";
import {
  buildTriageJudgePrompt,
  parseTriageJudgement,
  triageJudgeWork,
  type TriageJudgePlan,
  type TriageJudgement,
  type TriageOtherBoard,
} from "@/lib/storymap/triage/judge";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { gateOf, type BoardGatePort } from "./board-pace";
import type { ProxyLedgerEntry, ProxyLedgerStore } from "./proxy";

/** Chamadas ao juiz por card, para sempre — esgotado, o card vai ao dono. */
export const TRIAGE_JUDGE_MAX_ATTEMPTS = 2;
/**
 * Cards julgados por VARREDURA (a cada 5 min, no máximo). Ligar o só-negócio num board com um backlog na Triagem não
 * pode virar uma rajada: cada aceite também dispara a cascata do passo de destino. Espaçado assim, o backlog anda em
 * ritmo que o governador de capacidade e o orçamento acompanham; o nudge de um card novo não conta aqui.
 */
export const TRIAGE_JUDGE_MAX_PER_SWEEP = 3;
const LEDGER_MAX_ROWS = 500;

export interface TriageJudgeDeps {
  /** o contador de tentativas (o mesmo formato do ledger do proxy, noutro arquivo). */
  ledger: ProxyLedgerStore;
  listBoards(): Promise<string[]>;
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  readCards(board: string): Promise<Card[]>;
  readPrd(board: string): Promise<string | null>;
  /** os OUTROS boards do alvo (pacote, caminhos, escopo do PRD) — para o juiz mandar um card ao board dele. Ausente ⇒ sem roteamento. */
  otherBoards?(board: string): Promise<TriageOtherBoard[]>;
  /** muda o card de board (card-transfer.ts) — `ok:false` com o motivo quando a mudança recusa. */
  route?(board: string, cardId: string, toBoard: string, reason: string): Promise<{ ok: true } | { ok: false; error: string }>;
  masterEnabled(): boolean;
  /** o portão do board (desarmado, pausado, devagar) — board-pace.ts; ausente ⇒ só a configuração responde. */
  boardGate?: BoardGatePort;
  /** a admissão (janela da conta, RAM/load) — null quando admite. */
  admission(): string | null;
  /** a chamada de modelo: o prompt → o texto da resposta (lança numa falha). */
  judge(prompt: string): Promise<string>;
  /** o escritor: re-planeja sobre o card FRESCO sob o lock e grava — o plano aplicado, ou null (o card já saiu). */
  apply(board: string, cardId: string, judgement: TriageJudgement): Promise<TriageJudgePlan | null>;
  /**
   * «Adiado — não agora»: um card que nasce de algo adiado (parent/serves) nasce adiado também — o juiz NÃO o aceita
   * (num caso real, correções de um módulo adiado foram aceitas «porque o PRD ainda o punha no escopo» depois de o dono tirá-lo do ciclo).
   */
  deferChild?(board: string, cardId: string, anchor: Card): Promise<void>;
  /** leva o card ao dono com o motivo (tentativas esgotadas) — só se ele ainda está na Triagem sem veredito. */
  hold(board: string, cardId: string, reason: string): Promise<void>;
  /** os efeitos depois da escrita: ledger de transições, cascata, registro de decisões (best-effort). */
  after?(board: string, cardId: string, plan: TriageJudgePlan): Promise<void>;
  inFlight?: Set<string>;
  now?(): number;
  log?(line: string): void;
}

export type TriageJudgeOutcome =
  | { action: "skipped"; reason: string }
  | { action: "waiting"; reason: string }
  | { action: "judged"; verdict: TriageJudgePlan["action"] }
  | { action: "failed"; reason: string };

const IN_FLIGHT_KEY = Symbol.for("agileharness.triage-judge.inflight");
function globalInFlight(): Set<string> {
  const store = globalThis as unknown as { [IN_FLIGHT_KEY]?: Set<string> };
  return (store[IN_FLIGHT_KEY] ??= new Set());
}

/** Os cards (`board/cardId`) que o juiz está julgando AGORA neste processo — a linha de estado do card os mostra. */
export function triageJudgeInFlight(): string[] {
  return [...globalInFlight()];
}

const keyOf = (board: string, cardId: string) => `${board}/${cardId}#triage-judge`;
const upsert = (entries: ProxyLedgerEntry[], row: ProxyLedgerEntry) => [...entries.filter((e) => e.key !== row.key), row].slice(-LEDGER_MAX_ROWS);

/** Os cards do board que o juiz deve julgar AGORA: o trabalho puro menos os já julgados/esgotados no ledger. PURA. */
export function judgeWork(cards: readonly Card[], config: BoardConfig, board: string, ledger: readonly ProxyLedgerEntry[]): Card[] {
  const byKey = new Map(ledger.map((e) => [e.key, e]));
  return triageJudgeWork(cards, config).filter((c) => {
    const e = byKey.get(keyOf(board, c.id));
    return !e || (e.outcome !== "answered" && e.attempts < TRIAGE_JUDGE_MAX_ATTEMPTS);
  });
}

/** UM card: julga e aplica, quando os interruptores e o teto deixam. Nunca lança. */
export async function judgeTriageCard(deps: TriageJudgeDeps, board: string, cardId: string): Promise<TriageJudgeOutcome> {
  const log = deps.log ?? ((l: string) => console.log(`[triage-judge] ${l}`));
  const inFlight = deps.inFlight ?? globalInFlight();
  const cardKey = `${board}/${cardId}`;
  try {
    const config = await deps.readBoardConfig(board);
    if (!config) return { action: "skipped", reason: "board ilegível" };
    const cards = await deps.readCards(board);
    const ledger = await deps.ledger.load();
    const card = judgeWork(cards, config, board, ledger).find((c) => c.id === cardId);
    if (!card) return { action: "skipped", reason: "nada a julgar neste card" };
    const anchor = deferredAnchor(card, new Map(cards.map((c) => [c.id, c])));
    if (anchor && deps.deferChild) {
      await deps.deferChild(board, cardId, anchor).catch(() => {});
      log(`${board}/${cardId}: nasceu de «${anchor.title}», que está adiado — fica adiado, o juiz não o aceita`);
      return { action: "skipped", reason: "nasceu de um card adiado — adiado também" };
    }
    if (!deps.masterEnabled()) return { action: "waiting", reason: "autorun desligado — o juiz espera" };
    const gate = gateOf(deps.boardGate, board, config);
    if (gate.held) return { action: "waiting", reason: `${gate.why} — o juiz espera` };
    if (inFlight.has(cardKey)) return { action: "waiting", reason: "o juiz já está neste card" };
    const refused = deps.admission();
    if (refused) return { action: "waiting", reason: `máquina/janela saturada: ${refused}` };

    inFlight.add(cardKey);
    try {
      const key = keyOf(board, cardId);
      const prior = ledger.find((e) => e.key === key);
      const attempts = (prior?.attempts ?? 0) + 1;
      await deps.ledger.persist(upsert(ledger, { key, attempts, lastAt: new Date((deps.now ?? Date.now)()).toISOString(), outcome: "running" }));

      const otherBoards = deps.route && deps.otherBoards ? await deps.otherBoards(board).catch(() => [] as TriageOtherBoard[]) : [];
      const prompt = buildTriageJudgePrompt({ config, prd: await deps.readPrd(board).catch(() => null), card, cards, otherBoards });
      let failure: string | null = null;
      let plan: TriageJudgePlan | null = null;
      try {
        const parsed = parseTriageJudgement(await deps.judge(prompt), card, cards, { boards: otherBoards.map((b) => b.id) });
        if ("error" in parsed) failure = parsed.error;
        else plan = await deps.apply(board, cardId, parsed);
        // Mandar ao board a que pertence: a mudança de board é o efeito (o escritor não grava nada aqui). Recusada ⇒ o card
        // fica com o dono, com o motivo — nunca aceito «no lugar» do board certo.
        if (plan?.action === "route") {
          const moved = deps.route ? await deps.route(board, cardId, plan.toBoard, plan.reason) : { ok: false as const, error: "sem roteamento" };
          if (!moved.ok) {
            await deps.hold(board, cardId, `o juiz mandaria este card ao board «${plan.toBoard}», mas a mudança recusou: ${moved.error}`).catch(() => {});
            plan = { action: "hold", reason: moved.error, card: plan.card };
          }
        }
      } catch (err) {
        failure = String(err instanceof Error ? err.message : err).slice(0, 200);
      }
      const rows = await deps.ledger.load();
      const outcome: ProxyLedgerEntry["outcome"] = failure ? "failed" : "answered";
      await deps.ledger.persist(
        upsert(rows, { key, attempts, lastAt: new Date((deps.now ?? Date.now)()).toISOString(), outcome, ...(failure ? { detail: failure } : {}) }),
      );
      if (failure) {
        if (attempts >= TRIAGE_JUDGE_MAX_ATTEMPTS) {
          await deps.hold(board, cardId, `o juiz da triagem falhou ${attempts}x (${failure}) — a decisão é sua`).catch(() => {});
          log(`${board}/${cardId}: juiz esgotou as tentativas — card com o dono`);
        }
        return { action: "failed", reason: failure };
      }
      if (!plan) return { action: "skipped", reason: "o card saiu da Triagem (ou já tem veredito) enquanto o juiz pensava" };
      log(`${board}/${cardId}: juiz → ${plan.action}${"to" in plan ? ` (${plan.to})` : plan.action === "route" ? ` (board ${plan.toBoard})` : ""}`);
      await deps.after?.(board, cardId, plan).catch(() => {});
      return { action: "judged", verdict: plan.action };
    } finally {
      inFlight.delete(cardKey);
    }
  } catch (err) {
    return { action: "skipped", reason: `falha: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface TriageJudgeSweepReport {
  judged: Array<{ board: string; cardId: string; verdict: TriageJudgePlan["action"] }>;
  waiting: Array<{ board: string; cardId: string; reason: string }>;
}

/** A varredura: todo board, todo card pendente, um a um (um card esperando nunca segura o próximo). Nunca lança. */
export async function sweepTriageJudge(deps: TriageJudgeDeps): Promise<TriageJudgeSweepReport> {
  const report: TriageJudgeSweepReport = { judged: [], waiting: [] };
  let calls = 0;
  for (const board of await deps.listBoards().catch(() => [] as string[])) {
    const config = await deps.readBoardConfig(board).catch(() => null);
    if (!config) continue;
    const cards = await deps.readCards(board).catch(() => [] as Card[]);
    const ledger = await deps.ledger.load().catch(() => [] as ProxyLedgerEntry[]);
    for (const card of judgeWork(cards, config, board, ledger)) {
      if (calls >= TRIAGE_JUDGE_MAX_PER_SWEEP) return report;
      const out = await judgeTriageCard(deps, board, card.id);
      if (out.action === "judged" || out.action === "failed") calls++;
      if (out.action === "judged") report.judged.push({ board, cardId: card.id, verdict: out.verdict });
      else if (out.action === "waiting") report.waiting.push({ board, cardId: card.id, reason: out.reason });
    }
  }
  return report;
}
