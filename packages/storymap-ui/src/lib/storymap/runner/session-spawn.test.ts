// WS-6.2/6.3 (storymap-parallel-work) — the work-oriented spawn.
//
// Two kinds of test live here, and the second kind is the point:
//   • the DECISIONS (route, claim shape, prompt contract) — pure, asserted directly;
//   • the CLI/tmux FACTS that were MEASURED on the box (session-spawn.ts header) and that fail SILENTLY when
//     someone "tidies" the code: the prompt must precede the variadic --mcp-config, the token must never reach
//     argv, the rollback must leave nothing half-born. A comment alone would not survive a refactor; these do.

import { describe, expect, it } from "vitest";
import {
  buildSessionClaudeArgs,
  buildSessionCommand,
  buildSessionPrompt,
  claimForRole,
  findRetrySpawn,
  resolveSessionRoute,
  SPAWN_RETRY_WINDOW_MS,
  sessionMcpConfigPath,
  sessionTmuxName,
  shellQuote,
  recycleSession,
  spawnWorkSession,
  hostNeedsRootBypass,
  writeSessionMcpConfig,
  CONDUCTOR_TOOLS,
  sessionToolScope,
  sessionMcpToolset,
  sessionContextPackPath,
  writeSessionContextPack,
  removeSessionArtifacts,
  SHELL_RUNNING_TOOLS,
  HARD_DENY_COVERED_SHELL_TOOLS,
  type SessionSpawnDeps,
} from "./session-spawn";
import { MCP_TOOLSET_HEADER } from "@/lib/storymap/mcp/toolsets";
import { sessionClaimActor, type CardClaim } from "./claims";
import type { AgentRole, AgentSession, SessionStore } from "./session-worktree";

// ── route (WS-7 door mapping) ──────────────────────────────────────────────────────────────────────

describe("resolveSessionRoute — o tier de uma sessão vem das portas que já existem (D10)", () => {
  it("um override explícito do humano VENCE a derivação do card", () => {
    const r = resolveSessionRoute({ role: "implement", override: "sonnet", cardRoute: { model: "opus", effort: "high" } });
    expect(r.model).toBe("sonnet");
    expect(r.why).toContain("override");
  });

  it("com card, usa a regra do PRÓPRIO card (a mesma dos runs) — não um eixo novo", () => {
    const r = resolveSessionRoute({ role: "implement", cardRoute: { model: "sonnet", effort: "high" } });
    expect(r).toMatchObject({ model: "sonnet", effort: "high" });
  });

  it("sem card, trabalho aberto vai a opus/high (nada mais limita o escopo)", () => {
    expect(resolveSessionRoute({ role: "free" })).toMatchObject({ model: "opus", effort: "high" });
    expect(resolveSessionRoute({ role: "implement", cardRoute: null })).toMatchObject({ model: "opus", effort: "high" });
  });

  it("papéis mecânicos (triage/steward) sem card vão no tier barato", () => {
    expect(resolveSessionRoute({ role: "triage" })).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(resolveSessionRoute({ role: "steward" })).toMatchObject({ model: "sonnet", effort: "medium" });
  });
});

// F7 — um retry de rede (o conector remoto atravessa proxy) não pode virar uma segunda sessão: dois
// tmux, duas árvores e duas vagas do cap gastas no mesmo trabalho. Sem card não havia trava nenhuma.
describe("findRetrySpawn — retry de rede ≠ pedido novo", () => {
  const NOW = 1_000_000;
  const sessao = (over: Partial<{ role: AgentRole; task: string; board: string; cardId: string; openedAt: string }> = {}) => ({
    role: "implement" as AgentRole,
    task: "arrumar o parser",
    openedAt: new Date(NOW - 10_000).toISOString(),
    ...over,
  });

  it("acha a sessão idêntica aberta dentro da janela", () => {
    expect(findRetrySpawn([sessao()], { role: "implement", task: "arrumar o parser" }, NOW)).toBeDefined();
  });

  it("NÃO acha fora da janela — aí é um pedido novo e legítimo", () => {
    const velha = sessao({ openedAt: new Date(NOW - SPAWN_RETRY_WINDOW_MS - 1).toISOString() });
    expect(findRetrySpawn([velha], { role: "implement", task: "arrumar o parser" }, NOW)).toBeUndefined();
  });

  it("tarefa diferente é trabalho diferente", () => {
    expect(findRetrySpawn([sessao()], { role: "implement", task: "outra coisa" }, NOW)).toBeUndefined();
  });

  it("papel diferente na mesma tarefa é outro pedido (implement × review)", () => {
    expect(findRetrySpawn([sessao()], { role: "review", task: "arrumar o parser" }, NOW)).toBeUndefined();
  });

  it("card diferente é outro pedido, mesmo com papel e tarefa iguais", () => {
    const comCard = sessao({ board: "acme", cardId: "story-1" });
    expect(
      findRetrySpawn([comCard], { role: "implement", task: "arrumar o parser", board: "acme", cardId: "story-2" }, NOW),
    ).toBeUndefined();
  });

  it("sessão COM card não casa com um pedido SEM card (undefined ≠ 'story-1')", () => {
    const comCard = sessao({ board: "acme", cardId: "story-1" });
    expect(findRetrySpawn([comCard], { role: "implement", task: "arrumar o parser" }, NOW)).toBeUndefined();
  });

  it("openedAt ilegível nunca casa (não dá para provar que é retry)", () => {
    expect(findRetrySpawn([sessao({ openedAt: "amanhã" })], { role: "implement", task: "arrumar o parser" }, NOW)).toBeUndefined();
  });

  it("sessão aberta no FUTURO (relógio torto) não casa", () => {
    const futura = sessao({ openedAt: new Date(NOW + 60_000).toISOString() });
    expect(findRetrySpawn([futura], { role: "implement", task: "arrumar o parser" }, NOW)).toBeUndefined();
  });
});

