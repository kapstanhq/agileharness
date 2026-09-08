"use client";

// 💬 ChatPanel — O CHAT. Um só, para todas as telas.
//
// Antes existiam DOIS: o cockpit do board (CopilotChat) com a gramática completa — mascote escrevendo no fim da
// linha, anel de contexto, comandos de barra, histórico de conversas, fila de saída, anexos — e um painel de tela
// (ViewChat) que reusava só o transporte e re-desenhava uma moldura mais pobre. O resultado era previsível: a
// conversa da tela de Ideias parecia (e era) um chat de segunda classe, e cada melhoria do chat do board tinha de
// ser reimplementada aqui ou simplesmente não chegava.
//
// A regra agora: **a conversa é a MESMA em toda tela; o que muda é só o que a tela tem a mais**. Este componente é
// a conversa; as diferenças entram por SLOTS e por DADOS (a superfície declarada em copilot/chat-surfaces), nunca
// por um segundo componente.
//
// O que ele traz para QUALQUER tela, sem uma linha de código nova por tela:
//   • o mascote que escreve no fim do texto + a publicação do humor no topnav (face-bus);
//   • o anel de contexto (medidor da sessão DAQUELA raia) e o menu da conversa;
//   • os comandos de barra `/clear` `/compact` `/context` `/model`;
//   • o histórico de conversas + "nova conversa" (roster por raia);
//   • a fila de saída, os anexos, o cancelamento, o carregar-mais-antigas;
//   • as ações rápidas e as TÉCNICAS da superfície.
//
// O que o HOST fornece (slots): a tarja de aviso, os controles à esquerda da barra flutuante, a faixa acima do
// composer, e a interceptação de envio — é por ela que o cockpit trata aprovações/perguntas sem que este módulo
// saiba o que é uma aprovação.
//
// ⚠️ UMA instância por rota. Cada painel instancia `useCopilotAgent`, que faz poll da sessão da raia e pega lease
// por turno; dois painéis na MESMA raia brigam pelo mesmo turno (409) e o desmonte de um solta o lease do outro —
// e, pior, dividem a chave de fila no sessionStorage. Raias diferentes (board × tela) coexistem, mas o mascote
// não: quem monta um chat docked suprime a gaveta do board (ver BoardHeader.dockedCopilot).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { HitlConversation } from "@/components/hitl/HitlConversation";
import { useCopilotAgent } from "@/components/hitl/useCopilotAgent";
import { OutboxList } from "@/components/chat/ChatOutbox";
import { ChatContextBar, type ChatContextRef } from "@/components/chat/ChatContext";
import { TechniquePicker, useTechnique } from "@/components/chat/ChatTechniques";
import { JidoCursor } from "@/components/copilot/CopilotFace";
import { BTN_ICON, GUTTER, ICON, QUICK_CHIP } from "@/components/copilot/ui";
import { CopilotChatActions } from "@/components/copilot/CopilotChats";
import { SessionMenu, useSessionMeter } from "@/components/copilot/CopilotSession";
import { notifyCopilotSessionChanged } from "@/components/copilot/meter-bus";
import { publishCopilotFace } from "@/components/copilot/face-bus";
import { chatSignals, deriveMood, type FaceSignals } from "@/lib/storymap/copilot/face";
import {
  copilotChatModelAction,
  resumeCopilotChatAction,
  setCopilotChatModelAction,
  startNewCopilotChatAction,
} from "@/app/copilot-actions";
import {
  CHAT_CONTEXT_WINDOW,
  CHAT_EFFORTS,
  CHAT_MODEL_BASES,
  composeModel,
  formatAge,
  formatTokens,
  splitModelVariant,
} from "@/lib/storymap/copilot/copilot-status";
import type { SlashCommand } from "@/lib/storymap/hitl/slash";
import type { ChatQuickAction, ChatTechnique } from "@/lib/storymap/copilot/chat-surfaces";
import type { HitlTurn } from "@/lib/storymap/hitl/types";

/**
 * OS COMANDOS DE BARRA — os do Claude Code, com os nomes DELE.
 *
 * Em inglês e idênticos de propósito: o operador desta ferramenta vive no Claude Code, e memória muscular não se
 * traduz. Um `/limpar` que faz o que `/clear` faz seria um segundo vocabulário para o mesmo gesto.
 *
 * Módulo (e não `useMemo`): a lista é constante, e uma identidade estável evita re-derivar a paleta a cada render.
 * Comando novo = UMA entrada aqui + um `case` no `runCommand`. Os quatro valem em QUALQUER raia — é por isso que
 * eles moram no núcleo e não no cockpit.
 */
