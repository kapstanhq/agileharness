// story-7q83gx — os ATAQUES que estes testes descrevem. O endpoint MCP fica na internet pública por
// desenho e as tools dele spawnam `claude --dangerously-skip-permissions`; cada `it` abaixo é uma
// tentativa concreta de chegar até lá, por uma porta diferente:
//
//   1. o adotante INVENTA um segredo memorizável para essa URL (ataque de dicionário/adivinhação);
//   2. a instalação nasce com a porta ARMADA sem ninguém ter pedido — o default sempre-aberto que a
//      geração automática no boot criava, contradizendo a garantia escrita no header da route
//      ("refused outright unless STORYMAP_MCP_TOKEN is set");
//   3. o boot ROTACIONA o token que o operador declarou, matando a autonomia que ele já tinha
//      (a URL do conector vira 404 nu no restart) — remoção de capacidade, o oposto do mandato;
//   4. o token declarado é APROVADO no boot com espaço sobrando e RECUSADO em toda requisição,
//      porque `resolveActor` compara byte-a-byte contra `process.env`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMcpTokenValid, MIN_TOKEN_LEN, secretWeakness } from "./auth";
import {
  generateAndPersistMcpToken,
  generateMcpToken,
  mcpPostureAdvice,
  mcpTokenFile,
  MCP_TOKEN_ENV,
  normalizeMcpTokenEnv,
} from "./token-bootstrap";

let stateDir: string;
let prevStateDir: string | undefined;
let prevToken: string | undefined;

beforeEach(() => {
  prevStateDir = process.env.STORYMAP_RUNNER_STATE_DIR;
  prevToken = process.env[MCP_TOKEN_ENV];
  stateDir = mkdtempSync(path.join(tmpdir(), "ah-mcp-token-"));
  process.env.STORYMAP_RUNNER_STATE_DIR = stateDir;
  delete process.env[MCP_TOKEN_ENV];
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.STORYMAP_RUNNER_STATE_DIR;
  else process.env.STORYMAP_RUNNER_STATE_DIR = prevStateDir;
  if (prevToken === undefined) delete process.env[MCP_TOKEN_ENV];
  else process.env[MCP_TOKEN_ENV] = prevToken;
  vi.restoreAllMocks();
  // POR ÚLTIMO, e sobre a variável (não sobre `mcpTokenFile()`, que já lê a env restaurada): um
  // diretório por teste, 17 por passada, ficava para trás em /tmp. Depois do restore de env e dos
  // mocks porque qualquer escrita pendente ainda aponta para cá — apagar antes trocaria lixo por
  // falha intermitente de escrita.
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ATAQUE: contar com uma porta MCP que se arma sozinha na instalação de outra pessoa", () => {
  it("sem env declarada a superfície fica FECHADA — nada é gerado, nada é gravado", () => {
    const posture = normalizeMcpTokenEnv();

    expect(posture).toEqual({ state: "fechada" });
    // O default é a porta NÃO EXISTIR. Gerar aqui armaria `claude --dangerously-skip-permissions`
    // numa URL pública em toda instalação, inclusive nas que nunca pediram o endpoint.
    expect(process.env[MCP_TOKEN_ENV]).toBeUndefined();
    expect(existsSync(mcpTokenFile())).toBe(false);
  });

  it("um arquivo de token plantado no estado do runner NÃO arma a porta", () => {
    // O arquivo é REGISTRO do que o comando de geração produziu, não interruptor. Se ele armasse a
    // superfície, bastaria plantá-lo (ou herdá-lo de um backup) para a porta voltar a existir sem
    // ninguém declarar nada — o default sempre-armado por outro caminho.
    mkdirSync(path.dirname(mcpTokenFile()), { recursive: true });
    writeFileSync(mcpTokenFile(), `${generateMcpToken()}\n`);

    expect(normalizeMcpTokenEnv()).toEqual({ state: "fechada" });
    expect(process.env[MCP_TOKEN_ENV]).toBeUndefined();
  });

  it("o silêncio da porta fechada é honesto: sem token declarado não há nada a avisar", () => {
    // Ausência não é fraqueza — é uma postura válida. Avisar aqui treinaria o operador a ignorar o
    // aviso que importa (o do token FRACO).
    expect(mcpPostureAdvice(normalizeMcpTokenEnv())).toBeNull();
  });
});

