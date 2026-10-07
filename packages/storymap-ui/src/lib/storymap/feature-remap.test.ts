// 🔁 Renomear uma funcionalidade do PRD não solta os cards dela — e, na dúvida, não adivinha.
//
// O que não pode acontecer: (1) um card mudar de funcionalidade calado porque o id dele passou a ser de OUTRA (o
// deslocamento de uma família de títulos repetidos); (2) uma remarcação que falha derrubar a gravação do PRD.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrdFeature } from "./doc/prd-features";
import { featureRenames, remapFeatureIds, type FeatureRemapDeps } from "./feature-remap";
import type { Card } from "./types";

vi.mock("./runner/board-data-flush", () => ({ scheduleBoardDataFlush: vi.fn() }));

const f = (id: string, name: string, markdown: string): PrdFeature => ({ id, name, markdown });

describe("featureRenames — o casamento conservador", () => {
  it("id nos dois lados = mantida (nada a remarcar), mesmo com o texto editado", () => {
    expect(featureRenames([f("regar", "Regar", "a")], [f("regar", "Regar", "b")])).toEqual([]);
  });

  it("renomeada com o MESMO texto: remarca", () => {
    const before = [f("regar", "Regar", "Escala de rega da semana."), f("colher", "Colher", "Quem colhe o quê.")];
    const after = [f("regar-junto", "Regar junto", "Escala de rega da semana."), f("colher", "Colher", "Quem colhe o quê.")];
    expect(featureRenames(before, after)).toEqual([{ from: "regar", to: "regar-junto" }]);
  });

  it("título E texto editados juntos, nada mais mudou: sobrou uma de cada lado ⇒ remarca", () => {
    const before = [f("regar", "Regar", "velho"), f("colher", "Colher", "c")];
    const after = [f("regar-junto", "Regar junto", "novo"), f("colher", "Colher", "c")];
    expect(featureRenames(before, after)).toEqual([{ from: "regar", to: "regar-junto" }]);
  });

  it("apagar uma e criar outra com OUTRA mudança no documento NÃO é renome", () => {
    const before = [f("regar", "Regar", "velho"), f("colher", "Colher", "c")];
    const after = [f("compostar", "Compostar", "novo"), f("colher", "Colher", "c editado")];
    expect(featureRenames(before, after)).toEqual([]);
  });

  it("duas apagadas e duas novas com textos novos: ambíguo ⇒ nada", () => {
    const before = [f("a", "A", "1"), f("b", "B", "2")];
    const after = [f("c", "C", "3"), f("d", "D", "4")];
    expect(featureRenames(before, after)).toEqual([]);
  });

  it("família de títulos repetidos: apagar o PRIMEIRO desloca o id do segundo — os cards do segundo o seguem, os do apagado vão a «Outros»", () => {
    const before = [f("mural", "Mural", "avisos da horta"), f("mural-2", "Mural", "fotos da colheita")];
    const after = [f("mural", "Mural", "fotos da colheita")];
    expect(featureRenames(before, after)).toEqual([
      { from: "mural-2", to: "mural" },
      { from: "mural", to: null },
    ]);
  });

  it("família: dentro dela o id NÃO vale — sem texto que case, o id reusado é limpo", () => {
    const before = [f("mural", "Mural", "x"), f("mural-2", "Mural", "y")];
    const after = [f("mural", "Mural", "z")];
    expect(featureRenames(before, after)).toEqual([{ from: "mural", to: null }]);
  });

  it("texto vazio não prova nada", () => {
    const before = [f("a", "A", ""), f("b", "B", "")];
    const after = [f("c", "C", ""), f("d", "D", "")];
    expect(featureRenames(before, after)).toEqual([]);
  });
});

describe("remapFeatureIds — os cards", () => {
  const card = (id: string, feature?: string): Card => ({ id, type: "story", title: id, status: "desenvolver", feature }) as Card;

  function deps(cards: Card[], failOn?: string): FeatureRemapDeps & { lines: string[]; disk: Map<string, Card> } {
    const disk = new Map(cards.map((c) => [c.id, c] as const));
    const lines: string[] = [];
    return {
      disk,
      lines,
      readCards: async () => [...disk.values()],
      updateCard: async (_b, id, mutate) => {
        if (id === failOn) throw new Error("disco cheio");
        const next = mutate(disk.get(id)!);
        if (next) disk.set(id, next);
        return next;
      },
      log: (l) => lines.push(l),
    };
  }

  it("reescreve só os cards da renomeada, com uma linha de registro por card", async () => {
    const d = deps([card("story-ex9101", "regar"), card("story-ex9102", "colher"), card("story-ex9103")]);
    const r = await remapFeatureIds("horta", [f("regar", "Regar", "t"), f("colher", "Colher", "c")], [f("regar-junto", "Regar junto", "t"), f("colher", "Colher", "c")], d);
    expect(r).toEqual({ rewritten: ["story-ex9101"], failed: [] });
    expect(d.disk.get("story-ex9101")!.feature).toBe("regar-junto");
    expect(d.disk.get("story-ex9102")!.feature).toBe("colher");
    expect(d.lines).toEqual(["[feature-remap] horta/story-ex9101: funcionalidade renomeada: regar → regar-junto"]);
  });

  it("falha no meio: os outros seguem, o que falhou fica com o id velho e deixa a linha", async () => {
    const d = deps([card("story-ex9111", "regar"), card("story-ex9112", "regar")], "story-ex9111");
    const r = await remapFeatureIds("horta", [f("regar", "Regar", "t")], [f("regar-junto", "Regar junto", "t")], d);
    expect(r).toEqual({ rewritten: ["story-ex9112"], failed: ["story-ex9111"] });
    expect(d.disk.get("story-ex9111")!.feature).toBe("regar");
    expect(d.lines.some((l) => l.includes("story-ex9111") && l.includes("falhou"))).toBe(true);
  });

  it("nada renomeado ⇒ nem lê os cards", async () => {
    const readCards = vi.fn(async () => [] as Card[]);
    await remapFeatureIds("horta", [f("a", "A", "1")], [f("a", "A", "2")], { readCards, updateCard: vi.fn(), log: vi.fn() });
    expect(readCards).not.toHaveBeenCalled();
  });
});

