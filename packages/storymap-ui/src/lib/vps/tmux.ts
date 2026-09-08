// Server-side tmux helpers for the /processes page + terminal handoff. Mirrors the
// tmux usage in mcp/dev-tools.ts, but as a reusable module the page/actions can import.
//
// ALL args go through execFile arrays (shell:false) — never string interpolation — and
// session names are validated to a strict slug, so nothing here can inject a command. A
// compound command (e.g. `claude --resume <id>; exec bash`) is run via `bash -lc <one arg>`
// so the runner-side shell never parses caller data.
//
// SERVER-ONLY (node:child_process). Never import from a client component.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isClaudeProcess, parseProcessTable, type PaneOwner, type ProcRow } from "./process-attribution";

const pexec = promisify(execFile);

/** tmux session names: slug charset, bounded length. Rejects anything that could be a flag. */
const SAFE_SESSION = /^[A-Za-z0-9_-]{1,80}$/;
export function isSafeSessionName(name: string): boolean {
  return SAFE_SESSION.test(name) && !name.startsWith("-");
}

/**
 * A convenção de nome da sessão MASTER — `claude`, `claude-jonatas`, … — a sessão de CONTROLE da caixa.
 *
 * Mora aqui (e não no kill-guard, que a tinha) porque agora TRÊS caminhos precisam da mesma régua: o
 * guarda de kill (classe 1), a exclusão de colagem do overlay de feedback, e a entrega de texto do MCP
 * (`planSessionDelivery`). Duas cópias da convenção seriam duas verdades, e a que apodrece é sempre a
 * que o próximo caminho copiou.
 */
export const MASTER_SESSION_PREFIX = /^claude(-|$)/;

/** É a sessão MASTER (a que pilota a caixa)? PURA. */
export function isMasterSessionName(name: string, prefix: RegExp = MASTER_SESSION_PREFIX): boolean {
  return prefix.test(name);
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  /** epoch ms the session was created, or null */
  createdAt: number | null;
  /** epoch ms of last activity, or null */
  activityAt: number | null;
  /** cwd of the active pane */
  path: string;
  /** foreground command in the active pane (e.g. `claude`, `bash`) — the shell-vs-agent hint */
  command: string;
  /** active pane title (OSC-2 / tmux) — only meaningful when a program/agent intentionally set it */
  paneTitle: string;
  /**
   * Geometria do pane ativo (`"120x30"`), ou "" quando o tmux não a devolveu.
   *
   * Existe por UM motivo, e ele não é cosmético: quem ANEXA a um terminal (abrir `/terminal`) o
   * redimensiona, o programa de tela cheia lá dentro recebe SIGWINCH e REPINTA — e um repaint muda a
   * tela sem que ninguém tenha produzido nada. Sem saber a geometria, o vigia lia esse repaint como
   * "está trabalhando", e uma sessão dormente virava viva no instante em que o operador olhava para
   * ela (o que reprotegia o kill justamente na tela onde ele foi encerrá-la). Ver `stepAttention`.
   */
  geometry: string;
}

async function tmux(args: string[], timeoutMs = 8_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await pexec("tmux", args, { timeout: timeoutMs, maxBuffer: 4_000_000 });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (e: any) {
    return {
      code: typeof e?.code === "number" ? e.code : 1,
      stdout: String(e?.stdout ?? ""),
      stderr: String(e?.stderr ?? e?.message ?? ""),
    };
  }
}

/** List all tmux sessions on the box (empty array if tmux is unavailable / no sessions). */
export async function listSessions(): Promise<TmuxSession[]> {
  const r = await tmux([
    "list-sessions",
    "-F",
    // TAB-separated; `pane_title` LAST because it can carry unexpected chars (tmux rewrites control
    // bytes as octal TEXT, so a fixed-arity split stays safe — same convention as lib/terminal/tmux).
    // `pane_width`/`pane_height` ANTES do título (que vai por último por carregar bytes inesperados).
    "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{pane_title}",
  ]);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, created, activity, panePath, command, w, h, paneTitle] = line.split("\t");
      return {
        name: name ?? "",
        windows: Number(windows) || 1,
        attached: attached === "1",
        createdAt: created ? Number(created) * 1000 : null,
        activityAt: activity ? Number(activity) * 1000 : null,
        path: panePath ?? "",
        command: command ?? "",
        paneTitle: paneTitle ?? "",
        geometry: w && h ? `${w}x${h}` : "",
      };
    })
    .filter((s) => s.name);
}

