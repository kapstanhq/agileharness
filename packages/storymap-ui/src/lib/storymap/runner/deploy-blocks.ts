// deploy-blocks — a CAUSA de uma publicação parada, em vez de um alarme por card.
//
// O PROBLEMA. O deploy declarado publica o pacote INTEIRO no HEAD e pode sair com 3 em toda tentativa. Sem agrupar,
// cada card que chega a «Liberar» ganha o próprio finding «Precisa de você: há unidade que só você publica» e o próprio
// relógio: um alarme e uma tentativa agendada por card — para poucas causas. Pior: o mesmo plano pode trazer regras de
// dinheiro (do dono) junto de lacunas de configuração (unidade sem classe, rosto compartilhado, unidade de outro pacote
// sem dinheiro: do SISTEMA), e um status único `needs-human` mandaria todas ao dono. E um card sem código nenhum
// carregaria a recusa do código dos outros.
//
// O QUE ESTE MÓDULO FAZ, num ponto só:
//   · decide QUEM decide cada entrada do plano (`entryVerdict`, a régua única): no modo humano, o dono (não há sistema
//     que aja sozinho); senão o que o alvo declarar; senão a regra que o board mapeia para uma classe do dono
//     (`autonomy.deployRuleClasses`) é do dono; a entrada que o alvo marcou como do dono (`owner: true`) é do dono; regra
//     ilegível, ou board sem o mapa, é do dono (fail-closed); o resto é do sistema;
//   · agrupa as entradas em CAUSAS com chave estável (`causeKey`): uma por classe do dono, uma do sistema, por pacote — e
//     as fases transitórias (frescor, promoção, deploy que falhou) também viram causa, para o Inbox e o disjuntor
//     contarem por causa e não por card;
//   · mantém o LIVRO `deploy-blocks.json` (uma linha por causa: unidades, regras, cards, quando foi vista, o card que
//     carrega o arquivo guardado) — o fato pré-computado que o Inbox lê para saber se a causa está viva (ele nunca roda
//     plano nenhum);
//   · a VARREDURA (`sweepDeployBlocks`, chamada pela reconciliação de deploy, nunca pelo coletor do Inbox): completa a
//     causa dos findings antigos (backfill), tira da fila quem não declara código, e — no máximo uma vez por board a
//     cada 15 min — re-mede o que segura (o plano em modo leitura, o preflight de frescor): a causa que sumiu é fechada
//     sem clique e solta os cards.
//
// PURO nas decisões; o IO (livro, git, plano, cascata) entra por dependência injetada.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir, findRepoRoot } from "@/lib/storymap/paths";
import { ownerClassLabel, ownerClassesOf } from "@/lib/storymap/owner-classes";
import { isBusinessOnly } from "@/lib/storymap/decision-class";
import { declaresCode } from "@/lib/storymap/gates";
import { DEPLOY_FAILURE_FINDING_ID } from "@/lib/storymap/demands";
import { terminalStatusIds } from "@/lib/storymap/views";
import type { BoardConfig, Card, DeployCause, DeployFailurePhase, Finding } from "@/lib/storymap/types";
import { ownerApprovalRequestsOf, parsePlanOutput, type DeployExit3Report, type OwnerApprovalRequest, type PlanBlockEntry } from "./deploy-proof";
// a régua dos comandos declarados em board-data (o `deploy.planCommand` vira execução) — o módulo dela não importa nada
import { authorizeDeployCommand, deployPolicyFromSettings, quoteArgv, type DeployCommandPolicy } from "./deploy-command-guard";
import type { ExecFn } from "./worktree";

type AutonomyOf = Pick<BoardConfig, "autonomy"> | null | undefined;

// ── quem decide uma entrada ─────────────────────────────────────────────────────────────────────────

export interface EntryVerdict {
  decider: "owner" | "system";
  /** a classe do dono (id, ex.: `money`), quando a regra a carrega; null quando não há (ou não se sabe). */
  ownerClass: string | null;
}

/** O guard que o alvo nomeia no `why` de uma entrada marcada como do dono — o formato dele é `<guard>: <motivo>`. */
function guardNamedIn(why: string | null): string | null {
  const m = /^([A-Za-z0-9._-]+):\s/.exec(why ?? "");
  return m ? m[1] : null;
}

/** A classe do dono que a entrada carrega: a da regra, ou (entrada marcada do dono) a do guard nomeado no `why`. PURA. */
function ownerClassOfEntry(e: PlanBlockEntry, config: AutonomyOf): string | null {
  const map = config?.autonomy?.deployRuleClasses ?? {};
  if (e.rule && map[e.rule]) return map[e.rule];
  const guard = e.owner ? guardNamedIn(e.why) : null;
  return guard && map[guard] ? map[guard] : null;
}

/**
 * Há um SISTEMA que age sozinho sobre uma causa de publicação deste board? Só no só-negócio (`ultra`): é lá que a
 * recuperação do sistema roda (business-recovery.ts `runBusinessRecoveryPass`). No modo humano ninguém age — chamar a
 * causa de «trabalho do sistema» ali deixava o card parado em Liberar sem dono, com o texto «nada a fazer da sua parte».
 */
const systemActsOn = (config: AutonomyOf): boolean => isBusinessOnly(null, config);

/**
 * A RÉGUA ÚNICA de quem decide uma entrada do plano. Em ordem: (0) board em modo HUMANO ⇒ dono, sempre (como era antes
 * das causas: não há sistema que aja sozinho); (1) o que o ALVO declarar (`decider`, contrato novo) é respeitado;
 * (2) regra ilegível ⇒ dono (não saber o que segurou não pode virar «o sistema resolve»); (3) regra que o board mapeia
 * para uma classe do dono ⇒ dono, com a classe; (4) entrada que o alvo marcou como do dono (`owner: true`, hoje o
 * dinheiro casado num pacote estrangeiro) ⇒ dono; (5) board sem o mapa `autonomy.deployRuleClasses` ⇒ dono (sem ele não
 * se sabe se a regra é de dinheiro: fail-closed); (6) o resto — unidade sem classe, rosto compartilhado, unidade
 * estrangeira sem dinheiro, leitura que falhou — é lacuna de ferramenta/config: do SISTEMA. PURA.
 */
export function entryVerdict(e: PlanBlockEntry, config: AutonomyOf): EntryVerdict {
  const cls = ownerClassOfEntry(e, config);
  if (!systemActsOn(config)) return { decider: "owner", ownerClass: cls };
  if (e.decider) return { decider: e.decider, ownerClass: e.decider === "owner" ? cls : null };
  if (!e.rule) return { decider: "owner", ownerClass: null };
  if (cls) return { decider: "owner", ownerClass: cls };
  if (e.owner) return { decider: "owner", ownerClass: null };
  if (!config?.autonomy?.deployRuleClasses) return { decider: "owner", ownerClass: null };
  return { decider: "system", ownerClass: null };
}

// ── as causas ───────────────────────────────────────────────────────────────────────────────────────

/** A chave de uma causa: estável entre tentativas e entre cards (é ela que dobra N cards em UM item). PURA. */
export function causeKeyOf(pkg: string, kind: "owner" | "system" | "proof", ownerClass?: string | null): string {
  if (kind === "owner") return `${pkg}:owner:${ownerClass ?? "?"}`;
  return `${pkg}:${kind}`;
}

const uniq = (xs: Iterable<string | null | undefined>) => [...new Set([...xs].filter((x): x is string => !!x))];

/**
 * As CAUSAS de uma saída 3, já separadas por quem decide: uma por classe do dono e uma do sistema (por pacote), o dono
 * primeiro. A prova que falta é uma causa do sistema (o produtor a providencia). Saída 3 sem nada legível ⇒ UMA causa do
 * dono sem classe (fail-closed). PURA.
 */
export function deployCausesOf(report: DeployExit3Report, ctx: { pkg: string; config: AutonomyOf }): DeployCause[] {
  const { pkg } = ctx;
  const head = report.head ? { headSha: report.head } : {};
  const drift = report.driftUnits?.length ? { driftUnits: report.driftUnits } : {};
  if (report.status === "needs-proof") {
    return [
      {
        pkg,
        phase: "needs-proof",
        units: uniq(report.security.flatMap((s) => s.units)),
        rules: uniq([...report.security.flatMap((s) => s.guards), ...report.other.map((o) => o.proof)]),
        ownerClass: null,
        decider: "system",
        causeKey: causeKeyOf(pkg, "proof"),
        ...head,
        ...drift,
      },
    ];
  }
  if (report.entries.length === 0) {
    // o alvo declarou que só o sistema age, sem listar entradas: do sistema — se houver sistema que aja (só-negócio).
    // Qualquer outra saída 3 muda: do dono.
    const system = report.status === "needs-units" && systemActsOn(ctx.config);
    return [
      {
        pkg,
        phase: system ? "needs-units" : "needs-human",
        units: report.units,
        rules: report.humanRules,
        ownerClass: null,
        decider: system ? "system" : "owner",
        causeKey: causeKeyOf(pkg, system ? "system" : "owner", null),
        ...head,
        ...drift,
      },
    ];
  }
  const groups = new Map<string, { verdict: EntryVerdict; entries: PlanBlockEntry[] }>();
  for (const e of report.entries) {
    const verdict = entryVerdict(e, ctx.config);
    const key = verdict.decider === "owner" ? causeKeyOf(pkg, "owner", verdict.ownerClass) : causeKeyOf(pkg, "system");
    const g = groups.get(key) ?? { verdict, entries: [] };
    g.entries.push(e);
    groups.set(key, g);
  }
  const causes = [...groups.entries()].map(
    ([causeKey, g]): DeployCause => ({
      pkg,
      phase: g.verdict.decider === "owner" ? "needs-human" : "needs-units",
      units: uniq(g.entries.map((e) => e.unit)),
      rules: uniq(g.entries.map((e) => e.rule)),
      ownerClass: g.verdict.ownerClass,
      decider: g.verdict.decider,
      causeKey,
      // «ação manual» só quando o plano DECLAROU, em cada entrada com regra, que é do dono — nunca no fail-closed
      ...(g.verdict.decider === "owner" && !g.verdict.ownerClass && systemActsOn(ctx.config) && g.entries.every((e) => !!e.rule && (e.owner || e.decider === "owner"))
        ? { declaredManual: true }
        : {}),
      ...head,
      ...drift,
    }),
  );
  // o dono primeiro (classe nomeada antes da sem classe, em ordem estável); o sistema por último
  const rank = (c: DeployCause) => (c.decider === "owner" ? (c.ownerClass ? 0 : 1) : 2);
  return causes.sort((a, b) => rank(a) - rank(b) || a.causeKey.localeCompare(b.causeKey));
}

