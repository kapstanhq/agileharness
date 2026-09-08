// ── QUAL ÁRVORE ESTÁ SOB TESTE: o umbrella, ou o artefato que ele produz? ────────────────────────────
//
// `oss/extract.sh` monta o repositório público a partir deste monorepo, e a régua (`/.ossignore`) deixa
// DELIBERADAMENTE de fora um punhado de arquivos que são do DONO, não da ferramenta: o `justfile` do
// monorepo, `scripts/deploy/**` (a face composta mosaico.app), `docs/**`. Vários testes desta suíte asseram
// sobre eles — e a suíte VIAJA. No destino esses testes morriam em ENOENT.
//
// O conserto errado (e fácil) é `if (!existsSync(x)) return`. Isso produz portão verde que não mediu
// nada, e o mesmo `return` cego passa a esconder o dia em que o arquivo sumir DO UMBRELLA — que é
// exatamente o que o guarda existia para pegar. Este módulo troca o silêncio por uma decisão declarada:
//
//   · a árvore se identifica por DOIS sinais independentes que têm de concordar (ver `arvore()`);
//   · todo arquivo umbrella-only é DECLARADO aqui, com o motivo, num só lugar auditável;
//   · ausência no umbrella LANÇA; ausência no extraído devolve `null` e GRITA no console;
//   · e `oss-tree.test.ts` cobra os dois sentidos: nada declarado pode estar morto no umbrella, e nada
//     declarado pode ter VAZADO para o artefato.
//
// A régua também é assimétrica no outro sentido, e é o ponto mais fácil de errar: um teste de PRODUTOR
// ("alguém executa este gate?") não pode procurar o produtor pelo nome do produtor do umbrella. O gate de
// segredo da publicação tem DOIS produtores — o alvo `oss-snapshot-gate` do justfile (que fica) e o passo
// homônimo de `oss/ci/workflows/ci.yml` (que viaja, e é o único produtor do repo público). Procurar só o
// primeiro deixaria o artefato publicado sem NENHUMA cobrança de que seu CI liga o gate. Por isso
// `produtoresDaPublicacao()` enumera os produtores DA ÁRVORE, e os testes cobram cada um.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A raiz, resolvida a partir da LOCALIZAÇÃO DESTA FONTE — não por `findRepoRoot()`.
 * De propósito: `findRepoRoot()` obedece a `STORYMAP_TARGET`, e casos que apontam o alvo para um
 * diretório de teste fariam este módulo classificar a árvore errada. A pergunta "de que árvore este
 * arquivo faz parte?" só tem uma resposta honesta, e ela é o caminho do próprio arquivo.
 */
export const OSS_TREE_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

/** O script que o gate de publicação executa, em qualquer produtor. */
export const GATE_DE_PUBLICACAO = "scripts/security/scan-snapshot-secrets.mjs";

/** O alvo/passo que roda o gate ESCOPADO pela régua — o que mede o artefato, não o monorepo. */
export const ALVO_DA_PUBLICACAO = "oss-snapshot-gate";

/**
 * Os arquivos que, POR DECISÃO DA RÉGUA, existem só neste monorepo. Chave = caminho relativo à raiz;
 * valor = por que ele não viaja E o que se perde no artefato quando ele falta. O motivo é cobrado no
 * console do repo extraído: quem roda a suíte lá tem de saber o que deixou de ser medido.
 */
