// Testes de ATAQUE ao scan de segredos (story-ex0065). O que se descreve aqui é o vazamento, não a
// implementação: cada caso é uma forma em que uma credencial entra no repositório e passava batido.
//
// Por que este arquivo mora aqui e não ao lado do script: `scan-secrets.mjs` é um script de raiz, e a
// ÚNICA suíte que o cobre é a do storymap-ui (`vitest.config.ts` inclui só `src/**/*.test.ts`). Posto ao lado
// do script, nenhum gate o rodaria — e um teste que nunca roda não prova nada.
//
// As DUAS cegueiras medidas no card:
//   Forma 1 — `PREFIXO_API_KEY`: o `\b` da regra de keyword nunca casa depois de `_`, então
//             `LLM_GATEWAY_API_KEY=…` era invisível. Num arquivo de config típico, só as credenciais
//             com prefixo próprio do provedor (`AIza…`, `sk-or-v1-…`) eram pegas — as demais passavam.
//   Forma 2 — o token NU do próprio produto (`AGILEHARNESS_MCP_TOKEN`): sem palavra-chave e sem aspas,
//             nenhuma regra o via — nem em crase, nem em URL, nem em bloco de código.
//
// Todos os valores abaixo são SINTÉTICOS: o SHAPE de credenciais de provedores, nenhum byte real. Eles
// são propositalmente marker-less (sem `example`/`fake`/`mock`), porque um valor com marcador é
// dispensado por desenho — usar um aqui tornaria o teste incapaz de detectar a regressão.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describePosix } from "./test-platform";
// O scanner é um script compartilhado da raiz (o mesmo que o pre-commit, o merge train e o release chamam).
import {
  CAPABILITIES_LINE,
  CLAUDE_SESSION_TRAILER,
  EMPTY_TREE,
  looksLikeIdentifier,
  parseMessageLog,
  runScan,
} from "../../../../../../scripts/git-hooks/scan-secrets.mjs";

/** Monta um diff unificado de UMA linha adicionada em `file` — o formato que o scanner consome. */
function addedLine(file: string, line: string): string {
  return [`+++ b/${file}`, "@@ -0,0 +1 @@", `+${line}`].join("\n");
}

/** Roda o scan sobre um diff sintético (git falso, sem repo). `env: {}` = nenhum bypass herdado. */
function scanLine(file: string, line: string, env: Record<string, string | undefined> = {}) {
  const diff = addedLine(file, line);
  const git = (args: string[]) => (args.includes("--name-only") ? "" : diff);
  return runScan({ argv: ["--staged"], git, env });
}

const BLOCKED = 2;

// ---------------------------------------------------------------------------------------------
// Forma 1 — 5 credenciais de um arquivo de produção INVENTADO (um viveiro de mudas), em valores sintéticos.
// Os nomes têm a forma que importa: é o `PREFIXO_` antes da palavra de credencial que cegava a regra; valores falsos.
// ---------------------------------------------------------------------------------------------
// prettier-ignore
const PRODUCTION_SHAPES: Array<[name: string, syntheticValue: string]> = [
  ["ASSINATURA_WEBHOOK_SECRET", "whsec" + "_" + "Bv7NxK3RtWm9ZcLq5HdYs2JpGa8UfE4o"], // pragma: allowlist secret
  ["ESTUFA_SENSORES_API_KEY",   "5e4fc4fb9347e9b0554fffd145b2e393"], // pragma: allowlist secret
  ["REPO_DEPLOY_TOKEN",         "ghp" + "_" + "gkQqBtSXHiL2wu8NSAnLUKN8ErNdtPTAKwLx"], // pragma: allowlist secret
  ["AVISOS_EMAIL_API_KEY",      "SG" + "." + "AqPCQtNzWB5ib6NpgTQ8EQ" + "." + "UByQmvCLNL5jzjQaYi9X9uVKqKNiQy34rh4tTMyBKdM"], // pragma: allowlist secret
  ["VIVEIRO_DB_PASSWORD",       "wjaacBYjKZgSDbSEPXZJLMjdSiQ"], // pragma: allowlist secret
];

