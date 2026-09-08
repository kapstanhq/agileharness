"use client";

// DesignCanvas — the free multi-artifact design surface both approval surfaces share (CardDocument
// drawer + CockpitView Inbox). Replaces the single-choice radio/`Escolher esta` model: the
// human reacts PER ARTIFACT (one-tap approve · change request · set primary) and canvas-wide, and
// the accumulated unresolved change-requests are what a "Pedir ajuste" re-run incorporates.
// Legacy docs (options[], no artifacts) render through the SAME path via the in-memory selector
// bridge (design-canvas.ts) — one render path, no fork.

import { useState } from "react";
import { Check, MessageSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { DOC_SECTION } from "@/components/doc/typography";
import {
  artifactFeedback,
  canvasWideFeedback,
  JOURNEY_FEEDBACK_ID,
  orderedCanvasArtifacts,
} from "@/lib/storymap/design-canvas";
import type { DesignArtifact, DesignFeedbackEntry, WireframeDoc, WireframeJourney } from "@/lib/storymap/types";
import { AsciiFigure } from "../AsciiFigure";
import { WireframeDSL } from "./WireframeDSL";
import { FlowGraphView } from "./FlowGraphView";
import { HtmlArtifactFrame } from "./HtmlArtifactFrame";
import { JourneyView } from "./JourneyView";

export type DesignCanvasDoc = Pick<WireframeDoc, "artifacts" | "options" | "chosenOptionId" | "feedback">;

const KIND_SECTION: Record<DesignArtifact["kind"], string> = {
  screen: "Telas",
  component: "Componentes",
  flow: "Fluxos",
  note: "Notas",
};

const STATE_LABEL: Record<string, string> = {
  populated: "populado",
  empty: "vazio",
  loading: "carregando",
  error: "erro",
};

function FeedbackLine({ entry }: { entry: DesignFeedbackEntry }) {
  const mark =
    entry.kind === "approve" ? (
      <Check className="h-3 w-3 shrink-0 text-emerald-500" />
    ) : entry.resolvedAt ? (
      <Check className="h-3 w-3 shrink-0 text-fg-subtle" />
    ) : (
      <MessageSquare className="h-3 w-3 shrink-0 text-amber-500" />
    );
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-snug text-fg-muted">
      {mark}
      <span className="min-w-0">
        {entry.note}
        <span className="text-fg-subtle"> — {entry.by}{entry.at ? `, ${entry.at}` : ""}{entry.kind === "change" && entry.resolvedAt ? " · incorporado" : ""}</span>
      </span>
    </p>
  );
}

function ArtifactBody({ artifact, compact }: { artifact: DesignArtifact; compact: boolean }) {
  if (artifact.format === "dsl" && artifact.dsl) {
    return (
      <div className={cn("overflow-auto rounded-md border border-line bg-surface p-2.5", compact ? "max-h-80" : "max-h-[460px]")}>
        <WireframeDSL node={artifact.dsl} viewport={artifact.viewport} />
      </div>
    );
  }
  if (artifact.format === "html" && artifact.html != null) {
    return <HtmlArtifactFrame html={artifact.html} title={artifact.title} viewport={artifact.viewport} heightHint={artifact.heightHint} />;
  }
  if (artifact.format === "graph" && artifact.graph) {
    return <FlowGraphView graph={artifact.graph} className="my-0" />;
  }
  if (artifact.kind === "note") {
    return <p className="whitespace-pre-wrap rounded-md border border-line bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-fg-muted">{artifact.content}</p>;
  }
  return artifact.content.trim() ? <AsciiFigure ascii={artifact.content} /> : null;
}