export const SO_DO_UMBRELLA: Readonly<Record<string, string>> = {
  justfile:
    "o justfile é infra deste monorepo (a régua o exclui explicitamente). No repo extraído o produtor " +
    "equivalente é oss/ci/workflows/ci.yml, e `produtoresDaPublicacao()` o encontra lá.",
  "docs/plans/agileharness-oss/09-plano-multirepo-e-extracao.md":
    "docs/ inteiro fica — é o plano de extração desta casa, escrito PARA o umbrella, e cita a VPS do " +
    "dono. A metade do guarda que lê o documento (o F0 executado está descrito? as exceções estão " +
    "NOMEADAS?) só faz sentido onde o documento existe. A outra metade — o conjunto de arquivos que " +
    "emitem a flag de pular permissão, e o gate de cada injeção do bypass de root — varre a ÁRVORE, " +
    "que viaja, e continua incondicional no artefato: é ela que pega um emissor novo. " +
    // ⚠ NEM o nome da flag NEM o do env aparecem escritos neste texto, e os dois foram removidos
    // depois de DISPARAREM detectores reais: `oss-docs-truth.test.ts` acusou este arquivo como
    // emissor da flag, e o lint de dívida de `autonomy-sandbox.test.ts` o acusou como sítio novo do
    // bypass. Nos dois casos era prosa dentro de string literal, e nos dois casos os detectores
    // fizeram a coisa certa: eles varrem linha de CÓDIGO e não têm como distinguir explicação de
    // `push(...)`. Um registro de MOTIVOS cita naturalmente o que os detectores procuram, então a
    // regra deste arquivo é DESCREVER sem NOMEAR. Custa uma frase; o contrário custa um detector
    // afrouxado, e aí um caminho de spawn sem jaula passa batido.
    "(os nomes literais ficam fora deste texto — ver comentário no fonte).",
  ".mcp.json":
    "o `.mcp.json` da raiz é a configuração MCP DESTE checkout (servidores da máquina do dono). A " +
    "propriedade sob teste é negativa — 'a raiz NÃO declara um chrome-devtools global' — e num repo " +
    "sem `.mcp.json` ela é verdadeira por vacuidade, que é pior que não medir. No artefato quem cobra " +
    "o escopo por coluna é o próprio board.yaml, coberto por `capability-contract.test.ts`.",
  "scripts/ops/qa-stack/contract.json":
    "scripts/ops/** é operação do ecossistema do dono (units systemd do QA, error-report contra o GCP " +
    "dos produtos) e a régua o exclui inteiro — a regra que o protegia era INERTE e saiu em 2026-08-06. " +
    "O espelho de contrato existe para os dois lados não divergirem NESTA casa; no artefato só viaja o " +
    "lado do motor, e é ele que os testes de parse continuam cobrindo.",
  // ⚠ Estes três motivos falam da superfície composta do dono SEM nomeá-la: `agnostic-lint.test.ts`
  // reprova nome de board de produto fora de comentário em `src/**`, e este módulo VIAJA. O caminho do
  // manifesto vem por import do único módulo onde esse acoplamento está REGISTRADO como débito.
  "scripts/deploy/lib/turbo-failure.mjs":
    "scripts/deploy/** publica os produtos do dono. O emissor do marcador do gate do rosto não viaja; " +
    "o LEITOR (runner/face-gate-detail.ts) viaja e continua coberto pelos casos de parse.",
  "scripts/deploy/predeploy-face-gate.mjs":
    "idem — o gate de pré-deploy da face composta é do produto, não da ferramenta.",
  // A ENTRADA DO MANIFESTO DA SUPERFÍCIE COMPOSTA SAIU DAQUI, e a ausência é a notícia.
  //
  // Ela era uma chave computada — `[COMPOSED_FACE_MANIFEST_REL]` — importada de `runner/product-deploy`,
  // porque o caminho contém um nome de produto e este arquivo é agnóstico (escrever o literal aqui
  // reprovaria no `agnostic-lint`). O import era o disfarce: o literal morava no único módulo onde o
  // acoplamento estava REGISTRADO como débito.
  //
  // O caminho agora é DECLARADO pelo alvo (settings.yaml → `deploy.composedFace.manifest`), e um valor de
  // configuração não pode ser chave estática de um mapa em código. Mas a troca não é só mecânica: a
  // pergunta que este mapa responde ("este arquivo do umbrella existe?") deixou de ser a pergunta certa.
  // A certa é "este alvo DECLARA uma superfície composta?", e quem precisa dela pergunta ao motor
  // (`composedFaceManifestStatus()`), que distingue `absent` de `unreadable` — a distinção que impede uma
  // face velha de passar por publicada. Um alvo sem face declarada responde `absent` sem ninguém precisar
  // saber que um dia houve um arquivo com nome de produto.
  "docs/adr/ADR-067-sondas-f0-multitarget.md":
    "docs/ inteiro fica: traz o plano OSS, os business-models e as medições contra o HOST do dono " +
    "(caminho do checkout, kernel, serviço como root). O laço prosa↔código que o ADR fecha continua " +
    "cobrado no artefato pelos outros dois portadores que VIAJAM — o README do runner e o comentário " +
    "de dívida do engine.ts.",
};

export type Arvore = "umbrella" | "extraido";

