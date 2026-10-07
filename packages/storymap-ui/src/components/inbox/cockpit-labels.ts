// Presentational vocabulary around the Inbox that is NOT an item's decision: the governance proposal read as a
// decision (its headline and sections), the pending-proposal notice on the document pages, the outcome of an item
// that left the Inbox, the meter renewal toast and the home feed's tri-state. PURE, unit-tested without React.
//
// O texto de CADA ITEM do Inbox (a decisão, as opções, a consequência, o «se ignorar») não mora mais aqui: as tabelas
// de rótulo por kind (COCKPIT_KIND_LABEL / COCKPIT_DEMAND_LABEL, o resumo por kind, as cores de raia) saíram na onda 2
// do redesenho — o modelo do item (lib/storymap/inbox/decision.ts) é a única fonte, guardada contra o glossário.

import type { GovernanceCockpitItem } from "@/lib/storymap/demands";
import { governanceItemId } from "@/lib/storymap/demands";
import { cardHref, inboxItemHref } from "@/lib/storymap/deep-links";
import { dayToken, quoted, timeToken } from "@/lib/storymap/inbox/copy";
import { receiptUndoLabel, type InboxReceiptRecord } from "@/lib/storymap/inbox/receipts";
import { agentLabel, type SystemDecision } from "@/lib/storymap/system-decisions";
import { GOVERNANCE_DRAFT_TTL_DAYS, isGovernanceDraftStale, retiredDraftReason } from "@/lib/storymap/governance";
import { PRD_SCHEMA } from "@/lib/storymap/doc/schemas/prd";
import type { BoardConfig, Card, GovernanceArtifact, GovernanceChange, GovernanceDraft } from "@/lib/storymap/types";
import type { KeepaliveNowResult } from "@/lib/storymap/runner/capacity-service";
export { approvalRequesterText } from "@/lib/storymap/approval-requester";
// O substantivo curto de cada kind («Precisa de você: Aprovação») — mora no módulo de texto do Inbox (lib, client-safe)
// para o sinal do card (lib/storymap/inbox/card-signal.ts) o ler sem a lib importar componentes; a tela o lê daqui.
export { INBOX_KIND_NOUN } from "@/lib/storymap/inbox/copy";

// ── A proposta de governança como DECISÃO ────────────────────────────────────────────────────────
//
// O item de governança mostrava o rascunho INTEIRO antes dos botões: num PRD longo o Aprovar
// ficava muito abaixo da dobra no celular, e o dono não o achava. A tela passa a dizer primeiro O QUE
// está em decisão — "Aprovar o PRD do board — 16 seções" — e o documento vem depois, recolhido.
// Estas funções são a parte PURA disso: o que a manchete diz e como as seções se contam.

/** O objeto da decisão, por artefato — o complemento de "Aprovar …". Exaustivo (o Record obriga). */
const GOVERNANCE_SUBJECT: Record<GovernanceArtifact, string> = {
  prd: "o PRD do board",
  positioning: "o posicionamento",
  businessMetric: "a métrica de negócio",
  desiredOutcome: "o resultado-alvo",
  canvas: "o Business Model Canvas",
  canvasTags: "as etiquetas do canvas",
  releases: "as releases",
  personas: "as personas",
};

