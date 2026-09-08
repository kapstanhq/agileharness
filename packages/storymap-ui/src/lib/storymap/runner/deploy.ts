// Fase 4c / Fase 5 — DEPLOY from board: publish a board's RELEASED code to Live. Board-aware off the
// board's `package` — fully agnostic, NO per-app names (the product target is derived from the package):
//   - storymap board (`packages/storymap-ui`, the tool ITSELF): a DETACHED rebuild+restart. The action
//     runs INSIDE the very service it must restart (the self-deploy paradox), so it can NEVER restart
//     in-process — a `systemctl restart` would kill the action mid-flight. `systemd-run` hands the
//     build+restart to its OWN transient unit, so this call returns immediately and the restart fires
//     detached, surviving the parent's death. The build runs BEFORE the restart, so a broken build never
//     restarts onto bad code (the old service keeps serving). A FIXED unit name makes it idempotent: a
//     second deploy while one is in flight fails to start a duplicate (a no-op, reported non-fatal).
//   - product board: `just orch-deploy <target>` via the shared ProductDeployRegistry
//     (the SAME mechanism the MCP `deploy` tool uses — observable via deploy_status). A product deploy does
//     NOT restart storymap, so it needs no systemd-run: it is a tracked child process. Idempotent via the
//     registry's per-pkg `isRunning`. The `<pkg>` is the basename of `package` (deployPkgForPackage),
//     validated against the targets THIS deployment declares (settings.yaml `deploy.targets`) — a package
//     not among them is a no-op note (never silently fired).
//   - DECLARED deploy (docs/plans/deploy-agnostic/, D-AG1..D-AG4): a board.yaml `deploy:` descriptor
//     overrides the package-derived routing — kind "command" runs the owner's declared LAUNCHER (an
//     allow-listed argv, never an arbitrary script: authorizeDeployCommand), kind "agent" runs a bounded
//     headless claude following the owner's recipe — BOTH through the same registry/settle cycle.
//     Absent descriptor / kind "auto" ⇒ the two legacy paths above, byte-identical.
//
// Pure over the injected `exec` (like release.ts / the merge queue) → the command construction is
// unit-testable without ever touching systemd; the product path takes an injectable registry (DI) so the
// test never spawns a real deploy. SERVER-ONLY in production.

import path from "node:path";

import type { ExecFn } from "./worktree";
import type { BoardDeployConfig } from "@/lib/storymap/types";
// story-frente3 — o `bun` do build STAGED deixou de ser o endereço da caixa do autor
// (`/root/.bun/bin/bun`) e passa pela régua declarado > PATH > recusa. Ver host-tools.ts.
import { quotePathForShell, resolveHostTool } from "./host-tools";
import {
  composedFaceTarget,
  deployPkgForPackage,
  productDeployTargets,
  getProductDeploy,
  touchesComposedFace,
  type ProductDeployRegistry,
} from "./product-deploy";
// story-dlsxfj (3ª passada) — a RÉGUA dos comandos declarados em board-data saiu daqui para um módulo PURO
// e sem imports (`deploy-command-guard.ts`). Não foi arrumação: o executor do TERCEIRO campo declarado no
// MESMO bloco `deploy:` (`canaryCommand`, em runner/face-probe.ts) não pode importar ESTE arquivo — o
// import de `product-deploy` logo acima lê um manifesto do disco em tempo de CARGA, a mina que forçou o
// split do face-probe. Enquanto a régua era propriedade deste caminho, o campo vizinho ia cru para
// `/bin/sh -c` e contornava as duas ondas anteriores. Re-exportada abaixo para quem já a importava daqui.
import { authorizeDeployCommand, quoteArgv, shSingleQuote } from "./deploy-command-guard";
import { findToolPackageDir } from "@/lib/storymap/paths";

export {
  authorizeDeployCommand,
  parseDeclaredArgv,
  quoteArgv,
  resolveDeployLaunchers,
  resolveDeployRecipes,
  resolveRecipeRunners,
  shSingleQuote,
  type DeployCommandVerdict,
} from "./deploy-command-guard";

const STORYMAP_PACKAGE = "packages/storymap-ui";
const DEPLOY_UNIT = "storymap-deploy"; // fixed → idempotent (a second deploy while running is a no-op)
const SYSTEMD_RUN_TIMEOUT_MS = 30_000;
// WS1.1 — the env var the settle webhook secret is read from. Imported into the transient unit via
// `systemd-run --setenv=NAME` (no value → systemd copies it from THIS service's env) so it never appears
// in the command line. The service already carries STORYMAP_MCP_TOKEN (same token /api/runner/* validate).
const WEBHOOK_TOKEN_ENV = "STORYMAP_MCP_TOKEN";
// Base URL the detached unit POSTs the settle back to — THIS service, loopback. Overridable for a non-default port.
const DEFAULT_SELF_URL = "http://127.0.0.1:3008";

/**
 * D-AG1 — PURE: which deploy MECHANISM does a board's descriptor select? Absent block ⇒ "auto" (the legacy
 * package-derived routing, byte-identical — every current board). An explicit `kind` wins; with `kind`
 * omitted the mechanism is inferred from which field the block carries (`command` ⇒ command, `description`
 * alone ⇒ agent — the 01-arquitetura-alvo target format declares no kind), and a block with neither falls
 * back to "auto" (e.g. only `healthUrl` declared). Exported for tests + the entry-effect layer.
 */
export function resolveDeployKind(cfg: BoardDeployConfig | undefined): "auto" | "command" | "agent" {
  if (!cfg) return "auto";
  if (cfg.kind) return cfg.kind;
  if (cfg.command?.trim()) return "command";
  if (cfg.description?.trim()) return "agent";
  return "auto";
}

