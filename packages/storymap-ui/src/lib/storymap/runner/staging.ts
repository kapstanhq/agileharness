// Staged-release routing (Fase 4a) — PURE helpers deciding HOW the merge train integrates a run branch.
//
// Empirical context (14 leftover run/* branches inspected): autorun work is ~93% board DATA — cards
// under `storymap/**`, skills under `.claude/**` — and only `harness-do` produces app CODE under
// the code prefixes (e.g. `packages/**`). So the train routes a run by its changed paths:
//   - NO code paths (the common case) → merge straight to MAIN, exactly as before (board + cascade stay
//     live; .md data can't break a build, so no gate is needed).
//   - SOME code paths → the CODE is held on the integration branch (`autorun.staging.branch`, default
//     `stage`) behind the human release gate, while the run's non-code (board data / skills) still lands
//     on MAIN so the live board keeps advancing.
//
// Kept OUT of merge-queue.ts so the routing decision is unit-testable without the queue's git DI. The
// git plumbing (reading the diff, the dual-target merge) lives in the queue and calls these to decide.
//
// CLIENT-SAFE de propósito (zero import de servidor): `diff.ts` — que um componente de tela importa — lê a
// régua de código e o branch de integração DAQUI. Por isso o default do branch mora aqui como espelho de
// `DEFAULT_STAGING_BRANCH` (config.ts) e um teste trava a igualdade, em vez de um import de config.

import { layoutOf } from "../target-profile";

/**
 * O ÚNICO default de branch de integração que a ferramenta mantém: onde o código espera o portão de release
 * quando o alvo não declara `autorun.staging.branch`. É CONVENÇÃO da ferramenta (documentada), não suposição
 * sobre o repositório — e o staging só liga por opt-in. Espelho de `DEFAULT_STAGING_BRANCH` (config.ts);
 * staging.test.ts prova que os dois são o mesmo valor.
 */
export const STAGING_BRANCH_DEFAULT = "stage";

/** O que se lê do bloco `autorun.staging` (estrutural: serve ao tipo do settings e ao do MergeQueueConfig). */
export interface StagingScopeSource {
  branch?: string;
  codePrefixes?: readonly string[];
  declared?: { branch?: boolean; codePrefixes?: boolean };
}

/**
 * O branch de integração EFETIVO: o declarado em `autorun.staging.branch`, senão {@link STAGING_BRANCH_DEFAULT}.
 * Existe para ninguém mais escrever `?? "stage"` à mão (eram nove cópias do literal, e uma delas sobrescrevia
 * a declaração do repositório). PURA.
 */
export function stagingBranchOf(staging: StagingScopeSource | null | undefined): string {
  return staging?.branch?.trim() || STAGING_BRANCH_DEFAULT;
}

/**
 * Os `codePrefixes` que o repositório DECLAROU, ou `undefined` quando não declarou — e a diferença importa:
 *   · `[]` explícito  ⇒ «nada é código» (staging inerte; vale como foi declarado);
 *   · `undefined`     ⇒ «não declarei»: os consumidores tratam tudo fora de `storymap/boards/` como código
 *     ({@link isCodePath}) — a direção SEGURA, que só preserva e verifica MAIS, nunca descarta código.
 * O bloco vindo de `loadRunnerConfig()` traz `declared` (o que o ARQUIVO disse, distinto do default que a
 * coerção preenche); um objeto montado à mão (testes, `MergeQueueConfig`) não traz, e então o valor dado vale
 * como declarado. Mesma regra de `layoutOf` (target-profile.ts), que é quem a define. PURA.
 */
export function declaredCodePrefixes(staging: StagingScopeSource | null | undefined): readonly string[] | undefined {
  if (!staging) return undefined;
  if (staging.declared) return layoutOf({ autorun: { staging } }).codePrefixes;
  return staging.codePrefixes;
}

/**
 * Does this set of changed paths include any DEPLOYABLE CODE — a path under one of `codePrefixes`
 * (e.g. `packages/`)? A run with code is routed to the integration branch; a run with NONE merges to main.
 *
 * `changedPaths` are repo-relative POSIX paths as `git diff --name-only` emits them (no leading `./`).
 * An EMPTY `codePrefixes` means "nothing is code" → always false → every run merges to main (staging
 * inert); `undefined` (not declared) means everything outside `storymap/boards/` is code — see
 * {@link isCodePath}. Pure: the caller supplies the already-read diff, so this never touches disk.
 */
export function pathsTouchCode(
  changedPaths: readonly string[],
  codePrefixes: readonly string[] | undefined,
): boolean {
  return changedPaths.some((p) => isCodePath(p, codePrefixes));
}

