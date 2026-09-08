import { describe, expect, it } from "vitest";
import { completionFor, exactCommand, filterCommands, slashQuery, type SlashCommand } from "./slash";

const CMDS: SlashCommand[] = [
  { name: "clear", hint: "limpa" },
  { name: "compact", hint: "compacta" },
  { name: "context", hint: "mostra", whileBusy: true },
];

describe("slashQuery — quando a paleta abre", () => {
  it("a barra sozinha abre com tudo", () => {
    expect(slashQuery("/")).toBe("");
  });

  it("filtra pelo que veio depois da barra, sem caixa", () => {
    expect(slashQuery("/co")).toBe("co");
    expect(slashQuery("/CLE")).toBe("cle");
  });

  it("texto comum NUNCA abre a paleta", () => {
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("oi")).toBeNull();
    expect(slashQuery("explica o /compact")).toBeNull();
    expect(slashQuery("e/ou")).toBeNull();
  });

  it("um espaço depois da barra encerra o modo comando (voltou a ser frase)", () => {
    expect(slashQuery("/clear ")).toBeNull();
    expect(slashQuery("/clear tudo")).toBeNull();
  });

  it("caminho de arquivo colado não vira menu", () => {
    expect(slashQuery("/root/orbit/file.ts")).toBeNull();
    expect(slashQuery("/api/copilot/turn")).toBeNull();
  });
});

describe("filterCommands — o que aparece", () => {
  it("consulta vazia mostra tudo, na ordem do registro", () => {
    expect(filterCommands(CMDS, "").map((c) => c.name)).toEqual(["clear", "compact", "context"]);
  });

  it("casa por PREFIXO (previsível, sem ranking)", () => {
    expect(filterCommands(CMDS, "c").map((c) => c.name)).toEqual(["clear", "compact", "context"]);
    expect(filterCommands(CMDS, "com").map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands(CMDS, "cont").map((c) => c.name)).toEqual(["context"]);
  });

  it("sem casar, a paleta fica vazia (e o texto segue como mensagem)", () => {
    expect(filterCommands(CMDS, "xyz")).toEqual([]);
  });
});

describe("exactCommand — o cinto do envio", () => {
  it("reconhece o comando inteiro, com espaço sobrando ou caixa trocada", () => {
    expect(exactCommand(CMDS, "/clear")?.name).toBe("clear");
    expect(exactCommand(CMDS, "  /clear  ")?.name).toBe("clear");
    expect(exactCommand(CMDS, "/CLEAR")?.name).toBe("clear");
  });

  it("prefixo incompleto ou desconhecido NÃO é comando", () => {
    expect(exactCommand(CMDS, "/cle")).toBeNull();
    expect(exactCommand(CMDS, "/xyz")).toBeNull();
    expect(exactCommand(CMDS, "clear")).toBeNull();
    expect(exactCommand(CMDS, "/clear a conversa")).toBeNull();
  });
});

describe("completionFor", () => {
  it("devolve o texto pronto para o campo", () => {
    expect(completionFor(CMDS[1])).toBe("/compact");
  });
});
