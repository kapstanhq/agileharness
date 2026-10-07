import { describe, expect, it } from "vitest";
import {
  ELEMENT_MERGED_FIELDS,
  MERGE_BACK_PIPELINE_FIELDS,
  PIPELINE_OWNED_FIELDS,
  mergeCardOnSave,
  mergeCardThreeWay,
  mergeIdentifiedArrayThreeWay,
} from "./card-merge";
import { parseCard } from "./contracts";
import { coerceCard } from "./repo";
import type { Card } from "./types";

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

// Regression guard for storymap-drawer-pipeline-fields-clobber: a stale drawer
// draft must NOT erase pipeline-owned fields the pipeline wrote after the drawer
// loaded. mergeCardOnSave is the extracted, pure form of updateCardAction's merge.
describe("mergeCardOnSave", () => {
  it("returns the draft unchanged when there is no prior card (new card)", () => {
    const draft = card({ title: "Novo" });
    expect(mergeCardOnSave(draft, undefined)).toBe(draft);
  });

  it("human-authored fields come from the DRAFT", () => {
    const prev = card({ title: "Antigo", acceptance: ["velho"] });
    const draft = card({ title: "Novo título do drawer", acceptance: ["novo aceite"] });
    const merged = mergeCardOnSave(draft, { ...draft, ...prev });
    expect(merged.title).toBe("Novo título do drawer");
    expect(merged.acceptance).toEqual(["novo aceite"]);
  });

  it("pipeline-owned fields are PRESERVED from disk (the clobber guard)", () => {
    const prev = card({
      wireframeChosen: "opt-1",
      techPlanReady: true,
      findings: [{ id: "f1", lens: "security", severity: "blocker", title: "x", status: "open" }],
      reviewedAt: "2026-06-01",
      reviewCommit: "abc123",
      qaPassed: true,
      qaRanAt: "2026-06-02",
      qaCommit: "def456",
      mode: "refine",
      refinement: { brief: "melhorar o header" },
    });
    // The drawer draft has NONE of the pipeline state (it loaded before the picks).
    const staleDraft = card({ title: "edição do usuário" });
    const merged = mergeCardOnSave(staleDraft, prev);

    expect(merged.title).toBe("edição do usuário"); // human field survives from draft
    // every pipeline-owned field must equal the disk truth, not the stale draft
    for (const field of PIPELINE_OWNED_FIELDS) {
      expect(merged[field]).toEqual(prev[field]);
    }
    // spot-check the exact regression: wireframeChosen + qaPassed + mode not wiped
    expect(merged.wireframeChosen).toBe("opt-1");
    expect(merged.qaPassed).toBe(true);
    expect(merged.mode).toBe("refine");
    expect(merged.refinement?.brief).toBe("melhorar o header");
  });

  it("PIPELINE_OWNED_FIELDS lists every field a drawer save must not clobber", () => {
    // Drift guard: a new pipeline-owned field on the Card type must be added here.
    for (const f of ["wireframeChosen", "findings", "techPlanReady", "qaPassed", "mode", "retirement"]) {
      expect(PIPELINE_OWNED_FIELDS).toContain(f);
    }
  });
});

