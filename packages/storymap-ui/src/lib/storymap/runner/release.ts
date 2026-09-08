// Fase 4b — RELEASE: promote staged CODE from the `stage` branch to `main` (the human "publish" step).
//
// The split merge train (Fase 4a) routes a run's code onto `stage` and its board data onto `main`. A
// release is the human decision to make that staged code LIVE on the released branch (`main`). It is
// PATH-SCOPED to the code prefixes (`packages/**`): it brings ONLY the staged code, never board data —
// `stage` may carry a STALE snapshot of card .md files (it branched from main at first-stage time), so a
// whole-branch merge could conflict on data that already advanced on main. Promoting just `packages/**`
// sidesteps that entirely (disjoint from the data main owns).
//
// Pure over the injected `exec` (like the merge queue), so it is unit-testable against real or fake git.
// SERVER-ONLY (node:child_process / node:fs in the caller). The thin server action in app/actions.ts
// wraps this + stamps `releasedAt` on the released cards.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { execErrorDetail, makeGit, quote as q } from "./git";
import { secretScanCommand, type ExecFn } from "./worktree";
// O prefixo que É o dado de board — a ÚNICA classe que a régua de {@link classifyDeltaPath} libera. Vem
// de config.ts (fonte única do pathspec que o engine também commita), nunca re-digitado aqui: um literal
// duplicado é o começo de duas verdades sobre "o que é dado".
import { BOARD_DATA_PATHSPEC } from "./config";

const GIT_TIMEOUT_MS = 60_000;

// Monotonic per-process suffix so the release patch file is UNIQUE per invocation. runnerStateDir() is
// SHARED (one dir per checkout), and two promoteStageToMain calls can run concurrently — two boards
// releasing at once in prod, or (the case that actually bit) the parallel real-git test suites
// (release.test.ts + harness-flow.test.ts) both driving stageBranch "stage" in separate vitest workers.
// A fixed `release-<stage>.patch` name let one call's `git diff > patch` clobber another's between its
// own diff and apply → the wrong patch applied → sporadic apply-failed. The split path already learned
// this (split-<runId>-*.patch, merge-queue.ts); release must too. pid disambiguates parallel processes,
// the counter disambiguates concurrent calls within one process.
let releaseSeq = 0;

/**
 * story-5vv8n1 — a DISCRIMINATOR over every `promoted:false` return, because they mean opposite things and
 * the caller (fireReleaseStaged) MUST tell a legit no-op apart from a real FAILURE before it lets the card
 * claim "No Ar". `promoted:false` alone is ambiguous:
 *   - `already-promoted` / `nothing-staged` → LEGIT no-op (code is already live, or the card carries no code)
 *   - `out-of-scope` / `apply-failed` / `no-prefix` → real FAILURE (code was staged but NOT promoted to main)
 * `out-of-scope` is the acme incident: `stage` carried real code, but under a package OUTSIDE the board's
 * scoped prefix, so the scoped diff was empty — a silent no-op that used to sail through to a false "No Ar".
 */
export type PromoteOutcome =
  | "promoted" // a staged code delta landed on the released branch (new code is live)
  | "already-promoted" // idempotent: the delta was already on main → clean no-op, code IS live
  | "nothing-staged" // `stage` added nothing under ANY code prefix → nothing to promote (e.g. a data-only card)
  | "out-of-scope" // `stage` added code OUTSIDE the board's scoped prefix → NOT promoted (silent-no-op FAILURE)
  // A FRONTEIRA MENTIU: `frontier..stage` deu vazio, mas `branch` comprovadamente NÃO tem código que o
  // `stage` tem sob o escopo do board. Irmão do `out-of-scope` — os dois são "nada staged" que na verdade
  // esconde código não promovido; muda só a causa (prefixo errado × fronteira à frente da realidade).
  // A fronteira NÃO é avançada, então o estado é recuperável em vez de permanente.
  | "frontier-stale"
  | "apply-failed" // the staged delta did not apply cleanly (overlap / stale stage) → NOT promoted (FAILURE)
  // trabalho VIVO (sessão aberta / entrada na fila) toca os mesmos arquivos → NÃO promovido. NÃO é falha:
  // nada quebrou e nada se perdeu, o código segue staged e publicável assim que o outro trabalho integrar.
  // Distinto de `apply-failed` de propósito: ali houve uma tentativa que não aplicou; aqui a promoção foi
  // deliberadamente ADIADA, e o chamador não deve tratar como erro nem reverter o card.
  | "concurrent-work"
  | "blocked" // a secret in the release commit blocked the push (commit undone) → NOT promoted (FAILURE)
  | "no-prefix"; // no code prefix configured → nothing could be promoted (misconfig FAILURE)

