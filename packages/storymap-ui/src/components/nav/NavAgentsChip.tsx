"use client";

// «Agentes N» — o chip da barra que responde ao pedido do operador: «deve ficar claro quantos agentes estão
// rodando de fato, e quais cards estão rodando de fato».
//
// Ele substitui os chips Terminal e Processos, que respondiam outra pergunta: o Terminal contava as sessões tmux (os
// condutores MAIS o `claude` e o `shell` do dono) e o Processos mostrava a RAM com o ícone de CPU e o selo de execuções
// headless (0, com condutores trabalhando). N agora é a régua única de presença (agent-presence.ts): agentes da
// FROTA com evidência fresca de trabalho — nunca o heartbeat, nunca um terminal do dono, nunca um zumbi.
//
// O popover diz o resto: cada agente com o card, o bloco, desde quando e o terminal dele; a fila do condutor; as vagas
// (quando o despacho as informa) e, recolhidos, «Seus terminais».

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bot, ChevronRight, SquareTerminal } from "lucide-react";
import { cn } from "@/lib/cn";
import { AGENT_STATE_WORDS as STATE_WORDS, agentPulse, type AgentPresenceState, type PresentAgent } from "@/lib/storymap/agent-presence";
import { sinceWords } from "@/lib/storymap/card-live-status";
import { STATE_PULSE } from "@/lib/storymap/presence-tone";
import { cardHref } from "@/lib/storymap/deep-links";
import { terminalRows, type TerminalSessionLike } from "@/lib/terminal/attention";
import { useAgentPresence, useTerminalAttention } from "@/components/RunnerStatusProvider";
import { NavChip, NavPopover, NavPopoverDivider, NavPopoverEmpty, NavPopoverFooter, NavPopoverTitle, useHoverPopover } from "./NavShell";

/** O que a barra precisa de cada sessão de terminal (o subconjunto de `EnrichedSession` que a rota devolve). */
interface TerminalSession extends TerminalSessionLike {
  fleet?: boolean;
  zombie?: boolean;
  card?: { board: string; cardId: string; title: string | null } | null;
}

/** O ponto de cada estado, nas cores da presença do card (presence-tone.ts): o terminal parado num prompt é o
 *  terracota do card (`terminal-prompt` → stopped), o parado e o que espera são o círculo cinza. Também na lista da
 *  frota do /processes — o mesmo ponto para o mesmo estado. */
export function AgentDot({ state }: { state: AgentPresenceState }) {
  if (state === "working") return <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-state-working", STATE_PULSE)} />;
  if (state === "asking") return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />;
  return <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full border border-state-idle" />;
}

const PHASE_WORDS: Record<string, string> = { moldar: "moldando", construir: "construindo", verificar: "verificando", publicar: "publicando" };

/** Quem é o agente, na linha do popover. Record exaustivo: um tipo novo de agente sem nome não compila. */
const KIND_WORDS: Record<PresentAgent["kind"], string> = { run: "execução", conductor: "condutor", session: "agente", judge: "juiz da triagem" };

