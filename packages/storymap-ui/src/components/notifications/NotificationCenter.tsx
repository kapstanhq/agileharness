"use client";

// Board notifications — the client end of the pipeline. Consumes board content events
// from the SHARED SSE connection (RunnerStatusProvider, via useStorymapEvents — no
// second EventSource), routes each AgileHarnessEvent to the enabled client channels (sound
// + browser notification), and refreshes the board (debounced) so agent edits show live.
//
// This file is the ENGINE only: the hook runs at the always-mounted BoardHeader level
// (keeping live-refresh + channels alive) and the CONTROLS (three switches) live with the
// rest of the menu in `nav/BoardMenu`. Preferences persist in localStorage.
//
// O feed "Atividade recente" que morava aqui FOI REMOVIDO: era um segundo diário, pior que o do
// Jido (`copilot/CopilotActivityFeed`, durável e agrupado) — nascia vazio a cada F5, só existia
// enquanto o menu estava aberto e, por guardar estado no header sempre montado, re-renderizava a
// barra inteira duas vezes por evento SSE.
//
// DOIS TIPOS DE ENTRADA, dois portões diferentes:
//   • AgileHarnessEvent (escrita de board) — passa pelos toggles do operador, como sempre.
//   • AgentAlert (um terminal seu parado esperando você) — passa pelos MESMOS toggles E pela política
//     do MODO do Jido (copilot/alert-policy): "quanto mais autonomia, menos FYI, e nunca menos
//     bloqueio". O toggle diz SE ele pode falar; o modo diz DO QUE ele fala. São perguntas diferentes,
//     e por isso dois portões — juntá-los faria "desligar o som" e "confiar mais no agente" virarem o
//     mesmo botão.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { alertAllowed, alertPolicyLabel } from "@/lib/storymap/copilot/alert-policy";
import type { CopilotTier } from "@/lib/storymap/copilot/tier";
import { SoundChannel } from "@/lib/notifications/client/sound-channel";
import { WebNotificationChannel } from "@/lib/notifications/client/web-notification-channel";
import {
  getPushState,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from "@/lib/notifications/client/push-channel";
import { useAgentAlerts, useStorymapEvents } from "@/components/RunnerStatusProvider";

// Coalesce the board re-fetch: an agent run can emit a burst of card.* events, and one
// router.refresh per event would re-fetch the whole RSC N times back-to-back.
const REFRESH_DEBOUNCE_MS = 250;

const PREF_SOUND = "storymap.notify.sound";
const PREF_WEB = "storymap.notify.web";

function readPref(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(key);
  return v === null ? fallback : v === "1";
}

export interface BoardNotifications {
  soundOn: boolean;
  webOn: boolean;
  webSupported: boolean;
  pushState: PushState;
  pushBusy: boolean;
  /** A linha de baixo do canal "No celular": o que ele faz, ou POR QUE está indisponível. */
  pushHint: string;
  /** O que o MODO do Jido deixa passar por estes canais — a consequência, antes invisível, de trocar
   *  de modo. Não é um toggle: quem a muda é o botão de modo, esta linha só a torna legível. */
  alertPolicy: string;
  toggleSound: () => void;
  toggleWeb: () => Promise<void>;
  togglePush: () => Promise<void>;
}

/**
 * The notification engine as a hook — MUST be called from an always-mounted component
 * (BoardHeader) so the SSE handler (sound/web channels + the live board refresh) keeps
 * running regardless of whether the controls popover is open. Returns the state +
 * actions the three switches in `nav/BoardMenu` render.
 *
 * `tier` é o MODO do Jido (chat/copiloto/autônomo) — o portão de QUANTO ele interrompe. Vem de fora
 * (o header já lê o overview do copiloto uma vez) para não haver um segundo fetch do mesmo estado.
 */
export function useBoardNotifications(tier: CopilotTier): BoardNotifications {
  const router = useRouter();
  const [soundOn, setSoundOn] = useState(false);
  const [webOn, setWebOn] = useState(false);
  const [pushState, setPushState] = useState<PushState>("unsupported");
  const [pushBusy, setPushBusy] = useState(false);

  const sound = useMemo(() => new SoundChannel(), []);
  const web = useMemo(() => (WebNotificationChannel.supported() ? new WebNotificationChannel() : null), []);

  // Keep the latest toggle values readable inside the SSE handler without
  // re-subscribing the stream on every change. O `tier` entra aqui pelo mesmo motivo: trocar o modo
  // do Jido não pode re-assinar o stream.
  const flags = useRef({ soundOn: false, webOn: false, tier });
  useEffect(() => {
    flags.current = { soundOn, webOn, tier };
  }, [soundOn, webOn, tier]);

  useEffect(() => {
    setSoundOn(readPref(PREF_SOUND, false));
    setWebOn(readPref(PREF_WEB, false) && WebNotificationChannel.supported() && Notification.permission === "granted");
    // Reflect the real push subscription state (survives reloads — the SW + the
    // PushManager subscription persist independently of localStorage).
    if (isPushSupported()) void getPushState().then(setPushState);
  }, []);

  // Phone push (Web Push): subscribe = register SW + prompt + persist subscription
  // server-side; unsubscribe = drop it locally + tell the server. Unlike the system
  // toggle above, this delivers with the app/tab CLOSED (see push-channel.ts).
  const togglePush = useCallback(async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      setPushState(pushState === "subscribed" ? await unsubscribeFromPush() : await subscribeToPush());
    } finally {
      setPushBusy(false);
    }
  }, [pushState, pushBusy]);

  // Browsers suspend the AudioContext until a user gesture. After a reload with
  // sound enabled, re-unlock it on the first interaction anywhere on the page so
  // the next event actually plays (the toggle is no longer the only entry point).
  useEffect(() => {
    const handler = () => {
      if (flags.current.soundOn) sound.unlock();
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [sound]);

  // Debounced board refresh — collapses a burst of card.* events into one re-fetch.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
  }, [router]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  // Board content events arrive on the shared SSE connection (one stream for the board).
  useStorymapEvents((event) => {
    if (flags.current.soundOn) sound.notify(event);
    if (flags.current.webOn && web) web.notify(event);
    scheduleRefresh(); // reflect agent/UI edits on the board live (coalesced)
  });

  // AVISOS do agente — o segundo tipo de entrada. Passa pelos MESMOS toggles E pela política do modo
  // (ver o cabeçalho). Nunca dispara `router.refresh()`: um terminal esperando não muda o board.
  useAgentAlerts((alert) => {
    const { soundOn: s, webOn: w, tier: t } = flags.current;
    if (!alertAllowed(t, alert.kind)) return;
    if (s) sound.alert(alert);
    if (w && web) web.alert(alert);
  });

  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on;
      if (next) sound.unlock(); // must run inside this click gesture
      window.localStorage.setItem(PREF_SOUND, next ? "1" : "0");
      return next;
    });
  }, [sound]);

  const toggleWeb = useCallback(async () => {
    if (webOn) {
      setWebOn(false);
      window.localStorage.setItem(PREF_WEB, "0");
      return;
    }
    const perm = await WebNotificationChannel.requestPermission();
    const granted = perm === "granted";
    setWebOn(granted);
    window.localStorage.setItem(PREF_WEB, granted ? "1" : "0");
  }, [webOn]);

  // O RÓTULO do canal é fixo ("No celular", em BoardMenu); o que varia é a linha de baixo — o que
  // ele faz, ou por que não dá. Antes o motivo do bloqueio ocupava o rótulo, e o operador via um
  // item chamado "Push não suportado neste navegador" no lugar de um canal desligado.
  const pushHint =
    pushState === "unsupported"
      ? "Não suportado neste navegador"
      : pushState === "denied"
        ? "Permissão negada no navegador"
        : pushBusy
          ? "Configurando…"
          : "Chega mesmo com o app fechado";

  return {
    soundOn,
    webOn,
    webSupported: !!web,
    pushState,
    pushBusy,
    pushHint,
    alertPolicy: alertPolicyLabel(tier),
    toggleSound,
    toggleWeb,
    togglePush,
  };
}

