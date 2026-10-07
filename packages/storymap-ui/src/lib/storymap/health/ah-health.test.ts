// O relatório de saúde — cada sinal contra um estado doente INVENTADO e contra as bordas dos limiares.
// A fixture monta o que o Inbox, as raias, os ledgers e a frota diriam num instante ruim; as asserções são os números
// que esse estado implica pela régua declarada de cada sinal, não números ajustados ao código.

import { describe, expect, it } from "vitest";
import {
  coerceHealthSettings,
  computeHealth,
  DEFAULT_HEALTH_SETTINGS,
  DEFAULT_HEALTH_THRESHOLDS,
  episodeCover,
  HEALTH_SIGNAL_IDS,
  healthDelta,
  healthSignalCatalog,
  isOutcomeOption,
  RECORD_DETAIL_MAX,
  recordAsReading,
  redStreaks,
  toHealthRecord,
  type HealthCardOutcome,
  type HealthInboxEntry,
  type HealthInputs,
  type HealthLevel,
  type HealthReading,
  type HealthRecord,
  type HealthReport,
  type HealthSignalId,
} from "./ah-health";

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse("2026-05-19T15:10:20Z");

/** Um estado saudável e vazio: cada teste muda só o que quer provar. */
const green = (over: Partial<HealthInputs> = {}): HealthInputs => ({
  now: NOW,
  inbox: [],
  demandLanes: [],
  cards: [],
  transitions: [],
  deliveredStatuses: { armazem: ["concluida"] },
  publishWaiting: [],
  publishHeld: [],
  fleetKnown: true,
  fleet: [],
  orphanTerminals: [],
  claims: [],
  conductorQueue: [],
  stall: [],
  toolFailures: [],
  attribution: { actions: 100, attributed: 100 },
  touches: { liveStories: 10, technicalTouches: 0, ownerSessionActions: 0 },
  openTechnicalQuestions: [],
  ...over,
});

const level = (r: HealthReport, id: HealthSignalId) => r.signals.find((s) => s.id === id)!;

// ── o estado doente ────────────────────────────────────────────────────────────────────────────────────

const entry = (over: Partial<HealthInboxEntry> & Pick<HealthInboxEntry, "cardId">): HealthInboxEntry => ({
  board: "armazem",
  kind: "deploy-failed",
  bucket: "decidir",
  decider: "owner",
  ownerClass: null,
  floorOnly: false,
  executable: 0,
  followUpAllowed: false,
  ...over,
});

/** Os 6 itens de Decidir e os 36 de Acompanhar do estado doente. */
function inboxSick(): HealthInboxEntry[] {
  const publishParts = ["ex9801", "ex9802", "ex9803"].map((id) => entry({ cardId: `story-${id}` })); // só «como fazer» + «pedir ao Jido»
  const floorQuestions = ["ex9807"].map((id) => entry({ cardId: `story-${id}`, kind: "question", ownerClass: "money", floorOnly: true, executable: 1 })); // uma palavra acendeu o piso de dinheiro
  const payment = entry({ cardId: "story-ex9808", kind: "gate", ownerClass: "money", executable: 2 }); // a única decisão de negócio de verdade
  const humanBoard = [entry({ board: "loja", cardId: "story-ex9809", kind: "stuck", executable: 1 })];
  // Acompanhar: das 24 decisões do sistema só 2 são aceite de triagem de história `user` (o que o dono combinou rever); dos
  // 12 restantes, 4 são do contrato — 1 publicação que o sistema refaz, 1 bloqueio, 1 gate que ele decide, 1 amostra de
  // entrega — e 8 são avisos que nada espera.
  const others = ["deploy-failed", "blocker", "gate", "delivery-audit", ...Array<string>(8).fill("finding")];
  const follow = Array.from({ length: 36 }, (_, i) =>
    entry({
      cardId: `story-ac${i}`,
      kind: i < 24 ? "system-decision" : others[i - 24],
      bucket: "acompanhar",
      decider: "system",
      executable: 0,
      followUpAllowed: i < 2 || (i >= 24 && i < 28),
    }),
  );
  return [...publishParts, ...floorQuestions, payment, ...humanBoard, ...follow];
}

function fixtureSick(): HealthInputs {
  const waiting = ["ex9801", "ex9802", "ex9803", "ex9804", "ex9805"];
  const decidirNest = [...waiting.slice(0, 3), "ex9807", "ex9808"];
  const lastDelivered = Date.parse("2026-05-19T10:02:10Z");
  return green({
    inbox: inboxSick(),
    // a raia «Precisa de você» do armazem: os 5 de Decidir MAIS 3 que entraram por status (release/revisao), sem item no Inbox
    demandLanes: [{ board: "armazem", laneId: "voce", cardIds: [...decidirNest.map((id) => `story-${id}`), "story-ex9804", "story-ex9805", "story-ex9806"] }],
    cards: [{ board: "armazem", cardId: "story-ex9810", status: "corrigir" }, ...Array.from({ length: 47 }, (_, i) => ({ board: "armazem", cardId: `story-ok${i}`, status: "concluida" }))],
    transitions: [
      { board: "armazem", cardId: "story-ex9811", to: "concluida", at: lastDelivered, actor: "system" },
      // ex9810: o ledger parou em release (o arquivo diz corrigir)
      { board: "armazem", cardId: "story-ex9810", to: "deploy", at: Date.parse("2026-05-19T13:20:11Z"), actor: "cascade" },
      { board: "armazem", cardId: "story-ex9810", to: "release", at: Date.parse("2026-05-19T13:20:36Z"), actor: "system" },
      ...Array.from({ length: 47 }, (_, i) => ({ board: "armazem", cardId: `story-ok${i}`, to: "concluida", at: NOW - 30 * HOUR, actor: "system" })),
      // quando cada card que espera publicação voltou a `release` (o deploy revertido)
      ...(
        [
          ["ex9801", "10:41:30"], ["ex9802", "11:05:12"], ["ex9803", "12:20:48"], ["ex9804", "13:02:35"], ["ex9805", "10:55:09"],
        ] as const
      ).map(([id, hhmmss]) => ({ board: "armazem", cardId: `story-${id}`, to: "release", at: Date.parse(`2026-05-19T${hhmmss}Z`), actor: "system" })),
    ],
    publishWaiting: waiting.map((id) => ({ board: "armazem", cardId: `story-${id}` })),
    publishHeld: waiting.slice(0, 3).map((id) => ({ board: "armazem", cardId: `story-${id}`, phase: "needs-human", exitCode: 3 })),
    orphanTerminals: ["agent-conductor-story-ex9803-q7m3"],
    conductorQueue: [{ board: "armazem", cardId: "story-ex9812", queuedAt: Date.parse("2026-05-19T11:52:00Z") }],
    stall: [{ key: "armazem/story-ex9810@corrigir", firstSeenAt: Date.parse("2026-05-19T14:20:40Z"), escalatedAt: Date.parse("2026-05-19T14:48:10Z") }],
    toolFailures: ["2026-05-18T17:40:00Z", "2026-05-19T03:05:00Z", "2026-05-19T09:30:00Z", "2026-05-19T12:15:00Z", "2026-05-19T14:20:00Z"].map((at) => ({ signature: "sandbox:mount-denied", at: Date.parse(at), board: "loja", cardId: "story-ex9809" })),
    attribution: { actions: 615, attributed: 0 }, // o ator era só o nome do token
    openTechnicalQuestions: [{ board: "armazem", cardId: "story-ex9813", questionId: "q1", askedAt: "2026-05-19" }],
  });
}

