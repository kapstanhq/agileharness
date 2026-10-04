import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IO boundaries the guard touches; keep the policy kernel + actor ALS REAL.
const readBoardConfig = vi.fn();
vi.mock("@/lib/storymap/repo", () => ({ readBoardConfig: (...a: unknown[]) => readBoardConfig(...a) }));

const findMatchingGrant = vi.fn();
const consumeGrant = vi.fn();
const createApprovalRequest = vi.fn();
vi.mock("@/lib/storymap/approvals", () => ({
  findMatchingGrant: (...a: unknown[]) => findMatchingGrant(...a),
  consumeGrant: (...a: unknown[]) => consumeGrant(...a),
  createApprovalRequest: (...a: unknown[]) => createApprovalRequest(...a),
}));

const actions: unknown[] = [];
vi.mock("@/lib/storymap/runner/agent-actions", () => ({
  appendAgentAction: (rec: unknown) => { actions.push(rec); return Promise.resolve(); },
}));

// The two registries the guard derives a SCOPE from when the args carry no `board` — a sessionId
// (the fleet's worktree lifecycle) or a runId (the train's resolve_merge). Mocked at the same boundary as
// the rest: the derivation is the behavior under test, not the disk.
const sessionLoad = vi.fn();
vi.mock("@/lib/storymap/runner/session-worktree", () => ({
  makeSessionStore: () => ({ load: () => sessionLoad(), persist: async () => {} }),
  // o registro de sessões que a guarda consulta para dizer QUEM chamou (mcp/caller.ts)
  allSessions: () => sessionLoad(),
}));

// O diário do board (o que o dono lê no chat): gravado em memória para o teste ler a VOZ de cada desfecho.
const diary: Array<{ board: string; kind: string; text: string }> = [];
vi.mock("@/lib/storymap/copilot/activity", () => ({
  appendCopilotActivity: (board: string, e: { kind: string; text: string }) => {
    diary.push({ board, kind: e.kind, text: e.text });
    return Promise.resolve();
  },
}));
const mergeQueueSnapshot = vi.fn();
vi.mock("@/lib/storymap/runner/merge-queue", () => ({
  getMergeQueue: () => ({ getSnapshot: () => mergeQueueSnapshot() }),
}));

// O escopo REPO (scope.ts) — a matriz que governa a branch `stage`/a suíte/o serviço vem do settings.yaml,
// não de um board.yaml. Mockado no mesmo limite dos demais: a decisão é o que está sob teste, não o disco.
const loadRunnerConfig = vi.fn();
vi.mock("@/lib/storymap/runner/config", () => ({ loadRunnerConfig: () => loadRunnerConfig() }));

const readOrchestratorState = vi.fn();
const writeOrchestratorState = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/storymap/runner/orchestrator-state", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual, // rateWithinLimit / applyAction (pure) stay real
    readOrchestratorState: (...a: unknown[]) => readOrchestratorState(...a),
    writeOrchestratorState: (...a: unknown[]) => writeOrchestratorState(...a),
  };
});

import { guardToolCall, BRAKE_TOOLS, stricterDisposition } from "./guard";
import { runWithMcpActor } from "./actor";
import { emptyOrchestratorState } from "@/lib/storymap/runner/orchestrator-state";
import type { OrchestratorPolicy } from "@/lib/storymap/types";

