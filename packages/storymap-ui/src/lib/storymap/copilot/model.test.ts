import { describe, expect, it } from "vitest";
import { resolveCopilotModelEffort } from "./model";

// ADR-066 — o tier declarado no PROPÓSITO tem de valer. O Explorador é sonnet/medium; o knob de settings
// (`orchestrator.chat`) é a preferência do operador para o chat DO BOARD, e vazá-lo para outro propósito
// tornaria decorativo o `model`/`effort` do registro (era o que acontecia: toda conversa herdava opus[1m]).
describe("resolveCopilotModelEffort — o tier vem do propósito", () => {
  it("um propósito não-copilot usa o model/effort DELE", () => {
    expect(resolveCopilotModelEffort(undefined, undefined, "idea-explorer")).toEqual({
      model: "sonnet",
      effort: "medium",
    });
  });

  it("o pedido explícito ainda vence o propósito (o operador sobe pontualmente)", () => {
    expect(resolveCopilotModelEffort("opus", "high", "idea-explorer")).toEqual({ model: "opus", effort: "high" });
  });

  it("sem propósito informado, segue sendo o Jido do board (comportamento de sempre)", () => {
    const r = resolveCopilotModelEffort();
    expect(r.model.length).toBeGreaterThan(0);
    expect(r.effort.length).toBeGreaterThan(0);
  });
});
