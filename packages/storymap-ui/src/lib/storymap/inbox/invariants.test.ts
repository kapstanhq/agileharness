// As PROPRIEDADES do contrato do Inbox (contract.ts) — sobre as MESMAS fixtures do modelo (items.fixture.ts), nos quatro
// modos de board, com as variantes que já mentiram no ar: a publicação que pediu alguém com e sem causa, a prova
// que o sistema produz, a pergunta que o procurador responde, o «não há trabalho» repetido, o pedido de agente que já
// aconteceu. Cada propriedade nomeia o caso real que ela impede de voltar.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BoardConfig, Card, CardQuestion, DeployCause, Finding } from "../types";
import type { CockpitItem, CockpitItemKind } from "../demands";
import { cardCockpitItems, DEPLOY_FAILURE_FINDING_ID } from "../demands";
import { ownerTitleOf } from "../runner/deploy-blocks";
import { MONEY_CLASS, ownerClassLabel } from "../owner-classes";
import { undoRefusal, type FollowUpItem } from "../system-decisions";
import { decideItem } from "./decision";
import { changesOutcome, emptyFacts, itemCauseKey, itemLiveness, KIND_CONTRACT, REVIEW_TTL_DAYS, type InboxFacts } from "./contract";
import { foldByCause, INBOX_PRECEDENCE, inboxSections, settleItems, type InboxEntry } from "./entries";
import { formatDecisionText, itemTermsIn, localTimeFormatter } from "./copy";
import { systemDecisionEntry } from "./system-entries";
import { cardInboxSignal } from "./card-signal";
import { ownerDecisionsFromEntries } from "./decidir-set";
import { inboxFactsOf, readDeployLedger } from "./collect";
import { FIXTURES, HUMAN, HUMAN_JIDO, KINDS, MODES, NOW, ULTRA, ULTRA_JIDO, ctx, mkCard, mkItem } from "./items.fixture";

const ULTRA_MODES = MODES.filter(([, c]) => c === ULTRA || c === ULTRA_JIDO);

