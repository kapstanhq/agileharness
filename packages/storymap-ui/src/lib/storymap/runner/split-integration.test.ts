// Fase 4a SPLIT — REAL-git integration test (mirrors worktree-provisioning.test.ts's real-repo pattern).
// The unit tests in merge-queue.test.ts mock `exec`; this drives the ACTUAL merge queue over real git in
// a throwaway repo, so it validates the live mechanic end-to-end: a run touching CODE (`packages/**`) is
// split — code lands on the `stage` branch, board data on main — exactly as it now runs in prod.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { describePosix } from "./test-platform";
import { makeMergeQueue, type MergeQueueStore } from "./merge-queue";
import { findRepoRoot } from "@/lib/storymap/paths";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import type { ExecFn } from "./worktree";
import type { MergeQueueEntry } from "./types";
import type { CardStatusOnDisk, Transition } from "./transitions";
import { withCardLock } from "@/lib/storymap/write";

// Worktree-fragility guard: this real-git suite drives the split path directly, so it skips the runner
// boot that creates runnerStateDir() (where the split writes its data/code patches) and runs against
// whatever git context vitest's cwd sits in. Inside the merge train's integration gate (a nested git
// worktree) both bite — the split would false-fail with "conflict". `exec` is wrapped to run git in a
// fully isolated env; the temp repo's parent is the ceiling. See git-test-env.ts. Re-bound in beforeAll.
let exec = promisify(nodeExec) as unknown as ExecFn;

/** In-memory store (DI) so the queue lifecycle is observable without touching disk. */
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

const show = async (cwd: string, ref: string) => (await exec(`git show ${ref}`, { cwd })).stdout;

