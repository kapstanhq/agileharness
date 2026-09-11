// O ATAQUE: publicar na internet um endpoint MCP cujo token é ADIVINHÁVEL — e o token vem de onde
// ele SEMPRE vem na instalação real, um arquivo `.env.local`, não do ambiente do systemd.
//
// Por que este caso precisa existir separado de `bind-audit.test.ts`: lá o token de tutorial é posto
// direto em `process.env`, e a auditoria o encontra por sorte de ordem. Aqui ele chega pelo caminho
// MEDIDO do serviço vivo (o `.env.local`, aplicado pelo @next/env), que é justamente o que o boot
// não enxergava antes de os arquivos .env serem carregados no topo de `main.ts`. Sem essa ordem, a
// auto-checagem auditava um ambiente VAZIO, não achava fraqueza nenhuma e imprimia o PASS
// afirmativo — "Auto-checagem: OK" sobre uma porta aberta com credencial de tutorial. Um controle
// que emite PASS FALSO é pior que controle nenhum, e é exatamente isto que este arquivo impede.
//
// A superfície em jogo: as tools de `/api/mcp/<token>/mcp` spawnam `claude
// --dangerously-skip-permissions` NESTA máquina. Custo de autonomia da guarda: ZERO — ela só decide
// se a PORTA pode existir de frente para a rede, nunca o que o agente pode fazer depois de entrar.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";

/** O dublê do Next. `prepare()` lança: um boot que passe pela recusa aparece como SENTINELA, não como servidor. */
const prepare = vi.fn(async (): Promise<void> => {
  throw new Error("SENTINELA — prepare() do Next foi chamado");
});

vi.mock("next", () => ({
  default: () => ({ prepare, getRequestHandler: () => () => undefined }),
}));

/** 33 chars: passa o piso de comprimento e é adivinhável — o default de fábrica que o plano OSS não quer. */
const ADIVINHAVEL = "changeme-changeme-changeme-change";
const forte = (): string => randomBytes(32).toString("base64url");

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
let cwdOriginal: string;
/** O diretório de serviço desta suíte — de módulo para que o afterAll o remova de /tmp. */
let dirDoServico: string | undefined;

async function assentar(): Promise<void> {
  for (let i = 0; i < 200 && exit.mock.calls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  for (const k of ENVS_TOCADAS) salvo[k] = process.env[k];
  cwdOriginal = process.cwd();

  // O token de tutorial chega POR ARQUIVO — o caminho real da instalação.
  dirDoServico = mkdtempSync(path.join(tmpdir(), "ah-boot-weak-mcp-"));
  writeFileSync(path.join(dirDoServico, ".env.local"), `AGILEHARNESS_MCP_TOKEN=${ADIVINHAVEL}\n`, { mode: 0o600 });
  process.chdir(dirDoServico);

  // O CENÁRIO DO ATAQUE: porta aberta para a rede, credenciais do operador FORTES (para o único
  // motivo de recusa ser o token MCP) e nenhum override declarado.
  process.env.AGILEHARNESS_HOST = "0.0.0.0";
  process.env.AGILEHARNESS_PORT = "39119";
  process.env[TOKEN_ENV] = forte();
  process.env[SESSION_SECRET_ENV] = forte();
  delete process.env.AGILEHARNESS_DEV;
  delete process.env.AGILEHARNESS_ALLOW_PUBLIC_BIND;
  delete process.env.AGILEHARNESS_MCP_TOKEN;
  delete process.env.__NEXT_PROCESSED_ENV;

  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  await import("@/server/main");
  await assentar();
});

afterAll(() => {
  process.chdir(cwdOriginal);
  for (const k of ENVS_TOCADAS) {
    if (salvo[k] === undefined) delete process.env[k];
    else (process.env as EnvLike)[k] = salvo[k];
  }
  vi.restoreAllMocks();
  // Só DEPOIS do chdir de volta: o diretório de serviço some com a suíte em vez de ficar em /tmp.
  if (dirDoServico) rmSync(dirDoServico, { recursive: true, force: true });
});

const saidaDe = (spy: Espiao): string =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");

describe("bind aberto + token MCP de tutorial no .env.local — o boot RECUSA", () => {
  it("o serviço não sobe: o Next nem chega a ser preparado", () => {
    expect(prepare).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(saidaDe(error)).not.toContain("SENTINELA");
    expect(saidaDe(error).toLowerCase()).toContain("recusando");
  });

  it("a recusa NOMEIA o token MCP — e nunca imprime o PASS afirmativo sobre este ambiente", () => {
    const aviso = saidaDe(warn);
    expect(aviso).toContain("AGILEHARNESS_MCP_TOKEN");
    // O PASS falso é o achado: com a env carregada só depois, a auditoria não via o token do arquivo
    // e imprimia "Auto-checagem: OK — toda credencial alcançável passou o teste de entropia".
    expect(aviso).not.toContain("Auto-checagem: OK");
  });
});
