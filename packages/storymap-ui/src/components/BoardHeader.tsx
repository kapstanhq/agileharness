"use client";

import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
// WS-1 (D4) — the ?copilot=<ref> escalation deep-link receiver.
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import { seedFromCopilotParam, stripCopilotParam } from "@/lib/storymap/copilot/escalation-seed";
import { escalationInstructionFor } from "@/lib/storymap/copilot/escalation";
import { useBoardNotifications } from "@/components/notifications/NotificationCenter";
import { useInboxSummary } from "@/components/useInboxSummary";
import { useCopilotOverview } from "@/components/copilot/useCopilotOverview";
import { boardHomeHref, type BoardView } from "@/components/nav/nav-groups";
import { AppBar, AppBarBrand, AppBarSep } from "@/components/shell/AppBar";
import { ProjectSwitcher } from "@/components/shell/ProjectSwitcher";
import { GroupSwitcher } from "@/components/shell/GroupSwitcher";
import { QuotaRing } from "@/components/shell/QuotaRing";
import { AutonomyPill } from "@/components/shell/AutonomyControl";
import { InboxIconLink } from "@/components/shell/InboxIconLink";
import { SettingsMenu } from "@/components/shell/SettingsMenu";
import { JidoComposer, type JidoDocSurface } from "@/components/chat/JidoComposer";
import { seedJidoChat } from "@/components/chat/jido-bus";
import { inboxHref } from "@/lib/storymap/deep-links";
import { resolveConductorPolicy } from "@/lib/storymap/driver";
import type { BoardConfig, BoardSummary } from "@/lib/storymap/types";

export type { BoardView };

/**
 * O topo de TODA tela de board — a barra de 52px (`shell/AppBar`) e o que pende dela:
 *
 *   esquerda → Agile·HARNESS / projeto ▾ / grupo ▾
 *   direita  → Autonomia · anel da cota · Inbox N · engrenagem (Configurações do board)
 *
 * Logo abaixo, a 2ª barra da tela quando ela tem uma (`toolbar` — o Kanban: ritmo · atividade · busca · Mostrar).
 * Não há mais barra de ABAS: desde a fase 2 cada grupo é UMA página. E no rodapé, o compositor do Jido
 * (`chat/JidoComposer`) — a conversa do board em todas as telas; numa página de documento, a conversa DAQUELE
 * documento (`chatSurface`).
 *
 * O que SAIU da barra (fase 1), e para onde: o Jido do centro → o compositor do rodapé; os blocos → o seletor
 * de grupo; «Agentes N» e o ritmo → a 2ª barra do Kanban; o HealthPill → o anel; «Criar ▾» → o `/criar` do
 * chat; a RAM → a linha de alerta na engrenagem; a navegação inferior do celular → o compositor ocupa o rodapé.
 */
