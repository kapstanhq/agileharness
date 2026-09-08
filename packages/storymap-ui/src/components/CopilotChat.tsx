"use client";

// WS8 — the CONVERSATIONAL copiloto chat, opened from the topnav. A right-side drawer that grounds a
// conversation in the current board's live state (copilotContextAction) and runs it through the shared HITL
// backend (useHitl, purpose "copilot"). On open it greets with a state summary (what needs you + open
// questions) so the board's pending questions are visible right in the thread; then you chat freely and it
// answers grounded — it recommends actions (the human/tick acts), never deploys/deletes on its own.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel, type ChatSendApi } from "@/components/chat/ChatPanel";
import { NoticeBand } from "@/components/chat/ChatOutbox";
import { BTN_GHOST, TXT } from "@/components/copilot/ui";
import { cn } from "@/lib/cn";
import { scariestRisk, type FaceSignals } from "@/lib/storymap/copilot/face";
import type { CopilotStatusLevel } from "@/lib/storymap/copilot/copilot-status";
import { CopilotChatControls } from "@/components/copilot/CopilotChatControls";
import { CopilotActivityFeed } from "@/components/copilot/CopilotActivityFeed";
import { publishCopilotFace } from "@/components/copilot/face-bus";
import {
  acquireCopilotLeaseAction,
  copilotContextAction,
  copilotItemContextAction,
  releaseCopilotLeaseAction,
  type CopilotApprovalRef,
} from "@/app/copilot-actions";
import { answerQuestionAction, approveActionRequestAction, rejectActionRequestAction } from "@/app/actions";
// WS-1 (copilot-actionability) — escalation seed: composer prefill + item context (D4/D10).
import type { CopilotSeed } from "@/lib/storymap/copilot/escalation-seed";
import type { EscalationRef } from "@/lib/storymap/copilot/escalation";
import {
  questionChipOptions,
  parseQuestionChipId,
  answerOptionsFor,
  mapBackAnswerIds,
  type OpenQuestionRef,
} from "@/lib/storymap/hitl/question-chips";
import type { HitlTurn } from "@/lib/storymap/hitl/types";

// A FILA DE SAÍDA mudou de casa (components/chat/ChatOutbox): ela é corpo de QUALQUER conversa, e o núcleo
// compartilhado precisa dela — deixá-la aqui faria o núcleo importar do seu próprio consumidor. Re-exportada
// para não quebrar quem já a importava daqui.
export { OutboxList } from "@/components/chat/ChatOutbox";

/** WS-1 — a short, client-side label of an escalated item for the greeting line ("Item escalado: **…**").
 *  Uses only the ref's inocuous ids (the richer itemContextTitle needs the card, which loads server-side). */
function refLabel(ref: EscalationRef): string {
  switch (ref.kind) {
    case "merge":
      return `merge do run ${ref.runId}`;
    case "run":
      return `run do card ${ref.cardId}`;
    case "deploy":
      return `deploy do card ${ref.cardId}`;
    case "finding":
      return `bloqueio ${ref.findingId}`;
    case "question":
      return `pergunta do card ${ref.cardId}`;
    case "branch":
      return `branch ${ref.branch}`;
    case "process":
      return `sessão ${ref.session}`;
    case "approval":
      return `aprovação ${ref.approvalId}`;
    case "governance":
      return `draft ${ref.draftId}`;
    case "move-blocked":
      return `move para ${ref.target}`;
    default:
      return `card ${ref.cardId}`;
  }
}

