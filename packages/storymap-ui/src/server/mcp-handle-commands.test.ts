// TESTE DE PRODUTOR — o que este arquivo IMPEDE é uma mitigação que só existe no papel.
//
// A onda 2 entregou `createMcpHandle`/`revokeMcpHandle` (lib/auth/mcp-handle.ts) com a manchete
// "revogável na hora, sem restart" — e com ZERO chamador de produção: os únicos eram os próprios
// testes. Efeito líquido para o dono: ao achar um handle vazado no journal do proxy (o dano medido em
// story-u4yf1i — 174 gravações de credencial em texto claro), ele NÃO TINHA COMANDO para tirá-lo do
// ar. A capacidade estava declarada e era inexercível — o mesmo anti-padrão que este repo já pagou
// uma vez ("capacidade DECLARADA com zero produtores").
//
// Por isso os casos abaixo passam pela `main()` REAL, com o argv REAL, em vez de chamar a função
// diretamente: o que precisa ficar provado é a FIAÇÃO. Se alguém remover a linha de dispatch em
// `main()`, renomear uma flag ou trocar a ordem para depois do `prepare()`, isto REPROVA — e a
// primitiva volta a ser código morto sem ninguém perceber.
//
// O que NÃO é testado aqui: a semântica da revogação (mcp-handle.test.ts) e a segurança entre
// processos (mcp-handle-cross-process.test.ts).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_SECRET_ENV, TOKEN_ENV, type EnvLike } from "@/lib/auth/env";
import { mcpHandlesPath, readMcpHandles, resolveMcpCredential } from "@/lib/auth/mcp-handle";

/** O dublê do Next. Um comando de operador NÃO pode preparar o Next nem chegar a um `listen`. */
const prepare = vi.fn(async (): Promise<void> => {
  throw new Error("SENTINELA — prepare() do Next foi chamado");
});

vi.mock("next", () => ({
  default: () => ({ prepare, getRequestHandler: () => () => undefined }),
}));

/** As flags como o operador as digita. Conferidas contra as constantes exportadas nos casos abaixo. */
const EMITIR = "--generate-mcp-handle";
const LISTAR = "--list-mcp-handles";
const REVOGAR = "--revoke-mcp-handle";

const ENVS_TOCADAS = [
  "AGILEHARNESS_HOST",
  "AGILEHARNESS_PORT",
  "AGILEHARNESS_DEV",
  "NODE_ENV",
  "PORT",
  "STORYMAP_MCP_TOKEN",
  "__NEXT_PROCESSED_ENV",
  SESSION_SECRET_ENV,
  TOKEN_ENV,
] as const;

type Main = typeof import("@/server/main");
type Espiao = { mock: { calls: unknown[][] } };

let mod: Main;
let info: ReturnType<typeof vi.spyOn>;
let erro: ReturnType<typeof vi.spyOn>;
const salvo: Record<string, string | undefined> = {};
let argvOriginal: string[];
let prevStateDir: string | undefined;
/** O state dir desta suíte — de módulo para que o afterAll o remova de /tmp. */
let stateDir: string | undefined;
/** O handle que o comando de emissão imprimiu — capturado UMA vez, como o operador o copiaria. */
let handleEmitido: string;

const saidaDe = (spy: Espiao): string =>
  spy.mock.calls.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");

