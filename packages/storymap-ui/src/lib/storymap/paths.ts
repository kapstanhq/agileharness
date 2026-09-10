import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── RESOLUÇÃO DE RAIZ — FAIL-LOUD (F0 do plano multi-target, docs/plans/agileharness-oss/09) ─────────
//
// O QUE MUDOU E POR QUÊ. Esta função caía, sem log, em `resolve(cwd, "..", "..")` quando não achava o
// marcador. Isso é o par mais perigoso do inventário, porque quem CONSOME o resultado inclui os reapers
// de boot (`instrumentation.ts`), que rodam `git branch -D` e `git worktree remove --force` sobre ele.
// Um checkout sem o marcador — que é o caso de QUALQUER repositório que não seja este monorepo — já
// estava nessa condição hoje: a ferramenta apontava para o diretório PAI e apagava branch lá.
//
// Três regras substituem o palpite:
//   1. `AGILEHARNESS_TARGET` explícito vence tudo (é o degrau que F1 promove a registro de targets).
//   2. Senão, sobe procurando um MARCADOR. `turbo.json` sozinho não serve — é Turborepo, ausente na
//      esmagadora maioria dos repositórios. `.git` é o marcador universal, e vale como ARQUIVO também
//      (num worktree linkado `.git` é um arquivo, não um diretório).
//   3. Não achou ⇒ **LANÇA**, nomeando o que procurou e onde. Nunca adivinha.
//
// O TERCEIRO MARCADOR (`storymap/boards`) e por que ele é seguro. Quem baixa o ZIP do repositório —
// e não clona — não tem `.git`; o artefato publicado também não tem `turbo.json` (a régua corta a infra
// do monorepo). Resultado MEDIDO: a ferramenta não subia, e a saída que o próprio erro sugeria
// (`AGILEHARNESS_TARGET=$PWD`, exatamente o que o README manda) TAMBÉM falhava, porque o caminho declarado
// é cobrado do mesmo marcador. O primeiro contato do adotante era um beco.
//
// `storymap/boards` é o marcador NATURAL desta ferramenta: é a árvore sobre a qual ela opera. E não
// reabre o risco que os outros dois fecham, por construção: sem `.git` no lugar resolvido, o portão do
// boot decide INERTE (`engine-armed.ts`: `gitIsDirectory === null` ⇒ "na dúvida, inerte"), então
// nenhum `git branch -D` / `git worktree remove --force` chega a existir. Ele também MELHORA o caso do
// ZIP descompactado DENTRO de outro repositório git: o marcador mais PRÓXIMO vence, então a raiz passa
// a ser a pasta extraída (e inerte), em vez do repositório de fora (que armaria com a raiz errada).
export const ROOT_MARKERS = ["turbo.json", ".git", "storymap/boards"] as const;

/** Um marcador pode ser aninhado (`storymap/boards`) — resolvido por segmento, nunca por concatenação
 *  crua, para o teste valer em qualquer separador de caminho. */
function hasMarker(dir: string, marker: string): boolean {
  return existsSync(path.join(dir, ...marker.split("/")));
}
const MAX_ROOT_WALK = 12;

/** A raiz não pôde ser resolvida. Carrega o que foi procurado — um erro que não diz onde olhou obriga
 *  o operador a adivinhar exatamente onde o código adivinhava antes. */
export class RepoRootUnresolvedError extends Error {
  constructor(
    readonly from: string,
    readonly searched: readonly string[],
  ) {
    super(
      `[storymap] raiz de repositório não resolvida a partir de ${from}. ` +
        `Procurei por ${ROOT_MARKERS.join(" ou ")} subindo ${searched.length} nível(is): ` +
        `${searched.join(", ")}. ` +
        `Declare a raiz explicitamente em AGILEHARNESS_TARGET, ou rode a partir de um checkout git.`,
    );
    this.name = "RepoRootUnresolvedError";
  }
}

let cachedRoot: string | null = null;

/** Test-only: descarta a raiz memoizada (a suíte troca de cwd entre casos). */
export function resetRepoRootCache(): void {
  cachedRoot = null;
}

