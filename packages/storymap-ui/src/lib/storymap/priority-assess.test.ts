import { describe, it, expect } from "vitest";
import { prdDigest } from "./doc/prd-digest";
import { projectLegacyPrd } from "./doc/schemas/prd-legacy";
import {
  parsePriorityAssessment,
  parsePriorityBatch,
  priorityCardLine,
  buildPriorityAssessPrompt,
} from "./priority-assess";
import { coerceCard } from "./repo";
import type { BoardConfig, Card } from "./types";

const card = (data: Record<string, unknown>): Card => coerceCard("c", { type: "story", ...data }, "");

describe("parsePriorityAssessment — tolerante a cercas/preâmbulo", () => {
  it("parseia um objeto JSON limpo", () => {
    expect(parsePriorityAssessment('{"rank": 2, "rationale": "importa muito", "riskiestAssumption": "x"}')).toEqual({
      rank: 2,
      rationale: "importa muito",
      riskiestAssumption: "x",
    });
  });

  it("tolera cercas de código + preâmbulo", () => {
    const r = parsePriorityAssessment('Claro!\n```json\n{"rank": 3, "rationale": "crítico"}\n```');
    expect(r?.rank).toBe(3);
    expect(r?.riskiestAssumption).toBeUndefined();
  });

  it("rejeita rank inválido, rationale vazio ou não-JSON", () => {
    expect(parsePriorityAssessment('{"rank": 5, "rationale": "x"}')).toBeNull();
    expect(parsePriorityAssessment('{"rank": 2, "rationale": ""}')).toBeNull();
    expect(parsePriorityAssessment("desculpa, não consegui")).toBeNull();
  });
});

describe("parsePriorityBatch — descarta entradas malformadas", () => {
  it("parseia itens válidos e descarta os ruins", () => {
    const r = parsePriorityBatch(
      '{"items":[{"id":"a","rank":1,"rationale":"ok"},{"id":"b","rank":9,"rationale":"rank ruim"},{"rank":2,"rationale":"sem id"}]}',
    );
    expect(r).toEqual([{ id: "a", rank: 1, rationale: "ok" }]);
  });

  it("null quando nenhum item sobrevive", () => {
    expect(parsePriorityBatch('{"items":[]}')).toBeNull();
    expect(parsePriorityBatch("nope")).toBeNull();
  });
});

describe("priorityCardLine + prompt", () => {
  it("mostra o tier atual quando o card já foi argumentado", () => {
    const c = card({ priorityCall: { rank: 2, rationale: "x", source: "agent", assessedAt: "d" } });
    expect(priorityCardLine(c)).toMatch(/tier atual: Alta/);
  });

  it("o prompt carrega a estratégia + a metodologia (raciocínio, não alcance)", () => {
    // O norte chega pronto (o digest do PRD). Montá-lo aqui pela projeção do formato ANTIGO prova a
    // cadeia inteira de uma vez: escada no `board.yaml` → PRD projetado → digest → prompt.
    const config = { positioning: "amigo esperto na mosaico", businessMetric: null, desiredOutcome: "retenção" } as unknown as BoardConfig;
    const strategy = prdDigest(projectLegacyPrd(config));
    const p = buildPriorityAssessPrompt({ strategy, card: card({ title: "T" }), siblings: [] });
    expect(p).toMatch(/RACIOC[IÍ]NIO, não aritmética/);
    expect(p).toMatch(/amigo esperto na mosaico/);
    expect(p).toMatch(/retenção/);
    expect(p).toMatch(/APENAS com JSON/);
  });
});
