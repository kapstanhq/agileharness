// convergence — REAL-git suite (mirrors split-integration.test.ts's throwaway-repo pattern). The whole
// point of this primitive is to see through sha changes, so mocking git would test nothing: every verdict
// below is measured against an actual cherry-pick / squash / partial landing.
//
// The asymmetry (convergence.ts's header) is what these tests pin: `landed` must be EARNED (positive proof
// by content) and everything else must stay conservative — including the honest G11 residual (squash + a
// later edit reads `absent`), which is asserted here ON PURPOSE so nobody "fixes" it with a loose
// containment heuristic.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  branchWorkLandedBySplit,
  deltaLanded,
  expectedDeltaOf,
  projectSplitVerdict,
  rangeLandedBySplit,
  shaContainedIn,
} from "./convergence";
import { isolatedGitExec } from "./git-test-env";
import { describePosix } from "./test-platform";
import type { ExecFn } from "./worktree";

let exec = promisify(nodeExec) as unknown as ExecFn;

describePosix("deltaLanded (real git) — o delta X já está no alvo Y?", () => {
  let tmpRoot: string;
  let repo: string;
  let baseSha: string;

  const git = async (cmd: string) => (await exec(`git ${cmd}`, { cwd: repo })).stdout.trim();
  const write = async (file: string, body: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fsp.writeFile(path.join(repo, file), body);
  };
  const commit = async (file: string, body: string, msg: string) => {
    await write(file, body);
    await git(`add -A`);
    await git(`commit -q --no-verify -m ${JSON.stringify(msg)}`);
    return git(`rev-parse HEAD`);
  };

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-converge-"));
    exec = isolatedGitExec(exec, tmpRoot);
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(repo, { recursive: true });
    await git(`init -q -b main`);
    await git(`config user.email t@t.dev`);
    await git(`config user.name tester`);
    baseSha = await commit("packages/app/x.ts", "export const x = 1;\n", "base");

    // The card's delta: TWO own commits (two commits is what makes a squash change every patch-id, so the
    // layers are actually distinguishable — a single-commit squash keeps its patch-id and never reaches
    // layer 3).
    await git(`checkout -q -b feature ${baseSha}`);
    await commit("packages/app/a.ts", "export const a = 1;\n", "feat: a");
    await commit("packages/app/b.ts", "export const b = 1;\n", "feat: b");
    await git(`checkout -q main`);

    // 1) target-merged: main fast-forwards over the branch → the trivial ancestry case.
    await git(`branch target-merged feature`);

    // Every target below DIVERGES first (an unrelated advance) and only then receives the delta. That is
    // both realistic (the target moved on — that is WHY the sha changes) and necessary: a cherry-pick onto
    // the very same parent, with the same metadata, reproduces the IDENTICAL commit object — the fixture
    // would silently degenerate into the ancestry case and never exercise the patch-id layer at all.

    // 2) target-cherry: the two commits cherry-picked onto a moved target → NEW shas, NO ancestry.
    await git(`checkout -q -b target-cherry ${baseSha}`);
    await commit("packages/app/unrelated.ts", "export const u = 1;\n", "chore: unrelated");
    await git(`cherry-pick feature~1 feature`);
    await git(`checkout -q main`);

    // 3) target-squash: the SAME final content as `feature`, landed as ONE commit (every patch-id differs).
    //    Only the post-image layer can acquit this.
    await git(`checkout -q -b target-squash ${baseSha}`);
    await commit("packages/app/unrelated.ts", "export const u = 2;\n", "chore: unrelated");
    await write("packages/app/a.ts", "export const a = 1;\n");
    await write("packages/app/b.ts", "export const b = 1;\n");
    await git(`add -A`);
    await git(`commit -q --no-verify -m "squash: a+b"`);
    await git(`checkout -q main`);

    // 4) target-partial: only the FIRST of the two commits landed.
    await git(`checkout -q -b target-partial ${baseSha}`);
    await commit("packages/app/unrelated.ts", "export const u = 3;\n", "chore: unrelated");
    await git(`cherry-pick feature~1`);
    await git(`checkout -q main`);

    // 5) target-absent: advanced, but never saw the delta.
    await git(`checkout -q -b target-absent ${baseSha}`);
    await commit("packages/app/other.ts", "export const o = 1;\n", "chore: other");
    await git(`checkout -q main`);

    // 6) target-squash-edited: the squash landed AND was then EDITED in the target (the honest G11 residual
    //    — patch-id changed AND post-image changed).
    await git(`checkout -q -b target-squash-edited target-squash`);
    await commit("packages/app/b.ts", "export const b = 99; // ajustado depois\n", "fix: ajuste posterior");
    await git(`checkout -q main`);
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("camada 1 — o alvo descende do head do delta ⇒ landed (ancestralidade)", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: "feature" }, target: "target-merged" });
    expect(res.verdict).toBe("landed");
    expect(res.detail).toContain("ancestralidade");
  });

  it("camada 2 — CHERRY-PICK real (shas novos) ⇒ landed por patch-id, e um avanço não-relacionado do alvo não atrapalha", async () => {
    // O caso que o `--is-ancestor` do GC nunca via — e por isso o lixo virava imortal.
    await expect(exec(`git merge-base --is-ancestor feature target-cherry`, { cwd: repo })).rejects.toBeDefined();
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: "feature" }, target: "target-cherry" });
    expect(res.verdict).toBe("landed");
    expect(res.detail).toContain("patch-id");
  });

  it("camada 3 — SQUASH (todo patch-id mudou) ⇒ landed pela pós-imagem, medida SÓ no pathspec do delta", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: "feature" }, target: "target-squash" });
    expect(res.verdict).toBe("landed");
    expect(res.detail).toContain("pós-imagem");
  });

  it("aterrissagem PARCIAL (1 de 2 commits) ⇒ partial — que não autoriza nada", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: "feature" }, target: "target-partial" });
    expect(res.verdict).toBe("partial");
    expect(res.detail).toContain("1/2");
  });

  it("o delta não está no alvo ⇒ absent (nem ancestralidade, nem patch-id, nem pós-imagem)", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: "feature" }, target: "target-absent" });
    expect(res.verdict).toBe("absent");
  });

  it("RESIDUAL HONESTO (G11): squash + edição posterior no alvo ⇒ absent — conservador de propósito", async () => {
    // NÃO "conserte" isto com containment por arquivo: um falso `landed` perde trabalho; este `absent`
    // custa um spawn/um branch vivo, e o destravamento manual segue existindo. Ver o header do módulo.
    const res = await deltaLanded(exec, repo, {
      range: { base: baseSha, head: "feature" },
      target: "target-squash-edited",
    });
    expect(res.verdict).toBe("absent");
  });

  it("ref que não resolve ⇒ unknown (NUNCA absent — uma falha não é uma resposta)", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: "feature" }, target: "nao-existe" });
    expect(res.verdict).toBe("unknown");
    expect(res.detail).toContain("ref não resolvida");
  });

  it("git quebrado/timeout ⇒ unknown (o exec que sempre falha nunca vira 'absent')", async () => {
    const brokenExec: ExecFn = async () => {
      throw Object.assign(new Error("git morreu"), { code: 128 });
    };
    const res = await deltaLanded(brokenExec, repo, { range: { base: baseSha, head: "feature" }, target: "main" });
    expect(res.verdict).toBe("unknown");
  });

  it("range vazio (base == head) ⇒ absent — um delta que não existe não PROVA nada sobre o alvo", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: baseSha, head: baseSha }, target: "target-absent" });
    expect(res.verdict).toBe("absent");
    expect(res.detail).toContain("não muda arquivo nenhum");
  });

  it("range/alvo incompleto ⇒ unknown, sem tocar git", async () => {
    const res = await deltaLanded(exec, repo, { range: { base: "", head: "feature" }, target: "main" });
    expect(res.verdict).toBe("unknown");
  });

  // ── Follow-up B (deploy-truth) — a primitiva de ancestralidade extraída: UMA implementação para a
  // pergunta "sha A está contido no publicado B" (deploy-reconcile a consome via makeGitContains).
  describe("shaContainedIn — trinário nunca-lança (exit 0 = sim, 1 = NÃO real, resto = unknown)", () => {
    it("contido: o alvo descende do sha — e REFLEXIVO (um sha contém a si mesmo)", async () => {
      await expect(shaContainedIn(exec, repo, { inner: baseSha, outer: "feature" })).resolves.toBe("contained");
      await expect(shaContainedIn(exec, repo, { inner: baseSha, outer: baseSha })).resolves.toBe("contained");
    });

    it("exit 1 é uma RESPOSTA (não uma falha): o delta não está no alvo ⇒ not-contained", async () => {
      await expect(shaContainedIn(exec, repo, { inner: "feature", outer: "target-absent" })).resolves.toBe("not-contained");
    });

    it("ref inexistente (exit 128) ⇒ unknown — uma falha nunca é uma resposta", async () => {
      await expect(shaContainedIn(exec, repo, { inner: "feature", outer: "nao-existe" })).resolves.toBe("unknown");
    });

    it("git quebrado (erro sem exit code) e input vazio ⇒ unknown, nunca lança", async () => {
      const broken: ExecFn = async () => {
        throw new Error("git morreu");
      };
      await expect(shaContainedIn(broken, repo, { inner: "a", outer: "b" })).resolves.toBe("unknown");
      await expect(shaContainedIn(exec, repo, { inner: "", outer: "feature" })).resolves.toBe("unknown");
    });
  });
});

