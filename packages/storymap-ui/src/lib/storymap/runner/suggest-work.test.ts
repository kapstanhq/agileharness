// WS-6.5 — the deterministic "what next?" ranking. Every case below is an acceptance criterion of
// `06-ws6-frota.md` §6.5 or a property the contention model depends on (read-only, total order).

import { describe, expect, it } from "vitest";
import { collectWorkCandidates, excludedReason, rankWorkCandidates, type WorkCandidate } from "./suggest-work";

const c = (over: Partial<WorkCandidate> & { cardId: string }): WorkCandidate => ({
  board: "acme",
  title: `card ${over.cardId}`,
  status: "desenvolver",
  columnIndex: 5,
  trigger: "harness-do",
  ...over,
});

describe("rankWorkCandidates — ordem", () => {
  it("coluna mais à DIREITA primeiro: WIP antes de trabalho novo", () => {
    const out = rankWorkCandidates([
      c({ cardId: "novo", status: "enriquecer", columnIndex: 1, trigger: "harness-enrich" }),
      c({ cardId: "quase-la", status: "qa-automatizado", columnIndex: 9, trigger: "harness-qa" }),
      c({ cardId: "meio", status: "desenvolver", columnIndex: 5 }),
    ]);
    // Um card em QA está a UM passo de shipar; um em Spec está a um pipeline inteiro. Terminar > começar.
    expect(out.map((s) => s.cardId)).toEqual(["quase-la", "meio", "novo"]);
  });

  it("empatada a coluna, decide a prioridade (3 Crítica → 0 Baixa)", () => {
    const out = rankWorkCandidates([
      c({ cardId: "baixa", rank: 0 }),
      c({ cardId: "critica", rank: 3 }),
      c({ cardId: "media", rank: 1 }),
    ]);
    expect(out.map((s) => s.cardId)).toEqual(["critica", "media", "baixa"]);
  });

  it("card NÃO AVALIADO vai para o FIM — não empata com um avaliado como Baixa", () => {
    // Era o `?? 0`: um card sem prioridade nenhuma empatava com um julgado Baixa. Pior, num board onde
    // ninguém tinha nota TODOS empatavam em 0 e a ordem caía inteira no cardId — ordem alfabética de id
    // servida como ranking. Mesma regra de honestidade da tela: sem avaliação não se finge posição.
    const out = rankWorkCandidates([
      c({ cardId: "sem-nota" }),
      c({ cardId: "baixa", rank: 0 }),
      c({ cardId: "media", rank: 1 }),
    ]);
    expect(out.map((s) => s.cardId)).toEqual(["media", "baixa", "sem-nota"]);
  });

  it("dentro do MESMO tier, o WSJF desempata (dois 'Alta' não são igualmente urgentes)", () => {
    const out = rankWorkCandidates([
      c({ cardId: "alta-fraca", rank: 2, wsjf: 4.2 }),
      c({ cardId: "alta-forte", rank: 2, wsjf: 7.5 }),
      c({ cardId: "critica", rank: 3, wsjf: 0.5 }),
    ]);
    // o tier continua mandando sobre a razão — quem é Crítica vem primeiro mesmo com WSJF menor
    expect(out.map((s) => s.cardId)).toEqual(["critica", "alta-forte", "alta-fraca"]);
  });

  it("WIP-first continua VENCENDO a prioridade (terminar antes de começar)", () => {
    const out = rankWorkCandidates([
      c({ cardId: "critica-nova", status: "enriquecer", columnIndex: 1, trigger: "harness-enrich", rank: 3, wsjf: 12 }),
      c({ cardId: "baixa-em-qa", status: "qa-automatizado", columnIndex: 9, trigger: "harness-qa", rank: 0, wsjf: 0.4 }),
    ]);
    expect(out.map((s) => s.cardId)).toEqual(["baixa-em-qa", "critica-nova"]);
  });

  it("diz explicitamente quando um card não tem prioridade avaliada", () => {
    const [top] = rankWorkCandidates([c({ cardId: "x" })]);
    expect(top.why).toContain("sem prioridade avaliada");
  });

  it("AC4 — duas chamadas concorrentes recebem o MESMO ranking (ordem TOTAL, sem moeda ao ar)", () => {
    // Mesma coluna, mesma prioridade: sem o desempate por cardId a ordem dependeria da ordem de entrada,
    // e dois agentes perguntando ao mesmo tempo poderiam receber listas diferentes — a base do modelo de
    // contenção (o 2º pega "o próximo") deixaria de valer.
    const set = [c({ cardId: "b", rank: 2 }), c({ cardId: "a", rank: 2 }), c({ cardId: "c", rank: 2 })];
    const first = rankWorkCandidates(set, { count: 3 });
    const second = rankWorkCandidates([...set].reverse(), { count: 3 });
    expect(first.map((s) => s.cardId)).toEqual(["a", "b", "c"]);
    expect(second.map((s) => s.cardId)).toEqual(first.map((s) => s.cardId));
  });

  it("explica POR QUE cada sugestão está onde está (ranking auditável, não vibe)", () => {
    const [top] = rankWorkCandidates([c({ cardId: "x", rank: 3, status: "revisar-codigo", columnIndex: 7 })]);
    expect(top.why).toContain("revisar-codigo");
    expect(top.why).toContain("3/3");
    expect(top.why).toContain("sem claim vivo");
  });
});

