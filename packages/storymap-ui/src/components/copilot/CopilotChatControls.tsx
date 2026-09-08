"use client";

// F3.1/3.2 — os controles do Jido, na BARRA DE AÇÕES do composer: o seletor de AUTONOMIA (Chat·Copiloto·
// Autônomo — o que ele faz SEM você) e a engrenagem com os quick-settings. Lê o MESMO read-model
// (orchestratorOverviewAction) que a config page → nunca divergem. Copiloto/Autônomo ficam cadeados enquanto o
// enforcement (F5.9) não shipa; Autônomo fica ADICIONALMENTE cadeado enquanto DEPLOY_AUTONOMY_ENABLED (§4) não
// é liberado pelo operador.
//
// ONDE ele vive (e por que mudou): era uma faixa no TOPO do painel, junto do nome "Jido" e da palavra de
// estado. O topo inteiro caiu — o nome e o estado já são o mascote no topnav da aplicação, e repeti-los aqui
// era uma barra de moldura em cima da conversa. Os controles desceram para junto do composer, onde moram as
// outras ações da conversa (anexo, contexto): o que se OPERA fica na mão, não na testa da tela.
//
// Os 3 estados são uma PROJEÇÃO de (mode, riskMatrix.deploy) — ver copilot/tier.ts. Chat=off, Copiloto=
// autonomous+deploy:ask, Autônomo=autonomous+deploy:auto. Escolher um estado ESCREVE seu (mode,matriz) canônico.
//
// Quatro coisas que este componente conserta:
//  1. RÓTULO — "off/paired/auto" não diziam nada e sugeriam que `off` desligava o Jido. Não desliga: o CHAT
//     sempre funciona. O que o modo governa é só a autonomia (agir sem você).
//  2. ESCOLHA INFORMADA — era um <select> nativo: três palavras sem contexto, num menu do sistema operacional
//     onde não cabe explicação. Virou popover, e cada opção carrega a DESCRIÇÃO do comportamento
//     (TIER_META.short; o texto completo no tooltip) — a decisão mais consequente do painel deixa de ser um
//     chute pelo rótulo.
//  3. VERDADE PERSISTENTE — "auto" aceso pode significar "agindo", "inerte (sem token)", "tick desarmado" ou
//     "só leitura". O gatilho carrega um PONTO com o tom da verdade (copilotStatus, fonte única) e o popover
//     abre com a frase inteira; o que era um chip permanente na régua não gasta mais largura à toa.
//  4. QUANDO — "a cada 30min" não responde "falta quanto?". O relógio in-process (orchestrator-clock) dá o
//     horário do próximo tick, e o wake por evento aparece no popover ("acorda em 40s · card X travou").

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Lock, Settings2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ToastCard } from "@/components/Toast";
import { BTN_ICON, DOT, ICON, TXT } from "./ui";
import { MenuBlock, MenuSep, Popover } from "./Popover";
import {
  copilotChatModelAction,
  orchestratorOverviewAction,
  saveOrchestratorSettingsAction,
  type CopilotOrchestratorOverview,
} from "@/app/copilot-actions";
import { setBoardOrchestratorModeAction } from "@/app/actions";
import { activationNotice, type ActivationNotice } from "@/lib/storymap/copilot/activation-notice";
import {
  copilotStatus,
  formatCountdown,
  splitModelVariant,
  type CopilotStatusLevel,
} from "@/lib/storymap/copilot/copilot-status";
import { copilotTier, tierMatrix, tierMode, tierUnlocked, TIER_META, type CopilotTier } from "@/lib/storymap/copilot/tier";
import { ChatModelEffort, RiskMatrixEditor } from "./CopilotSettingsControls";

/** A ordem dos 3 estados na lista (do mais contido ao mais amplo). Rótulo/descrição/tooltip vêm de TIER_META
 *  (fonte única, compartilhada com a config page). Escolher um estado escreve seu (mode,matriz) canônico — o
 *  ESTADO é a autonomia, não há sub-opção. Ver copilot/tier.ts. */
