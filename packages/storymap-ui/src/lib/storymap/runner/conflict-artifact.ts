// conflict-artifact — CAPTURE o conflito ANTES de a árvore ser descartada.
//
// O train aplica a metade de código como PATCH (`git apply --index --3way`) no worktree de `stage`.
// Quando isso falha, o chamador faz `reset --hard HEAD` para deixar `stage` limpo — e é aí que a
// informação morre: os caminhos não-mergeados e os marcadores de conflito são apagados no mesmo
// instante em que passam a ser a única coisa que alguém precisava saber.
//
// O custo disso foi medido em produção: o desfecho mais comum de falha (`returned-to-session`) entregava
// à sessão exatamente `split: código conflita com stage (run <uuid>)` — sem arquivo, sem região, sem
// lado. A sessão só podia chutar (`worktree_refresh` às cegas + re-submeter). O irmão desta camada, o
// `release.ts`, já publica `divergentFiles`/`divergentBase` justamente para não cometer esse erro, e o
// comentário de lá diz textualmente que uma recusa em que ninguém pode agir "é o mesmo defeito do
// returned-to-session sem motivo". O defeito estava diagnosticado e corrigido só de um lado.
//
// DUAS FONTES, unidas — porque `git apply` falha de duas formas diferentes e só uma delas deixa rastro
// no índice:
//   1. CONFLITO de 3-way: deixa entradas UNMERGED no índice (`--diff-filter=U`) e marcadores na árvore.
//   2. RECUSA seca (contexto que não bate, patch binário sem index line): NÃO stageia nada — o índice
//      fica limpo e a única evidência é o stderr (`error: patch failed: <path>:<line>`).
// Ler só o índice perde a classe 2 inteira; ler só o stderr perde os hunks da classe 1. A união é o que
// torna o artefato NUNCA vazio quando o git disse alguma coisa.
//
// PURO sobre o `exec`/`readFile` injetados (a convenção de convergence.ts/release.ts): testável contra
// git de verdade ou dublê. NUNCA lança — uma captura que falha devolve o que conseguiu, porque ela roda
// no caminho de tratamento de erro e uma exceção aqui trocaria um conflito por um crash do train.

import type { ExecFn } from "./worktree";

/** Teto por hunk. Espelha HUNK_TEXT_CAP da escada semântica de propósito: o artefato alimenta a escada
 *  (é o `files` que ela julga) e viaja na entry persistida — dois consumidores, um teto. */
export const CONFLICT_HUNK_CAP = 800;
/** Quantos arquivos entram no artefato. Além disto a divergência não é um merge, é uma reescrita — quem
 *  for resolver precisa do branch, não de uma lista de 200. O excedente é CONTADO, nunca omitido em silêncio. */
export const CONFLICT_MAX_FILES = 20;
/** Quantos hunks no total. Mesmo raciocínio; um arquivo patológico não pode estourar o arquivo de estado. */
export const CONFLICT_MAX_HUNKS = 20;

/** Uma região divergente, já recortada e com teto. */
export interface ConflictHunk {
  /** caminho repo-relativo */
  file: string;
  /** o texto da região (com os marcadores), capado em {@link CONFLICT_HUNK_CAP} */
  hunk: string;
}

/**
 * O que a captura conseguiu ver. Todo campo é BEST-EFFORT: um artefato parcial é infinitamente melhor
 * que nenhum, e quem lê precisa saber que é parcial — daí `truncatedFiles`/`truncatedHunks` serem
 * contagens explícitas em vez de um corte mudo.
 */
export interface ConflictArtifact {
  /** os arquivos que divergiram (índice ∪ stderr), já capados */
  files: string[];
  /** as regiões divergentes, quando havia marcadores para ler */
  hunks: ConflictHunk[];
  /** quantos arquivos ficaram de fora do cap */
  truncatedFiles?: number;
  /** quantos hunks ficaram de fora do cap */
  truncatedHunks?: number;
}

const MARKER_START = "<<<<<<<";
const MARKER_MID = "=======";
const MARKER_END = ">>>>>>>";

/**
 * Os caminhos que o `git apply` NOMEOU no stderr. É a única evidência que sobra quando o apply recusa
 * SEM stagear nada (contexto que não bate) — o caso em que o índice fica limpo e `--diff-filter=U`
 * devolve vazio.
 *
 * Formatos cobertos (git 2.3x): `error: patch failed: <path>:<line>`, `error: <path>: patch does not
 * apply`, `error: cannot apply binary patch to '<path>' without full index line`. Deliberadamente
 * TOLERANTE: uma linha que não casa nenhum formato é ignorada, nunca vira um caminho inventado — um
 * caminho falso no artefato mandaria a sessão editar um arquivo que não tem nada.
 *
 * PURA.
 */
export function parseApplyStderr(stderr: string): string[] {
  const out: string[] = [];
  const push = (p: string | undefined): void => {
    const path = (p ?? "").trim();
    if (path && !out.includes(path)) out.push(path);
  };
  for (const raw of String(stderr ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^error: patch failed: (.+?):\d+$/);
    if (m) {
      push(m[1]);
      continue;
    }
    m = line.match(/^error: (.+?): patch does not apply$/);
    if (m) {
      push(m[1]);
      continue;
    }
    m = line.match(/^error: cannot apply binary patch to '(.+?)' without full index line$/);
    if (m) {
      push(m[1]);
      continue;
    }
    m = line.match(/^error: (.+?): does not exist in index$/);
    if (m) push(m[1]);
  }
  return out;
}

