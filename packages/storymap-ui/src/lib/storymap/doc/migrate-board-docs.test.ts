// 🔁 A migração GRAVANDO — num diretório de boards temporário e INVENTADO (raiz via
// `AGILEHARNESS_TARGET`). As perguntas só o disco responde: o original foi guardado? o que já migrou
// ficou intacto na segunda vez? o `board.yaml` foi tocado? e, antes do boot, quem lê vê o formato novo?

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RAIZ = mkdtempSync(path.join(tmpdir(), "docs-migra-"));
const ANTERIOR = process.env.AGILEHARNESS_TARGET;
const boardDir = (b: string) => path.join(RAIZ, "storymap", "boards", b);
const docs = (b: string, f: string) => path.join(boardDir(b), "docs", f);

const PRD_V1 = `---
doc: prd
---

# PRD

## Resumo executivo

A livraria Aurora leva a curadoria do balcão para a internet.

## Público

### Leitor frequente

- Quer o próximo livro sem a lista de mais vendidos.

## Posicionamento

A livraria que conhece o seu gosto.

## Escopo

### Nesta versão

- Ficha de gosto online

### Nunca

- Recomendar por histórico de compra

## Decisões já tomadas

- Recomendação por gosto declarado
`;

const YAML_COM_CANVAS = `id: livraria
name: Livraria
canvasTags:
  - id: leitor
    name: Leitor
    color: "#336699"
canvas:
  customerSegments:
    items:
      - id: i1
        text: Leitor frequente
        tags: [leitor]
  problem:
    items:
      - id: i2
        text: Só acha o mais vendido
`;

const LEAN_MD = `---
doc: lean-canvas
---

# Lean Canvas

## Segmentos de clientes

- Quem presenteia

## Problema

- Medo de errar o presente

## Proposta de valor única

- Presente certo, com devolução incluída

## Solução

## Canais

## Fontes de receita

## Estrutura de custos

## Métricas-chave

## Vantagem injusta
`;

function board(id: string, yaml: string, files: Record<string, string> = {}): void {
  mkdirSync(path.join(boardDir(id), "docs"), { recursive: true });
  writeFileSync(path.join(boardDir(id), "board.yaml"), yaml, "utf8");
  for (const [f, content] of Object.entries(files)) writeFileSync(docs(id, f), content, "utf8");
}

/** Os bytes de toda a pasta `docs/` (com `.archive/`) — a foto que a idempotência compara. */
function snapshot(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(full, "utf8");
    }
  };
  walk(path.join(boardDir(id), "docs"), "");
  return out;
}

beforeAll(() => {
  process.env.AGILEHARNESS_TARGET = RAIZ;
  board("livraria", YAML_COM_CANVAS, { "prd.md": PRD_V1 });
  board("presentes", "id: presentes\nname: Presentes\n", { "lean-canvas.md": LEAN_MD });
  board("contexto-antigo", "id: contexto-antigo\nname: Contexto antigo\n", {
    "prd.md": PRD_V1,
    "contexto.md": "---\ndoc: contexto\n---\n\n# Contexto para os agentes\n\n## Restrições e premissas\n\n- Equipe de duas pessoas\n",
  });
  board("vazio", "id: vazio\nname: Vazio\n");
});

afterAll(() => {
  if (ANTERIOR === undefined) delete process.env.AGILEHARNESS_TARGET;
  else process.env.AGILEHARNESS_TARGET = ANTERIOR;
  rmSync(RAIZ, { recursive: true, force: true });
});

