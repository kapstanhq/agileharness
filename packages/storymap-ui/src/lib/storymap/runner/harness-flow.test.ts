// END-TO-END autorun FLOW journeys — the TOP of the test pyramid (few, high-value). Each drives ONE
// card through the REAL plumbing (the `decideCascade` kernel, the serial merge train over real git, the
// split code→stage / data→main, and the `promoteStageToMain` release) with the LLM skill execution
// STUBBED by a scripted effect map. They cover the INTEGRATION/SEQUENCING failures the strong per-unit
// suites miss: a stale-stage clobber, a merge conflict losing work, a crash mid-merge, a red gate.
//
// See harness-flow-env.ts for the harness design. 100% deterministic, real git in os.tmpdir(), no LLM.

import { afterEach, expect, it } from "vitest";
import { FIXTURE_BOARD } from "@/lib/storymap/board-fixture";
import { describePosix } from "./test-platform";
import { makeFlowHarness, type Harness, type SkillEffect } from "./harness-flow-env";
import { makeMergeQueue, type MergeQueueStore } from "./merge-queue";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import { findRepoRoot } from "@/lib/storymap/paths";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import type { ExecFn } from "./worktree";
import type { MergeQueueEntry } from "./types";

// The scripted skill effects for a code card's build cascade. Each mirrors the real harness-* skill's
// observable contract: it edits the card (board data) and/or writes product code, then advances the card
// to the next column (the skill's own end-of-run advance). NO LLM, NO network — pure deterministic edits.
const CODE_EFFECTS: Partial<Record<string, SkillEffect>> = {
  // harness-do: write product code under packages/** + advance desenvolver → revisar-codigo. This run BEARS
  // CODE, so its branch is SPLIT by the train (code → stage, data → main).
  "harness-do": async ({ writeFile }) => {
    await writeFile("packages/storymap-ui/src/feature.ts", "export const feature = () => 'shipped';\n");
    return "revisar-codigo";
  },
  // harness-review: board-data-only (no code) — advance revisar-codigo → qa-automatizado. Merges whole to main.
  "harness-review": () => "qa-automatizado",
  // harness-qa: stamp qaPassed + advance qa-automatizado → revisao. Board-data-only → merges whole to main.
  "harness-qa": ({ card }) => {
    card.qaPassed = true;
    return "revisao";
  },
};