// an earlier story: the merge-back split integrates the run's card .md into main via a FIELD-LEVEL 3-way
// merge — replacing the line-based `git apply --3way` that left conflict markers (→ card parked) whenever
// main and the run diverged in the same frontmatter region. Rule: a field changed ONLY by the run → run;
// ONLY by main → main; by BOTH → ownership tiebreak (pipeline field → run advanced it; authorial → main's
// live human edit). Unlike a pure 2-way "authorial always from main", a one-sided edit is NEVER dropped.
describe("mergeCardThreeWay", () => {
  // A baseline card; each side overrides ONLY the fields under test so the divergence is precise.
  const mk = (over: Record<string, unknown> = {}) =>
    card({ status: "interview", title: "Título base", acceptance: ["a1"], ...over });
  const base = mk();

  it("takes a RUN-only field change (a pipeline advance main never touched)", () => {
    // The run advanced status interview → desenvolver; main didn't touch status.
    expect(mergeCardThreeWay(base, mk(), mk({ status: "desenvolver" })).status).toBe("desenvolver");
  });

  // WP5-F2 — um move A→C→A em main depois do corte termina igual à base: só o ledger prova que main mexeu.
  it("main voltou o status ao valor da base (A→C→A, o ledger diz): o status de main vence a foto velha do run", () => {
    expect(mergeCardThreeWay(base, mk(), mk({ status: "desenvolver" }), { mainMovedStatus: true }).status).toBe("interview");
    // a marca só vale para o status: o resto do run (pipeline) segue vindo dele
    const merged = mergeCardThreeWay(base, mk(), mk({ status: "desenvolver", reviewedAt: "2026-10-01" }), { mainMovedStatus: true });
    expect(merged.reviewedAt).toBe("2026-10-01");
    // sem a marca, o comportamento de sempre (main não mexeu ⇒ o run decide)
    expect(mergeCardThreeWay(base, mk(), mk({ status: "desenvolver" }), { mainMovedStatus: false }).status).toBe("desenvolver");
  });

  it("takes a MAIN-only field change (a live human edit the run never touched)", () => {
    expect(mergeCardThreeWay(base, mk({ title: "Editado pelo humano" }), mk()).title).toBe("Editado pelo humano");
  });

  it("BOTH sides changed a PIPELINE field → the RUN wins (it advanced the pipeline)", () => {
    // base: nenhuma QA; main carimbou uma revisão; o run carimbou outra → o carimbo do pipeline é do run.
    const merged = mergeCardThreeWay(base, mk({ reviewedAt: "2026-07-01" }), mk({ reviewedAt: "2026-07-08" }));
    expect(merged.reviewedAt).toBe("2026-07-08");
  });

  // WP5-F1 (REESCRITO de propósito — o teste antigo travava o defeito): «BOTH sides changed status → the RUN wins».
  // Em main o status só anda pelo moveCard (gate + salto no ledger), e esse move é POSTERIOR ao corte do worktree; o
  // status do run é a projeção de uma foto antiga. Deixar o run vencer trazia o status do worktree por cima de um
  // move_card do condutor/dono e deixava o arquivo contradizendo o ledger.
  it("card movido em main (MCP) DEPOIS do corte mantém o status de main, mesmo que o run tenha mudado o dele", () => {
    // base "interview"; main foi movido para "pronta" por move_card; o run (foto antiga) avançou para "desenvolver".
    expect(mergeCardThreeWay(base, mk({ status: "pronta" }), mk({ status: "desenvolver" })).status).toBe("pronta");
  });

  it("o avanço de status do run continua aterrissando quando main NÃO mexeu no status", () => {
    expect(mergeCardThreeWay(base, mk({ title: "outro" }), mk({ status: "desenvolver" })).status).toBe("desenvolver");
  });

  it("BOTH sides changed an AUTHORIAL field → MAIN wins (the human's live edit)", () => {
    expect(mergeCardThreeWay(base, mk({ title: "Reescrito pelo humano" }), mk({ title: "Reescrito pelo skill" })).title).toBe(
      "Reescrito pelo humano",
    );
  });

  it("NEVER drops a RUN-only authorial edit (the harness-enrich anti-drop a pure 2-way would wipe)", () => {
    // base + main both carry the EMPTY narrative; the run (harness-enrich) filled it. A naive "authorial always
    // from main" 2-way would take main's empty narrative and DISCARD the enrichment — the enrichment drop bug.
    const b = card({ narrative: { role: null, want: null, soThat: null }, acceptance: [] });
    const main = card({ narrative: { role: null, want: null, soThat: null }, acceptance: [] });
    const run = card({
      narrative: { role: "leitor", want: "achar os livros de um autor", soThat: "comprar o próximo da série" },
      acceptance: ["Dado a vitrine, Quando busco um autor, Então vejo os livros dele"],
    });
    const merged = mergeCardThreeWay(b, main, run);
    expect(merged.narrative.role).toBe("leitor");
    expect(merged.acceptance).toEqual(["Dado a vitrine, Quando busco um autor, Então vejo os livros dele"]);
  });

  it("merges a MIXED divergence: the run's pipeline state + main's authorial edits, no field lost", () => {
    const b = card({
      status: "revisar-codigo",
      title: "T",
      acceptance: ["a1"],
      tasks: [{ id: "t1", title: "x", done: false }],
    });
    // main: a human edited authorial fields live while the run processed the card.
    const main = card({
      status: "revisar-codigo",
      title: "Título humano",
      acceptance: ["a1", "a2 humano"],
      tasks: [{ id: "t1", title: "x", done: false }],
    });
    // run: the pipeline advanced status, marked the task done, and stamped review fields.
    const run = card({
      status: "qa-automatizado",
      title: "T",
      acceptance: ["a1"],
      tasks: [{ id: "t1", title: "x", done: true }],
      reviewedAt: "2026-07-08",
      qaPassed: false,
    });
    const merged = mergeCardThreeWay(b, main, run);
    // run's pipeline advance survives…
    expect(merged.status).toBe("qa-automatizado");
    expect(merged.tasks[0].done).toBe(true);
    expect(merged.reviewedAt).toBe("2026-07-08");
    // …and main's authorial edits survive
    expect(merged.title).toBe("Título humano");
    expect(merged.acceptance).toEqual(["a1", "a2 humano"]);
  });

  it("takes the RUN's body when only the run edited it (a harness-* section main never touched)", () => {
    const b = coerceCard("c", { type: "story" }, "corpo base");
    const main = coerceCard("c", { type: "story" }, "corpo base");
    const run = coerceCard("c", { type: "story" }, "corpo base\n\n## Estado atual\nnovo diagnóstico");
    expect(mergeCardThreeWay(b, main, run).body).toContain("## Estado atual");
  });

  it("MERGE_BACK_PIPELINE_FIELDS is a superset of PIPELINE_OWNED_FIELDS plus tasks — e NUNCA status (WP5-F1)", () => {
    for (const f of PIPELINE_OWNED_FIELDS) expect(MERGE_BACK_PIPELINE_FIELDS).toContain(f);
    expect(MERGE_BACK_PIPELINE_FIELDS).toContain("tasks");
    expect(MERGE_BACK_PIPELINE_FIELDS as readonly string[]).not.toContain("status");
  });
});

