// O PEDIDO DE ESCOLHA ("ask") — o protocolo pelo qual o AGENTE pergunta com uma UI de escolhas em vez de
// pedir que o operador digite a resposta por extenso.
//
// POR QUE ELE EXISTE: a persona do copiloto já mandava "faça no máximo uma pergunta curta por vez (com 2-3
// quick-replies quando ajudar)" — mas não havia NENHUM caminho pelo qual um quick-reply do agente chegasse à
// tela. As `options` de um `HitlAgentTurn` só eram preenchidas pelo CLIENTE (o greeting, os chips de pergunta
// de card, as aprovações). Era uma capacidade DECLARADA com zero produtores: parece feature, nunca dispara.
//
// COMO FUNCIONA: o agente emite um bloco cercado no meio da resposta dele —
//
//     ```jido-ask
//     {"question":"Qual caminho?","options":[{"label":"Refatorar agora","description":"Paga a dívida antes que
//      o próximo card encoste nela — custa ~1h e segura a entrega de hoje."},{"label":"Só documentar"}]}
//     ```
//
// — e este módulo (PURO, sem React e sem IO) o EXTRAI do texto: o bloco some da leitura e vira um {@link AskSpec}
// que a UI desenha como escolhas. Cinco invariantes que valem o comentário:
//
//  1. STREAMING-SAFE. O texto chega token-a-token: durante alguns frames o bloco existe ABERTO, sem a cerca de
//     fechamento, e o JSON está pela metade. Um parser ingênuo despejaria `{"question":"Qual cam` na tela do
//     operador. Aqui um bloco aberto é RECORTADO do texto e marcado `pending` — a UI mostra a prosa e espera.
//  2. NUNCA MOSTRA JSON. Bloco malformado (o modelo errou a mão) também é recortado: o operador vê a prosa em
//     volta (que quase sempre já traz a pergunta) e segue conversando pelo composer. `malformed` fica no
//     retorno para teste/diagnóstico — a UI não pinta nada com ele.
//  3. A RESPOSTA ABERTA É SEMPRE UMA OPÇÃO. Toda escolha oferecida pelo agente ganha a saída "escrever a minha"
//     — uma lista fechada de 3 botões é uma armadilha quando a resposta certa é a quarta. Por isso `openAnswer`
//     nasce true e o `false` do JSON é IGNORADO: é decisão de produto, não do modelo.
//  4. ESCOLHA **OU** ATALHO — NUNCA OS DOIS. Uma pergunta com opções é uma DECISÃO; um chip de resposta rápida
//     é ECONOMIA DE DIGITAÇÃO. Oferecer as duas famílias na mesma resposta (era o que acontecia) põe na tela
//     dois grupos de botões que se parecem e não fazem a mesma coisa: o operador tinha de descobrir, botão a
//     botão, qual respondia a pergunta e qual mudava de assunto. Havendo opções, as `suggestions` CAEM aqui,
//     no núcleo — não é decisão de estilo da UI, é a forma do dado.
//  5. A DESCRIÇÃO É DO AGENTE, e é o que faz a escolha valer. Cada opção carrega uma `description` livre — o
//     que acontece se escolher, o custo, o que ele já apurou. Antes só havia `pros`/`cons` (bullets que a tela
//     pintava com "+"/"−"), e um `hint` que virava um "pro" solitário: o agente escrevia um esclarecimento e o
//     operador lia um argumento a favor. Uma frase do agente merecia um campo próprio.
//
// A mesma forma serve às escolhas de CLIENTE (greeting, chips de pergunta): `agentTurnView` devolve UM
// AskSpec para a UI, venha ele do texto do agente ou dos campos do turno. Um só desenho de escolha na tela.

import type { HitlAgentTurn, HitlOption, HitlSegment } from "./types";

/** A linguagem da cerca. `jido-ask` (e não `json`) para que um bloco de JSON comum nunca vire UI por acidente. */
export const ASK_FENCE_LANG = "jido-ask";

// Tetos defensivos — o que o modelo emitir além disto é cortado. Eles guardam o LAYOUT (um painel de ~490px),
// não o estilo: o rótulo é uma linha de botão (curto por natureza), a DESCRIÇÃO é onde o agente fala à vontade
// — duas linhas confortáveis —, e a lista para em 5 opções porque acima disso ninguém decide, rola.
const MAX_OPTIONS = 5;
const MAX_SUGGESTIONS = 4;
const MAX_LABEL = 120;
const MAX_DESCRIPTION = 260;
const MAX_SUGGESTION = 90;
const MAX_QUESTION = 400;

