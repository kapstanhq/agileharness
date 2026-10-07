// Check: guard-business-intent — enforces the business-intent authorship guard.
//
// Applies ONLY to autorun runs (identified by AGILEHARNESS_AUTORUN_RUN_ID in the env
// the engine injects). A human editing via the notebook or the UI is NEVER blocked.
//
// When a run tries to write to a board.yaml and the write CHANGES a top-level field
// that is owner:human (northStar, canvas, releases, personas), the write is BLOCKED
// with an explicit error naming the field(s) and the run id. A run's write to the owner's
// markdown documents (docs/prd.md, docs/business-model-canvas.md) is BLOCKED by path.
//
// Writes to proposals/ (the draft zone) are always allowed regardless of content.
// Writes to cards/*.md and code files are always allowed (owner:agent territory).
//
// Pattern: mirrors validate-storymap-gate.js exactly — require()s the committed
// isomorphic source (ownership.js), reconstructs the final file content from the
// Edit/Write tool_input, parses before/after via js-yaml, and delegates to
// ownership.evaluateOwnerGuard. Lenient-allow on any parse/resolution surprise.
//
// WHAT THE OPERATOR ACTUALLY SEES (read before trusting this hook): THIS is the guard that fails open for real — an
// unloadable ownership lib lets a run edit the owner:human fields. It still ALLOWS and says so with ONE
// `[HARNESS WARNING] … DESLIGADO neste hook` line on STDERR, exit 0. Claude Code does not surface the stderr of an
// exit-0 hook to the model or to the operator outside verbose / transcript mode, so that line is a breadcrumb, NOT an
// alarm; an operator-visible check of whether the libs are reachable is the service preflight's job, not this hook's.
//
// Interface (auto-discovered by ../../runner.js):
//   module.exports = { name, test(input) -> null | { rule, message, fix } }

const path = require('path');
const fs = require('fs');

// Matches storymap/boards/<board>/board.yaml
const BOARD_YAML_RE = /storymap[\\/]+boards[\\/]+[^\\/]+[\\/]+board\.yaml$/i;
// Matches storymap/boards/<board>/docs/{prd,business-model-canvas}.md — os documentos markdown do dono — e
// storymap/boards/<board>/design/style-guide.md (o tom é do dono; o arquivo tem um escritor só, o servidor).
const OWNER_DOC_RE = /storymap[\\/]+boards[\\/]+[^\\/]+[\\/]+(docs[\\/]+(prd|business-model-canvas)|design[\\/]+style-guide)\.md$/i;

// ── Helpers (mirrored from validate-storymap-gate.js) ───────────────────────

function repoRootFor(dirname) {
  try {
    const marker = path.sep + '.worktrees' + path.sep;
    const wtIdx = dirname.indexOf(marker);
    return wtIdx !== -1
      ? dirname.slice(0, wtIdx)
      : path.resolve(dirname, '..', '..', '..', '..');
  } catch {
    return null;
  }
}

// When inside a worktree, derive the worktree root (so we can find newly-committed
// files like ownership.js that don't exist in the main checkout yet).
function worktreeRootFor(dirname) {
  try {
    const marker = path.sep + '.worktrees' + path.sep;
    const wtIdx = dirname.indexOf(marker);
    if (wtIdx === -1) return null;
    const rest = dirname.slice(wtIdx + marker.length);
    const runId = rest.split(path.sep)[0];
    return dirname.slice(0, wtIdx) + marker + runId;
  } catch {
    return null;
  }
}