export function NavAgentsChip() {
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();
  const attention = useTerminalAttention();
  // a presença da página inteira (RunnerStatusProvider) — a MESMA que o pulso do Kanban e o «Mais» do celular leem
  const { presence, now } = useAgentPresence();
  const [sessions, setSessions] = useState<TerminalSession[]>([]);

  // As sessões de terminal: o título do card de cada agente e os terminais do DONO. Poll de 60s (a rota é cara: tmux,
  // ps e os cards de todos os boards) — o mesmo ritmo do chip de Terminal que este substitui. (O aviso de rename que
  // relia na hora saiu com o bloco de terminais da home, o único que renomeava — fase 1.)
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/terminal/sessions", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (alive && j?.sessions) setSessions(j.sessions);
        })
        .catch(() => {});
    // a primeira leitura espera a página assentar: a rota é cara e nada do primeiro quadro depende dela (o popover só abre
    // com o cursor em cima, e o chip já conta os agentes pela presença do RunnerStatusProvider)
    const first = setTimeout(load, 3_000);
    const poll = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(poll);
    };
  }, []);

  const { working: n, queued } = agentPulse(presence);
  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) if (s.card?.title) m.set(`${s.card.board}/${s.card.cardId}`, s.card.title);
    return m;
  }, [sessions]);
  const mine = useMemo(() => terminalRows(sessions.filter((s) => s.fleet === false), attention), [sessions, attention]);

  return (
    <div ref={ref} className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <NavChip
        href="/processes"
        onTouchOpen={() => setOpen((o) => !o)}
        leading={
          <span className="relative inline-flex">
            <Bot className="h-4 w-4" />
            <span className="absolute -right-1 -top-1">
              {n > 0 ? (
                <span aria-hidden className={cn("block h-1.5 w-1.5 rounded-full bg-state-working", STATE_PULSE)} />
              ) : (
                <span aria-hidden className="block h-1.5 w-1.5 rounded-full border border-state-idle bg-surface" />
              )}
            </span>
          </span>
        }
        value={`Agentes ${n}`}
        open={open}
        title={
          n > 0
            ? `${n} agente${n === 1 ? "" : "s"} trabalhando agora${queued > 0 ? ` · ${queued} card${queued === 1 ? "" : "s"} na fila` : ""}`
            : "Nenhum agente trabalhando agora"
        }
        ariaLabel={`Agentes — ${n} trabalhando agora${queued > 0 ? `, ${queued} na fila` : ""}`}
      />
      {open && (
        <NavPopover label="Agentes" className="w-80">
          <NavPopoverTitle meta={`${n} agindo${queued > 0 ? ` · ${queued} na fila` : ""}`}>Agentes</NavPopoverTitle>
          {presence.agents.length === 0 ? (
            <NavPopoverEmpty>Nenhum agente nos cards agora.</NavPopoverEmpty>
          ) : (
            <ul className="flex flex-col">
              {presence.agents.map((a) => (
                <li key={a.key} className="flex items-start gap-1 rounded-lg transition hover:bg-surface-hover">
                  <Link href={cardHref(a.board, a.cardId)} onClick={() => setOpen(false)} className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5">
                    <span className="mt-[5px] flex shrink-0">
                      <AgentDot state={a.presence.state} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
                        <span className="truncate">
                          {KIND_WORDS[a.kind]} · {a.phase ? (PHASE_WORDS[a.phase] ?? a.phase) : STATE_WORDS[a.presence.state]}
                        </span>
                        {a.presence.since != null && <span className="shrink-0 tabular-nums">{sinceWords(a.presence.since, now)}</span>}
                      </span>
                      <span className="block truncate text-[12px] text-fg">{titleOf.get(`${a.board}/${a.cardId}`) ?? a.cardId}</span>
                      <span className="block truncate text-[11px] text-fg-muted">
                        {a.board} · {STATE_WORDS[a.presence.state]}
                      </span>
                    </span>
                  </Link>
                  {a.tmuxSession && (
                    // /terminal é documento estático (fora do App Router) → <a>, nunca <Link>.
                    <a
                      href={`/terminal?b=${encodeURIComponent(a.tmuxSession)}`}
                      title="Ver o terminal deste agente"
                      aria-label={`Ver o terminal de ${a.cardId}`}
                      className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface hover:text-fg"
                    >
                      <SquareTerminal className="h-3.5 w-3.5" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {presence.slots.length > 0 && (
            <>
              <NavPopoverDivider />
              <ul className="flex flex-col gap-0.5 px-1.5 text-[11px] text-fg-muted">
                {presence.slots.map((s) => (
                  <li key={s.board} className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{s.board}</span>
                    <span className="shrink-0 tabular-nums">
                      Vagas {s.used}/{s.max}
                      {s.extra && !s.extra.open && s.extra.why ? ` · vaga extra: ${s.extra.why}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {mine.length > 0 && (
            <>
              <NavPopoverDivider />
              {/* SEUS terminais — recolhidos: eles não são agentes e não entram no número, mas seguem a um toque. */}
              <details className="group px-1.5">
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-fg-muted transition hover:text-fg">
                  <ChevronRight className="h-3 w-3 transition group-open:rotate-90" aria-hidden />
                  Seus terminais · {mine.length}
                </summary>
                <ul className="mt-0.5 flex flex-col">
                  {mine.map((r) => (
                    <li key={r.session}>
                      <a
                        href={`/terminal?b=${encodeURIComponent(r.session)}`}
                        className="flex items-center gap-2 rounded-md px-1 py-1 text-[11.5px] text-fg transition hover:bg-surface-hover"
                      >
                        {r.waiting?.kind === "asking" ? (
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-state-owner" />
                        ) : (
                          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full border border-state-idle" />
                        )}
                        <span className="min-w-0 flex-1 truncate font-mono">{r.label}</span>
                        {r.waiting?.kind === "asking" && <span className="shrink-0 text-[10px] text-fg-muted">espera você</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <NavPopoverFooter href="/processes" onClick={() => setOpen(false)}>
            Abrir Processos →
          </NavPopoverFooter>
        </NavPopover>
      )}
    </div>
  );
}