const TIERS: CopilotTier[] = ["chat", "copiloto", "autonomo"];

export function CopilotChatControls({
  boardId,
  onStatus,
  placement = "up",
}: {
  boardId: string;
  /** o estado REAL do board (o mesmo do chip da verdade) + se um tick está rodando — alimenta o rosto do Jido. */
  onStatus?: (s: { level: CopilotStatusLevel; running: boolean }) => void;
  /**
   * Para onde os painéis abrem. O seletor de modo subiu para a barra do TOPO do chat (é ele que governa a
   * conversa inteira — ele pertence a onde o olho começa, não à mão que digita), e um painel `bottom-full`
   * ancorado lá em cima abriria para fora da janela. `down` é o modo do topo; `up` fica para quem ainda
   * monta estes controles perto do rodapé.
   */
  placement?: "up" | "down";
}) {
  const [overview, setOverview] = useState<CopilotOrchestratorOverview | null>(null);
  const [tier, setTier] = useState<CopilotTier>("chat");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActivationNotice | null>(null); // Item 3 — confirmação honesta da ativação
  const [nowMs, setNowMs] = useState(() => Date.now());

  // auto-dismiss da confirmação (8s) — o estado PERSISTENTE agora vive no chip, então o toast pode sumir.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(t);
  }, [notice]);

  const refresh = useCallback(() => {
    orchestratorOverviewAction(boardId)
      .then((o) => {
        setOverview(o);
        // O estado ATIVO é derivado de (mode, matriz.deploy) — a mesma projeção que o resto do sistema lê.
        setTier(copilotTier({ mode: o.boardMode, riskMatrix: o.riskMatrix }));
      })
      .catch(() => {});
  }, [boardId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Relógio local (1s) + re-leitura do read-model (30s): a contagem regressiva é local, mas nextTickAt/wake/
  // running vivem no servidor (o timer re-arma lá) — sem o poll o header mostraria um countdown congelado.
  useEffect(() => {
    if (tier === "chat") return; // só há tick/countdown a acompanhar nos estados autônomos (Copiloto/Autônomo)
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    const poll = setInterval(refresh, 30_000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [tier, refresh]);

  const enforcement = overview?.enforcementShipped ?? false;

  // Por que os estados acima de Chat podem estar travados — vira o title do select (as <option> não têm
  // tooltip próprio) para não perder a explicação que os botões do segmented traziam.
  const autonomyLockHint = !enforcement
    ? "Copiloto/Autônomo indisponíveis: o enforcement da matriz de risco está desligado. Só Chat por enquanto."
    : !tierUnlocked("autonomo")
      ? "Publicação autônoma em revisão pelo operador — Autônomo libera após aprovar o mecanismo de deploy-autônomo (§4)."
      : null;

  const status = useMemo(
    () =>
      overview
        ? copilotStatus({
            mode: overview.boardMode,
            enabled: overview.settings.enabled.value,
            orchTokenPresent: overview.orchTokenPresent,
            writeBoard: overview.riskMatrix["write-board"],
            deploy: overview.riskMatrix["deploy"],
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

  /** A frase de "quando" — o que o operador pergunta o tempo todo em modo autônomo. */
  const timing = useMemo(() => {
    if (!overview || overview.boardMode !== "autonomous" || status?.inert) return null;
    if (overview.state.running) return { text: "rodando agora", live: true };
    const wake = overview.clock.pendingWake;
    if (wake) return { text: `acorda em ${formatCountdown(wake.dueAt - nowMs)} · ${wake.reason}`, live: true };
    if (overview.clock.nextTickAt) return { text: `tick em ${formatCountdown(overview.clock.nextTickAt - nowMs)}`, live: false };
    return { text: "sem tick agendado", live: false };
  }, [overview, status, nowMs]);

  const write = async (next: CopilotTier) => {
    setErr(null);
    const prev = tier;
    setTier(next); // otimista
    setBusy(true);
    // Cada estado escreve seu (mode,matriz) canônico numa ÚNICA escrita (tier.ts). Chat só desliga o tick
    // (mode off) e preserva a matriz atual do board (riskMatrix ausente = mantém).
    const mode = tierMode(next);
    const riskMatrix = next === "chat" ? undefined : tierMatrix(next);
    const res = await setBoardOrchestratorModeAction({ boardId, mode, riskMatrix });
    setBusy(false);
    if (!res.ok) {
      setTier(prev); // revert
      setErr(res.error);
      return;
    }
    if (overview) {
      // confirmação HONESTA: usa o overview atual + a autonomia recém-escolhida (o read-model só reflete a
      // matriz nova no próximo refresh, e o operador precisa da verdade AGORA).
      setNotice(
        activationNotice({
          mode,
          enabled: overview.settings.enabled.value,
          orchTokenPresent: overview.orchTokenPresent,
          tickMinutes: overview.settings.tickMinutes,
          writeBoard: riskMatrix?.["write-board"] ?? overview.riskMatrix["write-board"],
        }),
      );
    }
    refresh();
  };

  const pickTier = async (next: CopilotTier) => {
    // O ESTADO é a autonomia — não há mais sub-popover. Um estado travado (enforcement off, ou Autônomo antes do
    // gate de deploy-autônomo) simplesmente não é selecionável.
    if (busy || next === tier || !tierUnlocked(next)) return;
    await write(next);
  };

  return (
    // Um grupo compacto na barra de ações do composer: modo + engrenagem, e nada mais ocupando largura.
    <div className="relative flex shrink-0 items-center gap-0.5">
      {/* AUTONOMIA (o que ele faz SEM você) — popover, não <select>. O menu nativo do sistema operacional só
          aceita três palavras soltas; a escolha mais consequente do painel (deixar ou não o Jido agir e
          publicar sozinho) merece a DESCRIÇÃO do comportamento ao lado de cada opção. O gatilho mostra o modo
          atual e, no autônomo, um PONTO com o tom da verdade — "auto" aceso pode ser agindo, inerte ou só
          leitura, e essa diferença não pode morar apenas dentro do popover fechado. */}
      <Popover
        label="Autonomia do Jido — o que ele faz sem você"
        title={autonomyLockHint ?? `O que o Jido faz sem você — ${TIER_META[tier].hint}`}
        align="left"
        direction={placement}
        className="w-72"
        triggerClassName={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg",
          TXT.label,
        )}
        trigger={
          <>
            {status && overview?.boardMode === "autonomous" && (
              <span
                className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[status.tone], timing?.live && "animate-pulse")}
              />
            )}
            {TIER_META[tier].label}
            <ChevronDown className={ICON.inline} />
          </>
        }
      >
        {(close) => (
          <>
            {TIERS.map((t) => {
              // Copiloto/Autônomo exigem enforcement; Autônomo depende AINDA do gate de deploy-autônomo (§4).
              const locked = (t !== "chat" && !enforcement) || !tierUnlocked(t);
              const active = t === tier;
              return (
                <button
                  key={t}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={locked || busy}
                  title={locked ? (autonomyLockHint ?? "Estado bloqueado") : TIER_META[t].hint}
                  onClick={() => {
                    void pickTier(t);
                    close();
                  }}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition",
                    "hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                    active && "bg-inset",
                  )}
                >
                  <span className={cn("flex items-center gap-1.5 font-semibold text-fg", TXT.label)}>
                    {TIER_META[t].label}
                    {active && <Check className={cn(ICON.inline, "text-accent")} />}
                    {locked && <Lock className={cn(ICON.inline, "text-fg-subtle")} />}
                  </span>
                  {/* A descrição BREVE do comportamento — o que muda de fato ao escolher este estado. */}
                  <span className={cn("leading-snug text-fg-subtle", TXT.meta)}>{TIER_META[t].short}</span>
                </button>
              );
            })}

            {/* A VERDADE do estado + o QUANDO — antes eram um chip e um contador permanentes na régua do
                header. Eles pertencem a esta conversa (o que o modo escolhido está REALMENTE fazendo agora),
                e aqui cabem por extenso em vez de abreviados numa faixa de 420px. */}
            {status && overview?.boardMode === "autonomous" && (
              <>
                <MenuSep />
                <MenuBlock>
                  <div className={cn("flex items-center gap-1.5 font-medium", TXT.meta)}>
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[status.tone])} />
                    <span className="text-fg">{status.label}</span>
                  </div>
                  <div className="leading-snug text-fg-subtle">{status.detail}</div>
                  {timing && (
                    <div className={cn("tabular-nums", timing.live ? "text-accent" : "text-fg-subtle")}>
                      {timing.text}
                    </div>
                  )}
                </MenuBlock>
              </>
            )}
          </>
        )}
      </Popover>

      {/* Engrenagem → popover */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(BTN_ICON, "shrink-0")}
        aria-label="Configurações rápidas do Jido"
        aria-expanded={open}
      >
        <Settings2 className={ICON.action} />
      </button>
      {busy && <Loader2 className={cn(ICON.inline, "animate-spin text-fg-subtle")} />}
      {err && <span className={cn("shrink-0 text-rose-500", TXT.meta)} title={err}>erro</span>}

      {open && overview && (
        <QuickSettings
          boardId={boardId}
          overview={overview}
          placement={placement}
          onClose={() => setOpen(false)}
          onChanged={refresh}
        />
      )}

      {/* Item 3 — confirmação honesta da ativação (auto-some em 8s; o estado persistente fica no ponto do
          gatilho + no popover de modo). Mesmo CARTÃO da pilha de toasts (ToastCard), só ancorado aqui — e
          para CIMA, como todo painel desta barra. */}
      {notice && (
        <ToastCard
          kind={notice.level === "ok" ? "success" : "warning"}
          message={notice.text}
          onDismiss={() => setNotice(null)}
          className={cn("absolute left-0 z-50 w-72 max-w-[85vw]", placement === "up" ? "bottom-9" : "top-9")}
        />
      )}
    </div>
  );
}

