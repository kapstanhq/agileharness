// O LUGAR do Jido enquanto ele ainda não está lá — a moldura do rail, vazia.
//
// Serve a dois momentos que são o mesmo problema:
//
//   1. o `loading.tsx` da home, enquanto o servidor responde;
//   2. o intervalo entre o primeiro paint e o `useEffect` do `InicioScreen`. O rail é decidido por JS
//      (`useMediaQuery`), e por um bom motivo — um rail escondido por CSS continuaria MONTADO, e no
//      celular o chat existiria duas vezes brigando pela sessão do board. Só que `matchMedia` só pode
//      ser lido depois do mount: no primeiro quadro `railVisible` é `false`, a home ocupa a largura
//      inteira, e um instante depois o rail de 492px entra e empurra TUDO para a esquerda.
//
// Este fantasma fecha esse buraco pelo CSS (`hidden lg:flex`), que não espera hidratação: no desktop
// o espaço já nasce reservado, e quando o rail de verdade monta ele apenas ocupa uma moldura que já
// estava lá. Ele NÃO monta o chat — é a diferença que preserva a razão de o rail ser decidido por JS.

import { cn } from "@/lib/cn";
import { cardSurface } from "@/lib/ui";
import { Skeleton } from "@/components/Skeleton";

/** A moldura do rail (492px, filete à esquerda, o chat como cartão por dentro) sem o chat. */
export function JidoRailGhost() {
  return (
    <aside
      aria-hidden
      className="hidden h-full w-[492px] shrink-0 flex-col border-l border-line bg-canvas px-4 py-3 lg:flex"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-line shadow-[0_1px_3px_rgba(15,15,15,0.05)]">
        {/* Cabeçalho da conversa. */}
        <div className="flex h-[41px] shrink-0 items-center gap-2 border-b border-line px-3">
          <Skeleton className="h-3 w-12 rounded" />
          <Skeleton className="h-3.5 w-3.5 rounded" />
          <span className="flex-1" />
          <Skeleton className="h-3.5 w-3.5 rounded" />
          <Skeleton className="h-3.5 w-3.5 rounded" />
        </div>

        {/* As opções que o Jido oferece ao abrir a conversa. */}
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
          <Skeleton className="h-3 w-40 rounded" />
          <div className="mt-1 space-y-2.5">
            <div className={cn(cardSurface, "space-y-2 p-3")}>
              <Skeleton className="h-3 w-2/3 rounded" />
              <Skeleton className="h-2.5 rounded" />
              <Skeleton className="h-2.5 w-4/5 rounded" />
            </div>
            <div className={cn(cardSurface, "space-y-2 p-3")}>
              <Skeleton className="h-3 w-1/2 rounded" />
              <Skeleton className="h-2.5 rounded" />
              <Skeleton className="h-2.5 w-3/5 rounded" />
            </div>
          </div>
        </div>

        {/* O compositor, ancorado embaixo. */}
        <div className="shrink-0 p-3">
          <div className={cn(cardSurface, "flex h-[76px] flex-col justify-between p-3")}>
            <Skeleton className="h-3 w-44 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-4 w-4 rounded" />
              <span className="flex-1" />
              <Skeleton className="h-7 w-16 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