/**
 * UM caminho é CÓDIGO? A régua única de quem decide entre «código» e «dado de board»:
 *   · `codePrefixes` declarado ⇒ sob algum prefixo (um `[]` declarado ⇒ nada é código);
 *   · `codePrefixes` INDECLARADO (`undefined`) ⇒ tudo fora de `storymap/boards/` é código. É o neutro seguro:
 *     errar para este lado só faz o train gatear/preservar MAIS; errar para o outro (um repositório de layout
 *     plano, `src/` na raiz, sem declaração) fazia `src/**` virar «dado» e um branch com código ser descartado.
 * PURA.
 */
export function isCodePath(p: string, codePrefixes: readonly string[] | undefined): boolean {
  if (codePrefixes === undefined) return !p.startsWith(BOARD_DATA_PREFIX);
  return codePrefixes.some((prefix) => p.startsWith(prefix));
}

/**
 * Do these changed paths touch a USER-VISIBLE UI surface? Feeds the QA gate: a run that edited a
 * screen must PROVE the visual sweep ran, instead of self-declaring that it has no surface.
 *
 * Why by EVIDENCE and not by a field on the card: `hasUiSurface` is authored by an LLM skill and was
 * set on almost no real card, so in practice the gate always fell through to `storyType === "user"` —
 * and a `chore`/`technical`/`bug` that rewrote a component shipped with NO visual QA at all. A run's
 * diff is a FACT the engine already reads (worktreeOps.changedPaths); the declaration is an opinion
 * nobody remembers to give. Same reasoning as buildEvidence/deployProof: prove, don't assert.
 *
 * `patterns` are matched as SUFFIXES (`.tsx`) or path SUBSTRINGS (`src/components/`) — whichever the
 * consuming repo declares (`autorun.qa.uiSurfacePatterns`). The default is by file EXTENSION only,
 * which is a fact about the LANGUAGE, not about this product — a clone of AgileHarness into another
 * repo classifies correctly without configuring anything, and a repo with different conventions adds
 * its own. An EMPTY `patterns` means "nothing is a UI surface" → always false (classifier inert).
 *
 * Pure: the caller supplies the already-read diff, so this never touches disk.
 */
export function pathsTouchUiSurface(
  changedPaths: readonly string[],
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false;
  return changedPaths.some((p) => patterns.some((pat) => (pat.startsWith(".") ? p.endsWith(pat) : p.includes(pat))));
}

/**
 * The subset of {@link pathsTouchUiSurface}'s matches — the actual files that made the verdict true.
 * Stamped onto the card (capped by the caller) so an operator reading a blocked gate sees WHICH file
 * put the card there, instead of an unfalsifiable "the system says it has UI".
 */
export function uiSurfacePaths(
  changedPaths: readonly string[],
  patterns: readonly string[],
): string[] {
  if (patterns.length === 0) return [];
  return changedPaths.filter((p) => patterns.some((pat) => (pat.startsWith(".") ? p.endsWith(pat) : p.includes(pat))));
}

/**
 * Partition a run's changed paths into the CODE set (routed to `stage`) and the DATA set (routed to
 * main: board cards, skills, docs, configs). The complement of {@link pathsTouchCode}'s predicate,
 * surfaced as the two lists the dual-target merge needs. Order-preserving and de-dup-free (the diff is
 * already unique). An empty `codePrefixes` puts everything in `data` (→ all to main); `undefined` (not
 * declared) puts everything outside `storymap/boards/` in `code` — see {@link isCodePath}.
 *
 * `dataDerived` — paths that live UNDER a code prefix but are DERIVED FROM board data, so they belong
 * to the DATA half despite their location. Routing them by path tears a derived artifact away from the
 * source that defines it, and both halves end up wrong at once (seen in production):
 * on `stage` the artifact regenerates against main's UNCHANGED board data and reverts, so the landing
 * verifier (#38) reports the change as a lost implementation and blames the session; on `main` the new
 * source lands WITHOUT its artifact, turning main's own suite red — and the train's gate is fail-closed,
 * so that freezes the whole queue. A derived file follows its SOURCE, never its own path.
 *
 * WHICH files derive from data is a fact about the consuming repo, so it comes from the spec
 * (`settings.yaml staging.dataDerived`), never a constant in here. Omitted/empty ⇒ byte-identical to
 * the pre-existing partition, so a repo that declares nothing behaves exactly as before.
 */
export function partitionPaths(
  changedPaths: readonly string[],
  codePrefixes: readonly string[] | undefined,
  dataDerived: readonly string[] = [],
): { code: string[]; data: string[] } {
  const derived = new Set(dataDerived);
  const code: string[] = [];
  const data: string[] = [];
  for (const p of changedPaths) {
    const looksLikeCode = isCodePath(p, codePrefixes);
    if (looksLikeCode && !derived.has(p)) code.push(p);
    else data.push(p);
  }
  return { code, data };
}

