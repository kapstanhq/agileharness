// Wake — o Jido autônomo acordando por EVENTO. Testa as duas decisões PURAS: (1) que evento merece acordar
// alguém (e qual motivo o operador vai ler), e (2) QUANDO o wake dispara — o debounce que coalesce a rajada e o
// cooldown que impede empilhar runs, SEM perder o evento (o cooldown reagenda, nunca descarta).

import { describe, it, expect } from "vitest";
import { wakeReasonForEvent, wakeTiming } from "./orchestrator-wake";
import type { AgileHarnessEvent } from "@/lib/notifications/event";

const ev = (e: Partial<AgileHarnessEvent>): AgileHarnessEvent =>
  ({ id: "1", at: Date.now(), type: "card.updated", boardId: "acme", ...e }) as AgileHarnessEvent;

describe("wakeReasonForEvent", () => {
  it("acorda por DEMANDA (pergunta/blocker/finding) mesmo sem o card mudar de coluna", () => {
    // o caso harness-grill/harness-review: o agente escreve questions/findings NO card, sem move nenhum. Antes isso só
    // seria visto no próximo tick (até 30min depois).
    const reason = wakeReasonForEvent(
      ev({ type: "card.updated", title: "Login social", demand: { type: "blocker", label: "Blocker aberto", severity: "high" } }),
    );
    expect(reason).toBe('Blocker aberto em "Login social"');
  });

  it("acorda quando um card se MOVE (progresso/travamento do pipeline)", () => {
    expect(wakeReasonForEvent(ev({ type: "card.moved", title: "Checkout", toStatusName: "Revisar código" }))).toBe(
      '"Checkout" foi movido para Revisar código',
    );
  });

  it("acorda quando um card NASCE (um bug/ideia entrando por report_issue)", () => {
    expect(wakeReasonForEvent(ev({ type: "card.created", title: "Erro 500 no /perguntas" }))).toBe(
      '"Erro 500 no /perguntas" entrou no board',
    );
  });

  it("NÃO acorda por update sem demanda (um agente preenchendo campos não é trabalho novo)", () => {
    expect(wakeReasonForEvent(ev({ type: "card.updated", title: "X" }))).toBeNull();
  });

  it("NÃO acorda por board.updated — o próprio toggle de modo grava board.yaml (seria um laço)", () => {
    expect(wakeReasonForEvent(ev({ type: "board.updated" }))).toBeNull();
  });

  it("NÃO acorda por delete (não há o que fazer sobre um card que sumiu)", () => {
    expect(wakeReasonForEvent(ev({ type: "card.deleted", title: "X" }))).toBeNull();
  });
});

describe("wakeTiming", () => {
  const now = 1_000_000;
  const debounceMs = 45_000;
  const cooldownMs = 300_000; // 5min

  it("sem tick recente: dispara ao fim do debounce", () => {
    expect(wakeTiming({ now, debounceMs, cooldownMs })).toEqual({ dueAt: now + debounceMs, throttled: false });
  });

  it("logo depois de um tick: REAGENDA p/ o fim do cooldown (não descarta o evento)", () => {
    // o bug óbvio seria dropar o wake — o evento chegou 10s após um tick e sumiria em silêncio.
    const r = wakeTiming({ now, debounceMs, cooldownMs, lastTickAt: now - 10_000 });
    expect(r.dueAt).toBe(now - 10_000 + cooldownMs);
    expect(r.throttled).toBe(true);
  });

  it("tick antigo o bastante: o cooldown não atrasa nada", () => {
    const r = wakeTiming({ now, debounceMs, cooldownMs, lastTickAt: now - 10 * 60_000 });
    expect(r).toEqual({ dueAt: now + debounceMs, throttled: false });
  });

  it("rajada de eventos NÃO adia o wake já agendado (anti-starvation do debounce ingênuo)", () => {
    // um re-arm a cada evento empurraria o wake p/ sempre enquanto um agente escreve em lote.
    const pendingAt = now + 5_000; // wake já marcado p/ daqui a 5s
    expect(wakeTiming({ now, debounceMs, cooldownMs, pendingAt }).dueAt).toBe(pendingAt);
  });

  it("um wake pendente MAIS TARDE que o cooldown não segura o novo horário", () => {
    const r = wakeTiming({ now, debounceMs, cooldownMs, pendingAt: now + 10 * 60_000 });
    expect(r.dueAt).toBe(now + debounceMs); // vence o mais cedo
  });

  it("debounce/cooldown zerados = dispara agora (o operador pode desligar os rails)", () => {
    expect(wakeTiming({ now, debounceMs: 0, cooldownMs: 0, lastTickAt: now }).dueAt).toBe(now);
  });
});
