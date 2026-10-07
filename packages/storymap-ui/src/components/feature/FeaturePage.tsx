"use client";

// A PÁGINA DA FUNCIONALIDADE (fase 7) — aonde leva o título do card do Kanban. De cima para baixo:
//   • o nome e a DESCRIÇÃO da funcionalidade, como o PRD a escreve (só leitura; «Ver no PRD» leva ao documento);
//   • «Pedir item novo» — abre o chat do Jido com a funcionalidade em contexto e o pedido escrito (nunca enviado);
//   • os itens por estado: «Agora» em destaque (o que está sendo feito), «Precisa de você», «Próximo» — cada linha abre
//     o item —, e «Feito» recolhido, com a Prova da entrega de cada item.
// O estado de cada item é o MESMO do Kanban (kanban/use-flow-states.ts); as seções e a ordem saem de feature-page.ts.
// Não entram (decisão do dono): reordenar itens, editar a descrição do PRD aqui.

import { useCallback, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { cardHref } from "@/lib/storymap/deep-links";
import { displayTitle, nameCardIds } from "@/lib/storymap/display-title";
import { batchKindWords, batchMates, kindOf, type FlowState } from "@/lib/storymap/kanban-features";
import {
  featurePageSections,
  newItemDraft,
  sectionsSummary,
  type FeatureDoneItem,
  type FeatureHead,
  type FeaturePageItem,
} from "@/lib/storymap/feature-page";
import type { OwnerDecisions } from "@/lib/storymap/inbox/decidir-set";
import type { BoardConfig, BoardSummary, Card } from "@/lib/storymap/types";
import { BoardHeader } from "@/components/BoardHeader";
import { BackButton } from "@/components/nav/NavShell";
import { Markdown } from "@/components/Markdown";
import { openJidoChat } from "@/components/chat/jido-bus";
import { useNow } from "@/components/inbox/useNow";
import { PRIMARY_BTN, STATE_TONE } from "@/components/kanban/kanban-tokens";
import { useFlowStates } from "@/components/kanban/use-flow-states";

export interface FeaturePageProps {
  config: BoardConfig;
  boards: BoardSummary[];
  owner: OwnerDecisions | null;
  feature: FeatureHead;
  /** os itens da funcionalidade (abertos e feitos), já enxutos para o navegador. */
  items: Card[];
  /** a Prova da entrega de cada item feito (lida do corpo no servidor). */
  proofs: Record<string, string | null>;
  /** quando cada item chegou ao ar (epoch ms, do ledger). */
  arrivals: Record<string, number>;
}

const EYEBROW: Readonly<Record<FeatureHead["source"], string>> = {
  prd: "Funcionalidade",
  outros: "Fora do PRD",
  map: "Funcionalidade",
};

/** O texto da descrição vazia, pela origem (a página nunca abre com um buraco sem explicação). */
const NO_DESCRIPTION: Readonly<Record<FeatureHead["source"], string>> = {
  prd: "O PRD ainda não descreve esta funcionalidade.",
  outros: "",
  map: "O PRD deste board ainda não lista as funcionalidades — por isso esta não tem descrição.",
};

/** Markdown vindo de fora (o PRD, a prova): nada empurra a página para o lado — bloco de código e tabela rolam sozinhos. */
const PROSE_FIT = "min-w-0 [overflow-wrap:anywhere] [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

export function FeaturePage({ config, boards, owner, feature, items, proofs, arrivals }: FeaturePageProps) {
  const now = useNow(60_000);
  // os abertos levam a régua viva; os feitos não precisam (o estado deles é o fim do fluxo)
  const terminal = useMemo(() => new Set(config.statuses.filter((s) => s.terminal === true).map((s) => s.id)), [config]);
  const open = useMemo(() => items.filter((c) => !(c.status != null && terminal.has(c.status))), [items, terminal]);
  const { stateOf, live, lanes } = useFlowStates(config, open, owner, now);
  const laneIndex = useMemo(() => {
    const at = new Map<string, number>();
    lanes.forEach((l, i) => l.statuses.forEach((s) => at.set(s, i)));
    return at;
  }, [lanes]);
  const sections = useMemo(
    () =>
      featurePageSections(items, {
        stateOf,
        config,
        proofOf: (id) => proofs[id] ?? null,
        laneOf: (c) => (c.status != null ? (laneIndex.get(c.status) ?? -1) : -1),
        arrivedAt: (id) => arrivals[id],
      }),
    [items, stateOf, config, proofs, laneIndex, arrivals],
  );

  const askRef = useRef<HTMLButtonElement>(null);
  const ask = () => {
    const draft = newItemDraft(displayTitle(feature.title));
    if (feature.source === "prd") openJidoChat({ feature: { id: feature.id, title: feature.title }, draft, returnFocus: askRef.current });
    // sem funcionalidade no PRD, o contexto é o próprio passo do mapa (um card): o item novo nasce servindo a ele
    else openJidoChat({ cardId: feature.id, cardTitle: feature.title, draft, returnFocus: askRef.current });
  };

  const stepName = (c: Card) => config.statuses.find((s) => s.id === c.status)?.name ?? c.status ?? "";
  const noteOf = (c: Card) => {
    const l = live.get(c.id);
    return l ? (l.note ?? l.label) : "";
  };
  // O dono lê o NOME do item, não o id: a descrição (o corpo do passo do mapa, escrito por agentes) e a prova citam
  // itens desta funcionalidade pelo id («ex9101») — na tela, o título curto deles (display-title.ts `nameCardIds`).
  // O id segue no `title` da linha de cada item.
  const description = useMemo(() => (feature.description ? nameCardIds(feature.description, items) : feature.description), [feature.description, items]);
  const named = useCallback((text: string) => nameCardIds(text, items), [items]);
  const agoraBatch = sections.agora.length >= 2 ? batchMates(sections.agora[0].card, sections.agora.map((i) => i.card)) : [];
  const empty = !items.length;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-canvas">
      <BoardHeader boards={boards} config={config} view="kanban" />
      <main
        className="mx-auto flex w-full min-w-0 max-w-[760px] flex-1 flex-col px-4 pt-4 md:px-6 md:pt-8"
        // o último item nunca fica embaixo do compositor do Jido (fixo no rodapé)
        style={{ paddingBottom: "calc(var(--jido-composer-h, 96px) + 24px)" }}
      >
        <BackButton
          fallbackHref={`/board/${config.id}/kanban`}
          title="Voltar ao Kanban"
          className="-ml-2 flex items-center gap-1.5 self-start rounded-md px-2 text-[13px] text-fg-muted transition hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-10 md:h-8"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Voltar
        </BackButton>

        <header className="mt-3 flex flex-col gap-1.5">
          <p className="text-[12px] font-semibold uppercase tracking-[.04em] text-fg-subtle">{EYEBROW[feature.source]}</p>
          <h1 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.015em] text-fg-strong [overflow-wrap:anywhere] [text-wrap:balance] md:text-[26px]">
            {displayTitle(feature.title)}
          </h1>
          <p className="text-[13px] text-fg-subtle">{sectionsSummary(sections)}</p>
        </header>

        {/* A caixa tem o próprio respiro (p-4): a margem do 1º e do último bloco do markdown (my-2) e o alvo de toque do
            «Ver no PRD» somavam um vão a mais em cima e embaixo — o markdown zera as pontas e o link compensa o próprio
            preenchimento com margem negativa (o alvo de 40px no celular fica). */}
        <section aria-label="Descrição" className="mt-4 flex flex-col gap-2.5 rounded-xl border border-line-muted bg-surface p-4">
          {description ? (
            feature.source === "outros" ? (
              <p className="text-[14px] leading-[1.5] text-fg">{description}</p>
            ) : (
              <Markdown variant="compact" className={cn("text-[14px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", PROSE_FIT)}>
                {description}
              </Markdown>
            )
          ) : (
            <p className="text-[14px] text-fg-subtle">{NO_DESCRIPTION[feature.source]}</p>
          )}
          {feature.source === "prd" && (
            <Link
              href={`/board/${config.id}/produto`}
              className="self-start rounded-sm text-[13px] text-fg-muted underline decoration-line-emphasis underline-offset-2 transition hover:text-fg hover:decoration-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:-my-2.5 max-md:py-2.5"
            >
              Ver no PRD
            </Link>
          )}
        </section>

        {feature.source !== "outros" && (
          <button ref={askRef} type="button" onClick={ask} className={cn(PRIMARY_BTN, "mt-4 gap-1.5 self-start max-md:h-10")}>
            <Plus className="h-3.5 w-3.5" aria-hidden strokeWidth={2.4} />
            Pedir item novo
          </button>
        )}

        {empty ? (
          <p className="mt-6 text-[14px] text-fg-subtle">Nenhum item nesta funcionalidade ainda.</p>
        ) : (
          <>
            <Section title="Agora" count={sections.agora.length} highlight>
              {sections.agora.length === 0 ? (
                <p className="px-1 py-1 text-[13px] text-fg-subtle">Nada sendo feito agora.</p>
              ) : (
                <>
                  {agoraBatch.length >= 2 && (
                    <p className="px-1 pb-1 text-[13px] text-fg">
                      <b className="font-semibold">Em lote:</b> {batchKindWords(agoraBatch)} numa sessão só.
                    </p>
                  )}
                  <ItemList boardId={config.id} items={sections.agora} stepName={stepName} noteOf={noteOf} />
                </>
              )}
            </Section>
            {sections.precisaDeVoce.length > 0 && (
              <Section title="Precisa de você" count={sections.precisaDeVoce.length}>
                <ItemList boardId={config.id} items={sections.precisaDeVoce} stepName={stepName} noteOf={noteOf} />
              </Section>
            )}
            {sections.proximo.length > 0 && (
              <Section title="Próximo" count={sections.proximo.length}>
                <ItemList boardId={config.id} items={sections.proximo} stepName={stepName} noteOf={() => ""} />
              </Section>
            )}
            {sections.feito.length > 0 && <DoneSection boardId={config.id} items={sections.feito} named={named} />}
          </>
        )}
      </main>
    </div>
  );
}