/** A causa que responde «quem precisa agir para este card andar»: a do dono, se houver; senão a do sistema. PURA. */
export function dominantCause(causes: readonly DeployCause[]): DeployCause | null {
  return causes[0] ?? null;
}

/** Os arquivos que as entradas DO DONO guardam — os que o item do dono atribui a um card. PURA. */
export function guardedOwnerFiles(report: DeployExit3Report, config: AutonomyOf): string[] {
  return uniq(report.entries.filter((e) => entryVerdict(e, config).decider === "owner").map((e) => e.file));
}

/** O que o revert sabe de uma falha de publicação — o suficiente para nomear a causa. */
export interface FailureFacts {
  phase?: DeployFailurePhase;
  pkg?: string;
  /** a saída 3 lida do log (needs-human/needs-units/needs-proof). */
  plan?: DeployExit3Report;
  /** legado (sem o relatório inteiro): as regras e as unidades que pediram alguém. */
  humanRules?: string[];
  units?: string[];
}

/**
 * A causa de UMA falha de publicação, de qualquer fase. As da saída 3 vêm das entradas do plano (a dominante — o dono
 * primeiro); as transitórias são do sistema e têm chave por pacote (frescor, deploy que falhou, rosto velho) ou por card
 * (a promoção, que é do diff dele). PURA.
 */
export function failureCause(facts: FailureFacts, ctx: { board: string; cardId: string; config: AutonomyOf }): DeployCause {
  const pkg = facts.pkg || ctx.board;
  const phase: DeployFailurePhase = facts.phase ?? "deploy";
  if (phase === "needs-human" || phase === "needs-units" || phase === "needs-proof") {
    const report: DeployExit3Report = facts.plan ?? {
      status: phase,
      head: null,
      units: facts.units ?? [],
      humanRules: facts.humanRules ?? [],
      // sem o relatório inteiro, cada regra vira uma entrada (sem unidade): a régua decide por ela do mesmo jeito
      entries: (facts.humanRules ?? []).map((rule) => ({ unit: null, file: null, rule, why: null, owner: false, decider: null })),
      driftUnits: null,
      security: [],
      other: [],
    };
    const cause = dominantCause(deployCausesOf(report, { pkg, config: ctx.config }));
    if (cause) return cause;
  }
  const key = phase === "release" ? `${pkg}:release:${ctx.cardId}` : `${pkg}:${phase}`;
  return { pkg, phase, units: facts.units ?? [], rules: [], ownerClass: null, decider: "system", causeKey: key };
}

// ── o backfill (findings anteriores às causas) ──────────────────────────────────────────────────────

/** As unidades que o finding antigo de saída 3 listou («Unidade(s) que só você publica: a, b.»). PURA. */
export function unitsFromLegacyDetail(detail: string | undefined): string[] {
  const m = /Unidade\(s\) que só você publica: ([^\n]+?)\.\s/.exec(detail ?? "");
  return m ? uniq(m[1].split(",").map((u) => u.trim())) : [];
}

/** A classe do dono que o TÍTULO do finding antigo nomeou («Precisa de você — <rótulo>: …»), por id. PURA. */
export function ownerClassFromLegacyTitle(title: string | undefined, config: AutonomyOf): string | null {
  const m = /^Precisa de você — (.+?):/.exec(title ?? "");
  if (!m) return null;
  return ownerClassesOf(config).find((c) => c.label === m[1] || c.id === m[1])?.id ?? null;
}

/**
 * A causa de um finding de publicação ABERTO escrito antes de as causas existirem (sem ele o ruído antigo nunca sai).
 * Saída 3: as unidades que o finding listou, cruzadas com as entradas do último plano do pacote (o log do deploy) —
 * dali saem as regras e quem decide; sem plano que cubra essas unidades, a classe que o título nomeou ⇒ dono com ela, e
 * nada além disso ⇒ dono (fail-closed: o título antigo não distinguia «regra sem classe» de «não li o plano»). As outras
 * fases têm a causa da fase. PURA.
 */
export function backfillDeployCause(
  finding: Pick<Finding, "deployPhase" | "title" | "detail">,
  ctx: { board: string; cardId: string; deployTargets?: string[]; config: AutonomyOf; lastPlan?: DeployExit3Report | null },
): DeployCause {
  const phase: DeployFailurePhase = finding.deployPhase ?? "deploy";
  const pkg = ctx.deployTargets?.[0] || ctx.board;
  if (phase !== "needs-human" && phase !== "needs-units") return failureCause({ phase, pkg }, ctx);
  const units = unitsFromLegacyDetail(finding.detail);
  const plan = ctx.lastPlan;
  if (plan && units.length) {
    const entries = plan.entries.filter((e) => e.unit && units.includes(e.unit));
    const covered = new Set(entries.map((e) => e.unit));
    if (entries.length && units.every((u) => covered.has(u))) {
      const cause = dominantCause(deployCausesOf({ ...plan, entries }, { pkg, config: ctx.config }));
      if (cause) return cause;
    }
  }
  const cls = ownerClassFromLegacyTitle(finding.title, ctx.config);
  return { pkg, phase: "needs-human", units, rules: [], ownerClass: cls, decider: "owner", causeKey: causeKeyOf(pkg, "owner", cls) };
}

// ── atribuição: o card que carrega o arquivo guardado ───────────────────────────────────────────────

/**
 * Os cards (ids) cujo diff toca algum arquivo guardado — o que carrega MAIS arquivos guardados primeiro (é para ele que o
 * item do dono aponta; exemplo: um card que carregava 4 dos 4 arquivos guardados, outro que tocava 1), empate na ordem
 * dada. PURA.
 */
