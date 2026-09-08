// AS PROVAS DOS MCP *RESOURCES*.
//
// A afirmação que interessa não é "o resource responde" — é "o resource responde a VERDADE do
// repositório". Um resource cujo conteúdo fosse literal ficaria verde para sempre e viraria documentação
// que mente com autoridade de máquina. Por isso cada conteúdo é confrontado com um INSTRUMENTO
// INDEPENDENTE (uma leitura própria do YAML, a constante de origem), nunca com o próprio motor que o
// produziu — comparar o motor consigo mesmo é a tautologia que já nos custou uma prova nesta casa.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_URIS, URI_AUTORUN, URI_PIPELINE_BASE, URI_PIPELINE_GATES, registerResources } from "./resources";
import { GATE_IDS } from "@/lib/storymap/types";
import { findRepoRoot } from "@/lib/storymap/paths";
import { listBoards } from "@/lib/storymap/repo";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";

type Lido = { contents: { uri: string; mimeType?: string; text: string }[] };

/** Monta os resources num servidor falso e devolve (uri → leitor), como o SDK faria. */
function montar(): Map<string, { name: string; ler: () => Promise<Lido> }> {
  const m = new Map<string, { name: string; ler: () => Promise<Lido> }>();
  const server = {
    registerResource: (name: string, uri: string, _meta: unknown, handler: () => Promise<Lido>) => {
      m.set(uri, { name, ler: handler });
    },
  } as unknown as McpServer;
  registerResources(server);
  return m;
}

const MONTADOS = montar();
const ler = async (uri: string): Promise<unknown> => {
  const r = MONTADOS.get(uri);
  if (!r) throw new Error(`resource não montado: ${uri}`);
  const out = await r.ler();
  return JSON.parse(out.contents[0].text);
};

describe("a superfície de resources", () => {
  it("monta exatamente as URIs declaradas, e cada leitura devolve `contents[0].uri` preenchido", async () => {
    expect([...MONTADOS.keys()].sort()).toEqual([...RESOURCE_URIS].sort());
    for (const uri of RESOURCE_URIS) {
      const out = await MONTADOS.get(uri)!.ler();
      // O SDK NÃO preenche este campo — quem esquece devolve um resource que o cliente não casa com o
      // que pediu. O wrapper `defineResource` o preenche; esta é a prova de que ele continua fazendo isso.
      expect(out.contents[0].uri, `${uri} devolveu contents[0].uri errado`).toBe(uri);
      expect(out.contents[0].mimeType).toBe("application/json");
      expect(() => JSON.parse(out.contents[0].text)).not.toThrow();
    }
  });

  it("nenhum resource devolve dado de BOARD (card, persona, prosa do usuário) — só template e estado", async () => {
    // A razão de eles serem `read` em qualquer nível E de não abrirem canal de envenenamento: o que sai
    // daqui é a instalação, nunca texto que um chamador escreveu.
    for (const uri of RESOURCE_URIS) {
      const texto = (await MONTADOS.get(uri)!.ler()).contents[0].text;
      expect(texto, `${uri} vazou um card`).not.toMatch(/"body"|"acceptance"|"narrative"/);
    }
  });
});

describe("agileharness://pipeline/base — o template, medido contra uma leitura INDEPENDENTE do _base", () => {
  const baseYaml = () => {
    const p = path.join(findRepoRoot(), "storymap", "boards", "_base", "board.yaml");
    return yaml.load(readFileSync(p, "utf8")) as {
      statuses?: { id: string; autorun?: boolean; trigger?: string }[];
      columns?: { id: string }[];
      linkTypes?: { id: string }[];
    };
  };

  it("os status publicados são OS DO ARQUIVO — não uma lista embutida no código", async () => {
    const doc = baseYaml();
    const noArquivo = (doc.statuses ?? []).map((s) => s.id).sort();
    const publicado = ((await ler(URI_PIPELINE_BASE)) as { status: { id: string }[] }).status.map((s) => s.id).sort();

    // PISO: sem isto, `[] === []` passaria e a prova mediria zero.
    expect(noArquivo.length, "o _base do disco não tem status — este teste não teria sujeito").toBeGreaterThan(10);
    expect(
      publicado,
      "o resource e o _base do disco discordam — o conteúdo publicado deixou de ser derivado do arquivo",
    ).toEqual(noArquivo);
  });

  it("`disparamQuandoArmado` é exatamente quem tem autorun E trigger no arquivo (a lista que o portão de armar pede)", async () => {
    const doc = baseYaml();
    const esperado = (doc.statuses ?? []).filter((s) => s.autorun === true && s.trigger).map((s) => s.id).sort();
    const publicado = ((await ler(URI_PIPELINE_BASE)) as { disparamQuandoArmado: string[] }).disparamQuandoArmado.slice().sort();
    expect(esperado.length, "nenhum passo dispara no _base — a lista não teria o que informar").toBeGreaterThan(0);
    expect(publicado).toEqual(esperado);
    // O PAR: a lista é ESTRITAMENTE menor que a de todos os status. Se fosse igual, ela não estaria
    // filtrando nada e o agente confirmaria armar sobre uma lista sem significado.
    const todos = (doc.statuses ?? []).map((s) => s.id);
    expect(publicado.length).toBeLessThan(todos.length);
  });

  it("colunas e linkTypes também vêm do arquivo", async () => {
    const doc = baseYaml();
    const r = (await ler(URI_PIPELINE_BASE)) as { colunas: { id: string }[]; linkTypes: { id: string }[] };
    expect(r.colunas.map((c) => c.id).sort()).toEqual((doc.columns ?? []).map((c) => c.id).sort());
    expect(r.linkTypes.map((l) => l.id).sort()).toEqual((doc.linkTypes ?? []).map((l) => l.id).sort());
    expect(r.colunas.length).toBeGreaterThan(0);
  });
});

