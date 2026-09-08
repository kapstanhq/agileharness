import { describe, expect, it } from "vitest";
import { AUTONOMO_ACTIONABLE_KINDS, boardCardDemands, cardCockpitItems, cardDemands, COCKPIT_GROUP_OF, COCKPIT_GROUP_ORDER, conflictItemsFromSnapshot, COPILOT_ACTIONABLE_KINDS, copilotActionableKinds, dedupeCaptureLanes, DEPLOY_FAILURE_FINDING_ID, hasDemand, hasProducedWork, isCopilotActionable, mergeFailedItemsFromSnapshot, stuckItemsFromFailures, supersedeDeliveryFindingsOnReentry } from "./demands";
import type { CockpitItem, CockpitItemKind, ProposalCockpitItem } from "./demands";
import { coerceCard } from "./repo";
import type { BoardConfig, Card } from "./types";
import type { MergeQueueEntry, MergeQueueSnapshot, MergeQueueStatus } from "./runner/types";

const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true }, // autorun undefined → human gate
    { id: "grill", name: "Dúvidas", trigger: "harness-grill", autorun: true }, // auto → no gate
    { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true },
    { id: "revisao", name: "Aprovar entrega", autorun: false }, // human gate
    { id: "stage", name: "Integrar", autorun: true }, // WS1.5: publish-resting step (autorun)
    { id: "release", name: "Liberar", autorun: false }, // WS1.5: publish-resting step (manual)
    { id: "descontinuar", name: "Descontinuar", trigger: "harness-retire", autorun: true, hidden: true }, // ql5mjm: autorun + hidden
    { id: "concluida", name: "No ar", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (fields: Record<string, unknown>): Card => coerceCard("story-x", { type: "story", ...fields }, "");
const q = (id: string, status: "open" | "answered", askedAt = "2026-06-13") => ({
  id, text: `q ${id}`, askedBy: "harness-grill", askedAt, status,
  ...(status === "answered" ? { answer: "x", answeredAt: askedAt } : {}),
});
const finding = (id: string, severity: string, status: string) => ({ id, lens: "general", severity, title: `f ${id}`, status });

// ── WS-5 (D9) — the 3 new cockpit kinds (clock injected; timing fields overridden POST-coerce so they keep
// full ISO precision — coerceCard day-truncates stagedAt). ────────────────────────────────────────────────
describe("WS-5 — deploy-unsettled / release-aging per-card cockpit items", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const cardWith = (status: string, over: Partial<Card>): Card => ({ ...card({ status }), ...over });

  it("deploy-unsettled: present at 20min, absent at 5min, SURVIVES the terminal guard", () => {
    const late = cardCockpitItems(cardWith("concluida", { deployFiredAt: iso(20 * 60_000) }), config, "b", { now: NOW });
    expect(late.find((i) => i.kind === "deploy-unsettled")).toBeTruthy(); // pushed before the def.terminal early-return
    const fresh = cardCockpitItems(cardWith("concluida", { deployFiredAt: iso(5 * 60_000) }), config, "b", { now: NOW });
    expect(fresh.find((i) => i.kind === "deploy-unsettled")).toBeUndefined();
  });

  it("release-aging: medium at 25h, high at 73h, absent outside stage/release or once released", () => {
    const at25 = cardCockpitItems(cardWith("release", { stagedAt: iso(25 * 3_600_000), releasedAt: undefined }), config, "b", { now: NOW });
    expect(at25.find((i) => i.kind === "release-aging")).toMatchObject({ severity: "medium" });
    const at73 = cardCockpitItems(cardWith("release", { stagedAt: iso(73 * 3_600_000), releasedAt: undefined }), config, "b", { now: NOW });
    expect(at73.find((i) => i.kind === "release-aging")).toMatchObject({ severity: "high" });
    const released = cardCockpitItems(cardWith("release", { stagedAt: iso(99 * 3_600_000), releasedAt: "2026-07-14" }), config, "b", { now: NOW });
    expect(released.find((i) => i.kind === "release-aging")).toBeUndefined();
    const notStage = cardCockpitItems(cardWith("grill", { stagedAt: iso(99 * 3_600_000), releasedAt: undefined }), config, "b", { now: NOW });
    expect(notStage.find((i) => i.kind === "release-aging")).toBeUndefined();
  });
});

