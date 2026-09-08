// gate-tree — MONTA a árvore que o gate valida, do jeito que a aterrissagem vai montar.
//
// ═══ O DEFEITO QUE ESTE MÓDULO EXISTE PARA FECHAR ═══
//
// O gate construía a árvore descartável a partir do HEAD de `main` e fazia `git merge <sha>`. A
// aterrissagem faz `git diff base..sha` + `git apply --3way` sobre `stage`. São COMPOSIÇÕES DIFERENTES
// SOBRE BASES DIFERENTES — logo "o gate passou" nunca implicou "aplica limpo". Medido em produção: a
// entrada `db87b761` gateou 134 s (verde) e morreu com `split: código conflita com stage`. Pagou-se a
// suíte inteira para descobrir, DEPOIS, que o patch não entrava.
//
// É a classe de bug que o próprio ADR-065 proíbe no D15 ("duas definições de escopo para o MESMO
// deploy") e que a memória do canário registra como reincidente: DUAS RÉGUAS PARA UMA PERGUNTA.
//
// ═══ A CORREÇÃO ═══
//
// Uma régua: a árvore do gate é `stage` + O MESMO PATCH que o split vai aplicar. Consequências:
//   • "gate verde ⇒ patch aplica" passa a ser verdade POR CONSTRUÇÃO, não por coincidência;
//   • o conflito é detectado ANTES da suíte (segundos, não os ~2 min do p90) e já com o artefato
//     legível anexado — o chamador dispõe dele (devolve à sessão / escada) sem pagar o gate;
//   • a suíte roda contra a árvore que VAI existir, incluindo o código não-liberado que já está em
//     `stage` — que a árvore baseada em `main` só via de raspão, por a branch descender de stage.
//
// A metade de DADOS entra no patch junto com a de código, de propósito: parte da suíte lê
// `storymap/boards/**` do disco (os goldens de pipeline, os lints de integridade), e `stage` é mantido
// ⊇ `main` pelo sync do train — então aplicar as duas metades sobre `stage` modela "main+stage depois
// que isto aterrissar" melhor que qualquer alternativa. Aterrissar é que as separa.
//
// FAIL-SAFE: se `stage` não resolver (staging desligado, branch ausente), o chamador mantém o caminho
// legado baseado em `main`. Degradar para o comportamento de ontem é sempre melhor que travar o train.
//
// PURO sobre `exec`/`fs` injetados; NUNCA lança (toda falha é um resultado tipado).

import { captureConflictArtifact, type ConflictArtifact } from "./conflict-artifact";
import { execErrorDetail, quote } from "./git";
import type { ExecFn, WorktreeFs } from "./worktree";

/** Generoso: `worktree add` faz checkout da árvore inteira; nunca minutos, mas nunca instantâneo. */
const GIT_TIMEOUT_MS = 60_000;
const LOG_CAP = 500;

export type GateTreeResult =
  /** a árvore está pronta e é EXATAMENTE a que a aterrissagem vai produzir */
  | { ok: true; baseSha: string; snapRegenerated: boolean }
  /**
   * O patch NÃO aplica. Este é o desfecho novo e o mais valioso: o conflito aparece aqui, barato, com o
   * artefato — o chamador devolve à sessão ou sobe a escada SEM ter rodado a suíte.
   */
  | { ok: false; kind: "conflict"; log: string; conflict: ConflictArtifact }
  /** infra (worktree add, provisão, git quebrado) — NÃO é defeito do submitter (inconclusivo) */
  | { ok: false; kind: "setup"; log: string };

