// story-5vv8n1 — INTEGRITY GATE for promote-and-deploy. A card must NEVER reach "No Ar" unless the staged
// code was ACTUALLY promoted to main AND the deploy did real work. Two chained bugs let it lie:
//   (1) fireReleaseStaged only console.log'd a no-op release (promoted:false) — it never propagated the
//       failure, so firePromoteAndDeploy fired the deploy + autoEnterTerminal claimed "No Ar" regardless.
//   (2) a diff-aware orch-deploy of un-promoted code exits 0 in ~0s (no drift) → ev.ok===true → the onDone
//       revert (which only fired on ev.ok===false) never ran.
// These tests drive firePromoteAndDeploy over a MOCKED release/deploy/revert seam and assert the gate:
// a real promotion FAILURE suppresses the deploy and REVERTS the card instead of shipping a lie.

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock every collaborator of entry-effects so firePromoteAndDeploy runs without real git / deploy / disk.
vi.mock("./release", () => ({ promoteStageToMain: vi.fn() }));
vi.mock("./deploy", () => ({ deployBoard: vi.fn(async () => ({ fired: true, tool: "orch-deploy", pkg: "acmeapp" })) }));
vi.mock("./deploy-revert", () => ({ revertCardOnDeployFailure: vi.fn(async () => {}) }));
vi.mock("./commit-serializer", () => ({ serialCommit: (_root: string, fn: () => unknown) => fn() }));
vi.mock("./worktree", () => ({ defaultExec: vi.fn() }));
vi.mock("./config", () => ({
  loadRunnerConfig: () => ({ autorun: { staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] } } }),
}));
vi.mock("@/lib/storymap/paths", () => ({ findRepoRoot: () => "/repo" }));
vi.mock("@/lib/storymap/repo", () => ({
  readBoardConfig: vi.fn(async () => ({ package: "packages/acmeapp", statuses: [] })),
  readCards: vi.fn(async () => []),
  // story-4eqltw — default: no other boards → empty exclusion set (leaves existing tests unaffected).
  listBoards: vi.fn(async () => []),
}));
vi.mock("@/lib/storymap/write", () => ({ updateCardOnDisk: vi.fn(async () => {}) }));
// WS-10.4 — o degrau 2 da escada é um SPAWN de `claude` (harness-resolve). Aqui ele é um port fake: o call-site
// do release é o objeto do teste, não o juiz. `makeJudgePort` é o seam — é ele que entry-effects chama.
vi.mock("./resolution-judge-spawn", () => ({ makeJudgePort: vi.fn(() => async () => ({ hunks: [], runId: "noop" })) }));
// 1.5 — stub the durable store so the redispatch defaults never touch disk/runnerStateDir (paths is mocked).
vi.mock("./pending-self-deploy", () => ({
  getPendingSelfDeploy: vi.fn(() => ({
    enqueue: vi.fn(async () => {}),
    take: vi.fn(async () => null),
    peek: vi.fn(async () => null),
  })),
}));
// deploy-truth WS-3 — the undeployable-board path dynamically imports the settle handler; mock it so the
// test observes the immediate evidence settle without touching git/fs (vitest intercepts dynamic imports).
vi.mock("./deploy-reconcile", () => ({ settleDeploySuccess: vi.fn(async () => null) }));

