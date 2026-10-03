// A terceira vaga de condutor (fatia 4 das «paradas por recurso», por decisão do operador): só com TODAS as travas.

import { describe, expect, it } from "vitest";
import { DEFAULT_EXTRA_SLOT, extraSlotBoardVerdict, extraSlotVerdict, gateCoresBetween, isSmallCard, loadWithoutGate, type ExtraSlotFacts } from "./extra-slot";

const S = DEFAULT_EXTRA_SLOT;
const ON = { onPace: true, detail: "a semana consumiu 20% da cota com 50% do tempo decorrido" };
const facts = (over: Partial<ExtraSlotFacts> = {}): ExtraSlotFacts => ({ live: 2, maxSessions: 2, loadAvg1: 1.2, cores: 6, freeRamMb: 9200, pace: ON, mergeBusy: 0, ...over });
const bug = { storyType: "bug" as const };

describe("extraSlotVerdict — a vaga extra só abre com todas as travas", () => {
  it("máquina folgada, cota no ritmo, integração vazia e card pequeno ⇒ abre, e diz por quê", () => {
    expect(extraSlotVerdict(bug, facts(), S)).toEqual({ open: true, why: expect.stringMatching(/processador em 1\.2, 9 GB livres, fila de integração vazia/) });
    expect(extraSlotVerdict({ storyType: "chore" }, facts(), S).open).toBe(true);
  });

  it.each([
    ["processador em metade dos núcleos ou mais", facts({ loadAvg1: 3 }), /processador em 3\.0 \(a vaga extra pede abaixo de 3\.0\)/, "load"],
    ["memória livre em 5 GB ou menos", facts({ freeRamMb: 5000 }), /memória livre em 5000 MB/, "ram"],
    ["cota fora do ritmo ou janela de 5 horas alta", facts({ pace: { onPace: false, detail: "a janela de 5 horas está em 61%" } }), /janela de 5 horas está em 61%/, "quota"],
    ["fila de integração com entrada viva", facts({ mergeBusy: 1 }), /fila de integração tem 1 entrada/, "merge"],
    ["o board já usa a vaga extra", facts({ live: 3 }), /já usa 1 vaga\(s\) extra\(s\)/, "used"],
  ])("uma trava só que falha fecha a vaga: %s — e diz QUAL trava (a classe estável que a fila grava)", (_name, f, why, lock) => {
    expect(extraSlotVerdict(bug, f as ExtraSlotFacts, S)).toEqual({ open: false, why: expect.stringMatching(why as RegExp), lock });
  });

  it("só card pequeno: story de usuário, spike e trabalho técnico esperam a vaga normal", () => {
    for (const storyType of ["user", "technical", "spike", null] as const) {
      expect(extraSlotVerdict({ storyType }, facts(), S)).toEqual({ open: false, why: expect.stringMatching(/só card pequeno/), lock: "card-size" });
      expect(isSmallCard({ storyType })).toBe(false);
    }
  });

  it("`max: 0` desliga; o limite de carga acompanha o número de núcleos da máquina", () => {
    expect(extraSlotVerdict(bug, facts(), { ...S, max: 0 })).toEqual({ open: false, why: "a vaga extra está desligada", lock: "off" });
    expect(extraSlotVerdict(bug, facts({ loadAvg1: 3.9, cores: 8 }), S).open).toBe(true); // 0,5 × 8 = 4
    expect(extraSlotVerdict(bug, facts({ loadAvg1: 3.9, cores: 6 }), S).open).toBe(false);
  });
});

// Carga alta com 2 condutores e o gate; a vaga extra nunca abria justamente quando havia
// fila, porque a suíte do merge train (passageira, e com trava própria) entrava na conta da carga.
describe("a carga da vaga extra é medida SEM a integração em curso", () => {
  it("o gate ocupando núcleos não fecha a vaga; a mesma carga sem gate fecha", () => {
    expect(extraSlotVerdict(bug, facts({ loadAvg1: 4.5, gateLoad: 2.5 }), S)).toEqual({ open: true, why: expect.stringMatching(/processador em 2\.0, sem os 2\.5 da integração/) });
    expect(extraSlotVerdict(bug, facts({ loadAvg1: 4.5 }), S)).toMatchObject({ open: false, lock: "load" });
  });
  it("a subtração nunca passa de zero nem soma uma leitura negativa", () => {
    expect(loadWithoutGate({ loadAvg1: 1, gateLoad: 3 })).toBe(0);
    expect(loadWithoutGate({ loadAvg1: 2, gateLoad: -1 })).toBe(2);
  });
});

describe("extraSlotBoardVerdict — a vaga extra do BOARD, sem card na mão (o que o nav mostra)", () => {
  it("mesmas travas, menos o tamanho do card", () => {
    expect(extraSlotBoardVerdict(facts(), S).open).toBe(true);
    expect(extraSlotBoardVerdict(facts({ freeRamMb: 100 }), S)).toMatchObject({ open: false, lock: "ram" });
  });
  it("para um card grande, a trava do board que já fecharia vem antes do «só card pequeno» só quando é desligada/usada", () => {
    expect(extraSlotVerdict({ storyType: "user" }, facts({ live: 3 }), S)).toMatchObject({ lock: "used" });
    expect(extraSlotVerdict({ storyType: "user" }, facts({ loadAvg1: 5 }), S)).toMatchObject({ lock: "card-size" });
  });
});

describe("gateCoresBetween — os núcleos do gate entre duas leituras do contador do cgroup", () => {
  it("60 s com 150 s de CPU ⇒ 2,5 núcleos", () => {
    expect(gateCoresBetween({ at: 0, usec: 0 }, { at: 60_000, usec: 150_000_000 })).toBe(2.5);
  });
  it("sem par, par curto (<10 s) ou longo (>5 min), ou contador que voltou (cgroup recriado) ⇒ 0", () => {
    expect(gateCoresBetween(undefined, { at: 60_000, usec: 1 })).toBe(0);
    expect(gateCoresBetween({ at: 0, usec: 0 }, { at: 9_000, usec: 9_000_000 })).toBe(0);
    expect(gateCoresBetween({ at: 0, usec: 0 }, { at: 6 * 60_000, usec: 1e9 })).toBe(0);
    expect(gateCoresBetween({ at: 0, usec: 5e9 }, { at: 60_000, usec: 1e9 })).toBe(0);
  });
});

