// Presentational vocabulary for the "Início Agêntico" home — a thin, PURE layer over the CockpitItem
// taxonomy (lib/storymap/demands.ts) plus the feed's tri-state. Kept out of CockpitView.tsx (a heavy
// client file) so the inbox, the feed and the per-item page share ONE vocabulary and can be
// unit-tested without React.

import type { CockpitGroup, CockpitItem, CockpitItemKind, GovernanceCockpitItem } from "@/lib/storymap/demands";
import { governanceItemId } from "@/lib/storymap/demands";
import { inboxItemHref } from "@/lib/storymap/deep-links";
import { PRD_SCHEMA } from "@/lib/storymap/doc/schemas/prd";
import type { GovernanceArtifact, GovernanceChange, GovernanceDraft } from "@/lib/storymap/types";
import type { KeepaliveNowResult } from "@/lib/storymap/runner/capacity-service";

/**
 * A short human LABEL per cockpit kind — the eyebrow of an attention row/detail. EXHAUSTIVE over
 * CockpitItemKind (TS enforces it via the Record): a new kind won't compile until it has a label,
 * the same discipline the KIND_RENDERER registry uses.
 */
export const COCKPIT_KIND_LABEL: Record<CockpitItemKind, string> = {
  question: "Pergunta",
  blocker: "Bloqueio",
  finding: "Achado",
  "deploy-failed": "Deploy falhou",
  gate: "Aprovar & avançar",
  approval: "Aprovação do Jido",
  review: "Revisão",
  stuck: "Run travado",
  conflict: "Conflito de merge",
  proposal: "Proposta de captura",
  design: "Design para revisar",
  governance: "Mudança de board",
  "deploy-unsettled": "Deploy não confirmado",
  "release-aging": "Release parada em stage",
  "merge-failed": "Merge falhou",
  "proxy-audit": "Resposta do proxy",
  "delivery-audit": "Entrega autônoma",
  "meter-stalled": "Medidor de cota parado",
};

/**
 * O PEDIDO — o que se espera de VOCÊ neste item, em uma frase imperativa curta. EXAUSTIVO sobre
 * CockpitItemKind (o Record obriga).
 *
 * Por que existe (o cabeçalho do Inbox mostrava TRÊS taxonomias enfileiradas — "Aprovar ·
 * Proposta de captura · Capturando"): a LANE ("Aprovar"), o KIND ("Proposta de captura") e o STATUS
 * do pipeline ("Capturando") são três recortes da mesma coisa, e lidos em sequência parecem três
 * categorias concorrentes em vez de uma informação. O pedido FUNDE lane + kind numa frase que diz o
 * que fazer; a lane sobrevive como COR (o ponto), não como palavra; e o status vira exceção
 * (ver {@link cockpitItemShowsStatus}).
 *
 * Onde há LARGURA (o cartão aberto, a página do item) mostramos o PEDIDO; onde não há (a folha da
 * home, o popover da barra) fica o SUBSTANTIVO de {@link COCKPIT_KIND_LABEL} — que é o mesmo
 * vocabulário, encurtado, nunca um sinônimo novo.
 */
export const COCKPIT_DEMAND_LABEL: Record<CockpitItemKind, string> = {
  question: "Responder pergunta",
  blocker: "Resolver bloqueio",
  finding: "Triar achado",
  "deploy-failed": "Resolver deploy que falhou",
  gate: "Aprovar e avançar",
  approval: "Autorizar o Jido",
  review: "Revisar triagem",
  stuck: "Destravar run",
  conflict: "Resolver conflito de merge",
  proposal: "Revisar proposta de captura",
  design: "Aprovar design",
  governance: "Aprovar mudança de board",
  "deploy-unsettled": "Confirmar deploy",
  "release-aging": "Publicar release parada",
  "merge-failed": "Resolver merge que falhou",
  "proxy-audit": "Auditar resposta do proxy",
  "delivery-audit": "Auditar entrega autônoma",
  "meter-stalled": "Religar o medidor de cota",
};

