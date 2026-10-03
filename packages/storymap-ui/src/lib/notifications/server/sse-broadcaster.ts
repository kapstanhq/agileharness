// SSE broadcaster — the bridge channel from the server dispatcher to every
// connected browser. It is a NotificationChannel like any other: the dispatcher
// calls notify(), and we fan the event out to all subscribed response streams.
//
// Held as a process-global singleton so it survives Next dev HMR (each route/
// module reload would otherwise create a fresh, empty subscriber set).

import type { NotificationChannel, AgileHarnessEvent } from "../event";

type Subscriber = (event: AgileHarnessEvent) => void;

class SseBroadcaster implements NotificationChannel {
  readonly id = "sse";
  private subscribers = new Set<Subscriber>();

  /** Register a stream sink; returns an unsubscribe fn (call on stream cancel). */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get size(): number {
    return this.subscribers.size;
  }

  notify(event: AgileHarnessEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // Stream already closed — drop it so it can't wedge the loop.
        this.subscribers.delete(fn);
      }
    }
  }
}

const KEY = Symbol.for("storymap.notifications.sseBroadcaster");
const store = globalThis as unknown as { [KEY]?: SseBroadcaster };

export function getBroadcaster(): SseBroadcaster {
  return (store[KEY] ??= new SseBroadcaster());
}
