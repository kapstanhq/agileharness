"use client";

// As primitivas da barra de topo — UMA gramática para todos os itens.
//
// Antes cada item da barra inventava a sua: o chip do Inbox era um ícone nu (sem contador),
// "runs" era texto solto, o Claude era uma pílula com borda e o board era um <select> nativo. Três
// alturas, três tipografias, três jeitos de abrir painel — a barra parecia três apps colados.
//
// A gramática é a mesma dos dois lados, e o que muda é o PAPEL:
//   • esquerda (NavCrumb)  → a ÁRVORE de contexto (app › board › view). Gatilho SIMPLES — só rótulo
//     e chevron, sem borda —, popover RICO (a lista de boards com pendências, o mega-menu de views).
//   • direita  (NavChip)   → os MEDIDORES (inbox · runs · Claude). Gatilho = ícone + valor, em
//     tabular-nums e na mesma altura; a cor carrega o estado (âmbar pede você, verde está vivo,
//     rosa falhou). O popover conta a história inteira.
// Os dois abrem o MESMO painel (NavPopover): hover com carência, Escape, clique fora, e um rodapé
// que leva à página completa. Item novo na barra = usar isto, não inventar a quarta pílula.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { claimNavPopover, releaseNavPopover } from "@/components/nav/popover-arbiter";

/**
 * Voltar de VERDADE. O "voltar" da UI era sempre um href FIXO (card→/kanban, detalhe→/inbox…),
 * então abrir um card do Início e clicar em Voltar te jogava no Kanban, não de volta ao Início — a
 * queixa "voltar não volta, vai pra uma página fixa". Aqui: quando há pilha de histórico no app
 * (o usuário chegou navegando), `router.back()` devolve à página REAL de origem; quando não há
 * (aba aberta direto num deep-link), cai num destino seguro — o pai lógico da página.
 * `window.history.length > 1` é o sinal version-agnostic (não depende de internals do Next).
 */
export function useHistoryBack(fallbackHref: string) {
  const router = useRouter();
  return () => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(fallbackHref);
  };
}

/** Um botão "voltar" que respeita o histórico (via {@link useHistoryBack}); o conteúdo (ícone+label)
 *  fica a cargo do chamador para casar com o estilo de cada superfície. */
export function BackButton({
  fallbackHref,
  className,
  title,
  children,
}: {
  fallbackHref: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const back = useHistoryBack(fallbackHref);
  return (
    <button type="button" onClick={back} aria-label={title ?? "Voltar"} title={title} className={className}>
      {children}
    </button>
  );
}

/** Fecha um popover no Escape enquanto ele está aberto. */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
}

/**
 * Reivindica a vez enquanto `open` for verdadeiro e devolve ao fechar/desmontar — o laço entre o
 * React e o árbitro da barra (`popover-arbiter.ts`, onde mora o PORQUÊ). É um EFEITO (e não um
 * wrapper no setter) de propósito: assim cobre TODO caminho de abertura — o hover (`openNow`), o
 * tap que alterna (`setOpen(o => !o)`) e qualquer `setOpen(true)` de fora — sem que nenhum chamador
 * precise lembrar de avisar o árbitro.
 */
export function useExclusiveNavPopover(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    claimNavPopover(close);
    return () => releaseNavPopover(close);
  }, [open, close]);
}

/**
 * Abertura por hover com carência de fechamento (o caminho diagonal do mouse até o painel não o
 * derruba) + Escape + pointer-down fora. No toque (sem hover) o tap no gatilho alterna.
 * NÃO usa overlay de tela cheia para o clique-fora: o overlay ficaria por cima do gatilho e roubaria
 * o hover, colapsando o painel no instante em que ele abre.
 * Exclusivo com os demais painéis da barra — ver `popover-arbiter.ts`.
 */
export function useHoverPopover() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Identidade estável do "fecha este" — é a chave do registry.
  const close = useRef(() => setOpen(false)).current;
  const openNow = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  };
  const closeSoon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(close, 140);
  };
  useEscape(open, close);
  useExclusiveNavPopover(open, close);
  // A carência pendente não pode sobreviver ao desmonte: ela chamaria `setOpen` num componente morto.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  return { open, setOpen, openNow, closeSoon, ref };
}