describe("expectedDeltaOf — o delta que o card diz ter produzido", () => {
  it("prefere commitRange (o delta validado pela review/QA) ao diffSnapshot", () => {
    expect(
      expectedDeltaOf({
        commitRange: { base: "aaa", head: "bbb" },
        diffSnapshot: { base: "ccc", mergeCommit: "ddd" },
      }),
    ).toEqual({ base: "aaa", head: "bbb" });
  });

  it("cai para diffSnapshot (base..mergeCommit) quando não há commitRange", () => {
    expect(expectedDeltaOf({ diffSnapshot: { base: "ccc", mergeCommit: "ddd" } })).toEqual({ base: "ccc", head: "ddd" });
  });

  it("card sem delta registrado (ou meio-range) ⇒ null — nada a provar, o chamador segue conservador", () => {
    expect(expectedDeltaOf(null)).toBeNull();
    expect(expectedDeltaOf({})).toBeNull();
    expect(expectedDeltaOf({ commitRange: { base: "aaa", head: "" } })).toBeNull();
    expect(expectedDeltaOf({ diffSnapshot: { base: "", mergeCommit: "ddd" } })).toBeNull();
  });
});

// autonomy-endgame WS-1 — the SPLIT ruler, over real git. The bug it kills is structural, not a typo: the
// train applies a run's diff as TWO disjoint patches to TWO refs (code → `stage`, board-data → `main`), and
// every ruler before this one asked whether the WHOLE delta was in ONE ref — a question a split run can never
// answer yes to, however completely it landed. That false `absent` is what made the redrive re-implement
// published code (~$13, the qb8z2c pattern) and the teardown brand landed sessions `failed/agent/*`.
//
// FIXTURE GOTCHA (cost real time before — see the fleet-autonomy notes): git addresses commits by content, so
// a cherry-pick onto the same parent with the same tree yields the IDENTICAL sha, and the fixture silently
// degenerates into the trivial ancestry case, proving nothing. Every target here DIVERGES first, then
// receives the content — exactly how the train's `git apply` + commit lands it: new sha, new patch-id, same
// post-image.
describePosix("branchWorkLandedBySplit (real git) — WS-1: cada metade medida no SEU ref", () => {
  let tmpRoot: string;
  let repo: string;
  let baseSha: string;

  const git = async (cmd: string) => (await exec(`git ${cmd}`, { cwd: repo })).stdout.trim();
  const write = async (file: string, body: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fsp.writeFile(path.join(repo, file), body);
  };
  const commitAll = async (msg: string) => {
    await git(`add -A`);
    await git(`commit -q --no-verify -m ${JSON.stringify(msg)}`);
    return git(`rev-parse HEAD`);
  };

  const CODE = "packages/app/feature.ts";
  const CARD = "storymap/boards/b/cards/story-x.md";
  const card = (status: string) => `---\nid: story-x\nstatus: ${status}\n---\ncorpo\n`;

  /** A run branch cut from base (the reflog's `Created from` ⇒ an EXACT base, which is what may authorize). */
  const mkRun = async (name: string, files: Record<string, string>) => {
    await git(`checkout -q -b ${name} ${baseSha}`);
    for (const [f, body] of Object.entries(files)) await write(f, body);
    await commitAll(`run ${name}`);
    await git(`checkout -q main`);
  };

  /** Land content on a ref the way the TRAIN does: diverge first, then re-apply the content as a NEW commit
   *  (new sha, new patch-id, identical post-image) — never a merge or a cherry-pick of the run's commit. */
  const landOn = async (ref: string, files: Record<string, string>, msg: string) => {
    await git(`checkout -q ${ref}`);
    await write(`packages/app/unrelated-${ref}-${msg.replace(/\W/g, "")}.ts`, `export const u = "${msg}";\n`);
    for (const [f, body] of Object.entries(files)) await write(f, body);
    await commitAll(msg);
    await git(`checkout -q main`);
  };

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-split-ruler-"));
    exec = isolatedGitExec(exec, tmpRoot);
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(repo, { recursive: true });
    await git(`init -q -b main`);
    await git(`config user.email t@t.dev`);
    await git(`config user.name tester`);
    await write(CODE, "export const feature = 1;\n");
    await write(CARD, card("desenvolver"));
    baseSha = await commitAll("base");
    await git(`branch stage ${baseSha}`);
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("1 — delta MISTO com as duas metades aterrissadas por patch ⇒ {code:landed, data:landed} (hoje: absent, ~$13)", async () => {
    await mkRun("run/mixed", { [CODE]: "export const feature = 2;\n", [CARD]: card("revisar-codigo") });
    await landOn("stage", { [CODE]: "export const feature = 2;\n" }, "stage recebe o código");
    await landOn("main", { [CARD]: card("revisar-codigo") }, "main recebe o board data");

    const v = await branchWorkLandedBySplit(exec, repo, "run/mixed");
    expect(v).toMatchObject({ code: "landed", data: "landed" });
    // The whole point: the projection the legacy consumers read now says `landed` for work that IS landed.
    expect(projectSplitVerdict(v)).toBe("landed");

    // ...and the OLD question — the whole delta against ONE ref — still says `absent` on the very same work.
    // This is the defect, executable: not a wrong ref, but a wrong QUESTION.
    const whole = await deltaLanded(exec, repo, { range: { base: baseSha, head: "run/mixed" }, target: "stage" });
    expect(whole.verdict).toBe("absent");
  });

  it("2 — código em stage, dados NÃO em main ⇒ {code:landed, data:absent} (a foto viva de a779b5be)", async () => {
    await mkRun("run/half", { [CODE]: "export const feature = 3;\n", [CARD]: card("qa-automatizado") });
    await landOn("stage", { [CODE]: "export const feature = 3;\n" }, "stage recebe so o codigo");

    const v = await branchWorkLandedBySplit(exec, repo, "run/half");
    expect(v).toMatchObject({ code: "landed", data: "absent" });
    // NOT `landed` — the card really is stranded. The ruler must name it, not paper over it.
    expect(projectSplitVerdict(v)).toBe("absent");
  });

  it("3 — run de board-data PURO ⇒ {code:'n/a', data:landed} — 'não tem código' ≠ 'o código não aterrissou'", async () => {
    await mkRun("run/dataonly", { [CARD]: card("entregue") });
    await landOn("main", { [CARD]: card("entregue") }, "main recebe o board data puro");

    const v = await branchWorkLandedBySplit(exec, repo, "run/dataonly");
    // `n/a`, NOT `absent`: a data-only run is the MAJORITY of runs, so calling its absent code half `absent`
    // would trade one bug for a far more frequent one. The train already models it (`pure-code run: nothing
    // to land on main`); this is the mirror.
    expect(v).toMatchObject({ code: "n/a", data: "landed" });
    expect(projectSplitVerdict(v)).toBe("landed");
  });

  it("4 — run de código PURO ⇒ {code:landed, data:'n/a'} — o espelho de 'pure-code run: nothing to land on main'", async () => {
    await mkRun("run/codeonly", { [CODE]: "export const feature = 4;\n" });
    await landOn("stage", { [CODE]: "export const feature = 4;\n" }, "stage recebe so codigo puro");

    const v = await branchWorkLandedBySplit(exec, repo, "run/codeonly");
    expect(v).toMatchObject({ code: "landed", data: "n/a" });
    expect(projectSplitVerdict(v)).toBe("landed");
  });

  it("5 — dados aterrissaram E o board ANDOU depois ⇒ data≠landed: a metade que só o RECIBO (WS-2) prova", async () => {
    await mkRun("run/moved", { [CARD]: card("revisao") });
    // The train lands the data...
    await landOn("main", { [CARD]: card("revisao") }, "main recebe os dados");
    // ...and then the LIVE SERVICE mutates the card, exactly as it does in production (a finding, a status
    // advance, a task). The post-image now differs FOR A REASON THAT IS NOT "it did not land".
    await git(`checkout -q main`);
    await write(CARD, `---\nid: story-x\nstatus: entregue\nfindings:\n  - id: f1\n---\ncorpo\n`);
    await commitAll("board: o serviço mexeu no card DEPOIS do train");

    const v = await branchWorkLandedBySplit(exec, repo, "run/moved");
    // THIS IS THE JUSTIFICATION FOR WS-2, EXECUTABLE. The data half DID land, and git cannot say so: no
    // measurement separates "did not land" from "landed and the board moved on". Whoever tries to close this
    // half inside WS-1 will reinvent the post-image and fail the same way. The receipt is the only way out.
    expect(v.data).not.toBe("landed");
    expect(v.data).toBe("absent");
  });

  it("6 — sem `paths`, deltaLanded se comporta EXATAMENTE como antes (retro-compatibilidade)", async () => {
    await mkRun("run/compat", { [CODE]: "export const feature = 6;\n" });
    await landOn("stage", { [CODE]: "export const feature = 6;\n" }, "stage compat");

    const withPaths = await deltaLanded(exec, repo, {
      range: { base: baseSha, head: "run/compat" },
      target: "stage",
      paths: ["packages/"],
    });
    const without = await deltaLanded(exec, repo, { range: { base: baseSha, head: "run/compat" }, target: "stage" });
    // A pure-code run has nothing outside the pathspec, so both forms must agree — the pathspec narrows
    // WHAT is measured, it never changes HOW.
    expect(without.verdict).toBe("landed");
    expect(withPaths.verdict).toBe("landed");
  });

  it("7 — git quebrado numa metade ⇒ `unknown` SÓ nela, sem contaminar a outra", async () => {
    await mkRun("run/brokenref", { [CODE]: "export const feature = 7;\n", [CARD]: card("pronta") });
    await landOn("main", { [CARD]: card("pronta") }, "main recebe dados do brokenref");

    const v = await branchWorkLandedBySplit(exec, repo, "run/brokenref", { codeRef: "refs/heads/nao-existe" });
    expect(v.code).toBe("unknown"); // the ref does not resolve → we know NOTHING about this half
    expect(v.data).toBe("landed"); // ...and that ignorance does not spread to the half we could measure
    // `unknown` contaminates the PROJECTION though — a hiccup must never read as a clean verdict.
    expect(projectSplitVerdict(v)).toBe("unknown");
  });

  it("8 — base ESTIMADA (fork-point) ⇒ unknown nas duas: um palpite não autoriza nada", async () => {
    await mkRun("run/noreflog", { [CODE]: "export const feature = 8;\n", [CARD]: card("pronta") });
    await landOn("stage", { [CODE]: "export const feature = 8;\n" }, "stage noreflog");
    await landOn("main", { [CARD]: card("pronta") }, "main noreflog");
    // Simulate an EXPIRED reflog (gc.reflogExpire, 90d): resolveRunBase then falls back to the fork-point,
    // which re-absorbs the stage inheritance and can only OVER-report the run's own work. Proving that
    // inflated range landed would prove something else — so it must authorize nothing, even though both
    // halves are in fact right there.
    await fsp.rm(path.join(repo, ".git", "logs", "refs", "heads", "run", "noreflog"), { force: true });

    const v = await branchWorkLandedBySplit(exec, repo, "run/noreflog");
    expect(v).toMatchObject({ code: "unknown", data: "unknown" });
    expect(projectSplitVerdict(v)).toBe("unknown");
  });
});