/** O mesmo, curto — para a proposta que mexe em mais de um artefato ("PRD + Business Model Canvas"). */
const GOVERNANCE_SHORT: Record<GovernanceArtifact, string> = {
  prd: "PRD",
  positioning: "posicionamento",
  businessMetric: "métrica de negócio",
  desiredOutcome: "resultado-alvo",
  canvas: "Business Model Canvas",
  canvasTags: "etiquetas do canvas",
  releases: "releases",
  personas: "personas",
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * As SEÇÕES que a proposta toca, na ordem em que aparecem, sem repetição. No PRD a unidade é a seção
 * de TOPO do documento: uma subseção ("Objetivos · Métrica de negócio") conta como a seção que a contém
 * — é assim que o dono lê o PRD, e é por isso que um rascunho de 20 mudanças é "16 seções". Nos outros
 * artefatos, cada campo tocado é uma unidade, com o rótulo que o proponente deu.
 */
export function governanceSections(changes: readonly GovernanceChange[]): string[] {
  const seen = new Map<string, string>();
  for (const c of changes) {
    if (c.artifact === "prd" && c.field) {
      const rule = PRD_SCHEMA.sections.find((s) => s.key === c.field);
      const top = rule?.parent ? PRD_SCHEMA.sections.find((s) => s.key === rule.parent) : rule;
      const key = `prd:${top?.key ?? c.field}`;
      if (!seen.has(key)) seen.set(key, top?.label ?? c.label?.trim() ?? c.field);
      continue;
    }
    const key = `${c.artifact}:${c.field ?? ""}`;
    if (!seen.has(key)) seen.set(key, c.label?.trim() || (c.field ? `${c.artifact}.${c.field}` : GOVERNANCE_SHORT[c.artifact]));
  }
  return [...seen.values()];
}

/**
 * O TAMANHO da proposta na unidade de quem lê: "16 seções" no PRD, "3 blocos" no Business Model Canvas, "2 mudanças" no
 * resto (e na proposta que mexe em mais de um artefato). PURA. É a mesma conta no título do item do Inbox e no
 * aviso da tela do documento — o dono lê "16 seções" nos dois lugares, ou desconfia que são propostas diferentes.
 */
export function governanceScope(changes: readonly GovernanceChange[]): string {
  const artifacts = new Set(changes.map((c) => c.artifact));
  if (artifacts.size === 1 && artifacts.has("prd")) return plural(governanceSections(changes).length, "seção", "seções");
  if (artifacts.size === 1 && artifacts.has("canvas") && changes.every((c) => c.field)) {
    return plural(governanceSections(changes).length, "bloco", "blocos");
  }
  return plural(changes.length, "mudança", "mudanças");
}

export interface GovernanceDecision {
  /** o que está em decisão, numa linha: "Aprovar o PRD do board — 16 seções, 1 conflito". */
  headline: string;
  /** as seções tocadas ({@link governanceSections}). */
  sections: string[];
  /** o rótulo do botão que abre o rascunho recolhido. */
  readLabel: string;
}

/**
 * A proposta de governança dita como DECISÃO — a manchete, as seções e o rótulo do "ler o rascunho".
 * PURA. `null` quando a proposta não traz mudança nenhuma (a tela cai no rótulo do kind).
 */
export function governanceDecision(item: Pick<GovernanceCockpitItem, "changes" | "conflicts">): GovernanceDecision | null {
  const changes = item.changes ?? [];
  if (changes.length === 0) return null;
  const sections = governanceSections(changes);
  const artifacts = [...new Set(changes.map((c) => c.artifact))];
  const unit = governanceScope(changes);

  let headline: string;
  if (artifacts.length > 1) {
    headline = `Aprovar mudanças no board — ${artifacts.map((a) => GOVERNANCE_SHORT[a]).join(" + ")}`;
  } else if (artifacts[0] === "prd") {
    headline = `Aprovar ${GOVERNANCE_SUBJECT.prd} — ${unit}`;
  } else if (artifacts[0] === "canvas" && changes.every((c) => c.field)) {
    headline = `Aprovar ${GOVERNANCE_SUBJECT.canvas} — ${unit}`;
  } else {
    headline = `Aprovar ${GOVERNANCE_SUBJECT[artifacts[0]]}${changes.length > 1 ? ` — ${unit}` : ""}`;
  }

  const conflicts = item.conflicts?.length ?? 0;
  if (conflicts > 0) {
    const c = plural(conflicts, "conflito", "conflitos");
    headline += headline.includes(" — ") ? `, ${c}` : ` — ${c}`;
  }

  const readLabel = artifacts.length === 1 && artifacts[0] === "prd" ? `Ler o rascunho completo (${unit})` : `Ver o antes e depois (${unit})`;
  return { headline, sections, readLabel };
}

// ── A proposta pendente vista de DENTRO do documento ─────────────────────────────────────────────
//
// O dono abriu o PRD e leu a versão aprovada sem saber que uma nova esperava um clique no Inbox. A tela de
// um documento governado avisa: que existe, o tamanho, quem propôs — e leva à página do item, onde se decide.

/** Uma linha do aviso: o que a proposta é e para onde o botão leva. Serializável (vai do servidor à tela). */
export interface DocProposalNotice {
  draftId: string;
  /** a página do item de governança no Inbox — onde se lê o rascunho e se aprova. */
  href: string;
  /** "16 seções · proposta por um agente (harness-plan) · em 11/03". */
  detail: string;
}

/** A frase do aviso. PURA. */
export function docProposalHeadline(count: number): string {
  const what = count === 1 ? "uma proposta pendente" : `${count} propostas pendentes`;
  return `Há ${what} para este documento — o que você vê abaixo é a versão aprovada.`;
}

/**
 * Uma linha por proposta, na ordem recebida. PURA. `drafts` já vem recortado às mudanças do documento
 * (`pendingDraftsForDoc`), então o tamanho é o DESTE documento. Quem propôs sai de `origin.skill`: a UI não o
 * preenche, `propose_change` sim — é a mesma régua que separa agente de humano em `withdrawRefusal`.
 */
export function docProposalNotices(
  drafts: readonly Pick<GovernanceDraft, "id" | "changes" | "origin" | "createdAt">[],
  boardId: string,
): DocProposalNotice[] {
  return drafts.map((d) => {
    const skill = d.origin?.skill?.trim();
    const day = dayMonth(d.createdAt);
    const detail = [
      governanceScope(d.changes),
      skill ? `proposta por um agente (${skill})` : "proposta por uma pessoa",
      day ? `em ${day}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { draftId: d.id, href: inboxItemHref(boardId, governanceItemId(d.id)), detail };
  });
}

/** "11/03" de uma data ISO (`YYYY-MM-DD…`), ou `null` — o dia sem fuso: é a data que o sidecar gravou. */
function dayMonth(iso: string | null | undefined): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[2]}/${m[1]}` : null;
}

/** O dia de um INSTANTE (ISO com hora) no fuso do dono — um marcador que a tela formata; uma data pura (YYYY-MM-DD)
 *  já é o dia, e vai literal. Cortar o dia do ISO em UTC errava por um a partir das 21h de São Paulo. PURA. */
function dayOf(iso: string | null | undefined): string | null {
  if (iso && /T\d{2}:\d{2}/.test(iso) && Number.isFinite(Date.parse(iso))) return dayToken(iso);
  return dayMonth(iso);
}

// ── O item que não está no Inbox ─────────────────────────────────────────────────────────────────
//
// A página do item dizia «Este item já foi resolvido» para QUALQUER id que não achasse — inclusive o de um link
// quebrado para um item que seguia pendente. Ela passa a dizer só o que sabe.

export interface InboxAbsentState {
  title: string;
  detail: string;
  /** B8 — para onde o desfecho aponta (ex.: a proposta mais nova que substituiu esta). */
  href?: string;
  hrefLabel?: string;
  /** onda 2 — o «Desfazer» do recibo, quando o dono decidiu isto pelo Inbox e a ação volta atrás. */
  undo?: { receiptId: string; label: string };
}

/**
 * O que a página de um item AUSENTE diz. PURA. `draft` é a proposta de governança em disco quando o id era
 * `gov:<id>` e ela existe (lê-la é um arquivo só); aí o desfecho é FATO — aprovada, rejeitada, retirada, vencida.
 * Sem ela (outro kind, ou nada em disco), a página não sabe se o item foi resolvido ou se o link está quebrado, e
 * diz exatamente isso. Uma proposta pendente e dentro do prazo que não está na lista também não ganha desfecho
 * inventado.
 */
export function inboxAbsentState(
  draft: (Pick<GovernanceDraft, "status" | "createdAt" | "decidedAt" | "approvedBy" | "withdrawnBy" | "supersededBy"> & Partial<Pick<GovernanceDraft, "changes">>) | null,
  now: number = Date.now(),
  /** o board — para apontar a página de uma proposta que substituiu esta (B8). */
  boardId?: string,
): InboxAbsentState {
  const day = dayMonth(draft?.decidedAt);
  const when = day ? ` em ${day}` : "";
  // B8 — substituída por uma proposta mais nova sobre as mesmas seções: o link velho diz isso e leva à nova.
  if (draft?.status === "rejected" && draft.supersededBy) {
    return {
      title: "Esta proposta foi substituída por uma mais nova.",
      detail: `Uma proposta mais nova sobre as mesmas seções tomou o lugar dela${when} — é essa que espera a sua decisão.`,
      ...(boardId ? { href: inboxItemHref(boardId, governanceItemId(draft.supersededBy)), hrefLabel: "Abrir a proposta nova" } : {}),
    };
  }
  if (draft?.status === "approved") {
    const peer = draft.approvedBy?.startsWith("peer:") ? " por um revisor par" : "";
    return { title: "Esta proposta já foi aprovada.", detail: `Aprovada${when}${peer} — as mudanças já valem no board.` };
  }
  if (draft?.status === "rejected" && draft.withdrawnBy) {
    return { title: "Esta proposta foi retirada.", detail: `Retirada por quem a propôs${when} — o board ficou como estava.` };
  }
  if (draft?.status === "rejected") {
    return { title: "Esta proposta foi rejeitada.", detail: `Rejeitada${when} — o board ficou como estava.` };
  }
  const retired = draft ? retiredDraftReason(draft) : null;
  if (retired) return { title: "Esta proposta venceu sem decisão.", detail: retired };
  if (draft?.status === "pending" && isGovernanceDraftStale(draft, now)) {
    return {
      title: "Esta proposta venceu sem decisão.",
      detail:
        `Ficou mais de ${GOVERNANCE_DRAFT_TTL_DAYS} dias pendente e saiu do Inbox — o board ficou como estava. ` +
        "Se ela ainda fizer sentido, peça uma nova.",
    };
  }
  return {
    title: "Este item não está no Inbox.",
    detail: "Ele pode já ter sido resolvido — ou o link pode estar quebrado.",
  };
}

/** O que se lê de um pedido de aprovação em disco para dizer o desfecho dele (approvals.ts). */
export interface ApprovalOutcomeFacts {
  status: "pending" | "granted" | "rejected" | "consumed" | "expired";
  requestedAt?: string;
  expiresAt?: string;
  decidedAt?: string;
}

/**
 * B11 (auditoria do Inbox) — a página de um PEDIDO de agente (`apr:<id>`) que saiu do Inbox diz o
 * desfecho que o sidecar sabe — autorizado, executado, negado, vencido —, em vez de «pode já ter sido resolvido — ou o
 * link pode estar quebrado». Sem isso, um pedido que vence em silêncio descarta o trabalho do agente sem
 * ninguém saber. PURA. `null` (sem sidecar) ⇒ o estado genérico.
 */
export function approvalAbsentState(req: ApprovalOutcomeFacts | null): InboxAbsentState {
  if (!req) return inboxAbsentState(null);
  const day = dayOf(req.decidedAt);
  const when = day ? ` em ${day}` : "";
  switch (req.status) {
    case "granted":
      return { title: "Este pedido foi autorizado.", detail: `Autorizado${when} — o agente pode executar a ação uma vez, com os mesmos argumentos.` };
    case "consumed":
      return { title: "Este pedido foi autorizado e usado.", detail: `Autorizado${when}; o agente já executou a ação.` };
    case "rejected":
      return { title: "Este pedido foi negado.", detail: `Negado${when} — o agente seguiu sem a ação.` };
    case "expired": {
      const exp = dayOf(req.expiresAt);
      return {
        title: "Este pedido venceu sem decisão.",
        detail: `Ficou 24 horas pendente${exp ? ` (até ${exp})` : ""} e saiu do Inbox — o agente não executou a ação. Se ela ainda fizer sentido, o agente pode pedir de novo.`,
      };
    }
    default:
      return inboxAbsentState(null);
  }
}

/**
 * Onda 2, passo 5 — o item saiu do Inbox porque O DONO decidiu: a página diz o que ele decidiu e o que aconteceu, com o
 * «Desfazer» quando ainda vale. PURA. Os instantes vão como marcadores ({t:…}) — a tela formata no fuso de quem lê.
 */
export function receiptAbsentState(r: InboxReceiptRecord, undoneAt?: string | null): InboxAbsentState {
  if (undoneAt) {
    return {
      title: "Você decidiu isto — e depois desfez.",
      detail: `${r.text} Você decidiu ${timeToken(r.at)} e desfez ${timeToken(undoneAt)}; se o item voltar a precisar de você, ele reaparece no Inbox.`,
    };
  }
  return {
    title: "Você já decidiu isto.",
    detail: `${r.text} Decidido ${timeToken(r.at)}.`,
    ...(r.undo ? { undo: { receiptId: r.id, label: receiptUndoLabel(r.undo) } } : {}),
  };
}

/** Onda 2 — a decisão que o SISTEMA tomou (`sd:<id>`) e que saiu do Acompanhar: quem decidiu, o quê e por quê. PURA. */
export function systemDecisionAbsentState(d: Pick<SystemDecision, "agent" | "what" | "why" | "at">, undoneAt?: string | null): InboxAbsentState {
  return {
    title: undoneAt ? "O sistema decidiu isto — e você desfez." : "O sistema decidiu isto.",
    detail: `${agentLabel(d.agent)}, ${timeToken(d.at)}: ${d.what}${d.why ? ` — por quê: ${d.why}` : ""}.${undoneAt ? ` Você desfez ${timeToken(undoneAt)}.` : ""}`,
  };
}

/**
 * Onda 2 — nenhum registro diz quem resolveu, mas o CARD do item existe: a página diz onde ele está agora (o desfecho
 * que o card mostra), em vez de «pode já ter sido resolvido — ou o link pode estar quebrado». PURA.
 */
export function cardAbsentState(card: Pick<Card, "id" | "title" | "status">, config: Pick<BoardConfig, "id" | "statuses">): InboxAbsentState {
  const where = config.statuses.find((s) => s.id === card.status)?.name;
  return {
    title: "Este item saiu do Inbox.",
    detail: where
      ? `Ninguém registrou uma decisão aqui; ${quoted(card.title)} está agora em «${where}».`
      : `Ninguém registrou uma decisão aqui; ${quoted(card.title)} segue no board.`,
    href: cardHref(config.id, card.id),
    hrefLabel: "Abrir o card",
  };
}

/** B11 — o aviso do HOST que saiu do Inbox (o medidor de cota parado): se ele não está mais lá, o medidor voltou. */
export function hostNoticeAbsentState(itemId: string): InboxAbsentState | null {
  if (!itemId.startsWith("host:meter-stalled:")) return null;
  return {
    title: "O medidor de cota voltou a ler.",
    detail: "Este aviso não está mais ativo: a automação deixou de ser retida por ele.",
  };
}

/**
 * Até `max` nomes e o resto contado — "Resumo executivo, Problema, Público e mais 13". PURA. Para caber
 * numa linha do Inbox sem virar outra parede de texto.
 */
export function previewList(names: readonly string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
}

/**
 * O que o toast diz depois do "Renovar agora" — o desfecho do governador em uma frase, e se é sucesso. PURA.
 * O `not-configured` diz a quem pedir e o quê: o dono no celular não tem como definir o keepalive, o operador
 * do host tem.
 */
export function meterRenewMessage(r: KeepaliveNowResult): { tone: "success" | "warning" | "error"; text: string } {
  const why = r.detail ? `: ${r.detail}` : "";
  switch (r.outcome) {
    case "renewed":
      return { tone: "success", text: "Medidor renovado — a automação volta a entrar." };
    case "still-stalled":
      return { tone: "warning", text: "O keepalive rodou, mas o medidor segue parado — o token do proxy não renovou." };
    case "failed":
      return { tone: "error", text: `O keepalive falhou${why}` };
    case "not-configured":
      return {
        tone: "warning",
        text: "Keepalive não configurado — peça ao operador do host para definir AGILEHARNESS_METER_KEEPALIVE.",
      };
    case "no-meter":
      return { tone: "warning", text: `Sem medidor neste host${why}` };
    default: {
      const exhaustive: never = r.outcome;
      return exhaustive;
    }
  }
}

// ── The feed's tri-state ─────────────────────────────────────────────────────────────────────────
//
// The design reduces every kanban row to THREE readings — "agindo", "aguardando você", "em pausa" —
// and that is the only thing the row's colour encodes. Deliberately NOT a per-step gerund table:
// StatusDef carries no progressive label (only `name`), and inventing a statusId→gerúndio map would
// be a SECOND source of step naming, guaranteed to drift the first time someone renames a step (and
// dead weight for a board that doesn't inherit the canonical `_base` pipeline). The step keeps its
// real name; the tri-state carries the state.

export type FeedState = "agindo" | "voce" | "pausa";

/**
 * `voce` wins over `agindo` on purpose: a card can be mid-run AND holding an open question, and the
 * whole thesis of this screen is that the human's attention is the scarce resource — a row that needs
 * you must never hide behind "it's busy, don't worry".
 */
export function feedState({ live, needsYou }: { live: boolean; needsYou: boolean }): FeedState {
  if (needsYou) return "voce";
  if (live) return "agindo";
  return "pausa";
}

/** Dot colour per state — emerald pulses (see {@link feedStatePulses}), amber waits, grey rests. */
export const FEED_STATE_DOT: Record<FeedState, string> = {
  agindo: "bg-emerald-500",
  voce: "bg-amber-400",
  pausa: "bg-fg-subtle",
};

/** Step-label ink per state. `text-accent` IS the design's amber (--accent), not a second colour. */
export const FEED_STATE_TEXT: Record<FeedState, string> = {
  agindo: "text-emerald-700 dark:text-emerald-400",
  voce: "text-accent",
  pausa: "text-fg-subtle",
};

/** Only a genuinely moving row animates — a pulsing dot that means nothing is just noise. */
export function feedStatePulses(state: FeedState): boolean {
  return state === "agindo";
}