/**
 * Recorta as regiões entre `<<<<<<<` e `>>>>>>>` de um arquivo já com marcadores. PURA.
 *
 * Um arquivo SEM marcadores devolve `[]` — e isso é uma resposta, não uma falha: no apply que recusou
 * seco o arquivo continua íntegro, e o valor está no NOME dele, que a outra fonte já trouxe.
 */
export function extractConflictHunks(file: string, content: string, cap = CONFLICT_HUNK_CAP): ConflictHunk[] {
  const lines = String(content ?? "").split("\n");
  const hunks: ConflictHunk[] = [];
  let buf: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(MARKER_START)) {
      buf = [line];
      continue;
    }
    if (buf === null) continue;
    buf.push(line);
    if (line.startsWith(MARKER_END)) {
      hunks.push({ file, hunk: buf.join("\n").slice(0, cap) });
      buf = null;
    }
  }
  // Marcador de abertura sem fechamento (arquivo truncado / binário lido como texto): ainda é a região
  // mais informativa que existe — entra capada em vez de sumir.
  if (buf && buf.length > 1 && buf.some((l) => l.startsWith(MARKER_MID))) {
    hunks.push({ file, hunk: buf.join("\n").slice(0, cap) });
  }
  return hunks;
}

/** Aplica os tetos, CONTANDO o excedente (nunca cortando em silêncio). PURA. */
export function capArtifact(
  files: string[],
  hunks: ConflictHunk[],
  limits: { maxFiles?: number; maxHunks?: number } = {},
): ConflictArtifact {
  const maxFiles = limits.maxFiles ?? CONFLICT_MAX_FILES;
  const maxHunks = limits.maxHunks ?? CONFLICT_MAX_HUNKS;
  const artifact: ConflictArtifact = {
    files: files.slice(0, maxFiles),
    hunks: hunks.slice(0, maxHunks),
  };
  if (files.length > maxFiles) artifact.truncatedFiles = files.length - maxFiles;
  if (hunks.length > maxHunks) artifact.truncatedHunks = hunks.length - maxHunks;
  return artifact;
}

export interface CaptureDeps {
  exec: ExecFn;
  /** lê o conteúdo do arquivo na árvore (injetado — o módulo não faz IO próprio) */
  readFile: (absPath: string) => Promise<string>;
  /** junta cwd + caminho repo-relativo (injetado para o teste não depender de path do host) */
  join: (cwd: string, rel: string) => string;
}

/**
 * Lê o conflito da árvore `cwd` — chame ANTES de qualquer `reset --hard`.
 *
 * `applyStderr` é o stderr do `git apply` que acabou de falhar; passe-o sempre. Sem ele a captura perde
 * a classe de falha que não stageia nada, e devolve um artefato vazio exatamente no caso em que o
 * operador/agente mais precisa do nome do arquivo.
 *
 * NUNCA lança. Um git quebrado devolve o que veio do stderr; um arquivo ilegível some dos hunks mas
 * permanece em `files`.
 */
export async function captureConflictArtifact(
  deps: CaptureDeps,
  cwd: string,
  opts: { applyStderr?: string; timeoutMs?: number; limits?: { maxFiles?: number; maxHunks?: number } } = {},
): Promise<ConflictArtifact> {
  const timeout = opts.timeoutMs ?? 30_000;
  let unmerged: string[] = [];
  try {
    const { stdout } = await deps.exec(`git diff --name-only --diff-filter=U`, { cwd, timeout });
    unmerged = String(stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* índice ilegível → a fonte do stderr ainda responde */
  }
  const fromStderr = parseApplyStderr(opts.applyStderr ?? "");
  // Ordem: primeiro os que o git marcou como não-mergeados (têm hunk para ler), depois os que só o
  // stderr nomeou. Assim o cap, quando morde, preserva os arquivos mais informativos.
  const files = [...unmerged, ...fromStderr.filter((f) => !unmerged.includes(f))];

  const hunks: ConflictHunk[] = [];
  for (const f of files) {
    if (hunks.length >= (opts.limits?.maxHunks ?? CONFLICT_MAX_HUNKS)) break;
    try {
      const content = await deps.readFile(deps.join(cwd, f));
      hunks.push(...extractConflictHunks(f, content));
    } catch {
      /* arquivo removido/ilegível — o nome já está em `files`, que é o essencial */
    }
  }
  return capArtifact(files, hunks, opts.limits);
}

/**
 * A frase que o operador (ou a sessão) lê. É o entregável do P-1: em vez de "código conflita com stage",
 * o nome dos arquivos e o tamanho da divergência.
 *
 * `undefined` quando não há NADA a dizer — melhor o detalhe original do chamador do que uma linha vazia
 * fingindo informação. PURA.
 */
export function describeConflictArtifact(artifact: ConflictArtifact | undefined): string | undefined {
  if (!artifact || artifact.files.length === 0) return undefined;
  const head = artifact.files.slice(0, 5).join(", ");
  const more = artifact.files.length > 5 ? ` (+${artifact.files.length - 5})` : "";
  const truncated = artifact.truncatedFiles ? ` [+${artifact.truncatedFiles} além do teto]` : "";
  const regions = artifact.hunks.length > 0 ? ` · ${artifact.hunks.length} região(ões) divergente(s)` : "";
  return `diverge em: ${head}${more}${truncated}${regions}`;
}
