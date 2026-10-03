// O RITMO DO BOARD — pausar, andar devagar ou andar normal. PURO (zero IO; o arquivo mora em board-pace-store.ts e a
// ação com os efeitos, em board-pace-actions.ts).
//
// POR QUE EXISTE: o único interruptor por board era `autorunDisabled`, no board.yaml — sem botão (só um
// agente o acionava), liga/desliga apenas, sem dizer quem desligou nem por quê, sem prazo, e sem parar o que já estava
// rodando. O operador pediu um jeito de ele E o agente que orquestra pausarem um board inteiro para não gastar cota à toa,
// e de ajustarem a velocidade sem editar configuração.
//
// TRÊS POSIÇÕES:
//   • `paused` — nada automático COMEÇA no board. O que estava rodando termina (`drain`) ou é parado e guardado para
//     voltar na retomada (`stop`).
//   • `slow`   — um card por vez (uma sessão de condutor, um run de coluna) e sem os automáticos de fundo (o auditor
//     sorteado, o copiloto). O que destrava o card em voo (procurador, juiz, provas, vigia) segue.
//   • `normal` — o que o board declara.
//
// O PORTÃO ÚNICO: {@link resolveBoardGate} responde por `autorunDisabled` (o board nunca armado) E pelo ritmo. Todo
// automático pergunta a ele — nenhum lê `autorunDisabled` por conta própria (board-pace.gate.test.ts guarda isso).
//
// DUAS CAMADAS, e o ritmo em vigor é o MAIS LENTO delas (regra do operador: «um agente só desfaz a pausa que um agente
// fez»). Cada board guarda um freio do DONO e um freio dos AGENTES, separados:
//   • desacelerar é de todos — um agente põe (ou aperta) o freio dos agentes em qualquer board;
//   • o agente só mexe na camada dele: nunca passa do que o dono fixou, e nada do que ele grave muda o freio do dono
//     (nem o prazo, nem o modo, nem «de quem é» a pausa — era a brecha de uma camada só: re-pausar por cima virava o
//     agente o autor, e ele retomava);
//   • o dono manda nas duas: a escolha dele substitui o freio dele e apaga o dos agentes.
//
// O ESTADO É DE OPERAÇÃO, não do produto: fica no estado do runner (como a trava de capacidade), não no board.yaml —
// pausar não gera commit de board, e o `autorunDisabled` continua sendo só «este board nunca foi armado».

import type { BoardConfig } from "@/lib/storymap/types";

export type PaceLevel = "paused" | "slow" | "normal";
export const PACE_LEVELS: readonly PaceLevel[] = ["paused", "slow", "normal"];
export function isPaceLevel(v: unknown): v is PaceLevel {
  return typeof v === "string" && (PACE_LEVELS as readonly string[]).includes(v);
}

/** A ordem das posições: maior = mais rápido. PURA. */
const RANK: Record<PaceLevel, number> = { paused: 0, slow: 1, normal: 2 };
export function paceRank(level: PaceLevel): number {
  return RANK[level];
}

/** Como a pausa trata o que já está rodando: `drain` deixa terminar, `stop` para e guarda para a retomada. */
export type PauseMode = "drain" | "stop";
export function isPauseMode(v: unknown): v is PauseMode {
  return v === "drain" || v === "stop";
}

/** Quem mudou o ritmo. `id` é um rótulo de auditoria (o nome do token do agente), nunca um segredo. */
export interface PaceActor {
  kind: "owner" | "agent";
  id?: string;
}

/** UM freio (o do dono ou o dos agentes): o ritmo que ele impõe, quem pôs, quando, por quê e até quando. */
export interface PaceHold {
  level: Exclude<PaceLevel, "normal">;
  by: PaceActor;
  at: string;
  reason?: string;
  /** ISO — quando este freio sai sozinho (ou afrouxa para {@link resumeTo}). Ausente = sem prazo. */
  until?: string;
  /** a pausa com prazo foi posta sobre um board que andava devagar: vencido o prazo, o freio volta a `slow`. */
  resumeTo?: "slow";
  mode?: PauseMode;
}

