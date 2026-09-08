// A GUARDA DO BUNDLE — o modo de execução tem de ser decidido em RUNTIME, nunca em build-time.
//
// O defeito (medido em 2026-07-27, no primeiro boot do servidor próprio): `bun build` faz
// constant-folding de `process.env.NODE_ENV`. Escrito como
//     const dev = process.env.NODE_ENV !== "production";
// o bundle sai com `var dev = true` — literalmente, porque o bundle NASCE fora de um ambiente de
// produção. O servidor de produção subiria com o bundler de DEV ligado, decidido no build, e nenhuma
// env do systemd mudaria isso. O sintoma é sutil (o serviço FUNCIONA, só que compilando sob demanda),
// então nada grita.
//
// Por que este teste chama o bundler de verdade em vez de olhar o fonte: o defeito não está no que
// escrevemos, está no que o bundler FAZ com o que escrevemos. Um lint sobre o fonte não veria o
// folding, e um fonte correto pode voltar a foldar se alguém trocar a flag do `build:server` ou
// importar um módulo novo que leia `NODE_ENV`. A única prova é o artefato.

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

import { describePosix } from "@/lib/storymap/runner/test-platform";

const exec = promisify(nodeExec);

/** Espelha o script `build:server` do package.json — se ele mudar, este teste tem de mudar junto. */
const BUILD_ARGS = "--target=node --format=esm --external next";

describePosix("bundle do servidor — o modo NÃO pode ser decidido em build-time", () => {
  let outDir: string;
  let bundle: string;

  beforeAll(async () => {
    outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ah-bundle-"));
    const out = path.join(outDir, "main.mjs");
    // NODE_ENV explicitamente NÃO-produção: é o cenário em que o folding morde (e é o ambiente real
    // do build, tanto no dev quanto no `bun run build` da VPS, que roda antes do systemd).
    await exec(`bun build src/server/main.ts ${BUILD_ARGS} --outfile ${JSON.stringify(out)}`, {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: "development" },
      timeout: 120_000,
    });
    bundle = await fsp.readFile(out, "utf8");
  }, 130_000);

  afterAll(async () => {
    await fsp.rm(outDir, { recursive: true, force: true });
  });

  it("a decisão de modo sobrevive ao bundler — a env é LIDA em runtime", () => {
    // A env própria não sofre folding (o bundler só substitui NODE_ENV). Se ela sumiu do artefato,
    // alguém trocou a régua por algo que o bundler resolve sozinho.
    expect(bundle).toContain("AGILEHARNESS_DEV");
  });

  it("não existe um `dev` constante-dobrado no artefato", () => {
    // A forma exata que o defeito produziu: `var dev = true;` / `var dev = false;`. Qualquer
    // atribuição literal ao identificador do modo é build-time por definição.
    expect(bundle).not.toMatch(/\b(var|let|const)\s+dev\s*=\s*(true|false)\s*[;,]/);
  });

  it("nenhum módulo do bundle decide comportamento por NODE_ENV", () => {
    // Se `process.env.NODE_ENV` aparecer numa LEITURA dentro do bundle, ela terá sido dobrada. A
    // única menção legítima é a ESCRITA que o entrypoint faz (espelhando o CLI do Next), que o
    // bundler preserva porque é atribuição, não leitura.
    const leituras = bundle.match(/process\.env\.NODE_ENV(?!\s*=[^=])/g) ?? [];
    expect(leituras, `leitura(s) de NODE_ENV que o bundler pode dobrar: ${leituras.length}`).toEqual([]);
  });
});
