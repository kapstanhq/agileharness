import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, CardQuestion, DeployCause } from "../types";
import type { CockpitItem, CockpitItemKind } from "../demands";
import { RISK_CLASSES } from "../types";
import { acceptTriageRefusal, dataDeletionRefusal, moveRefusal, republishRefusal, runSkillRefusal } from "../preconditions";
import { cardCockpitItems, DEPLOY_FAILURE_FINDING_ID } from "../demands";
import { evaluateGate } from "../gates";
import type { OptionInvokeKind } from "./decision";
import { decideItem, DEPLOY_WATCH_MINUTES, leadsToPublish, primaryOption, promote, type ItemDecision } from "./decision";
import { bannedTermsIn, formatDecisionText, itemTermsIn, localTimeFormatter } from "./copy";
import { foldByCard, INBOX_PRECEDENCE, inboxSections, inboxSummary, itemEntries, summaryLine, type InboxEntry } from "./entries";
import { followUpInWindow, systemDecisionEntry } from "./system-entries";
import { emptyFacts, isDiscard, type InboxFacts } from "./contract";
import type { FollowUpItem } from "../system-decisions";
import { FIXTURES, HUMAN, HUMAN_JIDO, KINDS, MODES, NOW, ULTRA, ULTRA_JIDO, ctx, mkCard, st } from "./items.fixture";
import { findingFixRefusal } from "../finding-fix";

const decide = (kind: CockpitItemKind, config: BoardConfig = HUMAN) => decideItem(FIXTURES[kind].item, ctx(config, FIXTURES[kind].card));
const fmt = localTimeFormatter(NOW, "America/Sao_Paulo");

/** As partes 1–4 de um item, formatadas como a tela as mostra. */
function parts1to4(d: ItemDecision): string[] {
  return [d.ask, d.happened, ...d.options.flatMap((o) => [o.label, o.consequence, o.disabled?.reason ?? ""]), d.ifIgnored].map((t) => formatDecisionText(t, fmt));
}

describe("o modelo de item — exaustivo e bem formado", () => {
  it("todo kind do Inbox tem uma decisão, e a precedência da dobra lista cada kind uma vez", () => {
    expect([...INBOX_PRECEDENCE].sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      const d = decide(kind);
      expect(d.ask.trim().length, kind).toBeGreaterThan(0);
      expect(d.happened.trim().length, kind).toBeGreaterThan(0);
      expect(d.ifIgnored.trim().length, kind).toBeGreaterThan(0);
      for (const o of [...d.options, ...d.more]) {
        expect(o.consequence.trim().length, `${kind}/${o.id}`).toBeGreaterThan(0);
        expect(o.done.trim().length, `${kind}/${o.id}`).toBeGreaterThan(0);
        expect(RISK_CLASSES, `${kind}/${o.id}`).toContain(o.auditCls);
      }
    }
  });

  // REESCRITO de propósito (WP3): a régua antiga só tirava o passo a passo, e «Pedir ao Jido» (só abre uma conversa)
  // contava como ação — várias publicações moravam em Decidir sem nada que mudasse o desfecho.
  it.each(MODES)("Decidir ⇒ ao menos uma opção que MUDA o desfecho, e a principal nunca é conversa nem descarte (modo %s)", (_m, config) => {
    let decidir = 0;
    for (const kind of KINDS) {
      const d = decide(kind, config);
      if (d.bucket !== "decidir") continue;
      decidir++;
      expect(d.options.some((o) => !o.disabled && o.auditCls !== "read" && !["howto", "escalate", "link", "show-publish-status"].includes(o.invoke.kind)), kind).toBe(true);
      // sem principal é válido (o conflito: só o descarte muda o desfecho, e o descarte nunca é o botão cheio)
      const main = primaryOption(d);
      if (main) {
        expect(["escalate", "link", "show-publish-status", "howto"], kind).not.toContain(main.invoke.kind);
        expect(isDiscard(main.invoke), kind).toBe(false);
      }
    }
    expect(decidir).toBeGreaterThan(0);
  });

  it.each(MODES)("o verbo da pergunta é o de uma opção, e está na própria pergunta (modo %s)", (_m, config) => {
    for (const kind of KINDS) {
      const d = decide(kind, config);
      if (d.bucket !== "decidir") continue;
      expect(d.askVerb, kind).toBeTruthy();
      const verb = new RegExp(`\\b${d.askVerb}\\b`, "i");
      expect(d.options.some((o) => verb.test(o.label)), `${kind}: «${d.askVerb}» em nenhuma opção`).toBe(true);
      if (kind !== "question") expect(verb.test(d.ask), `${kind}: «${d.ask}»`).toBe(true);
    }
  });

  it.each(MODES)("nenhum termo do glossário nas partes 1–4 (modo %s)", (_m, config) => {
    for (const kind of KINDS) {
      for (const text of parts1to4(decide(kind, config))) {
        const hits = itemTermsIn(text);
        expect(hits.map((h) => `${h.id} → use «${h.use}»`), `${kind}: «${text}»`).toEqual([]);
      }
    }
  });

  it("no máximo uma opção principal por item", () => {
    for (const [, config] of MODES) {
      for (const kind of KINDS) expect(decide(kind, config).options.filter((o) => o.tone === "primary").length, kind).toBeLessThanOrEqual(1);
    }
  });

  it("efeito externo tem nome: toda opção que move para o passo que publica diz «Publicar», nunca «Aprovar & avançar»", () => {
    for (const kind of KINDS) {
      for (const o of decide(kind).options) {
        if (o.invoke.kind === "move-card" && o.invoke.status === "deploy") expect(o.label, kind).toMatch(/Publicar/);
        expect(o.label).not.toMatch(/Aprovar & avançar|Aprovar e avançar/);
      }
    }
  });
});