describe("o estado doente — a linha de base ANTES dos consertos", () => {
  const report = computeHealth(fixtureSick());

  it("S1/S3/S6/S10 vermelhos, S9 âmbar, S11 não medível", () => {
    expect(level(report, "S1").level).toBe("red");
    expect(level(report, "S3").level).toBe("red");
    expect(level(report, "S6").level).toBe("red");
    expect(level(report, "S10").level).toBe("red");
    expect(level(report, "S9").level).toBe("amber");
    expect(level(report, "S11")).toMatchObject({ level: "unknown", value: null });
  });

  it("S1 conta o Decidir sem razão de negócio: 3 publicações + 1 pergunta do piso + 1 do board em modo humano; ex9808 NÃO conta", () => {
    const s = level(report, "S1");
    expect(s.value).toBe(5);
    expect(s.detail).toContain("3 sem opção que mude o desfecho");
    expect(s.evidence).not.toContain("armazem/story-ex9808");
  });

  it("S2: 35 de 42 linhas do Inbox fora do contrato = 83% (5 em Decidir sem negócio + 30 em Acompanhar que é só registro)", () => {
    expect(level(report, "S2").value).toBe(83);
    expect(level(report, "S2").level).toBe("red");
    expect(level(report, "S2").detail).toContain("35 de 42");
  });

  it("S3: 3 cards na raia sem estar em Decidir (a diferença simétrica)", () => {
    const s = level(report, "S3");
    expect(s.value).toBe(3);
    expect(s.evidence).toEqual(expect.arrayContaining(["armazem/story-ex9804", "armazem/story-ex9805", "armazem/story-ex9806"]));
  });

  it("S6: 4,5 h com fila e nada no ar (desde que ex9801 voltou a release, 10:41Z, depois da última entrega às 10:02Z); 3 pela MESMA causa", () => {
    const s = level(report, "S6");
    expect(s.value).toBe(4.5);
    expect(s.detail).toContain("5 cards esperam");
    expect(s.detail).toContain("3 pela mesma causa");
    expect(s.evidence.slice(0, 5)).toEqual(["armazem/story-ex9801", "armazem/story-ex9802", "armazem/story-ex9803", "armazem/story-ex9804", "armazem/story-ex9805"]);
  });

  it("S9: ex9810 — o arquivo diz corrigir, o ledger diz release", () => {
    const s = level(report, "S9");
    expect(s.value).toBe(1);
    expect(s.detail).toContain("«corrigir»");
    expect(s.detail).toContain("«release»");
  });

  it("S10: a mesma assinatura de sandbox 5x em 24 h", () => {
    expect(level(report, "S10")).toMatchObject({ value: 5, level: "red" });
  });

  it("S11 diz POR QUE não mede: 0% das ações atribuídas", () => {
    expect(level(report, "S11").detail).toContain("0%");
  });

  it("S12: a pergunta técnica só tem a data — não medível, não verde", () => {
    expect(level(report, "S12")).toMatchObject({ level: "unknown", value: null });
  });

  it("S4 âmbar (terminal órfão), S5 vermelho (escalado), S7 âmbar (3,3 h), S8 verde", () => {
    expect(level(report, "S4")).toMatchObject({ level: "amber", value: 1 });
    expect(level(report, "S5")).toMatchObject({ level: "red", value: 1 });
    expect(level(report, "S7")).toMatchObject({ level: "amber", value: 3.3 });
    expect(level(report, "S8").level).toBe("ok");
  });

  it("os 12 sinais, na ordem, cada um com limiar e regra; o pior nível é vermelho", () => {
    expect(report.signals.map((s) => s.id)).toEqual([...HEALTH_SIGNAL_IDS]);
    for (const s of report.signals) {
      expect(s.rule.length).toBeGreaterThan(10);
      expect(s.fixHint.length).toBeGreaterThan(10);
      expect(s.evidence.length).toBeLessThanOrEqual(5);
      expect(Number.isFinite(s.threshold.amber) && Number.isFinite(s.threshold.red)).toBe(true);
    }
    expect(report.worst).toBe("red");
    expect(report.at).toBe("2026-05-19T15:10:20.000Z");
  });

  it("é determinística: o mesmo input dá o mesmo relatório", () => {
    expect(computeHealth(fixtureSick())).toEqual(report);
  });
});

describe("um estado saudável é verde, e o que não dá para medir NUNCA é verde", () => {
  it("tudo em ordem ⇒ ok em todo sinal medível; S12 e S6 sem fila ficam verdes", () => {
    const r = computeHealth(green());
    expect(r.signals.filter((s) => s.level !== "ok")).toEqual([]);
    expect(r.worst).toBe("ok");
  });

  it("Inbox vazio não divide por zero", () => {
    expect(level(computeHealth(green()), "S2").value).toBe(0);
  });

  it("sem a sonda do tmux o S4 não julga ninguém: não medível", () => {
    expect(level(computeHealth(green({ fleetKnown: false })), "S4")).toMatchObject({ level: "unknown", value: null });
  });
});

