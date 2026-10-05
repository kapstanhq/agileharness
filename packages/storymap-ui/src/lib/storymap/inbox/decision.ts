// O MODELO DE ITEM do Inbox (onda 2 do redesenho, aprovado pelo dono) — UMA projeção pura por item, em UM
// lugar: a seção (Decidir ou Acompanhar), a decisão, o que aconteceu, as opções (cada uma com a consequência escrita e,
// quando bloqueada, o porquê e o que a libera), o que acontece se o dono não fizer nada, a idade e quem age a seguir.
//
// Por que existe (auditorias de UX e de arquitetura): o texto de um item vinha de várias tabelas de rótulo, de
// frases soltas em dezenas de renderers e de um registry de botões com a consequência só num tooltip — que o celular não
// mostra. O cabeçalho era um rótulo por KIND («Aprovar e avançar») sem conferir se a ação existia: foi assim que o dono
// leu «Aprovar & avançar» num botão que publicava em produção, e «Confirmar deploy» num item sem nada a confirmar.
// Aqui a pergunta nasce das opções que o item TEM, e os testes impedem a confusão de voltar:
//   • Decidir ⇒ ao menos uma opção que MUDA o desfecho (contract.ts `hasOutcomeAction`), pré-validada pela MESMA régua
//     do servidor (preconditions.ts) — conversar com o Jido, ler e o passo a passo do computador não contam;
//   • o verbo da pergunta é o de uma opção, e a pergunta cabe em 140 caracteres (o texto cru vai para Detalhes);
//   • nenhum termo do glossário nas partes 1–4 (copy.ts `bannedTermsIn`);
//   • um item de Decidir por CAUSA (contract.ts `KIND_CONTRACT`, entries.ts `foldByCause`).
//
// QUEM DECIDE segue sendo `whoDecides` (decision-class.ts): classe do dono ⇒ Decidir; técnico ⇒ Acompanhar, com o
// porquê e — quando o sistema cuida — quem tenta de novo. Poucas exceções por kind, todas escritas aqui: a amostra do
// dono (revisar quando puder), o aviso que não trava nada, a pergunta que o procurador está respondendo, a proposta
// que ainda está sendo gerada, o aviso do host (a faixa do medidor) e o card parado sem ninguém cuidando (o conserto que
// o vigia abriu é do sistema; o item conta em «sem ninguém cuidando»).
//
// EXAUSTIVO: `DECIDE` é um Record por kind — um kind novo não compila até alguém escrever a decisão dele.

import type { BoardConfig, Card, EntryEffect, RiskClass, StatusDef } from "../types";
import {
  deliveryInFlight,
  isCopilotActionable,
  isBusinessRecoveryItem,
  recoveryRetryLimit,
  type CockpitItem,
  type CockpitItemKind,
  type DeployUnsettledCockpitItem,
} from "../demands";
import { cockpitItemDecision, isBusinessOnly, ownerClassLabel, stuckFailure, type DecisionVerdict } from "../decision-class";
import type { CopilotTier } from "../copilot/tier";
import type { EscalationRef } from "../copilot/escalation";
import type { QuickActionInvoke } from "../quick-actions";
import { moveTargets } from "../move-targets";
import { evaluateGate } from "../gates";
import { acceptRoute, triagePlacementGap } from "../triage/parse";
import { isConducted } from "../driver";
import { GOVERNANCE_DRAFT_TTL_DAYS } from "../governance";
import { unresolvedChanges } from "../design-canvas";
import { isRemovalScope, REMOVAL_SCOPE_BY_ID } from "../frameworks";
import { cardHref, inboxListItemHref, processesMergeHref, processesServiceHref, runServiceId } from "../deep-links";
import { acceptTriageRefusal, dataDeletionRefusal, designApproveRefusal, moveRefusal, republishRefusal, runSkillRefusal } from "../preconditions";
import type { DeployCause, DeployFailurePhase } from "../types";
import { actionHappened, cardsOfCause, changesOutcome, deployCauseOfItem, hasOutcomeAction, isDiscard, isOwnerAdvisory, type InboxFacts } from "./contract";
import { findingFixRefusal, severityWords } from "../finding-fix";
import { ASK_MAX, clampAsk, clip, dayToken, plural, quoted, timeToken } from "./copy";
import { callerWords } from "@/lib/storymap/mcp/caller";
import { approvalRequesterText } from "@/lib/storymap/approval-requester";
import { dependentsSample, discardGroupRefusal, discardPlan } from "@/lib/storymap/card-dependents";

// ── Os tipos ─────────────────────────────────────────────────────────────────────────────────────────

/** As seções do Inbox. `resolvido` não nasce de um item vivo — vem dos recibos e do registro (receipts.ts). */
export type InboxBucket = "decidir" | "acompanhar";

/**
 * O que uma opção faz — serializável (vai do servidor à tela). Os kinds de {@link QuickActionInvoke} mapeiam 1:1 para
 * as ações de servidor de sempre; os demais são as ações que viviam soltas nos renderers (responder, aprovar a
 * proposta de PRD, autorizar o pedido de um agente…) e o `howto` — a opção que o celular não executa, trocada pelo
 * passo a passo «No computador: como fazer».
 */
export type OptionInvoke =
  | QuickActionInvoke
  | { kind: "answer-question"; boardId: string; cardId: string; questionId: string }
  | { kind: "approve-governance"; boardId: string; draftId: string }
  | { kind: "reject-governance"; boardId: string; draftId: string }
  | { kind: "grant-request"; boardId: string; approvalId: string }
  | { kind: "deny-request"; boardId: string; approvalId: string }
  | { kind: "resolve-proxy-audit"; boardId: string; cardId: string; questionId: string; outcome: "confirmed" | "reopened" }
  | { kind: "resolve-delivery-audit"; boardId: string; cardId: string; outcome: "confirmed" | "reopened" }
  | { kind: "accept-proposal"; boardId: string; containerId: string }
  | { kind: "refine-proposal"; boardId: string; containerId: string }
  | { kind: "request-redesign"; boardId: string; cardId: string }
  | { kind: "renew-meter" }
  | { kind: "undo-system-decision"; boardId: string; decisionId: string }
  | { kind: "show-publish-status"; boardId: string; cardId: string }
  // O sim do dono para uma mudança de código guardado (dinheiro) que o plano de publicação segura — por CAUSA, não por card.
  | { kind: "authorize-publish"; boardId: string; causeKey: string }
  // «Mandar corrigir» um aviso da revisão: cria o card de conserto e registra o aviso na origem (finding-fix.ts).
  | { kind: "fix-finding"; boardId: string; cardId: string; findingId: string }
  // Execução aprovada (runner/locked-exec*): as decisões do dono sobre um comando travado. `hash` = o pedido exato que ele
  // viu — o servidor recusa se ele mudou.
  | { kind: "approve-locked-exec"; boardId: string; id: string; hash: string }
  | { kind: "reject-locked-exec"; boardId: string; id: string }
  | { kind: "undo-locked-exec"; boardId: string; id: string }
  | { kind: "keep-locked-exec"; boardId: string; id: string }
  | { kind: "ack-locked-exec"; boardId: string; id: string }
  | { kind: "howto"; title: string; steps: string[] };

export type OptionInvokeKind = OptionInvoke["kind"];

/**
 * Como DESFAZER o que o dono acabou de fazer pelo Inbox (o «Desfazer» do recibo). Só as ações reversíveis têm um: um
 * movimento sem efeito externo, o descarte para a lixeira, a triagem de um aviso e o arquivamento de um item parado.
 */
export type ReceiptUndo =
  | { kind: "move-back"; boardId: string; cardId: string; from: string; to: string; toStaging?: boolean }
  | { kind: "restore-card"; boardId: string; cardId: string; /** o descarte levou junto o que dependia do card: o desfazer restaura todos */ group?: boolean }
  | { kind: "reopen-finding"; boardId: string; cardId: string; findingId: string }
  | { kind: "revive-card"; boardId: string; cardId: string };

/** Uma opção do item — a parte 3 da anatomia. */
export interface DecisionOption {
  /** estável dentro do item (chave de pendência/telemetria). */
  id: string;
  /** verbo + objeto, nomeando o efeito externo («Publicar em produção», nunca «Aprovar & avançar»). */
  label: string;
  /** o que muda se o dono apertar — impresso EMBAIXO do botão, nunca num tooltip. */
  consequence: string;
  tone: "primary" | "neutral" | "danger";
  /** recusada AGORA pela mesma régua do servidor: o porquê e, quando há, o que a libera. */
  disabled?: { reason: string; unblock?: { label: string; href: string } };
  invoke: OptionInvoke;
  /** confirmação antes do clique (as destrutivas e as de produção). */
  confirm?: { title: string; body: string };
  /** a opção precisa de algo que o dono escreve/escolhe no corpo do item antes de valer. */
  requires?: "answer" | "selection" | "note";
  /** trilha de auditoria do clique humano (quick-actions SENSITIVE_AUDIT_CLASSES). */
  auditCls: RiskClass;
  /** o recibo do clique bem-sucedido, quando o servidor não devolve um desfecho próprio. */
  done: string;
  /** como desfazer — só nas reversíveis. */
  undo?: ReceiptUndo;
}

/** Quem age a seguir — a linha que responde «isto é meu?». */
export interface NextActor {
  who: "voce" | "jido" | "sistema" | "condutor" | "ninguem";
  label: string;
  /** trabalho técnico parado que NINGUÉM vai pegar sozinho (o Jido desligado, o prazo que passou) — a contagem
   *  «sem ninguém cuidando» de Acompanhar, para o que é do sistema não apodrecer em silêncio. */
  stalled?: true;
}

/** Um item projetado nas cinco partes. */
export interface ItemDecision {
  bucket: InboxBucket;
  /** o verbo da decisão — o de uma opção (null fora de Decidir: em Acompanhar a frase é um fato). */
  askVerb: string | null;
  /** 1 · a decisão (Decidir) ou o fato em andamento (Acompanhar) — uma frase, com o objeto dentro. */
  ask: string;
  /** 2 · o que aconteceu — uma ou duas linhas, quem fez o quê, sem termo técnico. */
  happened: string;
  /** 3 · as opções, cada uma com a consequência. Pode ser vazio em Acompanhar. */
  options: DecisionOption[];
  /** 4 · se o dono não fizer nada. */
  ifIgnored: string;
  /** «Mais»: abrir o card, pedir ao Jido, ver o status — leitura e delegação, fora da decisão. */
  more: DecisionOption[];
  /** 5 · detalhes (fechados): ids, textos técnicos, o motivo cru. */
  details: Array<{ label: string; value: string }>;
  since: string | null;
  next: NextActor;
  verdict: DecisionVerdict;
  /** o ponto da linha: vermelho (produção/travado grave), âmbar (espera), verde (aprovar), cinza (parado). */
  dot: "red" | "amber" | "green" | "grey";
  /** o aviso do HOST (medidor parado): uma faixa no topo, uma vez, nunca uma linha de board. */
  banner?: boolean;
  /**
   * Acompanhar com PRAZO: passado `at`, o item sobe para Decidir se a classe é do dono ({@link promote}), com a
   * pergunta `ask`; se a classe é do sistema, fica e diz `systemText` (quem escala é o sistema, nunca o dono).
   */
  promotion?: { at: string; ask: string; askVerb: string; systemText: string };
}

/** O contexto de uma decisão — o card do item, o board, o relógio e o tier do Jido neste board. */
export interface DecisionCtx {
  config: BoardConfig;
  card?: Card;
  now: number;
  tier: CopilotTier;
  /**
   * Os fatos do board pré-computados pelo coletor (contract.ts): a causa de publicação de cada card e o card que a
   * decide, a re-tentativa agendada, as ações que já aconteceram. Ausentes (o sinal de um card sozinho) ⇒ o item decide
   * só pelo que o card mostra, e o que depende do board não é oferecido.
   */
  facts?: InboxFacts;
  /**
   * O nome humano de cada lente de revisão (`id → name`), resolvido no SERVIDOR a partir de `target.reviewLenses`
   * (o settings não atravessa para o cliente). Ausente ⇒ o detalhe «Área» mostra o id da lente, como sempre: uma lente
   * removida do settings (ou um id antigo) nunca some do item.
   */
  lensNames?: Readonly<Record<string, string>>;
}

// ── Peças comuns ─────────────────────────────────────────────────────────────────────────────────────

interface KindCtx extends DecisionCtx {
  verdict: DecisionVerdict;
  businessOnly: boolean;
  /** «o título do card», curto. */
  title: string;
  /** o nome de um passo do board. */
  step: (statusId: string | null | undefined) => string;
}

/** O que um kind devolve — o resto (a seção final, o ponto, quem age) é regra comum. */
interface KindDraft {
  askVerb: string | null;
  ask: string;
  happened: string;
  options: DecisionOption[];
  ifIgnored: string;
  more?: DecisionOption[];
  details?: Array<{ label: string; value: string }>;
  /** força a seção (as exceções por kind); ausente = a régua de quem decide. */
  bucket?: InboxBucket;
  /** Acompanhar: quem cuida e o que acontece (substitui o `ifIgnored` padrão do sistema). */
  next?: NextActor;
  dot?: ItemDecision["dot"];
  banner?: boolean;
  promotion?: ItemDecision["promotion"];
  /** o texto de «se você não fizer nada» quando o item vai para Acompanhar por ser do sistema. */
  systemIgnored?: string;
}

const openCard = (boardId: string, cardId: string): DecisionOption => ({
  id: "more:open-card",
  label: "Abrir card",
  consequence: "Abre o card inteiro para ler ou editar. Não decide nada.",
  tone: "neutral",
  auditCls: "read",
  invoke: { kind: "link", href: cardHref(boardId, cardId) },
  done: "Aberto.",
});

const askJido = (ref: EscalationRef, label = "Pedir ao Jido", consequence?: string): DecisionOption => ({
  id: `jido:${ref.templateId}`,
  label,
  consequence: consequence ?? "Abre o Jido com este item carregado, para conversar ou mandar ele cuidar. Não muda nada sozinho.",
  tone: "neutral",
  auditCls: "read",
  invoke: { kind: "escalate", ref },
  done: "O Jido abriu com este item.",
});

/** «Mais» padrão de um item de card: abrir o card e pedir ao Jido. */
function cardMore(item: CockpitItem, ref: EscalationRef | null): DecisionOption[] {
  const out: DecisionOption[] = [];
  if (item.cardId) out.push(openCard(item.boardId, item.cardId));
  if (ref) out.push(askJido(ref));
  return out;
}

/** O passo que publica (efeito promote-and-deploy) — o destino do «Publicar de novo». */
function publishStep(config: BoardConfig): StatusDef | undefined {
  return config.statuses.find((s) => s.onEnter === "promote-and-deploy");
}

/** O passo dispara uma publicação em produção ao receber o card? */
const publishesOnEnter = (s: Pick<StatusDef, "onEnter">) => s.onEnter === "promote-and-deploy" || s.onEnter === "deploy-board";

/**
 * Mandar o card para `targetId` o leva SOZINHO até o ar? A partir do destino, os passos seguintes rodam sem parar para
 * ninguém (autorun) até um que publica — sem passo manual nem terminal no meio. É o que faz o glossário trocar «Mandar
 * para «Integrar»» por «Aprovar e publicar» com honestidade: num board em que Integrar, Homologar, Liberar e Publicar
 * andam sozinhos (um board de produto típico), aprovar a entrega É publicar; num board com Liberar manual, não é. PURA.
 */
