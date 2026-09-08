// O ATAQUE deste arquivo não vem de fora: é o PRÓPRIO BOOT rotacionando a credencial de produção.
// O que ele defende é CAPACIDADE do agente — a URL do conector do Claude e as rotas /api/runner/*
// continuarem valendo depois de um restart —, e o perímetro de brinde (a auto-checagem passa a
// julgar o segredo EFETIVO em vez de um ambiente vazio).
//
// MEDIDO no serviço vivo (2026-07-29): /proc/<MainPID>/environ carrega `STORYMAP_MCP_TOKEN_ORCH` e
// `STORYMAP_MCP_TOKEN_RO`, mas NÃO o token primário — a unit systemd não tem `EnvironmentFile=`,
// então `STORYMAP_MCP_TOKEN` chega SÓ por `packages/storymap-ui/.env.local`. E o `.env.local` era
// aplicado pelo @next/env DENTRO de `app.prepare()`, isto é, DEPOIS do boot dos segredos. Duas
// consequências, ambas contra o mandato "porta blindada, agente livre":
//   • o bootstrap do token MCP via a env VAZIA, GERAVA um token novo e o injetava em process.env —
//     e o @next/env, que NÃO sobrescreve o que já está lá, deixava o valor do operador de fora para
//     sempre. No primeiro restart o conector e as 4 rotas /api/runner/* passam a responder 404 nu,
//     sem log: remoção silenciosa de capacidade;
//   • a auto-checagem de perímetro auditava um ambiente sem os segredos e podia imprimir o PASS
//     afirmativo sobre uma instalação que não os continha — um controle que emite PASS FALSO.
//
// A prova é de FIAÇÃO e ORDEM, não de predicado: boot de verdade, com o `next` trocado por um dublê
// cujo `prepare()` EXPLODE (o passo seguinte seria `listen`, numa máquina que já roda o serviço).

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";

/** O dublê do Next. `prepare()` lança de propósito — nenhum teste deste pacote pode chegar a um `listen`. */
const prepare = vi.fn(async (): Promise<void> => {
  throw new Error("SENTINELA — prepare() do Next foi chamado");
});

vi.mock("next", () => ({
  default: () => ({ prepare, getRequestHandler: () => () => undefined }),
}));

/** Um segredo de verdade, gerado na hora — nada de literal opaco num arquivo versionado. */
const forte = (): string => randomBytes(32).toString("base64url");

const ENVS_TOCADAS = [
  "AGILEHARNESS_HOST",
  "AGILEHARNESS_PORT",
  "AGILEHARNESS_DEV",
  "AGILEHARNESS_ALLOW_PUBLIC_BIND",
  "NODE_ENV",
  "PORT",
  "STORYMAP_MCP_TOKEN",
  // O @next/env marca este flag em process.env quando processa os arquivos. O worker do vitest é
  // COMPARTILHADO entre arquivos: deixá-lo posto faria o próximo boot PULAR os .env dele.
  "__NEXT_PROCESSED_ENV",
  SESSION_SECRET_ENV,
  TOKEN_ENV,
] as const;

type Main = typeof import("@/server/main");
type Espiao = { mock: { calls: unknown[][] } };

let mod: Main;
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;
const salvo: Record<string, string | undefined> = {};
let cwdOriginal: string;
let dirDoServico: string;
/** O token que o OPERADOR pôs no `.env.local` — o valor que tem de sobreviver ao boot inteiro. */
let tokenDoOperador: string;

async function assentar(): Promise<void> {
  for (let i = 0; i < 200 && exit.mock.calls.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(async () => {
  for (const k of ENVS_TOCADAS) salvo[k] = process.env[k];
  cwdOriginal = process.cwd();

  // `main.ts` lê os .env de `process.cwd()` — o MESMO `dir` que entrega ao Next. Um diretório
  // temporário reproduz a instalação real (token só no arquivo) sem depender do .env.local da
  // máquina de quem roda a suíte.
  dirDoServico = mkdtempSync(path.join(tmpdir(), "ah-boot-env-order-"));
  tokenDoOperador = forte();
  writeFileSync(path.join(dirDoServico, ".env.local"), `STORYMAP_MCP_TOKEN=${tokenDoOperador}\n`, { mode: 0o600 });
  process.chdir(dirDoServico);

  // O CENÁRIO REAL do serviço vivo: loopback, token primário SÓ no arquivo, tudo o mais forte.
  delete process.env.AGILEHARNESS_HOST;
  delete process.env.AGILEHARNESS_DEV;
  delete process.env.AGILEHARNESS_ALLOW_PUBLIC_BIND;
  delete process.env.STORYMAP_MCP_TOKEN;
  delete process.env.__NEXT_PROCESSED_ENV;
  process.env.AGILEHARNESS_PORT = "39118"; // porta improvável: se o boot regredir, não briga com o :3008 vivo
  process.env[TOKEN_ENV] = forte();
  process.env[SESSION_SECRET_ENV] = forte();

  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  mod = (await import("@/server/main")) as Main;
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

describe("boot com o token MCP no .env.local — a credencial de produção não pode ser rotacionada pelo próprio boot", () => {
  it("o token do .env.local é o que fica valendo — o boot NÃO gera outro por cima", () => {
    // Este é o blocker: quando o boot gerava um token por a env estar (ainda) vazia, o valor do
    // operador nunca era aplicado, e a URL do conector morria no primeiro restart.
    expect(process.env.STORYMAP_MCP_TOKEN).toBe(tokenDoOperador);
  });

  it("nada é gravado em storymap/.runner/mcp-token — a porta MCP não se arma sozinha", () => {
    // Geração automática no boot faria TODA instalação nascer com a superfície MCP existindo, numa
    // superfície cujas tools spawnam `claude --dangerously-skip-permissions`.
    const arquivo = path.join(process.env.STORYMAP_RUNNER_STATE_DIR!, "mcp-token");
    expect(existsSync(arquivo)).toBe(false);
  });

  it("a auto-checagem julga o valor EFETIVO — e em loopback o boot segue (zero atrito)", () => {
    // Com os segredos já em env, a auditoria vê o que de fato autentica. `prepare` chamado é a prova
    // de que a auto-checagem NÃO recusa uma instalação local sadia.
    expect(mod.auditBind(process.env).weaknesses).toEqual([]);
    expect(prepare).toHaveBeenCalled();
    expect(saidaDe(warn)).not.toContain("REPROVOU");
    expect(saidaDe(info)).toContain("auto-checagem de credenciais: OK");
  });
});
