// toolkit.ts — PURE + isomorphic resolution of a step's declarative toolkit facet (WS3 / F2) into the
// concrete mounts / expectations / guidance the runner consumes. NO IO (existence checks + warns live in
// the engine shell), no Date/random — trivially node-unit-testable and safe in the client bundle. The
// `{board}`/`{repoRoot}` templates in a toolConfig's mount path are expanded here.

import type { BoardConfig, StatusDef, ToolConfigDef, ToolExpectCondition, ToolExpectLevel } from "./types";
import { isDispensable, isLoadBearing } from "./skip-routing";

/** Max guidance length — protects the compaction-proof system prompt (re-emitted every turn) from inflating. */
export const TOOLKIT_GUIDANCE_MAX = 300;

/** Result of {@link lintToolkit}: ERRORS are hard drift (a typo'd toolConfig ref, bloated guidance) that a
 *  board-integrity test fails on; WARNINGS are advisory (a mcp mount not on disk — a consumer may plug it
 *  in later) that only log. */
export interface ToolkitLintResult {
  errors: string[];
  warnings: string[];
}

/**
 * WS3 (F2) — LINT a board's toolkit facets. PURE (existence checks are injected, never done here):
 *  - ERROR: a `toolkit.use[i]` / `toolkit.expect[i].tool` referencing a toolConfig id that doesn't exist.
 *  - ERROR: `guidance` longer than {@link TOOLKIT_GUIDANCE_MAX}.
 *  - WARN (advisory, opt-in via `mcpExists`): a toolConfig `mcp` mount that isn't on disk — the consumer
 *    can plug it in later, so it never errors. `{board}`/`{repoRoot}` are expanded before the check.
 * Binary-preflight (does the `command` inside the mcp JSON exist on the host?) is a documented v1-deferred
 * advisory — host-dependent, so it lives in ops tooling, not this pure lint.
 */
