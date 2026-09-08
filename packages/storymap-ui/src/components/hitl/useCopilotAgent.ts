"use client";

// useCopilotAgent (F1.3) — dirige o chat AGÊNTICO do Jido. MESMA superfície externa do useHitl
// ({turns, status, error, send, cancel, pushTurns, responseMode, setResponseMode, done}) para o
// HitlConversation montar sem fork, MAS o transporte é a rota SSE /api/copilot/turn (sessão headless nativa
// com tools + memória), não o one-shot no-tools do advanceHitlAction.
//
// Streaming: o turno abre um agente PENDENTE (último da lista) que CRESCE ao vivo — chips de tool (activity)
// e texto (message) chegam pelos eventos SSE; o `final` fixa a resposta autoritativa. Cancel mata o processo
// (abort do fetch + rota /cancel). Sessão + thread persistem em sessionStorage (fechar/reabrir não perde).
//
// FILA DE SAÍDA (outbox). O servidor admite 1 turno por board — e é ele quem manda. O que MUDOU (incidente de
// 2026-07-25) é o que o cliente faz com essa recusa: antes um `send` com o board ocupado virava uma bolha
// "⚠ Falha no turno" e o operador tinha de reenviar na mão (e um `send` durante o PRÓPRIO turno era descartado
// em silêncio, no `if (status === "typing") return`). Agora todo envio entra numa FILA e um "pump" serial
// despacha um por vez, re-tentando enquanto o servidor disser "ocupado" — como qualquer chat de agente.
// As duas invariantes que sustentam isso:
//   • NADA SE PERDE: o item só sai da fila quando o servidor ACEITA o turno (ou quando o operador o remove).
//   • NADA SAI DUAS VEZES: só re-tentamos o que o servidor recusou EXPLICITAMENTE (409 transitório). Uma queda
//     de rede sem resposta pausa a fila para o operador decidir — reenviar às cegas poderia duplicar um turno
//     que já começou lá.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HitlAgentTurn, HitlResponseMode, HitlSegment, HitlTurn } from "@/lib/storymap/hitl/types";
import { composeCopilotPrompt, parseSseBuffer, type CopilotSseEvent } from "@/lib/storymap/copilot/protocol";
import { historySignature, shouldAdoptHistory, shouldPollHistory } from "@/lib/storymap/copilot/history-sync";
import {
  OUTBOX_FULL_NOTICE,
  OUTBOX_STUCK_NOTICE,
  classifyTurnRejection,
  dropOutboxItem,
  enqueueOutbox,
  makeOutboxId,
  nextOutboxItem,
  parseRejectionBody,
  runOutboxPump,
  type BusyReason,
  type OutboxItem,
  type TurnAttempt,
} from "@/lib/storymap/copilot/outbox";

export type CopilotStatus = "idle" | "typing" | "error";

// (Aposentado: a classe `HttpError`, que existia só para levar o status 409 até o CopilotChat restaurar o
// rascunho no composer. A FILA substituiu esse remendo — o texto não precisa voltar ao composer porque nunca
// saiu da fila —, e a recusa agora é lida onde acontece, no próprio `runTurn`.)

/**
 * WS-3/3.3 — turns a FAILED turn response into a human-readable message, NEVER the raw `{ok:false,...}` envelope
 * (which used to land as a chat bubble). Pure + exported so it's node-testable — RTL render tests are broken under
 * rolldown-vite, so the logic that matters lives in a pure fn (same discipline as history-sync/outbox).
 *
 * Um 409 TRANSITÓRIO ("um copiloto já está trabalhando neste board" — turno pareado OU ciclo autônomo) ganha copy
 * amigável, mas hoje ela é caminho RARO: a fila absorve o ocupado (espera e reenvia sozinha), então esta linha só
 * aparece quando a espera esgota o teto de 15min. Qualquer outro status usa o `.error` parseado, com fallback
 * `HTTP <status>`. A régua de transitório×permanente é a MESMA do retry (classifyTurnRejection) — uma verdade só.
 */
export function deriveTurnError(status: number, body: string): string {
  if (status === 409 && classifyTurnRejection(status, body).kind === "busy") {
    return "Já há um copiloto trabalhando neste board — sua mensagem fica na fila e sai sozinha quando ele terminar (ou cancele: o turno no chat, ou o ciclo autônomo em Processos).";
  }
  const { error } = parseRejectionBody(body);
  return error ?? `HTTP ${status}`;
}

const isBrowser = typeof window !== "undefined";

/** Q8 — teto de turnos retidos em memória. Uma sessão longa de orquestração pode acumular centenas de turnos
 *  (cada envio anexa; o array crescia sem limite); retemos só os últimos MAX_TURNS ao ANEXAR. O histórico
 *  completo continua no transcript durável do servidor, paginável para trás via loadOlder — que por isso NÃO
 *  é capado (prepend). 200 é folgado p/ conversas normais. */
const MAX_TURNS = 200;

/** Lê a fila persistida (por-aba) — tolerante a lixo: storage corrompido vale fila vazia, nunca uma exceção
 *  no mount. `sessionStorage` é por-ABA, então duas abas nunca herdam a mesma fila (zero envio duplicado). */
function readPersistedOutbox(key: string): OutboxItem[] {
  if (!isBrowser) return [];
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((i): i is OutboxItem => !!i && typeof (i as OutboxItem).id === "string" && typeof (i as OutboxItem).text === "string");
  } catch {
    return [];
  }
}

/** Espera INTERRUPTÍVEL: o backoff da fila não pode segurar um cancelar/retomar por 8s. Quem quer acordar cedo
 *  chama o `wake` guardado no ref (o próprio sleep o instala e o limpa). */
