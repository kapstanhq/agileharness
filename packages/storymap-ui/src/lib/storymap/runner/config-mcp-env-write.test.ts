// story-6h3ioj (onda 2) — o ATAQUE: quem escreve board-data escolhe QUAL variável do ambiente do
// serviço vivo é sobrescrita.
//
// `normalizeScopedMcpTokenEnv` faz `env[name] = …` num `process.env` que é o do processo que roda como
// root — e o `name` nasce em `settings.yaml` (`mcpTokens[].tokenEnv`), um arquivo de DADOS. A validação
// de forma existia, mas SÓ no leitor (`coerceMcpTokens`): a função que ESCREVE é exportada e aceitava
// qualquer string. Bastava um call-site novo (ou um refactor que resolvesse a env antes de coagir a
// declaração) para o alvo da escrita passar a ser escolhido pelo arquivo — `PATH`, `NODE_OPTIONS`,
// `LD_PRELOAD`, `GIT_SSH_COMMAND` são todos nomes válidos de env var.
//
// A régua destes testes é o ALVO DA ESCRITA, não o valor devolvido: um controle que julga o nome mas
// escreve antes de julgar não protege nada. Nenhum caso toca `process.env` — a função recebe a env por
// parâmetro, e é por isso que dá para exercitar `PATH` de verdade sem envenenar o runner de teste.

import { describe, expect, it, vi } from "vitest";

import { coerceMcpTokens, isMcpTokenEnvName, normalizeScopedMcpTokenEnv } from "./config";
import { generateMcpToken } from "@/lib/storymap/mcp/token-bootstrap";

const FORTE = generateMcpToken();

/** Uma env FALSA com as variáveis que importam para execução de código no serviço. Os valores têm
 *  espaço em volta de propósito: é a diferença entre bruto e normalizado que dispara a escrita. */
function envDeMentira(): Record<string, string> {
  return {
    PATH: " /usr/local/bin:/usr/bin ",
    NODE_OPTIONS: " --require /tmp/evil.js ",
    LD_PRELOAD: " /tmp/evil.so ",
    GIT_SSH_COMMAND: " ssh -o ProxyCommand=/tmp/evil ",
    HOME: " /root ",
    AGILEHARNESS_MCP_TOKEN_ORCH: ` ${FORTE} `,
  };
}

/** Os nomes que dão execução de código quando o processo os relê — o pior caso de uma escrita
 *  escolhida por arquivo de dados. */
const ALVOS_DE_EXECUCAO = ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "GIT_SSH_COMMAND"];

