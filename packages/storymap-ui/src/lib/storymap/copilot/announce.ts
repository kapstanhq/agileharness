// O que o Jido ANUNCIA — de um fato do sistema para uma fala no balão do topnav.
//
// POR QUE EXISTE. O balão sabia falar de ESTADO: o humor dele, o diário do tick, um terminal parado — tudo
// lido por POLL, de 60 em 60 segundos (`copilot/speech.ts`). As NOTÍCIAS, que já chegam prontas e na hora
// pelo SSE (um card que trocou de coluna, um terminal que travou num prompt), não tinham como chegar até
// ele: iam SÓ para os canais do sistema operacional (som + notificação do navegador). Duas consequências
// medidas: quem não deu permissão de notificação não ficava sabendo de nada DENTRO do app, e quem deu
// recebia um aviso de SO — fora da janela, com o texto cru do evento — para coisas que o agente ao lado do
// relógio poderia simplesmente ter dito.
//
// A REGRA NOVA: o balão é a superfície natural desses avisos. Ele já está na tela, já tem uma CARA para
// animar junto, já some sozinho depois de alguns segundos e já é `aria-live` (o leitor de tela anuncia sem
// nenhum canal extra). Este módulo é só a TRADUÇÃO fato → fala: puro, exaustivo por tipo de evento, e sem
// nenhuma decisão de quando/como mostrar (isso é do `useCopilotAnnouncer` + BoardHeader).
//
// O QUE NÃO VIRA NOTÍCIA — a parte que mais importa. `card.updated` SEM demanda humana é silencioso: um run
// de agente reescreve o mesmo card várias vezes por minuto, e anunciar cada escrita transformaria o balão
// num log piscando no canto da barra. Foi exatamente esse ruído que aposentou o feed "Atividade recente"
// (ver NotificationCenter). Só vira fala o que MUDA A SITUAÇÃO de alguém: o card andou, nasceu, saiu — ou
// passou a precisar de você.
//
// PURO e ISOMÓRFICO (sem React, sem IO, sem relógio próprio) → testável, e a régua de produto ("o que ele
// anuncia e com que cara") fica num lugar só.

import type { AgentAlert, AgileHarnessEvent } from "@/lib/notifications/event";
import { cardHref } from "@/lib/storymap/deep-links";
import { summarizeEntry } from "@/lib/storymap/copilot/activity-view";
import { EXPRESSIONS, type MoodId } from "@/lib/storymap/copilot/face";
import {
  BUBBLE_DWELL_MS,
  BUBBLE_DWELL_URGENT_MS,
  type CopilotSpeech,
} from "@/lib/storymap/copilot/speech";

/** O teto de uma fala e o da nota — os mesmos do balão de estado (um balão no topnav é uma frase). */
const LINE_MAX = 140;
const NOTE_MAX = 80;

/** Uma NOTÍCIA pronta para o balão: o que ele diz, a cara que ele faz enquanto diz, e por quanto tempo. */
export interface CopilotAnnouncement {
  /** o mesmo contrato que o balão de estado já consome — o componente não sabe distinguir os dois. */
  readonly speech: CopilotSpeech;
  /** a FIGURA que o agente faz ao anunciar: o rosto do topnav troca por ela e volta sozinho no fim. */
  readonly mood: MoodId;
  /** quanto tempo o balão fica aberto por causa desta notícia. */
  readonly dwellMs: number;
  /**
   * PARA ONDE a notícia leva, quando há um lugar — o card que se moveu, o terminal que travou.
   *
   * A notificação do sistema já levava (`AgentAlert.url`, e o clique abre a página): quem recebia o
   * aviso pelo SO conseguia ir ao lugar, e quem estava com o app ABERTO — vendo a mesma frase no balão —
   * ficava com um texto que não fazia nada, tendo de procurar o card na mão. A mesma informação não pode
   * ser acionável por um caminho e morta pelo outro.
   *
   * Ausente quando não há destino honesto (um card REMOVIDO não tem página; a config do board não tem
   * uma tela só dela). Link que leva a lugar nenhum é pior que nenhum link.
   */
  readonly href?: string;
}

/** O construtor único — garante que toda notícia tenha tom coerente com a cara e teto de caracteres. */
function announce(input: {
  line: string;
  note?: string | null;
  key: string;
  mood: MoodId;
  urgent?: boolean;
  href?: string | null;
}): CopilotAnnouncement {
  const urgent = input.urgent ?? false;
  const note = input.note ? summarizeEntry(input.note, NOTE_MAX) : undefined;
  return {
    speech: {
      line: summarizeEntry(input.line, LINE_MAX),
      ...(note ? { note } : {}),
      key: input.key,
      // O TOM sai do humor, nunca de uma segunda tabela: a cara e a cor do ponto do balão têm de contar a
      // mesma coisa (é a regra que o resto do painel já segue — ver EXPRESSIONS).
      tone: EXPRESSIONS[input.mood].tone,
      urgent,
    },
    mood: input.mood,
    dwellMs: urgent ? BUBBLE_DWELL_URGENT_MS : BUBBLE_DWELL_MS,
    ...(input.href ? { href: input.href } : {}),
  };
}

