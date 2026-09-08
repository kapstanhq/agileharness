"use client";

// 🧱 ChatDock — COMO a conversa se encaixa na tela. A moldura, não o conteúdo.
//
// Existem duas maneiras de uma tela hospedar um chat, e a diferença entre elas é de PRODUTO, não de estilo:
//
//   • RAIL — a conversa é PARTE DO LAYOUT: nasce aberta, o conteúdo divide o espaço com ela e ela não some
//     quando você vai ler outra coisa. É o encaixe de uma tela onde conversar com o agente é o trabalho
//     (a bancada de Ideias, a home). Como gaveta, essa conversa se fecharia a cada leitura.
//   • DRAWER — a conversa abre POR CIMA do conteúdo, e o conteúdo não encolhe. É o encaixe de uma tela onde
//     ela é consulta ocasional: roubar 420px permanentes de uma tela de execução seria pior que o benefício.
//
// A REGRA QUE VALE PARA AS DUAS: **nada nunca cobre o topnav.** A gaveta começa em `--ah-topbar-h` (a altura que
// o TopBar publica por ResizeObserver), e não em `inset-0`. Com o mascote morando só na barra, um painel por cima
// dela apagaria a única cara do agente exatamente enquanto ele trabalha — e "sempre visível no topnav" deixaria
// de ser verdade na hora que mais importa. A faixa do topo fica nítida e alcançável: dá para trocar de board ou
// de seção sem fechar a conversa.
//
// No CELULAR não há duas colunas: os dois modos viram a mesma coisa — uma folha, também abaixo do topnav. E o
// rail DESMONTA (não é escondido por CSS): montado, ele brigaria com a folha pela mesma sessão. Ver useMediaQuery.