export function lintToolkit(
  config: Pick<BoardConfig, "id" | "statuses" | "toolConfigs" | "routeProfiles" | "specialists">,
  opts?: {
    mcpExists?: (relPath: string) => boolean;
    /** WS4 — injected existence check for `.claude/agents/<slug>.md`; drives the specialist WARN. */
    agentExists?: (slug: string) => boolean;
    boardId?: string;
    repoRoot?: string;
  },
): ToolkitLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const toolConfigs = config.toolConfigs ?? {};
  const knownIds = new Set(Object.keys(toolConfigs));
  const boardId = opts?.boardId ?? config.id;
  const repoRoot = opts?.repoRoot ?? ".";
  const statusById = new Map(config.statuses.map((s) => [s.id, s]));
  const specialistIds = new Set(Object.keys(config.specialists ?? {}));
  for (const s of config.statuses) {
    // WS4 — a load-bearing step must never be marked dispensable (defense-in-depth over the kernel guard).
    if (s.dispensable === true && isLoadBearing(s.id)) {
      errors.push(`step "${s.id}": dispensable:true num passo LOAD-BEARING (nunca pode ser pulado pela rota)`);
    }
    const tk = s.toolkit;
    if (!tk) continue;
    const referenced = [...(tk.use ?? []), ...(tk.expect ?? []).map((e) => e.tool)];
    for (const id of referenced) {
      if (!knownIds.has(id)) errors.push(`step "${s.id}": toolkit referencia toolConfig inexistente "${id}"`);
    }
    // WS4 — a toolkit.specialists id must resolve to a registered specialist.
    for (const id of tk.specialists ?? []) {
      if (!specialistIds.has(id)) errors.push(`step "${s.id}": toolkit.specialists referencia specialist inexistente "${id}"`);
    }
    if (tk.guidance && tk.guidance.length > TOOLKIT_GUIDANCE_MAX) {
      errors.push(`step "${s.id}": toolkit.guidance tem ${tk.guidance.length} chars (> ${TOOLKIT_GUIDANCE_MAX} — infla o system prompt)`);
    }
  }
  // WS4 — every routeProfile.skips entry must be a REAL, DISPENSABLE, non-load-bearing step.
  for (const [name, prof] of Object.entries(config.routeProfiles ?? {})) {
    for (const id of prof.skips ?? []) {
      const st = statusById.get(id);
      if (!st) errors.push(`routeProfile "${name}": skip "${id}" não é um step do board`);
      else if (isLoadBearing(id)) errors.push(`routeProfile "${name}": skip "${id}" é LOAD-BEARING (nunca pode ser pulado)`);
      else if (!isDispensable(st)) errors.push(`routeProfile "${name}": skip "${id}" não é dispensável`);
    }
  }
  if (opts?.mcpExists) {
    for (const [id, tc] of Object.entries(toolConfigs)) {
      if (!tc.mcp) continue;
      const resolved = expandToolkitTemplate(tc.mcp, boardId, repoRoot);
      if (!opts.mcpExists(resolved)) {
        warnings.push(`toolConfig "${id}": mcp "${resolved}" não existe no disco (advisory — consumidor pode plugar depois)`);
      }
    }
  }
  // ── CAPABILITY CONTRACT lints ────────────────────────────────────────────────────────────────────
  // These are ERRORS, not warnings, on purpose. The failure they prevent is the one that motivated the
  // whole facet: a capability that LOOKS provisioned, is gated on, and can never be satisfied — the
  // "declared capability with zero producers" anti-pattern. A build that fails is cheap; a card wedged
  // in a column while a run burns US$6 rediscovering the same missing binary is not.
  for (const [id, tc] of Object.entries(toolConfigs)) {
    if (tc.fallback) {
      const target = toolConfigs[tc.fallback];
      if (!target) {
        errors.push(`toolConfig "${id}": fallback aponta para toolConfig inexistente "${tc.fallback}"`);
      } else if ((target.provides ?? tc.fallback) !== (tc.provides ?? id)) {
        errors.push(
          `toolConfig "${id}": fallback "${tc.fallback}" provê "${target.provides ?? tc.fallback}", ` +
            `mas "${id}" provê "${tc.provides ?? id}" — um fallback tem de ser INTERCAMBIÁVEL (mesma capacidade)`,
        );
      }
    }
    if (tc.probeTimeoutMs != null && !(Number.isFinite(tc.probeTimeoutMs) && tc.probeTimeoutMs > 0)) {
      errors.push(`toolConfig "${id}": probeTimeoutMs deve ser um inteiro positivo (ms)`);
    }
  }
  // Fallback CYCLES — walked per config so the error names the entry point the operator has to edit.
  for (const id of Object.keys(toolConfigs)) {
    const seen = new Set<string>();
    let cur: string | undefined = id;
    while (cur && toolConfigs[cur]) {
      if (seen.has(cur)) {
        errors.push(`toolConfig "${id}": ciclo de fallback (${[...seen].join(" → ")} → ${cur})`);
        break;
      }
      seen.add(cur);
      cur = toolConfigs[cur].fallback;
    }
  }
  // EXHAUSTIVENESS OF PRODUCERS: every capability a step declares as `required` must have at least one
  // provider that can be PROVED on a host (a `probe`). Without it the step gates on a promise — and the
  // audit that already existed (`toolGap`) was structurally blind to exactly this case, because the QA
  // step declared its browser through the legacy `mcpConfig` sugar, leaving `expects` empty: 396 of 397
  // telemetry records carried a null gap. The lint is about the PRODUCER existing — never about anyone
  // having used it (that is the runtime audit's job, and a capability nobody used is not a defect).
  for (const s of config.statuses) {
    for (const e of s.toolkit?.expect ?? []) {
      if (e.level !== "required") continue;
      if (!knownIds.has(e.tool)) continue; // already reported above as an unknown ref
      const chain = providerChain(e.tool, toolConfigs, boardId, repoRoot);
      if (!chain.some((p) => p.probe)) {
        errors.push(
          `step "${s.id}": exige a capacidade "${toolConfigs[e.tool].provides ?? e.tool}" (expect level=required) ` +
            `mas NENHUM provedor da cadeia (${chain.map((p) => p.id).join(" → ") || e.tool}) declara \`probe\` — ` +
            `capacidade DECLARADA sem produtor verificável`,
        );
      }
    }
  }
  // WS4 — a specialist's agent slug SHOULD resolve to `.claude/agents/<slug>.md` — advisory (a consumer
  // may add the agent later), never an error.
  if (opts?.agentExists) {
    for (const [id, sp] of Object.entries(config.specialists ?? {})) {
      if (!opts.agentExists(sp.agent)) {
        warnings.push(`specialist "${id}": agent ".claude/agents/${sp.agent}.md" não existe no checkout (advisory)`);
      }
    }
  }
  return { errors, warnings };
}

