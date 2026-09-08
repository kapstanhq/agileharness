"use client";

// 🟥 Design · Guia de Estilo — the 2-state machine (Vazio / Publicado). The guide is a PLAIN
// SOURCE-OF-TRUTH document a human authors directly (prompt/refs → the assist action compiles + writes
// it); there is NO generation/approval/options flow. A THIN CLIENT SHELL: the "which state renders"
// decision is the pure `deriveEstiloState` (src/lib/storymap/derive-estilo-state.ts) — this file wires
// props to it, renders each state, and calls the authoring server actions (requestStyleGuideAssistAction
// → applyStyleGuideAssistAction). Result<T> + toast, NO optimism: a refused action reverts nothing
// locally and ALWAYS `router.refresh()`s (including on a refused apply — a stale baseVersion) so the tab
// never resends a defasado value in a loop.
//
// Type-only imports from style-guide.ts throughout (see derive-estilo-state.ts's header note): that
// module has a top-level `import { createHash } from "node:crypto"`, which must never enter this
// "use client" bundle as a RUNTIME import. Every kernel FUNCTION call (isEmptyStyleGuideDoc,
// styleGuideToPrompt) already happened server-side, in estilo/page.tsx.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Palette, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { BoardHeader } from "@/components/BoardHeader";
import { ToastProvider, useToast } from "@/components/Toast";
import { applyStyleGuideAssistAction, requestStyleGuideAssistAction } from "@/app/design-actions";
import { deriveEstiloState } from "@/lib/storymap/derive-estilo-state";
import { STYLE_SECTIONS, styleSectionLabel } from "@/lib/storymap/style-guide-blocks";
import { StyleDriftPanel } from "@/components/design/DriftPanel";
import { RefsUploader, type UploadedRef } from "@/components/design/RefsUploader";
import { StyleSwatches } from "@/components/design/StyleSwatches";
import { TypeScalePreview } from "@/components/design/TypeScalePreview";
import type { Board, BoardSummary } from "@/lib/storymap/types";
import type { AAReport, StyleGuideDiff, StyleGuideDoc, StyleGuidePointer } from "@/lib/storymap/style-guide";

export interface EstiloViewProps {
  board: Board;
  boards: BoardSummary[];
  styleGuide: StyleGuideDoc | null;
  hasPublishedGuide: boolean;
  /** styleGuideToPrompt(atual), precomputed server-side — seeds the "Editar guia" authoring form. */
  prefillPrompt: string | null;
  /** sub-topnav (DocToolbar) injetado pelo EstiloScreen — o caminho de volta para a view Documento. */
  subnav?: React.ReactNode;
}

export function EstiloView(props: EstiloViewProps) {
  return (
    <ToastProvider>
      <EstiloViewInner {...props} />
    </ToastProvider>
  );
}

function EstiloViewInner({ board, boards, styleGuide, hasPublishedGuide, prefillPrompt, subnav }: EstiloViewProps) {
  const state = deriveEstiloState({ styleGuide, hasPublishedGuide });
  const baseVersion = board.config.styleGuide?.version ?? 0;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={board.config} view="estilo" />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 pb-20 md:pb-6">
        {subnav && <div className="mb-3 flex justify-end">{subnav}</div>}
        <div className="mb-4">
          <h1 className="flex items-center gap-2 text-[17px] font-bold tracking-[-0.015em] text-fg">
            <Palette className="h-[17px] w-[17px] shrink-0 text-accent" />
            Guia de Estilo
          </h1>
          <p className="mt-1 max-w-[640px] text-[12.5px] leading-[1.5] text-fg-muted">
            A fonte da verdade de estética deste board — cores, tipografia, voz e anti-padrões que todo
            agente que desenha ou refatora UI consome.
          </p>
        </div>

        {state.kind === "vazio" && <AuthorPanel boardId={board.config.id} initialPrompt="" baseVersion={baseVersion} />}
        {state.kind === "publicado" && (
          <PublicadoPanel
            boardId={board.config.id}
            styleGuide={state.styleGuide}
            pointer={board.config.styleGuide}
            prefillPrompt={prefillPrompt}
            baseVersion={baseVersion}
          />
        )}
      </main>
    </div>
  );
}

// ── Author (empty state + "Editar guia") ──────────────────────────────────────
//
// The human-authoring path: a prompt (+ optional reference images) → requestStyleGuideAssistAction
// produces a full StyleGuideDoc for review → applyStyleGuideAssistAction compiles + writes the pointer.
// There are NO options to approve — the operator writes/edits the ONE guide directly.