export async function hasSession(name: string): Promise<boolean> {
  if (!isSafeSessionName(name)) return false;
  return (await tmux(["has-session", "-t", name])).code === 0;
}

/**
 * A resposta do tmux a "quais sessões existem AGORA?", **preservando o sinal que {@link listSessions}
 * perde** — ela devolve `[]` tanto para "zero sessões" quanto para "a sonda não respondeu".
 *
 * Essa ambiguidade não é acadêmica: quem lê a lista para decidir QUEM MORREU (`reconcileFleet`) trata
 * ausência como óbito e LIBERA os claims. Um `tmux list-sessions` que estoure o timeout de 8s sob carga
 * — ou um fork que falhe — declararia a frota INTEIRA morta e entregaria os cards de agentes que estão
 * trabalhando neste instante. É a mesma direção de erro que `gatherKillSnapshots` já recusa a correr.
 *
 * Por isso três respostas, não duas: `ok` com nomes, `ok` com lista vazia (o tmux RESPONDEU que não há
 * servidor/sessão — óbito é o fato), e `!ok` (não sei — quem consome não infere nada).
 */
export type TmuxProbe = { ok: true; names: string[] } | { ok: false; reason: string };

/** PURA — classifica a saída de `tmux list-sessions`. Exportada para o teste de exaustividade. */
export function classifyListSessions(r: { code: number; stdout: string; stderr: string }): TmuxProbe {
  if (r.code === 0) {
    return {
      ok: true,
      names: r.stdout
        .split("\n")
        .map((line) => line.split("\t")[0]?.trim() ?? "")
        .filter(Boolean),
    };
  }
  // O tmux RESPONDEU "não há servidor/sessão". Isso é um FATO sobre o mundo, não uma falha de sonda:
  // sem servidor, todo pane que a frota registrou realmente morreu junto.
  if (/no server running|no sessions|error connecting to/i.test(r.stderr)) return { ok: true, names: [] };
  return { ok: false, reason: r.stderr.trim() || `tmux list-sessions saiu com código ${r.code}` };
}

/** Sonda as sessões vivas mantendo a distinção entre "zero" e "não sei". */
export async function probeLiveTmuxSessions(): Promise<TmuxProbe> {
  return classifyListSessions(await tmux(["list-sessions", "-F", "#{session_name}"]));
}

/**
 * Create a DETACHED tmux session named `name`, running `shellCommand` via `bash -lc`
 * (so a compound command with `;`/`&&` works) in `cwd`. No-op-safe if it already exists
 * (returns ok:true, created:false). The command is a single argv element to bash.
 */
export async function ensureDetachedSession(
  name: string,
  shellCommand: string,
  cwd: string,
): Promise<{ ok: boolean; created: boolean; error?: string }> {
  if (!isSafeSessionName(name)) return { ok: false, created: false, error: "nome de sessão inválido" };
  if (await hasSession(name)) return { ok: true, created: false };
  const r = await tmux(["new-session", "-d", "-s", name, "-c", cwd, "bash", "-lc", shellCommand]);
  if (r.code !== 0) return { ok: false, created: false, error: r.stderr.trim() || "falha ao criar sessão (tmux disponível?)" };
  return { ok: true, created: true };
}

export async function killSession(name: string): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeSessionName(name)) return { ok: false, error: "nome de sessão inválido" };
  const r = await tmux(["kill-session", "-t", name]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || "sessão não encontrada" };
}

/**
 * Does tmux session `name` have a live Claude AGENT in its pane's process subtree? IDENTITY check
 * (`isClaudeProcess` — "the kernel is executing the claude binary", the SAME guard the kill path uses),
 * NOT a command-name grep: a shell whose foreground shows `node`/`less`/`vim` can't spoof it, and a
 * Claude agent that shows as `node` is correctly admitted. Walks children by ppid from each pane pid.
 * Fail-closed — false on any doubt (no panes, empty process table, no Claude in the subtree).
 */
