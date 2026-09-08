// Tests for the guard-business-intent hook (pre-write/pre-edit).
//
// Run with:  node --test .claude/hooks/tests/
//
// Lives OUTSIDE checks/ on purpose (see validate-storymap-gate.test.js rationale).
//
// Covers:
//   AC1 — run + board.yaml + human field changed → BLOCKED with field + run id in message
//   AC2 — run + proposals/ path → ALLOWED
//   AC3 — no env (human) + board.yaml + human field changed → ALLOWED
//   AC4 — run + card.md → ALLOWED

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const check = require('../checks/pre-write/guard-business-intent.js');

// Build a throwaway file tree that looks like the storymap directory layout.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-business-intent-test-'));
const boardsDir = path.join(base, 'storymap', 'boards', 'demo');
const cardsDir = path.join(boardsDir, 'cards');
const proposalsDir = path.join(boardsDir, 'proposals');
fs.mkdirSync(cardsDir, { recursive: true });
fs.mkdirSync(proposalsDir, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const boardYamlPath = path.join(boardsDir, 'board.yaml');
const cardPath = path.join(cardsDir, 'story-abc.md');
const proposalPath = path.join(proposalsDir, 'opp-1.json');

// Helpers
const writeInput = (file_path, content) => ({ tool_input: { file_path, content } });
const editInput = (file_path, old_string, new_string) => ({
  tool_input: { file_path, old_string, new_string },
});

// ── AC1: run + board.yaml + human field changed → BLOCKED ────────────────────

const BEFORE_YAML_UNCHANGED = `id: demo
name: Demo
personas:
  - id: p1
    name: Alice
statuses: []
`;

const AFTER_YAML_PERSONAS_CHANGED = `id: demo
name: Demo
personas:
  - id: p1
    name: Alice
  - id: p2
    name: Bob
statuses: []
`;

test('AC1 — run + board.yaml personas changed → BLOCKED with field and run id', () => {
  fs.writeFileSync(boardYamlPath, BEFORE_YAML_UNCHANGED, 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-test-abc';

  try {
    const result = check.test(writeInput(boardYamlPath, AFTER_YAML_PERSONAS_CHANGED));
    assert.ok(result, 'expected a violation');
    assert.strictEqual(result.rule, 'business-intent-guard');
    assert.match(result.message, /run-test-abc/);
    assert.match(result.message, /personas/);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

test('AC1 — run + board.yaml releases changed → BLOCKED', () => {
  const before = `id: demo\nreleases:\n  - id: r1\n    name: v1\npersonas: []\n`;
  const after = `id: demo\nreleases:\n  - id: r1\n    name: v1\n  - id: r2\n    name: v2\npersonas: []\n`;
  fs.writeFileSync(boardYamlPath, before, 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-xyz';

  try {
    const result = check.test(writeInput(boardYamlPath, after));
    assert.ok(result, 'expected a violation');
    assert.match(result.message, /releases/);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC3: no env → human session → NEVER blocked ──────────────────────────────

test('AC3 — no STORYMAP_AUTORUN_RUN_ID → human → ALLOWED even with human field change', () => {
  fs.writeFileSync(boardYamlPath, BEFORE_YAML_UNCHANGED, 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  delete process.env.STORYMAP_AUTORUN_RUN_ID;

  try {
    const result = check.test(writeInput(boardYamlPath, AFTER_YAML_PERSONAS_CHANGED));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv !== undefined) process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC4: run + card.md → always allowed ──────────────────────────────────────

test('AC4 — run + card.md → ALLOWED (owner:agent territory)', () => {
  fs.writeFileSync(cardPath, '---\nid: story-abc\nstatus: desenvolver\n---\n\nBody.\n', 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-agent';

  try {
    const result = check.test(writeInput(cardPath, '---\nid: story-abc\nstatus: revisar-codigo\n---\n\nBody.\n'));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC2: run + proposals/ path → allowed (draft zone) ────────────────────────

test('AC2 — run + proposals/ path → ALLOWED (draft zone)', () => {
  fs.writeFileSync(proposalPath, '{"northStar": "proposta"}', 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-proposing';

  try {
    const result = check.test(writeInput(proposalPath, '{"northStar": "updated proposta"}'));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── Edit tool shape: reconstruct from old_string + new_string ────────────────

test('Edit tool — BLOCKED when board.yaml human field changes via Edit', () => {
  fs.writeFileSync(boardYamlPath, BEFORE_YAML_UNCHANGED, 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-edit-test';

  try {
    const result = check.test(editInput(
      boardYamlPath,
      '  - id: p1\n    name: Alice',
      '  - id: p1\n    name: Alice\n  - id: p2\n    name: Bob',
    ));
    assert.ok(result, 'expected a violation');
    assert.strictEqual(result.rule, 'business-intent-guard');
    assert.match(result.message, /personas/);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── Lenient: unparseable/missing → allow ─────────────────────────────────────

test('lenient — unreadable board.yaml (no disk file + malformed Write) → ALLOWED', () => {
  const missingPath = path.join(boardsDir, 'board.yaml');
  // Remove any existing board.yaml so before=null
  try { fs.unlinkSync(missingPath); } catch { /* ok */ }

  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-lenient';

  try {
    // Malformed YAML as the final content → parseYaml returns null → lenient allow
    const result = check.test(writeInput(missingPath, 'not: valid: yaml: :::'));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC1 on statuses change (non-human field) → ALLOWED ───────────────────────

test('AC4 (board) — run writes board.yaml but only changes statuses (non-human) → ALLOWED', () => {
  const before = `id: demo\npersonas:\n  - id: p1\n    name: Alice\nstatuses: []\n`;
  const after = `id: demo\npersonas:\n  - id: p1\n    name: Alice\nstatuses:\n  - id: s1\n`;
  fs.writeFileSync(boardYamlPath, before, 'utf8');
  const savedEnv = process.env.STORYMAP_AUTORUN_RUN_ID;
  process.env.STORYMAP_AUTORUN_RUN_ID = 'run-nonhuman';

  try {
    const result = check.test(writeInput(boardYamlPath, after));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.STORYMAP_AUTORUN_RUN_ID;
    else process.env.STORYMAP_AUTORUN_RUN_ID = savedEnv;
  }
});
