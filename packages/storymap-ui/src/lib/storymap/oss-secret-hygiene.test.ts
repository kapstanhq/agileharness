// ATAQUE: o repositório público nasce com o segredo do operador DENTRO do commit inicial.
//
// A extração para OSS é cópia do SHA congelado + UM commit (docs/plans/agileharness-oss/
// 06-frente-release.md WS-H). O `.gitignore` que hoje segura `.env.local` mora na RAIZ do umbrella e
// NÃO viaja com o pacote — então, no repo novo, o primeiro `git add -A` é ao mesmo tempo o único
// commit e o artefato publicado: sem histórico onde o vazamento se esconda, sem rebase que o desfaça.
// O que entraria: token do operador, token MCP `full`, chave VAPID privada, tokens de ingest
// (`.env.local`) e `storymap/.runner/auth-token`. Qualquer um deles = board de terceiro operável, e
// o board spawna agentes com poder de execução.
//
// Este teste simula a extração de verdade — repo git novo, só os arquivos que viajam com o pacote —
// e reprova se um `.env*` (fora do `.env.example`) ou o estado do runner voltar a ser stageável.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** vitest roda com cwd = packages/storymap-ui (mesma premissa de agnostic-lint.test.ts). */
const PKG_ROOT = process.cwd();

/**
 * Cada repo-fixture montado aqui é um diretório novo em /tmp — e `extrairPacote()` roda uma vez por
 * teste. Sem esta remoção, cada passada do portão deixava 7 árvores órfãas para trás; elas eram parte
 * das ~84 mil entradas acumuladas em /tmp. A remoção é no `afterEach` (não no meio do teste) porque as
 * asserções LEEM os arquivos do fixture — apagar antes trocaria lixo por falha intermitente.
 */
const temporarios: string[] = [];
function tmpDescartavel(prefixo: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefixo));
  temporarios.push(dir);
  return dir;
}

afterEach(() => {
  while (temporarios.length > 0) {
    rmSync(temporarios.pop() as string, { recursive: true, force: true });
  }
});

