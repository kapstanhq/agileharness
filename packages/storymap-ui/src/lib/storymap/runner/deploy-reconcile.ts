// deploy-reconcile.ts — um `deploy-failure` é uma AFIRMAÇÃO ("o código deste card pode não estar no ar"), não
// uma lápide. Este módulo a RE-VERIFICA contra a realidade publicada e a retira quando ela deixou de ser verdade.
//
// O BURACO QUE ISTO FECHA (incidente acme/story-99wmbx + acme/story-dfbig1, 2026-07-08 → 13):
// o único caminho que fechava o finding era `resolveDeployFailureFindingOnSuccess`, chamado SÓ pelo settle do
// deploy que o PRÓPRIO board disparou, para AQUELE cardId. Quando o deploy do board falhou e o operador
// republicou à mão (`just orch-deploy acmeapp` no shell — que não passa pelo registry, logo não tem onDone), o
// código FOI para produção e o finding ficou `open` PARA SEMPRE. A UI, deliberadamente, não oferece "Resolver"
// nesse item (marcar resolvido sem republicar deixaria o card mentindo) — então os cards ficaram travados num
// deadlock: a única saída oferecida era re-deployar algo que já estava no ar.
//
// A saída não é um botão a mais: é parar de inferir o estado do mundo a partir de QUEM disparou o deploy e
// passar a LER o mundo. O orquestrador de deploy grava, para cada alvo, o commit em que rodou
// (`scripts/deploy/state/<alvo>.json` → `lastDeploySha`) — INDEPENDENTE de quem o invocou (board, MCP ou shell).
// Se esse commit é DESCENDENTE do sha de main onde o código do card pousou (`card.releasedSha`), então aquele
// deploy necessariamente carregou o código do card: ele está no ar, e o alarme é resíduo.
//
// CONSERVADOR POR CONSTRUÇÃO: qualquer evidência ausente (sem releasedSha, sem deployTargets, sem arquivo de
// estado, git ilegível) ⇒ NÃO resolve. Um falso-negativo deixa um alarme a mais na tela; um falso-positivo faz
// o card mentir "No ar" — que é o defeito que este subsistema inteiro existe para impedir. A assimetria é
// deliberada e não deve ser "otimizada".
//
// Verdict PURO + IO injetável (git/fs), para os testes provarem a lógica sem repo, sem rede e sem deploy.

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEPLOY_FAILURE_FINDING_ID, isDeployStep } from "@/lib/storymap/demands";
import { checkGate, declaresCode } from "@/lib/storymap/gates";
import { nextBuildStatus } from "@/lib/storymap/pipeline-routing";
import { resolveStaleQuestions } from "@/lib/storymap/questions";
import { supersedeStaleTerminalBlockers } from "./findings";
import { findRepoRoot, findToolRoot } from "@/lib/storymap/paths";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { rangeLandedBySplit, shaContainedIn } from "./convergence";
import { appendTransition } from "./transitions";
import { defaultExec, type ExecFn } from "./worktree";
import type { BoardConfig, Card, DeployProof } from "@/lib/storymap/types";

/** O que o orquestrador de deploy grava por alvo. Só `lastDeploySha` nos interessa: o commit em que ele rodou. */
export interface DeployStateFile {
  lastDeploySha?: string;
}

/** Por que um card NÃO pôde ser reconciliado (ou por que pôde) — para log e testes. */
export type ReconcileVerdict =
  | { resolved: true; via: string[] }
  | { resolved: false; reason: "sem-finding-aberto" | DeployUnprovenReason };

