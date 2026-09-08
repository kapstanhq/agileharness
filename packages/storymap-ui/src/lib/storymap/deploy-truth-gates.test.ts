import { describe, expect, it } from "vitest";
import { checkGate, declaresCode, GATES } from "./gates";
import { coerceCard } from "./repo";
import type { BoardConfig, Card, GateId } from "./types";

// deploy-truth WS-1/WS-2 — the two terminal gates ("No ar" needs PROOF; orbit's Concluída needs a
// RELEASE), both fail-closed with the SAME positive no-code rule (declaresCode). These tests pin the
// asymmetry the plan restores: who ACTS needs proof — a card that declares code (stagedAt OR commitRange)
// never terminates on silence; a card that positively declares NO code passes without inventing evidence.
// Lives next to gates-core.test.ts (same fixture style) as the deploy-truth-specific slice.

const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", gate: "hasDeployProof", terminal: true },
    { id: "so-released", name: "Concluída", gate: "hasReleased", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as unknown as BoardConfig;

const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

const PROOF = { sha: "abc1234", targets: ["acmeapp"], at: "2026-07-17T12:00:00Z", source: "registry-ondone" };

describe("declaresCode — a régua positiva de 'este card tem código' (D-DT4)", () => {
  it("stagedAt carimbado ⇒ declara código; commitRange completo ⇒ declara código; nenhum ⇒ não declara", () => {
    expect(declaresCode(card({ stagedAt: "2026-07-16" }))).toBe(true);
    expect(declaresCode(card({ commitRange: { base: "a1", head: "b2" } }))).toBe(true);
    expect(declaresCode(card({}))).toBe(false);
  });

  it("commitRange PELA METADE não declara código (mesma drop-rule do coerceCommitRange — paridade hook×app)", () => {
    expect(declaresCode({ commitRange: { base: "a1" } } as unknown as Card)).toBe(false);
    expect(declaresCode({ commitRange: { head: "b2" } } as unknown as Card)).toBe(false);
  });
});

describe("hasDeployProof — o terminal 'No ar' exige a prova CARIMBADA pelo settle (D-DT1/D-DT8)", () => {
  it("BLOQUEIA um card com código (stagedAt) sem deployProof — settle não confirmou, não termina", () => {
    const msg = checkGate(card({ stagedAt: "2026-07-16" }), "concluida", board);
    expect(msg).toMatch(/prova|deployProof|settle/i);
  });

  it("BLOQUEIA um card com commitRange (código revisado) sem deployProof — a régua positiva, não o silêncio", () => {
    expect(checkGate(card({ commitRange: { base: "a1", head: "b2" } }), "concluida", board)).not.toBeNull();
  });

  it("PASSA com deployProof carimbado (o settle mediu por ancestralidade e carimbou)", () => {
    expect(checkGate(card({ stagedAt: "2026-07-16", deployProof: PROOF }), "concluida", board)).toBeNull();
  });

  it("PASSA no-code (sem stagedAt E sem commitRange) — chore/spike não publica nada, nada a provar", () => {
    expect(checkGate(card({}), "concluida", board)).toBeNull();
  });

  it("carimbo MALFORMADO (sem sha) não é prova — bloqueia (fail-closed até no carimbo)", () => {
    // raw shape (bypassa o coerce de propósito): o predicado sozinho já recusa um stamp sem sha.
    const raw = { type: "story", stagedAt: "2026-07-16", deployProof: { targets: ["x"] } } as unknown as Card;
    expect(GATES.hasDeployProof.ok(raw)).toBe(false);
  });

  it("a mensagem NOMEIA o fix: aguardar o settle confirmar / nunca carimbar na mão", () => {
    expect(GATES.hasDeployProof.message).toMatch(/settle|confirm/i);
    expect(GATES.hasDeployProof.fix).toMatch(/settle/i);
    expect(GATES.hasDeployProof.fix).toMatch(/NUNCA escreva `deployProof` na mão/);
  });
});

describe("hasReleased — fail-closed (D-DT4): sem stagedAt NÃO é licença quando há commitRange", () => {
  it("BLOQUEIA código staged sem releasedAt (comportamento histórico preservado)", () => {
    expect(checkGate(card({ stagedAt: "2026-06-10" }), "so-released", board)).toMatch(/libera|release|main/i);
  });

  it("BLOQUEIA card com commitRange e SEM stagedAt — a classe que o fail-open deixava passar (eqpdtz/xfleex)", () => {
    expect(checkGate(card({ commitRange: { base: "a1", head: "b2" } }), "so-released", board)).not.toBeNull();
  });

  it("PASSA com releasedAt carimbado (o release promoveu)", () => {
    expect(checkGate(card({ stagedAt: "2026-06-10", releasedAt: "2026-06-11" }), "so-released", board)).toBeNull();
  });

  it("PASSA no-code (sem stagedAt e sem commitRange) — a afirmação positiva, não o escape vazio", () => {
    expect(checkGate(card({}), "so-released", board)).toBeNull();
  });
});

// Guard de regressão da exaustividade local: os dois gates deste arquivo existem no kernel (o
// gate-exhaustiveness.test já garante GATES ≡ GATE_IDS; aqui só pinamos que os ids usados acima são reais).
it("os GateIds usados aqui existem no kernel", () => {
  for (const g of ["hasDeployProof", "hasReleased"] as GateId[]) expect(GATES[g]).toBeTruthy();
});
