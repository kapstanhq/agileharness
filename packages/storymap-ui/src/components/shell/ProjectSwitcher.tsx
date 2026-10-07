"use client";

// O 1º degrau da árvore: QUAL projeto (board). O dropdown lista os boards com o número de decisões de cada um
// (a MESMA leitura do Inbox da barra — `useInboxSummary().byBoard`, só Decidir) e um ponto vivo onde há agente
// rodando, então dá para SAIR de um board sabendo que o outro está chamando. Trocar de board PRESERVA a tela.

import Link from "next/link";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { useRunnerSnapshot } from "@/components/RunnerStatusProvider";
import { NavDot, useHoverPopover } from "@/components/nav/NavShell";
import { viewHref, type BoardView } from "@/components/nav/nav-groups";
import { appBarCrumb, appBarPopover } from "@/components/shell/app-bar-shell";
import type { BoardConfig, BoardSummary } from "@/lib/storymap/types";

export function ProjectSwitcher({
  boards,
  config,
  view,
  counts,
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  view: BoardView;
  /** decisões do dono por board (só Decidir); null enquanto a 1ª leitura não voltou. */
  counts: Record<string, number> | null;
}) {
  // Clique, não hover: os seletores da árvore abrem como o desenho — e o hover de raspão ao atravessar a barra
  // abria listas que ninguém pediu. O hook entra pelo que ele arbitra de graça: Esc, clique fora, um painel por vez.
  const { open, setOpen, ref } = useHoverPopover();
  const { running } = useRunnerSnapshot();
  const busy = new Set(running.map((r) => r.board));

  return (
    // `flex min-w-0` no invólucro E `max-w-full` no gatilho: é o GATILHO que encolhe (e trunca o nome). Com um
    // invólucro `block` só o invólucro encolhia, o botão transbordava para a direita e o chevron caía em cima
    // da barra "/" seguinte (em 390px o "/" virava um "⁄" atropelado pelo grupo). O teto é 100% + 6px: o gatilho
    // tem `-ml-1.5` (o fundo do hover sangra para a esquerda), então o invólucro mede o conteúdo MENOS 6px — com
    // `max-w-full` o nome perdia esses 6px e «Livraria» virava «Livr…» com espaço sobrando na barra.
    <div ref={ref} className="relative flex min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Trocar de projeto"
        className={cn(appBarCrumb, "max-w-[calc(100%+6px)] sm:max-w-[18rem]", open && "bg-inset")}
      >
        {/* No celular o nome QUEBRA em até duas linhas (o gatilho tem 40px de altura — cabem duas de 13px): é a
            resposta a «em que board estou», e «Livraria Aur…» não responde. Quebra SÓ nos espaços — sem
            `overflow-wrap:anywhere`, que partia uma palavra no meio («AgileHa / rness» em 390px); uma palavra única
            mais larga que o gatilho é cortada. Do sm para cima, uma linha com «…». O nome inteiro fica no `title`. */}
        <span title={config.name} className="text-left leading-[1.15] max-sm:line-clamp-2 max-sm:text-ellipsis sm:truncate">
          {config.name}
        </span>
        <ChevronDown className={cn("h-[11px] w-[11px] shrink-0 text-fg-subtle transition", open && "rotate-180")} strokeWidth={2.4} />
      </button>
      {open && (
        <div role="menu" aria-label="Projetos" className={cn(appBarPopover, "absolute left-[-6px] top-[calc(100%+6px)] w-[min(20rem,calc(100vw-2rem))] p-1")}>
          <ul className="flex max-h-[min(60vh,22rem)] flex-col overflow-y-auto overscroll-contain">
            {boards.map((b) => {
              const active = b.id === config.id;
              const pend = counts?.[b.id] ?? null;
              return (
                <li key={b.id}>
                  <Link
                    href={viewHref(view, b.id)}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    title={pend == null ? b.name : pend > 0 ? `${b.name} — ${pend} para você decidir` : `${b.name} — nada para você decidir`}
                    className={cn(
                      // o nome INTEIRO (a lista é o lugar de ler o nome do board): quebra linha, a linha cresce
                      "flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] leading-snug text-fg transition hover:bg-inset focus-visible:bg-inset focus-visible:outline-none md:min-h-[30px] md:py-1",
                      active ? "bg-inset font-semibold" : "font-medium",
                    )}
                  >
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{b.name}</span>
                    {busy.has(b.id) && <NavDot pulse />}
                    {/* O número SEMPRE aparece: um «0» quieto vale tanto quanto um «3» — é a diferença entre
                        "board limpo" e "board que eu não sei". «…» enquanto lê. */}
                    <span
                      className={cn(
                        "inline-flex h-4 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                        pend != null && pend > 0 ? "font-semibold text-fg" : "text-fg-subtle",
                      )}
                    >
                      {pend == null ? "…" : pend}
                    </span>
                    <Check className={cn("h-3.5 w-3.5 shrink-0 text-fg", !active && "invisible")} aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