/** One resolved expectation: the toolConfig id, its level, and the `match` regex (from the board's
 *  toolConfigs) used to classify whether the run exercised it. `match` may be absent (a config with no
 *  classifier — then it can't be audited, so it never trips a gap). */
export interface ResolvedExpectation {
  tool: string;
  level: ToolExpectLevel;
  match?: string;
}

/** WS4 — a step's specialist id resolved against the board's `specialists` registry: the opaque id + the
 *  agent slug to delegate to + when to engage it. The engine composes these into the Task-delegation note
 *  (filtering the slug against SAFE_SLUG). An id with no registry entry is DROPPED at resolution. */
export interface ResolvedSpecialist {
  id: string;
  agent: string;
  when: string;
}

/**
 * The concrete, engine-ready shape a step's toolkit resolves to. PURE data — the engine turns
 * `mcpConfigPaths` into `--mcp-config` flags (after existence-filtering), `allowedTools` into
 * `--allowedTools`, `guidance` into the system-prompt toolkitNote, and `expects` into the capability
 * audit / telemetry `toolGap`.
 */
export interface ResolvedToolkit {
  /** repo-relative MCP config paths to mount (`{board}`/`{repoRoot}` already expanded), DEDUPED, in
   *  order. Combines `toolkit.use[]`'s toolConfigs.mcp with the legacy `mcpConfig` (absorbed as sugar). */
  mcpConfigPaths: string[];
  /** hard ACI allow-list (`toolkit.allowedTools`) — empty = no `--allowedTools` flag. */
  allowedTools: string[];
  /** the composed usage guidance (`toolkit.guidance` + a v1 informational CLI hint) or undefined. */
  guidance?: string;
  /** WS4 — specialists this step may delegate to, RESOLVED against the board registry (id → agent + when).
   *  Unknown ids are dropped here; the engine filters the agent slug against SAFE_SLUG at compose. */
  specialists: ResolvedSpecialist[];
  /** per-tool expectations joined with their `match` regex — drives the capability audit + toolGap. */
  expects: ResolvedExpectation[];
}

/** Expand the `{board}` / `{repoRoot}` templates in a mount path. Pure. */
export function expandToolkitTemplate(s: string, boardId: string, repoRoot: string): string {
  return s.replace(/\{board\}/g, boardId).replace(/\{repoRoot\}/g, repoRoot);
}

/**
 * Resolve a step's toolkit against the board's toolConfigs. PURE — no IO. Fail-open: an unknown `use`
 * id (or a config with no `mcp`) contributes no mount; the legacy `mcpConfig` is absorbed as a plain
 * mount (the "sugar" back-compat → byte-identical flags downstream). Templated `{board}`/`{repoRoot}`
 * are expanded; paths are DEDUPED preserving first-seen order (a step that both `use`s codegraph and
 * carries the same legacy path mounts it once).
 */
