// A CAIXA DE CORREIO DO CARD (fase 6, papel 6D — AGENTS-ARCH §4.1, categoria B). Núcleo DI; as deps de produção moram
// em card-intents-deps.ts.
//
// Antes: o dono movia (ou adiava, apagava, refinava) um card que tinha um condutor vivo e o condutor NÃO era avisado —
// num caso real o dono respondeu e moveu o card, nada chegou à sessão, e um condutor novo só pegou o card ~40 h depois.
// Agora toda ação do DONO num card conduzido:
//   1. é aplicada NA HORA, pelo plano de controle (a ação de servidor) — nenhum LLM fica entre o clique e o efeito;
//   2. vira um EVENTO durável em `.runner/card-intents.jsonl` (quem, o quê, de onde para onde, se o aviso chegou);
//   3. vira um AVISO FIXO à sessão viva do condutor — palavras fixas, só ids com forma de id, nunca texto de quem
//      chamou —, e só para um pane que prova rodar o claude (a mesma entrega das respostas, conductor-pause.ts).
// A regra que fecha o ciclo: NUNCA desfazer em silêncio um movimento do dono. A skill do condutor diz «obedeça ou
// contra-proponha no Inbox», e o `move_card` de um agente que DESFARIA o último movimento do dono é recusado aqui
// ({@link ownerMoveRevertRefusal}).

import { isConducted } from "@/lib/storymap/driver";
import type { Card } from "@/lib/storymap/types";

/** O que o dono fez no card. */
export type CardIntentKind =
  | "move"
  | "undo-move"
  | "defer"
  | "delete"
  | "refine"
  | "report-bug"
  | "retire"
  /** integração da fase 6 — «Parar condutor» / «Devolver ao fluxo» (card ou Inbox): o evento fica no registro como as
   *  outras ações do dono; o aviso chega antes de a sessão ser encerrada. */
  | "stop-conductor"
  | "return-to-flow";

