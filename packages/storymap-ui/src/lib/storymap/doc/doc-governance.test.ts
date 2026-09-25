// 🏛️ O caminho GOVERNADO dos documentos — a prova de que uma proposta aprovada muda o que o leitor LÊ.
//
// É a propriedade que o Lean Canvas NÃO tem hoje, e por isso ela ganha teste próprio: lá o caminho
// governado grava o campo `canvas:` do `board.yaml` enquanto `loadDoc`, depois da migração, lê só o
// `.md` — a proposta é aprovada, o operador vê "sucesso", e o documento não muda. Um write fantasma
// é pior que uma recusa, porque ninguém vai procurar o defeito.
//
// Escreve em disco de propósito (raiz temporária via `AGILEHARNESS_TARGET`): a pergunta é justamente
// "os bytes aterrissaram no arquivo que a tela lê?", e nenhum teste puro pode respondê-la.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PRD_DOC_TYPE } from "./schemas/prd";
import { LEAN_CANVAS_DOC_TYPE } from "./schemas/lean-canvas";
import type { GovernanceDraft } from "../types";

const RAIZ = mkdtempSync(path.join(tmpdir(), "prd-gov-"));
const BOARD = "acme";
const ANTERIOR = process.env.AGILEHARNESS_TARGET;

beforeAll(() => {
  // Uma raiz que satisfaz ROOT_MARKERS (`storymap/boards`) — o mesmo degrau que o README manda usar.
  mkdirSync(path.join(RAIZ, "storymap", "boards", BOARD), { recursive: true });
  writeFileSync(path.join(RAIZ, "storymap", "boards", BOARD, "board.yaml"), `id: ${BOARD}\nname: Acme\n`, "utf8");
  process.env.AGILEHARNESS_TARGET = RAIZ;
});

afterAll(() => {
  if (ANTERIOR === undefined) delete process.env.AGILEHARNESS_TARGET;
  else process.env.AGILEHARNESS_TARGET = ANTERIOR;
  rmSync(RAIZ, { recursive: true, force: true });
});

const config = () => ({ id: BOARD, name: "Acme" }) as never;

