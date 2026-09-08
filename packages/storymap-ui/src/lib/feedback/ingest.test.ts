import { describe, expect, it } from "vitest";
import {
  forceIngestLink,
  makeIngestResolver,
  MIN_INGEST_TOKEN_LENGTH,
  parseIngestTokens,
} from "./ingest";

const TOKEN = "token-de-repasse-com-tamanho-ok";
const OTHER = "outro-token-de-repasse-tamanho-ok";

describe("parseIngestTokens — the operator's relay bindings", () => {
  it("parses `board:token` pairs and never keeps the plaintext", () => {
    const bindings = parseIngestTokens(`acme:${TOKEN}, storymap:${OTHER}`);
    expect(bindings.map((b) => b.board)).toEqual(["acme", "storymap"]);
    expect(JSON.stringify(bindings)).not.toContain(TOKEN);
  });

  it("OFF by default — absent/empty means the relay lane does not exist", () => {
    expect(parseIngestTokens(undefined)).toEqual([]);
    expect(parseIngestTokens("")).toEqual([]);
    expect(parseIngestTokens(" , ,")).toEqual([]);
  });

  it("DROPS a token shorter than the floor instead of honouring a typo", () => {
    expect(parseIngestTokens("acme:curto")).toEqual([]);
    expect(parseIngestTokens(`acme:${"a".repeat(MIN_INGEST_TOKEN_LENGTH - 1)}`)).toEqual([]);
    expect(parseIngestTokens(`acme:${"a".repeat(MIN_INGEST_TOKEN_LENGTH)}`)).toHaveLength(1);
  });

  it("DROPS an entry whose board is not a slug (it names a directory under boards/)", () => {
    expect(parseIngestTokens(`../etc:${TOKEN}`)).toEqual([]);
    expect(parseIngestTokens(`Nest:${TOKEN}`)).toEqual([]); // uppercase is not a board id
    expect(parseIngestTokens(`:${TOKEN}`)).toEqual([]);
    expect(parseIngestTokens(TOKEN)).toEqual([]); // no separator at all
  });

  it("keeps a token that itself contains a colon (only the FIRST one separates)", () => {
    const bindings = parseIngestTokens(`acme:aaaa:bbbb-cccc-dddd-eeee-ffff`);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].board).toBe("acme");
    expect(makeIngestResolver(bindings)("aaaa:bbbb-cccc-dddd-eeee-ffff")).toBe("acme");
  });
});

describe("makeIngestResolver — possession of the token IS the capability", () => {
  const resolve = makeIngestResolver(parseIngestTokens(`acme:${TOKEN},storymap:${OTHER}`));

  it("maps each token to ITS board", () => {
    expect(resolve(TOKEN)).toBe("acme");
    expect(resolve(OTHER)).toBe("storymap");
  });

  it("refuses anything else — no prefix, no truncation, no empty", () => {
    expect(resolve(`${TOKEN}x`)).toBeNull();
    expect(resolve(TOKEN.slice(0, -1))).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("x".repeat(500))).toBeNull();
  });

  it("an empty binding list admits nothing (the lane is OFF, not open)", () => {
    expect(makeIngestResolver([])(TOKEN)).toBeNull();
  });
});

describe("forceIngestLink — a relay may file a NEW item, in ONE board, and nothing else", () => {
  it("pins the board from the token and carries no card/session", () => {
    expect(forceIngestLink("acme")).toEqual({ kind: "none", board: "acme" });
  });

  // The payload arrives from an anonymous browser, so NOTHING in it may choose a destination. This is
  // the difference from the embed lane, which keeps its payload's board (its origin was allowlisted).
  it("cannot be talked into another board — the collapse takes only the resolved board", () => {
    const link = forceIngestLink("acme");
    expect(link.board).toBe("acme");
    expect(link.cardId).toBeUndefined();
    expect(link.sessionId).toBeUndefined();
  });
});
