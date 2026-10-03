// Copy-mode driver for the web terminal (the server half of `POST /api/terminal/scroll`): send a
// pane back to the PREVIOUS shell prompt, or back to the bottom.
//
// WHY THIS MODULE EXISTS — it is a security boundary, not a convenience wrapper. tmux's search is
// `send-keys -X search-backward <pattern>`, so the obvious API ("the client sends the regex it
// wants") hands caller data to a command the server builds: one careless shell interpolation on the
// way there turns a terminal button into remote code execution. Hence the wire protocol names an
// ACTION out of a CLOSED literal set (`last-prompt` | `bottom`) and the SERVER owns the pattern
// allowlist. There is no code path in this file that forwards caller text into a tmux command.
//
// Three invariants that must never be broken here:
//   • BOTH guards run BEFORE the first spawn — `isSafeSessionName` (imported from lib/vps/tmux: the
//     one slug rule, never a second copy of that regex) and the action allowlist. The unit tests
//     prove the ordering by asserting the injected runner was never called at all.
//   • Every call is `execFile` with an argv ARRAY, `shell: false`, 3 000 ms timeout. Never a shell
//     string — not even "just for the pattern".
//   • It NEVER throws. Failure is a VALUE (`{ ok: false, error }`) so the route answers honestly
//     instead of the page getting a 500 it cannot explain.
//
// THE TRAP `found` AVOIDS: tmux reports SUCCESS for a search that matched nothing — `send-keys -X
// search-backward` exits 0 whether or not anything was found. Deriving "it worked" from the exit
// code would make the button lie silently on every pane with no earlier prompt. So `found` comes
// from the pane POSITION actually changing between a read before and a read after. When the
// position is unreadable we report `found: false`: absent is a value, a hopeful `true` is a bug.
//
// The position is read as `#{scroll_position}:#{copy_cursor_y}` and compared as an OPAQUE token,
// not as `#{scroll_position}` alone — that one only moves when the VIEW scrolls, so a prompt still
// on the visible screen (the common case: the last prompt is usually a few lines up) would match,
// move the cursor, leave scroll_position at 0 and read as "not found".
//
// The prompt pattern is a settings/env knob with a conservative default, never a product constant:
// this is generic tooling, and the shape of a prompt belongs to the box, not to the code.
//
// The runner is INJECTABLE (default = the real execFile wrapper) so the unit tests drive the whole
// decision table without ever touching a tmux server.
//
// SERVER-ONLY (node:child_process). Never import from a client component.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSafeSessionName } from "@/lib/vps/tmux";

const pexec = promisify(execFile);

/** Budget for EVERY tmux call here. Short on purpose: a copy-mode query that needs 3 s is a hung box,
 *  and this runs behind a button the operator is holding their thumb on. */
const TIMEOUT_MS = 3_000;

/** The closed set the wire protocol accepts. The route validates against THIS — a second literal
 *  list over there would be a second truth, and the one that drifts open is the security hole. */
export const SCROLL_ACTIONS = ["last-prompt", "bottom"] as const;
export type ScrollAction = (typeof SCROLL_ACTIONS)[number];

export function isScrollAction(x: unknown): x is ScrollAction {
  return typeof x === "string" && (SCROLL_ACTIONS as readonly string[]).includes(x);
}

/** Conservative default: a line that is nothing but indentation and `> ` — the prompt shape both a
 *  bare shell (`PS1`-agnostic) and the Claude TUI leave behind. Operators override per box with
 *  `AGILEHARNESS_TERM_PROMPT_PATTERN`; it is read PER CALL so the knob takes effect without a rebuild. */
const DEFAULT_PROMPT_PATTERN = "^ *> ";

/** Server-owned allowlist — the ONLY place a tmux search pattern can come from. */
function promptPattern(): string {
  const fromEnv = process.env.AGILEHARNESS_TERM_PROMPT_PATTERN;
  return fromEnv && fromEnv.trim() ? fromEnv : DEFAULT_PROMPT_PATTERN;
}

/** Scroll offset AND cursor row: together an absolute position in the pane's history. Exported so a
 *  test can pin it — dropping `copy_cursor_y` silently re-introduces the on-screen false negative. */
export const POSITION_FORMAT = "#{scroll_position}:#{copy_cursor_y}";

export interface ScrollResult {
  /** the command reached tmux and the pane answered */
  ok: boolean;
  /** the pane ACTUALLY moved — never inferred from an exit code */
  found: boolean;
  /** operator-facing reason when `ok` is false; absent otherwise */
  error?: string;
}

