// O CONTRATO do Inbox — o que faz uma entrada MORAR em Decidir, de qual CAUSA ela é, e quando ela deixa de ser
// verdade. PURO e client-safe (só `import type` de módulos de servidor): o modelo do item (decision.ts), a dobra
// (entries.ts) e o coletor (collect.ts) leem daqui, e a lista, o badge, a raia do dono, o push e o Jido leem deles.
//
// Por que existe (ciclo de conserto): o Decidir era costurado em cinco lugares e o único teste de propriedade
// («Decidir ⇒ uma opção habilitada») era satisfeito por «Pedir ao Jido» — que só abre uma conversa. No ar, a lista
// de Decidir misturava decisões de verdade, causas reais sem botão que as resolvesse e ruído. Várias eram a MESMA
// causa (o código sensível de um card segurando a publicação do pacote) contada uma vez por card-vítima; outra era
// um pedido de agente cuja ação já tinha acontecido por outro caminho, e ele seguia pendente.
//
// O INVARIANTE (uma entrada só fica em Decidir se TODAS valem):
//   (A) o dono decide por uma razão de negócio nomeada — o veredito de decision-class.ts (`whoDecides`);
//   (B) há ao menos uma opção habilitada que MUDA o desfecho ({@link hasOutcomeAction}): conversar, ler, abrir e o
//       passo a passo do computador não mudam nada;
//   (C) nenhum ator do sistema resolve (o procurador, o Jido, o disjuntor que já agendou a re-tentativa);
//   (D) é a única entrada da sua causa no board ({@link KIND_CONTRACT} `causeKey`, a dobra de entries.ts);
//   (E) a causa ainda é verdade, segundo fatos JÁ pré-computados ({@link InboxFacts}) — o coletor nunca roda plano.
// Falhou uma ⇒ Acompanhar com quem age a seguir dito com honestidade («sem ninguém cuidando» conta), ou sai do Inbox
// com um recibo em «Resolvido hoje». Nunca some em silêncio.

import type { CockpitItem, CockpitItemKind } from "../demands";
import type { DecisionVerdict } from "../decision-class";
import type { BoardConfig, Card, DeployCause } from "../types";
import type { OwnerApprovalRequest } from "../runner/deploy-proof";
import type { DecisionOption, OptionInvokeKind } from "./decision";
import { quoted } from "./copy";

// ── o que mora no Inbox ──────────────────────────────────────────────────────────────────────────────

/**
 * O aviso da revisão que SOBE a item: num card que toca uma classe do dono (o veredito nomeia a classe), com
 * importância média ou alta (INB-10). Os outros são dívida do card. PURA.
 */
export function isOwnerAdvisory(item: { findingSeverity: string }, verdict: Pick<DecisionVerdict, "decider" | "ownerClass">): boolean {
  return verdict.decider === "owner" && !!verdict.ownerClass && (item.findingSeverity === "high" || item.findingSeverity === "medium");
}

/**
 * O item mora no Inbox? Tudo mora, menos o aviso que não trava nada fora do caso do dono: ele não tem dono nem ação
 * que mude desfecho — é DÍVIDA, visível no card (a lista de avisos dele). Num caso real, vários avisos ocupavam Acompanhar, nenhum
 * triado, sem prazo. Segue no cockpit (o agente autônomo ainda os trata); só o Inbox do dono não os lista.
 *
 * As AMOSTRAS de auditoria (a resposta do procurador, a entrega autônoma) MORAM — em «Os agentes estão cuidando», nunca
 * em Decidir. Decisão do dono de 06/10: quem as revisa são revisores independentes (IA), nunca ele. Mas esse revisor
 * ainda não roda; escondê-las deixava as amostras sem ninguém (e a de entrega pendente segura o próximo sorteio do
 * card). Até ele existir, elas ficam à vista, marcadas «ninguém está revisando» (decision.ts). PURA.
 */
export function isInboxItem(item: CockpitItem, verdict: Pick<DecisionVerdict, "decider" | "ownerClass">): boolean {
  return item.kind !== "finding" || isOwnerAdvisory(item, verdict);
}

// ── (B) a opção que muda o desfecho ──────────────────────────────────────────────────────────────────

/** Invokes que NÃO mudam o desfecho: conversar com o Jido, abrir uma página, ler o status, ver o passo a passo. */
export const NOT_AN_OUTCOME: ReadonlySet<OptionInvokeKind> = new Set<OptionInvokeKind>(["howto", "escalate", "link", "show-publish-status"]);

