import { describe, expect, it, vi } from "vitest";

// 2.2 (camada 2 — cinto de segurança server-side): um purpose SEM doneContract (chat aberto, como o Jido)
// nunca pode "resolver". advanceHitlAction descarta qualquer `done` que o modelo emita, para o cliente não
// trocar por um banner FALSO "✓ Resolvido — aplicado.". Mockamos o LLM (runClaudeJson) → string JSON crua.
vi.mock("@/lib/storymap/smart-capture/claude", () => ({ runClaudeJson: vi.fn() }));

// F1.7 — o purpose "copilot" migrou p/ o transporte agêntico e advanceHitlAction agora o REJEITA. A cobertura
// do drop-`done` (2.2) precisa de OUTRO purpose sem doneContract → injetamos um sintético "open-test" (chat
// aberto) via mock parcial do registry, preservando os demais purposes reais.
vi.mock("@/lib/storymap/hitl/purpose-registry", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/storymap/hitl/purpose-registry")>();
  return {
    ...actual,
    hitlPurposeById: (id: string) =>
      id === "open-test"
        ? { id: "open-test", label: "Open test", summary: "chat aberto de teste", defaultPrompt: "persona de teste" }
        : actual.hitlPurposeById(id),
  };
});

import { advanceHitlAction } from "./hitl-actions";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";

describe("advanceHitlAction — 2.2: purpose sem doneContract nunca encerra o chat", () => {
  it("descarta o `done` que o modelo emitiu num chat aberto, preservando a message", async () => {
    vi.mocked(runClaudeJson).mockResolvedValue(JSON.stringify({ message: "segue conversando", done: { anything: 1 } }));
    const res = await advanceHitlAction({ purpose: "open-test", transcript: { turns: [] } });
    expect(res.ok).toBe(true);
    expect(res.ok && res.data?.turn.done).toBeUndefined(); // done dropado → banner falso nunca aparece
    expect(res.ok && res.data?.turn.message).toContain("segue conversando");
  });

  it("PRESERVA o `done` p/ um purpose COM doneContract (capture-disambiguation)", async () => {
    vi.mocked(runClaudeJson).mockResolvedValue(
      JSON.stringify({ message: "ok", done: { type: "story", storyType: "bug" } }),
    );
    const res = await advanceHitlAction({ purpose: "capture-disambiguation", transcript: { turns: [] } });
    expect(res.ok && res.data?.turn.done).toEqual({ type: "story", storyType: "bug" });
  });

  it("um turno com SÓ done num chat aberto vira ERRO (não um banner falso)", async () => {
    vi.mocked(runClaudeJson).mockResolvedValue(JSON.stringify({ done: { x: 1 } }));
    const res = await advanceHitlAction({ purpose: "open-test", transcript: { turns: [] } });
    expect(res.ok).toBe(false); // done dropado ANTES do guard → sem message/options/done → turno inválido
  });
});

describe("advanceHitlAction — F1.7: o Jido migrou p/ o transporte agêntico", () => {
  it("rejeita o purpose 'copilot' com erro instrutivo (aponta p/ /api/copilot/turn)", async () => {
    const res = await advanceHitlAction({ purpose: "copilot", transcript: { turns: [] } });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/\/api\/copilot\/turn/);
  });
});