// ── deploy-truth (D-DT7) — the deploy-unsettled watchdog now PRIMARILY covers a card STUCK in the deploy
// step ("Publicando", where the card WAITS for the settle since the terminal became settle-gated), while
// KEEPING the historical detection (an era-otimista card that reached a terminal with the stamp
// un-cleared). The predicate is status-independent; only the LABEL distinguishes the two cases. ─────────
describe("deploy-truth (D-DT7) — deploy-unsettled: card preso em Publicando × card terminal histórico", () => {
  const NOW = Date.parse("2026-07-17T12:00:00Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const cfg: BoardConfig = {
    id: "b",
    name: "B",
    statuses: [
      { id: "release", name: "Liberar", autorun: false },
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", terminal: true },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  };

  it("card PRESO em deploy com deployFiredAt velho dispara a demanda, com o label nomeando Publicando (teste 6)", () => {
    const c = { ...card({ status: "deploy" }), deployFiredAt: iso(20 * 60_000) };
    const d = cardDemands(c, cfg, "b", { now: NOW }).find((x) => x.type === "deploy-unsettled");
    expect(d).toBeTruthy();
    expect(d!.label).toMatch(/Publicando/);
    // e o gêmeo do cockpit emite o item também (as duas derivações nunca divergem)
    expect(cardCockpitItems(c, cfg, "b", { now: NOW }).some((i) => i.kind === "deploy-unsettled")).toBe(true);
  });

  it("detecção HISTÓRICA preservada: card TERMINAL com o stamp não-limpo ainda dispara (era otimista em trânsito)", () => {
    const c = { ...card({ status: "concluida" }), deployFiredAt: iso(20 * 60_000) };
    const d = cardDemands(c, cfg, "b", { now: NOW }).find((x) => x.type === "deploy-unsettled");
    expect(d).toBeTruthy();
    expect(d!.label).not.toMatch(/Publicando/); // o label histórico — outro fix se aplica
  });

  it("dentro do SLA (5min) não dispara em nenhum dos dois casos", () => {
    const fresh = { ...card({ status: "deploy" }), deployFiredAt: iso(5 * 60_000) };
    expect(cardDemands(fresh, cfg, "b", { now: NOW }).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });
});

describe("WS-5 — mergeFailedItemsFromSnapshot (latest-per-card, failed only)", () => {
  const cardsById = new Map<string, Pick<Card, "id" | "title" | "status">>([
    ["c1", { id: "c1", title: "C1", status: "revisao" }],
    ["c2", { id: "c2", title: "C2", status: "concluida" }], // terminal
  ]);
  const cfg = { statuses: config.statuses };
  const entry = (over: Partial<MergeQueueEntry> & { runId: string; cardId: string; status: MergeQueueStatus }): MergeQueueEntry =>
    ({ board: "b", branch: `run/${over.runId}`, enqueuedAt: 1, ...over }) as MergeQueueEntry;

  it("emits one item for a card whose LATEST entry is failed", () => {
    const snap: MergeQueueSnapshot = { entries: [entry({ runId: "r1", cardId: "c1", status: "failed", failureReason: "boom" })], processing: false };
    const items = mergeFailedItemsFromSnapshot(snap, cardsById, cfg, "b");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "merge-failed", cardId: "c1", runId: "r1", branch: "run/r1", failureReason: "boom" });
  });

  it("does NOT emit when a failed entry was SUPERSEDED by a newer live entry (latest wins)", () => {
    const snap: MergeQueueSnapshot = {
      entries: [entry({ runId: "r1", cardId: "c1", status: "failed" }), entry({ runId: "r2", cardId: "c1", status: "waiting" })],
      processing: false,
    };
    expect(mergeFailedItemsFromSnapshot(snap, cardsById, cfg, "b")).toHaveLength(0);
  });

  it("orphan-guards + terminal-guards + truncates failureReason to 300", () => {
    const snap: MergeQueueSnapshot = {
      entries: [
        entry({ runId: "r1", cardId: "c1", status: "failed", failureReason: "x".repeat(500) }),
        entry({ runId: "r3", cardId: "cX", status: "failed" }), // orphan (absent from cardsById)
        entry({ runId: "r4", cardId: "c2", status: "failed" }), // c2 is terminal
      ],
      processing: false,
    };
    const items = mergeFailedItemsFromSnapshot(snap, cardsById, cfg, "b");
    expect(items.map((i) => i.cardId)).toEqual(["c1"]);
    expect(items[0].failureReason).toHaveLength(300);
  });
});

describe("WS-5 D13 — os kinds da WS-5 no conjunto do COPILOTO", () => {
  it("os kinds de DEPLOY seguem fora do Copiloto (ele não tem `deploy: auto`) e dentro do Autônomo", () => {
    for (const kind of ["deploy-unsettled", "release-aging"] as CockpitItemKind[]) {
      const item = { id: "x", kind, boardId: "b", cardId: "c1", cardTitle: "T", status: null, lane: "travado", severity: "high" } as CockpitItem;
      expect(isCopilotActionable(item, "copiloto")).toBe(false);
      expect(isCopilotActionable(item, "autonomo")).toBe(true);
    }
  });

  it("D13 RESOLVIDA (decisão do Operador) — `merge-failed` é acionável JÁ no Copiloto: a ação é `merge-resolve`, que ele tem em `auto`", () => {
    const item = { id: "x", kind: "merge-failed", boardId: "b", cardId: "c1", cardTitle: "T", status: null, lane: "travado", severity: "high" } as CockpitItem;
    // O inverso do princípio da tabela: ele PODIA resolver a entry e mesmo assim não acordava por ela.
    expect(isCopilotActionable(item, "copiloto")).toBe(true);
    expect(isCopilotActionable(item, "autonomo")).toBe(true);
    // é o MESMO ato que `conflict` — que já era base desde a F8. Os dois andam juntos ou a tabela mente.
    expect(COPILOT_ACTIONABLE_KINDS.has("conflict")).toBe(true);
  });

  it("COPILOT_ACTIONABLE_KINDS is EXACTLY {conflict, deploy-failed, gate, merge-failed, question, stuck} — expanding it is separate governance (D13)", () => {
    expect([...COPILOT_ACTIONABLE_KINDS].sort()).toEqual(["conflict", "deploy-failed", "gate", "merge-failed", "question", "stuck"]);
    // e o Chat (sem tick) herda o conjunto conservador — nunca o do Autônomo.
    expect([...copilotActionableKinds("chat")].sort()).toEqual([...COPILOT_ACTIONABLE_KINDS].sort());
    expect([...copilotActionableKinds("copiloto")].sort()).toEqual([...COPILOT_ACTIONABLE_KINDS].sort());
  });
});

describe("cardDemands — the single source of truth for HITL demands", () => {
  it("open questions on a grill (autorun) card → ONE question demand, no gate", () => {
    const d = cardDemands(card({ status: "grill", questions: [q("q1", "open"), q("q2", "open")] }), config, "b");
    expect(d.map((x) => x.type)).toEqual(["question"]);
    expect(d[0]).toMatchObject({ type: "question", count: 2, severity: "high", since: "2026-06-13" });
  });

  it("a manual step the card reached AFTER producing work (qaPassed) is a human GATE labelled by the step name", () => {
    const d = cardDemands(card({ status: "revisao", qaPassed: true }), config, "b");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ type: "gate", label: "Aprovar entrega", severity: "medium" });
  });

  it("a card in a manual step with NO work produced yet → NO gate demand (it's backlog, not pilotage)", () => {
    // The cockpit's keystone fix: triage intake / "a fazer" after estimate must NOT pollute "precisa
    // de você" — only an approval the automation already produced work for is a pilotage demand.
    expect(cardDemands(card({ status: "revisao" }), config, "b")).toEqual([]);
    expect(cardDemands(card({ status: "triage" }), config, "b")).toEqual([]);
    expect(hasDemand(card({ status: "triage" }), config)).toBe(false);
  });

  it("an open BLOCKER finding surfaces as a blocker demand (alongside the gate)", () => {
    const d = cardDemands(card({ status: "revisao", findings: [finding("f1", "blocker", "open"), finding("f2", "low", "open")] }), config, "b");
    expect(d.map((x) => x.type).sort()).toEqual(["blocker", "gate"]);
    expect(d.find((x) => x.type === "blocker")).toMatchObject({ count: 1, severity: "high" });
  });

  it("needsHumanReview in triage → review facet ONLY (no gate: triage produced no work yet)", () => {
    // The triage agent flagging low confidence IS a pilotage demand (the automation ran and asked
    // for a look), but the bare manual-step gate is suppressed (nothing was produced to approve).
    const d = cardDemands(card({ status: "triage", needsHumanReview: true }), config, "b");
    expect(d.map((x) => x.type)).toEqual(["review"]);
  });

  it("a TERMINAL card never demands — even with open questions (they auto-resolve stale)", () => {
    const d = cardDemands(card({ status: "concluida", questions: [q("q1", "open")] }), config, "b");
    expect(d).toEqual([]);
  });

  it("an autorun build step with nothing pending → no demand", () => {
    expect(cardDemands(card({ status: "enriquecer" }), config, "b")).toEqual([]);
    expect(hasDemand(card({ status: "enriquecer" }), config)).toBe(false);
  });

  it("all-answered questions on a grill card → no question demand", () => {
    expect(cardDemands(card({ status: "grill", questions: [q("q1", "answered")] }), config, "b")).toEqual([]);
  });

  // story-ql5mjm: descontinuar is now autorun:true + hidden, so the generic gate demand is skipped. A
  // retire paused on the IRREVERSIBLE data-deletion approval (excluir-tudo) MUST still surface — else the
  // operator can never approve the wipe and the card is invisible everywhere (the review blocker).
  const retireExcluirTudo = (dataDeletionApproved: boolean) =>
    card({
      status: "descontinuar",
      mode: "retire",
      retirement: {
        brief: "remover feature X",
        disposition: "descontinuado",
        level: "excluir-tudo",
        scope: ["dados"],
        target: null,
        screenshot: null,
        fromStatus: "concluida",
        dataDeletionApproved,
        openedAt: "2026-06-16",
      },
    });

  it("retire excluir-tudo unapproved → data-deletion approval surfaces (gate/high) despite autorun+hidden", () => {
    const d = cardDemands(retireExcluirTudo(false), config, "b");
    expect(d.some((x) => x.type === "gate" && x.severity === "high" && /exclusão de dados/i.test(x.label))).toBe(true);
    const items = cardCockpitItems(retireExcluirTudo(false), config, "b");
    expect(items.some((x) => x.kind === "approval" && x.id.endsWith(":data-deletion"))).toBe(true);
  });

  it("retire excluir-tudo ALREADY approved → no data-deletion demand (the wipe is cleared)", () => {
    expect(cardDemands(retireExcluirTudo(true), config, "b").some((x) => /exclusão de dados/i.test(x.label))).toBe(false);
  });
});

