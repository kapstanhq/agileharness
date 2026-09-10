import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// WS-10.3 — a flag da escada (`autorun.mergeTrain.semanticResolution`) é lida do settings.yaml DENTRO do
// call-site, então provar o invariante 7 no train exige governá-la daqui. O mock DELEGA ao módulo real por
// padrão (todo o resto do arquivo continua lendo o settings.yaml de verdade, como sempre leu); só o teste
// da flag OFF sobrescreve o retorno. Um mock que substituísse a config inteira seria uma segunda verdade.
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, loadRunnerConfig: vi.fn(actual.loadRunnerConfig) };
});

import { loadRunnerConfig } from "./config";
import type { JudgePort, JudgeRequest } from "./semantic-resolution";
import {
  makeDefaultGateRunner,
  makeMergeQueue,
  orphanSplitPatches,
  parseVitestFailures,
  stuckEntries,
  verificationDemand,
  type IntegrationGateRunner,
  type MergeQueueConfig,
  type MergeQueueStore,
} from "./merge-queue";
// story-m3iouv — `classifyDeltaPath` é importado de release.ts porque é LÁ que a definição passou a morar
// (uma só, para o gate deste arquivo e para a fronteira de proveniência que a consome). Importá-la de
// merge-queue.ts seria testar um re-export e deixar a definição real sem cobertura.
import { ORIGIN_TRUST_ENV, classifyDeltaPath } from "./release";
import {
  conflictedBranchFindingId,
  gateBlockerFindingId,
  secretScanBlockerFindingId,
  withConflictedBranchFinding,
  withGateBlockerFinding,
  withRunBlockersResolved,
  withSecretScanBlockerFinding,
} from "./findings";
import type { ExecFn, WorktreeFs } from "./worktree";
import type { CommitSerializer } from "./commit-serializer";
import type { MergeQueueEntry } from "./types";
import type { DiffSnapshot, Finding } from "@/lib/storymap/types";

// story-ms5rmt — a recording per-cwd commit serializer (DI). It records every cwd it's asked to
// serialize a commit on and passes the fn straight through, so a test can assert the boundary-2
// board commit was routed through the SHARED mutex keyed by the main tree (not committed directly).
function recordingSerializer() {
  const cwds: string[] = [];
  const serialCommit: CommitSerializer = (cwd, fn) => {
    cwds.push(cwd);
    return fn();
  };
  return { serialCommit, cwds };
}

// A command-aware exec double (DI) so the merge plumbing is unit-testable without a real repo.
// `routes` maps a substring of the `git ...` command to an outcome:
//   - "ok"            → resolves (exit 0)
//   - { code, stderr } → rejects like promisify(child_process.exec) does on a non-zero exit.
// Unmatched commands default to ok (so `branch -D`, `merge --abort` etc. just succeed).
type Route = "ok" | { code: number; stderr?: string };
function makeExec(routes: Array<{ match: string; outcome: Route }> = []) {
  const calls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd);
    const hit = routes.find((r) => cmd.includes(r.match));
    const outcome = hit?.outcome ?? "ok";
    if (outcome === "ok") return { stdout: "", stderr: "" };
    const err = Object.assign(new Error(outcome.stderr ?? `exit ${outcome.code}`), {
      code: outcome.code,
      stderr: outcome.stderr ?? "",
    });
    throw err;
  };
  return { exec, calls };
}

// A REALISTIC stateful exec: `merge-base --is-ancestor X HEAD` is true ONLY after X is integrated,
// and a clean `git merge --no-ff X` integrates X. This models git's real invariant — a branch
// becomes an ancestor of HEAD precisely when it merges — which the f3 post-merge guard relies on.
// `conflict(branch)` forces a given branch's merge to fail (it never integrates).
function makeRealisticExec(opts: { conflict?: (branch: string) => boolean; renameFails?: (branch: string) => boolean; changed?: string } = {}) {
  const integrated = new Set<string>();
  const attempts: string[] = [];
  const calls: string[] = [];
  const exec: ExecFn = async (cmd) => {
    calls.push(cmd);
    const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
    if (cmd.includes("is-ancestor")) {
      if (integrated.has(br)) return { stdout: "", stderr: "" };
      throw Object.assign(new Error("not ancestor"), { code: 1 });
    }
    if (cmd.includes("branch -m")) {
      // SM-07: redrive renames the conflicted branch to conflicted/<orig>. Optionally force it to fail
      // (e.g. the destination already exists from a prior attempt) so the fallback branch -D is exercised.
      if (opts.renameFails?.(br)) throw Object.assign(new Error("dst exists"), { code: 128, stderr: "already exists" });
      return { stdout: "", stderr: "" };
    }
    if (cmd.includes("merge --no-ff")) {
      attempts.push(br);
      if (opts.conflict?.(br)) throw Object.assign(new Error("CONFLICT"), { code: 1, stderr: `CONFLICT in ${br}` });
      integrated.add(br);
      return { stdout: "", stderr: "" };
    }
    if (cmd.includes("diff --name-only")) {
      // Default to a CODE path so the integration gate runs (the gate tests). A board-data test passes
      // `changed` with a storymap/** path → branchTouchesCode false → the code gate is SKIPPED.
      return { stdout: opts.changed ?? "packages/storymap-ui/src/foo.ts\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { exec, calls, attempts, integrated };
}

// In-memory store (DI) so persistence is observable without touching disk.
function makeStore(seed: MergeQueueEntry[] = []) {
  let saved: MergeQueueEntry[] = seed.map((e) => ({ ...e }));
  const store: MergeQueueStore = {
    load: async () => saved.map((e) => ({ ...e })),
    persist: async (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
  };
  return { store, read: () => saved };
}

// Deterministic monotonic clock so enqueuedAt ordering is stable + assertable.
function clock(start = 1000) {
  let t = start;
  return () => (t += 1);
}

function makeQueue(over: Partial<MergeQueueConfig> = {}) {
  const exec = over.exec ?? makeExec().exec;
  const { store, read } = over.store ? { store: over.store, read: () => [] as MergeQueueEntry[] } : makeStore();
  // story-zdeajs (LOW #4): a no-op sleep by default so the dirty-tree bounded re-check (and any future
  // backoff) is INSTANT + deterministic under test; a test that asserts the backoff overrides it.
  const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock(), sleep: async () => {}, ...over });
  return { mq, read };
}

const input = (over: Partial<Pick<MergeQueueEntry, "runId" | "board" | "cardId" | "branch">> = {}) => ({
  runId: "s1",
  board: "acme",
  cardId: "story-1",
  branch: "run/s1",
  ...over,
});

describe("makeMergeQueue — enqueue + FIFO ordering (AC1)", () => {
  it("starts empty and enqueues a branch as `waiting`, round-tripping to the store", async () => {
    const { exec } = makeExec([{ match: "merge --no-ff", outcome: { code: 1 } }]); // force conflict so it stays put
    const { mq, read } = makeQueue({ exec });
    expect(mq.getSnapshot()).toEqual({ entries: [], processing: false });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    // it processed to a conflict (we forced a non-clean merge), but the entry exists + persisted.
    const snap = mq.getSnapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]).toMatchObject({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" });
    expect(read()).toHaveLength(1); // persisted
  });

  it("processes two simultaneously-enqueued branches ONE AT A TIME, in arrival order (FIFO, never parallel)", async () => {
    // Record the order merges are ATTEMPTED. Clean merges → both integrate in order. The realistic
    // exec makes each branch an ancestor only AFTER its merge, so the f3 post-merge guard passes.
    const { exec, attempts } = makeRealisticExec();
    const { mq, read } = makeQueue({ exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b" }));
    await mq.whenIdle();

    expect(attempts).toEqual(["run/a", "run/b"]); // serial, in arrival order
    const snap = mq.getSnapshot();
    expect(snap.entries.map((e) => e.status)).toEqual(["done", "done"]);
    expect(snap.processing).toBe(false);
    expect(read().every((e) => e.status === "done")).toBe(true);
  });
});

describe("makeMergeQueue — git push after merge-back (story-igl9tl)", () => {
  it("calls `git push origin HEAD` after a clean merge-back (non-fatal)", async () => {
    const { exec, calls } = makeRealisticExec();
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    expect(calls.some((c) => c.includes("git push origin HEAD"))).toBe(true);
  });

  it("records pushError on the done entry when push fails, but keeps status `done` and queue continues", async () => {
    const { exec } = makeRealisticExec();
    const pushCalls: string[] = [];
    const execWithFailPush: ExecFn = async (cmd) => {
      if (cmd.includes("push origin HEAD")) {
        // Track before throwing — the original exec never sees this command.
        pushCalls.push(cmd);
        throw Object.assign(new Error("! [rejected] main -> main (non-fast-forward)"), {
          code: 1,
          stderr: "! [rejected] main -> main (non-fast-forward)",
        });
      }
      return exec(cmd);
    };
    const { mq } = makeQueue({ exec: execWithFailPush });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b" }));
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    // Both entries are still `done` despite push failures — queue was NOT blocked.
    expect(snap.entries.map((e) => e.status)).toEqual(["done", "done"]);
    // The push error is recorded on the entry (non-fatal telemetry).
    expect(snap.entries[0].pushError).toBeTruthy();
    expect(snap.entries[0].pushError).toContain("rejected");
    // Push was attempted for both branches.
    expect(pushCalls.length).toBeGreaterThan(0);
  });

  it("reconciles a non-fast-forward rejected push (fetch+merge) and retries successfully → no pushError (#37 auto-push)", async () => {
    // origin/main advanced (another checkout pushed) so the FIRST push is rejected; the reconcile
    // (fetch + merge FETCH_HEAD, disjoint paths → clean) brings it in and the retry fast-forwards.
    const { exec } = makeRealisticExec();
    const calls: string[] = [];
    let pushAttempts = 0;
    const execAutoPush: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("push origin HEAD")) {
        pushAttempts += 1;
        if (pushAttempts === 1) {
          throw Object.assign(new Error("! [rejected] (non-fast-forward)"), {
            code: 1,
            stderr: "! [rejected] main -> main (non-fast-forward)",
          });
        }
        return { stdout: "", stderr: "" }; // retry after reconcile fast-forwards
      }
      return exec(cmd);
    };
    const { mq } = makeQueue({ exec: execAutoPush });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("done");
    expect(entry.pushError).toBeFalsy(); // reconciled + retried → nothing recorded
    expect(calls.some((c) => c.includes("git fetch origin"))).toBe(true);
    expect(calls.some((c) => c.includes("git merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(pushAttempts).toBe(2); // initial reject + exactly one retry
  });

  it("aborts the reconcile merge on conflict and records pushError, keeping status done (#37 fallback)", async () => {
    // A genuine conflict during reconcile must leave the tree pristine (merge --abort) and degrade to
    // the original non-fatal record-and-continue — never stall or dirty the train.
    const { exec } = makeRealisticExec();
    const calls: string[] = [];
    const execConflictReconcile: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("push origin HEAD")) {
        throw Object.assign(new Error("! [rejected] (non-fast-forward)"), {
          code: 1,
          stderr: "! [rejected] main -> main (non-fast-forward)",
        });
      }
      if (cmd.includes("merge --no-edit FETCH_HEAD")) {
        throw Object.assign(new Error("CONFLICT"), { code: 1, stderr: "CONFLICT (content)" });
      }
      return exec(cmd);
    };
    const { mq } = makeQueue({ exec: execConflictReconcile });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("done"); // push stays non-fatal → still done, queue not blocked
    expect(entry.pushError).toContain("rejected");
    expect(calls.some((c) => c.includes("git merge --abort"))).toBe(true); // tree left pristine
  });

  it("fires onMergeDone for the cascade AFTER the merge-back (story-r0zr3s)", async () => {
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({ exec });
    const done: Array<{ board: string; cardId: string }> = [];
    mq.onMergeDone((ev) => done.push(ev));

    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-1" }));
    await mq.whenIdle();

    expect(done).toEqual([{ board: "storymap", cardId: "story-1" }]);
  });

  it("onMergeDone carries the entry's trigger so the cascade re-eval keeps the suppress guard (audit #12)", async () => {
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({ exec });
    const done: Array<{ board: string; cardId: string; trigger?: string }> = [];
    mq.onMergeDone((ev) => done.push(ev));
    await mq.enqueueMerge({ ...input({ board: "storymap", cardId: "story-1" }), trigger: "harness-prioritize" });
    await mq.whenIdle();
    expect(done).toEqual([{ board: "storymap", cardId: "story-1", trigger: "harness-prioritize" }]);
  });
});

describe("makeMergeQueue — clean auto-merge (AC2)", () => {
  it("merges a non-conflicting branch into main with no human, marks it done and deletes the branch", async () => {
    const { exec, calls } = makeRealisticExec(); // not an ancestor pre-merge, becomes one post-merge
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0]).toMatchObject({ status: "done", branch: "run/s1" });
    // the merge ran, then the branch was force-deleted (clean-up owned by the queue, not the worktree)
    expect(calls.some((c) => c.includes("git merge --no-ff --no-edit \"run/s1\""))).toBe(true);
    expect(calls.some((c) => c.includes('git branch -D "run/s1"'))).toBe(true);
  });

  it("is idempotent when the branch is ALREADY an ancestor of HEAD — done without re-merging", async () => {
    const { exec, calls } = makeExec([{ match: "is-ancestor", outcome: "ok" }]); // already integrated
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(false); // never attempted a real merge
    expect(calls.some((c) => c.includes('git branch -D "run/s1"'))).toBe(true); // still cleaned up
  });

  it("marks an entry `failed` (without blocking the queue) when its branch has vanished", async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("rev-parse --verify")) throw Object.assign(new Error("unknown rev"), { code: 1 });
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input({ runId: "gone", branch: "run/gone" }));
    await mq.enqueueMerge(input({ runId: "ok", branch: "run/ok" })); // also vanished here, but proves the queue continued
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries.map((e) => e.status)).toEqual(["failed", "failed"]); // first didn't block the second
    expect(snap.entries[0].failureReason).toContain("inexistente");
    expect(snap.processing).toBe(false);
  });
});

describe("makeMergeQueue — f3 guard: never branch -D a non-ancestor branch", () => {
  it("runLoop: a merge that reports ok but leaves the branch NON-ancestor → conflict, branch preserved (f3)", async () => {
    // The anomaly: `git merge --no-ff` exits 0 but the branch is somehow still not an ancestor of
    // HEAD (corruption / a swallowed partial merge). The OLD code would `branch -D` it and mark done,
    // silently losing the run's work. f3: confirm `--is-ancestor` AFTER the merge; if false, pause as
    // `conflict` and KEEP the branch for the operator.
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 }); // ALWAYS false
      return { stdout: "", stderr: "" }; // merge --no-ff reports success
    };
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("conflict"); // paused, NOT done
    expect(entry.conflictDetail).toContain("non-ancestor");
    expect(calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(false); // branch survives
  });

  it("resolveMergeConflict('merged'): a branch the operator did NOT actually integrate → stays conflict, branch preserved (f3)", async () => {
    // Operator clicks "já integrei" but the branch is NOT an ancestor of HEAD (they were wrong / the
    // manual merge failed). The OLD code would delete it on their word, losing the work. f3: verify
    // `--is-ancestor` first; if false, keep it paused as `conflict` and never delete the branch.
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a" }); // a conflicts, never integrated
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");

    const callsBefore = calls.length;
    await mq.resolveMergeConflict("a", "merged"); // operator wrong: a is still not an ancestor
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("conflict"); // still paused — not falsely marked done
    expect(entry.conflictDetail).toContain("non-ancestor");
    expect(calls.slice(callsBefore).some((c) => c.includes('git branch -D "run/a"'))).toBe(false); // preserved
  });

  // WS-8.1 (D11) — the STEWARD's only verb over integration: hand a PARKED entry back so the train re-runs
  // ITS OWN disposition. The steward never merges; these tests pin that the verb stays a TRIGGER.
  it("retryParkedEntry: uma entry parqueada volta a `waiting`, o branch fica INTACTO e a fila drena", async () => {
    // O FATO muda entre as duas tentativas — é exatamente a única condição em que o steward re-tenta.
    const conflicting = new Set(["run/a"]);
    const realistic = makeRealisticExec({ conflict: (br) => conflicting.has(br) });
    const { mq } = makeQueue({ exec: realistic.exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");

    conflicting.delete("run/a"); // ex.: o WS-2 passou a mergear findings por elemento ⇒ não conflita mais
    const r = await mq.retryParkedEntry("a", "copilot:steward");
    await mq.whenIdle();

    expect(r.ok).toBe(true);
    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("done"); // re-integrou sozinha ao voltar p/ a fila — o TRAIN integrou, não o steward
    expect(entry.conflictDetail).toBeUndefined();
    expect(entry.stewardAttempts).toBe(1);
  });

  it("retryParkedEntry: o LOOP-GUARD é durável — cada devolução bumpa o contador da entry", async () => {
    const { mq } = makeQueue({ exec: makeRealisticExec({ conflict: () => true }).exec }); // conflita sempre

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");

    await mq.retryParkedEntry("a", "copilot:steward");
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict"); // parqueou de novo (o fato não mudou)
    expect(mq.getSnapshot().entries[0].stewardAttempts).toBe(1);

    // O contador SOBREVIVE ao re-park — é o que faz planParkedConflict escalar em vez de re-tentar.
    await mq.retryParkedEntry("a", "copilot:steward");
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].stewardAttempts).toBe(2);
  });

  it("retryParkedEntry: entry desconhecida / NÃO parqueada ⇒ recusa com o motivo (nunca um no-op que soa sucesso)", async () => {
    const { mq } = makeQueue({ exec: makeRealisticExec({}).exec });

    expect(await mq.retryParkedEntry("nao-existe", "copilot:steward")).toMatchObject({ ok: false });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("done"); // integrou normalmente
    const r = await mq.retryParkedEntry("a", "copilot:steward");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/não está parqueada/);
  });

  it("resolveMergeConflict('merged'): once the operator REALLY integrated it (ancestor) → done, branch deleted, queue resumes (f3)", async () => {
    const realistic = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({ exec: realistic.exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict"); // a parked
    expect(mq.getSnapshot().entries[1].status).toBe("done"); // b DRAINED past the parked head (parking, not head-of-line)

    realistic.integrated.add("run/a"); // the operator actually merged a by hand now
    await mq.resolveMergeConflict("a", "merged");
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0].status).toBe("done"); // a resolved (ancestor confirmed)
    expect(snap.entries[0].conflictDetail).toBeUndefined();
    expect(snap.entries[1].status).toBe("done"); // b integrated on resume
    expect(realistic.calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(true); // deleted only when safe
  });
});

describe("makeMergeQueue — HEAD=estado boundary 2: clean main before the merge-back", () => {
  it("commits pending board state SCOPED to storymap/boards/ BEFORE `git merge --no-ff` — never `git add -A` (story-p3bu01)", async () => {
    // Boundary 2: board mutations (writeCard) may accumulate on main DURING a run. A dirty tree makes
    // `git merge --no-ff` abort → the run falsely pauses as `conflict` and never reconciles. Commit the
    // live board state first (board: prefix, separable from code), THEN merge a clean main. story-p3bu01:
    // that snapshot stages ONLY the board pathspec — so a stray code edit / a predeploy tarball dirtying
    // the shared runtime checkout can NEVER be swept into the `board: estado vivo` commit that reaches main.
    const calls: string[] = [];
    // story-yy3hds: a mensagem vai por arquivo (-F, unlinkado após) — lê no momento da chamada.
    const commitMsgs: string[] = [];
    const integrated = new Set<string>();
    let boardDirty = true;
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      // commitBoardDataScoped decides emptiness via the STAGED board delta (`git diff --cached`), not status.
      if (cmd.includes("diff --cached --name-only")) {
        return { stdout: boardDirty ? "storymap/boards/storymap/cards/story-1.md\n" : "", stderr: "" };
      }
      if (cmd.includes("status --porcelain")) {
        // the clean-gate polls status AFTER the board commit → the tree is clean once the delta is committed.
        return { stdout: boardDirty ? " M storymap/boards/storymap/cards/story-1.md\n" : "", stderr: "" };
      }
      if (cmd.startsWith("git commit")) {
        const f = cmd.match(/-F "([^"]+)"/)?.[1];
        if (f) commitMsgs.push(readFileSync(f, "utf8"));
        boardDirty = false; // the board state is now committed → main clean for the merge
        return { stdout: "", stderr: "" };
      }
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done"); // merged cleanly on the now-clean main
    const boardCommitIx = calls.findIndex((c) => c.startsWith("git commit"));
    const mergeIx = calls.findIndex((c) => c.includes("merge --no-ff"));
    expect(boardCommitIx).toBeGreaterThanOrEqual(0); // a board commit happened
    expect(mergeIx).toBeGreaterThanOrEqual(0);
    expect(boardCommitIx).toBeLessThan(mergeIx); // …strictly BEFORE the merge-back
    expect(calls).toContain('git add -- "storymap/boards/"'); // p3bu01: scoped stage…
    expect(calls).not.toContain("git add -A"); // …NEVER the whole-tree sweep
    // story-yy3hds: a mensagem agora vai por arquivo -F — o prefixo board: é asserido pelo CONTEÚDO.
    expect(commitMsgs.some((m) => m.startsWith("board:"))).toBe(true);
  });

  it("routes the boundary-2 board commit through the per-cwd mutex keyed by repoRoot — never a bare commit that could race index.lock (AC3, story-ms5rmt)", async () => {
    // The fix: boundary-2's board commit (commitBoardDataScoped, story-p3bu01) must go through the SHARED
    // serializer (keyed by the main tree), so a run STARTING (boundary 1) while this merge runs can't
    // collide on .git/index.lock and falsely degrade to a `conflict`. Assert it serialized on repoRoot AND ran.
    const integrated = new Set<string>();
    const calls: string[] = [];
    // story-yy3hds: mensagem via arquivo -F — lida no momento da chamada (unlinkada após).
    const commitMsgs: string[] = [];
    // story-zdeajs: a SUCCESSFUL board commit clears the tree → flip clean after the commit so the new
    // tree-clean GATE (AC2/AC3) sees the now-clean tree and proceeds to the merge (the realistic case).
    let boardDirty = true;
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      // commitBoardDataScoped (story-p3bu01) decides emptiness via the STAGED board delta, not `git status`.
      if (cmd.includes("diff --cached --name-only")) {
        return { stdout: boardDirty ? "storymap/boards/x/cards/y.md\n" : "", stderr: "" };
      }
      if (cmd.includes("status --porcelain")) {
        return { stdout: boardDirty ? " M storymap/boards/x/cards/y.md\n" : "", stderr: "" };
      }
      if (cmd.includes("scan-secrets")) return { stdout: "", stderr: "" };
      if (cmd.startsWith("git commit")) {
        const f = cmd.match(/-F "([^"]+)"/)?.[1];
        if (f) commitMsgs.push(readFileSync(f, "utf8"));
        boardDirty = false; // committed → main clean for the gate + the merge
        return { stdout: "", stderr: "" };
      }
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const rec = recordingSerializer();
    const { mq } = makeQueue({ exec, commitSerializer: rec.serialCommit });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done"); // merged cleanly after the serialized commit
    // story-apz8sa FIX 3: BOTH index-mutating ops on the main tree are now serialized on repoRoot — the
    // boundary-2 board commit AND the merge-back `git merge --no-ff` itself — so neither can race a
    // concurrent board-data commit on .git/index.lock. Both routed through the SAME per-cwd chain.
    expect(rec.cwds).toEqual(["/repo", "/repo"]);
    // story-yy3hds: prefixo board: asserido pelo CONTEÚDO do arquivo -F — e realmente commitou.
    expect(commitMsgs.some((m) => m.startsWith("board:"))).toBe(true);
  });

  it("does NOT commit when main is already clean (board commit is a no-op → only the merge runs)", async () => {
    // Clean tree → commitBoardState returns committed:false (status only); no add/commit pollutes history.
    const { exec, calls } = makeRealisticExec(); // status falls through to empty stdout → clean
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    expect(calls.some((c) => c === "git add -A")).toBe(false); // never staged
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(false); // never committed
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(true); // merge still ran
  });

  it("FIX 3: the merge-back `git merge --no-ff` is itself serialized on repoRoot (against the index.lock race)", async () => {
    // The narrow race FIX 3 closes: a board-data settle commit firing mid-merge collides on .git/index.lock.
    // The merge itself must serialize on repoRoot — joining the SAME per-cwd chain as the boundary-2 board
    // commit. On a clean tree both serializer calls key on repoRoot (the boundary-2 no-op commit AND the
    // merge), and the LAST one is the merge — so the merge always ran inside the shared critical section.
    const { exec } = makeRealisticExec(); // clean status → boundary-2 no-op; clean merge → integrates
    const rec = recordingSerializer();
    const { mq } = makeQueue({ exec, commitSerializer: rec.serialCommit });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done"); // merged cleanly
    // Both the boundary-2 commit and the merge-back serialize on the MAIN tree (the merge is the new one).
    expect(rec.cwds).toEqual(["/repo", "/repo"]);
  });

  it("FIX 3: a CONFLICTING merge-back aborts INSIDE the serialized critical section (merge+abort atomic)", async () => {
    // A board-data commit slipping between a failed merge and its abort could commit the conflicted index.
    // So the abort must run INSIDE the same serializer continuation as the merge. Force a content conflict
    // (the realistic exec keeps the branch a NON-ancestor so the loop reaches the real merge-back) and
    // assert: the merge serialized on repoRoot, `git merge --abort` ran, and the entry parked conflict.
    const { exec, calls } = makeRealisticExec({ conflict: () => true }); // merge --no-ff always fails
    const rec = recordingSerializer();
    const { mq } = makeQueue({ exec, commitSerializer: rec.serialCommit });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    // Two serialized critical sections on the main tree: the boundary-2 no-op commit, then the merge+abort.
    expect(rec.cwds).toEqual(["/repo", "/repo"]);
    expect(calls.some((c) => c.includes("git merge --abort"))).toBe(true); // the half-merge was aborted
    // No `trigger` on this entry → maybeRedrive parks it as conflict (not re-driven) → main left pristine.
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");
  });

  it("a board-commit FAILURE (e.g. secret-scan blocked it) does NOT crash the train — it parks the dirty tree SAFELY instead of merging it (story-zdeajs AC2/AC3)", async () => {
    // Boundary 2 is deliberately ASYMMETRIC to boundary 1: a failed board commit here must NOT abort the
    // merge train (catch + log + proceed). PRE-FIX, the loop then merged the STILL-DIRTY tree → `git merge
    // --no-ff` aborted → false-parked as a CONTENT conflict. story-zdeajs: the new tree-clean GATE catches
    // the still-dirty tree BEFORE the doomed merge and parks the head with a DISTINCT dirty-tree detail
    // (NOT a content conflict) — the train pauses safely, the merge is never attempted on the dirty tree.
    const calls: string[] = [];
    const integrated = new Set<string>();
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      // commitBoardDataScoped (story-p3bu01) probes the STAGED board delta → non-empty here so it proceeds
      // to the scan (which throws below). status stays dirty so the clean-gate then parks the tree SAFELY.
      if (cmd.includes("diff --cached --name-only")) return { stdout: "storymap/boards/storymap/cards/story-1.md\n", stderr: "" };
      if (cmd.includes("status --porcelain")) return { stdout: " M storymap/boards/storymap/cards/story-1.md\n", stderr: "" };
      // Fail ONLY the board-commit scan (`--staged`, boundary 2); the SM-08 merge-commit scan
      // (`--range`) stays clean here so this test isolates the board-commit-failure path it's about.
      if (cmd.includes("scan-secrets.mjs") && cmd.includes("--staged")) throw Object.assign(new Error("secret found"), { code: 2 }); // blocks the board commit
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(calls.some((c) => c.includes("scan-secrets.mjs"))).toBe(true); // the board commit was attempted…
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(false); // …and blocked before committing
    // The doomed merge was NEVER attempted on the still-dirty tree (the gate stopped it).
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(false);
    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("conflict"); // parked SAFELY (not crashed, not falsely merged)
    expect(entry.conflictDetail).toContain("SUJA"); // the accurate dirty-tree marker, not a content conflict
    expect(mq.getSnapshot().processing).toBe(false);
  });

  /**
   * A FILA QUE PARA E NÃO VOLTA. A pausa por árvore suja dá `break` na FIFO INTEIRA — correto, porque uma
   * árvore suja condena todo merge. Mas o laço só é bombeado por EVENTO (enqueue, resolve, recover,
   * sweepStuck) e a pausa não gera evento nenhum: passado o motivo, as entradas atrás ficam `waiting`
   * indefinidamente, esperando alguém enfileirar outra coisa. Quem esperava era uma sessão que já tinha
   * submetido — sem nenhuma superfície dizendo que ninguém viria.
   */
  it("a pausa por árvore suja deixa as entradas de trás ESPERANDO — e o `pump()` é o que as retoma", async () => {
    let dirty = true; // um escritor externo segura a árvore suja; depois ele solta
    const integrated = new Set<string>();
    const merges: string[] = [];
    const exec: ExecFn = async (cmd) => {
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("diff --cached --name-only")) return { stdout: "", stderr: "" };
      if (cmd.includes("status --porcelain")) return { stdout: dirty ? " M packages/app/x.ts\n" : "", stderr: "" };
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        merges.push(br);
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1", cardId: "story-1" }));
    await mq.enqueueMerge(input({ runId: "s2", branch: "run/s2", cardId: "story-2" }));
    await mq.whenIdle();

    // A cabeça parqueou pela árvore suja e a SEGUNDA nem foi tentada — a FIFO inteira pausou.
    expect(mq.getSnapshot().entries.find((e) => e.runId === "s1")!.status).toBe("conflict");
    expect(mq.getSnapshot().entries.find((e) => e.runId === "s2")!.status).toBe("waiting");
    expect(merges).toEqual([]);

    // O escritor externo termina. NADA acontece: nenhum evento é gerado por uma árvore que limpou.
    dirty = false;
    await mq.whenIdle();
    expect(mq.getSnapshot().entries.find((e) => e.runId === "s2")!.status).toBe("waiting");
    expect(merges).toEqual([]);

    // O tick da varredura re-cutuca — e só então o trabalho de trás anda.
    const res = await mq.pump();
    expect(res).toEqual({ waiting: 1, pumped: true });
    await mq.whenIdle();
    expect(mq.getSnapshot().entries.find((e) => e.runId === "s2")!.status).toBe("done");
    expect(merges).toEqual(["run/s2"]);
  });

  it("`pump()` é no-op quando não há nada esperando — cutucar de mais nunca custa, mas não pode MENTIR", async () => {
    const { mq } = makeQueue();
    expect(await mq.pump()).toEqual({ waiting: 0, pumped: false });

    await mq.enqueueMerge(input());
    await mq.whenIdle();
    expect(await mq.pump()).toEqual({ waiting: 0, pumped: false }); // integrou: nada esperando
  });

  it("a TRANSIENTLY dirty tree (a racing in-process commit) that clears on a RE-POLL → the merge PROCEEDS (no false-park, story-zdeajs LOW #4)", async () => {
    // The shared main tree can be momentarily dirty because a CONCURRENT in-process board commit is mid-
    // flight; it clears in a beat. PRE-FIX the gate parked the FIFO head on the FIRST dirty read. The
    // bounded re-check re-polls `status --porcelain` and lets the merge proceed once the tree is clean.
    // story-p3bu01: the boundary-2 snapshot now probes the STAGED board delta (`git diff --cached`) — kept
    // EMPTY here so it is a no-op → the ONLY `status --porcelain` polls are the clean-gate's own: #1 is the
    // TRANSIENT dirty (a racing commit), #2+ are clean (it landed).
    let statusPolls = 0;
    const integrated = new Set<string>();
    const sleeps: number[] = [];
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("diff --cached --name-only")) return { stdout: "", stderr: "" }; // boundary-2 no-op
      if (cmd.includes("status --porcelain")) {
        statusPolls++;
        // clean-gate poll #1 DIRTY (the transient race); #2+ clean (it landed).
        return { stdout: statusPolls === 1 ? " M storymap/boards/x/cards/y.md\n" : "", stderr: "" };
      }
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec, sleep: async (ms) => { sleeps.push(ms); } });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("done"); // FAILS without the fix (parked `conflict` on the first dirty read)
    expect(statusPolls).toBeGreaterThanOrEqual(2); // it RE-POLLED the clean-gate rather than parking immediately
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // …with a backoff between the dirty poll and the re-poll
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(true); // the merge actually ran
  });

  it("a PERSISTENTLY dirty tree exhausts the bounded re-check and parks (does NOT loop forever, story-zdeajs LOW #4)", async () => {
    // The bound guarantees a never-clean tree (a real external/SSH writer) still parks — the re-check is
    // capped, so the train can't hang. story-p3bu01: the boundary-2 snapshot probes the STAGED board delta
    // (`git diff --cached`, kept EMPTY → no-op, no commit), so the ONLY `status --porcelain` polls are the
    // clean-GATE's own `attempts` (2) — all dirty — then it parks. (is-ancestor THROWS so we don't take the
    // already-integrated path.)
    let statusPolls = 0;
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("diff --cached --name-only")) return { stdout: "", stderr: "" }; // boundary-2 no-op
      if (cmd.includes("status --porcelain")) {
        statusPolls++;
        // the clean-gate's polls are all dirty (a genuine external writer holds the tree dirty).
        return { stdout: " M storymap/boards/x/cards/y.md\n", stderr: "" };
      }
      if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec, sleep: async () => {}, cleanTreeRecheck: { attempts: 2, delayMs: 5 } });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("conflict"); // still parks when genuinely dirty
    expect(entry.conflictDetail).toContain("SUJA");
    expect(statusPolls).toBe(2); // bounded `attempts` (2) clean-gate polls, never more (no status-based probe)
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(false); // never merged a dirty tree
  });
});