function sleepInterruptible(ms: number, wakeRef: { current: (() => void) | null }): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (wakeRef.current === finish) wakeRef.current = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakeRef.current = finish;
  });
}


/** Opções de um envio. `command` = este texto é uma SLASH COMMAND, não fala do operador: vai ao CLI CRU (sem o
 *  bloco <contexto>, senão a barra não abre o prompt e o comando não roda) e ecoa no thread como EVENTO com
 *  este rótulo, nunca como bolha do humano. */
export interface SendOptions {
  command?: string;
}

export function useCopilotAgent(opts: {
  boardId: string;
  /** contexto de abertura (fallback); getContext re-resolve fresco por turno. */
  context: string;
  /** turnos iniciais (greeting) — usados só quando não há thread persistido. */
  initialTurns?: HitlTurn[];
  /** resolvedor de contexto FRESCO por turno (o board se move sozinho). */
  getContext?: () => Promise<string | undefined>;
  responseMode?: HitlResponseMode;
  /** F3.2 — override de model/effort do chat (quick-settings). */
  model?: string;
  effort?: string;
  /** um ciclo AUTÔNOMO está em voo neste board → o poll near-live acelera (ele está escrevendo na sessão AGORA). */
  tickRunning?: boolean;
  /**
   * A TELA dona desta conversa (ver lib/storymap/copilot/chat-surfaces). Ausente ⇒ o chat do board.
   * É o que separa as conversas ponta a ponta: raia no servidor (turno/cancel), roster e histórico próprios,
   * e cache local por-aba próprio — sem isto, duas telas dividiriam o mesmo `sessionStorage` e a conversa de
   * uma apareceria pintada na outra até o servidor responder.
   */
  view?: string;
  /**
   * A TÉCNICA ativa (`chat-surfaces.techniques`) como instrução de MÉTODO do próximo turno. Lida FRESCA no
   * despacho, igual ao `responseMode`: o que vale é a técnica ligada na hora em que o item sai da fila, não a
   * que estava ligada quando ele entrou. Ausente ⇒ o prompt sai exatamente como sempre saiu.
   */
  instruction?: string;
}) {
  const { boardId, context, initialTurns, getContext, model, effort, tickRunning, view, instruction } = opts;
  const lane = view ? `${boardId}--${view}` : boardId;
  const viewQS = view ? `&view=${encodeURIComponent(view)}` : "";
  const threadKey = `copilot-thread-${lane}`;
  const sessionKey = `copilot-session-${lane}`;
  const outboxKey = `copilot-outbox-${lane}`;

  // Cache LOCAL rápido (sessionStorage, por-aba) — usado só como PINTURA INSTANTÂNEA no (re)mount, enquanto a
  // hidratação do servidor (effect abaixo) resolve. NÃO é mais a autoridade num refresh: o transcript durável do
  // CLI é a fonte da verdade e o effect SEMPRE reconcilia com ele — senão um refresh confiava cego no
  // sessionStorage e não via nada que o servidor avançou por fora deste cliente (tick autônomo, outro dispositivo).
  // O que só existe local (greeting, ecos de pergunta/aprovação) é efêmero e cede à verdade durável.
  const [turns, setTurns] = useState<HitlTurn[]>(() => {
    if (isBrowser) {
      try {
        const raw = sessionStorage.getItem(threadKey);
        if (raw) {
          const parsed = JSON.parse(raw) as HitlTurn[];
          if (Array.isArray(parsed) && parsed.length) return parsed;
        }
      } catch {
        /* ignora storage corrompido */
      }
    }
    return initialTurns ?? [];
  });
  // Paginação do histórico do servidor ("carregar mais antigas"): cursor + se há mais páginas.
  const [hasOlder, setHasOlder] = useState(false);
  const cursorRef = useRef<string | null>(null);
  // B-lite (2B) — o que o servidor tinha na última sincronização: o nº de turnos E a ASSINATURA do conteúdo.
  // A assinatura é o que faz o poll enxergar o tick trabalhando: o nº de turnos fica CONGELADO durante um
  // ciclo (toda a atividade do agente vira UM turno) e só os segmentos de dentro crescem — medir por length
  // era medir a coisa que não muda. Ver history-sync.ts para a medição que provou isso.
  const lastSyncedLenRef = useRef(0);
  const lastSyncedSigRef = useRef<string | null>(null);
  /** marca o que acabamos de adotar como a nova base de comparação (os dois refs andam SEMPRE juntos). */
  const markSynced = useCallback((adopted: HitlTurn[]) => {
    lastSyncedLenRef.current = adopted.length;
    lastSyncedSigRef.current = historySignature(adopted);
  }, []);
  const [responseMode, setResponseMode] = useState<HitlResponseMode>(opts.responseMode ?? "standard");
  const [status, setStatus] = useState<CopilotStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // (Aposentado com o remendo do rascunho: o `errorStatus`, que existia só para levar um 409 até o CopilotChat
  // devolver o texto ao composer. Hoje quem guarda o texto é a fila, e o `error` legível basta para a UI.)
  // A API está engasgando (retry) e ainda não voltou conteúdo. Era o único sinal do stream que a UI descartava
  // — o operador via um "pensando…" que não terminava e não sabia se era lentidão do modelo ou da rede. O rosto
  // do Jido lê isto (fica em `glitch`). Espelhado num ref p/ não chamar setState a cada token.
  const [straining, setStraining] = useState(false);
  const strainingRef = useRef(false);
  const setStrain = useCallback((v: boolean) => {
    if (strainingRef.current === v) return;
    strainingRef.current = v;
    setStraining(v);
  }, []);

  // ── A FILA DE SAÍDA ──────────────────────────────────────────────────────────────────────────────────────
  // `outbox` é o que a UI mostra; `outboxRef` é a AUTORIDADE (o pump é um laço async — ler state dentro dele
  // leria o valor do render em que nasceu). Os dois andam sempre juntos, por `commitOutbox`.
  const [outbox, setOutboxState] = useState<OutboxItem[]>(() => readPersistedOutbox(outboxKey));
  const outboxRef = useRef(outbox);
  // Fila restaurada de um REFRESH nasce PAUSADA: disparar sozinha uma mensagem que o operador ainda não vê (ele
  // acabou de recarregar a página) seria agir atrás dele. Ele retoma com um toque — e nada se perdeu.
  const [outboxPaused, setOutboxPaused] = useState(() => outboxRef.current.length > 0);
  const pausedRef = useRef(outboxPaused);
  const setPaused = useCallback((v: boolean) => {
    pausedRef.current = v;
    setOutboxPaused(v);
  }, []);
  /** ocupado AGORA: por que a cabeça da fila ainda não saiu (null = não estamos esperando espaço). */
  const [waiting, setWaiting] = useState<{ reason: BusyReason } | null>(null);
  const outboxSeqRef = useRef(0);
  const pumpingRef = useRef(false);
  const wakeRef = useRef<(() => void) | null>(null);
  const wake = useCallback(() => wakeRef.current?.(), []);
  const commitOutbox = useCallback(
    (next: OutboxItem[]) => {
      outboxRef.current = next;
      setOutboxState(next);
      if (!isBrowser) return;
      try {
        if (next.length) sessionStorage.setItem(outboxKey, JSON.stringify(next));
        else sessionStorage.removeItem(outboxKey);
      } catch {
        /* quota/estado — a fila em memória segue valendo */
      }
    },
    [outboxKey],
  );

  const sessionIdRef = useRef<string | null>(isBrowser ? sessionStorage.getItem(sessionKey) : null);
  // "Nova conversa" — a sessão que o operador acabou de DESCARTAR. Enquanto isto aponta para uma sessão, nem a
  // hidratação nem o poll near-live re-adotam o transcript dela (mesmo que a deleção do ponteiro no servidor
  // tenha perdido a corrida, ou um tick a re-aponte por um instante). Some quando uma sessão GENUINAMENTE nova
  // é observada (setSessionId com id diferente) — aí o trabalho novo volta a fluir. Ver history-sync.ts.
  const clearedSessionIdRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Robustez a restart/deploy do serviço: distingue uma QUEDA de conexão no meio do turno de uma falha real.
  const sawTerminalRef = useRef(false); // vimos um evento terminal (final/error) do servidor neste turno?
  const streamStartedRef = useRef(false); // o stream SSE chegou a começar? (queda-no-meio ≠ falha ao enviar)

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Persistência DEBOUNCED do thread (C4). Durante o streaming do Jido cada text-delta vira um setTurns; gravar
  // JSON.stringify(thread inteiro) SÍNCRONO na main-thread a cada token é O(n²) numa resposta longa. Em vez disso
  // coalescemos: cada mudança agenda UM write trailing (500ms) e a cleanup cancela o pendente — uma rajada de
  // tokens colapsa num único write. O write FINAL é garantido por dois flushes imediatos — na saída de "typing"
  // (fim do turno) e no unmount — então o stream ao vivo não precisa ser durável a cada caractere e o restore no
  // reload nunca perde o estado final.
  const latestTurnsRef = useRef(turns);
  latestTurnsRef.current = turns; // lido só em callback async (timeout/unmount) — nunca durante o render
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushThread = useCallback(() => {
    if (!isBrowser) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    try {
      sessionStorage.setItem(threadKey, JSON.stringify(latestTurnsRef.current));
    } catch {
      /* quota/estado — não fatal */
    }
  }, [threadKey]);
  // Agenda o write trailing a cada mudança de turns; a cleanup cancela o pendente (coalesce da rajada de tokens).
  useEffect(() => {
    if (!isBrowser) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(flushThread, 500);
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [turns, flushThread]);
  // Flush imediato ao FIM do turno (status deixa de ser "typing"): o estado final tem de ser durável na hora — o
  // operador pode fechar a aba antes dos 500ms do debounce. Cobre também a hidratação/poll ociosos.
  useEffect(() => {
    if (status !== "typing") flushThread();
  }, [status, flushThread]);
  // Flush no unmount: sem isto o timer pendente do debounce seria cancelado sem gravar o último estado.
  useEffect(() => flushThread, [flushThread]);

  const setSessionId = useCallback(
    (id: string) => {
      // Uma sessão GENUINAMENTE nova (id diferente do que foi descartado) solta o guard de "Nova conversa":
      // a partir daqui o poll/hidratação voltam a adotar o servidor normalmente (o operador começou de fato
      // outra conversa, ou um tick abriu uma sessão nova). Sem isto o guard ficaria preso para sempre.
      if (clearedSessionIdRef.current && id !== clearedSessionIdRef.current) clearedSessionIdRef.current = null;
      sessionIdRef.current = id;
      if (isBrowser) {
        try {
          sessionStorage.setItem(sessionKey, id);
        } catch {
          /* ignora */
        }
      }
    },
    [sessionKey],
  );

  // Hidratação/RECONCILIAÇÃO no mount: SEMPRE busca o histórico durável do servidor (transcript do CLI, a fonte da
  // verdade) e o adota quando não-vazio — INCLUSIVE num refresh com thread local. Senão o cliente confiaria cego no
  // sessionStorage e não veria o que o servidor avançou por fora dele (tick autônomo, outro dispositivo). Só corre
  // uma vez, no mount, e só se o operador ainda não interagiu (genRef 0) — nunca clobba um turno em voo; servidor
  // vazio/indisponível (sem ponteiro) mantém a pintura local (ex.: conversa nova só com o greeting).
  useEffect(() => {
    if (!isBrowser) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/copilot/history?boardId=${encodeURIComponent(boardId)}${viewQS}&limit=40`);
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; sessionId?: string | null; turns?: HitlTurn[]; nextCursor?: string | null };
        if (!alive || genRef.current !== 0 || !data?.ok || !Array.isArray(data.turns) || !data.turns.length) return;
        // "Nova conversa" recém-feita: não re-hidratar a sessão descartada (ponteiro pode não ter sido apagado
        // a tempo, ou um tick a re-apontou) — ver clearedSessionIdRef / shouldAdoptHistory.
        if (data.sessionId && data.sessionId === clearedSessionIdRef.current) return;
        setTurns(data.turns);
        markSynced(data.turns); // B-lite baseline (len + assinatura)
        if (data.sessionId) setSessionId(data.sessionId);
        cursorRef.current = data.nextCursor ?? null;
        setHasOlder(Boolean(data.nextCursor));
      } catch {
        /* histórico é best-effort — cai no greeting já montado */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  // B-lite (2B) — near-live: enquanto o painel está aberto e OCIOSO (o operador não está no meio do próprio
  // turno), faz poll do transcript durável e adota quando o CONTEÚDO do servidor muda. É assim que o trabalho
  // do tick autônomo (WS2A escreve na sessão COMPARTILHADA do board) aparece no painel aberto em segundos, sem
  // infra de streaming — o char-by-char é um passo seguinte. Também traz turnos de outro dispositivo.
  // A decisão de adotar é PURA (shouldAdoptHistory) e mede CONTEÚDO, não contagem de turnos: durante um ciclo
  // o nº de turnos não muda uma única vez (toda a atividade do agente é UM turno) — medir length era medir
  // justamente a coisa congelada, e o thread ficava parado o ciclo inteiro. Não roda durante o próprio turno
  // (status≠idle ⇒ effect sai) nem clobba um turno começando (abortRef vivo).
  // O gate é `shouldPollHistory` (não `status === "idle"`): um 409 deixava o hook em "error" e ESSE gate matava o
  // poll para sempre — o painel congelava até um F5 (incidente de 2026-07-25). Ver history-sync.ts.
  useEffect(() => {
    if (!isBrowser || !shouldPollHistory(status)) return;
    let alive = true;
    const poll = async () => {
      // A GERAÇÃO em que este poll nasceu. Sem isto, um poll em voo quando o operador troca de conversa
      // (adoptSession) ou começa outra (reset) volta com o transcript da conversa ANTIGA e o pinta por cima
      // da nova — o thread trocaria sozinho de assunto uma vez, logo após o clique.
      const gen = genRef.current;
      try {
        const res = await fetch(`/api/copilot/history?boardId=${encodeURIComponent(boardId)}${viewQS}&limit=40`);
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; sessionId?: string | null; turns?: HitlTurn[]; nextCursor?: string | null };
        if (!alive || gen !== genRef.current || abortRef.current || !data?.ok || !Array.isArray(data.turns)) return;
        if (
          shouldAdoptHistory(data.turns, lastSyncedLenRef.current, lastSyncedSigRef.current, {
            serverSessionId: data.sessionId ?? null,
            clearedSessionId: clearedSessionIdRef.current,
          })
        ) {
          markSynced(data.turns);
          setTurns(data.turns);
          if (data.sessionId) setSessionId(data.sessionId);
          cursorRef.current = data.nextCursor ?? null;
          setHasOlder(Boolean(data.nextCursor));
        }
      } catch {
        /* best-effort */
      }
    };
    // Com um ciclo autônomo EM VOO — ou com a fila esperando espaço — o painel está assistindo alguém trabalhar,
    // e 2s faz o trabalho dele chegar em saltos curtos. Ocioso de verdade, o poll é só uma rede de segurança
    // (outro dispositivo) e 5s sobra.
    const t = setInterval(poll, tickRunning || waiting ? 2_000 : 5_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [boardId, viewQS, status, setSessionId, tickRunning, waiting, markSynced]);

  /** "Carregar mais antigas": pagina o histórico do servidor p/ trás e PREPENDA os turnos mais velhos. */
  const loadOlder = useCallback(async () => {
    const cur = cursorRef.current;
    if (!cur || !isBrowser) return;
    try {
      const res = await fetch(`/api/copilot/history?boardId=${encodeURIComponent(boardId)}${viewQS}&before=${cur}&limit=40`);
      if (!res.ok) return;
      const data = (await res.json()) as { ok?: boolean; turns?: HitlTurn[]; nextCursor?: string | null };
      if (!data?.ok || !Array.isArray(data.turns) || !data.turns.length) {
        setHasOlder(false);
        return;
      }
      setTurns((prev) => [...data.turns!, ...prev]);
      cursorRef.current = data.nextCursor ?? null;
      setHasOlder(Boolean(data.nextCursor));
    } catch {
      /* ignora */
    }
  }, [boardId, viewQS]);

  /** Atualiza o ÚLTIMO turno do agente (o pendente durante o streaming), imutável. */
  const patchPendingAgent = useCallback((fn: (t: HitlAgentTurn) => HitlAgentTurn) => {
    setTurns((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === "agent") {
          next[i] = fn(next[i] as HitlAgentTurn);
          break;
        }
      }
      return next;
    });
  }, []);

  // Atualiza UM segmento (por segId) do turno pendente, imutável.
  const patchSeg = useCallback(
    (segId: string, fn: (s: HitlSegment) => HitlSegment) =>
      patchPendingAgent((t) => {
        const segs = t.segments ?? [];
        const idx = segs.findIndex((s) => s.segId === segId);
        if (idx < 0) return t;
        const next = segs.slice();
        next[idx] = fn(next[idx]);
        return { ...t, segments: next };
      }),
    [patchPendingAgent],
  );

  const handleEvent = useCallback(
    (ev: CopilotSseEvent) => {
      switch (ev.kind) {
        case "init":
          setSessionId(ev.sessionId);
          break;
        case "text-delta":
          setStrain(false); // voltou a produzir → o engasgo passou
          // anexa tokens ao segmento de texto (cria na 1ª vez → aparece NA ORDEM entre as tools).
          patchPendingAgent((t) => {
            const segs = t.segments ?? [];
            const idx = segs.findIndex((s) => s.type === "text" && s.segId === ev.segId);
            if (idx >= 0) {
              const next = segs.slice();
              const s = next[idx] as Extract<HitlSegment, { type: "text" }>;
              next[idx] = { ...s, text: s.text + ev.text };
              return { ...t, segments: next };
            }
            return { ...t, segments: [...segs, { type: "text", segId: ev.segId, text: ev.text }] };
          });
          break;
        case "tool-start":
          setStrain(false); // voltou a produzir → o engasgo passou
          patchPendingAgent((t) => ({
            ...t,
            segments: [...(t.segments ?? []), { type: "tool", segId: ev.segId, name: ev.name, summary: ev.summary, status: "running" }],
          }));
          break;
        case "tool-input":
          // input + summary AUTORITATIVO (o tool-start veio com input={} → summary vazio) + terminalUrl.
          patchSeg(ev.segId, (s) =>
            s.type === "tool"
              ? {
                  ...s,
                  input: ev.input,
                  ...(ev.summary ? { summary: ev.summary } : {}),
                  ...(ev.terminalUrl ? { terminalUrl: ev.terminalUrl } : {}),
                }
              : s,
          );
          break;
        case "tool-end":
          patchSeg(ev.segId, (s) => (s.type === "tool" ? { ...s, status: ev.ok ? "done" : "error", output: ev.output } : s));
          break;
        case "frame":
          // Notas de sistema (sessão iniciada / retry / MCP) — fora do fluxo de segmentos (o rodapé "pensando"
          // cobre). O `api-retry` é a exceção: vira SINAL (o rosto engasga junto). Discriminado por `code`,
          // nunca pelo texto — o texto é copy.
          if (ev.code === "api-retry") setStrain(true);
          break;
        case "final":
          // o texto já streamou como segmentos; nada a fazer aqui (o status volta a idle no fim do fetch).
          setStrain(false);
          sawTerminalRef.current = true;
          break;
        case "error":
          setStrain(false);
          sawTerminalRef.current = true;
          patchPendingAgent((t) => ({
            ...t,
            segments: [...(t.segments ?? []), { type: "text", segId: "error", text: `⚠ ${ev.message}` }],
          }));
          setStatus("error");
          setError(ev.message);
          break;
      }
    },
    [patchPendingAgent, patchSeg, setSessionId, setStrain],
  );

  /** Marca as tools ainda "running" do turno pendente como interrompidas (o processo caiu no meio delas). */
  const markRunningToolsInterrupted = useCallback(() => {
    patchPendingAgent((t) => ({
      ...t,
      segments: (t.segments ?? []).map((s) => (s.type === "tool" && s.status === "running" ? { ...s, status: "error" as const } : s)),
    }));
  }, [patchPendingAgent]);

  /**
   * Recuperação pós-queda (restart/deploy): espera o servidor voltar e RE-HIDRATA a conversa do transcript
   * durável (o mesmo mecanismo do reopen). Substitui o thread só se o turno FOI registrado (a última fala do
   * humano no servidor bate com a que enviamos) — senão mantém o thread local e orienta a reenviar (não some
   * mensagem). Aborta se o operador cancelar/fechar/começar outro turno (gen).
   */
  const recoverFromServer = useCallback(
    async (gen: number, sentText: string) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!aliveRef.current || gen !== genRef.current) return;
        await new Promise((r) => setTimeout(r, attempt === 0 ? 1200 : 3000)); // servidor reinicia em ~5s + boot
        if (!aliveRef.current || gen !== genRef.current) return;
        let data: { ok?: boolean; sessionId?: string | null; turns?: HitlTurn[]; nextCursor?: string | null } | null = null;
        try {
          const res = await fetch(`/api/copilot/history?boardId=${encodeURIComponent(boardId)}${viewQS}&limit=40`);
          if (!res.ok) continue;
          data = await res.json();
        } catch {
          continue; // ainda fora do ar — tenta de novo
        }
        if (!aliveRef.current || gen !== genRef.current) return;
        if (!data?.ok) return; // respondeu com erro estrutural — desiste
        const turns = Array.isArray(data.turns) ? data.turns : [];
        const lastHuman = [...turns].reverse().find((t) => t.role === "human") as { text?: string } | undefined;
        const recorded = turns.length > 0 && (lastHuman?.text ?? "").trim() === sentText.trim();
        if (recorded) {
          setTurns(turns);
          markSynced(turns); // B-lite baseline (len + assinatura)
          if (data.sessionId) setSessionId(data.sessionId);
          cursorRef.current = data.nextCursor ?? null;
          setHasOlder(Boolean(data.nextCursor));
          setError(null);
        } else {
          patchPendingAgent((t) => ({
            ...t,
            segments: [...(t.segments ?? []), { type: "text", segId: "reconnect", text: "✓ Servidor de volta. Se faltou a resposta, mande a mensagem de novo." }],
          }));
        }
        setStatus("idle");
        return;
      }
      if (!aliveRef.current || gen !== genRef.current) return;
      patchPendingAgent((t) => ({
        ...t,
        segments: [...(t.segments ?? []), { type: "text", segId: "reconnect", text: "O servidor não voltou a tempo. Reabra o chat mais tarde para recuperar a conversa." }],
      }));
      setStatus("idle");
    },
    [boardId, viewQS, setSessionId, patchPendingAgent, markSynced],
  );

  /**
   * O item entrou na CONVERSA: o servidor aceitou o turno. É o único ponto em que um envio sai da fila — e é o que
   * torna as duas invariantes verdadeiras ao mesmo tempo (nada se perde antes do aceite; nada sai duas vezes
   * depois dele). Antes, o eco era anexado ANTES do fetch: um 409 deixava no thread uma fala do operador que o
   * servidor nunca ouviu, seguida de uma bolha de erro.
   */
  const acceptDispatch = useCallback(
    (item: OutboxItem) => {
      commitOutbox(dropOutboxItem(outboxRef.current, item.id));
      // Um COMANDO não é fala do operador: ele entra no thread como EVENTO (a mesma linha centrada do tick) e
      // vai ao CLI CRU. Os dois lados importam. (1) O eco: ecoar `/compact` como bolha do humano era sintaxe de
      // comando crua no chat — o mesmo defeito do vazamento do tick, por outro caminho. (2) O envio: o
      // composeCopilotPrompt prepende o bloco `<contexto>`, e uma slash command só é comando quando abre o
      // prompt — embrulhada, ela virava texto solto no fim de um prompt comum e o CLI não compactava NADA (o
      // operador gastava um turno, com custo, achando que tinha compactado). Medido: `/compact` por stdin, sem
      // wrapper, o CLI expande e executa ("Not enough messages to compact." veio do próprio comando).
      const echo: HitlTurn = item.command
        ? // `kind: "command"` — o evento é AÇÃO DO OPERADOR (ele rodou /compact), não o tick acordando.
          // Os dois desenham a mesma linha centrada; o ícone é que diz de quem foi o gesto.
          { role: "notice", kind: "command", text: item.command }
        : {
            role: "human",
            text: item.text.trim(),
            ...(item.selectedOptionIds?.length ? { selectedOptionIds: item.selectedOptionIds } : {}),
            ...(item.images?.length ? { images: item.images } : {}),
          };
      const pending: HitlTurn = { role: "agent", message: "", segments: [] };
      setTurns((prev) => [...prev, echo, pending].slice(-MAX_TURNS)); // Q8 — teto de retenção em memória
      setWaiting(null);
      setStatus("typing");
    },
    [commitOutbox],
  );

  /** UMA tentativa de despachar um item da fila. Não mexe na fila além do aceite — quem decide seguir, esperar
   *  ou pausar é o pump (abaixo), que lê o desfecho. */
  const runTurn = useCallback(
    async (item: OutboxItem): Promise<TurnAttempt> => {
      const gen = ++genRef.current;
      const sentText = item.text.trim();
      setError(null);
      setStatus((s) => (s === "error" ? "idle" : s)); // tentar de novo já limpa a cara de erro
      setStrain(false); // turno novo começa sem engasgo herdado do anterior
      sawTerminalRef.current = false;
      streamStartedRef.current = false;

      // Contexto FRESCO a CADA tentativa (o board se move enquanto a fila espera) — e é também a renovação do
      // lease de pareamento: quem está na fila está engajado, então o tick não deve abrir outro ciclo por cima.
      const freshContext = item.command ? undefined : getContext ? await getContext().catch(() => context) : context;
      if (!aliveRef.current || gen !== genRef.current) return { kind: "aborted" };

      const prompt = item.command
        ? sentText // CRU: a barra tem de ser o 1o caractere do prompt, senão não é comando
        : composeCopilotPrompt({
            context: freshContext,
            text: sentText,
            images: item.images,
            responseMode,
            instruction,
          });
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/copilot/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            boardId,
            view,
            text: prompt,
            sessionId: sessionIdRef.current ?? undefined,
            model,
            effort,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          // A recusa do servidor decide o destino do item. OCUPADO (409 transitório) não é erro: o item fica na
          // fila, sem tocar no thread, e o pump espera. Qualquer outra recusa é falha REAL — aí sim ela aparece.
          const rejection = classifyTurnRejection(res.status, body);
          if (rejection.kind === "busy") return { kind: "busy", reason: rejection.reason };
          setStatus("error");
          setError(deriveTurnError(res.status, body));
          return { kind: "fatal" };
        }
        // ACEITO ⇒ agora (e só agora) o envio vira conversa.
        acceptDispatch(item);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        streamStartedRef.current = true; // o stream começou — daqui pra frente uma queda é "conexão perdida"
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!aliveRef.current || gen !== genRef.current) return { kind: "aborted" }; // cancelado/desmontado
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSseBuffer(buffer);
          buffer = rest;
          for (const ev of events) handleEvent(ev);
        }
        if (!aliveRef.current || gen !== genRef.current) return { kind: "aborted" };
        // Stream fechou SEM um terminal (final/error): o processo foi interrompido (crash/kill/restart) com o
        // servidor ainda de pé → recupera do transcript durável em vez de deixar o turno mudo e "concluído".
        if (!sawTerminalRef.current) {
          markRunningToolsInterrupted();
          patchPendingAgent((t) => ({
            ...t,
            segments: [...(t.segments ?? []), { type: "text", segId: "interrupted", text: "⚠ O turno foi interrompido antes de concluir. Recuperando do servidor…" }],
          }));
          void recoverFromServer(gen, sentText);
          return { kind: "sent" }; // já foi aceito — reenviar duplicaria o turno
        }
        setStatus((s) => (s === "error" ? s : "idle"));
        return { kind: "sent" };
      } catch (e) {
        if (!aliveRef.current || gen !== genRef.current) return { kind: "aborted" };
        if (e instanceof DOMException && e.name === "AbortError") return { kind: "aborted" }; // cancel explícito
        // Queda MID-turno (o stream começou e não vimos terminal) = conexão perdida (provável restart/deploy do
        // serviço) — NÃO é uma falha do turno. Mensagem clara + recuperação automática pelo transcript durável.
        if (streamStartedRef.current && !sawTerminalRef.current) {
          markRunningToolsInterrupted();
          patchPendingAgent((t) => ({
            ...t,
            segments: [...(t.segments ?? []), { type: "text", segId: "dropped", text: "⚠ Conexão com o servidor perdida (provável restart/deploy). Recuperando a conversa…" }],
          }));
          void recoverFromServer(gen, sentText);
          return { kind: "sent" }; // aceito antes da queda — a recuperação cuida; não reenviar
        }
        // Falha ANTES do stream (rede/proxy caído, serviço reiniciando): o item NUNCA entrou na conversa e segue
        // na fila. Mas não re-tentamos sozinhos — sem resposta do servidor não sabemos se o turno começou lá, e
        // um reenvio às cegas duplicaria trabalho de agente. A fila pausa e o operador retoma com um toque.
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
        return { kind: "fatal" };
      } finally {
        abortRef.current = null;
      }
    },
    [boardId, view, context, getContext, responseMode, model, effort, instruction, acceptDispatch, handleEvent, patchPendingAgent, markRunningToolsInterrupted, recoverFromServer, setStrain],
  );

  // O pump chama SEMPRE a versão mais nova do runTurn (contexto/modelo/verbosidade mudam entre turnos) sem se
  // recriar por isso — se ele se recriasse, dois pumps poderiam coexistir e a fila sairia fora de ordem.
  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;

  /**
   * O PUMP, ligado ao mundo real. A POLÍTICA (ordem, re-tentativa, teto, pausa) é pura e vive em
   * `runOutboxPump`; aqui só injetamos a fila, a rede, o relógio e os setState. O `pumpingRef` é o que garante
   * UM laço por chat — dois laços sobre a mesma fila mandariam fora de ordem.
   */
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      await runOutboxPump({
        next: () => nextOutboxItem(outboxRef.current, { paused: pausedRef.current }),
        attempt: (item) => runTurnRef.current(item),
        sleep: (ms) => sleepInterruptible(ms, wakeRef),
        now: () => Date.now(),
        alive: () => aliveRef.current,
        onWaiting: (reason) => setWaiting(reason ? { reason } : null),
        onExhausted: () => {
          setPaused(true);
          setError(OUTBOX_STUCK_NOTICE);
        },
        onFatal: () => setPaused(true), // o item segue na fila, intacto e visível
      });
    } finally {
      pumpingRef.current = false;
    }
  }, [setPaused]);

  /**
   * ENFILEIRA um envio e acorda o pump. Nunca recusa por ocupação e nunca descarta em silêncio (o antigo
   * `if (status === "typing") return` engolia um envio inteiro — inclusive o `/compact`, que o operador via
   * "não fazer nada"). A ordem de digitação é a ordem de envio.
   */
  const send = useCallback(
    async (text: string, selectedOptionIds?: string[], images?: string[], opts?: SendOptions) => {
      if (!text.trim() && !images?.length) return; // nada a enviar (o composer já barra; este é o cinto)
      const item: OutboxItem = {
        id: makeOutboxId(++outboxSeqRef.current),
        text,
        ...(selectedOptionIds?.length ? { selectedOptionIds } : {}),
        ...(images?.length ? { images } : {}),
        ...(opts?.command ? { command: opts.command } : {}),
        enqueuedAt: Date.now(),
      };
      const { queue, accepted } = enqueueOutbox(outboxRef.current, item);
      if (!accepted) {
        setError(OUTBOX_FULL_NOTICE);
        return;
      }
      commitOutbox(queue);
      // Enviar é intenção EXPLÍCITA: solta a pausa e acorda um backoff em curso (o operador acabou de agir; ele
      // não deve esperar o timer). A ordem FIFO segue — o que estava na frente continua na frente.
      setPaused(false);
      setError(null);
      wake();
      void pump();
    },
    [commitOutbox, pump, setPaused, wake],
  );

  /** Retoma uma fila pausada (por cancelar, por falha, ou restaurada de um refresh). */
  const resumeOutbox = useCallback(() => {
    setPaused(false);
    setError(null);
    wake();
    void pump();
  }, [pump, setPaused, wake]);

  /** Remove um envio da fila — o ✕ na bolha. É a única forma de um item sair sem ter sido enviado. */
  const removeFromOutbox = useCallback(
    (id: string) => {
      commitOutbox(dropOutboxItem(outboxRef.current, id));
    },
    [commitOutbox],
  );

  /** Cancela o turno em voo: aborta o fetch (mata o processo no server) + belt na rota /cancel. */
  const cancel = useCallback(() => {
    genRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
    // Cancelar significa PARE, não "pule para a próxima": a fila pausa em vez de disparar o próximo envio na
    // cara do operador. Nada se perde — os itens seguem visíveis, com ✕ para remover e "retomar" para seguir.
    if (outboxRef.current.length) setPaused(true);
    setWaiting(null);
    wake(); // se o pump estava em backoff, ele acorda, vê pausado e sai
    patchPendingAgent((t) => {
      const segs = t.segments ?? [];
      // marca tools ainda "running" como interrompidas + anexa uma nota, se o turno não produziu nada.
      const patched = segs.map((s) => (s.type === "tool" && s.status === "running" ? { ...s, status: "error" as const } : s));
      const hasContent = patched.some((s) => (s.type === "text" && s.text.trim()) || s.type === "tool");
      return { ...t, segments: hasContent ? patched : [...patched, { type: "text", segId: "cancel", text: "(cancelado)" }] };
    });
    if (isBrowser && sessionIdRef.current) {
      void fetch("/api/copilot/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId, view, sessionId: sessionIdRef.current }),
        keepalive: true,
      }).catch(() => {});
    }
  }, [boardId, view, patchPendingAgent, setPaused, wake]);

  /** Injeta turnos LOCALMENTE (sem chamar o agente) — usado p/ o fluxo de resposta de pergunta inline (F6.2). */
  const pushTurns = useCallback((extra: HitlTurn[]) => {
    setTurns((prev) => [...prev, ...extra].slice(-MAX_TURNS)); // Q8 — teto de retenção em memória
  }, []);

  /** Nova conversa: limpa a sessão + o thread (botão na F3). */
  const reset = useCallback(() => {
    genRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    // Marca a sessão descartada ANTES de zerar o ref: enquanto o servidor ainda puder devolver o transcript dela
    // (deleção do ponteiro é best-effort/assíncrona, e um tick pode re-apontá-la), o poll/hidratação a ignoram.
    clearedSessionIdRef.current = sessionIdRef.current;
    sessionIdRef.current = null;
    cursorRef.current = null;
    // Zera a base de comparação do poll: sem isto, os refs guardavam o tamanho/assinatura da conversa ANTIGA, e o
    // primeiro poll pós-reset (com o ponteiro ainda vivo por uma fração de segundo) re-adotava o transcript
    // descartado. É o segundo meio-caminho do bug de "o histórico volta sozinho" — o guard acima é o primeiro.
    lastSyncedLenRef.current = 0;
    lastSyncedSigRef.current = null;
    setHasOlder(false);
    setStatus("idle");
    setError(null);
    setTurns(initialTurns ?? []);
    // "Nova conversa" limpa a fila também: manter envios da conversa DESCARTADA para disparar na próxima seria
    // exatamente o "algo saiu sozinho" que a fila existe para não fazer.
    commitOutbox([]);
    setPaused(false);
    setWaiting(null);
    wake();
    if (isBrowser) {
      try {
        sessionStorage.removeItem(sessionKey);
        sessionStorage.removeItem(threadKey);
      } catch {
        /* ignora */
      }
    }
  }, [initialTurns, sessionKey, threadKey, commitOutbox, setPaused, wake]);

  /**
   * TROCA a conversa aberta: adota `sessionId` como a sessão deste painel e re-hidrata o thread do transcript
   * DELA. O lado servidor (o ponteiro do board) já foi trocado por quem chamou — aqui é só o lado cliente.
   *
   * Ele é o `reset` com um destino: mesma limpeza (turno em voo abortado, fila descartada, base do poll
   * zerada, sessão local reapontada) porque as duas coisas que ficariam para trás — um envio enfileirado e o
   * baseline do poll — pertencem à conversa que está saindo da tela. O thread é esvaziado ANTES do fetch de
   * propósito: mostrar os turnos da conversa anterior sob o nome da nova seria a única saída desonesta.
   */
  const adoptSession = useCallback(
    async (sessionId: string) => {
      const sid = sessionId.trim();
      if (!sid) return;
      const gen = ++genRef.current;
      abortRef.current?.abort();
      abortRef.current = null;
      clearedSessionIdRef.current = null; // retomar é o gesto EXPLÍCITO que supera o guard de "Nova conversa"
      lastSyncedLenRef.current = 0;
      lastSyncedSigRef.current = null;
      cursorRef.current = null;
      setHasOlder(false);
      setStatus("idle");
      setError(null);
      setTurns([]);
      commitOutbox([]);
      setPaused(false);
      setWaiting(null);
      wake();
      setSessionId(sid);
      if (!isBrowser) return;
      try {
        const res = await fetch(`/api/copilot/history?boardId=${encodeURIComponent(boardId)}${viewQS}&limit=40`);
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; turns?: HitlTurn[]; nextCursor?: string | null };
        if (!aliveRef.current || gen !== genRef.current || !data?.ok || !Array.isArray(data.turns)) return;
        setTurns(data.turns);
        markSynced(data.turns);
        cursorRef.current = data.nextCursor ?? null;
        setHasOlder(Boolean(data.nextCursor));
      } catch {
        /* best-effort: o poll near-live re-tenta em segundos */
      }
    },
    [boardId, viewQS, commitOutbox, markSynced, setPaused, setSessionId, wake],
  );

  // Desmonte: o timer do backoff não pode sobreviver ao painel (o `aliveRef` já barra o efeito, isto solta o
  // timer). A fila em si PERSISTE (sessionStorage) — reabrir o painel a mostra pausada, com tudo intacto.
  useEffect(() => () => wake(), [wake]);

  // `done` é sempre null (chat aberto — nunca resolve com payload), p/ paridade de tipo com useHitl.
  return useMemo(
    () => ({
      turns,
      status,
      error,
      straining,
      responseMode,
      setResponseMode,
      send,
      cancel,
      pushTurns,
      reset,
      /** troca a conversa aberta deste painel (retomada do histórico) e re-hidrata o thread dela. */
      adoptSession,
      loadOlder,
      hasOlder,
      /** os envios confirmados que ainda não foram aceitos pelo servidor, em ordem de saída. */
      outbox,
      /** a fila está parada esperando o operador (cancelou, falhou, ou veio de um refresh)? */
      outboxPaused,
      /** por que a cabeça da fila ainda não saiu (null = não estamos esperando espaço). */
      waiting,
      resumeOutbox,
      removeFromOutbox,
      done: null as null,
    }),
    [
      turns,
      status,
      error,
      straining,
      responseMode,
      send,
      cancel,
      pushTurns,
      reset,
      adoptSession,
      loadOlder,
      hasOlder,
      outbox,
      outboxPaused,
      waiting,
      resumeOutbox,
      removeFromOutbox,
    ],
  );
}
