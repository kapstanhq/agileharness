import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allJidoCommands,
  bugCaptureText,
  composerTextFor,
  isCoreCommand,
  jidoCommands,
  jidoMenuFor,
  jidoPromptFor,
  matchJidoCommands,
  parseJidoCommand,
} from "./jido-commands";
import { cardChipLabel, escalationRefLabel, withCardContext } from "./jido-context";

// Os comandos e o contexto do compositor do Jido — puros. Fixtures inventadas (livraria de demonstração).

const names = (xs: { name: string }[] | null) => (xs ?? []).map((c) => c.name);

describe("a lista do botão `/`", () => {
  it("segue a ordem do design e alterna /pausar ↔ /retomar pelo estado do board", () => {
    expect(names(jidoCommands(false)).slice(0, 6)).toEqual(["criar", "bug", "resumo", "pendente", "travou", "pausar"]);
    expect(names(jidoCommands(true)).slice(0, 6)).toEqual(["criar", "bug", "resumo", "pendente", "travou", "retomar"]);
    // desligado ⇒ «Ligar o board» (o verbo do painel de ritmo), nunca «retomar» um board que não está pausado
    expect(names(jidoCommands("off"))).toEqual(["criar", "bug", "resumo", "pendente", "travou", "ligar"]);
    expect(jidoCommands("off").at(-1)?.label).toBe("Ligar o board");
    // exatamente os seis do desenho: os da conversa não entram na lista do botão
    expect(jidoCommands(false)).toHaveLength(6);
  });

  it("os da conversa aparecem só quando se digita o começo do nome", () => {
    expect(names(jidoMenuFor(false, "/"))).toEqual(["criar", "bug", "resumo", "pendente", "travou", "pausar"]);
    expect(names(jidoMenuFor(false, "/c"))).toEqual(["criar", "clear", "compact", "context"]);
    expect(names(jidoMenuFor(true, "/re"))).toEqual(["resumo", "retomar"]);
    expect(jidoMenuFor(false, "olá")).toBeNull();
  });

  it("escolher ESCREVE o comando no campo (com espaço quem pede complemento) — quem roda é o Enter", () => {
    const byName = Object.fromEntries(allJidoCommands().map((c) => [c.name, composerTextFor(c)]));
    expect(byName).toMatchObject({ criar: "/criar ", bug: "/bug ", resumo: "/resumo", pendente: "/pendente", travou: "/travou ", pausar: "/pausar", retomar: "/retomar", clear: "/clear" });
  });

  it("os rótulos são os do design", () => {
    const byName = Object.fromEntries(jidoCommands(false).map((c) => [c.name, c.label]));
    expect(byName).toMatchObject({
      criar: "Criar item",
      bug: "Reportar um bug",
      resumo: "Resumo desde ontem",
      pendente: "O que precisa de mim",
      travou: "Por que algo travou?",
      pausar: "Pausar o board",
    });
    expect(Object.fromEntries(jidoCommands(true).map((c) => [c.name, c.label])).retomar).toBe("Retomar o board");
  });

  it("filtra pelo que se digita; a barra só vale no começo", () => {
    const list = jidoCommands(true);
    expect(names(matchJidoCommands(list, "/"))).toHaveLength(list.length);
    expect(names(matchJidoCommands(list, "/re"))).toEqual(["resumo", "retomar"]);
    expect(names(matchJidoCommands(list, "/c"))).toEqual(["criar"]);
    expect(matchJidoCommands(list, "olá /criar")).toBeNull();
    expect(matchJidoCommands(list, "/travou o pedido")).toBeNull(); // com espaço já é argumento, não consulta
  });
});

describe("parseJidoCommand — o que o Enter roda", () => {
  const all = allJidoCommands();
  it("nome inteiro + argumento", () => {
    expect(parseJidoCommand(all, "/travou o pedido de reposição")).toMatchObject({
      command: { name: "travou" },
      args: "o pedido de reposição",
    });
    expect(parseJidoCommand(all, "  /criar  ")).toMatchObject({ command: { name: "criar" }, args: "" });
    expect(parseJidoCommand(all, "/PAUSAR inventário")).toMatchObject({ command: { name: "pausar" }, args: "inventário" });
  });
  it("prefixo, comando desconhecido e barra no meio são TEXTO", () => {
    expect(parseJidoCommand(all, "/cri")).toBeNull();
    expect(parseJidoCommand(all, "/xyz algo")).toBeNull();
    expect(parseJidoCommand(all, "e/ou o catálogo")).toBeNull();
  });
  it("digitado, /pausar roda mesmo com o board pausado (a confirmação diz que já estava)", () => {
    expect(parseJidoCommand(all, "/pausar")).not.toBeNull();
    expect(parseJidoCommand(all, "/retomar")).not.toBeNull();
  });
});