/**
 * O CHAT em si, sem casca — layout-agnóstico: ocupa a altura que o host der.
 *
 * Duas cascas o usam: {@link CopilotChat} (o drawer overlay de sempre, montado pelo BoardHeader em
 * toda view) e o rail fixo de 492px da home. A regra que separa as duas é "montado = aberto": aqui
 * não existe prop `open` — o host monta quando quer conversa e desmonta quando não quer, e é o
 * desmonte que solta o lease de pareamento.
 *
 * `onClose` é OPCIONAL e significa "o host oferece uma saída": com ele aparece o X e o ESC fecha; sem
 * ele (rail docked, que não fecha) nenhum dos dois existe — um X num painel permanente não faria nada.
 *
 * ⚠️ Uma instância POR ROTA. Cada thread instancia `useCopilotAgent`, que faz poll da sessão
 * COMPARTILHADA do board e adquire lease por turno; dois painéis montados na mesma tela brigam pelo
 * mesmo turno (409) e o desmonte de um solta o lease do outro. Quem monta o rail suprime o drawer.
 * Com a FILA DE SAÍDA a invariante ficou mais séria: os dois painéis compartilhariam a MESMA chave
 * de fila em sessionStorage (é por-aba, não por-componente), e dois pumps sobre a mesma fila podem
 * despachar o mesmo envio duas vezes. A fila restaurada nasce PAUSADA, o que segura o caso comum —
 * mas a regra continua sendo montar um painel só.
 */