/** De que lado do gatilho o painel ancora — e onde, portanto, a setinha aponta. */
type NavPopoverAlign = "left" | "right" | "center";

/** A ponta do painel, na horizontal, por alinhamento. ~22px = o meio de um chip de barra (h-8 px-2). */
const CARET_POS: Record<NavPopoverAlign, string> = {
  right: "right-[22px]",
  left: "left-[22px]",
  center: "left-1/2 -translate-x-1/2",
};

const PANEL_POS: Record<NavPopoverAlign, string> = {
  right: "right-0",
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
};

/**
 * O casco do popover — mesma superfície, elevação e raio para TODO item da barra.
 *
 * Duas coisas que ele passou a fazer, e o porquê:
 *
 * • **A SETINHA.** O painel era um retângulo solto: com quatro medidores encostados uns nos outros, o
 *   que abriu deixava de dizer de QUEM ele é — o operador passava o mouse no terminal e lia um painel
 *   que podia ser dos processos. A ponta amarra painel↔gatilho, e é a mesma receita do mega-menu dos
 *   blocos (nav/GroupNav), que já era o único painel da barra a ter uma.
 * • **`pinned`.** No celular um painel ancorado no gatilho vaza da tela. O HealthPill resolvia isso
 *   com um `<div>` PRÓPRIO (`fixed right-2 top-14 … md:absolute`) — a razão de ele ser o único item da
 *   barra fora desta primitiva, com outro padding e sem rodapé. Trazido para cá, a exceção vira uma
 *   opção e o painel volta para a família.
 *
 * O conteúdo ROLA (`max-h`) — uma lista que cresce empurrava o rodapé para fora da tela. A ponta fica
 * FORA da área que rola, senão ela some no primeiro scroll.
 */
export function NavPopover({
  align = "right",
  className,
  children,
  label,
  pinned,
}: {
  align?: NavPopoverAlign;
  /** largura/altura extra (default: w-72). */
  className?: string;
  children: ReactNode;
  label?: string;
  /** abaixo de `md`, ancora no CANTO da tela em vez do gatilho (painel que abre no celular). */
  pinned?: boolean;
}) {
  return (
    <div
      className={cn(
        "z-[70]",
        pinned
          ? "fixed right-2 top-14 md:absolute md:right-0 md:top-full md:mt-2"
          : cn("absolute top-full mt-2", PANEL_POS[align]),
        className ?? (pinned ? "w-[min(18rem,calc(100vw-1rem))] md:w-72" : "w-72"),
      )}
    >
      <div role="dialog" aria-label={label} className="relative rounded-xl border border-line bg-surface p-2 shadow-lg">
        {/* A ponta: um quadrado girado que cobre a borda de cima. Escondida enquanto o painel está
            preso ao canto da tela (ali ele não sai de gatilho nenhum). */}
        <span
          aria-hidden
          className={cn(
            "absolute -top-[5px] h-2.5 w-2.5 rotate-45 rounded-tl-[3px] border-l border-t border-line bg-surface",
            CARET_POS[align],
            pinned && "hidden md:block",
          )}
        />
        <div className="relative max-h-[min(70vh,26rem)] overflow-y-auto overscroll-contain">{children}</div>
      </div>
    </div>
  );
}

// TUDO no painel se alinha na MESMA coluna (px-1.5) — título, linhas, medidores e rodapé. O título e o
// estado vazio moravam em `px-1`: 2px a menos que os vizinhos, o suficiente para o olho ver duas
// colunas num painel de 288px (visível no medidor de cota, onde as barras encostavam à esquerda do
// rodapé). Só o `leading` de uma linha empurra o texto dela — e esse é o recuo que ele existe para dar.
const POPOVER_GUTTER = "px-1.5";

/** O título do popover (caixa alta, discreto) + um meta opcional à direita ("3 pendências"). */
export function NavPopoverTitle({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <p
      className={cn(
        "flex items-center justify-between gap-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle",
        POPOVER_GUTTER,
      )}
    >
      <span>{children}</span>
      {meta != null && <span className="shrink-0 tabular-nums">{meta}</span>}
    </p>
  );
}