/** O rótulo default da opção ABERTA — a que devolve a palavra ao operador. */
export const OPEN_ANSWER_LABEL = "Escrever a minha resposta";

/** O id sintético da opção aberta. Nunca vai para o agente como id: escolher a aberta foca o composer. */
export const OPEN_ANSWER_ID = "__open_answer";

/**
 * Um pedido de escolha pronto para desenhar. É a ÚNICA forma que a UI de escolhas conhece — as duas fontes
 * (bloco do agente / campos do turno) convergem aqui.
 */
export interface AskSpec {
  /** a pergunta em si, quando o agente a separou do corpo. Ausente ⇒ a prosa acima já perguntou. */
  question?: string;
  options: HitlOption[];
  mode: "single" | "multi";
  /** mostra a opção ABERTA (foca o composer). Sempre true num ask do agente. */
  openAnswer: boolean;
  /** rótulo da opção aberta. */
  openLabel: string;
  /**
   * Respostas rápidas — um toque ENVIA o texto do chip, como se o operador o tivesse digitado. Elas NÃO
   * respondem a uma escolha: são o próximo passo provável de uma conversa que não perguntou nada. Por isso
   * são MUTUAMENTE EXCLUSIVAS com `options` (invariante 4 no topo) — havendo opções, esta lista vem vazia.
   */
  suggestions: string[];
}

/** O resultado do recorte de um texto: o que se lê, o que se escolhe, e o que ainda está chegando. */
export interface AskParse {
  /** o texto SEM os blocos de ask (é isto que vai para o markdown). */
  text: string;
  /** o último ask VÁLIDO encontrado (o mais recente vence — o agente pode reformular na mesma resposta). */
  ask: AskSpec | null;
  /** há um bloco ABERTO no fim do texto (ainda streamando) ⇒ a escolha está a caminho. */
  pending: boolean;
  /** houve bloco fechado que não parseou (diagnóstico/teste — a UI ignora). */
  malformed: boolean;
}

const EMPTY_PARSE: AskParse = { text: "", ask: null, pending: false, malformed: false };

function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Aceita `"rótulo"` ou `{id?, label|text, description|detail|hint?, pros?, cons?, recommended?}` — o modelo
 * escolhe o que é mais natural para o que ele tem a dizer.
 *
 * `description` é a forma PRINCIPAL de explicar uma opção: prosa livre do agente, na língua do operador.
 * `pros`/`cons` continuam válidos (é o shape das perguntas de CARD, que a fila /perguntas escreve), mas não
 * são mais o único jeito de falar — e um `hint`, que antes era espremido num `pros` de um item só (a tela
 * desenhava "+ …" num esclarecimento neutro), agora cai onde sempre pertenceu: na descrição.
 */
function coerceOption(raw: unknown, i: number): HitlOption | null {
  if (typeof raw === "string") {
    const label = clamp(raw, MAX_LABEL);
    return label ? { id: `o${i + 1}`, label } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rawLabel = typeof o.label === "string" ? o.label : typeof o.text === "string" ? o.text : "";
  const label = clamp(rawLabel, MAX_LABEL);
  if (!label) return null;
  const id = typeof o.id === "string" && o.id.trim() && o.id.trim() !== OPEN_ANSWER_ID ? o.id.trim() : `o${i + 1}`;
  const rawDesc = [o.description, o.detail, o.hint, o.why].find((v) => typeof v === "string" && v.trim());
  const description = typeof rawDesc === "string" ? clamp(rawDesc, MAX_DESCRIPTION) : "";
  const pros = strings(o.pros);
  const cons = strings(o.cons);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    ...(pros.length ? { pros } : {}),
    ...(cons.length ? { cons } : {}),
    ...(o.recommended === true ? { recommended: true } : {}),
  };
}

function strings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string").map((s) => clamp(s, MAX_LABEL)).filter(Boolean);
}