describePosix("integrateSplit (real git) — Fase 4a: code→stage / data→main", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let baseBranch: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-split-"));
    // Isolate every git op from the host/outer-worktree context, and ensure runnerStateDir() exists
    // (the split writes its patches there) — the production runner boot does the latter for us in prod.
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    mainRepo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(mainRepo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "storymap", "cards"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
    // Copy the REAL secret scanner so the split's pre-push rescan runs for real (no secrets → passes).
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "x.ts"), "export const x = 1;\n");
    await fsp.writeFile(path.join(mainRepo, "storymap", "cards", "c.md"), "# card\nstatus: a\n");

    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@example.test`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m base`, { cwd: mainRepo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: mainRepo })).stdout.trim();

    // A run branch that touches BOTH code (packages/**) and board data (storymap/**).
    await exec(`git checkout -q -b run/test`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "x.ts"), "export const x = 2; // changed\n");
    await fsp.writeFile(path.join(mainRepo, "storymap", "cards", "c.md"), "# card\nstatus: b\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run work"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: mainRepo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("splits the run: packages/** → stage, storymap/** → main; run branch deleted; entry done", async () => {
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });

    await mq.enqueueMerge({ runId: "test", board: "x", cardId: "y", branch: "run/test" });
    await mq.whenIdle();

    // The entry integrated cleanly.
    expect(store.read()[0]?.status).toBe("done");
    expect(store.read()[0]?.split).toEqual({ dataLanded: true, codeStaged: true });

    // The throwaway run branch was deleted (its work is split onto main+stage).
    const runExists = await exec(`git rev-parse --verify run/test`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(runExists).toBe(false);

    // CODE landed on `stage` and is ABSENT from main (held for the human release gate).
    expect(await show(mainRepo, "stage:packages/app/x.ts")).toContain("x = 2");
    expect(await show(mainRepo, `${baseBranch}:packages/app/x.ts`)).toContain("x = 1");
    expect(await show(mainRepo, `${baseBranch}:packages/app/x.ts`)).not.toContain("x = 2");

    // DATA (the card advance) landed on main so the live board keeps moving.
    expect(await show(mainRepo, `${baseBranch}:storymap/cards/c.md`)).toContain("status: b");

    // The board-data commit on main carries the `board:` prefix (separable from `usm:` code commits).
    const log = (await exec(`git log --oneline -1 ${baseBranch}`, { cwd: mainRepo })).stdout;
    expect(log).toContain("board:");
  });

  it("a board-data-ONLY run with staging ON integrates via the split (data→main, empty code), NOT a whole-branch merge", async () => {
    // Second run: only storymap/** changes. stale-base fix: with staging on EVERY run goes through the
    // split — a whole-branch merge would LEAK into main the unreleased code a stage-cut run carries. A
    // board-only run lands its data on main and stages no code (empty code delta → the code-empty guard
    // marks codeStaged without touching the stage worktree).
    await exec(`git checkout -q -b run/dataonly`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "storymap", "cards", "c.md"), "# card\nstatus: c\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "data only"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 2000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "dataonly", board: "x", cardId: "z", branch: "run/dataonly" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).toBe("done");
    // It DID enter the split (both halves marked) — but the code half was a no-op (empty code delta).
    expect(store.read()[0]?.split).toEqual({ dataLanded: true, codeStaged: true });
    // The board data still lands on main (now via the data patch, not a whole-branch merge commit).
    expect(await show(mainRepo, `${baseBranch}:storymap/cards/c.md`)).toContain("status: c");
  });

  it("AC1/AC4: two concurrent runs appending to board.yaml each land their entry — union preserved, zero conflict", async () => {
    // AC1: Two runs each appending a DIFFERENT entry to the same YAML list block in board.yaml BOTH
    // end up in main — no conflict marker, no data loss. This mirrors the live ex0079-vs-ex0127 case
    // (AC4): the `merge=union` driver in .gitattributes + the `unionFallback:true` in applyPatch let
    // `git apply --3way` merge the two overlapping list appends cleanly when --check alone fails.
    const gitattributes = [
      "* text=auto eol=lf",
      "storymap/boards/*/board.yaml merge=union",
    ].join("\n") + "\n";
    const initialYaml = "id: test\nlinkTypes:\n  - id: blocks\n    label: Blocks\n";
    await fsp.writeFile(path.join(mainRepo, ".gitattributes"), gitattributes);
    await fsp.mkdir(path.join(mainRepo, "storymap", "boards", "test"), { recursive: true });
    await fsp.writeFile(path.join(mainRepo, "storymap", "boards", "test", "board.yaml"), initialYaml);
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "chore: add gitattributes + base board.yaml"`, { cwd: mainRepo });

    // run/union-a appends one entry to board.yaml.
    await exec(`git checkout -q -b run/union-a`, { cwd: mainRepo });
    await fsp.writeFile(
      path.join(mainRepo, "storymap", "boards", "test", "board.yaml"),
      initialYaml + "  - id: mentions\n    label: Mentions\n",
    );
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run/union-a: add mentions linkType"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    // run/union-b appends a DIFFERENT entry to the SAME block — overlapping context, would normally conflict.
    await exec(`git checkout -q -b run/union-b`, { cwd: mainRepo });
    await fsp.writeFile(
      path.join(mainRepo, "storymap", "boards", "test", "board.yaml"),
      initialYaml + "  - id: duplicates\n    label: Duplicates\n",
    );
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run/union-b: add duplicates linkType"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    // Integrate run-a first (clean --check), then run-b (union fallback).
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 3000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "union-a", board: "test", cardId: "link-a", branch: "run/union-a" });
    await mq.whenIdle();
    await mq.enqueueMerge({ runId: "union-b", board: "test", cardId: "link-b", branch: "run/union-b" });
    await mq.whenIdle();

    const storeEntries = store.read();
    expect(storeEntries[0]?.status).toBe("done");
    expect(storeEntries[1]?.status).toBe("done");

    // Both entries are present in board.yaml on main — union preserved, no conflict marker.
    const finalYaml = (
      await exec(`git show ${baseBranch}:storymap/boards/test/board.yaml`, { cwd: mainRepo })
    ).stdout;
    expect(finalYaml).toContain("id: mentions");
    expect(finalYaml).toContain("id: duplicates");
    expect(finalYaml).not.toContain("<<<<<<<");
    expect(finalYaml).not.toContain("=======");
  });

  it("SYNCS a STALE stage with the released branch before staging code (root-cause fix — no spurious conflict, no clobber)", async () => {
    // The stage branch was created from main at first-stage time (test 1) and never advanced. Now main
    // gains NEW packages/** code DIRECTLY (simulating released/infra code landing on main) → stage is
    // STALE (behind main on a code file it lacks). Pre-fix, the next code run's apply onto the stale stage
    // spuriously conflicted (seen in a past incident). The fix (syncStageWithReleased) merges main's advance into
    // stage BEFORE applying the run's code — preserving the unreleased code already on stage.
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "infra.ts"), "export const infra = 1;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "infra: código novo direto na main (stage não tem)"`, { cwd: mainRepo });

    // A code run integrates → the stale stage must sync first, then stage the run's code, cleanly.
    await exec(`git checkout -q -b run/synctest`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "feature.ts"), "export const feature = 1;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "feature code"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 5000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "synctest", board: "x", cardId: "s", branch: "run/synctest" });
    await mq.whenIdle();

    // Integrated cleanly — the stale stage did NOT spuriously conflict.
    expect(store.read()[0]?.status).toBe("done");
    // stage was SYNCED: it now carries main's infra.ts advance (merged in) AND the run's feature.ts.
    expect(await show(mainRepo, "stage:packages/app/infra.ts")).toContain("infra = 1");
    expect(await show(mainRepo, "stage:packages/app/feature.ts")).toContain("feature = 1");
    // The earlier unreleased staged code is preserved (the sync merged, never reset-discarded it).
    expect(await show(mainRepo, "stage:packages/app/x.ts")).toContain("x = 2");
    // infra.ts stayed on main too — the sync brought it INTO stage, never moved it off main (no clobber).
    expect(await show(mainRepo, `${baseBranch}:packages/app/infra.ts`)).toContain("infra = 1");
  });

  it("corrida rename×fila: ref renomeada p/ failed/run/<id> ainda integra pelo nome preservado — NUNCA done-vazio", async () => {
    // O teardown pode renomear `run/<id>` → `failed/run/<id>` ENQUANTO a entry espera a vez. Pré-fix, o
    // diff sobre a ref sumida lia-se como conjunto VAZIO → as duas metades "aterrissavam vazias" e a entry
    // finalizava `done` com ZERO conteúdo integrado (o falso-done de um run real). O reparo em pick-time
    // (resolveIntegrationSha) segue o rename e PINA o sha antes de qualquer op de conteúdo.
    await exec(`git checkout -q -b run/race`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "race.ts"), "export const race = 1;\n");
    await fsp.writeFile(path.join(mainRepo, "storymap", "cards", "c.md"), "# card\nstatus: race\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "race work"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
    // O rename do teardown acontece ANTES do processamento (entry legada seed sem pinnedSha).
    await exec(`git branch -m run/race failed/run/race`, { cwd: mainRepo });

    const store = memStore();
    await store.persist([
      { runId: "race", board: "x", cardId: "r", branch: "run/race", status: "waiting", enqueuedAt: 1 } as MergeQueueEntry,
    ]);
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 6000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.recover();
    await mq.whenIdle();

    // Integrou DE VERDADE: código no stage, dado no main — nada de done-vazio.
    expect(store.read()[0]?.status).toBe("done");
    expect(store.read()[0]?.split).toEqual({ dataLanded: true, codeStaged: true });
    expect(await show(mainRepo, "stage:packages/app/race.ts")).toContain("race = 1");
    expect(await show(mainRepo, `${baseBranch}:storymap/cards/c.md`)).toContain("status: race");
    // A ref preservada foi consumida pela integração (deletada como qualquer run branch integrada).
    const preservedExists = await exec(`git rev-parse --verify failed/run/race`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(preservedExists).toBe(false);
  });

  it("EVICÇÃO da tentativa superada: redrive do MESMO card sincroniza stage evictando a implementação antiga — sem redrive fútil", async () => {
    // O ciclo: implementação v-OLD do card foi para stage; a released (main) avançou na MESMA
    // região; o redrive nasce da main nova. Pré-fix: "stage não sincroniza" → maybeRedrive → N
    // reimplementações mortas no mesmo muro. Pós-fix: os arquivos cuja história stage-only pertence TODA ao
    // próprio card são evictados (released vence; adições órfãs somem) e o código NOVO aplica limpo.
    const CARD = "story-evold";
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "evict.ts"), "export const v = 1;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "base: evict.ts v1"`, { cwd: mainRepo });

    // Tentativa ANTIGA do card → integra normal (código vai a stage com o cardId no subject do commit).
    await exec(`git checkout -q -b run/evict-old`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "evict.ts"), "export const v = 100; // OLD attempt\n");
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "evict-orphan.ts"), "export const orphan = true;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "usm(${CARD}): código staged (run evict-old) · x/${CARD}"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
    {
      const store = memStore();
      const mq = makeMergeQueue({
        repoRoot: mainRepo,
        exec,
        store,
        now: () => 8000,
        staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
        persistDiffSnapshot: async () => {},
        stampStaged: async () => {},
        addSecretScanBlocker: async () => {},
      });
      await mq.enqueueMerge({ runId: "evict-old", board: "x", cardId: CARD, branch: "run/evict-old" });
      await mq.whenIdle();
      expect(store.read()[0]?.status).toBe("done");
      expect(await show(mainRepo, "stage:packages/app/evict.ts")).toContain("v = 100");
    }

    // A released avança na MESMA região, direto na main (a divergência que causava o problema).
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "evict.ts"), "export const v = 2; // released advance\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "released: evict.ts v2 direto na main"`, { cwd: mainRepo });

    // O REDRIVE nasce da main nova, com a implementação DEFINITIVA.
    await exec(`git checkout -q -b run/evict-new`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "evict.ts"), "export const v = 3; // NEW impl\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "usm(${CARD}): redrive · x/${CARD}"`, { cwd: mainRepo });
    const newBase = (await exec(`git rev-parse HEAD~1`, { cwd: mainRepo })).stdout.trim();
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 9000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "evict-new", board: "x", cardId: CARD, branch: "run/evict-new", baseCommit: newBase });
    await mq.whenIdle();

    // Integrou: a evicção resolveu o sync e o código NOVO aterrissou em stage.
    expect(store.read()[0]?.status).toBe("done");
    expect(await show(mainRepo, "stage:packages/app/evict.ts")).toContain("v = 3");
    expect(await show(mainRepo, "stage:packages/app/evict.ts")).not.toContain("v = 100");
    // A adição órfã da tentativa antiga foi removida de stage.
    const orphan = await exec(`git cat-file -e stage:packages/app/evict-orphan.ts`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(orphan).toBe(false);
    // Trabalho não-liberado ALHEIO em stage permanece intacto (x.ts do primeiro teste).
    expect(await show(mainRepo, "stage:packages/app/x.ts")).toContain("x = 2");
  });

  it("sync-conflict com dono ALHEIO: parqueia com receita acionável (reconcile_stage + requeue) — NUNCA re-driva nem evicta trabalho de outro card", async () => {
    const OWNER = "story-owner1";
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "mixed.ts"), "export const m = 1;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "base: mixed.ts v1"`, { cwd: mainRepo });

    // Tentativa do card OWNER vai a stage.
    await exec(`git checkout -q -b run/mixed-owner`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "mixed.ts"), "export const m = 100; // OWNER\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "usm(${OWNER}): código staged · x/${OWNER}"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
    {
      const store = memStore();
      const mq = makeMergeQueue({
        repoRoot: mainRepo,
        exec,
        store,
        now: () => 10000,
        staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
        persistDiffSnapshot: async () => {},
        stampStaged: async () => {},
        addSecretScanBlocker: async () => {},
      });
      await mq.enqueueMerge({ runId: "mixed-owner", board: "x", cardId: OWNER, branch: "run/mixed-owner" });
      await mq.whenIdle();
      expect(store.read()[0]?.status).toBe("done");
    }

    // Released avança a mesma região; um run de OUTRO card colide no sync.
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "mixed.ts"), "export const m = 2; // released\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "released: mixed.ts v2"`, { cwd: mainRepo });
    await exec(`git checkout -q -b run/mixed-other`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "other.ts"), "export const o = 1;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "usm(story-otherx): trabalho · x/story-otherx"`, { cwd: mainRepo });
    const otherBase = (await exec(`git rev-parse HEAD~1`, { cwd: mainRepo })).stdout.trim();
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 11000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "mixed-other", board: "x", cardId: "story-otherx", branch: "run/mixed-other", baseCommit: otherBase });
    await mq.whenIdle();

    const entry = store.read()[0];
    // Parqueou como conflict com a RECEITA — sem redrive, sem evicção do trabalho do OWNER.
    expect(entry?.status).toBe("conflict");
    expect(entry?.conflictDetail).toContain("reconcile_stage");
    expect(entry?.conflictDetail).toContain("requeue");
    expect(await show(mainRepo, "stage:packages/app/mixed.ts")).toContain("m = 100"); // intacto
  });

  it("diff FALHO nunca vira done-vazio: baseCommit irresolvível finaliza `failed` com NADA integrado", async () => {
    // O guard duro do integrateSplit: um `git diff` que FALHA (base/ref inválida) é uma integração
    // falhada, jamais um conjunto vazio de mudanças. Pré-fix, `!ok` → `[]` → ambas as metades marcadas
    // como vazias → `done` sem conteúdo.
    await exec(`git checkout -q -b run/badbase`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "badbase.ts"), "export const bad = 1;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "badbase work"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    const store = memStore();
    await store.persist([
      {
        runId: "badbase",
        board: "x",
        cardId: "b",
        branch: "run/badbase",
        baseCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // sha inexistente → o diff base..branch FALHA
        status: "waiting",
        enqueuedAt: 1,
      } as MergeQueueEntry,
    ]);
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 7000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.recover();
    await mq.whenIdle();

    const entry = store.read()[0];
    expect(entry?.status).toBe("failed");
    expect(entry?.failureReason).toContain("FALHOU");
    expect(entry?.split ?? {}).not.toEqual({ dataLanded: true, codeStaged: true });
    // Nada aterrissou: o código do run NÃO está no stage.
    const staged = await exec(`git show stage:packages/app/badbase.ts`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(staged).toBe(false);
    // O branch segue preservado para requeue após diagnóstico.
    const branchExists = await exec(`git rev-parse --verify run/badbase`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(branchExists).toBe(true);
  });
});