/** O que a pausa segurou num card, para devolver na retomada. */
export interface PaceHeldEntry {
  cardId: string;
  /** `stopped` = um run em voo foi parado; `entry` = o card entrou num passo e o disparo foi retido. */
  why: "stopped" | "entry";
  at: string;
}

/** Uma mudança de ritmo, para o histórico curto do board. `level` é o que foi PEDIDO. */
export interface PaceChange {
  level: PaceLevel;
  by: PaceActor;
  at: string;
  reason?: string;
  until?: string;
  mode?: PauseMode;
  /** a mudança foi o PRAZO vencendo (ninguém clicou). */
  expired?: true;
}

/** A linha de um board no arquivo de ritmo. Board sem linha (ou sem freio nenhum) = `normal`. */
export interface BoardPaceRow {
  board: string;
  /** o freio do dono. */
  owner?: PaceHold;
  /** o freio dos agentes. */
  agent?: PaceHold;
  held?: PaceHeldEntry[];
  history?: PaceChange[];
}

/** Quantas mudanças o histórico guarda (as mais recentes). */
export const PACE_HISTORY_MAX = 20;
/** O teto de entradas retidas guardadas por board (um board pausado por dias não pode crescer sem fim). */
export const PACE_HELD_MAX = 500;
/** Em `slow`: quantas sessões de condutor, e quantos runs de coluna, o board carrega de uma vez. */
export const SLOW_MAX_PARALLEL = 1;
/** O prazo máximo de um freio com volta automática (30 dias): acima disso, é um freio sem prazo. */
export const PACE_UNTIL_MAX_MS = 30 * 24 * 60 * 60_000;
export const PACE_REASON_MAX = 300;

function validIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

// ── os freios em vigor ───────────────────────────────────────────────────────────────────────────────

/** O prazo deste freio já venceu? PURA. */
export function holdExpired(h: Pick<PaceHold, "until"> | null | undefined, now: number): boolean {
  return !!h && validIso(h.until) && Date.parse(h.until) <= now;
}

/**
 * O freio EM VIGOR agora: o próprio, enquanto o prazo não vence; vencido, o `slow` para onde ele afrouxa — ou nada. O
 * prazo vencido já conta, mesmo antes de a varredura gravar. PURA.
 */
export function liveHold(h: PaceHold | null | undefined, now: number): PaceHold | null {
  if (!h) return null;
  if (!holdExpired(h, now)) return h;
  if (h.level === "paused" && h.resumeTo === "slow") return { level: "slow", by: h.by, at: h.until as string, ...(h.reason ? { reason: h.reason } : {}) };
  return null;
}

/** O freio que MANDA agora: o mais lento dos dois em vigor (empate: o do dono). Null = ritmo normal. PURA. */
export function holdInForce(row: BoardPaceRow | null | undefined, now: number): PaceHold | null {
  const owner = liveHold(row?.owner, now);
  const agent = liveHold(row?.agent, now);
  if (!owner || !agent) return owner ?? agent;
  return paceRank(agent.level) < paceRank(owner.level) ? agent : owner;
}

/** O ritmo em vigor AGORA. PURA. */
export function effectivePaceLevel(row: BoardPaceRow | null | undefined, now: number): PaceLevel {
  return holdInForce(row, now)?.level ?? "normal";
}

/** O modo da pausa em vigor: `stop` se algum freio que pausa pediu «parar agora». Null fora da pausa. PURA. */
export function effectivePauseMode(row: BoardPaceRow | null | undefined, now: number): PauseMode | null {
  const pausing = [liveHold(row?.owner, now), liveHold(row?.agent, now)].filter((h): h is PaceHold => h?.level === "paused");
  if (!pausing.length) return null;
  return pausing.some((h) => h.mode === "stop") ? "stop" : "drain";
}

/** Algum freio da linha tem prazo vencido e ainda não varrido? PURA. */
export function paceExpired(row: BoardPaceRow | null | undefined, now: number): boolean {
  return holdExpired(row?.owner, now) || holdExpired(row?.agent, now);
}

