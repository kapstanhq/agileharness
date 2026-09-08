// Harness for the END-TO-END autorun flow journey tests (harness-flow.test.ts).
//
// WHY this exists — the strong per-component suites (engine.test.ts, merge-queue.test.ts,
// cascade-decision.test.ts, split-integration.test.ts, release.test.ts) each prove ONE unit in
// isolation, but the incidents that actually hurt were INTEGRATION/SEQUENCING bugs ACROSS them:
//   - a stale `stage` RELEASE that clobbered main (deleted 5602 lines),
//   - a run's worktree/branch reaped mid-flight losing work,
//   - cards stranded mid-column when the cascade didn't re-fire after a merge-back.
// These journeys drive a card through the REAL plumbing — the REAL `decideCascade` kernel, the REAL
// serial merge train (`makeMergeQueue`) over REAL git, the REAL split (code→stage / data→main) and
// the REAL `promoteStageToMain` release — with ONLY the LLM skill execution stubbed by a scripted
// `trigger → deterministic effect` map. No `claude` spawn, no network: 100% deterministic.
//
// Design (confirmed against engine.test.ts / split-integration.test.ts / release.test.ts):
//   - a throwaway git repo under os.tmpdir(), isolated via {@link isolatedGitExec} so it passes even
//     inside the merge train's nested gate worktree (see git-test-env.ts);
//   - an in-memory `Card` + the REAL `_base` board config (read from the live boards/_base + a minimal
//     storymap board.yaml), so the cascade walks the genuine canonical Stage→Step pipeline;
//   - a manual DRIVER that loops `decideCascade`: RUN → apply the scripted skill effect (edit the card,
//     write a stub file under packages/**, commit on a run branch, enqueue it on the REAL train);
//     FORWARD → write the new status (+ fire the REAL onEnter effect, e.g. promote-stage); STOP → halt.
//   - the merge queue's card-stamp callbacks (stampStaged/persistDiffSnapshot/clearRunBlockers/…) are
//     injected to mutate the in-memory card instead of `updateCardOnDisk` (which would hit the live
//     repo via findRepoRoot) — the train's git mechanics stay 100% real, only the card sink is local.
//
// NOT collected by vitest (the glob is `*.test.ts`); imported by harness-flow.test.ts.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHarnessTempDir } from "./temp";
import { promisify } from "node:util";
import matter from "gray-matter";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import { readBoardConfig } from "@/lib/storymap/repo";
import { FIXTURE_BOARD } from "@/lib/storymap/board-fixture";
import { decideCascade } from "@/lib/notifications/server/channels/cascade-decision";
import { entryEffect } from "@/lib/storymap/entry-effect";
import { promoteStageToMain } from "./release";
import { makeMergeQueue, type IntegrationGateRunner, type MergeQueuePort, type MergeQueueStore } from "./merge-queue";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import type { ExecFn } from "./worktree";
import type { MergeQueueEntry } from "./types";
import type { BoardConfig, Card, EntryEffect, TriggerId } from "@/lib/storymap/types";

const STAGE_BRANCH = "stage";
const CODE_PREFIXES = ["packages/"];

/** A scripted skill effect: how a harness-* trigger mutates a card + (optionally) the run worktree, in lieu
 *  of the real LLM. `card` is the freshly-read card; mutate it in place. `writeFile(rel, body)` writes a
 *  product/data file into the run worktree (committed onto the run branch). Return the status the skill
 *  advances the card TO (the skill's own end-of-run advance), or null to leave the card where it is. */
export type SkillEffect = (ctx: {
  card: Card;
  /** write a file (relative to the repo root) into the CURRENT working tree before the run commits. */
  writeFile: (rel: string, body: string) => Promise<void>;
}) => Promise<string | null> | string | null;

export interface HarnessOptions {
  /** the card's storyType — drives the cascade's skip rules (a `chore` skips the UI-design block). */
  storyType?: Card["storyType"];
  /** the scripted skill map: `trigger → effect`. A trigger with no entry is a no-op advance-less run. */
  effects?: Partial<Record<TriggerId, SkillEffect>>;
  /** the integration-gate verdict per run branch (DI — the FAKE gate the journeys control). Default: pass. */
  gateVerdict?: (branch: string) => { passed: boolean; log: string };
  /** turn the integration gate ON (default false — board-data-only runs never gate anyway). */
  gateEnabled?: boolean;
  /** seed the card at this status (default `desenvolver`). */
  startStatus?: string;
  /** seed the card's fields (tasks/acceptance/qaPassed/…) so gates pass where the journey needs them. */
  cardSeed?: Partial<Card>;
}