// storymap-parallel-work WS-2 (2.1) — the per-element 3-way. THE contract: a side never reverts an
// element it did not touch. Each row below is one line of the spec's decision table (§2.1); they are the
// reason the field-level tiebreak can no longer reopen a triaged finding (replayed further
// down). Element = { id, v } — the shape only needs `id` to be identified.
describe("mergeIdentifiedArrayThreeWay", () => {
  type El = { id: string; v: string };
  const el = (id: string, v = "base"): El => ({ id, v });

  it("base=main=run (untouched) → keeps the base element", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [el("a")], [el("a")])).toEqual([el("a")]);
  });

  it("MAIN changed, run left it at base → MAIN (the triage the run never touched — NEVER reverted)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [el("a", "main")], [el("a")])).toEqual([el("a", "main")]);
  });

  it("main left it at base, RUN changed → RUN (a pipeline advance)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [el("a")], [el("a", "run")])).toEqual([el("a", "run")]);
  });

  it("BOTH changed the same element differently → RUN (genuinely disputed: the run is the pipeline)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [el("a", "main")], [el("a", "run")])).toEqual([el("a", "run")]);
  });

  it("MAIN removed, run left it at base → removed (a unilateral delete stands)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a"), el("b")], [el("b")], [el("a"), el("b")])).toEqual([el("b")]);
  });

  it("main left it at base, RUN removed → removed (e.g. withRunBlockersResolved pruning)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a"), el("b")], [el("a"), el("b")], [el("b")])).toEqual([el("b")]);
  });

  it("MAIN changed, RUN removed → MAIN (never delete what the human just edited)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [el("a", "main")], [])).toEqual([el("a", "main")]);
  });

  it("MAIN removed, RUN changed → RUN (the mirror of the row above: an edit beats a delete)", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [], [el("a", "run")])).toEqual([el("a", "run")]);
  });

  it("absent from base, created by MAIN only → main's new element", () => {
    expect(mergeIdentifiedArrayThreeWay([], [el("a", "main")], [])).toEqual([el("a", "main")]);
  });

  it("absent from base, created by the RUN only → the run's new element (the fresh-review-* case)", () => {
    expect(mergeIdentifiedArrayThreeWay([], [], [el("a", "run")])).toEqual([el("a", "run")]);
  });

  it("absent from base, BOTH created the SAME id → RUN wins (documented id-collision behaviour, G9)", () => {
    // The lossy case the provenance suffix (reviewFindingId) + the duplicate-id lint exist to prevent:
    // if two sides mint the same id for DIFFERENT facts, main's fact is dropped. Documented, not desired.
    expect(mergeIdentifiedArrayThreeWay([], [el("a", "main")], [el("a", "run")])).toEqual([el("a", "run")]);
  });

  it("removed by BOTH → stays removed", () => {
    expect(mergeIdentifiedArrayThreeWay([el("a")], [], [])).toEqual([]);
  });

  it("orders by MAIN's order, appending run-only elements in the RUN's order", () => {
    const base = [el("a"), el("b")];
    const main = [el("b"), el("a")]; // main reordered — its order is the one the operator reads
    const run = [el("a"), el("b"), el("x", "run"), el("y", "run")];
    expect(mergeIdentifiedArrayThreeWay(base, main, run).map((e) => e.id)).toEqual(["b", "a", "x", "y"]);
  });

  it("treats undefined sides as empty (a card with no questions[] yet)", () => {
    expect(mergeIdentifiedArrayThreeWay(undefined, undefined, [el("a", "run")])).toEqual([el("a", "run")]);
    expect(mergeIdentifiedArrayThreeWay(undefined, undefined, undefined)).toEqual([]);
  });
});