describe("os limiares são `>` (estritamente acima), como declarados", () => {
  it("S3: 0 ok · 1 âmbar · 2 âmbar · 3 vermelho", () => {
    const lane = (n: number) => green({ demandLanes: [{ board: "b", laneId: "voce", cardIds: Array.from({ length: n }, (_, i) => `c${i}`) }] });
    expect(computeHealth(lane(0)).signals[2].level).toBe("ok");
    expect(computeHealth(lane(1)).signals[2].level).toBe("amber");
    expect(computeHealth(lane(2)).signals[2].level).toBe("amber");
    expect(computeHealth(lane(3)).signals[2].level).toBe("red");
  });

  it("S2: 20% ainda é verde, 21% âmbar, 51% vermelho", () => {
    const mix = (decisions: number, total: number) =>
      green({ inbox: Array.from({ length: total }, (_, i) => entry({ cardId: `c${i}`, bucket: i < decisions ? "decidir" : "acompanhar", ownerClass: i < decisions ? "money" : null, executable: 1 })) });
    expect(level(computeHealth(mix(8, 10)), "S2")).toMatchObject({ value: 20, level: "ok" });
    expect(level(computeHealth(mix(79, 100)), "S2")).toMatchObject({ value: 21, level: "amber" });
    expect(level(computeHealth(mix(49, 100)), "S2")).toMatchObject({ value: 51, level: "red" });
  });

  it("os limiares podem ser trocados (o settings manda)", () => {
    const lane = green({ demandLanes: [{ board: "b", laneId: "voce", cardIds: ["a", "b", "c"] }] });
    expect(level(computeHealth(lane), "S3").level).toBe("red");
    expect(level(computeHealth(lane, { ...DEFAULT_HEALTH_THRESHOLDS, s3: { amber: 5, red: 9 } }), "S3").level).toBe("ok");
  });
});

describe("S1 — Decidir só com razão de negócio e opção que mude o desfecho", () => {
  it("decisão de negócio de verdade (classe declarada, opção executável) é verde", () => {
    const r = computeHealth(green({ inbox: [entry({ cardId: "pay", kind: "gate", ownerClass: "money", executable: 2 })] }));
    expect(level(r, "S1")).toMatchObject({ value: 0, level: "ok" });
  });

  it("o dono por um piso de palavras (floorOnly) não é razão de negócio", () => {
    const r = computeHealth(green({ inbox: [entry({ cardId: "q", kind: "question", ownerClass: "money", floorOnly: true, executable: 1 })] }));
    expect(level(r, "S1")).toMatchObject({ value: 1, level: "amber" }); // âmbar: ao menos o dono PODE responder
  });

  it("sem nenhuma opção que mude o desfecho é vermelho de imediato", () => {
    const r = computeHealth(green({ inbox: [entry({ cardId: "x", executable: 0 })] }));
    expect(level(r, "S1").level).toBe("red");
  });

  it("Acompanhar nunca entra em S1", () => {
    const r = computeHealth(green({ inbox: [entry({ cardId: "x", bucket: "acompanhar", decider: "system" })] }));
    expect(level(r, "S1").value).toBe(0);
  });

  it("isOutcomeOption: howto/escalate/link/show-publish-status e leitura NÃO mudam o desfecho; desabilitada também não", () => {
    const opt = (kind: string, auditCls = "write-board", disabled?: unknown) => ({ invoke: { kind }, auditCls, disabled });
    expect(isOutcomeOption(opt("move-card"))).toBe(true);
    expect(isOutcomeOption(opt("answer-question"))).toBe(true);
    for (const k of ["howto", "escalate", "link", "show-publish-status"]) expect(isOutcomeOption(opt(k))).toBe(false);
    expect(isOutcomeOption(opt("move-card", "read"))).toBe(false);
    expect(isOutcomeOption(opt("move-card", "write-board", { reason: "gate" }))).toBe(false);
  });
});

describe("S2 — ruído é a linha FORA do contrato do Inbox, não «tudo que não é decisão para o dono»", () => {
  const working = (cardId: string) => entry({ cardId, kind: "deploy-failed", bucket: "acompanhar", decider: "system", followUpAllowed: true });
  const decision = (cardId: string) => entry({ cardId, kind: "gate", ownerClass: "money", executable: 2 });
  const log = (cardId: string) => entry({ cardId, kind: "system-decision", bucket: "acompanhar", decider: "system" });

  it("Acompanhar só com trabalho do sistema em andamento e nenhuma decisão pendente é verde (antes: 100% vermelho)", () => {
    expect(level(computeHealth(green({ inbox: [working("story-a")] })), "S2")).toMatchObject({ value: 0, level: "ok" });
  });

  it("acumular decisões do dono NÃO melhora o número: 5 aceites + 2 decisões e 5 aceites + 20 decisões dão o mesmo 0%", () => {
    const accepts = Array.from({ length: 5 }, (_, i) => working(`story-t${i}`));
    const few = level(computeHealth(green({ inbox: [...accepts, decision("p0"), decision("p1")] })), "S2");
    const many = level(computeHealth(green({ inbox: [...accepts, ...Array.from({ length: 20 }, (_, i) => decision(`p${i}`))] })), "S2");
    expect(few).toMatchObject({ value: 0, level: "ok" });
    expect(many).toMatchObject({ value: 0, level: "ok" });
  });

  it("Decidir sem razão de negócio, ou com razão mas sem opção que mude o desfecho, é ruído", () => {
    const noReason = entry({ cardId: "a", executable: 1 });
    const noOption = entry({ cardId: "b", kind: "gate", ownerClass: "money", executable: 0 });
    const s = level(computeHealth(green({ inbox: [noReason, noOption, decision("c"), decision("d")] })), "S2");
    expect(s.value).toBe(50);
    expect(s.detail).toContain("2 de 4");
  });

  it("denominador pequeno não oscila: com menos de 5 linhas fora do contrato o sinal não sai do verde", () => {
    const four = level(computeHealth(green({ inbox: Array.from({ length: 4 }, (_, i) => log(`l${i}`)) })), "S2");
    expect(four).toMatchObject({ value: 100, level: "ok" });
    expect(four.detail).toContain("mínimo de 5");
    expect(level(computeHealth(green({ inbox: Array.from({ length: 5 }, (_, i) => log(`l${i}`)) })), "S2")).toMatchObject({ value: 100, level: "red" });
    expect(level(computeHealth(green({ inbox: [log("l0")] }), { ...DEFAULT_HEALTH_THRESHOLDS, s2: { amber: 20, red: 50, minLines: 1 } }), "S2").level).toBe("red");
  });
});

