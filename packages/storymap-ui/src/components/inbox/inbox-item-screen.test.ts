// A página do item escrevia o título, o status e o id DUAS vezes. Desde a fase 3 ela desenha o MESMO item da lista
// (InboxItem), sozinho e com «Mais detalhes» aberto — um cabeçalho só (a linha de contexto e o que o agente precisa).
// Asserção sobre a fonte (o rig de teste não renderiza React).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const source = read("./InboxItemScreen.tsx");

describe("F17 — a página do item tem UM cabeçalho", () => {
  it("desenha o item com o componente da lista, com «Mais detalhes» aberto — e não escreve um segundo título", () => {
    expect(source).toMatch(/<InboxItem\b[^>]*detailsOpen/);
    expect(source).not.toMatch(/<h1\b/);
    expect(source).not.toMatch(/CockpitItemDetail/);
  });

  it("o item já resolvido diz o desfecho no fuso de quem lê, com o «Desfazer» do recibo; o mais específico primeiro", () => {
    expect(source).toMatch(/formatDecisionText\(missing\.detail, fmt\)/);
    expect(source).toMatch(/missing\.undo && \(/);
    const page = read("../../app/board/[boardId]/inbox/[itemId]/page.tsx");
    expect(page.indexOf("receiptAbsentState(")).toBeLessThan(page.indexOf("systemDecisionAbsentState("));
    expect(page.indexOf("systemDecisionAbsentState(")).toBeLessThan(page.indexOf("cardAbsentState("));
  });
});

// Revisão da fase 3: a página desenhava TODA entrada na anatomia de decidir — um item de Acompanhar (o sistema decide)
// abria com «O que eu preciso de você» e três botões, contradizendo a lista e convidando o dono a passar por cima do
// pipeline. Acompanhar abre na forma curta (o que acontece, quem cuida, só desfazer/reabrir), com os detalhes abertos.
describe("a página de um item de Acompanhar", () => {
  it("usa a forma curta com «Mais detalhes» aberto, sob «Os agentes estão cuidando»", () => {
    expect(source).toMatch(/entry\.decision\.bucket === "acompanhar"/);
    expect(source).toMatch(/<InboxItem\b[^>]*variant="short"[^>]*detailsOpen/);
    expect(source).toMatch(/Os agentes estão cuidando/);
  });
  it("a forma curta desenha os detalhes quando a página os pede, e só os botões de voltar atrás", () => {
    const item = read("./InboxItem.tsx");
    const short = item.slice(item.indexOf('if (variant === "short")'), item.indexOf("// ── a anatomia inteira"));
    expect(short).toMatch(/detailsOpen && detailsView/);
    expect(short).toMatch(/filter\(isUndoLike\)/);
    expect(short).not.toMatch(/O que eu preciso de você/);
    expect(short).not.toMatch(/<InboxOptions/);
  });
});
