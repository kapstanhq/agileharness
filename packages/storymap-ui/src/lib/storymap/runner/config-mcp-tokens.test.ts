// story-6h3ioj — o ATAQUE: `mcpTokens` do settings.yaml diz QUAL env var segura um token MCP e QUE
// nível de autoridade ele recebe, e `resolveActor` (app/api/mcp/[secret]/[transport]/route.ts)
// devolve o nível declarado. Quem conseguir escrever settings.yaml — um agente com escrita no repo,
// um PR de terceiro num fork OSS, um settings.yaml editado à mão — concedia a si mesmo `full`
// (todas as tools, incluindo shell e deploy) apontando para QUALQUER variável de ambiente, ou
// simplesmente omitindo o campo. Cada `it` abaixo é uma dessas linhas de settings.yaml.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMcpTokenValid } from "@/lib/storymap/mcp/auth";
import { generateMcpToken } from "@/lib/storymap/mcp/token-bootstrap";
import { applyEnvOverrides, coerceMcpTokens, DEFAULT_RUNNER_SETTINGS, mcpTokensBackedBySecret } from "./config";
import type { McpLevel, RunnerSettings } from "@/lib/storymap/types";

/** A config EFETIVA (arquivo + ENV) que a route.ts lê por requisição, para uma lista declarada. */
function efetiva(declarados: { tokenEnv: string; level: McpLevel }[] | undefined): RunnerSettings {
  return applyEnvOverrides({ ...DEFAULT_RUNNER_SETTINGS, mcpTokens: declarados });
}

const FORTE = generateMcpToken();
const OUTRO_FORTE = generateMcpToken();
const postas: string[] = [];

function setEnv(name: string, value: string): void {
  process.env[name] = value;
  postas.push(name);
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const name of postas.splice(0)) delete process.env[name];
  vi.restoreAllMocks();
});

describe("ATAQUE: escalar para `full` sem declarar nível", () => {
  it("entrada SEM level não recebe full — cai no menos privilegiado", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_X", FORTE);

    const out = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_X" }]);

    expect(out).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_X", level: "ro" }]);
  });

  it("level fora do conjunto conhecido (root/admin/1/null) não recebe full", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_X", FORTE);

    for (const level of ["root", "admin", "FULL", 1, null, true, ["full"]]) {
      const out = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_X", level }]);
      expect(out).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_X", level: "ro" }]);
    }
  });

  it("o rebaixamento é AVISADO, não silencioso (o operador precisa descobrir o typo)", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_X", FORTE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_X", level: "orq" }]);

    const msg = warn.mock.calls.flat().join("\n");
    expect(msg).toContain("AGILEHARNESS_MCP_TOKEN_X");
    expect(msg).toContain("ro");
  });

  it("`full` DECLARADO por extenso continua concedido — o controle fecha a omissão, não a autonomia", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_FULL2", FORTE);

    const out = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_FULL2", level: "full" }]);

    expect(out).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_FULL2", level: "full" }]);
  });
});

describe("ATAQUE: apontar tokenEnv para uma variável de ambiente ALHEIA", () => {
  it("recusa uma env var que não é um token MCP, mesmo com valor forte presente", () => {
    // O caso concreto: variáveis que o atacante JÁ conhece ou consegue adivinhar (o hostname da
    // VPS, o usuário, um token de outro serviço). Sem a allowlist, qualquer uma virava a chave de
    // um endpoint público que monta tools que executam código nesta máquina.
    // (nomes fabricados de propósito: sobrescrever PATH/USER de verdade envenenaria o processo do
    // vitest — a forma do nome é o que a allowlist julga, não a existência da variável)
    for (const alheia of ["HOSTNAME_ALVO", "GITHUB_TOKEN_ALVO", "DATABASE_URL_ALVO", "MY_SECRET"]) {
      setEnv(alheia, FORTE);
      const out = coerceMcpTokens([{ tokenEnv: alheia, level: "full" }]);
      expect(out).toBeUndefined();
    }
  });

  it("recusa nome que não é sequer formato de env var (injeção/lixo)", () => {
    for (const nome of ["storymap_mcp_token_x", "AGILEHARNESS_MCP_TOKEN-X", "$AGILEHARNESS_MCP_TOKEN", "1_TOKEN"]) {
      expect(coerceMcpTokens([{ tokenEnv: nome, level: "ro" }])).toBeUndefined();
    }
  });

  it("a recusa NOMEIA a entrada em vez de sumir com ela", () => {
    setEnv("HOSTNAME_FAKE", FORTE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    coerceMcpTokens([{ tokenEnv: "HOSTNAME_FAKE", level: "full" }]);

    const msg = warn.mock.calls.flat().join("\n");
    expect(msg).toContain("HOSTNAME_FAKE");
    expect(msg).toContain("RECUSADA");
    expect(msg).not.toContain(FORTE);
  });

  it("preserva as entradas legítimas mesmo quando uma alheia vem no meio", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_ORCH", FORTE);
    setEnv("HOME_FAKE", OUTRO_FORTE);

    const out = coerceMcpTokens([
      { tokenEnv: "HOME_FAKE", level: "full" },
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" },
    ]);

    expect(out).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" }]);
  });
});

