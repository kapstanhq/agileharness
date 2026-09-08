// Presentational vocabulary for the "Início Agêntico" home — a thin, PURE layer over the CockpitItem
// taxonomy (lib/storymap/demands.ts) plus the feed's tri-state. Kept out of CockpitView.tsx (a heavy
// client file) so the inbox, the feed and the per-item page share ONE vocabulary and can be
// unit-tested without React.

import type { CockpitGroup, CockpitItem, CockpitItemKind } from "@/lib/storymap/demands";

/**
 * A short human LABEL per cockpit kind — the eyebrow of an attention row/detail. EXHAUSTIVE over
 * CockpitItemKind (TS enforces it via the Record): a new kind won't compile until it has a label,
 * the same discipline the KIND_RENDERER registry uses.
 */
export const COCKPIT_KIND_LABEL: Record<CockpitItemKind, string> = {
  question: "Pergunta",
  blocker: "Bloqueio",
  finding: "Achado",
  "deploy-failed": "Deploy falhou",
  gate: "Aprovar & avançar",
  approval: "Aprovação do Jido",
  review: "Revisão",
  stuck: "Run travado",
  conflict: "Conflito de merge",
  proposal: "Proposta de captura",
  design: "Design para revisar",
  governance: "Mudança de board",
  "deploy-unsettled": "Deploy não confirmado",
  "release-aging": "Release parada em stage",
  "merge-failed": "Merge falhou",
};

/**
 * O PEDIDO — o que se espera de VOCÊ neste item, em uma frase imperativa curta. EXAUSTIVO sobre
 * CockpitItemKind (o Record obriga).
 *
 * Por que existe (o cabeçalho do Inbox mostrava TRÊS taxonomias enfileiradas — "Aprovar ·
 * Proposta de captura · Capturando"): a LANE ("Aprovar"), o KIND ("Proposta de captura") e o STATUS
 * do pipeline ("Capturando") são três recortes da mesma coisa, e lidos em sequência parecem três
 * categorias concorrentes em vez de uma informação. O pedido FUNDE lane + kind numa frase que diz o
 * que fazer; a lane sobrevive como COR (o ponto), não como palavra; e o status vira exceção
 * (ver {@link cockpitItemShowsStatus}).
 *
 * Onde há LARGURA (o cartão aberto, a página do item) mostramos o PEDIDO; onde não há (a folha da
 * home, o popover da barra) fica o SUBSTANTIVO de {@link COCKPIT_KIND_LABEL} — que é o mesmo
 * vocabulário, encurtado, nunca um sinônimo novo.
 */
export const COCKPIT_DEMAND_LABEL: Record<CockpitItemKind, string> = {
  question: "Responder pergunta",
  blocker: "Resolver bloqueio",
  finding: "Triar achado",
  "deploy-failed": "Resolver deploy que falhou",
  gate: "Aprovar e avançar",
  approval: "Autorizar o Jido",
  review: "Revisar triagem",
  stuck: "Destravar run",
  conflict: "Resolver conflito de merge",
  proposal: "Revisar proposta de captura",
  design: "Aprovar design",
  governance: "Aprovar mudança de board",
  "deploy-unsettled": "Confirmar deploy",
  "release-aging": "Publicar release parada",
  "merge-failed": "Resolver merge que falhou",
};

/**
 * O status do PIPELINE (a coluna do card) diz algo sobre este item, ou é ruído?
 *
 * É ruído em dois casos, e o teste é sempre o mesmo — o chip acrescenta alguma coisa ao pedido?
 *   1. a coluna é CONSTANTE por construção: uma proposta vive num contêiner efêmero eternamente em
 *      "Capturando"; uma triagem de baixa confiança está sempre em "Triagem". Um valor que nunca
 *      varia não informa — só repete, ao lado do pedido, uma palavra que ele já contém.
 *   2. não existe card: governança e a autorização do Jido são itens de BOARD.
 * A regra era um `if (kind === "proposal")` escrito à mão dentro do CockpitItemRow, invisível para as
 * outras superfícies; aqui ela é UMA e vale para todas.
 */
const STATUS_IS_NOISE = new Set<CockpitItemKind>(["proposal", "review", "governance", "approval"]);

export function cockpitItemShowsStatus(item: Pick<CockpitItem, "kind" | "cardId">): boolean {
  if (STATUS_IS_NOISE.has(item.kind)) return false;
  return Boolean(item.cardId);
}

/** The lane DOT colour class (matches CockpitView's LANE_DOT — the three attention lanes). */
export const LANE_DOT_CLS: Record<CockpitGroup, string> = {
  travado: "bg-rose-500",
  pergunta: "bg-amber-400",
  aprovar: "bg-emerald-500",
};

/** The lane LABEL text colour class (matches CockpitView's LANE_LABEL_COLOR). */
export const LANE_TEXT_CLS: Record<CockpitGroup, string> = {
  travado: "text-rose-600 dark:text-rose-400",
  pergunta: "text-amber-700 dark:text-amber-400",
  aprovar: "text-emerald-700 dark:text-emerald-400",
};

