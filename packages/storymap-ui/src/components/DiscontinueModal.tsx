"use client";

import { useState } from "react";
import { AlertTriangle, Archive, Check, ImagePlus, ShieldAlert, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { discontinueCardAction } from "@/app/actions";
import { DISPOSITIONS, REMOVAL_LEVELS, REMOVAL_SCOPES } from "@/lib/storymap/frameworks";
import type { Disposition, RemovalLevel, RemovalScope } from "@/lib/storymap/frameworks";
import type { Card } from "@/lib/storymap/types";
import { REOPENABLE_STATUSES } from "@/lib/storymap/reopen";

const inputCls =
  "w-full rounded-lg border border-line bg-inset px-3 py-2 text-[15px] text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent";

/**
 * "Descontinuar" — the third reopen sibling (after RefineModal/BugModal), for the
 * REMOVE flow. Captures the free-text reason, the DISPOSITION (why it's leaving), and
 * — when there's live code to cut — the removal LEVEL (deactivate ↔ delete) + SCOPE,
 * then calls `discontinueCardAction` to stamp `mode: retire` and route the card: a
 * level set sends it through the `descontinuar` executor (harness-retire); postergado /
 * "nothing to remove" sends it straight to the terminal `arquivados` graveyard.
 */
export function DiscontinueModal({
  boardId,
  card,
  onCancel,
  onDone,
}: {
  boardId: string;
  card: Card;
  onCancel: () => void;
  onDone: (card: Card) => void;
}) {
  // In human QA / shipped (REOPENABLE_STATUSES) the feature is live → default "descontinuado" (we're
  // killing it); anything earlier → "abandonado" (in the flow, never shipped). Postergado is explicit.
  const defaultDisposition: Disposition =
    card.status && REOPENABLE_STATUSES.has(card.status) ? "descontinuado" : "abandonado";
  const [brief, setBrief] = useState("");
  const [disposition, setDisposition] = useState<Disposition>(defaultDisposition);
  // Descontinuado defaults to a soft cut (despublicar); abandonado starts with nothing
  // to remove (the human opts in if there's WIP to clean). Postergado forces null below.
  const [level, setLevel] = useState<RemovalLevel | null>(
    defaultDisposition === "descontinuado" ? "despublicar" : null,
  );
  const [scope, setScope] = useState<RemovalScope[]>([]);
  const [target, setTarget] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null); // data URL
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPostergado = disposition === "postergado";
  // postergado never removes code → no level/scope; otherwise the chosen level decides
  // whether the card routes through the executor (level set) or archives directly (null).
  const effectiveLevel = isPostergado ? null : level;
  const goesToExecutor = !!effectiveLevel;
  const isDestructive = effectiveLevel === "excluir-tudo";

  const pickDisposition = (d: Disposition) => {
    setError(null);
    setDisposition(d);
    if (d === "postergado") setLevel(null);
    else if (d === "descontinuado" && level == null) setLevel("despublicar");
  };
  const toggleScope = (id: RemovalScope) =>
    setScope((cur) => (cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]));

  const onFile = (file?: File | null) => {
    if (!file) {
      setScreenshot(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setScreenshot(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  const submit = async () => {
    const b = brief.trim();
    if (!b) {
      setError("Escreva o motivo da descontinuação — por que sai e (se for o caso) até onde remover.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await discontinueCardAction({
      boardId,
      cardId: card.id,
      brief: b,
      disposition,
      level: effectiveLevel,
      scope: isPostergado ? [] : scope,
      target: target.trim() || null,
      screenshotDataUrl: screenshot,
    });
    setSaving(false);
    if (res.ok) {
      // discontinueCardAction always returns the written card on success; this fallback
      // is defensive only and MIRRORS what the server persisted (today's openedAt; the
      // screenshot lives in the sidecar) so the optimistic card can't contradict disk.
      onDone(
        res.data?.card ?? {
          ...card,
          mode: "retire",
          status: goesToExecutor ? "descontinuar" : "arquivados",
          refinement: null,
          bugReport: null,
          retirement: {
            brief: b,
            disposition,
            level: effectiveLevel,
            scope: isPostergado ? [] : scope,
            target: target.trim() || null,
            screenshot: card.retirement?.screenshot ?? null,
            fromStatus: card.status ?? null,
            dataDeletionApproved: false,
            openedAt: new Date().toISOString().slice(0, 10),
          },
        },
      );
    } else {
      setError(res.error);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 dark:bg-zinc-500/10 px-2 py-1 text-xs font-bold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
              <Archive className="h-3.5 w-3.5" /> Descontinuar
            </span>
            <span className="truncate text-sm font-medium text-fg-muted">{card.title}</span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-fg-subtle transition hover:bg-surface-hover hover:text-fg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="board-scroll flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <div className="flex items-start gap-2 rounded-lg border border-zinc-200 dark:border-zinc-500/30 bg-zinc-50/60 dark:bg-zinc-500/10 px-3 py-2.5 text-[12px] leading-snug text-zinc-800 dark:text-zinc-200">
            <Archive className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" />
            <span>
              Tira esta story da aplicação e a guarda como <strong>lápide</strong> no Arquivo. Se houver um{" "}
              <strong>nível de remoção</strong>, o agente diagnostica o código real e remove a feature — pausando antes
              de apagar dados de produção. Sem nível (ou postergado), só arquiva — e o que era postergado pode voltar.
            </span>
          </div>

          <div>
            <Label>Motivo (por que sair e até onde remover)</Label>
            <textarea
              autoFocus
              value={brief}
              onChange={(e) => {
                setError(null);
                setBrief(e.target.value);
              }}
              rows={4}
              placeholder="Ex.: o mural de salvos não engajou; vamos focar no feed. Tira do ar mas guarda os dados 30 dias antes de excluir."
              className={cn(inputCls, "resize-y leading-relaxed")}
            />
          </div>

          {/* Disposição — WHY it's leaving (drives the graveyard chip + reversibility). */}
          <div>
            <Label>Disposição</Label>
            <div className="flex flex-wrap gap-1.5">
              {DISPOSITIONS.map((d) => {
                const active = disposition === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => pickDisposition(d.id)}
                    title={d.short}
                    style={active ? { backgroundColor: d.color } : undefined}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
                      active
                        ? "text-white"
                        : "bg-surface-hover text-fg-muted hover:bg-surface-hover hover:text-fg-muted",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                    {d.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] leading-snug text-fg-muted">
              {DISPOSITIONS.find((d) => d.id === disposition)?.short}
            </p>
          </div>

          {/* Nível + escopo — only when there's live/WIP code to cut (not postergado). */}
          {!isPostergado && (
            <>
              <div>
                <Label>Nível de remoção</Label>
                <div className="space-y-1.5">
                  <LevelOption
                    label="Nada a remover — só arquivar"
                    short="Nunca foi construído (ou não há código a tocar); vai direto para o Arquivo."
                    active={level == null}
                    onClick={() => setLevel(null)}
                  />
                  {REMOVAL_LEVELS.map((l) => (
                    <LevelOption
                      key={l.id}
                      label={l.name}
                      short={l.short}
                      destructive={!l.reversible}
                      active={level === l.id}
                      onClick={() => setLevel(l.id)}
                    />
                  ))}
                </div>
              </div>

              {level != null && (
                <div>
                  <Label>Escopo (o que tocar)</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {REMOVAL_SCOPES.map((s) => {
                      const active = scope.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleScope(s.id)}
                          title={s.short}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
                            active
                              ? "bg-zinc-700 text-white dark:bg-zinc-600"
                              : "bg-surface-hover text-fg-muted hover:bg-surface-hover hover:text-fg-muted",
                          )}
                        >
                          {active && <Check className="h-3 w-3" />}
                          {s.name}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-fg-muted">
                    Marque as superfícies que o agente deve remover. Pode deixar vazio — o agente infere do diagnóstico.
                  </p>
                </div>
              )}

              {isDestructive && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/10 px-3 py-2.5 text-[12px] leading-snug text-red-800 dark:text-red-200">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500 dark:text-red-400" />
                  <span>
                    “Excluir tudo” apaga <strong>dados de produção</strong> — irreversível. O agente remove o código
                    (reversível via git) e <strong>pausa</strong>; o corte de dados só roda depois que você clicar{" "}
                    <strong>“Aprovar exclusão de dados”</strong> no card.
                  </span>
                </div>
              )}
            </>
          )}

          <div>
            <Label>Alvo (rota/feature) — opcional</Label>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="ex.: /perfil/salvos ou “mural de salvos no perfil”"
              className={inputCls}
            />
          </div>

          <div>
            <Label>Screenshot do estado atual — opcional</Label>
            {screenshot ? (
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot}
                  alt="estado atual"
                  className="h-16 w-16 rounded-md border border-line object-cover"
                />
                <button
                  type="button"
                  onClick={() => setScreenshot(null)}
                  className="text-xs font-medium text-fg-muted underline hover:text-zinc-600"
                >
                  remover
                </button>
              </div>
            ) : (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-sm text-fg-muted transition hover:border-line-emphasis hover:bg-surface-hover">
                <ImagePlus className="h-4 w-4" />
                Anexar imagem
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
              </label>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-6 mb-1 flex items-start gap-2 rounded-md border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1 leading-snug">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !brief.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-700 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-600 disabled:opacity-50"
          >
            {goesToExecutor ? <Trash2 className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            {saving ? "Enviando…" : goesToExecutor ? "Enviar para remoção" : "Arquivar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LevelOption({
  label,
  short,
  active,
  destructive,
  onClick,
}: {
  label: string;
  short: string;
  active: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition",
        active
          ? destructive
            ? "border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10"
            : "border-zinc-400 bg-zinc-50 dark:border-zinc-500/50 dark:bg-zinc-500/10"
          : "border-line hover:bg-surface-hover",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          active
            ? destructive
              ? "border-red-500 bg-red-500"
              : "border-zinc-600 bg-zinc-600"
            : "border-line",
        )}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-[13px] font-semibold",
            destructive ? "text-red-700 dark:text-red-300" : "text-fg-muted",
          )}
        >
          {label}
        </span>
        <span className="block text-[11px] leading-snug text-fg-muted">{short}</span>
      </span>
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </div>
  );
}
