"use client";

// A navegação por GRUPOS no topnav — os quatro BLOCOS (Negócio · Produto · Design · Software)
// dispostos ao redor do mascote no centro da barra (dois de cada lado).
//
// Cada bloco tem DOIS gestos, e eles não competem: o CLIQUE navega à ferramenta DEFAULT da seção (a
// primeira de `items`), e o HOVER abre um POPOVER com as telas daquela seção como MINIATURAS de layout
// clicáveis — a FORMA da tela (o grid do canvas, as colunas do kanban) reconhecida antes do rótulo, e
// um clique para qualquer ferramenta sem passar pela default. Dentro da seção já aberta o trocador
// continua sendo a barra de abas (`BlockTabs`), logo abaixo do topnav.
//
// Os links são deliberadamente MAGROS: sem borda, sem caixa — nem no ativo (o anel que o ativo tinha
// era a única borda da barra e destoava do resto). O que marca o estado é PESO + um fundo suave; a
// mnemônica de cor da seção vive no quadradinho, que acende no ativo/hover — é ele que sobra no md–lg,
// onde o rótulo some.

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useEscape, useExclusiveNavPopover } from "@/components/nav/NavShell";
import { LayoutThumb } from "@/components/nav/LayoutThumb";
import {
  groupRadicalHref,
  splitGroupsAroundCenter,
  type BoardView,
  type NavGroup,
  type NavItem,
} from "@/components/nav/nav-groups";

/** Carência de fechamento do popover: o caminho diagonal do mouse do link até as miniaturas não pode
 *  derrubá-lo (o mesmo valor do `useHoverPopover` da barra — uma carência só na UI). */
const CLOSE_GRACE_MS = 140;

/**
 * O CENTRO da barra: os blocos partidos ao meio, o Jido (`children`) entre eles, e UM estado de
 * popover aberto compartilhado pelos dois lados — é o que garante que atravessar de um bloco ao outro
 * TROQUE o painel em vez de abrir dois.
 *
 * Esse estado compartilhado cobre bloco↔bloco, mas NÃO cobria bloco↔Jido: o mascote é `children`
 * DESTE contêiner, e é no contêiner que mora o `onPointerLeave` que fecha o painel. Ir do bloco para
 * o Jido nunca sai do contêiner, então o painel do bloco ficava aberto e o balão abria por cima dele.
 * Quem arbitra isso é o registry da barra (`useExclusiveNavPopover`), do qual este estado participa
 * como mais um painel — abrir um bloco fecha o balão e vice-versa.
 */