const COMMANDS: SlashCommand[] = [
  { name: "clear", hint: "Começa uma conversa nova (a atual fica no histórico)" },
  { name: "compact", hint: "Resume a conversa e libera contexto, na mesma sessão" },
  // whileBusy: é LEITURA. Perguntar quanto de contexto foi enquanto ele responde é justamente quando a pergunta
  // importa — os outros dois mexem no contexto e ficam fora de alcance com um turno em voo.
  { name: "context", hint: "Quanto de contexto, turnos e custo esta conversa já tem", whileBusy: true },
  // Idle-only por uma razão de RENDER, não de segurança: a escolha é desenhada ancorada ao último turno do agente
  // e só aparece com o turno concluído. (A escrita em si é inofensiva: vale do próximo turno em diante.)
  { name: "model", hint: "Troca o modelo e o esforço desta conversa (vale no próximo turno)" },
];

/** As escolhas de MODELO que o `/model` oferece: base × janela, com o vocabulário vindo da fonte única. */
const MODEL_CHOICES: { id: string; label: string; hint: string }[] = CHAT_MODEL_BASES.flatMap((base) => [
  { id: composeModel(base, true), label: `${base} · 1M`, hint: "janela longa (contexto extra só é cobrado acima de 200k)" },
  { id: composeModel(base, false), label: `${base} · 200k`, hint: "janela padrão" },
]);

/** O que cada esforço significa para quem escolhe — a palavra sozinha (`xhigh`) não decide nada. */
const EFFORT_HINT: Record<string, string> = {
  medium: "rápido e barato — o padrão para perguntas de board",
  high: "pensa mais antes de responder",
  xhigh: "o teto: investigação longa, custo e latência maiores",
};

/**
 * A VERSÃO por trás do apelido — "qual Opus, 4.8 ou 5?".
 *
 * O `opus` do CLI é uma promessa ("o mais recente da família"), não um modelo, então a resposta certa não é uma
 * tabela no código (ela mentiria no próximo lançamento) e sim o que o CLI ANUNCIOU no último turno daquela
 * família (ver copilot/model-resolution.ts). Enquanto uma família nunca rodou aqui, a tela diz o que o apelido
 * literalmente significa em vez de inventar um número.
 */
function versionOf(resolutions: Record<string, string>, model: string): string | null {
  return resolutions[splitModelVariant(model).base.trim().toLowerCase()] ?? null;
}

/** Para a linha de estado: `opus[1m] (claude-opus-5)`. Silencioso quando a versão ainda não foi observada. */
function resolvedVersion(resolutions: Record<string, string>, model: string): string {
  const id = versionOf(resolutions, model);
  return id ? ` (${id})` : "";
}

/** Para o pró de cada opção: a versão, ou o que o apelido promete enquanto ela não é conhecida. */
function versionSuffix(resolutions: Record<string, string>, model: string): string {
  return ` · ${versionOf(resolutions, model) ?? "o mais recente da família"}`;
}

/**
 * A ESCOLHA DE MODELO de uma conversa de TELA, guardada no navegador.
 *
 * Assimetria deliberada, e vale saber por quê: no chat do BOARD o `/model` grava em `settings.orchestrator.chat`,
 * que é de onde o spawn resolve — durável e compartilhado, porque o Jido do board é um só. Uma conversa de TELA
 * resolve o tier pelo PROPÓSITO dela (`hitlPurposeById`, ex.: o Explorador é sonnet/medium) e o settings do chat
 * nem é consultado (`resolveCopilotModelEffort` só olha `orchestrator.chat` quando o propósito é `copilot`).
 * Gravar lá a partir daqui trocaria o modelo do Jido do board sem que ninguém pedisse.
 *
 * Então a escolha da tela é uma PREFERÊNCIA DAQUELA CONVERSA, mandada no corpo do turno (`reqModel`, que vence
 * tudo no servidor) e guardada em `localStorage` por raia — sobrevive a recarga e a outras abas, e some se o
 * operador limpar o navegador. Se um dia isso precisar ser durável no servidor, o lugar é um mapa por propósito
 * em settings + `resolveCopilotModelEffort` — não um segundo caminho aqui.
 */