describe("scan-secrets — as 5 credenciais de um arquivo de produção (forma PREFIXO_<credencial>)", () => {
  it.each(PRODUCTION_SHAPES)(
    "%s em YAML com aspas (o arquivo de produção) é BLOQUEADO",
    (name, value) => {
      const res = scanLine("packages/viveiro/deploy/config/producao.env.yaml", `${name}: "${value}"`);
      expect(res.code).toBe(BLOCKED);
    },
  );

  it.each(PRODUCTION_SHAPES)("%s em YAML/dotenv SEM aspas é BLOQUEADO", (name, value) => {
    const res = scanLine("deploy/env.yaml", `${name}: ${value}`);
    expect(res.code).toBe(BLOCKED);
  });

  it.each(PRODUCTION_SHAPES)("%s como export de shell (`NOME=valor`) é BLOQUEADO", (name, value) => {
    const res = scanLine("ops/env.sh", `export ${name}=${value}`);
    expect(res.code).toBe(BLOCKED);
  });

  // A aspa que fecha a CHAVE em JSON ficava entre a palavra-chave e o `:` — nenhuma das duas regras
  // chegava ao valor. É o formato de package.json / appsettings.json / firebase config.
  it.each(PRODUCTION_SHAPES)("%s num config JSON (chave entre aspas) é BLOQUEADO", (name, value) => {
    expect(scanLine("app/config.json", `  "${name}": "${value}",`).code).toBe(BLOCKED);
  });

  it("`\"apiKey\": \"<valor>\"` em JSON é BLOQUEADO (a chave entre aspas não é mais um buraco)", () => {
    const res = scanLine("app/config.json", '  "apiKey": "Kq7Vt2ZmXbNr9LpHc4WsGyDf6JuAe1Rk3TnQiOb5vZM",'); // pragma: allowlist secret
    expect(res.code).toBe(BLOCKED);
  });

  it("as 5 formas são pegas — nenhuma passa (antes só as de prefixo próprio do provedor eram)", () => {
    const passaram = PRODUCTION_SHAPES.filter(
      ([name, value]) => scanLine("deploy/env.yaml", `${name}: "${value}"`).code === 0,
    ).map(([name]) => name);
    expect(passaram).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Forma 1b — o hífen que matava o prefixo `sk-`: `sk-proj-…` (a chave que a OpenAI emite hoje).
// ---------------------------------------------------------------------------------------------
describe("scan-secrets — chave OpenAI com segmentos hifenizados (sk-proj-…)", () => {
  it("bloqueia um `sk-proj-…` mesmo SEM nome de variável nenhum (só o literal na linha)", () => {
    const res = scanLine(
      "packages/acmeapp/api/src/llm.ts",
      "  const client = new OpenAI({ apiKey: 'sk-proj-Wn4Kq7bVtZm2XrNc9LpHsGyDf6JuAe1Rk3TnQiOb5vZMdCw_9pLqW3sHmTbNzKrVfEyDu7A' });", // pragma: allowlist secret
    );
    expect(res.code).toBe(BLOCKED);
    expect(res.findings?.some((f) => f.rule === "openai-key")).toBe(true);
  });

  it("um identificador kebab-case que começa com `sk-` NÃO é confundido com chave (skeleton CSS)", () => {
    // Precisão: aceitar hífen no prefixo não pode transformar toda classe `sk-*` longa em achado.
    const res = scanLine("packages/exemplo/web/src/ui/skeleton.css", ".sk-card-title-loading-row-wide-variant { opacity: 0.4 }");
    expect(res.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Forma 2 — o token NU do próprio produto. É o segredo mais perigoso do repositório: quem o tem
// fala com o MCP do AgileHarness como Operador. Nenhuma destas formas tem palavra-chave nem aspas.
// ---------------------------------------------------------------------------------------------
// 43 chars, base64url — o MESMO shape do token vivo, valor inventado.
const OPERATOR_TOKEN = "Kq7Vt2ZmXbNr9LpHc4WsGyDf6JuAe1Rk3TnQiOb5vZM"; // pragma: allowlist secret

describe("scan-secrets — o token do PRÓPRIO produto vazando nu", () => {
  const withToken = { AGILEHARNESS_MCP_TOKEN: OPERATOR_TOKEN };

  // As 6 formas reproduzidas no card, todas com o valor LITERAL do token do ambiente.
  const FORMAS: Array<[string, string]> = [
    ["atribuído por nome", `AGILEHARNESS_MCP_TOKEN=${OPERATOR_TOKEN}`],
    ["em negrito num doc", `**Operator token:** \`${OPERATOR_TOKEN}\``],
    ["numa linha de bloco de código", `  ${OPERATOR_TOKEN}`],
    ["num path de URL", `curl https://ah.example.dev/api/mcp/${OPERATOR_TOKEN}/mcp`],
    ["num parâmetro de query", `curl 'https://ah.example.dev/api/mcp/mcp?secret=${OPERATOR_TOKEN}'`],
    ["nos args JSON do mcp-remote", `{ "args": ["mcp-remote", "https://ah.example.dev/api/mcp/mcp", "--header", "${OPERATOR_TOKEN}"] }`],
  ];

  it.each(FORMAS)("o valor literal do token %s é BLOQUEADO", (_forma, line) => {
    const res = scanLine("docs/operacao/onboarding.md", line, withToken);
    expect(res.code).toBe(BLOCKED);
  });

  it("nomeia a variável no achado, sem imprimir o valor do token", () => {
    const res = scanLine("README.md", `token: ${OPERATOR_TOKEN}`, withToken);
    const finding = res.findings?.find((f) => f.rule === "self-secret-literal");
    expect(finding).toBeTruthy();
    expect(finding?.preview).toContain("AGILEHARNESS_MCP_TOKEN");
    // um scanner que ecoa o segredo no stderr (log de CI, journal do train) vaza o que veio bloquear
    expect(finding?.preview).not.toContain(OPERATOR_TOKEN);
  });

  it("um token de alta entropia em crase é pego mesmo sem o valor no ambiente (por FORMA)", () => {
    // A checagem por literal só funciona para quem TEM o valor no ambiente. A régua por forma é a
    // que protege o repositório publicado, onde o token de quem commita não é o token vazado.
    const res = scanLine("docs/operacao/onboarding.md", `Use \`Xt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk3TnQiOb\` no header`); // pragma: allowlist secret
    expect(res.code).toBe(BLOCKED);
    expect(res.findings?.some((f) => f.rule === "naked-high-entropy-token")).toBe(true);
  });

  it("um token de alta entropia num path de URL é pego por FORMA", () => {
    const res = scanLine("docs/operacao/onboarding.md", "curl https://ah.example.dev/api/mcp/Xt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk3TnQiOb/mcp"); // pragma: allowlist secret
    expect(res.code).toBe(BLOCKED);
    expect(res.findings?.some((f) => f.rule === "naked-high-entropy-token")).toBe(true);
  });

  // O FALSO POSITIVO que punha cards em quarentena: nomes longos de função em crase na prosa. A régua mede a
  // ESTRUTURA (palavras de verdade × bytes aleatórios), não o lugar — nenhuma pasta fica isenta.
  describe("identificador composto de palavras não é credencial", () => {
    const IDENTIFICADORES = [
      "recalcularJanelasColetaNoturnoDaLavanderiaV3Handler",
      "recalculateShippingQuotesNightlyForOrdersJob4",
      "handleOwnerApprovalRequestForDeployUnitsV2",
      "ShelfIndexBuilder-rebuild-after-import-Step2",
      "importBooksFromSupplierSheetForCatalogJob3",
    ];
    it.each(IDENTIFICADORES)("`%s` em crase na prosa de um card PASSA", (id) => {
      expect(looksLikeIdentifier(id)).toBe(true);
      const res = scanLine("storymap/boards/store/cards/story-ex0001.md", `A function \`${id}\` é chamada pelo agendador.`);
      expect(res.findings?.some((f) => f.rule === "naked-high-entropy-token") ?? false).toBe(false);
    });

    it("o mesmo identificador num path de URL ou sozinho numa linha também passa", () => {
      for (const line of [`https://console.example.dev/functions/${IDENTIFICADORES[0]}/logs`, `  ${IDENTIFICADORES[1]}`]) {
        const res = scanLine("docs/operacao/funcoes.md", line);
        expect(res.findings?.some((f) => f.rule === "naked-high-entropy-token") ?? false, line).toBe(false);
      }
    });

    // Todos SINTÉTICOS, com a forma de credencial: nenhum deles pode ganhar carona na regra nova.
    const CREDENCIAIS = [
      ["aleatório puro", "Xt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk3TnQiOb"], // pragma: allowlist secret
      ["prefixo legível + cauda aleatória", "app_main_Xt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk"], // pragma: allowlist secret
      ["aleatório fatiado por separadores", "Xt4B-q9Wn_PmLc-7ZrV_s2Hk-DyGf_5JuA-e1Rk3"], // pragma: allowlist secret
      ["palavras reais + bloco aleatório no fim", "deploy_service_account_Kq7Vt2ZmXbNr9LpHc4WsGy"], // pragma: allowlist secret
      ["consoantes sem vogal em «palavras» longas", "Xkcd_Qwrt_Zxcv_Bnmp_Lkjh_Gfds_Mnbv_Plkj1"], // pragma: allowlist secret
      ["dígitos demais para um nome", "release_build_20260315_123456_987654_ab12"], // pragma: allowlist secret
    ] as const;
    it.each(CREDENCIAIS)("%s NÃO é tratado como identificador", (_forma, tok) => {
      expect(looksLikeIdentifier(tok)).toBe(false);
    });

    it("…e o token aleatório em crase num card segue BLOQUEADO (a régua não ganhou pasta isenta)", () => {
      const res = scanLine("storymap/boards/store/cards/story-ex0001.md", `Use \`${CREDENCIAIS[0][1]}\` no header`);
      expect(res.code).toBe(BLOCKED);
      expect(res.findings?.some((f) => f.rule === "naked-high-entropy-token")).toBe(true);
      const prefixed = scanLine("storymap/boards/store/cards/story-ex0001.md", `chave: \`${CREDENCIAIS[1][1]}\``);
      expect(prefixed.code).toBe(BLOCKED);
    });
  });

  it("o nome da variável do produto sozinho já bloqueia (AGILEHARNESS_MCP_TOKEN=<valor opaco>)", () => {
    const res = scanLine(".env.production", "AGILEHARNESS_MCP_TOKEN=Xt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk3TnQiOb"); // pragma: allowlist secret
    expect(res.code).toBe(BLOCKED);
  });

  it("um pragma na linha NÃO desculpa o valor literal do token do produto", () => {
    // O pragma é válvula para falso-positivo de heurística. Um casamento literal com o valor que está
    // no ambiente não é heurística — e se um comentário de uma linha o liberasse, o segredo mais
    // perigoso do repositório sairia com o esforço de escrever um comentário.
    const res = scanLine("docs/operacao/onboarding.md", `token: ${OPERATOR_TOKEN} # pragma: allowlist secret`, withToken);
    expect(res.code).toBe(BLOCKED);
    expect(res.findings?.map((f) => f.rule)).toEqual(["self-secret-literal"]);
  });
});

// ---------------------------------------------------------------------------------------------
// PRECISÃO — o que a regra nova NÃO pode passar a bloquear. Um gate que reprova commit legítimo é
// desligado pelo time em uma semana, e aí protege zero.
// ---------------------------------------------------------------------------------------------
describe("scan-secrets — precisão das regras novas", () => {
  it("um sha de git em crase não é achado", () => {
    expect(scanLine("docs/notas-de-operacao.md", "o fix veio em `7d21c5e8b04f9a36d1e2c78b50a49f3e6d8c1b27`").code).toBe(0);
  });

  it("um UUID de sessão em crase/URL não é achado (o repo é cheio deles)", () => {
    expect(scanLine("docs/notas/nota-0007.md", "o worktree `agent-2c9e71a4-5d38-4b6f-9a10-e47f03bd82c5` é efêmero").code).toBe(0);
    expect(scanLine("docs/notas/nota-0007.md", "GET /api/mcp/session/2c9e71a4-5d38-4b6f-9a10-e47f03bd82c5/status").code).toBe(0);
  });

  it("um identificador SCREAMING_SNAKE longo em crase não é achado", () => {
    expect(scanLine("docs/guides/env.md", "a flag `AGILEHARNESS_AUTORUN_PUBLISH_QUEUE_ENABLED` liga a fila").code).toBe(0);
  });

  it("um path de arquivo comprido em crase/URL não é achado", () => {
    expect(scanLine("docs/guides/env.md", "veja `packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts`").code).toBe(0);
  });

  it("`.env.example` com placeholder segue passando", () => {
    expect(scanLine(".env.example", "LLM_GATEWAY_API_KEY=your-key-here").code).toBe(0);
    expect(scanLine(".env.example", "AGILEHARNESS_MCP_TOKEN=<gere-com-openssl-rand>").code).toBe(0);
  });

  it("valor com marcador explícito de fixture segue dispensado, com ou sem aspas", () => {
    expect(scanLine("tests/fixtures/env.yaml", 'LLM_GATEWAY_API_KEY: "sk-proj-EXAMPLE-Kq7Vt2ZmXbNr9LpHc4WsGyDf6Ju"').code).toBe(0);
    expect(scanLine("tests/fixtures/env.yaml", "CLIMA_API_KEY: 1a2fa390b34635b9mock19bc32e870db").code).toBe(0);
  });

  it("uma referência a variável de ambiente (não o valor) segue passando", () => {
    expect(scanLine("packages/acmeapp/api/src/llm.ts", "  const apiKey = process.env.OPENAI_API_KEY;").code).toBe(0);
    expect(scanLine("deploy/env.yaml", "LLM_GATEWAY_API_KEY: ${LLM_GATEWAY_API_KEY}").code).toBe(0);
  });

  it("um valor de configuração kebab-case num nome *_KEY não é achado", () => {
    expect(scanLine("packages/exemplo/web/src/cache.ts", 'CACHE_KEY = "user-profile-avatar-cache-v2"').code).toBe(0);
  });

  // Estes casos são CLASSES de falso-positivo que a regra nova teve quando ficou frouxa demais (dezenas de achados numa
  // varredura de árvore inteira). Os arquivos e valores abaixo são inventados — se a classe voltar a reprovar, o gate
  // volta a ser desligado por quem só queria commitar código.
  it.each([
    ["chave de armazenamento local num *_KEY", "packages/jardim/web/src/hooks/useCanteiros.ts", "const LAST_VIEW_KEY = 'horta_aba_ativa';"],
    ["sentinela camelCase entre underscores", "packages/jardim-ui/src/layout/Mutirao.tsx", "const LOCK_KEY = '__mutiraoSorteioLock__';"],
    ["leitura de campo, não valor", "packages/biblioteca/functions/src/emprestimo/renovar.ts", "    refreshToken: loanSession.refreshToken,"],
    ["caminho de service account", "packages/biblioteca/scripts/seed/seed-leitor-teste.js", " *   SERVICE_ACCOUNT_KEY=../.segredos/conta-leitor.json"],
    ["referência do gerenciador de segredos (nome:versão)", "docs/runbooks/coleta.md", "--set-secrets=ESTUFA_SENSORES_API_KEY=ESTUFA_SENSORES_API_KEY:3,REPO_DEPLOY_TOKEN=REPO_DEPLOY_TOKEN:latest"],
    ["placeholder em prosa no .env.example", "packages/viveiro/api/.env.example", "REPO_DEPLOY_TOKEN=replace_me_with_a_long_random_value"],
    ["token de fixture com números no fim", "packages/loja/src/__tests__/checkout.test.ts", 'const API_TOKEN = "cliente-teste-bicicletario-0731";'],
    ["id de membro citado em doc (a forma é de id, o valor é sintético)", "docs/guides/operacao.md", "- Never paste a member id (`Wb7Pn4XcQe9RtLz2HdKs6VyMa3Jf` or similar) into the ticket;"],
  ])("%s não é achado", (_classe, file, line) => {
    expect(scanLine(file, line).code).toBe(0);
  });

  it("um JPEG embutido em base64 numa fixture não gera achado nenhum", () => {
    // Dezenas de achados vinham de UMA linha enorme — o `/` do alfabeto base64 se disfarça de
    // separador de path. O blob é alta entropia por construção, como o hash de um lockfile.
    const blob = `/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGx0dHx8fExch${"JlJvcXlue3yBg4WHiYuNj5GT".repeat(3)}`;
    const res = scanLine("packages/acmeapp/tests/fixtures/thumbnail-sample.json", `      "bytes_base64": "${blob}"`);
    expect(res.findings).toEqual([]);
  });

  it("o hash de integridade de um lockfile não é achado (alta entropia por construção)", () => {
    const line = '  "integrity": "Xt4Bq9WnPmLc7ZrVs2HkDyGf5JuAe1Rk3TnQiObKq7Vt2ZmXbNr9LpHc4Ws"'; // pragma: allowlist secret
    expect(scanLine("bun.lock", line).code).toBe(0);
  });

  it("o pragma de allowlist continua sendo a válvula de escape", () => {
    const value = "sk-proj-Wn4Kq7bVtZm2XrNc9LpHsGyDf6JuAe1Rk3TnQiOb5vZMdCw_9pLqW3sHmTbNzKrVfEyDu7A"; // pragma: allowlist secret
    expect(scanLine("deploy/env.yaml", `LLM_GATEWAY_API_KEY: ${value} # pragma: allowlist secret`).code).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Forma 3 — A CREDENCIAL DO PRÓPRIO AGILEHARNESS, que o gate de PUBLICAÇÃO liberava
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// COMO ISTO FOI ACHADO. O critério do corte exige um par: plantar um segredo falso num caminho que a
// régua de extração PERMITE e VER o portão bloquear — "sem ver o vermelho, o portão é decoração".
// O portão liberou. Medidas as cinco formas em que esta credencial de fato aparece, quatro passavam.
//
// O QUE ESTAVA ERRADO, e é mais interessante que a lacuna: `lib/auth/mcp-handle.ts` deu ao handle um
// PREFIXO justamente para ele ser julgável por forma, e o comentário que define esse prefixo afirma
// que ele segue "a mesma régua que scan-secrets.mjs já aplica nesta onda". A régua nunca foi escrita.
// Um comentário que descreve uma proteção inexistente é pior que nenhum: ele ENCERRA a pergunta.
//
// A forma que mais importa é a ÚLTIMA de cada bloco: a credencial dentro da URL do endpoint. É assim
// que ela entra no `.mcp.json` de um cliente, num README de onboarding e num exemplo em comentário —
// e é assim que ela costuma vazar: para o log persistente de um proxy. Nenhuma camada de VALOR
// podia pegá-la: `looksLikeSecretValue` recusa, por desenho, todo valor que começa com http(s)://.
//
// Valores SINTÉTICOS, marker-less de propósito (um marcador `example` é dispensado por desenho e
// tornaria o teste incapaz de detectar a regressão).
describe("Forma 3 — o handle/token MCP do próprio produto", () => {
  const ID_12HEX = "3f9a1c7e5b02";
  const SEGREDO_43 = "IjWTAFjfMwK6Yrn0S8tH7j1U6oOmmU4zaqyo59nBON4"; // pragma: allowlist secret
  const TOKEN_43 = "squa0Jw3MVsmaiOS_bcKi_l2lCqT6WZAkKl9NdusXno"; // pragma: allowlist secret
  const HANDLE = `ahk_${ID_12HEX}.${SEGREDO_43}`;

  // ⚠️ O PISO DA FIXTURE, e ele não é zelo: a primeira vez que medi isto, o gerador do meu canário
  // produzia 42 chars em vez de 43 e a regra — correta — não casava. Eu quase registrei "regra cega"
  // sobre uma fixture quebrada. Uma fixture fora de forma faz este arquivo inteiro reportar ausência
  // de proteção onde há proteção, que é a pior leitura possível de um teste de segurança.
  it("a fixture tem a FORMA do handle real — senão este arquivo mede a si mesmo, não o scanner", () => {
    expect(ID_12HEX, "o id público é 12 hex (HANDLE_ID_RE)").toMatch(/^[0-9a-f]{12}$/);
    expect(SEGREDO_43, "a parte secreta é 43 base64url (HANDLE_SECRET_RE)").toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(TOKEN_43, "o token cru tem o mesmo shape de 32 bytes base64url").toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  const FORMAS_REAIS: Array<[nome: string, linha: string]> = [
    ["nome canônico de env", `export const AGILEHARNESS_MCP_TOKEN = "${HANDLE}";`],
    // O nome que o PRODUTO usa não termina em TOKEN/KEY/SECRET, então ENV_ASSIGN não o vê.
    ["o nome que o produto usa (…_HANDLE)", `export const AGILEHARNESS_MCP_HANDLE = "${HANDLE}";`],
    ["valor nu entre aspas, sem palavra-chave", `export const X = "${HANDLE}";`],
    ["handle dentro da URL do conector", `const u = "https://ah.example/api/mcp/${HANDLE}/mcp";`],
    ["a mesma URL em comentário de doc", `// exemplo: https://ah.example/api/mcp/${HANDLE}/mcp`],
    ["token CRU na URL de um .mcp.json", `{"url":"https://ah.example/api/mcp/${TOKEN_43}/mcp"}`],
  ];

  it.each(FORMAS_REAIS)("BLOQUEIA: %s", (_nome, linha) => {
    expect(scanLine("packages/storymap-ui/src/qualquer.ts", linha).code).toBe(BLOCKED);
  });

  // O outro lado do par. Sem estes, a regra poderia ser um `return BLOCKED` disfarçado — e um gate
  // que reprova documentação honesta é um gate que alguém desliga na primeira semana.
  const CONTROLES: Array<[nome: string, linha: string]> = [
    ["placeholder de documentação", "// veja https://ah.example/api/mcp/<credencial>/mcp"],
    ["o REDIGIDO que o filtro de log escreve", "// veja https://ah.example/api/mcp/REDIGIDO/mcp"],
    ["a rota sem credencial nenhuma", `const rota = "/api/mcp/[secret]/[transport]";`],
  ];

  it.each(CONTROLES)("LIBERA (controle negativo): %s", (_nome, linha) => {
    expect(scanLine("docs/onboarding.md", linha).code).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// `--range … --messages`: a MENSAGEM do commit. O merge train compõe os commits que cria em main/stage com
// as mensagens da própria entrada (texto livre, inclusive o trailer `Decision:` de um agente) — e o diff,
// que é tudo o que as outras regras leem, nunca mostra a mensagem.
// ---------------------------------------------------------------------------------------------
describe("--messages: as mensagens dos commits do range", () => {
  // montado em runtime: a forma de um PAT do GitHub, sintética, sem marcador de fixture
  const TOKEN = ["gh", "p_", "Q7mZ2xK9vR4tL8nB3cW6yH1jF5dS0aGe2uPq"].join("");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  // a forma de `git log -z --format=%H%x00%B`: sha NUL mensagem NUL (o `%B` termina em \n)
  const gitWithMessage = (msg: string) => (args: string[]) => (args[0] === "log" ? `${SHA}\x00${msg}\n\x00` : "");

  it("BLOQUEIA um token na mensagem, nomeando o commit e a linha — sem ecoar os bytes", () => {
    const r = runScan({
      argv: ["--range", "HEAD~2..HEAD", "--messages"],
      git: gitWithMessage(`fix(ops): relatório\n\nDecision: autentiquei com ${TOKEN}`),
      env: {},
    });
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.[0]).toMatchObject({ file: "mensagem do commit 0123456789ab", line: 3, rule: "github-pat" });
    expect(JSON.stringify(r.findings)).not.toContain(TOKEN);
  });

  it("LIBERA (controle negativo): mensagem de prosa com trailers", () => {
    const msg = "fix(hooks): o guarda lê o dono\n\nCo-Authored-By: Pessoa Exemplo <p@example.test>\nRefs: story-ex9301";
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git: gitWithMessage(msg), env: {} }).code).toBe(0);
  });

  it("sem `--messages` a mensagem não é lida (o escopo do gate do merge integral não muda)", () => {
    const git = gitWithMessage(`Decision: ${TOKEN}`);
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD"], git, env: {} }).code).toBe(0);
  });

  it("um byte \\x1e NA mensagem não esconde o token que vem depois dele (o separador antigo)", () => {
    const r = runScan({
      argv: ["--range", "HEAD~1..HEAD", "--messages"],
      git: gitWithMessage(`feat: x\n\ncorpo\x1e\n${TOKEN}`),
      env: {},
    });
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.[0]).toMatchObject({ file: "mensagem do commit 0123456789ab", line: 4, rule: "github-pat" });
  });

  it("saída do log que não alterna sha/mensagem é ERRO INTERNO (fail-closed), nunca um registro pulado", () => {
    for (const bad of [`${SHA}\x00msg\n`, `${SHA}\x00msg\n\x00extra\x00`, `nao-e-sha\x00msg\n\x00`]) {
      const r = runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git: (a) => (a[0] === "log" ? bad : ""), env: {} });
      expect(r).toMatchObject({ code: 1, internalError: true });
    }
  });

  it("parseMessageLog: alternância estrita de NULs, vários commits, mensagem com \\x1e intacta", () => {
    const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
    expect(parseMessageLog("")).toEqual([]);
    expect(parseMessageLog(`${SHA}\x00um\x1e dois\n\x00${SHA2}\x00tres\n\x00`)).toEqual([
      { sha: SHA, message: "um\x1e dois\n" },
      { sha: SHA2, message: "tres\n" },
    ]);
  });
});

// O mesmo \x1e num repositório REAL: o git guarda o byte na mensagem, e o `git log -z` que o scanner roda
// tem de entregar o que vem depois dele para as regras.
describePosix("--messages (git real): \\x1e na mensagem do commit", () => {
  const TOKEN = ["gh", "p_", "Q7mZ2xK9vR4tL8nB3cW6yH1jF5dS0aGe2uPq"].join("");
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "scan-msg-rs-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const gitIn = (cwd: string) => (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dir },
    });

  it("o token DEPOIS do \\x1e é pego (antes: exit 0); sem token, o mesmo commit passa", () => {
    const repo = path.join(dir, "r");
    mkdirSync(repo);
    const git = gitIn(repo);
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.test"]);
    git(["config", "user.name", "tester"]);
    git(["commit", "-q", "--allow-empty", "-m", "base"]);
    writeFileSync(path.join(dir, "msg-limpa.txt"), "feat: x\n\ncorpo\x1e\nnada aqui\n");
    git(["commit", "-q", "--allow-empty", "-F", path.join(dir, "msg-limpa.txt")]);
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git, env: {} }).code).toBe(0);

    writeFileSync(path.join(dir, "msg-token.txt"), `feat: x\n\ncorpo\x1e\n${TOKEN}\n`);
    git(["commit", "-q", "--allow-empty", "-F", path.join(dir, "msg-token.txt")]);
    expect(git(["log", "-1", "--format=%B"])).toContain("\x1e"); // o git guardou o byte
    const r = runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git, env: {} });
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.[0]?.rule).toBe("github-pat");
    // o range com os dois commits também pega (o registro limpo não "engole" o seguinte)
    expect(runScan({ argv: ["--range", "HEAD~2..HEAD", "--messages"], git, env: {} }).code).toBe(BLOCKED);
  });
});

// O que o PUSH publica são os BYTES de cada commit da história — não o texto decodificado da mensagem nem o
// saldo líquido do range. Três formas medidas em que o token passava com exit 0, e o controle negativo da
// assinatura (base64 por construção, que a régua do token nu não pode transformar em achado).
describePosix("o objeto CRU e a história (git real): encoding, NUL na mensagem, adicionar-e-remover", () => {
  const TOKEN = ["gh", "p_", "Q7mZ2xK9vR4tL8nB3cW6yH1jF5dS0aGe2uPq"].join("");
  let dir = "";
  let n = 0;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "scan-raw-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const gitIn = (cwd: string) => (args: string[], opts: { input?: string } = {}) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      input: opts.input,
      env: { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dir },
    });
  const freshRepo = () => {
    const repo = path.join(dir, `r${++n}`);
    mkdirSync(repo);
    const git = gitIn(repo);
    git(["init", "-q"]);
    git(["config", "user.email", "t@example.test"]);
    git(["config", "user.name", "tester"]);
    git(["commit", "-q", "--allow-empty", "-m", "base"]);
    return { repo, git, base: git(["rev-parse", "HEAD"]).trim() };
  };
  const scan = (git: (a: string[]) => string, ...argv: string[]) => runScan({ argv, git, env: {} });

  it("`i18n.commitEncoding=UTF-16` esvazia o %B — a leitura CRUA ainda pega o token", () => {
    const { git, base } = freshRepo();
    git(["-c", "i18n.commitEncoding=UTF-16", "commit", "-q", "--allow-empty", "-m", `feat: y\n\n${TOKEN}`]);
    expect(git(["log", "-1", "--format=%B"])).not.toContain(TOKEN); // o bypass: o texto decodificado sumiu
    const r = scan(git, "--range", `${base}..HEAD`, "--messages");
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.some((f) => f.rule === "github-pat")).toBe(true);
  });

  it("um objeto forjado com NUL na mensagem (o %B trunca nele) é BLOQUEADO — o NUL e o token depois dele", () => {
    const { git, base } = freshRepo();
    const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
    const raw = `tree ${tree}\nparent ${base}\nauthor t <t@example.test> 1 +0000\ncommitter t <t@example.test> 1 +0000\n\nfeat: x\0\n${TOKEN}\n`;
    const forged = git(["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: raw }).trim();
    git(["reset", "-q", "--hard", forged]);
    const r = scan(git, "--range", `${base}..HEAD`, "--messages");
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.map((f) => f.rule)).toEqual(expect.arrayContaining(["nul-in-commit-object", "github-pat"]));
    expect(JSON.stringify(r.findings)).not.toContain(TOKEN);
  });

  it("adicionar e remover em commits seguidos: o diff líquido passa, `--per-commit` BLOQUEIA", () => {
    const { repo, git, base } = freshRepo();
    writeFileSync(path.join(repo, "k.txt"), `k=${TOKEN}\n`);
    git(["add", "k.txt"]);
    git(["commit", "-q", "-m", "a"]);
    writeFileSync(path.join(repo, "k.txt"), "k=redigido\n");
    git(["commit", "-q", "-am", "b"]);
    expect(scan(git, "--range", `${base}..HEAD`, "--messages").code).toBe(0); // o furo: o saldo é limpo
    const r = scan(git, "--range", `${base}..HEAD`, "--messages", "--per-commit");
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.[0]).toMatchObject({ file: "k.txt", rule: "github-pat" });
    // o achado diz DE QUAL COMMIT veio — o primeiro (o que adicionou), não o HEAD
    const first = git(["rev-list", "--reverse", `${base}..HEAD`]).split("\n")[0].trim();
    expect(r.findings?.[0]?.commit).toBe(first.slice(0, 12));
  });

  it("`<árvore vazia>..HEAD --per-commit` varre a história inteira, raiz incluída; limpa, passa", () => {
    const { repo, git } = freshRepo();
    expect(scan(git, "--range", `${EMPTY_TREE}..HEAD`, "--messages", "--per-commit").code).toBe(0);
    writeFileSync(path.join(repo, "k.txt"), `k=${TOKEN}\n`);
    git(["add", "k.txt"]);
    git(["commit", "-q", "-m", "a"]);
    expect(scan(git, "--range", `${EMPTY_TREE}..HEAD`, "--per-commit").code).toBe(BLOCKED);
  });

  it("a assinatura base64 de um `gpgsig` não é token nu (controle negativo); um prefixo de credencial nela é", () => {
    const { git, base } = freshRepo();
    const tree = git(["rev-parse", "HEAD^{tree}"]).trim();
    // base64 de bytes pseudo-aleatórios, montado em runtime: a forma de uma linha de assinatura ASCII-armored
    const sigLine = Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 73 + 41) % 256)).toString("base64");
    const forge = (extra: string) => {
      const raw = `tree ${tree}\nparent ${base}\nauthor t <t@example.test> 1 +0000\ncommitter t <t@example.test> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n ${sigLine}\n ${sigLine.split("").reverse().join("")}${extra}\n -----END PGP SIGNATURE-----\n\nfeat: assinado\n`;
      const sha = git(["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { input: raw }).trim();
      git(["reset", "-q", "--hard", sha]);
    };
    forge("");
    expect(scan(git, "--range", `${base}..HEAD`, "--messages").findings).toEqual([]);
    git(["reset", "-q", "--hard", base]);
    forge(` ${TOKEN}`);
    const r = scan(git, "--range", `${base}..HEAD`, "--messages");
    expect(r.code).toBe(BLOCKED);
    expect(r.findings?.[0]).toMatchObject({ file: expect.stringMatching(/^cabeçalho do commit /), rule: "github-pat" });
  });
});