export function DesignCanvas({
  doc,
  busy = false,
  compact = false,
  onSetPrimary,
  onFeedback,
  journey = null,
}: {
  doc: DesignCanvasDoc;
  busy?: boolean;
  compact?: boolean;
  /** set the primary screen (chooseWireframeAction) — omitted = read-only surface */
  onSetPrimary?: (artifactId: string) => void;
  /** append a feedback entry (submitDesignFeedbackAction) — omitted = read-only surface */
  onFeedback?: (artifactId: string | null, note: string, kind: "change" | "approve") => void | Promise<void>;
  /** when provided, the journey renders as the FIRST canvas card — same chrome as the artifact
   *  cards, with its own feedback field. Three DISTINCT feedback scopes (operator decision
   *  2026-07-22): a concrete artifact (inline input on its card) · the journey (inline input on the
   *  journey card, target `JOURNEY_FEEDBACK_ID`) · the design AS A WHOLE (`artifactId: null`, the
   *  visually distinct accent panel at the end of the canvas). Journey and whole-design both route
   *  the redesign through `design-ux`. */
  journey?: WireframeJourney | null;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const artifacts = orderedCanvasArtifacts(doc);
  const wide = canvasWideFeedback(doc);
  const journeyThread = artifactFeedback(doc, JOURNEY_FEEDBACK_ID);
  const interactive = onFeedback != null;

  // As seções do canvas (Jornada · Telas · Componentes · Feedback) são seções DO DOCUMENTO quando o
  // canvas mora dentro do card aberto — mesma escala das `##` ao redor, e é assim que o sumário
  // (DocOutline) as lista como irmãs. Na superfície COMPACTA (Inbox/cockpit) elas continuam sendo
  // rótulos de widget: ali o canvas é um painel dentro de um item, não o documento.
  const sectionCls = () =>
    compact ? "mb-1.5 mt-4 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle first:mt-0" : DOC_SECTION;

  const send = async (artifactId: string | null, kind: "change" | "approve") => {
    const key = artifactId ?? "__geral";
    const note = (drafts[key] ?? "").trim();
    if (kind === "change" && !note) return;
    await onFeedback?.(artifactId, note, kind);
    setDrafts((d) => ({ ...d, [key]: "" }));
  };

  const composer = (artifactId: string | null, placeholder: string) => {
    if (!interactive) return null;
    const key = artifactId ?? "__geral";
    return (
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          type="text"
          value={drafts[key] ?? ""}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void send(artifactId, "change");
            }
          }}
          placeholder={placeholder}
          className="min-w-0 flex-1 rounded-md border border-line bg-inset px-2 py-1 text-[11px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          disabled={busy || !(drafts[key] ?? "").trim()}
          onClick={() => void send(artifactId, "change")}
          title="Pedir esta mudança (entra no feedback que o redesenho incorpora)."
          className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
        >
          Pedir mudança
        </button>
        {artifactId != null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(artifactId, "approve")}
            title="Marca este artefato como aprovado — o redesenho o preserva como está."
            className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-emerald-700 transition hover:bg-surface-hover disabled:opacity-40 dark:text-emerald-400"
          >
            Aprovar
          </button>
        )}
      </div>
    );
  };

  let section = "";
  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      {journey && (
        <div>
          <h2 className={sectionCls()}>Jornada</h2>
          <div className="rounded-md border border-line bg-inset px-2.5 py-2">
            <JourneyView journey={journey} compact={compact} />
            {journeyThread.length > 0 && (
              <div className="mt-2 space-y-1 border-t border-line-muted pt-1.5">
                {journeyThread.map((f) => (
                  <FeedbackLine key={f.id} entry={f} />
                ))}
              </div>
            )}
            {composer(JOURNEY_FEEDBACK_ID, "Pedir mudança na jornada… (Enter)")}
          </div>
        </div>
      )}

      {artifacts.map((a) => {
        const isPrimary = doc.chosenOptionId === a.id;
        const thread = artifactFeedback(doc, a.id);
        const header = KIND_SECTION[a.kind];
        const showHeader = header !== section;
        if (showHeader) section = header;
        return (
          <div key={a.id}>
            {showHeader && (
              <h2 className={sectionCls()}>{header}</h2>
            )}
            <div className={cn("rounded-md border px-2.5 py-2", isPrimary ? "border-accent/50 bg-accent/8" : "border-line bg-inset")}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-[13px] font-medium text-fg">{a.title}</span>
                {isPrimary && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                    principal
                  </span>
                )}
                <span className="text-[10px] text-fg-subtle">
                  {[a.viewport, a.state ? STATE_LABEL[a.state] ?? a.state : null].filter(Boolean).join(" · ")}
                </span>
                {a.journeyRef && <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-fg-subtle">jornada: {a.journeyRef}</span>}
                {onSetPrimary && a.kind === "screen" && !isPrimary && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSetPrimary(a.id)}
                    title="Torna esta a tela principal do design (o gate de aprovação aponta para ela)."
                    className="ml-auto rounded-md border border-line px-2 py-0.5 text-[10px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-40"
                  >
                    Tornar principal
                  </button>
                )}
              </div>

              <div className="mt-2">
                <ArtifactBody artifact={a} compact={compact} />
              </div>
              {a.note.trim() && <p className="mt-1 text-[11px] leading-snug text-fg-subtle">{a.note}</p>}

              {thread.length > 0 && <div className="mt-2 space-y-1 border-t border-line-muted pt-1.5">{thread.map((f) => <FeedbackLine key={f.id} entry={f} />)}</div>}
              {composer(a.id, "Pedir mudança neste artefato… (Enter)")}
            </div>
          </div>
        );
      })}

      {/* WHOLE-DESIGN feedback — its own quiet block at the end (Notion-style: same neutral chrome
          as the artifact cards, distinguished by POSITION + heading + a multiline textarea, never by
          a loud color). Enter submits (Shift+Enter = nova linha) — no send button of its own: the
          only redesign TRIGGER is the surface's "Pedir ajuste". Targets `artifactId: null`. */}
      {(wide.length > 0 || interactive) && (
        <div className="mt-4">
          <h2 className={sectionCls()}>Feedback do design como um todo</h2>
          <div className="rounded-md border border-line bg-inset px-2.5 py-2">
            {wide.length > 0 && (
              <div className="mb-2 space-y-1">
                {wide.map((f) => (
                  <FeedbackLine key={f.id} entry={f} />
                ))}
              </div>
            )}
            {interactive && (
              <textarea
                value={drafts.__geral ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, __geral: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(null, "change");
                  }
                }}
                rows={2}
                placeholder="Feedback sobre a proposta inteira — direção, coerência, o que falta… (Enter envia)"
                className="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
