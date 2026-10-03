import { describe, expect, it } from "vitest";
import { boardForTmux, classifyFleetTmux, classifyTmux, fleetBoardByTmux, fleetRowsByTmux, isAgentKind, operatorLabel, tmuxRowClass } from "./processes";
import { fleetServiceStatus, laneOf, pipelineRunningCount, servesBoard, type RunningService } from "./types";
import type { TerminalPrefs } from "../terminal/prefs-store";
import type { AgentSession } from "@/lib/storymap/runner/session-worktree";

// Antes: o chip do terminal contava 4 (2 condutores + o `claude` e o `shell` do dono) e o /processes dizia
// «0 rodando» com dois condutores trabalhando — porque o tipo saía só do NOME, e `agent-conductor-…` caía em
// `tmux-adhoc` (raia terminal, origem «externo»). O registro da frota sabia de quem era cada sessão.
describe("classifyFleetTmux — da frota ou do dono, pelo REGISTRO antes do nome", () => {
  const row = (over: Partial<AgentSession> = {}): AgentSession => ({
    sessionId: "7d2f90a1",
    agentId: "7d2f90a1",
    role: "implement",
    task: "/harness-conductor story-ex0048 — conduzir a story de ponta a ponta",
    board: "armazem",
    cardId: "story-ex0048",
    driver: "conductor",
    spawnedBy: "human",
    tmuxSession: "agent-conductor-story-ex0048-9xn8",
    openedAt: "2026-09-14T15:22:00.000Z",
    heartbeatAt: "2026-09-14T15:31:40.215Z",
    ...over,
  });
  const WT = "/root/repo/.worktrees/agent-7d2f90a1";

  it("o condutor do registro é da FROTA: raia pipeline, nunca origem «externo», e conta como agente", () => {
    const v = classifyFleetTmux("agent-conductor-story-ex0048-9xn8", WT, row());
    expect(v).toMatchObject({ fleet: true, zombie: false });
    expect(laneOf("tmux-fleet")).toBe("pipeline");
    expect(isAgentKind("tmux-fleet")).toBe(true);
  });

  it("os terminais do dono (`claude`, `shell`) nunca são da frota — ficam em «seus terminais»", () => {
    for (const name of ["claude", "shell", "claude-main", "scratch-tmux"]) {
      expect(classifyFleetTmux(name, "/root/repo", undefined)).toEqual({ fleet: false });
      expect(laneOf(classifyTmux(name).kind)).toBe("terminal");
    }
  });

  it("ZUMBI: o registro tem a linha, mas a pasta de trabalho foi apagada (cwd «(deleted)»)", () => {
    expect(classifyFleetTmux("agent-conductor-story-ex0096-hmih", `${WT} (deleted)`, row())).toMatchObject({ fleet: true, zombie: true, why: "a pasta de trabalho foi apagada" });
  });

  it("ZUMBI: o nome é da frota (`agent-…`) mas a sessão saiu do registro", () => {
    expect(classifyFleetTmux("agent-conductor-story-ex0020-3j0e", WT, undefined)).toMatchObject({ fleet: true, zombie: true, why: "a sessão saiu do registro da frota" });
  });

  it("os nomes estruturais que não são da frota seguem pela regra do nome", () => {
    expect(classifyFleetTmux("card-acme__story-x", "/x", undefined)).toEqual({ fleet: false });
    expect(classifyFleetTmux("cop-revisao", "/x", undefined)).toEqual({ fleet: false });
  });

  it("fleetRowsByTmux: só a linha que ainda hospeda um tmux (óbito carimbado não conta)", () => {
    const idx = fleetRowsByTmux([row(), row({ sessionId: "morta", tmuxSession: "agent-x", endedAt: "2026-10-01T20:00:00.000Z" }), row({ sessionId: "sem-tmux", tmuxSession: undefined })]);
    expect([...idx.keys()]).toEqual(["agent-conductor-story-ex0048-9xn8"]);
  });

  it("o retrato típico: 2 condutores + o `claude` e o `shell` do dono + 1 zumbi ⇒ 2 agentes da frota", () => {
    const rows = fleetRowsByTmux([row(), row({ sessionId: "e19b6c35", agentId: "e19b6c35", cardId: "story-ex0096", tmuxSession: "agent-conductor-story-ex0096-hmih" })]);
    const tmux = [
      ["agent-conductor-story-ex0048-9xn8", WT],
      ["agent-conductor-story-ex0096-hmih", "/root/repo/.worktrees/agent-e19b6c35"],
      ["agent-conductor-story-ex0020-3j0e", "/root/repo/.worktrees/agent-gone (deleted)"],
      ["claude", "/root/repo"],
      ["shell", "/root/repo"],
    ] as const;
    const verdicts = tmux.map(([name, cwd]) => classifyFleetTmux(name, cwd, rows.get(name)));
    expect(verdicts.filter((v) => v.fleet && !v.zombie)).toHaveLength(2);
    expect(verdicts.filter((v) => v.fleet && v.zombie)).toHaveLength(1);
    expect(verdicts.filter((v) => !v.fleet)).toHaveLength(2);
  });
});

