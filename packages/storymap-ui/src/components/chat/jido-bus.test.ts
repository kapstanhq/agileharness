import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetJidoBusForTests, onOpenJidoChat, openJidoChat, seedJidoChat } from "./jido-bus";
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";

// O BARRAMENTO do chat do Jido — a porta única entre quem abre a conversa (o card do Kanban, o `?copilot=`) e o
// compositor. Fixtures inventadas, no vocabulário da livraria de demonstração.

const seed: CopilotSeed = {
  instruction: "Veja por que o card story-ex9101 parou e proponha o conserto.",
  ref: { kind: "card", boardId: "demo", cardId: "story-ex9101", templateId: "blocker-generic" },
};

afterEach(() => __resetJidoBusForTests());

describe("openJidoChat — abre com o card em contexto e o rascunho, sem enviar", () => {
  it("sem compositor montado é um no-op (não guarda o clique para uma tela futura)", () => {
    openJidoChat({ cardId: "story-ex9102", draft: "Rodar a etapa atual agora." });
    const l = vi.fn();
    onOpenJidoChat(l);
    expect(l).not.toHaveBeenCalled();
  });

  it("entrega exatamente o que foi pedido ao compositor inscrito", () => {
    const l = vi.fn();
    onOpenJidoChat(l);
    openJidoChat({ cardId: "story-ex9102", cardTitle: "Lista de desejos do leitor", draft: "Adiar este card. Motivo: " });
    expect(l).toHaveBeenCalledTimes(1);
    expect(l).toHaveBeenCalledWith({
      cardId: "story-ex9102",
      cardTitle: "Lista de desejos do leitor",
      draft: "Adiar este card. Motivo: ",
    });
  });

  it("sem argumentos abre a conversa pura (nenhum card, nenhum rascunho)", () => {
    const l = vi.fn();
    onOpenJidoChat(l);
    openJidoChat();
    expect(l).toHaveBeenCalledWith({});
  });

  it("cancelar a inscrição desliga o compositor", () => {
    const l = vi.fn();
    const off = onOpenJidoChat(l);
    off();
    openJidoChat({ cardId: "story-ex9103" });
    expect(l).not.toHaveBeenCalled();
  });
});

describe("seedJidoChat — o `?copilot=` abre a conversa semeada pela escalação", () => {
  it("com compositor inscrito: entrega a semente e a instrução como rascunho", () => {
    const l = vi.fn();
    onOpenJidoChat(l);
    seedJidoChat(seed);
    expect(l).toHaveBeenCalledWith({ seed, draft: seed.instruction });
  });

  it("antes do compositor (carregado sob demanda): a semente ESPERA o primeiro ouvinte e é entregue uma vez só", () => {
    seedJidoChat(seed);
    const first = vi.fn();
    onOpenJidoChat(first);
    expect(first).toHaveBeenCalledWith({ seed, draft: seed.instruction });
    // um segundo ouvinte (outra montagem) não recebe a mesma escalação de novo
    const second = vi.fn();
    onOpenJidoChat(second);
    expect(second).not.toHaveBeenCalled();
  });

  it("a semente guardada é a ÚLTIMA (dois deep-links seguidos não abrem duas conversas)", () => {
    const older: CopilotSeed = { ...seed, instruction: "Instrução antiga." };
    seedJidoChat(older);
    seedJidoChat(seed);
    const l = vi.fn();
    onOpenJidoChat(l);
    expect(l).toHaveBeenCalledTimes(1);
    expect(l).toHaveBeenCalledWith({ seed, draft: seed.instruction });
  });
});
