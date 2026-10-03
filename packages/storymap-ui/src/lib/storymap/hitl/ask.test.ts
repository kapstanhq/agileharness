import { describe, expect, it } from "vitest";
import {
  agentTurnView,
  askFromTurn,
  coerceAsk,
  OPEN_ANSWER_LABEL,
  parseAskBlocks,
} from "./ask";
import type { HitlAgentTurn } from "./types";

const fence = (json: string) => "```jido-ask\n" + json + "\n```";

describe("parseAskBlocks — o recorte do bloco de escolha", () => {
  it("texto sem bloco atravessa intacto", () => {
    const r = parseAskBlocks("Movi o card para Revisar.");
    expect(r).toEqual({ text: "Movi o card para Revisar.", ask: null, pending: false, malformed: false });
  });

  it("extrai o ask e TIRA o bloco da leitura", () => {
    const r = parseAskBlocks(
      `Achei dois caminhos.\n\n${fence('{"question":"Qual?","options":["Refatorar","Documentar"]}')}\n\nQualquer um serve.`,
    );
    expect(r.text).toBe("Achei dois caminhos.\n\nQualquer um serve.");
    expect(r.ask?.question).toBe("Qual?");
    expect(r.ask?.options.map((o) => o.label)).toEqual(["Refatorar", "Documentar"]);
    expect(r.pending).toBe(false);
  });

  it("bloco AINDA ABERTO (streaming) não vaza JSON pela metade", () => {
    const r = parseAskBlocks('Vou perguntar:\n\n```jido-ask\n{"question":"Qual cam');
    expect(r.text).toBe("Vou perguntar:");
    expect(r.pending).toBe(true);
    expect(r.ask).toBeNull();
  });

  it("a cerca sozinha (nem o \\n do JSON chegou) já é bloco aberto", () => {
    const r = parseAskBlocks("Pensando…\n\n```jido-ask");
    expect(r.text).toBe("Pensando…");
    expect(r.pending).toBe(true);
  });

  it("JSON malformado é recortado, nunca mostrado", () => {
    const r = parseAskBlocks(`Olha só.\n\n${fence("{isso não é json}")}`);
    expect(r.text).toBe("Olha só.");
    expect(r.ask).toBeNull();
    expect(r.malformed).toBe(true);
  });

  it("dois blocos: o ÚLTIMO vale e os dois somem do texto", () => {
    const r = parseAskBlocks(
      `${fence('{"options":["a"]}')}\nmeio\n${fence('{"options":["b"]}')}\nfim`,
    );
    expect(r.text).toBe("meio\nfim");
    expect(r.ask?.options.map((o) => o.label)).toEqual(["b"]);
  });

  it("um bloco ```json comum NÃO vira UI de escolha", () => {
    const src = 'Config:\n\n```json\n{"options":["a"]}\n```';
    expect(parseAskBlocks(src)).toMatchObject({ text: src, ask: null });
  });
});

describe("coerceAsk — normalização defensiva", () => {
  it("aceita opções como string e como objeto, e limita a 5", () => {
    const ask = coerceAsk({
      options: ["a", { label: "b", recommended: true }, ...Array.from({ length: 9 }, (_, i) => `x${i}`)],
    });
    expect(ask?.options).toHaveLength(5);
    expect(ask?.options[0]).toEqual({ id: "o1", label: "a" });
    expect(ask?.options[1]).toMatchObject({ label: "b", recommended: true });
  });

  it("a DESCRIÇÃO é campo próprio — e `hint`/`detail` caem nela, não em pros", () => {
    const ask = coerceAsk({
      options: [
        { label: "a", description: "o que acontece se escolher isto" },
        { label: "b", hint: "uma nota do agente" },
        { label: "c", detail: "outra nota" },
        { label: "d", pros: ["rápido"], cons: ["arriscado"] },
      ],
    });
    expect(ask?.options[0]).toMatchObject({ description: "o que acontece se escolher isto" });
    expect(ask?.options[1]).toMatchObject({ description: "uma nota do agente" });
    expect(ask?.options[1].pros).toBeUndefined();
    expect(ask?.options[2]).toMatchObject({ description: "outra nota" });
    // pros/cons seguem válidos (é o shape das perguntas de card) — só deixaram de ser o único jeito de falar.
    expect(ask?.options[3]).toMatchObject({ pros: ["rápido"], cons: ["arriscado"] });
  });

  it("ESCOLHA ou ATALHO, nunca os dois: havendo opções, as sugestões caem", () => {
    const ask = coerceAsk({ options: ["a", "b"], suggestions: ["e se…?", "por quê?"] });
    expect(ask?.options).toHaveLength(2);
    expect(ask?.suggestions).toEqual([]);
  });

  it("a resposta ABERTA é sempre oferecida — o `openAnswer:false` do modelo é ignorado", () => {
    const ask = coerceAsk({ options: ["a"], openAnswer: false });
    expect(ask?.openAnswer).toBe(true);
    expect(ask?.openLabel).toBe(OPEN_ANSWER_LABEL);
  });

  it("`multi` e `mode:multi` significam a mesma coisa", () => {
    expect(coerceAsk({ options: ["a"], multi: true })?.mode).toBe("multi");
    expect(coerceAsk({ options: ["a"], mode: "multi" })?.mode).toBe("multi");
    expect(coerceAsk({ options: ["a"] })?.mode).toBe("single");
  });

  it("só sugestões (sem opções) é um ask válido — e sem opção aberta (o composer já está aberto)", () => {
    const ask = coerceAsk({ chips: ["qual o status?", "o que falta?"] });
    expect(ask?.suggestions).toEqual(["qual o status?", "o que falta?"]);
    expect(ask?.openAnswer).toBe(false);
  });

  it("sem opção e sem sugestão não existe escolha", () => {
    expect(coerceAsk({ question: "e aí?" })).toBeNull();
    expect(coerceAsk(null)).toBeNull();
    expect(coerceAsk([1, 2])).toBeNull();
  });

  it("opção sem rótulo é descartada (não vira botão vazio)", () => {
    expect(coerceAsk({ options: [{ id: "x" }, "ok"] })?.options).toEqual([{ id: "o2", label: "ok" }]);
  });
});

