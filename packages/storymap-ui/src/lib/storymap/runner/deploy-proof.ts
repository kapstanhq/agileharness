// A PROVA que falta para publicar — a metade `needs-proof` da saída 3 do deploy declarado (política só-negócio). PURO.
//
// O contrato do alvo (fase 3 do plano): o comando de deploy sai com 3 em DOIS casos, e a última linha JSON diz qual:
//   `status: "needs-human"` — dinheiro (cobrança, gasto novo com fornecedor ou com API paga): do DONO, como hoje;
//   `status: "needs-proof"` — falta uma PROVA para esta mudança exata; `missingProofs[]` diz qual, e a revisão de
//     segurança traz o pedido (`request: { reviewer, subject, record }`). Produzir a prova é trabalho do SISTEMA.
// Este módulo lê o relatório, monta o veredito no formato do alvo (`deploy-proof/security-review@1` — o ASSUNTO vem
// do pedido, nunca do modelo), decide o que um veredito negativo faz com o card (reabre por correção, com os
// achados), e faz o card ESPERAR a prova no passo de publicar — de onde o mesmo «Re-publicar» de sempre o leva ao ar.

import { REOPEN_KINDS, applyReopen } from "@/lib/storymap/reopen";
import { DEPLOY_FAILURE_FINDING_ID } from "@/lib/storymap/demands";
import { upsertFinding } from "./findings";
import { loadRunnerConfig } from "./config";
import { deployPolicyOf, expandArgvTemplate } from "@/lib/storymap/deploy-policy";
import type { BoardConfig, Card, Finding } from "@/lib/storymap/types";

/**
 * O que a saída 3 pede. `needs-units` é o contrato NOVO do alvo (o mesmo exit 3, por compatibilidade): só há unidades que
 * o SISTEMA publica (lacuna de classe/config) — ninguém do negócio precisa decidir. O alvo de hoje ainda não o emite: ele
 * diz `needs-human` para tudo, e quem separa dono × sistema é a régua de deploy-blocks.ts, entrada por entrada.
 */
export type Exit3Status = "needs-human" | "needs-units" | "needs-proof";

/**
 * Uma entrada do plano que segurou a publicação (`plan.human[]` do alvo), como o alvo a escreveu. É dela — e não do
 * status geral do plano — que sai QUEM decide (deploy-blocks.ts): um mesmo plano pode misturar regras de dinheiro
 * (do dono) e lacunas de configuração (do sistema), e um status único `needs-human` mandaria todas ao dono.
 */
export interface PlanBlockEntry {
  unit: string | null;
  file: string | null;
  /** a regra do alvo que segurou (um guard, ou uma regra estrutural como `unit-operator-only`); null = ilegível. */
  rule: string | null;
  why: string | null;
  /** o alvo marcou a entrada como do dono (hoje: um guard de dinheiro casado num pacote estrangeiro). */
  owner: boolean;
  /** quem decide, quando o ALVO o declara (contrato novo); null no alvo de hoje. */
  decider: "owner" | "system" | null;
  /**
   * a entrada traz um PEDIDO DE AUTORIZAÇÃO do dono legível (`ownerApproval` com assunto de diff e comando de gravação):
   * o alvo está dizendo que só o sim do dono a libera — é do dono, mesmo com a regra fora do mapa de classes do board.
   */
  asksOwnerApproval?: boolean;
}

/** O ASSUNTO de uma revisão: a mudança exata (diff base..head daqueles arquivos) ou o conteúdo exato (regras). */
export interface ProofSubject {
  kind: "diff" | "content";
  hash: string;
  base?: string;
  head?: string;
  files: string[];
}

/** Uma revisão de segurança pedida pelo deploy. `record` é o comando do alvo que grava o veredito. */
export interface SecurityReviewRequest {
  reviewer: string;
  subject: ProofSubject;
  record: string;
  units: string[];
  guards: string[];
  status: string;
  detail: string | null;
}

/**
 * A AUTORIZAÇÃO DO DONO que o deploy pede (`plan.human[].ownerApproval` do alvo): a mudança exata que espera o sim dele
 * (o diff base..head daqueles arquivos) e o comando do alvo que grava esse sim. Vem nas entradas de DINHEIRO do plano —
 * a regra é do dono, e sem a autorização gravada para ESTE diff o plano segue dizendo `needs-human`. O Inbox a transforma
 * num botão (inbox/decision.ts); o alvo é quem confere, ao gravar, que o assunto ainda é o do checkout.
 */
