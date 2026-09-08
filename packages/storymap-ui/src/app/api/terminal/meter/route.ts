// The web terminal's meter: how much CONTEXT the Claude of EACH open pane has burned, and how much
// QUOTA the account has left. Two questions the operator previously had to leave the terminal to
// answer. The page sends one `b=` per open pane and paints the context in that pane's own header —
// a reading for the focused pane alone left the operator blind on the other three, which is the
// whole point of having four of them on screen.
//
// A SEPARATE endpoint from /api/terminal/sessions on purpose, and this is the single most important
// decision here. That one is polled every 5s and already costs several tmux/ps spawns plus a read of
// every card on every board (~350-600ms measured). Folding a transcript read into it would push the
// request past its own poll interval, and the page's `pollInFlight` guard would then start SKIPPING
// polls in silence — the bar would freeze with no error anywhere. This endpoint is polled at 15s,
// pauses while the tab is hidden, and costs ~15-20ms per pane on a cache miss (one bounded ~256KB
// pread each, over ONE memoised box snapshot).
//
// Reachable only through the app's own session gate — the same trust boundary as the board and the
// sibling terminal routes. Every `b` is validated as a slug and used ONLY as a map key: none of them
// ever reaches a shell.
//
// Honesty contract: every field degrades to an explicit absent state. `context: null` always comes
// with a `contextAbsentReason` that says WHICH kind of absence it is, because "this is a bash shell
// with no context at all" and "there is a live agent I could not identify" must not render alike.
// Nothing here ever guesses: see pane-claude-map.ts for the mtime attribution that was measured
// lying by 2.6x and rejected.

import { statSync } from "node:fs";
import { isSafeSessionName } from "@/lib/vps/tmux";
import { resolvePaneLive, type ContextAbsentReason, type PaneClaude } from "@/lib/vps/pane-claude-map";
import { readSessionContext, readTranscriptIdle } from "@/lib/vps/transcript-usage";
import { readQuota, type QuotaBlock } from "@/lib/vps/quota";
import { readRam } from "@/lib/vps/metrics";
import { classifyTmux } from "@/lib/vps/processes";
import { screenStillness } from "@/lib/terminal/attention-watch";
import { deriveWorkState, type StateSource, type WorkState } from "@/lib/vps/service-meters";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ContextPayload {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  limit: number | null;
  limitSource: string | null;
  pct: number | null;
  model: string | null;
  at: string | null;
  source: string;
  compacted: boolean;
}

/**
 * O ESTADO deste pane, pela MESMA régua da home e do /processes (`deriveWorkState`).
 *
 * Ele nasceu porque esta página — a única em que o operador está OLHANDO para o terminal — era a que
 * não dizia nada: a rota entregava `claude.status` cru, e a página o usava só para decidir se existia
 * um agente. Quem estivesse aqui não via nem "trabalhando" nem "aguardando você"; e se visse o flag
 * cru, veria a mentira de 42,6h que a régua existe para desarmar. `null` = não há agente neste pane
 * (um bash puro não tem estado a exibir).
 */
interface WorkPayload {
  state: WorkState;
  source: StateSource;
}

interface SessionPayload {
  name: string;
  context: ContextPayload | null;
  contextAbsentReason: ContextAbsentReason | null;
  claude: PaneClaude | null;
  work: WorkPayload | null;
  cost: { usd: number; tokens: number | null } | null;
}

/**
 * Cost, ONLY for a pane that is a card runner session (`card-<board>__<cardId>`), read straight from
 * the in-memory run registry — no fanout, no `listRunningServices()` (that is the expensive call).
 *
 * Card-less panes (shell, master, `cop-*`, `agent-*`, adhoc) get `null`, and the UI renders NO chip.
 * `$0.00` would be a different and false claim: it would say "this session cost nothing" when the
 * truth is "this kind of session has no cost telemetry at all".
 */
function costFor(name: string): SessionPayload["cost"] {
  if (!name.startsWith("card-")) return null;
  // Split on the FIRST `__`, rather than matching an underscore-free board with a regex: `cardSessionName`
  // joins board and cardId with `__`, and a board id that itself contains `_` made the regex fail outright,
  // dropping the cost chip — which the doc-comment below defines as the claim "this session has no cost".
  const rest = name.slice("card-".length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep + 2 >= rest.length) return null;
  const board = rest.slice(0, sep);
  const cardId = rest.slice(sep + 2);
  try {
    const usage = getRunnerRegistry().getUsage(board, cardId);
    if (!usage || usage.costUSD == null) return null;
    return { usd: usage.costUSD, tokens: usage.tokens ?? null };
  } catch {
    return null;
  }
}

/**
 * O estado, pela régua da casa, com as três testemunhas que esta rota consegue reunir: o flag do
 * pidfile, a tela (leitura de memória do vigia — zero IO) e o transcript.
 *
 * `claude == null` ⇒ `null`: um bash puro não tem estado a exibir, e inventar "ocioso" para ele seria
 * dizer que existe um agente parado ali. O `kind` sai de `classifyTmux` (a mesma classificação que a
 * lista de processos usa), então uma sessão de card não é lida como um shell qualquer.
 */
function workOf(
  name: string,
  claude: PaneClaude | null,
  transcriptIdleMs: number | null,
  now: number,
): WorkPayload | null {
  if (!claude) return null;
  const statusUpdatedAt = claude.statusUpdatedAt;
  return deriveWorkState({
    status: "running",
    kind: classifyTmux(name).kind,
    claudeStatus: claude.status,
    screenStillMs: screenStillness(now).get(name) ?? null,
    transcriptIdleMs,
    flagAgeMs: statusUpdatedAt == null ? null : Math.max(0, now - statusUpdatedAt),
  });
}