/**
 * O status do PIPELINE (a coluna do card) diz algo sobre este item, ou é ruído?
 *
 * É ruído em dois casos, e o teste é sempre o mesmo — o chip acrescenta alguma coisa ao pedido?
 *   1. a coluna é CONSTANTE por construção: uma proposta vive num contêiner efêmero eternamente em
 *      "Capturando"; uma triagem de baixa confiança está sempre em "Triagem". Um valor que nunca
 *      varia não informa — só repete, ao lado do pedido, uma palavra que ele já contém.
 *   2. não existe card: governança e a autorização do Jido são itens de BOARD.
 * A regra era um `if (kind === "proposal")` escrito à mão dentro do CockpitItemRow, invisível para as
 * outras superfícies; aqui ela é UMA e vale para todas.
 */
const STATUS_IS_NOISE = new Set<CockpitItemKind>(["proposal", "review", "governance", "approval"]);

export function cockpitItemShowsStatus(item: Pick<CockpitItem, "kind" | "cardId">): boolean {
  if (STATUS_IS_NOISE.has(item.kind)) return false;
  return Boolean(item.cardId);
}

/** The lane DOT colour class (matches CockpitView's LANE_DOT — the three attention lanes). */
export const LANE_DOT_CLS: Record<CockpitGroup, string> = {
  travado: "bg-rose-500",
  pergunta: "bg-amber-400",
  aprovar: "bg-emerald-500",
};

/** The lane LABEL text colour class (matches CockpitView's LANE_LABEL_COLOR). */
export const LANE_TEXT_CLS: Record<CockpitGroup, string> = {
  travado: "text-rose-600 dark:text-rose-400",
  pergunta: "text-amber-700 dark:text-amber-400",
  aprovar: "text-emerald-700 dark:text-emerald-400",
};

/**
 * A one-line TITLE for an attention item: the underlying card's title, or the kind label for a
 * board-level item that carries no card (governance drafts, the copiloto's own approval requests).
 *
 * A proposta de governança é a exceção: o `cardTitle` dela é a lista de chaves que ela toca
 * (`draftTitle` — "prd.resumo + prd.problema + …", 20 chaves num PRD inteiro), um identificador para
 * máquina que no Inbox virava um título de cinco linhas. O título dela é a DECISÃO
 * ({@link governanceDecision}).
 */
export function cockpitItemTitle(item: CockpitItem): string {
  if (item.kind === "governance") {
    const decision = governanceDecision(item);
    if (decision) return decision.headline;
  }
  const title = item.cardTitle?.trim();
  return title && title.length > 0 ? title : COCKPIT_KIND_LABEL[item.kind];
}

// ── A proposta de governança como DECISÃO ────────────────────────────────────────────────────────
//
// O item de governança mostrava o rascunho INTEIRO antes dos botões: num PRD de 16 seções o Aprovar
// ficava a ~8.800 px do topo no celular, e o dono não o achava. A tela passa a dizer primeiro O QUE
// está em decisão — "Aprovar o PRD do board — 16 seções" — e o documento vem depois, recolhido.
// Estas funções são a parte PURA disso: o que a manchete diz e como as seções se contam.

/** O objeto da decisão, por artefato — o complemento de "Aprovar …". Exaustivo (o Record obriga). */
const GOVERNANCE_SUBJECT: Record<GovernanceArtifact, string> = {
  prd: "o PRD do board",
  positioning: "o posicionamento",
  businessMetric: "a métrica de negócio",
  desiredOutcome: "o resultado-alvo",
  canvas: "o Lean Canvas",
  canvasTags: "as etiquetas do Lean Canvas",
  releases: "as releases",
  personas: "as personas",
};

/** O mesmo, curto — para a proposta que mexe em mais de um artefato ("PRD + Lean Canvas"). */
const GOVERNANCE_SHORT: Record<GovernanceArtifact, string> = {
  prd: "PRD",
  positioning: "posicionamento",
  businessMetric: "métrica de negócio",
  desiredOutcome: "resultado-alvo",
  canvas: "Lean Canvas",
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
 * O TAMANHO da proposta na unidade de quem lê: "16 seções" no PRD, "3 blocos" no Lean Canvas, "2 mudanças" no
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
  /** "16 seções · proposta por um agente (harness-plan) · em 25/09". */
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
    const day = /^\d{4}-(\d{2})-(\d{2})/.exec(d.createdAt);
    const detail = [
      governanceScope(d.changes),
      skill ? `proposta por um agente (${skill})` : "proposta por uma pessoa",
      day ? `em ${day[2]}/${day[1]}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { draftId: d.id, href: inboxItemHref(boardId, governanceItemId(d.id)), detail };
  });
}

/**
 * Até `max` nomes e o resto contado — "Resumo executivo, Problema, Público e mais 13". PURA. Para caber
 * numa linha do Inbox sem virar outra parede de texto.
 */
export function previewList(names: readonly string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} e mais ${names.length - max}`;
}

/** First non-empty trimmed string, or "" — keeps the per-kind branches below to one expression each. */
function firstText(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return t;
  }
  return "";
}