describe("cardDemands — release-aging (WS1.5): approved code idling unpublished", () => {
  // Inject a precise `now`; stagedAt is day-granular (YYYY-MM-DD) in prod, so age is measured from the
  // staged day's UTC midnight — exactly the production semantics.
  const NOW = Date.parse("2026-07-09T12:00:00Z");
  const rel = (fields: Record<string, unknown>) => cardDemands(card({ status: "release", ...fields }), config, "b", { now: NOW });

  it("staged 36h ago (> 24h SLA) → release-aging present, medium, since=stagedAt", () => {
    const ra = rel({ stagedAt: "2026-07-08" }).find((x) => x.type === "release-aging"); // 2026-07-08T00:00Z → 36h
    expect(ra).toMatchObject({ type: "release-aging", severity: "medium", since: "2026-07-08" });
    expect(ra!.label).toMatch(/publicar/i);
  });

  it("staged 84h ago (≥ 72h) → escalates to high", () => {
    expect(rel({ stagedAt: "2026-07-06" }).find((x) => x.type === "release-aging")?.severity).toBe("high"); // 84h
  });

  it("staged 12h ago (< 24h SLA) → absent", () => {
    expect(rel({ stagedAt: "2026-07-09" }).some((x) => x.type === "release-aging")).toBe(false); // 12h
  });

  it("already released → never ages (releasedAt closes the window)", () => {
    expect(rel({ stagedAt: "2026-07-01", releasedAt: "2026-07-02" }).some((x) => x.type === "release-aging")).toBe(false);
  });

  it("also fires in the autorun `stage` step, not only manual `release`", () => {
    const d = cardDemands(card({ status: "stage", stagedAt: "2026-07-06" }), config, "b", { now: NOW });
    expect(d.some((x) => x.type === "release-aging")).toBe(true);
  });

  it("custom threshold via opts.releaseAgingHours is honored (6h)", () => {
    const d = cardDemands(card({ status: "release", stagedAt: "2026-07-09" }), config, "b", { now: NOW, releaseAgingHours: 6 });
    expect(d.some((x) => x.type === "release-aging")).toBe(true); // 12h > 6h
  });

  it("a DEV step carrying a stale stagedAt does NOT age (scoped to stage/release — no reopen/revert noise)", () => {
    const d = cardDemands(card({ status: "revisao", stagedAt: "2026-07-01" }), config, "b", { now: NOW });
    expect(d.some((x) => x.type === "release-aging")).toBe(false);
  });

  it("a terminal card never ages even if staged-but-unreleased (early-return)", () => {
    const d = cardDemands(card({ status: "concluida", stagedAt: "2026-07-01" }), config, "b", { now: NOW });
    expect(d).toEqual([]);
  });
});

