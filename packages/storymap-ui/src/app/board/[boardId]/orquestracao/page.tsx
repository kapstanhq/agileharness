import { notFound } from "next/navigation";
import { getBoard, listBoards } from "@/lib/storymap/repo";
import { assembleConfigCockpit } from "@/lib/storymap/config-cockpit";
import { OrquestracaoView } from "@/components/OrquestracaoView";

export const dynamic = "force-dynamic";

// ⚙ Sistema · Orquestração — a bancada onde o operador vê e edita o contexto/prompt que governa o
// sistema autônomo: por step do pipeline com automação, a skill (trigger), o modelo, o effort, os turns
// e o autorun; os prompts dos assistentes de view; e — movido de Configurações — as Rotas &
// Especialistas (perfis de rota + especialistas por coluna, read-only). A page (server) deriva a lista
// serializável de steps e assembla o cockpit; a view (client) reparte os três em abas (`nav/PageTabs`).
export default async function OrquestracaoPage(props: { params: Promise<{ boardId: string }> }) {
  const params = await props.params;

  const [board, boards] = await Promise.all([getBoard(params.boardId), listBoards()]);
  if (!board) notFound();
  // Só os steps que de fato orquestram (têm trigger ou autorun) — o pipeline ativo. Passamos só
  // dados serializáveis à view (client): nada de StatusDef inteiro com facetas não-serializáveis.
  const steps = board.config.statuses
    .filter((s) => s.trigger || s.autorun)
    .map((s) => ({
      id: s.id,
      name: s.name,
      trigger: s.trigger ?? null,
      autorun: !!s.autorun,
      model: s.model ?? null,
      effort: s.effort ?? null,
      maxTurns: s.maxTurns ?? null,
    }));

  // Rotas & Especialistas (movido de Configurações) — a mesma leitura read-only que o cockpit assembla
  // (perfis de rota + especialistas por coluna, com origem _base-herdada e presença do arquivo de agente).
  const cockpit = await assembleConfigCockpit(params.boardId, board.config);

  return <OrquestracaoView board={board} boards={boards} steps={steps} cockpit={cockpit} />;
}
