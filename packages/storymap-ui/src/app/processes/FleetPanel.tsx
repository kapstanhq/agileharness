"use client";

// A FROTA em /processes: uma linha por AGENTE — "quem está fazendo o quê, onde, e alguém travou?".
//
// Reorganizada POR CICLO DE VIDA (não por tipo), a mesma doutrina da página: o que precisa de você primeiro,
// o que está trabalhando no meio, e o que já MORREU dobrado num fecho de limpeza. Antes esta lista mostrava
// TODA sessão registrada — inclusive as adotadas mortas há dias que o reaper de worktree nunca alcançava — e
// "Frota · 10" contava 8 zumbis, enterrando o único agente vivo. Agora o contador é honesto (só os ativos), e
// os mortos vão para "Encerrados", com um botão para varrê-los (o session-gc já os esquece sozinho no sweep;
// isto é o alívio imediato + o controle manual).
//
// ⚠️ Isto NÃO conta Claudes por identidade de processo (isso é a seção "Rodando"): lê o REGISTRO da frota
// (quem a ferramenta spawnou/adotou). As duas listas podem discordar — e a discordância é o sinal (um agente
// registrado sem processo = morto).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, GitBranch, Loader2, RotateCw, Trash2, Unlock, Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/Toast";
import { InlineConfirm } from "@/components/InlineConfirm";
import {
  discardSessionAction,
  killTmuxSessionAction,
  recycleSessionAction,
  releaseSessionClaimAction,
} from "@/app/actions";
import { inboxFocusHref } from "@/lib/storymap/deep-links";
import type { FleetRow } from "@/lib/storymap/runner/fleet-view";

const ROLE_META: Record<FleetRow["role"], { label: string; hex: string; hint: string }> = {
  implement: { label: "implementa", hex: "#3b82f6", hint: "escreve código no worktree próprio" },
  review: { label: "revisa", hex: "#8b5cf6", hint: "revisa código no worktree próprio" },
  triage: { label: "triagem", hex: "#14b8a6", hint: "mexe em board-data via MCP (sem árvore)" },
  steward: { label: "steward", hex: "#f59e0b", hint: "cuida da frota/board (sem árvore)" },
  free: { label: "livre", hex: "#64748b", hint: "trabalho aberto (self-dev) — tem árvore por precaução" },
};