// ── o portão ─────────────────────────────────────────────────────────────────────────────────────────

/** De onde veio a resposta do portão. */
export type BoardGateSource = "disarmed" | "pace" | "unreadable" | "default";

/** O que TODO automático pergunta antes de começar algo num board. */
export interface BoardGate {
  level: PaceLevel;
  /** nada automático começa (pausado, desarmado, ou o arquivo de ritmo não se lê). */
  held: boolean;
  /** os automáticos de fundo rodam (só em `normal`). */
  background: boolean;
  source: BoardGateSource;
  /** a frase para o motivo de espera e para o log — sem jargão. */
  why: string;
}

const WHO: Record<PaceActor["kind"], string> = { owner: "pelo dono", agent: "por um agente" };

/**
 * O PORTÃO. `config` é a configuração do board (null = ilegível ⇒ segura, a direção segura); `row` é a linha de ritmo
 * (ausente = normal); `unreadable` diz que o ARQUIVO de ritmo existe e não se lê — ilegível não é «sem pausa»: lido
 * como vazio, um board que o dono pausou voltaria a gastar sozinho. PURA.
 */
export function resolveBoardGate(
  config: Pick<BoardConfig, "autorunDisabled"> | null | undefined,
  row: BoardPaceRow | null | undefined,
  now: number,
  unreadable = false,
): BoardGate {
  if (!config) return { level: "paused", held: true, background: false, source: "unreadable", why: "a configuração do board não pôde ser lida" };
  if (config.autorunDisabled) return { level: "paused", held: true, background: false, source: "disarmed", why: "o board está desarmado (o autorun dele está desligado)" };
  if (unreadable) {
    return { level: "paused", held: true, background: false, source: "unreadable", why: "o registro de ritmo dos boards não pôde ser lido — retome o board para regravá-lo" };
  }
  const hold = holdInForce(row, now);
  if (!hold) return { level: "normal", held: false, background: true, source: row ? "pace" : "default", why: "ritmo normal" };
  if (hold.level === "slow") return { level: "slow", held: false, background: false, source: "pace", why: `board em ritmo devagar ${WHO[hold.by.kind]}` };
  return { level: "paused", held: true, background: false, source: "pace", why: `board pausado ${WHO[hold.by.kind]}` };
}

/** O portão de quem só tem a configuração (os núcleos sem a porta de ritmo ligada, e os testes deles). PURA. */
export function configOnlyGate(config: Pick<BoardConfig, "autorunDisabled"> | null | undefined): BoardGate {
  return resolveBoardGate(config, null, 0);
}

/** A porta que os núcleos recebem: a produção liga `boardGateNow` (board-pace-store.ts); sem ela, só a configuração responde. */
export type BoardGatePort = (board: string, config: Pick<BoardConfig, "autorunDisabled"> | null | undefined) => BoardGate;

/** O portão pelo que o núcleo tem: a porta injetada, ou só a configuração. PURA (a porta é quem faz IO). */
export function gateOf(port: BoardGatePort | undefined, board: string, config: Pick<BoardConfig, "autorunDisabled"> | null | undefined): BoardGate {
  return port ? port(board, config) : configOnlyGate(config);
}

/** O teto de trabalho em paralelo do board sob o ritmo: `normal` mantém, `slow` vira um por vez, `paused` zera. PURA. */
export function paceCap(max: number, gate: Pick<BoardGate, "level" | "held">): number {
  if (gate.held) return 0;
  return gate.level === "slow" ? Math.min(max, SLOW_MAX_PARALLEL) : max;
}

// ── a mudança ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Por que ESTE ator não pode pedir ESTE ritmo — ou null. A mesma frase na tool, na ação e no botão. PURA.
 * Desacelerar (ou manter) é de todos. O dono manda nas duas camadas; um agente nunca passa do que o dono fixou.
 */