describePosix("flow journey — code card: dev → review → qa → approve → split → publicar/deploy (no clobber)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("integrates the run (code→stage, data→main), rests at release, promotes on Deploy and WAITS for the settle (deploy-truth), never clobbers the sentinel, leaves no orphan worktree", async () => {
    h = await makeFlowHarness({
      storyType: "chore", // a chore skips the UI-design block — keeps the journey focused on build→integrate
      startStatus: "desenvolver",
      effects: CODE_EFFECTS,
    });

    // Sentinel + existing code present on main BEFORE the flow (the clobber canary).
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/sentinel.ts")).toContain("SENTINEL = 1");

    // --- HOP 1: harness-do (manual column "Desenvolver") writes code + advances to revisar-codigo. -------
    const doEv = await h.runSkill("harness-do");
    expect(doEv.to).toBe("revisar-codigo");
    expect(doEv.enqueued).toBe(true);
    expect(h.card.status).toBe("revisar-codigo");
    // SPLIT happened: the CODE landed on `stage` (held for release), ABSENT from main.
    expect(await h.fileAt("stage", "packages/storymap-ui/src/feature.ts")).toContain("shipped");
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/feature.ts")).toBe("");
    // The card DATA (the advance) landed on main so the live board keeps moving.
    expect(await h.fileAt(h.baseBranch, `storymap/boards/${FIXTURE_BOARD}/cards/story-flow.md`)).toContain("revisar-codigo");
    // The train stamped the card staged (Fase 4b gate hasStaged).
    expect(h.card.stagedAt).toBeTruthy();
    // The merge-back fired the cascade hook (the re-trigger signal) for the integrated run.
    expect(h.mergeDone.length).toBeGreaterThanOrEqual(1);

    // --- HOP 2: harness-review (manual) — board-data-only, merges whole to main, advances to qa. ---------
    const reviewEv = await h.runSkill("harness-review");
    expect(reviewEv.to).toBe("qa-automatizado");
    expect(h.card.status).toBe("qa-automatizado");

    // --- HOP 3: harness-qa stamps qaPassed + advances to revisao (the human-approve landing). -----------
    const qaEv = await h.runSkill("harness-qa");
    expect(qaEv.to).toBe("revisao");
    expect(h.card.qaPassed).toBe(true);

    // --- HOP 4: human approves in revisao → collect in Publicar (merge). The cascade integrates and
    // auto-forwards merge → stage (Homologar) → release (Liberar), then RESTS — ADR-059 collapsed the
    // delivery tail into ONE "Publicar" column where merge/stage are automatic passages and `release` is
    // the autorun:false "pronto-mas-ainda-não-no-ar" resting point: code is on `stage`, NOT yet promoted
    // to main (that happens on the Deploy click, HOP5). The #36 homologation parada was removed. --------
    await h.setStatus("merge");
    const trace = await h.drive();
    // The cascade auto-forwards through BOTH automatic passages (Homologar + Liberar).
    expect(trace.some((e) => e.kind === "forward" && e.to === "stage")).toBe(true);
    expect(trace.some((e) => e.kind === "forward" && e.to === "release")).toBe(true);
    // It RESTS at `release` (Liberar) — autorun:false, the ready-but-not-live state. It must NEVER
    // auto-forward into `deploy` (that is the human Deploy click, touch #2).
    expect(trace.at(-1)).toMatchObject({ kind: "stop", at: "release" });
    expect(trace.some((e) => e.kind === "forward" && e.to === "deploy")).toBe(false);
    // promote did NOT fire on the auto-forward (ADR-059 refinement: promote happens on the Deploy click,
    // not before) — the code is held on `stage`, ABSENT from main, and the card is NOT releasedAt yet.
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/feature.ts")).toBe("");
    expect(h.card.releasedAt).toBeFalsy();

    // --- HOP 5: the DEPLOY click (touch #2) → moving to Publicar (`deploy`) fires the promote-and-deploy
    // CHAIN: promote stage→main FIRST (the harness exercises the promote half; deploy-board shells out and
    // is out of scope), stamping releasedAt. deploy-truth WS-3: the card now WAITS here ("Publicando") —
    // the terminal is SETTLE-GATED (gate hasDeployProof on `concluida`), never optimistic: only the settle
    // handler (settleDeploySuccess, unit-covered in deploy-reconcile.test.ts) measures the ancestry proof,
    // stamps deployProof and advances deploy → concluida through the gated path. ----------------------
    const deployEffect = await h.setStatus("deploy");
    expect(deployEffect).toBe("promote-and-deploy");
    // NOW the staged CODE is LIVE on main and the card is stamped releasedAt (the promote half ran).
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/feature.ts")).toContain("shipped");
    expect(h.card.releasedAt).toBeTruthy();
    // The cascade must NOT advance the card out of `deploy` on its own (the old optimistic
    // autoEnterTerminal forward is unwired): it STOPS manual at `deploy`, waiting for the settle.
    const deployTrace = await h.drive();
    expect(deployTrace.some((e) => e.kind === "forward" && e.to === "concluida")).toBe(false);
    expect(deployTrace.at(-1)).toMatchObject({ kind: "stop", at: "deploy" });
    expect(h.card.status).toBe("deploy");

    // --- INVARIANTS: nothing clobbered, no orphan worktrees. ----------------------------------------
    // The SENTINEL + the pre-existing code survived the entire flow intact (the 2026-06 clobber canary).
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/sentinel.ts")).toContain("SENTINEL = 1");
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/existing.ts")).toContain("existing = 'main'");
    // No leftover run/* branches (each integrated run branch is deleted by the train).
    const branches = (await h.git("branch --format=%(refname:short)")).stdout.split("\n").map((b) => b.trim());
    expect(branches.some((b) => b.startsWith("run/"))).toBe(false);
    // Only main + the persistent stage worktree remain — no orphan run worktrees under .worktrees/.
    const worktrees = await h.worktreeList();
    expect(worktrees.every((w) => !w.includes(`${path.sep}.worktrees${path.sep}run-`))).toBe(true);
  }, 30_000); // journey: multiple real-git run→split→merge→release cycles — generous under parallel load
});

