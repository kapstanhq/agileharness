"use client";

// Per-column automation POLICY controls (model / effort / max-turns / cost guard).
// Shared by the Config panel (the read-only summary + global defaults) and the
// Kanban column header (the inline popover that edits a single StatusDef). Editing
// here patches the StatusDef; the parent persists the whole board.yaml.

import { useState } from "react";
import { Cpu } from "lucide-react";
import { EFFORT_LEVELS, MODEL_TIERS } from "@/lib/storymap/types";
import type { EffortLevel, ModelTier, StatusDef } from "@/lib/storymap/types";

const selectCls =
  "rounded-md border border-line bg-inset px-2 py-1 text-xs text-fg-muted outline-none transition focus:border-accent";

export function ModelSelect({
  value,
  onChange,
  inherit,
}: {
  value?: ModelTier;
  onChange: (v: ModelTier | undefined) => void;
  inherit?: string;
}) {
  return (
    <select
      className={selectCls}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || undefined) as ModelTier | undefined)}
    >
      <option value="">{inherit ? `herda (${inherit})` : "herda"}</option>
      {MODEL_TIERS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

export function EffortSelect({
  value,
  onChange,
  inherit,
}: {
  value?: EffortLevel;
  onChange: (v: EffortLevel | undefined) => void;
  inherit?: string;
}) {
  return (
    <select
      className={selectCls}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || undefined) as EffortLevel | undefined)}
    >
      <option value="">{inherit ? `herda (${inherit})` : "herda"}</option>
      {EFFORT_LEVELS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

/**
 * Inline popover to edit one column's automation policy. `onChange` receives a
 * partial StatusDef (a cleared field arrives as `undefined`, so the parent must
 * delete it before persisting to keep board.yaml clean).
 */
export function ColumnPolicyPopover({
  def,
  onChange,
  defaults,
}: {
  def: StatusDef;
  onChange: (patch: Partial<StatusDef>) => void;
  defaults?: { model?: string; effort?: string };
}) {
  const [open, setOpen] = useState(false);
  // Code skills write product code + run tests → costGuard watchdog applies.
  const isCodeSkill = def.trigger === "harness-do" || def.trigger === "harness-review";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Modelo / effort desta coluna"
        className="inline-flex h-5 shrink-0 items-center rounded bg-surface-hover px-1.5 text-fg-muted transition hover:bg-surface-hover hover:text-fg-muted"
      >
        <Cpu className="h-3 w-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-[70] mt-1 w-56 rounded-lg border border-line bg-surface p-2.5 shadow-lg">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Policy · {def.trigger}</p>
            <Row label="Modelo">
              <ModelSelect value={def.model} inherit={defaults?.model} onChange={(model) => onChange({ model })} />
            </Row>
            <Row label="Effort">
              <EffortSelect value={def.effort} inherit={defaults?.effort} onChange={(effort) => onChange({ effort })} />
            </Row>
            <Row label="Máx turns">
              <input
                type="number"
                min={1}
                value={def.maxTurns ?? ""}
                placeholder="—"
                onChange={(e) =>
                  onChange({ maxTurns: e.target.value === "" ? undefined : Math.max(1, Number(e.target.value) || 1) })
                }
                className="w-16 rounded-md border border-line px-1.5 py-1 text-xs outline-none focus:border-accent"
              />
            </Row>
            {isCodeSkill && (
              <label className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked={def.costGuard === true}
                  onChange={(e) => onChange({ costGuard: e.target.checked ? true : undefined })}
                />
                Guard-rail de tempo (watchdog)
              </label>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <span className="text-xs text-fg-muted">{label}</span>
      {children}
    </div>
  );
}