// O zumbi virou `tmux-fleet` e herdou a raia `pipeline` do tipo — status `idle`, que o /processes põe
// na lista viva —, então «Rodando no pipeline · 3» com 2 condutores reais: o zumbi CONTAVA, o oposto de C5. E um
// condutor quieto com o claude vivo seguia «running», porque o status vinha do processo, não da presença.
describe("a linha de um tmux no /processes — o zumbi não é pipeline; o status da frota é a PRESENÇA", () => {
  const row = (over: Partial<AgentSession> = {}): AgentSession =>
    ({ sessionId: "7d2f90a1", agentId: "7d2f90a1", role: "implement", task: "conduzir", board: "armazem", cardId: "story-ex0048", driver: "conductor", spawnedBy: "human", tmuxSession: "agent-conductor-story-ex0048-9xn8", openedAt: "2026-09-14T15:22:00.000Z", heartbeatAt: "2026-10-01T21:59:00.000Z", ...over }) as AgentSession;
  const WT = "/root/repo/.worktrees/agent-7d2f90a1";

  it("o zumbi (fora do registro, ou com a pasta apagada) vai para a raia «sobra» — nunca «pipeline» nem «seus terminais»", () => {
    const outOfRegistry = tmuxRowClass("agent-conductor-story-ex0020-3j0e", WT, undefined); // o caso vivo: sessão fora do registro
    const deletedCwd = tmuxRowClass("agent-conductor-story-ex0096-hmih", `${WT} (deleted)`, row());
    for (const c of [outOfRegistry, deletedCwd]) {
      expect(c).toMatchObject({ kind: "tmux-fleet", lane: "sobra" });
      expect(c.zombie).toBeTruthy();
    }
    expect(tmuxRowClass("agent-conductor-story-ex0048-9xn8", WT, row())).toEqual({ kind: "tmux-fleet", lane: "pipeline", row: row() });
    expect(tmuxRowClass("shell", "/root/repo", undefined)).toMatchObject({ kind: "tmux-shell", lane: "terminal" });
    expect(laneOf("tmux-fleet")).toBe("pipeline");
    expect(laneOf("tmux-fleet", true)).toBe("sobra");
  });

  const svc = (over: Partial<RunningService>): RunningService =>
    ({ id: `tmux:${over.tmuxSession ?? "x"}`, kind: "tmux-fleet", lane: "pipeline", label: "Condutor", status: "running", origin: "kanban", attachable: true, ...over }) as RunningService;

  it("o status da linha da frota sai da presença: trabalhando ⇒ rodando; parado, esperando ou perguntando ⇒ ocioso", () => {
    const byTmux = new Map([
      ["agent-a", "working"],
      ["agent-q", "quiet"],
      ["agent-w", "waiting"],
      ["agent-k", "asking"],
    ] as const);
    // o servidor viu o claude vivo dentro de todas (status running) — vida, não trabalho
    expect(fleetServiceStatus(svc({ tmuxSession: "agent-a" }), byTmux)).toBe("running");
    expect(fleetServiceStatus(svc({ tmuxSession: "agent-q" }), byTmux)).toBe("idle");
    expect(fleetServiceStatus(svc({ tmuxSession: "agent-w" }), byTmux)).toBe("idle");
    expect(fleetServiceStatus(svc({ tmuxSession: "agent-k" }), byTmux)).toBe("idle");
    // o zumbi nunca roda, nem com um claude vivo dentro
    expect(fleetServiceStatus(svc({ tmuxSession: "agent-a", zombie: true, lane: "sobra" }), byTmux)).toBe("idle");
    // a régua não conhece a sessão (sem card, ou o retrato ainda não chegou): fica o que o servidor viu
    expect(fleetServiceStatus(svc({ tmuxSession: "agent-sem-card" }), byTmux)).toBe("running");
    // as outras linhas não são da frota: o status é o delas
    expect(fleetServiceStatus(svc({ kind: "tmux-card", tmuxSession: "agent-q" }), byTmux)).toBe("running");
  });

  it("«Rodando no pipeline · N» conta só o que roda: o condutor quieto e o zumbi aparecem, não somam", () => {
    const byTmux = new Map([
      ["agent-a", "working"],
      ["agent-b", "working"],
      ["agent-q", "quiet"],
    ] as const);
    const zombie = tmuxRowClass("agent-conductor-story-ex0020-3j0e", WT, undefined);
    const rows = [
      svc({ tmuxSession: "agent-a" }),
      svc({ tmuxSession: "agent-b" }),
      svc({ tmuxSession: "agent-q" }),
      svc({ tmuxSession: "agent-conductor-story-ex0020-3j0e", lane: zombie.lane, zombie: true, status: "idle" }),
      svc({ kind: "tmux-shell", lane: "terminal", tmuxSession: "shell", status: "running" }),
    ].map((s) => ({ ...s, status: fleetServiceStatus(s, byTmux) }));
    expect(pipelineRunningCount(rows)).toBe(2);
  });
});