export function paceChangeRefusal(gate: BoardGate, row: BoardPaceRow | null | undefined, next: PaceLevel, actor: PaceActor, now: number): string | null {
  // Com o registro ilegível, QUALQUER gravação o regrava do zero — e os outros boards voltariam a `normal`. Só o dono.
  if (gate.source === "unreadable" && actor.kind !== "owner") return "O registro de ritmo não pôde ser lido: só o dono o regrava (retomando ou pausando o board).";
  if (paceRank(next) <= paceRank(gate.level)) return null;
  if (gate.source === "disarmed") return "Este board está desarmado: armar é um gesto à parte (set_board_autorun), não uma mudança de ritmo.";
  if (actor.kind === "owner") return null;
  const owner = liveHold(row?.owner, now);
  if (owner && paceRank(next) > paceRank(owner.level)) {
    return `O dono segurou este board em «${paceLabel(owner.level)}»: só ele retoma ou acelera além disso. Um agente só desfaz o freio que um agente pôs.`;
  }
  return null;
}

export interface PaceChangeInput {
  board: string;
  level: PaceLevel;
  by: PaceActor;
  reason?: string;
  /** em quantos minutos o ritmo volta sozinho (só para `paused`/`slow`). */
  forMinutes?: number;
  mode?: PauseMode;
}

/** O pedido é válido? Devolve a frase do defeito, ou null. PURA. */
export function paceInputRefusal(input: PaceChangeInput): string | null {
  if (!isPaceLevel(input.level)) return "Ritmo desconhecido: use paused, slow ou normal.";
  if (input.reason != null && input.reason.length > PACE_REASON_MAX) return `O motivo passa de ${PACE_REASON_MAX} caracteres.`;
  if (input.forMinutes != null) {
    if (input.level === "normal") return "O prazo vale para pausar ou andar devagar, não para o ritmo normal.";
    if (!Number.isFinite(input.forMinutes) || input.forMinutes <= 0) return "O prazo tem de ser um número de minutos maior que zero.";
    if (input.forMinutes * 60_000 > PACE_UNTIL_MAX_MS) return "O prazo máximo é de 30 dias; acima disso, pause sem prazo.";
  }
  if (input.mode != null && !isPauseMode(input.mode)) return "Modo de pausa desconhecido: use drain ou stop.";
  if (input.mode != null && input.level !== "paused") return "O modo (drain/stop) só vale para a pausa.";
  return null;
}

export interface PaceChangeResult {
  /** a linha nova (um board que voltou a `normal` mantém a linha: é ela que guarda o histórico). */
  row: BoardPaceRow;
  /** algo foi gravado de novo (pedir o que já está em vigor, sem prazo novo, não grava). */
  changed: boolean;
  /** o ritmo em vigor DEPOIS da mudança (o mais lento das duas camadas — pode não ser o pedido). */
  level: PaceLevel;
  /** o modo da pausa em vigor depois (null fora da pausa). */
  mode: PauseMode | null;
  /** o board ENTROU em pausa agora: quem chama tira o que está na fila. */
  enteredPause: boolean;
  /** a pausa passou a ser «parar agora»: quem chama para o que está rodando. */
  stopNow: boolean;
  /** saiu de pausado: estas entradas voltam ao pipeline. */
  released: PaceHeldEntry[];
}

const sameHold = (a: PaceHold | undefined, b: PaceHold | undefined): boolean =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.level === b.level &&
    a.by.kind === b.by.kind &&
    (a.until ?? null) === (b.until ?? null) &&
    (a.mode ?? null) === (b.mode ?? null) &&
    (a.resumeTo ?? null) === (b.resumeTo ?? null) &&
    (a.reason ?? null) === (b.reason ?? null));

/**
 * Aplica a mudança à linha do board. Não julga QUEM pode (isso é {@link paceChangeRefusal}, antes). O DONO substitui o
 * freio dele e apaga o dos agentes; um AGENTE só escreve o freio dos agentes. Uma pausa com prazo posta sobre um board
 * devagar volta a `slow` quando vence. O que a pausa segurou atravessa enquanto o board seguir pausado e é devolvido
 * quando ele sai dela. PURA.
 */
