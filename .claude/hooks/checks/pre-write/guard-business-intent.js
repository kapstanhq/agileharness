// Check: guard-business-intent — enforces the business-intent authorship guard.
//
// Applies ONLY to autorun runs (identified by AGILEHARNESS_AUTORUN_RUN_ID in the env
// the engine injects). A human editing via the notebook or the UI is NEVER blocked.
//
// When a run tries to write to a board.yaml and the write CHANGES a top-level field
// that is owner:human (northStar, canvas, releases, personas), the write is BLOCKED
// with an explicit error naming the field(s) and the run id.
//
// Writes to proposals/ (the draft zone) are always allowed regardless of content.
// Writes to cards/*.md and code files are always allowed (owner:agent territory).
//
// Pattern: mirrors validate-storymap-gate.js exactly — require()s the committed
// isomorphic source (ownership.js), reconstructs the final file content from the
// Edit/Write tool_input, parses before/after via js-yaml, and delegates to
// ownership.evaluateOwnerGuard. Lenient-allow on any parse/resolution surprise.
//
// Interface (auto-discovered by ../../runner.js):
//   module.exports = { name, test(input) -> null | { rule, message, fix } }

const path = require('path');
const fs = require('fs');

// Matches storymap/boards/<board>/board.yaml
const BOARD_YAML_RE = /storymap[\\/]+boards[\\/]+[^\\/]+[\\/]+board\.yaml$/i;

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

function yamlCandidatesFor(dirname) {
  const candidates = ['js-yaml'];
  const repoRoot = repoRootFor(dirname);
  if (repoRoot) {
    candidates.push(
      path.join(repoRoot, 'packages', 'storymap-ui', 'node_modules', 'js-yaml'),
      path.join(repoRoot, 'node_modules', 'js-yaml'),
    );
  }
  return candidates;
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
  const OWNERSHIP_REL = path.join('packages', 'storymap-ui', 'src', 'lib', 'storymap', 'ownership.js');
  // Try worktree-local first (ownership.js is new — may not be in main checkout yet).
  const wtRoot = worktreeRootFor(__dirname);
  if (wtRoot) {
    try { _ownership = require(path.join(wtRoot, OWNERSHIP_REL)); return _ownership; } catch { /* fallthrough */ }
  }
  // Fallback: main checkout (once merged).
  const repoRoot = repoRootFor(__dirname);
  try {
    _ownership = repoRoot ? require(path.join(repoRoot, OWNERSHIP_REL)) : null;
  } catch {
    _ownership = null;
  }
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

      // Only board.yaml files carry human-owned fields.
      // Cards and code are always allowed — skip them fast.
      if (!BOARD_YAML_RE.test(normalized)) return null;

      const ownership = loadOwnership();
      if (!ownership) return null; // module unavailable → lenient

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