export function CopilotChatPanel({
  boardId,
  boardName,
  onClose,
  seed,
}: {
  boardId: string;
  boardName: string;
  /** Presente ⇒ o host oferece fechar (X + ESC). Ausente ⇒ painel permanente. */
  onClose?: () => void;
  /** WS-1 (D4) — escalação de item: instrução pré-preenchida + ref. Ausente ⇒ comportamento atual. */
  seed?: CopilotSeed;
}) {
  const [context, setContext] = useState<string | null>(null);
  // WS-1 — o contexto do ITEM escalado (bloco "## Item escalado", entra DENTRO do <contexto>) + a instrução
  // pré-preenchida (genérica primeiro; copilotItemContextAction a refina com ids/labels reais). Null ⇒ sem escalação.
  const [itemContext, setItemContext] = useState<string | null>(null);
  const [seedInstruction, setSeedInstruction] = useState<string | null>(null);
  const [greeting, setGreeting] = useState<HitlTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // 2.5 — bump re-dispara o fetch (botão "Tentar de novo")
  const [openQuestions, setOpenQuestions] = useState<OpenQuestionRef[]>([]); // 3.1 — perguntas respondíveis inline
  const [pendingApprovals, setPendingApprovals] = useState<CopilotApprovalRef[]>([]); // F5.8 — aprovações inline
  // (Aposentado: o `resetRef`, a ponte que levava o "Nova conversa" do thread até um botão montado FORA dele —
  // dentro do popover de ajustes. Com a ação no cabeçalho do próprio thread, quem a dispara é quem a tem.)
  // O que o Jido SENTE nasce em dois lugares: o TURNO (dentro do thread: streaming, tool rodando, engasgo,
  // erro, aprovações) e o BOARD (nos CopilotChatControls, que já leem o overview: o Jido está desligado? um
  // tick está rodando?). Cada um reporta o seu pedaço em PRIMITIVOS estáveis.
  //
  // O ROSTO não está mais aqui — ele mora no topnav, e é a ÚNICA cara do Jido. Por isso o turno é PUBLICADO
  // no face-bus: o topnav enxerga sozinho só o repouso (nível do board, tick rodando, conversa recente), e
  // sem esta ponte o mascote ficaria de cara parada justamente enquanto o Jido responde, chama tool ou
  // engasga — o estado mais vivo que o produto tem. Os sinais de BOARD não vão no bus: o topnav já os lê.
  const [turnSignals, setTurnSignals] = useState<FaceSignals>({});
  const [boardSignals, setBoardSignals] = useState<FaceSignals>({});
  useEffect(() => {
    publishCopilotFace(boardId, turnSignals);
  }, [boardId, turnSignals]);
  // Limpa no DESMONTE (efeito separado, sem `turnSignals` nas deps): com a limpeza no cleanup do efeito acima,
  // toda mudança de sinal publicaria `{}` antes do valor novo — o mascote piscaria de volta ao repouso a cada
  // token. Aqui o cleanup só roda quando o chat sai da tela (ou troca de board), que é quando ele deve mesmo
  // parar de reportar turno.
  useEffect(() => () => publishCopilotFace(boardId, {}, false), [boardId]);
  const handleStatus = useCallback(
    (s: { level: CopilotStatusLevel; running: boolean }) =>
      setBoardSignals((prev) =>
        prev.level === s.level && prev.autonomousRunning === s.running ? prev : { level: s.level, autonomousRunning: s.running },
      ),
    [],
  );

  // On open, fetch the board state → inject as context + seed a grounded greeting turn. 2.1: the thread is
  // MOUNTED only AFTER this resolves (context !== null), so useHitl's one-shot useState(initialTurns) captures
  // the greeting. Before, useHitl was called at the top with an empty greeting and NEVER re-seeded when the
  // async greeting arrived → the chat opened visually empty (no first turn, no thread area).
  useEffect(() => {
    let alive = true;
    setContext(null); // reset on (re)mount → shows the loading gate until the fresh fetch resolves
    setError(null);
    // WS-1 — reset + seed the item context/instruction. The GENERIC instruction (from the ref) is available
    // immediately; copilotItemContextAction refines it in PARALLEL with real ids/labels. Fail-soft: a broken
    // item fetch keeps the generic seed (the MCP_EVIDENCE_HINT line covers the missing evidence).
    setItemContext(null);
    setSeedInstruction(seed ? seed.instruction : null);
    if (seed) {
      void copilotItemContextAction({ boardId, ref: seed.ref })
        .then((res) => {
          if (!alive || !res.ok) return;
          setItemContext(res.data.context);
          setSeedInstruction(res.data.instruction);
        })
        .catch(() => {
          /* fail-soft */
        });
    }
    void copilotContextAction(boardId)
      .then((res) => {
        if (!alive) return;
        setOpenQuestions(res.openQuestions); // 3.1 — kept so a chip click maps back to the card question
        setPendingApprovals(res.pendingApprovals); // F5.8 — aprovações do tick autônomo, acionáveis inline
        const nQ = res.openQuestions.length;
        const nA = res.pendingApprovals.length;
        const bits: string[] = [];
        if (res.needsYouCount) bits.push(`${res.needsYouCount} ${res.needsYouCount === 1 ? "item" : "itens"} para revisar`);
        if (nQ) bits.push(`${nQ} pergunta${nQ === 1 ? "" : "s"} em aberto`);
        if (nA) bits.push(`${nA} açã${nA === 1 ? "o" : "ões"} do Jido aguardando aprovação`);
        const summary = bits.length ? `Você tem ${bits.join(", ")}.` : "Nada urgente no momento.";
        // F6.2 — SEM parede de chips: perguntas e aprovações NÃO viram N chips no greeting. Viram AÇÕES
        // (a lista aparece atrás de UM toque). Sentinels tratados no handleSend do CopilotThread.
        const actions = [
          ...(nA ? [{ id: "__review_approvals", label: `Revisar ${nA} aprovaç${nA === 1 ? "ão" : "ões"}` }] : []),
          ...(nQ
            ? [
                { id: "__answer_questions", label: `Responder ${nQ} pergunta${nQ === 1 ? "" : "s"}` },
                { id: "__copilot_answer", label: "Deixe o Jido responder o que conseguir" },
              ]
            : []),
        ];
        const invite = nA
          ? "Toque para revisar as aprovações pendentes, ou cuide das perguntas. Ou pergunte o status / peça uma recomendação."
          : nQ
            ? "Posso listar as perguntas para você responder, ou eu mesmo apuro as que dá (código/dados) e proponho — você decide as de produto. Ou pergunte o status / peça uma recomendação."
            : "Pergunte o status, peça uma recomendação, ou me diga o que fazer.";
        const seedLine = seed ? `Item escalado: **${refLabel(seed.ref)}**. ` : "";
        setGreeting([
          {
            role: "agent",
            message: `${seedLine}Oi — sou o Jido do board **${boardName}**. ${summary} ${invite}`,
            options: actions.length ? actions : undefined,
            mode: "single",
            // As três perguntas que o operador faz o tempo todo, a um toque. Elas não são "opções de uma
            // escolha" (não respondem nada) — são atalhos de digitação, e é por isso que viajam em
            // `suggestions` e não em `options`.
            //
            // Elas só aparecem quando o greeting NÃO tem ações nem escalação — as três situações são
            // excludentes por desenho: um item escalado JÁ diz o que fazer (oferecer "qual o status do
            // board?" ao lado dele é convidar a mudar de assunto), e com ações pendentes na tela os atalhos
            // seriam uma segunda fileira de botões parecidos com a primeira, fazendo outra coisa (a mesma
            // invariante que hitl/ask.ts aplica ao bloco do agente). Nada urgente ⇒ eles são a única oferta.
            ...(seed || actions.length
              ? {}
              : { suggestions: ["Qual o status do board?", "O que eu deveria fazer agora?", "O que travou?"] }),
          } as HitlTurn,
        ]);
        setContext(res.context); // set LAST → the render that mounts CopilotThread already has the greeting
      })
      .catch((e) => {
        // 2.5 — a action é fail-safe NO SERVIDOR, mas a PONTE (rede / serialização do Server Action) pode
        // rejeitar → sem .catch, "Lendo o board…" ficava ETERNO, sem erro nem retry. Mostra erro + retry.
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Falha ao carregar o board.");
      });
    return () => {
      alive = false;
    };
  }, [boardId, boardName, attempt, seed]);

  // ESC closes — only when the host actually offers a way out (the docked rail doesn't).
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // req5 — o pareamento reflete ENGAJAMENTO ATIVO, não "o painel está montado na tela". Antes, ABRIR o painel já
  // adquiria o lease → o tick recuava ("Fiquei de fora: você está no comando") só porque o único chat que existe
  // estava visível, mesmo sem nenhuma interação — ligar "agir" não fazia o Jido agir. Agora o lease é
  // adquirido no ENVIO (CopilotThread.getContext, por turno) e renovado a cada mensagem; com o TTL de 15min, o
  // painel aberto-e-ocioso solta o tick sozinho. Só SOLTAMOS ao fechar (o tick retoma na hora quando você sai,
  // sem esperar o TTL). Best-effort. A trava contra tick × turno pareado na sessão compartilhada é o 409 do lado
  // do turno (o run em voo bloqueia — não é morto — e a mensagem é preservada).
  useEffect(() => {
    return () => {
      void releaseCopilotLeaseAction(boardId);
    };
  }, [boardId]);

  return (
    // SEM header. O painel é conversa da primeira à última linha.
    //
    // O que morava lá em cima: o nome "Jido" e a palavra de estado ("dormindo") — os dois já são o MASCOTE no
    // topnav da aplicação, que fica visível o tempo todo e agora também fala; repeti-los aqui era moldura
    // dizendo o que a tela inteira já diz. E os CONTROLES (modo + engrenagem), que desceram para a barra de
    // ações do composer, junto do anexo e do anel de contexto: o que se opera fica na mão, não na testa.
    <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="min-h-0 flex-1">
          {/* Os dois estados de espera são TEXTO, não rosto: o mascote mora no topnav e já reage lá em cima —
              um rosto de 92px no meio do painel duplicaria o mesmo sinal a 40px de distância do original. */}
          {error && context === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <p className={cn("font-medium text-fg", TXT.body)}>Não consegui ler o board.</p>
              <p className={cn("max-w-xs text-fg-muted", TXT.meta)}>{error}</p>
              <button
                onClick={() => {
                  setError(null);
                  setAttempt((a) => a + 1);
                }}
                className={cn(BTN_GHOST, "mt-1 border border-line text-fg")}
              >
                Tentar de novo
              </button>
            </div>
          ) : context === null ? (
            <div className="flex h-full flex-col items-center justify-center">
              <p className={cn("text-fg-subtle", TXT.meta)}>Lendo o board…</p>
            </div>
          ) : (
            <CopilotThread
              context={context}
              greeting={greeting}
              boardId={boardId}
              openQuestions={openQuestions}
              pendingApprovals={pendingApprovals}
              onSignals={setTurnSignals}
              autonomousRunning={Boolean(boardSignals.autonomousRunning)}
              // O diário só faz sentido onde o Jido AGE sozinho. `level` vem do mesmo read-model dos
              // controles: "off" é o estado Chat (ele não age sem você) ⇒ sem faixa. Undefined = ainda
              // carregando ⇒ também sem faixa, para ela não piscar na tela em toda abertura.
              autonomous={Boolean(boardSignals.level && boardSignals.level !== "off")}
              seedInstruction={seedInstruction}
              seedItemContext={itemContext}
              // Os controles do board (modo + ajustes) — montados aqui porque é este componente que conhece
              // o board. Eles vão para a barra do TOPO: o modo é o que governa a conversa inteira (o que o
              // Jido faz sem você), e essa decisão pertence a onde a leitura começa, não à mão que digita.
              // `placement="down"` porque um popover ancorado no topo tem de abrir para baixo.
              controls={<CopilotChatControls boardId={boardId} placement="down" onStatus={handleStatus} />}
              onClose={onClose}
            />
          )}
        </div>
    </div>
  );
}