export interface Harness {
  tmpRoot: string;
  mainRepo: string;
  baseBranch: string;
  exec: ExecFn;
  config: BoardConfig;
  card: Card;
  mq: MergeQueuePort;
  /** the in-memory merge-queue store (observe entry lifecycle). */
  store: MergeQueueStore & { read: () => MergeQueueEntry[] };
  /** runIds whose merge-back fired onMergeDone (the cascade re-trigger signal). */
  mergeDone: Array<{ board: string; cardId: string; trigger?: TriggerId }>;
  /** git helpers over the main repo. */
  git: (args: string, cwd?: string) => Promise<{ stdout: string; code: number }>;
  show: (ref: string, cwd?: string) => Promise<string>;
  branchExists: (name: string) => Promise<boolean>;
  worktreeList: () => Promise<string[]>;
  /** read a path's content at a ref (empty string if absent). */
  fileAt: (ref: string, file: string) => Promise<string>;
  /** drive ONE cascade step for the card (RUN/FORWARD/STOP); returns what happened. */
  step: () => Promise<DriverEvent>;
  /** drive the cascade until it STOPs or `maxSteps` is hit; returns the trace. */
  drive: (maxSteps?: number) => Promise<DriverEvent[]>;
  /**
   * EXPLICITLY run the column's trigger skill (the manual "Rodar agora" / the skill's own advance) —
   * used to cross a MANUAL column (autorun:false: desenvolver/revisar-codigo/qa-automatizado) the way a
   * human kicks it off. Applies the scripted effect, commits a run branch, and feeds the REAL merge
   * train, exactly like the autorun RUN path — just without the autorun gate. Returns the run event.
   */
  runSkill: (trigger: TriggerId) => Promise<DriverEvent & { kind: "run" }>;
  /**
   * Model the HUMAN move (moveCardAction): set the card's status AND fire the destination step's
   * `onEnter` effect on a REAL status change (the SAME contract as a UI drag / MCP move_card). Moving
   * into `release` therefore fires the REAL promote-stage (stage → main). Returns the fired effect or null.
   */
  setStatus: (statusId: string) => Promise<EntryEffect | null>;
  cleanup: () => Promise<void>;
}

export type DriverEvent =
  | { kind: "run"; trigger: TriggerId; from: string; to: string | null; enqueued: boolean }
  | { kind: "forward"; from: string; to: string; effect: EntryEffect | null }
  | { kind: "stop"; reason: string; at: string | null };

/** A minimal valid Card seeded for the build cascade. Fields the journeys need (tasks/acceptance/…) are
 *  overlaid via `cardSeed` so the relevant gates pass. */
function seedCard(boardId: string, status: string, storyType: Card["storyType"], seed: Partial<Card>): Card {
  const base: Card = {
    id: "story-flow",
    type: "story",
    title: "Flow harness story",
    storyType,
    status,
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: "dev", want: "a deterministic e2e harness", soThat: "sequencing bugs are caught" },
    acceptance: ["Dado o pipeline, Quando o card flui, Então nada clobbera main"],
    tasks: [{ id: "t1", title: "implement", done: false }],
    rice: { reach: 100, impact: 2, confidence: 0.8, effort: 1 },
    kano: "performance",
    funnelStage: "activation",
    findings: [],
    order: 0,
    created: "2026-06-12",
    updated: "2026-06-12",
    body: "",
  } as Card;
  return { ...base, ...seed };
}

