// Notification domain — isomorphic (no node/browser deps), shared by the server
// watcher/dispatcher and the client channels.
//
// A single `AgileHarnessEvent` describes one persisted change to a board (a card or
// the board config), regardless of who wrote it (the UI server actions or an
// agent editing the .md files directly). Channels turn that event into an
// effect (sound, browser notification, Slack message, …) — see NotificationChannel.

import type { CardType } from "@/lib/storymap/types";

export type AgileHarnessEventType =
  | "card.created"
  | "card.updated"
  | "card.moved" // status change (kanban movement)
  | "card.deleted"
  | "board.updated";

export interface AgileHarnessEvent {
  /** unique per emission, for client-side dedup/keying */
  id: string;
  type: AgileHarnessEventType;
  boardId: string;
  cardId?: string;
  cardType?: CardType;
  /** card title (or undefined for board.updated) */
  title?: string;
  /** card.moved only: previous status id */
  fromStatus?: string | null;
  /** card.moved only: new status id */
  toStatus?: string | null;
  /** epoch ms */
  at: number;

  // --- resolved metadata (filled by the server watcher from board.yaml) so the
  // client can render human-friendly context without loading the board config. ---
  /** display name of the board (e.g. "Nest") */
  boardName?: string;
  /** current status display name */
  statusName?: string | null;
  /** card.moved: previous/next status display names */
  fromStatusName?: string | null;
  toStatusName?: string | null;
  /**
   * `card.moved`: o passo de destino é TERMINAL (fim de linha do pipeline — "No ar", "Descontinuada"…)?
   *
   * Resolvido AQUI, no servidor, lendo `board.yaml` — e não no cliente reconhecendo um id como
   * `concluida`. O AgileHarness é ferramenta genérica: cada board escolhe seus passos e quais deles
   * terminam, então "chegou ao fim" é fato de CONFIG, nunca um id no código. Quem consome (hoje o
   * anúncio do topnav, que comemora) não precisa saber nada do pipeline.
   */
  toTerminal?: boolean;
  /** release slice display name (stories only) */
  releaseName?: string | null;
  /** immediate parent card title (step for a story, activity for a step) */
  parentTitle?: string | null;
  /** derived RICE score, when all inputs are present (stories) */
  riceScore?: number | null;

  /**
   * The card's dominant PENDING HUMAN DEMAND at emit time (question/blocker/review/gate), when any —
   * a lightweight projection of `dominantDemand(cardDemands(...))` attached by the watcher. This is
   * what lets the notification layer alert on a demand that appears WITHOUT a card move (e.g. harness-grill
   * writing questions in place — the story-rl5v03 root cause), instead of only inferring "needs you"
   * from card.moved. Consumers (web-push) dedupe per card by `type`.
   */
  demand?: { type: string; label: string; severity: string; count?: number };
}

// ── AVISOS DO AGENTE (o segundo tipo de evento do barramento) ────────────────────────────────────
//
// Um `AgileHarnessEvent` descreve uma ESCRITA no board — a única coisa que o barramento sabia carregar.
// Mas nem tudo que interrompe o operador é uma escrita de card: um TERMINAL parado num prompt trava o
// trabalho dele e não toca em arquivo nenhum. Um `AgentAlert` é um AVISO já pronto para virar efeito
// (som, notificação do sistema, push) — quem o produz decidiu que aquilo merece a atenção de um
// humano; os canais só o entregam.
//
// A DIFERENÇA que justifica um tipo próprio, e não um `AgileHarnessEventType` a mais: um evento de board
// é um FATO (algo mudou; cada superfície decide o que fazer com ele); um alerta é uma INTENÇÃO de
// interromper. Misturá-los faria toda escrita de card virar candidata a tocar o alarme — que é
// exatamente o volume que o operador não quer.

/**
 * O que aconteceu. Cada kind tem um PRODUTOR real (uma capacidade declarada sem produtor é uma
 * feature que nunca dispara) — hoje, os dois vêm do vigia de terminais (lib/terminal/attention-watch).
 */
export type AgentAlertKind =
  /** um terminal está PARADO num prompt esperando você (permissão, senha, sim/não). Trava trabalho. */
  | "terminal-waiting"
  /** um terminal de agente parou de produzir saída — terminou, ou espera sua próxima instrução. */
  | "terminal-quiet"
  /**
   * um pedido de publicação passou de LENTO para BLOQUEADO (a régua de `delivery-view isBlocked`:
   * espera longa + contagem alta). Produtor: o dreno da fila (`instrumentation` → `publish-queue
   * onBlocked`), na BORDA — uma vez, nunca por tentativa.
   */
  | "publish-blocked";

/**
 * O quanto isto pode interromper. É o eixo que a política por modo do Jido lê (copilot/alert-policy):
 * `blocking` = nada anda sem você; `pending` = está te esperando, mas o mundo segue.
 */
export type AlertUrgency = "blocking" | "pending";

