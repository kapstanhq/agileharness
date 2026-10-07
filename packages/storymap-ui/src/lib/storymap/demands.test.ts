import { describe, expect, it } from "vitest";
import { AUTONOMO_ACTIONABLE_KINDS, boardCockpitItems, capacityLatchItem, hostHealthItem, sentinelCockpitItems, publishHeldItems, pushOffItem, stageIdleItem, CARD_STALLED_FINDING_ID, cardCockpitItems, cardDemands, conflictItemsFromSnapshot, COPILOT_ACTIONABLE_KINDS, copilotActionableKinds, dedupeCaptureLanes, DEPLOY_FAILURE_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID, ENTRY_EFFECT_FAILED_FINDING_ID, exitStepAttempt, foldLastDeploy, hasProducedWork, foldRunDiagnostics, isCopilotActionable, mergeFailedItemsFromSnapshot, recoveryRetryLimit, staleDeliveryStampSweep, stuckItemsFromFailures, supersedeDeliveryFindingsOnReentry } from "./demands";
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
    { id: "descontinuar", name: "Descontinuar", trigger: "harness-retire", autorun: true, hidden: true }, // ex0118: autorun + hidden
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

  // B21 (auditoria do Inbox): o watchdog vale SÓ enquanto o card espera no passo de publicação. Fora
  // dele o carimbo é história — um card movido de volta a Liberar (ou arquivado) exibia «deploy sem confirmação»
  // ao lado de «Aprovar & avançar → Publicar». A varredura do serviço limpa/anota o carimbo velho.
  it("deploy-unsettled: present at 20min IN the deploy step, absent at 5min, and absent on a terminal card (history)", () => {
    const cfgDeploy = { ...config, statuses: [...config.statuses, { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" as const }] };
    const late = cardCockpitItems(cardWith("deploy", { deployFiredAt: iso(20 * 60_000) }), cfgDeploy, "b", { now: NOW });
    expect(late.find((i) => i.kind === "deploy-unsettled")).toBeTruthy();
    const fresh = cardCockpitItems(cardWith("deploy", { deployFiredAt: iso(5 * 60_000) }), cfgDeploy, "b", { now: NOW });
    expect(fresh.find((i) => i.kind === "deploy-unsettled")).toBeUndefined();
    const terminal = cardCockpitItems(cardWith("concluida", { deployFiredAt: iso(20 * 60_000) }), cfgDeploy, "b", { now: NOW });
    expect(terminal.find((i) => i.kind === "deploy-unsettled")).toBeUndefined();
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

  // B21 — o terminal é gatado por hasDeployProof desde o deploy-truth: um carimbo num card terminal é resíduo da era
  // otimista (a varredura do serviço o limpa, ou anota quando não há prova) — nunca um item vermelho para sempre.
  it("card TERMINAL com o carimbo velho NÃO dispara — é história, não watchdog (B21)", () => {
    const c = { ...card({ status: "concluida" }), deployFiredAt: iso(20 * 60_000) };
    expect(cardDemands(c, cfg, "b", { now: NOW }).some((x) => x.type === "deploy-unsettled")).toBe(false);
    expect(cardCockpitItems(c, cfg, "b", { now: NOW }).some((i) => i.kind === "deploy-unsettled")).toBe(false);
  });

  it("dentro do SLA (5min) não dispara em nenhum dos dois casos", () => {
    const fresh = { ...card({ status: "deploy" }), deployFiredAt: iso(5 * 60_000) };
    expect(cardDemands(fresh, cfg, "b", { now: NOW }).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });

  // Num caso real: o deploy rodou OK, o settle não provou (`codigo-sem-release`), e o
  // Inbox pôs o card em APROVAR com «Este card parou aqui e espera sua aprovação para seguir» — só com Devolver,
  // Abrir card e Jido. Não havia nada a aprovar: o card em Publicar espera a PROVA, não o dono.
  const withWork = { reviewedAt: "2026-09-25", qaPassed: true, commitRange: { base: "b0", head: "h9" } };
  const unproven = {
    id: DEPLOY_UNPROVEN_FINDING_ID,
    lens: "general",
    severity: "high",
    status: "open",
    title: "O deploy rodou, mas não há prova de que o código deste card está no ar",
    detail: "Motivo: nenhum release registrou em que sha de main o código deste card entrou. (código: codigo-sem-release)",
    suggestion: "Re-publicar: o release reconhece o código já promovido e carimba o sha; o settle então prova.",
  };

  it("card em Publicar esperando o settle NÃO vira item «aprovar» (não há aprovação — o que ele espera é a prova)", () => {
    const publishing = { ...card({ status: "deploy", ...withWork }), deployFiredAt: iso(2 * 60_000) };
    const items = cardCockpitItems(publishing, cfg, "b", { now: NOW });
    expect(items.some((i) => i.kind === "gate")).toBe(false);
  });

  it("settle que NÃO provou ⇒ item honesto na hora (sem esperar o SLA): o motivo e o conserto, nunca «aprovar»", () => {
    const held = { ...card({ status: "deploy", ...withWork, findings: [unproven] }), deployFiredAt: iso(2 * 60_000) };
    const items = cardCockpitItems(held, cfg, "b", { now: NOW });
    expect(items.some((i) => i.kind === "gate")).toBe(false);
    expect(items.some((i) => i.kind === "finding")).toBe(false); // o finding não duplica como aviso genérico
    const item = items.find((i) => i.kind === "deploy-unsettled");
    expect(item).toMatchObject({ lane: "travado", severity: "high" });
    expect(item!.kind === "deploy-unsettled" && item!.held).toMatchObject({
      title: unproven.title,
      detail: unproven.detail,
      suggestion: unproven.suggestion,
    });
    // o gêmeo das demandas diz a mesma coisa (as duas derivações nunca divergem)
    const d = cardDemands(held, cfg, "b", { now: NOW }).find((x) => x.type === "deploy-unsettled");
    expect(d?.label).toBe(unproven.title);
  });

  it("o motivo só fala enquanto o card espera em Publicar — devolvido a Liberar, ele vira história", () => {
    const back = card({ status: "release", ...withWork, findings: [unproven] });
    expect(cardCockpitItems(back, cfg, "b", { now: NOW }).some((i) => i.kind === "deploy-unsettled")).toBe(false);
    expect(cardDemands(back, cfg, "b", { now: NOW }).some((x) => x.type === "deploy-unsettled")).toBe(false);
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
    expect(cardDemands(card({ status: "triage" }), config, "").length).toBe(0);
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
    expect(cardDemands(card({ status: "enriquecer" }), config, "").length).toBe(0);
  });

  it("all-answered questions on a grill card → no question demand", () => {
    expect(cardDemands(card({ status: "grill", questions: [q("q1", "answered")] }), config, "b")).toEqual([]);
  });

  // story-ex0118: descontinuar is now autorun:true + hidden, so the generic gate demand is skipped. A
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
    // B1 — kind PRÓPRIO (era `approval`, que o Inbox desenhava com o GateRenderer e cuja primária MOVIA o card).
    const del = items.find((x) => x.id.endsWith(":data-deletion"));
    expect(del).toMatchObject({ kind: "data-deletion", lane: "aprovar", severity: "high", brief: "remover feature X", scope: ["dados"] });
    expect(items.some((x) => x.kind === "approval")).toBe(false);
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
  // B21 — o watchdog mora no passo de publicação (o card ESPERA a prova lá); o board de teste ganha o passo.
  const cfgDeploy = { ...config, statuses: [...config.statuses, { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" as const }] };
  const call = (fields: Record<string, unknown>) => cardDemands(card({ status: "deploy", ...fields }), cfgDeploy, "b", { now: NOW });

  it("deploy fired 20min ago without settle (> 15min SLA) → deploy-unsettled, high, since=deployFiredAt", () => {
    const fired = minAgo(20);
    const d = call({ deployFiredAt: fired }).find((x) => x.type === "deploy-unsettled");
    expect(d).toMatchObject({ type: "deploy-unsettled", severity: "high", since: fired });
  });

  it("deploy fired 5min ago (< 15min SLA) → absent", () => {
    expect(call({ deployFiredAt: minAgo(5) }).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });

  it("B21 — NÃO dispara num card TERMINAL nem em Liberar: fora do passo de publicação o carimbo é história", () => {
    expect(cardDemands(card({ status: "concluida", deployFiredAt: minAgo(20) }), cfgDeploy, "b", { now: NOW })).toEqual([]);
    expect(cardDemands(card({ status: "release", deployFiredAt: minAgo(20) }), cfgDeploy, "b", { now: NOW }).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });

  it("settled (deployFiredAt cleared) → absent", () => {
    expect(call({}).some((x) => x.type === "deploy-unsettled")).toBe(false);
  });

  it("custom threshold via opts.deployUnsettledMinutes (3min) flips a 5min-old fire to present", () => {
    expect(call({ deployFiredAt: minAgo(5) }).some((x) => x.type === "deploy-unsettled")).toBe(false); // default 15
    const d = cardDemands(card({ status: "deploy", deployFiredAt: minAgo(5) }), cfgDeploy, "b", { now: NOW, deployUnsettledMinutes: 3 });
    expect(d.some((x) => x.type === "deploy-unsettled")).toBe(true);
  });
});

describe("hasProducedWork — the cockpit entry axis (already-ran vs freshly-planned)", () => {
  it("false for a freshly planned card — only narrative/acceptance, no design/code/qa/merge artifact", () => {
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

// ── O kind `finding` — os AVISOS (non-blocker) que ninguém projetava ──────────────────────────────────────
// O caso que abriu o kind: vários findings abertos medium/high/low num board
// Autônomo, e o cockpit não emitia UM item sequer — `openBlockers` só olhava `severity === "blocker"`. O board
// passava horas dizendo "nada acionável" com avisos à vista, porque não travar gate estava codificado como
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
  // O passo de APROVAÇÃO DA ENTREGA (gate hasQaPassed, manual) marca o item: num board só-negócio ninguém do sistema
  // move um card parado ali, e a régua de decision-class o entrega ao dono (ver decision-class.test.ts).
  it("o gate da aprovação da ENTREGA (hasQaPassed, manual) marca deliveryApproval; outro gate manual não", () => {
    const withDelivery: BoardConfig = {
      ...config,
      statuses: config.statuses.map((s) => (s.id === "revisao" ? { ...s, gate: "hasQaPassed" } : s)),
    };
    const parked = cardCockpitItems(card({ status: "revisao", qaPassed: true }), withDelivery, "b").find((i) => i.kind === "gate");
    expect(parked).toMatchObject({ kind: "gate", deliveryApproval: true });
    const publish = cardCockpitItems(card({ status: "release", qaPassed: true }), withDelivery, "b").find((i) => i.kind === "gate");
    expect(publish && "deliveryApproval" in publish).toBe(false);
  });

  it("com um CONDUTOR no card, ou um agente trabalhando nele, a entrega parada não é pedido ao dono (ele vai mover)", () => {
    const withDelivery: BoardConfig = {
      ...config,
      statuses: config.statuses.map((s) => (s.id === "revisao" ? { ...s, gate: "hasQaPassed" } : s)),
    };
    const conducted = card({ status: "revisao", qaPassed: true, routing: { skips: [], decidedBy: "rules", decidedAt: "2026-05-01", driver: "conductor" } });
    const g1 = cardCockpitItems(conducted, withDelivery, "b").find((i) => i.kind === "gate");
    expect(g1 && "deliveryApproval" in g1).toBe(false);
    const worked = card({ status: "revisao", qaPassed: true });
    const g2 = cardCockpitItems(worked, withDelivery, "b", { workedCardIds: new Set([worked.id]) }).find((i) => i.kind === "gate");
    expect(g2 && "deliveryApproval" in g2).toBe(false);
    // ninguém no card ⇒ continua sendo pedido ao dono
    const g3 = cardCockpitItems(worked, withDelivery, "b", { workedCardIds: new Set() }).find((i) => i.kind === "gate");
    expect(g3).toMatchObject({ deliveryApproval: true });
  });

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

  // Num caso real, o deploy declarado saiu com 3 («há unidade que só você publica»). O item tem de
  // PEDIR o dono, não anunciar falha; e o Jido não o pega: republicar sem o dono publicar a unidade só repete o 3.
  it("deploy que PRECISA DO DONO (fase needs-human): item marcado, rótulo honesto, fora do alcance do Jido", () => {
    const waiting = card({
      status: "release",
      qaPassed: true,
      findings: [
        {
          id: DEPLOY_FAILURE_FINDING_ID,
          lens: "general",
          severity: "high",
          status: "open",
          title: "Aguardando o dono: uma unidade só ele publica",
          suggestion: "worker-api → deploy-tool bookshop --unit=worker-api",
          deployPhase: "needs-human",
        },
      ],
    });
    const demand = cardDemands(waiting, config, "b").find((d) => d.type === "deploy-failed");
    expect(demand?.label).toBe("Aguardando o dono: uma unidade só ele publica");
    const item = cardCockpitItems(waiting, config, "b").find((i) => i.kind === "deploy-failed");
    expect(item).toBeTruthy();
    expect(item!.kind === "deploy-failed" && item!.needsHuman).toBe(true);
    expect(item!.kind === "deploy-failed" && item!.suggestion).toContain("--unit=worker-api");
    expect(isCopilotActionable(item!, "copiloto")).toBe(false);
    expect(isCopilotActionable(item!, "autonomo")).toBe(false);
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

  it("EXCLUDES a 'cancelled' outcome — a deliberate operator cancel is never a stuck demand (story-ex0139)", () => {
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

describe("dedupeCaptureLanes — captura falhada não aparece nos 2 lanes (bug story-ex0199)", () => {
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

// story-ex0062 — findings de fase de ENTREGA morrem quando o card VOLTA para implementação: um
// `deploy-failure` aberto descreve o ciclo de entrega MORTO e ficava mentindo na UI ("Republicar"/
// "Release falhou") sobre um card com run de implementação ativo (num caso real).
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

// B2 (auditoria do Inbox) — o efeito de entrada recusado/que lançou deixa `entry-effect-failed` no card.
// O Inbox o projeta como UM item acionável — e não mais como o «Nada a aprovar aqui» do gate (o card não espera
// aprovação, espera o conserto do efeito) nem como aviso genérico («registrar como conhecido» não conserta nada).
describe("B2 — o efeito de entrada que falhou é UM item acionável", () => {
  const cfgDeploy = {
    id: "b",
    name: "B",
    statuses: [
      { id: "release", name: "Liberar", autorun: false },
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", terminal: true, gate: "hasDeployProof" },
    ],
  } as unknown as BoardConfig;
  const failed = {
    id: "entry-effect-failed",
    lens: "general",
    severity: "high",
    title: "A publicação não começou",
    detail: "deploy.kind=command recusado",
    status: "open",
  };

  it("card em Publicar com o finding aberto ⇒ item `effect-failed` (travado), sem gate e sem aviso genérico", () => {
    const c = card({ status: "deploy", stagedAt: "2026-09-27", findings: [failed] });
    const items = cardCockpitItems(c, cfgDeploy, "b");
    expect(items.map((i) => i.kind)).toEqual(["effect-failed"]);
    expect(items[0]).toMatchObject({ lane: "travado", severity: "high", effect: "promote-and-deploy", stepName: "Publicar", detail: "deploy.kind=command recusado" });
    const demands = cardDemands(c, cfgDeploy, "b");
    expect(demands.map((d) => d.type)).toEqual(["effect-failed"]);
  });

  it("fora de um passo com efeito de entrada ⇒ o finding é história, nenhum item", () => {
    const c = card({ status: "release", findings: [failed] });
    expect(cardCockpitItems(c, cfgDeploy, "b").some((i) => i.kind === "effect-failed" || i.kind === "finding")).toBe(false);
  });
});

// Paradas por recurso, fatia 1 — o vigia deixa `card-stalled` num card parado num passo
// em que o próximo ator é o SISTEMA, sem ninguém cuidando. O Inbox o projeta como UM item (`stalled`) — nunca como o
// gate «aprovar» (não há o que aprovar) nem como aviso genérico («registrar como conhecido» não destrava nada).
describe("paradas por recurso — o card parado sem ninguém cuidando é UM item (`stalled`)", () => {
  const cfgStall = {
    id: "b",
    name: "B",
    statuses: [
      { id: "desenvolver", name: "Desenvolver", autorun: false, trigger: "harness-do" },
      { id: "release", name: "Liberar", autorun: false },
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", terminal: true, gate: "hasDeployProof" },
    ],
  } as unknown as BoardConfig;
  const stalled = {
    id: CARD_STALLED_FINDING_ID,
    lens: "general",
    severity: "high",
    title: "Parado em «Publicar» sem ninguém cuidando",
    detail: "Parado desde ontem. O sistema refez o passo uma vez e abriu o conserto story-fix1.",
    status: "open",
  };

  it("num passo com ação automática ⇒ item `stalled` (travado, com o que refazer), sem gate e sem aviso genérico", () => {
    const c = card({ status: "deploy", stagedAt: "2026-09-27", findings: [stalled] });
    const items = cardCockpitItems(c, cfgStall, "b");
    expect(items.map((i) => i.kind)).toEqual(["stalled"]);
    expect(items[0]).toMatchObject({
      id: "story-x:stalled",
      lane: "travado",
      severity: "high",
      findingId: CARD_STALLED_FINDING_ID,
      findingTitle: stalled.title,
      findingDetail: stalled.detail,
      stepName: "Publicar",
      retryable: true,
      effect: "promote-and-deploy",
    });
    const demands = cardDemands(c, cfgStall, "b");
    expect(demands.map((d) => d.type)).toEqual(["stalled"]);
    expect(demands[0]).toMatchObject({ severity: "high", label: stalled.title, itemId: "story-x:stalled" });
  });

  it("num passo SEM ação automática (o card conduzido) ⇒ o mesmo item, sem nada a refazer no lugar", () => {
    const { detail: _detail, ...bare } = stalled;
    const c = card({ status: "desenvolver", reviewedAt: "2026-09-27", findings: [bare] });
    const items = cardCockpitItems(c, cfgStall, "b");
    expect(items.map((i) => i.kind)).toEqual(["stalled"]);
    expect(items[0]).toMatchObject({ stepName: "Desenvolver", retryable: false, findingDetail: null });
    expect("effect" in items[0]).toBe(false);
    expect(cardDemands(c, cfgStall, "b").map((d) => d.type)).toEqual(["stalled"]);
  });

  it("o `since` é quando o card entrou no passo", () => {
    const entered = "2026-09-30T14:03:00.000Z";
    const c = card({ status: "deploy", findings: [stalled] });
    expect(cardCockpitItems(c, cfgStall, "b", { stepEnteredAt: new Map([["story-x", entered]]) })[0].since).toBe(entered);
  });

  it("achado fechado, ou card num passo terminal ⇒ nenhum item e nenhuma demanda", () => {
    const closed = card({ status: "deploy", findings: [{ ...stalled, status: "fixed" }] });
    expect(cardCockpitItems(closed, cfgStall, "b").some((i) => i.kind === "stalled")).toBe(false);
    expect(cardDemands(closed, cfgStall, "b").some((d) => d.type === "stalled")).toBe(false);
    const terminal = card({ status: "concluida", findings: [stalled] });
    expect(cardCockpitItems(terminal, cfgStall, "b")).toEqual([]);
    expect(cardDemands(terminal, cfgStall, "b")).toEqual([]);
  });

  it("nenhum tier do Jido acorda por ele, e ele não é recuperação do Jido (o vigia já refez e já abriu o conserto)", () => {
    const item = cardCockpitItems(card({ status: "deploy", findings: [stalled] }), cfgStall, "b")[0];
    for (const tier of ["chat", "copiloto", "autonomo"] as const) {
      expect(isCopilotActionable(item, tier), tier).toBe(false);
      expect(isCopilotActionable(item, tier, { businessOnly: true }), `${tier} só-negócio`).toBe(false);
    }
    expect(recoveryRetryLimit("stalled")).toBe(0);
  });
});

// ── B21 (auditoria do Inbox) — UMA tentativa de entrega, dona do fluxo de entrega ─────────────────
// `deployFiredAt`, `deployTargets` e o `deploy-unproven` aberto descrevem UMA tentativa. Só o fluxo de entrega os
// escrevia e só o settle/o revert os limpavam: um card MOVIDO para fora de Publicar (à mão, MCP, gaveta, reabertura,
// descontinuação) levava o carimbo junto — e o Inbox mostrava, no mesmo card, «deploy sem confirmação» (escalar
// só) ao lado de «Aprovar & avançar → Publicar» (num caso real).
describe("B21 — o watchdog de publicação só existe no passo de publicação", () => {
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const cfgB21 = {
    ...config,
    statuses: [...config.statuses.filter((s) => s.id !== "concluida"),
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" as const },
      { id: "concluida", name: "No ar", terminal: true, gate: "hasDeployProof" as const }],
  } as BoardConfig;

  it("para TODO status que não é o de publicação, um card com o carimbo velho não gera item nem demanda de watchdog", () => {
    for (const s of cfgB21.statuses.filter((x) => x.onEnter !== "promote-and-deploy")) {
      const c = { ...card({ status: s.id }), deployFiredAt: new Date(NOW - 3 * 3_600_000).toISOString() };
      expect(cardCockpitItems(c, cfgB21, "b", { now: NOW }).some((i) => i.kind === "deploy-unsettled"), s.id).toBe(false);
      expect(cardDemands(c, cfgB21, "b", { now: NOW }).some((d) => d.type === "deploy-unsettled"), s.id).toBe(false);
    }
  });
});

describe("B21 — exitStepAttempt: sair do passo encerra a tentativa (a regra da chokepoint de escrita)", () => {
  const cfgX = {
    id: "b",
    name: "B",
    statuses: [
      { id: "release", name: "Liberar", autorun: false },
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", terminal: true, gate: "hasDeployProof" },
    ],
  } as unknown as BoardConfig;
  const unproven = { id: DEPLOY_UNPROVEN_FINDING_ID, lens: "general", severity: "high", title: "Publicado sem prova", status: "open" };
  const inDeploy = (over: Record<string, unknown> = {}) =>
    ({ ...card({ status: "deploy", findings: [unproven] }), deployFiredAt: "2026-09-27T22:27:46.743Z", deployTargets: ["alvo"], ...over }) as Card;

  it("sair de Publicar por qualquer caminho limpa o carimbo, os alvos e fecha o `deploy-unproven`", () => {
    const prev = inDeploy();
    const next = exitStepAttempt(prev, { ...prev, status: "release" }, cfgX, "2026-09-28");
    expect(next).not.toBeNull();
    expect(next!.deployFiredAt).toBeUndefined();
    expect(next!.deployTargets).toBeUndefined();
    const f = next!.findings.find((x) => x.id === DEPLOY_UNPROVEN_FINDING_ID)!;
    expect(f.status).toBe("fixed");
    expect(f.statusBy).toBe("system:saiu-de-publicar");
  });

  it("um `deploy-failure` aberto mantém os ALVOS (a reconciliação por evidência precisa deles)", () => {
    const failure = { id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "Deploy falhou", status: "open" };
    const prev = inDeploy();
    const next = exitStepAttempt(prev, { ...prev, status: "release", findings: [...prev.findings, failure] as Card["findings"] }, cfgX, "2026-09-28");
    expect(next!.deployTargets).toEqual(["alvo"]);
    expect(next!.deployFiredAt).toBeUndefined();
  });

  it("o AVANÇO do próprio settle (que acabou de carimbar a prova) não é tocado", () => {
    const prev = inDeploy({ findings: [] });
    const settled = { ...prev, status: "concluida", deployFiredAt: undefined, deployProof: { sha: "abc", targets: ["alvo"], at: "2026-09-28T00:00:00Z", source: "settle-webhook" } } as unknown as Card;
    expect(exitStepAttempt(prev, settled, cfgX, "2026-09-28")).toBeNull();
  });

  it("sem mudança de status, ou fora do passo de publicação sem nada a fechar ⇒ null (nenhuma escrita extra)", () => {
    const prev = inDeploy();
    expect(exitStepAttempt(prev, { ...prev, title: "novo" }, cfgX, "2026-09-28")).toBeNull();
    const plain = card({ status: "release" });
    expect(exitStepAttempt(plain, { ...plain, status: "deploy" }, cfgX, "2026-09-28")).toBeNull();
  });

  it("a parada sem ninguém cuidando é do passo que o card deixou: mudar de status a fecha, assinada pelo sistema", () => {
    const stalled = { id: CARD_STALLED_FINDING_ID, lens: "general", severity: "high", title: "Parado em «Liberar» sem ninguém cuidando", status: "open" };
    const other = { id: "w1", lens: "general", severity: "medium", title: "aviso", status: "open" };
    // num passo SEM efeito de entrada (o card conduzido): a regra não depende do passo de publicação
    const prev = { ...card({ status: "release", findings: [stalled, other] }) } as Card;
    const next = exitStepAttempt(prev, { ...prev, status: "deploy" }, cfgX, "2026-10-01");
    expect(next!.findings.find((x) => x.id === CARD_STALLED_FINDING_ID)).toMatchObject({ status: "fixed", statusBy: "system:saiu-do-passo", statusAt: "2026-10-01" });
    expect(next!.findings.find((x) => x.id === "w1")?.status).toBe("open");
    // sem mudar de status o card segue parado: nada a fechar
    expect(exitStepAttempt(prev, { ...prev, title: "novo" }, cfgX, "2026-10-01")).toBeNull();
  });

  it("a falha do efeito de entrada (B2) é da etapa que o card deixou: mudar de status a fecha", () => {
    const failed = { id: ENTRY_EFFECT_FAILED_FINDING_ID, lens: "general", severity: "high", title: "A publicação não aconteceu", status: "open" };
    const prev = { ...card({ status: "deploy", findings: [failed] }) } as Card;
    const next = exitStepAttempt(prev, { ...prev, status: "release" }, cfgX, "2026-09-28");
    expect(next!.findings.find((x) => x.id === ENTRY_EFFECT_FAILED_FINDING_ID)?.status).toBe("fixed");
  });
});

describe("B21 — staleDeliveryStampSweep: o carimbo velho fora de Publicar, na varredura do serviço", () => {
  const cfgS = {
    id: "b",
    name: "B",
    statuses: [
      { id: "release", name: "Liberar", autorun: false },
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", terminal: true, gate: "hasDeployProof" },
    ],
  } as unknown as BoardConfig;
  const stamped = (status: string, over: Record<string, unknown> = {}) =>
    ({ ...card({ status }), deployFiredAt: "2026-07-01T10:00:00.000Z", deployTargets: ["alvo"], ...over }) as Card;

  it("terminal COM prova ⇒ o carimbo sai (a prova já diz o que o carimbo dizia)", () => {
    const next = staleDeliveryStampSweep(stamped("concluida", { deployProof: { sha: "a", targets: ["alvo"], at: "x", source: "settle-webhook" } }), cfgS, "2026-09-28");
    expect(next!.deployFiredAt).toBeUndefined();
    expect(next!.findings).toEqual([]);
  });

  it("terminal SEM prova ⇒ uma NOTA informativa (registrada, fora do Inbox) — nunca um item vermelho", () => {
    const next = staleDeliveryStampSweep(stamped("concluida"), cfgS, "2026-09-28");
    expect(next!.deployFiredAt).toBeUndefined();
    const note = next!.findings[0];
    expect(note.status).toBe("acknowledged");
    expect(note.severity).toBe("low");
    expect(cardCockpitItems(next!, cfgS, "b").length).toBe(0);
  });

  it("fora de Publicar e não terminal (o caso típico) ⇒ a tentativa é encerrada, como na chokepoint", () => {
    const next = staleDeliveryStampSweep(stamped("release"), cfgS, "2026-09-28");
    expect(next!.deployFiredAt).toBeUndefined();
    expect(next!.deployTargets).toBeUndefined();
  });

  it("no passo de publicação o carimbo é VIVO ⇒ nada a varrer; sem carimbo ⇒ nada", () => {
    expect(staleDeliveryStampSweep(stamped("deploy"), cfgS, "2026-09-28")).toBeNull();
    expect(staleDeliveryStampSweep(card({ status: "concluida" }), cfgS, "2026-09-28")).toBeNull();
  });
});

// B3 (auditoria do Inbox) — o item do watchdog carrega o estado do ÚLTIMO deploy dos alvos do card (o
// registry do serviço), para o Inbox saber se re-publicar é seguro (nada rodando) ou se o deploy ainda roda (D6).
describe("B3 — foldLastDeploy: o watchdog sabe se o deploy do card ainda roda", () => {
  const item = (over: Record<string, unknown> = {}) =>
    ({ id: "c1:deploy-unsettled", kind: "deploy-unsettled", boardId: "b", cardId: "c1", cardTitle: "T", status: "deploy", lane: "travado", severity: "high", deployFiredAt: "2026-09-27T22:27:46.743Z", ...over }) as CockpitItem;
  const cardsById = new Map([["c1", { ...card({ status: "deploy" }), id: "c1", deployTargets: ["api", "face"] } as Card]]);

  it("algum alvo rodando ⇒ running; senão o término mais recente; nenhum job conhecido ⇒ null", () => {
    const running = foldLastDeploy([item()], cardsById, (t) => (t === "face" ? { status: "running" as const } : { status: "done" as const, finishedAt: 1, exitCode: 0 }));
    expect(running[0]).toMatchObject({ lastDeploy: { target: "face", status: "running" } });
    const done = foldLastDeploy([item()], cardsById, (t) => ({ status: t === "api" ? ("failed" as const) : ("done" as const), finishedAt: t === "api" ? 2_000 : 1_000, exitCode: t === "api" ? 1 : 0 }));
    expect(done[0]).toMatchObject({ lastDeploy: { target: "api", status: "failed", exitCode: 1, finishedAt: new Date(2_000).toISOString() } });
    const none = foldLastDeploy([item()], cardsById, () => undefined);
    expect((none[0] as { lastDeploy?: unknown }).lastDeploy).toBeNull();
  });

  it("card sem alvos (self-deploy, sem registry) ou item com `held` ⇒ intocado", () => {
    const noTargets = new Map([["c1", { ...card({ status: "deploy" }), id: "c1" } as Card]]);
    expect("lastDeploy" in foldLastDeploy([item()], noTargets, () => undefined)[0]).toBe(false);
    const held = item({ held: { title: "x" } });
    expect(foldLastDeploy([held], cardsById, () => undefined)[0]).toBe(held);
  });
});

// ── B6/B7 (auditoria do Inbox) — a morte de um run é UM item ────────────────────────────────────────
// Num caso real, o run foi morto por SIGTERM logo depois do aceite da triagem; o Inbox
// mostrou «Destravar run: Run falhou: exit» («espera há muitas horas» — o `since` cortado no dia, de uma morte de minutos
// antes) E «Triar achado · run morreu: exit» com «Registrar como conhecido / Marcar resolvido / Não corrigir»,
// nenhum dos quais re-tenta — e «Marcar resolvido» apagava o diagnóstico com o card ainda morto.
describe("B7 — o item travado: fim exato, etapa, e some quando o card sai da coluna", () => {
  const f = { board: "b", cardId: "story-x", reason: "exit" as const, detail: "exit", at: Date.parse("2026-09-27T23:07:28Z"), trigger: "harness-enrich" };

  it("`since` é o ISO completo do fim da execução (não o dia)", () => {
    const [item] = stuckItemsFromFailures([f], mkCardsById([card({ status: "enriquecer" })]), config, "b");
    expect(item.since).toBe("2026-09-27T23:07:28.000Z");
    expect(item.trigger).toBe("harness-enrich");
  });

  it("o card saiu da coluna DEPOIS da morte (transição mais nova) ⇒ o item resolve; transição antiga não", () => {
    const cards = mkCardsById([card({ status: "enriquecer" })]);
    const after = new Map([["story-x", "2026-09-27T23:30:00.000Z"]]);
    expect(stuckItemsFromFailures([f], cards, config, "b", { lastTransitionAt: after })).toHaveLength(0);
    const before = new Map([["story-x", "2026-09-27T23:00:00.000Z"]]);
    expect(stuckItemsFromFailures([f], cards, config, "b", { lastTransitionAt: before })).toHaveLength(1);
  });
});

describe("B6 — os diagnósticos do sistema viram EVIDÊNCIA do item travado, não um segundo item", () => {
  const stuck = { id: "story-x:stuck:exit", kind: "stuck", boardId: "b", cardId: "story-x", cardTitle: "T", status: "enriquecer", lane: "travado", severity: "high", outcome: "exit" } as CockpitItem;
  const findingItem = (findingId: string, cardId = "story-x") =>
    ({ id: `${cardId}:f:${findingId}`, kind: "finding", boardId: "b", cardId, cardTitle: "T", status: "enriquecer", lane: "pergunta", severity: "high", findingId, title: `f ${findingId}`, findingSeverity: "high" }) as CockpitItem;
  const cardsById = new Map([
    ["story-x", { ...card({ status: "enriquecer" }), findings: [{ id: "run-death", lens: "general", severity: "high", title: "run morreu: exit", detail: "morto (SIGTERM)", status: "open", failureClass: "infra" }] } as Card],
  ]);

  it("run-death (e budget-cut) com um item travado no MESMO card ⇒ o aviso some e vira a evidência do travado", () => {
    const out = foldRunDiagnostics([stuck, findingItem("run-death"), findingItem("budget-cut")], cardsById);
    expect(out.map((i) => i.kind)).toEqual(["stuck"]);
    expect(out[0]).toMatchObject({ evidence: { findingId: "run-death", title: "run morreu: exit", detail: "morto (SIGTERM)", failureClass: "infra" } });
  });

  it("sem item travado ⇒ o diagnóstico continua visível (nunca some em silêncio); outros achados de sistema ficam", () => {
    expect(foldRunDiagnostics([findingItem("run-death")], cardsById).map((i) => i.kind)).toEqual(["finding"]);
    const out = foldRunDiagnostics([stuck, findingItem("conductor-dispatch"), findingItem("deploy-settled-out-of-status")], cardsById);
    expect(out.map((i) => (i.kind === "finding" ? i.findingId : i.kind))).toEqual(["stuck", "conductor-dispatch", "deploy-settled-out-of-status"]);
  });
});

// B11 (auditoria do Inbox) — a demanda (Kanban, /perguntas, push) aponta o ITEM do Inbox pelo mesmo id
// que a projeção do Inbox constrói — uma construção só; antes o link era `?focus=<cardId>` (o primeiro item do card).
describe("B11 — cada demanda carrega o id do ITEM correspondente do Inbox", () => {
  const cfgB11 = {
    ...config,
    statuses: [...config.statuses.filter((s) => s.id !== "concluida"),
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" as const },
      { id: "concluida", name: "No ar", terminal: true }],
  } as BoardConfig;
  const NOW = Date.parse("2026-09-28T12:00:00Z");
  const cases: Card[] = [
    card({ status: "grill", questions: [q("q1", "open"), q("q2", "open")] }),
    card({ status: "revisao", reviewedAt: "2026-09-20", findings: [finding("b1", "blocker", "open")] }),
    card({ status: "triage", needsHumanReview: true }),
    card({ status: "revisao", reviewedAt: "2026-09-20" }),
    card({ status: "release", findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "falhou", status: "open" }] }),
    card({ status: "release", stagedAt: "2026-09-01" }),
    { ...card({ status: "deploy" }), deployFiredAt: new Date(NOW - 3_600_000).toISOString() } as Card,
  ];

  it.each(cases.map((c) => [c.status, c] as const))("%s", (_s, c) => {
    const ids = new Set(cardCockpitItems(c, cfgB11, "b", { now: NOW }).map((i) => i.id));
    const demands = cardDemands(c, cfgB11, "b", { now: NOW });
    expect(demands.length).toBeGreaterThan(0);
    for (const d of demands) expect(ids.has(d.itemId ?? ""), `${d.type} → ${d.itemId}`).toBe(true);
  });
});

// ── B9 (parte) — os dois modelos de «precisa de você» param de discordar até a onda 2 unificá-los ────────────────
describe("B9 — a demanda (Kanban, /perguntas, push) concorda com o item do Inbox", () => {
  const cfgB9 = {
    ...config,
    statuses: [...config.statuses, { id: "com-design", name: "Aprovar design", gate: "hasWireframe" as const, autorun: false }],
  } as BoardConfig;

  it("no passo de aprovar design não há demanda `gate` — o Inbox só mostra o item `design` (com canvas), nunca o gate", () => {
    const c = card({ status: "com-design", wireframeChosen: "s1" });
    expect(cardDemands(c, cfgB9, "b").some((d) => d.type === "gate")).toBe(false);
    expect(cardCockpitItems(c, cfgB9, "b").some((i) => i.kind === "gate")).toBe(false);
  });

  it("a severidade da demanda é a do item correspondente (deploy-failed era `critical` × `high`)", () => {
    const failed = card({ status: "release", findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "falhou", status: "open" }] });
    const d = cardDemands(failed, config, "b").find((x) => x.type === "deploy-failed")!;
    const i = cardCockpitItems(failed, config, "b").find((x) => x.kind === "deploy-failed")!;
    expect(d.severity).toBe(i.severity);
  });

});

// ── F9 / B14 (auditoria do Inbox) — todo item tem um `since` exato, e a raia ordena por severidade e idade
// Revisões de triagem de um board esperavam há semanas e não mostravam idade nenhuma (o
// item `review` não tinha `since`); gate, blocker, finding, deploy-failed e conflito também não — e a ordenação
// «mais velho primeiro» os empurrava para o fim. A ordem da raia ignorava a severidade.
describe("F9/B14 — o `since` de cada item e a ordem da raia", () => {
  const entered = "2026-07-08T14:03:00.000Z";
  const stepEnteredAt = new Map([["story-x", entered]]);
  const cfgF9 = {
    ...config,
    statuses: [...config.statuses.filter((s) => s.id !== "concluida"),
      { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" as const },
      { id: "concluida", name: "No ar", terminal: true }],
  } as BoardConfig;
  const effectFailed = { id: ENTRY_EFFECT_FAILED_FINDING_ID, lens: "general", severity: "high", title: "x", status: "open" };

  it("itens do card (review, blocker, aviso, gate, deploy-failed, efeito) ⇒ quando o card ENTROU no passo", () => {
    const cases: Card[] = [
      card({ status: "triage", needsHumanReview: true }),
      card({ status: "revisao", reviewedAt: "2026-09-20", findings: [finding("b1", "blocker", "open"), finding("w1", "medium", "open")] }),
      card({ status: "release", findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "f", status: "open" }] }),
      card({ status: "deploy", findings: [effectFailed] }),
    ];
    for (const c of cases) {
      const items = cardCockpitItems(c, cfgF9, "b", { stepEnteredAt }).filter((i) => ["review", "blocker", "finding", "gate", "deploy-failed", "effect-failed"].includes(i.kind));
      expect(items.length, c.status ?? "").toBeGreaterThan(0);
      for (const i of items) expect(i.since, `${i.kind}@${c.status}`).toBe(entered);
    }
  });

  it("sem registro da entrada no passo ⇒ a criação do card (nunca vazio)", () => {
    const c = { ...card({ status: "triage", needsHumanReview: true }), created: "2026-07-08" } as Card;
    expect(cardCockpitItems(c, cfgF9, "b").find((i) => i.kind === "review")?.since).toBe("2026-07-08");
  });

  it("conflito e merge-failed: o ISO completo do momento da entrada na fila (não o dia)", () => {
    const snap = { entries: [
      { runId: "r1", board: "b", cardId: "story-x", branch: "run/r1", status: "conflict", enqueuedAt: Date.parse("2026-09-27T10:00:00Z"), mergeStartedAt: Date.parse("2026-09-27T10:05:00Z"), mergeEndedAt: Date.parse("2026-09-27T10:06:30Z") },
    ], processing: false } as unknown as MergeQueueSnapshot;
    const cardsById = mkCardsById([card({ status: "revisao" })]);
    expect(conflictItemsFromSnapshot(snap, cardsById, config, "b")[0].since).toBe("2026-09-27T10:06:30.000Z");
    const failed = { ...snap, entries: [{ ...snap.entries[0], status: "failed" }] } as unknown as MergeQueueSnapshot;
    expect(mergeFailedItemsFromSnapshot(failed, cardsById, config, "b")[0].since).toBe("2026-09-27T10:06:30.000Z");
  });

  it("dentro da raia: severidade primeiro, idade depois (o mais velho primeiro)", () => {
    const old = { ...card({ status: "revisao", reviewedAt: "2026-09-01", findings: [finding("w1", "low", "open")] }), id: "story-old" } as Card;
    const recent = { ...card({ status: "revisao", reviewedAt: "2026-09-01", findings: [finding("w2", "high", "open")] }), id: "story-new" } as Card;
    const map = new Map([["story-old", "2026-07-01T00:00:00.000Z"], ["story-new", "2026-09-27T00:00:00.000Z"]]);
    const findings = boardCockpitItems([old, recent], config, "b", { stepEnteredAt: map }).filter((i) => i.kind === "finding");
    expect(findings.map((i) => i.cardId)).toEqual(["story-new", "story-old"]); // high antes de low, apesar da idade
  });
});

describe("isWorkingSession — só sessão viva conta como trabalho no card", () => {
  it("com batimento recente e sem óbito: sim; com óbito carimbado ou sem batimento: não", async () => {
    const { isWorkingSession } = await import("./cockpit-collect");
    const { isSessionAlive } = await import("./runner/session-liveness");
    const now = Date.parse("2026-03-02T12:00:00Z");
    expect(isWorkingSession({ heartbeatAt: "2026-03-02T11:59:00Z" }, now, isSessionAlive)).toBe(true);
    expect(isWorkingSession({ heartbeatAt: "2026-03-02T11:59:00Z", endedAt: "2026-03-02T11:59:30Z" }, now, isSessionAlive)).toBe(false);
    expect(isWorkingSession({ heartbeatAt: "2026-03-01T00:00:00Z" }, now, isSessionAlive)).toBe(false);
  });
});

// ── Fase 3 — os itens novos: as alavancas da Esteira e os avisos do host (projeções PURAS) ──────────────────────
describe("fase 3 — publishHeldItems / stageIdleItem / capacityLatchItem / hostHealthItem / pushOffItem", () => {
  const NOW3 = Date.parse("2026-09-28T20:00:00Z");
  it("o pedido segurado DESTE board vira item (o que só espera, sem `heldSince`, não); `blocked` é a régua passada", () => {
    const rows = [
      { id: "pub-ex9001", board: "loja", status: "waiting", heldSince: "2026-09-28T18:00:00Z", heldCount: 12, reason: "outra sessão" },
      { id: "pub-ex9002", board: "loja", status: "waiting" },
      { id: "pub-ex9003", board: "outro", status: "waiting", heldSince: "2026-09-28T18:00:00Z" },
      { id: "pub-ex9004", board: "loja", status: "published", heldSince: "2026-09-28T18:00:00Z" },
    ];
    const items = publishHeldItems(rows, "loja", (r) => r.id === "pub-ex9001");
    expect(items.map((i) => [i.id, i.blocked, i.cardId, i.reason])).toEqual([["pub:pub-ex9001", true, "", "outra sessão"]]);
  });
  it("entregas paradas: só num board manual, sem pedido aberto, com a mais antiga além do teto", () => {
    const frontier = { releaseMode: "manual", canPublish: true, stagedTotal: 3, staged: [{ at: "2026-09-28T19:00:00Z" }, { at: "2026-09-27T10:00:00Z" }] };
    expect(stageIdleItem(frontier, { boardId: "loja", now: NOW3, openRequest: false })).toMatchObject({ id: "stage:loja", pending: 3, hours: 34 });
    expect(stageIdleItem(frontier, { boardId: "loja", now: NOW3, openRequest: true })).toBeNull();
    expect(stageIdleItem({ ...frontier, releaseMode: "auto" }, { boardId: "loja", now: NOW3, openRequest: false })).toBeNull();
    expect(stageIdleItem({ ...frontier, staged: [{ at: "2026-09-28T10:00:00Z" }] }, { boardId: "loja", now: NOW3, openRequest: false })).toBeNull();
    expect(stageIdleItem({ ...frontier, organizeOnly: true }, { boardId: "loja", now: NOW3, openRequest: false })).toBeNull();
  });
  it("a trava, a saúde vermelha e o aviso desligado: um item por episódio, null quando não há", () => {
    expect(capacityLatchItem({ level: "soft", reason: "7 dias em 93%", trippedBy: "auto:week", at: NOW3, source: "file" }, "loja")).toMatchObject({ id: `host:latch:${NOW3}`, halt: false });
    expect(capacityLatchItem(null, "loja")).toBeNull();
    const rec = { at: "2026-09-28T19:55:00Z", signals: { S1: { level: "red", detail: "4 parados" }, S2: { level: "ok" } } };
    expect(hostHealthItem(rec, "loja", (id) => `sinal ${id}`)).toMatchObject({ id: "host:health:S1", signals: [{ id: "S1", label: "sinal S1", detail: "4 parados" }] });
    expect(hostHealthItem({ ...rec, signals: { S2: { level: "amber" } } }, "loja", (id) => id)).toBeNull();
    // quick-fix health-red: o item carrega o que o tick FEZ por cada sinal (o card, ou por que não abriu)
    const ticked = {
      at: rec.at,
      signals: { S6: { level: "red" }, S7: { level: "red" }, S5: { level: "red" } },
      cards: { S6: { outcome: "skipped", reason: "board só de organização" }, S7: { outcome: "created", cardId: "story-ex9201" } },
    };
    expect(hostHealthItem(ticked, "loja", (id) => id)?.signals).toEqual([
      { id: "S6", label: "S6", detail: "", noCard: "board só de organização" },
      { id: "S7", label: "S7", detail: "", card: "story-ex9201" },
      { id: "S5", label: "S5", detail: "" },
    ]);
    expect(pushOffItem({ configured: true, subscriptions: 0 }, "loja")).toMatchObject({ id: "host:push-off" });
    expect(pushOffItem({ configured: true, subscriptions: 1 }, "loja")).toBeNull();
    expect(pushOffItem({ configured: false, subscriptions: 0 }, "loja")).toBeNull();
    // «Agora não»: o dono que dispensou a oferta não é lembrado de novo
    expect(pushOffItem({ configured: true, subscriptions: 0, dismissed: true }, "loja")).toBeNull();
  });
  it("o card CONDUZIDO parado leva a marca `conducted` (o Inbox oferece as saídas do operador)", () => {
    const config = { id: "loja", name: "Loja", statuses: [{ id: "desenvolver", name: "Desenvolver", trigger: "harness-do" }, { id: "feito", name: "Feito", terminal: true }] } as unknown as BoardConfig;
    const stalled = card({
      type: "story", title: "Busca por autor", status: "desenvolver", routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-28", driver: "conductor" },
      findings: [{ id: CARD_STALLED_FINDING_ID, lens: "general", severity: "high", status: "open", title: "O condutor deste card encerrou e ninguém assumiu" }],
    });
    const item = cardCockpitItems(stalled, config, "loja", { now: NOW3 }).find((i) => i.kind === "stalled");
    expect(item).toMatchObject({ kind: "stalled", conducted: true });
  });
});

describe("fase 6 — o diagnóstico da Sentinela no Inbox", () => {
  it("um item por causa: o 1º card ancora (título do card), causa de host fica sem âncora; nenhum tier acorda por ele", () => {
    const rows = [
      { id: "sentinel:a", causeKey: "a", causeId: "stalled-run-1", title: "Execução parada ou morta", diagnosis: "d", cardIds: ["story-ex9001", "story-ex9002"], at: "2026-10-07T10:00:00Z", did: "diagnosed" },
      { id: "sentinel:h", causeKey: "h", causeId: "health-red-2", title: "Saúde da ferramenta no vermelho", diagnosis: "S6", cardIds: [], at: "2026-10-07T10:00:00Z", did: "repaired" },
    ];
    const [a, h] = sentinelCockpitItems(rows, "livraria", (id) => (id === "story-ex9001" ? "Catálogo de livros" : undefined));
    expect(a).toMatchObject({ kind: "sentinel", boardId: "livraria", cardId: "story-ex9001", cardTitle: "Catálogo de livros", tried: false, lane: "travado" });
    expect(h).toMatchObject({ cardId: "", cardTitle: "Saúde da ferramenta no vermelho", tried: true });
    expect(AUTONOMO_ACTIONABLE_KINDS.has("sentinel")).toBe(false);
    expect(COPILOT_ACTIONABLE_KINDS.has("sentinel")).toBe(false);
  });
});

// ── fase 7 — o LOTE do condutor: uma parada por lote (entrega, publicação, sessão morta) ─────────────────────────
describe("groupBatchStops — os itens de um lote parados juntos viram UM item do Inbox", () => {
  const withDelivery: BoardConfig = { ...config, statuses: config.statuses.map((s) => (s.id === "revisao" ? { ...s, gate: "hasQaPassed" } : s)) };
  const batch = (lead: string) => ({ id: "lote-ex1", lead, sessionId: "s-ex1", at: "2026-10-07" });
  const item = (id: string, over: Partial<Card> = {}): Card =>
    ({ ...card({ status: "revisao", qaPassed: true }), id, title: `Correção ${id}`, batch: batch("story-ex9001"), body: `## Prova da entrega\n- **O que mudou:** ${id} corrigido`, ...over }) as Card;

  it("a aprovação da entrega dos itens do mesmo lote no mesmo passo: UM item, o do líder, com a prova de cada um", () => {
    const cards = [item("story-ex9002"), item("story-ex9001"), item("story-ex9003")];
    const gates = boardCockpitItems(cards, withDelivery, "b").filter((i) => i.kind === "gate");
    expect(gates).toHaveLength(1);
    const g = gates[0];
    if (g.kind !== "gate") throw new Error("gate");
    expect(g).toMatchObject({ cardId: "story-ex9001", batchId: "lote-ex1", deliveryApproval: true, proof: expect.stringContaining("story-ex9001 corrigido") });
    expect(g.alsoCards?.map((c) => c.cardId)).toEqual(["story-ex9002", "story-ex9003"]);
    expect(g.alsoCards?.[0].proof).toContain("story-ex9002 corrigido");
  });

  it("um item do lote em OUTRO passo segue separado; card sem lote não muda", () => {
    const cards = [item("story-ex9001"), item("story-ex9002", { status: "release" }), { ...card({ status: "revisao", qaPassed: true }), id: "story-ex9009" } as Card];
    const gates = boardCockpitItems(cards, withDelivery, "b").filter((i) => i.kind === "gate");
    expect(gates.map((g) => g.cardId).sort()).toEqual(["story-ex9001", "story-ex9002", "story-ex9009"]);
    expect(gates.every((g) => g.kind === "gate" && !g.alsoCards)).toBe(true);
    expect(gates.find((g) => g.cardId === "story-ex9009")).not.toHaveProperty("batchId");
  });

  it("a sessão do lote que morreu: UM aviso que nomeia todos os itens (eles esperam o operador, como o líder)", () => {
    const stalledFinding = { id: CARD_STALLED_FINDING_ID, lens: "general", severity: "high", status: "open", title: "O condutor deste card encerrou e ninguém assumiu" };
    const driver = { skips: [], decidedBy: "rules", decidedAt: "2026-10-07", driver: "conductor" };
    const dead = (id: string) => item(id, { status: "grill", qaPassed: false, findings: [stalledFinding], routing: driver } as unknown as Partial<Card>);
    const stalled = boardCockpitItems([dead("story-ex9003"), dead("story-ex9001"), dead("story-ex9002")], config, "b").filter((i) => i.kind === "stalled");
    expect(stalled).toHaveLength(1);
    const s = stalled[0];
    if (s.kind !== "stalled") throw new Error("stalled");
    expect(s).toMatchObject({ cardId: "story-ex9001", conducted: true, batchId: "lote-ex1" });
    expect(s.alsoCards?.map((c) => c.cardId).sort()).toEqual(["story-ex9002", "story-ex9003"]);
    expect(s.findingTitle).toMatch(/e mais 2 itens do mesmo lote$/);
  });

  it("marca velha (o líder já não carrega o lote) não junta entregas: cada card segue com o seu item", () => {
    const lead = { ...card({ status: "concluida" }), id: "story-ex9001" } as Card; // o líder sem a marca
    const cards = [lead, item("story-ex9002"), item("story-ex9003")];
    const gates = boardCockpitItems(cards, withDelivery, "b").filter((i) => i.kind === "gate");
    expect(gates.map((g) => g.cardId).sort()).toEqual(["story-ex9002", "story-ex9003"]);
    expect(gates.every((g) => g.kind === "gate" && !g.alsoCards && !g.batchId)).toBe(true);
  });

  it("um lote de um item só não dobra nada (sem `alsoCards`)", () => {
    const g = boardCockpitItems([item("story-ex9001")], withDelivery, "b").find((i) => i.kind === "gate");
    expect(g && "alsoCards" in g).toBe(false);
  });
});

describe("batchStopCards / batchApprovalWords", () => {
  it("lista o card do item e os do lote, com a prova; um item sem lote ⇒ []", async () => {
    const { batchStopCards, batchApprovalWords } = await import("./demands");
    const head = { id: "x", kind: "gate", boardId: "b", cardId: "story-ex9001", cardTitle: "A", status: "revisao", lane: "aprovar", severity: "medium", gateLabel: "Aprovar entrega", batchId: "lote-ex1", proof: "p1", alsoCards: [{ cardId: "story-ex9002", cardTitle: "B", proof: "p2" }] } as CockpitItem;
    expect(batchStopCards(head).map((c) => [c.cardId, c.proof])).toEqual([["story-ex9001", "p1"], ["story-ex9002", "p2"]]);
    expect(batchStopCards({ ...head, alsoCards: [] } as CockpitItem)).toEqual([]);
    const words = batchApprovalWords({ id: "advance", label: "Aprovar e publicar", consequence: "Segue até o ar." }, 3);
    expect(words).toMatchObject({ id: "advance", label: "Aprovar e publicar (3 itens)" });
    expect(words.consequence).toMatch(/^Vale para os 3 itens do lote/);
  });
});
