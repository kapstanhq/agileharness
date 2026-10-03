"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * A boolean UI preference persisted in localStorage and shared across views by
 * key (e.g. the "show card details" toggle used by both the map and the kanban).
 * SSR-safe: starts at `fallback`, then hydrates from storage on mount.
 */
export function useLocalToggle(key: string, fallback = false): [boolean, () => void] {
  const [on, setOn] = useState(fallback);

  useEffect(() => {
    const v = typeof window === "undefined" ? null : window.localStorage.getItem(key);
    if (v !== null) setOn(v === "1");
  }, [key]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* storage unavailable — keep in-memory only */
      }
      return next;
    });
  }, [key]);

  return [on, toggle];
}
