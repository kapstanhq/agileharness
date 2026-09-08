import { describe, it, expect, vi } from "vitest";
import {
  allCosmetic,
  climbLadder,
  isJudgeableFile,
  isResolved,
  resolutionTrailer,
  sidesEquivalentModuloWhitespace,
  SEMANTIC_ATTEMPT_CAP,
  MAX_ANALYSIS_HUNKS,
  type HunkAnalysis,
  type JudgePort,
  type LadderDeps,
  type LadderInput,
} from "./semantic-resolution";
import type { ExecFn } from "./worktree";

// WS-10 — the ladder. Every test here defends a SAFETY invariant from the module header, so a failure is a
// statement about the system's safety, not about a helper's ergonomics. The judge is always a fake (a real
// port would spawn `claude` from a unit test); git is a fake exec keyed on the command, so each rung's
// behaviour under a git FAILURE is testable — which is where fail-closed actually gets proven.

/** A fake exec: `answers` maps a substring of the command → the exit code (0 = success). Anything unmatched
 *  succeeds, so a test only declares the commands it cares about. */
function fakeExec(answers: Array<{ match: string; code: number; stdout?: string }> = []): ExecFn {
  return (async (cmd: string) => {
    const hit = answers.find((a) => cmd.includes(a.match));
    if (!hit || hit.code === 0) return { stdout: hit?.stdout ?? "", stderr: "" };
    const err = Object.assign(new Error(`exit ${hit.code}`), { code: hit.code, stdout: hit.stdout ?? "", stderr: "" });
    throw err;
  }) as unknown as ExecFn;
}

const hunk = (over: Partial<HunkAnalysis> = {}): HunkAnalysis => ({
  file: "packages/x/src/a.ts",
  hunk: "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs",
  verdict: "cosmetic",
  rationale: "os dois lados reescrevem o mesmo comentário",
  ...over,
});

const baseInput = (over: Partial<LadderInput> = {}): LadderInput => ({
  sides: { ours: "main", theirs: "stage", files: ["packages/x/src/a.ts"] },
  base: "base-sha",
  origin: "release",
  ...over,
});

const deps = (over: Partial<LadderDeps> = {}): LadderDeps => ({
  exec: fakeExec([{ match: "git diff --quiet -w", code: 1 }]), // default: the sides genuinely differ
  repoRoot: "/repo",
  enabled: true,
  ...over,
});

