// Fase 5.2 — PURE origin classifier for a board-config entry (a routeProfile / specialist / toolConfig id).
// The resolved BoardConfig collapses the _base template and the board's own delta into ONE Record keyed by id
// (repo.ts mergeRawConfig), so origin is NOT recoverable from the merged value — it must be computed by
// comparing the id against the KEYS of each raw source. The config page reads both raws server-side (the
// board's own board.yaml + _base/board.yaml) and passes the key sets here. Node-unit-testable (no IO).

export type ConfigOrigin =
  /** defined only in the board's own board.yaml — board-specific. */
  | "board"
  /** present in BOTH the board's own raw and _base — the board OVERRIDES the inherited default. */
  | "base-override"
  /** present only in _base — inherited unchanged (a restart-cached template edit surfaces here). */
  | "base-inherited";

/**
 * Classify where an entry came from. `ownRawKeys` = keys of the board's OWN raw section (pre-merge);
 * `baseKeys` = keys of the _base section. An id absent from the own raw is inherited from _base; present in
 * both is an override; present only in own raw is board-specific. For an opt-out board (inheritPipeline:false)
 * that owns e.g. routeProfiles outright, pass an EMPTY baseKeys so everything reads as "board".
 */
export function classifyOrigin(id: string, ownRawKeys: ReadonlySet<string>, baseKeys: ReadonlySet<string>): ConfigOrigin {
  if (!ownRawKeys.has(id)) return "base-inherited";
  return baseKeys.has(id) ? "base-override" : "board";
}

/** True when the origin is _base (inherited or overridden) — the process-cached template edge the UI flags
 *  as "definições do _base podem exigir restart" for the same-mtime-rewrite case. */
export function isBaseOrigin(origin: ConfigOrigin): boolean {
  return origin === "base-inherited" || origin === "base-override";
}