describe("makeMergeQueue — conflict PARKS; the train DRAINS the rest (parking, not head-of-line)", () => {
  it("on a conflicting merge: aborts immediately, PARKS as `conflict`, records the detail — and DRAINS the next entry", async () => {
    const exec = makeExec([
      { match: "is-ancestor", outcome: { code: 1 } },
      { match: "merge --no-ff", outcome: { code: 1, stderr: "CONFLICT (content): Merge conflict in foo.ts" } },
    ]);
    const { mq, read } = makeQueue({ exec: exec.exec });

    // two DISTINCT cards queued; the first conflicts and PARKS — the second is STILL attempted (drain).
    // This exec conflicts EVERY merge, so the second also parks; the point is it was never BLOCKED.
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" }));
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ status: "conflict", runId: "a" });
    expect(snap.entries[0].conflictDetail).toContain("CONFLICT");
    expect(snap.entries[1].status).toBe("conflict"); // DRAINED: attempted past the parked head, also conflicts → parked
    expect(snap.processing).toBe(false);
    // the abort fired so main is never left dirty
    expect(exec.calls.some((c) => c.includes("git merge --abort"))).toBe(true);
    expect(read()[0].status).toBe("conflict"); // durable
  });

  it("DRAINS a branch enqueued AFTER a head conflict (a parked head no longer blocks the FIFO)", async () => {
    // Realistic exec: run/a conflicts (never integrates); run/b merges + becomes an ancestor → done.
    const realistic = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({ exec: realistic.exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");

    // A NEW run (DISTINCT card) finishes while the conflict is still parked → its enqueue re-triggers
    // the processor, which DRAINS b past the parked head 'a' (b merges cleanly → done).
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" }));
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries.map((e) => e.status)).toEqual(["conflict", "done"]); // a parked, b drained past it
    expect(realistic.attempts).toEqual(["run/a", "run/b"]); // b WAS attempted (no head-of-line block)
    expect(snap.processing).toBe(false);
  });
});

describe("makeMergeQueue — resolveMergeConflict (AC3 → resume)", () => {
  it("`merged` marks the paused entry done, deletes its branch and RESUMES the queue", async () => {
    // a conflicts on its automatic merge; the operator then integrates it by hand (→ ancestor).
    const realistic = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({ exec: realistic.exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");
    expect(mq.getSnapshot().entries[1].status).toBe("done"); // b DRAINED past the parked a (parking, not head-of-line)

    realistic.integrated.add("run/a"); // operator merged a by hand → now an ancestor of HEAD
    await mq.resolveMergeConflict("a", "merged");
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0].status).toBe("done"); // a resolved
    expect(snap.entries[1].status).toBe("done"); // b finally integrated after the resume
  });

  it("`aborted` marks the paused entry failed, PRESERVES the branch (WS-2.1, base unknown → fail-safe) and resumes", async () => {
    // a conflicts (never integrated); the operator aborts it. b merges cleanly on resume.
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b" }));
    await mq.whenIdle();

    await mq.resolveMergeConflict("a", "aborted");
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ status: "failed", runId: "a" });
    expect(snap.entries[0].failureReason).toContain("abortou");
    // WS-2.1: base is unknown here (merge-base empty) → the fail-safe PRESERVES the branch (never a blind -D
    // that could destroy the only copy of un-integrated code — the incident's run/54de4fa8 loss).
    expect(snap.entries[0].branch).toBe("conflicted/run/a");
    expect(calls.some((c) => c.includes('branch -m "run/a" "conflicted/run/a"'))).toBe(true);
    expect(calls.some((c) => c.includes('branch -D "run/a"'))).toBe(false);
    expect(snap.entries[1].status).toBe("done"); // b integrated on resume
  });

  it("WS-2.1: `aborted` DELETES a DATA-ONLY branch (no un-integrated code to lose → keeps the ledger clean)", async () => {
    // base is resolvable (baseCommit) AND the diff is board-data only → confidently data-only → -D is safe.
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a", changed: "storymap/boards/acme/cards/x.md" });
    const { mq } = makeQueue({ exec });
    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), baseCommit: "b0" });
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");

    await mq.resolveMergeConflict("a", "aborted");
    await mq.whenIdle();
    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ status: "failed", runId: "a", branch: "run/a" }); // NOT renamed
    expect(calls.some((c) => c.includes('branch -D "run/a"'))).toBe(true); // data-only → deleted
    expect(calls.some((c) => c.includes('branch -m "run/a"'))).toBe(false); // never renamed to conflicted/
  });

  it("WS-2.4: the failureReason names the ACTOR passed (an agent abort is not 'operador')", async () => {
    const { exec } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({ exec });
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    await mq.resolveMergeConflict("a", "aborted", "agente (AGILEHARNESS_MCP_TOKEN_ORCH)");
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].failureReason).toContain("agente (AGILEHARNESS_MCP_TOKEN_ORCH)");
  });

  it("is a no-op on an unknown / non-conflicting runId", async () => {
    const { exec } = makeRealisticExec(); // s1 merges cleanly → done
    const { mq } = makeQueue({ exec });
    await mq.enqueueMerge(input());
    await mq.whenIdle();
    await mq.resolveMergeConflict("does-not-exist", "merged"); // must not throw
    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });
});

describe("makeMergeQueue — reentrancy guard", () => {
  it("a second enqueue while one is processing does NOT start a parallel processor (serial guarantee)", async () => {
    let inMerge = 0;
    let maxConcurrent = 0;
    const integrated = new Set<string>();
    const exec: ExecFn = async (cmd) => {
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        inMerge += 1;
        maxConcurrent = Math.max(maxConcurrent, inMerge);
        await new Promise((r) => setTimeout(r, 5)); // hold the "merge" so a race would overlap
        inMerge -= 1;
        integrated.add(br); // now an ancestor → the f3 post-merge guard passes
      }
      return { stdout: "", stderr: "" };
    };
    const { mq } = makeQueue({ exec });

    await Promise.all([
      mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" })),
      mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" })),
      mq.enqueueMerge(input({ runId: "c", branch: "run/c", cardId: "story-c" })),
    ]);
    await mq.whenIdle();

    expect(maxConcurrent).toBe(1); // never two merges in flight at once
    expect(mq.getSnapshot().entries.map((e) => e.status)).toEqual(["done", "done", "done"]);
  });

  it("a duplicate enqueue of a still-live run is ignored (idempotent)", async () => {
    // keep the first entry alive (conflict) so the duplicate has a live prior to dedupe against.
    const { exec } = makeExec([
      { match: "is-ancestor", outcome: { code: 1 } },
      { match: "merge --no-ff", outcome: { code: 1, stderr: "CONFLICT" } },
    ]);
    const { mq } = makeQueue({ exec });
    await mq.enqueueMerge(input());
    await mq.whenIdle();
    await mq.enqueueMerge(input()); // same runId, still live (conflict) → ignored
    await mq.whenIdle();
    expect(mq.getSnapshot().entries).toHaveLength(1);
  });
});

describe("makeMergeQueue — boot recovery (SM-2 durability)", () => {
  it("resets a crashed `merging` entry to `conflict` only when the working tree is DIRTY (story-43w10w)", async () => {
    // Dirty tree: `git status --porcelain` returns non-empty output → genuine mid-merge crash.
    const seed: MergeQueueEntry[] = [
      { runId: "a", board: "acme", cardId: "c", branch: "run/a", status: "merging", enqueuedAt: 1, mergeStartedAt: 2 },
    ];
    const { store } = makeStore(seed);
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      if (cmd.includes("status --porcelain")) return { stdout: "M packages/x/foo.ts\n", stderr: "" }; // dirty
      return { stdout: "", stderr: "" };
    };
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary).toMatchObject({ loaded: 1, resetToConflict: 1, resumed: 0, waiting: 0 });
    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("conflict");
    expect(entry.conflictDetail).toContain("árvore suja");
  });

  it("re-drives a crashed `merging` entry as `waiting` when the tree is CLEAN (story-43w10w)", async () => {
    // Clean tree (the common restart case): branch not yet integrated, but no dirty files.
    const seed: MergeQueueEntry[] = [
      { runId: "a", board: "acme", cardId: "c", branch: "run/a", status: "merging", enqueuedAt: 1, mergeStartedAt: 2 },
      { runId: "b", board: "acme", cardId: "c", branch: "run/b", status: "waiting", enqueuedAt: 3 },
    ];
    const { store } = makeStore(seed);
    const { exec } = makeRealisticExec(); // clean tree, branches not yet ancestors
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary).toMatchObject({ loaded: 2, resetToConflict: 0, resumed: 1, waiting: 2 });
    // Both entries integrate after the re-drive:
    expect(mq.getSnapshot().entries.map((e) => e.status)).toEqual(["done", "done"]);
  });

  it("marks a crashed `merging` entry `done` when its branch is ALREADY an ancestor (story-43w10w)", async () => {
    // Merge completed before the crash but `done` was never persisted.
    const seed: MergeQueueEntry[] = [
      { runId: "a", board: "acme", cardId: "c", branch: "run/a", status: "merging", enqueuedAt: 1, mergeStartedAt: 2 },
    ];
    const { store } = makeStore(seed);
    const { exec } = makeExec([{ match: "is-ancestor", outcome: "ok" }]); // already integrated
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary).toMatchObject({ loaded: 1, resetToConflict: 0, resumed: 1 });
    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });

  it("resumes `waiting` entries left on disk after a restart", async () => {
    const seed: MergeQueueEntry[] = [
      { runId: "w", board: "acme", cardId: "c", branch: "run/w", status: "waiting", enqueuedAt: 1 },
    ];
    const { store } = makeStore(seed);
    const { exec } = makeRealisticExec(); // run/w not an ancestor pre-merge, becomes one post-merge
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary).toMatchObject({ loaded: 1, waiting: 1, resumed: 0 });
    expect(mq.getSnapshot().entries[0].status).toBe("done"); // the resumed processor integrated it
  });

  it("DRAINS a `waiting` entry past a parked `conflict` head on boot (parking, not head-of-line)", async () => {
    // A restart with a conflict parked at the head + a DISTINCT card waiting behind it: recovery must
    // DRAIN the waiter past the parked head (the operator still resolves the head separately).
    const seed: MergeQueueEntry[] = [
      { runId: "a", board: "acme", cardId: "story-a", branch: "run/a", status: "conflict", enqueuedAt: 1 },
      { runId: "b", board: "acme", cardId: "story-b", branch: "run/b", status: "waiting", enqueuedAt: 2 },
    ];
    const { store } = makeStore(seed);
    const { exec, calls } = makeRealisticExec(); // b not an ancestor pre-merge, becomes one post-merge → done
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    await mq.recover();
    await mq.whenIdle();

    expect(mq.getSnapshot().entries.map((e) => e.status)).toEqual(["conflict", "done"]); // a parked, b drained past it
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(true); // b WAS attempted past the parked head
  });
});

// --- Integration gate (story-1k7els) ---------------------------------------
// A recording fake gate runner (DI): records the branch order it's asked to validate and returns a
// scripted verdict, so the queue's gate phase is testable without a real staging worktree.
function recordingGate(verdict: (branch: string) => { passed: boolean; log: string }) {
  const branches: string[] = [];
  const calls: Parameters<IntegrationGateRunner>[0][] = [];
  const gate: IntegrationGateRunner = async (opts) => {
    branches.push(opts.branch);
    calls.push(opts);
    return verdict(opts.branch);
  };
  return { gate, branches, calls };
}