describe("quem decide — Decidir é só do dono; o técnico vai para Acompanhar", () => {
  it("modo humano: toda decisão real é do dono (Decidir), menos amostra, aviso, aviso do host e o card parado sem dono", () => {
    const acompanhar = KINDS.filter((k) => decide(k, HUMAN).bucket === "acompanhar").sort();
    expect(acompanhar).toEqual(["delivery-audit", "finding", "meter-stalled", "proxy-audit", "stalled"]);
  });

  it("só-negócio: PRD, dados de pessoas e a captura do dono ficam em Decidir; o técnico sai", () => {
    const decidir = KINDS.filter((k) => decide(k, ULTRA).bucket === "decidir").sort();
    // a pergunta do fixture não tem categoria: fica com o dono até ser classificada (fail-closed, questionVerdict)
    expect(decidir).toEqual(["data-deletion", "governance", "proposal", "question"]);
    const technical = decideItem({ ...FIXTURES.question.item, category: "technical" } as CockpitItem, ctx(ULTRA, FIXTURES.question.card));
    expect(technical.bucket).toBe("acompanhar");
  });

  it("só-negócio: a pergunta de dinheiro e o card que toca uma classe do dono voltam a Decidir", () => {
    const money = decideItem(FIXTURES.question.item, ctx(ULTRA, mkCard({ status: "desenvolver", questions: [{ id: "q1", text: "Contratar o plano pago?", category: "money", status: "open" } as CardQuestion] })));
    expect(money.bucket).toBe("decidir");
    const touched = decideItem(FIXTURES.review.item, ctx(ULTRA, mkCard({ status: "triage", needsHumanReview: true, businessClasses: { ids: ["money"], reason: "cobra do usuário" } } as Partial<Card>)));
    expect(touched.bucket).toBe("decidir");
    expect(touched.happened).toMatch(/Dinheiro e preço|decisão sua/);
  });

  it("só-negócio: o item técnico diz quem cuida — o Jido com limite quando ligado, «ninguém» quando desligado", () => {
    const withJido = decide("stuck", ULTRA_JIDO);
    expect(withJido.bucket).toBe("acompanhar");
    expect(withJido.next.who).toBe("jido");
    expect(withJido.ifIgnored).toMatch(/até 2 vezes/);
    const noJido = decide("stuck", ULTRA);
    expect(noJido.next.who).toBe("ninguem");
    expect(noJido.ifIgnored).toMatch(/Jido está desligado/);
    // em Acompanhar a frase é um fato, não uma pergunta sem dono
    expect(withJido.askVerb).toBeNull();
    expect(withJido.ask.endsWith("?")).toBe(false);
  });

  it("board humano com o Jido ligado: o item que ele pega vai para Acompanhar — e volta a Decidir quando ele desiste", () => {
    const picked = decide("stuck", HUMAN_JIDO);
    expect(picked.bucket).toBe("acompanhar");
    expect(picked.next.who).toBe("jido");
    const gaveUp = decideItem({ ...FIXTURES.stuck.item, copilotBackoff: { streak: 3 } } as CockpitItem, ctx(HUMAN_JIDO, FIXTURES.stuck.card));
    expect(gaveUp.bucket).toBe("decidir");
  });

  it("a amostra do dono (antes/depois + link) é «revisar quando puder», nunca Decidir", () => {
    for (const [, config] of MODES) {
      const d = decide("delivery-audit", config);
      expect(d.bucket).toBe("acompanhar");
      expect(d.ask).toMatch(/revisar quando puder/);
      expect(d.happened).toMatch(/Antes: sem convite/);
    }
  });

  it("a pergunta que o procurador está respondendo fica em Acompanhar, com «Responder antes» à mão", () => {
    const d = decideItem({ ...FIXTURES.question.item, awaitingProxy: true } as CockpitItem, ctx(ULTRA, FIXTURES.question.card));
    expect(d.bucket).toBe("acompanhar");
    expect(d.options[0].label).toBe("Responder antes do procurador");
    expect(d.options[0].requires).toBe("answer");
  });

  it("a proposta ainda sendo gerada é Acompanhar (com «Excluir» à mão); pronta, é Decidir", () => {
    const generating = decideItem({ ...FIXTURES.proposal.item, items: [] } as CockpitItem, ctx(HUMAN, FIXTURES.proposal.card));
    expect(generating.bucket).toBe("acompanhar");
    expect(generating.options.map((o) => o.id)).toEqual(["delete-proposal"]);
    expect(decide("proposal").bucket).toBe("decidir");
  });

  it("o aviso do host é uma faixa, uma vez, fora das seções", () => {
    const d = decide("meter-stalled");
    expect(d.banner).toBe(true);
    const entries = itemEntries([FIXTURES["meter-stalled"].item, { ...FIXTURES["meter-stalled"].item, boardId: "b2" } as CockpitItem], { boardId: "b1", boardName: "B", config: HUMAN, cardsById: new Map(), now: NOW });
    const s = inboxSections(entries);
    expect(s.banners).toHaveLength(1);
    expect(s.decidir.concat(s.acompanhar)).toHaveLength(0);
  });
});

describe("o card parado sem ninguém cuidando (`stalled`) — Acompanhar, contado, com as saídas à mão", () => {
  const stalledItem = FIXTURES.stalled.item;
  const noEffect = { ...stalledItem, status: "desenvolver", stepName: "Desenvolver", retryable: false, effect: undefined, findingTitle: "Parado em «Desenvolver» sem ninguém cuidando" } as CockpitItem;

  it("em todo modo: Acompanhar, sem pergunta, com «ninguém está cuidando» marcado para a contagem", () => {
    for (const [mode, config] of MODES) {
      const d = decide("stalled", config);
      expect(d.bucket, mode).toBe("acompanhar");
      expect(d.askVerb, mode).toBeNull();
      expect(d.ask.endsWith("?"), mode).toBe(false);
      expect(d.next, mode).toEqual({ who: "ninguem", label: "Ninguém está cuidando", stalled: true });
      expect(d.dot, mode).toBe("red");
    }
  });

  it("o que aconteceu é o título que o vigia escreveu; o detalhe dele mora em Detalhes", () => {
    const d = decide("stalled");
    expect(d.ask).toBe("«Lista de desejos compartilhada» está travado em «Publicar»");
    expect(d.happened).toBe("Parado em «Publicar» sem ninguém cuidando");
    expect(d.details).toEqual([{ label: "Detalhe", value: "Parado desde ontem. O sistema refez o passo uma vez e abriu o conserto story-fix1." }]);
    expect(d.ifIgnored).toMatch(/Nada mais move este card sozinho/);
    expect(d.ifIgnored).toMatch(/até alguém agir/);
  });

  it("passo com ação automática: «tentar de novo» é o MESMO do efeito que não rodou (no lugar, com confirmação) + o Jido", () => {
    const d = decide("stalled");
    expect(d.options.map((o) => o.id)).toEqual(["retry-effect", "jido-look"]);
    const retry = d.options[0];
    const twin = decide("effect-failed").options[0];
    expect(retry.invoke).toEqual({ kind: "republish", boardId: "b1", cardId: "c1" });
    expect(retry).toMatchObject({ label: twin.label, tone: twin.tone, auditCls: twin.auditCls, confirm: twin.confirm, done: twin.done });
    expect(retry.disabled).toBeUndefined();
    expect(d.options[1].invoke).toMatchObject({ kind: "escalate", ref: { templateId: "hitl-card-instructions", cardId: "c1" } });
  });

  it("promoção do código (sem publicar): «Tentar de novo» sem a confirmação de produção", () => {
    const d = decideItem({ ...stalledItem, status: "stage", stepName: "Homologar", effect: "promote-stage" } as CockpitItem, ctx(HUMAN, mkCard({ status: "stage" })));
    expect(d.options[0]).toMatchObject({ id: "retry-effect", label: "Tentar de novo", tone: "primary", auditCls: "merge-resolve" });
    expect(d.options[0].confirm).toBeUndefined();
  });

  it("«tentar de novo» fora de um passo com ação automática: bloqueado com a frase de republishRefusal", () => {
    const card = mkCard({ status: "release" });
    const d = decideItem(stalledItem, ctx(HUMAN, card));
    expect(d.options[0].disabled?.reason).toBe(republishRefusal(card, HUMAN));
  });

  it("card conduzido num passo sem ação automática: só o Jido — nada a refazer no lugar, e o condutor não é dito como quem cuida", () => {
    const card = mkCard({ status: "desenvolver", routing: { driver: "conductor" } } as Partial<Card>);
    for (const [mode, config] of MODES) {
      const d = decideItem(noEffect, ctx(config, card));
      expect(d.options.map((o) => o.invoke.kind), mode).toEqual(["escalate"]);
      expect(d.options[0].disabled, mode).toBeUndefined();
      expect(d.bucket, mode).toBe("acompanhar");
      expect(d.next, mode).toMatchObject({ who: "ninguem", stalled: true });
    }
  });

  it("entra na contagem «sem ninguém cuidando», e nunca vira «precisa de você»", () => {
    const entries = itemEntries([stalledItem], { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: new Map([["c1", FIXTURES.stalled.card]]), now: NOW });
    expect(inboxSummary(entries)).toEqual({ decidir: 0, acompanhar: 1, stalled: 1 });
    expect(summaryLine(inboxSummary(entries))).toBe("0 para decidir · 1 acompanhando · 1 sem ninguém cuidando");
  });

  it("nenhum termo interno nas partes 1–4, com e sem o que refazer, nos quatro modos", () => {
    for (const [mode, config] of MODES) {
      for (const [item, card] of [[stalledItem, FIXTURES.stalled.card], [stalledItem, mkCard({ status: "release" })], [noEffect, mkCard({ status: "desenvolver" })]] as Array<[CockpitItem, Card]>) {
        for (const text of parts1to4(decideItem(item, ctx(config, card)))) {
          expect(bannedTermsIn(text).map((h) => h.id), `${mode}: «${text}»`).toEqual([]);
        }
      }
    }
  });
});

