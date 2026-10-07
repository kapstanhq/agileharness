import { describe, expect, it } from "vitest";
import {
  BREAKER_BURST,
  afterRead,
  breakerOpen,
  coerceSignalsSettings,
  conductorSignalShare,
  conductorSlotAllowsSignal,
  dueSignalRechecks,
  emptySourceState,
  SIGNAL_RECHECK_AFTER_MS,
  maxOpenSignalCards,
  parseSignalOutput,
  planSignalIntake,
  readSignalMark,
  scrubPersonal,
  signalCardBody,
  signalVerdict,
} from "./signals";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const src = { id: "erros", command: ["fonte-de-erros", "--json"], board: "livraria", kind: "errors" as const, maxCardsPerDay: 3, minEvents: 20, timeoutSeconds: 60 };

describe("contrato de sinais — configuração", () => {
  it("coage fontes: argv sem shell, fonte torta é descartada, a reserva do dono nunca fica abaixo de 40%", () => {
    const s = coerceSignalsSettings({
      reserveOwnerPct: 10,
      sources: [
        { id: "erros", command: ["fonte-de-erros", "--json"], board: "livraria" },
        { id: "produto", command: "resumo-do-produto --json", board: "livraria", kind: "product", maxCardsPerDay: 99 },
        { id: "Sem Board", command: ["x"] },
        { id: "erros", command: ["dup"], board: "livraria" },
      ],
    });
    expect(s.reserveOwnerPct).toBe(40);
    expect(s.sources.map((x) => x.id)).toEqual(["erros", "produto"]);
    expect(s.sources[1]).toMatchObject({ command: ["resumo-do-produto", "--json"], kind: "product", maxCardsPerDay: 20 });
    expect(coerceSignalsSettings(undefined).sources).toEqual([]);
  });
});

