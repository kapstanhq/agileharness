// HITL conversacional — contratos do NÚCLEO reutilizável (síncrono, multi-round, shell-agnóstico).
// Um turno = uma chamada de LLM com o transcript replayado INTEIRO (mesmo modelo do CaptureTurn da captura).
// PURO/isomórfico: sem React, sem IO. O consumidor injeta o propósito (persona) e o contexto; o núcleo só
// transporta a conversa e o payload de fim (`done`), opaco a ele.

import type { QuestionOption } from "../types";

export type HitlResponseMode = "terse" | "standard";

/**
 * Uma OPÇÃO oferecida numa conversa HITL: o shape das perguntas de card (`QuestionOption` — label,
 * pros/cons, recommended) MAIS a `description`, a prosa livre com que o agente explica a opção.
 *
 * Por que a descrição mora AQUI e não em `QuestionOption`: aquele tipo é PERSISTIDO (frontmatter de card,
 * Zod, serializer). Um campo novo lá que o serializer não conhece é escrita silenciosamente descartada — a
 * armadilha clássica deste repo. A conversa não persiste opção nenhuma: ela vive um turno. Uma pergunta de
 * card continua chegando aqui inteira (toda `QuestionOption` É uma `HitlOption`), só sem descrição.
 */
export interface HitlOption extends QuestionOption {
  /** o que acontece se escolher isto — custo, risco, o que o agente já apurou. 1-2 linhas, prosa livre. */
  description?: string;
}

/** Resposta do humano: texto livre E/OU ids de opções (reusa o shape de QuestionOption do QuestionRenderer). */
export interface HitlHumanTurn {
  role: "human";
  text: string;
  selectedOptionIds?: string[];
  /** F4 (copilot agêntico) — paths absolutos das imagens anexadas ao turno (thumbnails via previewUrl no cliente,
   *  entregues ao agente como tail "[Imagem anexada — abra com Read: <path>]"). Consumidores velhos ignoram. */
  images?: string[];
}

/** F1 (copilot agêntico) — uma tool executada pelo Jido no turno, resumida p/ o chip de atividade no thread. */
export interface HitlActivity {
  tool: string;
  summary: string;
  /** F2 — quando a tool cria/dirige um terminal tmux, a URL do /terminal?b=<session> (chip vira link). */
  terminalUrl?: string;
}

/** F1-refino (streaming inline estilo Claude Code) — um SEGMENTO ordenado do turno do agente: um bloco de texto
 *  OU uma tool call com estado vivo. O turno vira uma SEQUÊNCIA desses (na ordem exata em que o CLI os emite),
 *  substituindo o modelo antigo "chips batched no topo + 1 blob de texto". `segId` é estável por segmento. */
export type HitlSegment =
  /** um bloco de texto do assistente (streama token-a-token via text-delta; múltiplos por turno). */
  | { type: "text"; segId: string; text: string }
  /** uma tool call INLINE com status vivo + input/output colapsáveis. */
  | {
      type: "tool";
      segId: string;
      name: string;
      summary: string;
      status: "running" | "done" | "error";
      /** JSON do input da tool (truncado) — mostrado ao expandir a pill. */
      input?: string;
      /** saída da tool (truncada) — mostrada ao expandir quando done/error. */
      output?: string;
      /** F2 — terminal tmux: a pill vira link p/ /terminal?b=<session>. */
      terminalUrl?: string;
    };

/**
 * Turno do agente: mensagem (estilo terminal) + quick-replies opcionais + payload de fim opcional.
 * `done` presente = a conversa RESOLVEU; `TDone` é opaco ao núcleo (o consumidor o instancia, como o
 * `CaptureTurn.proposal` carrega um Proposal opaco).
 */
export interface HitlAgentTurn<TDone = unknown> {
  role: "agent";
  message: string;
  options?: HitlOption[];
  mode?: "single" | "multi";
  done?: TDone;
  /** F1 (copilot agêntico) — tools que o agente executou neste turno, mostradas como chips acima do corpo.
   *  LEGADO (modelo batched): quando `segments` está presente, o render usa segments e ignora activity/message. */
  activity?: HitlActivity[];
  /** F1-refino — a sequência ORDENADA de segmentos (texto + tools inline). Quando presente, o HitlConversation
   *  renderiza inline/ao vivo e IGNORA `message`/`activity` (que os popovers HITL antigos continuam usando). */
  segments?: HitlSegment[];
  /**
   * As `options` deste turno são uma PERGUNTA (e não um menu de ações) ⇒ a UI oferece também a saída
   * ABERTA ("escrever a minha"), que devolve a palavra ao operador em vez de trancá-lo na lista.
   *
   * Quem decide é o PRODUTOR do turno: a pergunta de um card passa true; o menu de ações do greeting não
   * (ali não existe "outra resposta" — existem as ações que existem). Um ask que o AGENTE escreve
   * (bloco ```jido-ask) recebe a saída aberta SEMPRE, por decisão de produto — ver hitl/ask.ts.
   */
  openAnswer?: boolean;
  /**
   * RESPOSTAS RÁPIDAS sugeridas — um toque ENVIA o texto do chip como se o operador o tivesse digitado.
   * Diferente de `options`: elas respondem a uma escolha oferecida; estas só encurtam a digitação (o
   * "o que eu poderia perguntar agora"). Ausente ⇒ nada muda.
   *
   * ⚠️ Elas e `options` são MUTUAMENTE EXCLUSIVAS na tela: havendo opções, `hitl/ask.ts` derruba as
   * sugestões (invariante 4). Emitir as duas não é erro — é só trabalho jogado fora.
   */
  suggestions?: string[];
}

/**
 * Um EVENTO do sistema no meio da conversa — não é fala do operador nem do agente. Hoje só o "acordar" do tick
 * autônomo: desde o WS2A ele escreve na MESMA sessão durável que o chat lê, e o prompt com que ele acorda é uma
 * slash command. Sem este turno, o transcript entregava essa slash command (expandida em XML pelo CLI) como um
 * `role:"human"` — e o chat a imprimia como se o operador tivesse digitado XML. Um evento é um TERCEIRO papel:
 * modelá-lo como fala de alguém é o que produzia o vazamento.
 *
 * Aditivo: só o leitor de transcript o produz e só o HitlConversation o renderiza (centrado, discreto). Os
 * consumidores antigos (popovers HITL / captura) nunca o veem.
 */
export interface HitlNoticeTurn {
  role: "notice";
  /** a frase já pronta para leitura (o produtor formata — o render não interpreta). */
  text: string;
  /**
   * o que gerou o evento; o render escolhe o ícone por aqui, nunca por regex no texto.
   * `tick` = o ciclo autônomo acordou. `command` = o operador rodou um comando de barra (/clear,
   * /compact, /context) — é AÇÃO dele, não fala: uma bolha "/`clear`" seria uma mensagem que ele nunca
   * mandou a ninguém, e o resultado (o contexto zerado) não é resposta de nenhum interlocutor.
   */
  kind: "tick" | "command";
}

export type HitlTurn<TDone = unknown> = HitlHumanTurn | HitlAgentTurn<TDone> | HitlNoticeTurn;

export interface HitlTranscript {
  turns: HitlTurn[];
}