describe("makeMergeQueue — integration gate: pass (AC1+AC3)", () => {
  it("gate PASSES → validates the branch in staging, THEN merges into main and marks done", async () => {
    const { gate, branches } = recordingGate(() => ({ passed: true, log: "10 passed" }));
    const { exec, calls } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(branches).toEqual(["run/s1"]); // the gate ran for the branch…
    expect(mq.getSnapshot().entries[0].status).toBe("done");
    // …and ONLY after a green gate did the real merge-back into main run.
    expect(calls.some((c) => c.includes('git merge --no-ff --no-edit "run/s1"'))).toBe(true);
  });

  it("forwards repoRoot + the configured checkCommand/timeout/runId to the gate runner", async () => {
    const { gate, calls } = recordingGate(() => ({ passed: true, log: "" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({
      exec,
      integrationGate: gate,
      gateEnabled: true,
      gateCheckCommand: "vitest run merge-queue",
      gateTimeoutMs: 12_345,
    });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(calls[0]).toMatchObject({
      repoRoot: "/repo",
      branch: "run/s1",
      runId: "s1",
      checkCommand: "vitest run merge-queue",
      timeoutMs: 12_345,
    });
  });

  it("validates EACH run against the accumulated main, serially, in arrival order (AC4)", async () => {
    const { gate, branches } = recordingGate(() => ({ passed: true, log: "" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b" }));
    await mq.whenIdle();

    expect(branches).toEqual(["run/a", "run/b"]); // each gated, one at a time, in order
    expect(mq.getSnapshot().entries.map((e) => e.status)).toEqual(["done", "done"]);
  });
});

describe("makeMergeQueue — integration gate: fail (AC2)", () => {
  it("gate FAILS → main is NEVER touched, the entry PARKS as `gate-failed` (gateLog) and the train DRAINS the rest", async () => {
    const { gate } = recordingGate(() => ({ passed: false, log: "FAIL: 2 failed | 8 passed" }));
    const { exec, calls } = makeRealisticExec();
    const { mq, read } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" }));
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ status: "gate-failed", runId: "a" });
    expect(snap.entries[0].gateLog).toContain("2 failed");
    expect(snap.entries[1].status).toBe("gate-failed"); // DRAINED past a, gated too → also fails → parked (no merge)
    expect(snap.processing).toBe(false);
    // main was never merged — BOTH entries failed the gate, so neither reached `git merge --no-ff`.
    expect(calls.some((c) => c.includes("git merge --no-ff"))).toBe(false);
    expect(read()[0].status).toBe("gate-failed"); // durable
  });

  it("an UNEXPECTED gate error fails CLOSED — parks `gate-failed`, never falls through to the merge", async () => {
    const gate: IntegrationGateRunner = async () => {
      throw new Error("gate runner exploded");
    };
    const { exec, calls } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");
    expect(mq.getSnapshot().entries[0].gateLog).toContain("exploded");
    expect(calls.some((c) => c.includes("git merge --no-ff"))).toBe(false); // main untouched
  });
});

describe("makeMergeQueue — integration gate: disabled (back-compat)", () => {
  it("no gate runner → behavior identical to the pre-gate train (merges straight into main)", async () => {
    const { exec, calls } = makeRealisticExec();
    const { mq } = makeQueue({ exec }); // integrationGate omitted → disabled

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    expect(calls.some((c) => c.includes("git merge --no-ff"))).toBe(true); // merged with no gate phase
  });

  it("gateEnabled:false SKIPS the gate even with a runner wired → merges straight into main (SM-06 hot-reload, AC3)", async () => {
    // The production wiring ALWAYS injects the runner; `gateEnabled` is the live switch. With it OFF, the
    // runner must NEVER be invoked and the branch merges as in the pre-gate train — proving that flipping
    // settings.yaml back to `enabled: false` takes effect without un-wiring (or restarting) anything.
    const { gate, branches } = recordingGate(() => ({ passed: true, log: "" }));
    const { exec, calls } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: false });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(branches).toEqual([]); // the gate runner was never called…
    expect(mq.getSnapshot().entries[0].status).toBe("done");
    expect(calls.some((c) => c.includes("git merge --no-ff"))).toBe(true); // …main merged directly
  });
});

describe("makeMergeQueue — gate-failed stamps a testing:blocker on the card (SM-06, AC2)", () => {
  it("on gate FAIL → calls addGateBlocker with the card coords + the gate log (so hasNoBlockers holds it out of QA)", async () => {
    const stamped: Array<{ board: string; cardId: string; runId: string; gateLog: string }> = [];
    const { gate } = recordingGate(() => ({ passed: false, log: "FAIL: 2 failed | 8 passed" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({
      exec,
      integrationGate: gate,
      gateEnabled: true,
      addGateBlocker: async (board, cardId, runId, gateLog) => {
        stamped.push({ board, cardId, runId, gateLog });
      },
    });

    await mq.enqueueMerge(input({ runId: "a", board: "storymap", cardId: "story-x", branch: "run/a" }));
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");
    expect(stamped).toHaveLength(1);
    expect(stamped[0]).toMatchObject({ board: "storymap", cardId: "story-x", runId: "a" });
    expect(stamped[0].gateLog).toContain("2 failed");
  });

  it("a BOARD-DATA-only run SKIPS the code gate entirely — merges straight to done (no vitest on a card edit)", async () => {
    let gateRan = false;
    // The branch touches only a card .md (no packages/**) → branchTouchesCode is false → the code gate
    // must NOT run. Before the fix every run (incl. board-data) was gated and stranded on a gate flake.
    const integrationGate = async () => {
      gateRan = true;
      return { passed: false, log: "should never run on board-data" };
    };
    const { exec } = makeRealisticExec({ changed: "storymap/boards/storymap/cards/story-x.md" });
    const { mq } = makeQueue({ exec, integrationGate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", board: "storymap", cardId: "story-x", branch: "run/a" }));
    await mq.whenIdle();

    expect(gateRan).toBe(false); // the code gate never ran on a board-data change
    expect(mq.getSnapshot().entries[0].status).toBe("done"); // merged to main, not gate-failed
  });

  it("a PASS never stamps a blocker (addGateBlocker is only called on failure)", async () => {
    const stamped: unknown[] = [];
    const { gate } = recordingGate(() => ({ passed: true, log: "10 passed" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({
      exec,
      integrationGate: gate,
      gateEnabled: true,
      addGateBlocker: async (...args) => {
        stamped.push(args);
      },
    });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    expect(stamped).toEqual([]);
  });

  it("a FAILING addGateBlocker is non-fatal — the entry still parks gate-failed and records gateBlockerError", async () => {
    const { gate } = recordingGate(() => ({ passed: false, log: "red" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({
      exec,
      integrationGate: gate,
      gateEnabled: true,
      addGateBlocker: async () => {
        throw new Error("disk full");
      },
    });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("gate-failed"); // the swallowed write error never changed the verdict
    expect(entry.gateBlockerError).toContain("disk full");
  });

  it("audit #6 — a successful merge calls clearRunBlockers with the run coords (so a retry-then-pass doesn't strand the card before QA)", async () => {
    const cleared: Array<{ board: string; cardId: string; runId: string }> = [];
    const { gate } = recordingGate(() => ({ passed: true, log: "10 passed" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({
      exec,
      integrationGate: gate,
      gateEnabled: true,
      clearRunBlockers: async (board, cardId, runId) => {
        cleared.push({ board, cardId, runId });
      },
    });

    await mq.enqueueMerge(input({ runId: "a", board: "storymap", cardId: "story-x", branch: "run/a" }));
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    // The run's OWN gate/secret-scan blockers are cleared on success — without this, a retry-then-pass
    // left a stale `open` blocker and hasNoBlockers held the card out of qa-automatizado forever.
    expect(cleared).toEqual([{ board: "storymap", cardId: "story-x", runId: "a" }]);
  });
});

describe("withRunBlockersResolved — clears a run's OWN blockers on integration (audit #6, pure)", () => {
  const mk = (id: string, status: Finding["status"], lens: Finding["lens"] = "testing"): Finding => ({
    id,
    lens,
    severity: "blocker",
    title: id,
    status,
  });

  it("flips THIS run's gate + secret-scan blockers open → fixed", () => {
    const existing = [mk(gateBlockerFindingId("r1"), "open"), mk(secretScanBlockerFindingId("r1"), "open", "security")];
    expect(withRunBlockersResolved(existing, "r1").map((x) => x.status)).toEqual(["fixed", "fixed"]);
  });

  it("is RUN-SCOPED — leaves other runs' blockers AND human findings untouched", () => {
    const out = withRunBlockersResolved(
      [mk("review-xyz", "open"), mk(gateBlockerFindingId("r2"), "open"), mk(gateBlockerFindingId("r1"), "open")],
      "r1",
    );
    expect(out.find((x) => x.id === "review-xyz")!.status).toBe("open"); // human finding survives
    expect(out.find((x) => x.id === gateBlockerFindingId("r2"))!.status).toBe("open"); // other run survives
    expect(out.find((x) => x.id === gateBlockerFindingId("r1"))!.status).toBe("fixed"); // only mine cleared
  });

  it("idempotent — already-fixed stays fixed; no-op when the run has no findings", () => {
    const already = [mk(gateBlockerFindingId("r1"), "fixed")];
    expect(withRunBlockersResolved(already, "r1")).toEqual(already);
    expect(withRunBlockersResolved([], "r1")).toEqual([]);
  });
});

describe("withGateBlockerFinding — pure idempotent finding builder (SM-06, AC2)", () => {
  it("APPENDS a testing:blocker (open) finding keyed by gate-<runId>, preserving existing findings", async () => {
    const existing: Finding[] = [
      { id: "sec-1", lens: "security", severity: "high", title: "x", status: "open" },
    ];
    const next = withGateBlockerFinding(existing, "a", "2 failed | 8 passed");

    expect(next).toHaveLength(2);
    expect(next[0]).toBe(existing[0]); // untouched
    expect(next[1]).toMatchObject({
      id: gateBlockerFindingId("a"),
      lens: "testing",
      severity: "blocker",
      status: "open",
      title: "merge gate falhou",
      detail: "2 failed | 8 passed",
    });
  });

  it("REFRESHES the same finding in place on a re-fail (idempotent — never duplicates)", async () => {
    const first = withGateBlockerFinding([], "a", "1 failed");
    const second = withGateBlockerFinding(first, "a", "3 failed now");

    expect(second).toHaveLength(1); // not stacked
    expect(second[0].id).toBe(gateBlockerFindingId("a"));
    expect(second[0].detail).toBe("3 failed now"); // detail refreshed
    expect(second[0].status).toBe("open"); // re-opened even if the operator had touched it
  });

  it("re-opens a previously-resolved gate finding when the gate fails again", async () => {
    const resolved: Finding[] = [
      { id: gateBlockerFindingId("a"), lens: "testing", severity: "blocker", title: "merge gate falhou", status: "fixed" },
    ];
    const next = withGateBlockerFinding(resolved, "a", "regressed");

    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("open"); // back to blocking
    expect(next[0].severity).toBe("blocker");
  });

  it("caps the detail at 800 chars and omits it entirely when the log is empty", async () => {
    const long = "x".repeat(1000);
    const withLong = withGateBlockerFinding([], "a", long);
    expect(withLong[0].detail).toHaveLength(800);

    const withEmpty = withGateBlockerFinding([], "b", "");
    expect(withEmpty[0].detail).toBeUndefined();
  });
});

describe("withConflictedBranchFinding — pure idempotent finding builder (SM-07)", () => {
  it("APPENDS a low/general finding keyed by conflicted-<runId>, preserving existing findings", async () => {
    const existing: Finding[] = [
      { id: "x", lens: "security", severity: "blocker", title: "keep me", status: "open" },
    ];
    const next = withConflictedBranchFinding(existing, "a", "conflicted/run/a", 1);

    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(existing[0]); // untouched
    expect(next[1]).toMatchObject({
      id: conflictedBranchFindingId("a"),
      lens: "general",
      severity: "low", // does NOT block hasNoBlockers
      status: "open",
    });
    expect(next[1].title).toContain("conflicted/run/a");
    expect(next[1].detail).toContain("Tentativa 1");
  });

  it("REFRESHES the same finding in place on a re-stamp (idempotent — never duplicates)", async () => {
    const first = withConflictedBranchFinding([], "a", "conflicted/run/a", 1);
    const second = withConflictedBranchFinding(first, "a", "conflicted/run/a", 2);

    expect(second).toHaveLength(1); // same id → updated, not appended
    expect(second[0].detail).toContain("Tentativa 2");
  });
});

describe("makeMergeQueue — resolveGateFailed (operator unblock)", () => {
  it("`retry` resets the paused entry to `waiting` and RE-RUNS the gate (e.g. the run was re-driven)", async () => {
    let pass = false;
    const { gate, branches } = recordingGate(() => ({ passed: pass, log: pass ? "green" : "red" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");

    pass = true; // the operator re-drove the companion run; the gate now passes
    await mq.resolveGateFailed("a", "retry");
    await mq.whenIdle();

    expect(branches).toEqual(["run/a", "run/a"]); // the gate ran a SECOND time on retry
    expect(mq.getSnapshot().entries[0]).toMatchObject({ status: "done", gateLog: undefined });
  });

  it("`abort` PRESERVES the code branch (WS-2.1 conflicted/), marks `failed`, and RESUMES the rest of the queue", async () => {
    const { gate } = recordingGate((br) => ({ passed: br !== "run/a", log: "x" })); // a fails, b passes
    const { exec, calls } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");
    expect(mq.getSnapshot().entries[1].status).toBe("done"); // b DRAINED past parked a → gated + merged (parking)

    await mq.resolveGateFailed("a", "abort");
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ status: "failed", runId: "a" });
    expect(snap.entries[0].failureReason).toContain("abortou");
    expect(snap.entries[1].status).toBe("done"); // b gated + integrated on resume
    // WS-2.1: a gate-failed branch carried code (the gate ran on it) → abort PRESERVES it (conflicted/),
    // never a blind -D. Here the base is unknown so the fail-safe preserves regardless.
    expect(snap.entries[0].branch).toBe("conflicted/run/a");
    expect(calls.some((c) => c.includes('branch -m "run/a" "conflicted/run/a"'))).toBe(true);
    expect(calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(false); // never destroyed
  });

  it("is a no-op on an unknown / non-gate-failed runId", async () => {
    const { gate } = recordingGate(() => ({ passed: true, log: "" }));
    const { exec } = makeRealisticExec();
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });
    await mq.enqueueMerge(input());
    await mq.whenIdle();
    await mq.resolveGateFailed("does-not-exist", "retry"); // must not throw
    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });
});

describe("makeMergeQueue — boot recovery resets a crashed gate (gate-running → gate-failed)", () => {
  it("a `gate-running` entry interrupted by a restart is reset to `gate-failed` for the operator", async () => {
    const seed: MergeQueueEntry[] = [
      { runId: "a", board: "acme", cardId: "c", branch: "run/a", status: "gate-running", enqueuedAt: 1, mergeStartedAt: 2 },
    ];
    const { store } = makeStore(seed);
    // A crashed gate runs BEFORE the merge-back, so its run branch was never integrated:
    // `merge-base --is-ancestor run/a HEAD` must report "not ancestor" (exit 1). Otherwise the
    // recover() prune (which now also covers gate-failed) would read the branch as already
    // integrated (b) and drop the freshly-reset entry — masking the gate-failed the operator
    // must still see. Mirrors makeRealisticExec's is-ancestor invariant.
    const { exec } = makeExec([{ match: "is-ancestor", outcome: { code: 1 } }]);
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary).toMatchObject({ loaded: 1, resetGateFailed: 1, waiting: 0, pruned: 0 });
    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("gate-failed");
    expect(entry.gateLog).toContain("reinício");
  });
});

describe("parseVitestFailures — tolerant vitest --reporter=json parser", () => {
  it("extracts failed tests (file + fullName + first message line), ignoring passed ones", () => {
    const json = JSON.stringify({
      testResults: [
        {
          name: "/r/a.test.ts",
          assertionResults: [
            { fullName: "A > ok", status: "passed", failureMessages: [] },
            { fullName: "A > broken", status: "failed", failureMessages: ["AssertionError: nope\n  at line 9"] },
          ],
        },
        { name: "/r/b.test.ts", assertionResults: [{ fullName: "B > also broken", status: "failed", failureMessages: [] }] },
      ],
    });
    expect(parseVitestFailures(json)).toEqual([
      { file: "/r/a.test.ts", name: "A > broken", message: "AssertionError: nope" },
      { file: "/r/b.test.ts", name: "B > also broken", message: "" },
    ]);
  });

  it("returns [] when there is no parseable JSON (crash/OOM before the reporter wrote)", () => {
    expect(parseVitestFailures("")).toEqual([]);
    expect(parseVitestFailures("heap out of memory\nKilled")).toEqual([]);
  });
});

describe("makeDefaultGateRunner — staging worktree lifecycle", () => {
  // A no-op fs so node_modules provisioning links to nothing (the staging tree is fully faked via exec).
  const noopFs: WorktreeFs = {
    listDirs: async () => [],
    // A unidade de gate PRECISA existir na árvore medida — o runner agora recusa fail-closed quando
    // ela não existe (uma cópia morta, ou um pacote que o cutover deixou noutra árvore, reprovaria por
    // módulo não resolvido e o operador leria como flake). A fixture passa a modelar isso: o pacote
    // existe no staging, o resto não.
    isDir: async (p: string) => p.includes("packages/storymap-ui"),
    // tsconfig.json existe em toda unidade — o typecheck só roda quando o teste o INJETA.
    isFile: async (p: string) => p.endsWith("tsconfig.json"),
    linkDir: async () => {},
    unlinkDir: async () => false,
  };

  // vitest --reporter=json stdout for a set of failing tests (empty list = all green).
  function vitestJson(failures: Array<{ file: string; name: string; msg?: string }>): string {
    return JSON.stringify({
      testResults: failures.map((f) => ({
        name: f.file,
        assertionResults: [{ fullName: f.name, status: "failed", failureMessages: [f.msg ?? "AssertionError: boom"] }],
      })),
    });
  }

  // Command-aware exec for the gate's git plumbing + the (json-reporter) check. `mergedFailures` are the
  // failures on main+branch; `baseFailures` (after the attribution `git reset --hard`) are pre-existing.
  function makeGateExec(
    opts: {
      mergeFails?: boolean;
      addFails?: boolean;
      mergedFailures?: Array<{ file: string; name: string; msg?: string }>;
      baseFailures?: Array<{ file: string; name: string; msg?: string }>;
      crash?: boolean; // non-zero exit with NO parseable JSON (OOM/setup) → the conservative-block path
      /** saída do typecheck na árvore MESCLADA; ausente = verde (exit 0) */
      mergedTscOut?: string;
      /** saída do typecheck na BASE (após o reset de atribuição); ausente = verde */
      baseTscOut?: string;
    } = {},
  ) {
    const calls: Array<{ cmd: string; cwd?: string; maxBuffer?: number; env?: NodeJS.ProcessEnv }> = [];
    // WS1.3 — model TWO shas so the flaky retry (reset back to the MERGED sha, re-run the full suite) is
    // distinguishable from the attribution BASE run (reset to the base sha): rev-parse returns basesha0000
    // before the merge and mergedsha1111 after; a reset targets one or the other and flips `onBase`.
    let onBase = false;
    let merged = false;
    const exec: ExecFn = async (cmd, o) => {
      calls.push({ cmd, cwd: o?.cwd, maxBuffer: o?.maxBuffer, env: o?.env });
      if (cmd.includes("git worktree add") && opts.addFails) {
        throw Object.assign(new Error("fatal: worktree add"), { stderr: "fatal: worktree add" });
      }
      if (cmd.includes("git merge --no-ff")) {
        if (opts.mergeFails) throw Object.assign(new Error("CONFLICT"), { stderr: "CONFLICT (content) in foo.ts" });
        merged = true; // the run branch is now merged into staging → HEAD is the merged sha
        return { stdout: "", stderr: "" };
      }
      if (cmd.includes("git rev-parse HEAD")) return { stdout: merged ? "mergedsha1111\n" : "basesha0000\n", stderr: "" };
      if (cmd.includes("git reset --hard")) {
        onBase = cmd.includes("basesha0000"); // reset to base → BASE run; reset to merged → MERGED run again
        return { stdout: "", stderr: "" };
      }
      if (cmd.includes("tsc --noEmit")) {
        const out = onBase ? opts.baseTscOut : opts.mergedTscOut;
        if (out === undefined) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("typecheck failed"), { stdout: out, stderr: "" });
      }
      if (cmd.includes("vitest run")) {
        if (opts.crash) throw Object.assign(new Error("check failed"), { stdout: "heap out of memory" });
        const fails = onBase ? (opts.baseFailures ?? []) : (opts.mergedFailures ?? []);
        if (fails.length === 0) return { stdout: vitestJson([]), stderr: "" };
        throw Object.assign(new Error("check failed"), { stdout: vitestJson(fails) });
      }
      return { stdout: "", stderr: "" };
    };
    // Em qual árvore a staging está AGORA (o typecheck re-sonda tsconfig.json após o reset para a
    // base — um fs fake usa isto para modelar "o tsconfig ESTREIA no delta": existe na mesclada, não na base).
    const treeAtual = () => (onBase ? "base" : "mesclada");
    return { exec, calls, treeAtual };
  }

  // ── A unidade de gate tem de EXISTIR na árvore medida ────────────────────────────────────────────
  // O fallback do gate é o pacote da própria ferramenta, e ele deixa de ser garantido no instante em
  // que a ferramenta passa a morar noutro checkout: `<stage>/packages/storymap-ui` vira uma cópia morta
  // (ou some). Sem esta medição o gate rodaria a suíte de uma árvore SEM o runner de teste instalado e
  // reprovaria por módulo não resolvido — que o operador lê como flake. Flake é o disfarce perfeito
  // para um gate que parou de medir, e por isso a recusa precisa se ANUNCIAR como recusa.
  it("unidade AUSENTE na árvore medida ⇒ RECUSA anunciada, e a suíte não roda", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const semPacote: WorktreeFs = { ...noopFs, isDir: async () => false };
    const runner = makeDefaultGateRunner(semPacote);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    // A propriedade que importa: NADA foi executado como teste. Um gate que "reprova rodando" numa
    // árvore errada gasta minutos e mente sobre o motivo.
    expect(calls.some((c) => c.cmd.includes("vitest run"))).toBe(false);
    // e o log diz que é RECUSA, nomeando o caminho e o remédio
    expect(res.log ?? "").toMatch(/RECUSADO \(não reprovado\)/);
    expect(res.log ?? "").toContain("packages/storymap-ui");
    expect(res.log ?? "").toMatch(/mergeGate\.scope\.packages/);
  });

  // ── O FALLBACK DECLARADO PELO ALVO (`mergeGate.scope.fallback`) ─────────────────────────────────
  // POR QUE ESTES TESTES EXISTEM, e não só o `tsc`: capacidade declarada sem PRODUTOR é a forma nº1 de
  // mentira de configuração nesta base — a chave aparece no settings.yaml, o operador conclui que ela
  // vale, e o coerce a dropou (foi o que aconteceu com `deploy.surfaces`, inerte por dias). Estes medem
  // a metade do USO; a metade da CHEGADA está em config-env.test.ts.
  it("[PRODUTOR] um fallback DECLARADO decide onde a suíte roda — e o default histórico nem é consultado", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    // Esta árvore SÓ tem o pacote declarado. Se o código ignorasse a declaração e usasse o default, o
    // `isDir` reprovaria e viria a RECUSA — então o teste distingue de verdade os dois caminhos.
    const soODeclarado: WorktreeFs = { ...noopFs, isDir: async (p: string) => p.includes("packages/acmeapp") };
    const runner = makeDefaultGateRunner(soODeclarado);

    const res = await runner({
      exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000,
      scope: { fallback: { cwd: "packages/acmeapp" } },
    });

    expect(res.passed).toBe(true);
    expect(calls.some((c) => c.cmd.includes("vitest run") && (c.cwd ?? "").includes("packages/acmeapp"))).toBe(true);
    expect(calls.some((c) => (c.cwd ?? "").includes("storymap-ui"))).toBe(false);
  });

  it("[PRODUTOR] o `command` do fallback declarado vence o checkCommand global", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const soODeclarado: WorktreeFs = { ...noopFs, isDir: async (p: string) => p.includes("packages/acmeapp") };
    const runner = makeDefaultGateRunner(soODeclarado);

    await runner({
      exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000,
      scope: { fallback: { cwd: "packages/acmeapp", command: "vitest run --silent" } },
    });

    expect(calls.some((c) => c.cmd.includes("vitest run --silent"))).toBe(true);
  });

  it("[NÃO-VACUIDADE] a RECUSA nomeia o caminho DECLARADO, não o default — senão o operador procura o lugar errado", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const nenhum: WorktreeFs = { ...noopFs, isDir: async () => false };
    const runner = makeDefaultGateRunner(nenhum);

    const res = await runner({
      exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000,
      scope: { fallback: { cwd: "packages/acmeapp" } },
    });

    expect(res.passed).toBe(false);
    expect(calls.some((c) => c.cmd.includes("vitest run"))).toBe(false);
    expect(res.log ?? "").toContain("packages/acmeapp");
    expect(res.log ?? "", "a recusa citou o default em vez do declarado").not.toContain("packages/storymap-ui");
  });


  // ── TYPECHECK — pergunta binária por árvore, canal próprio (`mergeGate.typecheck`) ───────────────
  // POR QUE por unidade e nunca por chave de falha: expressar o tsc como GateFailure já desarmou uma
  // guarda nesta base (a falha compartilhada aparecia nas duas rodadas, a atribuição a creditava à
  // base e o gate aprovava). E POR QUE estes produtores existem: a suíte transpila sem checar tipo —
  // foi assim que 2× TS2353 entraram na main em silêncio; quem os achava era a extração OSS, que está
  // de saída. A metade da CHEGADA (settings.yaml → config) está em config-env.test.ts.
  const TC = { enabled: true, command: "bunx tsc --noEmit" };

  it("[PRODUTOR] erro de tipo NOVO reprova ANTES da suíte, nomeando a unidade e o diagnóstico", async () => {
    const { exec, calls } = makeGateExec({
      mergedTscOut: "src/x.ts(3,5): error TS2353: Object literal may only specify known properties.",
      // baseTscOut ausente = base VERDE → o delta introduziu o erro
    });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBeUndefined();
    expect(res.log).toContain("TS2353");
    expect(res.log).toMatch(/NOVO/);
    expect(res.log).toContain("packages/storymap-ui");
    // a propriedade cara: falhou RÁPIDO — a suíte (~2min de p90) nunca chegou a rodar
    expect(calls.some((c) => c.cmd.includes("vitest run"))).toBe(false);
  });

  it("[PRODUTOR] erro PRÉ-EXISTENTE na base é perdoado e NOMEADO — e a árvore mesclada é RESTAURADA antes da suíte", async () => {
    const err = "src/y.ts(9,1): error TS2345: Argument of type 'string' is not assignable.";
    const { exec, calls } = makeGateExec({
      mergedTscOut: err,
      baseTscOut: err, // a base também está vermelha → o erro não é deste card
      // Suíte: mesclada VERDE, base vermelha. Se a restauração pós-atribuição falhasse em silêncio, a
      // suíte leria a BASE e o log diria "nenhuma falha NOVA" — o "✓ suíte verde" distingue os caminhos.
      baseFailures: [{ file: "a.test.ts", name: "x" }],
      mergedFailures: [],
    });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(true);
    expect(res.log).toContain("✓ suíte verde");
    expect(res.log).toMatch(/já vermelha\(s\) na BASE/);
    // a atribuição de fato mediu a base E voltou: reset → base, depois reset → mesclada, nessa ordem
    const resets = calls.filter((c) => c.cmd.includes("git reset --hard")).map((c) => c.cmd);
    expect(resets.some((c) => c.includes("basesha0000"))).toBe(true);
    expect(resets[resets.length - 1]).toContain("mergedsha1111");
  });

  it("[NÃO-VACUIDADE] no caminho verde o typecheck RODOU (no cwd da unidade) e o log o registra", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(true);
    expect(calls.some((c) => c.cmd.includes("tsc --noEmit") && (c.cwd ?? "").includes("packages/storymap-ui"))).toBe(true);
    expect(res.log).toContain("typecheck: verde em 1 unidade(s)");
  });

  it("unidade SEM tsconfig.json é PULADA com aviso — `bunx tsc` nunca roda num pacote sem contrato de tipo", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const semTsconfig: WorktreeFs = { ...noopFs, isFile: async () => false };
    const runner = makeDefaultGateRunner(semTsconfig);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(true);
    expect(calls.some((c) => c.cmd.includes("tsc --noEmit"))).toBe(false);
    // o pulo se ANUNCIA no log — silêncio leria como "medido"
    expect(res.log).toContain("PULADO (sem tsconfig.json)");
  });

  it("[PRODUTOR] base que NÃO RODOU (vermelha sem diagnóstico) JAMAIS perdoa — bloqueio conservador nomeado", async () => {
    // O furo que a revisão adversarial achou (3 lentes convergiram): a régua "não rodou ≠ reprovou" só
    // valia no lado MESCLADO. Uma base morta por OOM/timeout/ENOENT virava "base vermelha" e PERDOAVA
    // o erro de tipo genuinamente novo — o falso-pass exato que a mudança existe para matar.
    const { exec, calls } = makeGateExec({
      mergedTscOut: "src/x.ts(3,5): error TS2353: Object literal may only specify known properties.",
      baseTscOut: "bunx: command not found", // a base CRASHOU — não foi medida
    });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("TS2353");
    expect(res.log).toMatch(/SEM diagnóstico de tipo .*bloqueio conservador/);
    expect(res.log ?? "", "uma base não-medida foi anunciada como vermelha").not.toMatch(/já vermelha\(s\) na BASE/);
    expect(calls.some((c) => c.cmd.includes("vitest run"))).toBe(false);
  });

  it("[PRODUTOR] tsconfig.json que ESTREIA no delta não é perdoável — não existe base para perdoar", async () => {
    // Segundo furo da revisão: sondar o contrato só na MESCLADA deixa o tsc da base medir OUTRO projeto
    // (ou emitir TS18003 — que TEM código TS e casaria o sentinela) e perdoar a estreia vermelha.
    const { exec, calls, treeAtual } = makeGateExec({
      mergedTscOut: "src/x.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      baseTscOut: "error TS18003: No inputs were found in config file.", // o que a base emitiria se rodasse
    });
    const soNaMesclada: WorktreeFs = { ...noopFs, isFile: async (p: string) => p.endsWith("tsconfig.json") && treeAtual() === "mesclada" };
    const runner = makeDefaultGateRunner(soNaMesclada);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("ESTREIA neste delta");
    expect(res.log).toContain("TS2322");
    // e o tsc NUNCA rodou na base — a unidade sem contrato lá é filtrada antes de executar
    const tscNaBase = calls.filter((c) => c.cmd.includes("tsc --noEmit")).length;
    expect(tscNaBase).toBe(1); // só a rodada mesclada
  });

  it("typecheck que NÃO RODOU (saída sem diagnóstico TS) é INCONCLUSIVO — nunca 'seus tipos quebraram'", async () => {
    const { exec, calls } = makeGateExec({ mergedTscOut: "bunx: command not found" });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

    expect(res.passed).toBe(false);
    expect(res.inconclusive).toBe(true);
    expect(res.log).toContain("INCONCLUSIVO");
    expect(calls.some((c) => c.cmd.includes("vitest run"))).toBe(false); // fail-closed, sem gastar a suíte
  });

  it("sem `typecheck` injetado, NENHUM tsc roda — o default ligado mora na config, não no runner", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(true);
    expect(calls.some((c) => c.cmd.includes("tsc"))).toBe(false);
  });

  // ── O ENV que chega ao exec do gate é SANEADO — produtor, não intenção ─────────────────────────
  // Sem `env` nas opções, promisify(child_process.exec) repassa o process.env do SERVIÇO: sob systemd
  // isso é NODE_ENV=production, e o vitest do alvo roda em modo produção («act(...) is not supported in
  // production builds of React» em todo teste de React — verde num shell manual). Medido num alvo real
  // em 2026-09-01: 55/55 verde com `env -u NODE_ENV`, 55/55 vermelho sem; e o painel acusava «main
  // VERMELHA: 12 pré-existentes» de um vermelho que não existia. Este teste FALHA se a suíte OU o tsc
  // forem spawnados sem env, ou com um env que ainda carregue a variável — e falha também se o
  // saneador ESVAZIAR o env (o filho precisa achar o bun): uma chave neutra tem de atravessar.
  it("[PRODUTOR] a suíte E o tsc recebem env SANEADO — sem NODE_ENV, __NEXT_* nem token MCP; o resto atravessa", async () => {
    const env = process.env as Record<string, string | undefined>;
    const antes = { NODE_ENV: env.NODE_ENV, NEXT: env.__NEXT_PROCESSED_ENV, TOK: env.AGILEHARNESS_MCP_TOKEN, PROBE: env.GATE_ENV_PROBE };
    env.NODE_ENV = "production";
    env.__NEXT_PROCESSED_ENV = "true";
    env.AGILEHARNESS_MCP_TOKEN = "segredo-que-nao-pode-viajar";
    env.GATE_ENV_PROBE = "atravessa";
    try {
      const { exec, calls } = makeGateExec({ mergedFailures: [] });
      const runner = makeDefaultGateRunner(noopFs);

      const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, typecheck: TC });

      expect(res.passed).toBe(true);
      const suite = calls.filter((c) => c.cmd.includes("vitest run"));
      const tsc = calls.filter((c) => c.cmd.includes("tsc --noEmit"));
      expect(suite.length).toBeGreaterThan(0);
      expect(tsc.length).toBeGreaterThan(0);
      for (const c of [...suite, ...tsc]) {
        expect(c.env, `sem env ⇒ herda o do serviço: ${c.cmd}`).toBeDefined();
        expect(c.env!.NODE_ENV).toBeUndefined();
        expect(c.env!.__NEXT_PROCESSED_ENV).toBeUndefined();
        expect(c.env!.AGILEHARNESS_MCP_TOKEN).toBeUndefined();
        expect(c.env!.GATE_ENV_PROBE).toBe("atravessa");
      }
    } finally {
      for (const [k, v] of [["NODE_ENV", antes.NODE_ENV], ["__NEXT_PROCESSED_ENV", antes.NEXT], ["AGILEHARNESS_MCP_TOKEN", antes.TOK], ["GATE_ENV_PROBE", antes.PROBE]] as const) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
  });

  it("PASS: adds a staging worktree, merges the run branch there, runs the check, then cleans up", async () => {
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(true);
    expect(calls.some((c) => c.cmd.includes("git worktree add") && c.cmd.includes("gate-x") && c.cmd.includes("gate/x"))).toBe(true);
    // story-zdeajs: the gate now merges SNAP-AWARE — phase 1 is `--no-commit` so it can resolve binary
    // snaps by hand, then completes with an explicit `git commit` (clean case → no snap conflict).
    expect(calls.some((c) => c.cmd.includes('git merge --no-ff --no-commit "run/x"'))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("git commit --no-verify --no-edit"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("vitest run") && c.cmd.includes("--reporter=json") && (c.cwd ?? "").includes("storymap-ui"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("git reset --hard"))).toBe(false); // green → no attribution re-run
    expect(calls.some((c) => c.cmd.includes("git worktree remove") && c.cmd.includes("gate-x"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes('git branch -D "gate/x"'))).toBe(true);
  });

  it("the check runs with a maxBuffer ABOVE exec's 1 MiB default — a big JSON report must not overflow", async () => {
    // Regression (story-cu4326): the --reporter=json report carries EVERY test, so at 2.7k tests it weighed
    // 1,109,888 bytes — past `child_process.exec`'s 1 MiB default maxBuffer. The overflow REJECTED the exec
    // with a truncated stdout even though the suite was GREEN (exit 0), so the gate saw an unparseable report,
    // could attribute nothing, and blocked EVERY code-touching card. The ceiling must clear that default.
    const NODE_EXEC_DEFAULT_MAX_BUFFER = 1024 * 1024;
    const { exec, calls } = makeGateExec({ mergedFailures: [] });
    const runner = makeDefaultGateRunner(noopFs);

    await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    const check = calls.find((c) => c.cmd.includes("vitest run") && c.cmd.includes("--reporter=json"));
    expect(check).toBeDefined();
    expect(check?.maxBuffer).toBeGreaterThan(NODE_EXEC_DEFAULT_MAX_BUFFER);
  });

  it("STAGING MERGE CONFLICT: reports passed:false WITHOUT running the check, and still cleans up", async () => {
    const { exec, calls } = makeGateExec({ mergeFails: true });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("staging merge falhou");
    expect(calls.some((c) => c.cmd === "vitest run")).toBe(false); // check never ran
    expect(calls.some((c) => c.cmd.includes("git worktree remove"))).toBe(true); // cleaned up regardless
  });

  it("NEW failure (introduced by the branch, green on base) → passed:false with an ACTIONABLE log", async () => {
    const { exec, calls } = makeGateExec({
      mergedFailures: [{ file: "src/components/Foo.test.ts", name: "Foo > renders the thing", msg: "AssertionError: expected 1 to be 2" }],
      baseFailures: [],
    });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("1 teste(s) quebrado(s) por este card");
    expect(res.log).toContain("Foo > renders the thing"); // names the REAL failing test, not a stderr head
    expect(calls.some((c) => c.cmd.includes("git reset --hard"))).toBe(true); // attribution re-run happened
  });

  it("ATTRIBUTION: every failure already red on base → passed:true (card NOT blamed for a red main)", async () => {
    const fail = { file: "src/lib/storymap/runner/engine.test.ts", name: "runSkill > rejects a non-slug id", msg: "boom" };
    const { exec } = makeGateExec({ mergedFailures: [fail], baseFailures: [fail] });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(true);
    expect(res.log).toContain("pré-existente");
  });

  it("CRASH (non-zero exit, no parseable JSON) → passed:false, blocks safely WITHOUT attributing", async () => {
    const { exec, calls } = makeGateExec({ crash: true });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("heap out of memory");
    expect(calls.some((c) => c.cmd.includes("git reset --hard"))).toBe(false); // no attribution on an unparseable crash
  });

  it("WORKTREE ADD FAILS: reports a gate setup failure", async () => {
    const { exec } = makeGateExec({ addFails: true });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("gate setup falhou");
  });
});

describe("makeDefaultGateRunner — affected-only selection (perf)", () => {
  const noopFs: WorktreeFs = {
    listDirs: async () => [],
    // A unidade de gate PRECISA existir na árvore medida — o runner agora recusa fail-closed quando
    // ela não existe (uma cópia morta, ou um pacote que o cutover deixou noutra árvore, reprovaria por
    // módulo não resolvido e o operador leria como flake). A fixture passa a modelar isso: o pacote
    // existe no staging, o resto não.
    isDir: async (p: string) => p.includes("packages/storymap-ui"),
    isFile: async () => false,
    linkDir: async () => {},
    unlinkDir: async () => false,
  };

  // A minimal gate exec: green suite, a controllable changed-file list for the affected diff.
  function makeExec(changedFiles: string[]) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    let merged = false;
    const exec: ExecFn = async (cmd, o) => {
      calls.push({ cmd, cwd: o?.cwd });
      if (cmd.includes("git merge --no-ff")) {
        merged = true;
        return { stdout: "", stderr: "" };
      }
      if (cmd.includes("git rev-parse HEAD")) return { stdout: merged ? "mergedsha1111\n" : "basesha0000\n", stderr: "" };
      if (cmd.includes("git diff --name-only")) return { stdout: changedFiles.join("\n"), stderr: "" };
      if (cmd.includes("vitest")) return { stdout: JSON.stringify({ testResults: [] }), stderr: "" }; // green
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  const affected = {
    enabled: true,
    command: "bunx vitest --changed {base} --run --passWithNoTests",
    fullSuitePaths: ["packages/storymap-ui/src/lib/storymap/types.ts"],
  };
  const checkOf = (calls: Array<{ cmd: string }>) => calls.find((c) => c.cmd.includes("vitest") && c.cmd.includes("--reporter=json"))?.cmd;

  it("non-blast diff → runs the AFFECTED command (`--changed <baseSha>`), not the full suite", async () => {
    const { exec, calls } = makeExec(["packages/storymap-ui/src/lib/terminal/enrich.ts"]);
    const res = await makeDefaultGateRunner(noopFs)({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, affected });
    expect(res.passed).toBe(true);
    const check = checkOf(calls);
    expect(check).toContain("--changed basesha0000");
    expect(check).toContain("--passWithNoTests");
  });

  it("a blast-radius changed file → falls back to the FULL suite", async () => {
    const { exec, calls } = makeExec(["packages/storymap-ui/src/lib/storymap/types.ts"]);
    const res = await makeDefaultGateRunner(noopFs)({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000, affected });
    expect(res.passed).toBe(true);
    const check = checkOf(calls);
    expect(check).toContain("vitest run --reporter=json");
    expect(check).not.toContain("--changed");
  });

  it("affected ausente → suíte COMPLETA (o delta segue sendo lido: agora ele também decide o ESCOPO, P-7)", async () => {
    const { exec, calls } = makeExec(["packages/storymap-ui/src/lib/terminal/enrich.ts"]);
    const res = await makeDefaultGateRunner(noopFs)({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });
    expect(res.passed).toBe(true);
    // O que "affected ausente" garante continua garantido: NENHUMA seleção entra no comando.
    expect(checkOf(calls)).toContain("vitest run --reporter=json");
    expect(checkOf(calls)).not.toContain("--changed");
    // Mudou o motivo de ler o diff, não o veredito. Ele era trabalho desperdiçado quando affected estava
    // desligado; agora tem um segundo leitor — `resolveGateUnits`, que responde "de qual pacote rodar a
    // suíte" e substituiu o `packages/storymap-ui` literal que morava no código do gate.
    expect(calls.some((c) => c.cmd.includes("git diff --name-only") && c.cmd.includes("basesha0000"))).toBe(true);
  });
});

// --- story-zdeajs (CRITICAL prod fix): the integration gate's staging merge is SNAP-AWARE ----------
// Production runs staging.enabled=TRUE + mergeGate.enabled=TRUE, so makeDefaultGateRunner is the LIVE
// path. It merged the run branch into the staging worktree with a BARE `git merge --no-ff`, which ABORTS
// on a binary `*.snap` divergence (.gitattributes: `*.snap binary`) — false-parking a CLEAN card whose
// only divergence is a regenerated snapshot, BEFORE integrateSplit's own snap-regen ever runs. The gate
// now resolves a snap-ONLY conflict by regenerating from the merged source (`bunx vitest run -u` in the
// staging tree) and then runs the validation suite against fresh snaps.
describe("makeDefaultGateRunner — SNAP-AWARE staging merge (story-zdeajs CRITICAL)", () => {
  const noopFs: WorktreeFs = {
    listDirs: async () => [],
    // A unidade de gate PRECISA existir na árvore medida — o runner agora recusa fail-closed quando
    // ela não existe (uma cópia morta, ou um pacote que o cutover deixou noutra árvore, reprovaria por
    // módulo não resolvido e o operador leria como flake). A fixture passa a modelar isso: o pacote
    // existe no staging, o resto não.
    isDir: async (p: string) => p.includes("packages/storymap-ui"),
    isFile: async () => false,
    linkDir: async () => {},
    unlinkDir: async () => false,
  };
  function vitestJson(failures: Array<{ file: string; name: string; msg?: string }>): string {
    return JSON.stringify({
      testResults: failures.map((f) => ({
        name: f.file,
        assertionResults: [{ fullName: f.name, status: "failed", failureMessages: [f.msg ?? "AssertionError: boom"] }],
      })),
    });
  }
  // A staging-merge exec where the phase-1 `git merge --no-ff --no-commit` CONFLICTS, the unmerged paths
  // are `unmergedPaths`, the snap-regen `bunx vitest run -u` succeeds unless `regenFails`, and the gate's
  // validation `vitest run --reporter=json` is green.
  function makeSnapGateExec(opts: { unmergedPaths: string[]; regenFails?: boolean }) {
    const calls: Array<{ cmd: string; cwd?: string }> = [];
    const exec: ExecFn = async (cmd, o) => {
      calls.push({ cmd, cwd: o?.cwd });
      if (cmd.includes("git rev-parse HEAD")) return { stdout: "basesha0000\n", stderr: "" };
      if (cmd.includes("git merge --no-ff --no-commit")) {
        // Phase 1 conflicts (a binary *.snap can't be textually merged).
        throw Object.assign(new Error("CONFLICT"), { stderr: "CONFLICT (content): merge conflict in __snapshots__/x.snap" });
      }
      if (cmd.includes("diff --name-only --diff-filter=U")) {
        return { stdout: opts.unmergedPaths.join("\n") + "\n", stderr: "" };
      }
      if (cmd.includes("bunx vitest run -u")) {
        if (opts.regenFails) throw Object.assign(new Error("snap regen exploded"), { stderr: "Error: a real red test the regen can't fix" });
        return { stdout: "", stderr: "" }; // regen succeeded
      }
      if (cmd.includes("vitest run") && cmd.includes("--reporter=json")) {
        return { stdout: vitestJson([]), stderr: "" }; // the validation suite is green with fresh snaps
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  it("SNAP-ONLY conflict → REGENERATES from the merged source, runs the suite, and PASSES (no false-park)", async () => {
    const { exec, calls } = makeSnapGateExec({ unmergedPaths: ["packages/storymap-ui/src/__snapshots__/board.snap"] });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(true); // FAILS without the fix (bare merge aborted → "staging merge falhou")
    // it took the run's side of the snap, then regenerated it from the merged source.
    expect(calls.some((c) => c.cmd.includes('git checkout --theirs -- "packages/storymap-ui/src/__snapshots__/board.snap"'))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("bunx vitest run -u") && (c.cwd ?? "").includes("storymap-ui"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("git commit --no-verify --no-edit"))).toBe(true);
    // and THEN ran the validation suite against the fresh snaps.
    expect(calls.some((c) => c.cmd.includes("vitest run") && c.cmd.includes("--reporter=json"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("git merge --abort"))).toBe(false); // resolved, NOT aborted
    expect(calls.some((c) => c.cmd.includes("git worktree remove"))).toBe(true); // cleaned up
  });

  it("snap regen `vitest -u` THROWS → blocks the gate (passed:false) and ABORTS the merge (no half-merge)", async () => {
    const { exec, calls } = makeSnapGateExec({ unmergedPaths: ["packages/storymap-ui/src/__snapshots__/board.snap"], regenFails: true });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("staging snap regen falhou"); // a genuine red test is NOT papered over
    expect(res.log).toContain("a real red test"); // surfaces the regen error detail
    expect(calls.some((c) => c.cmd.includes("git merge --abort"))).toBe(true); // staging tip restored
    expect(calls.some((c) => c.cmd.includes("vitest run") && c.cmd.includes("--reporter=json"))).toBe(false); // suite never ran on a bad regen
    expect(calls.some((c) => c.cmd.includes("git worktree remove"))).toBe(true); // cleaned up regardless
  });

  it("a NON-snap path among the unmerged → a REAL conflict: aborts and reports `staging merge falhou` (NO regen)", async () => {
    const { exec, calls } = makeSnapGateExec({
      unmergedPaths: ["packages/storymap-ui/src/__snapshots__/board.snap", "packages/storymap-ui/src/lib/engine.ts"],
    });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("staging merge falhou"); // unchanged real-conflict behavior
    expect(calls.some((c) => c.cmd.includes("bunx vitest run -u"))).toBe(false); // NEVER regenerates on a real conflict
    expect(calls.some((c) => c.cmd.includes("git merge --abort"))).toBe(true);
  });

  it("Defect B1: a BOARD-DATA-only conflict is RESOLVED (take theirs) — a card .md can't fail the CODE gate; the suite runs and PASSES", async () => {
    // story-olr777: a run's card .md conflicted with main's copy in the gate's whole-branch merge and
    // hard-failed the CODE gate. A card can't affect `vitest`, so it must be resolved in the throwaway
    // staging tree, not park the card. Only genuine `packages/**` code may fail the gate.
    const { exec, calls } = makeSnapGateExec({ unmergedPaths: ["storymap/boards/acme/cards/story-olr777.md"] });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(true); // board data resolved → gate proceeds (FAILS before the fix: false-park)
    expect(calls.some((c) => c.cmd.includes('git checkout --theirs -- "storymap/boards/acme/cards/story-olr777.md"'))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("bunx vitest run -u"))).toBe(false); // board data → NO snap regen
    expect(calls.some((c) => c.cmd.includes("vitest run") && c.cmd.includes("--reporter=json"))).toBe(true); // suite ran
    expect(calls.some((c) => c.cmd.includes("git merge --abort"))).toBe(false); // resolved, NOT aborted
  });

  it("Defect B1: a real CODE conflict alongside a resolvable board-data conflict STILL aborts the gate (code can't be papered over)", async () => {
    const { exec, calls } = makeSnapGateExec({
      unmergedPaths: ["storymap/boards/acme/cards/story-olr777.md", "packages/storymap-ui/src/lib/engine.ts"],
    });
    const runner = makeDefaultGateRunner(noopFs);

    const res = await runner({ exec, repoRoot: "/repo", branch: "run/x", runId: "x", checkCommand: "vitest run", timeoutMs: 1000 });

    expect(res.passed).toBe(false);
    expect(res.log).toContain("staging merge falhou"); // a real packages/** conflict is a REAL conflict
    expect(calls.some((c) => c.cmd.includes("bunx vitest run -u"))).toBe(false); // never regenerates on a code conflict
    expect(calls.some((c) => c.cmd.includes("vitest run") && c.cmd.includes("--reporter=json"))).toBe(false); // suite never ran
    expect(calls.some((c) => c.cmd.includes("git merge --abort"))).toBe(true);
  });
});

// --- Re-drive on conflict (story-92ldyt) -----------------------------------
// A conflicting branch with a generating skill (`trigger`) under the re-drive cap is RE-DRIVEN — the
// train deletes the superseded branch, marks the entry `re-driving` (terminal), calls the handler so
// the engine re-runs the skill against the updated main, and KEEPS draining the queue. Ad-hoc branches
// (no trigger) or a lineage past the cap degrade to the legacy `conflict` pause.
describe("makeMergeQueue — re-drive on conflict (story-92ldyt)", () => {
  it("re-drives a conflicting branch with a trigger: PRESERVES the branch (rename), marks `re-driving`, calls the handler with driveCount+1, and KEEPS processing the queue (SM-07 AC1)", async () => {
    const redrives: Array<{ board: string; cardId: string; trigger: string; driveCount: number; conflictDetail: string; preservedBranch?: string }> = [];
    const findings: Array<{ board: string; cardId: string; runId: string; conflictedBranch: string; driveAttempt: number }> = [];
    // run/a conflicts on its merge; run/b merges clean — proving the train did NOT pause behind a.
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({
      exec,
      persistConflictedBranchFinding: async (board, cardId, runId, conflictedBranch, driveAttempt) => {
        findings.push({ board, cardId, runId, conflictedBranch, driveAttempt });
      },
    });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.enqueueMerge({ ...input({ runId: "b", branch: "run/b" }), trigger: "harness-do" });
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ status: "re-driving", runId: "a" });
    expect(snap.entries[1].status).toBe("done"); // queue kept going past the re-driven head (NOT paused)
    expect(redrives).toHaveLength(1);
    expect(redrives[0]).toMatchObject({ board: "acme", cardId: "story-1", trigger: "harness-do", driveCount: 1 });
    expect(redrives[0].conflictDetail).toContain("CONFLICT");
    // SM-07: the work is PRESERVED — renamed to conflicted/, NOT force-deleted.
    expect(calls.some((c) => c.includes('git branch -m "run/a" "conflicted/run/a"'))).toBe(true);
    expect(calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(false);
    // and a finding pointing to the preserved branch is stamped on the card with driveCount+1.
    expect(findings).toEqual([
      { board: "acme", cardId: "story-1", runId: "a", conflictedBranch: "conflicted/run/a", driveAttempt: 1 },
    ]);
  });

  it("falls back to `branch -D` when the rename fails (stale conflicted/ name) — legacy behavior, no stall (SM-07 AC1 fallback)", async () => {
    const redrives: unknown[] = [];
    const findings: unknown[] = [];
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a", renameFails: () => true });
    const { mq } = makeQueue({
      exec,
      persistConflictedBranchFinding: async (...args) => {
        findings.push(args);
      },
    });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0]).toMatchObject({ status: "re-driving", runId: "a" });
    expect(redrives).toHaveLength(1); // still re-driven — the rename failure does not stall the train
    expect(calls.some((c) => c.includes('git branch -m "run/a" "conflicted/run/a"'))).toBe(true); // attempted
    expect(calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(true); // fell back to delete
    expect(findings).toEqual([]); // no finding when the branch could not be preserved
  });

  it("a `persistConflictedBranchFinding` failure is non-fatal — the redrive still happens, branch stays preserved (SM-07)", async () => {
    const redrives: unknown[] = [];
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({
      exec,
      persistConflictedBranchFinding: async () => {
        throw new Error("disk full");
      },
    });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("re-driving");
    expect(redrives).toHaveLength(1); // finding failure never blocks the redrive
    expect(calls.some((c) => c.includes('git branch -m "run/a" "conflicted/run/a"'))).toBe(true);
    expect(calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(false); // NOT deleted on a finding error
  });

  it("does NOT auto-delete the preserved `conflicted/` branch when a subsequent redrive integrates (cleanup is deferred — SM-07 AC2)", async () => {
    // run/a conflicts → preserved as conflicted/run/a; run/a2 (the regenerated branch) merges clean.
    const redrives: Array<{ driveCount: number }> = [];
    const { exec, calls } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq } = makeQueue({ exec, persistConflictedBranchFinding: async () => {} });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.whenIdle();
    // the engine re-runs the skill and a fresh branch lands and integrates cleanly:
    await mq.enqueueMerge({ ...input({ runId: "a2", branch: "run/a2" }), trigger: "harness-do", driveCount: 1 });
    await mq.whenIdle();

    expect(mq.getSnapshot().entries.find((e) => e.runId === "a2")?.status).toBe("done");
    // conflicted/run/a survives — the operator (or a future age-based job) removes it, never the train.
    expect(calls.some((c) => c.includes('branch -D "conflicted/run/a"'))).toBe(false);
  });

  it("re-driving is TERMINAL (not live) — it never blocks the head of the queue", async () => {
    const { exec } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq, read } = makeQueue({ exec });
    mq.setRedriveHandler(async () => ({ ok: true }));

    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("re-driving");
    expect(mq.getSnapshot().processing).toBe(false); // settled, not paused on a live head
    expect(read()[0].status).toBe("re-driving"); // durable
  });

  it("audit #5 — a REJECTED re-spawn recovers the card to `conflict` (not stranded `re-driving`), pointing at the preserved branch", async () => {
    const { exec } = makeRealisticExec({ conflict: (br) => br === "run/a" });
    const { mq, read } = makeQueue({ exec });
    // The engine rejects the re-spawn (e.g. a manual run for this card is already in-flight).
    mq.setRedriveHandler(async () => ({ ok: false, reason: "in-flight", detail: "já está rodando/na fila" }));

    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.whenIdle();

    const e = read()[0];
    // Recovered to a live, operator-actionable state instead of terminal `re-driving`.
    expect(e.status).toBe("conflict");
    expect(e.branch).toBe("conflicted/run/a"); // points at the PRESERVED branch (where the work lives)
    expect(e.conflictDetail).toContain("re-drive recusado");
    expect(e.conflictDetail).toContain("in-flight");
    // resolveMergeConflict now works on it again (it ignores `re-driving`).
    expect(mq.getSnapshot().processing).toBe(false);
  });

  it("does NOT re-drive once the lineage hit the cap — degrades to `conflict` and PAUSES (graceful fallback, AC3)", async () => {
    const redrives: unknown[] = [];
    const { exec } = makeRealisticExec({ conflict: () => true }); // always conflicts
    const { mq } = makeQueue({ exec });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    // driveCount already AT the cap (maxRedrives default 2) → canRedrive false.
    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do", driveCount: 2 });
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0]).toMatchObject({ status: "conflict", runId: "a" });
    expect(redrives).toEqual([]); // never re-driven past the cap (no infinite loop)
  });

  it("does NOT re-drive an ad-hoc branch (no trigger) — degrades to `conflict` (AC4)", async () => {
    const redrives: unknown[] = [];
    const { exec, calls } = makeRealisticExec({ conflict: () => true });
    const { mq } = makeQueue({ exec });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" })); // NO trigger → ad-hoc
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("conflict");
    expect(redrives).toEqual([]); // ad-hoc never re-drives (no skill/spec to regenerate from)
    expect(calls.some((c) => c.includes('git branch -D "run/a"'))).toBe(false); // branch preserved for the operator
  });

  it("degrades to `conflict` when no redrive handler is wired (back-compat — engine absent)", async () => {
    const { exec } = makeRealisticExec({ conflict: () => true });
    const { mq } = makeQueue({ exec }); // setRedriveHandler NEVER called
    await mq.enqueueMerge({ ...input({ runId: "a", branch: "run/a" }), trigger: "harness-do" });
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("conflict"); // no engine → pre-redrive behavior
  });

  it("boot recovery leaves a persisted `re-driving` entry untouched (terminal — branch already deleted)", async () => {
    const seed: MergeQueueEntry[] = [
      { runId: "a", board: "acme", cardId: "c", branch: "run/a", status: "re-driving", enqueuedAt: 1, mergeEndedAt: 2, trigger: "harness-do", driveCount: 1 },
    ];
    const { store } = makeStore(seed);
    const { exec, calls } = makeExec();
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary).toMatchObject({ loaded: 1, resetToConflict: 0, resetGateFailed: 0, waiting: 0 });
    expect(mq.getSnapshot().entries[0].status).toBe("re-driving"); // not reset
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(false); // nothing re-processed
  });
});

describe("makeMergeQueue — recover prune (backlog cleanup)", () => {
  // Stateful exec that answers the prune's probes per-branch: branch existence (rev-parse),
  // ancestry (merge-base --is-ancestor), and the run-branch diff (diff --name-only). Everything
  // else is a no-op `ok` so a surviving entry can still be processed by the trailing void process().
  function makePruneExec(spec: {
    missing?: Set<string>;
    ancestors?: Set<string>;
    diff?: Record<string, string>;
    conflict?: Set<string>;
  } = {}) {
    const integrated = new Set<string>();
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("rev-parse --verify")) {
        if (spec.missing?.has(br)) throw Object.assign(new Error("missing"), { code: 1 });
        return { stdout: br, stderr: "" };
      }
      if (cmd.includes("is-ancestor")) {
        if (spec.ancestors?.has(br) || integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("diff --name-only")) return { stdout: spec.diff?.[br] ?? "", stderr: "" };
      if (cmd.includes("merge --no-ff")) {
        if (spec.conflict?.has(br)) throw Object.assign(new Error("CONFLICT"), { code: 1, stderr: "CONFLICT" });
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  const wait = (over: Partial<MergeQueueEntry>): MergeQueueEntry => ({
    runId: "r", board: "storymap", cardId: "c", branch: "run/r", status: "waiting", enqueuedAt: 1, ...over,
  });

  it("drops a waiting entry whose branch is GONE (nothing to integrate)", async () => {
    const { store } = makeStore([wait({ runId: "a", branch: "run/a" })]);
    const { exec } = makePruneExec({ missing: new Set(["run/a"]) });
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary.pruned).toBe(1);
    expect(mq.getSnapshot().entries.find((e) => e.runId === "a")).toBeUndefined();
  });

  it("drops a waiting entry whose branch is already an ANCESTOR of HEAD (landed elsewhere)", async () => {
    const { store } = makeStore([wait({ runId: "a", branch: "run/a" })]);
    const { exec } = makePruneExec({ ancestors: new Set(["run/a"]) });
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });

    const summary = await mq.recover();
    expect(summary.pruned).toBe(1);
    expect(mq.getSnapshot().entries).toHaveLength(0);
  });

  it("drops a waiting entry whose CARD reached a terminal column (isCardTerminal=true)", async () => {
    const { store } = makeStore([wait({ runId: "a", branch: "run/a", cardId: "done-card" })]);
    // Real product code on the branch (would otherwise be KEPT) — terminal card overrides.
    const { exec } = makePruneExec({ diff: { "run/a": "packages/storymap-ui/src/x.ts" } });
    const mq = makeMergeQueue({
      repoRoot: "/repo", exec, store, now: clock(),
      isCardTerminal: async (_b, cardId) => cardId === "done-card",
    });

    const summary = await mq.recover();
    expect(summary.pruned).toBe(1);
    expect(mq.getSnapshot().entries).toHaveLength(0);
  });

  it("drops a board-data-only branch and KEEPS a real-code branch (board state lives on main)", async () => {
    const { store } = makeStore([
      wait({ runId: "bd", branch: "run/bd", cardId: "c1" }),
      wait({ runId: "code", branch: "run/code", cardId: "c2" }),
    ]);
    const { exec } = makePruneExec({
      diff: {
        "run/bd": "storymap/boards/storymap/cards/c1.md\nstorymap/boards/storymap/plans/c1.md",
        "run/code": "packages/storymap-ui/src/app/actions.ts",
      },
      conflict: new Set(["run/code"]), // keep it parked so the assertion sees it survive (not auto-merged away)
    });
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock(), isCardTerminal: async () => false });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary.pruned).toBe(1); // only the board-only one
    expect(mq.getSnapshot().entries.find((e) => e.runId === "bd")).toBeUndefined();
    expect(mq.getSnapshot().entries.find((e) => e.runId === "code")).toBeDefined(); // real code preserved
  });

  it("prunes a stale head-of-line `conflict` (board-only) so the FIFO is no longer frozen", async () => {
    const { store } = makeStore([
      wait({ runId: "x", branch: "run/x", cardId: "stale", status: "conflict", conflictDetail: "old" }),
    ]);
    const { exec } = makePruneExec({ diff: { "run/x": "storymap/boards/storymap/cards/stale.md" } });
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock(), isCardTerminal: async () => false });

    const summary = await mq.recover();
    await mq.whenIdle();

    expect(summary.pruned).toBe(1);
    expect(mq.getSnapshot().entries).toHaveLength(0); // the blocker is gone
  });
});