describe("as opções — pré-validadas pela MESMA régua do servidor (preconditions.ts)", () => {
  it("aceitar a triagem: recusada com a frase do servidor e o que a libera (card sem lugar no mapa)", () => {
    const card = mkCard({ status: "triage", needsHumanReview: true, parent: null });
    const d = decideItem(FIXTURES.review.item, ctx(HUMAN, card));
    const accept = d.options.find((o) => o.id === "accept")!;
    expect(accept.disabled?.reason).toBe(acceptTriageRefusal(card, HUMAN));
    expect(accept.disabled?.unblock?.label).toMatch(/lugar no mapa/);
    // «Descartar» segue habilitado: o item tem o que decidir
    expect(d.bucket).toBe("decidir");
  });

  it("aceitar a triagem num card COM lugar: habilitado, com o destino e o «Desfazer» de volta à Triagem", () => {
    const d = decide("review");
    const accept = d.options.find((o) => o.id === "accept")!;
    expect(accept.disabled).toBeUndefined();
    expect(accept.label).toBe("Aceitar e mandar para «Entrevista»");
    expect(accept.undo).toEqual({ kind: "move-back", boardId: "b1", cardId: "c1", from: "interview", to: "triage", toStaging: true });
  });

  // REESCRITO de propósito (WP3): com o «Tentar de novo» recusado, sobrava só a conversa com o Jido — e o item ficava
  // em Decidir. Sem nada que mude o desfecho, ele é trabalho parado: Acompanhar, contado em «sem ninguém cuidando».
  it("tentar de novo num card conduzido: desabilitado com a frase de runCardSkillAction; sobra o Jido, e o item sai de Decidir", () => {
    const card = mkCard({ status: "enriquecer", routing: { driver: "conductor" } } as Partial<Card>);
    const d = decideItem(FIXTURES.stuck.item, ctx(HUMAN, card));
    expect(d.options.find((o) => o.id === "retry")!.disabled?.reason).toBe(runSkillRefusal(card, HUMAN));
    expect(d.options.some((o) => o.invoke.kind === "escalate" && !o.disabled)).toBe(true);
    expect(d.bucket).toBe("acompanhar");
    expect(d.next).toMatchObject({ who: "ninguem", stalled: true });
  });

  it("publicar de novo: desabilitado enquanto uma publicação do card está em voo; o gate do passo vem do moveRefusal", () => {
    const inFlight = mkCard({ status: "deploy", deployFiredAt: "2026-09-28T19:00:00Z" });
    const d = decideItem(FIXTURES["deploy-failed"].item, ctx(HUMAN, inFlight));
    expect(d.options[0].disabled?.reason).toMatch(/em andamento/);
    const gated: BoardConfig = { ...HUMAN, statuses: HUMAN.statuses.map((s) => (s.id === "deploy" ? { ...s, gate: "hasQaPassed" } : s)) } as BoardConfig;
    const card = mkCard({ status: "release" });
    const g = decideItem(FIXTURES["deploy-failed"].item, ctx(gated, card));
    expect(g.options[0].disabled?.reason).toBe(moveRefusal(card, "deploy", gated));
  });

  it("apagar dados: recusado com a frase de dataDeletionRefusal quando o card não está na descontinuação", () => {
    const card = mkCard({ status: "descontinuar" });
    const d = decideItem(FIXTURES["data-deletion"].item, ctx(HUMAN, card));
    expect(d.options[0].disabled?.reason).toBe(dataDeletionRefusal(card));
    // sem opção habilitada ⇒ não fica em Decidir
    expect(d.bucket).toBe("acompanhar");
  });

  it("re-rodar o efeito do passo fora do passo: recusado com a frase de republishRefusal", () => {
    const card = mkCard({ status: "release" });
    const d = decideItem(FIXTURES["effect-failed"].item, ctx(HUMAN, card));
    expect(d.options[0].disabled?.reason).toBe(republishRefusal(card, HUMAN));
  });

  it("o gate que publica chama o botão pelo efeito — «Publicar em produção» — e o Devolver diz o destino", () => {
    const d = decide("gate");
    expect(d.ask).toBe("Publicar «Lista de desejos compartilhada» em produção?");
    expect(d.options.map((o) => o.label)).toEqual(["Publicar em produção", "Devolver para «Homologar»"]);
    expect(d.options[0].tone).toBe("danger");
    expect(d.options[0].confirm).toBeDefined();
    // publicar não se desfaz; devolver sim
    expect(d.options[0].undo).toBeUndefined();
    expect(d.options[1].undo).toMatchObject({ kind: "move-back", from: "stage", to: "release" });
    expect(d.dot).toBe("red");
  });

  it("gate sem nada para a frente (o próximo passo não aceita o card) não é decisão sua: Acompanhar, com o porquê", () => {
    const gated: BoardConfig = { ...HUMAN, statuses: HUMAN.statuses.map((s) => (s.id === "deploy" ? { ...s, gate: "hasQaPassed" } : s)) } as BoardConfig;
    const d = decideItem(FIXTURES.gate.item, ctx(gated, mkCard({ status: "release" })));
    expect(d.bucket).toBe("acompanhar");
    expect(d.happened).toMatch(/«Publicar»\) ainda não aceita este card/);
    // o texto cru da condição (com os nomes internos) mora em Detalhes, não na parte 2
    expect(d.details.some((x) => x.label === "Falta para «Publicar»")).toBe(true);
  });

  it("o pedido de um agente sem os argumentos não se autoriza às cegas", () => {
    const d = decideItem({ ...FIXTURES.approval.item, args: undefined } as CockpitItem, ctx(HUMAN, undefined));
    expect(d.options.find((o) => o.id === "grant")!.disabled?.reason).toMatch(/às cegas/);
    expect(d.ask).toBe("Deixar um agente mover «Lista de desejos compartilhada»?");
  });

  it("o pedido de mover um card diz a ação em palavras, com o nome da etapa", () => {
    expect(decide("approval").ask).toBe("Deixar um agente mover «Lista de desejos compartilhada» para «Aprovar entrega»?");
  });

  it("ação que o celular não faz vira «No computador: como fazer» ou «Pedir ao Jido» (conflito de integração)", () => {
    const d = decide("conflict");
    expect(d.options.map((o) => o.label)).toEqual(["Pedir ao Jido para integrar", "No computador: como integrar à mão", "Descartar este trabalho"]);
    expect(d.options[1].invoke.kind).toBe("howto");
    expect(d.options.some((o) => /Marcar integrado/.test(o.label))).toBe(false);
  });

  // REESCRITO de propósito (WP3, INB-02): este teste fixava o defeito — o item em Decidir com só «como publicar» e «Pedir
  // ao Jido», nenhuma opção que mudasse o desfecho, e o texto «só você publica». Sem a causa registrada e sem o card que
  // a decide, nada daqui destrava: Acompanhar, contado em «sem ninguém cuidando», sem prometer um ator.
  it("a publicação que parou pedindo alguém, sem causa registrada nem card que a decida: Acompanhar, sem botão de mentira", () => {
    for (const [mode, config] of MODES) {
      const d = decideItem({ ...FIXTURES["deploy-failed"].item, needsHuman: true } as CockpitItem, ctx(config, FIXTURES["deploy-failed"].card));
      expect(d.bucket, mode).toBe("acompanhar");
      expect(d.options, mode).toEqual([]);
      expect(d.next, mode).toMatchObject({ who: "ninguem", stalled: true });
      expect(`${d.ask} ${d.happened} ${d.ifIgnored}`, mode).not.toMatch(/só você publica/);
    }
  });

  it("a prova que o sistema está produzindo é Acompanhar, sem botão do dono", () => {
    const d = decideItem({ ...FIXTURES["deploy-failed"].item, needsProof: true } as CockpitItem, ctx(HUMAN, FIXTURES["deploy-failed"].card));
    expect(d.bucket).toBe("acompanhar");
    expect(d.options).toEqual([]);
  });

  it("o item travado em português, sem o código de saída; no-op e corte de gasto não põem «Tentar de novo» como principal", () => {
    const d = decide("stuck");
    expect(d.happened).not.toMatch(/exit/);
    expect(primaryOption(d)?.id).toBe("retry");
    const noop = decideItem({ ...FIXTURES.stuck.item, outcome: "no-op", reason: "no-op" } as CockpitItem, ctx(HUMAN, FIXTURES.stuck.card));
    expect(noop.options.find((o) => o.id === "retry")!.tone).toBe("neutral");
    expect(noop.happened).toMatch(/não havia trabalho/);
  });

  it("a exclusão de dados aprova a EXCLUSÃO (nunca move o card)", () => {
    const d = decide("data-deletion");
    expect(d.options.map((o) => o.invoke.kind)).toEqual(["approve-data-deletion"]);
    expect(d.options[0].confirm?.title).toMatch(/Não tem volta/);
  });
});