// autonomy-endgame WS-2 — PRECEDENCE. The train applied each half and witnessed it; the ruler should read
// that witness instead of re-deriving it from git and getting it wrong. The rule is one-directional and the
// whole safety of the feature rests on it: A RECEIPT PROVES; ITS ABSENCE REFUTES NOTHING.
describePosix("branchWorkLandedBySplit + recibo (WS-2) — o recibo prova, a ausência não refuta", () => {
  let tmpRoot: string;
  let repo: string;
  let stateDir: string;
  let baseSha: string;
  // sessionIdFromBranch only reads a uuid out of `run/<uuid>` — a free-form name has no receipt, by design.
  const RUN_ID = "a779b5be-0031-4a5c-bcfc-abc123456789";
  const BRANCH = `run/${RUN_ID}`;

  const git = async (cmd: string) => (await exec(`git ${cmd}`, { cwd: repo })).stdout.trim();
  const write = async (file: string, body: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fsp.writeFile(path.join(repo, file), body);
  };
  const commitAll = async (msg: string) => {
    await git(`add -A`);
    await git(`commit -q --no-verify -m ${JSON.stringify(msg)}`);
    return git(`rev-parse HEAD`);
  };
  const CARD = "storymap/boards/b/cards/story-y.md";

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-receipt-"));
    exec = isolatedGitExec(exec, tmpRoot);
    repo = path.join(tmpRoot, "repo");
    stateDir = path.join(tmpRoot, "state");
    await fsp.mkdir(repo, { recursive: true });
    await fsp.mkdir(stateDir, { recursive: true });
    await git(`init -q -b main`);
    await git(`config user.email t@t.dev`);
    await git(`config user.name tester`);
    await write(CARD, `---\nid: story-y\nstatus: desenvolver\n---\ncorpo\n`);
    baseSha = await commitAll("base");
    await git(`branch stage ${baseSha}`);

    // The run advances the card. Nothing is ever landed on `main` here, so GIT would answer `absent` — which
    // is exactly the false negative that costs $13, and exactly what the receipt overrides.
    await git(`checkout -q -b ${BRANCH} ${baseSha}`);
    await write(CARD, `---\nid: story-y\nstatus: entregue\n---\ncorpo\n`);
    await commitAll("run: avança o card");
    await git(`checkout -q main`);
  });

  afterAll(async () => {
    delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;
    await fsp.rm(path.join(stateDir, "landings.jsonl"), { force: true });
  });

  it("SEM recibo ⇒ cai no git (que aqui diz absent) — a ausência NUNCA vira prova", async () => {
    // Todo run anterior a este ledger está nesta situação. Se a ausência fosse lida como `absent`, o
    // branch-gc apagaria o histórico inteiro no primeiro boot.
    const v = await branchWorkLandedBySplit(exec, repo, BRANCH);
    expect(v.data).toBe("absent");
    expect(v.detail).not.toMatch(/recibo/);
  });

  it("COM recibo ⇒ landed, mesmo com o git dizendo absent, e SEM medir git (o ganho de custo)", async () => {
    const { recordLanding } = await import("./landings");
    await recordLanding({ runId: RUN_ID, board: "b", cardId: "story-y", half: "data", ref: "main", sha: baseSha });

    const cmds: string[] = [];
    const spyExec: ExecFn = async (cmd, opts) => {
      cmds.push(cmd);
      return exec(cmd, opts);
    };

    const v = await branchWorkLandedBySplit(spyExec, repo, BRANCH);
    // Prova POSITIVA, do único testemunho que existiu — e o git, sozinho, diria o contrário.
    expect(v.data).toBe("landed");
    expect(v.detail).toMatch(/recibo/);
    // NÃO-CHAMADA: nenhuma das camadas caras rodou para essa metade. O recibo não é só mais correto, é grátis.
    expect(cmds.filter((c) => c.includes("--is-ancestor"))).toHaveLength(0);
    expect(cmds.filter((c) => c.includes("patch-id"))).toHaveLength(0);
    expect(cmds.filter((c) => c.includes("diff --quiet"))).toHaveLength(0);
  });

  it("recibo de metade VAZIA ⇒ n/a (não landed, não absent): é fato sobre o RUN, não sobre o alvo", async () => {
    const { recordLanding } = await import("./landings");
    await recordLanding({ runId: RUN_ID, board: "b", half: "code", ref: "stage", sha: null, empty: true });
    const v = await branchWorkLandedBySplit(exec, repo, BRANCH);
    expect(v.code).toBe("n/a");
  });

  it("ledger corrompido ⇒ tratado como ausente ⇒ fallback pro git; nunca derruba o train", async () => {
    await fsp.writeFile(path.join(stateDir, "landings.jsonl"), "{lixo truncado\nnão-json\n", "utf8");
    const v = await branchWorkLandedBySplit(exec, repo, BRANCH);
    expect(v.data).toBe("absent"); // o veredito conservador de hoje, não uma exceção
  });
});