describe("ATAQUE: configurar um segredo memorizável e publicá-lo na internet", () => {
  it("um token com menos de 32 caracteres é RECUSADO, com o motivo e o caminho de saída", () => {
    process.env[MCP_TOKEN_ENV] = "senha-do-storymap-2026"; // 22 chars, digitável e adivinhável

    const posture = normalizeMcpTokenEnv();
    expect(posture).toEqual({ state: "recusada", weakness: "curto" });

    const aviso = mcpPostureAdvice(posture) ?? "";
    expect(aviso).toContain("RECUSADO");
    expect(aviso).toContain("menos de 32 caracteres");
    // Uma recusa sem saída é um bloqueio; a mensagem tem de ensinar o caminho E nomear o efeito.
    expect(aviso).toContain("randomBytes(32)");
    expect(aviso).toContain("--generate-mcp-token");
    expect(aviso).toContain("FECHADA");
  });

  it("recusa 32+ caracteres de baixa entropia (caractere repetido)", () => {
    process.env[MCP_TOKEN_ENV] = "x".repeat(40);
    expect(normalizeMcpTokenEnv().state).toBe("recusada");
  });

  it("recusa 32+ caracteres que são a repetição de um motivo curto", () => {
    process.env[MCP_TOKEN_ENV] = "abcdefgh".repeat(5); // 40 chars, 8 distintos
    expect(normalizeMcpTokenEnv().state).toBe("recusada");
  });

  it("recusar NÃO é substituir: o valor declarado pelo operador continua sendo o dele", () => {
    // Trocar em silêncio o segredo que o operador escreveu quebraria a URL do conector dele sem ele
    // entender por quê — e é o que a geração no boot fazia.
    const fraco = "abcdefgh".repeat(5);
    process.env[MCP_TOKEN_ENV] = fraco;

    normalizeMcpTokenEnv();

    expect(process.env[MCP_TOKEN_ENV]).toBe(fraco);
    expect(existsSync(mcpTokenFile())).toBe(false);
  });

  it("o aviso NUNCA imprime o segredo — só o motivo", () => {
    const fraco = "abcdefgh".repeat(5);
    expect(fraco.length).toBeGreaterThan(MIN_TOKEN_LEN); // comprimento sobra; a força é que falta
    process.env[MCP_TOKEN_ENV] = fraco;

    const aviso = mcpPostureAdvice(normalizeMcpTokenEnv()) ?? "";

    expect(aviso).toContain("RECUSADO");
    expect(aviso).not.toContain(fraco);
  });

  it("um token FORTE vindo da env ARMA a porta sem tocar em disco (12-factor intacto)", () => {
    const forte = generateMcpToken();
    process.env[MCP_TOKEN_ENV] = forte;

    expect(normalizeMcpTokenEnv()).toEqual({ state: "armada", token: forte });
    expect(existsSync(mcpTokenFile())).toBe(false);
    expect(mcpPostureAdvice({ state: "armada", token: forte })).toBeNull();
  });
});

describe("ATAQUE: aprovar no boot um token que nenhuma requisição vai aceitar", () => {
  it("o valor normalizado volta para a env — senão o boot aprova e todo request dá 404", () => {
    // `resolveActor` (api/usm/[secret]/[transport]/route.ts) compara byte-a-byte contra process.env.
    // Um `Environment=` de systemd ou um .env editado à mão que deixe espaço/quebra de linha
    // sobrando era APROVADO aqui (o julgamento usava o valor trimado) e batia 404 em toda
    // requisição, sem log e sem pista. Uma verdade só: o que fica na env é o que autentica.
    const forte = generateMcpToken();
    process.env[MCP_TOKEN_ENV] = `  ${forte}\n`;

    const posture = normalizeMcpTokenEnv();

    expect(posture).toEqual({ state: "armada", token: forte });
    expect(process.env[MCP_TOKEN_ENV]).toBe(forte);
    expect(isMcpTokenValid(forte, process.env[MCP_TOKEN_ENV])).toBe(true);
  });

  it("é idempotente: normalizar de novo não muda nada", () => {
    const forte = generateMcpToken();
    process.env[MCP_TOKEN_ENV] = ` ${forte} `;

    normalizeMcpTokenEnv();
    const segunda = normalizeMcpTokenEnv();

    expect(segunda).toEqual({ state: "armada", token: forte });
    expect(process.env[MCP_TOKEN_ENV]).toBe(forte);
  });
});

describe("o caminho EXPLÍCITO do operador — pedir um token forte em vez de inventar um", () => {
  it("gera 32 bytes base64url e grava a 0600", () => {
    const { token, file } = generateAndPersistMcpToken();

    // 32 bytes em base64url = 43 chars, o mesmo gerador do token do operador.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secretWeakness(token)).toBeNull();
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    // 0600: qualquer outro usuário da máquina lendo o arquivo é a chave da URL pública vazando.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("gerar não ARMA nada por si — quem arma é a env que o operador declara", () => {
    // A separação é o controle: o comando entrega um segredo; a decisão de a porta existir continua
    // sendo um ato do operador, visível no `.env.local`/systemd.
    const { token } = generateAndPersistMcpToken();
    expect(process.env[MCP_TOKEN_ENV]).toBeUndefined();
    expect(normalizeMcpTokenEnv()).toEqual({ state: "fechada" });
    // ...e o que ele entregou é, de fato, credencial válida quando declarado.
    expect(isMcpTokenValid(token, token)).toBe(true);
  });

  it("dois chamados nunca coincidem (é aleatoriedade, não um default de fábrica)", () => {
    expect(generateAndPersistMcpToken().token).not.toBe(generateAndPersistMcpToken().token);
  });

  it("corrige o modo de um arquivo pré-existente folgado", () => {
    // `writeFileSync` só aplica `mode` quando o arquivo NASCE: um 0644 herdado continuaria legível
    // por qualquer usuário da máquina.
    mkdirSync(path.dirname(mcpTokenFile()), { recursive: true });
    writeFileSync(mcpTokenFile(), "antigo\n", { mode: 0o644 });

    generateAndPersistMcpToken();

    expect(statSync(mcpTokenFile()).mode & 0o777).toBe(0o600);
  });
});

describe("defesa em profundidade: o segredo fraco não autentica NEM se o boot for contornado", () => {
  it("um expected degenerado de 40 chars é recusado por requisição", () => {
    // Um processo subido por outro entrypoint (ou com a env injetada depois do boot) nunca passou
    // pela normalização. A régua por request tem de ser a mesma, senão o piso é decorativo.
    const degenerado = "y".repeat(40);
    expect(isMcpTokenValid(degenerado, degenerado)).toBe(false);
  });

  it("um token de 24 chars — o piso ANTIGO — deixou de autenticar", () => {
    const antigo = generateMcpToken().slice(0, 24);
    expect(isMcpTokenValid(antigo, antigo)).toBe(false);
  });
});
