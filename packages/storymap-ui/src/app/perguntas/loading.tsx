// /perguntas enquanto o servidor coleta as pendências de todos os boards.
//
// O `<h1>` da página não é o nome dela na barra ("Perguntas" na barra, "Precisa de você" no corpo) —
// os dois são constantes e aparecem já. A linha de apoio, não: ela CONTA as pendências, e escrever um
// número antes de saber seria mentir por um instante — então fica fantasma.

import { AppPageSkeleton } from "@/components/nav/TopBarSkeleton";

export default function PerguntasLoading() {
  return <AppPageSkeleton title="Perguntas" heading="Precisa de você" rows={4} />;
}
