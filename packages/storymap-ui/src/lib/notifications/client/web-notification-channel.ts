// Web Notification channel — OS-level notification (on Windows these surface in
// the Action Center) via the browser Notification API. Silently no-ops when the
// API is missing or permission isn't granted; NotificationCenter owns the prompt.

import type { AgentAlert, NotificationChannel, AgileHarnessEvent } from "../event";
import { describeEvent } from "../event";

export class WebNotificationChannel implements NotificationChannel {
  readonly id = "web-notification";

  static supported(): boolean {
    return typeof window !== "undefined" && "Notification" in window;
  }

  static async requestPermission(): Promise<NotificationPermission> {
    if (!WebNotificationChannel.supported()) return "denied";
    if (Notification.permission !== "default") return Notification.permission;
    return Notification.requestPermission();
  }

  notify(event: AgileHarnessEvent): void {
    if (!WebNotificationChannel.supported() || Notification.permission !== "granted") return;
    const { title, body } = describeEvent(event);
    // tag collapses bursts on the same card into one toast (renotify re-alerts
    // when that card changes again instead of silently replacing).
    new Notification(title, {
      body,
      lang: "pt-BR",
      tag: `storymap:${event.boardId}:${event.cardId ?? "board"}`,
      renotify: true,
    } as NotificationOptions);
  }

  /**
   * Um AVISO do agente (terminal esperando você). Título/corpo já vêm decididos pelo produtor — aqui
   * não há um segundo `describe*`: o mesmo texto tem de aparecer no push do celular, na notificação do
   * sistema e na fala do Jido, senão o operador lê três versões do mesmo fato.
   *
   * O clique LEVA ao lugar (`alert.url`): uma notificação que só informa transfere para o operador o
   * trabalho de achar de onde ela veio.
   */
  alert(alert: AgentAlert): void {
    if (!WebNotificationChannel.supported() || Notification.permission !== "granted") return;
    const n = new Notification(alert.title, {
      body: alert.body,
      lang: "pt-BR",
      tag: alert.tag,
      renotify: true,
      // `blocking` fica na tela até alguém olhar; `pending` some sozinho como qualquer aviso.
      requireInteraction: alert.urgency === "blocking",
    } as NotificationOptions);
    n.onclick = () => {
      window.open(alert.url, "_blank", "noopener,noreferrer");
      n.close();
    };
  }
}