describe("rankWorkCandidates — exclusões (AC4: nunca sugerir o que não é pegável)", () => {
  it("NUNCA sugere card com claim vivo", () => {
    const out = rankWorkCandidates([c({ cardId: "livre" }), c({ cardId: "tomado", claimedBy: "agent-7" })]);
    expect(out.map((s) => s.cardId)).toEqual(["livre"]);
  });

  it("NUNCA sugere coluna terminal nem coluna sem automação (trabalho de humano)", () => {
    const out = rankWorkCandidates([
      c({ cardId: "pronto", status: "concluida", columnIndex: 12, terminal: true, trigger: undefined }),
      c({ cardId: "revisao-humana", status: "revisao", columnIndex: 10, trigger: undefined }),
      c({ cardId: "ok" }),
    ]);
    expect(out.map((s) => s.cardId)).toEqual(["ok"]);
  });

  it("NUNCA sugere card com blocker aberto (um humano precisa destravar antes)", () => {
    const out = rankWorkCandidates([c({ cardId: "travado", blocked: true }), c({ cardId: "ok" })]);
    expect(out.map((s) => s.cardId)).toEqual(["ok"]);
  });

  it("role filtra o TIPO de trabalho: implement só pega coluna que escreve código", () => {
    const cands = [
      c({ cardId: "codigo", trigger: "harness-do" }),
      c({ cardId: "texto", trigger: "harness-enrich", columnIndex: 9 }), // mais à direita, mas não é código
    ];
    expect(rankWorkCandidates(cands, { role: "implement" }).map((s) => s.cardId)).toEqual(["codigo"]);
    // `free` não filtra — aí a ordem por coluna volta a mandar.
    expect(rankWorkCandidates(cands, { role: "free" }).map((s) => s.cardId)).toEqual(["texto", "codigo"]);
  });

  it("count limita, e o default é 3", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => c({ cardId: id }));
    expect(rankWorkCandidates(many)).toHaveLength(3);
    expect(rankWorkCandidates(many, { count: 5 })).toHaveLength(5);
  });
});

describe("excludedReason — uma lista vazia é um RESULTADO, não um encolher de ombros", () => {
  it("nomeia o motivo de cada near-miss", () => {
    expect(excludedReason(c({ cardId: "x", terminal: true }))).toBe("coluna terminal");
    expect(excludedReason(c({ cardId: "x", trigger: undefined }))).toContain("humano");
    expect(excludedReason(c({ cardId: "x", blocked: true }))).toContain("blocker");
    expect(excludedReason(c({ cardId: "x", claimedBy: "agent-2" }))).toContain("agent-2");
    expect(excludedReason(c({ cardId: "x" }))).toBeNull(); // pegável → sem motivo de exclusão
  });
});

describe("collectWorkCandidates — o meio-IO", () => {
  const deps = {
    readCards: async () =>
      [
        { id: "s1", title: "um", status: "desenvolver", priorityCall: { rank: 2 } },
        { id: "s2", title: "dois", status: "concluida" },
        { id: "s3", title: "três", status: "desenvolver", findings: [{ severity: "blocker", status: "open" }] },
        { id: "s4", title: "fantasma", status: "coluna-que-nao-existe-mais" },
      ] as never,
    readBoardConfig: async () =>
      ({
        statuses: [
          { id: "enriquecer", trigger: "harness-enrich" },
          { id: "desenvolver", trigger: "harness-do" },
          { id: "concluida", terminal: true },
        ],
      }) as never,
    liveClaims: async () => [{ board: "acme", cardId: "s1", actor: "agent-9" }],
  };

  it("resolve status→coluna/trigger, marca claim vivo e blocker, e ignora status órfão", async () => {
    const out = await collectWorkCandidates("acme", deps);
    expect(out.find((x) => x.cardId === "s1")).toMatchObject({ columnIndex: 1, trigger: "harness-do", rank: 2, claimedBy: "agent-9" });
    expect(out.find((x) => x.cardId === "s2")).toMatchObject({ terminal: true });
    expect(out.find((x) => x.cardId === "s3")).toMatchObject({ blocked: true });
    // s4 está num status que o board não declara mais — não é sugerível (nem quebra a coleta).
    expect(out.find((x) => x.cardId === "s4")).toBeUndefined();
    // E o ranking sobre isso tudo sobra vazio: s1 tomado, s2 terminal, s3 travado.
    expect(rankWorkCandidates(out)).toEqual([]);
  });
});
