// As primitivas do ESQUELETO de carregamento — UMA gramática para toda tela que espera.
//
// Antes não havia nenhuma: nenhuma rota do app tinha `loading.tsx`, e como as páginas de board são
// `force-dynamic` (150ms mornos, 460ms frios — relê ~500 cards e chama o `tmux` a cada navegação),
// o App Router segurava a tela ANTERIOR inteira, congelada, até o servidor responder. O clique não
// tinha eco: o operador clicava, nada acontecia, e ele clicava de novo.
//
// A regra deste arquivo é uma só: **o esqueleto tem a MESMA geometria do conteúdo que ele substitui**.
// Não é enfeite, é reserva de espaço — se a altura não bate, o conteúdo real chega e a página PULA,
// que é pior do que não ter esqueleto nenhum. Por isso as medidas aqui não são "mais ou menos": elas
// citam a fonte (o `h-[150px]` do cartão do Inbox, o `h-8` dos chips da barra) e mudam junto com ela.
//
// O que este arquivo NÃO faz: animação própria. O desenho da onda mora em `globals.css` (`.ah-skeleton`),
// com o porquê do `transform` e da tinta; aqui só se compõe forma.

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Um bloco vazio. O tamanho vem SEMPRE do chamador (`className`), porque é ele que conhece a medida
 * do conteúdo real — um default de altura aqui viraria a medida errada em silêncio.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("ah-skeleton rounded-md", className)} />;
}

/**
 * Um parágrafo fantasma. A última linha sai mais curta (60%) — é o detalhe que faz o bloco ser lido
 * como TEXTO e não como uma barra; um retângulo cheio parece um campo, não uma frase.
 */
export function SkeletonText({
  lines = 2,
  className,
  lineClassName,
}: {
  lines?: number;
  className?: string;
  /** altura/raio de cada linha — o default (`h-3`) é corpo de texto comum. */
  lineClassName?: string;
}) {
  return (
    <div aria-hidden className={cn("flex flex-col gap-1.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3 rounded", lineClassName, i === lines - 1 && "w-3/5")}
        />
      ))}
    </div>
  );
}

/**
 * O cabeçalho de um bloco da home (Inbox · Terminais · Kanban). Existe aqui porque os três repetem a
 * MESMA gramática (`mb-3 … px-0.5`, título de 15.5px, chevron de 14px) — e um esqueleto que a copiasse
 * três vezes à mão sairia do lugar assim que um dos blocos mudasse.
 */
export function SkeletonSectionHeading({
  width = "w-20",
  badge,
}: {
  width?: string;
  /** o contador ao lado do título (o "23" do Inbox). Ele é 19px de altura — mais alto que a linha do
   *  título —, então é ELE quem dita a altura do cabeçalho onde existe; omiti-lo encolhia a faixa em
   *  4px e empurrava tudo abaixo para cima. */
  badge?: boolean;
}) {
  return (
    <div aria-hidden className="mb-3 flex items-center gap-2 px-0.5">
      <Skeleton className={cn("h-[15px] rounded", width)} />
      {badge && <Skeleton className="h-[19px] w-[26px] rounded-[5px]" />}
      <Skeleton className="h-3.5 w-3.5 rounded" />
    </div>
  );
}

/**
 * A casca de uma tela em carregamento — e a única parte com semântica.
 *
 * Os blocos são todos `aria-hidden` (um leitor de tela anunciando quarenta retângulos é ruído puro);
 * quem fala é ESTE contêiner, uma vez: `role="status"` + `aria-busy` + um rótulo invisível. É também
 * o que faz o esqueleto ser anunciado como ESTADO ("carregando…") e não como conteúdo chegando.
 */
export function SkeletonScreen({
  label = "Carregando",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}
