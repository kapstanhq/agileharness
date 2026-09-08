"use client";

// O INBOX na home — o bloco do que precisa de VOCÊ.
//
// Cada item é um CARTÃO: o carimbo do tipo e o PEDIDO, nada mais. Sem resumo, sem letra miúda — o
// cartão pequeno não é lugar de decidir, é de reconhecer; o título ganha a face inteira e some a
// linha que ninguém lia. Dois à vista; o resto conta como "+N".
//
// A metáfora é PAPEL PAUTADO — o que um agente precisa de você é um bilhete, não um registro do
// sistema —, mas ela foi separada em duas partes que tinham sido tratadas como uma só:
//
//   • a SUPERFÍCIE é a do app (`cardSurface`), igual à dos terminais e à do kanban logo abaixo. O
//     creme (e o pardo quente do tema escuro) saiu: na home ele era a terceira cor de superfície da
//     mesma tela e puxava a página para um lado que nenhum outro bloco acompanhava.
//   • o DESENHO ficou: a pauta horizontal e a margem vertical (`.paper-rules`, globals.css), que é
//     o que faz o cartão ser lido como uma folha — e custa duas linhas de gradiente, não uma cor.
//
// Ou seja: o que diferencia um pedido de um card de sistema é ele estar NESTE bloco, com o pedido
// em corpo grande e assentado na pauta — nunca a cor do fundo. Tipografia é a do app (o cartão é uma
// metáfora, não um pastiche): uma segunda família só para este bloco custaria leitura e brigaria com
// o resto da aplicação — exatamente o que o papel NÃO pode fazer.
//
// Clicar em qualquer uma abre a PILHA inteira (InboxOverlay), onde as ações reais moram e onde o
// carrossel roda. NADA é escondido aqui: o "Pular" do overlay é navegação, e o item folheado
// continua nesta mesa (com um discreto ✓ para o operador saber que já leu).
//
// O que este componente NÃO faz: decidir. Ele mostra e leva. As ações por kind têm um dono só
// (CockpitItemDetail), que vive no overlay e na página do item.
//
// Ordem = a do cockpit (COCKPIT_GROUP_ORDER: travado → pergunta → aprovar), preservando a ordem
// interna do coletor (mais antigo/mais grave primeiro).

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { COCKPIT_GROUP_LABEL, COCKPIT_GROUP_ORDER, type CockpitItem } from "@/lib/storymap/demands";
import { formatAge } from "@/lib/storymap/copilot/copilot-status";
import {
  COCKPIT_KIND_LABEL,
  LANE_DOT_CLS,
  cockpitItemTitle,
  cockpitItemWaitingMs,
} from "@/components/inicio/cockpit-labels";
import { InboxOverlay } from "@/components/inicio/InboxOverlay";
import { cardEyebrow, cardSurface, cardSurfaceHover } from "@/lib/ui";
import type { BoardConfig, Card } from "@/lib/storymap/types";

/** Quantos cartões ficam à vista antes de virarem "+N". Dois: mais que isso vira parede. */
const VISIBLE_SHEETS = 2;

/** O ORÇAMENTO DE ALTURA do cartão, e é uma conta, não um gosto: 150px de cartão, 12px de recuo em
 *  cima e embaixo e entrelinha de 20px cabem o carimbo + CINCO linhas de pedido (12 + 20 + 5×20 + 12
 *  = 144). Mexer na entrelinha sem refazer a conta é o jeito de a última linha vazar do cartão.
 *  A entrelinha é TAMBÉM o passo da pauta (`--paper-rule-gap`) e o recuo é o deslocamento dela
 *  (`--paper-rule-offset`): é esse casamento que faz o texto sentar na linha — ver `.paper-rules`. */
const SHEET_H = "h-[150px]";
const SHEET_LEADING = "leading-[20px]";

/** Cockpit order (travado → pergunta → aprovar), estável dentro de cada lane. */
function orderedByLane(items: CockpitItem[]): CockpitItem[] {
  return COCKPIT_GROUP_ORDER.flatMap((lane) => items.filter((it) => it.lane === lane));
}