/** DI seam for the agent path's PROOF settle (tests inject; the default dynamically imports the real
 *  settleDeploySuccess, mirroring entry-effects' evidence-settle import). */
export type DeploySettleFn = (
  board: string,
  cardId: string,
  opts: { source: "registry-ondone"; deps: { deployedShaFor: (target: string) => Promise<string | null> } },
) => Promise<unknown>;

const defaultSettle: DeploySettleFn = async (board, cardId, opts) => {
  const { settleDeploySuccess } = await import("./deploy-reconcile");
  return settleDeploySuccess(board, cardId, opts);
};

export interface DeployResult {
  /** the deploy was dispatched (the detached unit started / the product orch-deploy kicked off) */
  fired: boolean;
  /** D-AG2/D-AG3 add the board-DECLARED mechanisms: "board-command" (deploy.command via bash -lc) and
   *  "deploy-agent" (deploy.description via a bounded headless claude). */
  tool?: "systemd-restart" | "orch-deploy" | "board-command" | "deploy-agent";
  /** the product app deployed (orch-deploy target), when a product board fired */
  pkg?: string;
  /** story-efwo30: the deployment's declared face recipe is ARMED to fire once this backend deploy
   *  settles OK (the promoted diff touched the merged face, which orch-deploy does not publish). */
  chainedComposedFace?: boolean;
  /** The product-deploy targets whose publication makes the triggering card LIVE — the backend pkg plus the
   *  merged face when it was chained. Returned (not re-derived by the caller) so the effect layer can stamp it
   *  on the card WITHOUT importing a product name: this module is registered coupling debt, `entry-effects` is
   *  agnostic and must stay that way (agnostic-lint). Fuels the evidence-based deploy-failure reconciliation. */
  targets?: string[];
  /** WS1.1: the self-deploy fired with a card context, so its detached unit will POST a settle back to
   *  /api/runner/deploy-webhook. The caller (the deploy effect) stamps `deployFiredAt` on the card so the
   *  deploy-unsettled watchdog can catch a settle that never arrives (a dead restart). */
  settleArmed?: boolean;
  /** 1.5: a self-deploy could NOT start because one is already IN FLIGHT (the fixed `storymap-deploy` systemd
   *  unit is busy building). The caller parks the card in pending-self-deploy so the in-flight deploy's settle
   *  re-dispatches it — otherwise the card sits in "No ar" with no deployFiredAt, no settle and no watchdog
   *  (a silent terminal). Only ever set on the storymap self-deploy path (tool === "systemd-restart"). */
  inFlight?: boolean;
  /** when NOT fired: why (already in flight, package not deployable, no package) */
  reason?: string;
  /**
   * story-dlsxfj (3ª passada) — os passos de publicação DECLARADOS (`deploy.surfaces[].deployCmd`) que a
   * régua RECUSOU. Presente só quando houve recusa.
   *
   * Por que ele existe: a recusa é NÃO-FATAL por desenho (a prova do self-deploy é build+restart, não a
   * cópia da superfície), e uma recusa não-fatal que só aparece no log do unit é um NO-OP SILENCIOSO —
   * o deploy reporta sucesso e a superfície declarada simplesmente não foi publicada. Isso é pior que
   * falhar: o adotante cuja receita de publicação não está na allow-list default deste repo veria "deploy
   * ok" para sempre. Devolver a recusa aqui (e gritá-la no log do serviço, onde a linha `[deploy <board>]`
   * é lida) é o que a torna VISÍVEL sem torná-la fatal — nenhuma autonomia é perdida.
   */
  refusedPublishSteps?: { command: string; refusal: string }[];
}

/** Opts for {@link buildSelfDeployScript} — kept explicit so the builder stays PURE and unit-testable. */
export interface SelfDeployScriptOpts {
  /** A raiz do repositório ALVO — usada SÓ pelos passos de publicação de superfície declarados
   *  (`deploy.surfaces[].deployCmd`), que publicam artefato DO ALVO e por isso rodam de lá. */
  repoRoot: string;
  /** O diretório do PACOTE DA FERRAMENTA QUE ESTÁ RODANDO — o que se reconstrói e se reinicia.
   *  Deliberadamente NÃO derivado de `repoRoot`: era exatamente essa derivação que fazia o
   *  self-deploy buildar `<ALVO>/packages/storymap-ui` (uma cópia que não roda) e reiniciar o
   *  systemd que serve de outra árvore. Ver `findToolPackageDir()` em paths.ts. */
  toolPackageDir: string;
  /** board + card that triggered the deploy. When BOTH present the script chains the settle webhook; absent
   *  (a manual deploy, no card) → NO curl (fail-open: a manual deploy needn't settle any card). */
  board?: string;
  cardId?: string;
  /** base URL of THIS storymap service the settle POSTs back to (e.g. http://127.0.0.1:3008). */
  webhookBase: string;
  /** env var name holding the webhook secret — referenced as `$NAME` in the script; the transient unit
   *  imports it via `systemd-run --setenv=NAME`, so the value is NEVER interpolated into the script. */
  tokenEnvName: string;
  /** absolute path the build+restart output is captured to (source of the failure logTail). */
  logPath: string;
  /** story-zr1cmf — declared per-board `deploy.surfaces[].deployCmd`: extra PUBLISH steps run AFTER a
   *  successful build+restart (from the repo root via a login shell), each time-boxed and NON-FATAL. Empty/
   *  absent ⇒ byte-identical legacy self-deploy. Only the storymap self-deploy path threads these. */
  postBuildCommands?: readonly string[];
  /** story-frente3 — o caminho ABSOLUTO do `bun` que roda o build STAGED, resolvido pelo DESPACHO
   *  ({@link resolveHostTool}) e passado para cá para o builder seguir puro. Ausente ⇒ o nome nu `bun`,
   *  resolvido pelo PATH de quem executar o script. */
  bunPath?: string;
}

