import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// O CARTÃO ÚNICO do Inbox (onda 2) — contrato sobre a FONTE: o rig de teste é node sem renderizador de React (o mesmo
// padrão de kanban-card-footer.test.ts). O texto de cada item é garantido pelo modelo (inbox/decision.test.ts); aqui
// se garante que TODA superfície o desenha pelo mesmo componente, na mesma ordem, e com a consequência à vista.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const card = read("./InboxItemCard.tsx");

describe("a anatomia — cinco partes, sempre na mesma ordem", () => {
  it("decisão → o que aconteceu → suas opções → se você não fizer nada → detalhes (fechados)", () => {
    const full = card.slice(card.indexOf("function FullCard("));
    const at = (needle: string) => {
      const i = full.indexOf(needle);
      expect(i, `presente: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("text(d.ask)")).toBeLessThan(at('title="O que aconteceu"'));
    expect(at('title="O que aconteceu"')).toBeLessThan(at('"Suas opções"'));
    expect(at('"Suas opções"')).toBeLessThan(at('title="Se você não fizer nada"'));
    expect(at('title="Se você não fizer nada"')).toBeLessThan(at("<details"));
    // os detalhes nascem FECHADOS: <details> sem `open`
    expect(full.slice(at("<details"), at("<details") + 60)).not.toMatch(/\bopen\b/);
  });

  it("a consequência de cada opção é TEXTO sob o botão, ligada a ele — nunca um tooltip", () => {
    expect(card).toMatch(/\{text\(o\.consequence\)\}/);
    expect(card).toMatch(/aria-describedby=\{`opt-/);
    expect(card).not.toMatch(/title=\{[^}]*consequence/);
  });

  it("a opção bloqueada diz por quê e o que a libera", () => {
    expect(card).toMatch(/o\.disabled\.reason/);
    expect(card).toMatch(/o\.disabled\.unblock/);
  });

  it("no máximo UM botão cheio: a principal do modelo (primaryOption)", () => {
    expect(card).toMatch(/primaryOption\(d\)/);
    expect(card).toMatch(/const isPrimary = primary\?\.id === o\.id/);
  });

  it("ler e delegar ficam em «Mais», fora das opções", () => {
    expect(card).toMatch(/aria-label="Mais"/);
    expect(card).toMatch(/d\.more\.map/);
  });

  it("as opções ficam presas embaixo na folha (a barra de decisão), com alvos de 48 px", () => {
    expect(card).toMatch(/sticky bottom-0/);
    expect(card).toMatch(/min-h-12/);
  });

  it("depois do clique: o recibo no lugar («Feito — …»), o «Desfazer» quando a ação volta atrás, e o «Próximo»", () => {
    expect(card).toMatch(/Feito<\/b> — \{text\(receipt\.text\)\}/);
    expect(card).toMatch(/<UndoControl boardId=\{entry\.boardId\} undo=\{\{ source: "receipt"/);
    expect(card).toMatch(/onNext/);
  });

  it("o recibo é DURÁVEL e gravado ANTES da recarga — a página do item que acabou de sair já acha o desfecho", () => {
    const run = card.slice(card.indexOf("const run = useCallback("), card.indexOf("const click = "));
    expect(run).toMatch(/await recordInboxReceiptAction\(/);
    expect(run.indexOf("recordInboxReceiptAction(")).toBeLessThan(run.indexOf("router.refresh()"));
    // o «Desfazer» só existe quando o modelo diz que a ação volta atrás, e só depois que o recibo gravou
    expect(run).toMatch(/undo: option\.undo \?\? null/);
    expect(run).toMatch(/receiptId && option\.undo/);
  });

  it("o tempo é formatado no fuso de quem lê — o marcador do modelo nunca chega cru à tela", () => {
    expect(card).toMatch(/formatDecisionText\(/);
    expect(card).toMatch(/relativeWithClock\(/);
  });
});

describe("toda superfície desenha o item pelo cartão único", () => {
  it.each([
    ["a lista do Inbox", "./InboxList.tsx"],
    ["a folha aberta", "./InboxSheet.tsx"],
    ["a página do item", "../inicio/InboxItemScreen.tsx"],
    ["a home", "../inicio/InboxPanel.tsx"],
    ["o chip da barra", "../BoardHeader.tsx"],
    ["as seções do Inbox (a faixa do host e as listas)", "./InboxSections.tsx"],
  ])("%s", (_name, rel) => {
    expect(read(rel)).toMatch(/<InboxItemCard\b/);
  });

  it("o Inbox (de todos os boards, e o do board) desenha as seções, que desenham o cartão", () => {
    expect(read("../CockpitView.tsx")).toMatch(/<InboxHome\b/);
    expect(read("./InboxHome.tsx")).toMatch(/<InboxSections\b/);
    expect(read("./InboxSections.tsx")).toMatch(/<InboxList\b/);
  });

  it("nenhuma superfície guarda texto de decisão próprio: os renderers por kind e as tabelas de rótulo saíram", () => {
    const view = read("../CockpitView.tsx");
    expect(view).not.toMatch(/KIND_RENDERER|COCKPIT_DEMAND_LABEL|COCKPIT_KIND_LABEL|gateLead|quickActionsFor/);
    const labels = read("../inicio/cockpit-labels.ts");
    expect(labels).not.toMatch(/export const COCKPIT_(KIND|DEMAND)_LABEL|export function cockpitItemSnippet/);
  });
});

describe("o desfecho — «Resolvido hoje» e a página de um item que sumiu (passo 5)", () => {
  it("o Inbox desenha «Resolvido hoje» abaixo de Acompanhar, filtrado pelo board escolhido", () => {
    const home = read("./InboxHome.tsx");
    expect(home).toMatch(/resolved=\{<ResolvedToday entries=\{resolved\}/);
    expect(home).toMatch(/snapshot\.resolved\.filter\(\(e\) => e\.boardId === filter\)/);
  });
  it("o «Desfazer» é um componente só: o do recibo e o da decisão do sistema", () => {
    const undo = read("./UndoControl.tsx");
    expect(undo).toMatch(/undoInboxReceiptAction\(/);
    expect(undo).toMatch(/undoSystemDecisionAction\(/);
    expect(read("./ResolvedToday.tsx")).toMatch(/<UndoControl\b/);
  });
  it("a página do item ausente mostra o desfecho formatado no fuso de quem lê, com o «Desfazer» do recibo", () => {
    const screen = read("../inicio/InboxItemScreen.tsx");
    expect(screen).toMatch(/formatDecisionText\(missing\.detail, fmt\)/);
    expect(screen).toMatch(/missing\.undo && \(/);
    const page = read("../../app/board/[boardId]/inbox/[itemId]/page.tsx");
    // o mais específico primeiro: o recibo do dono, a decisão do sistema, … e o card só antes do «não sei»
    expect(page.indexOf("receiptAbsentState(")).toBeLessThan(page.indexOf("systemDecisionAbsentState("));
    expect(page.indexOf("systemDecisionAbsentState(")).toBeLessThan(page.indexOf("cardAbsentState("));
  });
});

describe("a folha aberta — acessível", () => {
  const sheet = read("./InboxSheet.tsx");
  it("deixa a página de trás `inert` e devolve o foco a quem abriu", () => {
    expect(sheet).toMatch(/setAttribute\("inert", ""\)/);
    expect(sheet).toMatch(/removeAttribute\("inert"\)/);
    expect(sheet).toMatch(/opener\.current\.focus\(\)/);
  });
  it("é um diálogo modal com Esc para fechar e ← → para navegar, com alvos de 44 px", () => {
    expect(sheet).toMatch(/role="dialog"/);
    expect(sheet).toMatch(/aria-modal="true"/);
    expect(sheet).toMatch(/"Escape"/);
    expect(sheet).toMatch(/"ArrowRight"/);
    expect(sheet).toMatch(/h-11 w-11/);
  });
});
