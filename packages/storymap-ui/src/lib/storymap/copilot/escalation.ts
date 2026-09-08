// WS-0 (copilot-actionability) — the PURE, isomorphic escalation kernel: a serializable, URL-safe
// reference to the ITEM a human wants to hand to the copiloto (`?copilot=<ref>`, D4) + the frozen
// registry of one escalation TEMPLATE per catalogued scenario (00-cenarios.md, 25 of them). It lives
// beside protocol.ts (the pure/isomorphic side of the copiloto), imports ONLY types, and is safe in
// both the browser (the QuickActionButton encodes a ref) and node (tests / the WS-1 seeder read it).
//
// Design invariants (README copilot-actionability):
//  • D4  — a ref carries only INOCUOUS ids (no secret): it travels in a query param that the WS-1
//          BoardHeader parses then immediately clears with router.replace.
//  • D8b — the containment clause is a STRUCTURED, exhaustiveness-tested FIELD (`confirmClause`), never
//          prose baked into the instruction.
//  • D16 — `EscalationRef.taskId?` is the reserved embryo of a future CopilotTask entity; v1 never sets it.
//  • inv.7 — an instruction NEVER embeds third-party evidence (stderr/gateLog/logTail): it interpolates
//          only ids/paths/short labels from the item; the evidence rides the <contexto> block (WS-1).
//  • inv.10 — agnostic: no board/brand names; the text is generic per scenario, specific per DATA.

import type { RiskClass } from "../types";
import type { CockpitItem } from "../demands";

/** One escalation TEMPLATE per catalogued scenario (00-cenarios.md). FROZEN in WS-0 — WS-5 extends it. */
export type EscalationTemplateId =
  | "merge-conflict" | "merge-gate-failed" | "merge-failed-terminal"
  | "deploy-failed" | "deploy-unsettled"
  | "run-death" | "run-inflight-stuck" | "run-advanced-warning"
  | "blocker-generic" | "blocker-merge-back" | "blocker-secret-scan" | "qa-red"
  | "question-pending" | "approval-pending" | "proposal-capture" | "review-triage"
  | "gate-manual-approve" | "design-wireframe" | "governance-draft"
  | "release-aging" | "preserved-branch-recovery" | "orphan-process-kill"
  | "move-gate-blocked" | "unplaced-card" | "hitl-card-instructions";

/** Fields common to every ref. `taskId` is RESERVED (D16) — the v1 code path never populates it. */
interface EscalationRefBase {
  templateId: EscalationTemplateId;
  /** D16 — reserved embryo of a future CopilotTask; v1 NEVER sets it. */
  taskId?: string;
}

/**
 * The serializable, URL-safe identifier of the ITEM being escalated — travels in `?copilot=<ref>` (D4).
 * A discriminated union by `kind`; every member carries only inocuous ids (no secret — invariant 6).
 */
export type EscalationRef = EscalationRefBase &
  (
    | { kind: "card"; boardId: string; cardId: string }
    | { kind: "question"; boardId: string; cardId: string; questionId: string }
    | { kind: "finding"; boardId: string; cardId: string; findingId: string }
    | { kind: "merge"; boardId: string; cardId: string; runId: string; entryStatus: "conflict" | "gate-failed" | "failed" }
    | { kind: "run"; boardId: string; cardId: string; runId?: string }
    | { kind: "deploy"; boardId: string; cardId: string }
    | { kind: "branch"; boardId: string; branch: string } // regex de discardPreservedBranchAction: /^(failed\/)?run\/[A-Za-z0-9-]+$/
    | { kind: "process"; boardId: string; session: string }
    | { kind: "approval"; boardId: string; approvalId: string }
    | { kind: "governance"; boardId: string; draftId: string }
    | { kind: "move-blocked"; boardId: string; cardId: string; target: string }
  );