/** story-zr1cmf — how long a single declared post-build publish command may run before it is killed
 *  (SIGTERM via `timeout`). Generous for a local file sync; bounds a hung command from starving the
 *  settle curl on the card path. */
const POSTBUILD_TIMEOUT_S = 120;

/**
 * story-zr1cmf — PURE builder for the post-build PUBLISH segment of the self-deploy: the declared per-board
 * `deploy.surfaces[].deployCmd`, run AFTER a successful build+restart. Returns "" for no commands, so the
 * legacy script stays byte-identical. Each command is:
 *  - GATED on `[ "$STATUS" = ok ]` — a broken build/restart never publishes a surface;
 *  - run from the repo root, time-boxed by `timeout` and NON-FATAL (`|| echo … >> log`): a surface-sync
 *    hiccup is logged but never fails the unit nor flips the storymap-ui deploy STATUS (its proof is
 *    build+restart, not the surface copy).
 * `rootDirJson`/`logJson` are pre-JSON-quoted by the caller (double-quoted, no `$` inside → shell-safe).
 *
 * story-dlsxfj — COMO o passo privilegiado roda, e por quê assim. Ele roda como ROOT, então:
 *  - ALVO AUTORIZADO, não comando qualquer: {@link authorizeDeployCommand} decide o que pode ser
 *    EXECUTADO (allow-list de lançadores) — é isso que impede um `deployCmd: "bash -c '<payload>'"`, que a
 *    régua anterior (metacaractere fora de aspas) deixava passar inteiro por não ter metacaractere nenhum
 *    solto. Interpretador nunca é alvo válido. E a régua vale para a CADEIA inteira, não só para `argv[0]`:
 *    num task runner a RECEITA (allow-list) e a FORMA dos argumentos (palavra literal) também são
 *    verificadas, porque quem interpola parâmetro em linha de shell é a receita — `just canary-check
 *    '$(curl … | sh)'` tem lançador autorizado e roda o payload como root.
 *  - ARGV, não script: o shell entra pelo SCRIPT FIXO `exec "$@"` — uma constante deste arquivo,
 *    versionada e revisável — e as palavras declaradas chegam como ARGUMENTOS POSICIONAIS, que shell
 *    nenhum re-interpreta. O login shell (`-l`) permanece porque é dele que vem o PATH do operador (é
 *    assim que `just`/`bun` resolvem); o que deixou de existir é o shell lendo o DADO. Este repositório já
 *    teve injeção por interpolação de dado em comando (o sweep-commit) — é a mesma classe.
 *  - AUDITÁVEL: cada passo escreve no log a argv EXATA que vai executar, antes de executar. O que rodou
 *    como root fica escrito, não deduzido — e a recusa registra o MOTIVO nomeado, não um "recusado" mudo.
 *  - FAIL-CLOSED: uma declaração não autorizada NÃO É EXECUTADA — só registrada, e o unit segue (a recusa
 *    é tão não-fatal quanto uma falha do passo; a prova do self-deploy é build+restart, não a superfície).
 */
function buildPostBuildSegment(cmds: readonly string[], rootDirJson: string, logJson: string): string {
  if (cmds.length === 0) return "";
  const steps = cmds
    .map((cmd) => {
      const { argv, refusal } = authorizeDeployCommand(cmd);
      if (!argv) {
        return `echo ${shSingleQuote(`[postBuild] RECUSADO (${refusal}; nada executado): ${cmd}`)} >> ${logJson};`;
      }
      const words = quoteArgv(argv);
      return (
        `echo ${shSingleQuote(`[postBuild] argv: ${argv.join(" ")}`)} >> ${logJson}; ` +
        `( cd ${rootDirJson} && timeout ${POSTBUILD_TIMEOUT_S} bash -lc 'exec "$@"' postBuild ${words} ) >> ${logJson} 2>&1 ` +
        `|| echo ${shSingleQuote(`[postBuild] falhou (nao-fatal): ${cmd}`)} >> ${logJson};`
      );
    })
    .join(" ");
  return ` if [ "$STATUS" = ok ]; then ${steps} fi;`;
}

/**
 * O BUILD do self-deploy: escreve em `.next-staging` + `dist/ah-server.staged.mjs`, NUNCA nos artefatos
 * que o processo vivo está servindo. Ver o doc de `distDir` em `next.config.js`.
 *
 * story-frente3 — o executável vem de FORA (resolvido em {@link resolveHostTool} no despacho, não aqui,
 * para o builder seguir PURO). O default `"bun"` é o nome POSIX: num unit transiente ele resolve pelo
 * PATH do systemd, e quando NÃO resolve o log diz `bun: command not found` — uma falha que o operador
 * sabe ler. O que ele NUNCA é de novo é o caminho absoluto do home de uma pessoa específica.
 */
function stagedBuild(bunPath?: string): string {
  return `${quotePathForShell(bunPath ?? "bun")} run build:staged`;
}