describe("cardDemands — deploy-unsettled (WS1.1): the 'No ar' mentiroso watchdog", () => {
  const NOW = Date.parse("2026-07-09T12:00:00Z");
  const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString(); // full ISO — minute-granular
  const call = (fields: Record<string, unknown>) => cardDemands(card({ status: "release", ...fields }), config, "b", { now: NOW });

  it("deploy fired 20min ago without settle (> 15min SLA) → deploy-unsettled, high, since=deployFiredAt", () => {
    const fired = minAgo(20);
    const d = call({ deployFiredAt: fired }).find((x) => x.type === "deploy-unsettled");
    expect(d).toMatchObject({ type: "deploy-unsettled", severity: "high", since: fired });
  });

  it("deploy fired 5min ago (< 15min SLA) → absent", () => {
    expect(call({ deployFiredAt: minAgo(5) }).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });

  it("fires even on a TERMINAL card — the optimistic 'No ar' that never settled (survives the early-return)", () => {
    const d = cardDemands(card({ status: "concluida", deployFiredAt: minAgo(20) }), config, "b", { now: NOW });
    expect(d.map((x) => x.type)).toEqual(["deploy-unsettled"]);
  });

  it("settled (deployFiredAt cleared) → absent", () => {
    expect(call({}).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });

  it("custom threshold via opts.deployUnsettledMinutes (3min) flips a 5min-old fire to present", () => {
    expect(call({ deployFiredAt: minAgo(5) }).some((x) => x.type === "deploy-unsettled")).toBe(false); // default 15
    const d = cardDemands(card({ status: "release", deployFiredAt: minAgo(5) }), config, "b", { now: NOW, deployUnsettledMinutes: 3 });
    expect(d.some((x) => x.type === "deploy-unsettled")).toBe(true);
  });
});

describe("boardCardDemands — sorted by severity then age", () => {
  it("orders high (question/blocker) before medium (gate), oldest-first within a tier", () => {
    const cards = [
      card({ status: "revisao", qaPassed: true }), // gate (medium) — work produced, so it surfaces
    ];
    cards[0] = { ...cards[0], id: "c-gate" };
    const withQ = { ...card({ status: "grill", questions: [q("q1", "open", "2026-06-10")] }), id: "c-q" };
    const all = boardCardDemands([cards[0], withQ], config, "b");
    expect(all[0].type).toBe("question"); // high before medium
    expect(all[0].severity).toBe("high");
    expect(all[all.length - 1].type).toBe("gate");
  });
});

describe("hasProducedWork — the cockpit entry axis (already-ran vs freshly-planned)", () => {
  it("false for a freshly planned card — only narrative/RICE, no design/code/qa/merge artifact", () => {
    expect(hasProducedWork(card({ status: "pronta" }))).toBe(false);
    expect(hasProducedWork(card({ status: "triage" }))).toBe(false);
  });

  it("true once ANY work artifact exists (wireframe / review / qa / stage / release / findings)", () => {
    expect(hasProducedWork(card({ wireframeChosen: "opt-a" }))).toBe(true);
    expect(hasProducedWork(card({ reviewedAt: "2026-06-13" }))).toBe(true);
    expect(hasProducedWork(card({ qaPassed: true }))).toBe(true);
    expect(hasProducedWork(card({ qaRanAt: "2026-06-13" }))).toBe(true);
    expect(hasProducedWork(card({ stagedAt: "2026-06-13" }))).toBe(true);
    expect(hasProducedWork(card({ releasedAt: "2026-06-13" }))).toBe(true);
    expect(hasProducedWork(card({ findings: [finding("f1", "low", "open")] }))).toBe(true);
  });
});

describe("cockpit grouping — every demand type lands in exactly one lane", () => {
  it("COCKPIT_GROUP_OF is exhaustive and points to a known lane", () => {
    const types = ["question", "blocker", "review", "gate", "merge-conflict", "merge-gate-failed", "release-aging", "deploy-unsettled"] as const;
    for (const t of types) expect(COCKPIT_GROUP_ORDER).toContain(COCKPIT_GROUP_OF[t]);
  });
  it("stalls before questions before approvals", () => {
    expect(COCKPIT_GROUP_OF.blocker).toBe("travado");
    expect(COCKPIT_GROUP_OF.question).toBe("pergunta");
    expect(COCKPIT_GROUP_OF.gate).toBe("aprovar");
    expect(COCKPIT_GROUP_OF["release-aging"]).toBe("travado"); // WS1.5: aging is a stall, not a routine approval
    expect(COCKPIT_GROUP_ORDER).toEqual(["travado", "pergunta", "aprovar"]);
  });
});

// ── O kind `finding` — os AVISOS (non-blocker) que ninguém projetava ──────────────────────────────────────
// O caso REAL que abriu o kind (acme/story-novo-item, 2026-07-17): 6 findings abertos medium/high/low num board
// Autônomo, e o cockpit não emitia UM item sequer — `openBlockers` só olhava `severity === "blocker"`. O board
// passou a noite dizendo "nada acionável" com 6 avisos à vista, porque não travar gate estava codificado como
// não ser trabalho.
describe("cardCockpitItems — `finding`: o aviso non-blocker aberto vira item", () => {
  const withFindings = (...fs: ReturnType<typeof finding>[]) => card({ status: "revisao", findings: fs });
  const findingItems = (c: Card) => cardCockpitItems(c, config, "b").filter((i) => i.kind === "finding");

  it("projeta UM item por aviso ABERTO, carregando severity/lens/suggestion do finding", () => {
    const c = card({
      status: "revisao",
      findings: [
        { id: "f1", lens: "perf", severity: "medium", title: "re-render", status: "open", suggestion: "memoize" },
        { id: "f2", lens: "nextjs", severity: "low", title: "import", status: "open" },
      ],
    });
    const items = findingItems(c);
    expect(items.map((i) => i.id)).toEqual(["story-x:f:f1", "story-x:f:f2"]);
    const [f1] = items as Array<Extract<CockpitItem, { kind: "finding" }>>;
    expect(f1.findingId).toBe("f1");
    expect(f1.lens).toBe("perf");
    expect(f1.suggestion).toBe("memoize");
    // a severity é a DO FINDING, nunca inventada — a lane ordena por ela.
    expect(f1.severity).toBe("medium");
    expect(f1.findingSeverity).toBe("medium");
    // e ele espera DECISÃO, não destrava nada ⇒ lane `pergunta`, jamais `travado`.
    expect(f1.lane).toBe("pergunta");
  });

  it("um `blocker` NÃO vira aviso (é o kind `blocker`) — e um aviso NÃO vira blocker", () => {
    const c = withFindings(finding("b1", "blocker", "open"), finding("a1", "high", "open"));
    const items = cardCockpitItems(c, config, "b");
    expect(items.filter((i) => i.kind === "blocker").map((i) => i.id)).toEqual(["story-x:b:b1"]);
    expect(items.filter((i) => i.kind === "finding").map((i) => i.id)).toEqual(["story-x:f:a1"]);
  });

  it("o finding `deploy-failure` NÃO duplica como aviso — só o kind `deploy-failed`", () => {
    // Ele é `high` (não pode gatear o release→deploy), então a régua de SEVERITY o chamaria de aviso. Se ele
    // duplicasse, o desfecho barato do aviso (`acknowledged`) apagaria o alarme de produção por triagem.
    const c = card({
      status: "release",
      findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "deploy falhou", status: "open" }],
    });
    const items = cardCockpitItems(c, config, "b");
    expect(items.filter((i) => i.kind === "deploy-failed")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "finding")).toHaveLength(0);
  });

  it("aviso já TRIADO não é item — o desfecho é o que tira o item do set (é o que faz o kind convergir)", () => {
    for (const status of ["acknowledged", "fixed", "wontfix"] as const) {
      expect(findingItems(withFindings(finding("f1", "medium", status)))).toHaveLength(0);
    }
    expect(findingItems(withFindings(finding("f1", "medium", "open")))).toHaveLength(1);
  });

  it("card TERMINAL não emite aviso — como todo item que vive depois do guard de terminal", () => {
    expect(findingItems(card({ status: "concluida", findings: [finding("f1", "high", "open")] }))).toHaveLength(0);
  });
});

