import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// /perguntas — a antiga «Central de ações». Aposentada em favor do Inbox: ela mostrava uma
// lista DIFERENTE da do Inbox (montada pelo modelo legado `cardDemands`, sem propostas, PRD, pedidos de agente,
// execuções paradas, conflitos nem amostras). Um Inbox só, para todos os boards — os links antigos caem nele.
export default function PerguntasPage() {
  redirect("/inbox");
}
