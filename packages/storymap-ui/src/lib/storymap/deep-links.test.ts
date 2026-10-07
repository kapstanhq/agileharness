import { describe, expect, it } from "vitest";
import {
  cardHref,
  decodeInboxItemId,
  decodeRouteParam,
  findInboxItem,
  inboxHref,
  inboxItemHref,
  inboxListItemHref,
  processesMergeHref,
  processesServiceHref,
  runServiceId,
} from "./deep-links";

// Auditoria do Inbox — `?focus=<cardId>` acendia o PRIMEIRO item do card: dois itens do mesmo card
// levavam ao mesmo lugar, e um item de board (governança, pedido de agente, aviso do host) virava `?focus=` vazio.
// O link é do ITEM.
describe("inboxListItemHref / inboxHref — o link é do ITEM, nunca do card", () => {
  it("acende UM item na lista pelo id dele (encodado — o id é composto)", () => {
    expect(inboxListItemHref("acme", "c1:q:q1")).toBe("/board/acme/inbox?item=c1%3Aq%3Aq1");
    expect(inboxListItemHref("acme", "gov:d-1")).toBe("/board/acme/inbox?item=gov%3Ad-1");
  });

  it("a lista do board", () => {
    expect(inboxHref("acme")).toBe("/board/acme/inbox");
  });
});

describe("inboxItemHref", () => {
  it("builds the dedicated per-item page path", () => {
    expect(inboxItemHref("acme", "story-abc:q:q1")).toBe(
      `/board/acme/inbox/${encodeURIComponent("story-abc:q:q1")}`,
    );
  });

  it("encodes the opaque composite item id so ':' and friends survive as one path segment", () => {
    const itemId = "apr:req 7/x&y";
    expect(inboxItemHref("acme", itemId)).toBe(
      `/board/acme/inbox/${encodeURIComponent(itemId)}`,
    );
    // round-trips: decoding the segment yields the original id the page matches on.
    const segment = inboxItemHref("acme", itemId).split("/").pop()!;
    expect(decodeURIComponent(segment)).toBe(itemId);
  });
});

describe("decodeInboxItemId", () => {
  // The bug this exists for: Next does NOT decode App-Router params, so the page received
  // "story-x%3Aq%3A1", compared it against "story-x:q:1", found nothing, and told the operator an
  // OPEN blocker had "already been resolved". Every real id shape must survive the round trip.
  const ID_SHAPES = [
    "story-ex9017:b:stale-shelf-7a31d9e2-05c8-4b6f-a1d3-92e0c4f7b815",
    "story-ex9032:review",
    "story-abc:q:q1",
    "apr:req-7",
    "gov:draft-12",
    "story-x:approval:triage",
  ];

  it.each(ID_SHAPES)("round-trips %s through the URL", (id) => {
    const segment = inboxItemHref("acme", id).split("/").pop()!;
    expect(decodeInboxItemId(segment)).toBe(id);
  });

  it("round-trips an id carrying spaces and query-hostile characters", () => {
    const id = "apr:req 7/x&y?z=1";
    const segment = inboxItemHref("acme", id).split("/").pop()!;
    expect(decodeInboxItemId(segment)).toBe(id);
  });

  it("returns a malformed segment verbatim instead of throwing (hand-typed URL ⇒ empty state, not 500)", () => {
    expect(() => decodeInboxItemId("100%")).not.toThrow();
    expect(decodeInboxItemId("100%")).toBe("100%");
  });

  it("leaves an already-decoded segment untouched", () => {
    expect(decodeInboxItemId("story-abc:q:q1")).toBe("story-abc:q:q1");
  });
});

// Uma varredura mostrou que a classe é MAIOR que a rota que a revelou: `card/[id]` e
// `vocabulario/[kind]/[id]` comparavam params sem decodificar e só estavam corretas porque os ids em
// disco são slug — uma propriedade dos DADOS de hoje, não do código. O par encode↔decode abaixo é o
// que transforma isso numa propriedade do código.
// (A página de UMA persona/sistema — `vocabEntityHref` — saiu com Personas & Sistemas na fase 2.)
describe("cardHref — simetria com decodeRouteParam", () => {
  const seg = (href: string) => href.split("/").pop()!;

  it("cardHref round-trips um id comum", () => {
    expect(cardHref("acme", "story-abc")).toBe("/board/acme/card/story-abc");
    expect(decodeRouteParam(seg(cardHref("acme", "story-abc")))).toBe("story-abc");
  });

  it("cardHref round-trips um id hostil", () => {
    const id = "story a/b:c";
    expect(decodeRouteParam(seg(cardHref("acme", id)))).toBe(id);
  });

  // Eram a MESMA função até o link do Inbox chegar re-codificado (abaixo). Divergem só aí: num segmento de UMA
  // camada as duas dão o mesmo valor — e decodeRouteParam segue em uma passada, porque compara segredo e ids abertos.
  it("decodeInboxItemId concorda com decodeRouteParam em todo link de uma camada", () => {
    for (const id of ["story-abc:q:q1", "gov:draft-12", "apr:req 7/x&y?z=1", "Mãe Solo"]) {
      const segment = encodeURIComponent(id);
      expect(decodeInboxItemId(segment), id).toBe(decodeRouteParam(segment));
    }
  });
});

