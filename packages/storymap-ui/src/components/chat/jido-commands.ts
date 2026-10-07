// OS COMANDOS do compositor do Jido — a lista do botão `/` e o que cada um faz. PURO (sem React): o compositor
// desenha e despacha, os testes leem daqui.
//
// Duas famílias, e a diferença é de QUEM resolve:
//   • os do BOARD (`/criar`, `/bug`, `/resumo`, `/pendente`, `/travou`, `/pausar` | `/retomar` | `/ligar`) — em português,
//     porque falam do trabalho do board. Uns abrem um fluxo que já existe (a captura, o relato de bug), uns mudam o
//     ritmo do board pela MESMA action do botão de ritmo, e os de pergunta viram um pedido escrito ao Jido.
//   • os da CONVERSA (`/clear`, `/compact`, `/context`, `/model`) — os do núcleo do chat (ChatPanel CORE_COMMANDS),
//     com os nomes do Claude Code de propósito (memória muscular não se traduz). Quem os roda é o painel. Eles NÃO
//     entram na lista do botão `/` (o desenho lista exatamente os seis do board): aparecem quando se DIGITA o começo
//     do nome (`/cl` → /clear) e rodam digitados.
//
// Escolher um comando na lista NÃO o roda: escreve o comando no campo (`/criar `, `/resumo`…) e a pessoa completa e
// aperta Enter — como no desenho.
//
// A regra de digitação é a de hitl/slash: a barra só vale no COMEÇO; comando desconhecido não é erro, é texto.

import { slashQuery } from "@/lib/storymap/hitl/slash";

export type JidoBoardCommand = "criar" | "bug" | "resumo" | "pendente" | "travou" | "pausar" | "retomar" | "ligar";

/**
 * O estado do ritmo que decide o 6º comando: rodando ⇒ `/pausar`; pausado ⇒ `/retomar`; DESLIGADO (o board nunca foi
 * armado, ou foi desarmado) ⇒ `/ligar` — «retomar» um board desligado não casava com o que o painel de ritmo chama
 * de «Ligar». `true`/`false` = pausado / rodando (a forma antiga).
 */
export type JidoPaceState = boolean | "off";
export type JidoCoreCommand = "clear" | "compact" | "context" | "model";
export type JidoCommandName = JidoBoardCommand | JidoCoreCommand;

export interface JidoCommand {
  name: JidoCommandName;
  /** a linha da lista — o que ele faz, em poucas palavras. */
  label: string;
  group: "board" | "conversa";
  /** o comando aceita um complemento escrito depois do nome (`/criar <o quê>`): escolhido, ele entra com um espaço. */
  takesArgs?: boolean;
  /** pode rodar com um turno do Jido em voo (leitura pura / não mexe no contexto da conversa). */
  whileBusy?: boolean;
}

/** Os comandos do board, na ordem da lista do design. `pausar`/`retomar` alternam pelo estado do board. */
const BOARD: Record<JidoBoardCommand, JidoCommand> = {
  criar: { name: "criar", label: "Criar item", group: "board", takesArgs: true, whileBusy: true },
  bug: { name: "bug", label: "Reportar um bug", group: "board", takesArgs: true, whileBusy: true },
  resumo: { name: "resumo", label: "Resumo desde ontem", group: "board", whileBusy: true },
  pendente: { name: "pendente", label: "O que precisa de mim", group: "board", whileBusy: true },
  travou: { name: "travou", label: "Por que algo travou?", group: "board", takesArgs: true, whileBusy: true },
  pausar: { name: "pausar", label: "Pausar o board", group: "board", whileBusy: true },
  retomar: { name: "retomar", label: "Retomar o board", group: "board", whileBusy: true },
  ligar: { name: "ligar", label: "Ligar o board", group: "board", whileBusy: true },
};

/** Os da conversa — os mesmos nomes e a mesma regra de "em voo" do núcleo (ChatPanel CORE_COMMANDS). */
const CORE: JidoCommand[] = [
  { name: "clear", label: "Nova conversa", group: "conversa" },
  { name: "compact", label: "Compactar a conversa", group: "conversa" },
  { name: "context", label: "Quanto de contexto já usei", group: "conversa", whileBusy: true },
  { name: "model", label: "Trocar o modelo", group: "conversa" },
];

