// Tests for the validate-storymap-gate hook (pre-write/pre-edit).
//
// Run with:  node --test .claude/hooks/tests/
//
// Lives OUTSIDE checks/ on purpose: runner.js auto-loads every *.js under
// checks/<event>/ as a check, so a test file there would be (harmlessly) loaded
// as a no-op check AND its node:test cases would never run. Here it's plain.
//
// The hardening behaviour under test (Fase 3): the hook judges the FINAL file
// content (disk + the Edit patch), not the isolated `new_string` slice, and gates
// only TRANSITIONS into a status (a status that is unchanged from disk is skipped).

const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const check = require("../checks/pre-write/validate-storymap-gate.js");

// A throwaway repo-shaped tree so the card path matches CARD_PATH_RE and the hook's
// disk reads hit real files.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "storymap-gate-test-"));
// Board de FIXTURE, nunca um de produto. Esta guarda VIAJA no artefato publicado, e um board do dono
// existe só na árvore dele: o teste ficava verde aqui e vermelho no destino, que é o pior dos dois
// mundos — uma trava publicada cujos próprios testes reprovam para quem a recebe.
const cardsDir = path.join(base, "storymap", "boards", "demo", "cards");
fs.mkdirSync(cardsDir, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

let seq = 0;
/** Write a card .md on disk and return its absolute path. */
function writeCard(frontmatter, body = "Corpo do card.") {
  const file = path.join(cardsDir, `card-${++seq}.md`);
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return file;
}

const editInput = (file_path, old_string, new_string, replace_all = false) => ({
  tool_input: { file_path, old_string, new_string, replace_all },
});
const writeInput = (file_path, content) => ({ tool_input: { file_path, content } });

// A card sitting in `quebrar-tasks` that ALREADY carries narrative, acceptance and
// tasks — exactly the shape that the old fragment-only hook mis-handled.
const READY_CARD = [
  "id: card",
  "type: story",
  "storyType: user",
  "status: quebrar-tasks",
  "narrative:",
  "  role: Como morador",
  "  want: quero ver eventos perto de mim",
  "  soThat: para sair de casa",
  "acceptance:",
  "  - Dado que abro o app Quando carrego Então vejo eventos",
  "tasks:",
  "  - id: t1",
  "    title: criar a query",
  "    done: false",
  "  - id: t2",
  "    title: render da lista",
  "    done: false",
  "techPlanReady: true",
].join("\n");

// ----------------------------------------------------------------------------
// ITEM 1 core: an Edit that ONLY flips the status line must pass when the gate's
// pre-condition already lives elsewhere in the file (no full-file rewrite needed).
// ----------------------------------------------------------------------------

test("Edit flipping status into desenvolver PASSES when tasks already exist on disk", () => {
  const file = writeCard(READY_CARD);
  const out = check.test(editInput(file, "status: quebrar-tasks", "status: desenvolver"));
  assert.strictEqual(out, null); // final content has tasks → hasTasks satisfied
});

test("Edit flipping status into priorizar PASSES when narrative+acceptance exist on disk", () => {
  const fm = READY_CARD.replace("status: quebrar-tasks", "status: enriquecer");
  const file = writeCard(fm);
  const out = check.test(editInput(file, "status: enriquecer", "status: priorizar"));
  assert.strictEqual(out, null); // hasRefinement reads the WHOLE file, not the slice
});

// ----------------------------------------------------------------------------
// Invalid transitions are still refused (gate against the FINAL file).
// ----------------------------------------------------------------------------

test("Edit flipping status into desenvolver BLOCKS when no tasks anywhere", () => {
  const fm = [
    "id: card",
    "type: story",
    "status: quebrar-tasks",
    "tasks: []",
  ].join("\n");
  const file = writeCard(fm);
  const out = check.test(editInput(file, "status: quebrar-tasks", "status: desenvolver"));
  assert.ok(out, "expected a violation");
  assert.strictEqual(out.rule, "storymap-gate");
  assert.match(out.message, /hasTasks/);
});

test("Write of a fresh card into priorizar BLOCKS without a narrative", () => {
  // No prior file on disk → treated as an entry transition → gate checked.
  const file = path.join(cardsDir, "brand-new.md");
  const content = `---\nid: brand-new\ntype: story\nstatus: priorizar\nacceptance: []\n---\n\nx\n`;
  const out = check.test(writeInput(file, content));
  assert.ok(out, "expected a violation");
  assert.match(out.message, /hasRefinement/);
});

test("Write of a fresh card into priorizar PASSES with narrative + acceptance", () => {
  const file = path.join(cardsDir, "brand-new-2.md");
  const content =
    "---\n" +
    "id: brand-new-2\n" +
    "type: story\n" +
    "status: priorizar\n" +
    "narrative:\n" +
    "  role: Como morador\n" +
    "  want: quero algo\n" +
    "  soThat: para um benefício\n" +
    "acceptance:\n" +
    "  - Dado A Quando B Então C\n" +
    "---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

// ----------------------------------------------------------------------------
// Transition-awareness: editing OTHER fields of a card already resting in a gated
// status must NOT be blocked (mirrors the app, which only gates a status change).
// ----------------------------------------------------------------------------

test("Edit of the body of a card already in desenvolver (no status change) PASSES even with no tasks", () => {
  const fm = ["id: card", "type: story", "status: desenvolver", "tasks: []"].join("\n");
  const file = writeCard(fm, "Texto antigo.");
  const out = check.test(editInput(file, "Texto antigo.", "Texto novo."));
  assert.strictEqual(out, null); // status unchanged from disk → not a transition → skip
});

// ----------------------------------------------------------------------------
// Mechanics: replace_all reconstruction; non-card paths ignored; deletes ignored.
// ----------------------------------------------------------------------------

test("replace_all Edit reconstructs the final file and gates it", () => {
  const fm = READY_CARD.replace("status: quebrar-tasks", "status: enriquecer");
  const file = writeCard(fm);
  // "enriquecer" appears only in the status line → replace_all is safe here.
  const out = check.test(editInput(file, "enriquecer", "priorizar", true));
  assert.strictEqual(out, null);
});

test("non-card paths are ignored", () => {
  const out = check.test(writeInput(path.join(base, "notes.md"), "status: priorizar\n"));
  assert.strictEqual(out, null);
});

test("a delete/rename (no content, no new_string) is ignored", () => {
  const file = writeCard(READY_CARD);
  assert.strictEqual(check.test({ tool_input: { file_path: file } }), null);
});

test("a non-gated target status passes (e.g. moving back to triage)", () => {
  const file = writeCard(READY_CARD);
  const out = check.test(editInput(file, "status: quebrar-tasks", "status: triage"));
  assert.strictEqual(out, null);
});

// ----------------------------------------------------------------------------
// B4 — the hook now parses the card (js-yaml) and delegates to the SAME predicates the app
// runs (gate-core.js), reading the board's REAL gate map. That lifts the old regex limitation
// that forced the hook to SKIP gates it couldn't parse leniently (findings[], nested briefs).
// These cases prove the newly-enforced gates + the type-aware prioritization running through
// the parse. (board = uma fixture; os cards resolvem o board.yaml dela na árvore real.)
// ----------------------------------------------------------------------------

test("hasNoBlockers: entering qa-automatizado with an OPEN blocker finding is BLOCKED", () => {
  const file = path.join(cardsDir, "nb-1.md");
  const content =
    "---\nid: nb-1\ntype: story\nstoryType: user\nstatus: qa-automatizado\nfindings:\n" +
    '  - id: f1\n    severity: blocker\n    status: open\n    title: "algo quebrou"\n---\n\nx\n';
  const out = check.test(writeInput(file, content));
  assert.ok(out, "expected a violation");
  assert.strictEqual(out.rule, "storymap-gate");
  assert.match(out.message, /hasNoBlockers/);
});

test("hasNoBlockers: entering qa-automatizado with the blocker RESOLVED (fixed) PASSES", () => {
  const file = path.join(cardsDir, "nb-2.md");
  const content =
    "---\nid: nb-2\ntype: story\nstoryType: user\nstatus: qa-automatizado\nfindings:\n" +
    "  - id: f1\n    severity: blocker\n    status: fixed\n---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

test("hasRefineBrief: entering refinar WITHOUT refinement.brief is BLOCKED", () => {
  const file = path.join(cardsDir, "rb-1.md");
  const content = "---\nid: rb-1\ntype: story\nstatus: refinar\n---\n\nx\n";
  const out = check.test(writeInput(file, content));
  assert.ok(out, "expected a violation");
  assert.match(out.message, /hasRefineBrief/);
});

test("hasRefineBrief: entering refinar WITH a refinement.brief PASSES", () => {
  const file = path.join(cardsDir, "rb-2.md");
  const content =
    "---\nid: rb-2\ntype: story\nstatus: refinar\nrefinement:\n" +
    '  brief: "Melhorar o contraste do botão primário"\n---\n\nx\n';
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

test("hasPrioritization is TYPE-AWARE through the parse: a bug into pronta needs severity + frequency", () => {
  const blocked = path.join(cardsDir, "pr-1.md");
  const blkContent = "---\nid: pr-1\ntype: story\nstoryType: bug\nstatus: pronta\nseverity: high\n---\n\nx\n";
  const out = check.test(writeInput(blocked, blkContent));
  assert.ok(out, "expected a violation (no frequency)");
  assert.match(out.message, /hasPrioritization/);

  const ok = path.join(cardsDir, "pr-2.md");
  const okContent =
    "---\nid: pr-2\ntype: story\nstoryType: bug\nstatus: pronta\nseverity: high\nfrequency: often\n---\n\nx\n";
  assert.strictEqual(check.test(writeInput(ok, okContent)), null);
});

// ----------------------------------------------------------------------------
// R1 / B5 Fase 5 — the `storymap` board INHERITS its pipeline from boards/_base (its own
// board.yaml declares no `statuses`). The hook must resolve the gate map over _base exactly
// as the app does (via gate-core.resolveBoardStatuses), so gated transitions on storymap cards
// are STILL enforced at the write boundary — not silently allowed. (board = storymap; resolves
// the REAL storymap + _base board.yaml from the repo.)
// ----------------------------------------------------------------------------

// Idem: o ponto do caso é a HERANÇA do `_base`, que vale para qualquer board.
const storymapCardsDir = path.join(base, "storymap", "boards", "demo-legado", "cards");
fs.mkdirSync(storymapCardsDir, { recursive: true });

test("(inherited) storymap card into desenvolver WITHOUT tasks is BLOCKED via the _base gate map", () => {
  const file = path.join(storymapCardsDir, "sm-1.md");
  const content = "---\nid: sm-1\ntype: story\nstoryType: user\nstatus: desenvolver\ntasks: []\n---\n\nx\n";
  const out = check.test(writeInput(file, content));
  assert.ok(out, "expected a violation (storymap inherits the hasTasks gate from _base)");
  assert.strictEqual(out.rule, "storymap-gate");
  assert.match(out.message, /hasTasks/);
});

test("(inherited) storymap card into desenvolver WITH a task PASSES (gate resolved from _base)", () => {
  const file = path.join(storymapCardsDir, "sm-2.md");
  const content =
    "---\nid: sm-2\ntype: story\nstoryType: user\nstatus: desenvolver\ntasks:\n" +
    "  - id: t1\n    title: implementar\n    done: false\n---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

// ----------------------------------------------------------------------------
// Frontmatter round-trip hardening: refuse a write whose card frontmatter would not
// survive a strict YAML parse (the recurring corruption that drops cards from the
// projection — title=id, status=null). Independent of the gate checks. See story-rk42pg.
// ----------------------------------------------------------------------------

test("(a) a block-list item with an unquoted ': ' is REJECTED (round-trip)", () => {
  const file = path.join(cardsDir, "rt-a.md");
  const content =
    "---\n" +
    "id: rt-a\n" +
    "type: story\n" +
    "status: triage\n" +
    "steps:\n" +
    "  - Disparar foo (ex.: bar) baz\n" +
    "---\n\nx\n";
  const out = check.test(writeInput(file, content));
  assert.ok(out, "expected a violation");
  assert.strictEqual(out.rule, "storymap-frontmatter-roundtrip");
});

test("(b) a duplicated top-level key (status) is REJECTED (round-trip)", () => {
  const file = path.join(cardsDir, "rt-b.md");
  const content = "---\nid: rt-b\ntype: story\nstatus: triage\ntitle: x\nstatus: pronta\n---\n\nx\n";
  const out = check.test(writeInput(file, content));
  assert.ok(out, "expected a violation");
  assert.strictEqual(out.rule, "storymap-frontmatter-roundtrip");
});

test("(c) the SAME block-list item QUOTED parses cleanly and is ALLOWED", () => {
  const file = path.join(cardsDir, "rt-c.md");
  const content =
    "---\nid: rt-c\ntype: story\nstatus: triage\nsteps:\n" +
    '  - "Disparar foo (ex.: bar) baz"\n' +
    "---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

test("(d) a typical valid card (incl. a QUOTED task title with a colon) round-trips and is ALLOWED", () => {
  const file = path.join(cardsDir, "rt-d.md");
  const content =
    "---\nid: rt-d\ntype: story\nstoryType: technical\nstatus: triage\ntasks:\n" +
    "  - id: t1\n" +
    '    title: "criar a query (com : dois-pontos) ok"\n' +
    "    done: false\n" +
    "---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

test("(e) a write OUTSIDE cards/ is NOT round-trip checked even if its frontmatter is malformed", () => {
  const file = path.join(base, "doc.md");
  const content = "---\nstatus: a\nstatus: b\nfoo: bar: baz\n---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

// ----------------------------------------------------------------------------
// story-5yfljn: the round-trip guard must not false-block skills running INSIDE a
// worktree (no node_modules). Two independent defects: (1) loadYamlLib() couldn't
// resolve js-yaml from the worktree; (2) the parser-free fallback false-positived on
// FLOW-STYLE list items (`- { id: t4, ... }`) the skills legitimately write.
// ----------------------------------------------------------------------------

// (1) Flow-style task items must round-trip via the FULL hook (parser path on main).
test("(flow) a flow-style task list `- { id: t4, ... }` round-trips and is ALLOWED", () => {
  const file = path.join(cardsDir, "rt-flow.md");
  const content =
    "---\nid: rt-flow\ntype: story\nstoryType: technical\nstatus: triage\ntasks:\n" +
    '  - { id: t4, title: "criar a query", done: false }\n' +
    "  - { id: t5, title: render da lista, done: false }\n" +
    "---\n\nx\n";
  assert.strictEqual(check.test(writeInput(file, content)), null);
});

// (2) The parser-free fallback, exercised in isolation via the test export.
test("(fallback) a flow-style list item is NOT flagged by the structural detector", () => {
  const fm = [
    "id: c",
    "status: desenvolver",
    "tasks:",
    '  - { id: t4, title: "criar a query", done: false }',
    "  - { id: t5, title: render da lista, done: false }",
  ].join("\n");
  assert.strictEqual(check._minimalDetectorFlags(fm), false);
});

test("(fallback) a plain scalar list item with an unquoted ': ' is STILL flagged", () => {
  const fm = ["id: c", "status: triage", "steps:", "  - Disparar foo (ex.: bar) baz"].join("\n");
  assert.strictEqual(check._minimalDetectorFlags(fm), true);
});

test("(fallback) a duplicated top-level key is STILL flagged", () => {
  const fm = ["id: c", "status: triage", "title: x", "status: pronta"].join("\n");
  assert.strictEqual(check._minimalDetectorFlags(fm), true);
});

test("(fallback) a top-level scalar whose unquoted value contains ': ' is STILL flagged", () => {
  const fm = ["id: c", "title: foo: bar baz", "status: triage"].join("\n");
  assert.strictEqual(check._minimalDetectorFlags(fm), true);
});

// (1) js-yaml resolution from a worktree — exercised via the pure candidate helper.
test("(worktree) candidate resolver derives the MAIN checkout root from a worktree dir", () => {
  const wtDir = ["", "repo", ".worktrees", "run-abc", ".claude", "hooks", "checks", "pre-write"].join(path.sep);
  const cands = check._yamlCandidatesFor(wtDir);
  const mainRoot = path.sep + "repo";
  assert.ok(cands.includes(path.join(mainRoot, "packages", "storymap-ui", "node_modules", "js-yaml")));
  assert.ok(cands.includes(path.join(mainRoot, "node_modules", "js-yaml")));
  assert.ok(!cands.some((c) => c.includes(".worktrees")), "must not point inside the depless worktree");
});

test("(non-worktree) candidate resolver keeps the up-4-levels repo root", () => {
  const dir = path.join(path.sep + "repo", ".claude", "hooks", "checks", "pre-write");
  const cands = check._yamlCandidatesFor(dir);
  assert.ok(cands.includes(path.join(path.sep + "repo", "packages", "storymap-ui", "node_modules", "js-yaml")));
});