export function attributeGuardedFiles(guarded: readonly string[], filesByCard: ReadonlyMap<string, readonly string[]>): string[] {
  const set = new Set(guarded);
  return [...filesByCard]
    .map(([id, files], i) => ({ id, i, hits: new Set(files.filter((f) => set.has(f))).size }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .map((x) => x.id);
}

/** Um sha de commit (abreviado ou inteiro, SHA-1 ou SHA-256) — só hexadecimal: nada que um shell expanda, nada que o git leia como opção. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/**
 * O `git diff --name-only` do intervalo de um card, ou null quando `base`/`head` não são sha. O `commitRange` é
 * BOARD-DATA (um agente o escreve no worktree, o train o integra, `coerceCommitRange` só apara) e este comando roda num
 * shell, sem clique, no processo do serviço — `$(…)` ou crase no intervalo seria executado (aspas duplas não protegem).
 * Board-data que vira execução passa por uma régua (como os comandos de deploy declarados); a deste é: só sha. PURA.
 */
export function commitRangeDiffCommand(range: { base: string; head: string }): string | null {
  return COMMIT_SHA.test(range.base) && COMMIT_SHA.test(range.head) ? `git diff --name-only ${range.base} ${range.head}` : null;
}

/**
 * Os cards do board cujo `commitRange` contém um arquivo guardado — para o item do dono apontar o card que carrega a
 * mudança (sem isso, o pedido de dinheiro podia aparecer em cards sem relação com o arquivo guardado). Só stories com intervalo de shas e fora do terminal (as que podem ter código ainda não no ar).
 * Best-effort: intervalo que não é sha ou git que falha deixa o card de fora. Nunca lança.
 */
export async function attributeOwnerFiles(
  guarded: readonly string[],
  cards: readonly Card[],
  config: Pick<BoardConfig, "statuses">,
  io: { exec: ExecFn; repoRoot: string },
): Promise<string[]> {
  if (!guarded.length) return [];
  const terminal = terminalStatusIds(config as BoardConfig);
  const filesByCard = new Map<string, string[]>();
  for (const c of cards) {
    const r = c.commitRange;
    if (c.type !== "story" || !r?.base || !r?.head || (c.status && terminal.has(c.status))) continue;
    const cmd = commitRangeDiffCommand(r);
    if (!cmd) continue;
    try {
      const { stdout } = await io.exec(cmd, { cwd: io.repoRoot, timeout: 20_000 });
      filesByCard.set(c.id, String(stdout).split("\n").map((l) => l.trim()).filter(Boolean));
    } catch {
      /* intervalo podado/inalcançável: o card fica de fora */
    }
  }
  return attributeGuardedFiles(guarded, filesByCard);
}

// ── o livro (deploy-blocks.json) ────────────────────────────────────────────────────────────────────

/** Uma causa viva de parada de publicação, por board. */
export interface DeployBlockRow {
  board: string;
  causeKey: string;
  pkg: string;
  phase: DeployFailurePhase;
  decider: "owner" | "system";
  ownerClass: string | null;
  units: string[];
  rules: string[];
  /** o comando de publicação declarado do board (de onde a causa foi vista). */
  command: string | null;
  firstAt: string;
  /** a última vez que a causa foi VISTA (uma falha registrada ou o plano que a confirmou). */
  lastAt: string;
  /** os cards que ela segura agora. */
  cardIds: string[];
  /** o HEAD do plano que a viu por último. */
  planHead: string | null;
  /** o card cujo diff carrega o arquivo guardado (só causa do dono). */
  attributedCard: string | null;
  /**
   * As autorizações que o plano pede ao dono para ESTA causa (deploy-proof.ts {@link OwnerApprovalRequest}) — o que o
   * Inbox precisa para pôr o botão «Autorizar publicar» na frente dele. Mora só aqui, uma vez por causa (e não no aviso
   * de cada card que a causa segura). Ausente = o plano não pediu (ou a causa não é do dono).
   */
  approvals?: OwnerApprovalRequest[];
  /**
   * Os assuntos (hash) que o dono JÁ autorizou nesta causa. O pedido lido de um log de deploy ANTIGO não volta a virar
   * botão para o que ele já respondeu (a varredura lê o último log do disco, e ele pode ser de antes do clique).
   */
  granted?: string[];
  /**
   * O board de cada card da linha que NÃO mora no board da linha. A linha vive no board que PUBLICA o pacote
   * ({@link publishingBoardOf}), e os cards que ela segura podem morar em qualquer board (um card movido de board leva o
   * aviso dele, não a linha). Ausente para o card do próprio board. Ver {@link cardBoardOf}.
   */
  cardBoards?: Record<string, string>;
  /**
   * Quando o sistema começou a REFAZER os pedidos desta causa (a autorização do dono foi recusada por ser de outra
   * mudança, ou o operador pediu na Esteira): o Inbox mostra «refazendo o pedido…» até o plano novo chegar — a próxima
   * leitura do plano ou do deploy do pacote o apaga, com os pedidos de agora. Ver {@link REREQUEST_WINDOW_MS}.
   */
  rerequestedAt?: string;
  /**
   * Os pedidos (hash do assunto) que o sistema JÁ SABE velhos — algum arquivo do assunto mudou na main desde o `head` do
   * pedido (auto-rerequest.ts) — e que ele não pôde refazer sozinho (o board que publica não declara `deploy.planCommand`
   * e o deploy sem card poderia publicar). Eles não viram botão «Autorizar» (autorizariam o que já mudou): o Inbox diz
   * «use Refazer os pedidos de publicação». Qualquer pedido novo (plano relido, deploy, refazer) apaga a marca.
   */
  staleApprovals?: string[];
}

/** Os pedidos da linha que ainda valem: os que o sistema não sabe velhos ({@link DeployBlockRow.staleApprovals}). PURA. */
export function freshApprovals(row: Pick<DeployBlockRow, "approvals" | "staleApprovals">): OwnerApprovalRequest[] {
  const stale = new Set(row.staleApprovals ?? []);
  return (row.approvals ?? []).filter((a) => !stale.has(a.subject.hash));
}

/** O board em que um card da linha mora (o da linha, salvo o que veio de outro board). PURA. */
export function cardBoardOf(row: Pick<DeployBlockRow, "board" | "cardBoards">, cardId: string): string {
  return row.cardBoards?.[cardId] ?? row.board;
}

/** Os boards que contribuem cards para a linha (o dela primeiro). PURA. */
export function contributorBoardsOf(row: Pick<DeployBlockRow, "board" | "cardBoards" | "cardIds">): string[] {
  return uniq([row.board, ...row.cardIds.map((id) => cardBoardOf(row, id))]);
}

/** Até quando «refazendo o pedido…» vale sem resposta: depois disso o Inbox volta a mostrar a causa como ela está. */
export const REREQUEST_WINDOW_MS = 30 * 60_000;

/** A causa está refazendo o pedido AGORA (dentro da janela)? PURA. */
export function isRerequesting(row: Pick<DeployBlockRow, "rerequestedAt">, now: number): boolean {
  const at = row.rerequestedAt ? Date.parse(row.rerequestedAt) : Number.NaN;
  return Number.isFinite(at) && now - at < REREQUEST_WINDOW_MS;
}

// ── o board que PUBLICA um pacote ───────────────────────────────────────────────────────────────────

/** O que se lê de um board para saber o que ele publica (estrutural: sem importar o roteamento do deploy). */
export interface PublisherCandidate {
  id: string;
  /** o descritor de deploy do board.yaml, se houver. */
  deploy?: { kind?: string; command?: string; description?: string } | null;
  /** o alvo do caminho legado que o `package` do board resolve (settings.yaml → deploy.targets), ou null. */
  legacyPkg?: string | null;
}

/** O board DECLARA o próprio deploy (comando ou agente) — o pacote dele é o id do board. PURA. */
export function declaresDeploy(d: PublisherCandidate["deploy"]): boolean {
  if (!d) return false;
  if (d.kind === "command" || d.kind === "agent") return true;
  return !d.kind && !!(d.command?.trim() || d.description?.trim());
}

/** O pacote que um board publica: o id (deploy declarado), o alvo legado do `package`, ou nenhum. PURA. */
export function publishedPkgOf(b: PublisherCandidate): string | null {
  if (declaresDeploy(b.deploy)) return b.id;
  return b.legacyPkg || null;
}

/**
 * O board que PUBLICA o pacote `pkg` — o board cujo deploy o declara (o descritor do board, com o id igual ao pacote, ou o
 * `package` que resolve para o alvo legado). Mais de um ⇒ o de id igual ao pacote, senão o primeiro por id (estável).
 * Nenhum ⇒ null: não há board que refaça o pedido, e quem pergunta diz isso. PURA.
 */
export function publishingBoardOf(pkg: string, boards: readonly PublisherCandidate[]): string | null {
  const matches = boards.filter((b) => publishedPkgOf(b) === pkg).map((b) => b.id);
  if (matches.length === 0) return null;
  return matches.includes(pkg) ? pkg : [...matches].sort()[0];
}

/** Quem publica cada pacote (o resolvedor que a varredura e a migração usam) e o comando declarado do board. */
export type PublisherOf = (pkg: string) => { board: string; command: string | null } | null;

/** O resolvedor de {@link PublisherOf} sobre os boards lidos. PURA. */
export function publisherResolver(boards: ReadonlyArray<PublisherCandidate>): PublisherOf {
  return (pkg) => {
    const board = publishingBoardOf(pkg, boards);
    if (!board) return null;
    const b = boards.find((x) => x.id === board);
    return { board, command: b?.deploy?.command?.trim() || null };
  };
}

/** Junta a linha `from` na `into` (a mesma causa): os cards com o board de cada um, os pedidos e o que o dono já deu. PURA. */
function mergeRowInto(into: DeployBlockRow, from: DeployBlockRow): DeployBlockRow {
  const boards: Record<string, string> = { ...(into.cardBoards ?? {}) };
  for (const id of from.cardIds) {
    const home = cardBoardOf(from, id);
    if (home !== into.board) boards[id] = home;
    else delete boards[id];
  }
  const cardIds = uniq([...into.cardIds, ...from.cardIds]);
  const kept = Object.fromEntries(Object.entries(boards).filter(([id]) => cardIds.includes(id)));
  const granted = uniq([...(into.granted ?? []), ...(from.granted ?? [])]).slice(-GRANTED_KEEP);
  const approvals = into.approvals?.length ? into.approvals : from.approvals;
  const rerequestedAt = [into.rerequestedAt, from.rerequestedAt].filter((x): x is string => !!x).sort().at(-1);
  const stale = uniq([...(into.staleApprovals ?? []), ...(from.staleApprovals ?? [])]).filter((h) => approvals?.some((a) => a.subject.hash === h));
  const { cardBoards: _a, approvals: _b, granted: _c, rerequestedAt: _d, staleApprovals: _e, ...rest } = into;
  return {
    ...rest,
    command: into.command ?? from.command,
    firstAt: [into.firstAt, from.firstAt].filter(Boolean).sort()[0] ?? into.firstAt,
    lastAt: [into.lastAt, from.lastAt].filter(Boolean).sort().at(-1) ?? into.lastAt,
    cardIds,
    attributedCard: into.attributedCard ?? from.attributedCard,
    ...(Object.keys(kept).length ? { cardBoards: kept } : {}),
    ...(approvals?.length ? { approvals } : {}),
    ...(granted.length ? { granted } : {}),
    ...(rerequestedAt ? { rerequestedAt } : {}),
    ...(stale.length ? { staleApprovals: stale } : {}),
  };
}

/** Move a linha para o board `to` (o que publica o pacote): os cards levam o board de onde vieram. PURA. */
function moveRow(row: DeployBlockRow, to: string, command: string | null): DeployBlockRow {
  const boards: Record<string, string> = {};
  for (const id of row.cardIds) {
    const home = cardBoardOf(row, id);
    if (home !== to) boards[id] = home;
  }
  const { cardBoards: _x, ...rest } = row;
  return { ...rest, board: to, command: command ?? row.command, ...(Object.keys(boards).length ? { cardBoards: boards } : {}) };
}

/**
 * A MIGRAÇÃO: cada linha vai para o board que PUBLICA o pacote dela (quando há um, e é outro) — juntando-se à linha da
 * mesma causa que já estiver lá. É o que leva de volta a linha que nasceu no board de um card movido (um board sem deploy,
 * onde o pedido não tinha quem o refizesse nem o Inbox certo). Devolve o que moveu, para o registro. PURA.
 */
export function relocateDeployBlocks(
  rows: readonly DeployBlockRow[],
  publisherOf: PublisherOf,
): { rows: DeployBlockRow[]; moved: Array<{ causeKey: string; from: string; to: string; cards: number }> } {
  const moved: Array<{ causeKey: string; from: string; to: string; cards: number }> = [];
  let out: DeployBlockRow[] = [...rows];
  for (const row of rows) {
    const pub = publisherOf(row.pkg);
    if (!pub || pub.board === row.board) continue;
    const current = out.find((r) => r.board === row.board && r.causeKey === row.causeKey);
    if (!current) continue;
    out = out.filter((r) => r !== current);
    const at = out.findIndex((r) => r.board === pub.board && r.causeKey === row.causeKey);
    if (at >= 0) out[at] = mergeRowInto(out[at], current);
    else out.push(moveRow(current, pub.board, pub.command));
    moved.push({ causeKey: row.causeKey, from: row.board, to: pub.board, cards: current.cardIds.length });
  }
  return { rows: out, moved };
}

/** Quantos assuntos autorizados a linha lembra (os mais recentes). */
const GRANTED_KEEP = 40;

/**
 * Os pedidos de autorização que pertencem a UMA causa: os que cobrem alguma regra dela (um board pode ter mais de uma
 * causa do dono no mesmo plano). Causa sem regra lida ⇒ todos. PURA.
 */
export function approvalsForCause(requests: readonly OwnerApprovalRequest[] | undefined, rules: readonly string[]): OwnerApprovalRequest[] | undefined {
  if (requests === undefined) return undefined;
  if (rules.length === 0) return [...requests];
  return requests.filter((a) => a.rules.length === 0 || a.rules.some((r) => rules.includes(r)));
}

function rowFromCause(board: string, cause: DeployCause, at: string, command: string | null, cardIds: string[], approvals?: OwnerApprovalRequest[]): DeployBlockRow {
  return {
    board,
    causeKey: cause.causeKey,
    pkg: cause.pkg,
    phase: cause.phase,
    decider: cause.decider,
    ownerClass: cause.ownerClass,
    units: cause.units,
    rules: cause.rules,
    command,
    firstAt: at,
    lastAt: at,
    cardIds,
    planHead: cause.headSha ?? null,
    attributedCard: cause.attributedCardIds?.[0] ?? null,
    ...(approvals?.length ? { approvals } : {}),
  };
}

/**
 * Uma falha VISTA agora: a linha da causa é criada ou atualizada (o que a causa diz agora, `lastAt`, o card entra) e o
 * card sai de qualquer outra linha do board — um card é segurado por uma causa de cada vez; linha vazia some. PURA.
 */
export function upsertDeployBlock(
  rows: readonly DeployBlockRow[],
  input: { board: string; cardId: string; cause: DeployCause; at: string; command: string | null; approvals?: OwnerApprovalRequest[] },
): DeployBlockRow[] {
  const { board, cardId, cause, at } = input;
  // Os pedidos de autorização são os do plano de AGORA: um plano que não pede mais nada (o dono já autorizou, ou o
  // código guardado saiu) apaga os antigos; um settle sem plano legível (`undefined`) não mexe no que a linha sabia.
  const approvalsOf = (r?: DeployBlockRow) => {
    const next = cause.decider === "owner" ? (approvalsForCause(input.approvals, cause.rules) ?? r?.approvals) : undefined;
    return next?.length ? { approvals: next } : {};
  };
  const out: DeployBlockRow[] = [];
  let found = false;
  for (const r of rows) {
    if (r.board === board && r.causeKey === cause.causeKey) {
      found = true;
      const { approvals: _previous, ...rest } = r;
      // o plano de AGORA chegou (`approvals` lido): o «refazendo o pedido…» terminou, e o que se sabia velho foi substituído
      if (input.approvals !== undefined) {
        delete rest.rerequestedAt;
        delete rest.staleApprovals;
      }
      out.push({
        ...rest,
        phase: cause.phase,
        decider: cause.decider,
        ownerClass: cause.ownerClass,
        units: cause.units,
        rules: cause.rules,
        command: input.command ?? r.command,
        lastAt: at,
        cardIds: uniq([...r.cardIds, cardId]),
        planHead: cause.headSha ?? r.planHead,
        attributedCard: cause.attributedCardIds?.[0] ?? r.attributedCard,
        ...approvalsOf(r),
      });
      continue;
    }
    if (r.board === board && r.cardIds.includes(cardId)) {
      const rest = r.cardIds.filter((c) => c !== cardId);
      if (rest.length) out.push({ ...r, cardIds: rest });
      continue;
    }
    out.push(r);
  }
  if (!found) out.push(rowFromCause(board, cause, at, input.command, [cardId], approvalsOf().approvals));
  return out;
}

/**
 * O livro como PROJEÇÃO dos findings abertos dos cards do board `board`: cada causa referida por um finding aberto tem a
 * sua linha, com exatamente os cards que a referem; linha sem card some; linha nova nasce da causa. A linha mora no board
 * que PUBLICA o pacote da causa (`publisherOf`; sem um, no board do card) — e pode juntar cards de vários boards, cada um
 * com o board dele: esta projeção só refaz a CONTRIBUIÇÃO dos cards de `board`, a dos outros boards fica. É o que faz o
 * livro se curar sozinho (um card resolvido por qualquer caminho sai dele na próxima varredura). PURA.
 */
export function syncDeployBlocks(
  rows: readonly DeployBlockRow[],
  board: string,
  open: ReadonlyArray<{ cardId: string; cause: DeployCause }>,
  ctx: { at: string; command: string | null; publisherOf?: PublisherOf },
): DeployBlockRow[] {
  const homeOf = (cause: DeployCause) => ctx.publisherOf?.(cause.pkg) ?? null;
  // 1. tira de toda linha os cards DESTE board (a contribuição que esta varredura refaz) — a linha fica, por ora, mesmo
  // vazia: se a causa seguir aberta, ela é reposta com o que já sabia (pedidos, autorizações, quando nasceu)
  let out: DeployBlockRow[] = rows.map((r) => {
    if (!r.cardIds.some((id) => cardBoardOf(r, id) === board)) return r;
    const cardIds = r.cardIds.filter((id) => cardBoardOf(r, id) !== board);
    const cardBoards = Object.fromEntries(Object.entries(r.cardBoards ?? {}).filter(([id]) => cardIds.includes(id)));
    const { cardBoards: _x, ...rest } = r;
    return { ...rest, cardIds, ...(Object.keys(cardBoards).length ? { cardBoards } : {}) };
  });
  // 2. cada card aberto entra na linha da causa, no board que publica o pacote
  for (const o of open) {
    const pub = homeOf(o.cause);
    const home = pub?.board ?? board;
    let at = out.findIndex((r) => r.board === home && r.causeKey === o.cause.causeKey);
    if (at < 0 && home !== board) {
      // a linha ainda no lugar antigo (o board do card, antes da migração): ela MUDA de board com o que sabe
      const old = out.findIndex((r) => r.board === board && r.causeKey === o.cause.causeKey);
      if (old >= 0) {
        out[old] = moveRow(out[old], home, pub?.command ?? null);
        at = old;
      }
    }
    if (at < 0) {
      out.push({ ...rowFromCause(home, o.cause, ctx.at, pub?.command ?? ctx.command, []), attributedCard: null });
      at = out.length - 1;
    }
    const r = out[at];
    const cardBoards = { ...(r.cardBoards ?? {}) };
    if (board !== home) cardBoards[o.cardId] = board;
    else delete cardBoards[o.cardId];
    const { cardBoards: _x, ...rest } = r;
    out[at] = {
      ...rest,
      cardIds: uniq([...r.cardIds, o.cardId]),
      attributedCard: r.attributedCard ?? o.cause.attributedCardIds?.[0] ?? null,
      ...(Object.keys(cardBoards).length ? { cardBoards } : {}),
    };
  }
  // 3. linha sem card some
  return out.filter((r) => r.cardIds.length > 0);
}

/** A causa fechou: a linha some. PURA. */
export function dropDeployBlock(rows: readonly DeployBlockRow[], board: string, causeKey: string): DeployBlockRow[] {
  return rows.filter((r) => !(r.board === board && r.causeKey === causeKey));
}

/** O plano re-viu a causa: o que ela diz agora e quando. PURA. */
export function touchDeployBlock(rows: readonly DeployBlockRow[], board: string, cause: DeployCause, at: string, approvals?: OwnerApprovalRequest[]): DeployBlockRow[] {
  return rows.map((r) => {
    if (r.board !== board || r.causeKey !== cause.causeKey) return r;
    // O plano relido diz também o que o dono ainda deve autorizar (`undefined` = quem chamou não leu o plano: fica como estava).
    const { approvals: previous, ...rest } = r;
    // o plano relido responde o «refazendo o pedido…» (com os pedidos de agora, ou com nenhum) e substitui o que se sabia velho
    if (approvals !== undefined) {
      delete rest.rerequestedAt;
      delete rest.staleApprovals;
    }
    const done = new Set(r.granted ?? []);
    const read = approvalsForCause(approvals, cause.rules)?.filter((a) => !done.has(a.subject.hash));
    const next = cause.decider === "owner" ? (read ?? previous) : undefined;
    return { ...rest, units: cause.units, rules: cause.rules, lastAt: at, planHead: cause.headSha ?? r.planHead, ...(next?.length ? { approvals: next } : {}) };
  });
}

/**
 * As autorizações que o dono ACABOU de dar saem da linha (pelo hash do assunto): o botão some na hora, sem esperar a
 * próxima leitura do plano. Se o plano voltar a pedi-las (o código mudou), a próxima falha ou re-medição as devolve. PURA.
 */
export function grantDeployApprovals(rows: readonly DeployBlockRow[], board: string, causeKey: string, grantedHashes: readonly string[]): DeployBlockRow[] {
  const granted = new Set(grantedHashes);
  return rows.map((r) => {
    if (r.board !== board || r.causeKey !== causeKey || !r.approvals?.length) return r;
    const { approvals, ...rest } = r;
    const left = approvals.filter((a) => !granted.has(a.subject.hash));
    const remembered = uniq([...(r.granted ?? []), ...grantedHashes]).slice(-GRANTED_KEEP);
    return { ...rest, ...(left.length ? { approvals: left } : {}), granted: remembered };
  });
}

/**
 * As causas `keys` do board passam a «refazendo o pedido…» desde `at` (null = desfaz a marca), e os pedidos recusados por
 * velhos (`drop`) saem da linha — sem entrar em `granted`: o dono não os autorizou, e o plano novo pode pedi-los de novo. PURA.
 */
export function markRerequested(rows: readonly DeployBlockRow[], board: string, keys: readonly string[], at: string | null, drop: readonly string[]): DeployBlockRow[] {
  const gone = new Set(drop);
  return rows.map((r) => {
    if (r.board !== board || !keys.includes(r.causeKey)) return r;
    const { rerequestedAt: _x, approvals, staleApprovals, ...rest } = r;
    const left = (approvals ?? []).filter((a) => !gone.has(a.subject.hash));
    // o que se sabia velho e saiu da linha não precisa mais da marca; o que ficou (o refazer foi desfeito) a mantém
    const stillStale = (staleApprovals ?? []).filter((h) => left.some((a) => a.subject.hash === h));
    return { ...rest, ...(left.length ? { approvals: left } : {}), ...(at ? { rerequestedAt: at } : {}), ...(stillStale.length ? { staleApprovals: stillStale } : {}) };
  });
}

/**
 * Os pedidos `hashes` das causas `keys` do board passam a «velhos, use Refazer» (auto-rerequest.ts não pôde refazê-los
 * sozinho sem arriscar publicar): só os que a linha ainda tem; os pedidos ficam na linha (o botão do operador os refaz),
 * mas não viram «Autorizar». Idempotente. PURA.
 */
export function markApprovalsStale(rows: readonly DeployBlockRow[], board: string, keys: readonly string[], hashes: readonly string[]): DeployBlockRow[] {
  return rows.map((r) => {
    if (r.board !== board || !keys.includes(r.causeKey)) return r;
    const known = hashes.filter((h) => r.approvals?.some((a) => a.subject.hash === h));
    if (!known.length) return r;
    return { ...r, staleApprovals: uniq([...(r.staleApprovals ?? []), ...known]) };
  });
}

/**
 * O deploy do pacote `pkg` terminou (o disparado sem card — o que refaz os pedidos): a saída 3 traz os pedidos de AGORA,
 * que entram nas linhas do pacote que estavam «refazendo o pedido…» (menos o que o dono já autorizou); qualquer desfecho
 * encerra o «refazendo». `report` null = o deploy não trouxe plano legível (falhou de outro jeito): só a marca sai. PURA.
 */
export function refreshRowsAfterDeploy(rows: readonly DeployBlockRow[], pkg: string, report: Pick<DeployExit3Report, "ownerApprovals"> | null): DeployBlockRow[] {
  return rows.map((r) => {
    if (r.pkg !== pkg || !r.rerequestedAt) return r;
    const { rerequestedAt: _x, approvals: previous, staleApprovals, ...rest } = r;
    if (!report || r.decider !== "owner") return { ...rest, ...(previous?.length ? { approvals: previous } : {}), ...(staleApprovals?.length ? { staleApprovals } : {}) };
    const done = new Set(r.granted ?? []);
    const next = (approvalsForCause(report.ownerApprovals ?? [], r.rules) ?? []).filter((a) => !done.has(a.subject.hash));
    return { ...rest, ...(next.length ? { approvals: next } : {}) };
  });
}

/**
 * O pedido que a linha ainda NÃO tem, lido da última saída do deploy (o log do disco): a causa do dono registrada antes
 * de o livro guardar pedidos — ou por um settle sem plano legível — ganha o botão sem esperar a próxima tentativa de
 * publicar. Nunca sobrescreve o que a linha já sabe, nunca devolve o que o dono já autorizou. PURA.
 */
export function backfillDeployApprovals(rows: readonly DeployBlockRow[], board: string, lastPlanOf: (pkg: string) => DeployExit3Report | null | undefined): DeployBlockRow[] {
  return rows.map((r) => {
    if (r.board !== board || r.decider !== "owner" || r.approvals?.length) return r;
    const done = new Set(r.granted ?? []);
    const found = (approvalsForCause(lastPlanOf(r.pkg)?.ownerApprovals ?? [], r.rules) ?? []).filter((a) => !done.has(a.subject.hash));
    return found.length ? { ...r, approvals: found } : r;
  });
}

const VERSION = 1;

/**
 * As linhas legíveis do livro e quantas foram puladas; null = o arquivo inteiro não se lê (JSON, versão, `rows`).
 * `recovering` — o livro foi RECOMEÇADO depois de não se ler (ver {@link mutateDeployBlocks}): a lista são os boards que a
 * varredura já re-sincronizou desde então; null = o livro não está em recuperação.
 */
function readRows(raw: string): { rows: DeployBlockRow[]; skipped: number; recovering: string[] | null } | null {
  try {
    const data = JSON.parse(raw);
    if (data?.version !== VERSION || !Array.isArray(data.rows)) return null;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);
    const recovering = Array.isArray(data.recovering) ? strs(data.recovering) : null;
    const out: DeployBlockRow[] = [];
    let skipped = 0;
    for (const r of data.rows as Record<string, unknown>[]) {
      if (!r || typeof r.board !== "string" || typeof r.causeKey !== "string" || typeof r.pkg !== "string" || (r.decider !== "owner" && r.decider !== "system")) {
        skipped += 1;
        continue;
      }
      out.push({
        board: r.board,
        causeKey: r.causeKey,
        pkg: r.pkg,
        phase: (typeof r.phase === "string" ? r.phase : "deploy") as DeployFailurePhase,
        decider: r.decider,
        ownerClass: typeof r.ownerClass === "string" && r.ownerClass ? r.ownerClass : null,
        units: strs(r.units),
        rules: strs(r.rules),
        command: typeof r.command === "string" ? r.command : null,
        firstAt: String(r.firstAt ?? ""),
        lastAt: String(r.lastAt ?? ""),
        cardIds: strs(r.cardIds),
        planHead: typeof r.planHead === "string" ? r.planHead : null,
        attributedCard: typeof r.attributedCard === "string" ? r.attributedCard : null,
        ...(ownerApprovalRequestsOf(r.approvals).length ? { approvals: ownerApprovalRequestsOf(r.approvals) } : {}),
        ...(strs(r.granted).length ? { granted: strs(r.granted) } : {}),
        ...cardBoardsOf(r.cardBoards),
        ...(typeof r.rerequestedAt === "string" && r.rerequestedAt ? { rerequestedAt: r.rerequestedAt } : {}),
        ...(strs(r.staleApprovals).length ? { staleApprovals: strs(r.staleApprovals) } : {}),
      });
    }
    return { rows: out, skipped, recovering };
  } catch {
    return null;
  }
}

/** `cardBoards` lido do disco: só pares texto → texto. PURA. */
function cardBoardsOf(v: unknown): { cardBoards?: Record<string, string> } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]));
  return Object.keys(out).length ? { cardBoards: out } : {};
}

