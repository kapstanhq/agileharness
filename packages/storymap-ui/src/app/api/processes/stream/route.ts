import { getHelperRegistry } from "@/lib/vps/helper-registry";
import type { HelperAgent } from "@/lib/vps/helper-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // the helper registry is a process-global singleton — must share the server's Node process

// SSE stream of the EPHEMERAL helper agents (synchronous panel assistants) running RIGHT NOW.
// A DEDICATED channel (separate from the runner/notifications SSE) so /processes can show these
// in real time — an 8s poll would miss a 3-second one. The ProcessesClient opens an EventSource
// here and overlays each as a transient "ajuda" row that vanishes when the call settles.
export async function GET(request: Request): Promise<Response> {
  const reg = getHelperRegistry();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (helpers: HelperAgent[]) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: helpers\ndata: ${JSON.stringify(helpers)}\n\n`));
        } catch {
          /* controller already closed */
        }
      };

      send(reg.list()); // initial snapshot
      const unsub = reg.subscribe(send); // live updates on every start/end

      // Heartbeat keeps the connection alive through the Caddy proxy.
      const hb = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: hb\n\n`));
        } catch {
          /* ignore */
        }
      }, 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(hb);
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