describe("a regra de promoção — prazo passado sobe a Decidir só se a classe é do dono", () => {
  const running = { ...FIXTURES["deploy-unsettled"].item, held: undefined, lastDeploy: { target: "web", status: "running" } } as CockpitItem;
  const card = FIXTURES["deploy-unsettled"].card;
  const fired = Date.parse("2026-09-28T18:00:00Z");

  it("publicação ainda rodando: Acompanhar, com o prazo", () => {
    const d = decideItem(running, ctx(HUMAN, card, fired + 20 * 60_000));
    expect(d.bucket).toBe("acompanhar");
    expect(d.promotion?.at).toBe(new Date(fired + DEPLOY_WATCH_MINUTES * 60_000).toISOString());
    expect(promote(d, fired + 30 * 60_000)).toBe(d);
  });

  // REESCRITO de propósito (WP3): a promoção usava a régua velha e subia a Decidir um item cuja única opção era «Pedir ao
  // Jido para conferir». A regra B vale também para o prazo: sem opção que mude o desfecho, fica contado como parado.
  it("modo humano: passado o prazo, sem opção que mude o desfecho, fica em Acompanhar como parado (nunca sobe com uma conversa)", () => {
    const later = fired + (DEPLOY_WATCH_MINUTES + 1) * 60_000;
    const d = promote(decideItem(running, ctx(HUMAN, card, later)), later);
    expect(d.bucket).toBe("acompanhar");
    expect(d.next).toMatchObject({ who: "ninguem", stalled: true });
    expect(d.ifIgnored).toMatch(/Passou do prazo/);
  });

  it("modo humano: passado o prazo, COM uma opção que muda o desfecho, sobe para Decidir com a pergunta do prazo", () => {
    const later = fired + (DEPLOY_WATCH_MINUTES + 1) * 60_000;
    const base = decideItem(running, ctx(HUMAN, card, later));
    const withAction = { ...base, options: [...base.options, { id: "x", label: "Pedir a publicação de novo", consequence: "c", tone: "primary" as const, auditCls: "deploy" as const, invoke: { kind: "republish" as const, boardId: "b1", cardId: "c1" }, done: "d" }] };
    const d = promote(withAction, later);
    expect(d.bucket).toBe("decidir");
    expect(d.askVerb).toBe("Pedir");
  });

  it("só-negócio: passado o prazo, fica em Acompanhar e diz o que acontece — nunca sobe ao dono", () => {
    const later = fired + (DEPLOY_WATCH_MINUTES + 1) * 60_000;
    const d = promote(decideItem(running, ctx(ULTRA, card, later)), later);
    expect(d.bucket).toBe("acompanhar");
    expect(d.ifIgnored).toMatch(/Passou do prazo/);
  });
});

describe("a dobra por card — um item de Decidir por card, com as facetas dentro", () => {
  const cardsById = new Map([["c1", FIXTURES.gate.card]]);
  const mkEntries = (items: CockpitItem[]) => itemEntries(items, { boardId: "b1", boardName: "Board", config: HUMAN, cardsById, now: NOW });

  it("publicação falha > gate > aviso: fica a de maior precedência, o resto vira faceta", () => {
    const items = [FIXTURES.gate.item, FIXTURES["deploy-failed"].item, { ...FIXTURES.blocker.item, status: "release" } as CockpitItem];
    const folded = foldByCard(mkEntries(items));
    const decidir = folded.filter((e) => e.decision.bucket === "decidir");
    expect(decidir).toHaveLength(1);
    expect(decidir[0].kind).toBe("deploy-failed");
    expect(decidir[0].facets.map((f) => f.kind)).toEqual(["blocker", "gate"]);
  });

  // REESCRITO de propósito (WP3, INB-04): o pedido de um agente SOBRE um card ficava fora da dobra — um card tinha o
  // passo travado e o pedido de re-rodá-lo como duas entradas em Decidir. Agora o pedido com card é da causa do card;
  // sem card (e a proposta de PRD), segue a causa dele mesmo.
  it("itens de cards diferentes não se dobram; o pedido de agente sobre um card dobra nele; sem card, nunca", () => {
    const other = { ...FIXTURES.gate.item, id: "c2:approval:release", cardId: "c2" } as CockpitItem;
    const both = new Map([...cardsById, ["c2", { ...FIXTURES.gate.card, id: "c2" }]]);
    const loose = { ...FIXTURES.approval.item, id: "apr:a2", cardId: "" } as CockpitItem;
    const folded = foldByCard(itemEntries([FIXTURES.gate.item, other, FIXTURES.approval.item, loose, FIXTURES.governance.item], { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: both, now: NOW }));
    const decidir = folded.filter((e) => e.decision.bucket === "decidir");
    expect(decidir.map((e) => e.itemId).sort()).toEqual(["apr:a2", "c1:approval:release", "c2:approval:release", "gov:d1"]);
    expect(decidir.find((e) => e.cardId === "c1")!.facets.map((f) => f.kind)).toEqual(["approval"]);
  });

  it("para qualquer combinação de kinds de um card, sai no máximo um item de Decidir para ele", () => {
    const cardKinds: CockpitItemKind[] = ["deploy-failed", "effect-failed", "stalled", "conflict", "merge-failed", "stuck", "blocker", "question", "gate", "release-aging", "finding"];
    for (let mask = 1; mask < 1 << cardKinds.length; mask += 37) {
      const items = cardKinds.filter((_, i) => mask & (1 << i)).map((k) => ({ ...FIXTURES[k].item, cardId: "c1" }) as CockpitItem);
      const folded = foldByCard(mkEntries(items));
      expect(folded.filter((e) => e.decision.bucket === "decidir" && e.cardId === "c1").length).toBeLessThanOrEqual(1);
    }
  });
});

describe("parado há muito tempo", () => {
  it("passou de 30 dias: «parado», e «Arquivar os antigos» alcança a triagem de uma história", () => {
    const old = { ...FIXTURES.review.item, since: "2026-07-08T10:00:00Z" } as CockpitItem;
    const [e] = itemEntries([old], { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: new Map([["c1", FIXTURES.review.card]]), now: NOW });
    expect(e.stale).toEqual({ days: 82, archivable: true });
    // e o parado desce para o fim de Decidir: a decisão nova vem antes
    const fresh = itemEntries([FIXTURES.gate.item], { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: new Map([["c1", FIXTURES.gate.card]]), now: NOW });
    expect(inboxSections([e, ...fresh]).decidir.map((x) => x.kind)).toEqual(["gate", "review"]);
  });

  it("recente não é parado; proposta de PRD nunca é arquivável (ela vence sozinha)", () => {
    const [e] = itemEntries([FIXTURES.review.item], { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: new Map([["c1", FIXTURES.review.card]]), now: NOW });
    expect(e.stale).toBeUndefined();
    const [g] = itemEntries([{ ...FIXTURES.governance.item, since: "2026-07-01" } as CockpitItem], { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: new Map(), now: NOW });
    expect(g.stale?.archivable).toBe(false);
  });
});

describe("a triagem que voltou para o dono", () => {
  it("o `hold` do DONO (ele desfez um aceite) diz que voltou para ele — não que o juiz ficou em dúvida", () => {
    const mine = mkCard({ status: "triage", needsHumanReview: true, triageDecision: { verdict: "hold", reason: "você desfez o aceite no Inbox", by: "human", at: "2026-09-28" } });
    expect(decideItem(FIXTURES.review.item, ctx(HUMAN, mine)).happened).toMatch(/Voltou para você: você desfez o aceite no Inbox\./);
    const judge = mkCard({ status: "triage", needsHumanReview: true, triageDecision: { verdict: "hold", reason: "o PRD não fala disso", by: "triage-judge", at: "2026-09-28" } });
    expect(decideItem(FIXTURES.review.item, ctx(HUMAN, judge)).happened).toMatch(/O juiz da triagem não conseguiu decidir: o PRD não fala disso/);
  });
});