// story-ex0159 — REAL-git proof the STAGING-OFF whole-branch merge now resolves a divergent binary
// `*.snap` instead of false-parking the CLEAN merge as a content conflict. A run regenerated a golden
// snapshot that diverges from main; `.gitattributes` marks `*.snap binary`, so a plain `git merge --no-ff`
// would ABORT with the snap unmergeable. The fix (mergeWithSnapResolution) does a two-phase merge,
// resolves the snap-only conflict by REGENERATING from the merged source, and lands `done` on main.
describePosix("staging-OFF merge (real git) — story-ex0159: a divergent binary *.snap is regenerated, not false-parked", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let baseBranch: string;
  // The canonical snapshot content `vitest -u` would produce from the merged source (deterministic here).
  const CANONICAL_SNAP = "exports[`pipeline 1`] = `MERGED-CANONICAL`;\n";

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-snapmerge-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    mainRepo = path.join(tmpRoot, "main");
    const snapDir = path.join(mainRepo, "packages", "storymap-ui", "src", "lib", "storymap", "__snapshots__");
    await fsp.mkdir(snapDir, { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    // `.gitattributes` marks *.snap binary — so git refuses to textually merge it (the root cause).
    await fsp.writeFile(path.join(mainRepo, ".gitattributes"), "* text=auto eol=lf\n*.snap binary\n");
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
    // O alvo declara onde moram seus pacotes (workspaces) — de onde sai «em que pacote regenerar o snapshot».
    await fsp.writeFile(path.join(mainRepo, "package.json"), JSON.stringify({ name: "alvo", private: true, workspaces: ["packages/*"] }));
    const snapFile = path.join(snapDir, "board-base-pipeline.test.ts.snap");
    await fsp.writeFile(snapFile, "exports[`pipeline 1`] = `BASE`;\n");

    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@example.test`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m base`, { cwd: mainRepo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: mainRepo })).stdout.trim();
    // Capture the BASE commit BEFORE main advances — the run branch must diverge from HERE so its snap
    // genuinely conflicts with main's later snap (else the merge fast-forwards and no regen is needed).
    const baseSha = (await exec(`git rev-parse HEAD`, { cwd: mainRepo })).stdout.trim();

    // The run branch (cut from the BASE) regenerated the snap one way → committed on the run branch.
    await exec(`git checkout -q -b run/snap ${baseSha}`, { cwd: mainRepo });
    await fsp.writeFile(snapFile, "exports[`pipeline 1`] = `RUN-REGEN`;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run: snap regen"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    // main advances the SAME snap a DIFFERENT way (a prior run regenerated it differently) → now the run
    // branch's binary snap diverges from main's → a plain `git merge --no-ff` would abort on the snap.
    await fsp.writeFile(snapFile, "exports[`pipeline 1`] = `MAIN-ADVANCED`;\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "main: snap advanced"`, { cwd: mainRepo });
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("regenerates the binary snap from the merged source and lands `done` on main (run branch deleted)", async () => {
    const store = memStore();
    // Wrap exec so `bunx vitest run -u` (which we don't really run in a temp repo) WRITES the canonical
    // regenerated snap to disk — exactly what vitest's --update would do from the merged source. Every
    // other git command runs for real against the isolated temp repo.
    const snapFileRel = "packages/storymap-ui/src/lib/storymap/__snapshots__/board-base-pipeline.test.ts.snap";
    const execWithVitest: ExecFn = async (cmd, opts) => {
      if (cmd.includes("bunx vitest run -u")) {
        // The regen runs with cwd = <repo>/packages/storymap-ui; write the snap at the repo-root path.
        await fsp.writeFile(path.join(mainRepo, snapFileRel), CANONICAL_SNAP);
        return { stdout: "", stderr: "" };
      }
      return exec(cmd, opts);
    };
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec: execWithVitest,
      store,
      now: () => 7000,
      // staging UNDEFINED → the staging-OFF whole-branch merge path (the storymap board's real config).
      persistDiffSnapshot: async () => {},
      // No node_modules in the temp repo → a no-op fs so provisioning links nothing.
      snapFs: {
        listDirs: async () => [],
        isDir: async () => false,
        isFile: async () => false,
        // lê o package.json REAL do repo temporário (o alvo declara seus workspaces ali)
        readText: async (p: string) => fsp.readFile(p, "utf8").catch(() => null),
        linkDir: async () => {},
        unlinkDir: async () => false,
      },
    });

    await mq.enqueueMerge({ runId: "snap", board: "storymap", cardId: "story-z", branch: "run/snap" });
    await mq.whenIdle();

    // Integrated cleanly — the divergent binary snap did NOT false-park the merge.
    expect(store.read()[0]?.status).toBe("done");
    expect(store.read()[0]?.conflictDetail).toBeUndefined();

    // The run branch was deleted (work integrated into the merge commit on main).
    const runExists = await exec(`git rev-parse --verify run/snap`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(runExists).toBe(false);

    // main's snap is the REGENERATED canonical content (from the merged source), not a conflict marker.
    const finalSnap = (await exec(`git show ${baseBranch}:${snapFileRel}`, { cwd: mainRepo })).stdout;
    expect(finalSnap).toContain("MERGED-CANONICAL");
    expect(finalSnap).not.toContain("<<<<<<<");
  });
});

