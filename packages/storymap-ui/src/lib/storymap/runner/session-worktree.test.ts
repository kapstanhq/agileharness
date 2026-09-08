// WS-1 (storymap-parallel-work) — agent-session worktrees, driven over REAL git in a throwaway repo.
//
// The mocked unit tests in merge-queue.test.ts prove the queue's LOGIC; this suite proves the MECHANIC that
// the whole workstream rests on — two agents really do get two trees, a pinned submit really does integrate
// the pinned sha, a conflict really does come back to the session, and the fail-closed teardown/GC really do
// keep un-integrated code. Each `it` below is either an acceptance criterion of 01-ws1 or one of the holes
// the plan's own grill found (G2/G4/G5/G6/G7), which are exactly the things a future "simplification" would
// quietly re-open.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";
import { classifyBranch } from "./branch-gc";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import { makeMergeQueue, type MergeQueueStore } from "./merge-queue";
import { listPreservedRunBranches } from "./preserved-branches";
import { makeReconcileWorktrees, parseRunWorktrees } from "./recovery";
import { agentBaseRef, agentSessionIdFromBranch, resolveRunBase, runOwnWork, sessionIdFromBranch } from "./run-base";
import { sessionClaimActor } from "./claims";
import { sessionsFilePath } from "./session-liveness";
import {
  partitionByTreePresence,
  admissionVerdict,
  adoptSession,
  discardSessionWorktree,
  isSessionAlive,
  liveSessionIds,
  makeSessionStore,
  openSessionWorktree,
  reconcileFleet,
  refreshSessionWorktree,
  submitSessionWork,
  type AgentSession,
  type LiveSessionIdsResult,
  type SessionStore,
  type SessionWorktreeDeps,
} from "./session-worktree";
import { describePosix } from "./test-platform";
import { defaultWorktreeFs, defaultWorktreeOps, makeWorktreeOps, type ExecFn } from "./worktree";
import type { MergeQueueEntry } from "./types";

let exec = promisify(nodeExec) as unknown as ExecFn;

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

function memSessionStore(): SessionStore & { read: () => AgentSession[] } {
  let saved: AgentSession[] = [];
  return {
    load: async () => saved.map((s) => ({ ...s })),
    persist: async (sessions) => {
      saved = sessions.map((s) => ({ ...s }));
    },
    read: () => saved,
  };
}

// --- G2: o chokepoint de deleção, provado sobre a FONTE ------------------------------------------

describe("G2 — toda deleção de branch do train passa pelo guard", () => {
  it("não existe um 11º `git branch -D` solto em merge-queue.ts", async () => {
    // Um teste sobre o TEXTO do arquivo porque a propriedade É textual: o furo G2 não era um bug de
    // lógica, era a EXISTÊNCIA de 10 chamadas independentes. Cobrir cada uma por comportamento não
    // impediria a 11ª de nascer amanhã — e a 11ª é exatamente como um branch de sessão viva volta a ser
    // deletado. Aqui a régua é: só DUAS linhas executáveis podem conter `git branch -D` — o corpo do
    // guard, e o teardown do worktree de gate (que só nomeia o `gate/<id>` que ele mesmo criou).
    const src = await fsp.readFile(path.join(import.meta.dirname, "merge-queue.ts"), "utf8");
    const lines = src.split("\n").filter((l) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false; // comentários citam o comando
      return /`git branch -D|`branch -D/.test(l);
    });
    expect(lines.map((l) => l.trim())).toEqual([
      "await exec(`git branch -D ${quote(branch)}`, { cwd: repoRoot, timeout: GATE_GIT_TIMEOUT_MS });", // gate/<runId>
      "return (await git(`branch -D ${quote(branch)}`)).ok;", // o corpo do deleteBranchAfterIntegration
    ]);
  });
});

// --- PURE admission (no repo needed) ------------------------------------------------------------

describe("WS-1.5 — admissão de sessão (pura)", () => {
  const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    sessionId: "s1",
    agentId: "s1",
    role: "implement",
    branch: "agent/s1",
    worktreePath: "/w/agent-s1",
    baseCommit: "abc",
    task: "t",
    openedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    ...over,
  });

  it("recusa quando o cap de worktrees vivos é atingido, dizendo QUEM está segurando", () => {
    const live = [session({ sessionId: "a", task: "refatorar o engine" }), session({ sessionId: "b" })];
    const v = admissionVerdict(live, 0, { maxWorktrees: 2 });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("2/2");
      expect(v.reason).toContain("refatorar o engine"); // acionável: sei de quem cobrar a vaga
    }
  });

  it("uma sessão MORTA não consome vaga do cap (senão um crash custaria capacidade para sempre)", () => {
    const dead = session({ heartbeatAt: new Date(0).toISOString() });
    const now = 10 * 60 * 60 * 1000; // 10h depois → muito além do TTL
    expect(admissionVerdict([dead], now, { maxWorktrees: 1 }).ok).toBe(true);
  });

  it("recusa quando a VPS está saturada (mesmos thresholds da lane heavy)", () => {
    const v = admissionVerdict([], 0, {
      maxWorktrees: 4,
      resources: { freeRamMb: 100, loadAvg1: 0.5 },
      thresholds: { ramFreeMb: 1500, loadAvg1: 3.5 },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("VPS saturada");
  });

  it("G7 — heartbeat ilegível lê como VIVO (nunca deixa um parse ruim autorizar um reap)", () => {
    expect(isSessionAlive(session({ heartbeatAt: "lixo" }), Date.now())).toBe(true);
  });
});

// --- WS-6.1/6.3: frota (registro único, adoção, ciclo de vida) -----------------------------------

