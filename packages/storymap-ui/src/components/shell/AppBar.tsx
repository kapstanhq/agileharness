"use client";

// A BARRA DO TOPO (52px) — UMA definição do `<header>` para toda página: as de board (o `BoardHeader`) e
// as app-level (`nav/TopBar` → `AppTopBar`: /inbox, /processes, /semana).
//
// Dois lados, nada no meio:
//   esquerda → a marca e a ÁRVORE:  Agile·HARNESS / projeto ▾ / grupo ▾
//   direita  → os sinais:            Autonomia · anel da cota · Inbox N · engrenagem (a Autonomia só em board)
// O Jido saiu do centro: ele é o compositor do rodapé (`chat/JidoComposer`), não um ícone da barra.

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";
import { appBarLeft, appBarRight, appBarSep, appBarShell } from "@/components/shell/app-bar-shell";
import { BrandMark } from "@/components/shell/BrandMark";

/**
 * A ALTURA da barra, publicada como variável CSS no `<html>` — as gavetas (`chat/ChatDock`) começam
 * ABAIXO dela em vez de cobrir a barra. Medida em runtime (ResizeObserver): fail-open no `0px` do fallback.
 */
const TOPBAR_H_VAR = "--ah-topbar-h";

export function AppBar({ left, right }: { left: ReactNode; right: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty(TOPBAR_H_VAR, `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header ref={ref} className={appBarShell}>
      <div className={appBarLeft}>{left}</div>
      <div className={appBarRight}>{right}</div>
    </header>
  );
}

/** A barra "/" entre dois degraus da árvore. */
export function AppBarSep() {
  return (
    <span aria-hidden className={appBarSep}>
      /
    </span>
  );
}

/**
 * A marca, como LINK para a casa (o Kanban do board, ou a porta `/` do app). No desktop o lockup inteiro
 * (Agile·HARNESS); no celular a marca COMPACTA (o ícone do app), para os dois seletores caberem em 390px.
 */
export function AppBarBrand({ href, title = "Ir para o Kanban" }: { href: string; title?: string }) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      className="inline-flex h-10 shrink-0 items-center rounded-md text-fg transition hover:text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg md:h-8"
    >
      <span className="hidden md:inline-flex">
        <AgileHarnessLogo size={13} />
      </span>
      <BrandMark className="md:hidden" />
    </Link>
  );
}