describe("claimForRole — D8: quem toca código reserva o card inteiro", () => {
  it("implement/review/free reservam escopo que inclui código (card-exclusivo)", () => {
    for (const role of ["implement", "review", "free"] as const) {
      expect(claimForRole(role).scope).toBe("both");
    }
  });
  it("triage/steward reservam só board-data (coexistem com um implementador)", () => {
    expect(claimForRole("triage")).toEqual({ kind: "triage", scope: "board" });
    expect(claimForRole("steward")).toEqual({ kind: "steward", scope: "board" });
  });
});

// ── the CLI contract (measured facts) ─────────────────────────────────────────────────────────────

describe("buildSessionClaudeArgs — FATO MEDIDO: --mcp-config é VARIÁDICO", () => {
  it("o prompt é o PRIMEIRO argumento e --mcp-config é o ÚLTIMO", () => {
    const args = buildSessionClaudeArgs({ prompt: "faça X", model: "opus", effort: "high", mcpConfigPath: "/s/x.json" });
    expect(args[0]).toBe("faça X");
    expect(args[args.length - 2]).toBe("--mcp-config");
    expect(args[args.length - 1]).toBe("/s/x.json");
  });

  it("REGRESSÃO: nenhum argumento vem DEPOIS do path do --mcp-config", () => {
    // O CLI lê tudo o que segue --mcp-config como MAIS arquivos de config: com o prompt depois, ele morre com
    // `MCP config file not found: <prompt>` e a sessão nunca nasce (medido na caixa).
    const args = buildSessionClaudeArgs({ prompt: "faça X", model: "sonnet", mcpConfigPath: "/s/x.json" });
    expect(args.indexOf("--mcp-config")).toBe(args.length - 2);
  });

  it("sem model/effort/config, o comando é só o prompt (o CLI aplica o default dele)", () => {
    expect(buildSessionClaudeArgs({ prompt: "oi" })).toEqual(["oi"]);
  });
});

// O início de uma sessão de condutor custava ~236k tokens porque ela herdava TUDO do operador (conectores, plugins,
// MCPs globais, todas as tools nativas). Só o PAPEL condutor fica enxuto; o terminal do operador segue como hoje.
describe("superfície do condutor — --tools + --strict-mcp-config SÓ para o driver conductor", () => {
  it("condutor: o argv exato — prompt PRIMEIRO, --tools numa string só, --strict-mcp-config, --mcp-config ÚLTIMO", () => {
    const args = buildSessionClaudeArgs({
      prompt: "/harness-conductor acme/story-ex9101",
      model: "opus",
      effort: "high",
      mcpConfigPath: "/s/x.json",
      ...sessionToolScope("conductor"),
    });
    expect(args).toEqual([
      "/harness-conductor acme/story-ex9101",
      "--model",
      "opus",
      "--effort",
      "high",
      "--tools",
      "Agent,Bash,Read,Edit,Write,Glob,Grep,TaskStop,WebFetch,WebSearch,ToolSearch",
      "--strict-mcp-config",
      "--mcp-config",
      "/s/x.json",
    ]);
  });

  it("SEGURANÇA: nenhuma tool que roda shell fora da trava dura do host (o hook gerenciado casa só com `Bash`)", () => {
    // `Monitor` executa o `command` dele no mesmo shell, e o hook `hard-deny` sai cedo para todo tool_name que não seja
    // Bash: uma sessão com Monitor rodaria o comando catastrófico que a trava recusa sem ela ver. Esta lista quebra antes.
    const shells = CONDUCTOR_TOOLS.filter((t) => (SHELL_RUNNING_TOOLS as readonly string[]).includes(t));
    expect(shells.filter((t) => !HARD_DENY_COVERED_SHELL_TOOLS.includes(t))).toEqual([]);
    expect(CONDUCTOR_TOOLS as readonly string[]).not.toContain("Monitor");
  });

  it("--tools é variádico: a lista é UM token e o seguinte é uma flag (nunca um valor que ela engula)", () => {
    const args = buildSessionClaudeArgs({ prompt: "p", mcpConfigPath: "/s/x.json", ...sessionToolScope("conductor") });
    const i = args.indexOf("--tools");
    expect(args[i + 1]).toBe(CONDUCTOR_TOOLS.join(","));
    expect(args[i + 2].startsWith("--")).toBe(true);
    expect(args.indexOf("--mcp-config")).toBe(args.length - 2);
  });

  it("sessão comum (sem driver, ou o terminal do operador): o argv de sempre, sem --tools nem --strict-mcp-config", () => {
    expect(sessionToolScope(undefined)).toEqual({});
    const args = buildSessionClaudeArgs({ prompt: "p", model: "opus", mcpConfigPath: "/s/x.json", ...sessionToolScope(undefined) });
    expect(args).toEqual(["p", "--model", "opus", "--mcp-config", "/s/x.json"]);
  });

  it("condutor SEM token: estrito mesmo assim (nenhuma MCP do operador vaza), e nada depois do prompt é posicional", () => {
    const args = buildSessionClaudeArgs({ prompt: "p", ...sessionToolScope("conductor") });
    expect(args).toEqual(["p", "--tools", CONDUCTOR_TOOLS.join(","), "--strict-mcp-config"]);
  });

  it("a lista do condutor não carrega tool que ele não usa (Skill, NotebookEdit, AskUserQuestion…)", () => {
    for (const t of ["Skill", "NotebookEdit", "AskUserQuestion"]) expect(CONDUCTOR_TOOLS).not.toContain(t as never);
  });

  // MEDIDO no CLI 2.1.289 (stream-json, um MCP de 140 tools, --strict-mcp-config): sem ToolSearch nenhum schema MCP é
  // adiado — o 1º turno leva os 140 (~125k tokens); com ela, ~7,6k, e a tool MCP segue chamável nos dois casos. Tirar
  // ToolSearch da lista enxuta só INFLA o início que a lista existe para cortar.
  it("ToolSearch FICA na lista do condutor: é ela que deixa o CLI adiar os schemas do MCP", () => {
    expect(CONDUCTOR_TOOLS).toContain("ToolSearch");
  });
});