describe("invariante 7 — a flag governa (semanticResolution: false ⇒ comportamento de hoje byte-idêntico)", () => {
  it("com a flag OFF não roda NENHUM comando git e devolve `disabled`", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as ExecFn;
    const res = await climbLadder(deps({ enabled: false, exec }), baseInput());
    expect(res.outcome).toBe("disabled");
    // O ponto do aceite 6: não é só "não resolve" — é não TOCAR em nada. Um git a mais já seria
    // comportamento novo num caminho que promete ser idêntico ao de hoje.
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("invariante 5 — board-data NUNCA chega ao juiz (aceite 7: teste de roteamento)", () => {
  it("classifica card/board-data como NÃO-julgável e código como julgável", () => {
    expect(isJudgeableFile("storymap/boards/acme/cards/story-x.md")).toBe(false);
    expect(isJudgeableFile("storymap/boards/_base/board.yaml")).toBe(false);
    expect(isJudgeableFile("packages/storymap-ui/src/lib/x.ts")).toBe(true);
    expect(isJudgeableFile("docs/plans/y.md")).toBe(true); // docs são texto arbitrário — do juiz
  });

  it("um conflito de card não sobe a escada — vai para o merge determinístico do WS-2", async () => {
    const judge = vi.fn();
    const res = await climbLadder(
      deps({ judge: judge as unknown as JudgePort }),
      baseInput({ sides: { ours: "main", theirs: "run/x", files: ["storymap/boards/acme/cards/story-x.md"] } }),
    );
    expect(res.outcome).toBe("skipped");
    expect(res.detail).toContain("WS-2");
    expect(judge).not.toHaveBeenCalled();
  });

  it("um conjunto MISTO (código + board-data) também não passa — nunca é do juiz dividir", async () => {
    const judge = vi.fn();
    const res = await climbLadder(
      deps({ judge: judge as unknown as JudgePort }),
      baseInput({ sides: { ours: "main", theirs: "run/x", files: ["packages/x/a.ts", "storymap/boards/acme/cards/s.md"] } }),
    );
    expect(res.outcome).toBe("skipped");
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("invariante 3 — 1 tentativa semântica por entry (aceite 5: loop-guard)", () => {
  it("a 2ª subida da MESMA entry é pulada — sem juiz, sem git", async () => {
    const judge = vi.fn();
    const res = await climbLadder(deps({ judge: judge as unknown as JudgePort }), baseInput({ attempts: SEMANTIC_ATTEMPT_CAP }));
    expect(res.outcome).toBe("skipped");
    expect(res.detail).toContain("base nova");
    expect(judge).not.toHaveBeenCalled();
  });

  it("a 1ª subida (attempts: 0) roda normalmente", async () => {
    const judge = vi.fn(async () => ({ hunks: [hunk()], runId: "r1", resolvedRef: "resolve/abc" }));
    const res = await climbLadder(deps({ judge }), baseInput({ attempts: 0 }));
    expect(judge).toHaveBeenCalledOnce();
    expect(res.outcome).toBe("resolved-cosmetic");
  });
});

describe("degrau 0 — convergência (só `landed` resolve; o resto sobe)", () => {
  it("`landed` resolve sem pagar o juiz", async () => {
    const judge = vi.fn();
    const res = await climbLadder(
      deps({
        judge: judge as unknown as JudgePort,
        deltaLandedFn: async () => ({ verdict: "landed", detail: "pós-imagem idêntica" }),
      }),
      baseInput({ range: { base: "b", head: "h" } }),
    );
    expect(res.outcome).toBe("resolved-converged");
    expect(judge).not.toHaveBeenCalled();
  });

  it.each(["partial", "unknown", "absent"] as const)("`%s` NÃO resolve — sobe a escada (contrato da assimetria)", async (verdict) => {
    const judge = vi.fn(async () => ({ hunks: [hunk({ verdict: "substantive", rationale: "lógica diferente" })], runId: "r" }));
    const res = await climbLadder(
      deps({ judge, deltaLandedFn: async () => ({ verdict, detail: "d" }) }),
      baseInput({ range: { base: "b", head: "h" } }),
    );
    expect(res.outcome).toBe("escalated-substantive");
    expect(judge).toHaveBeenCalledOnce();
  });

  it("uma falha do degrau 0 não derruba a escada — ela apenas sobe", async () => {
    const judge = vi.fn(async () => ({ hunks: [hunk()], runId: "r", resolvedRef: "resolve/x" }));
    const res = await climbLadder(
      deps({ judge, deltaLandedFn: async () => { throw new Error("git explodiu"); } }),
      baseInput({ range: { base: "b", head: "h" } }),
    );
    expect(res.outcome).toBe("resolved-cosmetic");
  });
});

describe("degrau 1 — filtro determinístico (aceite 1: resolve sem LLM)", () => {
  it("lados equivalentes módulo whitespace ⇒ resolve mantendo o alvo, sem juiz", async () => {
    const judge = vi.fn();
    const res = await climbLadder(
      deps({ exec: fakeExec([{ match: "git diff --quiet -w", code: 0 }]), judge: judge as unknown as JudgePort }),
      baseInput(),
    );
    expect(res.outcome).toBe("resolved-deterministic");
    expect(res.detail).toContain("sem LLM");
    expect(judge).not.toHaveBeenCalled();
  });

  it("TUDO-OU-NADA: um arquivo não-equivalente manda o CONJUNTO ao degrau 2", async () => {
    // a.ts é equivalente; b.ts não. Resolver só o a.ts seria a resolução PARCIAL que a spec rejeita.
    const exec = (async (cmd: string) => {
      if (cmd.includes("b.ts")) throw Object.assign(new Error("differ"), { code: 1, stdout: "" });
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFn;
    const judge = vi.fn(async () => ({ hunks: [hunk({ file: "b.ts", verdict: "substantive", rationale: "lógica" })], runId: "r" }));
    const res = await climbLadder(deps({ exec, judge }), baseInput({ sides: { ours: "main", theirs: "stage", files: ["a.ts", "b.ts"] } }));
    expect(judge).toHaveBeenCalledOnce();
    expect(res.outcome).toBe("escalated-substantive");
  });

  it("FAIL-CLOSED: um erro do git NÃO vira `equivalente` (exit 128 ≠ sem diff)", async () => {
    const exec = fakeExec([{ match: "git diff --quiet -w", code: 128 }]);
    await expect(sidesEquivalentModuloWhitespace(exec, "/repo", { ours: "main", theirs: "stage", files: ["a.ts"] })).resolves.toBe(false);
  });

  it("nada medido não prova nada — lista vazia nunca é `equivalente`", async () => {
    await expect(sidesEquivalentModuloWhitespace(fakeExec(), "/repo", { ours: "main", theirs: "stage", files: [] })).resolves.toBe(false);
  });
});

describe("degrau 2 — o juiz (invariante 2: tudo-ou-nada; invariante 6: dúvida ⇒ substantivo)", () => {
  it("todos cosméticos + artefato ⇒ resolve e devolve a ref para RE-ENTRAR pelo mecanismo normal", async () => {
    const judge: JudgePort = async () => ({ hunks: [hunk(), hunk({ file: "b.ts" })], runId: "run-1", resolvedRef: "resolve/abc" });
    const res = await climbLadder(deps({ judge }), baseInput());
    expect(res.outcome).toBe("resolved-cosmetic");
    expect(res.resolvedRef).toBe("resolve/abc");
    expect(res.detail).toContain("o gate roda de novo");
  });

  it("ACEITE 2/4 — 3 cosméticos + 1 SUBSTANTIVO ⇒ NENHUMA resolução, e a análise cobre os 4", async () => {
    const judge: JudgePort = async () => ({
      hunks: [
        hunk({ file: "a.ts" }),
        hunk({ file: "b.ts" }),
        hunk({ file: "c.ts" }),
        hunk({ file: "d.ts", verdict: "substantive", rationale: "duas implementações diferentes da mesma função" }),
      ],
      runId: "run-2",
      // Um juiz mal-comportado que resolveu mesmo assim: a ref é IGNORADA porque a regra é do código.
      resolvedRef: "resolve/should-be-ignored",
    });
    const res = await climbLadder(deps({ judge }), baseInput());
    expect(res.outcome).toBe("escalated-substantive");
    expect(res.resolvedRef).toBeUndefined(); // nada aplicado — a árvore parcial nunca existe
    expect(res.hunks).toHaveLength(4); // a análise cobre TODOS, não só o culpado
    expect(res.detail).toContain("tudo-ou-nada");
  });

  it("`allCosmetic` de mão vazia é FALSO — 'nada a julgar' não é prova de inocência", () => {
    expect(allCosmetic([])).toBe(false);
    expect(allCosmetic([hunk()])).toBe(true);
    expect(allCosmetic([hunk(), hunk({ verdict: "substantive" })])).toBe(false);
  });

  it("alegar 'tudo cosmético' SEM artefato não resolve — prova, não afirmação", async () => {
    const judge: JudgePort = async () => ({ hunks: [hunk()], runId: "run-3" }); // sem resolvedRef
    const res = await climbLadder(deps({ judge }), baseInput());
    expect(res.outcome).toBe("escalated-substantive");
  });

  it("o juiz MORRER é distinto de 'é ambíguo' (judge-failed) — o operador precisa saber qual foi", async () => {
    const judge: JudgePort = async () => ({ hunks: [], runId: "r", error: "timeout de 600s" });
    const res = await climbLadder(deps({ judge }), baseInput());
    expect(res.outcome).toBe("judge-failed");
    expect(res.detail).toContain("timeout");
  });

  it("o juiz LANÇAR também é fail-closed (nunca derruba a disposição do conflito)", async () => {
    const judge: JudgePort = async () => { throw new Error("spawn ENOENT"); };
    const res = await climbLadder(deps({ judge }), baseInput());
    expect(res.outcome).toBe("judge-failed");
  });

  it("sem juiz configurado, degrada para escalação (como um RedriveHandler ausente) — nunca crash", async () => {
    const res = await climbLadder(deps({ judge: undefined }), baseInput());
    expect(res.outcome).toBe("escalated-substantive");
    expect(res.detail).toContain("fail-closed");
  });

  it("uma análise gigante é CAPADA, e a truncagem é declarada (nunca mente sobre a própria completude)", async () => {
    const many = Array.from({ length: MAX_ANALYSIS_HUNKS + 5 }, (_, i) => hunk({ file: `f${i}.ts`, verdict: "substantive" }));
    const judge: JudgePort = async () => ({ hunks: many, runId: "r" });
    const res = await climbLadder(deps({ judge }), baseInput());
    expect(res.hunks).toHaveLength(MAX_ANALYSIS_HUNKS + 1); // os capados + o marcador de overflow
    expect(res.hunks.at(-1)!.rationale).toContain("não listados");
  });
});

describe("trilha (invariante 4)", () => {
  it("o trailer é estruturado — `git log` acha resolução de máquina sem parsear inglês", () => {
    expect(resolutionTrailer(3, "run-9")).toBe("Merge-Resolution: 3 hunk(s) cosmético(s), juiz run-9");
  });

  it("isResolved separa os 3 desfechos que materializam dos que escalam", () => {
    expect(isResolved("resolved-converged")).toBe(true);
    expect(isResolved("resolved-deterministic")).toBe(true);
    expect(isResolved("resolved-cosmetic")).toBe(true);
    expect(isResolved("escalated-substantive")).toBe(false);
    expect(isResolved("judge-failed")).toBe(false);
    expect(isResolved("disabled")).toBe(false);
    expect(isResolved("skipped")).toBe(false);
  });
});