// story-ex0120 — REAL-git proof the DATA→MAIN split integrates a card whose FRONTMATTER DIVERGED on both
// sides via a FIELD-LEVEL 3-way merge, instead of the line-based `git apply --3way` that left conflict
// markers and PARKED the card. The run advanced status while a human edited an AUTHORIAL field (title) live
// on main AND moved status differently — a same-region overlap the line-based apply cannot reconcile.
// Structural merge: authorial → main, run-only field never dropped, and (WP5-F1) the LATER status move on
// main wins over the run's old snapshot. (If the carve/merge is removed, the card re-parks as `conflict`.)
describePosix("integrateSplit (real git) — story-ex0120: a both-diverged card frontmatter merges by field", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let baseBranch: string;
  const cardRel = "storymap/boards/testboard/cards/story-r.md";
  const cardAbs = () => path.join(mainRepo, cardRel);

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-ex0120-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    mainRepo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(mainRepo, "storymap", "boards", "testboard", "cards"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
    // BASE card: status priorizar, title base, empty narrative.
    await fsp.writeFile(
      cardAbs(),
      ["---", "id: story-r", "type: story", "title: Título base", "status: priorizar", "---", "", "corpo base", ""].join("\n"),
    );
    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@example.test`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m base`, { cwd: mainRepo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: mainRepo })).stdout.trim();

    // RUN branch (cut from base): a PIPELINE advance (status → desenvolver) + a RUN-ONLY narrative fill.
    await exec(`git checkout -q -b run/rtest`, { cwd: mainRepo });
    await fsp.writeFile(
      cardAbs(),
      [
        "---", "id: story-r", "type: story", "title: Título base", "status: desenvolver",
        "narrative:", "  role: leitor", "  want: achar livros", "  soThat: escolher a próxima leitura",
        "---", "", "corpo base", "",
      ].join("\n"),
    );
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run: pipeline advance + narrative"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });

    // MAIN diverges live: a human edits an AUTHORIAL field (title) AND drags status differently → the same
    // frontmatter region both sides touched, which the line-based `git apply --3way` cannot reconcile.
    await fsp.writeFile(
      cardAbs(),
      ["---", "id: story-r", "type: story", "title: Título humano", "status: pronta", "---", "", "corpo base", ""].join("\n"),
    );
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "main: human authorial edit"`, { cwd: mainRepo });
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  // WP5-F1 — REESCRITO de propósito: o teste antigo afirmava «run's status wins», o defeito que trazia o status do
  // worktree por cima de um move posterior em main (o arquivo passava a contradizer o ledger).
  it("field-level 3-way: main's later status move wins, main's title wins, run-only narrative kept, no markers, done", async () => {
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 9000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });

    await mq.enqueueMerge({ runId: "rtest", board: "testboard", cardId: "story-r", branch: "run/rtest" });
    await mq.whenIdle();

    // Integrated cleanly — the both-diverged frontmatter did NOT park as a line-based conflict.
    expect(store.read()[0]?.status).toBe("done");
    expect(store.read()[0]?.conflictDetail).toBeUndefined();
    expect(store.read()[0]?.split?.dataLanded).toBe(true);

    const finalCard = await show(mainRepo, `${baseBranch}:${cardRel}`);
    // BOTH-changed status → main's move (posterior ao corte) wins; the run's stale snapshot does not come back.
    expect(finalCard).toContain("status: pronta");
    expect(finalCard).not.toContain("status: desenvolver");
    // MAIN-only AUTHORIAL edit (title) → the human's live edit survives.
    expect(finalCard).toContain("Título humano");
    // RUN-only field (narrative) → NOT dropped (the anti-drop a pure 2-way would have wiped).
    expect(finalCard).toContain("leitor");
    // No line-based conflict markers leaked into the card.
    expect(finalCard).not.toContain("<<<<<<<");
    expect(finalCard).not.toContain(">>>>>>>");

    // The board-data commit on main carries the `board:` prefix, and the run branch was integrated + deleted.
    const log = (await exec(`git log --oneline -1 ${baseBranch}`, { cwd: mainRepo })).stdout;
    expect(log).toContain("board:");
    const runExists = await exec(`git rev-parse --verify run/rtest`, { cwd: mainRepo }).then(() => true).catch(() => false);
    expect(runExists).toBe(false);
  });
});

// WS-3.1 — REAL-git proof that the DATA half survives a CONCURRENT board commit on the
// SHARED main tree. This is the line of the incident (`merge-queue.ts` ~L2040) — the ONE line that produced
// the `re-driving` entries stuck in a live runtime (both `{codeStaged: true}`
// with NO `dataLanded`): the code half landed on `stage`, the data half died on `main`, and the card was
// stranded with its feature already staged.
//
// THE HYPOTHESIS WAS FALSIFIABLE, AND WAS MEASURED BEFORE THIS FIX EXISTED (the plan's autocrítica #1 said
// "I never saw the race happen"). A throwaway spike ran the real `git apply --check && git apply --index`
// against 3 concurrent `git add -A` + commit writers, 80 rounds per arm:
//   • unserialized (today's code): 75 OK / 5 FAILED — ALL of them `index.lock`, ZERO content conflicts;
//   • apply+commit under ONE critical section: 80 OK / 0 FAILED.
// So: the race is real (~6% per contended apply), serializing cures it, and there was never a content
// conflict to "merge harder" at (which is why D7 refuses a looser --3way/unionFallback: it would trade a
// stranded card for a CORRUPTED board without touching the actual cause).
//
// MECHANISM, precisely (the spike refined the plan, which predicted "conflict"): `git apply --check` does
// NOT take the index lock, so it PASSES; `git apply --index` is the one that dies with
// `fatal: Unable to create '.git/index.lock': File exists` ⇒ applyPatch (~L1344-1346) returns "error", not
// "conflict". Both route to maybeRedrive identically (~L2041), so the defect and the fix are unchanged —
// but the verdict this test asserts on is "error".
//
// THE PROBE IS THE REAL LOCK, NOT A MOCK: the concurrent writer takes `.git/index.lock` — literally the file
// `git add -A`/`git commit` create for the duration of a commit — from INSIDE the serializer's critical
// section, which is exactly where the engine's boundary-1 board commit and the train's `commitAllPending`
// live (commit-serializer.ts:1-12). Timing is not left to chance (a 6% flake is not a test): the writer takes
// the lock before the data half starts and holds it across the apply window. Without the fix the apply runs
// unserialized INTO that window and dies; with the fix it queues behind the section and applies clean.
describePosix("integrateSplit (real git) — WS-3.1: the data half survives a concurrent board commit", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let baseBranch: string;
  const cardRel = "storymap/boards/testboard/cards/story-race.md";

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-race-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    mainRepo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(mainRepo, "storymap", "boards", "testboard", "cards"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "feature.ts"), "export const feature = 1;\n");
    await fsp.writeFile(
      path.join(mainRepo, cardRel),
      ["---", "id: story-race", "type: story", "title: Card", "status: desenvolver", "---", "", "corpo", ""].join("\n"),
    );
    // A SECOND card — the one the concurrent live-board writer churns. Disjoint from the run's card, so
    // any failure here is the RACE, never a content overlap.
    await fsp.writeFile(
      path.join(mainRepo, "storymap", "boards", "testboard", "cards", "story-live.md"),
      ["---", "id: story-live", "type: story", "title: Live", "status: pronta", "---", "", "vivo", ""].join("\n"),
    );
    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@example.test`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m base`, { cwd: mainRepo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: mainRepo })).stdout.trim();

    // The run: CODE (packages/**) + DATA (the card advance) — the mixed run of the incident.
    await exec(`git checkout -q -b run/race`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "feature.ts"), "export const feature = 2; // shipped\n");
    await fsp.writeFile(
      path.join(mainRepo, cardRel),
      ["---", "id: story-race", "type: story", "title: Card", "status: revisar-codigo", "---", "", "corpo", ""].join("\n"),
    );
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run: code + card advance"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: mainRepo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("a board commit holding .git/index.lock does NOT strand the card as {codeStaged, !dataLanded}", async () => {
    const store = memStore();
    const indexLock = path.join(mainRepo, ".git", "index.lock");
    let released = false;

    // The live board, mid-commit: it holds `.git/index.lock` from inside the serializer's section — the
    // exact state `git add -A` leaves the shared tree in, and the exact section the engine's boundary-1
    // commit occupies. Everything the train does under the SAME serializer waits for it; anything outside
    // races it.
    const holdLock = async () => {
      await fsp.writeFile(indexLock, "");
      await new Promise((r) => setTimeout(r, 250));
      await fsp.rm(indexLock, { force: true });
      released = true;
      // The live board's commit actually lands, so the tree ends in a real, committed state.
      await fsp.writeFile(
        path.join(mainRepo, "storymap", "boards", "testboard", "cards", "story-live.md"),
        ["---", "id: story-live", "type: story", "title: Live", "status: entregue", "---", "", "vivo", ""].join("\n"),
      );
      await exec(`git add -A`, { cwd: mainRepo });
      await exec(`git commit -q --no-verify -m "board: estado vivo"`, { cwd: mainRepo });
    };

    // The train and the live board share ONE serializer instance — the production topology (both boundaries
    // key the process-global chain by repoRoot). The queue's own commit already routes through it; whether
    // the APPLY does is what this test measures.
    const chain = new Map<string, Promise<unknown>>();
    const serializer = <T,>(cwd: string, fn: () => Promise<T>): Promise<T> => {
      const prev = chain.get(cwd) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => fn());
      chain.set(cwd, next.catch(() => {}));
      return next;
    };

    let writer: Promise<unknown> | null = null;
    // Fire the writer the instant the DATA half begins (the `git diff … > …-data.patch` that precedes the
    // apply) and do not return until it HOLDS the lock. That makes the interleaving deterministic instead of
    // a 6% coin flip: the apply that follows is guaranteed to meet a contended index.
    const execRacing: ExecFn = async (cmd, opts) => {
      if (cmd.includes("-data.patch") && cmd.includes("diff") && !writer) {
        writer = serializer(mainRepo, holdLock);
        await new Promise((r) => setTimeout(r, 20)); // let the section start and take the lock
      }
      return exec(cmd, opts);
    };

    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec: execRacing,
      store,
      now: () => 9000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      commitSerializer: serializer,
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });

    await mq.enqueueMerge({ runId: "race", board: "testboard", cardId: "story-race", branch: "run/race" });
    await mq.whenIdle();
    await writer; // never leave the lock-holder dangling into the next test

    const entry = store.read()[0];

    // THE INCIDENT'S SIGNATURE — the live shape of those stuck entries. This is the assertion that fails
    // on today's code: the data half dies on the contended index and the card is stranded with its code
    // already on `stage`.
    expect(entry?.split).not.toEqual({ codeStaged: true });
    // `?? ""` because a CLEAN integration leaves conflictDetail undefined — and `.not.toMatch(undefined)`
    // THROWS instead of passing, which would red the test on the very outcome it is asserting.
    expect(entry?.conflictDetail ?? "").not.toMatch(/board data não aplicou/);

    // Both halves landed: the card advanced on main and the code is on stage.
    expect(entry?.status).toBe("done");
    expect(entry?.split).toEqual({ dataLanded: true, codeStaged: true });
    expect(await show(mainRepo, `${baseBranch}:${cardRel}`)).toContain("status: revisar-codigo");
    expect(await show(mainRepo, "stage:packages/app/feature.ts")).toContain("feature = 2");

    // The probe really did contend (a green from a writer that never held the lock would prove nothing).
    expect(released).toBe(true);
  });
});

// WS-2 — the RECEIPT, over real git: the train witnesses each half AS IT LANDS it, citing
// the commit it created. Everything downstream then READS the fact instead of re-deriving it from git and
// getting it wrong (the redrive re-implementing code that was already published). A sha, not a bool: the point is that
// an operator — or this test — can go and CHECK the commit the receipt names.
describePosix("integrateSplit (real git) — WS-2: o train grava o recibo de cada metade", () => {
  let tmpRoot: string;
  let mainRepo: string;
  let stateDir: string;
  let baseBranch: string;
  let suiteStateDir: string | undefined;
  const RUN_ID = "e7691a24-1111-4222-8333-444455556666";
  const CARD = "storymap/boards/testboard/cards/story-r.md";

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-receipt-split-"));
    exec = isolatedGitExec(exec, tmpRoot);
    mainRepo = path.join(tmpRoot, "main");
    // ISOLATED state dir: the receipts (and the split's patch files) must not land in this checkout's real
    // storymap/.runner — paths.ts's own warning, earned the hard way (test fixtures once wrote into the
    // operator's live activity journal: "a ledger you cannot trust is worse than no ledger").
    stateDir = path.join(tmpRoot, "runner-state");
    await fsp.mkdir(stateDir, { recursive: true });
    suiteStateDir = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = stateDir;

    await fsp.mkdir(path.join(mainRepo, "storymap", "boards", "testboard", "cards"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "r.ts"), "export const r = 1;\n");
    await fsp.writeFile(path.join(mainRepo, CARD), "---\nid: story-r\nstatus: desenvolver\n---\ncorpo\n");
    await exec(`git init -q`, { cwd: mainRepo });
    await exec(`git config user.email t@example.test`, { cwd: mainRepo });
    await exec(`git config user.name tester`, { cwd: mainRepo });
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m base`, { cwd: mainRepo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: mainRepo })).stdout.trim();

    await exec(`git checkout -q -b run/${RUN_ID}`, { cwd: mainRepo });
    await fsp.writeFile(path.join(mainRepo, "packages", "app", "r.ts"), "export const r = 2;\n");
    await fsp.writeFile(path.join(mainRepo, CARD), "---\nid: story-r\nstatus: entregue\n---\ncorpo\n");
    await exec(`git add -A`, { cwd: mainRepo });
    await exec(`git commit -q --no-verify -m "run: code + card"`, { cwd: mainRepo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: mainRepo });
  });

  afterAll(async () => {
    // B22 — DEVOLVE o diretório do setup (era `delete`: todo describe depois deste rodava sem isolamento e gravava
    // recibos no `storymap/.runner` do checkout).
    process.env.AGILEHARNESS_RUNNER_STATE_DIR = suiteStateDir;
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: mainRepo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("as duas metades ganham recibo, e o SHA citado EXISTE e contém os arquivos daquela metade", async () => {
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: mainRepo,
      exec,
      store,
      now: () => 11000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: RUN_ID, board: "testboard", cardId: "story-r", branch: `run/${RUN_ID}` });
    await mq.whenIdle();
    expect(store.read()[0]?.status).toBe("done");

    const { readLanding } = await import("./landings");
    const code = await readLanding(RUN_ID, "code");
    const data = await readLanding(RUN_ID, "data");
    expect(code).toMatchObject({ half: "code", ref: "stage", board: "testboard", cardId: "story-r" });
    expect(data).toMatchObject({ half: "data", ref: "main", board: "testboard", cardId: "story-r" });

    // THE CLAIM IS CHECKABLE — that is the whole difference between a bool and a receipt. Each cited sha must
    // exist AND actually carry that half's content.
    const codeShow = (await exec(`git show ${code!.sha}:packages/app/r.ts`, { cwd: mainRepo })).stdout;
    expect(codeShow).toContain("r = 2");
    const dataShow = (await exec(`git show ${data!.sha}:${CARD}`, { cwd: mainRepo })).stdout;
    expect(dataShow).toContain("status: entregue");

    // ...and each sha is on the ref its receipt names (code on `stage`, data on main) — the split, witnessed.
    const onStage = await exec(`git merge-base --is-ancestor ${code!.sha} stage`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    const onMain = await exec(`git merge-base --is-ancestor ${data!.sha} ${baseBranch}`, { cwd: mainRepo })
      .then(() => true)
      .catch(() => false);
    expect(onStage).toBe(true);
    expect(onMain).toBe(true);
  });
});

