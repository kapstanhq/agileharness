"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/lib/useMediaQuery";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
// WS-1 (D4) — the ?copilot=<ref> escalation deep-link receiver.
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import { seedFromCopilotParam, stripCopilotParam } from "@/lib/storymap/copilot/escalation-seed";
import { escalationInstructionFor } from "@/lib/storymap/copilot/escalation";
import {
  Bot,
  Check,
  ChevronDown,
  Home,
  Inbox,
  KanbanSquare,
  Lightbulb,
  ListChecks,
  Map,
  MemoryStick,
  MessageCircleQuestion,
  MoreHorizontal,
  Plus,
  Settings2,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useBoardNotifications, type BoardNotifications } from "@/components/notifications/NotificationCenter";
import { useAgentPresence, useRunnerSnapshot, useTerminalAttention, useVpsMetrics } from "@/components/RunnerStatusProvider";
import { agentPulse } from "@/lib/storymap/agent-presence";
import { useInboxSummary } from "@/components/useInboxSummary";
import { NavAgentsChip } from "@/components/nav/NavAgentsChip";
import { BoardPaceChip, BoardPaceSheetSection } from "@/components/nav/BoardPaceChip";
import { HealthPill } from "@/components/HealthPill";
import { AgileHarnessLogo } from "@/components/AgileHarnessLogo";
import { TopBar } from "@/components/nav/TopBar";
import { CopilotFace } from "@/components/copilot/CopilotFace";
import { CopilotSpeechBubble, useSpeechCue } from "@/components/copilot/CopilotSpeech";
import {
  deriveMood,
  EXPRESSIONS,
  isUrgentMood,
  isWorking,
  moodDot,
  type FaceSignals,
} from "@/lib/storymap/copilot/face";
import { copilotSpeech } from "@/lib/storymap/copilot/speech";
import { useCopilotAnnouncer } from "@/components/copilot/useCopilotAnnouncer";
import { useCopilotOverview, type CopilotOverview } from "@/components/copilot/useCopilotOverview";
import { currentCopilotFace, onCopilotFace, type CopilotFaceState } from "@/components/copilot/face-bus";
import { copilotActivityAction, copilotSessionMeterAction, type CopilotSessionMeter } from "@/app/copilot-actions";
import { groupActivity } from "@/lib/storymap/copilot/activity-view";
import type { CopilotActivityEntry } from "@/lib/storymap/copilot/activity";
import { onCopilotSessionChanged } from "@/components/copilot/meter-bus";
import { useBoardTrash, TrashDrawer } from "@/components/BoardTrash";
import { BoardMenu, useEconomyMode, useMenuKeyboard } from "@/components/nav/BoardMenu";
import { ViewControls, type Filters } from "@/components/nav/ViewControls";
import {
  NavChip,
  NavCrumb,
  NavDot,
  NavPopover,
  NavPopoverEmpty,
  NavPopoverFooter,
  NavPopoverRow,
  NavPopoverTitle,
  RAM_ALERT_PCT,
  useEscape,
  useHoverPopover,
} from "@/components/nav/NavShell";
import { BlockNav } from "@/components/nav/GroupNav";
import { BlockTabs } from "@/components/nav/BlockTabs";
import {
  groupForView,
  INICIO_ITEM,
  isBlockGroup,
  NAV_GROUPS,
  SISTEMA_GROUP,
  viewHref,
  type BoardView,
  type NavGroup,
} from "@/components/nav/nav-groups";
import { InboxItemCard } from "@/components/inbox/InboxItemCard";
import type { InboxEntry } from "@/lib/storymap/inbox/entries";
import { inboxHref } from "@/lib/storymap/deep-links";
import type { BoardConfig, BoardSummary } from "@/lib/storymap/types";

// `Filters` passou a morar com quem o edita (nav/ViewControls); re-exportado daqui para os screens
// que já o importam deste módulo não terem de mudar de origem — mesmo motivo do `BoardView`.
export type { Filters };
export type { BoardView };

// O modelo de GRUPOS (Início · Negócio · Produto · Design · Software), o tipo `BoardView` e os
// helpers de rota (navItemForView, viewHref, groupForView…) vivem em @/components/nav/nav-groups;
// os componentes de navegação por grupo (crumbs + popovers) em @/components/nav/GroupNav.

// Q2 (perf) — o CopilotChat sai do bundle de TODA rota de board via next/dynamic (ssr:false): o chunk
// da conversa (streaming, HITL, medidor) só baixa quando o drawer de fato abre. A renderização abaixo não
// muda — o drawer já faz `if(!open) return null` internamente, então isto é ganho de BUNDLE, não de mount.
// `CopilotChatPanel` (o rail permanente da home) segue no import estático do InicioScreen, à parte disto.
const CopilotChat = dynamic(() => import("@/components/CopilotChat").then((m) => m.CopilotChat), { ssr: false });

// A captura livre é uma ação do TOPNAV, logo de TODA página — não só do Kanban/Mapa/Início (as três
// telas que passam `onSmartCapture`). Quem não passa handler ganha este modal, montado pelo próprio
// header. Mesmo tratamento de bundle do chat: só baixa quando o modal abre de fato.
const SmartCaptureModal = dynamic(() => import("@/components/SmartCaptureModal").then((m) => m.SmartCaptureModal), {
  ssr: false,
});

/** `md` no tailwind.config — a largura a partir da qual a barra completa (chips + ⋯) assume. */
const DESKTOP_MIN_WIDTH = "(min-width: 768px)";

// Q3 (perf) — `useMediaQuery` (lib/useMediaQuery) decide se o viewport casa `md`+ AGORA. Aqui ele existe
// pelo MESMO motivo do rail do chat: um filho escondido por CSS continua MONTADO, e no celular os useEffect
// do ActionsChip e do OverflowMenu (EventSource + poll de 60s + getInboxSummaryAction) rodavam invisíveis.
// (Havia uma cópia local desta função aqui e outra no InicioScreen — três definições da MESMA regra de
// layout, que é como um breakpoint diverge sem ninguém ver.)

/**
 * A barra de topo em três zonas, com UMA gramática (ver `components/nav/NavShell`):
 *
 *   esquerda → a ÁRVORE de contexto:  ▣ AgileHarness / acme ▾  ›  Kanban ▾   ⋯
 *              A view deixou de ser um item solto no centro: ela é o galho do board (você está NO
 *              board acme, NA view Kanban). Gatilhos simples (sem borda, só rótulo + chevron),
 *              popovers ricos. O ⋯ fecha a árvore — é a gestão DESTE board (config · lixeira ·
 *              filtros · notificações · tema), e por isso encosta no último degrau, não na direita.
 *   centro   → o COPILOTO — o único item com quem se CONVERSA fica no lugar mais alcançável da barra.
 *   direita  → os MEDIDORES, os três com o mesmo desenho (ícone + número): Inbox (quantas
 *              pendências) · runs · Claude. Depois deles, a ação primária (Capturar).
 *
 * No mobile a árvore encolhe para marca + board (a troca de view vive na bottom-nav) e os medidores
 * de máquina (runs/Claude) somem — sobra Inbox, que é o que pede você.
 */
