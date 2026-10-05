import { isOwnerOnlyQuestion } from "./autonomy";
import { isReviewFinding } from "./review-finding";
import type { Card, CardQuestion } from "./types";

/**
 * Pipeline-owned fields the editor drawer must NEVER clobber on save.
 *
 * The drawer owns only the human-authored product fields (title, narrative,
 * acceptance, tasks, RICE/KANO/funnel, links, body, status, parent, release,
 * vocab). These fields, by contrast, are mutated by their OWN actions / harness-*
 * skills (chooseWireframeAction, updateFindingStatusAction, the plan/review/QA
 * runs, the reopen flows) and may have advanced AFTER the drawer loaded its
 * snapshot. Writing the stale draft verbatim would silently wipe them — e.g.
 * clobbering `wireframeChosen` right after a pick, which re-blocks the
 * hasWireframe gate (the shipped regression in storymap-drawer-pipeline-fields-clobber).
 *
 * This list is the single source of truth: adding a new pipeline-owned field to
 * the Card type means adding ONE entry here, and mergeCardOnSave preserves it.
 */
export const PIPELINE_OWNED_FIELDS = [
  "wireframeChosen",
  "findings",
  "techPlanReady",
  "reviewedAt",
  "reviewCommit",
  "qaPassed",
  "qaRanAt",
  "qaCommit",
  "mode",
  "refinement",
  "bugReport",
  "retirement",
  // Bug priority axes (Fase 2) — set by the triage agent / harness-fix, not the drawer.
  "frequency",
  "hasWorkaround",
  // Fase 4b staged release — set by the merge train (stagedAt) / release action (releasedAt).
  "stagedAt",
  "releasedAt",
  // Per-instance routing override — set by the deterministic skip rules / harness-refine, never the drawer.
  "routing",
  // Prioridade argumentada — set by /harness-prioritize or the bench's "Avaliar/Ajustar", never the drawer's
  // Save (a stale draft would wipe an agent/human-assessed priority — the same clobber class this guards).
  "priorityCall",
  // UI-surface flag — set by /harness-enrich (frontmatter-direct, mirrors priorityCall) and the regression
  // flip, never the drawer; preserving it from disk keeps a Save from wiping the QA-regime signal.
  "hasUiSurface",
  // Superfície MEDIDA pelo engine + o QUE o QA provou: o drawer não tem campo para nenhum dos dois,
  // então um draft carregado ANTES do carimbo os traria ausentes e o Save apagaria a evidência —
  // devolvendo o gate ao fallback por storyType, que é exatamente o vazamento que eles fecham.
  "uiSurfaceEvidence",
  "qaEvidence",
  // WS6 (F5) — provenance + unplaced-ack: set by the creation chokepoints / triage accept / backfill,
  // never the drawer; preserving them from disk keeps a Save from wiping the audit trail + the gate signal.
  "via",
  "unplacedAck",
  // acceptance→spec map — authored by harness-tests/harness-do, never the drawer; preserving it
  // from disk keeps a Save from wiping the shift-left signal the hasCriteriaSpecs gate reads.
  "criteriaSpecs",
  // storymap-parallel-work WS-5 — the `already-landed` build proof: stamped EXCLUSIVELY by the engine when
  // deltaLanded proves the card's delta is already in the run's base, and read by the hasBuildEvidence gate.
  // The drawer has no field for it, so a draft loaded BEFORE the stamp would carry it as absent and a Save
  // would WIPE the proof — re-deadlocking the very card the stamp just freed (the exact clobber class this
  // list exists for). Never re-derivable from the drawer: only content-proof mints it.
  "buildEvidence",
  // As classes do DONO que o card toca (decision-class.ts): quem as escreve é um juiz (a triagem, o condutor), com
  // o porquê. O drawer não tem campo para elas — um rascunho anterior à marca a apagaria no Save, e um card que
  // propõe gasto passaria a ser decidido pelo sistema.
  "businessClasses",
  // O veredito do juiz da triagem (triage/judge.ts): escrito pelo juiz sob o lock, lido pelo Inbox e pelo «Desfazer».
  "triageDecision",
  // As decisões registradas dos dilemas (recorded-decisions.ts): escritas pelo condutor/proxy e desfeitas pelo dono
  // por ação própria — nunca pelo drawer.
  "decisions",
  // A trilha de boards (card-transfer.ts): escrita só pela mudança de board, nunca pelo drawer — um rascunho anterior à
  // mudança a apagaria no Save.
  "transfers",
  // A marca de cadeia de conserto de revisão (runner/review-rounds.ts): só o servidor a grava, na criação do conserto.
  // O drawer não a mostra; o update_card do agente a recusa — sem isto um agente reescrevia a raiz e zerava o teto.
  "reviewChain",
] as const satisfies readonly (keyof Card)[];

