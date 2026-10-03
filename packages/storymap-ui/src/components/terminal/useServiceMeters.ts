"use client";

// The client side of /api/processes/meters, shared by the home's Terminais block and /processes.
//
// 15s, and PAUSED while the tab is hidden. Both numbers are deliberate: the meters cost a transcript read
// plus two git spawns per session with a worktree, and a board left open in a background tab would
// otherwise keep the box busy answering questions nobody is looking at. A visible tab refetches
// immediately on focus, so coming back never shows a stale number.
//
// Failure is silent by design: the meters ENRICH a row that already renders without them. A fetch error
// keeps the last good snapshot rather than blanking the numbers — a flicker to "—" reads as "a sessão
// parou de produzir", which is exactly the lie this feature was built to remove.

import { useEffect, useState } from "react";
import type { ServiceMeter } from "@/lib/vps/service-meters";

const POLL_MS = 15_000;

export type MeterMap = Record<string, ServiceMeter>;

export function useServiceMeters(enabled = true): MeterMap {
  const [meters, setMeters] = useState<MeterMap>({});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/processes/meters", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { meters?: MeterMap };
        if (alive && j.meters) setMeters(j.meters);
      } catch {
        /* keep the last good snapshot */
      }
    };

    const start = () => {
      if (timer) return;
      timer = setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        void load();
        start();
      }
    };

    void load();
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return meters;
}