const scoped = <T>(fn: () => Promise<T>) => runWithMcpActor({ level: "write", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, fn);
const policy = (over: Partial<OrchestratorPolicy> = {}): OrchestratorPolicy => ({ mode: "autonomous", ...over });

beforeEach(() => {
  actions.length = 0;
  diary.length = 0;
  readBoardConfig.mockReset().mockResolvedValue({ orchestrator: policy() });
  findMatchingGrant.mockReset().mockResolvedValue(null);
  consumeGrant.mockReset().mockResolvedValue(false);
  createApprovalRequest.mockReset().mockResolvedValue({ id: "apr-test" });
  readOrchestratorState.mockReset().mockResolvedValue(emptyOrchestratorState(1_800_000_000_000));
  writeOrchestratorState.mockClear();
  sessionLoad.mockReset().mockResolvedValue([]);
  mergeQueueSnapshot.mockReset().mockReturnValue({ entries: [], processing: false });
  loadRunnerConfig.mockReset().mockReturnValue({ orchestrator: {} }); // matriz de repo NÃO declarada
});

// O ESCOPO REPO — a 3ª ocorrência da forma "capacidade estruturalmente inalcançável" (ver scope.ts). Uma tool
// que age no REPO (a branch `stage`, a suíte, o serviço) não tem board dono; o guard tratava isso como "sem
// board" e RECUSAVA com "refaça com o board", num schema que não tem board. Medido: `reconcile_stage` — a cura
// do stage defasado, justamente o que destrava um release preso — era inalcançável para o tick autônomo.
describe("guardToolCall — escopo REPO (settings.yaml, não board.yaml)", () => {
  it("reconcile_stage SEM matriz de repo: recusa — mas nomeando a alavanca REAL, não um board inexistente", async () => {
    const r = await scoped(() => guardToolCall("reconcile_stage", "merge-resolve", { mode: "sync" }));
    expect(r?.isError).toBe(true);
    const text = String((r?.content as { text: string }[])[0].text);
    expect(text).toContain("orchestrator.riskMatrix.merge-resolve: auto"); // conselho SEGUÍVEL
    expect(text).not.toContain("Refaça com o board"); // o conselho impossível não pode voltar
    expect(readBoardConfig).not.toHaveBeenCalled(); // nenhum board é dono disto
  });

  it("reconcile_stage COM `merge-resolve: auto` no settings.yaml: roda sozinha (o tick se desatola)", async () => {
    loadRunnerConfig.mockReturnValue({ orchestrator: { riskMatrix: { "merge-resolve": "auto" } } });
    const r = await scoped(() => guardToolCall("reconcile_stage", "merge-resolve", { mode: "sync" }));
    expect(r).toBeNull(); // ALLOW
    expect(actions.at(-1)).toMatchObject({ tool: "reconcile_stage", disposition: "auto", outcome: "executed" });
  });

  it("o clamp NEVER_AUTO vale no escopo repo: `run-free: auto` no settings.yaml NÃO entrega um shell", async () => {
    // Defesa em profundidade — um settings.yaml editado à mão pula qualquer lint, nunca o clamp de dispositionFor.
    loadRunnerConfig.mockReturnValue({ orchestrator: { riskMatrix: { "run-free": "auto" } } });
    const r = await scoped(() => guardToolCall("run_task", "run-free", { prompt: "rm -rf /" }));
    expect(r?.isError).toBe(true);
    expect(actions.at(-1)).toMatchObject({ tool: "run_task", outcome: "refused" });
  });

  it("uma leitura de config que EXPLODE degrada para o default conservador (nunca fail-open)", async () => {
    loadRunnerConfig.mockImplementation(() => { throw new Error("settings.yaml ilegível"); });
    const r = await scoped(() => guardToolCall("reconcile_stage", "merge-resolve", { mode: "sync" }));
    expect(r?.isError).toBe(true);
  });

  it("o operador (`full`) nunca é afetado: escopo repo não muda o curto-circuito", async () => {
    const r = await runWithMcpActor({ level: "full" }, () =>
      guardToolCall("reconcile_stage", "merge-resolve", { mode: "reset", confirmReset: true }),
    );
    expect(r).toBeNull();
  });
});

// A call that carries no `board` is not necessarily unscopable: the identity it DOES carry
// (sessionId / runId) names one. Before this, those tools hit the `ask` path board-less and were refused
// with "refaça com o board" — an instruction with no parameter able to satisfy it, which left the fleet
// unable to integrate its own work and `resolve_merge` unable to unpark the train under a scoped token.
describe("guardToolCall — o ESCOPO derivado da sessão/run", () => {
  it("worktree_submit de uma sessão COM board → a matriz DAQUELE board decide (governança preservada)", async () => {
    sessionLoad.mockResolvedValue([{ sessionId: "s1", board: "acme" }]);
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { session: "ask" } }) });
    const r = await scoped(() => guardToolCall("worktree_submit", "session", { sessionId: "s1" }));
    // Escalou para o board CERTO — a aprovação aterrissa no Inbox do acme, não numa recusa cega.
    expect(readBoardConfig).toHaveBeenCalledWith("acme");
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ board: "acme", tool: "worktree_submit", riskClass: "session" }));
    expect(r?.isError).toBeUndefined();
    expect(actions.at(-1)).toMatchObject({ board: "acme", disposition: "ask", outcome: "pending" });
  });

  it("worktree_submit de uma sessão CARD-LESS → roda (o gate do train é o controle), nunca a recusa sem saída", async () => {
    // A sessão card-less é LEGÍTIMA (`kind: session`) — não existe board para escapar a aprovação.
    // Este é o caso que provei ao vivo recusado: "exige aprovação humana, mas a chamada não traz um board".
    sessionLoad.mockResolvedValue([{ sessionId: "s2", board: undefined }]);
    const r = await scoped(() => guardToolCall("worktree_submit", "session", { sessionId: "s2" }));
    expect(r).toBeNull(); // ALLOW
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(actions.at(-1)).toMatchObject({ tool: "worktree_submit", cls: "session", disposition: "auto", outcome: "executed" });
  });

  it("resolve_merge({runId}) → o board vem da ENTRY do train (antes: recusado por não ter board)", async () => {
    mergeQueueSnapshot.mockReturnValue({ entries: [{ runId: "r9", board: "acme", cardId: "c1" }], processing: false });
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "merge-resolve": "auto" } }) });
    const r = await scoped(() => guardToolCall("resolve_merge", "merge-resolve", { runId: "r9" }));
    expect(r).toBeNull();
    expect(readBoardConfig).toHaveBeenCalledWith("acme");
    // E o ledger deixa de gravar `board: undefined` em toda ação de train — a trilha volta a ser atribuível.
    expect(actions.at(-1)).toMatchObject({ board: "acme", tool: "resolve_merge", outcome: "executed" });
  });

  it("um `board` explícito nos args SEMPRE vence (a derivação nunca sobrepõe o que o chamador nomeou)", async () => {
    sessionLoad.mockResolvedValue([{ sessionId: "s1", board: "outro-board" }]);
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { session: "auto" } }) });
    await scoped(() => guardToolCall("worktree_submit", "session", { board: "acme", sessionId: "s1" }));
    expect(readBoardConfig).toHaveBeenCalledWith("acme");
  });

  it("registro ilegível ⇒ degrada para 'sem board' (fail-open no caminho quente), nunca estoura", async () => {
    sessionLoad.mockRejectedValue(new Error("registry corrupto"));
    const r = await scoped(() => guardToolCall("worktree_submit", "session", { sessionId: "s1" }));
    expect(r).toBeNull(); // a classe `session` decide; a leitura quebrada não vira crash nem recusa
  });

  it("a classe `session` NÃO é um cavalo de Troia: run-free segue recusada mesmo vinda de uma sessão", async () => {
    sessionLoad.mockResolvedValue([{ sessionId: "s2", board: undefined }]);
    const r = await scoped(() => guardToolCall("run_task", "run-free", { sessionId: "s2", prompt: "rm -rf /" }));
    expect(r?.isError).toBe(true); // `never` — a fronteira do shell não se move
    expect(actions.at(-1)).toMatchObject({ disposition: "never", outcome: "refused" });
  });
});