describe("prd-governance — a seção como artefato governado", () => {
  it("a chave da seção é validada contra o SCHEMA, e a recusa enumera as válidas", async () => {
    const { isPrdSection, prdSectionKeys } = await import("./doc-governance");
    expect(isPrdSection("posicionamento")).toBe(true);
    expect(isPrdSection("escopo")).toBe(true);
    expect(isPrdSection("inventada")).toBe(false);
    expect(isPrdSection(null)).toBe(false);
    expect(prdSectionKeys().length, "não-vacuidade: o schema tem seções").toBeGreaterThan(10);
  });

  it("aplicar uma seção GRAVA no arquivo que a tela lê — e reler devolve o texto", async () => {
    const { applyPrdSection, readPrdSection } = await import("./doc-governance");
    const { boardDocPath } = await import("../paths");

    expect(await readPrdSection(BOARD, "posicionamento", config()), "nasce vazio").toBe("");

    const r = await applyPrdSection(BOARD, "posicionamento", "Para quem compra por indicação, a Aurora conhece o seu gosto.", config());
    expect(r.ok, "ok" in r && !r.ok ? r.error : "").toBe(true);

    // Os BYTES, não só o retorno: é a diferença entre "a função disse que gravou" e "gravou".
    const arquivo = boardDocPath(BOARD, "prd");
    expect(existsSync(arquivo), "o .md do PRD não foi criado").toBe(true);
    expect(readFileSync(arquivo, "utf8")).toContain("Para quem compra por indicação");
    expect(await readPrdSection(BOARD, "posicionamento", config())).toContain("a Aurora conhece o seu gosto");
  });

  it("uma seção de ITENS aterrissa como itens, não como um parágrafo", async () => {
    const { applyPrdSection } = await import("./doc-governance");
    const { loadDoc } = await import("./schema-doc-io");
    const { sectionItems } = await import("./schema-codec");

    await applyPrdSection(BOARD, "resultadoAlvo", "- Dobrar os pedidos por recomendação\n- Reduzir a devolução pela metade", config());
    const carregado = await loadDoc(BOARD, "prd", config());
    expect(sectionItems(carregado!.doc, "resultadoAlvo").map((i) => i.text)).toEqual([
      "Dobrar os pedidos por recomendação",
      "Reduzir a devolução pela metade",
    ]);
  });

  it("o RÓTULO travado sobrevive: quem propõe manda só o corpo, e o título vem do schema", async () => {
    const { applyPrdSection, readPrdSection } = await import("./doc-governance");
    const { boardDocPath } = await import("../paths");

    // Uma proposta que tentasse trocar o título mandaria isto como corpo. O parser o trata como
    // conteúdo da seção — o heading travado continua sendo o do schema.
    await applyPrdSection(BOARD, "posicionamento", "Texto novo do posicionamento.", config());
    const bruto = readFileSync(boardDocPath(BOARD, "prd"), "utf8");
    expect(bruto).toContain("## Posicionamento");
    expect(bruto).not.toContain("## Posicionamento estratégico");
    expect(await readPrdSection(BOARD, "posicionamento", config())).toBe("Texto novo do posicionamento.");
  });

  it("uma seção que o schema não conhece é RECUSADA, e nada é gravado", async () => {
    const { applyPrdSection } = await import("./doc-governance");
    const { boardDocPath } = await import("../paths");
    const antes = readFileSync(boardDocPath(BOARD, "prd"), "utf8");

    const r = await applyPrdSection(BOARD, "secaoQueNaoExiste", "qualquer coisa", config());
    expect(r.ok).toBe(false);
    expect("error" in r ? r.error : "").toContain("Seção desconhecida");
    expect(readFileSync(boardDocPath(BOARD, "prd"), "utf8"), "o documento foi tocado numa recusa").toBe(antes);
  });
});

describe("prdBacklogSeed — o recorte que semeia a captura", () => {
  it("vazio enquanto o PRD não disser o que construir — e é o BOTÃO que some", async () => {
    // A propriedade negativa vem primeiro porque é a que importa: semear a captura com nada
    // devolveria uma proposta inventada, com exatamente a mesma cara de uma proposta boa.
    const { prdBacklogSeed } = await import("../board-strategy");
    expect(await prdBacklogSeed(BOARD, config())).toBe("");
  });

  it("carrega jornadas, escopo e solução — e NÃO o documento inteiro", async () => {
    const { applyPrdSection } = await import("./doc-governance");
    const { prdBacklogSeed } = await import("../board-strategy");

    await applyPrdSection(BOARD, "jornadas", "- Descobrir um livro pelo gosto declarado", config());
    await applyPrdSection(BOARD, "escopo", "### Nesta versão\n\n- Curadoria por gosto\n\n### Fora, por ora\n\n- Fidelidade", config());
    await applyPrdSection(BOARD, "solucao", "- Trecho do audiolivro antes de comprar", config());
    await applyPrdSection(BOARD, "modeloNegocio", "- Assinatura mensal de 39 reais", config());
    await applyPrdSection(BOARD, "glossario", "- **Curadoria** — a escolha da casa", config());

    const semente = await prdBacklogSeed(BOARD, config());
    expect(semente).toContain("Descobrir um livro pelo gosto declarado");
    expect(semente).toContain("Curadoria por gosto");
    expect(semente).toContain("Trecho do audiolivro antes de comprar");

    // O "Fora, por ora" viaja DE PROPÓSITO: dizer o que não fazer é o que impede a captura de propor
    // exatamente aquilo — a proposta que o operador mais gasta tempo recusando à mão.
    expect(semente).toContain("Fidelidade");

    // As seções que descrevem o PRODUTO e não o TRABALHO ficam fora: com elas, a captura cunha card
    // para "Modelo de negócio" e "Glossário".
    expect(semente).not.toContain("Assinatura mensal");
    expect(semente).not.toContain("a escolha da casa");
    // E o norte também não se repete aqui — ele já entra no prompt da captura por outro canal.
    expect(semente).not.toContain("a Aurora conhece o seu gosto");
  });
});

