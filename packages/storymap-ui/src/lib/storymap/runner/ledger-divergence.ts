// O HISTÓRICO e o ARQUIVO do card discordam do status — e alguém precisa decidir qual lado vale.
//
// O ledger de transições (transitions.ts) só grava o salto DEPOIS de a escrita do card persistir (moveCardAction, o
// forward da cascata, o settle). Mesmo assim os dois podem se separar: uma escrita que não passa por esses escritores
// (um arquivo restaurado de uma versão anterior, uma escrita fora do serviço) muda o arquivo sem salto. A aterrissagem
// do train já ALERTA no journal quando vê isso (reconcileLedgerWithCards) — mas o journal ninguém lê, e o card seguia
// com o status errado para sempre (o sinal S9 da saúde ficava vermelho sem item nenhum para alguém agir).
//
// Esta varredura transforma a divergência em PROPOSTA no próprio card: um aviso que diz os dois status e pede a
// decisão. Ela NÃO escolhe um lado sozinha: o arquivo pode estar regredido (o histórico tem a verdade) ou o histórico
// pode ter um salto que nunca persistiu (o arquivo tem a verdade) — gravar qualquer um dos dois às cegas legitimaria o
// erro. Quem decide move o card para o status certo (o salto é gravado e o aviso sai sozinho na próxima passada).

import { isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import type { Card, Finding } from "@/lib/storymap/types";
import type { Transition } from "./transitions";

export const LEDGER_DIVERGENCE_FINDING_ID = "ledger-divergence";

/** O que a varredura precisa de um card. */
export interface DivergenceCard {
  id: string;
  status: string | null | undefined;
  findings?: Finding[];
}

/** O último salto de cada card (o ledger é append-only e cronológico: o último vence; empate de instante, o último anexado). */
export function lastHopByCard(hops: readonly Pick<Transition, "board" | "cardId" | "at" | "to">[], board: string): Map<string, string> {
  const last = new Map<string, { at: string; to: string }>();
  for (const t of hops) {
    if (t.board !== board) continue;
    const cur = last.get(t.cardId);
    if (!cur || t.at >= cur.at) last.set(t.cardId, { at: t.at, to: t.to });
  }
  return new Map([...last].map(([id, v]) => [id, v.to]));
}

/** O aviso, em linguagem de dono. PURO. */
export function ledgerDivergenceFinding(file: string, ledger: string, names: (status: string) => string = (s) => s): Finding {
  return {
    id: LEDGER_DIVERGENCE_FINDING_ID,
    lens: "general",
    severity: "medium",
    status: "open",
    title: "O card e o histórico discordam de onde ele está",
    detail:
      `O card diz que está em «${names(file)}», mas o histórico de movimentos termina em «${names(ledger)}». ` +
      "Uma das duas coisas está errada, e o sistema não escolhe sozinho. Confira onde o card de fato está e mova-o para lá " +
      "(mesmo que seja o lugar onde ele já aparece): o movimento fica registrado e este aviso sai sozinho.",
  };
}

export type DivergenceAction = { cardId: string; kind: "open"; finding: Finding } | { cardId: string; kind: "close" };

/**
 * PURA — o que fazer em cada card de um board: abrir o aviso (diverge e ainda não há aviso aberto igual) ou fechá-lo
 * (não diverge mais e há um aberto). Card sem histórico não diverge (não há o que comparar).
 */
export function planLedgerDivergence(
  cards: readonly DivergenceCard[],
  lastHop: ReadonlyMap<string, string>,
  names?: (status: string) => string,
): DivergenceAction[] {
  const out: DivergenceAction[] = [];
  for (const c of cards) {
    const ledger = lastHop.get(c.id);
    const open = (c.findings ?? []).find((f) => f.id === LEDGER_DIVERGENCE_FINDING_ID && f.status === "open");
    const diverges = ledger != null && !!c.status && ledger !== c.status;
    if (diverges) {
      const finding = ledgerDivergenceFinding(c.status!, ledger, names);
      if (!open || open.detail !== finding.detail) out.push({ cardId: c.id, kind: "open", finding });
    } else if (open) {
      out.push({ cardId: c.id, kind: "close" });
    }
  }
  return out;
}

export interface LedgerDivergenceDeps {
  boards(): Promise<{ id: string; cards: Card[]; statusName(status: string): string }[]>;
  hops(): Promise<Transition[]>;
  /** grava (upsert) ou fecha o aviso no card, sob o lock do card. */
  apply(board: string, action: DivergenceAction): Promise<void>;
  log?(line: string): void;
}

/** UMA passada por todos os boards. Nunca lança. Devolve o que fez. */
export async function sweepLedgerDivergence(deps: LedgerDivergenceDeps): Promise<{ board: string; action: DivergenceAction }[]> {
  const log = deps.log ?? ((l: string) => console.log(`[ledger-divergence] ${l}`));
  const done: { board: string; action: DivergenceAction }[] = [];
  try {
    const hops = await deps.hops();
    for (const b of await deps.boards()) {
      for (const action of planLedgerDivergence(b.cards, lastHopByCard(hops, b.id), b.statusName)) {
        try {
          await deps.apply(b.id, action);
          done.push({ board: b.id, action });
          log(`${b.id}/${action.cardId}: ${action.kind === "open" ? "aviso aberto — o card e o histórico discordam" : "aviso fechado — voltaram a concordar"}`);
        } catch (err) {
          log(`${b.id}/${action.cardId}: não gravou o aviso — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    log(`a varredura falhou — ${err instanceof Error ? err.message : String(err)}`);
  }
  return done;
}

/** As portas de produção (disco + ledger + lock do card). */
export function defaultLedgerDivergenceDeps(): LedgerDivergenceDeps {
  return {
    boards: async () => {
      const { listBoards, readBoardConfig, readCards } = await import("@/lib/storymap/repo");
      const out: { id: string; cards: Card[]; statusName(status: string): string }[] = [];
      for (const b of await listBoards()) {
        const [config, cards] = await Promise.all([readBoardConfig(b.id).catch(() => null), readCards(b.id).catch(() => null)]);
        if (!config || !cards) continue;
        // Board SÓ DE ORGANIZAÇÃO (organize-only.ts): o serviço não abre aviso sozinho nele.
        if (isOrganizeOnly(config)) continue;
        out.push({ id: b.id, cards, statusName: (s) => config.statuses.find((x) => x.id === s)?.name ?? s });
      }
      return out;
    },
    hops: async () => (await import("./transitions")).readTransitions(),
    apply: async (board, action) => {
      const [{ updateCardOnDisk }, { upsertFindingIfChanged }] = await Promise.all([import("@/lib/storymap/write"), import("./findings")]);
      await updateCardOnDisk(board, action.cardId, (fresh) => {
        const findings = fresh.findings ?? [];
        if (action.kind === "open") {
          const next = upsertFindingIfChanged(findings, action.finding);
          return next ? { ...fresh, findings: next } : null;
        }
        const idx = findings.findIndex((f) => f.id === LEDGER_DIVERGENCE_FINDING_ID && f.status === "open");
        if (idx < 0) return null;
        const next = findings.slice();
        next[idx] = { ...next[idx], status: "fixed" };
        return { ...fresh, findings: next };
      });
    },
  };
}
