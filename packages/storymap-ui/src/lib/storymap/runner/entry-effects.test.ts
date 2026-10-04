// story-ex0034 — INTEGRITY GATE for promote-and-deploy. A card must NEVER reach "No Ar" unless the staged
// code was ACTUALLY promoted to main AND the deploy did real work. Two chained bugs let it lie:
//   (1) fireReleaseStaged only console.log'd a no-op release (promoted:false) — it never propagated the
//       failure, so firePromoteAndDeploy fired the deploy + autoEnterTerminal claimed "No Ar" regardless.
//   (2) a diff-aware declared deploy command of un-promoted code exits 0 in ~0s (no drift) → ev.ok===true → the onDone
//       revert (which only fired on ev.ok===false) never ran.
// These tests drive firePromoteAndDeploy over a MOCKED release/deploy/revert seam and assert the gate:
// a real promotion FAILURE suppresses the deploy and REVERTS the card instead of shipping a lie.

import { afterEach, describe, expect, it, vi } from "vitest";

// Mock every collaborator of entry-effects so firePromoteAndDeploy runs without real git / deploy / disk.
vi.mock("./release", () => ({ promoteStageToMain: vi.fn() }));
vi.mock("./deploy", () => ({ deployBoard: vi.fn(async () => ({ fired: true, tool: "legacy-command", pkg: "acmeapp" })) }));
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
  // story-ex0025 — default: no other boards → empty exclusion set (leaves existing tests unaffected).
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
// WS-3 — the undeployable-board path dynamically imports the settle handler; mock it so the
// test observes the immediate evidence settle without touching git/fs (vitest intercepts dynamic imports).
vi.mock("./deploy-reconcile", () => ({ settleDeploySuccess: vi.fn(async () => null) }));
// O livro de recibos do train (landings.jsonl) — default vazio: nenhum teste antigo depende dele.
vi.mock("./landings", () => ({ readLandings: vi.fn(async () => []) }));

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
import { readLandings, type LandingReceipt } from "./landings";
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

