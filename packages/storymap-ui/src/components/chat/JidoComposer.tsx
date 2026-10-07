"use client";

// 💬 O COMPOSITOR DO JIDO — a caixa fixa no rodapé de toda tela de board, que abre a conversa POR CIMA da tela
// quando a pessoa a TOCA (clique/toque no campo) ou começa a escrever.
//
// Não abre só por receber o foco (o desenho abria): ele vem ANTES do quadro na ordem do Tab, e abrir no foco fazia
// quem navega por teclado cair na conversa a cada Tab/Shift+Tab rumo aos cards. Aberto, ele é um diálogo modal de
// verdade: o resto da página fica `inert` (nem Tab nem leitor de tela chegam lá) e, ao fechar, o foco volta a quem
// abriu (o chevron do card, a caixinha do fluxo).
//
// Ele é a ÚNICA caixa de texto da conversa. Fechado, é uma faixa no rodapé com um degradê do fundo para cima; com o
// foco, um véu cobre a tela e a conversa aparece numa coluna central, acima dele (ChatOverlay). Quem conversa de
// verdade é o motor de sempre — CopilotChatPanel → ChatPanel: sessão com lease, rota de turno, sementes de
// escalação, aprovações e perguntas inline, histórico, nova conversa, o medidor. Este componente só entrega a mão
// que digita, pela ponte `ChatComposerApi` (ver ChatPanel): o envio passa pelo MESMO caminho do painel (o host
// intercepta primeiro, depois o modelo), e o compositor de dentro do painel some.
//
// Numa PÁGINA DE DOCUMENTO (Negócio, Produto, Design) a conversa é a DO DOCUMENTO: a tela entrega `surface` (a raia
// da superfície em copilot/chat-surfaces + o contexto do documento, relido a cada turno) e a conversa aberta é o
// assistente dela (o Redator do PRD, o Estrategista do canvas…), não o Jido do board. A escalação `?copilot=` segue
// sendo do Jido do board: com uma semente, a conversa aberta é a dele.
//
// Entradas de FORA (chat/jido-bus): `openJidoChat({ cardId, cardTitle, draft })` abre com o chip "Sobre <card>" e o
// pedido escrito (nunca enviado); `openJidoChat({ feature, draft })`, com o chip da FUNCIONALIDADE do PRD (a página da
// funcionalidade); e `seedJidoChat(seed)` — o `?copilot=` — abre semeado pela escalação.
//
// Os COMANDOS (botão `/` ou digitar `/`): ver jido-commands.ts. `/criar` abre a captura, `/bug` o relato de bug (ou a
// captura "Algo quebrado" sem card em mão), `/pausar`/`/retomar` mudam o ritmo pela MESMA action do botão de ritmo
// (com a confirmação escrita na conversa), as perguntas viram um pedido ao Jido, e os da conversa (`/clear`…) o
// painel roda.
//
// ⚠️ Um compositor por rota, e nunca junto de um chat em trilho lateral (o host não o monta com `dockedChat`): cada
// conversa aberta instancia o poll da sessão compartilhada do board e pega lease por turno.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { COMPACT_COMPOSER_QUERY } from "@/lib/viewport";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ArrowUp, ImagePlus, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { BoardView } from "@/components/nav/nav-groups";
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import type { ChatComposerApi } from "@/components/chat/ChatPanel";
import { onOpenJidoChat } from "@/components/chat/jido-bus";
import { JidoMark } from "@/components/chat/JidoMark";
import { JidoCommandMenu } from "@/components/chat/JidoCommandMenu";
import {
  allJidoCommands,
  bugCaptureText,
  composerTextFor,
  isCoreCommand,
  jidoMenuFor,
  jidoPromptFor,
  parseJidoCommand,
  type JidoCommand,
} from "@/components/chat/jido-commands";
import { cardChipLabel, escalationRefLabel, featureChipContext, withCardContext, type JidoCardContext } from "@/components/chat/jido-context";
import { useAgentPresence } from "@/components/RunnerStatusProvider";
import { agentPulse } from "@/lib/storymap/agent-presence";
import { getBoardPaceAction, setBoardPaceAction } from "@/app/board-pace-actions";
import { PACE_ARM_CONFIRM } from "@/lib/storymap/board-pace-words";
import type { BoardPaceView } from "@/lib/storymap/runner/board-pace";
import { cardHref } from "@/lib/storymap/deep-links";
import { notifyBoardPaceChanged, onBoardPaceChanged } from "@/components/board-pace-bus";
import { currentCopilotFace, onCopilotFace } from "@/components/copilot/face-bus";
import type { FaceSignals } from "@/lib/storymap/copilot/face";