export function resolveToolkit(
  def: Pick<StatusDef, "mcpConfig" | "toolkit"> | null | undefined,
  config: Pick<BoardConfig, "toolConfigs" | "specialists"> | null | undefined,
  boardId: string,
  repoRoot: string,
): ResolvedToolkit {
  const toolConfigs = config?.toolConfigs ?? {};
  const specialistRegistry = config?.specialists ?? {};
  const tk = def?.toolkit;
  const paths: string[] = [];
  const push = (p: string | undefined) => {
    if (!p) return;
    const expanded = expandToolkitTemplate(p, boardId, repoRoot).trim();
    if (expanded && !paths.includes(expanded)) paths.push(expanded);
  };
  // toolkit.use → each toolConfig's mcp mount (templated).
  for (const id of tk?.use ?? []) push(toolConfigs[id]?.mcp);
  // legacy mcpConfig — absorbed as sugar (a mount with no expect/match), so flags stay byte-identical.
  push(def?.mcpConfig);

  const expects: ResolvedExpectation[] = (tk?.expect ?? []).map((e) => {
    const match = toolConfigs[e.tool]?.match;
    return { tool: e.tool, level: e.level, ...(match ? { match } : {}) };
  });

  // guidance: the step's own line + a v1 INFORMATIONAL CLI hint from any use'd toolConfig with a `cli`
  // (CLIs aren't classified as used — Bash calls aren't reliably attributable in toolsUsed).
  const clis = (tk?.use ?? []).map((id) => toolConfigs[id]?.cli).filter((c): c is string => !!c);
  const parts: string[] = [];
  if (tk?.guidance) parts.push(tk.guidance);
  if (clis.length) parts.push(`CLIs deste passo: ${clis.join(", ")}.`);
  const guidance = parts.length ? parts.join(" ") : undefined;

  // WS4 — resolve the step's specialist ids against the board registry (id → agent + when). An id with no
  // registry entry is DROPPED (fail-open + agnostic: storymap-ui never invents an agent name). The engine
  // filters the agent slug against SAFE_SLUG when composing the delegation note.
  const specialists: ResolvedSpecialist[] = (tk?.specialists ?? [])
    .map((id) => {
      const entry = specialistRegistry[id];
      return entry ? { id, agent: entry.agent, when: entry.when } : null;
    })
    .filter((s): s is ResolvedSpecialist => s != null);

  return {
    mcpConfigPaths: paths,
    allowedTools: tk?.allowedTools ?? [],
    ...(guidance ? { guidance } : {}),
    specialists,
    expects,
  };
}

// ── CAPABILITY CONTRACT (declare → prove → degrade) ──────────────────────────────────────────────────
// The lesson the `chrome-devtools` incident taught: the engine existence-filtered the mount FILE and
// treated "a JSON is on disk" as "the capability works". It did not. The MCP server handshook fine while
// every tool call failed for want of a Chrome binary, and the run burned 89 turns / US$6 discovering it
// AFTER booting a dev stack and seeding an emulator. A capability is only real when something PROVED it
// on THIS host — so `provides`/`probe`/`fallback` make that a declared, testable contract instead of an
// assumption. Everything here is PURE: the probe EXECUTION (and its cache) lives in runner/capability-probe.

/** One provider of a capability, resolved from the board's toolConfigs. Ordered by the fallback chain. */
export interface CapabilityProvider {
  /** the toolConfig id. */
  id: string;
  /** the capability it provides (`ToolConfigDef.provides`). */
  capability: string;
  /** the shell command that proves it works on this host — absent = UNPROVABLE. */
  probe?: string;
  probeTimeoutMs?: number;
  /** the mount this provider contributes when it is the ACTIVE one (already template-expanded). */
  mcp?: string;
  description?: string;
  /** this provider works OUTSIDE the run's Bash sandbox — under containment it cannot reach anything the
   *  run creates inside a call. A DECLARATION (see {@link ToolConfigDef.outsideRunSandbox}), not a probe:
   *  reachability belongs to the call's topology, not to the host, so no probe can answer it. */
  outsideRunSandbox?: boolean;
}

/** Max providers followed down a `fallback` chain — a cycle is a lint ERROR, this is the runtime backstop
 *  so a malformed board can never spin the resolver. */
const MAX_FALLBACK_DEPTH = 8;

/**
 * Follow a toolConfig's `fallback` chain into an ORDERED provider list (primary first). PURE and
 * cycle-safe: a repeated id ends the walk (the lint reports the cycle as an ERROR; the resolver simply
 * stops). An id with no toolConfig entry contributes nothing. `{board}`/`{repoRoot}` are expanded.
 */
