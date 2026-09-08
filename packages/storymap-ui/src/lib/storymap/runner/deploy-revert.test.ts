import { describe, expect, it } from "vitest";
import {
  buildDeployFailureFinding,
  applyDeployFailureRevert,
  applyDeployFailureResolved,
  applyDeploySettleFailure,
  buildDeploySettledOutOfStatusFinding,
  DEPLOY_FAILURE_FINDING_ID,
  DEPLOY_OUT_OF_STATUS_FINDING_ID,
  isRevertableDeployTarget,
  deployRevertableStatusIds,
  DEPLOY_REVERT_DESTINATION,
} from "./deploy-revert";
import type { BoardConfig, Card } from "@/lib/storymap/types";

describe("deploy-revert — redeploy revert transform (P0/story-2p5zuy: deploy failure ≠ code fix)", () => {
  it("reverts to the redeploy human parada (release), NOT the build column (a deploy failure is not a code defect)", () => {
    expect(DEPLOY_REVERT_DESTINATION).toBe("release");
  });

  it("buildDeployFailureFinding produces a high (non-blocker) finding with pkg + exit + log + stable id, status open", () => {
    const f = buildDeployFailureFinding({ pkg: "acmeapp", exitCode: 2 }, "2026-06-21");
    expect(f.severity).toBe("high"); // operator alert, NOT blocker (must not gate anything)
    expect(f.severity).not.toBe("blocker");
    expect(f.status).toBe("open");
    expect(f.detail).toContain("exit 2");
    expect(f.detail).toContain("acmeapp");
    expect(f.detail).toContain("mcp-deploy-acmeapp.log"); // points the operator at the deploy log
    expect(f.id).toBeTruthy(); // stable id so a re-fired callback UPSERTS instead of stacking duplicates
  });

  it("buildDeployFailureFinding — release phase names the promotion failure (code stayed on stage)", () => {
    const f = buildDeployFailureFinding({ pkg: "acmeapp", phase: "release", reason: "no-op" }, "2026-06-21");
    expect(f.detail?.toLowerCase()).toContain("promo"); // promoção stage→main
  });

  it("buildDeployFailureFinding — face-stale: the canary caught a shipped-but-stale mosaico.app face (VERIFY seam)", () => {
    // The face deploy reported SUCCESS but mosaico.app still serves an old x-build-sha → the UI is not actually live.
    const f = buildDeployFailureFinding({ pkg: "mosaico-site", phase: "face-stale" }, "2026-06-21");
    expect(f.severity).toBe("high");
    expect(f.status).toBe("open");
    expect(f.detail?.toLowerCase()).toContain("face"); // names the mosaico.app face specifically
    expect(f.detail?.toLowerCase()).toMatch(/canary|x-build-sha|cdn|stale|não atualizou/); // the freshness signal
  });

  it("buildDeployFailureFinding — self-deploy: names the AgileHarness rebuild+restart failure and weaves in the logTail (WS1.1)", () => {
    const f = buildDeployFailureFinding({ phase: "self-deploy", logTail: "error: bun build failed\n  at foo.ts:3" }, "2026-07-09");
    expect(f.severity).toBe("high");
    expect(f.severity).not.toBe("blocker"); // an alert, never a gate
    expect(f.title.toLowerCase()).toContain("self-deploy");
    expect(f.detail).toContain("systemctl status storymap"); // points the operator at the service
    expect(f.detail).toContain("bun build failed"); // the forensic logTail rides along
  });

  it("applyDeployFailureRevert clears the deploy-unsettled watchdog stamp (deployFiredAt) on the reverted card (WS1.1)", () => {
    const card = { id: "s1", type: "story", status: "concluida", deployFiredAt: "2026-07-09T12:00:00Z" } as unknown as Card;
    const next = applyDeployFailureRevert(card, buildDeployFailureFinding({ phase: "self-deploy" }, "2026-07-09"), "release");
    expect(next.deployFiredAt).toBeUndefined(); // the deploy settled (albeit failed) → no phantom deploy-unsettled
  });

  it("applyDeployFailureRevert routes a story to the destination + appends the finding, and does NOT stamp mode:fix / bugReport / reopenPending", () => {
    const card = { id: "s1", type: "story", status: "concluida" } as Card;
    const f = buildDeployFailureFinding({ pkg: "acmeapp", exitCode: 1 }, "2026-06-21");
    const next = applyDeployFailureRevert(card, f, "release");
    expect(next.status).toBe("release");
    // the CORE of story-2p5zuy: a deploy failure must NOT reopen as a code fix (harness-fix would no-op forever)
    expect(next.mode).toBeUndefined();
    expect(next.bugReport).toBeFalsy();
    expect(next.reopenPending).toBeFalsy();
    expect(next.findings?.some((x) => x.id === f.id)).toBe(true);
  });

  it("applyDeployFailureRevert UPSERTS the finding by id — a re-fired callback refreshes, never duplicates", () => {
    const card = { id: "s1", type: "story", status: "concluida", findings: [] } as unknown as Card;
    const f = buildDeployFailureFinding({ pkg: "acmeapp", exitCode: 1 }, "2026-06-21");
    const once = applyDeployFailureRevert(card, f, "release");
    const twice = applyDeployFailureRevert(once, f, "release");
    expect(twice.findings?.filter((x) => x.id === f.id).length).toBe(1);
  });

  it("applyDeployFailureRevert leaves a NON-story untouched (only stories carry the revert)", () => {
    const card = { id: "o1", type: "idea", status: "concluida" } as Card;
    const next = applyDeployFailureRevert(card, buildDeployFailureFinding({}, "2026-06-21"), "release");
    expect(next).toBe(card);
  });
});

