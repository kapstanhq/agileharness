// claude-settings — what a Claude Code session started in a repo INHERITS from the settings layers, read the way
// the CLI resolves them. Today only `permissions.defaultMode` is needed (session-spawn.ts, fact 4: as root with an
// inherited `bypassPermissions` the session dies at birth unless the command carries IS_SANDBOX=1).

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The CLI's managed-policy file on Linux — the highest-precedence layer. */
export const MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/**
 * The `permissions.defaultMode` a session started in `repoRoot` inherits, by the CLI's precedence (highest
 * first): managed policy, project local, project, user. A layer that is absent, unreadable or silent on the key
 * falls through to the next; nothing found ⇒ `undefined`. Never throws — a read failure must degrade to "no
 * bypass inherited" (the previous behaviour), never to a wider one.
 */
export function readInheritedDefaultMode(
  repoRoot: string,
  opts: { home?: string; managedPath?: string; readFile?: (f: string) => string } = {},
): unknown {
  const read = opts.readFile ?? ((f: string) => readFileSync(f, "utf8"));
  const files = [
    opts.managedPath ?? MANAGED_SETTINGS_PATH,
    path.join(repoRoot, ".claude", "settings.local.json"),
    path.join(repoRoot, ".claude", "settings.json"),
    path.join(opts.home ?? os.homedir(), ".claude", "settings.json"),
  ];
  for (const f of files) {
    try {
      const mode = (JSON.parse(read(f)) as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
      if (mode !== undefined) return mode;
    } catch {
      /* absent or unreadable ⇒ next layer */
    }
  }
  return undefined;
}
