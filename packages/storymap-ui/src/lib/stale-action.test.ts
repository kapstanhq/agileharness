import { describe, expect, it } from "vitest";
import { collectDrafts, draftKey, isStaleActionResponse, restoreDrafts } from "./stale-action";

// A aba de antes de uma atualização chama uma ação que a versão no ar não conhece: a resposta é reconhecida, o rascunho
// é guardado e devolvido só aos campos vazios — senha e campo oculto nunca entram.

const res = (h: Record<string, string>) => new Headers(h);

describe("isStaleActionResponse", () => {
  it("só uma chamada de ação (cabeçalho next-action) com a resposta «ação desconhecida»", () => {
    expect(isStaleActionResponse(new Headers({ "Next-Action": "abc" }), res({ "x-nextjs-action-not-found": "1" }))).toBe(true);
    expect(isStaleActionResponse({ "next-action": "abc" }, res({ "x-nextjs-action-not-found": "1" }))).toBe(true);
    expect(isStaleActionResponse({ "next-action": "abc" }, res({}))).toBe(false);
    expect(isStaleActionResponse({ accept: "text/html" }, res({ "x-nextjs-action-not-found": "1" }))).toBe(false);
    expect(isStaleActionResponse(undefined, res({ "x-nextjs-action-not-found": "1" }))).toBe(false);
  });
});

describe("rascunho", () => {
  it("chave por id, senão name; senha, oculto e campo sem chave ficam de fora", () => {
    expect(draftKey({ id: "nota" })).toBe("#nota");
    expect(draftKey({ name: "motivo" })).toBe("@motivo");
    expect(draftKey({ id: "x", type: "password" })).toBeNull();
    expect(draftKey({ name: "t", type: "hidden" })).toBeNull();
    expect(draftKey({})).toBeNull();
    expect(collectDrafts([{ id: "nota", value: "texto" }, { name: "vazio", value: "  " }, { value: "sem chave" }])).toEqual({ "#nota": "texto" });
  });
  it("devolve só a campos que existem e estão vazios", () => {
    const set: Record<string, string> = {};
    const field = (id: string, value: string) => ({ id, value, setValue: (v: string) => void (set[id] = v) });
    const n = restoreDrafts([field("nota", ""), field("motivo", "já escrito"), field("outro", "")], { "#nota": "texto", "#motivo": "velho" });
    expect(n).toBe(1);
    expect(set).toEqual({ nota: "texto" });
  });
});