import { fireDeployBoard, firePromoteAndDeploy, fireReleaseStaged, classifyRelease, redispatchPendingSelfDeploy } from "./entry-effects";
import type { DeployResult } from "./deploy";
import { promoteStageToMain, type PromoteResult } from "./release";
import { deployBoard } from "./deploy";
import { revertCardOnDeployFailure } from "./deploy-revert";
import { settleDeploySuccess } from "./deploy-reconcile";
import { listBoards, readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { defaultExec } from "./worktree";
import { makeJudgePort } from "./resolution-judge-spawn";
import type { Card } from "@/lib/storymap/types";
import type { HunkAnalysis, JudgePort, JudgeRequest } from "./semantic-resolution";

const mockPromote = vi.mocked(promoteStageToMain);
const mockDeploy = vi.mocked(deployBoard);
const mockRevert = vi.mocked(revertCardOnDeployFailure);
const mockReadBoardConfig = vi.mocked(readBoardConfig);
const mockListBoards = vi.mocked(listBoards);

// A PromoteResult stub — `outcome` is the new discriminator this fix adds to release.ts.
const promoteResult = (o: Record<string, unknown>) => ({ branch: "main", pushed: false, ...o }) as never;

afterEach(() => vi.clearAllMocks());

describe("firePromoteAndDeploy — integrity gate: a failed release must NOT ship or claim No Ar (story-5vv8n1)", () => {
  it("SUPPRESSES the deploy and REVERTS the card when the release failed to promote (out-of-scope staged code)", async () => {
    // The acme incident: `stage` carried real code but under packages/orbit/** — OUTSIDE the board's
    // scoped prefix (packages/acmeapp/) — so the scoped promote found 0 files → promoted:false, silently.
    // Today that no-op still fires the deploy and lets autoEnterTerminal declare "No Ar" with code stuck on stage.
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "out-of-scope", reason: "código staged fora do escopo do board" }));

    await firePromoteAndDeploy("acme", "story-m9g2gh");

    // GATE: a real promotion failure must NOT publish and must reverse the optimistic terminal.
    expect(mockDeploy).not.toHaveBeenCalled();
    expect(mockRevert).toHaveBeenCalledWith("acme", "story-m9g2gh", expect.objectContaining({ phase: "release" }));
  });

  it("SUPPRESSES + reverts when the staged code did not apply cleanly (apply-failed)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "apply-failed", reason: "não aplicou limpo" }));
    await firePromoteAndDeploy("acme", "story-z5pg1v");
    expect(mockDeploy).not.toHaveBeenCalled();
    expect(mockRevert).toHaveBeenCalledWith("acme", "story-z5pg1v", expect.objectContaining({ phase: "release" }));
  });

  it("FIRES the deploy when the release genuinely promoted new code (and never reverts)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted" }));
    await firePromoteAndDeploy("acme", "story-real");
    expect(mockDeploy).toHaveBeenCalledTimes(1);
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it("FIRES the deploy on a LEGIT idempotent no-op (code already on main) without reverting", async () => {
    // Idempotency is NOT a failure: the code is already live, re-entering release is a clean no-op → the
    // deploy (a diff-aware no-op) is fine and the card stays terminal. Only real FAILURES revert.
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted", reason: "nada a commitar (já promovido)" }));
    await firePromoteAndDeploy("acme", "story-idem");
    expect(mockDeploy).toHaveBeenCalledTimes(1);
    expect(mockRevert).not.toHaveBeenCalled();
  });
});

// story-efwo30 — the deploy's face gate (touchesComposedFace) needs the list of files the release just
// promoted. firePromoteAndDeploy must THREAD that list from the promote result into deployBoard, so a board
// deploy can decide whether to ALSO publish the mosaico.app merged web face. Driven over the MOCKED seam.
describe("firePromoteAndDeploy — threads the promoted diff to the deploy (story-efwo30)", () => {
  it("forwards the release's changedFiles into deployBoard", async () => {
    mockPromote.mockResolvedValue(
      promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted", changedFiles: ["packages/acmeapp/web/src/app/page.tsx"] }),
    );
    await firePromoteAndDeploy("acme", "story-face");
    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ changedFiles: ["packages/acmeapp/web/src/app/page.tsx"], expectWork: true }),
    );
  });

  it("forwards an empty list when the promote reported no changed files", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    await firePromoteAndDeploy("acme", "story-idem2");
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
  });
});