/** JSON cru → AskSpec normalizado. Devolve null quando não sobra escolha nenhuma para oferecer. */
export function coerceAsk(raw: unknown): AskSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const options = (Array.isArray(o.options) ? o.options : [])
    .map(coerceOption)
    .filter((x): x is HitlOption => x != null)
    .slice(0, MAX_OPTIONS);
  const suggestions = strings(o.suggestions ?? o.chips)
    .map((s) => clamp(s, MAX_SUGGESTION))
    .slice(0, MAX_SUGGESTIONS);
  const question = typeof o.question === "string" ? clamp(o.question, MAX_QUESTION) : "";
  // Um ask sem opção E sem sugestão não é escolha nenhuma — deixa a conversa como está (o composer basta).
  if (!options.length && !suggestions.length) return null;
  return {
    ...(question ? { question } : {}),
    options,
    mode: o.mode === "multi" || o.multi === true ? "multi" : "single",
    // Decisão de PRODUTO, não do modelo: a saída aberta existe sempre que há opções (ver o doc do módulo).
    openAnswer: options.length > 0,
    openLabel: typeof o.openLabel === "string" && o.openLabel.trim() ? clamp(o.openLabel, MAX_LABEL) : OPEN_ANSWER_LABEL,
    // Invariante 4: pergunta é decisão, chip é digitação. Com opções na tela, os atalhos caem — aqui, e não
    // na UI, para que qualquer superfície que desenhe um AskSpec herde a regra sem ter de lembrar dela.
    suggestions: options.length ? [] : suggestions,
  };
}

/** Normaliza uma frase para COMPARAÇÃO: sem ênfase de markdown, sem pontuação final, minúscula. */
function normalizeSentence(s: string): string {
  return s
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?!.:…]+$/g, "")
    .toLowerCase();
}

/**
 * A prosa já TERMINA com esta pergunta?
 *
 * O agente escreve bem quando fecha o raciocínio com a pergunta ("…então: por onde começo?") — e é isso que a
 * persona pede. Só que ele também precisa passar a pergunta no JSON para a escolha ter título. O resultado na
 * tela era a MESMA frase duas vezes, uma coladinha na outra, com a segunda em outro tamanho: parecia defeito de
 * render. Aqui a régua é a do LEITOR — se a última linha visível já faz a pergunta, a escolha não a repete.
 */
export function questionEchoesText(text: string, question: string): boolean {
  const q = normalizeSentence(question);
  if (!q) return false;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return false;
  const l = normalizeSentence(last);
  // `endsWith` (e não `===`) porque a linha costuma trazer um fecho antes da pergunta ("Beleza. Por onde começo?").
  return l === q || l.endsWith(q);
}

/**
 * Recorta os blocos ```jido-ask de um texto de agente. Pura e defensiva — ver as 3 invariantes no topo.
 *
 * O varredor é manual (e não um regex global) porque o caso que mais importa é o bloco ABERTO no fim do
 * streaming: um regex que exige a cerca de fechamento simplesmente não casa, e o JSON pela metade vazaria
 * para a tela em todo turno com pergunta.
 */
export function parseAskBlocks(input: string): AskParse {
  if (!input) return EMPTY_PARSE;
  // ATALHO barato — e não é micro-otimização: durante o streaming isto roda para TODO segmento de TODO
  // turno a cada token. Sem o `includes` (um indexOf nativo), cada tecla do agente pagaria uma varredura
  // de regex pelo transcript inteiro. A esmagadora maioria dos textos não tem bloco nenhum.
  if (!input.includes("```" + ASK_FENCE_LANG)) return { text: input, ask: null, pending: false, malformed: false };
  const openRe = new RegExp(`(^|\\n)[ \\t]*\`\`\`${ASK_FENCE_LANG}[ \\t]*(?:\\r?\\n|$)`, "g");
  let out = "";
  let cursor = 0;
  let ask: AskSpec | null = null;
  let pending = false;
  let malformed = false;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(input))) {
    const blockStart = m.index + (m[1] ? m[1].length : 0); // preserva o \n que antecede a cerca
    const bodyStart = m.index + m[0].length;
    out += input.slice(cursor, blockStart);
    // a cerca de fechamento: uma linha que começa com ``` (o modelo às vezes indenta).
    const closeRe = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/g;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(input);
    if (!close) {
      // AINDA CHEGANDO: engole o resto do texto e para. O que veio depois de uma cerca aberta é o JSON.
      pending = true;
      cursor = input.length;
      break;
    }
    const body = input.slice(bodyStart, close.index);
    try {
      const parsed = coerceAsk(JSON.parse(body));
      if (parsed) ask = parsed;
      else malformed = true;
    } catch {
      malformed = true;
    }
    cursor = close.index + close[0].length;
    openRe.lastIndex = cursor;
  }
  out += input.slice(cursor);
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), ask, pending, malformed };
}

