// deploy-reconcile.ts — um `deploy-failure` é uma AFIRMAÇÃO ("o código deste card pode não estar no ar"), não
// uma lápide. Este módulo a RE-VERIFICA contra a realidade publicada e a retira quando ela deixou de ser verdade.
//
// O BURACO QUE ISTO FECHA (visto em produção):
// o único caminho que fechava o finding era `resolveDeployFailureFindingOnSuccess`, chamado SÓ pelo settle do
// deploy que o PRÓPRIO board disparou, para AQUELE cardId. Quando o deploy do board falhou e o operador
// republicou à mão (o comando de deploy do alvo, no shell — que não passa pelo registry, logo não tem onDone), o
// código FOI para produção e o finding ficou `open` PARA SEMPRE. A UI, deliberadamente, não oferece "Resolver"
// nesse item (marcar resolvido sem republicar deixaria o card mentindo) — então os cards ficaram travados num
// deadlock: a única saída oferecida era re-deployar algo que já estava no ar.
//
// A saída não é um botão a mais: é parar de inferir o estado do mundo a partir de QUEM disparou o deploy e
// passar a LER o mundo. O orquestrador de deploy grava, para cada alvo, o commit em que rodou
// (o arquivo que o alvo declara em `deploy.legacy.state`, com `{target}` → `lastDeploySha`) — INDEPENDENTE de quem o
// invocou (board, MCP ou shell). Sem declaração não há evidência (null) e nada é lido por suposição de caminho.
// Se esse commit é DESCENDENTE do sha de main onde o código do card pousou (`card.releasedSha`), então aquele
// deploy necessariamente carregou o código do card: ele está no ar, e o alarme é resíduo.
//
// CONSERVADOR POR CONSTRUÇÃO: qualquer evidência ausente (sem releasedSha, sem deployTargets, sem arquivo de
// estado, git ilegível) ⇒ NÃO resolve. Um falso-negativo deixa um alarme a mais na tela; um falso-positivo faz
// o card mentir "No ar" — que é o defeito que este subsistema inteiro existe para impedir. A assimetria é
// deliberada e não deve ser "otimizada".
//
// Verdict PURO + IO injetável (git/fs), para os testes provarem a lógica sem repo, sem rede e sem deploy.

import { cardOwnerClass, isBusinessOnly } from "@/lib/storymap/decision-class";
import { isAutonomousDelivery } from "@/lib/storymap/delivery-audit";
import { ownerPublishHold } from "@/lib/storymap/owner-waiting";
import { releaseModeOf } from "@/lib/storymap/release-policy";
import { publishEntry, type SystemDecision } from "@/lib/storymap/system-decisions";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEPLOY_FAILURE_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID, isDeployStep, staleDeliveryStampSweep } from "@/lib/storymap/demands";
import { checkGate, declaresCode } from "@/lib/storymap/gates";
import { nextBuildStatus } from "@/lib/storymap/pipeline-routing";
import { resolveStaleQuestions } from "@/lib/storymap/questions";
import { supersedeStaleTerminalBlockers, upsertFinding } from "./findings";
import { findRepoRoot, findToolRoot } from "@/lib/storymap/paths";
import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { rangeLandedBySplit, shaContainedIn } from "./convergence";
import { isLiveCardFile } from "./staging";
import { appendTransition, readTransitions } from "./transitions";
import { tryGetPublishBreaker } from "./publish-breaker";
import { defaultDeployBlocksSweepDeps, sweepDeployBlocks } from "./deploy-blocks";
import { loadRunnerConfig } from "./config";
import { expandPathTemplate } from "@/lib/storymap/deploy-policy";
import { defaultExec, type ExecFn } from "./worktree";
import type { BoardConfig, Card, DeployProof, Finding } from "@/lib/storymap/types";

/**
 * O que o orquestrador de deploy grava por alvo: `lastDeploySha` (o commit em que o deploy do PACOTE inteiro rodou) e,
 * quando o alvo já o escreve, `units` — o commit no ar de CADA unidade, gravado mesmo quando o pacote não ficou todo verde.
 */