// PURE — the discriminator that resolves the `promoted:false` ambiguity into a deploy/terminal decision.
describe("classifyRelease — legit no-op vs real promotion failure (story-5vv8n1)", () => {
  const result = (o: Partial<PromoteResult>): PromoteResult => ({ promoted: false, branch: "main", pushed: false, outcome: "nothing-staged", ...o }) as PromoteResult;

  it("promoted → deployable, expectWork, no revert", () => {
    expect(classifyRelease(result({ promoted: true, outcome: "promoted" }))).toMatchObject({ deployable: true, revert: false, expectWork: true });
  });

  it("story-efwo30: carries the promoted changedFiles through (defaulting to [] when absent)", () => {
    expect(classifyRelease(result({ promoted: true, outcome: "promoted", changedFiles: ["packages/acmeapp/web/x.tsx"] }))).toMatchObject({
      changedFiles: ["packages/acmeapp/web/x.tsx"],
    });
    expect(classifyRelease(result({ outcome: "nothing-staged" })).changedFiles).toEqual([]);
  });

  it("already-promoted / nothing-staged → deployable no-op, no expectWork, no revert", () => {
    for (const outcome of ["already-promoted", "nothing-staged"] as const) {
      expect(classifyRelease(result({ outcome }))).toMatchObject({ deployable: true, revert: false, expectWork: false });
    }
  });

  it("out-of-scope / apply-failed / blocked / no-prefix → NOT deployable, REVERT", () => {
    for (const outcome of ["out-of-scope", "apply-failed", "blocked", "no-prefix"] as const) {
      expect(classifyRelease(result({ outcome }))).toMatchObject({ deployable: false, revert: true, expectWork: false });
    }
  });
});

// story-r4qdap — a board that LEGITIMATELY touches shared packages beyond its own (acme fixing code in
// packages/acme-shared/ or packages/orbit/) declares them in BoardConfig.sharedPackages. The release
// must WIDEN its scoped codePrefixes to include those, so the shared-package delta is promoted stage→main
// instead of being detected as out-of-scope and reverted (the story-5vv8n1 revert path). This drives the
// derivation at the fireReleaseStaged seam over the MOCKED promote, asserting the pathspec it hands down.
describe("fireReleaseStaged — release scope includes BoardConfig.sharedPackages (story-r4qdap)", () => {
  it("WIDENS codePrefixes to the board's own package PLUS its declared sharedPackages (normalized)", async () => {
    // Pass a MIX of trailing-slash / no-trailing-slash to prove the same normalization as `package`.
    mockReadBoardConfig.mockResolvedValueOnce({
      package: "packages/acmeapp",
      sharedPackages: ["packages/orbit", "packages/acme-shared/"],
      statuses: [],
    } as never);
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted" }));

    await fireReleaseStaged("acme");

    // The scoped promote must look at ALL THREE prefixes (own + shared), each normalized with a trailing slash.
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({
        codePrefixes: ["packages/acmeapp/", "packages/orbit/", "packages/acme-shared/"],
        // the out-of-scope discriminator still sees the GLOBAL roots (unchanged) so real out-of-scope code still trips.
        allCodePrefixes: ["packages/"],
      }),
    );
  });

  it("falls back to the board's own package alone when no sharedPackages are declared", async () => {
    mockReadBoardConfig.mockResolvedValueOnce({ package: "packages/acmeapp", statuses: [] } as never);
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, commit: "def5678", outcome: "promoted" }));

    await fireReleaseStaged("acme");

    expect(mockPromote).toHaveBeenCalledWith(expect.objectContaining({ codePrefixes: ["packages/acmeapp/"] }));
  });
});

// story-4eqltw — CROSS-BOARD false-positive fix at the derivation seam. On the single shared `stage`, the
// out-of-scope probe must EXCLUDE every OTHER board's package (each promotes on its own frontier), so a board
// releasing with its own scoped diff empty is not reverted just because ANOTHER board (e.g. storymap-ui) left
// un-promoted code on stage. The releasing board's OWN package must NEVER be excluded (it still self-promotes).
describe("fireReleaseStaged — excludes OTHER boards' packages from the out-of-scope probe (story-4eqltw)", () => {
  it("passes every OTHER board's package as otherBoardPrefixes, never the releasing board's own", async () => {
    // Call order is deterministic: fireReleaseStaged reads the RELEASING board's config first, then the helper
    // walks listBoards() and reads each OTHER board's config (skipping the releasing board itself).
    mockReadBoardConfig
      .mockResolvedValueOnce({ package: "packages/acmeapp", statuses: [] } as never) // releasing board (acme)
      .mockResolvedValueOnce({ package: "packages/storymap-ui", statuses: [] } as never) // other: storymap
      .mockResolvedValueOnce({ package: "packages/orbit", statuses: [] } as never) // other: orbit
      .mockResolvedValueOnce({ package: undefined, statuses: [] } as never); // other: nimbus — no package → omitted
    mockListBoards.mockResolvedValueOnce([
      { id: "storymap", name: "AgileHarness" },
      { id: "acme", name: "Nest" },
      { id: "orbit", name: "Quartz" },
      { id: "nimbus", name: "Spot" },
    ] as never);
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "nothing-staged" }));

    await fireReleaseStaged("acme");

    const call = mockPromote.mock.calls[0][0] as { otherBoardPrefixes: string[] };
    // OTHER boards with a declared package are excluded (normalized to a trailing slash); nimbus (no package) omitted.
    expect(call.otherBoardPrefixes).toEqual(["packages/storymap-ui/", "packages/orbit/"]);
    // the releasing board's OWN package is NEVER in the exclusion set — it must still promote/flag its own code.
    expect(call.otherBoardPrefixes).not.toContain("packages/acmeapp/");
  });

  it("degrades to an empty exclusion set when the board list cannot be read (best-effort, never throws)", async () => {
    mockReadBoardConfig.mockResolvedValueOnce({ package: "packages/acmeapp", statuses: [] } as never);
    mockListBoards.mockRejectedValueOnce(new Error("disk gone"));
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "nothing-staged" }));

    await fireReleaseStaged("acme");

    const call = mockPromote.mock.calls[0][0] as { otherBoardPrefixes: string[] };
    expect(call.otherBoardPrefixes).toEqual([]);
  });
});