export function leadsToPublish(config: Pick<BoardConfig, "statuses">, targetId: string): boolean {
  const from = config.statuses.findIndex((s) => s.id === targetId);
  if (from < 0) return false;
  for (let i = from; i < config.statuses.length; i++) {
    const s = config.statuses[i];
    if (publishesOnEnter(s)) return true;
    if (s.terminal || s.autorun !== true) return false;
  }
  return false;
}

/** O avanço de um card parado num passo manual: o destino recomendado e a opção que o leva, com o texto do efeito. */
interface Forward {
  rec: StatusDef;
  askVerb: string;
  ask: string;
  option: DecisionOption;
  /** o destino publica em produção ao receber o card. */
  externalEffect: boolean;
}

/**
 * O AVANÇO de `card` pelo destino recomendado (a MESMA régua do servidor: moveTargets), com o verbo pelo efeito:
 * publicar em produção, homologar o código, aprovar e publicar (quando o resto anda sozinho até o ar) ou mandar para o
 * passo. Null quando nenhum destino aceita o card agora. Usado pelo gate do próprio card e pela causa de publicação que
 * espera a decisão dele. PURA.
 */
function forwardOf(card: Card, config: BoardConfig, boardId: string, title: string): Forward | null {
  const rec = moveTargets(card, config).find((t) => t.recommended)?.status ?? null;
  if (!rec) return null;
  const effect = rec.onEnter;
  const externalEffect = publishesOnEnter(rec);
  const approvesToAir = !externalEffect && effect !== "promote-stage" && leadsToPublish(config, rec.id);
  const askVerb = externalEffect ? "Publicar" : effect === "promote-stage" ? "Homologar" : approvesToAir ? "Aprovar" : "Mandar";
  const ask = externalEffect
    ? `Publicar ${title} em produção?`
    : effect === "promote-stage"
      ? `Homologar ${title}?`
      : approvesToAir
        ? `Aprovar e publicar ${title}?`
        : `Mandar ${title} para «${rec.name}»?`;
  return {
    rec,
    askVerb,
    ask,
    externalEffect,
    option: {
      id: "advance",
      label: externalEffect ? "Publicar em produção" : effect === "promote-stage" ? "Homologar o código" : approvesToAir ? "Aprovar e publicar" : `Mandar para «${rec.name}»`,
      consequence: externalEffect
        ? "Publica o que mudou desde a última vez e confere que o código deste card está no ar."
        : effect === "promote-stage"
          ? "Leva o código aprovado para o ramo principal; a publicação vem depois."
          : approvesToAir
            ? "O card segue sozinho até o ar: integra, homologa e publica, com prova a cada passo."
            : `O card vai para «${rec.name}»${rec.autorun ? " e a automação do passo começa" : ""}.`,
      tone: externalEffect ? "danger" : "primary",
      ...(externalEffect || effect || approvesToAir
        ? { confirm: { title: ask, body: externalEffect ? `${title} vai para «${rec.name}» e a publicação em produção dispara.` : approvesToAir ? `${title} vai para «${rec.name}» e segue sozinho até o ar.` : `${title} vai para «${rec.name}».` } }
        : {}),
      auditCls: externalEffect ? "deploy" : effect ? "merge-resolve" : "write-board",
      invoke: { kind: "move-card", boardId, cardId: card.id, status: rec.id },
      done: externalEffect
        ? `${title} foi para «${rec.name}». A publicação começou; você é avisado se ela não provar.`
        : approvesToAir
          ? `${title} foi para «${rec.name}» e segue sozinho até o ar; você é avisado se algo parar.`
          : `${title} foi para «${rec.name}».`,
      ...(effect || !card.status ? {} : { undo: { kind: "move-back" as const, boardId, cardId: card.id, from: rec.id, to: card.status } }),
    },
  };
}

/** As causas de publicação do DONO que esperam a decisão deste card (ele é a âncora delas — contract.ts). PURA. */
function ownerCausesAnchoredAt(cardId: string, facts: InboxFacts | undefined): Array<{ cause: DeployCause; cards: string[] }> {
  if (!facts) return [];
  const out: Array<{ cause: DeployCause; cards: string[] }> = [];
  const seen = new Set<string>();
  for (const cause of facts.deployCauseOf.values()) {
    if (cause.decider !== "owner" || seen.has(cause.causeKey) || facts.deployAnchor.get(cause.causeKey) !== cardId) continue;
    seen.add(cause.causeKey);
    out.push({ cause, cards: cardsOfCause(cause.causeKey, facts) });
  }
  return out;
}

/** O que a publicação parada pela causa do dono faz com o card âncora: pedir o passo dele (Decidir), ou dizer quem o leva. */
type AnchorRoute =
  | { decide: { askVerb: string; ask: string; option: DecisionOption } }
  | { decide: null; next: NextActor; why: string; ifIgnored: string };

/**
 * A causa do dono pede o passo do card âncora SÓ quando esse passo é do dono agora: o item de aprovação da âncora — o
 * MESMO que o coletor entregou (fatos `gateOf`, com o recuo do Jido) — mora em Decidir. A ação é então exatamente a dele,
 * e as vítimas dobram como facetas da entrada dele. Em qualquer outro caso a causa vai para Acompanhar, dizendo quem
 * leva a âncora adiante — e nunca pede de novo o que o dono já aprovou.
 *
 * Caso da revisão: a vítima oferecia `forwardOf(âncora)` em qualquer passo — o dono aprovava «Aprovar e publicar
 * «<título do card>»?» em «Aprovar entrega», o card entrava em Integrar e a coleta seguinte trazia a MESMA pergunta, agora
 * numa vítima, com o botão movendo o card âncora para «Homologar» por cima da integração; com a âncora em
 * «Especificar», «Mandar … para «Entrevista»?»; num board humano com o Jido, a mesma entrada apostava corrida com o Jido
 * que já tinha pego o passo. PURA.
 */
function anchorRoute(anchor: Card, c: KindCtx): AnchorRoute {
  const title = quoted(anchor.title);
  const pending = `Quando a decisão de ${title} couber a você, ela sobe para Decidir, uma vez só; até lá, a publicação segue parada.`;
  // Já passou da aprovação: a publicação dele também parou, ou ele anda sozinho até o ar. O que falta é a autorização da
  // publicação gravada (a decisão nº 2 do dono, C2) — sem botão aqui, e perguntar o passo de novo não muda nada.
  if (c.facts?.deployCauseOf.has(anchor.id) || leadsToPublish(c.config, anchor.status ?? "")) {
    return {
      decide: null,
      next: { who: "ninguem", label: "Ninguém resolve daqui", stalled: true },
      why: `Você já aprovou ${title}; publicar esse código pede uma autorização sua que ainda não tem botão aqui.`,
      ifIgnored: "A publicação segue parada até essa autorização existir; nada vai ao ar.",
    };
  }
  const step = c.step(anchor.status);
  const gate = c.facts?.gateOf.get(anchor.id);
  const own = gate ? decideItem(gate, { config: c.config, card: anchor, now: c.now, tier: c.tier, ...(c.facts ? { facts: c.facts } : {}) }) : null;
  const advance = own?.bucket === "decidir" ? own.options.find((o) => o.id === "advance" && changesOutcome(o)) : undefined;
  if (own?.askVerb && advance) return { decide: { askVerb: own.askVerb, ask: own.ask, option: advance } };
  // Parado num passo do dono, mas quem age não é o dono (o Jido o pegou, o sistema decide, nada a aprovar): quem age é
  // quem o item de aprovação dele diz.
  if (own) return { decide: null, next: own.next, why: `${title} está em «${step}». ${own.next.label}.`, ifIgnored: pending };
  if (c.config.statuses.find((s) => s.id === anchor.status)?.autorun === true) {
    return { decide: null, next: { who: "sistema", label: "O pipeline leva o card adiante" }, why: `${title} está em «${step}», e o pipeline o leva adiante.`, ifIgnored: pending };
  }
  return { decide: null, next: { who: "ninguem", label: "Ninguém resolve daqui", stalled: true }, why: `${title} está em «${step}», sem nada a aprovar agora.`, ifIgnored: pending };
}

/** Por que uma publicação parou, em palavras de dono — por fase; cada uma completa «A publicação parou porque …». */
const PHASE_WORDS: Record<DeployFailurePhase, string> = {
  release: "a promoção do código para o ramo principal falhou",
  deploy: "a publicação falhou",
  "deploy-noop": "a publicação terminou sem publicar nada",
  "face-stale": "o site no ar não bate com o que foi publicado",
  "self-deploy": "a publicação da própria ferramenta falhou",
  freshness: "o código no servidor está diferente do que foi aprovado",
  "needs-human": "o motivo ainda não foi classificado",
  "needs-proof": "falta a prova de segurança que o sistema está produzindo",
  "needs-units": "falta configurar uma parte da publicação",
};

/** «o código pede uma decisão de «Dinheiro e preço»», «falta configurar…» — o porquê da causa, curto. PURA. */
function causeWords(cause: DeployCause, config: BoardConfig): string {
  if (cause.decider === "owner") return cause.ownerClass ? `o código pede uma decisão de «${ownerClassLabel(cause.ownerClass, config)}»` : PHASE_WORDS["needs-human"];
  return cause.phase === "needs-human" ? PHASE_WORDS["needs-units"] : PHASE_WORDS[cause.phase];
}

/** O que a causa diz em Detalhes — as partes e as regras cruas, que o texto do item não mostra. PURA. */
function causeDetails(cause: DeployCause | null): Array<{ label: string; value: string }> {
  if (!cause) return [];
  return [
    { label: "Causa", value: cause.causeKey },
    ...(cause.units.length ? [{ label: "Partes paradas", value: cause.units.join(", ") }] : []),
    ...(cause.rules.length ? [{ label: "Regras", value: cause.rules.join(", ") }] : []),
  ];
}

/**
 * Quantas vezes o dono mandou «Tentar de novo» neste passo ANTES desta morte (o registro de ações: a ação humana de
 * rodar o agente do card). Caso real: três «Tentar de novo» seguidos no mesmo passo, os três terminando em «não há
 * trabalho» — o botão seguia oferecido como se fosse mudar algo. 0 sem os fatos. PURA.
 */
function manualRetriesInStep(item: Pick<CockpitItem, "cardId" | "since">, facts: InboxFacts | undefined): number {
  if (!facts || !item.cardId) return 0;
  const from = facts.stepEnteredAt.get(item.cardId) ?? facts.lastTransitionAt.get(item.cardId) ?? "";
  const until = item.since ?? "9999";
  return facts.actions.filter(
    (a) =>
      (a.tool === "runCardSkillAction" || a.tool === "run_skill") &&
      actionHappened(a) &&
      (a.actor ?? "").startsWith("human") &&
      a.at >= from &&
      a.at < until &&
      (a.cardId === item.cardId || (a.note ?? "").includes(`card=${item.cardId}`)),
  ).length;
}

/** O passo anterior elegível mais próximo (o «Devolver»), pela MESMA régua do servidor (moveTargets). */
function previousEligible(card: Card, config: BoardConfig): StatusDef | null {
  const idx = config.statuses.findIndex((s) => s.id === card.status);
  return (
    moveTargets(card, config)
      .filter((t) => !t.recommended)
      .filter((t) => config.statuses.findIndex((s) => s.id === t.status.id) < idx)
      .at(-1)?.status ?? null
  );
}

/** O que o Jido (ou ninguém) faz com um item técnico — a linha «se você não fizer nada» de Acompanhar. */
function systemFollowUp(item: CockpitItem, c: KindCtx): { next: NextActor; ifIgnored: string } {
  if (c.businessOnly) {
    if (isBusinessRecoveryItem(item, c.tier)) {
      const n = recoveryRetryLimit(item.kind);
      return {
        next: { who: "jido", label: "O Jido tenta de novo" },
        ifIgnored: `O Jido tenta de novo (até ${plural(n, "vez", "vezes")}) e, se repetir, abre um card de conserto. Você não precisa fazer nada.`,
      };
    }
    if (c.tier === "chat" && recoveryRetryLimit(item.kind) > 0) {
      return {
        next: { who: "ninguem", label: "Ninguém tenta sozinho", stalled: true },
        ifIgnored: "Ninguém tenta de novo sozinho: o Jido está desligado neste board. O card fica parado até alguém agir.",
      };
    }
    return { next: { who: "sistema", label: "O sistema decide" }, ifIgnored: "O sistema decide pelo PRD e registra; você vê o resultado aqui." };
  }
  // Num board humano, o único item do sistema é o travado que passa por cima do modo (decision-class.ts: a falha da
  // ferramenta, o mesmo no-op de novo). Ninguém o pega: o Jido não re-tenta um veredito do sistema, e tentar de novo
  // do mesmo jeito não muda o desfecho. Antes esta linha dizia «O Jido está cuidando» — falso com o Jido desligado,
  // e o item nunca voltava a Decidir. Next honesto: ninguém cuida (RC2).
  return {
    next: { who: "ninguem", label: "Ninguém tenta sozinho", stalled: true },
    ifIgnored: "Ninguém tenta de novo sozinho: do mesmo jeito, o desfecho seria o mesmo. O card fica parado até a causa ser consertada.",
  };
}

/**
 * «Tentar de novo» NO LUGAR — refaz a ação automática do passo onde o card está (republishCardAction), sem movê-lo. UMA
 * opção para os dois itens que a oferecem (o efeito que não rodou e o card parado sem ninguém cuidando): a recusa do
 * servidor dita antes do clique (republishRefusal) e, quando o passo publica, a confirmação. `advice` fecha a
 * consequência — o que o dono deve saber antes de apertar.
 */
function retryEffectOption(item: Pick<CockpitItem, "boardId" | "cardId">, c: KindCtx, effect: EntryEffect, stepName: string, advice: string): DecisionOption {
  const deploys = effect !== "promote-stage";
  const refusal = c.card ? republishRefusal(c.card, c.config) : null;
  return {
    id: "retry-effect",
    label: deploys ? "Publicar de novo em produção" : "Tentar de novo",
    consequence: deploys
      ? `Roda a publicação de novo a partir de «${stepName}», sem mover o card. ${advice}`
      : `Roda de novo a promoção do código a partir de «${stepName}». ${advice}`,
    // «Publicar de novo» não é vermelho: repete o que já foi aprovado (a confirmação diz que é produção). O vermelho
    // fica para o que descarta ou não tem volta — dois botões vermelhos para coisas opostas confundiam o dono.
    tone: "primary",
    ...(deploys ? { confirm: { title: "Publicar de novo?", body: `A publicação de ${c.title} em produção dispara de novo, a partir de «${stepName}».` } } : {}),
    ...(refusal ? { disabled: { reason: refusal } } : {}),
    auditCls: deploys ? "deploy" : "merge-resolve",
    invoke: { kind: "republish", boardId: item.boardId, cardId: item.cardId },
    done: "Começou de novo. Se não der certo, o Inbox diz por quê.",
  };
}

// ── As decisões, por kind ────────────────────────────────────────────────────────────────────────────

type DecideMap = { [K in CockpitItemKind]: (item: Extract<CockpitItem, { kind: K }>, c: KindCtx) => KindDraft };