/**
 * Merge a drawer draft over the on-disk card: the human-authored fields from the
 * draft win, but every pipeline-owned field is preserved from `prev` (disk truth).
 * When there is no prior card (a brand-new card), the draft is returned as-is.
 *
 * PURE — extracted from updateCardAction so the clobber regression is unit-testable.
 */
export function mergeCardOnSave(draft: Card, prev: Card | undefined): Card {
  if (!prev) return draft;
  const merged: Card = { ...draft };
  for (const field of PIPELINE_OWNED_FIELDS) {
    // The on-disk value wins for pipeline-owned fields (it may be undefined, which
    // matches "unset" — identical to the explicit field-by-field assignment).
    (merged as unknown as Record<string, unknown>)[field] = (prev as unknown as Record<string, unknown>)[field];
  }
  return merged;
}

/**
 * Fields the RUN owns on a BOTH-SIDES-CHANGED tiebreak in the merge-back 3-way (story-ex0120).
 * Superset of {@link PIPELINE_OWNED_FIELDS} (the drawer-clobber list) plus `tasks`: a merge-back run
 * ADVANCES the card through the pipeline (tasks flip `done`, the review/QA/findings stamps land), so when
 * the human ALSO edited that same field live on main the run's pipeline state wins. Every other (authorial)
 * field lets main's live human edit win.
 *
 * `status` NÃO está aqui, de propósito. Quando os DOIS lados mudaram o status, o lado de main
 * é sempre o mais NOVO e o mais honesto: em main o status só anda pelo moveCard (gate + salto no ledger) —
 * o dono, o MCP do condutor, o vigia, a reversão do deploy, a cascata de um merge anterior do mesmo card —,
 * e tudo isso aconteceu DEPOIS do corte do worktree. O status do run é a projeção de uma foto antiga.
 * Deixar o run vencer trazia o status do worktree por cima de um move_card posterior, e o arquivo passava a
 * contradizer o ledger (o move ficava registrado, o card voltava). O avanço do run continua aterrissando
 * quando main NÃO mexeu no status (só o run mudou ⇒ o run vence, regra geral do 3-way abaixo).
 */
export const MERGE_BACK_PIPELINE_FIELDS = [
  ...PIPELINE_OWNED_FIELDS,
  "tasks",
] as const satisfies readonly (keyof Card)[];

const MERGE_BACK_PIPELINE_SET: ReadonlySet<string> = new Set(MERGE_BACK_PIPELINE_FIELDS);

/**
 * Collections with ELEMENT IDENTITY — merged per `id` (3-way per element) instead of as an atomic field
 * whenever BOTH sides changed them (storymap-parallel-work WS-2).
 *
 * The field-level tiebreak above is right for a SCALAR (`status`, `title`): the value means one thing, so
 * one side has to win. It is WRONG for an array of independent facts: handing the whole `findings` array to
 * the run reverts every element the run NEVER TOUCHED. That reproduced in practice — a human closed
 * 2 `code-not-landed-*` blockers via triage on main while a `harness-review` run held a snapshot cut BEFORE the
 * closure; the run added ONE new finding, and the field-level tiebreak paid for that one addition by
 * reopening both closures. It mines the `hasNoBlockers` gate: the operator closes a blocker and it comes back.
 *
 * The elements here are independent facts keyed by a stable id, so "who wins" is answerable PER ELEMENT and
 * an untouched element never has to lose. This list is the single source of truth (the contract test reads
 * it): a new identified collection on the Card type means ONE entry here — and its elements MUST carry a
 * `id: string` in the CardSchema. `acceptance` (string[], no identity) legitimately stays field-level.
 */
