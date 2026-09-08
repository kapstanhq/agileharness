// A home ("Início Agêntico") ENQUANTO o servidor responde.
//
// Por que existe: a página é `force-dynamic` e o IO dela custa ~150ms mornos e ~460ms frios (relê os
// cards de todos os boards e chama o `tmux`). Sem este arquivo o App Router não tem o que mostrar no
// lugar, então ele segura a tela ANTERIOR inteira, congelada, até o servidor terminar — o clique não
// tem eco, e o operador clica de novo achando que não pegou. Um `loading.tsx` troca essa espera cega
// por uma resposta imediata: a moldura da home aparece no mesmo quadro do clique.
//
// A geometria é a do `InicioScreen`, item por item (a grade de duas colunas, o `max-w-6xl`, o cartão
// de 150px do Inbox, o rail de 492px do Jido) — não por capricho, mas porque um esqueleto que erra a
// medida entrega a página com um PULO, que é pior do que não ter esqueleto. Onde uma medida aparece
// aqui, ela cita de onde veio.
//
// Um detalhe que não é enfeite: a PAUTA do cartão do Inbox (`paper-rules`) é desenhada já no
// esqueleto. Ela não depende de dado nenhum — é o papel; o que falta é o que está escrito nele.

import { cn } from "@/lib/cn";
import { cardSurface } from "@/lib/ui";
import { Skeleton, SkeletonScreen, SkeletonSectionHeading } from "@/components/Skeleton";
import { BoardTopBarSkeleton } from "@/components/nav/TopBarSkeleton";
import { JidoRailGhost } from "@/components/inicio/JidoRailGhost";

/** Um cartão do Inbox. `h-[150px]` e o recuo `py-3 pl-9 pr-3.5` são os do `InboxPanel` (SHEET_H). */
function SheetGhost() {
  return (
    <div className={cn(cardSurface, "paper-rules", "flex h-[150px] flex-col overflow-hidden py-3 pl-9 pr-3.5")}>
      {/* O carimbo do tipo (bolinha da lane + rótulo), na caixa de 20px da entrelinha. */}
      <div className="flex h-5 items-center gap-1.5">
        <Skeleton className="h-1.5 w-1.5 rounded-full" />
        <Skeleton className="h-2.5 w-24 rounded" />
      </div>
      {/* O pedido. `space-y-2` sobre barras de 12px dá o passo de 20px da pauta — é o que faz as
          linhas fantasmas sentarem em cima das linhas do papel, e não entre elas. */}
      <div className="mt-0.5 space-y-2">
        <Skeleton className="h-3 rounded" />
        <Skeleton className="h-3 rounded" />
        <Skeleton className="h-3 w-2/3 rounded" />
      </div>
    </div>
  );
}

/** Um terminal recolhido — `h-8 … px-2.5` do cabeçalho do `TerminalCard`. */
function TerminalGhost({ name = "w-28" }: { name?: string }) {
  return (
    <div className={cn(cardSurface, "overflow-hidden")}>
      <div className="flex h-8 items-center gap-2 px-2.5">
        <Skeleton className={`h-3 rounded ${name}`} />
        <Skeleton className="h-2.5 w-2.5 shrink-0 rounded-full" />
        <Skeleton className="h-2.5 min-w-0 flex-1 rounded" />
        <Skeleton className="ml-auto h-2.5 w-8 shrink-0 rounded" />
      </div>
    </div>
  );
}

/** Uma linha do feed do Kanban — `px-3.5 py-2.5` + caixa de 20px, os do `KanbanFeed`. */
function FeedRowGhost({ title, snippet }: { title: string; snippet: string }) {
  return (
    <li className="flex items-center gap-2.5 px-3.5 py-2.5">
      <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
      <span className="flex h-5 min-w-0 flex-1 items-center gap-2.5">
        <Skeleton className={`h-3 rounded ${title}`} />
        <Skeleton className={`hidden h-2.5 rounded sm:block ${snippet}`} />
      </span>
    </li>
  );
}