describe("S4 — agentes ociosos, órfãos e claims sem sessão", () => {
  const conductor = (over: Partial<HealthInputs["fleet"][number]> = {}) => ({
    agentId: "a1",
    board: "armazem",
    cardId: "story-ex9803",
    alive: true,
    isConductor: true,
    quietForMs: null,
    declaredWaiting: false,
    asking: false,
    worktreeMissing: false,
    claimAgeMs: null,
    ...over,
  });

  it("condutor quieto 14 min segurando claim de 45 min: ainda não é «ocioso» (15 min), mas com 16 min e claim de 45 é VERMELHO", () => {
    expect(level(computeHealth(green({ fleet: [conductor({ quietForMs: 14 * MIN, claimAgeMs: 45 * MIN })] })), "S4").level).toBe("ok");
    expect(level(computeHealth(green({ fleet: [conductor({ quietForMs: 16 * MIN, claimAgeMs: 45 * MIN })] })), "S4")).toMatchObject({ level: "red", value: 1 });
  });

  it("quieto de propósito (espera declarada) ou diante de um prompt desenhado não conta", () => {
    expect(level(computeHealth(green({ fleet: [conductor({ quietForMs: 60 * MIN, declaredWaiting: true })] })), "S4").value).toBe(0);
    expect(level(computeHealth(green({ fleet: [conductor({ quietForMs: 60 * MIN, asking: true })] })), "S4").value).toBe(0);
  });

  it("terminal vivo com o worktree apagado conta; terminal morto não", () => {
    expect(level(computeHealth(green({ fleet: [conductor({ worktreeMissing: true })] })), "S4").value).toBe(1);
    expect(level(computeHealth(green({ fleet: [conductor({ worktreeMissing: true, alive: false })] })), "S4").value).toBe(0);
  });

  it("claim sem sessão viva há 30 min é âmbar; acima de 30 é vermelho", () => {
    const claim = (ageMin: number) => ({ board: "armazem", cardId: "c", actor: "session:a9", claimAgeMs: ageMin * MIN, holderAlive: false });
    expect(level(computeHealth(green({ claims: [claim(30)] })), "S4").level).toBe("amber");
    expect(level(computeHealth(green({ claims: [claim(31)] })), "S4").level).toBe("red");
  });
});

describe("S5/S7 — parados e fila", () => {
  it("S5: vigiado é âmbar, escalado é vermelho; card que voltou a ter dono (firstSeenAt nulo) não conta", () => {
    const row = (over = {}) => ({ key: "armazem/story-x@corrigir", firstSeenAt: NOW - 20 * MIN, ...over });
    expect(level(computeHealth(green({ stall: [row()] })), "S5").level).toBe("amber");
    expect(level(computeHealth(green({ stall: [row({ escalatedAt: NOW })] })), "S5").level).toBe("red");
    expect(level(computeHealth(green({ stall: [row({ firstSeenAt: null, escalatedAt: NOW })] })), "S5").value).toBe(0);
  });

  it("S7: o card MAIS ANTIGO da fila manda (não a entrada nova)", () => {
    const q = [
      { board: "armazem", cardId: "novo", queuedAt: NOW - 10 * MIN },
      { board: "armazem", cardId: "velho", queuedAt: NOW - 5 * HOUR },
    ];
    const s = level(computeHealth(green({ conductorQueue: q })), "S7");
    expect(s).toMatchObject({ value: 5, level: "red" });
    expect(s.evidence[0]).toBe("armazem/velho");
  });
});

// quick-fix health-red: uma espera que o dono ESCOLHEU (board pausado) não é a ferramenta travada.
describe("S6/S7 — board pausado não conta, e a retomada zera o relógio", () => {
  const wait = (board: string, n: number) => Array.from({ length: n }, (_, i) => ({ board, cardId: `story-ex91${i}${board.length}` }));
  const entered = (board: string, cardId: string, hoursAgo: number) => ({ board, cardId, to: "release", at: NOW - hoursAgo * HOUR, actor: "cascade" });

  it("S6: board pausado com cards em release ⇒ verde, e o detalhe ainda cita a espera", () => {
    const w = wait("armazem", 3);
    const held = w.map((c) => ({ ...c, phase: "needs-human", exitCode: 3 }));
    const sick = green({ publishWaiting: w, publishHeld: held, transitions: w.map((c) => entered("armazem", c.cardId, 26)) });
    expect(level(computeHealth(sick), "S6").level).toBe("red");
    const s = level(computeHealth({ ...sick, pausedBoards: ["armazem"] }), "S6");
    expect(s).toMatchObject({ value: 0, level: "ok" });
    expect(s.detail).toMatch(/3 cards esperam em board pausado \(não conta\)/);
  });

  it("S7: etiqueta board-paused com o board NÃO pausado, 60 h ⇒ vermelho (etiqueta velha de despachante morto)", () => {
    const q = [{ board: "armazem", cardId: "story-ex9101", queuedAt: NOW - 60 * HOUR, waitKind: "board-paused" }];
    expect(level(computeHealth(green({ conductorQueue: q })), "S7")).toMatchObject({ value: 60, level: "red" });
    // com o board de fato pausado, a mesma entrada sai da conta
    expect(level(computeHealth(green({ conductorQueue: q, pausedBoards: ["armazem"] })), "S7")).toMatchObject({ value: 0, level: "ok" });
  });

  it("S7: entrada de board pausado ⇒ verde", () => {
    const q2 = [{ board: "armazem", cardId: "story-ex9102", queuedAt: NOW - 60 * HOUR }];
    const s = level(computeHealth(green({ conductorQueue: q2, pausedBoards: ["armazem"] })), "S7");
    expect(s).toMatchObject({ value: 0, level: "ok" });
    expect(s.detail).toMatch(/1 card espera em board pausado/);
  });

  it("mistura: o board pausado sai da conta, o NÃO pausado ainda fica vermelho", () => {
    const deliveredStatuses = { armazem: ["concluida"], loja: ["concluida"] };
    const w = [...wait("armazem", 1), ...wait("loja", 1)];
    const s6 = level(
      computeHealth(green({ deliveredStatuses, publishWaiting: w, transitions: [entered("armazem", w[0].cardId, 30), entered("loja", w[1].cardId, 5)], pausedBoards: ["armazem"] })),
      "S6",
    );
    expect(s6).toMatchObject({ value: 5, level: "red" });
    expect(s6.evidence).toEqual(["loja/" + w[1].cardId]);
    const q = [
      { board: "armazem", cardId: "story-ex9103", queuedAt: NOW - 50 * HOUR },
      { board: "loja", cardId: "story-ex9104", queuedAt: NOW - 6 * HOUR },
    ];
    expect(level(computeHealth(green({ conductorQueue: q, pausedBoards: ["armazem"] })), "S7")).toMatchObject({ value: 6, level: "red" });
  });

  it("board recém-retomado conta DA RETOMADA, não de quando o card entrou na fila", () => {
    const w = wait("armazem", 1);
    const resumedAt = { armazem: NOW - 1 * HOUR };
    const s6 = level(computeHealth(green({ publishWaiting: w, transitions: [entered("armazem", w[0].cardId, 40)], resumedAt })), "S6");
    expect(s6).toMatchObject({ value: 1, level: "ok" });
    const q = [{ board: "armazem", cardId: "story-ex9105", queuedAt: NOW - 40 * HOUR }];
    expect(level(computeHealth(green({ conductorQueue: q, resumedAt: { armazem: NOW - 3 * HOUR } })), "S7")).toMatchObject({ value: 3, level: "amber" });
    // a retomada é um CHÃO: espera que começou depois dela conta normalmente
    const fresh = [{ board: "armazem", cardId: "story-ex9106", queuedAt: NOW - 30 * MIN }];
    expect(level(computeHealth(green({ conductorQueue: fresh, resumedAt: { armazem: NOW - 3 * HOUR } })), "S7").value).toBe(0.5);
  });
});