describe("isRevertableDeployTarget — idempotency guard (G1/G3)", () => {
  const terminal: ReadonlySet<string> = new Set(["concluida"]);

  it("true only for a STORY still sitting in a terminal status (the optimistic 'No ar')", () => {
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: "concluida" } as Card, terminal)).toBe(true);
  });

  it("false once the card already left terminal — a re-fired/late callback is a safe no-op (the core fix)", () => {
    // a prior revert already moved it to release, OR the human re-deployed → re-reverting would yank it back.
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: "release" } as Card, terminal)).toBe(false);
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: "qa-automatizado" } as Card, terminal)).toBe(false);
  });

  it("false for a non-story and for a card with no status", () => {
    expect(isRevertableDeployTarget({ id: "o", type: "idea", status: "concluida" } as Card, terminal)).toBe(false);
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: null } as Card, terminal)).toBe(false);
  });
});

describe("deployRevertableStatusIds — terminal ∪ optimistic autoEnterTerminal (closes the fast-failure race)", () => {
  const config = {
    statuses: [
      { id: "release", name: "Liberar" },
      { id: "deploy", name: "Publicar", autoEnterTerminal: true },
      { id: "concluida", name: "No ar", terminal: true },
      { id: "arquivados", name: "Arquivados", terminal: true },
    ],
  } as BoardConfig;

  it("includes terminal statuses AND the optimistic autoEnterTerminal step, but not ordinary steps", () => {
    const ids = deployRevertableStatusIds(config);
    expect(ids.has("concluida")).toBe(true); // the settled terminal ('No ar')
    expect(ids.has("deploy")).toBe(true); // the optimistic pre-terminal carrying the deploy
    expect(ids.has("arquivados")).toBe(true);
    expect(ids.has("release")).toBe(false); // an ordinary step is not a revert-FROM source
  });

  it("a STORY transiently in `deploy` IS revertable — a fast deploy failure that beat the deploy→concluida forward", () => {
    const ids = deployRevertableStatusIds(config);
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: "deploy" } as Card, ids)).toBe(true);
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: "concluida" } as Card, ids)).toBe(true);
    expect(isRevertableDeployTarget({ id: "s", type: "story", status: "release" } as Card, ids)).toBe(false);
  });
});