export interface DeployStateFile {
  lastDeploySha?: string;
  units?: Record<string, string> | string[];
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
 * WS-1/WS-4 (D-DT2) — A MEDIÇÃO, extraída para ser a régua ÚNICA. O card está PROVADAMENTE
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

/**
 * Cada motivo de prova ausente, em PORTUGUÊS de quem opera o board: o que aconteceu (`why`) e o que resolve
 * (`fix`). É o que o settle deixa NO CARD quando ele chega e não prova (finding {@link DEPLOY_UNPROVEN_FINDING_ID})
 * — antes o motivo só existia no log do serviço, e o Inbox mostrava o card parado como «espera sua aprovação»
 * (`codigo-sem-release`). Exaustivo sobre {@link DeployUnprovenReason}: um motivo novo
 * não compila sem a sua frase.
 */
export const DEPLOY_UNPROVEN_TEXT: Record<DeployUnprovenReason, { why: string; fix: string }> = {
  "sem-released-sha": {
    why: "o card não tem o sha de main em que o código dele entrou (a promoção não o carimbou)",
    fix: "Re-publicar: o release reconhece o código já promovido e carimba o sha; o settle então mede de novo.",
  },
  "sem-alvos": {
    why: "o card não sabe em quais alvos de deploy o código dele precisa subir",
    fix: "Re-publicar: o disparo carimba os alvos do deploy deste board no card.",
  },
  "alvo-sem-deploy": {
    why: "um dos alvos do card não tem registro do último deploy nesta máquina (a prova que o deploy grava por alvo está ausente)",
    fix: "Confirme que o deploy deste board grava a prova do alvo e Re-publique.",
  },
  "deploy-anterior-ao-codigo": {
    why: "o deploy que rodou publicou um commit que ainda não continha o código deste card (a promoção dele veio depois)",
    fix: "Re-publicar: um deploy novo parte de um main que já tem o código deste card.",
  },
  "codigo-sem-release": {
    why: "o card tem código, mas nenhum release registrou em que sha de main ele entrou — a prova não tem de onde partir",
    fix: "Re-publicar: o release reconhece o código já promovido e carimba o sha; o settle então prova.",
  },
  "board-data-nao-aterrissou": {
    why: "a parte de dados do card (o que o train leva para main) não está provadamente em main",
    fix: "Confira a integração deste card no train (recibos e merge) e Re-publique.",
  },
  "medicao-indisponivel": {
    why: "a medição da prova falhou (git não respondeu, uma ref não resolveu ou a base mudou no meio)",
    fix: "Re-publicar mede de novo; se repetir, veja o log do serviço.",
  },
};

/** O finding que o settle deixa no card quando chega e não prova — o motivo (com o código) e o conserto. PURE. */
export function buildDeployUnprovenFinding(reason: DeployUnprovenReason): Finding {
  const t = DEPLOY_UNPROVEN_TEXT[reason];
  return {
    id: DEPLOY_UNPROVEN_FINDING_ID,
    lens: "general",
    severity: "high",
    status: "open",
    title: "O deploy rodou, mas não há prova de que o código deste card está no ar",
    detail:
      `O deploy terminou OK, mas a prova de publicação não fechou: ${t.why}. (código: ${reason}) ` +
      `O card segue em Publicar — nada a aprovar aqui; o que falta é a prova.`,
    suggestion: t.fix,
  };
}

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

/**
 * O escopo POR UNIDADE de um card: as unidades com mudança que a última causa de publicação dele registrou
 * (`deployCause.driftUnits`) e o HEAD em que o plano as viu. Superconjunto das unidades que o código do card toca e que
 * não estavam no ar — é o que deixa provar o card sem esperar o pacote inteiro. null quando o card não tem. PURA.
 */
export function deployUnitScope(card: Pick<Card, "findings">): { units: string[]; headSha: string } | null {
  const f = card.findings?.find((x) => x.id === DEPLOY_FAILURE_FINDING_ID && x.deployCause?.driftUnits?.length && x.deployCause.headSha);
  return f ? { units: f.deployCause!.driftUnits!, headSha: f.deployCause!.headSha! } : null;
}

/**
 * A régua de ancestralidade. Por alvo, em ordem:
 *   · POR UNIDADE (quando o alvo grava o sha de cada unidade e o card tem escopo por unidade, num HEAD que contém o código
 *     dele): provado quando CADA unidade do escopo roda um commit que contém o código — mesmo com o estado do pacote
 *     velho (o pacote não ficava todo verde por causa de uma unidade que o card nem tocava);
 *   · senão, POR PACOTE: o último deploy do alvo inteiro rodou num commit que contém o código (a régua de sempre).
 * Unidade do escopo sem sha gravado ⇒ cai na régua do pacote (nunca «provado» por falta de dado).
 */
export async function measureDeployAncestry(
  card: Pick<Card, "releasedSha" | "deployTargets"> & Partial<Pick<Card, "findings">>,
  deployedShaFor: (target: string) => Promise<string | null>,
  contains: (ancestor: string, descendant: string) => Promise<boolean>,
  unitShasFor?: (target: string) => Promise<Record<string, string> | null>,
): Promise<DeployProofMeasurement> {
  const released = card.releasedSha?.trim();
  if (!released) return { proven: false, reason: "sem-released-sha" };
  const targets = card.deployTargets?.filter(Boolean) ?? [];
  if (targets.length === 0) return { proven: false, reason: "sem-alvos" };
  const scope = unitShasFor ? deployUnitScope({ findings: card.findings ?? [] }) : null;
  const scopeHolds = scope ? await contains(released, scope.headSha) : false;

  for (const target of targets) {
    const units = scope && scopeHolds ? await unitShasFor!(target) : null;
    if (scope && units && scope.units.every((u) => !!units[u])) {
      for (const u of scope.units) if (!(await contains(released, units[u]))) return { proven: false, reason: "deploy-anterior-ao-codigo" };
      continue;
    }
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
  unitShasFor?: (target: string) => Promise<Record<string, string> | null>,
): Promise<ReconcileVerdict> {
  if (!hasOpenDeployFailure(card)) return { resolved: false, reason: "sem-finding-aberto" };
  const m = await measureDeployAncestry(card, deployedShaFor, contains, unitShasFor);
  return m.proven ? { resolved: true, via: m.targets } : { resolved: false, reason: m.reason };
}

// ── IO (best-effort, fail-CLOSED no veredito: qualquer erro vira "não sei" ⇒ não resolve) ─────────────────

/** O molde do arquivo de estado que o alvo declarou (`deploy.legacy.state`, com `{target}`), ou null quando não declarou. */
function declaredStateTemplate(): string | null {
  return loadRunnerConfig().deploy?.legacy?.state ?? null;
}

let stateUndeclaredWarned = false;

/**
 * O caminho do estado que o orquestrador de deploy DO ALVO grava — a MESMA fonte para deploy de board, MCP ou shell. Vem
 * da declaração (`template` = `deploy.legacy.state`; ausente ⇒ lê a do alvo). SEM declaração devolve null: sem evidência
 * ⇒ nunca «no ar» por acidente (a semântica conservadora deste módulo inteiro) — e avisa UMA vez qual chave declarar,
 * porque «não resolve» em silêncio parece defeito do deploy e não falta de configuração. O id do alvo é peneirado
 * (só `[a-z0-9_-]`), então `../` nunca escapa do molde.
 */
export function deployStatePath(repoRoot: string, target: string, template: string | null = declaredStateTemplate()): string | null {
  if (!template) {
    if (!stateUndeclaredWarned) {
      stateUndeclaredWarned = true;
      console.warn("[deploy-reconcile] o alvo não declarou onde o orquestrador de deploy grava o estado — declare settings.yaml → deploy.legacy.state (caminho com {target}). Sem isso nenhuma publicação é provada por ancestralidade.");
    }
    return null;
  }
  const rel = expandPathTemplate(template, target.replace(/[^a-z0-9_-]/gi, ""));
  return rel ? path.join(repoRoot, rel) : null;
}

/** O commit em que o último deploy de `target` rodou, ou null (arquivo ausente/corrompido/sem o campo/estado não declarado). */
export async function readLastDeploySha(repoRoot: string, target: string, template?: string | null): Promise<string | null> {
  try {
    const file = deployStatePath(repoRoot, target, template);
    if (!file) return null;
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as DeployStateFile;
    const sha = raw?.lastDeploySha?.trim();
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null; // sem evidência ⇒ não resolve (conservador)
  }
}

/**
 * O commit no ar de cada UNIDADE do alvo (`units` como mapa unidade → sha), ou null quando o alvo não o grava (o formato
 * antigo é uma lista de nomes, sem sha) ou o arquivo falta. Só shas com cara de sha — o resto é descartado.
 */
export async function readDeployUnitShas(repoRoot: string, target: string, template?: string | null): Promise<Record<string, string> | null> {
  try {
    const file = deployStatePath(repoRoot, target, template);
    if (!file) return null;
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as DeployStateFile;
    const u = raw?.units;
    if (!u || typeof u !== "object" || Array.isArray(u)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(u)) if (typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v.trim())) out[k] = v.trim();
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
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
// partitionPaths/os `staging.codePrefixes` declarados que roteiam a integração (`rangeLandedBySplit`, convergence.ts).
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
 *   • dados não provados (`absent`/`partial`) NA PONTA de main ⇒ a TESTEMUNHA: o recibo de dados do próprio train
 *     para este card (landings.jsonl). Vale quando (a) main ainda contém aquele commit e (b) ali o entregável do
 *     card estava em main EXATAMENTE como o card o produziu. Commits posteriores de outros cards nos mesmos
 *     arquivos não desfazem uma entrega — sem a testemunha, um card cujos arquivos foram tocados depois nunca mais
 *     provava e ficava em «Publicando» para sempre (os scripts de deploy do alvo mexidos várias vezes
 *     depois da integração). Sem recibo, ou com recibo que não confere ⇒ `board-data-nao-aterrissou` (segue preso).
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
    /** os shas dos recibos de DADOS do train para este card, do mais novo ao mais velho (ausente ⇒ sem testemunha). */
    receiptShas?: () => Promise<string[]>;
    /** `inner` é ancestral de `outer`? (DI de teste; default = a régua única, shaContainedIn). */
    contains?: (inner: string, outer: string) => Promise<boolean>;
  } = {},
): Promise<DeployProofMeasurement> {
  const dataRef = deps.dataRef ?? "main";
  // Os cards vivos do board NÃO são o que este card entrega: o serviço os reescreve a cada transição (inclusive o settle), então
  // exigir pós-imagem idêntica deles em main é irrefutável por construção. Só o entregável é julgado.
  const rangeLanded = deps.rangeLanded ?? rangeLandedBySplit;
  const split = await rangeLanded(exec, repoRoot, { range, dataRef, ignoreDataPaths: isLiveCardFile });
  if (split.code === "unknown") return { proven: false, reason: "medicao-indisponivel" };
  if (split.code !== "n/a") return { proven: false, reason: "codigo-sem-release" };
  if (split.data === "unknown") return { proven: false, reason: "medicao-indisponivel" };
  if (split.data !== "landed") {
    const contains = deps.contains ?? (async (inner: string, outer: string) => (await shaContainedIn(exec, repoRoot, { inner, outer })) === "contained");
    let witnessed = false;
    for (const sha of await (deps.receiptShas?.() ?? Promise.resolve([])).catch(() => [] as string[])) {
      if (!(await contains(sha, dataRef).catch(() => false))) continue; // o recibo aponta um commit que main não tem mais
      const at = await rangeLanded(exec, repoRoot, { range, dataRef: sha, ignoreDataPaths: isLiveCardFile });
      if (at.code === "n/a" && at.data === "landed") {
        witnessed = true;
        break;
      }
    }
    if (!witnessed) return { proven: false, reason: "board-data-nao-aterrissou" };
  }
  const mainSha = await (deps.resolveRefSha ?? ((ref: string) => resolveRefShaDefault(exec, repoRoot, ref)))(dataRef);
  if (!mainSha) return { proven: false, reason: "medicao-indisponivel" };
  return { proven: true, sha: mainSha, targets: ["board-data"], dataOnlyRange: { base: range.base, head: range.head } };
}

/** Os recibos de DADOS do train para um card (landings.jsonl), do mais novo ao mais velho — a testemunha da medição. */
export async function dataReceiptShas(board: string, cardId: string): Promise<string[]> {
  const { readLandings } = await import("./landings");
  return (await readLandings())
    .filter((r) => r.board === board && r.cardId === cardId && r.half === "data" && typeof r.sha === "string" && !!r.sha)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((r) => r.sha as string);
}

// ── risco de deploy ESCOPADO por pacote (2 números, não a contagem do monorepo inteiro) ──────────
/** The SCOPED deploy delta: the commits that ACTUALLY enter a package's deploy since `baseSha` (its
 *  last-deploy sha), as opposed to the misleading monorepo-wide count. Runs
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

/** Monorepo-wide commit count since `baseSha` — the number that overstates a package's deploy when read alone. */
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

/** The honest, LABELED deploy risk summary for a package: BOTH numbers (monorepo-wide vs what
 *  actually enters this deploy) + the scoped commit list. `deploy_plan` includes it so the operator decides
 *  informed (what enters this package vs. what the whole repo moved). Reads the package's last-deploy sha from the deploy
 *  orchestrator's state (READ-only). Never throws.
 *
 *  `declared` é o que o ALVO declarou (`deploy.legacy.scope` / `deploy.legacy.state`, ainda com `{target}`); ausente ⇒ lê a
 *  declaração do alvo. SEM escopo declarado o escopo é vazio — nenhum delta escopado é contado — e a nota diz qual chave declarar;
 *  sem estado declarado não há base (readLastDeploySha devolve null). */
export async function deployRiskSummary(
  exec: ExecFn,
  repoRoot: string,
  pkg: string,
  declared?: { scope?: readonly string[]; state?: string | null },
): Promise<{
  pkg: string;
  baseSha: string | null;
  monorepoSinceBase: number;
  scoped: { count: number; commits: { sha: string; subject: string }[] };
  note: string;
}> {
  const baseSha = await readLastDeploySha(repoRoot, pkg, declared?.state);
  // Scope = the package's OWN build path, DECLARED by the target (`deploy.legacy.scope`, expanded with the pkg id) — no
  // hardcoded layout and no per-app map (that would name product boards in this agnostic file, which agnostic-lint forbids).
  // Commits that touched ONLY a shared workspace dep aren't in this count (the note flags it); the package's own commits
  // are the primary signal that turns the monorepo-wide count into an informed number.
  const scopeTemplates = declared?.scope ?? loadRunnerConfig().deploy?.legacy?.scope ?? [];
  const scopePaths = scopeTemplates.map((t) => expandPathTemplate(t, pkg)).filter((p): p is string => !!p);
  const [monorepoSinceBase, scoped] = await Promise.all([
    monorepoDeltaCount(exec, repoRoot, baseSha ?? ""),
    scopedDeployDelta(exec, repoRoot, baseSha ?? "", scopePaths),
  ]);
  const note = baseSha
    ? `monorepo desde a base do último deploy: ${monorepoSinceBase}; entram NESTE deploy de ${pkg} (escopo: ` +
      `${scopePaths.join(", ") || "NÃO declarado — declare settings.yaml → deploy.legacy.scope"}, deps compartilhadas à parte): ${scoped.count}` +
      `${scoped.commits.length ? ` (${scoped.commits.map((c) => c.sha).join(", ")})` : ""}. A granularidade de ` +
      `publicação é a UNIDADE (imagem) — publicar leva TODOS os commits que tocaram os paths da unidade desde a ` +
      `base, não por card.`
    : `sem sha de último deploy registrado para ${pkg} — não há base para o delta escopado (o 1º deploy publica tudo).`;
  return { pkg, baseSha, monorepoSinceBase, scoped, note };
}

// ── WS-3 — o SETTLE DE SUCESSO: prova → carimbo → terminal ──────────────────────────────────
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
  /** a publicação do card está PROVADA (medida, ou o card não declara código). Separa «não avançou porque o
   *  deploy não carregou o código dele» (um deploy PRÓPRIO resolve) de «um gate segurou» (não resolve). */
  proven: boolean;
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
  if (opts.evidenceOnly && !proven && !noCode) {
    return { next: null, advancedTo: null, stampedProof: false, heldReason: null, proven: false };
  }

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

