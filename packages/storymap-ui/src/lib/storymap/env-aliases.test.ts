import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  avisoDeLegados,
  ehNomeLegado,
  familiaLegadaDe,
  nomeLegadoDe,
  nomeNovoDe,
  PREFIXO_NOVO,
  PREFIXOS_LEGADOS,
  resolverAliasesDeEnv,
  SUFIXOS_LEGADOS,
  SUFIXOS_NATIVOS,
} from "./env-aliases";
import { findToolPackageDir } from "./paths";
import { sanitizeSpawnEnv } from "./runner/spawn-env";

// ── A ENUMERAÇÃO — a guarda que o plano pediu: "enumera as variáveis lidas e falha se alguma legada não
// tiver alias". Pós-rename o código não contém mais nome legado nenhum; o que ele contém é todo nome
// `AGILEHARNESS_*` que lê ou emite, e a pergunta virou: para CADA um deles, sabemos se um operador ainda
// pode escrevê-lo na grafia antiga (e qual)? Um nome fora do catálogo e fora dos nativos é uma variável
// que entrou sem essa decisão — e é isso que reprova.
const PKG = findToolPackageDir();
const SRC = path.join(PKG, "src");

/** Todo nome `AGILEHARNESS_*` que o código LÊ ou EMITE, por FORMA (não por token solto — constante TS não é env). */
function nomesLidosPeloCodigo(): Map<string, string[]> {
  const onde = new Map<string, string[]>();
  const anotar = (nome: string, arquivo: string) => {
    const lista = onde.get(nome) ?? [];
    if (!lista.includes(arquivo)) lista.push(arquivo);
    onde.set(nome, lista);
  };
  const FORMAS: RegExp[] = [
    /process\.env\.(AGILEHARNESS_[A-Z0-9_]+)/g, // leitura direta
    /[A-Za-z_]*[eE]nv\.(AGILEHARNESS_[A-Z0-9_]+)/g, // `env.X` de um env injetado, `baseEnv.X =` de um filho
    /["'`](AGILEHARNESS_[A-Z0-9_]+)["'`]/g, // constante/lista de nomes (`MCP_TOKEN_ENV`, `ENV_KEYS`)
  ];
  const FORMA_SHELL = /\$\{?(AGILEHARNESS_[A-Z0-9_]+)/g; // só nos scripts do package.json (em TS seria interpolação de constante)
  const varrerArquivo = (arquivo: string) => {
    const texto = readFileSync(arquivo, "utf8");
    const formas = arquivo.endsWith("package.json") ? [FORMA_SHELL] : FORMAS;
    for (const re of formas) for (const m of texto.matchAll(re)) anotar(m[1], path.relative(PKG, arquivo));
  };
  const varrer = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) varrer(full);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/env-aliases\.ts$/.test(e.name))
        varrerArquivo(full);
    }
  };
  varrer(SRC);
  for (const extra of ["next.config.js", "package.json"]) varrerArquivo(path.join(PKG, extra));
  return onde;
}

describe("catálogo de aliases — enumeração honesta", () => {
  const lidos = nomesLidosPeloCodigo();
  const sufixosLidos = [...lidos.keys()].map((n) => n.slice(PREFIXO_NOVO.length));

  it("a varredura encontrou o contrato inteiro (guarda de não-vacuidade)", () => {
    // 62 legados + 27 nativos medidos em 2026-09-10. Uma varredura que achasse "poucos" passaria calada
    // pelo que não viu — e esse é exatamente o modo de falha que a enumeração existe para impedir.
    expect(sufixosLidos.length, "poucos nomes — o caminho ou as formas da varredura estão errados").toBeGreaterThan(80);
  });

  it("TODO nome que o código lê é legado (catalogado) OU nativo — nenhum entrou sem decisão", () => {
    const semDecisao = sufixosLidos.filter((s) => !familiaLegadaDe(s) && !SUFIXOS_NATIVOS.includes(s));
    expect(
      semDecisao.map((s) => `${PREFIXO_NOVO}${s} (${lidos.get(`${PREFIXO_NOVO}${s}`)!.join(", ")})`),
      "variável nova sem decisão: acrescente a SUFIXOS_LEGADOS (com a família de onde veio) ou a SUFIXOS_NATIVOS",
    ).toEqual([]);
  });

  it("nenhuma entrada MORTA no catálogo: todo sufixo exato é lido ou emitido por alguém", () => {
    const mortos = Object.keys(SUFIXOS_LEGADOS).filter((s) => !sufixosLidos.includes(s));
    expect(mortos, "entrada do catálogo que ninguém lê — remova-a, ou o alias promete o que o código não honra").toEqual(
      [],
    );
  });

  it("nenhum nativo é lido em vão, e nenhum sufixo está nos dois conjuntos", () => {
    const nativosMortos = SUFIXOS_NATIVOS.filter((s) => !sufixosLidos.includes(s));
    expect(nativosMortos).toEqual([]);
    const ambos = SUFIXOS_NATIVOS.filter((s) => familiaLegadaDe(s));
    expect(ambos, "um sufixo não pode ser nativo E legado — a família decide o twin").toEqual([]);
  });

  it("nenhum nativo cai num prefixo dinâmico por acidente", () => {
    for (const s of SUFIXOS_NATIVOS) for (const [p] of PREFIXOS_LEGADOS) expect(s.startsWith(p), `${s} ~ ${p}`).toBe(false);
  });
});

