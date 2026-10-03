// O ROSTER de conversas do chat do Jido — a álgebra PURA de "uma aberta, as anteriores recuperáveis".
//
// Antes o board tinha UM ponteiro (`sessionId`) e "Nova conversa" era uma DELEÇÃO: a conversa anterior sumia da
// UI para sempre. O transcript continuava no disco (o CLI o grava por sessão), mas sem o id ninguém o achava de
// novo — o operador perdia o fio de uma investigação por um clique, e a única saída era caçar o `.jsonl` na mão.
// Aqui a mesma estrutura passa a guardar uma LISTA MRU: a conversa aberta na frente e até
// {@link MAX_RECOVERABLE_CHATS} anteriores atrás dela, recuperáveis com um toque (como o `--resume` do CLI).
//
// Duas invariantes governam tudo abaixo:
//  1. UMA ABERTA. `activeSessionId` é um escalar, não um conjunto: abrir uma conversa fecha a outra. O chat é
//     um painel só, com uma sessão headless só por board (o 409 do turno depende disso).
//  2. NADA É APAGADO POR TROCA. "Nova conversa" ARQUIVA (a entrada continua no roster), nunca deleta. O que sai
//     é só a MAIS ANTIGA quando o teto estoura — e mesmo essa perde apenas o PONTEIRO: o transcript segue no
//     disco, sob o dono dele (o CLI). Este módulo nunca remove arquivo nenhum.
//
// Puro e determinístico (o `now` entra por parâmetro) para ser testável sem fs — a IO, o lock e o formato em
// disco ficam no shell (session-store.ts), como gate-core/outbox/history-sync já fazem.

import { formatAge } from "./copilot-status";

/** Uma conversa no roster: a sessão do CLI + o medidor dela + o rótulo que a lista mostra. */
export interface CopilotChatEntry {
  sessionId: string;
  /** A primeira fala do operador nesta conversa — o rótulo da lista. Ausente = ainda não resolvido (conversa
   *  nova, ou o transcript ainda não tem fala humana). Resolvido do transcript e cacheado aqui. */
  title?: string;
  /** ISO do primeiro turno desta conversa. */
  startedAt: string;
  /** ISO do último turno — a idade que a lista mostra ("há 2h"). */
  lastTurnAt: string;
  turns: number;
  /** Tamanho do contexto depois do último turno (medida, não acumulador — ver session-store). */
  contextTokens: number;
  /** Custo acumulado da conversa (aqui somar é correto). */
  costUSD: number;
}

export interface ChatRoster {
  /** A conversa ABERTA. `null` = nenhuma (o operador acabou de começar do zero e ainda não falou). */
  activeSessionId: string | null;
  /** A última conversa que saiu de ativa: um turno DELA ainda em voo não pode reabri-la sozinho (ver o
   *  tombstone em session-store.ts). Some quando o operador a RETOMA de propósito. */
  discardedSessionId: string | null;
  /** MRU — a mais recente primeiro. A ativa, quando existe, é sempre a primeira. */
  chats: CopilotChatEntry[];
}

/**
 * Quantas conversas ANTERIORES o operador pode recuperar. A aberta não conta — ela está na tela, não no
 * histórico. Teto do roster = esta constante + 1.
 *
 * Por que um teto: o roster mora num JSON lido a cada turno e a lista é um menu que se lê de relance. Sem teto
 * ele viraria um arquivo de sessões que ninguém revisita — e a lista, uma rolagem.
 */
export const MAX_RECOVERABLE_CHATS = 5;

export const EMPTY_ROSTER: ChatRoster = { activeSessionId: null, discardedSessionId: null, chats: [] };

/**
 * Aplica o teto: mantém a ABERTA (onde quer que esteja) + as {@link MAX_RECOVERABLE_CHATS} anteriores mais
 * recentes. A aberta é preservada FORA da conta de propósito — expulsar a conversa que está na tela porque
 * cinco outras são mais recentes seria apagar o presente para caber o passado.
 */
export function trimRoster(r: ChatRoster): ChatRoster {
  const kept: CopilotChatEntry[] = [];
  let others = 0;
  for (const c of r.chats) {
    if (c.sessionId === r.activeSessionId) {
      kept.push(c);
      continue;
    }
    if (others < MAX_RECOVERABLE_CHATS) {
      kept.push(c);
      others += 1;
    }
  }
  return kept.length === r.chats.length ? r : { ...r, chats: kept };
}