const DECIDE: DecideMap = {
  question: (item, c) => {
    const answer: DecisionOption = {
      id: "answer",
      label: item.awaitingProxy ? "Responder antes do procurador" : "Responder",
      consequence: item.awaitingProxy
        ? "Sua resposta vale no lugar da do procurador; o card segue com ela."
        : "Sua resposta vai para o agente, e o card volta a andar com ela.",
      tone: "primary",
      requires: "answer",
      auditCls: "write-board",
      invoke: { kind: "answer-question", boardId: item.boardId, cardId: item.cardId, questionId: item.questionId },
      done: "Respondido. O agente segue com a sua resposta.",
    };
    const ref: EscalationRef = { templateId: "question-pending", kind: "question", boardId: item.boardId, cardId: item.cardId, questionId: item.questionId };
    const byOwner = item.ownerOnly || c.verdict.ownerClass;
    return {
      askVerb: "Responder",
      // a pergunta inteira do agente mora no corpo do item (o formulário) e em Detalhes; a linha é curta
      ask: clip(item.prompt, ASK_MAX) || `Responder a pergunta sobre ${c.title}`,
      happened: [
        `Um agente perguntou enquanto trabalhava em ${c.title}.`,
        byOwner
          ? c.verdict.ownerClass
            ? `Só você decide: toca em «${ownerClassLabel(c.verdict.ownerClass, c.config)}».`
            : "Só você decide: é decisão de negócio (dinheiro, marca, PRD ou dados de pessoas); nunca vai ao procurador."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      options: [answer],
      ifIgnored: "O card fica parado nesta pergunta; o resto do board segue.",
      more: cardMore(item, ref),
      details: [
        { label: "Pergunta", value: item.questionId },
        ...(item.prompt.length > ASK_MAX ? [{ label: "Pergunta inteira", value: item.prompt }] : []),
        ...(item.askedBy ? [{ label: "Perguntado por", value: item.askedBy }] : []),
        ...(item.category ? [{ label: "Categoria", value: item.category }] : []),
      ],
      ...(item.awaitingProxy
        ? {
            bucket: "acompanhar" as const,
            askVerb: null,
            ask: `O procurador está respondendo por você: ${clip(item.prompt, ASK_MAX - 40)}`,
            next: { who: "sistema" as const, label: "O procurador responde" },
            ifIgnored: "O procurador responde pelo PRD e registra as premissas; se quiser decidir você, responda antes.",
          }
        : {}),
      dot: "amber",
    };
  },

  blocker: (item, c) => {
    const stepName = c.step(item.status);
    const ref: EscalationRef = { templateId: blockerTemplateId(item.findingId, item.lens, c.card?.status), kind: "finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId };
    return {
      askVerb: "Liberar",
      ask: `Liberar ${c.title} sem consertar o problema da revisão?`,
      happened: `A revisão encontrou um problema que impede ${c.title} de sair de «${stepName}».`,
      options: [
        {
          ...askJido(ref, "Pedir ao Jido para consertar", "Abre o Jido com o problema carregado; ele propõe e faz o conserto."),
          id: "jido-fix",
          tone: "primary",
        },
        {
          id: "wontfix",
          label: "Liberar sem consertar",
          consequence: "O card segue sem o conserto; o problema fica registrado como «não corrigir».",
          tone: "neutral",
          confirm: { title: "Liberar sem consertar?", body: `${c.title} segue sem o conserto. O problema fica registrado no card.` },
          auditCls: "write-board",
          invoke: { kind: "update-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId, status: "wontfix" },
          done: "Liberado sem o conserto — o problema ficou registrado.",
          undo: { kind: "reopen-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId },
        },
        {
          id: "fixed",
          label: "Já foi consertado",
          consequence: "Diga isto só se o problema já foi resolvido; o card volta a andar sozinho.",
          tone: "neutral",
          auditCls: "write-board",
          invoke: { kind: "update-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId, status: "fixed" },
          done: "Marcado como consertado — o card volta a andar.",
          undo: { kind: "reopen-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId },
        },
      ],
      ifIgnored: `O card não passa de «${stepName}» enquanto o problema estiver aberto.`,
      more: cardMore(item, null),
      details: [
        { label: "Problema", value: item.title },
        ...(item.suggestion ? [{ label: "Sugestão da revisão", value: item.suggestion }] : []),
        ...(item.lens ? [{ label: "Área", value: c.lensNames?.[item.lens] ?? item.lens }] : []),
      ],
      systemIgnored: `O card não passa de «${stepName}» enquanto o problema estiver aberto; o pipeline decide o conserto.`,
      dot: "amber",
    };
  },

  finding: (item, c) => {
    // O aviso que não trava nada é DÍVIDA do card, não item do Inbox (contract.ts `isInboxItem`) — salvo num card que
    // toca uma classe do dono, com importância média ou alta: aí o desfecho dele é decisão de negócio (INB-10).
    const owned = isOwnerAdvisory(item, c.verdict);
    const mk = (status: "acknowledged" | "fixed" | "wontfix", label: string, consequence: string, done: string): DecisionOption => ({
      id: `finding:${status}`,
      label,
      consequence,
      tone: "neutral",
      auditCls: "write-board",
      invoke: { kind: "update-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId, status },
      done,
      undo: { kind: "reopen-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId },
    });
    if (owned) {
      // A DECISÃO do dono é corrigir ou aceitar o risco — nunca «registrar como conhecido» (arquivar não é decidir) nem
      // «já foi resolvido» (um fato técnico que ele não tem como conferir). A ação principal é a que resolve o problema.
      const fixRefusal = findingFixRefusal(c.card, item.findingId);
      return {
        askVerb: "Corrigir",
        ask: `Corrigir o que a revisão achou em ${c.title}, ou aceitar o risco?`,
        happened: `A revisão achou um problema que não impede a entrega, mas o card toca «${ownerClassLabel(c.verdict.ownerClass!, c.config)}»: ${clip(item.title, 160)}`,
        options: [
          {
            id: "finding:fix",
            label: "Mandar corrigir",
            consequence: "Cria um card de conserto com este aviso; o sistema o leva pelo fluxo normal do board. O aviso fica registrado no card de origem.",
            tone: "primary",
            ...(fixRefusal ? { disabled: { reason: fixRefusal } } : {}),
            auditCls: "write-board",
            invoke: { kind: "fix-finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId },
            done: "Card de conserto criado — o sistema cuida dele.",
          },
          {
            ...mk("acknowledged", "Aceitar o risco", "Nada é corrigido: o aviso fica registrado no card como risco aceito por você.", "Registrado como risco aceito."),
            tone: "neutral",
            confirm: { title: "Aceitar o risco?", body: `O problema que a revisão achou em ${c.title} fica sem conserto, registrado no card como risco aceito por você.` },
          },
        ],
        ifIgnored: "Nada trava: o problema fica sem conserto e o aviso segue aberto no card.",
        more: cardMore(item, { templateId: blockerTemplateId(item.findingId, item.lens, c.card?.status), kind: "finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId }),
        details: [
          { label: "O que a revisão achou", value: item.title },
          { label: "Importância", value: severityWords(item.findingSeverity) },
          ...(item.suggestion ? [{ label: "O que a revisão sugere", value: item.suggestion }] : []),
        ],
        dot: "amber",
      };
    }
    // Fora do caso do dono o aviso é dívida do card (não mora no Inbox dele); o cockpit ainda o lista para o agente autônomo.
    return {
      bucket: "acompanhar" as const,
      askVerb: null,
      ask: `Aviso em ${c.title}: ${clip(item.title, 60)}`,
      happened: "A revisão deixou um aviso que não trava nada.",
      ifIgnored: "Nada trava; o aviso fica registrado no card.",
      next: { who: "ninguem" as const, label: "Nada trava" },
      options: [
        mk("acknowledged", "Registrar como conhecido", "Fica registrado no card como dívida conhecida; nada trava.", "Registrado como conhecido."),
        mk("fixed", "Já foi resolvido", "O aviso sai da lista.", "Marcado como resolvido."),
        mk("wontfix", "Não corrigir", "Descarta o aviso de vez, sem consertar.", "Marcado como «não corrigir»."),
      ],
      more: cardMore(item, { templateId: blockerTemplateId(item.findingId, item.lens, c.card?.status), kind: "finding", boardId: item.boardId, cardId: item.cardId, findingId: item.findingId }),
      details: [
        { label: "Aviso", value: item.title },
        { label: "Importância", value: item.findingSeverity },
        ...(item.suggestion ? [{ label: "Sugestão", value: item.suggestion }] : []),
      ],
      dot: "grey",
    };
  },

  "deploy-failed": (item, c) => {
    const ref: EscalationRef = { templateId: "deploy-failed", kind: "deploy", boardId: item.boardId, cardId: item.cardId };
    const status: DecisionOption = {
      id: "more:publish-status",
      label: "Ver o status da publicação",
      consequence: "Mostra se o código deste card está no ar e o registro da publicação. Só leitura.",
      tone: "neutral",
      auditCls: "read",
      invoke: { kind: "show-publish-status", boardId: item.boardId, cardId: item.cardId },
      done: "Aberto.",
    };
    // A CAUSA (deploy-blocks.ts, pré-computada pelo coletor): uma publicação parada é do PACOTE, não do card — o mesmo
    // motivo segura N cards, e o item fala da causa (num caso real, vários itens «Publicar a parte de «<card>» que só você publica?»
    // para poucas causas, e o dono lia o nome do card-vítima, nunca o do código que segurava).
    const cause = deployCauseOfItem(item, c.card, c.facts);
    const held = cause ? cardsOfCause(cause.causeKey, c.facts) : [];
    const n = Math.max(1, held.length);
    const affects = n > 1 ? ` — afeta ${plural(n, "card", "cards")}` : "";
    const why = cause ? causeWords(cause, c.config) : null;
    // o board de cada card que a causa segura: a linha mora no board que PUBLICA o pacote, e os cards podem ser de outros
    const boardOfCard = (id: string) => c.facts?.deployCardBoard.get(id)?.id ?? item.boardId;
    const foreign = held.some((id) => boardOfCard(id) !== c.config.id);
    const cardList = held.length > 1 || foreign
      ? [{ label: "Cards", value: held.map((id) => `${quoted(c.facts?.cardsById.get(id)?.title ?? id)} (${c.facts?.deployCardBoard.get(id)?.name ?? c.config.name})`).join(", ") }]
      : [];
    const details = [{ label: "Motivo", value: item.title }, ...(item.suggestion ? [{ label: "O que resolve", value: item.suggestion }] : []), ...causeDetails(cause), ...cardList];
    // A causa deste card mora no livro de OUTRO board — o que publica o pacote (um card movido de board leva o aviso dele,
    // não a linha). A decisão é do Inbox de lá, com a lista de cards; aqui o item só diz onde, sem botão que não muda nada.
    const heldOn = c.facts?.deployHeldOn.get(item.cardId);
    if (heldOn) {
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: `A publicação de ${c.title} espera no board «${heldOn.name}», que publica o pacote dela`,
        happened: `O que segura a publicação é do pacote que o board «${heldOn.name}» publica. A decisão (e o pedido de autorização, quando houver) está no Inbox desse board, junto com os outros cards que a mesma causa segura.`,
        options: [],
        ifIgnored: `Nada muda daqui: decida no Inbox do board «${heldOn.name}».`,
        next: { who: "voce", label: `Decida no board «${heldOn.name}»` },
        more: [{ ...openCard(heldOn.id, item.cardId), id: "more:open-publisher", label: `Abrir o Inbox de «${heldOn.name}»`, consequence: "Abre o Inbox do board que publica o pacote. Não decide nada.", invoke: { kind: "link", href: inboxListItemHref(heldOn.id, item.id) } }, status],
        details,
        dot: "grey",
      };
    }
    if (item.needsProof) {
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: `O sistema está produzindo a prova de segurança para publicar ${c.title}`,
        happened: "A publicação pediu uma revisão de segurança independente antes de ir ao ar.",
        options: [],
        ifIgnored: "O sistema pede a revisão, e publica de novo sozinho quando ela aprovar.",
        next: { who: "sistema", label: "O sistema cuida" },
        more: [...cardMore(item, ref), status],
        details,
        dot: "grey",
      };
    }
    if (item.needsHuman) {
      // A publicação parou PEDINDO alguém. Quem decide é a causa (decision-class.ts `deploy-hold`), e nunca «só você
      // publica»: o passo a passo do computador e a conversa com o Jido não mudam o desfecho (contract.ts, regra B).
      if (cause?.decider === "system") {
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: `A publicação parou porque ${why}${affects}`,
          happened: "Nada foi publicado: produção segue como estava. O que segurou não é decisão de negócio — é trabalho do sistema.",
          options: [],
          ifIgnored: "O sistema dá uma classe de publicação a essa parte ou abre um card de conserto; quando a causa sumir, os cards voltam a publicar sozinhos.",
          next: { who: "sistema", label: "O sistema cuida" },
          more: [...cardMore(item, ref), status],
          details,
          dot: "grey",
        };
      }
      const anchorId = cause ? c.facts?.deployAnchor.get(cause.causeKey) : undefined;
      const anchor = anchorId ? c.facts?.cardsById.get(anchorId) : undefined;
      // O PLANO PEDE A AUTORIZAÇÃO DO DONO (o livro de causas guarda o pedido: a mudança exata e o comando do alvo que a
      // grava). É a ação que muda o desfecho — e ela é da CAUSA, não do passo em que o card âncora está: o dono pode já
      // ter aprovado a entrega do card (num caso real, aprovada, e o plano seguia parado porque ninguém tinha onde dizer este sim).
      // O PEDIDO SENDO REFEITO: a autorização do dono foi recusada por ser de outra mudança (ou o operador pediu na
      // Esteira), e o sistema está rodando a medição/o deploy do pacote agora para ler os pedidos de agora. Até o plano
      // novo chegar, o botão de antes autorizaria o que já mudou — então não há botão, há o estado.
      if (cause && c.facts?.deployRerequesting.has(cause.causeKey)) {
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: `Refazendo o pedido de publicação…${affects}`,
          happened: "O código guardado mudou desde o último pedido, e o sistema está medindo de novo a publicação do pacote para pedir a sua autorização com a mudança de agora. Nada foi publicado.",
          options: [],
          ifIgnored: "Quando a medição terminar, o pedido novo volta a Decidir (ou some, se nada mais precisar de você).",
          next: { who: "sistema", label: "refazendo o pedido…" },
          more: [status],
          details,
          dot: "grey",
        };
      }
      const approvals = cause ? (c.facts?.deployApprovals.get(cause.causeKey) ?? []) : [];
      // O PEDIDO VELHO QUE O SISTEMA NÃO PÔDE REFAZER SOZINHO (auto-rerequest.ts): a main mexeu nos arquivos do pedido, e
      // refazê-lo daqui exigiria rodar o deploy sem a garantia de que nada publica (o board que publica não declara a
      // medição que só lê). Sem botão de autorizar — autorizaria o que mudou —, a saída é a Esteira.
      if (cause && !approvals.length && c.facts?.deployStale.has(cause.causeKey)) {
        const esteira = c.config.id || item.boardId;
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: `O pedido de publicação envelheceu — refaça pela Esteira${affects}`,
          happened: "O código guardado mudou na main desde o pedido de autorização, então ele já não vale. O sistema não refaz este pedido sozinho porque o board não declara uma medição que só lê, e o deploy poderia publicar. Nada foi publicado.",
          options: [],
          ifIgnored: `A publicação segue parada${affects}; nada vai ao ar.`,
          next: { who: "voce", label: "Refazer pela Esteira" },
          more: [
            {
              id: "more:open-esteira",
              label: "Abrir a Esteira",
              consequence: "Abre a Esteira do board, onde «Refazer os pedidos de publicação» pede a autorização com a mudança de agora. Não decide nada.",
              tone: "neutral",
              auditCls: "read",
              invoke: { kind: "link", href: `/board/${encodeURIComponent(esteira)}/entrega` },
              done: "Aberto.",
            },
            status,
          ],
          details,
          dot: "grey",
        };
      }
      if (cause && approvals.length) {
        const classText = cause.ownerClass ? `«${ownerClassLabel(cause.ownerClass, c.config)}»` : "negócio";
        const files = [...new Set(approvals.flatMap((a) => a.subject.files))];
        const units = [...new Set(approvals.flatMap((a) => a.units))];
        const where = units.length ? ` em ${units.join(", ")}` : "";
        const of = anchor ? ` de ${quoted(anchor.title)}` : "";
        const shown = files.slice(0, 8);
        // Visto de OUTRO card que a mesma causa segura (o selo «Precisa de você» do Kanban mostra este texto em cada card
        // afetado), «…do código de «<âncora>»» parecia falar do card errado: diz que o código vem de lá e segura este.
        const fromOther = anchor && item.cardId && anchor.id !== item.cardId;
        return {
          askVerb: "Autorizar",
          ask: fromOther
            ? `Autorizar a publicação do código de ${classText} que segura este card? (o código vem de ${quoted(anchor.title)})${affects}`
            : `Autorizar a publicação do código de ${classText}${of}?${affects}`,
          happened: `A publicação parou porque a mudança mexe em código de ${classText}, e só você libera isso: ${plural(files.length, "arquivo", "arquivos")}${where}. Nada foi publicado.`,
          options: [
            {
              id: "authorize-publish",
              label: "Autorizar publicar",
              consequence: "Grava a sua autorização para ESTA mudança e dispara a publicação de novo. Se esse código mudar depois, a autorização deixa de valer e o Inbox pede de novo.",
              tone: "primary",
              confirm: {
                title: "Autorizar a publicação?",
                body: `Você autoriza publicar ${plural(files.length, "arquivo", "arquivos")} de código de ${classText}${of}${where}. A autorização vale só para esta mudança.`,
              },
              auditCls: "deploy",
              // a linha da causa mora no livro DESTE Inbox (o board que publica o pacote) — o card pode ser de outro board
              invoke: { kind: "authorize-publish", boardId: c.config.id || item.boardId, causeKey: cause.causeKey },
              done: "Autorização gravada — a publicação foi disparada de novo. Se outra coisa ainda segurar, o Inbox diz o quê.",
            },
          ],
          ifIgnored: `A publicação segue parada${affects}; nada vai ao ar.`,
          more: [...(anchor ? [openCard(boardOfCard(anchor.id), anchor.id)] : cardMore(item, ref)), status],
          details: [
            ...details,
            { label: "O que você autoriza", value: `${plural(files.length, "arquivo", "arquivos")}${where}` },
            { label: "Arquivos", value: `${shown.join(", ")}${files.length > shown.length ? ` … e mais ${files.length - shown.length}` : ""}` },
          ],
          dot: "red",
        };
      }
      if (cause && anchor) {
        // A decisão de negócio da causa é a do card que CARREGA o código guardado (a âncora): aprovar a entrega dele.
        // Até o dono decidir como a autorização vira prova gravada (C2 do ciclo de conserto), a ação é o passo dele — e só
        // quando esse passo é do dono AGORA ({@link anchorRoute}).
        const anchorTitle = quoted(anchor.title);
        const route = anchorRoute(anchor, c);
        const classText = cause.ownerClass ? `«${ownerClassLabel(cause.ownerClass, c.config)}»` : "negócio";
        const story = `O código de ${anchorTitle} pede uma decisão sua de ${classText}; enquanto ela não for tomada, a publicação fica parada${affects}. Nada foi publicado.`;
        if (route.decide) {
          return {
            askVerb: route.decide.askVerb,
            ask: route.decide.ask,
            happened: story,
            options: [route.decide.option],
            ifIgnored: `A publicação segue parada${affects}; nada vai ao ar.`,
            more: [openCard(boardOfCard(anchor.id), anchor.id), status],
            details,
            dot: "red",
          };
        }
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: `A publicação espera a decisão sobre ${anchorTitle}${affects}`,
          happened: `${story} ${route.why}`,
          options: [],
          ifIgnored: route.ifIgnored,
          next: route.next,
          more: [openCard(boardOfCard(anchor.id), anchor.id), status],
          details,
          dot: "grey",
        };
      }
      // Do dono e sem card que a decida (a causa sem âncora, ou ainda não registrada): nada daqui muda o desfecho.
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: `A publicação parou porque ${why ?? PHASE_WORDS["needs-human"]}${affects}`,
        happened: cause?.ownerClass
          ? "O plano de publicação achou código que pede a sua decisão, e ainda não se sabe qual card o carrega. Nada foi publicado."
          : "O plano de publicação parou pedindo alguém, e o motivo ainda não foi classificado. Nada foi publicado.",
        options: [],
        ifIgnored: cause?.ownerClass
          ? "A publicação segue parada. Quando o sistema achar o card que carrega esse código, a decisão sobe para Decidir, uma vez só."
          : "O sistema classifica o motivo na próxima conferência: se for de negócio, sobe para Decidir; se não, o sistema cuida.",
        next: { who: "ninguem", label: "Ninguém resolve daqui", stalled: true },
        more: [...cardMore(item, ref), status],
        details,
        dot: "grey",
      };
    }
    const step = publishStep(c.config);
    const inFlight = !!c.card && deliveryInFlight(c.card, c.config);
    const refusal = c.card && step ? moveRefusal(c.card, step.id, c.config) : null;
    // O disjuntor já agendou a re-tentativa: um ator do sistema resolve (regra C) — o botão fica, mas não é o principal.
    const retryAt = c.facts?.publishRetryAt.get(item.cardId);
    const scheduled = retryAt != null && retryAt > c.now;
    const options: DecisionOption[] = step
      ? [
          {
            id: "republish",
            label: "Publicar de novo em produção",
            consequence: `Move o card para «${step.name}» e dispara a publicação em produção outra vez${scheduled ? ", sem esperar a nova tentativa do sistema" : ""}.`,
            tone: scheduled ? "neutral" : "primary",
            confirm: { title: "Publicar de novo em produção?", body: `${c.title} vai para «${step.name}» e a publicação em produção dispara de novo.` },
            ...(inFlight
              ? { disabled: { reason: "Uma publicação deste card já está em andamento; espere a confirmação dela." } }
              : refusal
                ? { disabled: { reason: refusal, unblock: { label: "Abrir o card", href: cardHref(item.boardId, item.cardId) } } }
                : {}),
            auditCls: "deploy",
            invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: step.id },
            done: "A publicação começou de novo. Se não der certo, o Inbox diz por quê.",
          },
        ]
      : [
          {
            id: "howto-republish",
            label: "No computador: como publicar de novo",
            consequence: "Este board não tem um passo que publica sozinho; mostra como fazer à mão.",
            tone: "neutral",
            auditCls: "read",
            invoke: { kind: "howto", title: "Publicar de novo", steps: ["Abra o card.", "Mova-o de novo para o passo de publicação do seu board.", "Acompanhe aqui a confirmação."] },
            done: "Passo a passo aberto.",
          },
        ];
    const asFact = scheduled || c.verdict.decider === "system";
    return {
      askVerb: "Publicar",
      ask: asFact && why ? `A publicação parou porque ${why}${affects}` : n > 1 && why ? `Publicar de novo? ${capitalize(why)}${affects}` : `Publicar ${c.title} de novo?`,
      happened: `A publicação de ${c.title} falhou${why ? ` (${why})` : ""}. O código está pronto, mas não está no ar.`,
      options: [...options, ...(step ? [] : [{ ...askJido(ref, "Pedir ao Jido para publicar"), id: "jido-publish" }])],
      ifIgnored: scheduled ? `O sistema tenta publicar de novo ${timeToken(new Date(retryAt!).toISOString())}; se repetir, para e avisa.` : "O trabalho aprovado continua fora do ar.",
      ...(scheduled ? { bucket: "acompanhar" as const, next: { who: "sistema" as const, label: "O sistema tenta de novo" } } : {}),
      more: [...cardMore(item, ref), status],
      details,
      dot: "red",
    };
  },

  gate: (item, c) => {
    const card = c.card;
    const stepName = c.step(item.status);
    const ref: EscalationRef = { templateId: "gate-manual-approve", kind: "card", boardId: item.boardId, cardId: item.cardId };
    const options: DecisionOption[] = [];
    const fwd = card ? forwardOf(card, c.config, item.boardId, c.title) : null;
    // as causas de publicação do DONO que esperam este card (ele carrega o código guardado — contract.ts, a âncora)
    const anchored = card ? ownerCausesAnchoredAt(card.id, c.facts) : [];
    if (fwd) {
      const classes = [...new Set(anchored.map((a) => (a.cause.ownerClass ? `«${ownerClassLabel(a.cause.ownerClass, c.config)}»` : "negócio")))];
      // honesto: aprovar a entrega não é a autorização gravada da publicação (ainda sem botão — C2 do ciclo de conserto)
      options.push(
        anchored.length
          ? { ...fwd.option, consequence: `${fwd.option.consequence} Se a publicação ainda pedir a sua autorização para o código de ${classes.join(" e ")}, o Inbox mostra.` }
          : fwd.option,
      );
    }
    if (card) {
      const prev = previousEligible(card, c.config);
      if (prev && card.status) {
        options.push({
          id: "return",
          label: `Devolver para «${prev.name}»`,
          consequence: "O card volta um passo para ajuste; nada é publicado.",
          tone: "neutral",
          auditCls: "write-board",
          invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: prev.id },
          done: `${c.title} voltou para «${prev.name}».`,
          undo: { kind: "move-back", boardId: item.boardId, cardId: item.cardId, from: prev.id, to: card.status },
        });
      }
    }
    const externalEffect = fwd?.externalEffect ?? false;
    // Sem opção para a frente: nada a aprovar aqui (o próximo passo ainda não aceita o card) — não é decisão sua.
    const idx = card ? c.config.statuses.findIndex((s) => s.id === card.status) : -1;
    const next = idx >= 0 ? c.config.statuses[idx + 1] : undefined;
    const blockedBy = !fwd && card && next ? evaluateGate(card, next.id, c.config) : null;
    // A decisão de NEGÓCIO deste card, dita: a classe que ele toca (e o porquê do juiz), a publicação que espera por ele
    // (as causas do dono ancoradas aqui) e os riscos que a revisão deixou abertos — o resumo para o dono decidir sem
    // abrir o código (num caso real, «Mandar «<título>» para «Integrar»?» sem dizer que era o
    // código de um card segurando a publicação de outros).
    const held = new Set(anchored.flatMap((a) => a.cards).filter((id) => id !== card?.id));
    const risks = (card?.findings ?? []).filter((f) => f.status === "open" && (f.severity === "high" || f.severity === "medium"));
    const business = [
      c.verdict.ownerClass ? `Só você decide: toca em «${ownerClassLabel(c.verdict.ownerClass, c.config)}»${card?.businessClasses?.reason ? ` — ${clip(card.businessClasses.reason, 120)}` : ""}.` : "",
      held.size ? `A publicação de ${plural(held.size, "outro card espera", "outros cards esperam")} esta decisão.` : "",
      risks.length ? `${plural(risks.length, "risco aberto", "riscos abertos")} na revisão (em Detalhes).` : "",
    ].filter(Boolean);
    return {
      askVerb: fwd ? fwd.askVerb : null,
      ask: fwd ? fwd.ask : `${c.title} está em «${stepName}», sem nada a aprovar agora`,
      happened: fwd
        ? [`O agente terminou o trabalho de ${c.title}, e o card parou em «${stepName}» esperando alguém mandar seguir.`, ...business].join(" ")
        : blockedBy && next
          ? `O próximo passo («${next.name}») ainda não aceita este card; a condição que falta está em Detalhes.`
          : `Não há um próximo passo que ${c.title} possa alcançar agora.`,
      options,
      ifIgnored: fwd
        ? externalEffect
          ? `Fica em «${stepName}», sem prazo; nada vai ao ar.`
          : held.size
            ? `Fica em «${stepName}», sem prazo; a publicação dos outros cards segue parada.`
            : `Fica em «${stepName}», sem prazo.`
        : "O card fica onde está até a condição do próximo passo ser cumprida.",
      ...(fwd ? {} : { bucket: "acompanhar" as const, next: { who: "ninguem" as const, label: "Espera uma condição" } }),
      more: cardMore(item, ref),
      details: [
        { label: "Passo", value: stepName },
        ...(blockedBy ? [{ label: `Falta para «${next?.name ?? "o próximo passo"}»`, value: `${blockedBy.label}: ${blockedBy.message}${blockedBy.fix ? ` ${blockedBy.fix}` : ""}` }] : []),
        ...(held.size ? [{ label: "Cards que esperam esta decisão", value: [...held].map((id) => c.facts?.cardsById.get(id)?.title ?? id).join(" · ") }] : []),
        ...risks.map((f) => ({ label: `Risco aberto (${f.severity})`, value: f.title })),
      ],
      systemIgnored: `O pipeline e o verificador levam ${c.title} adiante com prova; você vê o resultado aqui.`,
      dot: externalEffect || held.size ? "red" : "green",
    };
  },

  approval: (item, c) => {
    const approvalId = item.id.replace(/^apr:/, "");
    const who = approvalWho(item.requestedBy);
    const action = approvalActionText(item, c);
    const ref: EscalationRef = { templateId: "approval-pending", kind: "approval", boardId: item.boardId, approvalId };
    return {
      askVerb: "Deixar",
      ask: `Deixar ${who} ${action}?`,
      happened: `${capitalize(who)} pediu permissão. A regra de risco deste board manda perguntar a você antes.`,
      options: [
        {
          id: "grant",
          label: "Deixar fazer",
          consequence: "Autoriza esta ação uma vez, exatamente como foi pedida.",
          tone: "primary",
          confirm: {
            title: `Deixar ${who} ${action}?`,
            body: item.args ? "A autorização vale uma vez, para exatamente o que foi pedido (veja em Detalhes)." : "Os detalhes do pedido não estão disponíveis — abra o board e recarregue antes de autorizar.",
          },
          ...(item.args ? {} : { disabled: { reason: "Os detalhes do pedido não chegaram; sem eles não dá para autorizar às cegas." } }),
          auditCls: item.riskClass ?? "write-board",
          invoke: { kind: "grant-request", boardId: item.boardId, approvalId },
          done: "Autorizado — o agente pode fazer isto uma vez.",
        },
        {
          id: "deny",
          label: "Não deixar",
          consequence: "O agente segue sem esta ação.",
          tone: "neutral",
          auditCls: "write-board",
          invoke: { kind: "deny-request", boardId: item.boardId, approvalId },
          done: "Negado — o agente segue sem esta ação.",
        },
      ],
      ifIgnored: item.expiresAt ? `Vence ${timeToken(item.expiresAt)} e o agente não faz.` : "Vence em um dia e o agente não faz.",
      more: [...(item.cardId ? [openCard(item.boardId, item.cardId)] : []), askJido(ref)],
      details: [
        ...(item.tool ? [{ label: "Ferramenta", value: item.tool }] : []),
        ...(item.riskClass ? [{ label: "Classe de risco", value: item.riskClass }] : []),
        ...(item.requestedBy ? [{ label: "Pedido por", value: approvalRequesterText(item.requestedBy) }] : []),
        ...(item.args ? [{ label: "Argumentos", value: item.args }] : []),
      ],
      dot: item.riskClass === "deploy" || item.riskClass === "destructive" ? "red" : "green",
    };
  },

  review: (item, c) => {
    const card = c.card;
    const target = card ? c.config.statuses.find((s) => s.id === acceptRoute(card)) : undefined;
    const staging = card ? c.config.statuses.find((s) => s.id === card.status)?.staging === true : false;
    const refusal = card && target && staging ? acceptTriageRefusal(card, c.config) : null;
    const gateVerdict = card && target ? evaluateGate(card, target.id, c.config) : null;
    const placement = refusal && card && refusal === triagePlacementGap(card, c.config);
    const ref: EscalationRef = { templateId: "review-triage", kind: "card", boardId: item.boardId, cardId: item.cardId };
    const options: DecisionOption[] = [];
    if (card && target && staging) {
      options.push({
        id: "accept",
        label: `Aceitar e mandar para «${target.name}»`,
        consequence: `O card entra no fluxo em «${target.name}»${target.autorun ? ", e o agente do passo começa" : ""}.`,
        tone: "primary",
        ...(refusal
          ? {
              disabled: {
                reason: gateVerdict && refusal === gateVerdict.message ? `${gateVerdict.message}${gateVerdict.fix ? ` ${gateVerdict.fix}` : ""}` : refusal,
                unblock: { label: placement ? "Definir o lugar no mapa" : "Completar o card agora", href: cardHref(item.boardId, item.cardId, { view: "campos" }) },
              },
            }
          : {}),
        auditCls: "write-board",
        invoke: { kind: "accept-triage", boardId: item.boardId, cardId: item.cardId },
        done: `${c.title} foi para «${target.name}»${target.autorun ? "; o agente começou" : ""}.`,
        ...(card.status ? { undo: { kind: "move-back" as const, boardId: item.boardId, cardId: item.cardId, from: target.id, to: card.status, toStaging: true } } : {}),
      });
      // O que DEPENDE deste card vai junto (card-dependents.ts) — antes o clique voltava com «reancore-os primeiro»,
      // uma regra de estrutura do mapa travando uma decisão que o dono já tinha tomado. O plano é feito com os cards
      // do board (os fatos do coletor); sem eles, o descarte é o de um card só e o servidor recusa se houver dependente.
      const plan = c.facts ? discardPlan(item.cardId, [...c.facts.cardsById.values()], c.config) : null;
      const along = plan?.dependents ?? [];
      const groupRefusal = plan && along.length ? discardGroupRefusal(plan) : null;
      const blocker = plan && !plan.cascade.ok ? plan.cascade.blocker : null;
      const many = along.length === 1 ? "o card que depende dele" : `os ${along.length} cards que dependem dele`;
      options.push({
        id: "discard",
        label: along.length && !groupRefusal ? `Descartar com ${many}` : "Descartar",
        consequence: along.length
          ? `Vai para a lixeira do board junto com ${many} (${dependentsSample(along, 3)}); dá para restaurar todos por 7 dias.`
          : "O card vai para a lixeira do board; dá para restaurar por 7 dias.",
        tone: "danger",
        ...(groupRefusal
          ? { disabled: { reason: groupRefusal, ...(blocker ? { unblock: { label: "Abrir o card que segura", href: cardHref(item.boardId, blocker.id) } } : {}) } }
          : {}),
        confirm: along.length
          ? { title: `Descartar este item e ${many}?`, body: `${c.title} vai para a lixeira do board junto com ${dependentsSample(along, 5)} — dá para restaurar todos por 7 dias.` }
          : { title: "Descartar este item?", body: `${c.title} vai para a lixeira do board — dá para restaurar por 7 dias.` },
        auditCls: "destructive",
        invoke: { kind: "delete-card", boardId: item.boardId, cardId: item.cardId, ...(along.length ? { withDependents: true } : {}) },
        done: along.length
          ? `${c.title} e ${many} foram para a lixeira (dá para restaurar todos por 7 dias).`
          : `${c.title} foi para a lixeira (dá para restaurar por 7 dias).`,
        undo: { kind: "restore-card", boardId: item.boardId, cardId: item.cardId, ...(along.length ? { group: true } : {}) },
      });
    }
    const why = c.verdict.ownerClass
      ? `Toca em «${ownerClassLabel(c.verdict.ownerClass, c.config)}», então é decisão sua.`
      : card?.triageDecision?.verdict === "hold"
        ? // o `hold` do DONO (ele desfez um aceite) não é o juiz em dúvida: o card voltou para ele
          card.triageDecision.by === "human"
          ? `Voltou para você: ${clip(card.triageDecision.reason, 140)}.`
          : `O juiz da triagem não conseguiu decidir: ${clip(card.triageDecision.reason, 140)}`
        : "Chegou sem ninguém revisar.";
    return {
      askVerb: "Aceitar",
      ask: `Aceitar ${c.title} como trabalho?`,
      happened: `${c.title} está na Triagem. ${why}`,
      options,
      ifIgnored: "Fica na Triagem; nenhum agente mexe.",
      more: cardMore(item, ref),
      details: [],
      systemIgnored: "O juiz da triagem aceita, descarta ou junta pelo PRD e registra o porquê.",
      dot: "green",
    };
  },

  stuck: (item, c) => {
    const stepName = item.trigger ? (c.config.statuses.find((s) => s.trigger === item.trigger)?.name ?? c.step(item.status)) : c.step(item.status);
    const refusal = c.card ? runSkillRefusal(c.card, c.config) : null;
    const repeats = item.outcome === "no-op" || item.outcome === "budget-cut" || item.reason === "no-op" || item.reason === "budget-cut";
    const ref: EscalationRef = { templateId: "run-death", kind: "run", boardId: item.boardId, cardId: item.cardId };
    // «Tentar de novo» que não muda nada é bloqueado, com o porquê (regra B do contrato): a falha da FERRAMENTA (o
    // conserto mora no host — decision-class.ts `stuckFailure`) e o mesmo «não há trabalho»/corte de gasto que voltou
    // depois de um «Tentar de novo» do dono neste passo (num caso real, o mesmo desfecho se repetiu a cada tentativa).
    const failure = stuckFailure(item, c.card);
    const retries = repeats ? manualRetriesInStep(item, c.facts) : 0;
    const futile =
      failure?.origin === "tool"
        ? `Falha da ferramenta${failure.label ? ` (${failure.label})` : ""}: tentar de novo dá o mesmo desfecho enquanto o conserto no servidor não for feito.`
        : repeats && (failure?.repeatedNoOp || retries > 0)
          ? `Já foi tentado de novo neste passo${retries > 0 ? ` (${plural(retries, "vez", "vezes")})` : ""} e o agente terminou do mesmo jeito: sem mudar o card, o desfecho é o mesmo.`
          : null;
    const retry: DecisionOption = {
      id: "retry",
      label: "Tentar de novo",
      consequence: repeats
        ? item.outcome === "no-op" || item.reason === "no-op"
          ? "Roda o agente de novo; sem mudar o card, ele tende a concluir de novo que não há trabalho."
          : "Roda o agente de novo; sem quebrar o card em partes menores, tende a ser cortado de novo pelo limite de gasto."
        : `Roda de novo o agente de «${stepName}», do ponto em que parou.`,
      tone: repeats ? "neutral" : "primary",
      ...(refusal ? { disabled: { reason: refusal } } : futile ? { disabled: { reason: futile, unblock: { label: "Abrir o card", href: cardHref(item.boardId, item.cardId) } } } : {}),
      auditCls: "run",
      invoke: { kind: "run-skill", boardId: item.boardId, cardId: item.cardId },
      done: `O agente de «${stepName}» começou de novo. Se falhar, o Inbox mostra.`,
    };
    const options = [retry, ...(refusal || repeats || futile ? [{ ...askJido(ref, "Pedir ao Jido para olhar", "O Jido olha o que aconteceu e propõe o próximo passo."), id: "jido-look" }] : [])];
    return {
      askVerb: futile ? null : "Tentar",
      ask: futile ? `${c.title} parou em «${stepName}», e tentar de novo do mesmo jeito não muda nada` : `Tentar de novo o passo «${stepName}» de ${c.title}?`,
      happened: stuckHappened(item),
      options,
      ifIgnored: futile ? "O card fica parado até alguém mudar o card ou consertar a causa; tentar do mesmo jeito não adianta." : "O card fica parado; ninguém tenta de novo sozinho.",
      // em QUALQUER modo: tentar do mesmo jeito não muda nada, e nenhum ator do sistema re-tenta isso sozinho
      ...(futile ? { bucket: "acompanhar" as const, next: { who: "ninguem" as const, label: "Ninguém resolve daqui", stalled: true as const } } : {}),
      more: [
        ...cardMore(item, repeats || refusal || futile ? null : ref),
        {
          id: "more:processes",
          label: "Ver o que está rodando",
          consequence: "Abre a página de processos deste card. Só leitura.",
          tone: "neutral",
          auditCls: "read",
          invoke: { kind: "link", href: processesServiceHref(runServiceId(item.boardId, item.cardId)) },
          done: "Aberto.",
        },
      ],
      details: [
        ...(item.reason ? [{ label: "Motivo técnico", value: item.reason }] : []),
        ...(item.outcome && item.outcome !== item.reason ? [{ label: "Detalhe", value: item.outcome }] : []),
        ...(item.evidence?.detail ? [{ label: "Diagnóstico", value: item.evidence.detail }] : []),
      ],
      dot: "amber",
    };
  },

  conflict: (item, c) => {
    const gateFailed = item.conflictKind === "merge-gate-failed";
    const ref: EscalationRef = item.runId
      ? { templateId: item.conflictKind, kind: "merge", boardId: item.boardId, cardId: item.cardId, runId: item.runId, entryStatus: gateFailed ? "gate-failed" : "conflict" }
      : { templateId: item.conflictKind, kind: "card", boardId: item.boardId, cardId: item.cardId };
    const discard: DecisionOption[] = item.runId
      ? [
          {
            id: "discard-work",
            label: "Descartar este trabalho",
            consequence: "O que não entrou é perdido de vez; a fila de integração do board destrava.",
            tone: "danger",
            confirm: { title: "Descartar este trabalho?", body: `O trabalho de ${c.title} que não entrou no código principal é perdido.` },
            auditCls: "merge-resolve",
            invoke: gateFailed ? { kind: "resolve-gate", runId: item.runId, action: "abort" } : { kind: "resolve-merge", runId: item.runId, action: "aborted" },
            done: "Trabalho descartado — a fila de integração segue sem ele.",
          },
        ]
      : [];
    const main: DecisionOption[] = gateFailed
      ? item.runId
        ? [
            {
              id: "retest",
              label: "Testar a integração de novo",
              consequence: "Os testes da integração rodam outra vez; use se a falha foi passageira ou já foi corrigida.",
              tone: "primary",
              auditCls: "merge-resolve",
              invoke: { kind: "resolve-gate", runId: item.runId, action: "retry" },
              done: "Os testes da integração começaram de novo.",
            },
          ]
        : []
      : [
          { ...askJido(ref, "Pedir ao Jido para integrar", "O Jido tenta juntar as duas versões e diz o que decidiu."), id: "jido-integrate", tone: "primary" },
          {
            id: "howto-integrate",
            label: "No computador: como integrar à mão",
            consequence: "Mostra o passo a passo para resolver o conflito no computador.",
            tone: "neutral",
            auditCls: "read",
            invoke: {
              kind: "howto",
              title: "Integrar à mão",
              steps: [
                "No computador, abra a página de processos na integração deste card (em «Mais»).",
                "Junte as duas versões do código e confira que os testes passam.",
                "Marque o trabalho como integrado na página de processos.",
              ],
            },
            done: "Passo a passo aberto.",
          },
        ];
    return {
      askVerb: gateFailed ? "Testar" : "Integrar",
      ask: gateFailed ? `Testar a integração de ${c.title} de novo?` : `Integrar ou descartar o trabalho de ${c.title}?`,
      happened: gateFailed
        ? `Os testes da integração reprovaram o trabalho de ${c.title}.`
        : `A integração automática de ${c.title} parou: duas versões mudaram o mesmo trecho.`,
      options: [...main, ...discard],
      ifIgnored: "Trava a fila de integração de todo o board.",
      more: [
        ...cardMore(item, ref),
        {
          id: "more:processes",
          label: "Ver na página de processos",
          consequence: "Abre a integração deste card na página de processos. Só leitura.",
          tone: "neutral",
          auditCls: "read",
          invoke: { kind: "link", href: item.runId ? processesMergeHref(item.runId) : "/processes" },
          done: "Aberto.",
        },
      ],
      details: [...(item.runId ? [{ label: "Execução", value: item.runId }] : [])],
      dot: "red",
    };
  },

  "merge-failed": (item, c) => {
    const discardable = /^(failed\/)?run\/[A-Za-z0-9-]+$/.test(item.branch);
    const ref: EscalationRef = { templateId: "merge-failed-terminal", kind: "merge", boardId: item.boardId, cardId: item.cardId, runId: item.runId, entryStatus: "failed" };
    return {
      askVerb: "Integrar",
      ask: `Integrar o trabalho de ${c.title} de novo?`,
      happened: `A integração do trabalho de ${c.title} falhou e ele ficou fora do código principal.`,
      options: [
        {
          id: "requeue",
          label: "Integrar de novo",
          consequence: "O trabalho volta para a fila de integração e os testes rodam outra vez.",
          tone: "primary",
          auditCls: "merge-resolve",
          invoke: { kind: "requeue-merge", runId: item.runId },
          done: "A integração começou de novo.",
        },
        ...(discardable
          ? [
              {
                id: "discard-work",
                label: "Descartar este trabalho",
                consequence: "Apaga de vez o que não entrou no código principal.",
                tone: "danger" as const,
                confirm: { title: "Descartar este trabalho?", body: `O trabalho de ${c.title} que não entrou é apagado de vez.` },
                auditCls: "destructive" as const,
                invoke: { kind: "discard-branch" as const, branch: item.branch },
                done: "Trabalho descartado.",
              },
            ]
          : []),
      ],
      ifIgnored: "Este trabalho fica fora do código principal.",
      more: cardMore(item, ref),
      details: [
        { label: "Execução", value: item.runId },
        { label: "Ramo", value: item.branch },
        ...(item.failureReason ? [{ label: "Motivo", value: item.failureReason }] : []),
      ],
      dot: "amber",
    };
  },

  proposal: (item, c) => {
    const ref: EscalationRef = { templateId: "proposal-capture", kind: "card", boardId: item.boardId, cardId: item.cardId };
    const remove: DecisionOption = {
      id: "delete-proposal",
      label: "Excluir a proposta",
      consequence: "A proposta sai; nenhum card é criado. Dá para restaurar da lixeira por 7 dias.",
      tone: "danger",
      confirm: { title: "Excluir esta proposta?", body: "Nenhum card é criado. A proposta vai para a lixeira do board." },
      auditCls: "destructive",
      invoke: { kind: "delete-card", boardId: item.boardId, cardId: item.cardId },
      done: "Proposta excluída (dá para restaurar da lixeira por 7 dias).",
      undo: { kind: "restore-card", boardId: item.boardId, cardId: item.cardId },
    };
    if (item.items.length === 0) {
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: "O agente está montando a proposta da sua captura",
        happened: "Você escreveu uma captura; o agente está transformando o texto em cards.",
        options: [remove],
        ifIgnored: "Quando a proposta ficar pronta, ela aparece em Decidir.",
        next: { who: "sistema", label: "O agente está trabalhando" },
        more: [],
        details: [],
        dot: "grey",
      };
    }
    const n = item.items.length;
    const creates = item.items.filter((i) => !i.targetCardId).length;
    return {
      askVerb: creates === n ? "Criar" : "Aplicar",
      ask: creates === n ? `Criar os ${plural(n, "card proposto", "cards propostos")}?` : `Aplicar os ${plural(n, "item proposto", "itens propostos")}?`,
      happened: `Você escreveu uma captura, e o agente propôs ${plural(n, "item", "itens")}${item.rounds ? ` (depois de ${plural(item.rounds, "ajuste", "ajustes")})` : ""}.`,
      options: [
        {
          id: "accept-proposal",
          label: creates === n ? "Criar os cards marcados" : "Aplicar os itens marcados",
          consequence: "Os itens marcados entram no board; esta proposta sai do Inbox.",
          tone: "primary",
          requires: "selection",
          auditCls: "write-board",
          invoke: { kind: "accept-proposal", boardId: item.boardId, containerId: item.cardId },
          done: "Os itens marcados entraram no board.",
        },
        {
          id: "refine-proposal",
          label: "Pedir ajustes",
          consequence: "O agente refaz a proposta com o seu comentário; nenhum card é criado ainda.",
          tone: "neutral",
          requires: "note",
          auditCls: "write-board",
          invoke: { kind: "refine-proposal", boardId: item.boardId, containerId: item.cardId },
          done: "O agente está refazendo a proposta com o seu comentário.",
        },
        remove,
      ],
      ifIgnored: "Nenhum card é criado.",
      more: [askJido(ref)],
      details: [],
      dot: "green",
    };
  },

  design: (item, c) => {
    const pending = unresolvedChanges({ feedback: item.feedback }).length;
    const refusal = designApproveRefusal(c.card, c.config, item.chosenId);
    const rec = c.card ? (moveTargets(c.card, c.config).find((t) => t.recommended)?.status ?? null) : null;
    const ref: EscalationRef = { templateId: "design-wireframe", kind: "card", boardId: item.boardId, cardId: item.cardId };
    const screens = item.artifacts.length || item.options.length;
    const approve: DecisionOption = {
      id: "approve-design",
      label: "Aprovar o design",
      consequence: rec ? `O design fica valendo e o card vai para «${rec.name}».` : "O design fica valendo e o card segue para o próximo passo.",
      tone: "primary",
      ...(refusal
        ? { disabled: { reason: refusal, ...(item.chosenId ? {} : { unblock: { label: "Escolher a tela principal abaixo", href: `#design-${item.cardId}` } }) } }
        : pending > 0
          ? { disabled: { reason: `Há ${plural(pending, "pedido de mudança aberto", "pedidos de mudança abertos")} neste design.`, unblock: { label: "Enviar para redesenho", href: `#design-${item.cardId}` } } }
          : {}),
      auditCls: "write-board",
      invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: rec?.id ?? item.status ?? "" },
      done: rec ? `Design aprovado; ${c.title} foi para «${rec.name}».` : "Design aprovado.",
      ...(rec && c.card?.status ? { undo: { kind: "move-back" as const, boardId: item.boardId, cardId: item.cardId, from: rec.id, to: c.card.status } } : {}),
    };
    const redesign: DecisionOption = {
      id: "request-redesign",
      label: pending > 0 ? `Enviar para redesenho (${pending})` : "Enviar para redesenho",
      consequence: "O agente redesenha incorporando os seus comentários nas telas.",
      tone: pending > 0 ? "primary" : "neutral",
      ...(pending > 0 ? {} : { disabled: { reason: "Comente o que mudar nas telas abaixo antes de pedir o redesenho.", unblock: { label: "Comentar nas telas", href: `#design-${item.cardId}` } } }),
      auditCls: "write-board",
      invoke: { kind: "request-redesign", boardId: item.boardId, cardId: item.cardId },
      done: "Pedido de redesenho enviado ao agente.",
    };
    return {
      askVerb: "Aprovar",
      ask: `Aprovar o design de ${c.title}?`,
      happened: `O agente desenhou ${plural(screens, "tela", "telas")} para ${c.title}.${c.card?.ownerReviewsUi ? " Você pediu para ver as opções de tela deste card." : ""}`,
      options: pending > 0 ? [redesign, { ...approve, tone: "neutral" }] : [approve, redesign],
      ifIgnored: "O card não começa a ser construído.",
      more: cardMore(item, ref),
      details: [],
      systemIgnored: "O especialista de telas escolhe pelo guia de estilo e registra as alternativas.",
      dot: "green",
    };
  },

  governance: (item, c) => {
    const ref: EscalationRef = { templateId: "governance-draft", kind: "governance", boardId: item.boardId, draftId: item.draftId };
    const blocked = item.conflicts.length > 0 || Boolean(item.conflictMessage);
    const sections = governanceSectionCount(item);
    const expires = governanceExpiry(item.since);
    return {
      askVerb: "Aprovar",
      ask: `Aprovar ${sections} no PRD e nas metas do board?`,
      happened: `${item.origin?.skill ? "Um agente propôs" : "Alguém propôs"} mudar ${sections}: ${clip(item.reason, 160)}`,
      options: [
        {
          id: "approve-governance",
          label: "Aprovar as mudanças",
          consequence: "As mudanças passam a valer no board.",
          tone: "primary",
          ...(blocked
            ? {
                disabled: {
                  reason: item.conflictMessage ?? "O texto atual mudou depois da proposta; ela precisa ser refeita sobre o valor de hoje.",
                  unblock: { label: "Pedir uma proposta nova ao Jido", href: `/board/${item.boardId}/kanban` },
                },
              }
            : {}),
          auditCls: "write-board",
          invoke: { kind: "approve-governance", boardId: item.boardId, draftId: item.draftId },
          done: "Aprovado — as mudanças já valem no board.",
        },
        {
          id: "reject-governance",
          label: "Rejeitar",
          consequence: "O board fica como está.",
          tone: "neutral",
          auditCls: "write-board",
          invoke: { kind: "reject-governance", boardId: item.boardId, draftId: item.draftId },
          done: "Rejeitado — o board ficou como estava.",
        },
      ],
      ifIgnored: expires ? `Vence em ${dayToken(expires)} e o board fica como está.` : "Vence em 14 dias e o board fica como está.",
      more: [...(item.cardId ? [openCard(item.boardId, item.cardId)] : []), askJido(ref)],
      details: [
        { label: "Proposta", value: item.draftId },
        ...(item.origin?.skill ? [{ label: "Origem", value: item.origin.skill }] : []),
      ],
      dot: blocked ? "amber" : "green",
    };
  },

  "deploy-unsettled": (item, c) => {
    const stepName = c.step(item.status);
    const ref: EscalationRef = { templateId: "deploy-unsettled", kind: "deploy", boardId: item.boardId, cardId: item.cardId };
    const status: DecisionOption = {
      id: "more:publish-status",
      label: "Ver o status da publicação",
      consequence: "Mostra se o código deste card está no ar e o registro da publicação. Só leitura.",
      tone: "neutral",
      auditCls: "read",
      invoke: { kind: "show-publish-status", boardId: item.boardId, cardId: item.cardId },
      done: "Aberto.",
    };
    const refusal = c.card ? republishRefusal(c.card, c.config) : null;
    const republish: DecisionOption = {
      id: "republish",
      label: "Publicar de novo para provar",
      consequence: `Roda a publicação de novo a partir de «${stepName}», sem mover o card; a prova de que está no ar é medida outra vez.`,
      // repetir o que já foi aprovado não é vermelho (o vermelho é do que descarta ou não tem volta)
      tone: "primary",
      confirm: { title: "Publicar de novo?", body: `A publicação de ${c.title} em produção dispara de novo, a partir de «${stepName}».` },
      ...(refusal ? { disabled: { reason: refusal } } : {}),
      auditCls: "deploy",
      invoke: { kind: "republish", boardId: item.boardId, cardId: item.cardId },
      done: "A publicação começou de novo. Se não provar, o Inbox diz por quê.",
    };
    const details = [
      { label: "Disparada em", value: item.deployFiredAt },
      ...(item.held?.detail ? [{ label: "Motivo", value: item.held.detail }] : []),
      ...(item.lastDeploy ? [{ label: "Última publicação", value: `${item.lastDeploy.target}: ${item.lastDeploy.status}${item.lastDeploy.exitCode !== undefined ? ` (${item.lastDeploy.exitCode})` : ""}` }] : []),
    ];
    const finished = item.held || (item.lastDeploy !== undefined && item.lastDeploy?.status !== "running");
    if (!finished) {
      // Ainda rodando (ou sem como saber): conferimos de novo — e, passado o prazo, sobe para você (se a classe é sua).
      const fired = Date.parse(item.deployFiredAt);
      const promoteAt = Number.isFinite(fired) ? new Date(fired + DEPLOY_WATCH_MINUTES * 60_000).toISOString() : null;
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: `A publicação de ${c.title} ainda não confirmou que está no ar`,
        happened: item.lastDeploy?.status === "running" ? "A publicação ainda está rodando." : "Não dá para saber daqui se a publicação ainda roda.",
        options: [{ ...askJido(ref, "Pedir ao Jido para conferir", "O Jido confere a publicação e diz o que encontrou."), id: "jido-check" }],
        ifIgnored: promoteAt ? `Conferimos de novo; se nada confirmar até ${timeToken(promoteAt)}, volta para quem decide.` : "Conferimos de novo quando a publicação terminar.",
        next: { who: "sistema", label: "A publicação está rodando" },
        more: [...cardMore(item, null), status],
        details,
        dot: "grey",
        ...(promoteAt
          ? {
              promotion: {
                at: promoteAt,
                askVerb: "Pedir",
                ask: `Pedir ao Jido para investigar a publicação de ${c.title}? Ela passou do prazo sem confirmar.`,
                systemText: "Passou do prazo sem confirmar e ninguém investiga sozinho; o card fica em «Publicar» até alguém olhar.",
              },
            }
          : {}),
      };
    }
    return {
      askVerb: "Publicar",
      ask: `Publicar ${c.title} de novo para provar que está no ar?`,
      happened: item.held
        ? `A publicação de ${c.title} rodou, mas não provou que o código dele está no ar.`
        : `A publicação de ${c.title} terminou, e nada confirmou que o código dele está no ar.`,
      options: [republish, { ...askJido(ref, "Pedir ao Jido para investigar", "O Jido olha o registro da publicação e diz o que houve."), id: "jido-investigate" }],
      ifIgnored: `O card fica em «${stepName}» e não fecha; nada novo vai ao ar.`,
      more: [...cardMore(item, null), status],
      details,
      dot: "red",
    };
  },

  "release-aging": (item, c) => {
    const step = publishStep(c.config);
    const inFlight = !!c.card && deliveryInFlight(c.card, c.config);
    const refusal = c.card && step ? moveRefusal(c.card, step.id, c.config) : null;
    const ref: EscalationRef = { templateId: "release-aging", kind: "card", boardId: item.boardId, cardId: item.cardId };
    return {
      askVerb: "Publicar",
      ask: `Publicar ${c.title} agora?`,
      happened: `O código de ${c.title} está aprovado e homologado há ${plural(item.ageDays, "dia", "dias")}, esperando a publicação.`,
      options: step
        ? [
            {
              id: "publish",
              label: "Publicar em produção",
              consequence: `Move o card para «${step.name}» e coloca o código aprovado no ar.`,
              tone: "danger",
              confirm: { title: "Publicar em produção?", body: `${c.title} vai para «${step.name}» e a publicação em produção dispara.` },
              ...(inFlight
                ? { disabled: { reason: "Uma publicação deste card já está em andamento; espere a confirmação dela." } }
                : refusal
                  ? { disabled: { reason: refusal } }
                  : {}),
              auditCls: "deploy",
              invoke: { kind: "move-card", boardId: item.boardId, cardId: item.cardId, status: step.id },
              done: `${c.title} foi para «${step.name}». A publicação começou.`,
            },
          ]
        : [{ ...askJido(ref, "Pedir ao Jido para publicar"), id: "jido-publish" }],
      ifIgnored: "O código aprovado continua fora do ar.",
      more: cardMore(item, step ? ref : null),
      details: [{ label: "Homologado em", value: item.stagedAt }],
      dot: "red",
    };
  },

  "proxy-audit": (item, c) => ({
    bucket: "acompanhar",
    askVerb: null,
    ask: `O procurador respondeu por você em ${c.title} — revisar quando puder`,
    happened: `Pergunta: ${clip(item.prompt, 140)} Resposta: ${clip(item.answer || "—", 140)}`,
    options: [
      {
        id: "confirm-proxy",
        label: "Está certo",
        consequence: "A resposta do procurador fica valendo.",
        tone: "primary",
        auditCls: "write-board",
        invoke: { kind: "resolve-proxy-audit", boardId: item.boardId, cardId: item.cardId, questionId: item.questionId, outcome: "confirmed" },
        done: "Confirmado — a resposta do procurador fica valendo.",
      },
      {
        id: "reopen-proxy",
        label: "Reabrir para mim",
        consequence: "A pergunta volta para você responder, com o que o procurador assumiu à vista.",
        tone: "neutral",
        auditCls: "write-board",
        invoke: { kind: "resolve-proxy-audit", boardId: item.boardId, cardId: item.cardId, questionId: item.questionId, outcome: "reopened" },
        done: "A pergunta voltou para você.",
      },
    ],
    ifIgnored: "A resposta fica valendo.",
    next: { who: "ninguem", label: "Nada espera por isto" },
    more: cardMore(item, null),
    details: [
      { label: "Premissas do procurador", value: item.assumptions },
      { label: "Confiança", value: `${Math.round(item.confidence * 100)}%` },
    ],
    dot: "grey",
  }),

  "delivery-audit": (item, c) => ({
    bucket: "acompanhar",
    askVerb: null,
    ask: `${c.title} foi ao ar sem você aprovar antes — revisar quando puder`,
    happened: item.before || item.after ? `Antes: ${clip(item.before ?? "—", 120)} Agora: ${clip(item.after ?? "—", 120)}` : "Mudou o que o usuário vê. A entrega não trouxe o antes e o depois; veja no ar ou abra o card.",
    options: [
      {
        id: "confirm-delivery",
        label: "Está certo",
        consequence: "A entrega fica como está.",
        tone: "primary",
        auditCls: "write-board",
        invoke: { kind: "resolve-delivery-audit", boardId: item.boardId, cardId: item.cardId, outcome: "confirmed" },
        done: "Confirmado — a entrega fica como está.",
      },
      {
        id: "reopen-delivery",
        label: "Reabrir com um motivo",
        consequence: "O card volta para ajuste com o seu motivo; o que está no ar fica até o ajuste sair.",
        tone: "neutral",
        requires: "note",
        auditCls: "write-board",
        invoke: { kind: "resolve-delivery-audit", boardId: item.boardId, cardId: item.cardId, outcome: "reopened" },
        done: "Reaberto — o card voltou para ajuste com o seu motivo.",
      },
    ],
    ifIgnored: "A entrega fica valendo.",
    next: { who: "ninguem", label: "Nada espera por isto" },
    more: [
      ...(item.link
        ? [{ id: "more:live", label: "Ver no ar", consequence: "Abre o produto no ar.", tone: "neutral" as const, auditCls: "read" as const, invoke: { kind: "link" as const, href: item.link }, done: "Aberto." }]
        : []),
      ...cardMore(item, null),
    ],
    details: [{ label: "Sorteada em", value: item.sampledAt }],
    dot: "grey",
  }),

  // O PEDIDO DE AUTORIZAÇÃO QUE O PLANO LISTOU SEM CARD (deploy-blocks.ts `openPlanOwnerRows`): o mesmo botão da
  // publicação parada, sobre a causa do livro — sem card âncora (ninguém tentou publicar; um board pausado nunca tenta).
  "publish-approval": (item, c) => {
    const classText = item.ownerClass ? `«${ownerClassLabel(item.ownerClass, c.config)}»` : "negócio";
    const files = [...new Set(item.approvals.flatMap((a) => a.files))];
    const units = [...new Set(item.approvals.flatMap((a) => a.units))];
    const where = units.length ? ` em ${units.join(", ")}` : "";
    const shown = files.slice(0, 8);
    const esteira: DecisionOption = {
      id: "more:open-esteira",
      label: "Abrir a Esteira",
      consequence: "Abre a Esteira do board, onde «Refazer os pedidos de publicação» pede a autorização com a mudança de agora. Não decide nada.",
      tone: "neutral",
      auditCls: "read",
      invoke: { kind: "link", href: `/board/${encodeURIComponent(item.boardId)}/entrega` },
      done: "Aberto.",
    };
    const details = [
      { label: "Pacote", value: item.pkg },
      ...(files.length ? [{ label: "Arquivos", value: `${shown.join(", ")}${files.length > shown.length ? ` … e mais ${files.length - shown.length}` : ""}` }] : []),
    ];
    if (item.rerequesting) {
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: "Refazendo o pedido de publicação…",
        happened: "O código guardado mudou desde o último pedido, e o sistema está medindo de novo a publicação do pacote para pedir a sua autorização com a mudança de agora. Nada foi publicado.",
        options: [],
        ifIgnored: "Quando a medição terminar, o pedido novo volta a Decidir (ou some, se nada mais precisar de você).",
        next: { who: "sistema", label: "refazendo o pedido…" },
        more: [],
        details,
        dot: "grey",
      };
    }
    if (!item.approvals.length) {
      return {
        bucket: "acompanhar",
        askVerb: null,
        ask: "O pedido de publicação envelheceu — refaça pela Esteira",
        happened: "O código guardado mudou na main desde o pedido de autorização, então ele já não vale. Nada foi publicado.",
        options: [],
        ifIgnored: "A publicação segue parada; nada vai ao ar.",
        next: { who: "voce", label: "Refazer pela Esteira" },
        more: [esteira],
        details,
        dot: "grey",
      };
    }
    return {
      askVerb: "Autorizar",
      ask: `Autorizar a publicação do código de ${classText}${where}?`,
      happened: `O plano de publicação do board pede o seu sim para ${plural(files.length, "arquivo", "arquivos")} de código de ${classText}${where}. Nenhuma tentativa de publicar o registrou num card (o board pode estar pausado). Nada foi publicado.`,
      options: [
        {
          id: "authorize-publish",
          label: "Autorizar publicar",
          consequence: "Grava a sua autorização para ESTA mudança. Se esse código mudar depois, a autorização deixa de valer e o Inbox pede de novo. Publicar continua sendo do board, no ritmo dele.",
          tone: "primary",
          confirm: {
            title: "Autorizar a publicação?",
            body: `Você autoriza publicar ${plural(files.length, "arquivo", "arquivos")} de código de ${classText}${where}. A autorização vale só para esta mudança.`,
          },
          auditCls: "deploy",
          invoke: { kind: "authorize-publish", boardId: item.boardId, causeKey: item.causeKey },
          done: "Autorização gravada. A próxima publicação do board já a encontra.",
        },
      ],
      ifIgnored: "A publicação segue parada; nada vai ao ar.",
      more: [esteira],
      details: [...details, { label: "O que você autoriza", value: `${plural(files.length, "arquivo", "arquivos")}${where}` }],
      dot: "red",
    };
  },

  "meter-stalled": (item) => ({
    bucket: "acompanhar",
    banner: true,
    askVerb: null,
    ask: `Automação parada: o medidor de uso não lê desde ${timeToken(new Date(item.stalledSince).toISOString())}`,
    happened: "Sem a leitura do uso da conta, nenhum agente começa trabalho novo.",
    options: [
      {
        id: "renew-meter",
        label: "Renovar a leitura agora",
        consequence: "Pede ao servidor uma leitura nova do uso; a automação volta quando ela chegar.",
        tone: "primary",
        auditCls: "read",
        invoke: { kind: "renew-meter" },
        done: "Pedido de leitura enviado.",
      },
    ],
    ifIgnored: "Nenhum agente começa trabalho novo até a leitura voltar.",
    next: { who: "ninguem", label: "A automação está retida" },
    more: [],
    details: [{ label: "Medido", value: item.detail }],
    dot: "red",
  }),

  "data-deletion": (item, c) => {
    const surfaces = item.scope.filter(isRemovalScope).map((s) => REMOVAL_SCOPE_BY_ID[s].name);
    const refusal = c.card ? dataDeletionRefusal(c.card) : null;
    return {
      askVerb: "Apagar",
      ask: `Apagar os dados de produção de ${c.title}?`,
      happened: `A descontinuação de ${c.title} pediu para apagar dados${surfaces.length ? ` (${surfaces.join(", ")})` : ""}. Motivo: ${clip(item.brief, 140)}`,
      options: [
        {
          id: "approve-deletion",
          label: "Apagar os dados (não tem volta)",
          consequence: "O agente de descontinuação apaga os dados; depois disso eles não voltam.",
          tone: "danger",
          confirm: {
            title: "Apagar os dados de produção? Não tem volta.",
            body: `Apaga os dados de ${c.title}${item.target ? ` (${item.target})` : ""}${surfaces.length ? `, em: ${surfaces.join(", ")}` : ""}. Motivo: ${clip(item.brief, 140)}. Depois disso os dados não voltam.`,
          },
          ...(refusal ? { disabled: { reason: refusal } } : {}),
          auditCls: "destructive",
          invoke: { kind: "approve-data-deletion", boardId: item.boardId, cardId: item.cardId },
          done: "Exclusão aprovada — o agente de descontinuação começou a apagar os dados.",
        },
      ],
      ifIgnored: "Nada é apagado; o card espera aqui.",
      more: cardMore(item, { templateId: "hitl-card-instructions", kind: "card", boardId: item.boardId, cardId: item.cardId }),
      details: [...(item.target ? [{ label: "Alvo", value: item.target }] : [])],
      dot: "red",
    };
  },

  "effect-failed": (item, c) => {
    const deploys = item.effect !== "promote-stage";
    const ref: EscalationRef = deploys
      ? { templateId: "deploy-failed", kind: "deploy", boardId: item.boardId, cardId: item.cardId }
      : { templateId: "hitl-card-instructions", kind: "card", boardId: item.boardId, cardId: item.cardId };
    return {
      askVerb: deploys ? "Publicar" : "Tentar",
      ask: deploys ? `Publicar ${c.title} de novo?` : `Tentar de novo a promoção de ${c.title}?`,
      happened: `A ação automática de «${item.stepName}» não rodou para ${c.title}.`,
      options: [
        retryEffectOption(item, c, item.effect, item.stepName, "Resolva o motivo antes (em Detalhes)."),
        { ...askJido(ref, "Pedir ao Jido para resolver o motivo", "O Jido lê o motivo e propõe o conserto."), id: "jido-fix" },
      ],
      ifIgnored: `O card fica parado em «${item.stepName}».`,
      more: cardMore(item, null),
      details: [
        { label: "O que houve", value: item.title },
        ...(item.detail ? [{ label: "Motivo", value: item.detail }] : []),
        ...(item.suggestion ? [{ label: "O que resolve", value: item.suggestion }] : []),
      ],
      dot: "red",
    };
  },

  stalled: (item, c) => {
    // O modelo de conversa neutro do card: o que houve está no próprio card (o achado do vigia) — nenhum modelo novo.
    const ref: EscalationRef = { templateId: "hitl-card-instructions", kind: "card", boardId: item.boardId, cardId: item.cardId };
    return {
      // SEMPRE Acompanhar, em todo modo: quem resolve é o card de conserto que o vigia abriu (trabalho do sistema), e
      // é em Acompanhar que a contagem «sem ninguém cuidando» lê `next.stalled`. As opções ficam à mão para quem
      // quiser agir antes — o que o Jido NÃO faz sozinho (demands.ts KIND_AUTONOMY: o vigia já tentou).
      bucket: "acompanhar",
      askVerb: null,
      ask: `${c.title} está travado em «${item.stepName}»`,
      // quem escreveu o que aconteceu foi o vigia, já em linguagem de dono: o item repete, não reescreve.
      happened: item.findingTitle,
      options: [
        ...(item.retryable && item.effect ? [retryEffectOption(item, c, item.effect, item.stepName, "O que o sistema já tentou está em Detalhes.")] : []),
        { ...askJido(ref, "Pedir ao Jido para olhar", "O Jido olha o que aconteceu e propõe o próximo passo."), id: "jido-look" },
      ],
      // nem todo card parado ganha conserto (o de condutor só é avisado): a frase não promete um.
      ifIgnored: `Nada mais move este card sozinho: ele fica em «${item.stepName}» até alguém agir. Se o sistema abriu um card de conserto, ele segue na fila.`,
      next: { who: "ninguem", label: "Ninguém está cuidando", stalled: true },
      more: cardMore(item, null),
      details: [
        ...(item.findingDetail ? [{ label: "Detalhe", value: item.findingDetail }] : []),
        ...(item.suggestion ? [{ label: "O que resolve", value: item.suggestion }] : []),
      ],
      dot: "red",
    };
  },

  "locked-exec": (item, c) => {
    const who = approvalRequesterText(item.proposedBy);
    // no meio da frase: «Rodar o comando que o condutor do card … pede» (nunca «que O condutor»)
    const whoMid = who.charAt(0).toLowerCase() + who.slice(1);
    // O BLOCO ESTRUTURADO vem antes das palavras do agente: o que roda (programa real + comando exato), como desfazer,
    // e cada conferência com o critério. O texto do agente entra por último, rotulado — ele não forja a tela.
    const checkLine = (v: (typeof item.verify)[number]) => `• ${v.label}: ${v.command} — ${v.criterion}`;
    const structured = [
      `Programa: ${item.program}`,
      `Comando: ${item.command}`,
      item.undoCommand ? `Para desfazer: ${item.undoCommand} (programa: ${item.undoProgram ?? "?"})` : `SEM DESFAZER — plano B: ${item.noUndoPlan ?? "—"}`,
      ...(item.preflight.length ? ["Antes de rodar, confere:", ...item.preflight.map(checkLine)] : []),
      "Depois de rodar, confere:",
      ...item.verify.map(checkLine),
      "Conferências: só comandos que o servidor liberou para conferir.",
    ].join("\n");
    const agentText = `Explicação do agente: ${item.summary}${item.why ? `\nPor que agora (agente): ${item.why}` : ""}`;
    const details = [
      { label: "Programa", value: item.program },
      { label: "Comando", value: item.command },
      item.undoCommand ? { label: "Desfazer", value: `${item.undoCommand} (programa: ${item.undoProgram ?? "?"})` } : { label: "Sem desfazer — plano B", value: item.noUndoPlan ?? "—" },
      ...item.preflight.map((v) => ({ label: `Confere antes: ${v.label}`, value: `${v.command} — ${v.criterion}` })),
      ...item.verify.map((v) => ({ label: `Confere depois: ${v.label}`, value: `${v.command} — ${v.criterion}` })),
      { label: "Explicação do agente", value: item.summary },
      ...(item.why ? [{ label: "Por que agora (agente)", value: item.why }] : []),
      { label: "Quem pediu", value: item.proposedBy },
      ...(item.lockRule ? [{ label: "Regra da trava", value: item.lockRule }] : []),
      { label: "Tempo máximo", value: `${item.timeoutSec} s` },
      ...item.steps.map((st) => ({
        label: `Passo ${st.step}`,
        value: `${st.ok ? "ok" : "falhou"}${st.exitCode !== null ? ` (saída ${st.exitCode})` : ""}${st.error ? ` — ${st.error}` : ""}${st.output ? `\n${st.output}` : ""}`,
      })),
      ...(item.error ? [{ label: "Motivo", value: item.error }] : []),
      { label: "Pedido", value: item.lockedExecId },
    ];
    const ack: DecisionOption = {
      id: "ack",
      label: "Ok, entendi",
      consequence: "Tira este aviso do Inbox. Não roda nada.",
      tone: "neutral",
      auditCls: "write-board",
      invoke: { kind: "ack-locked-exec", boardId: item.boardId, id: item.lockedExecId },
      done: "Aviso arquivado.",
    };
    switch (item.execStatus) {
      case "pending":
        return {
          askVerb: "Rodar",
          ask: clampAsk(`Rodar o comando que ${whoMid} pede em ${c.title}?`),
          // só palavras do sistema aqui: o que o agente escreveu entra DEPOIS do bloco do que roda, rotulado (story-ex9603)
          happened: `${capitalize(who)} pede para rodar ${item.program.split("/").pop() ?? item.program}, um comando que a trava do servidor proíbe a agentes. Abaixo, o que o servidor roda exatamente; a explicação do agente vem por último.`,
          options: [
            {
              id: "approve",
              label: item.undoCommand ? "Aprovar e rodar" : "Aprovar e rodar (sem desfazer)",
              consequence: item.undoCommand
                ? "O servidor roda este comando uma vez, nos próximos 15 minutos, confere e desfaz sozinho se a conferência falhar."
                : "O servidor roda este comando uma vez, nos próximos 15 minutos, e confere. Não há como desfazer: se der errado, vale o plano B.",
              tone: item.undoCommand ? "primary" : "danger",
              confirm: {
                title: item.undoCommand ? "Rodar este comando no servidor?" : "Rodar este comando no servidor? Não tem desfazer.",
                body: `${structured}\n\n${agentText}`,
              },
              auditCls: "destructive",
              invoke: { kind: "approve-locked-exec", boardId: item.boardId, id: item.lockedExecId, hash: item.hash },
              done: "Aprovado — o servidor está rodando o comando; o resultado aparece aqui.",
            },
            {
              id: "reject",
              label: "Não rodar",
              consequence: "Nada roda. O agente fica sabendo que você não aprovou.",
              tone: "neutral",
              auditCls: "write-board",
              invoke: { kind: "reject-locked-exec", boardId: item.boardId, id: item.lockedExecId },
              done: "Recusado — nada rodou.",
            },
          ],
          ifIgnored: "Nada roda. O pedido espera aqui; o agente segue no que não depende dele.",
          more: cardMore(item, null),
          details,
          dot: "red",
        };
      case "approved":
      case "running":
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: item.undoing ? `Desfazendo o comando aprovado em ${c.title}` : `Rodando o comando que você aprovou em ${c.title}`,
          happened: item.undoing ? "O servidor está rodando o comando de desfazer; o resultado aparece aqui." : "O servidor está rodando o comando que você aprovou e depois faz as conferências; o resultado aparece aqui.",
          options: [],
          ifIgnored: "O servidor termina sozinho; o resultado aparece aqui.",
          next: { who: "sistema", label: item.undoing ? "O servidor está desfazendo" : "O servidor está rodando" },
          more: cardMore(item, null),
          details,
          dot: "amber",
        };
      case "done":
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: `O comando que você aprovou em ${c.title} rodou e passou nas conferências`,
          happened: item.undoCommand
            ? "Rodou uma vez e passou em todas as conferências. Se mudar de ideia, «Desfazer» roda o comando de volta."
            : "Rodou uma vez e passou em todas as conferências. Este comando não tem desfazer.",
          options: [
            {
              id: "keep",
              label: "Manter",
              consequence: "Fica como está e o aviso sai do Inbox; o desfazer deixa de ser oferecido.",
              tone: "primary",
              auditCls: "write-board",
              invoke: { kind: "keep-locked-exec", boardId: item.boardId, id: item.lockedExecId },
              done: "Mantido.",
            },
            ...(item.undoCommand
              ? [
                  {
                    id: "undo",
                    label: "Desfazer",
                    consequence: "O servidor roda o comando de desfazer uma vez.",
                    tone: "danger" as const,
                    confirm: { title: "Desfazer o comando?", body: `O servidor roda:\nPrograma: ${item.undoProgram ?? "?"}\nComando: ${item.undoCommand}` },
                    auditCls: "destructive" as const,
                    invoke: { kind: "undo-locked-exec" as const, boardId: item.boardId, id: item.lockedExecId },
                    done: "Desfazendo — o resultado aparece aqui.",
                  },
                ]
              : []),
          ],
          ifIgnored: "Fica como está.",
          next: { who: "ninguem", label: "Pronto" },
          more: cardMore(item, null),
          details,
          dot: "green",
        };
      default: {
        const happenedByStatus: Record<string, string> = {
          failed: `O comando aprovado falhou: ${item.error ?? "sem detalhe"}`,
          undone: item.autoUndone ? `A conferência falhou e o comando foi desfeito sozinho. ${item.error ?? ""}`.trim() : "Você desfez o comando.",
          stale: `Não rodou: ${item.error ?? "a situação mudou desde o pedido"}`,
          expired: `Não rodou: ${item.error ?? "a autorização de 15 minutos passou"}`,
          rejected: `Você não aprovou${item.rejectReason ? `: ${item.rejectReason}` : ""}. Nada rodou.`,
        };
        const bad = item.execStatus !== "rejected" && !(item.execStatus === "undone" && !item.autoUndone);
        return {
          bucket: "acompanhar",
          askVerb: null,
          ask: clampAsk(
            item.execStatus === "rejected"
              ? `Comando recusado em ${c.title}`
              : item.execStatus === "undone"
                ? `Comando desfeito em ${c.title}`
                : `O comando aprovado em ${c.title} não ficou como devia`,
          ),
          happened: clip(happenedByStatus[item.execStatus] ?? item.error ?? "", 280),
          options: [ack],
          ifIgnored: "O aviso fica aqui até você dar «Ok».",
          next: { who: bad ? "voce" : "ninguem", label: bad ? "Confira o estado" : "Encerrado" },
          more: cardMore(item, null),
          details,
          dot: bad ? "red" : "grey",
        };
      }
    }
  },
};

