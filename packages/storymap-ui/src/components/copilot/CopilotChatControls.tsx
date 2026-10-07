"use client";

// Os controles do Jido na barra da conversa (o cockpit — `CopilotChat` sem o compositor de fora): a VERDADE do
// estado (um ponto com o tom de `copilotStatus` + o QUANDO do próximo tick) e a engrenagem com os ajustes do
// RUNTIME (quando ele acorda, o teto do dia, o modelo do chat). Lê o MESMO read-model (orchestratorOverviewAction)
// que a configuração → nunca divergem.
//
// A AUTONOMIA saiu daqui (fase 4). O seletor Chat / Copiloto / Autônomo e o editor da matriz de risco («o que ele pode
// fazer sozinho») viraram o controle ÚNICO da barra do topo (`shell/AutonomyControl`, caixa «O Jido agir sem você
// pedir») — um painel, duas portas; nenhuma outra tela configura autonomia.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Settings2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { BTN_ICON, DOT, ICON, TXT } from "./ui";
import {
  copilotChatModelAction,
  orchestratorOverviewAction,
  saveOrchestratorSettingsAction,
  type CopilotOrchestratorOverview,
} from "@/app/copilot-actions";
import {
  copilotStatus,
  formatCountdown,
  splitModelVariant,
  type CopilotStatusLevel,
} from "@/lib/storymap/copilot/copilot-status";
import { copilotTier } from "@/lib/storymap/copilot/tier";
import { ChatModelEffort } from "./CopilotSettingsControls";

/**
 * Só a LEITURA dos controles, sem nada na tela — para a conversa por cima da tela do compositor do Jido
 * (chat/ChatOverlay), que não mostra a engrenagem do chat (a autonomia é o controle único da barra do topo; modelo e
 * esforço moram no `/model`). O rosto e o diário do tick continuam precisando saber o nível do
 * board e se um tick está rodando: é o MESMO read-model e a MESMA projeção (`copilotStatus`) dos controles, com o
 * mesmo ritmo — re-lê a cada 30s só nos estados autônomos (em Chat não há tick a acompanhar).
 */