/**
 * Um artefato DERIVADO de board-data (um caso já observado em produção).
 *
 * O golden `board-base-pipeline` fotografa a config resolvida dos boards: FONTE em `storymap/**` (metade
 * dados → main), CAMINHO em `packages/**` (metade código → stage). Roteado pelo caminho, o par se parte
 * e as duas metades ficam erradas ao mesmo tempo — em stage a regeneração roda contra a fonte ANTIGA e
 * reverte a mudança (o train então acusa "código não aterrissou (flag falsa)" e devolve à sessão um
 * conflito estruturalmente insolúvel), e em main a fonte nova pousa SEM o golden, deixando a suíte do
 * próprio main vermelha — que, com o gate fail-closed, congela a fila inteira.
 *
 * Mock não pega isto: só git de verdade mostra em QUAL ref cada metade caiu.
 */
// B22 — o describe acima reaponta o diretório de estado para o SEU temporário e, no
// afterAll, APAGAVA a variável em vez de devolver a do setup: todo describe depois dele rodava sem isolamento e
// `runnerStateDir()` caía em `<checkout>/storymap/.runner` — o que deixava recibos do board de fixture `x` (runs de teste)
// no ledger VIVO do alvo de produção, e de novo no worktree de cada sessão que roda a suíte.
describePosix("B22 — depois do describe que reaponta o estado do runner, os seguintes seguem isolados", () => {
  it("o diretório de estado do runner continua apontado para um temporário (nunca para o checkout)", () => {
    const dir = process.env.AGILEHARNESS_RUNNER_STATE_DIR?.trim() ?? "";
    expect(dir).not.toBe("");
    expect(path.resolve(dir).startsWith(path.resolve(findRepoRoot()) + path.sep)).toBe(false);
  });
});

describePosix("split — derivado de board-data viaja com a FONTE e é regenerado em main", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;
  const GOLDEN = "packages/app/golden.snap";
  const SOURCE = "storymap/boards/_base/board.yaml";
  // O regen REAL do repo é um `vitest -u`; aqui é uma derivação determinística e sem dependências, com a
  // mesma propriedade que importa: o artefato é função da fonte que estiver na árvore NAQUELE momento.
  const REGEN = `sh -c "sed 's/^/GOLDEN: /' ../../${SOURCE} > golden.snap"`;
  const dataDerived = [{ artifact: GOLDEN, sources: ["storymap/boards/"], cwd: "packages/app", regen: REGEN }];

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-derived-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "_base"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(repo, SOURCE), "steps: [a]\n");
    await fsp.writeFile(path.join(repo, GOLDEN), "GOLDEN: steps: [a]\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "real.ts"), "export const r = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: repo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  const runBranch = async (name: string, edit: () => Promise<void>) => {
    await exec(`git checkout -q -b ${name}`, { cwd: repo });
    await edit();
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "run ${name}"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });
  };

  it("a fonte E o golden pousam JUNTOS em main, e o golden bate com a fonte que pousou", async () => {
    await runBranch("run/derived", async () => {
      await fsp.writeFile(path.join(repo, SOURCE), "steps: [a, b]\n");
      await fsp.writeFile(path.join(repo, GOLDEN), "GOLDEN: steps: [a, b]\n");
    });
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"], dataDerived },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "d1", board: "x", cardId: "y", branch: "run/derived" });
    await mq.whenIdle();

    // NÃO voltou para a sessão: o par nunca foi partido, então não há conflito insolúvel a devolver.
    expect(store.read()[0]?.status).toBe("done");

    // O PONTO: as duas metades do par estão em MAIN, e são CONSISTENTES entre si. Antes do fix o golden
    // ficava preso em stage revertido, e main carregava a fonte nova com o golden velho (suíte vermelha).
    expect(await show(repo, `${baseBranch}:${SOURCE}`)).toContain("steps: [a, b]");
    expect(await show(repo, `${baseBranch}:${GOLDEN}`)).toBe("GOLDEN: steps: [a, b]\n");
  });

  it("REGENERA a partir da fonte de main, não aplica os bytes do run (o que sobrevive à concorrência)", async () => {
    // main avança sozinha ANTES da integração — como se outro run tivesse mexido na mesma fonte.
    await fsp.writeFile(path.join(repo, SOURCE), "steps: [z]\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "main mexeu na fonte"`, { cwd: repo });

    // O run carrega um golden que reflete a fonte DELE — bytes que, aplicados verbatim, mentiriam sobre main.
    await runBranch("run/stale-golden", async () => {
      await fsp.writeFile(path.join(repo, GOLDEN), "GOLDEN: steps: [a, b]\n");
      await fsp.writeFile(path.join(repo, "storymap", "boards", "_base", "outro.yaml"), "x: 1\n");
    });
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"], dataDerived },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "d2", board: "x", cardId: "y", branch: "run/stale-golden" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).toBe("done");
    // O golden reflete a fonte DE MAIN (steps: [z]) — NÃO os bytes que o run trazia (steps: [a, b]).
    // É exatamente isto que um patch verbatim erraria, e por isso o mecanismo regenera em vez de aplicar.
    expect(await show(repo, `${baseBranch}:${GOLDEN}`)).toBe("GOLDEN: steps: [z]\n");
  });

  it("regen que FALHA aborta a metade de dados — main nunca fica com fonte nova e golden velho", async () => {
    const before = (await exec(`git rev-parse ${baseBranch}`, { cwd: repo })).stdout.trim();
    await runBranch("run/regen-falha", async () => {
      await fsp.writeFile(path.join(repo, SOURCE), "steps: [q]\n");
    });
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: {
        enabled: true,
        branch: "stage",
        codePrefixes: ["packages/"],
        dataDerived: [{ ...dataDerived[0], regen: `sh -c "exit 3"` }],
      },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "d3", board: "x", cardId: "y", branch: "run/regen-falha" });
    await mq.whenIdle();

    // Fail-closed: main NÃO avançou. Commitar a fonte sem o artefato deixaria a suíte de main vermelha, e
    // como o gate do train é fail-closed isso congelaria a fila para todo mundo — pior que parar aqui.
    expect(store.read()[0]?.status).not.toBe("done");
    expect((await exec(`git rev-parse ${baseBranch}`, { cwd: repo })).stdout.trim()).toBe(before);
  });
});

/**
 * O VEREDITO DE UMA SUBMISSÃO DE SESSÃO PRECISA CHEGAR EM ALGUÉM (observado em produção).
 *
 * Uma entrada `kind: session` não tem card, e `emitMergeDone` retorna cedo sem cardId — a razão é boa
 * (a cascata existe para reavaliar a coluna DE UM CARD; sem card não há o que reavaliar), mas o efeito
 * era suprimir o evento para TODO consumidor, não só para a cascata. Somado a `returned-to-session` ser
 * TERMINAL (some do `runner_status`, que só projeta entradas vivas) e a `conflictDetail` não ter um
 * único leitor na superfície MCP, a submissão de uma sessão se decidia em silêncio absoluto: a sessão
 * era mandada resolver um conflito sem receber QUAL. O padrão de merge train exige o contrário — a
 * devolução carrega contexto suficiente para resolver sem perguntar.
 *
 * A separação correta: o emissor NÃO decide a regra de negócio da cascata suprimindo o evento de todos.
 * `onMergeDone` (cascata) segue exigindo card; `onEntrySettled` (quem espera) recebe todo desfecho.
 */
describePosix("veredito de entrada card-less — a sessão consegue saber o que aconteceu", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-settle-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "s.ts"), "export const s = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
    await exec(`git checkout -q -b agent/sess-1`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "s.ts"), "export const s = 2;\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "trabalho da sessao"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: repo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("uma entrada SEM card notifica quem espera pelo desfecho (e a cascata segue intocada)", async () => {
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });

    const cascade: unknown[] = [];
    const settled: Array<{ runId: string; status: string; detail?: string }> = [];
    mq.onMergeDone((ev) => cascade.push(ev));
    mq.onEntrySettled((ev) => settled.push(ev));

    await mq.enqueueMerge({ runId: "sess-1", board: "x", cardId: undefined, branch: "agent/sess-1" });
    await mq.whenIdle();

    // A cascata continua exigindo card — nada muda para ela (sem card não há coluna a reavaliar).
    expect(cascade).toEqual([]);
    // O PONTO: quem ESPERA recebe o desfecho, com a identidade da submissão. Antes, silêncio absoluto.
    expect(settled.map((s) => s.runId)).toContain("sess-1");
    expect(settled.at(-1)?.status).toBe(store.read()[0]?.status);
  });
});

