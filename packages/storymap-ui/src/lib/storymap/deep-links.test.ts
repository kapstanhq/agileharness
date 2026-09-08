import { describe, expect, it } from "vitest";
import {
  cardHref,
  decodeInboxItemId,
  decodeRouteParam,
  demandHref,
  inboxFocusHref,
  inboxItemHref,
  newCardHref,
  processesMergeHref,
  processesServiceHref,
  runServiceId,
  vocabEntityHref,
} from "./deep-links";
import { DEMAND_GROUP_LABEL, type DemandType } from "./demands";

describe("inboxFocusHref", () => {
  it("builds the inbox deep-link with focus=cardId", () => {
    expect(inboxFocusHref("acme", "c1")).toBe("/board/acme/inbox?focus=c1");
  });

  it("encodes a hostile cardId so it can't break the query", () => {
    const cardId = "c/1 ?x=&y";
    expect(inboxFocusHref("acme", cardId)).toBe(`/board/acme/inbox?focus=${encodeURIComponent(cardId)}`);
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
  const REAL_IDS = [
    "story-lcagq1:b:data-not-landed-b4fcc6e0-9892-484a-8b04-8eba9478b646",
    "story-vkefiw:review",
    "story-abc:q:q1",
    "apr:req-7",
    "gov:draft-12",
    "story-x:approval:triage",
  ];

  it.each(REAL_IDS)("round-trips %s through the URL", (id) => {
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

// A varredura de 2026-07-23 mostrou que a classe é MAIOR que a rota que a revelou: `card/[id]` e
// `vocabulario/[kind]/[id]` comparavam params sem decodificar e só estavam corretas porque os ids em
// disco são slug — uma propriedade dos DADOS de hoje, não do código. O par encode↔decode abaixo é o
// que transforma isso numa propriedade do código.
describe("cardHref / vocabEntityHref — simetria com decodeRouteParam", () => {
  const seg = (href: string) => href.split("/").pop()!;

  it("cardHref round-trips um id comum", () => {
    expect(cardHref("acme", "story-abc")).toBe("/board/acme/card/story-abc");
    expect(decodeRouteParam(seg(cardHref("acme", "story-abc")))).toBe("story-abc");
  });

  it("cardHref round-trips um id hostil", () => {
    const id = "story a/b:c";
    expect(decodeRouteParam(seg(cardHref("acme", id)))).toBe(id);
  });

  it("vocabEntityHref round-trips um id com acento e espaço (o write path aceita isso hoje)", () => {
    const id = "Mãe Solo";
    const href = vocabEntityHref("acme", "persona", id);
    expect(href).toBe(`/board/acme/vocabulario/persona/${encodeURIComponent(id)}`);
    expect(decodeRouteParam(seg(href))).toBe(id);
  });

  it("vocabEntityHref mantém o kind como segmento literal (a página casa contra os literais)", () => {
    expect(vocabEntityHref("acme", "sistema", "api")).toBe("/board/acme/vocabulario/sistema/api");
  });

  it("decodeRouteParam e decodeInboxItemId são a MESMA função (um alias, não uma segunda regra)", () => {
    expect(decodeInboxItemId).toBe(decodeRouteParam);
  });
});

describe("demandHref", () => {
  // Exhaustive over EVERY DemandType — reuses demands.ts's own exhaustive Record (DEMAND_GROUP_LABEL)
  // instead of a hand-copied list, so a new DemandType can't silently slip past this test uncovered.
  const ALL_TYPES = Object.keys(DEMAND_GROUP_LABEL) as DemandType[];
  const TRANSITIONAL_TO_KANBAN: ReadonlySet<DemandType> = new Set(["deploy-unsettled", "release-aging"]);

  it.each(ALL_TYPES)("%s", (type) => {
    const href = demandHref({ type, boardId: "acme", cardId: "c1" });
    if (TRANSITIONAL_TO_KANBAN.has(type)) {
      expect(href).toBe("/board/acme/kanban");
    } else {
      expect(href).toBe("/board/acme/inbox?focus=c1");
    }
  });

  it("encodes a hostile cardId on the inbox path", () => {
    const cardId = "a b/c";
    expect(demandHref({ type: "blocker", boardId: "acme", cardId })).toBe(
      `/board/acme/inbox?focus=${encodeURIComponent(cardId)}`,
    );
  });

  it("does not encode a hostile cardId on the transitional kanban path (no query to protect)", () => {
    expect(demandHref({ type: "release-aging", boardId: "acme", cardId: "a b/c" })).toBe("/board/acme/kanban");
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

describe("cardHref(view) / newCardHref — a página do card é a ÚNICA superfície de detalhe", () => {
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

  it("newCardHref leva só o contexto PRESENTE (um pai vazio não vira `pai=`)", () => {
    expect(newCardHref("storymap", { type: "story" })).toBe("/board/storymap/card/novo?tipo=story");
    expect(newCardHref("storymap", { type: "story", parent: null, release: null, status: null })).toBe(
      "/board/storymap/card/novo?tipo=story",
    );
  });

  it("newCardHref carrega pai/release/status — o '+ story' de uma célula nasce no lugar", () => {
    const href = newCardHref("storymap", {
      type: "story",
      parent: "step-a",
      release: "r1",
      status: "triagem",
    });
    const q = new URLSearchParams(href.split("?")[1]);
    expect(q.get("tipo")).toBe("story");
    expect(q.get("pai")).toBe("step-a");
    expect(q.get("release")).toBe("r1");
    expect(q.get("status")).toBe("triagem");
  });

  it("valores hostis viajam encodados na query (URLSearchParams faz o escape)", () => {
    const href = newCardHref("storymap", { type: "step", parent: "a&b=c" });
    expect(href).toContain("pai=a%26b%3Dc");
    expect(new URLSearchParams(href.split("?")[1]).get("pai")).toBe("a&b=c");
  });
});