export interface CardIntent {
  v: 1;
  id: string;
  at: string;
  board: string;
  cardId: string;
  kind: CardIntentKind;
  /** move/undo-move: o status de antes e o de depois. */
  from?: string | null;
  to?: string | null;
  /** quem — sempre o dono (o operador pela tela ou a sessão dele). */
  by: "human";
  /** o aviso à sessão viva: entregue, sem sessão viva (o card estacionado lê o card ao voltar), ou não entregue. */
  notice: "delivered" | "no-live-session" | "undeliverable" | "unknown";
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = (s: string | null | undefined) => (s && SAFE_ID.test(s) ? s : "?");

/** O rodapé de toda linha: a regra do dono. */
const RULE =
  "Nunca desfaça uma ação do dono: obedeça ou, se discordar, contra-proponha no Inbox (ask_question com o marcador [humano] e o porquê).";

/**
 * A linha FIXA que o condutor vivo recebe — PURA. Só ids com forma de id entram (status e card), nunca um nome de
 * coluna, um título ou um motivo digitado: é texto que vai para o terminal de um agente.
 */
export function intentLine(intent: Pick<CardIntent, "kind" | "from" | "to">): string {
  switch (intent.kind) {
    case "move":
      return `aviso do dono — o dono MOVEU este card de «${id(intent.from)}» para «${id(intent.to)}» pela tela. Releia o card (get_card) e siga a partir do lugar novo. ${RULE}`;
    case "undo-move":
      return `aviso do dono — o dono DESFEZ um movimento deste card: ele voltou de «${id(intent.from)}» para «${id(intent.to)}». Releia o card (get_card) e siga a partir dali. ${RULE}`;
    case "defer":
      return `aviso do dono — o dono ADIOU este card (não agora). Pare o que está fazendo: commite o que há no worktree, atualize a seção «Estado do condutor» no card e encerre o turno sem pedir mais nada. ${RULE}`;
    case "delete":
      return `aviso do dono — o dono mandou este card para a LIXEIRA. Pare: commite o que há no worktree (o branch fica preservado) e encerre o turno. Não recrie o card. ${RULE}`;
    // A reabertura (reopen.ts applyReopen) tira o card da condução: a skill da reabertura assume no passo de destino.
    case "refine":
      return `aviso do dono — o dono REABRIU este card para um refino: ele saiu da sua condução e a reabertura assume. Pare: commite o que há no worktree (o branch fica preservado) e encerre o turno sem mexer no card. ${RULE}`;
    case "report-bug":
      return `aviso do dono — o dono REPORTOU UM BUG neste card: ele saiu da sua condução e a reabertura assume. Pare: commite o que há no worktree (o branch fica preservado) e encerre o turno sem mexer no card. ${RULE}`;
    case "retire":
      return `aviso do dono — o dono pediu para DESCONTINUAR este card. Pare: commite o que há no worktree e encerre o turno sem seguir com a construção. ${RULE}`;
    // Estes dois ENCERRAM a sessão na mesma ação (actions.ts releaseConductedCard): o aviso é só para constar no
    // terminal. Nada de «commite agora» — a ordem não daria tempo de ser cumprida, e o kill no meio de um commit deixaria
    // `index.lock` ou um commit pela metade no worktree preservado.
    case "stop-conductor":
      return `aviso do dono — o dono PAROU o condutor deste card: a sessão está sendo encerrada agora e o card fica guardado como adiado. Não comece nada novo: o worktree e o branch ficam preservados como estão. ${RULE}`;
    case "return-to-flow":
      return `aviso do dono — o dono DEVOLVEU este card ao fluxo das colunas: ele saiu da sua condução e a sessão está sendo encerrada agora. Não comece nada novo: o worktree e o branch ficam preservados como estão. ${RULE}`;
  }
}

export interface CardIntentDeps {
  append(intent: CardIntent): Promise<void>;
  /**
   * O pane tmux da sessão VIVA do condutor deste card: o nome, `null` = nenhum condutor vivo, `undefined` = a sonda não
   * respondeu (não se sabe quem está vivo — nada é digitado).
   */
  livePane(board: string, cardId: string): Promise<string | null | undefined>;
  /** o pane roda o binário do claude? (nunca digitar num shell) */
  runsClaude(tmux: string): Promise<boolean>;
  /** digita e envia a linha — true se entregue. */
  deliver(tmux: string, text: string): Promise<boolean>;
  newId(): string;
  now?(): number;
  log?(line: string): void;
}

/**
 * O dono acabou de agir num card. `card` é o card ANTES da ação (o de um card apagado não existe mais depois): só um
 * card CONDUZIDO gera evento e aviso. Devolve o evento gravado, ou null. Nunca lança — a ação do dono já aconteceu e um
 * aviso que falha não a desfaz.
 */
export async function noteOwnerCardIntent(
  deps: CardIntentDeps,
  input: { board: string; card: Pick<Card, "id" | "routing"> | null | undefined; kind: CardIntentKind; from?: string | null; to?: string | null },
): Promise<CardIntent | null> {
  const log = deps.log ?? ((l: string) => console.log(`[card-intents] ${l}`));
  const card = input.card;
  if (!card || !isConducted(card)) return null;
  const base = { v: 1 as const, id: deps.newId(), at: new Date((deps.now ?? Date.now)()).toISOString(), board: input.board, cardId: card.id, kind: input.kind, by: "human" as const };
  const intent: CardIntent = { ...base, ...(input.from !== undefined ? { from: input.from } : {}), ...(input.to !== undefined ? { to: input.to } : {}), notice: "unknown" };
  try {
    const pane = await deps.livePane(input.board, card.id).catch(() => undefined);
    if (pane === null) intent.notice = "no-live-session";
    else if (pane) intent.notice = (await deps.runsClaude(pane)) && (await deps.deliver(pane, intentLine(intent))) ? "delivered" : "undeliverable";
  } catch {
    intent.notice = "undeliverable";
  }
  await deps.append(intent).catch((err) => log(`${input.board}/${card.id}: o evento não foi gravado — ${err instanceof Error ? err.message : String(err)}`));
  log(`${input.board}/${card.id}: ação do dono (${input.kind}) — aviso ao condutor: ${intent.notice}`);
  return intent;
}

/**
 * Um AGENTE quer mover o card para `to`: isso DESFARIA o último movimento do dono? PURA. Sim quando o evento mais
 * recente de movimento do dono neste card é a ÚLTIMA coisa que aconteceu com o status (o card ainda está onde o dono o
 * pôs) e o destino é exatamente de onde o dono o tirou. Devolve o motivo da recusa, ou null.
 */
export function ownerMoveRevertRefusal(intents: readonly CardIntent[], board: string, card: Pick<Card, "id" | "status">, to: string): string | null {
  let last: CardIntent | null = null;
  for (const i of intents) {
    if (i.board !== board || i.cardId !== card.id || (i.kind !== "move" && i.kind !== "undo-move")) continue;
    if (!last || i.at >= last.at) last = i;
  }
  if (!last || !last.from || last.to !== card.status || to !== last.from) return null;
  return (
    `o dono moveu este card de «${last.from}» para «${last.to}» (${last.at.slice(0, 16).replace("T", " ")}) e um agente não desfaz o movimento dele. ` +
    "Obedeça e siga daqui, ou contra-proponha no Inbox (ask_question com o marcador [humano] e o porquê)."
  );
}

// ── o «Desfazer» de um movimento ────────────────────────────────────────────────────────────────────────

/** Folga do relógio entre o salto gravado no ledger e o que ele disparou (o run nasce DEPOIS do salto). */
export const MOVE_UNDO_SLACK_MS = 1_000;

/**
 * O «Desfazer» de um movimento do dono só desfaz o que AQUELE movimento disparou. PURA. Antes o desfazer matava
 * qualquer run do card — inclusive um que já rodava antes do arrasto — e deixava de pé o despacho do condutor que o
 * movimento tinha feito (driver carimbado + fila: um condutor nascia no card que já tinha voltado).
 *   • `killRun` — há um run do engine e ele nasceu no instante do movimento ou depois;
 *   • `dropDispatch` — há uma entrada NOVA na fila do condutor (admitida no instante do movimento ou depois; nem
 *     retomada, nem passagem do train) e nenhum condutor vivo: o despacho foi deste movimento e ainda não virou sessão.
 * Sem o instante do movimento (`movedAtMs` null — o ledger não o tem), nada é desfeito: não dá para provar a autoria.
 */
export function moveUndoPlan(input: {
  movedAtMs: number | null;
  run: { startedAt: number } | null;
  queued: { queuedAt: string; resume?: boolean; handoff?: unknown; attempts?: number } | null;
  liveConductor: boolean;
}): { killRun: boolean; dropDispatch: boolean } {
  const at = input.movedAtMs;
  if (at == null || !Number.isFinite(at)) return { killRun: false, dropDispatch: false };
  const since = at - MOVE_UNDO_SLACK_MS;
  const killRun = !!input.run && input.run.startedAt >= since;
  const q = input.queued;
  const queuedAt = q ? Date.parse(q.queuedAt) : NaN;
  const dropDispatch = !!q && !q.resume && !q.handoff && Number.isFinite(queuedAt) && queuedAt >= since && !input.liveConductor;
  return { killRun, dropDispatch };
}

/** O instante do salto `from → to` mais recente do card no ledger, ou null. PURA. */
export function forwardMoveAt(transitions: ReadonlyArray<{ at: string; from: string | null; to: string }>, from: string, to: string): number | null {
  let best: number | null = null;
  for (const t of transitions) {
    if (t.from !== from || t.to !== to) continue;
    const ms = Date.parse(t.at);
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

/** Lê as linhas JSONL do registro, descartando as tortas. PURA. */
export function parseCardIntents(text: string): CardIntent[] {
  const out: CardIntent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as CardIntent;
      if (o && o.v === 1 && typeof o.board === "string" && typeof o.cardId === "string" && typeof o.kind === "string" && typeof o.at === "string") out.push(o);
    } catch {
      /* linha torta: ignorada */
    }
  }
  return out;
}
