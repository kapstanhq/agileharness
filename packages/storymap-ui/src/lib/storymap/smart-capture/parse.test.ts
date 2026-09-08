import { describe, expect, it } from "vitest";
import { parseProposal } from "./parse";
import { coerceCard } from "../repo";
import type { BoardConfig, Card } from "../types";

// parseProposal is the free-text → cards funnel's hardening layer (pure: string →
// validated Proposal). It also drives extractJsonObject (code fences, prose-before,
// braces-in-strings). A regression here either throws (capture dies) or lets invalid
// data through (a card parented to a ghost id, an invented persona) onto disk.
const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [{ id: "rascunho", name: "Rascunho" }],
  releases: [{ id: "r1", name: "R1", order: 10 }],
  personas: [{ id: "morador", name: "Morador" }],
  systems: [{ id: "whatsapp", name: "WhatsApp" }],
  linkTypes: [],
};
const cards: Card[] = [coerceCard("story-existente", { type: "story", title: "Existe" }, "")];

const parse = (raw: string) => parseProposal(raw, config, cards);

describe("parseProposal — dual-track OST (idea OST-light + story addresses)", () => {
  it("parses OST-light fields on an idea item (trimmed + deduped)", () => {
    const p = parse(JSON.stringify({ items: [{
      tempId: "i1", type: "idea", title: "Dor central",
      candidateSolutions: ["ideia A", "  ideia B  ", "", "ideia A"],
      keyAssumption: "  premissa  ", successSignal: "sinal",
      valueSize: { reach: 100, impact: 2 },
    }] }));
    const o = p.items[0];
    expect(o.type).toBe("idea");
    expect(o.candidateSolutions).toEqual(["ideia A", "ideia B"]);
    expect(o.keyAssumption).toBe("premissa");
    expect(o.successSignal).toBe("sinal");
    expect(o.valueSize).toEqual({ reach: 100, impact: 2 });
  });

  it("drops valueSize when neither axis is a finite number", () => {
    const p = parse(JSON.stringify({ items: [{ tempId: "i1", type: "idea", title: "Dor", valueSize: { reach: "x", impact: null } }] }));
    expect(p.items[0].valueSize).toBeUndefined();
  });

  // WS-9 (D15) retrocompat: capture no longer PROPOSES ◆, but a LEGACY sidecar may still carry one. The parser
  // must keep parsing it (the commit-guard is what bars materialization) — it must NEVER drop/throw on a ◆.
  it("RETROCOMPAT: a legacy ◆ item still parses intact (only the accept mint is barred, not the parse)", () => {
    const p = parse(JSON.stringify({ items: [{
      tempId: "i1", type: "idea", title: "Dor legada", rationale: "r", body: "evidência",
      candidateSolutions: ["sol"], keyAssumption: "premissa",
    }] }));
    expect(p.items).toHaveLength(1);
    expect(p.items[0].type).toBe("idea");
    expect(p.items[0].title).toBe("Dor legada");
    expect(p.items[0].candidateSolutions).toEqual(["sol"]);
  });

  it("ignores OST-light fields on a STORY (idea-only)", () => {
    const p = parse(JSON.stringify({ items: [{ tempId: "i1", type: "story", title: "Trabalho", candidateSolutions: ["x"], keyAssumption: "y" }] }));
    expect(p.items[0].candidateSolutions).toBeUndefined();
    expect(p.items[0].keyAssumption).toBeUndefined();
  });

  it("keeps a story `addresses` pointing at an in-batch idea tempId", () => {
    const p = parse(JSON.stringify({ items: [
      { tempId: "i1", type: "idea", title: "A dor" },
      { tempId: "i2", type: "story", title: "A solução", addresses: "i1" },
    ] }));
    expect(p.items.find((x) => x.tempId === "i2")!.addresses).toBe("i1");
  });

  it("keeps a story `addresses` pointing at an EXISTING card id", () => {
    const p = parse(JSON.stringify({ items: [{ tempId: "i1", type: "story", title: "S", addresses: "story-existente" }] }));
    expect(p.items[0].addresses).toBe("story-existente");
  });

  it("nulls a dangling `addresses` (neither existing id nor in-batch tempId)", () => {
    const p = parse(JSON.stringify({ items: [{ tempId: "i1", type: "story", title: "S", addresses: "fantasma" }] }));
    expect(p.items[0].addresses).toBeNull();
  });

  it("nulls a self-referential `addresses`", () => {
    const p = parse(JSON.stringify({ items: [{ tempId: "i1", type: "story", title: "S", addresses: "i1" }] }));
    expect(p.items[0].addresses).toBeNull();
  });

  it("ignores `addresses` on a non-story (idea/backbone) → null", () => {
    const p = parse(JSON.stringify({ items: [{ tempId: "i1", type: "idea", title: "Dor", addresses: "story-existente" }] }));
    expect(p.items[0].addresses).toBeNull();
  });
});