export function providerChain(
  startId: string,
  toolConfigs: Record<string, ToolConfigDef> | undefined,
  boardId: string,
  repoRoot: string,
): CapabilityProvider[] {
  const configs = toolConfigs ?? {};
  const out: CapabilityProvider[] = [];
  const seen = new Set<string>();
  let id: string | undefined = startId;
  while (id && !seen.has(id) && out.length < MAX_FALLBACK_DEPTH) {
    seen.add(id);
    const tc: ToolConfigDef | undefined = configs[id];
    if (!tc) break;
    out.push({
      id,
      capability: tc.provides ?? id,
      // `{board}`/`{repoRoot}` expand in the probe exactly as they do in the mount — a per-board provider
      // (e.g. a per-board code graph) must be able to prove the artifact THIS board actually uses.
      ...(tc.probe ? { probe: expandToolkitTemplate(tc.probe, boardId, repoRoot) } : {}),
      ...(tc.probeTimeoutMs ? { probeTimeoutMs: tc.probeTimeoutMs } : {}),
      ...(tc.mcp ? { mcp: expandToolkitTemplate(tc.mcp, boardId, repoRoot) } : {}),
      ...(tc.description ? { description: tc.description } : {}),
      ...(tc.outsideRunSandbox ? { outsideRunSandbox: true } : {}),
    });
    id = tc.fallback;
  }
  return out;
}

/**
 * The capabilities a step REQUIRES — the ones whose absence must stop the run BEFORE it spawns rather
 * than be discovered mid-run. That is the `expect` entries at `required` level ONLY: `expected` is the
 * softer "should have used it" audit and is never probed (see {@link ToolExpectLevel}). PURE.
 *
 * Returns one entry per REQUIRED toolConfig id, each with its resolved provider chain, so the caller can
 * probe them in order and mount whichever wins.
 */
export function expectationApplies(when: ToolExpectCondition | undefined, ctx: CapabilityCardContext): boolean {
  if (!when) return true;
  if (when === "uiSurface") return ctx.uiSurface === true;
  return true; // unknown condition (forward-compat) — never NARROWS silently
}

/** The card facts a conditional expectation reads. Passed IN (not derived here) so this module stays pure
 *  and the canonical `hasUiSurface` ruling — evidence-first, declaration-fallback — has exactly one home
 *  (gate-core), rather than a second, drifting copy. */
export interface CapabilityCardContext {
  uiSurface?: boolean;
}

export function requiredCapabilities(
  def: Pick<StatusDef, "toolkit"> | null | undefined,
  toolConfigs: Record<string, ToolConfigDef> | undefined,
  boardId: string,
  repoRoot: string,
  ctx: CapabilityCardContext = {},
): { tool: string; capability: string; providers: CapabilityProvider[] }[] {
  const out: { tool: string; capability: string; providers: CapabilityProvider[] }[] = [];
  for (const e of def?.toolkit?.expect ?? []) {
    if (e.level !== "required") continue;
    if (!expectationApplies(e.when, ctx)) continue;
    const providers = providerChain(e.tool, toolConfigs, boardId, repoRoot);
    // A required entry with NO provable provider is a board defect, not a runtime state — the
    // exhaustiveness lint fails the build on it. Here we simply carry what exists (fail-open at runtime:
    // an unprovable requirement can't be enforced, so it must never block a spawn).
    if (!providers.some((p) => p.probe)) continue;
    out.push({ tool: e.tool, capability: providers[0]?.capability ?? e.tool, providers });
  }
  return out;
}

/** The minimal shape {@link applyActiveProviders} / {@link buildCapabilityNote} need from a resolution —
 *  declared here (rather than importing the runner's type) so this module stays pure and client-safe. */
export interface ActiveProviderChoice {
  /** the toolConfig id the step declared (the chain head). */
  tool: string;
  capability: string;
  /** the provider that proved out — never null here (an unresolved capability blocks before this point). */
  active: Pick<CapabilityProvider, "id" | "mcp" | "description">;
}

/**
 * DEGRADE, the third leg of the contract: swap the mounts of any capability whose ACTIVE provider is not
 * the chain head. PURE.
 *
 * Concretely: the step declares `browser` (mounting the chrome-devtools MCP); its probe fails; the chain's
 * fallback is a script-based provider with no mount at all. Then the chrome mount must be REMOVED — mounting
 * a server whose tools all fail is strictly worse than not mounting it (the agent sees the tools, tries
 * them, and burns turns on errors; "a tool you can SEE but cannot USE is worse than an absent one" is the
 * lesson flags.ts already records about inherited MCP).
 */