/** O estado vazio de um popover — mesma voz em todos ("Nada precisa de você neste board agora."). */
export function NavPopoverEmpty({ children }: { children: ReactNode }) {
  return <p className={cn("py-2 text-[12px] text-fg-subtle", POPOVER_GUTTER)}>{children}</p>;
}

/** Um bloco de conteúdo estático (medidores, notas) na coluna do painel. */
export function NavPopoverBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-2 py-1", POPOVER_GUTTER, className)}>{children}</div>;
}

/**
 * O rodapé de UM destino: SEMPRE abre a coisa inteira ("Abrir Inbox →"). Vira <Link> quando o destino
 * é uma página e <button> quando é uma gaveta (o chat do Jido).
 *
 * Painel que leva a DOIS lugares não empilha dois destes — usa {@link NavPopoverActions}.
 */
export function NavPopoverFooter({
  href,
  external,
  onClick,
  children,
}: {
  href?: string;
  /** destino fora do App Router (ex.: /terminal, documento estático) → <a> (hard nav), NÃO <Link>. */
  external?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const cls =
    "mt-1 block w-full rounded-lg px-1.5 py-1.5 text-left text-[11px] font-medium text-accent transition hover:bg-surface-hover";
  if (!href) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {children}
      </button>
    );
  }
  if (external) {
    return (
      <a href={href} onClick={onClick} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} onClick={onClick} className={cls}>
      {children}
    </Link>
  );
}

// `NavPopoverActions` / `NavPopoverAction` (o par de PORTAS lado a lado) foram REMOVIDOS: o único
// painel com dois destinos era o de Processos, e o operador decidiu que o segundo (a Esteira) não
// devia morar num medidor — ele foi para o topo da coluna Entrega no Kanban, onde a pergunta nasce.
// Sem consumidor, o par virava export morto, que é o defeito que este arquivo acabou de limpar em
// outro lugar (HeadroomChip). Está no git se um segundo destino legítimo aparecer.

/**
 * A LINHA de um painel — uma anatomia só para as quatro listas da barra (pendências · terminais ·
 * runs · o que mais vier).
 *
 * Cada medidor desenhava a sua: o Inbox punha o tipo num chip à esquerda do título, o terminal
 * empurrava o comando para a direita com `ml-auto`, os processos alinhavam três colunas na mão. Três
 * listas, três alturas, três lugares para o olho procurar a mesma informação. Aqui a ordem é a MESMA
 * do cartão do Inbox (a superfície canônica deste vocabulário): sobrancelha → título → detalhe, com
 * o `meta` (idade/tempo) ancorado à direita, na linha da sobrancelha.
 *
 * Vira <Link>, <a> (destino fora do App Router) ou <div> (linha que não leva a lugar nenhum).
 */
export function NavPopoverRow({
  leading,
  eyebrow,
  label,
  sub,
  meta,
  href,
  external,
  onClick,
  title,
}: {
  /** o ponto de estado, ou um ícone — o que diz "em que pé está" antes de qualquer palavra. */
  leading?: ReactNode;
  /** a sobrancelha: o TIPO da coisa, curto e discreto. */
  eyebrow?: ReactNode;
  label: ReactNode;
  /** a segunda linha: as palavras da própria coisa (a pergunta do terminal, o card do run). */
  sub?: ReactNode;
  /** à direita, em tabular-nums: idade, tempo decorrido — o que não pode dançar a cada tick. */
  meta?: ReactNode;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const interactive = Boolean(href || onClick);
  const cls = cn(
    "flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left",
    interactive && "transition hover:bg-surface-hover",
  );
  const inner = (
    <>
      {leading != null && <span className="mt-[5px] flex shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        {(eyebrow != null || meta != null) && (
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[10px] font-medium uppercase tracking-wide text-fg-subtle">{eyebrow}</span>
            {meta != null && <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">{meta}</span>}
          </span>
        )}
        <span className="block truncate text-[12px] text-fg">{label}</span>
        {sub != null && <span className="block truncate text-[11px] leading-snug text-fg-muted">{sub}</span>}
      </span>
    </>
  );
  if (href && external) {
    return (
      <a href={href} onClick={onClick} title={title} className={cls}>
        {inner}
      </a>
    );
  }
  if (href) {
    return (
      <Link href={href} onClick={onClick} title={title} className={cls}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cls}>
        {inner}
      </button>
    );
  }
  return (
    <div title={title} className={cls}>
      {inner}
    </div>
  );
}