describe("extractJsonObject (via parseProposal) — tolerant JSON extraction", () => {
  it("parses plain JSON", () => {
    const p = parse('{"summary":"oi","items":[{"title":"A"}]}');
    expect(p.summary).toBe("oi");
    expect(p.items).toHaveLength(1);
    expect(p.items[0].title).toBe("A");
  });

  it("strips a ```json code fence", () => {
    const p = parse('```json\n{"items":[{"title":"Fenced"}]}\n```');
    expect(p.items[0].title).toBe("Fenced");
  });

  it("brace-scans past a stray sentence before the object", () => {
    const p = parse('Aqui está o plano: {"items":[{"title":"X"}]}');
    expect(p.items[0].title).toBe("X");
  });

  it("ignores braces that live inside a string value", () => {
    const p = parse('ruído {"items":[{"title":"a } b { c"}]}');
    expect(p.items[0].title).toBe("a } b { c");
  });

  it("throws when there is no JSON object at all", () => {
    expect(() => parse("não tem json aqui")).toThrow();
  });

  it("returns an empty item list when items is missing/not an array", () => {
    expect(parse('{"summary":"só resumo"}').items).toEqual([]);
  });
});

describe("parseProposal — sanitization against the board vocabulary", () => {
  it("drops items with no usable title", () => {
    const p = parse('{"items":[{"title":""},{"title":"   "},{"foo":1},{"title":"Mantido"}]}');
    expect(p.items.map((i) => i.title)).toEqual(["Mantido"]);
  });

  it("defaults an unknown type to story; keeps a valid type", () => {
    const p = parse('{"items":[{"title":"a","type":"bogus"},{"title":"b","type":"activity"}]}');
    expect(p.items[0].type).toBe("story");
    expect(p.items[1].type).toBe("activity");
  });

  it("assigns stable unique tempIds, deduping collisions", () => {
    const p = parse('{"items":[{"title":"a","tempId":"x"},{"title":"b","tempId":"x"},{"title":"c"}]}');
    const ids = p.items.map((i) => i.tempId);
    expect(ids[0]).toBe("x");
    expect(new Set(ids).size).toBe(3); // all unique despite the duplicate "x"
  });

  it("filters personas/systems/release to the board's real vocab", () => {
    const p = parse(
      '{"items":[{"title":"a","type":"story","personas":["morador","fantasma"],"systems":["whatsapp","nope"],"release":"r1"}]}',
    );
    expect(p.items[0].personas).toEqual(["morador"]);
    expect(p.items[0].systems).toEqual(["whatsapp"]);
    expect(p.items[0].release).toBe("r1");
  });

  it("nulls a release that isn't in the board (and any release on a non-story)", () => {
    expect(parse('{"items":[{"title":"a","type":"story","release":"r9"}]}').items[0].release).toBeNull();
    expect(parse('{"items":[{"title":"a","type":"activity","release":"r1"}]}').items[0].release).toBeNull();
  });

  it("keeps a parent that is an existing card id or an in-batch tempId; nulls dangling/self", () => {
    expect(parse('{"items":[{"title":"c","parent":"story-existente"}]}').items[0].parent).toBe(
      "story-existente",
    );
    const batch = parse('{"items":[{"title":"p","tempId":"p1"},{"title":"c","parent":"p1"}]}');
    expect(batch.items[1].parent).toBe("p1");
    expect(parse('{"items":[{"title":"c","parent":"naoexiste"}]}').items[0].parent).toBeNull();
    expect(parse('{"items":[{"title":"c","tempId":"z","parent":"z"}]}').items[0].parent).toBeNull(); // self
  });

  it("keeps duplicateOf only when it points at an existing card", () => {
    expect(parse('{"items":[{"title":"a","duplicateOf":"story-existente"}]}').items[0].duplicateOf).toBe(
      "story-existente",
    );
    expect(parse('{"items":[{"title":"a","duplicateOf":"inexistente"}]}').items[0].duplicateOf).toBeNull();
  });
});

