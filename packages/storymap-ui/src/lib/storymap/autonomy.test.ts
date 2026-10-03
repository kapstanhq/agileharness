// The AUTONOMY KEY — the pure answers. Every case is one row of the owner's table held in code:
//   human ⇒ nothing is proxied; ultra ⇒ only interview/ui-choice; money NEVER (category or floor); a story's own
//   mode beats the board's; the writer re-checks on the FRESH card; the audit sample is deterministic.

import { describe, expect, it } from "vitest";
import {
  applyProxyAnswers,
  auditDraw,
  defaultQuestionCategory,
  effectiveAutonomy,
  isOwnerOnlyQuestion,
  isPendingProxyAudit,
  markProxyDeclined,
  ownerOnlyOpenQuestions,
  proxiableQuestions,
  proxyRefusal,
  proxySettings,
  relaxedMoneyFloorMatch,
  resolveProxyAudit,
  shouldAuditProxyAnswer,
} from "./autonomy";
import type { BoardConfig, CardQuestion } from "./types";

const ultra = { autonomy: { mode: "ultra" as const } } satisfies Pick<BoardConfig, "autonomy">;
const human = { autonomy: { mode: "human" as const } } satisfies Pick<BoardConfig, "autonomy">;
const none = {} satisfies Pick<BoardConfig, "autonomy">;

const q = (id: string, extra: Partial<CardQuestion> = {}): CardQuestion => ({ id, text: `pergunta ${id}`, status: "open", ...extra });

describe("effectiveAutonomy — a exceção da story vence o board; ausente é human", () => {
  it("precedência card > board > default", () => {
    expect(effectiveAutonomy({}, none)).toEqual({ mode: "human", source: "default" });
    expect(effectiveAutonomy({}, ultra)).toEqual({ mode: "ultra", source: "board" });
    expect(effectiveAutonomy({ autonomyMode: "human" }, ultra)).toEqual({ mode: "human", source: "card" });
    expect(effectiveAutonomy({ autonomyMode: "ultra" }, human)).toEqual({ mode: "ultra", source: "card" });
    expect(effectiveAutonomy(null, null)).toEqual({ mode: "human", source: "default" });
  });

  it("proxySettings: sonnet e 0,2 por default; a taxa é presa em [0,1]", () => {
    expect(proxySettings(none)).toEqual({ model: "sonnet", auditSampleRate: 0.2, technicalAuditSampleRate: 0.2 });
    expect(proxySettings({ autonomy: { mode: "ultra", proxyModel: "opus", auditSampleRate: 3, technicalAuditSampleRate: -1 } })).toEqual({
      model: "opus",
      auditSampleRate: 1,
      technicalAuditSampleRate: 0,
    });
  });
});

describe("dinheiro NUNCA vai ao proxy — a categoria do autor, e um piso determinístico", () => {
  it("categoria money é do dono", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "money" }))).toBe(true);
  });

  it("o piso: marcador [humano] e palavras de preço/fornecedor/gasto NO TEXTO, mesmo com categoria interview", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", context: "[humano] muda o PRD" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "technical", text: "[humano] Publico o código de pagamento?" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "Qual o preço do plano?" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "Trocamos de fornecedor de SMS?" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "technical", text: "Qual fornecedor de SMS?" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "Which vendor should we use?" }))).toBe(true);
  });

  // CONTRATO MUDADO DE PROPÓSITO. Antes: `ui-choice` + contexto «aumenta o gasto mensal» ⇒ do dono — o
  // piso lia a NARRATIVA e passava por cima da categoria do autor. Agora o contexto só pesa quando ninguém declarou a
  // categoria (o legado de texto livre); com categoria declarada, só o texto da pergunta (o que se decide) conta.
  it("sem categoria (texto livre, legado): o piso ainda lê o contexto", () => {
    expect(isOwnerOnlyQuestion(q("a", { context: "aumenta o gasto mensal" }))).toBe(true);
    expect(isOwnerOnlyQuestion(q("a", { text: "Seguimos?", context: "o preço sobe para a primeira linha" }))).toBe(true);
  });

  it("com categoria declarada não-dinheiro: palavra de dinheiro SÓ no contexto não acende o piso", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "ui-choice", context: "aumenta o gasto mensal" }))).toBe(false);
    expect(isOwnerOnlyQuestion(q("a", { category: "technical", text: "Faço um ciclo extra?", context: "Gasto até aqui: ~US$ 7" }))).toBe(false);
  });

  it("costUsd é dado do card-budget: o piso nunca o lê", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "technical", text: "Faço um ciclo extra?", costUsd: 12 }))).toBe(false);
  });

  it("uma pergunta de produto comum não é tocada pelo piso", () => {
    expect(isOwnerOnlyQuestion(q("a", { category: "interview", text: "A leitora quer filtrar por gênero?" }))).toBe(false);
  });
});

