import { describe, expect, it } from "vitest";
import { commandNoticeText, parseTickWake, tickWakeText } from "./tick-turn";

// A forma REAL medida no transcript vivo do board acme (9 ocorrências na sessão cc8ca62b): o CLI expande a slash
// command numa casca XML. É esta string que o chat imprimia numa bolha à direita, como se o operador a digitasse.
const EXPANDED =
  "<command-message>harness-orchestrator</command-message>\n" +
  "<command-name>/harness-orchestrator</command-name>\n" +
  "<command-args>acme autonomous --tick</command-args>";

const EXPANDED_WITH_MOTIVO =
  "<command-message>harness-orchestrator</command-message>\n" +
  "<command-name>/harness-orchestrator</command-name>\n" +
  '<command-args>acme autonomous --tick --motivo "Aprovar design em Destacar eventos de alta afinidade no feed"</command-args>';

describe("parseTickWake", () => {
  it("reconhece a casca XML que o CLI grava para a slash command do tick", () => {
    expect(parseTickWake(EXPANDED)).toEqual({ board: "acme", mode: "autonomous" });
  });

  it("extrai o --motivo citado", () => {
    expect(parseTickWake(EXPANDED_WITH_MOTIVO)).toEqual({
      board: "acme",
      mode: "autonomous",
      reason: "Aprovar design em Destacar eventos de alta afinidade no feed",
    });
  });

  it("reconhece também a forma CRUA (o prompt como buildOrchestratorPrompt o monta)", () => {
    expect(parseTickWake("/harness-orchestrator orbit suggest --tick")).toEqual({
      board: "orbit",
      mode: "suggest",
    });
  });

  it("NÃO reconhece o que o operador digitou — é fala dele, e continua bolha dele", () => {
    expect(parseTickWake("qual o status do board?")).toBeNull();
    expect(parseTickWake("")).toBeNull();
    // o operador falando SOBRE o tick não é o tick
    expect(parseTickWake("por que o --tick não rodou?")).toBeNull();
  });

  it("sem --tick NÃO é o relógio: um /harness-orchestrator digitado pelo operador segue sendo fala dele", () => {
    expect(parseTickWake("/harness-orchestrator acme autonomous")).toBeNull();
    expect(
      parseTickWake(
        "<command-name>/harness-orchestrator</command-name>\n<command-args>acme autonomous</command-args>",
      ),
    ).toBeNull();
  });

  // O CLI grava `<command-name>` com E sem a barra (medido em ~/.claude/projects: 60x
  // `/harness-orchestrator` COM barra, mas também um `<command-name>code-review</command-name>` SEM).
  // Depender desse detalhe de um formato EXTERNO faria o vazamento voltar calado.
  it("tolera o nome do comando SEM a barra (o CLI grava das duas formas)", () => {
    expect(
      parseTickWake(
        "<command-message>harness-orchestrator</command-message>\n" +
          "<command-name>harness-orchestrator</command-name>\n" +
          '<command-args>acme autonomous --tick --motivo "Aprovar design em X"</command-args>',
      ),
    ).toEqual({ board: "acme", mode: "autonomous", reason: "Aprovar design em X" });
  });

  it("tolera a forma CRUA sem barra também", () => {
    expect(parseTickWake("harness-orchestrator acme autonomous --tick")).toEqual({
      board: "acme",
      mode: "autonomous",
    });
  });

  it("não confunde OUTRA slash command com a do tick", () => {
    expect(
      parseTickWake("<command-name>/compact</command-name>\n<command-args>--tick</command-args>"),
    ).toBeNull();
  });
});

describe("tickWakeText", () => {
  it("nomeia o motivo quando há um", () => {
    expect(tickWakeText({ board: "acme", mode: "autonomous", reason: "Aprovar design" })).toBe(
      "Acordei sozinho: Aprovar design",
    );
  });

  it("diz que foi o relógio quando não há motivo", () => {
    expect(tickWakeText({ board: "acme", mode: "autonomous" })).toBe("Acordei sozinho — ciclo periódico");
  });
});

// A regra é da CLASSE: qualquer casca `<command-name>` é INVOCAÇÃO, nunca prosa do operador. Cobrir só o tick
// deixava a porta aberta — o `/compact` do painel grava a MESMA casca (medido: forma real abaixo, com os
// elementos em ordem DIFERENTE e indentados) e voltaria a vazar como bolha do humano por outro caminho.
describe("commandNoticeText — o vazamento é da classe, não do tick", () => {
  // verbatim de um /compact REAL enviado por stdin (o caminho do chat) numa sessão de teste
  const COMPACT_REAL =
    "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>";

  it("o /compact do painel vira evento, não bolha do operador", () => {
    expect(commandNoticeText(COMPACT_REAL)).toBe("Comando: /compact");
  });

  it("o tick ganha a frase rica (tem motivo a contar), não o rótulo genérico", () => {
    expect(commandNoticeText(EXPANDED_WITH_MOTIVO)).toBe(
      "Acordei sozinho: Aprovar design em Destacar eventos de alta afinidade no feed",
    );
  });

  it("um comando com argumentos mostra os argumentos", () => {
    expect(
      commandNoticeText("<command-name>/model</command-name>\n<command-args>sonnet</command-args>"),
    ).toBe("Comando: /model sonnet");
  });

  it("um /harness-orchestrator SEM --tick não é o relógio, mas ainda é COMANDO (nunca XML cru na bolha)", () => {
    const raw = "<command-name>/harness-orchestrator</command-name>\n<command-args>acme autonomous</command-args>";
    expect(parseTickWake(raw)).toBeNull(); // não é tick
    expect(commandNoticeText(raw)).toBe("Comando: /harness-orchestrator acme autonomous"); // mas é evento
  });

  it("argumento gigante é capado (um comando não vira uma linha de evento infinita)", () => {
    const out = commandNoticeText(`<command-name>/x</command-name>\n<command-args>${"a".repeat(300)}</command-args>`)!;
    expect(out.length).toBeLessThanOrEqual("Comando: ".length + 80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prosa de verdade do operador NÃO vira evento", () => {
    expect(commandNoticeText("qual o status do board?")).toBeNull();
    expect(commandNoticeText("")).toBeNull();
  });
});