// storymap-parallel-work WS-2 (2.2/2.5) — the element merge WIRED into the card merge, and the replay of
// the real incident that motivated it. Only the BOTH-SIDES-CHANGED case changes behaviour; one-sided stays field-level.
describe("mergeCardThreeWay — element-level collections (WS-2)", () => {
  const finding = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    lens: "general",
    severity: "blocker",
    title: `finding ${id}`,
    status,
    ...extra,
  });

  it("REPLAY of the lost-closure collision: main's triage closures survive AND the run's new finding lands", () => {
    // The literal incident: 2 `code-not-landed-*` blockers the operator closed via triage on main, while a
    // concurrent harness-review run held a snapshot cut BEFORE the closure (so it carries them still `open`)
    // and added one `fresh-review-*`. The field-level tiebreak paid for that ONE addition by handing the
    // whole array to the run — REOPENING both closures. Per element: the run never touched them → main's.
    const base = card({ findings: [finding("code-not-landed-3b7c1d90", "open"), finding("code-not-landed-8e2f45a1", "open")] });
    const main = card({
      findings: [
        finding("code-not-landed-3b7c1d90", "fixed", { statusBy: "human", statusAt: "2026-07-16" }),
        finding("code-not-landed-8e2f45a1", "fixed", { statusBy: "human", statusAt: "2026-07-16" }),
      ],
    });
    const run = card({
      findings: [
        finding("code-not-landed-3b7c1d90", "open"), // stale snapshot — the run never touched these
        finding("code-not-landed-8e2f45a1", "open"),
        finding("fresh-review-7d41a09c5", "open"), // …it only ADDED this one
      ],
    });

    const merged = mergeCardThreeWay(base, main, run);

    expect(merged.findings.map((f) => [f.id, f.status])).toEqual([
      ["code-not-landed-3b7c1d90", "fixed"],
      ["code-not-landed-8e2f45a1", "fixed"],
      ["fresh-review-7d41a09c5", "open"],
    ]);
    // 2.3: the authorship stamp rides along with the element it belongs to (it is never merge INPUT).
    expect(merged.findings[0]).toMatchObject({ statusBy: "human", statusAt: "2026-07-16" });
  });

  it("tasks: the run's done-flip AND main's live rename both survive (the WS-2 note's example)", () => {
    // Before WS-2 the run took the whole tasks[] and main's rename of t2 was lost. Correction, not
    // regression: the two edits touch DIFFERENT elements, so neither has to lose.
    const base = card({ tasks: [{ id: "t1", title: "impl", done: false }, { id: "t2", title: "teste", done: false }] });
    const main = card({ tasks: [{ id: "t1", title: "impl", done: false }, { id: "t2", title: "teste E2E renomeado", done: false }] });
    const run = card({ tasks: [{ id: "t1", title: "impl", done: true }, { id: "t2", title: "teste", done: false }] });

    expect(mergeCardThreeWay(base, main, run).tasks).toEqual([
      { id: "t1", title: "impl", done: true },
      { id: "t2", title: "teste E2E renomeado", done: false },
    ]);
  });

  it("questions: main's answer survives AND the run's new question is no longer DROPPED", () => {
    // `questions` is NOT in MERGE_BACK_PIPELINE_FIELDS, so both-changed used to hand the array to MAIN —
    // silently dropping q2. Per element both sides keep what they wrote.
    const base = card({ questions: [{ id: "q1", text: "Qual persona?", status: "open" }] });
    const main = card({
      questions: [{ id: "q1", text: "Qual persona?", status: "answered", answer: "o leitor", answeredAt: "2026-07-16" }],
    });
    const run = card({
      questions: [
        { id: "q1", text: "Qual persona?", status: "open" },
        { id: "q2", text: "Vale para desktop?", status: "open" },
      ],
    });

    const merged = mergeCardThreeWay(base, main, run);
    expect(merged.questions?.map((q) => [q.id, q.status])).toEqual([
      ["q1", "answered"],
      ["q2", "open"],
    ]);
    expect(merged.questions?.[0].answer).toBe("o leitor");
  });

  it("only ONE side changed the collection → unchanged field-level behaviour (no element path)", () => {
    // The run advanced findings; main never touched them → the run's array, wholesale, as before.
    const base = card({ findings: [finding("f-a", "open")] });
    const run = card({ findings: [finding("f-a", "fixed"), finding("f-b", "open")] });
    expect(mergeCardThreeWay(base, card({ findings: [finding("f-a", "open")] }), run).findings.map((f) => f.id)).toEqual([
      "f-a",
      "f-b",
    ]);
    // …and main-only changes still keep main.
    const mainOnly = card({ findings: [finding("f-a", "fixed")] });
    expect(mergeCardThreeWay(base, mainOnly, card({ findings: [finding("f-a", "open")] })).findings[0].status).toBe("fixed");
  });

  it("acceptance (string[], no identity) stays FIELD-level: both changed → main's authorial edit", () => {
    const b = card({ acceptance: ["a1"] });
    const merged = mergeCardThreeWay(b, card({ acceptance: ["a1", "a2 humano"] }), card({ acceptance: ["a1", "a2 skill"] }));
    expect(merged.acceptance).toEqual(["a1", "a2 humano"]);
  });

  it("CONTRACT: every ELEMENT_MERGED_FIELDS field is an array of objects with a string `id` in CardSchema", () => {
    // Drift guard for 2.1's premise: the element merge keys on `id`, so a collection listed here whose
    // elements have no REQUIRED string id would merge by a field that may not exist. Behavioural (parse a
    // probe card), not Zod-internals introspection. Each probe is a VALID element of its collection, so
    // the only thing under test is the `id` — a probe invalid for other reasons would pass vacuously.
    const probes: Record<(typeof ELEMENT_MERGED_FIELDS)[number], Record<string, unknown>> = {
      findings: { id: "x1", lens: "general", severity: "low", title: "probe", status: "open" },
      questions: { id: "x1", text: "probe?", status: "open" },
      tasks: { id: "x1", title: "probe", done: false },
      decisions: { id: "x1", what: "probe", options: ["a", "b"], choice: "a", why: "PRD", undo: "voltar", by: "agent", at: "2026-09-28" },
    };
    // Exhaustiveness: a new element-merged collection must bring its probe here (the Record type already
    // forces it at compile time; this keeps the failure legible at runtime too).
    expect(Object.keys(probes).sort()).toEqual([...ELEMENT_MERGED_FIELDS].sort());

    for (const field of ELEMENT_MERGED_FIELDS) {
      const probe = probes[field];
      const base = card({}) as Card;
      // the probe as authored (WITH its id) must parse — otherwise the negatives below prove nothing
      expect(parseCard({ ...base, [field]: [probe] } as unknown as Card).ok, `${field}: probe válido deveria passar`).toBe(true);
      // …the SAME element without `id` must be rejected…
      const { id: _omitted, ...noId } = probe;
      expect(parseCard({ ...base, [field]: [noId] } as unknown as Card).ok, `${field}: elemento sem id deveria falhar`).toBe(false);
      // …and so must a non-string one.
      expect(
        parseCard({ ...base, [field]: [{ ...probe, id: 7 }] } as unknown as Card).ok,
        `${field}: id numérico deveria falhar`,
      ).toBe(false);
    }
  });
});

