import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

// ATAQUES contra o parsing de dado de board (story-c5uhes + story-t9k1jf). Todo teste aqui descreve o
// ATAQUE, não a implementação: um card é conteúdo de FORA (um PR de contribuidor, um branch de agente,
// um `git pull` que o board relê por mtime) e o processo que o lê roda como root.
//
// A defesa vive num chokepoint único (frontmatter.ts). O teste mais importante do arquivo não é
// nenhum dos ataques: é o LINT no fim, que reprova qualquer call-site novo que volte a chamar
// `matter(raw)` cru — sem ele, o buraco reabre no próximo módulo que precisar ler um card.
//
// Nota sobre o mock de `./paths`: espalha o módulo REAL e relocaliza só a raiz para um tmp (mesmo
// padrão de sidecars-write.test.ts) — jamais um dir de board vivo. O que está sob teste (a recusa)
// segue sendo o código real.
const TMP_ROOT = path.join(os.tmpdir(), "ah-frontmatter-attack-test");
vi.mock("./paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("./paths")>();
  const boardDir = (boardId: string) => path.join(TMP_ROOT, "boards", real.sanitizeId(boardId));
  return {
    ...real,
    boardsDir: () => path.join(TMP_ROOT, "boards"),
    boardDir,
    cardsDir: (b: string) => path.join(boardDir(b), "cards"),
    cardPath: (b: string, c: string) => path.join(boardDir(b), "cards", `${real.sanitizeId(c)}.md`),
    boardConfigPath: (b: string) => path.join(boardDir(b), "board.yaml"),
    baseBoardConfigPath: () => path.join(TMP_ROOT, "boards", "_base", "board.yaml"),
  };
});

import {
  FRONTMATTER_MAX_BYTES_DEFAULT,
  FRONTMATTER_MAX_DEPTH_DEFAULT,
  FrontmatterError,
  SAFE_MATTER_OPTIONS,
  assertNoLanguageToken,
  frontmatterLimits,
  parseFrontmatter,
  parseYamlMap,
} from "./frontmatter";
import { deriveBoardConfigForPersist, readBoardConfig, readCard, readCards } from "./repo";
import { isEmptyStyleGuideDoc, parseStyleGuideMd } from "./style-guide";
import { readRawKeys } from "./config-cockpit";
import type { BoardConfig } from "./types";

/** O sentinela: o payload de ataque escreve AQUI se o `eval` do gray-matter rodar. Um objeto (não uma
 *  variável solta) porque o payload precisa de uma expressão única para mutar dentro do frontmatter. */
const sentinel = { executou: false };
(globalThis as Record<string, unknown>).__AH_FRONTMATTER_SENTINEL__ = sentinel;

/** Um card de planejamento aparentemente inocente: o `title` sai certo, e de carona o código roda. */
function evalPayload(lang: string): string {
  return [
    `---${lang}`,
    "{ title: (globalThis.__AH_FRONTMATTER_SENTINEL__.executou = true, 'card inocente') }",
    "---",
    "Corpo do card.",
    "",
  ].join("\n");
}

/** Alias bomb (billion laughs): 443 bytes cuja expansão tem ~10^9 nós. O js-yaml parseia em ~4ms
 *  porque compartilha referências — quem morre é a PRIMEIRA travessia a jusante (JSON.stringify,
 *  safeParse do Zod, o coerce, o SSE). Teto de bytes não pega; orçamento de nós pega.
 *  Só o YAML, sem delimitador: serve para plantar a bomba em QUALQUER documento de board
 *  (frontmatter de card, board.yaml, o frontmatter do design/style-guide.md). */
function aliasBombYaml(): string {
  const lines = ["l0: &l0 [x,x,x,x,x,x,x,x,x,x]"];
  for (let i = 1; i <= 8; i++) {
    lines.push(`l${i}: &l${i} [${Array(10).fill(`*l${i - 1}`).join(",")}]`);
  }
  return lines.join("\n");
}

/** A bomba embalada como card (frontmatter + corpo). */
function aliasBomb(): string {
  return `---\n${aliasBombYaml()}\n---\ncorpo\n`;
}

function expectRejection(run: () => unknown, reason: string) {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught, "o parse tinha de RECUSAR, e não devolver dado").toBeInstanceOf(FrontmatterError);
  expect((caught as FrontmatterError).reason).toBe(reason);
  return caught as FrontmatterError;
}

