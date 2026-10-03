// O ESQUELETO da barra de topo — a barra enquanto o servidor ainda não respondeu.
//
// A decisão que define este arquivo: **o que é IDENTIDADE aparece de verdade; só o que é DADO vira
// bloco cinza.** O wordmark e o rosto do Jido não dependem de IO nenhum — pintá-los como retângulos
// faria a marca e o mascote PISCAREM a cada navegação, que é precisamente o defeito que o desenho da
// barra já tinha resolvido ("com um rosto só, em um lugar só, não há mudança, não há buraco"). O que
// espera o servidor é o nome do board, os medidores e os blocos; é isso, e só isso, que ondula.
//
// A casca (`topBarShell` + os três slots) vem de `lib/ui`, a MESMA que o TopBar usa — é o que garante
// que a barra falsa e a verdadeira tenham a mesma altura e a troca não empurre a página. A altura,
// aliás, quem manda nela é o Jido (`CopilotFace size="xs"` — 40px, ver `SIZE_PX` em mascot.ts, onde o
// tamanho é múltiplo da grade de propósito), não os chips de 32px: por isso o
// centro reserva o rosto inteiro mesmo no celular, onde os blocos ao redor somem.
//
// Sem `"use client"`: um esqueleto que custasse hidratação para aparecer chegaria junto com o
// conteúdo que ele deveria anteceder. (O `CopilotFace` é client, mas é puro desenho — sem estado,
// sem fetch, sem efeito.)

import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";
import { CopilotFace } from "@/components/copilot/CopilotFace";
import { Skeleton, SkeletonScreen } from "@/components/Skeleton";
import { cn } from "@/lib/cn";
import { topBarShell, topBarSlotCenter, topBarSlotLeft, topBarSlotRight } from "@/lib/ui";

/** Um medidor da direita (inbox · terminal · runs · cota) — o `h-8` do `CHIP_BASE` do NavShell. */
function ChipGhost({ value = "w-4" }: { value?: string }) {
  return (
    <div className="inline-flex h-8 shrink-0 items-center gap-1.5 px-2">
      <Skeleton className="h-4 w-4 rounded" />
      <Skeleton className={`h-3 rounded ${value}`} />
    </div>
  );
}

/** Um BLOCO do centro (Negócio · Produto · Design · Software) — `h-8`, quadradinho de 11px + rótulo. */
function BlockGhost({ label = "w-12" }: { label?: string }) {
  return (
    <div className="inline-flex h-8 shrink-0 items-center gap-2 px-2.5">
      <Skeleton className="h-[11px] w-[11px] rounded-[3px]" />
      <Skeleton className={`h-3 rounded ${label}`} />
    </div>
  );
}

/**
 * A barra de um board (o `BoardHeader`) em carregamento.
 *
 * O wordmark repete a grade de duas células do `WordmarkHome` (logo + "Ir para o início" empilhados)
 * porque é ela que decide a largura do lockup — sem a segunda célula o crumb ao lado nasceria alguns
 * pixels à esquerda e escorregaria quando a barra real chegasse.
 */
export function BoardTopBarSkeleton() {
  return (
    <header aria-hidden className={topBarShell}>
      <div className={topBarSlotLeft}>
        <span className="mr-3 hidden items-center text-fg lg:inline-grid">
          <span className="col-start-1 row-start-1 whitespace-nowrap">
            <AgileHarnessLogo size={13} />
          </span>
          <span className="col-start-1 row-start-1 whitespace-nowrap text-[15px] font-semibold tracking-tight opacity-0">
            Ir para o início
          </span>
        </span>
        {/* O board (crumb): rótulo + chevron, na altura de 32px do NavCrumb. */}
        <div className="inline-flex h-8 items-center gap-1.5 px-2">
          <Skeleton className="h-3.5 w-14 rounded" />
          <Skeleton className="h-3.5 w-3.5 rounded" />
        </div>
        {/* O ⋯ de gestão do board — desktop-only, como o original. */}
        <div className="hidden h-8 w-8 items-center justify-center md:flex">
          <Skeleton className="h-3.5 w-3.5 rounded" />
        </div>
      </div>

      <div className={topBarSlotCenter}>
        <div className="flex items-center gap-1">
          <div className="hidden items-center gap-0.5 md:flex">
            <BlockGhost label="w-14" />
            <BlockGhost label="w-12" />
          </div>
          {/* O Jido de verdade, em repouso — quem dá a altura da barra. */}
          <div className="flex min-w-[2.25rem] items-center justify-center">
            <CopilotFace mood="feliz" size="xs" className="shrink-0 text-fg-muted" title="" />
          </div>
          <div className="hidden items-center gap-0.5 md:flex">
            <BlockGhost label="w-12" />
            <BlockGhost label="w-16" />
          </div>
        </div>
      </div>

      <div className={topBarSlotRight}>
        {/* Os quatro medidores somem no celular, exatamente como no BoardHeader.
            As larguras são o TAMANHO DO VALOR de cada um: contadores (inbox · terminal) cabem em
            2 dígitos; os dois últimos carregam PERCENTUAL (Processos = RAM · cota do Claude), que
            é largo — reservar menos faria a barra encolher na hidratação. */}
        <div className="hidden items-center gap-1 md:flex">
          <ChipGhost />
          <ChipGhost value="w-3" />
          <ChipGhost value="w-7" />
          <ChipGhost value="w-7" />
        </div>
        {/* "Criar tarefa" — a ação primária (`h-8 rounded-lg px-3`). */}
        <span className="hidden md:ml-1.5 md:inline-flex">
          <Skeleton className="h-8 w-[124px] rounded-lg" />
        </span>
      </div>
    </header>
  );
}