export const ELEMENT_MERGED_FIELDS = [
  "findings",
  "questions",
  "tasks",
  // cada decisão registrada é um fato independente com id (d1, d2…): o condutor registra uma no worktree enquanto o
  // dono desfaz outra na main — nenhuma das duas pode reverter a outra.
  "decisions",
] as const satisfies readonly (keyof Card)[];

const ELEMENT_MERGED_SET: ReadonlySet<string> = new Set(ELEMENT_MERGED_FIELDS);

/** Order-independent structural equality over the JSON-shaped card field values (frontmatter + body). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * True when a value can be merged BY ELEMENT: absent, or an array whose every element carries a string
 * `id`. Guards the element path against a malformed/legacy value (a hand-edited card, a pre-identity
 * collection) — anything unrecognisable falls back to the field-level tiebreak, which is never worse than
 * today's behaviour. `null` is deliberately NOT accepted: it is not an identified collection, so it takes
 * the (unchanged) field path.
 */
function isIdentifiedCollection(value: unknown): value is { id: string }[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (el) => !!el && typeof el === "object" && typeof (el as { id?: unknown }).id === "string",
  );
}

/**
 * ELEMENT-LEVEL 3-way merge of a collection keyed by `id` (storymap-parallel-work WS-2, D5). PURE.
 * `base` = the collection at the run's fork point; `main` = on main NOW (live human/triage edits); `run` =
 * the collection the run advanced. Decided per element over the UNION of the three sides' ids, so a side
 * NEVER reverts an element it did not touch — the whole point (see {@link ELEMENT_MERGED_FIELDS}).
 *
 * Rules (the id is assumed to name the SAME fact on both sides — that assumption is what the provenance
 * suffix in `reviewFindingId` + the duplicate-id lint in board-integrity.test.ts protect):
 *   - untouched by both                  → keep base (via main's copy)
 *   - changed by ONE side only           → that side (the other never touched it → nothing to revert)
 *   - changed by BOTH (differently)      → RUN (the genuinely disputed element: the run IS the pipeline —
 *                                          the same tiebreak as the field path, now at the right grain)
 *   - removed by ONE side, untouched by  → removed (a unilateral delete stands, e.g.
 *     the other                            `withRunBlockersResolved` pruning, a human deleting a task)
 *   - removed by one, EDITED by the other → the EDIT wins (never delete what the other side just wrote;
 *                                          covers main-edited×run-removed → main, and its mirror)
 *   - created by ONE side only           → that side (e.g. the run's `fresh-review-*`)
 *   - created by BOTH under the same id  → RUN (an id collision resolves to the pipeline; the duplicate-id
 *                                          lint + provenance-suffixed ids keep this from being lossy)
 *
 * Order: main's order first (stable — the operator's reading order does not jump), then the run-only
 * elements appended in the run's order. No re-sort: the UI already sorts by severity where it matters.
 */
export function mergeIdentifiedArrayThreeWay<T extends { id: string }>(
  base: T[] | undefined,
  main: T[] | undefined,
  run: T[] | undefined,
): T[] {
  const index = (list: T[] | undefined) => new Map((list ?? []).map((el) => [el.id, el]));
  const b = index(base);
  const m = index(main);
  const r = index(run);

  /** The winning element for `id`, or undefined when the merge resolves to "not present". */
  const resolve = (id: string): T | undefined => {
    const bv = b.get(id);
    const mv = m.get(id);
    const rv = r.get(id);
    // Absent from base → a creation. Both created the same id ⇒ the run (the pipeline) wins.
    if (!bv) return rv ?? mv;
    // Present in base: "changed" includes REMOVED (absent on that side).
    const mainChanged = mv === undefined || !deepEqual(mv, bv);
    const runChanged = rv === undefined || !deepEqual(rv, bv);
    if (!runChanged) return mv; // the run left it at base → main decides (including main's delete)
    if (!mainChanged) return rv; // main left it at base → the run decides (including the run's delete)
    if (rv === undefined) return mv; // disputed, run deleted → main's edit survives (edit beats delete)
    return rv; // disputed (both edited, or main deleted × run edited) → the run
  };

  const merged: T[] = [];
  const emitted = new Set<string>();
  for (const el of main ?? []) {
    const win = resolve(el.id);
    if (win) merged.push(win);
    emitted.add(el.id);
  }
  for (const el of run ?? []) {
    if (emitted.has(el.id)) continue;
    const win = resolve(el.id);
    if (win) merged.push(win);
    emitted.add(el.id);
  }
  return merged;
}