function AuthorPanel({
  boardId,
  initialPrompt,
  baseVersion,
}: {
  boardId: string;
  initialPrompt: string;
  baseVersion: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [prompt, setPrompt] = useState(initialPrompt);
  const [refs, setRefs] = useState<UploadedRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{ doc: StyleGuideDoc; aa: AAReport; diff: StyleGuideDiff } | null>(null);

  const canGenerate = prompt.trim().length > 0 || refs.length > 0;

  const generate = async () => {
    if (!canGenerate) return;
    setBusy(true);
    // The assist action edits the current canonical from a text instruction. Reference images are
    // uploaded to design/refs/ (persisted); pass their paths in the instruction so the agent records
    // them in meta.sources.refs.
    const refNote = refs.length
      ? `\n\nReferências de imagem enviadas (registre em meta.sources.refs): ${refs.map((r) => r.path).join(", ")}`
      : "";
    const res = await requestStyleGuideAssistAction({
      boardId,
      mode: "editar",
      instruction: `${prompt.trim()}${refNote}`.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      toast(res.error);
      return;
    }
    if (res.data?.kind !== "proposal") {
      toast("O agente não retornou um guia com conteúdo.");
      return;
    }
    setProposal({ doc: res.data.doc, aa: res.data.aa, diff: res.data.diff });
  };

  const publish = async () => {
    if (!proposal) return;
    setBusy(true);
    const res = await applyStyleGuideAssistAction({ boardId, doc: proposal.doc, baseVersion });
    setBusy(false);
    if (!res.ok) {
      toast(res.error);
      // A baseVersion conflict is the likeliest refusal — MANDATORY refresh so the tab picks up the
      // canonical that moved under it, instead of resending the same stale baseVersion in a loop.
      router.refresh();
      return;
    }
    toast("Guia publicado.", "success");
    router.refresh();
  };

  if (proposal) {
    const aaFails = proposal.aa.pairs.filter((p) => p.level === "fail").map((p) => p.role);
    const changed = [
      ...proposal.diff.changedSections.map((k) => styleSectionLabel(k)),
      ...proposal.diff.colorTokenChanges.map((c) => `${c.role} (${c.kind === "added" ? "novo" : c.kind === "removed" ? "removido" : "alterado"})`),
    ];
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <p className="text-[13px] font-medium text-fg">Revise o guia proposto</p>
        {changed.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {changed.map((label) => (
              <span key={label} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                {label}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] italic text-fg-subtle">Nenhuma mudança em relação ao guia atual.</p>
        )}
        {aaFails.length > 0 && (
          <p className="text-[11.5px] text-amber-700 dark:text-amber-300">
            Contraste AA baixo em: {aaFails.join(", ")} — informativo, não bloqueia a publicação (ajuste as cores se quiser).
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={publish}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-fg px-4 text-[13px] font-medium text-surface transition hover:bg-fg/85 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Publicar guia
          </button>
          <button
            type="button"
            onClick={() => setProposal(null)}
            disabled={busy}
            className="inline-flex h-9 items-center rounded-lg border border-line px-3 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-50"
          >
            Editar o pedido
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-fg-muted">Descreva a estética desejada</span>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder='Escola, energia, referências — ex.: "editorial urbano de alto contraste, energia de app de eventos"'
          rows={6}
          disabled={busy}
          className="rounded-lg border border-line bg-inset px-3 py-2 text-[13px] outline-none focus:border-accent disabled:opacity-60"
        />
      </label>
      <RefsUploader boardId={boardId} refs={refs} onChange={setRefs} disabled={busy} />
      <button
        type="button"
        onClick={generate}
        disabled={busy || !canGenerate}
        className="inline-flex h-9 items-center justify-center gap-1.5 self-start rounded-lg bg-fg px-4 text-[13px] font-medium text-surface transition hover:bg-fg/85 disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        Gerar guia
      </button>
    </div>
  );
}

// ── Publicado ─────────────────────────────────────────────────────────────────

function PublicadoPanel({
  boardId,
  styleGuide,
  pointer,
  prefillPrompt,
  baseVersion,
}: {
  boardId: string;
  styleGuide: StyleGuideDoc;
  pointer?: StyleGuidePointer;
  prefillPrompt: string | null;
  baseVersion: number;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) return <AuthorPanel boardId={boardId} initialPrompt={prefillPrompt ?? ""} baseVersion={baseVersion} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3">
        <div className="flex items-center gap-2 text-[12px] text-fg-muted">
          <span className="rounded-full bg-fg/10 px-2 py-0.5 font-semibold text-fg">v{styleGuide.meta.version}</span>
          {pointer?.hash && <span className="font-mono text-[10px] text-fg-subtle">#{pointer.hash.slice(0, 8)}</span>}
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Editar guia
        </button>
      </div>

      <StyleDriftPanel boardId={boardId} />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {STYLE_SECTIONS.map((s) => (
          <section key={s.key} className={cn("min-w-0 rounded-xl border border-line bg-surface p-3", s.cell)}>
            <h2 className="mb-2 text-[13px] font-semibold text-fg">{s.label}</h2>
            <SectionBody sectionKey={s.key} doc={styleGuide} hint={s.hint} />
          </section>
        ))}
      </div>
    </div>
  );
}

function EmptyHint({ hint }: { hint: string }) {
  return <p className="text-[11px] italic text-fg-subtle">{hint}</p>;
}

/** Renders ONE STYLE_SECTIONS entry from the published doc — presentational only (the compiled .md's
 *  own serializer, `renderSectionBody`, is a private, server-only function in style-guide.ts; this is
 *  a DIFFERENT concern — a React view of the same data, not a duplicate of the markdown compiler). */
function SectionBody({ sectionKey, doc, hint }: { sectionKey: string; doc: StyleGuideDoc; hint: string }) {
  switch (sectionKey) {
    case "identity":
      if (!doc.identity.school && doc.identity.personality.length === 0 && !doc.identity.prose) {
        return <EmptyHint hint={hint} />;
      }
      return (
        <div className="flex flex-col gap-1.5 text-[12px] text-fg-muted">
          {doc.identity.school && (
            <p>
              <b className="font-semibold text-fg">Escola:</b> {doc.identity.school}
            </p>
          )}
          {doc.identity.personality.length > 0 && <p>{doc.identity.personality.join(" · ")}</p>}
          {doc.identity.prose && <p className="whitespace-pre-wrap">{doc.identity.prose}</p>}
        </div>
      );

    case "principles":
      if (doc.principles.items.length === 0) return <EmptyHint hint={hint} />;
      return (
        <ol className="flex flex-col gap-1 text-[12px] text-fg-muted">
          {doc.principles.items.map((p, i) => (
            <li key={i}>
              {i + 1}. {p}
            </li>
          ))}
        </ol>
      );

    case "color":
      if (doc.color.tokens.length === 0 && doc.color.budgetRules.length === 0) return <EmptyHint hint={hint} />;
      return (
        <div className="flex flex-col gap-2">
          <StyleSwatches tokens={doc.color.tokens} />
          {doc.color.budgetRules.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-[11px] text-fg-subtle">
              {doc.color.budgetRules.map((r, i) => (
                <li key={i}>· {r}</li>
              ))}
            </ul>
          )}
        </div>
      );

    case "typography":
      if (doc.typography.fonts.length === 0 && doc.typography.scale.length === 0) return <EmptyHint hint={hint} />;
      return (
        <div className="flex flex-col gap-2">
          {doc.typography.fonts.length > 0 && (
            <p className="text-[11px] text-fg-muted">
              {doc.typography.fonts.map((f) => `${f.family} (${f.role})`).join(" · ")}
            </p>
          )}
          <TypeScalePreview scale={doc.typography.scale} />
        </div>
      );

    case "spacing":
      if (!doc.spacing.base && doc.spacing.steps.length === 0) return <EmptyHint hint={hint} />;
      return (
        <p className="text-[12px] text-fg-muted">
          base {doc.spacing.base} · {doc.spacing.steps.join(", ")}
        </p>
      );

    case "shape": {
      const radii = Object.entries(doc.shape.radii);
      if (radii.length === 0 && !doc.shape.depth && !doc.shape.borders) return <EmptyHint hint={hint} />;
      return (
        <div className="flex flex-col gap-1 text-[12px] text-fg-muted">
          {radii.map(([k, v]) => (
            <p key={k}>
              {k}: {v}
            </p>
          ))}
          {doc.shape.depth && <p>Profundidade: {doc.shape.depth}</p>}
          {doc.shape.borders && <p>Bordas: {doc.shape.borders}</p>}
        </div>
      );
    }

    case "motion": {
      const durations = Object.entries(doc.motion.durations);
      const easings = Object.entries(doc.motion.easings);
      if (durations.length === 0 && easings.length === 0) return <EmptyHint hint={hint} />;
      return (
        <div className="flex flex-col gap-1 text-[12px] text-fg-muted">
          {durations.map(([k, v]) => (
            <p key={k}>
              {k}: {v}
            </p>
          ))}
          {easings.map(([k, v]) => (
            <p key={`e-${k}`}>
              easing {k}: {v}
            </p>
          ))}
        </div>
      );
    }

    case "voice":
      if (doc.voice.lexicon.preferred.length === 0 && doc.voice.lexicon.forbidden.length === 0) {
        return <EmptyHint hint={hint} />;
      }
      return (
        <div className="flex flex-col gap-2 text-[12px] text-fg-muted">
          {doc.voice.lexicon.preferred.length > 0 && (
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr>
                  <th className="pr-2 font-medium text-fg-subtle">use</th>
                  <th className="font-medium text-fg-subtle">evite</th>
                </tr>
              </thead>
              <tbody>
                {doc.voice.lexicon.preferred.map((p, i) => (
                  <tr key={i}>
                    <td className="pr-2">{p.use}</td>
                    <td>{p.avoid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {doc.voice.lexicon.forbidden.length > 0 && <p>Proibido: {doc.voice.lexicon.forbidden.join(", ")}</p>}
        </div>
      );

    case "antiPatterns":
      if (doc.antiPatterns.length === 0) return <EmptyHint hint={hint} />;
      return (
        <ul className="flex flex-col gap-1 text-[12px] text-fg-muted">
          {doc.antiPatterns.map((a, i) => (
            <li key={i}>
              {a.symptom} → {a.fix}
            </li>
          ))}
        </ul>
      );

    case "debt":
      if (doc.debt.knownIssues.length === 0) return <EmptyHint hint={hint} />;
      return (
        <ul className="flex flex-col gap-1 text-[12px] text-fg-muted">
          {doc.debt.knownIssues.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      );

    default:
      return <EmptyHint hint={hint} />;
  }
}