export interface OwnerApprovalRequest {
  subject: ProofSubject;
  /** o comando do alvo que grava a autorização, com `<approval.json>` no lugar do arquivo. */
  record: string;
  /** as unidades e as regras das entradas do plano que este pedido cobre (para o dono ler o que está autorizando). */
  units: string[];
  rules: string[];
}

/** Uma prova que falta e que não é revisão de segurança (um ensaio de rollback, um produtor que ficou vermelho). */
export interface OtherMissingProof {
  proof: string;
  status: string;
  detail: string | null;
  run?: string;
}

export interface DeployExit3Report {
  status: Exit3Status | null;
  head: string | null;
  /** needs-human: as unidades e as regras (os guards) que pediram o dono. */
  units: string[];
  humanRules: string[];
  /** as entradas do plano, uma a uma, na ordem — a matéria-prima da causa (deploy-blocks.ts). */
  entries: PlanBlockEntry[];
  /**
   * As unidades do pacote com mudança pendente no plano (`plan.units[].id`): um SUPERCONJUNTO das unidades que o código
   * de um card desse HEAD toca e que ainda não estão no ar. É o que deixa provar «no ar» por unidade (deploy-reconcile.ts).
   * null quando não vale como superconjunto: o plano não as listou, ou o rosto publicado também tem mudança (ele não é
   * unidade do pacote, e provar sem ele seria afirmar no ar um rosto velho).
   */
  driftUnits: string[] | null;
  security: SecurityReviewRequest[];
  other: OtherMissingProof[];
  /** needs-human: as autorizações que o plano pede ao dono, uma por mudança exata (ausente = o alvo não pediu nenhuma). */
  ownerApprovals?: OwnerApprovalRequest[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

function jsonLine(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function subjectOf(raw: unknown): ProofSubject | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if ((s.kind !== "diff" && s.kind !== "content") || !/^sha256:[0-9a-f]{64}$/.test(str(s.hash))) return null;
  const files = strs(s.files);
  if (!files.length) return null;
  return { kind: s.kind, hash: str(s.hash), ...(s.base ? { base: str(s.base) } : {}), ...(s.head ? { head: str(s.head) } : {}), files };
}

/**
 * Os pedidos de autorização do dono, lidos com a mesma tolerância do resto: um pedido sem assunto de DIFF completo (hash,
 * base, head, arquivos) ou sem o comando de gravação não vira botão — o dono não autoriza o que não dá para amarrar a
 * uma mudança exata. Aceita tanto as entradas do plano (`{ unit, rule, ownerApproval }`) quanto os pedidos já agrupados
 * (o que o livro de causas guarda). Um pedido por assunto; unidades e regras somadas. PURA.
 */
export function ownerApprovalRequestsOf(list: unknown): OwnerApprovalRequest[] {
  const byHash = new Map<string, OwnerApprovalRequest>();
  for (const h of Array.isArray(list) ? list : []) {
    if (!h || typeof h !== "object") continue;
    const e = h as Record<string, unknown>;
    const raw = (e.ownerApproval && typeof e.ownerApproval === "object" ? e.ownerApproval : e) as Record<string, unknown>;
    const subject = subjectOf(raw.subject);
    const record = str(raw.record).trim();
    if (!subject || subject.kind !== "diff" || !subject.base || !subject.head || !record) continue;
    const got = byHash.get(subject.hash) ?? { subject, record, units: [], rules: [] };
    for (const u of [str(e.unit), ...strs(e.units)]) if (u && !got.units.includes(u)) got.units.push(u);
    for (const r of [str(e.rule), ...strs(e.rules)]) if (r && !got.rules.includes(r)) got.rules.push(r);
    byHash.set(subject.hash, got);
  }
  return [...byHash.values()];
}

/**
 * A ÚLTIMA linha JSON do log do deploy que diz `status` needs-human/needs-proof. Tolerante (lixo e linha torta são
 * pulados) e nunca inventa: sem JSON ⇒ `status: null` (o settle trata como o dono — fail-closed). PURA.
 */
const EXIT3_STATUSES: readonly string[] = ["needs-human", "needs-units", "needs-proof"];

/** Uma entrada de `plan.human[]` lida com tolerância: string pura é só a unidade; objeto torto vira campos null. PURA. */
function planEntryOf(h: unknown): PlanBlockEntry | null {
  if (typeof h === "string") return h.trim() ? { unit: h.trim(), file: null, rule: null, why: null, owner: false, decider: null } : null;
  if (!h || typeof h !== "object") return null;
  const e = h as Record<string, unknown>;
  return {
    unit: str(e.unit) || null,
    file: str(e.file) || null,
    rule: str(e.rule) || null,
    why: str(e.why) || null,
    owner: e.owner === true,
    decider: e.decider === "owner" || e.decider === "system" ? e.decider : null,
    ...(e.ownerApproval && ownerApprovalRequestsOf([e]).length ? { asksOwnerApproval: true } : {}),
  };
}

/** As unidades com mudança pendente do plano — ou null quando não valem como superconjunto (ver o campo). PURA. */
function driftUnitsOf(plan: Record<string, unknown>): string[] | null {
  const face = plan.face && typeof plan.face === "object" ? (plan.face as Record<string, unknown>) : null;
  if (face?.affected === true) return null;
  if (!Array.isArray(plan.units)) return null;
  const ids = plan.units.map((u) => (u && typeof u === "object" ? str((u as Record<string, unknown>).id) : "")).filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
}

export function parseDeployExit3Report(log: string): DeployExit3Report {
  let last: Record<string, unknown> | null = null;
  for (const line of (log ?? "").split("\n")) {
    const o = jsonLine(line);
    if (o && EXIT3_STATUSES.includes(o.status as string)) last = o;
  }
  const empty: DeployExit3Report = { status: null, head: null, units: [], humanRules: [], entries: [], driftUnits: null, security: [], other: [], ownerApprovals: [] };
  if (!last) return empty;
  const plan = last.plan && typeof last.plan === "object" ? (last.plan as Record<string, unknown>) : {};
  const humanList = Array.isArray(last.human) ? last.human : Array.isArray(plan.human) ? plan.human : [];
  const units: string[] = [];
  const humanRules: string[] = [];
  const entries: PlanBlockEntry[] = [];
  for (const h of humanList) {
    const e = planEntryOf(h);
    if (!e) continue;
    entries.push(e);
    if (e.unit) units.push(e.unit);
    if (e.rule) humanRules.push(e.rule);
  }
  const security: SecurityReviewRequest[] = [];
  const other: OtherMissingProof[] = [];
  for (const m of Array.isArray(last.missingProofs) ? last.missingProofs : []) {
    if (!m || typeof m !== "object") continue;
    const e = m as Record<string, unknown>;
    const req = e.request && typeof e.request === "object" ? (e.request as Record<string, unknown>) : null;
    const subject = req ? subjectOf(req.subject) : null;
    if (e.proof === "security-review" && req && subject && str(req.reviewer) && str(req.record)) {
      security.push({ reviewer: str(req.reviewer), subject, record: str(req.record), units: strs(e.units), guards: strs(e.guards), status: str(e.status) || "missing", detail: str(e.detail) || null });
    } else {
      other.push({ proof: str(e.proof) || "?", status: str(e.status) || "missing", detail: str(e.detail) || null, ...(req && str(req.run) ? { run: str(req.run) } : {}) });
    }
  }
  return {
    status: last.status as Exit3Status,
    head: str(last.head) || str(plan.head) || null,
    units: [...new Set(units)],
    humanRules: [...new Set(humanRules)],
    entries,
    driftUnits: driftUnitsOf(plan),
    security,
    other,
    ownerApprovals: ownerApprovalRequestsOf(humanList),
  };
}

/**
 * O PLANO lido em modo leitura (`deploy.planCommand`, deploy-blocks.ts): a última linha JSON com `status`. Diferente de
 * {@link parseDeployExit3Report}, aqui um status FORA da saída 3 também é resposta — «o plano não recusa nada» é o fato
 * que fecha uma causa. null = nada legível (quem chama não conclui nada: fail-closed). PURA.
 */
export function parsePlanOutput(stdout: string): { status: string; report: DeployExit3Report } | null {
  let status: string | null = null;
  for (const line of (stdout ?? "").split("\n")) {
    const o = jsonLine(line);
    if (o && typeof o.status === "string" && o.status) status = o.status;
  }
  if (!status) return null;
  return { status, report: parseDeployExit3Report(stdout) };
}

// ── o card espera a prova ──────────────────────────────────────────────────────────────────────────────

/**
 * O card cujo deploy pediu uma PROVA fica no passo de publicar (não volta a Liberar — de lá uma política de release
 * automática o republicaria na hora, repetindo o pedido em laço): sem o carimbo do watchdog (o settle chegou), com o
 * finding `needs-proof`. Quando a prova sai, o «Re-publicar» de sempre re-roda o efeito do passo. PURA.
 */
export function applyDeployNeedsProofHold(card: Card, finding: Finding): Card {
  return { ...card, deployFiredAt: undefined, findings: upsertFinding(card.findings ?? [], finding) };
}

/** O finding de needs-proof ABERTO do card, se houver. PURA. */
export function openNeedsProof(card: Pick<Card, "findings">): Finding | null {
  return card.findings?.find((f) => f.id === DEPLOY_FAILURE_FINDING_ID && f.status === "open" && f.deployPhase === "needs-proof") ?? null;
}

/** A prova saiu: fecha o finding de needs-proof (só ele). Nada a fechar ⇒ null (pula a escrita). PURA. */
export function resolveNeedsProofFinding(card: Card): Card | null {
  if (!openNeedsProof(card)) return null;
  return {
    ...card,
    findings: (card.findings ?? []).map((f) => (f.id === DEPLOY_FAILURE_FINDING_ID && f.deployPhase === "needs-proof" ? { ...f, status: "fixed" as const } : f)),
  };
}

// ── o veredito ───────────────────────────────────────────────────────────────────────────────────────

export const VERDICT_SCHEMA = "deploy-proof/security-review@1";
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type VerdictSeverity = (typeof SEVERITIES)[number];
const BLOCKING: ReadonlySet<string> = new Set(["critical", "high"]);

export interface VerdictFinding {
  severity: VerdictSeverity;
  file?: string;
  title: string;
  detail?: string;
}

/** O que o revisor devolve (o resto do veredito é o código que monta). */
export interface ReviewerOutput {
  verdict: "approve" | "reject";
  summary: string;
  findings: VerdictFinding[];
}

export interface SecurityVerdict extends ReviewerOutput {
  schema: typeof VERDICT_SCHEMA;
  subject: ProofSubject;
  reviewer: { agent: string; runId: string; model: string };
  reviewedAt: string;
}

/** Valida a saída do revisor: veredito no vocabulário, resumo não-vazio, achados com título. PURA. */
export function parseReviewerOutput(raw: string): ReviewerOutput | { error: string } {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "o revisor não escreveu um objeto JSON" };
    o = v as Record<string, unknown>;
  } catch (err) {
    return { error: `veredito ilegível: ${String(err instanceof Error ? err.message : err).slice(0, 120)}` };
  }
  if (o.verdict !== "approve" && o.verdict !== "reject") return { error: "verdict deve ser approve ou reject" };
  const summary = str(o.summary).trim().slice(0, 1_500);
  if (!summary) return { error: "o veredito precisa do resumo (summary)" };
  const findings: VerdictFinding[] = [];
  for (const f of Array.isArray(o.findings) ? o.findings : []) {
    if (!f || typeof f !== "object") continue;
    const e = f as Record<string, unknown>;
    const title = str(e.title).trim().slice(0, 300);
    if (!title) continue;
    const sev = str(e.severity).toLowerCase();
    findings.push({
      severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as VerdictSeverity) : "info",
      ...(str(e.file) ? { file: str(e.file).slice(0, 300) } : {}),
      title,
      ...(str(e.detail) ? { detail: str(e.detail).slice(0, 1_500) } : {}),
    });
  }
  return { verdict: o.verdict, summary, findings };
}