describe("firePromoteAndDeploy — integrity gate: a failed release must NOT ship or claim No Ar (story-ex0034)", () => {
  it("SUPPRESSES the deploy and REVERTS the card when the release failed to promote (out-of-scope staged code)", async () => {
    // The acme incident: `stage` carried real code but under packages/acme-core/** — OUTSIDE the board's
    // scoped prefix (packages/acmeapp/) — so the scoped promote found 0 files → promoted:false, silently.
    // Today that no-op still fires the deploy and lets autoEnterTerminal declare "No Ar" with code stuck on stage.
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "out-of-scope", reason: "código staged fora do escopo do board" }));

    await firePromoteAndDeploy("acme", "story-ex0101");

    // GATE: a real promotion failure must NOT publish and must reverse the optimistic terminal.
    expect(mockDeploy).not.toHaveBeenCalled();
    expect(mockRevert).toHaveBeenCalledWith("acme", "story-ex0101", expect.objectContaining({ phase: "release" }));
  });

  it("SUPPRESSES + reverts when the staged code did not apply cleanly (apply-failed)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "apply-failed", reason: "não aplicou limpo" }));
    await firePromoteAndDeploy("acme", "story-ex0157");
    expect(mockDeploy).not.toHaveBeenCalled();
    expect(mockRevert).toHaveBeenCalledWith("acme", "story-ex0157", expect.objectContaining({ phase: "release" }));
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

// story-ex0071 — the deploy's face gate (touchesComposedFace) needs the list of files the release just
// promoted. firePromoteAndDeploy must THREAD that list from the promote result into deployBoard, so a board
// deploy can decide whether to ALSO publish the example.com merged web face. Driven over the MOCKED seam.
describe("firePromoteAndDeploy — threads the promoted diff to the deploy (story-ex0071)", () => {
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
describe("classifyRelease — legit no-op vs real promotion failure (story-ex0034)", () => {
  const result = (o: Partial<PromoteResult>): PromoteResult => ({ promoted: false, branch: "main", pushed: false, outcome: "nothing-staged", ...o }) as PromoteResult;

  it("promoted → deployable, expectWork, no revert", () => {
    expect(classifyRelease(result({ promoted: true, outcome: "promoted" }))).toMatchObject({ deployable: true, revert: false, expectWork: true });
  });

  it("story-ex0071: carries the promoted changedFiles through (defaulting to [] when absent)", () => {
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

// story-ex0121 — a board that LEGITIMATELY touches shared packages beyond its own (acme fixing code in
// packages/acme-shared/ or packages/acme-core/) declares them in BoardConfig.sharedPackages. The release
// must WIDEN its scoped codePrefixes to include those, so the shared-package delta is promoted stage→main
// instead of being detected as out-of-scope and reverted (the story-ex0034 revert path). This drives the
// derivation at the fireReleaseStaged seam over the MOCKED promote, asserting the pathspec it hands down.
describe("fireReleaseStaged — release scope includes BoardConfig.sharedPackages (story-ex0121)", () => {
  it("WIDENS codePrefixes to the board's own package PLUS its declared sharedPackages (normalized)", async () => {
    // Pass a MIX of trailing-slash / no-trailing-slash to prove the same normalization as `package`.
    mockReadBoardConfig.mockResolvedValueOnce({
      package: "packages/acmeapp",
      sharedPackages: ["packages/acme-core", "packages/acme-shared/"],
      statuses: [],
    } as never);
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted" }));

    await fireReleaseStaged("acme");

    // The scoped promote must look at ALL THREE prefixes (own + shared), each normalized with a trailing slash.
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({
        codePrefixes: ["packages/acmeapp/", "packages/acme-core/", "packages/acme-shared/"],
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

// story-ex0025 — CROSS-BOARD false-positive fix at the derivation seam. On the single shared `stage`, the
// out-of-scope probe must EXCLUDE every OTHER board's package (each promotes on its own frontier), so a board
// releasing with its own scoped diff empty is not reverted just because ANOTHER board (e.g. storymap-ui) left
// un-promoted code on stage. The releasing board's OWN package must NEVER be excluded (it still self-promotes).
describe("fireReleaseStaged — excludes OTHER boards' packages from the out-of-scope probe (story-ex0025)", () => {
  it("passes every OTHER board's package as otherBoardPrefixes, never the releasing board's own", async () => {
    // Call order is deterministic: fireReleaseStaged reads the RELEASING board's config first, then the helper
    // walks listBoards() and reads each OTHER board's config (skipping the releasing board itself).
    mockReadBoardConfig
      .mockResolvedValueOnce({ package: "packages/acmeapp", statuses: [] } as never) // releasing board (acme)
      .mockResolvedValueOnce({ package: "packages/storymap-ui", statuses: [] } as never) // other: storymap
      .mockResolvedValueOnce({ package: "packages/acme-core", statuses: [] } as never) // other: acme-core
      .mockResolvedValueOnce({ package: undefined, statuses: [] } as never); // other: entreposto — no package → omitted
    mockListBoards.mockResolvedValueOnce([
      { id: "storymap", name: "AgileHarness" },
      { id: "acme", name: "Armazem" },
      { id: "acme-core", name: "Galpao" },
      { id: "entreposto", name: "Balcao" },
    ] as never);
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "nothing-staged" }));

    await fireReleaseStaged("acme");

    const call = mockPromote.mock.calls[0][0] as { otherBoardPrefixes: string[] };
    // OTHER boards with a declared package are excluded (normalized to a trailing slash); entreposto (no package) omitted.
    expect(call.otherBoardPrefixes).toEqual(["packages/storymap-ui/", "packages/acme-core/"]);
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

// Lacuna observada: na RECUPERAÇÃO (card revertido p/ `release` por falha da
// face → humano reentra no Deploy), o promote devolve already-promoted com changedFiles VAZIO → o gate
// touchesComposedFace nunca re-armava a face — o card voltava a "No ar" com a face genuinamente quebrada.
// O re-entry agora DERIVA os arquivos do próprio card (git diff do commitRange durável) quando o promote
// não trouxe diff, então a face re-dispara na recuperação sem depender de um deploy manual.
describe("firePromoteAndDeploy — re-entry recovery deriva changedFiles do commitRange do card", () => {
  const cardWithRange = {
    id: "story-ex0130",
    type: "story",
    status: "deploy",
    commitRange: { base: "26e3db68", head: "1ff51746" },
  } as never;

  it("promote sem diff (already-promoted) + card com commitRange → deriva via git diff e re-arma a face", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([cardWithRange]);
    vi.mocked(defaultExec).mockResolvedValue({
      stdout: "packages/catalogo/web/src/lib/rotulos-vitrine.ts\npackages/catalogo/web/src/lib/__tests__/rotulos-vitrine.test.ts\n",
      stderr: "",
    });

    await firePromoteAndDeploy("acme", "story-ex0130");

    expect(vi.mocked(defaultExec)).toHaveBeenCalledWith(
      expect.stringContaining("git diff --name-only 26e3db68 1ff51746"),
      expect.anything(),
    );
    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: expect.arrayContaining(["packages/catalogo/web/src/lib/rotulos-vitrine.ts"]),
      }),
    );
  });

  it("promote COM diff → usa o diff do promote e NÃO consulta o commitRange (o caminho normal fica intacto)", async () => {
    mockPromote.mockResolvedValue(
      promoteResult({ promoted: true, commit: "abc", outcome: "promoted", changedFiles: ["packages/acmeapp/api/x.ts"] }),
    );
    vi.mocked(readCards).mockResolvedValue([cardWithRange]);

    await firePromoteAndDeploy("acme", "story-ex0130");

    expect(vi.mocked(defaultExec)).not.toHaveBeenCalled();
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: ["packages/acmeapp/api/x.ts"] }));
  });

  // Reescrito de propósito: o card daqui não tinha NENHUMA prova de código, e agora esse card nunca roda o deploy
  // do pacote (teste abaixo). O que este teste guarda — card COM código mas sem commitRange ⇒ lista vazia, sem git —
  // segue igual com um card que tem código staged.
  it("card sem commitRange → segue com lista vazia (comportamento anterior), sem git", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([{ id: "story-ex0130", type: "story", status: "deploy", stagedAt: "2026-07-09" } as never]);

    await firePromoteAndDeploy("acme", "story-ex0130");

    expect(vi.mocked(defaultExec)).not.toHaveBeenCalled();
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
  });

  // O `commitRange` é board-data: um intervalo que não é sha (ex.: `$(…)`) nunca chega ao shell do serviço.
  it("commitRange que não é sha → nenhum git roda e segue com lista vazia", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([{ id: "story-ex0130", type: "story", status: "deploy", commitRange: { base: "$(touch /tmp/x)", head: "1ff51746" } } as never]);

    await firePromoteAndDeploy("acme", "story-ex0130");

    expect(vi.mocked(defaultExec)).not.toHaveBeenCalled();
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ changedFiles: [] }));
  });

  it("falha do git na derivação → degrada para lista vazia (best-effort, nunca lança)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted" }));
    vi.mocked(readCards).mockResolvedValue([cardWithRange]);
    vi.mocked(defaultExec).mockRejectedValue(new Error("bad object"));

    await firePromoteAndDeploy("acme", "story-ex0130");

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
    // os outros cards e sessões (visto em produção: commits de mais de um pacote seriam perdidos).
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

// WS-3 (D-DT7) — fireDeployBoard arms the watchdog for EVERY card-triggered deploy (the card
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
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "legacy-command", pkg: "acmeapp" } as DeployResult);
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

  // Caso real: o 2º «Publicar» do mesmo board, com o deploy do 1º em curso, caía AQUI no ramo
  // «nada disparou» — settle imediato por evidência (que não prova card com código) e depois só o watchdog.
  it("CARONA no deploy em curso (inFlight + attached) ⇒ alvos + watchdog carimbados, SEM settle imediato — o desfecho do job o assenta", async () => {
    mockDeploy.mockResolvedValueOnce({
      fired: false,
      tool: "board-command",
      inFlight: true,
      attached: true,
      targets: ["acme"],
      reason: "deploy de acme já em andamento",
    } as DeployResult);
    await fireDeployBoard("acme", "s2");
    const c = applyWrites({ id: "s2" } as Partial<Card>);
    expect(c.deployTargets).toEqual(["acme"]); // a prova do card é medida contra o alvo do job em curso
    expect(c.deployFiredAt).toBeTruthy(); // e se o settle nunca vier, o watchdog escala (nunca silêncio)
    expect(vi.mocked(settleDeploySuccess)).not.toHaveBeenCalled();
  });

  it("a carona repassa ao deploy o `followUp` de quem re-despacha (anti-laço)", async () => {
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "board-command", targets: ["acme"] } as DeployResult);
    await fireDeployBoard("acme", "s2", { followUp: true });
    expect(mockDeploy).toHaveBeenCalledWith(expect.objectContaining({ board: "acme", cardId: "s2", followUp: true }));
  });

  it("self-deploy COLLISION (inFlight) keeps the 1.5 parking path — no immediate settle, no fire stamp", async () => {
    mockDeploy.mockResolvedValueOnce({ fired: false, tool: "systemd-restart", inFlight: true, reason: "em curso" } as DeployResult);
    await fireDeployBoard("storymap", "s1");
    expect(vi.mocked(settleDeploySuccess)).not.toHaveBeenCalled(); // the in-flight deploy's settle re-dispatches it
    expect(applyWrites().deployFiredAt).toBeUndefined(); // the redispatch/fallback stamps later (existing 1.5 flow)
  });
});