export interface GateTreeDeps {
  exec: ExecFn;
  fs: WorktreeFs;
  /** liga `node_modules` do checkout principal na árvore (instantâneo, sem rede). O retorno da
   *  implementação real (a lista de links) não interessa aqui — só que ela tenha completado. */
  provisionNodeModules: (fs: WorktreeFs, repoRoot: string, treePath: string) => Promise<unknown>;
  /**
   * Regenera os `*.snap` a partir da fonte já mesclada, na árvore dada. Snapshots são DERIVADOS e
   * `.gitattributes` os marca `binary`, então git NUNCA os mescla textualmente — quem integra tem de
   * reconstruí-los. Injetado porque a implementação real roda `vitest -u` (minutos) e o teste não pode.
   */
  regenerateSnapshots: (treePath: string, snapFiles: string[]) => Promise<{ status: "regenerated" | "noop" | "failed"; detail?: string }>;
  /** junta caminhos (injetado para o teste não depender do path do host) */
  join: (...parts: string[]) => string;
  /** lê um arquivo da árvore — usado só pela captura do conflito */
  readFile: (absPath: string) => Promise<string>;
}

export interface GateTreeOpts {
  repoRoot: string;
  /** onde a árvore descartável nasce */
  treePath: string;
  /** o branch descartável dela (`gate/<runId>`) */
  treeBranch: string;
  /** a BASELINE: o ref de que a árvore é cortada — `stage` em produção */
  baseline: string;
  /** a base do delta da entrada (`entry.baseCommit`) */
  deltaBase: string;
  /** o sha PINADO que a entrada integra (nunca o tip do branch — a sessão segue commitando) */
  deltaHead: string;
  /** onde escrever o patch temporário (`.runner/gate-<runId>.patch`) */
  patchFile: string;
  timeoutMs?: number;
}

/** `git` que devolve resultado em vez de lançar — o idioma de merge-queue/run-base. */
async function git(
  exec: ExecFn,
  cwd: string,
  args: string,
  timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await exec(`git ${args}`, { cwd, timeout });
    return { ok: true, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? execErrorDetail(err, LOG_CAP)) };
  }
}

/**
 * Prepara a árvore do gate. Devolve `baseSha` = o sha da BASELINE antes do patch — que é, de uma vez:
 *   • o alvo do `git reset --hard` da rodada de ATRIBUIÇÃO (as falhas que já existiam sem este delta);
 *   • o `{base}` da seleção `--changed` do affected gate.
 * Uma coisa só, porque é uma pergunta só ("o que este delta acrescenta?").
 */