// deploy-truth WS-3 (D-DT3) — the deploy step no longer declares `autoEnterTerminal` in board.yaml: the
// card WAITS there ("Publicando") until the settle proves the publish. The revertable set must therefore
// derive the deploy step from its onEnter EFFECT (isDeployStep) — else a failed settle would find the
// waiting card "not revertable" and strand it mid-publish. Terminals stay in the set on purpose: an
// era-otimista card still in transit (advanced to "No ar" by the old optimistic forward) must keep
// reverting concluida → release when its late settle fails (the D-DT3 tolerance).
describe("deployRevertableStatusIds — deploy-truth: the settle-gated deploy step (onEnter) is revertable", () => {
  const newModelConfig = {
    statuses: [
      { id: "release", name: "Liberar" },
      { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" }, // NO autoEnterTerminal — the new wiring
      { id: "concluida", name: "No ar", gate: "hasDeployProof", terminal: true },
    ],
  } as BoardConfig;

  it("includes the deploy step via its onEnter effect (no autoEnterTerminal flag needed)", () => {
    const ids = deployRevertableStatusIds(newModelConfig);
    expect(ids.has("deploy")).toBe(true); // the waiting "Publicando" card reverts deploy → release
    expect(ids.has("concluida")).toBe(true); // era-otimista tolerance: terminal still reverts
    expect(ids.has("release")).toBe(false);
  });

  it("a failed settle reverts the WAITING card deploy → release (the primary WS-3 path)", () => {
    const ids = deployRevertableStatusIds(newModelConfig);
    const card = { id: "s", type: "story", status: "deploy", deployFiredAt: "2026-07-17T11:00:00Z" } as unknown as Card;
    expect(isRevertableDeployTarget(card, ids)).toBe(true);
    const next = applyDeployFailureRevert(card, buildDeployFailureFinding({ pkg: "acmeapp", exitCode: 1 }, "2026-07-17"), DEPLOY_REVERT_DESTINATION);
    expect(next.status).toBe("release");
    expect(next.deployFiredAt).toBeUndefined(); // settle (failed) clears the watchdog stamp
    expect(next.findings?.some((f) => f.id === DEPLOY_FAILURE_FINDING_ID)).toBe(true);
  });

  it("a `deploy-board` onEnter step is equally revertable (the effect class, not the id, decides)", () => {
    const cfg = {
      statuses: [
        { id: "publicar-x", name: "Publicar X", onEnter: "deploy-board" },
        { id: "fim", name: "Fim", terminal: true },
      ],
    } as BoardConfig;
    expect(deployRevertableStatusIds(cfg).has("publicar-x")).toBe(true);
  });
});

// 1.4 — a FAILED settle that lands with the card ALREADY out of a revertable status used to `return null`,
// skipping the write → deployFiredAt leaked and the `deploy-unsettled` demand went phantom forever. Now the
// stamp is ALWAYS cleared (status only reverted when applicable), so the demand resolves in any status.
describe("applyDeploySettleFailure — settle terminal always clears deployFiredAt (kills the phantom demand)", () => {
  const revertableIds: ReadonlySet<string> = new Set(["concluida", "deploy"]);
  const finding = buildDeployFailureFinding({ pkg: "storymap", phase: "self-deploy" }, "2026-07-10");
  const opts = (detail: Record<string, unknown> = {}) => ({
    revertableIds,
    finding,
    destination: "release",
    detail: detail as never,
    today: "2026-07-10",
  });

  it("revertable status → reverts to destination, clears deployFiredAt (reverted=true)", () => {
    const card = { id: "s1", type: "story", status: "concluida", deployFiredAt: "2026-07-10T00:00:00Z" } as unknown as Card;
    const r = applyDeploySettleFailure(card, opts({ exitCode: 1 }));
    expect(r.reverted).toBe(true);
    expect(r.clearedStamp).toBe(false);
    expect(r.next!.status).toBe("release");
    expect(r.next!.deployFiredAt).toBeUndefined();
  });

  it("NOT revertable but deployFiredAt set → clears the stamp, KEEPS the status, stamps an informative finding", () => {
    // the settle arrived after a human moved the card to `qa-automatizado`; the phantom demand must still clear
    const card = { id: "s1", type: "story", status: "qa-automatizado", deployFiredAt: "2026-07-10T00:00:00Z" } as unknown as Card;
    const r = applyDeploySettleFailure(card, opts({ exitCode: 2 }));
    expect(r.reverted).toBe(false);
    expect(r.clearedStamp).toBe(true);
    expect(r.next).not.toBeNull();
    expect(r.next!.status).toBe("qa-automatizado"); // status intact — a human move is never yanked back
    expect(r.next!.deployFiredAt).toBeUndefined(); // the leak is closed
    expect(r.next!.findings?.some((f) => f.id === DEPLOY_OUT_OF_STATUS_FINDING_ID)).toBe(true);
  });

  it("NOT revertable AND no deployFiredAt → true no-op (next=null, the write is skipped)", () => {
    const card = { id: "s1", type: "story", status: "qa-automatizado" } as Card;
    const r = applyDeploySettleFailure(card, opts());
    expect(r.next).toBeNull();
    expect(r.reverted).toBe(false);
    expect(r.clearedStamp).toBe(false);
  });

  it("buildDeploySettledOutOfStatusFinding is informative (medium, non-blocker, open) and names the old status", () => {
    const f = buildDeploySettledOutOfStatusFinding("qa-automatizado", { exitCode: 3, reason: "spawn concorrente" }, "2026-07-10");
    expect(f.severity).toBe("medium");
    expect(f.severity).not.toBe("blocker");
    expect(f.status).toBe("open");
    expect(f.detail).toContain("qa-automatizado");
    expect(f.detail).toContain("spawn concorrente");
  });
});

// Incidente 2026-07-09 (gap do story-g9kxo9): um re-deploy BEM-SUCEDIDO deixava o finding deploy-failure
// aberto para sempre — o card voltava a "No ar" carregando um alerta "deploy falhou" obsoleto (a classe
// "resíduo" já limpa à mão em omazmj/ny4v26). O settle ok agora resolve o finding (open → fixed).
describe("applyDeployFailureResolved — settle ok resolve o finding deploy-failure (residuo)", () => {
  const openFinding = () => buildDeployFailureFinding({ pkg: "mosaico-site", exitCode: 1 }, "2026-07-08");

  it("marca o finding deploy-failure aberto como fixed, preservando os demais findings", () => {
    const other = { id: "gate-x", lens: "testing", severity: "blocker", title: "t", status: "open" };
    const card = { id: "s1", type: "story", status: "concluida", findings: [openFinding(), other] } as unknown as Card;
    const next = applyDeployFailureResolved(card);
    expect(next).not.toBeNull();
    expect(next!.findings!.find((f) => f.id === DEPLOY_FAILURE_FINDING_ID)!.status).toBe("fixed");
    expect(next!.findings!.find((f) => f.id === "gate-x")!.status).toBe("open"); // não toca findings alheios
  });

  it("retorna null (sem write) quando não há finding deploy-failure aberto — loop-safe no fs-watcher", () => {
    const card = { id: "s1", type: "story", status: "concluida" } as Card;
    expect(applyDeployFailureResolved(card)).toBeNull();
    const resolved = { ...openFinding(), status: "fixed" };
    const card2 = { id: "s2", type: "story", status: "concluida", findings: [resolved] } as unknown as Card;
    expect(applyDeployFailureResolved(card2)).toBeNull();
  });

  it("WS1.1 — limpa o stamp deploy-unsettled (deployFiredAt) num settle ok, MESMO sem finding obsoleto", () => {
    const card = { id: "s1", type: "story", status: "concluida", deployFiredAt: "2026-07-09T12:00:00Z" } as unknown as Card;
    const next = applyDeployFailureResolved(card);
    expect(next).not.toBeNull(); // não pula o write: há o stamp a limpar
    expect(next!.deployFiredAt).toBeUndefined();
  });

  it("WS1.1 — limpa deployFiredAt E resolve o finding juntos quando ambos presentes", () => {
    const card = { id: "s1", type: "story", status: "concluida", deployFiredAt: "2026-07-09T12:00:00Z", findings: [openFinding()] } as unknown as Card;
    const next = applyDeployFailureResolved(card);
    expect(next!.deployFiredAt).toBeUndefined();
    expect(next!.findings!.find((f) => f.id === DEPLOY_FAILURE_FINDING_ID)!.status).toBe("fixed");
  });
});