/**
 * FIELD-LEVEL 3-way merge of a card for the merge-back split (story-ex0120). `base` = the card at the
 * run's fork point; `main` = the card on main NOW (may carry live human authorial edits); `run` = the
 * card the run advanced. Per field:
 *   - changed only on the RUN side  → take run (a pipeline advance OR a run-only authorial edit)
 *   - changed only on the MAIN side → keep main (a live human edit the run never touched)
 *   - changed on BOTH sides         → an {@link ELEMENT_MERGED_FIELDS} collection → merged BY ELEMENT (no
 *                                     untouched element is reverted — WS-2); otherwise a tiebreak: a
 *                                     {@link MERGE_BACK_PIPELINE_FIELDS} field → run (it advanced it);
 *                                     else → main (the human's authorial edit wins — and `status`, whose
 *                                     later move on main always beats the run's old snapshot)
 *   - changed on NEITHER            → identical on all three → main
 * `opts.mainMovedStatus` (WP5-F2): main moved `status` after the base even if it came back to the base value (the
 * ledger says so) — counts as a main change, so main's status wins.
 * `id`/`type` are immutable (always main's — a merge-back never changes a card's identity). Replaces the
 * line-based `git apply --3way` that left conflict markers on any same-region frontmatter overlap (→ the
 * card parked); and, unlike a pure 2-way "authorial always from main", it never DROPS a run-only field
 * edit (e.g. harness-enrich filling `narrative` while main still held the base value).
 */
export function mergeCardThreeWay(base: Card, main: Card, run: Card, opts: { mainMovedStatus?: boolean } = {}): Card {
  const merged: Card = { ...main };
  const asRec = (c: Card) => c as unknown as Record<string, unknown>;
  const b = asRec(base);
  const m = asRec(main);
  const r = asRec(run);
  const keys = new Set<string>([...Object.keys(b), ...Object.keys(m), ...Object.keys(r)]);
  for (const key of keys) {
    if (key === "id" || key === "type") continue; // immutable identity — never merged
    const baseValue = b[key];
    const mainValue = m[key];
    const runValue = r[key];
    const runChanged = !deepEqual(runValue, baseValue);
    // WP5-F2 — o status de main «igual à base» não prova que main não mexeu: um move A→C→A depois do corte termina
    // no mesmo valor, e a foto antiga do run venceria. Quem chama sabe pelo LEDGER (um salto que não é deste run,
    // depois da base) e diz `mainMovedStatus` — aí o status de main vence, como em qualquer move posterior ao corte.
    const mainChanged = !deepEqual(mainValue, baseValue) || (key === "status" && opts.mainMovedStatus === true);
    // BOTH sides changed a collection with element identity → merge it per `id`. Only this case needs the
    // element grain: a one-sided change has nothing to revert, so it keeps the (cheap, already correct)
    // field path below. Any side whose value isn't a recognisable identified collection also falls through
    // to that path.
    if (
      runChanged &&
      mainChanged &&
      ELEMENT_MERGED_SET.has(key) &&
      isIdentifiedCollection(baseValue) &&
      isIdentifiedCollection(mainValue) &&
      isIdentifiedCollection(runValue)
    ) {
      asRec(merged)[key] = mergeIdentifiedArrayThreeWay(baseValue, mainValue, runValue);
      continue;
    }
    // Take the run when it changed the field AND (main left it at base, OR the run owns it as pipeline).
    if (runChanged && (!mainChanged || MERGE_BACK_PIPELINE_SET.has(key))) {
      asRec(merged)[key] = runValue;
    }
  }
  return withOwnerStateFromMain(merged, main);
}