// Incidente 2026-07-09 (gap do story-g9kxo9): na RECUPERAÇÃO (card revertido p/ `release` por falha da
// face → humano reentra no Deploy), o promote devolve already-promoted com changedFiles VAZIO → o gate
// touchesComposedFace nunca re-armava a face — o card voltava a "No ar" com a face genuinamente quebrada.
// O re-entry agora DERIVA os arquivos do próprio card (git diff do commitRange durável) quando o promote
// não trouxe diff, então a face re-dispara na recuperação sem depender de um deploy manual.
describe("firePromoteAndDeploy — re-entry recovery deriva changedFiles do commitRange do card", () => {
  const cardWithRange = {
    id: "story-syjb8k",
    type: "story",
    status: "deploy",
    commitRange: { base: "11686c27", head: "be8c0427" },
  } as never;

  it("promote sem diff (already-promoted) + card com commitRange → deriva via git diff e re-arma a face", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([cardWithRange]);
    vi.mocked(defaultExec).mockResolvedValue({
      stdout: "packages/orbit/web/src/lib/launcher-copy.ts\npackages/orbit/web/src/lib/__tests__/launcher-copy.test.ts\n",
      stderr: "",
    });

    await firePromoteAndDeploy("acme", "story-syjb8k");

    expect(vi.mocked(defaultExec)).toHaveBeenCalledWith(
      expect.stringContaining("git diff --name-only 11686c27 be8c0427"),
      expect.anything(),
    );
    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: expect.arrayContaining(["packages/orbit/web/src/lib/launcher-copy.ts"]),
      }),
    );
  });

  it("promote COM diff → usa o diff do promote e NÃO consulta o commitRange (o caminho normal fica intacto)", async () => {
    mockPromote.mockResolvedValue(
      promoteResult({ promoted: true, commit: "abc", outcome: "promoted", changedFiles: ["packages/acmeapp/api/x.ts"] }),
    );
    vi.mocked(readCards).mockResolvedValue([cardWithRange]);

    await firePromoteAndDeploy("acme", "story-syjb8k");

    expect(vi.mocked(defaultExec)).not.toHaveBeenCalled();
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: ["packages/acmeapp/api/x.ts"] }));
  });

  it("card sem commitRange → segue com lista vazia (comportamento anterior), sem git", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([{ id: "story-syjb8k", type: "story", status: "deploy" } as never]);

    await firePromoteAndDeploy("acme", "story-syjb8k");

    expect(vi.mocked(defaultExec)).not.toHaveBeenCalled();
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
  });

  it("falha do git na derivação → degrada para lista vazia (best-effort, nunca lança)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([cardWithRange]);
    vi.mocked(defaultExec).mockRejectedValue(new Error("bad object"));

    await firePromoteAndDeploy("acme", "story-syjb8k");

    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
  });
});