describe("guardToolCall (F5.2) — per-call enforcement", () => {
  it("a FULL operator token is never gated (short-circuits before any IO)", async () => {
    const r = await runWithMcpActor({ level: "full" }, () => guardToolCall("delete_card", "destructive", { board: "acme", cardId: "c1" }));
    expect(r).toBeNull();
    expect(readBoardConfig).not.toHaveBeenCalled();
  });

  it("an internal call (no actor) is never gated", async () => {
    expect(await guardToolCall("move_card", "write-board", { board: "acme" })).toBeNull();
  });

  it("a scoped READ always passes", async () => {
    expect(await scoped(() => guardToolCall("get_card", "read", { board: "acme" }))).toBeNull();
    expect(readBoardConfig).not.toHaveBeenCalled();
  });

  it("scoped write-board with board matrix `auto` → executes (null) + audits + increments rate", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) });
    const r = await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" }));
    expect(r).toBeNull();
    expect(writeOrchestratorState).toHaveBeenCalled(); // rate bumped
    expect(actions.at(-1)).toMatchObject({ tool: "move_card", disposition: "auto", outcome: "executed" });
  });

  it("scoped write-board with NO matrix declared → defaults to ASK → pending approval created (not run)", async () => {
    const r = await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" }));
    expect(r).not.toBeNull();
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ board: "acme", tool: "move_card", riskClass: "write-board" }));
    const payload = JSON.parse((r!.content[0] as { text: string }).text);
    expect(payload).toMatchObject({ ok: false, pendingApproval: "apr-test" });
    expect(actions.at(-1)).toMatchObject({ disposition: "ask", outcome: "pending", approvalId: "apr-test" });
  });

  it("scoped RUN → default ASK (escalável) → pending approval, not a silent refusal", async () => {
    // F5.0 kernel: run/merge-resolve default to `ask` (the tick can REQUEST approval for a pipeline run),
    // never `auto` (the kernel clamps run:auto→ask). So a run becomes a pending approval, not an isError.
    const r = await scoped(() => guardToolCall("run_task", "run", { board: "acme" }));
    expect(r?.isError).toBeUndefined();
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ riskClass: "run" }));
    expect(actions.at(-1)).toMatchObject({ disposition: "ask", outcome: "pending" });
  });

  it("scoped DEPLOY → never (hard refusal — a human deploys directly), no approval path", async () => {
    const r = await scoped(() => guardToolCall("deploy", "deploy", { board: "acme" }));
    expect(r?.isError).toBe(true);
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(actions.at(-1)).toMatchObject({ cls: "deploy", disposition: "never", outcome: "refused" });
  });

  it("scoped DESTRUCTIVE → never refusal", async () => {
    const r = await scoped(() => guardToolCall("delete_card", "destructive", { board: "acme", cardId: "c1" }));
    expect(r?.isError).toBe(true);
    expect(actions.at(-1)).toMatchObject({ cls: "destructive", disposition: "never", outcome: "refused" });
  });

  // A classe `deploy` — quem decide se o agente publica sozinho ou defere é a MATRIZ + o guard (aqui),
  // NÃO a server action. Estes três testes ancoram o mecanismo inteiro do deploy autônomo.
  // (Historicamente este bloco exercitava `approve_styleguide`; aquele subsistema foi desmontado, e o
  //  teste passava VACUAMENTE — guardToolCall recebe o nome como string e não valida existência. Foi
  //  retargetado para a tool `deploy`, que é real: as invariantes cobertas são as mesmas, agora honestas.)
  it("AUTÔNOMO: scoped deploy com deploy:auto → executa sozinho (a decisão do tier vive na matriz)", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { deploy: "auto" } }) });
    const r = await scoped(() => guardToolCall("deploy", "deploy", { board: "acme", cardId: "story-c1" }));
    expect(r).toBeNull(); // ALLOW → o handler roda
    expect(actions.at(-1)).toMatchObject({ tool: "deploy", cls: "deploy", disposition: "auto", outcome: "executed" });
  });

  it("COPILOTO: scoped deploy com deploy:ask → ApprovalRequest (defere ao humano — não executa)", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { deploy: "ask" } }) });
    const r = await scoped(() => guardToolCall("deploy", "deploy", { board: "acme", cardId: "story-c1" }));
    expect(r).not.toBeNull(); // NÃO executa — vira pedido de aprovação
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ tool: "deploy", riskClass: "deploy" }));
    expect(actions.at(-1)).toMatchObject({ disposition: "ask", outcome: "pending" });
  });

  it("um GRANT humano do deploy é consumido e o handler roda — a ponta que a action NÃO pode deadlockar", async () => {
    // Copiloto (deploy:ask) vira ApprovalRequest; o humano aprova → grant; o tick re-chama e o guard consome o
    // grant, LIBERANDO o handler AINDA sob o ator escopado. Se a action re-checasse o tier aqui, ela recusaria
    // a chamada que o humano acabou de aprovar. Este teste ancora o motivo de o check de tier NÃO viver na action.
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { deploy: "ask" } }) });
    findMatchingGrant.mockResolvedValue({ id: "apr-approved" });
    consumeGrant.mockResolvedValue(true);
    const r = await scoped(() => guardToolCall("deploy", "deploy", { board: "acme", cardId: "story-c1" }));
    expect(r).toBeNull(); // ALLOW — o grant destravou; o handler roda sob o ator escopado
    expect(actions.at(-1)).toMatchObject({ tool: "deploy", outcome: "grant-consumed" });
  });

  // WS-12.1 (D16) — o `cardId` no ledger é o que torna a atribuição do backoff por-item DETERMINÍSTICA: sem
  // ele, a única pista de "quem o run tentou" seria a presença do item no board (um caso real) ou o auto-relato
  // do LLM (que pode mentir/omitir). Vale em TODO desfecho — inclusive nos que o guard barrou.
  it("TODO desfecho grava o cardId dos args canônicos (auto/ask/never) — a prova de QUEM foi tentado", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) });
    await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "story-ex0152" }));
    expect(actions.at(-1)).toMatchObject({ board: "acme", cardId: "story-ex0152", outcome: "executed" });

    readBoardConfig.mockResolvedValue({ orchestrator: policy() }); // sem matriz ⇒ ask
    await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "story-ex9203" }));
    expect(actions.at(-1)).toMatchObject({ cardId: "story-ex9203", outcome: "pending" });

    await scoped(() => guardToolCall("delete_card", "destructive", { board: "acme", cardId: "story-ex0073" }));
    expect(actions.at(-1)).toMatchObject({ cardId: "story-ex0073", outcome: "refused" });
  });

  it("uma tool SEM card (resolve_merge → runId) grava cardId undefined — não atribuível, e tudo bem", async () => {
    await scoped(() => guardToolCall("resolve_merge", "merge-resolve", { runId: "run-1", action: "retry" }));
    expect(actions.at(-1)).toMatchObject({ tool: "resolve_merge" });
    expect((actions.at(-1) as { cardId?: string }).cardId).toBeUndefined();
  });

  it("a matching GRANT is consumed → the call passes (grant-consumed audit)", async () => {
    findMatchingGrant.mockResolvedValue({ id: "apr-9" });
    consumeGrant.mockResolvedValue(true);
    const r = await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" }));
    expect(r).toBeNull();
    expect(actions.at(-1)).toMatchObject({ outcome: "grant-consumed", approvalId: "apr-9" });
  });

  // B4 / F7: o limite de ações por hora virava um pedido de APROVAÇÃO — o dono via
  // «Jido pede: move_card (write-board)» várias vezes seguidas e rejeitava à mão coisas que a matriz dele já autorizava.
  // Limite de ritmo é FREIO, não decisão: o agente recebe «tente de novo às HH:MM» e ninguém é incomodado.
  it("B4 — acima do limite por hora: THROTTLE com retry-after, e NENHUM pedido de aprovação", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" }, maxActionsPerHour: 1 }) });
    const now = Date.now();
    const key = new Date(now).toISOString().slice(0, 13);
    readOrchestratorState.mockResolvedValue({ ...emptyOrchestratorState(now), actions: { hourKey: key, count: 1 } });
    const r = await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" }));
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(r).not.toBeNull();
    expect(r?.isError).toBeFalsy();
    const body = JSON.parse(String((r?.content as { text: string }[])[0].text));
    expect(body).toMatchObject({ ok: false, throttled: true, tool: "move_card" });
    expect(Date.parse(body.retryAfter)).toBeGreaterThan(now);
    expect(body.pendingApproval).toBeUndefined();
    expect(actions.at(-1)).toMatchObject({ outcome: "throttled", disposition: "auto" });
  });

  // O FREIO nunca é freado (runner/board-pace.ts): a hora em que o limite do board estourou, ou em que a matriz pede
  // aprovação para escrever, é exatamente a hora em que um agente precisa conseguir PARAR o board.
  it("pause_board passa com o limite por hora estourado E com a matriz em `ask` — auditado, sem contar no limite", async () => {
    const now = Date.now();
    const key = new Date(now).toISOString().slice(0, 13);
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "ask" }, maxActionsPerHour: 1 }) });
    readOrchestratorState.mockResolvedValue({ ...emptyOrchestratorState(now), actions: { hourKey: key, count: 1 } });
    const r = await scoped(() => guardToolCall("pause_board", "write-board", { board: "acme", level: "paused", reason: "cota" }));
    expect(r).toBeNull();
    expect(createApprovalRequest).not.toHaveBeenCalled();
    expect(actions.at(-1)).toMatchObject({ tool: "pause_board", board: "acme", outcome: "executed", disposition: "auto" });
    expect(BRAKE_TOOLS.has("pause_board")).toBe(true);
    // retomar NÃO é freio: segue a matriz do board
    expect(BRAKE_TOOLS.has("resume_board")).toBe(false);
  });

  // QUEM executou. Toda a frota entra pelo mesmo token; o diário dizia «Executei…» na voz do copiloto por
  // qualquer agente. Agora o agente se nomeia (mcp/caller.ts) e só o copiloto fala em primeira pessoa.
  describe("quem chamou — a trilha e a voz do diário", () => {
    const as = <T>(caller: { kind: "session" | "copilot-tick" | "copilot-chat" | "external"; id: string } | undefined, fn: () => Promise<T>) =>
      runWithMcpActor({ level: "write", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", ...(caller ? { caller } : {}) }, fn);
    const move = () => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" });
    beforeEach(() => readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) }));

    it("o COPILOTO fala em primeira pessoa, e a linha da trilha o nomeia", async () => {
      await as({ kind: "copilot-tick", id: "acme" }, move);
      expect(diary.at(-1)).toMatchObject({ kind: "acted", text: "Executei `move_card` sozinho (write-board)." });
      expect(actions.at(-1)).toMatchObject({ caller: "copilot:acme", outcome: "executed" });
    });

    it("a SESSÃO de condutor é dita pelo card que ela conduz (lido do registro), nunca como o copiloto", async () => {
      sessionLoad.mockResolvedValue([{ sessionId: "sess-1", driver: "conductor", cardId: "story-x", tmuxSession: "agent-conductor-story-x" }]);
      await as({ kind: "session", id: "sess-1" }, move);
      expect(diary.at(-1)?.text).toBe("O condutor do card story-x executou `move_card` (write-board).");
      expect(actions.at(-1)).toMatchObject({ caller: "conductor:story-x" });
    });

    it("sessão de trabalho (sem condutor), sessão que saiu do registro e agente de fora: cada um pelo que é", async () => {
      sessionLoad.mockResolvedValue([{ sessionId: "sess-2", tmuxSession: "agent-fix-login" }]);
      await as({ kind: "session", id: "sess-2" }, move);
      expect(diary.at(-1)?.text).toBe("Uma sessão de agente (agent-fix-login) executou `move_card` (write-board).");
      await as({ kind: "session", id: "sess-gone" }, move);
      expect(actions.at(-1)).toMatchObject({ caller: "session:sess-gone" });
      await as({ kind: "external", id: "orquestrador" }, move);
      expect(diary.at(-1)?.text).toBe("Um agente de fora (orquestrador) executou `move_card` (write-board).");
      expect(actions.at(-1)).toMatchObject({ caller: "external:orquestrador" });
    });

    it("quem NÃO se nomeia é «um agente» — nunca o copiloto por omissão — e a trilha fica sem `caller`", async () => {
      await as(undefined, move);
      expect(diary.at(-1)?.text).toBe("Um agente executou `move_card` (write-board).");
      expect((actions.at(-1) as { caller?: string }).caller).toBeUndefined();
    });

    it("o pedido de aprovação e a recusa dizem quem pediu", async () => {
      sessionLoad.mockResolvedValue([{ sessionId: "sess-1", driver: "conductor", cardId: "story-x" }]);
      readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "ask" } }) });
      await as({ kind: "session", id: "sess-1" }, move);
      expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: "conductor:story-x" }));
      expect(diary.at(-1)).toMatchObject({ kind: "asked", text: "O condutor do card story-x pediu `move_card` (write-board): parei e pedi sua aprovação." });
      await as({ kind: "session", id: "sess-1" }, () => guardToolCall("delete_card", "destructive", { board: "acme", cardId: "c1" }));
      expect(diary.at(-1)).toMatchObject({ kind: "refused", text: "Recusei `delete_card` (destructive) ao condutor do card story-x: ação irreversível é sempre sua." });
    });

    it("o registro de sessões fora do ar não derruba a guarda: a sessão é dita pelo id", async () => {
      sessionLoad.mockRejectedValue(new Error("registro ilegível"));
      expect(await as({ kind: "session", id: "sess-1" }, move)).toBeNull();
      expect(actions.at(-1)).toMatchObject({ caller: "session:sess-1", outcome: "executed" });
    });
  });

  it("B4 — o pedido de aprovação (matriz `ask`) registra o MOTIVO e QUEM pede de verdade (não «run:orch»)", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "ask" } }) });
    await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" }));
    expect(createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "risk-matrix", requestedBy: "mcp:write(AGILEHARNESS_MCP_TOKEN_ORCH)" }),
    );
  });
});

