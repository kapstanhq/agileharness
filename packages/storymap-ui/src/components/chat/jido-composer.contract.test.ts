import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// O CONTRATO do compositor do Jido, contra o fonte. O rig é node sem DOM (render RTL não roda aqui — ver
// card-live-status-surfaces.test.ts): o que é decisão mora nos módulos puros (jido-bus, jido-commands, jido-context,
// testados à parte) e aqui se afirma que os componentes OBEDECEM a eles e ao desenho — sem isto, trocar o atalho de
// envio, esquecer o Esc ou voltar a ter dois campos de texto na mesma conversa passaria em todos os testes puros.

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const composer = src("./JidoComposer.tsx");
const overlay = src("./ChatOverlay.tsx");
const panel = src("./ChatPanel.tsx");
const copilot = src("../CopilotChat.tsx");
const mark = src("./JidoMark.tsx");
const hitl = src("../hitl/HitlConversation.tsx");

describe("as props do compositor (o contrato com quem o monta)", () => {
  it("exporta JidoComposerProps com boardId, config e view (+ a captura opcional da tela), e o componente nomeado", () => {
    expect(composer).toMatch(/export interface JidoComposerProps \{\s*boardId: string;\s*config: BoardConfig;\s*view: BoardView;[\s\S]*?onCapture\?: \(initialText\?: string\) => void;\s*\}/);
    expect(composer).toMatch(/export function JidoComposer\(\{[^}]*\}: JidoComposerProps\)/);
    expect(composer).not.toMatch(/export default/);
  });
});