// Perguntas de protocolo técnico ou de tela, declaradas não-dinheiro pelo autor, em que o contexto cita DE PASSAGEM uma
// palavra do piso de dinheiro. O texto é de exemplo (uma lavanderia self-service fictícia); o que cada caso exercita é
// qual palavra do piso casava e em que campo ela estava.
describe("regressão do piso de dinheiro — perguntas técnicas com palavra do piso só no contexto", () => {
  const MOLDE: Array<[string, Partial<CardQuestion>]> = [
    [
      "política de nova tentativa, com «fornecedor» e «vendor» no contexto",
      {
        category: "technical",
        askedBy: "harness-conductor",
        text: "A leitura do sensor de umidade da secadora falha de vez em quando. Subo as tentativas de 3 para 5 ou deixo como está?",
        context: "O fornecedor do sensor documenta o timeout (vendor note, p. 12); o ponto aberto é só o intervalo entre tentativas.",
      },
    ],
    [
      "escolha entre três layouts, com «plano pago» no contexto",
      {
        category: "ui-choice",
        askedBy: "harness-conductor",
        text: "Dos três layouts do painel das secadoras, qual vai para o balcão de atendimento?",
        context: "Os layouts só diferem no tamanho da fonte do tempo restante; o plano pago do app de pagamento não aparece em nenhum deles.",
      },
    ],
    [
      "divisão da entrega, com «budget» no contexto",
      {
        category: "delivery",
        askedBy: "harness-conductor",
        text: "Posso entregar o parser de fichas e a tela de filtros em dois pedidos de integração separados?",
        context: "O budget do card não muda com a divisão; a ordem de merge é que importa.",
      },
    ],
    [
      "pergunta de entrevista, com «pricing» no contexto",
      {
        category: "interview",
        askedBy: "harness-conductor",
        text: "A atendente consegue marcar uma máquina como «em manutenção» sem sair da tela da fila?",
        context: "O pricing do ciclo longo aparece na tela só como leitura; nada é alterado ali.",
      },
    ],
    [
      "formato de data, com «billing» no contexto",
      {
        category: "technical",
        askedBy: "harness-conductor",
        text: "O recibo deve exibir a data como dd/mm ou como dia da semana?",
        context: "A tela de billing já usa dd/mm; aqui só se decide o recibo impresso.",
      },
    ],
  ];

  it.each(MOLDE)("%s ⇒ NÃO é do dono pelo piso, e vai ao proxy em ultra", (_label, over) => {
    const question = q("qx", over);
    expect(isOwnerOnlyQuestion(question)).toBe(false);
    expect(proxyRefusal(question, {}, ultra)).toBeNull();
  });

  it("a mesma pergunta SEM categoria (o legado) continua do dono — o contexto ainda pesa ali", () => {
    const [, over] = MOLDE[0];
    expect(isOwnerOnlyQuestion(q("qx", { text: over.text, context: over.context }))).toBe(true);
  });

  it("propriedade: toda palavra do piso no CONTEXTO de uma pergunta com categoria declarada não-dinheiro ⇒ proxiável", () => {
    const words = ["preço", "preços", "pricing", "price", "fornecedor", "vendor", "gasto", "spend", "orçamento", "budget", "assinatura", "subscription", "plano pago", "paid plan", "cobrança", "billing", "custo mensal", "monthly cost"];
    // não-vácuo: cada palavra ACENDE o piso quando a pergunta não declara categoria
    for (const w of words) expect(isOwnerOnlyQuestion(q("qx", { text: "Seguimos pelo caminho A?", context: `o contexto cita ${w} de passagem` })), w).toBe(true);
    for (const category of ["technical", "interview", "ui-choice", "delivery"] as const) {
      for (const w of words) {
        const question = q("qx", { category, text: "Seguimos pelo caminho A?", context: `o contexto cita ${w} de passagem` });
        expect(isOwnerOnlyQuestion(question), `${category} + «${w}»`).toBe(false);
        expect(proxyRefusal(question, {}, ultra), `${category} + «${w}»`).toBeNull();
      }
    }
  });

  // A MITIGAÇÃO que o afrouxamento exige (risco registrado ao afrouxar o piso): a pergunta que o piso
  // antigo mandaria ao dono só pelo CONTEXTO vai ao proxy — e a resposta dele vai SEMPRE à auditoria do dono
  // (Acompanhar), nunca só pela amostra. Um gasto real mal categorizado como técnico não passa sem o dono ver.
  const noSample = { autonomy: { mode: "ultra" as const, auditSampleRate: 0 } } satisfies Pick<BoardConfig, "autonomy">;
  const proxyAnswer = (question: CardQuestion) =>
    applyProxyAnswers({ questions: [question] }, noSample, "armazem", "story-x", [{ questionId: question.id, answer: "Sim, siga.", assumptions: "pelo PRD", confidence: 0.95 }], {
      today: "2026-10-02",
    });

  it.each(MOLDE)("%s ⇒ proxiável, mas a resposta do proxy vai SEMPRE à auditoria do dono", (_label, over) => {
    const question = q("qx", over);
    expect(relaxedMoneyFloorMatch(question)).toBe(true);
    const out = proxyAnswer(question);
    expect(out.applied).toEqual(["qx"]);
    expect(out.questions[0].proxy?.audit).toBe(true);
  });

  it("o caso do risco: «Uso a API X?» técnica, com «US$ 200/mês de assinatura» só no contexto ⇒ auditada", () => {
    const question = q("qx", { category: "technical", text: "Uso a API X para o enriquecimento?", context: "custa US$ 200/mês de assinatura" });
    expect(proxyAnswer(question).questions[0].proxy?.audit).toBe(true);
  });

  it("não-vácuo: sem dinheiro no contexto (ou já do dono pelo piso, ou sem categoria) não é o caso afrouxado", () => {
    const plain = q("qx", { category: "technical", text: "Uso a API X para o enriquecimento?", context: "a API já está no projeto" });
    expect(relaxedMoneyFloorMatch(plain)).toBe(false);
    expect(proxyAnswer(plain).questions[0].proxy?.audit).toBeUndefined();
    expect(relaxedMoneyFloorMatch(q("qx", { category: "technical", text: "Qual fornecedor de SMS?", context: "o preço sobe" }))).toBe(false);
    expect(relaxedMoneyFloorMatch(q("qx", { text: "Seguimos?", context: "o preço sobe" }))).toBe(false);
    expect(relaxedMoneyFloorMatch(q("qx", { category: "money", text: "Seguimos?", context: "o preço sobe" }))).toBe(false);
  });
});