beforeEach(() => {
  sentinel.executou = false;
  delete process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES;
  delete process.env.AGILEHARNESS_FRONTMATTER_MAX_DEPTH;
  delete process.env.AGILEHARNESS_FRONTMATTER_MAX_NODES;
});

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ATAQUE: um card executa código no servidor ao ser LIDO (gray-matter engine `javascript`)", () => {
  it("o `eval` do gray-matter é REAL — sem o chokepoint, ler o card roda o código do card", () => {
    // Este teste NÃO exercita a defesa: ele PROVA o vetor contra a biblioteca crua, para que a
    // recusa dos testes seguintes não seja fé. Se um bump de dependência matar o engine `javascript`,
    // este teste cai e o motivo aparece — melhor que uma defesa que ninguém sabe mais contra o quê é.
    matter(evalPayload("js"));
    expect(sentinel.executou, "o engine javascript do gray-matter deixou de executar?").toBe(true);
  });

  it("A ARMADILHA: `{language:'yaml'}` NÃO protege — o token do delimitador sobrescreve a opção", () => {
    // gray-matter/index.js:85-90 troca a language pelo token depois do `---`. Um fix que só passasse
    // `language:'yaml'` PARECERIA correto e continuaria executando o card.
    matter(evalPayload("js"), { language: "yaml" });
    expect(sentinel.executou, "language:'yaml' passou a proteger? então o fix pode ser simplificado").toBe(true);
  });

  it("um card com `---js` é RECUSADO e NADA é executado", () => {
    expectRejection(() => parseFrontmatter(evalPayload("js"), "board/story-x.md"), "engine-forbidden");
    expect(sentinel.executou, "o código do card rodou no processo do servidor").toBe(false);
  });

  it("`---javascript` (o mesmo alias do engine) também é recusado", () => {
    expectRejection(() => parseFrontmatter(evalPayload("javascript"), "board/story-x.md"), "engine-forbidden");
    expect(sentinel.executou).toBe(false);
  });

  it("variações de caixa e espaço no token não escapam (`---JS`, `---  js  `)", () => {
    for (const lang of ["JS", "Js", "  js  ", "\tjavascript"]) {
      expectRejection(() => parseFrontmatter(evalPayload(lang), "board/story-x.md"), "engine-forbidden");
      expect(sentinel.executou, `token ${JSON.stringify(lang)} escapou`).toBe(false);
    }
  });

  it("qualquer OUTRA linguagem depois do delimitador é recusada com motivo nomeado (`toml`, `cson`, `json`)", () => {
    // Modelo positivo: só `---` puro (YAML) entra. Não é uma lista negra de engines conhecidos — um
    // engine que o gray-matter registrar no futuro não vira um vetor novo.
    for (const lang of ["toml", "cson", "coffee", "json", "yaml"]) {
      expectRejection(() => parseFrontmatter(`---${lang}\na: 1\n---\nb\n`, "board/story-x.md"), "engine-forbidden");
    }
  });

  it("um .md que começa com régua `----` NÃO é confundido com token de linguagem", () => {
    // gray-matter (index.js:77) já não trata `----` como delimitador; a defesa não pode ser mais
    // agressiva que ele e recusar um markdown legítimo.
    const parsed = parseFrontmatter("----\ntexto\n", "board/story-x.md");
    expect(parsed.data).toEqual({});
  });

  it("os engines venenosos são o SEGUNDO cinto: mesmo chamando o gray-matter com as options do chokepoint, `---js` lança", () => {
    // Prova que a proteção não depende SÓ da checagem da 1ª linha (se um delimitador exótico algum dia
    // furar aquela porta, o engine injetado ainda desarma o eval — defaults.js:16 faz o engine do
    // chamador vencer o embutido).
    const boom = () => {
      throw new Error("engine proibido");
    };
    expect(() => matter(evalPayload("js"), { language: "yaml", engines: { javascript: boom, js: boom } })).toThrow(
      "engine proibido",
    );
    expect(sentinel.executou).toBe(false);
  });
});

