// orchestrator-state.ts — WS8 (F7) — DURABLE state for the board copiloto: per-board budget (so a daily cap
// survives restarts) + a LEASE that arbitrates paired-human ↔ autonomous-tick (only one drives at a time).
// Lives at storymap/.runner/orchestrator/<board>.json. Best-effort IO: every read/write fails OPEN (a missing
// or corrupt file → a fresh default state) so a state hiccup never bricks the copiloto or the board.
//
// PURE helpers (budgetOk / leaseHeldByHuman / applyTick / applyLease) are separated from the IO so the tick's
// decision logic stays unit-testable without a filesystem. Date is read via an injectable `now` for tests.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { OrchestratorMode, OrchestratorSettings } from "@/lib/storymap/types";
import { AUTONOMO_DOCTRINE_VERSION } from "@/lib/storymap/copilot/tier";

/** Who holds the board's lease: a `paired` human session or the `tick` (autonomous). */
export type LeaseOwner = "paired" | "tick";

/**
 * autonomy-endgame WS-4.2 — a per-item give-up, WITH the doctrine it was taken under.
 *
 * A streak is not just a count: it is a decision the tick took under a rule. When that rule is REVOKED, the
 * decision is not a decision any more — it is a residue. Carrying `doctrine` is what lets the backoff expire
 * for the ONE reason that is legitimate (§{@link AUTONOMO_DOCTRINE_VERSION}) while staying permanent for
 * every reason that is not.
 */
export interface NoopStreak {
  /** how many attempts this item absorbed without its own progress */
  streak: number;
  /** the {@link AUTONOMO_DOCTRINE_VERSION} in force when the streak was last written. `"pre"` = a legacy
   *  `number` entry, written before the doctrine had a version — which is never equal to the current one, so
   *  those items re-arm exactly once. */
  doctrine: string;
  /**
   * deploy-recovered — the WORLD FACT observed when the tick gave up on this item (today: whether the card's
   * deploy was PROVEN, by the same ruler that stamps "No ar"). It is the BASELINE, and the baseline is the
   * whole point: the steward re-arms on the EDGE (`false → true`), never on the LEVEL. A level ("the face
   * carries the release") was measured TRUE at all three give-ups of the incident that motivated this — it
   * discriminates nothing. Absent = never observed ⇒ the first observation only WRITES it, never re-arms.
   */
  observed?: { deployProven: boolean };
  /**
   * deploy-recovered — the steward already spent this item's ONE machine re-arm UNDER THIS DOCTRINE. The cap
   * is not weakened, it is re-issued when the doctrine changes ({@link bumpOne} drops this along with the rest
   * of the memory) — the same bound exit #4 already accepts. Its presence is what makes an oscillating fact
   * cost at most one spawn per item per doctrine version.
   */
  rearmedByStewardAt?: string;
}

/** Coerce a persisted entry (legacy `number` OR the current shape) into a {@link NoopStreak}. Tolerant on
 *  purpose (the serializer footgun this file already warns about): a legacy `2` means "streak 2, under a
 *  doctrine that predates versioning" — which is precisely the state the fix must rescue, not discard. */
export function coerceNoopStreak(raw: unknown): NoopStreak | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return { streak: raw, doctrine: "pre" };
  if (raw && typeof raw === "object") {
    const o = raw as { streak?: unknown; doctrine?: unknown; observed?: unknown; rearmedByStewardAt?: unknown };
    if (typeof o.streak === "number" && Number.isFinite(o.streak)) {
      const out: NoopStreak = {
        streak: o.streak,
        doctrine: typeof o.doctrine === "string" && o.doctrine ? o.doctrine : "pre",
      };
      // 5.5 GOTCHA, per-entry edition: a field NOT whitelisted here is dropped on EVERY read — which for
      // `observed` would mean the baseline is re-written as "never observed" forever (and the steward could
      // never see an EDGE), and for `rearmedByStewardAt` would mean the one-re-arm cap silently resets each
      // read. The two fields are the memory the whole edge-detector rests on; coercion is conservative (an
      // unreadable value is DROPPED, never guessed — a missing baseline is fail-closed by construction).
      const observed = o.observed as { deployProven?: unknown } | undefined;
      if (observed && typeof observed === "object" && typeof observed.deployProven === "boolean") {
        out.observed = { deployProven: observed.deployProven };
      }
      if (typeof o.rearmedByStewardAt === "string" && o.rearmedByStewardAt) out.rearmedByStewardAt = o.rearmedByStewardAt;
      return out;
    }
  }
  return null; // junk → the item simply has no streak (fail-open: it stays actionable)
}