// O SPLIT tem de carregar BINÁRIO. `git diff` sem `--binary` emite só o marcador "Binary files a/x and
// b/x differ" — sem payload e sem full index —, e `git apply` recusa o patch INTEIRO com "cannot apply
// binary patch to 'x' without full index line", inclusive sob `--3way`. As hunks de TEXTO do mesmo patch
// aplicam, então o run meia-aterrissa e a entrada parqueia como `conflict`: foi o que aconteceu com um
// golden .snap e com um lote de imagens PNG. Este teste cobre as DUAS
// metades de uma vez — o binário de código (→ stage) e o de board-data (→ main) — porque cada metade
// monta o seu próprio patch, num call site diferente.
describePosix("split (real git) — binário atravessa as DUAS metades (código→stage, data→main)", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;
  const CODE_BIN = "packages/app/logo.png";
  const DATA_BIN = "storymap/boards/x/assets/mark.png";
  const CODE_TXT = "packages/app/real.ts";
  // Bytes determinísticos COM NUL — é o NUL no início do conteúdo que faz o git classificar como binário.
  const png = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, ...Array.from({ length: 64 }, (_, i) => (i * seed) % 256)]);

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-binsplit-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "x", "assets"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(repo, CODE_BIN), png(1));
    await fsp.writeFile(path.join(repo, DATA_BIN), png(2));
    await fsp.writeFile(path.join(repo, CODE_TXT), "export const r = 1;\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: repo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  /** O sha do BLOB — comparação exata de conteúdo binário sem passar bytes por stdout. */
  const blob = async (ref: string) => (await exec(`git rev-parse ${ref}`, { cwd: repo })).stdout.trim();

  it("os bytes que pousam são os do run — e a entrada NÃO parqueia como conflito", async () => {
    await exec(`git checkout -q -b run/bin`, { cwd: repo });
    await fsp.writeFile(path.join(repo, CODE_BIN), png(7));
    await fsp.writeFile(path.join(repo, DATA_BIN), png(9));
    await fsp.writeFile(path.join(repo, CODE_TXT), "export const r = 2;\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "run bin"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });

    const wantCode = await blob("run/bin:" + CODE_BIN);
    const wantData = await blob("run/bin:" + DATA_BIN);

    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "b1", board: "x", cardId: "y", branch: "run/bin" });
    await mq.whenIdle();

    // Sem `--binary` isto era "conflict": o apply recusava o patch inteiro por causa do PNG.
    expect(store.read()[0]?.status).toBe("done");

    // A metade de CÓDIGO em stage — byte a byte, não "existe um arquivo lá".
    expect(await blob("stage:" + CODE_BIN)).toBe(wantCode);
    expect(await show(repo, "stage:" + CODE_TXT)).toContain("r = 2");

    // A metade de DATA em main — o outro call site, o outro patch.
    expect(await blob(`${baseBranch}:${DATA_BIN}`)).toBe(wantData);
  });
});