describe("S6 — vazão até o ar", () => {
  const w = (n: number) => Array.from({ length: n }, (_, i) => ({ board: "armazem", cardId: `c${i}` }));
  const delivered = (hoursAgo: number) => [{ board: "armazem", cardId: "x", to: "concluida", at: NOW - hoursAgo * HOUR, actor: "system" }];

  it("fila vazia = verde, mesmo sem nada no ar há dias (não há o que publicar)", () => {
    expect(level(computeHealth(green({ transitions: delivered(100) })), "S6")).toMatchObject({ value: 0, level: "ok" });
  });

  it("com fila: âmbar acima de 2 h, vermelho acima de 4 h", () => {
    expect(level(computeHealth(green({ publishWaiting: w(1), transitions: delivered(1.5) })), "S6").level).toBe("ok");
    expect(level(computeHealth(green({ publishWaiting: w(1), transitions: delivered(3) })), "S6").level).toBe("amber");
    expect(level(computeHealth(green({ publishWaiting: w(1), transitions: delivered(5) })), "S6").level).toBe("red");
  });

  it("3 cards pela mesma causa são vermelho MESMO com entrega recente; 2 não", () => {
    const held = (n: number, phase = "needs-human") => w(n).map((c) => ({ ...c, phase, exitCode: 3 }));
    expect(level(computeHealth(green({ publishWaiting: w(3), publishHeld: held(3), transitions: delivered(0.5) })), "S6").level).toBe("red");
    expect(level(computeHealth(green({ publishWaiting: w(2), publishHeld: held(2), transitions: delivered(0.5) })), "S6").level).toBe("ok");
  });

  it("causas diferentes não somam: 2 + 2 não é um grupo de 4", () => {
    const held = [
      ...w(2).map((c) => ({ ...c, phase: "needs-human", exitCode: 3 })),
      ...w(4).slice(2).map((c) => ({ ...c, phase: "freshness", exitCode: null })),
    ];
    expect(level(computeHealth(green({ publishWaiting: w(4), publishHeld: held, transitions: delivered(0.5) })), "S6").level).toBe("ok");
  });

  it("o `causeKey` explícito vence fase+código", () => {
    const held = w(3).map((c, i) => ({ ...c, phase: i === 0 ? "needs-human" : "freshness", exitCode: i, causeKey: "unit:extractor" }));
    expect(level(computeHealth(green({ publishWaiting: w(3), publishHeld: held, transitions: delivered(0.5) })), "S6").level).toBe("red");
  });

  it("sem nenhuma entrega no ledger, a espera conta desde o card que entrou na fila primeiro", () => {
    const s = level(computeHealth(green({ publishWaiting: w(1), transitions: [{ board: "armazem", cardId: "c0", to: "release", at: NOW - 3 * HOUR, actor: "cascade" }] })), "S6");
    expect(s).toMatchObject({ value: 3, level: "amber" });
  });

  const entered = (cardId: string, hoursAgo: number, board = "armazem") => ({ board, cardId, to: "release", at: NOW - hoursAgo * HOUR, actor: "cascade" });

  it("board calmo: a última entrega foi há 3 dias e o card ACABOU de entrar em release ⇒ verde, não 72 h", () => {
    const s = level(computeHealth(green({ publishWaiting: w(1), transitions: [...delivered(72), entered("c0", 2 / 60)] })), "S6");
    expect(s).toMatchObject({ value: 0, level: "ok" });
  });

  it("a fila que já existia antes da última entrega conta desde a ENTREGA (horas com fila e nada no ar)", () => {
    expect(level(computeHealth(green({ publishWaiting: w(1), transitions: [entered("c0", 10), ...delivered(3)] })), "S6")).toMatchObject({ value: 3, level: "amber" });
  });

  it("o card mais antigo da fila manda dentro do board; card sem registro de entrada cai na última entrega", () => {
    expect(level(computeHealth(green({ publishWaiting: w(2), transitions: [...delivered(72), entered("c0", 0.5), entered("c1", 5)] })), "S6").value).toBe(5);
    expect(level(computeHealth(green({ publishWaiting: w(1), transitions: delivered(5) })), "S6").value).toBe(5);
  });

  it("cada board com a sua régua: o conserto do board travado aparece como «melhorou» mesmo que um board calmo ganhe um card na fila", () => {
    const jammed = { publishWaiting: [{ board: "armazem", cardId: "c0" }], transitions: [...delivered(6), entered("c0", 5)] };
    const before = computeHealth(green({ ...jammed, deliveredStatuses: { armazem: ["concluida"], loja: ["concluida"] } }));
    const after = computeHealth(
      green({
        deliveredStatuses: { armazem: ["concluida"], loja: ["concluida"] },
        publishWaiting: [{ board: "loja", cardId: "p0" }],
        transitions: [...delivered(0.5), { board: "loja", cardId: "old", to: "concluida", at: NOW - 520 * HOUR, actor: "system" }, entered("p0", 2 / 60, "loja")],
      }),
    );
    expect(level(before, "S6")).toMatchObject({ value: 5, level: "red" });
    expect(level(after, "S6")).toMatchObject({ value: 0, level: "ok" });
    expect(healthDelta(before, after).improved).toContain("S6");
  });
});

describe("S8 — churn: o laço release↔deploy é vermelho no PRIMEIRO tick", () => {
  const hop = (i: number, over = {}) => ({ board: "armazem", cardId: "story-ex9814", to: i % 2 ? "deploy" : "release", at: NOW - i * MIN, actor: i % 2 ? "cascade" : "system", ...over });

  it("31 saltos não humanos em 60 min num card ⇒ vermelho, com o card como evidência", () => {
    const s = level(computeHealth(green({ transitions: Array.from({ length: 31 }, (_, i) => hop(i)) })), "S8");
    expect(s).toMatchObject({ value: 31, level: "red" });
    expect(s.evidence).toEqual(["armazem/story-ex9814"]);
  });

  it("11 saltos é âmbar; o movimento HUMANO nunca conta; salto fora da janela não conta", () => {
    expect(level(computeHealth(green({ transitions: Array.from({ length: 11 }, (_, i) => hop(i)) })), "S8").level).toBe("amber");
    expect(level(computeHealth(green({ transitions: Array.from({ length: 40 }, (_, i) => hop(i, { actor: "human" })) })), "S8").value).toBe(0);
    expect(level(computeHealth(green({ transitions: Array.from({ length: 40 }, (_, i) => hop(i, { at: NOW - 2 * HOUR - i * MIN })) })), "S8").value).toBe(0);
  });

  it("cada card tem a sua conta: 20 saltos em dois cards é verde-âmbar, não 40", () => {
    const t = [...Array.from({ length: 10 }, (_, i) => hop(i, { cardId: "a" })), ...Array.from({ length: 10 }, (_, i) => hop(i, { cardId: "b" }))];
    expect(level(computeHealth(green({ transitions: t })), "S8")).toMatchObject({ value: 10, level: "ok" });
  });
});