// O chunk da conversa (streaming, HITL, medidor) e os dois modais só baixam quando abrem de fato.
const ChatOverlay = dynamic(() => import("@/components/chat/ChatOverlay").then((m) => m.ChatOverlay), { ssr: false });
const SmartCaptureModal = dynamic(() => import("@/components/SmartCaptureModal").then((m) => m.SmartCaptureModal), {
  ssr: false,
});
const BugModal = dynamic(() => import("@/components/BugModal").then((m) => m.BugModal), { ssr: false });

/** A conversa de um DOCUMENTO no compositor: a raia da superfície e o contexto fresco do documento. */
export interface JidoDocSurface {
  /** o id da superfície em copilot/chat-surfaces (a raia da conversa). */
  view: string;
  /** o nome da conversa ("Redator do PRD") — vai no chip do compositor e no nome do diálogo. */
  label: string;
  /** o documento como contexto, relido a cada turno (o que acabou de ser salvo entra na próxima resposta). */
  getContext: () => Promise<string | undefined>;
  /** o documento ainda está vazio — a conversa oferece as ações rápidas de COMEÇAR (`emptyQuickActions`). */
  empty?: boolean;
}

export interface JidoComposerProps {
  boardId: string;
  config: BoardConfig;
  view: BoardView;
  /** Presente ⇒ a conversa desta tela é a do documento (ver o cabeçalho). */
  surface?: JidoDocSurface;
  /**
   * A tela abre a captura ELA MESMA (o Kanban, o Mapa): o modal dela recebe os cards do board como contexto da
   * proposta, que o compositor não tem. Ausente ⇒ o compositor abre a sua (sem esse contexto).
   */
  onCapture?: (initialText?: string) => void;
}

/** O placeholder do desenho. Mudá-lo é mudar o convite do produto — está fixado no teste de contrato. */
export const JIDO_PLACEHOLDER = "Pergunte ao Jido ou digite / para comandos";
/** O mesmo convite no celular, numa linha só (o botão `/` está ao lado do campo e diz o resto). */
export const JIDO_PLACEHOLDER_SHORT = "Pergunte ao Jido…";

/**
 * COMPACTO (uma linha, tudo na mesma fileira) no celular E no computador BAIXO (< 800px de altura — lib/viewport.ts):
 * num notebook de ~600px úteis o desenho de duas linhas com 56px de degradê tapava quase metade das raias. O desenho
 * inteiro mora na variante `tall:` (computador alto); as classes sem prefixo são as do compacto.
 *
 * Lido por `matchMedia` (e não só por CSS) porque três coisas do compositor não são estilo: o número de linhas do
 * campo, o teto do crescimento e o placeholder. Nasce `false` (o servidor não sabe o tamanho) e acerta no 1º efeito.
 */
const COMPACT_QUERY = COMPACT_COMPOSER_QUERY;

/** O degradê do compositor FECHADO: o fundo da página subindo. Uma tela com fundo próprio define `--jido-fade`. */
const CLOSED_FADE =
  "linear-gradient(180deg, rgb(var(--jido-fade, var(--canvas)) / 0) 0%, rgb(var(--jido-fade, var(--canvas)) / 0.94) 42%, rgb(var(--jido-fade, var(--canvas))) 100%)";

