"use client";

// useDocViewPref — per-docType (view, width) preference for the doc shell (DocShell.tsx), persisted
// in localStorage under `doc-view:<docType>` / `doc-width:<docType>`. SSR-safe by construction: the
// initial render (server + first client paint) always uses the caller's `defaults` — localStorage is
// only read in a `useEffect` (post-mount), so there is never a hydration mismatch between server and
// client markup. Which view/width actually applies once hydrated (saved vs. default vs. orphaned) is
// NOT this hook's job — that reconciliation is the pure `resolveDefaultView` in DocShell.tsx.

import { useCallback, useEffect, useState } from "react";

export type DocWidth = "narrow" | "medium" | "wide";

const WIDTHS: readonly DocWidth[] = ["narrow", "medium", "wide"];

function isDocWidth(value: string): value is DocWidth {
  return (WIDTHS as string[]).includes(value);
}

export interface UseDocViewPrefDefaults {
  viewId: string;
  width: DocWidth;
}

export interface UseDocViewPrefResult {
  viewId: string;
  setViewId: (id: string) => void;
  width: DocWidth;
  setWidth: (width: DocWidth) => void;
}

export function useDocViewPref(docType: string, defaults: UseDocViewPrefDefaults): UseDocViewPrefResult {
  const [viewId, setViewIdState] = useState(defaults.viewId);
  const [width, setWidthState] = useState<DocWidth>(defaults.width);

  // Hydrate from localStorage AFTER mount only — reading it during render would make the server
  // and the first client render disagree whenever a saved preference exists.
  useEffect(() => {
    try {
      const savedView = window.localStorage.getItem(`doc-view:${docType}`);
      if (savedView) setViewIdState(savedView);
      const savedWidth = window.localStorage.getItem(`doc-width:${docType}`);
      if (savedWidth && isDocWidth(savedWidth)) setWidthState(savedWidth);
    } catch {
      // localStorage unavailable (private mode, disabled storage) — keep the defaults.
    }
  }, [docType]);

  const setViewId = useCallback(
    (id: string) => {
      setViewIdState(id);
      try {
        window.localStorage.setItem(`doc-view:${docType}`, id);
      } catch {
        // best-effort persistence only
      }
    },
    [docType],
  );

  const setWidth = useCallback(
    (next: DocWidth) => {
      setWidthState(next);
      try {
        window.localStorage.setItem(`doc-width:${docType}`, next);
      } catch {
        // best-effort persistence only
      }
    },
    [docType],
  );

  return { viewId, setViewId, width, setWidth };
}