beforeAll(async () => {
  for (const k of ENVS_TOCADAS) salvo[k] = process.env[k];
  argvOriginal = process.argv;
  prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
  stateDir = mkdtempSync(path.join(tmpdir(), "mcp-handle-cmd-"));
  process.env.STORYMAP_RUNNER_STATE_DIR = stateDir;

  delete process.env.AGILEHARNESS_HOST;
  delete process.env.AGILEHARNESS_DEV;
  delete process.env.STORYMAP_MCP_TOKEN;
  delete process.env.__NEXT_PROCESSED_ENV;
  process.env.AGILEHARNESS_PORT = "39131";

  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  erro = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

  // O argv entra ANTES do import: o módulo dispara `main()` no próprio import, e no processo real a
  // flag já está lá desde o primeiro instante. Emitir é a primeira operação porque listar e revogar
  // precisam de um handle existente — e é assim que o operador faz na vida real.
  process.argv = [...argvOriginal, EMITIR, "--level", "full", "--label", "conector do chat web"];
  mod = (await import("@/server/main")) as Main;
  for (let i = 0; i < 200 && (await readMcpHandles()).handles.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const m = /ahk_[0-9a-f]{12}\.[A-Za-z0-9_-]{43}/.exec(saidaDe(info as unknown as Espiao));
  if (!m) throw new Error(`o comando de emissão não imprimiu handle nenhum:\n${saidaDe(info as unknown as Espiao)}`);
  handleEmitido = m[0];
});

afterAll(() => {
  process.argv = argvOriginal;
  for (const k of ENVS_TOCADAS) {
    if (salvo[k] === undefined) delete process.env[k];
    else (process.env as EnvLike)[k] = salvo[k];
  }
  if (prevStateDir === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
  else process.env.STORYMAP_RUNNER_STATE_DIR = prevStateDir;
  vi.restoreAllMocks();
  // No fim de tudo: os comandos já escreveram e leram o que precisavam neste diretório.
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

describe(`node dist/ah-server.mjs ${EMITIR}`, () => {
  it("as flags exercidas aqui são as que o código publica", () => {
    // Sem esta conferência, renomear uma flag deixaria os casos abaixo exercendo um comando que não
    // existe mais — e eles passariam pelo caminho "nada reconhecido", em silêncio.
    expect(mod.GENERATE_MCP_HANDLE_FLAG).toBe(EMITIR);
    expect(mod.LIST_MCP_HANDLES_FLAG).toBe(LISTAR);
    expect(mod.REVOKE_MCP_HANDLE_FLAG).toBe(REVOGAR);
  });

  it("emite um handle que AUTENTICA — a mitigação é exercível pelo operador, não só pelos testes", async () => {
    const res = await resolveMcpCredential(handleEmitido);
    expect(res.ok, "o handle que o comando entregou ao operador não autentica").toBe(true);
    // O nível pedido é o nível concedido: `full` É emissível — contenção não pode custar autonomia.
    expect(res.ok && res.credential.level).toBe("full");
    expect(res.ok && res.credential.via).toBe("handle");
    expect(res.ok && res.credential.label).toBe("conector do chat web");
  });

  it("registra a 0600 e NÃO persiste o valor apresentável", async () => {
    const bruto = readFileSync(mcpHandlesPath(), "utf8");
    expect(bruto.includes(handleEmitido), "o registro virou a própria credencial").toBe(false);
  });

  it("imprime a URL pronta do connector e o comando de revogação — o caminho de rotação sem restart", () => {
    const saida = saidaDe(info as unknown as Espiao);
    expect(saida).toContain(`/api/usm/${handleEmitido}/mcp`);
    expect(saida).toContain(REVOGAR);
    expect(saida).toContain("sem reiniciar o serviço");
  });

  it("o aviso nomeia o canal SEM PORTÃO — não o commit, que já é barrado", () => {
    // O texto anterior avisava "NUNCA o comite" e "log de proxy". MEDIDO: os dois já têm portão (o
    // scan de segredos reconhece a forma do handle e da URL; o log do proxy é redigido na origem).
    // Um aviso apontando para porta fechada gasta a atenção do leitor no instante em que ela mais
    // vale — ele está com a credencial na mão.
    const saida = saidaDe(info as unknown as Espiao);
    expect(saida, "o aviso não menciona o chat com um agente — o canal que nenhum controle alcança").toMatch(
      /chat com um\s+agente|agente ela sai da máquina/,
    );
    expect(saida, "o aviso não menciona o scrollback, que outra sessão lê").toMatch(/scrollback/);
    expect(saida, "o aviso não diz o que fazer quando já vazou").toMatch(/revogue/i);
  });

  it("o aviso NÃO entrega a receita — ele nomeia o canal, nunca a ferramenta que o explora", () => {
    // Este bloco chega ao chat PELO PRÓPRIO ATO que ele adverte, e fica num scrollback que a
    // superfície descrita consegue ler. Nomear a tool e o nível de token aqui seria imprimir o
    // passo-a-passo colado na credencial. É o par do teste acima: um aviso pode ser específico
    // demais, e este é o limite.
    const saida = saidaDe(info as unknown as Espiao);
    for (const receita of ["claude_capture", "claude_sessions", "tmux list-sessions", "session_read"])
      expect(saida, `o aviso nomeia \`${receita}\` — vira instrução de exploração ao lado do segredo`).not.toContain(
        receita,
      );
  });

  it("não sobe o serviço — é um comando, não um boot", () => {
    // Preparar o Next aqui significaria service.lock, watcher e merge train de pé só para emitir uma
    // credencial. E revogar tem de funcionar com o rosto fora do ar.
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe(`node dist/ah-server.mjs ${LISTAR}`, () => {
  it("lista o id público, o nível e as datas — e NUNCA o segredo", async () => {
    const [rec] = (await readMcpHandles()).handles;
    info.mockClear();
    expect(await mod.runMcpHandleCommand([...argvOriginal, LISTAR])).toBe(true);

    const saida = saidaDe(info as unknown as Espiao);
    expect(saida).toContain(rec!.id);
    expect(saida).toContain("full");
    expect(saida).toContain("conector do chat web");
    // O que a listagem não pode entregar: o valor apresentável, a metade secreta dele, e o digest —
    // este texto vai para o scrollback e de lá para handoffs colados em chat.
    expect(saida.includes(handleEmitido)).toBe(false);
    expect(saida.includes(handleEmitido.split(".")[1]!)).toBe(false);
    expect(saida.includes(rec!.digest)).toBe(false);
  });

  it("sem handle nenhum, ensina como emitir em vez de imprimir vazio", async () => {
    const outro = mkdtempSync(path.join(tmpdir(), "mcp-handle-vazio-"));
    const anterior = process.env.STORYMAP_RUNNER_STATE_DIR;
    process.env.STORYMAP_RUNNER_STATE_DIR = outro;
    try {
      info.mockClear();
      expect(await mod.runMcpHandleCommand([...argvOriginal, LISTAR])).toBe(true);
      const saida = saidaDe(info as unknown as Espiao);
      expect(saida).toContain("Nenhum handle MCP emitido");
      expect(saida).toContain(EMITIR);
    } finally {
      process.env.STORYMAP_RUNNER_STATE_DIR = anterior;
      rmSync(outro, { recursive: true, force: true });
    }
  });
});

describe(`node dist/ah-server.mjs ${REVOGAR}`, () => {
  it("revoga por id e o MESMO valor para de autenticar — sem restart", async () => {
    const [rec] = (await readMcpHandles()).handles;
    expect((await resolveMcpCredential(handleEmitido)).ok).toBe(true);

    info.mockClear();
    expect(await mod.runMcpHandleCommand([...argvOriginal, REVOGAR, rec!.id])).toBe(true);
    expect(saidaDe(info as unknown as Espiao)).toContain("REVOGADO");

    const res = await resolveMcpCredential(handleEmitido);
    expect(res.ok, "o comando disse ter revogado e o handle continua autenticando").toBe(false);
    expect(res.ok === false && res.reason).toBe("handle-revogado");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("id inexistente FALHA com código de saída — um script de incidente não pode achar que deu certo", async () => {
    const antes = process.exitCode;
    erro.mockClear();
    try {
      expect(await mod.runMcpHandleCommand([...argvOriginal, REVOGAR, "ffffffffffff"])).toBe(true);
      expect(saidaDe(erro as unknown as Espiao)).toContain("NADA foi revogado");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = antes;
    }
  });

  it("sem id, reclama e não adivinha — nem consome a flag seguinte como id", async () => {
    const antes = process.exitCode;
    erro.mockClear();
    try {
      expect(await mod.runMcpHandleCommand([...argvOriginal, REVOGAR, "--label", "x"])).toBe(true);
      expect(saidaDe(erro as unknown as Espiao)).toContain("exige o id público");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = antes;
    }
  });
});

describe("o nível é uma escolha ESCRITA, nunca um default", () => {
  it(`${EMITIR} sem --level recusa e não emite nada`, async () => {
    const antes = process.exitCode;
    const quantos = (await readMcpHandles()).handles.length;
    erro.mockClear();
    try {
      expect(await mod.runMcpHandleCommand([...argvOriginal, EMITIR])).toBe(true);
      // Um default aqui faria a instalação decidir sozinha QUANTO poder vai para uma URL pública.
      expect(saidaDe(erro as unknown as Espiao)).toContain("--level é OBRIGATÓRIO");
      expect(process.exitCode).toBe(1);
      expect((await readMcpHandles()).handles.length).toBe(quantos);
    } finally {
      process.exitCode = antes;
    }
  });

  it("um nível inventado é recusado — não vira `full` por descuido", async () => {
    const antes = process.exitCode;
    const quantos = (await readMcpHandles()).handles.length;
    erro.mockClear();
    try {
      expect(await mod.runMcpHandleCommand([...argvOriginal, EMITIR, "--level", "root"])).toBe(true);
      expect(saidaDe(erro as unknown as Espiao)).toContain("--level é OBRIGATÓRIO");
      expect((await readMcpHandles()).handles.length).toBe(quantos);
    } finally {
      process.exitCode = antes;
    }
  });
});

describe("sem flag de handle, nada é reconhecido — o boot normal segue intacto", () => {
  it("um argv sem as flags devolve false e não mexe no registro", async () => {
    const antes = readFileSync(mcpHandlesPath(), "utf8");
    expect(await mod.runMcpHandleCommand([...argvOriginal])).toBe(false);
    expect(readFileSync(mcpHandlesPath(), "utf8")).toBe(antes);
  });
});