/** O ritmo do board — só o que o mascote e os comandos precisam (pausado? desligado?). Lido ao montar, a cada minuto e ao abrir. */
function useJidoPace(boardId: string, open: boolean) {
  const [view, setView] = useState<BoardPaceView | null>(null);
  const load = useCallback(async () => {
    const r = await getBoardPaceAction(boardId).catch(() => null);
    if (r?.ok) setView(r.data);
  }, [boardId]);
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 60_000);
    return () => clearInterval(poll);
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  // a mudança feita em outro ponto da tela (a pílula do Kanban, o popover da caixinha) chega aqui na hora
  useEffect(
    () =>
      onBoardPaceChanged((c) => {
        if (c.boardId !== boardId) return;
        if (c.view) setView(c.view);
        else void load();
      }),
    [boardId, load],
  );
  return { view, setView };
}

/**
 * Deixa TUDO fora de `keep` `inert` (nem foco nem leitor de tela) — o modal de verdade. Sobe de `keep` até o <body>
 * marcando os irmãos de cada ancestral; devolve a função que desfaz (só o que ESTE chamado marcou).
 */
function inertOutside(keep: HTMLElement): () => void {
  const marked: HTMLElement[] = [];
  for (let el: HTMLElement | null = keep; el && el !== document.body; el = el.parentElement) {
    const parent: HTMLElement | null = el.parentElement;
    if (!parent) break;
    for (const sib of Array.from(parent.children)) {
      if (sib === el || !(sib instanceof HTMLElement) || sib.inert || sib.tagName === "SCRIPT") continue;
      sib.inert = true;
      marked.push(sib);
    }
  }
  return () => {
    for (const m of marked) m.inert = false;
  };
}

