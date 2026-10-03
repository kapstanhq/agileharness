import { describe, expect, it, vi } from "vitest";
import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFn } from "./worktree";

// O Next instancia o MESMO módulo uma vez por camada do bundle. Em produção a ação do
// botão «Aprovar & avançar → Publicar» cunhava a autorização numa cópia deste arquivo e o registro de
// deploys a resgatava noutra: o log dizia «[deploy-freshness] OK» e, logo depois, «[harness-deploy]
// RECUSADO: deploy sem autorização do preflight de frescor» — nenhum publish pela interface funcionava.
// O registro das autorizações é um por PROCESSO, não um por instância do módulo.

const baseExec = promisify(nodeExec) as unknown as ExecFn;
const OFF = { AGILEHARNESS_DEPLOY_FRESHNESS: "off" };

async function duasCopias() {
  vi.resetModules();
  const a = await import("./deploy-freshness");
  vi.resetModules();
  const b = await import("./deploy-freshness");
  return { a, b };
}

describe("autorização de frescor entre CÓPIAS do módulo", () => {
  it("as duas importações são instâncias diferentes (o cenário do bundle do Next)", async () => {
    const { a, b } = await duasCopias();
    expect(a.redeemDeployClearance).not.toBe(b.redeemDeployClearance);
  });

  it("cunhada por uma cópia, é resgatada pela outra — e continua de uso único entre elas", async () => {
    const { a, b } = await duasCopias();
    const v = await a.checkDeployFreshness(
      { target: "app", repoRoot: "/r", scope: [], label: "t" },
      { exec: baseExec, env: OFF, log: () => {}, now: () => 1_000 },
    );
    if (!v.ok) throw new Error("o escape deveria cunhar");
    expect(b.redeemDeployClearance(v.clearance, "app", 1_000)).toBeNull();
    expect(a.redeemDeployClearance(v.clearance, "app", 1_000)).toMatch(/sem autorização do preflight/);
  });

  it("forjar continua impossível: um objeto de mesmo formato não passa em nenhuma cópia", async () => {
    const { a, b } = await duasCopias();
    const forjada = { target: "app", repoRoot: "/r", head: null, issuedAt: 1_000, bypassed: false, summary: "" };
    expect(a.redeemDeployClearance(forjada, "app", 1_000)).toMatch(/sem autorização do preflight/);
    expect(b.redeemDeployClearance(forjada, "app", 1_000)).toMatch(/sem autorização do preflight/);
  });
});