/** O veredito no formato do alvo — o ASSUNTO é o do pedido (o hash que a receita recalcula), nunca o do modelo. PURA. */
export function composeSecurityVerdict(
  subject: ProofSubject,
  out: ReviewerOutput,
  meta: { agent: string; runId: string; model: string; at: string },
): SecurityVerdict {
  return {
    schema: VERDICT_SCHEMA,
    subject,
    verdict: out.verdict,
    summary: out.summary,
    findings: out.findings,
    reviewer: { agent: meta.agent, runId: meta.runId, model: meta.model },
    reviewedAt: meta.at,
  };
}

/** A mesma régua do alvo: aprovação = `approve` SEM achado crítico/alto. PURA. */
export function isVerdictApproval(v: Pick<SecurityVerdict, "verdict" | "findings">): boolean {
  return v.verdict === "approve" && !v.findings.some((f) => BLOCKING.has(String(f.severity).toLowerCase()));
}

// ── a autorização do dono ──────────────────────────────────────────────────────────────────

export const OWNER_APPROVAL_SCHEMA = "deploy-proof/owner-approval@1";
/** O marcador do arquivo no texto `record` que o log do deploy imprime (informativo: quem decide o que roda é `deploy.proof.record`). */
export const OWNER_APPROVAL_PLACEHOLDER = "<approval.json>";

