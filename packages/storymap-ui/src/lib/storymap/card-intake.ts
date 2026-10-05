// A VERIFICAÇÃO DE ENTRADA DE CARD (decisão do dono): quando um AGENTE cria um card — MCP, condutor, sessão, auditoria
// automática —, uma verificação rápida, barata e com justificativa aceita, recusa ou fica em dúvida, ANTES de o card
// existir. Esta é a CAMADA 1: regras puras, sem IA, custo zero.
//
//   (a) BOARD CERTO — pelos arquivos que o card cita (o campo `files`, ou caminhos achados no corpo e nos critérios) e
//       pela régua de board de arquivos (card-routing.ts: `package` › `ownsPaths` › `sharedPackages`). Arquivos de outro
//       board ⇒ RECUSA dizendo o board certo; nada é movido sozinho — o agente cria de novo lá.
//   (b) PADRÃO DE CRIAÇÃO — título em linguagem simples (sem id cru de card, sem caminho de arquivo, sem código em crase,
//       com tamanho razoável); bug com o que acontece e o que era esperado; user story fora da Triagem com ao menos um
//       critério de aceite. (A âncora no mapa já é cobrada pelo chokepoint de escrita — placementViolation — e não é
//       repetida aqui.)
//   (c) DUPLICATA — um card ABERTO do mesmo board com título quase igual ⇒ recusa apontando o existente.
//
// Sem arquivos, o board pedido vale — a não ser que o texto cite OUTRO board pelo nome ou pelo pacote: aí o veredito é
// `uncertain`, e só então a camada 2 (um modelo pequeno, runner/card-intake-deps.ts) é consultada. PURA.

import { boardForFiles, type BoardFootprint } from "./card-routing";
import { terminalStatusIds } from "./views";
import type { StoryType } from "./frameworks";
import type { BoardConfig, Card } from "./types";

/** O que se sabe do card que um agente quer criar. */
export interface IntakeCandidate {
  title: string;
  type: Card["type"];
  storyType?: StoryType | null;
  body?: string | null;
  acceptance?: readonly string[] | null;
  /** os arquivos/caminhos que o card toca, quando o agente os informa (campo `files` do create_card) */
  files?: readonly string[] | null;
  /** o card nasce na Triagem (staging): ali ele ainda não precisa de critérios — a triagem cobra depois */
  landsInQuarantine: boolean;
  /** um bug pode trazer o relato estruturado */
  bugReport?: { expected?: string | null; actual?: string | null; brief?: string | null } | null;
}

export interface IntakeContext {
  /** o board pedido */
  board: BoardFootprint;
  /** todos os boards do alvo (inclui o pedido) */
  boards: readonly BoardFootprint[];
  /** a configuração do board pedido (para saber o que é card aberto) */
  config: Pick<BoardConfig, "statuses" | "columns">;
  /** os cards do board pedido */
  cards: readonly Card[];
  /** 0..1 — a partir de quanto dois títulos contam como o mesmo card (Jaccard das palavras) */
  similarity: number;
}

export type IntakeReason = "board" | "pattern" | "duplicate";

export type IntakeVerdict =
  | { verdict: "accept"; notes: string[] }
  | { verdict: "refuse"; reason: IntakeReason; why: string; suggestBoard?: string; duplicateOf?: string; fix?: string[] }
  | { verdict: "uncertain"; why: string; candidates: string[] };

/** Limites do título: menos que isto não diz nada; mais que isto é parágrafo, não título. */
export const TITLE_MIN = 8;
export const TITLE_MAX = 140;
/** O limiar padrão de duplicata (Jaccard das palavras do título). */
export const DEFAULT_INTAKE_SIMILARITY = 0.75;

const RAW_CARD_ID = /\b(?:story|step|act|idea)-[a-z0-9]{6}\b/i;
const FILE_PATH = /(?:^|[\s(«"'`])((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8})(?=$|[\s)»"'`,.;:])/i;
const BACKTICK_CODE = /`[^`]+`/;

/** Normaliza uma palavra: minúscula, sem acento. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const STOP = new Set(
  "a o e de da do das dos em no na nos nas um uma uns umas para por com sem que se ao aos as os the and of to in on for is are with nao mais menos".split(" "),
);

/** As palavras que contam de um texto (≥ 3 letras, sem as vazias). */
export function significantWords(text: string): Set<string> {
  return new Set(
    fold(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  );
}

/** Jaccard de dois conjuntos de palavras. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Os caminhos de arquivo citados num texto (só os que algum board declara — uma URL ou uma frase não viram arquivo). */
export function pathsIn(text: string, boards: readonly BoardFootprint[]): string[] {
  const prefixes = boards.flatMap((b) => [b.package, ...(b.ownsPaths ?? []), ...(b.sharedPackages ?? [])]).filter((p): p is string => !!p);
  const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const declared = prefixes.map(norm).filter(Boolean);
  const out = new Set<string>();
  for (const raw of text.split(/[\s()«»"'`,;]+/)) {
    const tok = norm(raw.replace(/[.:]+$/, ""));
    if (!tok.includes("/") || tok.includes("://")) continue;
    if (declared.some((d) => tok === d || tok.startsWith(`${d}/`))) out.add(tok);
  }
  return [...out];
}