// ── Ajudantes de texto por kind ──────────────────────────────────────────────────────────────────────

/** Por quanto tempo uma publicação sem confirmação fica em Acompanhar antes de subir para quem decide. */
export const DEPLOY_WATCH_MINUTES = 60;

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function blockerTemplateId(findingId: string, lens: string | undefined, cardStatus: string | null | undefined): EscalationRef["templateId"] {
  if (findingId.startsWith("merge-back-")) return "blocker-merge-back";
  if (findingId.startsWith("secret-scan-")) return "blocker-secret-scan";
  // `testing` é uma lente EMBUTIDA (types.ts `CoreLens`): o id é contrato do mecanismo, não vocabulário do alvo.
  if (lens === "testing" && cardStatus === "qa-automatizado") return "qa-red";
  return "blocker-generic";
}

/** O desfecho de uma execução que morreu, em português — sem o código de saída nem o sinal (ficam em Detalhes). */
function stuckHappened(item: Extract<CockpitItem, { kind: "stuck" }>): string {
  const outcome = item.reason ?? item.outcome;
  const infra = item.evidence?.failureClass === "infra" || /SIGTERM/i.test(item.evidence?.detail ?? "");
  switch (outcome) {
    case "exit":
      return infra
        ? "A execução do agente foi encerrada no meio — em geral, por um reinício do serviço."
        : "A execução do agente foi encerrada antes de terminar.";
    case "timeout":
      return "A execução do agente passou do tempo limite e foi interrompida.";
    case "oom-killed":
      return "A execução do agente foi derrubada por falta de memória na máquina.";
    case "error":
      return "A execução do agente não conseguiu rodar (um erro no ambiente).";
    case "no-op":
      return "O agente rodou e concluiu que não havia trabalho a fazer; o card não andou.";
    case "budget-cut":
      return "A execução foi cortada pelo limite de gasto antes de o card andar.";
    default:
      return "A execução do agente terminou sem o card andar.";
  }
}