// O ESTADO DO DONO não vem do run (sonda: um agente edita o card no PRÓPRIO worktree e espera o merge levar).
describe("mergeCardThreeWay — o estado do dono vence pelo lado da main", () => {
  const capText = "Teto de rodadas de revisão: a revisão de «Freios» achou problema de novo, depois de 2 rodadas. Como seguir?";
  const openCap = { id: "q1", text: capText, status: "open", category: "money", ownerClass: "money", options: [{ id: "o1", label: "Aceitar" }, { id: "o2", label: "Pagar" }, { id: "o3", label: "Parar" }] };
  const chain = { root: "oficina/story-ex7101", round: 2 };

  it("pergunta do dono RESPONDIDA no worktree (o2 forjado) e marca de cadeia APAGADA no worktree ⇒ nada muda", () => {
    const base = card({ status: "desenvolver", reviewChain: chain, questions: [openCap] });
    const main = card({ status: "desenvolver", reviewChain: chain, questions: [openCap] });
    const run = card({
      status: "desenvolver",
      questions: [{ ...openCap, status: "answered", selectedOptionIds: ["o2"], answer: "pagar", answeredBy: "human", answeredAt: "2026-03-02" }],
    });
    const merged = mergeCardThreeWay(base, main, run);
    expect(merged.reviewChain).toEqual(chain);
    expect(merged.questions).toEqual(main.questions);
  });

  it("pergunta do dono CRIADA no worktree (já respondida) não entra; a do dono que o run apagou volta", () => {
    const ownerQ = { id: "q2", text: "[humano] Mandamos aviso para todos?", status: "open", category: "owner", ownerClass: "brand-voice" };
    const base = card({ questions: [ownerQ] });
    const main = card({ questions: [ownerQ] });
    const forged = { id: "q3", text: capText, status: "answered", category: "money", selectedOptionIds: ["o2"], answeredBy: "human" };
    const run = card({ questions: [forged] });
    const merged = mergeCardThreeWay(base, main, run);
    expect(merged.questions?.map((q) => q.id)).toEqual(["q2"]);
    expect(merged.questions?.[0].status).toBe("open");
  });

  it("uma marca de cadeia ESCRITA no worktree também não entra; perguntas técnicas seguem o 3-way", () => {
    const techQ = { id: "q4", text: "Uso o índice composto?", status: "open", category: "technical" };
    const base = card({ questions: [techQ] });
    const main = card({ questions: [techQ] });
    const run = card({ reviewChain: { root: "oficina/outro", round: 9 }, questions: [{ ...techQ, status: "answered", answer: "sim" }] });
    const merged = mergeCardThreeWay(base, main, run);
    expect(merged.reviewChain).toBeUndefined();
    expect(merged.questions?.[0]).toMatchObject({ id: "q4", status: "answered" });
  });

  it("a marca de LOTE é do servidor: forjada no worktree não entra; apagada no worktree volta a de main", () => {
    const mark = { id: "lote-ex9790", lead: "story-ex9791", sessionId: "sess-ex9790", at: "2026-03-02T10:00:00Z" };
    const forged = mergeCardThreeWay(card({}), card({}), card({ batch: { ...mark, lead: "story-ex9799" } }));
    expect(forged.batch).toBeUndefined();
    const erased = mergeCardThreeWay(card({ batch: mark }), card({ batch: mark }), card({}));
    expect(erased.batch).toEqual(mark);
  });
});

