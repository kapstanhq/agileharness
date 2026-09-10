"use client";

// Fase 5.1 — the "Copiloto" config tab. Makes the orchestrator's runtime state VISIBLE (armed/dormant, last
// tick + outcome, today's budget, lease, resolved riskMatrix) and gives the operator the ONLY two writes v1
// needs: the board's state (Chat/Copiloto/Autônomo — a projection of mode + riskMatrix.deploy, see
// copilot/tier.ts) and the global tick cadence/budget. Every control declares
// "aplica na hora" vs "requer restart" — determined by the actual consumer (instrumentation.ts arms the timer
// at boot). SAFETY GATE: overview.enforcementShipped (= riskMatrixEnforced) gates the autonomous option; F5.9
// flipped it TRUE (the per-call guard + move_card dynamic gate + approvals now enforce the riskMatrix), so
// autonomous is available — but turning it on is an explicit PER-BOARD opt-in (every board defaults to off).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bot, Clock, Coins, Loader2, Lock, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { setBoardOrchestratorModeAction, saveRunnerSettingsAction } from "@/app/actions";
import type { CopilotOrchestratorOverview } from "@/app/copilot-actions";
import type { RunnerSettings } from "@/lib/storymap/types";
import { copilotTier, tierMatrix, tierMode, tierUnlocked, TIER_META, type CopilotTier } from "@/lib/storymap/copilot/tier";
import { ChatModelEffort, RiskMatrixEditor } from "@/components/copilot/CopilotSettingsControls";

/** Os 3 estados, do mais contido ao mais amplo (mesma projeção do header — ver copilot/tier.ts). */
const TIERS: CopilotTier[] = ["chat", "copiloto", "autonomo"];

const RESTART = "requer restart do serviço";
const NEXT_TICK = "aplica no próximo tick";