export async function sessionRunsClaude(name: string): Promise<boolean> {
  if (!isSafeSessionName(name)) return false;
  const [panes, procs] = await Promise.all([listPaneOwners(), listProcesses()]);
  const panePids = panes.filter((p) => p.session === name).map((p) => p.pid);
  if (!panePids.length || !procs.length) return false;
  const claudePids = new Set(procs.filter((p) => isClaudeProcess(p)).map((p) => p.pid));
  if (!claudePids.size) return false;
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) childrenOf.set(p.ppid, [...(childrenOf.get(p.ppid) ?? []), p.pid]);
  const seen = new Set<number>();
  const queue = [...panePids];
  while (queue.length) {
    const pid = queue.shift() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (claudePids.has(pid)) return true;
    for (const c of childrenOf.get(pid) ?? []) queue.push(c);
  }
  return false;
}

/**
 * Neutraliza bytes de controle de terminal: mantém TAB, NEWLINE e texto imprimível, e derruba todo o
 * resto dos controles C0 + DEL — **inclusive ESC**, para que nenhum payload consiga emitir sequência de
 * escape nem forjar os marcadores de bracketed paste. PURA.
 */
export function sanitizeTerminalText(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || (c >= 32 && c !== 127);
    })
    .join("");
}

/**
 * COMO um payload deve chegar no pane:
 *  • `paste` — bracketed paste (`set-buffer` + `paste-buffer -p`): o bloco inteiro entra INERTE no input
 *    do agente, com as quebras de linha preservadas COMO TEXTO. É o único modo correto para um Claude.
 *  • `keys`  — `send-keys -l`: os caracteres são DIGITADOS. Num shell, cada `\n` EXECUTA a linha.
 */
export type DeliveryMode = "paste" | "keys";

export interface DeliveryTarget {
  /** o pane roda um agente Claude (IDENTIDADE via `sessionRunsClaude`, nunca grep de linha de comando) */
  runsClaude: boolean;
  /** é a sessão MASTER (`claude*`), a que pilota a caixa */
  isMaster: boolean;
}

export type DeliveryPlan =
  | { ok: true; mode: DeliveryMode; text: string; lines: number }
  | { ok: false; reason: string };

/**
 * A POLÍTICA de entrega de texto num pane — pura, e por isso exaustivamente testável.
 *
 * O DEFEITO que ela existe para matar: `claude_send` entregava tudo com `send-keys -l` cru. Num agente
 * Claude, um prompt multi-linha virava N SUBMITS (cada `\n` age como Enter no composer, então o agente
 * recebia o primeiro parágrafo e respondia enquanto o resto ainda chegava). Num SHELL — e `term_new`
 * cria shells `cop-*` de propósito — cada linha virava um COMANDO EXECUTADO. O mesmo arquivo já
 * documentava `send-keys -l` como "the naive approach" e já tinha a cura (bracketed paste), usada só
 * pelo overlay de feedback; a superfície MCP nunca a herdou.
 *
 * As três decisões, e por que cada uma NÃO remove capacidade:
 *  1. MASTER exige `confirmMaster` — não é proibição, é o mesmo padrão explícito de `confirmMain`
 *     (git_commit_push) e `confirmReset` (reconcile_stage). O acidente morre, a capacidade fica.
 *  2. Agente Claude → SEMPRE `paste`. Não há caso em que digitar tecla a tecla num composer seja melhor.
 *  3. Shell multi-linha exige `multiline` — porque ali "N linhas" significa "N comandos", e quem
 *     escreveu um prompt para um agente e errou o alvo precisa saber ANTES, não depois de executar.
 */
