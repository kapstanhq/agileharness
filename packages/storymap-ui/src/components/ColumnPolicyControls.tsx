"use client";

// Per-column automation POLICY controls (model / effort) — the selects of the Config panel (the read-only summary +
// global defaults). Editing here patches the StatusDef; the parent persists the whole board.yaml.

import { EFFORT_LEVELS, MODEL_TIERS } from "@/lib/storymap/types";
import type { EffortLevel, ModelTier } from "@/lib/storymap/types";

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

// (O popover por coluna — `ColumnPolicyPopover` — saiu na fase 1 com o cabeçalho de coluna do Kanban antigo; a política
// de cada coluna se edita no painel de Configuração, com os mesmos seletores.)
