import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_CUTS,
  FIB,
  cardWsjf,
  coerceWsjf,
  comparePriority,
  isDegenerate,
  toFib,
  wsjfConfidence,
  wsjfRatio,
  wsjfTier,
  type WsjfCall,
} from "./wsjf";
import type { Card } from "./types";

const w = (o: Partial<WsjfCall>): WsjfCall => ({
  value: 3,
  urgency: 3,
  unlock: 3,
  size: 3,
  basis: [],
  cohortSize: 0,
  cohortAt: "",
  ...o,
});

const card = (o: Partial<Card>): Card =>
  ({ id: "story-x", type: "story", title: "t", ...o }) as Card;

describe("wsjfRatio — a razão", () => {
  it("é (valor + urgência + destrava) / tamanho", () => {
    expect(wsjfRatio(w({ value: 8, urgency: 3, unlock: 5, size: 2 }))).toBe(8);
  });

  it("devolve null — NUNCA 0 — quando o bloco está ausente", () => {
    // 0 empataria um card não avaliado com um legitimamente Baixa; null o tira da ordenação.
    expect(wsjfRatio(null)).toBeNull();
    expect(wsjfRatio(undefined)).toBeNull();
  });

  it("devolve null quando um ordinal está fora da escala fechada (nunca divide por zero)", () => {
    expect(wsjfRatio(w({ size: 0 as never }))).toBeNull();
    expect(wsjfRatio(w({ value: 4 as never }))).toBeNull();
    expect(wsjfRatio(w({ size: -1 as never }))).toBeNull();
  });

  it("cobre a faixa documentada [0,23 , 39]", () => {
    expect(wsjfRatio(w({ value: 1, urgency: 1, unlock: 1, size: 13 }))).toBeCloseTo(0.23, 2);
    expect(wsjfRatio(w({ value: 13, urgency: 13, unlock: 13, size: 1 }))).toBe(39);
  });
});

describe("wsjfTier — faixa ABSOLUTA (não percentil)", () => {
  // A régua de frameworks.md §4. Estes casos SÃO a calibração — mudá-los é mudar a régua.
  it.each([
    ["quick win 16/2 = 8,0", { value: 8, urgency: 3, unlock: 5, size: 2 }, 3],
    ["blocker pequeno 19/2 = 9,5", { value: 3, urgency: 13, unlock: 3, size: 2 }, 3],
    ["alicerce que destrava 20/5 = 4,0", { value: 5, urgency: 2, unlock: 13, size: 5 }, 2],
    ["mediano 11/3 = 3,7", { value: 3, urgency: 5, unlock: 3, size: 3 }, 1],
    ["aposta grande 26/13 = 2,0", { value: 8, urgency: 5, unlock: 13, size: 13 }, 1],
    ["marginal 4/5 = 0,8", { value: 2, urgency: 1, unlock: 1, size: 5 }, 0],
  ])("%s ⇒ tier %s", (_label, ords, tier) => {
    expect(wsjfTier(wsjfRatio(w(ords as Partial<WsjfCall>)))).toBe(tier);
  });

  it("um BUG BLOQUEANTE sobe pela urgência, mesmo entregando pouco valor novo", () => {
    // Sem o termo `urgency` o blocker morreria: valor baixo (não entrega nada novo) e destravamento
    // baixo. É exatamente por isso que o numerador tem três termos e não um.
    const blocker = wsjfRatio(w({ value: 2, urgency: 13, unlock: 2, size: 2 })); // 8,5
    expect(wsjfTier(blocker)).toBe(3);
  });

  it("TETO ESTRUTURAL: tamanho 13 não alcança Alta — o remédio é QUEBRAR o card", () => {
    // CoD é no máximo 39, então 39/13 = 3,0 < corte de Alta (4). É o "SHORTEST" do WSJF operando,
    // não um defeito: item grande e crítico vira fatias que competem em pé de igualdade.
    const maximo = wsjfRatio(w({ value: 13, urgency: 13, unlock: 13, size: 13 }));
    expect(maximo).toBe(3);
    expect(wsjfTier(maximo)).toBe(1);
    // e a mesma substância, quebrada em fatias de tamanho 3, dispara para Crítica
    expect(wsjfTier(wsjfRatio(w({ value: 13, urgency: 13, unlock: 13, size: 3 })))).toBe(3);
  });

  it("um card entrando NÃO mexe no tier de outro (a virtude da faixa absoluta)", () => {
    const antes = wsjfTier(wsjfRatio(w({ value: 3, urgency: 3, unlock: 3, size: 5 })));
    // ... mesmo que 50 cards enormes entrem depois, a razão e o corte são os mesmos.
    const depois = wsjfTier(wsjfRatio(w({ value: 3, urgency: 3, unlock: 3, size: 5 })));
    expect(depois).toBe(antes);
  });

  it("os cortes vêm da spec, não de constante — passar cortes próprios muda o tier", () => {
    const score = wsjfRatio(w({ value: 3, urgency: 3, unlock: 3, size: 5 })); // 1,8
    expect(wsjfTier(score, DEFAULT_TIER_CUTS)).toBe(0);
    expect(wsjfTier(score, { critica: 1.5, alta: 1, media: 0.5 })).toBe(3);
  });

  it("os cortes default são uma escala por DOBRA (2 → 4 → 8)", () => {
    // A régua tem de ser memorizável por um humano; se alguém a mudar, que seja de propósito.
    expect(DEFAULT_TIER_CUTS).toEqual({ critica: 8, alta: 4, media: 2 });
  });

  it("score null ⇒ tier null", () => {
    expect(wsjfTier(null)).toBeNull();
  });
});