describe("docIsCanonical — a régua que decide ONDE a aprovação grava", () => {
  it("o PRD é SEMPRE documento; o canvas só depois de o `.md` existir", async () => {
    const { docIsCanonical } = await import("./doc-governance");
    const { applyGovernedChange } = await import("./doc-governance");

    // O PRD nasceu markdown — a escada do board.yaml nunca mais é lida depois da migração.
    expect(await docIsCanonical(BOARD, "prd")).toBe(true);

    // O canvas AINDA não: sem o `.md`, `loadDoc` projeta do board.yaml e o YAML É o canônico.
    // Gravar no documento aqui deixaria o campo `canvas:` sendo lido por quem projeta e escrito
    // por mais ninguém — que é exatamente o defeito que este módulo existe para não repetir.
    expect(await docIsCanonical(BOARD, "canvas")).toBe(false);
    expect(await docIsCanonical(BOARD, "canvasTags")).toBe(false);

    // Depois que o documento existe, ele passa a ser o canônico — e a aprovação o segue.
    await applyGovernedChange(BOARD, "canvas", "problem", { items: [{ id: "i1", text: "A dor de verdade." }] });
    expect(await docIsCanonical(BOARD, "canvas")).toBe(true);
    expect(await docIsCanonical(BOARD, "canvasTags")).toBe(true);
  });

  it("um campo comum do board.yaml NÃO é documento — segue o caminho de config", async () => {
    const { docIsCanonical, governedDoc } = await import("./doc-governance");
    for (const artefato of ["positioning", "businessMetric", "desiredOutcome", "releases", "personas"]) {
      expect(governedDoc(artefato), artefato).toBeUndefined();
      expect(await docIsCanonical(BOARD, artefato), artefato).toBe(false);
    }
  });

  it("o canvas grava ITENS pela MESMA conversão da projeção — e as tags vão para o frontmatter", async () => {
    const { applyGovernedChange, readGovernedValue } = await import("./doc-governance");
    const { boardDocPath } = await import("../paths");

    await applyGovernedChange(BOARD, "canvasTags", null, [{ id: "demanda", name: "Demanda", color: "#E8A13C" }]);
    await applyGovernedChange(BOARD, "canvas", "problem", {
      items: [{ id: "i1", text: "Não acha o próximo livro.", tags: ["demanda"] }],
    });

    const bruto = readFileSync(boardDocPath(BOARD, "lean-canvas"), "utf8");
    // O prefixo `**Etiqueta** — texto` é a convenção de LEITURA da projeção; a governança precisa
    // produzir a mesma coisa, senão os dois caminhos escrevem dialetos diferentes no mesmo arquivo.
    expect(bruto).toContain("**Demanda** — Não acha o próximo livro.");
    expect(bruto).toContain("id: demanda");
    expect(await readGovernedValue(BOARD, "canvasTags", null)).toEqual([
      { id: "demanda", name: "Demanda", color: "#E8A13C" },
    ]);
  });
});

// ── A proposta pendente vista de DENTRO do documento ──────────────────────────────────────────────
//
// O dono abriu o PRD e leu a versão velha sem saber que a nova esperava um clique no Inbox. A tela do
// documento passa a avisar — e quem decide QUAIS propostas são deste documento é o mesmo mapa
// artefato → documento que a aprovação usa, nunca uma segunda lista.

