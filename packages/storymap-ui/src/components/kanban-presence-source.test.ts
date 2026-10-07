// As TRAVAS DE FONTE do Kanban e do nav — o que nenhum teste de função pura enxerga, porque mora na tela:
//   • a raia do dono, o Kanban e o rodapé do card NÃO perguntam ao modelo legado (`cardDemands`/`dominantDemand`): era
//     por ele que a raia tinha mais cards que o Decidir e o rodapé oferecia «Publicar de novo» vermelho em
//     card que o sistema republicava;
//   • o card, a linha de estado e o nav não pintam com matiz cru do Tailwind nem animam com `animate-*` cru: a cor sai
//     dos tokens de estado (presence-tone.ts) e o pulso de `.state-pulse` (com prefers-reduced-motion);
//   • nenhuma linha de card é região viva (`role=status`) — nem o card, nem a caixinha do fluxo;
//   • o chip do Inbox não mostra «0» antes da primeira resposta.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Só o código: comentários contam a história do que saiu e citam os nomes de propósito. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const RAW_HUE = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|divide|shadow)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/;

describe("o Decidir é a única fonte de «precisa de você» no Kanban", () => {
  it.each([
    "../lib/storymap/lanes.ts",
    "../lib/storymap/kanban-features.ts",
    "./KanbanBoard.tsx",
    "./RunnerStatusProvider.tsx",
    "./kanban/FeatureCard.tsx",
    "./kanban/CratePopover.tsx",
    "./kanban/TrainColumn.tsx",
  ])("%s não usa cardDemands/dominantDemand", (f) => {
    expect(code(read(f))).not.toMatch(/\b(cardDemands|dominantDemand)\b/);
  });

  // O rodapé do card antigo (KanbanCardNextAction) virou o BLOCO DE AÇÃO do card por funcionalidade: o «precisa de
  // você» é o estado que o Decidir dá ao card, e o primário roda a ação do Inbox só quando a decisão a tem.
  it("o «precisa de você» e o botão primário do card leem o Decidir do board — nunca o status", () => {
    const board = code(read("./KanbanBoard.tsx"));
    expect(board).toMatch(/owner: ownerMap\.has\(c\.id\)/);
    expect(board).toMatch(/<OwnerDecisionsProvider value=\{ownerMap\}>/);
    const cardSrc = code(read("./kanban/FeatureCard.tsx"));
    expect(cardSrc).toMatch(/const decision = useOwnerDecisionFor\(card\.id\)/);
    expect(cardSrc).toMatch(/state === "attention" && decision\?\.primary \? \(/);
    expect(cardSrc).toMatch(/<QuickActionButton boardId=\{config\.id\} cardId=\{card\.id\} action=\{decision\.primary\}/);
  });

  it("a página do Kanban entrega o Decidir do coletor junto com o board", () => {
    const page = read("../app/board/[boardId]/kanban/page.tsx");
    expect(page).toMatch(/boardDecidirCardIds\(params\.boardId\)/);
    expect(page).toMatch(/owner=\{owner\}/);
  });
});

describe("cor e movimento só pelos tokens de estado", () => {
  it.each([
    "./KanbanBoard.tsx",
    "./kanban/FeatureCard.tsx",
    "./kanban/FlowBand.tsx",
    "./kanban/CratePopover.tsx",
    "./kanban/TrainColumn.tsx",
    "./kanban/LiveColumn.tsx",
    "./kanban/KanbanLane.tsx",
    "./kanban/kanban-tokens.ts",
    "./CardLiveStatus.tsx",
    "./nav/NavShell.tsx",
    "./nav/NavAgentsChip.tsx",
  ])(
    "%s sem matiz cru do Tailwind nem animate-* cru",
    (f) => {
      const src = code(read(f));
      expect(src).not.toMatch(RAW_HUE);
      expect(src).not.toMatch(/\banimate-[a-z]/);
    },
  );

  // Com 60 cards na tela, 60 regiões vivas faziam o leitor de tela anunciar o board inteiro a cada quadro do SSE. O
  // pulso do board (KanbanPulse) saiu do Kanban na fase 1 — o fluxo no cabeçalho diz o mesmo à vista —, então a
  // garantia que sobra é a de sempre: nenhuma peça do quadro (card, caixinha, trem, No ar) é região viva.
  it("nenhuma linha de card nem caixinha do fluxo é região viva", () => {
    for (const f of [
      "./KanbanBoard.tsx",
      "./kanban/FeatureCard.tsx",
      "./kanban/FlowBand.tsx",
      "./kanban/CratePopover.tsx",
      "./kanban/TrainColumn.tsx",
      "./kanban/LiveColumn.tsx",
      "./CardLiveStatus.tsx",
    ])
      expect(code(read(f)), f).not.toMatch(/role=["{]?["']?status/);
    expect(code(read("./KanbanBoard.tsx"))).not.toMatch(/<KanbanPulse\b/);
  });
});

describe("o nav", () => {
  it("o chip do Inbox nasce SEM número (null até a 1ª resposta), nunca «0»", () => {
    const store = code(read("./useInboxSummary.ts"));
    expect(store).toMatch(/let current: InboxSummary \| null = null;/);
    expect(store).toMatch(/useSyncExternalStore\(subscribe, \(\) => current, \(\) => null\)/);
    // o ícone do Inbox da barra do topo (shell/InboxIconLink) — era o chip do BoardHeader
    expect(code(read("./shell/InboxIconLink.tsx"))).toMatch(/\{total == null \? "" : total\}/);
  });

  // O nav contava agentes e o pulso contava cards pintados de «Agindo» — «Agentes 1» com «0 agindo».
  it("o «Agentes N» do nav, o do «Mais» do celular e o «n agentes agindo» do pulso saem da MESMA presença e da MESMA conta", () => {
    // O BoardHeader saiu da lista na fase 1: a barra do topo não conta mais agentes (o «Agentes N» e o «Mais» do
    // celular saíram dela; quem conta condutores é a 2ª barra do Kanban). Prova-se abaixo que ele não refaz a conta.
    expect(code(read("./BoardHeader.tsx"))).not.toMatch(/agentPulse\(|reduceAgentPresence\(|workingAgents\(/);
    // O pulso do Kanban saiu na fase 1; quem conta agentes no Kanban agora é o «u/s condutores» da 2ª barra, e o
    // número vem do KanbanBoard — pela MESMA presença e pela MESMA conta (agentPulse, recortada aos condutores).
    for (const f of ["./nav/NavAgentsChip.tsx", "./KanbanBoard.tsx"]) {
      const src = code(read(f));
      expect(src, f).toMatch(/useAgentPresence\(\)/);
      expect(src, f).toMatch(/agentPulse\(/);
      expect(src, f).not.toMatch(/reduceAgentPresence\(|workingAgents\(/); // nenhuma tela refaz a conta com o relógio dela
    }
    // o número de condutores do Kanban conta AGENTES (agentPulse), nunca cards pintados de «rodando»
    expect(code(read("./KanbanBoard.tsx"))).toMatch(/const agentsUsed = agentPulse\(/);
  });

  it("a barra do topo não tem chips de máquina; a RAM só aparece quando freia (na engrenagem)", () => {
    const header = code(read("./BoardHeader.tsx"));
    // fase 1: a barra é marca / projeto / grupo · cota · Inbox · engrenagem — nenhum medidor de máquina nela
    expect(header).not.toMatch(/<NavAgentsChip \/>|<TerminalChip \/>|<ProcessesChip \/>|<RamAlertChip \/>/);
    // a RAM virou a linha de alerta da engrenagem, com a MESMA régua (só a partir do limite)
    const gear = code(read("./shell/SettingsMenu.tsx"));
    expect(gear).toMatch(/if \(pct == null \|\| pct < RAM_ALERT_PCT\) return null;/);
    expect(header).toMatch(/<SettingsMenu /);
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
