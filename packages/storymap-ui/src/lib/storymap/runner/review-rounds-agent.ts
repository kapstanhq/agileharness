// O PORTÃO ÚNICO do teto de rodadas para o que um AGENTE cria pelo MCP — `create_card`, `usm_capture apply`,
// `report_issue` e qualquer outro caminho de criação que chegue às ações de criação (createCardAction /
// commitProposalAction). Fecha as três brechas que o teto ainda tinha contra um agente determinado:
//   · RÓTULO FALSO (B2): a sessão que decide a herança é a PROVADA (session-binding.ts), não a declarada no cabeçalho;
//   · ISCA E OMISSÃO (M1): com a sessão provada ligada a um card que carrega cadeia de revisão
//     ({@link cardCarriesReviewChain}), TODA story criada herda a cadeia (qualquer storyType, inclusive user ou omitido),
//     e um `continuesFrom` que aponte para fora da árvore da sessão é RECUSADO;
//   · OUTROS CAMINHOS (M2): as ações de criação chamam este portão para todo ator MCP, não só o `create_card`.
// A contagem em si (lixeira incluída; board ilegível ⇒ pergunta ao dono) mora em review-rounds-deps.ts.

import type { StructuredQuestionInput } from "@/lib/storymap/questions";
import type { McpActor } from "@/lib/storymap/mcp/actor";
import type { Card, CardLink, ReviewChainMark } from "@/lib/storymap/types";
import { sessionBindingOf, type SessionBinding } from "./session-binding";
import { readAllBoardCards, reviewRoundsGate, type ReviewRoundsDecision } from "./review-rounds-deps";
import { EXTRA_ROUND_LABEL, REVIEW_ROUND_LABEL, cardCarriesReviewChain, sameReviewTree, type BoardCard } from "./review-rounds";

/** O que a criação de um agente leva do portão. */
export type AgentRoundsDecision =
  /** nenhuma cadeia em jogo: cria normalmente. */
  | { kind: "none" }
  /** é uma rodada: o card nasce com esta marca, na MESMA escrita que o cria. */
  | { kind: "stamp"; stamp: { labels: string[]; links: CardLink[]; reviewChain?: ReviewChainMark }; origin: { board: string; cardId: string } }
  /** pedido inválido (o `continuesFrom` não existe ou aponta para fora da árvore da sessão): nada é criado. */
  | { kind: "refuse"; error: string }
  /** teto: nada é criado — a pergunta foi (ou já estava) com o dono, ou ele já respondeu «aceitar»/«parar». */
  | { kind: "held"; nota: string; origin: { board: string; cardId: string } };

export interface AgentRoundsDeps {
  binding: (actor: McpActor | undefined) => Promise<SessionBinding>;
  readCard: (board: string, cardId: string) => Promise<Card | null>;
  readAll: () => Promise<BoardCard[]>;
  gate: (board: string, cardId: string, summary: string) => Promise<ReviewRoundsDecision>;
}

function defaultDeps(ask?: (board: string, cardId: string, q: StructuredQuestionInput) => Promise<void>): AgentRoundsDeps {
  return {
    binding: (actor) => sessionBindingOf(actor),
    readCard: async (board, cardId) => (await import("@/lib/storymap/repo")).readCard(board, cardId),
    readAll: readAllBoardCards,
    gate: (board, cardId, summary) => reviewRoundsGate(board, cardId, summary, undefined, ask),
  };
}

/**
 * O portão do teto para uma criação de STORY por um ator MCP. `continuesFrom` = o card (neste board) cuja revisão o novo
 * card conserta, quando o agente o declara. Nunca lança: erro de leitura vira recusa (nada criado) ou a pergunta ao dono.
 */
export async function agentRoundsDecision(
  input: { boardId: string; summary: string; continuesFrom?: string | null; actor: McpActor | undefined },
  deps: Partial<AgentRoundsDeps> & { ask?: (board: string, cardId: string, q: StructuredQuestionInput) => Promise<void> } = {},
): Promise<AgentRoundsDecision> {
  const d = { ...defaultDeps(deps.ask), ...deps };
  // a sessão PROVADA e o card que ela conduz, quando ele carrega cadeia
  const binding = await d.binding(input.actor);
  let sessionOrigin: { board: string; card: Card } | null = null;
  if (binding.state === "bound" && binding.session.board && binding.session.cardId) {
    const card = await d.readCard(binding.session.board, binding.session.cardId).catch(() => null);
    if (card && cardCarriesReviewChain(card)) sessionOrigin = { board: binding.session.board, card };
  }

  let origin: { board: string; card: Card } | null = sessionOrigin;
  if (input.continuesFrom) {
    const c = await d.readCard(input.boardId, input.continuesFrom).catch(() => null);
    if (!c) return { kind: "refuse", error: `continuesFrom: card não encontrado neste board: ${input.continuesFrom}` };
    if (sessionOrigin) {
      let all: BoardCard[];
      try {
        all = await d.readAll();
      } catch {
        return { kind: "refuse", error: "não consegui conferir a cadeia de revisão desta sessão (um board não foi lido) — tente de novo" };
      }
      if (!sameReviewTree({ board: input.boardId, id: c.id }, { board: sessionOrigin.board, id: sessionOrigin.card.id }, all)) {
        return {
          kind: "refuse",
          error:
            `continuesFrom «${c.id}» está FORA da cadeia de revisão do card desta sessão («${sessionOrigin.card.title}»). ` +
            `Um conserto desta sessão conta na cadeia dela: omita continuesFrom (a cadeia é herdada) ou aponte um card dela.`,
        };
      }
    }
    origin = { board: input.boardId, card: c };
  }
  if (!origin) return { kind: "none" };

  const o = origin;
  const decision = await d.gate(o.board, o.card.id, input.summary);
  const at = { board: o.board, cardId: o.card.id };
  if (decision.gate === "asked" || decision.gate === "accepted" || decision.gate === "stopped") {
    const why =
      decision.gate === "asked"
        ? `chegou ao teto de rodadas de revisão: nenhum card foi criado e a pergunta foi ao dono no card ${o.card.id} (aceitar o risco restante, pagar mais uma rodada ou parar). Espere a resposta`
        : decision.gate === "accepted"
          ? "já teve a resposta do dono: ele aceitou o risco restante. Nenhum card foi criado"
          : "já teve a resposta do dono: ele mandou parar. Nenhum card foi criado";
    return { kind: "held", origin: at, nota: `A cadeia de consertos de «${o.card.title}» ${why}; não abra outro card para esta cadeia.` };
  }
  return {
    kind: "stamp",
    origin: at,
    stamp: {
      labels: [REVIEW_ROUND_LABEL, ...(decision.gate === "open-extra" ? [EXTRA_ROUND_LABEL] : [])],
      // o vínculo só vale dentro do mesmo board; a marca de cadeia vale em qualquer um
      links: o.board === input.boardId ? [{ rel: "relates-to", to: o.card.id }] : [],
      ...(decision.mark ? { reviewChain: decision.mark } : {}),
    },
  };
}
