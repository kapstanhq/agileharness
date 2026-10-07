"use client";

// O RITMO na 2ª barra do Kanban — a pílula `[Rodando · 1/2 condutores ▾ | ⏸]`. O texto abre o painel «Ritmo do board»;
// o botão da direita pausa (deixando terminar o que já roda) ou retoma num clique.
//
// O painel junta os eixos que o dono controla sem editar configuração:
//   • o RITMO (Normal / Devagar / Pausar) — as mesmas posições e a MESMA action do antigo chip do cabeçalho
//     (`setBoardPaceAction`); pausar pergunta o que fazer com o que já roda (Deixar terminar / Parar agora), por
//     quanto tempo e o motivo; um board DESLIGADO só liga com confirmação (ligar dispara agentes e gasta cota);
//   • as VAGAS de condutor (1 / 2) — só num board que usa condutor; grava `conductor.maxSessions` pela action do
//     operador (`setConductorSlotsAction`);
//   • o ESCOPO (Tudo / Só consertos) — o que o board pode COMEÇAR sozinho (`setBoardScopeAction`), que não poupa cota;
//   • o modo «só organização» — chave do operador, com confirmação, como antes.
// Quem pode o quê (freio do dono × do agente, limite do dono) mora nas actions e em runner/board-pace*.ts: aqui só se
// pede e se mostra a recusa com a frase.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getBoardPaceAction, setBoardPaceAction, setBoardScopeAction, setConductorSlotsAction, setOrganizeOnlyAction } from "@/app/board-pace-actions";
import { PACE_HELP, paceLabel, type BoardPaceView, type PaceLevel, type PauseMode } from "@/lib/storymap/runner/board-pace";
import {
  ORGANIZE_ONLY_CONFIRM_OFF,
  ORGANIZE_ONLY_CONFIRM_ON,
  ORGANIZE_ONLY_TURN_OFF,
  ORGANIZE_ONLY_TURN_ON,
  ORGANIZE_ONLY_TURN_ON_HELP,
  PACE_ARM_CONFIRM,
  PACE_PANEL_LOADING,
  PACE_PANEL_UNAVAILABLE,
  PAUSE_DURATIONS,
  paceRunningFace,
  SCOPE_PRESETS,
  paceStatusLine,
  pauseMinutes,
  scopeSentenceWords,
  scopeWaitingWords,
} from "@/lib/storymap/board-pace-words";
import { notifyBoardPaceChanged, onBoardPaceChanged } from "@/components/board-pace-bus";
import { useDismiss } from "./KanbanFilterMenu";

const POLL_MS = 60_000;

/**
 * O ritmo do board, lido ao montar, a cada minuto e quando o painel abre (a mesma disciplina do chip antigo: com uma
 * leitura boa na mão, um erro novo não a apaga). O Kanban o lê UMA vez e passa à pílula e ao «Mostrar» (que troca
 * «Rodando» por «Pausado» com o board pausado).
 */
export function useKanbanBoardPace(boardId: string, open = false) {
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
  // Uma mudança feita em OUTRO ponto da tela (o popover da caixinha, o `/pausar` do Jido) chega aqui na hora.
  useEffect(
    () =>
      onBoardPaceChanged((c) => {
        if (c.boardId !== boardId) return;
        if (c.view) {
          setView(c.view);
          setFailed(false);
        } else void load();
      }),
    [boardId, load],
  );
  /** Troca a vista E avisa os outros leitores do ritmo (o compositor do Jido, outro painel). */
  const publish = useCallback((v: BoardPaceView) => notifyBoardPaceChanged({ boardId, view: v }), [boardId]);
  return { view, setView: publish, failed, reload: load };
}

/** O ritmo lido (`useKanbanBoardPace`), como o Kanban o passa à 2ª barra. */
export type KanbanBoardPace = ReturnType<typeof useKanbanBoardPace>;