describe("proxyRefusal / proxiableQuestions — quem o proxy pode responder", () => {
  const card = (questions: CardQuestion[], autonomyMode?: "human" | "ultra") => ({ questions, autonomyMode });

  it("ultra (só-negócio): interview, ui-choice e delivery abertas vão ao proxy; sem categoria e money ficam com o dono", () => {
    const qs = [
      q("q1", { category: "interview" }),
      q("q2", { category: "ui-choice" }),
      q("q3"),
      q("q4", { category: "delivery" }),
      q("q5", { category: "money" }),
      q("q6", { category: "interview", status: "answered", answer: "x" }),
    ];
    expect(proxiableQuestions(card(qs), ultra).map((x) => x.id)).toEqual(["q1", "q2", "q4"]);
    expect(proxyRefusal(qs[2], card(qs), ultra)).toMatch(/sem categoria/);
    expect(proxyRefusal(qs[3], card(qs), ultra)).toBeNull();
    expect(proxyRefusal(qs[4], card(qs), ultra)).toMatch(/dinheiro/);
  });

  it("human (board ou exceção da story) ⇒ nada vai ao proxy", () => {
    const qs = [q("q1", { category: "interview" })];
    expect(proxiableQuestions(card(qs), human)).toEqual([]);
    expect(proxiableQuestions(card(qs), none)).toEqual([]);
    expect(proxiableQuestions(card(qs, "human"), ultra)).toEqual([]);
    expect(proxiableQuestions(card(qs, "ultra"), human).map((x) => x.id)).toEqual(["q1"]);
  });

  it("uma resposta do proxy que o dono REABRIU nunca volta ao proxy", () => {
    const reopened = q("q1", { category: "interview", proxy: { assumptions: "x", confidence: 0.9, audit: true, auditedAt: "d", auditOutcome: "reopened" } });
    expect(proxyRefusal(reopened, card([reopened]), ultra)).toMatch(/reabriu/);
  });

  it("a fila só-do-dono lista as de dinheiro abertas", () => {
    const qs = [q("q1", { category: "money" }), q("q2", { category: "interview" }), q("q3", { category: "money", status: "answered" })];
    expect(ownerOnlyOpenQuestions({ questions: qs }).map((x) => x.id)).toEqual(["q1"]);
  });
});

