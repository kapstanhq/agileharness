"use client";

// /perguntas — the human-in-the-loop "Central de Ações / Precisa de você". ONE cross-board surface
// for everything that needs the orchestrator: open agent QUESTIONS (answered inline — the answer
// rides the card spec for the next skill) PLUS every other pending demand (blocker findings,
// low-confidence triage, human gates) derived from the single source of truth `cardDemands`. Live:
// it subscribes to the SAME multiplexed SSE bus the board uses — any card change (ask/answer/move)
// re-pulls the server queue, so demands appear and resolved ones leave without a manual refresh.

import { useEffect, useRef, useState, useTransition } from "react";
import { sharedEventSource } from "@/lib/sse-bus";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { answerQuestionAction } from "@/app/actions";
import type { CardQuestion } from "@/lib/storymap/types";
import { DEMAND_GROUP_LABEL, type Demand, type DemandType } from "@/lib/storymap/demands";
import { demandHref, inboxFocusHref } from "@/lib/storymap/deep-links";
import { EscalateButton } from "@/components/copilot/EscalateButton";

/** One card with ≥1 open question — the inline-answer unit (built by the server page). */
export interface QueueCard {
  boardId: string;
  boardName: string;
  cardId: string;
  cardTitle: string;
  statusName: string | null;
  questions: CardQuestion[]; // OPEN only
  oldestAskedAt: string | null;
}

// The order demand groups are shown in the "Outras ações" section (most urgent kinds first).
// ⚠️ A página CONTA todas as demandas no total do cabeçalho mas só RENDERIZA as que aparecem AQUI — uma que
// falte vira linha FANTASMA (o cabeçalho diz "3 pendências" e a lista mostra 2). Era exatamente o caso de
// `release-aging` e `deploy-unsettled`: os rótulos já existiam em DEMAND_GROUP_LABEL, as linhas nunca saíam.
const GROUP_ORDER = [
  "deploy-failed", // F8 — a mais urgente que existe: pronta, aprovada, e FORA DO AR
  "merge-conflict",
  "blocker",
  "merge-gate-failed",
  "deploy-unsettled",
  "release-aging",
  "review",
  "gate",
] as const satisfies readonly DemandType[];

// …e a trava que impede a linha fantasma de VOLTAR: toda DemandType tem de estar em GROUP_ORDER, exceto
// `question` (renderizada na seção própria acima, com UX de resposta inline). Uma DemandType nova que ninguém
// posicionar faz Exclude<> deixar de ser `never` → AssertNever não compila → o build quebra na cara do autor.
type AssertNever<T extends never> = T;
type _EveryDemandTypeIsRendered = AssertNever<Exclude<DemandType, "question" | (typeof GROUP_ORDER)[number]>>;