// O PREFLIGHT DE FRESCOR recusou o deploy (deploy-freshness.ts): NADA foi publicado. É uma FALHA de publicação
// — o card volta para Liberar pelo caminho de falha de deploy, com o motivo —, e NÃO o "nada disparou" de um
// board sem alvo: aquele caminho tenta o settle imediato, que avançaria um card sem código para "No ar".
describe("fireDeployBoard — recusa do preflight de frescor segue o caminho de FALHA de deploy", () => {
  const recusado = {
    fired: false,
    tool: "legacy-command",
    pkg: "acmeapp",
    reason: "deploy RECUSADO pelo preflight de frescor (nada foi executado) — 4 commit(s) ATRÁS de origin/main",
    freshnessRefused: { code: "behind", reason: "o checkout está 4 commit(s) ATRÁS de origin/main" },
  } as DeployResult;

  it("reverte o card com phase `freshness` e o motivo — sem settle imediato, sem carimbo de disparo", async () => {
    mockDeploy.mockResolvedValueOnce(recusado);
    await fireDeployBoard("acme", "s1");
    expect(mockRevert).toHaveBeenCalledWith("acme", "s1", {
      pkg: "acmeapp",
      phase: "freshness",
      reason: "o checkout está 4 commit(s) ATRÁS de origin/main",
    });
    expect(vi.mocked(settleDeploySuccess)).not.toHaveBeenCalled();
    expect(vi.mocked(updateCardOnDisk)).not.toHaveBeenCalled(); // nem deployFiredAt: nada foi disparado
  });

  it("o escopo do preflight é o da PROMOÇÃO do board (package + sharedPackages), threaded ao deployBoard", async () => {
    mockReadBoardConfig.mockResolvedValueOnce({
      package: "packages/acmeapp",
      sharedPackages: ["packages/acme-shared"],
      statuses: [],
    } as never);
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "legacy-command", pkg: "acmeapp" } as DeployResult);
    await fireDeployBoard("acme", "s1");
    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ deployScope: ["packages/acmeapp/", "packages/acme-shared/"] }),
    );
  });

  it("firePromoteAndDeploy: promoveu mas o deploy foi recusado ⇒ o retorno CARREGA a recusa (a fila não carimba `published`)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted" }));
    mockDeploy.mockResolvedValueOnce(recusado);
    const r = await firePromoteAndDeploy("acme", "story-fresh");
    expect(r.revert).toBe(false); // a promoção aterrissou…
    expect(r.deployRefused).toBe("o checkout está 4 commit(s) ATRÁS de origin/main"); // …e o deploy não rodou
    expect(mockRevert).toHaveBeenCalledWith("acme", "story-fresh", expect.objectContaining({ phase: "freshness" }));
  });
});