export function findRepoRoot(): string {
  if (cachedRoot) return cachedRoot;

  // (1) Declaração explícita vence. Validada: um alvo declarado e inexistente é erro, nunca um silêncio
  // que degrada para a busca — senão um typo no env volta a resolver para o diretório errado.
  const declared = process.env.AGILEHARNESS_TARGET?.trim();
  if (declared) {
    const abs = path.resolve(declared);
    // Validado como DIRETÓRIO, não só "existe": um arquivo regular passava e era memoizado como raiz
    // (achado de revisão). Um alvo declarado errado tem de falhar aqui, não virar caminhos absurdos
    // dezenas de chamadas depois.
    //
    // ⚠ E validado como RAIZ, não só como diretório (segundo achado, mais grave). "Existe" deixava
    // passar `AGILEHARNESS_TARGET=/root/meu-monorepo/packages` — um diretório real, que virava
    // `cachedRoot`, e a partir dali `instrumentation.ts` e `recovery.ts` rodam `git branch -D` e
    // `git worktree remove --force` com cwd nesse caminho. O git resolve para CIMA: as operações
    // atingiriam o repositório PAI. Ou seja, o caminho DECLARADO — a porta que o próprio arquivo chama
    // de "o degrau que F1 promove a registro de targets" — reintroduzia o risco nº 1 que a busca por
    // marcador acabara de fechar, sem nem o silêncio ser o mesmo: aqui o operador acha que declarou.
    // Exigir o mesmo marcador dos dois caminhos é o que torna a declaração uma promessa verificada.
    if (!existsSync(abs) || !statSync(abs).isDirectory() || !ROOT_MARKERS.some((m) => hasMarker(abs, m))) {
      throw new RepoRootUnresolvedError(`AGILEHARNESS_TARGET=${declared}`, [abs]);
    }
    cachedRoot = abs;
    return abs;
  }

  // (2) Busca por marcador, registrando o caminho percorrido para o erro poder mostrá-lo.
  const from = process.cwd();
  const searched: string[] = [];
  let dir = from;
  for (let i = 0; i < MAX_ROOT_WALK; i++) {
    searched.push(dir);
    if (ROOT_MARKERS.some((m) => hasMarker(dir, m))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // (3) Falha ALTO. O fallback silencioso morreu aqui — paths-fail-loud.test.ts reprova se voltar.
  throw new RepoRootUnresolvedError(from, searched);
}

// ── A RAIZ DA FERRAMENTA — a irmã de findRepoRoot(), e a pergunta que ela NÃO responde ───────────────
//
// `findRepoRoot()` responde "onde mora o código do USUÁRIO" e obedece a `AGILEHARNESS_TARGET`. Existe uma
// segunda pergunta, que ninguém estava fazendo: "onde mora o código que está RODANDO?". Hoje as duas
// respostas coincidem — a ferramenta vive dentro do repositório que ela opera — e por isso todo
// chamador que as confunde passa calado. Elas divergem no instante em que o serviço passa a rodar de um
// checkout PRÓPRIO gerenciando outro repositório como alvo.
//
// O que a confusão custava, MEDIDO: o self-deploy reconstruía `<ALVO>/packages/storymap-ui` — a cópia
// que NÃO roda — reiniciava o systemd que serve da outra árvore, e carimbava sucesso medindo o HEAD do
// repositório errado. A fila de publicação em modo `auto` dispara esse caminho sem humano nenhum.
//
// A DERIVAÇÃO É POR MARCADOR, NUNCA POR PROFUNDIDADE FIXA, e o motivo é medido, não suposto:
//   · sob `bun build --target=node --format=esm`, `import.meta.url` é emitido VERBATIM — vivo, imune a
//     `cwd`, e acompanha o ARQUIVO (dois artefatos do mesmo código, em árvores diferentes, resolvem
//     cada um a sua). É a única âncora que serve.
//   · `__dirname`, não: o bundler o INLINA como literal absoluto DA MÁQUINA DE BUILD. Medido comparando
//     dois bundles do MESMO código, construídos em checkouts diferentes: cada um carrega, cravado, o
//     caminho da árvore onde foi construído. É a definição de âncora que não serve.
//   · e a PROFUNDIDADE muda entre os dois contextos: da fonte (`src/lib/storymap/paths.ts`) a raiz do
//     pacote são 3 níveis; do bundle (`dist/ah-server.mjs`), 1. Uma constante `new URL("../../..")` só
//     pode estar certa num deles. Por isso: sobe procurando um marcador, como `findRepoRoot()` faz.
//
// O marcador é o `name` do package.json DESTE pacote — a auto-identificação da ferramenta, não um fato
// sobre o usuário. Ele muda no rename de layout (Fase 5 do plano da inversão); quando mudar, a busca
// FALHA ALTO em vez de resolver para o lugar errado, que é a única forma segura de um literal envelhecer.
export const TOOL_PACKAGE_NAME = "storymap-ui";

/** A raiz da ferramenta não pôde ser resolvida. Carrega onde procurou, pelo mesmo motivo do irmão. */
export class ToolRootUnresolvedError extends Error {
  constructor(
    readonly from: string,
    readonly searched: readonly string[],
  ) {
    super(
      `[storymap] raiz da FERRAMENTA não resolvida a partir de ${from}. ` +
        `Procurei um package.json com name="${TOOL_PACKAGE_NAME}" subindo ${searched.length} nível(is): ` +
        `${searched.join(", ")}. ` +
        `Declare-a explicitamente em AGILEHARNESS_TOOL_ROOT (o diretório do PACOTE), ou rode a ferramenta ` +
        `de um checkout íntegro. Atenção: AGILEHARNESS_TARGET NÃO serve aqui — ele declara o ALVO.`,
    );
    this.name = "ToolRootUnresolvedError";
  }
}

let cachedToolPackageDir: string | null = null;

/** Test-only: descarta a memoização (a suíte exercita árvores diferentes no mesmo processo). */
export function resetToolRootCache(): void {
  cachedToolPackageDir = null;
}

function packageNameAt(dir: string): string | null {
  try {
    const nome = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown }).name;
    return typeof nome === "string" ? nome : null;
  } catch {
    return null;
  }
}

