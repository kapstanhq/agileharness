#!/usr/bin/env node
// Hook runner: auto-discovers and executes checks from checks/{event}/
// Usage: node runner.js <event> (e.g., pre-bash, pre-edit, post-bash)
// Each check exports { name: string, test: (input) => null | { rule, message, fix } }

const fs = require('fs');
const path = require('path');

const event = process.argv[2];
if (!event) {
  process.exit(0);
}

const checksDir = path.join(__dirname, 'checks', event);

let checkFiles = [];
try {
  checkFiles = fs.readdirSync(checksDir)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(checksDir, f));
} catch {
  process.exit(0);
}

if (checkFiles.length === 0) {
  process.exit(0);
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.stderr.write('[HARNESS WARNING] Failed to parse stdin JSON\n');
    process.exit(0);
  }

  const violations = [];
  const filePath = input.tool_input?.file_path || input.tool_input?.command || '';

  for (const checkFile of checkFiles) {
    let check;
    try {
      check = require(checkFile);
    } catch {
      continue;
    }

    if (!check || typeof check.test !== 'function' || !check.name) {
      continue;
    }

    try {
      const result = check.test(input);
      if (result) {
        violations.push({
          rule: result.rule || check.name,
          file: filePath,
          message: result.message,
          fix: result.fix,
        });
      }
    } catch (err) {
      process.stderr.write(`[HARNESS WARNING] check ${check.name} threw: ${err.message}\n`);
    }
  }

  if (violations.length === 0) {
    process.exit(0);
  }

  const output = violations.map(v =>
    `HARNESS CHECK FAILED: ${v.rule}\nFILE: ${v.file}\nVIOLATION: ${v.message}\nFIX: ${v.fix}\nRULE: See CLAUDE.md`
  ).join('\n\n');

  process.stderr.write(output + '\n');
  process.exit(2);
});