describe("makeMergeQueue — subscribe", () => {
  it("notifies subscribers on every state change and supports unsubscribe", async () => {
    const { exec } = makeExec([{ match: "is-ancestor", outcome: { code: 1 } }]);
    const { mq } = makeQueue({ exec });
    const seen: number[] = [];
    const unsub = mq.subscribe((snap) => seen.push(snap.entries.length));

    await mq.enqueueMerge(input());
    await mq.whenIdle();
    expect(seen.length).toBeGreaterThan(0); // at least the enqueue + processing transitions

    unsub();
    const before = seen.length;
    await mq.enqueueMerge(input({ runId: "s2", branch: "run/s2" }));
    await mq.whenIdle();
    expect(seen.length).toBe(before); // no more notifications after unsubscribe
  });
});

describe("makeMergeQueue — diffSnapshot capture after merge (SM-04)", () => {
  // A stateful exec that integrates a branch on `merge --no-ff` (so the f3 is-ancestor guard
  // passes) AND answers `rev-parse HEAD`/`HEAD^1` with distinct SHAs, recording when `branch -D`
  // ran so we can prove the snapshot is captured BEFORE the throwaway branch is deleted.
  function snapshotExec(shas: { head: string; parent: string }) {
    const integrated = new Set<string>();
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        integrated.add(br);
        return { stdout: "", stderr: "" };
      }
      // ORDER MATTERS: "rev-parse HEAD" is a substring of "rev-parse HEAD^1" — match ^1 first.
      if (cmd.includes("rev-parse HEAD^1")) return { stdout: `${shas.parent}\n`, stderr: "" };
      if (cmd.includes("rev-parse HEAD")) return { stdout: `${shas.head}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    return { exec, calls };
  }

  it("AC1: persists { base: HEAD^1, mergeCommit: HEAD } before deleting the branch", async () => {
    const { exec, calls } = snapshotExec({ head: "mergeSHA999", parent: "baseSHA000" });
    const snapshots: Array<{ board: string; cardId: string; snapshot: DiffSnapshot }> = [];
    const { store } = makeStore();
    const mq = makeMergeQueue({
      repoRoot: "/repo",
      exec,
      store,
      now: clock(),
      persistDiffSnapshot: async (board, cardId, snapshot) => {
        snapshots.push({ board, cardId, snapshot });
      },
    });

    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }));
    await mq.whenIdle();

    // the card got the SHAs the merge produced (HEAD^1 = base, HEAD = mergeCommit)
    expect(snapshots).toEqual([
      { board: "acme", cardId: "story-1", snapshot: { base: "baseSHA000", mergeCommit: "mergeSHA999" } },
    ]);
    // and it was captured BEFORE the branch -D (the SHAs are gone once the branch is deleted)
    const headRevIdx = calls.findIndex((c) => c.includes("rev-parse HEAD"));
    const delIdx = calls.findIndex((c) => c.includes("branch -D"));
    expect(headRevIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(headRevIdx);
    // the merge still completed
    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });

  it("is non-fatal: a snapshot-persist failure still completes the merge as done", async () => {
    const { exec } = snapshotExec({ head: "h", parent: "p" });
    const { store } = makeStore();
    const mq = makeMergeQueue({
      repoRoot: "/repo",
      exec,
      store,
      now: clock(),
      persistDiffSnapshot: async () => {
        throw new Error("disk full");
      },
    });

    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });

  it("does not capture a snapshot when the merge never integrates (conflict)", async () => {
    // merge --no-ff fails → never integrated → is-ancestor stays false → conflict path, no snapshot.
    const integrated = new Set<string>();
    const exec: ExecFn = async (cmd) => {
      const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
      if (cmd.includes("is-ancestor")) {
        if (integrated.has(br)) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      if (cmd.includes("merge --no-ff")) {
        throw Object.assign(new Error("CONFLICT"), { code: 1, stderr: `CONFLICT in ${br}` });
      }
      return { stdout: "", stderr: "" };
    };
    const snapshots: DiffSnapshot[] = [];
    const { store } = makeStore();
    const mq = makeMergeQueue({
      repoRoot: "/repo",
      exec,
      store,
      now: clock(),
      persistDiffSnapshot: async (_b, _c, snapshot) => {
        snapshots.push(snapshot);
      },
    });

    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    expect(snapshots).toEqual([]); // nothing persisted on a conflict
    expect(mq.getSnapshot().entries[0].status).toBe("conflict");
  });
});

// --- SM-08: secret scan over the merge commit + fail-closed ------------------
// Wraps the realistic exec so the SCANNER invocation (over HEAD~1..HEAD) throws with a chosen exit
// code: 2 = secret found, 1 = the scanner's OWN internal error (a diff past git's maxBuffer). Every
// other command (merge --no-ff, is-ancestor, reset, push) delegates to the realistic git double, so
// the merge integrates first and the scan runs on the resulting commit — exactly as in production.
function execWithScanResult(scanCode: number) {
  const base = makeRealisticExec();
  const exec: ExecFn = async (cmd) => {
    if (cmd.includes("scan-secrets.mjs")) {
      base.calls.push(cmd); // record so the test can assert the scan ran (we throw before delegating)
      throw Object.assign(new Error(scanCode === 2 ? "secret found" : "INTERNAL_ERROR could not scan diff"), {
        code: scanCode,
        stderr:
          scanCode === 2 ? "🔒 secret scan BLOCKED" : "[scan-secrets] INTERNAL_ERROR could not scan diff: maxBuffer",
      });
    }
    return base.exec(cmd);
  };
  return { exec, calls: base.calls };
}

describe("makeMergeQueue — SM-08: secret scan over the merge commit", () => {
  it("AC1: a CLEAN merge commit is scanned (--range HEAD~1..HEAD) BEFORE the push, then merges + pushes", async () => {
    const { exec, calls } = makeRealisticExec(); // scanner defaults to ok in the realistic double
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input());
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    const scanIdx = calls.findIndex((c) => c.includes("scan-secrets.mjs") && c.includes("--range HEAD~1..HEAD"));
    const pushIdx = calls.findIndex((c) => c.includes("git push origin HEAD"));
    expect(scanIdx).toBeGreaterThanOrEqual(0); // the merge commit WAS scanned
    expect(pushIdx).toBeGreaterThanOrEqual(0); // and then pushed
    expect(scanIdx).toBeLessThan(pushIdx); // scan happens BEFORE the push (AC1)
  });

  it("AC2a: a SECRET in the merge commit (exit 2) BLOCKS the push, undoes the merge, fails the entry + pauses the train", async () => {
    const { exec, calls } = execWithScanResult(2);
    const stamped: Array<{ board: string; cardId: string; runId: string; detail: string }> = [];
    const { mq } = makeQueue({
      exec,
      addSecretScanBlocker: async (board, cardId, runId, detail) => {
        stamped.push({ board, cardId, runId, detail });
      },
    });

    await mq.enqueueMerge(input({ runId: "a", board: "storymap", cardId: "story-x", branch: "run/a" }));
    await mq.enqueueMerge(input({ runId: "b", branch: "run/b" })); // queued behind the poisoned one
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    expect(snap.entries[0]).toMatchObject({ runId: "a", status: "failed" });
    expect(snap.entries[0].failureReason).toMatch(/secret/i);
    // the scan ran over the merge commit; the push NEVER did (fail-closed)
    expect(calls.some((c) => c.includes("scan-secrets.mjs") && c.includes("--range HEAD~1..HEAD"))).toBe(true);
    expect(calls.some((c) => c.includes("git push origin HEAD"))).toBe(false);
    // the just-created merge commit was UNDONE non-destructively (HARDENING 1.2: `reset --keep HEAD^1`, NOT
    // the old `reset --hard HEAD^1` that clobbered uncommitted code in the live checkout) so a later
    // cumulative push can't carry it to origin
    expect(calls.some((c) => c.includes("reset --keep HEAD^1"))).toBe(true);
    expect(calls.some((c) => c.includes("reset --hard HEAD^1"))).toBe(false);
    // a security:blocker finding was stamped on the card (held out of QA by hasNoBlockers)
    expect(stamped).toHaveLength(1);
    expect(stamped[0]).toMatchObject({ board: "storymap", cardId: "story-x", runId: "a" });
    // the train is PAUSED — the branch queued behind never merged
    expect(snap.entries[1]).toMatchObject({ runId: "b", status: "waiting" });
  });

  it("AC2b: an INTERNAL scanner error (exit 1) is treated as fail-CLOSED too — push blocked, entry failed", async () => {
    const { exec, calls } = execWithScanResult(1);
    const stamped: string[] = [];
    const { mq } = makeQueue({
      exec,
      addSecretScanBlocker: async (_b, _c, runId) => {
        stamped.push(runId);
      },
    });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("failed");
    expect(entry.failureReason).toMatch(/interno|internal/i); // distinguished as a scanner internal error
    expect(calls.some((c) => c.includes("git push origin HEAD"))).toBe(false); // never pushed an un-scanned diff
    expect(stamped).toEqual(["a"]); // still surfaces a blocker on the card
  });

  it("a FAILING addSecretScanBlocker is non-fatal — the entry still fails-closed and records secretScanBlockerError", async () => {
    const { exec } = execWithScanResult(2);
    const { mq } = makeQueue({
      exec,
      addSecretScanBlocker: async () => {
        throw new Error("disk full");
      },
    });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("failed"); // the swallowed write error never changed the fail-closed verdict
    expect(entry.secretScanBlockerError).toContain("disk full");
  });

  it("source guard (HARDENING 1.2): no destructive `git(`reset --hard`)` on the LIVE checkout", () => {
    // The default `git(...)` runner is bound to cfg.repoRoot (the LIVE runtime checkout); a `reset --hard`
    // through it clobbers uncommitted code outside the operation's scope (the WS1.2 data-loss class).
    // Isolated-worktree resets go via `gitAt(<path>, ...)` or `exec(`git reset --hard`, { cwd: stagingPath })`
    // and are safe. This guards against a future edit re-introducing a live-checkout `reset --hard`.
    const src = readFileSync(fileURLToPath(new URL("./merge-queue.ts", import.meta.url)), "utf8");
    const offenders = src.split("\n").filter((l) => l.includes("git(`reset --hard"));
    expect(offenders).toEqual([]);
  });
});

