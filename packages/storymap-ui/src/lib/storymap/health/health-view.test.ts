// O bloco «Saúde da ferramenta»: o modelo nasce da ÚLTIMA leitura gravada (a tela lê, não mede) e nunca esconde o que não
// sabe — sem leitura, leitura velha, tick desligado e sinal não medível aparecem como tais, não como verde.

import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_SETTINGS, HEALTH_SIGNAL_IDS, type HealthLevel, type HealthRecord } from "./ah-health";
import { ageWords, HEALTH_LEVEL_TEXT, HEALTH_TONE, healthPanelModel, humanDetail, lastReadingSummary, valueText } from "./health-view";

const MIN = 60_000;
const SETTINGS = { tickMinutes: DEFAULT_HEALTH_SETTINGS.tickMinutes, thresholds: DEFAULT_HEALTH_SETTINGS.thresholds };

/** Uma leitura INVENTADA de um tick (3 vermelhos, 5 em atenção, 3 ok, 1 não medível), com as linhas do dia. */
const SAMPLE_READING: HealthRecord = {
  v: 1,
  at: "2026-05-20T16:31:09.512Z",
  signals: {
    S1: { value: 3, level: "amber", detail: "3 itens em Decidir sem razão de negócio (0 sem opção que mude o desfecho) de 6 em Decidir" },
    S2: { value: 62, level: "red", detail: "29 de 47 linhas do Inbox fora do contrato" },
    S3: { value: 1, level: "amber", detail: "1 na raia sem estar em Decidir e 0 em Decidir fora da raia" },
    S4: { value: 1, level: "amber" },
    S5: { value: 0, level: "ok" },
    S6: { value: 4.3, level: "red" },
    S7: { value: 2.9, level: "amber" },
    S8: { value: 4, level: "ok" },
    S9: { value: 1, level: "amber" },
    S10: { value: 2, level: "red" },
    S11: { value: null, level: "unknown" },
    S12: { value: 0, level: "ok" },
  },
};
const T_FRESH = Date.parse("2026-05-20T16:33:09.512Z"); // 2 min depois

describe("healthPanelModel — o que a tela desenha", () => {
  it("os 12 sinais, na ordem dos ids, com nível em palavras, valor com unidade e a linha de evidência gravada", () => {
    const m = healthPanelModel([SAMPLE_READING], SETTINGS, T_FRESH);
    expect(m.rows.map((r) => r.id)).toEqual([...HEALTH_SIGNAL_IDS]);
    expect(m.rows.find((r) => r.id === "S2")).toMatchObject({ label: "Ruído do Inbox", level: "red", levelText: "vermelho", valueText: "62%", detail: "29 de 47 linhas do Inbox fora do contrato" });
    expect(m.rows.find((r) => r.id === "S1")).toMatchObject({ level: "amber", levelText: "atenção", valueText: "3 itens" });
    expect(m.rows.find((r) => r.id === "S11")).toMatchObject({ level: "unknown", levelText: "não medível", valueText: "não medível" });
    // sem a linha do dia (leitura antiga): a linha some, o resto fica
    expect(m.rows.find((r) => r.id === "S4")!.detail).toBeNull();
  });

  it("o resumo de cima conta os níveis e diz há quanto tempo foi lido; leitura recente não traz aviso", () => {
    const m = healthPanelModel([SAMPLE_READING], SETTINGS, T_FRESH);
    expect(m.state).toBe("fresh");
    expect(m.worst).toBe("red");
    expect(m.headline).toBe("3 vermelhos · 5 em atenção · 3 ok · 1 não medível — lido há 2 min");
    expect(m.note).toBeNull();
    expect(m.at).toBe(SAMPLE_READING.at);
  });

  it("só a ÚLTIMA leitura vale, mesmo com o ledger fora de ordem", () => {
    const older: HealthRecord = { v: 1, at: "2026-05-20T16:26:09.100Z", signals: { S1: { value: 11, level: "red" } } };
    const m = healthPanelModel([SAMPLE_READING, older], SETTINGS, T_FRESH);
    expect(m.at).toBe(SAMPLE_READING.at);
    expect(m.rows.find((r) => r.id === "S1")!.valueText).toBe("3 itens");
  });

  it("sem nenhuma leitura: «sem leitura ainda», sem verde inventado — os 12 sinais aparecem como sem leitura", () => {
    const m = healthPanelModel([], SETTINGS, T_FRESH);
    expect(m.state).toBe("empty");
    expect(m.worst).toBeNull();
    expect(m.headline).toBe("Sem leitura ainda");
    expect(m.note).toMatch(/a cada 5 min/);
    expect(m.rows).toHaveLength(12);
    expect(m.rows.every((r) => r.level === "unknown" && r.valueText === "sem leitura")).toBe(true);
  });

  it("leitura velha (3 ticks sem leitura nova) é dita como velha: o tick parou, os números podem não ser os de agora", () => {
    const m = healthPanelModel([SAMPLE_READING], SETTINGS, Date.parse(SAMPLE_READING.at) + 16 * MIN);
    expect(m.state).toBe("stale");
    expect(m.note).toMatch(/há 16 min/);
    expect(m.note).toMatch(/não anda/);
    // no limite (15 min = 3 ticks de 5) ainda é fresca
    expect(healthPanelModel([SAMPLE_READING], SETTINGS, Date.parse(SAMPLE_READING.at) + 15 * MIN).state).toBe("fresh");
  });

  it("tick desligado (tickMinutes 0): a leitura vira «última gravada», nunca o estado de agora; sem leitura, diz que o tick está desligado", () => {
    const off = { ...SETTINGS, tickMinutes: 0 };
    const withRecord = healthPanelModel([SAMPLE_READING], off, T_FRESH);
    expect(withRecord.state).toBe("off");
    expect(withRecord.note).toMatch(/desligado/);
    expect(withRecord.note).toMatch(/última leitura gravada/);
    const without = healthPanelModel([], off, T_FRESH);
    expect(without.state).toBe("off");
    expect(without.note).toMatch(/desligado/);
  });

  it("sinal que a leitura não traz (tick de uma versão com menos sinais) aparece como «sem leitura», não some", () => {
    const partial: HealthRecord = { v: 1, at: SAMPLE_READING.at, signals: { S3: { value: 0, level: "ok" } } };
    const m = healthPanelModel([partial], SETTINGS, T_FRESH);
    expect(m.rows).toHaveLength(12);
    expect(m.rows.find((r) => r.id === "S6")).toMatchObject({ level: "unknown", valueText: "sem leitura" });
  });

  it("os limiares do settings chegam à regra de cada linha (a tela diz o que acende o sinal NESTA instalação)", () => {
    const m = healthPanelModel([SAMPLE_READING], { ...SETTINGS, thresholds: { ...SETTINGS.thresholds, s6: { amber: 1, red: 9, redGroup: 5 } } }, T_FRESH);
    expect(m.rows.find((r) => r.id === "S6")!.rule).toMatch(/acima de 1 h/);
    expect(m.rows.find((r) => r.id === "S6")!.rule).toMatch(/acima de 9 h/);
  });
});