export async function prepareGateTree(deps: GateTreeDeps, opts: GateTreeOpts): Promise<GateTreeResult> {
  const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const g = (cwd: string, args: string) => git(deps.exec, cwd, args, timeout);

  // A árvore nasce da BASELINE — não do HEAD do repo. É a única linha que muda a resposta do gate de
  // "isto mescla com main?" para "isto aplica onde vai aplicar?".
  const added = await g(opts.repoRoot, `worktree add ${quote(opts.treePath)} -b ${quote(opts.treeBranch)} ${quote(opts.baseline)}`);
  if (!added.ok) return { ok: false, kind: "setup", log: `gate setup falhou (worktree add ${opts.baseline}): ${added.stderr.slice(0, LOG_CAP)}` };

  const head = await g(opts.treePath, `rev-parse HEAD`);
  const baseSha = head.stdout.trim();
  if (!head.ok || !baseSha) return { ok: false, kind: "setup", log: `gate setup falhou: não resolvi o HEAD de ${opts.baseline}` };

  try {
    await deps.provisionNodeModules(deps.fs, opts.repoRoot, opts.treePath);
  } catch (err) {
    return { ok: false, kind: "setup", log: `gate setup falhou (node_modules): ${execErrorDetail(err, LOG_CAP)}` };
  }

  // Quais arquivos o delta toca. `--no-renames` é OBRIGATÓRIO e pela MESMA razão do split: com detecção
  // de rename o `--name-only` de um `git mv` lista só o caminho NOVO, o antigo some do pathspec e o
  // arquivo velho sobrevive ao lado do novo (foi assim que uma tela renomeada ficou viva importando
  // símbolos que já não existiam). Sem renames, o par vira delete+add e as duas metades entram.
  const names = await g(opts.repoRoot, `diff --name-only --no-renames ${quote(opts.deltaBase)}..${quote(opts.deltaHead)}`);
  if (!names.ok) return { ok: false, kind: "setup", log: `gate setup falhou (diff do delta): ${names.stderr.slice(0, LOG_CAP)}` };
  const files = names.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (files.length === 0) {
    // Delta vazio: não há o que aplicar e não há o que validar. É um resultado LEGÍTIMO (o chamador
    // decide) — nunca um erro, e nunca um "passou" fabricado aqui.
    return { ok: true, baseSha, snapRegenerated: false };
  }

  // Snapshots saem do patch e voltam por regeneração — mesma regra da aterrissagem, mesmo motivo.
  const snapFiles = files.filter((f) => f.endsWith(".snap"));
  const patchable = files.filter((f) => !f.endsWith(".snap"));

  if (patchable.length > 0) {
    const spec = patchable.map((p) => quote(p)).join(" ");
    // `--binary`: sem ele o git emite só "Binary files … differ", sem payload nem index line completa, e
    // o `apply` recusa o patch INTEIRO — inclusive os hunks de texto que estavam no mesmo arquivo.
    const wrote = await g(
      opts.repoRoot,
      `diff --binary --no-renames ${quote(opts.deltaBase)}..${quote(opts.deltaHead)} -- ${spec} > ${quote(opts.patchFile)}`,
    );
    if (!wrote.ok) return { ok: false, kind: "setup", log: `gate setup falhou (gerar patch): ${wrote.stderr.slice(0, LOG_CAP)}` };

    // O MESMO apply do split: `--index --3way`. Mesma régua, mesmo resultado.
    const applied = await g(opts.treePath, `apply --index --3way ${quote(opts.patchFile)}`);
    if (!applied.ok) {
      // AQUI está o ganho: o conflito aparece ANTES da suíte, e sai com nome e região.
      const conflict = await captureConflictArtifact(
        { exec: deps.exec, readFile: deps.readFile, join: (cwd, rel) => deps.join(cwd, rel) },
        opts.treePath,
        { applyStderr: applied.stderr, timeoutMs: timeout },
      );
      return {
        ok: false,
        kind: "conflict",
        conflict,
        log: `o delta NÃO aplica em ${opts.baseline} (mesmo apply que a aterrissagem faz): ${applied.stderr.slice(0, LOG_CAP)}`,
      };
    }
  }

  let snapRegenerated = false;
  if (snapFiles.length > 0) {
    const regen = await deps.regenerateSnapshots(opts.treePath, snapFiles);
    if (regen.status === "failed") {
      // `vitest -u` vermelho é teste vermelho de verdade — a regeneração não tem como maquiar. É defeito
      // do delta (não infra), então vai como `conflict` sem artefato de texto: não há hunks, há um teste.
      return {
        ok: false,
        kind: "conflict",
        conflict: { files: snapFiles, hunks: [] },
        log: `regeneração de snapshot falhou na árvore do gate${regen.detail ? `: ${regen.detail}` : ""}`,
      };
    }
    snapRegenerated = regen.status === "regenerated";
    await g(opts.treePath, `add -- ${snapFiles.map((p) => quote(p)).join(" ")}`);
  }

  // Commita o delta na árvore descartável para que o `--changed <baseSha>` do affected gate enxergue
  // exatamente este delta, e para que a rodada de atribuição possa voltar com um `reset --hard baseSha`.
  // `--no-verify`: hooks são para humano no teclado; o secret-scan roda na aterrissagem, não aqui.
  const committed = await g(opts.treePath, `commit --no-verify --allow-empty -m "gate: delta sob validação"`);
  if (!committed.ok) {
    return { ok: false, kind: "setup", log: `gate setup falhou (commit na árvore do gate): ${(committed.stderr || committed.stdout).slice(0, LOG_CAP)}` };
  }
  return { ok: true, baseSha, snapRegenerated };
}
