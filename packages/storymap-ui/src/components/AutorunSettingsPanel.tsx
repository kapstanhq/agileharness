"use client";

// ⚙ Sistema · Configurações — os KNOBS: as global runner settings (storymap/settings.yaml — kill
// switch, concurrency, watchdogs, claude binary, global extra args e os fallbacks de
// model/effort/maxTurns por coluna), o copiloto (Jido) e o Toolkit & MCP. Per-column policy is edited
// in the Kanban (⚙ on a column); this shows it read-only + the global defaults columns inherit.
// ENV USM_* vars always win → flagged up top.
//
// Duas coisas SAÍRAM daqui, e as duas eram navegação disfarçada de conteúdo:
//   • "Rotas & Especialistas" → virou seção da tela Orquestração (é sobre o SISTEMA de agentes, não
//     um knob);
//   • os cartões "Acompanhamento" (Métricas · Orquestração · Processos) → eram uma TERCEIRA porta
//     para telas que já tinham duas (o popover do bloco Software e o ⋯). Hoje as três moram no menu
//     do ⚙ — e, uma vez dentro de qualquer uma delas, as irmãs estão na barra de abas logo acima.
//     Um atalho para o vizinho no meio de um formulário de ajustes era o sintoma de uma IA que não
//     tinha onde pendurar essas telas.
//
// As abas desta tela usam a primitiva do nível 3 (`nav/PageTabs`) — antes eram uma barra à mão, com
// o MESMO sublinhado da barra de ferramentas logo acima: duas faixas gêmeas empilhadas.

