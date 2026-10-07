"use client";

// O CONTROLE ÚNICO DE AUTONOMIA — «o que os agentes fazem sozinhos neste board», num lugar só.
//
// Um painel, DUAS portas, nenhuma outra tela configura autonomia:
//   • a pílula «Autonomia: Máxima» na barra do topo, à esquerda do anel da cota (no celular as barras do NÍVEL e a palavra curta: «Máx»);
//   • a seção no TOPO do menu da engrenagem (`SettingsMenu`): o nível atual e os dois modos prontos, e «Ajustar caixa a
//     caixa» abre o MESMO painel da pílula.
//
// O painel (360px; folha de baixo no celular): os dois modos prontos (Mínima / Máxima — «Personalizada» quando as
// caixas não batem com nenhum), as caixas com o efeito em uma linha e o motivo de a caixa estar travada (deploy exige
// publicar; publicar exige aprovar a entrega), e a lista TRAVADA do que é sempre do dono. Mudar salva NA HORA (uma
// ação de servidor, só a sessão do operador — agente nunca muda autonomia), com o recibo e «Desfazer».
//
// Saíram, e não voltam: o seletor Chat / Copiloto / Autônomo do Jido (configuração e compositor), o editor da matriz de
// risco, o selo «ultra / humano» do card e a tecnologia por card no formulário. A regra (o perfil, as dependências, o
// recibo, a lista do dono) mora em `lib/storymap/autonomy-profile.ts` — esta tela só a desenha.

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ChevronRight, Loader2, Lock, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { getBoardAutonomyAction, setBoardAutonomyAction, type AutonomyUndo } from "@/app/board-autonomy-actions";
import {
  ALWAYS_OWNER_NOTE,
  AUTONOMY_BOXES,
  PRESET_LABEL,
  alwaysOwnerPoints,
  autonomyProfileOf,
  dependencyBlock,
  hasExplicitProfile,
  presetGapWords,
  profileConflicts,
  shownPresetOf,
  type AgentDecidesKey,
  type AlwaysOwnerPoint,
  type AutonomyPreset,
  type AutonomyProfile,
} from "@/lib/storymap/autonomy-profile";
import type { BoardConfig } from "@/lib/storymap/types";
import { useHoverPopover } from "@/components/nav/NavShell";
import { appBarIconButton, appBarPopover } from "@/components/shell/app-bar-shell";
import { autonomyPillWords } from "@/components/shell/autonomy-pill-words";

/** Os dois modos prontos, como o dono os lê (a régua de cada um mora em autonomy-profile.ts). */
const PRESETS: ReadonlyArray<{ id: Exclude<AutonomyPreset, "personalizada">; hint: string }> = [
  { id: "minima", hint: "Você aprova cada passo; os agentes trabalham e param para perguntar." },
  { id: "maxima", hint: "Os agentes decidem o técnico, aprovam, publicam e fazem deploy; você só decide o que é seu." },
];

// ── o estado compartilhado pelas duas portas ────────────────────────────────────────────────────────────────────────

/** O evento que ABRE o painel da pílula (a porta da engrenagem o dispara). */
const OPEN_EVENT = "ah:autonomy-open";
/** O evento de «a autonomia deste board mudou» — a outra porta relê. `detail` = o boardId. */
const CHANGED_EVENT = "ah:autonomy-changed";