describe("loadDoc ANTES da migração — ninguém vê o formato antigo", () => {
  it("um prd.md formato 1 é LIDO como formato 2 (sem gravar), e o contexto sai dele", async () => {
    const { loadDoc } = await import("./schema-doc-io");
    const { sectionItems } = await import("./schema-codec");
    const antes = readFileSync(docs("livraria", "prd.md"), "utf8");

    const prd = await loadDoc("livraria", "prd");
    expect(prd?.doc.frontmatter.format).toBe(2);
    expect(prd?.violations).toEqual([]);
    expect(sectionItems(prd!.doc, "foraEscopo").map((i) => i.text)).toEqual(["Nunca: Recomendar por histórico de compra"]);
    const contexto = await loadDoc("livraria", "contexto");
    expect(sectionItems(contexto!.doc, "decisoes").map((i) => i.text)).toEqual(["Recomendação por gosto declarado"]);

    expect(readFileSync(docs("livraria", "prd.md"), "utf8"), "ler não pode gravar").toBe(antes);
    expect(existsSync(docs("livraria", "contexto.md"))).toBe(false);
  });

  it("o BMC sai do `canvas:` do board.yaml — e, quando há, do lean-canvas.md (que vence o yaml)", async () => {
    const { loadDoc } = await import("./schema-doc-io");
    const { sectionItems } = await import("./schema-codec");
    const doYaml = await loadDoc("livraria", "business-model-canvas");
    expect(sectionItems(doYaml!.doc, "customerSegments").map((i) => i.text)).toEqual(["**Leitor** — Leitor frequente"]);
    const doArquivo = await loadDoc("presentes", "business-model-canvas");
    expect(sectionItems(doArquivo!.doc, "customerSegments").map((i) => i.text)).toEqual(["Quem presenteia"]);
  });

  it("o docType antigo saiu do registro: `lean-canvas` não carrega (quem chama recusa)", async () => {
    const { loadDoc } = await import("./schema-doc-io");
    const { unknownDocMessage } = await import("./doc-registry");
    expect(await loadDoc("livraria", "lean-canvas")).toBeUndefined();
    expect(unknownDocMessage("lean-canvas")).toContain('"business-model-canvas"');
  });
});

describe("migrateBoardDocs — grava, guarda o original, e é idempotente", () => {
  const log: string[] = [];
  const NOW = new Date("2026-10-06T12:00:00Z");

  it("PRD formato 1 → formato 2 + contexto.md, com o original em docs/.archive/prd-v1.md; BMC do board.yaml", async () => {
    const { migrateBoardDocs } = await import("./migrate-board-docs");
    const yamlAntes = readFileSync(path.join(boardDir("livraria"), "board.yaml"), "utf8");

    const r = await migrateBoardDocs("livraria", { log: (l) => log.push(l), now: NOW });
    expect(r.migrated.sort()).toEqual([".archive/prd-v1.md", "business-model-canvas.md", "contexto.md", "prd.md"]);

    expect(readFileSync(docs("livraria", ".archive/prd-v1.md"), "utf8"), "o original, byte a byte").toBe(PRD_V1);
    const prd = readFileSync(docs("livraria", "prd.md"), "utf8");
    expect(prd).toContain("format: 2");
    expect(prd).toContain("## Proposta de valor");
    expect(prd).not.toContain("## Decisões já tomadas");
    expect(readFileSync(docs("livraria", "contexto.md"), "utf8")).toContain("- Recomendação por gosto declarado");
    expect(readFileSync(docs("livraria", "business-model-canvas.md"), "utf8")).toContain("# Business Model Canvas");
    expect(readFileSync(path.join(boardDir("livraria"), "board.yaml"), "utf8"), "o board.yaml NUNCA é tocado").toBe(yamlAntes);
    // uma linha de log por arquivo migrado
    expect(log.filter((l) => l.includes("livraria")).length).toBe(3);
  });

  it("rodar de novo não muda UM byte (nem duplica o arquivo do original)", async () => {
    const { migrateBoardDocs } = await import("./migrate-board-docs");
    const antes = snapshot("livraria");
    const r = await migrateBoardDocs("livraria", { log: () => {}, now: NOW });
    expect(r.migrated).toEqual([]);
    expect(snapshot("livraria")).toEqual(antes);
  });

  it("lean-canvas.md → BMC, e o arquivo antigo vai para docs/.archive/", async () => {
    const { migrateBoardDocs } = await import("./migrate-board-docs");
    await migrateBoardDocs("presentes", { log: () => {}, now: NOW });
    expect(existsSync(docs("presentes", "lean-canvas.md"))).toBe(false);
    expect(readFileSync(docs("presentes", ".archive/lean-canvas.md"), "utf8")).toBe(LEAN_MD);
    const bmc = readFileSync(docs("presentes", "business-model-canvas.md"), "utf8");
    expect(bmc).toContain("Presente certo, com devolução incluída");
    expect(bmc).toContain("### Problemas que resolve");
  });

  it("um contexto.md que já existia é ACRESCIDO (em «Outras notas»), nunca sobrescrito", async () => {
    const { migrateBoardDocs } = await import("./migrate-board-docs");
    await migrateBoardDocs("contexto-antigo", { log: () => {}, now: NOW });
    const ctx = readFileSync(docs("contexto-antigo", "contexto.md"), "utf8");
    expect(ctx).toContain("## Restrições e premissas\n\n- Equipe de duas pessoas");
    expect(ctx).toContain("### Do PRD antigo — Decisões já tomadas");
    expect(ctx).toContain("- Recomendação por gosto declarado");
  });

  it("a cópia do original NUNCA sobrescreve outra: um segundo arquivamento ganha a data no nome", async () => {
    const { archiveDocFile } = await import("./schema-doc-io");
    writeFileSync(docs("contexto-antigo", "prd.md"), PRD_V1.replace("Aurora", "Aurora (outra versão)"), "utf8");
    const alvo = await archiveDocFile("contexto-antigo", docs("contexto-antigo", "prd.md"), "prd-v1.md", NOW);
    expect(path.basename(alvo)).toBe("prd-v1-2026-10-06.md");
    expect(readFileSync(docs("contexto-antigo", ".archive/prd-v1.md"), "utf8")).toBe(PRD_V1);
  });

  it("arquivar de novo o MESMO conteúdo não abre outro nome — repetir a migração converge", async () => {
    const { archiveDocFile } = await import("./schema-doc-io");
    const alvo = docs("contexto-antigo", "prd.md");
    const a = await archiveDocFile("contexto-antigo", alvo, "prd-v1.md", NOW);
    const b = await archiveDocFile("contexto-antigo", alvo, "prd-v1.md", NOW);
    expect(b).toBe(a);
    expect(readdirSync(path.join(boardDir("contexto-antigo"), "docs", ".archive")).filter((f) => f.startsWith("prd-v1")).length).toBe(2);
  });

  it("um board sem nada para migrar não ganha arquivo nenhum; migrateAllBoardDocs nunca lança", async () => {
    const { migrateAllBoardDocs } = await import("./migrate-board-docs");
    const r = await migrateAllBoardDocs({ log: () => {} });
    expect(r.find((m) => m.board === "vazio")?.migrated).toEqual([]);
    expect(readdirSync(path.join(boardDir("vazio"), "docs"))).toEqual([]);
  });
});

