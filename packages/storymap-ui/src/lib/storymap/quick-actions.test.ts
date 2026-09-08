import { describe, expect, it } from "vitest";
import {
  QUICK_ACTIONS_OF,
  quickActionsFor,
  cardNextAction,
  mergeEntryDemand,
  blockedTargets,
  runRetryLabel,
  prettyCanonicalArgs,
  SENSITIVE_AUDIT_CLASSES,
  type QuickAction,
} from "./quick-actions";
import { moveTargets } from "./move-targets";
import { acceptRoute } from "./triage/parse";
import { evaluateGate } from "./gates";
import { RISK_CLASSES } from "./types";
import type { BoardConfig, Card, CardType, StatusDef } from "./types";
import type { CockpitItem, CockpitItemKind } from "./demands";

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
const BASE_CARD = {
  id: "c1",
  type: "story" as CardType,
  title: "T",
  storyType: "user",
  status: null,
  parent: null,
  release: null,
  personas: [],
  systems: [],
  links: [],
  narrative: { role: "", want: "", soThat: "" },
  acceptance: [],
  tasks: [],
  rice: {},
  kano: null,
  funnelStage: null,
  findings: [],
  order: 10,
  created: null,
  updated: null,
  body: "",
} as unknown as Card;

const mkCard = (over: Partial<Card> = {}): Card => ({ ...BASE_CARD, ...over });
const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
const mkConfig = (statuses: StatusDef[]): BoardConfig => ({ id: "storymap", name: "AgileHarness", statuses }) as BoardConfig;
const mkItem = (kind: string, over: Record<string, unknown> = {}): CockpitItem =>
  ({ id: `c1:${kind}`, boardId: "storymap", cardId: "c1", cardTitle: "T", status: "s", lane: "travado", severity: "high", kind, ...over }) as CockpitItem;

const KIND_OVERRIDES: Record<CockpitItemKind, Record<string, unknown>> = {
  question: { id: "c1:q:q1", lane: "pergunta", questionId: "q1", prompt: "?", options: [], mode: "single" },
  blocker: { findingId: "f1", title: "Blk" },
  finding: { id: "c1:f:f2", lane: "pergunta", severity: "medium", findingId: "f2", title: "Aviso", findingSeverity: "medium" },
  "deploy-failed": { findingId: "deploy-failure", title: "D" },
  gate: { lane: "aprovar", gateLabel: "Aprovar" },
  approval: { id: "apr:a1", lane: "aprovar", gateLabel: "Jido pede" },
  review: { lane: "pergunta", severity: "medium" },
  stuck: { trigger: "harness-do", outcome: "error" },
  conflict: { runId: "r1", conflictKind: "merge-conflict" },
  proposal: { lane: "aprovar", summary: "", items: [], rounds: 0 },
  design: { lane: "aprovar", journey: null, options: [], chosenId: null },
  governance: { id: "gov:d1", lane: "aprovar", draftId: "d1", changes: [], reason: "r", conflicts: [] },
  "deploy-unsettled": { deployFiredAt: "2026-01-01T00:00:00Z" },
  "release-aging": { stagedAt: "2026-01-01", ageDays: 3 },
  "merge-failed": { runId: "r1", branch: "run/r1", failureReason: "boom" },
};

const ALL_KINDS: CockpitItemKind[] = [
  "question", "blocker", "finding", "deploy-failed", "gate", "approval", "review", "stuck", "conflict", "proposal", "design", "governance",
  "deploy-unsettled", "release-aging", "merge-failed",
];

const deployCfg = mkConfig([st("release", "Publicar", { onEnter: "promote-and-deploy" }), st("live", "No ar", { terminal: true })]);
const simpleCfg = mkConfig([st("todo", "A fazer", { autorun: false }), st("next", "Próximo"), st("done", "Concluída", { terminal: true })]);