/** Um estágio do feed: o rótulo com o filete e a contagem, e o cartão com as linhas por dentro. */
function FeedStageGhost({ label, rows }: { label: string; rows: Array<{ title: string; snippet: string }> }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2.5 px-0.5">
        <Skeleton className={`h-2.5 rounded ${label}`} />
        <span className="h-px flex-1 bg-line-muted" />
        <Skeleton className="h-2.5 w-4 rounded" />
      </div>
      <ul className={cn(cardSurface, "divide-y divide-line-muted overflow-hidden")}>
        {rows.map((r, i) => (
          <FeedRowGhost key={i} title={r.title} snippet={r.snippet} />
        ))}
      </ul>
    </div>
  );
}

/** Uma aba da bottom-nav — `BOTTOM_TAB`: ícone de 20px + rótulo de 10px, `gap-0.5`. */
function TabGhost() {
  return (
    <span className="flex flex-1 flex-col items-center justify-center gap-0.5">
      <Skeleton className="h-5 w-5 rounded" />
      <Skeleton className="h-2 w-8 rounded" />
    </span>
  );
}

export default function InicioLoading() {
  return (
    // `lg:h-screen lg:overflow-hidden` como no InicioScreen: com o rail docado é a PÁGINA que ocupa a
    // viewport e o conteúdo que rola. Sem isso a altura fica indefinida e o `h-full` do rail não
    // resolve — ele nasceria do tamanho do conteúdo e a moldura do Jido chegaria curta.
    <SkeletonScreen
      label="Carregando o início"
      className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden"
    >
      <BoardTopBarSkeleton />

      <div className="flex min-h-0 flex-1">
        <main className="quiet-scroll mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-8 lg:overflow-y-auto">
          {/* Inbox + Terminais, lado a lado no desktop — a MESMA grade do InicioScreen. */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
            <section>
              <SkeletonSectionHeading width="w-14" badge />
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <SheetGhost />
                <SheetGhost />
              </div>
            </section>

            <section>
              <SkeletonSectionHeading width="w-20" />
              <div className="space-y-2">
                <TerminalGhost name="w-28" />
                <TerminalGhost name="w-32" />
                <TerminalGhost name="w-24" />
              </div>
            </section>
          </div>

          {/* O fluxo do Kanban. */}
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2 px-0.5">
              <Skeleton className="h-[15px] w-16 rounded" />
              <Skeleton className="h-3.5 w-3.5 rounded" />
              <span className="flex-1" />
              <Skeleton className="h-[30px] w-[30px] rounded-lg" />
            </div>
            <div className="space-y-4">
              <FeedStageGhost label="w-16" rows={[{ title: "w-2/5", snippet: "w-24" }]} />
              <FeedStageGhost
                label="w-12"
                rows={[
                  { title: "w-1/2", snippet: "w-32" },
                  { title: "w-2/5", snippet: "w-24" },
                  { title: "w-[55%]", snippet: "w-28" },
                  { title: "w-1/3", snippet: "w-20" },
                ]}
              />
            </div>
          </div>
        </main>

        {/* O rail do Jido — a MESMA moldura vazia que o `InicioScreen` usa no intervalo entre o
            primeiro paint e o `useMediaQuery`. Uma definição só, senão o esqueleto e a página real
            reservariam larguras diferentes e a troca daria um pulo (ver JidoRailGhost). */}
        <JidoRailGhost />
      </div>

      {/* A bottom-nav do celular é `fixed`, então não empurra nada — mas sem ela a home no telefone
          fica sem chão até o JS chegar. Mesma casca: `h-14`, filete em cima, superfície do app.
          O terceiro slot NÃO é uma aba: é o botão de criar tarefa, um círculo de 48px que sobe para
          fora da barra (`-mt-6` + anel da superfície). Desenhá-lo como mais uma aba deixaria o
          celular com cinco ícones iguais e um buraco redondo aparecendo no lugar do meio. */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface md:hidden">
        <div className="mx-auto flex h-14 max-w-xl items-stretch justify-around">
          {[0, 1].map((i) => (
            <TabGhost key={i} />
          ))}
          <span className="flex flex-1 flex-col items-center justify-end pb-1">
            <Skeleton className="-mt-6 h-12 w-12 rounded-full ring-4 ring-surface" />
            <Skeleton className="mt-1 h-2 w-12 rounded" />
          </span>
          {[2, 3].map((i) => (
            <TabGhost key={i} />
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}