describe("o compositor fechado e aberto (o desenho)", () => {
  it("o convite do campo é o do design, 15px no computador alto (16px no celular: o iOS não dá zoom), duas linhas, mínimo de 56px", () => {
    expect(composer).toContain('export const JIDO_PLACEHOLDER = "Pergunte ao Jido ou digite / para comandos";');
    expect(composer).toMatch(/rows=\{compact \? 1 : 2\}/);
    expect(composer).toMatch(/text-\[16px\][^"]*tall:min-h-\[56px\][^"]*tall:text-\[15px\]/);
  });
  it("no celular E no computador baixo o compositor é COMPACTO: Jido de 24px, campo de uma linha que cresce até ~5 linhas, `/` e enviar na mesma fileira, convite curto", () => {
    // a query é a de lib/viewport (celular OU altura < 800px) — o desenho inteiro é a variante `tall:`
    expect(composer).toContain("const COMPACT_QUERY = COMPACT_COMPOSER_QUERY;");
    expect(composer).toContain("const compact = useMediaQuery(COMPACT_QUERY);");
    // nenhuma classe `md:` sobrou na faixa: no computador baixo ela valeria e desmontaria o compacto
    const strip = composer.slice(composer.indexOf("data-jido-composer"), composer.indexOf("{capture && ("));
    expect(strip).not.toMatch(/(?<![-\w])md:/);
    expect(composer).toContain('export const JIDO_PLACEHOLDER_SHORT = "Pergunte ao Jido…";');
    expect(composer).toMatch(/placeholder=\{api\?\.placeholder \?\? \(compact \? JIDO_PLACEHOLDER_SHORT : JIDO_PLACEHOLDER\)\}/);
    expect(composer).toMatch(/<JidoMark size=\{compact \? 24 : 28\}/);
    expect(composer).toMatch(/Math\.min\(el\.scrollHeight, compact \? 136 : 168\)/);
    // uma fileira só: a caixa quebra no computador (o campo ocupa a linha inteira) e não quebra no celular
    expect(composer).toMatch(/className="flex flex-wrap items-end[^"]*"/);
    expect(composer).toMatch(/min-h-10 min-w-0 flex-1[^"]*tall:basis-\[calc\(100%-2\.75rem\)\]/);
    // no computador baixo os alvos são de mouse (32px): a fileira fica com ~46px
    expect(composer).toMatch(/short:min-h-8 short:py-1/);
    expect(composer.match(/short:h-8 short:w-8/g)).toHaveLength(2);
    // o safe-area do rodapé vale nos dois tamanhos
    expect(composer).toContain("pb-[max(12px,env(safe-area-inset-bottom))]");
  });
  it("a caixa de escrever tem só `/` e enviar, aberta ou fechada (uma fileira no celular); o anexo e o anel da sessão moram no TOPO da conversa aberta", () => {
    // o anexo é do topo da conversa (ChatOverlay `headerTools`), que só monta aberta — nunca uma 2ª linha da caixa
    const tools = composer.slice(composer.indexOf("const headerTools = ("), composer.indexOf("return (", composer.indexOf("const headerTools = (")));
    expect(tools).toMatch(/<input\s*ref=\{fileRef\}/);
    expect(tools).toMatch(/aria-label="Anexar imagem"/);
    expect(composer).toMatch(/headerTools=\{headerTools\}/);
    expect(composer).not.toMatch(/max-md:order-last max-md:basis-full/);
    expect(composer).not.toMatch(/ref=\{setMeterSlot\}/);
    expect(overlay).toMatch(/\{headerTools\}\s*\{\/\*[^]*?\*\/\}\s*<span ref=\{setActionsSlot\}/);
  });
  it("a borda escurece com CONTEÚDO (#A8A59D do desenho), não com o foco — o foco do teclado tem anel próprio, NEUTRO", () => {
    expect(composer).toMatch(/hasContent \? "border-st-forgot" : "border-line"/);
    expect(composer).not.toMatch(/focus-within:border/);
    expect(composer).toMatch(/has-\[textarea:focus-visible\]:ring-2 has-\[textarea:focus-visible\]:ring-fg\/10/);
    // nada de âmbar na caixa de escrever: âmbar é o tom de "precisa de você"
    expect(composer).not.toMatch(/ring-accent|border-accent|outline-accent/);
  });
  it("a caixa: até 760px, raio 16, a sombra do design; a faixa no rodapé com a sarjeta de 16px e o safe-area", () => {
    expect(composer).toMatch(/max-w-\[760px\][^"]*rounded-2xl/);
    expect(composer).toContain("shadow-[0_8px_28px_rgba(15,15,15,0.10)]");
    expect(composer).toMatch(/fixed inset-x-0 bottom-0[^"]*px-4/);
    expect(composer).toContain("tall:pb-[max(20px,env(safe-area-inset-bottom))]");
  });
  it("o degradê fechado: 56px só no computador alto; 24px no compacto (celular e computador baixo)", () => {
    expect(composer).toMatch(/fixed inset-x-0 bottom-0 flex justify-center px-4 pt-6 tall:pt-14"/);
  });
  it("TOCAR no campo ou ESCREVER abre a conversa (o foco sozinho, não — o Tab passa); Enter envia, Shift+Enter quebra a linha, Esc fecha", () => {
    // o desenho abria no foco; o compositor vem antes do quadro na ordem do Tab, e abrir no foco prendia o teclado
    expect(composer).not.toMatch(/onFocus=/);
    expect(composer).toMatch(/onPointerDown=\{openByHand\}/);
    expect(composer).toMatch(/setText\(v\);[\s\S]{0,160}openByHand\(\);/);
    expect(composer).toMatch(/if \(e\.key === "Enter" && !e\.shiftKey\) \{\s*e\.preventDefault\(\);\s*submit\(\);/);
    expect(composer).toMatch(/if \(e\.key === "Escape"\) \{\s*e\.preventDefault\(\);\s*closeChat\(\);/);
    // e o Esc vale de qualquer lugar da conversa aberta
    expect(composer).toMatch(/e\.key === "Escape" && !e\.defaultPrevented\) closeChat\(\)/);
  });
  it("o envio só tem o peso escuro quando há o que enviar; tem nome para leitor de tela", () => {
    expect(composer).toMatch(/canSend \? "bg-fg hover:bg-fg\/85" : "bg-line-emphasis"/);
    expect(composer).toMatch(/aria-label="Enviar"/);
    expect(composer).toMatch(/aria-label="Comandos do Jido"/);
  });
  it("o chip «Sobre <…>» com × aparece com um card ou uma escalação em contexto", () => {
    expect(composer).toMatch(/Sobre <b className="font-semibold text-fg">\{chipLabel\}<\/b>/);
    expect(composer).toMatch(/const chipLabel = seed \? escalationRefLabel\(seed\.ref\) : card \? cardChipLabel\(card\) : null;/);
  });
  it("aberta, é um diálogo MODAL de verdade: papel, nome, o resto da página `inert` e o foco de volta a quem abriu", () => {
    expect(composer).toMatch(/role=\{open \? "dialog" : undefined\}/);
    expect(composer).toMatch(/aria-modal=\{open \? true : undefined\}/);
    // o nome diz COM QUEM é a conversa: o Jido do board, ou o assistente do documento numa página de documento
    expect(composer).toMatch(/aria-label=\{open \? \(docSurface \? `Conversa: \$\{docSurface\.label\}` : "Conversa com o Jido"\) : undefined\}/);
    expect(composer).toMatch(/return inertOutside\(rootRef\.current\);/);
    expect(composer).toMatch(/if \(back\) requestAnimationFrame\(\(\) => back\.isConnected && back\.focus\(\)\);/);
    expect(composer).toMatch(/returnFocusRef\.current =\s*input\.returnFocus \?\?/);
  });
  it("escolher um comando na lista o ESCREVE no campo (o desenho) — quem roda é o Enter", () => {
    expect(composer).toMatch(/const pick = \(c: JidoCommand\) => \{\s*setText\(composerTextFor\(c\)\);/);
    expect(composer).not.toMatch(/const pick = [\s\S]{0,200}runCommand\(/);
  });
  it("o véu cobre a tela (clique fora fecha) e o «Fechar Esc» fica no canto; a coluna termina no compositor", () => {
    expect(overlay).toMatch(/aria-label="Fechar a conversa"\s*onClick=\{onClose\}\s*className="fixed inset-0/);
    expect(overlay).toMatch(/title="Fechar \(Esc\)"/);
    expect(overlay).toContain('bottom: "var(--jido-composer-h, 190px)"');
    // o topo da coluna some num degradê de 40px e o transcript reserva esses 40px: nenhuma linha cortada ao meio sob
    // a fileira dos ícones (no computador e no celular)
    expect(overlay).toContain("[mask-image:linear-gradient(to_bottom,transparent,#000_40px)]");
    expect(overlay).toContain("[&_.chat-scroll]:pt-10");
    expect(overlay).toContain("max-w-[760px]");
    expect(composer).toMatch(/setProperty\("--jido-composer-h"/);
    expect(composer).toMatch(/removeProperty\("--jido-composer-h"\)/);
  });
});

describe("o topo da conversa aberta (o desenho: só «Fechar Esc» no canto)", () => {
  it("histórico e nova conversa (e o anel de contexto) são ícones na MESMA fileira, logo à esquerda do «Fechar»", () => {
    const corner = overlay.slice(overlay.indexOf('<div className="fixed right-3 top-3'), overlay.indexOf('title="Fechar (Esc)"'));
    expect(corner).toContain("ref={setActionsSlot}");
    expect(panel).toMatch(/\{chatActions\}\s*<\/>,\s*externalComposer\.actionsSlot/);
  });
  it("sem barra flutuante no modo de fora: nem o seletor de modo (Chat ▾), nem os ajustes, nem a técnica", () => {
    expect(panel).toMatch(/topBar=\{\s*external \? undefined : \(/);
    // o cockpit não monta os controles de modo/ajustes com o compositor de fora — só a sonda sem tela (o rosto e o
    // diário do tick continuam sabendo o nível do board)
    expect(copilot).toMatch(/externalComposer \? undefined : <CopilotChatControls /);
    expect(copilot).toMatch(/\{externalComposer && <CopilotStatusProbe boardId=\{boardId\} onStatus=\{handleStatus\} \/>\}/);
  });
  it("as respostas e ações do Jido são botões de borda EM LINHA (30px, borda, raio 8, 13px/600), não pílulas de largura cheia", () => {
    expect(hitl).toMatch(/const JIDO_ACTION_BTN =\s*"inline-flex h-10 [^"]*rounded-lg border border-line bg-surface px-3 text-\[13px\] font-semibold[^"]*md:h-\[30px\]"/);
    expect(hitl).toMatch(/suggestionClassName=\{jido \? JIDO_ACTION_BTN : undefined\}/);
    expect(hitl).toMatch(/inlineOptionClassName=\{jido \? JIDO_ACTION_BTN : undefined\}/);
  });
});

describe("a porta de fora (jido-bus)", () => {
  it("o compositor se inscreve, aplica o card, o rascunho e a semente, abre e põe o cursor no fim", () => {
    expect(composer).toMatch(/onOpenJidoChat\(\(input\) => \{/);
    expect(composer).toMatch(/setCard\(input\.cardId \? \{ id: input\.cardId, title: input\.cardTitle, card: input\.card \} : null\)/);
    expect(composer).toMatch(/if \(input\.draft !== undefined\) setText\(input\.draft\);/);
    expect(composer).toMatch(/setSeed\(input\.seed\)/);
    expect(composer).toMatch(/el\.setSelectionRange\(end, end\)/);
  });
  it("o rascunho NUNCA é enviado sozinho: o único envio é o submit (Enter ou botão) e os comandos", () => {
    const sends = [...composer.matchAll(/\.send\(/g)].length;
    // um no submit, um no comando-pergunta
    expect(sends).toBe(2);
    expect(composer).toMatch(/a\.send\(withCardContext\(card, t\)/);
  });
});

describe("os comandos", () => {
  it("/criar abre a captura (lazy), /bug o BugModal com o card em mão ou a captura, ritmo pela action do botão de ritmo", () => {
    expect(composer).toMatch(/const SmartCaptureModal = dynamic\(/);
    expect(composer).toMatch(/const BugModal = dynamic\(/);
    expect(composer).toMatch(/case "criar":[\s\S]{0,120}openCapture\(args \|\| undefined\)/);
    expect(composer).toMatch(/if \(card\?\.card\) setBugCard\(card\.card\);\s*else openCapture\(bugCaptureText\(args\)\);/);
    // a captura é a da TELA quando ela a oferece (o modal dela leva os cards do board como contexto); senão a própria
    expect(composer).toMatch(/if \(onCapture\) onCapture\(initialText\);\s*else setCapture\(\{ initialText \}\);/);
    expect(composer).toMatch(/setBoardPaceAction\(\{[\s\S]{0,400}mode: pause \? "drain" : undefined/);
    // o board desligado só liga com confirmação (a mesma regra do botão de ritmo)
    expect(composer).toMatch(/source === "disarmed"\) \{\s*if \(!window\.confirm\(PACE_ARM_CONFIRM\)\)/);
    // a confirmação é escrita NA conversa
    expect(composer).toMatch(/a\.notice\(r\.ok \? r\.data\.message :/);
  });
  it("os da conversa vão ao painel, respeitando o turno em voo", () => {
    expect(composer).toMatch(/if \(busy && !c\.whileBusy\)/);
    expect(composer).toMatch(/withApi\(\(a\) => a\.runCommand\(c\.name\)\)/);
  });
});

describe("o mascote do compositor", () => {
  it("antena verde pulsando com agente trabalhando; olhos em traço com o board pausado", () => {
    expect(mark).toMatch(/mood\.working \? "fill-state-live state-pulse"/);
    expect(mark).toMatch(/mood\.paused \? \(/);
    expect(mark).toMatch(/viewBox="0 -6 16 22"/);
    expect(composer).toMatch(/agentPulse\(presence, boardId\)\.working > 0/);
    expect(composer).toMatch(/const paused = pace\.view\?\.level === "paused";/);
  });
});

describe("UM motor, UMA caixa de texto", () => {
  // Fase 2: numa página de DOCUMENTO (Negócio, Produto, Design) o compositor do rodapé é a conversa DAQUELE documento —
  // o mesmo núcleo (ChatPanel, via ViewChat) na raia da superfície, com o compositor de fora. A escalação `?copilot=`
  // continua sendo do Jido do board: com uma semente, a conversa aberta é a dele.
  it("numa página de documento a conversa é a da SUPERFÍCIE, pelo mesmo compositor de fora", () => {
    const viewTag = overlay.slice(overlay.indexOf("<ViewChat"), overlay.indexOf("/>", overlay.indexOf("<ViewChat")));
    expect(viewTag).toContain("view={surface.view}");
    expect(viewTag).toContain("getContext={surface.getContext}");
    expect(viewTag).toContain("externalComposer={{ ...externalComposer, actionsSlot }}");
    expect(viewTag).not.toContain("onClose");
    expect(overlay).toMatch(/\{surface \? \(\s*<ViewChat/);
    expect(composer).toMatch(/const docSurface = seed \? undefined : surface;/);
    expect(composer).toMatch(/surface=\{docSurface\}/);
  });

  it("a conversa aberta é o CopilotChatPanel de sempre, com o compositor de fora e sem onClose (o host fecha)", () => {
    const panelTag = overlay.slice(overlay.indexOf("<CopilotChatPanel"), overlay.indexOf("/>", overlay.indexOf("<CopilotChatPanel")));
    expect(panelTag).toContain("externalComposer={{ ...externalComposer, actionsSlot }}");
    expect(panelTag).not.toContain("onClose");
    expect(composer).toMatch(/const ChatOverlay = dynamic\(/);
    expect(copilot).toContain("externalComposer={externalComposer}");
  });
  it("no modo de fora, o painel entrega a API e esconde o PRÓPRIO compositor (o rodapé do HitlConversation)", () => {
    expect(panel).toMatch(/className=\{cn\("h-full", external && "\[&>div:last-child\]:hidden"\)\}/);
    expect(panel).toMatch(/draft=\{external \? undefined : draft\}/);
    expect(panel).toMatch(/composerExtra=\{external \? undefined : sessionMenu\}/);
    // as ferramentas da conversa (o anel de contexto, o histórico, a nova conversa) vão juntas para o CANTO da moldura;
    // o compositor do rodapé fica com o do desenho (`/` e enviar). Sem o canto, o anel cai na barra do compositor.
    // (a conversa de um documento põe antes o seletor de TÉCNICA dela — sem a barra do topo, ele também vai ao canto)
    expect(panel).toMatch(/createPortal\(\s*<>[\s\S]{0,400}?\{techniques\?\.length \? <TechniquePicker[^\n]*\n\s*\{sessionMenu\}\s*\{chatActions\}\s*<\/>,\s*externalComposer\.actionsSlot,?\s*\)/);
    expect(panel).toMatch(/placement=\{external && externalComposer\?\.actionsSlot \? "corner" : "composer"\}/);
    expect(panel).toMatch(/createPortal\(sessionMenu, externalComposer\.meterSlot\)/);
    expect(panel).toMatch(/useEffect\(\(\) => \(\) => onApiRef\.current\?\.\(null\), \[\]\);/);
  });
  it("…o que só funciona porque o rodapé (erro + composer) é o ÚLTIMO filho da raiz do HitlConversation", () => {
    const footer = hitl.indexOf('<div className={cn("space-y-2", full && cn("shrink-0 pb-3 pt-1", GUTTER))}>');
    expect(footer).toBeGreaterThan(0);
    const rest = hitl.slice(footer);
    // depois do rodapé não nasce nenhum irmão: nem o slot acima do composer, nem o transcript, nem o pill
    expect(rest).not.toMatch(/\{beforeComposer\}|ref=\{scrollRef\}|showJump &&|\{afterTurns\}/);
    expect(rest).toMatch(/<\/div>\s*\)\}\s*<\/div>\s*<\/div>\s*\);\s*\}\s*$/);
  });
});