export function BoardHeader({
  boards,
  config,
  view,
  onSmartCapture,
  dockedCopilot,
  dockedChat,
  toolbar,
  chatSurface,
  inboxScope = "board",
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  view: BoardView;
  /**
   * A captura livre saiu da barra (era o «Criar ▾») e virou o comando `/criar` do compositor do Jido. A tela que
   * tem o próprio modal de captura (com os cards do board como contexto da proposta) o entrega aqui e o `/criar`
   * abre o DELA, já com o texto digitado depois do comando; sem ele, o compositor abre o seu.
   */
  onSmartCapture?: (initialText?: string) => void;
  /**
   * The host already renders the Jido as a PERMANENT panel, so this header must NOT mount its own chat: two
   * panels on one route = two `useCopilotAgent` polling the same shared board session, two leases per turn, and
   * a 409 "turno em andamento" against itself. Present ⇒ docked: a `?copilot=` escalation is handed to the host
   * (`onSeed` + `onFocus`) instead of opening the composer.
   */
  dockedCopilot?: { onSeed: (seed: CopilotSeed) => void; onFocus: () => void };
  /**
   * A TELA já mostra uma conversa ANCORADA — a dela, de outra raia. Diferente do `dockedCopilot`, isto NÃO é uma delegação: só suprime o compositor do board. Um
   * painel por rota — o mascote do Jido é UM só, e dois chats montados publicariam humor na mesma chave.
   */
  dockedChat?: boolean;
  /** A SEGUNDA barra própria da tela (o Kanban: ritmo · atividade · busca · Mostrar), logo abaixo do topo. */
  toolbar?: ReactNode;
  /**
   * A conversa DESTA página de documento (Negócio, Produto, Design): o compositor do rodapé passa a falar com o
   * assistente do documento (a superfície de `copilot/chat-surfaces`) em vez do Jido do board.
   */
  chatSurface?: JidoDocSurface;
  /**
   * De quem é o número do Inbox na barra. `board` (padrão) = só o board aberto; `all` = a página /inbox do app, que
   * empresta a barra do primeiro board mas lista TODOS — ali o ícone conta todos (o mesmo número do «Precisa de você»)
   * e leva ao /inbox, senão a tela dizia «Precisa de você 2» com o ícone em 0.
   */
  inboxScope?: "board" | "all";
}) {
  const router = useRouter();
  // O MODO do Jido decide QUANTO os avisos podem interromper — lido aqui porque o motor de notificação roda
  // aqui (sempre montado), e os controles dele aparecem na engrenagem.
  const copilot = useCopilotOverview(config.id);
  // O Inbox de TODOS os boards, lido UMA vez (varredura cara) — o ícone da barra e o seletor de projetos leem
  // daqui, e os dois contam SÓ Decidir: o que o sistema está resolvendo não pede a atenção do dono.
  const inbox = useInboxSummary();
  // Numa página de board o ícone conta SÓ este board (o projeto ativo); o total de todos fica na página /inbox do app.
  const boardInbox = useMemo(() => (inbox?.entries ?? []).filter((e) => e.boardId === config.id), [inbox, config.id]);
  // The notification engine runs HERE (always-mounted) so its SSE handler (sound/web channels + the live board
  // refresh) stays alive; the CONTROLS render inside the gear menu.
  const notifications = useBoardNotifications(copilot.tier);
  const composerMounted = !dockedCopilot && !dockedChat;

  // WS-1 (D4) — escalation deep-link: a ?copilot=<ref> opens the Jido SEEDED with the item's context + the
  // template instruction written in the composer (never auto-sent). The param is cleaned IMMEDIATELY
  // (router.replace) so refresh/back never re-opens it and it never lands in history/bookmark (invariant 6).
  // Invalid ⇒ silent no-op.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  useEffect(() => {
    const raw = searchParams.get("copilot");
    if (!raw) return;
    const ref = seedFromCopilotParam(raw); // invalid ⇒ null, absolute silence (no toast, no console.error)
    if (ref) {
      const instruction = escalationInstructionFor(ref); // generic; the panel refines it
      // Docked ⇒ the escalation belongs to the host's permanent panel; opening the composer over it would be
      // the double-mount this whole prop exists to prevent.
      if (dockedCopilot) {
        dockedCopilot.onSeed({ instruction, ref });
        dockedCopilot.onFocus();
      } else if (composerMounted) {
        // `seedJidoChat` (e não `openJidoChat`): a escalação leva o ITEM junto (a conversa refina a instrução com
        // ele) e, se o compositor ainda não se inscreveu (ele carrega sob demanda), a semente espera por ele.
        seedJidoChat({ instruction, ref });
      }
    }
    // Hygiene runs UNCONDITIONALLY (even for an invalid ref); preserves every other param (?focus= etc.).
    const rest = stripCopilotParam(searchParams.toString());
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [searchParams, pathname, router, dockedCopilot, composerMounted]);

  return (
    <>
      <AppBar
        left={
          <>
            <AppBarBrand href={boardHomeHref(config.id)} />
            <AppBarSep />
            <ProjectSwitcher boards={boards} config={config} view={view} counts={inbox?.byBoard ?? null} />
            <AppBarSep />
            <GroupSwitcher boardId={config.id} view={view} />
          </>
        }
        right={
          <>
            <AutonomyPill config={config} />
            <QuotaRing board={{ id: config.id, conductorSlots: resolveConductorPolicy(config)?.maxSessions ?? null }} />
            {inboxScope === "all" ? (
              <InboxIconLink href="/inbox" total={inbox?.total ?? null} acompanhar={inbox?.acompanhar ?? 0} entries={inbox?.entries ?? []} />
            ) : (
              <InboxIconLink
                href={inboxHref(config.id)}
                total={inbox ? (inbox.byBoard[config.id] ?? 0) : null}
                acompanhar={inbox?.acompanharByBoard?.[config.id] ?? 0}
                entries={boardInbox}
                scope="board"
              />
            )}
            <SettingsMenu config={config} notifications={notifications} onRefresh={() => router.refresh()} />
          </>
        }
      />

      {/* A 2ª barra da tela (o Kanban). */}
      {toolbar}

      {/* O Jido do board — o compositor fixo no rodapé, que abre a conversa por cima da tela. Um chat por rota:
          suprimido quando a tela já tem a sua conversa ancorada (`dockedChat`) ou o host docou o Jido. */}
      {composerMounted && (
        <JidoComposer boardId={config.id} config={config} view={view} onCapture={onSmartCapture} surface={chatSurface} />
      )}
    </>
  );
}
