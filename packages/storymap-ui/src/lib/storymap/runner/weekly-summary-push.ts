// O PUSH DE SEGUNDA: toda segunda às 9h no fuso do dono, UM aviso com os números da
// semana que acabou e o link para /semana. O único push que não é crítico — a política de push o conhece pelo nome
// (`weekly-summary`), e os críticos seguem iguais. Checado pelo tick da frota (no máximo a cada 5 min); o envio é
// marcado ANTES de sair (no máximo um por segunda, mesmo com um restart no meio).

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import type { AgentAlert } from "@/lib/notifications/event";
import { ALERT_URGENCY } from "@/lib/notifications/event";
import { addDays, weeklyPushDue, weeklyPushText, weeklySummaryHref, type WeeklySummary } from "@/lib/storymap/weekly-summary";

export interface WeeklyPushDeps {
  timeZone(): string | undefined;
  loadLastSent(): Promise<string | null>;
  saveLastSent(monday: string): Promise<void>;
  /** o resumo da semana que começa em `monday`. */
  summarize(monday: string): Promise<WeeklySummary>;
  publish(alert: AgentAlert): void;
}

/** O aviso de segunda. PURA. */
export function weeklySummaryAlert(summary: WeeklySummary, now: number): AgentAlert {
  const { title, body } = weeklyPushText(summary);
  return {
    id: `weekly-summary-${summary.week.from}`,
    kind: "weekly-summary",
    urgency: ALERT_URGENCY["weekly-summary"],
    at: now,
    title,
    body,
    tag: `weekly-summary:${summary.week.from}`,
    url: weeklySummaryHref(summary.week.from),
    event: "weekly-summary",
  };
}

/** Envia o resumo se for a hora (segunda, 9h, ainda não enviado hoje). Devolve a segunda enviada, ou null. */
export async function sendWeeklySummaryIfDue(deps: WeeklyPushDeps, now: number = Date.now()): Promise<string | null> {
  const today = weeklyPushDue(now, deps.timeZone(), await deps.loadLastSent().catch(() => null));
  if (!today) return null;
  await deps.saveLastSent(today);
  const summary = await deps.summarize(addDays(today, -7));
  deps.publish(weeklySummaryAlert(summary, now));
  return today;
}

function statePath(): string {
  return path.join(runnerStateDir(), "weekly-summary.json");
}

/** As deps de produção; `tz` é o fuso do dono (weekly-summary-collect `ownerTimeZone`). */
export function defaultWeeklyPushDeps(tz: string | undefined): WeeklyPushDeps {
  return {
    timeZone: () => tz,
    loadLastSent: async () => {
      const raw = JSON.parse(await fsp.readFile(statePath(), "utf8")) as { lastSentFor?: unknown };
      return typeof raw.lastSentFor === "string" ? raw.lastSentFor : null;
    },
    saveLastSent: async (monday) => {
      await fsp.mkdir(path.dirname(statePath()), { recursive: true });
      await atomicWriteFile(statePath(), JSON.stringify({ v: 1, lastSentFor: monday }, null, 2));
    },
    summarize: async (monday) => (await import("@/lib/storymap/weekly-summary-collect")).collectWeeklySummary(monday),
    publish: (alert) => {
      void import("@/lib/notifications/server/alert-bus").then((m) => m.publishAgentAlert(alert));
    },
  };
}

const CHECK_MIN_INTERVAL_MS = 5 * 60_000;
const LAST_CHECK_KEY = Symbol.for("agileharness.weekly-summary.lastCheck");

/** O tick da frota chama isto; no máximo a cada 5 min. */
export async function maybeSendWeeklySummary(now: number = Date.now()): Promise<string | null> {
  const store = globalThis as unknown as { [LAST_CHECK_KEY]?: number };
  if (now - (store[LAST_CHECK_KEY] ?? 0) < CHECK_MIN_INTERVAL_MS) return null;
  store[LAST_CHECK_KEY] = now;
  const { ownerTimeZone } = await import("@/lib/storymap/weekly-summary-collect");
  return sendWeeklySummaryIfDue(defaultWeeklyPushDeps(ownerTimeZone()), now);
}