/** A leitura tolerante: só as linhas que se leem (quem só CONSULTA uma linha — nunca quem julga por ausência). */
function parseRows(raw: string): DeployBlockRow[] {
  return readRows(raw)?.rows ?? [];
}

/**
 * O livro lido com RIGOR, para quem JULGA por ele (o coletor do Inbox retira a causa que saiu do livro): null quando ele
 * não pode ser julgado — JSON quebrado, versão desconhecida, `rows` que não é lista ou uma linha ilegível. Ilegível não
 * é vazio: lido como vazio, toda causa gravada «sairia do registro».
 *
 * EM RECUPERAÇÃO (o livro foi recomeçado depois de não se ler) ele só pode ser julgado para o board que a varredura já
 * re-sincronizou: até lá as causas daquele board ainda não voltaram para o livro, e «não está no livro» não prova nada.
 * Sem `board`, um livro em recuperação não é julgável. PURA.
 */
export function parseDeployBlocks(raw: string, board?: string): DeployBlockRow[] | null {
  const read = readRows(raw);
  if (!read || read.skipped > 0) return null;
  if (read.recovering && !(board && read.recovering.includes(board))) return null;
  return read.rows;
}

/** O arquivo do livro — ao lado do disjuntor (`deploy-attempts.json`), no estado do runner. */
export function deployBlocksFile(dir: string = runnerStateDir()): string {
  return path.join(dir, "deploy-blocks.json");
}

