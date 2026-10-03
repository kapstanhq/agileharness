// "Produção fora do ar" na política de push: um deploy que falhou e REVERTEU o card vira UM aviso `deploy-failed`
// no barramento — `deploy-rollback` (empurra) quando o deploy rodou e falhou, `deploy-blocked` (só o Inbox) quando a
// publicação foi recusada antes de rodar. O segundo callback do MESMO deploy (onDone + webhook) não avisa de novo.

import { rmSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { getPublishBreaker, resetPublishBreakerForTest } from "./publish-breaker";

const { publishAgentAlert, evaluateAutorunOnEntry, state } = vi.hoisted(() => ({
  publishAgentAlert: vi.fn(),
  evaluateAutorunOnEntry: vi.fn(async (_board: string, _cardId: string) => {}),
  state: { card: null as unknown as Card },
}));
vi.mock("@/lib/notifications/server/alert-bus", () => ({ publishAgentAlert }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry }));
vi.mock("./transitions", () => ({ appendTransition: async () => {} }));
vi.mock("@/lib/storymap/write", () => ({
  updateCardOnDisk: async (_b: string, _id: string, fn: (c: Card) => Card | null) => {
    const next = fn(state.card);
    if (next) state.card = next;
    return next;
  },
}));
const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "release", name: "Liberar", autorun: false },
    { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};
vi.mock("@/lib/storymap/repo", () => ({ readBoardConfig: async () => config }));

import { deployFailureAlert, deployFailurePushEvent, revertCardOnDeployFailure } from "./deploy-revert";
import { shouldPush } from "@/lib/notifications/push-policy";

const card = (): Card => ({ id: "c", type: "story", title: "Checkout novo", status: "deploy", findings: [] }) as unknown as Card;

beforeEach(() => {
  publishAgentAlert.mockClear();
  evaluateAutorunOnEntry.mockClear();
  state.card = card();
  // o disjuntor é um singleton que persiste em disco: cada teste começa do zero
  resetPublishBreakerForTest();
  rmSync(path.join(runnerStateDir(), "deploy-attempts.json"), { force: true });
});

describe("deployFailurePushEvent — o deploy que rodou × o que foi recusado antes", () => {
  it.each([
    [undefined, "deploy-rollback"],
    ["deploy", "deploy-rollback"],
    ["deploy-noop", "deploy-rollback"],
    ["face-stale", "deploy-rollback"],
    ["self-deploy", "deploy-rollback"],
    ["release", "deploy-blocked"],
    ["freshness", "deploy-blocked"],
    ["needs-human", "deploy-blocked"], // nada tocou a produção: é pedido ao dono, não produção fora do ar
    ["needs-units", "deploy-blocked"], // idem — e é trabalho do sistema
  ] as const)("fase %s ⇒ %s", (phase, event) => {
    expect(deployFailurePushEvent({ phase })).toBe(event);
  });
});

describe("revertCardOnDeployFailure avisa UMA vez por revert", () => {
  it("deploy falhou ⇒ card volta a Liberar + UM aviso deploy-rollback, que empurra por padrão", async () => {
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(state.card.status).toBe("release");
    expect(publishAgentAlert).toHaveBeenCalledTimes(1);
    const a = publishAgentAlert.mock.calls[0][0];
    expect(a).toMatchObject({ kind: "deploy-failed", event: "deploy-rollback", boardId: "b", url: "/board/b/inbox" });
    expect(a.body).toContain("Checkout novo");
    expect(shouldPush(a.event)).toBe(true);

    // o segundo callback do MESMO deploy (webhook atrasado): o card já está em Liberar ⇒ nenhum aviso novo
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(publishAgentAlert).toHaveBeenCalledTimes(1);
  });

  it("preflight de frescor recusou ⇒ o aviso é deploy-blocked (fica no Inbox, não empurra)", async () => {
    await revertCardOnDeployFailure("b", "c", { phase: "freshness", reason: "3 commits atrás" });
    expect(publishAgentAlert).toHaveBeenCalledTimes(1);
    expect(publishAgentAlert.mock.calls[0][0]).toMatchObject({ event: "deploy-blocked" });
    expect(shouldPush("deploy-blocked")).toBe(false);
  });

  it("card fora de um status revertível (só o carimbo limpo) ⇒ nenhum aviso — não houve revert", async () => {
    state.card = { ...card(), status: "desenvolver", deployFiredAt: "2026-09-25T00:00:00Z" } as Card;
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(publishAgentAlert).not.toHaveBeenCalled();
  });

  it("deployFailureAlert é puro e carrega o título do finding", () => {
    const a = deployFailureAlert("b", "c", null, { title: "Deploy de produção falhou" }, {}, 7);
    expect(a).toMatchObject({ at: 7, body: "b: Deploy de produção falhou", tag: "deploy-failed:b:c" });
  });
});