function QuickSettings({
  boardId,
  overview,
  placement,
  onClose,
  onChanged,
}: {
  boardId: string;
  overview: CopilotOrchestratorOverview;
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
  const risk = riskSummary(overview.riskMatrix);

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

          {/* O QUE ELE PODE FAZER SOZINHO — a matriz é uma TABELA de 10 linhas com um Salvar PRÓPRIO: aberta,
              ela era 2/3 do popover e punha dois botões "Salvar" competindo na mesma tela. Fechada, ela vira
              uma linha de resumo (quantas classes são automáticas / perguntam / nunca) e só abre quem vai
              mexer — que é o caso raro. Nada saiu daqui: o editor é o MESMO da config completa. */}
          <Disclosure title="O que ele pode fazer sozinho" summary={risk}>
            <RiskMatrixEditor
              boardId={boardId}
              resolved={overview.riskMatrix}
              warnings={overview.riskMatrixWarnings}
              onSaved={onChanged}
            />
          </Disclosure>

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

/** Uma seção que se ABRE — fechada mostra o resumo, aberta mostra o editor inteiro. */
function Disclosure({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-line pt-2.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-left">
        <ChevronRight className={cn(ICON.inline, "text-fg-subtle transition", open && "rotate-90")} />
        <span className={cn("min-w-0 flex-1 font-medium text-fg", TXT.label)}>{title}</span>
        {!open && <span className={cn("shrink-0 tabular-nums text-fg-subtle", TXT.meta)}>{summary}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

/** O resumo da matriz de risco em uma linha: quantas classes ele faz sozinho, quantas pergunta, quantas nunca. */
function riskSummary(matrix: Record<string, string>): string {
  const vals = Object.values(matrix);
  const n = (d: string) => vals.filter((v) => v === d).length;
  return `${n("auto")} auto · ${n("ask")} pergunta · ${n("never")} nunca`;
}
