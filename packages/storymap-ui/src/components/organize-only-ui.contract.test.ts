import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Contrato de TELA do board «só organização»: nenhum controle que dispara execução aparece num board assim. O servidor
// já recusa (o portão e as guardas diretas), mas um botão que só sabe recusar é ruído — e foi visto um «Rodar» num card
// de board só de organização. Cada ponto abaixo é a porta de um disparo na tela; tirar o predicado dele reabre o botão.

const SRC = path.join(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("board só de organização: a tela não oferece disparo de execução", () => {
  it("o «Rodar» do card (Kanban e feed do Início) só aparece fora do board só de organização", () => {
    expect(read("components/KanbanCard.tsx")).toMatch(/hasTrigger=\{hasTrigger && !isOrganizeOnly\(config\)\}/);
    expect(read("components/inicio/KanbanFeed.tsx")).toMatch(/hasTrigger=\{!!def\?\.trigger && !isOrganizeOnly\(config\)\}/);
  });

  it("o «Sincronizar» (roda um agente) some do menu do card e da página do card", () => {
    expect(read("components/KanbanCard.tsx")).toMatch(/<KanbanCardActionsMenu [^>]*organizeOnly=\{isOrganizeOnly\(config\)\}/);
    const menu = read("components/RunnerStatusProvider.tsx");
    expect(menu).toMatch(/\{!organizeOnly && <button[\s\S]{0,200}onClick=\{sync\}/);
    expect(read("components/CardDocScreen.tsx")).toMatch(/isOrganizeOnly\(config\)\s*\n?\s*\? \[\]/);
  });

  it("os botões do passo de entrega («Aprovar entrega»/«Publicar») não aparecem", () => {
    expect(read("components/KanbanCard.tsx")).toMatch(/const showButton = [^;]*!isOrganizeOnly\(config\);/);
  });

  it("a página de entrega não oferece «Publicar» para o board e a action recusa", () => {
    const screen = read("components/EntregaScreen.tsx");
    expect(screen).toMatch(/frontier\.organizeOnly \?/);
    expect(read("lib/storymap/runner/delivery-deps.ts")).toMatch(/isOrganizeOnly\(boardConfig\) \? \{ organizeOnly: true \}/);
    expect(read("app/delivery-actions.ts")).toMatch(/if \(organizeOnlyNow\(board\)\) return \{ ok: false/);
  });

  it("o «Console» continua (só lê o que um agente fez — não dispara nada)", () => {
    expect(read("components/KanbanCard.tsx")).toMatch(/<KanbanCardConsoleButton boardId=\{config\.id\} cardId=\{card\.id\} \/>/);
  });
});