describe("--per-commit: saída do rev-list fora de forma é ERRO INTERNO (fail-closed)", () => {
  it("uma linha que não é só de shas não vira um commit pulado", () => {
    const git = (args: string[]) => (args[0] === "rev-list" ? "nao-e-sha\n" : "");
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD", "--per-commit"], git, env: {} })).toMatchObject({ code: 1, internalError: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Os falsos-positivos MEDIDOS no alvo real pelo portão pré-push (por commit + mensagens). Cada um reteria TODA
// publicação do checkout; as isenções são estreitas e têm o controle positivo ao lado.
// ---------------------------------------------------------------------------------------------
describe("portão pré-push: falsos-positivos medidos e a sonda --capabilities", () => {
  const TOKEN = ["gh", "p_", "Q7mZ2xK9vR4tL8nB3cW6yH1jF5dS0aGe2uPq"].join("");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const gitWithMessage = (msg: string) => (args: string[]) => (args[0] === "log" ? `${SHA}\x00${msg}\n\x00` : "");
  // um id aleatório com a forma do de uma sessão (32 alfanuméricos, as três classes), montado em runtime
  const SESSION_ID = Array.from({ length: 32 }, (_, i) => "aB3cD9eF1gH7iJ5kL2mN8oP4qR6sT0uV"[(i * 7 + 3) % 32]).join("");

  it("--capabilities imprime a linha e NÃO varre nada", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const git = () => {
        throw new Error("a sonda não pode chamar o git");
      };
      expect(runScan({ argv: ["--capabilities"], git, env: {} })).toMatchObject({ code: 0 });
      expect(write).toHaveBeenCalledWith(`${CAPABILITIES_LINE}\n`);
    } finally {
      write.mockRestore();
    }
    expect(CAPABILITIES_LINE.split(/\s+/)).toEqual(expect.arrayContaining(["per-commit", "messages", "range"]));
  });

  it("o trailer `Claude-Session:` de uma sessão na nuvem não é token nu — o mesmo id fora do trailer é", () => {
    const trailer = `Claude-Session: https://claude.ai/code/session_${SESSION_ID}`;
    expect(CLAUDE_SESSION_TRAILER.test(trailer)).toBe(true);
    const msg = `fix(app): ajuste\n\nCo-Authored-By: Pessoa Exemplo <p@example.test>\n${trailer}`;
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git: gitWithMessage(msg), env: {} }).code).toBe(0);
    // controle positivo: o mesmo valor numa linha que NÃO é exatamente o trailer segue achado
    const other = `fix(app): ajuste\n\nchave=${SESSION_ID}`;
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git: gitWithMessage(other), env: {} }).code).toBe(BLOCKED);
    // e o trailer não desculpa um prefixo de credencial na mesma mensagem
    const both = `${msg}\nDecision: ${TOKEN}`;
    expect(runScan({ argv: ["--range", "HEAD~1..HEAD", "--messages"], git: gitWithMessage(both), env: {} }).code).toBe(BLOCKED);
  });

  it("um id de anexo base64URL de 120+ caracteres (`_`/`-` no alfabeto) é blob, não token nu", () => {
    const alfabeto = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDeFgHiJkLmNoPqRsTuVwXyZ";
    const id = Array.from({ length: 127 }, (_, i) => alfabeto[(i * 29 + 11) % alfabeto.length]).join("");
    expect(scanLine("fixtures/feed-exemplo.json", `  "link": "https://blog.example.test/img?attbid=${id}&k=1",`).code).toBe(0);
    // controle: um token nu curto (fora da trava de blob) na mesma forma segue achado
    expect(scanLine("fixtures/feed-exemplo.json", `  "link": "https://blog.example.test/img?attbid=${SESSION_ID}&k=1",`).code).toBe(BLOCKED);
  });

  const scanFile = (file: string, lines: string[]) => {
    const diff = [`+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
    const git = (args: string[]) => (args.includes("--name-only") ? `${file}\n` : diff);
    return runScan({ argv: ["--staged"], git, env: {} });
  };

  it("`.env.development` só com `NEXT_PUBLIC_*`, comentário e linha vazia passa; qualquer outra chave nele é `secret-file`", () => {
    const publico = ["# valores públicos do front", "NEXT_PUBLIC_API_URL=https://api.example.test", "", "NEXT_PUBLIC_FLAG=1"];
    expect(scanFile("packages/web/.env.development", publico).code).toBe(0);
    const comChave = scanFile("packages/web/.env.development", [...publico, "DB_URL=postgres://localhost/app"]);
    expect(comChave.code).toBe(BLOCKED);
    expect(comChave.findings?.map((f) => f.rule)).toContain("secret-file");
    // o nome não basta: `.env.production` e `.env` seguem proibidos mesmo só com NEXT_PUBLIC_*
    expect(scanFile("packages/web/.env.production", publico).findings?.map((f) => f.rule)).toContain("secret-file");
    expect(scanFile("packages/web/.env", publico).findings?.map((f) => f.rule)).toContain("secret-file");
  });
});