function useLaneModel(lane: string, enabled: boolean) {
  const key = `copilot-model-${lane}`;
  const [override, setOverride] = useState<{ model?: string; effort?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw) setOverride(JSON.parse(raw) as { model?: string; effort?: string });
    } catch {
      /* preferência ilegível nunca pode impedir a conversa de abrir */
    }
  }, [key, enabled]);
  const patch = useCallback(
    (next: { model?: string; effort?: string }) => {
      setOverride((prev) => {
        const merged = { ...prev, ...next };
        try {
          window.localStorage.setItem(key, JSON.stringify(merged));
        } catch {
          /* modo privado / cota — a escolha ainda vale nesta sessão */
        }
        return merged;
      });
    },
    [key],
  );
  return { override, patch };
}

/** O que o host pode enfiar dentro da conversa sem que ela saiba o que é. */
export interface ChatPanelSlots {
  /** tarja PERSISTENTE no topo do painel (o cockpit usa p/ o ciclo autônomo em voo). */
  banner?: ReactNode;
  /** o que governa o COMPORTAMENTO do agente, à esquerda da barra flutuante (o cockpit põe modo + ajustes). */
  controls?: ReactNode;
  /** faixa ancorada entre transcript e composer (o cockpit põe o diário do tick). */
  beforeComposer?: ReactNode;
  /** alguém que não é o operador trabalha nesta conversa agora → linha viva no fim do transcript. */
  systemWorking?: string | null;
}

/** A API que o núcleo entrega ao host na interceptação de envio — o mínimo para ele escrever no thread. */
export interface ChatSendApi {
  pushTurns: (turns: HitlTurn[]) => void;
  send: (text: string, ids?: string[], images?: string[]) => void;
}