function Section({ title, count, highlight, children }: { title: string; count: number; highlight?: boolean; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("mt-6 flex flex-col gap-2", highlight && "rounded-xl border border-st-run/30 bg-st-run/[0.05] p-2.5 md:p-3")}>
      <h2 id={id} className="flex items-baseline gap-2 px-1 text-[14px] font-semibold text-fg">
        {title}
        <span className="text-[13px] font-normal tabular-nums text-fg-subtle">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function ItemList({
  boardId,
  items,
  stepName,
  noteOf,
}: {
  boardId: string;
  items: FeaturePageItem[];
  stepName: (c: Card) => string;
  noteOf: (c: Card) => string;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map(({ card, state, deferred }) => (
        <li key={card.id}>
          <ItemRow boardId={boardId} card={card} state={state} deferred={deferred} step={stepName(card)} note={noteOf(card)} />
        </li>
      ))}
    </ul>
  );
}

function ItemRow({ boardId, card, state, deferred, step, note }: { boardId: string; card: Card; state: FlowState; deferred: boolean; step: string; note: string }) {
  const tone = STATE_TONE[state];
  const facts = [kindOf(card), step, deferred ? "adiado" : "", note].filter(Boolean);
  return (
    <Link
      href={cardHref(boardId, card.id)}
      // o id e o título gravado (com a etiqueta de máquina, se houver) ficam no `title` — fora do texto visível
      title={`${card.title} (${card.id})`}
      className="flex min-w-0 items-start gap-2.5 rounded-lg border border-line-muted bg-surface px-3 py-2.5 transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11"
    >
      <span aria-hidden className={cn(tone.quietDot, "mt-[7px]")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-medium leading-[1.35] text-fg [overflow-wrap:anywhere]">{displayTitle(card.title)}</span>
        <span className="text-[12px] leading-[1.4] text-fg-subtle [overflow-wrap:anywhere]">
          <span className={cn("font-semibold", tone.ink)}>{tone.label}</span>
          {facts.map((f, i) => (
            <span key={i}>
              <span aria-hidden className="text-line-emphasis"> · </span>
              {f}
            </span>
          ))}
        </span>
      </span>
    </Link>
  );
}

/** «Feito», recolhido por padrão: cada item com a Prova da entrega que o card registrou. */
function DoneSection({ boardId, items, named }: { boardId: string; items: FeatureDoneItem[]; named: (text: string) => string }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <section className="mt-6 flex flex-col gap-2">
      <h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={listId}
          className="flex w-full items-center gap-2 rounded-lg px-1 text-left text-[14px] font-semibold text-fg transition hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 md:h-8"
        >
          Feito
          <span className="text-[13px] font-normal tabular-nums text-fg-subtle">{items.length}</span>
          <ChevronDown
            aria-hidden
            strokeWidth={2.4}
            className={cn("ml-auto h-4 w-4 text-fg-subtle transition-transform motion-reduce:transition-none", open && "rotate-180")}
          />
        </button>
      </h2>
      {open && (
        <ul id={listId} className="flex flex-col gap-1.5">
          {items.map(({ card, proof }) => (
            <li key={card.id} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line-muted bg-surface px-3 py-2.5">
              <Link
                href={cardHref(boardId, card.id)}
                title={`${card.title} (${card.id})`}
                className="flex items-center gap-2 self-start rounded-md text-[14px] font-medium leading-[1.35] text-fg [overflow-wrap:anywhere] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-10"
              >
                <span aria-hidden className={STATE_TONE.live.quietDot} />
                {displayTitle(card.title)}
              </Link>
              <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-fg-subtle">Prova da entrega</p>
              {proof ? (
                <Markdown variant="compact" className={cn("text-[13px]", PROSE_FIT)}>
                  {named(proof)}
                </Markdown>
              ) : (
                <p className="text-[13px] text-fg-subtle">Sem prova da entrega registrada.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
