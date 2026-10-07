import { notFound } from "next/navigation";
import { listBoards } from "@/lib/storymap/repo";
import { collectBoardInbox } from "@/lib/storymap/inbox/collect";
import { decodeInboxItemId, findInboxItem } from "@/lib/storymap/deep-links";
import { governanceDraftIdFromItemId } from "@/lib/storymap/demands";
import { readGovernanceDraft } from "@/lib/storymap/sidecars";
import { InboxItemScreen } from "@/components/inbox/InboxItemScreen";
import {
  approvalAbsentState,
  cardAbsentState,
  hostNoticeAbsentState,
  inboxAbsentState,
  receiptAbsentState,
  systemDecisionAbsentState,
} from "@/components/inbox/cockpit-labels";
import { isExpired, readApprovalRequest } from "@/lib/storymap/approvals";
import { latestReceiptFor, undoneReceipts } from "@/lib/storymap/inbox/receipts";

export const dynamic = "force-dynamic";

/**
 * A single Inbox attention item as a dedicated FULL PAGE (the "página individual" the Início
 * Agêntico feed links to). Mirrors the card page's shape: it resolves the item out of the same
 * collector the Inbox list uses (collectBoardInbox), so the page shows the SAME item — the same five parts, the same
 * options — as the list's opened sheet. `params.itemId` arrives PERCENT-ENCODED (Next does not decode
 * App-Router params) — and sometimes encoded TWICE by whatever rendered the link; findInboxItem peels
 * the layers. An absent item renders a graceful state (never a 404) — an action taken here can remove
 * the item under the reader — and that state says only what is known, most specific first: the owner's own receipt
 * (onda 2 — what was decided, with «Desfazer»), the system's decision, the real outcome of a governance draft or an
 * agent's request still on disk, where the item's card is now; only then "not in the Inbox (resolved, or a broken
 * link)".
 */
export default async function InboxItemPage(props: {
  params: Promise<{ boardId: string; itemId: string }>;
}) {
  const params = await props.params;

  const [inbox, boards] = await Promise.all([collectBoardInbox(params.boardId), listBoards()]);
  if (!inbox) notFound();
  const board = { config: inbox.config, cards: inbox.cards };

  // O item dobrado (com as facetas do card) quando ele lidera a dobra; senão o item sozinho — uma faceta também tem
  // página própria.
  const byId = (list: typeof inbox.entries) => list.map((e) => ({ id: e.itemId, entry: e }));
  const item = (findInboxItem(byId(inbox.entries), params.itemId) ?? findInboxItem(byId(inbox.all), params.itemId))?.entry ?? null;

  // Ausente: o sidecar sabe o próprio desfecho — a proposta de governança (aprovada, rejeitada, substituída, vencida)
  // e, desde o B11, o pedido de um agente (autorizado, executado, negado, vencido); o aviso do host que sumiu é um
  // medidor que voltou. O resto não sabe, e diz isso.
  let absent = null;
  if (!item) {
    const id = decodeInboxItemId(params.itemId);
    const draftId = governanceDraftIdFromItemId(id);
    const approvalId = /^apr:([A-Za-z0-9-]{1,100})$/.exec(id)?.[1] ?? null;
    const receipt = latestReceiptFor(inbox.receipts, board.config.id, id);
    const decision = id.startsWith("sd:") ? inbox.decisions.find((d) => d.id === id.slice(3) && d.kind !== "undo") : undefined;
    const card = inbox.cards.find((c) => c.id === id.split(":")[0]);
    if (receipt) {
      absent = receiptAbsentState(receipt, undoneReceipts(inbox.receipts).get(receipt.id));
    } else if (decision) {
      absent = systemDecisionAbsentState(decision, inbox.decisions.find((d) => d.kind === "undo" && d.undoOf === decision.id)?.at);
    } else if (draftId) {
      absent = inboxAbsentState(await readGovernanceDraft(board.config.id, draftId), Date.now(), board.config.id);
    } else if (approvalId) {
      const req = await readApprovalRequest(board.config.id, approvalId);
      absent = approvalAbsentState(
        req ? { ...req, status: req.status === "pending" && isExpired(req, Date.now()) ? "expired" : req.status } : null,
      );
    } else {
      absent = hostNoticeAbsentState(id) ?? (card ? cardAbsentState(card, board.config) : inboxAbsentState(null));
    }
  }

  return <InboxItemScreen board={board} boards={boards} entry={item} absent={absent} />;
}
