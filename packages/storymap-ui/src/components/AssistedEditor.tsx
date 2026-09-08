"use client";

// AssistedEditor — the reusable co-editing primitive for the operator's bench (Fase 3, P4).
// Wraps ANY editable artifact (the Resultado-alvo, a Lean Canvas block, an idea, a SKILL.md, an
// assistant prompt) with TWO ways to change it:
//   • editar direto — edit the value, preview the before/after diff, save.
//   • pedir ao agente — pick a MODE and ask the view-assistant:
//       - Aprender     → o agente EXPLICA (o que vai aqui, o que falta) — orientação em prosa.
//       - Editar       → o agente PROPÕE um novo valor → diff → aprovar/refinar/ajustar à mão.
//       - Sincronizar  → o agente LÊ o código real e deriva o valor (bootstrap) → diff → aprovar.
// Persistence + the agent call are injected (onSave / onAskAgent) so each screen wires them to the
// right server action — the component owns only the UX. Decoupled from the server Result via a
// structural { ok, ... } shape (the actions' Result is assignable to it).

import { useState } from "react";
import { AlertTriangle, BookOpen, Check, Loader2, Pencil, Plus, RefreshCw, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AssistedEditMode } from "@/lib/storymap/assisted-edit";

type SaveOutcome = { ok: boolean; error?: string };
type AgentOutcome = { ok: boolean; proposal?: string; error?: string };

// onSave receives (next, prev): `prev` is the value as the editor knew it at save time, so the
// caller can pass it as the governance `before` snapshot — robust across repeated edits in one
// session (a stale closure-captured value would falsely trip the conflict gate on a 2nd save).

type Mode = "view" | "edit" | "agent";
type AgentResult = { kind: "proposal" | "guidance"; text: string };

// editar primeiro → é o modo padrão (caso comum: o operador clica "pedir ao agente" para propor um ajuste).
const ALL_MODES: AssistedEditMode[] = ["editar", "aprender", "sincronizar"];

const MODE_META: Record<AssistedEditMode, { label: string; hint: string; placeholder: string; icon: typeof Sparkles }> = {
  aprender: {
    label: "Aprender",
    hint: "Entender o que vai aqui e como melhorar",
    placeholder: 'Ex.: "o que vai aqui? o que está fraco no valor atual?"',
    icon: BookOpen,
  },
  editar: {
    label: "Editar",
    hint: "O agente propõe um novo valor",
    placeholder: 'Ex.: "deixe mais mensurável e centrado em retenção"',
    icon: Sparkles,
  },
  sincronizar: {
    label: "Sincronizar",
    hint: "Derivar do código real (1ª vez)",
    placeholder: "Opcional: foque em algo. O agente lê o código real e propõe.",
    icon: RefreshCw,
  },
};