describePosix("flow journey — stale-stage release is a no-op, NEVER clobbers main (incident 2026-06)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it("a release with main ahead of stage on packages/** does not delete main's newer code; sentinel survives", async () => {
    h = await makeFlowHarness({ storyType: "chore", startStatus: "desenvolver", effects: CODE_EFFECTS });

    // Run harness-do so there IS a `stage` branch carrying some staged code.
    await h.runSkill("harness-do");
    expect(await h.fileAt("stage", "packages/storymap-ui/src/feature.ts")).toContain("shipped");

    // NOW main gains NEWER code on packages/** that stage has never seen (a direct code commit to main —
    // exactly the drift that made the stale stage's `main..stage` patch revert main's newer code).
    await h.git("checkout -q " + h.baseBranch);
    const abs = path.join(h.mainRepo, "packages", "storymap-ui", "src", "newer.ts");
    await fsp.writeFile(abs, "export const newer = 'main-only-99';\n");
    // Also mutate the sentinel ON MAIN so the staged (older) snapshot diverges from it.
    await fsp.writeFile(
      path.join(h.mainRepo, "packages", "storymap-ui", "src", "sentinel.ts"),
      "export const SENTINEL = 2; // bumped on main\n",
    );
    await h.git("add -A");
    await h.git('commit -q --no-verify -m "main: newer code stage lacks"');

    // Human publishes: the Deploy click → enter `deploy` → promote-and-deploy (ADR-059: promote happens
    // on Deploy, not on `release`). The merge-base clobber-guard must make this a clean no-op for the
    // already-staged feature (it is an ancestor of main now) — and must NEVER revert main's newer code or
    // the bumped sentinel.
    await h.setStatus("deploy");

    // main's newer code is intact (the bug deleted exactly this kind of file).
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/newer.ts")).toContain("main-only-99");
    // The sentinel keeps main's NEWER value — the stale stage's older snapshot did NOT clobber it.
    expect(await h.fileAt(h.baseBranch, "packages/storymap-ui/src/sentinel.ts")).toContain("SENTINEL = 2");
    // The originally-staged feature is still present (it had already landed on stage; release is idempotent).
    expect(await h.fileAt("stage", "packages/storymap-ui/src/feature.ts")).toContain("shipped");
  }, 30_000);
});

// The remaining journeys drive the REAL merge train directly over a temp repo (the same real-git pattern
// as split-integration.test.ts / release.test.ts) for the sequencing scenarios where two runs interact or
// a crash interrupts integration — the harness above models ONE card's happy cascade; these model the
// train's correctness under contention/crash. A shared minimal repo factory keeps them readable.

/** In-memory merge-queue store (DI) so the entry lifecycle is observable without disk. */
function memStore(): MergeQueueStore & { read: () => MergeQueueEntry[] } {
  let saved: MergeQueueEntry[] = [];
  return {
    load: async () => saved.map((e) => ({ ...e })),
    persist: async (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
    read: () => saved,
  };
}

async function makeTrainRepo(prefix: string) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const exec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmpRoot);
  await ensureRunnerStateDir();
  const mainRepo = path.join(tmpRoot, "main");
  await fsp.mkdir(path.join(mainRepo, "storymap", "boards", FIXTURE_BOARD, "cards"), { recursive: true });
  await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
  await fsp.copyFile(
    path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
    path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
  );
  await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
  // SENTINEL on main before any run — the clobber canary for these train journeys too.
  await fsp.writeFile(path.join(mainRepo, "storymap", "boards", FIXTURE_BOARD, "cards", "sentinel.md"), "SENTINEL\n");
  const git = async (args: string, cwd: string = mainRepo) => {
    try {
      const { stdout } = await exec(`git ${args}`, { cwd });
      return { stdout, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; code?: number };
      return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
    }
  };
  await git("init -q");
  await git("config user.email t@t.dev");
  await git("config user.name tester");
  // Higiene defensiva contra escritor de FUNDO durante o teardown. Um `ENOTEMPTY: rmdir '<tmp>/main'`
  // derrubou o CI do artefato publicado em 2026-08-25 (runner do GitHub; nesta VPS nunca abriu).
  //
  // ⚠️ O ESCRITOR NÃO FOI IDENTIFICADO, e é honesto dizer isso em vez de inventar. `gc --auto` é o
  // suspeito óbvio e provavelmente NÃO é o culpado aqui: ele só dispara acima de ~6700 objetos
  // soltos, e estes repositórios têm dezenas. Estas duas linhas custam nada e fecham a classe
  // "manutenção em background", mas quem fecha a falha OBSERVADA é o retry do `rm` no cleanup —
  // esse sim provado (spike: sem retry ⇒ ENOTEMPTY; com retry ⇒ remove, contra escritor transitório).
  // Se o ENOTEMPTY voltar, o suspeito seguinte é maquinário do próprio harness ainda escrevendo
  // depois do teste resolver, e aí o conserto é esperar por ele, não retentar mais.
  await git("config gc.auto 0");
  await git("config maintenance.auto false");
  await git("add -A");
  await git("commit -q --no-verify -m base");
  const baseBranch = (await git("rev-parse --abbrev-ref HEAD")).stdout.trim();
  // Helper: create a run branch that edits `file` to `content` (board DATA path so it merges whole to main).
  const makeRunBranch = async (name: string, file: string, content: string) => {
    await git(`checkout -q -b ${name}`);
    const abs = path.join(mainRepo, file);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
    await git("add -A");
    await git(`commit -q --no-verify -m "${name} work"`);
    await git(`checkout -q ${baseBranch}`);
  };
  const cleanup = async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  };
  return { tmpRoot, mainRepo, exec, git, baseBranch, makeRunBranch, cleanup };
}