export function CopilotConfigPanel({
  boardId,
  overview,
  settings,
}: {
  boardId: string;
  overview: CopilotOrchestratorOverview;
  settings: RunnerSettings;
}) {
  const router = useRouter();
  // O estado ATIVO é a projeção de (mode, matriz.deploy) — a mesma que o header e o resto do sistema leem.
  const [tier, setTier] = useState<CopilotTier>(copilotTier({ mode: overview.boardMode, riskMatrix: overview.riskMatrix }));
  const [busy, setBusy] = useState<null | "mode" | "settings">(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // local draft of the GLOBAL orchestrator settings (edited here, saved via saveRunnerSettingsAction).
  const orch = settings.orchestrator ?? { enabled: false, tickMinutes: 30, budget: { maxTicksPerDay: 20, maxCostPerDay: 10 } };
  const [enabled, setEnabled] = useState(orch.enabled);
  const [tickMinutes, setTickMinutes] = useState(orch.tickMinutes);
  const [maxTicks, setMaxTicks] = useState(orch.budget?.maxTicksPerDay ?? 20);
  const [maxCost, setMaxCost] = useState(orch.budget?.maxCostPerDay ?? 10);
  const [chatModel, setChatModel] = useState(orch.chat?.model ?? "opus");
  const [chatEffort, setChatEffort] = useState(orch.chat?.effort ?? "high");

  const enforcement = overview.enforcementShipped;

  const saveTier = async (next: CopilotTier) => {
    setBusy("mode");
    setMsg(null);
    // Cada estado escreve seu (mode,matriz) canônico (tier.ts). Chat só desliga o tick (mode off) e preserva
    // a matriz atual. A matriz que este write grava é a mesma que o RiskMatrixEditor abaixo pode refinar depois.
    const modeToWrite = tierMode(next);
    const riskMatrix = next === "chat" ? undefined : tierMatrix(next);
    const res = await setBoardOrchestratorModeAction({ boardId, mode: modeToWrite, riskMatrix });
    setBusy(null);
    if (res.ok) {
      setTier(next);
      setMsg({ ok: true, text: `Estado do board = ${TIER_META[next].label}. ${NEXT_TICK} (se o tick global estiver armado).` });
      router.refresh();
    } else {
      setMsg({ ok: false, text: res.error });
    }
  };

  const saveSettings = async () => {
    setBusy("settings");
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
    setBusy(null);
    setMsg(
      res.ok
        ? { ok: true, text: "Settings salvos. Ligar o Jido ou mudar a cadência exige restart do serviço." }
        : { ok: false, text: res.error },
    );
  };

  const st = overview.state;
  const s = overview.settings;
  const armed = s.enabled.value; // effective global enable (a disarmed board mode does nothing without it)

  return (
    <div className="space-y-6">
      {/* F5.9 — the CAPABILITY is on (riskMatrixEnforced=true): the per-call guard + move_card dynamic gate +
          run-escalation + approvals enforce the riskMatrix on every scoped-token action. The `!enforcement`
          fallback banner stays for defence (if the flag is ever turned back off). */}
      {!enforcement ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-300 bg-rose-50 p-3 text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Modo autônomo indisponível</p>
            <p className="mt-0.5">
              O enforcement server-side da matriz de risco está desligado. O estado <b>Chat</b> (só chat, sem
              tick) segue disponível.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">Modo autônomo disponível</p>
            <p className="mt-0.5">
              O enforcement da matriz de risco roda <b>por chamada</b>. Em <b>Copiloto</b> ele resolve o board e o
              pipeline sozinho (mover card, rodar skill da coluna, destravar merge) mas <b>deploy e decisões de
              produto param em você</b>. <b>Autônomo</b> vai além: decide produto e publica sozinho. Abrir um shell
              (<code className="font-mono">run-free</code>) e apagar dados (<code className="font-mono">destructive</code>){" "}
              <b>nunca</b> são automáticos — o kernel recusa. Escolher um estado aqui NÃO torna nenhum board autônomo
              sozinho: cada board começa em <b>Chat</b> e o tick ainda exige o token{" "}
              <code className="font-mono">AGILEHARNESS_MCP_TOKEN_ORCH</code> no ambiente do serviço.
            </p>
          </div>
        </div>
      )}

      {/* STATUS PANEL */}
      <Section title="Estado" icon={<Bot className="h-4 w-4" />}>
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat
            label="Jido global"
            value={armed ? "ligado" : "desligado"}
            tone={armed ? "ok" : "muted"}
            hint={s.enabled.origin === "env-override" ? "definido por AGILEHARNESS_ORCH_ENABLED (env)" : "settings.yaml"}
          />
          <Stat label="Estado deste board" value={TIER_META[tier].label} tone={tier === "chat" ? "muted" : "ok"} />
          <Stat
            label="Último tick"
            value={
              st.lastTick
                ? `${st.lastTick.at.slice(0, 16).replace("T", " ")} — ${st.lastTick.outcome === "ran" ? "rodou" : `pulou`}`
                : "ainda não rodou"
            }
            hint={st.lastTick?.reason}
          />
          <Stat
            label="Budget de hoje"
            value={`${st.budget.ticksToday}/${s.budget.maxTicksPerDay} ticks · $${st.budget.costToday.toFixed(2)}/$${s.budget.maxCostPerDay}`}
            tone={st.withinBudget ? "ok" : "warn"}
          />
          <Stat
            label="Lease"
            value={st.humanLeased ? `humano (${st.leaseOwner})` : st.leaseOwner ? st.leaseOwner : "livre"}
            hint={st.humanLeased ? "o tick autônomo se recolhe enquanto você conversa" : undefined}
          />
        </div>
        {armed && tier !== "chat" && (
          <p className="mt-1 text-[11px] text-fg-subtle">
            {st.lastTickAt ? `Último tick real em ${st.lastTickAt.slice(0, 16).replace("T", " ")}.` : "O timer está armado; aguardando o primeiro tick."}
          </p>
        )}
        {!armed && tier !== "chat" && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" /> Este board está em <b>{TIER_META[tier].label}</b>, mas o Jido GLOBAL está desligado — nada dispara até ligá-lo (abaixo) + restart.
          </p>
        )}
      </Section>

      {/* BOARD STATE — os 3 estados (projeção de mode + matriz.deploy; ver tier.ts). Escolher um estado grava seu
          (mode,matriz) canônico numa única escrita; o RiskMatrixEditor abaixo é o refino avançado da mesma matriz. */}
      <Section title="Estado do Jido neste board" icon={<Bot className="h-4 w-4" />} hint={`O que ele faz SEM você. ${NEXT_TICK}.`}>
        <div className="flex flex-wrap items-center gap-2">
          {TIERS.map((t) => {
            const meta = TIER_META[t];
            const active = tier === t;
            const needsEnforcement = t !== "chat";
            const lockedByEnforcement = needsEnforcement && !enforcement;
            const lockedByDeployGate = !tierUnlocked(t);
            const locked = lockedByEnforcement || lockedByDeployGate;
            const lockTitle = lockedByEnforcement
              ? "Bloqueado: o enforcement server-side da matriz de risco está desligado"
              : lockedByDeployGate
                ? "Publicação autônoma em revisão pelo operador — liberada após aprovar o mecanismo de deploy-autônomo (§4)"
                : meta.hint;
            return (
              <button
                key={t}
                type="button"
                disabled={busy !== null || locked}
                onClick={() => saveTier(t)}
                title={locked ? lockTitle : meta.hint}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-50",
                  active ? "border-accent bg-accent/10 text-accent" : "border-line text-fg-muted hover:bg-surface-hover hover:text-fg",
                )}
              >
                {locked && <Lock className="h-3 w-3" />}
                {meta.label}
                {busy === "mode" && active && <Loader2 className="h-3 w-3 animate-spin" />}
              </button>
            );
          })}
        </div>
      </Section>

      {/* RISK MATRIX (editável — grava via setBoardRiskMatrixAction, re-lintada server-side) */}
      <Section title="Matriz de risco" icon={<ShieldAlert className="h-4 w-4" />} hint="Como cada classe de ação é tratada no modo autônomo. Deploy/destructive nunca podem ser automáticos (clamp do kernel — só ask/never).">
        <RiskMatrixEditor boardId={boardId} resolved={overview.riskMatrix} warnings={overview.riskMatrixWarnings} onSaved={() => router.refresh()} />
      </Section>

      {/* GLOBAL SETTINGS (settings.yaml) */}
      <Section title="Cadência & budget (global)" icon={<Clock className="h-4 w-4" />} hint="Vale para TODOS os boards. Salvo em settings.yaml.">
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
        <Labeled label="Intervalo do tick (min)" tag={tickMinutes === orch.tickMinutes ? undefined : RESTART} tagTone="warn">
          <input
            type="number"
            min={1}
            value={tickMinutes}
            onChange={(e) => setTickMinutes(Math.max(1, Number(e.target.value) || 1))}
            className="w-24 rounded-lg border border-line bg-inset px-3 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        </Labeled>
        <Labeled label="Máx. ticks/dia" tag={maxTicks === (orch.budget?.maxTicksPerDay ?? 20) ? undefined : NEXT_TICK} tagTone="muted">
          <input type="number" min={0} value={maxTicks} onChange={(e) => setMaxTicks(Math.max(0, Number(e.target.value) || 0))} className="w-24 rounded-lg border border-line bg-inset px-3 py-1.5 text-sm text-fg outline-none focus:border-accent" />
        </Labeled>
        <Labeled label="Máx. custo/dia (USD)" tag={maxCost === (orch.budget?.maxCostPerDay ?? 10) ? undefined : NEXT_TICK} tagTone="muted">
          <input type="number" min={0} step={0.5} value={maxCost} onChange={(e) => setMaxCost(Math.max(0, Number(e.target.value) || 0))} className="w-24 rounded-lg border border-line bg-inset px-3 py-1.5 text-sm text-fg outline-none focus:border-accent" />
        </Labeled>
        <Labeled label="Chat do Jido (model/effort)" tag={chatModel === (orch.chat?.model ?? "opus") && chatEffort === (orch.chat?.effort ?? "high") ? undefined : "aplica no próximo turno"} tagTone="muted">
          <ChatModelEffort model={chatModel} effort={chatEffort} onModel={setChatModel} onEffort={setChatEffort} disabled={busy !== null} />
        </Labeled>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={saveSettings}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
          >
            {busy === "settings" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Coins className="h-3.5 w-3.5" />}
            Salvar settings
          </button>
          <p className="text-[11px] text-fg-subtle">Ligar o Jido (de desligado) e mudar a cadência só valem após <b>restart</b> do serviço; budget/modo valem no próximo tick.</p>
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