describe("o que cada comando vira", () => {
  it("as perguntas viram pedido escrito ao Jido; os demais não", () => {
    expect(jidoPromptFor("resumo")).toMatch(/^Resumo desde ontem/);
    expect(jidoPromptFor("pendente")).toMatch(/precisa de mim/);
    expect(jidoPromptFor("travou")).toMatch(/^Por que algo travou\?/);
    expect(jidoPromptFor("travou", "a vitrine de lançamentos")).toBe(
      "Por que isto travou: a vitrine de lançamentos? Explique a causa em linguagem simples e o próximo passo.",
    );
    for (const n of ["criar", "bug", "pausar", "retomar", "clear", "compact", "context", "model"] as const) {
      expect(jidoPromptFor(n)).toBeNull();
    }
  });
  it("só os da conversa são do núcleo", () => {
    expect(allJidoCommands().filter((c) => isCoreCommand(c.name)).map((c) => c.name)).toEqual([
      "clear",
      "compact",
      "context",
      "model",
    ]);
  });
  it("/bug sem card em mão abre a captura com a dica de algo quebrado", () => {
    expect(bugCaptureText("")).toBe("Algo quebrado: ");
    expect(bugCaptureText(" o carrinho esvazia sozinho ")).toBe("Algo quebrado: o carrinho esvazia sozinho");
  });
  it("os da conversa espelham o núcleo (ChatPanel CORE_COMMANDS): mesmos nomes, só /context roda em voo", () => {
    const panel = readFileSync(fileURLToPath(new URL("./ChatPanel.tsx", import.meta.url)), "utf8");
    const block = panel.slice(panel.indexOf("export const CORE_COMMANDS"), panel.indexOf("];", panel.indexOf("export const CORE_COMMANDS")));
    const coreNames = [...block.matchAll(/name: "([a-z-]+)"/g)].map((m) => m[1]);
    const jidoCore = allJidoCommands().filter((c) => isCoreCommand(c.name));
    expect(jidoCore.map((c) => c.name)).toEqual(coreNames);
    expect(block).toMatch(/name: "context"[^}]*whileBusy: true/);
    expect(jidoCore.filter((c) => c.whileBusy).map((c) => c.name)).toEqual(["context"]);
  });
});

describe("o contexto da conversa", () => {
  it("o chip diz o título do card, ou o id quando não há título", () => {
    expect(cardChipLabel({ id: "story-ex9104", title: "Resenhas na página do livro" })).toBe("Resenhas na página do livro");
    expect(cardChipLabel({ id: "story-ex9104", title: "  " })).toBe("story-ex9104");
  });
  it("o texto enviado nomeia o card com o id; sem card vai como está; vazio não vai", () => {
    expect(withCardContext({ id: "story-ex9104", title: "Resenhas na página do livro" }, " Rodar a etapa atual agora. ")).toBe(
      "Sobre o card «Resenhas na página do livro» (story-ex9104): Rodar a etapa atual agora.",
    );
    expect(withCardContext({ id: "story-ex9104" }, "Como está?")).toBe("Sobre o card story-ex9104: Como está?");
    expect(withCardContext(null, "Como está?")).toBe("Como está?");
    expect(withCardContext({ id: "story-ex9104" }, "   ")).toBe("");
  });
  it("o nome curto de uma escalação (saudação e chip) usa só ids", () => {
    expect(escalationRefLabel({ kind: "question", boardId: "demo", cardId: "story-ex9105", questionId: "q1", templateId: "question-pending" })).toBe(
      "pergunta do card story-ex9105",
    );
    expect(escalationRefLabel({ kind: "card", boardId: "demo", cardId: "story-ex9105", templateId: "unplaced-card" })).toBe("card story-ex9105");
  });
});
