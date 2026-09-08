"use client";

// PRIORIZAÇÃO — uma lista ordenada, um gráfico, e nada mais.
//
// A tela responde UMA pergunta: no que eu invisto primeiro? Tudo que não respondia isso saiu — a
// segunda tabela (a mesma lista com outra ordenação), os quatro gráficos de CLASSIFICAÇÃO (matriz
// RICE, funil AAARRR, curva KANO, raias KANO), os cinco filtros independentes que divergiam em
// silêncio, e a paleta improvisada que não vinha dos tokens.
//
// A REGRA DE HONESTIDADE que governa o layout: a tela NUNCA renderiza uma lista ordenada de cards
// não avaliados. A versão anterior fazia isso e ninguém via — sem `priorityCall`, a ordenação caía
// num `localeCompare(title)` e o que aparecia era uma LISTA ALFABÉTICA com cara de ranking, embaixo
// de um cabeçalho que dizia "0 de 173 avaliadas". Sem avaliação não há ordem: mostramos o convite
// para avaliar, e ponto.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListOrdered, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardEyebrow, countChipCls } from "@/lib/ui";
import { scoreStoriesAction } from "@/app/priority-actions";
import { hasStrategy, rankableCards } from "@/lib/storymap/priority-context";
import { cardWsjf, comparePriority, wsjfConfidence, type Confidence } from "@/lib/storymap/wsjf";
import { tierFromRank } from "@/lib/storymap/priority";
import type { Board, BoardConfig, BoardSummary, Card } from "@/lib/storymap/types";
import { cardHref } from "@/lib/storymap/deep-links";
import { PageHeader } from "@/components/nav/PageTabs";
import { BoardHeader } from "./BoardHeader";
import { ToastProvider } from "./Toast";
import { ValueSizeChart } from "./ValueSizeChart";

const TIERS = [3, 2, 1, 0] as const;

/** Peso tipográfico por tier — a hierarquia é peso e espaço, nunca cor (identidade do app). */
const TIER_WEIGHT: Record<0 | 1 | 2 | 3, string> = {
  3: "font-semibold text-fg",
  2: "font-medium text-fg",
  1: "text-fg-muted",
  0: "text-fg-subtle",
};

// Confiança = quantos sinais REAIS o card tinha quando foi julgado. Desenhada como um MEDIDOR de três
// segmentos e não como três pontinhos: em 4px os pontos liam como reticências ("···", texto truncado)
// em vez de escala — e no celular isso era pior. O medidor repete a gramática da barra de cobertura
// do topo, então o mesmo desenho significa a mesma coisa em dois lugares.
const CONFIDENCE_FILLED: Record<Confidence, number> = { alta: 3, media: 2, baixa: 1 };
const CONFIDENCE_TITLE: Record<Confidence, string> = {
  alta: "Avaliado com bastante evidência no card",
  media: "Avaliado com evidência parcial",
  baixa: "Avaliado com pouca evidência — o card estava quase vazio",
};

export function PrioritizationView({
  board,
  boards,
  strategy,
}: {
  board: Board;
  boards: BoardSummary[];
  /**
   * O norte do board (o digest do PRD), resolvido no SERVIDOR e entregue por prop. Não é lido aqui
   * porque lê-lo custa disco: `loadDoc` é de servidor, e importá-lo num componente de cliente
   * arrastaria `node:fs` para o bundle — o `next build` reprova, e o `tsc --noEmit` não vê.
   */
  strategy: string;
}) {
  return (
    <ToastProvider>
      <PrioritizationInner board={board} boards={boards} strategy={strategy} />
    </ToastProvider>
  );
}

