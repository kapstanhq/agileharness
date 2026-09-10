// O RISCO que este arquivo cobre é de ADOÇÃO, e ele é do mesmo tamanho de um buraco de segurança:
// um piso novo que MATA o boot de quem atualiza tira do agente TODA a capacidade dele de uma vez.
//
// O caso concreto: até story-7q83gx o piso do token MCP era 24 chars. O adotante que tem exatamente
// isso na env — legal ontem — atualiza o AgileHarness e, se o bootstrap LANÇAR, o entrypoint de
// produção (`src/server/main.ts` → `main().catch` → `process.exit(1)`) não sobe NADA: sem board, sem
// autorun, sem terminal. Recusa TOTAL por causa de UMA porta.
//
// A saída honesta é a degradação, e ela já é fail-closed de verdade: `isMcpTokenValid` recusa segredo
// fraco por REQUISIÇÃO (mcp/auth.ts), então um token de 24 chars deixa a superfície MCP FECHADA com
// ou sem morte de processo. Matar o serviço não fecha porta nenhuma a mais — só destrói capacidade.
// Logo: em loopback o boot SEGUE, com um aviso alto e PRESCRITIVO; com bind aberto a mesma fraqueza
// RECUSA subir (`boot-refuses-weak-mcp-token.test.ts` prova esse outro lado).

import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";

/** O dublê do Next. `prepare()` lança de propósito — chegar a `listen` numa suíte é proibido. */
const prepare = vi.fn(async (): Promise<void> => {
  throw new Error("SENTINELA — prepare() do Next foi chamado");
});

vi.mock("next", () => ({
  default: () => ({ prepare, getRequestHandler: () => () => undefined }),
}));

const forte = (): string => randomBytes(32).toString("base64url");
/** 24 chars aleatórios: o piso ANTIGO. Não é adivinhável — é só CURTO para a régua nova. */
const DO_PISO_ANTIGO = forte().slice(0, 24);

const ENVS_TOCADAS = [
  "AGILEHARNESS_HOST",
  "AGILEHARNESS_PORT",
  "AGILEHARNESS_DEV",
  "AGILEHARNESS_ALLOW_PUBLIC_BIND",
  "NODE_ENV",
  "PORT",
  "AGILEHARNESS_MCP_TOKEN",
  "__NEXT_PROCESSED_ENV",
  SESSION_SECRET_ENV,
  TOKEN_ENV,
] as const;

type Espiao = { mock: { calls: unknown[][] } };

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
const salvo: Record<string, string | undefined> = {};

async function assentar(): Promise<void> {
  for (let i = 0; i < 200 && exit.mock.calls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  for (const k of ENVS_TOCADAS) salvo[k] = process.env[k];

  // O CENÁRIO DA ATUALIZAÇÃO: instalação local (loopback, o default) com o token do piso antigo.
  delete process.env.AGILEHARNESS_HOST;
  delete process.env.AGILEHARNESS_DEV;
  delete process.env.AGILEHARNESS_ALLOW_PUBLIC_BIND;
  delete process.env.__NEXT_PROCESSED_ENV;
  process.env.AGILEHARNESS_PORT = "39120";
  process.env.AGILEHARNESS_MCP_TOKEN = DO_PISO_ANTIGO;
  process.env[TOKEN_ENV] = forte();
  process.env[SESSION_SECRET_ENV] = forte();

  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  await import("@/server/main");
  await assentar();
});

afterAll(() => {
  for (const k of ENVS_TOCADAS) {
    if (salvo[k] === undefined) delete process.env[k];
    else (process.env as EnvLike)[k] = salvo[k];
  }
  vi.restoreAllMocks();
});

const saidaDe = (spy: Espiao): string =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");

describe("token MCP do piso ANTIGO em loopback — a atualização não pode derrubar o serviço", () => {
  it("o boot SEGUE (o Next é preparado): a porta fraca não mata o processo", () => {
    // `prepare` chamado é a prova de que o boot atravessou a auto-checagem. O `exit(1)` que vem
    // depois é a SENTINELA do dublê — não a recusa.
    expect(prepare).toHaveBeenCalled();
    expect(saidaDe(error)).toContain("SENTINELA");
    expect(saidaDe(error).toLowerCase()).not.toContain("recusando");
  });

  it("o aviso é PRESCRITIVO: nomeia a env, o motivo, o comando que gera um forte e o efeito real", () => {
    const aviso = saidaDe(warn);
    expect(aviso).toContain("AGILEHARNESS_MCP_TOKEN");
    expect(aviso).toContain("menos de 32 caracteres");
    expect(aviso).toContain("randomBytes(32)");
    // O efeito é o que o operador precisa entender: a superfície MCP está FECHADA, não "meio aberta".
    expect(aviso.toLowerCase()).toContain("fechada");
  });

  it("o segredo NUNCA aparece no log — nem o do piso antigo", () => {
    // Log vai para journald e para o próximo relatório de bug. Só o comprimento pode sair.
    expect(saidaDe(warn)).not.toContain(DO_PISO_ANTIGO);
    expect(saidaDe(error)).not.toContain(DO_PISO_ANTIGO);
  });
});