export function AssistedEditor({
  label,
  value,
  multiline = true,
  mono = false,
  placeholder,
  onSave,
  onAskAgent,
  agentModes = ALL_MODES,
  rows = 6,
  frameless = false,
  compact = false,
  addLabel,
}: {
  label: string;
  value: string;
  /** single-line input vs textarea */
  multiline?: boolean;
  /** render the value + editor in a monospace block (for SKILL.md / code-ish artifacts) */
  mono?: boolean;
  placeholder?: string;
  onSave: (next: string, prev: string) => Promise<SaveOutcome>;
  /** omit to disable the "pedir ao agente" half (edit-direct only) */
  onAskAgent?: (instruction: string, current: string, mode: AssistedEditMode) => Promise<AgentOutcome>;
  /** which agent modes to offer (default all three). Restrict for artifacts where a mode makes no sense. */
  agentModes?: AssistedEditMode[];
  rows?: number;
  /** sem moldura própria (rounded/border/bg) e ocupando toda a altura — para quando a CÉLULA que o
   * contém já é a borda (ex.: as células coladas do template do Lean Canvas). */
  frameless?: boolean;
  /** view em UMA linha (o label vive fora) — para faixas-cabeçalho enxutas como o Resultado-alvo.
   *  Ao Editar/Pedir-ao-agente, expande para o layout normal. */
  compact?: boolean;
  /** compact + vazio: rótulo do botão "+ {addLabel}" que entra direto no modo edição (afordância
   *  estilo Notion, em vez do placeholder italizado). Sem isto, o vazio mostra placeholder + ícones. */
  addLabel?: string;
}) {
  const [current, setCurrent] = useState(value);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState(value);
  const [instruction, setInstruction] = useState("");
  const [agentMode, setAgentMode] = useState<AssistedEditMode>(agentModes[0] ?? "editar");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode("view");
    setDraft(current);
    setInstruction("");
    setResult(null);
    setError(null);
    setBusy(false);
  };

  const openAgent = () => {
    setInstruction("");
    setResult(null);
    setError(null);
    setAgentMode(agentModes[0] ?? "editar");
    setMode("agent");
  };

  const persist = async (next: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await onSave(next, current);
    if (res.ok) {
      setCurrent(next);
      reset();
    } else {
      setBusy(false);
      setError(res.error ?? "Falha ao salvar.");
    }
  };

  const askAgent = async () => {
    if (busy || !onAskAgent) return;
    const t = instruction.trim();
    if (!t && agentMode !== "sincronizar") return; // editar/aprender exigem pedido; sincronizar não
    setBusy(true);
    setError(null);
    // Refine builds on the last PROPOSAL so "pedir mais ajustes" itera; aprender parte do valor atual.
    const base = result?.kind === "proposal" ? result.text : current;
    const res = await onAskAgent(t, base, agentMode);
    setBusy(false);
    if (res.ok && res.proposal) {
      setResult({ kind: agentMode === "aprender" ? "guidance" : "proposal", text: res.proposal });
    } else {
      setError(res.error ?? "O agente não retornou uma resposta.");
    }
  };

  // Compact view — a single inline row (no header/border/padding); the label lives in the host banner.
  // Editing/asking-the-agent falls through to the full layout below (it needs the room).
  if (compact && mode === "view") {
    // Empty + addLabel → a Notion-style "+ Adicionar" affordance instead of an italic placeholder.
    if (!current.trim() && addLabel) {
      return (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { setDraft(current); setMode("edit"); }}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <Plus className="h-3.5 w-3.5" /> {addLabel}
          </button>
          {onAskAgent && agentModes.length > 0 && (
            <button
              type="button"
              onClick={openAgent}
              title="Pedir ao agente"
              className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent transition hover:bg-surface-hover"
            >
              <Sparkles className="h-3 w-3" />
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        {current.trim() ? (
          <p className="min-w-0 flex-1 truncate text-[13px] leading-snug text-fg-muted" title={current}>
            {current}
          </p>
        ) : (
          <p className="min-w-0 flex-1 truncate text-[13px] italic text-fg-subtle">
            {placeholder ?? "Vazio — clique em Editar."}
          </p>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => { setDraft(current); setMode("edit"); }}
            title="Editar"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <Pencil className="h-3 w-3" />
            <span className="hidden lg:inline">Editar</span>
          </button>
          {onAskAgent && agentModes.length > 0 && (
            <button
              type="button"
              onClick={openAgent}
              title="Pedir ao agente"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-accent transition hover:bg-surface-hover"
            >
              <Sparkles className="h-3 w-3" />
              <span className="hidden lg:inline">Pedir ao agente</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col",
        frameless ? "h-full bg-transparent" : "rounded-lg border border-line bg-surface",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</span>
        {mode === "view" && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { setDraft(current); setMode("edit"); }}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
            >
              <Pencil className="h-3 w-3" /> Editar
            </button>
            {onAskAgent && agentModes.length > 0 && (
              <button
                type="button"
                onClick={openAgent}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent transition hover:bg-surface-hover"
              >
                <Sparkles className="h-3 w-3" /> Pedir ao agente
              </button>
            )}
          </div>
        )}
      </div>

      <div className="px-3 py-3">
        {/* ── VIEW ── */}
        {mode === "view" && (
          current.trim() ? (
            <ArtifactText text={current} mono={mono} />
          ) : (
            <p className="text-[13px] italic text-fg-subtle">{placeholder ?? "Vazio — clique em Editar ou peça ao agente."}</p>
          )
        )}

        {/* ── EDIT ── */}
        {mode === "edit" && (
          <div className="space-y-3">
            <Field value={draft} onChange={setDraft} multiline={multiline} mono={mono} rows={rows} placeholder={placeholder} />
            {draft !== current && <DiffView before={current} after={draft} mono={mono} />}
            <Actions
              busy={busy}
              primary={{ label: "Salvar", onClick: () => persist(draft), disabled: draft === current }}
              onCancel={reset}
            />
          </div>
        )}

        {/* ── AGENT ── */}
        {mode === "agent" && (
          <div className="space-y-3">
            {result === null ? (
              <>
                {agentModes.length > 1 && (
                  <div className="flex flex-wrap gap-1">
                    {agentModes.map((m) => {
                      const meta = MODE_META[m];
                      const Icon = meta.icon;
                      const active = m === agentMode;
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setAgentMode(m)}
                          title={meta.hint}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition",
                            active
                              ? "border-accent bg-accent/10 text-accent"
                              : "border-line text-fg-muted hover:bg-surface-hover hover:text-fg",
                          )}
                        >
                          <Icon className="h-3 w-3" /> {meta.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-[11px] leading-snug text-fg-subtle">{MODE_META[agentMode].hint}.</p>
                <textarea
                  autoFocus
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); askAgent(); } }}
                  rows={3}
                  placeholder={MODE_META[agentMode].placeholder}
                  className="w-full resize-y rounded-lg border border-line bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent"
                />
                <Actions
                  busy={busy}
                  busyLabel={agentMode === "sincronizar" ? "Investigando o código…" : "Gerando…"}
                  primary={{
                    label: agentMode === "aprender" ? "Perguntar" : agentMode === "sincronizar" ? "Sincronizar" : "Gerar proposta",
                    icon: "sparkles",
                    onClick: askAgent,
                    disabled: !instruction.trim() && agentMode !== "sincronizar",
                  }}
                  onCancel={reset}
                />
              </>
            ) : result.kind === "guidance" ? (
              <>
                <div className="whitespace-pre-wrap rounded-md border border-line bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg">
                  {result.text}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setDraft(current); setMode("edit"); setResult(null); }}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Editar à mão
                  </button>
                  <button
                    type="button"
                    onClick={() => { setResult(null); setInstruction(""); }}
                    className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover"
                  >
                    Perguntar de novo
                  </button>
                  <button
                    type="button"
                    onClick={reset}
                    className="ml-auto rounded-lg px-3 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover"
                  >
                    Fechar
                  </button>
                </div>
              </>
            ) : (
              <>
                <DiffView before={current} after={result.text} mono={mono} />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => persist(result.text)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Aprovar
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setDraft(result.text); setMode("edit"); setResult(null); }}
                    className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-50"
                  >
                    Ajustar à mão
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setResult(null); setInstruction(""); }}
                    className="rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover disabled:opacity-50"
                  >
                    Pedir mais ajustes
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={reset}
                    className="ml-auto rounded-lg px-3 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover disabled:opacity-50"
                  >
                    Descartar
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 leading-snug">{error}</span>
            <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-60 transition hover:opacity-100" aria-label="Fechar aviso">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactText({ text, mono }: { text: string; mono: boolean }) {
  if (mono) {
    return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-inset px-3 py-2 text-[12px] leading-snug text-fg">{text}</pre>;
  }
  return <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{text}</p>;
}

function Field({
  value,
  onChange,
  multiline,
  mono,
  rows,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  multiline: boolean;
  mono: boolean;
  rows: number;
  placeholder?: string;
}) {
  const base = "w-full rounded-lg border border-line bg-inset px-3 py-2 text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent";
  if (!multiline) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={cn(base, "text-[13px]")} />;
  }
  return (
    <textarea
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      placeholder={placeholder}
      className={cn(base, "resize-y leading-relaxed", mono ? "font-mono text-[12px]" : "text-[13px]")}
    />
  );
}

