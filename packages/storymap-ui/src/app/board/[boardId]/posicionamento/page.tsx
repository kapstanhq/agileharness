import { permanentRedirect } from "next/navigation";

// O Posicionamento virou o PRD — não foi renomeado, foi ABSORVIDO: a frase de posicionamento é
// hoje UMA seção de um documento que também diz para quem, contra o quê, o que fica fora de escopo
// e o que já está decidido.
//
// A rota antiga sobrevive como redirecionamento porque ela está escrita em lugares que este commit
// não alcança: um card antigo, um `SKILL.md` de terceiro, o histórico do navegador de quem já usava
// a ferramenta. 308 (permanente) é o estado honesto — a tela não vai voltar.

export default async function PosicionamentoPage(props: { params: Promise<{ boardId: string }> }) {
  const { boardId } = await props.params;
  permanentRedirect(`/board/${boardId}/prd`);
}
