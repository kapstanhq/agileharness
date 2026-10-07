import { permanentRedirect } from "next/navigation";

// A página de CRIAR um card (`/card/novo?tipo=…&pai=…`) saiu com o Mapa (fase 2, decisão do dono): ela era o destino
// do «+ story» de uma célula passo×release, e nada mais apontava para ela. Um card nasce hoje pelo compositor do
// Jido, no Kanban («/criar»), ou pela Triagem.
//
// A rota antiga sobrevive como redirecionamento porque ela está escrita em lugares que este código não alcança:
// `SKILL.md` de terceiros, deep links de agentes, o histórico do navegador. 308 (permanente) é o estado honesto —
// a tela não vai voltar. O segmento estático `novo` continua vencendo o dinâmico `[id]`, então o link velho nunca
// cai na página de um card chamado «novo».
export default async function RedirectPage(props: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await props.params;
  permanentRedirect(`/board/${boardId}/kanban`);
}