/** O que está errado no título, em português simples (vazio = nada). */
export function titleProblems(title: string): string[] {
  const t = title.trim();
  const out: string[] = [];
  if (t.length < TITLE_MIN) out.push(`o título é curto demais (mínimo ${TITLE_MIN} caracteres): diga o que muda para quem usa`);
  if (t.length > TITLE_MAX) out.push(`o título é longo demais (máximo ${TITLE_MAX} caracteres): o detalhe vai no corpo`);
  if (RAW_CARD_ID.test(t)) out.push("o título cita o id de um card: diga o assunto em palavras (o vínculo vai em `serves`/`parent`)");
  if (FILE_PATH.test(` ${t} `)) out.push("o título cita um caminho de arquivo: diga o efeito, e passe os arquivos em `files`");
  if (BACKTICK_CODE.test(t)) out.push("o título tem código em crase: escreva em linguagem simples (o código vai no corpo)");
  if (t.length >= TITLE_MIN && t === t.toUpperCase() && /[A-Z]/.test(t)) out.push("o título está todo em maiúsculas");
  return out;
}

/** Os cards ABERTOS do board: nem no fim do fluxo, nem no arquivo, nem na lixeira. */
function openStories(ctx: IntakeContext): Card[] {
  const terminal = terminalStatusIds(ctx.config as BoardConfig);
  const systemCols = new Set((ctx.config.columns ?? []).filter((c) => c.system).map((c) => c.id));
  const archived = new Set(ctx.config.statuses.filter((s) => s.column != null && systemCols.has(s.column)).map((s) => s.id));
  // (a lixeira mora fora de cards/ — readCards não a devolve)
  return ctx.cards.filter((c) => c.type === "story" && !(c.status && (terminal.has(c.status) || archived.has(c.status))));
}

/** Os boards OUTROS que o texto cita pelo nome, pelo id ou pela pasta do pacote. */
export function otherBoardsMentioned(text: string, ctx: IntakeContext): string[] {
  const words = significantWords(text);
  const folded = fold(text);
  const hit: string[] = [];
  for (const b of ctx.boards) {
    if (b.id === ctx.board.id) continue;
    const names = [b.name, b.id, b.package ? b.package.replace(/\/+$/, "").split("/").pop() : null].filter((n): n is string => !!n && n.length >= 3);
    if (names.some((n) => (n.includes(" ") ? folded.includes(fold(n)) : words.has(fold(n))))) hit.push(b.id);
  }
  return hit;
}

/**
 * O veredito da camada 1. Ordem: padrão (o que o agente precisa consertar no pedido), board (arquivos de outro board),
 * duplicata, e por fim a dúvida (sem arquivos, texto citando outro board). PURA.
 */
export function intakeRules(c: IntakeCandidate, ctx: IntakeContext): IntakeVerdict {
  const notes: string[] = [];
  const isStory = c.type === "story";
  const st = c.storyType ?? "user";
  const text = [c.title, c.body ?? "", ...(c.acceptance ?? [])].join("\n");

  // (b) o padrão — só para STORY (atividade/passo são nós do mapa, com o título curto por natureza)
  if (isStory) {
    const fix = titleProblems(c.title);
    if (st === "bug") {
      const body = (c.body ?? "").trim();
      const br = c.bugReport;
      const told = !!(br && ((br.actual && br.expected) || (br.brief && br.brief.trim().length >= 40)));
      if (!told && body.length < 40) fix.push("um bug precisa dizer o que acontece e o que era esperado (no corpo, ou no relato do bug)");
    }
    if (st === "user" && !c.landsInQuarantine && !(c.acceptance ?? []).some((a) => a.trim())) {
      fix.push("uma user story fora da Triagem precisa de ao menos um critério de aceite");
    }
    if (fix.length) return { verdict: "refuse", reason: "pattern", why: `o card não segue o padrão de criação: ${fix.join("; ")}`, fix };
  }

  // (a) o board, pelos arquivos
  const files = [...new Set([...(c.files ?? []), ...pathsIn(text, ctx.boards)])];
  let ambiguousFiles = false;
  if (files.length) {
    const r = boardForFiles(files, ctx.boards, ctx.board.id);
    if (r.routed && r.board !== ctx.board.id) {
      const name = ctx.boards.find((b) => b.id === r.board)?.name ?? r.board;
      return { verdict: "refuse", reason: "board", why: `${r.reason}: crie este card no board «${name}» (${r.board})`, suggestBoard: r.board };
    }
    if (!r.routed && /se dividem/.test(r.reason)) ambiguousFiles = true;
    else notes.push(r.reason);
  }

  // (c) a duplicata — só contra STORY aberta do mesmo board
  if (isStory) {
    const mine = significantWords(c.title);
    let best: { card: Card; score: number } | null = null;
    for (const o of openStories(ctx)) {
      const s = jaccard(mine, significantWords(o.title));
      if (s >= ctx.similarity && (!best || s > best.score)) best = { card: o, score: s };
    }
    if (best) {
      return {
        verdict: "refuse",
        reason: "duplicate",
        why: `já existe um card aberto quase igual: ${best.card.id} — «${best.card.title}». Continue nele (ou diga no corpo o que é diferente)`,
        duplicateOf: best.card.id,
      };
    }
  }

  // a dúvida: arquivos divididos entre boards, ou nenhum arquivo e o texto citando outro board
  const mentioned = otherBoardsMentioned(text, ctx);
  if (ambiguousFiles) return { verdict: "uncertain", why: "os arquivos citados se dividem entre boards", candidates: [ctx.board.id, ...mentioned] };
  if (!files.length && mentioned.length) {
    return { verdict: "uncertain", why: `o card não cita arquivos e fala de outro board (${mentioned.join(", ")})`, candidates: [ctx.board.id, ...mentioned] };
  }
  return { verdict: "accept", notes };
}