describe("shellQuote/buildSessionCommand — o comando vai p/ `bash -lc`", () => {
  it("aspas simples no prompt não escapam do quoting (nem viram comando)", () => {
    const cmd = buildSessionCommand("claude", buildSessionClaudeArgs({ prompt: `don't; rm -rf /` }));
    expect(cmd).toBe(`'claude' 'don'\\''t; rm -rf /'`);
  });
  it("quota cada argumento, inclusive o binário", () => {
    expect(shellQuote("a b")).toBe("'a b'");
  });
});

describe("sessionTmuxName", () => {
  it("prefixa `agent-` e usa o slug quando dado", () => {
    expect(sessionTmuxName("abcdef12-0000", "Fix Login")).toBe("agent-fix-login");
  });
  it("sem slug, cai no id curto da sessão", () => {
    expect(sessionTmuxName("abcdef12-0000")).toBe("agent-abcdef12");
  });
  it("sanitiza um slug hostil p/ o charset que o tmux aceita", () => {
    expect(sessionTmuxName("abcdef12", "../../etc; rm")).toBe("agent-etc-rm");
  });
});

// ── the contract prompt ───────────────────────────────────────────────────────────────────────────

describe("buildSessionPrompt — o contrato chega COM a sessão, não num doc que ela nunca vai ler", () => {
  const base = { sessionId: "s-1", agentId: "a-1", role: "implement" as const, task: "arrumar o login" };

  it("uma sessão com árvore recebe o path, o branch e as 4 regras", () => {
    const p = buildSessionPrompt({ ...base, board: "acme", cardId: "story-1", worktreePath: "/repo/.worktrees/agent-s-1", branch: "agent/s-1" });
    expect(p).toContain("/repo/.worktrees/agent-s-1");
    expect(p).toContain("agent/s-1");
    expect(p).toContain("acme/story-1");
    expect(p).toContain("NUNCA edite o checkout de runtime");
    expect(p).toContain("worktree_submit");
    expect(p).toContain("worktree_discard");
  });

  it("uma sessão SEM árvore é mandada abrir uma antes de tocar em código", () => {
    const p = buildSessionPrompt({ ...base, role: "triage" });
    expect(p).toContain("worktree_open");
    expect(p).toContain("NUNCA edite o checkout");
  });

  it("na reciclagem, o prompt manda LER o estado antes de agir (não recomeçar)", () => {
    const p = buildSessionPrompt({ ...base, worktreePath: "/w", branch: "agent/s-1", handoff: true });
    expect(p).toContain("RECICLAGEM");
    expect(p).toContain("não recomece do zero");
  });

  it("fase 7 — a reciclagem de um condutor de LOTE nomeia os itens, cujos claims já são da sessão", () => {
    const p = buildSessionPrompt({ ...base, board: "acme", cardId: "story-ex9501", handoff: true, batchCardIds: ["story-ex9502", "story-ex9503"] });
    expect(p).toContain("LOTE: acme/story-ex9502, acme/story-ex9503");
    expect(buildSessionPrompt({ ...base, board: "acme", cardId: "story-ex9501" })).not.toContain("LOTE:");
  });
});

// ── G12: the scoped token ─────────────────────────────────────────────────────────────────────────

describe("writeSessionMcpConfig — G12: token ESCOPADO, e fora do argv", () => {
  it("escreve o mount com o token e devolve o path (0600, dir 0700)", async () => {
    const writes: Array<{ file: string; data: string; opts: unknown }> = [];
    const fs = {
      mkdir: async () => undefined,
      writeFile: async (file: unknown, data: unknown, opts: unknown) => {
        writes.push({ file: String(file), data: String(data), opts });
      },
    } as unknown as Parameters<typeof writeSessionMcpConfig>[0];
    const p = await writeSessionMcpConfig(fs, "/state", "s-1", "tok-123", 3008);
    expect(p).toBe(sessionMcpConfigPath("/state", "s-1"));
    expect(writes[0].data).toContain("tok-123");
    expect(writes[0].opts).toMatchObject({ mode: 0o600 });
  });

  it("SEM token não inventa mount: devolve null (o chamador avisa em vez de fingir)", async () => {
    const fs = { mkdir: async () => undefined, writeFile: async () => undefined } as unknown as Parameters<typeof writeSessionMcpConfig>[0];
    expect(await writeSessionMcpConfig(fs, "/state", "s-1", undefined, 3008)).toBeNull();
    expect(await writeSessionMcpConfig(fs, "/state", "s-1", "   ", 3008)).toBeNull();
  });

  it("REGRESSÃO: o token NUNCA entra no comando (ps é legível por qualquer agente da caixa)", () => {
    const cmd = buildSessionCommand(
      "claude",
      buildSessionClaudeArgs({ prompt: "trabalhe", mcpConfigPath: sessionMcpConfigPath("/state", "s-1") }),
    );
    expect(cmd).not.toContain("tok-123");
    expect(cmd).toContain("/state/sessions/s-1.mcp.json");
  });
});

// ── the spawn's refusals + rollback ───────────────────────────────────────────────────────────────