export function InboxPanel({
  boardId,
  config,
  cards,
  items,
  seenItemIds,
  now,
}: {
  boardId: string;
  config: BoardConfig;
  /** todos os cards do board — o overlay entrega ao renderer de cada kind. */
  cards: Card[];
  /** TODOS os itens que pedem o operador. Nada é filtrado — ver inbox-seen.ts. */
  items: CockpitItem[];
  /** ids que o operador já folheou no carrossel (marca de visto, vinda do servidor). */
  seenItemIds: string[];
  /** relógio grosseiro carimbado no mount (0 antes) — idades só no cliente, sem skew de SSR. */
  now: number;
}) {
  // Marcas otimistas: o servidor é a verdade, mas o ✓ tem de aparecer no gesto, não no round-trip.
  const [justSeen, setJustSeen] = useState<string[]>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const ordered = useMemo(() => orderedByLane(items), [items]);
  const seen = useMemo(() => new Set([...seenItemIds, ...justSeen]), [seenItemIds, justSeen]);

  const total = ordered.length;
  const shown = ordered.slice(0, VISIBLE_SHEETS);
  const rest = total - shown.length;
  /** O "+N" abre a pilha no primeiro item que o operador AINDA não viu — é o que ele quer dali. */
  const firstUnseen = ordered.findIndex((it) => !seen.has(it.id));

  return (
    <section aria-label="Inbox">
      <div className="mb-3 flex items-center gap-2 px-0.5">
        {/* O título É o link (sem pílula "ver todos" ao lado): abre o Inbox inteiro. */}
        <Link href={`/board/${boardId}/inbox`} prefetch={false} className="group inline-flex items-center gap-2">
          <span className="text-[15.5px] font-semibold tracking-tight text-fg transition group-hover:text-accent">
            Inbox
          </span>
          {total > 0 && (
            <span className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-[5px] bg-brand px-1.5 text-[11px] font-bold tabular-nums text-white">
              {total}
            </span>
          )}
          <ChevronRight className="h-3.5 w-3.5 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:text-accent" />
        </Link>
        <span className="flex-1" />
      </div>

      {total === 0 ? (
        <InboxEmpty />
      ) : (
        <div className="flex items-start gap-3">
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
            {shown.map((item, i) => (
              <InboxSheet
                key={item.id}
                item={item}
                seen={seen.has(item.id)}
                now={now}
                onOpen={() => setOpenIndex(i)}
              />
            ))}
          </div>
          {rest > 0 && (
            <button
              type="button"
              onClick={() => setOpenIndex(firstUnseen >= 0 ? firstUnseen : VISIBLE_SHEETS)}
              title={`Mais ${rest} na pilha`}
              className={cn(
                SHEET_H,
                "flex shrink-0 items-center px-1 text-[12px] font-semibold text-fg-subtle transition hover:text-fg",
              )}
            >
              +{rest}
            </button>
          )}
        </div>
      )}

      {openIndex !== null && (
        <InboxOverlay
          boardId={boardId}
          config={config}
          cards={cards}
          items={ordered}
          index={openIndex}
          onIndex={setOpenIndex}
          seenIds={seen}
          onSeen={(id) => setJustSeen((prev) => (prev.includes(id) ? prev : [...prev, id]))}
          onClose={() => setOpenIndex(null)}
          now={now}
        />
      )}
    </section>
  );
}

/** UM cartão: carimbo e pedido. Clicar abre a pilha nele. */
function InboxSheet({
  item,
  seen,
  now,
  onOpen,
}: {
  item: CockpitItem;
  seen: boolean;
  now: number;
  onOpen: () => void;
}) {
  const waited = cockpitItemWaitingMs(item, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Abrir: ${cockpitItemTitle(item)}`}
      className={cn(
        cardSurface,
        cardSurfaceHover,
        SHEET_H,
        SHEET_LEADING,
        // `paper-rules` desenha a pauta e a margem; a SUPERFÍCIE segue sendo a do app (`cardSurface`).
        // O `pl-9` (e não o `px-3.5` das outras bordas) é o par da margem vertical: o texto começa
        // dez pixels à DIREITA dela — ver a métrica em globals.css.
        "paper-rules",
        "group flex w-full flex-col overflow-hidden py-3 pl-9 pr-3.5 text-left",
      )}
    >
      <span className={cn(cardEyebrow, SHEET_LEADING, "flex items-center gap-1.5")}>
        <span className={cn("h-1.5 w-1.5 rounded-full", LANE_DOT_CLS[item.lane])} aria-hidden />
        <span className="truncate">
          {COCKPIT_KIND_LABEL[item.kind]}
          <span className="sr-only"> · {COCKPIT_GROUP_LABEL[item.lane]}</span>
          {waited != null ? ` · há ${formatAge(waited)}` : ""}
        </span>
        {/* Já folheado no carrossel — informa, não esconde. */}
        {seen && (
          <span className="ml-auto inline-flex items-center gap-1 normal-case tracking-normal text-fg-subtle">
            <Check className="h-3 w-3" /> visto
          </span>
        )}
      </span>
      {/* SÓ o pedido, ocupando o cartão. O resumo saiu: no cartão pequeno ele competia com o título
          e ninguém decidia por ele — quem quer o detalhe abre. O corpo é um pouco menor que o
          natural DE PROPÓSITO: título é para ser reconhecido, não lido em voz alta, e cada ponto a
          menos compra caractere — o que enche o cartão em vez de cortar. */}
      <span className={cn(SHEET_LEADING, "line-clamp-5 text-pretty text-[15px] font-medium tracking-[-0.011em] text-fg")}>
        {cockpitItemTitle(item)}
      </span>
    </button>
  );
}

/**
 * O VAZIO: um contorno traçado, com o lugar de um cartão desenhado ao lado. Sem ilustração e sem
 * celebração — nada aconteceu, simplesmente não há nada para você. Ocupa a MESMA altura do estado
 * cheio, então a home não pula de layout quando o último item é resolvido.
 */
function InboxEmpty() {
  return (
    <div className={cn(SHEET_H, "flex items-center justify-center gap-6 rounded-[11px] border border-dashed border-fg/[0.09] px-6")}>
      <div className="hidden h-[104px] w-[200px] shrink-0 rounded-[10px] border border-dashed border-fg/[0.08] sm:block" />
      <div className="flex max-w-[220px] flex-col gap-1">
        <span className="text-[12.5px] font-medium text-fg/25">Inbox vazio</span>
        <span className="text-[11.5px] leading-[1.45] text-fg/[0.18]">
          O que precisar de você chega aqui como cartão.
        </span>
      </div>
    </div>
  );
}
