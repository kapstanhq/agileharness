// A RECUPERAÇÃO TÉCNICA do Jido num board SÓ-NEGÓCIO — o passo depois do limite (política só-negócio; a D13, decidida:
// sim). Núcleo DI: o planejador e o card de conserto são PUROS; o executor recebe as deps (produção em
// orchestrator-run.ts, junto das outras deps do tick).
//
// O ciclo inteiro:
//   1. o tick acorda pelos itens de recuperação (demands.ts `isBusinessRecoveryItem` — execução travada, conflito,
//      merge falho, publicação falha, efeito que não rodou; nunca gate genérico) e o LLM tenta de novo;
//   2. cada tentativa que não move o item cresce o streak dele (a atribuição por tentativa de sempre, WS-12);
//   3. no LIMITE DO TIPO (`recoveryRetryLimit`: efeito 1, o resto 2) o item sai do conjunto do tick
//      (`itemsInRecoveryBackoff`) — e ESTE passe, a $0 e sem LLM, abre UM card de conserto na Triagem com a
//      evidência, registra no estado do board (nunca de novo para o mesmo item) e no registro de decisões, e o
//      fluxo segue. O juiz da triagem (só-negócio) aceita o card de conserto pelo PRD como qualquer outro.
// Nunca pergunta ao dono: uma falha técnica não é decisão de negócio.
//
// UM CARD DE CONSERTO POR CAUSA. Uma publicação parada é do PACOTE: seis cards em «Liberar» paravam pela mesma
// lacuna de configuração, e a chave por item abriria seis cards de conserto para uma causa. A chave do conserto de uma
// publicação parada é a causa dela (`deployCause.causeKey`, deploy-blocks.ts); o card de conserto se relaciona a todos os
// cards que a causa segura.

import { copilotTier } from "@/lib/storymap/copilot/tier";
import { isBusinessOnly } from "@/lib/storymap/decision-class";
import { isBusinessRecoveryItem, recoveryRetryLimit, type CockpitItem, type CockpitItemKind } from "@/lib/storymap/demands";
import { makeDraftCard } from "@/lib/storymap/draft";
import { openDeployFailure } from "./deploy-blocks";
import { inferTriagePlacement } from "@/lib/storymap/triage/parse";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { itemsInRecoveryBackoff, markRecoveryHandoff, type OrchestratorState } from "./orchestrator-state";

/**
 * A chave do conserto de um item: a CAUSA, quando o item é uma publicação parada cujo finding a carrega (um card de
 * conserto por causa); senão o próprio item. PURA.
 */
export function recoveryKeyOf(item: CockpitItem, cards: readonly Card[]): string {
  if (item.kind === "deploy-failed") {
    const cause = openDeployFailure(cards.find((c) => c.id === item.cardId) ?? { findings: [] })?.deployCause;
    if (cause) return `causa:${item.boardId}:${cause.causeKey}`;
  }
  return item.id;
}

/** Um conserto a abrir: o item que o representa (o primeiro a esgotar), a chave e os cards que a causa segura. */
export interface RecoveryHandoff {
  key: string;
  item: CockpitItem;
  cardIds: string[];
}

/**
 * Os consertos a abrir: uma chave por vez (a causa ou o item), quando ALGUM item dela esgotou o limite e ela ainda não
 * ganhou o card de conserto. Os cards de todos os itens da chave vão junto (o card de conserto se relaciona a todos). PURA.
 */
export function planRecoveryHandoffs(
  items: readonly CockpitItem[],
  backoff: ReadonlySet<string>,
  state: OrchestratorState,
  keyOf: (item: CockpitItem) => string = (i) => i.id,
): RecoveryHandoff[] {
  const groups = new Map<string, CockpitItem[]>();
  for (const i of items) groups.set(keyOf(i), [...(groups.get(keyOf(i)) ?? []), i]);
  const out: RecoveryHandoff[] = [];
  for (const [key, group] of groups) {
    const exhausted = group.find((i) => backoff.has(i.id));
    if (!exhausted || state.recoveryHandoffs?.[key]) continue;
    out.push({ key, item: exhausted, cardIds: [...new Set(group.map((i) => i.cardId).filter(Boolean))] });
  }
  return out;
}