// Regression: the home Terminais panel + /processes showed the name-derived label (raw tmux name or
// the generic "Shell (bash)"), IGNORING the alias the operator set on the /terminal page. These pin
// that the operator's real name wins — the SAME precedence the terminal picker's deriveLabel uses.

describe("operatorLabel — o nome real do operador vence o rótulo derivado", () => {
  const prefs: TerminalPrefs = {
    shell: { alias: "Revisão do inventário" },
    "scratch-tmux": { alias: "limpeza do cache" },
    blank: { alias: "   " }, // só espaços — não conta como apelido
  };

  it("o apelido vence o rótulo genérico de um `shell`", () => {
    expect(operatorLabel("Shell (bash)", "shell", prefs)).toBe("Revisão do inventário");
  });

  it("o apelido vence o nome cru de uma sessão ad-hoc", () => {
    expect(operatorLabel("scratch-tmux", "scratch-tmux", prefs)).toBe("limpeza do cache");
  });

  it("sem apelido, o rótulo derivado permanece", () => {
    expect(operatorLabel("Claude master (interativo)", "claude-main", prefs)).toBe(
      "Claude master (interativo)",
    );
  });

  it("uma linha sem sessão tmux (run headless) mantém o rótulo derivado", () => {
    expect(operatorLabel("sincronizar · Comprar", undefined, prefs)).toBe("sincronizar · Comprar");
  });

  it("um apelido só de espaços é ignorado (fica com o derivado)", () => {
    expect(operatorLabel("Terminal · x", "blank", prefs)).toBe("Terminal · x");
  });

  it("prefs vazio nunca altera o rótulo", () => {
    expect(operatorLabel("Shell (bash)", "shell", {})).toBe("Shell (bash)");
  });
});