describe("S9 — arquivo × ledger", () => {
  it("card sem histórico no ledger não é divergência", () => {
    expect(level(computeHealth(green({ cards: [{ board: "b", cardId: "novo", status: "triage" }] })), "S9").value).toBe(0);
  });

  it("o último salto vale; em empate de instante, o último anexado", () => {
    const t = (to: string, at = NOW - HOUR) => ({ board: "b", cardId: "c", to, at, actor: "system" });
    expect(level(computeHealth(green({ cards: [{ board: "b", cardId: "c", status: "release" }], transitions: [t("deploy"), t("release")] })), "S9").value).toBe(0);
    expect(level(computeHealth(green({ cards: [{ board: "b", cardId: "c", status: "deploy" }], transitions: [t("deploy"), t("release")] })), "S9").value).toBe(1);
  });

  it("3 divergências são vermelho", () => {
    const cards = ["a", "b", "c"].map((id) => ({ board: "b", cardId: id, status: "x" }));
    const transitions = ["a", "b", "c"].map((id) => ({ board: "b", cardId: id, to: "y", at: NOW - HOUR, actor: "system" }));
    expect(level(computeHealth(green({ cards, transitions })), "S9").level).toBe("red");
  });
});

describe("S10 — a MESMA assinatura repetida", () => {
  const fail = (signature: string, hoursAgo: number) => ({ signature, at: NOW - hoursAgo * HOUR, board: "b", cardId: "c" });

  it("uma falha é âmbar, duas da mesma assinatura são vermelho", () => {
    expect(level(computeHealth(green({ toolFailures: [fail("a", 1)] })), "S10").level).toBe("amber");
    expect(level(computeHealth(green({ toolFailures: [fail("a", 1), fail("a", 2)] })), "S10").level).toBe("red");
  });

  it("assinaturas diferentes não se somam; falha fora da janela de 24 h não conta", () => {
    expect(level(computeHealth(green({ toolFailures: [fail("a", 1), fail("b", 2)] })), "S10").value).toBe(1);
    expect(level(computeHealth(green({ toolFailures: [fail("a", 25), fail("a", 26)] })), "S10").value).toBe(0);
  });
});

describe("S11 — nunca verde às cegas", () => {
  it("atribuição abaixo de 90% ⇒ não medível, mesmo com 0 toques", () => {
    const s = level(computeHealth(green({ attribution: { actions: 100, attributed: 89 } })), "S11");
    expect(s).toMatchObject({ level: "unknown", value: null });
    expect(s.detail).toContain("89%");
  });

  it("sem NENHUMA ação na janela também não é medível", () => {
    expect(level(computeHealth(green({ attribution: { actions: 0, attributed: 0 } })), "S11").level).toBe("unknown");
  });

  it("com 90% ou mais, mede: toque técnico + ação da sessão do dono por história no ar", () => {
    const ok = level(computeHealth(green({ attribution: { actions: 100, attributed: 90 } })), "S11");
    expect(ok).toMatchObject({ value: 0, level: "ok" });
    const touched = level(computeHealth(green({ attribution: { actions: 100, attributed: 100 }, touches: { liveStories: 4, technicalTouches: 1, ownerSessionActions: 2 } })), "S11");
    expect(touched).toMatchObject({ value: 0.75, level: "red" });
  });
});

describe("S12 — latência de pergunta técnica", () => {
  const q = (askedAt: string | null) => ({ board: "armazem", cardId: "story-ex9813", questionId: "q1", askedAt });
  const iso = (minAgo: number) => new Date(NOW - minAgo * MIN).toISOString();

  it("aberta há 45 min é âmbar; há 3 h é vermelho; há 10 min é verde", () => {
    expect(level(computeHealth(green({ openTechnicalQuestions: [q(iso(45))] })), "S12")).toMatchObject({ value: 45, level: "amber" });
    expect(level(computeHealth(green({ openTechnicalQuestions: [q(iso(180))] })), "S12").level).toBe("red");
    expect(level(computeHealth(green({ openTechnicalQuestions: [q(iso(10))] })), "S12").level).toBe("ok");
  });

  it("só a data de ontem já prova mais de 2 h (o piso é o FIM do dia): vermelho", () => {
    const s = level(computeHealth(green({ openTechnicalQuestions: [q("2026-05-18")] })), "S12");
    expect(s.level).toBe("red");
    expect(s.detail).toContain("pelo menos"); // é um piso, e o texto não finge precisão
  });

  it("só a data de HOJE não prova nada: não medível, nunca chutada", () => {
    expect(level(computeHealth(green({ openTechnicalQuestions: [q("2026-05-19")] })), "S12")).toMatchObject({ level: "unknown", value: null });
  });

  it("nenhuma pergunta aberta é verde; a mais antiga manda", () => {
    expect(level(computeHealth(green()), "S12")).toMatchObject({ value: 0, level: "ok" });
    expect(level(computeHealth(green({ openTechnicalQuestions: [q(iso(5)), q(iso(70))] })), "S12").value).toBe(70);
  });
});