function PrioritizationInner({
  board,
  boards,
  strategy: strategyText,
}: {
  board: Board;
  boards: BoardSummary[];
  strategy: string;
}) {
  const router = useRouter();
  const [cards, setCards] = useState<Card[]>(board.cards);
  const [config, setConfig] = useState<BoardConfig>(board.config);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCards(board.cards);
    setConfig(board.config);
  }, [board]);

  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);

  const { ranked, unscored } = useMemo(() => {
    const open = rankableCards(cards, config);
    const scored = open.filter((c) => cardWsjf(c) != null).sort(comparePriority);
    return { ranked: scored, unscored: open.filter((c) => cardWsjf(c) == null) };
  }, [cards, config]);

  const posById = useMemo(() => new Map(ranked.map((c, i) => [c.id, i + 1])), [ranked]);
  const total = ranked.length + unscored.length;
  const strategy = hasStrategy(strategyText);

  const lastAssessed = useMemo(() => {
    const stamps = ranked.map((c) => c.priorityCall?.assessedAt).filter((s): s is string => !!s);
    return stamps.length ? (stamps.sort().at(-1) ?? null) : null;
  }, [ranked]);

  const score = async (cardIds?: string[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await scoreStoriesAction({ boardId: config.id, cardIds });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const d = res.data;
    if (d) {
      const partes = [`${d.scored} priorizada(s)`];
      // Cobertura parcial é DITA, não escondida — foi o silêncio sobre isso que deixou a tela
      // parecer completa com a maioria dos cards sem nota.
      if (d.missing.length) partes.push(`${d.missing.length} sem resposta do agente`);
      if (d.skippedHuman) partes.push(`${d.skippedHuman} preservada(s) por serem suas`);
      setNotice(partes.join(" · "));
    }
    router.refresh();
  };

  // Abrir uma story NAVEGA para a página dela (a lista e o ponto do gráfico). Era uma gaveta —
  // e era a ÚNICA forma de chegar ao detalhe a partir daqui, já que esta tela nunca teve um link
  // para /card/<id>.
  const openCardPage = (id: string) => router.push(cardHref(config.id, id));

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={config} view="priorizacao" subnav />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-8">
        {/* O MESMO cabeçalho das telas irmãs. O verbo primário da tela vai no slot `actions`; a
            COBERTURA (linha + barra + o aviso de norte) fica logo abaixo, junta: uma barra de
            progresso não cabe num slot encostado à direita do título. O ícone perde o `text-accent`
            e assume o `text-fg-subtle` do PageHeader — é a unificação, não um esquecimento. */}
        <PageHeader
          title="Priorização"
          icon={ListOrdered}
          description="No que investir primeiro. Cada story recebe uma nota WSJF — valor, urgência e o quanto destrava, dividido pelo tamanho — e a ordem cai dessa conta."
          actions={
            <button
              type="button"
              onClick={() => score()}
              disabled={busy || unscored.length === 0}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-fg px-3 text-[12px] font-semibold text-canvas transition hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {unscored.length > 0 ? `Priorizar ${unscored.length}` : "Tudo priorizado"}
            </button>
          }
        />

        <Coverage
          scored={ranked.length}
          total={total}
          lastAssessed={lastAssessed}
          strategy={strategy}
          boardId={config.id}
        />

        {notice && (
          <p className="mt-3 text-[12px] text-fg-muted" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-3 flex items-start gap-1.5 text-[12px] text-danger" role="alert">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        {total === 0 ? (
          <EmptyBlock>Nenhuma story em aberto neste board — não há o que priorizar.</EmptyBlock>
        ) : ranked.length === 0 ? (
          // Sem NENHUMA nota não existe ordem: não desenhamos lista nem gráfico.
          <EmptyBlock>
            {unscored.length} story(s) em aberto, nenhuma avaliada ainda. Peça a avaliação ao agente e
            a ordem aparece aqui.
          </EmptyBlock>
        ) : (
          <div className={cn("mt-5 space-y-5", busy && "pointer-events-none opacity-60")} aria-busy={busy}>
            <ValueSizeChart cards={ranked} onOpen={openCardPage} />

            {TIERS.map((rank) => {
              const group = ranked.filter((c) => c.priorityCall?.rank === rank);
              if (group.length === 0) return null;
              return (
                <section key={rank}>
                  <div className="mb-1.5 flex items-center gap-2 px-1">
                    <h2 className={cardEyebrow}>{tierFromRank(rank).label}</h2>
                    <span className="h-px flex-1 bg-line-muted" />
                    <span className={countChipCls}>{group.length}</span>
                  </div>
                  <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                    {group.map((card) => (
                      <li key={card.id}>
                        <PriorityRow
                          card={card}
                          pos={posById.get(card.id) ?? 0}
                          onOpen={() => openCardPage(card.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {unscored.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-line px-4 py-3">
                <span className="text-[12.5px] text-fg-subtle">
                  {unscored.length} story(s) ainda sem avaliação — fora da ordem acima.
                </span>
                <button
                  type="button"
                  onClick={() => score(unscored.map((c) => c.id))}
                  disabled={busy}
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-[11.5px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Avaliar as {unscored.length}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

    </div>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-lg border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-fg-subtle">
      {children}
    </div>
  );
}

/** A COBERTURA — quanto do backlog tem nota, dito ANTES de qualquer lista (o verbo primário mudou-se
 *  para o slot `actions` do PageHeader; estes três elementos ficam juntos porque se leem juntos). */
function Coverage({
  scored,
  total,
  lastAssessed,
  strategy,
  boardId,
}: {
  scored: number;
  total: number;
  lastAssessed: string | null;
  strategy: boolean;
  boardId: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[12px] tabular-nums text-fg-subtle">
        {scored} de {total} priorizada(s)
        {lastAssessed && <> · última avaliação em {lastAssessed.slice(0, 10)}</>}
      </p>

      {/* A barra de cobertura: quanto do backlog tem nota, num relance. Grafite e linha, sem cor. */}
      {total > 0 && (
        // `fg/40` e não `fg/70`: no tema escuro a tinta é quase branca, e a 70% a barra cheia lia
        // como um traço gritando embaixo do cabeçalho em vez de um medidor discreto.
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-line" title={`${scored} de ${total} com nota`}>
          <div className="h-full rounded-full bg-fg/40" style={{ width: `${(scored / total) * 100}%` }} />
        </div>
      )}

      {!strategy && (
        <p className="text-[11.5px] leading-snug text-fg-subtle">
          Este board não declarou posicionamento nem resultado-alvo. Sem esse norte a avaliação vira
          palpite confiante —{" "}
          <a href={`/board/${boardId}/posicionamento`} className="underline underline-offset-2 hover:text-fg">
            declare o norte
          </a>{" "}
          antes.
        </p>
      )}
    </div>
  );
}

/** Uma linha do ranking: posição, título, o PORQUÊ, e a nota com sua confiança. */
function PriorityRow({ card, pos, onOpen }: { card: Card; pos: number; onOpen: () => void }) {
  const pc = card.priorityCall;
  const w = pc?.wsjf;
  const score = cardWsjf(card);
  const conf = wsjfConfidence(w?.basis);
  const tier = pc ? tierFromRank(pc.rank) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition hover:bg-surface-hover"
    >
      <span className="w-5 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-fg-subtle">{pos}</span>

      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13.5px] leading-snug", tier ? TIER_WEIGHT[tier.rank] : "text-fg")}>
          {card.title}
        </span>
        {/* O porquê é o coração da tela — é o que separa isto de uma planilha. Some no celular,
            onde a largura é o recurso escasso e o título já decide. */}
        {pc?.rationale && (
          <span className="mt-0.5 hidden truncate text-[12px] leading-snug text-fg-subtle md:block">
            {pc.rationale}
          </span>
        )}
      </span>

      {pc?.source === "human" && (
        <span
          title="Prioridade definida por você — o agente não sobrescreve"
          className="mt-0.5 shrink-0 rounded-md bg-fg/[0.05] px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-fg-muted"
        >
          você
        </span>
      )}

      <span className="flex shrink-0 items-center gap-2.5 pt-1">
        {/* Impede a nota de soar certa sobre um card vazio. */}
        <span className="flex items-center gap-[2px]" title={CONFIDENCE_TITLE[conf]} aria-label={CONFIDENCE_TITLE[conf]}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={cn(
                // `fg-muted` e não `fg-subtle`: cheio contra vazio media 1.98:1 no claro e 2.62:1 no
                // escuro — abaixo dos 3:1 que a WCAG 1.4.11 pede de um objeto GRÁFICO que carrega
                // significado, e o medidor lia como três tracinhos iguais. Com muted vai a 5.17:1 /
                // 4.82:1. O `h-1` dá tinta suficiente para a diferença aparecer a 1x.
                "h-1 w-2 rounded-[1px]",
                i < CONFIDENCE_FILLED[conf] ? "bg-fg-muted" : "bg-line",
              )}
            />
          ))}
        </span>
        <span className="w-8 text-right text-[13px] font-semibold tabular-nums text-fg">
          {score != null ? score.toFixed(1) : "—"}
        </span>
      </span>
    </button>
  );
}