// ── Wire encoding (isomorphic, UTF-8 safe) ───────────────────────────────────────────────────────
// base64url(JSON.stringify(ref)); the whole wire matches /^[A-Za-z0-9_-]+$/ (no escaping needed). Uses
// btoa/atob + TextEncoder/TextDecoder — all present in modern browsers AND node 22 — so the SAME code
// runs client-side (QuickActionButton) and in tests. Never throws (parse fails silent to null).

const KINDS = new Set([
  "card", "question", "finding", "merge", "run", "deploy", "branch", "process", "approval", "governance", "move-blocked",
]);
const TEMPLATE_IDS = new Set<string>([
  "merge-conflict", "merge-gate-failed", "merge-failed-terminal", "deploy-failed", "deploy-unsettled",
  "run-death", "run-inflight-stuck", "run-advanced-warning", "blocker-generic", "blocker-merge-back",
  "blocker-secret-scan", "qa-red", "question-pending", "approval-pending", "proposal-capture",
  "review-triage", "gate-manual-approve", "design-wireframe", "governance-draft", "release-aging",
  "preserved-branch-recovery", "orphan-process-kill", "move-gate-blocked", "unplaced-card", "hitl-card-instructions",
]);
/** ids that ride a ref must be inocuous (no path traversal, no secret) — invariant 6. */
const ID_RE = /^[A-Za-z0-9/._-]{1,120}$/;
/** boardId is a slug (the subsystem's SLUG_RE). */
const SLUG_RE = /^[a-z0-9-]{1,64}$/i;
/** the whole wire — bounds size (defense against abuse) + guarantees URL-safe. */
const WIRE_RE = /^[A-Za-z0-9_-]{1,512}$/;

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string | null {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = typeof atob !== "undefined" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Encode a ref for `?copilot=<ref>`. The output matches /^[A-Za-z0-9_-]+$/ (URL-safe, no escaping). */
export function encodeEscalationRef(ref: EscalationRef): string {
  return toBase64Url(JSON.stringify(ref));
}

const idOk = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

/**
 * Parse `?copilot=<ref>` FAIL-SILENT: any tampered / truncated / non-base64url / unknown-kind /
 * unknown-templateId / bad-id payload returns `null` WITHOUT throwing — a garbled param simply does
 * nothing (never opens the drawer with junk, never lands `undefined` ids in a prompt). Reconstructs a
 * CANONICAL object per kind (strips unknown fields), so `parse(encode(ref))` is deep-equal for a clean ref.
 */
export function parseEscalationRef(raw: string | null | undefined): EscalationRef | null {
  if (!raw || !WIRE_RE.test(raw)) return null;
  const json = fromBase64Url(raw);
  if (json === null) return null;
  let o: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  if (typeof o.templateId !== "string" || !TEMPLATE_IDS.has(o.templateId)) return null;
  if (typeof o.boardId !== "string" || !SLUG_RE.test(o.boardId)) return null;
  if (o.taskId !== undefined && !idOk(o.taskId)) return null;

  const templateId = o.templateId as EscalationTemplateId;
  const boardId = o.boardId;
  const base: EscalationRefBase = idOk(o.taskId) ? { templateId, taskId: o.taskId } : { templateId };

  switch (o.kind) {
    case "card":
      if (!idOk(o.cardId)) return null;
      return { ...base, kind: "card", boardId, cardId: o.cardId };
    case "question":
      if (!idOk(o.cardId) || !idOk(o.questionId)) return null;
      return { ...base, kind: "question", boardId, cardId: o.cardId, questionId: o.questionId };
    case "finding":
      if (!idOk(o.cardId) || !idOk(o.findingId)) return null;
      return { ...base, kind: "finding", boardId, cardId: o.cardId, findingId: o.findingId };
    case "merge": {
      if (!idOk(o.cardId) || !idOk(o.runId)) return null;
      if (o.entryStatus !== "conflict" && o.entryStatus !== "gate-failed" && o.entryStatus !== "failed") return null;
      return { ...base, kind: "merge", boardId, cardId: o.cardId, runId: o.runId, entryStatus: o.entryStatus };
    }
    case "run":
      if (!idOk(o.cardId)) return null;
      if (o.runId !== undefined && !idOk(o.runId)) return null;
      return { ...base, kind: "run", boardId, cardId: o.cardId, ...(idOk(o.runId) ? { runId: o.runId } : {}) };
    case "deploy":
      if (!idOk(o.cardId)) return null;
      return { ...base, kind: "deploy", boardId, cardId: o.cardId };
    case "branch":
      if (!idOk(o.branch)) return null;
      return { ...base, kind: "branch", boardId, branch: o.branch };
    case "process":
      if (!idOk(o.session)) return null;
      return { ...base, kind: "process", boardId, session: o.session };
    case "approval":
      if (!idOk(o.approvalId)) return null;
      return { ...base, kind: "approval", boardId, approvalId: o.approvalId };
    case "governance":
      if (!idOk(o.draftId)) return null;
      return { ...base, kind: "governance", boardId, draftId: o.draftId };
    case "move-blocked":
      if (!idOk(o.cardId) || !idOk(o.target)) return null;
      return { ...base, kind: "move-blocked", boardId, cardId: o.cardId, target: o.target };
    default:
      return null;
  }
}

/**
 * The GENERIC CockpitItem → ref mapper consumed by the WS-3 renderers (pure). A field it can't fill
 * degrades to a `{kind:'card'}` ref; a `card` degrade with no cardId returns `null` (no escalate). The
 * scenario-SPECIFIC refs (blocker by finding prefix, etc.) are built inside QUICK_ACTIONS_OF — this is
 * the fallback/default for a surface that only wants "hand this item to the copiloto".
 */
export function escalationRefFor(item: CockpitItem, boardId: string): EscalationRef | null {
  switch (item.kind) {
    case "conflict":
      if (!item.runId) return { templateId: item.conflictKind, kind: "card", boardId, cardId: item.cardId };
      return {
        templateId: item.conflictKind,
        kind: "merge",
        boardId,
        cardId: item.cardId,
        runId: item.runId,
        entryStatus: item.conflictKind === "merge-conflict" ? "conflict" : "gate-failed",
      };
    case "stuck":
      return { templateId: "run-death", kind: "run", boardId, cardId: item.cardId };
    case "deploy-failed":
      return { templateId: "deploy-failed", kind: "deploy", boardId, cardId: item.cardId };
    case "approval":
      // apr:<id> = a copiloto-opened ApprovalRequest → an `approval` ref; the <cardId>:data-deletion
      // card-field gate has no approvalId → degrade to card.
      if (item.id.startsWith("apr:")) {
        return { templateId: "approval-pending", kind: "approval", boardId, approvalId: item.id.slice(4) };
      }
      return item.cardId ? { templateId: "approval-pending", kind: "card", boardId, cardId: item.cardId } : null;
    case "governance":
      return { templateId: "governance-draft", kind: "governance", boardId, draftId: item.draftId };
    case "question":
      return { templateId: "question-pending", kind: "question", boardId, cardId: item.cardId, questionId: item.questionId };
    case "deploy-unsettled":
      return { templateId: "deploy-unsettled", kind: "deploy", boardId, cardId: item.cardId };
    case "release-aging":
      return { templateId: "release-aging", kind: "card", boardId, cardId: item.cardId };
    case "merge-failed":
      return { templateId: "merge-failed-terminal", kind: "merge", boardId, cardId: item.cardId, runId: item.runId, entryStatus: "failed" };
    default:
      // blocker · gate · review · proposal · design → a plain card ref (generic HITL). No card ⇒ no escalate.
      return item.cardId ? { templateId: "hitl-card-instructions", kind: "card", boardId, cardId: item.cardId } : null;
  }
}

// ── Templates (D8b — the containment clause is a structured field, not prose) ─────────────────────

/** Parameters an instruction interpolates — ONLY ids/paths/short labels (invariant 7 — never a blob). */
export interface EscalationParams {
  boardId: string;
  cardId?: string;
  runId?: string;
  findingId?: string;
  questionId?: string;
  approvalId?: string;
  branch?: string;
  session?: string;
  targetStatus?: string;
  /** pointwise labels (gateLabel, reason, draftId, firedAt, stagedAt) — NEVER blobs. */
  extra?: Record<string, string>;
}

/** A frozen escalation template. `confirmClause` (D8b) is present iff `cls` is a sensitive class. */
export interface EscalationTemplate {
  id: EscalationTemplateId;
  /** risk class of the WORST step of the playbook — drives requiresConfirm/confirmClause + the D8b test. */
  cls: RiskClass;
  /** PT-BR instruction pre-seeded into the composer (the human ALWAYS edits + sends it — D4). */
  instruction: (params: EscalationParams) => string;
  requiresConfirm: boolean;
  /** D8b — obligatory when `cls` is sensitive: names the irreversible act of THIS playbook. */
  confirmClause?: string;
}

/** The classes whose escalation carries a containment clause (== SENSITIVE_AUDIT_CLASSES). Kept local to
 *  avoid a value-import cycle with quick-actions.ts; the escalation test pins the two in agreement. */
const SENSITIVE_CLS: ReadonlySet<RiskClass> = new Set<RiskClass>(["run", "merge-resolve", "deploy", "destructive"]);

function tpl(
  id: EscalationTemplateId,
  cls: RiskClass,
  instruction: (p: EscalationParams) => string,
  confirmClause?: string,
): EscalationTemplate {
  const sensitive = SENSITIVE_CLS.has(cls);
  if (sensitive && !confirmClause) {
    // A sensitive template without a clause is a bug the D8b test also catches — fail loud in dev.
    throw new Error(`escalation template ${id} (cls ${cls}) requires a confirmClause`);
  }
  return { id, cls, instruction, requiresConfirm: sensitive, ...(sensitive ? { confirmClause } : {}) };
}

/**
 * EXHAUSTIVE registry — one template per catalogued scenario (00-cenarios.md). The `instruction` text
 * follows each scenario's `copilotEscalation`; it cites the target id (so the agent has the target even
 * if the WS-1 context injection fails) and NEVER embeds third-party evidence (invariant 7).
 */
export const ESCALATION_TEMPLATES: Record<EscalationTemplateId, EscalationTemplate> = {
  "merge-conflict": tpl(
    "merge-conflict",
    "merge-resolve",
    (p) =>
      `Investigue e resolva o merge conflitado do run \`${p.runId}\` (card \`${p.cardId}\`): faça checkout/merge da branch, ` +
      `resolva os conflitos, rode a suíte, então chame resolve_merge (merged). Se irrecuperável, aborte e explique.`,
    "NÃO conclua o merge nem aborte a branch sem me confirmar neste chat antes.",
  ),
  "merge-gate-failed": tpl(
    "merge-gate-failed",
    "merge-resolve",
    (p) =>
      `O gate do run \`${p.runId}\` (card \`${p.cardId}\`) reprovou. Reproduza a suíte, determine se é defeito real ou ` +
      `teste flaky (flaky no gated suite congela o train), conserte o código/teste — nunca enfraquecer asserção — então retry.`,
    "NÃO aborte a branch nem force o gate sem me confirmar neste chat antes.",
  ),
  "merge-failed-terminal": tpl(
    "merge-failed-terminal",
    "merge-resolve",
    (p) =>
      `O run \`${p.runId}\` (card \`${p.cardId}\`) falhou terminalmente. Verifique a branch preservada` +
      `${p.branch ? ` \`${p.branch}\`` : ""}, execute o recoverHint, recupere os commits (git fsck/cherry-pick se ` +
      `preciso) e reintegre via enqueue ou merge manual + resolve_merge.`,
    "NÃO descarte a branch nem reescreva histórico sem me confirmar neste chat antes.",
  ),
  "deploy-failed": tpl(
    "deploy-failed",
    "deploy",
    (p) =>
      `O deploy do card \`${p.cardId}\` falhou. Chame deploy_status/deploy_plan, diagnostique (build? env? drift?), ` +
      `conserte a causa e re-dispare o deploy; confirme o settle.`,
    "NÃO re-dispare o deploy sem me confirmar neste chat antes.",
  ),
  "deploy-unsettled": tpl(
    "deploy-unsettled",
    "deploy",
    (p) =>
      `O deploy do card \`${p.cardId}\`${p.extra?.firedAt ? ` disparou às ${p.extra.firedAt}` : ""} e não settlou. ` +
      `Verifique a unit de deploy, o log e deploy_status; conclua se rodou e settle ou re-dispare.`,
    "NÃO force o settle nem re-dispare o deploy sem me confirmar neste chat antes.",
  ),
  "run-death": tpl(
    "run-death",
    "run",
    (p) =>
      `O run do card \`${p.cardId}\` morreu${p.extra?.reason ? ` (${p.extra.reason})` : ""}. Leia o finding run-death, o ` +
      `journal e as últimas linhas do console; se infra, re-enfileire; se app/test, conserte a causa no worktree antes ` +
      `de re-rodar; se no-op, descubra por que a skill não avançou o card.`,
    "NÃO re-enfileire o run nem altere o worktree/branch sem me confirmar neste chat antes.",
  ),
  "run-inflight-stuck": tpl(
    "run-inflight-stuck",
    "run",
    (p) =>
      `O run \`${p.runId}\` do card \`${p.cardId}\` pode ter travado. Capture o console (card_console/claude_capture), ` +
      `avalie se progride; se travado, cancele (cancel_run) e re-enfileire; se saudável, apenas reporte.`,
    "NÃO mate o run nem re-enfileire sem me confirmar neste chat antes.",
  ),
  "run-advanced-warning": tpl(
    "run-advanced-warning",
    "write-board",
    (p) =>
      `O card \`${p.cardId}\` avançou${p.targetStatus ? ` para \`${p.targetStatus}\`` : ""} mas o run terminou com aviso. ` +
      `Verifique o diff (card_diff/git_diff) e o trail: o trabalho declarado foi entregue? Se não, mova de volta e explique.`,
  ),
  "blocker-generic": tpl(
    "blocker-generic",
    "write-board",
    (p) =>
      `O card \`${p.cardId}\` está travado pelo blocker${p.findingId ? ` \`${p.findingId}\`` : ""}. Conserte o código de ` +
      `verdade, rode typecheck+testes (nunca enfraquecer asserção), então marque o finding como fixed — o gate libera o card sozinho.`,
  ),
  "blocker-merge-back": tpl(
    "blocker-merge-back",
    "merge-resolve",
    (p) =>
      `O merge-back do run \`${p.runId}\` (card \`${p.cardId}\`) falhou; o trabalho está preso` +
      `${p.branch ? ` na branch \`${p.branch}\`` : ""}. Cherry-picke os commits para o stage, rode a suíte, integre, ` +
      `então marque o finding${p.findingId ? ` \`${p.findingId}\`` : ""} como fixed.`,
    "NÃO descarte a branch nem reescreva histórico sem me confirmar neste chat antes.",
  ),
  "blocker-secret-scan": tpl(
    "blocker-secret-scan",
    "destructive",
    (p) =>
      `O run \`${p.runId}\` (card \`${p.cardId}\`) foi bloqueado pelo secret-scan. Identifique o valor flagado e decida: ` +
      `fixture (marcador example/fake/mock no VALOR) ou segredo real (remova e reescreva o commit); prove verde com o scan, ` +
      `marque o finding${p.findingId ? ` \`${p.findingId}\`` : ""} como fixed e re-tente o gate.`,
    "NÃO reescreva commits nem force push sem me confirmar neste chat antes.",
  ),
  "qa-red": tpl(
    "qa-red",
    "run",
    (p) =>
      `O QA do card \`${p.cardId}\` reprovou${p.findingId ? ` (finding \`${p.findingId}\`)` : ""}. Leia os specs E2E e o ` +
      `acceptance, reproduza a falha, conserte o APP (nunca o teste para passar), marque o finding como fixed e re-enfileire o QA.`,
    "NÃO re-enfileire o QA nem altere specs sem me confirmar neste chat antes.",
  ),
  "question-pending": tpl(
    "question-pending",
    "write-board",
    (p) =>
      `Investigue e responda com FATOS a pergunta${p.questionId ? ` \`${p.questionId}\`` : ""} do card \`${p.cardId}\`. ` +
      `Se exigir decisão humana genuína, diga o que descobriu e devolva as opções enriquecidas. Responda via answer_question.`,
  ),
  "approval-pending": tpl(
    "approval-pending",
    "read",
    (p) =>
      `Você (tick autônomo) pediu a aprovação${p.approvalId ? ` \`${p.approvalId}\`` : ""}${p.cardId ? ` do card \`${p.cardId}\`` : ""}. ` +
      `Explique o que a ação faz, o risco e por que a pediu (consulte o diário e o ledger de ações); recomende aprovar ou ` +
      `rejeitar — NUNCA decida por mim.`,
  ),
  "proposal-capture": tpl(
    "proposal-capture",
    "write-board",
    (p) =>
      `Avalie a proposta de captura do container \`${p.cardId}\` (granularidade story≠task, duplicatas contra o board, ` +
      `parents corretos); sugira merges/cortes e, se eu concordar, aplique o refino.`,
  ),
  "review-triage": tpl(
    "review-triage",
    "write-board",
    (p) =>
      `O card \`${p.cardId}\` veio da triagem com baixa confiança. Compare com o board (duplicata? escopo? parent certo?), ` +
      `recomende aceitar/mesclar/descartar e execute a decisão que eu confirmar.`,
  ),
  "gate-manual-approve": tpl(
    "gate-manual-approve",
    "read",
    (p) =>
      `O card \`${p.cardId}\` aguarda minha aprovação no gate${p.extra?.gateLabel ? ` \`${p.extra.gateLabel}\`` : ""}. ` +
      `Verifique a entrega (diff, acceptance, findings abertos) e diga se está pronto; liste ressalvas — NÃO decida por mim.`,
  ),
  "design-wireframe": tpl(
    "design-wireframe",
    "write-board",
    (p) =>
      `Avalie o canvas de design do card \`${p.cardId}\` contra a jornada e as convenções do app ` +
      `(get_card_wireframes, view "text"). Decida: APROVAR o artefato primário como está; TROCAR o ` +
      `primário (choose_wireframe); ou PEDIR AJUSTE — registre o pedido específico por artefato via ` +
      `design_feedback (o redesenho incorpora as entradas não-resolvidas); ou proponha o ajuste que eu descrever.`,
  ),
  "governance-draft": tpl(
    "governance-draft",
    "write-board",
    (p) =>
      `O draft de governança${p.extra?.draftId ? ` \`${p.extra.draftId}\`` : ""} conflita com o valor canônico atual. ` +
      `Leia o canônico, reaplique a intenção da mudança sobre ele e emita novo propose_change para eu aprovar — nunca aprove você mesmo.`,
  ),
  "release-aging": tpl(
    "release-aging",
    "merge-resolve",
    (p) =>
      `O card \`${p.cardId}\` está staged sem release${p.extra?.stagedAt ? ` desde ${p.extra.stagedAt}` : ""}. Verifique se há ` +
      `razão (frontier refs/promoted, conflito stage↔main, gates); se estiver limpo, promova (ou explique o bloqueio).`,
    "NÃO promova (merge stage→main) nem publique sem me confirmar neste chat antes.",
  ),
  "preserved-branch-recovery": tpl(
    "preserved-branch-recovery",
    "merge-resolve",
    (p) =>
      `A branch${p.branch ? ` \`${p.branch}\`` : ""} (card \`${p.cardId}\`) precisa de atenção. Execute o recoverHint, ` +
      `valide com a suíte, integre no stage e descarte a branch depois.`,
    "NÃO descarte a branch antes de integrar, nem reescreva histórico, sem me confirmar neste chat antes.",
  ),
  "orphan-process-kill": tpl(
    "orphan-process-kill",
    "destructive",
    (p) =>
      `Capture o pane da sessão${p.session ? ` \`${p.session}\`` : ""} (claude_capture/claude_sessions), resuma o estado, ` +
      `diga se há trabalho não salvo e se é seguro encerrar; se eu confirmar, encerre.`,
    "NÃO encerre nem mate a sessão/processo sem me confirmar neste chat antes.",
  ),
  "move-gate-blocked": tpl(
    "move-gate-blocked",
    "write-board",
    (p) =>
      `Tentei mover o card \`${p.cardId}\`${p.targetStatus ? ` para \`${p.targetStatus}\`` : ""} e o gate` +
      `${p.extra?.gate ? ` \`${p.extra.gate}\`` : ""} reprovou. Diagnostique o pré-requisito faltante e resolva o que for ` +
      `automatizável (finding, pergunta, task); devolva o que exige decisão minha.`,
  ),
  "unplaced-card": tpl(
    "unplaced-card",
    "write-board",
    (p) =>
      `O card \`${p.cardId}\` está sem lugar no mapa. Analise o backbone (activities/steps) e proponha parent+release; ` +
      `se eu aprovar, aplique via move_card/update_card.`,
  ),
  "hitl-card-instructions": tpl(
    "hitl-card-instructions",
    "read",
    // The free-HITL template (scenario 25): MINIMAL — only points the agent at the card; the human types the rest.
    (p) => `Investigue o card \`${p.cardId}\` antes de responder.`,
  ),
};