/** Coerce the whole persisted map. Junk entries are dropped, never guessed. */
export function coerceNoopByItem(raw: unknown): Record<string, NoopStreak> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, NoopStreak> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = coerceNoopStreak(v);
    if (s) out[id] = s;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface OrchestratorState {
  v: 1;
  /** the last mode the copiloto ran under (informational). */
  mode?: OrchestratorMode;
  /** ISO ts of the last tick that acted. */
  lastTickAt?: string;
  /** 3.5a — the RESULT of the LAST tick (whether it acted or stood down, and WHY), so the chat/cockpit can
   *  say what the autonomous copiloto did last — e.g. "rodei há 20min e não havia trabalho". Skip reasons
   *  were previously discarded (only the `ran` path persisted anything). Wake: `costUSD`/`summary`/`exitCode`/
   *  `endedAt` são carimbados quando o PROCESSO termina (applyRunResult), não quando ele nasce. */
  lastTick?: {
    at: string;
    outcome: "ran" | "skipped";
    reason?: string;
    spawnedPid?: number;
    /** custo REAL do run (total_cost_usd do `--output-format json`), cobrado no budget do dia. */
    costUSD?: number;
    /** o texto final do Jido — "o que ele fez" em uma frase, p/ a UI e o chat. */
    summary?: string;
    exitCode?: number | null;
    endedAt?: string;
  };
  /** per-DAY budget counters (reset when `day` rolls over). */
  budget: { day: string; ticksToday: number; costToday: number; pushesToday: number };
  /** WS-4.1 — TWO INDEPENDENT lease slots. A single slot conflated two facts that can be true AT THE SAME
   *  TIME (a human is paired AND an autonomous run is still in flight), so every write clobbered the other —
   *  the TOCTOU race + the lost anti-two-copilotos trava. `pairedLease`: a human has the chat open → the tick
   *  does NOT spawn while it's live. `tickLease`: an autonomous run is in flight → nothing else spawns for
   *  this board while it's live. Each write touches ONLY its own slot. The legacy single `lease` is migrated
   *  into the matching slot on read (readOrchestratorState). */
  pairedLease?: { expiresAt: string } | null;
  tickLease?: { expiresAt: string } | null;
  /** 6.4 — anti-noop backoff state: the actionable-work signature of the last tick that SPAWNED, and how many
   *  consecutive spawns saw that SAME signature (no board progress). A run that moves the board resets the
   *  streak; a stuck loop grows it → the tick backs off. Absent on legacy state (treated as no streak). */
  noop?: { workSig?: string; ranStreak: number };
  /** WS-5.4 — PER-ITEM anti-noop streak: `{actionableItemId → consecutive TRIES that left it where it was}`.
   *  The global `noop.workSig` above resets on ANY board churn (a new run/conflict changes the joined-ids
   *  signature), so one stuck item can be re-spawned forever while the rest of the board moves. This per-item
   *  counter is IMMUNE to that churn: an item that reached the cap ({@link PER_ITEM_NOOP_MAX}) leaves the tick's
   *  actionable set (it stays on Inbox for the human). An item that DISAPPEARS from the actionable set (it
   *  progressed/resolved) is pruned on the next bump → its streak resets. Absent on legacy state.
   *  WS-12 (D16) — a TRY, not a spawn: the counter grows via {@link bumpNoopByAttempt} on the run's RESULT, only
   *  for items whose card the run actually mutated (deterministic, from the guard's ledger). It reads the same
   *  either way; what changed is who gets counted. Re-armable: {@link clearNoopItem}.
   *  autonomy-endgame WS-4.2 — the streak now carries the DOCTRINE it was taken under, because a give-up
   *  decided under a rule that no longer exists is not a give-up, it is a residue. A legacy `number` coerces
   *  to `{streak: n, doctrine: "pre"}` on read, and `"pre"` never equals the live version — so the items
   *  stuck today re-arm themselves on the first tick after deploy. The migration IS the rescue. */
  noopByItem?: Record<string, NoopStreak>;
  /** 5.5 — per-HOUR count of AUTO-executed guarded tool calls (anti-runaway). When the count hits
   *  policy.maxActionsPerHour the guard degrades an `auto` call to `ask`. Rolls over when the hour changes. */
  actions?: { hourKey: string; count: number };
  /** Circuit breaker for ABORTIVE spawns — runs that were born and died WITHOUT ever looking at the board
   *  (exit≠0 AND $0). They are a DEFECT, not work: charging them to the daily tick budget let 19 crashes eat
   *  a whole day of autonomy on 2026-07-13 while the copiloto told the operator "parei por budget" — the one
   *  message that guarantees nobody investigates. The streak resets on any run that actually executed. */
  failures?: { streak: number; lastAt: string; reason?: string };
}