/** Lê o livro. Ausente, ilegível ou sem diretório de estado ⇒ vazio (nunca lança). */
export async function readDeployBlocks(file?: string): Promise<DeployBlockRow[]> {
  try {
    return parseRows(await fsp.readFile(file ?? deployBlocksFile(), "utf8"));
  } catch {
    return [];
  }
}

// Uma cadeia do PROCESSO (não do módulo: o Next instancia o arquivo uma vez por camada) — a escrita é ler-mudar-gravar,
// e duas falhas que chegam juntas (o callback e o webhook do mesmo deploy) não podem perder uma linha.
const CHAIN_KEY = Symbol.for("agileharness.deploy-blocks.chain");
const holder = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;

/** Onde fica a cópia do livro que não se leu, antes de ele ser recomeçado. */
export function unreadableDeployBlocksFile(file: string = deployBlocksFile()): string {
  return `${file}.ilegivel`;
}

/**
 * O que o escritor encontrou no disco: as linhas e o estado de recuperação. Ausente ⇒ livro novo, nada a recuperar.
 * ILEGÍVEL NÃO É VAZIO: o escritor lia o que não se lê como `[]` e gravava por cima — um arquivo de versão mais
 * nova (a ferramenta voltou de versão) ou um JSON cortado era apagado em silêncio, com as autorizações que o dono já
 * tinha dado. Agora o que não se lê é GUARDADO ao lado (`.ilegivel`) antes de o livro recomeçar, e o recomeço é marcado:
 * o livro fica «em recuperação» até a varredura re-sincronizar cada board (parseDeployBlocks não o julga antes disso).
 */
async function readForWrite(file: string): Promise<{ rows: DeployBlockRow[]; recovering: string[] | null }> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { rows: [], recovering: null };
    throw err;
  }
  const read = readRows(raw);
  if (read && read.skipped === 0) return { rows: read.rows, recovering: read.recovering };
  await fsp.copyFile(file, unreadableDeployBlocksFile(file)).catch(() => {});
  console.error(
    `[deploy-blocks] o livro ${read ? `tem ${read.skipped} linha(s) que não se leem` : "não pôde ser lido (JSON, versão ou formato)"} — ` +
      `guardado em ${path.basename(unreadableDeployBlocksFile(file))} e recomeçado; a varredura o re-sincroniza por board`,
  );
  return { rows: read?.rows ?? [], recovering: [] };
}

/**
 * Muda o livro sob a cadeia: lê, aplica `fn` (PURA), grava atômico. Devolve as linhas gravadas. Nunca lança — nem quando
 * o diretório de estado não resolve: o livro acompanha o revert, e o revert tem de acontecer mesmo sem ele.
 * `swept` = a varredura acabou de re-sincronizar este board (a projeção inteira dele): num livro em recuperação, é o
 * que o torna julgável de novo para aquele board.
 */
export function mutateDeployBlocks(fn: (rows: DeployBlockRow[]) => DeployBlockRow[], fileOverride?: string, opts: { swept?: string } = {}): Promise<DeployBlockRow[]> {
  const run = (holder[CHAIN_KEY] ?? Promise.resolve()).then(async () => {
    try {
      const file = fileOverride ?? deployBlocksFile();
      const state = await readForWrite(file);
      const next = fn(state.rows);
      const recovering = state.recovering && opts.swept && !state.recovering.includes(opts.swept) ? [...state.recovering, opts.swept] : state.recovering;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ version: VERSION, rows: next, ...(recovering ? { recovering } : {}) }, null, 2), "utf8");
      await fsp.rename(tmp, file);
      return next;
    } catch (err) {
      console.error("[deploy-blocks] gravar o livro falhou:", err instanceof Error ? err.message : err);
      return [] as DeployBlockRow[];
    }
  });
  holder[CHAIN_KEY] = run.catch(() => {});
  return run;
}

// ── a re-medição (o plano em modo leitura e o preflight de frescor) ─────────────────────────────────

/** Os status do plano que dizem «nada segura a publicação agora». */
const CLEAR_PLAN_STATUSES: readonly string[] = ["nothing", "ready"];
/** Os status do plano que listam o que segura (a saída 3). */
const EXIT3_STATUSES: readonly string[] = ["needs-human", "needs-units", "needs-proof"];

/**
 * A linha é de uma causa que o plano em modo leitura RE-MEDE? Só as da régua de quem decide (needs-human/needs-units).
 * A da PROVA (needs-proof) não: o modo leitura não avalia prova (diz que a produziria), então «o plano não a lista» não
 * prova nada — e o finding needs-proof aberto é a única âncora do produtor da prova (deploy-proof-producer.ts): fechá-lo
 * deixava o card em Publicar sem produtor, sem vigia e sem item. Ela é fechada pelo produtor e pelo settle. PURA.
 */
