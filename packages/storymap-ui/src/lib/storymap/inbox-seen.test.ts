// Unit — o núcleo PURO da marca de visto do Inbox (inbox-seen.ts).
//
// O contrato que estes testes travam é o que o refino comprou: a marca INFORMA, nunca FILTRA. Não
// existe função aqui que devolva "os itens visíveis" — se um dia alguém acrescentar uma, este
// arquivo é onde a discussão volta.

import { describe, expect, it } from "vitest";
import {
  clearSeen,
  coerceInboxSeenState,
  emptyInboxSeenState,
  isSeen,
  itemSeenSignature,
  markSeen,
  pruneSeen,
  sameSeenState,
  seenIdsAmong,
  type SeenableItem,
} from "./inbox-seen";

const AT = "2026-07-26T12:00:00.000Z";

function item(over: Partial<SeenableItem> = {}): SeenableItem {
  return {
    id: "story-x:q:q1",
    kind: "question",
    lane: "pergunta",
    severity: "medium",
    status: "desenvolver",
    since: "2026-07-26T09:00:00.000Z",
    ...over,
  };
}

describe("itemSeenSignature", () => {
  it("é estável para o MESMO pedido", () => {
    expect(itemSeenSignature(item())).toBe(itemSeenSignature(item()));
  });

  it("muda quando o pedido muda materialmente (lane, severidade, status, relógio)", () => {
    const base = itemSeenSignature(item());
    expect(itemSeenSignature(item({ lane: "travado" }))).not.toBe(base);
    expect(itemSeenSignature(item({ severity: "critical" }))).not.toBe(base);
    expect(itemSeenSignature(item({ status: "revisao" }))).not.toBe(base);
    expect(itemSeenSignature(item({ since: "2026-07-26T11:00:00.000Z" }))).not.toBe(base);
  });
});

describe("markSeen / isSeen", () => {
  it("marca o item como já folheado", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(isSeen(state, item())).toBe(true);
  });

  it("um item que MUDOU desde a marca volta a contar como não-visto — você não leu ESTA versão", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(isSeen(state, item({ lane: "travado" }))).toBe(false);
  });

  it("não vaza para outro item", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(isSeen(state, item({ id: "story-y:blocker" }))).toBe(false);
  });

  it("é idempotente — re-marcar re-carimba, não duplica", () => {
    const once = markSeen(emptyInboxSeenState(), item(), AT);
    const twice = markSeen(once, item(), "2026-07-26T13:00:00.000Z");
    expect(Object.keys(twice.seen)).toHaveLength(1);
    expect(twice.seen["story-x:q:q1"]?.at).toBe("2026-07-26T13:00:00.000Z");
  });
});

describe("clearSeen", () => {
  it("desfaz a marca", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(isSeen(clearSeen(state, "story-x:q:q1"), item())).toBe(false);
  });

  it("id ausente é no-op — devolve o MESMO objeto", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(clearSeen(state, "nao-existe")).toBe(state);
  });
});

describe("pruneSeen", () => {
  it("descarta a marca de um item que não existe mais (foi resolvido)", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(pruneSeen(state, []).seen).toEqual({});
  });

  it("descarta a marca cuja assinatura mudou", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(pruneSeen(state, [item({ severity: "critical" })]).seen).toEqual({});
  });

  it("preserva a marca enquanto o item está vivo e igual", () => {
    const state = markSeen(emptyInboxSeenState(), item(), AT);
    expect(pruneSeen(state, [item()]).seen["story-x:q:q1"]?.at).toBe(AT);
  });
});

describe("seenIdsAmong — a marca INFORMA, nunca esconde", () => {
  it("devolve só os ids vistos, sem tocar na lista", () => {
    const a = item({ id: "a" });
    const b = item({ id: "b" });
    const c = item({ id: "c" });
    const state = markSeen(emptyInboxSeenState(), b, AT);
    expect(seenIdsAmong([a, b, c], state)).toEqual(["b"]);
  });

  it("estado vazio ⇒ nenhum id marcado (e a lista do chamador continua inteira)", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(seenIdsAmong(items, emptyInboxSeenState())).toEqual([]);
    expect(items).toHaveLength(2);
  });
});

describe("sameSeenState", () => {
  it("detecta igualdade e diferença (evita reescrever o arquivo a cada render)", () => {
    const s1 = markSeen(emptyInboxSeenState(), item(), AT);
    const s2 = markSeen(emptyInboxSeenState(), item(), AT);
    expect(sameSeenState(s1, s2)).toBe(true);
    expect(sameSeenState(s1, emptyInboxSeenState())).toBe(false);
    expect(sameSeenState(s1, markSeen(emptyInboxSeenState(), item(), "2026-07-26T14:00:00.000Z"))).toBe(false);
  });
});

describe("coerceInboxSeenState", () => {
  it("lê o formato atual", () => {
    const raw = { v: 1, seen: { "story-x:q:q1": { at: AT, sig: "question|pergunta|medium||" } } };
    expect(coerceInboxSeenState(raw).seen["story-x:q:q1"]?.at).toBe(AT);
  });

  it("MIGRA a chave legada `skips` (quando pular escondia) para `seen` — o formato é o mesmo", () => {
    const raw = { v: 1, skips: { "story-x:q:q1": { at: AT, sig: "question|pergunta|medium||" } } };
    expect(coerceInboxSeenState(raw).seen["story-x:q:q1"]?.at).toBe(AT);
  });

  it("descarta lixo em vez de adivinhar", () => {
    expect(coerceInboxSeenState(null).seen).toEqual({});
    expect(coerceInboxSeenState({ seen: "nope" }).seen).toEqual({});
    expect(coerceInboxSeenState({ seen: { a: 3, b: { at: 7 }, c: { at: AT } } }).seen).toEqual({});
  });
});