export function JidoComposer({ boardId, config, onCapture, surface }: JidoComposerProps) {
  const router = useRouter();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Para onde o foco volta ao fechar (quem abriu a conversa).
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  // O que a conversa tem em contexto: um CARD (aberto do Kanban) ou uma ESCALAÇÃO (`?copilot=`) — nunca os dois.
  const [card, setCard] = useState<(JidoCardContext & { card?: Card }) | null>(null);
  const [seed, setSeed] = useState<CopilotSeed | null>(null);
  // A ponte com o painel (null enquanto a conversa abre — o painel lê o board antes de montar o thread).
  const [api, setApi] = useState<ChatComposerApi | null>(null);
  const apiRef = useRef<ChatComposerApi | null>(null);
  apiRef.current = api;
  // A lista de comandos: aberta pelo botão `/` (sem tocar no texto) ou por digitar `/`.
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  // Os fluxos que os comandos abrem.
  const [capture, setCapture] = useState<{ initialText?: string } | null>(null);
  const [bugCard, setBugCard] = useState<Card | null>(null);
  // Imagens coladas/anexadas, já no servidor (os paths que o turno lê).
  const [attachments, setAttachments] = useState<{ path: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);

  const pace = useJidoPace(boardId, open);
  const compact = useMediaQuery(COMPACT_QUERY);
  // O que o TURNO sente (o chat publica no face-bus: escrevendo, rodando uma ferramenta, engasgou) — o mascote daqui
  // é a cara do Jido agora, e reage à conversa como reagia o do topnav.
  const [turn, setTurn] = useState<FaceSignals>({});
  useEffect(() => {
    setTurn(currentCopilotFace(boardId).signals);
    return onCopilotFace((b, s) => {
      if (b === boardId) setTurn(s.signals);
    });
  }, [boardId]);
  const paused = pace.view?.level === "paused";
  const { presence } = useAgentPresence();
  const agentsWorking = agentPulse(presence, boardId).working > 0;
  const busy = Boolean(api?.busy);

  // ── abrir / fechar ─────────────────────────────────────────────────────────────────────────────────────
  /** Foco no campo com o cursor no FIM (o pedido escrito por quem abriu fica pronto para continuar). */
  const focusEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, []);

  // O que um comando pede ao painel ANTES de ele estar pronto (a conversa ainda lendo o board) espera aqui.
  const pendingRef = useRef<((a: ChatComposerApi) => void)[]>([]);
  const withApi = useCallback((fn: (a: ChatComposerApi) => void) => {
    setOpen(true);
    if (apiRef.current) fn(apiRef.current);
    else pendingRef.current.push(fn);
  }, []);
  useEffect(() => {
    if (!api) return;
    const queued = pendingRef.current.splice(0);
    for (const fn of queued) fn(api);
  }, [api]);

  const closeChat = useCallback(() => {
    setOpen(false);
    setCmdOpen(false);
    // A escalação vale para a conversa em que chegou: fechar a solta (reabrir é a conversa normal do board).
    setSeed(null);
    pendingRef.current = [];
    // O foco volta a quem abriu (o chevron do card, a caixinha) — senão sai do campo e cai no <body>. Depois do
    // render: enquanto a conversa está aberta o resto da página está `inert` e não aceita foco.
    const back = returnFocusRef.current;
    returnFocusRef.current = null;
    inputRef.current?.blur();
    if (back) requestAnimationFrame(() => back.isConnected && back.focus());
  }, []);

  // MODAL de verdade enquanto aberta: o resto da página fica `inert` (o Tab não sai da conversa, o leitor de tela não
  // lê o quadro por baixo do véu).
  useEffect(() => {
    if (!open || !rootRef.current) return;
    return inertOutside(rootRef.current);
  }, [open]);

  /** Abre pela mão da pessoa (toque no campo, digitar, o botão `/`). Guarda quem tinha o foco, se for de fora. */
  const openByHand = useCallback(() => {
    if (open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !rootRef.current?.contains(active) && active !== document.body) returnFocusRef.current = active;
    setOpen(true);
  }, [open]);

  // A porta de fora (jido-bus): o card do Kanban, a escalação do `?copilot=`.
  useEffect(
    () =>
      onOpenJidoChat((input) => {
        const active = document.activeElement;
        returnFocusRef.current =
          input.returnFocus ?? (active instanceof HTMLElement && active !== document.body && !rootRef.current?.contains(active) ? active : null);
        if (input.seed) {
          setSeed(input.seed);
          setCard(null);
        } else if (input.feature && !input.cardId) {
          // a FUNCIONALIDADE do PRD («Pedir item novo»): o chip diz o nome dela e o texto leva o id que o
          // `create_card` grava no item novo
          setSeed(null);
          setCard(featureChipContext(input.feature));
        } else {
          setSeed(null);
          setCard(input.cardId ? { id: input.cardId, title: input.cardTitle, card: input.card } : null);
        }
        if (input.draft !== undefined) setText(input.draft);
        setCmdOpen(false);
        setOpen(true);
        focusEnd();
      }),
    [focusEnd],
  );

  // A instrução REFINADA da escalação chega do painel (copilotItemContextAction) um instante depois da genérica: ela
  // só substitui o campo enquanto ele ainda tem o texto da semente (ou nada) — nunca o que a pessoa já escreveu.
  const appliedDraft = useRef<string | null>(null);
  const draftKey = api?.draft ? `${api.draft.nonce}:${api.draft.text}` : null;
  useEffect(() => {
    if (!api?.draft || draftKey === appliedDraft.current) return;
    appliedDraft.current = draftKey;
    const next = api.draft.text;
    const seedText = seed?.instruction ?? "";
    setText((cur) => (cur.trim() === "" || cur === seedText ? next : cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a chave já carrega nonce + texto
  }, [draftKey]);
  useEffect(() => {
    if (!api) appliedDraft.current = null;
  }, [api]);

  // Esc fecha de QUALQUER lugar da conversa (o campo trata o próprio Esc primeiro: com a lista aberta, ele só a fecha).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeChat();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeChat]);

  // A altura do compositor, publicada para quem precisa não ficar embaixo dele: a coluna da conversa termina aqui, e
  // as telas usam `padding-bottom: var(--jido-composer-h)` para o último item não ficar tapado.
  useEffect(() => {
    const el = stripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--jido-composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--jido-composer-h");
    };
  }, []);

  // O campo cresce com o texto (do mínimo — 2 linhas no computador, 1 no celular — até um teto: ~7 linhas no
  // computador, 5 no celular) e volta a encolher ao apagar.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 136 : 168)}px`;
  }, [text, compact]);

  // ── comandos ───────────────────────────────────────────────────────────────────────────────────────────
  // desligado (nunca armado / desarmado) oferece `/ligar`, não `/retomar` — o mesmo verbo do painel de ritmo
  const paceState = pace.view?.source === "disarmed" ? "off" : paused;
  const typed = jidoMenuFor(paceState, text);
  const menuItems = cmdDismissed ? null : (typed ?? (cmdOpen ? jidoMenuFor(paceState, "/") : null));
  const menuVisible = open && Boolean(menuItems?.length);
  // Digitar de novo ressuscita a lista (o Esc vale para aquele texto) e o destaque volta ao topo.
  useEffect(() => {
    setCmdDismissed(false);
    setCmdIndex(0);
  }, [text]);

  const changePace = async (pause: boolean, reason: string) => {
    const level = pause ? "paused" : "normal";
    let arm = false;
    if (!pause && pace.view?.source === "disarmed") {
      if (!window.confirm(PACE_ARM_CONFIRM)) {
        withApi((a) => a.notice("O board continua desligado."));
        return;
      }
      arm = true;
    }
    const r = await setBoardPaceAction({
      boardId,
      level,
      // pausar daqui = "deixar terminar": o que já roda termina, nada novo começa (o "parar agora" é do painel de ritmo)
      mode: pause ? "drain" : undefined,
      reason: reason || undefined,
      arm: arm || undefined,
    }).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (r.ok) {
      // o quadro (a pílula, a esteira, as caixinhas) troca na hora — o mascote aqui troca pelo mesmo aviso
      notifyBoardPaceChanged({ boardId, view: r.data.pace });
      router.refresh();
    }
    withApi((a) => a.notice(r.ok ? r.data.message : `Não consegui ${pause ? "pausar" : arm ? "ligar" : "retomar"} o board: ${r.error}`));
  };

  /** A captura: a da tela quando ela a oferece (com os cards como contexto), senão a do compositor. */
  const openCapture = (initialText: string | undefined) => {
    if (onCapture) onCapture(initialText);
    else setCapture({ initialText });
  };

  const runCommand = (c: JidoCommand, args: string) => {
    setCmdOpen(false);
    switch (c.name) {
      case "criar":
        closeChat();
        openCapture(args || undefined);
        return;
      case "bug":
        closeChat();
        // O relato de bug REABRE um card — só existe com o card em mão. Sem ele, a captura com a dica "algo quebrado".
        if (card?.card) setBugCard(card.card);
        else openCapture(bugCaptureText(args));
        return;
      case "pausar":
      case "retomar":
      case "ligar":
        setOpen(true);
        void changePace(c.name === "pausar", args);
        return;
      default: {
        if (isCoreCommand(c.name)) {
          if (busy && !c.whileBusy) {
            withApi((a) => a.notice(`Espere o Jido terminar a resposta atual para usar /${c.name}.`));
            return;
          }
          withApi((a) => a.runCommand(c.name));
          return;
        }
        const prompt = jidoPromptFor(c.name, args);
        if (prompt) withApi((a) => a.send(withCardContext(card, prompt)));
      }
    }
  };

  /** Escolher na lista ESCREVE o comando no campo (como no desenho) — quem roda é o Enter, com o complemento. */
  const pick = (c: JidoCommand) => {
    setText(composerTextFor(c));
    setCmdOpen(false);
    openByHand();
    focusEnd();
  };

  // ── envio ──────────────────────────────────────────────────────────────────────────────────────────────
  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const submit = () => {
    const t = text.trim();
    if (!t && !attachments.length) return;
    const parsed = attachments.length ? null : parseJidoCommand(allJidoCommands(), t);
    if (parsed) {
      setText("");
      runCommand(parsed.command, parsed.args);
      return;
    }
    const a = apiRef.current;
    if (!a) return; // a conversa ainda está abrindo — o texto fica no campo
    a.send(withCardContext(card, t), attachments.length ? attachments.map((x) => x.path) : undefined);
    setText("");
    setAttachments([]);
    setAttachErr(null);
  };
  const ready = Boolean(api);
  const canSend = hasContent && !uploading && (ready || text.trim().startsWith("/"));

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const a = apiRef.current;
    if (!imgs.length || !a) return;
    setAttachErr(null);
    setUploading(true);
    try {
      const paths = await a.attachImages(imgs);
      setAttachments((prev) => [...prev, ...paths.map((p, i) => ({ path: p, name: imgs[i]?.name ?? "imagem" }))]);
    } catch (e) {
      setAttachErr(e instanceof Error ? e.message : "falha ao anexar a imagem");
    } finally {
      setUploading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Com a lista ABERTA o teclado é dela: ↑↓ navega, Tab completa, Enter roda, Esc fecha (o texto fica).
    if (menuVisible && menuItems) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = menuItems.length;
        setCmdIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const c = menuItems[cmdIndex] ?? menuItems[0];
        if (c) setText(`/${c.name} `);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCmdDismissed(true);
        setCmdOpen(false);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const c = menuItems[cmdIndex] ?? menuItems[0];
        // o campo JÁ tem o comando inteiro (`/resumo`): o Enter roda; senão completa com o destacado
        const whole = parseJidoCommand(allJidoCommands(), text);
        if (whole && (!c || whole.command.name === c.name)) submit();
        else if (c) pick(c);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeChat();
      return;
    }
    // Enter envia, Shift+Enter quebra a linha.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const chipLabel = seed ? escalationRefLabel(seed.ref) : card ? cardChipLabel(card) : null;
  // A conversa do documento vale enquanto não chegou uma escalação do board (essa é do Jido).
  const docSurface = seed ? undefined : surface;

  // O ANEXO mora no topo da conversa aberta, na fileira do histórico / nova conversa / Fechar (com o anel de contexto,
  // que o painel desenha ali por portal) — não na caixa de escrever: no celular ele virava uma 2ª linha sozinho e a
  // caixa dobrava de altura. Fechado, nada disto existe (a moldura nem está montada).
  const headerTools = (
    <>
      {!ready && <span className="px-1 text-[12px] text-fg-subtle">abrindo a conversa…</span>}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = ""; // permite anexar o mesmo arquivo de novo
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={!ready || uploading}
        title="Anexar imagem à próxima mensagem"
        aria-label="Anexar imagem"
        className="grid h-10 w-10 place-items-center rounded-lg text-fg-muted transition hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg disabled:opacity-40 md:h-8 md:w-8"
      >
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ImagePlus className="h-4 w-4" aria-hidden />}
      </button>
    </>
  );
  const turnLive = Boolean(turn.streamingText || turn.runningTool) || turn.chat === "typing";
  const mood = { working: agentsWorking || busy || turnLive, paused, error: open && (Boolean(api?.error) || Boolean(turn.interrupted) || turn.chat === "error") };

  return (
    <>
      {/* O DIÁLOGO: a conversa e o compositor, juntos — o resto da página fica `inert` enquanto aberta. O invólucro é
          sempre o mesmo nó (o campo não remonta ao abrir); só os papéis mudam. Os filhos são `fixed`: ele não ocupa
          espaço no fluxo. */}
      <div
        ref={rootRef}
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
        aria-label={open ? (docSurface ? `Conversa: ${docSurface.label}` : "Conversa com o Jido") : undefined}
      >
      {open && (
        <ChatOverlay
          boardId={boardId}
          boardName={config.name}
          seed={seed ?? undefined}
          surface={docSurface}
          externalComposer={{ onApi: setApi, meterSlot: null }}
          headerTools={headerTools}
          onClose={closeChat}
        />
      )}

      {/* A FAIXA do rodapé: fechada, o degradê do fundo subindo; aberta, transparente e por cima do véu. */}
      <div
        ref={stripRef}
        data-jido-composer=""
        className={cn(
          // o degradê fechado: 24px no compacto (celular, computador baixo), 56px só no computador alto
          "pointer-events-none fixed inset-x-0 bottom-0 flex justify-center px-4 pt-6 tall:pt-14",
          "pb-[max(12px,env(safe-area-inset-bottom))] tall:pb-[max(20px,env(safe-area-inset-bottom))]",
          open ? "z-[57]" : "z-30",
        )}
        style={{ background: open ? "transparent" : CLOSED_FADE }}
      >
        <div
          className={cn(
            "pointer-events-auto relative flex w-full max-w-[760px] flex-col gap-2 rounded-2xl border bg-surface py-1.5 pl-2.5 pr-1.5 tall:pb-2.5 tall:pl-3.5 tall:pr-3 tall:pt-3",
            // a borda escurece com CONTEÚDO (o desenho), não com o foco; o foco do teclado tem o anel próprio — NEUTRO
            // (um halo grafite translúcido): o âmbar é o tom de "precisa de você" no quadro, e a caixa de escrever não
            // pode parecer um alerta só por estar em uso.
            "shadow-[0_8px_28px_rgba(15,15,15,0.10)] transition-colors has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-fg/10",
            hasContent ? "border-st-forgot" : "border-line",
          )}
        >
          {menuVisible && menuItems && (
            <JidoCommandMenu
              id={menuId}
              commands={menuItems}
              activeIndex={cmdIndex}
              onPick={pick}
              onHover={setCmdIndex}
              busy={busy}
            />
          )}

          {open && (api?.error || attachErr) && (
            <p role="alert" className="text-[12px] leading-snug text-danger">
              {api?.error ?? attachErr}
            </p>
          )}

          {/* com quem é a conversa desta página — no celular, só com ela aberta (fechado, o compositor é UMA fileira) */}
          {docSurface && !chipLabel && (
            <span className={cn("flex h-6 max-w-full items-center self-start rounded-md bg-inset px-2 text-[12px] text-fg-muted", !open && "max-md:hidden")}>
              <span className="truncate">
                Conversa: <b className="font-semibold text-fg">{docSurface.label}</b>
              </span>
            </span>
          )}

          {chipLabel && (
            <span className="flex h-6 max-w-full items-center gap-1.5 self-start rounded-md bg-inset pl-2 pr-1 text-[12px] text-fg-muted">
              <span className="truncate">
                Sobre <b className="font-semibold text-fg">{chipLabel}</b>
              </span>
              <button
                type="button"
                onClick={() => {
                  if (seed) setSeed(null);
                  else setCard(null);
                  inputRef.current?.focus();
                }}
                aria-label={`Tirar ${chipLabel} do contexto`}
                title="Tirar do contexto"
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-fg-subtle transition hover:bg-surface-hover hover:text-fg max-md:h-10 max-md:w-10"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a, i) => (
                <span key={a.path} className="flex h-6 items-center gap-1 rounded-md bg-inset pl-2 pr-1 text-[12px] text-fg-muted">
                  <ImagePlus className="h-3 w-3" aria-hidden />
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remover ${a.name}`}
                    className="grid h-5 w-5 place-items-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg max-md:h-10 max-md:w-10"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* A FILEIRA do campo. Uma só caixa flex que QUEBRA no computador alto e não quebra no compacto:
                computador alto → [Jido][campo, a linha inteira] / [/ ··· enviar]   (o desenho)
                celular e computador baixo → [Jido][campo de uma linha][/][enviar]   — aberta ou fechada, UMA fileira
              O anexo e o anel de contexto moram no topo da conversa aberta (ChatOverlay), não aqui.
              A ordem visual do computador alto vem de `tall:order-*`; a do DOM é a do compacto (e a do Tab nos dois).
              No computador baixo (`short:`) os alvos são de mouse (32px), não de dedo: a fileira fica com ~46px. */}
          <div className="flex flex-wrap items-end gap-x-2 gap-y-2 tall:items-center tall:gap-x-3">
            <span className="flex shrink-0 self-start pt-2 short:pt-1 tall:order-1 tall:pt-0.5">
              <JidoMark size={compact ? 24 : 28} mood={mood} />
            </span>
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => {
                const v = e.target.value;
                setText(v);
                if (!v.startsWith("/")) setCmdOpen(false);
                // escrever abre a conversa (o Tab que só PASSA pelo campo, não)
                openByHand();
              }}
              onPointerDown={openByHand}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData?.items ?? [])
                  .filter((it) => it.type.startsWith("image/"))
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => !!f);
                if (files.length) {
                  e.preventDefault(); // não cola a imagem como texto
                  void addFiles(files);
                }
              }}
              rows={compact ? 1 : 2}
              // o painel só pede outro texto no modo resposta de uma pergunta de card ("Responda a pergunta acima…")
              placeholder={api?.placeholder ?? (compact ? JIDO_PLACEHOLDER_SHORT : JIDO_PLACEHOLDER)}
              aria-label="Mensagem para o Jido"
              aria-controls={menuVisible ? menuId : undefined}
              aria-activedescendant={menuVisible && menuItems?.[cmdIndex] ? `${menuId}-${menuItems[cmdIndex].name}` : undefined}
              // celular: uma linha de 40px de alvo (16px de fonte — o iOS não dá zoom); computador: a linha inteira
              // da caixa (`basis` = 100% menos o Jido e o vão, com folga: na conta exata o arredondamento jogava o campo para a linha de baixo), duas linhas, mínimo de 56px.
              className="min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-[16px] leading-normal text-fg-strong outline-none placeholder:text-fg-subtle short:min-h-8 short:py-1 short:text-[15px] tall:order-2 tall:min-h-[56px] tall:basis-[calc(100%-2.75rem)] tall:pb-0 tall:pt-3 tall:text-[15px]"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setCmdDismissed(false);
                setCmdOpen((o) => !o);
                openByHand();
                inputRef.current?.focus();
              }}
              title="Comandos"
              aria-label="Comandos do Jido"
              aria-haspopup="listbox"
              aria-expanded={menuVisible}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line-muted font-mono text-[13px] text-fg transition hover:bg-inset short:h-8 short:w-8 tall:order-3 tall:h-7 tall:w-7",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg",
                menuVisible ? "bg-inset" : "bg-surface",
              )}
            >
              /
            </button>
            {/* computador alto: o vão entre o `/` e o enviar (a 2ª linha do desenho) */}
            <span aria-hidden className="hidden tall:order-4 tall:block tall:flex-1" />
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              title={busy ? "O Jido está respondendo — sua mensagem entra na fila" : "Enviar"}
              aria-label="Enviar"
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-lg text-surface transition short:h-8 short:w-8 tall:order-5 tall:h-8 tall:w-8",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
                canSend ? "bg-fg hover:bg-fg/85" : "bg-line-emphasis",
              )}
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
            </button>
          </div>
        </div>
      </div>
      </div>

      {capture && (
        <SmartCaptureModal
          boardId={boardId}
          config={config}
          initialText={capture.initialText}
          onClose={() => {
            setCapture(null);
            router.refresh();
          }}
          onCreated={() => router.refresh()}
          onOpenCard={(id) => router.push(cardHref(boardId, id))}
        />
      )}
      {bugCard && (
        <BugModal
          boardId={boardId}
          card={bugCard}
          statuses={config.statuses}
          onCancel={() => setBugCard(null)}
          onDone={() => {
            setBugCard(null);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
