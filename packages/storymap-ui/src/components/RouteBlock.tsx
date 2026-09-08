"use client";

// Fase 4.2 — "Rota": the drawer block that makes a card's per-instance ROUTE (which dispensable steps it
// skips, model/effort caps, why, who decided) VISIBLE and editable — before this, the whole routing surface
// lived only in YAML/MCP. Self-contained (its own setCardRouteAction, like PriorityBlock) because `routing` is
// pipeline-owned (a normal drawer save rejects it). Picking a board routeProfile MATERIALIZES its skips/caps
// on the card (the runner reads routing.skips/caps directly, never the profile name — the server action does
// the union). Load-bearing steps (plano/dev/review/QA) are shown LOCKED — never skippable.

import { useState } from "react";
import { AlertTriangle, Loader2, Route, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { setCardRouteAction } from "@/app/actions";
import { isDispensable, isLoadBearing, resolveRouteProfile } from "@/lib/storymap/skip-routing";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const inputSm =
  "rounded-md border border-line bg-inset px-2 py-1 text-[12px] text-fg outline-none transition focus:border-accent";

export function RouteBlock({
  boardId,
  card,
  config,
  onSaved,
}: {
  boardId: string;
  card: Card;
  config: BoardConfig;
  onSaved: (card: Card) => void;
}) {
  const profiles = config.routeProfiles ?? {};
  const hasProfiles = Object.keys(profiles).length > 0;
  const routing = card.routing ?? null;

  const nameOf = (id: string) => config.statuses.find((s) => s.id === id)?.name ?? id;
  // the toggleable (dispensable) steps + the locked (load-bearing) ones, in board order.
  const dispensableSteps = config.statuses.filter((s) => isDispensable(s));
  const lockedSteps = config.statuses.filter((s) => isLoadBearing(s.id));

  const [editing, setEditing] = useState(false);
  const [skips, setSkips] = useState<Set<string>>(new Set(routing?.skips ?? []));
  const [profile, setProfile] = useState<string>(routing?.profile ?? "");
  const [rationale, setRationale] = useState<string>(routing?.rationale ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const startEdit = () => {
    setSkips(new Set(routing?.skips ?? []));
    setProfile(routing?.profile ?? "");
    setRationale(routing?.rationale ?? "");
    setError(null);
    setNote(null);
    setEditing(true);
  };

  // Picking a profile SEEDS the skip toggles from its materialized skips (preview) — the human can still
  // adjust; the server unions the profile's skips regardless.
  const onPickProfile = (name: string) => {
    setProfile(name);
    const resolved = resolveRouteProfile(name || undefined, profiles);
    if (resolved) setSkips(new Set(resolved.skips));
  };

  const toggle = (id: string) =>
    setSkips((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await setCardRouteAction({
      boardId,
      cardId: card.id,
      skips: [...skips],
      profile: profile || undefined,
      rationale: rationale.trim() || undefined,
    });
    setBusy(false);
    if (res.ok && res.data) {
      onSaved(res.data.card);
      if (res.data.note) setNote(res.data.note);
      setEditing(false);
    } else {
      setError(res.ok ? "Falhou." : res.error);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
          <Route className="h-3 w-3" />
          Rota
        </span>
        {routing && (
          <span className="text-[10px] text-fg-subtle">
            {routing.decidedBy === "human" ? "definida por você" : routing.decidedBy === "agent" ? "definida pelo agente" : "regras"}
            {routing.decidedAt ? ` · ${routing.decidedAt}` : ""}
          </span>
        )}
      </div>

      {!editing ? (
        <div className="space-y-1.5 text-[12px] leading-snug">
          {routing ? (
            <>
              {routing.profile && (
                <p className="text-fg">
                  <span className="text-fg-subtle">Perfil: </span>
                  <span className="font-medium">{routing.profile}</span>
                </p>
              )}
              <p className="text-fg">
                <span className="text-fg-subtle">Pula: </span>
                {routing.skips.length ? routing.skips.map(nameOf).join(" · ") : <span className="text-fg-subtle">nenhum step</span>}
              </p>
              {(routing.modelCap || routing.effortCap) && (
                <p className="text-fg-muted">
                  <span className="text-fg-subtle">Tetos: </span>
                  {[routing.modelCap && `modelo ≤ ${routing.modelCap}`, routing.effortCap && `esforço ≤ ${routing.effortCap}`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {routing.rationale && (
                <p className="text-fg-muted">
                  <span className="text-fg-subtle">Por quê: </span>
                  {routing.rationale}
                </p>
              )}
            </>
          ) : (
            <p className="text-fg-subtle">Rota completa (padrão) — nenhum step pulado.</p>
          )}
          <button
            type="button"
            onClick={startEdit}
            className="text-[11px] font-medium text-fg-muted underline underline-offset-2 transition hover:text-fg"
          >
            Editar rota
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {hasProfiles && (
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-fg-muted">Perfil</span>
              <select value={profile} onChange={(e) => onPickProfile(e.target.value)} className={cn(inputSm, "w-full")}>
                <option value="">— (rota manual)</option>
                {Object.entries(profiles).map(([name, p]) => (
                  <option key={name} value={name}>
                    {name}
                    {p.description ? ` — ${p.description}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="space-y-1">
            <span className="text-[11px] font-medium text-fg-muted">Pular steps (só dispensáveis)</span>
            <div className="space-y-1">
              {dispensableSteps.length === 0 && <p className="text-[11px] text-fg-subtle">Nenhum step dispensável neste board.</p>}
              {dispensableSteps.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-[12px] text-fg">
                  <input type="checkbox" checked={skips.has(s.id)} onChange={() => toggle(s.id)} className="h-3.5 w-3.5" />
                  {s.name}
                </label>
              ))}
              {lockedSteps.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-[12px] text-fg-subtle" title="Step load-bearing (plano/dev/review/QA) — obrigatório, nunca pulado.">
                  <input type="checkbox" checked={false} disabled className="h-3.5 w-3.5" />
                  {s.name} <span className="text-[10px] uppercase tracking-wide">· obrigatório</span>
                </div>
              ))}
            </div>
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-fg-muted">Por quê (opcional)</span>
            <input
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Ex.: mudança trivial, sem UI — rota express."
              className={cn(inputSm, "w-full")}
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[11px] font-semibold text-surface transition hover:bg-fg/85 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Salvar rota
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md px-2.5 py-1 text-[11px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {note && <p className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">{note}</p>}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="flex-1 leading-snug">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
