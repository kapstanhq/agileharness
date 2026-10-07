"use client";

// A aba «Jido» da Configuração — o RUNTIME do copiloto, e só ele: o estado (ligado, a última vez que acordou, o gasto
// de hoje, quem está com a conversa) e os ajustes GLOBAIS do settings.yaml (ligar, intervalo, teto do dia, modelo do
// chat). Cada ajuste diz quando passa a valer — pelo consumidor real (instrumentation.ts arma o timer no boot). Em
// português de quem usa: nada de «tick», «lease», «budget» ou «restart» na tela.
//
// A AUTONOMIA saiu daqui (fase 4): o seletor Chat / Copiloto / Autônomo e o editor da matriz de risco viraram o
// controle único da barra do topo (`shell/AutonomyControl` — a caixa «O Jido agir no board»). Esta aba não
// decide o que o Jido faz sozinho; só quando ele acorda e quanto pode gastar.

import { useState } from "react";
import { AlertTriangle, Bot, Clock, Coins, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { saveRunnerSettingsAction } from "@/app/actions";
import type { CopilotOrchestratorOverview } from "@/app/copilot-actions";
import type { RunnerSettings } from "@/lib/storymap/types";
import { ChatModelEffort } from "@/components/copilot/CopilotSettingsControls";

const RESTART = "vale depois de reiniciar o serviço";
const NEXT_TICK = "vale na próxima vez que ele acordar";

export function JidoRuntimePanel({
  overview,
  settings,
}: {
  overview: CopilotOrchestratorOverview;
  settings: RunnerSettings;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // local draft of the GLOBAL orchestrator settings (edited here, saved via saveRunnerSettingsAction).
  const orch = settings.orchestrator ?? { enabled: false, tickMinutes: 30, budget: { maxTicksPerDay: 20, maxCostPerDay: 10 } };
  const [enabled, setEnabled] = useState(orch.enabled);
  const [tickMinutes, setTickMinutes] = useState(orch.tickMinutes);
  const [maxTicks, setMaxTicks] = useState(orch.budget?.maxTicksPerDay ?? 20);
  const [maxCost, setMaxCost] = useState(orch.budget?.maxCostPerDay ?? 10);
  const [chatModel, setChatModel] = useState(orch.chat?.model ?? "opus");
  const [chatEffort, setChatEffort] = useState(orch.chat?.effort ?? "high");

  const saveSettings = async () => {
    setBusy(true);
    setMsg(null);
    const next: RunnerSettings = {
      ...settings,
      orchestrator: {
        ...(settings.orchestrator ?? { enabled, tickMinutes }),
        enabled,
        tickMinutes,
        budget: { maxTicksPerDay: maxTicks, maxCostPerDay: maxCost },
        chat: { model: chatModel, effort: chatEffort },
      },
    };
    const res = await saveRunnerSettingsAction({ settings: next });
    setBusy(false);
    setMsg(
      res.ok
        ? { ok: true, text: "Salvo. Ligar o Jido ou mudar o intervalo só vale depois de reiniciar o serviço." }
        : { ok: false, text: res.error },
    );
  };

  const st = overview.state;
  const s = overview.settings;
  const armed = s.enabled.value; // effective global enable (a disarmed board mode does nothing without it)

  return (
    <div className="space-y-6">
      {/* STATUS PANEL */}
      <Section title="Estado" icon={<Bot className="h-4 w-4" />}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat
            label="Jido (todos os boards)"
            value={armed ? "ligado" : "desligado"}
            tone={armed ? "ok" : "muted"}
            hint={s.enabled.origin === "env-override" ? "definido pela variável de ambiente AGILEHARNESS_ORCH_ENABLED" : undefined}
          />
          <Stat
            label="Agir no board"
            value={overview.boardMode === "autonomous" ? "ligado neste board" : "desligado neste board"}
            tone={overview.boardMode === "autonomous" ? "ok" : "muted"}
            hint="muda no botão «Autonomia» da barra do topo"
          />
          <Stat
            label="Última vez que acordou"
            value={
              st.lastTick
                ? `${st.lastTick.at.slice(0, 16).replace("T", " ")} — ${st.lastTick.outcome === "ran" ? "trabalhou" : "não precisou agir"}`
                : "ainda não acordou"
            }
            // o motivo cru da máquina (`skipped-running`…) não vai à tela; só uma frase de verdade
            hint={st.lastTick?.reason && /\s/.test(st.lastTick.reason) ? st.lastTick.reason : undefined}
          />
          <Stat
            label="Gasto de hoje"
            value={`${st.budget.ticksToday} de ${s.budget.maxTicksPerDay} vezes · US$ ${st.budget.costToday.toFixed(2)} de US$ ${s.budget.maxCostPerDay}`}
            tone={st.withinBudget ? "ok" : "warn"}
          />
          <Stat
            label="Quem está com o board"
            value={st.humanLeased ? `você (${st.leaseOwner})` : st.leaseOwner ? (st.leaseOwner === "tick" ? "o Jido, sozinho" : st.leaseOwner) : "ninguém"}
            hint={st.humanLeased ? "o Jido espera enquanto você conversa" : undefined}
          />
        </div>
        {armed && overview.boardMode === "autonomous" && (
          <p className="mt-1 text-[11px] text-fg-subtle">
            {st.lastTickAt ? `Agiu pela última vez em ${st.lastTickAt.slice(0, 16).replace("T", " ")}.` : "Ligado; esperando a primeira vez que ele acordar."}
          </p>
        )}
        {!armed && overview.boardMode === "autonomous" && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" /> Este board deixa o Jido agir, mas o Jido está desligado para todos os boards — nada acontece até você ligá-lo (abaixo) e reiniciar o serviço.
          </p>
        )}
      </Section>

      {/* GLOBAL SETTINGS (settings.yaml) */}
      <Section title="Quando acorda e quanto gasta" icon={<Clock className="h-4 w-4" />} hint="Vale para todos os boards.">
        <Labeled label="Jido ligado" tag={enabled === orch.enabled ? undefined : enabled ? RESTART : NEXT_TICK} tagTone={enabled && enabled !== orch.enabled ? "warn" : "muted"}>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((v) => !v)}
            className={cn("relative inline-flex h-6 w-11 items-center rounded-full transition", enabled ? "bg-emerald-500" : "bg-surface-hover")}
          >
            <span className={cn("inline-block h-5 w-5 rounded-full bg-surface shadow transition", enabled ? "translate-x-5" : "translate-x-0.5")} />
          </button>
        </Labeled>
        <Labeled label="Acorda a cada (minutos)" tag={tickMinutes === orch.tickMinutes ? undefined : RESTART} tagTone="warn">
          <input
            type="number"
            min={1}
            value={tickMinutes}
            onChange={(e) => setTickMinutes(Math.max(1, Number(e.target.value) || 1))}
            className="w-24 rounded-lg border border-line bg-inset px-3 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        </Labeled>
        <Labeled label="Máximo de vezes por dia" tag={maxTicks === (orch.budget?.maxTicksPerDay ?? 20) ? undefined : NEXT_TICK} tagTone="muted">
          <input type="number" min={0} value={maxTicks} onChange={(e) => setMaxTicks(Math.max(0, Number(e.target.value) || 0))} className="w-24 rounded-lg border border-line bg-inset px-3 py-1.5 text-sm text-fg outline-none focus:border-accent" />
        </Labeled>
        <Labeled label="Gasto máximo por dia (US$)" tag={maxCost === (orch.budget?.maxCostPerDay ?? 10) ? undefined : NEXT_TICK} tagTone="muted">
          <input type="number" min={0} step={0.5} value={maxCost} onChange={(e) => setMaxCost(Math.max(0, Number(e.target.value) || 0))} className="w-24 rounded-lg border border-line bg-inset px-3 py-1.5 text-sm text-fg outline-none focus:border-accent" />
        </Labeled>
        <Labeled label="Modelo e esforço do chat" tag={chatModel === (orch.chat?.model ?? "opus") && chatEffort === (orch.chat?.effort ?? "high") ? undefined : "vale na próxima mensagem"} tagTone="muted">
          <ChatModelEffort model={chatModel} effort={chatEffort} onModel={setChatModel} onEffort={setChatEffort} disabled={busy} />
        </Labeled>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={saveSettings}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Coins className="h-3.5 w-3.5" />}
            Salvar
          </button>
          <p className="text-[11px] text-fg-subtle">Ligar o Jido e mudar o intervalo só valem depois de <b>reiniciar o serviço</b>; o teto vale na próxima vez que ele acordar.</p>
        </div>
      </Section>

      {msg && (
        <p className={cn("text-xs font-medium", msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-300")}>{msg.text}</p>
      )}
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
      <div className="mt-3 space-y-2.5">{children}</div>
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "warn" | "muted" }) {
  const cls = tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : tone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-fg";
  return (
    <div className="rounded-lg border border-line-muted bg-inset px-2.5 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{label}</p>
      <p className={cn("text-[13px] font-medium", cls)}>{value}</p>
      {hint && <p className="text-[10px] leading-snug text-fg-subtle">{hint}</p>}
    </div>
  );
}

function Labeled({ label, tag, tagTone, children }: { label: string; tag?: string; tagTone?: "warn" | "muted"; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-fg-muted">{label}</p>
        {tag && (
          <p className={cn("text-[11px] font-medium", tagTone === "warn" ? "text-amber-700 dark:text-amber-400" : "text-fg-subtle")}>{tag}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