describe("healthDelta — o que o conserto mudou", () => {
  const before = computeHealth(fixtureSick());

  it("o estado depois do conserto de publicação/raia: S1, S3 e S6 melhoram, o resto igual", () => {
    const fixed = fixtureSick();
    fixed.inbox = fixed.inbox.filter((e) => !(e.kind === "deploy-failed" && e.bucket === "decidir"));
    fixed.demandLanes = [{ board: "armazem", laneId: "voce", cardIds: ["story-ex9807", "story-ex9808"] }];
    fixed.publishWaiting = [];
    fixed.publishHeld = [];
    const d = healthDelta(before, computeHealth(fixed));
    expect(d.improved).toEqual(expect.arrayContaining(["S1", "S3", "S6"]));
    expect(d.worsened).toEqual([]);
    expect(d.signals.find((s) => s.id === "S3")).toMatchObject({ before: 3, after: 0, beforeLevel: "red", afterLevel: "ok", trend: "melhorou" });
    expect(d.line).toMatch(/melhorou: .*S3 \(3→0\)/);
  });

  it("piorou quando o nível sobe; igual quando nada muda; não medível quando um dos lados é null", () => {
    const worse = fixtureSick();
    worse.cards.push({ board: "armazem", cardId: "story-n", status: "x" }, { board: "armazem", cardId: "story-m", status: "x" });
    worse.transitions.push({ board: "armazem", cardId: "story-n", to: "y", at: NOW - HOUR, actor: "system" }, { board: "armazem", cardId: "story-m", to: "y", at: NOW - HOUR, actor: "system" });
    const d = healthDelta(before, computeHealth(worse));
    expect(d.worsened).toContain("S9");
    expect(d.signals.find((s) => s.id === "S2")!.trend).toBe("igual");
    expect(d.signals.find((s) => s.id === "S11")!.trend).toBe("não medível");
  });

  it("`worsenedLevel` só tem quem SUBIU DE NÍVEL — a oscilação numérica dentro do mesmo nível não reprova um ciclo ", () => {
    // Leituras seguidas de um ledger vivo, sem release no meio: o número oscila dentro do MESMO nível quase a cada par
    // (aqui S2 64→71, S7 2.6→3.1, S8 5→8) e só um sinal muda de nível (S4 ok→amber). O critério de saída do harness-cycle
    // lido sobre `worsened` nunca fecharia um ciclo — e mandaria desfazer conserto bom.
    const antes: HealthReading = {
      signals: [
        { id: "S2", value: 64, level: "red" },
        { id: "S7", value: 2.6, level: "amber" },
        { id: "S8", value: 5, level: "ok" },
        { id: "S4", value: 0, level: "ok" },
        { id: "S12", value: null, level: "unknown" },
      ],
    };
    const depois: HealthReading = {
      signals: [
        { id: "S2", value: 71, level: "red" },
        { id: "S7", value: 3.1, level: "amber" },
        { id: "S8", value: 8, level: "ok" },
        { id: "S4", value: 1, level: "amber" },
        { id: "S12", value: 0, level: "ok" },
      ],
    };
    const d = healthDelta(antes, depois);
    expect(d.worsened).toEqual(["S2", "S7", "S8", "S4"]); // o número segue dito, sinal a sinal
    expect(d.worsenedLevel).toEqual(["S4"]);
    // só os três que oscilaram no número: nenhum subiu de nível
    expect(healthDelta(antes, { signals: depois.signals.filter((s) => s.id !== "S4") }).worsenedLevel).toEqual([]);
    // «não medível» de um lado não é piora de nível: sem um dos valores não há comparação (S12 pode oscilar unknown↔ok)
    expect(healthDelta(depois, antes).worsenedLevel).toEqual([]);
  });

  it("com o mesmo nível, o número decide (menor é melhor)", () => {
    const a = computeHealth(green({ toolFailures: [{ signature: "a", at: NOW - HOUR, board: "b", cardId: "c" }, { signature: "a", at: NOW - HOUR, board: "b", cardId: "c" }] }));
    const b = computeHealth(green({ toolFailures: Array.from({ length: 5 }, () => ({ signature: "a", at: NOW - HOUR, board: "b", cardId: "c" })) }));
    expect(healthDelta(a, b).signals.find((s) => s.id === "S10")!.trend).toBe("piorou");
    expect(healthDelta(b, a).signals.find((s) => s.id === "S10")!.trend).toBe("melhorou");
  });
});

describe("recordAsReading — o delta de «agora × a última leitura GRAVADA» (a base do ah_health)", () => {
  it("a leitura gravada compara com a medida de agora sem remedir nada: o mesmo delta que entre dois relatórios", () => {
    const before = computeHealth(fixtureSick());
    const fixed = fixtureSick();
    fixed.demandLanes = [{ board: "armazem", laneId: "voce", cardIds: ["story-ex9807", "story-ex9808"] }];
    const after = computeHealth(fixed);
    expect(healthDelta(recordAsReading(toHealthRecord(before)), after)).toEqual(healthDelta(before, after));
  });

  it("sinal ausente do registro (leitura de um tick antigo, com menos sinais) não entra no delta nem derruba nada", () => {
    const rec: HealthRecord = { v: 1, at: new Date(NOW).toISOString(), signals: { S3: { value: 4, level: "red" } } };
    const d = healthDelta(recordAsReading(rec), computeHealth(green()));
    expect(d.signals.map((s) => s.id)).toEqual(["S3"]);
    expect(d.improved).toEqual(["S3"]);
  });
});

describe("healthSignalCatalog — o que cada sinal É, para quem só lê uma leitura gravada", () => {
  it("os 12 sinais, na ordem dos ids, com rótulo, unidade, regra e os limiares EFETIVOS", () => {
    const cat = healthSignalCatalog();
    expect(cat.map((s) => s.id)).toEqual([...HEALTH_SIGNAL_IDS]);
    for (const s of cat) {
      expect(s.label.length, `${s.id} sem rótulo`).toBeGreaterThan(0);
      expect(s.rule.length, `${s.id} sem regra`).toBeGreaterThan(0);
    }
    const custom = healthSignalCatalog({ ...DEFAULT_HEALTH_THRESHOLDS, s6: { amber: 1, red: 9, redGroup: 5 } });
    expect(custom.find((s) => s.id === "S6")!.threshold).toEqual({ amber: 1, red: 9 });
  });

  it("os rótulos são OS MESMOS que a medida escreve (fonte única — não uma tabela paralela que diverge)", () => {
    const measured = computeHealth(fixtureSick()).signals;
    for (const c of healthSignalCatalog()) {
      const m = measured.find((s) => s.id === c.id)!;
      expect({ label: c.label, unit: c.unit, rule: c.rule }).toEqual({ label: m.label, unit: m.unit, rule: m.rule });
    }
  });
});

describe("coerceHealthSettings — o bloco health: do settings.yaml, com os defaults no código", () => {
  it("ausente, nulo ou não-mapa ⇒ os defaults", () => {
    for (const raw of [undefined, null, "x", 3, [], {}]) expect(coerceHealthSettings(raw)).toEqual(DEFAULT_HEALTH_SETTINGS);
  });

  it("sobrepõe campo a campo e preserva o resto", () => {
    const s = coerceHealthSettings({ redTicks: 3, s3: { red: 9 }, s8: { windowMinutes: 30 } });
    expect(s.redTicks).toBe(3);
    expect(s.thresholds.s3).toEqual({ amber: 0, red: 9 });
    expect(s.thresholds.s8).toEqual({ amber: 10, red: 30, windowMinutes: 30 });
    expect(s.thresholds.s2).toEqual(DEFAULT_HEALTH_THRESHOLDS.s2);
  });

  it("valor inválido (texto, negativo, NaN, tipo errado) mantém o default daquela folha", () => {
    const s = coerceHealthSettings({ s2: { amber: "muito", red: -1 }, s6: "x", tickMinutes: Number.NaN, redTicks: 0 });
    expect(s.thresholds.s2).toEqual(DEFAULT_HEALTH_THRESHOLDS.s2);
    expect(s.thresholds.s6).toEqual(DEFAULT_HEALTH_THRESHOLDS.s6);
    expect(s.tickMinutes).toBe(5);
    expect(s.redTicks).toBe(1); // 0 vira o mínimo de 1 leitura
  });

  it("`tickMinutes: 0` desliga o tick (é o único jeito declarado de silenciar)", () => {
    expect(coerceHealthSettings({ tickMinutes: 0 }).tickMinutes).toBe(0);
  });
});

