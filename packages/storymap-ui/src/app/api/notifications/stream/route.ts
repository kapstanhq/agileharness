// SSE endpoint — the browser opens an EventSource here and receives every
// AgileHarnessEvent live. The first connection also boots the filesystem watcher.

import { ensureWatching } from "@/lib/notifications/server/watcher";
import { getBroadcaster } from "@/lib/notifications/server/sse-broadcaster";
import { subscribeAgentAlerts } from "@/lib/notifications/server/alert-bus";
import {
  currentTerminalAttention,
  onTerminalSnapshot,
  startTerminalAttentionWatch,
} from "@/lib/terminal/attention-watch";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getCardClaims, type CardClaim } from "@/lib/storymap/runner/claims";
import { getMetricsHub } from "@/lib/vps/metrics";
import type { AgentAlert, AgileHarnessEvent } from "@/lib/notifications/event";
import type { TerminalAttention } from "@/lib/terminal/attention";
import type { LogFrame, MergeQueueSnapshot, RunnerLogBatch, RunnerSnapshot } from "@/lib/storymap/runner/types";
import type { VpsMetrics } from "@/lib/vps/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  await ensureWatching();
  const broadcaster = getBroadcaster();
  const registry = getRunnerRegistry();
  const encoder = new TextEncoder();

  let unsubscribe = () => {};
  let unsubscribeRunner = () => {};
  let unsubscribeLog = () => {};
  let unsubscribeMetrics = () => {};
  let unsubscribeMergeQueue = () => {};
  let unsubscribeClaims = () => {};
  let unsubscribeAlerts = () => {};
  let unsubscribeTerminals = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let logFlush: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          return false; // stream closed
        }
      };

      const send = (event: AgileHarnessEvent) => {
        if (!safeEnqueue(`event: agileharness\ndata: ${JSON.stringify(event)}\n\n`)) cleanup();
      };
      const sendRunner = (snapshot: RunnerSnapshot) => {
        if (!safeEnqueue(`event: runner\ndata: ${JSON.stringify(snapshot)}\n\n`)) cleanup();
      };
      const sendLogBatch = (batch: RunnerLogBatch) => {
        if (!safeEnqueue(`event: runner-log\ndata: ${JSON.stringify(batch)}\n\n`)) cleanup();
      };
      const sendMetrics = (m: VpsMetrics) => {
        if (!safeEnqueue(`event: metrics\ndata: ${JSON.stringify(m)}\n\n`)) cleanup();
      };
      const sendMergeQueue = (snap: MergeQueueSnapshot) => {
        if (!safeEnqueue(`event: merge-queue\ndata: ${JSON.stringify(snap)}\n\n`)) cleanup();
      };
      // WS-4.3 — card claims ride the SHARED stream the UI already subscribes to (never a second EventSource):
      // the kanban chip shows who holds a card the instant it changes. The LIVE set for every board (small by
      // construction — one entry per card actually being worked); the client filters by board.
      const sendClaims = (claims: CardClaim[]) => {
        if (!safeEnqueue(`event: claims\ndata: ${JSON.stringify(claims)}\n\n`)) cleanup();
      };
      // AVISOS do agente (hoje: um terminal esperando você). Evento próprio, e não um `storymap`,
      // porque ele não descreve uma escrita de board — ver AgentAlert em notifications/event.ts.
      const sendAlert = (alert: AgentAlert) => {
        if (!safeEnqueue(`event: alert\ndata: ${JSON.stringify(alert)}\n\n`)) cleanup();
      };
      // O RETRATO dos terminais que esperam o operador — o nível, ao lado da borda que é o alerta.
      // O balão do Jido lê daqui: sem o retrato ele só saberia quando algo COMEÇOU, e seguiria
      // dizendo "um terminal te espera" depois de o terminal ter voltado a trabalhar.
      const sendTerminals = (list: TerminalAttention[]) => {
        if (!safeEnqueue(`event: terminals\ndata: ${JSON.stringify(list)}\n\n`)) cleanup();
      };
      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (logFlush) clearInterval(logFlush);
        unsubscribe();
        unsubscribeRunner();
        unsubscribeLog();
        unsubscribeMetrics();
        unsubscribeMergeQueue();
        unsubscribeClaims();
        unsubscribeAlerts();
        unsubscribeTerminals();
      };

      // Coalesce console frames per card and flush every 150ms — --verbose can emit
      // many events, and one SSE frame per event would melt the EventSource.
      const pending = new Map<string, LogFrame[]>();
      const queueFrame = (frame: LogFrame) => {
        const k = `${frame.board}/${frame.cardId}`;
        const arr = pending.get(k);
        if (arr) arr.push(frame);
        else pending.set(k, [frame]);
      };
      const flushLogs = () => {
        if (!pending.size) return;
        for (const frames of pending.values()) {
          if (frames.length) sendLogBatch({ board: frames[0].board, cardId: frames[0].cardId, frames });
        }
        pending.clear();
      };

      safeEnqueue(": connected\n\n");
      unsubscribe = broadcaster.subscribe(send);
      unsubscribeRunner = registry.subscribe(sendRunner);
      unsubscribeLog = registry.logSubscribe(queueFrame);
      // VPS health → `metrics` events. subscribe() hands the cached snapshot immediately and
      // starts the 15s poller (ref-counted: it stops when the last stream disconnects).
      unsubscribeMetrics = getMetricsHub().subscribe(sendMetrics);
      // SM-2 merge train → dedicated `merge-queue` events. Subscribe, then push the current picture
      // (if any) so a page opened with a paused/active queue shows it without waiting for a change.
      unsubscribeMergeQueue = registry.subscribeMergeQueue(sendMergeQueue);
      const mqSnapshot = registry.mergeQueueSnapshot();
      if (mqSnapshot) sendMergeQueue(mqSnapshot);
      // WS-4.3 — subscribe to claim changes, then push the CURRENT reservations so a page opened while an
      // agent already holds a card shows the chip immediately (the store read is async → fire-and-forget).
      // Best-effort: a claims read failure must never break the stream that carries runs/logs/metrics.
      const claims = getCardClaims();
      unsubscribeClaims = claims.subscribe(sendClaims);
      void claims
        .list()
        .then((live) => sendClaims(live))
        .catch(() => {});
      // Terminais: o vigia é always-on (o boot o liga), mas assinar aqui garante que uma instância
      // que ainda não o subiu (dev, rota fria) passe a vigiar assim que alguém abre uma página.
      startTerminalAttentionWatch();
      unsubscribeAlerts = subscribeAgentAlerts(sendAlert);
      unsubscribeTerminals = onTerminalSnapshot(sendTerminals);
      sendTerminals(currentTerminalAttention());
      // Initial snapshot so a page opened mid-run shows the badge right away.
      sendRunner(registry.snapshot());
      // Replay retained console frames so a fresh connection shows the backlog.
      for (const frame of registry.allLogs()) queueFrame(frame);
      flushLogs();
      heartbeat = setInterval(() => {
        if (!safeEnqueue(": ping\n\n")) cleanup();
      }, 25_000);
      logFlush = setInterval(flushLogs, 150);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      if (logFlush) clearInterval(logFlush);
      unsubscribe();
      unsubscribeRunner();
      unsubscribeLog();
      unsubscribeMetrics();
      unsubscribeMergeQueue();
      unsubscribeClaims();
      unsubscribeAlerts();
      unsubscribeTerminals();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