/**
 * Classifica a árvore por DOIS sinais que se cruzam:
 *   · `oss/extract.sh` existe  — a árvore que EXTRAI é o umbrella; a extraída não leva o extrator;
 *   · `packages/` tem um pacote só — o artefato leva só `storymap-ui`; o umbrella tem nove.
 *
 * Eles têm de discordar entre si (um verdadeiro, um falso). Concordando, a árvore é INCOERENTE e este
 * módulo LANÇA em vez de escolher: se alguém apagar o extrator do umbrella, o discriminador vira
 * "extraído" e TODO guarda umbrella-only desliga em silêncio — a falha de modo que este arquivo existe
 * para não ter. Um discriminador de um sinal só é um interruptor de desligar a suíte.
 */
export function arvore(root: string = OSS_TREE_ROOT): Arvore {
  const temExtrator = existsSync(path.join(root, "oss/extract.sh"));
  const pacotes = readdirSync(path.join(root, "packages"), { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  );
  const soStorymap = pacotes.length === 1 && pacotes[0].name === "storymap-ui";
  if (temExtrator === soStorymap) {
    throw new Error(
      `[oss-tree] árvore INCOERENTE em ${root}: oss/extract.sh ${temExtrator ? "existe" : "não existe"} ` +
        `e packages/ tem ${pacotes.length} pacote(s) (${pacotes.map((p) => p.name).join(", ")}). ` +
        `Umbrella = extrator presente + vários pacotes; artefato = sem extrator + só storymap-ui. ` +
        `Enquanto os dois sinais não concordarem com um dos dois retratos, nenhum guarda umbrella-only ` +
        `pode decidir se a ausência de um arquivo é normal ou é a regressão que ele deveria pegar.`,
    );
  }
  return temExtrator ? "umbrella" : "extraido";
}

const jaAvisados = new Set<string>();

/**
 * Caminho ABSOLUTO de um arquivo umbrella-only, ou `null` quando a árvore é o artefato extraído.
 *
 * · No umbrella, ausência é REGRESSÃO ⇒ lança (o caso que deveria falhar falha).
 * · No extraído, ausência é o estado CORRETO ⇒ devolve `null` e grita uma vez no console, dizendo o que
 *   deixou de ser medido e onde a propriedade continua coberta.
 * · Caminho não declarado em `SO_DO_UMBRELLA` ⇒ lança. Não há porta lateral: para um teste passar a
 *   tolerar a ausência de um arquivo, o arquivo tem de entrar na lista acima, com motivo escrito, e
 *   `oss-tree.test.ts` passa a cobrar dele os dois sentidos.
 */
export function soDoUmbrella(rel: string, root: string = OSS_TREE_ROOT): string | null {
  const motivo = SO_DO_UMBRELLA[rel];
  if (!motivo) {
    throw new Error(
      `[oss-tree] "${rel}" não está declarado em SO_DO_UMBRELLA. Declare-o (com o motivo pelo qual ` +
        `não viaja e onde a propriedade fica coberta no artefato) antes de tolerar a ausência dele.`,
    );
  }
  const abs = path.join(root, rel);
  if (existsSync(abs)) return abs;
  if (arvore(root) === "umbrella") {
    throw new Error(
      `[oss-tree] "${rel}" sumiu do UMBRELLA, onde ele tem de existir. ${motivo} ` +
        `Este guarda não é opcional: no umbrella a ausência é a regressão que ele existe para pegar.`,
    );
  }
  if (!jaAvisados.has(rel)) {
    jaAvisados.add(rel);
    console.warn(
      `⚠ [oss-tree] repo EXTRAÍDO: "${rel}" não viaja por decisão da régua — este caso NÃO mediu o que ` +
        `mede no umbrella. ${motivo}`,
    );
  }
  return null;
}

/** Test-only: esquece quais avisos já foram impressos. */
export function resetAvisosDoOssTree(): void {
  jaAvisados.clear();
}

export type ProdutorDoGate = {
  /** `<arquivo>:<alvo|passo>` — aparece nas mensagens de falha. */
  readonly nome: string;
  /** O texto do corpo do alvo/passo, como escrito. É sobre ele que os testes de texto asseram. */
  readonly corpo: string;
  /** O comando pronto para rodar, e como rodá-lo (o `just` do umbrella não é um shell command). */
  readonly comando: readonly string[];
};

/** O corpo de uma receita do justfile (as linhas indentadas logo abaixo do cabeçalho do alvo). */
export function receitaDoJustfile(justfile: string, alvo: string): string {
  const linhas = justfile.split("\n");
  const i = linhas.findIndex((l) => new RegExp(`^${alvo}(\\s|:)`).test(l));
  if (i < 0) return "";
  const corpo: string[] = [];
  for (let j = i + 1; j < linhas.length && /^\s+\S/.test(linhas[j]); j++) corpo.push(linhas[j]);
  return corpo.join("\n");
}

/**
 * O escalar `run:` do YAML que contém `agulha`, desdobrado numa linha. Sem dependência de parser: acha a
 * linha do `run:` que governa a ocorrência e consome tudo que estiver MAIS indentado que ela — que é a
 * regra do próprio YAML para escalares em bloco (`>-`, `|`) e cobre também o `run:` de uma linha só.
 */
function passosRunQueInvocam(yaml: string, agulha: string): { nome: string; corpo: string }[] {
  const linhas = yaml.split("\n");
  const achados: { nome: string; corpo: string }[] = [];
  for (let i = 0; i < linhas.length; i++) {
    if (!linhas[i].includes(agulha)) continue;
    // sobe até o `run:` que governa esta linha
    let r = i;
    while (r >= 0 && !/^\s*(-\s+)?run:/.test(linhas[r])) r--;
    if (r < 0) continue;
    const indent = linhas[r].search(/\S/);
    const corpo = [linhas[r]];
    for (let j = r + 1; j < linhas.length; j++) {
      if (linhas[j].trim() === "") continue;
      if (linhas[j].search(/\S/) <= indent) break;
      corpo.push(linhas[j]);
    }
    // o `- name:` do passo, se houver, dá o rótulo humano
    let n = r;
    while (n >= 0 && !/^\s*-\s+name:/.test(linhas[n])) n--;
    const nome = n >= 0 ? linhas[n].replace(/^\s*-\s+name:\s*/, "").trim() : `run@${r + 1}`;
    if (!achados.some((a) => a.nome === nome)) achados.push({ nome, corpo: corpo.join("\n") });
  }
  return achados;
}

/** `node x.mjs --a b\n--c` (escalar dobrado, com ou sem `run:`/`@`/`{{ARGS}}`) → `node x.mjs --a b --c`. */
export function comandoDe(corpo: string): string {
  return corpo
    .replace(/^\s*(-\s+)?run:\s*[|>][-+]?\s*/, " ")
    .replace(/^\s*(-\s+)?run:\s*/, " ")
    .replace(/\{\{ARGS\}\}/g, " ")
    .split("\n")
    .map((l) => l.trim().replace(/^@/, ""))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * TODO produtor do gate de publicação NESTA árvore — o alvo do justfile (umbrella) e cada passo de
 * `oss/ci/workflows/*.yml` que invoca o gate (umbrella e artefato). Devolver lista, e não "o produtor",
 * é o que faz o teste de produtor continuar sendo teste de produtor no repo extraído.
 */
export function produtoresDaPublicacao(root: string = OSS_TREE_ROOT): ProdutorDoGate[] {
  const produtores: ProdutorDoGate[] = [];

  const justfile = path.join(root, "justfile");
  if (existsSync(justfile)) {
    const corpo = receitaDoJustfile(readFileSync(justfile, "utf8"), ALVO_DA_PUBLICACAO);
    if (corpo.includes(GATE_DE_PUBLICACAO)) {
      produtores.push({
        nome: `justfile:${ALVO_DA_PUBLICACAO}`,
        corpo,
        comando: ["just", "--justfile", justfile, "--working-directory", root, ALVO_DA_PUBLICACAO],
      });
    }
  }

  const dir = path.join(root, "oss/ci/workflows");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
      const yaml = readFileSync(path.join(dir, f), "utf8");
      for (const passo of passosRunQueInvocam(yaml, GATE_DE_PUBLICACAO)) {
        // `corpo` é o que será PUBLICADO; `comando` é como executá-lo NESTA árvore. Os dois divergem, e
        // a divergência é a correção de um defeito medido (2026-08-21).
        //
        // O passo do workflow tem dois consumidores com necessidades OPOSTAS. No artefato ele varre a
        // árvore inteira — tudo que está lá já sobreviveu ao corte, e reaplicar a régua apagaria da
        // varredura `.github/` inteiro, os quatro documentos de raiz, o `.gitignore` e o golden gerado no
        // destino (10 de 1236 rastreados, medido; uma chave `AKIA…` em `.github/workflows/` saía EXIT 0).
        // No UMBRELLA, o mesmo comando roda como PRÉ-VOO sobre o monorepo, onde sem escopo ele acusa os
        // pacotes que nem viajam e nasce permanentemente vermelho.
        //
        // O escopo é propriedade da ÁRVORE MEDIDA, não do comando publicado. Então ele entra na execução
        // local e fica fora do texto que viaja.
        const escopoLocal = arvore(root) === "umbrella" ? " --exclude-from .ossignore" : "";
        produtores.push({
          nome: `oss/ci/workflows/${f}:${passo.nome}`,
          corpo: passo.corpo,
          comando: ["sh", "-c", `${comandoDe(passo.corpo)}${escopoLocal}`],
        });
      }
    }
  }

  return produtores;
}

