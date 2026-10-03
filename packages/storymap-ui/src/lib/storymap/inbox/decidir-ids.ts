// O Decidir de um board, lido do COLETOR do Inbox — a fonte da raia do dono no Kanban (página server do Kanban).
//
// Server-only: `collectBoardInbox` lê o disco. A transformação é a função pura de decidir-set.ts, a MESMA que o hook do
// cliente usa sobre `getInboxSummaryAction` — então o Kanban recém-aberto e o Kanban atualizado ao vivo mostram o mesmo
// conjunto. Quando o contrato do Inbox mudar o que entra em Decidir, a raia segue sozinha: ela nunca lista status.

import { collectBoardInbox } from "./collect";
import { ownerDecisionsFromEntries, type OwnerDecisions } from "./decidir-set";

export type { OwnerCardDecision, OwnerDecisions } from "./decidir-set";

/**
 * O Decidir do board `boardId`, por card e na ordem do Inbox — ou null quando o board não existe ou o Inbox não pôde
 * ser lido (a raia do dono fica vazia e diz isso, em vez de voltar a adivinhar por status).
 */
export async function boardDecidirCardIds(boardId: string, now: number = Date.now()): Promise<OwnerDecisions | null> {
  try {
    const inbox = await collectBoardInbox(boardId, now);
    return inbox ? ownerDecisionsFromEntries(inbox.entries, boardId) : null;
  } catch (err) {
    console.warn(`[kanban] o Inbox do board ${boardId} não pôde ser lido:`, err instanceof Error ? err.message : err);
    return null;
  }
}
