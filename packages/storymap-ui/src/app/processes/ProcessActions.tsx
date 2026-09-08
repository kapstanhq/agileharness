"use client";

// The contextual action cluster for ONE RunningService — shared by the Processos list
// rows and the [id] detail page (both render inside processes/layout, so the runner
// console + toasts are available). Each button maps to a server action from
// @/app/actions and toasts its Result; the terminal handoff navigates via a PLAIN
// window.location (the /terminal route is served by Caddy, not Next — a <Link> 404s).

import { useState } from "react";
import { ExternalLink, Loader2, RotateCcw, SquareTerminal, Trash2, Unlock } from "lucide-react";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/Toast";
import { InlineConfirm } from "@/components/InlineConfirm";
import { useRunnerSnapshot } from "@/components/RunnerStatusProvider";
import {
  forceReleaseRunAction,
  killProcessAction,
  killTmuxSessionAction,
  resumeRunInTerminalAction,
  runCardSkillAction,
} from "@/app/actions";
import type { RunningService } from "@/lib/vps/types";
import { serviceEscalation } from "@/lib/storymap/copilot/process-escalation";
import { EscalateButton } from "@/components/copilot/EscalateButton";

/** A plain <a> deep-link to the web terminal (Caddy-served, NOT Next routing). */
function terminalHref(tmuxSession: string): string {
  return `/terminal?b=${encodeURIComponent(tmuxSession)}`;
}