// Guard de EXAUSTIVIDADE (mesmo espírito de gate-exhaustiveness.test.ts): consertar as 3 chamadas de hoje
// não impede uma 4ª nascer errada amanhã. Todo `git diff` do merge train que ESCREVE um patch precisa de
// `--binary` — a falha é silenciosa até alguém tocar num asset, e aí custa uma investigação inteira.
it("todo `git diff … > *.patch` do merge train pede --binary", async () => {
  const src = await fsp.readFile(
    path.join(findRepoRoot(), "packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts"),
    "utf8",
  );
  // Casa qualquer `diff …` cujo redirecionamento seja para um arquivo de patch.
  const offenders = [...src.matchAll(/`diff (?![^`]*--binary)[^`]*>\s*\$\{quote\((?:code|data)Patch\)\}/g)];
  expect(offenders.map((m) => m[0])).toEqual([]);
});

// Um incidente real, ponta a ponta no train de verdade. Um commit adicionou um helper em
// `scripts/` E os configs sob `packages/` que o importam. `codePrefixes: [packages/]` mandou os configs
// para stage e o helper para main: stage ficou com import apontando para arquivo inexistente. Como o
// worktree de run é cortado de stage, isso quebraria o gate de TODO run seguinte — falha silenciosa
// produzida por uma integração VERDE. A regra `promoteImportedDataPaths` faz o importado viajar junto.
describePosix("split (real git) — arquivo de dados IMPORTADO pelo código viaja com ele, não para main", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;
  const HELPER = "scripts/vitest/helper.mjs";
  const CONFIG = "packages/app/vitest.config.ts";
  const CARD = "storymap/boards/x/cards/c1.md";

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-torn-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "vitest"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "x", "cards"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(repo, CONFIG), "export default {};\n");
    await fsp.writeFile(path.join(repo, CARD), "---\nid: c1\n---\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, {
      cwd: repo,
    }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("o helper importado pousa em STAGE junto do config; o card segue para main", async () => {
    await exec(`git checkout -q -b run/torn`, { cwd: repo });
    await fsp.writeFile(path.join(repo, HELPER), "export const help = () => 1;\n");
    await fsp.writeFile(
      path.join(repo, CONFIG),
      "import { help } from '../../scripts/vitest/helper.mjs';\nexport default { help };\n",
    );
    await fsp.writeFile(path.join(repo, CARD), "---\nid: c1\nstatus: pronta\n---\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "run torn"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });

    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
    });
    await mq.enqueueMerge({ runId: "t1", board: "x", cardId: "c1", branch: "run/torn" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).toBe("done");

    // O PONTO: as duas metades do par estão em STAGE. Antes, o helper ia para main e stage ficava com
    // um import quebrado — e é de stage que os worktrees de run nascem.
    expect(await show(repo, `stage:${CONFIG}`)).toContain("scripts/vitest/helper.mjs");
    expect(await show(repo, `stage:${HELPER}`)).toContain("export const help");

    // O card, que é board data de verdade, segue seu caminho normal para main.
    expect(await show(repo, `${baseBranch}:${CARD}`)).toContain("status: pronta");
  });
});

// Fase 4b — o carimbo `stagedAt` SOBREVIVE à metade de dados (num caso real, várias stories do condutor ficaram
// presas em «Publicar» para sempre). O train carimbava `stagedAt` logo depois da
// metade de CÓDIGO — uma escrita NÃO-commitada no card da árvore viva de main — e a metade de DADOS, que
// roda DEPOIS (WS-1.1: código antes de dados), a apagava:
//   • card que main também moveu (o formato do condutor: ele move o card em main pelo MCP enquanto a sessão
//     trabalha) ⇒ o 3-way por campo lê o card de HEAD e o REESCREVE no disco — o carimbo some em silêncio;
//   • card que main não moveu ⇒ `git apply --index` recusa o card sujo («does not match index») e a metade
//     de dados morre em MEIA-ATERRISSAGEM.
// Sem `stagedAt` o release nunca carimba `releasedAt/releasedSha`, e o settle do deploy fica em «prova de
// publicação não medida (codigo-sem-release)» para sempre. O stampStaged daqui escreve NO DISCO de main,
// exatamente como o de produção (updateCardOnDisk) — é isso que o no-op dos outros testes escondia.
describePosix("integrateSplit (real git) — Fase 4b: stagedAt sobrevive à metade de dados", () => {
  let tmpRoot: string;
  const CARD = "storymap/boards/testboard/cards/story-s.md";
  const baseCard = ["---", "id: story-s", "type: story", "title: Título", "status: desenvolver", "---", "", "corpo", ""];

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-staged-at-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  /** Um repo com um run que muda CÓDIGO e o CARD; `mainMovesCard` faz main mover o card depois do fork. */
  async function setup(name: string, mainMovesCard: boolean): Promise<{ repo: string; baseBranch: string }> {
    const repo = path.join(tmpRoot, name);
    await fsp.mkdir(path.join(repo, "storymap", "boards", "testboard", "cards"), { recursive: true });
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "s.ts"), "export const s = 1;\n");
    await fsp.writeFile(path.join(repo, CARD), baseCard.join("\n"));
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@example.test`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    const baseBranch = (await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: repo })).stdout.trim();

    // O RUN: código + o card avançado com os carimbos do pipeline (o que a sessão do condutor entrega).
    await exec(`git checkout -q -b run/${name}`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "s.ts"), "export const s = 2;\n");
    await fsp.writeFile(
      path.join(repo, CARD),
      ["---", "id: story-s", "type: story", "title: Título", "status: desenvolver", "qaPassed: true", "---", "", "corpo", ""].join("\n"),
    );
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m "run: code + card"`, { cwd: repo });
    await exec(`git checkout -q ${baseBranch}`, { cwd: repo });

    if (mainMovesCard) {
      await fsp.writeFile(
        path.join(repo, CARD),
        ["---", "id: story-s", "type: story", "title: Título", "status: revisao", "---", "", "corpo", ""].join("\n"),
      );
      await exec(`git add -A`, { cwd: repo });
      await exec(`git commit -q --no-verify -m "board: estado vivo antes do merge-back"`, { cwd: repo });
    }
    return { repo, baseBranch };
  }

  /** O carimbo de PRODUÇÃO, em miniatura: escreve `stagedAt` no card do DISCO de main, sem commitar. */
  const diskStamp = (repo: string) => async () => {
    const abs = path.join(repo, CARD);
    const raw = await fsp.readFile(abs, "utf8");
    if (raw.includes("stagedAt:")) return;
    await fsp.writeFile(abs, raw.replace(/\n---\n/, "\nstagedAt: '2026-09-25'\n---\n"));
  };

  async function integrate(repo: string, runId: string) {
    const store = memStore();
    const mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store,
      now: () => 13000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: diskStamp(repo),
      addSecretScanBlocker: async () => {},
      addDataNotLandedBlocker: async () => {},
      addCodeNotLandedBlocker: async () => {},
      persistConflictedBranchFinding: async () => {},
      addGateBlocker: async () => {},
      clearRunBlockers: async () => {},
      isCardTerminal: async () => false,
      cleanTreeRecheck: { attempts: 1, delayMs: 0 },
    });
    await mq.enqueueMerge({ runId, board: "testboard", cardId: "story-s", branch: `run/${runId}` });
    await mq.whenIdle();
    await exec(`git worktree remove ${JSON.stringify(`${repo}-stage`)} --force`, { cwd: repo }).catch(() => {});
    return store.read()[0];
  }

  it("card que main TAMBÉM moveu (3-way por campo, o formato do condutor): o carimbo segue no disco", async () => {
    const { repo, baseBranch } = await setup("cond", true);
    const entry = await integrate(repo, "cond");

    expect(entry?.status).toBe("done");
    expect(entry?.split).toEqual({ codeStaged: true, dataLanded: true });
    // A metade de dados pousou (o carimbo do run chegou a main)…
    expect(await show(repo, `${baseBranch}:${CARD}`)).toContain("qaPassed: true");
    // …e NÃO levou o `stagedAt` junto: é ele que o release lê para carimbar releasedAt/releasedSha.
    expect(await fsp.readFile(path.join(repo, CARD), "utf8")).toContain("stagedAt: '2026-09-25'");
  });

  it("card que main NÃO moveu (apply por linha): o carimbo não suja o card antes do apply nem se perde", async () => {
    const { repo, baseBranch } = await setup("line", false);
    const entry = await integrate(repo, "line");

    expect(entry?.status).toBe("done");
    expect(entry?.split).toEqual({ codeStaged: true, dataLanded: true });
    expect(await show(repo, `${baseBranch}:${CARD}`)).toContain("qaPassed: true");
    expect(await fsp.readFile(path.join(repo, CARD), "utf8")).toContain("stagedAt: '2026-09-25'");
  });
});

// WP5-F1 — O TRAIN SÓ DESFAZ O QUE ELE ESCREVEU. O incidente, reproduzido em git DE VERDADE: no checkout de runtime o
// serviço grava cards por MCP direto no disco e o flush do board estava travado pelo secret-scan (o `git add` dele deixa
// o board STAGED quando o scan recusa). Qualquer falha da metade de dados fazia `reset`/`checkout HEAD`/`clean -fd` em
// TODO storymap/boards — e um card NOVO não rastreado e um card existente modificado (nenhum dos dois no patch do run)
// sumiam. Aqui cada um dos quatro «desfazer» (apply que conflita no unionFallback, regeneração que falha, commit que
// falha, secret no commit do split) roda sobre esse estado, e os dois arquivos alheios têm de sobreviver BYTE A BYTE.
// As falhas são injetadas SOBRE o git real: só o veredito de UM comando muda; índice, árvore e patch são os de verdade.
describePosix("integrateSplit (real git) — WP5-F1: o train só desfaz o que ELE escreveu", () => {
  const CARDS = "storymap/boards/tb/cards";
  const RUN_CARD = `${CARDS}/story-run.md`;
  const EXISTING = `${CARDS}/story-existing.md`;
  const NOVO = `${CARDS}/story-novo.md`;
  const NOTES = "storymap/boards/tb/docs/notes.md";
  const GOLDEN = "packages/app/golden.snap";
  const cardText = (id: string, status: string, extra: string[] = []) =>
    ["---", `id: ${id}`, "type: story", `title: ${id}`, `status: ${status}`, ...extra, "---", "", "corpo", ""].join("\n");

  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;
  let real: ExecFn;
  /** as falhas injetadas da vez (o resto é git real) */
  let fail: { boundaryScan: boolean; rangeScan: boolean; trainCommit: boolean };
  /** WP5-F2 — avisa quando o train chega à decisão do carve (o merge por campo vem logo depois) */
  let onCarveProbe: (() => void) | null = null;
  /** avisa quando o train já DECIDIU o carve e aplica o patch por linha (a nota do board) — antes do lock do card */
  let afterCarveProbe: (() => void) | null = null;
  const injected: ExecFn = async (cmd, opts) => {
    if (onCarveProbe && cmd.includes("diff-index --name-only --no-renames HEAD --")) onCarveProbe();
    if (afterCarveProbe && cmd.includes("diff --binary --no-renames") && cmd.includes(NOTES)) afterCarveProbe();
    // o flush/commit de fronteira recusado pelo scan, nomeando o card alheio — o estado do incidente
    if (fail.boundaryScan && cmd.includes("scan-secrets.mjs") && cmd.includes("--staged")) {
      throw Object.assign(new Error(`Command failed: ${cmd}\n  ✗ [naked-high-entropy-token] ${EXISTING}:7 → (mascarado)`), { code: 2 });
    }
    if (fail.rangeScan && cmd.includes("scan-secrets.mjs") && cmd.includes("--range")) {
      throw Object.assign(new Error("secret no commit do train"), { code: 2 });
    }
    if (fail.trainCommit && cmd.includes('commit --no-verify -m "board: story-run')) {
      throw Object.assign(new Error("commit falhou"), { code: 1, stderr: "fatal: falha injetada" });
    }
    return real(cmd, opts);
  };
  const g = (args: string) => real(`git ${args}`, { cwd: repo, timeout: 30_000 });
  const read = (rel: string) => fsp.readFile(path.join(repo, rel), "utf8");
  const write = async (rel: string, text: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fsp.writeFile(path.join(repo, rel), text);
  };

  beforeEach(async () => {
    fail = { boundaryScan: true, rangeScan: false, trainCommit: false };
    onCarveProbe = null;
    afterCarveProbe = null;
    ledgerHops = [];
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-wp5f1-"));
    real = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await write(".gitignore", "node_modules\n.worktrees/\n");
    await write(RUN_CARD, cardText("story-run", "desenvolver"));
    await write(EXISTING, cardText("story-existing", "pronta"));
    await write(NOTES, "linha base\n");
    await write(GOLDEN, "GOLDEN v0\n");
    await write("packages/app/real.ts", "export const r = 1;\n");
    await g(`init -q`);
    await g(`config user.email t@example.test`);
    await g(`config user.name tester`);
    await g(`add -A`);
    await g(`commit -q --no-verify -m base`);
    baseBranch = (await g(`rev-parse --abbrev-ref HEAD`)).stdout.trim();
    // o run (só board-data): avança o card dele e mexe numa nota do board
    await g(`checkout -q -b run/r1`);
    await write(RUN_CARD, cardText("story-run", "revisar-codigo", ["narrative:", "  role: leitor", "  want: achar livros", "  soThat: escolher"]));
    await write(NOTES, "linha do run\n");
    await g(`add -A`);
    await g(`commit -q --no-verify -m "run r1"`);
    await g(`checkout -q ${baseBranch}`);
  });

  afterEach(async () => {
    await real(`git worktree remove ${JSON.stringify(path.join(tmpRoot, "main-stage"))} --force`, { cwd: repo, timeout: 30_000 }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  /** o estado vivo do runtime que NÃO é do train: um card novo fora do git e um card existente movido por MCP */
  const liveForeignWrites = async () => {
    await write(NOVO, cardText("story-novo", "triagem", ["# aceito na triagem: bug de seguranca"]));
    await write(EXISTING, cardText("story-existing", "desenvolver"));
    return { novo: await read(NOVO), existing: await read(EXISTING) };
  };

  /** WP5-F2 — os saltos do ledger que o merge por campo consulta (o default leria o ledger real do host). */
  let ledgerHops: Transition[] = [];
  const makeQ = (staging: Record<string, unknown> = {}) => {
    const store = memStore();
    const ledger: CardStatusOnDisk[][] = [];
    const mq = makeMergeQueue({
      readCardTransitions: async () => ledgerHops,
      repoRoot: repo,
      exec: injected,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"], ...staging },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
      addDataNotLandedBlocker: async () => {},
      cleanTreeRecheck: { attempts: 1, delayMs: 0 },
      sleep: async () => {},
      reconcileLedger: async (cards) => void ledger.push([...cards]),
    });
    return { mq, store, ledger };
  };

  const expectForeignIntact = async (before: { novo: string; existing: string }) => {
    expect(await read(NOVO)).toBe(before.novo);
    expect(await read(EXISTING)).toBe(before.existing);
  };
  /** os caminhos do train voltaram ao HEAD e não sobrou nada staged/sujo deles */
  const expectTrainPathsUndone = async () => {
    expect(await read(RUN_CARD)).toBe(await show(repo, `HEAD:${RUN_CARD}`));
    expect(await read(NOTES)).toBe(await show(repo, `HEAD:${NOTES}`));
    expect((await g(`status --porcelain -- ${RUN_CARD} ${NOTES}`)).stdout.trim()).toBe("");
  };

  it("apply de dados que CONFLITA (unionFallback): só os caminhos do patch voltam; o card novo e o card movido sobrevivem", async () => {
    // main moveu a nota do board depois do corte — o patch do run não aplica nem com --3way
    await write(NOTES, "linha de main\n");
    await g(`add -A`);
    await g(`commit -q --no-verify -m "main mexeu na nota"`);
    const before = await liveForeignWrites();
    const head = (await g(`rev-parse HEAD`)).stdout.trim();

    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).not.toBe("done");
    expect((await g(`rev-parse HEAD`)).stdout.trim()).toBe(head);
    await expectForeignIntact(before);
    await expectTrainPathsUndone();
    expect(await read(NOTES)).not.toContain("<<<<<<<");
  });

  it("regeneração que FALHA: o artefato meio-escrito volta ao que era; o resto do board vivo fica", async () => {
    const before = await liveForeignWrites();
    const head = (await g(`rev-parse HEAD`)).stdout.trim();
    const { mq, store } = makeQ({
      dataDerived: [{ artifact: GOLDEN, sources: ["storymap/boards/"], cwd: "packages/app", regen: `sh -c "echo PARCIAL > golden.snap; exit 3"` }],
    });
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).not.toBe("done");
    expect((await g(`rev-parse HEAD`)).stdout.trim()).toBe(head);
    expect(await read(GOLDEN)).toBe("GOLDEN v0\n");
    await expectForeignIntact(before);
    await expectTrainPathsUndone();
  });

  it("commit do train que FALHA: só o que ele aplicou é desfeito", async () => {
    fail.trainCommit = true;
    const before = await liveForeignWrites();
    const head = (await g(`rev-parse HEAD`)).stdout.trim();
    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).not.toBe("done");
    expect((await g(`rev-parse HEAD`)).stdout.trim()).toBe(head);
    await expectForeignIntact(before);
    await expectTrainPathsUndone();
  });

  it("secret no commit do split: o commit sai (reset --soft), só os caminhos do train voltam, o board vivo fica", async () => {
    fail.rangeScan = true;
    const before = await liveForeignWrites();
    const head = (await g(`rev-parse HEAD`)).stdout.trim();
    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).toBe("failed");
    expect((await g(`rev-parse HEAD`)).stdout.trim()).toBe(head);
    await expectForeignIntact(before);
    await expectTrainPathsUndone();
  });

  it("aterrissagem com escrita viva no card do run: funde com o card VIVO, o move de main vence, o commit leva só o que é do train e o ledger é reconciliado", async () => {
    const before = await liveForeignWrites();
    // o condutor moveu o card do run por MCP depois do corte (escrita viva, ainda fora do git)
    await write(RUN_CARD, cardText("story-run", "qa-automatizado"));
    const { mq, store, ledger } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).toBe("done");
    // o commit do train carrega SÓ os caminhos dele — nada do conteúdo alheio que o flush recusado deixou staged
    const committed = (await g(`show --name-only --format= HEAD`)).stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
    expect(committed).toEqual([NOTES, RUN_CARD].sort());
    // o card fundido: o status do move vivo (posterior ao corte) + a narrativa que só o run trouxe
    const landed = await show(repo, `HEAD:${RUN_CARD}`);
    expect(landed).toContain("status: qa-automatizado");
    expect(landed).not.toContain("status: revisar-codigo");
    expect(landed).toContain("leitor");
    // os alheios seguem no disco, intactos e fora do commit (o flush os versiona)
    await expectForeignIntact(before);
    expect((await g(`status --porcelain -- ${NOVO} ${EXISTING}`)).stdout).toContain("story-novo.md");
    // o ledger é posto em dia com o status que ficou no arquivo
    expect(ledger).toEqual([[{ board: "tb", cardId: "story-run", before: "qa-automatizado", after: "qa-automatizado" }]]);
  });
  // WP5-F2 — o desfazer restaurava cada caminho ao estado anterior SEM conferir se o disco ainda tinha o que o train
  // escreveu: uma escrita de MCP durante a regeneração do dataDerived (segundos) era apagada junto.
  it("escrita de OUTRO escritor num caminho do train durante a regeneração: o desfazer NÃO a apaga; o resto do train volta", async () => {
    const before = await liveForeignWrites();
    const mcp = cardText("story-run", "qa-automatizado", ["# movido por MCP durante a regeneração"]);
    const mcpFile = path.join(tmpRoot, "escrita-mcp.md");
    await fsp.writeFile(mcpFile, mcp);
    const { mq, store } = makeQ({
      dataDerived: [
        {
          artifact: GOLDEN,
          sources: ["storymap/boards/"],
          cwd: "packages/app",
          // a regeneração demora; no meio dela, um update_card grava o card do run — e depois a regeneração falha
          regen: `sh -c "cp ${JSON.stringify(mcpFile).slice(1, -1)} ../../${RUN_CARD}; echo PARCIAL > golden.snap; exit 3"`,
        },
      ],
    });
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();

    expect(store.read()[0]?.status).not.toBe("done");
    expect(await read(RUN_CARD)).toBe(mcp); // a escrita do outro escritor ficou
    expect(await read(GOLDEN)).toBe("GOLDEN v0\n"); // o que é só do train voltou
    expect(await read(NOTES)).toBe(await show(repo, `HEAD:${NOTES}`));
    expect((await g(`diff --cached --name-only`)).stdout).not.toContain("story-run.md"); // o índice do caminho voltou ao HEAD
    await expectForeignIntact(before);
  });

  // WP5-F2 — o merge do card VIVO rodava sem o lock por card: ler o lado vivo (a foto do começo da metade de dados),
  // fundir e escrever podia intercalar com um update_card e apagá-lo.
  it("o merge do card vivo toma o lock por card e relê o lado vivo DENTRO dele: o update_card feito no meio sobrevive", async () => {
    await write(RUN_CARD, cardText("story-run", "qa-automatizado")); // escrita viva: o card do run é fundido por campo
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((r) => (releaseLock = r));
    let lockTaken!: () => void;
    const taken = new Promise<void>((r) => (lockTaken = r));
    const holder = withCardLock("tb", "story-run", async () => {
      lockTaken();
      await lockHeld;
    });
    await taken;
    const reachedCarve = new Promise<void>((r) => (onCarveProbe = r));

    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    const idle = mq.whenIdle();
    await reachedCarve; // a foto do lado vivo já foi tirada; o train vai pedir o lock do card
    await new Promise((r) => setTimeout(r, 50));
    // um update_card (sob o lock que o teste segura) move o card de novo
    await write(RUN_CARD, cardText("story-run", "revisao", ["# aprovado por MCP no meio do merge"]));
    releaseLock();
    await holder;
    await idle;

    expect(store.read()[0]?.status).toBe("done");
    const landed = await show(repo, `HEAD:${RUN_CARD}`);
    expect(landed).toContain("status: revisao"); // o move de MCP feito durante o merge
    expect(landed).toContain("leitor"); // a narrativa que só o run trouxe
  });

  // Revisão do WP5-F2: o lado de main só vinha do disco quando o card estava sujo NA FOTO. Um card fundido só por
  // DIVERGÊNCIA (main o commitou depois da base — o flush, o caso comum no runtime) usava o HEAD, e o update_card gravado
  // entre a foto e o lock era sobrescrito pelo merge sem aviso.
  it("REPRO-3: card divergido e LIMPO na foto — o update_card gravado entre a foto e o lock sobrevive ao merge", async () => {
    // o flush versionou o card em main depois da base: divergido, sem escrita viva
    await write(RUN_CARD, cardText("story-run", "desenvolver", ["release: r-flush"]));
    await g(`add -A`);
    await g(`commit -q --no-verify -m "board: flush"`);
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((r) => (releaseLock = r));
    let lockTaken!: () => void;
    const taken = new Promise<void>((r) => (lockTaken = r));
    const holder = withCardLock("tb", "story-run", async () => {
      lockTaken();
      await lockHeld;
    });
    await taken;
    const pastCarve = new Promise<void>((r) => (afterCarveProbe = r));

    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    const idle = mq.whenIdle();
    await pastCarve; // a foto já foi tirada e o card ficou LIMPO nela; o train vai pedir o lock do card
    // o update_card (sob o lock que o teste segura) grava o card
    await write(RUN_CARD, cardText("story-run", "desenvolver", ["release: r-mcp-no-meio"]));
    releaseLock();
    await holder;
    await idle;

    expect(store.read()[0]?.status).toBe("done");
    const landed = await show(repo, `HEAD:${RUN_CARD}`);
    expect(landed).toContain("release: r-mcp-no-meio"); // a escrita do MCP ficou
    expect(landed).not.toContain("r-flush");
    expect(landed).toContain("status: revisar-codigo"); // o avanço do run
    expect(landed).toContain("leitor"); // a narrativa que só o run trouxe
    expect(await read(RUN_CARD)).toBe(landed); // o disco e o commit dizem a mesma coisa
  });
  // WP5-F2 — «main vence o status» só valia quando o status de main diferia da BASE: um move A→C→A depois do corte
  // contava como «main não mexeu», e a foto velha do run (revisar-codigo) vencia. O ledger prova o move.
  it("main moveu o card e o devolveu ao status da base depois do corte (A→C→A): o status de main vence a foto do run", async () => {
    // escrita viva (status igual à base, corpo mexido) — o card do run é fundido por campo
    await write(RUN_CARD, cardText("story-run", "desenvolver", ["# nota viva"]));
    const later = new Date(Date.now() + 60_000).toISOString();
    ledgerHops = [
      { v: 1, at: later, board: "tb", cardId: "story-run", from: "desenvolver", to: "qa-automatizado", actor: "human" },
      { v: 1, at: later, board: "tb", cardId: "story-run", from: "qa-automatizado", to: "desenvolver", actor: "human" },
    ];
    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();
    expect(store.read()[0]?.status).toBe("done");
    const landed = await show(repo, `HEAD:${RUN_CARD}`);
    expect(landed).toContain("status: desenvolver");
    expect(landed).toContain("leitor"); // o resto do run segue vindo dele
  });

  it("controle: sem salto de main depois da base, o run decide o status como sempre", async () => {
    await write(RUN_CARD, cardText("story-run", "desenvolver", ["# nota viva"]));
    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();
    expect(store.read()[0]?.status).toBe("done");
    expect(await show(repo, `HEAD:${RUN_CARD}`)).toContain("status: revisar-codigo");
  });

  // Revisão do WP5-F2: o ledger contava como move de main QUALQUER salto posterior à base. No caso comum (o settle carimba
  // uiSurfaceEvidence no card de main ⇒ card fundido por campo) isso descartava o avanço do run e travava o card.
  /** o instante (ms) do commit-base do run, com a precisão que o train tem: o `%ct` do git, em segundos */
  const baseInstantMs = async () => Number((await g(`show -s --format=%ct ${(await g(`merge-base HEAD run/r1`)).stdout.trim()}`)).stdout.trim()) * 1000;

  it("REPRO-1: o merge:approved de OUTRO run (from == to) gravado logo depois do commit-base não é move de main — o avanço do run vence", async () => {
    await write(RUN_CARD, cardText("story-run", "desenvolver", ["# uiSurfaceEvidence carimbado no settle"]));
    const at = new Date((await baseInstantMs()) + 2_000).toISOString();
    ledgerHops = [{ v: 1, at, board: "tb", cardId: "story-run", from: "desenvolver", to: "desenvolver", actor: "merge", runId: "r0", note: "merge:approved" }];
    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();
    expect(store.read()[0]?.status).toBe("done");
    expect(await show(repo, `HEAD:${RUN_CARD}`)).toContain("status: revisar-codigo");
  });

  it("REPRO-2: o salto que LEVOU o card ao status da base no mesmo segundo do commit-base não é move de main — o avanço do run vence", async () => {
    await write(RUN_CARD, cardText("story-run", "desenvolver", ["# uiSurfaceEvidence carimbado no settle"]));
    const at = new Date((await baseInstantMs()) + 400).toISOString();
    ledgerHops = [{ v: 1, at, board: "tb", cardId: "story-run", from: "priorizar", to: "desenvolver", actor: "cascade" }];
    const { mq, store } = makeQ();
    await mq.enqueueMerge({ runId: "r1", board: "tb", cardId: "story-run", branch: "run/r1" });
    await mq.whenIdle();
    expect(store.read()[0]?.status).toBe("done");
    expect(await show(repo, `HEAD:${RUN_CARD}`)).toContain("status: revisar-codigo");
  });
});