// O deploy RECUSADO antes de começar (descritor inválido, comando não
// autorizado, autorização do preflight recusada no registry) não é «disparado»: carimbar o watchdog faria o Inbox
// dizer «deploy disparado sem confirmação» 15 min depois — sobre um deploy que nunca existiu. O motivo vai para o
// card pelo relatório do efeito (entry-effect-report); o retorno o carrega.
describe("fireDeployBoard — recusa antes de começar não é «disparo» (B2)", () => {
  const applyWrites = (base: Partial<Card> = {}): Card => {
    let c = { id: "s1", type: "story", status: "deploy", ...base } as unknown as Card;
    for (const call of vi.mocked(updateCardOnDisk).mock.calls) {
      const next = (call[2] as (x: Card) => Card | null)(c);
      if (next) c = next;
    }
    return c;
  };
  const recusado = { fired: false, tool: "board-command", refused: "deploy.kind=command recusado — interpretador", reason: "deploy.kind=command recusado — interpretador" } as DeployResult;

  it("sem carimbo do watchdog; o settle por evidência ainda roda (um card SEM código segue em frente)", async () => {
    mockDeploy.mockResolvedValueOnce(recusado);
    const r = await fireDeployBoard("acme", "s1");
    expect(r?.refused).toBe(recusado.refused);
    expect(applyWrites().deployFiredAt).toBeUndefined();
    expect(vi.mocked(settleDeploySuccess)).toHaveBeenCalledWith("acme", "s1", { source: "reconcile-evidence" });
  });

  it("firePromoteAndDeploy: promoveu, mas o deploy nem começou ⇒ o retorno carrega o motivo (`deployNotStarted`)", async () => {
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, commit: "abc1234", outcome: "promoted" }));
    mockDeploy.mockResolvedValueOnce(recusado);
    const r = await firePromoteAndDeploy("acme", "story-r");
    expect(r.revert).toBe(false);
    expect(r.deployNotStarted).toBe(recusado.refused);
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
// O card que NÃO carrega código nunca espera o deploy do PACOTE: cards assim ficavam horas em «Liberar»
// carregando a recusa do código dos outros. E o card já parado cujas unidades estão no ar assenta sem re-rodar o deploy.
describe("card sem código / já no ar por unidade — assenta por evidência, sem o deploy do pacote", () => {
  it("sem código: nem promoção nem deploy; assenta por evidência", async () => {
    vi.mocked(readCards).mockResolvedValue([{ id: "story-ex0099", type: "story", status: "deploy" } as never]);
    const r = await firePromoteAndDeploy("acme", "story-ex0099");
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockDeploy).not.toHaveBeenCalled();
    expect(mockRevert).not.toHaveBeenCalled();
    expect(vi.mocked(settleDeploySuccess)).toHaveBeenCalledWith("acme", "story-ex0099", { source: "reconcile-evidence" });
    expect(r).toMatchObject({ revert: false, promoted: false });
    // e pelo efeito só-deploy também
    vi.clearAllMocks();
    vi.mocked(readCards).mockResolvedValue([{ id: "story-ex0099", type: "story", status: "deploy" } as never]);
    expect(await fireDeployBoard("acme", "story-ex0099")).toMatchObject({ fired: false, reason: expect.stringContaining("sem código") });
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it("recibo do train de código pousado conta como código (o stagedAt se perde): segue o caminho de sempre", async () => {
    vi.mocked(readCards).mockResolvedValue([{ id: "story-r", type: "story", status: "deploy" } as never]);
    vi.mocked(readLandings).mockResolvedValueOnce([{ board: "acme", cardId: "story-r", half: "code", sha: "abc", at: "t" } as unknown as LandingReceipt]);
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "legacy-command", pkg: "acmeapp" } as DeployResult);
    await fireDeployBoard("acme", "story-r");
    expect(mockDeploy).toHaveBeenCalledTimes(1);
  });

  it("card parado com escopo por unidade: provado no ar ⇒ assenta sem deploy; não provado ⇒ deploy normal", async () => {
    const scoped = {
      id: "story-u",
      type: "story",
      status: "deploy",
      stagedAt: "2026-10-01",
      findings: [{ id: "deploy-failure", status: "fixed", deployCause: { causeKey: "acme:system", driftUnits: ["edge-api"], headSha: "h" } }],
    };
    vi.mocked(readCards).mockResolvedValue([scoped as never]);
    vi.mocked(settleDeploySuccess).mockResolvedValueOnce({ advancedTo: "concluida" } as never);
    expect(await fireDeployBoard("acme", "story-u")).toMatchObject({ fired: false, reason: expect.stringContaining("já está no ar") });
    expect(mockDeploy).not.toHaveBeenCalled();
    vi.mocked(settleDeploySuccess).mockResolvedValueOnce({ advancedTo: null } as never);
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "legacy-command", pkg: "acmeapp" } as DeployResult);
    await fireDeployBoard("acme", "story-u");
    expect(mockDeploy).toHaveBeenCalledTimes(1);
  });
});

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
    mockDeploy.mockResolvedValueOnce({ fired: true, tool: "legacy-command", pkg: "acmeapp" } as DeployResult);

    await fireDeployBoard("acme", "s1");

    expect(mockDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ boardDeploy: undefined, releasedSha: undefined }),
    );
  });
});

