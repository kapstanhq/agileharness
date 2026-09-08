"use client";

// Group 1 of the home — the kanban flow as a compact, read-only FEED grouped by stage (ColumnDef),
// not the full drag-and-drop board. Reuses the exact placement helpers the kanban uses (views.ts:
// kanbanStories/kanbanColumnStatuses + StatusDef.column → stage) so a card lands in the same stage
// here as there. Every row is a Link to the card's dedicated page. A live run pulses the status dot.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  KanbanCardConsoleButton,
  KanbanCardHistoryButton,
  KanbanCardRunButton,
  MoveToPopover,
  useRunnerSnapshot,
} from "@/components/RunnerStatusProvider";
import { CardBadges } from "@/components/CardBadges";
import {
  FEED_STATE_DOT,
  FEED_STATE_TEXT,
  feedState,
  feedStatePulses,
} from "@/components/inicio/cockpit-labels";
import { kanbanColumnStatuses, kanbanStories } from "@/lib/storymap/views";
import { byUpdatedDesc } from "@/lib/storymap/order";
import { cardSurface } from "@/lib/ui";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const MAX_PER_STAGE = 6;

/** First non-empty line of a card body, stripped of the leading markdown marker — the row snippet. */
function firstLine(body: string): string {
  const line = (body || "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .slice(0, 160);
}

export function KanbanFeed({
  boardId,
  config,
  cards,
  attentionCardIds,
}: {
  boardId: string;
  config: BoardConfig;
  cards: Card[];
  /** cards carrying an open cockpit item — the "aguardando você" half of the row's tri-state. */
  attentionCardIds: ReadonlySet<string>;
}) {
  const { running } = useRunnerSnapshot();
  const liveCardIds = new Set(running.filter((r) => r.board === boardId).map((r) => r.cardId));
  const [query, setQuery] = useState("");
  // O filtro em repouso é só o ÍCONE: um campo vazio ocupando 186px do cabeçalho anunciava uma busca
  // que quase nunca é usada, e competia com o título do bloco. Ele abre no clique e volta a fechar
  // sozinho quando o operador sai dele sem ter digitado nada — com texto ativo NUNCA fecha, porque um
  // filtro aplicado atrás de um ícone é uma lista mentindo em silêncio.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchExpanded = searchOpen || query.length > 0;
  useEffect(() => {
    // `preventScroll`: o cabeçalho pode estar fora de vista num `main` rolado, e focar não é navegar.
    if (searchOpen) searchRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  const groups = useMemo(() => {
    const stories = kanbanStories(cards, config);
    const columnStatusIds = new Set(kanbanColumnStatuses(config).map((s) => s.id));
    const statusById = new Map(config.statuses.map((s) => [s.id, s]));
    const stages = (config.columns ?? []).filter((c) => !c.system);
    const q = query.trim().toLowerCase();
    const matches = (c: Card) =>
      q.length === 0 ||
      c.title.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      (statusById.get(c.status ?? "")?.name ?? "").toLowerCase().includes(q);

    return stages
      .map((stage) => ({
        stage,
        statusById,
        items: stories
          .filter(
            (c) =>
              c.status != null &&
              columnStatusIds.has(c.status) &&
              statusById.get(c.status)?.column === stage.id &&
              matches(c),
          )
          .sort(byUpdatedDesc),
      }))
      .filter((g) => g.items.length > 0);
  }, [cards, config, query]);

  return (
    <section aria-label="Kanban">
      <div className="mb-3 flex items-center gap-2 px-0.5">
        {/* The block's link lives on its TITLE (no separate "Abrir kanban" pill): the heading itself
            opens the full board, a chevron nudging on hover. */}
        <Link
          href={`/board/${boardId}/kanban`}
          prefetch={false}
          className="group inline-flex items-center gap-1 text-[15.5px] font-semibold tracking-tight text-fg transition hover:text-accent"
        >
          Kanban
          <ChevronRight className="h-3.5 w-3.5 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:text-accent" />
        </Link>
        <span className="flex-1" />
        {searchExpanded ? (
          <label className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-fg/[0.10] bg-surface px-2.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // Re-arma ao voltar para o campo. Sem isso, apagar o texto de um campo que estava
              // aberto SÓ por ter filtro (o operador saiu e voltou) recolhia o campo debaixo do
              // cursor — o gesto de limpar a busca destruía a busca.
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setSearchOpen(false)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                setQuery("");
                setSearchOpen(false);
              }}
              placeholder="Filtrar…"
              aria-label="Filtrar cards do kanban"
              className="w-24 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-subtle sm:w-36"
            />
          </label>
        ) : (
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            title="Filtrar cards"
            aria-label="Filtrar cards do kanban"
            aria-expanded={false}
            className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-lg text-fg-subtle transition hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Search className="h-4 w-4" />
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <div className={cn(cardSurface, "px-4 py-10 text-center")}>
          <p className="text-[13px] text-fg-muted">
            {query.trim() ? `Nenhuma story casa com “${query.trim()}”.` : "Nenhuma story em fluxo."}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(({ stage, items, statusById }) => (
            <div key={stage.id}>
              <div className="mb-1.5 flex items-center gap-2.5 px-0.5">
                <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-fg-subtle">
                  {stage.name}
                </span>
                {/* Mesmo token de filete fraco das divisórias de dentro do cartão — o rótulo do
                    estágio e as linhas que ele encima falam a mesma língua. */}
                <span className="h-px flex-1 bg-line-muted" />
                <span className="text-[11px] text-fg-subtle">{items.length}</span>
              </div>

              {/* O estágio é um CARTÃO — a mesma superfície dos outros dois blocos da home (as folhas
                  do Inbox e os consoles dos Terminais usam este mesmo `cardSurface`), com as linhas
                  por dentro. Já foi só a linha, sem moldura, com a estrutura de container aparecendo
                  no hover: ficou solto, porque então o Kanban era o único bloco da tela sem casco e
                  a lista boiava sobre o canvas — a moldura não era peso, era o que dizia onde o
                  grupo começa e acaba.
                  A divisória é `divide-line-muted`, o token de filete FRACO do app (e não uma alfa
                  inventada sobre `fg`): é ele que separa dentro de um cartão sem competir com a
                  borda dele — a mesma escolha que os Terminais fazem entre cabeçalho e corpo. */}
              <ul className={cn(cardSurface, "divide-y divide-line-muted overflow-hidden")}>
                {items.slice(0, MAX_PER_STAGE).map((card) => {
                  const def = card.status ? statusById.get(card.status) : undefined;
                  const state = feedState({
                    live: liveCardIds.has(card.id),
                    needsYou: attentionCardIds.has(card.id),
                  });
                  // The tri-state DOT (colour + pulse) carries "acting / needs you / at rest". The step
                  // WORD is shown only when it adds information beyond the stage header above it: an
                  // active row always earns it ("entrevistando", "travado"), a resting row only when its
                  // step differs from the stage name — so a "No ar" row under the "NO AR" header no
                  // longer repeats the column back at you.
                  const showState = state !== "pausa" || (!!def?.name && def.name !== stage.name);
                  const snippet = firstLine(card.body);
                  return (
                    // The whole row navigates, but it also HOSTS buttons — and a <button> inside an
                    // <a> is invalid HTML (and unclickable). So the link is a full-bleed overlay, the
                    // static content is pointer-transparent above it, and only the action cluster
                    // takes pointer events back.
                    <li
                      key={card.id}
                      className="group relative flex items-center gap-2.5 px-3.5 py-2.5 transition hover:bg-surface-hover"
                    >
                      <Link
                        href={`/board/${boardId}/card/${card.id}`}
                        prefetch={false}
                        aria-label={`Abrir ${card.title}`}
                        className="absolute inset-0 rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                      />

                      <span className="pointer-events-none relative flex shrink-0 items-center gap-1.5">
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            FEED_STATE_DOT[state],
                            feedStatePulses(state) && "animate-pulse",
                          )}
                        />
                        {showState && (
                          <span className={cn("text-[12px] font-medium", FEED_STATE_TEXT[state])}>
                            {def?.name}
                          </span>
                        )}
                      </span>

                      <span className="pointer-events-none relative min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg md:max-w-[400px] md:flex-none">
                        {card.title}
                      </span>

                      {snippet && (
                        <span className="pointer-events-none relative hidden min-w-0 flex-1 truncate text-[12.5px] text-fg-subtle md:block">
                          {snippet}
                        </span>
                      )}

                      {/* At rest, the right edge carries only the EXCEPTION chips (compact). On hover the
                          action layer below slides over them. */}
                      <span className="pointer-events-none relative ml-auto hidden shrink-0 items-center md:flex">
                        <CardBadges card={card} config={config} compact />
                      </span>

                      {/* The operational cluster the kanban card carries — same components, same
                          confirmations. It LAYERS OVER the row pinned to the right edge, so it stays
                          flush-right no matter what sits behind it and the content can use the full
                          width at rest. A gradient scrim fades the content out to its left so the
                          buttons always read. Hidden until hover; `focus-within` keeps it keyboard-
                          reachable. Only the buttons take pointer events — the scrim and the layer stay
                          click-through, so the row's Link still works underneath. */}
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                        <span
                          aria-hidden
                          className="h-full w-14 bg-gradient-to-r from-transparent to-surface-hover"
                        />
                        <span className="pointer-events-auto flex h-full items-center gap-1 bg-surface-hover pl-1 pr-2.5">
                          <KanbanCardHistoryButton
                            boardId={boardId}
                            cardId={card.id}
                            card={card}
                            config={config}
                          />
                          <KanbanCardConsoleButton boardId={boardId} cardId={card.id} />
                          <MoveToPopover
                            boardId={boardId}
                            cardId={card.id}
                            card={card}
                            config={config}
                          />
                          <KanbanCardRunButton
                            boardId={boardId}
                            cardId={card.id}
                            hasTrigger={!!def?.trigger}
                            card={card}
                          />
                        </span>
                      </div>
                    </li>
                  );
                })}

                {items.length > MAX_PER_STAGE && (
                  // A plain "there's more" hint, not a link — navigation lives on the Kanban title.
                  <li className="px-3.5 py-2 text-center text-[11.5px] text-fg-subtle">
                    +{items.length - MAX_PER_STAGE} em {stage.name}
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