/**
 * O DRAWER de sempre — a casca overlay em volta do {@link CopilotChatPanel}. Assinatura preservada
 * (`open`/`onClose` obrigatórios) para as ~18 views que o montam pelo BoardHeader não mudarem nada.
 *
 * `open=false` DESMONTA o painel (em vez de escondê-lo): é o desmonte que solta o lease de pareamento
 * e para o poll da sessão — um painel fechado-mas-montado seguraria o tick achando que você está no
 * comando.
 */
export function CopilotChat({
  boardId,
  boardName,
  open,
  onClose,
  seed,
}: {
  boardId: string;
  boardName: string;
  open: boolean;
  onClose: () => void;
  seed?: CopilotSeed;
}) {
  if (!open) return null;
  return (
    <div
      // A gaveta começa ABAIXO do topnav (`--ah-topbar-h`, publicada pelo TopBar), não em `inset-0`.
      // Com o mascote morando só na barra, um backdrop escuro+borrado por cima dela apagava a única cara
      // do Jido exatamente enquanto ele trabalha — e "sempre visível no topnav" deixava de ser verdade na
      // hora que mais importa. Agora a faixa do topo fica nítida (e alcançável: dá para trocar de board ou
      // de seção sem fechar a conversa) e o escurecimento cobre só o que a gaveta de fato substitui.
      // Fallback `0px`: sem a variável (SSR, ou um host que não monte o TopBar) é o comportamento antigo.
      className="fixed inset-x-0 bottom-0 top-[var(--ah-topbar-h,0px)] z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Jido do board"
    >
      <button className="absolute inset-0 bg-black/40 backdrop-blur-sm" aria-label="Fechar" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-line shadow-2xl">
        <CopilotChatPanel boardId={boardId} boardName={boardName} onClose={onClose} seed={seed} />
      </div>
    </div>
  );
}

