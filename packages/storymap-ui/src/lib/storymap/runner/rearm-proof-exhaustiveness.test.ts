// The guard for the bug that motivated the whole `deploy-recovered` producer: `RearmProof.kind` declared
// THREE families of proof and shipped with producers for ONE. A kind with no producer is not a feature that
// is "not wired yet" — it is dead code with a reassuring name, and it hid a real consequence for months
// (every item that fell into the per-item anti-noop backoff waited for a human click while the type promised
// the machine could free it).
//
// Molde: gate-exhaustiveness.test.ts, which exists for the identical failure mode on GateId. The difference
// worth stating: that test proves each id has a PREDICATE. This one is stricter — a registry of paths would
// be just another declaration, so caso B opens the file and demands the literal actually be EMITTED there.
// (Same second-assertion discipline as agnostic-lint's "the whitelist does not list a file that no longer
// has a hit": a registry nobody re-checks against reality rots into fiction.)

import { describe, expect, it } from "vitest";
import { REARM_PROOF_KINDS, type RearmProof, type RearmProofKind } from "./noop-rearm";
import { planDeployRecoveredRearm, planOrphanClaim } from "../copilot/steward";
import { tierMatrix, tierMode } from "../copilot/tier";
import type { CardClaim } from "./claims";
import type { OrchestratorPolicy } from "@/lib/storymap/types";

/** O tier que autoriza agir sozinho — montado das MESMAS peças que o resto da suíte usa. */
const AUTONOMO: OrchestratorPolicy = { mode: tierMode("autonomo"), riskMatrix: tierMatrix("autonomo") };

/** Um claim de sessão MORTA (a única forma que 8.2 aceita como trabalho do steward). */
const deadClaim: CardClaim = {
  board: "acme",
  cardId: "story-1",
  actor: "session:agent-7",
  kind: "implement",
  scope: "code",
  acquiredAt: new Date(0).toISOString(),
  expiresAt: new Date(0).toISOString(),
  heartbeatAt: new Date(0).toISOString(),
  released: "session-died",
  releasedAt: new Date(0).toISOString(),
};

/**
 * kind → uma TESTEMUNHA: entradas que fazem o produtor REAL devolver uma prova daquele kind.
 *
 * Por que testemunha e não grep do literal: a primeira versão deste teste lia o arquivo e exigia
 * /kind:\s*"<kind>"/. Uma MUTAÇÃO (trocar o kind emitido em steward.ts) manteve o teste VERDE — porque o
 * doc-comment do próprio produtor contém a frase `RearmProof.kind: "deploy-recovered"` e satisfazia a regex.
 * Ou seja: o guarda contra "declaração sem produtor" estava sendo satisfeito por uma DECLARAÇÃO (um
 * comentário), reproduzindo o bug que ele existe para impedir. Texto não prova produção — execução prova.
 *
 * Um kind novo sem testemunha falha o caso A; uma testemunha que não consegue fazer o produtor emitir aquele
 * kind falha o caso B — e nenhum dos dois é satisfazível escrevendo comentário.
 */
const WITNESSES: Record<RearmProofKind, () => RearmProof | null> = {
  // planDeployRecoveredRearm (8.4) — o fato de deploy do card do item transicionou false → true.
  "deploy-recovered": () => {
    const plan = planDeployRecoveredRearm({
      itemId: "story-x:approval:release",
      cardId: "story-x",
      observedDeployProven: false,
      stewardRearmed: false,
      measured: { deployProven: true, detail: "alvos e face carregam o releasedSha" },
    });
    return plan.action === "rearm" ? plan.proof : null;
  },
  // planOrphanClaim (8.2) — a convergência provou que o trabalho de uma sessão morta já aterrissou.
  "delta-landed": () => {
    const plan = planOrphanClaim({
      claim: deadClaim,
      landed: { verdict: "landed", detail: "pós-imagem idêntica em main" },
      policy: AUTONOMO,
    });
    return plan.action === "close-cycle" ? plan.proof : null;
  },
};

describe("RearmProof exhaustiveness — todo kind declarado TEM um produtor real", () => {
  it("caso A: o registro de testemunhas set-equals REARM_PROOF_KINDS (kind sem produtor ⇒ vermelho)", () => {
    expect(new Set(Object.keys(WITNESSES))).toEqual(new Set(REARM_PROOF_KINDS));
  });

  it("caso B: cada produtor, EXECUTADO, devolve de fato uma prova do seu kind", () => {
    const broken: string[] = [];
    for (const kind of REARM_PROOF_KINDS) {
      const proof = WITNESSES[kind]();
      if (!proof) broken.push(`${kind}: o produtor não chegou a emitir prova`);
      else if (proof.kind !== kind) broken.push(`${kind}: o produtor emitiu \`${proof.kind}\``);
      else if (!proof.detail.trim()) broken.push(`${kind}: prova sem detail (detail vazio não é evidência)`);
    }
    expect(broken, "Kind sem produtor REAL — ou escreva o produtor, ou remova o kind do union.").toEqual([]);
  });

  it("`conflict-resolved` NÃO voltou ao union: zero produtores ⇒ o tipo se deleta, não se inventa produtor fraco", () => {
    expect(REARM_PROOF_KINDS).not.toContain("conflict-resolved");
  });
});