/**
 * Uma mudança no BOARD virou notícia? `null` = não é notícia (ver o cabeçalho).
 *
 * `forBoard` é o board que o operador está OLHANDO, e filtrar por ele não é detalhe: o stream SSE é
 * global (o vigia observa `storymap/boards/` inteiro e o broadcaster não filtra nada), então sem isto o
 * Jido de um board anunciava card de OUTRO — "«card do Nest» entrou em Revisar código" na barra de quem
 * está no AgileHarness, sem nem dizer de que board se trata. E o Jido do topnav é board-scoped por toda a
 * volta (overview, chat, diário): ele não teria contexto nenhum para dar sobre aquele card. Quem cobre
 * o cross-board são os canais do SO, que já recebem tudo. Omitir `forBoard` = não filtrar.
 *
 * A DEMANDA vence o tipo do evento: quando o card passa a esperar um humano, o que mudou não é "ele foi
 * escrito", é "a bola está com você" — e isso vale tanto num `card.moved` quanto num `card.updated` que
 * o agente fez em silêncio (foi assim que perguntas escritas em lugar nenhum ficavam invisíveis).
 */
export function announceEvent(e: AgileHarnessEvent, forBoard?: string): CopilotAnnouncement | null {
  if (forBoard && e.boardId !== forBoard) return null;
  const board = e.boardName ?? e.boardId;
  const name = e.title ? `“${e.title}”` : (e.cardId ?? "um card");
  // O DESTINO da notícia: a página do card. Só existe se o card existe — um card removido não tem
  // página, e `card.deleted` abaixo não recebe href nenhum. Rota pelo helper canônico (deep-links),
  // nunca montada à mão aqui.
  const href = e.cardId ? cardHref(e.boardId, e.cardId) : null;

  if (e.demand) {
    return announce({
      line: `${name} precisa de você: ${e.demand.label}.`,
      note: e.statusName,
      // A identidade inclui a CONTAGEM: uma segunda pergunta no mesmo card é notícia nova, a mesma não é.
      key: `demand:${e.cardId}:${e.demand.type}:${e.demand.count ?? 1}`,
      mood: "surpreso",
      urgent: true,
      href,
    });
  }

  switch (e.type) {
    case "card.moved":
      // CHEGAR AO FIM não é uma mudança de coluna como as outras — é a única notícia do board que
      // fecha um ciclo, e ela ganha a cara de COMEMORAÇÃO (braços erguidos, ✦ cintilando). Sem isto o
      // trabalho que foi ao ar lia exatamente igual a um card que só avançou um passo, e o único humor
      // festivo do vocabulário nunca aparecia por notícia nenhuma. Quem decide o que é "fim" é o
      // board.yaml, resolvido no servidor (`toTerminal`) — o cliente não conhece id de passo.
      if (e.toTerminal) {
        return announce({
          // Sem emoji e sem exclamação: quem comemora é a CARA (braços erguidos, ✦), e o texto segue
          // sóbrio como o resto do painel. É a mesma regra do mascote monocromático — o estado vive no
          // desenho, não em enfeite no meio da frase.
          line: e.toStatusName ? `${name} chegou em ${e.toStatusName}.` : `${name} chegou ao fim do pipeline.`,
          note: e.fromStatusName ? `veio de ${e.fromStatusName}` : null,
          key: `done:${e.cardId}:${e.toStatus ?? ""}`,
          mood: "amoroso",
          href,
        });
      }
      return announce({
        line: `${name} entrou em ${e.toStatusName ?? e.toStatus ?? "outra coluna"}.`,
        note: e.fromStatusName ? `saiu de ${e.fromStatusName}` : null,
        key: `moved:${e.cardId}:${e.toStatus ?? ""}`,
        mood: "conectado", // as ondas de atividade — algo se mexendo no board
        href,
      });
    case "card.created":
      return announce({
        line: `Entrou um card novo em ${board}: ${name}.`,
        note: e.statusName,
        href,
        key: `created:${e.cardId}`,
        mood: "piscando", // "vi, anotei"
      });
    case "card.deleted":
      return announce({
        line: `${name} saiu do board.`,
        key: `deleted:${e.cardId}`,
        mood: "triste",
      });
    case "board.updated":
      return announce({
        line: `A configuração do board ${board} mudou.`,
        key: `board:${e.boardId}:${e.at}`,
        mood: "codigo",
      });
    case "card.updated":
      // Escrita de agente não é notícia — só a demanda acima é (ver o cabeçalho).
      return null;
  }
}

