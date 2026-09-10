// O caminho EXPLÍCITO para o operador ganhar um token MCP forte — e a razão pela qual ele é um
// COMANDO e não um passo de boot.
//
// O ATAQUE que o comando fecha: sem um gerador à mão, o adotante do open-source INVENTA um segredo
// para uma URL que fica na internet pública e cujas tools spawnam `claude
// --dangerously-skip-permissions`. Um humano inventa algo memorizável; a régua de entropia
// (mcp/auth.ts) então RECUSA, e sem uma saída pronta o resultado prático é o adotante desistir da
// entropia, não ganhar segurança.
//
// O ATAQUE que ele NÃO reabre: gerar no BOOT — o que a onda 1 fazia — armava a superfície MCP em toda
// instalação, inclusive nas que nunca pediram o endpoint, contradizendo a garantia do header da route
// ("refused outright unless AGILEHARNESS_MCP_TOKEN is set"). Aqui a geração é um ato declarado do
// operador, e mesmo assim ela NÃO arma nada: quem arma é a env que ele decide escrever.
//
// Este arquivo prova a FIAÇÃO do comando (o entrypoint de produção reconhece a flag, produz o
// segredo, não sobe o servidor e não sai com erro) — a semântica está em mcp/token-bootstrap.test.ts.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";

/** O dublê do Next. Um comando de operador NÃO pode preparar o Next nem chegar a um `listen`. */
const prepare = vi.fn(async (): Promise<void> => {
  throw new Error("SENTINELA — prepare() do Next foi chamado");
});

vi.mock("next", () => ({
  default: () => ({ prepare, getRequestHandler: () => () => undefined }),
}));

const ENVS_TOCADAS = [
  "AGILEHARNESS_HOST",
  "AGILEHARNESS_PORT",
  "AGILEHARNESS_DEV",
  "NODE_ENV",
  "PORT",
  "AGILEHARNESS_MCP_TOKEN",
  "__NEXT_PROCESSED_ENV",
  SESSION_SECRET_ENV,
  TOKEN_ENV,
] as const;

type Main = typeof import("@/server/main");
type Espiao = { mock: { calls: unknown[][] } };

/** A flag como o operador a digita. Conferida contra a constante exportada no primeiro caso. */
const FLAG = "--generate-mcp-token";

let mod: Main;
let info: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
const salvo: Record<string, string | undefined> = {};
let argvOriginal: string[];

const saidaDe = (spy: Espiao): string =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");

beforeAll(async () => {
  for (const k of ENVS_TOCADAS) salvo[k] = process.env[k];
  argvOriginal = process.argv;

  delete process.env.AGILEHARNESS_HOST;
  delete process.env.AGILEHARNESS_DEV;
  delete process.env.AGILEHARNESS_MCP_TOKEN;
  delete process.env.__NEXT_PROCESSED_ENV;
  process.env.AGILEHARNESS_PORT = "39121";

  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  // A flag entra ANTES do import: o módulo dispara `main()` no próprio import, e no processo real ela
  // já está no argv desde o primeiro instante. O literal é conferido contra a constante exportada no
  // caso abaixo — assim renomear a flag REPROVA em vez de silenciosamente deixar de exercer o comando.
  process.argv = [...argvOriginal, FLAG];
  mod = (await import("@/server/main")) as Main;
  // `main()` é assíncrono e o comando escreve o arquivo dentro dele.
  for (let i = 0; i < 100 && !existsSync(arquivoDoToken()); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
});

afterAll(() => {
  process.argv = argvOriginal;
  for (const k of ENVS_TOCADAS) {
    if (salvo[k] === undefined) delete process.env[k];
    else (process.env as EnvLike)[k] = salvo[k];
  }
  vi.restoreAllMocks();
});

/** O registro a 0600 — no diretório de estado que a suíte redireciona para um temp (vitest.setup.ts). */
function arquivoDoToken(): string {
  return path.join(process.env.AGILEHARNESS_RUNNER_STATE_DIR!, "mcp-token");
}

describe("node dist/ah-server.mjs --generate-mcp-token", () => {
  it("produz um segredo forte registrado a 0600 — o operador não precisa inventar nenhum", () => {
    expect(mod.GENERATE_MCP_TOKEN_FLAG).toBe(FLAG); // a flag exercida é a que o código publica
    const arquivo = arquivoDoToken();
    expect(existsSync(arquivo)).toBe(true);
    const token = readFileSync(arquivo, "utf8").trim();
    expect(token).toHaveLength(43); // 32 bytes em base64url
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 0600: outro usuário da máquina lendo este arquivo é a chave da URL pública vazando.
    expect(statSync(arquivo).mode & 0o777).toBe(0o600);
  });

  it("imprime a linha pronta do .env.local e diz que é a ENV que arma a porta", () => {
    const token = readFileSync(arquivoDoToken(), "utf8").trim();
    const saida = saidaDe(info);
    expect(saida).toContain(`AGILEHARNESS_MCP_TOKEN=${token}`);
    expect(saida).toContain("FECHADA");
    expect(saida).toContain("NUNCA o comite");
  });

  it("não sobe o serviço e não sai com erro — é um comando, não um boot", () => {
    // Preparar o Next aqui significaria service.lock, watcher e merge train de pé só para imprimir um
    // segredo; um exit(1) quebraria qualquer script que use este comando no provisionamento.
    expect(prepare).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    // E a geração NÃO arma a porta: o segredo RECÉM-GERADO não vai parar na env.
    //
    // Asserir `toBeUndefined()` aqui media o `.env.local` do HOST, não o comando. O `beforeAll`
    // apaga a env, mas `main.ts:96` chama `loadEnvConfig`, que a repovoa a partir do arquivo do
    // operador — então numa máquina com a porta JÁ ARMADA o caso reprovava sem regressão nenhuma.
    // Foi o que manteve a main vermelha por 68h (medido em 2026-08-06 com o par: comentar a linha
    // do `.env.local` fazia RC virar 0 sem tocar em uma linha de código).
    //
    // Comparar com o token gerado mede a propriedade de verdade e vale nos dois hosts: numa
    // instalação limpa a env está vazia e difere; numa armada ela tem o segredo ANTIGO do operador
    // e também difere. Só fica igual se a geração passar a armar a porta — que é o defeito.
    const gerado = readFileSync(arquivoDoToken(), "utf8").trim();
    expect(process.env.AGILEHARNESS_MCP_TOKEN).not.toBe(gerado);
  });
});