/**
 * A TROCA, com o serviço PARADO — o que elimina a janela de 500 do deploy.
 *
 * O problema: `next build` reescrevia os arquivos DENTRO do `.next` que o servidor vivo lê por caminho a
 * cada request. Durante ~1 min por publicação o serviço respondia 500 (`clientModules` undefined, medido
 * 2026-07-28 18:49:51) — parecendo no ar, sem estar. `systemctl restart` no fim só encerrava a janela;
 * não a evitava.
 *
 * O desenho: o build inteiro roda em artefatos de STAGING (o vivo intocado, zero 500), e a troca é um
 * `mv` — instantâneo — feito com o serviço JÁ PARADO. A indisponibilidade que resta é a do restart, que
 * sempre existiu, e ela é HONESTA: conexão recusada, não um 200 mentiroso. É o padrão canônico de
 * distDir-swap; em Next 14 o `--distDir` do `next build` não existe mais, então o distDir vem do config
 * por env (ver `next.config.js`).
 *
 * Três invariantes, e cada uma custou uma linha:
 *  1. **O serviço SEMPRE volta.** `systemctl start` roda fora de qualquer `&&` — um `mv` que falhe não
 *     pode deixar o serviço no chão. É por isso que o status da troca viaja em `$SWAP` e é reavaliado no
 *     fim, em vez de encadear tudo.
 *  2. **Rollback antes do start.** Se o staging não entrar no lugar, o build anterior volta — melhor o
 *     código velho de pé que um diretório ausente.
 *  3. **O cache sobrevive.** Depois de um start bem-sucedido o build anterior VIRA o staging do próximo
 *     deploy, levando o `cache/` junto. Não é elegância: medido neste repo, staging frio = 136s e
 *     quente = 44s. Sem esta linha eu trocaria a janela de 500 por deploys 3x mais lentos, para sempre.
 */
const SWAP_AND_RESTART =
  "systemctl stop storymap; " +
  "rm -rf .next-prev; [ -d .next ] && mv .next .next-prev; " +
  "if mv .next-staging .next; then SWAP=ok; else [ -d .next ] || { [ -d .next-prev ] && mv .next-prev .next; }; SWAP=failed; fi; " +
  "[ \"$SWAP\" = ok ] && [ -f dist/ah-server.staged.mjs ] && mv dist/ah-server.staged.mjs dist/ah-server.mjs; " +
  "systemctl start storymap; " +
  "[ \"$SWAP\" = ok ] && [ -d .next-prev ] && mv .next-prev .next-staging; " +
  "[ \"$SWAP\" = ok ]";

/**
 * PURE builder for the storymap self-deploy script (the `bash -c` payload of the transient systemd unit).
 * Semantics (NOT a literal — see the tests):
 *  - build STAGED (`bun run build:staged` → `.next-staging`) THEN swap+restart, joined by `&&` so o build
 *    roda ANTES de o serviço ser tocado — um build quebrado nunca reinicia sobre código ruim (o serviço
 *    antigo segue servindo, agora SEM a janela de 500: ver {@link SWAP_AND_RESTART}).
 *  - the settle webhook closes the loop: success → STATUS=ok, else STATUS=failed; curl POSTs the versioned
 *    payload back to THIS service. `--retry-connrefused` is MANDATORY: the restart window IS exactly
 *    connection-refused, and curl will NOT retry that without the flag — the HAPPY path would fail to settle.
 *  - on failure the last ~50 lines of the log ride along as `logTailB64` (base64 → arbitrary log bytes never
 *    break the JSON) so the operator gets the WHY, not just "falhou".
 *  - NO card context → the curl (and the whole settle) is OMITTED (fail-open).
 *  - story-zr1cmf: any declared `postBuildCommands` run AFTER build+restart (STATUS-gated + non-fatal) on
 *    BOTH the card and the card-free branch — the card-free branch is the publish-queue's driver, so it gets
 *    the same STATUS discipline (never a bare `&&`) or a persistent surface-sync failure would go unnoticed.
 * The token is read from `$<tokenEnvName>` at runtime — never interpolated here.
 */
export function buildSelfDeployScript(opts: SelfDeployScriptOpts): string {
  const { repoRoot, board, cardId, webhookBase, tokenEnvName, logPath } = opts;
  const STAGED_BUILD = stagedBuild(opts.bunPath);
  const dir = JSON.stringify(opts.toolPackageDir); // double-quoted path (no $ inside) — safe
  const log = JSON.stringify(logPath);
  // The declared surface-publish supplement, spliced INTO this detached script so it inherits the systemd-run
  // detach + STATUS-gating + fixed-unit idempotency. Empty ⇒ "" ⇒ byte-identical legacy script.
  const postBuild = buildPostBuildSegment(opts.postBuildCommands ?? [], JSON.stringify(repoRoot), log);

  // Manual deploy (no card) → the classic build-before-restart chain, fail-open, nothing to settle.
  if (!board || !cardId) {
    if (!postBuild) return `cd ${dir} && ${STAGED_BUILD} && ${SWAP_AND_RESTART}`;
    // With a declared publish supplement the card-free chain gains a STATUS so the supplement GATES on a
    // clean build+restart and self-heals: the publish queue self-deploys card-free várias vezes ao dia, and
    // an idempotent sync converges the docroot to zero drift instead of waiting on a remembered manual step.
    const buildRestartNoCard =
      `cd ${dir} && if ${STAGED_BUILD} > ${log} 2>&1 && ` +
      `{ ${SWAP_AND_RESTART}; } >> ${log} 2>&1; then STATUS=ok; else STATUS=failed; fi`;
    return `${buildRestartNoCard};${postBuild}`;
  }

  const buildRestart =
    `cd ${dir} && if ${STAGED_BUILD} > ${log} 2>&1 && ` +
    `{ ${SWAP_AND_RESTART}; } >> ${log} 2>&1; then STATUS=ok; else STATUS=failed; fi`;
  // The webhook URL is double-quoted so bash expands `$<tokenEnvName>` (the imported secret) at runtime. It is
  // written to a mode-600 temp config via `printf` (a bash BUILTIN → the token never becomes a separate
  // process's argv) and read by curl via -K, so the secret appears in NEITHER curl's argv (no /proc/<pid>/
  // cmdline nor `ps` exposure during the --retry window) NOR the command line.
  const url = JSON.stringify(`${webhookBase.replace(/\/+$/, "")}/api/runner/deploy-webhook?secret=$${tokenEnvName}`);
  // ok payload fully baked in JS (board/cardId are slugs). failed payload: board/cardId baked, logTailB64
  // filled at runtime (%s ← $TAIL). Single-quoted for bash so the embedded JSON double-quotes stay literal.
  const okPayload = shSingleQuote(JSON.stringify({ v: 1, board, cardId, status: "ok", phase: "self-deploy" }));
  const failedFmt = shSingleQuote(
    `{"v":1,"board":${JSON.stringify(board)},"cardId":${JSON.stringify(cardId)},"status":"failed","phase":"self-deploy","logTailB64":"%s"}`,
  );
  const settle =
    `PF=$(mktemp); CFG=$(mktemp); ` +
    // Write `url = "<url-with-secret>"` to the mode-600 config via the printf BUILTIN (no forked process → no
    // argv exposure of the token); curl reads the URL from it via -K.
    `printf 'url = "%s"\\n' ${url} > "$CFG"; ` +
    `if [ "$STATUS" = ok ]; then printf '%s' ${okPayload} > "$PF"; ` +
    `else TAIL=$(tail -n 50 ${log} 2>/dev/null | base64 | tr -d '\\n'); printf ${failedFmt} "$TAIL" > "$PF"; fi; ` +
    `curl -fsS --retry 30 --retry-delay 2 --retry-connrefused -X POST -K "$CFG" ` +
    `-H 'content-type: application/json' --data-binary @"$PF"; rm -f "$PF" "$CFG"`;
  // The surface publish (postBuild) runs AFTER build+restart and BEFORE the settle: STATUS-gated + time-boxed
  // + non-fatal, so a slow/failed sync never starves nor falsifies the settle (whose proof is the storymap-ui
  // build+restart, not the surface copy). Empty postBuild ⇒ byte-identical to the pre-zr1cmf `buildRestart; settle`.
  return `${buildRestart};${postBuild} ${settle}`;
}