// ── ref → instruction bridge (added for WS-1; ADDITIVE to the frozen WS-0 contract) ───────────────
// WS-1's plumbing (BoardHeader seed + copilotItemContextAction) hands the composer an INSTRUCTION built
// from a ref. This maps a ref's ids to EscalationParams and calls its template. `extra` carries pointwise
// LABELS (failureClass/reason/firedAt/…) the server aggregator derives from the item's live evidence —
// never a blob (invariant 7). Client-side (BoardHeader) calls it WITHOUT extra → the generic template text.

/** Map a ref's discriminated fields to the flat EscalationParams the templates interpolate. Pure. */
export function paramsFromRef(ref: EscalationRef, extra?: Record<string, string>): EscalationParams {
  const p: EscalationParams = { boardId: ref.boardId };
  switch (ref.kind) {
    case "card":
    case "deploy":
      p.cardId = ref.cardId;
      break;
    case "question":
      p.cardId = ref.cardId;
      p.questionId = ref.questionId;
      break;
    case "finding":
      p.cardId = ref.cardId;
      p.findingId = ref.findingId;
      break;
    case "merge":
      p.cardId = ref.cardId;
      p.runId = ref.runId;
      break;
    case "run":
      p.cardId = ref.cardId;
      if (ref.runId) p.runId = ref.runId;
      break;
    case "branch":
      p.branch = ref.branch;
      break;
    case "process":
      p.session = ref.session;
      break;
    case "approval":
      p.approvalId = ref.approvalId;
      break;
    case "governance":
      // draftId has no dedicated param slot — it rides `extra` so the template can cite it.
      p.extra = { draftId: ref.draftId };
      break;
    case "move-blocked":
      p.cardId = ref.cardId;
      p.targetStatus = ref.target;
      break;
  }
  if (extra) p.extra = { ...(p.extra ?? {}), ...extra };
  return p;
}

/** The pre-composed instruction (composer seed, D4) for a ref. `extra` enriches it server-side with real
 *  labels; called with no extra (client) it yields the generic template text. Never auto-sent. */
export function escalationInstructionFor(ref: EscalationRef, extra?: Record<string, string>): string {
  return ESCALATION_TEMPLATES[ref.templateId].instruction(paramsFromRef(ref, extra));
}