/** A entrada da conversa aberta (null quando não há nenhuma). */
export function activeChat(r: ChatRoster): CopilotChatEntry | null {
  return r.activeSessionId ? (r.chats.find((c) => c.sessionId === r.activeSessionId) ?? null) : null;
}

/** As conversas RECUPERÁVEIS — tudo que não é a aberta, na ordem MRU. */
export function recoverableChats(r: ChatRoster): CopilotChatEntry[] {
  return r.chats.filter((c) => c.sessionId !== r.activeSessionId);
}

function withoutChat(chats: readonly CopilotChatEntry[], sessionId: string): CopilotChatEntry[] {
  return chats.filter((c) => c.sessionId !== sessionId);
}

/**
 * ABRE uma sessão como a conversa da vez (o início de cada turno/tick resolve o seu id e chama isto).
 * Idempotente: re-abrir a que já está aberta não mexe no medidor nem na ordem.
 *
 * Respeita o TOMBSTONE: um turno da conversa que o operador acabou de arquivar chega aqui atrasado e NÃO pode
 * reabri-la por conta própria — só uma retomada explícita ({@link resumeChat}) faz isso.
 */
export function activateChat(r: ChatRoster, sessionId: string, nowIso: string): ChatRoster {
  const sid = sessionId.trim();
  if (!sid || sid === r.discardedSessionId) return r;
  const existing = r.chats.find((c) => c.sessionId === sid);
  const entry: CopilotChatEntry = existing ?? {
    sessionId: sid,
    startedAt: nowIso,
    lastTurnAt: nowIso,
    turns: 0,
    contextTokens: 0,
    costUSD: 0,
  };
  if (existing && r.activeSessionId === sid && r.chats[0]?.sessionId === sid) return r;
  return trimRoster({
    ...r,
    activeSessionId: sid,
    chats: [entry, ...withoutChat(r.chats, sid)],
  });
}

/**
 * Fecha o turno de uma sessão no medidor dela (o evento `result` do CLI).
 *
 * O contexto é uma MEDIDA (o tamanho do prompt da última chamada de modelo), então ele SUBSTITUI; o custo é um
 * acumulador, então ele SOMA. Um turno que não reportou contexto mantém o último valor conhecido.
 *
 * Três recusas, cada uma pagando um erro real:
 *  • sessão ARQUIVADA por "Nova conversa" (tombstone) ⇒ ignora: o fim de um turno em voo não ressuscita o que
 *    o operador acabou de fechar.
 *  • sessão DESCONHECIDA que não é a aberta ⇒ ignora: seria ressuscitar como entrada nova uma conversa que o
 *    teto já expulsou.
 *  • sessão conhecida mas NÃO aberta ⇒ atualiza o medidor DELA, sem mexer na ordem nem em quem está aberto.
 *    Um straggler não rouba a tela — mas o histórico dele fica correto.
 */
export function recordChatTurn(
  r: ChatRoster,
  sessionId: string,
  usage: { contextTokens?: number | null; costUSD?: number | null },
  nowIso: string,
): ChatRoster {
  const sid = sessionId.trim();
  if (!sid || sid === r.discardedSessionId) return r;
  const idx = r.chats.findIndex((c) => c.sessionId === sid);
  if (idx < 0 && r.activeSessionId !== sid) return r;
  const prev = idx >= 0 ? r.chats[idx] : null;
  const next: CopilotChatEntry = {
    ...(prev ?? { sessionId: sid, startedAt: nowIso, turns: 0, contextTokens: 0, costUSD: 0, lastTurnAt: nowIso }),
    startedAt: prev?.startedAt || nowIso,
    lastTurnAt: nowIso,
    turns: (prev?.turns ?? 0) + 1,
    contextTokens: Math.max(0, usage.contextTokens ?? prev?.contextTokens ?? 0),
    costUSD: (prev?.costUSD ?? 0) + Math.max(0, usage.costUSD ?? 0),
  };
  if (idx < 0) return trimRoster({ ...r, chats: [next, ...r.chats] });
  const chats = r.chats.slice();
  chats[idx] = next;
  return { ...r, chats };
}

