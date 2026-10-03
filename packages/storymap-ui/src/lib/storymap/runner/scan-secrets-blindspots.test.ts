// Testes de ATAQUE ao scan de segredos (story-ex0065). O que se descreve aqui é o vazamento, não a
// implementação: cada caso é uma forma em que uma credencial entra no repositório e passava batido.
//
// Por que este arquivo mora aqui e não ao lado do script: `scan-secrets.mjs` é um script de raiz, e a
// ÚNICA suíte que o cobre é a do storymap-ui (`vitest.config.ts` inclui só `src/**/*.test.ts`). Um teste
// em `scripts/git-hooks/__tests__/` não seria executado por nenhum gate — logo não provaria nada.
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
import { describe, expect, it } from "vitest";
// O scanner é um script compartilhado da raiz (o mesmo que o pre-commit, o merge train e o release chamam).
import { looksLikeIdentifier, runScan } from "../../../../../../scripts/git-hooks/scan-secrets.mjs";

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