/**
 * git com os excludes GLOBAIS desligados. Sem isso um `~/.config/git/ignore` da máquina do dono
 * poderia esconder `.env.local` e deixar o teste verde por acidente — verde emprestado da máquina,
 * não do artefato que vai a público.
 */
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "core.excludesFile=/dev/null", "-c", "core.quotePath=false", ...args], {
    cwd,
    input,
    encoding: "utf8",
    // stderr CAPTURADO, não herdado: um dos testes abaixo provoca de propósito um `fatal:` do git, e
    // deixá-lo vazar para a saída da suíte treina quem lê a suíte a ignorar linhas `fatal:`.
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Lê a saída de `check-ignore -v -n`: `<fonte>:<linha>:<padrão>\t<caminho>`, ou `::\t<caminho>`
 * quando nenhum padrão casou. Um padrão de NEGAÇÃO (`!.env.example`) CASA, mas significa
 * "NÃO ignorado" — julgar pela mera presença de fonte inverteria o veredito e daria por protegido
 * justamente o arquivo que foi re-incluído.
 *
 * `esperados` NÃO é decoração: `-n` imprime UMA linha por caminho de entrada, então um veredito com
 * menos linhas do que caminhos significa que a MEDIÇÃO falhou. Sem esta conferência, as asserções
 * abaixo (todas da forma `alvos.filter(...)` → `[]`) passam VACUAMENTE com o veredito vazio: um
 * `check-ignore` que morreu por qualquer motivo virava "nenhum arquivo ignorado" — exatamente o
 * resultado que a barreira precisa provar —, e o teste ficava verde sem ter medido nada.
 */
function lerVeredito(saida: string, esperados: string[]): Record<string, boolean> {
  const veredito: Record<string, boolean> = {};
  for (const linha of saida.split("\n").filter(Boolean)) {
    const [descricao, alvo] = linha.split("\t");
    if (!alvo) continue;
    const padrao = descricao.split(":").slice(2).join(":");
    veredito[alvo] = descricao !== "::" && !padrao.startsWith("!");
  }
  const semVeredito = esperados.filter((p) => !(p in veredito));
  if (semVeredito.length > 0) {
    throw new Error(
      `check-ignore não deu veredito para ${semVeredito.join(", ")} — a medição falhou, e um teste de ` +
        `barreira que não mediu NÃO pode passar. Saída bruta:\n${saida}`,
    );
  }
  return veredito;
}

/**
 * Roda `check-ignore` e trata como resultado APENAS o exit 1 (nenhum caminho casou) — que com `-n`
 * ainda traz a saída completa. Qualquer outro fracasso (128, git ausente, cwd que não é repo) LANÇA.
 *
 * O `catch` anterior transformava qualquer erro em string vazia, e daí em veredito vazio: a falha de
 * medição virava um verde. É a mesma classe de defeito que o gate de snapshot já corrigiu — "não
 * consegui olhar" nunca pode ser lido como "está limpo".
 */
function vereditoDe(cwd: string, caminhos: string[]): Record<string, boolean> {
  let saida: string;
  try {
    saida = git(cwd, ["check-ignore", "--no-index", "--stdin", "-v", "-n"], caminhos.join("\n"));
  } catch (e) {
    const err = e as { status?: number; stdout?: string; message?: string };
    if (err.status !== 1) {
      throw new Error(`check-ignore falhou em ${cwd} (status ${err.status}): ${err.message ?? e}`);
    }
    saida = String(err.stdout ?? "");
  }
  return lerVeredito(saida, caminhos);
}

/**
 * Valor de mentira, com nome que grita — nunca um segredo real, nem no tmp. Os marcadores
 * `FAKE`/`EXAMPLE` estão no VALOR de propósito: é o que dispensa o scan de segredo
 * (scripts/git-hooks/scan-secrets.mjs, FIXTURE_MARKER) de reprovar o commit deste teste.
 */
const SEGREDO_FALSO = "FAKE-EXAMPLE-TOKEN-nao-e-segredo-de-ninguem-0123456789";

/**
 * Monta o repo público como a extração o monta: `git init` + CÓPIA dos arquivos do pacote. Nada da
 * raiz do umbrella entra — é justamente essa perda que o `.gitignore` do pacote tem de cobrir.
 */
function extrairPacote(): string {
  const dest = tmpDescartavel("ah-extract-");
  execFileSync("git", ["init", "-q", dest]);
  for (const f of [".gitignore", ".env.example", "package.json"]) {
    const src = path.join(PKG_ROOT, f);
    if (existsSync(src)) cpSync(src, path.join(dest, f));
  }
  // O que o 1º boot do novo operador cria, e que o `git add -A` dele encontraria.
  writeFileSync(
    path.join(dest, ".env.local"),
    `AGILEHARNESS_AUTH_TOKEN=${SEGREDO_FALSO}\nSTORYMAP_MCP_TOKEN=${SEGREDO_FALSO}\nSTORYMAP_VAPID_PRIVATE_KEY=${SEGREDO_FALSO}\n`,
  );
  // ...e as variantes que a rede do pacote NÃO enumerava. Elas não são hipotéticas: `@next/env`
  // (src/server/main.ts, loadEnvConfig) LÊ `.env.<ambiente>` — com AGILEHARNESS_DEV=1 isso é
  // `.env.development` —, então é um arquivo que o adotante cria por instrução do próprio produto.
  // Plantá-las aqui é o que faz este teste medir a CLASSE `.env*` que o nome dele promete: com só
  // o `.env.local` no fixture, a barreira podia enumerar variante por variante e ficar verde —
  // exatamente o buraco que o `.gitignore` da RAIZ já tinha fechado e este, o único que VIAJA,
  // não. MEDIDO: as três eram stageadas no commit inicial que É o artefato publicado.
  for (const variante of [".env.development", ".env.staging", ".env.dev"]) {
    writeFileSync(path.join(dest, variante), `STORYMAP_MCP_TOKEN=${SEGREDO_FALSO}\n`);
  }
  mkdirSync(path.join(dest, "storymap", ".runner"), { recursive: true });
  writeFileSync(path.join(dest, "storymap", ".runner", "auth-token"), `${SEGREDO_FALSO}\n`);
  writeFileSync(path.join(dest, "storymap", ".runner", "session-secret"), `${SEGREDO_FALSO}\n`);
  // MATERIAL DE CHAVE — a classe que este fixture NUNCA plantou, e a ausência tinha consequência
  // medida: dá para apagar as sete linhas de chave da cerca QUE VIAJA e a suíte inteira fica verde
  // no umbrella, porque o único caso que as cobria mede `vereditoDaRaiz` — o `.gitignore` da raiz
  // do umbrella, que por desenho FICA PARA TRÁS. O merge gate aprovaria a remoção.
  //
  // Por que isto é o eixo mais caro da extração: chave privada num histórico git PÚBLICO não se
  // conserta com um commit por cima — conserta-se rodando a chave. E o artefato é UM commit, sem
  // histórico para reescrever.
  mkdirSync(path.join(dest, "sa"), { recursive: true });
  for (const arquivo of ["id_rsa", "id_ed25519", "keystore.p12", "cert.pfx", "sa/serviceAccount.json", "sa/gcp-service-account.json"]) {
    writeFileSync(path.join(dest, arquivo), `${SEGREDO_FALSO}\n`);
  }
  return dest;
}

/**
 * Veredito da cerca QUE VIAJA — `packages/storymap-ui/.gitignore`, julgado DENTRO do repo extraído.
 *
 * Por que não dá para medi-la a partir do umbrella: ali o `check-ignore` soma o `.gitignore` da RAIZ ao
 * do pacote, e a raiz cobre a classe `.env*` desde 2026-07. Um veredito medido de lá seria verde mesmo
 * com a cerca do pacote vazia — e é exatamente essa cerca que vira a raiz do repositório público (a
 * extração é cópia do SHA + UM commit; nada da raiz do umbrella viaja). Aqui, o único `.gitignore` que
 * existe na árvore é o do pacote, então o veredito é dele e de mais ninguém.
 *
 * `--no-index` para julgar o PADRÃO, não o índice.
 */
function vereditoDaCercaQueViaja(caminhos: string[]): Record<string, boolean> {
  return vereditoDe(extrairPacote(), caminhos);
}

describe("higiene de segredo na extração para OSS (story-2psifs)", () => {
  it("[ATAQUE] variante de .env não enumerada não é commitável na cerca QUE VIAJA (a do pacote)", () => {
    // O teste-irmão no describe de baixo mede a cerca da RAIZ do umbrella — que protege ESTE checkout e
    // NÃO viaja. Este mede a única que vira a raiz do repo público, e por isso é o que decide se o
    // commit inicial (que É o artefato) nasce carregando credencial. Variantes DIFERENTES das que
    // `extrairPacote` planta, de propósito: aqui o que está sob teste é o PADRÃO cobrir a classe, não a
    // barreira acertar os três nomes que o fixture conhece.
    const alvos = [".env.qa", ".env.homolog", ".env.ci", "app/.env.tenant-a"];
    const v = vereditoDaCercaQueViaja(alvos);
    expect(
      alvos.filter((p) => !v[p]),
      "Variante de .env fora da cerca do PACOTE — credencial no commit único que é o artefato publicado.",
    ).toEqual([]);
  });

  it("[ATAQUE] material de chave privada não é commitável na cerca QUE VIAJA (a do pacote)", () => {
    // GÊMEO do caso `vereditoDaRaiz` do describe de baixo, e a razão de ele existir é uma falha
    // MEDIDA: apagar as sete linhas de chave APENAS da cerca que viaja deixava a suíte 13/13 verde
    // no umbrella, porque o caso original mede o `.gitignore` da RAIZ — que não viaja. O merge gate
    // aprovava a remoção da única cerca que o repositório público herda.
    //
    // Nomes DIFERENTES dos que `extrairPacote` planta, de propósito: aqui o que está sob teste é o
    // PADRÃO cobrir a CLASSE, não a barreira acertar os seis nomes que o fixture conhece.
    const alvos = [
      "deploy/id_rsa.bak",
      "keys/id_ed25519_ci",
      "certs/prod.p12",
      "certs/client.pfx",
      "infra/firebase-service-account.json",
      "infra/gcpServiceAccount.json",
    ];
    const v = vereditoDaCercaQueViaja(alvos);
    expect(
      alvos.filter((p) => !v[p]),
      "Material de chave fora da cerca do PACOTE. Ela vira a RAIZ do repositório público, e o primeiro " +
        "`git add -A` dela é o commit ÚNICO publicado. Chave privada em histórico git público não se " +
        "conserta com commit por cima — conserta-se rodando a chave.",
    ).toEqual([]);
  });

  it("o primeiro `git add -A` do repo extraído NÃO stageia material de chave", () => {
    // O par do caso acima pelo lado do COMPORTAMENTO, não do padrão: `check-ignore` julga a regra,
    // isto julga o que o git de fato levaria para o commit.
    const repo = extrairPacote();
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    const chaveVazada = staged.filter((p) =>
      /(^|\/)id_(rsa|ed25519|ecdsa)|\.(p12|pfx|pem|key)$|service[-_]?account.*\.json$/i.test(p),
    );
    expect(
      chaveVazada,
      "O pacote extraído stageou material de chave — a regra tem de morar em packages/storymap-ui/.gitignore, " +
        "porque a cerca da raiz do umbrella NÃO viaja.",
    ).toEqual([]);
  });

  it("a cerca que viaja NÃO engole os DOCUMENTOS (.env*.example) — sem eles o adotante não configura", () => {
    const alvos = [".env.example", ".env.local.example", ".env.example.auth"];
    const v = vereditoDaCercaQueViaja(alvos);
    expect(alvos.filter((p) => v[p]), "Um .env*.example ficou ignorado no repo público.").toEqual([]);
  });

  it("o primeiro `git add -A` do repo extraído NÃO stageia nenhum .env* fora do .env.example", () => {
    const repo = extrairPacote();
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);

    const envVazados = staged.filter((p) => path.basename(p).startsWith(".env") && path.basename(p) !== ".env.example");
    expect(
      envVazados,
      "O pacote extraído stageou um .env — o `.gitignore` que segura isso ficou na raiz do umbrella e não viajou. " +
        "A regra tem de morar em packages/storymap-ui/.gitignore.",
    ).toEqual([]);
  });

  it("o estado do runner (auth-token, session-secret) NÃO é stageável no repo extraído", () => {
    const repo = extrairPacote();
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);

    const runnerVazado = staged.filter((p) => p.includes("storymap/.runner/"));
    expect(
      runnerVazado,
      "O token do operador (storymap/.runner/auth-token) entrou no commit inicial do repo público.",
    ).toEqual([]);
  });

  it("nenhum arquivo stageado contém o valor do segredo (a régua é o CONTEÚDO, não o nome do arquivo)", () => {
    const repo = extrairPacote();
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);

    const comSegredo = staged.filter((p) => {
      const abs = path.join(repo, p);
      return existsSync(abs) && readFileSync(abs, "utf8").includes(SEGREDO_FALSO);
    });
    expect(comSegredo, "Um arquivo stageado carrega o valor do segredo — nome ignorado, conteúdo vazado.").toEqual([]);
  });

  it("o .env.example VIAJA (o documento sem valores é o que ensina a configurar)", () => {
    const repo = extrairPacote();
    git(repo, ["add", "-A"]);
    const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    // Uma lista de ignore que engolisse o .env.example também estaria errada: o repo público
    // precisa dele para o operador saber quais knobs existem.
    expect(staged).toContain(".env.example");
  });

  it("o .env.example prescreve o modo 0600 do .env.local com o comando exato", () => {
    // O modo do arquivo VIVO é ato de ops (o serviço já roda com ele) — o que um artefato
    // versionado pode garantir é a INSTRUÇÃO: quem instalar não descobre sozinho que 0644 entrega
    // o token do operador para qualquer conta local da máquina.
    const doc = readFileSync(path.join(PKG_ROOT, ".env.example"), "utf8");
    expect(doc, "falta o comando de correção do modo (chmod 600 do .env.local)").toMatch(/chmod\s+600\s+\S*\.env\.local/);
    expect(doc, "falta como CONFERIR o modo (stat) — instrução sem verificação não fecha o buraco").toMatch(/stat\b[^\n]*\.env\.local/);
  });
});