/** A opção, apertada agora, muda o desfecho do item? Habilitada, fora de leitura e fora de conversa. PURA. */
export function changesOutcome(o: Pick<DecisionOption, "disabled" | "auditCls" | "invoke">): boolean {
  return !o.disabled && o.auditCls !== "read" && !NOT_AN_OUTCOME.has(o.invoke.kind);
}

/** O item tem ao menos uma opção que muda o desfecho? A régua (B) de Decidir — e a da promoção pelo prazo. PURA. */
export function hasOutcomeAction(options: readonly Pick<DecisionOption, "disabled" | "auditCls" | "invoke">[]): boolean {
  return options.some(changesOutcome);
}

/**
 * Descartar trabalho (a integração, o ramo, o card para a lixeira): uma opção legítima, mas NUNCA a principal por
 * sobra — o dono descarta olhando a decisão inteira. (No conflito de integração, a única opção que muda o desfecho é o
 * descarte; promovê-lo a botão cheio verde era o defeito que a revisão do WP4 achou no Kanban.) PURA.
 */
export function isDiscard(invoke: DecisionOption["invoke"]): boolean {
  return (
    invoke.kind === "delete-card" ||
    invoke.kind === "discard-branch" ||
    (invoke.kind === "resolve-merge" && invoke.action === "aborted") ||
    (invoke.kind === "resolve-gate" && invoke.action === "abort")
  );
}

// ── (E) os fatos pré-computados ──────────────────────────────────────────────────────────────────────

/** Uma linha do registro de ações (runner/agent-actions.ts), só o que a régua do pedido lê. */
export interface ExecutedAction {
  at: string;
  tool: string;
  cardId?: string;
  /** a ação humana diz o card na nota («card=<id> · stuck:retry»). */
  note?: string;
  actor?: string;
  /** o desfecho no registro; ausente = executada (as linhas antigas e as do dono não o têm sempre). */
  outcome?: string;
}

/**
 * A linha diz que a ação ACONTECEU? O registro também guarda o pedido que ficou pendente (`pending`), a recusa e o
 * freio — e o próprio pedido de um agente é gravado ali, 20 ms depois de nascer: contá-lo como «a ação já aconteceu»
 * retiraria todo pedido no instante em que ele surge. PURA.
 */
export function actionHappened(a: Pick<ExecutedAction, "outcome">): boolean {
  return !a.outcome || a.outcome === "executed" || a.outcome === "grant-consumed";
}

/**
 * Os fatos de UM board que o contrato lê — pré-computados pelo coletor (collect.ts), nunca medidos aqui. Ausentes (o
 * sinal de um card sozinho, card-signal.ts) ⇒ a régua não julga o que depende deles: o item fica como o card o mostra.
 */