/** The hour bucket key (UTC YYYY-MM-DDTHH) for the rate limiter. PURE. */
export function hourKey(now: number): string {
  return new Date(now).toISOString().slice(0, 13);
}

const todayStr = (now: number) => new Date(now).toISOString().slice(0, 10);

/** A fresh default state for `board` (used when the file is absent/corrupt). PURE. */
export function emptyOrchestratorState(now: number): OrchestratorState {
  // WS-4.1: no lease slots set → both pairedLease/tickLease are undefined (= no lease held).
  return { v: 1, budget: { day: todayStr(now), ticksToday: 0, costToday: 0, pushesToday: 0 } };
}

/** Roll the budget over to today if the stored day is stale (zeroes the counters). PURE. */
export function rolloverBudget(state: OrchestratorState, now: number): OrchestratorState {
  const day = todayStr(now);
  if (state.budget.day === day) return state;
  return { ...state, budget: { day, ticksToday: 0, costToday: 0, pushesToday: 0 } };
}

/** Is the board within its daily budget (ticks + cost)? PURE — rolls over stale days first. */
export function budgetOk(state: OrchestratorState, settings: OrchestratorSettings, now: number): boolean {
  const s = rolloverBudget(state, now);
  const b = settings.budget;
  if (!b) return true;
  return s.budget.ticksToday < b.maxTicksPerDay && s.budget.costToday < b.maxCostPerDay;
}

/** Is a PAIRED human lease currently active (not expired)? While true, the autonomous tick stands down. PURE. */
export function leaseHeldByHuman(state: OrchestratorState, now: number): boolean {
  return state.pairedLease != null && new Date(state.pairedLease.expiresAt).getTime() > now;
}

/** Apply a tick to the budget (increment ticks + add cost) + stamp lastTickAt/mode. PURE. `workSig` (6.4) is
 *  the actionable-work signature this spawn saw: passing it grows the anti-noop streak while the board doesn't
 *  change and resets it to 1 when it does; omitting it (legacy callers/tests) leaves the noop state untouched. */
export function applyTick(
  state: OrchestratorState,
  now: number,
  mode: OrchestratorMode,
  costUSD = 0,
  workSig?: string,
): OrchestratorState {
  const s = rolloverBudget(state, now);
  const at = new Date(now).toISOString();
  // 6.4 — consecutive spawns with an UNCHANGED signature = the copiloto isn't making progress → grow the
  // streak so the tick can back off; a changed signature (real progress) resets it to 1.
  const ranStreak = workSig !== undefined && workSig === s.noop?.workSig ? (s.noop?.ranStreak ?? 0) + 1 : 1;
  return {
    ...s,
    mode,
    lastTickAt: at,
    lastTick: { at, outcome: "ran" }, // 3.5a — the ran path also records the outcome for the chat/cockpit
    budget: { ...s.budget, ticksToday: s.budget.ticksToday + 1, costToday: s.budget.costToday + costUSD },
    ...(workSig !== undefined ? { noop: { workSig, ranStreak } } : {}),
  };
}

/**
 * 3.5a — stamp the RESULT of a tick that did NOT act (skipped/no-work/leased/budget/error) WITHOUT touching
 * the budget: a stand-down must never consume the daily cap. The `ran` path uses {@link applyTick} instead
 * (which also increments the budget). PURE — exported for tests.
 */