// A MEDIÇÃO é parte do controle: todo teste de barreira acima tem a forma `alvos.filter(...)` → `[]`, e
// essa forma é VERDE com um veredito vazio. Logo, "não consegui medir" tinha de virar falha — antes ele
// virava exatamente o resultado que a barreira precisa provar.
describe("o verde destes testes só vale se a medição ACONTECEU", () => {
  it("[REGRESSÃO] `check-ignore` que não roda LANÇA, em vez de virar 'nada é ignorado'", () => {
    // Um diretório que não é repo git: o `check-ignore` sai 128. O catch antigo o transformava em string
    // vazia → veredito `{}` → toda asserção passando sem medir nada, inclusive a que garante que os
    // `.env*.example` continuam versionáveis no repo público.
    const semRepo = tmpDescartavel("ah-sem-repo-");
    expect(() => vereditoDe(semRepo, [".env.example"])).toThrow(/check-ignore/);
  });

  it("[REGRESSÃO] veredito INCOMPLETO LANÇA — `-n` imprime uma linha por caminho, e menos que isso é falha", () => {
    // O modo de falha mais sutil: o comando roda, sai 0, e responde sobre MENOS caminhos do que se pediu
    // (mudança de flag, caminho engolido por quoting). O caminho sem veredito lê-se como "não ignorado".
    expect(() => lerVeredito("::\t.env.example\n", [".env.example", ".env.local.example"])).toThrow(
      /não deu veredito/,
    );
  });
});