// Defesa em profundidade do carimbo de release (caso real). O release só carimbava
// `releasedAt/releasedSha` em card com `stagedAt` — e o `stagedAt` de algumas stories do condutor tinha sido
// apagado pela metade de dados do train. Sem `releasedSha` o settle do deploy mede `codigo-sem-release` e o
// card fica em «Publicando» para sempre, embora o código esteja no ar. O RECIBO da metade de código
// (landings.jsonl, escrito pelo train no instante em que o código pousou em stage, com o sha) é prova durável
// do mesmo fato — e o release passa a aceitá-lo. Fail-closed: sem recibo e sem stagedAt, nada muda.
describe("fireReleaseStaged — o recibo durável da metade de código também prova que o card foi staged", () => {
  const receipt = (o: Partial<LandingReceipt>): LandingReceipt => ({
    v: 1,
    runId: "run-1",
    board: "acme",
    cardId: "s1",
    half: "code",
    ref: "stage",
    sha: "c0de5a1",
    at: "2027-01-14T11:32:08.417Z",
    ...o,
  });
  const stampedIds = () => vi.mocked(updateCardOnDisk).mock.calls.map((c) => c[1]);
  const stampOf = (cardId: string, card: Card) => {
    const call = vi.mocked(updateCardOnDisk).mock.calls.find((c) => c[1] === cardId);
    return (call?.[2] as (c: Card) => Card)(card);
  };
  const card = (o: Partial<Card>) => ({ type: "story", status: "release", ...o }) as Card;

  it("recibo de código SEM stagedAt ⇒ releasedAt + releasedSha carimbados", async () => {
    vi.mocked(readCards).mockResolvedValue([card({ id: "s1" })]);
    vi.mocked(readLandings).mockResolvedValueOnce([receipt({})]);
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, outcome: "promoted", commit: "abc1234", mainSha: "main5678" }));

    await fireReleaseStaged("acme");

    expect(stampedIds()).toEqual(["s1"]);
    const stamped = stampOf("s1", card({ id: "s1" }));
    expect(stamped.releasedSha).toBe("main5678");
    expect(stamped.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("sem recibo e sem stagedAt ⇒ NÃO carimba (fail-closed)", async () => {
    vi.mocked(readCards).mockResolvedValue([card({ id: "s1" })]);
    vi.mocked(readLandings).mockResolvedValueOnce([]);
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, outcome: "promoted", mainSha: "main5678" }));

    await fireReleaseStaged("acme");

    expect(stampedIds()).toEqual([]);
  });

  it("recibo que NÃO prova código não conta: metade VAZIA, metade de dados, outro board, outro card", async () => {
    vi.mocked(readCards).mockResolvedValue([card({ id: "s1" })]);
    vi.mocked(readLandings).mockResolvedValueOnce([
      receipt({ sha: null, empty: true }), // run só de board-data: nada foi staged
      receipt({ half: "data", ref: "main", sha: "da7a" }),
      receipt({ board: "other" }),
      receipt({ cardId: "s2" }),
    ]);
    mockPromote.mockResolvedValue(promoteResult({ promoted: true, outcome: "promoted", mainSha: "main5678" }));

    await fireReleaseStaged("acme");

    expect(stampedIds()).toEqual([]);
  });

  it("card JÁ liberado não é recarimbado, com ou sem recibo; stagedAt segue valendo sozinho", async () => {
    vi.mocked(readCards).mockResolvedValue([
      card({ id: "s1", releasedAt: "2027-01-10", releasedSha: "old1111" }),
      card({ id: "s3", stagedAt: "2027-01-14" }),
    ]);
    vi.mocked(readLandings).mockResolvedValueOnce([receipt({})]);
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "already-promoted", mainSha: "main5678" }));

    await fireReleaseStaged("acme");

    expect(stampedIds()).toEqual(["s3"]);
  });

  it("promoção que FALHOU não carimba nada, nem com recibo", async () => {
    vi.mocked(readCards).mockResolvedValue([card({ id: "s1" })]);
    vi.mocked(readLandings).mockResolvedValueOnce([receipt({})]);
    mockPromote.mockResolvedValue(promoteResult({ promoted: false, outcome: "apply-failed", reason: "não aplicou" }));

    await fireReleaseStaged("acme");

    expect(stampedIds()).toEqual([]);
  });
});
