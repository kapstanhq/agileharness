// session-spawn — WS-6.2: `claude_new` ORIENTADO A TRABALHO. The AgileHarness stops being a place where the
// operator hand-rolls tmux and becomes the SPAWNER of the fleet: a session is born with an identity, a tree,
// a claim, a role, a model and a contract — or it is REFUSED with a reason and the queue.
//
// What this module owns (the MCP tool in dev-tools.ts is only the surface over it):
//   • ADMISSION  — a code role competes for the box (cap + the HEAVY lane's thresholds); a refusal names WHO
//                  is holding it, so the caller can wait, re-prioritise, or take card-less work.
//   • ISOLATION  — a code role gets a worktree through WS-1's ONE door (openSessionWorktree), never `git` by
//                  hand: the branch mint, the base and the base-ref stay in one auditable place.
//   • EXCLUSION  — a card gets a claim (WS-4) held by the LOGICAL agent, so it survives recycling.
//   • CONTRACT   — the spawn prompt already CARRIES the rules (your tree, board-data via MCP, submit through
//                  the train, never the runtime checkout). A rule an agent has to go looking for is a rule it
//                  will break at 2am.
//   • AUTHORITY  — G12: the session mounts the AgileHarness MCP with the SCOPED `orch` token, never the operator's
//                  `full` one. Without a token it could not honour "board-data via MCP"; with `full` it could
//                  deploy and delete.
//
// ── FOUR FACTS ABOUT THE CLI + TMUX, EACH VERIFIED ON THE BOX, EACH OF WHICH SILENTLY BREAKS THE SPAWN ──────
//
//  1. `--mcp-config <configs...>` is VARIADIC. `claude --mcp-config <path> "<prompt>"` reads the PROMPT as a
//     second config path and dies with `MCP config file not found: <prompt>`. The prompt therefore goes FIRST,
//     as the positional (see {@link buildSessionClaudeArgs}) — and no flag may ever be appended after it.
//  2. tmux does NOT give a new session the spawning process's env. The session env comes from the tmux SERVER
//     (started long ago) + `update-environment`; a var exported here arrives as ABSENT (measured). So the MCP
//     token CANNOT ride the env of the caller, which is why it rides a 0600 config file instead (`-e` would
//     work but puts the secret in argv, readable by every `ps` on the box).
//  3. Workspace trust INHERITS into subdirectories of a trusted project. An agent tree lives at
//     `<repoRoot>/.worktrees/agent-<id>` — under the trusted repo — so no trust dialog blocks the session.
//     A tree OUTSIDE the repo root would hang forever on "Is this a project you trust?" with nobody to answer.
//  4. `--dangerously-skip-permissions` is NOT passed (it is a root footgun) — but inheriting the operator's
//     global `defaultMode: bypassPermissions` is NOT the escape this line used to claim. MEASURED (v0.8.0, CLI
//     2.1.281, as root): the guard fires on the ACTIVE MODE, flag or settings alike, and the session dies at birth
//     with "--dangerously-skip-permissions cannot be used with root/sudo privileges" → `session_lost` on every
//     conductor dispatch. The CLI's own escape is `IS_SANDBOX=1` — the one every headless spawn already sets when
//     root (engine needsSandboxEnv, peer-review). So the session command carries it EXACTLY in that case: root AND
//     the inherited mode is bypass ({@link hostNeedsRootBypass}); nowhere else (it changes other CLI behaviour).
//     It rides the COMMAND line, not the caller's env — fact 2: tmux would drop an exported var.
//
// The IO is injected (the engine's DI convention) so the decisions below are unit-testable with no tmux, no
// git and no service. SERVER-ONLY in production.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { buildOrchestratorMcpConfig } from "./orchestrator-spawn";
import { currentSessionProof } from "@/lib/storymap/mcp/session-proof";
import { CLAIM_TTL_SESSION_MS, sessionClaimActor, type CardClaim, type ClaimKind, type ClaimScope } from "./claims";
import {
  discardSessionWorktree,
  openSessionWorktree,
  registerSession,
  roleNeedsWorktree,
  sessionCardIds,
  updateSession,
  type AgentRole,
  type AgentSession,
  type FleetQueueRow,
  type SessionWorktreeDeps,
} from "./session-worktree";
import type { CardDriver, EffortLevel, ModelTier, SessionModel } from "@/lib/storymap/types";
import { conductorCommand } from "@/lib/storymap/driver";
import { CAPACITY_HELD_MARKER, type GateVerdict, type Initiator } from "./capacity-governor";
import { MCP_TOOLSET_HEADER, type McpToolset } from "@/lib/storymap/mcp/toolsets";

/** How the fleet names a session's tmux: `agent-<slug|short id>`. The `agent-` prefix is what tells the
 *  reaper, the /processes lanes and a human at a keyboard that the tool owns this session. */