describe("pendingDraftsForDoc — as propostas pendentes que mudam ESTE documento", () => {
  const AGORA = Date.parse("2026-09-25T12:00:00Z");
  const secao = (field: string) => ({ artifact: "prd" as const, field, before: "", after: "x" });
  const draft = (id: string, over: Partial<GovernanceDraft> = {}): GovernanceDraft => ({
    id,
    board: BOARD,
    status: "pending",
    reason: "",
    origin: { skill: "harness-plan", cardId: null },
    changes: [secao("resumo")],
    createdAt: "2026-09-25",
    decidedAt: null,
    ...over,
  });

  it("só a PENDENTE avisa: aprovada, rejeitada e retirada já não mudam nada", async () => {
    const { pendingDraftsForDoc } = await import("./doc-governance");
    const drafts = [
      draft("pendente"),
      draft("aprovada", { status: "approved", decidedAt: "2026-09-25" }),
      draft("rejeitada", { status: "rejected", decidedAt: "2026-09-25" }),
      draft("retirada", { status: "rejected", decidedAt: "2026-09-25", withdrawnBy: "agent" }),
    ];
    expect(pendingDraftsForDoc(drafts, PRD_DOC_TYPE, AGORA).map((d) => d.id)).toEqual(["pendente"]);
  });

  it("a VENCIDA não avisa — o Inbox já a escondeu, e o link cairia num item que não existe", async () => {
    const { pendingDraftsForDoc } = await import("./doc-governance");
    const velha = draft("velha", { createdAt: "2026-01-01" });
    expect(pendingDraftsForDoc([velha], PRD_DOC_TYPE, AGORA)).toEqual([]);
  });

  it("o artefato decide o documento: prd → PRD; canvas e canvasTags → Lean Canvas; campo do board.yaml → nenhum", async () => {
    const { pendingDraftsForDoc } = await import("./doc-governance");
    const prd = draft("prd");
    const canvas = draft("canvas", { changes: [{ artifact: "canvas", field: "problem", before: null, after: { items: [] } }] });
    const tags = draft("tags", { changes: [{ artifact: "canvasTags", field: null, before: [], after: [] }] });
    const yaml = draft("yaml", { changes: [{ artifact: "positioning", field: null, before: "a", after: "b" }] });
    const todos = [prd, canvas, tags, yaml];

    expect(pendingDraftsForDoc(todos, PRD_DOC_TYPE, AGORA).map((d) => d.id)).toEqual(["prd"]);
    expect(pendingDraftsForDoc(todos, LEAN_CANVAS_DOC_TYPE, AGORA).map((d) => d.id).sort()).toEqual(["canvas", "tags"]);
    expect(pendingDraftsForDoc(todos, "documento-que-nao-existe", AGORA)).toEqual([]);
  });

  it("a proposta MISTA aparece nos dois documentos, cada um com só as mudanças dele", async () => {
    const { pendingDraftsForDoc } = await import("./doc-governance");
    const mista = draft("mista", {
      changes: [
        secao("resumo"),
        secao("problema"),
        { artifact: "canvas", field: "problem", before: null, after: { items: [] } },
        { artifact: "personas", field: null, before: [], after: [] },
      ],
    });

    const noPrd = pendingDraftsForDoc([mista], PRD_DOC_TYPE, AGORA);
    expect(noPrd).toHaveLength(1);
    expect(noPrd[0].changes.map((c) => c.field)).toEqual(["resumo", "problema"]);
    const noCanvas = pendingDraftsForDoc([mista], LEAN_CANVAS_DOC_TYPE, AGORA);
    expect(noCanvas[0].changes.map((c) => c.artifact)).toEqual(["canvas"]);
    // O recorte é uma CÓPIA: a proposta em si segue inteira para quem a decide.
    expect(mista.changes).toHaveLength(4);
  });

  it("várias pendentes: todas, a mais nova primeiro (empate pelo id, para a ordem não depender do disco)", async () => {
    const { pendingDraftsForDoc } = await import("./doc-governance");
    const drafts = [
      draft("b-antiga", { createdAt: "2026-09-20" }),
      draft("c-nova", { createdAt: "2026-09-24" }),
      draft("a-nova", { createdAt: "2026-09-24" }),
    ];
    expect(pendingDraftsForDoc(drafts, PRD_DOC_TYPE, AGORA).map((d) => d.id)).toEqual(["a-nova", "c-nova", "b-antiga"]);
  });
});
