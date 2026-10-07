import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docPageLayout, docStatusLine, isSchemaDocEmpty, readModelWithHints } from "./doc-page";
import { emptySchemaDoc, setSectionItems } from "@/lib/storymap/doc/schema-codec";
import { PRD_SCHEMA } from "@/lib/storymap/doc/schemas/prd";
import { reattachBindings, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { boardLayoutFor } from "./views/board-layouts";
import { orderStyleModel, STYLE_PAGE_GROUPS, STYLE_PAGE_ORDER } from "../design/style-page";
import { commitStyleDoc, projectStyleDoc } from "@/lib/storymap/doc/style-doc";
import { coerceStyleGuideDoc } from "@/lib/storymap/style-guide";
import { STYLE_SECTION_KEYS } from "@/lib/storymap/style-guide-blocks";

// CONTRATO das páginas de documento da fase 2 (Negócio, Produto, Design) — asserido sobre a FONTE onde é desenho (o
// rig é node-env, sem DOM) e sobre as funções PURAS onde é regra. Cada item é uma decisão do dono que uma edição
// distraída desfaz sem quebrar mais nada: uma vista por documento, UM botão, a conversa no compositor do rodapé.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const page = read("./DocPage.tsx");
const design = read("../design/DesignScreen.tsx");
const editorTheme = read("./blocknote/theme.css");
const editorImpl = read("./blocknote/DocEditorImpl.tsx");

describe("DocPage — uma casca simples, uma vista fixa por documento", () => {
  it("o canvas é um QUADRO; o PRD (e qualquer outro) é DOCUMENTO", () => {
    expect(docPageLayout("business-model-canvas")).toBe("quadro");
    expect(docPageLayout("prd")).toBe("documento");
  });

  it("não há trocador de views nem trilho de conversa", () => {
    for (const src of [page, design]) {
      expect(src).not.toMatch(/availableViews|DocShell|ChatDock|ViewChat|useDocViewPref/);
    }
  });

  it("UM botão Editar ⇄ Salvar (Cancelar só enquanto se edita)", () => {
    expect(page).toContain('{editing ? (saving ? "Salvando…" : "Salvar") : "Editar"}');
    expect(page).toMatch(/\{editing && \(\s*<button[\s\S]{0,200}onClick=\{onCancel\}/);
  });

  it("a conversa da página é o compositor do rodapé, com a superfície do documento", () => {
    expect(page).toMatch(/<BoardHeader [^>]*chatSurface=\{chatSurface\}/);
    expect(page).toMatch(/chatSurfaceFor\(view\)/);
    expect(design).toMatch(/chatSurfaceFor\("design"\)/);
  });

  it("o fim do conteúdo não fica atrás do compositor, e o lembrete de salvar gruda logo acima dele", () => {
    expect(page).toMatch(/<main className=\{cn\([^)]*composerGutter\)\}/);
    expect(page).toMatch(/sticky z-20[^"]*", aboveComposer\)/);
  });

  it("os avisos têm provedor próprio — sem ele um `toast` de recusa some calado", () => {
    expect(page).toMatch(/<ToastProvider>\s*<SchemaDocPageInner/);
    expect(design).toMatch(/<ToastProvider>\s*<DesignScreenInner/);
  });
});

describe("docStatusLine — o estado em palavras", () => {
  it("salvo, editando, alterado, salvando e o que impede", () => {
    expect(docStatusLine({ editing: false, dirty: false, saving: false, errors: 0 })).toBe("Salvo");
    expect(docStatusLine({ editing: true, dirty: false, saving: false, errors: 0 })).toBe("Editando — nada mudou ainda");
    expect(docStatusLine({ editing: true, dirty: true, saving: false, errors: 0 })).toBe("Alterações não salvas");
    expect(docStatusLine({ editing: true, dirty: true, saving: true, errors: 0 })).toBe("Salvando…");
    expect(docStatusLine({ editing: true, dirty: true, saving: false, errors: 2 })).toBe("2 problemas impedem de salvar");
  });
});

describe("o quadro do Business Model Canvas", () => {
  it("só posiciona a partir de `lg` — no celular vira lista, na ordem de preenchimento", () => {
    const layout = boardLayoutFor("business-model-canvas")!;
    for (const cell of Object.values(layout.cells)) for (const cls of cell.split(" ")) expect(cls).toMatch(/^lg:/);
    expect(layout.container.split(" ").every((c) => c.startsWith("lg:"))).toBe(true);
  });

  it("a grade clássica: Parcerias, Proposta e Segmentos ocupam as duas linhas; Custos e Receitas dividem a de baixo", () => {
    const { cells } = boardLayoutFor("business-model-canvas")!;
    for (const tall of ["keyPartners", "valuePropositions", "customerSegments"]) expect(cells[tall]).toContain("lg:row-span-2");
    expect(cells.costStructure).toContain("lg:row-start-3");
    expect(cells.revenueStreams).toContain("lg:row-start-3");
  });

  it("um bloco longo não estica os curtos: linhas pelo conteúdo e cada célula do tamanho dela; um só estilo de item", () => {
    const layout = boardLayoutFor("business-model-canvas")!;
    expect(layout.container).not.toMatch(/1fr/);
    for (const cell of Object.values(layout.cells)) expect(cell).toContain("lg:self-start");
    expect(layout.compact ?? []).toEqual([]);
  });
});

describe("a página de Design — o guia na linguagem de quem o lê", () => {
  it("Tom · Cores · Tipografia · Estética · Componentes · e, recolhidos, Anti-padrões e dívidas", () => {
    expect(STYLE_PAGE_GROUPS.map((g) => g.label)).toEqual(["Tom", "Cores", "Tipografia", "Estética", "Componentes", "Anti-padrões e dívidas"]);
    expect(STYLE_PAGE_GROUPS.filter((g) => g.collapsed).map((g) => g.id)).toEqual(["cuidados"]);
  });

  it("cobre TODA seção do guia, uma vez — nada some da página", () => {
    expect([...STYLE_PAGE_ORDER].sort()).toEqual([...STYLE_SECTION_KEYS].sort());
  });

  it("rearrumar o editor na ordem da página não muda o que se salva (o commit lê por vínculo)", () => {
    const guide = coerceStyleGuideDoc({
      meta: { version: 2, updatedAt: "2026-10-01", sources: { refs: [] } },
      identity: { school: "editorial de livraria", personality: ["calmo"], prose: "A marca indica, não grita." },
      voice: { lexicon: { preferred: [{ use: "exemplar", avoid: "unidade" }], forbidden: [], exceptions: [] }, prose: "Fala como livreiro." },
      components: { items: [{ name: "Botão de compra", rule: "um por página de livro" }], prose: "Poucos e firmes." },
    });
    const ordered = orderStyleModel(projectStyleDoc(guide));
    // o primeiro título vinculado é o TOM (voice), não a identidade (a ordem do arquivo)
    const firstHeading = ordered.blocks.find((b) => b.kind === "heading");
    expect(firstHeading && "binding" in firstHeading ? firstHeading.binding : null).toBe("style:voice");
    const res = commitStyleDoc(ordered, guide);
    expect(res.unbound).toEqual([]);
    expect(res.changedSections).toEqual([]);
    // a prosa de Componentes é editável como as outras
    expect(ordered.blocks.some((b) => b.kind === "heading" && b.binding === "style:components")).toBe(true);
  });

  it("guia vazio convida a pedir ao assistente pelo compositor (nunca o painel de autoria antigo)", () => {
    expect(design).toContain('export const EMPTY_GUIDE_DRAFT = "Escreva o guia de estilo a partir de ";');
    expect(design).toMatch(/openJidoChat\(\{ draft: EMPTY_GUIDE_DRAFT \}\)/);
    expect(design).not.toMatch(/import[^\n]*(requestStyleGuideAssistAction|RefsUploader|EstiloView)/);
  });
});

describe("as três páginas falam a MESMA escala e a mesma fonte", () => {
  it("título da página > seção > subseção: o h1 da casca é DOC.title; as seções do guia são DOC.h1, como as do PRD", () => {
    expect(page).toMatch(/<h1 className=\{cn\("text-fg-strong", DOC\.title\)\}>\{title\}<\/h1>/);
    expect(design).toMatch(/<h2 className=\{cn\("mb-3 text-fg-strong", DOC\.h1\)\}>\{g\.label\}<\/h2>/);
    expect(design).toMatch(/DOC\.h3\)\}>\{STYLE_SUB_LABEL/);
    // nada de corpo em 13/14px no guia: o corpo é DOC.body, como no PRD
    expect(design).not.toMatch(/text-\[1[34]px\] leading-relaxed/);
  });

  it("o editor não tem fonte própria: herda a da página (Editar não troca a fonte do documento)", () => {
    expect(editorTheme).toMatch(/--bn-font-family: var\(--font-sans\)/);
    // a pilha de fábrica do BlockNote mora em `.bn-default-styles` — vencida aqui
    expect(editorTheme).toMatch(/\.bn-root\[data-color-scheme\] \.bn-default-styles,[\s\S]{0,80}font-family: var\(--bn-font-family\)/);
    for (const decl of editorTheme.match(/(?<![-\w])font-family:[^;]*;/g) ?? []) expect(decl).toMatch(/var\(--bn-font-family\)/);
    expect(editorImpl).not.toMatch(/fontFamily|font-family/);
  });

  it("Salvar só é o botão principal quando há o que salvar", () => {
    expect(page).toMatch(/editing && dirty\s*\?\s*saveBlocked/);
  });
});

describe("documento vazio — a leitura diz o que escrever", () => {
  const vazio = emptySchemaDoc(PRD_SCHEMA);
  const meio = setSectionItems(vazio, "problema", [{ text: "O leitor não acha o próximo livro", group: null }], PRD_SCHEMA);

  it("todas as seções vazias ⇒ vazio; uma linha escrita ⇒ não", () => {
    expect(isSchemaDocEmpty(vazio)).toBe(true);
    expect(isSchemaDocEmpty(meio)).toBe(false);
  });

  it("cada seção VAZIA ganha a dica do schema como legenda discreta; a preenchida não", () => {
    const blocks = readModelWithHints(meio, PRD_SCHEMA).blocks;
    const notes = blocks.filter((b): b is Extract<DocBlock, { kind: "section" }> => b.kind === "section" && b.tone === "note");
    const vazias = PRD_SCHEMA.sections.filter((r) => r.key !== "problema");
    expect(notes.map((n) => n.label)).toEqual(vazias.map((r) => r.hint));
    const problema = blocks.findIndex((b) => b.kind === "heading" && b.text === "Problema");
    expect(blocks[problema + 1].kind).not.toBe("section");
  });

  it("o PRD vazio mostra UM botão que abre a conversa com «Começar pelo começo» escrito (nada é enviado sozinho)", () => {
    expect(page).toMatch(/empty && surface\?\.emptyStart/);
    expect(page).toMatch(/onClick=\{\(\) => openJidoChat\(\{ draft: prompt \}\)\}/);
  });
});

describe("Design — a edição tem o mesmo desenho da leitura, e o dono edita o tom", () => {
  const guide = coerceStyleGuideDoc({
    meta: { version: 3, updatedAt: "2026-10-01T10:00:00.000Z", sources: { refs: [] } },
    identity: { school: "editorial", personality: ["calmo"], prose: "A marca indica." },
    voice: { lexicon: { preferred: [{ use: "exemplar", avoid: "unidade" }], forbidden: ["promoção imperdível"], exceptions: [] }, prose: "Fala como livreiro." },
    color: { tokens: [{ role: "fundo", value: "#ffffff" }], budgetRules: [], prose: "" },
  });
  const ordered = orderStyleModel(projectStyleDoc(guide));
  const headings = ordered.blocks.filter((b): b is Extract<DocBlock, { kind: "heading" }> => b.kind === "heading");

  it("os títulos são os da leitura (Tom, Cores, Estética › Identidade…), sem propriedades com data crua", () => {
    const h2 = headings.filter((h) => h.level === 2).map((h) => h.text);
    expect(h2).toEqual(STYLE_PAGE_GROUPS.map((g) => g.label));
    expect(headings.some((h) => h.level === 3 && h.text === "Identidade")).toBe(true);
    expect(ordered.blocks.some((b) => b.kind === "properties")).toBe(false);
    expect(JSON.stringify(ordered)).not.toContain("2026-10-01T10:00");
  });

  it("o dado mantido pelo assistente é uma LEGENDA discreta (tom note), não um H2 repetido por seção", () => {
    const ro = ordered.blocks.filter((b): b is Extract<DocBlock, { kind: "section" }> => b.kind === "section");
    expect(ro.length).toBeGreaterThan(0);
    for (const r of ro) {
      expect(r.tone).toBe("note");
      expect(r.label).not.toMatch(/Estruturado/);
    }
  });

  it("o léxico do TOM é editável e volta para o guia (o assistente não pode escrevê-lo; o dono, sim)", () => {
    const blocks = ordered.blocks.map((b): DocBlock => {
      if (b.kind === "bullet" && b.text === "exemplar → unidade") return { ...b, text: "exemplar → item" };
      if (b.kind === "bullet" && b.text === "promoção imperdível") return { ...b, text: "oferta relâmpago" };
      return b;
    });
    // o editor devolve títulos sem vínculo: a re-anexação por nível+texto os recupera
    const fromEditor = blocks.map((b) => (b.kind === "heading" ? { ...b, binding: undefined } : b));
    const res = commitStyleDoc({ ...ordered, blocks: reattachBindings(fromEditor, ordered.blocks) }, guide);
    expect(res.unbound).toEqual([]);
    expect(res.changedSections).toEqual(["voice"]);
    expect(res.doc.voice.lexicon.preferred).toEqual([{ use: "exemplar", avoid: "item" }]);
    expect(res.doc.voice.lexicon.forbidden).toEqual(["oferta relâmpago"]);
    expect(res.doc.voice.prose).toBe("Fala como livreiro.");
  });

  it("guia vazio: sem Editar (o estado vazio já leva ao assistente) e com ações rápidas de COMEÇAR", () => {
    expect(design).toMatch(/canEdit=\{!!styleGuide\}/);
    expect(design).toMatch(/empty: !styleGuide/);
  });
});