/**
 * "Nova conversa": FECHA a que está aberta e a deixa no histórico, recuperável. Nenhum ponteiro é apagado — o
 * que muda é que ninguém está aberto (`activeSessionId: null`), e a que saiu vira o tombstone.
 *
 * Sem conversa aberta é um no-op que PRESERVA o tombstone existente: dois cliques seguidos não podem destravar
 * a barreira contra o straggler da primeira.
 */
export function startNewChat(r: ChatRoster): ChatRoster {
  if (!r.activeSessionId) return r;
  return trimRoster({ ...r, activeSessionId: null, discardedSessionId: r.activeSessionId });
}

/**
 * RETOMA uma conversa do histórico — o gesto explícito do operador, e a única coisa que supera o tombstone
 * (foi ele quem escolheu voltar). Retorna `null` quando a sessão não está no roster: recuperar o que não é
 * oferecido seria transformar um id qualquer em ponteiro do board.
 */
export function resumeChat(r: ChatRoster, sessionId: string): ChatRoster | null {
  const sid = sessionId.trim();
  const entry = r.chats.find((c) => c.sessionId === sid);
  if (!entry) return null;
  return trimRoster({
    activeSessionId: sid,
    discardedSessionId: r.discardedSessionId === sid ? null : r.discardedSessionId,
    chats: [entry, ...withoutChat(r.chats, sid)],
  });
}

/** Grava o rótulo resolvido do transcript (cache) — sem mexer em ordem, medidor ou em quem está aberto. */
export function setChatTitle(r: ChatRoster, sessionId: string, title: string): ChatRoster {
  const t = title.trim();
  const idx = r.chats.findIndex((c) => c.sessionId === sessionId);
  if (idx < 0 || !t || r.chats[idx].title === t) return r;
  const chats = r.chats.slice();
  chats[idx] = { ...chats[idx], title: t };
  return { ...r, chats };
}

// ── Como uma conversa se APRESENTA na lista ──────────────────────────────────────────────────────────
// Puro e aqui (e não no componente) pela mesma razão de sempre neste pacote: teste de render está quebrado
// sob rolldown-vite, então a lógica que importa mora numa função pura — e a COPY, num lugar só.

/** O rótulo visível: a fala que a batizou, ou o que ela é enquanto não tem uma. */
export function chatTitle(c: { title?: string | null; turns?: number }): string {
  const t = c.title?.trim();
  if (t) return t;
  return c.turns ? "Conversa sem título" : "Conversa nova";
}

/**
 * A linha de baixo: quando foi, quanto andou, quanto custou — o que faz o operador reconhecer QUAL das cinco
 * é a que ele quer. Custo só aparece quando existe (um "· $0.00" seria ruído em toda linha).
 */
export function chatSubtitle(c: { lastTurnAt?: string; turns?: number; costUSD?: number }, nowMs: number): string {
  const turns = c.turns ?? 0;
  if (!turns) return "sem turnos ainda";
  const at = c.lastTurnAt ? Date.parse(c.lastTurnAt) : NaN;
  const age = Number.isFinite(at) ? formatAge(nowMs - at) : null;
  const when = age === "agora" ? "agora" : age ? `há ${age}` : null;
  return [when, `${turns} ${turns === 1 ? "turno" : "turnos"}`, (c.costUSD ?? 0) > 0 ? `$${c.costUSD!.toFixed(2)}` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * ESQUECE conversas cujo transcript não existe mais (o CLI coletou o `.jsonl`): oferecer na lista o que não
 * abre seria um botão que mente. Só o PONTEIRO é esquecido — nenhum arquivo é tocado.
 */
export function forgetChats(r: ChatRoster, sessionIds: readonly string[]): ChatRoster {
  const drop = new Set(sessionIds.filter(Boolean));
  if (!drop.size) return r;
  const chats = r.chats.filter((c) => !drop.has(c.sessionId));
  if (chats.length === r.chats.length) return r;
  return {
    ...r,
    activeSessionId: r.activeSessionId && drop.has(r.activeSessionId) ? null : r.activeSessionId,
    chats,
  };
}