describe("ATAQUE: um BOM antes do delimitador esconde o token de linguagem da 1ª porta", () => {
  // O BOM não é decoração: é o caractere que fazia as DUAS pontas do chokepoint olharem strings
  // DIFERENTES. O gray-matter remove o U+FEFF (lib/to-file.js → strip-bom-string) ANTES de procurar
  // o delimitador; a 1ª porta olhava o texto original, via um 1º caractere que não é `-`, concluía
  // "não abre frontmatter" e liberava o payload.
  // Por CODEPOINT, nunca pelo caractere literal: um invisível literal no fixture é invisível também
  // para quem revisa o diff, e um copy-paste que o remova mataria o ataque sem o teste acusar.
  const ch = (cp: number) => String.fromCodePoint(cp);
  const BOM = ch(0xfeff);

  it("o gray-matter REMOVE o BOM e ainda escolhe o engine `javascript` — o vetor é real", () => {
    // Prova contra a lib crua, como o resto do arquivo: se um bump de dependência parar de remover o
    // BOM, este teste cai e a normalização da 1ª porta passa a ser explicavelmente desnecessária.
    matter(BOM + evalPayload("js"), { language: "yaml" });
    expect(sentinel.executou, "o BOM deixou de furar o gray-matter?").toBe(true);
  });

  it("a 1ª porta RECUSA o payload com BOM (é ela quem tem de ver o ataque, não só a 2ª camada)", () => {
    // Exercita a camada SOZINHA de propósito: end-to-end o payload já era barrado pelos engines
    // venenosos, então um teste só de parseFrontmatter ficaria VERDE com esta porta furada — e a
    // defesa em profundidade viraria defesa única sem ninguém notar.
    expectRejection(() => assertNoLanguageToken(BOM + evalPayload("js"), "board/story-x.md"), "engine-forbidden");
  });

  it("outros invisíveis de largura zero também não escondem o token", () => {
    for (const prefix of [BOM + BOM, ch(0x200b), ch(0x200e), ch(0x2060)]) {
      expectRejection(() => assertNoLanguageToken(prefix + evalPayload("javascript"), "c"), "engine-forbidden");
    }
  });

  it("a 2ª camada SOZINHA ainda bloqueia o BOM — a redundância é INTENCIONAL, não acidental", () => {
    // Se um refactor futuro tratar a 1ª porta como suficiente e a remover, o engine venenoso ainda
    // desarma o eval. Usa as options REAIS do chokepoint (não uma cópia local), senão o teste provaria
    // uma propriedade do gray-matter em vez da nossa defesa.
    expectRejection(() => matter(BOM + evalPayload("js"), SAFE_MATTER_OPTIONS), "engine-forbidden");
    expect(sentinel.executou).toBe(false);
  });

  it("parseFrontmatter recusa o card com BOM + `---js` e nada é executado", () => {
    expectRejection(() => parseFrontmatter(BOM + evalPayload("js"), "board/story-x.md"), "engine-forbidden");
    expect(sentinel.executou).toBe(false);
  });

  it("um card LEGÍTIMO salvo com BOM (editor Windows) continua sendo lido — nada de capacidade perdida", () => {
    const { data, content } = parseFrontmatter(`${BOM}---\nid: story-x\ntitle: ok\n---\ncorpo\n`, "c");
    expect(data).toEqual({ id: "story-x", title: "ok" });
    expect(content).toBe("corpo\n");
  });
});

describe("ATAQUE: DoS por parse (volume e alias bomb)", () => {
  it("um card gigante é recusado ANTES de chegar ao parser (teto default de bytes)", () => {
    const huge = `---\ntitle: x\npad: "${"a".repeat(FRONTMATTER_MAX_BYTES_DEFAULT)}"\n---\nb\n`;
    const err = expectRejection(() => parseFrontmatter(huge, "board/story-gorda.md"), "too-large");
    expect(err.message).toContain("acima do teto");
  });

  it("o teto de bytes é um knob de operador — apertá-lo recusa um card que passaria", () => {
    const card = `---\ntitle: x\npad: "${"a".repeat(4096)}"\n---\nb\n`;
    expect(() => parseFrontmatter(card, "board/story-x.md")).not.toThrow();
    process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES = "1024";
    expect(frontmatterLimits().maxBytes).toBe(1024);
    expectRejection(() => parseFrontmatter(card, "board/story-x.md"), "too-large");
  });

  it("uma alias bomb de <1KB é recusada em milissegundos, não expandida em 10^9 nós", () => {
    const bomb = aliasBomb();
    expect(Buffer.byteLength(bomb), "o payload é minúsculo — o teto de bytes jamais o pegaria").toBeLessThan(1024);
    const t0 = Date.now();
    expectRejection(() => parseFrontmatter(bomb, "board/story-bomba.md"), "too-many-nodes");
    expect(Date.now() - t0, "a recusa tem de ser barata, senão ela É o DoS").toBeLessThan(1000);
  });

  it("frontmatter aninhado além do teto de profundidade é recusado", () => {
    let yamlDoc = "folha: 1";
    for (let i = 0; i < FRONTMATTER_MAX_DEPTH_DEFAULT + 4; i++) yamlDoc = `n${i}:\n  ${yamlDoc.split("\n").join("\n  ")}`;
    expectRejection(() => parseFrontmatter(`---\n${yamlDoc}\n---\nb\n`, "board/story-funda.md"), "too-deep");
  });

  it("board.yaml também está sob os tetos — uma alias bomb no config do board é recusada", () => {
    const bomb = aliasBomb().replace(/^---\n/, "").replace(/\n---\ncorpo\n$/, "\n");
    expectRejection(() => parseYamlMap(bomb, "x/board.yaml"), "too-many-nodes");
  });

  it("um card real (55KB, 375 nós, profundidade 6) passa folgado — o controle não tira capacidade", () => {
    const limits = frontmatterLimits();
    expect(limits.maxBytes).toBeGreaterThan(55_288 * 10);
    expect(limits.maxNodes).toBeGreaterThan(375 * 10);
    expect(limits.maxDepth).toBeGreaterThan(6 * 2);
  });
});

