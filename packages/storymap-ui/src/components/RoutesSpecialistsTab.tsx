"use client";

// Fase 5.2 — "Rotas & Especialistas" (READ-ONLY): answer "quais perfis existem? o express pula o quê? que
// especialistas revisam a coluna X? algum sem arquivo de agente?" without SSH. Data is server-assembled
// (config-cockpit.ts) with ORIGIN (_base-inherited vs board) + agent-file presence probed. Visibility first;
// editing is future work.

import { GitBranch, Lock, Route, UserCog } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ConfigCockpitData } from "@/lib/storymap/config-cockpit";

const ORIGIN_LABEL: Record<string, string> = {
  board: "deste board",
  "base-override": "_base (sobrescrito)",
  "base-inherited": "herdado do _base",
};

function OriginBadge({ origin }: { origin: string }) {
  const base = origin !== "board";
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", base ? "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300" : "bg-surface-hover text-fg-subtle")}>
      {ORIGIN_LABEL[origin] ?? origin}
    </span>
  );
}

export function RoutesSpecialistsTab({ data }: { data: ConfigCockpitData }) {
  return (
    <div className="space-y-6">
      {data.hasBaseOrigin && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          Definições herdadas do <code className="font-mono">_base</code> são cacheadas por processo — uma edição no <code className="font-mono">_base</code> pode exigir <b>restart</b> do serviço para valer em todos os boards.
        </p>
      )}

      {/* Route profiles */}
      <Section title="Perfis de rota" icon={<Route className="h-4 w-4" />} hint="Cada perfil pula steps dispensáveis e/ou aplica um teto de modelo/effort. A rota efetiva de um card materializa o perfil (skips/caps no card).">
        {data.routeProfiles.length === 0 ? (
          <Empty>Nenhum perfil de rota neste board.</Empty>
        ) : (
          <div className="space-y-2">
            {data.routeProfiles.map((p) => (
              <div key={p.id} className="rounded-lg border border-line bg-inset p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-fg">{p.id}</span>
                  <OriginBadge origin={p.origin} />
                </div>
                {p.description && <p className="mt-0.5 text-[12px] text-fg-muted">{p.description}</p>}
                <div className="mt-1.5 space-y-0.5 text-[12px]">
                  <p className="text-fg">
                    <span className="text-fg-subtle">Pula: </span>
                    {p.skips.length ? p.skips.map((s) => s.name).join(" · ") : <span className="text-fg-subtle">nenhum step</span>}
                  </p>
                  {(p.modelCap || p.effortCap) && (
                    <p className="text-fg-muted">
                      <span className="text-fg-subtle">Tetos: </span>
                      {[p.modelCap && `modelo ≤ ${p.modelCap}`, p.effortCap && `esforço ≤ ${p.effortCap}`].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Specialists */}
      <Section title="Especialistas" icon={<UserCog className="h-4 w-4" />} hint="Sub-agentes que uma coluna pode delegar (Task). Um slug sem .claude/agents/<slug>.md aparece marcado — o run não conseguirá delegá-lo.">
        {data.specialists.length === 0 ? (
          <Empty>Nenhum especialista registrado.</Empty>
        ) : (
          <div className="space-y-2">
            {data.specialists.map((sp) => (
              <div key={sp.id} className="rounded-lg border border-line bg-inset p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-semibold text-fg">{sp.id}</span>
                  <span className="font-mono text-[11px] text-accent">{sp.agent}</span>
                  <OriginBadge origin={sp.origin} />
                  {sp.agentFilePresent ? (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">arquivo ✓</span>
                  ) : (
                    <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">.claude/agents/{sp.agent}.md ausente</span>
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-fg-muted"><span className="text-fg-subtle">Quando: </span>{sp.when}</p>
                <p className="mt-0.5 text-[11px] text-fg-subtle">
                  {sp.usedByColumns.length ? `Usado em: ${sp.usedByColumns.join(" · ")}` : "Não referenciado por nenhuma coluna."}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Dispensable ruler */}
      <Section title="Steps dispensáveis" icon={<GitBranch className="h-4 w-4" />} hint="Quais steps um perfil de rota PODE pular. Steps load-bearing (plano/dev/review/QA) ficam travados — nunca são pulados.">
        <div className="overflow-hidden rounded-lg border border-line">
          <table className="w-full text-xs">
            <tbody>
              {data.dispensableSteps.map((s) => (
                <tr key={s.id} className="border-t border-line-muted first:border-t-0">
                  <td className="px-2.5 py-1.5 text-fg-muted">{s.name}</td>
                  <td className="px-2.5 py-1.5 text-right">
                    {s.loadBearing ? (
                      <span className="inline-flex items-center gap-1 text-fg-subtle"><Lock className="h-3 w-3" /> load-bearing</span>
                    ) : s.dispensable ? (
                      <span className="text-emerald-700 dark:text-emerald-400">dispensável</span>
                    ) : (
                      <span className="text-fg-subtle">obrigatório</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, icon, hint, children }: { title: string; icon: React.ReactNode; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="text-fg-subtle">{icon}</span>
        {title}
      </h2>
      {hint && <p className="mt-0.5 max-w-prose text-xs leading-snug text-fg-muted">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[12px] text-fg-subtle">{children}</p>;
}