// Os glifos são os SVG da pílula (▶ e as duas barras do ⏸): o caractere «⏸» caía, em fonte sem ele, num quadrado
// cheio — que lê como «parar», não «pausar».
const LEVELS: ReadonlyArray<{ id: PaceLevel; label: string; glyph?: "play" | "pause" }> = [
  { id: "normal", label: "Normal", glyph: "play" },
  { id: "slow", label: "Devagar" },
  { id: "paused", label: "Pausar", glyph: "pause" },
];
const MODES: ReadonlyArray<{ id: PauseMode; label: string; help: string }> = [
  { id: "drain", label: "Deixar terminar", help: "O que já está rodando termina; nada novo começa." },
  { id: "stop", label: "Parar agora", help: "O que está rodando guarda o trabalho e para; volta quando você retomar." },
];
const SCOPE_SHORT: Record<string, string> = { all: "Tudo", fixes: "Só consertos" };

const OPT = "flex h-10 flex-1 items-center justify-center gap-1 rounded-lg border px-2 text-[12px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 md:h-8";
/** A fila do RITMO (Normal / Devagar / Pausar) é a mais alta do painel no desenho: 34px. */
const OPT_PACE = "md:h-[34px]";
const OPT_ON = "border-fg bg-surface-hover text-fg";
const OPT_OFF = "border-line bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg";
const SECTION = "text-[11px] font-semibold uppercase tracking-[.04em] text-fg-subtle";
const HELP = "text-[12px] leading-snug text-fg-subtle";

/** A linha de estado termina em ponto antes da frase do escopo («… · há 2 dias. Só começa consertos…»). */
const withStop = (line: string) => (/[.!?…]$/.test(line.trim()) ? line : `${line.trim()}.`);

function PauseGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x={6} y={4} width={4} height={16} rx={1} />
      <rect x={14} y={4} width={4} height={16} rx={1} />
    </svg>
  );
}
function PlayGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

export interface KanbanPaceControlProps {
  boardId: string;
  view: BoardPaceView | null;
  failed: boolean;
  onChanged: (v: BoardPaceView) => void;
  /** o painel abriu: quem lê o ritmo relê na hora. */
  onOpen?: () => void;
  /** condutores trabalhando de fato agora. */
  agentsUsed: number;
  /** vagas de condutor do board (`conductor.maxSessions`). */
  slots: number;
  /** o board usa condutor (há política de condutor ligada) — sem ela a pílula não fala de vagas. */
  hasConductor: boolean;
  className?: string;
}