export interface InboxFacts {
  cardsById: ReadonlyMap<string, Card>;
  /** a causa de publicação de cada card com o aviso de publicação aberto: a gravada (deployCause) ou a reconstruída. */
  deployCauseOf: ReadonlyMap<string, DeployCause>;
  /** as causas vivas no livro do board (runner/deploy-blocks.json). null = livro ausente ⇒ não julga a causa por ele. */
  deployLedger: ReadonlySet<string> | null;
  /** o card que carrega o arquivo guardado de cada causa do DONO (a âncora do item dela), por causeKey. */
  deployAnchor: ReadonlyMap<string, string>;
  /**
   * As autorizações que o plano de publicação pede ao dono, por causeKey (o livro de causas as guarda): cada uma é uma
   * mudança EXATA de código guardado esperando o sim dele. É o que põe o botão «Autorizar publicar» no item da causa.
   */
  deployApprovals: ReadonlyMap<string, readonly OwnerApprovalRequest[]>;
  /**
   * Os cards DESTE board cuja causa de publicação mora no livro de OUTRO board — o que publica o pacote (id e nome). A
   * decisão da causa é do Inbox de lá; aqui o item só diz onde.
   */
  deployHeldOn: ReadonlyMap<string, { id: string; name: string }>;
  /** o board (id e nome) de cada card que uma linha DESTE board segura — os de outros boards entram no Inbox daqui. */
  deployCardBoard: ReadonlyMap<string, { id: string; name: string }>;
  /** as causas deste board cujo pedido o sistema está refazendo agora (deploy-blocks.ts `isRerequesting`). */
  deployRerequesting: ReadonlySet<string>;
  /**
   * as causas deste board com pedidos que o sistema JÁ SABE velhos e não pôde refazer sozinho sem arriscar publicar
   * (deploy-blocks.ts `staleApprovals`, auto-rerequest.ts): o item delas manda à Esteira («Refazer os pedidos»).
   */
  deployStale: ReadonlySet<string>;
  /**
   * O item de aprovação (`gate`) de cada card parado num passo manual, EXATAMENTE como o coletor o entregou — com o
   * recuo do Jido marcado (`copilotBackoff`). A causa do dono só pede o passo do card âncora quando o item de aprovação
   * DELE mora em Decidir (decision.ts); recalculá-lo do card perderia o recuo e diria «o Jido cuida» de um passo que o
   * Jido já devolveu ao dono.
   */
  gateOf: ReadonlyMap<string, CockpitItem>;
  /** quando o disjuntor tenta publicar de novo, por card (epoch ms) — só as re-tentativas ainda por vir. */
  publishRetryAt: ReadonlyMap<string, number>;
  /** a última mudança de status de cada card (ISO). */
  lastTransitionAt: ReadonlyMap<string, string>;
  /** quando cada card entrou no status em que está (ISO). */
  stepEnteredAt: ReadonlyMap<string, string>;
  /** as ações que aconteceram no board (o coletor só as lê quando há o que conferir: pedido pendente, travado repetido). */
  actions: readonly ExecutedAction[];
}

/** Fatos vazios — o ponto de partida dos testes e do coletor. PURA. */
export function emptyFacts(cards: readonly Card[] = []): InboxFacts {
  return {
    cardsById: new Map(cards.map((c) => [c.id, c])),
    deployCauseOf: new Map(),
    deployLedger: null,
    deployAnchor: new Map(),
    deployApprovals: new Map(),
    deployHeldOn: new Map(),
    deployCardBoard: new Map(),
    deployRerequesting: new Set(),
    deployStale: new Set(),
    gateOf: new Map(),
    publishRetryAt: new Map(),
    lastTransitionAt: new Map(),
    stepEnteredAt: new Map(),
    actions: [],
  };
}

/**
 * A ÂNCORA de cada causa do dono: o primeiro card atribuído (o diff dele carrega o arquivo guardado — deploy-blocks.ts
 * `attributeOwnerFiles`) que ainda existe e não terminou. Sem âncora, a causa não tem card que a decida (Acompanhar). PURA.
 */
export function deployAnchors(
  causes: Iterable<DeployCause>,
  ledgerAttributed: ReadonlyMap<string, string | null>,
  cardsById: ReadonlyMap<string, Pick<Card, "status">>,
  config: Pick<BoardConfig, "statuses">,
): Map<string, string> {
  const terminal = new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id));
  const out = new Map<string, string>();
  for (const cause of causes) {
    if (cause.decider !== "owner" || out.has(cause.causeKey)) continue;
    const candidates = [...(cause.attributedCardIds ?? []), ledgerAttributed.get(cause.causeKey) ?? null];
    const anchor = candidates.find((id): id is string => !!id && cardsById.has(id) && !terminal.has(cardsById.get(id)!.status ?? ""));
    if (anchor) out.set(cause.causeKey, anchor);
  }
  return out;
}

/** A causa de publicação do item (os fatos, senão a que o card gravou no aviso), ou null. PURA. */
export function deployCauseOfItem(item: Pick<CockpitItem, "kind" | "cardId">, card: Card | undefined, facts: InboxFacts | undefined): DeployCause | null {
  if (item.kind !== "deploy-failed") return null;
  return facts?.deployCauseOf.get(item.cardId) ?? card?.findings?.find((f) => f.id === (item as { findingId?: string }).findingId)?.deployCause ?? null;
}

/**
 * Os itens do PASSO DE PUBLICAÇÃO de um card: aprovar a liberação, a homologação que envelhece, o efeito de publicar que
 * não rodou, o card parado na publicação.
 */
const PUBLISH_EDGE_KINDS: ReadonlySet<CockpitItemKind> = new Set<CockpitItemKind>(["gate", "release-aging", "effect-failed", "stalled"]);