function assertAction(a: QuickAction | null) {
  if (a === null) return;
  expect(typeof a.id).toBe("string");
  expect(typeof a.label).toBe("string");
  expect(["primary", "neutral", "danger"]).toContain(a.tone);
  expect(RISK_CLASSES).toContain(a.auditCls);
  expect(a.invoke).toBeTruthy();
  expect(typeof a.invoke.kind).toBe("string");
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────
describe("QUICK_ACTIONS_OF", () => {
  it("covers exactly the 14 real CockpitItemKinds and yields well-formed sets", () => {
    expect(Object.keys(QUICK_ACTIONS_OF).sort()).toEqual([...ALL_KINDS].sort());
    for (const kind of ALL_KINDS) {
      const set = quickActionsFor(mkItem(kind, KIND_OVERRIDES[kind]), deployCfg, mkCard({ id: "c1", status: "release" }));
      assertAction(set.primary);
      expect(Array.isArray(set.secondary)).toBe(true);
      set.secondary.forEach(assertAction);
      // every kind can be handed to the copiloto (D4) — escalate is always present in WS-0.
      expect(set.escalate).not.toBeNull();
      assertAction(set.escalate);
      expect(set.escalate?.invoke.kind).toBe("escalate");
    }
  });
});

describe("happy = canonical next step (D3)", () => {
  it("a gate item advances to moveTargets(...).find(recommended)", () => {
    const card = mkCard({ id: "c1", status: "todo" });
    const rec = moveTargets(card, simpleCfg).find((t) => t.recommended);
    expect(rec?.status.id).toBe("next");
    const set = quickActionsFor(mkItem("gate", { gateLabel: "Aprovar" }), simpleCfg, card);
    expect(set.primary?.invoke).toMatchObject({ kind: "move-card", status: rec!.status.id });
  });

  it("cardNextAction with no demand on a manual step advances to the same recommended step", () => {
    const card = mkCard({ id: "c1", status: "todo" });
    const rec = moveTargets(card, simpleCfg).find((t) => t.recommended);
    const set = cardNextAction(card, simpleCfg, null, null);
    expect(set?.primary?.invoke).toMatchObject({ kind: "move-card", status: rec!.status.id });
    expect(set?.escalate).toBeNull(); // happy path → no escalate
  });
});

describe("danger where it destroys / deploys", () => {
  it("merge conflict abort + gate abort are danger + confirm + merge-resolve", () => {
    const conflict = quickActionsFor(mkItem("conflict", { runId: "r1", conflictKind: "merge-conflict" }), simpleCfg);
    expect(conflict.secondary[0]).toMatchObject({ tone: "danger", auditCls: "merge-resolve" });
    expect(conflict.secondary[0].confirm).toBeTruthy();
    expect(conflict.secondary[0].invoke).toMatchObject({ kind: "resolve-merge", action: "aborted" });

    const gate = quickActionsFor(mkItem("conflict", { runId: "r1", conflictKind: "merge-gate-failed" }), simpleCfg);
    expect(gate.secondary[0]).toMatchObject({ tone: "danger", auditCls: "merge-resolve" });
    expect(gate.secondary[0].invoke).toMatchObject({ kind: "resolve-gate", action: "abort" });
  });

  it("a move-card whose target has onEnter is danger + confirm + deploy", () => {
    const onEnterCfg = mkConfig([st("pre", "Pré", { autorun: false }), st("deploy", "Deploy", { onEnter: "promote-and-deploy" }), st("done", "Done", { terminal: true })]);
    const card = mkCard({ id: "c1", status: "pre" });
    expect(moveTargets(card, onEnterCfg).find((t) => t.recommended)?.status.id).toBe("deploy");
    const set = quickActionsFor(mkItem("gate", { gateLabel: "x" }), onEnterCfg, card);
    expect(set.primary).toMatchObject({ tone: "danger", auditCls: "deploy" });
    expect(set.primary?.confirm).toBeTruthy();
  });

  it("deploy-failed re-publish is danger + confirm + deploy", () => {
    const set = quickActionsFor(mkItem("deploy-failed", {}), deployCfg, mkCard({ id: "c1", status: "release" }));
    expect(set.primary).toMatchObject({ tone: "danger", auditCls: "deploy" });
    expect(set.primary?.confirm).toBeTruthy();
    expect(set.primary?.invoke).toMatchObject({ kind: "move-card", status: "release" });
  });

  it("SENSITIVE_AUDIT_CLASSES is exactly {run, merge-resolve, deploy, destructive}", () => {
    expect([...SENSITIVE_AUDIT_CLASSES].sort()).toEqual(["deploy", "destructive", "merge-resolve", "run"]);
  });
});

describe("risk 5 — re-publish is a real deploy", () => {
  it("disables the primary while a deploy is in flight (deployFiredAt) and enables it otherwise", () => {
    const fired = quickActionsFor(mkItem("deploy-failed", {}), deployCfg, mkCard({ id: "c1", deployFiredAt: "2026-01-01T00:00:00Z" }));
    expect(fired.primary?.disabled).toBeTruthy();
    const idle = quickActionsFor(mkItem("deploy-failed", {}), deployCfg, mkCard({ id: "c1" }));
    expect(idle.primary?.disabled).toBeUndefined();
  });

  it("has no primary when the board has no promote-and-deploy step", () => {
    const set = quickActionsFor(mkItem("deploy-failed", {}), simpleCfg, mkCard({ id: "c1" }));
    expect(set.primary).toBeNull();
  });
});

describe("D15 — run-death failureClass becomes UX", () => {
  it("runRetryLabel routes infra→resolve, app/test→escalate, undefined→plain", () => {
    expect(runRetryLabel("infra").hint).toMatch(/resolver/);
    expect(runRetryLabel("app").hint).toMatch(/escalar/);
    expect(runRetryLabel("test").hint).toMatch(/escalar/);
    expect(runRetryLabel(undefined).hint).toBeUndefined();
  });

  it("a stuck card with an infra run-death finding propagates the hint to the retry primary", () => {
    const card = mkCard({ id: "c1", findings: [{ id: "run-death", lens: "general", severity: "high", title: "x", status: "open", failureClass: "infra" }] });
    const set = quickActionsFor(mkItem("stuck", { trigger: "harness-do", outcome: "error" }), simpleCfg, card);
    expect(set.primary?.hint).toBe("infra: retry deve resolver");
    expect(set.primary?.invoke.kind).toBe("run-skill");
  });
});

describe("§3.3 — gate.secondary Devolver (nearest eligible previous step)", () => {
  it("no previous step at the FIRST status → no Devolver", () => {
    const card = mkCard({ id: "c1", status: "todo" });
    const set = quickActionsFor(mkItem("gate", { gateLabel: "Aprovar" }), simpleCfg, card);
    expect(set.secondary).toEqual([]);
  });

  it("offers Devolver to the closest ELIGIBLE previous step, confirm + write-board", () => {
    const cfg = mkConfig([st("a", "A"), st("b", "B"), st("c", "C"), st("d", "D")]);
    const card = mkCard({ id: "c1", status: "c" });
    const set = quickActionsFor(mkItem("gate", { gateLabel: "Aprovar" }), cfg, card);
    const devolver = set.secondary.find((a) => a.id === "move-card:devolver");
    expect(devolver).toBeTruthy();
    expect(devolver).toMatchObject({ tone: "neutral", auditCls: "write-board" });
    expect(devolver?.confirm).toBeTruthy();
    expect(devolver?.invoke).toMatchObject({ kind: "move-card", status: "b" });
  });

  it("skips a step whose gate FAILS when picking the previous target", () => {
    const cfg = mkConfig([st("a", "A"), st("b", "B", { gate: "hasTasks" }), st("c", "C")]);
    const card = mkCard({ id: "c1", status: "c", tasks: [] }); // fails hasTasks at "b"
    const set = quickActionsFor(mkItem("gate", { gateLabel: "Aprovar" }), cfg, card);
    const devolver = set.secondary.find((a) => a.id === "move-card:devolver");
    expect(devolver?.invoke).toMatchObject({ kind: "move-card", status: "a" });
  });
});

describe("prettyCanonicalArgs (D12 — fim da aprovação às cegas)", () => {
  it("pretty-prints valid canonical JSON", () => {
    expect(prettyCanonicalArgs('{"a":1,"b":"x"}')).toBe(JSON.stringify({ a: 1, b: "x" }, null, 2));
  });

  it("falls back to the raw string on invalid/truncated JSON — never throws", () => {
    const truncated = '{"a":1,"b":"trunca';
    expect(() => prettyCanonicalArgs(truncated)).not.toThrow();
    expect(prettyCanonicalArgs(truncated)).toBe(truncated);
  });
});

describe("mergeEntryDemand + blockedTargets", () => {
  it("synthesizes a merge-conflict Demand with runId, and null for a non-parked entry", () => {
    const card = { id: "c1", title: "T", status: "s" };
    expect(mergeEntryDemand({ runId: "r1", status: "conflict", board: "storymap", cardId: "c1" }, card)).toMatchObject({ type: "merge-conflict", runId: "r1" });
    expect(mergeEntryDemand({ runId: "r1", status: "waiting", board: "storymap", cardId: "c1" }, card)).toBeNull();
  });

  it("blockedTargets is the exact complement of moveTargets over the same checkGate", () => {
    const cfg = mkConfig([st("cur", "Cur"), st("gated", "Gated", { gate: "hasTasks" }), st("free", "Free")]);
    const card = mkCard({ id: "c1", status: "cur", tasks: [] }); // fails hasTasks
    const bts = blockedTargets(card, cfg);
    expect(bts.map((b) => b.status.id)).toEqual(["gated"]);
    const verdict = evaluateGate(card, "gated", cfg)!;
    expect(bts[0].gateLabel).toBe(verdict.label);
    expect(bts[0].message).toBe(verdict.message);

    const moveable = new Set(moveTargets(card, cfg).map((t) => t.status.id));
    const blocked = new Set(bts.map((b) => b.status.id));
    // disjoint, and their union is exactly config.statuses minus the current one.
    expect([...moveable].filter((id) => blocked.has(id))).toEqual([]);
    expect([...new Set([...moveable, ...blocked])].sort()).toEqual(["free", "gated"]);
  });
});

describe("quick-actions — `finding` (aviso): o desfecho que faltava", () => {
  const item = mkItem("finding", KIND_OVERRIDES.finding);

  it("primário é `acknowledged` — o estado que existia no tipo e nenhuma superfície escrevia", () => {
    const qa = quickActionsFor(item, simpleCfg);
    expect(qa.primary?.invoke).toMatchObject({ kind: "update-finding", findingId: "f2", status: "acknowledged" });
    // …e os outros dois desfechos seguem alcançáveis
    expect(qa.secondary.map((a) => (a.invoke as { status?: string }).status)).toEqual(["fixed", "wontfix"]);
  });

  it("NENHUMA ação de aviso confirma — confirmar mentiria: um aviso não gateia nada", () => {
    // O confirm do blocker diz "o card avança sem o conserto". Num aviso isso é FALSO — ele nunca segurou o
    // card. É a assimetria que separa os dois kinds; se um dia um aviso ganhar confirm, o texto tem de mudar.
    const qa = quickActionsFor(item, simpleCfg);
    for (const a of [qa.primary, ...qa.secondary]) expect(a?.confirm).toBeUndefined();
    // contraste: o wontfix do BLOCKER confirma, porque ele destrava o gate de verdade.
    const blk = quickActionsFor(mkItem("blocker", KIND_OVERRIDES.blocker), simpleCfg);
    expect(blk.secondary.find((a) => a.id === "update-finding:wontfix")?.confirm).toBeTruthy();
  });

  it("todo desfecho é `write-board` e nomeia o finding — o ato é triar, não mover card", () => {
    const qa = quickActionsFor(item, simpleCfg);
    for (const a of [qa.primary!, ...qa.secondary]) {
      expect(a.auditCls).toBe("write-board");
      expect(a.invoke.kind).toBe("update-finding");
    }
  });
});

describe("quick-actions — `review` (triagem de baixa confiança): as duas saídas, de 1 clique", () => {
  // O board de quarentena: um passo `staging` (a Triagem) + as raias de destino do acceptRoute.
  const triageCfg = mkConfig([
    st("triage", "Triagem", { staging: true }),
    st("corrigir", "Corrigir"),
    st("refinar", "Refinar"),
    st("interview", "Entrevista"),
    st("enriquecer", "Enriquecer"),
  ]);
  const reviewItem = mkItem("review", KIND_OVERRIDES.review);

  it("aceitar leva para a raia que o TIPO do card pede, e o destino vai no botão", () => {
    // bug → Corrigir · melhoria (mode refine) → Refinar · user story → Entrevista · resto → Enriquecer
    const cases: [Partial<Card>, string, string][] = [
      [{ storyType: "bug" }, "corrigir", "Corrigir"],
      [{ mode: "refine" }, "refinar", "Refinar"],
      [{ storyType: "user" }, "interview", "Entrevista"],
      [{ storyType: "chore" }, "enriquecer", "Enriquecer"],
    ];
    for (const [over, statusId, name] of cases) {
      const card = mkCard({ id: "c1", status: "triage", ...over });
      const qa = quickActionsFor(reviewItem, triageCfg, card);
      expect(qa.primary?.invoke).toMatchObject({ kind: "accept-triage", cardId: "c1" });
      expect(qa.primary?.destination).toBe(name);
      // o destino do rótulo é o MESMO que o servidor aplicaria (uma régua só)
      expect(acceptRoute(card)).toBe(statusId);
    }
  });

  it("descartar é destrutivo, confirma e nomeia o card — a recusa também é de 1 clique", () => {
    const qa = quickActionsFor(reviewItem, triageCfg, mkCard({ id: "c1", status: "triage", storyType: "bug" }));
    const discard = qa.secondary.find((a) => a.id === "delete-card");
    expect(discard).toMatchObject({ tone: "danger", auditCls: "destructive" });
    expect(discard?.confirm?.body).toContain("lixeira");
    expect(discard?.invoke).toMatchObject({ kind: "delete-card", cardId: "c1" });
  });

  it("fora da quarentena NÃO oferece aceitar — o servidor recusaria, e um botão que falha é pior que nenhum", () => {
    const qa = quickActionsFor(reviewItem, triageCfg, mkCard({ id: "c1", status: "refinar", storyType: "bug" }));
    expect(qa.primary).toBeNull();
    // …e a saída degradada continua sendo o link para o Inbox (nunca um beco sem ação)
    expect(qa.secondary.map((a) => a.id)).toEqual(["link:inbox"]);
  });

  it("sem card em contexto degrada para o link, jamais para um aceite às cegas", () => {
    const qa = quickActionsFor(reviewItem, triageCfg);
    expect(qa.primary).toBeNull();
    expect(qa.secondary[0]?.invoke.kind).toBe("link");
  });
});