/**
 * Quem pede uma aprovação, em minúsculas para caber na frase («um agente autônomo», «o condutor do card X»). O agente
 * que se nomeou (mcp/caller.ts) é dito pelo que ele é; o resto segue «um agente».
 */
function approvalWho(requestedBy: string | undefined): string {
  const named = callerWords(requestedBy);
  if (named) return `${named.charAt(0).toLowerCase()}${named.slice(1)}`;
  return requestedBy?.trim() === "run:orch" ? "um agente autônomo" : "um agente";
}

/** A ação pedida, dita em palavras a partir da ferramenta e dos argumentos. Ferramenta desconhecida: genérica. */
function approvalActionText(item: Extract<CockpitItem, { kind: "approval" }>, c: KindCtx): string {
  let args: Record<string, unknown> = {};
  try {
    args = item.args ? (JSON.parse(item.args) as Record<string, unknown>) : {};
  } catch {
    args = {};
  }
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : null);
  const cardTitle = item.cardId ? c.title : str("cardId") ? `«${str("cardId")}»` : "um card";
  switch (item.tool) {
    case "move_card": {
      const to = str("status") ?? str("to");
      return `mover ${cardTitle}${to ? ` para «${c.step(to)}»` : ""}`;
    }
    case "update_card":
      return `editar ${cardTitle}`;
    case "create_card":
      return `criar um card${str("title") ? ` («${clip(str("title"), 60)}»)` : ""}`;
    case "delete_card":
      return `apagar ${cardTitle}`;
    case "answer_question":
      return `responder uma pergunta em ${cardTitle}`;
    case "worktree_open":
      return "abrir uma cópia de trabalho do código";
    case "worktree_submit":
      return "mandar um trabalho para a integração";
    case "run_skill":
    case "enqueue_run":
      return `rodar um agente em ${cardTitle}`;
    default:
      return item.riskClass === "deploy" ? "publicar em produção" : item.riskClass === "destructive" ? "fazer uma ação que não tem volta" : "fazer uma ação no board";
  }
}