/** Solta o registro dos itens que não estão mais no Inbox. Devolve o MESMO estado quando nada mudou. PURA. */
export function pruneRecoveryHandoffs(state: OrchestratorState, present: ReadonlySet<string>): OrchestratorState {
  const handed = state.recoveryHandoffs;
  if (!handed) return state;
  const kept = Object.fromEntries(Object.entries(handed).filter(([id]) => present.has(id)));
  if (Object.keys(kept).length === Object.keys(handed).length) return state;
  return { ...state, recoveryHandoffs: Object.keys(kept).length ? kept : undefined };
}

/** O que falhou, em português, por tipo. */
const WHAT: Partial<Record<CockpitItemKind, (i: CockpitItem) => string>> = {
  stuck: (i) => `a execução ${i.kind === "stuck" && i.trigger ? `de ${i.trigger} ` : ""}morre`,
  conflict: () => "o conflito de integração não se resolve",
  "merge-failed": () => "a integração falha",
  "deploy-failed": () => "a publicação falha",
  "effect-failed": () => "a ação automática do passo não roda",
};

/** A evidência que o item carrega (o motivo, o detalhe, o título do achado). */
function evidenceOf(i: CockpitItem): string[] {
  const out: string[] = [];
  if (i.kind === "stuck") {
    if (i.reason) out.push(`motivo: ${i.reason}`);
    if (i.outcome && i.outcome !== i.reason) out.push(`detalhe: ${i.outcome}`);
    if (i.evidence?.title) out.push(`diagnóstico: ${i.evidence.title}${i.evidence.detail ? ` — ${i.evidence.detail}` : ""}`);
  }
  if (i.kind === "deploy-failed" || i.kind === "effect-failed") {
    out.push(i.title);
    if (i.kind === "effect-failed" && i.detail) out.push(i.detail);
  }
  if (i.kind === "conflict" && i.runId) out.push(`run ${i.runId}`);
  return out;
}

/**
 * O CARD DE CONSERTO de um item que esgotou o limite: técnico, na quarentena do board (o juiz da triagem decide),
 * relacionado ao card de origem e servindo a mesma história de usuário (inferTriagePlacement), com a evidência no
 * corpo. PURA.
 */
export function buildRecoveryFixCard(
  item: CockpitItem,
  cards: Card[],
  config: BoardConfig,
  opts: { tries: number; now: string; cardIds?: string[] },
): Card {
  const staging = config.statuses.find((s) => s.staging)?.id ?? null;
  const what = WHAT[item.kind]?.(item) ?? "o travamento técnico não se resolve";
  const origin = cards.find((c) => c.id === item.cardId);
  const placement = origin ? inferTriagePlacement("technical", [origin.id], cards) : {};
  // a causa que segura VÁRIOS cards: o conserto nomeia a causa (não o card) e se relaciona a todos eles
  const related = [...new Set([item.cardId, ...(opts.cardIds ?? [])].filter(Boolean))];
  const cause = item.kind === "deploy-failed" ? openDeployFailure(origin ?? { findings: [] })?.deployCause : undefined;
  const where = related.length > 1 && cause ? `na publicação de ${cause.pkg} (${related.length} cards parados)` : `em «${item.cardTitle}»`;
  const draft = makeDraftCard({ type: "story", title: `Conserto: ${what} ${where}`, status: staging, cards });
  const evidence = evidenceOf(item);
  return {
    ...draft,
    storyType: "technical",
    ...(placement.serves ? { serves: placement.serves } : {}),
    links: related.map((to) => ({ rel: "relates-to", to })),
    labels: ["recuperacao-tecnica"],
    body: [
      "## Travamento que o Jido não destravou",
      "",
      `- Card: ${item.cardId || "—"} — ${item.cardTitle}`,
      ...(related.length > 1 ? [`- A mesma causa segura também: ${related.filter((c) => c !== item.cardId).join(", ")}`] : []),
      ...(cause ? [`- Causa: ${cause.causeKey} — unidade(s) ${cause.units.join(", ") || "—"}; regra(s) ${cause.rules.join(", ") || "—"}`] : []),
      `- O quê: ${what}`,
      ...evidence.map((e) => `- ${e}`),
      `- O Jido tentou ${opts.tries} tentativa${opts.tries === 1 ? "" : "s"} (o limite deste tipo) em ${opts.now} e abriu este card para`,
      "  consertar a CAUSA. O dono não foi chamado: é uma falha técnica, não uma decisão de negócio.",
    ].join("\n"),
  };
}