// O bloco Terminais da home mostrava a MÁQUINA inteira: com N boards no mesmo host, o operador via
// terminal de board alheio sem ter como atribuí-lo. Estas fixam as DUAS metades do conserto — de
// onde vem o board de uma linha, e quem passa no recorte.

describe("fleetBoardByTmux — o board de uma sessão da frota chega à linha do terminal", () => {
  it("indexa por nome de tmux a sessão que tem board", () => {
    const idx = fleetBoardByTmux([
      { tmuxSession: "agent-a91f", board: "acme" },
      { tmuxSession: "agent-7c2d", board: "storymap" },
    ]);
    expect(idx.get("agent-a91f")).toBe("acme");
    expect(idx.get("agent-7c2d")).toBe("storymap");
  });

  it("ignora sessão SEM board (self-dev) — nunca vira chave vazia", () => {
    const idx = fleetBoardByTmux([{ tmuxSession: "agent-0000" }, { board: "acme" }]);
    expect(idx.size).toBe(0);
  });

  it("o nome `card-<board>__<card>` já resolve sozinho — a frota é o fallback, não a fonte", () => {
    expect(classifyTmux("card-acme__story-4k2p").board).toBe("acme");
    expect(classifyTmux("agent-a91f").board).toBeUndefined();
  });
});

describe("servesBoard — a régua ESTRITA da home (sem board ⇒ fora)", () => {
  it("aceita a linha do próprio board", () => {
    expect(servesBoard({ board: "acme" }, "acme")).toBe(true);
  });

  it("recusa a linha de outro board — era o vazamento", () => {
    expect(servesBoard({ board: "storymap" }, "acme")).toBe(false);
  });

  it("recusa o trabalho SEM board (master, shell, cop-*, sessão sem card)", () => {
    expect(servesBoard({}, "acme")).toBe(false);
    expect(servesBoard({ board: undefined }, "acme")).toBe(false);
  });

  it("board vazio não casa com boardId vazio (não existe recorte sem nome)", () => {
    expect(servesBoard({ board: "" }, "")).toBe(false);
  });
});

describe("boardForTmux — a estrutura vence a preferência; o manual só preenche o vazio", () => {
  // O DEFEITO original: um tmux aberto à mão (`shell`, `term-2`, `term-3`) não ganhava board por
  // NENHUM caminho, então `servesBoard` o excluía da home de todos os boards — e não havia alavanca.
  // O vínculo manual é essa alavanca, mas ele NÃO pode contradizer um vínculo estrutural.
  const fleet = new Map([["agent-a91f", "acme"]]);
  const prefs: TerminalPrefs = {
    "card-acme__story-4k2p": { board: "galpao" }, // tentativa de reapontar um card
    "agent-a91f": { board: "galpao" }, //            tentativa de reapontar uma sessão da frota
    "term-2": { board: "storymap" }, //                o caso legítimo
    vazio: { board: "   " }, //                        só espaços — não conta como vínculo
  };

  it("o nome do card vence tudo — reapontá-lo faria a home de um board listar o card de outro", () => {
    expect(boardForTmux("card-acme__story-4k2p", "acme", fleet, prefs)).toEqual({
      board: "acme",
      boardSource: "card",
    });
  });

  it("a frota vence o manual — o claim é estrutural", () => {
    expect(boardForTmux("agent-a91f", undefined, fleet, prefs)).toEqual({
      board: "acme",
      boardSource: "fleet",
    });
  });

  it("sem board estrutural, o vínculo do operador vale — é o conserto do terminal invisível", () => {
    expect(boardForTmux("term-2", undefined, fleet, prefs)).toEqual({
      board: "storymap",
      boardSource: "manual",
    });
  });

  it("sem nenhuma das três fontes, não há board (e a origem também some)", () => {
    expect(boardForTmux("shell", undefined, fleet, prefs)).toEqual({});
    expect(boardForTmux("vazio", undefined, fleet, prefs)).toEqual({});
  });
});