describe("agentTurnView — a visão que a UI desenha", () => {
  const base: HitlAgentTurn = { role: "agent", message: "" };

  it("turno com segmentos: recorta o bloco de dentro do segmento de texto", () => {
    const view = agentTurnView({
      ...base,
      segments: [
        { type: "tool", segId: "t1", name: "Read", summary: "x", status: "done" },
        { type: "text", segId: "s1", text: `Decida:\n\n${fence('{"options":["sim","não"]}')}` },
      ],
    });
    expect(view.segments?.[1]).toMatchObject({ type: "text", text: "Decida:" });
    expect(view.ask?.options).toHaveLength(2);
    expect(view.ask?.openAnswer).toBe(true);
  });

  it("sem bloco no texto, a escolha vem dos CAMPOS do turno", () => {
    const view = agentTurnView({
      ...base,
      message: "Toque numa pergunta:",
      options: [{ id: "q1", label: "story-a" }],
      openAnswer: true,
    });
    expect(view.message).toBe("Toque numa pergunta:");
    expect(view.ask?.options).toHaveLength(1);
    expect(view.ask?.openAnswer).toBe(true);
  });

  it("menu de AÇÕES (sem openAnswer) não ganha a saída aberta", () => {
    const ask = askFromTurn({ ...base, options: [{ id: "__review", label: "Revisar" }] });
    expect(ask?.openAnswer).toBe(false);
  });

  it("greeting com AÇÕES não empilha os atalhos de digitação embaixo delas", () => {
    const comAcoes = askFromTurn({ ...base, options: [{ id: "__review", label: "Revisar" }], suggestions: ["status?"] });
    expect(comAcoes?.suggestions).toEqual([]);
    const semAcoes = askFromTurn({ ...base, suggestions: ["status?"] });
    expect(semAcoes?.suggestions).toEqual(["status?"]);
  });

  it("a pergunta NÃO é repetida quando a prosa já termina com ela", () => {
    const view = agentTurnView({
      ...base,
      segments: [
        {
          type: "text",
          segId: "s1",
          text: `Os dois tocam a mesma superfície.\n\n**Por onde começo?**\n\n${fence('{"question":"Por onde começo?","options":["A","B"]}')}`,
        },
      ],
    });
    expect(view.ask?.question).toBeUndefined();
    expect(view.ask?.options).toHaveLength(2);
  });

  it("…mas a pergunta VALE como título quando a prosa falou de outra coisa", () => {
    const view = agentTurnView({
      ...base,
      message: `Li o diff e o selo está mesmo quebrado.\n\n${fence('{"question":"Reverto ou conserto?","options":["A","B"]}')}`,
    });
    expect(view.ask?.question).toBe("Reverto ou conserto?");
  });

  it("o eco é reconhecido mesmo com fecho antes da pergunta e sem a ênfase", () => {
    const view = agentTurnView({
      ...base,
      message: `Beleza. Por onde começo?\n\n${fence('{"question":"por onde começo","options":["A","B"]}')}`,
    });
    expect(view.ask?.question).toBeUndefined();
  });

  it("um turno sem nada não produz escolha", () => {
    expect(agentTurnView({ ...base, message: "oi" }).ask).toBeNull();
  });
});
