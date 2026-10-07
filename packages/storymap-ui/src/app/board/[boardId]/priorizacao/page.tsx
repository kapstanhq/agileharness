import { permanentRedirect } from "next/navigation";

// A Priorização foi APAGADA na fase 5 (decisão do dono): não há nota de prioridade — a ordem do trabalho é a POSIÇÃO
// do card na coluna do Kanban («Fazer antes» / «Pode esperar» no menu do card).
//
// A rota antiga sobrevive como redirecionamento porque ela está escrita em lugares que este código não alcança:
// cards antigos, `SKILL.md` de terceiros, deep links de agentes, o histórico do navegador. 308 (permanente) é o
// estado honesto — a tela não vai voltar.
export default async function RedirectPage(props: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await props.params;
  permanentRedirect(`/board/${boardId}/kanban`);
}
