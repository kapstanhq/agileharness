// Governance core — pure (no fs), fully unit-testable.
// Provides the proposal lifecycle primitives: coerce (tolerant parse), apply (deep-set
// on a config clone), conflict detection (before vs canonical), and title derivation.
//
// The IO layer (read/write/list/delete governance sidecars) lives in sidecars.ts.
// Server actions (propose/approve/reject) live in app/actions.ts.

import type { BoardConfig, GovernanceArtifact, GovernanceChange, GovernanceDraft, GovernanceDraftStatus } from "./types";
import { GOVERNANCE_ARTIFACTS } from "./types";
import { BMC_BLOCK_KEYS } from "./doc/schemas/business-model-canvas";
import { PRD_SCHEMA } from "./doc/schemas/prd";

const VALID_STATUSES: readonly GovernanceDraftStatus[] = ["pending", "approved", "rejected"];

function coerceChange(raw: unknown): GovernanceChange | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const artifact = typeof c.artifact === "string" && (GOVERNANCE_ARTIFACTS as readonly string[]).includes(c.artifact)
    ? (c.artifact as GovernanceArtifact)
    : null;
  if (!artifact) return null;
  return {
    artifact,
    field: typeof c.field === "string" ? c.field : null,
    before: c.before,
    after: c.after,
    label: typeof c.label === "string" ? c.label : null,
  };
}

function coerceOrigin(raw: unknown): GovernanceDraft["origin"] {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    skill: typeof o.skill === "string" ? o.skill : null,
    cardId: typeof o.cardId === "string" ? o.cardId : null,
  };
}

/** Coerce raw JSON into a GovernanceDraft. Tolerant — never throws. Drops invalid changes. */
export function coerceGovernanceDraft(id: string, raw: unknown): GovernanceDraft {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status: GovernanceDraftStatus = (VALID_STATUSES as readonly string[]).includes(r.status as string)
    ? (r.status as GovernanceDraftStatus)
    : "pending";
  const changes = Array.isArray(r.changes)
    ? r.changes.map(coerceChange).filter((c): c is GovernanceChange => c !== null)
    : [];
  return {
    id,
    board: typeof r.board === "string" ? r.board : "",
    status,
    reason: typeof r.reason === "string" ? r.reason : "",
    origin: coerceOrigin(r.origin),
    changes,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString().slice(0, 10),
    decidedAt: typeof r.decidedAt === "string" ? r.decidedAt : null,
    approvedBy: typeof r.approvedBy === "string" ? r.approvedBy : null,
    withdrawnBy: typeof r.withdrawnBy === "string" ? r.withdrawnBy : null,
    ...(typeof r.supersededBy === "string" && r.supersededBy ? { supersededBy: r.supersededBy } : {}),
    ...(Array.isArray(r.supersedes) && r.supersedes.every((x) => typeof x === "string") && r.supersedes.length
      ? { supersedes: r.supersedes as string[] }
      : {}),
  };
}

/** A chave de uma mudança: o artefato e o campo que ela toca. */
const changeKey = (c: Pick<GovernanceChange, "artifact" | "field">) => `${c.artifact}:${c.field ?? ""}`;

/**
 * Os rascunhos PENDENTES que `draft` substitui: os que só mexem em campos que
 * ele também mexe (o novo cobre tudo o que o velho propunha). Um rascunho com um campo a mais que o novo não toca NÃO
 * é substituído — descartá-lo perderia aquele campo. Num caso real, vários rascunhos pendentes dos mesmos campos do PRD
 * lado a lado no board de produto; aprovar um fazia os outros falharem por conflito depois do clique. PURE.
 */
export function supersededPendingDrafts(draft: Pick<GovernanceDraft, "id" | "changes">, drafts: readonly GovernanceDraft[]): string[] {
  const covered = new Set(draft.changes.map(changeKey));
  if (covered.size === 0) return [];
  return drafts
    .filter((d) => d.id !== draft.id && d.status === "pending" && d.changes.length > 0 && d.changes.every((c) => covered.has(changeKey(c))))
    .map((d) => d.id);
}

/**
 * Apply a single GovernanceChange to a CLONE of the config — never mutates the input.
 * When `field` is null/undefined, replaces the entire artifact on the config.
 * When `field` is a dotpath string (single level), deep-sets that key inside the artifact.
 */