describe("ATAQUE: os OUTROS arquivos de board — o invariante do chokepoint valia só para os cards", () => {
  // `storymap/boards/**` não é só `cards/*.md`: o `design/style-guide.md` e cada `board.yaml` (mais o
  // `_base`) atravessam a MESMA fronteira (PR de contribuidor → `git pull` → releitura por mtime) e
  // eram parseados por `yaml.load` cru — sem teto de bytes/nós/profundidade e sem guard de `__proto__`.
  // O lint da suíte não pegava porque só conhecia `gray-matter`.

  describe("design/style-guide.md (o guia de estilo do board)", () => {
    /** Guia com conteúdo LEGÍTIMO (`identity.school`) + a carga hostil no MESMO frontmatter. É o que
     *  torna o teste observável: se o documento foi parseado, o conteúdo legítimo aparece no doc; se foi
     *  recusado, o guia inteiro degrada para vazio. */
    const guideWith = (hostile: string) =>
      `# guia compilado\n\n---\n${hostile}identity:\n  school: brutalismo\n---\n\n## Cor [color]\n\n_(vazio)_\n`;

    it("um guia sadio é lido (a linha de base do teste)", () => {
      const doc = parseStyleGuideMd(guideWith(""));
      expect(doc.identity.school).toBe("brutalismo");
    });

    it("uma alias bomb no frontmatter do guia é RECUSADA — o grafo hostil não vira dado do board", () => {
      const doc = parseStyleGuideMd(guideWith(`${aliasBombYaml()}\n`));
      expect(isEmptyStyleGuideDoc(doc), "o documento hostil foi parseado e entregou conteúdo").toBe(true);
    });

    it("um frontmatter de guia acima do teto de bytes é recusado", () => {
      const doc = parseStyleGuideMd(guideWith(`pad: "${"a".repeat(FRONTMATTER_MAX_BYTES_DEFAULT)}"\n`));
      expect(isEmptyStyleGuideDoc(doc)).toBe(true);
    });

    it("`__proto__` no frontmatter do guia é recusado (não removido em silêncio)", () => {
      const doc = parseStyleGuideMd(guideWith('"__proto__":\n  polluted: true\n'));
      expect(isEmptyStyleGuideDoc(doc)).toBe(true);
    });

    it("o(s) style-guide.md REAIS do repo seguem sendo lidos — o teto não tira capacidade", () => {
      const boardsRoot = path.resolve(__dirname, "../../../../../storymap/boards");
      const guides = readdirSync(boardsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(boardsRoot, e.name, "design", "style-guide.md"))
        .filter((p) => {
          try {
            readFileSync(p);
            return true;
          } catch {
            return false;
          }
        });
      expect(guides.length, "nenhum guia real encontrado — o teste estaria provando nada").toBeGreaterThan(0);
      for (const g of guides) {
        expect(isEmptyStyleGuideDoc(parseStyleGuideMd(readFileSync(g, "utf8"))), g).toBe(false);
      }
    });
  });

  describe("board.yaml relido pelo cockpit de config (origem de rota/especialista)", () => {
    const writeYaml = async (name: string, raw: string) => {
      const file = path.join(TMP_ROOT, "boards", name, "board.yaml");
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, raw, "utf8");
      return file;
    };
    const withRouteProfile = (hostile: string) =>
      `${hostile}routeProfiles:\n  express:\n    description: pula passos\n`;

    it("um board.yaml sadio entrega as chaves ao cockpit (a linha de base do teste)", async () => {
      const file = await writeYaml("acme", withRouteProfile(""));
      expect([...(await readRawKeys(file, "routeProfiles"))]).toEqual(["express"]);
    });

    it("um board.yaml com alias bomb NÃO é parseado pelo cockpit", async () => {
      const file = await writeYaml("acme", withRouteProfile(`${aliasBombYaml()}\n`));
      expect([...(await readRawKeys(file, "routeProfiles"))], "o cockpit parseou o grafo hostil").toEqual([]);
    });

    it("um board.yaml acima do teto de bytes NÃO é parseado pelo cockpit", async () => {
      const file = await writeYaml("acme", withRouteProfile(`pad: "${"a".repeat(FRONTMATTER_MAX_BYTES_DEFAULT)}"\n`));
      expect([...(await readRawKeys(file, "routeProfiles"))]).toEqual([]);
    });
  });
});

