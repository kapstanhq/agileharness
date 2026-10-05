// O item do Inbox do PEDIDO DE AUTORIZAÇÃO que o plano de publicação listou sem card (runner/deploy-blocks.ts
// `openPlanOwnerRows`): a projeção PURA de uma linha `planSourced` do livro de bloqueios para o que a tela mostra. Mora
// fora do runner (como locked-exec-item.ts) porque o coletor do cockpit e os testes do Inbox a usam sem disco nem relógio.

import type { PublishApprovalCockpitItem } from "./demands";
import type { DeployBlockRow } from "./runner/deploy-blocks";

/** Até quando «refazendo o pedido…» vale sem resposta (o mesmo número de deploy-blocks.ts `REREQUEST_WINDOW_MS`). */
const REREQUEST_WINDOW_MS = 30 * 60_000;

/**
 * Os itens do board `boardId`: um por linha do DONO que nasceu do plano e não segura card nenhum (com card, o aviso do
 * card já leva a decisão ao Inbox — dois itens da mesma causa seriam duas decisões). Sem pedido que valha, sem refazer
 * em curso e sem pedido velho, não há o que mostrar (o dono já autorizou tudo: a linha espera o plano deixar de listá-la).
 * PURA.
 */
export function publishApprovalItems(rows: readonly DeployBlockRow[], boardId: string, now: number): PublishApprovalCockpitItem[] {
  const out: PublishApprovalCockpitItem[] = [];
  for (const r of rows) {
    if (r.board !== boardId || !r.planSourced || r.decider !== "owner" || r.cardIds.length > 0) continue;
    const staleSet = new Set(r.staleApprovals ?? []);
    const fresh = (r.approvals ?? []).filter((a) => !staleSet.has(a.subject.hash));
    const at = r.rerequestedAt ? Date.parse(r.rerequestedAt) : Number.NaN;
    const rerequesting = Number.isFinite(at) && now - at < REREQUEST_WINDOW_MS;
    const stale = !fresh.length && staleSet.size > 0;
    if (!fresh.length && !rerequesting && !stale) continue;
    out.push({
      id: `plan-ask:${r.causeKey}`,
      kind: "publish-approval",
      boardId,
      cardId: "",
      cardTitle: `Publicação de ${r.pkg}`,
      status: null,
      lane: "aprovar",
      severity: "high",
      since: r.firstAt || null,
      causeKey: r.causeKey,
      pkg: r.pkg,
      ownerClass: r.ownerClass,
      approvals: fresh.map((a) => ({ hash: a.subject.hash, files: a.subject.files, units: a.units, rules: a.rules })),
      rerequesting,
      stale,
    });
  }
  return out;
}