/** Honest before/after panels — zero-dep, always correct. Upgrade to line-level diff later if needed. */
function DiffView({ before, after, mono }: { before: string; after: string; mono: boolean }) {
  const cell = cn("max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md px-3 py-2 leading-snug", mono ? "font-mono text-[11px]" : "text-[12px]");
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">Antes</p>
        <div className={cn(cell, "border border-red-200 bg-red-50/50 text-fg-muted dark:border-red-500/30 dark:bg-red-500/5")}>
          {before.trim() || <span className="italic text-fg-subtle">(vazio)</span>}
        </div>
      </div>
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Depois</p>
        <div className={cn(cell, "border border-emerald-200 bg-emerald-50/50 text-fg dark:border-emerald-500/30 dark:bg-emerald-500/5")}>
          {after.trim() || <span className="italic text-fg-subtle">(vazio)</span>}
        </div>
      </div>
    </div>
  );
}

function Actions({
  busy,
  busyLabel = "Salvando…",
  primary,
  onCancel,
}: {
  busy: boolean;
  busyLabel?: string;
  primary: { label: string; onClick: () => void; disabled?: boolean; icon?: "sparkles" | "check" };
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={primary.onClick}
        disabled={busy || primary.disabled}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : primary.icon === "sparkles" ? <Sparkles className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
        {busy ? busyLabel : primary.label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover disabled:opacity-50"
      >
        Cancelar
      </button>
    </div>
  );
}
