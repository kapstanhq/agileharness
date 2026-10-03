// A TOOL `ah_health` — a medida de saúde de AGORA para quem conserta a ferramenta, SOMENTE-LEITURA. A forma da resposta, a
// base do delta e o recorte por board moram aqui (puros, com os deps injetados); mcp/tools.ts só a registra.
//
// O QUE ELA ENTREGA (o passo «medir» do ciclo de conserto, skill harness-cycle):
//   • os 12 sinais, com valor, nível, limiar, evidência curta e o primeiro passo do conserto;
//   • o DELTA contra uma leitura que o tick já gravou no health.jsonl — por padrão a última; com `since`, a leitura de
//     antes daquele instante (é assim que se prova um conserto: a base é de ANTES do release, não de 5 min atrás);
//   • a versão da ferramenta no ar — a que ESTE processo carregou no boot (tool-version.ts), não o recibo do disco de
//     agora —, para a sessão conferir que mede o código que acabou de liberar. Um recibo mais novo no disco (swap sem
//     restart) aparece na nota como «restart pendente», nunca como a versão no ar.
//
// NÃO GRAVA NADA: nem leitura no health.jsonl, nem card. Quem grava é o tick; quem abre trabalho é a sessão.

import { healthDelta, recordAsReading, summarizeSignals, type HealthDelta, type HealthLevel, type HealthRecord, type HealthReport, type HealthSignal } from "./ah-health";
import { BOARD_SCOPE_CAVEAT } from "./health-scope";
import { toolReleaseNote, type LiveToolVersion, type ToolVersion } from "../tool-version";

export interface AhHealthArgs {
  /** mede só a fatia deste board (health-scope.ts). */
  board?: string;
  /** ISO — o delta compara com a última leitura gravada até este instante. */
  since?: string;
}

export interface AhHealthDeps {
  now(): number;
  /** os ids dos boards que existem. */
  boards(): Promise<string[]>;
  /** mede agora; `board` null = a instalação inteira. */
  measure(now: number, board: string | null): Promise<HealthReport>;
  /** as leituras gravadas pelo tick (qualquer ordem). */
  history(): Promise<HealthRecord[]>;
  /** a versão que o processo roda (a foto do boot) e o release que espera restart. */
  release(): LiveToolVersion;
}

export interface AhHealthResult {
  at: string;
  scope: { kind: "installation" } | { kind: "board"; board: string; caveat: string };
  worst: HealthLevel;
  /** uma linha: quantos vermelhos/atenção/ok/não medíveis, e quais. */
  summary: string;
  signals: HealthSignal[];
  /** o delta contra a leitura gravada; `null` quando não há base ou o recorte é de um board (ver `deltaNote`). */
  delta: (Pick<HealthDelta, "improved" | "worsened" | "worsenedLevel" | "line" | "signals"> & { against: string; baselineNote: string | null }) | null;
  deltaNote: string | null;
  /**
   * a versão da ferramenta que o processo roda (o recibo lido no boot, ligado ao build); `null` quando o build não passou
   * pelo release ou foi trocado fora dele (ver `releaseNote`, que também diz o restart pendente).
   */
  release: ToolVersion | null;
  releaseNote: string | null;
}

export type AhHealthOutcome = { ok: true; result: AhHealthResult } | { ok: false; error: string };

/**
 * A leitura gravada que serve de BASE do delta. Sem `since`, a última; com ele, a última até aquele instante — e, se o
 * ledger só tem leituras DEPOIS dele (o tick começou depois do instante pedido), a primeira delas, dito na nota. `null`
 * quando não há leitura nenhuma. PURA.
 */
export function pickBaseline(history: readonly HealthRecord[], sinceMs: number | null): { record: HealthRecord; note: string | null } | null {
  const sorted = [...history].sort((a, z) => a.at.localeCompare(z.at));
  if (!sorted.length) return null;
  if (sinceMs == null) return { record: sorted[sorted.length - 1]!, note: null };
  const upTo = sorted.filter((r) => Date.parse(r.at) <= sinceMs);
  if (upTo.length) return { record: upTo[upTo.length - 1]!, note: null };
  return { record: sorted[0]!, note: "não há leitura gravada até `since` — a base é a primeira leitura depois dele" };
}

/** O que a tool devolve. Erro de argumento (board inexistente, `since` que não é data) volta como `ok: false`. */
export async function ahHealth(args: AhHealthArgs, deps: AhHealthDeps): Promise<AhHealthOutcome> {
  let sinceMs: number | null = null;
  if (args.since !== undefined) {
    sinceMs = Date.parse(args.since);
    if (!Number.isFinite(sinceMs)) return { ok: false, error: `since «${args.since}» não é um instante ISO (ex.: 2026-10-02T03:00:00Z)` };
  }
  if (args.board !== undefined) {
    const boards = await deps.boards();
    if (!boards.includes(args.board)) return { ok: false, error: `o board «${args.board}» não existe. Boards: ${boards.join(", ") || "(nenhum)"}` };
  }

  const now = deps.now();
  const board = args.board ?? null;
  const [report, history] = await Promise.all([deps.measure(now, board), deps.history()]);

  let delta: AhHealthResult["delta"] = null;
  let deltaNote: string | null = null;
  if (board) {
    // O tick grava a INSTALAÇÃO; comparar o recorte de um board com ela seria comparar coisas diferentes.
    deltaNote = "o delta compara a instalação inteira (é o que o tick grava): chame sem `board` para ele; com `board` vale a medida do recorte";
  } else {
    const base = pickBaseline(history, sinceMs);
    if (!base) deltaNote = "ainda não há leitura gravada em health.jsonl (o tick grava a cada poucos minutos): sem base para o delta";
    else {
      const d = healthDelta(recordAsReading(base.record), report);
      delta = { against: base.record.at, baselineNote: base.note, improved: d.improved, worsened: d.worsened, worsenedLevel: d.worsenedLevel, line: d.line, signals: d.signals };
    }
  }

  const release = deps.release();
  return {
    ok: true,
    result: {
      at: report.at,
      scope: board ? { kind: "board", board, caveat: BOARD_SCOPE_CAVEAT } : { kind: "installation" },
      worst: report.worst,
      summary: summarizeSignals(report.signals),
      signals: report.signals,
      delta,
      deltaNote,
      release: release.running.version,
      releaseNote: toolReleaseNote(release),
    },
  };
}

/** Os deps de produção. Imports dinâmicos: a tool só paga o Inbox e o tmux quando é chamada. */
export async function defaultAhHealthDeps(): Promise<AhHealthDeps> {
  const [{ listBoards }, { diskHealthLedger, measureHealthNow }, { readLiveToolVersion }] = await Promise.all([
    import("@/lib/storymap/repo"),
    import("./health-deps"),
    import("../tool-version"),
  ]);
  return {
    now: () => Date.now(),
    boards: async () => (await listBoards()).map((b) => b.id),
    measure: (now, board) => measureHealthNow(now, board ? { board } : {}),
    history: () => diskHealthLedger().read(),
    release: () => readLiveToolVersion(),
  };
}