// Lote D: the TOOL's own checkout (AGILEHARNESS_TOOL_ROOT, injected by the engine into every run) is also a
// candidate — a target repository has no `packages/storymap-ui` of its own.
function toolRootOf(env) {
  const v = (env || process.env).AGILEHARNESS_TOOL_ROOT;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function yamlCandidatesFor(dirname, env) {
  const candidates = ['js-yaml'];
  const repoRoot = repoRootFor(dirname);
  if (repoRoot) {
    candidates.push(
      path.join(repoRoot, 'packages', 'storymap-ui', 'node_modules', 'js-yaml'),
      path.join(repoRoot, 'node_modules', 'js-yaml'),
    );
  }
  const toolRoot = toolRootOf(env);
  if (toolRoot) candidates.push(path.join(toolRoot, 'node_modules', 'js-yaml'));
  return candidates;
}

// Ordered candidates for one of the tool's isomorphic libs (ownership.js). (1) a copy VENDORED beside the hook
// (`.claude/hooks/lib/<name>`); (2) the TOOL's checkout (AGILEHARNESS_TOOL_ROOT/src/lib/storymap); (3) the legacy
// path of the tool's own tree — worktree-local first (a newly committed lib may not be in the main checkout yet),
// then the main checkout.
function libCandidatesFor(dirname, name, env) {
  const out = [path.join(dirname, '..', '..', 'lib', name)];
  const toolRoot = toolRootOf(env);
  if (toolRoot) out.push(path.join(toolRoot, 'src', 'lib', 'storymap', name));
  const rel = path.join('packages', 'storymap-ui', 'src', 'lib', 'storymap', name);
  const wtRoot = worktreeRootFor(dirname);
  if (wtRoot) out.push(path.join(wtRoot, rel));
  const repoRoot = repoRootFor(dirname);
  if (repoRoot) out.push(path.join(repoRoot, rel));
  return out;
}

// Said ONCE per process, out loud: THIS is the guard that fails open (an unloadable ownership lib lets an agent edit
// the human-owned fields), and a guard that silently degrades is indistinguishable from one that works.
let _warnedMissingLib = false;
function warnLibMissing(name, what, tried) {
  if (_warnedMissingLib) return;
  _warnedMissingLib = true;
  try {
    process.stderr.write(`[HARNESS WARNING] ${name} não encontrado — ${what} DESLIGADO neste hook (procurei: ${tried.join(', ')}). Declare AGILEHARNESS_TOOL_ROOT ou vendorize a lib ao lado do hook.\n`);
  } catch { /* stderr fechado: nada a fazer */ }
}

let _yamlLib;
function loadYamlLib() {
  if (_yamlLib !== undefined) return _yamlLib;
  for (const c of yamlCandidatesFor(__dirname)) {
    try { _yamlLib = require(c); return _yamlLib; } catch { /* try next */ }
  }
  _yamlLib = null;
  return null;
}

let _ownership;
function loadOwnership() {
  if (_ownership !== undefined) return _ownership;
  const tried = libCandidatesFor(__dirname, 'ownership.js');
  _ownership = null;
  for (const c of tried) {
    try { _ownership = require(c); return _ownership; } catch { /* try next */ }
  }
  warnLibMissing('ownership', 'a guarda owner:human', tried);
  return _ownership;
}

function readDisk(filePath) {
  if (typeof filePath !== 'string') return null;
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function applyEdit(content, oldStr, newStr, replaceAll) {
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
  if (oldStr === '') return null;
  if (replaceAll) {
    if (!content.includes(oldStr)) return null;
    return content.split(oldStr).join(newStr);
  }
  const i = content.indexOf(oldStr);
  if (i === -1) return null;
  return content.slice(0, i) + newStr + content.slice(i + oldStr.length);
}

function getFinalContent(input) {
  const ti = input && input.tool_input;
  if (!ti) return null;
  if (typeof ti.content === 'string') return ti.content;
  if (typeof ti.new_string === 'string') {
    const disk = readDisk(ti.file_path);
    if (disk != null) {
      const patched = applyEdit(disk, ti.old_string, ti.new_string, ti.replace_all === true);
      if (patched != null) return patched;
    }
    return ti.new_string;
  }
  return null;
}

function parseYaml(yaml, text) {
  if (!yaml || typeof text !== 'string') return null;
  try {
    const parsed = yaml.load(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

module.exports = {
  name: 'guard-business-intent',
  test(input) {
    try {
      // AC3: only applies to autorun runs — the engine injects AGILEHARNESS_AUTORUN_RUN_ID.
      // A human session or the UI never has this env → lenient-allow immediately.
      const runId = process.env.AGILEHARNESS_AUTORUN_RUN_ID;
      if (!runId) return null;

      const filePath = input && input.tool_input && input.tool_input.file_path;
      if (!filePath || typeof filePath !== 'string') return null;

      const normalized = filePath.split(path.sep).join('/');

      // Os arquivos do DONO: o board.yaml (campos owner:human) e os documentos markdown que são dele (o PRD e o
      // Business Model Canvas). Cards e código são sempre permitidos — saem rápido. (Antes este recorte só
      // deixava passar o board.yaml, e as linhas do PRD/BMC em `evaluateOwnerGuard` nunca eram alcançadas.)
      const isOwnerDoc = OWNER_DOC_RE.test(normalized);
      if (!BOARD_YAML_RE.test(normalized) && !isOwnerDoc) return null;

      const ownership = loadOwnership();
      if (!ownership) return null; // module unavailable → lenient

      // Um documento do dono é bloqueado pelo CAMINHO, não pelo conteúdo — sem YAML para comparar.
      if (isOwnerDoc) {
        const verdict = ownership.evaluateOwnerGuard({ filePath: normalized, board: null, beforeYaml: null, afterYaml: null, runId });
        return verdict ? { rule: 'business-intent-guard', message: verdict.message, fix: verdict.fix } : null;
      }

      const yaml = loadYamlLib();
      if (!yaml) return null; // no YAML parser → lenient

      const beforeText = readDisk(filePath);
      const afterText = getFinalContent(input);
      if (!afterText) return null; // nothing to inspect (delete / rename) → allow

      const beforeYaml = parseYaml(yaml, beforeText ?? '');
      const afterYaml = parseYaml(yaml, afterText);
      if (!afterYaml) return null; // unparseable final content → lenient (AC3-safety)

      const verdict = ownership.evaluateOwnerGuard({
        filePath: normalized,
        board: null,
        beforeYaml,
        afterYaml,
        runId,
      });
      if (!verdict) return null;

      return {
        rule: 'business-intent-guard',
        message: verdict.message,
        fix: verdict.fix,
      };
    } catch {
      return null; // always lenient on internal surprise
    }
  },
};

module.exports._libCandidatesFor = libCandidatesFor;
module.exports._yamlCandidatesFor = yamlCandidatesFor;