// ── "Quanto disso já foi" — UMA régua ────────────────────────────────────────────────────────────
//
// A cota do Claude e a RAM da máquina são a MESMA pergunta feita de dois jeitos, e mediam com réguas
// diferentes: a cota tinha limiares (60/85) e barra colorida no HealthPill, a RAM era um número cru ao
// lado de um ícone no painel dos processos. Mesma pergunta, duas leituras — 80% de RAM parecia calmo
// e 80% de semana parecia grave. Uma régua só, e os dois painéis passam a se ler igual.

/** <60 é quieto (verde constante seria ruído) · 60–85 pede olho · >85 freia. */
export function meterInk(pct: number): string {
  if (pct >= 85) return "text-rose-600 dark:text-rose-300";
  if (pct >= 60) return "text-amber-700 dark:text-amber-300";
  return "text-emerald-700 dark:text-emerald-300";
}

export function meterFill(pct: number): string {
  if (pct >= 85) return "bg-rose-500";
  if (pct >= 60) return "bg-amber-500";
  return "bg-emerald-500";
}

/**
 * A MESMA régua, lida como tom de CHIP — para o medidor que carrega a grandeza no próprio número da
 * barra (a cota do Claude, a RAM da máquina).
 *
 * Repare que o calmo aqui é `idle` (cinza), não o verde do `meterInk`: no painel o verde é uma
 * medida entre outras, na barra ele seria um alarme aceso o dia inteiro. `null` = não sei medir →
 * `idle`, nunca um tom que afirme algo sobre um número que não existe.
 */
export function meterTone(pct: number | null): NavTone {
  if (pct == null || !Number.isFinite(pct)) return "idle";
  if (pct >= 85) return "danger";
  if (pct >= 60) return "attention";
  return "idle";
}

/**
 * Uma grandeza medida: rótulo · valor · barra. `pct` null = "não sei medir" — a barra fica vazia e o
 * valor cai para "—" (nunca 0%, que é uma medida e não uma ausência).
 * `muted` derruba a cor autoritativa (número defasado): a barra continua lá, sem fingir que vale.
 */