function memSessionStore(seed: AgentSession[] = []): SessionStore & { read: () => AgentSession[] } {
  let saved = seed;
  return {
    load: async () => saved.map((s) => ({ ...s })),
    persist: async (sessions) => {
      saved = sessions.map((s) => ({ ...s }));
    },
    read: () => saved,
  };
}

function liveClaim(over: Partial<CardClaim> = {}): CardClaim {
  return {
    board: "acme",
    cardId: "story-1",
    actor: "run:outro",
    kind: "implement",
    scope: "both",
    acquiredAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    ...over,
  };
}

/** Deps that FAIL LOUDLY on anything the test didn't intend to happen — the point of most cases below is that
 *  a refusal creates NOTHING, so an unexpected tmux/tree call must break the test, not pass silently. */
function spawnDeps(over: Partial<SessionSpawnDeps> = {}): SessionSpawnDeps & { created: string[] } {
  const created: string[] = [];
  const deps = {
    worktree: {
      store: memSessionStore(),
      exec: (async () => {
        throw new Error("git inesperado");
      }) as never,
      fs: {} as never,
      repoRoot: "/repo",
      ensureRunBase: async () => "base-sha",
      enqueueMerge: async () => {},
      liveRunIds: async () => [],
    },
    claims: {
      conflictFor: async () => null,
      acquire: async () => ({ ok: true, claim: liveClaim({ actor: "session:a" }) }) as const,
      release: async () => {},
    },
    cardRoute: async () => ({ model: "sonnet" as const, effort: "high" as const, title: "T" }),
    tmux: {
      exists: async () => false,
      create: async (name: string) => {
        created.push(name);
        return { ok: true };
      },
      survives: async () => true,
      kill: async () => {},
    },
    findTranscript: async () => null,
    fs: { mkdir: async () => undefined, writeFile: async () => undefined } as never,
    claudeBin: "claude",
    repoRoot: "/repo",
    stateDir: "/state",
    mcpToken: "tok",
    port: 3008,
    ...over,
  } as unknown as SessionSpawnDeps & { created: string[] };
  (deps as { created: string[] }).created = created;
  return deps;
}

