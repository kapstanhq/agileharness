import { describe, expect, it } from "vitest";
import { healPermissionPrompts, type PromptHealDeps, type PromptHealState } from "./permission-prompt-heal";
import { PROMPT_GRACE_MS, PROMPT_MAX_ANSWERS, PROMPT_TIMEOUT_MS } from "./permission-prompt";
import type { AgentSession } from "./session-worktree";
import type { SystemDecision } from "@/lib/storymap/system-decisions";

const WT = "/root/repo/.worktrees/agent-aaa";
const SCRATCH = "/tmp/claude-0/-root-repo--worktrees-agent-aaa";
const screen = (warning = "Dangerous rm operation on possibly-empty variable path: $S/x") =>
  ` Bash command · from the code-reviewer agent\n Run shell command\n╌╌╌\n │ S=${SCRATCH}/s; rm -rf $S/x\n │ ${warning}\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel`;
const session = (over: Partial<AgentSession> = {}): AgentSession =>
  ({ sessionId: "s1", tmuxSession: "agent-conductor-x", board: "b", cardId: "story-1", driver: "conductor", worktreePath: WT, transcriptFile: "/t.jsonl", ...over }) as AgentSession;
const safe = { name: "Bash", input: { command: `S=${SCRATCH}/s; rm -rf $S/x` } };

function harness(over: Partial<PromptHealDeps> = {}) {
  let now = 1_000_000;
  const pressed: Array<[string, string]> = [];
  const recorded: SystemDecision[] = [];
  const state: PromptHealState = new Map();
  const deps: PromptHealDeps = {
    sessions: async () => [session()],
    liveTmux: async () => new Set(["agent-conductor-x"]),
    heartbeatAlive: () => true,
    runsClaude: async () => true,
    screen: async () => screen(),
    pendingTool: async () => safe,
    roots: () => ({ worktree: WT, scratch: SCRATCH }),
    press: async (t, k) => (pressed.push([t, k]), true),
    record: async (e) => void recorded.push(e),
    newId: () => "id1",
    now: () => now,
    log: () => {},
    state,
    ...over,
  };
  return { deps, pressed, recorded, state, advance: (ms: number) => void (now += ms) };
}

describe("healPermissionPrompts", () => {
  it("dentro da carência não responde (um humano que olha o terminal tem a vez); depois dela aprova o falso positivo provado", async () => {
    const h = harness();
    expect((await healPermissionPrompts(h.deps)).waiting).toHaveLength(1);
    expect(h.pressed).toEqual([]);
    h.advance(PROMPT_GRACE_MS + 1);
    const r = await healPermissionPrompts(h.deps);
    expect(r.approved).toEqual([{ tmuxSession: "agent-conductor-x", cardId: "story-1" }]);
    expect(h.pressed).toEqual([["agent-conductor-x", "1"]]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ kind: "stall-retry", board: "b", cardId: "story-1", agent: "system" });
    expect(h.recorded[0]!.what).toMatch(/Liberou um comando seguro/);
  });

  it("recusa o que o isolamento não prova (tecla do «No»)", async () => {
    const h = harness({ pendingTool: async () => ({ name: "Bash", input: { command: "S=/root; rm -rf $S/x" } }) });
    await healPermissionPrompts(h.deps);
    h.advance(PROMPT_GRACE_MS + 1);
    const r = await healPermissionPrompts(h.deps);
    expect(r.rejected).toHaveLength(1);
    expect(h.pressed).toEqual([["agent-conductor-x", "2"]]);
  });

  it("o que não consegue julgar espera o prazo e então é recusado — nenhuma sessão fica horas no pedido", async () => {
    const h = harness({ screen: async () => screen("Command has an unusual shape"), pendingTool: async () => null });
    await healPermissionPrompts(h.deps);
    h.advance(PROMPT_GRACE_MS + 1);
    expect((await healPermissionPrompts(h.deps)).waiting).toHaveLength(1);
    expect(h.pressed).toEqual([]);
    h.advance(PROMPT_TIMEOUT_MS);
    const r = await healPermissionPrompts(h.deps);
    expect(r.rejected).toHaveLength(1);
    expect(h.pressed).toEqual([["agent-conductor-x", "2"]]);
  });

  it("uma PERGUNTA do agente ao dono (sem moldura de ferramenta) nunca é respondida pelo sistema", async () => {
    const h = harness({ screen: async () => " Qual índice usar?\n ❯ 1. Composto\n   2. Simples\n" });
    await healPermissionPrompts(h.deps);
    h.advance(PROMPT_TIMEOUT_MS * 3);
    const r = await healPermissionPrompts(h.deps);
    expect(r).toEqual({ approved: [], rejected: [], waiting: [] });
    expect(h.pressed).toEqual([]);
  });

  it("pedido NOVO zera a carência; sessão sem claude no pane ou sonda de tmux sem resposta ⇒ não digita nada", async () => {
    const h = harness();
    await healPermissionPrompts(h.deps);
    h.advance(PROMPT_GRACE_MS + 1);
    h.deps.pendingTool = async () => ({ name: "Bash", input: { command: `S=${SCRATCH}/s; rm -rf $S/y` } }); // outro comando = outro pedido
    expect((await healPermissionPrompts(h.deps)).waiting).toHaveLength(1);
    expect(h.pressed).toEqual([]);
    const semClaude = harness({ runsClaude: async () => false });
    await healPermissionPrompts(semClaude.deps);
    semClaude.advance(PROMPT_TIMEOUT_MS);
    await healPermissionPrompts(semClaude.deps);
    expect(semClaude.pressed).toEqual([]);
    const semSonda = harness({ liveTmux: async () => null });
    semSonda.advance(PROMPT_TIMEOUT_MS);
    expect(await healPermissionPrompts(semSonda.deps)).toEqual({ approved: [], rejected: [], waiting: [] });
  });

  it("depois de PROMPT_MAX_ANSWERS respostas na mesma sessão o resto é do humano (laço pedido→recusa→pedido)", async () => {
    const h = harness();
    for (let i = 0; i < PROMPT_MAX_ANSWERS; i++) {
      h.deps.pendingTool = async () => ({ name: "Bash", input: { command: `S=/root; rm -rf $S/x${i}` } });
      await healPermissionPrompts(h.deps);
      h.advance(PROMPT_GRACE_MS + 1);
      await healPermissionPrompts(h.deps);
    }
    expect(h.pressed).toHaveLength(PROMPT_MAX_ANSWERS);
    h.deps.pendingTool = async () => ({ name: "Bash", input: { command: `S=/root; rm -rf $S/novo` } });
    await healPermissionPrompts(h.deps);
    h.advance(PROMPT_GRACE_MS + 1);
    const r = await healPermissionPrompts(h.deps);
    expect(r.waiting[0]!.why).toMatch(/já respondeu/);
    expect(h.pressed).toHaveLength(PROMPT_MAX_ANSWERS);
  });

  it("a tecla que falha em ser pressionada tenta de novo no próximo passe e não registra decisão", async () => {
    const h = harness({ press: async () => false });
    await healPermissionPrompts(h.deps);
    h.advance(PROMPT_GRACE_MS + 1);
    const r = await healPermissionPrompts(h.deps);
    expect(r.approved).toEqual([]);
    expect(h.recorded).toEqual([]);
  });
});