export interface OwnerApproval {
  schema: typeof OWNER_APPROVAL_SCHEMA;
  subject: ProofSubject;
  approvedBy: "owner";
  /** onde o dono autorizou (o Inbox). */
  via: string;
  approvedAt: string;
  /** o card cujo código carrega a mudança, quando se sabe. */
  card?: string;
}

/**
 * A autorização no formato do alvo. O ASSUNTO é o do PEDIDO, copiado — quem autoriza não escolhe o que está autorizando,
 * e o alvo recalcula o assunto ao gravar (uma autorização de outra mudança é recusada lá). PURA.
 */
export function buildOwnerApproval(request: Pick<OwnerApprovalRequest, "subject">, meta: { at: string; via: string; card?: string | null }): OwnerApproval {
  return { schema: OWNER_APPROVAL_SCHEMA, subject: request.subject, approvedBy: "owner", via: meta.via, approvedAt: meta.at, ...(meta.card ? { card: meta.card } : {}) };
}

/** As frases que o ALVO declarou (settings.yaml → `deploy.proof.staleMarkers`) para dizer «veredito de OUTRO assunto». */
export function declaredStaleMarkers(): string[] {
  return deployPolicyOf(loadRunnerConfig()).proof.staleMarkers;
}

/**
 * A gravação recusou porque o veredito é de OUTRO assunto (o checkout andou)? A frase é a do script do ALVO — por isso é o ALVO
 * quem a declara (`deploy.proof.staleMarkers`, texto LITERAL, sem caixa): a ferramenta não conhece o idioma nem o texto de erro
 * do script de ninguém. SEM declaração nunca é «stale»: a falha cai no caminho contado de falhas (tentativas limitadas ⇒
 * card de conserto), que é o lado seguro — jamais o dono. PURA sobre `markers` (o default lê a declaração do alvo).
 */