export function BlockNav({
  boardId,
  activeGroupId,
  view,
  children,
}: {
  boardId: string;
  /** o bloco da view atual (realce do link), ou undefined nas views transversais. */
  activeGroupId?: string;
  /** a view atual — marca a miniatura da tela em que você já está. */
  view: BoardView;
  /** o Jido, centro de gravidade da barra. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openNow = useCallback((id: string) => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(id);
  }, []);
  const closeSoon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(null), CLOSE_GRACE_MS);
  }, []);
  const closeNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(null);
  }, []);

  useEscape(open !== null, closeNow);
  // `closeNow` tem identidade estável (useCallback sem deps) — é a chave do registry da barra.
  useExclusiveNavPopover(open !== null, closeNow);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const [before, after] = splitGroupsAroundCenter();

  const block = (g: NavGroup) => (
    <div
      key={g.id}
      className="relative"
      onPointerEnter={() => openNow(g.id)}
      // Teclado: focar o link abre o painel (o Tab seguinte já cai nas miniaturas); sair do bloco
      // INTEIRO fecha — sem isso o painel ficaria pendurado depois do último tile, esperando um Escape
      // que só quem usa mouse pensa em apertar.
      onFocus={() => openNow(g.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeSoon();
      }}
    >
      <BlockLink group={g} boardId={boardId} active={activeGroupId === g.id} open={open === g.id} />
      {open === g.id && g.items.length > 0 && (
        <BlockPopover group={g} boardId={boardId} view={view} onNavigate={closeNow} />
      )}
    </div>
  );

  return (
    <div className="flex items-center gap-1" onPointerLeave={closeSoon}>
      <div className="hidden items-center gap-0.5 md:flex">{before.map(block)}</div>
      {children}
      <div className="hidden items-center gap-0.5 md:flex">{after.map(block)}</div>
    </div>
  );
}

/**
 * Um BLOCO do centro da barra (lg+ com rótulo, md só o quadradinho de cor). O CLIQUE navega à
 * ferramenta default da seção; o HOVER abre o popover de telas (ver {@link BlockPopover}). Sem borda
 * em nenhum estado: o ativo é PESO + fundo suave, com o quadradinho aceso.
 */
export function BlockLink({
  group,
  boardId,
  active,
  open,
}: {
  group: NavGroup;
  boardId: string;
  active: boolean;
  /** popover deste bloco aberto → o link segue realçado mesmo com o mouse já sobre as miniaturas. */
  open?: boolean;
}) {
  const lit = active || open;
  return (
    <Link
      href={groupRadicalHref(group, boardId)}
      title={`Abrir ${group.label}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group inline-flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13.5px] transition",
        active ? "font-semibold" : "font-medium",
        lit ? "bg-surface-hover text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[11px] w-[11px] shrink-0 rounded-[3px] transition-opacity",
          group.dot,
          lit ? "opacity-100" : "opacity-70 group-hover:opacity-100",
        )}
      />
      <span className="hidden truncate lg:inline">{group.label}</span>
    </Link>
  );
}

/**
 * O popover de TELAS de um bloco: centralizado sob o link, uma miniatura de layout de 100×100 por
 * ferramenta com o nome embaixo. Clicar numa miniatura navega para a tela.
 *
 * Duas sutilezas que o fazem funcionar de verdade:
 *  • o painel é CENTRADO no link (`left-1/2`) mas GRUDA na viewport quando não cabe — a seção de
 *    quatro telas tem ~450px e um bloco perto da ponta jogaria metade dela fora da tela; o bico
 *    (caret) desconta o mesmo deslocamento para continuar apontando o LINK, não o centro do painel.
 *  • o `pt` do invólucro é área de hover CONTÍGUA ao link — se o vão entre link e painel fosse padding
 *    do PAI, ele seria terra de ninguém e o mouse atravessando-o fecharia o popover. O valor (22px)
 *    são os 10px de `py-2.5` da barra — o link acaba ANTES da borda do `<header>` — mais 12px de
 *    respiro: sem isso o painel (e o bico) encostam na borda da barra, como se fossem uma coisa só.
 */
function BlockPopover({
  group,
  boardId,
  view,
  onNavigate,
}: {
  group: NavGroup;
  boardId: string;
  view: BoardView;
  onNavigate: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  const shiftRef = useRef(0);

  const clampToViewport = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Mede DESCONTANDO o deslocamento já aplicado, senão o cálculo realimenta a si mesmo.
    const left = rect.left - shiftRef.current;
    const right = rect.right - shiftRef.current;
    const margin = 8;
    let next = 0;
    if (left < margin) next = margin - left;
    else if (right > window.innerWidth - margin) next = window.innerWidth - margin - right;
    next = Math.round(next);
    if (next === shiftRef.current) return;
    shiftRef.current = next;
    setShift(next);
  }, []);

  useLayoutEffect(() => {
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [clampToViewport]);

  return (
    <div
      ref={ref}
      className="absolute left-1/2 top-full z-[70] pt-[22px]"
      style={{ transform: `translateX(calc(-50% + ${shift}px))` }}
    >
      <nav
        aria-label={`Telas de ${group.label}`}
        className="relative rounded-xl border border-line bg-surface p-3 shadow-lg"
      >
        <span
          aria-hidden
          className="absolute -top-[5px] h-2.5 w-2.5 rotate-45 rounded-tl-[3px] border-l border-t border-line bg-surface"
          style={{ left: `calc(50% - 5px - ${shift}px)` }}
        />
        <p className="flex items-center gap-1.5 px-0.5 pb-2.5 text-[10px] font-bold uppercase tracking-[0.1em] text-fg-subtle">
          <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-[2px]", group.dot)} />
          {group.label}
        </p>
        <div className="flex items-start gap-2">
          {group.items.map((item) => (
            <ScreenTile
              key={item.id}
              item={item}
              boardId={boardId}
              active={item.id === view}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Uma tela no popover: a miniatura de 100×100 + o nome. É um `<Link>` de verdade — teclado, foco
 *  visível e "abrir em nova aba" funcionam como em qualquer link da barra. */
function ScreenTile({
  item,
  boardId,
  active,
  onNavigate,
}: {
  item: NavItem;
  boardId: string;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href(boardId)}
      prefetch={false}
      title={item.hint}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className="group flex w-[100px] shrink-0 flex-col items-center gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <span
        className={cn(
          "flex h-[100px] w-[100px] flex-col overflow-hidden rounded-[10px] border bg-inset p-2.5 transition",
          active
            ? "border-accent/60 bg-accent/[0.06]"
            : "border-line group-hover:border-accent/50 group-hover:bg-accent/[0.05]",
        )}
      >
        {/* Sem miniatura declarada (só possível num item transversal) o ícone do item segura o lugar —
            nunca um quadrado vazio. */}
        {item.thumb ? <LayoutThumb kind={item.thumb} /> : <Icon className="m-auto h-6 w-6 text-fg-subtle" />}
      </span>
      <span
        className={cn(
          "text-center text-[11.5px] font-semibold leading-tight tracking-[-0.005em] transition-colors",
          active ? "text-fg" : "text-fg-muted group-hover:text-fg",
        )}
      >
        {item.label}
      </span>
    </Link>
  );
}
