import { permanentRedirect } from "next/navigation";

// A bancada de Ideias foi APAGADA na fase 2 (decisão do dono): uma ideia vira item da Triagem, no Kanban.
//
// A rota antiga sobrevive como redirecionamento porque ela está escrita em lugares que este código não alcança:
// cards antigos, `SKILL.md` de terceiros, deep links de agentes, o histórico do navegador. 308 (permanente) é o
// estado honesto — a tela não vai voltar.
export default async function RedirectPage(props: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await props.params;
  permanentRedirect(`/board/${boardId}/kanban`);
}
