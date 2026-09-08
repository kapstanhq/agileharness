import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUARANTINE,
  decideQuarantine,
  corridaVerdeLimpaMainRed,
  describeMainRed,
  nextMainRedState,
  type FlakyRecord,
  type MainRedState,
} from "./gate-health";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const flake = (testId: string, days: number): FlakyRecord => ({ at: ago(days), testId, runId: "r1" });

describe("decideQuarantine — quarentena é PADRÃO, não pânico", () => {
  it("uma ocorrência só não quarentena nada", () => {
    expect(decideQuarantine([flake("a.ts::x", 1)], NOW).testIds).toEqual([]);
  });

  it("atingido o mínimo dentro da janela, entra", () => {
    const d = decideQuarantine([flake("a.ts::x", 1), flake("a.ts::x", 2), flake("a.ts::x", 3)], NOW);
    expect(d.testIds).toEqual(["a.ts::x"]);
    expect(d.reason).toContain("1 teste(s) em quarentena");
  });

  it("ocorrências FORA da janela não contam — flake de ano passado é história, não flake", () => {
    const d = decideQuarantine([flake("a.ts::x", 1), flake("a.ts::x", 40), flake("a.ts::x", 60)], NOW);
    expect(d.testIds).toEqual([]);
  });

  it("ordena por frequência (o pior primeiro)", () => {
    const recs = [
      ...Array.from({ length: 3 }, () => flake("b::y", 1)),
      ...Array.from({ length: 5 }, () => flake("a::x", 1)),
    ];
    expect(decideQuarantine(recs, NOW).testIds).toEqual(["a::x", "b::y"]);
  });

  it("acima do teto NÃO quarentena NINGUÉM — suíte podre se conserta, não se silencia", () => {
    const recs: FlakyRecord[] = [];
    for (let i = 0; i < DEFAULT_QUARANTINE.maxQuarantined + 1; i++) {
      for (let k = 0; k < 3; k++) recs.push(flake(`t${i}::x`, 1));
    }
    const d = decideQuarantine(recs, NOW);
    expect(d.testIds).toEqual([]);
    expect(d.reason).toContain("suíte podre");
  });

  it("registro malformado (sem data / sem testId) é ignorado sem quebrar", () => {
    const recs = [{ at: "não é data", testId: "a::x" }, { at: ago(1), testId: "" }] as FlakyRecord[];
    expect(decideQuarantine(recs, NOW).testIds).toEqual([]);
  });

  it("ledger vazio é uma resposta, não um erro", () => {
    expect(decideQuarantine([], NOW).testIds).toEqual([]);
  });
});

describe("nextMainRedState — o `since` é o número que constrange", () => {
  const red = [{ file: "a.ts", name: "x" }];

  it("primeira medição vermelha abre o episódio", () => {
    const s = nextMainRedState(null, { failures: red, sha: "abc", at: ago(0) });
    expect(s?.since).toBe(ago(0));
    expect(s?.observations).toBe(1);
  });

  it("medição vermelha seguinte PRESERVA o início e incrementa as observações", () => {
    const prev: MainRedState = { since: ago(3), at: ago(1), sha: "old", failures: red, observations: 4 };
    const s = nextMainRedState(prev, { failures: red, sha: "new", at: ago(0) });
    expect(s?.since).toBe(ago(3)); // NÃO reinicia — "vermelha desde a última medição" seria inútil
    expect(s?.at).toBe(ago(0));
    expect(s?.sha).toBe("new");
    expect(s?.observations).toBe(5);
  });

  it("verde encerra o episódio (estado some)", () => {
    const prev: MainRedState = { since: ago(3), at: ago(1), sha: "s", failures: red, observations: 9 };
    expect(nextMainRedState(prev, { failures: [], sha: "s2", at: ago(0) })).toBeNull();
  });

  it("capa a lista de falhas (um estado não pode crescer sem teto)", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ file: `f${i}.ts`, name: "x" }));
    expect(nextMainRedState(null, { failures: many, sha: "s", at: ago(0) })?.failures.length).toBe(12);
  });
});

