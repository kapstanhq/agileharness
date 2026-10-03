// run-base — ONDE UM RUN COMEÇOU, e portanto o que ELE fez.
//
// Um run branch é cortado do `stage`, então ele HERDA todo o código não-lançado que estava lá no
// momento do corte. Qualquer medida que use `HEAD` (ou a merge-base com HEAD) como régua atribui essa
// herança ao run — e essa única confusão produziu TRÊS bugs independentes:
//
//   • o teardown (worktree.ts) preservava como `failed/*` todo branch que não fosse ancestral de HEAD
//     — e um branch cortado do stage NUNCA é —, então preservava runs que não commitaram NADA. 12 dos
//     14 branches "preservados" da VPS não tinham um único commit próprio.
//   • o painel /processes anunciava "7 arquivos de código em risco" num branch cujo commit próprio
//     mexeu em um card .md — os 7 eram do stage, e já estavam em main por cherry-pick.
//   • o branch-gc provava integração com `--is-ancestor` contra main/stage — cego ao cherry-pick (sha
//     novo) e à herança —, então NUNCA conseguia colher, e o lixo virou imortal.
//
// A régua certa é o PONTO DE CORTE, e o git já o registrou: o reflog do ref guarda
// `branch: Created from <sha>` desde a criação. Sobrevive ao rename para `failed/`/`conflicted/` e é
// imune a qualquer reescrita posterior da história do stage. O trabalho próprio do run é
// `<cut-point>..<branch>`, ponto final.
//
// O reflog é exato enquanto NINGUÉM reescreve o branch. `worktree_refresh` (WS-1) REBASA o branch da
// sessão sobre a base nova, e o rebase não empilha um novo `Created from` — o reflog segue apontando o
// corte ORIGINAL, então `cut-point-original..branch` re-absorveria os commits que o stage ganhou desde
// o corte como se fossem da sessão: exatamente o bug acima, por uma porta nova. Por isso a ferramenta
// ESCREVE a base num ref próprio (`refs/agent-base/<id>`, proveniência `base-ref`) e o atualiza a cada
// rebase; para branches `agent/*` ele vence o reflog.
//
// Quando o reflog expirou (gc.reflogExpire, 90d), caímos no fork-point — e dizemos que é uma
// ESTIMATIVA. A assimetria importa e é usada pelos dois consumidores: uma base estimada reabsorve a
// herança, logo só pode SUPERESTIMAR o trabalho do run. Portanto ela é confiável para ABSOLVER (se
// mesmo inflada não há código, não há código) e NÃO é confiável para ACUSAR (o código pode ser
// herança). Ninguém alarma nem apaga com base num palpite que aponta para o lado perigoso.

import type { ExecFn } from "./worktree";

export type BaseProvenance =
  /** o registro do próprio git (`branch: Created from <sha>` no reflog do ref) — EXATO */
  | "reflog"
  /**
   * `refs/agent-base/<sessionId>` — a base que a ferramenta ESCREVEU para um branch de sessão (WS-1/G4).
   * EXATO como o reflog, e a ÚNICA fonte correta depois de um `worktree_refresh`: o rebase reescreve o
   * branch mas NÃO escreve um novo `Created from`, então o reflog continua apontando o corte ORIGINAL —
   * e `cut-point-original..branch` re-absorveria os commits novos do stage como trabalho da sessão (a
   * EXATA classe de bug que este módulo existe para matar). Por isso vence o reflog em branches `agent/*`.
   */
  | "base-ref"
  /** o reflog expirou → fork-point vs stage/HEAD. ESTIMATIVA: só superestima, nunca subestima */
  | "fork-point"
  /** não deu para resolver — o chamador deve falhar FECHADO */
  | "none";

export interface RunBase {
  /** o sha de onde o run foi cortado; "" quando não resolvido */
  base: string;
  provenance: BaseProvenance;
}

/**
 * A base é EXATA (o git/a ferramenta REGISTROU o corte) e não um palpite? Só uma base exata pode ACUSAR —
 * i.e. autorizar uma decisão destrutiva (colher/apagar) sobre "este branch não tem trabalho próprio". Uma
 * estimativa (`fork-point`) reabsorve a herança do stage e portanto só pode ABSOLVER. As duas exatas são o
 * reflog do git e o base-ref que a ferramenta escreve para sessões — a segunda existe justamente porque o
 * rebase do `worktree_refresh` invalida a primeira.
 */
export function isExactBase(p: BaseProvenance): boolean {
  return p === "reflog" || p === "base-ref";
}

/** O trabalho PRÓPRIO de um run. `null` = não deu para medir (≠ "mediu e deu zero"). */
export interface RunOwnWork {
  commits: number;
  files: string[];
}

/** Branches da MÁQUINA são `[failed/|conflicted/]{run,agent}/<uuid>` — nada fora disso vira linha de
 *  comando git. `run/` = run headless do autorun; `agent/` = sessão de agente (WS-1). O uuid é sempre
 *  mintado pela ferramenta (nunca nome livre do agente — D12). */
export const RUN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{7,40}$/i;
/** `branch: Created from <sha>` — o registro do git de onde o runner cortou este branch. */
const CREATED_FROM = /branch:\s*Created from\s+([0-9a-f]{7,40})\b/gi;
/** O prefixo `[failed/|conflicted/]` que os renames de preservação empilham na frente do nome. */
const PRESERVED_PREFIX = /^(failed|conflicted)\//;