/** «2 seções», «1 mudança» — o tamanho da proposta de governança, na unidade de quem lê. */
function governanceSectionCount(item: Extract<CockpitItem, { kind: "governance" }>): string {
  const keys = new Set(item.changes.map((ch) => `${ch.artifact}:${ch.field ?? ""}`));
  const allPrd = item.changes.length > 0 && item.changes.every((ch) => ch.artifact === "prd");
  return allPrd ? plural(keys.size, "seção", "seções") : plural(item.changes.length || 1, "mudança", "mudanças");
}

/** O dia em que a proposta vence (criada + 14 dias), em ISO — ou null. */
function governanceExpiry(since: string | null | undefined): string | null {
  const t = since ? Date.parse(since.length === 10 ? `${since}T00:00:00Z` : since) : NaN;
  return Number.isFinite(t) ? new Date(t + GOVERNANCE_DRAFT_TTL_DAYS * 86_400_000).toISOString() : null;
}

// ── A régua comum ────────────────────────────────────────────────────────────────────────────────────

/** Um kind técnico que o Jido pega NESTE tier de um board humano (a demoção do ux-report §4.1). */
function jidoPicksUp(item: CockpitItem, c: KindCtx): boolean {
  if (c.businessOnly || c.tier === "chat" || item.copilotBackoff) return false;
  return isCopilotActionable(item, c.tier);
}