describe("as decisões do sistema em Acompanhar — o quê, quem, por quê e o «Desfazer»", () => {
  const sd = (over: Partial<FollowUpItem> = {}): FollowUpItem => ({
    v: 1,
    id: "sd-1",
    at: "2026-09-26T10:00:00Z",
    board: "b1",
    cardId: "c1",
    agent: "triage-judge",
    kind: "triage-accept",
    what: "Aceitou na triagem: «Convite»",
    why: "o PRD pede convites",
    undo: { kind: "return-to-triage", cardId: "c1", from: "interview" },
    undoable: true,
    ...over,
  });

  it("vira uma entrada de Acompanhar com o «Desfazer» do registro", () => {
    const e = systemDecisionEntry(sd(), { boardId: "b1", boardName: "Board", config: HUMAN, card: mkCard({ status: "interview" }) });
    expect(e.decision.bucket).toBe("acompanhar");
    expect(e.decision.happened).toBe("Juiz da triagem decidiu por você: o PRD pede convites");
    expect(e.decision.options.map((o) => o.invoke)).toEqual([{ kind: "undo-system-decision", boardId: "b1", decisionId: "sd-1" }]);
    for (const text of parts1to4(e.decision)) expect(bannedTermsIn(text)).toEqual([]);
  });

  it("reabrir uma entrega pede o motivo antes; sem handle, não há botão", () => {
    expect(systemDecisionEntry(sd({ undo: { kind: "reopen-card", cardId: "c1", deliveredIn: "concluida" } }), { boardId: "b1", boardName: "B", config: HUMAN, card: mkCard({ status: "concluida" }) }).decision.options[0].requires).toBe("note");
    expect(systemDecisionEntry(sd({ undo: undefined, undoable: false }), { boardId: "b1", boardName: "B", config: HUMAN }).decision.options).toEqual([]);
  });

  it("a janela: as de hoje são de «Resolvido hoje»; de 1 a 7 dias, Acompanhar; desfeitas saem", () => {
    const list = [sd({ id: "today", at: "2026-09-28T19:00:00Z" }), sd({ id: "d2", at: "2026-09-26T19:00:00Z" }), sd({ id: "old", at: "2026-09-10T19:00:00Z" }), sd({ id: "undone", at: "2026-09-26T09:00:00Z", undoneAt: "2026-09-27T09:00:00Z" })];
    expect(followUpInWindow(list, NOW).map((d) => d.id)).toEqual(["d2"]);
  });
});

describe("as seções", () => {
  it("Decidir em ordem de urgência; Acompanhar do mais novo para o mais velho", () => {
    const cardsById = new Map(Object.values(FIXTURES).map((f) => [f.card.id, f.card]));
    // (o aviso que não trava nada não é entrada: é dívida do card — contract.ts `isInboxItem`)
    const entries: InboxEntry[] = KINDS.flatMap((k) => itemEntries([FIXTURES[k].item], { boardId: "b1", boardName: "B", config: HUMAN, cardsById: new Map([["c1", FIXTURES[k].card]]), now: NOW }));
    void cardsById;
    const s = inboxSections(entries);
    const dots = s.decidir.map((e) => e.decision.dot);
    const rank = { red: 0, amber: 1, green: 2, grey: 3 };
    expect(dots.map((d) => rank[d])).toEqual([...dots.map((d) => rank[d])].sort((a, b) => a - b));
    const since = s.acompanhar.map((e) => e.decision.since ?? "");
    expect(since).toEqual([...since].sort().reverse());
  });
});

// ── Garantias herdadas do registry antigo (QUICK_ACTIONS_OF), agora sobre o modelo ──────────────────────────────