export function planSessionDelivery(
  target: DeliveryTarget,
  rawText: string,
  opts?: { confirmMaster?: boolean; multiline?: boolean },
): DeliveryPlan {
  const text = sanitizeTerminalText(rawText);
  if (!text.trim()) return { ok: false, reason: "texto vazio (ou vazio depois de remover bytes de controle)" };

  if (target.isMaster && opts?.confirmMaster !== true) {
    return {
      ok: false,
      reason:
        "alvo é a sessão MASTER (`claude*`), a que pilota a caixa — um texto digitado nela vira comando do " +
        "orquestrador, não mensagem para um agente de trabalho. Se é MESMO o alvo, repita com confirmMaster:true.",
    };
  }

  const lines = text.split("\n").length;
  if (target.runsClaude) return { ok: true, mode: "paste", text, lines };

  if (lines > 1 && opts?.multiline !== true) {
    return {
      ok: false,
      reason:
        `alvo é um SHELL (não há agente Claude no pane) e o texto tem ${lines} linhas — num shell cada quebra ` +
        `EXECUTA a linha como comando. Se você queria falar com um agente, confira a sessão em claude_sessions; ` +
        `se queria mesmo rodar ${lines} comandos, repita com multiline:true.`,
    };
  }
  return { ok: true, mode: "keys", text, lines };
}

/** Cola um bloco INERTE (bracketed paste) no pane. O `-d` descarta o buffer depois. */
async function pasteBlock(name: string, text: string, bufPrefix: string): Promise<{ ok: boolean; error?: string }> {
  const buf = `${bufPrefix}-${name}`;
  const set = await tmux(["set-buffer", "-b", buf, "--", text]);
  if (set.code !== 0) return { ok: false, error: set.stderr.trim() || "falha ao preparar o buffer" };
  const paste = await tmux(["paste-buffer", "-b", buf, "-t", name, "-p", "-d"]);
  if (paste.code !== 0) return { ok: false, error: paste.stderr.trim() || "falha ao colar no terminal" };
  return { ok: true };
}

/**
 * Deliver `text` into a CLAUDE-agent tmux session as a bracketed PASTE, so a multi-line payload lands in
 * the agent's input as ONE INERT block — never typed keystrokes, and with NO implicit Enter (the operator
 * reviews and submits). REFUSES any session not running a Claude agent (identity allowlist) — so it can
 * NEVER type into a shell, esp. the ttyd ROOT pane. Used by the feedback-overlay terminal round-trip.
 *
 * Security: `send-keys -l` (the naive approach) would emit literal newlines that act as Enter in the
 * target REPL → command injection into a shell. The identity allowlist (never a shell) is the primary
 * guard; bracketed paste + no auto-submit are defense-in-depth.
 */
export async function sendToClaudeSession(
  name: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeSessionName(name)) return { ok: false, error: "nome de sessão inválido" };
  if (!text.trim()) return { ok: false, error: "texto vazio" };
  if (!(await sessionRunsClaude(name))) {
    return { ok: false, error: `sessão "${name}" não está rodando um agente Claude — envio recusado (o round-trip nunca digita num shell)` };
  }
  const safe = sanitizeTerminalText(text);
  if (!safe.trim()) return { ok: false, error: "texto vazio após sanitização" };
  return pasteBlock(name, safe, "ah-fb");
}

/**
 * As TECLAS que `claude_keys` sabe mandar — vocabulário FECHADO, em nomes do tmux.
 *
 * POR QUE UMA LISTA E NÃO BYTES. `claude_send` remove todo byte de controle (`sanitizeTerminalText`),
 * e com razão: ESC e companhia numa sessão alheia são injeção. A consequência medida em 2026-08-28,
 * numa simulação de onboarding: uma sessão que cai num FORMULÁRIO de opções fica inalcançável de
 * fora — os números alternam o item sob o cursor, navegar exige Tab/setas, e o canal as removia. Uma
 * sessão presa assim contradiz duas promessas do produto: o `/terminal` autenticado e o
 * «destravar do celular».
 *
 * A saída não é afrouxar a sanitização — é NOMEAR. O `tmux send-keys` já aceita nome de tecla (o
 * `Enter` do submit sempre foi assim), então o chamador escolhe de um vocabulário conhecido e o byte
 * nunca vem dele. Um nome fora da lista é RECUSADO, nunca repassado.
 *
 * O QUE FICA DE FORA, DE PROPÓSITO: `C-c`, `C-d`, `C-z`. Interromper, encerrar e suspender não são
 * navegação — são outra classe, e ela já tem porta (`claude_kill`, por PID/sessão, com o seu próprio
 * consentimento). Uma tool de navegação que também mata é uma tool que ninguém consegue autorizar
 * com precisão.
 */