/**
 * A DECISÃO de um item — as cinco partes, a seção e quem age. PURA.
 *
 * A seção sai de quatro réguas, nesta ordem — o contrato (contract.ts) imposto num ponto só:
 *   1. as exceções do kind (a amostra, o aviso, a pergunta do procurador, a proposta sendo gerada, o medidor);
 *   2. quem decide (`whoDecides`, regra A): do sistema ⇒ Acompanhar, com quem tenta de novo; do dono ⇒ Decidir;
 *   3. o Jido que pega o item num board humano ⇒ Acompanhar até ele desistir (aí volta a Decidir) — regra C;
 *   4. a regra B: sem uma opção que MUDE o desfecho, não há o que decidir — Acompanhar, contado em «sem ninguém
 *      cuidando» (o dono vê que está parado; o Decidir não mente que há um botão para ele).
 * E a pergunta cabe numa linha (≤ {@link ASK_MAX}): o texto inteiro vai para Detalhes.
 */
export function decideItem(item: CockpitItem, ctx: DecisionCtx): ItemDecision {
  const verdict = cockpitItemDecision(item, ctx.card, ctx.config);
  const businessOnly = isBusinessOnly(ctx.card, ctx.config);
  const step = (id: string | null | undefined) => ctx.config.statuses.find((s) => s.id === id)?.name ?? id ?? "—";
  const title = quoted(item.cardTitle || (item.cardId ? item.cardId : "este item"));
  const c: KindCtx = { ...ctx, verdict, businessOnly, step, title };
  const draft = (DECIDE[item.kind] as (i: CockpitItem, k: KindCtx) => KindDraft)(item, c);

  let bucket: InboxBucket = draft.bucket ?? (verdict.decider === "owner" ? "decidir" : "acompanhar");
  let next: NextActor = draft.next ?? { who: "voce", label: "Espera você" };
  let ifIgnored = draft.ifIgnored;
  let askVerb = draft.askVerb;
  let ask = draft.ask;

  if (!draft.bucket && verdict.decider === "system") {
    const follow = systemFollowUp(item, c);
    next = follow.next;
    ifIgnored = draft.systemIgnored && follow.next.who === "sistema" ? draft.systemIgnored : follow.ifIgnored;
  } else if (bucket === "decidir" && jidoPicksUp(item, c)) {
    bucket = "acompanhar";
    next = { who: "jido", label: "O Jido está cuidando" };
    ifIgnored = "O Jido está cuidando. Se ele desistir, o item volta para você em Decidir.";
  }
  if (bucket === "decidir" && !hasOutcomeAction(draft.options)) {
    // Esta régua já contou «Pedir ao Jido» como ação: várias publicações «que só você publica» moravam em Decidir
    // com só «como publicar» e uma conversa. Sem o que mudar o desfecho, o item é trabalho parado — dito, não cobrado.
    bucket = "acompanhar";
    next = { who: "ninguem", label: "Ninguém resolve daqui", stalled: true };
  }
  if (bucket === "acompanhar" && draft.bucket !== "acompanhar" && askVerb) {
    // Em Acompanhar a frase é um fato, não uma pergunta: o sistema (ou o Jido) está cuidando.
    askVerb = null;
    ask = ask.replace(/\?$/, "");
  }
  if (isConducted(ctx.card) && next.who === "voce") next = { who: "condutor", label: "Um agente cuida deste card; a decisão é sua" };
  if (bucket === "decidir") next = next.who === "condutor" ? next : { who: "voce", label: "Espera você" };
  const line = clampAsk(ask);

  return {
    bucket,
    askVerb,
    ask: line,
    happened: draft.happened,
    options: draft.options,
    ifIgnored,
    more: draft.more ?? [],
    details: line === ask ? (draft.details ?? []) : [{ label: "Texto inteiro", value: ask }, ...(draft.details ?? [])],
    since: item.since ?? null,
    next,
    verdict,
    dot: draft.dot ?? (bucket === "decidir" ? "green" : "grey"),
    ...(draft.banner ? { banner: true } : {}),
    ...(bucket === "acompanhar" && draft.promotion ? { promotion: draft.promotion } : {}),
  };
}