describe("`finding` × tier — julgar um aviso é do Autônomo, nunca do Copiloto", () => {
  const item = (): CockpitItem =>
    ({ id: "c:f:f1", kind: "finding", boardId: "b", cardId: "c", cardTitle: "T", status: "revisao", lane: "pergunta",
       severity: "medium", findingId: "f1", title: "t", findingSeverity: "medium" }) as CockpitItem;

  it("acionável no Autônomo (dar desfecho é JULGAR) e não no Copiloto (acordaria só p/ devolver ao humano)", () => {
    expect(isCopilotActionable(item(), "autonomo")).toBe(true);
    expect(isCopilotActionable(item(), "copiloto")).toBe(false);
    expect(isCopilotActionable(item(), "chat")).toBe(false);
  });
});

describe("cardCockpitItems — typed inbox items, each carrying the parent cardId", () => {
  it("projects an open question into a question item with the agent's options + mode", () => {
    const c = card({
      status: "grill",
      questions: [
        {
          id: "q1",
          text: "Qual abordagem?",
          status: "open",
          askedAt: "2026-06-13",
          options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }],
          mode: "single",
        },
      ],
    });
    const items = cardCockpitItems(c, config, "b");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "question", cardId: "story-x", lane: "pergunta", questionId: "q1", mode: "single" });
    expect(items[0].kind === "question" && items[0].options).toHaveLength(2);
  });

  // F8 — o gate do CARD virou kind `gate` (era `approval`). Não é cosmético: `approval` passou a significar SÓ
  // o pedido de aprovação que o PRÓPRIO copiloto abre (cockpit-collect, id `apr:*`). Conflatidos, tornar a fila
  // acionável faria o tick acordar por causa do próprio pedido — laço. Ver o teste anti-laço abaixo.
  it("a post-work manual gate → item `gate`; a freshly-planned manual step → nothing", () => {
    expect(cardCockpitItems(card({ status: "revisao", qaPassed: true }), config, "b").map((i) => i.kind)).toEqual(["gate"]);
    expect(cardCockpitItems(card({ status: "revisao" }), config, "b")).toEqual([]);
  });

  // WS-12.4 (D16) — o id do item de gate carrega o STATUS. Antes era `<card>:approval` em toda parada manual:
  // um card que cruzava um gate e parava no PRÓXIMO (progresso REAL) chegava lá com o streak anti-noop do gate
  // anterior — o Jido já tinha "desistido" de um item que acabara de nascer. Com o status no id, o item
  // velho some do actionable set (o rebuild-from-set o poda) e o novo nasce zerado.
  it("o id do item de gate é escopado pelo STATUS — cruzar um gate gera um item NOVO (o streak não é herdado)", () => {
    const naRevisao = cardCockpitItems(card({ status: "revisao", qaPassed: true }), config, "b");
    const noRelease = cardCockpitItems(card({ status: "release", qaPassed: true }), config, "b");
    expect(naRevisao[0].id).toBe("story-x:approval:revisao");
    expect(noRelease.find((i) => i.kind === "gate")?.id).toBe("story-x:approval:release");
    expect(naRevisao[0].id).not.toBe(noRelease.find((i) => i.kind === "gate")?.id);
  });

  it("review only while in the staging column; not after the card advances", () => {
    expect(cardCockpitItems(card({ status: "triage", needsHumanReview: true }), config, "b").map((i) => i.kind)).toEqual(["review"]);
    expect(
      cardCockpitItems(card({ status: "revisao", needsHumanReview: true, qaPassed: true }), config, "b").map((i) => i.kind),
    ).toEqual(["gate"]);
  });

  // F8 — o BUG que originou tudo isto: um deploy de produção falhava, o card era revertido para "Liberar" com um
  // finding `high`… e NADA acontecia. `high` não gerava demanda; o card descia na lane verde, o push dizia
  // "⏳ Precisa de você — Liberar" (igual a um card saudável) e o Jido olhava o cockpit, não via item
  // acionável nenhum e voltava a dormir. A falha era ativamente classificada como SAÚDE.
  it("F8 — um deploy FALHO gera demanda `deploy-failed` crítica + item acionável (antes: NADA)", () => {
    const broke = card({
      status: "release",
      qaPassed: true,
      findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "Deploy de produção falhou — reentrar no Deploy" }],
    });
    const demands = cardDemands(broke, config, "b");
    const failure = demands.find((d) => d.type === "deploy-failed");
    expect(failure, "um deploy falho TEM de gerar demanda — era o buraco").toBeTruthy();
    expect(failure!.severity).toBe("critical");

    const items = cardCockpitItems(broke, config, "b");
    const item = items.find((i) => i.kind === "deploy-failed");
    expect(item, "…e um item de cockpit").toBeTruthy();
    expect(item!.lane).toBe("travado"); // 🔴 nunca a lane verde "aprovar"
    expect(isCopilotActionable(item!, "copiloto"), "…que o Jido autônomo consegue pegar").toBe(true);
  });

  it("F8 — o finding RESOLVIDO (deploy re-publicado com sucesso) para de gerar demanda", () => {
    const fixed = card({
      status: "release",
      qaPassed: true,
      findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "fixed", title: "Deploy falhou" }],
    });
    expect(cardDemands(fixed, config, "b").some((d) => d.type === "deploy-failed")).toBe(false);
    expect(cardCockpitItems(fixed, config, "b").some((i) => i.kind === "deploy-failed")).toBe(false);
  });

  it("EVERY item carries a non-empty parent cardId (no orphan items)", () => {
    const c = card({ status: "revisao", qaPassed: true, findings: [finding("f1", "blocker", "open")] });
    const items = cardCockpitItems(c, config, "b");
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.cardId).toBeTruthy();
  });
});