// ── O QUE A PUBLICAÇÃO SUBSTITUI: o override que REMOVE um pacote do fecho ───────────────────────────
//
// `oss/extract.sh` escreve `overrides` PRÓPRIOS no `package.json` do DESTINO (o do umbrella não é
// tocado) e gera o lockfile lá. Quase todos sobem versão; um deles REMOVE: `sharp` é apontado para um
// stub `npm:@favware/skip-dependency`, porque o `next@15` o declara em `optionalDependencies` só para o
// otimizador de imagem — que este produto não usa — e ele arrasta `@img/sharp-libvips-*` em
// LGPL-3.0-or-later, o único copyleft que o gate de licença recusa no fecho publicado sob Apache-2.0.
//
// ISSO PARTIU EM DOIS O QUE ERA UMA COISA SÓ. Até o Next 14 o fecho INSTALADO daqui e o fecho
// PUBLICADO coincidiam, e `oss-license.test.ts` media "o fecho realmente publicado" lendo este disco.
// Com o 15 eles divergiram POR DESENHO: aqui a LGPL entra — e TEM de entrar, porque os apps do monorepo
// de origem usam `sharp` de verdade e o override não pode subir para a raiz do monorepo; lá ela não
// existe. O teste continuava certo; a árvore é que deixou de ser a mesma.
//
// É a lição de `produtoresDaPublicacao()` outra vez: o ESCOPO é propriedade da ÁRVORE MEDIDA. No
// artefato não há substituição a simular (o override já está aplicado e o disco É o fecho publicado),
// então a resposta é o conjunto VAZIO e a medição lá é integral — é ela que vale. No umbrella a
// resposta vem do extrator, LIDA dele a cada rodada: tirar o override de `extract.sh` encolhe o
// conjunto, a LGPL reaparece no fecho medido e o gate fica vermelho. Que é o desfecho certo, porque o
// artefato publicado passaria a carregá-la de fato.
//
// A isenção é um BURACO na medição, e por isso não basta ela existir: `oss-license.test.ts` pina o
// conjunto esperado (remoção nova reprova até alguém escrevê-la lá), exige que ela ainda subtraia algo
// (isenção sem sujeito é hole sem dono) e exige que o que ela subtrai seja só o pacote substituído e o
// que SÓ ele alcança.