// A outra metade do mesmo princípio: a rede da RAIZ do monorepo. Ela não viaja na extração, mas é
// ela que protege ESTE checkout — e ela enumerava variante por variante, o que sempre deixa buraco.
describe("a rede do monorepo (raiz) cobre segredo operacional por CLASSE, não por enumeração", () => {
  const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");

  /** `--no-index` para julgar o PADRÃO, não o índice: um arquivo já rastreado seria dado como não-ignorado.
   *  Mesma exigência de medição do gêmeo de cima (`vereditoDe`): falha de medição LANÇA, nunca passa. */
  function vereditoDaRaiz(caminhos: string[]): Record<string, boolean> {
    return vereditoDe(REPO_ROOT, caminhos);
  }

  it("[ATAQUE] variante de .env não enumerada não é commitável na cerca da RAIZ (este checkout)", () => {
    // `.env.staging` / `.env.development` passavam direto: a lista cobria `.env`, `.env.local`,
    // `.env.*.local`, `.env.production` e `.env.e2e`, e mais nada.
    //
    // ATENÇÃO ao que este teste NÃO mede, porque já ficou verde uma vez enquanto o buraco estava aberto:
    // `vereditoDaRaiz` roda no `.gitignore` da RAIZ do umbrella, que POR DESENHO não viaja na extração.
    // Ele protege ESTE checkout e nada mais. O gêmeo que mede a cerca que VIAJA (a do pacote, a única
    // que vira a raiz do repo público) está no describe de cima — os dois importam, e cada um diz qual é.
    const alvos = [
      "packages/storymap-ui/.env.staging",
      "packages/storymap-ui/.env.development",
      "packages/acmeapp/api/.env.dev",
      ".env.qa",
    ];
    const v = vereditoDaRaiz(alvos);
    expect(alvos.filter((p) => !v[p]), "Variante de .env fora da barreira — credencial commitável.").toEqual([]);
  });

  it("[ATAQUE] material de chave privada solto no repo não é commitável", () => {
    const alvos = [
      "server.key",
      "certs/priv.pem",
      "id_rsa",
      "keystore.p12",
      "certs/bundle.pfx",
      "config/service-account.json",
      "sa/serviceAccount.json",
    ];
    const v = vereditoDaRaiz(alvos);
    expect(alvos.filter((p) => !v[p]), "Chave privada / service account passaria no `git add -A`.").toEqual([]);
  });

  it("o estado do runner e os dumps de log seguem cobertos", () => {
    const alvos = ["storymap/.runner/auth-token", "storymap/.runner/session-secret", ".artifacts/logs/run.log"];
    const v = vereditoDaRaiz(alvos);
    expect(alvos.filter((p) => !v[p])).toEqual([]);
  });

  it("os DOCUMENTOS (.env*.example) continuam versionáveis — a barreira não pode engolir a doc", () => {
    // Sem as negações, `.env.*` esconderia justamente os arquivos que ensinam a configurar — e a
    // regressão seria silenciosa: ninguém percebe um exemplo que deixou de ser adicionado.
    const alvos = [
      "packages/storymap-ui/.env.example",
      "packages/admin-dashboard/.env.local.example",
      "packages/acmeapp/.env.example.auth",
    ];
    const v = vereditoDaRaiz(alvos);
    expect(alvos.filter((p) => v[p]), "Um .env*.example ficou ignorado — a doc do operador para de viajar.").toEqual([]);
  });
});