/**
 * The item's own WORDS — what the pile shows under the title so the operator can decide whether to
 * open it without opening it. Each kind keeps its detail in a differently-named field (a question has
 * `prompt`, a blocker a finding `title`, a proposal a `summary`…), so this is the ONE place that maps
 * the union onto a single line of prose.
 *
 * EXHAUSTIVE by construction: the `default` branch assigns to `never`, so adding a CockpitItemKind
 * without a branch here fails to compile — the same discipline as {@link COCKPIT_KIND_LABEL}.
 * Returns "" when the kind genuinely carries no prose; callers fall back to the kind label.
 */
/**
 * A frase do medidor de cota parado — a que o dono lê no Inbox, com a hora LOCAL da última leitura boa. Mora aqui
 * (e não na projeção pura) porque a hora é do fuso de quem lê.
 */
export function meterStallLine(stalledSince: number): string {
  return `medidor de cota parado desde ${stallClock(stalledSince)} — automação retida; causa provável: sem tráfego pelo proxy / token expirado`;
}

/** `HH:MM` da última leitura boa, no fuso de quem LÊ. */
function stallClock(stalledSince: number): string {
  return new Date(stalledSince).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * A linha ÚNICA do aviso compacto do medidor no Inbox — o fato e o efeito, sem a causa (que fica no "por quê",
 * recolhido). O aviso é do HOST e se repete em todo board: ele não pode empurrar as decisões para fora da
 * primeira tela.
 */
export function meterStallHeadline(stalledSince: number): string {
  return `Medidor de cota parado desde ${stallClock(stalledSince)} — automação retida`;
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

export function cockpitItemSnippet(item: CockpitItem): string {
  switch (item.kind) {
    case "question":
      return firstText(item.prompt, item.context, item.recommendation);
    case "blocker":
    case "finding":
    case "deploy-failed":
      return firstText(item.title, item.suggestion);
    case "gate":
      return firstText(item.gateLabel);
    case "approval":
      return firstText(item.note, item.tool && `Ferramenta: ${item.tool}`, item.gateLabel);
    case "review":
      return "Triagem de baixa confiança — aceitar, recusar ou apontar a duplicata.";
    case "stuck":
      return firstText(item.outcome, item.trigger && `Run de ${item.trigger} não terminou.`);
    case "conflict":
      return item.conflictKind === "merge-gate-failed"
        ? "O gate do merge train reprovou este run."
        : "O merge train não conseguiu integrar sozinho.";
    case "proposal":
      return firstText(
        item.summary,
        item.items.length > 0 ? `${item.items.length} cards propostos.` : undefined,
      );
    case "design":
      return item.artifacts.length > 0
        ? `${item.artifacts.length} artefato(s) de design para aprovar.`
        : "Design para revisar.";
    case "governance":
      return firstText(
        item.reason,
        item.changes.length > 0 ? `${item.changes.length} mudança(s) no board.` : undefined,
      );
    case "deploy-unsettled":
      return "Deploy disparado, mas ninguém confirmou que subiu.";
    case "release-aging":
      return `Código aprovado parado em stage há ${item.ageDays}d — falta publicar.`;
    case "merge-failed":
      return firstText(item.failureReason, `Branch ${item.branch} ficou fora da main.`);
    case "proxy-audit":
      return firstText(item.prompt && `${item.prompt} → ${item.answer}`, item.answer);
    case "delivery-audit":
      return firstText(item.proof, "Entregue sem aprovação prévia (modo ultra) — caiu na amostra de auditoria.");
    case "meter-stalled":
      return meterStallLine(item.stalledSince);
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

/**
 * How long the item has been waiting, in ms, or `null` when it carries no usable timestamp.
 * `since` is a best-effort ISO string (demands.ts) — a malformed one must read as "no age", never NaN.
 */
export function cockpitItemWaitingMs(item: CockpitItem, now: number): number | null {
  const since = item.since;
  if (!since) return null;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
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