// Os ACHADOS DE REVISÃO são estado que o run não decide: «fechado pelo dono» encerra a cadeia de conserto, então um agente
// que marcasse `statusBy: human` (ou apagasse o achado) no próprio worktree desligava a cadeia só com o merge.
describe("mergeCardThreeWay — achados de revisão: o desfecho vem da main", () => {
  const review = { id: "f1", lens: "security", severity: "high", title: "A pinça não trava com a roda solta", status: "open" };
  const general = { id: "f2", lens: "general", severity: "low", title: "Texto do botão", status: "open" };

  it("worktree marca o achado de revisão como fechado PELO DONO ⇒ após o merge, segue aberto e a cadeia continua", async () => {
    const { cardCarriesReviewChain } = await import("./runner/review-rounds");
    const base = card({ status: "desenvolver", findings: [review] });
    const main = card({ status: "desenvolver", findings: [review] });
    const run = card({ status: "desenvolver", findings: [{ ...review, status: "fixed", statusBy: "human", statusAt: "2026-03-02" }] });
    expect(cardCarriesReviewChain(run)).toBe(false);
    const merged = mergeCardThreeWay(base, main, run);
    expect(merged.findings).toEqual(main.findings);
    expect(cardCarriesReviewChain(merged)).toBe(true);
  });

  it("worktree APAGA o achado de revisão ⇒ ele volta; um achado geral apagado continua apagado (3-way normal)", async () => {
    const { cardCarriesReviewChain } = await import("./runner/review-rounds");
    const base = card({ findings: [review, general] });
    const main = card({ findings: [review, general] });
    const run = card({ findings: [] });
    const merged = mergeCardThreeWay(base, main, run);
    expect(merged.findings?.map((f) => f.id)).toEqual(["f1"]);
    expect(cardCarriesReviewChain(merged)).toBe(true);
  });

  it("achado de revisão NOVO do run entra; se vier «fechado pelo dono», entra aberto e sem a marca", () => {
    const base = card({ findings: [] });
    const main = card({ findings: [] });
    const fresh = { id: "f3", lens: "perf", severity: "medium", title: "A lista de peças recarrega a cada tecla", status: "open" };
    const forged = { id: "f4", lens: "security", severity: "blocker", title: "O cofre aceita chave vencida", status: "fixed", statusBy: "human", statusAt: "2026-03-02" };
    const merged = mergeCardThreeWay(base, main, card({ findings: [fresh, forged] }));
    expect(merged.findings?.find((f) => f.id === "f3")).toMatchObject({ status: "open" });
    const f4 = merged.findings?.find((f) => f.id === "f4");
    expect(f4).toMatchObject({ status: "open" });
    expect(f4?.statusBy).toBeUndefined();
  });

  it("o fechamento legítimo (na main, pela tela ou triage_finding) é preservado mesmo que o run traga o achado aberto", () => {
    const closed = { ...review, status: "fixed", statusBy: "human", statusAt: "2026-03-03" };
    const base = card({ findings: [review] });
    const main = card({ findings: [closed] });
    const run = card({ findings: [review] });
    expect(mergeCardThreeWay(base, main, run).findings).toEqual(main.findings);
  });
});