// ── helpers shared by stuck + conflict tests ──────────────────────────────────
const mkCardsById = (cards: Card[]) => new Map(cards.map((c) => [c.id, c]));

describe("stuckItemsFromFailures — pure projection of failed runs into stuck cockpit items", () => {
  const baseFailure = { board: "b", cardId: "story-x", reason: "exit" as const, detail: "exit 1", at: Date.now(), trigger: "harness-do" };

  it("projects a failure into a stuck item with the correct fields", () => {
    const c = card({ status: "enriquecer" });
    const result = stuckItemsFromFailures([baseFailure], mkCardsById([c]), config, "b");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "stuck", lane: "travado", severity: "high", cardId: "story-x", outcome: "exit 1", trigger: "harness-do" });
  });

  it("deduplicates: only one stuck item per card even with multiple failures", () => {
    const c = card({ status: "grill" });
    const failures = [
      { ...baseFailure, reason: "timeout" as const, at: Date.now() - 1000 },
      { ...baseFailure, reason: "exit" as const, at: Date.now() },
    ];
    expect(stuckItemsFromFailures(failures, mkCardsById([c]), config, "b")).toHaveLength(1);
  });

  it("skips failures whose card is absent from cardsById (orphan guard)", () => {
    const result = stuckItemsFromFailures([baseFailure], new Map(), config, "b");
    expect(result).toHaveLength(0);
  });

  it("skips failures whose card is terminal", () => {
    const c = { ...card({ status: "concluida" }), id: "story-x" };
    const result = stuckItemsFromFailures([baseFailure], mkCardsById([c]), config, "b");
    expect(result).toHaveLength(0);
  });

  it("skips failures from a different board", () => {
    const c = card({ status: "enriquecer" });
    const result = stuckItemsFromFailures([{ ...baseFailure, board: "other" }], mkCardsById([c]), config, "b");
    expect(result).toHaveLength(0);
  });

  it("stuck item carries a non-empty cardId (no orphans)", () => {
    const c = card({ status: "enriquecer" });
    const result = stuckItemsFromFailures([baseFailure], mkCardsById([c]), config, "b");
    for (const it of result) expect(it.cardId).toBeTruthy();
  });

  it("EXCLUDES a 'cancelled' outcome — a deliberate operator cancel is never a stuck demand (story-vbkazs)", () => {
    // The board-level collector maps a card's latest telemetry `lastStatus` into a failure-shaped item
    // (cockpit-collect.ts). A card whose latest run is 'cancelled' must NOT surface in Inbox as
    // 'travado' — STUCK_REASONS deliberately omits 'cancelled'. (`reason` is cast because 'cancelled'
    // is intentionally NOT a RunnerFailureReason — it can only arrive via the telemetry-status path.)
    const c = card({ status: "enriquecer" });
    const cancelled = { ...baseFailure, reason: "cancelled" as unknown as typeof baseFailure.reason, detail: "cancelled" };
    expect(stuckItemsFromFailures([cancelled], mkCardsById([c]), config, "b")).toHaveLength(0);
  });
});