describe("os leitores do PRD (board-strategy) — PRD + contexto, personas do PRD", () => {
  it("readPrdWithContext junta os dois documentos; board sem nenhum ⇒ null (não um bloco vazio no prompt)", async () => {
    const { readPrdWithContext } = await import("../board-strategy");
    const texto = await readPrdWithContext("livraria");
    expect(texto).toContain("# PRD");
    expect(texto).toContain("## Proposta de valor");
    expect(texto).toContain("# Contexto para os agentes");
    expect(texto).toContain("Recomendação por gosto declarado");
    expect(await readPrdWithContext("vazio")).toBeNull();
  });

  it("boardPersonas lê a seção «Personas» do PRD", async () => {
    const { boardPersonas } = await import("../board-strategy");
    const personas = await boardPersonas("livraria");
    expect(personas.map((p) => p.name)).toEqual(["Leitor frequente"]);
    expect(personas[0].prompt).toContain("Quer o próximo livro");
  });

  it("uma persona escrita SÓ no PRD pode ser escolhida no card e sobrevive à captura (parseProposal)", async () => {
    const { withBoardPersonas, boardWithPersonas } = await import("../board-strategy");
    const { readBoardConfig } = await import("../repo");
    const { parseProposal } = await import("../smart-capture/parse");
    const cru = await readBoardConfig("livraria");
    expect(cru.personas.map((p) => p.id), "o board.yaml não conhece a persona do PRD").not.toContain("leitor-frequente");

    const config = await withBoardPersonas("livraria", cru);
    expect(config.personas.map((p) => p.id)).toContain("leitor-frequente");
    // o que as páginas que abrem card recebem (o seletor e as fichas leem `config.personas`)
    const board = await boardWithPersonas({ config: cru, cards: [] });
    expect(board.config.personas.map((p) => p.name)).toContain("Leitor frequente");

    const raw = JSON.stringify({ items: [{ type: "story", title: "Ficha de gosto", personas: ["leitor-frequente", "inventada"] }] });
    expect(parseProposal(raw, config, []).items[0].personas).toEqual(["leitor-frequente"]);
    // e o objeto resolvido é só para LER: o board.yaml segue como estava
    expect((await readBoardConfig("livraria")).personas).toEqual(cru.personas);
  });
});