export function applyTickOutcome(
  state: OrchestratorState,
  now: number,
  outcome: "ran" | "skipped",
  reason?: string,
  spawnedPid?: number,
): OrchestratorState {
  return { ...state, lastTick: { at: new Date(now).toISOString(), outcome, reason, spawnedPid } };
}

/** 5.5 — is the board UNDER its hourly auto-action cap right now? A fresh hour is always within limit. When no
 *  cap is configured (undefined/≤0) the limiter is disabled (always within). PURE. */
export function rateWithinLimit(state: OrchestratorState, maxPerHour: number | undefined, now: number): boolean {
  if (!maxPerHour || maxPerHour <= 0) return true;
  const key = hourKey(now);
  if (state.actions?.hourKey !== key) return true; // rolled to a new hour → counter is effectively 0
  return state.actions.count < maxPerHour;
}

/** 5.5 — record ONE auto-executed guarded action, rolling the hour bucket over when it changes. PURE. */
export function applyAction(state: OrchestratorState, now: number): OrchestratorState {
  const key = hourKey(now);
  const count = state.actions?.hourKey === key ? state.actions.count + 1 : 1;
  return { ...state, actions: { hourKey: key, count } };
}

/** WS-5.4 — how many spawns an actionable item may absorb (without its own progress) before it leaves the
 *  tick's actionable set. 2 = "the copiloto gets two tries per item, then it's the human's". */
export const PER_ITEM_NOOP_MAX = 2;

/**
 * WS-5.4 — grow the PER-ITEM anti-noop streak for EVERY id given, and PRUNE any item no longer actionable (its
 * streak resets to absent): ids still present carry their prior streak + 1; ids dropped from `actionableIds`
 * (the item progressed/resolved) are simply not re-added. Rebuilding the map from the set is what makes
 * progress reset the streak with zero extra bookkeeping.
 *
 * WS-12 (D16) — this is now the BUMP-ALL primitive, reached only for the TRUE no-op (a run that mutated
 * nothing with work in sight) via {@link bumpNoopByAttempt}, which is the sole caller in the tick. Calling it
 * directly bumps by PRESENCE — the colisão #7 defect. PURE — exported for tests.
 */
export function bumpNoopByItem(state: OrchestratorState, actionableIds: string[]): OrchestratorState {
  if (actionableIds.length === 0) {
    // A spawn with no actionable ids leaves nothing to track — drop the whole map (all items resolved).
    if (!state.noopByItem) return state;
    const { noopByItem: _drop, ...rest } = state;
    return rest;
  }
  const next: Record<string, NoopStreak> = {};
  // WS-4.2: a bump under a DIFFERENT doctrine restarts the count — the item is getting its quota of tries
  // under the NEW rule, which is the whole point of re-arming. Same doctrine ⇒ the streak grows as always.
  for (const id of actionableIds) next[id] = bumpOne(state.noopByItem?.[id], 1);
  return { ...state, noopByItem: next };
}

/** WS-4.2 — grow (or restart) ONE streak, stamping the doctrine in force. A prior streak taken under another
 *  doctrine does not carry over: it was a decision under a rule that no longer exists. PURE. */
function bumpOne(prior: NoopStreak | undefined, by: 0 | 1): NoopStreak {
  const sameDoctrine = prior?.doctrine === AUTONOMO_DOCTRINE_VERSION;
  const base = sameDoctrine ? prior.streak : 0;
  const next: NoopStreak = { streak: base + by, doctrine: AUTONOMO_DOCTRINE_VERSION };
  // deploy-recovered — the bump REBUILDS the map (`const next = {}`), so anything not carried here is
  // ANNIHILATED on the next tick, in two call-sites. That is what killed the previous design: a baseline
  // written at give-up time would be gone before the fact ever had a chance to change. Under the SAME
  // doctrine the memory rides along; when the doctrine CHANGES it is dropped on purpose — exit #4 re-issues
  // the quota, and a re-issued quota with a stale "already re-armed" stamp would be no re-issue at all.
  if (sameDoctrine && prior) {
    if (prior.observed) next.observed = prior.observed;
    if (prior.rearmedByStewardAt) next.rearmedByStewardAt = prior.rearmedByStewardAt;
  }
  return next;
}