describe("WS-6 — frota sobre o MESMO registro durável (não um 2º store)", () => {
  const deps = (store: ReturnType<typeof memSessionStore>, over: Partial<SessionWorktreeDeps> = {}): SessionWorktreeDeps => ({
    exec: (async () => ({ stdout: "", stderr: "" })) as unknown as ExecFn,
    fs: defaultWorktreeFs,
    repoRoot: "/repo",
    store,
    ensureRunBase: async () => "base",
    enqueueMerge: async () => {},
    liveRunIds: async () => [],
    now: () => 1_000,
    ...over,
  });

  it("6.2 — adoção registra identidade SEM worktree e marca a dívida (adopted)", async () => {
    const store = memSessionStore();
    const res = await adoptSession(deps(store), { tmuxSession: "legado-1", role: "free", board: "acme" });
    expect(res.ok).toBe(true);
    const s = store.read()[0];
    expect(s).toMatchObject({ tmuxSession: "legado-1", role: "free", adopted: true, spawnedBy: "human" });
    // A adoção NÃO inventa isolamento: sem worktree, sem branch. Fingir o contrário seria a mentira perigosa.
    expect(s.worktreePath).toBeUndefined();
    expect(s.branch).toBeUndefined();
    expect(s.agentId).toBe(s.sessionId);
  });

  it("6.2 — re-adotar o MESMO tmux atualiza a linha (não forka uma 2ª identidade p/ um processo)", async () => {
    const store = memSessionStore();
    await adoptSession(deps(store), { tmuxSession: "legado-1", role: "free" });
    await adoptSession(deps(store), { tmuxSession: "legado-1", role: "review", cardId: "story-x" });
    expect(store.read()).toHaveLength(1);
    expect(store.read()[0]).toMatchObject({ role: "review", cardId: "story-x" });
  });

  it("uma sessão adotada RECUSA submit/refresh com motivo prescritivo (não crasha lendo undefined)", async () => {
    const store = memSessionStore();
    const { session } = (await adoptSession(deps(store), { tmuxSession: "legado-1", role: "free" })) as { session: AgentSession };
    const sub = await submitSessionWork(deps(store), { sessionId: session.sessionId });
    expect(sub.ok).toBe(false);
    if (!sub.ok) {
      expect(sub.reason).toContain("não tem worktree isolado");
      expect(sub.reason).toContain("ADOTADA");
      expect(sub.reason).toContain("worktree_open"); // diz o que FAZER
    }
    const ref = await refreshSessionWorktree(deps(store), { sessionId: session.sessionId });
    expect(ref.ok).toBe(false);
  });

  it("discard de sessão adotada apenas DESREGISTRA (não é erro — não há árvore p/ derrubar)", async () => {
    const store = memSessionStore();
    const { session } = (await adoptSession(deps(store), { tmuxSession: "legado-1", role: "free" })) as { session: AgentSession };
    const res = await discardSessionWorktree(deps(store), { sessionId: session.sessionId });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.detail).toContain("apenas desregistrada");
    expect(store.read()).toEqual([]); // saiu da frota — não fica linha morta segurando vaga
  });

  it("6.3 — tmux VIVO renova o heartbeat (é isso que impede o reaper de ceifar quem está trabalhando)", async () => {
    const store = memSessionStore();
    await adoptSession(deps(store), { tmuxSession: "viva", role: "free" });
    const later = deps(store, { now: () => 9_000_000 });
    const res = await reconcileFleet(later, ["viva"]);
    expect(res.alive).toHaveLength(1);
    expect(res.died).toEqual([]);
    expect(store.read()[0].heartbeatAt).toBe(new Date(9_000_000).toISOString());
  });

  it("6.3/AC3 — tmux MORTO libera os claims do agente com motivo, em UMA varredura", async () => {
    const store = memSessionStore();
    const { session } = (await adoptSession(deps(store), { tmuxSession: "morta", role: "implement", cardId: "story-1" })) as {
      session: AgentSession;
    };
    const swept: Array<Set<string>> = [];
    const res = await reconcileFleet(
      {
        ...deps(store),
        sweepDeadActors: async (dead) => {
          swept.push(dead);
          return [{ board: "acme", cardId: "story-1", actor: sessionClaimActor(session.agentId) }];
        },
      },
      [], // nenhum tmux vivo
    );
    expect(res.died).toHaveLength(1);
    expect(res.died[0]).toMatchObject({ agentId: session.agentId, tmuxSession: "morta", claimsReleased: 1 });
    // UMA chamada com o conjunto dos mortos — não N releases correndo entre si.
    expect(swept).toHaveLength(1);
    // …e o conjunto é o ATOR DO CLAIM (`session:<agentId>`), não o agentId cru: é assim que claims.ts
    // guarda a reserva, e um id cru aqui não casaria com claim nenhum (varredura muda).
    expect([...swept[0]]).toEqual([sessionClaimActor(session.agentId)]);
  });

  it("F2 — sonda que NÃO respondeu (null) não julga ninguém: nem vida, nem óbito", async () => {
    const store = memSessionStore();
    const { session } = (await adoptSession(deps(store), { tmuxSession: "viva", role: "implement", cardId: "story-1" })) as {
      session: AgentSession;
    };
    const heartbeatAntes = store.read()[0].heartbeatAt;
    let sweeps = 0;
    const res = await reconcileFleet(
      {
        ...deps(store, { now: () => 9_000_000 }),
        sweepDeadActors: async () => {
          sweeps += 1;
          return [];
        },
      },
      // `null` = o `tmux list-sessions` não respondeu (timeout sob carga, fork que falhou). Uma lista
      // VAZIA aqui significaria "todos morreram" e entregaria o card de quem está trabalhando agora.
      null,
    );
    expect(res).toEqual({ died: [], alive: [] });
    expect(sweeps).toBe(0); // nenhum claim varrido
    expect(store.read()[0].heartbeatAt).toBe(heartbeatAntes); // nem renovado por engano
    expect(session.agentId).toBeTruthy();
  });

  it("6.3 — sessão SEM tmux (aberta por worktree_open fora do tmux) nunca é dada como morta", async () => {
    const store = memSessionStore();
    store.persist([
      {
        sessionId: "s1",
        agentId: "s1",
        role: "implement",
        task: "t",
        openedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      },
    ]);
    const res = await reconcileFleet(deps(store), []);
    // Ausência de um handle de processo NÃO é evidência de morte — chutar aqui ceifaria trabalho vivo.
    expect(res.died).toEqual([]);
    expect(res.alive).toEqual([]);
  });
});

// --- nomes de branch ----------------------------------------------------------------------------

describe("WS-1.1 — parsing de branch de sessão", () => {
  const id = "11111111-2222-3333-4444-555555555555";

  it("sessionIdFromBranch enxerga run/ E agent/, com os renames de preservação", () => {
    expect(sessionIdFromBranch(`agent/${id}`)).toBe(id);
    expect(sessionIdFromBranch(`failed/agent/${id}`)).toBe(id);
    expect(sessionIdFromBranch(`conflicted/agent/${id}`)).toBe(id);
    expect(sessionIdFromBranch(`run/${id}`)).toBe(id);
  });

  it("agentSessionIdFromBranch separa sessão de run (e ignora nome livre — o id é sempre um uuid)", () => {
    expect(agentSessionIdFromBranch(`agent/${id}`)).toBe(id);
    expect(agentSessionIdFromBranch(`failed/agent/${id}`)).toBe(id);
    expect(agentSessionIdFromBranch(`run/${id}`)).toBeNull();
    expect(agentSessionIdFromBranch("agent/minha-branch")).toBeNull(); // D12: agente não inventa branch
  });
});

// --- REAL git -----------------------------------------------------------------------------------