/**
 * Um AVISO do agente (hoje: os terminais) virou notícia. Sempre vira: quem o produziu já decidiu que
 * aquilo merece a atenção de um humano — este módulo não re-julga, só escolhe a cara e o tempo de tela.
 *
 * O texto é o MESMO que vai para a notificação do sistema e para o push: o operador não pode ler três
 * versões do mesmo fato dependendo de por onde ele chegou. E o DESTINO também: o aviso já carregava
 * `url` (obrigatório por contrato — "um aviso que interrompe e não leva a lugar nenhum transfere para o
 * operador o trabalho de descobrir de onde ele veio"), e era justamente o balão que a ignorava.
 */
export function announceAlert(a: AgentAlert): CopilotAnnouncement {
  const blocking = a.urgency === "blocking";
  return announce({
    line: a.title,
    note: a.body,
    key: `alert:${a.id}`,
    // Travou trabalho ⇒ a cara de quem parou e espera você; cortesia ⇒ a piscadela de "terminei".
    mood: blocking ? "surpreso" : "piscando",
    urgent: blocking,
    href: a.url,
  });
}

/**
 * O que o anunciador SABE entre uma notícia e outra. Pequeno de propósito: quem tem relógio é o hook.
 */
export interface AnnouncerState {
  /** a fala que está NA TELA agora (null = balão livre). */
  readonly showingKey: string | null;
  /** quantas notícias a janela atual já engoliu (viram "+N"). */
  readonly skipped: number;
  /** a notícia que chegou com o balão SEGURADO — assume quando o operador soltar. */
  readonly deferred: CopilotAnnouncement | null;
}

/** Balão livre — o estado de partida e o de depois que a notícia expira. */
export const IDLE_ANNOUNCER: AnnouncerState = { showingKey: null, skipped: 0, deferred: null };

/**
 * Chegou uma notícia: mostra, represa ou engole? PURA — é aqui que mora a regra, não no relógio do hook.
 *
 * A trava contra REPETIÇÃO vale só enquanto a notícia está na tela, e essa fronteira é o conserto de um
 * defeito real: a primeira versão guardava a última chave para SEMPRE, então um card que voltasse à
 * mesma coluna horas depois — mesma identidade, notícia legítima e nova — ficava mudo. Guardar contra o
 * eco imediato (o watcher reemite o mesmo fato quando uma escrita vira dois eventos) é certo; guardar
 * contra recorrência é engolir notícia.
 *
 * `held` = o ponteiro do operador está EM CIMA do balão. Aí nada troca: a notícia nova é REPRESADA e só
 * assume quando ele soltar (`releaseAnnouncer`). Isto foi medido, não imaginado — na validação ao vivo,
 * um aviso de terminal chegou entre o hover e o clique, trocou o link debaixo do cursor e o clique
 * aterrissou noutro lugar. Uma superfície que muda de destino no meio do gesto é pior que uma que
 * some. Nada se perde por represar: o alarme desses avisos (som, notificação do SO, push) é de outro
 * canal e já disparou; o que se atrasa em segundos é só o texto no balão.
 */
export function admitAnnouncement(
  state: AnnouncerState,
  incoming: CopilotAnnouncement,
  opts: { held?: boolean } = {},
): { show: CopilotAnnouncement | null; next: AnnouncerState } {
  if (state.showingKey === incoming.speech.key) return { show: null, next: state };
  if (opts.held) {
    // A represada anterior é que foi deslocada por esta (a da tela já contou na entrada dela).
    const skipped = state.deferred ? state.skipped + 1 : state.skipped;
    return { show: null, next: { ...state, skipped, deferred: incoming } };
  }
  // Substituir uma notícia ainda na tela custa a contagem dela; com o balão livre, a conta recomeça.
  const skipped = state.showingKey ? state.skipped + 1 : 0;
  const show = withPending(incoming, skipped);
  return { show, next: { showingKey: show.speech.key, skipped, deferred: null } };
}

/** O operador SOLTOU o balão: a notícia represada (se houver) assume agora. PURA. */
export function releaseAnnouncer(state: AnnouncerState): {
  show: CopilotAnnouncement | null;
  next: AnnouncerState;
} {
  if (!state.deferred) return { show: null, next: state };
  return admitAnnouncement({ ...state, deferred: null }, state.deferred);
}

/**
 * "E mais N" — o que sobra quando várias notícias chegam dentro da MESMA janela de balão.
 *
 * Elas não se enfileiram: um balão que reproduz 12 avisos de 5s cada fala por um minuto sobre coisas que
 * já passaram. A última SUBSTITUI as anteriores e o que ficou para trás vira contagem — o operador vê a
 * notícia mais nova e sabe que houve mais movimento, que é a informação honesta.
 */
export function withPending(a: CopilotAnnouncement, pending: number): CopilotAnnouncement {
  if (pending <= 0) return a;
  const tail = `+${pending} ${pending === 1 ? "mudança" : "mudanças"} antes desta`;
  const note = a.speech.note ? `${a.speech.note} · ${tail}` : tail;
  return { ...a, speech: { ...a.speech, note: summarizeEntry(note, NOTE_MAX) } };
}