export function applyPaceChange(row: BoardPaceRow | null | undefined, input: PaceChangeInput, now: number): PaceChangeResult {
  const before = effectivePaceLevel(row, now);
  const beforeMode = effectivePauseMode(row, now);
  const at = new Date(now).toISOString();
  const reason = input.reason?.trim() || undefined;
  const until = input.forMinutes != null && input.level !== "normal" ? new Date(now + input.forMinutes * 60_000).toISOString() : undefined;
  const mine = input.by.kind === "owner" ? row?.owner : row?.agent;
  const hold: PaceHold | undefined =
    input.level === "normal"
      ? undefined
      : {
          level: input.level,
          by: input.by,
          at,
          // sem motivo novo, o motivo do MESMO freio no mesmo ritmo continua valendo (repetir o pedido não o apaga)
          ...((reason ?? (mine?.level === input.level ? mine.reason : undefined)) ? { reason: reason ?? mine?.reason } : {}),
          ...(until ? { until } : {}),
          ...(until && input.level === "paused" && before === "slow" ? { resumeTo: "slow" as const } : {}),
          ...(input.level === "paused" ? { mode: input.mode ?? "drain" } : {}),
        };
  const owner = input.by.kind === "owner" ? hold : row?.owner;
  const agent = input.by.kind === "owner" ? undefined : hold;
  const changed = !sameHold(owner, row?.owner) || !sameHold(agent, row?.agent);
  if (!changed) {
    return { row: row ?? { board: input.board }, changed: false, level: before, mode: beforeMode, enteredPause: false, stopNow: false, released: [] };
  }
  const base: BoardPaceRow = { board: input.board, ...(owner ? { owner } : {}), ...(agent ? { agent } : {}) };
  const level = effectivePaceLevel(base, now);
  const mode = effectivePauseMode(base, now);
  const change: PaceChange = { level: input.level, by: input.by, at, ...(reason ? { reason } : {}), ...(until ? { until } : {}), ...(hold?.mode ? { mode: hold.mode } : {}) };
  // O que a linha GRAVADA guarda vale mesmo com um prazo vencido e ainda não varrido: quem segue pausando mantém, quem
  // sai da pausa devolve — nunca se perde uma entrada retida entre o vencimento e a varredura.
  const held = row?.held ?? [];
  return {
    row: { ...base, ...(level === "paused" && held.length ? { held } : {}), history: [...(row?.history ?? []), change].slice(-PACE_HISTORY_MAX) },
    changed: true,
    level,
    mode,
    enteredPause: level === "paused" && before !== "paused",
    stopNow: level === "paused" && mode === "stop" && !(before === "paused" && beforeMode === "stop"),
    released: level !== "paused" ? held : [],
  };
}

/**
 * Os prazos vencidos da linha: cada freio vencido sai (ou afrouxa para `slow`), e o que a pausa segurava é devolvido se
 * o board saiu dela. Sem prazo vencido devolve null. PURA.
 */
export function expirePace(row: BoardPaceRow, now: number): { row: BoardPaceRow; level: PaceLevel; faster: boolean; released: PaceHeldEntry[] } | null {
  if (!paceExpired(row, now)) return null;
  // «antes» = o que a linha dizia com os prazos ainda valendo
  const stored = [row.owner, row.agent].filter((h): h is PaceHold => !!h);
  const before = stored.reduce<PaceLevel>((acc, h) => (paceRank(h.level) < paceRank(acc) ? h.level : acc), "normal");
  const owner = liveHold(row.owner, now) ?? undefined;
  const agent = liveHold(row.agent, now) ?? undefined;
  const base: BoardPaceRow = { board: row.board, ...(owner ? { owner } : {}), ...(agent ? { agent } : {}) };
  const level = effectivePaceLevel(base, now);
  const by = (holdExpired(row.owner, now) ? row.owner : row.agent)?.by ?? { kind: "owner" as const };
  const change: PaceChange = { level, by, at: new Date(now).toISOString(), expired: true };
  const held = row.held ?? [];
  return {
    row: { ...base, ...(level === "paused" && held.length ? { held } : {}), history: [...(row.history ?? []), change].slice(-PACE_HISTORY_MAX) },
    level,
    faster: paceRank(level) > paceRank(before),
    released: level !== "paused" ? held : [],
  };
}