/**
 * A barra das páginas APP-LEVEL (Processos, Perguntas…) — o `AppTopBar`.
 *
 * Mais baixa que a do board por construção: aqui não há Jido, então quem dita a altura são os 32px
 * do voltar/HealthPill. O título é dado (o esqueleto não o adivinha); o voltar e o logo são fixos.
 */
export function AppTopBarSkeleton({ title }: { title?: string }) {
  return (
    <header aria-hidden className={topBarShell}>
      <div className={topBarSlotLeft}>
        <div className="mr-0.5 flex h-8 w-8 shrink-0 items-center justify-center">
          <Skeleton className="h-4 w-4 rounded" />
        </div>
        <span className="hidden text-fg lg:inline-flex">
          <AgileHarnessLogo size={13} />
        </span>
        <span className="mx-1 inline-flex">
          <Skeleton className="h-3.5 w-3.5 rounded" />
        </span>
        {/* Quando a rota conhece o próprio nome, ele aparece JÁ — um título que se sabe não tem por
            que ondular (e é o que diz ao operador que ele chegou onde clicou). */}
        {title ? (
          <span className="truncate text-[13px] font-medium text-fg">{title}</span>
        ) : (
          <Skeleton className="h-3.5 w-24 rounded" />
        )}
      </div>
      <div className={topBarSlotCenter} />
      <div className={topBarSlotRight}>
        <ChipGhost value="w-7" />
      </div>
    </header>
  );
}

/**
 * A tela inteira de uma página APP-LEVEL em carregamento (Processos, Perguntas) — as duas usam a
 * mesma casca (`max-w-3xl p-6 sm:p-10` + cabeçalho), então ela mora aqui uma vez só.
 *
 * O TÍTULO e a linha de apoio são escritos de VERDADE: a rota já os conhece (são constantes do
 * arquivo, não vêm do servidor), e uma página que se anuncia no primeiro quadro é o que diz ao
 * operador que ele chegou onde clicou. Fantasma é só o que ainda está sendo lido do disco.
 */
export function AppPageSkeleton({
  title,
  heading,
  subtitle,
  rows = 5,
}: {
  /** o nome na barra de topo. */
  title: string;
  /** o `<h1>` da página, quando difere do nome na barra (Perguntas → "Precisa de você"). */
  heading?: string;
  /** a linha de apoio, SÓ quando ela é constante. Em Perguntas ela conta pendências — dado — e por
   *  isso vira fantasma: escrever "0 pendências" e trocar depois seria mentir por um instante. */
  subtitle?: string;
  /** quantas linhas de lista esboçar — a silhueta da página, não a contagem real. */
  rows?: number;
}) {
  return (
    <SkeletonScreen label={`Carregando ${title}`}>
      <AppTopBarSkeleton title={title} />
      <main className="mx-auto max-w-3xl p-6 sm:p-10">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{heading ?? title}</h1>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-fg-muted">{subtitle}</p>
          ) : (
            <div className="mt-[7px] flex flex-col gap-1.5">
              <Skeleton className="h-3 w-80 max-w-full rounded" />
            </div>
          )}
        </header>
        <ul className="space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="overflow-hidden rounded-md border border-line bg-surface">
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <Skeleton className="h-2 w-2 shrink-0 rounded-full" />
                <span className="flex h-5 min-w-0 flex-1 items-center">
                  <Skeleton className={cn("h-3 rounded", ROW_WIDTHS[i % ROW_WIDTHS.length])} />
                </span>
                <Skeleton className="h-2.5 w-10 shrink-0 rounded" />
              </div>
            </li>
          ))}
        </ul>
      </main>
    </SkeletonScreen>
  );
}

/** Larguras alternadas das linhas fantasmas — uma lista de barras idênticas lê como tabela, não como
 *  texto esperando. O ciclo é fixo (e não aleatório) para o servidor e o cliente pintarem o mesmo. */
const ROW_WIDTHS = ["w-1/2", "w-2/3", "w-2/5", "w-[58%]", "w-1/3"];