import { useState } from "react";
import { AlertTriangle, Bot, Cpu, KeyRound, Power, Save, SlidersHorizontal, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { saveRunnerSettingsAction } from "@/app/actions";
import type { Board, BoardSummary, RunnerSettings } from "@/lib/storymap/types";
import type { CopilotOrchestratorOverview } from "@/app/copilot-actions";
import type { ConfigCockpitData } from "@/lib/storymap/config-cockpit";
import { PageHeader, PageTabs, usePageTab, type PageTab } from "@/components/nav/PageTabs";
import { BoardHeader } from "./BoardHeader";
import { EffortSelect, ModelSelect } from "./ColumnPolicyControls";
import { CopilotConfigPanel } from "./CopilotConfigPanel";
import { ToolkitMcpTab } from "./ToolkitMcpTab";

type ConfigTab = "autopilot" | "copiloto" | "toolkit";
const TABS: readonly PageTab<ConfigTab>[] = [
  { id: "autopilot", label: "Autopilot", icon: SlidersHorizontal, hint: "O runner que executa as skills" },
  { id: "copiloto", label: "Jido", icon: Bot, hint: "O copiloto — modo, autonomia e riscos" },
  { id: "toolkit", label: "Toolkit & MCP", icon: KeyRound, hint: "Ferramentas e tokens que os agentes usam" },
];

const inputCls =
  "rounded-lg border border-line bg-inset px-3 py-2 text-sm text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent";

export function AutorunSettingsPanel({
  board,
  boards,
  settings,
  envOverrides,
  overview,
  cockpit,
}: {
  board: Board;
  boards: BoardSummary[];
  settings: RunnerSettings;
  envOverrides: string[];
  /** Fase 5.1 — the Copiloto tab's read model (orchestrator settings/mode/state/riskMatrix + 6.5 gate). */
  overview: CopilotOrchestratorOverview;
  /** Fase 5.2/5.3/5.4 — the read-only cockpit data (routes/specialists/toolkit/mcpTokens). */
  cockpit: ConfigCockpitData;
}) {
  // As abas viram URL (deep-link/bookmark): /config?tab=toolkit é endereçável e compartilhável, e o
  // back/forward do navegador funciona entre elas. A mecânica (default sem query, params vizinhos
  // preservados) mora em `usePageTab` — é a MESMA das abas de Orquestração.
  const [tab, setTab] = usePageTab(TABS);
  const [draft, setDraft] = useState<RunnerSettings>(settings);
  const [extraArgs, setExtraArgs] = useState((settings.autorun.extraArgs ?? []).join(" "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const a = draft.autorun;
  const setAutorun = (patch: Partial<RunnerSettings["autorun"]>) => {
    setMsg(null);
    setDraft((d) => ({ ...d, autorun: { ...d.autorun, ...patch } }));
  };
  const setTimeouts = (patch: Partial<RunnerSettings["autorun"]["timeouts"]>) =>
    setAutorun({ timeouts: { ...a.timeouts, ...patch } });
  const setColDefault = (patch: Partial<RunnerSettings["columnDefaults"]>) => {
    setMsg(null);
    setDraft((d) => ({ ...d, columnDefaults: { ...d.columnDefaults, ...patch } }));
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const next: RunnerSettings = {
      ...draft,
      autorun: { ...draft.autorun, extraArgs: extraArgs.split(/\s+/).filter(Boolean) },
    };
    const res = await saveRunnerSettingsAction({ settings: next });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Configuração salva em storymap/settings.yaml." } : { ok: false, text: res.error });
  };

  const triggerColumns = board.config.statuses.filter((s) => s.trigger);

  return (
    <div className="flex h-screen flex-col">
      <BoardHeader boards={boards} config={board.config} view="config" />

      <div className="board-scroll flex-1 overflow-auto bg-canvas p-4 sm:p-6">
        {/* SISTEMA_MAX_W — a MESMA largura das irmãs (ver `nav/PageTabs`). */}
        <div className="mx-auto max-w-4xl">
          <PageHeader
            title="Configurações"
            icon={SlidersHorizontal}
            description="Os ajustes deste board — o autopilot que executa as skills, o copiloto e as ferramentas que os agentes usam."
            tabs={<PageTabs label="Seções de Configurações" tabs={TABS} value={tab} onChange={setTab} />}
          />

          {tab === "copiloto" && <CopilotConfigPanel boardId={board.config.id} overview={overview} settings={settings} />}
          {tab === "toolkit" && <ToolkitMcpTab data={cockpit} />}

          {tab === "autopilot" && (
          <div className="space-y-4">
          <p className="max-w-prose text-[12.5px] leading-snug text-fg-muted">
            Controla o runner que executa as skills quando você arrasta um card para uma coluna automática. Salvo em{" "}
            <code className="rounded bg-surface-hover px-1 py-0.5 font-mono text-[11px]">storymap/settings.yaml</code>. As
            variáveis de ambiente <code className="font-mono">USM_*</code> sempre vencem este arquivo.
          </p>

          {envOverrides.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">Estas variáveis de ambiente estão ativas e sobrescrevem o painel:</p>
                <p className="mt-0.5 font-mono">{envOverrides.join(", ")}</p>
                <p className="mt-1">Remova-as do shell / .env.local para o painel ter efeito pleno.</p>
              </div>
            </div>
          )}

          <Card title="Geral" icon={<Power className="h-4 w-4" />}>
            <Toggle
              label="Autopilot ligado"
              hint="Desligado, nenhuma coluna automática dispara skill nem encaminha card."
              on={a.enabled}
              onToggle={() => setAutorun({ enabled: !a.enabled })}
            />
            <Toggle
              label="Retomar runs após reinício"
              hint="Se o dev server cair com skills rodando, retoma-as no próximo boot (re-roda do estado em disco; o session id fica salvo p/ claude --resume)."
              on={a.resumeOnBoot}
              onToggle={() => setAutorun({ resumeOnBoot: !a.resumeOnBoot })}
            />
            <Field label="Paralelismo máximo" hint="Quantas skills rodam ao mesmo tempo.">
              <input
                type="number"
                min={1}
                value={a.maxConcurrent}
                onChange={(e) => setAutorun({ maxConcurrent: Math.max(1, Number(e.target.value) || 1) })}
                className={cn(inputCls, "w-28")}
              />
            </Field>
            <Field label="Watchdog skills rápidas (ms)" hint="Mata enrich/tasks/prioritize travados.">
              <input
                type="number"
                min={1000}
                step={1000}
                value={a.timeouts.fastMs}
                onChange={(e) => setTimeouts({ fastMs: Math.max(1000, Number(e.target.value) || 1000) })}
                className={cn(inputCls, "w-40")}
              />
            </Field>
            <Toggle
              label="Watchdog p/ skills de código"
              hint="harness-do/harness-review têm duração imprevisível — guard-rail opcional (off = sem limite)."
              on={a.timeouts.doMs != null}
              onToggle={() => setTimeouts({ doMs: a.timeouts.doMs == null ? 30 * 60_000 : null })}
            />
            {a.timeouts.doMs != null && (
              <Field label="Timeout skills de código (ms)" hint="">
                <input
                  type="number"
                  min={60000}
                  step={60000}
                  value={a.timeouts.doMs}
                  onChange={(e) => setTimeouts({ doMs: Math.max(60000, Number(e.target.value) || 60000) })}
                  className={cn(inputCls, "w-40")}
                />
              </Field>
            )}
            <Field label="Binário do claude" hint="Como o runner resolve o CLI no PATH.">
              <input
                value={a.claudeBin}
                onChange={(e) => setAutorun({ claudeBin: e.target.value })}
                className={cn(inputCls, "w-56")}
              />
            </Field>
            <Field label="Flags extras (global)" hint="Anexadas a TODA run. Escape hatch.">
              <input
                value={extraArgs}
                onChange={(e) => setExtraArgs(e.target.value)}
                placeholder="ex.: --verbose"
                className={cn(inputCls, "w-full")}
              />
            </Field>
          </Card>

          <Card
            title="Padrão por coluna (fallback)"
            icon={<Cpu className="h-4 w-4" />}
            hint="Usado por qualquer coluna automática que não defina o seu próprio. A policy específica de cada coluna fica no Kanban."
          >
            <Field label="Modelo padrão" hint="">
              <ModelSelect value={draft.columnDefaults.model} onChange={(model) => setColDefault({ model })} />
            </Field>
            <Field label="Effort padrão" hint="">
              <EffortSelect value={draft.columnDefaults.effort} onChange={(effort) => setColDefault({ effort })} />
            </Field>
            <Field label="Máx. de turns padrão" hint="Vazio = sem limite.">
              <input
                type="number"
                min={1}
                value={draft.columnDefaults.maxTurns ?? ""}
                onChange={(e) =>
                  setColDefault({
                    maxTurns: e.target.value === "" ? undefined : Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className={cn(inputCls, "w-28")}
              />
            </Field>
          </Card>

          <Card
            title="Policy por coluna (neste board)"
            icon={<Zap className="h-4 w-4" />}
            hint="Modelo/effort efetivos de cada coluna com skill. Edite no Kanban (⚙ no topo da coluna)."
          >
            <div className="overflow-hidden rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="bg-surface-hover text-fg-muted">
                  <tr>
                    <Th>Coluna</Th>
                    <Th>Skill</Th>
                    <Th>Modelo</Th>
                    <Th>Effort</Th>
                    <Th>Máx turns</Th>
                    <Th>Guard</Th>
                  </tr>
                </thead>
                <tbody>
                  {triggerColumns.map((s) => (
                    <tr key={s.id} className="border-t border-line-muted">
                      <Td>{s.name}</Td>
                      <Td className="font-mono text-accent">{s.trigger}</Td>
                      <Td>{s.model ?? <Muted>{draft.columnDefaults.model ?? "—"}</Muted>}</Td>
                      <Td>{s.effort ?? <Muted>{draft.columnDefaults.effort ?? "—"}</Muted>}</Td>
                      <Td>{s.maxTurns ?? <Muted>{draft.columnDefaults.maxTurns ?? "—"}</Muted>}</Td>
                      <Td>{s.costGuard ? "✓" : "—"}</Td>
                    </tr>
                  ))}
                  {triggerColumns.length === 0 && (
                    <tr>
                      <Td>
                        <span className="text-fg-subtle">Nenhuma coluna com skill neste board.</span>
                      </Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex items-center gap-3 pb-8">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
            >
              <Save className="h-4 w-4" /> {busy ? "Salvando…" : "Salvar configuração"}
            </button>
            {msg && (
              <span className={cn("text-xs font-medium", msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-300")}>{msg.text}</span>
            )}
          </div>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Card({
  title,
  icon,
  hint,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <span className="text-fg-subtle">{icon}</span>
        {title}
      </h2>
      {hint && <p className="mt-0.5 max-w-prose text-xs leading-snug text-fg-muted">{hint}</p>}
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-fg-muted">{label}</p>
        {hint && <p className="text-[11px] leading-snug text-fg-subtle">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ label, hint, on, onToggle }: { label: string; hint?: string; on: boolean; onToggle: () => void }) {
  return (
    <Field label={label} hint={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-6 w-11 items-center rounded-full transition",
          on ? "bg-emerald-500" : "bg-surface-hover",
        )}
      >
        <span
          className={cn("inline-block h-5 w-5 transform rounded-full bg-surface shadow transition", on ? "translate-x-5" : "translate-x-0.5")}
        />
      </button>
    </Field>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2.5 py-1.5 text-left font-semibold">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("px-2.5 py-1.5 text-fg-muted", className)}>{children}</td>;
}
function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-fg-subtle">{children}</span>;
}
