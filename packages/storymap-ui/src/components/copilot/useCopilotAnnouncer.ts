"use client";

// O ANUNCIADOR — o que transforma os eventos vivos do sistema numa fala passageira do Jido no topnav.
//
// A REGRA é a do balão: uma notícia por vez, alguns segundos, e some sozinha. As que chegam durante a
// janela de uma que já está na tela NÃO se enfileiram — a última substitui, e as anteriores viram
// contagem (`withPending`). Um balão reproduzindo uma fila de doze avisos de 5s cada falaria por um
// minuto inteiro sobre coisas que já passaram, com o operador impedido de ver a mais recente.
//
// A tradução fato → fala E a decisão de mostrar/engolir/contar moram em `copilot/announce.ts` (puras e
// testadas). Aqui fica só o que precisa de React: o RELÓGIO, o estado dele e as duas assinaturas — as
// MESMAS do NotificationCenter (a conexão SSE é uma só, compartilhada).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentAlerts, useStorymapEvents } from "@/components/RunnerStatusProvider";
import {
  admitAnnouncement,
  announceAlert,
  announceEvent,
  IDLE_ANNOUNCER,
  releaseAnnouncer,
  type AnnouncerState,
  type CopilotAnnouncement,
} from "@/lib/storymap/copilot/announce";

/**
 * A notícia que o Jido está anunciando AGORA, ou `null`.
 *
 * `boardId` é o board que o operador está olhando: o stream SSE é GLOBAL, e sem esse recorte a barra de
 * um board anuncia card de outro (ver `announceEvent`). Os AVISOS de agente (terminais) passam sem
 * recorte de propósito — um terminal seu travado trava o seu trabalho esteja você em que board estiver.
 *
 * `enabled=false` (ele escrevendo no chat) não só ignora as notícias novas: apaga a que estiver aberta.
 * Um balão que ficasse pendurado depois de o dono do timer sair da tela não teria mais quem o fechasse.
 */
export function useCopilotAnnouncer(
  enabled: boolean,
  boardId?: string,
  hold = false,
): CopilotAnnouncement | null {
  const [news, setNews] = useState<CopilotAnnouncement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** a REGRA (mostrar/engolir/contar) é pura e mora em `announce.ts`; aqui fica só o estado dela. */
  const state = useRef<AnnouncerState>(IDLE_ANNOUNCER);
  /** o balão está SEGURADO (ponteiro em cima)? Enquanto estiver, a notícia não expira — ver abaixo. */
  const held = useRef(hold);
  held.current = hold;
  /** a notícia venceu enquanto o operador a segurava: sai assim que ele soltar. */
  const expiredWhileHeld = useRef(false);
  // O handler do SSE vive fora do ciclo de render — ele lê os valores atuais por ref para que
  // ligar/desligar o anúncio (ou trocar de board) não re-assine o stream.
  const on = useRef(enabled);
  on.current = enabled;
  const board = useRef(boardId);
  board.current = boardId;

  const clear = useCallback(() => {
    timer.current = null;
    state.current = IDLE_ANNOUNCER;
    expiredWhileHeld.current = false;
    setNews(null);
  }, []);

  /** Põe a notícia na tela e arma o relógio dela. */
  const display = useCallback(
    (shown: CopilotAnnouncement) => {
      expiredWhileHeld.current = false;
      if (timer.current) clearTimeout(timer.current);
      setNews(shown);
      timer.current = setTimeout(() => {
        // SEGURADO = não some. O operador está com o ponteiro no balão (lendo, ou indo clicar no link):
        // fazer a notícia evaporar debaixo do cursor é tirar o alvo da mão de quem foi buscá-lo. Fica
        // marcado para sair assim que ele soltar.
        if (held.current) {
          timer.current = null;
          expiredWhileHeld.current = true;
          return;
        }
        clear();
      }, shown.dwellMs);
    },
    [clear],
  );

  const show = useCallback(
    (incoming: CopilotAnnouncement | null) => {
      if (!incoming || !on.current) return;
      // A regra (mostrar / represar / engolir) é pura; aqui só se obedece o veredito.
      const { show: shown, next } = admitAnnouncement(state.current, incoming, { held: held.current });
      state.current = next;
      if (shown) display(shown);
    },
    [display],
  );

  useStorymapEvents((event) => show(announceEvent(event, board.current)));
  useAgentAlerts((alert) => show(announceAlert(alert)));

  // SOLTOU: a notícia represada assume agora; se nada foi represado e a atual já venceu, ela sai.
  useEffect(() => {
    if (hold) return;
    const { show: shown, next } = releaseAnnouncer(state.current);
    state.current = next;
    if (shown) display(shown);
    else if (expiredWhileHeld.current) clear();
  }, [hold, display, clear]);

  useEffect(() => {
    if (enabled) return;
    if (timer.current) clearTimeout(timer.current);
    clear();
  }, [enabled, clear]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return news;
}
