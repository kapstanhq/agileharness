"use client";

// O RITMO DO BOARD no cabeçalho — pausar, andar devagar, retomar (lib/storymap/runner/board-pace.ts).
//
// O pedido do operador: um botão para ele — e para o agente que orquestra — parar um board inteiro e não gastar cota
// à toa, e para ajustar a velocidade sem editar configuração. O chip diz o ritmo em vigor; o painel diz quem o pôs,
// desde quando, até quando e quantos cards esperam a retomada, e troca de ritmo com um clique. Pausar pergunta só o que
// muda o resultado: o que fazer com o que já está rodando, e por quanto tempo.
//
// O ESCOPO é um SEGUNDO eixo, independente do ritmo: o ritmo diz QUANTO o board anda, o escopo diz O QUE ele pode começar
// sozinho («Só consertos e manutenção» não começa funcionalidade nova). O painel os mostra em blocos separados e diz, em
// palavras, que o escopo não poupa cota — sem isso o dono acharia que «só consertos» gasta menos.
//
// O painel ({@link BoardPacePanel}) é o mesmo no chip do computador e no menu «Mais» do celular.

import { useCallback, useEffect, useState, useTransition } from "react";
import { CircleDashed, CirclePause, Play, Turtle, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { getBoardPaceAction, setBoardPaceAction, setBoardScopeAction } from "@/app/board-pace-actions";
import { PACE_HELP, paceLabel, type BoardPaceView, type PaceLevel, type PauseMode } from "@/lib/storymap/runner/board-pace";
import {
  PACE_PANEL_LOADING,
  PACE_PANEL_UNAVAILABLE,
  PAUSE_DURATIONS,
  SCOPE_AXIS_HELP,
  SCOPE_BOUNDS_HELP,
  SCOPE_PRESETS,
  SCOPE_QUOTA_HELP,
  featuresToShipWords,
  paceChipFace,
  paceChipValue,
  paceHistoryLine,
  paceStatusLine,
  pauseMinutes,
  scopeHistoryLine,
  scopeWaitingWords,
} from "@/lib/storymap/board-pace-words";
import { NavChip, NavPopover, NavPopoverBlock, NavPopoverDivider, NavPopoverTitle, useHoverPopover, type NavTone } from "./NavShell";

const POLL_MS = 60_000;

/**
 * O ritmo do board, lido ao montar, a cada minuto e sempre que o painel abre. `failed` = a última tentativa não leu (e o
 * chip só o usa se nunca houve leitura: com uma leitura boa na mão, ela vale mais que um erro novo — ver `paceReadState`).
 */
function useBoardPace(boardId: string, open: boolean) {
  const [view, setView] = useState<BoardPaceView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await getBoardPaceAction(boardId).catch(() => null);
    if (r?.ok) {
      setView(r.data);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, [boardId]);
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return { view, setView, failed };
}

function PaceIcon({ level, className }: { level: PaceLevel; className?: string }) {
  if (level === "paused") return <CirclePause className={className} aria-hidden />;
  if (level === "slow") return <Turtle className={className} aria-hidden />;
  return <Play className={className} aria-hidden />;
}

const LEVELS: readonly PaceLevel[] = ["normal", "slow", "paused"];
const MODES: ReadonlyArray<{ id: PauseMode; label: string; help: string }> = [
  { id: "drain", label: "Deixar terminar", help: "O que já está rodando termina; nada novo começa." },
  { id: "stop", label: "Parar agora", help: "O que está rodando guarda o trabalho e para; volta quando você retomar." },
];

const OPTION = "flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium transition";
const OPTION_ON = "border-accent bg-accent/10 text-accent-ink";
const OPTION_OFF = "border-line text-fg-muted hover:bg-surface-hover hover:text-fg";

/** O painel do ritmo: estado, as três posições, as opções da pausa, a sugestão pela cota e o histórico curto. */
export function BoardPacePanel({ boardId, view, failed = false, onChanged }: { boardId: string; view: BoardPaceView | null; failed?: boolean; onChanged: (v: BoardPaceView) => void }) {
  const [pending, start] = useTransition();
  const [pausing, setPausing] = useState(false);
  const [mode, setMode] = useState<PauseMode>("drain");
  const [duration, setDuration] = useState<(typeof PAUSE_DURATIONS)[number]["id"]>("none");
  const [reason, setReason] = useState("");
  // o escopo: «Só consertos» abre um passo para escolher o prazo; «Tudo» vale na hora (alargar não pede nada)
  const [limiting, setLimiting] = useState(false);
  const [scopeDuration, setScopeDuration] = useState<(typeof PAUSE_DURATIONS)[number]["id"]>("none");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!view) return <NavPopoverBlock className="text-[12px] text-fg-subtle">{failed ? PACE_PANEL_UNAVAILABLE : PACE_PANEL_LOADING}</NavPopoverBlock>;

  const apply = (level: PaceLevel, extra: { mode?: PauseMode; forMinutes?: number; reason?: string; arm?: boolean } = {}) =>
    start(async () => {
      setNote(null);
      const r = await setBoardPaceAction({ boardId, level, ...extra }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (!r.ok) return setNote({ tone: "error", text: r.error });
      onChanged(r.data.pace);
      setPausing(false);
      setReason("");
      setNote({ tone: "ok", text: r.data.message });
    });

  const applyScope = (preset: "all" | "fixes", extra: { forMinutes?: number } = {}) =>
    start(async () => {
      setNote(null);
      const r = await setBoardScopeAction({ boardId, preset, ...extra }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (!r.ok) return setNote({ tone: "error", text: r.error });
      onChanged(r.data.pace);
      setLimiting(false);
      setScopeDuration("none");
      setNote({ tone: "ok", text: r.data.message });
    });

  const chooseScope = (preset: "all" | "fixes") => {
    if (preset === "all") {
      setLimiting(false);
      return applyScope("all");
    }
    setLimiting((l) => !l);
  };

  const choose = (level: PaceLevel) => {
    if (level === "paused") {
      setLimiting(false);
      return setPausing((p) => !p);
    }
    setPausing(false);
    if (view.source === "disarmed") {
      const yes = window.confirm("Este board está desligado. Ligar faz os passos automáticos dele dispararem agentes sozinhos, o que gasta cota. Ligar agora?");
      if (!yes) return;
      return apply(level, { arm: true });
    }
    apply(level);
  };

  const disarmed = view.source === "disarmed";
  // só organização: o ritmo não se aplica (nada roda sozinho, de qualquer jeito) — o painel só diz o estado
  const organize = view.source === "organize-only";
  // desarmado e ilegível seguram tudo antes de olhar tipo: o escopo só tem o que dizer num board que anda
  const showScope = view.source !== "disarmed" && view.source !== "unreadable" && !organize;
  const scopePreset = view.scope?.preset ?? "all";
  const waitingWords = scopeWaitingWords(view);
  const shipWords = featuresToShipWords(view.featuresToShip);
  const earlierScope = view.scopeHistory.filter((r) => !view.scope || r.at !== view.scope.since).slice(0, 3);
  // A mudança que pôs o ritmo em vigor já está dita na linha de estado: o histórico mostra as ANTERIORES.
  const earlier = view.history.filter((c) => c.at !== view.since).slice(0, 3);
  return (
    <>
      <NavPopoverBlock>
        <p className="text-[12px] leading-snug text-fg">{paceStatusLine(view, now)}</p>
        {/* Escolhendo a pausa, o painel mostra só o que a escolha pede — o motivo e a ajuda voltam depois (o botão de
            confirmar não pode ficar abaixo da dobra do painel). */}
        {view.reason && !pausing && <p className="text-[12px] leading-snug text-fg-muted">Motivo: {view.reason}</p>}
        {view.waiting > 0 && !pausing && (
          <p className="text-[12px] leading-snug text-fg-muted">
            {/* «waiting» conta os PEDIDOS de trabalho que a pausa segurou (um card pode pedir mais de uma vez) — não é a
                fila de cards do Kanban («N na fila»), que conta cards esperando vaga de agente. */}
            A pausa segurou {view.waiting} {view.waiting === 1 ? "pedido de trabalho" : "pedidos de trabalho"}; eles voltam quando você retomar.
          </p>
        )}
        {!organize && (<div className="flex gap-1.5" role="group" aria-label="Ritmo do board">
          {LEVELS.map((level) => {
            const on = pausing ? level === "paused" : view.level === level && !disarmed;
            return (
              <button
                key={level}
                type="button"
                disabled={pending}
                aria-pressed={on}
                title={PACE_HELP[level]}
                onClick={() => choose(level)}
                className={cn(OPTION, on ? OPTION_ON : OPTION_OFF, pending && "opacity-60")}
              >
                <PaceIcon level={level} className="h-3.5 w-3.5" />
                {disarmed && level === "normal" ? "Ligar" : paceLabel(level)}
              </button>
            );
          })}
        </div>)}
        {!pausing && !organize && <p className="text-[11px] leading-snug text-fg-subtle">{PACE_HELP[disarmed ? "paused" : view.level]}</p>}
      </NavPopoverBlock>

      {showScope && !pausing && (
        <>
          <NavPopoverDivider />
          <NavPopoverBlock>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">O que o board pode começar sozinho</p>
            <div className="flex gap-1.5" role="group" aria-label="O que o board pode começar sozinho">
              {SCOPE_PRESETS.map((p) => {
                const on = limiting ? p.id === "fixes" : scopePreset === p.id;
                return (
                  <button key={p.id} type="button" disabled={pending} aria-pressed={on} title={p.help} onClick={() => chooseScope(p.id)} className={cn(OPTION, on ? OPTION_ON : OPTION_OFF, pending && "opacity-60")}>
                    {p.id === "fixes" && <Wrench className="h-3.5 w-3.5" aria-hidden />}
                    {p.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] leading-snug text-fg-subtle">{SCOPE_PRESETS.find((p) => p.id === (limiting ? "fixes" : scopePreset))?.help ?? "O board pode começar este recorte de tipos."}</p>
            {waitingWords && <p className="text-[12px] leading-snug text-fg-muted">{waitingWords}.</p>}
            {shipWords && <p className="text-[12px] leading-snug text-fg-muted">{shipWords}</p>}
            <p className="text-[11px] leading-snug text-fg-subtle">{SCOPE_AXIS_HELP} {SCOPE_QUOTA_HELP}</p>
          </NavPopoverBlock>
        </>
      )}

      {showScope && limiting && !pausing && (
        <NavPopoverBlock>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Por quanto tempo</p>
          <div className="flex gap-1.5">
            {PAUSE_DURATIONS.map((d) => (
              <button key={d.id} type="button" aria-pressed={scopeDuration === d.id} onClick={() => setScopeDuration(d.id)} className={cn(OPTION, scopeDuration === d.id ? OPTION_ON : OPTION_OFF)}>
                {d.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-fg-subtle">{SCOPE_BOUNDS_HELP}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => applyScope("fixes", { forMinutes: pauseMinutes(scopeDuration, new Date()) })}
            className={cn("flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-2 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover", pending && "opacity-60")}
          >
            <Wrench className="h-3.5 w-3.5" aria-hidden />
            {pending ? "Limitando…" : "Só consertos e manutenção"}
          </button>
        </NavPopoverBlock>
      )}

      {pausing && (
        <>
          <NavPopoverDivider />
          <NavPopoverBlock>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">O que já está rodando</p>
            <div className="flex gap-1.5">
              {MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={mode === m.id} title={m.help} onClick={() => setMode(m.id)} className={cn(OPTION, mode === m.id ? OPTION_ON : OPTION_OFF)}>
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-fg-subtle">{MODES.find((m) => m.id === mode)?.help}</p>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Por quanto tempo</p>
            <div className="flex gap-1.5">
              {PAUSE_DURATIONS.map((d) => (
                <button key={d.id} type="button" aria-pressed={duration === d.id} onClick={() => setDuration(d.id)} className={cn(OPTION, duration === d.id ? OPTION_ON : OPTION_OFF)}>
                  {d.label}
                </button>
              ))}
            </div>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="Motivo (opcional)"
              aria-label="Motivo da pausa"
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-[12px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() => apply("paused", { mode, forMinutes: pauseMinutes(duration, new Date()), reason: reason.trim() || undefined })}
              className={cn("flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-2 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover", pending && "opacity-60")}
            >
              <CirclePause className="h-3.5 w-3.5" aria-hidden />
              {pending ? "Pausando…" : "Pausar o board"}
            </button>
          </NavPopoverBlock>
        </>
      )}

      {view.suggestion && !pausing && (
        <>
          <NavPopoverDivider />
          <NavPopoverBlock>
            <p className="text-[12px] leading-snug text-fg-muted">A cota do Claude está acima do ritmo: {view.suggestion.why}.</p>
            <button type="button" disabled={pending} onClick={() => apply(view.suggestion!.level)} className={cn(OPTION, OPTION_OFF, "w-full flex-none")}>
              <PaceIcon level={view.suggestion.level} className="h-3.5 w-3.5" />
              Andar {paceLabel(view.suggestion.level).toLowerCase()}
            </button>
          </NavPopoverBlock>
        </>
      )}

      {note && (
        <NavPopoverBlock>
          <p role="status" className={cn("text-[12px] leading-snug", note.tone === "error" ? "text-danger" : "text-fg-muted")}>
            {note.text}
          </p>
        </NavPopoverBlock>
      )}

      {earlierScope.length > 0 && !pausing && (
        <>
          <NavPopoverDivider />
          <NavPopoverBlock className="gap-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Últimas mudanças do que o board começa</p>
            {earlierScope.map((r) => (
              <p key={`${r.at}-${r.types?.join("") ?? "all"}`} className="text-[11px] leading-snug text-fg-muted">
                {scopeHistoryLine(r, now)}
              </p>
            ))}
          </NavPopoverBlock>
        </>
      )}

      {earlier.length > 0 && !pausing && (
        <>
          <NavPopoverDivider />
          <NavPopoverBlock className="gap-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">Últimas mudanças</p>
            {earlier.map((c) => (
              <p key={`${c.at}-${c.level}`} className="text-[11px] leading-snug text-fg-muted">
                {paceHistoryLine(c, now)}
              </p>
            ))}
          </NavPopoverBlock>
        </>
      )}
    </>
  );
}

/** O chip do cabeçalho (computador): o ritmo em vigor; o painel abre no clique (e no toque). */
export function BoardPaceChip({ boardId }: { boardId: string }) {
  // Abre no CLIQUE, não no hover: é um controle (com campo de texto), não um medidor — um painel que fecha quando o
  // mouse sai apagaria o que o dono estava escrevendo.
  const { open, setOpen, ref } = useHoverPopover();
  const { view, setView, failed } = useBoardPace(boardId, open);
  const level = view?.level ?? "normal";
  const disarmed = view?.source === "disarmed" || view?.source === "organize-only";
  const tone: NavTone = level === "paused" && !disarmed ? "owner" : "idle";
  // Sem leitura o chip NÃO assume «Normal»: diz que está lendo (ou que não deu), sem nível e sem o ícone de «anda».
  const face = paceChipFace(view, failed, Date.now());
  const reading = face.state !== "ready";
  return (
    <div ref={ref} className="relative">
      <NavChip
        leading={reading ? <CircleDashed className={cn("h-4 w-4", face.state === "loading" && "animate-spin text-fg-subtle")} aria-hidden /> : <PaceIcon level={level} className="h-4 w-4" />}
        // largura mínima: «Ritmo…» → «Normal» não faz o cabeçalho pular (o texto final varia com o escopo, o piso não)
        value={reading ? <span className={cn("inline-block min-w-[7ch]", face.state === "loading" && "text-fg-subtle")}>{face.value}</span> : face.value}
        tone={tone}
        open={open}
        onClick={() => setOpen((o) => !o)}
        title={face.title}
        ariaLabel={face.ariaLabel}
      />
      {open && (
        <NavPopover label="Ritmo do board" className="w-80">
          <NavPopoverTitle meta={view ? face.value : undefined}>Ritmo do board</NavPopoverTitle>
          <BoardPacePanel boardId={boardId} view={view} failed={failed} onChanged={setView} />
        </NavPopover>
      )}
    </div>
  );
}

/**
 * O SELO do ritmo no topo do celular: só aparece quando o board NÃO está andando normal (pausado/devagar). No celular
 * o chip não monta (o painel mora no «Mais»), e um board pausado ficava invisível no topo — quem abria o Kanban não
 * sabia por que nada andava. Só indica; trocar o ritmo segue no «Mais».
 */
export function BoardPaceBadge({ boardId }: { boardId: string }) {
  const { view } = useBoardPace(boardId, false);
  if (!view || view.source === "disarmed" || view.level === "normal") return null;
  const label = view.level === "paused" ? "Pausado" : "Devagar";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium",
        view.level === "paused" ? "border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300" : "border-line text-fg-muted",
      )}
      title={`Ritmo do board: ${paceChipValue(view)} — troque no menu «Mais»`}
    >
      <PaceIcon level={view.level} className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

/** O mesmo painel dentro do menu «Mais» do celular (o chip do cabeçalho não monta ali). */
export function BoardPaceSheetSection({ boardId, active }: { boardId: string; active: boolean }) {
  const { view, setView, failed } = useBoardPace(boardId, active);
  return (
    <section aria-label="Ritmo do board" className="mb-2 rounded-lg border border-line px-1.5 py-2">
      <NavPopoverTitle meta={view ? paceChipValue(view) : undefined}>Ritmo do board</NavPopoverTitle>
      <BoardPacePanel boardId={boardId} view={view} failed={failed} onChanged={setView} />
    </section>
  );
}
