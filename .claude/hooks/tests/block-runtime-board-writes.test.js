// Tests for the block-runtime-board-writes hook (pre-write/pre-edit) — WS-3.1 / D4.
//
// Run with:  node --test .claude/hooks/tests/
//
// Lives OUTSIDE checks/ on purpose (mesmo racional dos irmãos: runner.js auto-carrega todo *.js
// sob checks/<event>/ como CHECK — um arquivo de teste lá viraria um check no-op e os casos nunca
// rodariam).
//
// Monta checkouts FALSOS em tmp. NUNCA escreve um service.lock no checkout runtime de verdade:
// isso ligaria o hook AO VIVO para toda sessão da máquina, sem deploy.
//
// Cobre:
//   AC1 — sessão de agente + board-data do checkout do serviço → BLOQUEADO (msg prescritiva)
//   AC1 — run sancionado (STORYMAP_AUTORUN_RUN_ID) → LIBERADO  (G3: a lane light vive disto)
//   AC1 — worktree de sessão / código / lacre → conforme a política
//   AC3 — sem service.lock, ou lock stale (pid morto / pid reciclado) → NO-OP

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const check = require('../checks/pre-write/block-runtime-board-writes.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'block-runtime-board-writes-test-'));

// --- checkout do SERVIÇO: `.git` DIR + storymap/.runner/ ---------------------------------------
const svc = path.join(base, 'alvo');
fs.mkdirSync(path.join(svc, '.git'), { recursive: true });
fs.mkdirSync(path.join(svc, 'storymap', '.runner'), { recursive: true });
fs.mkdirSync(path.join(svc, 'storymap', 'boards', 'demo', 'cards'), { recursive: true });
fs.mkdirSync(path.join(svc, 'packages', 'storymap-ui'), { recursive: true });

// --- worktree de SESSÃO: `.git` FILE → o .git do serviço; sem lock próprio ---------------------
const wt = path.join(svc, '.worktrees', 'agent-abc');
fs.mkdirSync(path.join(wt, 'storymap', 'boards', 'demo', 'cards'), { recursive: true });
fs.mkdirSync(path.join(svc, '.git', 'worktrees', 'agent-abc'), { recursive: true });
fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(svc, '.git', 'worktrees', 'agent-abc')}\n`);

// --- worktree INTERNO DO TRAIN: irmão `<repo>-stage` (stageWorktreePath) -----------------------
const stage = path.join(base, 'alvo-stage');
fs.mkdirSync(path.join(stage, 'storymap', 'boards', 'demo', 'cards'), { recursive: true });
fs.mkdirSync(path.join(stage, 'packages', 'storymap-ui'), { recursive: true });
fs.mkdirSync(path.join(svc, '.git', 'worktrees', 'alvo-stage'), { recursive: true });
fs.writeFileSync(path.join(stage, '.git'), `gitdir: ${path.join(svc, '.git', 'worktrees', 'alvo-stage')}\n`);

// --- checkout SEM serviço (notebook / dev local) -----------------------------------------------
const dev = path.join(base, 'notebook');
fs.mkdirSync(path.join(dev, '.git'), { recursive: true });
fs.mkdirSync(path.join(dev, 'storymap', 'boards', 'demo', 'cards'), { recursive: true });

const lockPath = path.join(svc, 'storymap', '.runner', 'service.lock');
const sealPath = path.join(svc, 'storymap', '.runner', 'stage-seal.on');

/** Um pid VIVO que se parece com o serviço: o próprio runner de teste (node). */
const LIVE_PID = process.pid;

/** Um pid vivo que NÃO é node — o cenário de pid RECICLADO (o hook deve tratar como stale). */
const sleeper = spawn('sleep', ['120'], { stdio: 'ignore' });
after(() => sleeper.kill());

/** Um pid comprovadamente MORTO (spawn + wait): stale lock de crash. */
const dead = spawnSync('node', ['-e', '']);
const DEAD_PID = dead.pid;

after(() => fs.rmSync(base, { recursive: true, force: true }));

function writeLock(pid) {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, port: 3008, startedAt: '2026-07-16T00:00:00.000Z' }));
}
function clearLock() {
  fs.rmSync(lockPath, { force: true });
}
function run(filePath, env = {}) {
  const saved = { ...process.env };
  delete process.env.STORYMAP_AUTORUN_RUN_ID; // o test runner pode estar DENTRO de um run
  Object.assign(process.env, env);
  try {
    return check.test({ tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' } });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const CARD = path.join(svc, 'storymap', 'boards', 'demo', 'cards', 'story-x.md');

test('AC1 — sessão de agente escrevendo card do checkout do SERVIÇO → bloqueado, com o caminho prescrito', () => {
  writeLock(LIVE_PID);
  const v = run(CARD);
  assert.ok(v, 'deveria bloquear');
  assert.equal(v.rule, 'block-runtime-board-writes');
  assert.match(v.message, /checkout RUNTIME/);
  assert.match(v.fix, /update_card/);
  assert.match(v.fix, /write_sidecar/);
});

test('AC1/G3 — run SANCIONADO do engine (marcador no env) → liberado [a lane light inteira depende disto]', () => {
  writeLock(LIVE_PID);
  assert.equal(run(CARD, { STORYMAP_AUTORUN_RUN_ID: '550e8400-e29b-41d4-a716-446655440000' }), null);
});

test('AC1 — sidecar (plans/) do checkout do serviço também é board-data → bloqueado', () => {
  writeLock(LIVE_PID);
  assert.ok(run(path.join(svc, 'storymap', 'boards', 'demo', 'plans', 'story-x.md')));
});

test('AC1 — CÓDIGO no checkout do serviço não é board-data → liberado', () => {
  writeLock(LIVE_PID);
  assert.equal(run(path.join(svc, 'packages', 'storymap-ui', 'a.ts')), null);
});

test('AC1 — o MESMO card no worktree da sessão → liberado', () => {
  writeLock(LIVE_PID);
  assert.equal(run(path.join(wt, 'storymap', 'boards', 'demo', 'cards', 'story-x.md')), null);
});

test('AC3 — sem service.lock (notebook/dev local) → NO-OP', () => {
  clearLock();
  assert.equal(run(CARD), null);
  assert.equal(run(path.join(dev, 'storymap', 'boards', 'demo', 'cards', 'story-x.md')), null);
});

test('AC3 — lock STALE (pid morto = crash) → NO-OP [é o caso de EMERGÊNCIA: serviço fora do ar]', () => {
  writeLock(DEAD_PID);
  assert.equal(run(CARD), null);
});

test('AC3 — lock com pid RECICLADO (vivo, mas não é node/next) → NO-OP', () => {
  writeLock(sleeper.pid);
  assert.equal(run(CARD), null);
});

test('AC3 — lock ilegível (JSON corrompido) → NO-OP (fail-open)', () => {
  fs.writeFileSync(lockPath, 'não é json');
  assert.equal(run(CARD), null);
});

test('lacre do <repo>-stage — NASCE DESLIGADO: sem o flag, o worktree do train é editável', () => {
  writeLock(LIVE_PID);
  fs.rmSync(sealPath, { force: true });
  assert.equal(run(path.join(stage, 'packages', 'storymap-ui', 'a.ts')), null);
});

test('lacre do <repo>-stage — com o flag: código dentro do worktree do train → bloqueado', () => {
  writeLock(LIVE_PID);
  fs.writeFileSync(sealPath, '');
  const v = run(path.join(stage, 'packages', 'storymap-ui', 'a.ts'));
  assert.ok(v, 'deveria bloquear');
  assert.match(v.message, /worktree INTERNO e PERSISTENTE do merge train/);
  assert.match(v.fix, /worktree_open/);
  fs.rmSync(sealPath, { force: true });
});

// REGRESSÃO (o bug pego pelo harness manual): o lacre é avaliado ANTES da regra de board-data.
// Um card dentro do `<repo>-stage` casa `storymap/boards/**`, mas o lock não está NELE (está no
// irmão) — na ordem errada a regra de board-data retornava "liberado" e o lacre nunca rodava.
test('lacre do <repo>-stage — com o flag: CARD dentro do worktree do train → bloqueado (ordem das regras)', () => {
  writeLock(LIVE_PID);
  fs.writeFileSync(sealPath, '');
  const v = run(path.join(stage, 'storymap', 'boards', 'demo', 'cards', 'story-x.md'));
  assert.ok(v, 'o lacre deve pegar board-data do stage worktree, não só código');
  assert.match(v.message, /merge train/);
  fs.rmSync(sealPath, { force: true });
});

test('lacre do <repo>-stage — o flag NÃO afeta um worktree de sessão (.worktrees/agent-*)', () => {
  writeLock(LIVE_PID);
  fs.writeFileSync(sealPath, '');
  assert.equal(run(path.join(wt, 'storymap', 'boards', 'demo', 'cards', 'story-x.md')), null);
  fs.rmSync(sealPath, { force: true });
});

test('lacre do <repo>-stage — sem serviço vivo não há train: flag ligado + lock stale → NO-OP', () => {
  writeLock(DEAD_PID);
  fs.writeFileSync(sealPath, '');
  assert.equal(run(path.join(stage, 'packages', 'storymap-ui', 'a.ts')), null);
  fs.rmSync(sealPath, { force: true });
});

test('path relativo / fora de qualquer checkout git → NO-OP', () => {
  writeLock(LIVE_PID);
  // Board de FIXTURE de propósito: um id real acopla o teste a um board que pode sumir, e — desde que
  // esta guarda passou a viajar no artefato — publicaria o nome de um produto do dono junto com ela.
  assert.equal(run('storymap/boards/demo/cards/story-x.md'), null);
  assert.equal(run(path.join(os.tmpdir(), 'solto.md')), null);
});