/**
 * A one-line TITLE for an attention item: the underlying card's title, or the kind label for a
 * board-level item that carries no card (governance drafts, the copiloto's own approval requests).
 */
export function cockpitItemTitle(item: CockpitItem): string {
  const title = item.cardTitle?.trim();
  return title && title.length > 0 ? title : COCKPIT_KIND_LABEL[item.kind];
}

/** First non-empty trimmed string, or "" — keeps the per-kind branches below to one expression each. */
function firstText(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return t;
  }
  return "";
}

/**
 * The item's own WORDS — what the pile shows under the title so the operator can decide whether to
 * open it without opening it. Each kind keeps its detail in a differently-named field (a question has
 * `prompt`, a blocker a finding `title`, a proposal a `summary`…), so this is the ONE place that maps
 * the union onto a single line of prose.
 *
 * EXHAUSTIVE by construction: the `default` branch assigns to `never`, so adding a CockpitItemKind
 * without a branch here fails to compile — the same discipline as {@link COCKPIT_KIND_LABEL}.
 * Returns "" when the kind genuinely carries no prose; callers fall back to the kind label.
 */
export function cockpitItemSnippet(item: CockpitItem): string {
  switch (item.kind) {
    case "question":
      return firstText(item.prompt, item.context, item.recommendation);
    case "blocker":
    case "finding":
    case "deploy-failed":
      return firstText(item.title, item.suggestion);
    case "gate":
      return firstText(item.gateLabel);
    case "approval":
      return firstText(item.note, item.tool && `Ferramenta: ${item.tool}`, item.gateLabel);
    case "review":
      return "Triagem de baixa confiança — aceitar, recusar ou apontar a duplicata.";
    case "stuck":
      return firstText(item.outcome, item.trigger && `Run de ${item.trigger} não terminou.`);
    case "conflict":
      return item.conflictKind === "merge-gate-failed"
        ? "O gate do merge train reprovou este run."
        : "O merge train não conseguiu integrar sozinho.";
    case "proposal":
      return firstText(
        item.summary,
        item.items.length > 0 ? `${item.items.length} cards propostos.` : undefined,
      );
    case "design":
      return item.artifacts.length > 0
        ? `${item.artifacts.length} artefato(s) de design para aprovar.`
        : "Design para revisar.";
    case "governance":
      return firstText(
        item.reason,
        item.changes.length > 0 ? `${item.changes.length} mudança(s) no board.` : undefined,
      );
    case "deploy-unsettled":
      return "Deploy disparado, mas ninguém confirmou que subiu.";
    case "release-aging":
      return `Código aprovado parado em stage há ${item.ageDays}d — falta publicar.`;
    case "merge-failed":
      return firstText(item.failureReason, `Branch ${item.branch} ficou fora da main.`);
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

/**
 * How long the item has been waiting, in ms, or `null` when it carries no usable timestamp.
 * `since` is a best-effort ISO string (demands.ts) — a malformed one must read as "no age", never NaN.
 */
export function cockpitItemWaitingMs(item: CockpitItem, now: number): number | null {
  const since = item.since;
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}

// ── The feed's tri-state ─────────────────────────────────────────────────────────────────────────
//
// The design reduces every kanban row to THREE readings — "agindo", "aguardando você", "em pausa" —
// and that is the only thing the row's colour encodes. Deliberately NOT a per-step gerund table:
// StatusDef carries no progressive label (only `name`), and inventing a statusId→gerúndio map would
// be a SECOND source of step naming, guaranteed to drift the first time someone renames a step (and
// dead weight for a board that doesn't inherit the canonical `_base` pipeline). The step keeps its
// real name; the tri-state carries the state.

export type FeedState = "agindo" | "voce" | "pausa";

/**
 * `voce` wins over `agindo` on purpose: a card can be mid-run AND holding an open question, and the
 * whole thesis of this screen is that the human's attention is the scarce resource — a row that needs
 * you must never hide behind "it's busy, don't worry".
 */
export function feedState({ live, needsYou }: { live: boolean; needsYou: boolean }): FeedState {
  if (needsYou) return "voce";
  if (live) return "agindo";
  return "pausa";
}

/** Dot colour per state — emerald pulses (see {@link feedStatePulses}), amber waits, grey rests. */
export const FEED_STATE_DOT: Record<FeedState, string> = {
  agindo: "bg-emerald-500",
  voce: "bg-amber-400",
  pausa: "bg-fg-subtle",
};

/** Step-label ink per state. `text-accent` IS the design's amber (--accent), not a second colour. */
export const FEED_STATE_TEXT: Record<FeedState, string> = {
  agindo: "text-emerald-700 dark:text-emerald-400",
  voce: "text-accent",
  pausa: "text-fg-subtle",
};

/** Only a genuinely moving row animates — a pulsing dot that means nothing is just noise. */
export function feedStatePulses(state: FeedState): boolean {
  return state === "agindo";
}