/** A lista do botão `/`: os seis do board, na ordem do desenho (com `/pausar`, `/retomar` OU `/ligar`, conforme o board). */
export function jidoCommands(paused: JidoPaceState): JidoCommand[] {
  const pace = paused === "off" ? BOARD.ligar : paused ? BOARD.retomar : BOARD.pausar;
  return [BOARD.criar, BOARD.bug, BOARD.resumo, BOARD.pendente, BOARD.travou, pace];
}

/**
 * A lista que o campo mostra para o que está digitado: só `/` ⇒ os seis do board; um começo de nome ⇒ os que casam,
 * do board E da conversa (`/c` → /criar, /clear, /compact, /context). Sem `/` no começo ⇒ null (lista fechada).
 */
export function jidoMenuFor(paused: JidoPaceState, text: string): JidoCommand[] | null {
  const q = slashQuery(text);
  if (q === null) return null;
  return matchJidoCommands(q === "" ? jidoCommands(paused) : [...jidoCommands(paused), ...CORE], text);
}

/** O que escolher um comando ESCREVE no campo: `/criar ` (com espaço, quem pede complemento), `/resumo`. */
export function composerTextFor(c: Pick<JidoCommand, "name" | "takesArgs">): string {
  return c.takesArgs ? `/${c.name} ` : `/${c.name}`;
}

/**
 * TODOS os comandos que o campo reconhece ao enviar — inclusive o par que a lista esconde (`/pausar` num board já
 * pausado). Digitado, ele roda e a confirmação diz "o board já estava pausado": melhor que mandar `/pausar` ao Jido
 * como se fosse conversa.
 */
export function allJidoCommands(): JidoCommand[] {
  return [...Object.values(BOARD), ...CORE];
}

/** As entradas que casam com o que está no campo (`/` → todas; `/re` → resumo, retomar…); null ⇒ lista fechada. */
export function matchJidoCommands(commands: readonly JidoCommand[], text: string): JidoCommand[] | null {
  const q = slashQuery(text);
  if (q === null) return null;
  return commands.filter((c) => c.name.startsWith(q));
}

/**
 * O texto do campo É um comando? `/travou o deploy` → travou + "o deploy"; `/criar` → criar + "". Só casa o nome
 * INTEIRO (`/cri` não roda nada) e só os da lista dada (o compositor passa {@link allJidoCommands}). Comando
 * desconhecido ⇒ null: o texto segue como mensagem. Puro.
 */
export function parseJidoCommand(
  commands: readonly JidoCommand[],
  text: string,
): { command: JidoCommand; args: string } | null {
  const t = text.trim();
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(t);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const command = commands.find((c) => c.name === name);
  return command ? { command, args: (m[2] ?? "").trim() } : null;
}

/** É um comando da conversa (o painel roda), e não do board? */
export function isCoreCommand(name: JidoCommandName): name is JidoCoreCommand {
  return CORE.some((c) => c.name === name);
}

/**
 * O PEDIDO escrito ao Jido para os comandos que são pergunta. Linguagem simples, sem jargão do motor — é o que
 * aparece na bolha da pessoa. `null` ⇒ o comando não é uma pergunta (abre fluxo ou muda o ritmo). Puro.
 */
export function jidoPromptFor(name: JidoCommandName, args = ""): string | null {
  const extra = args.trim();
  switch (name) {
    case "resumo":
      return `Resumo desde ontem: o que andou neste board nas últimas 24 horas, o que entrou no ar, o que travou e o que espera por mim.${extra ? ` ${extra}` : ""}`;
    case "pendente":
      return `O que precisa de mim agora neste board? Em ordem de urgência, com o que cada decisão pede.${extra ? ` ${extra}` : ""}`;
    case "travou":
      return extra
        ? `Por que isto travou: ${extra}? Explique a causa em linguagem simples e o próximo passo.`
        : "Por que algo travou? Olhe o que está parado, com erro ou esperando há mais tempo e explique a causa de cada um em linguagem simples, com o próximo passo.";
    default:
      return null;
  }
}

/** O texto inicial da captura aberta pelo `/bug` sem card em mão — a dica "algo quebrado" para a classificação. */
export function bugCaptureText(args: string): string {
  const extra = args.trim();
  return extra ? `Algo quebrado: ${extra}` : "Algo quebrado: ";
}