/**
 * Os pacotes que a publicação troca por um stub sem dependências — nome → o valor do override.
 *
 * Vazio no artefato extraído, por construção. No umbrella, lido de `oss/extract.sh`: só as entradas de
 * `DA_EXTRACAO` cujo valor é um `npm:<pacote>` (as demais sobem versão e não mudam o fecho).
 */
export function substituicoesDaPublicacao(root: string = OSS_TREE_ROOT): Map<string, string> {
  const subs = new Map<string, string>();
  if (arvore(root) === "extraido") return subs;

  const extrator = path.join(root, "oss/extract.sh");
  const fonte = readFileSync(extrator, "utf8");
  // `[^}]*` atravessa quebra de linha: a constante pode virar multi-linha sem quebrar a leitura.
  const corpo = /const\s+DA_EXTRACAO\s*=\s*\{([^}]*)\}/.exec(fonte);
  if (!corpo) {
    throw new Error(
      `[oss-tree] não achei \`const DA_EXTRACAO = { … }\` em ${extrator}. É de lá que sai o conjunto de ` +
        `pacotes que a publicação REMOVE do fecho, e sem ele o gate de licença não sabe distinguir a LGPL ` +
        `que fica neste monorepo da que viaja. Se a constante mudou de nome ou de forma, atualize esta ` +
        `leitura — devolver vazio em silêncio faria o gate medir a árvore errada e chamar isso de veredito.`,
    );
  }
  for (const par of corpo[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*"([^"]+)"/g)) {
    const nome = par[1] ?? par[2];
    const valor = par[3];
    if (valor.startsWith("npm:")) subs.set(nome, valor);
  }
  return subs;
}