export function ProcessActions({
  service,
  size = "sm",
  onChanged,
}: {
  service: RunningService;
  /** "sm" = compact buttons for list rows; "md" = roomier for the detail page. */
  size?: "sm" | "md";
  /** called after an action that mutates the box state (e.g. Encerrar) → re-poll. */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const { openConsole } = useRunnerSnapshot();
  // One pending flag per logical action so a slow resume doesn't freeze the whole cluster.
  const [pending, setPending] = useState<string | null>(null);
  /** qual ação destrutiva está ARMADA — a faixa de confirmação toma o lugar do cluster de botões. */
  const [armed, setArmed] = useState<"kill" | "killproc" | null>(null);

  const { kind, status, board, cardId, tmuxSession, attachable, pid } = service;
  const isRun = kind === "runner-run";
  const hasCard = !!(board && cardId);

  const btn =
    size === "md"
      ? "inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium transition disabled:opacity-40"
      : "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium transition disabled:opacity-40";
  const icon = size === "md" ? "h-3.5 w-3.5" : "h-3 w-3";

  const run = async (key: string, fn: () => Promise<void>) => {
    if (pending) return;
    setPending(key);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  // R4 "Console" — pop the live read-only console modal (runner runs only).
  const onConsole = () => {
    if (hasCard) openConsole(board!, cardId!);
  };

  // R4 "Abrir terminal" — attach to an existing tmux session, or first materialize one
  // for a headless run (claude --resume in tmux) then navigate.
  const onTerminal = () =>
    run("terminal", async () => {
      // Open the (Caddy/ttyd) web terminal in a NEW TAB so the operator keeps the AgileHarness open
      // — instead of navigating away from the SPA.
      if (tmuxSession) {
        window.open(terminalHref(tmuxSession), "_blank", "noopener");
        return;
      }
      if (!hasCard) return;
      const res = await resumeRunInTerminalAction({ boardId: board!, cardId: cardId! });
      if (res.ok && res.data) {
        window.open(terminalHref(res.data.tmuxSession), "_blank", "noopener");
      } else if (!res.ok) {
        toast(res.error);
      }
    });

  // R1 "Retomar" — re-run the card's current-column skill (interrupted/failed runs whose
  // card still sits in its trigger column).
  const onResume = () =>
    run("resume", async () => {
      if (!hasCard) return;
      const res = await runCardSkillAction({ boardId: board!, cardId: cardId! });
      if (res.ok) toast(`Retomando ${res.data?.trigger ?? "skill"} neste card…`, "success");
      else toast(res.error);
    });

  // R1 "Liberar" — force-release a stuck/queued in-flight run.
  const onRelease = () =>
    run("release", async () => {
      if (!hasCard) return;
      const res = await forceReleaseRunAction({ boardId: board!, cardId: cardId! });
      if (res.ok) toast(res.data?.note ?? "Run liberada.", "success");
      else toast(res.error);
    });

  // R4 "Encerrar" — kill an ad-hoc / card tmux session (master + shell are protected).
  // Passou a PERGUNTAR: este é o mesmo gesto que o bloco Terminais e a página do terminal confirmam, e
  // um encerrar sem pergunta ao lado de dois que perguntam é a inconsistência que ensina o operador a
  // não confiar em nenhum dos três.
  const onKill = () =>
    run("kill", async () => {
      if (!tmuxSession) return;
      setArmed(null);
      const res = await killTmuxSessionAction({ session: tmuxSession });
      if (res.ok) {
        toast("Sessão encerrada.", "success");
        onChanged?.();
      } else {
        toast(res.error);
      }
    });

  // R4 "Matar" — terminate a stray external `claude` process (pid). Confirma porque não há
  // resume/attach para um processo aberto na mão: matá-lo é o único cabo que temos nele.
  const onKillProc = () =>
    run("killproc", async () => {
      if (pid == null) return;
      setArmed(null);
      const res = await killProcessAction({ pid });
      if (res.ok) {
        toast(res.data?.note ?? "Processo encerrado.", "success");
        onChanged?.();
      } else {
        toast(res.error);
      }
    });

  const showConsole = isRun && hasCard;
  // Either attach to an existing tmux session, or (for a headless run with a card) offer
  // to materialize one on click. resumeRunInTerminalAction resolves the session id itself.
  const showTerminal = !!tmuxSession || (isRun && hasCard && attachable);
  const showResume = (status === "interrupted" || status === "failed") && hasCard;
  const showRelease = status === "running" && isRun && hasCard;

  // WS-4 §4.3 — the escalate sits between Retomar and Liberar: the diagnostic ALTERNATIVE to a
  // cega retry or a cego SIGTERM (run-death / run-inflight-stuck — 00-cenarios.md). null when
  // there's no board+card to land the drawer on (D14).
  const esc = serviceEscalation({ kind, status, board, cardId });
  const escalateLabel = esc?.ref.templateId === "run-death" ? "Copiloto: diagnosticar" : "Copiloto: está travado?";
  const showKill = (kind === "tmux-adhoc" || kind === "tmux-card" || kind === "tmux-copilot") && !!tmuxSession;
  const showKillProc = kind === "claude-external" && pid != null;

  const spin = (key: string) => pending === key;

  if (armed) {
    return (
      <div
        className={cn("flex flex-wrap items-center gap-1.5", size === "md" && "gap-2")}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Armada, a pergunta toma o lugar do cluster inteiro — nenhum outro botão fica clicável ao
            lado da confirmação de um encerramento. */}
        <InlineConfirm
          question={
            armed === "kill"
              ? `Encerrar a sessão ${tmuxSession}? O que estiver rodando dentro dela morre.`
              : `Encerrar o processo claude (pid ${pid})? Ele é morto imediatamente, e não há como retomá-lo.`
          }
          confirmLabel="encerrar"
          busy={!!pending}
          onConfirm={armed === "kill" ? onKill : onKillProc}
          onCancel={() => setArmed(null)}
        />
      </div>
    );
  }

  return (
    // Stop clicks here so the action cluster never triggers a parent row link (the list
    // row wraps the actions in a stretched-link layout; this keeps the buttons isolated).
    <div
      className={cn("flex flex-wrap items-center gap-1.5", size === "md" && "gap-2")}
      onClick={(e) => e.stopPropagation()}
    >
      {showConsole && (
        <button
          type="button"
          onClick={onConsole}
          title="Abrir o console ao vivo da run (read-only)"
          className={cn(btn, "text-fg-muted hover:bg-surface-hover hover:text-fg")}
        >
          <SquareTerminal className={icon} /> Console
        </button>
      )}

      {showTerminal &&
        (tmuxSession ? (
          <a
            href={terminalHref(tmuxSession)}
            target="_blank"
            rel="noopener"
            title="Abrir esta sessão no terminal web (nova aba)"
            className={cn(btn, "text-fg-muted hover:bg-surface-hover hover:text-fg")}
          >
            <ExternalLink className={icon} /> Abrir terminal
          </a>
        ) : (
          <button
            type="button"
            onClick={onTerminal}
            disabled={spin("terminal")}
            title="Materializar um terminal (claude --resume) e abri-lo"
            className={cn(btn, "text-fg-muted hover:bg-surface-hover hover:text-fg")}
          >
            {spin("terminal") ? <Loader2 className={cn(icon, "animate-spin")} /> : <ExternalLink className={icon} />}{" "}
            Abrir terminal
          </button>
        ))}

      {showResume && (
        <button
          type="button"
          onClick={onResume}
          disabled={spin("resume")}
          title="Re-rodar a skill da coluna atual deste card"
          className={cn(
            btn,
            "border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/40 dark:text-emerald-300 dark:hover:bg-emerald-500/10",
          )}
        >
          {spin("resume") ? <Loader2 className={cn(icon, "animate-spin")} /> : <RotateCcw className={icon} />} Retomar
        </button>
      )}

      {esc && <EscalateButton target={esc.ref} surface="processes" label={escalateLabel} size={size} />}

      {showRelease && (
        <button
          type="button"
          onClick={onRelease}
          disabled={spin("release")}
          title="Liberar/matar a run travada deste card"
          className={cn(
            btn,
            "border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10",
          )}
        >
          {spin("release") ? <Loader2 className={cn(icon, "animate-spin")} /> : <Unlock className={icon} />} Liberar
        </button>
      )}

      {showKill && (
        <button
          type="button"
          onClick={() => setArmed("kill")}
          disabled={spin("kill")}
          title="Encerrar esta sessão de terminal"
          className={cn(
            btn,
            "border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10",
          )}
        >
          {spin("kill") ? <Loader2 className={cn(icon, "animate-spin")} /> : <Trash2 className={icon} />} Encerrar
        </button>
      )}

      {showKillProc && (
        <button
          type="button"
          onClick={() => setArmed("killproc")}
          disabled={spin("killproc")}
          title="Matar este processo claude solto (pid)"
          className={cn(
            btn,
            "border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10",
          )}
        >
          {spin("killproc") ? <Loader2 className={cn(icon, "animate-spin")} /> : <Trash2 className={icon} />} Matar
        </button>
      )}
    </div>
  );
}