// ── Link do Inbox re-codificado ──────────────────────────────────────────────────────────────────
// Caso real observado: /inbox/gov%3A<id> e /inbox/gov:<id> abriam o item com Aprovar; /inbox/gov%253A<id> — o `%`
// re-codificado por quem renderizou o link, e foi esse o que o operador clicou — mostrava «resolvido» para um item
// que seguia pendente.

describe("decodeInboxItemId — o link que chega re-codificado", () => {
  const ID = "gov:c3a90d17-6e4b-4f28-9b05-1d7e82a4f6c3";
  const once = encodeURIComponent(ID);

  it("uma camada — o link que o app monta", () => {
    expect(decodeInboxItemId(once)).toBe(ID);
  });

  it("duas camadas — gov%253A<id> vira o id, não um item fantasma", () => {
    expect(encodeURIComponent(once)).toBe("gov%253Ac3a90d17-6e4b-4f28-9b05-1d7e82a4f6c3");
    expect(decodeInboxItemId(encodeURIComponent(once))).toBe(ID);
  });

  it("cru — o id escrito à mão na barra", () => {
    expect(decodeInboxItemId(ID)).toBe(ID);
  });

  it("malformado (%E0%A4%A): devolve o segmento, nunca lança", () => {
    expect(() => decodeInboxItemId("%E0%A4%A")).not.toThrow();
    expect(decodeInboxItemId("%E0%A4%A")).toBe("%E0%A4%A");
    // malformado DEPOIS de uma camada boa: para no último passo que decodificou
    expect(decodeInboxItemId(encodeURIComponent("%E0%A4%A"))).toBe("%E0%A4%A");
  });

  it("limitado: três camadas decodificam; a quarta fica como veio da terceira", () => {
    const enc = (s: string, n: number): string => (n === 0 ? s : enc(encodeURIComponent(s), n - 1));
    expect(decodeInboxItemId(enc(ID, 3))).toBe(ID);
    expect(decodeInboxItemId(enc(ID, 4))).toBe(once);
  });
});

describe("findInboxItem — o primeiro degrau de decodificação que nomeia um item vence", () => {
  const items = [{ id: "gov:d1" }, { id: "story-x:q:q%41" }, { id: "story-x:q:qA" }];
  const seg = (id: string) => inboxItemHref("acme", id).split("/").pop()!;

  it("link de uma camada, de duas, e cru — o mesmo item", () => {
    expect(findInboxItem(items, seg("gov:d1"))).toBe(items[0]);
    expect(findInboxItem(items, encodeURIComponent(seg("gov:d1")))).toBe(items[0]);
    expect(findInboxItem(items, "gov:d1")).toBe(items[0]);
  });

  it("um id com %XX de verdade (dado escrito à mão no card) segue abrindo pelo PRÓPRIO link — não vira outro item", () => {
    expect(findInboxItem(items, seg("story-x:q:q%41"))).toBe(items[1]);
    expect(findInboxItem(items, seg("story-x:q:qA"))).toBe(items[2]);
  });

  it("nenhum degrau casa ⇒ null", () => {
    expect(findInboxItem(items, seg("gov:outro"))).toBeNull();
    expect(findInboxItem(items, "%E0%A4%A")).toBeNull();
  });
});

describe("decodeRouteParam fica em UMA passada", () => {
  it("não colapsa camadas: o segredo do MCP e o id aberto de vocabulário comparam exatamente o que veio", () => {
    expect(decodeRouteParam("a%2541")).toBe("a%41");
    expect(decodeRouteParam(encodeURIComponent("50%41 off"))).toBe("50%41 off");
  });
});

describe("processesMergeHref / processesServiceHref / runServiceId", () => {
  it("builds ?run= encoded", () => {
    const runId = "run/abc-123";
    expect(processesMergeHref(runId)).toBe(`/processes?run=${encodeURIComponent(runId)}`);
  });

  it("builds ?svc= encoded", () => {
    const serviceId = "run:acme/c1";
    expect(processesServiceHref(serviceId)).toBe(`/processes?svc=${encodeURIComponent(serviceId)}`);
  });

  it("runServiceId mirrors ProcessesClient.tsx's run:<board>/<cardId> build", () => {
    expect(runServiceId("acme", "c1")).toBe("run:acme/c1");
  });

  it("a hostile serviceId (built from a hostile cardId) still round-trips through the query", () => {
    const serviceId = runServiceId("acme", "c/1 x&y");
    expect(processesServiceHref(serviceId)).toBe(`/processes?svc=${encodeURIComponent(serviceId)}`);
  });
});

describe("cardHref(view) — a página do card é a ÚNICA superfície de detalhe", () => {
  it("sem view, é a rota nua (o caso de todo clique em card)", () => {
    expect(cardHref("storymap", "story-x")).toBe("/board/storymap/card/story-x");
  });

  it("com view, abre JÁ na visão pedida — é o que faz 'Definir o lugar' cair no formulário", () => {
    expect(cardHref("storymap", "story-x", { view: "campos" })).toBe(
      "/board/storymap/card/story-x?view=campos",
    );
  });

  it("o id continua encodado com a view (a query não relaxa a regra do path)", () => {
    expect(cardHref("acme", "story:a b", { view: "markdown" })).toBe(
      `/board/acme/card/${encodeURIComponent("story:a b")}?view=markdown`,
    );
  });
});
