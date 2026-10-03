// O esqueleto GENÉRICO de uma view de board — vale para toda rota sob `/board/<id>/…` que não tenha
// um `loading.tsx` próprio (kanban, mapa, priorização, config, vocabulário, o card…). A home tem o
// seu, mais fiel, em `inicio/loading.tsx`.
//
// Aqui a barra é EXATA (ela é a mesma em todas as views, e é o que responde ao clique no mesmo
// quadro) e o corpo é deliberadamente NEUTRO: cada view tem um layout diferente — kanban em colunas,
// mapa em grade, config em formulário — e desenhar um deles faria as outras trocarem de forma na
// chegada. Um corpo quieto e sem promessa é mais honesto (e envelhece melhor) do que um palpite
// caro que acerta uma view e erra dez.

import { Skeleton, SkeletonScreen } from "@/components/Skeleton";
import { BoardTopBarSkeleton } from "@/components/nav/TopBarSkeleton";

export default function BoardViewLoading() {
  return (
    <SkeletonScreen label="Carregando o board" className="flex min-h-screen flex-col bg-canvas">
      <BoardTopBarSkeleton />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6">
        {/* Só o cabeçalho da view + um começo de conteúdo: o suficiente para a página ter peso e
            direção, sem afirmar uma forma que a view real talvez não tenha. */}
        <div className="flex items-center gap-2 px-0.5">
          <Skeleton className="h-4 w-40 rounded" />
          <span className="flex-1" />
          <Skeleton className="h-[30px] w-[30px] rounded-lg" />
        </div>
        <div className="mt-5 space-y-2.5">
          <Skeleton className="h-11 rounded-[10px]" />
          <Skeleton className="h-11 rounded-[10px] opacity-80" />
          <Skeleton className="h-11 rounded-[10px] opacity-60" />
          <Skeleton className="h-11 rounded-[10px] opacity-40" />
        </div>
      </main>
    </SkeletonScreen>
  );
}
