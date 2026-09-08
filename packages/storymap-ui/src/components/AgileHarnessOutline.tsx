"use client";

// STORY MAP — o User Story Mapping como OUTLINE (árvore progressiva).
//
// O que substituiu, e por quê: o mapa era uma GRADE 2D (passos no eixo x × releases no eixo y) com
// arrasto. Era fiel ao quadro de post-its do Patton e ilegível na tela: rolava nos dois eixos ao mesmo
// tempo (perdia-se o cabeçalho OU a coluna), não cabia no celular, e a hierarquia ação › passo › story
// só existia na cabeça de quem já conhecia o método. O gesto que ela oferecia — arrastar — era também
// o mais fácil de fazer sem querer.
//
// Aqui a MESMA informação é uma árvore que se lê de cima para baixo, um nível por vez:
//
//     ▸ Descobrir na mosaico                      2 passos · 4 stories   ▮▮▯
//       ▸ Navegar o feed                                     3 stories
//         ● Ver eventos no feed              MVP · 1 entrega    abrir ↗
//
// Três decisões que valem por todo o resto:
//   1. NADA de detalhe próprio. Clicar numa linha ABRE O NÍVEL; "abrir ↗" vai para a PÁGINA do card
//      (que já é um documento completo). O mapa não compete com ela — ele só situa.
//   2. O arrasto morreu, a ORDEM não. A espinha se lê na ordem de uso, então cada linha reordena por
//      ↑/↓ (preciso, reversível, funciona no celular) e a release troca por um seletor na própria
//      linha. Reancorar (trocar de passo/pai) é da página do card, onde já era.
//   3. Filtro/busca PODAM e ABREM: o que sobra é o que casou, já revelado — nunca "achei 3, agora
//      descubra em qual galho".
//
// A derivação (quem aparece, em que ordem, com que resumo) é PURA e mora em lib/storymap/outline.ts —
// este arquivo desenha OutlineRow[] e nada mais.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  ExternalLink,
  Plus,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { idChip } from "@/lib/ui";
import { useLocalToggle } from "@/lib/useLocalToggle";
import { cardHref, newCardHref } from "@/lib/storymap/deep-links";
import { entryStatusId } from "@/lib/storymap/views";
import {
  buildOutline,
  expansionForLevel,
  reorderTarget,
  EMPTY_OUTLINE_FILTERS,
  type OutlineGrouping,
  type OutlineProgress,
  type OutlineRow,
  type OutlineState,
} from "@/lib/storymap/outline";
import { NO_RELEASE, type Board, type BoardConfig, type BoardSummary, type Card } from "@/lib/storymap/types";
import { moveCardAction } from "@/app/actions";
import { BoardHeader, type Filters } from "./BoardHeader";
import { MetaBadge } from "./FrameworkBadges";
import { ResultadoAlvoBanner } from "./ResultadoAlvoBanner";
import { SmartCaptureModal } from "./SmartCaptureModal";
import { ToastProvider, UNDO_TOAST_MS, useToast } from "./Toast";

/** Quanto cada nível recua — a largura da calha que desenha a guia vertical. */
const RAIL = 22;

/**
 * Uma ação da linha (abrir / novo passo). No DESKTOP ela aparece no hover/foco, para não competir com
 * o texto; no CELULAR fica SEMPRE visível — não existe hover no toque, e escondê-la ali deixaria a
 * página do card inalcançável a partir de uma linha que tem filhos (o toque abriria só o nível).
 */
const ROW_ACTION =
  "inline-flex shrink-0 items-center gap-1 rounded-md border border-transparent px-1.5 py-1 text-[11px] text-fg-subtle transition hover:border-line hover:text-fg sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100";

const LEVELS = [
  { n: 1, label: "Ações", hint: "Só a espinha dorsal — as grandes ações do usuário" },
  { n: 2, label: "Passos", hint: "Abre cada ação nos seus passos" },
  { n: 3, label: "Stories", hint: "Abre tudo até as stories" },
] as const;