/**
 * deploy-recovered — record the WORLD FACT observed for an item that is in backoff, WITHOUT re-arming it.
 * The first observation of an item can only ever write this baseline: an edge needs two readings, and a
 * `measured === true` with no prior reading is a LEVEL (it may well have been true when the tick gave up —
 * it was, in the incident this exists for). PURE.
 *
 * An item with no entry gets one at `streak: 0` (below {@link PER_ITEM_NOOP_MAX}, so it is NOT in backoff):
 * recording a fact must never invent a give-up.
 */
export function markObservedFact(state: OrchestratorState, itemId: string, deployProven: boolean): OrchestratorState {
  const prior = state.noopByItem?.[itemId];
  const entry: NoopStreak = {
    ...(prior ?? { streak: 0, doctrine: AUTONOMO_DOCTRINE_VERSION }),
    observed: { deployProven },
  };
  return { ...state, noopByItem: { ...(state.noopByItem ?? {}), [itemId]: entry } };
}

/**
 * deploy-recovered (exit #3) — the STEWARD's re-arm: unblock the item WITHOUT forgetting it.
 *
 * {@link clearNoopItem} (the HUMAN's exit) deletes the entry — and with it the one-re-arm cap and the
 * observed baseline, so a machine re-arm through that door would be unbounded by construction (each re-arm
 * erasing the evidence that it happened). This writes `streak: 0` instead: the item leaves backoff
 * ({@link itemsInNoopBackoff} requires `>= PER_ITEM_NOOP_MAX`) while the memory survives.
 *
 * The human keeps the deleting door on purpose: a human re-arm owes the machine no accounting.
 * PURE.
 */
export function markStewardRearm(state: OrchestratorState, itemId: string, nowIso: string): OrchestratorState {
  const prior = state.noopByItem?.[itemId];
  const entry: NoopStreak = {
    streak: 0,
    doctrine: AUTONOMO_DOCTRINE_VERSION,
    ...(prior?.observed ? { observed: prior.observed } : {}),
    rearmedByStewardAt: nowIso,
  };
  return { ...state, noopByItem: { ...(state.noopByItem ?? {}), [itemId]: entry } };
}

/**
 * WS-12 (D16) — the bump, by ATTEMPT. Called on the run's RESULT (not on the spawn), against the items still
 * actionable at the END of the run. The rule, per item still in the set:
 *
 *   - the run mutated NOTHING on a board that HAD work ⇒ the true no-op (2026-07-15) ⇒ every item bumps
 *     (delegates to {@link bumpNoopByItem} — that behaviour is deliberately unchanged);
 *   - else, the item's CARD was attempted ⇒ tried and didn't move ⇒ +1;
 *   - else ⇒ never tried ⇒ streak UNCHANGED. Presence is not guilt (the colisão #7 fix).
 *
 * An item that left the set is pruned either way — the reset-by-progress of WS-5.4, intact.
 *
 * GRANULARITY: attribution is per CARD, not per item — the three items of one card (`x:approval`,
 * `x:deploy-failed`, `x:q:q2`) rise together when the card was attempted. It errs to the SAFE side (extra
 * backoff on a card genuinely tried, never less on one that wasn't) and asks no tool to carry an "item id"
 * that does not exist in the domain.
 *
 * PURE — `attempt` is derived from the ledger by deriveRunAttempt (noop-attribution.ts).
 */
export function bumpNoopByAttempt(
  state: OrchestratorState,
  items: ReadonlyArray<{ id: string; cardId: string }>,
  attempt: { anyMutation: boolean; attemptedCardIds: ReadonlySet<string> },
): OrchestratorState {
  const ids = items.map((i) => i.id);
  if (ids.length === 0 || !attempt.anyMutation) return bumpNoopByItem(state, ids);
  const next: Record<string, NoopStreak> = {};
  for (const item of items) {
    // "Presence is not guilt" (colisão #7), UNCHANGED: an item whose card was never attempted keeps its
    // streak. WS-4.2 only adds the doctrine stamp — via bumpOne, so a stamp under a new doctrine restarts
    // the count exactly as a re-arm should.
    next[item.id] = bumpOne(state.noopByItem?.[item.id], item.cardId && attempt.attemptedCardIds.has(item.cardId) ? 1 : 0);
  }
  return { ...state, noopByItem: next };
}