export function ChatPanel({
  boardId,
  view,
  label,
  context,
  greeting,
  getContext,
  placeholder,
  quickActions,
  techniques,
  contextRefs,
  slots,
  onSignals,
  onClose,
  onIntercept,
  tickRunning,
  draft,
  className,
}: {
  boardId: string;
  /** a TELA dona da conversa (raia própria). Ausente ⇒ o chat do board — o cockpit. */
  view?: string;
  /** o nome da conversa, para leitores de tela (o painel não tem header: a moldura é a barra do composer). */
  label: string;
  /** contexto de abertura (fallback); `getContext` re-resolve fresco a cada turno. */
  context: string;
  /** os turnos iniciais — só valem quando não há thread persistido. */
  greeting?: HitlTurn[];
  getContext?: () => Promise<string | undefined>;
  placeholder?: string;
  quickActions?: readonly ChatQuickAction[];
  techniques?: readonly ChatTechnique[];
  /**
   * O que está PRESO a esta conversa além do escopo largo da tela (a ideia aberta, um card em foco).
   *
   * Ele é DESENHO, não transporte: quem monta o contexto de verdade é o `getContext` do host. Este campo só
   * garante que o operador VEJA o que o agente está lendo — antes dele, abrir uma ideia mudava silenciosamente
   * o que ia no prompt e a tela seguia dizendo "estou vendo a bancada inteira".
   */
  contextRefs?: readonly ChatContextRef[];
  slots?: ChatPanelSlots;
  /** o que o TURNO sente, para o rosto lá no topnav (o host repassa ao face-bus com a chave que ele conhece). */
  onSignals?: (s: FaceSignals) => void;
  /** presente ⇒ o host oferece saída: o ✕ entra na barra do composer e o ESC fecha. */
  onClose?: () => void;
  /**
   * O host vê o envio ANTES da conversa. Devolver `true` = "eu tratei isto, não mande ao modelo" (é assim que o
   * cockpit responde perguntas de card e decide aprovações sem que este módulo conheça nenhuma das duas coisas).
   */
  onIntercept?: (input: { text: string; ids?: string[]; images?: string[] }, api: ChatSendApi) => boolean;
  /** um ciclo autônomo escreve nesta sessão agora ⇒ o poll near-live acelera. */
  tickRunning?: boolean;
  /** one-shot prefill do composer (escalação de item). */
  draft?: { text: string; nonce: number };
  className?: string;
}) {
  const lane = view ? `${boardId}--${view}` : boardId;
  const { technique, setTechnique, instruction } = useTechnique(lane, techniques);
  // A escolha de modelo só é local numa conversa de TELA; o cockpit continua gravando no settings (ver useLaneModel).
  const { override, patch } = useLaneModel(lane, Boolean(view));

  const hitl = useCopilotAgent({
    boardId,
    view,
    context,
    initialTurns: greeting,
    getContext,
    tickRunning,
    instruction,
    model: view ? override.model : undefined,
    effort: view ? override.effort : undefined,
  });

  // ── O QUE O TURNO SENTE ────────────────────────────────────────────────────────────────────────────────
  // O rosto mora no topnav; o humor do TURNO só existe aqui dentro. Sem esta ponte o mascote ficaria de cara
  // parada justamente enquanto o agente responde — o estado mais vivo que o produto tem.
  const busy = hitl.status !== "idle";
  const [contextTone, setContextTone] = useState<"ok" | "warn" | "danger">("ok");
  const session = useSessionMeter(boardId, busy, setContextTone, view);
  const turn = chatSignals({ status: hitl.status, turns: hitl.turns, straining: hitl.straining });
  const signals = useMemo<FaceSignals>(
    () => ({
      chat: turn.chat,
      streamingText: turn.streamingText,
      runningTool: turn.runningTool,
      interrupted: turn.interrupted,
      straining: turn.straining,
      contextTone,
    }),
    // Deps PRIMITIVOS de propósito: `hitl.turns` é um array novo a CADA token — memoizar por ele faria o topnav
    // re-renderizar letra por letra.
    [turn.chat, turn.streamingText, turn.runningTool, turn.interrupted, turn.straining, contextTone],
  );
  const onSignalsRef = useRef(onSignals);
  onSignalsRef.current = onSignals;
  useEffect(() => {
    onSignalsRef.current?.(signals);
  }, [signals]);
  // Sem host interessado nos sinais (uma tela que só monta o painel), o próprio núcleo publica no face-bus: o
  // mascote do topnav reflete a conversa que está na tela, seja ela do board ou da tela. É o que garante que ele
  // nunca esteja em dois lugares — há UM painel montado por rota, e é ele quem fala pelo rosto.
  useEffect(() => {
    if (onSignalsRef.current) return;
    publishCopilotFace(boardId, signals);
  }, [boardId, signals]);
  // Limpa no DESMONTE (efeito separado, sem `signals` nas deps): com a limpeza no cleanup do efeito acima, toda
  // mudança de sinal publicaria `{}` antes do valor novo — o mascote piscaria de volta ao repouso a cada token.
  useEffect(
    () => () => {
      if (!onSignalsRef.current) publishCopilotFace(boardId, {}, false);
    },
    [boardId],
  );

  // O MASCOTE QUE ESCREVE — o mesmo humor do rosto lá em cima, no fim da linha que está saindo.
  // Memoizado por HUMOR: a identidade deste nó entra no mapa de componentes do markdown, e trocá-la a cada token
  // remontaria o SVG — a animação recomeçaria a cada letra e o mascote pareceria travado.
  const mood = deriveMood(signals);
  const streamCursor = useMemo(() => <JidoCursor mood={mood} />, [mood]);

  // ESC fecha, e o painel recebe o foco ao abrir — sem isto uma gaveta é um beco para quem navega por teclado.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onClose) return;
    rootRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── AS CONVERSAS (nova / retomar) ──────────────────────────────────────────────────────────────────────
  // "Nova conversa" = fechar dos DOIS lados. O reset zera o cliente; sem fechar no servidor, o medidor seguiria
  // mostrando o contexto/custo da anterior num chat recém-aberto. O aviso vai DEPOIS de o servidor gravar —
  // notificar antes faria os assinantes re-lerem a sessão velha, que ainda existiria.
  const startNewChat = useCallback(() => {
    void startNewCopilotChatAction(boardId, view)
      .catch(() => {})
      .finally(() => notifyCopilotSessionChanged(boardId));
    hitl.reset();
    hitl.pushTurns([
      { role: "notice", kind: "command", text: "Conversa nova — a anterior ficou no histórico, no topo do painel." },
    ]);
  }, [boardId, view, hitl]);

  /** RETOMA uma conversa: troca o ponteiro no servidor e SÓ ENTÃO o painel adota a sessão (invertida, a ordem
   *  re-hidrataria o transcript da conversa que está saindo). Uma falha vira linha no thread, nunca clique mudo. */
  const resumeChat = useCallback(
    async (sessionId: string) => {
      const res = await resumeCopilotChatAction({ boardId, sessionId, view });
      if (!res.ok) {
        hitl.pushTurns([{ role: "notice", kind: "command", text: `Não consegui retomar: ${res.error}` }]);
        return;
      }
      await hitl.adoptSession(sessionId);
      notifyCopilotSessionChanged(boardId);
    },
    [boardId, view, hitl],
  );

  // ── OS COMANDOS DE BARRA ───────────────────────────────────────────────────────────────────────────────
  const commandNotice = useCallback(
    (text: string) => hitl.pushTurns([{ role: "notice", kind: "command", text }]),
    [hitl],
  );
  const runCommand = useCallback(
    (name: string) => {
      switch (name) {
        case "clear":
          startNewChat();
          return;
        case "compact":
          // Vai CRU ao CLI (sem o bloco <contexto>, senão a barra não abre o prompt e nada é compactado) e ecoa
          // como evento, não como uma bolha "/compact" que o operador nunca digitou.
          hitl.send("/compact", undefined, undefined, { command: "Compactando a conversa…" });
          return;
        case "model":
          // Pergunta com a MESMA UI de escolha que o agente usa (hitl/ask): o comando não abre um painel à parte —
          // ele conversa. O "atual" é o EFETIVO (o que o próximo turno rodaria), não o que está escrito no arquivo.
          void copilotChatModelAction(view ? { view } : undefined)
            .then(({ model, effort, resolutions }) => {
              const curModel = override.model ?? model;
              const curEffort = override.effort ?? effort;
              hitl.pushTurns([
                {
                  role: "agent",
                  message: `Agora: modelo **${curModel}**${resolvedVersion(resolutions, curModel)}, esforço **${curEffort}**. Qual modelo?`,
                  options: MODEL_CHOICES.map((c) => ({
                    id: `model:${c.id}`,
                    label: c.label + (c.id === curModel ? " · atual" : ""),
                    pros: [`${c.hint}${versionSuffix(resolutions, c.id)}`],
                  })),
                  mode: "single",
                },
              ]);
            })
            .catch(() => commandNotice("Não consegui ler a configuração do modelo."));
          return;
        case "context": {
          // LEITURA — responde na hora, sem gastar turno de modelo. É o número que o anel já mostra de relance.
          const m = session.meter;
          commandNotice(
            m
              ? `Contexto: ${formatTokens(m.contextTokens)} de ${formatTokens(m.contextWindow || CHAT_CONTEXT_WINDOW)} (${session.pct}%) · ${m.turns} ${m.turns === 1 ? "turno" : "turnos"}${m.costUSD > 0 ? ` · $${m.costUSD.toFixed(2)}` : ""} · ${busy ? "respondendo agora" : `ociosa há ${formatAge(session.idleMs)}`}`
              : "Conversa nova — nenhum contexto acumulado ainda.",
          );
          return;
        }
      }
    },
    [busy, commandNotice, hitl, session, startNewChat, view, override.model, override.effort],
  );

  // `/model`, passo a passo: primeiro QUAL modelo, depois QUANTO ele pensa. Cada passo GRAVA — parar no meio deixa
  // uma troca válida aplicada, que é o que o operador pediu.
  const pickModel = useCallback(
    async (model: string) => {
      if (view) {
        patch({ model });
        hitl.pushTurns([
          {
            role: "agent",
            message: `Modelo desta conversa agora é **${model}** — vale no próximo turno. E o esforço?`,
            options: CHAT_EFFORTS.map((e) => ({ id: `effort:${e}`, label: e, pros: [EFFORT_HINT[e]] })),
            mode: "single",
          },
        ]);
        return;
      }
      const res = await setCopilotChatModelAction({ model });
      if (!res.ok) {
        hitl.pushTurns([{ role: "agent", message: `Não consegui trocar o modelo: ${res.error}` }]);
        return;
      }
      hitl.pushTurns([
        {
          role: "agent",
          message: `Modelo agora é **${res.model}** — vale no próximo turno. E o esforço?`,
          options: CHAT_EFFORTS.map((e) => ({
            id: `effort:${e}`,
            label: e + (e === res.effort ? " · atual" : ""),
            pros: [EFFORT_HINT[e]],
          })),
          mode: "single",
        },
      ]);
    },
    [hitl, patch, view],
  );

  const pickEffort = useCallback(
    async (effort: string) => {
      if (view) {
        patch({ effort });
        hitl.pushTurns([
          {
            role: "notice",
            kind: "command",
            text: `Esta conversa em ${override.model ?? "modelo do propósito"} · esforço ${effort} — vale no próximo turno.`,
          },
        ]);
        return;
      }
      const res = await setCopilotChatModelAction({ effort });
      hitl.pushTurns([
        res.ok
          ? {
              role: "notice",
              kind: "command",
              // O fecho carrega os DOIS valores: quem chegou aqui trocou duas coisas e a última linha do fluxo é
              // o que ele vai reler depois para saber em que configuração o agente ficou.
              text: `Jido em ${res.model} · esforço ${res.effort} — vale no próximo turno.`,
            }
          : { role: "agent", message: `Não consegui trocar o esforço: ${res.error}` },
      ]);
    },
    [hitl, patch, view, override.model],
  );

  // F4 — sobe cada imagem colada/arrastada/anexada e devolve os paths absolutos (que a sessão headless abre com
  // Read). Falha em qualquer arquivo aborta o lote (o composer mantém o texto).
  const onAttachImages = useCallback(async (files: File[]): Promise<string[]> => {
    const paths: string[] = [];
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/copilot/upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; path?: string; error?: string } | null;
      if (!res.ok || !data?.ok || !data.path) throw new Error(data?.error || `upload falhou (HTTP ${res.status})`);
      paths.push(data.path);
    }
    return paths;
  }, []);

  const sendApi = useMemo<ChatSendApi>(
    () => ({ pushTurns: hitl.pushTurns, send: (t, i, im) => hitl.send(t, i, im) }),
    [hitl],
  );

  const handleSend = (text: string, ids?: string[], images?: string[]) => {
    // (1) O HOST vê PRIMEIRO: aprovações, perguntas de card, o que ele souber tratar. `true` = tratado.
    //
    // A ordem importa e não é arbitrária: enquanto o cockpit está em "modo resposta" de uma pergunta de card, o
    // próximo envio é a RESPOSTA — inclusive quando o operador toca numa opção cujo id, por azar, se pareça com
    // um id do núcleo. Deixando o host à frente, ele engole tudo enquanto responde, que é exatamente a guarda
    // (`!answering`) que existia quando as duas coisas moravam na mesma função.
    if (onIntercept?.({ text, ids, images }, sendApi)) return;
    // (2) As escolhas do `/model` — as duas etapas. Ficam aqui (e não no host) porque o comando é do NÚCLEO:
    // quem oferece a escolha é quem a resolve.
    if (ids?.length === 1) {
      const id = ids[0];
      if (id.startsWith("model:")) {
        void pickModel(id.slice("model:".length));
        return;
      }
      if (id.startsWith("effort:")) {
        void pickEffort(id.slice("effort:".length));
        return;
      }
    }
    // (3) turno normal — vai para a FILA (sai na hora se a raia estiver livre).
    hitl.send(text, ids, images);
  };

  // Ancorados acima do composer, em ordem de permanência:
  //   1. o que o HOST pendurou (o diário do tick, no cockpit);
  //   2. os ANEXOS — o que a conversa está olhando. Ficam SEMPRE: descrevem o que todo turno enxerga;
  //   3. as AÇÕES RÁPIDAS — somem quando a conversa começa. Servem para vencer a página em branco, não
  //      para competir com o que você quer perguntar.
  //
  // O ESPAÇAMENTO desta pilha mora AQUI, num lugar só. Ele estava repartido entre quatro peças que não se
  // conhecem — um `gap-1.5` na pilha, um `pb-1.5` dentro da barra de anexos, um `pb-0.5` na fileira de
  // atalhos e o `pt-1` do rodapé do composer — e o que sobrava entre o último atalho e a caixa de escrever
  // eram 6px: as pílulas encostavam no composer como se fossem parte dele. Empilhamento com respiro
  // desigual é o defeito que o Operador viu primeiro ("componentes colados, sem espaçamento embaixo").
  // Uma pilha tem UM dono de ritmo: `gap-2` entre as faixas, `pb-2` antes do composer.
  const virgin = hitl.turns.filter((t) => t.role === "human").length === 0;
  const showQuick = Boolean(quickActions?.length) && virgin;
  const hasCtx = Boolean(contextRefs?.length);
  const beforeComposer =
    slots?.beforeComposer || hasCtx || showQuick ? (
      <div className="flex flex-col gap-2 pb-2">
        {slots?.beforeComposer}
        {hasCtx && <ChatContextBar refs={contextRefs!} />}
        {showQuick ? (
          // `gap-2` nos DOIS eixos: as pílulas quebram em duas fileiras num painel de 420px, e 6px entre
          // fileiras de alvos de 29px de altura lê como uma massa só, não como quatro opções.
          // `GUTTER` alinha os atalhos com a caixa do composer e com o texto das mensagens.
          <div className={cn("flex flex-wrap gap-2", GUTTER)}>
            {quickActions!.map((a) => (
              <button key={a.label} type="button" onClick={() => hitl.send(a.prompt)} className={QUICK_CHIP}>
                {a.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div
      ref={rootRef}
      // SEMPRE `region`, nunca `dialog`. Quem é a caixa modal é a MOLDURA (o ChatDock, ou a gaveta do
      // CopilotChat): é ela que tem o backdrop, o `aria-modal` e o que fechar. Marcar os dois como diálogo
      // aninhava um dentro do outro — um leitor de tela anunciaria duas caixas para a mesma conversa, e um
      // `getByRole("dialog")` passa a resolver dois nós (foi assim que isto apareceu). A conversa é o CONTEÚDO
      // da moldura, e o papel dela é esse.
      role="region"
      aria-label={label}
      tabIndex={-1}
      className={cn("flex h-full min-h-0 flex-col outline-none", className)}
    >
      {slots?.banner}
      <div className="min-h-0 flex-1">
        <HitlConversation
          turns={hitl.turns}
          status={hitl.status}
          error={hitl.error}
          responseMode={hitl.responseMode}
          setResponseMode={hitl.setResponseMode}
          onSend={handleSend}
          onCancel={hitl.cancel}
          onAttachImages={onAttachImages}
          onLoadOlder={hitl.loadOlder}
          hasOlder={hitl.hasOlder}
          done={hitl.done}
          placeholder={placeholder ?? "Pergunte ou instrua…"}
          className="h-full"
          layout="full"
          draft={draft}
          // Há FILA: digitar e enviar continua liberado com um turno em voo — a mensagem entra na fila (bolhas
          // tracejadas abaixo) e sai sozinha. `scrollKey` faz o transcript acompanhar a bolha recém-enfileirada.
          queueWhileBusy
          scrollKey={hitl.outbox.length}
          systemWorking={slots?.systemWorking ?? null}
          afterTurns={
            <OutboxList
              items={hitl.outbox}
              paused={hitl.outboxPaused}
              waitingReason={hitl.waiting?.reason ?? null}
              selfBusy={hitl.status === "typing"}
              onRemove={hitl.removeFromOutbox}
              onResume={hitl.resumeOutbox}
            />
          }
          beforeComposer={beforeComposer}
          streamCursor={streamCursor}
          commands={COMMANDS}
          onCommand={runCommand}
          // A BARRA DO TOPO — o que governa a CONVERSA INTEIRA. Ela flutua sobre o transcript com um degradê (o
          // texto passa por baixo), então o painel continua sendo conversa de ponta a ponta, sem header.
          topBar={
            <>
              {slots?.controls}
              {techniques?.length ? (
                <TechniquePicker techniques={techniques} active={technique} onPick={setTechnique} />
              ) : null}
              <span className="flex-1" />
              {/* À DIREITA, as ações da CONVERSA (qual delas está na tela) — separadas do que governa o
                  comportamento do agente, à esquerda. `typing`, não `busy`: o que impede trocar de conversa é um
                  TURNO EM VOO; depois de um erro, começar outra é justamente o que o operador quer. */}
              <CopilotChatActions
                boardId={boardId}
                view={view}
                busy={hitl.status === "typing"}
                onNewChat={startNewChat}
                onResume={(id) => void resumeChat(id)}
              />
              {onClose && (
                <button type="button" onClick={onClose} className={BTN_ICON} aria-label="Fechar" title="Fechar (Esc)">
                  <X className={ICON.inline} />
                </button>
              )}
            </>
          }
          // DENTRO do campo ficam as ações da MENSAGEM (anexo) e da SESSÃO (o anel com contexto/custo/compactar) —
          // a mão que digita alcança as duas sem sair da caixa.
          showModeToggle={false}
          composerExtra={
            <SessionMenu
              session={session}
              active={busy}
              onCompact={() => hitl.send("/compact", undefined, undefined, { command: "Compactando a conversa…" })}
              responseMode={hitl.responseMode}
              setResponseMode={hitl.setResponseMode}
            />
          }
        />
      </div>
    </div>
  );
}