/**
 * Artefatos que NÃO moram no `board.yaml` — o núcleo puro não os aplica nem os compara, porque
 * ambos exigiriam I/O (ler o documento em disco). Quem os despacha é a casca
 * (`approveGovernanceDraftAction`), e é ela também que checa o conflito deles.
 *
 * Declarado como lista, e não com um `if (artifact === "prd")` espalhado: quando o segundo documento
 * governado aparecer, o lugar de dizer isso é UM.
 */
export const NON_CONFIG_ARTIFACTS: readonly string[] = ["prd"];

export function isNonConfigArtifact(artifact: string): boolean {
  return NON_CONFIG_ARTIFACTS.includes(artifact);
}

export function applyGovernanceChange(config: BoardConfig, change: GovernanceChange): BoardConfig {
  const key = change.artifact;
  // Um artefato que não mora no `board.yaml` sai INTACTO daqui: escrevê-lo como campo criaria uma
  // chave `prd` fantasma no YAML — exatamente o defeito do canvas (um caminho governado gravando
  // onde ninguém lê). Quem o aplica é a casca, que tem I/O.
  if (isNonConfigArtifact(key)) return config;
  if (!change.field) {
    return { ...config, [key]: change.after } as BoardConfig;
  }
  const current = (config as unknown as Record<string, unknown>)[key];
  const nested: Record<string, unknown> =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  nested[change.field] = change.after;
  return { ...config, [key]: nested } as BoardConfig;
}

/**
 * Detect GovernanceChanges whose `before` snapshot diverges from the current canonical value —
 * meaning the canonical was updated after the proposal was created. Returns labels of conflicting
 * changes; empty = no conflicts = safe to approve. Uses JSON serialization for deep equality.
 */
export function governanceConflicts(draft: GovernanceDraft, config: BoardConfig): string[] {
  const out: string[] = [];
  for (const change of draft.changes) {
    // O conflito de um artefato não-config é sobre o DOCUMENTO em disco; comparar contra o
    // `BoardConfig` diria "conflito" sempre (a chave não existe lá) e nenhuma proposta de PRD
    // poderia ser aprovada. A casca, que lê o documento, é quem o checa.
    if (isNonConfigArtifact(change.artifact)) continue;
    const current = (config as unknown as Record<string, unknown>)[change.artifact];
    let canonical: unknown;
    if (!change.field) {
      canonical = current;
    } else {
      canonical = current && typeof current === "object"
        ? (current as Record<string, unknown>)[change.field]
        : undefined;
    }
    if (JSON.stringify(canonical) !== JSON.stringify(change.before)) {
      const label = change.label ?? (change.field ? `${change.artifact}.${change.field}` : change.artifact);
      out.push(label);
    }
  }
  return out;
}

/**
 * Human-readable title derived from the artifact(s) changed in a draft — deduplicates and
 * joins with " + " (e.g. "desiredOutcome + canvas.propositionValue"). Falls back to "proposta".
 */
export function draftTitle(draft: GovernanceDraft): string {
  const seen = new Set<string>();
  for (const c of draft.changes) {
    seen.add(c.field ? `${c.artifact}.${c.field}` : c.artifact);
  }
  return seen.size > 0 ? [...seen].join(" + ") : "proposta";
}

// ── VALIDADE DA PROPOSTA (Inbox: pendente eterno) ────────────────────────────────────────────────
//
// O `ApprovalRequest` sempre teve `expiresAt`, e `listApprovalRequests` marca a vencida como
// `expired` — por isso aprovação velha não polui o Inbox. O `GovernanceDraft` nasceu SEM nada disso:
// uma proposta pendente ficava pendente para sempre. Somado ao fail-closed do revisor par (draft
// vetado SEGUE pendente, de propósito) e ao fato de o proponente não poder retirá-la, cada erro de
// um agente virava um item permanente na tela do operador.
//
// A validade é DERIVADA de `createdAt`, não gravada num campo novo. É o que faz ela valer para as
// propostas que já existem — um `expiresAt` só alcançaria as futuras, e o problema é o acúmulo de
// ontem. O preço é não dar para estender o prazo de uma proposta específica; se um dia isso for
// preciso, o campo entra e esta função passa a preferi-lo.
//
// 14 dias, e não as 24h da aprovação: os dois objetos pedem coisas diferentes do humano. A aprovação
// destrava uma AÇÃO que o agente quer executar agora — se ele não for destravado hoje, o pedido
// perdeu o sentido. Uma proposta de governança (um PRD, o posicionamento) é para ser LIDA com calma.
export const GOVERNANCE_DRAFT_TTL_DAYS = 14;