export function AgileHarnessOutline({
  board,
  boards,
  desiredOutcome,
}: {
  board: Board;
  boards: BoardSummary[];
  /** O Resultado-alvo lido do PRD (servidor) — a tira acima do mapa só o MOSTRA. */
  desiredOutcome: string | null;
}) {
  return (
    <ToastProvider>
      <AgileHarnessOutlineInner board={board} boards={boards} desiredOutcome={desiredOutcome} />
    </ToastProvider>
  );
}

function AgileHarnessOutlineInner({
  board,
  boards,
  desiredOutcome,
}: {
  board: Board;
  boards: BoardSummary[];
  desiredOutcome: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [cards, setCards] = useState<Card[]>(board.cards);
  const [config, setConfig] = useState<BoardConfig>(board.config);
  const [filters, setFilters] = useState<Filters>(EMPTY_OUTLINE_FILTERS);
  const [showMeta, toggleMeta] = useLocalToggle("storymap.showMeta", false);
  const [smartOpen, setSmartOpen] = useState(false);

  const [grouping, setGrouping] = useState<OutlineGrouping>("fluxo");
  const [search, setSearch] = useState("");
  const [release, setRelease] = useState("");
  const [level, setLevel] = useState(1);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // O servidor manda dados frescos (mutação nossa revalida a rota; edição externa — um agente
  // escrevendo o card — entra pelo refresh de foco abaixo).
  useEffect(() => {
    setCards(board.cards);
    setConfig(board.config);
  }, [board]);

  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);

  const outline = useMemo(
    () => buildOutline(cards, config, { grouping, search, release, filters, open }),
    [cards, config, grouping, search, release, filters, open],
  );

  const toggle = useCallback((key: string) => {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
    setLevel(0); // a abertura deixou de ser "um nível inteiro" e passou a ser a sua
  }, []);

  const applyLevel = useCallback(
    (n: number) => {
      setOpen(expansionForLevel(cards, config, grouping, n));
      setLevel(n);
    },
    [cards, config, grouping],
  );

  const changeGrouping = (g: OutlineGrouping) => {
    setGrouping(g);
    setOpen({});
    setLevel(1);
  };

  const clearAll = () => {
    setSearch("");
    setRelease("");
    setFilters(EMPTY_OUTLINE_FILTERS);
    setOpen({});
    setLevel(1);
  };

  const openCard = (id: string) => router.push(cardHref(config.id, id));

  const startNew = (init: { type: Card["type"]; parent?: string | null; release?: string | null }) =>
    router.push(
      newCardHref(config.id, {
        ...init,
        status: init.type === "story" ? entryStatusId(config) : undefined,
      }),
    );

  /**
   * Grava um `move` otimista com DESFAZER — o mesmo contrato do arrasto que existia aqui: a lista
   * mexe na hora, o servidor confirma, e a falha devolve o estado anterior em vez de deixar a tela
   * mentindo. Não há mudança de status envolvida (nenhum autorun dispara), então a volta é o inverso.
   */
  const applyMove = async (
    card: Card,
    patch: { order?: number; release?: string | null },
    describe: string,
  ) => {
    const before = cards;
    const updated: Card = { ...card, ...patch };
    setCards((cs) => cs.map((c) => (c.id === card.id ? updated : c)));
    const res = await moveCardAction({
      boardId: config.id,
      cardId: card.id,
      parent: updated.parent,
      release: updated.release,
      order: updated.order,
    });
    if (!res.ok) {
      setCards(before);
      toast(res.error);
      return;
    }
    toast(
      describe,
      "success",
      {
        label: "Desfazer",
        onClick: async () => {
          const back = await moveCardAction({
            boardId: config.id,
            cardId: card.id,
            parent: card.parent,
            release: card.release,
            order: card.order,
            isUndo: true,
          });
          if (!back.ok) return toast(`Não consegui desfazer: ${back.error}`);
          setCards(before);
        },
      },
      UNDO_TOAST_MS,
    );
  };

  const move = (row: OutlineRow, dir: -1 | 1) => {
    if (!row.card || !row.container) return;
    const order = reorderTarget(cards, row.container, row.card.id, dir);
    if (order == null) return;
    void applyMove(row.card, { order }, `“${row.card.title}” ${dir === -1 ? "subiu" : "desceu"} na ordem.`);
  };

  const setCardRelease = (row: OutlineRow, next: string) => {
    if (!row.card) return;
    const releaseId = next === NO_RELEASE ? null : next;
    if ((row.card.release ?? null) === releaseId) return;
    const name = outline.releases.find((r) => r.id === next)?.name ?? "sem release";
    void applyMove(row.card, { release: releaseId }, `“${row.card.title}” foi para ${name}.`);
  };

  const canReorder = (row: OutlineRow, dir: -1 | 1) =>
    !!row.card && !!row.container && reorderTarget(cards, row.container, row.card.id, dir) != null;

  const hasBackbone = outline.totals.activities > 0;
  const dirty = !!search || !!release || !!filters.status || !!filters.persona || !!filters.system;

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader
        boards={boards}
        config={config}
        view="mapa"
        filters={filters}
        onFilterChange={setFilters}
        onSmartCapture={() => setSmartOpen(true)}
        showMeta={showMeta}
        onToggleMeta={toggleMeta}
        subnav
      />

      {/* O Resultado-alvo (Desired Outcome) — o vértice ao qual as stories sobem. */}
      <ResultadoAlvoBanner boardId={config.id} outcome={desiredOutcome} />

      {/* PRODUTO_MAX_W — a MESMA largura das irmãs do bloco (Ideias · Priorização · Personas). O mapa
          era a exceção declarada enquanto era uma grade 2D que rolava nos dois eixos; virou coluna de
          conteúdo e entrou na régua, para a troca de aba do nível 2 não deslocar a página de lado. */}
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-10">
        <OutlineHeader config={config} totals={outline.totals} />

        <Toolbar
          search={search}
          onSearch={setSearch}
          grouping={grouping}
          onGrouping={changeGrouping}
          release={release}
          onRelease={setRelease}
          releases={outline.releases}
          level={level}
          onLevel={applyLevel}
          dirty={dirty}
          onClear={clearAll}
        />

        {dirty && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
            <span>
              Mostrando <strong className="font-semibold text-fg">{outline.totals.matched}</strong> de{" "}
              {outline.totals.stories} stories
            </span>
            {search && <FilterChip label={`busca: ${search.trim()}`} onClear={() => setSearch("")} />}
            {release && (
              <FilterChip
                label={`release: ${outline.releases.find((r) => r.id === release)?.name ?? release}`}
                onClear={() => setRelease("")}
              />
            )}
            {filters.status && (
              <FilterChip
                label={`status: ${config.statuses.find((s) => s.id === filters.status)?.name ?? filters.status}`}
                onClear={() => setFilters({ ...filters, status: "" })}
              />
            )}
            {filters.persona && (
              <FilterChip
                label={`persona: ${config.personas.find((p) => p.id === filters.persona)?.name ?? filters.persona}`}
                onClear={() => setFilters({ ...filters, persona: "" })}
              />
            )}
            {filters.system && (
              <FilterChip
                label={`sistema: ${config.systems.find((s) => s.id === filters.system)?.name ?? filters.system}`}
                onClear={() => setFilters({ ...filters, system: "" })}
              />
            )}
          </div>
        )}

        <div className="mt-4">
          {!hasBackbone ? (
            <EmptyBoard onAdd={() => startNew({ type: "activity" })} />
          ) : outline.rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line py-16 text-center text-[13px] text-fg-muted">
              Nenhuma story com esse filtro.
            </div>
          ) : (
            <div className="border-t border-line">
              {outline.rows.map((row) => (
                <OutlineRowView
                  key={row.key}
                  row={row}
                  config={config}
                  showMeta={showMeta}
                  onToggle={() => toggle(row.key)}
                  onOpen={openCard}
                  onCreate={startNew}
                  onMoveUp={canReorder(row, -1) ? () => move(row, -1) : undefined}
                  onMoveDown={canReorder(row, 1) ? () => move(row, 1) : undefined}
                  onRelease={(v) => setCardRelease(row, v)}
                  releases={outline.releases}
                />
              ))}
            </div>
          )}

          {hasBackbone && !dirty && grouping === "fluxo" && (
            <button
              type="button"
              onClick={() => startNew({ type: "activity" })}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-[12.5px] font-medium text-fg-muted transition hover:border-line-emphasis hover:text-fg"
            >
              <Plus className="h-3.5 w-3.5" /> Ação
            </button>
          )}
        </div>
      </main>

      {smartOpen && (
        <SmartCaptureModal
          boardId={config.id}
          config={config}
          cards={cards}
          onClose={() => {
            setSmartOpen(false);
            router.refresh();
          }}
          onCreated={() => router.refresh()}
          onOpenCard={openCard}
          onOpenIdeas={() => router.push(`/board/${config.id}/ideias`)}
        />
      )}
    </div>
  );
}

