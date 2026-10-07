"use server";

// As server actions da PUBLICAÇÃO operada do navegador — a fila de publicação vista e operada pelo dono.
//
// A fila já existia inteira (`runner/publish-queue`), mas SÓ por MCP: um pedido segurado gravava um
// motivo excelente ("trabalho vivo nos mesmos arquivos — sessão X, arquivos Y") que nenhum humano
// conseguia ler sem uma ferramenta de agente. Estas actions são a ponte, e nada mais: elas não
// reimplementam decisão nenhuma — enfileiram, cancelam e leem, exatamente pelas mesmas funções que as
// tools usam. Toda a lógica de QUANDO publicar segue no dreno.
//
// Fase 3: a página de Entrega (a Esteira) saiu; as alavancas dela moram no INBOX, como itens com botão de um clique
// (inbox/decision.ts `publish-held`, `stage-idle`, o «Refazer o pedido agora») despachados por
// components/quick-action-run.ts. As actions são as mesmas; só a superfície mudou.
//
// Autorização: toda action passa pelo portão de sessão (`requireSession`). A trava específica desta
// superfície é a MESMA da tool — e ela mudou: antes exigia o board na lista `autorun.publishQueue.boards`,
// o que fazia o BOTÃO desaparecer justamente nos boards que mais precisavam dele. Aquela flag respondia
// duas perguntas ("pode publicar?" e "publica sozinho?") e desligá-la tirava as duas. Agora "pode pedir"
// depende só de a máquina existir (kill-switch global + staging ligado) e "publica sozinho" é
// `release.mode` no board.yaml. Ver `lib/storymap/release-policy.ts`. Verificado AQUI, no servidor.

import { requireSession } from "@/lib/auth/action-guard";
import { resolveActionCaller } from "@/lib/auth/action-guard";
import { revalidatePath } from "next/cache";
import { cancelPublish, enqueuePublish, type PublishRequest } from "@/lib/storymap/runner/publish-queue";
import { stagingShaOf } from "@/lib/storymap/runner/publish-git";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { mayRequestPublish, publishRefusalReason } from "@/lib/storymap/release-policy";
import { logHumanActionAction } from "./audit-actions";
import { organizeOnlyNow } from "@/lib/storymap/organize-only";
import { ORGANIZE_ONLY_WHY } from "@/lib/storymap/organize-only-core";

/** Refaz as telas que mostram a publicação de um board: o Inbox (do board e de todos) e o Kanban. */
function revalidatePublishSurfaces(board?: string): void {
  revalidatePath("/inbox");
  if (board) revalidatePath(`/board/${board}`, "layout");
}

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
    // publicar POR CIMA da guarda é alavanca do OPERADOR (o item «publish-held» do Inbox): um agente que passa pela
    // action (MCP) e o próprio serviço são recusados. O agente tem a tool `publish_when_idle`, governada pelo riskMatrix.
    if (input.overrideEmbargo && (await resolveActionCaller()) !== "operator-session") {
      return { ok: false, error: "Publicar por cima da guarda é do operador: só pelo Inbox, com a sua sessão." };
    }
    const board = String(input.board || "").trim();
    if (!board) return { ok: false, error: "board ausente." };
    if (organizeOnlyNow(board)) return { ok: false, error: `${ORGANIZE_ONLY_WHY}: nada é publicado a partir deste board.` };
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
      surface: "inbox",
      tool: "publishStagedAction",
      cls: "deploy",
      boardId: board,
      note: input.overrideEmbargo ? `publicar ${sha.slice(0, 8)} (embargo dispensado)` : `publicar ${sha.slice(0, 8)}`,
    }).catch(() => {});
    revalidatePublishSurfaces(board);
    return { ok: true, data: { requestId: request.id, deduped, status: request.status } };
  } catch (e) {
    return fail(e);
  }
}

/** Cancela um pedido que ainda espera. Um já resolvido não muda — história não se reescreve. */
export async function cancelPublishAction(input: { id: string; board?: string }): Promise<Result> {
  await requireSession("cancelPublishAction");
  try {
    // cancelar um pedido é alavanca do OPERADOR (o item «publish-held» do Inbox), como o «Refazer o pedido agora»
    if ((await resolveActionCaller()) !== "operator-session") {
      return { ok: false, error: "Cancelar um pedido de publicação é do operador: só pelo Inbox, com a sua sessão." };
    }
    const id = String(input.id || "").trim();
    if (!id) return { ok: false, error: "id do pedido ausente." };
    const cancelled = await cancelPublish(id, { reason: "cancelado pelo operador no Inbox" });
    if (!cancelled) return { ok: false, error: "Pedido não encontrado ou já resolvido — nada mudou." };
    void logHumanActionAction({
      surface: "inbox",
      tool: "cancelPublishAction",
      cls: "deploy",
      boardId: input.board,
      note: `cancelar ${id}`,
    }).catch(() => {});
    revalidatePublishSurfaces(input.board);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * «Refazer o pedido agora» — o botão do OPERADOR no Inbox do board, quando há pedido `needs-human` dele: roda
 * NA HORA a medição/o deploy do pacote no board que o publica (o mesmo caminho da autorização recusada por velha,
 * owner-approval.ts `rerequestPublishRequests`) e o Inbox mostra «refazendo o pedido…» até o pedido novo chegar. Só a
 * sessão do operador no navegador: um agente (MCP, mesmo com o token `full`) e o próprio serviço são recusados — o
 * deploy de produto não é ferramenta de agente.
 */
export async function rerequestPublishRequestsAction(input: { board: string }): Promise<Result<{ message: string }>> {
  await requireSession("rerequestPublishRequestsAction");
  try {
    if ((await resolveActionCaller()) !== "operator-session") {
      return { ok: false, error: "Refazer os pedidos de publicação é do operador: só pelo Inbox, com a sua sessão." };
    }
    const board = String(input?.board || "").trim();
    if (!board) return { ok: false, error: "board ausente." };
    const [{ rerequestBoardPublishRequests, defaultRerequestDeps }, { readDeployBlocks }] = await Promise.all([
      import("@/lib/storymap/runner/owner-approval"),
      import("@/lib/storymap/runner/deploy-blocks"),
    ]);
    const r = await rerequestBoardPublishRequests(board, { ...defaultRerequestDeps(), readRows: () => readDeployBlocks() });
    void logHumanActionAction({ surface: "inbox", tool: "rerequestPublishRequestsAction", cls: "deploy", boardId: board, note: r.message.slice(0, 200) }).catch(() => {});
    revalidatePublishSurfaces(board);
    return r.ok ? { ok: true, data: { message: r.message } } : { ok: false, error: r.message };
  } catch (e) {
    return fail(e);
  }
}
