// Check: validate-storymap-gate — enforces the StoryMap pipeline gates at the write
// boundary. When a write targets a card file (storymap/boards/<board>/cards/<id>.md), it
// parses the YAML frontmatter from the FINAL file content (NOT the isolated Edit fragment) and
// refuses the write only when it is a TRANSITION into a gated `status` the card does not yet
// satisfy.
//
// FINAL-CONTENT + TRANSITION (Fase 3, hardening): a Write carries the whole file; an Edit
// carries only the changed slice. Judging an Edit's `new_string` ALONE false-blocked legit
// moves whose pre-condition already lived elsewhere in the file (e.g. `status: desenvolver`
// needs `tasks:` that a PRIOR edit already wrote). So we reconstruct the POST-edit file (disk
// content + the old→new patch) and gate against THAT, and — mirroring the app's checkGate, which
// only fires on a status CHANGE — read the prior status from disk and skip when it is unchanged.
//
// B4 — ISOMORPHIC single-source: this hook no longer RE-IMPLEMENTS the gate predicates in regex.
// It js-yaml-parses the final frontmatter into a card object, reads the board's REAL gate map
// from storymap/boards/<board>/board.yaml, and delegates to the SAME predicates the app runs —
// packages/storymap-ui/src/lib/storymap/gate-core.js (require()d directly; it is committed
// source, present even inside a git worktree, unlike node_modules). There is no second copy of
// the gate logic to drift from. See ADR-057. The hook stays a coarse, LENIENT safety net: any
// missing piece (no shared module, no YAML parser, an unreadable board.yaml, an unparseable
// card) degrades to "allow" — the app's checkGate remains the authoritative enforcement; this
// just catches agent file-edits before they land.
//
// Interface (auto-discovered by ../../runner.js):
//   module.exports = { name, test(input) -> null | { rule, message, fix } }
// Write tool exposes the whole file via tool_input.content; Edit exposes
// tool_input.{old_string,new_string,replace_all} — we rebuild the resulting file from disk +
// that patch (and read disk again for the prior status).

const path = require('path');
const fs = require('fs');

// Matches storymap/boards/<board>/cards/<id>.md anywhere in the path (posix or win).
const CARD_PATH_RE = /storymap[\\/]+boards[\\/]+[^\\/]+[\\/]+cards[\\/]+[^\\/]+\.md$/i;

