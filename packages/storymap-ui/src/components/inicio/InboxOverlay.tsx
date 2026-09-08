"use client";

// O INBOX ABERTO — a pilha de itens, um de cada vez, sobre a tela desfocada.
//
// É um CARROSSEL, não uma caixa de saída: "Pular" vira a folha e deixa uma marca de VISTO — não tira
// nada de lugar nenhum (ver inbox-seen.ts). Por isso a numeração ("3 de 24") é o elemento fixo do
// rodapé, e por isso um item já folheado se anuncia: ao dar a volta na pilha, o operador precisa
// reconhecer o que já leu em vez de reler.
//
// ESTÉTICA: superfície do APP (bg-surface, borda hairline, tipografia padrão) e empilhamento RETO —
// nada de papel pautado nem inclinação aqui. Este é o lugar de LER e DECIDIR: a moldura tem de sumir
// de vista, e qualquer diferença em relação ao resto da aplicação vira atrito de leitura. Os cartões
// da HOME mantêm o papel — lá a metáfora do bilhete distingue "o que pede você" do resto do board;
// aqui ela só atrapalharia.
//
// O corpo é o `CockpitItemDetail` (modo `bare`): as ações REAIS de cada kind, as mesmas da tela do
// Inbox e da página do item. Zero segundo conjunto de botões para manter em sincronia — e, sem o
// papel, ele já renderiza na paleta certa sem nenhum re-mapeamento de token.
//
// NAVEGAÇÃO NO TOPO, DECISÃO EMBAIXO. Pular / Abrir em página / "N de M" viviam num rodapé FIXO, e o
// rodapé fixo cobria justamente o fim do corpo — que é onde mora a ação principal do item (o "Criar 1
// card" da proposta ficava atrás dele). Duas coisas erradas de uma vez: a barra mais permanente da
// tela era a de NAVEGAR, e a de DECIDIR era a que sumia. Agora o chrome é uma barra fina no alto,
// junto do fechar (é tudo a mesma família: sair, folhear, abrir noutro lugar), e o corpo termina na
// fileira de ações do kind — sem nada por cima.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, ExternalLink, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { CockpitItemDetail } from "@/components/CockpitView";
import { markInboxItemSeen } from "@/lib/storymap/inbox-seen-client";
import { inboxItemHref } from "@/lib/storymap/deep-links";
import { COCKPIT_GROUP_LABEL, type CockpitItem } from "@/lib/storymap/demands";
import { formatAge } from "@/lib/storymap/copilot/copilot-status";
import {
  COCKPIT_DEMAND_LABEL,
  LANE_DOT_CLS,
  LANE_TEXT_CLS,
  cockpitItemShowsStatus,
  cockpitItemTitle,
  cockpitItemWaitingMs,
} from "@/components/inicio/cockpit-labels";
import { idChip } from "@/lib/ui";
import type { BoardConfig, Card } from "@/lib/storymap/types";

/** Botão do CHROME (navegar/sair) — deliberadamente mais leve que qualquer ação de decisão do corpo:
 *  sem preenchimento, texto menor, peso normal. Quem folheia a pilha não pode confundir "pular" com
 *  "aprovar". */
const chromeButton =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover hover:text-fg disabled:opacity-50";