describe("HEALTH_TONE — um vocabulário só, em tokens, com forma e palavra", () => {
  const levels: HealthLevel[] = ["ok", "amber", "red", "unknown"];

  it("todo nível tem cor, forma e palavra", () => {
    for (const l of levels) {
      expect(HEALTH_TONE[l].text, l).not.toBe("");
      expect(HEALTH_LEVEL_TEXT[l], l).not.toBe("");
    }
    expect(new Set(levels.map((l) => HEALTH_LEVEL_TEXT[l])).size).toBe(4);
  });

  it("só tokens de cor do tema (--state-*, --danger, --fg*) — nunca cor crua do Tailwind nem hexadecimal", () => {
    const allowed = /^(?:bg-state-(?:delivering|idle)|text-state-live|bg-danger|text-danger|text-fg|text-fg-subtle|border-\[1\.5px\]|border-state-idle|bg-transparent)$/;
    for (const l of levels) {
      for (const cls of `${HEALTH_TONE[l].dot} ${HEALTH_TONE[l].text}`.split(/\s+/).filter(Boolean)) {
        expect(cls, `${l}: «${cls}» não é um token`).toMatch(allowed);
      }
    }
  });

  it("o âmbar do «precisa de você» NÃO é usado: um sinal de saúde nunca é do dono (C3)", () => {
    for (const l of levels) expect(`${HEALTH_TONE[l].dot} ${HEALTH_TONE[l].text}`).not.toMatch(/state-owner|amber|accent/);
  });

  it("as formas distinguem os níveis sem depender de cor: ok é ✓, atenção/vermelho preenchem, não medível é círculo vazio", () => {
    expect(HEALTH_TONE.ok.mark).toBe("check");
    expect(HEALTH_TONE.amber.mark).toBe("filled");
    expect(HEALTH_TONE.red.mark).toBe("filled");
    expect(HEALTH_TONE.unknown.mark).toBe("ring");
  });
});

describe("ageWords e lastReadingSummary", () => {
  it("a idade em palavras", () => {
    expect(ageWords(10_000)).toBe("agora há pouco");
    expect(ageWords(2 * MIN)).toBe("há 2 min");
    expect(ageWords(135 * MIN)).toBe("há 2 h");
    expect(ageWords(50 * 60 * MIN)).toBe("há 2 d");
    expect(ageWords(-5 * MIN)).toBe("agora há pouco"); // relógio adiantado nunca vira «há -5 min»
  });

  it("o resumo da última leitura: quando, o pior nível e quem está vermelho/em atenção; sem leitura, null", () => {
    expect(lastReadingSummary(SAMPLE_READING)).toEqual({ at: SAMPLE_READING.at, worst: "red", red: ["S2", "S6", "S10"], amber: ["S1", "S3", "S4", "S7", "S9"] });
    expect(lastReadingSummary(null)).toBeNull();
  });
});

// A linha de evidência e o valor em português de gente: vírgula decimal, singular no 1, «(s)» resolvido, códigos internos em
// palavras. O ponto decimal, «1 cards», «(s)» sem resolver e códigos internos não chegam ao dono.
describe("valueText e humanDetail — o número como o dono lê", () => {
  it("vírgula decimal, singular no 1, % colado", () => {
    expect(valueText(6.4, "h")).toBe("6,4 h");
    expect(valueText(1, "cards")).toBe("1 card");
    expect(valueText(2, "cards")).toBe("2 cards");
    expect(valueText(1, "saltos")).toBe("1 salto");
    expect(valueText(65, "%")).toBe("65%");
    expect(valueText(null, "cards")).toBe("não medível");
  });

  it("detalhe: (s) pelo número, 1 no singular, códigos internos em palavras, decimal com vírgula", () => {
    expect(humanDetail("1 vigiado(s), 2 escalado(s)")).toBe("1 vigiado, 2 escalados");
    expect(humanDetail("6.4 h com fila; 1 cards esperam")).toBe("6,4 h com fila; 1 card esperam");
    expect(humanDetail("2 pela mesma causa (needs-human|7)")).toBe("2 pela mesma causa (espera uma pessoa · 7)");
    expect(humanDetail("bate com o último salto do ledger")).toBe("bate com o último salto do histórico de status");
    expect(humanDetail("v1.2 do texto e 4.5 min de espera")).toBe("v1.2 do texto e 4,5 min de espera");
  });
});
