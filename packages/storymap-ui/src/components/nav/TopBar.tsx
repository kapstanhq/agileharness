"use client";

// A barra das páginas APP-LEVEL (/inbox, /processes, /semana…) — as que não pertencem a um board.
//
// Veste a MESMA barra do board (`shell/AppBar`, 52px): a marca, "/", o título da página; à direita o anel da
// cota e o Inbox — a cota do Claude e o número de decisões têm UMA implementação no produto inteiro, em vez de
// uma por página. Sem engrenagem: as configurações são de um board, e aqui não há board.
//
// (O antigo `TopBar` de três slots saiu: a barra não tem mais centro — o Jido mora no compositor do rodapé.)

import { ArrowLeft } from "lucide-react";
import { BackButton } from "@/components/nav/NavShell";
import { useInboxSummary } from "@/components/useInboxSummary";
import { AppBar, AppBarBrand, AppBarSep } from "@/components/shell/AppBar";
import { QuotaRing } from "@/components/shell/QuotaRing";
import { InboxIconLink } from "@/components/shell/InboxIconLink";
import { appBarIconButton } from "@/components/shell/app-bar-shell";

export function AppTopBar({ title, backHref }: { title: string; backHref?: string }) {
  const inbox = useInboxSummary();
  return (
    <AppBar
      left={
        <>
          {/* Voltar de VERDADE (histórico) — à esquerda, o lugar universal do "voltar", visível no celular
              também. Fallback = o pai lógico da página (backHref) ou a porta do app. */}
          <BackButton fallbackHref={backHref ?? "/"} title="Voltar" className={`${appBarIconButton} -ml-1.5`}>
            <ArrowLeft className="h-4 w-4" />
          </BackButton>
          <AppBarBrand href="/" title="Ir para o Kanban" />
          <AppBarSep />
          <span className="truncate text-[13px] font-semibold text-fg">{title}</span>
        </>
      }
      right={
        <>
          <QuotaRing />
          <InboxIconLink href="/inbox" total={inbox?.total ?? null} acompanhar={inbox?.acompanhar ?? 0} entries={inbox?.entries ?? []} />
        </>
      }
    />
  );
}