export const isPlanCause = (r: Pick<DeployBlockRow, "phase">) => r.phase === "needs-human" || r.phase === "needs-units";

/** A linha é de uma causa que a re-medição mede (o preflight de frescor ou o plano)? Só essas morrem por ela. PURA. */
export const isRemeasured = (r: Pick<DeployBlockRow, "phase">) => r.phase === "freshness" || isPlanCause(r);

/**
 * O plano que LISTA causas consegue dizer que esta sumiu? A do dono SEM classe (`owner:?`) não: ela nasce, em geral, de
 * um revert cujo log não trouxe o plano legível (fail-closed) — «o que não se leu» não é comparável às entradas de
 * agora, e julgá-la morta porque o plano lista OUTRA causa soltava o disjuntor a cada janela (as duas fontes nunca
 * concordavam). Só o plano limpo (nothing/ready) a fecha. PURA.
 */
const representedByListingPlan = (r: Pick<DeployBlockRow, "decider" | "ownerClass">) => !(r.decider === "owner" && !r.ownerClass);

/**
 * O que o plano lido AGORA diz das causas da saída 3 do board: as que ele não lista mais estão MORTAS (a do dono sem
 * classe, só com o plano limpo); as que ele lista seguem (com o que dizem agora). Plano ilegível ou inconclusivo
 * (`refused`, erro) ⇒ nada morre (fail-closed). A linha da prova nunca entra (ver `isPlanCause`). PURA.
 */
export function judgePlanCauses(
  rows: readonly DeployBlockRow[],
  plan: { status: string; report: DeployExit3Report } | null,
  config: AutonomyOf,
): { dead: string[]; present: DeployCause[] } {
  const planRows = rows.filter(isPlanCause);
  if (!plan || planRows.length === 0) return { dead: [], present: [] };
  if (CLEAR_PLAN_STATUSES.includes(plan.status)) return { dead: planRows.map((r) => r.causeKey), present: [] };
  if (!EXIT3_STATUSES.includes(plan.status)) return { dead: [], present: [] };
  const present: DeployCause[] = [];
  for (const pkg of uniq(planRows.map((r) => r.pkg))) present.push(...deployCausesOf(plan.report, { pkg, config }));
  const alive = new Set(present.map((c) => c.causeKey));
  return { dead: planRows.filter((r) => !alive.has(r.causeKey) && representedByListingPlan(r)).map((r) => r.causeKey), present };
}

/** No máximo uma re-medição por board nesta janela (o plano lê o que está no ar em vários serviços). */
export const REMEASURE_EVERY_MS = 15 * 60_000;
const REMEASURE_KEY = Symbol.for("agileharness.deploy-blocks.remeasuredAt");
const remeasuredAt = ((globalThis as Record<symbol, unknown>)[REMEASURE_KEY] ??= new Map<string, number>()) as Map<string, number>;

/** Pode re-medir este board agora? Reserva a janela quando sim. */
export function claimRemeasure(board: string, now: number): boolean {
  const last = remeasuredAt.get(board);
  if (last != null && now - last < REMEASURE_EVERY_MS) return false;
  remeasuredAt.set(board, now);
  return true;
}

/** Só para teste: esquece as janelas. */
export function resetRemeasureForTest(): void {
  remeasuredAt.clear();
}

/** O que a re-medição concluiu: as causas mortas e as que o plano re-viu. */
export interface RemeasureVerdict {
  dead: string[];
  present: DeployCause[];
  /** as autorizações que o plano relido pede ao dono; ausente = o plano não foi lido nesta passada. */
  approvals?: OwnerApprovalRequest[];
}

/**
 * A re-medição de PRODUÇÃO (throttled): o preflight de frescor quando há causa de frescor; o `deploy.planCommand`
 * declarado quando há causa da saída 3. Comando declarado passa pela régua dos comandos de deploy (board-data que vira
 * execução). Nunca lança: falhou ⇒ inconclusivo.
 */
