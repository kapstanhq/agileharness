// O ESQUELETO da barra do topo — a barra enquanto o servidor ainda não respondeu.
//
// A decisão que define este arquivo: **o que é IDENTIDADE aparece de verdade; só o que é DADO vira bloco
// cinza.** A marca não depende de IO nenhum — pintá-la como retângulo faria o logo PISCAR a cada navegação.
// O que espera o servidor é o nome do projeto, o grupo e os três sinais da direita; é isso, e só isso, que ondula.
//
// A casca (`appBarShell` e os dois lados) vem de `shell/app-bar-shell`, a MESMA que o `AppBar` usa — é o que
// garante que a barra falsa e a verdadeira tenham os mesmos 52px e a troca não empurre a página.
//
// Sem `"use client"`: um esqueleto que custasse hidratação para aparecer chegaria junto com o conteúdo que ele
// deveria anteceder.

import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";
import { Skeleton, SkeletonScreen } from "@/components/Skeleton";
import { BrandMark } from "@/components/shell/BrandMark";
import { appBarLeft, appBarRight, appBarSep, appBarShell } from "@/components/shell/app-bar-shell";
import { cn } from "@/lib/cn";

/** A marca de verdade — o lockup no desktop, o ícone compacto no celular (como o `AppBarBrand`). */
function BrandGhost() {
  return (
    <span className="inline-flex h-10 shrink-0 items-center text-fg md:h-8">
      <span className="hidden md:inline-flex">
        <AgileHarnessLogo size={13} />
      </span>
      <BrandMark className="md:hidden" />
    </span>
  );
}

function Sep() {
  return (
    <span aria-hidden className={appBarSep}>
      /
    </span>
  );
}

/** Um sinal da direita (anel · Inbox · engrenagem) — o alvo de 40px no celular, 32px no desktop. */
function SignalGhost({ wide }: { wide?: boolean }) {
  return (
    <div className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 px-1.5 md:h-8 md:min-w-8">
      <Skeleton className="h-4 w-4 rounded" />
      {wide && <Skeleton className="hidden h-3 w-5 rounded md:block" />}
    </div>
  );
}

/** A barra de um board (o `BoardHeader`) em carregamento: marca / projeto ▾ / grupo ▾ · anel · Inbox · engrenagem. */
export function BoardTopBarSkeleton() {
  return (
    <header aria-hidden className={appBarShell}>
      <div className={appBarLeft}>
        <BrandGhost />
        <Sep />
        <div className="inline-flex h-7 items-center gap-1 px-1.5">
          <Skeleton className="h-3.5 w-16 rounded" />
        </div>
        <Sep />
        <div className="inline-flex h-7 items-center gap-1 px-1.5">
          <Skeleton className="h-3.5 w-14 rounded" />
        </div>
      </div>
      <div className={appBarRight}>
        <SignalGhost wide />
        <SignalGhost wide />
        <SignalGhost />
      </div>
    </header>
  );
}

/**
 * A barra das páginas APP-LEVEL (Processos, Inbox, Semana…) — o `AppTopBar`. O título é dado (o esqueleto não
 * o adivinha); o voltar e a marca são fixos.
 */
export function AppTopBarSkeleton({ title }: { title?: string }) {
  return (
    <header aria-hidden className={appBarShell}>
      <div className={appBarLeft}>
        <div className="-ml-1.5 inline-flex h-10 w-10 shrink-0 items-center justify-center md:h-8 md:w-8">
          <Skeleton className="h-4 w-4 rounded" />
        </div>
        <BrandGhost />
        <Sep />
        {/* Quando a rota conhece o próprio nome, ele aparece JÁ — um título que se sabe não tem por que ondular. */}
        {title ? <span className="truncate text-[13px] font-semibold text-fg">{title}</span> : <Skeleton className="h-3.5 w-24 rounded" />}
      </div>
      <div className={appBarRight}>
        <SignalGhost wide />
        <SignalGhost wide />
      </div>
    </header>
  );
}

/**
 * A tela inteira de uma página APP-LEVEL em carregamento (Processos, Perguntas) — as duas usam a mesma casca
 * (`max-w-3xl p-6 sm:p-10` + cabeçalho), então ela mora aqui uma vez só.
 *
 * O TÍTULO e a linha de apoio são escritos de VERDADE: a rota já os conhece (são constantes do arquivo, não vêm
 * do servidor). Fantasma é só o que ainda está sendo lido do disco.
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
