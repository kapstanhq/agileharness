// ATAQUE: a extração para OSS publica o board do dono junto com a ferramenta.
//
// O corte é uma CÓPIA (docs/plans/agileharness-oss/06-frente-release.md WS-H) e o commit inicial é o
// artefato publicado — o que entrar nele é público para sempre. O que este monorepo tem ao lado da
// ferramenta: 4 boards reais (cards, planos, entrevistas, governança, screenshots de feedback), os
// grafos de código dos produtos, três relatórios internos de estratégia na raiz do pacote, o segredo
// operacional e o allowlist da máquina do dono. Nada disso é o AgileHarness.
//
// A defesa é a LISTA (`/.ossignore` na raiz do monorepo) — um denylist total em sintaxe de gitignore
// que a extração consome. Este teste roda a lista contra a árvore REAL e cobra os dois lados:
// nenhum dado do dono sobrevive, E a ferramenta continua sobrevivendo (uma lista que exclui tudo
// passaria no primeiro critério e não protegeria nada — protegeria contra existir).

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_BOARDS } from "./board-fixture";

/** vitest roda com cwd = packages/storymap-ui (mesma premissa de agnostic-lint.test.ts). */
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const OSSIGNORE = path.join(REPO_ROOT, ".ossignore");

/** Este arquivo, no caminho em que ESTÁ rodando. Usado como testemunha: um instrumento que varre a
 *  árvore e não enxerga o próprio arquivo que está sendo executado está varrendo outra árvore. */
const ESTE_ARQUIVO = fileURLToPath(import.meta.url);

/**
 * A ÁRVORE-FERRAMENTA. É o que o repositório extraído É — o motor inteiro do AgileHarness — e por
 * isso existe, com o mesmo endereço, nas DUAS árvores: aqui e no destino. É dela que sai o piso.
 */
const ARVORE_FERRAMENTA = "packages/storymap-ui/src";

/** Caminho relativo à raiz, em separador POSIX — a mesma forma que `git ls-files` devolve. */
function relativoAoRepo(abs: string): string {
  return path.relative(REPO_ROOT, abs).split(path.sep).join("/");
}

/**
 * O repo-sonda descartável de `excluidos()` é um diretório novo em /tmp a cada passada — e o portão
 * roda muitas vezes por dia. Sem esta remoção ele se acumulava indefinidamente (parte das ~84 mil
 * entradas encontradas lá). A limpeza é no `afterEach`, depois de o veredito já ter sido lido.
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
 * git com excludes GLOBAIS desligados: um `~/.config/git/ignore` da máquina do dono não pode
 * participar do veredito — a lista tem de se sustentar sozinha na máquina de quem fizer o corte.
 */
function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "core.excludesFile=/dev/null", "-c", "core.quotePath=false", ...args], {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Rastreados no monorepo × rastreados que a lista EXCLUI ⇒ o conjunto que VIAJARIA.
 *
 * NÃO-VACUIDADE (o motivo do `throw`): quase toda asserção deste arquivo é de AUSÊNCIA — "board do
 * dono não viaja", "pacote do ecossistema não viaja". Se `REPO_ROOT` resolvesse para o diretório
 * errado, ou se o `git ls-files` falhasse em silêncio, `rastreados` viria vazio e TODAS elas ficariam
 * verdes por não medir nada. É a patologia que este arquivo existe para detectar na régua, e ele não
 * pode ser vítima dela: uma varredura que lê zero arquivos é erro de instrumento, não aprovação.
 */

/**
 * O PISO, DERIVADO — e não mais uma constante calibrada.
 *
 * O piso anterior era `2000`, um número escolhido olhando ESTA árvore (5918 rastreados). Ele tinha
 * dois defeitos, e o segundo é pior que o primeiro:
 *
 *   1. Reprovava a árvore CERTA. O repositório extraído é a mesma ferramenta com ~1200 rastreados;
 *      `2000` fazia o único guarda de ausência que viaja nascer VERMELHO justamente lá — que é o
 *      incentivo exato para alguém apagá-lo. Baixá-lo para outra constante só reencena a calibragem
 *      na terceira árvore; baixá-lo para 0 ou 1 é o vácuo que ele existe para pegar.
 *   2. Não pegava o erro que nomeava. "Instrumento quebrado" inclui `REPO_ROOT` resolvido para o
 *      checkout VIZINHO — e o umbrella inteiro tem 5801 rastreados, folgadamente acima de 2000. A
 *      constante aprovava a medição da árvore errada.
 *
 * A derivação usa um SEGUNDO instrumento, independente do que está sob suspeita: o filesystem. Conta
 * os arquivos em disco sob a árvore-ferramenta, que existe nas duas árvores, e cobra que o índice do
 * git dê conta de pelo menos isso. O número acompanha a árvore em que se está e continua reprovando
 * varredura vazia — o disco nunca está vazio enquanto este arquivo executa, porque ele próprio está
 * lá dentro, e é isso que a testemunha abaixo verifica antes de o piso valer qualquer coisa.
 */
function arquivosEmDisco(raiz: string): string[] {
  const achados: string[] = [];
  const pilha = [raiz];
  while (pilha.length > 0) {
    const dir = pilha.pop() as string;
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name === "node_modules" || entrada.name === ".git") continue;
      const alvo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) pilha.push(alvo);
      else achados.push(relativoAoRepo(alvo));
    }
  }
  return achados;
}

function pisoDerivado(): { piso: number; comoFoiMedido: string } {
  const raizDaFerramenta = path.join(REPO_ROOT, ARVORE_FERRAMENTA);
  if (!existsSync(raizDaFerramenta)) {
    throw new Error(
      `a árvore-ferramenta não existe em ${raizDaFerramenta}. Sem ela não há de onde derivar piso — ` +
        "e uma raiz sem a ferramenta dentro não é a raiz deste repositório.",
    );
  }
  const emDisco = arquivosEmDisco(raizDaFerramenta);
  // NÃO-VACUIDADE DO PRÓPRIO DERIVADOR. Um piso derivado de uma varredura vazia seria zero, e zero é
  // exatamente o que o piso existe para recusar. Este arquivo está DENTRO da árvore que acabou de ser
  // varrida: se ele não aparecer, o número que sairia daqui foi fabricado do nada.
  const testemunha = relativoAoRepo(ESTE_ARQUIVO);
  if (!emDisco.includes(testemunha)) {
    throw new Error(
      `o derivador do piso varreu ${ARVORE_FERRAMENTA} sob ${REPO_ROOT} (${emDisco.length} arquivos) e ` +
        `não encontrou ${testemunha}, que é ESTE arquivo em execução. Ou a raiz está resolvida para ` +
        "outra árvore, ou a varredura de disco não leu nada — nos dois casos o piso seria fabricado.",
    );
  }
  return { piso: emDisco.length, comoFoiMedido: `${emDisco.length} arquivos em disco sob ${ARVORE_FERRAMENTA}/` };
}