/**
 * A REGRA DE PROMOÇÃO: um item de Acompanhar cujo prazo passou sobe para Decidir SÓ se a classe dele é do dono e ele
 * tem uma opção que muda o desfecho (a MESMA regra B do Decidir — a conversa com o Jido não sobe ninguém), com a
 * pergunta que o kind escreveu para esse momento. Do contrário ele fica em Acompanhar e diz o que acontece, contado
 * em «sem ninguém cuidando» — quem escala é o sistema, nunca o dono. PURA.
 */
export function promote(decision: ItemDecision, now: number): ItemDecision {
  const p = decision.promotion;
  if (decision.bucket !== "acompanhar" || !p) return decision;
  const at = Date.parse(p.at);
  if (!Number.isFinite(at) || now < at) return decision;
  const { promotion: _done, ...rest } = decision;
  if (decision.verdict.decider === "owner" && hasOutcomeAction(decision.options)) {
    return { ...rest, bucket: "decidir", askVerb: p.askVerb, ask: clampAsk(p.ask), next: { who: "voce", label: "Passou do prazo; espera você" } };
  }
  return { ...rest, ifIgnored: p.systemText, next: { who: "ninguem", label: "Passou do prazo", stalled: true } };
}

/**
 * A opção PRINCIPAL — a régua canônica (o botão cheio do Inbox, o botão do card no Kanban, o rótulo da pílula): entre
 * as que mudam o desfecho, a de tom principal; senão a de produção (publicar); senão a primeira que não é vermelha.
 * Nunca a conversa com o Jido, um link ou o status (o primário de Decidir era «Pedir ao Jido» em vários itens), e
 * nunca um DESCARTE por sobra — no conflito de integração a única que muda o desfecho é «Descartar este trabalho», e
 * ela não pode ser o botão cheio. Item sem nada que mude o desfecho (Acompanhar): a declarada principal, se houver.
 * PURA.
 */
export function primaryOption(decision: Pick<ItemDecision, "options">): DecisionOption | null {
  const enabled = decision.options.filter((o) => !o.disabled && o.invoke.kind !== "howto");
  const outcome = enabled.filter(changesOutcome);
  if (outcome.length === 0) return enabled.find((o) => o.tone === "primary") ?? null;
  return outcome.find((o) => o.tone === "primary") ?? outcome.find((o) => o.tone === "danger" && !isDiscard(o.invoke)) ?? outcome.find((o) => o.tone !== "danger") ?? null;
}

/** Re-exportado para quem monta o tipo de uma opção de um item publicado (deploy-unsettled). */
export type { DeployUnsettledCockpitItem };