/**
 * O item é a MESMA publicação parada, vista por outro lado? Um item do passo de publicação cujo botão publica: num card
 * com a publicação parada por uma causa viva, apertá-lo dispararia de novo o que a mesma causa para de novo — não muda o
 * desfecho (regra B) e seria uma segunda entrada da causa (regra D). Ele dobra no aviso de publicação do card (entries.ts
 * `settleItems`): mesma causa, mesma decisão. Caso da revisão: num board com «Liberar» manual, cada card-vítima
 * da mesma causa trazia o próprio «Publicar «…» em produção?» — várias entradas em Decidir para UMA causa. PURA.
 */
export function foldsIntoPublishHold(kind: CockpitItemKind, options: readonly Pick<DecisionOption, "auditCls">[]): boolean {
  return PUBLISH_EDGE_KINDS.has(kind) && options.some((o) => o.auditCls === "deploy");
}

/** Os cards que a mesma causa segura agora (os fatos), na ordem do board. PURA. */
export function cardsOfCause(causeKey: string, facts: InboxFacts | undefined): string[] {
  if (!facts) return [];
  return [...facts.deployCauseOf].filter(([, c]) => c.causeKey === causeKey).map(([id]) => id);
}

// ── o contrato por kind ──────────────────────────────────────────────────────────────────────────────

/** A causa está viva? Morta: quando, quem a encerrou e o recibo em palavras («Resolvido hoje»). */
export type Liveness = { alive: true } | { alive: false; at: string; who: "sistema" | "prazo"; why: string };

const ALIVE: Liveness = { alive: true };

type ItemOf<K extends CockpitItemKind> = Extract<CockpitItem, { kind: K }>;

/** O contrato de um kind: a chave da causa, se ela ainda é verdade, e o prazo da revisão do dono (quando há). */
export interface KindContract<K extends CockpitItemKind> {
  /** a chave da causa no board — duas entradas com a mesma chave são UMA entrada (a dobra de entries.ts). */
  causeKey(item: ItemOf<K>, facts: InboxFacts | undefined): string;
  /** a causa ainda é verdade, pelos fatos pré-computados? Sem fatos ⇒ viva (quem não tem o fato não julga). */
  alive(item: ItemOf<K>, facts: InboxFacts | undefined, now: number): Liveness;
  /** dias até o item sair sozinho com recibo do prazo — só o que o dono combinou rever «quando puder». */
  ttlDays?: number;
}

/** A causa de um item que nasce de um card: o próprio card (a dobra de sempre, «um item por card»). */
const byCard = (item: Pick<CockpitItem, "cardId" | "id">): string => (item.cardId ? `card:${item.cardId}` : `item:${item.id}`);
const always = (): Liveness => ALIVE;

/** Quanto tempo o dono tem para revisar uma amostra antes de ela ir para o registro (C8: 7 dias). */
export const REVIEW_TTL_DAYS = 7;

/**
 * Os invokes humanos que fazem o mesmo que a ferramenta que um agente pediu (o registro de ações chama a ação de
 * servidor pelo nome dela: `runCardSkillAction`, `moveCardAction`). Genérico: são os nomes da própria ferramenta.
 */
const SAME_ACTION: Readonly<Record<string, readonly string[]>> = {
  run_skill: ["run_skill", "enqueue_run", "runCardSkillAction"],
  enqueue_run: ["run_skill", "enqueue_run", "runCardSkillAction"],
  move_card: ["move_card", "moveCardAction"],
  delete_card: ["delete_card", "deleteCardAction"],
  update_card: ["update_card"],
  answer_question: ["answer_question", "answerQuestionAction"],
};

/** Os pedidos cuja PREMISSA é a posição do card: o card que mudou de passo depois do pedido tornou o pedido velho. */
const POSITIONAL_TOOLS: ReadonlySet<string> = new Set(["move_card", "run_skill", "enqueue_run", "accept_triage"]);

/** A ação foi sobre este card? (o campo do registro, ou a nota da ação humana). PURA. */
function actionTouchesCard(a: ExecutedAction, cardId: string): boolean {
  return a.cardId === cardId || (a.note ?? "").includes(`card=${cardId}`);
}

/**
 * O pedido de um agente que perdeu a razão de existir: a MESMA ação já aconteceu depois do pedido (por outro caminho —
 * o dono apertou «Tentar de novo» no Inbox), ou o card mudou de passo depois de um pedido que dependia da posição dele.
 * Caso real: um pedido «rodar o agente neste card» seguia pendente horas depois, e o dono já tinha
 * rodado o agente por outro caminho. PURA.
 */