describe("redStreaks — vermelho em leituras SEGUIDAS", () => {
  const settings = { redTicks: 2, tickMinutes: 5 };
  const reportAt = (offsetMin: number, redIds: HealthSignalId[]): HealthReport => {
    const base = computeHealth(green());
    return {
      ...base,
      at: new Date(NOW + offsetMin * MIN).toISOString(),
      signals: base.signals.map((s) => (redIds.includes(s.id) ? { ...s, level: "red" as const, value: 9 } : s)),
    };
  };
  const rec = (offsetMin: number, redIds: HealthSignalId[]): HealthRecord => toHealthRecord(reportAt(offsetMin, redIds));

  it("vermelho agora e na leitura anterior ⇒ pede card; vermelho só agora ⇒ não", () => {
    expect(redStreaks([rec(-5, ["S6"])], reportAt(0, ["S6"]), settings).map((s) => s.id)).toEqual(["S6"]);
    expect(redStreaks([rec(-5, [])], reportAt(0, ["S6"]), settings)).toEqual([]);
    expect(redStreaks([], reportAt(0, ["S6"]), settings)).toEqual([]);
  });

  it("só os sinais vermelhos nas DUAS leituras", () => {
    expect(redStreaks([rec(-5, ["S1", "S6"])], reportAt(0, ["S6", "S10"]), settings).map((s) => s.id)).toEqual(["S6"]);
  });

  it("uma leitura velha demais (serviço parado por horas) não é «a leitura anterior»", () => {
    expect(redStreaks([rec(-16, ["S6"])], reportAt(0, ["S6"]), settings)).toEqual([]);
    expect(redStreaks([rec(-15, ["S6"])], reportAt(0, ["S6"]), settings).map((s) => s.id)).toEqual(["S6"]);
  });

  it("redTicks 3 pede as DUAS anteriores, e as três seguidas", () => {
    const s3 = { redTicks: 3, tickMinutes: 5 };
    expect(redStreaks([rec(-5, ["S6"])], reportAt(0, ["S6"]), s3)).toEqual([]);
    expect(redStreaks([rec(-10, ["S6"]), rec(-5, ["S6"])], reportAt(0, ["S6"]), s3).map((s) => s.id)).toEqual(["S6"]);
    expect(redStreaks([rec(-10, ["S6"]), rec(-5, [])], reportAt(0, ["S6"]), s3)).toEqual([]);
  });

  it("redTicks 1 devolve todo vermelho de agora", () => {
    expect(redStreaks([], reportAt(0, ["S1", "S2"]), { redTicks: 1, tickMinutes: 5 }).map((s) => s.id)).toEqual(["S1", "S2"]);
  });

  it("toHealthRecord é compacto: valor, nível e UMA linha do dia, sem a lista de evidência; o desfecho do card vai estruturado (o próximo tick o lê)", () => {
    const report = computeHealth(fixtureSick());
    const r = toHealthRecord(report, { S6: { outcome: "created", cardId: "story-ex9001" } });
    expect(r.v).toBe(1);
    // A linha do dia (`detail`) entrou no registro de propósito (WP6b): é o que a tela de /processes mostra SEM remedir.
    expect(r.signals.S3).toEqual({ value: 3, level: "red", detail: report.signals.find((s) => s.id === "S3")!.detail });
    expect(r.cards).toEqual({ S6: { outcome: "created", cardId: "story-ex9001" } });
    expect(JSON.stringify(r)).not.toContain("evidence");
  });

  it("a linha do dia no registro é UMA linha e tem teto: quebra vira espaço, o excesso vira reticências", () => {
    const base = computeHealth(green());
    const long = `${"muito ".repeat(60)}\nsegunda linha`;
    const r = toHealthRecord({ ...base, signals: base.signals.map((s) => (s.id === "S1" ? { ...s, detail: long } : s)) });
    const detail = r.signals.S1!.detail!;
    expect(detail.length).toBeLessThanOrEqual(RECORD_DETAIL_MAX);
    expect(detail).not.toContain("\n");
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("episodeCover — UM card por episódio vermelho, re-armado só por uma leitura fora do vermelho", () => {
  const rec = (offsetMin: number, level: HealthLevel, card?: HealthCardOutcome): HealthRecord => ({
    v: 1,
    at: new Date(NOW + offsetMin * MIN).toISOString(),
    signals: { S6: { value: level === "red" ? 9 : 0, level } },
    ...(card ? { cards: { S6: card } } : {}),
  });

  it("o card criado neste episódio o cobre, mesmo depois de fechado (o ledger não sabe do status — e não precisa)", () => {
    const h = [rec(0, "red"), rec(5, "red", { outcome: "created", cardId: "story-a" }), rec(10, "red", { outcome: "covered", cardId: "story-a" })];
    expect(episodeCover(h, "S6")).toBe("story-a");
  });

  it("uma leitura verde ou âmbar fecha o episódio: o próximo vermelho pode ter card novo", () => {
    expect(episodeCover([rec(0, "red", { outcome: "created", cardId: "story-a" }), rec(5, "ok")], "S6")).toBeNull();
    expect(episodeCover([rec(0, "red", { outcome: "created", cardId: "story-a" }), rec(5, "amber"), rec(10, "red")], "S6")).toBeNull();
  });

  it("«não medível» NÃO prova que o sinal saiu do vermelho; leitura sem o sinal também não", () => {
    const h = [rec(0, "red", { outcome: "exists", cardId: "story-a" }), rec(5, "unknown"), { v: 1 as const, at: new Date(NOW + 10 * MIN).toISOString(), signals: {} }];
    expect(episodeCover(h, "S6")).toBe("story-a");
  });

  it("recusa (sem board, falha de escrita) não cobre; o card mais recente do episódio vence; a ordem é a do instante", () => {
    expect(episodeCover([rec(0, "red", { outcome: "skipped", reason: "sem board" })], "S6")).toBeNull();
    expect(episodeCover([rec(10, "red", { outcome: "exists", cardId: "story-b" }), rec(5, "red", { outcome: "created", cardId: "story-a" })], "S6")).toBe("story-b");
    expect(episodeCover([], "S6")).toBeNull();
  });
});