export function recordRefusedAsStale(stderr: string, markers: readonly string[] = declaredStaleMarkers()): boolean {
  const haystack = String(stderr ?? "").toLowerCase();
  return markers.some((m) => m.length > 0 && haystack.includes(m.toLowerCase()));
}

/**
 * O comando que GRAVA a prova, como o ALVO o declarou (`deploy.proof.record.securityReview` / `.ownerApproval`, um argv com
 * `{file}`) — NÃO o texto que o log do deploy imprimiu. O programa que roda com o privilégio do serviço é escolhido por quem
 * opera o alvo (settings.yaml é superfície de revisão), nunca por uma linha de saída de comando. Sem declaração (ou com um
 * `file` que não vira argumento seguro) devolve a recusa nomeando a chave. PURA sobre `record`.
 */
export function declaredRecordArgv(
  kind: "securityReview" | "ownerApproval",
  file: string,
  record: { securityReview?: string[]; ownerApproval?: string[] } = deployPolicyOf(loadRunnerConfig()).proof.record,
): { argv: string[] } | { refusal: string } {
  const template = record[kind];
  if (!template) return { refusal: `o alvo não declarou COMO gravar esta prova — declare em settings.yaml → deploy.proof.record.${kind} (um argv, sem shell, com {file}).` };
  const argv = expandArgvTemplate(template, { file });
  return argv ? { argv } : { refusal: `o arquivo ${JSON.stringify(file)} não é um caminho seguro para deploy.proof.record.${kind}.` };
}

/** O resultado de gravar uma prova pelo comando que o ALVO declarou. `stale` = o alvo recusou porque a mudança já é outra. */
export type DeclaredRecordOutcome = { ok: true } | { ok: false; stale: boolean; error: string };