describe("toFib — coage a resposta do modelo para a escala", () => {
  it("mapeia para o ordinal mais próximo", () => {
    expect(toFib(4)).toBe(3); // empate 3 vs 5 resolve no primeiro varrido
    expect(toFib(6)).toBe(5);
    expect(toFib(10)).toBe(8);
    expect(toFib(100)).toBe(13);
  });
  it("rejeita não-número, zero e negativo", () => {
    expect(toFib("x")).toBeNull();
    expect(toFib(0)).toBeNull();
    expect(toFib(-3)).toBeNull();
    expect(toFib(null)).toBeNull();
  });
  it("todo membro de FIB mapeia para si mesmo", () => {
    for (const f of FIB) expect(toFib(f)).toBe(f);
  });
});

describe("wsjfConfidence — quantos sinais REAIS existiam", () => {
  it("escala com o número de sinais", () => {
    expect(wsjfConfidence([])).toBe("baixa");
    expect(wsjfConfidence(["soThat", "aceite"])).toBe("baixa");
    expect(wsjfConfidence(["soThat", "aceite", "personas"])).toBe("media");
    expect(wsjfConfidence(["soThat", "aceite", "personas", "esforco", "entregues"])).toBe("alta");
  });
  it("tolera ausência", () => {
    expect(wsjfConfidence(undefined)).toBe("baixa");
  });
});

describe("isDegenerate — o guarda contra ranking fantasma", () => {
  it("acusa um lote sem discriminação nenhuma", () => {
    const items = Array.from({ length: 6 }, () => ({ value: 8 as const, size: 3 as const }));
    expect(isDegenerate(items)).toBe(true);
  });
  it("não acusa quando o tamanho varia", () => {
    const items = [
      { value: 8, size: 3 },
      { value: 8, size: 5 },
      { value: 8, size: 1 },
      { value: 8, size: 13 },
      { value: 8, size: 2 },
    ] as Array<Pick<WsjfCall, "value" | "size">>;
    expect(isDegenerate(items)).toBe(false);
  });
  it("não acusa lote pequeno — empate ali é plausível", () => {
    const items = Array.from({ length: 4 }, () => ({ value: 8 as const, size: 3 as const }));
    expect(isDegenerate(items)).toBe(false);
  });
});

describe("comparePriority — a ordem total do backlog", () => {
  const withCall = (id: string, rank: 0 | 1 | 2 | 3, wsjf?: Partial<WsjfCall>) =>
    card({
      id,
      priorityCall: {
        rank,
        rationale: "r",
        source: "agent",
        assessedAt: "2026-07-29T00:00:00.000Z",
        ...(wsjf ? { wsjf: w(wsjf) } : {}),
      },
    });

  it("o tier manda", () => {
    expect(comparePriority(withCall("a", 3), withCall("b", 1))).toBeLessThan(0);
  });

  it("dentro do MESMO tier, a razão WSJF desempata", () => {
    const alto = withCall("a", 2, { value: 8, urgency: 5, unlock: 3, size: 5 }); // 3,2
    const baixo = withCall("b", 2, { value: 5, urgency: 3, unlock: 3, size: 5 }); // 2,2
    expect(comparePriority(alto, baixo)).toBeLessThan(0);
  });

  it("um card avaliado vem SEMPRE antes de um não avaliado", () => {
    // A mesma regra de honestidade da tela: não-avaliado não se disfarça de Baixa.
    const avaliado = withCall("a", 0, { value: 1, urgency: 1, unlock: 1, size: 13 });
    const naoAvaliado = card({ id: "b" });
    expect(comparePriority(avaliado, naoAvaliado)).toBeLessThan(0);
  });

  it("empate total cai no id — ordem TOTAL, nunca cara-ou-coroa", () => {
    const a = withCall("story-a", 2, { value: 3, urgency: 3, unlock: 3, size: 3 });
    const b = withCall("story-b", 2, { value: 3, urgency: 3, unlock: 3, size: 3 });
    expect(comparePriority(a, b)).toBeLessThan(0);
    expect(comparePriority(b, a)).toBeGreaterThan(0);
  });

  it("call LEGADO (só rank, sem ordinais) segue ordenando pelo rank", () => {
    const legado = withCall("a", 3);
    expect(cardWsjf(legado)).toBeNull();
    expect(comparePriority(legado, withCall("b", 1))).toBeLessThan(0);
  });
});

describe("coerceWsjf — a fronteira com o disco e com o modelo", () => {
  it("aceita um bloco válido", () => {
    const out = coerceWsjf({ value: 8, urgency: 3, unlock: 5, size: 2, basis: ["aceite"], cohortSize: 30, cohortAt: "x" });
    expect(out).toEqual({ value: 8, urgency: 3, unlock: 5, size: 2, basis: ["aceite"], cohortSize: 30, cohortAt: "x" });
  });

  it("coage ordinais fora da escala em vez de descartar o julgamento inteiro", () => {
    expect(coerceWsjf({ value: 4, urgency: 6, unlock: 10, size: 2 })).toMatchObject({
      value: 3,
      urgency: 5,
      unlock: 8,
      size: 2,
    });
  });

  it("converte cohortAt para STRING — o YAML entrega ISO nu como Date", () => {
    const asDate = new Date("2026-07-29T00:00:00.000Z");
    const out = coerceWsjf({ value: 3, urgency: 3, unlock: 3, size: 3, cohortAt: asDate });
    expect(typeof out?.cohortAt).toBe("string");
  });

  it("rejeita bloco sem ordinais utilizáveis", () => {
    expect(coerceWsjf({ basis: [] })).toBeNull();
    expect(coerceWsjf(null)).toBeNull();
    expect(coerceWsjf("nope")).toBeNull();
  });

  it("tolera basis ausente", () => {
    expect(coerceWsjf({ value: 3, urgency: 3, unlock: 3, size: 3 })?.basis).toEqual([]);
  });
});