export function QuestionsQueue({ initial, otherDemands = [] }: { initial: QueueCard[]; otherDemands?: Demand[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const filterBoard = params.get("board");
  const filterCard = params.get("card");
  const isFiltered = !!(filterBoard && filterCard);

  // When a board+card filter is active, show only that card's questions.
  const visibleInitial = isFiltered
    ? initial.filter((c) => c.boardId === filterBoard && c.cardId === filterCard)
    : initial;
  const visibleDemands = isFiltered ? [] : otherDemands;

  // Real-time: any card mutation on the SSE bus (incl. an ask/answer/move, which writes the card .md)
  // may change the queue → debounce a server refresh. Reuses the bus the kanban already speaks.
  useEffect(() => {
    const es = sharedEventSource("/api/notifications/stream");
    let t: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(t);
      t = setTimeout(() => router.refresh(), 300);
    };
    es.addEventListener("storymap", refresh as EventListener);
    return () => {
      clearTimeout(t);
      es.close();
    };
  }, [router]);

  const totalQuestions = visibleInitial.reduce((n, c) => n + c.questions.length, 0);
  const totalDemands = totalQuestions + visibleDemands.length;
  const grouped = GROUP_ORDER.map((type) => ({ type, items: visibleDemands.filter((d) => d.type === type) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <main className="mx-auto max-w-3xl p-6 sm:p-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Precisa de você</h1>
        <p className="mt-0.5 text-sm text-fg-muted">
          {totalDemands > 0
            ? `${totalDemands} pendência${totalDemands === 1 ? "" : "s"} aguardando você.`
            : "Nada precisa de você agora."}{" "}
          Os agentes seguem assim que você resolve.
        </p>
        {isFiltered && (
          <div className="mt-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-hover px-2.5 py-1 text-[11px] font-medium text-fg-muted">
              card {filterCard}
            </span>
            <Link
              href="/perguntas"
              className="text-[11px] text-accent transition hover:underline"
            >
              ver todas
            </Link>
          </div>
        )}
      </header>

      {totalDemands === 0 ? (
        <p className="rounded-md border border-line bg-surface p-6 text-center text-sm text-fg-muted">
          {isFiltered
            ? "Nenhuma pergunta aberta para este card."
            : "Nada pendente. Quando um agente levanta uma incógnita, deixa um bloqueio de revisão, ou um card chega a uma parada humana (aprovar design/entrega, publicar, resolver conflito), aparece aqui para você agir."}
        </p>
      ) : (
        <div className="space-y-8">
          {visibleInitial.length > 0 && (
            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                {DEMAND_GROUP_LABEL.question} · {totalQuestions}
              </h2>
              <ul className="space-y-3">
                {visibleInitial.map((c) => (
                  <CardBlock key={`${c.boardId}/${c.cardId}`} card={c} />
                ))}
              </ul>
            </section>
          )}

          {grouped.map((g) => (
            <section key={g.type}>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                {DEMAND_GROUP_LABEL[g.type]} · {g.items.length}
              </h2>
              <ul className="overflow-hidden rounded-md border border-line bg-surface divide-y divide-line">
                {g.items.map((d) => (
                  <DemandRow key={`${d.boardId}/${d.cardId}/${d.type}`} demand={d} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

const SEVERITY_DOT: Record<Demand["severity"], string> = {
  critical: "bg-rose-500",
  high: "bg-amber-500",
  medium: "bg-sky-500",
  low: "bg-fg-subtle",
};

/** A non-question demand — a tappable row that deep-links to the card where the action lives. */
function DemandRow({ demand }: { demand: Demand }) {
  return (
    <li>
      <Link
        href={demandHref(demand)}
        className="flex items-center gap-2.5 px-3 py-2.5 transition hover:bg-surface-hover"
        title="Abrir no Inbox"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[demand.severity]}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">{demand.cardTitle}</span>
          <span className="text-[11px] text-fg-muted">{demand.label}</span>
        </span>
        <span className="shrink-0 font-mono text-[10px] text-fg-subtle">{demand.cardId}</span>
      </Link>
    </li>
  );
}

function CardBlock({ card }: { card: QueueCard }) {
  return (
    <li className="overflow-hidden rounded-md border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-hover px-3 py-2">
        <Link
          href={inboxFocusHref(card.boardId, card.cardId)}
          className="text-[13px] font-medium text-fg transition hover:text-accent"
          title="Abrir no Inbox"
        >
          {card.cardTitle}
        </Link>
        <span className="text-[11px] text-fg-subtle">·</span>
        <span className="text-[11px] font-medium text-fg-muted">{card.boardName}</span>
        {card.statusName && (
          <>
            <span className="text-[11px] text-fg-subtle">·</span>
            <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
              {card.statusName}
            </span>
          </>
        )}
        <span className="ml-auto font-mono text-[10px] text-fg-subtle">{card.cardId}</span>
      </header>
      <ul className="divide-y divide-line">
        {card.questions.map((q) => (
          <QuestionRow key={q.id} boardId={card.boardId} cardId={card.cardId} q={q} />
        ))}
      </ul>
    </li>
  );
}

/** Exported so CockpitView (inbox) can reuse the inline-answer UX without duplicating it. */
export function QuestionRow({ boardId, cardId, q }: { boardId: string; cardId: string; q: CardQuestion }) {
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const text = answer.trim();
    if (!text || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await answerQuestionAction({ boardId, cardId, questionId: q.id, answer: text });
      if (res.ok) {
        setAnswer("");
        router.refresh(); // the answered question drops out of the queue on the next server pull
      } else {
        setError(res.error);
      }
    });
  };

  // Cmd/Ctrl+Enter submits — the efficient keyboard path for draining the queue.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <li className="px-3 py-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 select-none text-[11px] font-mono text-fg-subtle">{q.id}</span>
        <p className="flex-1 text-[13px] leading-snug text-fg">{q.text}</p>
      </div>
      {(q.askedBy || q.askedAt) && (
        <p className="mt-1 pl-7 text-[10px] text-fg-subtle">
          {q.askedBy && <span className="font-medium">{q.askedBy}</span>}
          {q.askedBy && q.askedAt && " · "}
          {q.askedAt}
        </p>
      )}
      <div className="mt-2 pl-7">
        <textarea
          ref={taRef}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Responda ou instrua o agente…  (⌘/Ctrl+Enter)"
          className="w-full resize-y rounded-md border border-line bg-inset px-2.5 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button
            onClick={submit}
            disabled={pending || !answer.trim()}
            className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-fg transition enabled:hover:bg-primary-hover disabled:opacity-40"
          >
            {pending ? "Enviando…" : "Responder"}
          </button>
          <EscalateButton
            target={{ templateId: "question-pending", kind: "question", boardId, cardId, questionId: q.id }}
            surface="perguntas"
            label="Jido apura"
            size="sm"
            className={pending ? "pointer-events-none opacity-40" : undefined}
          />
          {error && <span className="text-[11px] text-rose-600 dark:text-rose-300">{error}</span>}
        </div>
      </div>
    </li>
  );
}