describe("B21 — um card nunca mostra ao mesmo tempo uma ação de publicar habilitada e outra desabilitada", () => {
  const cfg = { id: "b1", name: "B", statuses: [
    st("stage", "Integrar", { autorun: true, laneStep: true }),
    st("release", "Liberar", { autorun: false, laneStep: true }),
    st("deploy", "Publicar", { autorun: false, onEnter: "promote-and-deploy", laneStep: true }),
    st("concluida", "No ar", { terminal: true, gate: "hasDeployProof" }),
  ] } as BoardConfig;
  const failure = { id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", title: "Deploy falhou", status: "open" } as Card["findings"][number];
  const stale = "2026-09-20T10:00:00.000Z";
  const states: Array<[string, Partial<Card>]> = [
    ["Liberar, carimbo velho, publicação falha", { status: "release", deployFiredAt: stale, findings: [failure], reviewedAt: "2026-09-19" }],
    ["Liberar, carimbo velho, código parado", { status: "release", deployFiredAt: stale, stagedAt: "2026-09-10", reviewedAt: "2026-09-19" }],
    ["Integrar, carimbo velho, código parado", { status: "stage", deployFiredAt: stale, stagedAt: "2026-09-10" }],
    ["Publicar, disparo em voo", { status: "deploy", deployFiredAt: stale, findings: [failure] }],
  ];
  it.each(states)("%s", (_name, over) => {
    const card = mkCard({ ...over });
    const publishing = cardCockpitItems(card, cfg, "b1", { now: NOW })
      .flatMap((it) => decideItem(it, ctx(cfg, card)).options)
      .filter((o) => (o.invoke.kind === "move-card" && o.invoke.status === "deploy") || o.invoke.kind === "republish");
    const enabled = publishing.filter((o) => !o.disabled);
    const disabled = publishing.filter((o) => o.disabled);
    expect(enabled.length > 0 && disabled.length > 0, JSON.stringify(publishing.map((o) => [o.label, o.disabled?.reason ?? "ok"]))).toBe(false);
  });
});

describe("F6 — toda opção com pré-condição avaliável no cliente aparece BLOQUEADA com a frase do servidor", () => {
  type Case = { item: CockpitItem; config: BoardConfig; card: Card; server: () => string | null };
  const deployGated = { ...HUMAN, statuses: HUMAN.statuses.map((s) => (s.id === "deploy" ? { ...s, gate: "hasQaPassed" } : s)) } as BoardConfig;
  const refineCard = mkCard({ status: "triage", storyType: "technical", mode: "refine", needsHumanReview: true, parent: null } as Partial<Card>);
  const conducted = mkCard({ status: "enriquecer", routing: { driver: "conductor" } } as Partial<Card>);
  const staleRetire = mkCard({ status: "descontinuar", mode: "retire", retirement: null } as Partial<Card>);
  const releaseCard = mkCard({ status: "release" });
  // EXAUSTIVO por invoke (o Record obriga): um invoke novo não compila sem dizer se tem pré-condição de cliente.
  const CASES: Record<OptionInvokeKind, Case | { serverStateOnly: string }> = {
    "move-card": { item: FIXTURES["deploy-failed"].item, config: deployGated, card: releaseCard, server: () => moveRefusal(releaseCard, "deploy", deployGated) },
    "run-skill": { item: FIXTURES.stuck.item, config: HUMAN, card: conducted, server: () => runSkillRefusal(conducted, HUMAN) },
    republish: { item: FIXTURES["effect-failed"].item, config: HUMAN, card: releaseCard, server: () => republishRefusal(releaseCard, HUMAN) },
    "accept-triage": { item: FIXTURES.review.item, config: HUMAN, card: refineCard, server: () => acceptTriageRefusal(refineCard, HUMAN) },
    "approve-data-deletion": { item: FIXTURES["data-deletion"].item, config: HUMAN, card: staleRetire, server: () => dataDeletionRefusal(staleRetire) },
    "approve-governance": { serverStateOnly: "o conflito com o documento vem pronto do coletor (governance-check) no item — conferido em cockpit-collect-governance.test" },
    "update-finding": { serverStateOnly: "o aviso vem do próprio card do item — a única recusa é ele ter sumido do disco entre a leitura e o clique" },
    "force-release": { serverStateOnly: "depende da execução viva no registry do serviço" },
    "resolve-merge": { serverStateOnly: "depende da entrada viva na fila de integração" },
    "resolve-gate": { serverStateOnly: "depende da entrada viva na fila de integração" },
    "discard-branch": { serverStateOnly: "depende do ramo no git do serviço (o item só oferece a forma que a guarda aceita)" },
    "requeue-merge": { serverStateOnly: "depende da entrada e do ramo no serviço" },
    "delete-card": { serverStateOnly: "o card do item existe por construção; a lixeira é do serviço" },
    "answer-question": { serverStateOnly: "a única recusa é a resposta vazia — a opção espera o texto (requires: answer) antes de habilitar" },
    "reject-governance": { serverStateOnly: "recusa só a proposta que já foi decidida (estado do disco)" },
    "grant-request": { serverStateOnly: "o pedido vencido sai do Inbox no coletor; sem os argumentos, a opção vem bloqueada (às cegas)" },
    "deny-request": { serverStateOnly: "recusa só o pedido já decidido ou vencido (estado do disco)" },
    "resolve-proxy-audit": { serverStateOnly: "recusa só a amostra já resolvida (estado do disco)" },
    "resolve-delivery-audit": { serverStateOnly: "reabrir exige o motivo — a opção espera o texto (requires: note)" },
    "accept-proposal": { serverStateOnly: "recusa a seleção vazia — a opção espera a seleção (requires: selection)" },
    "refine-proposal": { serverStateOnly: "recusa o comentário vazio — a opção espera o texto (requires: note)" },
    "request-redesign": { serverStateOnly: "sem pedido de mudança aberto a opção vem bloqueada, com o que a libera" },
    "renew-meter": { serverStateOnly: "o desfecho do governador volta como recibo (renovado) ou recusa (segue parado)" },
    "undo-system-decision": { serverStateOnly: "a pré-condição de cada desfazer lê o card FRESCO sob o lock (system-decisions undoRefusal)" },
    "show-publish-status": { serverStateOnly: "só leitura — não muda nada" },
    "fix-finding": { serverStateOnly: "o item do aviso só existe enquanto o aviso está aberto; a recusa por aviso já tratado é coberta no teste do item do dono" },
    "authorize-publish": { serverStateOnly: "o pedido de autorização mora no livro de causas do servidor; a opção só existe enquanto o plano o pede" },
    howto: { serverStateOnly: "passo a passo na tela — não chama ação de servidor" },
    link: { serverStateOnly: "navegação — não chama ação de servidor" },
    escalate: { serverStateOnly: "navegação — abre o Jido, não chama ação de servidor" },
  };
  it.each(Object.entries(CASES))("%s", (kind, c) => {
    if ("serverStateOnly" in c) {
      expect(c.serverStateOnly.length).toBeGreaterThan(10);
      return;
    }
    const refusal = c.server();
    expect(refusal, `a pré-condição do servidor tem de FALHAR no fixture de ${kind}`).toBeTruthy();
    const option = decideItem(c.item, ctx(c.config, c.card)).options.find((o) => o.invoke.kind === kind);
    expect(option, `o item oferece a ação ${kind}`).toBeTruthy();
    expect(option!.disabled?.reason).toContain(refusal!);
  });

  it("«Aceitar → Refinar» sem o brief: bloqueado com a mensagem E o conserto do gate, e o que libera leva ao card", () => {
    const d = decideItem(FIXTURES.review.item, ctx(HUMAN, refineCard));
    const accept = d.options.find((o) => o.invoke.kind === "accept-triage")!;
    const verdict = evaluateGate(refineCard, "refinar", HUMAN)!;
    expect(accept.disabled?.reason).toContain(verdict.message);
    if (verdict.fix) expect(accept.disabled?.reason).toContain(verdict.fix);
    expect(accept.disabled?.unblock?.href).toMatch(/view=campos/);
  });
});

describe("a «Área» do problema: o nome que o alvo declarou para a lente, ou o id dela", () => {
  const areaOf = (d: ItemDecision) => d.details.find((x) => x.label === "Área")?.value;
  const withLens = { ...FIXTURES.blocker.item, lens: "freios" } as CockpitItem;

  it("sem mapa de nomes (ou lente fora do mapa) o detalhe mostra o id, como sempre — uma lente removida do settings nunca some", () => {
    expect(areaOf(decideItem(withLens, ctx(HUMAN, FIXTURES.blocker.card)))).toBe("freios");
    expect(areaOf(decideItem(withLens, { ...ctx(HUMAN, FIXTURES.blocker.card), lensNames: { cambio: "Câmbio" } }))).toBe("freios");
  });

  it("com o nome declarado pelo alvo, mostra o nome humano", () => {
    expect(areaOf(decideItem(withLens, { ...ctx(HUMAN, FIXTURES.blocker.card), lensNames: { freios: "Freios e pinças" } }))).toBe("Freios e pinças");
  });

  it("`testing` é lente embutida: o gabarito qa-red não depende de declaração do alvo", () => {
    const qaRed = decideItem({ ...FIXTURES.blocker.item, lens: "testing" } as CockpitItem, ctx(HUMAN, mkCard({ status: "qa-automatizado" })));
    expect([...qaRed.options, ...qaRed.more].map((o) => (o.invoke.kind === "escalate" ? o.invoke.ref.templateId : null))).toContain("qa-red");
  });
});

describe("B12 — o «Pedir ao Jido» leva o modelo de conversa específico do item, com um rótulo só", () => {
  const templateOf = (d: ItemDecision) => [...d.options, ...d.more].map((o) => (o.invoke.kind === "escalate" ? o.invoke.ref.templateId : null)).filter(Boolean);
  it("os kinds que caíam no genérico ganham o modelo próprio", () => {
    expect(templateOf(decideItem({ ...FIXTURES.blocker.item, findingId: "merge-back-x" } as CockpitItem, ctx(HUMAN, FIXTURES.blocker.card)))).toContain("blocker-merge-back");
    expect(templateOf(decide("gate"))).toContain("gate-manual-approve");
    expect(templateOf(decide("review"))).toContain("review-triage");
    expect(templateOf(decide("proposal"))).toContain("proposal-capture");
    expect(templateOf(decide("design"))).toContain("design-wireframe");
  });
  it("em «Mais», o rótulo é sempre «Pedir ao Jido»", () => {
    for (const kind of KINDS) for (const o of decide(kind).more) if (o.invoke.kind === "escalate") expect(o.label, kind).toBe("Pedir ao Jido");
  });
});

describe("risco 7 e B1 — o que nunca pode aparecer", () => {
  it("a publicação que falhou nunca oferece «marcar resolvido» (apagaria o alarme sem publicar)", () => {
    for (const [, config] of MODES) {
      for (const over of [{}, { needsHuman: true }, { needsProof: true }]) {
        const d = decideItem({ ...FIXTURES["deploy-failed"].item, ...over } as CockpitItem, ctx(config, FIXTURES["deploy-failed"].card));
        expect([...d.options, ...d.more].some((o) => o.invoke.kind === "update-finding")).toBe(false);
      }
    }
  });
  it("a exclusão de dados confirma nomeando O QUE é apagado, o alvo e que não tem volta", () => {
    const d = decideItem({ ...FIXTURES["data-deletion"].item, target: "/perfil/salvos", scope: ["dados"] } as CockpitItem, ctx(HUMAN, FIXTURES["data-deletion"].card));
    const o = d.options[0];
    expect(o).toMatchObject({ tone: "danger", auditCls: "destructive" });
    expect(o.confirm?.body).toContain("Lista de desejos compartilhada");
    expect(o.confirm?.body).toContain("/perfil/salvos");
    expect(`${o.confirm?.title} ${o.confirm?.body}`).toMatch(/Não tem volta|não voltam/);
  });
});

// ── WP3: o «Tentar de novo» que não muda nada, a causa da publicação e o glossário ─────────────────────────────────

describe("o «Tentar de novo» que não muda o desfecho é bloqueado com o porquê — e o item sai de Decidir", () => {
  const noop = { ...FIXTURES.stuck.item, outcome: "no-op", reason: "no-op", since: "2026-09-28T19:36:00Z" } as CockpitItem;

  it("o dono já mandou tentar de novo neste passo e o agente terminou sem trabalho de novo", () => {
    for (const [mode, config] of MODES) {
      const facts = {
        ...emptyFacts([FIXTURES.stuck.card]),
        stepEnteredAt: new Map([["c1", "2026-09-28T01:00:00Z"]]),
        actions: [
          { at: "2026-09-28T01:48:00Z", tool: "runCardSkillAction", actor: "human:inbox", note: "card=c1 · stuck:retry" },
          { at: "2026-09-28T19:34:00Z", tool: "runCardSkillAction", actor: "human:inbox", note: "card=c1 · stuck:retry" },
        ],
      };
      const d = decideItem(noop, { ...ctx(config, FIXTURES.stuck.card), facts });
      const retry = d.options.find((o) => o.id === "retry")!;
      expect(retry.disabled?.reason, mode).toMatch(/Já foi tentado de novo neste passo \(2 vezes\)/);
      expect(d.bucket, mode).toBe("acompanhar");
      expect(d.next.stalled, mode).toBe(true);
    }
  });

  it("um retry de OUTRO passo (antes de o card entrar neste) não conta; sem retry, o primeiro segue oferecido", () => {
    const facts = { ...emptyFacts([FIXTURES.stuck.card]), stepEnteredAt: new Map([["c1", "2026-09-28T12:00:00Z"]]), actions: [{ at: "2026-09-28T01:48:00Z", tool: "runCardSkillAction", actor: "human:inbox", note: "card=c1 · stuck:retry" }] };
    const d = decideItem(noop, { ...ctx(HUMAN, FIXTURES.stuck.card), facts });
    expect(d.options.find((o) => o.id === "retry")!.disabled).toBeUndefined();
    expect(d.bucket).toBe("decidir");
  });

  it("a falha da FERRAMENTA (a assinatura conhecida): bloqueado com o motivo, em qualquer modo", () => {
    const tool = { ...FIXTURES.stuck.item, outcome: "error", reason: "error", evidence: { findingId: "run-death", title: "run morreu: error", detail: "sandbox: bwrap: setting up uid map: Permission denied", failureClass: "infra" } } as CockpitItem;
    const d = decideItem(tool, ctx(HUMAN, FIXTURES.stuck.card));
    if (d.verdict.decider === "system" && /ferramenta/.test(d.verdict.reason)) {
      expect(d.options.find((o) => o.id === "retry")!.disabled?.reason).toMatch(/Falha da ferramenta/);
      expect(d.bucket).toBe("acompanhar");
    }
  });
});

describe("a publicação parada, pela CAUSA", () => {
  const cause = (over: Partial<DeployCause> = {}): DeployCause => ({ pkg: "app", phase: "freshness", units: [], rules: [], ownerClass: null, decider: "system", causeKey: "app:freshness", ...over });
  const card = mkCard({ status: "release" });
  const item = FIXTURES["deploy-failed"].item;
  const withCause = (c: DeployCause, extra: Partial<InboxFacts> = {}) => ({ ...emptyFacts([card]), deployCauseOf: new Map([["c1", c], ["c2", c]]), ...extra });

  it("a mesma causa em vários cards: o item fala da causa e de quantos cards ela afeta", () => {
    const d = decideItem(item, { ...ctx(HUMAN, card), facts: withCause(cause()) });
    expect(d.ask).toBe("Publicar de novo? O código no servidor está diferente do que foi aprovado — afeta 2 cards");
    expect(d.bucket).toBe("decidir");
  });

  it("o sistema já agendou a nova tentativa: Acompanhar, o sistema cuida, e «Publicar de novo» não é o principal", () => {
    const d = decideItem(item, { ...ctx(HUMAN, card), facts: withCause(cause(), { publishRetryAt: new Map([["c1", NOW + 3_600_000]]) }) });
    expect(d.bucket).toBe("acompanhar");
    expect(d.next).toEqual({ who: "sistema", label: "O sistema tenta de novo" });
    expect(d.options.find((o) => o.id === "republish")!.tone).toBe("neutral");
    expect(d.ifIgnored).toMatch(/O sistema tenta publicar de novo/);
  });

  it("«Publicar de novo» não é vermelho (o vermelho é do que descarta ou não tem volta)", () => {
    for (const kind of ["deploy-failed", "effect-failed", "deploy-unsettled", "stalled"] as CockpitItemKind[]) {
      for (const o of decide(kind).options) if (/Publicar de novo/.test(o.label)) expect(o.tone, `${kind}/${o.id}`).not.toBe("danger");
    }
  });

  it("a causa do SISTEMA que pediu alguém (lacuna de configuração): Acompanhar, o sistema cuida, nunca «só você publica»", () => {
    const sys = cause({ phase: "needs-human", decider: "system", causeKey: "app:system", units: ["job"], rules: ["unit-operator-only"] });
    const d = decideItem({ ...item, needsHuman: true } as CockpitItem, { ...ctx(ULTRA, mkCard({ status: "release", findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "x", deployPhase: "needs-human", deployCause: sys } as Card["findings"][number]] })), facts: withCause(sys) });
    expect(d.bucket).toBe("acompanhar");
    expect(d.next.who).toBe("sistema");
    expect(d.ask).toBe("A publicação parou porque falta configurar uma parte da publicação — afeta 2 cards");
    expect(d.details.find((x) => x.label === "Partes paradas")?.value).toBe("job");
  });
});

