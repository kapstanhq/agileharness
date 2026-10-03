// Pipeline EVIDENCE an agent session writes on MAIN through MCP — `add_finding` and `set_tasks`.
//
// Why these exist: the gates are evaluated against MAIN's card (`checkGate` in moveCardAction), and a conductor
// session writes its code in its own worktree. Before these tools, the only way for a finding or the task list
// to reach main was a data-only merge-train checkpoint — legal only while the branch carried no code, so a
// budget/verification finding found MID-BUILD, or the task list the build gate (`hasBuildEvidence`/`hasTasks`)
// reads, had no road to main until the final submit. Both go through the service's single writer
// (updateCardOnDisk — the per-card lock), never through a file edit on the runtime checkout.
//
// PURE — the server actions (app/actions.ts) own the IO and the containment (set_tasks requires the caller to
// hold the card's live claim: the task list is build EVIDENCE, and "mark it done" without owning the work is
// the trust-me stamp `mark_tasks_done` was retired for).

import { CORE_LENS_IDS, FINDING_SEVERITIES } from "./types";
import type { Finding, FindingSeverity, ReviewLens, Task } from "./types";

export interface AddFindingInput {
  severity: FindingSeverity;
  title: string;
  detail?: string;
  lens?: ReviewLens;
  /**
   * As lentes que ESTE alvo aceita para escrever um finding (as embutidas + as de `target.reviewLenses`), resolvidas pela
   * porta que conhece o alvo (a tool `add_finding`). Ausente ⇒ só as embutidas: o alvo que não declara nada nunca
   * recebe uma lente de domínio que a ferramenta inventou. Não é gravado no finding.
   */
  lenses?: ReadonlySet<string>;
  /** a STABLE id makes the call idempotent (`conductor-budget`); absent ⇒ a fresh `<lens>-<n>` is minted. */
  id?: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

/** A recusa de uma lente fora do conjunto: lista as válidas e diz exatamente onde declarar uma nova. */
export function undeclaredLensError(lens: string, declared: readonly string[]): string {
  return `lente "${lens}" não declarada — as válidas: ${declared.join(", ")}. Para uma lente nova, declare em storymap/settings.yaml → target.reviewLenses.${/^[a-z][a-z0-9-]{0,31}$/.test(lens) ? lens : "<id>"} (name e description), ou use "general".`;
}

/**
 * The card's findings with `input` added — or, when `input.id` names an existing finding, that finding's
 * CONTENT refreshed (severity/title/detail/…) with its STATUS untouched: triage (`triage_finding`) owns the
 * status, and a re-add must never silently reopen what a human closed. `changed: false` ⇒ nothing to write.
 * PURE.
 */
export function addOrRefreshFinding(
  existing: Finding[],
  input: AddFindingInput,
): { ok: true; findings: Finding[]; id: string; created: boolean; changed: boolean } | { ok: false; error: string } {
  const title = input.title?.trim();
  if (!title) return { ok: false, error: "finding sem título" };
  if (!(FINDING_SEVERITIES as readonly string[]).includes(input.severity)) {
    return { ok: false, error: `severity inválida "${input.severity}" — use ${FINDING_SEVERITIES.join(" | ")}` };
  }
  const lens: ReviewLens = input.lens ?? "general";
  const allowed = input.lenses ?? new Set<string>(CORE_LENS_IDS);
  if (!allowed.has(lens)) return { ok: false, error: undeclaredLensError(lens, [...allowed]) };
  if (input.id != null && !ID_RE.test(input.id)) return { ok: false, error: `id inválido "${input.id}" (letras, dígitos, . _ : -; até 80)` };

  const content = {
    lens,
    severity: input.severity,
    title,
    ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
    ...(input.file?.trim() ? { file: input.file.trim() } : {}),
    ...(typeof input.line === "number" && Number.isFinite(input.line) ? { line: Math.floor(input.line) } : {}),
    ...(input.suggestion?.trim() ? { suggestion: input.suggestion.trim() } : {}),
  };

  const cur = input.id ? existing.find((f) => f.id === input.id) : undefined;
  if (cur) {
    const next: Finding = {
      id: cur.id,
      ...content,
      status: cur.status,
      ...(cur.failureClass ? { failureClass: cur.failureClass } : {}),
      ...(cur.statusBy ? { statusBy: cur.statusBy } : {}),
      ...(cur.statusAt ? { statusAt: cur.statusAt } : {}),
    };
    const changed = JSON.stringify(next) !== JSON.stringify(cur);
    return { ok: true, findings: changed ? existing.map((f) => (f.id === cur.id ? next : f)) : existing, id: cur.id, created: false, changed };
  }

  let id = input.id;
  if (!id) {
    const taken = new Set(existing.map((f) => f.id));
    let n = existing.filter((f) => f.id.startsWith(`${lens}-`)).length + 1;
    while (taken.has(`${lens}-${n}`)) n += 1;
    id = `${lens}-${n}`;
  }
  return { ok: true, findings: [...existing, { id, ...content, status: "open" }], id, created: true, changed: true };
}

/**
 * Why a task list is malformed — or null. PURE. Ids non-empty and unique (they are the element identity the
 * merge train's per-element 3-way merges tasks by — a duplicate would make two tasks one), titles non-empty,
 * `done` a boolean, at most 50 tasks (a story, not a backlog).
 */
export function tasksError(tasks: Array<Partial<Task>>): string | null {
  if (tasks.length > 50) return `${tasks.length} tasks — no máximo 50 (uma story, não um backlog)`;
  const seen = new Set<string>();
  for (const t of tasks) {
    const id = typeof t.id === "string" ? t.id.trim() : "";
    if (!id) return "task sem id";
    if (seen.has(id)) return `task id duplicado "${id}"`;
    seen.add(id);
    if (!(typeof t.title === "string" && t.title.trim())) return `task "${id}" sem título`;
    if (typeof t.done !== "boolean") return `task "${id}": done precisa ser true/false`;
  }
  return null;
}

/** The normalized task list (trimmed). PURE; call {@link tasksError} first. */
export function normalizeTasks(tasks: Array<Pick<Task, "id" | "title" | "done">>): Task[] {
  return tasks.map((t) => ({ id: t.id.trim(), title: t.title.trim(), done: t.done }));
}