/**
 * WS-12.3 (D16) — RE-ARM one item: drop its streak so the tick tries it again. The second of the three exits
 * from backoff (the first is the item's own progress, which prunes it; the third is the steward with a PROVEN
 * change of fact — noop-rearm.ts owns who may call this). Absent id / empty map ⇒ no-op. PURE.
 */
export function clearNoopItem(state: OrchestratorState, itemId: string): OrchestratorState {
  if (state.noopByItem?.[itemId] === undefined) return state;
  const { [itemId]: _dropped, ...rest } = state.noopByItem;
  if (Object.keys(rest).length > 0) return { ...state, noopByItem: rest };
  const { noopByItem: _empty, ...withoutMap } = state; // último item re-armado → o mapa inteiro sai
  return withoutMap;
}

/**
 * WS-5.4 — the set of actionable item ids whose per-item streak has reached `threshold` (they've had their
 * quota of spawns without progress → the tick excludes them even under board churn).
 *
 * autonomy-endgame WS-4.3 — an item is in backoff only if its streak was taken under the DOCTRINE IN FORCE.
 * A give-up decided under a rule that no longer exists is not a give-up; it is a residue, and keeping it
 * would mean the rule written to decide those very items is never read against them (the state of `acme` on
 * 2026-07-17: autonomous, "nada acionável", with the item in plain sight).
 *
 * WHY THIS IS NOT A LOOP — the question the review will ask. The cap is not WEAKENED, it is RE-ISSUED. A
 * fixed doctrine ⇒ every item still gets exactly `PER_ITEM_NOOP_MAX` tries, FOREVER, byte-identical to today.
 * A NEW doctrine ⇒ two more tries, ONCE. Since the version is a hand-edited literal, the number of re-arms
 * per year is the number of times a human DECIDED to change the agent's behaviour — which is precisely when
 * retrying is the right thing to do.
 *
 * PURE — exported for tests.
 */
export function itemsInNoopBackoff(state: OrchestratorState, threshold: number = PER_ITEM_NOOP_MAX): Set<string> {
  const out = new Set<string>();
  for (const [id, entry] of Object.entries(state.noopByItem ?? {})) {
    if (entry.streak >= threshold && entry.doctrine === AUTONOMO_DOCTRINE_VERSION) out.add(id);
  }
  return out;
}

/** Acquire/renew a lease for `owner` expiring `ttlMs` from `now`. PURE. WS-4.1: writes ONLY the owner's
 *  slot (paired → pairedLease; tick → tickLease) — the other fact is never clobbered. */
export function applyLease(state: OrchestratorState, owner: LeaseOwner, now: number, ttlMs: number): OrchestratorState {
  const lease = { expiresAt: new Date(now + ttlMs).toISOString() };
  return owner === "paired" ? { ...state, pairedLease: lease } : { ...state, tickLease: lease };
}

/**
 * Wake — is a TICK run of this board still in flight (a live `tick` lease)? Simétrico de leaseHeldByHuman e a
 * trava que impede DOIS copilotos no mesmo board: antes o único spawn possível era o do timer (30min), então
 * uma corrida era teórica; com o wake por evento o timer e N eventos podem cair juntos. O tick pega o lease ao
 * spawnar e o solta quando o processo morre (applyRunResult) — o TTL é o backstop se o serviço cair no meio. PURE.
 */
export function leaseHeldByTick(state: OrchestratorState, now: number): boolean {
  return state.tickLease != null && new Date(state.tickLease.expiresAt).getTime() > now;
}

/** Quantas mortes ABORTIVAS seguidas abrem o breaker (o spawn está quebrado — pare de tentar). */
export const SPAWN_BREAKER_THRESHOLD = 3;
/** Cooldown da 1a abertura; dobra a cada morte extra (meia-abertura: 1 sonda por cooldown), até o teto. */
export const SPAWN_BREAKER_BASE_COOLDOWN_MS = 30 * 60_000;
export const SPAWN_BREAKER_MAX_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Um run ABORTIVO nasceu e morreu SEM olhar o board: exit≠0 E custo $0 (o `claude -p` nem chegou ao 1o turno —
 * binário ausente, token inválido, CLI recusando o ambiente…). É um DEFEITO, não trabalho — distinto de um run
 * que rodou, custou e falhou no meio (esse consumiu recurso de verdade e é cobrado). PURE.
 */