describe("withSecretScanBlockerFinding — pure idempotent finding builder (SM-08)", () => {
  it("APPENDS a security:blocker finding keyed by runId", () => {
    const out = withSecretScanBlockerFinding([], "run-1", "secret detected");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: secretScanBlockerFindingId("run-1"),
      lens: "security",
      severity: "blocker",
      status: "open",
    });
    expect(out[0].detail).toContain("secret detected");
  });

  it("REFRESHES the same finding in place on a repeat (never duplicates)", () => {
    const first = withSecretScanBlockerFinding([], "run-1", "first");
    const second = withSecretScanBlockerFinding(first, "run-1", "second");
    expect(second).toHaveLength(1);
    expect(second[0].detail).toContain("second");
  });

  it("preserves OTHER findings untouched", () => {
    const existing = [
      { id: "other", lens: "perf", severity: "low", title: "x", status: "open" } as const,
    ];
    const out = withSecretScanBlockerFinding(existing, "run-1", "secret");
    expect(out).toHaveLength(2);
    expect(out.find((f) => f.id === "other")).toBeTruthy();
  });
});

// Fase 4a — staged release (split integration). A run touching CODE (`packages/**`) is SPLIT: code →
// `stage`, board data → main; a run with NO code (or staging off) takes the unchanged merge path.
// Stateful exec: `is-ancestor` is true only after a `merge --no-ff` (the normal path); the split path
// never merges into main, so its top-of-loop ancestor check stays false and it proceeds to split.
// autonomy-endgame WS-3: `dataApplyFailTimes` models the LINE OF THE INCIDENT — the data half's `git apply`
// failing (the index.lock race, measured at 5/80 unserialized applies) for the first N attempts and then
// succeeding, which is what a TRANSIENT is. It replaces a `dataFails` flag that no test ever used and that
// could not have worked anyway: it only failed `apply --check`, so the unionFallback's `--3way` rescued the
// apply and the half "landed". The one line that produced the two entries wedged in the live runtime had
// scaffolding that pretended to test it.
function stagingExec(opts: {
  changed: string;
  codeConflict?: boolean;
  /** how many DATA-half apply attempts fail before one succeeds. `Infinity` ⇒ never applies. */
  dataApplyFailTimes?: number;
  boardCommitFails?: boolean;
  verifyFails?: boolean;
}) {
  const integrated = new Set<string>();
  const calls: string[] = [];
  let dataApplyAttempts = 0;
  const dataApplyShouldFail = () => (opts.dataApplyFailTimes ?? 0) >= dataApplyAttempts && dataApplyAttempts > 0;
  const exec: ExecFn = async (cmd: string) => {
    calls.push(cmd);
    const br = cmd.match(/run\/[\w-]+/)?.[0] ?? "";
    if (cmd.includes("is-ancestor")) {
      if (integrated.has(br)) return { stdout: "", stderr: "" };
      throw Object.assign(new Error("not ancestor"), { code: 1 });
    }
    if (cmd.includes("merge --no-ff")) {
      integrated.add(br);
      return { stdout: "", stderr: "" };
    }
    // story-r4o4wo board-divergence check: `diff --quiet base HEAD -- <card.md>` asks whether MAIN moved
    // the card since the fork (→ carve for the structural merge). These tests don't model a main-side
    // divergence, so the card is UNCHANGED on main (exit 0) → NOT carved → line-applied as before.
    if (cmd.includes("diff --quiet") && cmd.includes("cards/") && cmd.includes(".md")) {
      return { stdout: "", stderr: "" }; // exit 0 = main did not diverge on this card → line patch handles it
    }
    // #38 verify-integration: `diff --quiet base HEAD -- <code>` proves the run's code landed on stage.
    // Real git exits 1 when there IS a diff (landed → ok:false) and 0 when there is none (not landed →
    // ok:true). Default models a healthy landing (exit 1); `verifyFails` models the false-flag (exit 0).
    if (cmd.includes("diff --quiet")) {
      if (opts.verifyFails) return { stdout: "", stderr: "" }; // exit 0 = no delta = NOT landed
      throw Object.assign(new Error("has diff"), { code: 1 }); // exit 1 = delta present = landed
    }
    if (cmd.includes("diff --name-only")) return { stdout: opts.changed, stderr: "" };
    if (cmd.includes("merge-base")) return { stdout: "base000\n", stderr: "" };
    if (cmd.includes('rev-parse "run/')) return { stdout: "tip0000\n", stderr: "" }; // branchTip (quoted)
    if (cmd.includes("apply --check")) {
      if (cmd.includes("-data.patch")) {
        dataApplyAttempts++;
        // The REAL failure mode, measured: `--check` does not take the index lock, so in production it
        // PASSES and `apply --index` is what dies. Failing at --check here drives the same applyPatch exit
        // ("error"/"conflict") through the same call site with one less mocked command.
        if (dataApplyShouldFail()) throw Object.assign(new Error("index.lock"), { code: 1 });
      }
      if (opts.codeConflict && cmd.includes("-code.patch")) throw Object.assign(new Error("x"), { code: 1 });
      return { stdout: "", stderr: "" }; // clean apply
    }
    if (cmd.includes("apply --reverse --check")) throw Object.assign(new Error("not applied"), { code: 1 });
    if (cmd.includes("apply --index --3way")) {
      // The data half's unionFallback also tries --3way; a raced apply fails there too (the tree/index is
      // what is contended, not the content). Without this the fallback would silently "rescue" the failure
      // and the incident could not be modelled at all — the bug the old `dataFails` flag had.
      if (cmd.includes("-data.patch") && dataApplyShouldFail()) throw Object.assign(new Error("index.lock"), { code: 1 });
      if (opts.codeConflict) throw Object.assign(new Error("conflict markers"), { code: 1 });
      return { stdout: "", stderr: "" };
    }
    // audit #10: model a hook-rejected board commit so the failure-pause path is exercisable.
    if (opts.boardCommitFails && cmd.includes("commit") && cmd.includes("board:")) {
      throw Object.assign(new Error("hook rejected the board commit"), { code: 1 });
    }
    return { stdout: "", stderr: "" }; // every other git (add/commit/worktree/reset/push/branch -D/…) → ok
  };
  return { exec, calls };
}

const STAGING = { enabled: true, branch: "stage", codePrefixes: ["packages/"] };
const recordingDiffSnapshot = () => {
  const snaps: Array<{ board: string; cardId: string; snap: DiffSnapshot }> = [];
  return { fn: async (board: string, cardId: string, snap: DiffSnapshot) => void snaps.push({ board, cardId, snap }), snaps };
};

describe("makeMergeQueue — Fase 4a staged release (split)", () => {
  it("a CODE-touching run splits: board data committed on main, code applied+committed+pushed on stage, no whole-merge", async () => {
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md" });
    const done: Array<{ board: string; cardId: string }> = [];
    const diff = recordingDiffSnapshot();
    const staged: string[] = [];
    const { mq, read } = makeQueue({
      exec,
      staging: STAGING,
      persistDiffSnapshot: diff.fn,
      stampStaged: async (b, c) => void staged.push(`${b}/${c}`),
    });
    mq.onMergeDone((ev) => done.push(ev));
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }));
    await mq.whenIdle();
    expect(staged).toEqual(["acme/story-1"]); // Fase 4b: the card is stamped stagedAt

    // DATA → main: the board commit landed (and main's accumulated push fired).
    expect(calls.some((c) => c.includes('commit --no-verify -m "board: story-1 (run s1)"'))).toBe(true);
    // CODE → stage: worktree provisioned, code patch applied + committed + pushed to the stage branch.
    expect(calls.some((c) => c.includes("worktree add") && c.includes('"stage"'))).toBe(true);
    expect(calls.some((c) => c.includes("apply --index") && c.includes("-code.patch"))).toBe(true);
    expect(calls.some((c) => c.includes('commit --no-verify -m "usm(story-1): código staged (run s1)"'))).toBe(true);
    expect(calls.some((c) => c.includes('push origin "stage"'))).toBe(true);
    // The run branch is deleted and the cascade hook fires — but the whole-branch merge NEVER ran.
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(true);
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(false);
    expect(done).toEqual([{ board: "acme", cardId: "story-1" }]);
    expect(diff.snaps).toHaveLength(1);
    expect(read()[0]?.status).toBe("done");
  });

  it("verify-integration: a FALSE codeStaged flag (code not on stage despite apply) PAUSES as conflict, branch PRESERVED (#38)", async () => {
    // The lost-impl class (commit 325c4435): the split reports the code staged while `stage` has no delta.
    // #38 confirms `git diff --quiet base HEAD -- <code>` shows a delta BEFORE marking done; absent → pause.
    const { exec, calls } = stagingExec({
      changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md",
      verifyFails: true,
    });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();

    const e = read()[0];
    expect(e?.status).toBe("conflict"); // false flag → PAUSED, not done
    expect(e?.split?.codeStaged).not.toBe(true); // never marked staged on the false flag
    expect(calls.some((c) => c.includes("diff --quiet"))).toBe(true); // the verify actually ran
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(false); // branch PRESERVED → recoverable
  });

  it("a BOARD-DATA-ONLY run with staging ON is integrated via the SPLIT (data→main, no code patch), never a whole-branch merge", async () => {
    const { exec, calls } = stagingExec({ changed: "storymap/boards/acme/cards/story-1.md" });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();
    // stale-base fix: with staging on EVERY run integrates via the split — a whole-branch `merge --no-ff`
    // would LEAK into main the unreleased code the run inherited from `stage`. A board-only run lands its
    // data on main (the `board:` commit) and stages NO code (empty code delta → the code-empty guard).
    expect(calls.some((c) => c.includes('merge --no-ff --no-edit "run/s1"'))).toBe(false); // never whole-merge
    expect(calls.some((c) => c.includes('commit --no-verify -m "board: story-1 (run s1)"'))).toBe(true); // data → main
    expect(calls.some((c) => c.includes("-code.patch"))).toBe(false); // no code delta → no code patch staged
    expect(read()[0]?.status).toBe("done");
  });

  it("anchors the split diff at entry.baseCommit (the stage sha), NOT HEAD — unreleased stage code is never re-applied/leaked", async () => {
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md" });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    // The engine threads the run's integration base (the captured `stage` sha) onto the entry.
    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();
    // EVERY diff that extracts the run's work is anchored at the captured stage sha (a fixed 2-dot range),
    // so the unreleased code already on `stage` is excluded — it can never be re-applied to stage nor leak
    // to main. The pre-fix `HEAD...branch` form must NOT appear for this entry.
    // `--binary` sits between `diff` and the range now (patches must carry binary payloads), so match the
    // RANGE — the thing this test is actually about — instead of the whole literal command.
    expect(calls.some((c) => c.includes('"stageSha1".."run/s1"'))).toBe(true);
    expect(calls.some((c) => c.includes("diff --name-only") && c.includes("HEAD..."))).toBe(false);
    expect(read()[0]?.status).toBe("done");
  });

  it("o split enumera e extrai SEM detecção de rename — senão um `git mv` perde a metade DELETADA e o arquivo velho sobrevive em stage/main", async () => {
    // Defeito real (rename Pilotagem→Inbox, 2026-07-26): com rename detection — o DEFAULT do git — o
    // `--name-only` de um `git mv` lista só o caminho NOVO. O caminho ANTIGO não entra na lista, logo
    // não entra no pathspec do patch, logo NUNCA é deletado: `stage` (e depois main) fica com os DOIS
    // arquivos. O velho seguia importando símbolos que já não existiam; o build só avisa (a rota morta
    // é inalcançável), então nada grita. Uma deleção pura sempre funcionou — por isso só aparece quando
    // alguém renomeia. O contrato é: `--no-renames` na ENUMERAÇÃO e na EXTRAÇÃO do patch.
    const { exec, calls } = stagingExec({
      changed: "packages/acmeapp/novo.ts\npackages/acmeapp/velho.ts\nstorymap/boards/acme/cards/story-1.md",
    });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();

    const enumeration = calls.filter((c) => c.includes("diff --name-only") && c.includes('"stageSha1".."run/s1"'));
    expect(enumeration.length).toBeGreaterThan(0);
    expect(enumeration.every((c) => c.includes("--no-renames"))).toBe(true);
    const patches = calls.filter((c) => c.includes("diff --binary"));
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((c) => c.includes("--no-renames"))).toBe(true);
    expect(read()[0]?.status).toBe("done");
  });

  it("Defect A: a run whose persisted baseCommit DRIFTED past the fork point is classified by the FORK POINT (merge-base with stage), NOT the stale base — the board-only run SKIPS the code gate (story-olr777)", async () => {
    // harness-review was cut from `stage` on TOP of this card's own staged code; its persisted baseCommit
    // lagged one commit behind the real cut point, so `baseCommit..branch` dragged in the neighbour's
    // packages/** files → the run was misclassified as code-touching → the code gate ran a whole-branch
    // merge that conflicted on the card .md and froze. The fork point isolates the run's OWN work (card).
    const staleBase = "staleBASE0000";
    const forkPoint = "forkPOINT0000";
    let gateRan = false;
    const inner = stagingExec({ changed: "storymap/boards/acme/cards/story-1.md" }); // fork-point diff = board only
    const exec: ExecFn = async (cmd, o) => {
      if (cmd.includes('merge-base "stage"')) {
        inner.calls.push(cmd);
        return { stdout: forkPoint + "\n", stderr: "" };
      }
      // The STALE base spans the neighbour's staged code → would MISCLASSIFY the run as code-touching.
      if (cmd.includes("diff --name-only") && cmd.includes(staleBase)) {
        inner.calls.push(cmd);
        return { stdout: "packages/orbit/web/x.tsx\nstorymap/boards/acme/cards/story-1.md", stderr: "" };
      }
      return inner.exec(cmd, o);
    };
    const integrationGate: IntegrationGateRunner = async () => {
      gateRan = true;
      return { passed: false, log: "should NOT run on a board-data-only run" };
    };
    const { mq, read } = makeQueue({ exec, staging: STAGING, integrationGate, gateEnabled: true });
    await mq.enqueueMerge({
      ...input({ runId: "rev", branch: "run/rev", board: "acme", cardId: "story-1" }),
      baseCommit: staleBase,
    });
    await mq.whenIdle();

    expect(gateRan).toBe(false); // classified by the fork point (board-only) → the code gate never ran (was `true` pre-fix)
    expect(inner.calls.some((c) => c.includes('merge-base "stage"'))).toBe(true); // forkPointBase resolved the true cut point
    expect(read()[0]?.status).toBe("done"); // integrated cleanly via the split, never gate-failed
  });

  it("with staging OFF, a code-touching run still merges whole into main (pre-staging behavior)", async () => {
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts" });
    const { mq, read } = makeQueue({ exec }); // no staging
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();
    expect(calls.some((c) => c.includes('merge --no-ff --no-edit "run/s1"'))).toBe(true);
    expect(calls.some((c) => c.includes("worktree add") && c.includes('"stage"'))).toBe(false);
    expect(read()[0]?.status).toBe("done");
  });

  it("a code patch that conflicts with prior staged code PAUSES the entry as conflict — NO board commit (card never advances, WS-1.1)", async () => {
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md", codeConflict: true });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();
    // autonomy-reliability WS-1.1: CODE lands FIRST → a code conflict returns BEFORE the DATA half, so the
    // board commit is NEVER created. The card keeps its pre-integration status (the truth) instead of
    // reading "done"/advanced without any code behind it (the lost-impl of story-qb8z2c). Branch preserved.
    expect(calls.some((c) => c.includes('commit --no-verify -m "board: story-1 (run s1)"'))).toBe(false);
    expect(read()[0]?.status).toBe("conflict");
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(false);
  });

  it("story-ibc64m AC3: a code conflict on the SPLIT path RE-DRIVES (not just parks) when the run has a trigger under the cap", async () => {
    // The card's headline behavior: re-drive now fires from inside integrateSplit (the staging-merge
    // path), not only the legacy runLoop. A code patch that conflicts with prior staged code, on an
    // auto-driven run under maxRedrives, re-drives the skill against the CURRENT stage instead of
    // parking for the operator. Mirrors the legacy-path re-drive tests (story-92ldyt) but proves the
    // wiring through the split exit at merge-queue.ts:1059-1066.
    const redrives: Array<{ board: string; cardId: string; trigger: string; driveCount: number; conflictDetail: string; preservedBranch?: string }> = [];
    const { exec, calls } = stagingExec({
      changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md",
      codeConflict: true,
    });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1" }), trigger: "harness-do" });
    await mq.whenIdle();

    // Re-driven through the split path: handler called with driveCount+1, entry terminal `re-driving`,
    // and the superseded branch PRESERVED (renamed to conflicted/, never force-deleted).
    expect(redrives).toHaveLength(1);
    expect(redrives[0]).toMatchObject({ board: "acme", cardId: "story-1", trigger: "harness-do", driveCount: 1 });
    expect(redrives[0].conflictDetail).toContain("split: código conflita");
    // WS-2.2: the handler is pointed at the PRESERVED branch so the fresh run reuses the prior code.
    expect(redrives[0].preservedBranch).toBe("conflicted/run/s1");
    expect(read()[0]?.status).toBe("re-driving");
    expect(calls.some((c) => c.includes('branch -m "run/s1" "conflicted/run/s1"'))).toBe(true);
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(false); // preserved, not deleted
  });

  it("WS-1.2: a code conflict (no re-drive) stamps the code-not-landed BLOCKER naming the preserved branch", async () => {
    // The CODE half (now FIRST) conflicts, and with no trigger the entry parks as conflict without re-drive —
    // the DATA half never ran, so the card did NOT advance. The split chokepoint stamps a `general:blocker`
    // naming the run branch (where the stranded code lives) so the failure is VISIBLE, never a "done" fantasma.
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md", codeConflict: true });
    const blockers: Array<{ board: string; cardId: string; runId: string; branch: string; detail?: string }> = [];
    const { mq, read } = makeQueue({
      exec,
      staging: STAGING,
      addCodeNotLandedBlocker: async (board, cardId, runId, branch, detail) => {
        blockers.push({ board, cardId, runId, branch, detail });
      },
    });
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }));
    await mq.whenIdle();
    expect(read()[0]?.status).toBe("conflict");
    expect(calls.some((c) => c.includes('commit --no-verify -m "board: story-1 (run s1)"'))).toBe(false); // data NEVER landed
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ board: "acme", cardId: "story-1", runId: "s1", branch: "run/s1" });
  });

  it("WS-1.2 (AC4): recover() stamps code-not-landed on a LEGACY parked split (dataLanded && !codeStaged)", async () => {
    // The incident signature (run 54de4fa8): the pre-WS-1 inverted order landed board data on main but the
    // code never staged, and the entry ended `failed` — the card read "done" without code. recover() now
    // sweeps it and stamps the blocker so the defect becomes visible in Inbox (lane travado).
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "conflicted/run/s1", board: "acme", cardId: "story-1" }), status: "failed", enqueuedAt: 1, split: { dataLanded: true } },
    ];
    const { store } = makeStore(seed);
    const { exec } = stagingExec({ changed: "" });
    const blockers: Array<{ cardId: string; runId: string; branch: string }> = [];
    const mq = makeMergeQueue({
      repoRoot: "/repo",
      exec,
      store,
      now: clock(),
      staging: STAGING,
      addCodeNotLandedBlocker: async (_b, cardId, runId, branch) => void blockers.push({ cardId, runId, branch }),
    });
    await mq.recover();
    await mq.whenIdle();
    expect(blockers).toEqual([{ cardId: "story-1", runId: "s1", branch: "conflicted/run/s1" }]);
  });

  it("fix (stale-Bloqueio): recover() does NOT stamp code-not-landed when the CARD is already TERMINAL", async () => {
    // Same legacy signature as AC4 above, but the card already SHIPPED (terminal) by another path. Stamping
    // here would strand an `open` blocker FOREVER — a terminal card never re-integrates, so
    // withRunBlockersResolved can't auto-clear it (the exact bug: 3 "No Ar" cards showing a false "Bloqueio").
    // The terminal guard inside stampCodeNotLandedIfNeeded skips the stamp; a non-terminal card (AC4) still gets it.
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "conflicted/run/s1", board: "acme", cardId: "story-done" }), status: "failed", enqueuedAt: 1, split: { dataLanded: true } },
    ];
    const { store } = makeStore(seed);
    const { exec } = stagingExec({ changed: "" });
    const blockers: Array<{ cardId: string; runId: string }> = [];
    const mq = makeMergeQueue({
      repoRoot: "/repo",
      exec,
      store,
      now: clock(),
      staging: STAGING,
      isCardTerminal: async (_b, cardId) => cardId === "story-done",
      addCodeNotLandedBlocker: async (_b, cardId, runId) => void blockers.push({ cardId, runId }),
    });
    await mq.recover();
    await mq.whenIdle();
    expect(blockers).toEqual([]); // terminal card → guard skips the stamp
  });

  it("audit #10 — a FAILED board commit PAUSES (conflict) and never marks dataLanded (no silent board-state loss)", async () => {
    const { exec } = stagingExec({
      changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md",
      boardCommitFails: true,
    });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }));
    await mq.whenIdle();
    const e = read()[0];
    expect(e.status).toBe("conflict"); // paused for the operator, main left pristine
    expect(e.split?.dataLanded).not.toBe(true); // the old swallow falsely marked this true
  });

  it("recover(): a split with BOTH halves landed finalizes done (only the final persist was lost)", async () => {
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "run/s1" }), status: "merging", enqueuedAt: 1, split: { dataLanded: true, codeStaged: true } },
    ];
    const { store, read } = makeStore(seed);
    const { exec, calls } = stagingExec({ changed: "" });
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });
    const res = await mq.recover();
    await mq.whenIdle();
    expect(read()[0]?.status).toBe("done");
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(true);
    expect(res.resumed).toBeGreaterThanOrEqual(1);
  });

  it("recover(): a split interrupted MID-WAY (data landed, code not) resumes the code half WITHOUT re-landing data", async () => {
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }), status: "merging", enqueuedAt: 1, split: { dataLanded: true } },
    ];
    const { store, read } = makeStore(seed);
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md" });
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock(), staging: STAGING, persistDiffSnapshot: recordingDiffSnapshot().fn });
    await mq.recover();
    await mq.whenIdle();
    expect(read()[0]?.status).toBe("done"); // re-process finished the code half + finalized
    expect(calls.some((c) => c.includes('commit --no-verify -m "board: story-1 (run s1)"'))).toBe(false); // data NOT re-landed
    expect(calls.some((c) => c.includes("worktree add") && c.includes('"stage"'))).toBe(true); // code half ran
    expect(calls.some((c) => c.includes('commit --no-verify -m "usm(story-1): código staged (run s1)"'))).toBe(true);
  });

  it("recover(): a non-split merging entry is untouched by the split path (existing recovery preserved)", async () => {
    // story-43w10w Case 1: a normal merge entry whose branch is already an ancestor → done (no `split`).
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "run/s1" }), status: "merging", enqueuedAt: 1 },
    ];
    const { store, read } = makeStore(seed);
    const exec: ExecFn = async (cmd) => {
      if (cmd.includes("is-ancestor")) return { stdout: "", stderr: "" }; // already integrated
      return { stdout: "", stderr: "" };
    };
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });
    await mq.recover();
    await mq.whenIdle();
    expect(read()[0]?.status).toBe("done");
  });

  it("recover(): FIRES onMergeDone for the entries it completes → the cascade resumes post-restart (audit #8)", async () => {
    // BEFORE the fix recover() finalized these `done` SILENTLY, so a restart that completed an
    // integration stranded the card in its advanced autorun column with nothing to re-trigger the
    // cascade. Cover BOTH strand branches (already-ancestor whole-branch + split-both-landed), and
    // assert the event carries the trigger (the suppress-guard plumbing, audit #12).
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "run/s1", board: "storymap", cardId: "story-1" }), status: "merging", enqueuedAt: 1, trigger: "harness-prioritize" },
      { ...input({ runId: "s2", branch: "run/s2", board: "acme", cardId: "story-2" }), status: "merging", enqueuedAt: 2, trigger: "harness-do", split: { dataLanded: true, codeStaged: true } },
    ];
    const { store } = makeStore(seed);
    const { exec } = stagingExec({ changed: "" }); // is-ancestor ok → s1 already integrated; s2 split both-landed
    const done: Array<{ board: string; cardId: string; trigger?: string }> = [];
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });
    mq.onMergeDone((ev) => done.push(ev));
    await mq.recover();
    await mq.whenIdle();
    expect(done).toEqual(
      expect.arrayContaining([
        { board: "storymap", cardId: "story-1", trigger: "harness-prioritize" },
        { board: "acme", cardId: "story-2", trigger: "harness-do" },
      ]),
    );
    expect(done).toHaveLength(2);
  });

  it("resolveMergeConflict('merged'): a SPLIT conflict resolves WITHOUT the is-ancestor guard (operator fixed it on stage)", async () => {
    const seed: MergeQueueEntry[] = [
      { ...input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }), status: "conflict", enqueuedAt: 1, split: { dataLanded: true } },
    ];
    const { store, read } = makeStore(seed);
    const calls: string[] = [];
    // is-ancestor is ALWAYS false for a split (it never merges into main); the split path must ignore it.
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      return { stdout: "", stderr: "" };
    };
    const done: Array<{ board: string; cardId: string }> = [];
    const mq = makeMergeQueue({ repoRoot: "/repo", exec, store, now: clock() });
    mq.onMergeDone((ev) => done.push(ev));
    await mq.resolveMergeConflict("s1", "merged");
    expect(read()[0]?.status).toBe("done");
    expect(read()[0]?.split?.codeStaged).toBe(true);
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(true);
    expect(done).toEqual([{ board: "acme", cardId: "story-1" }]);
  });
});

