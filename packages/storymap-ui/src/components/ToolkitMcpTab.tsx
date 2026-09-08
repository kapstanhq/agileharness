"use client";

// Fase 5.3 + 5.4 — "Toolkit & MCP" (READ-ONLY). 5.3: the RESOLVED toolkit per trigger column (MCP mounts,
// allowedTools, guidance, specialists, expectations) + the last observed toolGap ("declarou X, o run não o
// exercitou — run Y, data") so a mis-provisioned column (the nimbus-herda-grafo-do-storymap class) is visible
// at a glance. 5.4: the CONFIGURED mcpTokens — count + level only, NEVER the secret value (only the env-var
// NAME + McpLevel; enforcement of the levels is item 6.5).

import { KeyRound, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ConfigCockpitData } from "@/lib/storymap/config-cockpit";

const LEVEL_LABEL: Record<string, string> = { ro: "somente leitura", write: "escrita", full: "total" };
const LEVEL_CLS: Record<string, string> = {
  ro: "bg-surface-hover text-fg-muted",
  write: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  full: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
};

export function ToolkitMcpTab({ data }: { data: ConfigCockpitData }) {
  return (
    <div className="space-y-6">
      {/* 5.3 — toolkit per column */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className="text-fg-subtle"><Wrench className="h-4 w-4" /></span>
          Toolkit por coluna
        </h2>
        <p className="mt-0.5 max-w-prose text-xs leading-snug text-fg-muted">
          O toolkit RESOLVIDO de cada coluna com skill — o que o run realmente monta. O último <b>toolGap</b>{" "}
          mostra uma capacidade declarada que um run não exercitou.
        </p>
        <div className="mt-3 space-y-2">
          {data.columns.length === 0 && <p className="text-[12px] text-fg-subtle">Nenhuma coluna com skill/toolkit neste board.</p>}
          {data.columns.map((c) => (
            <div key={c.statusId} className="rounded-lg border border-line bg-inset p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-fg">{c.statusName}</span>
                {c.trigger && <span className="font-mono text-[11px] text-accent">{c.trigger}</span>}
              </div>
              <dl className="mt-1.5 space-y-1 text-[12px]">
                <Row label="Mounts MCP">
                  {c.mounts.length ? (
                    <span className="flex flex-wrap gap-1">
                      {c.mounts.map((m) => (
                        <code key={m.path} className={cn("rounded px-1 py-0.5 font-mono text-[10px]", m.legacy ? "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" : "bg-surface-hover text-fg-muted")} title={m.legacy ? "via mcpConfig legado (sugar)" : "via toolkit.use[]"}>
                          {m.path}{m.legacy ? " (legado)" : ""}
                        </code>
                      ))}
                    </span>
                  ) : (
                    <Muted>nenhum</Muted>
                  )}
                </Row>
                <Row label="allowedTools">{c.allowedTools.length ? <span className="font-mono text-[11px] text-fg-muted">{c.allowedTools.join(", ")}</span> : <Muted>sem restrição</Muted>}</Row>
                <Row label="Especialistas">{c.specialists.length ? <span className="text-fg-muted">{c.specialists.map((s) => `${s.id}→${s.agent}`).join(" · ")}</span> : <Muted>nenhum</Muted>}</Row>
                <Row label="Espera">{c.expects.length ? <span className="text-fg-muted">{c.expects.map((e) => `${e.tool}@${e.level}`).join(" · ")}</span> : <Muted>nenhuma</Muted>}</Row>
                {c.guidance && <Row label="Guia"><span className="text-fg-subtle">{c.guidance}</span></Row>}
              </dl>
              {c.lastGap && (
                <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  Último toolGap: declarou <b>{c.lastGap.tools.join(", ")}</b>, o run <span className="font-mono">{c.lastGap.cardId}</span> não exercitou — {c.lastGap.at}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 5.4 — mcpTokens presence */}
      <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <span className="text-fg-subtle"><KeyRound className="h-4 w-4" /></span>
          Tokens MCP
        </h2>
        <p className="mt-0.5 max-w-prose text-xs leading-snug text-fg-muted">
          Tokens de autoridade MCP configurados (nome da variável + nível). O valor do token nunca é exibido. O
          enforcement server-side dos níveis é o item 6.5.
        </p>
        <div className="mt-3">
          {data.mcpTokens == null || data.mcpTokens.length === 0 ? (
            <p className="text-[12px] text-fg-subtle">
              Nenhum token MCP configurado — sem enforcement por nível hoje (todo cliente tem acesso total até o item 6.5).
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[12px] text-fg-muted">{data.mcpTokens.length} token(s) configurado(s):</p>
              <ul className="space-y-1">
                {data.mcpTokens.map((t) => (
                  <li key={t.tokenEnv} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-inset px-2.5 py-1.5">
                    <code className="font-mono text-[12px] text-fg-muted">{t.tokenEnv}</code>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", LEVEL_CLS[t.level])}>{LEVEL_LABEL[t.level] ?? t.level}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-24 shrink-0 text-[11px] text-fg-subtle">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-fg-subtle">{children}</span>;
}