/**
 * Uma pergunta que é ESTADO DO DONO: uma decisão dele (categoria dono/dinheiro, classe do dono, o marcador «[humano]»
 * — inclusive a pergunta do teto de rodadas, que é dinheiro). PURA.
 */
export function isOwnerStateQuestion(q: Pick<CardQuestion, "category" | "text" | "context" | "ownerClass">): boolean {
  return q.category === "owner" || q.category === "money" || !!q.ownerClass || isOwnerOnlyQuestion(q);
}

/**
 * O ESTADO DO DONO não vem do run. O worktree é escrita de um agente: uma pergunta do dono que ele «responde», cria ou
 * apaga no frontmatter, e a marca de cadeia de revisão (`reviewChain`) que ele muda, não podem aterrissar na main pelo
 * merge — senão um agente forjava a resposta do dono (ou zerava o teto de rodadas) só editando o próprio card. Para
 * esses, o lado da MAIN vence sempre: a marca é a de main; cada pergunta do dono é a versão de main (ausente em main ⇒
 * não entra; presente em main e apagada no run ⇒ volta). As outras perguntas seguem o 3-way por elemento. PURA.
 */
export function withOwnerStateFromMain(merged: Card, main: Card): Card {
  const out: Card = { ...merged };
  if (main.reviewChain) out.reviewChain = main.reviewChain;
  else delete out.reviewChain;
  const mainQs = main.questions ?? [];
  const mainById = new Map(mainQs.map((q) => [q.id, q] as const));
  const questions: CardQuestion[] = [];
  for (const q of merged.questions ?? []) {
    const mq = mainById.get(q.id);
    if (isOwnerStateQuestion(q) || (mq && isOwnerStateQuestion(mq))) {
      if (mq) questions.push(mq);
    } else {
      questions.push(q);
    }
  }
  for (const mq of mainQs) {
    if (isOwnerStateQuestion(mq) && !questions.some((q) => q.id === mq.id)) questions.push(mq);
  }
  if (questions.length || main.questions || merged.questions) out.questions = questions;
  const findings = reviewFindingsFromMain(merged.findings, main.findings);
  if (findings) out.findings = findings;
  return out;
}

/**
 * Os ACHADOS DE REVISÃO também são estado que o run não decide: o desfecho deles (status, quem fechou) é o que mantém ou
 * encerra a cadeia de conserto (`cardCarriesReviewChain`), e «fechado por um humano» encerra. Um agente que, no próprio
 * worktree, marcasse o achado como fechado pelo dono — ou o apagasse — desligaria a cadeia só com o merge. Então, para
 * cada achado de revisão que a MAIN tem, vale a versão de main (inclusive se o run o apagou: ele volta). Um achado de
 * revisão NOVO do run entra (a revisão roda em worktree), mas nunca nasce «fechado pelo dono»: se vier assim, entra
 * aberto e sem a marca. Fechar de verdade é pela tela ou por `triage_finding`, que carimba o ator real. PURA.
 */
function reviewFindingsFromMain(
  merged: Card["findings"],
  main: Card["findings"],
): Card["findings"] | undefined {
  const mainList = main ?? [];
  const mainReview = new Map(mainList.filter(isReviewFinding).map((f) => [f.id, f] as const));
  if (mainReview.size === 0 && !(merged ?? []).some((f) => isReviewFinding(f) && f.statusBy === "human")) return merged;
  const out: NonNullable<Card["findings"]> = [];
  const seen = new Set<string>();
  for (const f of merged ?? []) {
    const mf = mainReview.get(f.id);
    if (mf) {
      out.push(mf);
    } else if (isReviewFinding(f) && f.statusBy === "human") {
      const { statusBy: _by, statusAt: _at, ...rest } = f;
      out.push({ ...rest, status: "open" });
    } else {
      out.push(f);
    }
    seen.add(f.id);
  }
  for (const mf of mainReview.values()) if (!seen.has(mf.id)) out.push(mf);
  return out;
}