  // O MOTIVO da prova ausente vai para o card: o settle CHEGOU, então o Inbox não pode
  // dizer «settle não chegou» nem «espera sua aprovação» — diz por que a prova não fechou e o que resolve. Só no
  // passo de publicação (onde o card espera a prova) e só com medição de fato (card com código). A prova que
  // chega depois resolve o finding; o mesmo motivo de novo não reescreve o card.
  const unprovenOpen = (next.findings ?? []).find((f) => f.id === DEPLOY_UNPROVEN_FINDING_ID && f.status === "open");
  if (proven || noCode) {
    if (unprovenOpen) {
      next = {
        ...next,
        findings: (next.findings ?? []).map((f) =>
          f.id === DEPLOY_UNPROVEN_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const } : f,
        ),
      };
      changed = true;
    }
  } else if (card.type === "story" && isDeployStep(def) && measurement && !measurement.proven) {
    const f = buildDeployUnprovenFinding(measurement.reason);
    if (!unprovenOpen || unprovenOpen.detail !== f.detail || unprovenOpen.suggestion !== f.suggestion) {
      next = { ...next, findings: upsertFinding(next.findings ?? [], f) };
      changed = true;
    }
  }

  return { next: changed ? next : null, advancedTo, stampedProof, heldReason, proven: proven || noCode };
}

