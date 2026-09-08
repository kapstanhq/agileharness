"use client";

// A CASCA da barra de topo — UMA definição do `<header>` para todas as páginas.
//
// Antes só as páginas de board tinham barra: quem entrava em /processes caía numa página sem topo,
// com um `← Boards` de texto e um medidor de cota PRÓPRIO — que lia a estimativa do ccusage e
// mostrava 85% enquanto a barra do board, na página ao lado, mostrava o número REAL da assinatura.
// Duas barras = dois números; a cura não é sincronizar as duas, é ter UMA.
//
// TopBar dá os três slots (esquerda = a marca + o board · centro = os blocos com o Jido no meio ·
// direita = os medidores) e nada mais: quem monta o conteúdo é o BoardHeader (modo board) ou o
// AppTopBar (modo app-level, sem board). Item novo na barra entra por um dos slots — nunca por um
// `<header>` novo.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { HealthPill } from "@/components/HealthPill";
import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";
import { BackButton, NavTreeSep } from "@/components/nav/NavShell";
import { topBarShell, topBarSlotCenter, topBarSlotLeft, topBarSlotRight } from "@/lib/ui";

/**
 * A ALTURA da barra, publicada como variável CSS no `<html>`.
 *
 * Existe por causa de um conflito de camadas: um overlay `inset-0` (a gaveta do chat) cobre a barra
 * inteira — e desde que o mascote passou a morar SÓ no topnav, escurecê-lo é apagar a única cara do
 * Jido justamente quando ele está trabalhando. A gaveta então começa ABAIXO da barra, e para isso
 * precisa saber a altura dela. Medida em runtime (ResizeObserver) em vez de cravada: a barra muda de
 * altura com o breakpoint e com o próprio conteúdo, e um número mágico apodrece na primeira mudança.
 *
 * Fail-open: sem a variável, o consumidor cai no `0px` do fallback — que é o comportamento de antes.
 */
const TOPBAR_H_VAR = "--ah-topbar-h";

/** O `<header>` compartilhado: mesma altura, borda, superfície e grade em TODA página. */
export function TopBar({
  left,
  center,
  right,
}: {
  left: ReactNode;
  center?: ReactNode;
  right: ReactNode;
}) {
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

  // As classes da casca vivem em `lib/ui` (módulo neutro) porque o ESQUELETO da barra —
  // server-side, para não custar JS — precisa exatamente das mesmas medidas. Ver a nota lá.
  return (
    <header ref={ref} className={topBarShell}>
      <div className={topBarSlotLeft}>{left}</div>
      <div className={topBarSlotCenter}>{center}</div>
      <div className={topBarSlotRight}>{right}</div>
    </header>
  );
}

/**
 * A barra das páginas APP-LEVEL (Processos, Perguntas…) — as que não pertencem a um board.
 *
 * Mesma casca do board, mesmo wordmark, e — o ponto — o MESMO HealthPill: a cota do Claude passa a
 * ter uma implementação só no produto inteiro (a janela real da assinatura), em vez de uma por página.
 */
export function AppTopBar({ title, backHref }: { title: string; backHref?: string }) {
  return (
    <TopBar
      left={
        <>
          {/* Voltar de VERDADE (histórico) fica À ESQUERDA, o lugar universal do "voltar" — e visível
              no mobile também (era `hidden md:`, deixando as páginas app-level sem saída no celular).
              Fallback = o pai lógico da página (backHref) ou a home do app. */}
          <BackButton
            fallbackHref={backHref ?? "/"}
            title="Voltar"
            className="mr-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            <ArrowLeft className="h-4 w-4" />
          </BackButton>
          {/* O logo do AgileHarness (lockup Agile·HARNESS), que leva à home do app. */}
          <Link
            href="/"
            className="hidden text-fg transition hover:text-fg-muted lg:inline-flex"
            title="Início do AgileHarness"
          >
            <AgileHarnessLogo size={13} />
          </Link>
          <span className="mx-1 inline-flex">
            <NavTreeSep />
          </span>
          <span className="truncate text-[13px] font-medium text-fg">{title}</span>
        </>
      }
      right={<HealthPill />}
    />
  );
}
