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

// ADR-065: the two registries the guard derives a SCOPE from when the args carry no `board` — a sessionId
// (the fleet's worktree lifecycle) or a runId (the train's resolve_merge). Mocked at the same boundary as
// the rest: the derivation is the behavior under test, not the disk.
const sessionLoad = vi.fn();
vi.mock("@/lib/storymap/runner/session-worktree", () => ({
  makeSessionStore: () => ({ load: () => sessionLoad(), persist: async () => {} }),
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

import { guardToolCall } from "./guard";
import { runWithMcpActor } from "./actor";
import { emptyOrchestratorState } from "@/lib/storymap/runner/orchestrator-state";
import type { OrchestratorPolicy } from "@/lib/storymap/types";

const scoped = <T>(fn: () => Promise<T>) => runWithMcpActor({ level: "write", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" }, fn);
const policy = (over: Partial<OrchestratorPolicy> = {}): OrchestratorPolicy => ({ mode: "autonomous", ...over });

beforeEach(() => {
  actions.length = 0;
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

// ADR-065 — a call that carries no `board` is not necessarily unscopable: the identity it DOES carry
// (sessionId / runId) names one. Before this, those tools hit the `ask` path board-less and were refused
// with "refaça com o board" — an instruction with no parameter able to satisfy it, which left the fleet
// unable to integrate its own work and `resolve_merge` unable to unpark the train under a scoped token.
describe("guardToolCall — o ESCOPO derivado da sessão/run (ADR-065)", () => {
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
    // A sessão card-less é LEGÍTIMA (ADR-065 `kind: session`) — não existe board para escapar a aprovação.
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
  // ele, a única pista de "quem o run tentou" seria a presença do item no board (a colisão #7) ou o auto-relato
  // do LLM (que pode mentir/omitir). Vale em TODO desfecho — inclusive nos que o guard barrou.
  it("TODO desfecho grava o cardId dos args canônicos (auto/ask/never) — a prova de QUEM foi tentado", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" } }) });
    await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "story-xfleex" }));
    expect(actions.at(-1)).toMatchObject({ board: "acme", cardId: "story-xfleex", outcome: "executed" });

    readBoardConfig.mockResolvedValue({ orchestrator: policy() }); // sem matriz ⇒ ask
    await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "story-qb8z2c" }));
    expect(actions.at(-1)).toMatchObject({ cardId: "story-qb8z2c", outcome: "pending" });

    await scoped(() => guardToolCall("delete_card", "destructive", { board: "acme", cardId: "story-eqpdtz" }));
    expect(actions.at(-1)).toMatchObject({ cardId: "story-eqpdtz", outcome: "refused" });
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

  it("rate over cap degrades an `auto` write-board to ASK", async () => {
    readBoardConfig.mockResolvedValue({ orchestrator: policy({ riskMatrix: { "write-board": "auto" }, maxActionsPerHour: 1 }) });
    // pre-seed the hour bucket at the cap
    const now = Date.now();
    const key = new Date(now).toISOString().slice(0, 13);
    readOrchestratorState.mockResolvedValue({ ...emptyOrchestratorState(now), actions: { hourKey: key, count: 1 } });
    const r = await scoped(() => guardToolCall("move_card", "write-board", { board: "acme", cardId: "c1" }));
    expect(r).not.toBeNull(); // degraded to ask → pending
    expect(createApprovalRequest).toHaveBeenCalled();
  });
});
