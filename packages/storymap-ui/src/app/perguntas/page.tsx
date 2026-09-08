import { getBoard, listBoards } from "@/lib/storymap/repo";
import { openQuestions } from "@/lib/storymap/questions";
import { boardCardDemands, SEVERITY_RANK, type Demand } from "@/lib/storymap/demands";
import { QuestionsQueue, type QueueCard } from "@/components/QuestionsQueue";
import { AppTopBar } from "@/components/nav/TopBar";

export const dynamic = "force-dynamic";

// /perguntas — the human-in-the-loop "Central de Ações / Precisa de você" (ADR-056). It aggregates,
// across EVERY board, everything that needs the orchestrator into ONE surface: (1) open agent
// QUESTIONS, kept with their rich inline-answer UX (the answer rides the card spec for the next
// skill), and (2) every OTHER pending demand (blocker findings, low-confidence triage, human gates)
// derived from the single source of truth `cardDemands` (demands.ts), rendered as deep-link rows
// grouped by type. The client component owns the live SSE refresh; this server component gathers the
// queue. (Merge-train demands live on the queue, not the card — folded in a later increment.)

export default async function PerguntasPage() {
  const boards = await listBoards();
  const loaded = await Promise.all(boards.map(async (b) => ({ b, board: await getBoard(b.id) })));

  const items: QueueCard[] = [];
  const otherDemands: Demand[] = [];
  for (const { b, board } of loaded) {
    if (!board) continue;
    const statusName = (id: string | null) => board.config.statuses.find((s) => s.id === id)?.name ?? null;
    for (const card of board.cards) {
      // (1) open questions → the inline-answer cards
      const open = openQuestions(card);
      if (open.length) {
        const askedDates = open.map((q) => q.askedAt).filter((d): d is string => Boolean(d)).sort();
        items.push({
          boardId: b.id,
          boardName: b.name,
          cardId: card.id,
          cardTitle: card.title,
          statusName: statusName(card.status),
          questions: open,
          oldestAskedAt: askedDates[0] ?? null,
        });
      }
    }
    // (2) every NON-question demand on the board → deep-link rows in the queue
    for (const d of boardCardDemands(board.cards, board.config, b.id)) {
      if (d.type !== "question") otherDemands.push(d);
    }
  }
  // Oldest-first (FIFO) for the question cards; severity-then-age for the other demands.
  items.sort((a, z) => (a.oldestAskedAt || "9999").localeCompare(z.oldestAskedAt || "9999"));
  otherDemands.sort(
    (a, z) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity] || (a.since || "9999").localeCompare(z.since || "9999"),
  );

  // /perguntas é app-level (cross-board) e vivia SEM barra nenhuma — um beco sem saída no desktop e
  // no mobile. Ganha a mesma casca das outras páginas app-level (AppTopBar: marca + voltar + cota).
  return (
    <>
      <AppTopBar title="Perguntas" backHref="/" />
      <QuestionsQueue initial={items} otherDemands={otherDemands} />
    </>
  );
}
