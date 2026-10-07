import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// A ANATOMIA do card do Kanban por funcionalidade (fase 1, desenho 6a) — o contrato que antes fixava o rodapé do card
// antigo (story-ex0019: a faixa de ações, a prioridade, Mover/Rodar/Console) passa a fixar a peça NOVA equivalente:
//   • cabeçalho QUIETO de uma linha: tipo · espaço · tempo · o chevron de ações colado à direita;
//   • o título é a FUNCIONALIDADE (o link da página do card, esticado sobre o card) e o item vem menor embaixo — e
//     some quando o card é a própria funcionalidade (o título nunca se repete);
//   • UMA seção pelo estado: ação (precisa de você / erro) com o primário escuro, rodando (marca + mensagem ao vivo +
//     passos + custo), ou o rodapé quieto (bolinha · rótulo · mensagem ou passo);
//   • as ações moram no chevron: «Fazer antes» / «Pode esperar» gravam a posição na coluna direto (fase 5 — a ordem do
//     trabalho é a posição); as demais abrem o chat do Jido com o card em contexto e o pedido escrito.
// O rig de teste é node sem DOM (jsdom/testing-library ausentes, só `*.test.ts`), então o contrato é afirmado contra o
// fonte — a composição do JSX É o contrato.
const source = readFileSync(fileURLToPath(new URL("./kanban/FeatureCard.tsx", import.meta.url)), "utf8");
/** Só o código: comentários contam a história e citam os nomes de propósito. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
// As PALAVRAS do card (rótulos e pedidos escritos) moram no módulo puro do Kanban, que o glossário do dono varre
// (kanban-copy.test.ts); o card as usa pelas chaves.
const copy = readFileSync(fileURLToPath(new URL("../lib/storymap/kanban-copy.ts", import.meta.url)), "utf8");

describe("o cabeçalho do card: tipo · tempo · ações", () => {
  it("uma linha de 12px com o tipo, o espaço, o tempo e o chevron colado à direita", () => {
    const head = code.slice(code.indexOf("{kindOf(card)}") - 200, code.indexOf("<ChevronDown"));
    expect(head).toMatch(/flex items-center gap-1\.5 pl-3 pr-2 pt-\[9px\] text-\[12px\] text-fg-subtle/);
    expect(head.indexOf("{kindOf(card)}")).toBeLessThan(head.indexOf('<span className="flex-1" />'));
    expect(head.indexOf('<span className="flex-1" />')).toBeLessThan(head.indexOf("{since}"));
  });

  it("o chevron tem nome (title + aria-label) e diz se está aberto", () => {
    expect(code).toMatch(/title="Ações"/);
    // o nome do card sem a etiqueta de máquina do começo (display-title.ts) — o leitor de tela lê o que a tela mostra
    expect(code).toMatch(/aria-label=\{`Ações do card \$\{displayTitle\(card\.title\)\}`\}/);
    expect(code).toMatch(/aria-expanded=\{menuOpen\}/);
  });
});

describe("o corpo: a funcionalidade e o item", () => {
  it("o título é o link da página da FUNCIONALIDADE, esticado sobre o card inteiro (sem link aninhado nos botões)", () => {
    expect(code).toMatch(/<Link\s+href=\{href\}/);
    expect(code).toMatch(/after:absolute after:inset-0/);
    expect(code).toMatch(/\{entry\.feature\.title\}/);
    // o quadro dá ao título a página da funcionalidade (o card que é a própria funcionalidade: a do item) — fase 7
    const board = readFileSync(fileURLToPath(new URL("./KanbanBoard.tsx", import.meta.url)), "utf8");
    expect(board).toMatch(/href=\{featureTitleHref\(boardId, e\.feature, hrefOf\(e\.item\.id\)\)\}/);
  });

  it("a linha do ITEM é um link próprio para o item, acima do link esticado, com o prefixo pelo estado — e SOME quando o card é a própria funcionalidade", () => {
    const item = code.slice(code.indexOf("{!entry.feature.self && ("), code.indexOf("{extra.others.length > 0 && ("));
    expect(item).toMatch(/<Link\s+href=\{hrefOf\(card\.id\)\}/);
    expect(item).toMatch(/className="relative z-\[1\][^"]*text-\[13px\] leading-\[1\.4\] text-fg-subtle[^"]*max-md:min-h-10"/);
    // «Agora:» / «Próximo:» / «Precisa de você:» na tinta do estado; o texto é o item (ou o que o lote junta)
    expect(code).toMatch(/const line = itemLine\(entry\);/);
    expect(item).toMatch(/\{line\.prefix && <span className=\{cn\("font-semibold", tone\.ink\)\}>\{line\.prefix\} <\/span>\}/);
    expect(item).toMatch(/\{line\.text\}/);
  });

  it("os outros itens da funcionalidade na raia viram o «+N» DITO (o que são: «+1 correção desta funcionalidade»)", () => {
    // o «+1 item aqui» seco não dizia o que era o item; a frase sai da função pura (kanban-features moreItemsWords)
    // os outros SEM os do lote que a linha do item já resume (kanban-features othersBeyondLot) — nada conta duas vezes
    expect(code).toMatch(/const extra = othersBeyondLot\(entry\);/);
    expect(code).toMatch(/\{moreItemsWords\(extra\.others\)\}/);
    expect(code).not.toMatch(/itens"\}\s*aqui/);
  });

  it("o «+N» é um BOTÃO que abre e fecha, dentro do card, a lista dos outros itens (cada um abre a página dele)", () => {
    const more = code.slice(code.indexOf("{extra.others.length > 0 && ("), code.indexOf("{isAct && ("));
    // botão de verdade (teclado de graça), acima do link esticado do card, dizendo se está aberto e o que controla
    expect(more).toMatch(/<button\s+type="button"\s+onClick=\{\(\) => setOthersOpen\(\(o\) => !o\)\}\s+aria-expanded=\{othersOpen\}\s+aria-controls=\{othersId\}/);
    expect(more).toMatch(/className="relative z-\[1\]/);
    // na cor de destaque: a pessoa vê que o «+N» abre os itens que o card junta (o cabeçalho conta itens, a coluna mostra funcionalidades)
    expect(more).toMatch(/text-\[12px\] font-medium text-accent-ink/);
    // a lista: bolinha do estado (com o nome do estado para o leitor de tela), título, há quanto tempo — e o link
    expect(more).toMatch(/<ul id=\{othersId\}/);
    expect(more).toMatch(/extra\.others\.map\(/);
    expect(more).toMatch(/<Link\s+href=\{hrefOf\(o\.id\)\}/);
    expect(more).toMatch(/STATE_TONE\[st\]\.quietDot/);
    // cada linha leva o prefixo pelo estado (fase 7); no ar (sem prefixo), o nome do estado só para o leitor de tela.
    // Prefixo e título num TEXTO SÓ que quebra nas palavras (até 2 linhas) — o prefixo fixo cortava o título no meio
    // da palavra numa coluna estreita («Esquecido: Condut…»)
    expect(more).toMatch(/<span className="line-clamp-2 min-w-0 flex-1 break-words">\s*\{itemLinePrefix\(st\) \? \(\s*<span className=\{cn\("font-semibold", STATE_TONE\[st\]\.ink\)\}>\{itemLinePrefix\(st\)\} <\/span>/);
    expect(more).not.toMatch(/truncate">\{(displayTitle\()?o\.title/);
    expect(more).toMatch(/<span className="sr-only">\{STATE_TONE\[st\]\.label\}: <\/span>/);
    // o título sem a etiqueta de máquina do começo
    expect(more).toMatch(/\{displayTitle\(o\.title\)\}/);
    expect(more).toMatch(/\{age && <span/);
    // alvo de toque de 40px no celular
    expect(more).toMatch(/max-md:min-h-10/);
  });
});

describe("uma seção pelo estado", () => {
  it("AÇÃO (precisa de você / erro): o tom do estado, o motivo e o primário que RODA a decisão do dono", () => {
    expect(code).toMatch(/const isAct = state === "attention" \|\| state === "error";/);
    expect(code).toMatch(/state === "attention" && decision\?\.primary \? \(/);
    expect(code).toMatch(/<QuickActionButton boardId=\{config\.id\} cardId=\{card\.id\} action=\{decision\.primary\} surface="kanban"/);
    // sem ação direta, o primário abre o chat com o pedido escrito (o texto do protótipo)
    expect(code).toMatch(/ask\(state === "attention" \? DRAFT\.answer : DRAFT\.investigate\)/);
    expect(copy).toMatch(/investigate: "Investigar por que parou e propor o conserto\."/);
    expect(copy).toMatch(/answer: "Responder a pergunta: "/);
  });

  it("RODANDO: a marca do agente, a mensagem ao vivo que anima ao trocar, os passos da raia e o custo", () => {
    const run = code.slice(code.indexOf("{running && ("), code.indexOf("{!isAct && !running && ("));
    expect(run).toMatch(/<AgentMark kind=\{isConducted\(card\) \? "condutor" : "execucao"\} size=\{20\} animated \/>/);
    expect(run).toMatch(/<span key=\{message\}[^>]*className="ah-tick-in/);
    expect(run).toMatch(/Array\.from\(\{ length: step\.total \}/);
    expect(run).toMatch(/\{stepText\}/);
    expect(run).toMatch(/border-dotted/);
    // o brilho de quem roda cede ao contorno do ELO card ↔ caixinha — que não acende com o menu do card aberto
    expect(code).toMatch(/const lit = highlighted && !menuOpen;/);
    expect(code).toMatch(/running && !lit \? "ah-run-glow border-transparent"/);
  });

  it("QUIETO para o resto: uma linha com borda em cima — bolinha · rótulo · mensagem ou passo", () => {
    const quiet = code.slice(code.indexOf("{!isAct && !running && ("), code.indexOf("{menuOpen && ("));
    expect(quiet).toMatch(/flex min-w-0 items-center gap-1\.5 border-t border-surface-hover/);
    expect(quiet).toMatch(/\{tone\.label\}/);
    expect(quiet).toMatch(/·/);
  });
});

describe("as ações do card (o chevron)", () => {
  it("as de conversa abrem o chat do Jido com o card em contexto e o pedido escrito — nunca executam direto", () => {
    // o card INTEIRO vai junto: o `/bug` do compositor reabre ESTE card no relato de bug (sem ele, cai na captura)
    // …e, fechada a conversa, o foco volta ao chevron do card
    expect(code).toMatch(/openJidoChat\(\{ cardId: card\.id, cardTitle: card\.title, card, draft, returnFocus: chevronRef\.current \}\)/);
    expect(code).toMatch(/\{ACTION_LABEL\.menuHint\}/);
    expect(copy).toMatch(/menuHint: "Abre na central de comando, com o pedido escrito"/);
    for (const key of ["talk", "move", "run", "stop", "deferMenu", "bug", "sync", "remove"]) expect(code, key).toMatch(new RegExp(`label: ACTION_LABEL\\.${key},`));
    for (const label of [
      // curto (uma linha de 28px no computador): o card em contexto já vai no chip «Sobre <card>» da conversa
      "Falar com o Jido",
      "Mover para outra etapa…",
      "Rodar a etapa agora",
      "Parar o condutor",
      "Adiar (não agora)",
      "Reportar um bug",
      "Sincronizar o card",
      "Excluir o card",
    ])
      expect(copy, label).toContain(`"${label}"`);
  });

  it("o menu aberto rola para a vista ACIMA do compositor e as linhas são de uma linha só (28px; 40px no toque)", () => {
    expect(code).toMatch(/menuRef\.current\?\.scrollIntoView\(\{ block: "nearest"/);
    expect(code).toContain("scroll-mb-[calc(var(--jido-composer-h,0px)_+_12px)]");
    expect(code).toMatch(/className="flex h-7 min-w-0 items-center[^"]*max-md:h-10"/);
    expect(code).toMatch(/<span className="min-w-0 truncate">\{m\.label\}<\/span>/);
  });

  // A ORDEM DO TRABALHO é a posição na coluna (fase 5): sem nota de prioridade, a pessoa diz a vez do card pelo menu.
  // As duas gravam só o `order` pela action do servidor (sem chat, sem troca de status) e ficam ANTES das de conversa,
  // com o próprio rótulo — o «Abre na central de comando…» não pode descrevê-las.
  it("«Fazer antes» e «Pode esperar» gravam a posição na coluna direto, pela action do servidor", () => {
    expect(copy).toMatch(/doFirst: "Fazer antes"/);
    expect(copy).toMatch(/canWait: "Pode esperar"/);
    expect(code).toMatch(/\{ label: ACTION_LABEL\.doFirst, where: "top" \}/);
    expect(code).toMatch(/\{ label: ACTION_LABEL\.canWait, where: "bottom" \}/);
    expect(code).toMatch(/placeCardInColumnAction\(\{ boardId: config\.id, cardId: card\.id, where \}\)/);
    expect(code).toMatch(/import \{ placeCardInColumnAction \} from "@\/app\/card-order-actions";/);
    const menu = code.slice(code.indexOf("{menuOpen && ("));
    expect(menu.indexOf("ORDER_ITEMS.map(")).toBeGreaterThan(-1);
    expect(menu.indexOf("ORDER_ITEMS.map(")).toBeLessThan(menu.indexOf("{ACTION_LABEL.menuHint}"));
    // botão de verdade, com nome, desabilitado enquanto grava, alvo de 40px no toque; Esc/foco seguem o do menu
    expect(menu).toMatch(/disabled=\{placing\}\s+onClick=\{\(\) => void place\(o\.where\)\}\s+title=\{o\.label\}/);
    // depois de gravar, o menu fecha e o foco volta ao chevron
    expect(code).toMatch(/setMenuOpen\(false\);\s+chevronRef\.current\?\.focus\(\);/);
    // no trem e no ar a posição não decide nada — as duas somem
    expect(code).toMatch(/const orderable = state !== "delivering" && state !== "live";/);
  });

  it("«Mudar autonomia» saiu do card (vai para a fase 4)", () => {
    expect(code).not.toMatch(/Mudar autonomia/);
  });
});

// A faixa antiga (prioridade · Mover · Rodar · Console · ⋮) e o arraste saíram DE PROPÓSITO: o card por funcionalidade
// diz o estado e o que fazer; mover/rodar viraram pedidos ao Jido pelo chevron, e a prioridade deixou de existir (fase
// 5: a vez do card é a posição na coluna). Prova-se a AUSÊNCIA, para nenhuma delas voltar pela porta dos fundos.
describe("o que saiu do card de propósito", () => {
  it("sem a faixa de ações antiga, sem prioridade e sem arraste", () => {
    expect(code).not.toMatch(/<MoveToPopover|<KanbanCardRunButton|<KanbanCardConsoleButton|<KanbanCardNextAction|<CardRunStatusBadge/);
    expect(code).not.toMatch(/cardPriorityTier|priorityScore|priorityCall|ACTION_LABEL\.prioritize/);
    expect(code).not.toMatch(/useSortable|@dnd-kit/);
  });
});