/** As bordas de {@link runDeclaredRecord}: achar o executável e rodá-lo. Injetáveis para a lógica ser testável sem processo. */
export interface DeclaredRecordIo {
  /** o NOME do programa (`argv[0]`) → o caminho absoluto, ou a recusa que diz o que declarar. */
  resolveProgram(name: string): { ok: true; path: string } | { ok: false; refusal: string };
  /** roda o programa (sem shell). Lança em saída não-zero; o `stderr` do erro é o que `recordRefusedAsStale` lê. */
  exec(program: string, args: string[]): Promise<void>;
}

/**
 * GRAVA a prova (o veredito da revisão, ou a autorização do dono) pelo comando que o ALVO declarou — o ÚNICO caminho que
 * executa o programa que roda com o privilégio do serviço. Antes, o comando saía do TEXTO `record` que o log do deploy
 * imprimiu: o texto de uma saída de comando virava argv, e cada palavra só precisava casar `[A-Za-z0-9._/:=-]+`, então
 * `bash -c id <verdict.json>` passava. Agora o argv é o de `settings.yaml → deploy.proof.record.<kind>`: o texto do log
 * não decide NADA do que roda (o programa é escolhido por quem opera o alvo).
 *
 *   · sem declaração ⇒ recusa nomeando `deploy.proof.record.<kind>` (nada roda por suposição);
 *   · a saída não-zero é «stale» só se casar uma marca declarada (`deploy.proof.staleMarkers`) — sem marcas nunca é stale.
 */
export async function runDeclaredRecord(
  kind: "securityReview" | "ownerApproval",
  file: string,
  io: DeclaredRecordIo,
  opts: { record?: { securityReview?: string[]; ownerApproval?: string[] }; markers?: readonly string[] } = {},
): Promise<DeclaredRecordOutcome> {
  const declared = declaredRecordArgv(kind, file, opts.record);
  if ("refusal" in declared) return { ok: false, stale: false, error: declared.refusal };
  const program = io.resolveProgram(declared.argv[0]);
  if (!program.ok) return { ok: false, stale: false, error: program.refusal };
  try {
    await io.exec(program.path, declared.argv.slice(1));
    return { ok: true };
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? (err instanceof Error ? err.message : err));
    return { ok: false, stale: recordRefusedAsStale(stderr, opts.markers), error: stderr.trim().slice(-300) };
  }
}

/**
 * Um veredito NEGATIVO reabre o card por CORREÇÃO (o mesmo reabrir do «Corrigir»): o resumo do revisor como o brief do
 * bug, cada achado como um finding de segurança (crítico/alto = blocker, que segura o gate), e `reopenPending` para o
 * harness-fix rodar no destino. Board sem o passo de correção ⇒ null (quem chama abre um card de conserto). PURA.
 */
export function securityReopen(card: Card, config: Pick<BoardConfig, "statuses">, v: SecurityVerdict, today: string): Card | null {
  const fix = REOPEN_KINDS.fix;
  if (!config.statuses.some((s) => s.id === fix.status)) return null;
  const reopened = applyReopen(card, {
    mode: "fix",
    bugReport: {
      brief: `A revisão de segurança independente reprovou a publicação: ${v.summary}`,
      severity: v.findings.some((f) => BLOCKING.has(f.severity)) ? "high" : "medium",
      expected: null,
      actual: null,
      steps: [],
      target: null,
      screenshot: null,
      openedAt: today,
    },
  });
  let findings = card.findings ?? [];
  v.findings.forEach((f, i) => {
    findings = upsertFinding(findings, {
      id: `security-review-${i + 1}`,
      lens: "security",
      severity: BLOCKING.has(f.severity) ? "blocker" : f.severity === "medium" ? "medium" : "low",
      status: "open",
      title: f.title,
      ...(f.detail ? { detail: f.detail } : {}),
      ...(f.file ? { file: f.file } : {}),
    });
  });
  // o pedido de prova deste deploy acabou (a resposta foi não): o finding de needs-proof fecha.
  findings = findings.map((f) => (f.id === DEPLOY_FAILURE_FINDING_ID && f.deployPhase === "needs-proof" && f.status === "open" ? { ...f, status: "fixed" as const } : f));
  return { ...reopened, status: fix.status, reopenPending: true, findings };
}