async function buildSession(name: string): Promise<SessionPayload> {
  const cost = costFor(name);
  const now = Date.now();
  const res = await resolvePaneLive(name);
  if (!res.ok) {
    return {
      name,
      context: null,
      contextAbsentReason: res.reason,
      claude: res.claude,
      // Sem pane resolvido não há transcript para consultar — a régua fica com as testemunhas que
      // sobraram, e `null` ali significa "não medi", nunca "está parado".
      work: workOf(name, res.claude, null, now),
      cost,
    };
  }

  const pane = res.pane;
  const [ctx, transcriptIdleMs] = await Promise.all([
    // `pane.cwd` é o diretório em que a sessão FOI LANÇADA — a mesma chave com que o CLI indexa
    // `projects` no seu `~/.claude.json`, e por isso o que destrava a janela de 1M para um pane sem pin.
    readSessionContext(pane.transcriptPath, pane.model, pane.cwd),
    readTranscriptIdle(pane.transcriptPath, now).catch(() => null),
  ]);
  const work = workOf(name, pane.claude, transcriptIdleMs, now);
  if (!ctx) {
    // readSessionContext collapses two different absences into null. One `stat` (sub-millisecond)
    // tells them apart so the UI can say "transcript indisponível" vs "sessão ainda sem turno do
    // modelo" — a brand-new session is not a broken one.
    let exists = false;
    try {
      exists = statSync(pane.transcriptPath).isFile();
    } catch {
      exists = false;
    }
    return {
      name,
      context: null,
      contextAbsentReason: exists ? "no-usage" : "unreadable",
      claude: pane.claude,
      work,
      cost,
    };
  }

  return {
    name,
    context: {
      tokens: ctx.contextTokens,
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      limit: ctx.limit,
      limitSource: ctx.limitSource,
      pct: ctx.pct,
      model: ctx.model,
      at: ctx.at,
      source: pane.source,
      compacted: ctx.compacted,
    },
    contextAbsentReason: null,
    claude: pane.claude,
    work,
    cost,
  };
}

/**
 * How many panes one poll may ask about. The grid caps at 4 (`MAX_PANES` in the terminal page); the
 * slack absorbs a stale tab that still has an old layout open. Anything beyond is truncated rather
 * than refused: the extra names cost a transcript read each, and a 400 would blank the whole bar.
 */
const MAX_SESSIONS = 8;

/**
 * The names this poll is about, in the order the page asked. Repeated `b=` params AND a
 * comma-separated `b=` are both accepted — the page sends one pane per param, but a hand-typed URL
 * naturally uses commas and there is no reason for that to 400.
 */
function requestedNames(url: URL): string[] {
  const raw: string[] = [];
  for (const v of url.searchParams.getAll("b")) {
    for (const part of v.split(",")) raw.push(part.trim());
  }
  const out: string[] = [];
  for (const n of raw) {
    if (!n || out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_SESSIONS) break;
  }
  return out;
}

export async function GET(request: Request): Promise<Response> {
  let names: string[] = [];
  try {
    names = requestedNames(new URL(request.url));
  } catch {
    names = [];
  }
  if (!names.length || !names.every(isSafeSessionName)) {
    return Response.json({ ok: false, error: "nome de terminal inválido" }, { status: 400 });
  }

  // EVERY open pane in ONE request, not one request per pane. The context reading is per-pane by
  // nature (each pane holds a different Claude), but the expensive part — the tmux/ps/pidfile box
  // snapshot behind `resolvePaneLive` — is memoised for 5s and therefore shared by all of them, so N
  // panes cost one snapshot plus N bounded transcript reads (~15-20ms each). Fanning out to N HTTP
  // polls would instead multiply the quota/RAM reads by N for no new information.
  //
  // allSettled, not all: the context and the quota are independent readings, and a box whose
  // ccusage/proxy is down must still report the context (and vice-versa). One failure nulls ONE
  // block, never the response — and one pane that throws never blanks its neighbours.
  // RAM rides this poll (one /proc/meminfo read, sub-millisecond) instead of the terminal page
  // opening a second endpoint: the box running out of memory is the thing that kills the very
  // agents these panes are watching, so it belongs beside the quota, not a click away.
  const [sessionsRes, quotaRes, ramRes] = await Promise.allSettled([
    Promise.all(
      names.map((n) =>
        buildSession(n).catch(
          (): SessionPayload => ({
            name: n,
            context: null,
            contextAbsentReason: "unreadable",
            claude: null,
            work: null,
            cost: null,
          }),
        ),
      ),
    ),
    readQuota(),
    readRam(),
  ]);

  const sessions: SessionPayload[] =
    sessionsRes.status === "fulfilled"
      ? sessionsRes.value
      : names.map((n) => ({
          name: n,
          context: null,
          contextAbsentReason: "unreadable" as const,
          claude: null,
          work: null,
          cost: null,
        }));

  // `session` (singular) stays: it is the FIRST name asked — the focused pane — and a tab that was
  // loaded before this deploy keeps reading exactly the field it knows.
  const session: SessionPayload = sessions[0];

  const quota: QuotaBlock | null = quotaRes.status === "fulfilled" ? quotaRes.value : null;
  const quotaError =
    quotaRes.status === "rejected"
      ? "falha ao ler a cota"
      : quotaRes.value === null
        ? "o medidor de cota não respondeu (ccusage ou proxy fora do ar, ou ainda sem janela aberta)"
        : null;

  const ram = ramRes.status === "fulfilled" ? ramRes.value : null;

  return Response.json(
    { ok: true, at: new Date().toISOString(), session, sessions, quota, quotaError, ram },
    { headers: { "cache-control": "no-store" } },
  );
}