describe("auditoria — amostra determinística + toda resposta de baixa confiança", () => {
  it("auditDraw é estável e em [0,1)", () => {
    const a = auditDraw("b/c/q1");
    expect(a).toBe(auditDraw("b/c/q1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
  });

  it("confiança baixa ⇒ sempre; taxa 0 ⇒ nunca (acima do piso); taxa 1 ⇒ sempre", () => {
    expect(shouldAuditProxyAnswer("k", 0.3, 0)).toBe(true);
    expect(shouldAuditProxyAnswer("k", 0.9, 0)).toBe(false);
    expect(shouldAuditProxyAnswer("k", 0.9, 1)).toBe(true);
    expect(shouldAuditProxyAnswer("k", Number.NaN, 0)).toBe(true);
  });

  it("a taxa default amostra ~20% (a régua não é decorativa)", () => {
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (shouldAuditProxyAnswer(`b/story-${i}/q1`, 0.9, 0.2)) hits++;
    expect(hits / 2000).toBeGreaterThan(0.15);
    expect(hits / 2000).toBeLessThan(0.25);
  });
});

describe("applyProxyAnswers — o escritor re-julga no card FRESCO", () => {
  const answers = [
    { questionId: "q1", answer: "Leitoras por indicação", assumptions: "PRD §público", confidence: 0.9 },
    { questionId: "q2", answer: "", selectedOptionIds: ["o2", "o9"], assumptions: "rubrica: aderência ao guia", confidence: 0.8 },
    { questionId: "q3", answer: "R$ 29", assumptions: "chute", confidence: 0.9 },
    { questionId: "q4", answer: "sim", assumptions: "x", confidence: 0.9 },
  ];
  const fresh = {
    questions: [
      q("q1", { category: "interview" }),
      q("q2", { category: "ui-choice", options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }] }),
      q("q3", { category: "money" }),
      q("q4", { category: "interview", status: "answered", answer: "o dono respondeu antes" }),
    ],
  };

  it("aplica só o que segue aberto e proxiável; carimba answeredBy proxy + premissas; opção inventada é descartada", () => {
    const r = applyProxyAnswers(fresh, ultra, "b", "c", answers, { today: "2026-09-25", runId: "run-1" });
    expect(r.applied).toEqual(["q1", "q2"]);
    const [q1, q2, q3, q4] = r.questions;
    expect(q1).toMatchObject({ status: "answered", answer: "Leitoras por indicação", answeredBy: "proxy", answeredAt: "2026-09-25" });
    expect(q1.proxy).toMatchObject({ assumptions: "PRD §público", confidence: 0.9, runId: "run-1" });
    expect(q2).toMatchObject({ status: "answered", selectedOptionIds: ["o2"], answeredBy: "proxy" });
    expect(q3.status).toBe("open"); // dinheiro: intocado
    expect(q4.answer).toBe("o dono respondeu antes"); // a resposta humana nunca é sobrescrita
  });

  it("a story virou human no meio do caminho ⇒ nada aterrissa (mesmo array)", () => {
    const r = applyProxyAnswers({ ...fresh, autonomyMode: "human" }, ultra, "b", "c", answers, { today: "d" });
    expect(r.applied).toEqual([]);
    expect(r.questions).toBe(fresh.questions);
  });

  it("a amostra marca `audit` (taxa 1) — e confiança baixa marca sempre", () => {
    const all = applyProxyAnswers(fresh, { autonomy: { mode: "ultra", auditSampleRate: 1 } }, "b", "c", answers, { today: "d" });
    expect(all.questions[0].proxy?.audit).toBe(true);
    const zero = applyProxyAnswers(fresh, { autonomy: { mode: "ultra", auditSampleRate: 0 } }, "b", "c", [{ ...answers[0], confidence: 0.2 }], { today: "d" });
    expect(zero.questions[0].proxy?.audit).toBe(true);
    const none0 = applyProxyAnswers(fresh, { autonomy: { mode: "ultra", auditSampleRate: 0 } }, "b", "c", [answers[0]], { today: "d" });
    expect(none0.questions[0].proxy?.audit).toBeUndefined();
  });
});