describe("conflictItemsFromSnapshot — pure projection of merge-queue conflicts into conflict cockpit items", () => {
  const mkSnapshot = (entries: MergeQueueSnapshot["entries"]): MergeQueueSnapshot => ({ entries, processing: false });
  const baseEntry = { runId: "run-abc", board: "b", cardId: "story-x", branch: "run/run-abc", status: "conflict" as const, enqueuedAt: Date.now() };

  it("projects a conflict entry into a conflict item", () => {
    const c = card({ status: "revisao" });
    const result = conflictItemsFromSnapshot(mkSnapshot([baseEntry]), mkCardsById([c]), config, "b");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "conflict", lane: "travado", severity: "high", cardId: "story-x", runId: "run-abc", conflictKind: "merge-conflict" });
  });

  it("projects a gate-failed entry into a conflict item with the correct conflictKind", () => {
    const c = card({ status: "revisao" });
    const entry = { ...baseEntry, status: "gate-failed" as const };
    const result = conflictItemsFromSnapshot(mkSnapshot([entry]), mkCardsById([c]), config, "b");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ conflictKind: "merge-gate-failed" });
  });

  it("skips entries not in conflict/gate-failed status", () => {
    const c = card({ status: "revisao" });
    const entry = { ...baseEntry, status: "waiting" as const };
    expect(conflictItemsFromSnapshot(mkSnapshot([entry]), mkCardsById([c]), config, "b")).toHaveLength(0);
  });

  it("skips entries whose card is absent from cardsById (orphan guard)", () => {
    const result = conflictItemsFromSnapshot(mkSnapshot([baseEntry]), new Map(), config, "b");
    expect(result).toHaveLength(0);
  });

  it("skips entries from a different board", () => {
    const c = card({ status: "revisao" });
    const entry = { ...baseEntry, board: "other" };
    expect(conflictItemsFromSnapshot(mkSnapshot([entry]), mkCardsById([c]), config, "b")).toHaveLength(0);
  });

  it("returns empty for undefined snapshot (registry not yet initialized)", () => {
    const c = card({ status: "revisao" });
    expect(conflictItemsFromSnapshot(undefined, mkCardsById([c]), config, "b")).toHaveLength(0);
  });

  it("conflict item carries a non-empty cardId (no orphans)", () => {
    const c = card({ status: "revisao" });
    const result = conflictItemsFromSnapshot(mkSnapshot([baseEntry]), mkCardsById([c]), config, "b");
    for (const it of result) expect(it.cardId).toBeTruthy();
  });
});

describe("dedupeCaptureLanes — captura falhada não aparece nos 2 lanes (bug story-73tajj)", () => {
  const stuckItem = (cardId: string): CockpitItem => ({
    id: `${cardId}:stuck:exit`, kind: "stuck", boardId: "b", cardId, cardTitle: "captura", status: "capturando",
    lane: "travado", severity: "high", since: null, outcome: "exit",
  });
  const proposalItem = (cardId: string, hasContent: boolean): ProposalCockpitItem => ({
    id: `${cardId}:proposal`, kind: "proposal", boardId: "b", cardId, cardTitle: "captura", status: "capturando",
    lane: "aprovar", severity: "medium", since: null,
    summary: hasContent ? "resumo" : "", items: hasContent ? [{ tempId: "i1", type: "story", title: "T", rationale: "r" }] : [], rounds: 0,
  });

  it("sem sidecar + run falhou → SÓ o stuck (some o 'Gerando proposta…')", () => {
    const { stuck, proposal } = dedupeCaptureLanes([stuckItem("c1")], [proposalItem("c1", false)], new Set());
    expect(stuck.map((s) => s.cardId)).toEqual(["c1"]);
    expect(proposal).toEqual([]);
  });

  it("com sidecar (proposta real) + run falhou stale → SÓ a proposta (some o stuck)", () => {
    const { stuck, proposal } = dedupeCaptureLanes([stuckItem("c1")], [proposalItem("c1", true)], new Set(["c1"]));
    expect(stuck).toEqual([]);
    expect(proposal.map((p) => p.cardId)).toEqual(["c1"]);
  });

  it("sem sidecar + sem falha → mantém o 'Gerando proposta…' (em voo de verdade)", () => {
    const { stuck, proposal } = dedupeCaptureLanes([], [proposalItem("c1", false)], new Set());
    expect(stuck).toEqual([]);
    expect(proposal.map((p) => p.cardId)).toEqual(["c1"]);
  });

  it("stuck de card NÃO-captura (sem sidecar) sobrevive sempre", () => {
    const { stuck } = dedupeCaptureLanes([stuckItem("story-real")], [], new Set());
    expect(stuck.map((s) => s.cardId)).toEqual(["story-real"]);
  });
});