export function isAbortiveRun(result: { costUSD?: number; exitCode?: number | null }): boolean {
  const cost = Number.isFinite(result.costUSD) ? Math.max(0, result.costUSD as number) : 0;
  return (result.exitCode ?? 0) !== 0 && cost === 0;
}

/**
 * O breaker está ABERTO (não spawne)? Abre após {@link SPAWN_BREAKER_THRESHOLD} mortes abortivas seguidas e
 * fecha sozinho depois de um cooldown EXPONENCIAL — meia-abertura clássica: passado o cooldown, 1 sonda é
 * liberada; se ela morrer também, o streak cresce e o cooldown dobra (teto de 6h). Isso limita o desperdício a
 * ~1 spawn por cooldown em vez dos 20/dia que o incidente de 2026-07-13 queimou, e AINDA se auto-cura assim que
 * a causa é corrigida (a 1a sonda que sobreviver zera o streak). PURE.
 */
export function spawnBreakerOpen(state: OrchestratorState, now: number): boolean {
  const f = state.failures;
  if (!f || f.streak < SPAWN_BREAKER_THRESHOLD) return false;
  const over = f.streak - SPAWN_BREAKER_THRESHOLD; // 0, 1, 2, …
  const cooldown = Math.min(SPAWN_BREAKER_BASE_COOLDOWN_MS * 2 ** over, SPAWN_BREAKER_MAX_COOLDOWN_MS);
  return now - new Date(f.lastAt).getTime() < cooldown;
}

/**
 * O run do Jido TERMINOU: cobra o custo REAL no budget do dia, guarda o resumo do que ele fez, e SOLTA o
 * lease do tick. Antes o custo nunca era cobrado (o único caller passava costUSD=0 p/ applyTick), então
 * `maxCostPerDay` era um botão decorativo — só `maxTicksPerDay` limitava de fato. PURE.
 *
 * RESERVA-E-ACERTA (compensating transaction): o tick DEBITA um tick ao spawnar (reserva — impede estouro
 * enquanto o run está em voo), e aqui ESTORNAMOS essa reserva quando o run foi ABORTIVO (isAbortiveRun) — ele
 * nem chegou a olhar o board, então não é consumo. Sem o estorno, 19 spawns natimortos comeram os 20 ticks do
 * dia em 2026-07-13 e o Jido passou a responder "parei por budget" — uma mentira que escondeu o defeito.
 * O estorno sozinho seria um convite a crash-loop infinito, então ele vem SEMPRE em par com o breaker
 * ({@link spawnBreakerOpen}), que trava o board após 3 mortes seguidas e diz a VERDADE ao operador.
 */