export function approvalLiveness(item: ItemOf<"approval">, facts: InboxFacts | undefined): Liveness {
  const asked = item.requestedAt ?? item.since ?? null;
  if (!facts || !asked || !item.cardId || !item.tool) return ALIVE;
  const title = quoted(item.cardTitle || item.cardId);
  const same = SAME_ACTION[item.tool] ?? [item.tool];
  const done = facts.actions
    .filter((a) => a.at > asked && actionHappened(a) && same.includes(a.tool) && actionTouchesCard(a, item.cardId))
    .sort((a, z) => a.at.localeCompare(z.at))[0];
  if (done) {
    return { alive: false, at: done.at, who: "sistema", why: `O pedido de um agente sobre ${title} saiu do Inbox: a mesma ação já aconteceu depois do pedido.` };
  }
  const moved = facts.lastTransitionAt.get(item.cardId);
  if (POSITIONAL_TOOLS.has(item.tool) && moved && moved > asked) {
    return { alive: false, at: moved, who: "sistema", why: `O pedido de um agente sobre ${title} saiu do Inbox: o card mudou de passo depois do pedido.` };
  }
  return ALIVE;
}

/**
 * O aviso de publicação cuja causa saiu do livro de causas: a re-medição a julgou morta (o plano não a lista mais, o
 * preflight passou) e a varredura fecha o aviso na mesma passada. Só julga a causa GRAVADA no aviso — a reconstruída
 * de um aviso antigo nunca esteve no livro, e julgá-la por ele apagaria o aviso antes de a varredura o completar. PURA.
 */
function deployLiveness(item: ItemOf<"deploy-failed">, facts: InboxFacts | undefined, now: number): Liveness {
  if (!facts?.deployLedger) return ALIVE;
  const recorded = facts.cardsById.get(item.cardId)?.findings?.find((f) => f.id === item.findingId)?.deployCause;
  if (!recorded || facts.deployLedger.has(recorded.causeKey)) return ALIVE;
  return {
    alive: false,
    at: new Date(now).toISOString(),
    who: "sistema",
    why: `A causa que segurava a publicação de ${quoted(item.cardTitle || item.cardId)} saiu do registro de causas — o sistema fecha o aviso e publica de novo.`,
  };
}

/**
 * A amostra de entrega que o dono combinou rever «quando puder»: passado o prazo, vai para o registro e fica valendo
 * (num caso real, amostras vencidas seguiam em Acompanhar, sem prazo nenhum). PURA.
 */
function deliveryReviewLiveness(item: ItemOf<"delivery-audit">, _facts: InboxFacts | undefined, now: number): Liveness {
  const born = Date.parse(item.sampledAt || item.since || "");
  if (!Number.isFinite(born)) return ALIVE;
  const due = born + REVIEW_TTL_DAYS * 86_400_000;
  return now >= due
    ? {
        alive: false,
        at: new Date(due).toISOString(),
        who: "prazo",
        why: `A amostra da entrega de ${quoted(item.cardTitle || item.cardId)} passou de ${REVIEW_TTL_DAYS} dias sem revisão — a entrega fica valendo e vai para o registro.`,
      }
    : ALIVE;
}

/**
 * A chave da causa de um aviso de publicação. A causa do DONO com âncora mora no card âncora (o item dela é a decisão
 * daquele card — num caso real, o código de um único card segurava a publicação de vários outros); as outras
 * moram na causa (`deploy:<pacote>:<o que segurou>` — N cards, UM item). Sem causa conhecida, o próprio card. PURA.
 */
function deployCauseKey(item: ItemOf<"deploy-failed">, facts: InboxFacts | undefined): string {
  const cause = deployCauseOfItem(item, facts?.cardsById.get(item.cardId), facts);
  if (!cause) return byCard(item);
  const anchor = cause.decider === "owner" ? facts?.deployAnchor.get(cause.causeKey) : undefined;
  return anchor ? `card:${anchor}` : `deploy:${cause.causeKey}`;
}

