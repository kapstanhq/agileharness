"use server";

// As server actions da página de ENTREGA — a fila de publicação vista e operada do navegador.
//
// A fila já existia inteira (`runner/publish-queue`), mas SÓ por MCP: um pedido segurado gravava um
// motivo excelente ("trabalho vivo nos mesmos arquivos — sessão X, arquivos Y") que nenhum humano
// conseguia ler sem uma ferramenta de agente. Estas três actions são a ponte, e nada mais: elas não
// reimplementam decisão nenhuma — enfileiram, cancelam e leem, exatamente pelas mesmas funções que as
// tools usam. Toda a lógica de QUANDO publicar segue no dreno.
//
// Autorização: a rota inteira já está atrás do portão de sessão (middleware). A trava específica desta
// superfície é a MESMA da tool — e ela mudou: antes exigia o board na lista `autorun.publishQueue.boards`,
// o que fazia o BOTÃO desaparecer justamente nos boards que mais precisavam dele. Aquela flag respondia
// duas perguntas ("pode publicar?" e "publica sozinho?") e desligá-la tirava as duas. Agora "pode pedir"
// depende só de a máquina existir (kill-switch global + staging ligado) e "publica sozinho" é
// `release.mode` no board.yaml. Ver `lib/storymap/release-policy.ts`. Verificado AQUI, no servidor.

import { requireSession } from "@/lib/auth/action-guard";
import { revalidatePath } from "next/cache";
import { cancelPublish, enqueuePublish, type PublishRequest } from "@/lib/storymap/runner/publish-queue";
import { stagingShaOf } from "@/lib/storymap/runner/publish-git";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { mayRequestPublish, publishRefusalReason } from "@/lib/storymap/release-policy";
import { collectDelivery } from "@/lib/storymap/runner/delivery-deps";
import type { DeliveryOverview } from "@/lib/storymap/runner/delivery-view";
import { logHumanActionAction } from "./audit-actions";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function fail<T = unknown>(e: unknown): Result<T> {
  const error = e instanceof Error ? e.message : String(e);
  console.warn("[entrega] action falhou:", error);
  return { ok: false, error };
}

/**
 * A máquina de publicação existe? É a autorização da superfície — decidida no servidor.
 *
 * NÃO depende do board: nos dois modos de release um humano pode pedir. O que varia por board é quem
 * ORIGINA o pedido (`release.mode`), não quem tem permissão de pedir.
 */
function publishMachineryState(): { queueEnabled: boolean; stagingEnabled: boolean } {
  const autorun = loadRunnerConfig().autorun;
  return { queueEnabled: !!autorun.publishQueue?.enabled, stagingEnabled: !!autorun.staging?.enabled };
}

/**
 * O panorama da entrega (fronteiras + trabalho + fila). Leitura pura de estado, sem efeito.
 *
 * `boardId` ESCOPA todas as raias ao mesmo recorte — a página é uma view DO board, e ela mostrava
 * "Em curso" filtrado por board ao lado de train/stage/fronteiras do sistema inteiro. Omitir mantém o
 * comportamento antigo (todos os boards com a fila ligada), que é o do atalho legado `/entrega`.
 */
export async function getDeliveryOverviewAction(boardId?: string): Promise<Result<DeliveryOverview>> {
  await requireSession("getDeliveryOverviewAction");
  try {
    const board = typeof boardId === "string" && boardId.trim() ? boardId.trim() : undefined;
    return { ok: true, data: await collectDelivery(undefined, board) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Enfileira a publicação do que está no stage AGORA. O sha é lido no SERVIDOR (`stagingShaOf`), nunca
 * recebido do cliente: o pedido tem de pinar o que o operador acabou de ver na tela, e um sha vindo do
 * navegador seria uma janela para publicar outra coisa.
 *
 * `overrideEmbargo` é a válvula explícita — publicar por cima da guarda de concorrência. Ela não
 * destrói nada da outra sessão (o branch e a árvore dela seguem; o 3-way do train reconcilia no submit
 * seguinte), mas é decisão consciente, então fica no registro de auditoria com quem pediu.
 */
export async function publishStagedAction(input: {
  board: string;
  overrideEmbargo?: boolean;
  allowNewer?: boolean;
}): Promise<Result<{ requestId: string; deduped: boolean; status: PublishRequest["status"] }>> {
  await requireSession("publishStagedAction");
  try {
    const board = String(input.board || "").trim();
    if (!board) return { ok: false, error: "board ausente." };
    const machinery = publishMachineryState();
    if (!mayRequestPublish(machinery)) {
      return { ok: false, error: publishRefusalReason(machinery) ?? "A publicação não está disponível." };
    }
    const sha = await stagingShaOf(board);
    if (!sha) return { ok: false, error: "Não deu para ler o sha do branch de staging — nada foi enfileirado." };

    const { request, deduped } = await enqueuePublish({
      board,
      requestedSha: sha,
      requestedBy: "human",
      allowNewer: input.allowNewer,
      overrideEmbargo: input.overrideEmbargo,
    });
    // `.catch` no fire-and-forget: `logHumanActionAction` começa por `requireSession`, e uma promise
    // rejeitada sem handler DERRUBA o processo Node. O ledger é fail-open por desenho.
    void logHumanActionAction({
      surface: "entrega",
      tool: "publishStagedAction",
      cls: "deploy",
      boardId: board,
      note: input.overrideEmbargo ? `publicar ${sha.slice(0, 8)} (embargo dispensado)` : `publicar ${sha.slice(0, 8)}`,
    }).catch(() => {});
    revalidatePath("/entrega");
    return { ok: true, data: { requestId: request.id, deduped, status: request.status } };
  } catch (e) {
    return fail(e);
  }
}

/** Cancela um pedido que ainda espera. Um já resolvido não muda — história não se reescreve. */
export async function cancelPublishAction(input: { id: string; board?: string }): Promise<Result> {
  await requireSession("cancelPublishAction");
  try {
    const id = String(input.id || "").trim();
    if (!id) return { ok: false, error: "id do pedido ausente." };
    const cancelled = await cancelPublish(id, { reason: "cancelado pelo operador na página de Entrega" });
    if (!cancelled) return { ok: false, error: "Pedido não encontrado ou já resolvido — nada mudou." };
    void logHumanActionAction({
      surface: "entrega",
      tool: "cancelPublishAction",
      cls: "deploy",
      boardId: input.board,
      note: `cancelar ${id}`,
    }).catch(() => {});
    revalidatePath("/entrega");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