// Extract the board id from a (forward-slashed) card path: storymap/boards/<board>/cards/<id>.md
function boardFromPath(normalized) {
  const m = normalized.match(/storymap\/boards\/([^/]+)\/cards\//i);
  return m ? m[1] : null;
}

// Apply a single Edit (old_string → new_string) to `content`, returning the patched text — or
// null when old_string isn't present. Uses indexOf/slice (NOT String.replace) so a `$` sequence
// in the replacement is never interpreted, and split/join for the replace_all variant. Pure.
function applyEdit(content, oldStr, newStr, replaceAll) {
  if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
  if (oldStr === '') return null; // an empty match is ambiguous → bail (lenient)
  if (replaceAll) {
    if (!content.includes(oldStr)) return null;
    return content.split(oldStr).join(newStr);
  }
  const i = content.indexOf(oldStr);
  if (i === -1) return null;
  return content.slice(0, i) + newStr + content.slice(i + oldStr.length);
}

// Read the card file from disk (the pre-write state). Returns the text or null.
function readDisk(filePath) {
  if (typeof filePath !== 'string') return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Resolve the FINAL file content the gate must judge — the whole resulting card, NOT the isolated
// Edit slice. Write → its content IS the file. Edit → rebuild (disk + patch). Degenerate cases
// (file unreadable, old_string absent) fall back to the raw new_string fragment — the lenient
// historical behaviour, so a parser surprise never false-blocks.
function getFinalContent(input) {
  const ti = input && input.tool_input;
  if (!ti) return null;
  if (typeof ti.content === 'string') return ti.content; // Write: whole file
  if (typeof ti.new_string === 'string') {
    const disk = readDisk(ti.file_path);
    if (disk != null) {
      const patched = applyEdit(disk, ti.old_string, ti.new_string, ti.replace_all === true);
      if (patched != null) return patched;
    }
    return ti.new_string; // fallback: the post-edit fragment alone
  }
  return null;
}

// Extract the frontmatter block (between leading `---` fences). Tolerant: if no fenced block is
// found, fall back to scanning the whole text.
function extractFrontmatter(text) {
  const m = text.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : text;
}

function readStatus(fm) {
  // status: <id>  (quoted or bare). null/empty => no gate to check.
  const m = fm.match(/^\s*status\s*:\s*("?)([A-Za-z0-9_-]+)\1\s*$/m);
  return m ? m[2] : null;
}

// The card's status BEFORE this write (read from disk). null when the file doesn't exist yet (a
// brand-new card → treated as an entry, so the gate is checked) or has no status. Used to gate
// only TRANSITIONS, mirroring the app's checkGate.
function priorStatus(input) {
  const ti = input && input.tool_input;
  const disk = readDisk(ti && ti.file_path);
  return disk == null ? null : readStatus(extractFrontmatter(disk));
}

// The repo root for a given hook dir. WORKTREE caveat (story-5yfljn): inside an isolated run the
// hook lives at `<mainRepo>/.worktrees/run-<id>/.claude/hooks/checks/pre-write`, and `git
// worktree add` does NOT copy node_modules — so deriving the root via `../../../..` lands in the
// (depless) worktree. When the dir sits under `.worktrees/`, truncate there to reach the MAIN
// checkout (whose packages/storymap-ui/node_modules/js-yaml is real, and whose committed source
// is identical); otherwise keep the historical up-4 root. Pure (no fs) so it's unit-testable.
function repoRootFor(dirname) {
  try {
    const marker = path.sep + '.worktrees' + path.sep;
    const wtIdx = dirname.indexOf(marker);
    return wtIdx !== -1
      ? dirname.slice(0, wtIdx) // main checkout root (the worktree has no deps)
      : path.resolve(dirname, '..', '..', '..', '..'); // .../pre-write → repo root
  } catch {
    return null;
  }
}

// Ordered js-yaml require candidates for a given starting dir. A bare require fails under the
// repo's bun node_modules layout, so we also point at the storymap-ui package copy and the root
// copy, resolved RELATIVE to the (worktree-aware) repo root.
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

// Load a real YAML parser. Cached. Returns the lib or null.
let _yamlLib;
function loadYamlLib() {
  if (_yamlLib !== undefined) return _yamlLib;
  for (const c of yamlCandidatesFor(__dirname)) {
    try {
      _yamlLib = require(c);
      return _yamlLib;
    } catch {
      /* try next */
    }
  }
  _yamlLib = null;
  return null;
}

// Load the isomorphic gate-core (committed source — present in main AND in worktrees). Cached.
// Guarded so a resolution surprise degrades to lenient-allow WITHOUT skipping the round-trip
// guard (the runner skips the WHOLE check if a top-level require throws).
let _gateCore;
function loadGateCore() {
  if (_gateCore !== undefined) return _gateCore;
  const repoRoot = repoRootFor(__dirname);
  try {
    _gateCore = repoRoot
      ? require(path.join(repoRoot, 'packages', 'storymap-ui', 'src', 'lib', 'storymap', 'gate-core.js'))
      : null;
  } catch {
    _gateCore = null;
  }
  return _gateCore;
}

// Parse the board's REAL gate map from storymap/boards/<board>/board.yaml — RESOLVED over the shared
// _base template exactly as the app's readBoardConfig does (B5/Fase 5: the canonical Stage→Step
// pipeline lives in boards/_base; the `storymap` board inherits it — its own board.yaml carries NO
// `statuses` — while product boards opt out via `inheritPipeline: false`). The merge is delegated to
// gate-core's `resolveBoardStatuses` (the SAME isomorphic algorithm repo.ts uses), so the hook and
// the app resolve the inherited gate map identically. Returns a config with a `statuses` array (what
// gate-core.gateForStatus needs), or null when the board/parser/file isn't available (→ lenient
// allow). Read from the worktree-aware repo root so a worktree run gets the stable main board.yaml.
function loadBoardConfig(yaml, gateCore, repoRoot, board) {
  if (!yaml || !gateCore || typeof gateCore.resolveBoardStatuses !== 'function' || !repoRoot || !board) return null;
  try {
    const readYaml = (p) => {
      try {
        const c = yaml.load(fs.readFileSync(p, 'utf8'));
        return c && typeof c === 'object' ? c : null;
      } catch {
        return null;
      }
    };
    const boardRaw = readYaml(path.join(repoRoot, 'storymap', 'boards', board, 'board.yaml'));
    if (!boardRaw) return null;
    const baseRaw = readYaml(path.join(repoRoot, 'storymap', 'boards', '_base', 'board.yaml'));
    const statuses = gateCore.resolveBoardStatuses(baseRaw, boardRaw);
    return Array.isArray(statuses) && statuses.length ? { statuses } : null;
  } catch {
    return null;
  }
}

// The gate verdict for a transition into `status` — delegated to gate-core (the single source).
// null = allow (no gate, gate satisfied, or any lenient fallback). Otherwise a violation object.
function checkGate(fm, status, normalized) {
  const gateCore = loadGateCore();
  const yaml = loadYamlLib();
  if (!gateCore || !yaml) return null; // no shared module / parser → app stays authoritative
  const repoRoot = repoRootFor(__dirname);
  const config = loadBoardConfig(yaml, gateCore, repoRoot, boardFromPath(normalized));
  if (!config) return null; // can't resolve the gate map → lenient

  let card;
  try {
    card = yaml.load(fm);
  } catch {
    return null; // unparseable card (round-trip guard above already refuses true corruption)
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;

  const verdict = gateCore.evaluateGate(card, status, config); // null | { gate, label, message, fix }
  if (!verdict) return null;
  return {
    rule: 'storymap-gate',
    message: `Gate "${verdict.gate}" bloqueia a entrada no status "${status}": ${verdict.message}`,
    fix: `${verdict.fix} O gate valida o conteúdo final do card (não só a linha alterada). Fonte única: board.yaml + packages/storymap-ui/src/lib/storymap/gate-core.js.`,
  };
}

// ── Frontmatter round-trip hardening (independent of the gate checks above) ──
// A card whose frontmatter doesn't survive a STRICT YAML parse silently corrupts the board
// projection: the parser bails and the card renders with title=id and status=null, dropping it
// out of its column. Two recurring shapes (documented in story-rk42pg): (1) an unquoted plain
// scalar containing ': ' — e.g. a task/step title like "… (saída 0): marca done" — which YAML
// reads as a nested mapping or fails to parse; (2) a duplicated top-level key (e.g. two
// `status:`). This validates the FINAL frontmatter and refuses the write before it lands. It is
// SEPARATE from the gate checks and does not weaken them.

const ROUNDTRIP_VIOLATION = {
  rule: 'storymap-frontmatter-roundtrip',
  message:
    'o frontmatter do card não faz round-trip — provável ": " não-quotado num escalar plano (títulos de task/steps) ou chave duplicada; isso derruba o card da projeção (title=id, status=null)',
  fix:
    'Escreva todo escalar que contenha ": " como string entre ASPAS DUPLAS (escapando " interno); no máximo uma de cada chave de topo.',
};

// Extract ONLY a fenced frontmatter block (`---` … `---` at the top). Unlike extractFrontmatter,
// returns null when there is no fenced block (so the round-trip check is skipped for content
// without frontmatter — e.g. an Edit fragment that didn't touch the head).
function extractFrontmatterBlock(text) {
  const m = text.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

// Does the PARSED object round-trip the frontmatter TEXT? Catches the silent-misparse cases the
// parser doesn't throw on: (b) a block-list scalar that contains ': ' is read as a 1-key mapping
// whose key carries SPACES (a real list-of-mappings uses field-name keys like id/title/done that
// never contain spaces); (c) a top-level scalar the text clearly declares (id/title/status) was
// absorbed/lost (key missing) or turned into a structure. `null` (e.g. `status: null` on backbone
// cards) is a valid scalar and allowed.
function parsedRoundTrips(parsed, fmBlock) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // A frontmatter that declares top-level keys but doesn't parse to a mapping is suspect;
    // otherwise (empty / pure comment) allow.
    return !/^[A-Za-z_][\w-]*\s*:/m.test(fmBlock);
  }
  for (const v of Object.values(parsed)) {
    if (!Array.isArray(v)) continue;
    for (const el of v) {
      if (el && typeof el === 'object' && !Array.isArray(el) && Object.keys(el).some((k) => /\s/.test(k))) {
        return false; // a list item misparsed from a ': '-bearing scalar into a space-keyed mapping
      }
    }
  }
  for (const key of ['id', 'title', 'status']) {
    if (!new RegExp(`^${key}\\s*:`, 'm').test(fmBlock)) continue; // the text doesn't declare it
    if (!(key in parsed)) return false; // declared in text but lost in the parse
    const val = parsed[key];
    if (val !== null && typeof val === 'object') return false; // absorbed into a list/mapping
  }
  return true;
}

// Parser-free fallback (only when no YAML lib resolves). Flags the two known corruption shapes
// WITHOUT false-flagging valid list-of-mappings: (a) a duplicated top-level key; (b) a block-list
// item whose pre-colon text has a SPACE (`- Disparar foo (ex.: bar)` — a valid `- id: t4` has no
// space before its colon); (c) a key whose UNQUOTED value itself contains ': '.
function minimalDetectorFlags(fmBlock) {
  const topKeys = new Map();
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:/);
    if (m) topKeys.set(m[1], (topKeys.get(m[1]) || 0) + 1);
  }
  for (const n of topKeys.values()) if (n > 1) return true; // (a) duplicated top-level key
  if (/^\s*-\s+(?!["'{])[^:\n]*\s[^:\n]*:\s/m.test(fmBlock)) return true; // (b) PLAIN-scalar list item with ': ' (flow-style `- { ... }` is skipped — the parser handles it)
  if (/^\s*[A-Za-z_][\w-]*\s*:[ \t]+(?!["'[{>|&*#])[^"'\n]*:\s/m.test(fmBlock)) return true; // (c) value with ': ' — gap is horizontal-only so a `key:`\n followed by a flow-style list item doesn't cross the newline
  return false;
}

// Strict round-trip validation of the frontmatter block → a violation object or null. Prefers the
// real parser; falls back to the structural detector. Tolerant: any internal surprise allows.
function checkFrontmatterRoundtrip(fmBlock) {
  try {
    const yaml = loadYamlLib();
    if (yaml) {
      let parsed;
      try {
        parsed = yaml.load(fmBlock); // throws on a duplicated key + on a ': ' that breaks a plain scalar
      } catch {
        return ROUNDTRIP_VIOLATION;
      }
      return parsedRoundTrips(parsed, fmBlock) ? null : ROUNDTRIP_VIOLATION;
    }
    return minimalDetectorFlags(fmBlock) ? ROUNDTRIP_VIOLATION : null;
  } catch {
    return null;
  }
}

module.exports = {
  name: 'validate-storymap-gate',
  test(input) {
    try {
      const filePath = input && input.tool_input && input.tool_input.file_path;
      if (!filePath || typeof filePath !== 'string') return null;

      const normalized = filePath.split(path.sep).join('/');
      if (!CARD_PATH_RE.test(normalized)) return null; // not a storymap card

      const content = getFinalContent(input);
      if (!content) return null; // nothing to inspect (e.g. delete/rename)

      // (independent of the gate checks): refuse a write whose card frontmatter would not survive
      // a strict YAML parse (unquoted ': ' scalar / duplicated key) — that corrupts the board
      // projection (title=id, status=null). Runs for ANY card .md with a frontmatter block,
      // regardless of status/transition. See story-rk42pg.
      const fmBlock = extractFrontmatterBlock(content);
      if (fmBlock != null) {
        const rt = checkFrontmatterRoundtrip(fmBlock);
        if (rt) return rt;
      }

      const fm = extractFrontmatter(content);
      const status = readStatus(fm);
      if (!status) return null; // no/null status -> nothing to gate

      // Gate only TRANSITIONS into the status (mirror the app's checkGate, which runs only on a
      // status change). If the card already RESTED in this status before the write, editing its
      // other fields must not be blocked — even if the gate isn't met.
      if (priorStatus(input) === status) return null;

      return checkGate(fm, status, normalized); // null (ok) or violation object
    } catch {
      // Tolerant by design: never block on a parser surprise.
      return null;
    }
  },
};

// Exported for unit tests of the parser-free fallback and the worktree-aware js-yaml resolution
// (story-5yfljn). The runner only consumes `name` + `test`; these are inert in production.
module.exports._minimalDetectorFlags = minimalDetectorFlags;
module.exports._yamlCandidatesFor = yamlCandidatesFor;