/**
 * A urgência CANÔNICA de cada kind. Mora no domínio (e não na política por modo) porque ela é
 * propriedade do FATO, não da preferência de quem recebe: "um prompt parado trava trabalho" é
 * verdade em qualquer modo. Quem produz o aviso carimba a partir daqui; a política por modo
 * (copilot/alert-policy) decide, sobre isto, quem é interrompido.
 */
export const ALERT_URGENCY: Record<AgentAlertKind, AlertUrgency> = {
  "terminal-waiting": "blocking", // um prompt parado não anda sem você
  "terminal-quiet": "pending", // acabou (ou espera instrução) — te espera, mas nada trava
  "publish-blocked": "blocking", // a publicação não sai sozinha: ou o trabalho sobreposto integra, ou alguém dispensa
};

export interface AgentAlert {
  /** único por emissão (dedup/keying no cliente). */
  id: string;
  kind: AgentAlertKind;
  urgency: AlertUrgency;
  /** epoch ms */
  at: number;
  /** a manchete (título da notificação). */
  title: string;
  /** o corpo — o que está acontecendo e há quanto tempo. */
  body: string;
  /** tag do SO: dois avisos da MESMA origem colapsam em um em vez de empilhar. */
  tag: string;
  /** para onde levar quem clicar. Obrigatório: um aviso que interrompe e não leva a lugar nenhum
   *  transfere para o operador o trabalho de descobrir de onde ele veio. */
  url: string;
  /** board relacionado, quando houver (um terminal de card sabe o seu). */
  boardId?: string;
  /**
   * O SERVIDOR deve empurrar para o celular (aba fechada)? Decidido por quem produz — ele é quem sabe
   * se aquilo trava trabalho ou se o operador pediu para ser avisado daquela origem. O barramento
   * obedece: uma segunda régua escondida no fan-out seria uma política em dois lugares.
   */
  push?: boolean;
}

/**
 * A notification sink. Implemented on BOTH sides of the SSE bridge:
 *  - server: SSE broadcaster, Slack, log (see lib/notifications/server/channels)
 *  - client: sound, browser Notification (see lib/notifications/client)
 * Adding a channel = implement this and register it — no other code changes.
 */
export interface NotificationChannel {
  readonly id: string;
  notify(event: AgileHarnessEvent): void | Promise<void>;
}

const NOUN: Record<CardType, string> = {
  activity: "Atividade",
  step: "Step",
  story: "Story",
  idea: "Ideia",
};

export interface EventLabel {
  /** one-line headline (the notification title) */
  title: string;
  /** multi-line body: card name + a context line + a timestamp line */
  body: string;
}

const VERB: Record<AgileHarnessEventType, string> = {
  "card.created": "criada",
  "card.updated": "atualizada",
  "card.moved": "movida",
  "card.deleted": "removida",
  "board.updated": "alterado",
};

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Join non-empty context fragments with a middle dot. */
function contextLine(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(" · ");
}

/**
 * Human-readable PT-BR label for an event — used by the browser notification,
 * the Slack channel and the in-app activity log. The body packs the useful
 * metadata: parent/release/status context plus the time it happened.
 */
export function describeEvent(e: AgileHarnessEvent): EventLabel {
  const board = e.boardName ?? e.boardId;
  const time = timeOf(e.at);

  if (e.type === "board.updated") {
    return { title: `Board ${board} alterado`, body: contextLine(["Configuração (board.yaml)", time]) };
  }

  const noun = e.cardType ? NOUN[e.cardType] : "Card";
  const name = e.title ? `“${e.title}”` : (e.cardId ?? "");
  const parent = e.parentTitle ? `em ${e.parentTitle}` : null;
  const release = e.releaseName ? `Release: ${e.releaseName}` : null;
  const rice = e.riceScore != null ? `RICE ${e.riceScore}` : null;

  switch (e.type) {
    case "card.created":
      return {
        title: `Nova ${noun.toLowerCase()} em ${board}`,
        body: [name, contextLine([parent, release, e.statusName ? `Status: ${e.statusName}` : null]), time]
          .filter(Boolean)
          .join("\n"),
      };
    case "card.moved":
      return {
        title: `${noun} movida → ${e.toStatusName ?? e.toStatus ?? "sem status"}`,
        body: [
          name,
          contextLine([
            board,
            e.fromStatusName ?? e.fromStatus ? `de ${e.fromStatusName ?? e.fromStatus}` : null,
            parent,
            rice,
          ]),
          time,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    case "card.updated":
      return {
        title: `${noun} ${VERB[e.type]} · ${board}`,
        body: [name, contextLine([parent, release, e.statusName ? `Status: ${e.statusName}` : null, rice]), time]
          .filter(Boolean)
          .join("\n"),
      };
    case "card.deleted":
      return {
        title: `${noun} removida · ${board}`,
        body: [name, contextLine([parent, e.statusName ? `Status: ${e.statusName}` : null]), time]
          .filter(Boolean)
          .join("\n"),
      };
  }
}