/**
 * A ÂNCORA. Era `existsSync(turbo.json)`, e `turbo.json` é Turborepo: arquivo do LADO DE CÁ que a
 * régua não deixa viajar — a âncora reprovava a árvore que este guarda existe para proteger.
 *
 * `.git` é o marcador universal que `paths.ts` já usa e documenta, e vale como ARQUIVO também (num
 * worktree linkado `.git` é arquivo, não diretório) — por isso `existsSync`, nunca `isDirectory()`.
 * E ele vem acompanhado da checagem que a âncora antiga NÃO fazia: o git que responde pela varredura
 * tem de ter esta raiz como TOPO. `turbo.json` presente provava, no máximo, "há algum monorepo
 * Turborepo aqui"; o checkout vizinho satisfazia isso e as contagens continuavam altas.
 */
function raizConferida(): string {
  if (!existsSync(path.join(REPO_ROOT, ".git"))) {
    throw new Error(
      `raiz de repositório não resolvida: ${REPO_ROOT} não tem .git (marcador universal, arquivo ou ` +
        "diretório). A varredura abaixo mediria uma árvore que não é a deste checkout.",
    );
  }
  const topo = realpathSync(git(REPO_ROOT, ["rev-parse", "--show-toplevel"]).trim());
  if (topo !== realpathSync(REPO_ROOT)) {
    throw new Error(
      `o git que faz a varredura tem topo em ${topo}, e a raiz medida é ${REPO_ROOT}. O instrumento ` +
        "está lendo outra árvore (ou um subdiretório dela) — todo veredito abaixo seria sobre ela.",
    );
  }
  return REPO_ROOT;
}

function conjuntos() {
  const raiz = raizConferida();
  const { piso, comoFoiMedido } = pisoDerivado();
  const rastreados = git(raiz, ["ls-files"]).split("\n").filter(Boolean);
  if (rastreados.length < piso) {
    throw new Error(
      `varredura leu ${rastreados.length} arquivos rastreados em ${raiz}, abaixo do piso DERIVADO ` +
        `de ${piso} (${comoFoiMedido}). Instrumento quebrado — as asserções de ausência abaixo ` +
        "seriam verdes por vacuidade.",
    );
  }
  // A TESTEMUNHA, agora contra o índice e não contra o disco: o `git ls-files` que vai julgar tudo
  // abaixo tem de enxergar este próprio arquivo. É o que separa "varreu pouco" de "varreu outra
  // coisa" — uma raiz vizinha devolve milhares de caminhos e nenhum deles é este.
  const testemunha = relativoAoRepo(ESTE_ARQUIVO);
  if (!rastreados.includes(testemunha)) {
    throw new Error(
      `os ${rastreados.length} rastreados lidos em ${raiz} não incluem ${testemunha}, que é ESTE ` +
        "arquivo. A varredura está apontada para outra árvore — contagem alta não é medição certa.",
    );
  }

  // ── SEGUNDA TESTEMUNHA, FORA da árvore-ferramenta ─────────────────────────────────────────────
  // Um cético mediu o buraco exato das duas guardas acima: uma varredura que devolvesse SÓ a
  // árvore-ferramenta (medido: 982 caminhos REAIS) satisfaz as duas por construção — o piso é
  // DERIVADO dessa mesma árvore, então `982 >= 982` e ele fica MUDO; e a testemunha vive DENTRO
  // dela, então também passa. O piso nunca tinha sido testado no ponto em que é a única defesa: as
  // duas mutações que o "provaram" escolheram truncagens ABAIXO dele.
  //
  // Estas três ficam FORA de `packages/storymap-ui/src` e são rastreadas nas DUAS árvores (viajam
  // por decisão da régua). Uma varredura amputada na ferramenta perde as três de uma vez.
  //
  // A condição é `=== length`, não `> 0`: exigir as três seria acoplar este guarda a decisões da
  // régua que podem mudar por bons motivos; exigir PELO MENOS UMA já discrimina o caso degenerado,
  // que é a amputação inteira.
  const FORA_DA_FERRAMENTA = ["LICENSE", ".ossignore", "storymap/boards/_base/board.yaml"] as const;
  const semTestemunhaExterna = FORA_DA_FERRAMENTA.filter((p) => !rastreados.includes(p));
  if (semTestemunhaExterna.length === FORA_DA_FERRAMENTA.length) {
    throw new Error(
      `os ${rastreados.length} rastreados não incluem NENHUMA testemunha fora da árvore-ferramenta ` +
        `(${FORA_DA_FERRAMENTA.join(", ")}). Uma varredura que enxerga só ${ARVORE_FERRAMENTA} ` +
        "satisfaz o piso derivado por CONSTRUÇÃO — é o caso que o piso sozinho não pega, e a razão " +
        "de ele não andar sozinho.",
    );
  }

  const excluidos = new Set(
    git(raiz, ["ls-files", "--cached", "--ignored", `--exclude-from=${OSSIGNORE}`]).split("\n").filter(Boolean),
  );
  const viajam = rastreados.filter((p) => !excluidos.has(p));
  if (viajam.length < piso) {
    throw new Error(
      `apenas ${viajam.length} arquivos viajariam, abaixo do piso derivado de ${piso} ` +
        `(${comoFoiMedido}). A árvore-ferramenta inteira tem de atravessar: ou a régua passou a ` +
        "excluir a ferramenta, ou o `--exclude-from` não foi aplicado — os dois invalidam este teste.",
    );
  }
  return { rastreados, excluidos, viajam, piso, comoFoiMedido };
}

/**
 * As NEGAÇÕES da própria régua, lidas do arquivo — não uma cópia mantida à mão aqui. Cada `!` é uma
 * superfície que a régua declara como "isto é a ferramenta"; o teste abaixo cobra que cada uma tenha
 * sobrevivente. Ler do arquivo é o que faz a cobrança acompanhar quem editar a régua amanhã.
 */
function negacoesDaRegua(): string[] {
  return readFileSync(OSSIGNORE, "utf8")
    .split("\n")
    .map((linha) => linha.trim())
    .filter((linha) => linha.startsWith("!"));
}

/**
 * Traduz um padrão de gitignore ANCORADO (`/…`, o único formato usado nesta régua) para o matcher
 * que a varredura aplica sobre os caminhos sobreviventes. `dir/` casa por prefixo, arquivo casa
 * exato, `*` casa dentro de um segmento.
 *
 * Um erro AQUI falha para o lado seguro: regex que não casa nada reporta a superfície como inerte e
 * REPROVA — barulhento. O risco oposto (regex frouxa demais, que casa tudo e aprova sempre) é o que
 * o controle embutido no teste mede, com uma superfície que sabidamente tem ZERO sobreviventes.
 */
