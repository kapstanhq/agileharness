"use client";

// Liga lib/stale-action.ts à janela: uma ação do servidor que a versão no ar não conhece (a aba é de antes da
// atualização) guarda o rascunho, recarrega a página e, de volta, devolve o rascunho e mostra o aviso. Uma vez por
// aba — o `fetch` é embrulhado uma só vez, e o recarregar só acontece uma vez por minuto (nunca um laço).

import { useEffect, useState } from "react";
import { STALE_DRAFTS_KEY, STALE_RELOAD_NOTICE, collectDrafts, isStaleActionResponse, restoreDrafts, type DraftField } from "@/lib/stale-action";

const RELOAD_GUARD_KEY = "ah:stale-action-reloaded-at";
const WRAPPED = Symbol.for("ah.staleActionGuard");

type TextField = HTMLInputElement | HTMLTextAreaElement;

function textFields(): (DraftField & { setValue(v: string): void })[] {
  return Array.from(document.querySelectorAll<TextField>("input, textarea")).map((el) => ({
    id: el.id || undefined,
    name: el.getAttribute("name") || undefined,
    type: el instanceof HTMLInputElement ? el.type : "textarea",
    value: el.value,
    setValue: (v: string) => {
      // o setter nativo + o evento de input: o React só vê o valor novo assim
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
  }));
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function StaleActionGuard() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // De volta do recarregar: devolve o rascunho (depois de a página montar os campos) e mostra o aviso.
    const raw = safe(() => sessionStorage.getItem(STALE_DRAFTS_KEY), null);
    if (raw) {
      safe(() => sessionStorage.removeItem(STALE_DRAFTS_KEY), undefined);
      const drafts = safe(() => JSON.parse(raw) as Record<string, string>, {});
      const t = window.setTimeout(() => {
        restoreDrafts(textFields(), drafts);
        setNotice(STALE_RELOAD_NOTICE);
      }, 600);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, []);

  useEffect(() => {
    const w = window as unknown as Record<symbol, boolean>;
    if (w[WRAPPED]) return;
    w[WRAPPED] = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await original(input, init);
      const reqHeaders = init?.headers instanceof Headers ? init.headers : (init?.headers as Record<string, string> | undefined);
      if (isStaleActionResponse(reqHeaders, res.headers)) {
        const last = Number(safe(() => sessionStorage.getItem(RELOAD_GUARD_KEY), null) ?? 0);
        if (Date.now() - last > 60_000) {
          safe(() => sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())), undefined);
          safe(() => sessionStorage.setItem(STALE_DRAFTS_KEY, JSON.stringify(collectDrafts(textFields()))), undefined);
          window.location.reload();
        }
      }
      return res;
    };
  }, []);

  if (!notice) return null;
  return (
    <div role="status" className="fixed inset-x-0 top-2 z-[100] mx-auto w-fit max-w-[92vw] rounded-md bg-surface px-3 py-2 text-[13px] text-fg shadow-lg ring-1 ring-line">
      {notice}
      <button type="button" onClick={() => setNotice(null)} className="ml-3 text-fg-muted underline-offset-2 hover:underline">
        Ok
      </button>
    </div>
  );
}