export function applyRunResult(
  state: OrchestratorState,
  now: number,
  result: { costUSD?: number; summary?: string; exitCode?: number | null; failure?: string },
): OrchestratorState {
  const s = rolloverBudget(state, now);
  const costUSD = Number.isFinite(result.costUSD) ? Math.max(0, result.costUSD as number) : 0;
  // Um run que MORREU não é evidência de que não há trabalho — ele nem chegou a olhar o board. Contá-lo no
  // streak anti-noop faz o Jido se CALAR ("minhas últimas tentativas não moveram nada") exatamente quando
  // está quebrado: em 2026-07-13 o spawn morria no arranque (exit 1, $0) e o guard silenciou os ticks seguintes,
  // escondendo a falha atrás de uma mensagem que parecia sensatez. O streak mede COPILOTO QUE OLHOU E NÃO AGIU;
  // morte reseta. O gasto segue limitado pelo budget de ticks/dia — e agora a causa aparece no chat.
  const died = (result.exitCode ?? 0) !== 0;
  const abortive = isAbortiveRun(result);
  // Estorno da reserva: o tick nunca aconteceu. Piso em 0 — o estado é best-effort/fail-open, então um
  // applyRunResult sem o applyTick correspondente (estado corrompido, restart no meio) não pode ir a negativo.
  const ticksToday = abortive ? Math.max(0, s.budget.ticksToday - 1) : s.budget.ticksToday;
  // O breaker mede SÓ morte abortiva. Um run que executou (exit 0, ou exit≠0 tendo custado) prova que o spawn
  // funciona → zera o streak. Assim o breaker nunca trava por causa de um bug DENTRO do agente, só do arranque.
  const failures = abortive
    ? { streak: (s.failures?.streak ?? 0) + 1, lastAt: new Date(now).toISOString(), reason: result.failure }
    : undefined;
  return {
    ...s,
    budget: { ...s.budget, ticksToday, costToday: s.budget.costToday + costUSD },
    ...(died && s.noop ? { noop: { ...s.noop, ranStreak: 0 } } : {}),
    failures: failures ?? (s.failures ? { streak: 0, lastAt: s.failures.lastAt } : undefined),
    lastTick: {
      ...(s.lastTick ?? { at: new Date(now).toISOString(), outcome: "ran" as const }),
      costUSD,
      summary: result.summary,
      exitCode: result.exitCode ?? null,
      endedAt: new Date(now).toISOString(),
    },
    tickLease: null, // WS-4.1: o run do tick terminou → solta SÓ o tickLease; o pairedLease (humano) é intocado
  };
}

/** 6.4 — release the PAIRED lease (the human closed the chat). applyLease can only SET a lease, so a real
 *  release needs this: the autonomous tick resumes on the next tick once the paired lease is gone. WS-4.1:
 *  clears ONLY pairedLease — a tick run still in flight (tickLease) keeps blocking a second copiloto. PURE. */
export function releaseLease(state: OrchestratorState): OrchestratorState {
  return { ...state, pairedLease: null };
}

// ── IO (best-effort, fail-open) ────────────────────────────────────────────────
function statePath(board: string): string {
  return path.join(runnerStateDir(), "orchestrator", `${board.replace(/[^a-z0-9_-]/gi, "")}.json`);
}

/** Read the board's durable state, or a fresh default when absent/corrupt. Never throws. */
export async function readOrchestratorState(board: string, now = Date.now()): Promise<OrchestratorState> {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(board), "utf8"));
    if (raw && raw.v === 1 && raw.budget && typeof raw.budget.day === "string") {
      // 5.5 GOTCHA — a NEW state field MUST be whitelisted here or readOrchestratorState silently drops it every
      // read (same class as the cardToFrontmatter serializer footgun). `actions` (rate limiter) added.
      // WS-4.1 MIGRATION: a legacy single `lease {owner, expiresAt}` maps into the matching slot ONCE (then we
      // always persist the new shape); a state already on the new shape reads its slots directly.
      const legacy = raw.lease as { owner?: string; expiresAt?: string } | null | undefined;
      const pairedLease =
        raw.pairedLease ?? (legacy?.owner === "paired" && legacy.expiresAt ? { expiresAt: legacy.expiresAt } : null);
      const tickLease =
        raw.tickLease ?? (legacy?.owner === "tick" && legacy.expiresAt ? { expiresAt: legacy.expiresAt } : null);
      // WS-4.2 MIGRATION: `noopByItem` was `Record<string, number>`; a legacy entry is coerced to
      // `{streak: n, doctrine: "pre"}` HERE, on read. `"pre"` never equals the live doctrine version, so the
      // items given up on under the OLD rule come back to the actionable set on the first tick after deploy —
      // the migration IS the rescue (no script, no click).
      return { v: 1, mode: raw.mode, lastTickAt: raw.lastTickAt, lastTick: raw.lastTick, budget: raw.budget, pairedLease, tickLease, noop: raw.noop, noopByItem: coerceNoopByItem(raw.noopByItem), actions: raw.actions, failures: raw.failures };
    }
  } catch {
    /* absent/corrupt → default */
  }
  return emptyOrchestratorState(now);
}

/** Write the board's durable state. Best-effort — a write failure is swallowed (logged) and never throws. */
export async function writeOrchestratorState(board: string, state: OrchestratorState): Promise<void> {
  try {
    const p = statePath(board);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error(`[orchestrator-state ${board}] write falhou:`, err instanceof Error ? err.message : err);
  }
}