describe("resolveProxyAudit — o dono fecha o item de auditoria", () => {
  const audited: CardQuestion = {
    id: "q1",
    text: "Quem é o público?",
    status: "answered",
    answer: "Leitoras",
    answeredAt: "d0",
    answeredBy: "proxy",
    category: "interview",
    proxy: { assumptions: "PRD §público", confidence: 0.8, audit: true },
  };

  it("confirmar mantém a resposta e fecha a auditoria", () => {
    const [x] = resolveProxyAudit([audited], "q1", "confirmed", "d1");
    expect(x).toMatchObject({ status: "answered", answer: "Leitoras", proxy: { auditedAt: "d1", auditOutcome: "confirmed" } });
    expect(isPendingProxyAudit(x)).toBe(false);
  });

  it("reabrir devolve a pergunta ao dono com o que o proxy assumiu no contexto", () => {
    const [x] = resolveProxyAudit([audited], "q1", "reopened", "d1");
    expect(x.status).toBe("open");
    expect(x.answer).toBeUndefined();
    expect(x.answeredBy).toBeUndefined();
    expect(x.context).toMatch(/Leitoras/);
    expect(x.context).toMatch(/PRD §público/);
    expect(x.proxy?.auditOutcome).toBe("reopened");
  });

  it("uma pergunta sem auditoria pendente não muda (mesmo array)", () => {
    const list = [{ ...audited, proxy: { ...audited.proxy!, audit: undefined } }];
    expect(resolveProxyAudit(list, "q1", "confirmed", "d1")).toBe(list);
  });
});

describe("markProxyDeclined — o proxy DEVOLVE a pergunta ao dono, gravado na própria pergunta", () => {
  it("só a pergunta ABERTA muda: vira do dono (declined, confiança 0, o motivo no registro)", () => {
    const list = [
      q("q1", { category: "interview" }),
      q("q2", { category: "interview", status: "answered", answer: "do dono" }),
    ];
    const next = markProxyDeclined(list, [
      { questionId: "q1", reason: "o proxy recusou: depende de preço" },
      { questionId: "q2", reason: "x" },
    ], { runId: "r1" });
    expect(next[0]).toMatchObject({ status: "open", proxy: { declined: true, confidence: 0, runId: "r1", assumptions: "o proxy recusou: depende de preço" } });
    expect(next[1]).toBe(list[1]); // respondida: intocada
    expect(proxyRefusal(next[0], {}, ultra)).toMatch(/devolveu/);
  });

  it("a classe do dono que o proxy apontou fica gravada na pergunta; sem classe, o registro não a inventa", () => {
    const list = [q("q1", { category: "interview" }), q("q2", { category: "interview" })];
    const next = markProxyDeclined(list, [
      { questionId: "q1", reason: "o proxy recusou: troca de fornecedor", ownerClass: "money" },
      { questionId: "q2", reason: "o proxy falhou 2x — a pergunta é sua" },
    ]);
    expect(next[0].proxy).toMatchObject({ declined: true, ownerClass: "money" });
    expect(next[1].proxy).toMatchObject({ declined: true });
    expect(next[1].proxy?.ownerClass).toBeUndefined();
  });

  it("nada a devolver (ou já devolvida) ⇒ o MESMO array (o escritor pula a gravação)", () => {
    const already = [q("q1", { category: "interview", proxy: { assumptions: "antes", confidence: 0, declined: true } })];
    expect(markProxyDeclined(already, [{ questionId: "q1", reason: "de novo" }])).toBe(already);
    const list = [q("q1", { category: "interview" })];
    expect(markProxyDeclined(list, [{ questionId: "q9", reason: "?" }])).toBe(list);
  });
});