/** A escolha que veio dos CAMPOS do turno (greeting, chips de pergunta de card, aprovações). */
export function askFromTurn(turn: HitlAgentTurn): AskSpec | null {
  const options = turn.options ?? [];
  const suggestions = strings(turn.suggestions).map((s) => clamp(s, MAX_SUGGESTION)).slice(0, MAX_SUGGESTIONS);
  if (!options.length && !suggestions.length) return null;
  return {
    options,
    mode: turn.mode ?? "single",
    // Aqui a abertura é do PRODUTOR: o menu de ações do greeting não é uma pergunta (não há "outra resposta"
    // a escrever), mas a pergunta de um card é — e é ela que passa `openAnswer`.
    openAnswer: Boolean(turn.openAnswer) && options.length > 0,
    openLabel: OPEN_ANSWER_LABEL,
    // Mesma invariante 4 do bloco do agente: o greeting com ações pendentes ("Revisar 2 aprovações") não
    // empilha os três atalhos de digitação embaixo delas. Sem ações, os atalhos são a única oferta e valem.
    suggestions: options.length ? [] : suggestions,
  };
}

/** A visão RENDERIZÁVEL de um turno do agente: conteúdo já limpo + a escolha, venha ela do texto ou do turno. */
export interface AgentTurnView {
  /** segmentos com o texto já recortado (o modelo novo, streaming inline). */
  segments?: HitlSegment[];
  /** a mensagem já recortada (o modelo legado dos popovers HITL). */
  message: string;
  ask: AskSpec | null;
  /** um bloco de ask está chegando (a UI segura a escolha em vez de piscar meia lista). */
  pending: boolean;
}

/**
 * Aplica o recorte a um turno inteiro. O ask do TEXTO vence o dos campos: quando o agente escreveu a escolha
 * nesta resposta, é ela que vale — os campos só carregam escolhas de cliente, que nunca coexistem com um bloco.
 */
export function agentTurnView(turn: HitlAgentTurn): AgentTurnView {
  // Acumulador em OBJETO (e não `let` capturado por closure): o TypeScript não rastreia atribuição feita
  // dentro de um callback e estreitaria `ask` para `null` no uso lá embaixo — um bug de tipo silencioso.
  const acc: { asks: AskSpec[]; pending: boolean } = { asks: [], pending: false };
  const absorb = (p: AskParse) => {
    if (p.ask) acc.asks.push(p.ask);
    if (p.pending) acc.pending = true;
  };
  let segments: HitlSegment[] | undefined;
  if (turn.segments) {
    segments = turn.segments.map((s) => {
      if (s.type !== "text") return s;
      const p = parseAskBlocks(s.text);
      absorb(p);
      return p.text === s.text ? s : { ...s, text: p.text };
    });
  }
  const parsedMsg = turn.message ? parseAskBlocks(turn.message) : EMPTY_PARSE;
  absorb(parsedMsg);
  const ask = acc.asks[acc.asks.length - 1] ?? askFromTurn(turn);
  return {
    ...(segments ? { segments } : {}),
    message: parsedMsg.text,
    ask: withoutEchoedQuestion(ask, visibleTail(segments, parsedMsg.text)),
    pending: acc.pending,
  };
}

/** O último pedaço de texto que o operador LÊ neste turno (o fim da prosa, ignorando tools e vazios). */
function visibleTail(segments: HitlSegment[] | undefined, message: string): string {
  if (!segments?.length) return message;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.type === "text" && s.text.trim()) return s.text;
  }
  return "";
}

/** Tira o título da escolha quando a prosa acima já perguntou a mesma coisa (ver {@link questionEchoesText}). */
function withoutEchoedQuestion(ask: AskSpec | null, tail: string): AskSpec | null {
  if (!ask?.question || !questionEchoesText(tail, ask.question)) return ask;
  const { question: _echoed, ...rest } = ask;
  return rest;
}