// ── Cabeçalho ───────────────────────────────────────────────────────────────────────────────────

function OutlineHeader({
  config,
  totals,
}: {
  config: BoardConfig;
  totals: { activities: number; steps: number; stories: number; done: number };
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-subtle">
          User Story Mapping
        </div>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-fg sm:text-[26px]">
          {config.name}
        </h1>
        <p className="mt-1 max-w-prose text-[13px] leading-snug text-fg-muted">
          A jornada do usuário de cima para baixo: ação › passo › story › entrega. Clique numa linha
          para abrir o nível seguinte.
        </p>
      </div>
      <dl className="flex shrink-0 gap-5">
        <Stat n={totals.activities} label="ações" />
        <Stat n={totals.steps} label="passos" />
        <Stat n={totals.stories} label="stories" />
        <Stat n={totals.done} label="no ar" muted />
      </dl>
    </header>
  );
}

function Stat({ n, label, muted }: { n: number; label: string; muted?: boolean }) {
  return (
    <div className="text-right">
      <dd className={cn("text-[19px] font-semibold tabular-nums", muted ? "text-fg-muted" : "text-fg")}>{n}</dd>
      <dt className="text-[10px] uppercase tracking-[0.06em] text-fg-subtle">{label}</dt>
    </div>
  );
}