// WS-10.4 — O CALL-SITE DO RELEASE (climbReleaseLadder). A escada em si é coberta por
// semantic-resolution.test.ts; o que se prova AQUI é a dança do invariante 1 no release, que é a parte sutil:
// o juiz NUNCA escreve em stage/main — ele commita na PRÓPRIA branch, e o que aterrissa é um `update-ref` de
// `stage` para essa branch, seguido de uma re-execução do promoteStageToMain INALTERADO. Ou seja: o código
// resolvido ainda encara o delta real, o `--3way` real, o secret-scan real e o push real. Era o outro metade
// do gap do cenário 8 ("divergência cosmética no train E no release"): nenhum teste dirigia este call-site.
describe("fireReleaseStaged — o call-site do RELEASE dirige a escada semântica (WS-10.4)", () => {
  afterEach(() => vi.mocked(defaultExec).mockReset());

  const APPLY_FAILED = promoteResult({
    promoted: false,
    outcome: "apply-failed",
    reason: "não aplicou limpo",
    divergentFiles: ["packages/acmeapp/api/x.ts"],
  });
  const cosmetic: HunkAnalysis = {
    file: "packages/acmeapp/api/x.ts",
    hunk: "<<<<<<<\n// a\n=======\n// b\n>>>>>>>",
    verdict: "cosmetic",
    rationale: "o mesmo comentário, redigido de dois jeitos",
  };

  /** Um exec de git em que o degrau 1 responde "os lados DIVERGEM mesmo" (exit 1 — a resposta real, não uma
   *  falha), para a divergência chegar ao juiz. `updateRefFails` modela o ref que não se move. */
  const SHA_STAGE = "a".repeat(40); // tip atual do stage (o PAI do enxerto)
  const SHA_TREE = "b".repeat(40);
  const SHA_GRAFT = "c".repeat(40); // o commit NOVO que carrega a resolução
  function releaseExec(opts: { updateRefFails?: boolean } = {}) {
    const cmds: string[] = [];
    vi.mocked(defaultExec).mockImplementation((async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("diff --quiet -w")) throw Object.assign(new Error("differ"), { code: 1 });
      if (cmd.includes("update-ref") && opts.updateRefFails) throw Object.assign(new Error("ref locked"), { code: 128 });
      // O ENXERTO (graftResolvedFilesOntoStage) é plumbing: cada passo devolve o que o git devolveria.
      if (cmd.includes("ls-tree")) return { stdout: `100644 blob ${"d".repeat(40)}\tpackages/acmeapp/api/x.ts\n`, stderr: "" };
      if (cmd.includes("write-tree")) return { stdout: `${SHA_TREE}\n`, stderr: "" };
      if (cmd.includes("commit-tree")) return { stdout: `${SHA_GRAFT}\n`, stderr: "" };
      if (cmd.includes("rev-parse")) return { stdout: `${SHA_STAGE}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    }) as never);
    return cmds;
  }

  /** O juiz fake, no mesmo seam que a produção usa (makeJudgePort). Grava o pedido que o release montou. */
  function judging(verdict: () => Awaited<ReturnType<JudgePort>>) {
    const requests: JudgeRequest[] = [];
    vi.mocked(makeJudgePort).mockReturnValue((async (req: JudgeRequest) => {
      requests.push(req);
      return verdict();
    }) as never);
    return requests;
  }

  it("degrau 2 resolve ⇒ a resolução é ENXERTADA no topo do stage (nunca substitui) e o release RE-TENTA o MESMO promote", async () => {
    const cmds = releaseExec();
    const requests = judging(() => ({ hunks: [cosmetic], runId: "judge-1", resolvedRef: "resolve/abc" }));
    mockPromote.mockResolvedValueOnce(APPLY_FAILED).mockResolvedValueOnce(promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted" }));

    await firePromoteAndDeploy("acme", "story-lad1");

    // OURS = a branch liberada (o que main tem AGORA); THEIRS = stage. A orientação importa: o degrau 1
    // resolve MANTENDO `ours`, e para um release "fica com main" é exatamente o certo.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      sides: { ours: "main", theirs: "stage", files: ["packages/acmeapp/api/x.ts"] },
      origin: "release",
      conflictDetail: "não aplicou limpo",
    });
    // O ENXERTO, não a substituição. O `stage` é COMPARTILHADO por todo o repo: apontá-lo para a árvore do
    // juiz — que é cortada de `main` e só tem os arquivos divergentes — DESCARTA o código não-liberado de todos
    // os outros cards e sessões (medido em produção 2026-07-20: 10+ commits de dois pacotes seriam perdidos).
    // Então o índice PARTE do stage, só os arquivos divergentes recebem a versão do juiz, e o commit resultante
    // tem o tip ANTERIOR do stage como PAI — a história não-liberada sobrevive por construção.
    expect(cmds.some((c) => c.includes(`git read-tree "stage"`))).toBe(true); // parte do STAGE, não do juiz
    expect(cmds.some((c) => c.includes("update-index") && c.includes("packages/acmeapp/api/x.ts"))).toBe(true);
    expect(cmds.some((c) => c.includes(`git commit-tree ${SHA_TREE} -p ${SHA_STAGE}`))).toBe(true); // pai = stage
    expect(cmds.filter((c) => c.includes("update-ref"))).toEqual([
      `git update-ref "refs/heads/stage" ${SHA_GRAFT} ${SHA_STAGE}`, // CAS: só move se o tip não mudou
    ]);
    // O juiz segue sem publicar nada: nenhum push/merge/apply saiu daqui (o enxerto é plumbing local).
    expect(cmds.some((c) => /git (push|merge|apply)/.test(c))).toBe(false);
    // …e o retry é o release ORDINÁRIO de novo: o MESMO promoteStageToMain, com os mesmos argumentos.
    expect(mockPromote).toHaveBeenCalledTimes(2);
    expect(mockPromote.mock.calls[1][0]).toEqual(mockPromote.mock.calls[0][0]);
    expect(mockDeploy).toHaveBeenCalledTimes(1); // o retry promoveu → o deploy segue
    expect(mockRevert).not.toHaveBeenCalled();
  });

  it("veredito SUBSTANTIVO ⇒ `stage` INTOCADO, sem retry, e a falha ORIGINAL é reportada — agora COM a análise por hunk", async () => {
    const cmds = releaseExec();
    judging(() => ({
      hunks: [cosmetic, { file: "packages/acmeapp/api/x.ts", hunk: "<<<<<<<\nreturn 1\n=======\nreturn 2\n>>>>>>>", verdict: "substantive", rationale: "duas implementações diferentes" }],
      runId: "judge-2",
    }));
    mockPromote.mockResolvedValue(APPLY_FAILED);

    await firePromoteAndDeploy("acme", "story-lad2");

    expect(cmds.some((c) => c.includes("update-ref"))).toBe(false); // fail-closed: o ref NUNCA se move sem resolução
    expect(mockPromote).toHaveBeenCalledTimes(1); // nada a re-tentar
    expect(mockDeploy).not.toHaveBeenCalled();
    const reason = vi.mocked(mockRevert).mock.calls[0][2]?.reason ?? "";
    expect(reason).toContain("não aplicou limpo"); // a falha ORIGINAL, nunca substituída pela da escada
    expect(reason).toContain("SUBSTANTIVO"); // + o WHY por hunk: "diverge" virou "o hunk X é substantivo porque…"
    expect(reason).toContain("duas implementações diferentes");
    expect(reason).toContain("tudo-ou-nada"); // e o porquê de nem o hunk cosmético ter sido aplicado
  });

  it("o ENXERTO falhar ⇒ `stage` fica como estava, sem retry, e a falha original é reportada (nunca um stage meio-movido)", async () => {
    const cmds = releaseExec({ updateRefFails: true });
    judging(() => ({ hunks: [cosmetic], runId: "judge-3", resolvedRef: "resolve/abc" }));
    mockPromote.mockResolvedValue(APPLY_FAILED);

    await firePromoteAndDeploy("acme", "story-lad3");

    expect(cmds.some((c) => c.includes("update-ref"))).toBe(true); // tentou mover…
    expect(mockPromote).toHaveBeenCalledTimes(1); // …falhou ⇒ NÃO re-tenta sobre um stage que não mudou
    expect(mockDeploy).not.toHaveBeenCalled();
    const reason = vi.mocked(mockRevert).mock.calls[0][2]?.reason ?? "";
    expect(reason).toContain("não aplicou limpo");
    expect(reason).toContain("não foi possível levar a resolução para stage"); // o operador sabe o que houve
  });

  it("o juiz MORRER não derruba o release: sem ref move, sem retry, falha original + o sinal de saúde da escada", async () => {
    const cmds = releaseExec();
    judging(() => {
      throw new Error("spawn ENOENT");
    });
    mockPromote.mockResolvedValue(APPLY_FAILED);

    await firePromoteAndDeploy("acme", "story-lad4");

    expect(cmds.some((c) => c.includes("update-ref"))).toBe(false);
    expect(mockPromote).toHaveBeenCalledTimes(1);
    const reason = vi.mocked(mockRevert).mock.calls[0][2]?.reason ?? "";
    expect(reason).toContain("não aplicou limpo");
    expect(reason).toContain("o juiz falhou"); // distinto de "é ambíguo" — a escada quebrou, e isso se vê
  });

  it("uma falha SEM arquivos divergentes não chama o juiz — não há divergência de texto a julgar", async () => {
    const cmds = releaseExec();
    const requests = judging(() => ({ hunks: [cosmetic], runId: "judge-5", resolvedRef: "resolve/abc" }));
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "apply-failed", reason: "não aplicou limpo" }));

    await firePromoteAndDeploy("acme", "story-lad5");

    expect(requests).toEqual([]);
    expect(cmds).toEqual([]); // nem um git da escada
    expect(mockPromote).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mockRevert).mock.calls[0][2]?.reason).toBe("não aplicou limpo"); // relatório intacto
  });
});

// deploy-truth WS-3 (D-DT7) — fireDeployBoard arms the watchdog for EVERY card-triggered deploy (the card
// now WAITS in Publicando for the settle; a dead settle would strand it silently), and an UNDEPLOYABLE
// board (nothing fired, nothing ever will) gets an immediate evidence settle so a no-code card still
// terminates while a code card stays put with the watchdog armed. Over the mocked write/deploy seam.
describe("fireDeployBoard — deploy-truth: watchdog em todo disparo + settle imediato do não-deployável", () => {
  /** Applies every mutate updateCardOnDisk received to a blank card, returning the final shape. */
  const applyWrites = (base: Partial<Card> = {}): Card => {
    let c = { id: "s1", type: "story", status: "deploy", ...base } as unknown as Card;
    for (const call of vi.mocked(updateCardOnDisk).mock.calls) {
      const next = (call[2] as (x: Card) => Card | null)(c);
      if (next) c = next;
    }
    return c;
  };

  it("PRODUCT deploy fired + cardId ⇒ stamps deployFiredAt (not only the self-deploy settleArmed case)", async () => {
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "orch-deploy", pkg: "acmeapp" } as DeployResult);
    await fireDeployBoard("acme", "s1");
    expect(applyWrites().deployFiredAt).toBeTruthy();
    expect(vi.mocked(settleDeploySuccess)).not.toHaveBeenCalled(); // a real fire waits for its real settle
  });

  it("UNDEPLOYABLE board (fired:false, not inFlight) ⇒ stamps the watchdog AND runs the immediate evidence settle", async () => {
    mockDeploy.mockResolvedValueOnce({ fired: false, reason: "board sem `package` configurado — nada a deployar" } as DeployResult);
    await fireDeployBoard("acme", "s1");
    expect(applyWrites().deployFiredAt).toBeTruthy(); // a code card left waiting is escalated by the watchdog
    expect(vi.mocked(settleDeploySuccess)).toHaveBeenCalledWith("acme", "s1", { source: "reconcile-evidence" });
  });

  it("self-deploy COLLISION (inFlight) keeps the 1.5 parking path — no immediate settle, no fire stamp", async () => {
    mockDeploy.mockResolvedValueOnce({ fired: false, tool: "systemd-restart", inFlight: true, reason: "em curso" } as DeployResult);
    await fireDeployBoard("storymap", "s1");
    expect(vi.mocked(settleDeploySuccess)).not.toHaveBeenCalled(); // the in-flight deploy's settle re-dispatches it
    expect(applyWrites().deployFiredAt).toBeUndefined(); // the redispatch/fallback stamps later (existing 1.5 flow)
  });
});

// 1.5 — a 2nd self-deploy that collides with the fixed unit is parked; the in-flight deploy's settle
// re-dispatches it. redispatchPendingSelfDeploy runs at the settle over injected deps (no disk/systemd).
describe("redispatchPendingSelfDeploy — re-dispatch the parked self-deploy at the settle (1.5)", () => {
  it("no parked card → 'none', never fires nor stamps", async () => {
    const fire = vi.fn(async () => undefined);
    const stampUnsettled = vi.fn(async () => {});
    const out = await redispatchPendingSelfDeploy({ take: async () => null, fire, stampUnsettled });
    expect(out).toBe("none");
    expect(fire).not.toHaveBeenCalled();
    expect(stampUnsettled).not.toHaveBeenCalled();
  });

  it("parked card + re-fire SUCCEEDS → 'fired' (fireDeployBoard stamps its own deployFiredAt), no fallback stamp", async () => {
    const fire = vi.fn(async () => ({ fired: true, tool: "systemd-restart", settleArmed: true }) as DeployResult);
    const stampUnsettled = vi.fn(async () => {});
    const out = await redispatchPendingSelfDeploy({
      take: async () => ({ board: "storymap", cardId: "s1" }),
      fire,
      stampUnsettled,
    });
    expect(out).toBe("fired");
    expect(fire).toHaveBeenCalledWith("storymap", "s1");
    expect(stampUnsettled).not.toHaveBeenCalled();
  });

  it("parked card + re-fire STILL inFlight → 'requeued-unsettled' + stampUnsettled (watchdog covers)", async () => {
    const fire = vi.fn(async () => ({ fired: false, inFlight: true, tool: "systemd-restart" }) as DeployResult);
    const stampUnsettled = vi.fn(async () => {});
    const out = await redispatchPendingSelfDeploy({
      take: async () => ({ board: "storymap", cardId: "s1" }),
      fire,
      stampUnsettled,
    });
    expect(out).toBe("requeued-unsettled");
    expect(stampUnsettled).toHaveBeenCalledWith("storymap", "s1"); // no silent terminal
  });

  it("re-fire THROWS → still stamps unsettled (never a silent terminal)", async () => {
    const fire = vi.fn(async () => {
      throw new Error("boom");
    });
    const stampUnsettled = vi.fn(async () => {});
    const out = await redispatchPendingSelfDeploy({
      take: async () => ({ board: "storymap", cardId: "s1" }),
      fire,
      stampUnsettled,
    });
    expect(out).toBe("requeued-unsettled");
    expect(stampUnsettled).toHaveBeenCalled();
  });
});

// Deploy agnóstico (D-AG1/D-AG3) — fireDeployBoard threads the board's DECLARED descriptor (config.deploy)
// into deployBoard and, ONLY when one is declared, the card's releasedSha (the agent prompt's "which sha
// to publish"). A board without the block pays zero extra reads and routes byte-identically (legacy).
describe("fireDeployBoard — threads o descritor deploy do board (deploy-agnóstico)", () => {
  it("descritor declarado + card ⇒ deployBoard recebe boardDeploy e o releasedSha lido do card", async () => {
    mockReadBoardConfig.mockResolvedValueOnce({
      package: "packages/acmeapp",
      deploy: { kind: "agent", description: "publique via vercel" },
      statuses: [],
    } as never);
    vi.mocked(readCards).mockResolvedValue([{ id: "s9", type: "story", status: "deploy", releasedSha: "beef1234" } as never]);
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "deploy-agent", targets: ["acme"] } as DeployResult);

    await fireDeployBoard("acme", "s9");

    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        boardDeploy: { kind: "agent", description: "publique via vercel" },
        releasedSha: "beef1234",
      }),
    );
  });

  it("board SEM descritor ⇒ boardDeploy/releasedSha undefined — o roteamento legado segue byte-a-byte", async () => {
    mockReadBoardConfig.mockResolvedValueOnce({ package: "packages/acmeapp", statuses: [] } as never);
    vi.mocked(readCards).mockResolvedValue([]);
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "orch-deploy", pkg: "acmeapp" } as DeployResult);

    await fireDeployBoard("acme", "s1");

    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ boardDeploy: undefined, releasedSha: undefined }),
    );
  });
});