describe("só agregados — nada por pessoa", () => {
  it("guarda só chave, título e contagem; e-mail, telefone e ids longos são tirados; causas iguais se somam", () => {
    const r = parseSignalOutput(
      "erros",
      JSON.stringify({
        events: 340,
        causes: [
          { key: "Falha ao fechar o carrinho para leitor@example.com", count: 7, userId: "u-1", email: "leitor@example.com" },
          { key: "Falha ao fechar o carrinho para outro@example.com", count: 5 },
          { key: "Timeout no catálogo, ligue +55 11 99999-0000", title: "Timeout", count: 2 },
        ],
      }),
    )!;
    expect(r.events).toBe(340);
    expect(r.causes).toHaveLength(2);
    expect(r.causes[0]).toMatchObject({ count: 12 });
    expect(JSON.stringify(r)).not.toMatch(/example\.com|99999|userId|u-1/);
    expect(parseSignalOutput("erros", "não é json")).toBeNull();
  });

  it("scrubPersonal", () => {
    expect(scrubPersonal("a@b.test ligou de (11) 98765-4321 token abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[e-mail] ligou de [número] token [id]");
  });
});

describe("disjuntor", () => {
  it("abre na 3ª falha seguida e numa enxurrada de causas novas; uma leitura boa zera as falhas", () => {
    let s = emptySourceState(NOW);
    s = afterRead(s, NOW, { ok: false, newCauses: 0 });
    s = afterRead(s, NOW, { ok: false, newCauses: 0 });
    expect(breakerOpen(s, NOW)).toBe(false);
    s = afterRead(s, NOW, { ok: false, newCauses: 0 });
    expect(breakerOpen(s, NOW)).toBe(true);
    const flood = afterRead(emptySourceState(NOW), NOW, { ok: true, newCauses: BREAKER_BURST + 1 });
    expect(breakerOpen(flood, NOW)).toBe(true);
    const ok = afterRead({ ...emptySourceState(NOW), failures: 2 }, NOW, { ok: true, newCauses: 1 });
    expect(ok.failures).toBe(0);
  });
});

describe("a entrada determinística", () => {
  const reading = parseSignalOutput("erros", JSON.stringify({ events: 500, causes: [{ key: "a", count: 9 }, { key: "b", count: 8 }, { key: "c", count: 7 }, { key: "d", count: 1 }] }))!;
  const base = { source: src, reading, state: emptySourceState(NOW), now: NOW, openCauseHashes: new Set<string>(), openSignalCards: 0, slots: 5, reserveOwnerPct: 40 };

  it("um card por causa: a causa que já tem card aberto não ganha outro", () => {
    const plan = planSignalIntake({ ...base, openCauseHashes: new Set([reading.causes[0].hash]) });
    expect(plan.create.map((c) => c.key)).toEqual(["b", "c", "d"]);
    expect(plan.skipped).toEqual([{ hash: reading.causes[0].hash, why: "open-card" }]);
  });

  it("teto por fonte por dia", () => {
    const plan = planSignalIntake({ ...base, state: { ...emptySourceState(NOW), createdToday: 2 } });
    expect(plan.create).toHaveLength(1);
    expect(plan.skipped.filter((s) => s.why === "daily-cap")).toHaveLength(3);
  });

  it("≥ 40% da capacidade do condutor fica com o dono: os cards de sinal abertos não passam da fatia", () => {
    expect(maxOpenSignalCards(5, 40)).toBe(3);
    expect(maxOpenSignalCards(2, 40)).toBe(1);
    expect(maxOpenSignalCards(1, 40)).toBe(1);
    const plan = planSignalIntake({ ...base, openSignalCards: 2 });
    expect(plan.create).toHaveLength(1);
    expect(plan.skipped.some((s) => s.why === "owner-reserve")).toBe(true);
    expect(conductorSlotAllowsSignal({ runningSignal: 2, slots: 5, reserveOwnerPct: 40 })).toBe(true);
    expect(conductorSlotAllowsSignal({ runningSignal: 3, slots: 5, reserveOwnerPct: 40 })).toBe(false);
  });

  it("as VAGAS dos sinais arredondam para baixo: 1 vaga ⇒ fatia 0, 2 vagas ⇒ 1 (50% ficam com o dono)", () => {
    expect(conductorSignalShare(1, 40)).toBe(0);
    expect(conductorSignalShare(2, 40)).toBe(1);
    expect(conductorSignalShare(5, 40)).toBe(3);
    // 2 vagas: um sinal roda; o segundo espera (os dois juntos seriam 100%)
    expect(conductorSlotAllowsSignal({ runningSignal: 0, slots: 2, reserveOwnerPct: 40, ownerWorkQueued: true })).toBe(true);
    expect(conductorSlotAllowsSignal({ runningSignal: 1, slots: 2, reserveOwnerPct: 40, ownerWorkQueued: false })).toBe(false);
  });

  it("board de UMA vaga (dono, 07/10: «seus pedidos primeiro»): o sinal só pega a vaga sem trabalho do dono na fila", () => {
    expect(conductorSlotAllowsSignal({ runningSignal: 0, slots: 1, reserveOwnerPct: 40, ownerWorkQueued: true })).toBe(false);
    expect(conductorSlotAllowsSignal({ runningSignal: 0, slots: 1, reserveOwnerPct: 40, ownerWorkQueued: false })).toBe(true);
    // sem saber se há trabalho do dono, não pega
    expect(conductorSlotAllowsSignal({ runningSignal: 0, slots: 1, reserveOwnerPct: 40 })).toBe(false);
  });

  it("um sinal URGENTE (erro grave em produção) passa na frente do trabalho do dono — mas nunca ao lado de outro sinal", () => {
    expect(conductorSlotAllowsSignal({ runningSignal: 0, slots: 1, reserveOwnerPct: 40, ownerWorkQueued: true, urgent: true })).toBe(true);
    expect(conductorSlotAllowsSignal({ runningSignal: 1, slots: 1, reserveOwnerPct: 40, ownerWorkQueued: true, urgent: true })).toBe(false);
    expect(conductorSlotAllowsSignal({ runningSignal: 3, slots: 5, reserveOwnerPct: 40, ownerWorkQueued: true, urgent: true })).toBe(false);
    expect(conductorSlotAllowsSignal({ runningSignal: 0, slots: 1, reserveOwnerPct: 40, ownerWorkQueued: true, urgent: false })).toBe(false);
  });

  it("fonte de produto não cria card; disjuntor aberto não cria nada", () => {
    expect(planSignalIntake({ ...base, source: { ...src, kind: "product" } }).create).toEqual([]);
    const open = afterRead(emptySourceState(NOW), NOW, { ok: true, newCauses: BREAKER_BURST + 5 });
    const plan = planSignalIntake({ ...base, state: open });
    expect(plan.create).toEqual([]);
    expect(plan.skipped.every((s) => s.why === "breaker")).toBe(true);
  });
});

describe("o veredito depois do deploy", () => {
  it("moveu / não moveu / inconclusivo", () => {
    expect(signalVerdict({ baseline: 40, current: 10, minEvents: 20, eventsBefore: 400, eventsAfter: 380 })).toBe("moveu");
    expect(signalVerdict({ baseline: 40, current: 35, minEvents: 20, eventsBefore: 400, eventsAfter: 380 })).toBe("não moveu");
    expect(signalVerdict({ baseline: 4, current: 1, minEvents: 20, eventsBefore: 9, eventsAfter: 7 })).toBe("inconclusivo");
  });

  it("a marca do card ida e volta", () => {
    const body = signalCardBody({ id: "erros" }, reading0(), { causes: [], events: 120 }, "2026-10-07T12:00:00Z");
    expect(readSignalMark(body)).toEqual({ source: "erros", hash: "abcd1234", baseline: 9, events: 120, at: "2026-10-07T12:00:00Z" });
    expect(readSignalMark("sem marca")).toBeNull();
  });

  it("a releitura é devida só para card de sinal publicado há tempo bastante, num status terminal e sem veredito", () => {
    const terminal = new Set(["no-ar"]);
    const old = new Date(NOW - SIGNAL_RECHECK_AFTER_MS - 1).toISOString();
    const fresh = new Date(NOW - 60_000).toISOString();
    const cards = [
      { id: "story-ex9501", status: "no-ar", labels: ["sinal"], deployProof: { at: old } },
      { id: "story-ex9502", status: "no-ar", labels: ["sinal"], deployProof: { at: fresh } }, // cedo demais
      { id: "story-ex9503", status: "no-ar", labels: ["sinal", "sinal-veredito:moveu"], deployProof: { at: old } }, // já tem
      { id: "story-ex9504", status: "no-ar", labels: [], deployProof: { at: old } }, // não é de sinal
      { id: "story-ex9505", status: "revisao", labels: ["sinal"], deployProof: { at: old } }, // não está publicado
      { id: "story-ex9506", status: "no-ar", labels: ["sinal"] }, // sem prova de publicação
    ];
    expect(dueSignalRechecks(cards, terminal, NOW)).toEqual(["story-ex9501"]);
  });
});

function reading0() {
  return { key: "a", title: "Falha a", count: 9, hash: "abcd1234" };
}
