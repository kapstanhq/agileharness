"use client";

// useHitl — dirige a conversa HITL (ping-pong de turnos). Stateless no servidor: cada turno reenvia o
// transcript inteiro a advanceHitlAction (modelo CaptureTurn). Multi-round até o agente emitir `done`.
//
// Robustez: descarta respostas que chegam após DESMONTAR ou após um CANCEL (a server action segue no
// servidor com seu próprio watchdog, mas o cliente ignora o resultado tardio — sem setState em componente
// morto). Persistência opcional: `initialTurns` retoma uma conversa e `onTurnsChange` deixa o host guardá-la
// fora (ex. por tempId), de modo que fechar/reabrir o popover NÃO perde os rounds já trocados.

import { useCallback, useEffect, useRef, useState } from "react";
import { advanceHitlAction } from "@/app/hitl-actions";
import type { HitlResponseMode, HitlTranscript, HitlTurn } from "@/lib/storymap/hitl/types";

export type HitlStatus = "idle" | "typing" | "error";

/** Q8 — teto de turnos retidos em memória. useHitl é um ping-pong curto (roda até o `done`), mas o cap protege
 *  contra crescimento sem limite ao anexar. 200 é folgado p/ qualquer conversa HITL normal. */
const MAX_TURNS = 200;

export function useHitl(opts: {
  purpose: string;
  /** contexto do consumidor já serializado em texto (o item, o board, etc.). */
  context?: string;
  /** board de origem — atribui o helper em /processes. */
  boardId?: string;
  responseMode?: HitlResponseMode;
  /** transcript inicial — retoma uma conversa persistida (não perde rounds ao reabrir). */
  initialTurns?: HitlTurn[];
  /** chamado a cada mudança no transcript — o host persiste fora (ex. por tempId). */
  onTurnsChange?: (turns: HitlTurn[]) => void;
  /** chamado quando o agente emite `done` (a conversa resolveu). */
  onResolve?: (done: unknown, transcript: HitlTranscript) => void;
  /** 3.4 — resolvedor de contexto FRESCO por turno: se presente, é chamado antes de CADA turno e seu retorno
   *  (não o `context` congelado) vai ao agente. Sidesteppa a corrida setState→send (o advance captura `context`
   *  por closure). Consumidores sem getContext usam o `context` estático — comportamento inalterado. */
  getContext?: () => Promise<string | undefined>;
}) {
  const { purpose, context, boardId, onResolve, onTurnsChange, getContext } = opts;
  const [turns, setTurns] = useState<HitlTurn[]>(opts.initialTurns ?? []);
  const [responseMode, setResponseMode] = useState<HitlResponseMode>(opts.responseMode ?? "terse");
  const [status, setStatus] = useState<HitlStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<unknown | null>(null);

  // aliveRef: false após desmontar. genRef: id do turno em voo — um cancel/novo turno o incrementa, então
  // a resposta do turno antigo é ignorada quando chega.
  const aliveRef = useRef(true);
  const genRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const advance = useCallback(
    async (nextTurns: HitlTurn[]) => {
      const gen = ++genRef.current;
      setStatus("typing");
      setError(null);
      let res: Awaited<ReturnType<typeof advanceHitlAction>>;
      // 3.4 — re-resolve o contexto ANTES do turno (o board se move sozinho: runs terminam, cards andam). O
      // RETORNO é o que vale — evita a corrida em que o host faz setContext(fresh) + send() no mesmo tick mas
      // o advance ainda leria o `context` velho pela closure. Sem getContext → usa o `context` estático.
      const freshContext = getContext ? await getContext().catch(() => context) : context;
      try {
        res = await advanceHitlAction({ purpose, context: freshContext, boardId, responseMode, transcript: { turns: nextTurns } });
      } catch (e) {
        if (!aliveRef.current || gen !== genRef.current) return; // desmontado/cancelado → ignora
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!aliveRef.current || gen !== genRef.current) return; // resposta tardia de turno abortado
      if (res.ok && res.data) {
        const agentTurn = res.data.turn;
        const all = [...nextTurns, agentTurn].slice(-MAX_TURNS); // Q8 — teto de retenção em memória
        setTurns(all);
        onTurnsChange?.(all);
        setStatus("idle");
        if (agentTurn.done !== undefined) {
          setDone(agentTurn.done);
          onResolve?.(agentTurn.done, { turns: all });
        }
      } else {
        setStatus("error");
        setError(res.ok ? "Resposta vazia do agente." : res.error);
      }
    },
    [purpose, context, boardId, responseMode, onResolve, onTurnsChange, getContext],
  );

  const send = useCallback(
    (text: string, selectedOptionIds?: string[]) => {
      if (status === "typing" || done !== null) return;
      const next: HitlTurn[] = [...turns, { role: "human" as const, text: text.trim(), selectedOptionIds }].slice(-MAX_TURNS); // Q8
      setTurns(next);
      onTurnsChange?.(next);
      advance(next);
    },
    [turns, status, done, advance, onTurnsChange],
  );

  /** 3.1 — injeta turnos LOCALMENTE (sem chamar o LLM): usado p/ responder uma pergunta de card INLINE — o
   *  copiloto não decide a resposta, o humano decide, então o round de resposta não passa pelo agente. Não
   *  herda o guard busy/done do `send` (é edição local do transcript). */
  const pushTurns = useCallback((extra: HitlTurn[]) => {
    setTurns((prev) => [...prev, ...extra].slice(-MAX_TURNS)); // Q8 — teto de retenção em memória
  }, []);

  /** Abre a conversa pelo agente (1º turno, sem entrada humana) — quando o agente começa perguntando. */
  const start = useCallback(() => {
    if (turns.length === 0 && status === "idle" && done === null) advance([]);
  }, [turns.length, status, done, advance]);

  /** Cancela o turno em voo (ignora a resposta tardia) e volta a ocioso. */
  const cancel = useCallback(() => {
    genRef.current++;
    setStatus("idle");
  }, []);

  return { turns, status, error, responseMode, setResponseMode, send, start, cancel, done, pushTurns };
}