// story-fpf9hc — campos ricos opcionais (narrative/acceptance/body)
describe("parseProposal — rich fields (narrative/acceptance/body) · story-fpf9hc", () => {
  it("preserves narrative/acceptance/body when all are present and non-empty", () => {
    const item = parse(
      JSON.stringify({
        items: [{
          title: "Ver perfil completo",
          narrative: { role: "usuário", want: "ver meu perfil", soThat: "me apresentar" },
          acceptance: ["Dado X, quando Y, então Z", "Dado A, quando B, então C"],
          body: "Decisão: mostrar avatar e bio sempre visíveis.",
        }],
      }),
    ).items[0];
    expect(item.narrative).toEqual({ role: "usuário", want: "ver meu perfil", soThat: "me apresentar" });
    expect(item.acceptance).toEqual(["Dado X, quando Y, então Z", "Dado A, quando B, então C"]);
    expect(item.body).toBe("Decisão: mostrar avatar e bio sempre visíveis.");
  });

  it("omits narrative/acceptance/body when absent from the item", () => {
    const item = parse(JSON.stringify({ items: [{ title: "Item simples", rationale: "r" }] })).items[0];
    expect(item.narrative).toBeUndefined();
    expect(item.acceptance).toBeUndefined();
    expect(item.body).toBeUndefined();
  });

  it("discards malformed narrative (non-object)", () => {
    const item = parse(JSON.stringify({ items: [{ title: "a", narrative: "string-errada" }] })).items[0];
    expect(item.narrative).toBeUndefined();
  });

  it("discards malformed narrative (array)", () => {
    const item = parse(JSON.stringify({ items: [{ title: "a", narrative: ["r", "w", "s"] }] })).items[0];
    expect(item.narrative).toBeUndefined();
  });

  it("omits narrative when all parts are empty/null", () => {
    const item = parse(JSON.stringify({ items: [{ title: "a", narrative: { role: "", want: null, soThat: "  " } }] })).items[0];
    expect(item.narrative).toBeUndefined();
  });

  it("preserves partial narrative (only want filled)", () => {
    const item = parse(JSON.stringify({ items: [{ title: "a", narrative: { want: "ver algo" } }] })).items[0];
    expect(item.narrative).toEqual({ role: null, want: "ver algo", soThat: null });
  });

  it("discards acceptance entries that are not strings or are empty", () => {
    const item = parse(
      JSON.stringify({ items: [{ title: "a", acceptance: ["válido", 42, "", null, "outro válido"] }] }),
    ).items[0];
    expect(item.acceptance).toEqual(["válido", "outro válido"]);
  });

  it("omits acceptance when array is empty or all entries invalid", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a", acceptance: [] }] })).items[0].acceptance).toBeUndefined();
    expect(parse(JSON.stringify({ items: [{ title: "a", acceptance: [null, 1] }] })).items[0].acceptance).toBeUndefined();
  });

  it("discards acceptance when not an array", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a", acceptance: "string" }] })).items[0].acceptance).toBeUndefined();
  });

  it("omits body when empty string or whitespace-only", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a", body: "" }] })).items[0].body).toBeUndefined();
    expect(parse(JSON.stringify({ items: [{ title: "a", body: "   " }] })).items[0].body).toBeUndefined();
  });

  it("discards body when not a string", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a", body: 123 }] })).items[0].body).toBeUndefined();
  });

  it("does NOT use a vocab allowlist for acceptance (free text, not persona/system ids)", () => {
    const item = parse(
      JSON.stringify({ items: [{ title: "a", acceptance: ["Dado que estou logado, quando acesso, então vejo o badge"] }] }),
    ).items[0];
    expect(item.acceptance).toHaveLength(1);
  });
});

describe("parseProposal — confidence + ambiguous (classification signals)", () => {
  it("keeps a valid confidence and clamps it to [0,1]", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a", confidence: 0.42 }] })).items[0].confidence).toBe(0.42);
    expect(parse(JSON.stringify({ items: [{ title: "a", confidence: 1.7 }] })).items[0].confidence).toBe(1);
    expect(parse(JSON.stringify({ items: [{ title: "a", confidence: -3 }] })).items[0].confidence).toBe(0);
  });

  it("falls back to null confidence when absent or not a finite number", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a" }] })).items[0].confidence).toBeNull();
    expect(parse(JSON.stringify({ items: [{ title: "a", confidence: "x" }] })).items[0].confidence).toBeNull();
  });

  it("keeps ambiguous only when literally true", () => {
    expect(parse(JSON.stringify({ items: [{ title: "a", ambiguous: true }] })).items[0].ambiguous).toBe(true);
    expect(parse(JSON.stringify({ items: [{ title: "a", ambiguous: "yes" }] })).items[0].ambiguous).toBeUndefined();
    expect(parse(JSON.stringify({ items: [{ title: "a" }] })).items[0].ambiguous).toBeUndefined();
  });
});
