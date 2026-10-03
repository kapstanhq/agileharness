// A CARONA no deploy em curso: dois «Publicar» do mesmo board em segundos, um deploy
// só, e o segundo card preso em Publicar para sempre. Com a carona, o card que chegou com o deploy em curso
// recebe o desfecho dele como um evento próprio — e ESTE módulo é quem o assenta: a falha o devolve como a do
// dono do job; o sucesso o mede; e o sucesso que não carregou o código dele (a promoção dele veio depois do
// início do deploy) lhe dá um deploy PRÓPRIO — uma vez só.

import { describe, expect, it, vi } from "vitest";
import { needsOwnRun, settleAttachedDeploy, type AttachedSettleDeps } from "./deploy-attached";
import type { DeployDoneEvent } from "./product-deploy";
import type { DeploySettleSuccessDecision } from "./deploy-reconcile";

const ev = (o: Partial<DeployDoneEvent>): DeployDoneEvent => ({
  pkg: "acme",
  ok: true,
  exitCode: 0,
  board: "acme",
  cardId: "s2",
  durationMs: 60_000,
  attached: true,
  declaredKind: "command",
  ...o,
});

const decision = (o: Partial<DeploySettleSuccessDecision>): DeploySettleSuccessDecision => ({
  next: null,
  advancedTo: null,
  stampedProof: false,
  heldReason: null,
  proven: false,
  ...o,
});

function deps(settled: DeploySettleSuccessDecision | null = decision({ advancedTo: "concluida", proven: true })) {
  const d = {
    revert: vi.fn(async () => {}),
    settle: vi.fn(async (_board: string, _cardId: string, _opts: Parameters<AttachedSettleDeps["settle"]>[2]) => settled),
    readNeedsHumanReport: vi.fn(async () => ({ units: ["api"], message: "publique a api: ./deploy-api" })),
    redispatch: vi.fn(async () => {}),
  } satisfies AttachedSettleDeps;
  return d;
}

describe("needsOwnRun — só o «deploy não carregou o código dele» pede um deploy próprio", () => {
  it("segurado SEM prova ⇒ sim; provado, avançado, gate segurando ou card fora do passo ⇒ não", () => {
    expect(needsOwnRun(decision({ heldReason: "prova de publicação não medida (deploy-anterior-ao-codigo)" }))).toBe(true);
    expect(needsOwnRun(decision({ advancedTo: "concluida", proven: true }))).toBe(false);
    expect(needsOwnRun(decision({ heldReason: "gate hasQaPassed reprovou", proven: true }))).toBe(false);
    expect(needsOwnRun(decision({ heldReason: null }))).toBe(false); // card já saiu de Publicar
    expect(needsOwnRun(null)).toBe(false); // card sumiu
  });
});

describe("settleAttachedDeploy — o desfecho do deploy em curso assenta o card de carona", () => {
  it("sucesso que prova ⇒ settle pelo caminho de sempre, sem deploy extra", async () => {
    const d = deps();
    await settleAttachedDeploy(ev({}), d);
    expect(d.settle).toHaveBeenCalledWith("acme", "s2", expect.objectContaining({ source: "registry-ondone" }));
    expect(d.redispatch).not.toHaveBeenCalled();
    expect(d.revert).not.toHaveBeenCalled();
  });

  it("sucesso que NÃO carregou o código dele ⇒ um deploy PRÓPRIO, marcado followUp (anti-laço)", async () => {
    const d = deps(decision({ heldReason: "prova de publicação não medida (deploy-anterior-ao-codigo)" }));
    await settleAttachedDeploy(ev({}), d);
    expect(d.redispatch).toHaveBeenCalledWith("acme", "s2");
  });

  it("já era a carona de um deploy de follow-up e ainda não prova ⇒ PARA (fica em Publicar com o watchdog)", async () => {
    const d = deps(decision({ heldReason: "prova de publicação não medida (deploy-anterior-ao-codigo)" }));
    await settleAttachedDeploy(ev({ followUp: true }), d);
    expect(d.redispatch).not.toHaveBeenCalled();
  });

  it("falha do deploy em curso ⇒ o card volta como o dono do job voltou (mesma falha), sem settle nem deploy extra", async () => {
    const d = deps();
    await settleAttachedDeploy(ev({ ok: false, exitCode: 1 }), d);
    expect(d.revert).toHaveBeenCalledWith("acme", "s2", expect.objectContaining({ phase: "deploy", exitCode: 1, pkg: "acme" }));
    expect(d.settle).not.toHaveBeenCalled();
    expect(d.redispatch).not.toHaveBeenCalled();
  });

  it("saída 3 do comando declarado ⇒ o card de carona também recebe o pedido «precisa de você», com o recado", async () => {
    const d = deps();
    await settleAttachedDeploy(ev({ ok: false, exitCode: 3 }), d);
    expect(d.revert).toHaveBeenCalledWith(
      "acme",
      "s2",
      expect.objectContaining({ phase: "needs-human", units: ["api"], commandSays: "publique a api: ./deploy-api" }),
    );
  });

  it("agente com liveSha ⇒ o settle mede contra a ALEGAÇÃO dele (como faz para o dono do job)", async () => {
    const d = deps();
    await settleAttachedDeploy(ev({ declaredKind: "agent", liveSha: "beef1234" }), d);
    const opts = d.settle.mock.calls[0]?.[2];
    expect(await opts?.deps?.deployedShaFor("acme")).toBe("beef1234");
  });

  it("evento sem card ⇒ nada (defensivo: carona sempre tem card)", async () => {
    const d = deps();
    await settleAttachedDeploy(ev({ cardId: undefined }), d);
    expect(d.settle).not.toHaveBeenCalled();
    expect(d.revert).not.toHaveBeenCalled();
  });
});