export const TECLAS_PERMITIDAS = [
  "Up", "Down", "Left", "Right",
  "Tab", "BTab",
  "Enter", "Space", "Escape",
  "Home", "End", "PageUp", "PageDown",
] as const;

export type TeclaPermitida = (typeof TECLAS_PERMITIDAS)[number];

/** Teto de teclas por chamada: navegar um formulário são poucas; centenas são outra intenção. */
export const MAX_TECLAS_POR_CHAMADA = 24;

export type KeyPlan =
  | { ok: true; keys: TeclaPermitida[] }
  | { ok: false; reason: string };

/**
 * PURA: decide se a sequência pode ser enviada. Separada da execução pelo mesmo motivo que
 * {@link planSessionDelivery} — a regra é testável sem tmux, e é a regra que carrega a segurança.
 */
export function planKeySequence(
  target: { isMaster: boolean },
  keys: readonly string[],
  opts?: { confirmMaster?: boolean },
): KeyPlan {
  if (keys.length === 0) return { ok: false, reason: "nenhuma tecla — não há o que enviar" };
  if (keys.length > MAX_TECLAS_POR_CHAMADA) {
    return {
      ok: false,
      reason:
        `${keys.length} teclas numa chamada (teto ${MAX_TECLAS_POR_CHAMADA}). Navegar um formulário são ` +
        `poucas teclas; uma rajada é outra intenção — divida em chamadas e LEIA a tela entre elas.`,
    };
  }
  const permitidas = new Set<string>(TECLAS_PERMITIDAS);
  const recusadas = keys.filter((k) => !permitidas.has(k));
  if (recusadas.length > 0) {
    return {
      ok: false,
      reason:
        `tecla fora do vocabulário: ${[...new Set(recusadas)].join(", ")}. ` +
        `Permitidas: ${TECLAS_PERMITIDAS.join(", ")}. ` +
        `Interromper/encerrar/suspender (C-c, C-d, C-z) NÃO estão aqui de propósito — não são navegação; ` +
        `para encerrar uma sessão use claude_kill.`,
    };
  }
  if (target.isMaster && opts?.confirmMaster !== true) {
    return {
      ok: false,
      reason:
        "esta é a sessão MASTER (a que pilota a caixa). Mandar tecla nela pode responder um prompt que " +
        "não é seu — passe confirmMaster:true se é isso mesmo.",
    };
  }
  return { ok: true, keys: keys as TeclaPermitida[] };
}

export type KeyResult = { ok: true; keys: TeclaPermitida[] } | { ok: false; error: string };

/**
 * Manda uma sequência de TECLAS NOMEADAS para uma sessão tmux. É o par de {@link deliverToSession}
 * para quem precisa NAVEGAR em vez de digitar: formulário de opções, menu, confirmação.
 *
 * Uma tecla por invocação de `send-keys` de propósito: em lote o tmux entregaria tudo antes de a TUI
 * repintar, e a segunda tecla agiria sobre um estado que o chamador não viu. Navegar às cegas é
 * exatamente o que produz o clique errado.
 */
export async function sendKeysToSession(
  name: string,
  keys: readonly string[],
  opts?: { confirmMaster?: boolean },
): Promise<KeyResult> {
  if (!isSafeSessionName(name)) return { ok: false, error: "nome de sessão inválido (use [A-Za-z0-9_-])." };
  if (!(await hasSession(name))) return { ok: false, error: `sessão "${name}" não encontrada` };

  const plan = planKeySequence({ isMaster: isMasterSessionName(name) }, keys, opts);
  if (!plan.ok) return { ok: false, error: plan.reason };

  for (const tecla of plan.keys) {
    const r = await tmux(["send-keys", "-t", name, tecla]);
    if (r.code !== 0) {
      return { ok: false, error: r.stderr.trim() || `falha ao enviar "${tecla}" para "${name}"` };
    }
  }
  return { ok: true, keys: plan.keys };
}

