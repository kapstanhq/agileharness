// AS PALAVRAS DO RITMO DO BOARD (runner/board-pace.ts) — o que o botão do cabeçalho mostra. PURO.

import { sinceWords, untilWords } from "./card-live-status";
import type { BoardPaceView, PaceActor, PaceChange } from "./runner/board-pace";
import { paceLabel } from "./runner/board-pace";

/** Quem pôs o ritmo, para quem está olhando a tela (o dono): «por você» / «por um agente». PURA. */
export function paceWhoWords(by: PaceActor): string {
  return by.kind === "owner" ? "por você" : "por um agente";
}

/**
 * A linha de estado do ritmo: «Ritmo normal», «Pausado por você · há 12 min · volta às 18:00». Para o desarmado e para
 * o registro ilegível, a frase do portão (não há «quem» nem «desde»). PURA.
 */
export function paceStatusLine(view: Pick<BoardPaceView, "level" | "label" | "source" | "why" | "by" | "since" | "until">, now: number, timeZone?: string): string {
  if (view.source === "disarmed") return "Este board está desligado: nenhum passo automático dispara.";
  if (view.source === "unreadable") return `Tudo parado: ${view.why}.`;
  if (view.level === "normal") return "Ritmo normal";
  const parts = [view.by ? `${view.label} ${paceWhoWords(view.by)}` : view.label];
  const since = view.since ? Date.parse(view.since) : NaN;
  if (Number.isFinite(since)) parts.push(sinceWords(since, now));
  const until = view.until ? Date.parse(view.until) : NaN;
  if (Number.isFinite(until) && until > now) parts.push(untilWords(until, now, timeZone));
  return parts.join(" · ");
}

/** Uma linha do histórico: «Pausado por um agente · há 2 h — motivo». PURA. */
export function paceHistoryLine(c: PaceChange, now: number): string {
  const head = c.expired ? `${paceLabel(c.level)} (o prazo venceu)` : `${paceLabel(c.level)} ${paceWhoWords(c.by)}`;
  const at = Date.parse(c.at);
  return [Number.isFinite(at) ? `${head} · ${sinceWords(at, now)}` : head, c.reason].filter(Boolean).join(" — ");
}

/** Quantos minutos faltam até a próxima manhã (hora local de quem chama) — o prazo «até amanhã cedo». PURA. */
export function minutesUntilMorning(now: Date, hour = 8): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000));
}

/** Os prazos que o botão oferece para uma pausa. `minutes` null = sem prazo. */
export const PAUSE_DURATIONS: ReadonlyArray<{ id: "none" | "hour" | "morning"; label: string }> = [
  { id: "none", label: "Sem prazo" },
  { id: "hour", label: "1 hora" },
  { id: "morning", label: "Até amanhã cedo" },
];

export function pauseMinutes(id: "none" | "hour" | "morning", now: Date): number | undefined {
  if (id === "hour") return 60;
  if (id === "morning") return minutesUntilMorning(now);
  return undefined;
}