export function NavPopoverMeter({
  label,
  pct,
  value,
  muted,
}: {
  label: ReactNode;
  pct: number | null;
  /** o que se lê à direita (default: o próprio `pct` arredondado). */
  value?: ReactNode;
  muted?: boolean;
}) {
  const known = pct != null && Number.isFinite(pct);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-fg-muted">{label}</span>
        <span
          className={cn(
            "shrink-0 font-medium tabular-nums",
            !known || muted ? "text-fg-muted" : meterInk(pct),
          )}
        >
          {value ?? (known ? `${Math.round(pct)}%` : "—")}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-inset">
        {known && (
          <div
            className={cn("h-full rounded-full transition-[width]", muted ? "bg-fg-subtle/40" : meterFill(pct))}
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function NavPopoverDivider() {
  return <div className="my-1.5 h-px bg-line-muted" />;
}

// ── Direita: os MEDIDORES ────────────────────────────────────────────────────────────────────────

/** O estado que a COR do chip carrega. `idle` = quieto; os outros pedem atenção em graus. */
export type NavTone = "idle" | "attention" | "live" | "danger";

const TONE: Record<NavTone, string> = {
  idle: "text-fg-muted hover:bg-surface-hover hover:text-fg",
  attention: "text-amber-700 hover:bg-surface-hover dark:text-amber-300",
  live: "text-emerald-700 hover:bg-surface-hover dark:text-emerald-400",
  danger: "text-rose-600 hover:bg-surface-hover dark:text-rose-300",
};

/** O corpo do chip: uma linha de 32px, ícone + valor, número em tabular-nums (não dança ao mudar). */
const CHIP_BASE =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium tabular-nums transition";

/**
 * Um medidor da direita. `leading` é o ícone (ou o anel de uso do Claude), `value` é o número — e é
 * SÓ isso: quem quiser contar mais história põe no popover, não no chip.
 * Vira <Link> quando tem href (inbox/runs levam à página) e <button> quando abre painel próprio.
 */
export function NavChip({
  leading,
  value,
  tone = "idle",
  open,
  href,
  external,
  onClick,
  onTouchOpen,
  title,
  ariaLabel,
}: {
  leading: ReactNode;
  value: ReactNode;
  tone?: NavTone;
  /** popover aberto → o chip fica "apertado" (mesma pista visual do crumb aberto). */
  open?: boolean;
  href?: string;
  /** destino fora do App Router (ex.: /terminal, documento estático) → renderiza <a> (hard nav), NÃO <Link>
   *  do next/link, que faria nav client-side numa rota que o Next não possui → not-found. */
  external?: boolean;
  onClick?: () => void;
  /**
   * No TOQUE, abre o painel em vez de navegar.
   *
   * O painel de um chip com `href` era inalcançável sem mouse: o gatilho é um link e o único caminho
   * para o popover é o hover, que não existe no toque — num tablet ou num laptop com tela sensível o
   * tap ia direto para a página e a lista (a metade útil do medidor) nunca aparecia. O primeiro toque
   * abre; o link segue inteiro para o mouse, o teclado e o clique do meio, e o rodapé do painel leva
   * ao mesmo destino — então o toque perde zero e ganha o painel.
   */
  onTouchOpen?: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  const cls = cn(CHIP_BASE, TONE[tone], open && "bg-surface-hover");
  const inner = (
    <>
      {leading}
      <span>{value}</span>
    </>
  );
  // Só o toque é interceptado (`pointerType`); mouse e caneta caem no comportamento de sempre.
  const onPointerDown = onTouchOpen
    ? (e: ReactPointerEvent) => {
        if (e.pointerType !== "touch") return;
        e.preventDefault();
        onTouchOpen();
      }
    : undefined;
  if (href && external) {
    return (
      <a href={href} onPointerDown={onPointerDown} title={title} aria-label={ariaLabel} className={cls}>
        {inner}
      </a>
    );
  }
  if (href) {
    return (
      <Link href={href} onPointerDown={onPointerDown} title={title} aria-label={ariaLabel} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} title={title} aria-label={ariaLabel} className={cls}>
      {inner}
    </button>
  );
}

/** O pontinho de vida do chip — pulsa enquanto há run ativo; sólido quando é só um alerta parado. */
export function NavDot({ pulse, tone = "live" }: { pulse?: boolean; tone?: "live" | "danger" | "attention" }) {
  const bg = tone === "danger" ? "bg-rose-500" : tone === "attention" ? "bg-amber-500" : "bg-emerald-500";
  const ping = tone === "danger" ? "bg-rose-400" : tone === "attention" ? "bg-amber-400" : "bg-emerald-400";
  if (!pulse) return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", bg)} />;
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", ping)} />
      <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", bg)} />
    </span>
  );
}

// ── Esquerda: a ÁRVORE de contexto ───────────────────────────────────────────────────────────────

/**
 * Um degrau da árvore (board › view). Gatilho deliberadamente MAGRO — sem borda, sem caixa: o que
 * pesa é o rótulo. A riqueza mora no popover que ele abre.
 */
export function NavCrumb({
  leading,
  label,
  open,
  onClick,
  onFocus,
  title,
  className,
}: {
  leading?: ReactNode;
  label: string;
  open?: boolean;
  onClick?: () => void;
  onFocus?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onFocus={onFocus}
      aria-haspopup="menu"
      aria-expanded={!!open}
      title={title}
      className={cn(
        "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition",
        open ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
        className,
      )}
    >
      {leading}
      <span className="truncate">{label}</span>
      <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-fg-subtle transition", open && "rotate-180")} />
    </button>
  );
}

/** O conector da árvore entre dois degraus (app / board › view). */
export function NavTreeSep({ variant = "chevron" }: { variant?: "chevron" | "slash" }) {
  if (variant === "slash") {
    return (
      <span aria-hidden className="select-none text-base text-line-emphasis">
        /
      </span>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-line-emphasis">
      <path d="M6 3.5 10 8l-4 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
