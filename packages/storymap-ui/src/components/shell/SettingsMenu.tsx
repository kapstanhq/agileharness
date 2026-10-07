"use client";

// A ENGRENAGEM "Configurações do board" — a porta única da máquina, à direita da barra do topo, em TODA
// largura (o sheet "Mais" do celular saiu com a navegação inferior). Ela é só o INVÓLUCRO: no TOPO, a seção de
// AUTONOMIA (`shell/AutonomyControl` — a segunda porta do mesmo painel da pílula da barra); abaixo, a lista que mora
// em `nav/BoardMenu` (Sistema · Lixeira · App · Notificações · Modo econômico · Tema · Recarregar).
//
// É também a porta do «Marcar ajuste» (o modo de feedback visual do overlay — lib/feedback/overlay-launcher): a pílula
// flutuante que fazia esse papel ficava em cima da 1ª raia do Kanban. O item só aparece com o overlay montado.
//
// Dois sinais no gatilho, com o menu FECHADO, porque mudam o comportamento do sistema em silêncio:
//   • o ponto âmbar do modo econômico (os agentes no modelo mais barato);
//   • o ponto terracota da RAM acima do limite — e, aberto, a LINHA de alerta no topo do painel. A RAM saiu da
//     barra (era o `RamAlertChip`): abaixo do limite ela não informa decisão nenhuma (o scheduler admite
//     sozinho); acima, é o que explica por que a vaga extra para agentes não abre.

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { MemoryStick } from "lucide-react";
import { cn } from "@/lib/cn";
import { useVpsMetrics } from "@/components/RunnerStatusProvider";
import { useBoardTrash, TrashDrawer } from "@/components/BoardTrash";
import { BoardMenu, useEconomyMode, useMenuKeyboard } from "@/components/nav/BoardMenu";
import { RAM_ALERT_PCT, useHoverPopover } from "@/components/nav/NavShell";
import type { BoardNotifications } from "@/components/notifications/NotificationCenter";
import { appBarIconButton, appBarPopover } from "@/components/shell/app-bar-shell";
import { feedbackOverlayReady, toggleFeedbackMarking } from "@/lib/feedback/overlay-launcher";
import { AutonomyMenuSection } from "@/components/shell/AutonomyControl";
import type { BoardConfig } from "@/lib/storymap/types";

/** A RAM da máquina quando FREIA (≥ {@link RAM_ALERT_PCT}%), ou null — a regra da linha de alerta. */
export function useRamAlert(): number | null {
  const metrics = useVpsMetrics();
  const pct = metrics?.ram?.usedPct ?? null;
  if (pct == null || pct < RAM_ALERT_PCT) return null;
  return Math.round(pct);
}

export function SettingsMenu({
  config,
  notifications,
  onRefresh,
}: {
  config: BoardConfig;
  notifications: BoardNotifications;
  onRefresh: () => void;
}) {
  const boardId = config.id;
  const { open, setOpen, ref } = useHoverPopover();
  const [trashOpen, setTrashOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A varredura do arquivo só roda quando alguém pode vê-la (menu ou gaveta abertos) — ver useBoardTrash.
  const trash = useBoardTrash(boardId, open || trashOpen);
  const economy = useEconomyMode();
  const economyOn = economy.enabled === true;
  const ram = useRamAlert();
  const menuRef = useMenuKeyboard(open);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus(); // teclado: o foco volta para o gatilho, não para o corpo da página
  }, [setOpen]);

  const title = [
    "Configurações do board",
    ram != null ? `RAM em ${ram}%` : null,
    economyOn ? "modo econômico LIGADO (os agentes usam o modelo mais barato)" : null,
  ]
    .filter(Boolean)
    .join(" — ");

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        aria-label={title}
        className={cn(appBarIconButton, open && "bg-surface-hover text-fg")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        {ram != null ? (
          <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-danger md:right-0.5 md:top-1" />
        ) : economyOn ? (
          <span aria-hidden className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-state-owner md:right-0.5 md:top-1" />
        ) : null}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Configurações do board"
          className={cn(
            appBarPopover,
            "fixed right-2 top-[56px] max-h-[calc(100dvh-72px)] w-[min(19rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain p-2",
            "md:absolute md:right-0 md:top-[calc(100%+6px)] md:max-h-[calc(100dvh-72px)] md:w-[19rem]",
          )}
        >
          <AutonomyMenuSection config={config} onOpenPanel={() => setOpen(false)} />
          {ram != null && (
            <Link
              href="/processes"
              role="menuitem"
              data-menuitem
              onClick={close}
              className="mb-1.5 flex items-start gap-2 rounded-lg bg-danger/10 px-2.5 py-2 text-[12px] leading-snug text-danger transition hover:bg-danger/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger"
            >
              <MemoryStick className="mt-px h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">RAM em {ram}%</span> — acima de {RAM_ALERT_PCT}% o sistema não abre vaga extra
                para agentes.
              </span>
            </Link>
          )}
          <BoardMenu
            boardId={boardId}
            notifications={notifications}
            economy={economy}
            trashCount={trash.count}
            onOpenTrash={() => {
              trash.load();
              setOpen(false);
              setTrashOpen(true);
            }}
            onRefresh={() => {
              onRefresh();
              close();
            }}
            onNavigate={() => setOpen(false)}
            // lido ao ABRIR (o overlay carrega `async`; o menu só existe depois de um clique) — sem hidratação em jogo
            onMarkAdjust={
              feedbackOverlayReady()
                ? () => {
                    setOpen(false);
                    toggleFeedbackMarking();
                  }
                : undefined
            }
          />
        </div>
      )}
      <TrashDrawer open={trashOpen} onClose={() => setTrashOpen(false)} trash={trash} />
    </div>
  );
}