// --- Supersede invariant: at most ONE pending integration per card (merge-train rootcause Front 2/3) ---
describe("makeMergeQueue — supersede invariant: one pending integration per card", () => {
  it("enqueueMerge SUPERSEDES a prior PARKED entry of the SAME card (failed + branch preserved + blockers cleared)", async () => {
    const cleared: string[] = [];
    const { gate } = recordingGate((br) => ({ passed: br !== "run/a1", log: "x" })); // a1's gate fails → parks
    const realistic = makeRealisticExec();
    const { mq } = makeQueue({
      exec: realistic.exec,
      integrationGate: gate,
      gateEnabled: true,
      clearRunBlockers: async (_b, _c, runId) => {
        cleared.push(runId);
      },
    });

    await mq.enqueueMerge(input({ runId: "a1", branch: "run/a1", cardId: "story-x" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");

    // A NEWER run of the SAME card enqueues → it SUPERSEDES the parked a1 before inserting itself.
    await mq.enqueueMerge(input({ runId: "a2", branch: "run/a2", cardId: "story-x" }));
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    const a1 = snap.entries.find((e) => e.runId === "a1")!;
    const a2 = snap.entries.find((e) => e.runId === "a2")!;
    expect(a1.status).toBe("failed");
    expect(a1.failureReason).toContain("superseded");
    expect(a1.branch).toBe("failed/run/a1"); // PRESERVED (renamed), never -D
    expect(cleared).toContain("a1"); // the superseded run's gate/secret blockers were cleared
    expect(a2.status).toBe("done"); // the successor integrated (its gate passes → merge)
    // invariant: NO live entry remains for the card (a1 failed, a2 done — both terminal)
    const live = snap.entries.filter((e) =>
      ["waiting", "gate-running", "merging", "gate-failed", "conflict"].includes(e.status),
    );
    expect(live).toHaveLength(0);
  });

  it("enqueueMerge does NOT supersede a DIFFERENT card's parked entry", async () => {
    const { gate } = recordingGate((br) => ({ passed: br !== "run/a", log: "x" })); // run/a parks
    const realistic = makeRealisticExec();
    const { mq } = makeQueue({ exec: realistic.exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-a" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");

    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-b" })); // different card
    await mq.whenIdle();

    const a = mq.getSnapshot().entries.find((e) => e.runId === "a")!;
    expect(a.status).toBe("gate-failed"); // untouched — supersede is per-card
  });

  it("does NOT supersede an ACTIVELY-integrating (merging) entry — only waiting/parked", async () => {
    // Seed an in-flight `merging` entry (mid-integration). A new run of the SAME card enqueues — the
    // supersede must SKIP the merging entry (aborting it could leave main half-merged). The serial
    // guard then pauses, so the successor waits behind the in-flight one.
    const seeded = makeStore([
      { runId: "a", board: "acme", cardId: "story-x", branch: "run/a", status: "merging", enqueuedAt: 1, mergeStartedAt: 2 },
    ]);
    const realistic = makeRealisticExec();
    const mq = makeMergeQueue({ repoRoot: "/repo", exec: realistic.exec, store: seeded.store, now: clock() });

    await mq.enqueueMerge(input({ runId: "b", branch: "run/b", cardId: "story-x" }));
    await mq.whenIdle();

    expect(mq.getSnapshot().entries.find((e) => e.runId === "a")!.status).toBe("merging"); // NOT superseded
    expect(mq.getSnapshot().entries.find((e) => e.runId === "b")!.status).toBe("waiting"); // serial guard: waits behind it
  });

  it("reconcileCardMergeEntries SUPERSEDES the card's PARKED entries (failed + branch preserved)", async () => {
    const { gate } = recordingGate(() => ({ passed: false, log: "x" })); // parks gate-failed
    const realistic = makeRealisticExec();
    const { mq } = makeQueue({ exec: realistic.exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-x" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("gate-failed");

    await mq.reconcileCardMergeEntries("acme", "story-x"); // operator moved/reopened the card
    await mq.whenIdle();

    const a = mq.getSnapshot().entries.find((e) => e.runId === "a")!;
    expect(a.status).toBe("failed");
    expect(a.failureReason).toContain("movido/reaberto");
    expect(a.branch).toBe("failed/run/a"); // PRESERVED
  });

  it("reconcileCardMergeEntries is a no-op when the card has no parked entry", async () => {
    const realistic = makeRealisticExec();
    const { mq } = makeQueue({ exec: realistic.exec });

    await mq.enqueueMerge(input({ runId: "a", branch: "run/a", cardId: "story-x" }));
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("done"); // integrated cleanly — nothing parked

    await mq.reconcileCardMergeEntries("acme", "story-x");
    await mq.whenIdle();
    expect(mq.getSnapshot().entries[0].status).toBe("done"); // unchanged
  });
});

// ── story-zdeajs: merge-train robustness on the STAGING-OFF path ─────────────────────────────────
// The storymap board runs staging.enabled=false → runLoop takes the pure whole-branch `git merge --no-ff`
// path. Two confirmed bugs lived there: (1) a run that regenerated a golden snapshot (*.snap, `binary` per
// .gitattributes) made the merge ABORT (snap unmergeable) → false-parked a CLEAN merge as `conflict`, with
// NO snap auto-regen (that logic only existed on the staging-ON split path); (2) a tree left DIRTY after
// the best-effort board commit (commit failed, or an external SSH writer raced) made `git merge --no-ff`
// abort, which the code mis-read as a CONTENT conflict (both exit 1) — a false-park of a branch that
// integrates cleanly. The fix: snap-aware merge (regenerate from merged source) + a tree-clean GATE before
// the merge that distinguishes "árvore suja" (operational hold) from a real branch conflict.

// A recording WorktreeFs (DI) so the snap-regen's provision/deprovision are observable without disk.
// `isDir` is true for node_modules paths so planNodeModulesLinks plans the ROOT link (the regen then
// links it in and drops it) — that's what makes the provision/deprovision observable.
function recordingFs() {
  const linked: string[] = [];
  const unlinked: string[] = [];
  const fs: WorktreeFs = {
    listDirs: async () => [],
    isDir: async (p) => p.endsWith("node_modules"),
    isFile: async () => false,
    linkDir: async (_t, linkPath) => {
      linked.push(linkPath);
    },
    unlinkDir: async (linkPath) => {
      unlinked.push(linkPath);
      return true;
    },
  };
  return { fs, linked, unlinked };
}

describe("makeMergeQueue — staging-OFF snapshot auto-regen on the pure git-merge path (story-zdeajs AC1/AC4)", () => {
  // A stateful exec modelling the staging-OFF merge of a branch carrying a DIVERGENT *.snap. The
  // two-phase merge (`--no-commit`) hits a snap-only conflict; the regen resolves it; the completing
  // commit makes the branch an ancestor of HEAD (so the f3 guard passes). The snap regen reports a
  // staged diff (`diff --cached --quiet` exits 1) so the helper returns "regenerated".
  function makeSnapMergeExec(opts: { regenThrows?: boolean } = {}) {
    const calls: string[] = [];
    const snap = "packages/storymap-ui/src/lib/storymap/__snapshots__/board-base-pipeline.test.ts.snap";
    let integrated = false;
    let vitestRan = false;
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      // main tree is clean (no board mutations) → empty-diff guard + clean-gate both see clean.
      if (cmd.includes("status --porcelain")) return { stdout: "", stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: "deadbeef\n", stderr: "" };
      if (cmd.includes("is-ancestor")) {
        if (integrated) return { stdout: "", stderr: "" };
        throw Object.assign(new Error("not ancestor"), { code: 1 });
      }
      // The branch's changed files include a *.snap → snapFiles non-empty → the snap-aware path runs.
      if (cmd.includes("diff --name-only") && !cmd.includes("--diff-filter=U")) {
        return { stdout: `${snap}\n`, stderr: "" };
      }
      // Phase 1: the snap makes the no-commit merge fail (snap is binary/unmergeable).
      if (cmd.includes("merge --no-ff --no-commit")) {
        throw Object.assign(new Error("CONFLICT (modify/delete)"), { code: 1, stderr: "CONFLICT in snap" });
      }
      // Phase 2 conflict inspection: ONLY the snap is unmerged → snap-only conflict → resolvable.
      if (cmd.includes("diff --name-only --diff-filter=U")) return { stdout: `${snap}\n`, stderr: "" };
      // The snap regen update run.
      if (cmd.includes("bunx vitest run -u")) {
        vitestRan = true;
        if (opts.regenThrows) throw Object.assign(new Error("red test"), { code: 1, stderr: "1 failed" });
        return { stdout: "", stderr: "" };
      }
      // After the regen staged the snap, `diff --cached --quiet` exits 1 (there IS a staged diff) →
      // the helper reads that as "regenerated". Throw to model the non-zero exit.
      if (cmd.includes("diff --cached --quiet")) {
        if (vitestRan) throw Object.assign(new Error("staged diff present"), { code: 1 });
        return { stdout: "", stderr: "" };
      }
      // The commit that COMPLETES the two-phase merge → the branch is now an ancestor of HEAD.
      if (cmd.includes("commit --no-verify --no-edit")) {
        integrated = true;
        return { stdout: "", stderr: "" };
      }
      // scan-secrets, rev-parse HEAD/HEAD^1, branch -D, push, etc. all succeed.
      return { stdout: "", stderr: "" };
    };
    return { exec, calls, snap };
  }

  it("regenerates a divergent *.snap from the merged source, folds it into the merge commit, lands `done` — NEVER false-parks (AC1)", async () => {
    const { exec, calls, snap } = makeSnapMergeExec();
    const rec = recordingFs();
    const { mq } = makeQueue({ exec, snapFs: rec.fs });

    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-z", runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("done"); // integrated — NOT false-parked as conflict
    expect(entry.conflictDetail).toBeUndefined();
    // The snap-aware two-phase merge ran (no-commit), the regen rebuilt the snap, and it was re-staged.
    expect(calls.some((c) => c.includes("merge --no-ff --no-commit"))).toBe(true);
    expect(calls.some((c) => c.includes("bunx vitest run -u"))).toBe(true);
    expect(calls.some((c) => c.includes(`checkout --theirs -- "${snap}"`))).toBe(true);
    expect(calls.some((c) => c.includes(`add -- "${snap}"`))).toBe(true);
    // The completing commit folded the regenerated snap INTO the merge commit (single push carries it).
    expect(calls.some((c) => c.includes("commit --no-verify --no-edit"))).toBe(true);
    // The branch was deleted only after the f3 ancestor guard passed.
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(true);
  });

  it("uses the injected snapFs for node_modules provisioning during regen (AC4 DI — absorbs card 2iiehr)", async () => {
    const { exec } = makeSnapMergeExec();
    const rec = recordingFs();
    const { mq } = makeQueue({ exec, snapFs: rec.fs });

    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-z", runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done");
    // The regen linked node_modules in via the INJECTED fs (not the module-level default) and dropped them.
    expect(rec.linked.length).toBeGreaterThan(0);
    expect(rec.unlinked.length).toBeGreaterThan(0);
  });

  it("undoes the merge (reset/abort) and re-drives when the snap-regen vitest THROWS (AC1 failure path)", async () => {
    const { exec, calls } = makeSnapMergeExec({ regenThrows: true });
    const rec = recordingFs();
    // A redrive handler that ADMITS so the entry terminalizes as `re-driving` (proves the failure routed
    // through maybeRedrive, not a silent done).
    const { mq } = makeQueue({ exec, snapFs: rec.fs });
    mq.setRedriveHandler(async () => ({ ok: true }));

    await mq.enqueueMerge({
      ...input({ board: "storymap", cardId: "story-z", runId: "s1", branch: "run/s1" }),
      trigger: "harness-do",
    });
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    // The regen failed → the snap-aware merge aborted (main pristine) → re-driven (not done, not a silent merge).
    expect(entry.status).toBe("re-driving");
    expect(calls.some((c) => c.includes("bunx vitest run -u"))).toBe(true);
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(true); // the half-merge was rolled back
    // It NEVER reached the `branch -D` (the run branch is preserved for re-drive).
    expect(calls.some((c) => c.includes('branch -D "run/s1"'))).toBe(false);
    // LOW #3: the redrive message SURFACES the regen error reason for operator triage (the bare `catch {}`
    // used to swallow it, leaving a reasonless detail). The vitest threw with stderr "1 failed".
    expect(entry.conflictDetail).toContain("snapshot regen falhou");
    expect(entry.conflictDetail).toContain("1 failed"); // FAILS without LOW #3 (reason was dropped)
  });

  it("treats a NON-snap unmerged path as a REAL content conflict — aborts + parks (no false snap-resolution)", async () => {
    // The two-phase merge conflicts, but the unmerged set includes a real source file (not just the snap)
    // → it must NOT be snap-resolved; abort + maybeRedrive (the existing safe content-conflict path).
    const snap = "packages/storymap-ui/src/lib/storymap/__snapshots__/board-base-pipeline.test.ts.snap";
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("status --porcelain")) return { stdout: "", stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: "deadbeef\n", stderr: "" };
      if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      if (cmd.includes("diff --name-only") && !cmd.includes("--diff-filter=U")) {
        return { stdout: `${snap}\npackages/storymap-ui/src/real.ts\n`, stderr: "" };
      }
      if (cmd.includes("merge --no-ff --no-commit")) {
        throw Object.assign(new Error("CONFLICT"), { code: 1, stderr: "CONFLICT (content)" });
      }
      // Phase 2: the unmerged set has BOTH the snap AND a real source file → NOT snap-only.
      if (cmd.includes("diff --name-only --diff-filter=U")) {
        return { stdout: `${snap}\npackages/storymap-ui/src/real.ts\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const rec = recordingFs();
    const { mq } = makeQueue({ exec, snapFs: rec.fs });

    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-z", runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    const entry = mq.getSnapshot().entries[0];
    expect(entry.status).toBe("conflict"); // a REAL conflict → parked
    // It did NOT try to snap-resolve (no checkout --theirs / vitest -u) and it aborted the merge.
    expect(calls.some((c) => c.includes("checkout --theirs"))).toBe(false);
    expect(calls.some((c) => c.includes("bunx vitest run -u"))).toBe(false);
    expect(calls.some((c) => c.includes("merge --abort"))).toBe(true);
  });
});

describe("makeMergeQueue — staging-OFF tree-clean GATE before the merge-back (story-zdeajs AC2/AC3)", () => {
  it("parks `conflict` with the DIRTY-TREE marker (not a content conflict) and PAUSES the FIFO when the tree is still dirty after the board commit", async () => {
    // The board commit fails to clean the tree (e.g. an external SSH writer raced, or the commit was
    // blocked) → `git status --porcelain` STILL reports dirty. The doomed merge must NOT be attempted;
    // the head parks with a DISTINCT dirty-tree detail and the FIFO pauses (a dirty SHARED tree blocks all).
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      // Tree stays dirty across the whole run (commit never cleans it — simulates an external racer).
      if (cmd.includes("status --porcelain")) return { stdout: " M packages/storymap-ui/src/x.ts\n", stderr: "" };
      if (cmd.includes("scan-secrets")) return { stdout: "", stderr: "" };
      if (cmd.includes("rev-parse --verify")) return { stdout: "deadbeef\n", stderr: "" };
      if (cmd.includes("is-ancestor")) throw Object.assign(new Error("not ancestor"), { code: 1 });
      return { stdout: "", stderr: "" };
    };
    const { mq, read } = makeQueue({ exec });

    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-z", runId: "s1", branch: "run/s1" }));
    // A SECOND distinct card waits behind it — it must NOT drain (the dirty tree blocks ALL merges → break).
    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-y", runId: "s2", branch: "run/s2" }));
    await mq.whenIdle();

    const snap = mq.getSnapshot();
    const head = snap.entries.find((e) => e.runId === "s1")!;
    expect(head.status).toBe("conflict");
    expect(head.conflictDetail).toContain("SUJA"); // the dirty-tree marker
    expect(head.conflictDetail).toContain("NÃO é conflito de conteúdo"); // explicitly NOT a content conflict
    // The doomed `git merge --no-ff` was NEVER attempted on the dirty tree.
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(false);
    // The FIFO PAUSED at this head (break) — the second waiter is still `waiting`, not drained.
    const behind = snap.entries.find((e) => e.runId === "s2")!;
    expect(behind.status).toBe("waiting");
    expect(snap.processing).toBe(false);
    expect(read().find((e) => e.runId === "s1")!.status).toBe("conflict"); // durable
  });

  it("a CLEAN tree (board commit was a no-op or succeeded) proceeds straight to the merge — no false dirty-tree park (behavior-neutral)", async () => {
    const { exec, calls } = makeRealisticExec(); // status falls through to empty → clean tree
    const { mq } = makeQueue({ exec });

    await mq.enqueueMerge(input({ board: "storymap", cardId: "story-z", runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    expect(mq.getSnapshot().entries[0].status).toBe("done"); // merged cleanly
    expect(calls.some((c) => c.includes("merge --no-ff"))).toBe(true); // the merge actually ran
  });
});

// ── O bug que matou o recovery sweep (2026-07-13) ───────────────────────────────────────────────────
// `liveRunIds()` devolvia TODAS as entradas, inclusive as terminais. A fila retém até
// MAX_TERMINAL_RETAINED (100) terminais, e o gate de ociosidade do sweep é `liveRunIds().length === 0`
// (instrumentation.ts). Com o cap saturado — 100 entradas, 0 vivas — `isIdle()` era SEMPRE falso e o
// sweep pulava TODO tick, PARA SEMPRE: recuperação de runs órfãos, branch GC e a reconciliação de
// deploy-failure morreram em silêncio no dia em que a fila encheu. Zero sinal nos logs.
//
// Estes testes fixam a semântica dos DOIS métodos. Se alguém reconflatá-los, a suíte grita.
describe("liveRunIds vs allRunIds — a fila cheia de terminais AINDA está ociosa", () => {
  const terminal = (runId: string, status: "done" | "failed"): MergeQueueEntry =>
    ({ runId, board: "acme", cardId: "c1", branch: `run/${runId}`, status, enqueuedAt: 1 }) as MergeQueueEntry;
  const alive = (runId: string): MergeQueueEntry =>
    ({ runId, board: "acme", cardId: "c1", branch: `run/${runId}`, status: "waiting", enqueuedAt: 2 }) as MergeQueueEntry;

  it("liveRunIds NÃO conta entradas terminais — o cenário exato do incidente (100 done/failed, 0 vivas)", async () => {
    const seed = Array.from({ length: 96 }, (_, i) => terminal(`d${i}`, "done")).concat(
      Array.from({ length: 4 }, (_, i) => terminal(`f${i}`, "failed")),
    );
    const { store } = makeStore(seed);
    const { mq } = makeQueue({ store });
    expect(await mq.liveRunIds()).toEqual([]); // ← ANTES devolvia os 100 → isIdle() nunca era true
    expect((await mq.allRunIds()).length).toBe(100); // o conjunto completo segue disponível p/ quem precisa
  });

  it("liveRunIds conta SÓ as vivas quando há uma mistura", async () => {
    const { store } = makeStore([terminal("d1", "done"), alive("live1"), terminal("f1", "failed")]);
    const { mq } = makeQueue({ store });
    expect(await mq.liveRunIds()).toEqual(["live1"]);
    expect((await mq.allRunIds()).sort()).toEqual(["d1", "f1", "live1"]);
  });

  it("allRunIds inclui as terminais — é o que a proteção anti-órfão do settle-gap precisa (órfão = SEM entrada)", async () => {
    const { store } = makeStore([terminal("integrado", "done")]);
    const { mq } = makeQueue({ store });
    // um run já integrado (entrada terminal) NÃO é órfão de settle-gap: seu branch não pode ser varrido
    expect(await mq.allRunIds()).toContain("integrado");
    expect(await mq.liveRunIds()).not.toContain("integrado");
  });
});

// ── O MESMO bug, um degrau adiante (2026-07-23) ─────────────────────────────────────────────────────
// Corrigido o caso das TERMINAIS, sobrou o das PARKEADAS. `liveRunIds` conta gate-failed/conflict — e
// uma entrada parkeada espera um HUMANO, por dias. Quem usa a resposta como portão de ociosidade
// (pipelineIdle) cai num impasse circular: publicar espera ociosidade → ociosidade espera o conflito
// parkeado → o conflito parkeado espera alguém decidir. Foi o que aconteceu: um conflito parkeado desde
// 21/07 deixou a fila de publicação E o recovery sweep pulando TODO tick, em silêncio, por dois dias —
// três pedidos de publicação empilhados em `waiting`, `main` intocada, zero linha de log.
//
// O contrato de `PipelineIdleProbes.liveMergeEntries` JÁ dizia "parked não entra". Faltava alguém
// implementar. Estes testes travam a distinção nos dois sentidos.
describe("activeRunIds vs liveRunIds — um conflito PARKEADO não é trabalho em voo", () => {
  const mk = (runId: string, status: MergeQueueEntry["status"]): MergeQueueEntry =>
    ({ runId, board: "acme", cardId: "c1", branch: `run/${runId}`, status, enqueuedAt: 1 }) as MergeQueueEntry;

  it("o cenário EXATO do incidente: só um conflito parkeado ⇒ NADA em voo (pipeline ocioso)", async () => {
    const { store } = makeStore([mk("parkeado", "conflict")]);
    const { mq } = makeQueue({ store });
    expect(await mq.activeRunIds()).toEqual([]); // ← o portão de ociosidade abre
    expect(await mq.liveRunIds()).toEqual(["parkeado"]); // ← mas a entrada SEGUE ocupando a fila
  });

  it.each(["gate-failed", "conflict"] as const)("%s é parkeado — fora de activeRunIds", async (status) => {
    const { store } = makeStore([mk("p", status)]);
    const { mq } = makeQueue({ store });
    expect(await mq.activeRunIds()).toEqual([]);
    expect(await mq.liveRunIds()).toEqual(["p"]);
  });

  it.each(["waiting", "gate-running", "merging"] as const)("%s é EM VOO — bloqueia mesmo", async (status) => {
    const { store } = makeStore([mk("a", status)]);
    const { mq } = makeQueue({ store });
    expect(await mq.activeRunIds()).toEqual(["a"]);
  });

  it.each(["done", "failed"] as const)("%s é terminal — nem ativo nem vivo", async (status) => {
    const { store } = makeStore([mk("t", status)]);
    const { mq } = makeQueue({ store });
    expect(await mq.activeRunIds()).toEqual([]);
    expect(await mq.liveRunIds()).toEqual([]);
  });

  it("uma sessão irmã EM VOO ao lado de um parkeado ainda segura o portão (o fix não cega o caso legítimo)", async () => {
    const { store } = makeStore([mk("parkeado", "conflict"), mk("em-voo", "gate-running")]);
    const { mq } = makeQueue({ store });
    expect(await mq.activeRunIds()).toEqual(["em-voo"]);
  });

  it("active é sempre subconjunto de live — se alguém reconflatá-los, isto grita", async () => {
    const seed = (["waiting", "gate-running", "merging", "gate-failed", "conflict", "done", "failed"] as const).map(
      (s, i) => mk(`e${i}`, s),
    );
    const { store } = makeStore(seed);
    const { mq } = makeQueue({ store });
    const [active, live] = [await mq.activeRunIds(), await mq.liveRunIds()];
    expect(live).toEqual(expect.arrayContaining(active));
    expect(active.length).toBeLessThan(live.length); // estritamente menor: há parkeados no seed
  });
});

// WS-10.3 — O CALL-SITE DO TRAIN (climbSemanticLadder). A escada em si é coberta por
// semantic-resolution.test.ts (degraus, tudo-ou-nada, fail-closed); o que se prova AQUI é o que só o train
// sabe fazer: QUEM ele manda ao juiz, e o que ele FAZ com cada veredito. É o gap do cenário 8 ("divergência
// cosmética no train E no release"): nenhum teste dirigia o juiz por dentro da fila, então o comportamento
// do train diante de uma resolução era código não-exercitado.
//
// A divergência real é o conflito do `apply --3way` do código contra o `stage` — o mesmo setup dos testes de
// park/re-drive do split (stagingExec + codeConflict), com um juiz FAKE injetado na config (o port é DI
// exatamente para isto: um port real faria spawn de `claude` dentro de um unit test).
describe("makeMergeQueue — o call-site do TRAIN dirige a escada semântica (WS-10.3)", () => {
  afterEach(() => {
    // volta o loadRunnerConfig ao default do factory (delegar ao módulo real) — só o teste da flag OFF o troca.
    vi.mocked(loadRunnerConfig).mockReset();
  });

  /** Um exec do split em que o patch de UM run específico conflita — os demais aplicam limpo. Sem isto não
   *  dá para provar a RE-ENTRADA: o artefato do juiz é uma entry nova (runId `<id>-resolved` → outro nome de
   *  patch), e ela precisa integrar de verdade para o "o gate roda de novo" ser um fato, não uma promessa. */
  function conflictingPatchExec(opts: { changed: string; conflictOn: string }) {
    const inner = stagingExec({ changed: opts.changed });
    const exec: ExecFn = async (cmd, o) => {
      if (cmd.includes(opts.conflictOn) && (cmd.includes("apply --check") || cmd.includes("apply --index --3way"))) {
        inner.calls.push(cmd);
        throw Object.assign(new Error("conflict markers"), { code: 1 });
      }
      return inner.exec(cmd, o);
    };
    return { exec, calls: inner.calls };
  }

  /** Um juiz FAKE: grava o pedido que o train montou e devolve o veredito roteirizado. */
  function recordingJudge(verdict: () => Awaited<ReturnType<JudgePort>>) {
    const requests: JudgeRequest[] = [];
    const judge: JudgePort = async (req) => {
      requests.push(req);
      return verdict();
    };
    return { judge, requests };
  }

  const CHANGED = "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md";
  const cosmetic = (file: string) => ({ file, hunk: "<<<<<<<\na\n=======\nb\n>>>>>>>", verdict: "cosmetic" as const, rationale: "os dois lados reescrevem o mesmo comentário" });

  it("uma divergência COSMÉTICA resolvida pelo juiz RE-ENFILEIRA uma entry NOVA e o GATE roda DE NOVO sobre a árvore julgada (invariante 1)", async () => {
    // A palavra final NUNCA é do juiz: é do gate determinístico. O artefato resolvido re-entra pelo mecanismo
    // normal (uma entry como qualquer outra), então o gate + o split + o secret-scan rodam sobre ele.
    const { exec } = conflictingPatchExec({ changed: CHANGED, conflictOn: "split-s1-code.patch" });
    const { judge, requests } = recordingJudge(() => ({ hunks: [cosmetic("packages/acmeapp/x.ts")], runId: "judge-1", resolvedRef: "resolve/s1" }));
    const { gate, branches } = recordingGate(() => ({ passed: true, log: "" }));
    const { mq, read } = makeQueue({ exec, staging: STAGING, judge, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();

    // O train mandou ao juiz a SUA divergência: os dois lados do apply (stage × o branch do run) e só os
    // arquivos de código conflitantes — nunca o card (esse é do merge determinístico do WS-2).
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sides: { ours: "stage", theirs: "run/s1", files: ["packages/acmeapp/x.ts"] },
      base: "stageSha1",
      origin: "train",
      board: "acme",
      cardId: "story-1",
    });
    // INVARIANTE 1: o gate rodou DUAS vezes — a do run e a da árvore que o juiz produziu.
    expect(branches).toEqual(["run/s1", "resolve/s1"]);

    const [original, resolved] = read();
    expect(original.status).toBe("re-driving"); // a entry original terminaliza; ela não parqueia por um humano
    expect(original.conflictDetail).toContain("resolvido pelo juiz semântico");
    // A entry NOVA carrega o artefato do juiz, ancorada no tip do alvo (reusar o baseCommit original
    // reabriria a divergência que o juiz acabou de fechar) e integra de verdade.
    expect(resolved).toMatchObject({ runId: "s1-resolved", branch: "resolve/s1", baseCommit: "stage", board: "acme", cardId: "story-1", status: "done" });
    // O contador RIDE na sucessora: se o artefato resolvido conflitar de novo, ela não compra um 2º juiz.
    expect(resolved.semanticAttempts).toBe(1);
    expect(resolved.resolutionAnalysis).toMatchObject({ outcome: "resolved-cosmetic" });
  });

  it("uma divergência SUBSTANTIVA escala com a análise POR HUNK anexada à ENTRY — é o que o Inbox renderiza", async () => {
    // O entregável do WS: o item parqueado deixa de ser um stderr cru e passa a ser "o hunk X é substantivo
    // porque …". Tudo-ou-nada: o hunk cosmético do meio NÃO é aplicado, mas a análise cobre os dois.
    const { exec, calls } = conflictingPatchExec({ changed: CHANGED, conflictOn: "split-s1-code.patch" });
    const { judge, requests } = recordingJudge(() => ({
      hunks: [
        cosmetic("packages/acmeapp/x.ts"),
        { file: "packages/acmeapp/x.ts", hunk: "<<<<<<<\nreturn 1\n=======\nreturn 2\n>>>>>>>", verdict: "substantive" as const, rationale: "os dois lados devolvem valores diferentes" },
      ],
      runId: "judge-2",
    }));
    const { mq, read } = makeQueue({ exec, staging: STAGING, judge });

    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();

    expect(requests).toHaveLength(1);
    expect(read()).toHaveLength(1); // nada re-enfileirado: nenhum artefato foi materializado
    const entry = read()[0];
    expect(entry.status).toBe("conflict"); // parqueia para o humano, como antes da escada
    expect(entry.resolutionAnalysis?.outcome).toBe("escalated-substantive");
    expect(entry.resolutionAnalysis?.hunks).toHaveLength(2); // a análise cobre TODOS os hunks, não só o culpado
    expect(entry.resolutionAnalysis?.hunks?.[1]).toMatchObject({ verdict: "substantive", rationale: "os dois lados devolvem valores diferentes" });
    expect(entry.semanticAttempts).toBe(1); // a tentativa foi GASTA — a 2ª subida da mesma entry é barrada
    // e o `stage` continua intocado: nenhuma resolução parcial foi commitada lá.
    expect(calls.some((c) => c.includes('commit --no-verify -m "usm(story-1): código staged'))).toBe(false);
  });

  it("D3/P-4 — sessão climba os degraus GRÁTIS (0/1) mas NUNCA o juiz pago; a análise volta com ela", async () => {
    // A sessão viva TEM o contexto, está viva, e resolve com `worktree_refresh` em segundos: é um LLM mais
    // bem posicionado que o juiz. Gastar um juiz aqui seria estritamente pior E mais lento — D3 permanece.
    // O que MUDOU (P-4): D3 era grosso demais e desligava a escada INTEIRA para sessão, que é 96% do
    // tráfego — o resultado medido foram ZERO acionamentos da escada em 137 h de produção. Os degraus 0
    // (isto já aterrissou?) e 1 (os dois lados são iguais módulo whitespace?) são GRÁTIS e não decidem
    // nada: rodá-los só acrescenta informação ao que a sessão recebe de volta.
    const { exec } = conflictingPatchExec({ changed: CHANGED, conflictOn: "split-sess-code.patch" });
    const { judge, requests } = recordingJudge(() => ({ hunks: [cosmetic("packages/acmeapp/x.ts")], runId: "judge-3", resolvedRef: "resolve/sess" }));
    const { mq, read } = makeQueue({ exec, staging: STAGING, judge });

    await mq.enqueueMerge({
      ...input({ runId: "sess", branch: "run/sess", board: "acme", cardId: "story-1" }),
      kind: "session",
      baseCommit: "stageSha1",
    });
    await mq.whenIdle();

    expect(requests).toEqual([]); // o juiz PAGO NUNCA foi chamado — é exatamente isto que D3 protege
    const entry = read()[0];
    expect(entry.status).toBe("returned-to-session"); // terminal: devolvido à sessão, sem parquear a fila
    // A análise dos degraus grátis VIAJA com a devolução, e diz a verdade sobre por que o degrau 2 não
    // rodou — antes a mensagem padrão era "sem juiz configurado", que mandaria a sessão caçar um defeito
    // de configuração inexistente em vez de rebasear.
    expect(entry.resolutionAnalysis?.outcome).toBe("escalated-substantive");
    expect(entry.resolutionAnalysis?.detail).toContain("NÃO roda para sessão viva");
    expect(entry.semanticAttempts).toBeUndefined(); // nenhum julgamento comprado ⇒ nenhuma tentativa gasta
  });

  it("invariante 7 — com a flag OFF o juiz não é invocado e NENHUM git da escada roda (comportamento de hoje)", async () => {
    // `semanticResolution: false` promete o comportamento de hoje: o conflito parqueia direto. Não é só "não
    // resolve" — é não TOCAR em nada: um `git diff -w` a mais já seria comportamento novo num caminho que
    // promete ser idêntico ao de antes da escada.
    const real = loadRunnerConfig();
    // A flag tem de EXISTIR na config real — se não existisse, virar `false` aqui não provaria nada sobre o
    // que o serviço lê, e o teste seria uma miragem.
    expect(real.autorun.mergeTrain?.semanticResolution).toBe(true);
    const mergeTrain = { ...real.autorun.mergeTrain!, semanticResolution: false };
    vi.mocked(loadRunnerConfig).mockImplementation(() => ({ ...real, autorun: { ...real.autorun, mergeTrain } }));
    const { exec, calls } = conflictingPatchExec({ changed: CHANGED, conflictOn: "split-s1-code.patch" });
    const { judge, requests } = recordingJudge(() => ({ hunks: [cosmetic("packages/acmeapp/x.ts")], runId: "judge-4", resolvedRef: "resolve/s1" }));
    const { mq, read } = makeQueue({ exec, staging: STAGING, judge });

    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1", board: "acme", cardId: "story-1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();

    expect(requests).toEqual([]); // sem juiz…
    expect(calls.some((c) => c.includes("--ignore-blank-lines"))).toBe(false); // …e sem o degrau 1 (nenhum git da escada)
    expect(read()).toHaveLength(1); // nada re-enfileirado
    expect(read()[0].status).toBe("conflict"); // parqueia exatamente como antes da escada existir
    expect(read()[0].semanticAttempts).toBeUndefined(); // `disabled` nunca gasta a tentativa
  });
});

// autonomy-endgame WS-3 — THE LINE OF THE INCIDENT (~merge-queue.ts:2040). It had NO test: the suite covered
// the data COMMIT failing, never the data APPLY failing with `codeStaged:true` — the exact signature of the
// two entries wedged in the live runtime (a779b5be / f873d987: `{codeStaged:true}`, no `dataLanded`). The
// scaffolding that pretended to cover it (`dataFails`) was never used by a test and could not have worked.
//
// The cause is a RACE, measured before any fix existed (5/80 unserialized applies died on `.git/index.lock`;
// 0/160 hit a content conflict). So the remedy is to RETRY THE PATCH — not `maybeRedrive`, which re-runs the
// whole skill: expensive (it re-implements code already on `stage` — the qb8z2c pattern, ~$13) and useless
// (the skill was never broken; `git apply` was).
describe("makeMergeQueue — WS-3: a metade de DADOS falha, e o remédio é o patch, não a skill", () => {
  const CHANGED = "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md";

  it("transitório: falha 1×, retenta o PATCH e aterrissa — ZERO redrive, ZERO spawn (o incidente, resolvido)", async () => {
    const { exec, calls } = stagingExec({ changed: CHANGED, dataApplyFailTimes: 1 });
    const redrives: unknown[] = [];
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    // THE POINT: the transient healed itself. Both halves landed, and nobody paid for an agent.
    expect(read()[0]?.status).toBe("done");
    expect(read()[0]?.split).toEqual({ codeStaged: true, dataLanded: true });
    expect(redrives).toHaveLength(0);
    // It retried the PATCH — the data apply ran more than once, and the skill ran zero times.
    expect(calls.filter((c) => c.includes("apply --check") && c.includes("-data.patch")).length).toBeGreaterThan(1);
    // ...and it NEVER renamed the branch (the first thing maybeRedrive does).
    expect(calls.some((c) => c.includes("branch -m"))).toBe(false);
  });

  it("bound esgotado ⇒ finding `data-not-landed` no card + entry parqueada — e NUNCA um redrive", async () => {
    const { exec, calls } = stagingExec({ changed: CHANGED, dataApplyFailTimes: Infinity });
    const redrives: unknown[] = [];
    const blockers: Array<{ cardId: string; runId: string; detail?: string }> = [];
    const { mq, read } = makeQueue({
      exec,
      staging: STAGING,
      addDataNotLandedBlocker: async (_b, cardId, runId, detail) => void blockers.push({ cardId, runId, detail }),
    });
    mq.setRedriveHandler(async (p) => {
      redrives.push(p);
      return { ok: true };
    });

    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();

    // NEVER a redrive — that is the whole WS-3.3 decision, asserted.
    expect(redrives).toHaveLength(0);
    expect(calls.some((c) => c.includes("branch -m"))).toBe(false);
    // The half-landing is now VISIBLE on the card instead of silent.
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ cardId: "story-1", runId: "s1" });
    // Parked, with a detail that names the RIGHT recovery — the operator's instinct here is the $13 button.
    const entry = read()[0];
    expect(entry?.status).toBe("conflict");
    expect(entry?.split).toEqual({ codeStaged: true }); // the live signature: code safe, data not landed
    expect(entry?.conflictDetail).toMatch(/MEIA-ATERRISSAGEM/);
    expect(entry?.conflictDetail).toMatch(/NÃO re-drivar/);
    expect(entry?.conflictDetail).toMatch(/-data\.patch/);
  });

  it("uma sessão card-less NÃO ganha finding (não há card) — seu equivalente é devolver o conflito à sessão", async () => {
    const { exec } = stagingExec({ changed: CHANGED, dataApplyFailTimes: Infinity });
    const blockers: unknown[] = [];
    const { mq } = makeQueue({
      exec,
      staging: STAGING,
      addDataNotLandedBlocker: async () => void blockers.push(1),
    });
    await mq.enqueueMerge({ runId: "s2", board: "acme", branch: "agent/s2", kind: "session" } as never);
    await mq.whenIdle();
    expect(blockers).toHaveLength(0); // não invente um card para pendurar aviso
  });

  it("o apply da metade de dados roda DENTRO do serializer (a corrida do incidente), o do código NÃO (D9)", async () => {
    const { exec } = stagingExec({ changed: CHANGED });
    // A recording serializer that captures WHICH git commands ran while it held the section.
    const inSection: string[] = [];
    let holding = false;
    const spyExec: ExecFn = async (cmd, o) => {
      if (holding) inSection.push(cmd);
      return exec(cmd, o);
    };
    const serializer: CommitSerializer = async (cwd, fn) => {
      holding = true;
      try {
        return await fn();
      } finally {
        holding = false;
      }
    };
    const { mq, read } = makeQueue({ exec: spyExec, staging: STAGING, commitSerializer: serializer });
    await mq.enqueueMerge(input({ runId: "s1", branch: "run/s1" }));
    await mq.whenIdle();
    expect(read()[0]?.status).toBe("done");

    // The DATA apply is inside the critical section — this is the fix, asserted at the mechanism level.
    expect(inSection.some((c) => c.includes("apply") && c.includes("-data.patch"))).toBe(true);
    // ...and so is the board commit it must be atomic with (half-serializing was the original defect).
    expect(inSection.some((c) => c.includes("commit") && c.includes("board:"))).toBe(true);
    // The CODE half stays OUT (D9): `<repo>-stage` is an isolated worktree sharing no index with main, so
    // serializing it would only cost throughput.
    expect(inSection.some((c) => c.includes("apply") && c.includes("-code.patch"))).toBe(false);
  });
});

describe("gate INCONCLUSIVO ≠ gate reprovado (infra não é defeito do submitter)", () => {
  // O gate morreu no meio (o processo foi morto por um `systemctl restart storymap` durante a suíte) e
  // devolveu apenas ruído de stderr de fixture. Reportar isso como "gate reprovou" manda a sessão caçar
  // uma regressão que não existe — a mesma confusão infra×produto que o contrato de capacidade fecha um
  // nível abaixo. O bloqueio permanece (fail-closed); o que muda é a HONESTIDADE do motivo.
  it("um gate sem veredito devolve a sessão rotulado INCONCLUSIVO, não como reprovação", async () => {
    const { gate } = recordingGate(() => ({
      passed: false,
      inconclusive: true,
      log: "[harness-autorun harness-do storymap/story-1] No conversation found with session ID: sess-gone",
    }));
    const { exec, calls } = makeRealisticExec();
    const { mq, read } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge({ ...input({ runId: "sess", branch: "run/sess", cardId: "story-a" }), kind: "session" });
    await mq.whenIdle();

    const entry = read()[0];
    expect(entry.status).toBe("returned-to-session");
    expect(entry.conflictDetail).toContain("INCONCLUSIVO");
    expect(entry.conflictDetail).toContain("re-submeta");
    expect(entry.conflictDetail).not.toContain("gate de integração reprovou");
    // fail-closed segue valendo: nada foi integrado em main
    expect(calls.some((c) => c.includes("git merge --no-ff"))).toBe(false);
  });

  it("uma reprovação REAL (falhas atribuídas) continua dizendo que reprovou", async () => {
    const { gate } = recordingGate(() => ({ passed: false, log: "2 teste(s) quebrado(s) por este card" }));
    const { exec } = makeRealisticExec();
    const { mq, read } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge({ ...input({ runId: "sess2", branch: "run/sess2", cardId: "story-b" }), kind: "session" });
    await mq.whenIdle();

    const entry = read()[0];
    expect(entry.conflictDetail).toContain("gate de integração reprovou");
    expect(entry.conflictDetail).not.toContain("INCONCLUSIVO");
  });

  it("gate INCONCLUSIVO TRANSITÓRIO é re-enfileirado e INTEGRA no retry (sem re-submit manual)", async () => {
    // Infra flakou UMA vez (processo do gate morto/poluído); no retry a suíte passa. O train re-enfileira
    // sozinho — a sessão não precisa de worktree_refresh + re-submit manual (o custo real do incidente do
    // topnav, 2026-07-24). Só um gate PERSISTENTEMENTE inconclusivo (o teste acima) é que devolve a sessão.
    let n = 0;
    const { gate } = recordingGate(() =>
      ++n === 1
        ? { passed: false, inconclusive: true, log: "infra flake (sem JSON parseável)" }
        : { passed: true, log: "✓ verde no retry" },
    );
    const { exec } = makeRealisticExec();
    const { mq, read } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });

    await mq.enqueueMerge({ ...input({ runId: "sflaky", branch: "run/sflaky", cardId: "story-c" }), kind: "session" });
    await mq.whenIdle();

    const entry = read()[0];
    expect(n).toBe(2); // rodou o gate 2x: inconclusivo → re-fila → verde
    expect(entry.status).not.toBe("returned-to-session"); // integrou, NÃO devolveu à sessão
    expect(entry.gateInconclusiveRetries).toBe(1); // registrou 1 re-enfileiramento
  });
});

describe("orphanSplitPatches — GC dos split-*.patch sem entrada dona", () => {
  it("apaga só os patches cujo runId saiu da fila; preserva os de entradas retidas e ignora não-patches", () => {
    const files = [
      "split-alive-code.patch",
      "split-alive-data.patch",
      "split-gone-code.patch",
      "split-gone-data.patch",
      "merge-queue.json",
      "flaky.json",
    ];
    expect(orphanSplitPatches(files, new Set(["alive"])).sort()).toEqual([
      "split-gone-code.patch",
      "split-gone-data.patch",
    ]);
  });

  it("runId com hífens (uuid) casa certo — vivo preserva, órfão apaga", () => {
    const files = ["split-a1b2-c3d4-e5f6-data.patch"];
    expect(orphanSplitPatches(files, new Set(["a1b2-c3d4-e5f6"]))).toEqual([]);
    expect(orphanSplitPatches(files, new Set())).toEqual(["split-a1b2-c3d4-e5f6-data.patch"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ONDA 1/2 do redesign do train. O que se prova aqui é o que a produção mediu e o código não garantia:
// (a) o conflito vira ARTEFATO legível em vez de nove palavras; (b) PARQUEAR é verbo só de run — a
// invariante D3 valia num `if` e não nos outros seis; (c) o gate detecta o conflito ANTES da suíte; e
// (d) uma cabeça travada não congela o sistema até alguém reiniciar o serviço.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("stuckEntries — o prazo só morde quem está EM VOO", () => {
  const mk = (runId: string, status: MergeQueueEntry["status"], startedAt?: number): MergeQueueEntry =>
    ({ runId, board: "b", branch: `run/${runId}`, status, enqueuedAt: 0, mergeStartedAt: startedAt }) as MergeQueueEntry;
  const NOW = 10_000_000;

  it("pega merging/gate-running além do prazo", () => {
    const got = stuckEntries([mk("a", "merging", NOW - 5000), mk("b", "gate-running", NOW - 5000)], NOW, 1000);
    expect(got.map((e) => e.runId)).toEqual(["a", "b"]);
  });

  it("NÃO pega `waiting` — esperar a vez é o funcionamento normal da fila", () => {
    // Matar quem espera transformaria uma fila longa numa fila que come trabalho.
    expect(stuckEntries([mk("w", "waiting", NOW - 999_999)], NOW, 1000)).toEqual([]);
  });

  it("NÃO pega quem está dentro do prazo", () => {
    expect(stuckEntries([mk("a", "merging", NOW - 500)], NOW, 1000)).toEqual([]);
  });

  it("sem `mergeStartedAt` NÃO pega — 'não sei desde quando' jamais autoriza uma ação destrutiva", () => {
    expect(stuckEntries([mk("a", "merging")], NOW, 1000)).toEqual([]);
  });

  it("prazo <= 0 desliga a varredura inteira", () => {
    expect(stuckEntries([mk("a", "merging", 0)], NOW, 0)).toEqual([]);
  });

  it("terminal/parkeado nunca entra", () => {
    const seed = (["done", "failed", "conflict", "gate-failed"] as const).map((s) => mk(s, s, NOW - 999_999));
    expect(stuckEntries(seed, NOW, 1000)).toEqual([]);
  });
});

describe("sweepStuck — destrava a cabeça sem MENTIR sobre ociosidade", () => {
  const stale = (): MergeQueueEntry =>
    ({ runId: "travada", board: "acme", cardId: "c1", branch: "run/travada", status: "merging", enqueuedAt: 1, mergeStartedAt: 1 }) as MergeQueueEntry;

  it("o modo de falha REAL: laço morto + entrada `merging` ⇒ o train ficava travado para sempre", async () => {
    const { store, read } = makeStore([stale()]);
    // Antes desta varredura: toda chamada de process() entrava no laço, via `some(status === 'merging')`
    // e saía na hora — sem log, sem saída, sem nada além de reiniciar o serviço.
    const { mq } = makeQueue({ store, entryDeadlineMs: 1 });
    await mq.whenIdle();
    expect(await mq.activeRunIds()).toEqual(["travada"]); // ← o portão de ociosidade FECHADO por ela

    const res = await mq.sweepStuck();
    expect(res.swept).toBe(1);
    expect(res.runIds).toEqual(["travada"]);
    const entry = read()[0];
    expect(entry.status).toBe("failed");
    expect(entry.failureReason).toContain("sem processador vivo");
    expect(await mq.activeRunIds()).toEqual([]); // ← manutenção (branch-GC/session-GC/publicação) volta
  });

  it("o branch é PRESERVADO — destravar a fila nunca é motivo para destruir trabalho", async () => {
    const { store, read } = makeStore([stale()]);
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts" });
    const { mq } = makeQueue({ store, exec, entryDeadlineMs: 1 });
    await mq.whenIdle();
    await mq.sweepStuck();
    expect(read()[0].branch).toBe("run/travada");
    expect(calls.some((c) => c.includes("branch -D"))).toBe(false);
  });

  it("com o processador VIVO ela apenas AVISA — marcar `failed` ali faria a publicação reiniciar por cima de um merge", async () => {
    // A segurança inteira mora aqui: `activeRunIds` alimenta o portão de ociosidade de quem PUBLICA
    // (reinicia o serviço). Um "vazio" falso enquanto um merge corre é pior que um travamento visível.
    let release!: () => void;
    const gateHeld = new Promise<void>((r) => (release = r));
    const { store } = makeStore();
    const { mq } = makeQueue({
      store,
      // O relógio do arquivo anda 1ms por leitura; para a entrada VENCER o prazo dentro do teste, este
      // anda 1min. A asserção é sobre a POLÍTICA (avisar × finalizar), não sobre o valor do prazo.
      now: (() => {
        let t = 1_000_000;
        return () => (t += 60_000);
      })(),
      entryDeadlineMs: 1,
      gateEnabled: true,
      integrationGate: async () => {
        await gateHeld;
        return { passed: true, log: "ok" };
      },
      exec: stagingExec({ changed: "packages/acmeapp/x.ts" }).exec,
      staging: STAGING,
    });
    await mq.enqueueMerge({ ...input({ runId: "viva", branch: "run/viva" }), baseCommit: "stageSha1" });
    await new Promise((r) => setTimeout(r, 5)); // deixa o laço entrar no gate e ficar preso lá

    const res = await mq.sweepStuck();
    expect(res.swept).toBe(0); // NADA foi finalizado
    expect(res.warned).toBe(1); // mas o operador foi avisado, com a idade
    expect(await mq.activeRunIds()).toEqual(["viva"]); // ← e o portão SEGUE fechado, que é a verdade

    release();
    await mq.whenIdle();
  });

  it("fila sã: nada a varrer", async () => {
    const { mq } = makeQueue({ entryDeadlineMs: 1 });
    expect(await mq.sweepStuck()).toEqual({ swept: 0, warned: 0, runIds: [] });
  });
});

describe("D3 nos SEIS parques que não o cumpriam — uma sessão viva nunca espera um humano", () => {
  // O incidente que isto fecha: a entrada b4fcc6e0 era uma SESSÃO e caiu no parque da metade de dados,
  // onde `finalize(entry, "conflict")` era chamado direto. Ficou 43,5 h esperando um humano, que no fim
  // ABORTOU — deixando o código em `stage` e o board-data fora de `main` para sempre. A invariante estava
  // implementada em `maybeRedrive` e no gate, e em nenhum dos outros seis sítios.
  it("metade de DADOS que não aplica: sessão é DEVOLVIDA, não parqueada", async () => {
    const { exec } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md", dataApplyFailTimes: Infinity });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge({ ...input({ runId: "sessao", branch: "run/sessao" }), kind: "session", baseCommit: "stageSha1" });
    await mq.whenIdle();

    const entry = read()[0];
    expect(entry.status).toBe("returned-to-session"); // ANTES: "conflict", e a sessão esperava dias
    expect(entry.conflictDetail).toContain("MEIA-ATERRISSAGEM");
    expect(entry.conflictDetail).toContain("NÃO re-drivar"); // a receita segue viajando junto
  });

  it("a MESMA falha num RUN segue parqueando para o operador — D3 não afrouxa nada para quem não está vivo", async () => {
    const { exec } = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md", dataApplyFailTimes: Infinity });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge({ ...input({ runId: "run1", branch: "run/run1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();
    expect(read()[0].status).toBe("conflict");
  });
});

describe("P-1 — o conflito vira ARTEFATO em vez de nove palavras", () => {
  it("o código que conflita grava arquivos na entry e os NOMEIA no detalhe devolvido", async () => {
    const { exec } = stagingExec({ changed: "packages/acmeapp/x.ts", codeConflict: true });
    const { mq, read } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge({ ...input({ runId: "s9", branch: "run/s9" }), kind: "session", baseCommit: "stageSha1" });
    await mq.whenIdle();

    const entry = read()[0];
    expect(entry.status).toBe("returned-to-session");
    expect(entry.conflict?.files).toContain("packages/acmeapp/x.ts");
    // ANTES: "split: código conflita com stage (run s9)" — e mais nada, para uma sessão que só podia chutar.
    expect(entry.conflictDetail).toContain("diverge em: packages/acmeapp/x.ts");
  });
});

describe("P-2 — o gate detecta o conflito ANTES de a suíte custar minutos", () => {
  const conflictGate = () =>
    (async () => ({
      passed: false,
      log: "o delta NÃO aplica em stage",
      conflict: { files: ["packages/acmeapp/x.ts"], hunks: [{ file: "packages/acmeapp/x.ts", hunk: "<<<<<<< ours" }] },
    })) as unknown as NonNullable<MergeQueueConfig["integrationGate"]>;

  it("conflito no gate ⇒ sessão DEVOLVIDA com os arquivos, e o split NUNCA roda", async () => {
    const { exec, calls } = stagingExec({ changed: "packages/acmeapp/x.ts" });
    const { mq, read } = makeQueue({ exec, staging: STAGING, gateEnabled: true, integrationGate: conflictGate() });
    await mq.enqueueMerge({ ...input({ runId: "g1", branch: "run/g1" }), kind: "session", baseCommit: "stageSha1" });
    await mq.whenIdle();

    const entry = read()[0];
    expect(entry.status).toBe("returned-to-session");
    expect(entry.conflict?.files).toEqual(["packages/acmeapp/x.ts"]);
    expect(entry.conflictDetail).toContain("diverge em: packages/acmeapp/x.ts");
    // A prova de que o trabalho foi POUPADO: nenhuma aplicação de patch, nenhum commit em stage.
    expect(calls.some((c) => c.includes("apply --index"))).toBe(false);
    expect(calls.some((c) => c.includes("código staged"))).toBe(false);
  });

  it("um gate que reprova SEM conflito segue sendo reprovação de teste (a rota antiga, intacta)", async () => {
    const { exec } = stagingExec({ changed: "packages/acmeapp/x.ts" });
    const { mq, read } = makeQueue({
      exec,
      staging: STAGING,
      gateEnabled: true,
      integrationGate: async () => ({ passed: false, log: "2 testes quebrados" }),
    });
    await mq.enqueueMerge({ ...input({ runId: "g2", branch: "run/g2" }), baseCommit: "stageSha1" });
    await mq.whenIdle();
    expect(read()[0].status).toBe("gate-failed");
    expect(read()[0].conflict).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-m3iouv — o gate decidia "o que é CÓDIGO" por ALLOW-LIST DE PREFIXO
//
// O ATAQUE. A régua era `pathsTouchCode(delta, ["packages/"])`. Logo, TUDO o que mora fora de
// `packages/` fundia sem o gate rodar nada — e o que mora fora de `packages/` inclui o próprio
// mecanismo de controle: `scripts/git-hooks/scan-secrets.mjs` (o scanner de segredo que o train re-roda a
// cada commit), `.github/**` (o CI) e o `justfile` (os comandos que o gate e o deploy invocam pelo nome).
// Quem alcança o train podia, num único delta, DESARMAR o controle de segurança por um caminho que o
// controle não cobre. A prova aconteceu: `c5c2f0013` apagou 461 linhas de workflow de CI e chegou a
// `origin/main` sem verificação alguma — ali a deleção era intencional, mas o mecanismo não sabia disso.
//
// A CORREÇÃO. Deny-list do que é comprovadamente DADO (`storymap/boards/**`), e o resto verifica. O
// board-data (~93% dos runs) segue exatamente como hoje — é o que impede a inversão de virar atrito, e é
// a lição de um freeze anterior (board-data classificado como código travou o train inteiro).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("merge train — a régua de VERIFICAÇÃO não é allow-list de prefixo (story-m3iouv)", () => {
  const gateSpy = () => {
    const seen: Array<Parameters<IntegrationGateRunner>[0]> = [];
    const gate: IntegrationGateRunner = async (opts) => {
      seen.push(opts);
      return { passed: true, log: "verde" };
    };
    return { gate, seen };
  };

  it("um delta que ALTERA o próprio scanner de segredo é VERIFICADO — não funde às cegas", async () => {
    const { gate, seen } = gateSpy();
    const { exec } = makeRealisticExec({ changed: "scripts/git-hooks/scan-secrets.mjs" });
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(seen).toHaveLength(1); // antes: ZERO — o delta desarmava o scanner sem passar por nada
    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });

  it("um delta que DELETA workflows de CI (`.github/**`) é VERIFICADO", async () => {
    const { gate, seen } = gateSpy();
    const { exec } = makeRealisticExec({ changed: ".github/workflows/ci.yml\n.github/workflows/deploy.yml" });
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(seen).toHaveLength(1);
  });

  it("um delta que reescreve o `justfile` é VERIFICADO", async () => {
    const { gate, seen } = gateSpy();
    const { exec } = makeRealisticExec({ changed: "justfile" });
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(seen).toHaveLength(1);
  });

  it("board-data (`storymap/boards/**`) continua PULANDO o gate — a inversão não cria atrito no fluxo normal", async () => {
    // A regressão que este teste guarda tem precedente: classificar board-data como código já congelou o
    // train inteiro. `.md` é path-disjunto do código e não pode deixar a suíte vermelha.
    const { gate, seen } = gateSpy();
    const { exec } = makeRealisticExec({ changed: "storymap/boards/acme/cards/story-1.md\nstorymap/boards/acme/board.yaml" });
    const { mq } = makeQueue({ exec, integrationGate: gate, gateEnabled: true });
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(seen).toEqual([]);
    expect(mq.getSnapshot().entries[0].status).toBe("done");
  });

  it("um arquivo de CONTROLE SUSPENDE a seleção por afetados — senão o escrutínio maior escolheria ZERO teste", async () => {
    // `affected` deriva os testes dos ARQUIVOS mudados. Um `justfile`/hook/workflow não é importado por
    // teste nenhum ⇒ zero selecionados ⇒ "verde" sem ter olhado nada. Justamente onde não pode.
    const affected = { enabled: true } as NonNullable<MergeQueueConfig["gateAffected"]>;
    const controle = gateSpy();
    const { exec } = makeRealisticExec({ changed: "scripts/git-hooks/scan-secrets.mjs" });
    const { mq } = makeQueue({ exec, integrationGate: controle.gate, gateEnabled: true, gateAffected: affected });
    await mq.enqueueMerge(input({ runId: "a", branch: "run/a" }));
    await mq.whenIdle();
    expect(controle.seen[0]?.affected).toBeUndefined(); // suíte COMPLETA

    // Contraprova: um delta de código comum mantém a otimização exatamente como hoje.
    const codigo = gateSpy();
    const { exec: exec2 } = makeRealisticExec({ changed: "packages/storymap-ui/src/foo.ts" });
    const { mq: mq2 } = makeQueue({ exec: exec2, integrationGate: codigo.gate, gateEnabled: true, gateAffected: affected });
    await mq2.enqueueMerge(input({ runId: "b", branch: "run/b" }));
    await mq2.whenIdle();
    expect(codigo.seen[0]?.affected).toEqual(affected);
  });

  it("a régua pura: só board-data é dado; controle, código e desconhecido verificam", () => {
    const code = ["packages/"];
    expect(classifyDeltaPath("storymap/boards/acme/cards/x.md", code)).toBe("board-data");
    expect(classifyDeltaPath("scripts/git-hooks/scan-secrets.mjs", code)).toBe("control");
    expect(classifyDeltaPath(".github/workflows/ci.yml", code)).toBe("control");
    expect(classifyDeltaPath("justfile", code)).toBe("control");
    expect(classifyDeltaPath(".claude/hooks/checks/pre-write/x.js", code)).toBe("control");
    expect(classifyDeltaPath(".claude/settings.json", code)).toBe("control");
    // O caso extremo: o arquivo que DECLARA se o gate roda não pode escapar do gate.
    expect(classifyDeltaPath("storymap/settings.yaml", code)).toBe("control");
    expect(classifyDeltaPath("packages/storymap-ui/src/a.ts", code)).toBe("code");
    // Vizinhos com nome parecido NÃO são o controle (o casamento é por pasta/igualdade, não por substring).
    expect(classifyDeltaPath("justfile-notas.md", code)).toBe("unclassified");
    expect(classifyDeltaPath("scripts/deploy/build.mjs", code)).toBe("unclassified");
    expect(classifyDeltaPath("turbo.json", code)).toBe("unclassified");

    expect(verificationDemand([], code).needsVerification).toBe(false);
    expect(verificationDemand(["storymap/boards/a/cards/b.md"], code).needsVerification).toBe(false);
    expect(verificationDemand(["turbo.json"], code).needsVerification).toBe(true); // era FALSE (o buraco)
    const d = verificationDemand(["storymap/boards/a/cards/b.md", "justfile"], code);
    expect(d.needsVerification).toBe(true);
    expect(d.controlPaths).toEqual(["justfile"]); // nomeados, para o rastro do operador
    // Um diff ILEGÍVEL verifica (fail-closed): "não sei o que entra" era exatamente o caso que fundia.
    expect(verificationDemand([], code, { diffReadable: false }).needsVerification).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-281gg4 — a FRONTEIRA DE CONTRIBUIÇÃO no branch que o deploy observa (train, lado do `stage`)
//
// O ATAQUE, no train. Depois de aplicar o código de um run em `stage`, o train empurra `origin/stage`. Se
// o push é recusado (origin andou), ele "reconcilia": `fetch origin stage` + `merge FETCH_HEAD`. `stage` é
// de onde `promoteStageToMain` promove para main, e main é o que o self-deploy builda e reinicia como
// root. Num repositório público, portanto, bastava a um terceiro pôr um commit em `origin/stage` e
// esperar: o próximo run do train o traria para dentro da linha de produção, sem gate, sem train, sem
// decisão. O reconcile existe para o DADO de outro checkout do dono — nunca para ser canal de código.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("merge train — fronteira de contribuição no reconcile do `stage` (story-281gg4)", () => {
  /** Envelopa o `stagingExec` com o que o caminho do reconcile precisa: um push recusado e um `origin`
   *  que traz `incoming`. Intercepta ANTES de delegar (o stagingExec responde qualquer diff --name-only). */
  function reconcileExec(incoming: string) {
    const inner = stagingExec({ changed: "packages/acmeapp/x.ts\nstorymap/boards/acme/cards/story-1.md" });
    const calls: string[] = [];
    let pushes = 0;
    const exec: ExecFn = async (cmd, opts) => {
      calls.push(cmd);
      if (cmd.includes("HEAD...FETCH_HEAD")) return { stdout: incoming, stderr: "" };
      if (cmd.includes('push origin "stage"')) {
        pushes += 1;
        if (pushes === 1) throw Object.assign(new Error("rejected"), { code: 1, stderr: "! [rejected] (non-fast-forward)" });
        return { stdout: "", stderr: "" };
      }
      return inner.exec(cmd, opts);
    };
    return { exec, calls };
  }

  const withTrust = async <T>(trust: string | undefined, body: () => Promise<T>): Promise<T> => {
    const before = process.env[ORIGIN_TRUST_ENV];
    if (trust === undefined) delete process.env[ORIGIN_TRUST_ENV];
    else process.env[ORIGIN_TRUST_ENV] = trust;
    try {
      return await body();
    } finally {
      if (before === undefined) delete process.env[ORIGIN_TRUST_ENV];
      else process.env[ORIGIN_TRUST_ENV] = before;
    }
  };

  const drive = async (exec: ExecFn) => {
    const { mq } = makeQueue({ exec, staging: STAGING });
    await mq.enqueueMerge({ ...input({ runId: "s1", branch: "run/s1" }), baseCommit: "stageSha1" });
    await mq.whenIdle();
  };

  it("com a fronteira DECLARADA public, código de terceiro em origin/stage NÃO é absorvido", async () => {
    const { exec, calls } = reconcileExec("packages/acmeapp/backdoor.ts");
    await withTrust("public", () => drive(exec));
    expect(calls.some((c) => c.includes("fetch origin"))).toBe(true); // o train PERGUNTOU o que havia lá
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(false); // e NÃO absorveu
  });

  it("board data de outro checkout do dono segue reconciliando sob a fronteira public (é o propósito do mecanismo)", async () => {
    const { exec, calls } = reconcileExec("storymap/boards/acme/cards/outra.md");
    await withTrust("public", () => drive(exec));
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
  });

  it("DEFAULT (fronteira não declarada) = comportamento de hoje: absorve e re-empurra", async () => {
    const { exec, calls } = reconcileExec("packages/acmeapp/do-dono.ts");
    await withTrust(undefined, () => drive(exec));
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(calls.filter((c) => c.includes('push origin "stage"')).length).toBe(2); // recusa + retry
  });

  it("ATAQUE: quebrar o diff de proveniência para o merge passar por 'origin não trouxe nada'", async () => {
    // A régua lia só o `stdout` do `git diff HEAD...FETCH_HEAD`. Diff que FALHA ⇒ stdout vazio ⇒ lista
    // vazia ⇒ `nothing`, a classe que a fronteira SEMPRE absorve: o único caso em que não se sabe o que
    // origin traz era o caso que entrava em `stage` — de onde o promote leva para main, que o self-deploy
    // builda e reinicia como root. O sibling desta régua no MESMO arquivo (`verificationDemand`) já trata
    // diff ilegível como fail-closed; aqui a mesma incerteza liberava. E provocar a falha não exige o
    // repositório: o train roda na MESMA árvore que outros escritores, então um lock de índice basta.
    const { exec, calls } = reconcileExec("packages/acmeapp/backdoor.ts");
    const quebrado: ExecFn = async (cmd, opts) => {
      if (cmd.includes("HEAD...FETCH_HEAD")) {
        throw Object.assign(new Error("fatal: bad object FETCH_HEAD"), { code: 128, stderr: "fatal: bad object" });
      }
      return exec(cmd, opts);
    };
    await withTrust("public", () => drive(quebrado));
    expect(calls.some((c) => c.includes("fetch origin"))).toBe(true); // o train PERGUNTOU
    expect(
      calls.some((c) => c.includes("merge --no-edit FETCH_HEAD")),
      "diff ILEGÍVEL virou 'origin não trouxe nada' e o merge absorveu o que ninguém conseguiu classificar",
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-281gg4 — a fronteira no reconcile do `main` (o MERGE-BACK), o que a primeira passada deixou de fora
//
// O ATAQUE. A fronteira foi construída em DOIS dos três reconciles: o do `stage` (acima) e o do release. O
// terceiro é este — depois de CADA integração o train empurra `main` e, se o push é recusado porque origin
// andou, reconcilia com `fetch` + `merge FETCH_HEAD`. É o pior dos três por duas razões: `main` é o branch
// que o self-deploy builda e reinicia COMO ROOT (no `stage` ainda há o promote entre o merge e a produção;
// aqui não há nada), e ele roda uma vez por MERGE, não uma por publicação — a superfície mais frequente do
// sistema. Bastava a um terceiro pôr um commit em `origin/main` e esperar o próximo card avançar.
//
// O que estes testes provam: o caminho que termina em root passou a ter a mesma régua dos outros dois, e o
// custo de autonomia é ZERO — a recusa só devolve `pushed:false`, que o train já trata como não-fatal e
// cumulativo (a entrada segue `done`, a fila segue andando, nenhum humano entra no caminho).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("merge train — fronteira de contribuição no reconcile do `main` (story-281gg4)", () => {
  /** O merge-back normal (sem staging), com `origin/main` à frente: o 1º `push origin HEAD` é RECUSADO e
   *  `origin` traz `incoming`. Intercepta o diff de proveniência ANTES de delegar (o exec realista
   *  responde qualquer `diff --name-only` com um caminho de código). */
  function mergeBackExec(incoming: string) {
    const inner = makeRealisticExec();
    const calls: string[] = [];
    let pushes = 0;
    const exec: ExecFn = async (cmd, opts) => {
      calls.push(cmd);
      if (cmd.includes("HEAD...FETCH_HEAD")) return { stdout: incoming, stderr: "" };
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "main", stderr: "" };
      if (cmd.includes("push origin HEAD")) {
        pushes += 1;
        if (pushes === 1) {
          throw Object.assign(new Error("rejected"), {
            code: 1,
            stderr: "! [rejected] main -> main (non-fast-forward)",
          });
        }
        return { stdout: "", stderr: "" };
      }
      return inner.exec(cmd, opts);
    };
    return { exec, calls, pushCount: () => pushes };
  }

  const withTrust = async <T>(trust: string | undefined, body: () => Promise<T>): Promise<T> => {
    const before = process.env[ORIGIN_TRUST_ENV];
    if (trust === undefined) delete process.env[ORIGIN_TRUST_ENV];
    else process.env[ORIGIN_TRUST_ENV] = trust;
    try {
      return await body();
    } finally {
      if (before === undefined) delete process.env[ORIGIN_TRUST_ENV];
      else process.env[ORIGIN_TRUST_ENV] = before;
    }
  };

  const drive = async (exec: ExecFn) => {
    const { mq } = makeQueue({ exec });
    await mq.enqueueMerge(input({ runId: "m1", branch: "run/m1" }));
    await mq.whenIdle();
    return mq.getSnapshot().entries[0];
  };

  it("ATAQUE: código de terceiro em origin/main NÃO entra na árvore que o self-deploy reinicia como root", async () => {
    const { exec, calls } = mergeBackExec("packages/acmeapp/backdoor.ts");
    const entry = await withTrust("public", () => drive(exec));
    expect(calls.some((c) => c.includes("fetch origin"))).toBe(true); // o train PERGUNTOU o que havia lá
    expect(
      calls.some((c) => c.includes("merge --no-edit FETCH_HEAD")),
      "o reconcile de `main` absorveu código externo — a fronteira cobria só `stage` e o release",
    ).toBe(false);
    // Custo de autonomia ZERO: nada trava, nada se perde, o push é cumulativo.
    expect(entry.status).toBe("done");
    expect(entry.pushError).toContain("rejected");
  });

  it("ATAQUE: o próprio mecanismo de controle (`scan-secrets.mjs`) chegando por origin/main", async () => {
    // story-m3iouv no caminho que termina em root: a régua antiga chamava isto de DADO (não está sob
    // `packages/`) e absorvia SEMPRE, mesmo sob `public`.
    const { exec, calls } = mergeBackExec("scripts/git-hooks/scan-secrets.mjs");
    await withTrust("public", () => drive(exec));
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(false);
  });

  it("board data de outro checkout do dono segue reconciliando sob `public` (é o propósito do mecanismo)", async () => {
    const { exec, calls, pushCount } = mergeBackExec("storymap/boards/acme/cards/outra.md");
    const entry = await withTrust("public", () => drive(exec));
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(pushCount()).toBe(2); // recusa + retry
    expect(entry.pushError).toBeFalsy();
  });

  it("DEFAULT (fronteira não declarada) = comportamento de hoje: absorve, re-empurra e nada é registrado", async () => {
    const { exec, calls, pushCount } = mergeBackExec("packages/acmeapp/do-dono.ts");
    const entry = await withTrust(undefined, () => drive(exec));
    expect(calls.some((c) => c.includes("merge --no-edit FETCH_HEAD"))).toBe(true);
    expect(pushCount()).toBe(2);
    expect(entry.pushError).toBeFalsy();
  });

  it("ATAQUE: quebrar o diff de proveniência do merge-back para o merge passar por 'nada de fora'", async () => {
    const { exec, calls } = mergeBackExec("packages/acmeapp/backdoor.ts");
    const quebrado: ExecFn = async (cmd, opts) => {
      if (cmd.includes("HEAD...FETCH_HEAD")) {
        throw Object.assign(new Error("fatal: bad object FETCH_HEAD"), { code: 128, stderr: "fatal: bad object" });
      }
      return exec(cmd, opts);
    };
    await withTrust("public", () => drive(quebrado));
    expect(
      calls.some((c) => c.includes("merge --no-edit FETCH_HEAD")),
      "diff ILEGÍVEL virou 'origin não trouxe nada' e o merge-back absorveu o inclassificável",
    ).toBe(false);
  });
});
