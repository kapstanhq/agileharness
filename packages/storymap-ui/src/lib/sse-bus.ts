"use client";

// UMA conexão SSE por URL, compartilhada por toda a página.
//
// O PROBLEMA QUE ISTO RESOLVE (medido, não teórico): cada componente vivo abria o SEU
// `new EventSource("/api/notifications/stream")` — o header (2×), a lixeira, o drift de sistemas, a
// tela do Inbox, o detalhe do item, a fila de perguntas, o provider de runs. Na tela do Inbox isso
// dava **6 conexões abertas ao mesmo host**, que é EXATAMENTE o teto de conexões simultâneas do
// Chrome em HTTP/1.1. Com as 6 presas para sempre (um stream não termina), o navegador não tinha
// mais nenhuma conexão livre: TODO request seguinte — server action, RSC refresh, fetch — ficava na
// fila indefinidamente. O sintoma para o operador é o pior possível: o botão não faz nada. Sem erro,
// sem toast, sem request no servidor. Reproduzido igual na build em produção (mesma contagem de 6),
// então é condição pré-existente do app, não de uma tela.
//
// Com o bus: 1 conexão por canal (hoje 2 no total — notificações e processos), e sobram 4 slots para
// o trabalho de verdade.
//
// O contrato é o mínimo que os call-sites usavam: assine (url, nome do evento, handler) e receba a
// função de cancelar. O handler recebe o MessageEvent CRU — quem precisa do payload (o provider de
// runs, os helpers de /processes) faz o seu próprio parse, como antes.

type Handler = (ev: MessageEvent) => void;

interface Conn {
  es: EventSource;
  /** handlers por nome de evento; o listener nativo é UM por nome. */
  byEvent: Map<string, Set<Handler>>;
  /** fecho adiado — ver {@link CLOSE_GRACE_MS}. */
  closeTimer?: ReturnType<typeof setTimeout>;
}

const conns = new Map<string, Conn>();

/**
 * Um remount do React (navegação, StrictMode em dev) desmonta e remonta em sequência. Fechar a
 * conexão no primeiro unmount e reabrir 1ms depois torraria uma reconexão a cada troca de tela — e
 * pior, criaria a janela em que o evento se perde. O fecho espera; se alguém reassinar antes, é
 * cancelado.
 */
const CLOSE_GRACE_MS = 2000;

const noop = () => {};

/**
 * Assina `event` no stream `url` usando a conexão compartilhada (criando-a na primeira assinatura).
 * Devolve a função de cancelar. No servidor é um no-op (não há EventSource).
 */
export function subscribeSse(url: string, event: string, handler: Handler): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return noop;

  let conn = conns.get(url);
  if (!conn) {
    conn = { es: new EventSource(url), byEvent: new Map() };
    conns.set(url, conn);
  }
  if (conn.closeTimer) {
    clearTimeout(conn.closeTimer);
    conn.closeTimer = undefined;
  }

  let handlers = conn.byEvent.get(event);
  if (!handlers) {
    handlers = new Set();
    conn.byEvent.set(event, handlers);
    const set = handlers;
    // UM listener nativo por nome de evento; ele distribui para os assinantes. Um handler que
    // explode não pode derrubar os outros (nem a conexão) — daí o try/catch por assinante.
    conn.es.addEventListener(event, ((ev: MessageEvent) => {
      for (const fn of [...set]) {
        try {
          fn(ev);
        } catch (err) {
          console.error(`[sse-bus ${url}#${event}] handler falhou:`, err);
        }
      }
    }) as EventListener);
  }
  handlers.add(handler);

  return () => {
    const c = conns.get(url);
    if (!c) return;
    c.byEvent.get(event)?.delete(handler);
    const empty = [...c.byEvent.values()].every((s) => s.size === 0);
    if (!empty || c.closeTimer) return;
    c.closeTimer = setTimeout(() => {
      const still = conns.get(url);
      if (!still || still !== c) return;
      if (![...still.byEvent.values()].every((s) => s.size === 0)) {
        still.closeTimer = undefined;
        return;
      }
      still.es.close();
      conns.delete(url);
    }, CLOSE_GRACE_MS);
  };
}

/** Açúcar para o canal do board (o de longe mais assinado). */
export function subscribeStorymap(handler: Handler): () => void {
  return subscribeSse("/api/notifications/stream", "agileharness", handler);
}

/**
 * A mesma coisa com a CARA de um EventSource — `addEventListener` + `close` — para os call-sites
 * poderem trocar `new EventSource(url)` por `sharedEventSource(url)` e mais nada. É deliberado que a
 * migração seja de UMA palavra: um componente que se esqueça de migrar volta a queimar um slot de
 * conexão, e um diff pequeno é o que faz a revisão notar quem ficou de fora.
 *
 * `close()` cancela SÓ as assinaturas deste chamador — a conexão física morre quando o último
 * assinante sai (com a carência acima), nunca porque um componente desmontou.
 */
export function sharedEventSource(url: string): {
  addEventListener: (event: string, handler: EventListener) => void;
  close: () => void;
} {
  const offs: Array<() => void> = [];
  return {
    addEventListener: (event, handler) => {
      offs.push(subscribeSse(url, event, handler as unknown as Handler));
    },
    close: () => {
      for (const off of offs.splice(0)) off();
    },
  };
}