export function KanbanPaceControl({ boardId, view, failed, onChanged, onOpen, agentsUsed, slots, hasConductor, className }: KanbanPaceControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const [pending, start] = useTransition();
  const [pausing, setPausing] = useState(false);
  const [mode, setMode] = useState<PauseMode>("drain");
  const [duration, setDuration] = useState<(typeof PAUSE_DURATIONS)[number]["id"]>("none");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // as vagas que o operador acabou de gravar valem até a página reler a config
  const [slotsOverride, setSlotsOverride] = useState<number | null>(null);
  useEffect(() => setSlotsOverride(null), [slots]);
  const shownSlots = slotsOverride ?? slots;

  useEffect(() => {
    if (!open) {
      setPausing(false);
      setNote(null);
    }
  }, [open]);

  const disarmed = view?.source === "disarmed";
  const organize = view?.source === "organize-only";
  const unreadable = view?.source === "unreadable";
  const paused = view?.level === "paused" && !disarmed && !organize;
  // O escopo é configurável também num board desligado (vale quando ele for ligado); a FRASE «pode começar…» da linha
  // de estado é que só existe com o board ligado — desligado, ele não começa nada.
  const showScope = !!view && !unreadable && !organize;
  const scopeSentence = showScope && !disarmed;

  // A recusa nunca some: vinda do botão ⏸/▶ (painel fechado), ela ABRE o painel para a frase aparecer.
  const say = (r: { ok: true; data: { message: string } } | { ok: false; error: string }) => {
    setNote(r.ok ? { tone: "ok", text: r.data.message } : { tone: "error", text: r.error });
    if (!r.ok) setOpen(true);
  };
  const fail = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) });

  const apply = (level: PaceLevel, extra: { mode?: PauseMode; forMinutes?: number; reason?: string; arm?: boolean } = {}) =>
    start(async () => {
      setNote(null);
      const r = await setBoardPaceAction({ boardId, level, ...extra }).catch(fail);
      if (r.ok) {
        onChanged(r.data.pace);
        setPausing(false);
        setReason("");
      }
      say(r);
    });

  /** Ligar um board desligado dispara agentes sozinhos e gasta cota: só com confirmação (a regra do chip antigo). */
  const armOrApply = (level: PaceLevel) => {
    if (disarmed) {
      const yes = window.confirm(PACE_ARM_CONFIRM);
      if (!yes) return;
      return apply(level, { arm: true });
    }
    apply(level);
  };

  const chooseLevel = (level: PaceLevel) => {
    if (level === "paused") {
      if (paused) return;
      return setPausing((p) => !p);
    }
    setPausing(false);
    armOrApply(level);
  };

  /** O botão ⏸/▶ da pílula: pausa deixando terminar o que já roda, ou retoma. */
  const quickToggle = () => {
    if (!view || organize || unreadable) return;
    if (paused) return apply("normal");
    if (disarmed) return armOrApply("normal");
    apply("paused", { mode: "drain" });
  };

  const applyScope = (preset: "all" | "fixes") =>
    start(async () => {
      setNote(null);
      const r = await setBoardScopeAction({ boardId, preset }).catch(fail);
      if (r.ok) onChanged(r.data.pace);
      say(r);
    });

  const applySlots = (n: number) => {
    if (n === shownSlots) return;
    start(async () => {
      setNote(null);
      const r = await setConductorSlotsAction({ boardId, slots: n }).catch(fail);
      if (r.ok) setSlotsOverride(r.data.slots);
      say(r);
    });
  };

  // O modo «só organização» é do OPERADOR (a action recusa agente e serviço): confirma o efeito antes de mudar.
  const toggleOrganize = (on: boolean) => {
    if (!window.confirm(on ? ORGANIZE_ONLY_CONFIRM_ON : ORGANIZE_ONLY_CONFIRM_OFF)) return;
    start(async () => {
      setNote(null);
      const r = await setOrganizeOnlyAction({ boardId, on }).catch(fail);
      if (r.ok) {
        onChanged(r.data.pace);
        setPausing(false);
      }
      say(r);
    });
  };

  const face = paceRunningFace(view, failed);
  const quickDisabled = !view || organize || unreadable || pending;
  const quickTitle = !view ? "Lendo o ritmo do board" : organize ? "Board só de organização: nada roda sozinho" : paused ? "Retomar o board" : disarmed ? "Ligar o board" : "Pausar o board (o que já roda termina)";
  const scopePreset = view?.scope?.preset ?? "all";
  const waitingWords = view ? scopeWaitingWords(view) : null;

  return (
    <div ref={ref} className={cn("relative flex-none", className)}>
      <div className="flex h-10 items-stretch overflow-hidden rounded-lg border border-line md:h-8">
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            if (!open) onOpen?.();
          }}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Ritmo, condutores e escopo do board"
          className={cn(
            "flex items-center gap-1.5 px-2.5 text-[13px] text-fg transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
            open ? "bg-surface-hover" : "bg-surface",
          )}
        >
          <b className={cn("font-semibold", !view && "text-fg-subtle")}>{face}</b>
          {hasConductor && (
            <>
              <span aria-hidden className="text-line-emphasis">·</span>
              <span className="tabular-nums text-fg-muted" title="Condutores trabalhando agora / vagas de condutor">
                {agentsUsed}/{shownSlots}
                <span className="hidden sm:inline"> {shownSlots === 1 ? "condutor" : "condutores"}</span>
              </span>
            </>
          )}
          <ChevronDown className="h-3 w-3 text-fg-subtle" aria-hidden />
        </button>
        <button
          type="button"
          onClick={quickToggle}
          disabled={quickDisabled}
          title={quickTitle}
          aria-label={quickTitle}
          className={cn(
            "flex w-10 items-center justify-center border-l border-line-muted text-fg transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-default disabled:opacity-50 md:w-[34px]",
            paused ? "bg-surface-hover" : "bg-surface",
          )}
        >
          {paused || disarmed ? <PlayGlyph /> : <PauseGlyph />}
        </button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="Ritmo do board"
          className="absolute left-0 top-full z-40 mt-1.5 flex max-h-[min(640px,calc(100dvh-var(--ah-topbar-h,52px)-var(--jido-composer-h,0px)-60px))] w-[min(340px,calc(100vw-32px))] flex-col gap-3.5 overflow-y-auto rounded-xl border border-line bg-surface p-3.5 shadow-[0_14px_36px_rgba(15,15,15,.16)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-semibold text-fg">Ritmo do board</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" title="Fechar" className="flex h-10 w-10 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:h-6 md:w-6">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          {!view ? (
            <p className={HELP}>{failed ? PACE_PANEL_UNAVAILABLE : PACE_PANEL_LOADING}</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <p className="text-[13px] leading-snug text-fg">
                  {withStop(paceStatusLine(view, Date.now()))}
                  {scopeSentence && ` ${scopeSentenceWords(scopePreset, paused)}`}
                </p>
                {view.reason && !pausing && <p className={HELP}>Motivo: {view.reason}</p>}
                {view.waiting > 0 && !pausing && (
                  <p className={HELP}>
                    A pausa segurou {view.waiting} {view.waiting === 1 ? "pedido de trabalho" : "pedidos de trabalho"}; eles voltam quando você retomar.
                  </p>
                )}
                {!organize && (
                  <div className="flex gap-1.5" role="group" aria-label="Ritmo do board">
                    {LEVELS.map((l) => {
                      const on = pausing ? l.id === "paused" : !disarmed && view.level === l.id;
                      return (
                        <button key={l.id} type="button" disabled={pending} aria-pressed={on} title={PACE_HELP[l.id]} onClick={() => chooseLevel(l.id)} className={cn(OPT, OPT_PACE, on ? OPT_ON : OPT_OFF)}>
                          {l.glyph === "play" ? <PlayGlyph /> : l.glyph === "pause" ? <PauseGlyph /> : null}
                          {disarmed && l.id === "normal" ? "Ligar" : l.label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {(paused || pausing) && (
                  <div className="mt-1 flex flex-col gap-1.5">
                    <span className={SECTION}>O que já está rodando</span>
                    <div className="flex gap-1.5">
                      {MODES.map((m) => {
                        const on = pausing ? mode === m.id : (view.mode ?? "drain") === m.id;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            disabled={pending}
                            aria-pressed={on}
                            title={m.help}
                            onClick={() => (pausing ? setMode(m.id) : !on && apply("paused", { mode: m.id }))}
                            className={cn(OPT, on ? OPT_ON : OPT_OFF)}
                          >
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                    <span className={HELP}>{MODES.find((m) => m.id === (pausing ? mode : (view.mode ?? "drain")))?.help}</span>
                  </div>
                )}
                {pausing && (
                  <div className="flex flex-col gap-1.5">
                    <span className={SECTION}>Por quanto tempo</span>
                    <div className="flex gap-1.5">
                      {PAUSE_DURATIONS.map((d) => (
                        <button key={d.id} type="button" aria-pressed={duration === d.id} onClick={() => setDuration(d.id)} className={cn(OPT, duration === d.id ? OPT_ON : OPT_OFF)}>
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
                      className="h-10 w-full rounded-lg border border-line bg-surface px-2 text-[16px] text-fg placeholder:text-fg-subtle focus:border-line-emphasis focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:h-8 md:text-[12px]"
                    />
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => apply("paused", { mode, forMinutes: pauseMinutes(duration, new Date()), reason: reason.trim() || undefined })}
                      className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-fg px-2 text-[12px] font-semibold text-surface transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 md:h-8"
                    >
                      {pending ? "Pausando…" : "Pausar o board"}
                    </button>
                  </div>
                )}
              </div>

              {hasConductor && !pausing && (
                <div className="flex flex-col gap-1.5">
                  <span className={SECTION}>Condutores ao mesmo tempo</span>
                  <div className="flex gap-1.5" role="group" aria-label="Condutores ao mesmo tempo">
                    {[1, 2].map((n) => (
                      <button key={n} type="button" disabled={pending} aria-pressed={shownSlots === n} onClick={() => applySlots(n)} className={cn(OPT, shownSlots === n ? OPT_ON : OPT_OFF)}>
                        {n === 1 ? "1 condutor" : "2 condutores"}
                      </button>
                    ))}
                  </div>
                  <span className={HELP}>Cada condutor leva uma funcionalidade e gasta cota. Execuções de coluna e auxiliares não ocupam vaga.</span>
                </div>
              )}

              {showScope && !pausing && (
                <div className="flex flex-col gap-1.5">
                  <span className={SECTION}>O que o board pode começar sozinho</span>
                  <div className="flex gap-1.5" role="group" aria-label="O que o board pode começar sozinho">
                    {SCOPE_PRESETS.map((p) => (
                      <button key={p.id} type="button" disabled={pending} aria-pressed={scopePreset === p.id} title={p.help} onClick={() => scopePreset !== p.id && applyScope(p.id)} className={cn(OPT, scopePreset === p.id ? OPT_ON : OPT_OFF)}>
                        {SCOPE_SHORT[p.id] ?? p.label}
                      </button>
                    ))}
                  </div>
                  {waitingWords && <span className="text-[12px] leading-snug text-fg-muted">{waitingWords}.</span>}
                  <span className={HELP}>O escopo não poupa cota: só limita o tipo de trabalho novo.</span>
                </div>
              )}

              {view.suggestion && !pausing && (
                <div className="flex flex-col gap-1.5 border-t border-surface-hover pt-3">
                  <span className="text-[12px] leading-snug text-fg-muted">A cota está acima do ritmo: {view.suggestion.why}.</span>
                  <button type="button" disabled={pending} onClick={() => apply(view.suggestion!.level)} className={cn(OPT, OPT_OFF, "w-full flex-none")}>
                    Andar {paceLabel(view.suggestion.level).toLowerCase()}
                  </button>
                </div>
              )}

              {!pausing && !unreadable && (
                <div className="flex flex-col gap-1.5 border-t border-surface-hover pt-3">
                  <button type="button" disabled={pending} onClick={() => toggleOrganize(!organize)} className={cn(OPT, OPT_OFF, "w-full flex-none font-medium")}>
                    {organize ? ORGANIZE_ONLY_TURN_OFF : ORGANIZE_ONLY_TURN_ON}
                  </button>
                  {!organize && <span className={HELP}>{ORGANIZE_ONLY_TURN_ON_HELP}</span>}
                </div>
              )}
            </>
          )}

          {note && (
            <p role="status" className={cn("text-[12px] leading-snug", note.tone === "error" ? "text-danger" : "text-fg-muted")}>
              {note.text}
            </p>
          )}
        </div>
      )}
      {/* o clique da pílula (fora do painel) também anuncia o resultado */}
      {!open && note && (
        <span role="status" className="sr-only">
          {note.text}
        </span>
      )}
    </div>
  );
}
