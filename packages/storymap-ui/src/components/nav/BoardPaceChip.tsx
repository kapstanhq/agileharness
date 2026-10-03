"use client";

// O RITMO DO BOARD no cabeçalho — pausar, andar devagar, retomar (lib/storymap/runner/board-pace.ts).
//
// O pedido do operador: um botão para ele — e para o agente que orquestra — parar um board inteiro e não gastar cota
// à toa, e para ajustar a velocidade sem editar configuração. O chip diz o ritmo em vigor; o painel diz quem o pôs,
// desde quando, até quando e quantos cards esperam a retomada, e troca de ritmo com um clique. Pausar pergunta só o que
// muda o resultado: o que fazer com o que já está rodando, e por quanto tempo.
//
// O painel ({@link BoardPacePanel}) é o mesmo no chip do computador e no menu «Mais» do celular.

import { useCallback, useEffect, useState, useTransition } from "react";
import { CirclePause, Play, Turtle } from "lucide-react";
import { cn } from "@/lib/cn";
import { getBoardPaceAction, setBoardPaceAction } from "@/app/board-pace-actions";
import { PACE_HELP, paceLabel, type BoardPaceView, type PaceLevel, type PauseMode } from "@/lib/storymap/runner/board-pace";
import { PAUSE_DURATIONS, paceHistoryLine, paceStatusLine, pauseMinutes } from "@/lib/storymap/board-pace-words";
import { NavChip, NavPopover, NavPopoverBlock, NavPopoverDivider, NavPopoverTitle, useHoverPopover, type NavTone } from "./NavShell";

const POLL_MS = 60_000;

/** O ritmo do board, lido ao montar, a cada minuto e sempre que o painel abre. */
function useBoardPace(boardId: string, open: boolean) {
  const [view, setView] = useState<BoardPaceView | null>(null);
  const load = useCallback(async () => {
    const r = await getBoardPaceAction(boardId).catch(() => null);
    if (r?.ok) setView(r.data);
  }, [boardId]);
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  return { view, setView };
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
export function BoardPacePanel({ boardId, view, onChanged }: { boardId: string; view: BoardPaceView | null; onChanged: (v: BoardPaceView) => void }) {
  const [pending, start] = useTransition();
  const [pausing, setPausing] = useState(false);
  const [mode, setMode] = useState<PauseMode>("drain");
  const [duration, setDuration] = useState<(typeof PAUSE_DURATIONS)[number]["id"]>("none");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!view) return <NavPopoverBlock className="text-[12px] text-fg-subtle">Lendo o ritmo do board…</NavPopoverBlock>;

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

  const choose = (level: PaceLevel) => {
    if (level === "paused") return setPausing((p) => !p);
    setPausing(false);
    if (view.source === "disarmed") {
      const yes = window.confirm("Este board está desligado. Ligar faz os passos automáticos dele dispararem agentes sozinhos, o que gasta cota. Ligar agora?");
      if (!yes) return;
      return apply(level, { arm: true });
    }
    apply(level);
  };

  const disarmed = view.source === "disarmed";
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
            {view.waiting} {view.waiting === 1 ? "card espera" : "cards esperam"} a retomada.
          </p>
        )}
        <div className="flex gap-1.5" role="group" aria-label="Ritmo do board">
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
        </div>
        {!pausing && <p className="text-[11px] leading-snug text-fg-subtle">{PACE_HELP[disarmed ? "paused" : view.level]}</p>}
      </NavPopoverBlock>

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
  const { view, setView } = useBoardPace(boardId, open);
  const level = view?.level ?? "normal";
  const disarmed = view?.source === "disarmed";
  const tone: NavTone = level === "paused" && !disarmed ? "owner" : "idle";
  const value = disarmed ? "Desligado" : paceLabel(level);
  return (
    <div ref={ref} className="relative">
      <NavChip
        leading={<PaceIcon level={level} className="h-4 w-4" />}
        value={value}
        tone={tone}
        open={open}
        onClick={() => setOpen((o) => !o)}
        title={view ? paceStatusLine(view, Date.now()) : "Ritmo do board"}
        ariaLabel={`Ritmo do board — ${value}`}
      />
      {open && (
        <NavPopover label="Ritmo do board" className="w-80">
          <NavPopoverTitle meta={value}>Ritmo do board</NavPopoverTitle>
          <BoardPacePanel boardId={boardId} view={view} onChanged={setView} />
        </NavPopover>
      )}
    </div>
  );
}

/** O mesmo painel dentro do menu «Mais» do celular (o chip do cabeçalho não monta ali). */
export function BoardPaceSheetSection({ boardId, active }: { boardId: string; active: boolean }) {
  const { view, setView } = useBoardPace(boardId, active);
  return (
    <section aria-label="Ritmo do board" className="mb-2 rounded-lg border border-line px-1.5 py-2">
      <NavPopoverTitle meta={view ? (view.source === "disarmed" ? "Desligado" : paceLabel(view.level)) : undefined}>Ritmo do board</NavPopoverTitle>
      <BoardPacePanel boardId={boardId} view={view} onChanged={setView} />
    </section>
  );
}