describe("deployFailureAlert — needs-human não se anuncia como falha", () => {
  it("o aviso diz que o deploy precisa do dono, não que falhou", () => {
    const alert = deployFailureAlert(
      "b",
      "c",
      "Checkout novo",
      { title: "Precisa de você: há unidade que só você publica" },
      { phase: "needs-human", exitCode: 3 },
      1,
    );
    expect(alert.event).toBe("deploy-blocked");
    expect(alert.title).toBe("Precisa de você para publicar");
    expect(alert.title).not.toMatch(/falhou|recusada/);
  });
});

// O revert devolve o card a `release`, que AUTOAVANÇA: sem registrar a falha a cascata o reencaminharia na
// hora — um laço de milhares de ciclos. O registro tem de estar LÁ quando a reavaliação provocada pelo revert roda.
describe("revertCardOnDeployFailure — registra a falha no disjuntor da publicação", () => {
  it("registra fase e exit ANTES de reavaliar a cascata (a reavaliação já lê o recuo)", async () => {
    let holdAtReeval: string | null | undefined;
    evaluateAutorunOnEntry.mockImplementationOnce(async () => {
      holdAtReeval = await getPublishBreaker().holdReason("b", "c");
    });
    await revertCardOnDeployFailure("b", "c", { exitCode: 3, phase: "needs-human", units: ["batch-importer"] });
    expect(evaluateAutorunOnEntry).toHaveBeenCalledTimes(1);
    expect(holdAtReeval).toContain("nova tentativa automática");
    expect(await getPublishBreaker().snapshot()).toEqual([
      expect.objectContaining({ board: "b", cardId: "c", phase: "needs-human", exitCode: 3, consecutive: 1, exhausted: false }),
    ]);
  });

  it("o 2º callback do MESMO deploy (webhook atrasado, card já em Liberar) NÃO conta outra falha", async () => {
    await revertCardOnDeployFailure("b", "c", { exitCode: 3, phase: "needs-human" });
    await revertCardOnDeployFailure("b", "c", { exitCode: 3, phase: "needs-human" });
    expect((await getPublishBreaker().snapshot())[0]).toMatchObject({ consecutive: 1 });
  });

  it("falhas de tentativas DIFERENTES acumulam (o card volta a Publicar e falha de novo)", async () => {
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    state.card = { ...state.card, status: "deploy" } as Card; // uma nova tentativa o levou de volta ao passo de publicar
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect((await getPublishBreaker().snapshot())[0]).toMatchObject({ consecutive: 2, phase: "deploy" });
  });

  it("o FREIO nunca impede o revert: sem diretório de estado o card volta a Liberar do mesmo jeito (só não há registro)", async () => {
    resetPublishBreakerForTest(); // sob o vitest, sem o override `runnerStateDir()` lança ⇒ `getPublishBreaker()` lança
    vi.stubEnv("AGILEHARNESS_RUNNER_STATE_DIR", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await revertCardOnDeployFailure("b", "c", { exitCode: 3, phase: "needs-human" });
    } finally {
      vi.unstubAllEnvs();
      err.mockRestore();
    }
    expect(state.card.status).toBe("release"); // o revert aconteceu
    expect(publishAgentAlert).toHaveBeenCalledTimes(1); // e o aviso também
    expect(evaluateAutorunOnEntry).toHaveBeenCalledTimes(1);
  });

  // O deploy do pacote parado pela MESMA causa para vários cards: uma linha no livro e uma no disjuntor,
  // nem uma por card. E o finding de cada card carrega a causa (quem decide), com a fase pela régua.
  // Reescrito de propósito: o board deste arquivo não tem bloco `autonomy` (modo HUMANO), e o teste
  // travava «lacuna de classe ⇒ do sistema» ali — onde nenhum sistema age sozinho. Agora ele roda num board só-negócio
  // com o mapa de regras, e o modo humano tem a sua asserção: a mesma saída 3 é do dono.
  it("4 reverts da MESMA causa ⇒ 1 linha no livro (deploy-blocks.json) e 1 tentativa no disjuntor; finding com a causa", async () => {
    const { parseDeployExit3Report } = await import("./deploy-proof");
    const { readDeployBlocks, mutateDeployBlocks } = await import("./deploy-blocks");
    await mutateDeployBlocks(() => []); // espera as escritas dos testes anteriores (fire-and-forget) e começa do zero
    const plan = parseDeployExit3Report(
      JSON.stringify({ status: "needs-human", head: "h1", plan: { human: [{ unit: "ledger-sync", file: null, rule: "diff-unreadable", why: "o diff do schema não pôde ser lido" }] } }),
    );
    const failure = (i: number) => revertCardOnDeployFailure("b", `story-${i}`, { pkg: "b", exitCode: 3, phase: "needs-human", units: ["ledger-sync"], plan });
    config.autonomy = { mode: "ultra", deployRuleClasses: { "bills-customer": "money" } } as BoardConfig["autonomy"];
    try {
      for (let i = 1; i <= 4; i++) {
        state.card = { ...card(), id: `story-${i}` } as Card;
        await failure(i);
        expect(state.card.findings[0]).toMatchObject({ deployPhase: "needs-units", deployCause: { causeKey: "b:system", decider: "system" } });
        expect(state.card.findings[0].title).not.toMatch(/Precisa de você|só você/);
      }
    } finally {
      delete config.autonomy;
    }
    await mutateDeployBlocks((r) => r); // espera a cadeia do livro
    const rows = (await readDeployBlocks()).filter((r) => r.board === "b");
    expect(rows).toEqual([expect.objectContaining({ causeKey: "b:system", decider: "system", cardIds: ["story-1", "story-2", "story-3", "story-4"] })]);
    // (o registro é um singleton em disco: filtra o que é deste teste — uma persistência atrasada de outro pode estar lá)
    const due = (await getPublishBreaker().due(Number.MAX_SAFE_INTEGER)).filter((a) => a.cardId.startsWith("story-"));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ causeKey: "b:system", consecutive: 1, cardIds: ["story-1", "story-2", "story-3", "story-4"] });
    // um aviso por CAUSA no celular/Inbox: a etiqueta colapsa os quatro
    expect(new Set(publishAgentAlert.mock.calls.map((c) => c[0].tag))).toEqual(new Set(["deploy-failed:b:b:system"]));
    // o MESMO plano num board em modo humano: não há sistema que aja sozinho — a decisão é do dono, como antes das causas
    state.card = { ...card(), id: "story-5" } as Card;
    await failure(5);
    expect(state.card.findings[0]).toMatchObject({ deployPhase: "needs-human", deployCause: { causeKey: "b:owner:?", decider: "owner" } });
  });

  it("sem revert (card já fora de um status revertível) não registra nada", async () => {
    state.card = { ...card(), status: "desenvolver", deployFiredAt: "2026-09-25T00:00:00Z" } as Card;
    await revertCardOnDeployFailure("b", "c", { exitCode: 1 });
    expect(await getPublishBreaker().snapshot()).toEqual([]);
  });
});