describe("isCopilotActionable (6.4/F6.3) — the demands the autonomous tick can act on", () => {
  const item = (kind: CockpitItemKind) => ({ kind }) as CockpitItem;
  const ALL: CockpitItemKind[] = ["question", "blocker", "approval", "review", "stuck", "conflict", "proposal", "design", "governance"];

  it("stuck + conflict + question are actionable (F6.3: the tick answers factually-resolvable questions)", () => {
    expect(ALL.filter((k) => isCopilotActionable(item(k), "copiloto"))).toEqual(["question", "stuck", "conflict"]);
  });

  it("a human-escalated blocker is NOT actionable no COPILOTO (classified by KIND, not by its red lane)", () => {
    expect(isCopilotActionable(item("blocker"), "copiloto")).toBe(false); // sits with stuck/conflict in travado, but is human
    // F6.3 — question IS now actionable (the tick investigates + answers the resolvable ones via answer_question);
    // product-decision questions stay open and the anti-noop backoff prevents re-spawning on them.
    expect(isCopilotActionable(item("question"), "copiloto")).toBe(true);
    // F8 — A INVARIANTE ANTI-LAÇO: `approval` é o pedido que o PRÓPRIO copiloto abriu (aguarda o humano). Se
    // ele fosse acionável, o tick acordaria por causa de si mesmo, veria "trabalho", e re-acordaria: laço.
    // O gate DO CARD (que ele PODE empurrar) é kind `gate` — outro item, outra semântica.
    expect(isCopilotActionable(item("approval"), "copiloto")).toBe(false);
    expect(isCopilotActionable(item("gate"), "copiloto")).toBe(true);
  });

  it("F8 (+D13) — COPILOT_ACTIONABLE_KINDS: os sinais que um orquestrador de ponta a ponta consegue trabalhar", () => {
    expect([...COPILOT_ACTIONABLE_KINDS].sort()).toEqual(["conflict", "deploy-failed", "gate", "merge-failed", "question", "stuck"]);
    // …e NENHUM dos que dependem de julgamento humano (ou que seriam laço):
    for (const humanOnly of ["approval", "blocker", "finding", "review", "proposal", "design", "governance"] as const) {
      expect(COPILOT_ACTIONABLE_KINDS.has(humanOnly), `${humanOnly} NÃO é acionável pelo Jido`).toBe(false);
    }
  });

  it("AUTÔNOMO — paridade com o humano: aciona TODO kind menos `approval` (a invariante anti-laço)", () => {
    // O contrato inteiro numa asserção: o Autônomo decide produto/UX e publica sozinho, então tudo que um humano
    // pegaria no Inbox ele acorda para pegar. A ÚNICA exceção é estrutural, não de poder.
    expect([...AUTONOMO_ACTIONABLE_KINDS].sort()).toEqual(
      ["blocker", "conflict", "deploy-failed", "deploy-unsettled", "design", "finding", "gate", "governance", "merge-failed", "proposal", "question", "release-aging", "review", "stuck"],
    );
    expect(AUTONOMO_ACTIONABLE_KINDS.has("approval"), "approval seria o tick acordando por causa de si mesmo").toBe(false);
    // e o Autônomo é um SUPERSET estrito do Copiloto — nenhum tier perde sinal ao subir.
    for (const k of COPILOT_ACTIONABLE_KINDS) expect(AUTONOMO_ACTIONABLE_KINDS.has(k), `${k} não pode sumir no Autônomo`).toBe(true);
    expect(AUTONOMO_ACTIONABLE_KINDS.size).toBeGreaterThan(COPILOT_ACTIONABLE_KINDS.size);
  });

  it("AUTÔNOMO — os kinds de JULGAMENTO (produto/UX) que o Copiloto escala viram acionáveis", () => {
    // Cada um destes é exatamente o que a DEFER_STANCE manda o Copiloto devolver ao humano e a AUTONOMO_STANCE
    // autoriza decidir. Se algum destes voltar a `false` no Autônomo, o tier virou rótulo sem efeito.
    for (const k of ["blocker", "review", "proposal", "design", "governance"] as const) {
      expect(isCopilotActionable(item(k), "copiloto"), `${k}: Copiloto escala`).toBe(false);
      expect(isCopilotActionable(item(k), "autonomo"), `${k}: Autônomo decide`).toBe(true);
    }
  });

  it("WS-5.1 (D9) — um stuck com outcome `no-op` NÃO é acionável (o playbook cancel+enqueue é errado p/ 'não havia trabalho')", () => {
    const stuck = (outcome?: string) =>
      ({ kind: "stuck", outcome } as CockpitItem); // só o discriminante + o outcome importam aqui
    // no-op → o loop auto-alimentado: fica visível ao humano (travado) mas o tick o deixa em paz.
    expect(isCopilotActionable(stuck("no-op"), "copiloto")).toBe(false);
    // …e o AUTÔNOMO tampouco: "re-drivar um no-op compra outro no-op" é fato sobre o playbook, não falta de
    // poder — mais autonomia não torna a re-tentativa certa, só mais cara. Invariante de tier, como `approval`.
    expect(isCopilotActionable(stuck("no-op"), "autonomo")).toBe(false);
    // um stuck de FALHA real (crash) continua acionável — o Jido pode diagnosticar + re-drivar.
    expect(isCopilotActionable(stuck("exit"), "copiloto")).toBe(true);
    expect(isCopilotActionable(stuck("timeout"), "copiloto")).toBe(true);
    // sem outcome (registro sem detalhe) → tratado como acionável (retrocompatível), como antes da D9.
    expect(isCopilotActionable(stuck(undefined), "copiloto")).toBe(true);
  });
});

// story-cvq4w0 — findings de fase de ENTREGA morrem quando o card VOLTA para implementação: um
// `deploy-failure` aberto descreve o ciclo de entrega MORTO e ficava mentindo na UI ("Republicar"/
// "Release falhou") sobre um card com run de implementação ativo (incidente acme/story-tlz0dt, 21/07).
describe("supersedeDeliveryFindingsOnReentry — o par do resolveStaleQuestions para findings de entrega", () => {
  const open = {
    id: DEPLOY_FAILURE_FINDING_ID,
    lens: "general" as const,
    severity: "high" as const,
    title: "Release falhou",
    detail: "promoção não aplicou",
    status: "open" as const,
  };

  it("supersede o deploy-failure ABERTO: fixed + statusBy de sistema + nota no detail", () => {
    const out = supersedeDeliveryFindingsOnReentry([open], "2026-07-21");
    expect(out).toHaveLength(1);
    expect(out![0].status).toBe("fixed");
    expect(out![0].statusBy).toBe("system:reentrada-implementacao");
    expect(out![0].statusAt).toBe("2026-07-21");
    expect(out![0].detail).toContain("SUPERSEDIDO");
    expect(out![0].detail).toContain("promoção não aplicou"); // o histórico original permanece
  });

  it("nada a supersedir ⇒ MESMA referência (identidade preservada — o chamador pode pular o write)", () => {
    const closed = [{ ...open, status: "fixed" as const }];
    expect(supersedeDeliveryFindingsOnReentry(closed, "2026-07-21")).toBe(closed);
    expect(supersedeDeliveryFindingsOnReentry(undefined, "2026-07-21")).toBeUndefined();
    const others = [{ ...open, id: "outro-finding" }];
    expect(supersedeDeliveryFindingsOnReentry(others, "2026-07-21")).toBe(others);
  });

  it("não toca findings alheios nem re-supersede um já fechado (idempotente)", () => {
    const mixed = [open, { ...open, id: "review-x", status: "open" as const }];
    const out = supersedeDeliveryFindingsOnReentry(mixed, "2026-07-21")!;
    expect(out[0].status).toBe("fixed");
    expect(out[1].status).toBe("open"); // finding de review permanece aberto
    expect(supersedeDeliveryFindingsOnReentry(out, "2026-07-22")).toBe(out); // 2ª passada = no-op
  });
});