export function sessionTmuxName(sessionId: string, slug?: string): string {
  const clean = (slug ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `agent-${clean || sessionId.slice(0, 8)}`;
}

// ── the ROLE → (claim kind, scope) map ───────────────────────────────────────────────────────────────────
//
// D8's exclusivity is per (card, kind) + card-exclusive for anything touching CODE. The map is small and
// CLOSED on purpose: a role that invents its own kind would be excluded from nothing.

/** What a session of this role reserves on its card. PURE. */
export function claimForRole(role: AgentRole): { kind: ClaimKind; scope: ClaimScope } {
  switch (role) {
    case "implement":
      // `both`: an implementer writes the code AND the card's own data (tasks done, findings) — the
      // card-exclusive axis, so a second implementer is refused.
      return { kind: "implement", scope: "both" };
    case "review":
      return { kind: "review", scope: "both" };
    case "triage":
      return { kind: "triage", scope: "board" };
    case "steward":
      return { kind: "steward", scope: "board" };
    case "free":
      // Open-ended work on a card is implementation until proven otherwise (it gets a tree for the same
      // reason — roleNeedsWorktree): claiming it weakly would let a second implementer in behind it.
      return { kind: "implement", scope: "both" };
  }
}

// ── the ROUTE (model, effort) ────────────────────────────────────────────────────────────────────────────

export interface SessionRoute {
  model?: SessionModel;
  effort?: EffortLevel;
  /** the one-line ARITHMETIC of why — the fleet view shows it, and "why is this on sonnet?" must be answerable. */
  why: string;
}

/**
 * WS-6.2/WS-7 — the (model, effort) a spawned session runs on. This is NOT a new routing axis (D10 forbids a
 * fourth door): it MAPS onto the doors that already exist, exactly as model-routing.ts's canonical table says.
 *
 *   • an explicit HUMAN override always wins — it is the operator on the keyboard, and a tool that argued with
 *     them would just be worked around (the effort still comes from the card's rule: overriding the tier is a
 *     statement about capability, not about how hard to think);
 *   • a session ON A CARD gets THE CARD'S OWN RULE — the same `resolveCardRoute` a headless run goes through
 *     (door 3, capped by the column and the card's route profile). "The same card, a different tier, because a
 *     human happened to spawn it" is precisely the unpredictability D10 exists to prevent;
 *   • CARD-LESS open-ended work (`free`/`implement`/`review` with no card) gets opus/high: nothing bounds it,
 *     so the reasoning has to;
 *   • `triage`/`steward` are mechanical by definition → sonnet/medium.
 *
 * `cardRoute` is INJECTED (the caller reads the card + the board config + the settings) so this stays pure.
 */
export function resolveSessionRoute(input: {
  role: AgentRole;
  override?: SessionModel;
  cardRoute?: { model?: ModelTier; effort?: EffortLevel } | null;
}): SessionRoute {
  if (input.override) {
    return {
      model: input.override,
      effort: input.cardRoute?.effort,
      why: `override explícito do chamador (${input.override}) — a escolha humana vence a derivação`,
    };
  }
  if (input.cardRoute && (input.cardRoute.model || input.cardRoute.effort)) {
    return {
      model: input.cardRoute.model,
      effort: input.cardRoute.effort,
      why: "a regra do próprio card (mesma derivação dos runs: coluna × complexidade × route profile)",
    };
  }
  if (input.role === "triage" || input.role === "steward") {
    return { model: "sonnet", effort: "medium", why: "papel mecânico (triagem/steward) — tier barato" };
  }
  return { model: "opus", effort: "high", why: "trabalho aberto sem card — nada limita o escopo, o raciocínio limita" };
}

// ── retry de rede ≠ pedido novo (F7) ─────────────────────────────────────────────────────────────────────

/** Janela em que dois spawns IDÊNTICOS são lidos como um pedido só (um retry), não como dois. */
export const SPAWN_RETRY_WINDOW_MS = 120_000;

/**
 * A sessão que um spawn IDÊNTICO acabou de criar — ou undefined.
 *
 * O DEFEITO: `claude_new` não tinha chave de idempotência. Uma chamada MCP que estoure o timeout do
 * intermediário (o conector remoto atravessa um proxy) é re-tentada pelo cliente, e o servidor spawna a
 * SEGUNDA sessão: dois tmux, duas árvores, duas vagas do cap gastas no mesmo trabalho. Trabalho COM card
 * se defendia sozinho (o claim recusa o segundo), mas trabalho SEM card — legítimo e comum (self-dev,
 * fix rápido) — não tinha nenhuma trava.
 *
 * A régua é a INTENÇÃO (papel + tarefa + card), não um token que o chamador precisaria inventar e
 * lembrar: um `claude_new` repetido com a MESMA tarefa dentro de 2 minutos é, na prática, sempre o mesmo
 * pedido chegando duas vezes. Fora da janela é um pedido novo e legítimo (o operador quis um segundo
 * agente na mesma tarefa) e passa. PURA.
 */
export function findRetrySpawn<T extends { role: AgentRole; task: string; board?: string; cardId?: string; openedAt: string }>(
  sessions: readonly T[],
  intent: { role: AgentRole; task: string; board?: string; cardId?: string },
  now: number,
  windowMs: number = SPAWN_RETRY_WINDOW_MS,
): T | undefined {
  return sessions.find((s) => {
    if (s.role !== intent.role || s.task !== intent.task) return false;
    if ((s.board ?? undefined) !== (intent.board ?? undefined)) return false;
    if ((s.cardId ?? undefined) !== (intent.cardId ?? undefined)) return false;
    const opened = Date.parse(s.openedAt);
    return Number.isFinite(opened) && now - opened >= 0 && now - opened <= windowMs;
  });
}

// ── the CONTRACT prompt ──────────────────────────────────────────────────────────────────────────────────

export interface SessionPromptInput {
  /**
   * A SLASH COMMAND that LEADS the prompt (`/harness-conductor demo/story-x`), so the CLI parses the first
   * user turn as that command and loads the skill — a command buried after the contract preamble would be
   * read as prose, and the session would only "maybe" invoke the skill. Everything after it (the contract)
   * reaches the skill as its arguments. Absent ⇒ the prompt is the contract alone (every other session).
   */
  command?: string;
  sessionId: string;
  agentId: string;
  role: AgentRole;
  task: string;
  board?: string;
  cardId?: string;
  cardTitle?: string;
  worktreePath?: string;
  branch?: string;
  /** WS-6.3 — this process REPLACES one that ran out of context; the tree/branch/claims are already ours. */
  handoff?: boolean;
  /**
   * Fase 7 — os ITENS do lote que esta sessão já segura além do card (`sessionCardIds` sem o líder). Só uma reciclagem
   * os tem: o processo novo precisa saber que os claims deles também são seus. Ausente/vazio ⇒ sessão de um card só.
   */
  batchCardIds?: readonly string[];
}

/**
 * The prompt the session WAKES UP holding. It carries the four things a fresh agent cannot look up and must
 * not guess: who it is, what the work is, where its tree is, and the rules of the road.
 *
 * The rules are stated as PROHIBITIONS with their reason, not as etiquette: "never edit the runtime checkout"
 * without "because it is the live service and a stray write clobbers it" is a rule an agent will helpfully
 * optimise away the moment its own tree seems inconvenient.
 */
export function buildSessionPrompt(i: SessionPromptInput): string {
  const lines: string[] = [];
  if (i.command) lines.push(i.command, "");
  lines.push(
    `Você é um agente da FROTA do AgileHarness (papel: ${i.role}; agentId: ${i.agentId.slice(0, 8)}; sessionId: ${i.sessionId}).`,
    "",
    `TAREFA: ${i.task}`,
  );
  if (i.board && i.cardId) {
    lines.push(
      `CARD: ${i.board}/${i.cardId}${i.cardTitle ? ` — ${i.cardTitle}` : ""} (o claim já é SEU; leia o card com get_card).`,
    );
    if (i.batchCardIds?.length) {
      lines.push(`LOTE: ${i.batchCardIds.map((id) => `${i.board}/${id}`).join(", ")} (itens do lote deste card — os claims também já são SEUS).`);
    }
  } else if (i.board) {
    lines.push(`BOARD: ${i.board} (trabalho sem card — legítimo; integra igual).`);
  }
  lines.push("");
  if (i.worktreePath) {
    lines.push(
      "SEU WORKTREE (trabalhe SÓ aqui):",
      `  ${i.worktreePath}   [branch ${i.branch ?? "?"}]`,
      "",
      "CONTRATO (não negociável):",
      `  1. CÓDIGO: só dentro de ${i.worktreePath}. NUNCA edite o checkout de runtime nem o worktree de stage —`,
      "     o runtime é o serviço VIVO (uma escrita solta o derruba) e o stage é a engrenagem interna do merge train.",
      "  2. BOARD-DATA urgente (status, findings, respostas): via MCP (update_card etc.) — aterrissa na hora.",
      "     O PRODUTO do trabalho (código + o card/sidecar que ele muda) vai no seu worktree e integra pelo train.",
      `  3. INTEGRAR: worktree_submit({sessionId:"${i.sessionId}"}). O train pina o sha e roda o gate; se voltar`,
      "     `returned-to-session`, o conflito é SEU: worktree_refresh, resolva, submeta de novo.",
      `  4. AO TERMINAR: worktree_discard({sessionId:"${i.sessionId}"}) libera sua vaga no cap da frota.`,
      "     Depois, suggest_work({board}) diz o próximo card livre (e adquira o claim antes de começar).",
    );
  } else {
    lines.push(
      "SEM WORKTREE: seu papel trabalha em board-data via MCP (get_card/update_card/move_card), não em código.",
      `Se o trabalho virar código, abra uma árvore isolada: worktree_open({task:"..."}) — NUNCA edite o checkout`,
      "de runtime direto (é o serviço vivo).",
    );
  }
  if (i.handoff) {
    lines.push(
      "",
      "RECICLAGEM: você ASSUME o trabalho de um processo anterior que encheu o contexto. A árvore, o branch e os",
      "claims são os MESMOS (o agentId não mudou) — leia o estado no disco (git status/log no seu worktree) e no",
      "card antes de agir; não recomece do zero.",
    );
  }
  return lines.join("\n");
}

// ── the CLI args ─────────────────────────────────────────────────────────────────────────────────────────

// ── a superfície ENXUTA do condutor ──────────────────────────────────────────────────────────────────────
//
// MEDIDO (123 sessões de condutor): o início de uma sessão custava ~236k tokens — 66% de todo o input delas —
// porque o spawn herdava TUDO do operador: os conectores do claude.ai, os plugins, as MCPs globais e todas as
// tools nativas do CLI. O condutor só precisa do MCP do AgileHarness (o `--mcp-config` da sessão) e de um punhado de
// tools nativas. Só o PAPEL condutor muda: o terminal que o próprio operador abre (`claude_new` sem driver) segue
// herdando o ambiente dele, exatamente como hoje.

/**
 * As tools nativas que RODAM COMANDO DE SHELL. A trava dura do host (o hook `hard-deny` nos managed settings) casa só
 * com `Bash` — uma sessão que tenha outra destas roda comando sem passar por ela (medido: `Monitor` executa o `command`
 * dele no mesmo shell, e o hook sai cedo para todo `tool_name` que não seja Bash). Nenhuma sessão que o serviço abre
 * pode ganhar uma delas além de `Bash`.
 */
export const SHELL_RUNNING_TOOLS = ["Bash", "Monitor", "PowerShell"] as const;

/** A única tool de shell que a trava dura do host cobre (o `matcher` do hook gerenciado). */
export const HARD_DENY_COVERED_SHELL_TOOLS: readonly string[] = ["Bash"];

/**
 * As tools NATIVAS que um condutor usa de fato: Agent (os especialistas e o verificador de contexto limpo), o shell
 * e os arquivos do próprio worktree (Bash/Read/Edit/Write/Glob/Grep), TaskStop (parar o servidor de dev ou a suíte
 * longa que ele subiu com `Bash` em segundo plano), WebFetch/WebSearch (documentação oficial antes de prescrever um
 * conserto) e ToolSearch. `Monitor` SAIU: ele roda comando de shell por fora da trava dura (ver
 * {@link SHELL_RUNNING_TOOLS}), e o `Bash` com `run_in_background` cobre o servidor de dev e a suíte longa. O slash command
 * `/harness-conductor` continua registrado com esta lista (verificado no evento `init` do CLI 2.1.289).
 *
 * ToolSearch FICA, medido no CLI 2.1.289 (`-p`, stream-json, um servidor MCP de 140 tools, `--strict-mcp-config`):
 * SEM ela o CLI não adia nenhum schema MCP — os 140 entram no 1º turno (~125k tokens, sonnet e opus); COM ela os
 * schemas são adiados e o 1º turno custa ~7,6k, a tool MCP chamada depois de um `select:`. Nos dois casos a tool MCP
 * é chamável. Tirá-la só faz o adiamento nunca acontecer — o oposto do que a superfície enxuta quer. É só leitura.
 * `Skill` fica FORA de propósito: sem ela a lista de skills (~13k tokens) não entra no contexto, e o slash command
 * do spawn continua funcionando; as menções a `Skill:` nos agentes do alvo são opcionais («quando necessário»).
 */
export const CONDUCTOR_TOOLS = ["Agent", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "TaskStop", "WebFetch", "WebSearch", "ToolSearch"] as const;

/**
 * O recorte de superfície de uma sessão pelo seu driver. PURA. Condutor ⇒ só o MCP do `--mcp-config`
 * (`--strict-mcp-config`) e só as {@link CONDUCTOR_TOOLS}; qualquer outra sessão ⇒ nada muda (herda o operador).
 */
export function sessionToolScope(driver: CardDriver | undefined): { tools?: readonly string[]; strictMcpConfig?: boolean } {
  return driver === "conductor" ? { tools: CONDUCTOR_TOOLS, strictMcpConfig: true } : {};
}

/**
 * O conjunto de tools MCP do PAPEL da sessão (mcp/toolsets.ts) — o que o servidor monta para ela, por baixo do nível do
 * token. Condutor ⇒ `conductor` (as ~40 que um condutor usa, das ~140 que o `orch` monta); qualquer outra sessão ⇒
 * nenhum recorte (a superfície inteira do nível, como hoje). PURA.
 */
export function sessionMcpToolset(driver: CardDriver | undefined): McpToolset | undefined {
  return driver === "conductor" ? "conductor" : undefined;
}

// ── o PACOTE DE CONTEXTO (context-pack.ts) ───────────────────────────────────────────────────────────────────
//
// O condutor nasce com o norte do produto no PROMPT DE SISTEMA (`--append-system-prompt-file`): o canal que é re-emitido a
// cada turno e sobrevive à compactação — o mesmo que os runs headless já usam (engine.ts). Antes o contexto de negócio
// chegava por instrução («leia o PRD…»), e só uma fração das sessões o lia. O arquivo mora ao lado do `.mcp.json` da
// sessão (gitignored, 0600) e é REESCRITO a cada spawn/reciclagem: o hash no cabeçalho diz à sessão nova se o norte mudou
// (a skill manda anotá-lo no diário e comparar), e hash + tokens ficam na linha do registro da sessão (telemetria).
//
// SÓ COM A SKILL DIVIDIDA. A skill monolítica antiga (sem `ref/`) manda ler o PRD e os documentos inteiros: com ela, o
// pacote só SOMA tokens a cada turno. O alvo só recebe a skill nova quando o operador sobrescreve a cópia dele
// (skills-sync guarda uma cópia divergente). Por isso o pacote só é entregue quando o worktree da sessão tem
// `.claude/skills/harness-conductor/ref/` (dep `hasSplitConductorSkill`).

/** Onde a skill dividida do condutor deixa as regras completas, relativo à raiz do worktree. */
export const CONDUCTOR_SKILL_REF_DIR = path.join(".claude", "skills", "harness-conductor", "ref");

/** Onde mora o pacote de uma sessão: `storymap/.runner/sessions/<sessionId>.pack.md`. */
export function sessionContextPackPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, "sessions", `${sessionId}.pack.md`);
}