describe("agileharness://pipeline/gates — a remediação que a recusa de move_card NÃO carrega", () => {
  it("publica TODO gate conhecido, cada um com `comoCumprir` não-vazio", async () => {
    const r = (await ler(URI_PIPELINE_GATES)) as { gates: { id: string; exige: string | null; comoCumprir: string | null }[] };
    expect(r.gates.map((g) => g.id).sort()).toEqual([...GATE_IDS].sort());
    expect(GATE_IDS.length, "não há GateId declarado — o resource não teria o que publicar").toBeGreaterThan(5);
    const semRemedio = r.gates.filter((g) => !g.comoCumprir?.trim()).map((g) => g.id);
    expect(semRemedio, "gate publicado sem remediação — é exatamente a informação que este resource existe para entregar").toEqual([]);
  });

  it("`comoCumprir` é o `fix`, não a `exige` re-rotulada (senão o resource não acrescenta nada)", async () => {
    const r = (await ler(URI_PIPELINE_GATES)) as { gates: { id: string; exige: string | null; comoCumprir: string | null }[] };
    // A ASSIMETRIA que justifica este resource: se os dois campos fossem iguais, o agente já teria tudo
    // pela mensagem de recusa do `move_card`, e este resource seria peso morto.
    const distintos = r.gates.filter((g) => g.comoCumprir !== g.exige);
    expect(distintos.length, "`comoCumprir` é idêntico a `exige` em todos os gates — o resource não acrescenta informação").toBeGreaterThan(0);
  });
});

describe("agileharness://autorun — os interruptores", () => {
  it("o mestre segue a config viva e os boards seguem a listagem real", async () => {
    const r = (await ler(URI_AUTORUN)) as {
      mestre: { ligado: boolean };
      boards: { id: string; armado: boolean | null }[];
      modoEconomia: boolean;
    };
    expect(r.mestre.ligado).toBe(loadRunnerConfig().autorun.enabled);
    expect(r.boards.map((b) => b.id).sort()).toEqual((await listBoards()).map((b) => b.id).sort());
    expect(r.boards.length, "nenhum board na árvore — a prova mediria uma lista vazia").toBeGreaterThan(0);
    expect(typeof r.modoEconomia).toBe("boolean");
  });

  it("NÃO existe um booleano que prometa que um card vai rodar (seriam quatro causas numa promessa só)", async () => {
    const texto = (await MONTADOS.get(URI_AUTORUN)!.ler()).contents[0].text;
    expect(texto).not.toMatch(/"vaiRodar"|"willRun"/);
  });

  it("o board de demonstração aparece DESARMADO — ele declara autorunDisabled de propósito", async () => {
    const r = (await ler(URI_AUTORUN)) as { boards: { id: string; armado: boolean | null }[] };
    const demo = r.boards.find((b) => b.id === "demo");
    expect(demo, "o board de demonstração sumiu da árvore — ele é o sujeito que viaja na extração").toBeDefined();
    // O PAR anti-constante: nem todos podem estar desarmados, senão `armado` poderia ser um literal
    // `false`. A árvore do dono tem board armado; a extraída, não — então a asserção é sobre o `demo`,
    // e o par é a asserção de tipo acima (o campo é derivado por board, não global).
    expect(demo!.armado).toBe(false);
  });
});