describePosix("flow journey — merge conflict: the run PARKS, never silently loses work or corrupts main", () => {
  it("two runs touching the SAME file: the 2nd conflicts → PARKS as `conflict`, branch preserved, main pristine", async () => {
    const repo = await makeTrainRepo("sm-flow-conflict-");
    try {
      const store = memStore();
      // No `trigger` on the entries → the train cannot re-drive (canRedrive false) → it PARKS the
      // conflicting entry (the fail-closed path), never silently drops the work. Board-data → whole-merge.
      const mq = makeMergeQueue({
        repoRoot: repo.mainRepo,
        exec: repo.exec,
        store,
        persistDiffSnapshot: async () => {},
      });

      // Two runs edit the SAME card file to DIFFERENT content from a common base → textual conflict.
      await repo.makeRunBranch("run/a", `storymap/boards/${FIXTURE_BOARD}/cards/c.md`, "# card\nstatus: from-a\n");
      await repo.makeRunBranch("run/b", `storymap/boards/${FIXTURE_BOARD}/cards/c.md`, "# card\nstatus: from-b\n");

      await mq.enqueueMerge({ runId: "a", board: "storymap", cardId: "c", branch: "run/a" });
      await mq.enqueueMerge({ runId: "b", board: "storymap", cardId: "d", branch: "run/b" }); // DISTINCT card (else the supersede invariant would finalize a)
      await mq.whenIdle();

      const entries = store.read();
      const a = entries.find((e) => e.runId === "a")!;
      const b = entries.find((e) => e.runId === "b")!;
      // The first run merged cleanly; the second conflicts and PARKS (never auto-dropped). The FIFO drains
      // the rest past a parked entry — here b is the last, so it simply parks.
      expect(a.status).toBe("done");
      expect(b.status).toBe("conflict");
      // The conflicting branch is PRESERVED (its work survives for the operator) — not force-deleted.
      const bBranch = (await repo.git("rev-parse --verify --quiet run/b")).code === 0;
      expect(bBranch).toBe(true);
      // main is PRISTINE after the conflict (the merge was aborted) — no conflict markers, no corruption.
      const mainCard = await repo.git(`show ${repo.baseBranch}:storymap/boards/${FIXTURE_BOARD}/cards/c.md`);
      expect(mainCard.stdout).not.toContain("<<<<<<<");
      expect(mainCard.stdout).toContain("from-a"); // run/a's work is the integrated state
      const status = await repo.git("status --porcelain");
      expect(status.stdout.trim()).toBe(""); // working tree clean — no half-merge left behind
      // SENTINEL untouched.
      expect((await repo.git(`show ${repo.baseBranch}:storymap/boards/${FIXTURE_BOARD}/cards/sentinel.md`)).stdout).toContain("SENTINEL");
    } finally {
      await repo.cleanup();
    }
  }, 20_000);
});