/** O que o spawn recebe do montador do pacote (context-pack.ts → `loadContextPack`). */
export interface SessionContextPack {
  text: string;
  hash: string;
  tokens: number;
}

/**
 * Escreve o pacote da sessão e devolve o caminho + o hash, ou null (sem pacote, sem card, ou a escrita falhou). FAIL-OPEN
 * de propósito: uma sessão sem pacote ainda cumpre o contrato (a skill manda ler as fontes); uma sessão que NÃO nasce por
 * causa de um arquivo de contexto seria o pior dos dois.
 */
export async function writeSessionContextPack(
  fs: Pick<typeof fsp, "mkdir" | "writeFile">,
  stateDir: string,
  sessionId: string,
  pack: SessionContextPack | null | undefined,
): Promise<{ path: string; hash: string; tokens: number } | null> {
  if (!pack?.text?.trim()) return null;
  const file = sessionContextPackPath(stateDir, sessionId);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, pack.text, { encoding: "utf8", mode: 0o600 });
    return { path: file, hash: pack.hash, tokens: pack.tokens };
  } catch {
    return null;
  }
}

/**
 * Apaga os arquivos que o spawn escreveu para uma sessão (`<id>.mcp.json` com o token, `<id>.pack.md`). Chamado quando a
 * sessão sai do registro (session-worktree.ts `removeSessionFiles`). Ausente já é sucesso; nunca lança.
 */