/**
 * O COCKPIT do board sobre o núcleo compartilhado ({@link ChatPanel}).
 *
 * A conversa em si — mascote, anel de contexto, comandos de barra, histórico, fila, anexos — não mora mais aqui:
 * ela é a MESMA de toda tela, e este componente é só o que o board tem A MAIS. Sobrou exatamente isso:
 *   • o CONTEXTO do board (re-lido a cada turno) e a renovação do lease de pareamento;
 *   • o SEED de escalação (prefill do composer + o bloco "## Item escalado" dentro do <contexto>);
 *   • as APROVAÇÕES e as PERGUNTAS de card, que ele trata interceptando o envio;
 *   • os sinais de rosto que só o board tem (quantas aprovações esperam, o risco mais alto, a reação à decisão);
 *   • a tarja do ciclo autônomo, o diário do tick e os controles de modo/ajustes — todos slots.
 *
 * Nada aqui sabe desenhar uma bolha. Se algo do chat precisar mudar, muda no núcleo e chega às duas telas.
 */
function CopilotThread({
  context,
  greeting,
  boardId,
  openQuestions,
  pendingApprovals,
  onSignals,
  autonomousRunning,
  autonomous,
  seedInstruction,
  seedItemContext,
  controls,
  onClose,
}: {
  context: string;
  greeting: HitlTurn[];
  boardId: string;
  openQuestions: OpenQuestionRef[];
  pendingApprovals: CopilotApprovalRef[];
  /** o que o TURNO sente, para o rosto lá no header (o thread é quem enxerga o hook). */
  onSignals: (s: FaceSignals) => void;
  /** WS-4.2 — um ciclo AUTÔNOMO (tick) está em voo neste board (do overview) → mostra o aviso persistente. */
  autonomousRunning?: boolean;
  /** o board está em modo autônomo (qualquer grau) → a faixa do diário existe. Em Chat, não. */
  autonomous?: boolean;
  /** WS-1 — instrução pré-preenchida do composer (null ⇒ sem escalação). */
  seedInstruction?: string | null;
  /** WS-1 — bloco "## Item escalado" injetado DENTRO do <contexto> (D5/invariante 7). */
  seedItemContext?: string | null;
  /** os controles do board (modo + ajustes), renderizados na barra de ações do composer. */
  controls?: React.ReactNode;
  /** presente ⇒ o host oferece saída: o ✕ entra na barra do composer (o painel não tem mais header). */
  onClose?: () => void;
}) {
  // WS-1 (D4) — seed lifecycle: prefill the composer, inject the item context into <contexto>, consume the seed
  // on the first completed turn. ALL additive — no seed ⇒ inert.
  const seedActiveRef = useRef(Boolean(seedInstruction));
  const [draft] = useState<{ text: string; nonce: number } | undefined>(
    seedInstruction ? { text: seedInstruction, nonce: 1 } : undefined,
  );

  // 3.4 — re-busca o contexto do board antes de CADA turno (o board se move sozinho enquanto o chat fica aberto:
  // runs terminam, cards andam, perguntas são respondidas). O RETORNO é o que o turno usa.
  const getContext = useCallback(async () => {
    void acquireCopilotLeaseAction(boardId); // 6.4 — renova o lease humano a cada turno (o tick fica de fora)
    const board = (await copilotContextAction(boardId)).context;
    // D5/invariante 7 — o item-context viaja DENTRO do <contexto> do composeCopilotPrompt, nunca na instrução.
    return seedActiveRef.current && seedItemContext ? `${board}\n\n${seedItemContext}` : board;
  }, [boardId, seedItemContext]);

  // ── O QUE SÓ O BOARD SENTE ─────────────────────────────────────────────────────────────────────────────
  // As aprovações que você já decidiu somem da conta na hora: a lista veio do fetch de abertura e não se
  // atualiza sozinha — sem isto o rosto ficaria eternamente surpreso depois de você aprovar tudo.
  const [decided, setDecided] = useState<ReadonlySet<string>>(() => new Set());
  // Reação à SUA decisão, transitória: aprovou → ele se derrete; rejeitou → ele murcha. Passa em 3,5s.
  const [reaction, setReaction] = useState<"delighted" | "dejected" | null>(null);
  useEffect(() => {
    if (!reaction) return;
    const t = setTimeout(() => setReaction(null), 3500);
    return () => clearTimeout(t);
  }, [reaction]);

  const waiting = pendingApprovals.filter((a) => !decided.has(a.id));
  const nWaiting = waiting.length;
  const risk = scariestRisk(waiting.map((a) => a.riskClass));

  // O núcleo entrega o que o TURNO sente; o board soma o que só ele sabe e repassa ao rosto do topnav. É por
  // esta costura que o mascote continua sendo UM só: quem monta o painel é quem fala pelo rosto.
  const [turnSignals, setTurnSignals] = useState<FaceSignals>({});
  const boardSignals = useMemo<FaceSignals>(
    () => ({
      ...turnSignals,
      pendingApprovals: nWaiting,
      topRisk: risk,
      delighted: reaction === "delighted",
      dejected: reaction === "dejected",
    }),
    [turnSignals, nWaiting, risk, reaction],
  );
  useEffect(() => {
    onSignals(boardSignals);
  }, [boardSignals, onSignals]);

  // 3.1 — quando não-null, o chat está em "modo resposta" de UMA pergunta de card (o próximo input responde-a).
  const [answering, setAnswering] = useState<OpenQuestionRef | null>(null);

  const submitAnswer = async (api: ChatSendApi, ref: OpenQuestionRef, text: string, chipIds?: string[]) => {
    const selectedOptionIds = chipIds ? mapBackAnswerIds(chipIds) : undefined;
    // eco LOCAL da resposta do humano (o Jido não decide — o humano decide) + confirmação.
    api.pushTurns([{ role: "human", text: text.trim() || "(opção escolhida)", selectedOptionIds: chipIds }]);
    // MESMA action da fila /perguntas — uma resposta = mesma semântica nas duas superfícies (sem 2º caminho).
    const res = await answerQuestionAction({
      boardId,
      cardId: ref.cardId,
      questionId: ref.question.id,
      answer: text,
      selectedOptionIds,
    });
    api.pushTurns([
      {
        role: "agent",
        message: res.ok
          ? `✔ Respondida — a cascata do card **${ref.cardId}** segue.`
          : `Não consegui gravar a resposta: ${res.error}`,
      },
    ]);
    setAnswering(null);
  };

  // F5.8 — grava a decisão do humano sobre uma aprovação pendente do Jido (aprovar/rejeitar), com eco local.
  const decideApproval = async (api: ChatSendApi, approvalId: string, grant: boolean) => {
    // Sai da fila do rosto AGORA (ele para de pedir) e ele reage à sua decisão.
    setDecided((prev) => new Set(prev).add(approvalId));
    setReaction(grant ? "delighted" : "dejected");
    api.pushTurns([{ role: "human", text: grant ? `aprovar ${approvalId}` : `rejeitar ${approvalId}` }]);
    const res = await (grant ? approveActionRequestAction : rejectActionRequestAction)({ boardId, approvalId });
    if (!res.ok) {
      // A decisão NÃO foi registrada: a ação continua pendente de verdade → devolve para a fila (o rosto volta
      // a pedir). Sem isto, um erro de escrita deixaria o operador achando que já resolveu.
      setDecided((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
      setReaction(null);
    }
    api.pushTurns([
      {
        role: "agent",
        message: res.ok
          ? grant
            ? `✔ Aprovado — o Jido pode prosseguir com a ação (${approvalId}).`
            : `✖ Rejeitado — a ação (${approvalId}) não vai rodar.`
          : `Não consegui registrar a decisão: ${res.error}`,
      },
    ]);
  };

  /**
   * O que o COCKPIT trata antes do modelo: as ações do greeting, as decisões de aprovação e as perguntas de card.
   * Devolver `true` = "tratei isto" — o núcleo não manda nada ao agente.
   */
  const onIntercept = (
    { text, ids }: { text: string; ids?: string[]; images?: string[] },
    api: ChatSendApi,
  ): boolean => {
    // (0) F6.2/6.3/5.8 — as ações do greeting (sem parede de chips) + as decisões de aprovação inline.
    if (!answering && ids?.length === 1) {
      const id = ids[0];
      if (id === "__review_approvals") {
        // F5.8 — só AGORA (após um toque) cada aprovação vira um turno com chips Aprovar/Rejeitar.
        api.pushTurns([
          { role: "human", text: "revisar aprovações" },
          ...(pendingApprovals.length
            ? pendingApprovals.map((a) => ({
                role: "agent" as const,
                message: `O copiloto pede permissão: **${a.tool}** (${a.riskClass})${a.cardId ? ` no card ${a.cardId}` : ""}.`,
                options: [
                  { id: `apr-grant:${a.id}`, label: "Aprovar ação" },
                  { id: `apr-reject:${a.id}`, label: "Rejeitar" },
                ],
                mode: "single" as const,
              }))
            : [{ role: "agent" as const, message: "Nenhuma aprovação pendente agora." }]),
        ]);
        return true;
      }
      if (id.startsWith("apr-grant:")) {
        void decideApproval(api, id.slice("apr-grant:".length), true);
        return true;
      }
      if (id.startsWith("apr-reject:")) {
        void decideApproval(api, id.slice("apr-reject:".length), false);
        return true;
      }
      if (id === "__answer_questions") {
        // F6.2 — só AGORA (após um toque) as perguntas individuais viram chips — não na abertura.
        const chips = questionChipOptions(openQuestions);
        api.pushTurns([
          { role: "human", text: "responder perguntas" },
          {
            role: "agent",
            message: chips.length ? "Toque numa pergunta para respondê-la aqui:" : "Nenhuma pergunta em aberto agora.",
            options: chips.length ? chips : undefined,
            mode: "single",
          },
        ]);
        return true;
      }
      if (id === "__copilot_answer") {
        // F6.3 (paired) — o Jido (full-level, com tools) apura os FATOS e responde via answer_question;
        // decisões de produto ficam para o humano. Um turno agêntico normal, com a instrução explícita.
        api.send(
          "Investigue as perguntas em aberto deste board (listadas no contexto). Para CADA uma decida: a resposta é um FATO que você consegue apurar no código/dados/print, ou é uma DECISÃO de produto/design (trade-off)? Para os FATOS: apure com evidência e responda a pergunta via a tool answer_question. Para as DECISÕES: NÃO responda — deixe aberta. Ao fim, resuma o que respondeu (com a evidência) e o que ficou para mim decidir e por quê.",
        );
        return true;
      }
    }
    // (a) fora do modo resposta + clicou num chip de PERGUNTA → entra em modo resposta daquela pergunta.
    if (!answering && ids?.length) {
      const qc = ids.map(parseQuestionChipId).find((x): x is { cardId: string; questionId: string } => x != null);
      const ref = qc ? openQuestions.find((o) => o.cardId === qc.cardId && o.question.id === qc.questionId) : undefined;
      if (ref) {
        setAnswering(ref);
        const ans = answerOptionsFor(ref.question);
        api.pushTurns([
          { role: "human", text: `responder ${ref.cardId}` },
          {
            role: "agent",
            message:
              `**${ref.cardId}** — ${ref.question.text}` +
              (ref.question.context ? `\n\n${ref.question.context}` : "") +
              (ref.question.recommendation ? `\n\n_Sugestão: ${ref.question.recommendation}_` : ""),
            options: ans?.options,
            mode: ans?.mode ?? "single",
            // É PERGUNTA, não menu de ações: a resposta aberta é uma escolha legítima (e a lista de um card
            // quase nunca é exaustiva).
            openAnswer: true,
          },
        ]);
        return true; // não chama o LLM — o humano responde a pergunta do card
      }
    }
    // (b) em modo resposta → grava a resposta (chip OU texto livre) pela action da fila /perguntas.
    if (answering) {
      void submitAnswer(api, answering, text, ids);
      return true;
    }
    return false; // (c) turno normal — o núcleo cuida
  };

  return (
    <ChatPanel
      boardId={boardId}
      label="Jido do board"
      context={context}
      greeting={greeting}
      getContext={getContext}
      placeholder={answering ? "Responda a pergunta acima…" : "Pergunte ou instrua o Jido…"}
      draft={draft}
      // `tickRunning` acelera o poll near-live: enquanto o ciclo autônomo escreve na sessão COMPARTILHADA, o
      // trabalho dele chega ao painel no ritmo do poll — 5s é o ritmo de fundo, não o de assistir alguém trabalhar.
      tickRunning={autonomousRunning}
      onSignals={setTurnSignals}
      onIntercept={onIntercept}
      onClose={onClose}
      slots={{
        // WS-4.2 — aviso PERSISTENTE de ciclo autônomo EM VOO. Com os dois slots de lease independentes, um run
        // autônomo iniciado ANTES de o operador parear continua terminando enquanto o chat está aberto; ele
        // precisa VER isso explicitamente e ter um caminho para cancelá-lo.
        banner: autonomousRunning ? (
          // `accent` + o ponto pulsando: o âmbar é reservado ao que está VIVO agora (ver copilot/ui.ts).
          <NoticeBand tone="accent" pulse>
            <span>
              Um ciclo autônomo está rodando neste board agora — acompanhe no diário abaixo ou{" "}
              <a href="/processes" target="_blank" rel="noreferrer" className="font-medium text-fg underline underline-offset-2">
                cancele em Processos
              </a>
              .
            </span>
          </NoticeBand>
        ) : null,
        controls,
        // O diário do Jido autônomo: faixa de uma linha ancorada acima do composer, e só quando o board está em
        // modo autônomo. TODA decisão dele continua a um toque; o que ele deixou de fazer é roubar 60px
        // permanentes do transcript num modo (Chat) em que ele nem age sozinho.
        beforeComposer: autonomous ? <CopilotActivityFeed boardId={boardId} /> : null,
        // O ciclo autônomo trabalhando, VISÍVEL no corpo — o banner do topo diz que ele existe; esta linha fica
        // onde o trabalho dele aparece (os turnos que o poll near-live adota), e some quando ele termina.
        systemWorking: autonomousRunning ? "o Jido está trabalhando sozinho…" : null,
      }}
    />
  );
}