describe("ATAQUE: sequestro de protótipo por chave de frontmatter", () => {
  it("`__proto__` no frontmatter sequestraria um `Object.assign` a jusante — por isso é recusado", () => {
    const raw = '---\n"__proto__":\n  polluted: true\n---\nb\n';
    // O ataque, provado contra o parser cru: a chave vem como PRÓPRIA e enumerável, e o
    // `Object.assign` a copia via [[Set]] → o setter de Object.prototype.__proto__ troca o protótipo.
    const cru = matter(raw, { language: "yaml" }).data as Record<string, unknown>;
    expect(Object.keys(cru)).toContain("__proto__");
    expect((Object.assign({}, cru) as { polluted?: boolean }).polluted).toBe(true);
    // A defesa: o objeto nunca chega ao código (recusa, não remoção silenciosa).
    expectRejection(() => parseFrontmatter(raw, "board/story-x.md"), "forbidden-key");
  });

  it("`constructor`/`prototype`, em qualquer nível do frontmatter, são recusados", () => {
    expectRejection(() => parseFrontmatter("---\nconstructor: x\n---\nb\n", "c"), "forbidden-key");
    expectRejection(() => parseFrontmatter("---\ntasks:\n  - prototype: x\n---\nb\n", "c"), "forbidden-key");
  });
});

describe("ATAQUE: falha de parse silenciosa (o `{}` que virava config vazia)", () => {
  it("YAML malformado é RECUSA NOMEADA, nunca um mapa vazio", () => {
    const err = expectRejection(() => parseFrontmatter("---\na: [1, 2\nb: :\n---\nb\n", "board/x.md"), "invalid-yaml");
    expect(err.label).toBe("board/x.md");
  });

  it("frontmatter escalar ou lista não passa como se fosse card", () => {
    expectRejection(() => parseFrontmatter("---\nsó um texto\n---\nb\n", "c"), "not-a-map");
    expectRejection(() => parseFrontmatter("---\n- a\n- b\n---\nb\n", "c"), "not-a-map");
  });

  it("um board.yaml que não é mapa é recusado em vez de resolver como pipeline VAZIA", () => {
    expectRejection(() => parseYamlMap("- statuses\n- columns\n", "x/board.yaml"), "not-a-map");
  });

  it("board.yaml vazio (ou só comentários) segue sendo mapa vazio legítimo", () => {
    expect(parseYamlMap("", "x/board.yaml")).toEqual({});
    expect(parseYamlMap("# nada aqui\n", "x/board.yaml")).toEqual({});
  });
});

describe("o loader YAML não instancia código (trava contra bump de dependência)", () => {
  it("tags que constroem objetos JS são recusadas nos DOIS loaders (frontmatter e board.yaml)", () => {
    for (const tag of ["!!js/function 'function(){return 1}'", "!!js/eval 'x'", "!!js/regexp /x/"]) {
      expectRejection(() => parseFrontmatter(`---\na: ${tag}\n---\nb\n`, "c"), "invalid-yaml");
      expectRejection(() => parseYamlMap(`a: ${tag}\n`, "x/board.yaml"), "invalid-yaml");
    }
  });
});