// A recusa por VALOR é medida na config EFETIVA (`applyEnvOverrides`, a camada que a route.ts lê a
// cada requisição), não na coerção do arquivo: é lá que o piso passou a ser aplicado. Cada `it` abaixo
// continua sendo uma linha de settings.yaml — o que mudou é QUANDO o segredo é julgado, não SE.
// ⚠️ O log de recusa é memoizado por (tokenEnv, fraqueza, comprimento) para não inundar o journald a
// cada requisição — um teste que queira VER o aviso precisa de um nome de env var só dele.
describe("ATAQUE: conceder autoridade contra um segredo que não existe ou é adivinhável", () => {
  it("recusa a entrada quando a env var declarada está AUSENTE do ambiente", () => {
    // Uma credencial fantasma prometia um nível que nada segura — e escondia o erro de deploy
    // (a env var que ninguém setou) atrás de um 404 silencioso.
    const declarados = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_INEXISTENTE", level: "orch" }]);
    expect(efetiva(declarados).mcpTokens).toBeUndefined();
  });

  it("recusa a entrada quando a env var está vazia/em branco", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_VAZIO", "   ");
    const declarados = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_VAZIO", level: "write" }]);
    expect(efetiva(declarados).mcpTokens).toBeUndefined();
  });

  it("recusa um segredo curto (o piso antigo de 24) com o MOTIVO no log", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_CURTO", FORTE.slice(0, 24));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(mcpTokensBackedBySecret([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_CURTO", level: "orch" }])).toBeUndefined();

    const msg = warn.mock.calls.flat().join("\n");
    expect(msg).toContain("AGILEHARNESS_MCP_TOKEN_CURTO");
    expect(msg).toMatch(/menos de 32 caracteres/);
    // O log de recusa não pode ser o vazamento do segredo que ele está recusando.
    expect(msg).not.toContain(FORTE.slice(0, 24));
    expect(msg).toContain("<oculto: 24 chars>");
  });

  it("recusa um segredo longo mas degenerado (caractere repetido)", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_FRACO", "z".repeat(48));
    const declarados = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_FRACO", level: "ro" }]);
    expect(efetiva(declarados).mcpTokens).toBeUndefined();
  });

  it("não avisa a MESMA fraqueza a cada leitura (o log de recusa não pode inundar o journald)", () => {
    // A recusa roda por REQUISIÇÃO agora. Se ela falasse toda vez, o aviso que o operador precisa
    // ler viraria ruído — e ruído é a forma mais comum de um controle de segurança ser ignorado.
    setEnv("AGILEHARNESS_MCP_TOKEN_REPETE", "y".repeat(40));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entrada = [{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_REPETE", level: "ro" as const }];

    for (let i = 0; i < 5; i++) expect(mcpTokensBackedBySecret(entrada)).toBeUndefined();

    expect(warn.mock.calls.filter((c) => c.join(" ").includes("AGILEHARNESS_MCP_TOKEN_REPETE"))).toHaveLength(1);
  });

  it("a config REAL do repo continua valendo: token forte + level declarado sobrevive intacto", () => {
    // A régua de "não tirar capacidade": o que o settings.yaml declara hoje (orch + ro) tem de
    // atravessar a coerção com o nível DECLARADO, senão o hardening virou perda de autonomia.
    setEnv("AGILEHARNESS_MCP_TOKEN_ORCH", FORTE);
    setEnv("AGILEHARNESS_MCP_TOKEN_RO", OUTRO_FORTE);

    const declarados = coerceMcpTokens([
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" },
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_RO", level: "ro" },
    ]);

    expect(declarados).toEqual([
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" },
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_RO", level: "ro" },
    ]);
    expect(efetiva(declarados).mcpTokens).toEqual([
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" },
      { tokenEnv: "AGILEHARNESS_MCP_TOKEN_RO", level: "ro" },
    ]);
  });
});