/** Abre o painel de autonomia (a pílula da barra o escuta). */
export function openAutonomyPanel(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

interface AutonomyView {
  profile: AutonomyProfile;
  /** o board já gravou pelo painel (o perfil é o bloco explícito) — senão é o legado (presetOf). */
  explicit: boolean;
  /** caixas ligadas sem a pré-requisito (board legado): o painel mostra, o dono escolhe. */
  conflicts: string[];
  alwaysOwner: AlwaysOwnerPoint[];
}

/** O recibo da última mudança, com a foto EXATA de antes (o «Desfazer» a devolve, sem propagar nada). */
interface Receipt {
  text: string;
  undo: AutonomyUndo | null;
}

/**
 * O perfil do board e a escrita. O primeiro quadro sai da configuração que a página já tem (sem pulo na barra); a
 * leitura do servidor completa o que só ele sabe (o legado do teto de gasto vem do settings.yaml). Uma mudança feita
 * por uma porta avisa a outra.
 */
function useBoardAutonomy(config: BoardConfig) {
  const router = useRouter();
  const boardId = config.id;
  const [view, setView] = useState<AutonomyView>(() => {
    const profile = autonomyProfileOf(config);
    return { profile, explicit: hasExplicitProfile(config), conflicts: profileConflicts(profile), alwaysOwner: alwaysOwnerPoints(config) };
  });
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<AutonomyView | null> => {
    try {
      const r = await getBoardAutonomyAction(boardId);
      if (!r.ok) return null;
      const next = { profile: r.data.profile, explicit: r.data.explicit, conflicts: r.data.conflicts, alwaysOwner: r.data.alwaysOwner };
      setView(next);
      return next;
    } catch {
      return null;
    }
  }, [boardId]);

  useEffect(() => {
    void reload();
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === boardId) void reload();
    };
    window.addEventListener(CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CHANGED_EVENT, onChanged);
  }, [boardId, reload]);

  const change = useCallback(
    async (input: { preset?: Exclude<AutonomyPreset, "personalizada">; patch?: Partial<AutonomyProfile>; restore?: AutonomyUndo }, undo = false) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        // a escrita devolve o perfil NOVO, a foto de ANTES (o «Desfazer») e o recibo, já em palavras
        const res = await setBoardAutonomyAction({ boardId, ...input });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const { profile, explicit, conflicts, alwaysOwner, undo: undoTo, receipt: text, changed } = res.data;
        setView({ profile, explicit, conflicts, alwaysOwner });
        setReceipt({ text: undo ? `Desfeito. ${text}` : text, undo: undo || !changed ? null : undoTo });
        if (changed) {
          window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: boardId }));
          // as telas que leem a configuração (o Kanban, a Entrega) acompanham — numa transição, que mantém a tela de
          // antes até a nova chegar (nada pisca vazio no meio)
          startTransition(() => router.refresh());
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Não foi possível salvar a autonomia.");
      } finally {
        setBusy(false);
      }
    },
    [boardId, busy, router],
  );

  // desfazer = devolver as chaves EXATAMENTE como estavam (a foto do servidor) — nunca reaplicar o perfil de antes como
  // mudança: as dependências de cada caixa ligariam o que o dono nunca ligou
  const undo = useCallback(() => {
    const to = receipt?.undo;
    if (to) void change({ restore: to }, true);
  }, [change, receipt]);

  const clearReceipt = useCallback(() => {
    setReceipt(null);
    setError(null);
  }, []);

  // o nível que a tela mostra conta TODA caixa: «Máxima» com a Sentinela desligada é «Personalizada» (e `gap` diz
  // «Máxima, sem a Sentinela») — nunca um «Máxima ✓» que o dono leria como tudo ligado
  return { view, preset: shownPresetOf(view.profile), gap: presetGapWords(view.profile), busy, receipt, error, change, undo, clearReceipt };
}

type AutonomyState = ReturnType<typeof useBoardAutonomy>;

// ── o ícone do NÍVEL ────────────────────────────────────────────────────────────────────────────────────────────────

/** Três barras: uma acesa em Mínima, duas em Personalizada, três em Máxima. */
function LevelIcon({ preset, className }: { preset: AutonomyPreset; className?: string }) {
  const lit = preset === "maxima" ? 3 : preset === "personalizada" ? 2 : 1;
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className={cn("block shrink-0", className)}>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1 + i * 4.5}
          y={9 - i * 3.5}
          width="3"
          height={4 + i * 3.5}
          rx="1"
          fill={i < lit ? "currentColor" : "rgb(var(--line-emphasis))"}
        />
      ))}
    </svg>
  );
}

// ── as peças do painel (as duas portas usam as MESMAS) ─────────────────────────────────────────────────────────────