describe("a regra mecânica de nomes", () => {
  it("legado → novo é por prefixo, qualquer sufixo (inclusive um que o catálogo nunca viu)", () => {
    expect(nomeNovoDe("STORYMAP_TARGET")).toBe("AGILEHARNESS_TARGET");
    expect(nomeNovoDe("USM_AUTORUN_MAX")).toBe("AGILEHARNESS_AUTORUN_MAX");
    expect(nomeNovoDe("USM_ALGO_QUE_NAO_EXISTE")).toBe("AGILEHARNESS_ALGO_QUE_NAO_EXISTE");
    expect(nomeNovoDe("AGILEHARNESS_HOST")).toBeUndefined();
    expect(nomeNovoDe("STORYMAP_")).toBeUndefined();
    expect(nomeNovoDe("MYSTORYMAP_X")).toBeUndefined();
  });

  it("novo → legado precisa da família, e a família vem do catálogo", () => {
    expect(nomeLegadoDe("AGILEHARNESS_TARGET")).toBe("STORYMAP_TARGET");
    expect(nomeLegadoDe("AGILEHARNESS_AUTORUN_MAX")).toBe("USM_AUTORUN_MAX");
    // os marcadores de run são STORYMAP apesar do AUTORUN_ — é o exato vencendo o instinto
    expect(nomeLegadoDe("AGILEHARNESS_AUTORUN_RUN_ID")).toBe("STORYMAP_AUTORUN_RUN_ID");
    // dinâmicos: qualquer tier MCP, qualquer teto por board
    expect(nomeLegadoDe("AGILEHARNESS_MCP_TOKEN_ORCH")).toBe("STORYMAP_MCP_TOKEN_ORCH");
    expect(nomeLegadoDe("AGILEHARNESS_MCP_TOKEN_UM_TIER_FUTURO")).toBe("STORYMAP_MCP_TOKEN_UM_TIER_FUTURO");
    expect(nomeLegadoDe("AGILEHARNESS_AUTORUN_TIER_CAP_NOOK")).toBe("USM_AUTORUN_TIER_CAP_NOOK");
    // nativo e desconhecido não ganham twin
    expect(nomeLegadoDe("AGILEHARNESS_HOST")).toBeUndefined();
    expect(nomeLegadoDe("AGILEHARNESS_INVENTADO_AGORA")).toBeUndefined();
    expect(nomeLegadoDe("STORYMAP_TARGET")).toBeUndefined();
  });

  it("ehNomeLegado reconhece as duas famílias e só elas", () => {
    expect(ehNomeLegado("STORYMAP_ENGINE")).toBe(true);
    expect(ehNomeLegado("USM_AUTORUN")).toBe(true);
    expect(ehNomeLegado("AGILEHARNESS_ENGINE")).toBe(false);
    expect(ehNomeLegado("USM")).toBe(false);
    expect(ehNomeLegado("USM_")).toBe(false);
  });
});

