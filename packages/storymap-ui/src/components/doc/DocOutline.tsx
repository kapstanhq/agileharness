"use client";

// DocOutline — the sticky navigation rail for fullscreen doc pages: scans the RENDERED content for
// h1/h2/h3, assigns anchor ids, and lists them indented by level. Everything stays ONE scroll —
// clicking only scrolls the container (no route change, nothing collapses); the active section
// highlights via IntersectionObserver. DOM-scanned (not model-derived) on purpose: every block
// contributes — markdown body headings, the design-canvas sections, histórico/trajeto widgets,
// async-loaded sidecars — without threading ids through each renderer (a MutationObserver re-scans
// when late blocks mount).

import { useEffect, useState, type RefObject } from "react";
import { cn } from "@/lib/cn";

interface OutlineItem {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "secao"
  );
}

export function DocOutline({
  contentRef,
  scrollRef,
}: {
  /** the element whose headings compose the outline */
  contentRef: RefObject<HTMLElement | null>;
  /** the scroll container (IntersectionObserver root) — null root = viewport */
  scrollRef: RefObject<HTMLElement | null>;
}) {
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let observer: IntersectionObserver | null = null;

    const collect = () => {
      const seen = new Map<string, number>();
      const found: OutlineItem[] = [];
      root.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((el) => {
        const text = (el.textContent ?? "").trim();
        if (!text) return;
        let id = el.id;
        if (!id) {
          const base = slugify(text);
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          id = n > 1 ? `${base}-${n}` : base;
          el.id = id; // attribute mutation — the MutationObserver below watches childList only, no loop
        }
        el.style.scrollMarginTop = "64px"; // clear the sticky toolbar on anchor jumps
        found.push({ id, text, level: el.tagName === "H1" ? 1 : el.tagName === "H2" ? 2 : 3 });
      });
      setItems((prev) =>
        prev.length === found.length && prev.every((p, i) => p.id === found[i].id && p.text === found[i].text)
          ? prev
          : found,
      );
      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible[0]) setActiveId(visible[0].target.id);
        },
        { root: scrollRef.current ?? null, rootMargin: "0px 0px -65% 0px" },
      );
      for (const it of found) {
        const el = document.getElementById(it.id);
        if (el) observer.observe(el);
      }
    };

    collect();
    const mutations = new MutationObserver(collect);
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      observer?.disconnect();
    };
  }, [contentRef, scrollRef]);

  if (items.length < 2) return null;

  return (
    <nav aria-label="Sumário do documento" className="w-52 shrink-0">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Neste documento</p>
      <ul className="space-y-0.5 border-l border-line">
        {items.map((it) => (
          <li key={it.id} className="-ml-px">
            <button
              type="button"
              title={it.text}
              onClick={() =>
                document.getElementById(it.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className={cn(
                "block w-full truncate border-l-2 py-1 pr-2 text-left text-[12px] leading-snug transition",
                it.level === 1 ? "pl-2.5 font-medium" : it.level === 2 ? "pl-2.5" : "pl-5",
                activeId === it.id
                  ? "border-accent text-fg"
                  : "border-transparent text-fg-muted hover:text-fg",
              )}
            >
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