describe("o aviso da revisão num card do DONO: corrigir ou aceitar o risco — nunca «registrar como conhecido»", () => {
  const open = { id: "f2", lens: "general", severity: "medium", status: "open", title: "Avaliações de pedidos cancelados seguem aparecendo na vitrine", suggestion: "Esconder as avaliações dos pedidos cancelados numa passada única." } as Card["findings"][number];
  const owned = (finding = open) => mkCard({ businessClasses: { ids: ["personal-data"], reason: "mexe no que cada cliente vê dos outros" } as Card["businessClasses"], findings: [finding] });
  const item = { ...FIXTURES.finding.item, title: open.title, suggestion: open.suggestion, findingSeverity: "medium" } as CockpitItem;

  it("a pergunta é a decisão de verdade, e a ação principal é a que resolve o problema", () => {
    const d = decideItem(item, ctx(ULTRA, owned()));
    expect(d.verdict).toMatchObject({ decider: "owner", ownerClass: "personal-data" });
    expect(d.bucket).toBe("decidir");
    expect(d.ask).toBe("Corrigir o que a revisão achou em «Lista de desejos compartilhada», ou aceitar o risco?");
    expect(d.options.map((o) => [o.id, o.label, o.tone])).toEqual([
      ["finding:fix", "Mandar corrigir", "primary"],
      ["finding:acknowledged", "Aceitar o risco", "neutral"],
    ]);
    expect(d.options[0].invoke).toEqual({ kind: "fix-finding", boardId: item.boardId, cardId: item.cardId, findingId: "f2" });
    expect(d.options[1].invoke).toMatchObject({ kind: "update-finding", status: "acknowledged" });
    expect(d.options[1].confirm?.title).toBe("Aceitar o risco?");
  });

  it("não pede ao dono um fato técnico nem um arquivamento: sem «Já foi resolvido», sem «Registrar como conhecido»", () => {
    const d = decideItem(item, ctx(ULTRA, owned()));
    const text = JSON.stringify([d.ask, d.happened, d.options.map((o) => [o.label, o.consequence])]);
    expect(text).not.toMatch(/Já foi resolvido|Registrar como conhecido|Não corrigir/);
    expect(d.details).toEqual([
      { label: "O que a revisão achou", value: open.title },
      { label: "Importância", value: "média" },
      { label: "O que a revisão sugere", value: open.suggestion },
    ]);
  });

  it("aviso que já foi tratado: «Mandar corrigir» aparece bloqueado com a frase do servidor (um clique, um card)", () => {
    const treated = owned({ ...open, status: "acknowledged" } as Card["findings"][number]);
    const fix = decideItem(item, ctx(ULTRA, treated)).options.find((o) => o.id === "finding:fix")!;
    expect(fix.disabled?.reason).toBe(findingFixRefusal(treated, "f2"));
    expect(fix.disabled?.reason).toBe("Este aviso já foi tratado.");
  });

  it("fora de um card do dono o aviso segue dívida do card: Acompanhar, sem «Mandar corrigir»", () => {
    const d = decideItem(item, ctx(ULTRA, mkCard({ findings: [open] })));
    expect(d.bucket).toBe("acompanhar");
    expect(d.options.some((o) => o.invoke.kind === "fix-finding")).toBe(false);
  });
});

