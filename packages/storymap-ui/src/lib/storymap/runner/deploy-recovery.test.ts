import { describe, expect, it, vi } from "vitest";
import { measureDeployRecovery } from "./deploy-recovery";

const RELEASED = "47a8edd9c1111111111111111111111111111111";
const NEWER = "aaaa1111222233334444555566667777888899990";
const OLDER = "033ee72e6222222222222222222222222222222b";

/** `contains(ancestor, descendant)` for a world where only NEWER carries RELEASED. */
const realistic = async (ancestor: string, descendant: string) => ancestor === RELEASED && descendant === NEWER;
const never = async () => false;
const always = async () => true;

/** A canary that MUST NOT be called (the cost short-circuit / the "no declared canary" contract). */
const forbiddenProbe = vi.fn(async () => "fresh" as const);

describe("measureDeployRecovery — a medição do fato de mundo (a régua do settle, não uma nova)", () => {
  it("todos os alvos contêm o releasedSha E a face declarada contém ⇒ deployProven: true", async () => {
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web", "api"],
      deployedShaFor: async () => NEWER,
      faceDeclared: true,
      faceFidelity: async () => "fresh",
      contains: realistic,
    });
    expect(m).not.toBeNull();
    expect(m?.deployProven).toBe(true);
    expect(m?.detail.trim()).not.toBe(""); // um detail vazio é recusado por rearmAllowed — a prova precisa dizer algo
  });

  it("UM alvo não contém ⇒ false (a regressão do caso real: um alvo sobre-declarado em commit anterior)", async () => {
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web", "api"],
      // `web` está à frente; `api` rodou num commit que NÃO carrega o código do card.
      deployedShaFor: async (t) => (t === "web" ? NEWER : OLDER),
      faceDeclared: true,
      faceFidelity: forbiddenProbe,
      contains: realistic,
    });
    expect(m).toEqual({ deployProven: false, detail: expect.stringContaining("NÃO está provado") });
  });

  it("board SEM canário declarado ⇒ a fidelidade sai da conjunção e NADA é sondado", async () => {
    const probe = vi.fn(async () => null);
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web"],
      deployedShaFor: async () => NEWER,
      faceDeclared: false,
      faceFidelity: probe,
      contains: realistic,
    });
    expect(m?.deployProven).toBe(true);
    // Sondar um default de deployment mede OUTRO app — a causa raiz do incidente. Nada é sondado.
    expect(probe).not.toHaveBeenCalled();
  });

  it("canário declarado mas sem leitura concreta ⇒ null (leitura falha NUNCA vira `false`)", async () => {
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web"],
      deployedShaFor: async () => NEWER,
      faceDeclared: true,
      faceFidelity: async () => "unknown",
      contains: realistic,
    });
    expect(m).toBeNull();
  });

  it("superfície servindo bytes diferentes dos publicados ⇒ false (medição negativa de verdade)", async () => {
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web"],
      deployedShaFor: async () => NEWER,
      faceDeclared: true,
      faceFidelity: async () => "stale",
      contains: realistic,
    });
    expect(m).toEqual({ deployProven: false, detail: expect.stringContaining("bytes diferentes") });
  });

  // story-w3y6ml — a REGRESSÃO desta conjunção. A régua anterior aqui era
  // `contains(releasedSha, shaServidoNaFace)`, e um build diff-aware que PULA um app corretamente
  // faz esse app servir um artefato mais antigo que o release: a conjunção reprovava um deploy
  // perfeito e o steward DESISTIA do item (backoff). Fidelidade não tem esse modo de falha — a
  // superfície pulada serve exatamente o que foi publicado para ela.
  it("app pulado pelo build diff-aware (serve artefato anterior ao release) NÃO reprova a conjunção", async () => {
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web"],
      deployedShaFor: async () => NEWER,
      faceDeclared: true,
      faceFidelity: async () => "fresh",
      // a régua velha perguntaria isto e responderia `false` — e reverteria um card que está no ar
      contains: realistic,
    });
    expect(m?.deployProven).toBe(true);
  });

  it("sem releasedSha / sem deployTargets / alvo sem deploy ⇒ null — 'nada a checar' ≠ 'tudo passou'", async () => {
    const base = { deployedShaFor: async () => NEWER, faceDeclared: false, faceFidelity: forbiddenProbe, contains: always };
    expect(await measureDeployRecovery({ ...base, releasedSha: null, deployTargets: ["web"] })).toBeNull();
    expect(await measureDeployRecovery({ ...base, releasedSha: "   ", deployTargets: ["web"] })).toBeNull();
    expect(await measureDeployRecovery({ ...base, releasedSha: RELEASED, deployTargets: [] })).toBeNull();
    expect(await measureDeployRecovery({ ...base, releasedSha: RELEASED, deployTargets: undefined })).toBeNull();
    // alvo declarado cujo estado de deploy é ilegível/ausente: não medi (e não é uma prova de nada)
    expect(
      await measureDeployRecovery({ ...base, releasedSha: RELEASED, deployTargets: ["web"], deployedShaFor: async () => null }),
    ).toBeNull();
  });

  it("`contains` rejeita (git ilegível) ⇒ null, NUNCA true", async () => {
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web"],
      deployedShaFor: async () => NEWER,
      faceDeclared: false,
      faceFidelity: forbiddenProbe,
      contains: async () => {
        throw new Error("fatal: not a git repository");
      },
    });
    expect(m).toBeNull();
  });

  it("ancestralidade reprova ⇒ o canário NÃO é chamado (curto-circuito de custo: 0 chamadas de rede)", async () => {
    const probe = vi.fn(async () => "fresh" as const);
    const m = await measureDeployRecovery({
      releasedSha: RELEASED,
      deployTargets: ["web"],
      deployedShaFor: async () => OLDER,
      faceDeclared: true,
      faceFidelity: probe,
      contains: never,
    });
    expect(m?.deployProven).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