/**
 * O diretório do PACOTE da ferramenta que está rodando — o que se reconstrói e se reinicia.
 * NUNCA obedece a `AGILEHARNESS_TARGET`: apontar o alvo para outro lugar não muda qual código está no ar.
 */
export function findToolPackageDir(): string {
  if (cachedToolPackageDir) return cachedToolPackageDir;

  // (1) Declaração explícita vence — e é VALIDADA pelo mesmo marcador da busca, como em findRepoRoot().
  // Um declarado errado tem de falhar aqui, não virar um `cd` para o lugar errado no script destacado.
  const declarado = process.env.AGILEHARNESS_TOOL_ROOT?.trim();
  if (declarado) {
    const abs = path.resolve(declarado);
    if (!existsSync(abs) || !statSync(abs).isDirectory() || packageNameAt(abs) !== TOOL_PACKAGE_NAME) {
      throw new ToolRootUnresolvedError(`AGILEHARNESS_TOOL_ROOT=${declarado}`, [abs]);
    }
    cachedToolPackageDir = abs;
    return abs;
  }

  // (2) Sobe a partir da localização DESTA FONTE. `import.meta.url` acompanha o arquivo nos dois
  // contextos (fonte sob vitest, bundle em produção) — ver o bloco acima.
  const from = path.dirname(fileURLToPath(import.meta.url));
  const searched: string[] = [];
  let dir = from;
  for (let i = 0; i < MAX_ROOT_WALK; i++) {
    searched.push(dir);
    if (packageNameAt(dir) === TOOL_PACKAGE_NAME) {
      cachedToolPackageDir = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // (3) Falha ALTO, como o irmão. Um fallback aqui reintroduziria exatamente o defeito que este módulo
  // existe para fechar: resolver silenciosamente para a árvore errada.
  throw new ToolRootUnresolvedError(from, searched);
}

/** A raiz do REPOSITÓRIO da ferramenta — onde `git rev-parse HEAD` é a prova do que está no ar. */
export function findToolRoot(): string {
  const pacote = findToolPackageDir();
  let dir = pacote;
  for (let i = 0; i < MAX_ROOT_WALK; i++) {
    if (ROOT_MARKERS.some((m) => hasMarker(dir, m))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new ToolRootUnresolvedError(pacote, [pacote]);
}

/** Constrain ids to the slug charset so they can never escape the data dir. */
export function sanitizeId(id: string): string {
  return String(id ?? "")
    .replace(/[^a-z0-9-]/gi, "")
    .slice(0, 100);
}

export function storymapDir(): string {
  return path.join(findRepoRoot(), "storymap");
}

export function boardsDir(): string {
  return path.join(storymapDir(), "boards");
}

export function boardDir(boardId: string): string {
  return path.join(boardsDir(), sanitizeId(boardId));
}

export function cardsDir(boardId: string): string {
  return path.join(boardDir(boardId), "cards");
}

export function cardPath(boardId: string, cardId: string): string {
  return path.join(cardsDir(boardId), `${sanitizeId(cardId)}.md`);
}

/**
 * autonomo-liberdade-humana M2 — the board's soft-delete QUARANTINE (`.trash/`). A deleted card/persona/system
 * moves here alongside a restore manifest; `restore_deleted` brings it back, and the trash GC prunes entries
 * older than 7 days (keyed on the manifest's `at`, not git time — this is git-tracked board data). Deletion is
 * therefore reversible for a week — the whole reason `delete_*` may be `reversible-delete` instead of `destructive`.
 */
export function trashDir(boardId: string): string {
  return path.join(boardDir(boardId), ".trash");
}

/** The trashed card FILE (the moved `.md`): `<board>/.trash/card-<id>.md`. */
export function trashedCardPath(boardId: string, cardId: string): string {
  return path.join(trashDir(boardId), `card-${sanitizeId(cardId)}.md`);
}

/** The restore MANIFEST sidecar for a trashed entry: `<board>/.trash/<kind>-<id>.json` (kind = card|persona|system). */
export function trashManifestPath(boardId: string, kind: string, id: string): string {
  return path.join(trashDir(boardId), `${sanitizeId(kind)}-${sanitizeId(id)}.json`);
}

export function boardConfigPath(boardId: string): string {
  return path.join(boardDir(boardId), "board.yaml");
}

/**
 * Um DOCUMENTO de board — `storymap/boards/<board>/docs/<docType>.md`.
 *
 * A zona onde vive o conteúdo cuja fonte da verdade é o MARKDOWN, não o `board.yaml`: o Lean Canvas
 * é o primeiro, e a régua para os próximos é a mesma linha que impede o drift de volta —
 * **frontmatter = o que a máquina lê e roteia; corpo = o que o humano lê e escreve**. Prosa que
 * morava em block scalar de YAML (`positioning:`, o `prompt:` de uma persona) pertence aqui; a
 * pipeline, os gates e os ids continuam no `board.yaml`, que é configuração de máquina.
 *
 * Arquivo por documento, e não um campo string dentro do YAML, por um motivo prático: assim o
 * `git diff` de uma edição de conteúdo é um diff de PROSA legível, e não um bloco `>-` reindentado.
 */
export function boardDocsDir(boardId: string): string {
  return path.join(boardDir(boardId), "docs");
}

export function boardDocPath(boardId: string, docType: string): string {
  return path.join(boardDocsDir(boardId), `${sanitizeId(docType)}.md`);
}

/**
 * The shared board TEMPLATE — boards/_base/board.yaml. Boards INHERIT its canonical pipeline +
 * common vocabulary; each board.yaml carries only its deltas (id, package, personas, the bits it
 * overrides). NOT a board: listBoards skips `_`-prefixed dirs, and the `_` keeps it out of the
 * sanitized board-id space (sanitizeId would strip it), so it can never be loaded as one. B5.
 */
export function baseBoardConfigPath(): string {
  return path.join(boardsDir(), "_base", "board.yaml");
}

/** Global runner settings (cross-board infra knobs). storymap/settings.yaml. */
export function settingsPath(): string {
  return path.join(storymapDir(), "settings.yaml");
}

/**
 * Ephemeral runner state dir (the durable run journal, the orchestrator budget, the audit + activity ledgers).
 * Gitignored.
 *
 * `AGILEHARNESS_RUNNER_STATE_DIR` REDIRECTS it — and the test setup ALWAYS sets it to a temp dir. Without that,
 * every suite that exercised a module touching this dir wrote into the LIVE state of the running service:
 * `guard.test.ts` fixtures (board "acme", card "c1") landed in the real copilot activity journal, so the
 * operator's own audit trail carried invented entries — a ledger you cannot trust is worse than no ledger.
 * Reading the env per call (not once at module load) keeps it honest under vitest's module reuse.
 */
export function runnerStateDir(): string {
  const override = process.env.AGILEHARNESS_RUNNER_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(storymapDir(), ".runner");
}

/** Persisted run telemetry (cost/turns/duration history per run). storymap/.runner/telemetry.json,
 * gitignored alongside the journal (story-observabilidade-runs-telemetria). */
export function telemetryPath(): string {
  return path.join(runnerStateDir(), "telemetry.json");
}

/** WS2 — the append-only JSONL ledger of card status transitions (honest history: every from→to hop + who). */
export function transitionsPath(): string {
  return path.join(runnerStateDir(), "transitions.jsonl");
}

/** Operator UI prefs for the web terminal — per-session alias + pinned flag, keyed by tmux session
 * name. Not board data (operator state, not product state): lives in the gitignored runner dir, and
 * the Next server is its SOLE writer (the static page mutates it via PATCH /api/terminal/sessions). */
export function terminalPrefsPath(): string {
  return path.join(runnerStateDir(), "terminal-prefs.json");
}

// --- Sidecars (Fase C): heavy content kept beside the card, not in its .md ---
export function plansDir(boardId: string): string {
  return path.join(boardDir(boardId), "plans");
}
export function planPath(boardId: string, cardId: string): string {
  return path.join(plansDir(boardId), `${sanitizeId(cardId)}.md`);
}
export function wireframesDir(boardId: string): string {
  return path.join(boardDir(boardId), "wireframes");
}
export function wireframePath(boardId: string, cardId: string): string {
  return path.join(wireframesDir(boardId), `${sanitizeId(cardId)}.json`);
}
/** Smart-capture proposal sidecar: the harness-capture output (summary + proposed items + feedback) for
 * a capture container card. proposals/<containerId>.json. */
export function proposalsDir(boardId: string): string {
  return path.join(boardDir(boardId), "proposals");
}
export function proposalPath(boardId: string, cardId: string): string {
  return path.join(proposalsDir(boardId), `${sanitizeId(cardId)}.json`);
}
/** Refine mode (improve a shipped story): per-card sidecar dir for the current-state
 * screenshot + any heavy refinement attachment (the brief itself rides in the card). */
export function refineDir(boardId: string, cardId: string): string {
  return path.join(boardDir(boardId), "refine", sanitizeId(cardId));
}
/** Fix mode (correct a regression in a shipped story): per-card sidecar dir for the
 * broken-state screenshot (the report itself rides in the card). */
export function bugsDir(boardId: string, cardId: string): string {
  return path.join(boardDir(boardId), "bugs", sanitizeId(cardId));
}
/** Retire mode (remove/archive a feature): per-card sidecar dir holding the
 * current-state screenshot + the removal plan the agent writes. The retirement
 * brief itself rides in the card .md. */
export function retireDir(boardId: string, cardId: string): string {
  return path.join(boardDir(boardId), "retire", sanitizeId(cardId));
}
/** The removal plan `harness-retire` writes (what to delete, ordered safely) for a card. */
export function retirePlanPath(boardId: string, cardId: string): string {
  return path.join(retireDir(boardId, cardId), "plan.md");
}

/**
 * Style Guide (bloco de Design, D2/D7/D12) — per-board sidecar zone for the canonical guide, its
 * reference-image batches and its generation proposals. storymap/boards/<board>/design/.
 */
export function designDir(boardId: string): string {
  return path.join(boardDir(boardId), "design");
}
/** The canonical compiled guide (D2/D3) — design/style-guide.md (frontmatter=machine, body=prose). */
export function styleGuideMdPath(boardId: string): string {
  return path.join(designDir(boardId), "style-guide.md");
}
/**
 * Reference-image batch dir — design/refs/<batchId>/ref-N.webp. D12: refs are IMMUTABLE per batch —
 * `batchId` is SERVER-generated (never client-supplied), so a published guide's cited paths never
 * change under it, and a re-upload lands in a fresh batch instead of overwriting a cited ref.
 */
export function designRefsDir(boardId: string, batchId: string): string {
  return path.join(designDir(boardId), "refs", sanitizeId(batchId));
}

/**
 * Feedback-overlay region SCREENSHOT dir — feedback/<batchId>/shot-N.png. Same discipline as
 * designRefsDir: `batchId` is SERVER-generated (never client-supplied), so no request can steer the
 * write anywhere but a fresh dir. Deliberately keyed by BATCH, not by card: a triage batch has no
 * card yet when the image is uploaded (the sink mints it afterwards), so a card-keyed dir would need
 * a move + a rewrite of the reference. The card points at the image by URL instead.
 */
export function feedbackShotsDir(boardId: string, batchId: string): string {
  return path.join(boardDir(boardId), "feedback", sanitizeId(batchId));
}

/** The repo-relative-path charset a board-authored code reference may use (matches engine.ts's
 *  `SAFE_PKG_PATH` — the read-only-trust regime for a `package:`/`brandbook:` value). `.` is allowed
 *  (dotfiles/extensions); `..` traversal is caught by the containment guard below, not the charset. */
const SAFE_REPO_REL = /^[A-Za-z0-9._/-]+$/;

/**
 * Resolve a board's product-file reference — the AgileHarness convention shared by `package:`,
 * `brandbook:` and `SystemDef.paths`: a code path is relative to the REPO ROOT, never to the package
 * dir. So `file` is joined to `repoRoot` (NOT to `<repoRoot>/<pkg>` — that double-prefix was the WS-4
 * drift bug: a guide's `tokenBindings.file` of `packages/acme/web/globals.css` resolved to
 * `<root>/packages/acme/packages/acme/web/globals.css` → "unreadable"). GUARDED: the resolved file
 * must live UNDER the board's own package (a board binds only to its own package's tokens), which
 * itself must stay under the repo. Returns null on any charset/containment violation — callers degrade
 * to skip/"unreadable", never throw. PURE: `repoRoot` is passed in (no fs), so it is unit-testable.
 */
export function resolveBoundFilePath(repoRoot: string, pkg: string, file: string): string | null {
  if (!SAFE_REPO_REL.test(pkg) || !SAFE_REPO_REL.test(file)) return null;
  const root = path.resolve(repoRoot);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const pkgDir = path.resolve(root, pkg);
  if (pkgDir !== root && !pkgDir.startsWith(rootWithSep)) return null; // pkg escaped the repo
  const pkgWithSep = pkgDir.endsWith(path.sep) ? pkgDir : pkgDir + path.sep;
  const resolved = path.resolve(root, file); // REPO-root-relative (AgileHarness convention), NOT pkg-relative
  if (!resolved.startsWith(pkgWithSep)) return null; // the bound file must live under the board's package
  return resolved;
}

/** Governance proposal zone — per-board sidecar dir for GovernanceDraft JSON files.
 * Distinct from proposals/ (smart-capture, per-card) to avoid filename collisions. */
export function governanceDir(boardId: string): string {
  return path.join(boardDir(boardId), "governance");
}
/** Path to a single GovernanceDraft sidecar: boards/<board>/governance/<draftId>.json. */
export function governancePath(boardId: string, draftId: string): string {
  return path.join(governanceDir(boardId), `${sanitizeId(draftId)}.json`);
}

/** F5.4 — approval-request zone: per-board sidecar dir for the copiloto's ApprovalRequest JSON files
 *  (a scoped agent asks the human to grant an `ask`-disposition action before it re-tries the call). */
export function approvalsDir(boardId: string): string {
  return path.join(boardDir(boardId), "approvals");
}
/** Path to a single ApprovalRequest sidecar: boards/<board>/approvals/<id>.json. */
export function approvalPath(boardId: string, id: string): string {
  return path.join(approvalsDir(boardId), `${sanitizeId(id)}.json`);
}
/** F5.6 — agent-action audit ledger: append-only JSONL of the guard's per-call decisions. */
export function agentActionsPath(): string {
  return path.join(runnerStateDir(), "agent-actions.jsonl");
}