/** ISO → "há 3m" / "há 2h" / "há 5d". A idade do heartbeat é o que diz se a linha é presente ou fóssil. */
function ago(iso: string, now: number): string {
  const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(secs)) return "?";
  if (secs < 60) return `há ${secs}s`;
  if (secs < 3600) return `há ${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `há ${Math.floor(secs / 3600)}h`;
  return `há ${Math.floor(secs / 86_400)}d`;
}

/** A row is DEAD when its process is provably gone (no live tmux) OR its heartbeat lapsed the TTL — the same
 *  predicate fleet-view uses. `processAlive === null` (no tmux handle) is NOT death on its own. */
function isDead(row: FleetRow): boolean {
  return row.processAlive === false || !row.alive;
}

function FleetRowItem({
  row,
  onChanged,
  compact = false,
}: {
  row: FleetRow;
  onChanged: () => void;
  /** archived (dead) rows render tighter and only offer "Descartar". */
  compact?: boolean;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  /** qual ação destrutiva está ARMADA nesta linha — a faixa de confirmação toma o lugar dos botões. */
  const [armed, setArmed] = useState<"release" | "kill" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const role = ROLE_META[row.role];
  const dead = isDead(row);
  const run = async (key: string, fn: () => Promise<void>) => {
    if (pending) return;
    setPending(key);
    try {
      await fn();
    } finally {
      setPending(null);
    }
  };

  const onRecycle = () =>
    run("recycle", async () => {
      const res = await recycleSessionAction({ sessionId: row.sessionId });
      if (res.ok) {
        toast(`Agente reciclado em ${res.data?.session} — árvore, branch e claim preservados.`, "success");
        onChanged();
      } else toast(res.error);
    });

  // As DUAS perguntas desta linha, escritas uma vez. O que elas dizem importa tanto quanto o gesto:
  // o claim é ADVISORY (claims.ts) — liberar devolve o CARD e não interrompe o agente, e um operador
  // que pense o contrário usaria isso como botão de pânico e estaria errado.
  const question =
    armed === "release"
      ? `Liberar o claim de ${row.board}/${row.cardId}? O agente ${row.agentId.slice(0, 8)} NÃO é interrompido — ` +
        `só o card volta a ficar disponível para outro. Fica registrado quem liberou.`
      : `Encerrar a sessão ${row.tmuxSession}? O processo morre agora; o worktree${row.branch ? ` ${row.branch}` : ""} é ` +
        `PRESERVADO (o trabalho não integrado é recuperável) e os claims caem na próxima varredura.`;

  const onRelease = () =>
    run("release", async () => {
      if (!row.board || !row.cardId) return;
      setArmed(null);
      const res = await releaseSessionClaimAction({ board: row.board, cardId: row.cardId, agentId: row.agentId, surface: "processes" });
      if (res.ok) {
        toast(res.data?.note ?? "Claim liberado.", "success");
        onChanged();
      } else toast(res.error);
    });

  const onKill = () =>
    run("kill", async () => {
      if (!row.tmuxSession) return;
      setArmed(null);
      const res = await killTmuxSessionAction({ session: row.tmuxSession });
      if (res.ok) {
        toast("Sessão encerrada — o worktree foi preservado.", "success");
        onChanged();
      } else toast(res.error);
    });

  const onDiscard = () =>
    run("discard", async () => {
      const res = await discardSessionAction({ sessionId: row.sessionId });
      if (res.ok) {
        toast(res.data?.detail ?? "Sessão descartada da frota.", "success");
        onChanged();
      } else toast(res.error);
    });

  const btn = "inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium transition disabled:opacity-40";
  const spin = (k: string) => pending === k;

  return (
    <li
      className={cn(
        "group rounded-lg border border-line bg-surface",
        compact ? "p-2.5" : "p-3",
        row.orphanedIntegration && "border-amber-400/70 bg-amber-50/40 dark:bg-amber-500/[0.06]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          title={role.hint}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{ backgroundColor: `${role.hex}1a`, color: role.hex }}
        >
          {role.label}
        </span>
        <span className="font-mono text-[11px] text-fg-subtle">{row.agentId.slice(0, 8)}</span>
        <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", dead ? "text-fg-muted" : "text-fg")}>
          {row.task}
        </span>
        {row.board && row.cardId && (
          <Link
            href={inboxFocusHref(row.board, row.cardId)}
            title="Abrir o card no Inbox"
            className="shrink-0 truncate rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-accent hover:underline"
          >
            {row.cardTitle ?? row.cardId}
          </Link>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-subtle">
        <span
          className={cn(
            "inline-flex items-center gap-1 font-medium",
            dead ? "text-rose-500" : "text-emerald-700 dark:text-emerald-400",
          )}
        >
          <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dead ? "bg-rose-500" : "bg-emerald-500")} />
          {dead ? "processo morto" : row.processAlive === null ? "sem tmux" : "vivo"}
        </span>
        <span>·</span>
        <span title={`heartbeat: ${row.heartbeatAt}`}>{ago(row.heartbeatAt, now)}</span>
        {row.model && (
          <>
            <span>·</span>
            <span>{row.model}</span>
          </>
        )}
        {row.contextPct != null && (
          <>
            <span>·</span>
            <span className={cn("tabular-nums", row.suggestRecycle && "font-semibold text-amber-700 dark:text-amber-400")}>
              {/* A leitura tem uma casa decimal e NÃO é clampada (26.1, 130.4); a linha arredonda para
                  exibir, como o cabeçalho do terminal — mas nunca corta o que passa de 100. */}
              contexto {Math.round(row.contextPct)}%
            </span>
          </>
        )}
        {row.claim && (
          <>
            <span>·</span>
            <span title={`claim ${row.claim.kind}/${row.claim.scope} até ${row.claim.expiresAt}`}>claim {row.claim.kind}</span>
          </>
        )}
        {row.train && (
          <>
            <span>·</span>
            <span title={row.train.pinnedSha ? `sha ${row.train.pinnedSha}` : undefined}>train: {row.train.status}</span>
          </>
        )}
        {row.branch && (
          <span className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
            <GitBranch className="h-3 w-3" />
            <span className="font-mono">{row.branch}</span>
          </span>
        )}
      </div>

      {/* The adoption debt line is noise on a DEAD row (it's leaving anyway) — only warn while it's live. */}
      {row.warning && !dead && (
        <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">⚠ {row.warning}</p>
      )}

      {/* Gap 1.3c — a demanda que NENHUMA superfície keyed-by-card podia mostrar. */}
      {row.orphanedIntegration && (
        <p className="mt-1.5 rounded bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="font-semibold">Integração órfã ({row.orphanedIntegration.status}):</span>{" "}
          {row.orphanedIntegration.detail}{" "}
          <span className="font-mono">{row.orphanedIntegration.branch}</span>
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* Armada, a pergunta OCUPA a barra de ações: some o que ela está confirmando, e não sobra um
            segundo botão destrutivo ao lado da confirmação do primeiro. */}
        {armed ? (
          <InlineConfirm
            question={question}
            confirmLabel={armed === "kill" ? "encerrar" : "liberar"}
            busy={!!pending}
            onConfirm={armed === "kill" ? onKill : onRelease}
            onCancel={() => setArmed(null)}
          />
        ) : (
          <>
        {row.tmuxSession && !compact && (
          <a
            href={`/terminal?b=${encodeURIComponent(row.tmuxSession)}`}
            target="_blank"
            rel="noopener"
            className={cn(btn, "text-fg-muted hover:bg-surface-hover hover:text-fg")}
          >
            Abrir terminal
          </a>
        )}
        {/* Uma sessão ADOTADA não tem árvore nem contrato nosso: reciclá-la criaria outro agente, não
            continuaria este (recycleSession recusa) — então a ação nem aparece. */}
        {!row.adopted && !dead && (
          <button
            type="button"
            onClick={onRecycle}
            disabled={spin("recycle")}
            title="Trocar o processo mantendo árvore, branch, card e claim (o agente continua o mesmo)"
            className={cn(
              btn,
              row.suggestRecycle
                ? "border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10"
                : "text-fg-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            {spin("recycle") ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />} Reciclar
          </button>
        )}
        {row.claim && !dead && (
          <button
            type="button"
            onClick={() => setArmed("release")}
            disabled={spin("release")}
            title="Devolver o card para a fila (advisory — não interrompe o agente)"
            className={cn(btn, "text-fg-muted hover:bg-surface-hover hover:text-fg")}
          >
            {spin("release") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />} Liberar claim
          </button>
        )}
        {row.tmuxSession && !dead && (
          <button
            type="button"
            onClick={() => setArmed("kill")}
            disabled={spin("kill")}
            className={cn(
              btn,
              "border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10",
            )}
          >
            {spin("kill") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Encerrar
          </button>
        )}
        {/* A dead row can only be forgotten — the fail-closed teardown preserves any committed branch work. */}
        {dead && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={spin("discard")}
            title="Esquecer a sessão da frota (um branch com trabalho não integrado é preservado)"
            className={cn(btn, "text-fg-subtle hover:border-line-emphasis hover:text-fg-muted")}
          >
            {spin("discard") ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Descartar
          </button>
        )}
          </>
        )}
      </div>
    </li>
  );
}

/** The collapsed fold of DEAD agents, with a one-click "clear all". */
function DeadAgentsDisclosure({ dead, onChanged }: { dead: FleetRow[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const toast = useToast();

  const clearAll = useCallback(async () => {
    if (clearing) return;
    setClearing(true);
    try {
      const results = await Promise.all(dead.map((r) => discardSessionAction({ sessionId: r.sessionId })));
      const ok = results.filter((r) => r.ok).length;
      toast(`${ok}/${dead.length} sessão(ões) encerrada(s) removida(s) da frota.`, ok > 0 ? "success" : undefined);
      onChanged();
    } finally {
      setClearing(false);
    }
  }, [clearing, dead, onChanged, toast]);

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-fg-muted transition hover:text-fg"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Encerrados <span className="font-normal text-fg-subtle">· {dead.length}</span>
        </button>
        <button
          type="button"
          onClick={clearAll}
          disabled={clearing}
          className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-fg-muted transition hover:text-fg disabled:opacity-40"
          title="Descartar todas as sessões mortas da frota (o session-gc também as esquece sozinho no sweep)"
        >
          {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Limpar {dead.length}
        </button>
      </div>
      {open && (
        <ul className="mt-2.5 space-y-1.5">
          {dead.map((row) => (
            <FleetRowItem key={row.agentId} row={row} onChanged={onChanged} compact />
          ))}
        </ul>
      )}
    </div>
  );
}

export function FleetPanel({ initialFleet }: { initialFleet: FleetRow[] }) {
  const [fleet, setFleet] = useState<FleetRow[]>(initialFleet);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/processes/fleet", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { fleet: FleetRow[] };
      if (Array.isArray(json.fleet)) setFleet(json.fleet);
    } catch {
      /* keep the last good snapshot */
    }
  }, []);

  // The same 8s cadence the tmux rows use — the fleet is registry+tmux state, not SSE.
  useEffect(() => {
    const t = setInterval(refetch, 8000);
    return () => clearInterval(t);
  }, [refetch]);

  // Partition by LIFECYCLE (mirrors fleet-view's own ATTENTION ordering). Orphaned ⊆ dead, so it wins first.
  const { attention, live, dead } = useMemo(() => {
    const attention = fleet.filter((r) => r.orphanedIntegration);
    const rest = fleet.filter((r) => !r.orphanedIntegration);
    return {
      attention,
      live: rest.filter((r) => !isDead(r)),
      dead: rest.filter((r) => isDead(r)),
    };
  }, [fleet]);

  // An empty fleet is the NORMAL state of a box nobody is working on — no panel at all. But if the ONLY thing
  // left is dead rows, still show the fold so the operator can clear them (and see they aren't live agents).
  if (fleet.length === 0) return null;

  return (
    <section className="mt-8">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-fg">
          <Users className="h-4 w-4 text-fg-subtle" />
          Agentes <span className="text-fg-subtle">· {live.length}</span>
        </h2>
        {attention.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" /> {attention.length} integração(ões) órfã(s)
          </span>
        )}
      </header>

      {attention.length > 0 && (
        <ul className="mb-2 space-y-2">
          {attention.map((row) => (
            <FleetRowItem key={row.agentId} row={row} onChanged={refetch} />
          ))}
        </ul>
      )}

      {live.length > 0 ? (
        <ul className="space-y-2">
          {live.map((row) => (
            <FleetRowItem key={row.agentId} row={row} onChanged={refetch} />
          ))}
        </ul>
      ) : (
        attention.length === 0 && (
          <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[12px] text-fg-muted">
            Nenhum agente ativo agora.
          </p>
        )
      )}

      {dead.length > 0 && <DeadAgentsDisclosure dead={dead} onChanged={refetch} />}
    </section>
  );
}