/**
 * Anota o que a pausa segurou num card (uma entrada por card: a mais forte vence — `stopped` sobre `entry`). Só uma
 * linha PAUSADA agora guarda; fora dela devolve a mesma linha. PURA.
 */
export function holdPaceEntry(row: BoardPaceRow, entry: PaceHeldEntry, now: number): BoardPaceRow {
  if (effectivePaceLevel(row, now) !== "paused") return row;
  const held = row.held ?? [];
  const at = held.findIndex((h) => h.cardId === entry.cardId);
  if (at >= 0) {
    if (held[at].why === "stopped" || entry.why === "entry") return row;
    return { ...row, held: held.map((h, n) => (n === at ? entry : h)) };
  }
  if (held.length >= PACE_HELD_MAX) return row;
  return { ...row, held: [...held, entry] };
}

// ── as palavras ──────────────────────────────────────────────────────────────────────────────────────

const LABEL: Record<PaceLevel, string> = { paused: "Pausado", slow: "Devagar", normal: "Normal" };
export function paceLabel(level: PaceLevel): string {
  return LABEL[level];
}

/** O que cada posição faz, numa frase — o texto de ajuda do controle e da tool. */
export const PACE_HELP: Record<PaceLevel, string> = {
  paused: "Nada automático começa neste board.",
  slow: "Um card por vez, sem os agentes de fundo.",
  normal: "O ritmo que o board declara.",
};

/** A sugestão de ritmo a partir da cota: fora do ritmo da semana, andar devagar. PURA. */
export function paceSuggestion(gate: Pick<BoardGate, "level">, quota: { onPace: boolean; detail: string } | null): { level: PaceLevel; why: string } | null {
  if (!quota || quota.onPace || gate.level !== "normal") return null;
  return { level: "slow", why: quota.detail };
}

/** O ritmo de um board como a tela e a tool o mostram — uma projeção só, para as duas portas não divergirem. */
export interface BoardPaceView {
  board: string;
  level: PaceLevel;
  label: string;
  /** nada automático começa agora. */
  held: boolean;
  source: BoardGateSource;
  why: string;
  /** quem pôs o ritmo em vigor e quando (null em `normal`, no desarmado e no ilegível). */
  by: PaceActor | null;
  since: string | null;
  reason: string | null;
  /** quando o ritmo em vigor afrouxa sozinho. */
  until: string | null;
  mode: PauseMode | null;
  /** o que o DONO fixou (um agente não passa disso); null = o dono não segura este board. */
  ownerLimit: Exclude<PaceLevel, "normal"> | null;
  /** quantos cards a pausa está segurando para devolver na retomada. */
  waiting: number;
  /** as últimas mudanças, a mais recente primeiro. */
  history: PaceChange[];
  suggestion: { level: PaceLevel; why: string } | null;
}

/** A projeção. `quota` null = sem leitura confiável da cota (nenhuma sugestão sai de um palpite). PURA. */
export function paceViewOf(
  board: string,
  config: Pick<BoardConfig, "autorunDisabled"> | null | undefined,
  snap: { rows: readonly BoardPaceRow[]; unreadable: boolean },
  now: number,
  quota: { onPace: boolean; detail: string } | null,
): BoardPaceView {
  const row = snap.rows.find((r) => r.board === board) ?? null;
  const gate = resolveBoardGate(config, row, now, snap.unreadable);
  const hold = gate.source === "pace" ? holdInForce(row, now) : null;
  return {
    board,
    level: gate.level,
    label: paceLabel(gate.level),
    held: gate.held,
    source: gate.source,
    why: gate.why,
    by: hold?.by ?? null,
    since: hold?.at ?? null,
    reason: hold?.reason ?? null,
    until: hold && !holdExpired(hold, now) ? (hold.until ?? null) : null,
    mode: gate.source === "pace" ? effectivePauseMode(row, now) : null,
    ownerLimit: gate.source === "pace" ? (liveHold(row?.owner, now)?.level ?? null) : null,
    waiting: gate.source === "pace" && gate.level === "paused" ? (row?.held?.length ?? 0) : 0,
    history: [...(row?.history ?? [])].reverse(),
    suggestion: paceSuggestion(gate, quota),
  };
}

