import { describe, expect, it } from "vitest";

import { toolTreeFlags } from "./flags";

// A cegueira que deixou C1 passar foi exatamente esta: a suíte roda numa árvore em que ferramenta e
// alvo coincidem, então nenhum caso conseguia distinguir os dois mundos. Estes casos passam as duas
// raízes como DADO, e por isso medem o mundo que ainda não existe.
describe("toolTreeFlags — as skills da ferramenta chegam ao filho", () => {
  it("árvores DIFERENTES ⇒ acrescenta a raiz da ferramenta", () => {
    expect(toolTreeFlags("/root/agileharness", "/root/quartz-umbrella")).toEqual([
      "--add-dir",
      "/root/agileharness",
    ]);
  });

  it("a ferramenta DENTRO da árvore do spawn ⇒ nada (o CLI já acha subindo)", () => {
    expect(toolTreeFlags("/repo/packages/storymap-ui", "/repo")).toEqual([]);
    expect(toolTreeFlags("/repo", "/repo")).toEqual([]);
    expect(toolTreeFlags("/repo/", "/repo")).toEqual([]);
  });

  // Não-vacuidade do prefixo: `/repo-outro` COMEÇA com `/repo` como string, mas não está dentro dele.
  // Um `startsWith` sem a barra diria que está, e a ferramenta ficaria invisível para o filho.
  it("prefixo de STRING não é prefixo de CAMINHO", () => {
    expect(toolTreeFlags("/repo-outro", "/repo")).toEqual(["--add-dir", "/repo-outro"]);
  });

  it("entrada ausente ⇒ vazio, nunca uma flag pela metade", () => {
    expect(toolTreeFlags(null, "/repo")).toEqual([]);
    expect(toolTreeFlags("/x", "")).toEqual([]);
    expect(toolTreeFlags(undefined, undefined)).toEqual([]);
  });
});