/** O card carrega um `deploy-failure` ABERTO? (o predicado que a UI usa para o grupo "Travado"). */
export function hasOpenDeployFailure(card: Card): boolean {
  return !!card.findings?.some((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open");
}

/**
 * deploy-truth WS-1/WS-4 (D-DT2) — A MEDIÇÃO, extraída para ser a régua ÚNICA. O card está PROVADAMENTE
 * no ar quando, para TODO alvo que ele declara, o último deploy daquele alvo rodou num commit que CONTÉM
 * o código do card (`releasedSha` é ancestral-ou-igual dele). Era o corpo do {@link reconcileVerdict};
 * virou função própria porque agora DOIS consumidores a leem — a reconciliação de finding (abaixo) e o
 * carimbo `deployProof` do settle ({@link settleDeploySuccess}) — e duas réguas para uma pergunta é como
 * o canário do rosto nasceu (anti-requisito do plano: NENHUMA régua nova; extrair e reusar).
 */
export type DeployUnprovenReason =
  | "sem-released-sha"
  | "sem-alvos"
  | "alvo-sem-deploy"
  | "deploy-anterior-ao-codigo"
  // follow-up A (classe-limbo data-only) — as três saídas fail-closed da medição por partição:
  | "codigo-sem-release" // a metade de CÓDIGO do commitRange NÃO é vazia e o card não tem release — segue preso
  | "board-data-nao-aterrissou" // metade de dados não provada em main — segue preso
  | "medicao-indisponivel"; // git falhou / ref não resolveu / base mudou sob o lock — segue preso

export type DeployProofMeasurement =
  | {
      proven: true;
      sha: string;
      targets: string[];
      /**
       * follow-up A — presente SÓ na prova data-only: o commitRange que a medição particionou. O guard de
       * staleness sob o lock re-valida CONTRA ELE (o range ainda é o mesmo? o card segue sem releasedSha?),
       * porque para esta prova `sha` é o sha de MAIN medido — comparar com `releasedSha` (o guard das provas
       * por ancestralidade) descartaria toda prova data-only por construção.
       */
      dataOnlyRange?: { base: string; head: string };
    }
  | { proven: false; reason: DeployUnprovenReason };

export async function measureDeployAncestry(
  card: Pick<Card, "releasedSha" | "deployTargets">,
  deployedShaFor: (target: string) => Promise<string | null>,
  contains: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<DeployProofMeasurement> {
  const released = card.releasedSha?.trim();
  if (!released) return { proven: false, reason: "sem-released-sha" };
  const targets = card.deployTargets?.filter(Boolean) ?? [];
  if (targets.length === 0) return { proven: false, reason: "sem-alvos" };

  for (const target of targets) {
    const deployed = await deployedShaFor(target);
    if (!deployed) return { proven: false, reason: "alvo-sem-deploy" };
    if (!(await contains(released, deployed))) return { proven: false, reason: "deploy-anterior-ao-codigo" };
  }
  return { proven: true, sha: released, targets };
}

/**
 * PURE — o veredito de RECONCILIAÇÃO de finding: a medição de ancestralidade ({@link measureDeployAncestry},
 * a régua única) aplicada a um card que carrega o alarme `deploy-failure` aberto.
 *
 * `contains(releasedSha, deployedSha)` é injetado (na prática {@link makeGitContains} sobre a primitiva de
 * ancestralidade `shaContainedIn` de convergence.ts, que é reflexiva — um sha contém a si mesmo, logo um
 * deploy rodado exatamente no commit da promoção conta como no ar).
 *
 * "TODO alvo" e não "algum": um card cujo código está na face E no backend não está no ar enquanto só um dos
 * dois tiver subido — é exatamente esse meio-deploy que produz o "rosto novo falando com backend velho".
 */
export async function reconcileVerdict(
  card: Card,
  deployedShaFor: (target: string) => Promise<string | null>,
  contains: (ancestor: string, descendant: string) => Promise<boolean>,
): Promise<ReconcileVerdict> {
  if (!hasOpenDeployFailure(card)) return { resolved: false, reason: "sem-finding-aberto" };
  const m = await measureDeployAncestry(card, deployedShaFor, contains);
  return m.proven ? { resolved: true, via: m.targets } : { resolved: false, reason: m.reason };
}

// ── IO (best-effort, fail-CLOSED no veredito: qualquer erro vira "não sei" ⇒ não resolve) ─────────────────

/** Caminho do estado que `scripts/deploy/orchestrator.js` grava — a MESMA fonte para deploy de board, MCP ou shell. */
export function deployStatePath(repoRoot: string, target: string): string {
  return path.join(repoRoot, "scripts", "deploy", "state", `${target.replace(/[^a-z0-9_-]/gi, "")}.json`);
}

/** O commit em que o último deploy de `target` rodou, ou null (arquivo ausente/corrompido/sem o campo). */
export async function readLastDeploySha(repoRoot: string, target: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(deployStatePath(repoRoot, target), "utf8")) as DeployStateFile;
    const sha = raw?.lastDeploySha?.trim();
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null; // sem evidência ⇒ não resolve (conservador)
  }
}

/**
 * `ancestor` está contido em `descendant`? (reflexivo). Follow-up B (deploy-truth): a pergunta é respondida
 * pela primitiva ÚNICA de ancestralidade (`shaContainedIn`, convergence.ts) — este adapter só COLAPSA o
 * trinário para o booleano fail-closed que a medição de deploy consome: `contained` ⇒ true; `not-contained`
 * E `unknown` ⇒ false — nunca "no ar" por acidente (um git quebrado não é uma resposta).
 */
export function makeGitContains(exec: ExecFn, repoRoot: string) {
  return async (ancestor: string, descendant: string): Promise<boolean> =>
    (await shaContainedIn(exec, repoRoot, { inner: ancestor, outer: descendant, timeoutMs: 15_000 })) === "contained";
}

// ── Follow-up A (deploy-truth) — a classe-LIMBO do card DATA-ONLY ────────────────────────────────────────
//
// Um run que só tocou board-data ganha `commitRange` do harness-review ⇒ declaresCode(card)=true ⇒ o gate
// hasDeployProof exige prova ⇒ mas ele NUNCA terá `releasedSha` (nada foi staged/promovido): sem esta
// medição o card ficaria PRESO em Publicando para sempre — o watchdog escala, sem caminho feliz. A saída é
// a régua do TRAIN, não uma régua nova: particionar o delta do commitRange com a MESMA
// partitionPaths/STAGING_CODE_PREFIXES que roteiam a integração (`rangeLandedBySplit`, convergence.ts).
// Metade de código VAZIA ⇒ o card é data-only, e a "produção" de board-data É a main do runtime: provar que
// a metade de dados aterrissou em main é provar a publicação. O gate NÃO muda — ele continua exigindo o
// carimbo; o que muda é que o settle passa a saber carimbar ESTE caso.

/** Sha atual de um ref (ex.: "main"), ou null — o sha "publicado" que a prova data-only carimba. */
async function resolveRefShaDefault(exec: ExecFn, repoRoot: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await exec(`git rev-parse --verify --quiet ${JSON.stringify(`${ref}^{commit}`)}`, {
      cwd: repoRoot,
      timeout: 15_000,
    });
    const sha = String(stdout).trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * A medição data-only: o commitRange particionado pela régua do train, fail-closed em TODA ponta.
 *   • metade de código VAZIA (`code: "n/a"`) + metade de dados ATERRISSADA em main (`data: "landed"`) ⇒
 *     prova `{sha: <sha de main medido>, targets: ["board-data"], dataOnlyRange}`;
 *   • metade de código NÃO-vazia ⇒ `codigo-sem-release` (card misto sem release — NADA muda, segue
 *     preso). O range VAZIO cai aqui também ({absent, absent} pela doutrina do range vazio — a checagem
 *     de código dispara primeiro), com o mesmo desfecho fail-closed;
 *   • qualquer metade `unknown` (git falhou / ref não resolveu) ⇒ `medicao-indisponivel` (segue preso);
 *   • dados não provados (`absent`/`partial`) ⇒ `board-data-nao-aterrissou` (segue preso).
 * DI para os testes; a régua real é SEMPRE a de convergence.ts — nunca uma cópia local.
 */
export async function measureDataOnlySettle(
  exec: ExecFn,
  repoRoot: string,
  range: { base: string; head: string },
  deps: {
    /** onde board-data é produção (default "main" — a main do runtime). */
    dataRef?: string;
    /** a régua particionada (DI de teste; default = a única, de convergence.ts). */
    rangeLanded?: typeof rangeLandedBySplit;
    /** resolve o sha publicado do dataRef (DI de teste). */
    resolveRefSha?: (ref: string) => Promise<string | null>;
  } = {},
): Promise<DeployProofMeasurement> {
  const dataRef = deps.dataRef ?? "main";
  const split = await (deps.rangeLanded ?? rangeLandedBySplit)(exec, repoRoot, { range, dataRef });
  if (split.code === "unknown") return { proven: false, reason: "medicao-indisponivel" };
  if (split.code !== "n/a") return { proven: false, reason: "codigo-sem-release" };
  if (split.data === "unknown") return { proven: false, reason: "medicao-indisponivel" };
  if (split.data !== "landed") return { proven: false, reason: "board-data-nao-aterrissou" };
  const mainSha = await (deps.resolveRefSha ?? ((ref: string) => resolveRefShaDefault(exec, repoRoot, ref)))(dataRef);
  if (!mainSha) return { proven: false, reason: "medicao-indisponivel" };
  return { proven: true, sha: mainSha, targets: ["board-data"], dataOnlyRange: { base: range.base, head: range.head } };
}

// ── WS-11.1 (autonomy-reliability): risco de deploy ESCOPADO por pacote (2 números, não 119) ──────────
/** The SCOPED deploy delta: the commits that ACTUALLY enter a package's deploy since `baseSha` (its
 *  last-deploy sha), as opposed to the misleading monorepo-wide count the incident quoted ("119"). Runs
 *  `git log --oneline <baseSha>..HEAD -- <scopePaths>`. PURE over the injected exec; NEVER throws (any git
 *  error / empty base ⇒ count 0). */
export async function scopedDeployDelta(
  exec: ExecFn,
  repoRoot: string,
  baseSha: string,
  scopePaths: string[],
): Promise<{ count: number; commits: { sha: string; subject: string }[] }> {
  if (!baseSha || scopePaths.length === 0) return { count: 0, commits: [] };
  try {
    const spec = scopePaths.map((p) => JSON.stringify(p)).join(" ");
    const { stdout } = await exec(`git log --oneline --no-decorate ${JSON.stringify(baseSha)}..HEAD -- ${spec}`, {
      cwd: repoRoot,
      timeout: 20_000,
    });
    const commits = String(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(" ");
        return i < 0 ? { sha: l, subject: "" } : { sha: l.slice(0, i), subject: l.slice(i + 1) };
      });
    return { count: commits.length, commits };
  } catch {
    return { count: 0, commits: [] };
  }
}

/** Monorepo-wide commit count since `baseSha` — the number that LOOKS scary out of context (the "119"). */
export async function monorepoDeltaCount(exec: ExecFn, repoRoot: string, baseSha: string): Promise<number> {
  if (!baseSha) return 0;
  try {
    const { stdout } = await exec(`git rev-list --count ${JSON.stringify(baseSha)}..HEAD`, { cwd: repoRoot, timeout: 20_000 });
    const n = parseInt(String(stdout).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** WS-11.1 — the honest, LABELED deploy risk summary for a package: BOTH numbers (monorepo-wide vs what
 *  actually enters this deploy) + the scoped commit list. `deploy_plan` includes it so the operator decides
 *  informed ("2 commits entram", not "119 de backlog"). Reads the package's last-deploy sha from the deploy
 *  orchestrator's state (READ-only). Never throws. */
export async function deployRiskSummary(
  exec: ExecFn,
  repoRoot: string,
  pkg: string,
): Promise<{
  pkg: string;
  baseSha: string | null;
  monorepoSinceBase: number;
  scoped: { count: number; commits: { sha: string; subject: string }[] };
  note: string;
}> {
  const baseSha = await readLastDeploySha(repoRoot, pkg);
  // WS-11.1 — scope = the package's OWN build path, DERIVED from the pkg id (no hardcoded per-app map — that
  // would name product boards in this agnostic file, which agnostic-lint forbids). Commits that touched ONLY a
  // shared workspace dep aren't in this count (the note flags it); the package's own commits are the primary
  // signal that turns the monorepo-wide "119" into an informed number.
  const scopePaths = [`packages/${pkg}/`];
  const [monorepoSinceBase, scoped] = await Promise.all([
    monorepoDeltaCount(exec, repoRoot, baseSha ?? ""),
    scopedDeployDelta(exec, repoRoot, baseSha ?? "", scopePaths),
  ]);
  const note = baseSha
    ? `monorepo desde a base do último deploy: ${monorepoSinceBase}; entram NESTE deploy de ${pkg} (escopo: ` +
      `packages/${pkg}/, deps compartilhadas à parte): ${scoped.count}` +
      `${scoped.commits.length ? ` (${scoped.commits.map((c) => c.sha).join(", ")})` : ""}. A granularidade de ` +
      `publicação é a UNIDADE (imagem) — publicar leva TODOS os commits que tocaram os paths da unidade desde a ` +
      `base, não por card.`
    : `sem sha de último deploy registrado para ${pkg} — não há base para o delta escopado (o 1º deploy publica tudo).`;
  return { pkg, baseSha, monorepoSinceBase, scoped, note };
}

// ── deploy-truth WS-3 — o SETTLE DE SUCESSO: prova → carimbo → terminal ──────────────────────────────────
//
// O terminal deixou de ser otimista: o card fica no passo de deploy ("Publicando") até um settle OK chegar E
// a prova ser MEDIDA (a régua única de ancestralidade acima). Só então o handler carimba `deployProof` e
// avança deploy → terminal PELO CAMINHO GATADO (checkGate — o gate hasDeployProof passa porque o carimbo
// existe; qualquer outro gate de board também é respeitado). Fail-closed em toda ponta: settle ok SEM prova
// mantém o card em Publicando COM `deployFiredAt` (o watchdog deploy-unsettled escala ao humano); nada aqui
// jamais avança por exit code sozinho. Um card SEM código (a régua positiva declaresCode, a MESMA do gate)
// avança sem carimbo — não há o que provar (D-DT8). Cards já terminais só ganham limpeza/carimbo (nunca uma
// migração retroativa: settle de card histórico não existe).

/** O que um settle de sucesso decidiu para UM card — capturado para log/teste. */
export interface DeploySettleSuccessDecision {
  /** o card transformado a escrever, ou null para PULAR o write (nada mudou — no-op genuíno). */
  next: Card | null;
  /** o terminal para o qual o card avançou (null = não avançou nesta chamada). */
  advancedTo: string | null;
  /** `deployProof` foi carimbado nesta decisão. */
  stampedProof: boolean;
  /** por que um card no passo de deploy NÃO avançou (prova ausente / gate reprovou / sem terminal adiante). */
  heldReason: string | null;
}

/**
 * PURE — a decisão completa de um settle de deploy BEM-SUCEDIDO para um card, composta numa única
 * transformação (roda inteira sob o lock por-card do updateCardOnDisk — sem TOCTOU):
 *   1. resolve o finding `deploy-failure` obsoleto (open → fixed) — o deploy confirmou, o alarme é resíduo;
 *   2. prova medida ⇒ carimba `deployProof` (sha/targets/at/source) e limpa `deployFiredAt`;
 *   3. card sem código ⇒ limpa `deployFiredAt` (settle é confirmação suficiente; não há o que provar);
 *   4. card COM código e SEM prova ⇒ MANTÉM `deployFiredAt` — "settlou mas não provou" continua escalando
 *      pelo watchdog deploy-unsettled em vez de sumir num terminal mentiroso;
 *   5. (prova ∨ sem-código) e o card está PARADO no passo de deploy ⇒ avança para o PRÓXIMO passo, exigindo
 *      que seja TERMINAL e que o checkGate passe (o caminho gatado — nunca um bypass do gate).
 * `evidenceOnly` (source reconcile-evidence): a varredura por evidência NÃO é um evento de settle — para um
 * card COM código e SEM prova ela não tem autoridade nenhuma (não resolve finding, não limpa stamp, não
 * avança). Com prova — ou para um card sem código, que não tem o que provar — tem autoridade PLENA
 * (evidência é mais forte que um exit code).
 */
export function applyDeploySettleSuccess(
  card: Card,
  config: BoardConfig,
  measurement: DeployProofMeasurement | null,
  opts: { source: DeployProof["source"]; now: string; today: string; evidenceOnly?: boolean },
): DeploySettleSuccessDecision {
  const noCode = !declaresCode(card);
  const proven = measurement?.proven === true;
  if (opts.evidenceOnly && !proven && !noCode) return { next: null, advancedTo: null, stampedProof: false, heldReason: null };

  let next: Card = card;
  let changed = false;

  // 1 — o settle OK resolve o alarme de deploy anterior (recuperação: revert → reentra → sucesso).
  if (hasOpenDeployFailure(next)) {
    next = {
      ...next,
      findings: (next.findings ?? []).map((f) =>
        f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const } : f,
      ),
    };
    changed = true;
  }

  // 2 — a PROVA: carimba deployProof (idempotente — um re-settle com a mesma prova não re-escreve).
  let stampedProof = false;
  if (proven && measurement.proven && (next.deployProof?.sha !== measurement.sha || next.deployProof?.source !== opts.source)) {
    next = {
      ...next,
      deployProof: { sha: measurement.sha, targets: measurement.targets, at: opts.now, source: opts.source },
    };
    changed = true;
    stampedProof = true;
  }

  // 3/4 — o watchdog: limpa o stamp SÓ com prova (ou sem código); senão o deploy-unsettled segue armado.
  if ((proven || noCode) && next.deployFiredAt != null) {
    next = { ...next, deployFiredAt: undefined };
    changed = true;
  }

  // 5 — o avanço gatado deploy → terminal. Só stories, só a partir do passo que CARREGA o deploy.
  let advancedTo: string | null = null;
  let heldReason: string | null = null;
  const def = config.statuses.find((s) => s.id === card.status);
  if (card.type === "story" && isDeployStep(def)) {
    if (proven || noCode) {
      const dest = nextBuildStatus(config, def!.id, next);
      if (!dest || !dest.status.terminal) {
        heldReason = "o próximo passo do pipeline não é terminal — avanço automático só entra num terminal";
      } else {
        const gateError = checkGate(next, dest.status.id, config);
        if (gateError) {
          heldReason = gateError; // um gate de board reprova ⇒ o card FICA (o gate é a autoridade, nunca este handler)
        } else {
          // HITL + terminal supersede: entrar num terminal resolve perguntas abertas como stale E supersede os
          // MECHANISM blockers residuais (code/data-not-landed, merge-back). Num terminal o código já subiu por
          // outro caminho (settle provado acima), então o blocker "não aterrissou" é stale e NUNCA fecharia
          // sozinho (o card não re-integra) — mesma régua do move manual (actions) e do forward (autorun-eval).
          const superseded = supersedeStaleTerminalBlockers(next.findings ?? [], { by: `terminal:${dest.status.id}`, at: opts.today });
          next = {
            ...next,
            status: dest.status.id,
            questions: resolveStaleQuestions(next.questions ?? [], opts.today),
            ...(superseded ? { findings: superseded } : {}),
          };
          advancedTo = dest.status.id;
          changed = true;
        }
      }
    } else {
      heldReason =
        measurement && !measurement.proven
          ? `prova de publicação não medida (${measurement.reason}) — card segue em Publicando, watchdog armado`
          : "prova de publicação ausente — card segue em Publicando, watchdog armado";
    }
  }

  return { next: changed ? next : null, advancedTo, stampedProof, heldReason };
}

/** DI do {@link settleDeploySuccess} — tudo injetável para o teste nunca tocar git/fs/disco real. */
export interface SettleDeploySuccessDeps {
  repoRoot?: string;
  /** A raiz do repositório DA FERRAMENTA — de onde o self-deploy tirou o build, e por isso a única
   *  de onde a prova dele pode ser tirada. Ausente ⇒ {@link findToolRoot}. Enquanto a ferramenta mora
   *  dentro do alvo as duas coincidem; quando divergem, medir o HEAD do ALVO prova um deploy que não
   *  aconteceu — era o defeito C2 do plano da inversão. */
  toolRoot?: string;
  exec?: ExecFn;
  readConfig?: (board: string) => Promise<BoardConfig | null>;
  readBoardCards?: (board: string) => Promise<Card[]>;
  deployedShaFor?: (target: string) => Promise<string | null>;
  contains?: (ancestor: string, descendant: string) => Promise<boolean>;
  /** o sha "publicado" de um SELF-deploy: o HEAD do checkout de runtime que o build+restart rodou. */
  headSha?: () => Promise<string | null>;
  /** follow-up A — a medição data-only (DI de teste; default {@link measureDataOnlySettle}). */
  measureDataOnly?: (range: { base: string; head: string }) => Promise<DeployProofMeasurement>;
  write?: typeof updateCardOnDisk;
  transition?: typeof appendTransition;
  /** re-avaliação pós-avanço (notifica o board + re-deriva demandas). Injetável p/ teste. */
  reevaluate?: (board: string, cardId: string) => Promise<void>;
  now?: () => Date;
}

/**
 * O HANDLER de settle de sucesso — chamado pelo webhook durável (source "settle-webhook"), pelo onDone
 * in-process do registry (source "registry-ondone") e pela varredura por evidência (source
 * "reconcile-evidence"). SEM ESTADO EM MEMÓRIA: lê card/config/estado de deploy do disco a cada chamada —
 * obrigatório porque o settle do self-deploy do storymap chega ao PROCESSO NOVO pós-restart. A medição:
 *   - card com `commitRange` e SEM `releasedSha` ⇒ a medição data-only ({@link measureDataOnlySettle},
 *     follow-up A): ancestralidade nunca proverá (nada foi promovido) — ou o card é data-only e prova pela
 *     metade de dados em main, ou segue não-provado (fail-closed, como sempre);
 *   - card com `deployTargets` ⇒ a régua única sobre os state files ({@link measureDeployAncestry});
 *   - self-deploy (payload phase self-deploy) sem targets ⇒ a MESMA régua de ancestralidade com o sha
 *     publicado = HEAD do checkout (o build rodou dele) — target lógico "self";
 *   - nada mensurável ⇒ não provou (fail-closed; o card com código fica em Publicando p/ o watchdog).
 * Best-effort: loga e NUNCA lança (é chamado de rotas/subscribers que não podem quebrar).
 */
export async function settleDeploySuccess(
  board: string,
  cardId: string,
  opts: { source: DeployProof["source"]; selfDeploy?: boolean; deps?: SettleDeploySuccessDeps },
): Promise<DeploySettleSuccessDecision | null> {
  const d = opts.deps ?? {};
  try {
    const repoRoot = d.repoRoot ?? findRepoRoot();
    const exec = d.exec ?? defaultExec;
    const config = await (d.readConfig ?? ((b: string) => readBoardConfig(b).catch(() => null)))(board);
    if (!config) {
      console.warn(`[deploy-settle ${board}/${cardId}] board sem config — settle ignorado`);
      return null;
    }
    const cards = await (d.readBoardCards ?? readCards)(board).catch(() => [] as Card[]);
    const card = cards.find((c) => c.id === cardId);
    if (!card) return null;

    // A MEDIÇÃO (fora do lock — git/fs; o transform re-valida a base sob o lock).
    let measurement: DeployProofMeasurement | null = null;
    if (declaresCode(card)) {
      const targets = card.deployTargets?.filter(Boolean) ?? [];
      const cr = card.commitRange;
      if (!card.releasedSha?.trim() && cr?.base && cr?.head) {
        // Follow-up A — a classe-limbo: commitRange SEM releasedSha nunca prova por ancestralidade (nada foi
        // promovido). A medição data-only particiona o range com a régua do train; código presente ou medição
        // indisponível ⇒ não-provado (fail-closed, card fica em Publicando para o watchdog, como antes).
        measurement = await (d.measureDataOnly ??
          ((r: { base: string; head: string }) => measureDataOnlySettle(exec, repoRoot, r)))({
          base: cr.base,
          head: cr.head,
        });
      } else if (targets.length > 0) {
        const contains = d.contains ?? makeGitContains(exec, repoRoot);
        const deployedShaFor = d.deployedShaFor ?? ((t: string) => readLastDeploySha(repoRoot, t));
        measurement = await measureDeployAncestry(card, deployedShaFor, contains);
      } else if (opts.selfDeploy) {
        // Self-deploy: o artefato publicado É o serviço reconstruído do checkout — o sha publicado é o HEAD
        // de onde o build rodou. Janela conhecida: uma promoção que aterrisse DURANTE o build faria o HEAD
        // do settle conter código que o build não carregou; o erro é raro, corrige-se no próximo deploy e a
        // alternativa (nenhuma medição) deixaria o board do storymap sem settle NENHUM. Mesma régua, mesmo
        // `contains` — nunca uma segunda régua.
        const released = card.releasedSha?.trim();
        if (!released) {
          measurement = { proven: false, reason: "sem-released-sha" };
        } else {
          // A prova do self-deploy sai do repositório DA FERRAMENTA — é dele que o build rodou.
          // E o `contains` sai da MESMA raiz do `head`: ancestralidade só significa alguma coisa dentro
          // de UM repositório. Quando as duas árvores divergem, um `releasedSha` do alvo simplesmente
          // não é objeto conhecido aqui, `contains` devolve false, e o card fica NÃO-PROVADO para o
          // watchdog — que é o desfecho honesto, e o oposto do "No Ar" que a régua antiga carimbava.
          const raizDaFerramenta = d.toolRoot ?? findToolRoot();
          const head = await (d.headSha ??
            (async () => {
              try {
                const { stdout } = await exec("git rev-parse HEAD", { cwd: raizDaFerramenta, timeout: 15_000 });
                return String(stdout).trim() || null;
              } catch {
                return null;
              }
            }))();
          const contains = d.contains ?? makeGitContains(exec, raizDaFerramenta);
          measurement =
            head && (await contains(released, head))
              ? { proven: true, sha: released, targets: ["self"] }
              : { proven: false, reason: head ? "deploy-anterior-ao-codigo" : "alvo-sem-deploy" };
        }
      } else {
        measurement = { proven: false, reason: "sem-alvos" };
      }
    }

    const now = (d.now ?? (() => new Date()))();
    let decision: DeploySettleSuccessDecision = { next: null, advancedTo: null, stampedProof: false, heldReason: null };
    let from: string | null = null;
    await (d.write ?? updateCardOnDisk)(board, cardId, (fresh) => {
      // Guard de staleness sob o lock: se a base da medição mudou, a prova medida não fala mais deste card —
      // degrade para "não provou" (fail-closed). A base é POR TIPO de prova: ancestralidade compara
      // `releasedSha` com o sha provado; a prova data-only (follow-up A) compara o commitRange particionado
      // E exige que o card SIGA sem releasedSha (se uma promoção carimbou release no meio, a régua de
      // ancestralidade passa a mandar — nunca terminar um card com código promovido via prova de board-data).
      const staleBase =
        measurement?.proven === true &&
        (measurement.dataOnlyRange
          ? !!String(fresh.releasedSha ?? "").trim() ||
            fresh.commitRange?.base !== measurement.dataOnlyRange.base ||
            fresh.commitRange?.head !== measurement.dataOnlyRange.head
          : String(fresh.releasedSha ?? "").trim() !== measurement.sha);
      const m = staleBase
        ? ({
            proven: false,
            reason: measurement?.proven === true && measurement.dataOnlyRange ? "medicao-indisponivel" : "sem-released-sha",
          } as const)
        : measurement;
      decision = applyDeploySettleSuccess(fresh, config, m, {
        source: opts.source,
        now: now.toISOString(),
        today: now.toISOString().slice(0, 10),
        evidenceOnly: opts.source === "reconcile-evidence",
      });
      if (decision.advancedTo) from = fresh.status ?? null;
      return decision.next;
    });

    if (decision.advancedTo) {
      // O hop mais importante do ledger: Publicando → No ar COM prova. actor system, nota explícita.
      void (d.transition ?? appendTransition)({
        board,
        cardId,
        from,
        to: decision.advancedTo,
        actor: "system",
        note: `deploy:settled:${opts.source}`,
      });
      const reevaluate =
        d.reevaluate ??
        (async (b: string, c: string) => {
          const { evaluateAutorunOnEntry } = await import("@/lib/notifications/server/channels/autorun-eval");
          await evaluateAutorunOnEntry(b, c);
        });
      await reevaluate(board, cardId).catch((err) =>
        console.error(`[deploy-settle ${board}/${cardId}] re-eval pós-avanço falhou:`, err instanceof Error ? err.message : err),
      );
      console.log(
        `[deploy-settle ${board}/${cardId}] prova ${decision.stampedProof ? "carimbada" : "dispensada (sem código)"} → avançou para ${decision.advancedTo} (${opts.source})`,
      );
    } else if (decision.heldReason) {
      console.warn(`[deploy-settle ${board}/${cardId}] settle ok SEM avanço: ${decision.heldReason}`);
    }
    return decision;
  } catch (err) {
    console.error(`[deploy-settle ${board}/${cardId}] settle falhou:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Varre um board e RESOLVE (open → fixed) todo `deploy-failure` cujo código está provadamente publicado.
 * Best-effort: loga e NUNCA lança (roda dentro do sweep e do settle de deploy — não pode derrubar nenhum dos dois).
 * Devolve os ids reconciliados. Barato: só cards COM o finding aberto chegam a tocar git/fs (o caso normal é zero).
 */
export async function reconcileBoardDeployFailures(
  board: string,
  deps?: { repoRoot?: string; exec?: ExecFn },
): Promise<string[]> {
  const repoRoot = deps?.repoRoot ?? findRepoRoot();
  const exec = deps?.exec ?? defaultExec;
  const contains = makeGitContains(exec, repoRoot);
  const shaCache = new Map<string, string | null>();
  const deployedShaFor = async (target: string) => {
    if (!shaCache.has(target)) shaCache.set(target, await readLastDeploySha(repoRoot, target));
    return shaCache.get(target)!;
  };

  const resolved: string[] = [];
  try {
    const cards = await readCards(board);
    for (const card of cards.filter(hasOpenDeployFailure)) {
      const verdict = await reconcileVerdict(card, deployedShaFor, contains);
      if (!verdict.resolved) continue;
      await updateCardOnDisk(board, card.id, (c) => ({
        ...c,
        findings: (c.findings ?? []).map((f) =>
          f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open"
            ? {
                ...f,
                status: "fixed" as const,
                detail:
                  `${f.detail ?? ""}\n\n[reconciliado automaticamente] O código deste card (main ${card.releasedSha?.slice(0, 8)}) ` +
                  `está contido no último deploy de ${verdict.via.join(" + ")} — ele ESTÁ no ar. O alarme era resíduo de ` +
                  `uma publicação feita fora do board (ex.: pela CLI), que não tinha como fechar o finding.`.trim(),
              }
            : f,
        ),
      })).catch(() => {});
      resolved.push(card.id);
      console.log(
        `[deploy-reconcile ${board}/${card.id}] deploy-failure RESOLVIDO por evidência — ${card.releasedSha?.slice(0, 8)} ⊆ último deploy de ${verdict.via.join(" + ")}`,
      );
    }

    // deploy-truth WS-3 — a outra metade da mesma varredura: um card ESPERANDO no passo de deploy
    // ("Publicando") cuja publicação aconteceu FORA do board (operador via CLI — não há onDone nem webhook
    // para ele) ficaria preso até o watchdog escalar. A evidência dos state files é a MESMA que fecha o
    // finding acima; com prova, o settle por evidência (source "reconcile-evidence") tem autoridade plena —
    // carimba deployProof e avança pelo caminho gatado. SEM prova, é um no-op absoluto (evidenceOnly).
    const config = await readBoardConfig(board).catch(() => null);
    if (config) {
      const cards = await readCards(board).catch(() => [] as Card[]);
      const byId = new Map(config.statuses.map((s) => [s.id, s]));
      for (const card of cards) {
        if (!isDeployStep(byId.get(card.status ?? ""))) continue;
        await settleDeploySuccess(board, card.id, {
          source: "reconcile-evidence",
          deps: { repoRoot, exec, deployedShaFor, contains },
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`[deploy-reconcile ${board}] varredura falhou:`, err instanceof Error ? err.message : err);
  }
  return resolved;
}