// ── o arquivo ────────────────────────────────────────────────────────────────────────────────────────

export const PACE_FILE_VERSION = 1;

function actorOf(v: unknown): PaceActor | null {
  const o = v as { kind?: unknown; id?: unknown } | null;
  if (!o || (o.kind !== "owner" && o.kind !== "agent")) return null;
  return { kind: o.kind, ...(typeof o.id === "string" && o.id ? { id: o.id } : {}) };
}

/** Um freio do arquivo. `undefined` = ausente; `null` = presente e ILEGÍVEL (a linha inteira não pode ser julgada). */
function holdOf(v: unknown, kind: PaceActor["kind"]): PaceHold | undefined | null {
  if (v == null) return undefined;
  const o = v as Record<string, unknown>;
  const by = actorOf(o.by);
  if (!by || by.kind !== kind || (o.level !== "paused" && o.level !== "slow") || !validIso(o.at)) return null;
  if (o.until != null && !validIso(o.until)) return null;
  return {
    level: o.level,
    by,
    at: o.at,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
    ...(validIso(o.until) ? { until: o.until } : {}),
    ...(o.resumeTo === "slow" ? { resumeTo: "slow" as const } : {}),
    ...(isPauseMode(o.mode) ? { mode: o.mode } : {}),
  };
}

function changeOf(v: unknown): PaceChange | null {
  const o = v as Record<string, unknown> | null;
  const by = actorOf(o?.by);
  if (!o || !by || !isPaceLevel(o.level) || !validIso(o.at)) return null;
  return {
    level: o.level,
    by,
    at: o.at,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
    ...(validIso(o.until) ? { until: o.until } : {}),
    ...(isPauseMode(o.mode) ? { mode: o.mode } : {}),
    ...(o.expired === true ? { expired: true as const } : {}),
  };
}

function rowOf(v: unknown): BoardPaceRow | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.board !== "string" || !o.board) return null;
  const owner = holdOf(o.owner, "owner");
  const agent = holdOf(o.agent, "agent");
  if (owner === null || agent === null) return null;
  const held = Array.isArray(o.held)
    ? o.held.flatMap((h): PaceHeldEntry[] => {
        const e = h as Record<string, unknown> | null;
        return e && typeof e.cardId === "string" && e.cardId && (e.why === "stopped" || e.why === "entry") && validIso(e.at) ? [{ cardId: e.cardId, why: e.why, at: e.at }] : [];
      })
    : [];
  const history = Array.isArray(o.history) ? o.history.flatMap((c) => changeOf(c) ?? []) : [];
  return { board: o.board, ...(owner ? { owner } : {}), ...(agent ? { agent } : {}), ...(held.length ? { held } : {}), ...(history.length ? { history } : {}) };
}

/**
 * O arquivo de ritmo, lido com RIGOR: null quando ele não pode ser julgado — JSON quebrado, versão desconhecida, `rows`
 * que não é lista, ou uma linha cujo board ou cujo freio não se lê. Quem chama trata null como «todo board segurado»
 * ({@link resolveBoardGate} com `unreadable`). PURA.
 */
export function parsePaceFile(raw: string): BoardPaceRow[] | null {
  try {
    const data = JSON.parse(raw) as { version?: unknown; rows?: unknown };
    if (data?.version !== PACE_FILE_VERSION || !Array.isArray(data.rows)) return null;
    const out: BoardPaceRow[] = [];
    for (const r of data.rows) {
      const row = rowOf(r);
      if (!row) return null;
      out.push(row);
    }
    return out;
  } catch {
    return null;
  }
}

export function serializePaceFile(rows: readonly BoardPaceRow[]): string {
  return JSON.stringify({ version: PACE_FILE_VERSION, rows }, null, 2);
}