export interface BusinessRecoveryDeps {
  readBoardConfig(board: string): Promise<BoardConfig | null>;
  readCards(board: string): Promise<Card[]>;
  /** os itens do Inbox do board (todos — o passe filtra os de recuperação). */
  collectItems(board: string): Promise<CockpitItem[]>;
  readState(board: string): Promise<OrchestratorState>;
  writeState(board: string, state: OrchestratorState): Promise<void>;
  /** cria o card pela porta de sempre (createCardAction) — o card criado, ou null. */
  createCard(board: string, card: Card): Promise<Card | null>;
  /** registra a decisão no registro de decisões do sistema (best-effort). */
  record?(board: string, item: CockpitItem, fixCard: Card): Promise<void>;
  now?(): number;
}

/**
 * O PASSE ($0, sem LLM): num board só-negócio, abre o card de conserto de cada item de recuperação que esgotou o
 * limite, uma vez por item. Nunca lança — um passe que derrubasse o tick seria pior que nenhum.
 */
export async function runBusinessRecoveryPass(deps: BusinessRecoveryDeps, board: string): Promise<{ opened: Array<{ itemId: string; cardId: string }> }> {
  const opened: Array<{ itemId: string; cardId: string }> = [];
  try {
    const config = await deps.readBoardConfig(board);
    if (!config || !isBusinessOnly(null, config)) return { opened };
    const tier = copilotTier(config.orchestrator ?? null);
    const items = (await deps.collectItems(board)).filter((i) => isBusinessRecoveryItem(i, tier));
    const loaded = await deps.readState(board);
    // as publicações paradas se agrupam pela causa (lida dos cards); sem item de publicação, nem lê os cards
    const cards = items.some((i) => i.kind === "deploy-failed") ? await deps.readCards(board) : null;
    const keyOf = (i: CockpitItem) => (cards ? recoveryKeyOf(i, cards) : i.id);
    // O item que SUMIU (o travamento se resolveu, o card andou) solta o registro: se ele voltar um dia, é uma falha
    // nova — o Jido tenta de novo, com o limite, antes de abrir outro card.
    let state = pruneRecoveryHandoffs(loaded, new Set(items.map(keyOf)));
    const plan = planRecoveryHandoffs(items, itemsInRecoveryBackoff(state, items), state, keyOf);
    if (!plan.length) {
      if (state !== loaded) await deps.writeState(board, state);
      return { opened };
    }
    const all = cards ?? (await deps.readCards(board));
    const nowMs = (deps.now ?? Date.now)();
    const iso = new Date(nowMs).toISOString();
    for (const { key, item, cardIds } of plan) {
      const fix = buildRecoveryFixCard(item, all, config, { tries: recoveryRetryLimit(item.kind), now: iso.slice(0, 10), cardIds });
      // PONTO DE EXTENSÃO (WP1, failureOrigin): a falha de origem FERRAMENTA abre o conserto no board da ferramenta, a de
      // origem PRODUTO no board do item. Enquanto a origem não existe, é sempre o board do item.
      const target = board;
      const created = await deps.createCard(target, fix).catch(() => null);
      if (!created) continue;
      state = markRecoveryHandoff(state, key, created.id, iso);
      opened.push({ itemId: item.id, cardId: created.id });
      await deps.record?.(board, item, created).catch(() => {});
    }
    if (state !== loaded) await deps.writeState(board, state);
  } catch {
    /* best-effort: o próximo tick tenta de novo */
  }
  return { opened };
}