// ─── `.artifacts/` — o que o PRODUTO grava (auditoria de extração, 2026-08-19) ───────────────────
//
// A cerca da RAIZ do umbrella já cobria esta pasta; a que VIAJA — a do pacote, transplantada para a
// raiz do repositório publicado — não. É onde a captura de tela que o operador anexa no terminal e no
// copiloto é salva (`api/terminal/upload`, `api/copilot/upload`) e onde as skills mandam gravar spike.
// Sem a regra, um `git add -A` — o do commit de código de um run (`worktree.ts commitAllPending`) —
// varre a captura para o branch, para o merge e para o remoto.
describe("a cerca que viaja cobre `.artifacts/` (o que o produto grava)", () => {
  function comArtefatos(): string {
    const repo = extrairPacote();
    for (const rel of [
      ".artifacts/screenshots/captura-do-operador.png",
      ".artifacts/scratch/spike-diagnostico.js",
      ".artifacts/reports/auditoria.md",
      ".artifacts/logs/run.log",
    ]) {
      const abs = path.join(repo, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "conteudo efemero\n");
    }
    return repo;
  }

  it("o primeiro `git add -A` do repo extraído NÃO stageia nada de `.artifacts/`", () => {
    const repo = comArtefatos();
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(
      staged.filter((p) => p.startsWith(".artifacts/")).join("\n"),
      "artefato efêmero stageado no repo publicado — é conteúdo do operador (captura de tela, spike), " +
        "não código nem dado de board",
    ).toBe("");
  });

  it("NÃO-VACUIDADE: os arquivos existem no disco — o vazio acima é a cerca, não a ausência", () => {
    const repo = comArtefatos();
    expect(existsSync(path.join(repo, ".artifacts/screenshots/captura-do-operador.png"))).toBe(true);
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" });
    expect(staged.trim().length, "o `git add -A` precisa ter stageado ALGO (o .gitignore, ao menos)").toBeGreaterThan(0);
  });

  it("o ESQUELETO continua versionável — a regra ignora conteúdo, não a convenção de diretórios", () => {
    // O padrão é o mesmo da cerca da raiz do umbrella, de propósito: README + os diretórios + os
    // `.gitkeep` sobrevivem, para a convenção `.artifacts/<kind>/` continuar existindo no clone.
    const repo = comArtefatos();
    mkdirSync(path.join(repo, ".artifacts"), { recursive: true });
    writeFileSync(path.join(repo, ".artifacts/README.md"), "# artefatos efêmeros\n");
    writeFileSync(path.join(repo, ".artifacts/scratch/.gitkeep"), "");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" });
    expect(staged).toContain(".artifacts/README.md");
    expect(staged).toContain(".artifacts/scratch/.gitkeep");
  });
});