// ── Barra de controles ──────────────────────────────────────────────────────────────────────────

const CONTROL = "h-8 rounded-lg border border-line bg-surface text-[12.5px] text-fg";

function Toolbar({
  search,
  onSearch,
  grouping,
  onGrouping,
  release,
  onRelease,
  releases,
  level,
  onLevel,
  dirty,
  onClear,
}: {
  search: string;
  onSearch: (v: string) => void;
  grouping: OutlineGrouping;
  onGrouping: (g: OutlineGrouping) => void;
  release: string;
  onRelease: (v: string) => void;
  releases: { id: string; name: string; count: number }[];
  level: number;
  onLevel: (n: number) => void;
  dirty: boolean;
  onClear: () => void;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <label
        className={cn(
          CONTROL,
          "flex min-w-[180px] flex-1 items-center gap-2 px-2.5 focus-within:border-line-emphasis",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Buscar story, passo ou id…"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-subtle"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch("")}
            title="Limpar busca"
            className="shrink-0 rounded-full p-0.5 text-fg-subtle transition hover:bg-surface-hover hover:text-fg"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </label>

      <Select
        label="Agrupar"
        value={grouping}
        onChange={(v) => onGrouping(v as OutlineGrouping)}
        title="Como as stories são organizadas"
        options={[
          { value: "fluxo", label: "Fluxo da jornada" },
          { value: "release", label: "Release" },
        ]}
      />

      <Select
        label="Release"
        value={release}
        onChange={onRelease}
        title="Mostrar apenas uma release"
        options={[
          { value: "", label: "Todas" },
          ...releases.map((r) => ({ value: r.id, label: `${r.name} · ${r.count}` })),
        ]}
      />

      <div
        role="group"
        aria-label="Profundidade da árvore"
        className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-line bg-inset p-0.5"
      >
        <span className="px-1.5 text-[11px] text-fg-subtle">Abrir até</span>
        {LEVELS.map((l) => (
          <button
            key={l.n}
            type="button"
            title={l.hint}
            aria-pressed={level === l.n}
            onClick={() => onLevel(l.n)}
            className={cn(
              "rounded-[6px] px-2 py-1 text-[12px] font-medium transition",
              level === l.n ? "bg-surface font-semibold text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={onClear}
        disabled={!dirty}
        className={cn(
          CONTROL,
          "px-3 font-medium transition disabled:cursor-default disabled:border-transparent disabled:text-fg-subtle/60",
          dirty && "hover:border-line-emphasis",
        )}
      >
        Limpar
      </button>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  title?: string;
}) {
  return (
    <span className={cn(CONTROL, "inline-flex items-center overflow-hidden")} title={title}>
      <span className="pl-2.5 pr-1 text-[11px] text-fg-subtle">{label}</span>
      {/* O `<select>` nativo se dimensiona pela OPÇÃO MAIS LONGA — com nomes de release compridos
          ("MVP — Descobrir e voltar") ele engolia meia barra. O teto corta a largura, não a lista. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-full max-w-[9.5rem] cursor-pointer appearance-none truncate bg-transparent py-0 pl-1 pr-6 text-[12.5px] font-medium text-fg outline-none"
        style={{
          backgroundImage:
            "linear-gradient(45deg,transparent 49%,currentColor 50%),linear-gradient(-45deg,transparent 49%,currentColor 50%)",
          backgroundSize: "4px 4px, 4px 4px",
          backgroundPosition: "calc(100% - 12px) 13px, calc(100% - 8px) 13px",
          backgroundRepeat: "no-repeat",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11.5px] text-fg transition hover:border-line-emphasis"
    >
      {label}
      <X className="h-3 w-3 text-fg-subtle" />
    </button>
  );
}

// ── A linha ─────────────────────────────────────────────────────────────────────────────────────

function OutlineRowView({
  row,
  config,
  showMeta,
  onToggle,
  onOpen,
  onCreate,
  onMoveUp,
  onMoveDown,
  onRelease,
  releases,
}: {
  row: OutlineRow;
  config: BoardConfig;
  showMeta: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onCreate: (init: { type: Card["type"]; parent?: string | null; release?: string | null }) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRelease: (v: string) => void;
  releases: { id: string; name: string; count: number }[];
}) {
  const rails = (
    <>
      {Array.from({ length: row.depth }, (_, i) => (
        <span key={i} className="shrink-0 border-l border-line-muted" style={{ width: RAIL }} />
      ))}
    </>
  );

  if (row.kind === "add") {
    return (
      <div className="flex items-stretch">
        {rails}
        <button
          type="button"
          onClick={() => row.add && onCreate(row.add)}
          className="flex flex-1 items-center gap-2 py-1.5 pl-2 text-left text-[12px] text-fg-subtle transition hover:text-fg"
        >
          <Plus className="h-3.5 w-3.5" />
          {row.title}
        </button>
      </div>
    );
  }

  const isBackboneRow = row.kind === "activity" || row.kind === "release" || row.kind === "orphans";
  const clickable = row.expandable || !!row.card;
  const handleClick = () => {
    if (row.expandable) return onToggle();
    if (row.card) return onOpen(row.card.id);
  };

  return (
    <div className={cn("group flex items-stretch border-t border-line-muted first:border-t-0", isBackboneRow && "border-line")}>
      {rails}
      <div
        role={clickable ? "button" : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? handleClick : undefined}
        onKeyDown={
          clickable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleClick();
                }
              }
            : undefined
        }
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden rounded-md pl-1.5 pr-1 transition",
          clickable && "cursor-pointer hover:bg-surface-hover",
          row.kind === "activity" || row.kind === "release" || row.kind === "orphans" ? "py-3" : "py-2",
        )}
      >
        <Chevron expandable={row.expandable} expanded={row.expanded} />

        {(row.kind === "story" || row.kind === "delivery") && row.state && <StateDot state={row.state} />}

        {/* O TÍTULO manda: ele é `flex-1`, então cresce com a linha e é o último a apertar — o que
            aperta primeiro é o metadado (que tem teto e corta). Sem isso, ligar "Detalhes" espremia
            o título a "Re…" para caber uma fileira de chips. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate sm:min-w-[12rem]",
            row.kind === "activity" && "text-[17px] font-semibold tracking-tight text-fg sm:text-[19px]",
            row.kind === "release" && "text-[17px] font-semibold tracking-tight text-fg sm:text-[19px]",
            row.kind === "orphans" && "text-[15px] font-semibold text-fg",
            row.kind === "step" && "text-[14.5px] font-medium text-fg",
            row.kind === "story" && "text-[13.5px] text-fg",
            row.kind === "delivery" && "text-[12.5px] text-fg-muted",
            row.state === "archived" && "line-through decoration-fg-subtle/60",
          )}
        >
          {row.title}
        </span>

        {row.eyebrow && row.eyebrowKind === "type" && (
          <span className="shrink-0 rounded border border-line px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            {row.eyebrow}
          </span>
        )}
        {row.eyebrow && row.eyebrowKind === "coord" && (
          <span className="hidden shrink-0 font-mono text-[10px] text-fg-subtle sm:inline">{row.eyebrow}</span>
        )}
        {row.eyebrow && row.eyebrowKind === "context" && (
          <span className="hidden max-w-[30%] shrink-0 truncate text-[11.5px] text-fg-subtle sm:inline">
            {row.eyebrow}
          </span>
        )}
        {/* "Detalhes" (o olho no header) promete personas e sistemas — o vocabulário do card — além
            do id. Só no desktop: no celular a linha já disputa cada pixel com o título. */}
        {showMeta && row.card && (
          // Teto + corte no FIM: cada ficha guarda a largura natural (`shrink-0`) e quem não coube
          // fica cortada na borda direita — como uma lista que continua. Sem isso a PRIMEIRA ficha
          // (o id) encolhia até virar uma letra solta, que não é informação nenhuma.
          <span className="hidden max-w-[32%] items-center gap-1 overflow-hidden sm:flex">
            <span className={cn(idChip, "shrink-0")}>{row.card.id}</span>
            {row.card.personas.map((pid) => (
              <MetaBadge
                key={`p-${pid}`}
                className="shrink-0"
                label={config.personas.find((x) => x.id === pid)?.name ?? pid}
              />
            ))}
            {row.card.systems.map((sid) => (
              <MetaBadge
                key={`s-${sid}`}
                className="shrink-0"
                label={config.systems.find((x) => x.id === sid)?.name ?? sid}
              />
            ))}
          </span>
        )}

        {/* Ações da linha — aparecem no hover/foco para não competirem com o texto. */}
        {(onMoveUp || onMoveDown) && (
          <span className="hidden shrink-0 items-center opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 sm:flex">
            <RowIconButton label="Subir" disabled={!onMoveUp} onClick={onMoveUp}>
              ↑
            </RowIconButton>
            <RowIconButton label="Descer" disabled={!onMoveDown} onClick={onMoveDown}>
              ↓
            </RowIconButton>
          </span>
        )}

        {row.kind === "story" && (
          <ReleasePicker
            value={row.releaseId ?? NO_RELEASE}
            releases={releases}
            onChange={onRelease}
          />
        )}

        {row.summary && (
          <span
            className={cn(
              "hidden shrink-0 whitespace-nowrap sm:inline",
              isBackboneRow ? "text-[12px] text-fg-muted" : "text-[11.5px] text-fg-subtle",
            )}
          >
            {row.summary}
          </span>
        )}

        {row.progress && row.progress.total > 0 && <Meter progress={row.progress} />}

        {row.card && (
          <button
            type="button"
            title="Abrir a página do card"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(row.card!.id);
            }}
            className={ROW_ACTION}
          >
            <span className="hidden sm:inline">abrir</span>
            <ExternalLink className="h-3 w-3" />
          </button>
        )}

        {row.kind === "activity" && row.card && (
          <button
            type="button"
            title="Novo passo nesta ação"
            onClick={(e) => {
              e.stopPropagation();
              onCreate({ type: "step", parent: row.card!.id });
            }}
            className={ROW_ACTION}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function Chevron({ expandable, expanded }: { expandable: boolean; expanded: boolean }) {
  if (!expandable) {
    return <CornerDownRight className="h-3 w-3 shrink-0 text-transparent" aria-hidden />;
  }
  const Icon = expanded ? ChevronDown : ChevronRight;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden />;
}

const STATE_TITLE: Record<OutlineState, string> = {
  done: "No ar",
  doing: "Em andamento",
  open: "Em aberto",
  archived: "Encerrada sem entrega",
};

function StateDot({ state }: { state: OutlineState }) {
  return (
    <span
      title={STATE_TITLE[state]}
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        state === "done" && "bg-primary",
        state === "doing" && "border-2 border-accent bg-surface",
        state === "open" && "border border-line-emphasis bg-surface",
        state === "archived" && "bg-fg/20",
      )}
    />
  );
}

/**
 * O medidor do ramo — no ar · andando · em aberto. Repete a gramática do medidor de confiança da
 * Priorização (mesmos três segmentos), então o mesmo desenho significa a mesma coisa em duas telas.
 */
function Meter({ progress }: { progress: OutlineProgress }) {
  const seg = (n: number, cls: string, label: string) =>
    n > 0 ? <span key={label} className={cn("h-full", cls)} style={{ flex: n }} title={`${n} ${label}`} /> : null;
  return (
    <span
      className="hidden h-1.5 w-[92px] shrink-0 overflow-hidden rounded-full bg-fg/[0.08] sm:flex"
      title={`${progress.done} no ar · ${progress.doing} em andamento · ${progress.open} em aberto`}
    >
      {seg(progress.done, "bg-primary", "no ar")}
      {seg(progress.doing, "bg-accent", "em andamento")}
      {seg(progress.open, "bg-fg/15", "em aberto")}
    </span>
  );
}

function RowIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="rounded px-1 text-[12px] leading-none text-fg-subtle transition hover:text-fg disabled:cursor-default disabled:text-fg-subtle/30"
    >
      {children}
    </button>
  );
}

/**
 * A release da story, editável NA LINHA. Fatiar releases é o gesto central do método (Patton) e era
 * exatamente o que o arrasto entre raias fazia; um `<select>` nativo o devolve sem arrasto — e
 * funciona no celular, onde arrastar entre raias nunca funcionou.
 */
function ReleasePicker({
  value,
  releases,
  onChange,
}: {
  value: string;
  releases: { id: string; name: string; count: number }[];
  onChange: (v: string) => void;
}) {
  const unset = value === NO_RELEASE;
  return (
    <select
      value={value}
      title="Release desta story"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        e.stopPropagation();
        onChange(e.target.value);
      }}
      className={cn(
        "hidden max-w-[11rem] shrink-0 cursor-pointer appearance-none truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[11px] outline-none transition hover:border-line sm:block",
        unset ? "text-fg-subtle" : "text-fg-muted",
      )}
    >
      {releases.map((r) => (
        <option key={r.id} value={r.id}>
          {r.id === NO_RELEASE ? "sem release" : r.name}
        </option>
      ))}
    </select>
  );
}

function EmptyBoard({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-16 text-center">
      <p className="text-[14px] font-medium text-fg">O mapa começa pela espinha dorsal.</p>
      <p className="mx-auto mt-1 max-w-sm text-[13px] leading-snug text-fg-muted">
        Uma <strong className="font-medium text-fg">ação</strong> é uma grande coisa que o usuário faz.
        Crie a primeira e depois desdobre em passos e stories.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-fg transition hover:bg-primary-hover"
      >
        <Plus className="h-4 w-4" /> Ação
      </button>
    </div>
  );
}
