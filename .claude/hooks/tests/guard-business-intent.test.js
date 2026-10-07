// Tests for the guard-business-intent hook (pre-write/pre-edit).
//
// Run with (from .claude/):  node --test 'hooks/tests/*.test.js'   (quoted: node ≥ 21 expands the glob itself; a bare
//             DIRECTORY argument is read as a module path on node 22 and fails with MODULE_NOT_FOUND)
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
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-test-abc';

  try {
    const result = check.test(writeInput(boardYamlPath, AFTER_YAML_PERSONAS_CHANGED));
    assert.ok(result, 'expected a violation');
    assert.strictEqual(result.rule, 'business-intent-guard');
    assert.match(result.message, /run-test-abc/);
    assert.match(result.message, /personas/);
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

test('AC1 — run + board.yaml releases changed → BLOCKED', () => {
  const before = `id: demo\nreleases:\n  - id: r1\n    name: v1\npersonas: []\n`;
  const after = `id: demo\nreleases:\n  - id: r1\n    name: v1\n  - id: r2\n    name: v2\npersonas: []\n`;
  fs.writeFileSync(boardYamlPath, before, 'utf8');
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-xyz';

  try {
    const result = check.test(writeInput(boardYamlPath, after));
    assert.ok(result, 'expected a violation');
    assert.match(result.message, /releases/);
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC3: no env → human session → NEVER blocked ──────────────────────────────

test('AC3 — no AGILEHARNESS_AUTORUN_RUN_ID → human → ALLOWED even with human field change', () => {
  fs.writeFileSync(boardYamlPath, BEFORE_YAML_UNCHANGED, 'utf8');
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;

  try {
    const result = check.test(writeInput(boardYamlPath, AFTER_YAML_PERSONAS_CHANGED));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv !== undefined) process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC4: run + card.md → always allowed ──────────────────────────────────────

test('AC4 — run + card.md → ALLOWED (owner:agent territory)', () => {
  fs.writeFileSync(cardPath, '---\nid: story-abc\nstatus: desenvolver\n---\n\nBody.\n', 'utf8');
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-agent';

  try {
    const result = check.test(writeInput(cardPath, '---\nid: story-abc\nstatus: revisar-codigo\n---\n\nBody.\n'));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC2: run + proposals/ path → allowed (draft zone) ────────────────────────

test('AC2 — run + proposals/ path → ALLOWED (draft zone)', () => {
  fs.writeFileSync(proposalPath, '{"northStar": "proposta"}', 'utf8');
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-proposing';

  try {
    const result = check.test(writeInput(proposalPath, '{"northStar": "updated proposta"}'));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── Edit tool shape: reconstruct from old_string + new_string ────────────────

test('Edit tool — BLOCKED when board.yaml human field changes via Edit', () => {
  fs.writeFileSync(boardYamlPath, BEFORE_YAML_UNCHANGED, 'utf8');
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-edit-test';

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
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── Lenient: unparseable/missing → allow ─────────────────────────────────────

test('lenient — unreadable board.yaml (no disk file + malformed Write) → ALLOWED', () => {
  const missingPath = path.join(boardsDir, 'board.yaml');
  // Remove any existing board.yaml so before=null
  try { fs.unlinkSync(missingPath); } catch { /* ok */ }

  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-lenient';

  try {
    // Malformed YAML as the final content → parseYaml returns null → lenient allow
    const result = check.test(writeInput(missingPath, 'not: valid: yaml: :::'));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── AC1 on statuses change (non-human field) → ALLOWED ───────────────────────

test('AC4 (board) — run writes board.yaml but only changes statuses (non-human) → ALLOWED', () => {
  const before = `id: demo\npersonas:\n  - id: p1\n    name: Alice\nstatuses: []\n`;
  const after = `id: demo\npersonas:\n  - id: p1\n    name: Alice\nstatuses:\n  - id: s1\n`;
  fs.writeFileSync(boardYamlPath, before, 'utf8');
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  process.env.AGILEHARNESS_AUTORUN_RUN_ID = 'run-nonhuman';

  try {
    const result = check.test(writeInput(boardYamlPath, after));
    assert.strictEqual(result, null);
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
});

// ── Lote D: ownership achado por LISTA ORDENADA (vendorizada > AGILEHARNESS_TOOL_ROOT > árvore legada) ───────────────
// Esta é a guarda que falha ABERTA: sem a lib, um agente edita os campos do dono (persona, release) sem ninguém ver.
// Num repositório-ALVO não há `packages/storymap-ui`; a lista cobre o alvo, e a ausência total vira AVISO, nunca silêncio.

const { spawnSync } = require('node:child_process');

const TOOL_PKG = path.resolve(__dirname, '..', '..', '..', 'packages', 'storymap-ui');
const HOOK_SRC = path.resolve(__dirname, '..', 'checks', 'pre-write', 'guard-business-intent.js');
const OWNERSHIP_SRC = path.join(TOOL_PKG, 'src', 'lib', 'storymap', 'ownership.js');

test('(lote D) lista de ownership: vendorizada primeiro, depois TOOL_ROOT, depois worktree e árvore legada', () => {
  const dir = path.join(path.sep + 'repo', '.claude', 'hooks', 'checks', 'pre-write');
  const cands = check._libCandidatesFor(dir, 'ownership.js', { AGILEHARNESS_TOOL_ROOT: path.sep + 'ferramenta' + path.sep + 'pkg' });
  assert.deepStrictEqual(cands, [
    path.join(path.sep + 'repo', '.claude', 'hooks', 'lib', 'ownership.js'),
    path.join(path.sep + 'ferramenta', 'pkg', 'src', 'lib', 'storymap', 'ownership.js'),
    path.join(path.sep + 'repo', 'packages', 'storymap-ui', 'src', 'lib', 'storymap', 'ownership.js'),
  ]);
  // dentro de um worktree o candidato local vem ANTES do checkout principal
  const wtDir = ['', 'repo', '.worktrees', 'run-abc', '.claude', 'hooks', 'checks', 'pre-write'].join(path.sep);
  const wt = check._libCandidatesFor(wtDir, 'ownership.js', {});
  assert.strictEqual(wt.length, 3);
  assert.ok(wt[1].includes('run-abc'), 'o worktree vem antes do checkout principal');
  assert.ok(!wt[2].includes('.worktrees'));
});

function targetFixture({ vendored }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alvo-sem-ferramenta-own-'));
  const hookDir = path.join(root, '.claude', 'hooks', 'checks', 'pre-write');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(hookDir, 'guard-business-intent.js'));
  if (vendored) {
    fs.mkdirSync(path.join(root, '.claude', 'hooks', 'lib'), { recursive: true });
    fs.copyFileSync(OWNERSHIP_SRC, path.join(root, '.claude', 'hooks', 'lib', 'ownership.js'));
  }
  const board = path.join(root, 'storymap', 'boards', 'oficina', 'board.yaml');
  fs.mkdirSync(path.dirname(board), { recursive: true });
  fs.writeFileSync(board, BEFORE_YAML_UNCHANGED.replace(/demo/g, 'oficina'), 'utf8');
  return { root, board };
}

function runGuardIn({ root, board }, env) {
  const script = `
    const check = require(${JSON.stringify(path.join(root, '.claude', 'hooks', 'checks', 'pre-write', 'guard-business-intent.js'))});
    const out = check.test({ tool_input: { file_path: ${JSON.stringify(board)}, content: ${JSON.stringify(AFTER_YAML_PERSONAS_CHANGED.replace(/demo/g, 'oficina'))} } });
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, AGILEHARNESS_AUTORUN_RUN_ID: 'run-ex9902', ...env },
    encoding: 'utf8',
  });
  return { out: JSON.parse(r.stdout || 'null'), stderr: r.stderr };
}

test('(lote D) alvo SEM packages/storymap-ui, com a lib vendorizada: a guarda owner:human BLOQUEIA a edição de persona', () => {
  const fx = targetFixture({ vendored: true });
  try {
    const { out, stderr } = runGuardIn(fx, { AGILEHARNESS_TOOL_ROOT: TOOL_PKG });
    assert.ok(out, 'a guarda devia bloquear');
    assert.strictEqual(out.rule, 'business-intent-guard');
    assert.match(out.message, /personas/);
    assert.doesNotMatch(stderr, /HARNESS WARNING/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('(lote D) sem cópia vendorizada mas com AGILEHARNESS_TOOL_ROOT: a lib vem da ferramenta e a guarda BLOQUEIA', () => {
  const fx = targetFixture({ vendored: false });
  try {
    const { out } = runGuardIn(fx, { AGILEHARNESS_TOOL_ROOT: TOOL_PKG });
    assert.ok(out);
    assert.match(out.message, /personas/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('(lote D) NENHUMA lib alcançável: a guarda continua permitindo (fail-open) mas AVISA em voz alta, UMA vez', () => {
  const fx = targetFixture({ vendored: false });
  try {
    const { out, stderr } = runGuardIn(fx, {});
    assert.strictEqual(out, null);
    const avisos = stderr.split('\n').filter((l) => l.includes('[HARNESS WARNING] ownership não encontrado'));
    assert.strictEqual(avisos.length, 1, `esperava UM aviso, veio: ${JSON.stringify(stderr)}`);
    assert.match(avisos[0], /guarda owner:human DESLIGADO neste hook/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ── Os documentos markdown do dono (PRD e Business Model Canvas) ─────────────
// Antes o recorte do hook só deixava passar o board.yaml, e as linhas do PRD/BMC em `evaluateOwnerGuard` nunca
// eram alcançadas — um run reescrevia o PRD calado. O contexto dos agentes (docs/contexto.md) segue livre.

function withRun(runId, fn) {
  const savedEnv = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  if (runId === null) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
  else process.env.AGILEHARNESS_AUTORUN_RUN_ID = runId;
  try {
    fn();
  } finally {
    if (savedEnv === undefined) delete process.env.AGILEHARNESS_AUTORUN_RUN_ID;
    else process.env.AGILEHARNESS_AUTORUN_RUN_ID = savedEnv;
  }
}

const docsDir = path.join(boardsDir, 'docs');
fs.mkdirSync(docsDir, { recursive: true });

test('run + docs/prd.md (Write ou Edit) → BLOCKED, apontando propose_change', () => {
  const prd = path.join(docsDir, 'prd.md');
  fs.writeFileSync(prd, '---\ndoc: prd\nformat: 2\n---\n\n## Problema\n\n- Leitores não acham a edição certa.\n', 'utf8');
  withRun('run-prd', () => {
    const w = check.test(writeInput(prd, '---\ndoc: prd\nformat: 2\n---\n\n## Problema\n\n- Outro problema.\n'));
    assert.ok(w, 'a escrita do run no PRD tem de ser bloqueada');
    assert.match(w.message, /run-prd/);
    assert.match(w.fix, /propose_change/);
    const e = check.test(editInput(prd, 'Leitores não acham a edição certa.', 'Outro problema.'));
    assert.ok(e, 'o Edit do run no PRD tem de ser bloqueado');
  });
});

test('run + docs/business-model-canvas.md → BLOCKED (artifact canvas)', () => {
  const bmc = path.join(docsDir, 'business-model-canvas.md');
  withRun('run-bmc', () => {
    const r = check.test(writeInput(bmc, '## Segmentos de clientes\n\n- Clubes de leitura.\n'));
    assert.ok(r);
    assert.match(r.fix, /artifact: "canvas"/);
  });
});

test('run + design/style-guide.md (Write ou Edit) → BLOCKED, apontando write_styleguide', () => {
  const designDir = path.join(boardsDir, 'design');
  fs.mkdirSync(designDir, { recursive: true });
  const guide = path.join(designDir, 'style-guide.md');
  fs.writeFileSync(guide, '---\nvoice:\n  tone: sereno\n---\n\nO tom da livraria.\n', 'utf8');
  withRun('run-guia', () => {
    const w = check.test(writeInput(guide, '---\nvoice:\n  tone: gritado\n---\n'));
    assert.ok(w, 'a escrita do run no guia tem de ser bloqueada');
    assert.match(w.fix, /write_styleguide/);
    assert.ok(check.test(editInput(guide, 'sereno', 'gritado')), 'o Edit do run no guia tem de ser bloqueado');
  });
  withRun(null, () => {
    assert.strictEqual(check.test(writeInput(guide, 'humano edita')), null);
  });
});

test('run + docs/contexto.md → ALLOWED; humano + docs/prd.md → ALLOWED', () => {
  withRun('run-ctx', () => {
    assert.strictEqual(check.test(writeInput(path.join(docsDir, 'contexto.md'), '## Decisões já tomadas\n\n- Só livros físicos.\n')), null);
  });
  withRun(null, () => {
    assert.strictEqual(check.test(writeInput(path.join(docsDir, 'prd.md'), '## Problema\n\n- Novo.\n')), null);
  });
});