// MUDAR UM CARD DE BOARD cruza boards: a matriz MAIS ESTRITA das duas governa — um board de destino que pede aprovação
// para escrever não é atravessado por um board de origem que deixa.
describe("guardToolCall — transfer_card responde à matriz mais estrita (origem × destino)", () => {
  it("stricterDisposition: never > ask > auto", () => {
    expect(stricterDisposition("auto", "ask")).toBe("ask");
    expect(stricterDisposition("never", "auto")).toBe("never");
    expect(stricterDisposition("ask", "ask")).toBe("ask");
  });

  it("origem libera escrita, destino pede aprovação ⇒ pede aprovação (não executa)", async () => {
    readBoardConfig.mockImplementation(async (b: string) =>
      b === "estufa" ? { orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) } : { orchestrator: policy({ riskMatrix: { "write-board": "ask" } }) },
    );
    const r = await scoped(() => guardToolCall("transfer_card", "write-board", { board: "estufa", cardId: "story-x", toBoard: "galpao" }));
    expect(r).not.toBeNull();
    expect(createApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({ board: "estufa", tool: "transfer_card" }));
    expect(readBoardConfig).toHaveBeenCalledWith("galpao");
  });

  it("os dois liberam ⇒ executa", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) });
    const r = await scoped(() => guardToolCall("transfer_card", "write-board", { board: "estufa", cardId: "story-x", toBoard: "galpao" }));
    expect(r).toBeNull();
  });

  it("uma tool que NÃO cruza boards ignora um `toBoard` no args", async () => {
    readBoardConfig.mockImplementation(async (b: string) =>
      b === "estufa" ? { orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) } : { orchestrator: policy({ riskMatrix: { "write-board": "never" } }) },
    );
    const r = await scoped(() => guardToolCall("update_card", "write-board", { board: "estufa", cardId: "story-x", toBoard: "galpao" }));
    expect(r).toBeNull();
  });
});
