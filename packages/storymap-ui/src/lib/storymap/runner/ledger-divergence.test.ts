import { describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/storymap/types";
import {
  LEDGER_DIVERGENCE_FINDING_ID,
  lastHopByCard,
  ledgerDivergenceFinding,
  planLedgerDivergence,
  sweepLedgerDivergence,
  type DivergenceAction,
} from "./ledger-divergence";
import type { Transition } from "./transitions";

// O card cujo arquivo e cujo histórico discordam do status ganha um aviso que pede a decisão — e só ele. A varredura
// nunca escolhe um lado sozinha (nenhum status é escrito), e o aviso some quando os dois voltam a concordar.

const hop = (cardId: string, to: string, at: string, board = "estufa"): Transition => ({ v: 1, at, board, cardId, from: null, to, actor: "cascade" });
const card = (id: string, status: string, findings: Card["findings"] = []): Card => ({ id, type: "story", title: id, status, findings }) as unknown as Card;

describe("lastHopByCard", () => {
  it("o último salto vence (empate de instante: o último anexado); só o board pedido", () => {
    const hops = [hop("story-ex0001", "ready", "2026-04-01T10:00:00Z"), hop("story-ex0001", "revisao", "2026-04-01T11:00:00Z"), hop("story-ex0001", "deploy", "2026-04-01T11:00:00Z"), hop("story-ex0001", "x", "2026-04-02T00:00:00Z", "outro")];
    expect(lastHopByCard(hops, "estufa").get("story-ex0001")).toBe("deploy");
  });
});

describe("planLedgerDivergence", () => {
  const last = new Map([["story-ex0001", "revisao"], ["story-ex0002", "ready"]]);

  it("diverge sem aviso ⇒ abre; concorda ⇒ nada; sem histórico ⇒ nada", () => {
    const plan = planLedgerDivergence([card("story-ex0001", "desenvolver"), card("story-ex0002", "ready"), card("story-ex0003", "ready")], last);
    expect(plan).toEqual([{ cardId: "story-ex0001", kind: "open", finding: expect.objectContaining({ id: LEDGER_DIVERGENCE_FINDING_ID, status: "open", severity: "medium" }) }]);
    const f = (plan[0] as Extract<DivergenceAction, { kind: "open" }>).finding;
    expect(f.detail).toMatch(/«desenvolver».*«revisao»/);
    expect(f.detail).toMatch(/não escolhe sozinho/);
  });

  it("o aviso igual já aberto não é regravado; voltou a concordar ⇒ fecha", () => {
    const open = ledgerDivergenceFinding("desenvolver", "revisao");
    expect(planLedgerDivergence([card("story-ex0001", "desenvolver", [open])], last)).toEqual([]);
    expect(planLedgerDivergence([card("story-ex0001", "revisao", [open])], last)).toEqual([{ cardId: "story-ex0001", kind: "close" }]);
  });

  it("usa o nome do passo que o dono lê", () => {
    const plan = planLedgerDivergence([card("story-ex0001", "desenvolver")], last, (s) => ({ desenvolver: "Construir", revisao: "Revisão" })[s] ?? s);
    expect((plan[0] as Extract<DivergenceAction, { kind: "open" }>).finding.detail).toMatch(/«Construir».*«Revisão»/);
  });
});

describe("sweepLedgerDivergence", () => {
  it("aplica cada ação no seu board, nunca escreve status, e não lança quando uma escrita falha", async () => {
    const applied: { board: string; action: DivergenceAction }[] = [];
    const apply = vi.fn(async (board: string, action: DivergenceAction) => {
      if (action.cardId === "story-ex0009") throw new Error("lock ocupado");
      applied.push({ board, action });
    });
    const done = await sweepLedgerDivergence({
      boards: async () => [{ id: "estufa", cards: [card("story-ex0001", "desenvolver"), card("story-ex0009", "ready")], statusName: (s) => s }],
      hops: async () => [hop("story-ex0001", "revisao", "2026-04-01T11:00:00Z"), hop("story-ex0009", "deploy", "2026-04-01T11:00:00Z")],
      apply,
      log: () => {},
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(done.map((d) => d.action.cardId)).toEqual(["story-ex0001"]);
    expect(applied[0].action.kind).toBe("open");
  });

  it("uma leitura do histórico que falha não lança e não faz nada", async () => {
    const apply = vi.fn();
    expect(await sweepLedgerDivergence({ boards: async () => [], hops: async () => { throw new Error("ilegível"); }, apply, log: () => {} })).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });
});