export function BoardHeader({
  boards,
  config,
  view,
  filters,
  onFilterChange,
  onSmartCapture,
  showMeta,
  onToggleMeta,
  dockedCopilot,
  dockedChat,
  subnav,
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  view: BoardView;
  filters?: Filters;
  onFilterChange?: (next: Filters) => void;
  /**
   * Open the free-text smart capture (LLM proposes one or many cards to review). OPTIONAL: as telas
   * que têm os cards em mão (mapa/kanban/início) passam o seu, para a proposta nascer com o board
   * como contexto e para refrescar a view por trás. Quem não passa NÃO fica sem o botão — o header
   * abre o seu próprio modal (sem o contexto dos cards, que é enriquecimento, não requisito).
   */
  onSmartCapture?: () => void;
  /** map/kanban: current state of the "show card details" toggle */
  showMeta?: boolean;
  /** map/kanban: flips persona/system chips on cards */
  onToggleMeta?: () => void;
  /**
   * The host already renders the Jido as a PERMANENT panel (the home's rail), so this header must NOT
   * mount its own drawer: two panels on one route = two `useCopilotAgent` polling the same shared
   * board session, two leases per turn, and a 409 "turno em andamento" against itself.
   *
   * Present ⇒ docked. The header then delegates instead of opening: `onSeed` hands over a `?copilot=`
   * escalation for the rail to consume, `onFocus` is what the chip does. Absent ⇒ today's drawer,
   * unchanged — which is what every other view gets, including the home below `lg` (where the rail is
   * genuinely unmounted, not merely hidden).
   */
  dockedCopilot?: { onSeed: (seed: CopilotSeed) => void; onFocus: () => void };
  /**
   * A TELA já mostra uma conversa ANCORADA — a dela, de outra raia (o Explorador da bancada de Ideias, por
   * exemplo). Diferente do `dockedCopilot`, isto NÃO é uma delegação: a conversa da tela não é a do board e não
   * sabe receber uma escalação de item. É só uma supressão.
   *
   * Ela existe pelo MASCOTE, não pela sessão (raias distintas não brigam por lease): o rosto do Jido é UM só, e
   * o painel montado é quem fala por ele (face-bus). Com os dois na tela, os dois publicariam humor na mesma
   * chave e o mascote ficaria alternando entre duas conversas — que é exatamente o "em dois lugares ao mesmo
   * tempo" que a régua proíbe. Um painel por rota, e o da tela ganha quando existe.
   */
  dockedChat?: boolean;
  /**
   * O SUBNAV da página — a segunda barra (abas da seção + ações da tela).
   *   • ausente  → as ABAS da seção aparecem (dirigidas pelo grupo), sem ações próprias;
   *   • objeto   → idem + as `actions` alinhadas à direita das abas;
   *   • `false`  → NENHUMA segunda barra. É a opção das páginas de DETALHE (o card aberto), onde a
   *     tela não é uma "ferramenta da seção" e sim UM documento: as abas ali só competiriam com a
   *     barra do próprio documento (voltar + título + ações) logo abaixo.
   */
  subnav?: boolean | { actions?: ReactNode };
}) {
  const router = useRouter();
  // Q3 (perf) — mount guard real por viewport: o ActionsChip e o OverflowMenu só MONTAM no desktop, para
  // os EventSource/poll deles (getInboxSummaryAction · trash) não rodarem invisíveis no celular — a classe
  // `md:flex` só os escondia por CSS, o React montava os dois e disparava os useEffect assim mesmo.
  const isDesktop = useMediaQuery(DESKTOP_MIN_WIDTH);
  // O bloco ATIVO (destaca no centro) e as ABAS da seção. A barra de abas é dirigida pelo GRUPO:
  // aparece em toda seção com MAIS de uma ferramenta — então as superfícies-doc (Lean Canvas,
  // Posicionamento) também a ganham. Seção de ferramenta única (Design) não mostra. A prop `subnav`
  // decide as AÇÕES da tela (alinhadas à direita das abas) e, em `false`, SUPRIME a barra inteira.
  const activeGroup = groupForView(view);
  // `subnav === false` é o opt-out EXPLÍCITO da segunda barra (páginas de detalhe). Ausente segue
  // como sempre: as abas aparecem em toda seção com ≥2 ferramentas.
  const groupTabs = subnav !== false && activeGroup && activeGroup.items.length > 1 ? activeGroup.items : null;
  const subnavActions = subnav && typeof subnav === "object" ? subnav.actions : undefined;
  // Os controles da VIEW (filtros · detalhes) só existem nas telas que os passam (Mapa, Kanban);
  // sem eles E sem ações da tela, a barra de abas não ganha zona de ações nenhuma.
  const viewControls =
    (filters && onFilterChange) || onToggleMeta ? (
      <ViewControls
        config={config}
        filters={filters}
        onFilterChange={onFilterChange}
        showMeta={showMeta}
        onToggleMeta={onToggleMeta}
      />
    ) : null;
  // O ESTADO DO JIDO, lido UMA vez para os dois consumidores da barra: o mascote (humor/ciclo em voo) e a
  // política de aviso (o MODO decide QUANTO ele pode te interromper). Antes o CopilotChip fazia este fetch
  // sozinho, e o motor de notificação não tinha como saber o modo — os avisos não tinham nível nenhum.
  const copilot = useCopilotOverview(config.id);
  // O Inbox de TODOS os boards, lido UMA vez (varredura cara) — o chip, a aba do celular, a fala do Jido e o seletor de
  // boards leem daqui, e todos contam SÓ Decidir: o que o sistema está resolvendo não pede a atenção do dono.
  const inbox = useInboxSummary();
  // The notification engine runs HERE (always-mounted) so its SSE handler (sound/web
  // channels + the live board refresh) stays alive; the CONTROLS render inside the ⋯ menu.
  const notifications = useBoardNotifications(copilot.tier);
  // WS8 — the conversational copiloto drawer (topnav-triggered).
  const [copilotOpen, setCopilotOpen] = useState(false);
  // Captura livre de fallback: só monta quando o host NÃO passou `onSmartCapture` — assim o botão
  // "Criar tarefa" existe em toda página (Design, Estilo, Doc, Ideias…) em vez de sumir.
  const [captureOpen, setCaptureOpen] = useState(false);
  const openCapture = onSmartCapture ?? (() => setCaptureOpen(true));
  // WS-1 (D4) — escalation deep-link: a ?copilot=<ref> opens the drawer SEEDED with the item's context + the
  // template instruction (composer, never auto-sent). The param is cleaned IMMEDIATELY (router.replace) so
  // refresh/back never re-opens it and it never lands in history/bookmark (invariant 6). Invalid ⇒ silent no-op.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [copilotSeed, setCopilotSeed] = useState<CopilotSeed | null>(null);
  useEffect(() => {
    const raw = searchParams.get("copilot");
    if (!raw) return;
    const ref = seedFromCopilotParam(raw); // invalid ⇒ null, absolute silence (no toast, no console.error)
    if (ref) {
      const next = { instruction: escalationInstructionFor(ref), ref }; // generic; the panel refines it
      // Docked ⇒ the escalation belongs to the host's permanent rail; opening a drawer over it would
      // be the double-mount this whole prop exists to prevent.
      if (dockedCopilot) {
        dockedCopilot.onSeed(next);
        dockedCopilot.onFocus();
      } else {
        setCopilotSeed(next);
        setCopilotOpen(true);
      }
    }
    // Hygiene runs UNCONDITIONALLY (even for an invalid ref); preserves every other param (?focus= etc.).
    const rest = stripCopilotParam(searchParams.toString());
    router.replace(rest ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [searchParams, pathname, router, dockedCopilot]);

  // Hand-off: a host can only decide it's docked AFTER mount (the rail's breakpoint is a media query),
  // and child effects run before the parent's — so on a deep-linked load the branch above still takes
  // the drawer path, and one tick later `dockedCopilot` appears. Without this the drawer would blink
  // open and the escalation would be stranded in state the rail can't see. Flushing it here is what
  // makes the two paths converge on the same seed.
  useEffect(() => {
    if (!dockedCopilot || !copilotSeed) return;
    dockedCopilot.onSeed(copilotSeed);
    dockedCopilot.onFocus();
    setCopilotSeed(null);
    setCopilotOpen(false);
  }, [dockedCopilot, copilotSeed]);

  return (
    <>
      {/* A casca do `<header>` vive em nav/TopBar (UMA definição da barra, compartilhada com as
          páginas app-level como /processes); aqui só montamos os três slots. */}
      <TopBar
        // ── Esquerda: a ÁRVORE — ▣ AgileHarness / board ▾ › view ▾ ⋯ ────────────────────────────
        left={
          <>
            {/* Wordmark SEM o quadrado de marca — leva ao Início do board; no hover troca o texto
                para "Ir para o início". Sem a barra "/" entre ele e o board. */}
            <WordmarkHome boardId={config.id} />
            <BoardCrumb boards={boards} config={config} view={view} counts={inbox?.byBoard ?? null} />
            {/* O SISTEMA deste board (⚙) — encosta no board. Desktop-only (no mobile o sheet "Mais" da
                bottom-nav assume). Os BLOCOS não moram mais aqui: foram para o centro, ao redor do Jido. */}
            <div className="hidden items-center md:flex">
              {/* Q3 — mount só no desktop: no celular o ⚙ não existe (o sheet "Mais" da bottom-nav assume),
                  então nem monta — o useBoardTrash dele (EventSource + poll de 60s) deixa de rodar invisível. */}
              {isDesktop && (
                <SistemaMenu config={config} onRefresh={() => router.refresh()} notifications={notifications} />
              )}
            </div>
          </>
        }
        // ── Centro: os 4 BLOCOS com o Jido no MEIO — dois de cada lado (Negócio · Produto | Jido |
        //    Design · Software). O clique num bloco abre a ferramenta default da seção; o HOVER abre o
        //    popover com as telas da seção em miniatura (BlockNav é quem partilha esse estado entre os
        //    dois lados). No mobile (< md) os blocos somem (a bottom-nav troca de seção) e sobra o Jido.
        center={
          <BlockNav boardId={config.id} activeGroupId={activeGroup?.id} view={view}>
            {/* O Jido, centro de gravidade da barra — e agora a ÚNICA casa do mascote: ele saiu do chat e
                fica SEMPRE aqui, com conversa aberta ou fechada. Antes ele se mudava para o painel quando
                uma conversa abria (e a barra pendurava a placa "volto logo" no buraco); com um rosto só, em
                um lugar só, não há mudança, não há buraco e não há placa — o operador sempre sabe onde
                olhar para ver como ele está. O que ele DIZ pende dele, num balão (CopilotSpeechBubble). */}
            <div className="flex min-w-[2.25rem] items-center justify-center">
              <CopilotChip boardId={config.id} overview={copilot} needsYou={inbox?.total ?? 0} />
            </div>
          </BlockNav>
        }
        // ── Direita: os MEDIDORES (mesmo desenho) + a ação primária. ────────────────────────────
        right={
          // Medidores (desktop): Inbox · agentes · (RAM, só quando freia) · cota Claude — mesma gramática. No
          // MOBILE some tudo: o Inbox virou aba da bottom-nav (com contador) e os medidores de
          // máquina moram na faixa do sheet "Mais", deixando o topo do celular limpo (marca + board +
          // Jido). A ação Capturar continua sendo o FAB central da bottom-nav.
          <>
            <div className="hidden items-center gap-1 md:flex">
              {/* Q3 — o Inbox (ActionsChip) só monta no desktop: no celular ela é a aba com contador da
                  bottom-nav (MobileInboxTab). A leitura do Inbox é uma só por página (useInboxSummary). */}
              {isDesktop && <ActionsChip boardId={config.id} total={inbox?.total ?? null} acompanhar={inbox?.acompanhar ?? 0} entries={inbox?.entries ?? []} />}
              {/* «Agentes N» no lugar dos chips Terminal e Processos: quantos agentes da FROTA trabalham de fato (os
                  terminais do dono ficam no popover, recolhidos). A RAM só aparece quando freia. */}
              {/* Só monta no desktop (o mesmo motivo do Inbox acima): o poll de 60s dos terminais não roda invisível. */}
              {isDesktop && <NavAgentsChip />}
              {/* O RITMO do board (pausado · devagar · normal): o dono e o agente que orquestra param o board inteiro
                  daqui. Só no desktop — no celular o mesmo painel mora no sheet «Mais». */}
              {isDesktop && <BoardPaceChip boardId={config.id} />}
              <RamAlertChip />
              <HealthPill />
            </div>
            <span className="hidden md:ml-1.5 md:inline-flex">
              <CaptureMenu boardId={config.id} onSmartCapture={openCapture} />
            </span>
          </>
        }
      />

      {/* A barra de ABAS da seção — as ferramentas irmãs (troca) + as ações da tela à direita. Dirigida
          pelo GRUPO: aparece em toda seção com ≥2 ferramentas (Negócio, Produto, Software), inclusive
          nas superfícies-doc. Seção de ferramenta única (Design) e views transversais não mostram.
          É aqui que moram os controles da VIEW (filtros · detalhes dos cards): saíram do ⋯ para ficar
          ao lado do conteúdo que alteram — as duas telas que os usam (Mapa, Kanban) vivem em seções
          de 4 ferramentas, então a barra está sempre presente para hospedá-los. */}
      {groupTabs && activeGroup && (
        <BlockTabs
          items={groupTabs}
          view={view}
          boardId={config.id}
          // Seção SEM bloco aceso no topo (o Sistema) se apresenta na própria barra — sem isso as
          // abas ficariam órfãs, sem nada na tela dizendo de onde vieram.
          lead={
            isBlockGroup(activeGroup) ? undefined : (
              <>
                <Settings2 className="h-3.5 w-3.5" aria-hidden />
                {activeGroup.label}
              </>
            )
          }
          actions={
            viewControls || subnavActions ? (
              <>
                {viewControls}
                {subnavActions}
              </>
            ) : undefined
          }
        />
      )}

      <MobileBottomNav view={view} config={config} onSmartCapture={openCapture} notifications={notifications} inboxCount={inbox?.total ?? null} />

      {/* WS8 — the conversational copiloto chat, opened from the topnav button above. WS-1 — seeded when a
          ?copilot=<ref> escalation opened it; closing clears the seed so the chip reopens the normal board chat.
          Suppressed when the host docks the Jido as a permanent rail (see `dockedCopilot`) OR when the screen
          already shows its own anchored conversation (see `dockedChat`) — um painel por rota, sempre. */}
      {!dockedCopilot && !dockedChat && (
        <CopilotChat
          boardId={config.id}
          boardName={config.name}
          open={copilotOpen}
          seed={copilotSeed ?? undefined}
          onClose={() => {
            setCopilotOpen(false);
            setCopilotSeed(null);
          }}
        />
      )}

      {/* A captura de fallback (só existe quando o host não passou a sua). Sem `cards`: o header não os
          tem — a proposta nasce sem o contexto do board, que é enriquecimento e não requisito. */}
      {captureOpen && (
        <SmartCaptureModal
          boardId={config.id}
          config={config}
          onClose={() => {
            setCaptureOpen(false);
            router.refresh();
          }}
          onCreated={() => router.refresh()}
          onOpenCard={(id) => router.push(`/board/${config.id}/card/${id}`)}
          onOpenIdeas={() => router.push(`/board/${config.id}/ideias`)}
        />
      )}
    </>
  );
}

/**
 * O logo do AgileHarness (lockup Agile·HARNESS). É um LINK para o Início do board; no HOVER o logo
 * troca por "Ir para o início" (os dois empilhados na MESMA célula do grid, então a largura fica na
 * maior e não há pulo de layout). Some abaixo de lg — ali sobra o board + os blocos —, como o
 * wordmark já fazia antes.
 */
function WordmarkHome({ boardId }: { boardId: string }) {
  return (
    <Link
      href={`/board/${boardId}/inicio`}
      title="Ir para o início"
      className="group mr-3 hidden items-center text-fg lg:inline-grid"
    >
      <span className="col-start-1 row-start-1 whitespace-nowrap transition group-hover:opacity-0">
        <AgileHarnessLogo size={13} />
      </span>
      <span className="col-start-1 row-start-1 whitespace-nowrap text-[15px] font-semibold tracking-tight text-accent-ink opacity-0 transition group-hover:opacity-100">
        Ir para o início
      </span>
    </Link>
  );
}

/**
 * O primeiro degrau da árvore: QUAL board. Era um <select> nativo (menu do sistema operacional, sem
 * informação nenhuma) — virou um crumb com popover: cada board mostra quantas pendências tem, então
 * dá para SAIR de um board sabendo que o outro está te chamando. As contagens são carregadas ao
 * abrir (uma varredura por board é cara para deixar rodando à toa) e valem 60s.
 */
function BoardCrumb({
  boards,
  config,
  view,
  counts,
}: {
  boards: BoardSummary[];
  config: BoardConfig;
  view: BoardView;
  /** as decisões do dono por board — a MESMA leitura do chip (getInboxSummaryAction); null enquanto carrega. */
  counts: Record<string, number> | null;
}) {
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();
  // Os runs ativos já chegam por SSE (é o mesmo snapshot do chip de Processos) — de graça, dá para
  // dizer QUAL board está trabalhando agora, e não só quantos runs existem no total.
  const { running } = useRunnerSnapshot();
  const busy = new Set(running.map((r) => r.board));

  return (
    <div ref={ref} className="relative min-w-0" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <NavCrumb
        label={config.name}
        open={open}
        onClick={() => setOpen((o) => !o)}
        title="Trocar de board"
        // Fundo SEMPRE ligado (não só no hover/aberto): o crumb do board é o gatilho de trocar de
        // board, e um gatilho precisa PARECER clicável em repouso — não só quando o mouse encosta.
        // Mas SEM anel: o fundo suave + o peso + o chevron já dizem "isto abre", e a borda fazia dele a
        // única caixa desenhada da barra (a mesma limpeza dos blocos, que perderam o `ring` do ativo).
        // O repouso fica a 60% do fundo para o hover/aberto ainda TER para onde subir — sem o anel,
        // um fundo cheio em repouso deixaria o gatilho sem nenhuma reação ao mouse.
        className={cn(
          "max-w-[9rem] rounded-lg font-semibold text-fg",
          open ? "bg-surface-hover" : "bg-surface-hover/60",
        )}
      />
      {open && (
        <NavPopover align="left" label="Boards" className="w-56">
          <NavPopoverTitle meta={`${boards.length}`}>Boards</NavPopoverTitle>
          <ul className="flex flex-col">
            {boards.map((b) => {
              const isActive = b.id === config.id;
              const pend = counts?.[b.id] ?? null;
              return (
                <li key={b.id}>
                  <Link
                    // Trocar de board PRESERVA a view (você continua no Kanban, só que no outro board).
                    href={viewHref(view, b.id)}
                    onClick={() => setOpen(false)}
                    title={
                      pend == null
                        ? b.name
                        : pend > 0
                          ? `${b.name} — ${pend} para você decidir`
                          : `${b.name} — nada para você decidir`
                    }
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-1.5 py-1.5 transition hover:bg-surface-hover",
                      isActive && "bg-surface-hover",
                    )}
                  >
                    <span
                      className={cn("min-w-0 flex-1 truncate text-[12px]", isActive ? "font-medium text-fg" : "text-fg-muted")}
                    >
                      {b.name}
                    </span>
                    {/* Trabalhando agora (run headless rodando neste board). */}
                    {busy.has(b.id) && <NavDot pulse />}
                    {/* Decisões do dono (só Decidir): o número SEMPRE aparece (um "0" quieto vale tanto quanto um "3"
                        âmbar — é a diferença entre "board limpo" e "board que eu não sei"). "…" enquanto carrega. */}
                    <span
                      className={cn(
                        "inline-flex h-4 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                        pend == null
                          ? "text-fg-subtle"
                          : pend > 0
                            ? "bg-state-owner text-state-owner-fg"
                            : "text-fg-subtle",
                      )}
                    >
                      {pend == null ? "…" : pend}
                    </span>
                    <Check className={cn("h-3.5 w-3.5 shrink-0 text-accent-ink", !isActive && "invisible")} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </NavPopover>
      )}
    </div>
  );
}

/**
 * O COPILOTO, no centro da barra — e, desde que o mascote saiu do chat, a CASA dele: ele fica aqui com a
 * conversa aberta ou fechada, para o operador ter sempre um lugar onde olhar e ver como o Jido está.
 *
 * O gatilho não repete o número do Inbox (era o MESMO `collectBoardCockpitItems` — a barra mostrava a mesma
 * contagem duas vezes); ele mostra o que só o copiloto sabe: a conversa está viva? o autônomo decidiu alguma
 * coisa? E o que ele tem a dizer sai por um BALÃO DE FALA pendurado na cabeça — sozinho por alguns segundos
 * quando há fala nova, e no hover (aí com o recall das decisões anteriores e os números da sessão). O clique
 * leva à HOME, onde o chat dele mora (o rail já vem aberto).
 */
function CopilotChip({
  boardId,
  overview,
  needsYou,
}: {
  boardId: string;
  overview: CopilotOverview;
  /** quantos itens do Inbox esperam VOCÊ — vem do header (uma varredura só; ver useInboxSummary). */
  needsYou: number;
}) {
  const router = useRouter();
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();
  // Clicar no Jido leva à HOME, onde o chat dele já vem aberto (o rail). Ele deixou de abrir a gaveta:
  // a conversa tem UM lar (a home), e é para lá que o mascote aponta.
  const goHome = () => router.push(INICIO_ITEM.href(boardId));
  const [meter, setMeter] = useState<CopilotSessionMeter | null>(null);
  const [activity, setActivity] = useState<CopilotActivityEntry[]>([]);
  // O nível/modo/ciclo-em-voo vêm de CIMA (useCopilotOverview no header): um fetch só para os dois
  // consumidores da barra, sem duas cópias do mesmo estado que possam discordar por um poll inteiro.
  const { level, running, loaded: statusLoaded } = overview;
  // Os terminais que esperam o operador AGORA — chegam pelo SSE compartilhado (nenhum poll novo). É o que
  // permite ao Jido avisar "o terminal X travou esperando você" sem que ninguém abra /processes.
  const terminals = useTerminalAttention();
  // Os fetches do chip (medidor, overview, diário) já voltaram — com dado ou com erro? É o que autoriza o
  // balão a falar sozinho: antes disso o que ele "diz" ainda é o palpite do 1º paint, e cada resposta que chega
  // troca a fala sem que nada tenha acontecido no board. Faltar UM já bastava para o balão abrir a cada F5 (o
  // diário era o esquecido: ele muda a fala de `mood:*` para a última decisão). Ver useSpeechCue.
  const [meterLoaded, setMeterLoaded] = useState(false);
  const [activityLoaded, setActivityLoaded] = useState(false);
  // O que o TURNO sente, publicado pelo chat (face-bus). O chip enxerga sozinho só o REPOUSO; sem esta
  // assinatura o mascote — que agora é o único rosto do Jido — ficaria parado justamente enquanto ele
  // responde, roda uma tool ou engasga. Nasce do último valor conhecido para não haver um frame de repouso
  // ao trocar de rota com uma conversa em voo.
  const [chatFace, setChatFace] = useState<CopilotFaceState>(() => currentCopilotFace(boardId));
  useEffect(() => {
    setChatFace(currentCopilotFace(boardId));
    return onCopilotFace((b, s) => b === boardId && setChatFace(s));
  }, [boardId]);

  // O gatilho precisa do medidor SEMPRE (é o pontinho "conversa viva"); o diário só quando abre.
  useEffect(() => {
    let alive = true;
    const load = () =>
      copilotSessionMeterAction(boardId)
        .then((m) => alive && setMeter(m))
        .catch(() => {})
        .finally(() => alive && setMeterLoaded(true));
    load();
    const poll = setInterval(load, 60_000);
    // "Nova conversa"/"Compactar" mudam a sessão FORA do poll: sem esta assinatura o chip seguia pintando o
    // pontinho de "conversa viva" e a % de contexto de uma sessão já descartada por até 60s (ver meter-bus.ts).
    const off = onCopilotSessionChanged((b) => b === boardId && load());
    return () => {
      alive = false;
      clearInterval(poll);
      off();
    };
  }, [boardId]);

  // O DIÁRIO agora é lido SEMPRE (não só com o popover aberto): é dele que sai o que o Jido FALA no balão —
  // e uma fala que só existe depois de o operador passar o mouse não é uma fala, é um tooltip. Mesmo ritmo dos
  // outros polls (60s). O teto subiu de 4 para 12 porque a fala agora PULA os ciclos vazios para achar a
  // última ação real: com 4 entradas, um board que decidiu não agir 4 vezes seguidas não tinha o que contar.
  useEffect(() => {
    let alive = true;
    const load = () =>
      copilotActivityAction(boardId, ACTIVITY_WINDOW)
        .then((e) => alive && setActivity(e ?? []))
        .catch(() => {})
        .finally(() => alive && setActivityLoaded(true));
    load();
    const poll = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [boardId]);

  // "Viva" = houve turno nos últimos 30min. O copiloto não fica rodando de fundo — o que existe é a
  // conversa (com contexto acumulado) e o tick autônomo; os dois carimbam o medidor.
  const idleMs = meter ? Date.now() - new Date(meter.lastTurnAt).getTime() : Infinity;
  const live = idleMs < 30 * 60_000;
  const ctxPct = meter ? Math.round((meter.contextTokens / Math.max(1, meter.contextWindow)) * 100) : 0;
  const newestFirst = [...activity].reverse();

  // TODOS os sinais do Jido, montados UMA vez: o REPOUSO que o chip enxerga sozinho (nível do board,
  // conversa recente, tick rodando) mais o TURNO em andamento (streaming, tool, engasgo, aprovação
  // pendente), que só existe dentro do chat e chega pelo face-bus — o turno POR CIMA, porque quando
  // ele existe é o que importa. Um objeto só porque o rosto (`deriveMood`) e o estado de trabalho
  // (`isWorking`) precisam derivar do MESMO instante: dois conjuntos = duas verdades sobre o mascote.
  const signals: FaceSignals = {
    level,
    // `live` é CONVERSA RECENTE, não tick autônomo. Passá-lo como `autonomousRunning` fazia o
    // topnav anunciar "agindo sozinho" logo depois de o operador conversar — o Jido não estava
    // agindo sozinho, estava respondendo a ele. São sinais diferentes e vão em campos diferentes.
    recentTurn: live,
    autonomousRunning: running,
    contextTone: ctxPct >= 85 ? "danger" : undefined,
    ...chatFace.signals,
  };
  // O HUMOR vem do MESMO motor do chat (`deriveMood`) — não de uma segunda regra escrita aqui.
  const mood = deriveMood(signals);
  // "trabalhando AGORA" — turno em voo, tool rodando ou tick autônomo. Substituiu o `active`
  // (`live || running`), que dava por vivo qualquer conversa das últimas 30min: o mascote ficava
  // âmbar com selo verde meia hora depois de o operador falar com ele, sem nada acontecendo. Ver
  // `isWorking`. A recência sobrevive onde ela informa — no rodapé do balão, logo abaixo.
  const working = isWorking(signals);
  // O ponto no canto da cabeça: existe só quando o humor NÃO é repouso, e a cor é a do tom (verde
  // agindo · âmbar parado esperando você · rosa quebrou). Ver `moodDot`.
  const dot = moodDot(mood);
  // ELE SAIU DA BARRA E FOI ESCREVER. Com o mascote agora aparecendo no FIM do texto que ele está
  // escrevendo no chat, ele está literalmente em dois lugares — e um mascote duplicado é pior que um
  // ausente: as duas cópias reagem juntas e nenhuma das duas é "onde ele está". Enquanto o turno vive,
  // a barra pendura a plaquinha "volto logo" e o rosto fica lá embaixo, no texto.
  //
  // A régua é o TURNO (não "há um chat aberto"): `chatFace.open` diz que existe um painel montado neste
  // board, e `chat === "typing"` que existe um turno em voo nele. Um chat aberto e parado não tira o Jido
  // da barra — só o trabalho tira.
  const writing = chatFace.open && chatFace.signals.chat === "typing";
  // O texto vem do `short` CANÔNICO de EXPRESSIONS — o mesmo objeto que o chat consome. Antes eu
  // derivava tirando o prefixo do `label` ("Copiloto tranquilo" → "tranquilo"), o que era uma
  // SEGUNDA regra de texto por cima de um campo que já existia (e que, até aqui, não tinha nenhum
  // consumidor). Duas regras = dois textos possíveis para o mesmo estado.
  const status = EXPRESSIONS[mood].short;

  // O que ele DIZ — regra pura (copilot/speech.ts): o mesmo humor que desenha o rosto + o diário + os
  // TERMINAIS que esperam você + quantos itens o Inbox tem. O balão aparece sozinho na BORDA da fala
  // (`useSpeechCue`) e no hover.
  const speech = copilotSpeech({ mood, activity: newestFirst, terminals, needsYou });
  // O HISTÓRICO do hover EXCLUI a entrada que virou fala e COLAPSA repetições consecutivas idênticas —
  // as duas metades do "o balão não repete o histórico". Sem a segunda, um tick que decide não agir a cada
  // ciclo enchia a lista com a mesma frase 3×; sem a primeira, a fala aparecia de novo logo abaixo dela.
  const recall = groupActivity(newestFirst.filter((e) => e.id !== speech.sourceId)).slice(0, 3);
  // Com a conversa NA TELA o balão automático não fala: você está vendo a resposta chegar, um balão lá em
  // cima repetindo "estou te respondendo" é ruído. O hover continua valendo, e o ROSTO continua reagindo.
  const cued = useSpeechCue(
    speech.key,
    speech.urgent,
    meterLoaded && statusLoaded && activityLoaded && !chatFace.open,
  );

  // AS NOTÍCIAS. Tudo acima é ESTADO, lido por poll de 60s: como ele está, o que ele fez, quem espera
  // você. O que ACABOU de acontecer (um card que mudou de coluna, um terminal que travou num prompt)
  // chega na hora pelo SSE e, até aqui, ia SÓ para os canais do sistema operacional — quem não deu
  // permissão de notificação não via nada dentro do app, e quem deu levava um toast do SO por card
  // tocado. O balão é a superfície certa para isso: já está na tela, já tem uma cara para animar junto,
  // já é `aria-live` e já sabe sumir sozinho. Ver `copilot/announce.ts` (o que vira notícia e o que não).
  //
  // Fica mudo enquanto ele está ESCREVENDO — e só aí. É uma régua diferente da do `cued` logo acima (que
  // cala com o chat apenas MONTADO), e de propósito: o `cued` fala do próprio turno, então repetir "estou
  // te respondendo" ao lado da resposta chegando é ruído. Uma notícia não é sobre a conversa — um terminal
  // seu travado continua travado com o chat aberto, e a home (onde o rail do Jido vive montado o tempo
  // todo) é exatamente o lugar onde o operador está quando o board se mexe. Calar ali por causa do rail
  // deixaria o aviso sem superfície nenhuma. Enquanto o turno corre, porém, o rosto nem está na barra
  // (saiu para escrever no chat, ver `writing`) — um balão pendurado na plaquinha "volto logo" não tem
  // dono.
  //
  // `open` (o ponteiro está no balão) entra como HOLD: enquanto o operador está com o mouse ali — lendo,
  // ou indo clicar no link da notícia — ela não expira. Sem isso, o alvo evapora debaixo do cursor de
  // quem foi buscá-lo, que é a maneira mais irritante de perder um clique.
  const news = useCopilotAnnouncer(!writing, boardId, open);
  // A notícia TOMA o balão e a CARA enquanto dura — mas nunca cobre um humor que INTERROMPE (ele
  // quebrou, ou parou esperando você). Uma notícia é passageira; um bloqueio não, e trocar a cara de
  // "preciso de você" por "um card entrou em Revisar" esconderia justamente o que não pode ser perdido.
  const announcing = news !== null && !isUrgentMood(mood);
  const shownSpeech = announcing ? news.speech : speech;
  const shownMood = announcing ? news.mood : mood;

  return (
    // `flex` no wrapper (e não só `relative`): com um botão `inline-flex` dentro de um bloco, a
    // linha reserva espaço para o DESCENDER da fonte — o centro media 40px para um rosto de 30, e
    // esses 10px de nada empurravam a altura da barra inteira. Medido no board.
    <div ref={ref} className="relative flex items-center" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      {/* O Jido NÃO é um chip: ele é o agente, não um medidor. Sem pill e sem borda — só a cabeça
          e o que ele está fazendo agora. É a única coisa da barra que olha de volta. */}
      {/* SEM caixa: nem padding, nem fundo no hover. O padding vertical de um container aqui
          empurra a altura da barra INTEIRA — e o Jido não é um botão de barra, é o agente olhando
          de volta. O único feedback de hover é a cor do traço e do texto. */}
      <button
        type="button"
        onClick={goHome}
        title={writing ? "O Jido está escrevendo no chat — clique para ir até lá" : `Jido — ${status} · abrir o chat`}
        aria-label={writing ? "Jido — escrevendo no chat; ir para a conversa" : `Jido — ${status}; abrir o chat na home`}
        className="group relative inline-flex shrink-0 items-center text-left"
      >
        {writing ? (
          <CopilotAwaySign />
        ) : (
          <CopilotFace
            mood={shownMood}
            size="xs"
            // TINTA, nunca MATIZ. O rosto era pintado de `text-accent` (o âmbar) quando a régua
            // `active` dava vivo — e âmbar, no vocabulário desta barra, é uma COR DE ESTADO. Duas
            // coisas erradas de uma vez: o mascote é monocromático por desenho (quem carrega o
            // estado é o ponto, ver `ui.ts`), e o estado que ele estava anunciando nem era estado,
            // era recência. Quem está trabalhando ganha a tinta CHEIA; em repouso ele recua para
            // `fg-muted`. Peso, não cor — e o QUE ele está sentindo continua no desenho da cara.
            className={cn("shrink-0 transition-colors", working ? "text-fg" : "text-fg-muted group-hover:text-fg")}
            title=""
          />
        )}
        {/* No centro o Jido é só a cabeça — o rótulo de estado saiu (vai na fala do balão). O que sobra
            é um selo no canto: ele acende SÓ quando o humor pede o olho do operador (`moodDot`), e pulsa
            só quando há movimento de verdade (`working`) — um ponto de "ele parou e espera você" fica
            parado, que é exatamente o que está acontecendo. */}
        {dot && !writing && (
          <span className="absolute -right-0.5 -top-0.5">
            <NavDot tone={dot} pulse={working} />
          </span>
        )}
      </button>

      {/* O BALÃO: a fala sozinha quando ele acabou de dizer algo (`cued`, alguns segundos), e a fala + o
          recall quando o operador para o mouse em cima (`open`). Uma superfície só para as duas coisas —
          antes o hover abria um popover de medidor ("Copiloto · 3 turnos · ctx 12%"), que é painel de
          instrumento, não conversa. Os números não sumiram: viraram o rodapé do balão. */}
      <CopilotSpeechBubble
        speech={shownSpeech}
        open={open || cued || announcing}
        // Só a NOTÍCIA leva a algum lugar. A fala de estado ("Estou dormindo…") descreve o próprio
        // agente — o destino dela é o chat, que já é o clique da cabeça e o atalho do rodapé.
        href={announcing ? news.href : undefined}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
      >
        {open && (
          <div className="mt-2 space-y-1.5 border-t border-line-muted pt-2">
            {recall.length > 0 && (
              <ul className="flex flex-col gap-1">
                {recall.map((g) => (
                  <li key={g.key} className="flex items-start gap-1.5 text-[11px] leading-snug text-fg-subtle">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-line-emphasis" />
                    <span className="min-w-0 flex-1 truncate" title={g.entry.detail ?? g.entry.text}>
                      {g.entry.text}
                    </span>
                    {/* "×3 desde 14:02" no lugar de três linhas idênticas — o colapso é o que impede a
                        lista de virar o mesmo aviso repetido empurrando o que importa para baixo. */}
                    {g.count > 1 && (
                      <span className="shrink-0 tabular-nums text-fg-subtle/70">
                        ×{g.count} desde {new Date(g.sinceAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
              <span className="truncate">
                {meter
                  ? `${live ? "conversa viva" : `ociosa ${fmtElapsed(new Date(meter.lastTurnAt).getTime())}`} · ctx ${ctxPct}%`
                  : "nenhuma conversa ainda"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  goHome();
                }}
                className="shrink-0 font-medium text-accent-ink transition hover:underline"
              >
                conversar →
              </button>
            </div>
          </div>
        )}
      </CopilotSpeechBubble>
    </div>
  );
}

/**
 * A PLAQUINHA "volto logo" — o lugar do Jido na barra enquanto ele está escrevendo no chat.
 *
 * Ela já existiu e foi APOSENTADA, com razão, quando o mascote passou a morar fixo no topnav: uma placa
 * que anuncia uma mudança que não acontece é ruído. O que a traz de volta é a mudança acontecer de novo —
 * agora o mascote aparece no FIM do texto que está sendo escrito, dentro do chat. Nesse intervalo ele
 * está lá, não aqui; a placa é o que impede duas cópias do mesmo agente reagindo em duas telas.
 *
 * Diferença para a versão antiga: ela era um FLASH de 2,6s na borda de "o chat abriu". Esta é um NÍVEL —
 * fica exatamente enquanto o turno dura, e some quando ele termina. Sem timer, sem borda: o estado é a
 * verdade, e a verdade é o turno em voo.
 *
 * Placa na MESMA tinta do mascote (`bg-fg`), texto invertido (`text-surface`) — casa com os dois temas
 * sem uma segunda paleta. Ocupa a largura de uma cabeça (38px) para a barra não pular quando ele sai.
 */
function CopilotAwaySign() {
  return (
    <span className="flex h-[38px] w-[38px] shrink-0 flex-col items-center justify-center" aria-hidden>
      {/* os dois fios — o que faz a placa "pendurar". */}
      <span className="flex items-end gap-4 leading-none">
        <span className="h-1.5 w-px bg-line-emphasis" />
        <span className="h-1.5 w-px bg-line-emphasis" />
      </span>
      <span className="-mt-px -rotate-6 rounded-[5px] bg-fg px-1.5 py-0.5 text-center font-mono text-[8px] font-bold uppercase leading-[1.15] tracking-wide text-surface shadow-sm transition group-hover:-rotate-3">
        Volto
        <br />
        logo
      </span>
    </span>
  );
}

// O rótulo por kind vem de components/inicio/cockpit-labels — a MESMA fonte que o Inbox, a folha da
// home e a página do item usam. Esta barra mantinha uma tabela PRÓPRIA, com outras palavras para as
// mesmas coisas ("Aviso" × "Achado", "Fora do ar" × "Deploy falhou", "Copiloto pede" × "Aprovação do
// Jido"): o mesmo item mudava de nome conforme onde você olhava, que é a raiz da confusão de rótulos.
// Aqui fica o SUBSTANTIVO curto (o chip é estreito); onde há largura, as telas mostram o PEDIDO.

/**
 * O chip do Inbox na barra — o número conta o que o Inbox conta (a mesma leitura: getInboxSummaryAction →
 * collectInbox, todos os boards, só Decidir), e o popover mostra as primeiras decisões com o CARTÃO ÚNICO do Inbox
 * (densidade `popover`, com o selo do board): a mesma frase da lista e da folha, levando à página do item.
 */
function ActionsChip({ boardId, total, acompanhar, entries }: { boardId: string; total: number | null; acompanhar: number; entries: InboxEntry[] }) {
  const { open, setOpen, openNow, closeSoon, ref } = useHoverPopover();
  const top = entries.slice(0, POPOVER_TOP);
  // O relógio é lido UMA vez por render: as linhas mostram idades que batem entre si.
  const now = Date.now();

  return (
    <div ref={ref} className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      {/* O ÍCONE CONTA: o inbox era mudo — dava para ter 7 pendências e a barra não dizer nada. */}
      <NavChip
        href={inboxHref(boardId)}
        onTouchOpen={() => setOpen((o) => !o)}
        leading={<Inbox className="h-4 w-4" />}
        // Antes da 1ª resposta não há número: «0» afirmaria «nada para decidir» sem ter medido. Com decisão, o
        // chip é o âmbar PREENCHIDO do dono — o mesmo da pílula do card.
        value={total == null ? "" : total}
        tone={total != null && total > 0 ? "owner" : "idle"}
        open={open}
        title={total == null ? "Inbox — lendo…" : total > 0 ? `${total} para decidir no Inbox` : "Inbox — nada para você decidir agora"}
        ariaLabel={total == null ? "Inbox — lendo" : `Inbox — ${total} para decidir`}
      />
      {open && (
        <NavPopover label="Inbox">
          <NavPopoverTitle meta={total == null ? "lendo…" : `${total} para decidir · ${acompanhar} acompanhando`}>Inbox</NavPopoverTitle>
          {top.length === 0 ? (
            <NavPopoverEmpty>Nada para você decidir agora.</NavPopoverEmpty>
          ) : (
            <ul className="flex flex-col" onClick={() => setOpen(false)}>
              {top.map((e) => (
                <li key={e.key}>
                  <InboxItemCard entry={e} density="popover" now={now} showBoard />
                </li>
              ))}
            </ul>
          )}
          <NavPopoverFooter href={inboxHref(boardId)} onClick={() => setOpen(false)}>
            {entries.length > top.length ? `Ver as ${entries.length} decisões →` : "Abrir o Inbox →"}
          </NavPopoverFooter>
        </NavPopover>
      )}
    </div>
  );
}

/**
 * Quantas entradas do diário o balão carrega. Ele PULA os ciclos vazios (o tick olhando o board e
 * decidindo não agir) para achar a última ação real — então a janela precisa caber uma sequência
 * plausível de ciclos vazios. Com as 4 antigas, um board disciplinado por 4 ciclos não tinha o que contar.
 */
const ACTIVITY_WINDOW = 12;

/**
 * Quantos itens cada painel da barra lista antes de mandar para a página inteira. UM número para os
 * três (o Inbox parava em 5, terminais e runs em 6): profundidades diferentes fazem o operador achar
 * que um painel escondeu mais que o outro. O que passar do teto é ANUNCIADO no rodapé — corte em
 * silêncio se lê como "acabou".
 */
const POPOVER_TOP = 5;

/** "12s" / "4m" / "1h03" / "3d" — uma duração em ms, para quem já tem o delta em mãos. */
function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  // Pendência parada há dias existe (um `since` de card é data, não hora) — sem este degrau ela lia
  // "73h12", que é um número que ninguém converte de cabeça.
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d`;
}

/** "12s" / "4m" / "1h03" elapsed since a run's startedAt — best-effort (recomputed on re-render). */
function fmtElapsed(startedAt: number): string {
  return fmtDuration(Date.now() - startedAt);
}

/**
 * A RAM na barra — SÓ quando freia (≥ {@link RAM_ALERT_PCT}%), e com o rótulo escrito. Ela morava no número do chip de
 * Processos o tempo todo, com o ícone de CPU: «62%» ocupava o lugar onde o dono procurava quantos agentes rodam, e
 * lia como carga de CPU. Abaixo do limiar ela não informa decisão nenhuma (o scheduler admite sozinho); acima dele é o
 * que explica por que a vaga extra não abre.
 */
function RamAlertChip() {
  const metrics = useVpsMetrics();
  const pct = metrics?.ram?.usedPct ?? null;
  if (pct == null || pct < RAM_ALERT_PCT) return null;
  return (
    <NavChip
      href="/processes"
      leading={<MemoryStick className="h-4 w-4" />}
      value={`RAM ${Math.round(pct)}%`}
      tone="danger"
      title={`RAM em ${Math.round(pct)}% — acima de ${RAM_ALERT_PCT}% o sistema não abre vaga extra para agentes`}
      ariaLabel={`Memória RAM em ${Math.round(pct)}%`}
    />
  );
}

/**
 * Criar ▾ — a bifurcação Tarefa × Ideia, posta na superfície onde a dúvida acontece.
 *
 * O botão existia como "Criar tarefa" e abria a captura direto. Só que nem tudo que passa pela
 * cabeça do operador É uma tarefa: quando ainda não se sabe o que fazer, forçar um card empurra
 * exploração para dentro do pipeline (com gates, autorun e cascata) — foi assim que ideia técnica
 * virava card prematuro. A régua vira uma pergunta, e ela é feita AQUI:
 *
 *   sei o que precisa ser feito?  →  TAREFA (captura inteligente → Triagem → pipeline)
 *   preciso investigar antes?     →  IDEIA  (documento em /ideias, fora do pipeline)
 *
 * CLIQUE, não hover: o crumb do board abre no hover porque navegar é barato e reversível; um menu
 * de CRIAÇÃO que se abre de raspão enquanto o mouse atravessa a barra é ruído. O `useHoverPopover`
 * entra só pelo que ele arbitra de graça (Escape, clique fora, um popover aberto por vez) — as
 * mãos de mouse ficam desligadas de propósito.
 */
function CaptureMenu({ boardId, onSmartCapture }: { boardId: string; onSmartCapture: () => void }) {
  const { open, setOpen, ref } = useHoverPopover();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Criar uma tarefa ou anotar uma ideia"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-fg px-3 text-sm font-medium text-surface transition hover:bg-fg/85"
      >
        <Plus className="h-4 w-4" />
        <span className="hidden md:inline">Criar</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <NavPopover align="right" label="Criar" className="w-72">
          <ul className="flex flex-col">
            <li>
              <NavPopoverRow
                leading={<ListChecks className="h-4 w-4 text-fg-muted" />}
                label="Tarefa"
                sub="Já sei o que precisa ser feito — entra na Triagem e segue o pipeline."
                onClick={() => {
                  setOpen(false);
                  onSmartCapture();
                }}
              />
            </li>
            <li>
              <NavPopoverRow
                leading={<Lightbulb className="h-4 w-4 text-fg-muted" />}
                label="Ideia"
                sub="Ainda não sei — vira um documento para explorar antes de decidir."
                href={`/board/${boardId}/ideias?nova=1`}
                onClick={() => setOpen(false)}
              />
            </li>
          </ul>
        </NavPopover>
      )}
    </div>
  );
}

/**
 * O ⚙ — o SISTEMA deste board. Fica encostado no último degrau da árvore, não na direita: tudo o que
 * ele guarda é sobre o board que está à esquerda dele — a direita é dos medidores.
 *
 * Era um ⋯, e o ícone estava mentindo: "overflow" é o que sobra, e o que mora aqui é uma seção de
 * verdade — Configurações, Orquestração, Métricas, Lixeira, avisos, tema. Enquanto três dessas telas
 * também apareciam no popover do bloco Software, o ⋯ podia passar por sobra; agora que ele é a ÚNICA
 * porta da máquina, o gatilho precisa dizer isso à primeira vista. Uma engrenagem diz.
 *
 * Ele é só o INVÓLUCRO: a lista mora em `nav/BoardMenu` (a mesma que o sheet do celular abre). O que
 * o gatilho ainda carrega é UM sinal — o ponto âmbar do modo econômico —, porque é o único estado
 * daqui que muda o comportamento do pipeline inteiro em silêncio; os filtros, que antes justificavam
 * um badge de contagem, deixaram de morar atrás de um ícone (foram para a barra da view).
 */
function SistemaMenu({
  config,
  onRefresh,
  notifications,
}: {
  config: BoardConfig;
  onRefresh: () => void;
  notifications: BoardNotifications;
}) {
  const [open, setOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // A varredura do arquivo só roda quando alguém pode vê-la (menu ou gaveta abertos) — ver useBoardTrash.
  const trash = useBoardTrash(config.id, open || trashOpen);
  const economy = useEconomyMode();
  const close = useCallback(() => setOpen(false), []);
  useEscape(open, () => {
    close();
    triggerRef.current?.focus(); // teclado: o foco volta para o gatilho, não para o corpo da página
  });
  const menuRef = useMenuKeyboard(open);
  const economyOn = economy.enabled === true;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          economyOn
            ? "Sistema do board — modo econômico ATIVO (todo o pipeline em sonnet)"
            : "Sistema do board — configurações, orquestração, métricas, lixeira, avisos, tema"
        }
        className={cn(
          "relative inline-flex h-8 items-center rounded-md px-2 transition",
          open ? "bg-surface-hover text-fg" : "text-fg-muted hover:text-fg",
        )}
      >
        <Settings2 className="h-4 w-4" />
        {economyOn && (
          <span aria-hidden className="absolute right-0.5 top-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[65]" onClick={close} />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Sistema do board"
            className="absolute left-0 top-full z-[70] mt-2 w-[19rem] rounded-xl border border-line bg-surface p-2 shadow-lg"
          >
            <BoardMenu
              boardId={config.id}
              notifications={notifications}
              economy={economy}
              trashCount={trash.count}
              onOpenTrash={() => {
                trash.load();
                close();
                setTrashOpen(true);
              }}
              onRefresh={() => {
                onRefresh();
                close();
              }}
              onNavigate={close}
            />
          </div>
        </>
      )}
      <TrashDrawer open={trashOpen} onClose={() => setTrashOpen(false)} trash={trash} />
    </div>
  );
}

// ===========================================================================
// Mobile bottom navigation — a nav primária phone-first, reorganizada por SEÇÃO (não mais por view
// solta). Cinco slots: Início · Inbox (com contador) · Capturar (FAB) · Produto ▾ (a seção, que
// abre um sheet) · Mais (o sheet HIERÁRQUICO com todas as seções + app + exibição + utilitários).
// Isso promove o Inbox (o trabalho nº1 no celular, antes um chip de 32px) e torna TODA view
// alcançável no telefone (antes 4 seções sumiam). Escondida de `md` up, onde os crumbs de grupo e a
// barra completa assumem.
// ===========================================================================

const SHEET_ROW =
  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-fg-muted transition hover:bg-surface-hover active:bg-surface-hover";
const BOTTOM_TAB = "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition";

function MobileBottomNav({
  view,
  config,
  onSmartCapture,
  notifications,
  inboxCount,
}: {
  view: BoardView;
  config: BoardConfig;
  onSmartCapture: () => void;
  notifications: BoardNotifications;
  /** o número do Inbox — o MESMO do chip e da fala do Jido (uma leitura só); null antes da 1ª resposta. */
  inboxCount: number | null;
}) {
  const boardId = config.id;
  const activeGroup = groupForView(view);
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex h-14 max-w-xl items-stretch justify-around">
        <BottomTab href={INICIO_ITEM.href(boardId)} icon={Home} label="Início" active={view === "inicio"} />
        <MobileInboxTab boardId={boardId} active={view === "inbox"} count={inboxCount} />
        <CaptureFab boardId={boardId} onSmartCapture={onSmartCapture} />
        {/* O KANBAN a UM toque (era a aba «Produto», que abria um sheet e cobrava um segundo toque para chegar à tela
            que o dono mais abre). As outras ferramentas do Produto seguem no «Mais». */}
        <BottomTab href={viewHref("kanban", boardId)} icon={KanbanSquare} label="Kanban" active={view === "kanban"} />
        <MoreTab view={view} config={config} notifications={notifications} />
      </div>
    </nav>
  );
}

/** Inbox promovida a aba de 1ª classe — com o CONTADOR vivo (o mesmo número do chip: uma leitura só, no cabeçalho). */
function MobileInboxTab({ boardId, active, count }: { boardId: string; active: boolean; count: number | null }) {
  return (
    <Link href={inboxHref(boardId)} prefetch={false} className={cn(BOTTOM_TAB, active ? "text-accent-ink" : "text-fg-subtle")}>
      <span className="relative inline-flex">
        <Inbox className={cn("h-5 w-5", active ? "text-accent-ink" : "text-fg-muted")} />
        {count != null && count > 0 && (
          // o número da aba: o âmbar PREENCHIDO do dono com a tinta escura dele (5,8:1 claro · 8,9:1 escuro — medido em
          // presence-tone.test.ts) — o mesmo do chip do desktop e da pílula do card
          <span className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-state-owner px-1 text-[9px] font-bold tabular-nums text-state-owner-fg">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </span>
      Inbox
    </Link>
  );
}

/** As linhas de um grupo dentro de um bottom-sheet (Página inicial + ferramentas), estilo SHEET_ROW. */
function SheetGroupRows({
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
  const rows = group.items;
  return (
    <>
      {rows.map((it) => {
        const Icon = it.icon;
        const isActive = it.id === view;
        return (
          <Link
            key={it.id}
            href={it.href(boardId)}
            prefetch={false}
            onClick={onNavigate}
            className={cn(SHEET_ROW, isActive && "text-fg")}
          >
            <Icon className={cn("h-5 w-5 shrink-0", isActive ? "text-accent-ink" : "text-fg-subtle")} />
            {it.label}
          </Link>
        );
      })}
    </>
  );
}

function BottomTab({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string;
  icon: typeof Map;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition",
        active ? "text-accent-ink" : "text-fg-subtle",
      )}
    >
      <Icon className={cn("h-5 w-5", active ? "text-accent-ink" : "text-fg-muted")} />
      {label}
    </Link>
  );
}

/**
 * O FAB central — o espelho mobile do `Criar ▾`. Mesma bifurcação (Tarefa × Ideia), em
 * folha ancorada ACIMA do botão: no celular o popover não cabe para baixo (o FAB já mora na borda
 * inferior, sob a safe-area). O rótulo perdeu o "tarefa" porque o botão deixou de ser sobre um
 * artefato só — decidir qual é justamente o que ele pergunta.
 */
function CaptureFab({ boardId, onSmartCapture }: { boardId: string; onSmartCapture: () => void }) {
  const { open, setOpen, ref } = useHoverPopover();
  const ringCls =
    "-mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-fg shadow-lg ring-4 ring-surface transition hover:bg-primary-hover";

  return (
    <div ref={ref} className="relative flex flex-1 flex-col items-center justify-end pb-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Criar uma tarefa ou anotar uma ideia"
        className={ringCls}
      >
        <Plus className={cn("h-5 w-5 transition-transform", open && "rotate-45")} />
      </button>
      <span className="text-[10px] font-medium text-fg-subtle">Criar</span>
      {open && (
        <div className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-2xl border border-line bg-surface p-1 shadow-2xl">
          <ul className="flex flex-col">
            <li>
              <NavPopoverRow
                leading={<ListChecks className="h-4 w-4 text-fg-muted" />}
                label="Tarefa"
                sub="Já sei o que fazer — vai para a Triagem."
                onClick={() => {
                  setOpen(false);
                  onSmartCapture();
                }}
              />
            </li>
            <li>
              <NavPopoverRow
                leading={<Lightbulb className="h-4 w-4 text-fg-muted" />}
                label="Ideia"
                sub="Ainda não sei — explorar antes de decidir."
                href={`/board/${boardId}/ideias?nova=1`}
                onClick={() => setOpen(false)}
              />
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A aba "Mais" — o sheet HIERÁRQUICO do board no celular: uma faixa de MEDIDORES (runs · RAM · cota
 * Claude — pelo menos um sinal de máquina sobrevive no mobile), TODAS as seções por grupo (fecha o
 * buraco das views inacessíveis), a seção App (Perguntas · Processos · Terminal) e, no fim, o MESMO
 * menu do board que o ⋯ do desktop abre (`nav/BoardMenu`) — antes era uma segunda lista escrita à
 * mão, que já divergia (a Lixeira nunca chegou ao celular). Ativa só quando a view atual NÃO é
 * coberta pelas outras 4 abas.
 */
function MoreTab({
  view,
  config,
  notifications,
}: {
  view: BoardView;
  config: BoardConfig;
  notifications: BoardNotifications;
}) {
  const boardId = config.id;
  const [open, setOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const router = useRouter();
  const { failures } = useRunnerSnapshot();
  const metrics = useVpsMetrics();
  // «Agentes N» também no celular (o chip do desktop não monta aqui): a MESMA régua de presença, nunca as execuções
  // headless sozinhas (0 com dois condutores trabalhando).
  const agents = agentPulse(useAgentPresence().presence).working;
  const trash = useBoardTrash(boardId, open || trashOpen);
  // O sheet fica montado no desktop (escondido por `md:hidden`) — só lê o modo econômico quando abre.
  const economy = useEconomyMode(open);
  // Ativa quando a view NÃO é uma das cobertas pelas outras 4 abas (Início · Inbox · Kanban).
  const active = view !== "inicio" && view !== "inbox" && view !== "kanban";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="menu"
        title={
          agents > 0
            ? `${agents} agente${agents === 1 ? "" : "s"} trabalhando agora`
            : failures.length > 0
              ? `${failures.length} run(s) com falha recente`
              : undefined
        }
        className={cn(BOTTOM_TAB, "relative", active ? "text-accent-ink" : "text-fg-subtle")}
      >
        <span className="relative inline-flex">
          <MoreHorizontal className={cn("h-5 w-5", active ? "text-accent-ink" : "text-fg-muted")} />
          {agents > 0 ? (
            <span className="absolute -right-1.5 -top-1">
              <NavDot pulse />
            </span>
          ) : failures.length > 0 ? (
            <span className="absolute -right-1.5 -top-1">
              <NavDot tone="danger" />
            </span>
          ) : null}
        </span>
        Mais
      </button>

      {open && (
        <BottomSheet title="Tudo do board" onClose={() => setOpen(false)}>
          {/* Medidores — o único sinal de máquina que sobra no celular (o resto era hidden md:). */}
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-inset/60 px-3 py-2 text-[11px] text-fg-muted">
            <span className="inline-flex items-center gap-1">
              <Bot className={cn("h-3.5 w-3.5", agents > 0 ? "text-state-working" : "text-fg-subtle")} />
              Agentes {agents}
            </span>
            <span className="inline-flex items-center gap-1">
              <MemoryStick className="h-3.5 w-3.5 text-fg-subtle" /> {metrics?.ram ? Math.round(metrics.ram.usedPct) : "—"}%
            </span>
            <HealthPill />
          </div>

          {/* O RITMO do board — o mesmo painel do chip do desktop (pausar · devagar · normal). */}
          <BoardPaceSheetSection boardId={boardId} active={open} />

          {/* Seções — TODA view alcançável no celular (fecha o buraco das 4 seções que sumiam). */}
          <Link
            href={INICIO_ITEM.href(boardId)}
            prefetch={false}
            onClick={() => setOpen(false)}
            className={cn(SHEET_ROW, view === "inicio" && "text-fg")}
          >
            <Home className="h-5 w-5 shrink-0 text-fg-subtle" />
            Início
          </Link>
          {NAV_GROUPS.map((g) => (
            <div key={g.id} className="mt-1">
              <p className={cn("flex items-center gap-1.5 px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide", g.tone)}>
                <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-[2px]", g.dot)} />
                {g.label}
              </p>
              <SheetGroupRows group={g} boardId={boardId} view={view} onNavigate={() => setOpen(false)} />
            </div>
          ))}

          <div className="my-1.5 h-px bg-line-muted" />
          {/* Processos SAIU daqui: virou linha do `nav/BoardMenu` (a seção "Máquina"), que este sheet
              já renderiza logo abaixo — duas portas para a mesma página, uma delas invisível ao
              desktop, era a divergência que trouxe a lista para `BoardMenu` em primeiro lugar. */}
          <p className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">App</p>
          <Link href="/inbox" onClick={() => setOpen(false)} className={SHEET_ROW}>
            <MessageCircleQuestion className="h-5 w-5 shrink-0 text-fg-subtle" />
            Inbox de todos os boards
          </Link>
          {/* /terminal é documento estático (fora do App Router) → <a> (hard nav), não <Link>. */}
          <a href="/terminal?b=shell" className={SHEET_ROW}>
            <SquareTerminal className="h-5 w-5 shrink-0 text-fg-subtle" />
            Terminal (shell)
          </a>

          {/* O MESMO menu do ⋯ do desktop — uma fonte só, então o celular deixa de ficar para trás. */}
          <div className="mt-1.5 border-t border-line-muted pt-1.5">
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
                router.refresh();
                setOpen(false);
              }}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </BottomSheet>
      )}
      <TrashDrawer open={trashOpen} onClose={() => setTrashOpen(false)} trash={trash} />
    </>
  );
}

/** A bottom sheet (mobile): dimmed backdrop + a panel that rises from the bottom edge. */
function BottomSheet({
  title,
  onClose,
  children,
}: {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEscape(true, onClose);
  return (
    <div className="fixed inset-0 z-[60] md:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line bg-surface p-2 shadow-2xl"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
        {title && (
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{title}</p>
        )}
        {children}
      </div>
    </div>
  );
}