export async function removeSessionArtifacts(
  fs: Pick<typeof fsp, "rm">,
  stateDir: string,
  sessionId: string,
): Promise<void> {
  for (const file of [sessionMcpConfigPath(stateDir, sessionId), sessionContextPackPath(stateDir, sessionId)]) {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/** Carrega (pelo dep injetado) e escreve o pacote de uma sessão de CONDUTOR num card. Nunca lança. */
async function conductorPackFor(
  deps: SessionSpawnDeps,
  driver: CardDriver | undefined,
  sessionId: string,
  card: { board: string; cardId: string } | null,
  cwd: string,
): Promise<{ path: string; hash: string; tokens: number } | null> {
  if (driver !== "conductor" || !card || !deps.contextPack) return null;
  // skill antiga no worktree ⇒ sem pacote (ver o cabeçalho desta seção); sem o dep ⇒ assume a skill dividida
  if (deps.hasSplitConductorSkill && !(await deps.hasSplitConductorSkill(cwd).catch(() => false))) return null;
  const pack = await deps.contextPack(card.board, card.cardId).catch(() => null);
  return writeSessionContextPack(deps.fs, deps.stateDir, sessionId, pack);
}

/**
 * The argv for the session's `claude`. THE PROMPT IS FIRST and everything else follows — see fact 1 in the
 * header: `--mcp-config` is variadic, so a prompt placed after it is eaten as a config path and the CLI dies
 * before the session exists. Do not "tidy" the order. PURE.
 *
 * `--tools` é VARIÁDICO também: a lista vai como UM argumento separado por vírgula (a forma que o `--help` do CLI
 * documenta, "Bash,Edit,Read"), e o token seguinte é sempre uma flag — nunca um valor que ela possa engolir.
 */
export function buildSessionClaudeArgs(input: {
  prompt: string;
  model?: SessionModel;
  effort?: EffortLevel;
  mcpConfigPath?: string;
  /** as tools NATIVAS permitidas (`--tools`); ausente ⇒ o default do CLI (todas). */
  tools?: readonly string[];
  /** `--strict-mcp-config`: só as MCPs do `--mcp-config` (nenhuma do operador). Sem config ⇒ nenhuma MCP. */
  strictMcpConfig?: boolean;
  /** `--append-system-prompt-file`: o pacote de contexto (um caminho só; a flag não é variádica). */
  appendSystemPromptFile?: string;
}): string[] {
  const args: string[] = [input.prompt];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  if (input.tools && input.tools.length > 0) args.push("--tools", input.tools.join(","));
  if (input.strictMcpConfig) args.push("--strict-mcp-config");
  if (input.appendSystemPromptFile) args.push("--append-system-prompt-file", input.appendSystemPromptFile);
  // LAST, and last on purpose (variadic): nothing may follow it.
  if (input.mcpConfigPath) args.push("--mcp-config", input.mcpConfigPath);
  return args;
}

/** POSIX single-quote: the ONLY safe way to hand caller data to `bash -lc` (tmux runs the session's command
 *  through a shell). `'` closes, escapes, reopens. PURE. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The one-line shell command tmux runs for the session. `rootBypass` prefixes the CLI's root-guard escape
 *  (fact 4) as a shell assignment — a constant, never caller data. PURE. */
export function buildSessionCommand(claudeBin: string, args: string[], opts: { rootBypass?: boolean } = {}): string {
  const cmd = [claudeBin, ...args].map(shellQuote).join(" ");
  return opts.rootBypass ? `IS_SANDBOX=1 ${cmd}` : cmd;
}

// ── the MCP surface (G12) ────────────────────────────────────────────────────────────────────────────────

/** Where a session's MCP config lives: `storymap/.runner/sessions/<sessionId>.mcp.json` (gitignored — the
 *  whole `.runner/` tree is). It must OUTLIVE the spawn (unlike the orchestrator's tmpdir config, which the
 *  run deletes on exit): a session re-reads nothing, but it lives for hours and may be recycled onto it. */
export function sessionMcpConfigPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, "sessions", `${sessionId}.mcp.json`);
}