/**
 * A proposta está vencida? Só `pending` vence — decidida é história, e história não expira.
 *
 * FAIL-CLOSED de propósito: `createdAt` ilegível devolve `false`, ou seja, a proposta CONTINUA
 * visível. O erro barato aqui é o operador ver um item a mais; o caro é uma proposta sumir da tela
 * dele por causa de uma data que ninguém conseguiu ler.
 */
export function isGovernanceDraftStale(draft: Pick<GovernanceDraft, "status" | "createdAt">, now: number = Date.now()): boolean {
  if (draft.status !== "pending") return false;
  const nascida = Date.parse(`${draft.createdAt}T00:00:00Z`);
  if (!Number.isFinite(nascida)) return false;
  return now - nascida > GOVERNANCE_DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A proposta PENDENTE mira uma seção do formato ANTIGO de um documento (um bloco do Lean Canvas — `problem`,
 * `solution`… — ou uma seção do PRD formato 1 — `posicionamento`, `escopo`…)? Devolve a primeira mudança assim, ou
 * `null`. PURA.
 *
 * Uma proposta dessas nasceu antes da fase 2 e não tem mais onde aterrissar: aprovar dava «Seção desconhecida» e ela
 * ficava presa no Inbox. Traduzir a chave não basta — o `after` dela era a lista INTEIRA de um bloco antigo, e o
 * bloco novo junta vários antigos (gravar por cima apagaria o resto). Então ela sai do Inbox como VENCIDA, com o
 * motivo dito em palavras ({@link retiredDraftReason}); quem ainda quiser a mudança pede uma nova, já no formato novo.
 */
export function retiredDraftChange(draft: Pick<GovernanceDraft, "status"> & Partial<Pick<GovernanceDraft, "changes">>): GovernanceChange | null {
  if (draft.status !== "pending") return null;
  const prdKeys = new Set(PRD_SCHEMA.sections.map((s) => s.key));
  for (const c of draft.changes ?? []) {
    if (c.artifact === "canvas" && c.field != null && !BMC_BLOCK_KEYS.includes(c.field)) return c;
    if (c.artifact === "prd" && c.field != null && !prdKeys.has(c.field)) return c;
  }
  return null;
}

/** O motivo, em palavras, de uma proposta do formato antigo ter saído do Inbox — `null` quando não é o caso. PURA. */
export function retiredDraftReason(draft: Pick<GovernanceDraft, "status"> & Partial<Pick<GovernanceDraft, "changes">>): string | null {
  const c = retiredDraftChange(draft);
  if (!c) return null;
  const doc = c.artifact === "canvas" ? "o Business Model Canvas" : "o PRD";
  return (
    `Ela mudava «${c.field}», uma parte do formato antigo que não existe mais (${doc} mudou de formato). ` +
    "Saiu do Inbox sem mudar nada — se ainda fizer sentido, peça uma nova proposta."
  );
}

/**
 * Pode esta proposta ser RETIRADA pelo proponente? Devolve `null` quando sim, ou a razão da recusa.
 *
 * PURA e separada do handler MCP de propósito: é a única propriedade de segurança de
 * `withdraw_change`, e regra de segurança que mora inline num handler é regra que ninguém testa.
 *
 * As duas recusas, na ordem em que importam:
 *  1. já DECIDIDA — não há o que retirar, e sobrescrever a decisão de alguém seria o oposto do que
 *     esta tool faz;
 *  2. proposta de HUMANO (sem `origin.skill`) — retirar a proposta de quem decide seria decidir por
 *     ele. `origin.skill` é o que separa as duas origens: a UI não o preenche, `propose_change` sim.
 *
 * A ordem é deliberada: uma proposta de humano JÁ decidida recusa por (1), que é a informação mais
 * útil para quem chamou.
 */
export function withdrawRefusal(draft: GovernanceDraft): string | null {
  if (draft.status !== "pending") {
    return `Proposta já ${draft.status === "approved" ? "aprovada" : "rejeitada"} — nada a retirar.`;
  }
  if (!draft.origin?.skill) {
    return (
      `A proposta ${draft.id} não foi feita por um agente (sem \`origin.skill\`) — retirar a proposta de ` +
      `um humano seria decidir por ele. Só o operador a resolve, no Inbox.`
    );
  }
  return null;
}