describe("corridaVerdeLimpaMainRed — o produtor que faltava do produtor", () => {
  it("suíte COMPLETA verde declara a main verde: é o único caminho que apaga o estado", () => {
    // Sem isto o episódio vermelho é uma porta de mão única: a atribuição (que produz a medição) só roda
    // quando a mesclada FALHA, então uma main já consertada seguia sendo anunciada como vermelha para
    // sempre. Aconteceu: 5 falhas no painel, 0 na medição do dia.
    expect(corridaVerdeLimpaMainRed({ ok: true, affectedOnly: false })).toBe(true);
  });

  it("verde por SELEÇÃO DE AFETADOS não declara nada — ela não mediu o que não rodou", () => {
    // Apagar aqui seria pior que o painel velho: um vermelho real desapareceria com base numa rodada
    // que nem chegou a executar a suíte onde ele mora.
    expect(corridaVerdeLimpaMainRed({ ok: true, affectedOnly: true })).toBe(false);
  });

  it("rodada VERMELHA nunca declara verde, com ou sem seleção", () => {
    expect(corridaVerdeLimpaMainRed({ ok: false, affectedOnly: false })).toBe(false);
    expect(corridaVerdeLimpaMainRed({ ok: false, affectedOnly: true })).toBe(false);
  });

  it("e o que ele autoriza REALMENTE apaga — o par com nextMainRedState, fechado ponta a ponta", () => {
    const vermelha: MainRedState = { since: ago(3), at: ago(1), sha: "s1", failures: [{ file: "a", name: "x" }], observations: 3 };
    const autoriza = corridaVerdeLimpaMainRed({ ok: true, affectedOnly: false });
    expect(autoriza).toBe(true);
    expect(
      nextMainRedState(vermelha, { failures: autoriza ? [] : vermelha.failures, sha: "s2", at: ago(0) }),
      "autorizar e não apagar deixaria os dois lados certos e o painel errado",
    ).toBeNull();
  });
});

describe("describeMainRed", () => {
  it("diz há quanto tempo e que ninguém está consertando", () => {
    const s: MainRedState = { since: ago(3), at: ago(0), sha: "s", failures: [{ file: "a", name: "x" }], observations: 7 };
    const text = describeMainRed(s, NOW);
    expect(text).toContain("há 3d");
    expect(text).toContain("ninguém está consertando");
  });

  it("episódio do mesmo dia não diz 'há 0d'", () => {
    const s: MainRedState = { since: ago(0), at: ago(0), sha: "s", failures: [], observations: 1 };
    expect(describeMainRed(s, NOW)).toContain("hoje");
  });

  it("carrega QUANDO mediu e SOBRE QUAL sha — a linha é um retrato, não uma afirmação sobre agora", () => {
    // O estado só é re-medido quando alguém passa pelo gate. Sem estes dois fatos a linha afirma o
    // presente sobre uma medição que pode ser de dias atrás — foi o que aconteceu em 2026-08-25, quando
    // ela anunciava 5 falhas e a main do dia tinha 0.
    const s: MainRedState = {
      since: ago(3),
      at: "2026-08-24T21:29:06.585Z",
      sha: "48386eb25d3093726571dda0d1fbe721eeddddbf",
      failures: [{ file: "a", name: "x" }],
      observations: 4,
    };
    const text = describeMainRed(s, NOW) as string;
    expect(text, "sem a data da medição não dá para saber se a linha é de hoje").toContain("2026-08-24 21:29");
    expect(text, "sem o sha não dá para conferir contra a main de agora").toContain("48386eb25");
    expect(text, "quem lê precisa saber que isto não é re-medido sozinho").toMatch(/confirme na main de hoje/);
  });

  it("main verde não tem nada a dizer", () => {
    expect(describeMainRed(null)).toBeNull();
  });
});
