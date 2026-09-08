// Smart capture — free-text → LLM proposal → human review → batch create.
//
// The agent NEVER writes: it returns a PROPOSAL (these types). The human edits it
// in the modal, then commitProposalAction turns the approved items into cards in the
// board's staging intake (Triagem) — they rest there (no autorun) until routed into
// the build flow. Isomorphic — shared by the server actions and the client modal.

import type { CardType } from "../types";
import type { StoryType } from "../frameworks";

/**
 * One card the agent proposes to create. `parent` may reference an EXISTING card id
 * OR the `tempId` of another proposed item (so the agent can propose a new
 * activity/step and hang stories under it in the same batch) OR be null (unplaced
 * → kanban backlog). RICE/enrichment is a later stage; narrative/acceptance/body
 * are optional seeds — only propagated when the source text already contains them.
 */
/**
 * O desfecho de um item em modo ESTENDER: o card existente que o lote acrescentou tasks, e quantas.
 * `addedTasks: 0` é um resultado LEGÍTIMO (todas as tasks propostas já existiam no card) — a UI diz
 * isso em vez de fingir que acrescentou.
 */
export interface ExtendedCardOutcome {
  tempId: string;
  cardId: string;
  /** título do card estendido, para a UI não mostrar id cru. */
  title: string;
  addedTasks: number;
}

/** Normaliza o título de uma task para a dedupe do modo ESTENDER (caixa e acento não distinguem). */
export function normalizeTaskTitle(title: string): string {
  return title.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export interface ProposedItem {
  /** agent-assigned id, unique within this batch (e.g. "i1"); used for parent refs */
  tempId: string;
  type: CardType;
  title: string;
  /**
   * ESTENDER em vez de CRIAR: o id de um card EXISTENTE ao qual este item apenas ACRESCENTA as suas
   * `tasks`. Presença do campo É o modo — não existe um `op` paralelo que possa discordar dele (um
   * estado, não dois). Quando presente, `parent`/`serves`/`release`/narrativa são ignorados: nada é
   * criado, nada é ancorado.
   *
   * Por que existe: sem isto a captura só sabia CRIAR. Um pedido do tipo "reagrupar a agenda por dia"
   * sobre uma tela que já tem story só podia virar uma story nova marcada "possível duplicata" — a
   * arquitetura errada, com o aviso certo. Agora o agente pode dizer "isto é mais trabalho DENTRO da
   * story X", que é o que de fato é.
   *
   * Só aponta para card do BOARD (nunca um tempId do lote): estender algo que ainda não existe é
   * criar. Alvo que não resolve = lote recusado, nunca degradado para "cria um card novo".
   */
  targetCardId?: string | null;
  /** stories only; null/omitted for activity/step */
  storyType?: StoryType | null;
  /** existing card id, another item's tempId, or null */
  parent?: string | null;
  /**
   * Dual-track: for a DELIVERY item (storyType technical/bug/chore/spike), the map node it serves
   * (a step/activity/user-story id, or another item's tempId). Override on parent; omit to use parent.
   */
  serves?: string | null;
  /** release id (stories only); null = unscheduled */
  release?: string | null;
  /** existing persona ids the story serves */
  personas?: string[];
  /** existing system ids involved */
  systems?: string[];
  /** one-line reason: what this card covers / why it exists (shown in the review) */
  rationale: string;
  /**
   * Confiança do agente na CLASSIFICAÇÃO (type/storyType) deste item — 0..1. < 0.6 → a UI marca ⚠ e
   * oferece desambiguar; null/omitido = assuma alta. NÃO é confiança no conteúdo, só no TIPO.
   */
  confidence?: number | null;
  /** o agente está na fronteira (ex.: defeito↔dor) e RECOMENDA o humano desambiguar antes de criar. */
  ambiguous?: boolean;
  /** existing card id this looks like a duplicate of (warn the human) */
  duplicateOf?: string | null;
  /** seed da narrativa Agile — só quando o texto-fonte já a trouxe; enrich preenche se ausente */
  narrative?: { role?: string | null; want?: string | null; soThat?: string | null } | null;
  /** seeds de critérios de aceite (Gherkin recomendado) — só quando já decididos no texto */
  acceptance?: string[];
  /**
   * WS7 (F6) — decomposição PRÉ-SEMEADA: 1 card guarda-chuva com N tasks em vez de N cards. Quando a
   * captura reconhece refatorações/ajustes na MESMA superfície/arquivo, propõe UM card com estas tasks
   * (mapeadas para `Card.tasks` com done:false no commit) — harness-plan/harness-do já as consomem. Consolida o
   * intake (N-1 pipelines inteiros a menos — o ganho dominante do lote). Story-only.
   */
  tasks?: { id?: string; title: string }[];
  /** contexto/decisões/constraints/valor além do rationale de 1 linha */
  body?: string;
  /**
   * Dual-track OST: the idea (a user PAIN) this STORY addresses — an existing card id OR the
   * `tempId` of an idea in the SAME batch. Becomes the `addresses` edge (story→idea) on
   * commit; per-item override of commitProposalAction's batch-level addressesIdeaId. Story-only.
   */
  addresses?: string | null;
  /** OST-light — idea items ONLY: extra IdeaFields beyond statement(=title)/evidence(=body). */
  candidateSolutions?: string[];
  keyAssumption?: string | null;
  successSignal?: string | null;
  valueSize?: { reach: number | null; impact: number | null } | null;
}

/**
 * A context image the user attached to a capture (a screenshot/sketch/evidence). Carried from the
 * modal to proposeCardsAction as a data URL; the server writes it to a temp file and tells the agent
 * to Read it. Downscaled client-side first, so the payload stays small.
 */
export interface CaptureImageInput {
  /** display name (best effort — file name or a synthesized "colado-N.png"). */
  name: string;
  /** "data:image/<type>;base64,<...>" — the (downscaled) image bytes. */
  dataUrl: string;
}

/** The agent's full answer for one analyze/refine turn. */
export interface Proposal {
  items: ProposedItem[];
  /** short PT-BR summary of how the free text was interpreted */
  summary: string;
}

/** One round of the review loop, replayed into the prompt so refine has memory. */
export interface CaptureTurn {
  /** the user's free text (first turn) or refine feedback (later turns) */
  text: string;
  /** the proposal the agent returned for that text (omitted on the pending turn) */
  proposal?: Proposal;
}

/**
 * The persisted proposal sidecar (proposals/<containerId>.json) — the OUTPUT of harness-capture for a
 * capture container card. The source free text rides in the container card's `body`; the refine
 * feedback history accumulates HERE (oldest-first) so a re-run revises with memory. Mirrors WireframeDoc.
 */
export interface ProposalDoc {
  containerId: string;
  /** short PT-BR summary of how the agent interpreted the source text. */
  summary: string;
  items: ProposedItem[];
  /** refine rounds: the human's free-text feedback, oldest-first (the agent reads these to revise). */
  feedback: string[];
  /** which skill produced it (harness-capture). */
  generatedBy: string;
  /** YYYY-MM-DD of the last generation. */
  updated: string | null;
}