/** DI do {@link settleDeploySuccess} — tudo injetável para o teste nunca tocar git/fs/disco real. */
export interface SettleDeploySuccessDeps {
  repoRoot?: string;
  /** solta a linha do disjuntor deste card — o deploy passou, a causa acabou (DI de teste; default = o registro do processo). */
  clearPublishBreaker?: (board: string, cardId: string) => Promise<void>;
  /** tira SÓ este card da linha do disjuntor — ele andou por evidência, a causa pode seguir viva (DI de teste). */
  forgetPublishBreaker?: (board: string, cardId: string) => Promise<void>;
  /** A raiz do repositório DA FERRAMENTA — de onde o self-deploy tirou o build, e por isso a única
   *  de onde a prova dele pode ser tirada. Ausente ⇒ {@link findToolRoot}. Enquanto a ferramenta mora
   *  dentro do alvo as duas coincidem; quando divergem, medir o HEAD do ALVO prova um deploy que não
   *  aconteceu — era o defeito C2 do plano da inversão. */
  toolRoot?: string;
  exec?: ExecFn;
  readConfig?: (board: string) => Promise<BoardConfig | null>;
  readBoardCards?: (board: string) => Promise<Card[]>;
  deployedShaFor?: (target: string) => Promise<string | null>;
  /** o sha no ar de cada unidade do alvo (a prova por unidade); ausente ⇒ {@link readDeployUnitShas}. */
  unitShasFor?: (target: string) => Promise<Record<string, string> | null>;
  contains?: (ancestor: string, descendant: string) => Promise<boolean>;
  /** o sha "publicado" de um SELF-deploy: o HEAD do checkout de runtime que o build+restart rodou. */
  headSha?: () => Promise<string | null>;
  /** follow-up A — a medição data-only (DI de teste; default {@link measureDataOnlySettle}). */
  measureDataOnly?: (range: { base: string; head: string }) => Promise<DeployProofMeasurement>;
  write?: typeof updateCardOnDisk;
  transition?: typeof appendTransition;
  /** re-avaliação pós-avanço (notifica o board + re-deriva demandas). Injetável p/ teste. */
  reevaluate?: (board: string, cardId: string) => Promise<void>;
  /** SÓ-NEGÓCIO (política só-negócio) — registra a publicação no registro de decisões do sistema. Injetável p/ teste. */
  recordDecision?: (e: SystemDecision) => Promise<void>;
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
          ((r: { base: string; head: string }) => measureDataOnlySettle(exec, repoRoot, r, { receiptShas: () => dataReceiptShas(board, cardId) })))({
          base: cr.base,
          head: cr.head,
        });
      } else if (targets.length > 0) {
        const contains = d.contains ?? makeGitContains(exec, repoRoot);
        const deployedShaFor = d.deployedShaFor ?? ((t: string) => readLastDeploySha(repoRoot, t));
        const unitShasFor = d.unitShasFor ?? ((t: string) => readDeployUnitShas(repoRoot, t));
        measurement = await measureDeployAncestry(card, deployedShaFor, contains, unitShasFor);
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
    let decision: DeploySettleSuccessDecision = { next: null, advancedTo: null, stampedProof: false, heldReason: null, proven: false };
    let from: string | null = null;
    // o sha que estava no ar ANTES desta publicação, para o «Desfazer» (a prova anterior deste card, senão a base do
    // intervalo dele) — lido sob o lock, antes de a prova nova ser carimbada.
    let previousSha: string | null = null;
    await (d.write ?? updateCardOnDisk)(board, cardId, (fresh) => {
      previousSha = fresh.deployProof?.sha ?? fresh.commitRange?.base ?? null;
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
      // A base mudou entre a medição e o write: a medição não fala mais deste card. O motivo é esse — «a base
      // mudou no meio» (medicao-indisponivel) —, e é ele que vai para o card; «sem released sha» seria falso.
      const m = staleBase ? ({ proven: false, reason: "medicao-indisponivel" } as const) : measurement;
      decision = applyDeploySettleSuccess(fresh, config, m, {
        source: opts.source,
        now: now.toISOString(),
        today: now.toISOString().slice(0, 10),
        evidenceOnly: opts.source === "reconcile-evidence",
      });
      if (decision.advancedTo) from = fresh.status ?? null;
      return decision.next;
    });

    // O disjuntor da publicação (publish-breaker.ts). Um deploy que TERMINOU BEM (registry/webhook) — tenha a prova fechado
    // ou não; «sem prova» é o finding deploy-unproven, outra coisa — prova que a causa que segurava acabou (o deploy do
    // pacote passou): a linha inteira é SOLTA e os outros cards dela vencem agora. A varredura por EVIDÊNCIA que avançou
    // o card não prova nada sobre a causa (um card sem código ou já no ar anda mesmo com ela viva): só ele sai da linha.
    // A varredura SEM avanço roda a cada passada e não é um sucesso — mexer aí apagaria a contagem de uma tentativa em voo.
    if (opts.source !== "reconcile-evidence") {
      await (d.clearPublishBreaker ?? ((b: string, c: string) => tryGetPublishBreaker()?.clear(b, c) ?? Promise.resolve()))(board, cardId).catch(() => {});
    } else if (decision.advancedTo) {
      await (d.forgetPublishBreaker ?? ((b: string, c: string) => tryGetPublishBreaker()?.forget(b, c) ?? Promise.resolve()))(board, cardId).catch(() => {});
    }

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
      // SÓ-NEGÓCIO: a publicação é uma decisão que o sistema tomou em nome do dono — vai para o registro, com o
      // «Desfazer» (a reversão para o sha anterior) quando há um.
      const published = decision.next as Card | null;
      const sha = published?.deployProof?.sha;
      if (published && sha && isBusinessOnly(published, config)) {
        await (d.recordDecision ?? appendSystemDecision)(
          publishEntry(board, published, { sha, previousSha: previousSha && previousSha !== sha ? previousSha : null }, { at: now.toISOString(), id: newSystemDecisionId() }),
        ).catch(() => {});
      }
    } else if (decision.heldReason) {
      console.warn(`[deploy-settle ${board}/${cardId}] settle ok SEM avanço: ${decision.heldReason}`);
    }
    return decision;
  } catch (err) {
    console.error(`[deploy-settle ${board}/${cardId}] settle falhou:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── a quarta metade: o card que ESPERA em «Liberar» com o código JÁ no ar (story-ex9601) ──────────────────────
//
// O BURACO: a cascata é movida a EVENTO, e um deploy que termina sem nada a publicar não gera evento por card. Quem
// chegou a «Liberar» enquanto a publicação estava segurada (o disjuntor, uma causa do dono, o board pausado) não recebe
// outro evento — o recuo do disjuntor só re-aciona os cards da linha DELE, e a linha esgotada espera o botão. O código
// desses cards pode já estar no ar (publicado junto com outro), e o card fica em «Liberar» indefinidamente.
//
// A SAÍDA é a mesma régua do resto deste módulo — ler o mundo, não esperar o evento: um card parado no passo ANTES do
// de publicar cujo código está PROVADO no ar (a ancestralidade dos state files, a régua única) atravessa o passo de
// publicar SEM disparar deploy nenhum (não há o que publicar) e o settle por evidência o leva ao terminal pelo caminho
// gatado. Nada roda que já não rodou: por isso o RITMO do board não segura isto — pausado quer dizer «não comece
// trabalho novo», e assentar o que já está no ar não é trabalho, é corrigir o registro. O que segura:
//   · a decisão do DONO aberta no card (`ownerPublishHold`, a mesma régua que a cascata e o move_card do MCP leem): um
//     card que toca uma classe do dono e que ele não aprovou fica onde está;
//   · prova ausente (sem releasedSha, sem alvos, deploy anterior ao código, git ilegível): fica — fail-closed, como sempre;
//   · card SEM código: só no board que libera sozinho (`release.mode: auto`) — no manual, o «Publicar» é do humano;
//   · o settle que NÃO avançaria (um gate do terminal reprova): o card nem sai de «Liberar» — nunca fica parado no passo
//     de publicar sem um deploy em voo e sem o vigia armado.

/** O que a varredura decide para um card parado antes do passo de publicar. */
export type ReleaseLiveVerdict = { forward: string } | { skip: string };

/**
 * PURA — o card parado no passo ANTES do de publicar pode atravessá-lo por evidência? `measurement` é a régua de
 * ancestralidade (null = não medida: card sem código); `ownerHold` é o motivo da trava do dono (null = livre). O destino
 * é o passo de publicar; o avanço ao terminal é do settle (que esta função SIMULA para não deixar o card a meio caminho).
 */
export function releaseAlreadyLiveVerdict(
  card: Card,
  config: BoardConfig,
  measurement: DeployProofMeasurement | null,
  ownerHold: string | null,
): ReleaseLiveVerdict {
  if (card.type !== "story") return { skip: "não é story" };
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def || def.terminal || isDeployStep(def)) return { skip: "não está antes do passo de publicar" };
  const dest = nextBuildStatus(config, def.id, card);
  if (!dest || !isDeployStep(dest.status)) return { skip: "o próximo passo não é o de publicar" };
  if (ownerHold) return { skip: ownerHold };
  const noCode = !declaresCode(card);
  if (noCode) {
    if (releaseModeOf(config) !== "auto") return { skip: "card sem código num board que libera à mão — o «Publicar» é do humano" };
  } else if (measurement?.proven !== true) {
    return { skip: `código não provado no ar (${measurement && !measurement.proven ? measurement.reason : "sem medição"})` };
  }
  // simula o settle no passo de publicar: só atravessa se ele levaria o card ao terminal agora
  const sim = applyDeploySettleSuccess({ ...card, status: dest.status.id }, config, measurement, {
    source: "reconcile-evidence",
    now: new Date(0).toISOString(),
    today: "1970-01-01",
    evidenceOnly: true,
  });
  if (!sim.advancedTo) return { skip: sim.heldReason ?? "o settle não avançaria" };
  return { forward: dest.status.id };
}

/** DI da varredura de «Liberar» (os testes injetam tudo; produção usa os defaults de {@link reconcileBoardDeployFailures}). */
export interface ReleaseLiveSweepDeps {
  deployedShaFor(target: string): Promise<string | null>;
  unitShasFor(target: string): Promise<Record<string, string> | null>;
  contains(ancestor: string, descendant: string): Promise<boolean>;
  /** o dono já atravessou o passo de aprovar a entrega deste card? (o ledger de transições — delivery-audit.ts). */
  ownerApproved(board: string, card: Card, config: BoardConfig): Promise<boolean>;
  write: typeof updateCardOnDisk;
  transition: typeof appendTransition;
  settle(board: string, cardId: string): Promise<DeploySettleSuccessDecision | null>;
}

/**
 * A varredura: para cada card parado antes do passo de publicar com veredito `forward`, grava o passo de publicar sob o
 * lock (só se o card ainda está onde estava), registra a transição (`system`, nota `deploy:already-live`) e chama o
 * settle por evidência — que carimba a prova e avança ao terminal. NÃO dispara o efeito de entrada do passo de publicar
 * (o deploy): o código já está no ar. Devolve os ids que atravessaram. Nunca lança.
 */
export async function settleReleasedLiveCards(board: string, config: BoardConfig, cards: readonly Card[], d: ReleaseLiveSweepDeps): Promise<string[]> {
  const moved: string[] = [];
  for (const card of cards) {
    try {
      const def = config.statuses.find((s) => s.id === card.status);
      if (card.type !== "story" || !def || def.terminal || isDeployStep(def)) continue;
      const dest = nextBuildStatus(config, def.id, card);
      if (!dest || !isDeployStep(dest.status)) continue;
      const approved = cardOwnerClass(card) ? await d.ownerApproved(board, card, config).catch(() => false) : false;
      const hold = ownerPublishHold(card, def, dest.status, config, { ownerApproved: approved });
      const measurement = declaresCode(card) ? await measureDeployAncestry(card, d.deployedShaFor, d.contains, d.unitShasFor) : null;
      const verdict = releaseAlreadyLiveVerdict(card, config, measurement, hold);
      if (!("forward" in verdict)) continue;
      const written = await d.write(board, card.id, (fresh) => (fresh.status === card.status ? { ...fresh, status: verdict.forward } : null));
      if (!written) continue; // mudou sob o lock: a próxima passada decide
      void d.transition({ board, cardId: card.id, from: card.status ?? null, to: verdict.forward, actor: "system", note: "deploy:already-live" });
      const settled = await d.settle(board, card.id);
      moved.push(card.id);
      console.log(
        `[deploy-reconcile ${board}/${card.id}] esperava em ${card.status} com o código já no ar — ${settled?.advancedTo ? `assentado por evidência (${settled.advancedTo})` : `no passo de publicar, settle sem avanço: ${settled?.heldReason ?? "?"}`}`,
      );
    } catch (err) {
      console.error(`[deploy-reconcile ${board}/${card.id}] liberar por evidência falhou:`, err instanceof Error ? err.message : err);
    }
  }
  return moved;
}

/**
 * Varre um board e RESOLVE (open → fixed) todo `deploy-failure` cujo código está provadamente publicado.
 * Best-effort: loga e NUNCA lança (roda dentro do sweep e do settle de deploy — não pode derrubar nenhum dos dois).
 * Devolve os ids reconciliados. Barato: só cards COM o finding aberto chegam a tocar git/fs (o caso normal é zero).
 */
export async function reconcileBoardDeployFailures(
  board: string,
  deps?: { repoRoot?: string; exec?: ExecFn; sweepBlocks?: (board: string) => Promise<unknown> },
): Promise<string[]> {
  const repoRoot = deps?.repoRoot ?? findRepoRoot();
  const exec = deps?.exec ?? defaultExec;
  const contains = makeGitContains(exec, repoRoot);
  const shaCache = new Map<string, string | null>();
  const deployedShaFor = async (target: string) => {
    if (!shaCache.has(target)) shaCache.set(target, await readLastDeploySha(repoRoot, target));
    return shaCache.get(target)!;
  };
  const unitCache = new Map<string, Record<string, string> | null>();
  const unitShasFor = async (target: string) => {
    if (!unitCache.has(target)) unitCache.set(target, await readDeployUnitShas(repoRoot, target));
    return unitCache.get(target)!;
  };

  const resolved: string[] = [];
  // AS CAUSAS primeiro (deploy-blocks.ts): completa a causa dos findings antigos, tira da fila o card sem código e — no
  // máximo uma vez por board a cada 15 min — re-mede o que segura a publicação, fechando a causa que sumiu. Aqui, e
  // nunca no coletor do Inbox: o plano lê o que está no ar em vários serviços; o Inbox só lê o livro que isto grava.
  await (deps?.sweepBlocks ?? (async (b: string) => sweepDeployBlocks(b, await defaultDeployBlocksSweepDeps({ exec, repoRoot }))))(board).catch((err) =>
    console.error(`[deploy-reconcile ${board}] varredura das causas falhou:`, err instanceof Error ? err.message : err),
  );
  try {
    const cards = await readCards(board);
    for (const card of cards.filter(hasOpenDeployFailure)) {
      const verdict = await reconcileVerdict(card, deployedShaFor, contains, unitShasFor);
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

    // WS-3 — a outra metade da mesma varredura: um card ESPERANDO no passo de deploy
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
          deps: { repoRoot, exec, deployedShaFor, unitShasFor, contains },
        }).catch(() => {});
      }
      // A quarta metade (story-ex9601): quem ESPERA antes do passo de publicar com o código já no ar atravessa por
      // evidência, sem deploy (ver {@link settleReleasedLiveCards}). Relê os cards: a metade acima pode ter movido alguns.
      const fresh = await readCards(board).catch(() => [] as Card[]);
      await settleReleasedLiveCards(board, config, fresh, {
        deployedShaFor,
        unitShasFor,
        contains,
        ownerApproved: (b, c, cfg) => readTransitions({ board: b, cardId: c.id }).then((ts) => !isAutonomousDelivery(ts, cfg)),
        write: updateCardOnDisk,
        transition: appendTransition,
        settle: (b, id) => settleDeploySuccess(b, id, { source: "reconcile-evidence", deps: { repoRoot, exec, deployedShaFor, unitShasFor, contains } }),
      });
      // A terceira metade: o carimbo de disparo que ficou para trás FORA do
      // passo de publicação (o legado de antes da chokepoint de escrita — a era otimista, os cards movidos à mão).
      // Terminal com prova ⇒ o carimbo sai; terminal sem prova ⇒ uma nota informativa (registrada, fora do Inbox);
      // não terminal ⇒ a tentativa é encerrada. Aqui, e não num script avulso: é o serviço que conserta o próprio
      // estado, em toda instalação, e de novo se algum caminho fora da chokepoint voltar a vazar.
      const today = new Date().toISOString().slice(0, 10);
      for (const card of cards) {
        if (!card.deployFiredAt || isDeployStep(byId.get(card.status ?? ""))) continue;
        await updateCardOnDisk(board, card.id, (fresh) => staleDeliveryStampSweep(fresh, config, today)).catch((err) =>
          console.error(`[deploy-reconcile ${board}/${card.id}] limpar o carimbo velho falhou:`, err instanceof Error ? err.message : err),
        );
      }
    }
  } catch (err) {
    console.error(`[deploy-reconcile ${board}] varredura falhou:`, err instanceof Error ? err.message : err);
  }
  return resolved;
}
