// As TRAVAS DE FONTE do Kanban e do nav — o que nenhum teste de função pura enxerga, porque mora na tela:
//   • a raia do dono, o Kanban e o rodapé do card NÃO perguntam ao modelo legado (`cardDemands`/`dominantDemand`): era
//     por ele que a raia tinha mais cards que o Decidir e o rodapé oferecia «Publicar de novo» vermelho em
//     card que o sistema republicava;
//   • o card, a linha de estado e o nav não pintam com matiz cru do Tailwind nem animam com `animate-*` cru: a cor sai
//     dos tokens de estado (presence-tone.ts) e o pulso de `.state-pulse` (com prefers-reduced-motion);
//   • nenhuma linha de card é região viva (`role=status`): o pulso do board é o único anúncio;
//   • o chip do Inbox não mostra «0» antes da primeira resposta.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Só o código: comentários contam a história do que saiu e citam os nomes de propósito. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const RAW_HUE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|divide|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

describe("o Decidir é a única fonte de «precisa de você» no Kanban", () => {
  it.each(["../lib/storymap/lanes.ts", "./KanbanBoard.tsx", "./RunnerStatusProvider.tsx", "./KanbanCard.tsx"])("%s não usa cardDemands/dominantDemand", (f) => {
    expect(code(read(f))).not.toMatch(/\b(cardDemands|dominantDemand)\b/);
  });

  it("o botão de resolver do rodapé lê o Decidir do board, e só existe para o card que está nele", () => {
    const src = code(read("./RunnerStatusProvider.tsx"));
    const slot = src.slice(src.indexOf("export function KanbanCardNextAction("), src.indexOf("export function MoveToPopover("));
    expect(slot).toMatch(/useOwnerDecisionFor\(cardId\)/);
    expect(slot).toMatch(/if \(!decision\?\.primary\) return null;/);
  });

  it("a página do Kanban entrega o Decidir do coletor junto com o board", () => {
    const page = read("../app/board/[boardId]/kanban/page.tsx");
    expect(page).toMatch(/boardDecidirCardIds\(params\.boardId\)/);
    expect(page).toMatch(/owner=\{owner\}/);
  });
});

describe("cor e movimento só pelos tokens de estado", () => {
  it.each(["./KanbanCard.tsx", "./CardLiveStatus.tsx", "./nav/NavShell.tsx", "./KanbanPulse.tsx", "./nav/NavAgentsChip.tsx"])(
    "%s sem matiz cru do Tailwind nem animate-* cru",
    (f) => {
      const src = code(read(f));
      expect(src).not.toMatch(RAW_HUE);
      expect(src).not.toMatch(/\banimate-[a-z]/);
    },
  );

  it("nenhuma linha de card é região viva; o pulso do board é a única", () => {
    for (const f of ["./KanbanCard.tsx", "./CardLiveStatus.tsx"]) expect(code(read(f)), f).not.toMatch(/role=["{]?["']?status/);
    expect(code(read("./KanbanPulse.tsx")).match(/role="status"/g)).toHaveLength(1);
  });
});

describe("o nav", () => {
  it("o chip do Inbox nasce SEM número (null até a 1ª resposta), nunca «0»", () => {
    const store = code(read("./useInboxSummary.ts"));
    expect(store).toMatch(/let current: InboxSummary \| null = null;/);
    expect(store).toMatch(/useSyncExternalStore\(subscribe, \(\) => current, \(\) => null\)/);
    const header = code(read("./BoardHeader.tsx"));
    expect(header).toMatch(/value=\{total == null \? "" : total\}/);
  });

  // O nav contava agentes e o pulso contava cards pintados de «Agindo» — «Agentes 1» com «0 agindo».
  it("o «Agentes N» do nav, o do «Mais» do celular e o «n agentes agindo» do pulso saem da MESMA presença e da MESMA conta", () => {
    for (const f of ["./nav/NavAgentsChip.tsx", "./BoardHeader.tsx", "./KanbanPulse.tsx"]) {
      const src = code(read(f));
      expect(src, f).toMatch(/useAgentPresence\(\)/);
      expect(src, f).toMatch(/agentPulse\(/);
      expect(src, f).not.toMatch(/reduceAgentPresence\(|workingAgents\(/); // nenhuma tela refaz a conta com o relógio dela
    }
    expect(code(read("./KanbanPulse.tsx"))).not.toMatch(/\.working\b[^\n]*agindo|kind === "queued"/); // o pulso não conta cards
  });

  it("«Agentes N» toma o lugar dos chips Terminal e Processos; a RAM só aparece quando freia", () => {
    const header = code(read("./BoardHeader.tsx"));
    expect(header).toMatch(/<NavAgentsChip \/>/);
    expect(header).not.toMatch(/<TerminalChip \/>|<ProcessesChip \/>/);
    expect(header).toMatch(/if \(pct == null \|\| pct < RAM_ALERT_PCT\) return null;/);
  });
});

// O /processes não lia a régua de presença — o zumbi contava em «Rodando no pipeline», o condutor
// quieto com o claude vivo seguia «running», e a frota mostrava «vivo · há 0m» em verde pelo batimento.
describe("o /processes lê a MESMA presença do nav", () => {
  it("a linha da frota tira o status da presença, e «Rodando no pipeline» conta só o que roda", () => {
    const src = code(read("../app/processes/ProcessesClient.tsx"));
    expect(src).toMatch(/useAgentPresence\(\)/);
    expect(src).toMatch(/fleetServiceStatus\(s, presenceByTmux\)/);
    expect(src).toMatch(/Rodando no pipeline <span[^>]*>· \{pipelineRunningCount\(pipelineSvc\) \+ mqActive\.length\}/);
  });

  it("a lista da frota mostra a presença; o batimento é só prova de vida, nunca o verde de «vivo»", () => {
    const src = code(read("../app/processes/FleetPanel.tsx"));
    expect(src).toMatch(/useAgentPresence\(\)/);
    expect(src).toMatch(/AGENT_STATE_WORDS\[presence\.state\]/);
    expect(src).not.toMatch(/emerald/);
  });
});
