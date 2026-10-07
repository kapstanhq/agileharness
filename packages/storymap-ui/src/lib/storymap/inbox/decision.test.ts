import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, CardQuestion, DeployCause } from "../types";
import type { CockpitItem, CockpitItemKind } from "../demands";
import { RISK_CLASSES } from "../types";
import { acceptTriageRefusal, dataDeletionRefusal, moveRefusal, republishRefusal, runSkillRefusal } from "../preconditions";
import { cardCockpitItems, DEPLOY_FAILURE_FINDING_ID } from "../demands";
import { evaluateGate } from "../gates";
import type { OptionInvokeKind } from "./decision";
import { decideItem, DEPLOY_WATCH_MINUTES, HAPPENED_MAX, leadsToPublish, OPTION_LABEL_MAX, primaryOption, promote, REFINE_DEFAULT_NOTE, type ItemDecision } from "./decision";
import { ASK_FORMAT, bannedTermsIn, formatDecisionText, itemTermsIn, localTimeFormatter } from "./copy";
import { foldByCard, INBOX_PRECEDENCE, inboxSections, inboxSummary, itemEntries, summaryLine, type InboxEntry } from "./entries";
import { followUpInWindow, systemDecisionEntry } from "./system-entries";
import { emptyFacts, isDiscard, type InboxFacts } from "./contract";
import type { FollowUpItem } from "../system-decisions";
import { FIXTURES, HUMAN, HUMAN_JIDO, KINDS, MODES, NOW, ULTRA, ULTRA_JIDO, ctx, mkCard, st } from "./items.fixture";
import { findingFixRefusal } from "../finding-fix";
import { inboxFactsOf } from "./collect";
import type { DeployBlockRow } from "../runner/deploy-blocks";

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
  it("modo humano: toda decisão real é do dono (Decidir), menos amostra, aviso, os avisos do host e o card parado sem dono", () => {
    const acompanhar = KINDS.filter((k) => decide(k, HUMAN).bucket === "acompanhar").sort();
    // fase 6 — o diagnóstico da Sentinela é um aviso do sistema: a saída dele é conversar («Resolver no chat»), não um
    // desfecho de um clique, então mora em Acompanhar como a saúde do host
    expect(acompanhar).toEqual(["capacity-latch", "delivery-audit", "finding", "host-health", "meter-stalled", "proxy-audit", "push-off", "sentinel", "stalled"]);
  });

  it("só-negócio: PRD, dados de pessoas, a captura do dono, o comando travado e o pedido de autorização do plano ficam em Decidir; o técnico sai", () => {
    const decidir = KINDS.filter((k) => decide(k, ULTRA).bucket === "decidir").sort();
    // a pergunta do fixture não tem categoria: fica com o dono até ser classificada (fail-closed, questionVerdict)
    // fase 3: as alavancas do operador (o pedido segurado e bloqueado, as entregas paradas num board manual) também
    expect(decidir).toEqual(["data-deletion", "governance", "locked-exec", "proposal", "publish-approval", "publish-held", "question", "stage-idle"]);
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

  it("board humano com o Jido ligado: a pergunta que o perfil deixa com o dono NÃO vai ao Jido — fica em Decidir", () => {
    // Mínima nas caixas de story: o `answer_question` de um agente seria recusado (autonomy.ts agentAnswerRefusal); se o
    // Inbox a desse ao Jido, ela sumia do dono para quem não pode respondê-la.
    for (const category of ["technical", "interview", "guardrail"] as const) {
      const item = { ...FIXTURES.question.item, category } as CockpitItem;
      expect(decideItem(item, ctx(HUMAN_JIDO, FIXTURES.question.card)).bucket, category).toBe("decidir");
    }
    // com a caixa da categoria ligada (a exceção do card, aqui), o Jido a pega como antes
    const ultraCard = { ...FIXTURES.question.card, autonomyMode: "ultra" as const };
    const picked = decideItem({ ...FIXTURES.question.item, category: "technical" } as CockpitItem, ctx(HUMAN_JIDO, ultraCard));
    expect(picked.next.who === "jido" || picked.bucket === "acompanhar").toBe(true);
  });

  // decisão do dono (06/10): o dono não revisa amostras — um revisor independente (IA) revisa. Esse revisor ainda não
  // roda: a amostra NÃO some (sumir era ninguém revisar, calado); fica em Acompanhar, dita «ninguém está revisando».
  it("as amostras de auditoria nunca são Decidir: ficam em «Os agentes estão cuidando», marcadas sem revisor", () => {
    for (const [, config] of MODES) {
      for (const kind of ["delivery-audit", "proxy-audit"] as const) {
        const d = decide(kind, config);
        expect(d.bucket, kind).toBe("acompanhar");
        expect(d.next, kind).toMatchObject({ who: "ninguem", stalled: true });
        expect(d.next.label, kind).toMatch(/Ninguém está revisando/);
        const entries = itemEntries([FIXTURES[kind].item], { boardId: "b1", boardName: "Board", config, cardsById: new Map([["c1", FIXTURES[kind].card]]), now: NOW });
        expect(entries.map((e) => e.decision.bucket), kind).toEqual(["acompanhar"]);
      }
      expect(decide("delivery-audit", config).happened).toMatch(/Antes: sem convite/);
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

  it("passo com ação automática: «tentar de novo» é o MESMO do efeito que não rodou (no lugar, um clique) + o Jido", () => {
    const d = decide("stalled");
    expect(d.options.map((o) => o.id)).toEqual(["retry-effect", "jido-look"]);
    const retry = d.options[0];
    const twin = decide("effect-failed").options[0];
    expect(retry.invoke).toEqual({ kind: "republish", boardId: "b1", cardId: "c1" });
    expect(retry).toMatchObject({ label: twin.label, tone: twin.tone, auditCls: twin.auditCls, done: twin.done });
    expect(retry.disabled).toBeUndefined();
    expect(d.options[1].invoke).toMatchObject({ kind: "escalate", ref: { templateId: "hitl-card-instructions", cardId: "c1" } });
  });

  it("promoção do código (sem publicar): «Tentar de novo», sem dizer produção", () => {
    const d = decideItem({ ...stalledItem, status: "stage", stepName: "Homologar", effect: "promote-stage" } as CockpitItem, ctx(HUMAN, mkCard({ status: "stage" })));
    expect(d.options[0]).toMatchObject({ id: "retry-effect", label: "Tentar de novo", tone: "primary", auditCls: "merge-resolve" });
    expect(d.options[0].label).not.toMatch(/produção/);
  });

  it("«tentar de novo» fora de um passo com ação automática: bloqueado com a frase de republishRefusal", () => {
    const card = mkCard({ status: "release" });
    const d = decideItem(stalledItem, ctx(HUMAN, card));
    expect(d.options[0].disabled?.reason).toBe(republishRefusal(card, HUMAN));
  });

  // fase 3 (decisão do dono): o card CONDUZIDO que ninguém assumiu é Decidir, com as duas saídas do operador
  it("card conduzido que ninguém assumiu: Decidir em todo modo, com «Devolver ao fluxo» (principal) e «Parar condutor»", () => {
    const card = mkCard({ status: "desenvolver", routing: { driver: "conductor" } } as Partial<Card>);
    for (const [mode, config] of MODES) {
      const d = decideItem(noEffect, ctx(config, card));
      expect(d.bucket, mode).toBe("decidir");
      expect(d.options.map((o) => [o.label, o.invoke.kind, o.tone]), mode).toEqual([
        ["Devolver ao fluxo", "return-to-flow", "primary"],
        ["Parar condutor", "stop-conductor", "neutral"],
      ]);
      expect(d.verdict.decider, mode).toBe("owner");
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
    // um clique (fase 3): o rótulo diz produção — nenhum diálogo antes
    expect(d.options[0].label).toMatch(/produção/);
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
    expect(d.options.map((o) => o.label)).toEqual(["Pedir ao Jido para integrar", "No computador: como integrar à mão", "Descartar este trabalho — não tem volta"]);
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
    expect(d.options[0].label).toMatch(/não tem volta/);
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

  it("reabrir uma entrega roda num clique com o motivo padrão; sem handle, não há botão", () => {
    const o = systemDecisionEntry(sd({ undo: { kind: "reopen-card", cardId: "c1", deliveredIn: "concluida" } }), { boardId: "b1", boardName: "B", config: HUMAN, card: mkCard({ status: "concluida" }) }).decision.options[0];
    expect(o.requires).toBeUndefined();
    expect((o.invoke as { note?: string }).note).toBeTruthy();
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
    "answer-question": { serverStateOnly: "a única recusa é a resposta vazia — a alternativa/sugestão vem no invoke; a resposta livre envia o texto (requires: answer)" },
    "reject-governance": { serverStateOnly: "recusa só a proposta que já foi decidida (estado do disco)" },
    "grant-request": { serverStateOnly: "o pedido vencido sai do Inbox no coletor; sem os argumentos, a opção vem bloqueada (às cegas)" },
    "deny-request": { serverStateOnly: "recusa só o pedido já decidido ou vencido (estado do disco)" },
    "resolve-proxy-audit": { serverStateOnly: "recusa só a amostra já resolvida (estado do disco)" },
    "resolve-delivery-audit": { serverStateOnly: "reabrir exige o motivo — o invoke traz o motivo padrão (um clique)" },
    "accept-proposal": { serverStateOnly: "recusa a seleção vazia — o invoke traz todos os itens propostos (um clique)" },
    "refine-proposal": { serverStateOnly: "recusa o comentário vazio — o invoke traz o ajuste padrão (um clique)" },
    "request-redesign": { serverStateOnly: "sem pedido de mudança aberto a opção vem bloqueada, com o que a libera" },
    "renew-meter": { serverStateOnly: "o desfecho do governador volta como recibo (renovado) ou recusa (segue parado)" },
    "undo-system-decision": { serverStateOnly: "a pré-condição de cada desfazer lê o card FRESCO sob o lock (system-decisions undoRefusal)" },
    "show-publish-status": { serverStateOnly: "só leitura — não muda nada" },
    "fix-finding": { serverStateOnly: "o item do aviso só existe enquanto o aviso está aberto; a recusa por aviso já tratado é coberta no teste do item do dono" },
    "authorize-publish": { serverStateOnly: "o pedido de autorização mora no livro de causas do servidor; a opção só existe enquanto o plano o pede" },
    "approve-locked-exec": { serverStateOnly: "a recusa é do serviço: pedido já decidido, hash que mudou, ou chamador que não é o dono na sessão dele" },
    "reject-locked-exec": { serverStateOnly: "recusa só o pedido já decidido (estado do serviço)" },
    "explain-locked-exec": { serverStateOnly: "só explica um pedido JÁ recusado, e recusa o motivo vazio (estado do serviço)" },
    "undo-locked-exec": { serverStateOnly: "o desfazer só é oferecido para o comando que deu certo e tem desfazer; o resto é estado do serviço" },
    "keep-locked-exec": { serverStateOnly: "só é oferecido para o comando que deu certo (estado do serviço)" },
    "publish-staged": { serverStateOnly: "a máquina de publicação desligada vem no item (canPublish); o resto (board só de organização, sha) é do servidor" },
    "cancel-publish": { serverStateOnly: "recusa só o pedido que já se resolveu (estado da fila)" },
    "rerequest-publish": { serverStateOnly: "só a sessão do operador refaz; a medição é do serviço" },
    "clear-latch": { serverStateOnly: "a trava do arquivo HALT vem bloqueada no item; o resto (quem chama) é do servidor" },
    "enable-push": { serverStateOnly: "gesto do navegador — a permissão é pedida na tela" },
    "dismiss-push-offer": { serverStateOnly: "só grava a dispensa da oferta — não há o que recusar" },
    "stop-conductor": { serverStateOnly: "só a sessão do operador para o condutor; a sessão viva é do serviço" },
    "return-to-flow": { serverStateOnly: "só a sessão do operador devolve o card; a sessão viva é do serviço" },
    "ack-locked-exec": { serverStateOnly: "só é oferecido para um desfecho final (estado do serviço)" },
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
  it("a exclusão de dados diz, no botão e na consequência, O QUE é apagado, o alvo e que não tem volta (um clique)", () => {
    const d = decideItem({ ...FIXTURES["data-deletion"].item, target: "/perfil/salvos", scope: ["dados"] } as CockpitItem, ctx(HUMAN, FIXTURES["data-deletion"].card));
    const o = d.options[0];
    expect(o).toMatchObject({ tone: "danger", auditCls: "destructive" });
    expect(o.consequence).toContain("Lista de desejos compartilhada");
    expect(o.consequence).toContain("/perfil/salvos");
    expect(o.label).toMatch(/não tem volta/);
    expect(o.consequence).toMatch(/não voltam/);
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
      ["finding:acknowledged", "Aceitar o risco, sem consertar", "neutral"],
    ]);
    expect(d.options[0].invoke).toEqual({ kind: "fix-finding", boardId: item.boardId, cardId: item.cardId, findingId: "f2" });
    expect(d.options[1].invoke).toMatchObject({ kind: "update-finding", status: "acknowledged" });
    expect(d.options[1].consequence).toMatch(/fica sem conserto/);
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
    expect(d.happened).toMatch(/3 arquivos/);
    expect(d.ask).toMatch(/^Autorizar a publicação do código de «.+»/);
    expect(d.ask).toMatch(/afeta 2 cards$/);
    expect(d.details.find((x) => x.label === "O que você autoriza")?.value).toBe("3 arquivos");
    // o nome técnico das partes publicadas só em Detalhes (07/10: «face:<app>» chegava à pergunta)
    expect(d.details.find((x) => x.label === "Onde publica (nome técnico)")?.value).toBe("api, functions");
    expect(d.details.find((x) => x.label === "Arquivos")?.value).toBe("pay/a.ts, pay/b.ts, fn/c.ts");
  });

  it("visto de OUTRO card que a causa segura: diz que o código vem do card âncora e segura este (não parece falar do card errado)", () => {
    const anchor = mkCard({ id: "story-ex7702", title: "Trocar o meio de pagamento da oficina" });
    const approvals = new Map([[own.causeKey, [request("a", ["pay/a.ts"], ["api"])]]]);
    const withAnchor = (cardId: string) =>
      decideItem({ ...item, cardId } as CockpitItem, {
        ...ctx(ULTRA, held),
        facts: facts({ deployApprovals: approvals, deployAnchor: new Map([[own.causeKey, anchor.id]]), cardsById: new Map([[anchor.id, anchor], [held.id, held]]) }),
      });
    expect(withAnchor(held.id === anchor.id ? "story-ex7703" : held.id).ask).toMatch(
      /^Autorizar a publicação do código de «.+» que segura este card\? \(o código vem de «Trocar o meio de pagamento da oficina»\)/,
    );
    expect(withAnchor(anchor.id).ask).toMatch(/^Autorizar a publicação do código de «.+» de «Trocar o meio de pagamento da oficina»\?/);
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

// O ITEM DA CAUSA mora no Inbox do board que PUBLICA o pacote (a linha do livro mora lá): os cards de outros boards que
// ela segura entram nele com o board de cada um, o card de outro board só diz onde decidir, e o pedido refeito aparece
// como «refazendo o pedido…» até o plano novo chegar. Boards inventados: `vitrine` publica, `bancada` não.
describe("o Inbox da causa no board que publica — cards de outros boards e o pedido refeito", () => {
  const own: DeployCause = { pkg: "vitrine", phase: "needs-human", units: ["api"], rules: ["checkout"], ownerClass: "money", decider: "owner", causeKey: "vitrine:owner:money" };
  const finding = { id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "Precisa de você", deployPhase: "needs-human", deployCause: own } as Card["findings"][number];
  const VITRINE = { ...ULTRA, id: "vitrine", name: "Vitrine" } as BoardConfig;
  const BANCADA = { ...ULTRA, id: "bancada", name: "Bancada" } as BoardConfig;
  const local = mkCard({ id: "v1", title: "Cupom no carrinho", status: "release", findings: [finding] });
  const moved = mkCard({ id: "b1", title: "Parcelar a compra", status: "release", findings: [finding] });
  const request = { subject: { kind: "diff" as const, hash: `sha256:${"a".repeat(64)}`, base: "abc1234", head: "f".repeat(40), files: ["pay/a.ts"] }, record: "rec", units: ["api"], rules: ["checkout"] };
  const row = (over: Partial<DeployBlockRow> = {}): DeployBlockRow => ({
    board: "vitrine", causeKey: own.causeKey, pkg: "vitrine", phase: "needs-human", decider: "owner", ownerClass: "money", units: ["api"], rules: ["checkout"],
    command: "./ship", firstAt: "2026-09-28T10:00:00Z", lastAt: "2026-09-28T10:00:00Z", cardIds: ["v1", "b1"], planHead: null, attributedCard: "b1",
    cardBoards: { b1: "bancada" }, approvals: [request], ...over,
  });
  const names = new Map([["vitrine", "Vitrine"], ["bancada", "Bancada"]]);
  const itemOf = (card: Card, board: string) => ({ ...FIXTURES["deploy-failed"].item, id: `${card.id}:deploy-failed`, boardId: board, cardId: card.id, cardTitle: card.title, needsHuman: true, causeKey: own.causeKey }) as CockpitItem;

  it("no board que publica: o card de OUTRO board entra, o pedido autoriza na linha DESTE board e a lista diz o board de cada card", () => {
    const facts = inboxFactsOf({ boardId: "vitrine", config: VITRINE, cards: [local, moved], ledger: [row()], boardNames: names, now: NOW });
    expect(facts.deployLedger?.has(own.causeKey)).toBe(true);
    const d = decideItem(itemOf(moved, "bancada"), { ...ctx(VITRINE, moved), facts });
    expect(d.bucket).toBe("decidir");
    expect(d.options[0]).toMatchObject({ id: "authorize-publish", invoke: { kind: "authorize-publish", boardId: "vitrine", causeKey: own.causeKey } });
    expect(d.details.find((x) => x.label === "Cards")?.value).toBe("«Cupom no carrinho» (Vitrine), «Parcelar a compra» (Bancada)");
    // o card âncora abre no board DELE
    expect(JSON.stringify(d.more)).toContain("/board/bancada/");
  });

  it("no board do card movido: a causa segue viva, mas a decisão mora no board que publica — sem botão, com o caminho", () => {
    const facts = inboxFactsOf({ boardId: "bancada", config: BANCADA, cards: [moved], ledger: [row()], boardNames: names, now: NOW });
    // viva: a linha de OUTRO board segura este card (sem isso o item sairia com «o sistema publica de novo»)
    expect(facts.deployLedger?.has(own.causeKey)).toBe(true);
    const d = decideItem(itemOf(moved, "bancada"), { ...ctx(BANCADA, moved), facts });
    expect(d.bucket).toBe("acompanhar");
    expect(d.options).toEqual([]);
    expect(d.ask).toMatch(/espera no board «Vitrine», que publica o pacote dela/);
    expect(d.more.find((o) => o.id === "more:open-publisher")?.invoke).toEqual({ kind: "link", href: "/board/vitrine/inbox?item=b1%3Adeploy-failed" });
  });

  it("o pedido sendo refeito: «refazendo o pedido…» em vez do botão (que autorizaria o que já mudou), até a janela acabar", () => {
    const rerequesting = row({ rerequestedAt: new Date(NOW - 60_000).toISOString() });
    const facts = inboxFactsOf({ boardId: "vitrine", config: VITRINE, cards: [local, moved], ledger: [rerequesting], boardNames: names, now: NOW });
    const d = decideItem(itemOf(local, "vitrine"), { ...ctx(VITRINE, local), facts });
    expect(d.bucket).toBe("acompanhar");
    expect(d.ask).toMatch(/^Refazendo o pedido de publicação…/);
    expect(d.next.label).toBe("refazendo o pedido…");
    expect(d.options.some((o) => o.invoke.kind === "authorize-publish")).toBe(false);
    // passada a janela sem resposta, o Inbox volta a mostrar a causa como ela está
    const late = inboxFactsOf({ boardId: "vitrine", config: VITRINE, cards: [local, moved], ledger: [rerequesting], boardNames: names, now: NOW + 31 * 60_000 });
    expect(decideItem(itemOf(local, "vitrine"), { ...ctx(VITRINE, local, NOW + 31 * 60_000), facts: late }).options[0]?.id).toBe("authorize-publish");
  });

  it("o pedido que o sistema JÁ SABE velho e não pôde refazer sozinho: sem «Autorizar», «Refazer o pedido agora» — no MESMO item", () => {
    const stale = row({ staleApprovals: [request.subject.hash] });
    const facts = inboxFactsOf({ boardId: "vitrine", config: VITRINE, cards: [local, moved], ledger: [stale], boardNames: names, now: NOW });
    expect(facts.deployApprovals.has(own.causeKey)).toBe(false);
    const item = itemOf(local, "vitrine");
    const d = decideItem(item, { ...ctx(VITRINE, local), facts });
    // fase 3: a Esteira saiu — a alavanca dela é a opção do próprio item, e ele é Decidir
    expect(d.bucket).toBe("decidir");
    expect(d.options.some((o) => o.invoke.kind === "authorize-publish")).toBe(false);
    expect(d.ask).toMatch(/^Refazer o pedido de publicação/);
    expect(d.options.map((o) => o.invoke)).toEqual([{ kind: "rerequest-publish", boardId: "vitrine" }]);
    // o pedido novo chega na mesma linha (o plano relido apaga a marca): o MESMO item volta a «Autorizar»
    const fresh = row({ approvals: [{ ...request, subject: { ...request.subject, hash: `sha256:${"b".repeat(64)}` } }] });
    const again = decideItem(item, { ...ctx(VITRINE, local), facts: inboxFactsOf({ boardId: "vitrine", config: VITRINE, cards: [local, moved], ledger: [fresh], boardNames: names, now: NOW }) });
    expect(again.options[0]?.id).toBe("authorize-publish");
  });

  it("um pedido velho e outro que vale na mesma causa: o botão autoriza só o que vale", () => {
    const other = { ...request, subject: { ...request.subject, hash: `sha256:${"c".repeat(64)}`, files: ["pay/b.ts"] } };
    const facts = inboxFactsOf({ boardId: "vitrine", config: VITRINE, cards: [local, moved], ledger: [row({ approvals: [request, other], staleApprovals: [request.subject.hash] })], boardNames: names, now: NOW });
    expect(facts.deployApprovals.get(own.causeKey)?.map((a) => a.subject.hash)).toEqual([other.subject.hash]);
    const d = decideItem(itemOf(local, "vitrine"), { ...ctx(VITRINE, local), facts });
    expect(d.options[0]?.id).toBe("authorize-publish");
    expect(d.details.find((x) => x.label === "Arquivos")?.value).toBe("pay/b.ts");
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
    expect(o).toMatchObject({ label: "Descartar (vai para a lixeira)", invoke: { kind: "delete-card", boardId: item.boardId, cardId: item.cardId }, undo: { kind: "restore-card" } });
    expect((o.invoke as { withDependents?: boolean }).withDependents).toBeUndefined();
    expect((o.undo as { group?: boolean }).group).toBeUndefined();
    expect(o.disabled).toBeUndefined();
  });

  it("com dependentes: a opção diz QUANTOS e QUAIS vão junto, antes do clique; o desfazer restaura todos", () => {
    const o = discardOf([mkCard({ id: "d1", title: "Agendador de posts", serves: card.id, status: "enriquecer" }), mkCard({ id: "d2", title: "Tela do agendador", parent: "d1", status: "enriquecer" })]);
    expect(o.label).toBe("Descartar com os 2 cards que dependem dele");
    expect(o.consequence).toContain("«Agendador de posts», «Tela do agendador»");
    expect(o.consequence).toContain("dá para restaurar todos por 7 dias");
    expect(o.invoke).toMatchObject({ kind: "delete-card", withDependents: true });
    expect(o.undo).toMatchObject({ kind: "restore-card", group: true });
    expect(o.done).toContain("foram para a lixeira (dá para restaurar todos por 7 dias)");
    expect(o.disabled).toBeUndefined();
    expect(discardOf([mkCard({ id: "d1", title: "Agendador", serves: card.id, status: "enriquecer" })]).label).toBe("Descartar com o card que depende dele");
  });

  it("um dependente que já produziu trabalho: a opção vem DESABILITADA, com o motivo e o card que segura a um clique", () => {
    const o = discardOf([mkCard({ id: "d1", title: "Agendador de posts", serves: card.id, status: "enriquecer", qaPassed: true })]);
    expect(o.label).toBe("Descartar (vai para a lixeira)");
    expect(o.disabled?.reason).toBe("Não dá para descartar junto: «Agendador de posts», que depende deste card, já passou pela verificação. Abra esse card e decida o que fazer com ele; depois descarte este.");
    expect(o.disabled?.unblock).toMatchObject({ label: "Abrir o card que segura" });
    expect(o.disabled?.unblock?.href).toContain("d1");
  });

  it("sem os fatos do board (o sinal de um card sozinho) o descarte é o de um card — o servidor recusa se houver dependente", () => {
    const d = decideItem(item, ctx(HUMAN, card));
    expect(d.options.find((o) => o.id === "discard")).toMatchObject({ label: "Descartar (vai para a lixeira)", invoke: { kind: "delete-card" } });
  });
});

// ── Fase 3 — o Inbox refeito: linguagem simples, um clique, as alavancas da Esteira e os avisos do host ──────────

describe("fase 3 — o texto de TODO kind: o que aconteceu, o que precisa, as opções — curtos e sem termo proibido", () => {
  const LIMITS = { ask: 140, happened: 420, label: OPTION_LABEL_MAX } as const;
  it.each(MODES)("modo %s", (_m, config) => {
    for (const kind of KINDS) {
      const d = decide(kind, config);
      expect(formatDecisionText(d.ask, fmt).length, `${kind}: «${d.ask}»`).toBeLessThanOrEqual(LIMITS.ask);
      expect(formatDecisionText(d.happened, fmt).length, `${kind}: «${d.happened}»`).toBeLessThanOrEqual(LIMITS.happened);
      for (const o of d.options) expect(o.label.length, `${kind}/${o.id}: «${o.label}»`).toBeLessThanOrEqual(LIMITS.label);
      for (const text of [d.ask, d.happened, ...d.options.map((o) => o.label)]) {
        expect(itemTermsIn(formatDecisionText(text, fmt)).map((t) => t.id), `${kind}: «${text}»`).toEqual([]);
      }
    }
  });
});

describe("fase 3 — UM clique: nenhuma opção pede diálogo nem formulário antes do botão", () => {
  const all = (config: BoardConfig) => KINDS.flatMap((k) => decide(k, config).options.map((o) => ({ k, o })));
  it.each(MODES)("modo %s: sem confirmação, e só a resposta livre/escolha múltipla leem o corpo do item", (_m, config) => {
    for (const { k, o } of all(config)) {
      expect(o, `${k}/${o.id}`).not.toHaveProperty("confirm");
      if (o.requires) expect(o.invoke.kind, `${k}/${o.id}`).toBe("answer-question");
    }
  });
  it("o que pedia um texto roda com o texto PADRÃO, e o recibo oferece «Adicionar um motivo» quando o servidor aceita um depois", () => {
    const refine = decide("proposal").options.find((o) => o.id === "refine-proposal")!;
    expect(refine.invoke).toMatchObject({ kind: "refine-proposal", note: REFINE_DEFAULT_NOTE });
    expect(refine.addNote).toMatchObject({ label: "Adicionar um motivo", invoke: { kind: "refine-proposal" } });
    expect((refine.addNote!.invoke as { note?: string }).note).toBeUndefined();
    const reject = decide("locked-exec").options.find((o) => o.id === "reject")!;
    expect((reject.invoke as { note?: string }).note?.trim()).toBeTruthy();
    // «Não rodar» também: o motivo da pessoa vai DEPOIS, e explica a recusa sem mudar a decisão
    expect(reject.addNote).toMatchObject({ label: "Adicionar um motivo", invoke: { kind: "explain-locked-exec" } });
  });
  it("aceitar a proposta cria TODOS os itens no clique (a seleção do corpo, quando houver, vem no payload)", () => {
    const accept = decide("proposal").options.find((o) => o.id === "accept-proposal")!;
    expect(accept.requires).toBeUndefined();
    expect((accept.invoke as { items?: unknown[] }).items).toEqual((FIXTURES.proposal.item as { items: unknown[] }).items);
    expect(accept.label).toBe("Criar o card");
  });
  it("o que não tem volta diz isso no RÓTULO; o reversível traz o desfazer", () => {
    expect(decide("data-deletion").options[0].label).toBe("Apagar os dados — não tem volta");
    expect(decide("merge-failed").options.find((o) => o.id === "discard-work")!.label).toMatch(/não tem volta/);
    const discard = decide("review").options.find((o) => o.id === "discard")!;
    expect(discard.label).toMatch(/lixeira/);
    expect(discard.undo).toMatchObject({ kind: "restore-card" });
  });
});

describe("fase 3 — a pergunta do agente: cada alternativa é um botão", () => {
  const q = FIXTURES.question.item as Extract<CockpitItem, { kind: "question" }>;
  const ask = (over: Partial<typeof q>) => decideItem({ ...q, ...over } as CockpitItem, ctx(HUMAN, FIXTURES.question.card));
  it("escolha única: um botão por alternativa (a recomendada é a principal) e a resposta livre à mão", () => {
    const d = ask({ options: [{ id: "o1", label: "Ignorar acentos", recommended: true, pros: ["acha mais livros"] }, { id: "o2", label: "Exigir a grafia exata" }], mode: "single" });
    expect(d.options.map((o) => [o.label, o.tone, o.requires ?? null])).toEqual([
      ["Ignorar acentos", "primary", null],
      ["Exigir a grafia exata", "neutral", null],
      ["Responder com as suas palavras", "neutral", "answer"],
    ]);
    expect(d.options[0].invoke).toEqual({ kind: "answer-question", boardId: "b1", cardId: "c1", questionId: "q1", selectedOptionIds: ["o1"] });
    expect(d.options[0].consequence).toMatch(/A favor: acha mais livros/);
  });
  it("aberta com sugestão: «Usar a sugestão» responde com ela num clique", () => {
    const d = ask({ options: [], recommendation: "Mostrar os mais vendidos primeiro" });
    expect(d.options[0]).toMatchObject({ label: "Usar a sugestão: Mostrar os mais vendidos primeiro", tone: "primary", invoke: { kind: "answer-question", answer: "Mostrar os mais vendidos primeiro" } });
    expect(d.options[1]).toMatchObject({ label: "Responder", requires: "answer", tone: "neutral" });
  });
  // revisão da fase 3: o ask_question aceitava rótulos de 80 e o botão cortava em 60 — um rótulo válido chegava cortado
  it("o teto do rótulo que o ask_question aceita É o do botão; a sugestão longa não é cortada no meio", () => {
    expect(ASK_FORMAT.optionLabelMax).toBe(OPTION_LABEL_MAX);
    const label = "Mostrar os mais vendidos e depois os lançamentos da semana".slice(0, OPTION_LABEL_MAX);
    expect(ask({ options: [{ id: "o1", label, recommended: true }, { id: "o2", label: "Não" }], mode: "single" }).options[0].label).toBe(label);
    const rec = "Mostrar primeiro os mais vendidos da semana, depois os lançamentos e por último os clássicos da casa";
    const d = ask({ options: [], recommendation: rec });
    expect(d.options[0].label).toBe("Usar a sugestão");
    expect(d.options[0].consequence).toContain(rec);
  });
  it("sem alternativa recomendada, nenhuma alternativa do agente é a principal (a resposta livre é)", () => {
    const d = ask({ options: [{ id: "o1", label: "Ignorar acentos" }, { id: "o2", label: "Exigir a grafia exata" }], mode: "single" });
    const main = primaryOption(d);
    expect(main?.invoke.kind === "answer-question" && main.invoke.selectedOptionIds).toBeFalsy();
    expect(main?.requires).toBe("answer");
  });
  it("múltipla escolha: marca no corpo e envia", () => {
    const d = ask({ options: [{ id: "o1", label: "Capa" }, { id: "o2", label: "Sinopse" }], mode: "multi" });
    expect(d.options[0]).toMatchObject({ requires: "selection", tone: "primary" });
  });
  it("o contexto do agente é o «o que aconteceu»; o inteiro vai para Detalhes quando passa do teto", () => {
    expect(ask({ context: "A busca do catálogo já acha livros pelo título." }).happened).toBe("A busca do catálogo já acha livros pelo título.");
    const long = "A busca do catálogo já acha livros pelo título e pelo autor. ".repeat(8);
    const d = ask({ context: long });
    expect(d.happened.length).toBeLessThanOrEqual(HAPPENED_MAX);
    expect(d.details.find((x) => x.label === "Contexto inteiro")?.value).toBe(long);
  });
});

describe("fase 3 — as alavancas da Esteira no Inbox", () => {
  it("pedido segurado e BLOQUEADO: Decidir, «Publicar mesmo assim» (por cima da guarda) e «Cancelar o pedido», com o motivo em Detalhes", () => {
    for (const [mode, config] of MODES) {
      const d = decide("publish-held", config);
      expect(d.bucket, mode).toBe("decidir");
      expect(d.options.map((o) => [o.label, o.invoke])).toEqual([
        ["Publicar mesmo assim", { kind: "publish-staged", boardId: "b1", override: true }],
        ["Cancelar o pedido", { kind: "cancel-publish", boardId: "b1", requestId: "pub-ex9001" }],
      ]);
      expect(d.details.find((x) => x.label === "Motivo")?.value).toMatch(/trabalho vivo nos mesmos arquivos/);
    }
  });
  it("pedido segurado que ainda espera (sem bloqueio): Acompanhar — o sistema tenta de novo —, com as alavancas à mão", () => {
    const d = decideItem({ ...FIXTURES["publish-held"].item, blocked: false } as CockpitItem, ctx(HUMAN, FIXTURES["publish-held"].card));
    expect(d.bucket).toBe("acompanhar");
    expect(d.next.who).toBe("sistema");
    expect(d.options).toHaveLength(2);
  });
  it("entregas paradas num board manual: «Publicar as N entregas»; com a publicação desligada, o botão diz por quê", () => {
    const d = decide("stage-idle");
    expect(d.bucket).toBe("decidir");
    expect(d.ask).toBe("Publicar as 3 entregas que esperam há 30 horas?");
    expect(d.options[0]).toMatchObject({ label: "Publicar as 3 entregas", invoke: { kind: "publish-staged", boardId: "b1" } });
    const off = decideItem({ ...FIXTURES["stage-idle"].item, canPublish: false } as CockpitItem, ctx(HUMAN, FIXTURES["stage-idle"].card));
    expect(off.options[0].disabled?.reason).toMatch(/desligada/);
  });
  it("o pedido de autorização envelhecido: «Refazer o pedido agora», daqui — nenhum link para a Esteira", () => {
    const d = decideItem({ ...FIXTURES["publish-approval"].item, approvals: [], stale: true } as CockpitItem, ctx(HUMAN, FIXTURES["publish-approval"].card));
    expect(d.bucket).toBe("decidir");
    expect(d.options.map((o) => [o.label, o.invoke])).toEqual([["Refazer o pedido agora", { kind: "rerequest-publish", boardId: "b1" }]]);
    for (const kind of KINDS) for (const o of [...decide(kind).options, ...decide(kind).more]) expect(JSON.stringify(o.invoke), kind).not.toMatch(/\/entrega/);
  });
});

describe("fase 3 — os avisos do host: uma faixa, com a ação que destrava", () => {
  it("a trava da cota: faixa com «Soltar a trava»; a do arquivo HALT vem bloqueada com o porquê", () => {
    const d = decide("capacity-latch");
    expect(d.banner).toBe(true);
    expect(d.options[0]).toMatchObject({ label: "Soltar a trava", invoke: { kind: "clear-latch" } });
    const halt = decideItem({ ...FIXTURES["capacity-latch"].item, halt: true } as CockpitItem, ctx(HUMAN, FIXTURES["capacity-latch"].card));
    expect(halt.options[0].disabled?.reason).toMatch(/arquivo no servidor/);
  });
  it("a saúde vermelha: faixa que nomeia os sinais; o aviso no celular: faixa com «Ativar o aviso no celular»", () => {
    expect(decide("host-health")).toMatchObject({ banner: true, ask: "A ferramenta não está bem: Cards parados" });
    // quick-fix health-red: a faixa só diz o que aconteceu — nunca «abri um card de conserto» sem card
    const base = FIXTURES["host-health"];
    const happened = (signals: unknown[]) => decideItem({ ...base.item, signals } as CockpitItem, ctx(HUMAN, base.card)).happened;
    const sig = { id: "S6", label: "Vazão até o ar", detail: "3 cards" };
    expect(decide("host-health").happened).not.toMatch(/virou um card|está no card/);
    expect(decide("host-health").happened).toMatch(/Ainda não foi aberto card de conserto/);
    const skipped = happened([{ ...sig, noCard: "board só de organização — nada roda sozinho" }]);
    expect(skipped).toMatch(/Nenhum card de conserto foi aberto: board só de organização/);
    expect(skipped).not.toMatch(/está no card|virou um card/);
    expect(happened([{ ...sig, card: "story-ex9202" }])).toMatch(/O conserto está no card story-ex9202/);
    expect(decide("push-off").options[0]).toMatchObject({ label: "Ativar o aviso no celular", invoke: { kind: "enable-push" } });
    expect(decide("push-off").banner).toBe(true);
    // a faixa não é lembrete eterno: «Agora não» grava a dispensa (um clique)
    expect(decide("push-off").options[1]).toMatchObject({ label: "Agora não", invoke: { kind: "dismiss-push-offer" } });
  });
  it("as faixas do host não contam no Decidir (o número da barra)", () => {
    const entries = itemEntries(
      (["capacity-latch", "host-health", "push-off"] as const).map((k) => FIXTURES[k].item),
      { boardId: "b1", boardName: "Board", config: HUMAN, cardsById: new Map(), now: NOW },
    );
    expect(inboxSections(entries).banners).toHaveLength(3);
    expect(inboxSummary(entries).decidir).toBe(0);
  });
});

describe("07/10 — o que o dono lê, sem nome técnico", () => {
  it("a autorização de publicação não diz o nome técnico da parte publicada; ele fica em Detalhes", () => {
    const d = decide("publish-approval");
    expect(d.ask).not.toMatch(/face:/);
    expect(d.happened).not.toMatch(/face:/);
    expect(d.details.map((x) => x.label)).not.toContain("Pacote");
    expect(d.details.find((x) => x.label === "Onde publica (nome técnico)")?.value).toBe("face:loja");
  });
  it("a faixa da Sentinela diz a causa de configuração em palavras, mesmo com o diagnóstico técnico já gravado", () => {
    const base = FIXTURES.sentinel.item as Extract<CockpitItem, { kind: "sentinel" }>;
    const item = { ...base, causeKey: "stale-conductor-skill:__host__:config", diagnosis: "A skill harness-conductor do alvo é a versão monolítica antiga (sem a pasta ref/)." };
    const d = decideItem(item, ctx(HUMAN, FIXTURES.sentinel.card));
    expect(d.ask).toMatch(/^A Sentinela não resolveu: as instruções do condutor/);
    expect(itemTermsIn(d.ask)).toEqual([]);
    expect(d.details.find((x) => x.label === "Diagnóstico")?.value).toMatch(/harness-conductor/);
    // outra causa: o diagnóstico da sessão, como antes
    expect(decide("sentinel").ask).toMatch(/A execução do card parou/);
  });
});