describePosix("WS-1 — worktree de sessão (git real)", () => {
  let tmpRoot: string;
  let repo: string;
  let sessionStore: ReturnType<typeof memSessionStore>;
  let queueStore: ReturnType<typeof memStore>;
  let deps: SessionWorktreeDeps;
  let mq: ReturnType<typeof makeMergeQueue>;

  /** The integration base the runs/sessions are cut from — `stage`, as in production. */
  const stageSha = async (): Promise<string> => (await exec(`git rev-parse stage`, { cwd: repo })).stdout.trim();

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-session-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "b", "cards"), { recursive: true });
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    // The REAL secret scanner — commitAllPending runs it fail-closed on every session commit.
    await fsp.copyFile(
      path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"),
      path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"),
    );
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "x.ts"), "export const x = 1;\n");
    await fsp.writeFile(path.join(repo, "storymap", "boards", "b", "cards", "c.md"), "# card\nstatus: a\n");
    await exec(`git init -q -b main`, { cwd: repo });
    await exec(`git config user.email t@t.dev`, { cwd: repo });
    await exec(`git config user.name tester`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q --no-verify -m base`, { cwd: repo });
    await exec(`git branch stage`, { cwd: repo }); // staging on: sessions are cut from `stage`
  });

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    sessionStore = memSessionStore();
    queueStore = memStore();
    mq = makeMergeQueue({
      repoRoot: repo,
      exec,
      store: queueStore,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      // Card effects are stubbed to RECORD: a card-less entry must never reach any of them.
      persistDiffSnapshot: async () => {
        cardEffects.push("diffSnapshot");
      },
      stampStaged: async () => {
        cardEffects.push("stampStaged");
      },
      addSecretScanBlocker: async () => {
        cardEffects.push("secretScanBlocker");
      },
      addGateBlocker: async () => {
        cardEffects.push("gateBlocker");
      },
      clearRunBlockers: async () => {
        cardEffects.push("clearRunBlockers");
      },
      addCodeNotLandedBlocker: async () => {
        cardEffects.push("codeNotLanded");
      },
    });
    cardEffects = [];
    deps = {
      exec,
      fs: defaultWorktreeFs,
      repoRoot: repo,
      store: sessionStore,
      ensureRunBase: stageSha,
      enqueueMerge: (e) => mq.enqueueMerge(e),
      liveRunIds: () => mq.liveRunIds(),
      now: () => Date.now(),
      maxWorktrees: 4,
    };
  });

  let cardEffects: string[] = [];

  // `worktree_open` ALWAYS provisions a tree, so its result is an isolated session by construction. The
  // narrowing lives here (once) rather than at every `s.branch!` below: `branch`/`worktreePath` are optional
  // on AgentSession only because an ADOPTED session (WS-6.2) has none — never for one this helper returns.
  const open = async (
    task = "trabalho",
    over: { board?: string; cardId?: string } = {},
  ): Promise<AgentSession & { branch: string; worktreePath: string; baseCommit: string }> => {
    const res = await openSessionWorktree(deps, { task, ...over });
    if (!res.ok) throw new Error(`open falhou: ${res.reason}`);
    const s = res.session;
    if (!s.branch || !s.worktreePath || !s.baseCommit) throw new Error("worktree_open devolveu sessão sem árvore");
    return s as AgentSession & { branch: string; worktreePath: string; baseCommit: string };
  };

  const writeIn = (wt: string, rel: string, body: string) => fsp.writeFile(path.join(wt, rel), body);

  it("AC1 — duas sessões simultâneas ganham árvores e branches DISTINTOS, da MESMA base fresca", async () => {
    const base = await stageSha();
    const [a, b] = await Promise.all([open("sessão A"), open("sessão B")]);

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.branch).not.toBe(b.branch);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.baseCommit).toBe(base);
    expect(b.baseCommit).toBe(base);
    // As duas árvores existem DE VERDADE e cada uma tem o seu branch checked-out.
    for (const s of [a, b]) {
      expect((await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: s.worktreePath })).stdout.trim()).toBe(s.branch);
    }
    // Nenhum passo exigiu coordenação manual entre elas — é o ponto do WS.
    await discardSessionWorktree(deps, { sessionId: a.sessionId });
    await discardSessionWorktree(deps, { sessionId: b.sessionId });
  });

  // CENÁRIO 5 do contrato de aceitação do plano (09-verificacao-e-adr.md), o ÚNICO que o inventário honesto
  // marcava "❌ NÃO COBERTO (composto)": 3 sessões + 2 runs de autorun ⇒ 5 branches vivos ao mesmo tempo, no
  // MESMO train. As PARTES já eram provadas isoladas (FIFO com 2 branches; 2 sessões simultâneas; claims
  // disjuntos) — o que ninguém exercia era a COMPOSIÇÃO, que é exatamente onde as 7 colisões de 2026-07-16
  // aconteceram: várias sessões Claude em paralelo na VPS. Um invariante que só vale isolado não é invariante.
  it("cenário 5 — 3 sessões + 2 runs = 5 branches: o train integra TODOS, um a um, sem cruzar trabalho", async () => {
    // As 3 sessões (worktree_open), cada uma no seu arquivo — nenhuma coordenação manual entre elas.
    const sessions = await Promise.all([open("sessão 1"), open("sessão 2"), open("sessão 3")]);
    await Promise.all(
      sessions.map((s, i) => writeIn(s.worktreePath, `packages/app/s${i + 1}.ts`, `export const s${i + 1} = ${i + 1};\n`)),
    );

    // Os 2 runs de autorun: mesma base canônica, branch `run/<id>` — a outra metade da frota.
    const ops = makeWorktreeOps(exec, defaultWorktreeFs);
    const runs = await Promise.all(
      ["run-a", "run-b"].map(async (runId, i) => {
        const base = await stageSha();
        const wt = await ops.create(repo, runId, base);
        await fsp.writeFile(path.join(wt.worktreePath, "packages", "app", `r${i + 1}.ts`), `export const r${i + 1} = ${i + 1};\n`);
        await exec(`git add -A`, { cwd: wt.worktreePath });
        await exec(`git commit -q --no-verify -m "run ${runId}"`, { cwd: wt.worktreePath });
        await ops.detach(wt.worktreePath); // o run assenta e entrega o branch ao train, como no engine
        return { runId, branch: wt.branch, base };
      }),
    );

    // Os 5 entram no train. As sessões pelo submit; os runs pelo enqueue do engine.
    const subs = await Promise.all(sessions.map((s) => submitSessionWork(deps, { sessionId: s.sessionId })));
    expect(subs.map((r) => (r.ok ? "ok" : `FALHOU: ${r.reason}`))).toEqual(["ok", "ok", "ok"]);
    await Promise.all(
      runs.map((r) => mq.enqueueMerge({ runId: r.runId, board: "b", cardId: undefined, branch: r.branch, baseCommit: r.base, kind: "run" })),
    );
    await mq.whenIdle();

    // (1) Os 5 branches existiram e os 5 integraram — ninguém ficou para trás nem parqueou para o operador.
    const entries = queueStore.read();
    expect(entries).toHaveLength(5);
    expect(entries.every((e) => e.status === "done")).toBe(true);
    expect(entries.some((e) => e.status === "conflict" || e.status === "gate-failed")).toBe(false);

    // (2) O train é SERIAL: nenhum par de merges se sobrepõe no tempo (é o que protege a árvore de main).
    const windows = entries
      .map((e) => ({ start: e.mergeStartedAt ?? 0, end: e.mergeEndedAt ?? 0 }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].start).toBeGreaterThanOrEqual(windows[i - 1].end);
    }

    // (3) NADA se cruzou: o trabalho dos 5 está em stage, cada um com o SEU conteúdo. É este o aceite —
    // 5 escritores concorrentes, zero perda, zero mistura.
    for (let i = 1; i <= 3; i++) {
      expect((await exec(`git show stage:packages/app/s${i}.ts`, { cwd: repo })).stdout).toContain(`export const s${i} = ${i}`);
    }
    for (let i = 1; i <= 2; i++) {
      expect((await exec(`git show stage:packages/app/r${i}.ts`, { cwd: repo })).stdout).toContain(`export const r${i} = ${i}`);
    }
    // ...e nada de código vazou para main (a regra dura sobrevive à concorrência, não só ao caso feliz).
    for (const f of ["s1", "s2", "s3", "r1", "r2"]) {
      expect(await exec(`git show main:packages/app/${f}.ts`, { cwd: repo }).then(() => true).catch(() => false)).toBe(false);
    }

    await Promise.all(sessions.map((s) => discardSessionWorktree(deps, { sessionId: s.sessionId })));
  });

  it("G4 — worktree_open grava refs/agent-base/<id> e a régua de own-work o usa (proveniência base-ref)", async () => {
    const s = await open();
    const ref = (await exec(`git rev-parse ${agentBaseRef(s.sessionId)}`, { cwd: repo })).stdout.trim();
    expect(ref).toBe(s.baseCommit);

    const resolved = await resolveRunBase(exec, repo, s.branch, { stageBranch: "stage" });
    expect(resolved).toEqual({ base: s.baseCommit, provenance: "base-ref" });
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("AC2 — submit limpo integra pelo train com split code→stage / data→main; SEM card, zero efeito de card", async () => {
    const s = await open("self-dev sem card"); // card-less: D2
    await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 42; // sessão\n");
    await writeIn(s.worktreePath, "storymap/boards/b/cards/c.md", "# card\nstatus: z\n");

    const sub = await submitSessionWork(deps, { sessionId: s.sessionId });
    expect(sub.ok).toBe(true);
    await mq.whenIdle();

    const entry = queueStore.read()[0];
    expect(entry.status).toBe("done");
    expect(entry.kind).toBe("session");
    expect(entry.cardId).toBeUndefined();
    expect(entry.split).toEqual({ dataLanded: true, codeStaged: true });

    // O split fez o seu trabalho normal: código em stage, board-data em main.
    expect((await exec(`git show stage:packages/app/x.ts`, { cwd: repo })).stdout).toContain("42");
    expect((await exec(`git show main:storymap/boards/b/cards/c.md`, { cwd: repo })).stdout).toContain("status: z");
    // ...e o código NÃO vazou para main (a regra dura: nada chega em main sem passar por stage).
    expect((await exec(`git show main:packages/app/x.ts`, { cwd: repo })).stdout).not.toContain("42");

    // D2/D13: sem card ⇒ nenhum efeito de card, e NENHUM card criado automaticamente.
    expect(cardEffects).toEqual([]);
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("G2 — o train NUNCA deleta o branch de uma sessão viva (nem no sucesso)", async () => {
    const s = await open();
    await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 7;\n");
    await submitSessionWork(deps, { sessionId: s.sessionId });
    await mq.whenIdle();

    expect(queueStore.read()[0].status).toBe("done");
    // O branch sobreviveu à integração: a sessão ainda o usa (e vai refresh+continuar nele).
    const alive = await exec(`git rev-parse --verify ${s.branch}`, { cwd: repo }).then(() => true).catch(() => false);
    expect(alive).toBe(true);
    // E a árvore continua de pé, com o branch ainda checked-out (era o cenário que mataria o processor).
    expect((await exec(`git rev-parse --abbrev-ref HEAD`, { cwd: s.worktreePath })).stdout.trim()).toBe(s.branch);
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("G5 — o train integra o sha PINADO; o que a sessão commitar depois do submit NÃO entra", async () => {
    const s = await open();
    await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 1; // submetido\n");
    const sub = await submitSessionWork(deps, { sessionId: s.sessionId });
    expect(sub.ok).toBe(true);
    const pinned = sub.ok ? sub.pinnedSha : "";

    // A sessão SEGUE trabalhando (é viva) e commita algo novo ANTES do train processar.
    await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 2; // DEPOIS do submit\n");
    await exec(`git add -A`, { cwd: s.worktreePath });
    await exec(`git commit -q --no-verify -m "trabalho pós-submit"`, { cwd: s.worktreePath });
    const tip = (await exec(`git rev-parse ${s.branch}`, { cwd: repo })).stdout.trim();
    expect(tip).not.toBe(pinned); // o branch andou — o pin é o que separa as duas coisas

    await mq.whenIdle();
    expect(queueStore.read()[0].status).toBe("done");
    expect(queueStore.read()[0].pinnedSha).toBe(pinned);

    // stage recebeu o SUBMETIDO, não o commit posterior (que nenhum gate validou).
    const staged = (await exec(`git show stage:packages/app/x.ts`, { cwd: repo })).stdout;
    expect(staged).toContain("submetido");
    expect(staged).not.toContain("DEPOIS do submit");
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("AC3/G6 — submit conflitante volta à sessão (TERMINAL, nada parqueia); refresh + re-submit integram", async () => {
    // AS DUAS sessões são cortadas da MESMA base — o cenário real de concorrência. (Abrir a segunda DEPOIS
    // da primeira integrar a cortaria da base nova e não haveria conflito nenhum para testar.)
    const other = await open("sessão que chega antes");
    const s = await open("sessão que conflita");

    // A outra chega primeiro e coloca a sua versão da MESMA linha em stage.
    await writeIn(other.worktreePath, "packages/app/x.ts", "export const x = 100; // do outro\n");
    await submitSessionWork(deps, { sessionId: other.sessionId });
    await mq.whenIdle();
    expect(queueStore.read().find((e) => e.runId === other.sessionId)!.status).toBe("done");

    // A nossa mexe na MESMA linha a partir da base velha → conflita no apply sobre stage.
    await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 999; // do nosso\n");
    await submitSessionWork(deps, { sessionId: s.sessionId });
    await mq.whenIdle();

    const mine = queueStore.read().find((e) => e.runId === s.sessionId)!;
    expect(mine.status).toBe("returned-to-session");
    // G6: NADA parqueou para o operador — nenhum conflict/gate-failed em lugar nenhum da fila.
    expect(queueStore.read().some((e) => e.status === "conflict" || e.status === "gate-failed")).toBe(false);
    // O branch da sessão ficou intacto, esperando ela resolver.
    expect(await exec(`git rev-parse --verify ${s.branch}`, { cwd: repo }).then(() => true).catch(() => false)).toBe(true);

    // A sessão se atualiza: rebase sobre a base nova, resolvendo o conflito no SEU worktree.
    const refreshed = await refreshSessionWorktree(deps, { sessionId: s.sessionId });
    if (!refreshed.ok) {
      // O rebase conflitou (esperado quando as duas mexem na mesma linha): a sessão resolve NA SUA árvore.
      expect(refreshed.conflict).toBe(true);
      await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 999; // resolvido pela sessão\n");
      await exec(`git add -A`, { cwd: s.worktreePath });
      await exec(`git -c core.editor=true rebase --continue`, { cwd: s.worktreePath });
      const again = await refreshSessionWorktree(deps, { sessionId: s.sessionId });
      expect(again.ok).toBe(true);
    }

    // Re-submit = entry NOVA (o runId é o mesmo; a entrada terminal anterior é substituída).
    const resub = await submitSessionWork(deps, { sessionId: s.sessionId });
    expect(resub.ok).toBe(true);
    await mq.whenIdle();
    const after = queueStore.read().find((e) => e.runId === s.sessionId)!;
    expect(after.status).toBe("done");
    expect((await exec(`git show stage:packages/app/x.ts`, { cwd: repo })).stdout).toContain("999");

    await discardSessionWorktree(deps, { sessionId: s.sessionId });
    await discardSessionWorktree(deps, { sessionId: other.sessionId });
  });

  it("G4 — depois do refresh, a régua NÃO reabsorve os commits do stage como trabalho da sessão", async () => {
    // A nossa sessão nasce ANTES do stage andar — é o que torna o rebase (e o furo G4) possíveis.
    const s = await open();
    const other = await open("avança o stage");

    // stage avança por conta da outra sessão…
    await writeIn(other.worktreePath, "packages/app/other.ts", "export const o = 1;\n");
    await submitSessionWork(deps, { sessionId: other.sessionId });
    await mq.whenIdle();
    await discardSessionWorktree(deps, { sessionId: other.sessionId });

    // …e a nossa faz UM commit próprio e rebasa por cima.
    await writeIn(s.worktreePath, "packages/app/mine.ts", "export const m = 1;\n");
    await exec(`git add -A`, { cwd: s.worktreePath });
    await exec(`git commit -q --no-verify -m "meu único commit"`, { cwd: s.worktreePath });

    const refreshed = await refreshSessionWorktree(deps, { sessionId: s.sessionId });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.rebased).toBe(true);

    // A base-ref andou junto com o rebase — e é ELA que a régua usa.
    const { base, provenance } = await resolveRunBase(exec, repo, s.branch, { stageBranch: "stage" });
    expect(provenance).toBe("base-ref");
    const work = await runOwnWork(exec, repo, s.branch, base);
    // 1 commit — o nosso. Sem o base-ref, o reflog ainda apontaria o corte ORIGINAL e o commit do `other`
    // (agora ancestral do branch, via rebase) contaria como trabalho DESTA sessão.
    expect(work?.commits).toBe(1);
    expect(work?.files).toEqual(["packages/app/mine.ts"]);

    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("AC4 — o teardown PRESERVA agent/* com código não integrado, e some com o vazio", async () => {
    // (a) sessão com trabalho NÃO integrado → branch preservado como failed/agent/<id>
    const withWork = await open();
    await writeIn(withWork.worktreePath, "packages/app/precioso.ts", "export const p = 1;\n");
    await exec(`git add -A`, { cwd: withWork.worktreePath });
    await exec(`git commit -q --no-verify -m "trabalho que não pode sumir"`, { cwd: withWork.worktreePath });

    const discarded = await discardSessionWorktree(deps, { sessionId: withWork.sessionId });
    expect(discarded.ok).toBe(true);
    if (discarded.ok) expect(discarded.branchPreserved).toBe(true);
    const preserved = (await exec(`git rev-parse --verify failed/agent/${withWork.sessionId}`, { cwd: repo }))
      .stdout.trim();
    expect(preserved).toBeTruthy();
    // O código continua lá, recuperável.
    expect((await exec(`git show failed/agent/${withWork.sessionId}:packages/app/precioso.ts`, { cwd: repo })).stdout)
      .toContain("export const p = 1");

    // (b) sessão que não commitou nada → nada a preservar → branch deletado (não vira lixo imortal)
    const empty = await open();
    const res = await discardSessionWorktree(deps, { sessionId: empty.sessionId });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.branchPreserved).toBe(false);
    expect(await exec(`git rev-parse --verify agent/${empty.sessionId}`, { cwd: repo }).then(() => true).catch(() => false))
      .toBe(false);
    // e a base-ref foi junto (não fica ref órfã para sempre)
    expect(await exec(`git rev-parse ${agentBaseRef(empty.sessionId)}`, { cwd: repo }).then(() => true).catch(() => false))
      .toBe(false);
  });

  // ADR-065 — o FALSO "failed". O train integra RE-APLICANDO o trabalho como patch em stage/main: shas NOVOS,
  // e o branch da sessão intocado. Toda a régua do teardown, porém, contava SHAS (`--is-ancestor` anda no DAG;
  // `hasOwnCommits` conta `base..branch`) — nenhuma delas pode DECREMENTAR com uma integração por patch. Logo
  // toda sessão que commitou alguma coisa virava `failed/agent/<id>`, por mais completamente que tivesse
  // aterrissado; e o falso "failed" era imortal, porque o escape por conteúdo do branch-gc também excluía
  // sessões. Este teste é o cenário REAL (cherry-pick para stage), que nenhum teste anterior exercia.
  // Re-aplica `sha` em `stage` como o split faz: um commit NOVO (sha diferente) com o mesmo conteúdo. Roda num
  // worktree descartável porque `stage` está checked-out no worktree INTERNO do train (`<repo>-stage`), então
  // o `repo` não pode dar checkout nele — `-f` é o que permite a segunda árvore sobre o mesmo branch.
  const landOnStage = async (sha: string, tag: string) => {
    const wt = path.join(tmpRoot, `pick-${tag}`);
    await exec(`git worktree add -f ${wt} stage`, { cwd: repo });
    // `stage` ANDA antes de integrar — outro par aterrissou primeiro. Sem isto o cherry-pick teria o MESMO
    // pai e a mesma árvore, e o git (que endereça commits por conteúdo) devolveria o sha IDÊNTICO: um
    // fixture que não reproduz o bug nenhum. É a divergência que força o sha novo — como na produção.
    await fsp.writeFile(path.join(wt, "packages", "app", `outro-${tag}.ts`), `export const o = "${tag}";\n`);
    await exec(`git add -A`, { cwd: wt });
    await exec(`git commit -q --no-verify -m "trabalho de outro par"`, { cwd: wt });
    await exec(`git cherry-pick ${sha}`, { cwd: wt });
    await exec(`git worktree remove --force ${wt}`, { cwd: repo });
  };

  it("AC4/ADR-065 — trabalho INTEGRADO POR PATCH (sha novo) é deletado, não rotulado failed/*", async () => {
    const s = await open();
    await writeIn(s.worktreePath, "packages/app/integrado.ts", "export const i = 1;\n");
    await exec(`git add -A`, { cwd: s.worktreePath });
    await exec(`git commit -q --no-verify -m "trabalho da sessão"`, { cwd: s.worktreePath });
    const ownSha = (await exec(`git rev-parse ${s.branch}`, { cwd: s.worktreePath })).stdout.trim();

    // O train integra por PATCH: o commit em stage tem sha DIFERENTE e o branch da sessão fica intocado.
    // É exatamente o que o split faz — e o que a régua por sha não tinha como enxergar.
    await landOnStage(ownSha, "integrado");
    const stageSha2 = (await exec(`git rev-parse stage`, { cwd: repo })).stdout.trim();
    expect(stageSha2).not.toBe(ownSha); // o sha MUDOU — é essa a premissa do bug

    const discarded = await discardSessionWorktree(deps, { sessionId: s.sessionId });
    expect(discarded.ok).toBe(true);
    // O trabalho ESTÁ em stage (provado por conteúdo) ⇒ nada a preservar.
    if (discarded.ok) expect(discarded.branchPreserved).toBe(false);
    expect(await exec(`git rev-parse --verify failed/agent/${s.sessionId}`, { cwd: repo }).then(() => true).catch(() => false))
      .toBe(false);
    expect(await exec(`git rev-parse --verify agent/${s.sessionId}`, { cwd: repo }).then(() => true).catch(() => false))
      .toBe(false);
  });

  it("AC4/ADR-065 — trabalho PARCIALMENTE aterrissado continua PRESERVADO (só prova positiva deleta)", async () => {
    const s = await open();
    await writeIn(s.worktreePath, "packages/app/um.ts", "export const a = 1;\n");
    await exec(`git add -A`, { cwd: s.worktreePath });
    await exec(`git commit -q --no-verify -m "commit 1"`, { cwd: s.worktreePath });
    const firstSha = (await exec(`git rev-parse ${s.branch}`, { cwd: s.worktreePath })).stdout.trim();
    // Um SEGUNDO commit que NUNCA foi integrado — o trabalho que não pode sumir.
    await writeIn(s.worktreePath, "packages/app/dois.ts", "export const b = 2;\n");
    await exec(`git add -A`, { cwd: s.worktreePath });
    await exec(`git commit -q --no-verify -m "commit 2 (não integrado)"`, { cwd: s.worktreePath });

    // Só o PRIMEIRO aterrissa em stage. `partial` não é prova de nada ⇒ fail-closed.
    await landOnStage(firstSha, "parcial");

    const discarded = await discardSessionWorktree(deps, { sessionId: s.sessionId });
    expect(discarded.ok).toBe(true);
    if (discarded.ok) expect(discarded.branchPreserved).toBe(true);
    expect((await exec(`git show failed/agent/${s.sessionId}:packages/app/dois.ts`, { cwd: repo })).stdout)
      .toContain("export const b = 2");
  });

  it("AC4/GC — o branch-gc ENXERGA agent/* e nunca colhe código não integrado (fail-closed)", async () => {
    const s = await open();
    await writeIn(s.worktreePath, "packages/app/gc.ts", "export const g = 1;\n");
    await exec(`git add -A`, { cwd: s.worktreePath });
    await exec(`git commit -q --no-verify -m "código da sessão"`, { cwd: s.worktreePath });
    await discardSessionWorktree(deps, { sessionId: s.sessionId }); // → failed/agent/<id>

    const listed = await listPreservedRunBranches({
      exec,
      repoRoot: repo,
      liveRunIds: async () => [],
      liveSessionIds: async () => ({ ok: true, ids: [] }),
      stageBranch: "stage",
      cardStatus: async () => null,
    });
    const mine = listed.find((b) => b.branch === `failed/agent/${s.sessionId}`);
    expect(mine).toBeDefined();
    expect(mine!.origin).toBe("session"); // enxergado, e rotulado como sessão
    expect(mine!.touchesCode).toBe(true);
    expect(mine!.ownCommits).toBe(1); // a régua mediu o trabalho PRÓPRIO, não a herança do stage

    // A decisão do GC sobre ele: código não provado em main/stage ⇒ NUNCA colher, por mais velho que seja.
    expect(
      classifyBranch(
        { superseded: mine!.superseded, ageDays: 999, touchesCode: true, codeIntegrated: false },
        { harvestAfterDays: 7, staleAfterDays: 30 },
      ),
    ).toBe("keep-unmerged-code");
  });

  it("G7 — um worktree de sessão VIVA é invisível ao GC e intocável pelo boot-reconciler", async () => {
    const s = await open("sessão trabalhando há horas");

    // (a) o painel/GC não o trata como órfão enquanto a sessão está viva
    const listed = await listPreservedRunBranches({
      exec,
      repoRoot: repo,
      liveRunIds: async () => [],
      liveSessionIds: async () => ({ ok: true, ids: [s.sessionId] }), // o registro durável diz: tem gente em casa
      stageBranch: "stage",
      cardStatus: async () => null,
    });
    expect(listed.some((b) => b.sessionId === s.sessionId)).toBe(false);

    // (b) o boot-reconciler NÃO poda a árvore dela. `keep` vem do JOURNAL DE RUNS — e uma sessão nunca
    //     esteve no journal, então é exatamente aqui que a regra dos runs a destruiria.
    const removed: string[] = [];
    const reconcile = makeReconcileWorktrees({
      listWorktrees: async () => (await exec(`git worktree list --porcelain`, { cwd: repo })).stdout,
      removeWorktree: async (_p, branch) => void removed.push(branch),
      isSessionReapable: async () => false, // heartbeat vivo
    });
    await reconcile(new Set()); // nenhum run vivo
    expect(removed).toEqual([]);
    expect(await fsp.stat(s.worktreePath).then(() => true).catch(() => false)).toBe(true);

    // (c) com heartbeat MORTO + TTL vencido, a PASTA é liberada. `toContain` (e não toEqual): o repo do
    // teste é compartilhado entre os `it`s, então outras árvores de sessão podem estar de pé — o que este
    // caso afirma é sobre ESTA sessão, e um toEqual só acoplaria a asserção à ordem dos testes.
    const removed2: string[] = [];
    const reconcile2 = makeReconcileWorktrees({
      listWorktrees: async () => (await exec(`git worktree list --porcelain`, { cwd: repo })).stdout,
      removeWorktree: async (_p, branch) => void removed2.push(branch),
      isSessionReapable: async () => true,
    });
    await reconcile2(new Set());
    expect(removed2).toContain(s.branch);

    await discardSessionWorktree(deps, { sessionId: s.sessionId }).catch(() => {});
  });

  // O INCIDENTE de 2026-07-27, ponta a ponta sobre git DE VERDADE. Uma sessão interativa editou por horas
  // sem commitar; o `heartbeatAt` só avança em chamada de tool, venceu o TTL, a varredura chamou `remove`
  // e o `git worktree remove --force` apagou os arquivos — sem commit não há objeto, então não havia NADA
  // a recuperar. O teste prova a inversão: a MESMA chamada agora devolve o trabalho.
  it("REGRESSÃO — a árvore reapada devolve o trabalho NÃO-COMMITADO (resgate → failed/agent/<id>)", async () => {
    const s = await open("editando há horas, sem commitar");
    const file = path.join("packages", "app", "resgatado.ts");
    await fsp.writeFile(path.join(s.worktreePath, file), "export const salvo = 42;\n");

    // O registro no estado do incidente: a sessão EXISTE e o heartbeat venceu (o varredor tem carta
    // branca do `assertRemovable`) — é assim que a pasta foi parar no `--force`.
    await fsp.writeFile(
      sessionsFilePath(),
      JSON.stringify({
        v: 1,
        sessions: [{ ...s, heartbeatAt: new Date(Date.now() - 9 * 3600_000).toISOString() }],
      }),
      "utf8",
    );

    await makeWorktreeOps(exec).remove(s.worktreePath, s.branch, s.baseCommit);

    // A pasta some (o varredor cumpriu o papel dele)…
    expect(await fsp.stat(s.worktreePath).then(() => true).catch(() => false)).toBe(false);
    // …mas o trabalho VIROU COMMIT e o branch foi preservado — recuperável por cherry-pick.
    const preserved = `failed/${s.branch}`;
    const show = await exec(`git show ${preserved}:${file}`, { cwd: repo });
    expect(show.stdout).toContain("salvo = 42");
    const subject = await exec(`git log -1 --format=%s ${preserved}`, { cwd: repo });
    expect(subject.stdout).toContain("resgate");
  });

  // REGRESSÃO (2026-07-21) — a perda de trabalho que originou o story-lcagq1. `liveSessionIds` devolvia
  // `[]` num `.catch()` mudo, e os consumidores dela são listas de PROTEÇÃO: "não consegui LER o registro"
  // virava "NENHUMA sessão está viva", isto é, TODA árvore de sessão vira reapável de uma vez — a frota
  // inteira varrida por uma falha de leitura. O resultado agora é discriminado e o compilador obriga o
  // chamador a separar os dois casos.
  it("registro ILEGÍVEL nunca autoriza reap (fail-closed) — mas registro VAZIO autoriza", async () => {
    const boom: SessionStore = {
      load: async () => {
        throw new Error("sessions.json corrompido");
      },
      persist: async () => {},
    };
    const failed = await liveSessionIds(boom);
    expect(failed.ok).toBe(false);

    // A doutrina do consumidor, afirmada no MESMO teste que a causa: ilegível ⇒ não reapa.
    const reapableOn = (r: LiveSessionIdsResult, id: string) => (r.ok ? !r.ids.includes(id) : false);
    expect(reapableOn(failed, "qualquer-sessao")).toBe(false);

    // Um registro legitimamente VAZIO é uma resposta DIFERENTE — e aí reapar é o comportamento correto
    // (é o que limpa árvore de sessão morta). Sem esta metade, o fail-closed viraria "nunca limpa nada".
    const empty: SessionStore = { load: async () => [], persist: async () => {} };
    const ok = await liveSessionIds(empty);
    expect(ok).toEqual({ ok: true, ids: [] });
    expect(reapableOn(ok, "sessao-morta")).toBe(true);
  });

  // REGRESSÃO (2026-07-23) — o teste ACIMA prova o CONSUMIDOR com um store injetado que lança. Faltava o
  // PRODUTOR: o store de PRODUÇÃO (`makeSessionStore`) tinha um `catch { return [] }` cego, então ele
  // nunca lançava e o ramo `ok:false` era, na prática, inalcançável em produção — a correção de 07-21
  // estava anulada uma camada abaixo. Observado ao vivo: um servidor subido de um worktree cujo
  // `.runner/` é gitignored (logo, sem arquivo de registro) declarou QUATRO árvores de sessão VIVAS
  // "heartbeat morto + TTL vencido"; só o guard fail-closed do `removeWorktree` impediu a remoção.
  describe("makeSessionStore — o PRODUTOR do ok:false (registro real em disco)", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-registry-"));
    });

    // O diretório é POR TESTE: sem este afterEach cada passada do portão deixava 5 órfãos em /tmp.
    afterEach(async () => {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    // ESTE é o incidente de 2026-07-23, reproduzido: um servidor subido de dentro de um worktree resolve
    // `findRepoRoot()` para a RAIZ DO WORKTREE (tem turbo.json), e `storymap/.runner/` é gitignored — logo
    // não há sessions.json ali. O registro "vazio" que ele lia era, na verdade, o registro ERRADO, e as 4
    // sessões vivas da frota viraram reapáveis de uma vez. Ausência de registro é ausência de EVIDÊNCIA.
    it("arquivo AUSENTE nunca autoriza reap — 'não há registro aqui' não é 'ninguém está vivo'", async () => {
      const store = makeSessionStore(path.join(dir, "sessions.json"));
      const res = await liveSessionIds(store);
      expect(res.ok).toBe(false);

      const reapable = (r: LiveSessionIdsResult, id: string) => (r.ok ? !r.ids.includes(id) : false);
      expect(reapable(res, "sessao-viva-registrada-em-outro-root")).toBe(false);
    });

    it("JSON CORROMPIDO produz ok:false — não 'ninguém está vivo'", async () => {
      const file = path.join(dir, "sessions.json");
      await fsp.writeFile(file, '{"v":1,"sessions":[{"sessionId":"a"', "utf8"); // truncado
      const res = await liveSessionIds(makeSessionStore(file));
      expect(res.ok).toBe(false);
    });

    it("shape MALFORMADO (JSON válido, registro irreconhecível) produz ok:false", async () => {
      const file = path.join(dir, "sessions.json");
      await fsp.writeFile(file, '{"v":1}', "utf8"); // sem `sessions`
      const res = await liveSessionIds(makeSessionStore(file));
      expect(res.ok).toBe(false);
    });

    it("um registro ÍNTEGRO com sessão viva continua protegendo (a correção não cega o caminho feliz)", async () => {
      const file = path.join(dir, "sessions.json");
      const viva = { sessionId: "viva-1", heartbeatAt: Date.now() };
      await fsp.writeFile(file, JSON.stringify({ v: 1, sessions: [viva] }), "utf8");
      const res = await liveSessionIds(makeSessionStore(file));
      expect(res).toEqual({ ok: true, ids: ["viva-1"] });
    });

    it("o `load` LENIENTE segue engolindo o erro — os outros 9 chamadores não mudam de contrato", async () => {
      const file = path.join(dir, "sessions.json");
      await fsp.writeFile(file, "isto não é json", "utf8");
      await expect(makeSessionStore(file).load()).resolves.toEqual([]);
    });
  });

  it("G7 — sem o dep isSessionReapable o reconciler NÃO toca em sessão nenhuma (fail-closed)", async () => {
    const s = await open();
    const removed: string[] = [];
    const reconcile = makeReconcileWorktrees({
      listWorktrees: async () => (await exec(`git worktree list --porcelain`, { cwd: repo })).stdout,
      removeWorktree: async (_p, branch) => void removed.push(branch),
      // isSessionReapable AUSENTE (um caller legado) ⇒ ninguém é reapable
    });
    await reconcile(new Set());
    expect(removed).toEqual([]);
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("parseRunWorktrees rotula run/* e agent/* (o que decide o destino oposto no reconciler)", async () => {
    const s = await open();
    const parsed = parseRunWorktrees((await exec(`git worktree list --porcelain`, { cwd: repo })).stdout);
    const mine = parsed.find((w) => w.sessionId === s.sessionId);
    expect(mine).toMatchObject({ branch: s.branch, origin: "session" });
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("submit recusa quando a sessão já tem submissão EM VOO (senão o enqueue idempotente a engoliria)", async () => {
    const s = await open();
    await writeIn(s.worktreePath, "packages/app/x.ts", "export const x = 5;\n");
    await submitSessionWork(deps, { sessionId: s.sessionId });
    // NÃO esperamos o train: a entrada está viva. Um 2º submit não pode ser silenciosamente ignorado.
    const second = await submitSessionWork(deps, { sessionId: s.sessionId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain("EM VOO");
    await mq.whenIdle();
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("submit sem nada a integrar não coloca no-op no train (o gate custa uma suíte inteira)", async () => {
    const s = await open();
    const res = await submitSessionWork(deps, { sessionId: s.sessionId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("nada a submeter");
    expect(queueStore.read()).toEqual([]);
    await discardSessionWorktree(deps, { sessionId: s.sessionId });
  });

  it("WS-1.3 — duas sessões SEM card não se supersedem (undefined === undefined era a armadilha)", async () => {
    const a = await open("sessão A sem card");
    const b = await open("sessão B sem card");
    await writeIn(a.worktreePath, "packages/app/a.ts", "export const a = 1;\n");
    await writeIn(b.worktreePath, "packages/app/b.ts", "export const b = 1;\n");

    await submitSessionWork(deps, { sessionId: a.sessionId });
    await submitSessionWork(deps, { sessionId: b.sessionId });
    await mq.whenIdle();

    // As DUAS integraram. Antes do guard, a entrada de B (mesmo board "", mesmo cardId undefined) teria
    // marcado a de A como `failed` — trabalho de outra sessão, nem integrado nem de nenhum card.
    const ea = queueStore.read().find((e) => e.runId === a.sessionId)!;
    const eb = queueStore.read().find((e) => e.runId === b.sessionId)!;
    expect([ea.status, eb.status]).toEqual(["done", "done"]);
    expect((await exec(`git show stage:packages/app/a.ts`, { cwd: repo })).stdout).toContain("export const a = 1");
    expect((await exec(`git show stage:packages/app/b.ts`, { cwd: repo })).stdout).toContain("export const b = 1");

    await discardSessionWorktree(deps, { sessionId: a.sessionId });
    await discardSessionWorktree(deps, { sessionId: b.sessionId });
  });

  it("cap: a admissão recusa a 5ª árvore (e a recusa é acionável)", async () => {
    deps.maxWorktrees = 2;
    const a = await open("A");
    const b = await open("B");
    const third = await openSessionWorktree(deps, { task: "C" });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain("cap de worktrees");
    await discardSessionWorktree(deps, { sessionId: a.sessionId });
    await discardSessionWorktree(deps, { sessionId: b.sessionId });
  });
});

describe("fantasma no registro — entrada cuja ÁRVORE sumiu do disco", () => {
  // O incidente: o cap ficou 4/4 com QUATRO fantasmas e recusou todo worktree_open novo. A
  // capacidade inteira da frota travada por entradas cujas pastas já não existiam, sem nada que
  // percebesse sozinho — só um humano descobrindo os ids e descartando na mão.
  const sess = (id: string, over: Partial<AgentSession> = {}): AgentSession => ({
    sessionId: id,
    agentId: id,
    role: "implement",
    branch: `agent/${id}`,
    worktreePath: `/w/agent-${id}`,
    baseCommit: "abc",
    task: `t-${id}`,
    openedAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    ...over,
  });
  const fs = (existentes: string[]) => ({
    isDir: async (p: string) => existentes.includes(p),
  });

  it("separa quem tem árvore de quem virou fantasma", async () => {
    const r = await partitionByTreePresence(fs(["/w/agent-viva"]), [sess("viva"), sess("morta")]);
    expect(r.present.map((s) => s.sessionId)).toEqual(["viva"]);
    expect(r.ghosts.map((s) => s.sessionId)).toEqual(["morta"]);
  });

  it("sessão ADOTADA (sem worktreePath) NUNCA é fantasma", async () => {
    // 6.2: ela não tem árvore por desenho — tratá-la como fantasma comeria justamente as
    // sessões que existem sem isolamento.
    const adotada = sess("adotada", { worktreePath: undefined, branch: undefined });
    const r = await partitionByTreePresence(fs([]), [adotada]);
    expect(r.present.map((s) => s.sessionId)).toEqual(["adotada"]);
    expect(r.ghosts).toEqual([]);
  });

  it("erro ao consultar o disco conta como PRESENTE (fail-closed)", async () => {
    // "Não consegui olhar" jamais pode virar "não existe": é a mesma regra que impede o reaper
    // de varrer uma sessão viva.
    const fsQuebrado = { isDir: async () => { throw new Error("EIO"); } };
    const r = await partitionByTreePresence(fsQuebrado, [sess("a")]);
    expect(r.present.map((s) => s.sessionId)).toEqual(["a"]);
    expect(r.ghosts).toEqual([]);
  });

  it("o cap deixa de contar o fantasma depois da partição", async () => {
    const todas = [sess("a"), sess("b"), sess("c"), sess("d")];
    const { present } = await partitionByTreePresence(fs(["/w/agent-a"]), todas);
    // Antes: 4/4 e recusa. Agora: só 'a' tem árvore, então há vaga.
    expect(admissionVerdict(todas, 0, { maxWorktrees: 4 }).ok).toBe(false);
    expect(admissionVerdict(present, 0, { maxWorktrees: 4 }).ok).toBe(true);
  });
});