export interface PromoteResult {
  /** a staged code delta was applied + committed onto the released branch */
  promoted: boolean;
  /** story-5vv8n1 — WHICH kind of result this is; the caller gates deploy/terminal off this, not off `promoted`. */
  outcome: PromoteOutcome;
  /** the released branch the code landed on (usually `main`) */
  branch: string;
  /** the release commit sha (when promoted) */
  commit?: string;
  /** best-effort push to origin succeeded (non-fatal — cumulative, next push catches up) */
  pushed: boolean;
  /** when NOT promoted, or blocked: the human-facing reason */
  reason?: string;
  /** SM-08: a secret in the release commit blocked it (the commit was undone, branch left pristine) */
  blocked?: boolean;
  /** story-efwo30 — the code files this promotion carried stage→main (the scoped `changed` set). Threaded to
   *  the deploy so a diff that touched the mosaico.app merged face ALSO fires `just deploy-mosaico-site`. Present
   *  on a real `promoted`; empty/absent on no-op/failure outcomes (nothing was promoted). */
  changedFiles?: string[];
  /**
   * The sha of `branch` (main) that now PROVABLY CONTAINS the promoted code — the durable evidence a card is
   * stamped with (`Card.releasedSha`) so a `deploy-failure` can later be reconciled against reality: any deploy
   * run at a DESCENDANT of this sha necessarily carried the code (deploy-reconcile.ts).
   *
   * Present on every LIVE outcome (`promoted` → the release commit; `already-promoted` / `nothing-staged` → the
   * current head, which already contains it), absent on failures (nothing is live, so there is nothing to
   * prove). Reported HERE, by the module that owns git, rather than re-derived by the caller: `entry-effects`
   * must not run ad-hoc git (its exec is not injected, so a caller-side `git rev-parse` is untestable).
   */
  mainSha?: string;
  /**
   * Quem está segurando esta publicação, ESTRUTURADO. Presente só em `concurrent-work`.
   *
   * Mesmo princípio (e mesma dívida quitada) do `divergentFiles` abaixo: a prosa do `reason` já nomeia
   * dono e arquivos, e antes disso a única forma de a UI ligar "o pedido está segurado" à LINHA da sessão
   * que o segura era procurar o uuid dentro da frase. Casar por substring numa mensagem é a classe de
   * acoplamento que apodrece no primeiro dia em que alguém reescreve o texto — e apodrece calada. Os nomes
   * viajam no resultado agora, vindos de quem fez a interseção.
   */
  clashes?: Array<{ owner: string; files: string[] }>;
  /**
   * WS-10.4 — the files `stageBranch` and `branch` each carry a DIFFERENT text for (the `toPromote` set the
   * `apply-failed` reason already names in prose). Present ONLY on `apply-failed`; this is the divergence the
   * SEMANTIC LADDER climbs before the failure is reported to the operator (entry-effects.fireReleaseStaged).
   *
   * ADDITIVE by design: story-sf4vyb's delta mechanics above are NOT touched — `toPromote` is computed
   * exactly as it was (the real delta against main, `033ee72e6`), and this field only PUBLISHES what that
   * computation already knew and then threw away. The caller previously had to re-parse the prose reason to
   * learn the file set, which is precisely the second-ruler bug class: the names ride the result now, from
   * the module that owns git.
   */
  divergentFiles?: string[];
  /**
   * A BASE de onde o patch reprovado foi gerado (a fronteira `refs/promoted/<board>` ou o merge-base
   * fallback). Presente SÓ em `apply-failed`, para a escada semântica materializar o MESMO 3-way que
   * falhou aqui. Sem ela o chamador usava `base = ours = main` — e um diff a partir de X aplica em X por
   * tautologia, então o juiz respondia "o delta aplicou LIMPO na base atual" para TODO conflito de release
   * e nunca julgava nada (o fail-closed fantasma do story-tlz0dt, 2026-07-21).
   */
  divergentBase?: string;
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-m3iouv — UMA definição de "o que não pode passar", para o gate E para a fronteira
//
// O defeito era uma CONTRADIÇÃO entre duas metades do mesmo mecanismo, as duas no ar: o gate do train
// (`verificationDemand`, merge-queue.ts) classificava `scripts/git-hooks/**`, `.github/**`, `justfile`,
// `.claude/hooks/**` e `storymap/settings.yaml` como CONTROLE — os arquivos que SÃO o mecanismo de
// segurança, e que por isso pedem MAIS escrutínio —, enquanto a fronteira de proveniência
// (`classifyIncoming`, aqui) chamava exatamente esses mesmos arquivos de DADO, a classe que o reconcile
// SEMPRE absorve. Ou seja: um commit externo que reescrevesse `scan-secrets.mjs` era recusado pelo gate
// e aceito pela fronteira. Com duas réguas de "o que é perigoso" a mais permissiva ganha sempre, porque
// basta ao atacante escolher o caminho que ela cobre.
//
// A régua CERTA é a DENY-LIST, e é esta: só `storymap/boards/**` é dado PROVADO; todo o resto tem de ser
// examinado. A allow-list de prefixo ("é perigoso se está sob `packages/`") é uma INFERÊNCIA sobre o
// caminho, e foi a inferência que abriu o buraco — `c5c2f0013` apagou os 5 workflows de CI e foi para
// `origin/main` sem passar por nada. Ali a deleção era intencional, mas o mecanismo não sabia disso e não
// saberia na próxima vez.
//
// POR QUE ela mora NESTE arquivo: a fronteira (abaixo) é a consumidora crítica — é ela que decide o que
// entra na árvore que o self-deploy builda e reinicia como root — e release.ts já é o módulo dono da
// promoção para o branch que o deploy observa (é o que o cabeçalho de merge-queue.ts registra). O train
// importa daqui; o contrário fecharia um ciclo. UMA definição, UM lugar, dois consumidores.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * As CLASSES de um caminho repo-relativo do delta. As classes são NOMEADAS de propósito — um prefixo é
 * uma inferência, e é o veredito que interessa a quem chama:
 *  - `board-data` (`storymap/boards/**`) — o ÚNICO auto-skip, e é o que impede a inversão de virar
 *    atrito: são ~93% dos runs (avanço de card, stamps de QA/review, perguntas de grill), PATH-DISJUNTOS
 *    do código, live por mtime, e um `.md` não pode deixar a suíte vermelha. Classificar board-data como
 *    código já congelou o train inteiro uma vez (stale-base freeze) — nunca mais.
 *  - `control` — os arquivos que SÃO o controle: ver {@link CONTROL_PATH_PREFIXES}.
 *  - `code` — sob os `codePrefixes` declarados: exatamente o que já era gateado.
 *  - `unclassified` — todo o resto (`scripts/**`, `docs/**`, configs de raiz). "Não sei o que isto é"
 *    nunca pode significar "funde às cegas".
 * PURA.
 */
export type DeltaClass = "board-data" | "control" | "code" | "unclassified";

/**
 * Os caminhos que SÃO o mecanismo de controle deste repositório — mexer neles pede MAIS escrutínio, não
 * menos, porque a mudança pode ser a própria desativação do gate que a examinaria depois:
 *  - `scripts/git-hooks/` — o scan de segredo (que o train re-roda a cada commit) e o anti-defasagem;
 *  - `.github/` — o CI;
 *  - `.claude/hooks/` — os hooks que recusam escrita em board-data de runtime e artefato na raiz;
 *  - `justfile` — os comandos canônicos que o gate e o deploy invocam pelo nome;
 *  - `.claude/settings*.json` — o allowlist de permissão dos agentes;
 *  - `storymap/settings.yaml` — o arquivo que DECLARA se o gate roda (`mergeGate.enabled`), o que conta
 *    como código (`staging.codePrefixes`) e a fila de publicação. É o caso extremo do defeito: um delta
 *    que desliga o gate NÃO pode ser um delta que o gate não examina. Mora fora de `storymap/boards/**`
 *    de propósito — não é board-data, é configuração do harness.
 * Prefixos casam por PASTA (com a barra), arquivos por igualdade — `justfile-notes` não é o `justfile`.
 */
const CONTROL_PATH_PREFIXES: readonly string[] = ["scripts/git-hooks/", ".github/", ".claude/hooks/"];
const CONTROL_PATH_FILES: readonly string[] = [
  "justfile",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "storymap/settings.yaml",
];

/** {@link DeltaClass} de UM caminho repo-relativo. PURA. */
export function classifyDeltaPath(p: string, codePrefixes: readonly string[]): DeltaClass {
  if (p.startsWith(BOARD_DATA_PATHSPEC)) return "board-data";
  if (CONTROL_PATH_PREFIXES.some((c) => p.startsWith(c)) || CONTROL_PATH_FILES.includes(p)) return "control";
  if (codePrefixes.some((c) => c.length > 0 && p.startsWith(c))) return "code";
  return "unclassified";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// story-281gg4 — FRONTEIRA DE CONTRIBUIÇÃO (e NÃO aprovação humana)
//
// O eixo não é "deploy automático vs. manual" — a publicação autônoma É o produto e fica intacta. O eixo
// é QUEM consegue pôr código no branch que o deploy observa. E havia um caminho por onde código de FORA
// entra nesse branch sem ninguém decidir nada: o RECONCILE do push. Quando um `git push` é recusado
// porque `origin/<branch>` andou, o train e o release fazem `fetch origin <branch>` + `merge FETCH_HEAD`
// para o push seguinte ser fast-forward. Esse merge ABSORVE, na árvore que o self-deploy builda e
// reinicia como root, tudo o que estiver em origin — e num repositório público `origin/main` é
// exatamente onde um PR de terceiro aterrissa.
//
// SÃO TRÊS RECONCILES, e a primeira passada cobriu dois. O terceiro é o do MERGE-BACK: depois de cada
// integração o train empurra `main` (`pushToOrigin`, merge-queue.ts) e, na recusa, reconcilia igual. Ele
// é o que roda MAIS vezes (uma por merge, não uma por publicação) e o que reconcilia DIRETAMENTE o branch
// que o self-deploy builda — `stage` ainda tem o promote entre ele e a produção; `main` não tem nada. A
// fronteira tinha sido construída deixando de fora exatamente o caminho que termina em root.
//
// O que o controle IMPEDE: que um commit de PROVENIÊNCIA EXTERNA que não seja board-data PROVADO — código,
// ou o próprio mecanismo de controle, ou um caminho que ninguém conseguiu classificar — seja absorvido por
// um reconcile, mecanismo cuja única razão de existir é reconciliar DADO de outro checkout do dono (board
// data é path-disjunto do código, é por isso que o merge do reconcile resolve limpo). O que vem de fora
// tem de entrar por decisão explícita (um merge/PR revisado), nunca de carona num retry de push.
//
// Custo de autonomia: ZERO, e por construção. O trabalho do dono e da frota NUNCA chega por aqui: ele
// entra pelo merge train (worktree → gate → split) e sai por `promoteStageToMain`. Recusar o reconcile só
// devolve `pushed:false`, que todo chamador já trata como não-fatal e cumulativo (o push seguinte
// recupera) — nada é perdido, nada pára, nenhum humano é inserido no caminho.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Quem pode escrever em `origin` — DECLARADO, nunca inferido. Ver {@link declaredOriginTrust}. */
export type OriginTrust =
  /** todo escritor de origin é o dono/a frota (repo privado): o reconcile absorve, mas deixa RASTRO. */
  | "owner"
  /** origin aceita contribuição de fora (repo publicado): o reconcile nunca absorve CÓDIGO externo. */
  | "public";

/** A env var que DECLARA a fronteira. Nasce ausente ⇒ `owner` ⇒ comportamento byte-idêntico ao de hoje. */
export const ORIGIN_TRUST_ENV = "AGILEHARNESS_ORIGIN_TRUST";

/**
 * A fronteira declarada. Ausente/desconhecida ⇒ `owner` — o default é o comportamento de HOJE, porque
 * hoje a topologia É essa (só o dono e os agentes autorizados alcançam origin) e o card registra que
 * nessa topologia o self-deploy autônomo é seguro E é a feature. Publicar o repositório é o evento que
 * muda a topologia, e é aí que o dono declara `public` — uma DECLARAÇÃO, não uma restrição imposta.
 * PURA sobre o env injetado.
 */
export function declaredOriginTrust(env: Record<string, string | undefined> = process.env): OriginTrust {
  return env[ORIGIN_TRUST_ENV]?.trim().toLowerCase() === "public" ? "public" : "owner";
}

/** A PROVENIÊNCIA do que `origin` tem e este checkout não tem. */
export type IncomingProvenance =
  /** origin não trouxe nada além do que já temos */
  | "nothing"
  /** SÓ `storymap/boards/**` — o dado PROVADO, e o único caso para o qual o reconcile foi feito */
  | "outside-data"
  /**
   * toca o próprio MECANISMO DE CONTROLE (`scripts/git-hooks/**`, `.github/**`, `justfile`,
   * `.claude/hooks/**`, `storymap/settings.yaml`). É a classe que a régua antiga chamava de DADO e
   * absorvia sempre — logo, o caminho por onde um commit de fora reescrevia o scanner de segredo ou
   * desligava o gate na árvore que o deploy publica. Nomeada à parte de `outside-code` para o rastro do
   * operador dizer a verdade: o que entrou não é código de feature, é o gate.
   */
  | "outside-control"
  /**
   * CÓDIGO de fora deste checkout — ou qualquer caminho que NÃO conseguimos provar que é dado
   * (`docs/**`, `scripts/**`, configs de raiz). Contribuição, não reconciliação.
   */
  | "outside-code"
  /**
   * o `git diff` da proveniência FALHOU: não sabemos o que `origin` traz. Vale o mesmo que
   * `outside-code`, e é o degrau que impede o modo de falha mais barato do controle — ver
   * {@link classifyIncoming}.
   */
  | "unknown";

/**
 * Classifica o delta que `origin` traz. `incomingFiles` são os arquivos que FETCH_HEAD mudou desde o
 * ancestral comum (`git diff --name-only HEAD...FETCH_HEAD`, que é diff(merge-base, FETCH_HEAD)) — ou
 * seja, exatamente o que é de fora, sem o nosso lado. `codeRoots` são as raízes GLOBAIS de código
 * (`packages/`), não o escopo de um board: código é código venha de onde vier.
 *
 * Julga pela MESMA régua do gate do train — {@link classifyDeltaPath}, a deny-list acima —, e é essa
 * unificação que fecha o buraco: só `board-data` é dado, então `docs/**`, `scripts/**` e as configs de
 * raiz deixam de ser "dado" por não estarem sob `packages/`, e um caminho de CONTROLE (o cenário grave:
 * `scan-secrets.mjs`, o `justfile`, `storymap/settings.yaml`) é NOMEADO em vez de absorvido calado. Por
 * isso `codeRoots` não decide mais NADA aqui — ele só distingue `code` de `unclassified`, e as duas
 * classes exigem a mesma decisão. Efeito colateral bem-vindo: o train passava seu `staging.codePrefixes`
 * (que pode ser o escopo de UM board) como se fossem as raízes globais, e sob aquela régua o código de
 * outro pacote entrava como "dado de fora".
 *
 * FAIL-CLOSED quando o diff é ILEGÍVEL (`readable: false`) — a mesma régua que `verificationDemand`
 * (merge-queue.ts) aplica ao gate, e pela mesma razão. Sem este degrau a incerteza LIBERAVA: um diff que
 * falha devolve stdout vazio, vazio virava `nothing`, e `nothing` é a classe que a fronteira sempre
 * absorve — logo o único caso em que não se sabe o que está entrando era exatamente o caso que entrava
 * na árvore que o self-deploy builda e reinicia como root. E provocar a falha não exige o repositório:
 * um `FETCH_HEAD` parcial, um objeto ausente depois de um fetch interrompido ou o lock do índice tomado
 * por outro escritor da MESMA árvore (o train roda nela) já servem. PURA.
 */
export function classifyIncoming(
  incomingFiles: readonly string[],
  codeRoots: readonly string[],
  opts: { readable?: boolean } = {},
): IncomingProvenance {
  if (opts.readable === false) return "unknown";
  if (incomingFiles.length === 0) return "nothing";
  const classes = incomingFiles.map((p) => classifyDeltaPath(p, codeRoots));
  // CONTROLE primeiro: um delta misto (um card + o `justfile`) é o pior caso, não o mais brando.
  if (classes.includes("control")) return "outside-control";
  return classes.every((c) => c === "board-data") ? "outside-data" : "outside-code";
}

/**
 * Pode o reconcile ABSORVER este delta? `nothing`/`outside-data` sempre (é o propósito do mecanismo).
 * `outside-code`, `outside-control` e `unknown` só sob a fronteira `owner` — e mesmo ali o chamador GRITA
 * os arquivos, porque um commit de fora entrando na árvore que o deploy publica não pode ser invisível. A
 * régua está escrita como ALLOW-LIST das classes que passam: uma classe NOVA de proveniência (como
 * `outside-control`, que esta passada acrescentou) nasce recusada sob `public` em vez de nascer absorvida
 * por não estar na lista de exceções. PURA.
 */
export function mayAbsorbIncoming(provenance: IncomingProvenance, trust: OriginTrust): boolean {
  return trust === "owner" || provenance === "nothing" || provenance === "outside-data";
}

/** O veredito de {@link judgeIncoming} sobre um reconcile. */
export interface IncomingVerdict {
  provenance: IncomingProvenance;
  /** a fronteira que estava DECLARADA no momento da decisão (para o rastro) */
  trust: OriginTrust;
  /** o reconcile pode fundir `FETCH_HEAD` */
  absorb: boolean;
  /** o que GRITAR no log do operador; `""` quando não há nada a gritar (nada de fora, ou só board-data).
   *  Prosa para humano — nunca casar por substring. */
  detail: string;
}

/**
 * A decisão COMPLETA de um reconcile — classificar, julgar contra a fronteira e redigir o rastro — num
 * lugar só, porque são TRÊS os reconciles que a consomem (`stage` e `main` no train, `main` no release) e
 * o padrão que produziu o defeito original foi justamente copiar a régua de um lugar para o outro: a
 * terceira cópia é a que esquece um degrau, e o degrau esquecido some calado.
 *
 * O chamador fica com duas linhas — gritar `detail` quando houver, e desistir do merge quando `absorb` é
 * falso. NÃO decide nada por si: `trust` vem de {@link declaredOriginTrust} (injetável no teste). PURA.
 */
export function judgeIncoming(
  incomingFiles: readonly string[],
  codeRoots: readonly string[],
  opts: { readable?: boolean; trust?: OriginTrust } = {},
): IncomingVerdict {
  const provenance = classifyIncoming(incomingFiles, codeRoots, { readable: opts.readable });
  const trust = opts.trust ?? declaredOriginTrust();
  const absorb = mayAbsorbIncoming(provenance, trust);
  const nomes = `${incomingFiles.slice(0, 5).join(", ")}${incomingFiles.length > 5 ? ` +${incomingFiles.length - 5}` : ""}`;
  const oQue =
    provenance === "unknown"
      ? "traz algo que NÃO CONSEGUIMOS classificar (o diff de proveniência falhou)"
      : provenance === "outside-control"
        ? `traz o PRÓPRIO MECANISMO DE CONTROLE deste repositório (${nomes})`
        : provenance === "outside-code"
          ? `traz arquivo(s) que este checkout não produziu e que não são board-data (${nomes})`
          : "";
  return {
    provenance,
    trust,
    absorb,
    detail: oQue
      ? `${oQue} — proveniência EXTERNA` +
        (trust === "owner"
          ? ": absorvido (fronteira declarada `owner`)"
          : ": NÃO absorvido (fronteira `public`) — o push fica para depois")
      : "",
  };
}

/**
 * Promote the staged `packages/**` code from `stageBranch` onto the currently checked-out (released)
 * branch of `repoRoot`. Idempotent: once promoted, the diff is empty → a second call is a clean no-op
 * (`promoted:false`, reason "nada staged"). SM-08 fail-closed: the release commit is re-scanned for
 * secrets before the push; a hit undoes the commit (`reset --hard HEAD^1`) and reports `blocked`.
 */
export async function promoteStageToMain(opts: {
  exec: ExecFn;
  repoRoot: string;
  stageBranch: string;
  /** the code prefixes to PROMOTE — board-scoped (e.g. `packages/acmeapp/`) so one release doesn't drag
   *  every board's staged code to main. */
  codePrefixes: string[];
  /** story-5vv8n1 — the GLOBAL code roots (e.g. `packages/`), used ONLY to detect staged code that lives
   *  OUTSIDE the scoped `codePrefixes`. When the scoped diff is empty but `stage` DID add code under these,
   *  the "nada staged" no-op is really a scoping FAILURE (`out-of-scope`), not a legit nothing-to-release.
   *  Defaults to `codePrefixes` (a superset match → never flags out-of-scope, for the un-scoped legacy path). */
  allCodePrefixes?: string[];
  /** story-4eqltw — the OTHER boards' package prefixes (e.g. `packages/storymap-ui/`, `packages/orbit/`),
   *  EXCLUDED from the out-of-scope probe only. On the single shared `stage` branch that probe otherwise sees
   *  code ANOTHER board staged but has not yet promoted through ITS OWN frontier (refs/promoted/<other>) — most
   *  often the storymap-ui dev tool, released on an independent cadence — and mis-flags THIS board's empty
   *  release as `out-of-scope`, reverting the card (the real acme/story-z5pg1v revert loop). Each board owns
   *  its own promotion cycle, so foreign-board code is never THIS release's failure. The releasing board's OWN
   *  package is never in this set (see fireReleaseStaged), so it still promotes/flags its own code. Applied via
   *  `:(exclude)` pathspec; a package NO other board owns (an undeclared touch) is still flagged out-of-scope. */
  otherBoardPrefixes?: string[];
  /** story-m6sl8i — the board this release is for. When set, the diff base is a PER-BOARD promotion
   *  frontier ref `refs/promoted/<board>` (the stage sha this board last promoted) instead of the shared
   *  `merge-base(main, stage)`. The merge-base freezes on a stage shared by N boards (the release re-commits
   *  the delta, so the stage commit never becomes a main ancestor → the base never advances), so every later
   *  release re-diffs from the frozen point and re-includes already-promoted deltas → false add/add conflicts.
   *  A per-board frontier advances past each board's own last promotion, so the scoped diff is only what THIS
   *  board added since. Absent (or ref missing / not a stage ancestor) → falls back to merge-base (legacy). */
  board?: string;
  /**
   * A guarda de CONCORRÊNCIA da publicação: recebe os arquivos que ESTA promoção carregaria e devolve o
   * trabalho VIVO que toca algum deles (worktree de sessão aberto, entrada na fila do train). Não-vazio ⇒
   * não publica (`concurrent-work`).
   *
   * Existe porque o deploy não fazia parte do pipeline serializado do merge: a promoção aplica um patch na
   * MESMA árvore de trabalho de main que o train mexe, e nada perguntava se outra sessão estava reescrevendo
   * aqueles arquivos naquele instante. A mitigação em uso era humana — uma nota de embargo escrita à mão num
   * card —, que só protege o card em que alguém lembrou de escrever, e só enquanto lembrar.
   *
   * Injetada (não lida daqui) para este módulo continuar puro sobre `exec`: quem sabe de sessões vivas e da
   * fila é o chamador. Ausente ⇒ sem guarda, comportamento byte-idêntico ao anterior.
   *
   * POR ARQUIVO, deliberadamente: um cadeado global faria N sessões pararem a fila umas das outras, que é o
   * anti-objetivo do trabalho paralelo. Duas sessões em pacotes distintos publicam sem se ver.
   */
  concurrentWork?: (files: string[]) => Promise<Array<{ owner: string; files: string[] }>>;
}): Promise<PromoteResult> {
  const { exec, repoRoot, stageBranch, codePrefixes } = opts;
  const allCodePrefixes = opts.allCodePrefixes ?? codePrefixes;

  // Shared factory (B6): the `git <args>` wrapper (spawn + error-capture) lives once in git.ts.
  // cwd is fixed to repoRoot here — release only ever runs against the released branch's tree.
  const git = makeGit(exec, { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS });

  /** O head do branch de release AGORA — a evidência `mainSha` dos desfechos LIVE. Usa o `git` injetado (o
   *  mesmo que os testes fingem), nunca um exec ad-hoc. Vazio ⇒ undefined: sem evidência, ninguém reconcilia. */
  const headSha = async (): Promise<string | undefined> => (await git(`rev-parse HEAD`)).stdout.trim() || undefined;

  const branch = (await git(`rev-parse --abbrev-ref HEAD`)).stdout.trim() || "main";
  if (codePrefixes.length === 0) {
    return { promoted: false, outcome: "no-prefix", branch, pushed: false, reason: "nenhum prefixo de código configurado" };
  }
  const pathspec = codePrefixes.map(q).join(" ");
  const stageHead = (await git(`rev-parse ${q(stageBranch)}`)).stdout.trim();

  // story-m6sl8i — the DIFF BASE. Prefer a PER-BOARD promotion frontier `refs/promoted/<board>` (the stage
  // sha this board last promoted, advanced after a live outcome below) over the shared merge-base. On a
  // `stage` shared by N boards the release RE-COMMITS the delta onto main (a new sha), so the stage commit
  // never becomes a main ancestor and `merge-base(main, stage)` FREEZES at the pre-first-release point —
  // then every later release re-diffs from there and RE-INCLUDES already-promoted deltas, hitting false
  // add/add conflicts on any file two releases touched. The frontier advances past THIS board's own last
  // promotion, so the scoped diff is only what it added since. Trusted only when it resolves to a commit
  // that is an ANCESTOR of `stage` (else stage was reset/rebased → fall back to the merge-base).
  const promotedRef = opts.board ? `refs/promoted/${opts.board}` : "";
  let diffBase = "";
  if (promotedRef) {
    const f = (await git(`rev-parse --verify --quiet ${q(promotedRef)}`)).stdout.trim();
    if (f && (await git(`merge-base --is-ancestor ${q(f)} ${q(stageBranch)}`)).ok) diffBase = f;
  }
  // CLOBBER GUARD (merge-base fallback): diff from the MERGE-BASE of the released branch and `stage`, NOT
  // from `branch` directly. `branch..stage` includes main's NEWER code as a "revert" whenever `stage` fell
  // behind main (any direct code commit to main leaves it stale) — applying that patch would DELETE/revert
  // that newer code (incident 2026-06: a stale stage wiped 5602 lines). A base that is an ANCESTOR of
  // `stage` (both the frontier and the merge-base are) yields ONLY what `stage` ADDED since — the genuine
  // staged delta. So a stale stage that is an ANCESTOR of main yields an EMPTY diff → clean no-op; and a
  // staged change that overlaps main's newer code makes `git apply` fail (fail-closed below).
  if (!diffBase) diffBase = (await git(`merge-base ${q(branch)} ${q(stageBranch)}`)).stdout.trim() || branch;

  // story-m6sl8i — advance THIS board's frontier to the stage sha we just reconciled against, so the NEXT
  // release for this board diffs from here instead of the frozen merge-base. Called ONLY on a "code is
  // live" outcome (promoted / already-promoted / nothing-staged) — never on a failure. Best-effort.
  const advanceFrontier = async () => {
    if (promotedRef && stageHead) await git(`update-ref ${q(promotedRef)} ${q(stageHead)}`);
  };

  // What staged code is on `stage` but not yet on the released branch?
  //
  // `--no-renames` é OBRIGATÓRIO em TODOS os diffs desta função — o mesmo motivo já documentado no merge
  // train (merge-queue.ts, incidente Pilotagem→Inbox): com detecção de rename ligada (o default), o
  // `--name-only` de um `git mv` lista APENAS o caminho NOVO. O antigo some da lista, some do pathspec e
  // portanto some do patch — o arquivo velho SOBREVIVE em main ao lado do novo, e o release ainda devolve
  // `promoted`. O train foi curado disto; o release ficou uma camada atrás e o defeito reapareceu em
  // 2026-07-27 (o `git mv` de tools/web-terminal/ → public/terminal/ deixou 588KB de cópia órfã em main,
  // removida à mão). Sem renames, o par vira delete+add e as duas metades entram no patch. A deleção PURA
  // sempre funcionou — por isso o defeito é invisível até alguém renomear.
  const changed = (await git(`diff --name-only --no-renames ${q(diffBase)}..${q(stageBranch)} -- ${pathspec}`)).stdout.trim();
  if (!changed) {
    // story-5vv8n1 — the scoped diff is empty. That is a LEGIT no-op ONLY if `stage` also added no code
    // OUTSIDE the scope. If it DID (the acme incident: real code under packages/orbit/** while the board
    // scoped to packages/acmeapp/), this "nada staged" is a silent scoping FAILURE — the code was staged but
    // will NEVER reach main under this prefix. Surface it as `out-of-scope` so the caller reverts instead of
    // sailing to a false "No Ar". Probe skipped when the scope IS the global set (nothing to be out-of-scope of).
    const scopeIsGlobal = allCodePrefixes.length === codePrefixes.length && allCodePrefixes.every((p, i) => p === codePrefixes[i]);
    // story-4eqltw — EXCLUDE every OTHER board's package from the probe: on the shared `stage` their un-promoted
    // code is THEIR release's concern (own frontier), never a scoping failure of THIS board. `:(exclude)` needs a
    // positive pathspec — `allCodePrefixes` (e.g. `packages/`) always provides one — so this only ever narrows.
    const excludeSpec = (opts.otherBoardPrefixes ?? []).map((p) => q(`:(exclude)${p}`));
    const probePathspec = [...allCodePrefixes.map(q), ...excludeSpec].join(" ");
    const outOfScope = scopeIsGlobal
      ? ""
      : (await git(`diff --name-only --no-renames ${q(diffBase)}..${q(stageBranch)} -- ${probePathspec}`)).stdout.trim();
    if (outOfScope) {
      return {
        promoted: false,
        outcome: "out-of-scope",
        branch,
        pushed: false,
        reason:
          `nada staged em ${codePrefixes.join(", ")}, mas há CÓDIGO staged FORA do escopo do board ` +
          `(${allCodePrefixes.join(", ")}) que NÃO foi promovido — release NÃO publicou o código`,
      };
    }
    // ── A FRONTEIRA PODE ESTAR MENTINDO ───────────────────────────────────────────────────────────────
    // `changed` é `frontier..stage`. Vazio significa "este board não ADICIONOU nada desde a última
    // promoção DELE" — o que só equivale a "a main está em dia" se a fronteira for verdadeira. Ela é uma
    // OTIMIZAÇÃO (não re-diffar da merge-base congelada, ver story-m6sl8i); a VERDADE é a `branch`.
    //
    // COMO ELA MENTE (medido em 2026-07-31): o merge train integra um branch ao `stage` e a escrituração
    // da entrada morre no meio (restart) — o CÓDIGO entra, a entrada fica marcada `gate-failed`. Dali em
    // diante toda promoção cuja fronteira já esteja À FRENTE daquele commit vê `frontier..stage` vazio,
    // declara `nothing-staged` e AVANÇA a fronteira por cima: aquele conteúdo fica invisível para SEMPRE,
    // sem erro, sem log, sem ninguém para notar. Estado encontrado: 21 arquivos em 7 pacotes vivos só no
    // `stage`, com `refs/promoted/<board>` no HEAD do stage afirmando que tudo estava promovido.
    //
    // A pergunta certa é a MESMA que o story-sf4vyb faz no caminho não-vazio logo abaixo: o que a `branch`
    // ainda NÃO TEM? Aqui ela serve só para DETECTAR. Promover este conjunto às cegas seria pior que o
    // defeito: ele inclui os arquivos em que a MAIN é que está à frente, e aplicar o patch neles reverteria
    // código mais novo (o incidente das 5602 linhas). Decidir arquivo a arquivo quem está à frente é
    // análise de história que não cabe no caminho de release — então **fail-closed**: não avança a
    // fronteira e devolve uma FALHA que NOMEIA os arquivos, para o operador agir sabendo o quê.
    //
    // Guarda contra falso positivo: `stage` ANCESTRAL de `branch` é o caso "stage atrasado" que o
    // clobber-guard acima já documenta — ali a main está à frente por construção e o no-op é legítimo.
    const stageBehind = (await git(`merge-base --is-ancestor ${q(stageBranch)} ${q(branch)}`)).ok;
    const missing = stageBehind
      ? ""
      : (await git(`diff --name-only --no-renames ${q(branch)}..${q(stageBranch)} -- ${pathspec}`)).stdout.trim();
    if (missing) {
      const files = missing.split("\n").map((f) => f.trim()).filter(Boolean);
      return {
        promoted: false,
        outcome: "frontier-stale",
        branch,
        pushed: false,
        reason:
          `a fronteira de promoção (${promotedRef || "merge-base"}) está À FRENTE do que ${branch} realmente tem: ` +
          `${files.length} arquivo(s) staged sob ${codePrefixes.join(", ")} NÃO estão em ${branch} ` +
          `(${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}). A fronteira NÃO foi avançada.`,
      };
    }

    await advanceFrontier(); // code IS live (nothing under scope to promote) → this board is caught up to stageHead
    // LIVE outcome ⇒ reporta o sha de main que contém o código (evidência p/ Card.releasedSha).
    return { promoted: false, outcome: "nothing-staged", branch, pushed: false, mainSha: await headSha(), reason: `nada staged em ${codePrefixes.join(", ")} para promover` };
  }

  // story-sf4vyb — THE REAL DELTA. `changed` answers "what did `stage` ADD since this board last promoted?",
  // which is NOT the question a release must answer: "what does the released branch still LACK?". A file
  // whose blob is ALREADY identical on `branch` and `stage` needs nothing promoted — the usual cause is code
  // that reached main OUT-OF-BAND (a manual rescue cherry-pick, the CLI, another board's release carrying a
  // shared file), which leaves this board's frontier stale while main is already correct. Re-applying those
  // files is dead work at best and a SPURIOUS conflict at worst: the patch's context no longer matches, so
  // --3way falls back to merging against main's own copy of the SAME change, and a divergence as trivial as a
  // reworded comment fails the WHOLE release — reverting a card whose code is demonstrably live ("No ar" →
  // "Liberar" + a deploy-failure claiming the code was never published). The 2026-07-16 acme incident
  // (story-qb8z2c + story-eqpdtz, both rescued by hand onto main): `frontier..stage` was 9 files while
  // `main..stage` was 0 — the release re-applied a 42KB patch that could only ever be a no-op.
  //
  // Intersecting with the branch-vs-stage diff is LOSSLESS: an excluded file already holds EXACTLY the content
  // `stage` would give it, so dropping it cannot lose code. It only ever NARROWS — a file changed only on
  // `branch` is already excluded from `changed` by the clobber guard above, so main's newer code stays
  // untouchable either way. An empty intersection ⇒ `already-promoted`: the very same LIVE outcome the
  // empty-commit guard below already returns for this case, just reached WITHOUT gambling on the apply.
  const divergent = new Set(
    (await git(`diff --name-only --no-renames ${q(branch)}..${q(stageBranch)} -- ${pathspec}`)).stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean),
  );
  const changedFiles = changed.split("\n").map((f) => f.trim()).filter(Boolean);
  const toPromote = changedFiles.filter((f) => divergent.has(f));
  if (toPromote.length === 0) {
    await advanceFrontier(); // `branch` already holds every staged file → this board is caught up to stageHead
    // LIVE outcome ⇒ reporta o sha de main que contém o código (evidência p/ Card.releasedSha).
    return {
      promoted: false,
      outcome: "already-promoted",
      branch,
      pushed: false,
      mainSha: await headSha(),
      reason: `código staged já promovido — ${changedFiles.length} arquivo(s) idênticos entre ${stageBranch} e ${branch}, nada a aplicar`,
    };
  }

  // A guarda de concorrência roda AQUI: depois de saber exatamente quais arquivos a promoção carregaria
  // (`toPromote`), e ANTES de tocar a árvore. Perguntar antes de computar o conjunto obrigaria a guarda a
  // adivinhar o escopo pelo branch inteiro e ela seguraria publicações que não colidem com nada.
  // A INTERSEÇÃO é feita AQUI, não confiada à sonda: uma sonda é um informante ("isto está vivo"), e a
  // decisão de segurar é desta função, que é quem sabe o que vai carregar. Assim uma sonda conservadora
  // demais (que reporte um worktree inteiro, por exemplo) não vira uma publicação travada sem colisão real.
  // Uma entrada da sonda nomeia um ARQUIVO ou um PREFIXO (`packages/acmeapp/`): o prefixo é como uma
  // sessão sem árvore isolada — imensurável arquivo a arquivo — declara o território que ocupa. Casar só
  // por igualdade deixaria esse caso passar silenciosamente, que é justamente o caso mais perigoso.
  const clashesWith = (claimed: string): string[] =>
    claimed.endsWith("/") ? toPromote.filter((f) => f.startsWith(claimed)) : toPromote.includes(claimed) ? [claimed] : [];
  const clashes = ((await opts.concurrentWork?.(toPromote)) ?? [])
    .map((c) => ({ owner: c.owner, files: [...new Set(c.files.flatMap(clashesWith))] }))
    .filter((c) => c.files.length > 0);
  if (clashes.length > 0) {
    const who = clashes
      .map((c) => `${c.owner} (${c.files.slice(0, 5).join(", ")})`)
      .join("; ")
      .slice(0, 400);
    return {
      promoted: false,
      outcome: "concurrent-work",
      branch,
      pushed: false,
      // NOMEIA dono e arquivos: uma recusa em que o operador não tem como agir é o mesmo defeito do
      // `returned-to-session` sem motivo — o processo pára e ninguém sabe o que destravar.
      reason:
        `publicação segurada: há trabalho VIVO nos mesmos arquivos — ${who}. ` +
        `O código segue staged (nada foi perdido): publique quando esse trabalho integrar.`,
      clashes,
    };
  }

  // Apply ONLY the code delta onto the released branch (never the board data → no stale-data conflict), and
  // only for the files main actually LACKS (story-sf4vyb) — an already-matching file can contribute nothing
  // but a false conflict.
  const applyPathspec = toPromote.map(q).join(" ");
  const patchFile = path.join(runnerStateDir(), `release-${stageBranch}-${process.pid}-${++releaseSeq}.patch`);
  // --binary: emit the full 40-hex index line + the `GIT binary patch` payload for files Git treats as
  // binary (`.snap` golden snapshots are `*.snap binary` in .gitattributes on purpose — see there; also
  // `.png`/`.lockb`/etc.). Without it, `git diff` writes only a `Binary files … differ` stub with an
  // ABBREVIATED index and no payload, and `git apply` below dies with "cannot apply binary patch without
  // full index line" → the whole release fails (story-r4qdap: a release that regenerated a golden .snap).
  // For text files --binary is a no-op (implies --full-index, still emits normal text hunks).
  await git(`diff --binary --no-renames ${q(diffBase)}..${q(stageBranch)} -- ${applyPathspec} > ${q(patchFile)}`);
  // --3way: 3-way merge fallback so the patch composes with main's CURRENT tree instead of demanding the
  // merge-base context verbatim. Keeps it idempotent (code already promoted → resolves to a no-op, caught
  // by the empty-commit guard below) and lets non-overlapping main changes coexist; a genuine overlap
  // leaves conflict markers + non-zero exit → fail-closed (never a silent clobber).
  let applied = await git(`apply --3way --index ${q(patchFile)}`);
  // The patch is consumed by the apply above (its content is now in the index/worktree) — drop it so the
  // unique-per-invocation names don't accumulate in the SHARED runnerStateDir(). Best-effort either way.
  await fsp.unlink(patchFile).catch(() => {});
  let effectiveBase = diffBase;
  if (!applied.ok) {
    // #edk504 FAIL-CLEAN: a --3way conflict (a genuine overlap, OR a STALE `stage` whose old code
    // collides with main's newer code — the recurring case when code lands direct-on-main and the
    // stage drifts behind) leaves partial hunks / conflict markers staged in the index + worktree.
    // Restore the code pathspec to HEAD so a failed release NEVER dirties the LIVE released checkout
    // (otherwise the next autorun "board: estado vivo" commit could commit the garbage and corrupt
    // main). Scoped to codePrefixes → board data + any other uncommitted work stay untouched.
    await git(`checkout HEAD -- ${pathspec}`);
    // FANTASMA DE BASE (story-tlz0dt): a fronteira pode estar VELHA — o patch dela re-inclui mudanças que
    // `branch` já recebeu por outro caminho, escritas de outra forma, e o 3-way morre num conflito que o
    // delta REAL não tem. Antes de reportar falha, UMA re-tentativa com a base FRESCA (merge-base
    // branch↔stage; com stage ⊇ branch é o próprio tip da branch) para os MESMOS arquivos: o conjunto
    // `toPromote` já é medido contra `branch..stage`, então o conteúdo também pode ser. Aplica ⇒ segue o
    // fluxo normal; não aplica ⇒ a divergência é REAL e o apply-failed abaixo é a verdade.
    const freshBase = (await git(`merge-base ${q(branch)} ${q(stageBranch)}`)).stdout.trim();
    if (freshBase && freshBase !== diffBase) {
      const freshPatch = path.join(runnerStateDir(), `release-${stageBranch}-${process.pid}-${++releaseSeq}.patch`);
      await git(`diff --binary --no-renames ${q(freshBase)}..${q(stageBranch)} -- ${applyPathspec} > ${q(freshPatch)}`);
      const retried = await git(`apply --3way --index ${q(freshPatch)}`);
      await fsp.unlink(freshPatch).catch(() => {});
      if (retried.ok) {
        console.warn(
          `[release] patch da fronteira ${diffBase.slice(0, 8)} não aplicou em ${branch}; a base fresca ${freshBase.slice(0, 8)} aplicou LIMPO — fantasma de base curado (${toPromote.length} arquivo(s))`,
        );
        applied = retried;
        effectiveBase = freshBase;
      } else {
        await git(`checkout HEAD -- ${pathspec}`); // fail-clean da re-tentativa também
      }
    }
  }
  if (!applied.ok) {
    return {
      promoted: false,
      outcome: "apply-failed",
      branch,
      pushed: false,
      // WS-10.4 — the divergent set, published for the ladder (the caller judges these files against main's
      // current text before reporting the failure). Same `toPromote` the reason names; no new computation.
      divergentFiles: toPromote,
      // A base efetiva do 3-way reprovado — a escada materializa o MESMO conflito a partir dela (nunca de
      // `branch`, que aplicaria por tautologia — ver doc do campo).
      divergentBase: effectiveBase,
      // story-sf4vyb — NAME the divergent files and the remedy. The old text ("diagnostique por que a promoção
      // não encontrou/aplicou o código staged") implied the code was MISSING and sent the operator hunting for
      // a lost commit; the real cause is that `stage` and `branch` each carry a DIFFERENT text for the same
      // region (classically: the same fix landed on both, worded differently), which `toPromote` names exactly.
      reason:
        `o código staged não aplicou limpo em ${branch} (worktree restaurada): ${applied.stderr.slice(0, 300)}` +
        ` · ${stageBranch} e ${branch} divergem em: ${toPromote.slice(0, 5).join(", ")}` +
        `${toPromote.length > 5 ? ` (+${toPromote.length - 5})` : ""}` +
        ` — se o código já está live (aterrissado fora do pipeline), reconcilie o ${stageBranch} com ${branch} e republique`,
    };
  }
  // --no-verify: the unattended release commit bypasses the non-security pre-commit hooks (mirrors
  // commitAllPending / the split commits, audit #10); the secret re-scan below is the security gate.
  const committed = await git(`commit --no-verify -m ${q(`release: promove código staged de ${stageBranch} para ${branch}`)}`);
  if (!committed.ok) {
    // Nothing actually committed (e.g. the delta was already present) → treat as a clean no-op.
    await git(`reset -- ${pathspec}`); // unstage anything left in the index
    await advanceFrontier(); // idempotent: the delta is already on main → advance so the next release skips it
    // LIVE outcome ⇒ o head atual JÁ contém o delta (é por isso que não houve o que commitar).
    return { promoted: false, outcome: "already-promoted", branch, pushed: false, mainSha: await headSha(), reason: "nada a commitar (já promovido)" };
  }

  // SM-08 fail-closed: re-scan the release commit before pushing. A hit undoes it (branch pristine).
  let blocked: string | null = null;
  try {
    await exec(secretScanCommand(repoRoot, { range: "HEAD~1..HEAD" }), { cwd: repoRoot, timeout: GIT_TIMEOUT_MS });
  } catch (e: unknown) {
    blocked = execErrorDetail(e) || "secret-scan falhou";
  }
  if (blocked) {
    await git(`reset --hard HEAD^1`);
    return { promoted: false, outcome: "blocked", branch, pushed: false, blocked: true, reason: `secret-scan bloqueou o release: ${blocked}` };
  }

  const commit = (await git(`rev-parse HEAD`)).stdout.trim();
  // Push the release commit. #37 auto-push: on a non-fast-forward rejection (origin advanced — the
  // autorun pushed board data, or another checkout) RECONCILE (fetch + merge FETCH_HEAD; the release
  // touches ONLY packages/**, the board data origin advanced is disjoint → clean merge) and retry
  // ONCE, so origin stays == this checkout instead of stranding the release unpushed. Merge (not
  // rebase) preserves the release commit sha. A genuine code overlap aborts → best-effort false
  // (cumulative: a later push catches up).
  let pushed = (await git(`push origin ${q(branch)}`)).ok;
  if (!pushed && (await git(`fetch origin ${q(branch)}`)).ok) {
    // story-281gg4 — FRONTEIRA DE CONTRIBUIÇÃO. Este merge absorve `origin/<branch>` na árvore que o
    // self-deploy vai buildar e reiniciar como root, e é o único lugar do release por onde um commit que
    // este checkout não produziu entra sem ninguém decidir nada. O reconcile existe para o DADO de outro
    // checkout do dono (disjunto do código, é por isso que resolve limpo) — então o que NÃO é board-data
    // provado só passa sob a fronteira declarada `owner`, e nunca em silêncio. Ver os blocos
    // story-281gg4 / story-m3iouv no topo; a decisão inteira é de `judgeIncoming` (uma régua, três
    // reconciles). O `.ok` do diff VIAJA: um diff ilegível não pode virar lista vazia e, com ela, um
    // "origin não trouxe nada" — era o único caminho em que a incerteza LIBERAVA.
    const incomingDiff = await git(`diff --name-only --no-renames HEAD...FETCH_HEAD`);
    const incoming = incomingDiff.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    const verdict = judgeIncoming(incoming, allCodePrefixes, { readable: incomingDiff.ok });
    if (verdict.detail) console.warn(`[release] origin/${branch} ${verdict.detail} (o release segue local)`);
    if (verdict.absorb) {
      if ((await git(`merge --no-edit FETCH_HEAD`)).ok) {
        pushed = (await git(`push origin ${q(branch)}`)).ok; // retry after pulling origin's advance in
      } else {
        await git(`merge --abort`); // conflict/error → leave the released branch pristine
      }
    }
  }
  await advanceFrontier(); // the staged delta is now live on main (committed locally, push best-effort) → advance
  // story-efwo30 — surface the promoted file set (computed above as `changed`) so the deploy can decide
  // whether the mosaico.app merged face must ALSO be published (touchesComposedFace).
  // story-sf4vyb — deliberately the FULL staged set, not the narrowed `toPromote`: this is the delta the
  // release is publishing, and the face gate must stay conservative. A file excluded from the patch only
  // because main already matched it may have reached main OUT-OF-BAND (a manual rescue), in which case no
  // earlier release ever fired the face for it — under-reporting here would ship a broken face.
  // `commit` É o head de main agora — a promoção acabou de commitá-lo lá. mainSha = commit (sem git extra).
  return { promoted: true, outcome: "promoted", branch, commit, mainSha: commit, pushed, changedFiles };
}