/** Os dois modos prontos. `compact` = a versão da engrenagem (itens de menu, sem a descrição longa). */
function PresetButtons({ state, compact = false }: { state: AutonomyState; compact?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2" role={compact ? undefined : "radiogroup"} aria-label={compact ? undefined : "Modo pronto"}>
      {PRESETS.map((p) => {
        const active = state.preset === p.id;
        return (
          <button
            key={p.id}
            type="button"
            role={compact ? "menuitemradio" : "radio"}
            data-menuitem={compact ? true : undefined}
            aria-checked={active}
            disabled={state.busy}
            title={p.hint}
            onClick={() => !active && void state.change({ preset: p.id })}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-lg border text-left transition disabled:cursor-wait",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-fg",
              compact ? "min-h-10 px-2.5 py-1.5" : "min-h-[76px] px-3 py-2.5",
              active ? "border-fg bg-inset ring-1 ring-fg" : "border-line hover:bg-inset",
            )}
          >
            <span className="flex w-full items-center gap-1.5 text-[13px] font-semibold text-fg-strong">
              <LevelIcon preset={p.id} />
              {PRESET_LABEL[p.id]}
              {active && <Check className="ml-auto h-3.5 w-3.5 text-fg" aria-hidden />}
            </span>
            {!compact && <span className="text-[12px] leading-snug text-fg-muted">{p.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * O recibo da última mudança (com «Desfazer») ou o erro — o retorno da escrita, nas duas portas. `sticky` = o rodapé
 * GRUDADO do painel: no celular a folha rola, e o recibo de uma caixa lá de baixo ficaria fora da vista no topo.
 */
function SaveFeedback({ state, sticky = false }: { state: AutonomyState; sticky?: boolean }) {
  const wrap = sticky ? "sticky bottom-0 z-10 -mx-1 bg-surface px-1 pb-0.5 pt-1.5" : "";
  if (state.error) {
    return (
      <div className={wrap}>
        <p role="alert" className="rounded-md bg-danger/10 px-2.5 py-1.5 text-[12px] leading-snug text-danger">
          {state.error}
        </p>
      </div>
    );
  }
  if (!state.receipt) return null;
  return (
    <div className={wrap}>
    <p role="status" className="flex items-start gap-2 rounded-md bg-inset px-2.5 py-1.5 text-[12px] leading-snug text-fg shadow-[0_-6px_12px_rgb(var(--surface))]">
      <span className="min-w-0 flex-1">{state.receipt.text}</span>
      {state.receipt.undo && (
        <button
          type="button"
          onClick={state.undo}
          disabled={state.busy}
          className="shrink-0 font-semibold text-fg-strong underline underline-offset-2 hover:text-fg-muted disabled:opacity-50"
        >
          Desfazer
        </button>
      )}
    </p>
    </div>
  );
}

/** Uma caixa: o rótulo, o efeito em uma linha e — travada — o motivo. */
function Box({ state, k }: { state: AutonomyState; k: AgentDecidesKey }) {
  const meta = AUTONOMY_BOXES.find((b) => b.key === k);
  if (!meta) return null;
  const on = state.view.profile[k] === true;
  // «em breve»: a caixa existe, mas nada a lê ainda — travada, sem prometer efeito
  const blocked = meta.soon ? "em breve" : on ? null : dependencyBlock(state.view.profile, k);
  const id = `ah-autonomy-${k}`;
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-1.5 py-1.5 transition",
        blocked ? "cursor-not-allowed" : "cursor-pointer hover:bg-inset",
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={on}
        disabled={state.busy || blocked !== null}
        onChange={(e) => void state.change({ patch: { [k]: e.target.checked } })}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[rgb(var(--fg))] disabled:cursor-not-allowed"
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13px] font-medium leading-snug", blocked ? "text-fg-subtle" : "text-fg")}>{meta.label}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-fg-muted">{meta.soon ? "Em breve." : blocked ? `Travada: ${blocked}.` : meta.effect}</span>
      </span>
    </label>
  );
}

/** O PAINEL «Autonomia do board» — o mesmo nas duas portas. */
export function AutonomyPanel({ state, onClose }: { state: AutonomyState; onClose?: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[14px] font-semibold text-fg">
          Autonomia do board
          <span className="ml-1.5 font-normal text-fg-muted">· {PRESET_LABEL[state.preset]}</span>
        </span>
        {state.busy && <Loader2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle motion-safe:animate-spin" aria-label="Salvando" />}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Fechar (Esc)"
            aria-label="Fechar o painel de autonomia"
            className="-mr-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-fg-muted transition hover:bg-inset hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg md:h-7 md:w-7"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>

      <PresetButtons state={state} />
      {state.preset === "personalizada" && (
        <p className="-mt-1 text-[12px] leading-snug text-fg-muted">
          <span className="font-semibold text-fg">Personalizada</span> —{" "}
          {state.gap ? `${state.gap}.` : "as caixas abaixo não batem com nenhum dos dois modos."}
        </p>
      )}
      {state.view.conflicts.length > 0 && (
        <div role="note" className="flex items-start gap-2 rounded-md bg-st-attn/10 px-2.5 py-1.5 text-[12px] leading-snug text-fg">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-st-attn-ink" aria-hidden />
          <span className="min-w-0 flex-1">{state.view.conflicts.join(" ")}</span>
        </div>
      )}

      <section aria-labelledby="ah-autonomy-boxes" className="flex flex-col gap-0.5 border-t border-line-muted pt-2.5">
        <h3 id="ah-autonomy-boxes" className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-fg-subtle">
          O que os agentes podem fazer sozinhos
        </h3>
        {AUTONOMY_BOXES.map((b) => (
          <Box key={b.key} state={state} k={b.key} />
        ))}
      </section>

      <section aria-labelledby="ah-autonomy-owner" className="flex flex-col gap-1.5 border-t border-line-muted pt-2.5">
        <h3 id="ah-autonomy-owner" className="text-[12px] font-semibold uppercase tracking-wide text-fg-subtle">
          Sempre seus, em qualquer modo
        </h3>
        <p className="text-[12px] leading-snug text-fg-muted">{ALWAYS_OWNER_NOTE}</p>
        {/* UMA linha por item: o rótulo e a frase curta; a explicação inteira fica no `title` */}
        <ul className="flex flex-col gap-1">
          {state.view.alwaysOwner.map((p) => (
            <li key={p.id} title={p.long ?? p.detail} className="flex items-start gap-2 text-[12.5px] leading-snug">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden />
              <span className="min-w-0">
                <span className="font-medium text-fg">{p.label}</span>
                {p.detail && <span className="text-fg-muted"> — {p.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <SaveFeedback state={state} sticky />
    </div>
  );
}

// ── porta 1: a pílula da barra do topo ─────────────────────────────────────────────────────────────────────────────

/** A pílula «Autonomia: Máxima» (no celular, as barras e «Máx» / «Mín» / «Pers.») e o painel que ela abre. */
export function AutonomyPill({ config }: { config: BoardConfig }) {
  const state = useBoardAutonomy(config);
  const { open, setOpen, ref } = useHoverPopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const words = autonomyPillWords(state.preset, state.gap);

  // a porta da engrenagem abre ESTE painel
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [setOpen]);

  // o recibo é da sessão do painel: fechou, some
  const { clearReceipt } = state;
  useEffect(() => {
    if (!open) clearReceipt();
  }, [open, clearReceipt]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={ref} className="relative flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={words.title}
        aria-label={words.ariaLabel}
        className={cn(appBarIconButton, "max-md:gap-0.5 max-md:px-1 md:px-2", open && "bg-surface-hover text-fg")}
      >
        <LevelIcon preset={state.preset} className="max-md:h-3 max-md:w-3" />
        {/* celular: a palavra curta (Máx/Mín/Pers.); abaixo de 360px, só as barras */}
        <span aria-hidden className="whitespace-nowrap text-[11px] font-semibold leading-none text-fg max-[359px]:hidden md:hidden">
          {words.short}
        </span>
        <span className="hidden whitespace-nowrap text-[12px] md:inline">
          Autonomia: <span className="font-medium text-fg">{PRESET_LABEL[state.preset]}</span>
        </span>
      </button>

      {open && (
        <>
          {/* no celular o painel é uma FOLHA de baixo, com um véu (tocar fora fecha) */}
          <div aria-hidden className="fixed inset-0 z-[69] bg-fg/20 md:hidden" onClick={close} />
          <div
            role="dialog"
            aria-label="Autonomia do board"
            className={cn(
              appBarPopover,
              "fixed inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-b-none rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]",
              // no computador, preso à borda DIREITA da barra (52px + 6), não à pílula — senão ele pendia para a esquerda,
              // por cima dos controles da segunda barra
              "md:inset-x-auto md:bottom-auto md:right-4 md:top-[58px] md:max-h-[calc(100dvh-72px)] md:w-[360px] md:rounded-[10px] md:p-3.5",
            )}
          >
            <AutonomyPanel state={state} onClose={close} />
          </div>
        </>
      )}
    </div>
  );
}

// ── porta 2: a seção no topo da engrenagem ─────────────────────────────────────────────────────────────────────────

/**
 * A seção de autonomia no TOPO do menu da engrenagem: o nível, os dois modos prontos e «Ajustar caixa a caixa», que
 * fecha o menu e abre o painel da pílula — o mesmo painel, outra porta.
 */
export function AutonomyMenuSection({ config, onOpenPanel }: { config: BoardConfig; onOpenPanel: () => void }) {
  const state = useBoardAutonomy(config);
  const custom = state.preset === "personalizada";
  return (
    <section aria-label="Autonomia do board" className="mb-1.5 flex flex-col gap-1.5 border-b border-line-muted px-1 pb-2.5 pt-1">
      <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-fg-subtle">
        Autonomia
        <span className="font-semibold normal-case tracking-normal text-fg">· {PRESET_LABEL[state.preset]}</span>
        {state.busy && <Loader2 className="h-3 w-3 text-fg-subtle motion-safe:animate-spin" aria-label="Salvando" />}
      </span>
      <PresetButtons state={state} compact />
      <SaveFeedback state={state} />
      {/* «Personalizada» é o terceiro estado: marcado AQUI, com o mesmo realce do modo pronto ativo */}
      <button
        type="button"
        role="menuitem"
        data-menuitem
        aria-current={custom ? "true" : undefined}
        onClick={() => {
          onOpenPanel();
          openAutonomyPanel();
        }}
        className={cn(
          "flex min-h-10 items-center gap-1.5 rounded-md border px-1.5 text-left text-[13px] transition hover:bg-inset hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg md:min-h-8",
          custom ? "border-fg bg-inset font-semibold text-fg-strong" : "border-transparent text-fg-muted",
        )}
      >
        {custom && <LevelIcon preset="personalizada" />}
        <span className="min-w-0 flex-1">
          {custom ? (state.gap ? `Personalizada: ${state.gap}` : "Personalizada — ajustar caixa a caixa") : "Ajustar caixa a caixa"}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
    </section>
  );
}