export function CopilotStatusProbe({
  boardId,
  onStatus,
}: {
  boardId: string;
  onStatus: (s: { level: CopilotStatusLevel; running: boolean }) => void;
}) {
  const [overview, setOverview] = useState<CopilotOrchestratorOverview | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () =>
      orchestratorOverviewAction(boardId)
        .then((o) => {
          if (alive) setOverview(o);
        })
        .catch(() => {});
    read();
    return () => {
      alive = false;
    };
  }, [boardId]);
  const tier = overview ? copilotTier({ mode: overview.boardMode, riskMatrix: overview.riskMatrix }) : "chat";
  useEffect(() => {
    if (tier === "chat") return;
    let alive = true;
    const poll = setInterval(() => {
      orchestratorOverviewAction(boardId)
        .then((o) => {
          if (alive) setOverview(o);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [boardId, tier]);
  const level = overview
    ? copilotStatus({
        mode: overview.boardMode,
        enabled: overview.settings.enabled.value,
        orchTokenPresent: overview.orchTokenPresent,
        writeBoard: overview.riskMatrix["write-board"],
        deploy: overview.riskMatrix["deploy"],
        paused: overview.paused,
      }).level
    : undefined;
  const running = overview?.state.running ?? false;
  useEffect(() => {
    if (level) onStatus({ level, running });
  }, [level, running, onStatus]);
  return null;
}

export function CopilotChatControls({
  boardId,
  onStatus,
  placement = "up",
}: {
  boardId: string;
  /** o estado REAL do board (o mesmo do ponto da verdade) + se um tick está rodando — alimenta o rosto do Jido. */
  onStatus?: (s: { level: CopilotStatusLevel; running: boolean }) => void;
  /** Para onde o cartão de ajustes abre: `down` quando o gatilho está no topo do painel, `up` perto do rodapé. */
  placement?: "up" | "down";
}) {
  const [overview, setOverview] = useState<CopilotOrchestratorOverview | null>(null);
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(() => {
    orchestratorOverviewAction(boardId)
      .then(setOverview)
      .catch(() => {});
  }, [boardId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const autonomous = overview ? copilotTier({ mode: overview.boardMode, riskMatrix: overview.riskMatrix }) !== "chat" : false;

  // Relógio local (1s) + re-leitura do read-model (30s): a contagem regressiva é local, mas nextTickAt/wake/
  // running vivem no servidor (o timer re-arma lá) — sem o poll o ponto mostraria um countdown congelado.
  useEffect(() => {
    if (!autonomous) return; // só há tick/countdown a acompanhar quando o board deixa o Jido agir sozinho
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    const poll = setInterval(refresh, 30_000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [autonomous, refresh]);

  const status = useMemo(
    () =>
      overview
        ? copilotStatus({
            mode: overview.boardMode,
            enabled: overview.settings.enabled.value,
            orchTokenPresent: overview.orchTokenPresent,
            writeBoard: overview.riskMatrix["write-board"],
            deploy: overview.riskMatrix["deploy"],
            paused: overview.paused,
          })
        : null,
    [overview],
  );

  // O ROSTO do Jido (no header, ao lado) precisa saber se o board vai acordá-lo (senão ele dorme) e se um
  // tick está rodando agora (aí ele fica "conectado"). Este componente já lê o overview — reporta em vez de
  // fazer o pai buscar de novo. Só dispara quando o par (nível, rodando) muda de verdade.
  const level = status?.level;
  const running = overview?.state.running ?? false;
  useEffect(() => {
    if (level) onStatus?.({ level, running });
  }, [level, running, onStatus]);

  /** A frase de "quando" — o que o operador pergunta o tempo todo com o Jido agindo sozinho. */
  const timing = useMemo(() => {
    if (!overview || overview.boardMode !== "autonomous" || status?.inert) return null;
    if (overview.state.running) return { text: "rodando agora", live: true };
    const wake = overview.clock.pendingWake;
    if (wake) return { text: `acorda em ${formatCountdown(wake.dueAt - nowMs)} · ${wake.reason}`, live: true };
    if (overview.clock.nextTickAt) return { text: `tick em ${formatCountdown(overview.clock.nextTickAt - nowMs)}`, live: false };
    return { text: "sem tick agendado", live: false };
  }, [overview, status, nowMs]);

  const truth = status && overview?.boardMode === "autonomous" ? { status, timing } : null;

  return (
    // Um grupo compacto: o PONTO da verdade (só quando o Jido age sozinho) + a engrenagem dos ajustes do runtime.
    <div className="relative flex shrink-0 items-center gap-0.5">
      {truth && (
        <span
          className={cn("inline-flex shrink-0 items-center gap-1 px-1 text-fg-muted", TXT.meta)}
          title={`${truth.status.label} — ${truth.status.detail}`}
        >
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[truth.status.tone], truth.timing?.live && "motion-safe:animate-pulse")} />
          {truth.timing && <span className="tabular-nums">{truth.timing.text}</span>}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(BTN_ICON, "shrink-0")}
        aria-label="Configurações rápidas do Jido"
        aria-expanded={open}
      >
        <Settings2 className={ICON.action} />
      </button>

      {open && overview && (
        <QuickSettings
          boardId={boardId}
          overview={overview}
          truth={truth ? { label: truth.status.label, detail: truth.status.detail, tone: truth.status.tone } : null}
          placement={placement}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function QuickSettings({
  boardId,
  overview,
  truth,
  placement,
  onClose,
  onChanged,
}: {
  boardId: string;
  overview: CopilotOrchestratorOverview;
  /** a verdade do estado quando o Jido age sozinho (o ponto do gatilho, por extenso) — null em modo só-conversa. */
  truth: { label: string; detail: string; tone: keyof typeof DOT } | null;
  /** o cartão abre para baixo (gatilho no topo do painel) ou para cima (gatilho no rodapé). */
  placement: "up" | "down";
  onClose: () => void;
  onChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(overview.settings.enabled.value);
  const [tickMinutes, setTickMinutes] = useState(overview.settings.tickMinutes);
  const [maxTicks, setMaxTicks] = useState(overview.settings.budget.maxTicksPerDay);
  const [maxCost, setMaxCost] = useState(overview.settings.budget.maxCostPerDay);
  const [wakeEnabled, setWakeEnabled] = useState(overview.settings.wake.enabled);
  const [model, setModel] = useState("opus");
  const [effort, setEffort] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** apelido base → id resolvido pelo CLI (`opus` → `claude-opus-5`) — a VERSÃO que o select não diz. */
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  // O modelo/esforço EFETIVOS (o que o próximo turno rodaria). Era o RunnerSettings INTEIRO que vinha para
  // cá — o arquivo todo no cliente só para preencher dois selects e ser devolvido por spread no Salvar.
  // Com a escrita cirúrgica, o popover não precisa mais conhecer o arquivo: ele lê o que EDITA.
  useEffect(() => {
    copilotChatModelAction()
      .then(({ model, effort, resolutions }) => {
        setModel(model);
        setEffort(effort);
        setResolutions(resolutions);
      })
      .catch(() => {});
  }, []);

  /** `opus` sozinho não diz se é 4.8 ou 5 — o id vem do que o CLI anunciou no último turno da família. */
  const modelVersion = resolutions[splitModelVariant(model).base.trim().toLowerCase()] ?? null;

  const saveSettings = async () => {
    setBusy(true);
    setMsg(null);
    // PATCH PARCIAL: só os knobs deste popover. O que ele não edita (riskMatrix, autorun, mergeGate, e o
    // debounce/cooldown do wake) nem viaja — e por isso não há como clobbar. O caminho antigo mandava o
    // RunnerSettings inteiro de volta: apagava os comentários do settings.yaml a cada Salvar e sobrescrevia
    // com uma cópia velha qualquer campo que tivesse mudado no servidor enquanto o popover estava aberto.
    const res = await saveOrchestratorSettingsAction({
      enabled,
      tickMinutes,
      maxTicksPerDay: maxTicks,
      maxCostPerDay: maxCost,
      wakeEnabled,
      model,
      effort,
    });
    setBusy(false);
    // O timer é armado SEMPRE e re-lê settings a cada ciclo → ligar/desligar e mudar a cadência valem sem
    // restart. (A tag "restart" que ficava aqui era falsa E perigosa: reiniciar o serviço derruba runs em voo.)
    setMsg(res.ok ? { ok: true, text: "Salvo — vale no próximo ciclo, sem restart." } : { ok: false, text: res.error });
    if (res.ok) onChanged();
  };

  const last = overview.state.lastTick;

  return (
    <>
      <button className="fixed inset-0 z-40 cursor-default" aria-label="Fechar" onClick={onClose} />
      {/* O popover PASSAVA da janela (não dava p/ rolar nem alcançar o fim). Agora: altura limitada ao
          viewport, corpo rolável, e o Salvar num rodapé FIXO — a ação principal nunca sai de alcance.
          Abre para CIMA (`bottom-full`) e para a DIREITA (`left-0`): a engrenagem desceu para a barra do
          composer, que fica na BORDA ESQUERDA do painel — ancorado à direita, o cartão de 320px crescia para
          fora do painel e o `overflow-hidden` do rail o cortava ao meio (visto no rail de 492px). */}
      <div
        className={cn(
          "absolute left-0 z-50 flex max-h-[min(75vh,34rem)] w-80 max-w-[90vw] flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-2xl",
          placement === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {/* CABEÇALHO — o painel não se apresentava: abria direto numa caixa cinza de "Último tick" e o
            operador tinha de deduzir onde estava e como sair. Título, fechar, e o caminho para a config
            completa ficam FIXOS aqui em cima, fora do rolável. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <p className={cn("min-w-0 flex-1 truncate font-semibold text-fg", TXT.label)}>Ajustes do Jido</p>
          <a href={`/board/${boardId}/config`} className={cn("shrink-0 font-medium text-accent hover:underline", TXT.meta)}>
            tudo →
          </a>
          <button type="button" onClick={onClose} className={cn(BTN_ICON, "-mr-1")} aria-label="Fechar ajustes">
            <X className={ICON.inline} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto overscroll-contain p-3">
          {/* AGORA — o estado, junto: o que ele fez por último e o quanto já gastou hoje. Eram dois blocos
              iguais em seções diferentes (um só aparecia se houvesse tick), lidos como controles quando são
              LEITURA. Um bloco só, sempre presente, visivelmente diferente do resto (é `bg-inset`). */}
          <div className="space-y-1.5 rounded-lg border border-line bg-inset px-2.5 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className={cn("font-semibold uppercase tracking-wide text-fg-subtle", TXT.meta)}>Agora</p>
              <span
                className={cn(
                  "tabular-nums",
                  TXT.meta,
                  overview.state.withinBudget ? "text-fg-subtle" : "font-semibold text-rose-600 dark:text-rose-400",
                )}
                title="Consumo de hoje contra os tetos (zera na virada do dia)"
              >
                {overview.state.budget.ticksToday}/{overview.settings.budget.maxTicksPerDay} ticks · $
                {overview.state.budget.costToday.toFixed(2)}/${overview.settings.budget.maxCostPerDay}
              </span>
            </div>
            <p className={cn("line-clamp-3 leading-snug text-fg", TXT.meta)}>
              {last
                ? last.outcome === "ran"
                  ? last.summary || "rodou (sem resumo)"
                  : `parou: ${last.reason ?? "sem motivo"}`
                : "Ainda não rodou nenhum ciclo neste board."}
            </p>
            {truth && (
              <p className={cn("flex items-start gap-1.5 leading-snug text-fg-subtle", TXT.meta)}>
                <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", DOT[truth.tone])} />
                <span>
                  <span className="text-fg">{truth.label}</span> — {truth.detail}
                </span>
              </p>
            )}
            {last && (
              <p className={cn("text-fg-subtle", TXT.meta)}>
                {new Date(last.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                {last.costUSD ? ` · $${last.costUSD.toFixed(2)}` : ""}
              </p>
            )}
          </div>

          {/* QUANDO ELE ACORDA */}
          <Section title="Quando ele acorda">
            <SettingRow label="Jido ligado" hint="desligado, ele não roda ciclo nenhum — o chat continua valendo">
              <Switch checked={enabled} onChange={() => setEnabled((v) => !v)} label="Jido ligado" />
            </SettingRow>
            <SettingRow label="Intervalo" hint="de quantos em quantos minutos ele revisa o board">
              <NumberField value={tickMinutes} min={1} onChange={(n) => setTickMinutes(Math.max(1, n))} suffix="min" />
            </SettingRow>
            <SettingRow
              label="Acordar por evento"
              hint="na hora em que algo trava, morre ou cai na fila — sem esperar o próximo ciclo"
            >
              <Switch checked={wakeEnabled} onChange={() => setWakeEnabled((v) => !v)} label="Acordar por evento" />
            </SettingRow>
          </Section>

          {/* QUANTO ELE PODE GASTAR */}
          <Section title="Teto do dia">
            <SettingRow label="Máx. de ciclos">
              <NumberField value={maxTicks} min={0} onChange={(n) => setMaxTicks(Math.max(0, n))} />
            </SettingRow>
            <SettingRow label="Máx. de custo" hint="o custo real de cada run é cobrado aqui quando ele termina">
              <NumberField value={maxCost} min={0} step={0.5} onChange={(n) => setMaxCost(Math.max(0, n))} prefix="$" />
            </SettingRow>
          </Section>

          {/* COMO ELE RESPONDE */}
          <Section title="Chat">
            <ChatModelEffort model={model} effort={effort} onModel={setModel} onEffort={setEffort} disabled={busy} />
            {/* QUAL opus? O select mostra o apelido, que é uma promessa ("o mais recente"); esta linha diz
                em que versão ele caiu de fato no último turno — sem chumbar no código um número que o
                próximo lançamento tornaria falso. Ver copilot/model-resolution.ts. */}
            {modelVersion && (
              <p className={cn("text-fg-subtle", TXT.meta)} title="Id que o CLI resolveu no último turno desta família">
                hoje o apelido <span className="font-mono">{splitModelVariant(model).base}</span> roda{" "}
                <span className="font-mono">{modelVersion}</span>
              </p>
            )}
          </Section>

          {/* («O que ele pode fazer sozinho» — a matriz de risco — saiu daqui na fase 4: é a caixa «O Jido agir sem você
              pedir» do controle único de autonomia, na barra do topo.) */}

          {/* ("Começar uma conversa nova" saiu daqui: é ação de CONVERSA, não ajuste do Jido, e agora mora no
              cabeçalho do painel — ver CopilotChats.tsx. Ela era o único item deste cartão que não configurava
              nada, e o terceiro lugar de onde o mesmo gesto saía.) */}
        </div>

        {/* Rodapé FIXO — o Salvar (e o retorno do save) sempre visível, mesmo com o corpo rolado. */}
        <div className="shrink-0 space-y-1 border-t border-line bg-surface p-3">
          <button
            type="button"
            onClick={saveSettings}
            // Só `busy`: o Salvar não espera mais o arquivo inteiro chegar (ele não é mais lido). Os
            // valores do popover vêm do overview, que já veio com o cartão.
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Salvar
          </button>
          {msg && (
            <p className={cn("text-[11px] font-medium", msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300")}>{msg.text}</p>
          )}
        </div>
      </div>
    </>
  );
}

// ── As peças do painel de ajustes ────────────────────────────────────────────────────────────────────
// Elas existem porque o popover tinha SEIS jeitos de desenhar a mesma coisa: dois toggles copiados linha a
// linha, três inputs numéricos com a mesma string de classes repetida, títulos de seção soltos e explicações
// que só existiam como `title` (invisíveis no toque). Com um `Section`/`SettingRow`/`Switch`/`NumberField` a
// régua é uma só — e o que era tooltip virou uma linha de ajuda que o dedo também alcança.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <p className={cn("font-semibold uppercase tracking-wide text-fg-subtle", TXT.meta)}>{title}</p>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

/** Uma linha de ajuste: o que é (+ por que), e o controle encostado à direita. */
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start justify-between gap-3">
      <span className="min-w-0 flex-1">
        <span className={cn("block text-fg", TXT.label)}>{label}</span>
        {hint && <span className={cn("mt-0.5 block leading-snug text-fg-subtle", TXT.meta)}>{hint}</span>}
      </span>
      <span className="shrink-0 pt-0.5">{children}</span>
    </label>
  );
}

/** O interruptor — UMA definição (era copiado inteiro em cada linha que precisava dele). */
function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
        checked ? "bg-emerald-500" : "bg-surface-hover",
      )}
    >
      <span className={cn("inline-block h-4 w-4 rounded-full bg-surface shadow transition", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

/** Campo numérico com a unidade GRUDADA nele (o "$" e o "min" estavam no rótulo, longe do número). */
function NumberField({
  value,
  onChange,
  min,
  step,
  prefix,
  suffix,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-inset px-2 py-1 focus-within:border-accent">
      {prefix && <span className={cn("text-fg-subtle", TXT.meta)}>{prefix}</span>}
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className={cn("w-11 bg-transparent text-right tabular-nums text-fg outline-none", TXT.label)}
      />
      {suffix && <span className={cn("text-fg-subtle", TXT.meta)}>{suffix}</span>}
    </span>
  );
}