export type DeliveryResult =
  | { ok: true; mode: DeliveryMode; lines: number; sentChars: number; submitted: boolean }
  | { ok: false; error: string };

/**
 * A entrega de texto do MCP (`claude_send`): decide o modo por {@link planSessionDelivery} e o executa.
 * Diferente de {@link sendToClaudeSession}, ela ADMITE um shell como alvo (o fluxo `term_new` depende
 * disso) e SUBMETE por padrão — o que muda é que agora um shell só recebe multi-linha com consentimento,
 * e um agente Claude recebe o bloco inteiro de uma vez em vez de fatiado por Enter.
 */
export async function deliverToSession(
  name: string,
  rawText: string,
  opts?: { submit?: boolean; confirmMaster?: boolean; multiline?: boolean },
): Promise<DeliveryResult> {
  if (!isSafeSessionName(name)) return { ok: false, error: "nome de sessão inválido (use [A-Za-z0-9_-])." };
  if (!(await hasSession(name))) return { ok: false, error: `sessão "${name}" não encontrada` };

  const plan = planSessionDelivery(
    { runsClaude: await sessionRunsClaude(name), isMaster: isMasterSessionName(name) },
    rawText,
    opts,
  );
  if (!plan.ok) return { ok: false, error: plan.reason };

  if (plan.mode === "paste") {
    const pasted = await pasteBlock(name, plan.text, "ah-send");
    if (!pasted.ok) return { ok: false, error: pasted.error ?? "falha ao colar" };
  } else {
    const sk = await tmux(["send-keys", "-t", name, "-l", "--", plan.text]);
    if (sk.code !== 0) return { ok: false, error: sk.stderr.trim() || `falha ao digitar em "${name}"` };
  }

  const submit = opts?.submit !== false;
  if (submit) {
    const enter = await tmux(["send-keys", "-t", name, "Enter"]);
    if (enter.code !== 0) return { ok: false, error: enter.stderr.trim() || "texto entregue, mas o Enter falhou" };
  }
  return { ok: true, mode: plan.mode, lines: plan.lines, sentChars: plan.text.length, submitted: submit };
}

/**
 * The box's FULL process table (pid/ppid/etime/comm/args), best-effort (empty on `ps` failure).
 *
 * Two `ps` invocations on purpose: `comm` can contain a space (`tmux: server`), so a single
 * `pid,ppid,etime,comm,args` cannot be column-split unambiguously. Each table therefore puts the
 * space-bearing field LAST, and `parseProcessTable` joins them by pid. The whole table (not just
 * the claude rows) is required — process ANCESTRY is what tells an agent apart from its wrapper.
 */
export async function listProcesses(): Promise<ProcRow[]> {
  try {
    const [comm, args] = await Promise.all([
      pexec("ps", ["-eo", "pid=,ppid=,etime=,comm="], { timeout: 8_000, maxBuffer: 8_000_000 }),
      pexec("ps", ["-eo", "pid=,args="], { timeout: 8_000, maxBuffer: 8_000_000 }),
    ]);
    return parseProcessTable(String(comm.stdout), String(args.stdout));
  } catch {
    return [];
  }
}

/** Each tmux pane's process — the root of everything running INSIDE that session. */
export async function listPaneOwners(): Promise<PaneOwner[]> {
  const r = await tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [session, pid] = line.split("\t");
      return { session: session ?? "", pid: Number(pid) };
    })
    .filter((p) => p.session && Number.isInteger(p.pid) && p.pid > 0);
}

/**
 * The live Claude AGENT processes on the box — identity-checked (`isClaudeProcess`), not grepped.
 *
 * This is also the kill guard for `killProcessAction`: because membership now means "the kernel is
 * executing the claude binary", a pid whose command line merely MENTIONS claude (any Bash tool call
 * sourcing `/root/.claude/…`) can no longer be killed through the /processes UI.
 */
export async function listClaudeProcesses(): Promise<ProcRow[]> {
  return (await listProcesses()).filter(isClaudeProcess);
}