describePosix("flow journey — restart mid-merge: recover() finishes the integration, no double-merge, card consistent", () => {
  it("a `merging` entry whose branch already landed is resumed to `done` (idempotent), no orphan, sentinel intact", async () => {
    const repo = await makeTrainRepo("sm-flow-recover-");
    try {
      // First boot: integrate run/a cleanly, then SIMULATE a crash by persisting a SECOND entry stuck at
      // `merging` whose branch the (crashed) process had ALREADY merged into main — the exact mid-merge
      // window where only the final `done` persist was lost. recover() must mark it done idempotently.
      const store = memStore();

      // run/a integrates cleanly on the first boot.
      await repo.makeRunBranch("run/a", `storymap/boards/${FIXTURE_BOARD}/cards/c.md`, "# card\nstatus: a-done\n");
      const mq1 = makeMergeQueue({ repoRoot: repo.mainRepo, exec: repo.exec, store, persistDiffSnapshot: async () => {} });
      await mq1.enqueueMerge({ runId: "a", board: "storymap", cardId: "c", branch: "run/a" });
      await mq1.whenIdle();
      expect(store.read().find((e) => e.runId === "a")?.status).toBe("done");

      // run/b's work is ALREADY on main (its merge landed) but its entry is stuck `merging` (crash before
      // the `done` persist). Merge it by hand to model "branch already an ancestor of HEAD".
      await repo.makeRunBranch("run/b", `storymap/boards/${FIXTURE_BOARD}/cards/d.md`, "# card\nstatus: b-done\n");
      await repo.git("merge --no-ff --no-edit run/b");
      // Persist the crashed-state queue: run/b stuck `merging`, branch still present.
      await store.persist([
        { runId: "a", board: "storymap", cardId: "c", branch: "run/a", status: "done", enqueuedAt: 1 },
        { runId: "b", board: "storymap", cardId: "d", branch: "run/b", status: "merging", enqueuedAt: 2 },
      ]);

      // Second boot: a FRESH queue over the SAME store recovers.
      const mergeDone: Array<{ cardId: string }> = [];
      const mq2 = makeMergeQueue({ repoRoot: repo.mainRepo, exec: repo.exec, store, persistDiffSnapshot: async () => {} });
      mq2.onMergeDone((ev) => mergeDone.push({ cardId: ev.cardId }));
      const rec = await mq2.recover();
      await mq2.whenIdle();

      // The interrupted entry is resumed to `done` (NOT re-merged — its branch was already an ancestor).
      expect(rec.resumed).toBeGreaterThanOrEqual(1);
      expect(store.read().find((e) => e.runId === "b")?.status).toBe("done");
      // recover() fired the cascade hook for the completed integration (so the card doesn't strand).
      expect(mergeDone.some((m) => m.cardId === "d")).toBe(true);
      // No double-merge: HEAD has exactly ONE merge commit for run/b (recover didn't merge it again).
      const log = (await repo.git("log --oneline")).stdout;
      const bMerges = log.split("\n").filter((l) => /Merge branch ['"]?run\/b/.test(l)).length;
      expect(bMerges).toBe(1);
      // run/b branch cleaned up (no orphan); both cards' data consistent on main.
      expect((await repo.git("rev-parse --verify --quiet run/b")).code).not.toBe(0);
      expect((await repo.git(`show ${repo.baseBranch}:storymap/boards/${FIXTURE_BOARD}/cards/d.md`)).stdout).toContain("b-done");
      // SENTINEL intact through the crash/recover.
      expect((await repo.git(`show ${repo.baseBranch}:storymap/boards/${FIXTURE_BOARD}/cards/sentinel.md`)).stdout).toContain("SENTINEL");
    } finally {
      await repo.cleanup();
    }
  }, 20_000);
});

describePosix("flow journey — red integration gate PARKS the failing run; the rest drains; retry integrates it", () => {
  it("a failing gate PARKS the run; the rest DRAINS past it; retry→pass integrates the parked run", async () => {
    const repo = await makeTrainRepo("sm-flow-gate-");
    try {
      const store = memStore();
      // Both runs touch CODE (packages/**) so the gate actually runs (board-data-only runs skip it).
      await repo.makeRunBranch("run/a", "packages/storymap-ui/src/a.ts", "export const a = 1;\n");
      await repo.makeRunBranch("run/b", "packages/storymap-ui/src/b.ts", "export const b = 2;\n");

      // The fake gate fails run/a the FIRST time it sees it, then passes (models a flake the operator
      // re-drove). run/b always passes. The gate verdict is controlled per-branch + per-attempt.
      // G5 (agora também para RUNS): o gate recebe o SHA PINADO na porta do enqueue, não o nome do branch —
      // o veredito cobre exatamente o que o merge aterrissa, imune a renames de teardown (falso-done 94bfdb77).
      const aSha = (await repo.git("rev-parse run/a")).stdout.trim();
      let aSeen = 0;
      const mq = makeMergeQueue({
        repoRoot: repo.mainRepo,
        exec: repo.exec,
        store,
        gateEnabled: true,
        integrationGate: async ({ branch }) => {
          if (branch === aSha || branch === "run/a") {
            aSeen += 1;
            return aSeen === 1 ? { passed: false, log: "FAIL: 1 failed | 9 passed" } : { passed: true, log: "10 passed" };
          }
          return { passed: true, log: "10 passed" };
        },
        // Staging OFF here so a passing code run merges WHOLE into main (simpler assert that the gate, not
        // the split, governs); the split path has its own dedicated journey above.
        persistDiffSnapshot: async () => {},
        addGateBlocker: async () => {},
      });

      await mq.enqueueMerge({ runId: "a", board: "storymap", cardId: "c", branch: "run/a", trigger: "harness-do" });
      await mq.enqueueMerge({ runId: "b", board: "storymap", cardId: "d", branch: "run/b", trigger: "harness-do" });
      await mq.whenIdle();

      // run/a failed the gate and PARKED; run/b DRAINS past it (parking, not head-of-line) → merges to main.
      let entries = store.read();
      expect(entries.find((e) => e.runId === "a")?.status).toBe("gate-failed");
      expect(entries.find((e) => e.runId === "b")?.status).toBe("done"); // drained past the parked head
      // run/a's code is NOT on main (parked); run/b's code IS (it drained past the parked head).
      expect((await repo.git("show " + repo.baseBranch + ":packages/storymap-ui/src/a.ts")).code).not.toBe(0);
      expect((await repo.git("show " + repo.baseBranch + ":packages/storymap-ui/src/b.ts")).stdout).toContain("b = 2");

      // Operator RETRIES the parked run → the gate runs again, passes, and run/a integrates (b already drained).
      await mq.resolveGateFailed("a", "retry");
      await mq.whenIdle();

      entries = store.read();
      expect(entries.find((e) => e.runId === "a")?.status).toBe("done");
      expect(entries.find((e) => e.runId === "b")?.status).toBe("done");
      // BOTH runs' code is now on main (the train drained in order after the resolve).
      expect((await repo.git("show " + repo.baseBranch + ":packages/storymap-ui/src/a.ts")).stdout).toContain("a = 1");
      expect((await repo.git("show " + repo.baseBranch + ":packages/storymap-ui/src/b.ts")).stdout).toContain("b = 2");
      // SENTINEL intact.
      expect((await repo.git(`show ${repo.baseBranch}:storymap/boards/${FIXTURE_BOARD}/cards/sentinel.md`)).stdout).toContain("SENTINEL");
    } finally {
      await repo.cleanup();
    }
  }, 20_000);

  it("abort on the failed gate drops that run but lets the rest of the train drain", async () => {
    const repo = await makeTrainRepo("sm-flow-gate-abort-");
    try {
      const store = memStore();
      await repo.makeRunBranch("run/a", "packages/storymap-ui/src/a.ts", "export const a = 1;\n");
      await repo.makeRunBranch("run/b", "packages/storymap-ui/src/b.ts", "export const b = 2;\n");
      // G5 para runs: o gate vê o SHA pinado (ver nota no teste acima).
      const aSha = (await repo.git("rev-parse run/a")).stdout.trim();
      const mq = makeMergeQueue({
        repoRoot: repo.mainRepo,
        exec: repo.exec,
        store,
        gateEnabled: true,
        integrationGate: async ({ branch }) =>
          branch === aSha || branch === "run/a" ? { passed: false, log: "FAIL" } : { passed: true, log: "ok" },
        persistDiffSnapshot: async () => {},
        addGateBlocker: async () => {},
      });
      await mq.enqueueMerge({ runId: "a", board: "storymap", cardId: "c", branch: "run/a", trigger: "harness-do" });
      await mq.enqueueMerge({ runId: "b", board: "storymap", cardId: "d", branch: "run/b", trigger: "harness-do" });
      await mq.whenIdle();
      expect(store.read().find((e) => e.runId === "a")?.status).toBe("gate-failed");

      // Operator ABORTS the failed run → it's dropped (failed, branch deleted), the train drains run/b.
      await mq.resolveGateFailed("a", "abort");
      await mq.whenIdle();
      expect(store.read().find((e) => e.runId === "a")?.status).toBe("failed");
      expect(store.read().find((e) => e.runId === "b")?.status).toBe("done");
      // run/a's code never reached main; run/b's did.
      expect((await repo.git("show " + repo.baseBranch + ":packages/storymap-ui/src/a.ts")).code).not.toBe(0);
      expect((await repo.git("show " + repo.baseBranch + ":packages/storymap-ui/src/b.ts")).stdout).toContain("b = 2");
    } finally {
      await repo.cleanup();
    }
  }, 20_000);
});
