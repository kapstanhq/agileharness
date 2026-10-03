"use client";

// O OUVIDO da tela para `inbox.changed` (onda 2, passo 8 — lib/notifications/server/inbox-bus.ts): a lista do Inbox,
// o número da barra e a home releem quando o Inbox de um board que ELAS mostram muda — sem poll. Na conexão SSE
// compartilhada da página (sse-bus), nunca uma a mais.
//
// Recuperação: se a conexão cair e voltar (o celular dormiu, a rede piscou), os eventos do meio se perderam — a
// reabertura dispara uma releitura. A primeira abertura não (quem monta já leu).

import { useEffect, useRef } from "react";
import { subscribeSse } from "@/lib/sse-bus";

const STREAM = "/api/notifications/stream";

/** O evento concerne a esta tela? `boards` null = a tela mostra todos. `board: null` no evento = o host (todos). PURA. */
export function inboxEventConcerns(raw: string, boards: readonly string[] | null): boolean {
  let board: unknown;
  try {
    board = (JSON.parse(raw) as { board?: unknown }).board;
  } catch {
    return true; // na dúvida, relê: um evento torto nunca deixa a tela velha
  }
  if (board == null || boards == null) return true;
  return typeof board === "string" && boards.includes(board);
}

/** Chama `onChange` (com um respiro) quando o Inbox de um dos `boards` muda. */
export function useInboxChanged(onChange: () => void, opts: { boards?: readonly string[] | null; delayMs?: number } = {}): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  const boardsKey = opts.boards ? opts.boards.join("|") : "*";
  const delay = opts.delayMs ?? 400;
  useEffect(() => {
    const boards = boardsKey === "*" ? null : boardsKey.split("|");
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(t);
      t = setTimeout(() => cb.current(), delay);
    };
    let opened = false;
    const offChanged = subscribeSse(STREAM, "inbox.changed", (ev) => {
      if (inboxEventConcerns(String(ev.data ?? ""), boards)) schedule();
    });
    const offOpen = subscribeSse(STREAM, "open", () => {
      if (opened) schedule(); // reconectou: o que mudou no meio se perdeu — relê
      opened = true;
    });
    return () => {
      clearTimeout(t);
      offChanged();
      offOpen();
    };
  }, [boardsKey, delay]);
}