describe("[ATAQUE] settings.yaml não escolhe qual env var do serviço é escrita", () => {
  it("nome de env var ALHEIA: nada é escrito e nada autentica", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const alvo of [...ALVOS_DE_EXECUCAO, "HOME"]) {
      const env = envDeMentira();
      const antes = env[alvo];

      const valor = normalizeScopedMcpTokenEnv(alvo, env as unknown as NodeJS.ProcessEnv);

      expect(valor, `${alvo} não pode virar credencial MCP`).toBeUndefined();
      expect(env[alvo], `${alvo} do ambiente do serviço foi REESCRITO por uma linha de settings.yaml`).toBe(antes);
    }
    vi.restoreAllMocks();
  });

  // ⚠️ Os dois testes que OBSERVAM o aviso usam um nome só deles: o memo anti-flood é por nome e vive no
  // módulo, então um nome já recusado noutro teste chegaria aqui calado (a mesma convenção que
  // config-mcp-tokens.test.ts documenta).
  it("a recusa é AVISADA e diz que nada do ambiente foi tocado", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { LD_PRELOAD_AVISO: " /tmp/evil.so " };

    normalizeScopedMcpTokenEnv("LD_PRELOAD_AVISO", env as unknown as NodeJS.ProcessEnv);

    const msg = warn.mock.calls.flat().join("\n");
    expect(msg).toContain("LD_PRELOAD_AVISO");
    expect(msg).toContain("RECUSADO");
    expect(msg, "o aviso tem de dizer que a env NÃO foi escrita").toMatch(/[Nn]enhuma variável/);
    expect(env.LD_PRELOAD_AVISO).toBe(" /tmp/evil.so ");
    vi.restoreAllMocks();
  });

  it("nome que não é sequer formato de env var (injeção/lixo) também não escreve", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const nome of ["path", "AGILEHARNESS_MCP_TOKEN;rm -rf /", "__proto__", "$PATH", "1_TOKEN", ""]) {
      const env = envDeMentira();
      const chavesAntes = JSON.stringify(env);

      expect(normalizeScopedMcpTokenEnv(nome, env as unknown as NodeJS.ProcessEnv)).toBeUndefined();

      expect(JSON.stringify(env), `o nome "${nome}" mexeu na env`).toBe(chavesAntes);
    }
    vi.restoreAllMocks();
  });

  it("o aviso não repete a cada requisição (o memo da recusa por FORMA tem namespace próprio)", () => {
    // A normalização roda a cada `loadRunnerConfig()`, isto é, a cada requisição do endpoint MCP. Sem o
    // memo — e com o memo colidindo com o da recusa por segredo fraco — o journald recebia uma linha por
    // requisição, e o aviso que importa afogava.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { GIT_SSH_COMMAND_MEMO: " ssh -o ProxyCommand=/tmp/evil " };

    for (let i = 0; i < 5; i++) normalizeScopedMcpTokenEnv("GIT_SSH_COMMAND_MEMO", env as unknown as NodeJS.ProcessEnv);

    expect(warn.mock.calls.filter((c) => c.join(" ").includes("GIT_SSH_COMMAND_MEMO"))).toHaveLength(1);
    vi.restoreAllMocks();
  });
});

describe("o controle não custa capacidade: o tier LEGÍTIMO continua sendo normalizado", () => {
  it("`AGILEHARNESS_MCP_TOKEN_ORCH` sujo é normalizado e a env fica com o valor que AUTENTICA", () => {
    const env = envDeMentira();

    const valor = normalizeScopedMcpTokenEnv("AGILEHARNESS_MCP_TOKEN_ORCH", env as unknown as NodeJS.ProcessEnv);

    expect(valor).toBe(FORTE);
    expect(env.AGILEHARNESS_MCP_TOKEN_ORCH).toBe(FORTE);
  });

  it("qualquer tier novo com o prefixo certo segue valendo — o operador declara quantos quiser", () => {
    const env = { AGILEHARNESS_MCP_TOKEN_QUALQUER_COISA_NOVA: `\t${FORTE}\n` };

    expect(normalizeScopedMcpTokenEnv("AGILEHARNESS_MCP_TOKEN_QUALQUER_COISA_NOVA", env as unknown as NodeJS.ProcessEnv)).toBe(
      FORTE,
    );
    expect(env.AGILEHARNESS_MCP_TOKEN_QUALQUER_COISA_NOVA).toBe(FORTE);
  });
});

describe("leitor e escritor usam UMA régua só — é isso que impede a validação de driftar", () => {
  it("o veredito de `isMcpTokenEnvName` casa com o de `coerceMcpTokens` para todo nome da tabela", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const nomes = [
      "AGILEHARNESS_MCP_TOKEN",
      "AGILEHARNESS_MCP_TOKEN_ORCH",
      "AGILEHARNESS_MCP_TOKEN_RO",
      "AGILEHARNESS_MCP_TOKEN2",
      "PATH",
      "LD_PRELOAD",
      "HOME",
      "storymap_mcp_token_x",
      "AGILEHARNESS_MCP_TOKEN-X",
      "$AGILEHARNESS_MCP_TOKEN",
      "1_TOKEN",
      "MCP_TOKEN_STORYMAP",
    ];

    for (const nome of nomes) {
      const aceitoPeloLeitor = coerceMcpTokens([{ tokenEnv: nome, level: "ro" }]) !== undefined;
      expect(isMcpTokenEnvName(nome), `divergência de veredito para "${nome}"`).toBe(aceitoPeloLeitor);
    }
    vi.restoreAllMocks();
  });
});