describe("a publicação parada por código do DONO: «Autorizar publicar» quando o plano traz o pedido", () => {
  const own: DeployCause = { pkg: "app", phase: "needs-human", units: ["api"], rules: ["checkout"], ownerClass: "money", decider: "owner", causeKey: "app:owner:money" };
  const held = mkCard({ status: "release", findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "x", deployPhase: "needs-human", deployCause: own } as Card["findings"][number]] });
  const item = { ...FIXTURES["deploy-failed"].item, needsHuman: true } as CockpitItem;
  const request = (c: string, files: string[], units: string[]) => ({ subject: { kind: "diff" as const, hash: `sha256:${c.repeat(64)}`, base: "abc1234", head: "f".repeat(40), files }, record: "node record.js <approval.json>", units, rules: ["checkout"] });
  const facts = (extra: Partial<InboxFacts> = {}): InboxFacts => ({ ...emptyFacts([held]), deployCauseOf: new Map([["c1", own], ["c2", own]]), ...extra });

  it("com o pedido no livro: o item vai a Decidir e a ação principal é autorizar — pela CAUSA, não pelo card", () => {
    const approvals = new Map([[own.causeKey, [request("a", ["pay/a.ts", "pay/b.ts"], ["api"]), request("b", ["fn/c.ts"], ["functions"])]]]);
    const d = decideItem(item, { ...ctx(ULTRA, held), facts: facts({ deployApprovals: approvals }) });
    expect(d.bucket).toBe("decidir");
    expect(d.options).toHaveLength(1);
    expect(d.options[0]).toMatchObject({ id: "authorize-publish", label: "Autorizar publicar", tone: "primary", auditCls: "deploy", invoke: { kind: "authorize-publish", boardId: item.boardId, causeKey: own.causeKey } });
    expect(d.options[0].confirm?.body).toMatch(/3 arquivos/);
    expect(d.ask).toMatch(/^Autorizar a publicação do código de «.+»/);
    expect(d.ask).toMatch(/afeta 2 cards$/);
    expect(d.details.find((x) => x.label === "O que você autoriza")?.value).toBe("3 arquivos em api, functions");
    expect(d.details.find((x) => x.label === "Arquivos")?.value).toBe("pay/a.ts, pay/b.ts, fn/c.ts");
  });

  it("muitos arquivos: a lista mostra os primeiros e diz quantos faltam", () => {
    const many = Array.from({ length: 11 }, (_, i) => `pay/f${i}.ts`);
    const d = decideItem(item, { ...ctx(ULTRA, held), facts: facts({ deployApprovals: new Map([[own.causeKey, [request("a", many, ["api"])]]]) }) });
    expect(d.details.find((x) => x.label === "Arquivos")?.value).toMatch(/pay\/f7\.ts … e mais 3$/);
  });

  it("sem pedido no livro (o alvo não o emite, ou o dono já autorizou): não há botão de autorizar", () => {
    const d = decideItem(item, { ...ctx(ULTRA, held), facts: facts() });
    expect(d.options.some((o) => o.invoke.kind === "authorize-publish")).toBe(false);
  });
});

describe("o glossário: «Aprovar e publicar» quando o resto anda sozinho até o ar", () => {
  const AUTO: BoardConfig = { ...HUMAN, statuses: HUMAN.statuses.map((s) => (s.id === "release" ? { ...s, autorun: true } : s)) } as BoardConfig;
  const atReview = mkCard({ status: "revisao", reviewedAt: "2026-09-27", qaPassed: true } as Partial<Card>);
  const gate = { ...FIXTURES.gate.item, id: "c1:approval:revisao", status: "revisao" } as CockpitItem;

  it("Integrar → Homologar → Liberar → Publicar sem parar: aprovar a entrega É publicar", () => {
    expect(leadsToPublish(AUTO, "merge")).toBe(true);
    const d = decideItem(gate, ctx(AUTO, atReview));
    expect(d.ask).toBe("Aprovar e publicar «Lista de desejos compartilhada»?");
    expect(d.options[0]).toMatchObject({ label: "Aprovar e publicar", invoke: { kind: "move-card", status: "merge" } });
  });

  it("com «Liberar» manual no meio, não é: o botão diz para onde o card vai", () => {
    expect(leadsToPublish(HUMAN, "merge")).toBe(false);
    expect(decideItem(gate, ctx(HUMAN, atReview)).options[0].label).toBe("Mandar para «Integrar»");
  });
});

// «Descartar» num card de que outros dependem. Antes o clique voltava com «reancore-os primeiro»; agora a
// opção DIZ o que vai junto antes do clique, leva tudo para a lixeira e o desfazer restaura todos.
describe("triagem — descartar um card com o que depende dele", () => {
  const { item, card } = FIXTURES.review;
  const discardOf = (others: Card[]) => {
    const d = decideItem(item, { ...ctx(HUMAN, card), facts: emptyFacts([card, ...others]) });
    const option = d.options.find((o) => o.id === "discard");
    if (!option) throw new Error("a triagem não ofereceu «Descartar»");
    return option;
  };

  it("sem dependentes: o descarte de um card só, como sempre", () => {
    const o = discardOf([]);
    expect(o).toMatchObject({ label: "Descartar", invoke: { kind: "delete-card", boardId: item.boardId, cardId: item.cardId }, undo: { kind: "restore-card" } });
    expect((o.invoke as { withDependents?: boolean }).withDependents).toBeUndefined();
    expect((o.undo as { group?: boolean }).group).toBeUndefined();
    expect(o.disabled).toBeUndefined();
  });

  it("com dependentes: a opção diz QUANTOS e QUAIS vão junto, antes do clique; o desfazer restaura todos", () => {
    const o = discardOf([mkCard({ id: "d1", title: "Agendador de posts", serves: card.id, status: "enriquecer" }), mkCard({ id: "d2", title: "Tela do agendador", parent: "d1", status: "enriquecer" })]);
    expect(o.label).toBe("Descartar com os 2 cards que dependem dele");
    expect(o.consequence).toContain("«Agendador de posts», «Tela do agendador»");
    expect(o.consequence).toContain("dá para restaurar todos por 7 dias");
    expect(o.confirm?.title).toBe("Descartar este item e os 2 cards que dependem dele?");
    expect(o.invoke).toMatchObject({ kind: "delete-card", withDependents: true });
    expect(o.undo).toMatchObject({ kind: "restore-card", group: true });
    expect(o.done).toContain("foram para a lixeira (dá para restaurar todos por 7 dias)");
    expect(o.disabled).toBeUndefined();
    expect(discardOf([mkCard({ id: "d1", title: "Agendador", serves: card.id, status: "enriquecer" })]).label).toBe("Descartar com o card que depende dele");
  });

  it("um dependente que já produziu trabalho: a opção vem DESABILITADA, com o motivo e o card que segura a um clique", () => {
    const o = discardOf([mkCard({ id: "d1", title: "Agendador de posts", serves: card.id, status: "enriquecer", qaPassed: true })]);
    expect(o.label).toBe("Descartar");
    expect(o.disabled?.reason).toBe("Não dá para descartar junto: «Agendador de posts», que depende deste card, já passou pela verificação. Abra esse card e decida o que fazer com ele; depois descarte este.");
    expect(o.disabled?.unblock).toMatchObject({ label: "Abrir o card que segura" });
    expect(o.disabled?.unblock?.href).toContain("d1");
  });

  it("sem os fatos do board (o sinal de um card sozinho) o descarte é o de um card — o servidor recusa se houver dependente", () => {
    const d = decideItem(item, ctx(HUMAN, card));
    expect(d.options.find((o) => o.id === "discard")).toMatchObject({ label: "Descartar", invoke: { kind: "delete-card" } });
  });
});