// v0.9 — a pergunta SEM categoria é do dono, em todo modo, venha de onde vier. O grill (o maior escritor de perguntas)
// passou a declarar a categoria; o que sobra sem ela — um texto livre, uma skill que esqueceu — nunca vai ao proxy, e
// o único classificador automático (o de quem genuinamente não sabe) só sabe apontar para o DONO.
describe("defaultQuestionCategory — o default conservador só aponta para o dono", () => {
  it("palavras de dinheiro / marcador [humano] ⇒ money; o resto ⇒ nenhuma categoria (do dono)", () => {
    expect(defaultQuestionCategory({ text: "Assinamos o plano pago do fornecedor de SMS?" })).toBe("money");
    expect(defaultQuestionCategory({ text: "Qual o preço do plano anual?" })).toBe("money");
    expect(defaultQuestionCategory({ text: "Mudamos a meta?", context: "[humano] mexe no PRD" })).toBe("money");
    expect(defaultQuestionCategory({ text: "A leitora quer filtrar por gênero?" })).toBeUndefined();
  });

  it("NUNCA devolve uma categoria proxiável — nem para a prosa mais 'de produto' que houver", () => {
    const prosa = [
      "Quem é a persona desta tela?",
      "Qual das três variantes de layout você prefere?",
      "O escopo inclui o estado vazio?",
      "Aprovar a entrega?",
      "Pode publicar?",
      "",
    ];
    for (const text of prosa) {
      const cat = defaultQuestionCategory({ text });
      expect(cat === undefined || cat === "money").toBe(true);
    }
  });
});

describe("pergunta sem categoria fica com o dono — de ponta a ponta no modo ultra", () => {
  // a forma exata que um grill antigo (ou uma skill que esqueceu) grava no frontmatter: sem `category`
  const grillQ = q("q1", { text: "Barramos livros repetidos na importação ou limpamos o catálogo depois?", askedBy: "harness-grill", options: [{ id: "o1", label: "Importação" }, { id: "o2", label: "Catálogo" }] });
  const card = { id: "c", autonomyMode: undefined, questions: [grillQ] };

  it("o proxy recusa (motivo: sem categoria) e a seleção dele sai vazia", () => {
    expect(proxyRefusal(grillQ, card, ultra)).toMatch(/sem categoria/);
    expect(proxiableQuestions(card, ultra)).toEqual([]);
  });

  it("o escritor do proxy também recusa: uma resposta para ela não aterrissa", () => {
    const out = applyProxyAnswers(card, ultra, "b", "c", [{ questionId: "q1", answer: "Importação", selectedOptionIds: ["o1"], assumptions: "PRD", confidence: 0.9 }], { today: "2026-09-25" });
    expect(out.applied).toEqual([]);
    expect(out.questions[0]).toMatchObject({ status: "open" });
    expect(out.questions[0]).not.toHaveProperty("answeredBy");
  });

  it("a mesma pergunta COM categoria interview é do proxy — a categoria é o que decide", () => {
    expect(proxiableQuestions({ ...card, questions: [{ ...grillQ, category: "interview" }] }, ultra).map((x) => x.id)).toEqual(["q1"]);
  });
});