describe("writeSchemaDoc remarca os cards (disco de verdade)", () => {
  const RAIZ = mkdtempSync(path.join(tmpdir(), "feature-remap-"));
  const BOARD = "horta";
  const ANTERIOR = process.env.AGILEHARNESS_TARGET;

  beforeAll(() => {
    mkdirSync(path.join(RAIZ, "storymap", "boards", BOARD, "cards"), { recursive: true });
    writeFileSync(path.join(RAIZ, "storymap", "boards", BOARD, "board.yaml"), `id: ${BOARD}\nname: Horta\n`, "utf8");
    process.env.AGILEHARNESS_TARGET = RAIZ;
  });
  afterAll(() => {
    if (ANTERIOR === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = ANTERIOR;
    rmSync(RAIZ, { recursive: true, force: true });
  });

  // um PRD completo (o schema recusa gravar sem as seções obrigatórias) — só «Funcionalidades» varia.
  const prdMd = (features: [string, string][]) =>
    [
      "# PRD", "", "## Problema", "", "A rega fica esquecida.", "", "## Personas", "", "### Quem cultiva", "", "- tem um canteiro", "",
      "## Proposta de valor", "", "Ninguém rega sozinho.", "", "## Funcionalidades", "", ...features.flatMap(([n, t]) => [`### ${n}`, "", t, ""]),
      "## Fluxo de uso", "", "- entra, vê a escala, rega", "", "## Métricas de sucesso", "", "- canteiros vivos no fim do mês", "",
      "## Fora do escopo", "", "- venda de mudas", "",
    ].join("\n");

  it("o PRD renomeado remarca o card; `feature` e `batch` fazem o round-trip pelo disco", async () => {
    const { writeSchemaDoc } = await import("./doc/schema-doc-io");
    const { parseSchemaBody } = await import("./doc/schema-codec");
    const { PRD_SCHEMA } = await import("./doc/schemas/prd");
    const { writeCard } = await import("./write");
    const { readCard } = await import("./repo");
    const doc = (md: string) => parseSchemaBody(md, PRD_SCHEMA, {}).doc;

    // a hierarquia mínima (todo card vive no mapa): atividade → passo → as histórias.
    const cards = path.join(RAIZ, "storymap", "boards", BOARD, "cards");
    writeFileSync(path.join(cards, "act-ex1.md"), "---\nid: act-ex1\ntype: activity\ntitle: Cuidar da horta\nstatus: null\nparent: null\n---\n\nDado sintético.\n");
    writeFileSync(path.join(cards, "step-ex1.md"), "---\nid: step-ex1\ntype: step\ntitle: Regar\nstatus: null\nparent: act-ex1\n---\n\nDado sintético.\n");
    const first = await writeSchemaDoc(BOARD, PRD_SCHEMA, doc(prdMd([["Regar", "Escala de rega da semana."], ["Colher", "Quem colhe o quê."]])));
    expect(first.ok, first.error).toBe(true);
    const batch = { id: "lote-ex1", lead: "story-ex9121", sessionId: "sess-ex1", at: "2026-01-02T03:04:05.000Z", planHash: "h1" };
    await writeCard(BOARD, { id: "story-ex9121", type: "story", title: "Lembrete de rega", storyType: "user", status: "triage", parent: "step-ex1", feature: "regar", batch } as Card);
    await writeCard(BOARD, { id: "story-ex9122", type: "story", title: "Sem funcionalidade", storyType: "user", status: "triage", parent: "step-ex1", feature: "  " } as Card);
    expect((await readCard(BOARD, "story-ex9121"))?.batch).toEqual(batch);
    expect((await readCard(BOARD, "story-ex9122"))?.feature).toBeUndefined();

    const second = await writeSchemaDoc(BOARD, PRD_SCHEMA, doc(prdMd([["Regar junto", "Escala de rega da semana."], ["Colher", "Quem colhe o quê."]])));
    expect(second.ok).toBe(true);
    const moved = await readCard(BOARD, "story-ex9121");
    expect(moved?.feature).toBe("regar-junto");
    expect(moved?.batch, "a marca de lote sobrevive à reescrita").toEqual(batch);
  });

  it("a remarcação que falha NÃO derruba a gravação do PRD", async () => {
    const { writeSchemaDoc } = await import("./doc/schema-doc-io");
    const { parseSchemaBody } = await import("./doc/schema-codec");
    const { PRD_SCHEMA } = await import("./doc/schemas/prd");
    const doc = (md: string) => parseSchemaBody(md, PRD_SCHEMA, {}).doc;
    const broken: FeatureRemapDeps = {
      readCards: async () => {
        throw new Error("cards ilegíveis");
      },
      updateCard: vi.fn(),
      log: vi.fn(),
    };
    const r = await writeSchemaDoc(BOARD, PRD_SCHEMA, doc(prdMd([["Regar em dupla", "Escala de rega da semana."], ["Colher", "Quem colhe o quê."]])), {
      featureRemapDeps: broken,
    });
    expect(r.ok, r.error).toBe(true);
  });
});
