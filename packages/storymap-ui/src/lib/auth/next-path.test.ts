import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/auth/next-path";

describe("saneamento do ?next=", () => {
  it("aceita caminho interno, com query e fragmento", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/board/acme/kanban")).toBe("/board/acme/kanban");
    expect(safeNextPath("/perguntas?focus=abc")).toBe("/perguntas?focus=abc");
    expect(safeNextPath("/board/x/inbox#item-3")).toBe("/board/x/inbox#item-3");
  });

  it("recusa URL absoluta — a tela de login não é trampolim de phishing", () => {
    for (const bad of [
      "https://evil.example",
      "http://evil.example/x",
      "//evil.example",
      "javascript:alert(1)",
      "data:text/html,<h1>x",
    ]) {
      expect(safeNextPath(bad), bad).toBeNull();
    }
  });

  it("recusa BARRA INVERTIDA — o bypass que a checagem óbvia deixava passar", () => {
    // Regressão direta: `/\evil.example` começa com "/" e não com "//", então passava na primeira
    // versão; o parser de URL do WHATWG lê `\` como `/` e o navegador vai para fora do site.
    for (const bad of ["/\\evil.example", "/\\/evil.example", "/\\\\evil.example", "/ok/\\evil"]) {
      expect(safeNextPath(bad), bad).toBeNull();
    }
  });

  it("recusa controle, CR/LF e espaço cru (matéria de header splitting)", () => {
    expect(safeNextPath("/board\r\nSet-Cookie: x=1")).toBeNull();
    expect(safeNextPath("/board\nx")).toBeNull();
    expect(safeNextPath("/board\tx")).toBeNull();
    expect(safeNextPath("/board x")).toBeNull();
    expect(safeNextPath(`/board${String.fromCharCode(0)}x`)).toBeNull();
    expect(safeNextPath(`/board${String.fromCharCode(0x7f)}`)).toBeNull();
  });

  it("recusa vazio, ausente e absurdamente longo", () => {
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath("relativo/sem/barra")).toBeNull();
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBeNull();
  });
});