export function applyActiveProviders(
  mcpConfigPaths: readonly string[],
  choices: readonly ActiveProviderChoice[],
  toolConfigs: Record<string, ToolConfigDef> | undefined,
  boardId: string,
  repoRoot: string,
): string[] {
  const configs = toolConfigs ?? {};
  const drop = new Set<string>();
  const add: string[] = [];
  for (const c of choices) {
    if (c.active.id === c.tool) continue; // primary won → nothing to swap
    const headMount = configs[c.tool]?.mcp;
    if (headMount) drop.add(expandToolkitTemplate(headMount, boardId, repoRoot));
    if (c.active.mcp) add.push(c.active.mcp);
  }
  const out = mcpConfigPaths.filter((p) => !drop.has(p));
  for (const p of add) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * The system-prompt clause telling the run WHICH provider is live for each required capability. Without
 * it the degrade is invisible: the skill's prose names a tool ("drive the chrome-devtools MCP") that may
 * not be mounted this run, and the agent burns turns hunting for it — which is precisely how the incident's
 * run spent 5+ ToolSearch attempts on a server that could never answer. Returns null when nothing is
 * required or every primary won (no note = no noise on the 99% path). PURE.
 */
export function buildCapabilityNote(choices: readonly ActiveProviderChoice[]): string | null {
  const swapped = choices.filter((c) => c.active.id !== c.tool);
  if (!swapped.length) return null;
  const lines = swapped.map((c) => {
    const how = c.active.description ? ` — ${c.active.description}` : "";
    return `"${c.capability}": use o provedor \`${c.active.id}\`${how} (o provedor primário \`${c.tool}\` NÃO passou no teste neste host e NÃO está montado).`;
  });
  return (
    `CAPACIDADES DESTE RUN — provedor ativo por capacidade (verificado neste host antes do spawn): ${lines.join(" ")} ` +
    `Siga o provedor ATIVO mesmo que o texto da skill nomeie o primário: a skill descreve a capacidade, ` +
    `esta nota diz por onde ela está disponível agora.`
  );
}

/**
 * Re-point each expectation's `match` classifier at the provider that is ACTUALLY live this run.
 *
 * Without this the audit lies whenever a fallback wins: the expectation carries the PRIMARY's classifier
 * (`^mcp__chrome-devtools__`), the run legitimately used the fallback (a script, evidenced only as `Bash`),
 * and the toolGap would stamp "capacidade provisionada mas não usada" on every card — a false anomaly, the
 * one failure mode {@link computeToolGap} is explicitly written to avoid. An active provider with NO
 * classifier is DROPPED from the audit (unverifiable ⇒ never a gap), same fail-open rule. PURE.
 */
export function expectsForActiveProviders(
  expects: readonly ResolvedExpectation[],
  choices: readonly ActiveProviderChoice[],
  toolConfigs: Record<string, ToolConfigDef> | undefined,
): ResolvedExpectation[] {
  const configs = toolConfigs ?? {};
  const activeById = new Map(choices.map((c) => [c.tool, c.active.id]));
  const out: ResolvedExpectation[] = [];
  for (const e of expects) {
    const activeId = activeById.get(e.tool);
    if (!activeId || activeId === e.tool) {
      out.push(e);
      continue;
    }
    const match = configs[activeId]?.match;
    if (match) out.push({ ...e, match });
    // else: the live provider can't be classified → omit (never counted as a gap)
  }
  return out;
}

/**
 * WS3 — compute the toolGap: the toolConfig ids at `expected` level whose `match` regex found NO
 * evidence in the run's `toolsUsed`. PURE. An expected config with NO match regex can't be verified, so
 * it is NOT counted (fail-open — never a false anomaly). `advisory`/`off` levels never contribute. A
 * malformed match regex is skipped, not thrown. Drives the SOFT `tooling-unused` finding + the durable
 * `TelemetryRecord.toolGap`.
 */
export function computeToolGap(expects: ResolvedExpectation[], toolsUsed: readonly string[]): string[] {
  const gap: string[] = [];
  for (const e of expects) {
    // `required` audits like `expected` here: having PROVED a capability available and then not touching
    // it is the same soft signal either way (it never blocks — the preflight is what enforces presence).
    if ((e.level !== "expected" && e.level !== "required") || !e.match) continue;
    let re: RegExp;
    try {
      re = new RegExp(e.match);
    } catch {
      continue; // a malformed match regex never trips the audit (fail-open)
    }
    if (!toolsUsed.some((t) => re.test(t))) gap.push(e.tool);
  }
  return gap;
}
