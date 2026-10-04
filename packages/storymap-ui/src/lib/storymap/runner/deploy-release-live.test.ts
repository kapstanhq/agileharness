import { describe, expect, it, vi } from "vitest";
import { releaseAlreadyLiveVerdict, settleReleasedLiveCards, type ReleaseLiveSweepDeps } from "./deploy-reconcile";
import type { BoardConfig, Card } from "@/lib/storymap/types";

// A QUARTA METADE da reconciliação (story-ex9601): o card que ESPERA em «Liberar» com o código já no ar atravessa o passo
// de publicar por evidência — sem deploy — e o settle o leva ao terminal. Um deploy que termina sem nada a publicar não
// gera evento por card: sem a varredura, nada acordaria quem espera em «Liberar». Fixtures inventadas.

function cfg(over: Partial<BoardConfig> = {}): BoardConfig {
  return {
    id: "estufa",
    name: "Estufa",
    statuses: [
      { id: "aprovar", name: "Aprovar entrega", deliveryApproval: true },
      { id: "release", name: "Liberar" },
      { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", gate: "hasDeployProof", terminal: true },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
    ...over,
  } as unknown as BoardConfig;
}

function card(over: Partial<Card> = {}): Card {
  return {
    id: "story-ex7701",
    type: "story",
    title: "Regar por setor",
    status: "release",
    stagedAt: "2026-05-02",
    releasedSha: "beef001",
    deployTargets: ["estufa-api"],
    findings: [],
    order: 3,
    created: null,
    updated: null,
    body: "",
    ...over,
  } as unknown as Card;
}

const PROVEN = { proven: true as const, sha: "beef001", targets: ["estufa-api"] };

describe("releaseAlreadyLiveVerdict — quem espera antes de publicar com o código no ar", () => {
  it("código PROVADO no ar ⇒ atravessa para o passo de publicar", () => {
    expect(releaseAlreadyLiveVerdict(card(), cfg(), PROVEN, null)).toEqual({ forward: "deploy" });
  });

  it("código NÃO provado (deploy anterior ao código, sem medição) ⇒ fica (fail-closed)", () => {
    expect(releaseAlreadyLiveVerdict(card(), cfg(), { proven: false, reason: "deploy-anterior-ao-codigo" }, null)).toEqual({
      skip: expect.stringContaining("deploy-anterior-ao-codigo"),
    });
    expect(releaseAlreadyLiveVerdict(card(), cfg(), null, null)).toEqual({ skip: expect.stringContaining("não provado") });
  });

  it("a decisão do DONO aberta segura, mesmo com o código no ar", () => {
    expect(releaseAlreadyLiveVerdict(card(), cfg(), PROVEN, "espera o dono antes de ir ao ar: o card toca «Dinheiro»")).toEqual({
      skip: expect.stringContaining("espera o dono"),
    });
  });

  it("card SEM código: só no board que libera sozinho", () => {
    const semCodigo = card({ stagedAt: undefined, releasedSha: undefined, deployTargets: undefined });
    expect(releaseAlreadyLiveVerdict(semCodigo, cfg(), null, null)).toEqual({ skip: expect.stringContaining("libera à mão") });
    expect(releaseAlreadyLiveVerdict(semCodigo, cfg({ release: { mode: "auto" } } as Partial<BoardConfig>), null, null)).toEqual({ forward: "deploy" });
  });

  it("fora do lugar: já no passo de publicar, terminal, não-story, ou o próximo passo não publica", () => {
    expect("skip" in releaseAlreadyLiveVerdict(card({ status: "deploy" }), cfg(), PROVEN, null)).toBe(true);
    expect("skip" in releaseAlreadyLiveVerdict(card({ status: "concluida" }), cfg(), PROVEN, null)).toBe(true);
    expect("skip" in releaseAlreadyLiveVerdict(card({ status: "aprovar" }), cfg(), PROVEN, null)).toBe(true);
    expect("skip" in releaseAlreadyLiveVerdict(card({ type: "step" } as Partial<Card>), cfg(), PROVEN, null)).toBe(true);
  });

  it("o settle não levaria ao terminal (um gate reprova) ⇒ nem sai de «Liberar»", () => {
    const gated = cfg({
      statuses: [
        { id: "release", name: "Liberar" },
        { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
        { id: "concluida", name: "No ar", gate: "hasTechPlan", terminal: true },
      ],
    } as Partial<BoardConfig>);
    expect(releaseAlreadyLiveVerdict(card(), gated, PROVEN, null)).toEqual({ skip: expect.any(String) });
  });
});

function deps(over: Partial<ReleaseLiveSweepDeps> = {}) {
  const writes: Array<{ id: string; status: string | null | undefined }> = [];
  const d: ReleaseLiveSweepDeps = {
    deployedShaFor: async () => "beef009",
    unitShasFor: async () => null,
    contains: async (a, b) => a === "beef001" && b === "beef009",
    ownerApproved: async () => false,
    write: vi.fn(async (_b: string, id: string, fn: (c: Card) => Card | null) => {
      const next = fn(card({ id }));
      if (next) writes.push({ id, status: next.status });
      return next;
    }) as unknown as ReleaseLiveSweepDeps["write"],
    transition: vi.fn(async () => {}) as unknown as ReleaseLiveSweepDeps["transition"],
    settle: vi.fn(async () => ({ next: null, advancedTo: "concluida", stampedProof: true, heldReason: null, proven: true })),
    ...over,
  };
  return { d, writes };
}

describe("settleReleasedLiveCards — a varredura", () => {
  it("move para o passo de publicar SEM disparar deploy, registra a transição e chama o settle por evidência", async () => {
    const { d, writes } = deps();
    const moved = await settleReleasedLiveCards("estufa", cfg(), [card()], d);
    expect(moved).toEqual(["story-ex7701"]);
    expect(writes).toEqual([{ id: "story-ex7701", status: "deploy" }]);
    expect(d.transition).toHaveBeenCalledWith(expect.objectContaining({ from: "release", to: "deploy", actor: "system", note: "deploy:already-live" }));
    expect(d.settle).toHaveBeenCalledWith("estufa", "story-ex7701");
  });

  it("código não contido no último deploy ⇒ ninguém é movido", async () => {
    const { d, writes } = deps({ contains: async () => false });
    expect(await settleReleasedLiveCards("estufa", cfg(), [card()], d)).toEqual([]);
    expect(writes).toEqual([]);
    expect(d.settle).not.toHaveBeenCalled();
  });

  it("card que toca uma classe do dono, em só-negócio: fica sem a aprovação dele; anda com ela", async () => {
    const ultra = cfg({ autonomy: { mode: "ultra" } } as Partial<BoardConfig>);
    const doDono = card({ businessClasses: { ids: ["money"] } } as Partial<Card>);
    const sem = deps({ ownerApproved: async () => false });
    expect(await settleReleasedLiveCards("estufa", ultra, [doDono], sem.d)).toEqual([]);
    const com = deps({ ownerApproved: async () => true });
    expect(await settleReleasedLiveCards("estufa", ultra, [doDono], com.d)).toEqual(["story-ex7701"]);
  });

  it("o card mudou sob o lock ⇒ não grava, não chama o settle", async () => {
    const { d } = deps({
      write: vi.fn(async (_b: string, id: string, fn: (c: Card) => Card | null) => fn(card({ id, status: "aprovar" }))) as unknown as ReleaseLiveSweepDeps["write"],
    });
    expect(await settleReleasedLiveCards("estufa", cfg(), [card()], d)).toEqual([]);
    expect(d.settle).not.toHaveBeenCalled();
  });

  it("uma falha num card não derruba a varredura dos outros", async () => {
    let n = 0;
    const { d } = deps({
      deployedShaFor: async () => {
        if (n++ === 0) throw new Error("git ilegível");
        return "beef009";
      },
    });
    const outro = card({ id: "story-ex7702" });
    expect(await settleReleasedLiveCards("estufa", cfg(), [card(), outro], d)).toEqual(["story-ex7702"]);
  });
});

// ── o deploy LIMPO fecha as causas do plano (deploy-blocks.ts) ─────────────────────────────────────────────────
import { causesClosedByCleanDeploy, closeCausesAfterCleanDeploy, type CleanDeployCloseDeps, type DeployBlockRow } from "./deploy-blocks";
import { DEPLOY_FAILURE_FINDING_ID } from "@/lib/storymap/demands";

function row(over: Partial<DeployBlockRow> = {}): DeployBlockRow {
  return {
    board: "estufa",
    causeKey: "estufa:owner:money",
    pkg: "estufa-api",
    phase: "needs-human",
    decider: "owner",
    ownerClass: "money",
    units: ["api"],
    rules: ["faturas"],
    command: "relay push estufa-api",
    firstAt: "2026-05-01T10:00:00.000Z",
    lastAt: "2026-05-01T10:00:00.000Z",
    cardIds: ["story-ex7701"],
    planHead: null,
    attributedCard: null,
    ...over,
  } as DeployBlockRow;
}

function blockedCard(causeKey: string): Card {
  return card({
    findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "parado", deployCause: { causeKey } } as unknown as Card["findings"][number]],
  });
}

describe("closeCausesAfterCleanDeploy — saída 0 do deploy do pacote fecha as causas do plano dele", () => {
  it("só as causas do PLANO (needs-human/needs-units) do MESMO pacote", () => {
    const rows = [row(), row({ causeKey: "estufa:system", phase: "needs-units", decider: "system" }), row({ causeKey: "estufa:proof", phase: "needs-proof" }), row({ causeKey: "outro:owner:money", pkg: "outro-api" })];
    expect(causesClosedByCleanDeploy(rows, "estufa-api").map((r) => r.causeKey)).toEqual(["estufa:owner:money", "estufa:system"]);
  });

  it("solta o disjuntor, fecha o finding do card com o porquê e tira a linha do livro", async () => {
    let rows = [row(), row({ causeKey: "outro:owner:money", pkg: "outro-api", cardIds: ["story-ex7709"] })];
    const written: Card[] = [];
    const d: CleanDeployCloseDeps = {
      readRows: async () => rows,
      write: async (_b, _c, fn) => {
        const next = fn(blockedCard("estufa:owner:money"));
        if (next) written.push(next);
      },
      breaker: { releaseCause: vi.fn(async () => ["story-ex7701"]) },
      mutateBlocks: async (fn) => (rows = fn(rows)),
      now: () => Date.parse("2026-05-03T12:00:00.000Z"),
    };
    expect(await closeCausesAfterCleanDeploy("estufa-api", d)).toEqual(["estufa:owner:money"]);
    expect(rows.map((r) => r.causeKey)).toEqual(["outro:owner:money"]);
    const f = written[0].findings.find((x) => x.id === DEPLOY_FAILURE_FINDING_ID)!;
    expect(f.status).toBe("fixed");
    expect(f.detail).toContain("terminou bem (saída 0)");
  });

  it("o disjuntor recusa soltar ⇒ nada fecha (como na re-medição)", async () => {
    let rows = [row()];
    const d: CleanDeployCloseDeps = {
      readRows: async () => rows,
      write: vi.fn(async () => {}),
      breaker: { releaseCause: async () => null },
      mutateBlocks: async (fn) => (rows = fn(rows)),
      now: () => 0,
    };
    expect(await closeCausesAfterCleanDeploy("estufa-api", d)).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(d.write).not.toHaveBeenCalled();
  });
});
