// /processes enquanto o servidor lê a frota. A página cruza o registry, o journal, o `tmux` e os
// cards de TODOS os boards — é uma das esperas mais longas do app, e era 100% silenciosa.
//
// O título e a linha de apoio são constantes do arquivo (não vêm do servidor), então aparecem já.

import { AppPageSkeleton } from "@/components/nav/TopBarSkeleton";

export default function ProcessesLoading() {
  return (
    <AppPageSkeleton
      title="Processos"
      subtitle="O que a máquina está fazendo — runs do pipeline, fila de merge e o que travou."
      rows={6}
    />
  );
}