import { type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { cardSurface } from "@/lib/ui";
import { Skeleton } from "@/components/Skeleton";
import { useMediaQuery } from "@/lib/useMediaQuery";
import type { ChatDockMode } from "@/lib/storymap/copilot/chat-surfaces";

/** O breakpoint do rail. É o `lg` do Tailwind — as duas réguas (montagem por JS, layout por CSS) são a MESMA. */
export const CHAT_RAIL_MIN_WIDTH = "(min-width: 1024px)";

/** A largura do rail. Larga o bastante para o texto respirar, estreita o bastante para não engolir a tela. */
const RAIL_W = "w-[420px]";

/**
 * O rail é visível? Exportado porque o HOST precisa saber ANTES de renderizar: é ele quem decide montar o botão
 * que abre a folha no celular, e quem passa `dockedChat` ao BoardHeader para que a gaveta do Jido do board não
 * apareça por cima de uma conversa que já está na tela.
 */
export function useChatRailVisible(): boolean {
  return useMediaQuery(CHAT_RAIL_MIN_WIDTH);
}

export function ChatDock({
  mode = "rail",
  open,
  onClose,
  label,
  children,
}: {
  mode?: ChatDockMode;
  /** vale para a gaveta e para a folha do celular. No rail é ignorado: ele é permanente por definição. */
  open: boolean;
  onClose: () => void;
  /** o nome da região, para leitores de tela. */
  label: string;
  children: ReactNode;
}) {
  const railVisible = useChatRailVisible();

  // ── DESKTOP · RAIL ─────────────────────────────────────────────────────────────────────────────────────
  if (railVisible && mode === "rail") {
    return (
      <aside
        aria-label={label}
        // `py-3` (era `p-4`): a moldura é a última coisa que pode gastar altura numa tela de notebook — o
        // conteúdo do chat é que tem de crescer. Nas laterais o respiro fica.
        className={cn("flex h-full shrink-0 flex-col border-l border-line bg-canvas px-4 py-3", RAIL_W)}
      >
        {/* O chat é um CARTÃO dentro do rail, não uma parede colada: a moldura é o que o separa do conteúdo à
            esquerda sem precisar de uma segunda régua vertical.
            `bg-surface` NÃO é decoração — é o que o conteúdo já pressupõe. A barra flutuante do topo é
            `bg-surface` opaca e o degradê abaixo dela nasce de `from-surface`; sem fundo próprio, o cartão
            mostrava o `bg-canvas` do rail, e no ESCURO os dois são cores diferentes (#242220 contra
            #1A1916). O resultado era uma faixa mais clara atravessando o alto do painel e um borrão de
            degradê morrendo sobre o fundo errado — exatamente onde a primeira mensagem nasce, que é o que
            fazia o texto do topo parecer apagado. No claro os dois são #ffffff e o defeito era invisível.
            A gaveta e a folha (abaixo) sempre disseram `bg-surface`; o rail era o único que não dizia — e
            o cockpit do board também o declara (CopilotChat). */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_1px_3px_rgba(15,15,15,0.05)]">
          {children}
        </div>
      </aside>
    );
  }

  // ── DESKTOP · GAVETA ───────────────────────────────────────────────────────────────────────────────────
  if (railVisible && mode === "drawer") {
    if (!open) return null;
    return (
      <div
        className="fixed inset-x-0 bottom-0 top-[var(--ah-topbar-h,0px)] z-50 flex justify-end"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <button className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-label="Fechar" onClick={onClose} />
        <div className={cn("relative flex h-full flex-col border-l border-line bg-surface shadow-2xl", RAIL_W, "max-w-full")}>
          {children}
        </div>
      </div>
    );
  }

  // ── CELULAR · FOLHA ────────────────────────────────────────────────────────────────────────────────────
  // Sem duas colunas, os dois modos convergem. Também abaixo do topnav: a régua do mascote não tem exceção de
  // viewport. (No rail, `open` só existe porque no celular ele deixa de ser permanente — é o mesmo botão.)
  if (!open) return null;
  return (
    <div
      className="fixed inset-x-0 bottom-0 top-[var(--ah-topbar-h,0px)] z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <button className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-label="Fechar" onClick={onClose} />
      <div className="relative flex h-full w-full flex-col bg-surface shadow-2xl">{children}</div>
    </div>
  );
}

/**
 * O LUGAR do rail enquanto ele ainda não está lá.
 *
 * O rail é decidido por JS (`matchMedia`), que só pode ser lido depois do mount: no primeiro quadro o desktop
 * desenha a tela com a largura inteira e, um instante depois, os 420px entram e empurram tudo para a esquerda —
 * a página "assentando" a cada visita. Este fantasma reserva a coluna pelo CSS (`hidden lg:flex`), que não espera
 * hidratação, e **não monta chat nenhum** — que é justamente a razão de o rail ser decidido por JS.
 *
 * Renderize-o enquanto `useChatRailVisible()` for falso, ao lado do dock.
 */
export function ChatDockGhost() {
  return (
    <aside aria-hidden className={cn("hidden h-full shrink-0 flex-col border-l border-line bg-canvas px-4 py-3 lg:flex", RAIL_W)}>
      {/* MESMA superfície do cartão de verdade (ver acima) — o fantasma existe para o layout não "assentar",
          e um fantasma de outra cor faria a troca piscar justamente no lugar que ele reservou. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_1px_3px_rgba(15,15,15,0.05)]">
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
          <Skeleton className="h-3 w-40 rounded" />
          <div className="mt-1 space-y-2.5">
            <div className={cn(cardSurface, "space-y-2 p-3")}>
              <Skeleton className="h-3 w-2/3 rounded" />
              <Skeleton className="h-2.5 rounded" />
              <Skeleton className="h-2.5 w-4/5 rounded" />
            </div>
          </div>
        </div>
        <div className="shrink-0 p-3">
          <div className={cn(cardSurface, "flex h-[76px] flex-col justify-between p-3")}>
            <Skeleton className="h-3 w-44 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded" />
              <span className="flex-1" />
              <Skeleton className="h-7 w-16 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
