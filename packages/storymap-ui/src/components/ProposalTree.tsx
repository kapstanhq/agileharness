"use client";

// <ProposalTree> — a revisão de uma proposta de captura. Usada IDÊNTICA no modal síncrono
// (SmartCaptureModal) e no Inbox (CockpitView).
//
// A leitura é "ONDE entra" × "O QUE entra": para cada lugar do mapa, uma linha de TEXTO com o caminho
// (Ação › Passo › Story) e, sob ela, só os cards que o lote vai criar — esses sim com corpo (tipo,
// motivo, tasks, duplicata acionável). O contexto NÃO é mais desenhado como nó de primeira classe: a
// versão anterior trazia a vizinhança inteira da âncora em profundidade 2 (bugs, entregas e stories
// irmãs, cada uma numa caixa tracejada) e o único card NOVO do lote se perdia no meio de vinte linhas
// de coisas que já existem e que a decisão não usa. A suspeita de duplicata continua visível onde ela
// importa — dentro do item, nomeando o card por título e com as duas saídas a um clique.
//
// A hierarquia pura mora em smart-capture/architecture-tree (buildProposalGroups); a seleção em
// cascata, em smart-capture/proposal-tree.

import { ChevronRight, CornerDownRight, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { TriCheckbox } from "@/components/TriCheckbox";
import { proposedTypeLabelText } from "@/lib/storymap/smart-capture/proposed-label";
import { nodeCheckState, type ReanchorPatch } from "@/lib/storymap/smart-capture/proposal-tree";
import {
  buildProposalGroups,
  ROOT_GROUP_KEY,
  UNANCHORED_KEY,
  type ArchitectureNode,
  type ProposalGroup,
} from "@/lib/storymap/smart-capture/architecture-tree";
import type { ProposedItem } from "@/lib/storymap/smart-capture/types";
import type { BoardConfig, Card, CardType } from "@/lib/storymap/types";
import type { StoryType } from "@/lib/storymap/frameworks";

/** ② Re-cast — os tipos (em rótulo humano) para os quais o humano pode trocar um item na revisão. */
const RECAST_OPTIONS: { value: string; label: string; type: CardType; storyType: StoryType | null }[] = [
  { value: "idea", label: "Ideia", type: "idea", storyType: null },
  { value: "user", label: "User story", type: "story", storyType: "user" },
  { value: "bug", label: "Bug", type: "story", storyType: "bug" },
  { value: "technical", label: "Técnico", type: "story", storyType: "technical" },
  { value: "chore", label: "Chore", type: "story", storyType: "chore" },
  { value: "spike", label: "Spike", type: "story", storyType: "spike" },
];
const recastValueOf = (it: ProposedItem): string =>
  it.type === "idea" ? "idea" : it.type === "story" ? it.storyType ?? "user" : "";

/** A nova âncora que uma ação de 1 clique aplica (o tipo + o `applyReanchor` vivem em proposal-tree). */
export type { ReanchorPatch };

/** Tudo que uma linha precisa — um objeto só, em vez de repetir 10 props em cada nível. */
type TreeCtx = {
  items: ProposedItem[];
  cards: Map<string, Card>;
  selected: Set<string>;
  onSelect: (tempId: string, on: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapse: (tempId: string) => void;
  onRecast?: (tempId: string, toType: CardType, toStoryType: StoryType | null) => void;
  recastingId?: string | null;
  onDisambiguate?: (item: ProposedItem, anchor: HTMLElement) => void;
  onReanchor?: (tempId: string, patch: ReanchorPatch) => void;
};

export function ProposalTree({
  items,
  cards,
  config,
  selected,
  onSelect,
  collapsed,
  onToggleCollapse,
  onSelectAll,
  onSelectNone,
  onRecast,
  recastingId,
  onDisambiguate,
  onReanchor,
}: {
  items: ProposedItem[];
  /** cards do board por id — resolvem o CAMINHO até a âncora e os títulos citados (duplicata/aborda). */
  cards: Map<string, Card>;
  config: BoardConfig;
  selected: Set<string>;
  /** caller applies cascadeSelect(items, selected, tempId, on) — keeps the parent-closed invariant. */
  onSelect: (tempId: string, on: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapse: (tempId: string) => void;
  /** when provided, shows a "Tudo / Nenhum" toolbar (caller sets selected = selectAll(items) / new Set()). */
  onSelectAll?: () => void;
  onSelectNone?: () => void;
  /** ② quando provido, o badge de tipo vira um SELECT que reclassifica (re-cast) o item. */
  onRecast?: (tempId: string, toType: CardType, toStoryType: StoryType | null) => void;
  /** tempId do item sendo reescrito agora (spinner + select desabilitado). */
  recastingId?: string | null;
  /** ③ quando provido, itens ambíguos/baixa-confiança ganham "Desambiguar" (abre o HITL ancorado na linha). */
  onDisambiguate?: (item: ProposedItem, anchor: HTMLElement) => void;
  /**
   * Reancora um item NA HORA, sem reanálise. É o que fecha o beco da duplicata: ver "parece a mesma
   * coisa que X" e poder responder "então é trabalho DE X" num clique, em vez de escrever feedback
   * em texto livre e esperar o agente repropor o lote inteiro.
   */
  onReanchor?: (tempId: string, patch: ReanchorPatch) => void;
}) {
  const groups = buildProposalGroups(items, [...cards.values()], config);
  const ctx: TreeCtx = {
    items,
    cards,
    selected,
    onSelect,
    collapsed,
    onToggleCollapse,
    onRecast,
    recastingId,
    onDisambiguate,
    onReanchor,
  };

  return (
    <div className="space-y-3.5">
      {(onSelectAll || onSelectNone) && items.length > 1 && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-fg-subtle">
            <span className="font-medium text-fg-muted">{selected.size}</span> de {items.length} selecionados
          </span>
          <span className="flex items-center gap-1">
            {onSelectAll && (
              <button
                type="button"
                onClick={onSelectAll}
                className="rounded px-1.5 py-0.5 font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                Tudo
              </button>
            )}
            {onSelectNone && (
              <button
                type="button"
                onClick={onSelectNone}
                className="rounded px-1.5 py-0.5 font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                Nenhum
              </button>
            )}
          </span>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.key} className="space-y-1.5">
          <GroupPath group={group} />
          <ul className="space-y-1.5 border-l border-line pl-3">
            {group.extendedBy.map((it) => (
              <li key={it.tempId}>
                <ExtendRow item={it} anchor={group.path[group.path.length - 1] ?? null} ctx={ctx} />
              </li>
            ))}
            {group.nodes.map((node) => (
              <TreeRow key={node.key} node={node} depth={0} ctx={ctx} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** ONDE o lote entra — uma linha de texto simples, nunca uma caixa. O último elo é o pai DIRETO. */
function GroupPath({ group }: { group: ProposalGroup }) {
  if (group.key === UNANCHORED_KEY) {
    return (
      <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
        ⚠ ainda sem lugar no mapa — nasce na Triagem esperando a decisão
      </p>
    );
  }
  if (group.key === ROOT_GROUP_KEY || group.path.length === 0) {
    return <p className="text-[11px] text-fg-subtle">no topo do mapa</p>;
  }
  return (
    <p className="flex flex-wrap items-baseline gap-x-1 text-[11px] leading-snug text-fg-subtle">
      <span>em</span>
      {group.path.map((c, i) => (
        <span key={c.id} className="flex items-baseline gap-x-1">
          {i > 0 && <span aria-hidden>›</span>}
          <span className={i === group.path.length - 1 ? "font-medium text-fg-muted" : undefined}>{c.title}</span>
        </span>
      ))}
    </p>
  );
}

/** Um item proposto — e a sua subárvore, quando o lote propõe backbone novo no mesmo lugar. */
function TreeRow({ node, depth, ctx }: { node: ArchitectureNode; depth: number; ctx: TreeCtx }) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = ctx.collapsed.has(node.key);

  return (
    <li className={depth > 0 ? "mt-1.5" : undefined}>
      <div className="flex items-start gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => ctx.onToggleCollapse(node.key)}
            className="mt-2 shrink-0 text-fg-subtle transition hover:text-fg"
            aria-label={isCollapsed ? "Expandir" : "Colapsar"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 transition", !isCollapsed && "rotate-90")} />
          </button>
        ) : null}
        <ProposedCard item={node.item!} ctx={ctx} />
      </div>

      {hasChildren && !isCollapsed && (
        <ul className="ml-2 border-l border-line pl-3">
          {node.children.map((child) => (
            <TreeRow key={child.key} node={child} depth={depth + 1} ctx={ctx} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A casca dos itens do lote — a ÚNICA superfície com corpo, porque é a única que decide algo. */
function ItemShell({
  state,
  accent,
  label,
  onToggle,
  children,
}: {
  state: "on" | "off" | "indeterminate";
  accent?: boolean;
  label: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 flex-1 cursor-pointer select-none items-start gap-2.5 rounded-lg border px-3 py-2 transition",
        state === "off"
          ? "border-line/60 bg-transparent opacity-45 hover:opacity-70"
          : accent
            ? "border-accent/40 bg-accent/[0.06]"
            : "border-line bg-inset",
      )}
    >
      <TriCheckbox state={state} onChange={onToggle} className="mt-0.5" label={label} />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

/** Um card que o lote vai CRIAR — selecionável, reclassificável e reancorável. */
function ProposedCard({ item: it, ctx }: { item: ProposedItem; ctx: TreeCtx }) {
  const { items, cards, selected, onSelect, onRecast, recastingId, onDisambiguate, onReanchor } = ctx;
  const state = nodeCheckState(items, selected, it.tempId);
  const dup = it.duplicateOf ? cards.get(it.duplicateOf) : null;
  const isIdea = it.type === "idea";
  const isUserStory = it.type === "story" && (it.storyType ?? "user") === "user";
  const tasks = it.tasks ?? [];
  const lowConfidence = it.confidence != null && it.confidence < 0.6;

  return (
    <ItemShell
      state={state}
      accent={isIdea}
      label={`Incluir ${it.title}`}
      onToggle={() => onSelect(it.tempId, state !== "on")}
    >
      <span className="block text-[13px] font-medium leading-snug text-fg">{it.title}</span>

      {/* Meta — o que ele É fica em segundo plano: quem carrega a decisão é o título. */}
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-fg-subtle">
        {onRecast && (it.type === "idea" || it.type === "story") ? (
          <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <select
              value={recastValueOf(it)}
              disabled={recastingId === it.tempId}
              onChange={(e) => {
                const opt = RECAST_OPTIONS.find((o) => o.value === e.target.value);
                if (opt && opt.value !== recastValueOf(it)) onRecast(it.tempId, opt.type, opt.storyType);
              }}
              className={cn(
                "rounded border border-line bg-surface px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide outline-none transition focus:border-accent disabled:opacity-50",
                isIdea ? "text-accent" : "text-fg-muted",
              )}
              aria-label="Tipo do item — trocar reclassifica (reescreve o conteúdo no novo formato)"
            >
              {RECAST_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {recastingId === it.tempId && <Loader2 className="h-3 w-3 animate-spin text-fg-subtle" />}
          </span>
        ) : (
          <span className={cn("font-medium", isIdea ? "text-accent" : "text-fg-muted")}>
            {proposedTypeLabelText(it)}
          </span>
        )}
        {tasks.length > 0 && (
          <span>
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
        )}
        {lowConfidence && (
          <span
            className="font-medium text-amber-700 dark:text-amber-400"
            title={it.ambiguous ? "Classificação ambígua — confira o tipo" : "Baixa confiança na classificação"}
          >
            ⚠ tipo incerto ({Math.round(it.confidence! * 100)}%)
          </span>
        )}
        {onDisambiguate && (it.ambiguous || lowConfidence) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDisambiguate(it, e.currentTarget);
            }}
            className="rounded px-1 py-0.5 font-medium text-accent transition hover:bg-accent/10"
            title="Conversar com o agente para decidir o tipo certo"
          >
            Desambiguar
          </button>
        )}
      </span>

      {it.rationale && <span className="mt-1 block text-[11px] leading-snug text-fg-muted">{it.rationale}</span>}

      {it.addresses && (
        <span className="mt-1 block text-[11px] leading-snug text-accent/90">
          → aborda: «
          {cards.get(it.addresses)?.title ?? items.find((x) => x.tempId === it.addresses)?.title ?? it.addresses}»
        </span>
      )}

      {tasks.length > 0 && <TaskList tasks={tasks} />}

      {/* A SUSPEITA DE DUPLICATA, acionável. Ver o aviso e não ter o que fazer com ele era o beco: a
          resposta certa quase sempre é "então isto é trabalho DENTRO daquele card". As duas saídas
          ficam a um clique, sem reanálise — e o alvo aparece pelo TÍTULO, não pelo id cru. */}
      {dup && (
        <span
          className="mt-1.5 block rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] leading-snug"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="block font-medium text-amber-700 dark:text-amber-300">
            ⚠ parece a mesma coisa que «{dup.title}»
          </span>
          {onReanchor && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  onReanchor(it.tempId, {
                    parent: null,
                    serves: dup.id,
                    storyType: isUserStory ? "technical" : it.storyType ?? "technical",
                    targetCardId: null,
                  })
                }
                className="inline-flex items-center gap-1 rounded border border-accent/40 px-1.5 py-0.5 font-medium text-accent transition hover:bg-accent/10"
                title={`Transformar em uma entrega que serve «${dup.title}»`}
              >
                <CornerDownRight className="h-3 w-3" /> Virar entrega dele
              </button>
              {tasks.length > 0 && (
                <button
                  type="button"
                  onClick={() => onReanchor(it.tempId, { targetCardId: dup.id, parent: null, serves: null })}
                  className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
                  title={`Não criar card — acrescentar as ${tasks.length} tasks em «${dup.title}»`}
                >
                  <Plus className="h-3 w-3" /> Só somar as tasks nele
                </button>
              )}
            </span>
          )}
        </span>
      )}
    </ItemShell>
  );
}

/**
 * Um item em modo ESTENDER: não cria card nenhum, só acrescenta tasks ao card no fim do caminho. Fica
 * na mesma casca dos demais (com checkbox) porque responde à mesma pergunta — "isto entra?" —, e antes
 * ela simplesmente não podia ser respondida: o item vinha marcado e sem como desmarcar.
 */
function ExtendRow({ item: it, anchor, ctx }: { item: ProposedItem; anchor: Card | null; ctx: TreeCtx }) {
  const state = nodeCheckState(ctx.items, ctx.selected, it.tempId);
  const tasks = it.tasks ?? [];

  return (
    <ItemShell state={state} label={`Incluir ${it.title}`} onToggle={() => ctx.onSelect(it.tempId, state !== "on")}>
      <span className="flex items-baseline gap-1.5 text-[13px] font-medium leading-snug text-fg">
        <Plus className="h-3 w-3 shrink-0 translate-y-0.5 text-accent" aria-hidden />
        {tasks.length} {tasks.length === 1 ? "task" : "tasks"} neste card
      </span>
      {/* O caminho acima já termina no card-alvo — repetir o título aqui só alongaria a linha. */}
      <span className="mt-0.5 block text-[11px] text-fg-subtle">
        {anchor ? "nenhum card novo — as tasks entram no card acima" : "nenhum card novo — as tasks entram no card-alvo"}
      </span>
      {tasks.length > 0 && <TaskList tasks={tasks} />}
      {ctx.onReanchor && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            ctx.onReanchor!(it.tempId, { targetCardId: null, serves: anchor?.id ?? null, storyType: "technical" });
          }}
          className="mt-1 rounded px-1 py-0.5 text-[11px] font-medium text-accent transition hover:bg-accent/10"
          title="Em vez de acrescentar tasks aqui, criar uma entrega própria servindo este card"
        >
          Prefiro uma entrega separada
        </button>
      )}
    </ItemShell>
  );
}

function TaskList({ tasks }: { tasks: { id?: string; title: string }[] }) {
  return (
    <span className="mt-1 block space-y-0.5">
      {tasks.map((t, i) => (
        <span key={t.id ?? i} className="flex items-baseline gap-1.5 text-[11px] leading-snug text-fg-muted">
          <span className="text-fg-subtle" aria-hidden>
            ·
          </span>
          <span className="min-w-0 flex-1">{t.title}</span>
        </span>
      ))}
    </span>
  );
}