/** As variantes de cada kind que já mentiram no ar — somadas ao fixture base. */
const VARIANTS: Array<{ name: string; item: CockpitItem; card: Card }> = [
  ...KINDS.map((k) => ({ name: k, item: FIXTURES[k].item, card: FIXTURES[k].card })),
  { name: "deploy-failed/pede alguém", item: { ...FIXTURES["deploy-failed"].item, needsHuman: true } as CockpitItem, card: FIXTURES["deploy-failed"].card },
  { name: "deploy-failed/prova", item: { ...FIXTURES["deploy-failed"].item, needsProof: true } as CockpitItem, card: FIXTURES["deploy-failed"].card },
  { name: "question/procurador", item: { ...FIXTURES.question.item, awaitingProxy: true } as CockpitItem, card: FIXTURES.question.card },
  { name: "question/técnica", item: { ...FIXTURES.question.item, category: "technical" } as CockpitItem, card: FIXTURES.question.card },
  { name: "stuck/não há trabalho", item: { ...FIXTURES.stuck.item, outcome: "no-op", reason: "no-op" } as CockpitItem, card: FIXTURES.stuck.card },
  { name: "conflict/gate", item: { ...FIXTURES.conflict.item, conflictKind: "merge-gate-failed" } as CockpitItem, card: FIXTURES.conflict.card },
  // fase 3 — o card conduzido que ninguém assumiu e o pedido de publicação que ainda espera (não bloqueado)
  { name: "stalled/conduzido", item: { ...FIXTURES.stalled.item, conducted: true } as CockpitItem, card: { ...FIXTURES.stalled.card, routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-28", driver: "conductor" } } as Card },
  { name: "publish-held/esperando", item: { ...FIXTURES["publish-held"].item, blocked: false } as CockpitItem, card: FIXTURES["publish-held"].card },
];

/** Os pontos de parada ESTRUTURAIS — o dono decide por eles sem classe nomeada (decision-class.ts, o invariante do WP1):
 *  a captura dele, a pergunta que o autor/o procurador/o [humano] pôs com ele, a tela que ele pediu, a trava do núcleo. */
// `locked-exec`: um comando que a trava proíbe a agentes só roda com o clique do dono — estrutural, em qualquer modo.
// fase 3 — as alavancas do OPERADOR (as actions recusam qualquer outro chamador): publicar por cima da guarda ou cancelar,
// publicar o que espera num board manual. Parar o condutor de um card que ninguém assumiu também é do operador — mas
// SÓ o card conduzido: o kind `stalled` inteiro NÃO é estrutural (um parado comum em Decidir sem classe é regressão).
const STRUCTURAL: ReadonlySet<CockpitItemKind> = new Set(["proposal", "question", "design", "approval", "locked-exec", "publish-held", "stage-idle"]);
/** O ponto estrutural por ITEM: os kinds acima, ou o parado CONDUZIDO (a alavanca do operador sobre o condutor). */
const structural = (item: CockpitItem): boolean => STRUCTURAL.has(item.kind) || (item.kind === "stalled" && Boolean((item as { conducted?: boolean }).conducted));

describe("P1 — Decidir ⇒ ao menos uma opção que MUDA o desfecho (conversa, leitura e passo a passo não contam)", () => {
  it.each(MODES)("modo %s", (_m, config) => {
    for (const v of VARIANTS) {
      const d = decideItem(v.item, ctx(config, v.card));
      if (d.bucket !== "decidir") continue;
      expect(d.options.some(changesOutcome), v.name).toBe(true);
    }
  });
});

describe("P2 — só-negócio: Decidir ⇒ uma classe do dono nomeada ou um ponto estrutural", () => {
  it.each(ULTRA_MODES)("modo %s", (_m, config) => {
    for (const v of VARIANTS) {
      const d = decideItem(v.item, ctx(config, v.card));
      if (d.bucket !== "decidir") continue;
      expect(d.verdict.decider, v.name).toBe("owner");
      expect(Boolean(d.verdict.ownerClass) || structural(v.item), `${v.name}: ${d.verdict.reason}`).toBe(true);
    }
  });
});

// ── a causa ───────────────────────────────────────────────────────────────────────────────────────────────

const CAUSE: DeployCause = { pkg: "app", phase: "needs-human", units: ["api"], rules: ["paid-api"], ownerClass: "money", decider: "owner", causeKey: "app:owner:money", attributedCardIds: ["pay"] };
const deployFinding = (cause: DeployCause | null): Finding =>
  ({ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: ownerTitleOf(ownerClassLabel(MONEY_CLASS, null)), deployPhase: cause?.phase ?? "needs-human", ...(cause ? { deployCause: cause } : {}) }) as Finding;
/** Quatro cards em Liberar segurados pela MESMA causa de dinheiro, e o card que a carrega parado em «Aprovar entrega». */
const victims = ["v1", "v2", "v3", "v4"].map((id) => mkCard({ id, title: `Vítima ${id}`, status: "release", findings: [deployFinding(CAUSE)] }));
const payer = mkCard({ id: "pay", title: "Enviar lembrete de renovação por SMS", status: "revisao", reviewedAt: "2026-09-28", qaPassed: true, businessClasses: { ids: ["money"], reason: "cada SMS enviado tem custo por mensagem" } } as Partial<Card>);
const causeFacts = (cards: Card[], over: Partial<InboxFacts> = {}): InboxFacts => {
  const base = emptyFacts(cards);
  const deployCauseOf = new Map(cards.flatMap((c) => {
    const cause = c.findings?.find((f) => f.id === DEPLOY_FAILURE_FINDING_ID)?.deployCause;
    return cause ? [[c.id, cause] as const] : [];
  }));
  return { ...base, deployCauseOf, deployLedger: new Set([CAUSE.causeKey]), deployAnchor: new Map([[CAUSE.causeKey, "pay"]]), ...over };
};
const boardItems = (cards: Card[], config = ULTRA) => cards.flatMap((c) => cardCockpitItems(c, config, "b1", { now: NOW }));
const settle = (cards: Card[], facts: InboxFacts | undefined, config = ULTRA, items = boardItems(cards, config)) =>
  settleItems(items, { boardId: "b1", boardName: "Board", config, cardsById: new Map(cards.map((c) => [c.id, c])), now: NOW, ...(facts ? { facts } : {}) });
/** Os fatos como o coletor os monta: as causas, o livro, a âncora — e o item de aprovação de cada card (`gateOf`). */
const boardFacts = (cards: Card[], config: BoardConfig, items = boardItems(cards, config)) =>
  causeFacts(cards, { gateOf: new Map(items.filter((i) => i.kind === "gate").map((i) => [i.cardId, i])) });
/** O Inbox de um board inteiro (os itens que o card dá, os fatos do coletor), dobrado e em seções. */
const board = (cards: Card[], config: BoardConfig, items = boardItems(cards, config)) => {
  const folded = foldByCause(settle(cards, boardFacts(cards, config, items), config, items).entries);
  return { folded, ...inboxSections(folded) };
};
const payerAt = (status: string) => ({ ...payer, status });
/** «Liberar» automático — um board de produto típico: de «Integrar» em diante, o card anda sozinho até o ar. */
const AUTO_RELEASE = { ...ULTRA, statuses: ULTRA.statuses.map((s) => (s.id === "release" ? { ...s, autorun: true } : s)) } as BoardConfig;

describe("P3 — mesma causa ⇒ no máximo UMA entrada em Decidir (a dobra por causa)", () => {
  // REESCRITO de propósito (revisão do WP3): a versão anterior exigia UMA entrada em Decidir em TODO modo — no
  // board humano com o Jido, o gate do card âncora ia para o Jido e a publicação parada das vítimas virava a
  // entrada de Decidir com o MESMO «Mandar para…» do card âncora, apostando corrida com o Jido que já o tinha pego. Agora
  // a causa só mora em Decidir quando o passo do card âncora é do dono (o item de aprovação dele está em Decidir).
  it("o código de envio pago que segura 4 cards é UMA decisão — a do card que o carrega, com os 4 como facetas", () => {
    for (const [mode, config] of MODES) {
      const cards = [...victims, payer];
      const { decidir, acompanhar } = board(cards, config);
      const ofCause = decidir.filter((e) => e.causeKey === "card:pay");
      if (config === HUMAN_JIDO) {
        // o Jido pegou o passo do card âncora: a causa inteira é UMA linha de Acompanhar, com o Jido cuidando
        expect(ofCause, mode).toEqual([]);
        const followed = acompanhar.filter((e) => e.causeKey === "card:pay");
        expect(followed, mode).toHaveLength(1);
        expect(followed[0].decision.next.who, mode).toBe("jido");
        continue;
      }
      expect(ofCause, mode).toHaveLength(1);
      // a ação é sempre o passo do card que carrega o código — e quem lidera a entrada é o PRÓPRIO card âncora
      expect(ofCause[0].cardId, mode).toBe("pay");
      expect(ofCause[0].decision.options[0].invoke, mode).toMatchObject({ kind: "move-card", cardId: "pay" });
      const cardsInEntry = new Set([ofCause[0].cardId, ...ofCause[0].facets.map((f) => f.cardId)]);
      for (const v of victims) expect(cardsInEntry.has(v.id), `${mode}: ${v.id}`).toBe(true);
    }
  });

  it("modo humano com «Liberar» manual: o card âncora e as 4 vítimas são EXATAMENTE 1 entrada em Decidir — nenhum «Publicar «Vítima…»?»", () => {
    // Caso da revisão: cada vítima parada em «Liberar» trazia o próprio «Publicar «Vítima» em produção?», com o
    // botão vermelho que publicaria de novo o que a MESMA causa de dinheiro para de novo — várias entradas para uma causa.
    const { decidir } = board([...victims, payer], HUMAN);
    expect(decidir.map((e) => `${e.kind}/${e.cardId}`)).toEqual(["gate/pay"]);
    const facetCards = new Set(decidir[0].facets.map((f) => f.cardId));
    for (const v of victims) expect(facetCards.has(v.id), v.id).toBe(true);
    // e o push de uma vítima sozinha (o sinal do card, sem os fatos do board) não dispara
    expect(cardInboxSignal(victims[0], HUMAN, "b1", { now: NOW })).toBeNull();
  });

  it("o card âncora que JÁ passou da aprovação e também está parado: o «Publicar» dele não volta a ser pedido", () => {
    const held = { ...payerAt("release"), findings: [deployFinding(CAUSE)] } as Card;
    for (const [mode, config] of MODES) {
      const { decidir, acompanhar } = board([...victims, held], config);
      expect(decidir, mode).toEqual([]);
      const cause = acompanhar.filter((e) => e.causeKey === "card:pay");
      expect(cause, mode).toHaveLength(1);
      expect(cause[0].decision.happened, mode).toMatch(/Você já aprovou/);
      expect(cause[0].decision.next, mode).toMatchObject({ who: "ninguem", stalled: true });
    }
  });

  it.each(["merge", "stage", "enriquecer", "refinar"])("o card âncora num passo que o SISTEMA conduz (%s): a causa tem 0 entradas em Decidir, em todo modo", (status) => {
    for (const [mode, config] of MODES) {
      const { decidir, acompanhar } = board([...victims, payerAt(status)], config);
      // nenhuma entrada de Decidir pede para mover o card âncora (era «Mandar «…» para «Homologar»?» na vítima)
      expect(decidir.map((e) => `${e.kind}/${e.cardId}: ${e.decision.ask}`), mode).toEqual([]);
      const cause = acompanhar.filter((e) => e.causeKey === "card:pay");
      expect(cause, mode).toHaveLength(1);
      expect(cause[0].decision.options, mode).toEqual([]);
      // quem leva o card adiante, dito com honestidade: o pipeline — não «espera você»
      expect(cause[0].decision.next.who, mode).toBe("sistema");
    }
  });

  it("aprovou em «Aprovar entrega», o card âncora entrou em «Integrar» e anda sozinho até o ar: a MESMA pergunta não volta", () => {
    // O fluxo da revisão, num board como o de produto (só-negócio, «Liberar» automático): o dono aprova
    // «Aprovar e publicar «…»?», o card entra em Integrar — e na coleta seguinte o Decidir mostrava a pergunta idêntica,
    // agora liderada por uma vítima, com o botão movendo o card âncora para «Homologar» por cima da integração.
    const before = board([...victims, payerAt("revisao")], AUTO_RELEASE).decidir;
    expect(before.map((e) => `${e.kind}/${e.cardId}`)).toEqual(["gate/pay"]);
    expect(before[0].decision.ask).toMatch(/^Aprovar e publicar/);
    const after = board([...victims, payerAt("merge")], AUTO_RELEASE);
    expect(after.decidir).toEqual([]);
    const cause = after.acompanhar.filter((e) => e.causeKey === "card:pay");
    expect(cause).toHaveLength(1);
    expect(cause[0].decision.happened).toMatch(/Você já aprovou/);
    expect(cause[0].decision.next).toMatchObject({ who: "ninguem", stalled: true });
  });

  it("o Jido desistiu do passo do card âncora (o recuo que o coletor marca no item): a decisão volta para Decidir, uma vez só", () => {
    const cards = [...victims, payer];
    const items = boardItems(cards, HUMAN_JIDO).map((i) => (i.kind === "gate" && i.cardId === "pay" ? ({ ...i, copilotBackoff: { streak: 3 } } as CockpitItem) : i));
    const { decidir } = board(cards, HUMAN_JIDO, items);
    expect(decidir.map((e) => `${e.kind}/${e.cardId}`)).toEqual(["gate/pay"]);
    expect(new Set(decidir[0].facets.map((f) => f.cardId))).toEqual(new Set(victims.map((v) => v.id)));
  });

  it("nenhum botão de card move OUTRO card (a raia do dono no Kanban)", () => {
    for (const status of ["revisao", "merge", "stage", "enriquecer", "refinar", "release"]) {
      for (const [mode, config] of [...MODES, ["só-negócio, «Liberar» automático", AUTO_RELEASE] as [string, BoardConfig]]) {
        const { folded } = board([...victims, payerAt(status)], config);
        for (const c of ownerDecisionsFromEntries(folded, "b1").cards) {
          const target = (c.primary?.invoke as { cardId?: string } | undefined)?.cardId;
          expect(target === undefined || target === c.cardId, `${status}/${mode}: o botão de ${c.cardId} move ${target}`).toBe(true);
        }
      }
    }
    // e mesmo uma entrada montada à mão, liderada pela vítima, com a principal movendo o card âncora: sem botão no card
    const [lead] = board([...victims, payer], ULTRA).decidir;
    const onVictim = { ...lead, cardId: "v1", itemId: "v1:deploy-failed", key: "b1/v1:deploy-failed", facets: [] };
    expect(ownerDecisionsFromEntries([onVictim], "b1").cards[0]).toMatchObject({ cardId: "v1", primary: null });
  });

  it("para qualquer mistura de itens e causas, cada causa tem no máximo uma entrada por seção", () => {
    const cards = [...victims, payer];
    const facts = causeFacts(cards);
    const all = boardItems(cards);
    for (let mask = 1; mask < 1 << all.length; mask += 13) {
      const items = all.filter((_, i) => mask & (1 << i));
      for (const [, config] of MODES) {
        const folded = foldByCause(settle(cards, facts, config, items).entries);
        const keys = folded.map((e) => `${e.decision.bucket}|${e.causeKey}`);
        expect(new Set(keys).size).toBe(keys.length);
      }
    }
  });
});

describe("P4 — mudou o fato, a entrada sai (com recibo), sem ninguém clicar", () => {
  it("a causa saiu do livro de causas ⇒ o aviso de publicação sai; sem livro, ninguém julga", () => {
    const cards = [victims[0], payer];
    const gone = settle(cards, causeFacts(cards, { deployLedger: new Set() }));
    expect(gone.entries.some((e) => e.kind === "deploy-failed")).toBe(false);
    expect(gone.retired.map((r) => r.item.cardId)).toEqual(["v1"]);
    expect(gone.retired[0].liveness.who).toBe("sistema");
    const noLedger = settle(cards, causeFacts(cards, { deployLedger: null }));
    expect(noLedger.entries.some((e) => e.kind === "deploy-failed")).toBe(true);
  });

  describe("o livro ILEGÍVEL não é o livro vazio (fail-closed)", () => {
    // Caso da revisão: o leitor tolerante do livro devolve [] para JSON quebrado, versão desconhecida (a
    // ferramenta voltou de versão depois de uma mais nova gravar o arquivo) ou `rows` que não é lista — e o coletor lia
    // isso como «livro vazio»: TODA causa gravada «saiu do registro», inclusive a de dinheiro do dono, com um recibo
    // falso em «Resolvido hoje» dizendo que o sistema publica de novo.
    let dir = "";
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "inbox-ledger-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const row = { board: "b1", causeKey: CAUSE.causeKey, pkg: "app", phase: "needs-human", decider: "owner", ownerClass: "money", units: ["api"], rules: ["paid-api"], command: null, firstAt: "2026-09-28T17:00:00Z", lastAt: "2026-09-28T17:00:00Z", cardIds: ["v1"], planHead: null, attributedCard: "pay" };
    const ledgerFrom = async (name: string, raw: string | null) => {
      const file = path.join(dir, name);
      if (raw !== null) await writeFile(file, raw, "utf8");
      return readDeployLedger(file);
    };
    const itemOf = (card: Card) => cardCockpitItems(card, ULTRA, "b1", { now: NOW }).find((i) => i.kind === "deploy-failed")!;

    it.each([
      ["versão desconhecida", JSON.stringify({ version: 2, rows: [row] })],
      ["arquivo cortado", JSON.stringify({ version: 1, rows: [row] }).slice(0, 90)],
      ["`rows` que não é lista", JSON.stringify({ version: 1, rows: { a: row } })],
      ["uma linha ilegível", JSON.stringify({ version: 1, rows: [row, { board: "b1" }] })],
      ["arquivo ausente", null],
    ])("%s ⇒ sem livro: a causa viva fica viva", async (_name, raw) => {
      const ledger = await ledgerFrom(`l-${_name.replace(/\W+/g, "-")}.json`, raw);
      expect(ledger).toBeNull();
      const facts = inboxFactsOf({ boardId: "b1", config: ULTRA, cards: [victims[0]], ledger });
      expect(itemLiveness(itemOf(victims[0]), facts, NOW)).toEqual({ alive: true });
    });

    it("o livro legível e VAZIO ainda julga: a causa que saiu dele sai do Inbox", async () => {
      expect(await ledgerFrom("ok.json", JSON.stringify({ version: 1, rows: [row] }))).toHaveLength(1);
      const empty = await ledgerFrom("empty.json", JSON.stringify({ version: 1, rows: [] }));
      expect(empty).toEqual([]);
      const facts = inboxFactsOf({ boardId: "b1", config: ULTRA, cards: [victims[0]], ledger: empty });
      expect(itemLiveness(itemOf(victims[0]), facts, NOW)).toMatchObject({ alive: false, who: "sistema" });
    });
  });

  it("o aviso ANTIGO, sem causa gravada, nunca é julgado pelo livro (a varredura ainda vai completá-lo)", () => {
    const legacy = mkCard({ id: "old", status: "release", findings: [deployFinding(null)] });
    const out = settle([legacy], { ...causeFacts([legacy]), deployLedger: new Set() });
    expect(out.retired).toEqual([]);
  });

  it("o pedido do agente cuja ação já aconteceu (o dono rodou o agente pelo Inbox depois) sai, com o porquê", () => {
    const item = { ...FIXTURES.approval.item, tool: "run_skill", args: JSON.stringify({ cardId: "c1" }), requestedAt: "2026-09-28T14:05:00Z", since: "2026-09-28T14:05:00Z" } as CockpitItem;
    const facts = { ...emptyFacts([FIXTURES.approval.card]), actions: [{ at: "2026-09-28T17:50:00Z", tool: "runCardSkillAction", actor: "human:inbox", note: "card=c1 · stuck:retry" }] };
    const l = itemLiveness(item, facts, NOW);
    expect(l.alive).toBe(false);
    expect(l.alive === false && l.why).toMatch(/a mesma ação já aconteceu/);
    // a ação ANTES do pedido não conta
    expect(itemLiveness(item, { ...facts, actions: [{ ...facts.actions[0], at: "2026-09-28T10:00:00Z" }] }, NOW).alive).toBe(true);
    // e o próprio PEDIDO, gravado no registro 20 ms depois de nascer (outcome «pending»), nunca é «a ação aconteceu»
    const own = { at: "2026-09-28T14:05:00.020Z", tool: "run_skill", cardId: "c1", actor: "AGILEHARNESS_MCP_TOKEN_ORCH", outcome: "pending" };
    expect(itemLiveness(item, { ...facts, actions: [own] }, NOW).alive).toBe(true);
  });

  it("o pedido que dependia da posição do card perde a premissa quando o card muda de passo depois dele", () => {
    const item = { ...FIXTURES.approval.item, requestedAt: "2026-09-28T16:00:00Z" } as CockpitItem; // move_card
    expect(itemLiveness(item, { ...emptyFacts(), lastTransitionAt: new Map([["c1", "2026-09-28T17:00:00Z"]]) }, NOW).alive).toBe(false);
    expect(itemLiveness(item, { ...emptyFacts(), lastTransitionAt: new Map([["c1", "2026-09-28T15:00:00Z"]]) }, NOW).alive).toBe(true);
  });

  it("o card andou ⇒ o item do passo dele some (o coletor deixa de emiti-lo — o contrato não precisa julgar)", () => {
    const at = mkCard({ status: "release", stagedAt: "2026-09-20", reviewedAt: "2026-09-19" });
    expect(cardCockpitItems(at, HUMAN, "b1", { now: NOW }).some((i) => i.kind === "gate")).toBe(true);
    expect(cardCockpitItems({ ...at, status: "concluida" }, HUMAN, "b1", { now: NOW }).some((i) => i.kind === "gate")).toBe(false);
  });

  it(`a amostra de entrega passa de ${REVIEW_TTL_DAYS} dias ⇒ vai para o registro, com o recibo do prazo`, () => {
    const old = { ...FIXTURES["delivery-audit"].item, sampledAt: "2026-09-20", since: "2026-09-20" } as CockpitItem;
    const l = itemLiveness(old, undefined, NOW);
    expect(l).toMatchObject({ alive: false, who: "prazo" });
    expect(itemLiveness(FIXTURES["delivery-audit"].item, undefined, NOW).alive).toBe(true);
  });
});

describe("P5 — o «Desfazer» de uma decisão do sistema vem bloqueado ⇔ o servidor o recusaria", () => {
  const sd = (over: Partial<FollowUpItem>): FollowUpItem => ({
    v: 1,
    id: "sd-1",
    at: "2026-09-26T10:00:00Z",
    board: "b1",
    cardId: "c1",
    agent: "triage-judge",
    kind: "triage-accept",
    what: "Aceitou na triagem: «Convite»",
    why: "o PRD pede",
    undo: { kind: "return-to-triage", cardId: "c1", from: "interview" },
    undoable: true,
    ...over,
  });
  const cases: Array<[string, FollowUpItem, Card | undefined]> = [
    ["o card não andou", sd({}), mkCard({ status: "interview" })],
    ["o card andou", sd({}), mkCard({ status: "desenvolver" })],
    ["o card sumiu", sd({}), undefined],
    ["a pergunta segue respondida pelo procurador", sd({ kind: "proxy-answer", undo: { kind: "reopen-question", cardId: "c1", questionId: "q1" } }), mkCard({ questions: [{ id: "q1", text: "?", status: "answered", answeredBy: "proxy" } as CardQuestion] })],
    ["a pergunta já foi mexida", sd({ kind: "proxy-answer", undo: { kind: "reopen-question", cardId: "c1", questionId: "q1" } }), mkCard({ questions: [{ id: "q1", text: "?", status: "open" } as CardQuestion] })],
    ["a entrega ainda no ar (o motivo vem no clique)", sd({ kind: "delivery-skip", undo: { kind: "reopen-card", cardId: "c1", deliveredIn: "concluida" } }), mkCard({ status: "concluida" })],
  ];
  it.each(cases)("%s", (_name, d, card) => {
    const option = systemDecisionEntry(d, { boardId: "b1", boardName: "B", config: HUMAN, card }).decision.options[0];
    const refusal = undoRefusal(d, { config: HUMAN, card: card ?? null, undone: false, note: "motivo" });
    expect(Boolean(option.disabled)).toBe(refusal !== null);
    if (refusal) expect(option.disabled!.reason).toBe(refusal);
  });
});

describe("P7 — a pergunta técnica com dinheiro só no CONTEXTO não é do dono (o piso do WP1 chega ao Inbox)", () => {
  it.each(ULTRA_MODES)("modo %s", (_m, config) => {
    const q = { id: "q1", text: "Rodo mais uma volta de revisão antes de integrar o cupom?", context: "Gasto até aqui: ~US$ 14 de 40; o preço do livro passa a aparecer em duas linhas no cartão da estante.", category: "technical", status: "open" } as CardQuestion;
    const card = mkCard({ status: "desenvolver", questions: [q] });
    const [item] = cardCockpitItems(card, config, "b1", { now: NOW }).filter((i) => i.kind === "question");
    expect(decideItem(item, ctx(config, card)).bucket).toBe("acompanhar");
    // e a mesma palavra no TEXTO segue do dono
    const money = { ...q, text: "Qual fornecedor de SMS contratar?" };
    const card2 = mkCard({ status: "desenvolver", questions: [money] });
    const [item2] = cardCockpitItems(card2, config, "b1", { now: NOW }).filter((i) => i.kind === "question");
    expect(decideItem(item2, ctx(config, card2)).bucket).toBe("decidir");
  });
});

describe("P8 — o contrato é exaustivo: todo kind declara a causa e quando ela deixa de ser verdade", () => {
  it("KIND_CONTRACT tem cada kind do Inbox, uma vez", () => {
    expect(Object.keys(KIND_CONTRACT).sort()).toEqual([...INBOX_PRECEDENCE].sort());
  });
  it("cada fixture tem uma causa não vazia e, sem fatos, está viva (quem não tem o fato não julga)", () => {
    for (const kind of KINDS) {
      expect(itemCauseKey(FIXTURES[kind].item).length, kind).toBeGreaterThan(0);
      expect(itemLiveness(FIXTURES[kind].item, undefined, Date.parse("2026-09-28T20:00:00Z")).alive, kind).toBe(true);
    }
  });
});

describe("o texto que o dono lê — uma linha, sem hash, CLS, commit, worktree, tmux ou etapa", () => {
  it.each(MODES)("modo %s", (_m, config) => {
    for (const v of VARIANTS) {
      const d = decideItem(v.item, ctx(config, v.card));
      const fmt = localTimeFormatter(NOW, "America/Chicago");
      const shown = formatDecisionText(d.ask, fmt);
      expect(shown.length, `${v.name}: ${shown}`).toBeLessThanOrEqual(140);
      expect(itemTermsIn(`${shown}\n${formatDecisionText(d.happened, fmt)}`).map((t) => t.id), `${v.name}: ${shown}`).toEqual([]);
    }
  });

  it("a pergunta longa do agente vira uma linha, e a inteira mora em Detalhes", () => {
    const long = `Posso reescrever ${"o teste de frete que ainda fixa a regra antiga do cupom ".repeat(6)}?`;
    const d = decideItem({ ...FIXTURES.question.item, prompt: long } as CockpitItem, ctx(HUMAN, FIXTURES.question.card));
    expect(d.ask.length).toBeLessThanOrEqual(140);
    expect(d.details.find((x) => x.label === "Pergunta inteira")?.value).toBe(long);
  });
});

describe("o card de uma decisão — a entrada do Inbox e o resumo de negócio", () => {
  it("o card que carrega o código de dinheiro diz por que é do dono, quantos cards esperam e os riscos abertos", () => {
    const risky = { ...payer, findings: [{ id: "r1", lens: "security", severity: "medium", status: "open", title: "Envio sem limite de frequência" } as Finding] };
    const cards = [...victims, risky];
    const { entries } = settle(cards, causeFacts(cards));
    const lead = foldByCause(entries).find((e) => e.cardId === "pay" && e.decision.bucket === "decidir")!;
    expect(lead.decision.happened).toMatch(/Dinheiro e preço/);
    expect(lead.decision.happened).toMatch(/4 outros cards esperam/);
    expect(lead.decision.happened).toMatch(/1 risco aberto/);
    expect(lead.decision.details.some((x) => x.label === "Cards que esperam esta decisão")).toBe(true);
  });

  it("sem o card âncora (a causa de dinheiro sem card atribuído), nada daqui decide: Acompanhar, contado como parado", () => {
    const cards = [...victims];
    const { entries } = settle(cards, causeFacts(cards, { deployAnchor: new Map() }));
    const folded: InboxEntry[] = foldByCause(entries);
    expect(folded.filter((e) => e.decision.bucket === "decidir")).toEqual([]);
    const cause = folded.filter((e) => e.kind === "deploy-failed");
    expect(cause).toHaveLength(1);
    expect(cause[0].decision.next).toMatchObject({ who: "ninguem", stalled: true });
    expect(cause[0].decision.ask).toMatch(/afeta 4 cards/);
  });
});