/**
 * O CONTRATO de cada kind — exaustivo (`{ [K in CockpitItemKind]: … }`): um kind novo não compila até alguém dizer de
 * qual causa ele é e quando ela deixa de ser verdade. QUEM decide não mora aqui: é o veredito de decision-class.ts.
 * Os kinds que nascem de campos do card somem sozinhos quando o fato muda (o card andou, a pergunta foi respondida) —
 * o `alive` deles é «sempre», porque o coletor já não os emite. Os do passo de publicação de um card com a publicação
 * parada trocam a chave do card pela do aviso dele ({@link foldsIntoPublishHold} — a dobra lê a decisão, que só existe
 * depois do contrato).
 */
export const KIND_CONTRACT: { [K in CockpitItemKind]: KindContract<K> } = {
  question: { causeKey: byCard, alive: always },
  blocker: { causeKey: byCard, alive: always },
  finding: { causeKey: byCard, alive: always },
  "deploy-failed": { causeKey: deployCauseKey, alive: deployLiveness },
  gate: { causeKey: byCard, alive: always },
  // o pedido de um agente com card é UMA coisa com o card (o passo travado e o pedido de re-rodá-lo eram duas entradas)
  approval: { causeKey: byCard, alive: (item, facts) => approvalLiveness(item, facts) },
  review: { causeKey: byCard, alive: always },
  stuck: { causeKey: byCard, alive: always },
  conflict: { causeKey: byCard, alive: always },
  proposal: { causeKey: byCard, alive: always },
  design: { causeKey: byCard, alive: always },
  // a proposta de PRD é a causa dela mesma (o prazo de 14 dias mora em governance.ts; o recibo, em receipts.ts)
  governance: { causeKey: (item) => `item:${item.id}`, alive: always },
  "deploy-unsettled": { causeKey: byCard, alive: always },
  "release-aging": { causeKey: byCard, alive: always },
  "merge-failed": { causeKey: byCard, alive: always },
  // a resposta do procurador NÃO vence: entre elas estão as que o piso de dinheiro antigo mandaria ao dono (autonomy.ts
  // `relaxedMoneyFloorMatch`, a mitigação do WP1) — o risco de um gasto decidido sem o dono ver não expira
  "proxy-audit": { causeKey: byCard, alive: always },
  "delivery-audit": { causeKey: byCard, alive: deliveryReviewLiveness, ttlDays: REVIEW_TTL_DAYS },
  // o aviso do host é um só, em todo board (a faixa do medidor)
  "meter-stalled": { causeKey: () => "host:meter", alive: always },
  "data-deletion": { causeKey: byCard, alive: always },
  "effect-failed": { causeKey: byCard, alive: always },
  stalled: { causeKey: byCard, alive: always },
  // cada pedido de comando travado é a causa dele mesmo: dois pedidos do mesmo card são duas decisões (dois comandos)
  "locked-exec": { causeKey: (item) => `item:${item.id}`, alive: always },
  // o pedido que o plano listou sem card é a CAUSA do livro (a mesma chave da publicação parada que o card teria): o
  // coletor só o emite enquanto a linha existe
  "publish-approval": { causeKey: (item) => `deploy:${item.causeKey}`, alive: always },
  // fase 3 — as alavancas da Esteira: a publicação do BOARD é uma causa só (o pedido segurado e as entregas paradas
  // falam da mesma fila); os avisos do host são um só em todo board (uma faixa)
  "publish-held": { causeKey: (item) => `publish:${item.boardId}`, alive: always },
  "stage-idle": { causeKey: (item) => `publish:${item.boardId}`, alive: always },
  "capacity-latch": { causeKey: () => "host:latch", alive: always },
  "host-health": { causeKey: () => "host:health", alive: always },
  "push-off": { causeKey: () => "host:push-off", alive: always },
  // fase 6 — a causa da Sentinela é a própria causa (dois cards com o mesmo motivo já chegam como UM item)
  sentinel: { causeKey: (item) => `sentinel:${item.causeKey}`, alive: always },
};

/** A chave da causa de um item (o contrato do kind dele). PURA. */
export function itemCauseKey(item: CockpitItem, facts?: InboxFacts): string {
  return (KIND_CONTRACT[item.kind] as KindContract<CockpitItemKind>).causeKey(item as never, facts);
}

/** A causa de um item ainda é verdade? (o contrato do kind dele, com os fatos do coletor). PURA. */
export function itemLiveness(item: CockpitItem, facts: InboxFacts | undefined, now: number): Liveness {
  return (KIND_CONTRACT[item.kind] as KindContract<CockpitItemKind>).alive(item as never, facts, now);
}
