// The broker's SINK registry — where an AnnotationBatch becomes AgileHarness work.
//
// A Sink is `{ id, accepts(batch), run(batch, deps) }`. Adding a destination = ONE entry
// here (the modular contract), never a change to the schema or the overlay. Dependencies
// (the real server actions) are INJECTED so the routing is unit-testable without spawning
// the triage agent. The broker runs INSIDE the storymap-ui service, which is the SOLE writer
// of board data (D4/WS-3) — the overlay only captures; this is what actually writes.
//
// Fase 1 ships ONE sink: `triage` (any batch with a board → report_issue → a triage card the
// agent classifies). Fase 2 adds `refine` (link.kind=card → DesignFeedbackEntry with a
// first-class anchor); Fase 3 adds `terminal` (link.kind=session → claude_send).

import { type AnnotationBatch, renderBatchMarkdown } from "./schema";

export interface SinkResult {
  sink: string;
  ok: boolean;
  detail: string;
  cardId?: string;
  count?: number;
}

/** The board writes a sink needs — injected by the intake route (real actions) or a test (fakes). */
export interface SinkDeps {
  reportIssue(input: {
    boardId: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string; data?: { card: { id: string } } }>;
  /** Reopen a card in refine mode with the annotations as the brief (feedback-overlay Fase 2). */
  refineCard(input: {
    boardId: string;
    cardId: string;
    brief: string;
    kinds: string[];
  }): Promise<{ ok: boolean; error?: string; data?: { card: { id: string } } }>;
  /** Send the annotations back into a tmux session (feedback-overlay Fase 3 round-trip). */
  sendToTerminal(input: { sessionId: string; text: string }): Promise<{ ok: boolean; error?: string }>;
}

export interface Sink {
  id: string;
  accepts(batch: AnnotationBatch): boolean;
  run(batch: AnnotationBatch, deps: SinkDeps): Promise<SinkResult>;
}

/** Opened from a terminal (link.kind=session) → send the annotations straight back into that tmux
 *  session (the operator's Claude receives them as a prompt). No copy-paste. If the send fails, the
 *  intake still returns the handoff markdown, so nothing is stranded. */
export const terminalSink: Sink = {
  id: "terminal",
  accepts: (b) => b.link.kind === "session" && Boolean(b.link.sessionId),
  run: async (b, deps) => {
    const sessionId = b.link.sessionId as string;
    const text = `${renderBatchMarkdown(b)}\n\n_(feedback visual via overlay — ${b.pins.length} anotação(ões))_`;
    const r = await deps.sendToTerminal({ sessionId, text });
    return r.ok
      ? { sink: "terminal", ok: true, count: b.pins.length, detail: `Enviado ao terminal ${sessionId}.` }
      : { sink: "terminal", ok: false, detail: r.error ?? "falha ao enviar ao terminal" };
  },
};

/** Linked to a card → reopen THAT card in refine mode with the annotations as the brief (the brief
 *  carries every pin's grep-friendly selector + rect + route as markdown, so harness-refine locates the
 *  code). Attaches to the card itself; if the refine can't apply (not a story / not found), it falls
 *  back to triage — the feedback is never lost. ONE reopen per batch → no per-pin failure window. */
export const refineSink: Sink = {
  id: "refine",
  accepts: (b) => b.link.kind === "card" && Boolean(b.link.cardId) && Boolean(b.link.board),
  run: async (b, deps) => {
    const boardId = b.link.board as string;
    const cardId = b.link.cardId as string;
    const brief = `${renderBatchMarkdown(b)}\n\n_(via feedback-overlay — anotações na UI ao vivo)_`;
    const r = await deps.refineCard({ boardId, cardId, brief, kinds: ["ux"] });
    if (r.ok) {
      return { sink: "refine", ok: true, cardId, count: b.pins.length, detail: `Card ${cardId} reaberto em refino com ${b.pins.length} anotação(ões).` };
    }
    // The card can't be refined (not a story / not found) — don't lose the feedback: file it to triage.
    const t = await deps.reportIssue({
      boardId,
      text: `${renderBatchMarkdown(b)}\n\n> Refino do card \`${cardId}\` não pôde ser aplicado (${r.error ?? "erro"}) — encaminhado à triagem.`,
    });
    if (t.ok && t.data) {
      return { sink: "refine→triage", ok: true, cardId: t.data.card.id, detail: `Refino não aplicável — feedback à triagem: ${t.data.card.id}` };
    }
    return { sink: "refine", ok: false, detail: r.error ?? t.error ?? "falha ao refinar" };
  },
};

/** Free-text intake: the whole batch → ONE triage card the read-only triage agent classifies
 *  (bug / melhoria / feature) and files into the Triagem lane. Works for ANY board — the
 *  app-agnostic default. A linked-but-not-yet-refinable card rides in as a related note. */
export const triageSink: Sink = {
  id: "triage",
  accepts: (b) => Boolean(b.link.board),
  run: async (b, deps) => {
    const boardId = b.link.board as string;
    const text =
      b.link.kind === "card" && b.link.cardId
        ? `${renderBatchMarkdown(b)}\n\n> Relacionado ao card \`${b.link.cardId}\`.`
        : renderBatchMarkdown(b);
    const r = await deps.reportIssue({ boardId, text });
    if (r.ok && r.data) {
      return { sink: "triage", ok: true, cardId: r.data.card.id, detail: `Card de triagem criado: ${r.data.card.id}` };
    }
    return { sink: "triage", ok: false, detail: r.error ?? "falha ao criar o card de triagem" };
  },
};

/** The registry — first accepting sink wins: session→terminal, card→refine, else triage. */
export const SINKS: Sink[] = [terminalSink, refineSink, triageSink];

export function pickSink(batch: AnnotationBatch): Sink | null {
  return SINKS.find((s) => s.accepts(batch)) ?? null;
}