export function InboxOverlay({
  boardId,
  config,
  cards,
  items,
  index,
  onIndex,
  seenIds,
  onSeen,
  onClose,
  now,
}: {
  boardId: string;
  config: BoardConfig;
  cards: Card[];
  /** a pilha INTEIRA, na ordem do Inbox (lane → idade). Pular nunca a encurta. */
  items: CockpitItem[];
  /** qual item está no topo. */
  index: number;
  onIndex: (next: number) => void;
  /** ids que o operador já folheou — o chip "já visto". */
  seenIds: ReadonlySet<string>;
  /** avisa o pai que este item acabou de ser marcado (atualização otimista). */
  onSeen: (itemId: string) => void;
  onClose: () => void;
  now: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const total = items.length;
  const safeIndex = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1);
  const item = items[safeIndex];
  const next = total > 1 ? items[(safeIndex + 1) % total] : undefined;
  /** quantos ainda esperam ATRÁS deste — é o que as folhas de baixo insinuam. */
  const behind = Math.max(0, total - 1 - safeIndex);

  const go = useCallback(
    (delta: number) => {
      if (total <= 1) return;
      onIndex((safeIndex + delta + total) % total);
    },
    [onIndex, safeIndex, total],
  );

  // A pilha esvaziou embaixo do leitor (o último item foi resolvido) — nada a mostrar, fecha.
  useEffect(() => {
    if (total === 0) onClose();
  }, [total, onClose]);

  // Teclado: esc fecha, setas viram a folha. O foco vai para o diálogo no mount para o leitor de tela
  // anunciar o item e para as setas funcionarem sem um clique antes.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        go(1);
      } else if (e.key === "ArrowLeft") {
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    // Enquanto a pilha está aberta o documento não rola atrás dela.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [go, onClose]);

  if (!item) return null;

  const waited = cockpitItemWaitingMs(item, now);
  // O status do pipeline só entra quando descreve MESMO o card (ver cockpitItemShowsStatus): numa
  // proposta ele seria o "Capturando" do contêiner efêmero — a terceira palavra redundante do
  // cabeçalho antigo.
  const statusName =
    cockpitItemShowsStatus(item) && item.status
      ? (config.statuses.find((s) => s.id === item.status)?.name ?? null)
      : null;
  const alreadySeen = seenIds.has(item.id);

  // PULAR = avançar + marcar visto. A navegação é IMEDIATA (não espera a rede): virar a folha é um
  // gesto, e um gesto que trava por causa de um fetch parece quebrado. A marca é best-effort — se
  // falhar, o operador perde um chip, nunca a posição na pilha.
  const skip = () => {
    setError(null);
    const skipped = item.id;
    go(1);
    onSeen(skipped);
    startTransition(async () => {
      const res = await markInboxItemSeen(boardId, skipped);
      if (!res.ok) setError(res.error);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={`Inbox — ${cockpitItemTitle(item)}`}
    >
      {/* O VÉU: desfoca e apaga o que está atrás, sem apagar de vez — a tela continua lá. */}
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-canvas/70 backdrop-blur-md"
      />

      <div ref={dialogRef} tabIndex={-1} className="w-full max-w-[680px] outline-none">
        {/* A PILHA e o cartão vivem no MESMO contexto de posicionamento, e a linha do "próximo" fica
            FORA dele: as folhas de baixo se esticam até o fim do seu pai, então com a linha dentro
            elas a emolduravam. */}
        <div className="relative">
          {/* A PILHA, RETA: as folhas de baixo são só profundidade (aria-hidden). Quantas faltam vai por
            NÚMERO na barra de chrome — "tem mais" não pode depender de enxergar uma sombra. */}
          {behind > 1 && (
            <div
              aria-hidden
              className="absolute -bottom-3.5 left-6 right-6 top-6 rounded-[14px] border border-line bg-surface shadow-[0_10px_24px_-16px_rgba(15,15,15,0.35)]"
            />
          )}
          {behind > 0 && (
            <div
              aria-hidden
              className="absolute -bottom-2 left-3 right-3 top-3 rounded-[14px] border border-line bg-surface shadow-[0_8px_20px_-14px_rgba(15,15,15,0.3)]"
            />
          )}

          <article className="stack-rise relative flex max-h-[86vh] flex-col overflow-hidden rounded-[14px] border border-line bg-surface shadow-[0_2px_6px_rgba(15,15,15,0.08),0_28px_60px_-28px_rgba(15,15,15,0.45)]">
            {/* CHROME — onde você está na pilha e como sair dela. Fina, discreta, e a primeira coisa
                do cartão: navegar é sempre possível, mas nunca é a ação que o item pede. */}
            <div className="flex flex-none items-center gap-1 border-b border-line-muted py-2 pl-3 pr-2">
              {total > 1 && (
                <span className="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => go(-1)}
                    aria-label="Item anterior"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="min-w-[58px] text-center font-mono text-[11.5px] tabular-nums text-fg-subtle">
                    {safeIndex + 1} de {total}
                  </span>
                  <button
                    type="button"
                    onClick={() => go(1)}
                    aria-label="Próximo item"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </span>
              )}
              {total > 1 && (
                <button
                  type="button"
                  onClick={skip}
                  disabled={pending}
                  title="Passa para o próximo e marca este como já visto — nada sai da lista."
                  className={chromeButton}
                >
                  <SkipForward className="h-3.5 w-3.5" /> Pular
                </button>
              )}
              <Link href={inboxItemHref(boardId, item.id)} prefetch={false} className={chromeButton}>
                Abrir em página
              </Link>

              <span className="flex-1" />

              {/* A marca de VISTO é um fato de NAVEGAÇÃO ("já folheei este"), não uma propriedade do
                  item — por isso mora com o folhear/sair, e não mais na fileira de rótulos do item. */}
              {alreadySeen && (
                <span className="inline-flex items-center gap-1 pr-1 text-[11.5px] text-fg-subtle">
                  <Check className="h-3 w-3" /> já visto
                </span>
              )}

              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* O PEDIDO, em UMA linha: o que se espera de você e há quanto tempo espera.
                Antes eram CINCO rótulos lado a lado — a lane ("Aprovar"), o kind ("Proposta de
                captura"), o status do pipeline ("Capturando"), a idade e o chip de visto —, e três
                deles diziam recortes da MESMA coisa. Agora: a lane é só a COR do ponto (segue
                anunciada ao leitor de tela), o kind virou o VERBO da frase, o status desceu para a
                meta do corpo (e só quando descreve mesmo um card) e o visto subiu para o chrome. */}
            <header className="flex flex-none flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-line-muted px-5 py-2.5">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", LANE_DOT_CLS[item.lane])} aria-hidden />
              <span className={cn("text-[12.5px] font-semibold", LANE_TEXT_CLS[item.lane])}>
                {COCKPIT_DEMAND_LABEL[item.kind]}
              </span>
              <span className="sr-only">· {COCKPIT_GROUP_LABEL[item.lane]}</span>
              {waited != null && (
                <span className="text-[12px] text-fg-subtle">· espera há {formatAge(waited)}</span>
              )}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <h2 className="text-[19px] font-semibold leading-[1.32] tracking-[-0.011em] text-fg">
                {cockpitItemTitle(item)}
              </h2>
              {/* A META — de ONDE vem: o card e, só quando descreve mesmo um card do pipeline, a
                  coluna em que ele está. Depois do título de propósito: pedido → assunto → procedência. */}
              {(item.cardId || statusName) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  {item.cardId && (
                    <Link
                      href={`/board/${boardId}/card/${item.cardId}`}
                      prefetch={false}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-fg-subtle transition hover:text-accent"
                    >
                      {item.cardId} <ExternalLink className="h-3 w-3" />
                    </Link>
                  )}
                  {statusName && <span className={idChip}>{statusName}</span>}
                </div>
              )}

              {/* As palavras do item + as ações do seu kind. Sem resumo próprio aqui: o renderer abre
                justamente com o texto que o resumo derivaria — seria a mesma frase escrita duas vezes. */}
              <div className="mt-4 border-t border-line-muted pt-4">
                <CockpitItemDetail config={config} boardId={boardId} item={item} cards={cards} bare />
              </div>

              {error && <p className="mt-3 text-[12.5px] text-danger">{error}</p>}
            </div>

          </article>
        </div>

        {/* `mt-6` dá a folga das folhas de baixo (que avançam ~14px além do cartão). */}
        {next && (
          <p className="mt-6 truncate px-1 text-center text-[12px] text-fg-muted">
            Próximo: <span className="text-fg-muted">{cockpitItemTitle(next)}</span>
            {seenIds.has(next.id) && <span> · já visto</span>}
          </p>
        )}
      </div>
    </div>
  );
}