/** One tmux invocation, argv only. Injectable so the tests never spawn anything. */
export type TmuxRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** The real thing: argv array, `shell: false` (stated, not merely defaulted), bounded time+buffer. */
const execFileRunner: TmuxRunner = async (args) => {
  const { stdout, stderr } = await pexec("tmux", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 64_000,
    shell: false,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Never-throw wrapper: an injected runner may reject, and `execFile` rejects on a non-zero exit. */
async function call(
  run: TmuxRunner,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const r = await run(args);
    return { ok: true, stdout: String(r?.stdout ?? "") };
  } catch (e: any) {
    const raw = String(e?.stderr ?? e?.message ?? "").trim();
    return { ok: false, error: raw || "falha ao falar com o tmux" };
  }
}

/** Current position, or null when the pane could not be read at all (killed session, no tmux). */
async function readPosition(run: TmuxRunner, name: string): Promise<string | null> {
  const r = await call(run, ["display-message", "-p", "-t", name, POSITION_FORMAT]);
  return r.ok ? r.stdout.trim() : null;
}

/** Did the pane move? An unreadable `after` proves nothing, so it counts as "did not move". */
function moved(before: string, after: string | null): boolean {
  return after !== null && after !== before;
}

const UNREADABLE = "não consegui ler a posição do painel";

/**
 * Drive one pane's copy-mode.
 *
 * `action` is typed `string` on purpose: it arrives from the wire, and narrowing it HERE (rather
 * than trusting a caller's cast) is what makes the allowlist load-bearing.
 */
export async function scrollBack(
  name: string,
  action: string,
  run: TmuxRunner = execFileRunner,
): Promise<ScrollResult> {
  // GUARDS FIRST. Nothing below this line may spawn until both pass — that ordering IS the feature.
  if (!isSafeSessionName(name)) return { ok: false, found: false, error: "nome de sessão inválido" };
  if (!isScrollAction(action)) return { ok: false, found: false, error: "ação desconhecida" };

  return action === "bottom" ? toBottom(name, run) : toLastPrompt(name, run);
}

/**
 * Back one prompt: enter copy-mode, note where we are, search backwards for the server's pattern,
 * note where we ended up. `copy-mode` comes BEFORE the baseline read on purpose — entering the mode
 * is itself what turns an empty position into `0`, so reading first would make every no-match look
 * like a jump. Re-entering an already-in-copy-mode pane is a no-op, which is what lets repeated
 * presses walk further and further back.
 */
async function toLastPrompt(name: string, run: TmuxRunner): Promise<ScrollResult> {
  // `-e` matters: it makes copy-mode EXIT on its own once the view scrolls back to the bottom. Without
  // it the pane stays in a mode the web page has no way out of — the "voltar ao fim" pill only
  // synthesizes wheel events, and a pane parked in copy-mode swallows every subsequent keystroke,
  // including a `claude_send` or a steward dispatch. That turns a read-only convenience into a way to
  // silently wedge the operator's pane.
  const entered = await call(run, ["copy-mode", "-e", "-t", name]);
  if (!entered.ok) return { ok: false, found: false, error: entered.error };

  const before = await readPosition(run, name);
  if (before === null) return { ok: false, found: false, error: UNREADABLE };

  const searched = await call(run, ["send-keys", "-t", name, "-X", "search-backward", promptPattern()]);
  if (!searched.ok) return { ok: false, found: false, error: searched.error };

  const found = moved(before, await readPosition(run, name));
  // Nothing matched ⇒ leave the pane exactly as we found it. The default pattern targets the Claude
  // `> ` prompt, so on a plain bash pane every press misses — and parking it in copy-mode on a miss
  // would be a side effect the operator never asked for and cannot see.
  if (!found) await call(run, ["send-keys", "-t", name, "-X", "cancel"]);

  return { ok: true, found };
}

/**
 * Back to the live bottom: `-X cancel` leaves copy-mode. The cancel failing is TOLERATED here and
 * only here — on a pane that is not in a mode tmux refuses the key, and "not in a mode" is exactly
 * the end state the operator asked for. A pane we cannot even read the position of is a different
 * story (killed session, no tmux server) and still reports `ok: false`.
 */
async function toBottom(name: string, run: TmuxRunner): Promise<ScrollResult> {
  const before = await readPosition(run, name);
  if (before === null) return { ok: false, found: false, error: UNREADABLE };

  await call(run, ["send-keys", "-t", name, "-X", "cancel"]);

  return { ok: true, found: moved(before, await readPosition(run, name)) };
}
