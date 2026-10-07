import { notFound } from "next/navigation";
import { listBoards } from "@/lib/storymap/repo";
import { cardsForScreen, collectBoardInbox, type InboxSnapshot } from "@/lib/storymap/inbox/collect";
import { inboxSummary } from "@/lib/storymap/inbox/entries";
import { systemRegistry } from "@/components/inbox/registry";
import { CockpitView } from "@/components/CockpitView";

export const dynamic = "force-dynamic";

// /board/[boardId]/inbox — o Inbox DESTE board (fase 3), dentro da casca do board; «Ver de todos os boards» leva a
// /inbox. O mesmo coletor do Inbox de todos (lib/storymap/inbox/collect), lido só para este board.
export default async function BoardInboxPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;
  const [inbox, boards] = await Promise.all([collectBoardInbox(params.boardId), listBoards()]);
  if (!inbox) notFound();
  const snapshot: InboxSnapshot = {
    boards: [{ id: inbox.boardId, name: inbox.boardName, ...inboxSummary(inbox.entries) }],
    entries: inbox.entries,
    contexts: { [inbox.boardId]: { config: inbox.config, cards: cardsForScreen(inbox.entries, inbox.cards) } },
    resolved: inbox.resolved,
  };
  const registry = systemRegistry(inbox.decisions, [{ id: inbox.boardId, name: inbox.boardName }], Date.now());
  return <CockpitView boards={boards} config={inbox.config} snapshot={snapshot} registry={registry} />;
}
