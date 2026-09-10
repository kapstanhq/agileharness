import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONTRATO_DE_ENV, chavesFaltantes } from "./env-contract";
import { findToolPackageDir } from "./paths";
import { runPreflight } from "./preflight";

// O autopush exige o literal "1" — a fixture tem de sustentá-lo de verdade, senão ela mesma é a
// armadilha que os casos abaixo descrevem (e o primeiro a cair nela fui eu).
const cheio: Record<string, string> = Object.fromEntries(
  CONTRATO_DE_ENV.map((c) => [c.chave, c.chave === "AGILEHARNESS_BOARD_AUTOPUSH" ? "1" : "x"]),
);

describe("contrato de env — o que se apaga em silêncio", () => {
  it("ambiente completo ⇒ nada faltando", () => {
    expect(chavesFaltantes(cheio)).toEqual([]);
  });

  // A PONTE DE NOMES (env-aliases.ts): o env julgado pode ser o do serviço vivo, lido de /proc, ainda na
  // grafia legada. Sem isto o diagnóstico de um serviço em `STORYMAP_*` acusaria o contrato inteiro
  // como ausente — foi exatamente o que o primeiro boot de smoke da 0.3.0 mostrou (2026-09-10).
  it("as chaves em grafia LEGADA sustentam o contrato do mesmo jeito — e a cópia não muda o env do chamador", () => {
    const legado: Record<string, string> = {
      STORYMAP_MCP_TOKEN: "x",
      STORYMAP_VAPID_PUBLIC_KEY: "x",
      STORYMAP_VAPID_PRIVATE_KEY: "x",
      AGILEHARNESS_PUBLIC_URL: "x",
      STORYMAP_BOARD_AUTOPUSH: "1",
    };
    const antes = { ...legado };
    expect(chavesFaltantes(legado)).toEqual([]);
    expect(legado).toEqual(antes);
    // e a armadilha do literal "1" continua sendo vista na grafia velha
    expect(chavesFaltantes({ ...legado, STORYMAP_BOARD_AUTOPUSH: "true" }).map((f) => f.chave)).toEqual([
      "AGILEHARNESS_BOARD_AUTOPUSH",
    ]);
  });

  // O CENÁRIO DO CUTOVER: a WorkingDirectory muda, o `.env.local` fica para trás, e o que chega é só o
  // que a unit declara. Nenhum consumidor emite erro — é exatamente por isso que precisa ser medido.
  it("só o que a unit declara ⇒ nomeia cada chave E o que ela desliga", () => {
    const faltando = chavesFaltantes({ NODE_ENV: "production", AGILEHARNESS_HOST: "127.0.0.1" });
    expect(faltando.map((f) => f.chave)).toContain("AGILEHARNESS_MCP_TOKEN");
    expect(faltando.map((f) => f.chave)).toContain("AGILEHARNESS_VAPID_PUBLIC_KEY");
    // a consequência viaja junto: um relatório que só diz "faltou" obriga o operador a ir descobrir
    expect(faltando.every((f) => f.desliga.length > 20)).toBe(true);
    // e todas são silenciosas — é essa propriedade que justifica o check existir
    expect(faltando.every((f) => f.silenciosa)).toBe(true);
  });

  it("presente porém VAZIA é falta — é o arquivo lido pela metade", () => {
    expect(chavesFaltantes({ ...cheio, AGILEHARNESS_MCP_TOKEN: "   " }).map((f) => f.motivo)).toEqual(["vazia"]);
  });

  // O autopush é opt-in: ausência é escolha. A armadilha é o valor PLAUSÍVEL que o leitor recusa —
  // quem escreve "true" acredita ter ligado, e desligou.
  it("autopush: ausente NÃO é falta; \"true\" É", () => {
    expect(chavesFaltantes(cheio).map((f) => f.chave)).not.toContain("AGILEHARNESS_BOARD_AUTOPUSH");
    expect(chavesFaltantes({ ...cheio, AGILEHARNESS_BOARD_AUTOPUSH: "true" }).map((f) => f.chave)).toContain(
      "AGILEHARNESS_BOARD_AUTOPUSH",
    );
  });
});

describe("o contrato é LIDO pelo preflight, e é honesto com o catálogo", () => {
  it("o check env.contract degrada nomeando o remédio", () => {
    const r = runPreflight({ env: { NODE_ENV: "production" } });
    const c = r.checks.find((x) => x.id === "env.contract");
    expect(c?.status).toBe("degraded");
    expect(c?.observed).toContain("AGILEHARNESS_MCP_TOKEN");
    expect(c?.remedy).toMatch(/unit do systemd|EnvironmentFile/);
    // a advertência que evita o dano irreversível: gerar VAPID novo invalida as inscrições
    expect(c?.remedy).toMatch(/MESMAS|invalida/);
  });

  it("e passa quando o ambiente sustenta", () => {
    const r = runPreflight({ env: cheio });
    expect(r.checks.find((x) => x.id === "env.contract")?.status).toBe("ok");
  });

  // Toda chave do contrato tem de estar no `.env.example` — o catálogo que VIAJA com o artefato e que
  // o README promete. Uma chave load-bearing que o adotante não consegue descobrir é dívida calada.
  it("toda chave do contrato aparece no .env.example", () => {
    const exemplo = readFileSync(path.join(findToolPackageDir(), ".env.example"), "utf8");
    const ausentes = CONTRATO_DE_ENV.filter((c) => !exemplo.includes(c.chave)).map((c) => c.chave);
    expect(ausentes, "chave load-bearing fora do catálogo publicado").toEqual([]);
  });
});