// O "ATAQUE" aqui não tem adversário: é a ORDEM DE BOOT — e o dano é PERDA DE CAPACIDADE, o que o
// mandato do projeto proíbe explicitamente. A primeira versão deste hardening lia o VALOR da env
// dentro de `coerceMcpTokens`, cujo resultado é memoizado por mtime do settings.yaml
// (`readFileSettings`: `cache = { mtimeMs, settings }`, com retorno antecipado quando o mtime bate).
// Consequência: se a env do token não estivesse posta no PRIMEIRO load — unidade systemd que sobe
// antes do EnvironmentFile, secret manager que injeta tarde, `docker run` sem `--env-file` — a
// credencial válida que chegasse depois só reaparecia quando alguém TOCASSE o arquivo. O sintoma
// seria um 404 do MCP sem causa aparente: o orquestrador autônomo perdendo a porta de entrada.
describe("ARMADILHA DE BOOT: credencial válida que chega DEPOIS do primeiro load", () => {
  it("passa a autenticar sem tocar o settings.yaml", () => {
    // 1) O load acontece com a env AUSENTE. A FORMA (nome + level) é declarativa e sobrevive —
    //    é só isso que o cache por mtime tem direito de congelar.
    const doArquivo = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_TARDE", level: "write" }]);
    expect(doArquivo).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_TARDE", level: "write" }]);
    // ...e, sem segredo, nada autentica: a config efetiva não expõe a entrada (fail-closed).
    expect(efetiva(doArquivo).mcpTokens).toBeUndefined();

    // 2) A env chega. O settings.yaml NÃO mudou — o cache por mtime devolve o MESMO objeto de arquivo.
    setEnv("AGILEHARNESS_MCP_TOKEN_TARDE", FORTE);

    // 3) A credencial existe na leitura seguinte, com o nível DECLARADO, sem `touch` em nada.
    expect(efetiva(doArquivo).mcpTokens).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_TARDE", level: "write" }]);
  });

  it("um segredo TROCADO por um fraco volta a ser recusado na leitura seguinte (a régua vale nos dois sentidos)", () => {
    const entrada = [{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_ROTATE", level: "orch" as const }];
    setEnv("AGILEHARNESS_MCP_TOKEN_ROTATE", FORTE);
    expect(efetiva(entrada).mcpTokens).toEqual(entrada);

    // Rotação malfeita (o operador colou um valor curto): a autoridade cai na MESMA leitura seguinte,
    // sem esperar edição de arquivo nem restart — o inverso exato do caso acima.
    setEnv("AGILEHARNESS_MCP_TOKEN_ROTATE", "curto");
    expect(efetiva(entrada).mcpTokens).toBeUndefined();
  });

  it("a entrada devolvida é CÓPIA: a camada ENV não muta o objeto memoizado do arquivo", () => {
    // O objeto do arquivo é compartilhado por todas as requisições (é o cache). Devolver a mesma
    // referência deixaria um consumidor descuidado corromper a config de todos os outros.
    setEnv("AGILEHARNESS_MCP_TOKEN_COPIA", FORTE);
    const doArquivo = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_COPIA", level: "write" }])!;

    const efetivos = efetiva(doArquivo).mcpTokens!;
    efetivos[0].level = "full";

    expect(doArquivo[0].level).toBe("write");
  });
});

// O "ATAQUE" aqui também não tem adversário — é PERDA DE CAPACIDADE, e a mais cruel: a credencial
// aparece APROVADA na config (e no cockpit) e devolve 404 em TODA requisição, sem uma linha de log.
// O mecanismo: `secretWeakness` julga o valor TRIMADO (aprova) e `isMcpTokenValid` compara o valor CRU
// byte-a-byte (recusa por 1 byte de diferença de comprimento). Um `Environment=` de systemd, um
// `.env.local` editado à mão ou um secret manager que injeta com `\n` produzem exatamente isso — foi
// o modo de falha que `normalizeMcpTokenEnv` consertou para o token PRIMÁRIO e que os tiers ESCOPADOS
// (`_ORCH`, `_RO`, e qualquer `mcpTokens[].tokenEnv` declarado) ainda tinham.
describe("PERDA DE CAPACIDADE: espaço sobrando na env do tier ESCOPADO", () => {
  /**
   * O que a route.ts faz por requisição (`app/api/mcp/[secret]/[transport]/route.ts:46-47`): resolve a
   * config EFETIVA e SÓ DEPOIS compara byte-a-byte contra `process.env`. A ordem é o que dá à camada
   * ENV a chance de normalizar antes de alguém comparar — reproduzida aqui para o teste medir o
   * desfecho REAL (autentica ou 404), não a forma da config.
   */
  function resolveActor(apresentado: string, cfg: RunnerSettings): { level: McpLevel; tokenEnv: string } | null {
    for (const t of cfg.mcpTokens ?? []) {
      if (isMcpTokenValid(apresentado, process.env[t.tokenEnv])) return { level: t.level, tokenEnv: t.tokenEnv };
    }
    return null;
  }

  it("token com `\\n` no fim AUTENTICA — a credencial não fica aprovada-mas-inútil", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_SUJO", `${FORTE}\n`);
    const declarados = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_SUJO", level: "orch" }]);

    const cfg = efetiva(declarados);
    expect(cfg.mcpTokens).toEqual([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_SUJO", level: "orch" }]);
    // O agente apresenta o valor TRIMADO — é o que `orchestrator-run.ts`/`session-spawn.ts` põem na URL
    // do MCP (`process.env.X?.trim()`). Sem a normalização os dois lados divergem em 1 byte.
    expect(resolveActor(FORTE, cfg)).toEqual({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_SUJO" });
  });

  it("os DOIS tiers reais do repo (`_ORCH` e `_RO`) atravessam com espaço em volta, cada um no seu nível", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_ORCH", ` ${FORTE} `);
    setEnv("AGILEHARNESS_MCP_TOKEN_RO", `\t${OUTRO_FORTE}\n`);
    const cfg = efetiva(
      coerceMcpTokens([
        { tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH", level: "orch" },
        { tokenEnv: "AGILEHARNESS_MCP_TOKEN_RO", level: "ro" },
      ]),
    );

    expect(resolveActor(FORTE, cfg)).toEqual({ level: "orch", tokenEnv: "AGILEHARNESS_MCP_TOKEN_ORCH" });
    expect(resolveActor(OUTRO_FORTE, cfg)).toEqual({ level: "ro", tokenEnv: "AGILEHARNESS_MCP_TOKEN_RO" });
  });

  it("a env fica com o valor que AUTENTICA — uma verdade só, como no token primário", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_ESPACO", `  ${FORTE}  `);

    efetiva(coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_ESPACO", level: "ro" }]));

    expect(process.env.AGILEHARNESS_MCP_TOKEN_ESPACO).toBe(FORTE);
  });

  it("normalizar NÃO é afrouxar: só-espaço segue recusado", () => {
    setEnv("AGILEHARNESS_MCP_TOKEN_BRANCO", "   ");
    const declarados = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_BRANCO", level: "full" }]);
    expect(efetiva(declarados).mcpTokens).toBeUndefined();
  });

  it("normalizar NÃO é afrouxar: um segredo que só alcança 32 chars COM o padding segue curto", () => {
    // A armadilha do trim mal-feito: `"  " + 30 chars + "  "` tem 34 bytes crus e passaria um piso
    // medido sobre o valor sujo. O piso continua sendo medido sobre o valor NORMALIZADO.
    setEnv("AGILEHARNESS_MCP_TOKEN_CURTINHO", `  ${FORTE.slice(0, 30)}  `);
    const declarados = coerceMcpTokens([{ tokenEnv: "AGILEHARNESS_MCP_TOKEN_CURTINHO", level: "orch" }]);
    expect(efetiva(declarados).mcpTokens).toBeUndefined();
  });
});