describe("resolverAliasesDeEnv — a ponte nas duas direções", () => {
  it("legado só ⇒ preenche o novo E acusa o legado em uso, nomeando o novo", () => {
    const env: Record<string, string | undefined> = { STORYMAP_TARGET: "/alvo", USM_AUTORUN_MAX: "3" };
    const r = resolverAliasesDeEnv(env);
    expect(env.AGILEHARNESS_TARGET).toBe("/alvo");
    expect(env.AGILEHARNESS_AUTORUN_MAX).toBe("3");
    expect(r.legadosEmUso).toEqual([
      { legado: "STORYMAP_TARGET", novo: "AGILEHARNESS_TARGET" },
      { legado: "USM_AUTORUN_MAX", novo: "AGILEHARNESS_AUTORUN_MAX" },
    ]);
    expect(r.conflitos).toEqual([]);
    const aviso = avisoDeLegados(r)!;
    expect(aviso).toContain("STORYMAP_TARGET → AGILEHARNESS_TARGET");
    expect(aviso).toContain("USM_AUTORUN_MAX → AGILEHARNESS_AUTORUN_MAX");
    expect(aviso).toContain("LEGADOS");
  });

  it("novo só ⇒ preenche o legado em SILÊNCIO (é para quem ainda lê a grafia velha), nativo fica sozinho", () => {
    const env: Record<string, string | undefined> = {
      AGILEHARNESS_AUTORUN_RUN_ID: "run-1",
      AGILEHARNESS_MCP_TOKEN_ORCH: "t",
      AGILEHARNESS_AUTORUN_TIER_CAP_NOOK: "sonnet",
      AGILEHARNESS_HOST: "127.0.0.1",
    };
    const r = resolverAliasesDeEnv(env);
    expect(env.STORYMAP_AUTORUN_RUN_ID).toBe("run-1");
    expect(env.STORYMAP_MCP_TOKEN_ORCH).toBe("t");
    expect(env.USM_AUTORUN_TIER_CAP_NOOK).toBe("sonnet");
    expect(Object.keys(env).filter((k) => k.endsWith("_HOST"))).toEqual(["AGILEHARNESS_HOST"]);
    expect(r.legadosEmUso).toEqual([]);
    expect(avisoDeLegados(r)).toBeNull();
  });

  it("as duas grafias iguais ⇒ nada a fazer, nada a avisar", () => {
    const env = { STORYMAP_ENGINE: "off", AGILEHARNESS_ENGINE: "off" };
    const r = resolverAliasesDeEnv(env);
    expect(r).toEqual({ legadosEmUso: [], preenchidos: [], conflitos: [] });
    expect(avisoDeLegados(r)).toBeNull();
  });

  it("as duas grafias DIFERENTES ⇒ a nova vence, a velha não é tocada, e o conflito é nomeado", () => {
    const env = { STORYMAP_ENGINE: "on", AGILEHARNESS_ENGINE: "off" };
    const r = resolverAliasesDeEnv(env);
    expect(env).toEqual({ STORYMAP_ENGINE: "on", AGILEHARNESS_ENGINE: "off" });
    expect(r.conflitos).toEqual([{ legado: "STORYMAP_ENGINE", novo: "AGILEHARNESS_ENGINE" }]);
    expect(avisoDeLegados(r)).toContain("STORYMAP_ENGINE ≠ AGILEHARNESS_ENGINE");
  });

  it("vazio conta como ausente — um `.env.local` lido pela metade não vira valor", () => {
    const env: Record<string, string | undefined> = { STORYMAP_MCP_TOKEN: "", AGILEHARNESS_MCP_TOKEN: "   " };
    resolverAliasesDeEnv(env);
    expect(env).toEqual({ STORYMAP_MCP_TOKEN: "", AGILEHARNESS_MCP_TOKEN: "   " });
  });

  it("é idempotente: a segunda passagem não muda nada nem acusa legado", () => {
    const env: Record<string, string | undefined> = { STORYMAP_TARGET: "/alvo", AGILEHARNESS_AUTORUN_MAX: "2" };
    resolverAliasesDeEnv(env);
    const antes = { ...env };
    const r2 = resolverAliasesDeEnv(env);
    expect(env).toEqual(antes);
    expect(r2).toEqual({ legadosEmUso: [], preenchidos: [], conflitos: [] });
  });

  it("um legado com sufixo desconhecido ainda ganha o novo (regra mecânica), mas não é catalogado", () => {
    const env: Record<string, string | undefined> = { USM_FLAG_DE_ONTEM: "1" };
    resolverAliasesDeEnv(env);
    expect(env.AGILEHARNESS_FLAG_DE_ONTEM).toBe("1");
    expect(familiaLegadaDe("FLAG_DE_ONTEM")).toBeUndefined();
  });
});

describe("a ponte no chokepoint de spawn", () => {
  it("o filho recebe as DUAS grafias do que não é segredo — e NENHUMA grafia do que é", () => {
    const filho = sanitizeSpawnEnv({
      STORYMAP_TARGET: "/alvo",
      AGILEHARNESS_AUTORUN_RUN_ID: "run-1",
      STORYMAP_MCP_TOKEN: "segredo-1",
      AGILEHARNESS_MCP_TOKEN_ORCH: "segredo-2",
      STORYMAP_VAPID_PRIVATE_KEY: "segredo-3",
      AGILEHARNESS_FEEDBACK_INGEST_TOKENS: "nook:segredo-4",
      PATH: "/usr/bin",
    } as unknown as NodeJS.ProcessEnv) as Record<string, string | undefined>;
    // o que o umbrella lê como marcador de run sancionado sai na grafia velha; o código lê a nova
    expect(filho.STORYMAP_TARGET).toBe("/alvo");
    expect(filho.AGILEHARNESS_TARGET).toBe("/alvo");
    expect(filho.STORYMAP_AUTORUN_RUN_ID).toBe("run-1");
    expect(filho.AGILEHARNESS_AUTORUN_RUN_ID).toBe("run-1");
    // segredo não viaja em grafia nenhuma — a ponte NÃO pode ser a porta por onde ele volta
    for (const k of Object.keys(filho)) {
      expect(k.includes("MCP_TOKEN"), k).toBe(false);
      expect(k.includes("VAPID_PRIVATE_KEY"), k).toBe(false);
      expect(k.includes("FEEDBACK_INGEST_TOKENS"), k).toBe(false);
    }
    expect(Object.values(filho).some((v) => typeof v === "string" && v.startsWith("segredo-"))).toBe(false);
  });
});