function matcherDaSuperficie(padrao: string): RegExp {
  let alvo = padrao.replace(/^!/, "").replace(/^\//, "");
  const ehDiretorio = alvo.endsWith("/");
  if (ehDiretorio) alvo = alvo.slice(0, -1);
  const corpo = alvo
    .split("/")
    .map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join("/");
  return new RegExp(`^${corpo}${ehDiretorio ? "/" : "$"}`);
}

/**
 * Avalia a lista contra caminhos HIPOTÉTICOS (arquivos não-rastreados: `.env.local`, auth-token,
 * settings.local.json). Sem isto o teste só veria o que o git já rastreia — e o segredo, por
 * construção, nunca está rastreado. Mesmo motor de matching (git), num repo descartável.
 */
function excluidos(caminhos: string[]): Record<string, boolean> {
  const probe = tmpDescartavel("ah-ossignore-");
  execFileSync("git", ["init", "-q", probe]);
  cpSync(OSSIGNORE, path.join(probe, ".gitignore"));
  let out = "";
  try {
    out = git(probe, ["check-ignore", "--no-index", "--stdin", "-v", "-n"], caminhos.join("\n"));
  } catch (e) {
    // check-ignore sai 1 quando NENHUM caminho casa; a saída ainda vale.
    out = String((e as { stdout?: string }).stdout ?? "");
  }
  const veredito: Record<string, boolean> = {};
  for (const linha of out.split("\n").filter(Boolean)) {
    const [descricao, alvo] = linha.split("\t");
    if (!alvo) continue;
    // `::` = nenhum padrão casou ⇒ VIAJARIA. E um padrão de NEGAÇÃO (`!/packages/storymap-ui/
    // .env.example`) casa mas significa "viaja" — sem esta leitura, um arquivo RE-INCLUÍDO seria
    // reportado como excluído e o teste daria por protegido o que está justamente saindo.
    const padrao = descricao.split(":").slice(2).join(":");
    veredito[alvo] = descricao !== "::" && !padrao.startsWith("!");
  }
  return veredito;
}

/**
 * As superfícies que a lista declara como "é a ferramenta". Um sobrevivente fora daqui é decisão
 * pendente — E uma entrada daqui SEM sobrevivente é declaração morta, cobrada logo abaixo.
 */
/**
 * CAMINHOS QUE A EXTRAÇÃO REALOCA — a origem viaja pela régua, e a etapa 4b do `extract.sh` a move
 * para outro lugar no destino.
 *
 * POR QUE ISTO PRECISA DE UMA ENTRADA PRÓPRIA: os dois guardas [INVERSO] abaixo perguntam "esta
 * declaração/negação tem sobrevivente?". No repositório de ORIGEM a resposta é sim. No repositório
 * EXTRAÍDO — onde esta mesma suíte roda — o arquivo já não está no caminho de origem, então os dois
 * guardas leem a linha como ficção e reprovam. Eles estão certos sobre o que medem; o que faltava era
 * a informação de que houve mudança de endereço.
 *
 * A ISENÇÃO É ESTREITA DE PROPÓSITO: ela só vale quando o caminho de origem NÃO tem sobrevivente E o
 * destino EXISTE nesta árvore. Se a realocação silenciosamente não acontecer, o destino não existe e
 * o guarda dispara igual. E o teste logo acima confere que o `extract.sh` realmente contém a
 * movimentação — sem isso, este objeto seria só um jeito de calar dois guardas escrevendo um caminho.
 */
const RELOCADOS_PELA_EXTRACAO: Record<string, string> = {
  // O guia do agente: mora em `oss/` porque a raiz do umbrella já tem um AGENTS.md que é do umbrella,
  // e vai para a RAIZ do destino, que é onde um agente procura ao clonar um repositório.
  "oss/AGENTS.md": "AGENTS.md",
  "oss/README.md": "README.md",
  "oss/tmpfiles-agileharness.conf": "contrib/tmpfiles-agileharness.conf",
  // A política de segurança e o guia de contribuição: o GitHub só os lê na RAIZ (ou em /.github,
  // /docs), então a extração os leva para lá. No umbrella eles moram em `oss/` porque este monorepo é
  // privado e não tem nenhum dos dois na raiz.
  "oss/SECURITY.md": "SECURITY.md",
  "oss/CONTRIBUTING.md": "CONTRIBUTING.md",
  // As capturas do README. A chave é o DIRETÓRIO que o extract.sh realmente move (`oss/docs/`), e não
  // cada imagem: o roteiro move a pasta inteira, e uma chave por arquivo mentiria sobre o que ele faz
  // — além de exigir que o extract.sh citasse cada nome, que é o teste logo abaixo cobrando ficção.
  // Entradas de diretório terminam em `/` e casam por PREFIXO (ver `foiRealocado`), então
  // `oss/docs/screenshots/` resolve por aqui sem precisar de linha própria.
  "oss/docs/": "docs/",
};

/** True quando o caminho foi realocado E o destino está presente NESTA árvore (ver o objeto acima).
 *
 *  Uma entrada de DIRETÓRIO (chave terminada em `/`) casa por prefixo: `oss/docs/` cobre
 *  `oss/docs/screenshots/`, porque o que o extract.sh move é a pasta. A isenção continua estreita —
 *  ela só vale se o destino MAPEADO existir nesta árvore, então uma movimentação que não aconteceu
 *  reprova exatamente como antes. */
function foiRealocado(caminho: string): boolean {
  const direto = RELOCADOS_PELA_EXTRACAO[caminho];
  if (direto != null) return existsSync(path.join(REPO_ROOT, direto));
  const prefixo = Object.keys(RELOCADOS_PELA_EXTRACAO)
    .filter((k) => k.endsWith("/") && caminho.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (prefixo == null) return false;
  const destino = RELOCADOS_PELA_EXTRACAO[prefixo] + caminho.slice(prefixo.length);
  return existsSync(path.join(REPO_ROOT, destino));
}

/**
 * Passageiros em trânsito: moram em `oss/` no umbrella e são MOVIDOS para a raiz do artefato pela
 * etapa 4b(iv) da extração. Não são moradores de `oss/` (que é maquinário desta margem), e por isso
 * não contam como "vazamento de `oss/`" no teste de completude.
 */
const PASSAGEIROS_EM_TRANSITO = [
  "oss/AGENTS.md",
  // O drop-in de tmpfiles: viaja para `contrib/`, que é o caminho que o bloco de instalação do
  // unit gerado (`--generate-systemd-unit`) manda copiar. Sem ele aquele bloco citava um arquivo
  // que ninguém recebia.
  "oss/tmpfiles-agileharness.conf",
  "oss/README.md",
  "oss/SECURITY.md",
  "oss/CONTRIBUTING.md",
  // As capturas do README. O prefixo (e não os quatro nomes) porque a lista de imagens muda toda vez
  // que a interface muda, e um pino nominal aqui viraria o atrito que faz alguém publicar o README
  // com a foto velha. O DIRETÓRIO é o contrato; a etapa 4b(iv) o move inteiro para `docs/`.
  "oss/docs/screenshots/",
  // O aprofundamento que o README enxuto delega. NOMINAL, e não `oss/docs/` inteiro, de propósito:
  // o prefixo acima existe porque imagem é CHURN, e uma página de documentação não é — declarar o
  // diretório todo faria o próximo `.md` que alguém largar ali viajar sem ninguém decidir nada.
  "oss/docs/how-it-works.md",
];

const SUPERFICIES_QUE_VIAJAM = [
  "packages/storymap-ui/",
  // As GUARDAS do board-data e o runner que as descobre. Três das checagens do `.claude/hooks/` não
  // são política do dono — são o contrato da FERRAMENTA (escrita direta em `storymap/boards/**` no
  // checkout vivo, o gate, a intenção). O artefato publicava as SKILLS do pipeline sem elas, que é a
  // forma nº 1 de dívida desta casa: capacidade declarada com zero produtores. O resto de `hooks/`
  // (bun, just, Firebase, artefatos na raiz) continua excluído, e `settings.json` também — ele carrega
  // `permissions` e `env` da máquina do dono.
  ".claude/hooks/runner.js",
  ".claude/hooks/checks/pre-edit/",
  ".claude/hooks/checks/pre-write/",
  ".claude/hooks/tests/",
  "storymap/boards/_base/",
  // O guia do agente do ARTEFATO. Ele mora em `oss/` porque a raiz do umbrella já tem um AGENTS.md
  // que é do umbrella, e a etapa 4b(iv) do extract.sh o MOVE para a raiz do destino — que é onde um
  // agente procura ao clonar. Sem ele o artefato não tem porta de entrada, e o critério de aceitação
  // da ferramenta ("um agente só com MCP + AGENTS.md…") é incumprível por falta do arquivo.
  "oss/AGENTS.md",
  // O drop-in de tmpfiles, movido para `contrib/`. Ele é BACKSTOP e não garantia — mas até
  // 2026-08-26 o adotante não recebia nem o arquivo nem a informação de que o backstop existe,
  // enquanto o unit gerado por `--generate-systemd-unit` mandava copiá-lo de `contrib/`.
  "oss/tmpfiles-agileharness.conf",
  // As capturas que o README mostra — mesmo mecanismo dos documentos: moram em `oss/` (que é do
  // ARTEFATO) e a etapa 4b(iv) move `oss/docs/` para `docs/` no destino, porque `oss/` não significa
  // nada do lado de lá. Elas são ASSET e não artefato de iteração: são a primeira tela do
  // repositório publicado, e o guarda daquela etapa reprova a extração se o README citar uma que não
  // chegou (imagem quebrada na primeira tela lê como projeto abandonado).
  "oss/docs/screenshots/",
  // A página de aprofundamento. O README foi enxugado para responder "o que é / como comparo / como
  // rodo" na primeira tela, e o porquê + as técnicas mudaram de casa em vez de sumir. Declarada por
  // NOME pelo motivo do comentário gêmeo em PASSAGEIROS_EM_TRANSITO.
  "oss/docs/how-it-works.md",
  // O README do artefato — mesmo mecanismo, mesmo motivo: um repositório aberto sem README não se
  // explica a ninguém, e a raiz do umbrella já tem o dele.
  "oss/README.md",
  // A política de segurança e o guia de contribuição do artefato — mesmo mecanismo, e o caminho é o
  // que decide: enterrada em `packages/`, a política não vira a aba Security do GitHub nem o botão de
  // reporte privado, e o primeiro relato de falha chega como issue público.
  "oss/SECURITY.md",
  "oss/CONTRIBUTING.md",
  ".claude/commands/harness.md",
  ".claude/skills/harness-",
  ".claude/skills/storymap-orchestrator/",
  ".claude/storymap-assistants/",
  "scripts/capability-probe/",
  // O scan de segredo e o hook que o dispara. Viajam JUNTOS de propósito: num repositório privado
  // no plano Free o GitHub não oferece push protection, e o `scan-snapshot-secrets.mjs` que o CI
  // roda mede a árvore DEPOIS do commit — o hook é a única prevenção ANTES. `install.sh` é como
  // ele deixa de ser um arquivo parado e vira o hook de `.git/hooks`.
  "scripts/git-hooks/scan-secrets.mjs",
  "scripts/git-hooks/pre-commit.sh",
  "scripts/git-hooks/install.sh",
  "scripts/visual-sweep.mjs",
  // Arquivos de RAIZ: o Nível 0 (`/*`) os comia e só sabia devolver DIRETÓRIO. Nenhum deles quebra
  // um build ao faltar — o dano (licença ausente, build não reproduzível, régua não auditável) só
  // aparece depois de publicado.
  "LICENSE",
  "NOTICE",
  "package.json",
  "bun.lock",
  ".ossignore",
  // O CI que a equipe escreveu PARA o repo novo, e o ferramental que os workflows invocam por
  // caminho literal (`node scripts/security/…`). Sem os dois pares juntos o destino recebe um gate
  // que nunca reprova.
  "oss/ci/",
  "scripts/security/",
  // A raiz de storymap/: o esquema que o onboarding preenche, o mount que a sonda de capacidade lê,
  // e a documentação do pipeline Stage→Step que É a ferramenta.
  "storymap/settings.yaml",
  "storymap/qa-mcp.json",
  "storymap/README.md",
  "storymap/frameworks.md",
  // Os dois boards de DEMONSTRAÇÃO (livraria fictícia, dado sintético) — o SUJEITO da suíte. Não são
  // exceção à regra "board real não viaja": são o que a torna sustentável. Sem eles a extração
  // chegava ao destino com ~40 provas em ENOENT e as travas anti-vácuo reprovando por não ter o que
  // medir. Derivados de `FIXTURE_BOARDS` de propósito — o nome do fixture mora em UM lugar.
  ...FIXTURE_BOARDS.map((id) => `storymap/boards/${id}/`),
];

/**
 * As 7 quebras medidas em 2026-08-06, arquivo por arquivo. A cobrança por SUPERFÍCIE (acima) aceita
 * "≥ 1 sobrevivente" e por isso não distingue `scripts/security/` inteiro de um único .mjs dela; a
 * cobrança NOMINAL fixa exatamente o que o repo novo precisa ter na mão.
 */
const QUEBRAS_QUE_TEM_DE_VIAJAR: Record<string, string[]> = {
  "raiz — licença, atribuição, workspace, lockfile e a própria régua": [
    "LICENSE",
    "NOTICE",
    "package.json",
    "bun.lock",
    ".ossignore",
  ],
  "scripts/security/ — o que os workflows de oss/ci/ invocam por caminho literal": [
    "scripts/security/check-licenses.mjs",
    "scripts/security/generate-sbom.mjs",
    "scripts/security/lib/dep-closure.mjs",
    "scripts/security/lint-workflows.mjs",
    "scripts/security/osv-query.mjs",
    "scripts/security/scan-snapshot-secrets.mjs",
    "scripts/security/secret-baseline-allowlist.json",
    "scripts/security/vex-dispositions.json",
    "scripts/security/vex-gate.mjs",
  ],
  "oss/ci/ — o CI escrito para o repo novo (único diretório cujo endereço JÁ É o destino)": [
    "oss/ci/CODEOWNERS",
    "oss/ci/README.md",
    "oss/ci/dependabot.yml",
    "oss/ci/workflows/ci.yml",
    "oss/ci/workflows/security.yml",
  ],
  "storymap/ — o que a ferramenta precisa para ser configurada e entendida": [
    "storymap/settings.yaml",
    "storymap/qa-mcp.json",
    "storymap/README.md",
    "storymap/frameworks.md",
    "storymap/boards/_base/board.yaml",
  ],
};

/**
 * CONTROLE do matcher: uma superfície POVOADA (rastreada) e INTEIRAMENTE cortada pela régua. Sem
 * ela, o `toBe(0)` do medidor não distingue "a régua cortou" de "o regex não casa nada".
 *
 * `scripts/ops/` é o controle NOMEADO, escolhido por medição e não por conveniência: 12 arquivos
 * rastreados, zero sobreviventes. Foi o par `!/scripts/ops/` + `/scripts/ops/*`, declarado e vazio,
 * que ficou anos verde justamente porque este arquivo só sabia cobrar "sobrevivente ⇒ declarado".
 *
 * Mas ele é do LADO DE CÁ. No repositório extraído a régua já foi aplicada e o que ela corta não
 * chega lá: `scripts/ops/` não está rastreado no destino, e o piso do próprio controle
 * (`toBeGreaterThan(0)`, que existe para o zero de baixo não ser zero de lista vazia) reprovava a
 * árvore CERTA. A saída não é dispensar o controle — é ESCOLHÊ-LO da árvore medida: o nomeado
 * primeiro e, se ele não estiver rastreado aqui, a maior superfície que a régua desta árvore corta
 * INTEIRA. Não havendo nenhuma, isto LANÇA: uma árvore em que a régua não corta nada não pode
 * atestar que o medidor discrimina.
 */
const CONTROLE_NOMEADO = "scripts/ops/";

/** Superfícies candidatas lidas do que a régua cortou: diretório de topo, ou o arquivo exato. */
function superficiesCortadas(excluidos: Set<string>): string[] {
  const contagem = new Map<string, number>();
  for (const p of excluidos) {
    const barra = p.indexOf("/");
    const superficie = barra === -1 ? p : `${p.slice(0, barra)}/`;
    contagem.set(superficie, (contagem.get(superficie) ?? 0) + 1);
  }
  return [...contagem.entries()].sort((a, b) => b[1] - a[1]).map(([superficie]) => superficie);
}

function controleCortado(rastreados: string[], excluidos: Set<string>): string {
  for (const superficie of [CONTROLE_NOMEADO, ...superficiesCortadas(excluidos)]) {
    const rx = matcherDaSuperficie(superficie);
    const naArvore = rastreados.filter((p) => rx.test(p));
    // POVOADA nesta árvore E cortada INTEIRA: um sobrevivente sequer e ela não serve de controle,
    // porque o zero esperado deixaria de ser o veredito da régua.
    if (naArvore.length > 0 && naArvore.every((p) => excluidos.has(p))) return superficie;
  }
  throw new Error(
    `nenhuma superfície POVOADA e inteiramente cortada nesta árvore (${excluidos.size} rastreados ` +
      `excluídos, controle nomeado "${CONTROLE_NOMEADO}" ausente ou parcial). Sem controle, o zero ` +
      "do medidor não distingue régua aplicada de regex que não casa nada.",
  );
}

describe("lista de exclusão da extração OSS — /.ossignore (story-vhragr)", () => {
  it("a lista existe na raiz do repositório, e a raiz é a que o git varre (é ela que a extração consome)", () => {
    expect(existsSync(OSSIGNORE), `.ossignore ausente em ${REPO_ROOT} — sem lista, a extração é feita de memória`).toBe(
      true,
    );
    // `.git` no lugar de `turbo.json`: o marcador universal, válido como ARQUIVO (worktree linkado).
    expect(existsSync(path.join(REPO_ROOT, ".git")), `raiz resolvida errada: ${REPO_ROOT} não tem .git`).toBe(true);
    // E a âncora FORTE, que a antiga não tinha: presença de marcador não prova que a varredura é
    // desta árvore. Topo do git ≠ raiz medida é o instrumento medindo o repositório vizinho.
    expect(
      realpathSync(git(REPO_ROOT, ["rev-parse", "--show-toplevel"]).trim()),
      "o git que faz a varredura não tem esta raiz como topo",
    ).toBe(realpathSync(REPO_ROOT));
    // E a TESTEMUNHA, medida: "é UMA raiz de repositório" não é "é ESTA árvore". Apontado para o
    // checkout vizinho, este caso passava nas duas linhas acima — ele é raiz, e é topo de si mesmo.
    // O que distingue é o arquivo em execução: ele tem de estar rastreado NA raiz que se está medindo.
    expect(
      git(REPO_ROOT, ["ls-files"]).split("\n").filter(Boolean),
      `${REPO_ROOT} é uma raiz de repositório, mas não a que contém este arquivo — instrumento apontado ` +
        "para a árvore vizinha",
    ).toContain(relativoAoRepo(ESTE_ARQUIVO));
  });

  it("[ATAQUE] nenhum board REAL do dono viaja — só o `_base` e os fixtures de demonstração", () => {
    const { viajam } = conjuntos();
    // O que PODE atravessar sob `storymap/boards/`: a pipeline canônica (`_base`) e os dois boards
    // de DEMONSTRAÇÃO, que são dado sintético e o sujeito da suíte. Qualquer outro diretório aqui é
    // board de produto do dono — cards, planos, wireframes, entrevistas — e sobrevivente nenhum.
    const PERMITIDOS = ["storymap/boards/_base/", ...FIXTURE_BOARDS.map((id) => `storymap/boards/${id}/`)];
    const boards = viajam.filter(
      (p) => p.startsWith("storymap/boards/") && !PERMITIDOS.some((ok) => p.startsWith(ok)),
    );
    expect(
      boards.slice(0, 20),
      "Card/plano/wireframe/feedback de board real sobreviveu à lista — isso publica o roadmap de 4 produtos.",
    ).toEqual([]);

    // O OUTRO SENTIDO, e é ele que impede esta asserção de virar vácuo. A linha acima fica verde de
    // graça se `storymap/boards/` inteiro parar de viajar — foi assim que a extração nasceu com ~40
    // provas em ENOENT. Aqui se cobra que cada fixture tenha board.yaml E cards do outro lado: é a
    // trava que reprova, no merge gate, quem apagar a negação `!/storymap/boards/<fixture>/` da
    // régua. Vale nas DUAS árvores (umbrella e repositório extraído) — o fixture existe nas duas.
    for (const id of FIXTURE_BOARDS) {
      const doFixture = viajam.filter((p) => p.startsWith(`storymap/boards/${id}/`));
      expect(doFixture, `o board de teste "${id}" parou de viajar — a suíte do repo extraído fica sem sujeito`).toContain(
        `storymap/boards/${id}/board.yaml`,
      );
      expect(
        doFixture.filter((p) => p.startsWith(`storymap/boards/${id}/cards/`)).length,
        `"${id}" viajou sem cards — board.yaml sozinho não sustenta prova nenhuma`,
      ).toBeGreaterThan(0);
    }
  });

  it("[ATAQUE] nenhum pacote do ecossistema PlayPack viaja — só a ferramenta", () => {
    const { viajam } = conjuntos();
    const outros = viajam.filter((p) => p.startsWith("packages/") && !p.startsWith("packages/storymap-ui/"));
    expect(outros.slice(0, 20), "Código de produto do dono sobreviveu à lista.").toEqual([]);
  });

  it("[ATAQUE] os relatórios internos de estratégia e o manual da VPS não viajam", () => {
    const { viajam } = conjuntos();
    const vazados = viajam.filter((p) =>
      /^packages\/storymap-ui\/(PLANO-|RELATORIO-|\.claude\/)/.test(p),
    );
    expect(
      vazados,
      "Relatório de posicionamento/evolução (58K de tese sobre o mercado) ou o CLAUDE.md da VPS do dono viajaria.",
    ).toEqual([]);
  });

  it("[ATAQUE] segredo e estado operacional estão cobertos mesmo NÃO estando rastreados", () => {
    const alvos = [
      "packages/storymap-ui/.env.local",
      "packages/storymap-ui/.env",
      "packages/storymap-ui/.env.producao.local",
      "storymap/.runner/auth-token",
      "storymap/.runner/session-secret",
      ".claude/settings.local.json",
      ".mcp.json",
      "storymap/graphify/acme.json",
      "packages/acmeapp/api/.env",
    ];
    const veredito = excluidos(alvos);
    const escaparam = alvos.filter((p) => !veredito[p]);
    expect(escaparam, "Caminho com segredo/estado do dono NÃO é coberto pela lista de exclusão.").toEqual([]);
  });

  it("a lista não é teatro: o motor da ferramenta VIAJA", () => {
    const { viajam } = conjuntos();
    const set = new Set(viajam);
    for (const obrigatorio of [
      "packages/storymap-ui/package.json",
      "packages/storymap-ui/.env.example",
      "packages/storymap-ui/src/lib/storymap/repo.ts",
      "packages/storymap-ui/src/lib/storymap/runner/engine.ts",
      "packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts",
      "packages/storymap-ui/src/server/main.ts",
      "storymap/boards/_base/board.yaml",
      ".claude/commands/harness.md",
      ".claude/skills/harness-do/SKILL.md",
      "scripts/git-hooks/scan-secrets.mjs",
      "scripts/git-hooks/pre-commit.sh",
    ]) {
      expect(set.has(obrigatorio), `${obrigatorio} É a ferramenta e a lista o excluiu — o repo novo não sobe`).toBe(true);
    }
    // Piso grosseiro: a ferramenta são centenas de arquivos. Uma lista que deixasse passar só o
    // package.json satisfaria as asserções acima e não entregaria nada.
    const fonte = viajam.filter((p) => p.startsWith("packages/storymap-ui/src/"));
    expect(fonte.length).toBeGreaterThan(300);
  });

  it("a lista permanece honesta: todo sobrevivente está numa superfície DECLARADA", () => {
    const { viajam } = conjuntos();
    const semDono = viajam.filter((p) => !SUPERFICIES_QUE_VIAJAM.some((s) => p.startsWith(s)));
    expect(
      semDono.slice(0, 30),
      "Caminho novo sobreviveu sem estar declarado como parte da ferramenta. Decida: é a ferramenta " +
        "(negue no .ossignore E declare aqui) ou é do dono (deixe excluído). Silêncio aqui é vazamento amanhã.",
    ).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // O OUTRO SENTIDO. Tudo acima cobra "sobrevivente ⇒ declarado". Nada cobrava
  // "declarado ⇒ sobrevivente", e por isso uma superfície podia ser declarada e estar VAZIA sem
  // ninguém notar — exatamente o que aconteceu com `!/scripts/ops/`, que existia para um
  // `harness-run-sandbox.sh` apagado em 2026-08-05. Declaração morta não é neutra: quem lê a régua
  // entende "isto viaja", e a próxima pessoa escreve a extração acreditando nela.
  // ───────────────────────────────────────────────────────────────────────────

  it("a varredura não é vácuo: o instrumento lê a árvore REAL antes de qualquer veredito", () => {
    const { rastreados, viajam, excluidos, piso, comoFoiMedido } = conjuntos();
    // O piso é derivado a cada passada, e por isso ele próprio precisa de guarda: um derivador que
    // medisse zero devolveria um piso que qualquer varredura satisfaz — o vácuo entrando pela porta
    // que foi construída para fechá-lo.
    expect(piso, `o piso derivado mediu zero (${comoFoiMedido}) — o derivador é que está quebrado`).toBeGreaterThan(0);
    // Sem este piso, `REPO_ROOT` errado ⇒ listas vazias ⇒ toda asserção de AUSÊNCIA acima fica
    // verde por não medir nada. Um teste que passa medindo zero é o defeito, não a aprovação.
    expect(rastreados.length, `git ls-files não leu a árvore (piso derivado: ${comoFoiMedido})`).toBeGreaterThanOrEqual(
      piso,
    );
    expect(viajam.length, "conjunto que viaja colapsou").toBeGreaterThanOrEqual(piso);
    // E o `--exclude-from` de fato cortou algo: se `excluidos` viesse vazio, `viajam` seria a
    // árvore inteira e as asserções de ausência reprovariam — mas o inverso (excluir tudo) já é
    // pego pelo piso acima. Este par fixa que a régua está sendo APLICADA, não ignorada.
    expect(excluidos.size, ".ossignore não excluiu arquivo nenhum — a régua não foi aplicada").toBeGreaterThan(0);
    expect(viajam.length, "a régua deixou passar a árvore inteira").toBeLessThan(rastreados.length);
  });

  it("o medidor de superfície sabe reprovar: uma superfície POVOADA e cortada mede ZERO", () => {
    const { rastreados, viajam, excluidos } = conjuntos();
    const superficie = controleCortado(rastreados, excluidos);
    const rx = matcherDaSuperficie(superficie);
    // O 0 abaixo só vale como controle se houver o que contar. A escolha do controle já exigiu isso;
    // esta linha cobra de novo pelo CAMINHO DO MEDIDOR (o regex), que é o que está sendo posto à
    // prova — um matcher quebrado zera aqui em vez de zerar silenciosamente lá embaixo.
    expect(
      rastreados.filter((p) => rx.test(p)).length,
      `o controle "${superficie}" não é POVOADO pelo medidor — o zero abaixo seria zero de lista ` +
        "vazia, e não prova que o medidor discrimina.",
    ).toBeGreaterThan(0);
    expect(
      viajam.filter((p) => rx.test(p)).length,
      `o controle "${superficie}" voltou a viajar — se isso é intencional, declare a superfície; ` +
        "se não, a régua abriu material que ela cortava (em `scripts/ops/`, a operação do dono: " +
        "error-report.js fala com o GCP dele).",
    ).toBe(0);
    // E o mesmo matcher, apontado para uma superfície viva, conta > 0. Sem este segundo lado o
    // zero acima poderia ser um regex quebrado que nunca casa nada.
    expect(viajam.filter((p) => matcherDaSuperficie("scripts/").test(p)).length).toBeGreaterThan(0);
  });

  it("a exceção de realocação é ELA MESMA verificada — não é uma isenção de confiança", () => {
    // Sem este teste, `RELOCADOS_PELA_EXTRACAO` seria um jeito de calar os dois guardas escrevendo
    // um caminho num objeto. Aqui a exceção precisa GANHAR o direito de existir: o extract.sh tem de
    // realmente conter a movimentação, e o destino tem de ser um caminho de raiz (é o ponto dela).
    const roteiro = (() => {
      try {
        return readFileSync(path.join(REPO_ROOT, "oss", "extract.sh"), "utf8");
      } catch {
        return null; // árvore SEM o extract.sh = o artefato; lá não há o que conferir
      }
    })();
    expect(Object.keys(RELOCADOS_PELA_EXTRACAO).length, "objeto de realocação vazio — o teste mediria nada").toBeGreaterThan(0);
    for (const [origem, destino] of Object.entries(RELOCADOS_PELA_EXTRACAO)) {
      // A propriedade é SAIR de `oss/` — esse é o ponto inteiro da realocação: do lado de lá do corte
      // o nome `oss/` não significa nada. Antes esta linha exigia `!destino.includes("/")`, o que
      // codificava a forma dos QUATRO primeiros casos (arquivo solto na raiz) e não a propriedade;
      // um diretório que aterrissa em `docs/` cumpre o mesmo contrato e reprovava por formato.
      expect(destino, `${origem}: uma realocação que continua em oss/ não realoca nada`).not.toMatch(/^oss\//);
      expect(destino, `${origem}: o destino tem de ser de raiz (1 ou 2 segmentos), não enterrado`)
        .toMatch(/^[^/]+\/?$|^[^/]+\/[^/]+\/?$/);
      if (roteiro) {
        expect(roteiro, `extract.sh não menciona a origem ${origem} — a realocação declarada não existe no roteiro`).toContain(origem);
        expect(roteiro, `extract.sh não menciona o destino ${destino}`).toContain(destino);
      }
    }
  });

  it("[PROVENIÊNCIA] o carimbo `-sujo` mede o conjunto que VIAJA, não a árvore inteira", () => {
    // MEDIDO em 2026-08-27, publicando `7770cf7`: o único arquivo modificado na origem era
    // `.claude/settings.local.json` — que ESTA régua exclui. O artefato reproduzia perfeitamente a
    // partir do HEAD nu, e mesmo assim o commit publicado saiu carimbado `<sha>-sujo`.
    //
    // O dano não é cosmético. O assunto do commit inicial é a ÚNICA linha que liga o artefato
    // publicado à árvore que o produziu: é por ela que alguém com acesso à origem confere se o que
    // está lendo foi mesmo gerado do que diz ter sido. Um `-sujo` que dispara por arquivo que não
    // viaja é alarme falso na única linha auditável — e alarme falso repetido é alarme que ninguém
    // mais lê, o que apaga o sinal no dia em que ele for verdadeiro.
    //
    // A propriedade: a resposta vem da MESMA `viaja.txt` que decide o que é copiado. Por construção
    // as duas não podem divergir — que é exatamente o que a versão antiga permitia, medindo
    // `git status --porcelain` da árvore toda enquanto copiava só os rastreados que a régua deixa
    // passar.
    const roteiro = (() => {
      try {
        return readFileSync(path.join(REPO_ROOT, "oss", "extract.sh"), "utf8");
      } catch {
        return null; // árvore SEM o extract.sh = o artefato
      }
    })();

    // AS DUAS ÁRVORES TÊM UMA PROPRIEDADE, E NENHUMA DELAS É "não medir". Um `return` mudo aqui
    // REPROVA — `vitest.config.ts` declara `expect.requireAssertions`, e um caso que sai sem
    // asserção nenhuma é indistinguível de um caso que esqueceu de medir. MEDIDO em 2026-08-27: a
    // suíte local passou verde (o `extract.sh` existe aqui) e só a verificação NO DESTINO acusou,
    // que é exatamente o ponto cego que a extração existe para cobrir.
    if (roteiro == null) {
      // No artefato a propriedade é a AUSÊNCIA: o extrator é maquinário do lado de cá — ele lê a
      // régua do monorepo privado e conhece a topologia dele. Publicá-lo entregaria o roteiro de
      // corte junto com o que foi cortado.
      expect(
        existsSync(path.join(REPO_ROOT, "oss", "extract.sh")),
        "`oss/extract.sh` chegou ao artefato — o roteiro de corte é maquinário da origem e não viaja",
      ).toBe(false);
      return;
    }
    expect(roteiro.length, "extract.sh vazio — o caso ficaria verde sem medir").toBeGreaterThan(2000);

    // (i) o carimbo é decidido pela INTERSEÇÃO com o que viaja
    expect(
      roteiro,
      "o carimbo de proveniência precisa cruzar os sujos com `viaja.txt` — sem o cruzamento ele " +
        "volta a medir a árvore inteira e a reprovar publicação reproduzível",
    ).toMatch(/SUJOS_VIAJANTES[\s\S]{0,400}viaja\.txt/);

    // (ii) e a pergunta é "difere do HEAD?" para RASTREADOS — não-rastreado nunca entra em
    //      `viaja.txt`, então contá-lo era metade do falso positivo.
    expect(roteiro, "a medição de sujeira precisa ser `git diff --name-only HEAD` (rastreados)").toContain(
      "diff --name-only HEAD",
    );

    // (iii) ATAQUE: a linha exata que produzia o falso positivo não pode voltar.
    expect(
      /SHA_ORIGEM="\$\{SHA_ORIGEM\}-sujo"[\s\S]{0,80}$/m.test(roteiro) &&
        /if \[\[ "\$SUJO" != "0" \]\]; then SHA_ORIGEM=/.test(roteiro),
      "o carimbo voltou a sair de `$SUJO` (contagem da árvore inteira) em vez do conjunto que viaja",
    ).toBe(false);

    // (iv) NÃO-VACUIDADE do ataque: a variável que ele proíbe usar para carimbar ainda EXISTE no
    //      roteiro (ela continua servindo para a nota informativa). Sem esta linha, um `extract.sh`
    //      que deixasse de medir sujeira por completo passaria em (iii) por ausência.
    expect(roteiro, "`$SUJO` sumiu do roteiro — o ataque de (iii) ficaria verde por vacuidade").toContain("SUJO=");
  });

  it("[INVERSO] toda superfície declarada NESTE teste tem pelo menos um sobrevivente", () => {
    const { viajam } = conjuntos();
    const mortas = SUPERFICIES_QUE_VIAJAM.filter((s) => !viajam.some((p) => p.startsWith(s)) && !foiRealocado(s));
    expect(
      mortas,
      "Superfície declarada aqui como 'é a ferramenta' e sem NENHUM sobrevivente. Ou a régua parou " +
        "de deixá-la passar (regressão silenciosa), ou os arquivos sumiram e a declaração virou " +
        "ficção. Apague a entrada ou conserte a régua — deixar as duas coisas é o vácuo-verde.",
    ).toEqual([]);
  });

  it("[INVERSO] toda NEGAÇÃO da própria régua tem pelo menos um sobrevivente (regra inerte reprova)", () => {
    const { viajam } = conjuntos();
    const negacoes = negacoesDaRegua();
    // Não-vacuidade do próprio parser: régua sem negação nenhuma tornaria este teste verde por
    // lista vazia. A régua é um denylist TOTAL — sem negações ela não deixa passar nada.
    expect(negacoes.length, "nenhuma linha de negação lida do .ossignore — parser ou caminho quebrado").toBeGreaterThan(
      15,
    );
    const inertes = negacoes.filter(
      (n) => !viajam.some((p) => matcherDaSuperficie(n).test(p)) && !foiRealocado(n.replace(/^!\//, "")),
    );
    expect(
      inertes,
      "Linha `!` na régua que não devolve arquivo NENHUM. Regra inerte lê-se como decisão ('isto " +
        "viaja') e não é: foi assim que `!/scripts/ops/` sobreviveu ao arquivo que ele protegia. " +
        "Ou a negação está mal escrita (gitignore exige re-incluir CADA nível de um diretório " +
        "excluído), ou o alvo não existe mais e a linha tem de sair.",
    ).toEqual([]);
  });

  it("[QUEBRAS] os arquivos nomeados das 7 quebras viajam, um a um", () => {
    const { viajam } = conjuntos();
    const set = new Set(viajam);
    const faltando: string[] = [];
    for (const [grupo, arquivos] of Object.entries(QUEBRAS_QUE_TEM_DE_VIAJAR)) {
      for (const arquivo of arquivos) {
        if (!set.has(arquivo)) faltando.push(`${arquivo}  (${grupo})`);
      }
    }
    expect(
      faltando,
      "Arquivo que o repo novo precisa e que a régua está comendo. `/*` mata a raiz inteira e só " +
        "negação explícita a devolve — e negar dentro de um diretório excluído exige re-incluir " +
        "cada nível acima.",
    ).toEqual([]);
  });

  it("[QUEBRAS] o ferramental de CI viaja COMPLETO — gate com peça faltando é gate que não reprova", () => {
    const { viajam } = conjuntos();
    // Contagem, não só presença: os workflows de `oss/ci/` chamam `node scripts/security/…` por
    // caminho literal. Um único .mjs ausente vira job vermelho no primeiro PR do repo novo — ou,
    // pior, um `|| true` que alguém acrescenta para destravar e que apaga o gate de vez.
    expect(viajam.filter((p) => p.startsWith("scripts/security/")).length, "scripts/security/ incompleto").toBe(9);
    // 6 desde 2026-08-25: `keepalive.yml` entrou (era 5 = ci.yml + security.yml + o README do
    // diretório + os 2 do `.github/` montado). O pino é a REVISÃO: mexer no número obriga a dizer o
    // que entrou e por quê, em vez de um workflow novo aparecer no artefato publicado sem ninguém
    // olhar. `keepalive.yml` é o ÚNICO com `contents: write` — exatamente a classe que não pode
    // entrar em silêncio.
    expect(viajam.filter((p) => p.startsWith("oss/ci/")).length, "oss/ci/ incompleto").toBe(6);
    // `oss/extract.sh` é maquinário do LADO DE CÁ (embute o caminho do umbrella). Ficar de fora é
    // escolha escrita na régua; se um dia viajar, é decisão nova e tem de ser tomada de novo.
    //
    // As exceções são NOMINAIS de propósito: estes arquivos não FICAM em `oss/` no destino — a etapa
    // 4b(iv) do extract.sh os move para a raiz, e o guarda de lá reprova a extração se não chegarem.
    // `oss/` segue sendo "maquinário desta margem"; eles são passageiros em trânsito, não moradores.
    // Uma lista por NOME, e não um `oss/*.md` aberto, porque a próxima coisa que alguém largar em
    // `oss/` tem de bater neste teste de novo — e a mesma lista é cobrada, arquivo a arquivo, no
    // PISO_ARQUIVOS do extrator: aqui prova que viajam, lá prova que chegam.
    //
    // UMA entrada pode ser um DIRETÓRIO (sufixo `/`), e a exceção é estreita de propósito. As
    // capturas do README mudam toda vez que a interface muda: um pino nominal aqui viraria o atrito
    // que faz alguém publicar o README com a foto velha — o mesmo tipo de dano que esta lista existe
    // para evitar, pela outra ponta. A garantia não se perde, sobe um nível: um arquivo largado em
    // `oss/` continua batendo neste teste, a menos que caia DENTRO de um diretório que já foi
    // declarado aqui, com o motivo escrito ao lado.
    const declarado = (p: string) =>
      PASSAGEIROS_EM_TRANSITO.some((d) => (d.endsWith("/") ? p.startsWith(d) : p === d));
    expect(
      viajam.filter((p) => p.startsWith("oss/") && !p.startsWith("oss/ci/") && !declarado(p)),
      "oss/ além de ci/ (e dos passageiros em trânsito declarados)",
    ).toEqual([]);
  });
});

// ── AS GUARDAS QUE AS SKILLS PUBLICADAS PRESSUPÕEM ──────────────────────────────────────────────────
// O artefato publica o pipeline inteiro em skills. Três checagens do `.claude/hooks/` não são política
// do DONO — são o contrato do board-data, isto é, da FERRAMENTA: elas impedem um agente de escrever
// `storymap/boards/**` por fs no checkout onde o serviço está vivo (o lock que serializa card é
// IN-PROCESS; contra outro processo é last-writer-wins, e foi assim que dois blockers fechados
// reabriram sozinhos), e cobram o gate e a intenção.
//
// Publicá-las era o que faltava, e a falta tinha a forma mais comum de dívida desta casa: capacidade
// declarada com zero produtores — o adotante recebia o pipeline e nenhuma das travas que o tornam
// seguro. Este caso é SEMÂNTICO, não estrutural: a régua já cobra "toda negação tem sobrevivente", o
// que passaria igual se alguém apagasse as negações. Aqui a afirmação é sobre o que o artefato PRECISA
// ter, e por isso ela reprova quem as remover.
describe("o artefato leva as guardas que as skills dele pressupõem", () => {
  const EXIGIDAS = [
    ".claude/hooks/runner.js", // sem ele as checagens são arquivos inertes: é quem as descobre
    ".claude/hooks/checks/pre-edit/block-runtime-board-writes.js",
    ".claude/hooks/checks/pre-write/block-runtime-board-writes.js",
    ".claude/hooks/checks/pre-edit/validate-storymap-gate.js",
    ".claude/hooks/checks/pre-write/validate-storymap-gate.js",
    ".claude/hooks/checks/pre-edit/guard-business-intent.js",
    ".claude/hooks/checks/pre-write/guard-business-intent.js",
  ];

  it("as sete peças atravessam a régua", () => {
    const { viajam } = conjuntos();
    const conjunto = new Set(viajam);
    const faltando = EXIGIDAS.filter((p) => !conjunto.has(p));
    expect(
      faltando,
      "o artefato publicaria as skills do pipeline SEM as travas que elas pressupõem — " +
        "capacidade declarada com zero produtores:\n" +
        faltando.join("\n"),
    ).toEqual([]);
  });

  // O par: o `settings.json` do dono NÃO pode viajar junto. Além do wiring ele carrega `permissions` e
  // `env` da máquina dele — publicá-lo entregaria a allowlist de um estranho como se fosse padrão.
  it("…e o settings.json do DONO continua fora", () => {
    const { viajam } = conjuntos();
    expect(viajam.filter((p) => p.startsWith(".claude/settings"))).toEqual([]);
  });
});