/**
 * G12 — write the session's AgileHarness MCP mount, carrying the SCOPED `orch` token (never the operator's `full`
 * one): the session may drive the pipeline and publish, but never open a shell through MCP nor delete.
 *
 * The token is INLINED in the file (0600, gitignored dir) rather than passed through the env — the precedent
 * is the copilot's own spawn (`buildOrchestratorMcpConfig`), and both alternatives are worse here: the env
 * does not survive tmux at all (fact 2), and `-e` would print the secret into argv for every `ps` on the box.
 * Returns the path, or null when there is no token — the caller then spawns a session that simply has no
 * AgileHarness tools, and SAYS SO, rather than pretending the contract is honourable.
 */
export async function writeSessionMcpConfig(
  fs: Pick<typeof fsp, "mkdir" | "writeFile">,
  stateDir: string,
  sessionId: string,
  token: string | undefined,
  port: number,
  /** a prova de sessão a escrever (testes injetam); omitida ⇒ a cunhada pelo serviço. */
  sessionProof?: string | null,
  /** o PAPEL da sessão (mcp/toolsets.ts): o servidor monta só as tools dele. Ausente ⇒ a superfície inteira do nível. */
  toolset?: McpToolset,
): Promise<string | null> {
  const clean = token?.trim();
  if (!clean) return null;
  const file = sessionMcpConfigPath(stateDir, sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // a sessão se nomeia pelo sessionId do registro: a trilha e o diário do board dizem QUAL agente fez cada chamada; e
  // leva a prova que o serviço cunhou para ela (mcp/session-proof.ts), o vínculo do servidor para o que decide por sessão
  const base = buildOrchestratorMcpConfig(clean, port, { kind: "session", id: sessionId }, sessionProof === undefined ? currentSessionProof(sessionId) : sessionProof);
  await fs.writeFile(file, toolset ? withToolsetHeader(base, toolset) : base, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** O config do MCP com o cabeçalho do papel no servidor `storymap` (o único que o arquivo monta). PURA. */
function withToolsetHeader(config: string, toolset: McpToolset): string {
  const parsed = JSON.parse(config) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
  for (const server of Object.values(parsed.mcpServers)) server.headers = { ...(server.headers ?? {}), [MCP_TOOLSET_HEADER]: toolset };
  return JSON.stringify(parsed);
}

// ── the honest-spawn probe ───────────────────────────────────────────────────────────────────────────────
// claude_new used to return {ok:true} the instant `tmux new-session` exited 0, but the `claude` process can
// die right after (no current client / not-in-a-mode) — so the session vanishes and every later
// claude_send/claude_sessions call breaks. This makes the contract honest (poll for persistence). It lives
// with the spawn (not in the MCP tool module) because TWO callers need it: `claude_new` and the conductor
// dispatch (runner/conductor.ts), and the second must not import the tools module to reach it.

const SESSION_POLL_INTERVAL_MS = 500;
const SESSION_POLL_TIMEOUT_MS = 5_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Poll `check()` (true = session still alive) across the persistence window. Resolves
 * `false` the moment a check reports the session is gone; `true` only if it survives the
 * whole window. Iteration-driven (not wall-clock) so it's deterministic under an injected
 * `sleep` in unit tests — the real call passes a `tmux has-session` probe as `check`.
 */
export async function pollSessionAlive(
  check: () => Promise<boolean>,
  opts: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? SESSION_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? SESSION_POLL_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const iterations = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  for (let i = 0; i < iterations; i++) {
    await sleep(intervalMs);
    if (!(await check())) return false;
  }
  return true;
}

// ── the spawn ────────────────────────────────────────────────────────────────────────────────────────────

export interface SessionSpawnDeps {
  /** WS-1's deps — the SAME door runs go through (base, train, admission, registry). */
  worktree: SessionWorktreeDeps;
  /** WS-4 — the live claim registry. Three verbs: look, take, give back (the rollback needs the third). */
  claims: {
    conflictFor(req: { board: string; cardId: string; actor: string; kind: ClaimKind; scope: ClaimScope; ttlMs: number }): Promise<CardClaim | null>;
    acquire(req: { board: string; cardId: string; actor: string; kind: ClaimKind; scope: ClaimScope; ttlMs: number; note?: string }): Promise<{ ok: true; claim: CardClaim } | { ok: false; holder: CardClaim }>;
    release(board: string, cardId: string, actor: string): Promise<void>;
  };
  /** the card's route, resolved by the caller (reads card + board config + settings); null ⇒ no card/unknown. */
  cardRoute(board: string, cardId: string): Promise<{ model?: ModelTier; effort?: EffortLevel; title?: string } | null>;
  /** tmux: create detached, probe existence, probe survival, kill. */
  tmux: {
    exists(name: string): Promise<boolean>;
    create(name: string, command: string, cwd: string): Promise<{ ok: boolean; error?: string }>;
    /** true when the session is STILL there after the persistence window (the honest `claude_new` contract). */
    survives(name: string): Promise<boolean>;
    kill(name: string): Promise<void>;
  };
  /** the transcript the CLI just started writing (feeds contextPct); best-effort. */
  findTranscript(since: number): Promise<string | null>;
  fs: Pick<typeof fsp, "mkdir" | "writeFile">;
  claudeBin: string;
  repoRoot: string;
  stateDir: string;
  /** the scoped `orch` MCP token (AGILEHARNESS_MCP_TOKEN_ORCH); absent ⇒ the session mounts no AgileHarness tools. */
  mcpToken?: string;
  port: number;
  now?: () => number;
  /** O GOVERNADOR DE CAPACIDADE — consultado SÓ para sessão aberta por AUTOMAÇÃO (`spawnedBy: "copilot"`); a
   *  sessão do operador nunca espera. Ausente ⇒ sem governador (legado). */
  admission?: (initiator: Initiator) => GateVerdict;
  /** The session inherits `bypassPermissions` AS ROOT ⇒ its command must carry `IS_SANDBOX=1` (fact 4). Resolved
   *  per call by the production wiring ({@link hostNeedsRootBypass}); absent/false ⇒ the command is unchanged. */
  rootBypass?: boolean;
  /** O PACOTE DE CONTEXTO do card (context-pack.ts `loadContextPack`), só para sessão de condutor. Ausente ⇒ sem pacote. */
  contextPack?(board: string, cardId: string): Promise<SessionContextPack | null>;
  /**
   * O worktree (cwd) da sessão carrega a skill do condutor DIVIDIDA ({@link CONDUCTOR_SKILL_REF_DIR})? Falso ⇒ sem
   * pacote. Ausente ⇒ assume que sim (testes, instalação sem disco).
   */
  hasSplitConductorSkill?(cwd: string): Promise<boolean>;
}

/**
 * Does a session spawned on this host die in the CLI's root guard unless it carries `IS_SANDBOX=1`? Only when
 * the process is root (POSIX) AND the mode it will inherit is `bypassPermissions` (the operator's user settings
 * `permissions.defaultMode`). PURE — the caller reads uid/platform/settings.
 */
export function hostNeedsRootBypass(h: { uid: number | undefined; platform: string; inheritedDefaultMode: unknown }): boolean {
  return h.platform !== "win32" && h.uid === 0 && h.inheritedDefaultMode === "bypassPermissions";
}

export interface SpawnSessionInput {
  /**
   * The session is this card's DRIVER (`conductor`): stamped on the registry row so the conductor dispatch
   * can count live conductors per board, and so a recycle re-invokes the conductor skill. Absent ⇒ an
   * ordinary fleet session.
   */
  driver?: CardDriver;
  /** A slash command that leads the first prompt (see {@link SessionPromptInput.command}). */
  command?: string;
  role: AgentRole;
  task: string;
  board?: string;
  cardId?: string;
  /** an explicit tier (or its `[1m]` variant) from the caller — always wins (see resolveSessionRoute). */
  model?: SessionModel;
  /** a readable suffix for the tmux name; defaults to the session's short id. */
  name?: string;
  actor?: string;
  spawnedBy?: "human" | "copilot";
  /** WS-6.3 — recycle: keep this LOGICAL identity (its claims and its tree follow it to the new process). */
  agentId?: string;
}

/**
 * WHY a spawn was refused — the caller's next move differs per code, so it is a FIELD, not a phrase to
 * regex out of `reason`:
 *  - `no_capacity`  → the box is full; `queue` says who has it (wait, or re-prioritise).
 *  - `card_claimed` → someone owns the card; `holder` says who (take the next suggestion).
 *  - `name_taken`   → the tmux name collides; pick another `name`.
 *  - `session_lost` → the process died on arrival (the honest contract the old claude_new learned the hard
 *                     way: `tmux new-session` exiting 0 does NOT mean the agent lives).
 *  - `spawn_failed` → the plumbing itself failed (git/tmux/fs).
 */
export type SpawnFailureCode = "no_capacity" | "card_claimed" | "name_taken" | "session_lost" | "spawn_failed" | "capacity_held";

export type SpawnSessionResult =
  | {
      ok: true;
      session: AgentSession;
      tmuxSession: string;
      route: SessionRoute;
      claim: CardClaim | null;
      /** false ⇒ no `orch` token on the box: the session has NO AgileHarness tools (the contract is degraded). */
      mcpMounted: boolean;
      /** o pacote de contexto entregue no prompt de sistema (condutor), com o hash das fontes; ausente ⇒ nenhum. */
      contextPack?: { path: string; hash: string; tokens: number };
    }
  | { ok: false; code: SpawnFailureCode; reason: string; queue?: FleetQueueRow[]; holder?: CardClaim };

const nowOf = (deps: SessionSpawnDeps): number => (deps.now ?? Date.now)();

/**
 * WS-6.2 — birth a working session. The ORDER below is the whole design, and each step undoes itself on the
 * next one's failure, because a half-born session is worse than none: a tree nobody owns, or a card reserved
 * by a process that never existed, both need a human to notice and clean up.
 *
 *   1. CLAIM PRE-CHECK (a cheap READ) — refuse a taken card BEFORE building anything for it.
 *   2. TREE (code roles) — admission lives inside WS-1's door; its refusal carries the queue.
 *   3. CLAIM ACQUIRE (authoritative, first-writer-wins) — a race lost here rolls the tree back.
 *   4. SPAWN — a session that dies on arrival releases the claim and discards the tree, and says so
 *      (`session_lost`) instead of the old false `{ok:true}`.
 *   5. STAMP — tmux/cwd/transcript/model onto the registry row: the fleet view's whole content.
 */
export async function spawnWorkSession(deps: SessionSpawnDeps, input: SpawnSessionInput): Promise<SpawnSessionResult> {
  const wantsTree = roleNeedsWorktree(input.role);
  const claimSpec = claimForRole(input.role);

  // 0 — a janela da CONTA, antes de qualquer efeito (claim, árvore, tmux): uma sessão que a AUTOMAÇÃO abre
  // passa pelo governador de capacidade; a do operador (`human`) nunca. Uma recusa aqui não deixa nada pela
  // metade, e o chamador (um agente) re-tenta no próximo ciclo dele.
  if (input.spawnedBy === "copilot" && deps.admission) {
    const gate = deps.admission("automation");
    if (!gate.admit) return { ok: false, code: "capacity_held", reason: `${CAPACITY_HELD_MARKER}: ${gate.detail}` };
  }

  // 1 — is the card already taken? A read, not a reservation: the authoritative answer is step 3, but paying
  // for a worktree just to lose the race is waste we can see coming.
  const card = input.board && input.cardId ? { board: input.board, cardId: input.cardId } : null;
  if (card) {
    const probeActor = sessionClaimActor(input.agentId ?? "probe");
    const holder = await deps.claims
      .conflictFor({ ...card, actor: probeActor, ...claimSpec, ttlMs: CLAIM_TTL_SESSION_MS })
      .catch(() => null);
    if (holder && holder.actor !== probeActor) {
      return {
        ok: false,
        code: "card_claimed",
        holder,
        reason:
          `${card.board}/${card.cardId} já está reservado por ${holder.actor} (${holder.kind}/${holder.scope}, ` +
          `até ${holder.expiresAt})${holder.note ? ` — "${holder.note}"` : ""}. ` +
          `Pegue outro card (suggest_work) ou espere a reserva cair.`,
      };
    }
  }

  // 2 — the tree (with the admission the box actually needs).
  let session: AgentSession;
  if (wantsTree) {
    const opened = await openSessionWorktree(deps.worktree, {
      board: input.board,
      cardId: input.cardId,
      task: input.task,
      actor: input.actor,
      role: input.role,
      spawnedBy: input.spawnedBy,
      agentId: input.agentId,
      ...(input.driver ? { driver: input.driver } : {}),
    });
    // WS-1's door refuses for exactly one reason a caller can act on (admission) — it carries the queue when
    // so; anything else is plumbing (git/fs) that no queue explains.
    if (!opened.ok) {
      return { ok: false, code: opened.queue ? "no_capacity" : "spawn_failed", reason: opened.reason, queue: opened.queue };
    }
    session = opened.session;
  } else {
    const reg = await registerSession(deps.worktree, {
      role: input.role,
      board: input.board,
      cardId: input.cardId,
      task: input.task,
      actor: input.actor,
      spawnedBy: input.spawnedBy,
      agentId: input.agentId,
      cwd: deps.repoRoot,
      ...(input.driver ? { driver: input.driver } : {}),
    });
    session = reg.session;
  }

  // Everything from here can fail with a session already registered → ONE rollback, used by every exit below.
  // It must be blind-safe (releasing a claim never taken is a documented no-op; discarding a tree-less session
  // just deregisters it), because a failure path that can itself fail leaves the mess it was meant to clean.
  const rollback = async (claimed: boolean): Promise<void> => {
    if (card && claimed) {
      await deps.claims.release(card.board, card.cardId, sessionClaimActor(session.agentId)).catch(() => {});
    }
    await discardSessionWorktree(deps.worktree, { sessionId: session.sessionId }).catch(() => {});
  };

  // 3 — the reservation, for real.
  let claim: CardClaim | null = null;
  if (card) {
    const res = await deps.claims.acquire({
      ...card,
      actor: sessionClaimActor(session.agentId),
      ...claimSpec,
      ttlMs: CLAIM_TTL_SESSION_MS,
      note: input.task.slice(0, 120),
    });
    if (!res.ok) {
      await rollback(false);
      return {
        ok: false,
        code: "card_claimed",
        holder: res.holder,
        reason:
          `perdi a corrida pelo claim de ${card.board}/${card.cardId}: ${res.holder.actor} pegou primeiro ` +
          `(${res.holder.kind}/${res.holder.scope}). Nada foi criado; pegue outro card (suggest_work).`,
      };
    }
    claim = res.claim;
  }

  // 4 — the process.
  const tmuxSession = sessionTmuxName(session.sessionId, input.name);
  if (await deps.tmux.exists(tmuxSession)) {
    await rollback(!!claim);
    return { ok: false, code: "name_taken", reason: `já existe uma sessão tmux "${tmuxSession}" — escolha outro \`name\`.` };
  }
  const cardRoute = card ? await deps.cardRoute(card.board, card.cardId).catch(() => null) : null;
  const route = resolveSessionRoute({ role: input.role, override: input.model, cardRoute });
  const mcpPath = await writeSessionMcpConfig(
    deps.fs,
    deps.stateDir,
    session.sessionId,
    deps.mcpToken,
    deps.port,
    undefined,
    sessionMcpToolset(input.driver),
  ).catch(() => null);
  const cwd = session.worktreePath ?? deps.repoRoot;
  const pack = await conductorPackFor(deps, input.driver, session.sessionId, card, cwd);
  const prompt = buildSessionPrompt({
    ...(input.command ? { command: input.command } : {}),
    sessionId: session.sessionId,
    agentId: session.agentId,
    role: input.role,
    task: input.task,
    board: input.board,
    cardId: input.cardId,
    cardTitle: cardRoute?.title,
    worktreePath: session.worktreePath,
    branch: session.branch,
    handoff: !!input.agentId,
  });
  const command = buildSessionCommand(
    deps.claudeBin,
    buildSessionClaudeArgs({
      prompt,
      model: route.model,
      effort: route.effort,
      mcpConfigPath: mcpPath ?? undefined,
      ...sessionToolScope(input.driver),
      ...(pack ? { appendSystemPromptFile: pack.path } : {}),
    }),
    { rootBypass: deps.rootBypass },
  );
  const created = await deps.tmux.create(tmuxSession, command, cwd);
  if (!created.ok) {
    await rollback(!!claim);
    return { ok: false, code: "spawn_failed", reason: created.error ?? "falha ao criar a sessão tmux (tmux disponível?)." };
  }
  // The honest contract (AC1 of the old claude_new, kept): `tmux new-session` exiting 0 only means tmux made a
  // session — the `claude` inside can die a second later (a bad flag, the root guard). Verify, then commit.
  const startedAt = nowOf(deps);
  if (!(await deps.tmux.survives(tmuxSession))) {
    await deps.tmux.kill(tmuxSession).catch(() => {});
    await rollback(!!claim);
    return {
      ok: false,
      code: "session_lost",
      reason:
        `a sessão "${tmuxSession}" morreu logo após nascer — o processo claude não persistiu. ` +
        `Nada ficou pendurado: claim e worktree foram desfeitos.`,
    };
  }

  // 5 — the row the fleet view reads.
  const transcriptFile = (await deps.findTranscript(startedAt).catch(() => null)) ?? undefined;
  const stamped = await updateSession(deps.worktree, session.sessionId, {
    tmuxSession,
    cwd,
    transcriptFile,
    model: route.model,
    ...(pack ? { contextPack: { hash: pack.hash, tokens: pack.tokens } } : {}),
  });
  return { ok: true, session: stamped ?? session, tmuxSession, route, claim, mcpMounted: !!mcpPath, ...(pack ? { contextPack: pack } : {}) };
}

// ── RECYCLING (6.3) ──────────────────────────────────────────────────────────────────────────────────────

export type RecycleSessionResult =
  | { ok: true; session: AgentSession; tmuxSession: string; previousTmux?: string; route: SessionRoute }
  | { ok: false; reason: string };

/**
 * WS-6.3 — replace the PROCESS of a session whose context filled up, keeping the AGENT.
 *
 * The decision this implements: the worktree belongs to the LOGICAL agent (agentId), not to the process. So
 * recycling is deliberately NOT "discard + claude_new": the tree, the branch, the base-ref, the card and the
 * claim all stay exactly where they are (the claim is held as `session:<agentId>`, which does not change), and
 * only `tmuxSession`/`transcriptFile` are swapped. A recycle that re-opened a tree would throw away hours of
 * un-integrated work and re-acquire its own card as a stranger.
 *
 * ORDER: the new process is born and PROVEN to survive BEFORE the old one is killed. The reverse (kill first)
 * leaves a window where the agent does not exist, and a failed spawn in that window would strand the tree with
 * nobody attached. The cost of this order is a few seconds of two processes on one tree — during which the OLD
 * one is the only writer (the new one starts by reading), which is why the handoff prompt tells it to read the
 * state before acting.
 */
export async function recycleSession(deps: SessionSpawnDeps, input: { sessionId: string }): Promise<RecycleSessionResult> {
  const sessions = await deps.worktree.store.load().catch(() => [] as AgentSession[]);
  const cur = sessions.find((s) => s.sessionId === input.sessionId);
  if (!cur) return { ok: false, reason: `sessão ${input.sessionId} desconhecida (já descartada?)` };
  if (cur.adopted) {
    return {
      ok: false,
      reason:
        `sessão ${input.sessionId.slice(0, 8)} foi ADOTADA (tmux criado fora da ferramenta): não temos o contrato ` +
        `dela nem árvore própria, então reciclar seria criar um agente novo com outra cara. Encerre-a e abra uma ` +
        `sessão com claude_new.`,
    };
  }

  const card = cur.board && cur.cardId ? { board: cur.board, cardId: cur.cardId } : null;
  const cardRoute = card ? await deps.cardRoute(card.board, card.cardId).catch(() => null) : null;
  const route = resolveSessionRoute({ role: cur.role, override: cur.model as SessionModel | undefined, cardRoute });
  const mcpPath = await writeSessionMcpConfig(
    deps.fs,
    deps.stateDir,
    cur.sessionId,
    deps.mcpToken,
    deps.port,
    undefined,
    sessionMcpToolset(cur.driver),
  ).catch(() => null);
  // o pacote é RE-MONTADO (as fontes podem ter mudado desde o spawn; o hash novo diz isso à sessão nova)
  const pack = await conductorPackFor(deps, cur.driver, cur.sessionId, card, cur.worktreePath ?? deps.repoRoot);
  // A recycled CONDUCTOR must wake up inside the conductor skill again (with the handoff note telling it to
  // read its journal first) — without the leading command the new process would be a generic fleet agent
  // holding a conductor's claim and tree.
  const command = cur.driver === "conductor" && cur.board && cur.cardId ? conductorCommand(cur.board, cur.cardId) : undefined;
  const prompt = buildSessionPrompt({
    ...(command ? { command } : {}),
    sessionId: cur.sessionId,
    agentId: cur.agentId,
    role: cur.role,
    task: cur.task,
    board: cur.board,
    cardId: cur.cardId,
    cardTitle: cardRoute?.title,
    worktreePath: cur.worktreePath,
    branch: cur.branch,
    handoff: true,
    // o lote é da linha do registro (que a reciclagem mantém): o processo novo herda os itens com os claims
    batchCardIds: sessionCardIds(cur).filter((id) => id !== cur.cardId),
  });
  const cwd = cur.worktreePath ?? deps.repoRoot;
  // A DIFFERENT tmux name, because the old session is still alive at this point (see ORDER above). The name is
  // just the host; identity is the agentId, which the fleet view keys on.
  const tmuxSession = sessionTmuxName(cur.sessionId, `${cur.agentId.slice(0, 8)}-${nowOf(deps).toString(36).slice(-4)}`);
  const created = await deps.tmux.create(
    tmuxSession,
    buildSessionCommand(
      deps.claudeBin,
      // o condutor reciclado nasce com a MESMA superfície enxuta do despachado (o driver vem da linha do registro)
      buildSessionClaudeArgs({
        prompt,
        model: route.model,
        effort: route.effort,
        mcpConfigPath: mcpPath ?? undefined,
        ...sessionToolScope(cur.driver),
        ...(pack ? { appendSystemPromptFile: pack.path } : {}),
      }),
      { rootBypass: deps.rootBypass },
    ),
    cwd,
  );
  if (!created.ok) return { ok: false, reason: `falha ao criar a sessão nova: ${created.error ?? "?"} (a antiga segue viva)` };
  const startedAt = nowOf(deps);
  if (!(await deps.tmux.survives(tmuxSession))) {
    await deps.tmux.kill(tmuxSession).catch(() => {});
    return { ok: false, reason: "a sessão nova morreu ao nascer — a ANTIGA segue viva e dona da árvore (nada mudou)." };
  }

  const previousTmux = cur.tmuxSession;
  if (previousTmux && previousTmux !== tmuxSession) await deps.tmux.kill(previousTmux).catch(() => {});
  const transcriptFile = (await deps.findTranscript(startedAt).catch(() => null)) ?? undefined;
  const stamped = await updateSession(deps.worktree, cur.sessionId, {
    tmuxSession,
    cwd,
    transcriptFile,
    model: route.model,
    // a telemetria do pacote acompanha o processo: sem pacote nesta reciclagem, a linha não guarda o hash do anterior
    contextPack: pack ? { hash: pack.hash, tokens: pack.tokens } : undefined,
  });
  return { ok: true, session: stamped ?? cur, tmuxSession, previousTmux, route };
}
