import { describe, it, expect } from "vitest";
import { GATES } from "./gate-core";
import { coerceCard } from "./repo";

// C2 (2026-07-08, ny4v26) — the build-evidence gate on the desenvolver→revisar-codigo edge. A card
// reached code review with NO implementation (the sanctioned advance was swallowed — C1 — and the
// skill hand-flipped `status:`). This gate demands every declared task done before review; because
// gates also run in the pre-write hook, it binds ANY writer — including a manual status flip.
// Like hasCriteriaSpecs it must be DEFAULT-SATISFIED on absent data (zero-migration: never freezes
// a legacy card / the merge train — the storymap-merge-gate-fail-closed footgun).
const okWith = (data: Record<string, any>) =>
  GATES.hasBuildEvidence.ok(coerceCard("t", { type: "story", storyType: "user", ...data }, ""));

describe("C2 hasBuildEvidence — tasks done + delega hasCriteriaSpecs, default-satisfied", () => {
  it("SATISFIED when tasks is absent (zero-migration — a legacy card never freezes)", () => {
    expect(okWith({})).toBe(true);
  });

  it("SATISFIED when tasks is empty", () => {
    expect(okWith({ tasks: [] })).toBe(true);
  });

  it("SATISFIED when every declared task is done", () => {
    expect(
      okWith({
        tasks: [
          { id: "t1", title: "modelo", done: true },
          { id: "t2", title: "ui", done: true },
        ],
      }),
    ).toBe(true);
  });

  it("BLOCKS when any declared task is not done (the ny4v26 ghost-advance vector)", () => {
    expect(
      okWith({
        tasks: [
          { id: "t1", title: "modelo", done: true },
          { id: "t2", title: "ui", done: false },
        ],
      }),
    ).toBe(false);
  });

  it("delegates hasCriteriaSpecs: tasks done but a declared UI criterion without specPath still BLOCKS", () => {
    expect(
      okWith({
        tasks: [{ id: "t1", title: "x", done: true }],
        criteriaSpecs: [{ criterion: "botão salva" }],
      }),
    ).toBe(false);
  });

  // ── WS-5.2 (colisão #4 / story-uae2ag) — o carimbo `buildEvidence` como a OUTRA evidência ─────────────
  // As tasks são um PROXY, e o proxy é cego ao caso em que o código do card JÁ ATERRISSOU num run anterior:
  // não implementar é o comportamento CORRETO, nenhuma task vira done, e o card deadlocka em Desenvolver
  // para sempre. O carimbo só existe quando o engine PROVOU convergência por conteúdo (deltaLanded ===
  // landed) — então o gate não afrouxou: ele aceita a prova direta, além do proxy.
  const landedStamp = { provenance: "already-landed", at: "2026-07-16T10:00:00.000Z", range: "aaa..bbb", target: "stage" };

  it("WS-5.2: tasks PENDENTES + buildEvidence carimbada ⇒ SATISFIED (o deadlock do qb8z2c morre)", () => {
    expect(
      okWith({
        tasks: [{ id: "t1", title: "implementar", done: false }],
        buildEvidence: landedStamp,
      }),
    ).toBe(true);
  });

  it("WS-5.2: o carimbo NÃO dispensa os specs de aceite (ele prova o build, não o spec)", () => {
    expect(
      okWith({
        tasks: [{ id: "t1", title: "x", done: false }],
        buildEvidence: landedStamp,
        criteriaSpecs: [{ criterion: "botão salva" }],
      }),
    ).toBe(false);
  });

  it("WS-5.2: um carimbo FORJADO/malformado não passa o card (provenance desconhecida é descartada no coerce)", () => {
    expect(okWith({ tasks: [{ id: "t1", title: "x", done: false }], buildEvidence: { provenance: "confia-em-mim", at: "2026-07-16" } })).toBe(false);
    expect(okWith({ tasks: [{ id: "t1", title: "x", done: false }], buildEvidence: { provenance: "already-landed" } })).toBe(false); // sem `at`
    expect(okWith({ tasks: [{ id: "t1", title: "x", done: false }], buildEvidence: "sim" })).toBe(false);
  });

  it("WS-5.2 parity: o predicado CRU (hook, sem coerce) lê a mesma provenance e nunca lança", () => {
    // O hook roda sobre o js-yaml puro — onde `at` vira Date, não string. Por isso o predicado só olha a
    // `provenance`: depender de `at` faria hook e app discordarem.
    const raw = (buildEvidence: unknown) =>
      GATES.hasBuildEvidence.ok({ type: "story", storyType: "user", tasks: [{ done: false }], buildEvidence } as any);
    expect(raw({ provenance: "already-landed", at: new Date("2026-07-16T10:00:00Z") })).toBe(true);
    expect(raw({ provenance: "outra-coisa" })).toBe(false);
    expect(() => raw(["junk"])).not.toThrow();
    expect(raw(["junk"])).toBe(false);
    expect(raw(null)).toBe(false);
  });

  it("parity-safe: never throws on RAW malformed input (the pre-write hook path)", () => {
    expect(() =>
      GATES.hasBuildEvidence.ok({ type: "story", storyType: "user", tasks: [null, "junk", { done: "yes" }] } as any),
    ).not.toThrow();
    // a malformed declared task counts as not-done → present-but-incomplete → blocks (same
    // fail-closed-on-declared spirit as hasCriteriaSpecs' non-string specPath)
    expect(GATES.hasBuildEvidence.ok({ type: "story", storyType: "user", tasks: [{ done: "yes" }] } as any)).toBe(false);
    expect(GATES.hasBuildEvidence.ok({ type: "story", storyType: "user", tasks: "junk" } as any)).toBe(true); // non-array = undeclared → default-satisfied
  });
});
