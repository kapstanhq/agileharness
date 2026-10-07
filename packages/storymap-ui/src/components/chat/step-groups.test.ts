import { describe, expect, it } from "vitest";
import type { HitlSegment } from "@/lib/storymap/hitl/types";
import { groupSegments, stepsLabel, stepsStatus } from "./step-groups";

const text = (segId: string, t: string): HitlSegment => ({ type: "text", segId, text: t });
const tool = (segId: string, status: "running" | "done" | "error" = "done"): Extract<HitlSegment, { type: "tool" }> => ({
  type: "tool",
  segId,
  name: "Bash",
  summary: "git status",
  status,
});

describe("groupSegments — o técnico recolhido da conversa do Jido", () => {
  it("passos seguidos viram UM grupo; o texto entre eles separa", () => {
    const items = groupSegments([tool("a"), tool("b"), text("t1", "Movi o card."), tool("c")]);
    expect(items.map((i) => i.kind)).toEqual(["steps", "text", "steps"]);
    expect(items[0].kind === "steps" && items[0].steps.map((s) => s.segId)).toEqual(["a", "b"]);
  });

  it("texto vazio (o segmento que o stream cria antes do 1º token) não aparece nem separa", () => {
    const items = groupSegments([tool("a"), text("vazio", "  "), tool("b")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind === "steps" && items[0].steps).toHaveLength(2);
  });

  it("a ordem é preservada e a chave do grupo é estável (o 1º passo)", () => {
    const items = groupSegments([text("t0", "Olhei o board."), tool("x"), tool("y")]);
    expect(items[1]).toMatchObject({ kind: "steps", key: "x" });
  });
});

describe("o rótulo da linha recolhida", () => {
  it("diz quantos passos, em português, sem nome de ferramenta", () => {
    expect(stepsLabel([tool("a")])).toBe("ver detalhes · 1 passo");
    expect(stepsLabel([tool("a"), tool("b")])).toBe("ver detalhes · 2 passos");
    expect(stepsLabel([tool("a")])).not.toMatch(/bash|git/i);
  });

  it("rodando vence erro; erro é contado", () => {
    expect(stepsStatus([tool("a", "error"), tool("b", "running")])).toBe("running");
    expect(stepsLabel([tool("a", "running")])).toBe("trabalhando · 1 passo");
    expect(stepsLabel([tool("a", "error"), tool("b")])).toBe("ver detalhes · 2 passos, 1 com erro");
  });
});