describe("spawnWorkSession — uma recusa não deixa NADA pela metade", () => {
  it("card já reservado: recusa com o holder ANTES de criar árvore ou tmux", async () => {
    const deps = spawnDeps({
      claims: {
        conflictFor: async () => liveClaim({ actor: "session:outro-agente" }),
        acquire: async () => {
          throw new Error("não deveria tentar adquirir um card tomado");
        },
        release: async () => {},
      } as never,
    });
    const res = await spawnWorkSession(deps, { role: "triage", task: "t", board: "acme", cardId: "story-1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("card_claimed");
    expect(res.holder?.actor).toBe("session:outro-agente");
    expect(deps.created).toEqual([]); // nenhum tmux nasceu
  });

  it("papel sem código (triage) nasce SEM worktree e com o claim de board", async () => {
    const acquired: Array<{ actor: string; scope: string }> = [];
    const deps = spawnDeps({
      claims: {
        conflictFor: async () => null,
        acquire: async (req: { actor: string; scope: string }) => {
          acquired.push({ actor: req.actor, scope: req.scope });
          return { ok: true, claim: liveClaim({ actor: req.actor, kind: "triage", scope: "board" }) };
        },
        release: async () => {},
      } as never,
    });
    const res = await spawnWorkSession(deps, { role: "triage", task: "triar", board: "acme", cardId: "story-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.worktreePath).toBeUndefined();
    expect(res.session.adopted).toBeUndefined(); // sessão nossa sem árvore NÃO é dívida de adoção
    // O claim é do AGENTE (id lógico), não do processo — é o que sobrevive à reciclagem.
    expect(acquired[0]).toEqual({ actor: sessionClaimActor(res.session.agentId), scope: "board" });
    expect(deps.created).toEqual([res.tmuxSession]);
  });

  it("sessão que morre ao nascer: session_lost, e o claim é DEVOLVIDO", async () => {
    const released: string[] = [];
    const deps = spawnDeps({
      tmux: { exists: async () => false, create: async () => ({ ok: true }), survives: async () => false, kill: async () => {} } as never,
      claims: {
        conflictFor: async () => null,
        acquire: async (req: { actor: string }) => ({ ok: true, claim: liveClaim({ actor: req.actor }) }),
        release: async (_b: string, _c: string, actor: string) => {
          released.push(actor);
        },
      } as never,
    });
    const res = await spawnWorkSession(deps, { role: "triage", task: "t", board: "acme", cardId: "story-1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("session_lost");
    expect(released).toHaveLength(1); // o card não fica reservado por um processo que não existe
    expect(deps.worktree.store.load()).resolves.toEqual([]); // nem o registro sobra
  });

  it("sem token `orch`: a sessão sobe, mas o resultado ADMITE que ela não tem as tools", async () => {
    const deps = spawnDeps({ mcpToken: undefined });
    const res = await spawnWorkSession(deps, { role: "steward", task: "olhar o board", board: "acme" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mcpMounted).toBe(false);
  });

  it("uma sessão viva é registrada com o tmux que a hospeda (é o que a frota lê)", async () => {
    const deps = spawnDeps();
    const res = await spawnWorkSession(deps, { role: "steward", task: "varrer o board", board: "acme", name: "steward-1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.tmuxSession).toBe("agent-steward-1");
    const [stored] = await deps.worktree.store.load();
    expect(stored).toMatchObject({ tmuxSession: "agent-steward-1", role: "steward", model: "sonnet" });
  });

  it("sem card, nenhum claim é pedido (trabalho sem card é legítimo — D2)", async () => {
    const deps = spawnDeps({
      claims: {
        conflictFor: async () => {
          throw new Error("não deveria consultar claim sem card");
        },
        acquire: async () => {
          throw new Error("não deveria adquirir claim sem card");
        },
        release: async () => {},
      } as never,
    });
    const res = await spawnWorkSession(deps, { role: "steward", task: "varrer" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claim).toBeNull();
  });
});

// ── recycling (6.3 / AC5) ─────────────────────────────────────────────────────────────────────────
//
// AC5 is one sentence — "a reciclagem mantém worktree/branch/claims (agentId estável)" — and it is exactly
// the property a naive implementation (discard + claude_new) breaks: it would mint a new agentId, a new tree,
// and re-acquire its own card as a stranger, throwing away whatever was not yet integrated.

describe("recycleSession — troca o PROCESSO, preserva o AGENTE (AC5)", () => {
  function livingSession(over: Partial<AgentSession> = {}): AgentSession {
    return {
      sessionId: "s-live",
      agentId: "a-live",
      role: "implement",
      task: "arrumar o login",
      branch: "agent/s-live",
      worktreePath: "/repo/.worktrees/agent-s-live",
      baseCommit: "base",
      board: "acme",
      cardId: "story-1",
      tmuxSession: "agent-velha",
      model: "sonnet",
      openedAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      ...over,
    };
  }

  it("mantém agentId, worktree, branch e card — e o claim NUNCA é tocado", async () => {
    const store = memSessionStore([livingSession()]);
    const claimCalls: string[] = [];
    const deps = spawnDeps({
      worktree: { ...spawnDeps().worktree, store } as never,
      claims: {
        conflictFor: async () => {
          claimCalls.push("conflictFor");
          return null;
        },
        acquire: async () => {
          claimCalls.push("acquire");
          return { ok: true, claim: liveClaim() };
        },
        release: async () => {
          claimCalls.push("release");
        },
      } as never,
    });
    const res = await recycleSession(deps, { sessionId: "s-live" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.session.agentId).toBe("a-live"); // a identidade lógica sobrevive → o claim segue sendo dele
    expect(res.session.worktreePath).toBe("/repo/.worktrees/agent-s-live");
    expect(res.session.branch).toBe("agent/s-live");
    expect(res.session.cardId).toBe("story-1");
    expect(res.tmuxSession).not.toBe("agent-velha"); // só o processo mudou
    expect(res.previousTmux).toBe("agent-velha");
    // O claim nem foi consultado: reciclar não é re-adquirir. Qualquer chamada aqui denunciaria um
    // "discard + claude_new" disfarçado.
    expect(claimCalls).toEqual([]);
  });

  it("a sessão nova nasce ANTES de a antiga morrer (e só então a antiga morre)", async () => {
    const order: string[] = [];
    const store = memSessionStore([livingSession()]);
    const deps = spawnDeps({
      worktree: { ...spawnDeps().worktree, store } as never,
      tmux: {
        exists: async () => false,
        create: async (n: string) => {
          order.push(`create:${n}`);
          return { ok: true };
        },
        survives: async () => {
          order.push("survives");
          return true;
        },
        kill: async (n: string) => {
          order.push(`kill:${n}`);
        },
      } as never,
    });
    const res = await recycleSession(deps, { sessionId: "s-live" });
    expect(res.ok).toBe(true);
    expect(order[0]).toMatch(/^create:/);
    expect(order[1]).toBe("survives");
    expect(order[2]).toBe("kill:agent-velha"); // a antiga só cai DEPOIS de a nova provar que vive
  });

  it("se a sessão nova não sobe, a ANTIGA segue viva e dona da árvore (nada muda)", async () => {
    const store = memSessionStore([livingSession()]);
    const killed: string[] = [];
    const deps = spawnDeps({
      worktree: { ...spawnDeps().worktree, store } as never,
      tmux: {
        exists: async () => false,
        create: async () => ({ ok: true }),
        survives: async () => false,
        kill: async (n: string) => {
          killed.push(n);
        },
      } as never,
    });
    const res = await recycleSession(deps, { sessionId: "s-live" });
    expect(res.ok).toBe(false);
    expect(killed).not.toContain("agent-velha"); // a antiga NÃO foi morta
    const [stored] = await store.load();
    expect(stored.tmuxSession).toBe("agent-velha"); // o registro continua apontando p/ ela
  });

  it("recusa reciclar uma sessão ADOTADA (não temos árvore nem contrato dela)", async () => {
    const store = memSessionStore([livingSession({ adopted: true, worktreePath: undefined, branch: undefined })]);
    const deps = spawnDeps({ worktree: { ...spawnDeps().worktree, store } as never });
    const res = await recycleSession(deps, { sessionId: "s-live" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("ADOTADA");
  });

  it("sessão desconhecida: recusa em vez de criar uma do nada", async () => {
    const res = await recycleSession(spawnDeps(), { sessionId: "nao-existe" });
    expect(res.ok).toBe(false);
  });
});

// ── conductor-core — a sessão CONDUTORA ────────────────────────────────────────────────────────────────
// O prompt precisa COMEÇAR pelo comando da skill (senão o CLI lê "/harness-conductor …" como prosa enterrada
// depois do contrato, e a skill "talvez" carregue); a linha do registro carrega o driver (é o que a dispatch
// conta contra o cap); e uma reciclagem acorda DENTRO da skill de novo.
describe("sessão condutora — comando na frente, driver no registro, reciclagem re-invoca", () => {
  it("buildSessionPrompt: o comando é a PRIMEIRA linha; o contrato segue abaixo", () => {
    const p = buildSessionPrompt({
      command: "/harness-conductor acme/story-1",
      sessionId: "s-1",
      agentId: "a-1",
      role: "implement",
      task: "conduzir",
      board: "acme",
      cardId: "story-1",
      worktreePath: "/w",
      branch: "agent/s-1",
    });
    expect(p.split("\n")[0]).toBe("/harness-conductor acme/story-1");
    expect(p).toContain("worktree_submit");
    // sem comando, nada muda (as outras sessões)
    expect(buildSessionPrompt({ sessionId: "s", agentId: "a", role: "implement", task: "t" }).startsWith("Você é um agente")).toBe(true);
  });

  it("spawnWorkSession grava `driver` na linha da sessão e o comando chega no argv do tmux", async () => {
    const commands: string[] = [];
    const deps = spawnDeps({
      tmux: {
        exists: async () => false,
        create: async (_n: string, command: string) => {
          commands.push(command);
          return { ok: true };
        },
        survives: async () => true,
        kill: async () => {},
      } as never,
    });
    // triage = o caminho SEM árvore (o registerSession); o de árvore passa pela mesma porta de campos.
    const res = await spawnWorkSession(deps, {
      role: "triage",
      task: "conduzir",
      board: "acme",
      cardId: "story-1",
      driver: "conductor",
      command: "/harness-conductor acme/story-1",
    });
    expect(res.ok).toBe(true);
    const [stored] = await deps.worktree.store.load();
    expect(stored.driver).toBe("conductor");
    expect(commands[0]).toContain("'/harness-conductor acme/story-1\n\n");
    // o condutor nasce ENXUTO: só as tools que ele usa, só o MCP do AgileHarness
    expect(commands[0]).toContain(`'--tools' '${CONDUCTOR_TOOLS.join(",")}' '--strict-mcp-config'`);
  });

  it("spawnWorkSession SEM driver (o terminal do operador via claude_new): nada de --tools nem --strict-mcp-config", async () => {
    const commands: string[] = [];
    const deps = spawnDeps({
      tmux: {
        exists: async () => false,
        create: async (_n: string, command: string) => {
          commands.push(command);
          return { ok: true };
        },
        survives: async () => true,
        kill: async () => {},
      } as never,
    });
    const res = await spawnWorkSession(deps, { role: "triage", task: "/harness-conductor acme/story-1", board: "acme", cardId: "story-1" });
    expect(res.ok).toBe(true);
    expect(commands[0]).not.toContain("--tools");
    expect(commands[0]).not.toContain("--strict-mcp-config");
  });

  it("recycleSession de um condutor: o prompt novo começa pelo comando da skill (+ o handoff)", async () => {
    const store = memSessionStore([
      {
        sessionId: "s-live",
        agentId: "a-live",
        role: "implement",
        task: "conduzir",
        branch: "agent/s-live",
        worktreePath: "/w",
        baseCommit: "b",
        board: "acme",
        cardId: "story-1",
        driver: "conductor",
        tmuxSession: "agent-velha",
        openedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      },
    ]);
    const commands: string[] = [];
    const deps = spawnDeps({
      worktree: { ...spawnDeps().worktree, store } as never,
      tmux: {
        exists: async () => false,
        create: async (_n: string, command: string) => {
          commands.push(command);
          return { ok: true };
        },
        survives: async () => true,
        kill: async () => {},
      } as never,
    });
    const res = await recycleSession(deps, { sessionId: "s-live" });
    expect(res.ok).toBe(true);
    expect(commands[0]).toContain("'/harness-conductor acme/story-1\n\n");
    expect(commands[0]).toContain("RECICLAGEM");
    // o reciclado herda a MESMA superfície enxuta do despachado
    expect(commands[0]).toContain(`'--tools' '${CONDUCTOR_TOOLS.join(",")}' '--strict-mcp-config'`);
  });
});

// ── o CENSO dos chamadores do spawn de sessão (a família tmux que o lint de env declara fora do alcance) ──────
// `spawn-chokepoint.test.ts` recenseia quem spawna o binário do Claude DIRETO; a família mediada por tmux
// (`spawnWorkSession`) ficava sem censo. Agora há um SEGUNDO chamador — a dispatch do condutor, que abre sessões
// SEM uma chamada humana — e ele não pode nascer calado: um chamador novo reprova aqui até ser registrado.
describe("censo — quem chama spawnWorkSession", () => {
  const SPAWN_WORK_SESSION_CALLERS: Record<string, string> = {
    "src/lib/storymap/mcp/dev-tools.ts": "claude_new — o operador (ou o copiloto) abre uma sessão da frota",
    "src/lib/storymap/runner/fleet-deps.ts": "a dispatch do CONDUTOR — um card entra em `conductor.fromStatus` e ganha uma sessão",
  };

  it("os chamadores são exatamente os registrados", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, acc);
        else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) acc.push(p);
      }
      return acc;
    };
    const callers = walk("src")
      .filter((f) => !f.endsWith("runner/session-spawn.ts"))
      .filter((f) => /\bspawnWorkSession\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual(Object.keys(SPAWN_WORK_SESSION_CALLERS).sort());
  });
});


// ── fact 4 (v0.8.1): as ROOT with an inherited `bypassPermissions`, the session dies at birth unless the command
//    carries IS_SANDBOX=1 — measured: every conductor dispatch ended `session_lost` on the reference host.
describe("root-guard escape — IS_SANDBOX=1 só quando root + bypass herdado", () => {
  it("hostNeedsRootBypass: só root, POSIX e modo herdado bypassPermissions", () => {
    expect(hostNeedsRootBypass({ uid: 0, platform: "linux", inheritedDefaultMode: "bypassPermissions" })).toBe(true);
    expect(hostNeedsRootBypass({ uid: 1000, platform: "linux", inheritedDefaultMode: "bypassPermissions" })).toBe(false);
    expect(hostNeedsRootBypass({ uid: 0, platform: "linux", inheritedDefaultMode: "acceptEdits" })).toBe(false);
    expect(hostNeedsRootBypass({ uid: 0, platform: "linux", inheritedDefaultMode: undefined })).toBe(false);
    expect(hostNeedsRootBypass({ uid: 0, platform: "win32", inheritedDefaultMode: "bypassPermissions" })).toBe(false);
    expect(hostNeedsRootBypass({ uid: undefined, platform: "linux", inheritedDefaultMode: "bypassPermissions" })).toBe(false);
  });

  it("buildSessionCommand prefixa o escape como constante, e só quando pedido", () => {
    const args = buildSessionClaudeArgs({ prompt: "/harness-conductor acme/story-1", model: "opus" });
    expect(buildSessionCommand("claude", args, { rootBypass: true })).toBe(`IS_SANDBOX=1 ${buildSessionCommand("claude", args)}`);
    expect(buildSessionCommand("claude", args)).not.toMatch(/IS_SANDBOX/);
    expect(buildSessionCommand("claude", args, { rootBypass: false })).not.toMatch(/IS_SANDBOX/);
  });

  it("spawnWorkSession leva o escape até o comando do tmux quando a fiação diz rootBypass", async () => {
    const commands: string[] = [];
    const tmux = {
      exists: async () => false,
      create: async (_name: string, command: string) => {
        commands.push(command);
        return { ok: true };
      },
      survives: async () => true,
      kill: async () => {},
    };
    const withEscape = await spawnWorkSession(spawnDeps({ rootBypass: true, tmux } as never), { role: "triage", task: "t" });
    const without = await spawnWorkSession(spawnDeps({ tmux } as never), { role: "triage", task: "t" });
    expect(withEscape.ok && without.ok).toBe(true);
    expect(commands[0].startsWith("IS_SANDBOX=1 'claude' ")).toBe(true);
    expect(commands[1].startsWith("'claude' ")).toBe(true);
  });
});


describe("o modelo da sessão com a variante de 1M (v0.8.2)", () => {
  it("buildSessionClaudeArgs passa `--model opus[1m]` intacto (e depois do prompt, antes do --mcp-config)", () => {
    const args = buildSessionClaudeArgs({ prompt: "/harness-conductor acme/story-1", model: "opus[1m]", mcpConfigPath: "/c.json" });
    expect(args).toEqual(["/harness-conductor acme/story-1", "--model", "opus[1m]", "--mcp-config", "/c.json"]);
    expect(buildSessionCommand("claude", args)).toContain("'--model' 'opus[1m]'");
  });

  it("o override do chamador (o condutor) com [1m] vence a rota do card", () => {
    expect(resolveSessionRoute({ role: "implement", override: "opus[1m]", cardRoute: { model: "sonnet", effort: "high" } }).model).toBe("opus[1m]");
  });
});

// ── o PACOTE DE CONTEXTO e o CONJUNTO DE TOOLS do papel (fase 6) ─────────────────────────────────────────────────
// O condutor nasce com o norte do produto no prompt de SISTEMA (`--append-system-prompt-file`, o canal que sobrevive à
// compactação) e com a superfície MCP do papel dele (o cabeçalho de toolset no arquivo de MCP). Uma sessão que não é
// condutora não muda nada.
describe("o condutor nasce com o pacote de contexto e o conjunto de tools do papel", () => {
  function recording(over: Partial<SessionSpawnDeps> = {}) {
    const commands: string[] = [];
    const files = new Map<string, { data: string; opts: unknown }>();
    const deps = spawnDeps({
      fs: {
        mkdir: async () => undefined,
        writeFile: async (file: unknown, data: unknown, opts: unknown) => void files.set(String(file), { data: String(data), opts }),
      } as never,
      tmux: {
        exists: async () => false,
        create: async (_n: string, command: string) => {
          commands.push(command);
          return { ok: true };
        },
        survives: async () => true,
        kill: async () => {},
      } as never,
      contextPack: async (board: string, cardId: string) => ({ text: `# Pacote de contexto · ${board}/${cardId} · abc123`, hash: "abc123", tokens: 12 }),
      ...over,
    });
    return { deps, commands, files };
  }
  const conduct = { role: "triage" as AgentRole, task: "conduzir", board: "acme", cardId: "story-ex9101", driver: "conductor" as const, command: "/harness-conductor acme/story-ex9101" };

  it("spawn de condutor: escreve o pacote (0600) e o entrega por --append-system-prompt-file ANTES do --mcp-config", async () => {
    const { deps, commands, files } = recording();
    const res = await spawnWorkSession(deps, conduct);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const packPath = sessionContextPackPath("/state", res.session.sessionId);
    expect(files.get(packPath)?.data).toContain("# Pacote de contexto · acme/story-ex9101 · abc123");
    expect(files.get(packPath)?.opts).toMatchObject({ mode: 0o600 });
    expect(res.contextPack).toEqual({ path: packPath, hash: "abc123", tokens: 12 });
    const cmd = commands[0];
    expect(cmd).toContain(`'--append-system-prompt-file' '${packPath}'`);
    // fato 1: o --mcp-config é variádico e fica por ÚLTIMO
    expect(cmd.indexOf("--append-system-prompt-file")).toBeLessThan(cmd.indexOf("--mcp-config"));
    expect(cmd.trimEnd().endsWith(`'${sessionMcpConfigPath("/state", res.session.sessionId)}'`)).toBe(true);
  });

  it("o arquivo de MCP do condutor pede o conjunto `conductor` (o token segue o mesmo, fora do argv)", async () => {
    const { deps, files } = recording();
    const res = await spawnWorkSession(deps, conduct);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cfg = JSON.parse(files.get(sessionMcpConfigPath("/state", res.session.sessionId))!.data);
    expect(cfg.mcpServers.storymap.headers[MCP_TOOLSET_HEADER]).toBe("conductor");
    expect(cfg.mcpServers.storymap.url).toContain("/api/mcp/tok/mcp");
  });

  it("sessão que NÃO é condutora: sem pacote, sem cabeçalho de papel (herda a superfície do nível, como antes)", async () => {
    let asked = 0;
    const { deps, commands, files } = recording({
      contextPack: async () => {
        asked++;
        return { text: "x", hash: "h", tokens: 1 };
      },
    });
    const res = await spawnWorkSession(deps, { role: "triage", task: "t", board: "acme", cardId: "story-ex9101" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(asked).toBe(0);
    expect(commands[0]).not.toContain("--append-system-prompt-file");
    expect(res.contextPack).toBeUndefined();
    const cfg = JSON.parse(files.get(sessionMcpConfigPath("/state", res.session.sessionId))!.data);
    expect(cfg.mcpServers.storymap.headers?.[MCP_TOOLSET_HEADER]).toBeUndefined();
  });

  it("FAIL-OPEN: o montador do pacote falha ⇒ a sessão nasce sem pacote (nunca deixa de nascer por ele)", async () => {
    const { deps, commands } = recording({
      contextPack: async () => {
        throw new Error("disco");
      },
    });
    const res = await spawnWorkSession(deps, conduct);
    expect(res.ok).toBe(true);
    expect(commands[0]).not.toContain("--append-system-prompt-file");
  });

  it("reciclagem de um condutor RE-MONTA o pacote (as fontes podem ter mudado) e mantém o conjunto do papel", async () => {
    const store = memSessionStore([
      {
        sessionId: "s-live",
        agentId: "a-live",
        role: "implement",
        task: "conduzir",
        branch: "agent/s-live",
        worktreePath: "/w",
        baseCommit: "b",
        board: "acme",
        cardId: "story-ex9101",
        driver: "conductor",
        tmuxSession: "agent-velha",
        openedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      },
    ]);
    let n = 0;
    const { deps, commands, files } = recording({
      worktree: { ...spawnDeps().worktree, store } as never,
      contextPack: async () => ({ text: `pacote v${++n}`, hash: `h${n}`, tokens: 3 }),
    });
    const res = await recycleSession(deps, { sessionId: "s-live" });
    expect(res.ok).toBe(true);
    expect(n).toBe(1);
    expect(files.get(sessionContextPackPath("/state", "s-live"))?.data).toBe("pacote v1");
    expect(commands[0]).toContain(`'--append-system-prompt-file' '${sessionContextPackPath("/state", "s-live")}'`);
    expect(JSON.parse(files.get(sessionMcpConfigPath("/state", "s-live"))!.data).mcpServers.storymap.headers[MCP_TOOLSET_HEADER]).toBe("conductor");
  });

  it("a linha do registro guarda hash + tokens do pacote (telemetria; o que a skill compara depois de reciclar)", async () => {
    const { deps } = recording();
    const res = await spawnWorkSession(deps, conduct);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = (await deps.worktree.store.load()).find((r) => r.sessionId === res.session.sessionId);
    expect(row?.contextPack).toEqual({ hash: "abc123", tokens: 12 });
  });

  it("skill MONOLÍTICA no worktree (sem ref/) ⇒ sem pacote: com ela o pacote só somaria tokens", async () => {
    const seen: string[] = [];
    let asked = 0;
    const { deps, commands } = recording({
      hasSplitConductorSkill: async (cwd: string) => {
        seen.push(cwd);
        return false;
      },
      contextPack: async () => {
        asked++;
        return { text: "x", hash: "h", tokens: 1 };
      },
    });
    const res = await spawnWorkSession(deps, conduct);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(seen).toEqual(["/repo"]);
    expect(asked).toBe(0);
    expect(commands[0]).not.toContain("--append-system-prompt-file");
    expect((await deps.worktree.store.load()).find((r) => r.sessionId === res.session.sessionId)?.contextPack).toBeUndefined();
  });

  it("a sessão que sai do registro leva junto o token MCP e o pacote (nada se acumula em .runner/sessions)", async () => {
    const removed: string[] = [];
    const base = spawnDeps().worktree;
    const { deps } = recording({
      worktree: { ...base, removeSessionFiles: async (id: string) => void removed.push(id) } as never,
      tmux: { exists: async () => false, create: async () => ({ ok: true }), survives: async () => false, kill: async () => {} } as never,
    });
    const res = await spawnWorkSession(deps, conduct);
    expect(res.ok).toBe(false);
    expect(removed).toHaveLength(1);
    const rm: string[] = [];
    await removeSessionArtifacts({ rm: async (f: unknown) => void rm.push(String(f)) } as never, "/state", "s-9");
    expect(rm.sort()).toEqual([sessionContextPackPath("/state", "s-9"), sessionMcpConfigPath("/state", "s-9")].sort());
  });

  it("helpers: o papel só para o condutor; pacote vazio não vira arquivo", async () => {
    expect(sessionMcpToolset("conductor")).toBe("conductor");
    expect(sessionMcpToolset(undefined)).toBeUndefined();
    const fs = { mkdir: async () => undefined, writeFile: async () => undefined } as never;
    expect(await writeSessionContextPack(fs, "/state", "s", { text: "  ", hash: "h", tokens: 0 })).toBeNull();
    expect(await writeSessionContextPack(fs, "/state", "s", null)).toBeNull();
    expect(buildSessionClaudeArgs({ prompt: "p", appendSystemPromptFile: "/s/p.md", mcpConfigPath: "/s/m.json" })).toEqual([
      "p",
      "--append-system-prompt-file",
      "/s/p.md",
      "--mcp-config",
      "/s/m.json",
    ]);
  });
});
