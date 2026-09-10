// ── A ÁRVORE SOB TESTE É UMA SÓ: este repositório ─────────────────────────────────────────────────
//
// Até 2026-09-01 a ferramenta era EXTRAÍDA de um monorepo privado por uma lista de corte, e este
// módulo respondia "de que árvore este arquivo faz parte?" — umbrella (a fonte) ou artefato (o extraído).
// Vários guardas asseravam sobre arquivos que só existiam na fonte, e precisavam de uma decisão declarada
// para não morrer em ENOENT no destino.
//
// Desde a inversão a ferramenta é desenvolvida AQUI, e desde a issue #1 não há mais segunda árvore: o
// `oss/` (a cópia revisada do CI) e a régua saíram, `.github/` é a única fonte, e todo guarda que só
// fazia sentido na fonte foi retirado em vez de ficar pulando para sempre — um caso que nunca corre é
// capacidade declarada com zero produtores. O que sobrou deste módulo é a parte que continua verdadeira
// em qualquer clone: onde fica a raiz, qual é o gate de segredo da publicação, e QUEM o executa.
//
// A régua de produtor permanece assimétrica de propósito: um teste "alguém executa este gate?" não
// procura o produtor por um nome fixo — `produtoresDaPublicacao()` ENUMERA cada passo de
// `.github/workflows/*.yml` que invoca o gate, e os testes cobram cada um. Se o passo sumir do CI, a
// lista fica vazia e o teste de produtor reprova, que é o único desfecho honesto.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A raiz, resolvida a partir da LOCALIZAÇÃO DESTA FONTE — não por `findRepoRoot()`.
 * De propósito: `findRepoRoot()` obedece a `AGILEHARNESS_TARGET`, e casos que apontam o alvo para um
 * diretório de teste fariam este módulo medir a árvore errada. A pergunta "de que árvore este arquivo
 * faz parte?" só tem uma resposta honesta, e ela é o caminho do próprio arquivo.
 */
export const OSS_TREE_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
/** Sinônimo sem o nome da época da extração. */
export const REPO_ROOT = OSS_TREE_ROOT;

/** O script que o gate de segredo da publicação executa. */
export const GATE_DE_PUBLICACAO = "scripts/security/scan-snapshot-secrets.mjs";
/** O nome do passo de CI que o executa sobre a árvore inteira. */
export const ALVO_DA_PUBLICACAO = "oss-snapshot-gate";
/** Onde o GitHub lê os workflows — a ÚNICA cópia. */
export const WORKFLOWS_DIR = ".github/workflows";

export type ProdutorDoGate = {
  /** `<arquivo>:<passo>` — aparece nas mensagens de falha. */
  readonly nome: string;
  /** O texto do corpo do passo, como escrito. É sobre ele que os testes de texto asseram. */
  readonly corpo: string;
  /** O comando pronto para rodar, e como rodá-lo. */
  readonly comando: readonly string[];
};

/** O corpo de uma receita de justfile (as linhas indentadas logo abaixo do cabeçalho do alvo). */
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
 * TODO produtor do gate de publicação nesta árvore: cada passo de `.github/workflows/*.yml` que invoca
 * o gate. O `corpo` é o que o CI executa; o `comando` é a mesma coisa pronta para rodar aqui — sobre a
 * árvore inteira, sem recorte, porque nesta árvore tudo que existe já é o que se publica.
 */
export function produtoresDaPublicacao(root: string = OSS_TREE_ROOT): ProdutorDoGate[] {
  const produtores: ProdutorDoGate[] = [];
  const dir = path.join(root, WORKFLOWS_DIR);
  if (!existsSync(dir)) return produtores;
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const yaml = readFileSync(path.join(dir, f), "utf8");
    for (const passo of passosRunQueInvocam(yaml, GATE_DE_PUBLICACAO)) {
      produtores.push({
        nome: `${WORKFLOWS_DIR}/${f}:${passo.nome}`,
        corpo: passo.corpo,
        comando: ["sh", "-c", comandoDe(passo.corpo)],
      });
    }
  }
  return produtores;
}