/** Board data NEVER travels with code — it is the one half whose destination is not negotiable. */
export const BOARD_DATA_PREFIX = "storymap/boards/";

/**
 * O arquivo de um CARD (`storymap/boards/<board>/cards/<id>.md`) — ESTADO VIVO do pipeline, não entregável: o serviço o
 * reescreve a cada transição (status, findings, carimbos de deploy), inclusive o ato de publicar. Quem mede "o delta
 * deste card aterrissou em main?" por igualdade de conteúdo não pode exigir que ele seja idêntico — nunca é, e o
 * próprio settle é quem o muda. (Num caso real, um card ficou preso por mais de um dia em «board-data-nao-aterrissou» com todos os
 * arquivos entregáveis idênticos em main e só os arquivos de card do range diferentes.) PURA.
 */
export function isLiveCardFile(p: string): boolean {
  return p.startsWith(BOARD_DATA_PREFIX) && /^[^/]+\/cards\/[^/]+\.md$/.test(p.slice(BOARD_DATA_PREFIX.length));
}

/** Relative import/require/dynamic-import specifiers. Deliberately syntactic: the split runs on a bare
 *  git tree, with no resolver, no `node_modules` and no TS program to ask. */
const RELATIVE_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;

/** Extension-less specifiers resolve through these, in order — the same shapes Node/TS accept. */
const RESOLUTION_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".json", "/index.ts", "/index.js"];

/** Normalize `a/b/../c` → `a/c` without touching the filesystem (the paths are repo-relative). */
function normalizeRepoPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/**
 * Move DATA-half files into the CODE half when a code file IMPORTS them — the exact mirror of
 * `dataDerived`, which moves code-located files into the data half because they derive from data.
 * One rule, stated once: **a file travels with whatever DEFINES its correctness.** A derived artifact
 * is defined by its source; an imported module is defined by its importer's build.
 *
 * WHY this exists. `codePrefixes` is `packages/` alone, and routing skills/docs/configs to main is a
 * DELIBERATE design choice (they are live-by-mtime, not deployable code) — not a misclassification to
 * be tuned away. But the prefix says nothing about DEPENDENCY, so a single commit adding
 * a shared helper under `tools/` plus the several `vitest.config.ts` files that import it got
 * torn in half: the configs landed on `stage`, the helper on `main`, and `stage` was left with those
 * configs importing a file that is not there (ERR_MODULE_NOT_FOUND at config load). Run worktrees are
 * cut from stage, so that breaks the GATE of every later run touching those packages — a silent,
 * fleet-wide failure produced by a green integration. Seen in production.
 *
 * Syntactic on purpose: it over-approximates (a specifier inside a comment or a string still counts),
 * which is the safe direction — a file that did NOT need to travel with the code merely lands on stage
 * instead of main, and reaches main at the next release. Under-approximating breaks stage.
 *
 * Board data (`storymap/boards/**`) is NEVER promoted: if code imports it, that is a genuine defect
 * the operator must see, not something to paper over by shipping board data to stage.
 *
 * @param readSource Reads a repo-relative path AT THE RUN'S REV; `null` when unreadable (deleted, binary).
 */
export function promoteImportedDataPaths(
  code: readonly string[],
  data: readonly string[],
  readSource: (path: string) => string | null,
): { code: string[]; data: string[]; promoted: string[] } {
  const dataSet = new Set(data);
  const promoted = new Set<string>();
  // Worklist, not a single pass: a promoted file may itself import another data-half file.
  const queue = [...code];
  const scanned = new Set<string>();

  while (queue.length > 0) {
    const importer = queue.shift() as string;
    if (scanned.has(importer)) continue;
    scanned.add(importer);

    const source = readSource(importer);
    if (!source) continue;
    const dir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";

    for (const match of source.matchAll(RELATIVE_SPECIFIER_RE)) {
      const base = normalizeRepoPath(`${dir}/${match[1]}`);
      for (const suffix of RESOLUTION_SUFFIXES) {
        const candidate = `${base}${suffix}`;
        if (!dataSet.has(candidate) || promoted.has(candidate)) continue;
        if (candidate.startsWith(BOARD_DATA_PREFIX)) continue; // never — see doc above
        promoted.add(candidate);
        queue.push(candidate);
        break;
      }
    }
  }

  if (promoted.size === 0) return { code: [...code], data: [...data], promoted: [] };
  return {
    code: [...code, ...[...promoted].filter((p) => !code.includes(p))],
    data: data.filter((p) => !promoted.has(p)),
    promoted: [...promoted],
  };
}
