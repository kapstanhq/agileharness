import { describe, expect, it } from "vitest";
import {
  makeDefaultAcceptanceRunner,
  planAcceptance,
  type AcceptanceSpec,
} from "./qa-runner";

describe("planAcceptance — routes each criterion via the verification ladder", () => {
  it("maps each acceptance criterion to a spec carrying its ladder layer, preserving order + text", () => {
    const acceptance = [
      "Dado que abro a tela, o botão de perfil aparece no header",
      "Quando confirmo, os dados persistem no Firestore",
      "A transição do modal é animada suavemente",
    ];
    const specs = planAcceptance(acceptance);

    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.criterion)).toEqual(acceptance); // order + text preserved
    expect(specs[0].layer).toBe("component"); // "aparece"/"header"/"botão" → cheapest render layer
    expect(specs[1].layer).toBe("integration"); // "persistem"/"Firestore" → real stack
    expect(specs[2].layer).toBe("browser"); // "transição"/"animada" → real browser
    // The scaffold does not synthesize spec paths yet — a later Fase wires the authoring.
    expect(specs.every((s) => s.specPath === undefined)).toBe(true);
  });

  it("empty in → empty out (pure, no side effects)", () => {
    expect(planAcceptance([])).toEqual([]);
  });
});

describe("makeDefaultAcceptanceRunner — aggregates injected per-spec results into a verdict", () => {
  const specs: AcceptanceSpec[] = [
    { criterion: "o botão aparece", layer: "component" },
    { criterion: "os dados persistem", layer: "integration" },
  ];

  it("passed = ALL specs passed; reports one result per criterion (preserving layer + text)", async () => {
    const runner = makeDefaultAcceptanceRunner({
      runSpec: async () => ({ passed: true }),
    });
    const verdict = await runner.run(specs, { cwd: "/repo" });

    expect(verdict.passed).toBe(true);
    expect(verdict.results).toHaveLength(2);
    expect(verdict.results.map((r) => r.criterion)).toEqual(["o botão aparece", "os dados persistem"]);
    expect(verdict.results.map((r) => r.layer)).toEqual(["component", "integration"]);
    expect(verdict.results.every((r) => r.passed)).toBe(true);
  });

  it("a single failing spec fails the whole verdict, but every criterion is still reported", async () => {
    const runner = makeDefaultAcceptanceRunner({
      runSpec: async (spec) =>
        spec.layer === "integration"
          ? { passed: false, detail: "expected doc, got null" }
          : { passed: true },
    });
    const verdict = await runner.run(specs, { cwd: "/repo" });

    expect(verdict.passed).toBe(false); // one red ⇒ gate red
    expect(verdict.results).toHaveLength(2);
    const failed = verdict.results.find((r) => !r.passed);
    expect(failed?.criterion).toBe("os dados persistem");
    expect(failed?.detail).toBe("expected doc, got null");
  });

  it("passes the run ctx (cwd) through to the injected runSpec unchanged", async () => {
    const seen: Array<{ criterion: string; cwd: string }> = [];
    const runner = makeDefaultAcceptanceRunner({
      runSpec: async (spec, ctx) => {
        seen.push({ criterion: spec.criterion, cwd: ctx.cwd });
        return { passed: true };
      },
    });
    await runner.run(specs, { cwd: "/some/worktree" });

    expect(seen).toEqual([
      { criterion: "o botão aparece", cwd: "/some/worktree" },
      { criterion: "os dados persistem", cwd: "/some/worktree" },
    ]);
  });

  it("empty specs → a vacuously-passing verdict with no results", async () => {
    const runner = makeDefaultAcceptanceRunner({ runSpec: async () => ({ passed: true }) });
    const verdict = await runner.run([], { cwd: "/repo" });
    expect(verdict).toEqual({ passed: true, results: [] });
  });
});