export async function remeasureBoardCauses(
  board: string,
  config: BoardConfig,
  rows: readonly DeployBlockRow[],
  io: {
    exec: ExecFn;
    repoRoot: string;
    now: number;
    /** A POLÍTICA do passo privilegiado que o alvo declarou (lançadores/receitas). Ausente ⇒ a do settings do alvo ∪ o env. */
    policy?: DeployCommandPolicy;
    /** mede AGORA, fora da janela de 15 min (o pedido refeito: a autorização recusada por velha, o botão do operador). */
    force?: boolean;
  },
): Promise<RemeasureVerdict> {
  const verdict: RemeasureVerdict = { dead: [], present: [] };
  const fresh = rows.filter((r) => r.phase === "freshness");
  const plan = rows.filter(isPlanCause);
  if (!fresh.length && !plan.length) return verdict;
  if (io.force) remeasuredAt.set(board, io.now);
  else if (!claimRemeasure(board, io.now)) return verdict;
  try {
    const { loadRunnerConfig } = await import("./config");
    const policy = io.policy ?? deployPolicyFromSettings(loadRunnerConfig().deploy);
    if (fresh.length) {
      const [{ checkDeployFreshness }, { releaseCodePrefixes }] = await Promise.all([
        import("./deploy-freshness"),
        import("./release-scope"),
      ]);
      const v = await checkDeployFreshness(
        {
          target: board,
          repoRoot: io.repoRoot,
          scope: releaseCodePrefixes(config, loadRunnerConfig().autorun.staging?.codePrefixes ?? []),
          liveShaCommands: [config.deploy?.liveShaCommand],
          policy,
          label: `causa de frescor ${board}`,
        },
        { exec: io.exec },
      );
      if (v.ok) verdict.dead.push(...fresh.map((r) => r.causeKey));
    }
    const declared = config.deploy?.planCommand?.trim();
    if (plan.length && declared) {
      const auth = authorizeDeployCommand(declared, policy);
      if (!auth.argv) {
        console.error(`[deploy-blocks ${board}] deploy.planCommand recusado pela régua dos comandos declarados — ${auth.refusal}`);
      } else {
        let stdout = "";
        try {
          stdout = (await io.exec(quoteArgv(auth.argv), { cwd: io.repoRoot, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
        } catch (err) {
          // a saída 3 é a resposta normal do plano que recusa: o stdout vem no erro
          stdout = String((err as { stdout?: unknown })?.stdout ?? "");
        }
        const parsed = parsePlanOutput(stdout);
        const judged = judgePlanCauses(plan, parsed, config);
        verdict.dead.push(...judged.dead);
        verdict.present.push(...judged.present);
        if (parsed) verdict.approvals = parsed.report.ownerApprovals ?? [];
      }
    }
  } catch (err) {
    console.error(`[deploy-blocks ${board}] re-medição falhou (inconclusiva):`, err instanceof Error ? err.message : err);
  }
  return verdict;
}

// ── a varredura ─────────────────────────────────────────────────────────────────────────────────────

/**
 * O card NÃO carrega código nenhum: nem intervalo de commits nem código staged (a régua positiva `declaresCode`, a do
 * gate), nem release carimbado, nem recibo do train de código pousado (o `stagedAt` é escrita da árvore viva e já se
 * perdeu antes — o recibo e o release provam o mesmo fato). É o card que NUNCA espera o deploy do pacote (sem isso, dois
 * cards assim carregavam a recusa do código dos outros). Na dúvida, tem código (fail-closed). PURA.
 */
export function carriesNoCode(card: Pick<Card, "id" | "type" | "stagedAt" | "commitRange" | "releasedSha" | "releasedAt">, codeLanded?: ReadonlySet<string>): boolean {
  return card.type === "story" && !declaresCode(card as Card) && !card.releasedSha?.trim() && !card.releasedAt && !codeLanded?.has(card.id);
}

/** O finding de publicação aberto do card, se houver. PURA. */
export function openDeployFailure(card: Pick<Card, "findings">): Finding | null {
  return card.findings?.find((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open") ?? null;
}

/** Fecha o finding de publicação aberto do card, com o porquê (o fato que mudou). Nada aberto ⇒ null. PURA. */
export function resolveOpenDeployFailure(card: Card, why: string, at: string): Card | null {
  if (!openDeployFailure(card)) return null;
  return {
    ...card,
    findings: (card.findings ?? []).map((f) =>
      f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open"
        ? { ...f, status: "fixed" as const, statusBy: "system:causa-encerrada", statusAt: at, detail: `${f.detail ?? ""}\n\n[fechado automaticamente] ${why}`.trim() }
        : f,
    ),
  };
}

/** O título do pedido ao DONO: a decisão que espera, na classe de negócio quando há — nunca «só você publica». PURA. */
export function ownerTitleOf(ownerClassLabel: string | null | undefined, declaredManual = false): string {
  if (ownerClassLabel) return `Precisa de você — ${ownerClassLabel}: a publicação espera a sua decisão`;
  // Sem classe, dois casos que não podem ter o mesmo texto: o plano DECLAROU uma parte manual (unidade sem classe
  // automática, aceite manual) — aí é ação, não decisão de negócio; ou o sistema NÃO CONSEGUIU classificar (fail-closed:
  // sem regra, sem tabela de classes, saída ilegível) — aí ele não sabe o que é, e o texto não pode tranquilizar.
  return declaredManual
    ? "Precisa de você: uma parte da publicação só uma pessoa faz (ação manual, não é decisão de negócio)"
    : "Precisa de você: o sistema não conseguiu classificar o que segurou a publicação — confira o que sobe antes de liberar";
}

/**
 * O finding antigo ganha a causa. Quando a régua diz que a causa é do SISTEMA, ele deixa de dizer «Precisa de você»: a
 * fase vira `needs-units` e o texto é o do sistema (`text`); a receita «publique à mão» do alvo sai. Quando é do DONO,
 * o título passa a nomear a decisão (`ownerTitle`) em vez de «há unidade que só você publica». PURA.
 */
export function withBackfilledCause(
  finding: Finding,
  cause: DeployCause,
  text: (cause: DeployCause) => Pick<Finding, "title" | "detail">,
  ownerTitle?: string,
): Finding {
  const next: Finding = { ...finding, deployCause: cause };
  if (finding.deployPhase === "needs-human" && cause.decider === "owner" && ownerTitle) return { ...next, title: ownerTitle };
  if (finding.deployPhase === "needs-human" && cause.decider === "system") {
    const t = text(cause);
    const rewritten: Finding = { ...next, deployPhase: "needs-units", title: t.title, detail: t.detail };
    delete rewritten.suggestion; // a receita do alvo dizia «só você publica»: num item do sistema ela mente
    return rewritten;
  }
  return next;
}

export interface DeployBlocksSweepDeps {
  readConfig(board: string): Promise<BoardConfig | null>;
  readCards(board: string): Promise<Card[]>;
  write(board: string, cardId: string, fn: (card: Card) => Card | null): Promise<unknown>;
  /** a última saída 3 do pacote (o log do deploy), para o backfill ler as regras. */
  lastPlan(pkg: string): Promise<DeployExit3Report | null>;
  /** `releaseCause` devolve null quando RECUSA soltar (a linha já passou do teto depois da chance da borda). */
  breaker: { adoptCard(board: string, cardId: string, causeKey: string, phase: string): Promise<unknown>; forget(board: string, cardId: string): Promise<void>; releaseCause(board: string, causeKey: string): Promise<string[] | null> } | null;
  /** os cards do board com recibo do train de código pousado (landings.jsonl) — prova de código sem `stagedAt`. */
  codeLanded(board: string): Promise<ReadonlySet<string>>;
  /** `swept` = a projeção inteira deste board acabou de ser gravada (ver {@link mutateDeployBlocks}). */
  mutateBlocks(fn: (rows: DeployBlockRow[]) => DeployBlockRow[], opts?: { swept?: string }): Promise<DeployBlockRow[]>;
  remeasure(board: string, config: BoardConfig, rows: readonly DeployBlockRow[]): Promise<RemeasureVerdict>;
  reevaluate(board: string, cardId: string): Promise<void>;
  /** os cards cujo diff carrega os arquivos guardados (atribuição da causa do dono — git diff dos intervalos). */
  attribute(guarded: readonly string[], cards: readonly Card[], config: BoardConfig): Promise<string[]>;
  /** o texto do finding de uma causa do sistema (o mesmo do revert — deploy-revert.ts). */
  systemText(cause: DeployCause, today: string): Pick<Finding, "title" | "detail">;
  /** quem publica cada pacote (a linha mora lá — {@link publishingBoardOf}). Ausente ⇒ a linha fica no board do card. */
  publishers?(): Promise<PublisherOf>;
  now(): number;
}

export interface DeployBlocksSweepReport {
  backfilled: string[];
  noCode: string[];
  closedCauses: string[];
  resolved: string[];
}

/**
 * A VARREDURA de um board (dentro da reconciliação de deploy). Em ordem:
 *   1. card SEM código com finding de publicação aberto ⇒ o finding fecha (não há o que publicar), o disjuntor o esquece
 *      e a cascata o reavalia — o passo de publicar o assenta por evidência (entry-effects.ts), sem rodar deploy;
 *   2. finding aberto sem causa ⇒ backfill (a causa, a fase pela régua, o texto do sistema) e o card passa a ser
 *      segurado pela linha da causa no disjuntor;
 *   3. o livro vira a projeção dos findings abertos;
 *   4. re-medição (no máximo 1 a cada 15 min por board): causa morta ⇒ a linha do disjuntor vence agora (a re-tentativa
 *      leva os cards), os findings dela fecham e a linha do livro some — salvo se o disjuntor recusar soltar (passou do
 *      teto); causa re-vista ⇒ a linha atualiza. A prova (needs-proof) nunca morre aqui: é do produtor da prova.
 * Nunca lança (roda dentro de outra varredura).
 */
export async function sweepDeployBlocks(board: string, deps: DeployBlocksSweepDeps): Promise<DeployBlocksSweepReport> {
  const report: DeployBlocksSweepReport = { backfilled: [], noCode: [], closedCauses: [], resolved: [] };
  try {
    const config = await deps.readConfig(board);
    if (!config) return report;
    const cards = await deps.readCards(board);
    const nowMs = deps.now();
    const iso = new Date(nowMs).toISOString();
    const today = iso.slice(0, 10);
    const plans = new Map<string, DeployExit3Report | null>();
    const planOf = async (pkg: string) => {
      if (!plans.has(pkg)) plans.set(pkg, await deps.lastPlan(pkg).catch(() => null));
      return plans.get(pkg) ?? null;
    };
    // a atribuição da causa do DONO (o card que carrega o arquivo guardado), uma vez por causa nesta passada
    const attributions = new Map<string, string[]>();
    const attributionOf = async (cause: DeployCause, plan: DeployExit3Report | null) => {
      if (cause.decider !== "owner" || !plan) return [];
      if (!attributions.has(cause.causeKey)) attributions.set(cause.causeKey, await deps.attribute(guardedOwnerFiles(plan, config), cards, config).catch(() => []));
      return attributions.get(cause.causeKey)!;
    };
    const open: Array<{ cardId: string; cause: DeployCause }> = [];
    let landed: ReadonlySet<string> | null = null;
    for (const card of cards) {
      const f = openDeployFailure(card);
      if (!f) continue;
      if (card.type === "story" && !declaresCode(card)) landed ??= await deps.codeLanded(board).catch(() => null);
      // recibo ilegível ⇒ não sabe ⇒ trata como código (o card segue o caminho de sempre)
      if (landed && carriesNoCode(card, landed)) {
        await deps.write(board, card.id, (c) =>
          resolveOpenDeployFailure(c, "este card não declara código (nem intervalo de commits nem código staged): não há o que publicar, e a recusa era do código de outros cards.", today),
        );
        await deps.breaker?.forget(board, card.id).catch(() => {});
        report.noCode.push(card.id);
        continue;
      }
      if (f.deployCause) {
        open.push({ cardId: card.id, cause: f.deployCause });
        continue;
      }
      const pkg = card.deployTargets?.[0] || board;
      const lastPlan = f.deployPhase === "needs-human" || f.deployPhase === "needs-units" ? await planOf(pkg) : null;
      const backfilled = backfillDeployCause(f, { board, cardId: card.id, deployTargets: card.deployTargets, config, lastPlan });
      const attributed = await attributionOf(backfilled, lastPlan);
      const cause: DeployCause = attributed.length ? { ...backfilled, attributedCardIds: attributed } : backfilled;
      await deps.write(board, card.id, (c) => {
        const cur = openDeployFailure(c);
        if (!cur || cur.deployCause) return null; // mudou sob o lock: a próxima varredura decide
        const ownerTitle = cause.decider === "owner" ? ownerTitleOf(cause.ownerClass ? ownerClassLabel(cause.ownerClass, config) : null, !!cause.declaredManual) : undefined;
        return { ...c, findings: c.findings.map((x) => (x === cur ? withBackfilledCause(cur, cause, (k) => deps.systemText(k, today), ownerTitle) : x)) };
      });
      await deps.breaker?.adoptCard(board, card.id, cause.causeKey, cause.phase).catch(() => {});
      open.push({ cardId: card.id, cause });
      report.backfilled.push(card.id);
    }

    // a projeção INTEIRA do board: depois dela o livro fala por este board de novo (num livro em recuperação, `swept`)
    const publisherOf = deps.publishers ? await deps.publishers().catch(() => undefined) : undefined;
    let rows = await deps.mutateBlocks((all) => syncDeployBlocks(all, board, open, { at: iso, command: config.deploy?.command ?? null, publisherOf }), { swept: board });
    // 3b. A causa do DONO sem o pedido de autorização no livro o lê da última saída do deploy do pacote (o log): é o que
    // põe «Autorizar publicar» na frente dele sem esperar a próxima tentativa de publicar (que o disjuntor pode ter parado).
    const waiting = rows.filter((r) => r.board === board && r.decider === "owner" && !r.approvals?.length);
    if (waiting.length) {
      for (const pkg of uniq(waiting.map((r) => r.pkg))) await planOf(pkg);
      if ([...plans.values()].some((p) => p?.ownerApprovals?.length)) rows = await deps.mutateBlocks((all) => backfillDeployApprovals(all, board, (pkg) => plans.get(pkg)));
    }
    const mine = rows.filter((r) => r.board === board);
    const verdict = mine.length ? await deps.remeasure(board, config, mine) : { dead: [], present: [] };
    for (const key of new Set(verdict.dead)) {
      const row = mine.find((r) => r.causeKey === key);
      // só morre pela re-medição o que ela MEDE — a linha da prova (needs-proof) pertence ao produtor da prova, que só vê
      // o card enquanto o finding dele está aberto (deploy-proof-producer.ts); fechá-la aqui o deixava sem dono.
      if (!row || !isRemeasured(row)) continue;
      // O disjuntor PRIMEIRO: se ele recusa soltar (a causa já «sumiu» antes, a chance foi dada e o deploy real recusou
      // pela mesma causa — a re-medição e o revert discordam), nada fecha: o finding segue aberto (a recuperação do
      // sistema o pega) em vez de dizer «o sistema tenta de novo» a um card que continua segurado.
      const released = deps.breaker ? await deps.breaker.releaseCause(board, key).catch(() => [] as string[]) : [];
      if (released === null) continue;
      // os cards de OUTROS boards que a linha segura (a linha mora no board que publica): o disjuntor de cada um solta, e o
      // aviso deles fecha no board deles
      for (const other of contributorBoardsOf(row).filter((b) => b !== board)) await deps.breaker?.releaseCause(other, key).catch(() => null);
      for (const cardId of row.cardIds) {
        await deps.write(cardBoardOf(row, cardId), cardId, (c) =>
          openDeployFailure(c)?.deployCause?.causeKey === key
            ? resolveOpenDeployFailure(c, `a causa sumiu na re-medição (${row.phase === "freshness" ? "o preflight de frescor passou" : "o plano da publicação não a lista mais"}) — o sistema tenta publicar de novo.`, today)
            : null,
        );
        report.resolved.push(cardId);
      }
      await deps.mutateBlocks((all) => dropDeployBlock(all, board, key));
      report.closedCauses.push(key);
    }
    const dead = new Set(verdict.dead);
    const seen = verdict.present.filter((c) => !dead.has(c.causeKey) && mine.some((r) => r.causeKey === c.causeKey));
    if (seen.length) await deps.mutateBlocks((all) => seen.reduce((acc, c) => touchDeployBlock(acc, board, c, iso, verdict.approvals), all));

    for (const cardId of report.noCode) await deps.reevaluate(board, cardId).catch(() => {});
  } catch (err) {
    console.error(`[deploy-blocks ${board}] varredura falhou:`, err instanceof Error ? err.message : err);
  }
  return report;
}

// ── o deploy LIMPO fecha as causas do plano (story-ex9601) ───────────────────────────────────────────────────
//
// A re-medição (acima) só fecha uma causa do plano quando o alvo declara `deploy.planCommand` — sem ele, uma causa do
// dono (`needs-human`) ficava no livro depois de o deploy do mesmo pacote ter passado com saída 0 («nada a publicar»
// ou publicado). Mas saída 0 do deploy declarado É a resposta que o plano daria: nada segura a publicação agora (a saída
// 3 é o contrato de «segurado»). Então o deploy limpo do pacote fecha as causas do plano dele — a mesma sequência da
// re-medição: o disjuntor solta primeiro (recusou ⇒ nada fecha), os findings dela fecham com o porquê, a linha some.
// A causa da PROVA (needs-proof) não: é do produtor da prova (ver `isPlanCause`). Um deploy de outro pacote não fecha nada.

/** As causas do plano que um deploy LIMPO do pacote `pkg` encerra. PURA. */
export function causesClosedByCleanDeploy(rows: readonly DeployBlockRow[], pkg: string): DeployBlockRow[] {
  return rows.filter((r) => isPlanCause(r) && r.pkg === pkg);
}

export interface CleanDeployCloseDeps {
  readRows(): Promise<DeployBlockRow[]>;
  write: DeployBlocksSweepDeps["write"];
  breaker: Pick<NonNullable<DeployBlocksSweepDeps["breaker"]>, "releaseCause"> | null;
  mutateBlocks(fn: (rows: DeployBlockRow[]) => DeployBlockRow[]): Promise<DeployBlockRow[]>;
  now(): number;
}

/**
 * O deploy do pacote `pkg` terminou LIMPO (saída 0, e não o «terminou em ~0s sem fazer nada» que o revert trata como
 * falha): fecha as causas do plano dele. Devolve as chaves fechadas. Nunca lança.
 */
export async function closeCausesAfterCleanDeploy(pkg: string, deps: CleanDeployCloseDeps): Promise<string[]> {
  const closed: string[] = [];
  try {
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    for (const row of causesClosedByCleanDeploy(await deps.readRows(), pkg)) {
      const released = deps.breaker ? await deps.breaker.releaseCause(row.board, row.causeKey).catch(() => [] as string[]) : [];
      if (released === null) continue; // o disjuntor recusa soltar: segue aberta, como na re-medição
      for (const other of contributorBoardsOf(row).filter((b) => b !== row.board)) await deps.breaker?.releaseCause(other, row.causeKey).catch(() => null);
      for (const cardId of row.cardIds) {
        await deps.write(cardBoardOf(row, cardId), cardId, (c) =>
          openDeployFailure(c)?.deployCause?.causeKey === row.causeKey
            ? resolveOpenDeployFailure(c, `o deploy de ${pkg} terminou bem (saída 0): nada mais segura a publicação — a causa foi encerrada.`, today)
            : null,
        );
      }
      await deps.mutateBlocks((all) => dropDeployBlock(all, row.board, row.causeKey));
      closed.push(row.causeKey);
      console.log(`[deploy-blocks ${row.board}] causa ${row.causeKey} encerrada: o deploy de ${pkg} terminou bem (saída 0) — ${row.cardIds.length} card(s) soltos`);
    }
  } catch (err) {
    console.error(`[deploy-blocks] encerrar causas após o deploy limpo de ${pkg} falhou:`, err instanceof Error ? err.message : err);
  }
  return closed;
}

/** As dependências de produção do {@link closeCausesAfterCleanDeploy}. */
export async function defaultCleanDeployCloseDeps(): Promise<CleanDeployCloseDeps> {
  const [{ updateCardOnDisk }, { tryGetPublishBreaker }] = await Promise.all([import("@/lib/storymap/write"), import("./publish-breaker")]);
  return {
    readRows: () => readDeployBlocks(),
    write: (b, c, fn) => updateCardOnDisk(b, c, fn).catch((err) => console.error(`[deploy-blocks ${b}/${c}] escrita falhou:`, err instanceof Error ? err.message : err)),
    breaker: tryGetPublishBreaker(),
    mutateBlocks: (fn) => mutateDeployBlocks(fn),
    now: Date.now,
  };
}

/** As dependências de produção da varredura (imports dinâmicos onde há ciclo: o revert e a cascata importam o mundo). */
export async function defaultDeployBlocksSweepDeps(io?: { exec?: ExecFn; repoRoot?: string }): Promise<DeployBlocksSweepDeps> {
  const [{ readBoardConfig, readCards }, { updateCardOnDisk }, { tryGetPublishBreaker }, { readDeployExit3Report }, { defaultExec }] = await Promise.all([
    import("@/lib/storymap/repo"),
    import("@/lib/storymap/write"),
    import("./publish-breaker"),
    import("./deploy-needs-human"),
    import("./worktree"),
  ]);
  const exec = io?.exec ?? defaultExec;
  const repoRoot = io?.repoRoot ?? findRepoRoot();
  return {
    codeLanded: async (b) => {
      const { readLandings } = await import("./landings");
      return new Set((await readLandings()).filter((r) => r.board === b && r.half === "code" && !!r.sha && !r.empty && !!r.cardId).map((r) => r.cardId as string));
    },
    readConfig: (b) => readBoardConfig(b).catch(() => null),
    readCards: (b) => readCards(b),
    write: (b, c, fn) => updateCardOnDisk(b, c, fn).catch((err) => console.error(`[deploy-blocks ${b}/${c}] escrita falhou:`, err instanceof Error ? err.message : err)),
    lastPlan: async (pkg) => {
      const r = await readDeployExit3Report(pkg);
      return r.status ? r : null;
    },
    breaker: tryGetPublishBreaker(),
    mutateBlocks: (fn, opts) => mutateDeployBlocks(fn, undefined, opts),
    remeasure: (b, config, rows) => remeasureBoardCauses(b, config, rows, { exec, repoRoot, now: Date.now() }),
    reevaluate: async (b, c) => {
      const { evaluateAutorunOnEntry } = await import("@/lib/notifications/server/channels/autorun-eval");
      await evaluateAutorunOnEntry(b, c);
    },
    attribute: (guarded, cards, config) => attributeOwnerFiles(guarded, cards, config, { exec, repoRoot }),
    systemText: systemTextOf,
    publishers: async () => publisherResolver(await readPublisherCandidates()),
    now: Date.now,
  };
}

/** Os boards como candidatos a publicar (o descritor de deploy e o alvo legado do `package`). Ilegível ⇒ fica de fora. */
export async function readPublisherCandidates(): Promise<PublisherCandidate[]> {
  const [{ listBoards, readBoardConfig }, { deployPkgForPackage }] = await Promise.all([import("@/lib/storymap/repo"), import("./product-deploy")]);
  const out: PublisherCandidate[] = [];
  for (const b of await listBoards().catch(() => [])) {
    const config = await readBoardConfig(b.id).catch(() => null);
    if (!config) continue;
    const legacyPkg = declaresDeploy(config.deploy) ? null : (() => {
      try {
        return deployPkgForPackage(config.package);
      } catch {
        return null;
      }
    })();
    out.push({ id: b.id, deploy: config.deploy ?? null, legacyPkg });
  }
  return out;
}

/**
 * A MIGRAÇÃO DO BOOT: as linhas que vivem num board que não publica o pacote delas (a linha que nasceu no board de um
 * card movido) voltam para o board que o publica — com uma linha no log do serviço por linha movida (o registro). Nunca
 * lança. Devolve o que moveu.
 */
export async function migrateDeployBlocksToPublishers(deps?: {
  publishers?: () => Promise<PublisherOf>;
  readRows?: () => Promise<DeployBlockRow[]>;
  mutateBlocks?: (fn: (rows: DeployBlockRow[]) => DeployBlockRow[]) => Promise<DeployBlockRow[]>;
  log?: (line: string) => void;
}): Promise<Array<{ causeKey: string; from: string; to: string; cards: number }>> {
  try {
    const publisherOf = await (deps?.publishers ?? (async () => publisherResolver(await readPublisherCandidates())))();
    // só GRAVA quando há o que mover: gravar um livro ausente o criaria vazio, e «livro vazio» retira do Inbox toda causa
    // gravada (ausente é «não sei») até a primeira varredura
    if (relocateDeployBlocks(await (deps?.readRows ?? (() => readDeployBlocks()))(), publisherOf).moved.length === 0) return [];
    let moved: Array<{ causeKey: string; from: string; to: string; cards: number }> = [];
    await (deps?.mutateBlocks ?? ((fn) => mutateDeployBlocks(fn)))((rows) => {
      const r = relocateDeployBlocks(rows, publisherOf);
      moved = r.moved;
      return r.rows;
    });
    const log = deps?.log ?? ((line: string) => console.log(line));
    for (const m of moved) {
      log(`[deploy-blocks] migração: a causa ${m.causeKey} (${m.cards} card(s)) saiu do board ${m.from} e voltou para ${m.to}, o board que publica o pacote dela`);
    }
    return moved;
  } catch (err) {
    console.error("[deploy-blocks] migração das linhas para o board que publica falhou:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * O texto de uma causa do SISTEMA (`needs-units`): diz que nada foi publicado, o que segurou (unidades e regras), que não é
 * decisão de negócio e quem cuida. Mora AQUI (e não no revert) porque a varredura e o revert escrevem o mesmo finding — e
 * este módulo não pode importar o revert (o revert o importa). PURA.
 */
export function systemTextOf(cause: DeployCause, today: string): Pick<Finding, "title" | "detail"> {
  const units = cause.units.length ? cause.units.join(", ") : null;
  const rules = cause.rules.length ? cause.rules.join(", ") : null;
  return {
    title: "Publicação parada por uma lacuna de configuração — trabalho do sistema",
    detail:
      `O deploy de ${cause.pkg} parou ANTES de publicar: nada foi publicado e produção segue exatamente como estava. ` +
      `O que segurou não é decisão de negócio` +
      (units ? ` — unidade(s): ${units}` : "") +
      (rules ? ` (regra(s) do deploy: ${rules})` : "") +
      `. É trabalho do sistema: publicar essas unidades pelo comando de deploy do alvo, por unidade, ou corrigir a configuração de classes ` +
      `de publicação; se não destravar, abre um card de conserto. Quando o plano não listar mais esta causa, o card volta a ` +
      `publicar sozinho. Nada a fazer da sua parte (${today}).`,
  };
}