export async function makeFlowHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const storyType = opts.storyType ?? "story" as Card["storyType"];
  const startStatus = opts.startStatus ?? "desenvolver";
  // O board cuja pipeline canônica o harness caminha. É o fixture (`demo`) porque ele VIAJA: os
  // boards de produto do dono ficam no repositório privado, e sem sujeito no disco esta jornada
  // inteira viraria ENOENT no repositório extraído. A pipeline é a MESMA (o fixture herda o `_base`
  // com zero delta de passo) — o que se caminha aqui continua sendo o pipeline canônico de verdade.
  const boardId = FIXTURE_BOARD;

  // 22 órfãos: a remoção existia, mas fora de um `finally`. Na raiz do harness, o que escapar é
  // alcançável pela varredura.
  const tmpRoot = await makeHarnessTempDir("sm-flow");
  let exec = promisify(nodeExec) as unknown as ExecFn;
  exec = isolatedGitExec(exec, tmpRoot);
  await ensureRunnerStateDir();

  const mainRepo = path.join(tmpRoot, "main");
  await fsp.mkdir(path.join(mainRepo, "packages", "storymap-ui", "src"), { recursive: true });
  await fsp.mkdir(path.join(mainRepo, "storymap", "boards", boardId, "cards"), { recursive: true });
  await fsp.mkdir(path.join(mainRepo, "scripts", "git-hooks"), { recursive: true });
  // Copy the REAL secret scanner so the train's fail-closed pre-push rescan runs for real (no secrets).
  await fsp.copyFile(
    path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
    path.join(mainRepo, "scripts", "git-hooks", "scan-secrets.mjs"),
  );
  await fsp.writeFile(path.join(mainRepo, ".gitignore"), "node_modules\n.worktrees/\n");
  // SENTINEL: a file committed on main BEFORE the flow. Every journey asserts it survives intact — the
  // clobber canary (the 2026-06 incident deleted real code; this is the minimal reproduction surface).
  await fsp.writeFile(path.join(mainRepo, "packages", "storymap-ui", "src", "sentinel.ts"), "export const SENTINEL = 1;\n");
  await fsp.writeFile(path.join(mainRepo, "packages", "storymap-ui", "src", "existing.ts"), "export const existing = 'main';\n");

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

  // READ-ONLY: the genuine canonical Stage→Step pipeline (storymap inherits _base with zero delta), so
  // the driver walks the REAL statuses/gates/skipForTypes — not a hand-rolled fake. Never mutated.
  const config = await readBoardConfig(boardId);
  const card = seedCard(boardId, startStatus, storyType, opts.cardSeed ?? {});

  // In-memory merge-queue store (DI) so the entry lifecycle is observable without disk.
  let saved: MergeQueueEntry[] = [];
  const store: MergeQueueStore & { read: () => MergeQueueEntry[] } = {
    load: async () => saved.map((e) => ({ ...e })),
    persist: async (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
    read: () => saved,
  };

  const mergeDone: Array<{ board: string; cardId: string; trigger?: TriggerId }> = [];

  const gateVerdict = opts.gateVerdict ?? (() => ({ passed: true, log: "ok" }));
  const integrationGate: IntegrationGateRunner = async ({ branch }) => gateVerdict(branch);

  // The card-stamp callbacks are injected to mutate the IN-MEMORY card instead of `updateCardOnDisk`
  // (which resolves the LIVE repo via findRepoRoot). The train's GIT mechanics stay 100% real; only the
  // card sink is local — exactly the seam these journeys want (assert the train's effect on the card).
  const mq = makeMergeQueue({
    repoRoot: mainRepo,
    exec,
    store,
    staging: { enabled: true, branch: STAGE_BRANCH, codePrefixes: CODE_PREFIXES },
    integrationGate,
    gateEnabled: opts.gateEnabled ?? false,
    stampStaged: async (_b, _c) => {
      card.stagedAt = new Date().toISOString().slice(0, 10);
    },
    persistDiffSnapshot: async () => {},
    persistConflictedBranchFinding: async () => {},
    addGateBlocker: async () => {},
    addSecretScanBlocker: async () => {},
    clearRunBlockers: async () => {},
    isCardTerminal: async () => false,
  });
  mq.onMergeDone((ev) => {
    mergeDone.push(ev);
  });

  // --- the deterministic skill driver ---------------------------------------------------------------
  // A RUN applies the scripted effect for the column's trigger ON A FRESH RUN BRANCH, commits it, and
  // enqueues the branch on the REAL merge train (mirroring the engine's commit→detach→enqueue success
  // path). A board-data-only effect (a card .md edit) merges whole into main; a code effect (a file under
  // packages/**) is SPLIT (code→stage, data→main). The card status advances per the effect's return.
  let runSeq = 0;
  const effects = opts.effects ?? {};
  // Per-harness unique run-id prefix: the split/release write patch files into the SHARED runnerStateDir()
  // (split-test-<runId>.patch) of the LIVE repo, so two harness instances running in parallel must never
  // mint the same runId — a collision would let one overwrite the other's patch. The tmp dir's basename is
  // already unique (mkdtemp), so derive the prefix from it.
  const runPrefix = path.basename(tmpRoot).replace(/[^a-z0-9]/gi, "").slice(-12) || "h";

  const applyRun = async (trigger: TriggerId): Promise<{ to: string | null; enqueued: boolean }> => {
    const runId = `${runPrefix}-r${++runSeq}`;
    const branch = `run/${runId}`;
    // Branch from main HEAD, apply the scripted effect into the working tree, commit, return to main.
    await git(`checkout -q -b ${branch}`);
    const writeFile = async (rel: string, body: string) => {
      const abs = path.join(mainRepo, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, body);
    };
    const effect = effects[trigger];
    const advanceTo = effect ? await effect({ card, writeFile }) : null;
    if (advanceTo) card.status = advanceTo;
    // The card advance is BOARD DATA — write the (advanced) card .md so the run branch carries the
    // status move alongside any code the effect wrote (exactly as a real harness-* run does on its worktree).
    await writeCardMd(mainRepo, boardId, card);
    await git("add -A");
    const { code } = await git(`commit -q --no-verify -m "usm(${trigger}): ${boardId}/${card.id} [run ${runId}]"`);
    await git(`checkout -q ${baseBranch}`);
    if (code !== 0) {
      // empty diff → nothing to integrate (the effect changed nothing). Drop the branch.
      await git(`branch -D ${branch}`);
      return { to: advanceTo, enqueued: false };
    }
    await mq.enqueueMerge({ runId, board: boardId, cardId: card.id, branch, trigger });
    await mq.whenIdle();
    return { to: advanceTo, enqueued: true };
  };

  const step = async (): Promise<DriverEvent> => {
    const from = card.status ?? "<none>";
    const decision = decideCascade(card, config);
    if (decision.action === "run") {
      const { to, enqueued } = await applyRun(decision.trigger);
      return { kind: "run", trigger: decision.trigger, from, to, enqueued };
    }
    if (decision.action === "forward") {
      // entryEffect(config, toStatus, prevStatus): the effect of ENTERING decision.to FROM card.status.
      const fx = entryEffect(config, decision.to, card.status);
      card.status = decision.to;
      // Fire the REAL onEnter effect (e.g. promote-stage) against the temp repo — the SAME path the
      // autorun cascade's `forward` takes (autorun-eval.ts). promote-stage reads loadRunnerConfig().staging;
      // the harness drives it directly below so it is independent of the live settings.yaml.
      if (fx) await runHarnessEntryEffect(fx, mainRepo, exec, boardId, card);
      return { kind: "forward", from, to: decision.to, effect: fx };
    }
    return { kind: "stop", reason: decision.reason, at: card.status };
  };

  const drive = async (maxSteps = 40): Promise<DriverEvent[]> => {
    const trace: DriverEvent[] = [];
    for (let i = 0; i < maxSteps; i++) {
      const ev = await step();
      trace.push(ev);
      if (ev.kind === "stop") break;
    }
    return trace;
  };

  return {
    tmpRoot,
    mainRepo,
    baseBranch,
    exec,
    config,
    card,
    mq,
    store,
    mergeDone,
    git,
    show: async (ref, cwd = mainRepo) => (await git(`show ${ref}`, cwd)).stdout,
    branchExists: async (name) => (await git(`rev-parse --verify --quiet ${name}`)).code === 0,
    worktreeList: async () => {
      const { stdout } = await git("worktree list --porcelain");
      return stdout
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim());
    },
    fileAt: async (ref, file) => {
      const { stdout, code } = await git(`show ${ref}:${file}`);
      return code === 0 ? stdout : "";
    },
    step,
    drive,
    runSkill: async (trigger: TriggerId) => {
      const from = card.status ?? "<none>";
      const { to, enqueued } = await applyRun(trigger);
      return { kind: "run", trigger, from, to, enqueued };
    },
    setStatus: async (statusId: string) => {
      // moveCardAction fires the destination's onEnter effect on a REAL status change.
      const fx = entryEffect(config, statusId, card.status);
      card.status = statusId;
      if (fx) await runHarnessEntryEffect(fx, mainRepo, exec, boardId, card);
      return fx;
    },
    cleanup: async () => {
      // Remove the persistent stage worktree (a sibling of mainRepo) before nuking tmpRoot.
      await git(`worktree remove ${JSON.stringify(`${mainRepo}-${STAGE_BRANCH}`)} --force`).catch(() => {});
      // `force: true` NÃO cobre ENOTEMPTY no Linux — ele ignora ENOENT e mais nada. É ESTE retry que
      // fecha a falha observada no CI, e ele é provado: com um escritor TRANSITÓRIO na árvore (a forma
      // real — algo que escreve por um instante e sai), `rm` sem retry devolve ENOTEMPTY e `rm` com
      // `maxRetries:10` remove. Com escritor ETERNO nenhum dos dois sobrevive, e isso é correto: aí a
      // falha é um processo que ninguém esperou, e o conserto seria esperar por ele.
      // Teardown, nunca asserção.
      await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      // The split writes its per-run patch files into the SHARED (gitignored) runnerStateDir() — sweep
      // THIS harness's own (`split-<runPrefix>-*.patch`) so they don't accumulate on disk between runs.
      try {
        const dir = runnerStateDir();
        for (const f of await fsp.readdir(dir)) {
          if (f.startsWith(`split-${runPrefix}-`)) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
        }
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Write the card's .md (frontmatter + body) into the board's cards dir of `repo`. The status field is
 *  what the merge train's `data → main` lands on main, so the cascade reads the advance after merge-back. */
async function writeCardMd(repo: string, boardId: string, card: Card): Promise<void> {
  const file = path.join(repo, "storymap", "boards", boardId, "cards", `${card.id}.md`);
  // Only well-defined fields — js-yaml (gray-matter's dumper) throws on an `undefined` value.
  const front: Record<string, unknown> = {
    id: card.id,
    type: card.type,
    title: card.title,
    storyType: card.storyType,
    status: card.status,
    tasks: card.tasks,
  };
  if (card.qaPassed !== undefined) front.qaPassed = card.qaPassed;
  if (card.stagedAt !== undefined) front.stagedAt = card.stagedAt;
  if (card.releasedAt !== undefined) front.releasedAt = card.releasedAt;
  const body = matter.stringify("\n", front);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
}

/** The harness twin of runner/entry-effects.ts, but driven against the TEMP repo (not findRepoRoot) and
 *  with the staging config inlined — so promote-stage exercises the REAL promoteStageToMain over real git
 *  without depending on the live settings.yaml. Mirrors fireReleaseStaged's stamp-on-success. */
async function runHarnessEntryEffect(
  effect: EntryEffect,
  repo: string,
  exec: ExecFn,
  boardId: string,
  card: Card,
): Promise<void> {
  // ADR-059: `promote-and-deploy` is the Deploy chain — the PROMOTE part is the only piece the harness
  // exercises (the deploy-board half shells out to systemd/just, out of scope), so it runs the SAME real
  // promoteStageToMain + stamp as `promote-stage`. The legacy `promote-stage` id stays for entry-effect
  // back-compat (it survives in the enum + ENTRY_EFFECTS, just no longer wired on a board step).
  if (effect === "promote-stage" || effect === "promote-and-deploy") {
    const result = await promoteStageToMain({
      exec,
      repoRoot: repo,
      stageBranch: STAGE_BRANCH,
      codePrefixes: CODE_PREFIXES,
    });
    if (!result.blocked && card.stagedAt && !card.releasedAt) {
      card.releasedAt = new Date().toISOString().slice(0, 10);
    }
  }
  // deploy-board (and the deploy half of promote-and-deploy) is a board publish (rebuild+restart /
  // orch-deploy) — out of scope for the harness (it shells out to systemd/just). The journeys assert the
  // promote + the auto-advance to concluida, not the real restart.
}
