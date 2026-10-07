// 📄 As actions de documento pelo caminho de VERDADE (disco num alvo temporário e INVENTADO, ator MCP real):
//   · salvar o PRD sobre um formato 1, ANTES da migração do boot, não pode perder o contexto dos agentes;
//   · a regra de dono vale no servidor — o BMC e as personas só o dono muda, o resto do PRD só a conversa da
//     página Produto; um run headless recebe a recusa apontando `propose_change`.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/action-guard", () => ({ requireSession: async () => {} }));

const RAIZ = mkdtempSync(path.join(tmpdir(), "doc-actions-"));
const ANTERIOR = process.env.AGILEHARNESS_TARGET;
const docs = (b: string, f: string) => path.join(RAIZ, "storymap", "boards", b, "docs", f);

const PRD_V1 = `---
doc: prd
---

# PRD

## Problema

- O leitor não acha o próximo livro

## Posicionamento

A livraria que conhece o seu gosto.

## Decisões já tomadas

- Recomendação por gosto declarado

## Pronto quando

- A ficha de gosto sugere três livros

## Riscos e perguntas em aberto

- Leitor não preencher a ficha

## Glossário

- Ficha de gosto: o questionário curto do cadastro
`;

function board(id: string, files: Record<string, string> = {}): void {
  mkdirSync(path.join(RAIZ, "storymap", "boards", id, "docs"), { recursive: true });
  writeFileSync(path.join(RAIZ, "storymap", "boards", id, "board.yaml"), `id: ${id}\nname: ${id}\n`, "utf8");
  for (const [f, content] of Object.entries(files)) writeFileSync(docs(id, f), content, "utf8");
}

beforeAll(() => {
  process.env.AGILEHARNESS_TARGET = RAIZ;
  board("livraria", { "prd.md": PRD_V1 });
  board("sebo");
});

afterAll(() => {
  if (ANTERIOR === undefined) delete process.env.AGILEHARNESS_TARGET;
  else process.env.AGILEHARNESS_TARGET = ANTERIOR;
  rmSync(RAIZ, { recursive: true, force: true });
});

describe("salvar o PRD ANTES da migração do boot — o contexto vai junto", () => {
  it("saveDocAction sobre um formato 1 grava o contexto.md (decisões, pronto quando, riscos, glossário) e guarda o original", async () => {
    const { saveDocAction } = await import("./doc-actions");
    const { loadDoc } = await import("@/lib/storymap/doc/schema-doc-io");
    const { setSectionItems } = await import("@/lib/storymap/doc/schema-codec");
    const { PRD_SCHEMA } = await import("@/lib/storymap/doc/schemas/prd");

    // o que a página Produto tem na mão: a projeção v2 em memória, editada pela pessoa
    const loaded = await loadDoc("livraria", "prd");
    const editado = setSectionItems(loaded!.doc, "foraEscopo", [{ text: "Venda de e-books", group: null }], PRD_SCHEMA);
    const r = await saveDocAction({ boardId: "livraria", docType: "prd", doc: editado });
    expect(r).toEqual({ ok: true });

    const ctx = readFileSync(docs("livraria", "contexto.md"), "utf8");
    for (const trecho of ["Recomendação por gosto declarado", "A ficha de gosto sugere três livros", "Leitor não preencher a ficha", "Ficha de gosto"]) {
      expect(ctx, `o contexto perdeu «${trecho}»`).toContain(trecho);
    }
    expect(readFileSync(docs("livraria", ".archive/prd-v1.md"), "utf8"), "o original, byte a byte").toBe(PRD_V1);
    const prd = readFileSync(docs("livraria", "prd.md"), "utf8");
    expect(prd).toContain("format: 2");
    expect(prd).toContain("- Venda de e-books");

    // e os leitores vivos seguem vendo o contexto depois que o formato 1 saiu do disco
    const vivo = await loadDoc("livraria", "contexto");
    expect(vivo?.exists).toBe(true);
    expect(JSON.stringify(vivo?.doc)).toContain("Recomendação por gosto declarado");
  });

  it("a migração do boot depois disso não muda um byte (nada a migrar, nenhuma cópia nova)", async () => {
    const { migrateBoardDocs } = await import("@/lib/storymap/doc/migrate-board-docs");
    const antes = [readFileSync(docs("livraria", "prd.md"), "utf8"), readFileSync(docs("livraria", "contexto.md"), "utf8")];
    const r = await migrateBoardDocs("livraria", { log: () => {} });
    expect(r.migrated).toEqual([]);
    expect([readFileSync(docs("livraria", "prd.md"), "utf8"), readFileSync(docs("livraria", "contexto.md"), "utf8")]).toEqual(antes);
    expect(existsSync(docs("livraria", `.archive/prd-v1-${new Date().toISOString().slice(0, 10)}.md`))).toBe(false);
  });
});

describe("write_doc — a regra de dono vale no servidor", () => {
  const RUN = { level: "write" as const, caller: { kind: "session" as const, id: "run-ex9101" } };
  const PAGINA_PRODUTO = { level: "ro" as const, caller: { kind: "doc-chat" as const, id: "sebo.produto" } };
  const PAGINA_NEGOCIO = { level: "ro" as const, caller: { kind: "doc-chat" as const, id: "sebo.negocio" } };

  async function escrever(actor: Parameters<typeof import("@/lib/storymap/mcp/actor").runWithMcpActor>[0] | null, docType: string, section: string) {
    const { writeDocSectionAction } = await import("./doc-actions");
    const { runWithMcpActor } = await import("@/lib/storymap/mcp/actor");
    const call = () => writeDocSectionAction({ boardId: "sebo", docType, section, items: [{ text: "Colecionador de primeiras edições" }] });
    return actor ? runWithMcpActor(actor, call) : call();
  }

  it("um run headless NÃO escreve as personas do PRD — a recusa aponta propose_change", async () => {
    const r = await escrever(RUN, "prd", "personas");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("propose_change");
    expect(existsSync(docs("sebo", "prd.md"))).toBe(false);
  });

  it("um run headless NÃO escreve no BMC nem nas outras seções do PRD", async () => {
    for (const [docType, section] of [["business-model-canvas", "customerSegments"], ["prd", "problema"]] as const) {
      const r = await escrever(RUN, docType, section);
      expect(r.ok, `${docType}/${section}`).toBe(false);
      expect(!r.ok && r.error).toContain("propose_change");
    }
  });

  it("nem a conversa da página escreve as personas ou o BMC: ali o agente propõe (decisão do dono)", async () => {
    expect((await escrever(PAGINA_PRODUTO, "prd", "personas")).ok).toBe(false);
    expect((await escrever(PAGINA_NEGOCIO, "business-model-canvas", "customerSegments")).ok).toBe(false);
  });

  it("a conversa da página PRODUTO escreve as outras seções do PRD; a de outra página, não", async () => {
    expect((await escrever(PAGINA_NEGOCIO, "prd", "problema")).ok).toBe(false);
    const r = await escrever(PAGINA_PRODUTO, "prd", "problema");
    expect(r).toMatchObject({ ok: true });
    expect(readFileSync(docs("sebo", "prd.md"), "utf8")).toContain("Colecionador de primeiras edições");
  });

  it("o contexto é dos agentes: o run escreve livre", async () => {
    const r = await escrever(RUN, "contexto", "decisoes");
    expect(r).toMatchObject({ ok: true });
  });

  it("o operador (token full) e a própria tela não passam pela regra", async () => {
    expect((await escrever({ level: "full" }, "prd", "personas")).ok).toBe(true);
    expect((await escrever(null, "business-model-canvas", "customerSegments")).ok).toBe(true);
  });
});