// ── Follow-up A (deploy-truth) — rangeLandedBySplit: a MESMA régua por metades sobre um RANGE explícito
// (o commitRange durável do card — branch morto, recibo inderivável). Sem run-base, sem recibo: WS-1 puro.
describePosix("rangeLandedBySplit (git real) — o irmão por RANGE da régua particionada", () => {
  let tmpRoot: string;
  let repo: string;
  let baseSha: string;
  let ex: ExecFn;

  const git = async (cmd: string) => (await ex(`git ${cmd}`, { cwd: repo })).stdout.trim();
  const write = async (file: string, body: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fsp.writeFile(path.join(repo, file), body);
  };
  const commit = async (file: string, body: string, msg: string) => {
    await write(file, body);
    await git(`add -A`);
    await git(`commit -q --no-verify -m ${JSON.stringify(msg)}`);
    return git(`rev-parse HEAD`);
  };

  const CODE_A = "export const a = 1;\n";
  const CARD1_V2 = "# card v2\n";
  const CARD2_V1 = "# card2 v1\n";

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-range-split-"));
    ex = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmpRoot);
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(repo, { recursive: true });
    await git(`init -q -b main`);
    await git(`config user.email t@t.dev`);
    await git(`config user.name tester`);
    await write("packages/app/x.ts", "export const x = 1;\n");
    await write("storymap/boards/acme/cards/story-1.md", "# card v1\n");
    await git(`add -A`);
    await git(`commit -q --no-verify -m base`);
    baseSha = await git(`rev-parse HEAD`);

    // O range MISTO — UM commit tocando código E board-data (a forma real do commit de run).
    await git(`checkout -q -b mixed ${baseSha}`);
    await write("packages/app/a.ts", CODE_A);
    await write("storymap/boards/acme/cards/story-1.md", CARD1_V2);
    await git(`add -A`);
    await git(`commit -q --no-verify -m "run: código+dados"`);

    // Range de board-data PURO (a maioria real dos commitRange vivos).
    await git(`checkout -q -b dataonly ${baseSha}`);
    await commit("storymap/boards/acme/cards/story-2.md", CARD2_V1, "run: só board-data");

    // `stage` (codeRef DEFAULT): DIVERGE e então recebe a metade de CÓDIGO de `mixed` como o train a aplica
    // — patch reaplicado + commit novo (sha e patch-id diferentes do commit misto original).
    await git(`checkout -q -b stage ${baseSha}`);
    await commit("packages/app/stage-only.ts", "export const s = 1;\n", "chore: stage avançou");
    await commit("packages/app/a.ts", CODE_A, "train: metade de código de mixed");

    // `main` (dataRef DEFAULT): idem para a metade de DADOS de `mixed`.
    await git(`checkout -q main`);
    await commit("storymap/boards/acme/other.md", "# outro\n", "chore: main avançou");
    await commit("storymap/boards/acme/cards/story-1.md", CARD1_V2, "train: metade de dados de mixed");

    // main que NUNCA recebeu dado nenhum dos ranges.
    await git(`checkout -q -b main-absent ${baseSha}`);
    await commit("storymap/boards/acme/unrelated.md", "# u\n", "chore: outro trabalho");

    // main que recebeu o conteúdo de `dataonly`.
    await git(`checkout -q -b main-t3 ${baseSha}`);
    await commit("storymap/boards/acme/unrelated2.md", "# u2\n", "chore: diverge");
    await commit("storymap/boards/acme/cards/story-2.md", CARD2_V1, "train: metade de dados de dataonly");
    await git(`checkout -q main`);
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("range data-only cuja metade de dados aterrissou em main ⇒ {code: n/a, data: landed} — a prova da classe-limbo", async () => {
    const res = await rangeLandedBySplit(ex, repo, { range: { base: baseSha, head: "dataonly" }, dataRef: "main-t3" });
    expect(res).toEqual({ code: "n/a", data: "landed" });
  });

  it("a metade de código VAZIA é `n/a` SEM depender do codeRef existir (a metade vazia nunca chega ao git)", async () => {
    const res = await rangeLandedBySplit(ex, repo, {
      range: { base: baseSha, head: "dataonly" },
      codeRef: "ref-que-nao-existe",
      dataRef: "main-t3",
    });
    expect(res.code).toBe("n/a");
    expect(res.data).toBe("landed");
  });

  it("range MISTO com as duas metades aplicadas pelo train ⇒ {landed, landed} — mesma resposta da régua por branch", async () => {
    const res = await rangeLandedBySplit(ex, repo, { range: { base: baseSha, head: "mixed" } });
    expect(res).toEqual({ code: "landed", data: "landed" });
  });

  it("dados NÃO aterrissados ⇒ {code: n/a, data: absent} — conservador, nunca prova por ausência", async () => {
    const res = await rangeLandedBySplit(ex, repo, { range: { base: baseSha, head: "dataonly" }, dataRef: "main-absent" });
    expect(res).toEqual({ code: "n/a", data: "absent" });
  });

  it("range VAZIO (base == head) ⇒ {absent, absent} — a doutrina do range vazio, nunca um landed vácuo", async () => {
    const res = await rangeLandedBySplit(ex, repo, { range: { base: baseSha, head: baseSha } });
    expect(res).toEqual({ code: "absent", data: "absent" });
  });

  it("ref que não resolve / range incompleto ⇒ {unknown, unknown} — falha não é resposta", async () => {
    await expect(rangeLandedBySplit(ex, repo, { range: { base: baseSha, head: "nao-existe" } })).resolves.toEqual({
      code: "unknown",
      data: "unknown",
    });
    await expect(rangeLandedBySplit(ex, repo, { range: { base: "", head: "mixed" } })).resolves.toEqual({
      code: "unknown",
      data: "unknown",
    });
  });
});