describe("nenhuma capacidade perdida: YAML legítimo segue passando igual", () => {
  it("frontmatter normal devolve os mesmos dados e o corpo verbatim", () => {
    const raw = "---\nid: story-x\ntitle: Um card\ntasks:\n  - id: t1\n    done: false\n---\n\nCorpo **markdown**.\n";
    const { data, content } = parseFrontmatter(raw, "board/story-x.md");
    expect(data).toEqual({ id: "story-x", title: "Um card", tasks: [{ id: "t1", done: false }] });
    expect(content).toBe("\nCorpo **markdown**.\n");
  });

  it("o dialeto do frontmatter NÃO mudou: ISO sem quotes continua virando Date (o repo depende disso)", () => {
    const { data } = parseFrontmatter("---\ncreated: 2026-07-29T12:00:00Z\n---\nb\n", "c");
    expect(data.created).toBeInstanceOf(Date);
  });

  it("todo card e board.yaml REAIS do repo passam pelo chokepoint", () => {
    // A prova de que nenhum teto/recusa é apertado demais para o dado que existe hoje.
    const boardsRoot = path.resolve(__dirname, "../../../../../storymap/boards");
    const boards = readdirSync(boardsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    let cards = 0;
    for (const b of boards) {
      const cardsDir = path.join(boardsRoot, b.name, "cards");
      let entries: string[] = [];
      try {
        entries = readdirSync(cardsDir).filter((f) => f.endsWith(".md"));
      } catch {
        entries = [];
      }
      for (const f of entries) {
        const raw = readFileSync(path.join(cardsDir, f), "utf8");
        expect(() => parseFrontmatter(raw, `${b.name}/${f}`), `${b.name}/${f}`).not.toThrow();
        cards++;
      }
      const cfg = path.join(boardsRoot, b.name, "board.yaml");
      try {
        const raw = readFileSync(cfg, "utf8");
        expect(() => parseYamlMap(raw, `${b.name}/board.yaml`), `${b.name}/board.yaml`).not.toThrow();
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
    }
    expect(cards, "não encontrou os cards reais — o teste estaria provando nada").toBeGreaterThan(100);
  });
});

describe("o cache global do gray-matter não retém mais o conteúdo dos cards", () => {
  // `matter.cache`/`clearCache` EXISTEM em runtime (index.js:224-227) mas não estão no
  // gray-matter.d.ts — parte de por que o vazamento era invisível: o tipo não conta que a lib guarda
  // uma cópia de tudo que você já parseou.
  const cached = matter as unknown as { cache: Record<string, unknown>; clearCache: () => void };

  it("o chokepoint não alimenta `matter.cache` (que é keyed pelo arquivo inteiro e nunca é podado)", () => {
    cached.clearCache();
    // O comportamento ANTIGO: `matter(raw)` sem options guarda o arquivo inteiro num objeto global,
    // para sempre — num serviço de longa duração, uma cópia de cada versão de cada card já lido.
    matter("---\na: 1\n---\ncorpo antigo\n");
    expect(Object.keys(cached.cache).length).toBe(1);

    cached.clearCache();
    parseFrontmatter("---\na: 1\n---\ncorpo novo\n", "c");
    expect(Object.keys(cached.cache).length, "o parse voltou a cachear conteúdo de card").toBe(0);
  });
});

describe("o caminho REAL de leitura de card (repo.ts) recusa o payload", () => {
  const writeCard = async (board: string, id: string, raw: string) => {
    const dir = path.join(TMP_ROOT, "boards", board, "cards");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.md`), raw, "utf8");
  };
  const okCard = (id: string) => `---\nid: ${id}\ntype: story\ntitle: Card ok\nstatus: triage\n---\n\ncorpo\n`;

  it("readCards descarta o card hostil, mantém os sadios e NÃO executa nada", async () => {
    await writeCard("acme", "story-ok", okCard("story-ok"));
    await writeCard("acme", "story-mau", evalPayload("js"));

    const cards = await readCards("acme");

    expect(sentinel.executou, "ler o board executou o código do card").toBe(false);
    expect(cards.map((c) => c.id)).toEqual(["story-ok"]);
  });

  it("readCard do card hostil devolve null sem executar", async () => {
    await writeCard("acme", "story-mau", evalPayload("javascript"));
    expect(await readCard("acme", "story-mau")).toBeNull();
    expect(sentinel.executou).toBe(false);
  });

  it("readCards também descarta uma alias bomb (o card que derrubaria o processo ao serializar)", async () => {
    await writeCard("acme", "story-ok", okCard("story-ok"));
    await writeCard("acme", "story-bomba", aliasBomb());
    const cards = await readCards("acme");
    expect(cards.map((c) => c.id)).toEqual(["story-ok"]);
  });

  it("o card acima do teto NÃO chega a ser lido para a memória — o DoS de volume morre no `stat`", async () => {
    // O teto de bytes do chokepoint recebe uma string que o chamador JÁ materializou: ele protege o
    // PARSER, não o READ. Sem o `stat` antes do `readFile`, o card de 500MB era carregado inteiro e só
    // então recusado — o volume acontecia ANTES da recusa, que é exatamente o DoS que o teto promete
    // fechar. Aqui o teto é apertado por env (o mesmo knob do operador) para o fixture caber no teste.
    process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES = "2048";
    await writeCard("acme", "story-ok", okCard("story-ok"));
    await writeCard("acme", "story-gorda", `---\nid: story-gorda\ntype: story\nstatus: triage\n---\n${"a".repeat(64 * 1024)}\n`);

    const spy = vi.spyOn(fs, "readFile");
    const cards = await readCards("acme");
    const lidos = spy.mock.calls.map((c) => String(c[0]));

    expect(cards.map((c) => c.id)).toEqual(["story-ok"]);
    expect(lidos.some((p) => p.includes("story-gorda")), "o card gigante foi lido inteiro antes de ser recusado").toBe(
      false,
    );
    // Contraprova: o teste não passa "por não ler nada" — o card sadio FOI lido.
    expect(lidos.some((p) => p.includes("story-ok"))).toBe(true);
  });

  it("readCard (uma carta só) também recusa antes de ler", async () => {
    process.env.AGILEHARNESS_FRONTMATTER_MAX_BYTES = "2048";
    await writeCard("acme", "story-gorda", `---\nid: story-gorda\n---\n${"a".repeat(64 * 1024)}\n`);
    const spy = vi.spyOn(fs, "readFile");
    expect(await readCard("acme", "story-gorda")).toBeNull();
    expect(spy.mock.calls.map((c) => String(c[0])).some((p) => p.includes("story-gorda"))).toBe(false);
  });
});

describe("ATAQUE: desligar os GATES de TODOS os boards por um `_base` recusado", () => {
  // O `_base/board.yaml` carrega o pipeline canônico — os gates. A recusa do chokepoint e a AUSÊNCIA do
  // arquivo viravam o MESMO `null`: um `_base` hostil (bomba/gigante/torto) fazia todo board cair no
  // pipeline próprio, possivelmente SEM GATES, em silêncio. É um downgrade de segurança disparado por
  // um arquivo que o atacante controla — e o efeito colateral é pior no caminho de ESCRITA: com base
  // `null`, `deriveBoardConfigForPersist` persiste o config RESOLVIDO inteiro, re-inlinando o pipeline
  // canônico no board.yaml e SEVERANDO a herança para sempre.
  let mtimeSeq = 0;
  const writeBase = async (raw: string) => {
    const p = path.join(TMP_ROOT, "boards", "_base", "board.yaml");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, raw, "utf8");
    // mtime único por teste: o `readBaseRaw` memoiza por mtime (inclusive a recusa), e dois arquivos
    // escritos no MESMO milissegundo dariam cache hit cruzado entre testes.
    const t = new Date(Date.UTC(2026, 0, 1 + ++mtimeSeq));
    await fs.utimes(p, t, t);
  };
  const writeBoard = async (id: string, raw: string) => {
    const p = path.join(TMP_ROOT, "boards", id, "board.yaml");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, raw, "utf8");
  };
  const ownBoard = "id: acme\nname: Nest\nstatuses:\n  - id: triage\n    name: Triagem\n";

  it("`_base` AUSENTE segue fail-OPEN — o board carrega o próprio pipeline (estado legítimo)", async () => {
    await writeBoard("acme", ownBoard);
    const cfg = await readBoardConfig("acme");
    expect(cfg.statuses.map((s) => s.id)).toEqual(["triage"]);
  });

  it("`_base` com alias bomb NÃO cai em fail-open: a leitura do board FALHA com o motivo nomeado", async () => {
    await writeBase(`${aliasBombYaml()}\nstatuses:\n  - id: triage\n    name: Triagem\n    gate: hasTasks\n`);
    await writeBoard("acme", ownBoard);
    await expect(readBoardConfig("acme")).rejects.toMatchObject({
      name: "FrontmatterError",
      reason: "too-many-nodes",
    });
  });

  it("`_base` acima do teto de bytes também é fail-CLOSED", async () => {
    await writeBase(`pad: "${"a".repeat(FRONTMATTER_MAX_BYTES_DEFAULT)}"\n`);
    await writeBoard("acme", ownBoard);
    await expect(readBoardConfig("acme")).rejects.toMatchObject({ name: "FrontmatterError", reason: "too-large" });
  });

  it("um `_base` recusado não deixa o SAVE re-inlinar o pipeline canônico (herança severada)", async () => {
    await writeBase(`${aliasBombYaml()}\nstatuses:\n  - id: triage\n    name: Triagem\n`);
    await writeBoard("acme", ownBoard);
    const resolved = { id: "acme", name: "Nest", statuses: [], columns: [] } as unknown as BoardConfig;
    await expect(deriveBoardConfigForPersist("acme", resolved)).rejects.toMatchObject({
      name: "FrontmatterError",
    });
  });
});

describe("LINT: o chokepoint é o ÚNICO parser de frontmatter de `src/`", () => {
  const CHOKEPOINT = path.join(__dirname, "frontmatter.ts");
  /** Os únicos módulos que podem importar `gray-matter`: o chokepoint (parse) e os dois que apenas
   *  SERIALIZAM (`matter.stringify`, que não escolhe engine de parse). Um import a mais aqui é a
   *  decisão de deixar outro arquivo tocar a biblioteca crua — e tem de ser deliberada. */
  const IMPORT_ALLOWLIST = new Set([
    CHOKEPOINT,
    path.join(__dirname, "write.ts"),
    path.join(__dirname, "runner", "harness-flow-env.ts"),
  ]);

  /** Tira comentários e strings antes de procurar chamadas — uma prosa que MENCIONA `matter()` não é
   *  um call-site, e um lint que confunde as duas coisas treina o próximo dev a ignorá-lo. */
  const stripProse = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');

  const sourceFiles = (): string[] => {
    const srcRoot = path.resolve(__dirname, "../..");
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          walk(p);
        } else if ((e.name.endsWith(".ts") || e.name.endsWith(".tsx")) && !e.name.endsWith(".test.ts")) {
          out.push(p);
        }
      }
    };
    walk(srcRoot);
    return out;
  };

  it("nenhum módulo de src chama `matter(...)` fora de frontmatter.ts", () => {
    // O teste que a story pede explicitamente: sem ele, o próximo call-site que precisar ler um card
    // reabre o buraco em silêncio (foram 5 sítios, e ninguém percebeu por meses). `matter.stringify`
    // é ESCRITA e segue permitido; o proibido é a chamada de PARSE.
    const offenders = sourceFiles()
      .filter((p) => p !== CHOKEPOINT)
      .filter((p) => {
        const code = stripProse(readFileSync(p, "utf8"));
        return /\bmatter\s*\(/.test(code) || /\bmatter\.read\s*\(/.test(code);
      });
    expect(offenders, "use parseFrontmatter() de lib/storymap/frontmatter.ts").toEqual([]);
  });

  /** Os únicos módulos de `src/` que podem PARSEAR YAML fora do chokepoint. Os dois não-chokepoint
   *  leem `storymap/settings.yaml` — o arquivo de knobs do OPERADOR, que NÃO é dado de board (nem cai
   *  na árvore que um PR de contribuidor edita hoje). Se o settings.yaml algum dia entrar no corpus de
   *  PR, o certo é movê-lo para o chokepoint, não ampliar esta lista. */
  const YAML_PARSE_ALLOWLIST = new Set([
    CHOKEPOINT,
    path.join(__dirname, "runner", "config.ts"), // settings.yaml (readFileSettings)
    path.resolve(__dirname, "../vps/metrics.ts"), // settings.yaml (headroom)
  ]);

  it("nenhum módulo de src PARSEIA YAML com js-yaml fora do chokepoint", () => {
    // O LINT QUE FALTAVA. O de `matter(` acima anunciava um invariante mais forte do que provava: dois
    // sítios VIVOS (style-guide.ts e config-cockpit.ts) parseavam bytes de `storymap/boards/**` com
    // `yaml.load` — sem teto de bytes/nós/profundidade e sem guard de `__proto__` — e a suíte ficava
    // VERDE, porque o lint só conhecia gray-matter. Um `yaml.load` novo tem de ficar VERMELHO aqui.
    //
    // A régua é "importa js-yaml E chama `.load(<algo>)`/`.loadAll(<algo>)`": pega o import renomeado
    // (`import y from "js-yaml"; y.load(raw)`) sem confundir `.load()` sem argumento de outras APIs
    // (`diskTelemetryStore().load()`). `yaml.dump` (SERIALIZAR o que nós mesmos construímos) segue
    // livre — o proibido é LER bytes de fora.
    //
    // `loadAll` entra no `(?:All)?` porque é a OUTRA entrada de parse do js-yaml (multi-documento) e
    // ela escapava do `\.load\s*\(`: `yaml.loadAll(bytesDeBoard, fn)` parseia sem teto de
    // bytes/nós/profundidade e sem guard de `__proto__`, exatamente como o `yaml.load` que este lint
    // nasceu para proibir. Hoje ninguém a usa (conferido) — é para continuar assim.
    const offenders = sourceFiles()
      .filter((p) => !YAML_PARSE_ALLOWLIST.has(p))
      .filter((p) => {
        const raw = readFileSync(p, "utf8");
        if (!/from\s+["']js-yaml["']|require\(["']js-yaml["']\)/.test(raw)) return false;
        return /\.load(?:All)?\s*\(\s*[^\s)]/.test(stripProse(raw));
      });
    expect(offenders, "use parseYamlMap()/parseFrontmatter() de lib/storymap/frontmatter.ts").toEqual([]);
  });

  it("só o chokepoint (e os dois que apenas serializam) importam `gray-matter`", () => {
    // Trava complementar: o lint de identificador acima é burlável renomeando o import
    // (`import m from "gray-matter"; m(raw)`); a allowlist de IMPORT não é.
    const offenders = sourceFiles().filter(
      (p) => !IMPORT_ALLOWLIST.has(p) && /from\s+["']gray-matter["']|require\(["']gray-matter["']\)/.test(readFileSync(p, "utf8")),
    );
    expect(offenders, "importe parseFrontmatter, não gray-matter").toEqual([]);
  });
});