/** O sessionId embutido no nome do branch (run OU agent), ou null se não for um branch nosso. */
export function sessionIdFromBranch(branch: string): string | null {
  const id = branch.replace(PRESERVED_PREFIX, "").replace(/^(run|agent)\//, "");
  return RUN_SESSION_ID.test(id) ? id : null;
}

/** O sessionId de um branch de SESSÃO (`[failed/|conflicted/]agent/<uuid>`) — null para run/* e o resto.
 *  Os renames de preservação valem igual aos dos runs, então o prefixo é descascado antes. */
export function agentSessionIdFromBranch(branch: string): string | null {
  const rest = branch.replace(PRESERVED_PREFIX, "");
  if (!rest.startsWith("agent/")) return null;
  const id = rest.slice("agent/".length);
  return RUN_SESSION_ID.test(id) ? id : null;
}

/**
 * O ref onde a ferramenta grava a base ATUAL de um branch de sessão (WS-1/G4). `worktree_open` o escreve
 * no corte e `worktree_refresh` o REESCREVE a cada rebase — é o que mantém a régua de own-work exata
 * depois que o rebase invalida o `Created from` do reflog. Fora de `refs/heads/*` de propósito: não é um
 * branch, não aparece em `git branch`, e nenhum sweep de branch o confunde com trabalho.
 */
export function agentBaseRef(sessionId: string): string {
  return `refs/agent-base/${sessionId}`;
}

/** A ÚLTIMA entrada `Created from` do reflog é a criação (um rename empilha entradas mais novas). */
export function parseCreatedFrom(reflog: string): string | null {
  const shas = [...reflog.matchAll(CREATED_FROM)].map((m) => m[1]);
  const sha = shas[shas.length - 1];
  return sha && SHA.test(sha) ? sha : null;
}

const q = (s: string) => JSON.stringify(s);

/** git que devolve `ok:false` no exit != 0 — UMA FALHA NÃO É UM RESULTADO VAZIO (confundir os dois é
 *  como um git quebrado viraria "o branch está vazio, pode apagar"). */
async function tryGit(
  exec: ExecFn,
  repoRoot: string,
  cmd: string,
  timeout = 30_000,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await exec(cmd, { cwd: repoRoot, timeout });
    return { ok: true, stdout: String(stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * O sha de onde este branch foi cortado. Base-ref primeiro (só sessões — exato E vivo através do rebase),
 * reflog depois (exato), fork-point como estimativa.
 * `provenance: "none"` ⇒ o chamador NÃO sabe nada e deve falhar fechado (preservar / não colher).
 */
export async function resolveRunBase(
  exec: ExecFn,
  repoRoot: string,
  branch: string,
  opts: { stageBranch?: string | null } = {},
): Promise<RunBase> {
  // WS-1/G4: um branch de sessão pode ter sido REBASADO por `worktree_refresh`, e o rebase NÃO reescreve o
  // `Created from` do reflog — só este ref sabe a base ATUAL. Por isso ele vem ANTES do reflog: consultar o
  // reflog primeiro devolveria o corte ORIGINAL e re-atribuiria à sessão todo commit que o stage ganhou desde
  // então. Ausente (sessão pré-WS-1 / ref colhido) ⇒ cai no reflog, o comportamento de sempre.
  const sessionId = agentSessionIdFromBranch(branch);
  if (sessionId) {
    const ref = await tryGit(exec, repoRoot, `git rev-parse --verify --quiet ${q(`${agentBaseRef(sessionId)}^{commit}`)}`);
    const out = ref.stdout.trim();
    if (ref.ok && SHA.test(out)) return { base: out, provenance: "base-ref" };
  }
  const reflog = await tryGit(exec, repoRoot, `git reflog show ${q(branch)}`);
  if (reflog.ok) {
    const sha = parseCreatedFrom(reflog.stdout);
    if (sha) {
      const resolved = await tryGit(exec, repoRoot, `git rev-parse --verify --quiet ${q(`${sha}^{commit}`)}`);
      const out = resolved.stdout.trim();
      if (resolved.ok && SHA.test(out)) return { base: out, provenance: "reflog" };
    }
  }
  for (const against of [opts.stageBranch, "HEAD"].filter((x): x is string => !!x)) {
    const mb = await tryGit(exec, repoRoot, `git merge-base ${q(against)} ${q(branch)}`);
    const sha = mb.stdout.trim();
    if (mb.ok && SHA.test(sha)) return { base: sha, provenance: "fork-point" };
  }
  return { base: "", provenance: "none" };
}

/**
 * O que o run commitou POR CIMA da sua base: `base..branch` (two-dot — o que o branch ADICIONOU, não
 * `HEAD...branch`, que reatribuiria a herança do stage a este run). `null` quando o git não respondeu.
 */
export async function runOwnWork(
  exec: ExecFn,
  repoRoot: string,
  branch: string,
  base: string,
): Promise<RunOwnWork | null> {
  if (!base) return null;
  const count = await tryGit(exec, repoRoot, `git rev-list --count ${q(base)}..${q(branch)}`);
  const commits = Number(count.stdout.trim());
  if (!count.ok || !Number.isFinite(commits)) return null;
  const diff = await tryGit(exec, repoRoot, `git diff --name-only ${q(base)}..${q(branch)}`);
  if (!diff.ok) return null;
  const files = diff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { commits, files };
}