/**
 * Dispatch the board's deploy. For the storymap board this REBUILDS + RESTARTS the tool itself, detached
 * via systemd-run (never in-process). Returns once the unit is dispatched — the actual build+restart runs
 * in the background unit. Idempotent on the fixed unit name.
 */
export async function deployBoard(opts: {
  exec: ExecFn;
  repoRoot: string;
  boardPackage: string | undefined;
  /** story-harness-adk G3: the board id + card id that triggered this deploy (onEnter effect), threaded to
   *  the registry so onDone can revert THAT card on failure. Absent for a self-deploy / no card context. */
  board?: string;
  cardId?: string;
  /** story-5vv8n1 (t5): the release that fired this deploy just promoted NEW code → the deploy must do real
   *  work; a ~0s no-drift settle then means nothing shipped (deploySettledWithoutWork → revert). */
  expectWork?: boolean;
  /** story-efwo30: the file paths the release just promoted to main. When any is a composed-face path
   *  (touchesComposedFace), the board deploy ALSO publishes the merged web face — `orch-deploy` doesn't. */
  changedFiles?: string[];
  /** D-AG1 — the board's DECLARED deploy descriptor (BoardConfig.deploy), threaded by fireDeployBoard.
   *  Absent or kind "auto" ⇒ the legacy package-derived routing below, byte-identical. */
  boardDeploy?: BoardDeployConfig;
  /** D-AG3 — the card's releasedSha (main sha proven to carry its code), context for the agent prompt
   *  ("which sha to publish"). Only threaded when a descriptor is declared. */
  releasedSha?: string;
  /** DI: the product-deploy registry (defaults to the process-global singleton). Tests inject a fake. */
  productDeploy?: ProductDeployRegistry;
  /**
   * DI: os alvos deployáveis DECLARADOS (settings.yaml `deploy.targets`). Ausente ⇒ lê a declaração do
   * alvo. Injetável pela mesma razão que `exec` e `productDeploy` já são: sem isto, um caso que exercita
   * o roteamento de produto passaria a depender do settings.yaml da máquina em que a suíte roda — verde
   * no umbrella, vermelho num checkout que não declara nada, e nenhum dos dois medindo o roteamento.
   */
  deployTargets?: readonly string[];
  /** DI: the agent path's proof settle (defaults to the real settleDeploySuccess via dynamic import). */
  settle?: DeploySettleFn;
  /** DI: o diretório do pacote da FERRAMENTA que está rodando. Ausente ⇒ `findToolPackageDir()`.
   *  Injetável pela mesma razão que `exec` e `deployTargets` já são: sem isto, todo caso que exercita
   *  o self-deploy passaria a depender da árvore em que a suíte roda. */
  toolPackageDir?: string;
}): Promise<DeployResult> {
  const { exec, repoRoot, boardPackage } = opts;

  // ── Deploy agnóstico (D-AG1/D-AG2/D-AG3) — a DECLARED descriptor wins over the package-derived
  // routing (declaring it is the board owner's explicit intent, config-authored like column triggers).
  // Both declared kinds ride the SAME ProductDeployRegistry (job key = the BOARD id — a board has one
  // declared deploy, unlike the per-target legacy path) → same tracking, same G3 onDone (failure ⇒
  // revert via trigger-runner-channel), same settle→proof→advance cycle. No parallel state machine.
  const declaredKind = resolveDeployKind(opts.boardDeploy);
  if (declaredKind === "command" || declaredKind === "agent") {
    const tool = declaredKind === "command" ? ("board-command" as const) : ("deploy-agent" as const);
    if (!opts.board) {
      // The board id is the job key; a dispatch without one has no identity to track/settle against.
      return { fired: false, tool, reason: "deploy declarado no board.yaml exige o id do board (chave do job) — nada disparado" };
    }
    const registry = opts.productDeploy ?? getProductDeploy();
    if (registry.isRunning(opts.board)) {
      return { fired: false, tool, reason: `deploy de ${opts.board} já em andamento — veja deploy_status` };
    }
    const ctx = opts.cardId ? { board: opts.board, cardId: opts.cardId, expectWork: opts.expectWork } : undefined;

    if (declaredKind === "command") {
      const command = opts.boardDeploy?.command?.trim();
      if (!command) {
        // A half-declared descriptor is a CONFIG error (the zod refine also flags it at parse time).
        // Fail-closed: nothing fires, the WS-3 no-fire path holds a code card in Publicando + watchdog.
        return { fired: false, tool, reason: "deploy.kind=command sem `command` no board.yaml — descritor inválido, nada disparado" };
      }
      // story-dlsxfj — o SEGUNDO caminho privilegiado declarado em board-data. Ele é executado do outro
      // lado do registry por um login shell, então esta é a fronteira onde a régua tem de valer — e a régua
      // é sobre O QUE PODE SER EXECUTADO, não sobre quais caracteres aparecem: `bash -c '<payload>'` não
      // tem metacaractere solto e por isso atravessava a régua anterior inteirinha. Fail-closed pelo caminho
      // de "descritor inválido" que já existe (nada dispara; o card segura em Publicando com o watchdog).
      // Nenhuma capacidade é perdida: `just deploy-x` e `vercel deploy --prod` (o exemplo do `_base`) são
      // alvos autorizados; uma receita de N passos se declara como receita VERSIONADA do repo (`just <alvo>`)
      // ou como `kind: agent`; outro CLI de publicação entra pelo env do operador (AGILEHARNESS_DEPLOY_LAUNCHERS).
      const verdict = authorizeDeployCommand(command);
      if (!verdict.argv) {
        return {
          fired: false,
          tool,
          reason: `deploy.kind=command recusado — ${verdict.refusal}`,
        };
      }
      // E o que segue ao registry é a argv AUTORIZADA RE-CITADA, nunca a string crua. Aqui os dois lados da
      // fronteira divergiam: para o parser `"…"` é agrupamento LITERAL, mas o `bash -lc` que executa do outro
      // lado EXPANDE `$VAR` e EXECUTA `$(…)` dentro de aspas duplas. Com a string crua, um alvo autorizado
      // bastava para rodar payload como root (`vercel deploy --msg "$(curl … | sh)"`) e para vazar segredo do
      // serviço para dentro de um argumento (`"$STORYMAP_MCP_TOKEN"`). Citando palavra por palavra, o shell
      // recebe exatamente a argv que foi autorizada — o comando declarado roda igual, sem expansão nenhuma.
      const authorizedCommand = quoteArgv(verdict.argv);
      const job = registry.start(opts.board, ctx, { kind: "shell", command: authorizedCommand });
      return {
        fired: true,
        tool,
        // The card's live-target is the board's own declared deploy. Proof is the SAME evidence contract
        // as every target: the settle measures scripts/deploy/state/<board>.json (which the declared
        // command MAY write — opt-in proof); absent, the card holds in Publicando for the human/watchdog.
        targets: [opts.board],
        reason: `deploy declarado do board: ${command.slice(0, 120)} (pid ${job.pid ?? "?"}, log ${job.logFile})`,
      };
    }

    // declaredKind === "agent"
    const description = opts.boardDeploy?.description?.trim();
    if (!description) {
      return { fired: false, tool, reason: "deploy.kind=agent sem `description` no board.yaml — descritor inválido, nada disparado" };
    }
    if (ctx) {
      // D-AG4 — THE PROOF SEAM, subscribed BEFORE start() (the face-chain precedent above) so the settle
      // is never missed; one-shot. On ok+liveSha the agent's CLAIM becomes the measured `deployedShaFor`
      // of the SAME settle handler every other channel uses — the single ancestry ruler then verifies
      // releasedSha ∈ liveSha (real git) before deployProof is stamped and the card advances gated.
      // THE ASYMMETRY, on purpose: ok WITHOUT a liveSha fires NOTHING here — deploy ok, proof absent ⇒
      // the card STAYS in Publicando with the watchdog armed (deploy-unsettled escalates the human).
      // A failed settle is not ours either: the channel's G3 onDone revert handles it like any deploy.
      const settle = opts.settle ?? defaultSettle;
      const unsub = registry.onDone((ev) => {
        if (ev.pkg !== ctx.board || ev.board !== ctx.board || ev.cardId !== ctx.cardId) return;
        unsub();
        const liveSha = ev.liveSha;
        if (!ev.ok || !liveSha) return;
        void settle(ctx.board, ctx.cardId, { source: "registry-ondone", deps: { deployedShaFor: async () => liveSha } }).catch(
          (err) => console.error(`[deploy-agent ${ctx.board}/${ctx.cardId}] settle com prova falhou:`, err instanceof Error ? err.message : err),
        );
      });
    }
    const job = registry.start(opts.board, ctx, {
      kind: "agent",
      board: opts.board,
      cardId: opts.cardId,
      description,
      releasedSha: opts.releasedSha,
      changedFiles: opts.changedFiles,
      healthUrl: opts.boardDeploy?.healthUrl,
      timeoutMinutes: opts.boardDeploy?.timeoutMinutes,
    });
    return {
      fired: true,
      tool,
      targets: [opts.board],
      reason: `agente de deploy do board despachado (pid ${job.pid ?? "?"}, log ${job.logFile})`,
    };
  }

  if (boardPackage === STORYMAP_PACKAGE) {
    // ── A RÉGUA DO SELF-DEPLOY: "este board É a ferramenta que está rodando" ────────────────────────
    // Antes ela era "o caminho do pacote tem este nome", e as duas leituras coincidiam enquanto a
    // ferramenta morava DENTRO do repositório que ela opera. Elas divergem no instante em que o serviço
    // passa a rodar de um checkout próprio: o board do ALVO continua declarando `packages/storymap-ui`,
    // e esse caminho resolve para a CÓPIA MORTA do alvo — não para o código no ar.
    //
    // O que acontecia então, medido: build da árvore errada, `systemctl restart` da produção à toa, e um
    // `deployProof` tirado do HEAD do repositório errado carimbando "No Ar". Disparado pela fila de
    // publicação em modo `auto`, sem humano nenhum.
    //
    // Por isso a recusa é FAIL-CLOSED e vem ANTES de qualquer efeito: um self-deploy que não consegue
    // provar que a árvore declarada é a que está no ar não é um deploy — é um restart cego.
    const pacoteDaFerramenta = opts.toolPackageDir ?? findToolPackageDir();
    const declarado = path.resolve(repoRoot, boardPackage);
    if (path.resolve(pacoteDaFerramenta) !== declarado) {
      return {
        fired: false,
        reason:
          `self-deploy RECUSADO: o board declara \`${boardPackage}\`, que neste alvo resolve para ` +
          `${declarado} — mas a ferramenta no ar roda de ${path.resolve(pacoteDaFerramenta)}. ` +
          `Reconstruir a árvore declarada jogaria o build fora e reiniciaria o serviço à toa, com a prova ` +
          `tirada do repositório errado. Se a intenção é publicar a ferramenta, o board dela tem de viver ` +
          `no repositório dela (ou declarar AGILEHARNESS_TOOL_ROOT).`,
      };
    }
    // Build+restart (+ settle webhook when a card triggered it) the transient unit runs. Bun is not on
    // systemd's PATH → the builder uses an absolute path. Extracted to a PURE builder (unit-testable).
    const armed = !!(opts.board && opts.cardId);
    // story-zr1cmf — the board's declared post-build PUBLISH steps (deploy.surfaces[].deployCmd): run INSIDE
    // the detached self-deploy script after build+restart, so a surface (e.g. the Caddy-served web terminal)
    // is published without a manual `just sync-web-terminal`. This is the ONLY path that consumes deployCmd —
    // a surface declared on a non-self-deploy board is caught by the board-integrity lint, never silently dropped.
    const postBuildCommands = (opts.boardDeploy?.surfaces ?? [])
      .map((s) => s.deployCmd?.trim())
      .filter((c): c is string => !!c);
    // story-dlsxfj (3ª passada) — A RECUSA TEM DE SER VISÍVEL. A régua roda de novo aqui (ela é PURA, custa
    // nada) só para dizer o que foi recusado ANTES do disparo: o script segue recebendo TODOS os comandos —
    // é ele que grava o `[postBuild] RECUSADO (<motivo>)` no log do unit, o rastro de auditoria — mas esse
    // log só chega ao operador quando o deploy FALHA (o `logTail` do settle). Num deploy bem-sucedido a
    // recusa era invisível: o passo de publicação declarado virava um no-op silencioso com o deploy
    // reportando sucesso, exatamente o que um ADOTANTE veria (a allow-list default é a deste repo). Então a
    // recusa também GRITA no log do serviço e volta no resultado. Continua NÃO-FATAL: o deploy roda igual.
    const refusedPublishSteps = postBuildCommands
      .map((command) => ({ command, refusal: authorizeDeployCommand(command).refusal }))
      .filter((r): r is { command: string; refusal: string } => r.refusal !== null);
    if (refusedPublishSteps.length > 0) {
      console.warn(
        `[deploy ${opts.board ?? "sem-card"}] PASSO DE PUBLICAÇÃO RECUSADO (não-fatal, o build+restart segue) — ` +
          refusedPublishSteps.map((r) => `deployCmd "${r.command}": ${r.refusal}`).join(" | "),
      );
    }
    // story-frente3 — RESOLVER O `bun` ANTES DE DISPARAR. O script para o serviço (`systemctl stop`)
    // ANTES de o build sequer começar; um executável que não existe transforma isso numa parada seguida
    // de "command not found" — o serviço volta pelo rollback, mas o operador só descobre pelo log. Aqui a
    // recusa acontece com o serviço INTACTO e diz o que declarar. NÃO é `inFlight`: não há deploy em
    // curso a esperar, então o chamador não deve parquear o card para um settle que nunca virá.
    const bun = resolveHostTool("bun");
    if (!bun.ok) {
      return { fired: false, tool: "systemd-restart", reason: `self-deploy não disparado: ${bun.refusal}` };
    }
    const script = buildSelfDeployScript({
      repoRoot,
      toolPackageDir: pacoteDaFerramenta,
      board: opts.board,
      cardId: opts.cardId,
      webhookBase: process.env.STORYMAP_SELF_URL || DEFAULT_SELF_URL,
      tokenEnvName: WEBHOOK_TOKEN_ENV,
      logPath: `${repoRoot}/storymap/.runner/self-deploy.log`,
      postBuildCommands,
      bunPath: bun.path,
    });
    // Import the webhook token from THIS service's env into the transient unit via `--setenv=NAME` (no value
    // → systemd copies it from the invoking env) so the secret never appears in the command line/ps/logs.
    // Only when a card armed the settle curl (a manual deploy has no curl → no token needed).
    const setenv = armed ? ` --setenv=${WEBHOOK_TOKEN_ENV}` : "";
    // reset-failed clears a prior one-shot unit's exit state so the name is reusable; --collect GC's it after.
    // The bash -c argument is POSIX single-quoted (NOT JSON) so the outer shell never expands the script's
    // own `$PF`/`$STATUS`/`$STORYMAP_MCP_TOKEN`/`$(...)` — those are the INNER bash's to resolve.
    const cmd = `systemctl reset-failed ${DEPLOY_UNIT} 2>/dev/null; systemd-run --collect --unit ${DEPLOY_UNIT}${setenv} bash -c ${shSingleQuote(script)}`;
    try {
      await exec(cmd, { cwd: pacoteDaFerramenta, timeout: SYSTEMD_RUN_TIMEOUT_MS });
      const result: DeployResult = { fired: true, tool: "systemd-restart" };
      if (armed) result.settleArmed = true;
      // Só quando houve recusa: um deploy sem passo recusado devolve o MESMO objeto de sempre (o campo
      // ausente é o que mantém o resultado legado byte-idêntico para quem o compara inteiro).
      if (refusedPublishSteps.length > 0) {
        result.refusedPublishSteps = refusedPublishSteps;
        result.reason = `publicação de superfície recusada: ${refusedPublishSteps.map((r) => r.command).join(", ")}`;
      }
      return result;
    } catch (e: unknown) {
      // A failure to START the unit (a deploy already running = the fixed unit is busy) is non-fatal/idempotent.
      // 1.5: flag `inFlight` so the caller parks the card for re-dispatch at the in-flight deploy's settle
      // (else the optimistically-terminal card would strand in "No ar" with no settle-future nor watchdog).
      const msg = String((e as { message?: unknown })?.message ?? e).slice(0, 200);
      return { fired: false, tool: "systemd-restart", inFlight: true, reason: `systemd-run não iniciou (deploy em curso?): ${msg}` };
    }
  }

  // Product board → `just orch-deploy <target>` via the shared registry (same path as the MCP `deploy`
  // tool, observable via deploy_status). Agnostic: `<target>` is derived from `package` and validated
  // against the targets THIS deployment declares (settings.yaml `deploy.targets`), never a name in this
  // source. Um alvo que não declara nenhum cai no ramo "nada a deployar" logo abaixo.
  const pkg = deployPkgForPackage(boardPackage, opts.deployTargets ?? productDeployTargets());
  if (pkg) {
    const registry = opts.productDeploy ?? getProductDeploy();
    if (registry.isRunning(pkg)) {
      return { fired: false, tool: "orch-deploy", pkg, reason: `deploy de ${pkg} já em andamento — veja deploy_status` };
    }
    // story-efwo30 — `orch-deploy <target>` ships the backend but NOT the merged web face (no hosting unit
    // in any manifest, by design — ADR-061). When the release promoted a diff that touched a face path (its
    // own web/, or the shared SDK), ALSO publish the face via the deployment's DECLARED face recipe. Chain
    // it off the backend deploy SETTLING OK — the SAME G3 onDone hook the revert path uses — so the new
    // face never goes up against a half-deployed backend (the merge-build's backend-before-face order) and
    // a FAILED backend suppresses it. Subscribed BEFORE start() so the settle is never missed; one-shot.
    // The face job THREADS {board, cardId}, so its OWN failure is not silent: the existing G3 onDone revert
    // subscriber (trigger-runner-channel) reopens the card (mode:fix) when the face publish fails — keeping
    // "No ar" TRUTHFUL, symmetric with a backend-deploy failure. A face SUCCESS is a no-op there (ok, no
    // expectWork → not a no-work settle), leaving the optimistically-terminal card as shipped.
    //
    // `alvoDaFace` é resolvido UMA VEZ, aqui, e não dentro do callback: o callback roda no settle, minutos
    // depois, e o settings pode ter sido editado nesse meio-tempo (a leitura é memoizada por mtime, então
    // isso não é hipotético). O alvo que entra em `targets:` — a evidência que a reconciliação vai cobrar —
    // tem de ser o MESMO que o callback publica, ou a prova cobraria um alvo que ninguém publicou.
    const alvoDaFace = composedFaceTarget();
    const chainComposedFace = !!alvoDaFace && touchesComposedFace(opts.changedFiles ?? []) && !!(opts.board && opts.cardId);
    if (chainComposedFace) {
      const unsub = registry.onDone((ev) => {
        if (ev.pkg !== pkg || ev.board !== opts.board || ev.cardId !== opts.cardId) return;
        unsub();
        // idempotent: if a face deploy is already in flight (another board just fired it) skip — the merged
        // build is global, so one run publishes every board's staged web change.
        if (ev.ok && !registry.isRunning(alvoDaFace!)) {
          registry.start(alvoDaFace!, { board: opts.board!, cardId: opts.cardId! });
        }
      });
    }
    const job = registry.start(pkg, opts.board && opts.cardId ? { board: opts.board, cardId: opts.cardId, expectWork: opts.expectWork } : undefined);
    return {
      fired: true,
      tool: "orch-deploy",
      pkg,
      chainedComposedFace: chainComposedFace,
      // Os alvos que ESTE deploy publica — a evidência que a reconciliação lê depois (deploy-reconcile.ts).
      targets: [pkg, ...(chainComposedFace ? [alvoDaFace!] : [])],
      reason: `just orch-deploy ${pkg} (pid ${job.pid ?? "?"}, log ${job.logFile})`,
    };
  }
  if (boardPackage) {
    return {
      fired: false,
      tool: "orch-deploy",
      // A mensagem tem de apontar para onde o operador CONSERTA. Ela citava o nome de uma constante de
      // código que não existe mais — e, num produto usado por outros repositórios, citar um símbolo
      // interno manda o leitor procurar no lugar errado.
      reason:
        `pacote "${boardPackage}" não está entre os alvos deployáveis declarados por este alvo ` +
        `(settings.yaml → deploy.targets), e o board não declara \`deploy:\` — nada a deployar`,
    };
  }
  return { fired: false, reason: "board sem `package` configurado — nada a deployar" };
}
