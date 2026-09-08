"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "storymap.theme";

/**
 * App theme (light/dark), persisted in localStorage and applied as the `dark`
 * class on <html>. Light (warm-neutral) is the default — the inline bootstrap script in
 * layout.tsx already set the class before paint, so on mount we just READ the
 * current class to stay in sync (no flash, no hydration mismatch).
 */
export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setThemeState(isDark ? "dark" : "light");
  }, []);

  const apply = useCallback((next: Theme) => {
    setThemeState(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, []);

  const toggle = useCallback(() => {
    apply(document.documentElement.classList.contains("dark") ? "light" : "dark");
  }, [apply]);

  return { theme, toggle, setTheme: apply };
}
