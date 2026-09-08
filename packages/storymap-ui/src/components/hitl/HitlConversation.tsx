"use client";

// <HitlConversation> — o chat HITL estilo terminal, SHELL-AGNÓSTICO (sem overlay/posição). Renderiza o
// transcript (auto-scroll p/ o último turno), os quick-replies (OptionChips) do último turno do agente, o
// input (auto-focado, ⌘/Ctrl+Enter), o toggle de modo curto/padrão e o estado "pensando" (com cancelar).
// Controlado pelo useHitl (o host injeta os handlers). Em single-select, escolher um quick-reply ENVIA na
// hora (1 toque resolve, estilo terminal).
//
// LAYOUT: `compact` (default) — bloco fluido que herda o padding do shell (HitlSurface p-3 nos popovers);
// `full` — assume a altura toda do host (drawer/rail do Jido). O compact preserva o layout antigo
// byte-a-byte (os popovers dependem dele); TODA a gramática de chat moderno abaixo vale só no `full`:
//
//   • O AGENTE não fala em bolha. A resposta dele ocupa a largura toda, como texto (ver FLOW_PROSE em
//     copilot/ui.ts para o porquê); o OPERADOR continua em bolha, à direita. É a divisão a que Claude,
//     ChatGPT e Gemini convergiram — e a que faz o painel ler como documento vivo, não como mensageiro.
//   • O texto ENTRA animado, por bloco (`jido-stream`), e o MASCOTE escreve LOGO ABAIXO do último bloco
//     de texto (`streamCursor`) — o mesmo rosto do topnav, no mesmo tamanho.
//   • Os COMANDOS moram DENTRO do campo: campo, anexos e ações são uma caixa só (COMPOSER_BOX).
//   • O que governa a conversa (modo do Jido, ajustes, sair) fica no TOPO, numa barra flutuante com
//     degradê (`topBar`) — o transcript passa por baixo dela em vez de ser cortado por uma régua.
//   • As ESCOLHAS ficam ancoradas ao turno que as pediu (AskChoices), não soltas acima do composer.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  Loader2,
  SquareSlash,
  SquareTerminal,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { OptionChips } from "@/components/hitl/OptionChips";
import { AskChoices } from "@/components/hitl/AskChoices";
import { SlashMenu } from "@/components/hitl/SlashMenu";
import { Markdown } from "@/components/Markdown";
import {
  BTN_GHOST,
  BTN_ICON,
  BTN_SOLID,
  BUBBLE,
  CHIP,
  COMPOSER_BOX,
  FIELD,
  FIELD_BARE,
  FLOW_PROSE,
  GUTTER,
  ICON,
  TOP_BAR_CLEARANCE,
  TOP_FADE,
  TXT,
} from "@/components/copilot/ui";
import { agentTurnView, type AskSpec } from "@/lib/storymap/hitl/ask";
import { completionFor, exactCommand, filterCommands, slashQuery, type SlashCommand } from "@/lib/storymap/hitl/slash";
import type {
  HitlActivity,
  HitlAgentTurn,
  HitlNoticeTurn,
  HitlResponseMode,
  HitlSegment,
  HitlTurn,
} from "@/lib/storymap/hitl/types";

/** req 4 — a que distância do fim (px) ainda contamos o operador como "ancorado no fim" (segue o streaming). */
const NEAR_BOTTOM_PX = 80;

/** Rótulo curto de uma tool p/ o chip: mcp__storymap__get_card → "get_card", Bash → "bash". Pura. */
function toolLabel(tool: string): string {
  if (tool.startsWith("mcp__")) return tool.split("__").pop() || tool;
  return tool.toLowerCase();
}

// F1.4b — chips de ATIVIDADE do turno agêntico (tools executadas ao vivo). Um chip de terminal (F2 emite
// terminalUrl) vira LINK p/ /terminal?b=<session> (window.open — /terminal é documento estático, fora do App Router). >6 colapsam em "+N".
function ActivityChips({ activity }: { activity: HitlActivity[] }) {
  const shown = activity.slice(0, 6);
  const extra = activity.length - shown.length;
  return (
    <div className="flex max-w-[92%] flex-wrap gap-1">
      {shown.map((a, i) => {
        const label = `${toolLabel(a.tool)}${a.summary ? ` · ${a.summary}` : ""}`;
        const base = cn(CHIP, "max-w-[240px] transition");
        const inner = (
          <>
            {a.terminalUrl ? <SquareTerminal className={ICON.inline} /> : <Wrench className={ICON.inline} />}
            <span className="truncate">{label}</span>
          </>
        );
        return a.terminalUrl ? (
          <button
            key={i}
            type="button"
            onClick={() => window.open(a.terminalUrl!, "_blank", "noopener")}
            className={cn(base, "bg-accent/20 text-fg")}
            title={`Abrir terminal — ${label}`}
            data-terminal={a.terminalUrl}
          >
            {inner}
          </button>
        ) : (
          <span key={i} className={base} title={label}>
            {inner}
          </span>
        );
      })}
      {extra > 0 && (
        <span className={CHIP}>+{extra}</span>
      )}
    </div>
  );
}

// F1-refino — UMA tool call INLINE (estilo Claude Code): pill com status vivo (running/done/erro) + summary,
// clicável para EXPANDIR input/output sem poluir a leitura. Terminal (F2) ganha o link p/ /terminal.
function CopilotToolStep({ seg }: { seg: Extract<HitlSegment, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const label = `${toolLabel(seg.name)}${seg.summary ? ` · ${seg.summary}` : ""}`;
  const statusIcon =
    seg.status === "running" ? (
      <Loader2 className={cn(ICON.inline, "animate-spin text-accent")} />
    ) : seg.status === "error" ? (
      <X className={cn(ICON.inline, "text-rose-500")} />
    ) : (
      <Check className={cn(ICON.inline, "text-emerald-500")} />
    );
  const hasDetail = !!(seg.input || seg.output != null || seg.terminalUrl);
  return (
    <div className="w-full max-w-[92%]">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((o) => !o)}
        className={cn(
          CHIP,
          "max-w-full transition",
          seg.terminalUrl && "bg-accent/20 text-fg",
          hasDetail && "hover:bg-fg/[0.09] hover:text-fg",
        )}
        title={label}
      >
        {statusIcon}
        {seg.terminalUrl ? <SquareTerminal className={ICON.inline} /> : <Wrench className={ICON.inline} />}
        <span className="truncate">{label}</span>
        {hasDetail && <ChevronRight className={cn(ICON.inline, "transition", open && "rotate-90")} />}
      </button>
      {open && hasDetail && (
        <div className={cn("mt-1.5 space-y-2 rounded-lg bg-fg/[0.05] px-2.5 py-2 text-fg-muted", TXT.meta)}>
          {seg.input && (
            <div>
              <span className="text-fg-subtle">input</span>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-fg-muted">{seg.input}</pre>
            </div>
          )}
          {seg.output != null && seg.output !== "" && (
            <div>
              <span className="text-fg-subtle">output</span>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-fg-muted">{seg.output}</pre>
            </div>
          )}
          {seg.terminalUrl && (
            <button
              type="button"
              onClick={() => window.open(seg.terminalUrl!, "_blank", "noopener")}
              className="font-medium text-accent hover:underline"
            >
              abrir terminal →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * O CORPO de uma resposta do agente — os segmentos INLINE na ordem exata (texto e tools intercalados).
 *
 * `flow` decide a FORMA do texto: largura cheia sem bolha (o painel do Jido — ver FLOW_PROSE) ou a bolha
 * densa de sempre (os popovers HITL, que são caixinhas de 300px onde uma bolha ainda é a leitura certa).
 *
 * `cursor` é o mascote que ESCREVE: ele entra ABAIXO do último bloco de texto — e só enquanto o turno está
 * vivo e a última coisa que saiu é TEXTO (quando a última coisa é uma tool, o que está vivo ali é a pill
 * dela, não o texto).
 *
 * Ele já morou DENTRO do último parágrafo, como um caractere no fim da linha — o que exigia um plugin de
 * rehype para pendurar um sentinela no último nó de texto, e o obrigava a ser miúdo (15px) para não virar um
 * segundo assunto no meio da frase. Nesse tamanho ele não era mais o mascote: era um borrão. Hoje ele é o
 * MESMO rosto do topnav, no mesmo tamanho, numa linha própria logo abaixo do texto — quem está escrevendo
 * fica reconhecível, e o parágrafo volta a ser só parágrafo.
 */
function AgentSegments({
  segments,
  flow,
  cursor,
}: {
  segments: HitlSegment[];
  flow: boolean;
  /** presente ⇒ o turno está VIVO: o mascote entra abaixo do texto (se o texto for a última coisa). */
  cursor?: ReactNode;
}) {
  const last = segments[segments.length - 1];
  return (
    <div className="flex w-full flex-col items-start gap-1.5">
      {segments.map((s) =>
        s.type === "tool" ? (
          <CopilotToolStep key={s.segId} seg={s} />
        ) : s.text.trim() ? (
          <AgentProse key={s.segId} text={s.text} flow={flow} />
        ) : null,
      )}
      {cursor && last?.type === "text" && cursor}
    </div>
  );
}

/** UM bloco de prosa do agente — a única definição de "como o texto do agente é pintado". */
function AgentProse({ text, flow }: { text: string; flow: boolean }) {
  // Bolha de chat = superfície DENSA: variante `compact` (a `doc`, default, é a escala de leitura do
  // documento — 15.5px e headings de 26px não cabem num painel de 492px).
  const md = <Markdown variant="compact">{text}</Markdown>;
  if (flow) return <div className={FLOW_PROSE}>{md}</div>;
  return (
    <span className={cn(BUBBLE, "rounded-bl-md bg-inset")}>
      <div
        className={cn(
          "[&_*]:text-[13px]",
          "[&_p]:my-0 [&_ul]:my-1 [&_ol]:my-1 [&_pre]:my-1 [&_>div>*:first-child]:mt-0 [&_>div>*:last-child]:mb-0",
        )}
      >
        {md}
      </div>
    </span>
  );
}

/**
 * Um EVENTO no meio da conversa. Nem bolha à direita nem bolha à esquerda — uma linha CENTRADA e discreta,
 * entre filetes: ninguém falou, algo ACONTECEU. Dois produtores hoje: o tick acordando sozinho (`tick`) e o
 * operador rodando um comando de barra (`command`).
 *
 * O ícone vem do `kind`, NUNCA de regex no texto: o texto é copy (muda quando alguém reescreve a frase) e
 * casar comportamento com copy é uma bomba-relógio — a mesma regra que o `code` dos frames SSE segue.
 */
function NoticeLine({ text, kind }: { text: string; kind: HitlNoticeTurn["kind"] }) {
  const Icon = kind === "command" ? SquareSlash : Zap;
  return (
    <div className="flex items-center gap-2 py-0.5" role="separator">
      {/* `min-w-3`: os filetes são `flex-1`, e um aviso comprido (o de "conversa nova" tem 60 caracteres)
          consumia a linha inteira até os dois sumirem — sem eles não sobra separador nenhum, só um ícone
          solto com um parágrafo ao lado, que é como o defeito aparecia na tela. Um mínimo garantido faz a
          forma de separador sobreviver ao texto que a preenche. */}
      <span className="h-px min-w-3 flex-1 bg-line" />
      {/* `items-start` + o texto num nó próprio: quando ele quebra em duas linhas, o ícone acompanha a
          PRIMEIRA (centrado, ele flutuava no meio do bloco, como se marcasse a segunda). */}
      <span className={cn("flex min-w-0 shrink items-start gap-1.5 text-center leading-snug text-fg-subtle", TXT.meta)}>
        <Icon className={cn(ICON.inline, "mt-px text-accent")} />
        <span className="min-w-0">{text}</span>
      </span>
      <span className="h-px min-w-3 flex-1 bg-line" />
    </div>
  );
}

/**
 * O tick TRABALHANDO agora, no CORPO da conversa. O aviso de ciclo autônomo já existia — mas como banner no topo
 * do painel, longe do olhar e mudo sobre o que ele estava FAZENDO; o "pensando…" só nascia do turno do operador,
 * então um ciclo autônomo rodava com o thread visualmente parado. Aqui ele ganha a mesma gramática do turno do
 * operador (spinner no fim do transcript), no lugar onde o trabalho dele aparece quando chega.
 */
function TickWorkingLine({ label }: { label: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-fg-muted", TXT.label)}>
      <Loader2 className={cn(ICON.inline, "animate-spin text-accent")} />
      <span className="animate-pulse">{label}</span>
    </div>
  );
}

/**
 * O "pensando…" DENTRO da conversa (estilo Claude Code): spinner + cronômetro + cancelar, no fim do transcript.
 * O cronômetro é o que muda a sensação — sem ele, um turno de 90s é indistinguível de um travado.
 */
function ThinkingLine({ onCancel, quiet }: { onCancel?: () => void; quiet?: boolean }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // QUIETO = o texto já está saindo e o MASCOTE está lá no fim dele dizendo isso. Um "pensando… 13s"
  // logo abaixo seria o mesmo recado dito duas vezes, a dois centímetros de distância — e o cronômetro,
  // que existe para distinguir "demorado" de "travado", não informa nada quando você está vendo as
  // palavras aparecerem. Fica só a saída: cancelar.
  if (quiet) {
    return onCancel ? (
      <div className="flex w-full justify-end">
        <button type="button" onClick={onCancel} className={cn(BTN_GHOST, "text-fg-subtle")} title="Cancelar este turno">
          cancelar
        </button>
      </div>
    ) : null;
  }
  return (
    <div className={cn("flex items-center gap-2 text-fg-muted", TXT.label)}>
      <Loader2 className={cn(ICON.inline, "animate-spin text-accent")} />
      <span className="animate-pulse">pensando…</span>
      <span className="tabular-nums text-fg-subtle">{secs}s</span>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className={cn(BTN_GHOST, "ml-auto")}
          title="Cancelar este turno"
        >
          cancelar
        </button>
      )}
    </div>
  );
}

export function HitlConversation({
  turns,
  status,
  error,
  responseMode,
  setResponseMode,
  onSend,
  onCancel,
  onAttachImages,
  onLoadOlder,
  hasOlder,
  done,
  title,
  placeholder,
  className,
  layout = "compact",
  afterTurns,
  beforeComposer,
  composerExtra,
  topBar,
  streamCursor,
  commands,
  onCommand,
  showModeToggle = true,
  draft,
  systemWorking,
  queueWhileBusy = false,
  scrollKey,
}: {
  turns: HitlTurn[];
  status: "idle" | "typing" | "error";
  error: string | null;
  responseMode: HitlResponseMode;
  setResponseMode: (m: HitlResponseMode) => void;
  onSend: (text: string, selectedOptionIds?: string[], images?: string[]) => void;
  /** cancela o turno em voo (volta a ocioso, ignora a resposta tardia). */
  onCancel?: () => void;
  /** F4 (opt-in — só o Jido) — faz upload dos arquivos e devolve os paths absolutos p/ o turno. Presente
   *  ⇒ habilita colar/arrastar/anexar imagem no composer. Ausente ⇒ consumidores velhos: composer inalterado. */
  onAttachImages?: (files: File[]) => Promise<string[]>;
  /** Persistência do histórico: carrega a página de turnos mais ANTIGA (prepend). Presente só quando há mais. */
  onLoadOlder?: () => void | Promise<void>;
  /** há páginas mais antigas no servidor → mostra "carregar mais antigas" no topo do transcript. */
  hasOlder?: boolean;
  done: unknown | null;
  title?: string;
  placeholder?: string;
  /** 2.3 — o HOST controla a altura do root: os popovers passam `max-h-[60vh]`, o drawer full-height do
   *  copiloto passa `h-full`. Era hard-coded `max-h-[60vh]` (vazava o layout de popover para o drawer). */
  className?: string;
  /** `full` = drawer full-height (padding próprio + composer pinado num rodapé). `compact` = bloco fluido
   *  que herda o padding do shell (popovers). Default compact — não regride os consumidores existentes. */
  layout?: "compact" | "full";
  /** Slot renderizado DENTRO do transcript, depois do último turno (o Jido usa p/ o diário de decisões do
   *  tick autônomo). Fica no corpo do chat, não num painel à parte — é conversa, não configuração. */
  afterTurns?: ReactNode;
  /** Slot FIXO entre o transcript e o composer (o Jido usa p/ a faixa do diário autônomo). Diferente de
   *  `afterTurns`, que rola COM as mensagens: o que entra aqui não é conversa e não some da vista quando o
   *  operador rola para cima — ele fica ancorado no rodapé e o transcript encolhe. Ausente ⇒ nada muda. */
  beforeComposer?: ReactNode;
  /** Slot na BARRA DE AÇÕES do composer, ao lado do anexo (o Jido usa p/ o ⋯ da conversa). O host decide o
   *  que é raro o bastante para morar num menu — este componente não sabe (nem precisa saber) o que é. */
  composerExtra?: ReactNode;
  /**
   * Barra FLUTUANTE no topo do transcript (só no `full`): o que governa a conversa inteira — o modo do
   * Jido, os ajustes, a saída. Ela é opaca e o conteúdo passa POR BAIXO dela através de um degradê
   * (TOP_FADE), em vez de ser cortado por uma régua: o painel continua sendo conversa da primeira à
   * última linha, mas com o controle mais consequente onde o olho começa a ler. Ausente ⇒ nada muda.
   */
  topBar?: ReactNode;
  /**
   * O que aparece enquanto o agente escreve (o mascote do Jido), numa linha PRÓPRIA logo abaixo do último
   * bloco de texto do turno vivo.
   *
   * MEMOIZE no host (por humor): identidade nova a cada token remonta o nó e reinicia a animação a cada
   * letra. Ausente ⇒ sem mascote (os popovers HITL).
   */
  streamCursor?: ReactNode;
  /**
   * Os COMANDOS DE BARRA disponíveis neste chat (`/clear`, `/compact`, `/context` no painel do Jido).
   * Este componente só desenha e navega a paleta — o que cada um FAZ é do host, via {@link onCommand}.
   * MEMOIZE (ou declare no módulo): a lista entra em derivações de render. Ausente ⇒ digitar `/` é texto
   * comum, e os popovers HITL seguem exatamente como eram.
   */
  commands?: readonly SlashCommand[];
  /** roda o comando escolhido (o host conhece a sessão, o board e o CLI). Recebe o `name`, sem a barra. */
  onCommand?: (name: string) => void;
  /** false = o host cuida da verbosidade (o Jido a moveu para dentro do ⋯). Default true — não regride os
   *  outros consumidores, que não têm menu nenhum. */
  showModeToggle?: boolean;
  /** WS-1 (D4) — one-shot prefill do composer: aplica `text` quando `nonce` muda (NÃO é controlled input —
   *  o usuário edita livremente depois). Ausente ⇒ consumidores atuais inalterados. NUNCA auto-envia. */
  draft?: { text: string; nonce: number };
  /** Alguém que NÃO é o operador está trabalhando nesta conversa agora (o Jido usa p/ o ciclo autônomo) — o
   *  rótulo aparece como linha viva no fim do transcript. Shell-agnóstico: este componente não sabe o que é um
   *  tick, só que há trabalho em voo que não nasceu de um `send` daqui. Ausente/null ⇒ nada muda. */
  systemWorking?: string | null;
  /** O host tem FILA de saída (o Jido) ⇒ digitar e enviar continua liberado durante um turno em voo: o envio é
   *  aceito e sai quando abrir espaço. Default false — nos popovers HITL (one-shot, sem fila) enviar no meio de
   *  um turno não teria para onde ir, e o composer segue travado enquanto o agente responde. */
  queueWhileBusy?: boolean;
  /** Token OPACO: mudou ⇒ re-avalia o auto-scroll. Existe porque conteúdo do `afterTurns` (a fila de saída do
   *  Jido) cresce no fim do transcript sem passar por `turns` — sem isto, a bolha recém-enfileirada nascia logo
   *  abaixo da dobra. Este componente não sabe (nem precisa saber) o que o token significa. */
  scrollKey?: string | number;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // O composer começa com UMA linha e cresce até um teto — em vez de reservar 2 linhas de altura o tempo todo.
  // Num notebook essas ~26px eram conversa perdida em toda sessão para acomodar um texto que quase nunca vinha.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // F4 — anexos de imagem pendentes (path do servidor + preview blob local + nome), só quando onAttachImages existe.
  const [attachments, setAttachments] = useState<{ path: string; previewUrl: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [attachErr, setAttachErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // "carregar mais antigas": ao prepender turnos velhos, suprime o auto-scroll e preserva a posição visual.
  const suppressAutoScrollRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // req 4 — auto-scroll INTELIGENTE. `atBottomRef` (ref, não state → não re-renderiza a cada token) diz se o
  // operador está ANCORADO no fim. Começa true: abrir/montar cola no fim. Ele rola p/ cima p/ ler algo antigo →
  // vira false → o conteúdo novo (streaming) NÃO puxa mais a leitura; o pill "novas mensagens" avisa. Voltar ao
  // fim (ou clicar o pill) re-ancora.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const addFiles = async (files: File[]) => {
    if (!onAttachImages) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setAttachErr(null);
    setUploading(true);
    const previews = imgs.map((f) => ({ previewUrl: URL.createObjectURL(f), name: f.name }));
    try {
      const paths = await onAttachImages(imgs);
      setAttachments((prev) => [
        ...prev,
        ...paths.map((p, i) => ({ path: p, previewUrl: previews[i]?.previewUrl ?? "", name: previews[i]?.name ?? "imagem" })),
      ]);
    } catch (e) {
      previews.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setAttachErr(e instanceof Error ? e.message : "falha ao anexar a imagem");
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (i: number) => {
    setAttachments((prev) => {
      const a = prev[i];
      if (a) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((_, j) => j !== i);
    });
  };

  const busy = status === "typing";
  /** o composer está BLOQUEADO? Com fila, um turno em voo não bloqueia mais nada — só enfileira. */
  const composerLocked = busy && !queueWhileBusy;
  const full = layout === "full";

  // A ESCOLHA VIVA é a do ÚLTIMO turno do agente — e só dele. Uma pergunta de três turnos atrás já foi
  // respondida (ou abandonada); deixá-la clicável seria oferecer um botão que responde a outra conversa.
  // O índice (e não só o turno) importa porque no `full` a escolha é desenhada ANCORADA ao turno dela.
  const lastAgentIndex = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "agent") return i;
    return -1;
  }, [turns]);
  const lastAgent = lastAgentIndex >= 0 ? (turns[lastAgentIndex] as HitlAgentTurn) : undefined;
  // ...e ela morre assim que o OPERADOR fala. Sem isto, o eco da própria resposta ("Publicar agora")
  // entra no transcript e a lista de botões CONTINUA ali embaixo, convidando a responder de novo a
  // pergunta que acabou de ser respondida. Os `notice` (eventos do sistema) não contam como fala.
  const humanSpokeLast = useMemo(() => {
    for (let i = turns.length - 1; i > lastAgentIndex; i--) if (turns[i].role === "human") return true;
    return false;
  }, [turns, lastAgentIndex]);
  // A resposta pode ficar na FILA antes de virar turno (o board ocupado segura o envio). Nesse intervalo
  // o transcript não mudou — e a escolha seguiria clicável, aceitando uma segunda resposta para a mesma
  // pergunta. Marcamos localmente até o transcript se mexer, que é quando a verdade volta a ser ele.
  const [justAnswered, setJustAnswered] = useState(false);
  useEffect(() => setJustAnswered(false), [turns]);
  /** A escolha oferecida agora: do bloco ```jido-ask do agente OU dos campos do turno (ver hitl/ask.ts). */
  const ask: AskSpec | null = useMemo(
    () => (done === null && lastAgent && !humanSpokeLast ? agentTurnView(lastAgent).ask : null),
    [done, lastAgent, humanSpokeLast],
  );
  // O caminho LEGADO (popovers `compact`): as opções continuam sendo desenhadas acima do composer.
  const options = !full && done === null ? lastAgent?.options : undefined;
  const mode = ask?.mode ?? lastAgent?.mode ?? "single";
  /** O texto do agente está SAINDO agora (a última coisa do turno vivo é texto) — quem anuncia isso é o
   *  mascote no fim da linha, então o "pensando…" abaixo dele fica quieto. Ver ThinkingLine. */
  const writingText =
    busy && !!streamCursor && lastAgent?.segments?.[lastAgent.segments.length - 1]?.type === "text";

  // O campo cresce com o texto (1 linha → teto de 140px) em vez de reservar 2 linhas sempre. `height=0` antes de
  // ler o scrollHeight é o que faz ele DIMINUIR ao apagar texto (senão só cresce).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  // WS-1 (D4) — one-shot draft prefill (the escalation seed): apply `text` when `nonce` changes + focus.
  // NOT a controlled input — the human edits/erases freely and it NEVER auto-sends (D4: composer, no send).
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.nonce]);

  // F4 — revoga os object URLs dos previews pendentes no UNMOUNT (fechar o drawer com anexos não enviados
  // vazava blobs). Um ref espelha os anexos p/ a limpeza ver a lista atual sem re-rodar o efeito a cada troca.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    },
    [],
  );

  // auto-scroll para o último turno (transcript cresce a cada round). Exceção 1: logo após "carregar mais antigas"
  // (prepend), NÃO cola no fim — a posição é restaurada no handler do botão. Exceção 2 (req 4): se o operador
  // rolou p/ cima (lendo algo antigo), o conteúdo novo do streaming NÃO interrompe a leitura — só sinaliza com o
  // pill "novas mensagens". Ancorado no fim (ou recém-aberto) segue colando.
  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [turns, busy, scrollKey]);

  // req 4 — re-ancora no fim (botão/pill) e a cada rolagem recalcula se está "perto do fim" (some com o pill ao voltar).
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    if (near) setShowJump(false);
  };

  // Carrega turnos mais antigos preservando a posição visual (o conteúdo cresce no TOPO, não pula pro fim).
  const handleLoadOlder = async () => {
    if (!onLoadOlder || loadingOlder) return;
    const el = scrollRef.current;
    const prevH = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    suppressAutoScrollRef.current = true;
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (el2) el2.scrollTop = prevTop + (el2.scrollHeight - prevH); // mantém o turno que o usuário via
      });
    }
  };
  useEffect(() => {
    if (!composerLocked && done === null) inputRef.current?.focus();
  }, [composerLocked, done]);

  const submitWith = (ids: string[], freeText: string) => {
    if (composerLocked || done !== null) return;
    setJustAnswered(true); // a escolha some AGORA, mesmo que o envio fique na fila (ver justAnswered)
    // O TEXTO que vai ao agente quando o operador escolhe: os rótulos das opções (os ids viajam à parte,
    // em `selectedOptionIds`). A lista vem da escolha viva — `options` só existe no layout compacto.
    const pool = ask?.options ?? options ?? [];
    const labels = pool.filter((o) => ids.includes(o.id)).map((o) => o.label).join("; ");
    const msg = freeText.trim() || labels;
    const images = attachments.map((a) => a.path);
    if (!msg && !ids.length && !images.length) return; // permite enviar SÓ imagens
    onSend(msg, ids.length ? ids : undefined, images.length ? images : undefined);
    setText("");
    setPicked(new Set());
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    setAttachErr(null);
  };

  const submit = () => {
    // O CINTO: `/clear` (mesmo com espaço sobrando, mesmo com a paleta fechada no Esc) roda o comando —
    // nunca vira uma mensagem para o modelo. Sem isto o operador veria o Jido "respondendo" a um comando.
    const exact = commands ? exactCommand(commands, text) : null;
    if (exact) {
      runCommand(exact);
      return;
    }
    submitWith([...picked], text);
  };

  const togglePick = (id: string) => {
    if (mode === "single") {
      // single-select = um toque resolve: envia imediatamente (preservando o texto livre, se houver).
      submitWith([id], text);
      return;
    }
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── A PALETA DE COMANDOS ────────────────────────────────────────────────────────────────────────────
  // Estado mínimo: qual entrada está destacada, e se o operador FECHOU a paleta com Esc. O resto é
  // derivado do texto — a fonte da verdade é o campo, não um "modo comando" paralelo que pode dessincronizar.
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const query = commands?.length ? slashQuery(text) : null;
  const matches = useMemo(
    () => (query === null || !commands ? [] : filterCommands(commands, query)),
    [commands, query],
  );
  const menuOpen = matches.length > 0 && !cmdDismissed && !composerLocked && done === null;
  // Digitar de novo RESSUSCITA a paleta (o Esc vale para aquele texto, não para sempre) e o destaque
  // volta ao topo — a lista mudou debaixo dele, manter o índice destacaria outra coisa.
  useEffect(() => {
    setCmdDismissed(false);
    setCmdIndex(0);
  }, [text]);

  const runCommand = (c: SlashCommand) => {
    if (composerLocked || done !== null) return;
    if (busy && !c.whileBusy) return; // mexer no contexto no meio de um turno: a paleta já mostra desabilitado
    setText("");
    setCmdDismissed(true);
    onCommand?.(c.name);
    inputRef.current?.focus();
  };

  /** A saída ABERTA de uma escolha: nada é enviado — a palavra volta para o operador, no composer. */
  const writeOwn = () => {
    setPicked(new Set());
    inputRef.current?.focus();
  };
  /** Um chip de resposta rápida: vale como se o operador tivesse digitado aquilo e apertado Enviar. */
  const sendSuggestion = (s: string) => submitWith([], s);

  /**
   * Não há NADA para enviar — a mesma condição de saída do {@link submitWith}, dita na tela.
   *
   * Os três caminhos contam, e é por isso que não basta olhar o texto: dá para enviar só imagens
   * (anexo sem legenda) e só escolhas (as marcadas no `multi`, que o operador manda sem comentar).
   */
  const nothingToSend = !text.trim() && picked.size === 0 && attachments.length === 0;

  /** A ESCOLHA desenhada ancorada ao turno (só no `full` — no compacto ela segue acima do composer). */
  const askBlock =
    full && ask && !justAnswered ? (
      <AskChoices
        ask={ask}
        selected={picked}
        onToggle={togglePick}
        onWriteOwn={writeOwn}
        onSuggestion={sendSuggestion}
        onSubmit={submit}
        disabled={composerLocked}
        className="pt-0.5"
      />
    ) : null;

  return (
    // `relative` — a barra do topo FLUTUA sobre o transcript (ela não é uma faixa que empurra o conteúdo:
    // é uma camada, e o texto passa por baixo dela com o degradê apagando a transição).
    <div className={cn("relative flex flex-col", full ? "min-h-0" : "gap-2", className)}>
      {title && <p className={cn(TXT.label, "font-semibold text-fg", full && "shrink-0 px-4 pt-3")}>{title}</p>}

      {full && topBar && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
          <div className="pointer-events-auto flex items-center gap-1 bg-surface px-3 pb-1 pt-2">{topBar}</div>
          <div className={TOP_FADE} />
        </div>
      )}

      {(turns.length > 0 || afterTurns) && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            // `chat-scroll` (e não `board-scroll`) SÓ no painel: mesma barra de rolagem, sem a reserva de
            // nav inferior que as áreas de rolagem da PÁGINA têm no celular (ver globals.css) — aqui
            // embaixo do transcript não há nav nenhuma, há o composer. O `compact` (os popovers HITL)
            // segue no `board-scroll` de sempre: o layout dele é preservado byte-a-byte de propósito, e
            // trocar a classe lá mudaria um respiro que ninguém pediu para mudar.
            full ? "chat-scroll" : "board-scroll",
            // `flex flex-col` só para o `mt-auto` do miolo poder empurrar (ver o wrapper abaixo). O
            // espaçamento entre turnos saiu daqui para o wrapper — `space-y` só vale para filhos diretos.
            full ? "flex flex-col px-4 py-3" : "pr-0.5",
            // o respiro que deixa o primeiro turno nascer ABAIXO da barra flutuante E do degradê dela.
            full && topBar && TOP_BAR_CLEARANCE,
          )}
        >
          {/* O MIOLO — e ele DESCANSA NO FUNDO enquanto for curto (`mt-auto`).
              Uma conversa recém-aberta tinha a saudação colada no topo e um vão de 200px até o composer:
              a mesma tela que todo mensageiro resolve há vinte anos crescendo DE BAIXO PARA CIMA. Ancorar
              no fim não é só estética — é onde o olho já está (o composer) e é para onde o transcript rola
              sozinho de qualquer maneira; o vão em cima é espaço vazio ANTES da conversa, que ninguém lê
              como defeito.
              `mt-auto` e não `justify-end` no rolável: a margem automática vira zero assim que o conteúdo
              passa da altura da caixa, então uma conversa longa rola normal — o `justify-end` é o que
              deixa o topo do conteúdo inalcançável nesse caso. O espaçamento entre turnos mora AQUI (e não
              no rolável) porque `space-y` só alcança filhos diretos. */}
          <div className={cn(full ? "mt-auto space-y-3" : "space-y-1.5")}>
          {hasOlder && onLoadOlder && (
            <div className="flex justify-center pb-1">
              <button
                type="button"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className={cn(CHIP, "transition hover:text-fg disabled:opacity-50")}
              >
                {loadingOlder && <Loader2 className={cn(ICON.inline, "animate-spin")} />}
                carregar mais antigas
              </button>
            </div>
          )}
          {turns.map((t, i) => {
            // EVENTO do sistema (o tick acordando) — nem operador nem agente. Antes este turno não existia: o
            // transcript entregava o prompt do tick como `role:"human"` e ele caía na bolha à direita abaixo.
            if (t.role === "notice") return <NoticeLine key={i} text={t.text} kind={t.kind} />;
            if (t.role === "human") {
              return (
                <div key={i} className="flex flex-col items-end gap-1">
                  {t.images && t.images.length > 0 && (
                    <span className={CHIP}>
                      <ImagePlus className={ICON.inline} /> {t.images.length} imagem{t.images.length > 1 ? "s" : ""} anexada{t.images.length > 1 ? "s" : ""}
                    </span>
                  )}
                  {(t.text || !t.images?.length) && (
                    <span
                      className={cn(
                        BUBBLE,
                        "rounded-br-md bg-accent/10",
                      )}
                    >
                      {t.text || "(imagem)"}
                    </span>
                  )}
                </div>
              );
            }
            // AGENTE, coluna à esquerda. NOVO modelo (copiloto agêntico): `segments` presente → render INLINE
            // ao vivo (texto + tools intercalados, na ordem). LEGADO (popovers HITL / greeting): `activity` +
            // `message` (chips no topo + 1 bolha). O render por-turno escolhe conforme o shape.
            //
            // `agentTurnView` RECORTA o bloco ```jido-ask do conteúdo: o que o operador lê é a prosa, e a
            // escolha vira UI (ver hitl/ask.ts). Ele roda em todo turno do agente, não só no último —
            // senão uma pergunta antiga voltaria a exibir o JSON cru ao rolar para cima.
            const view = agentTurnView(t);
            const isLastAgent = i === lastAgentIndex;
            // O turno VIVO: o último do agente enquanto o turno está em voo. É nele — e só nele — que o
            // texto anima ao entrar (`jido-stream`) e o mascote escreve no fim da linha.
            const live = isLastAgent && busy;
            return (
              <div key={i} className={cn("flex flex-col items-start gap-1.5", live && "jido-stream")}>
                {view.segments ? (
                  <AgentSegments segments={view.segments} flow={full} cursor={live ? streamCursor : undefined} />
                ) : (
                  <>
                    {t.activity && t.activity.length > 0 && <ActivityChips activity={t.activity} />}
                    {view.message.trim().length > 0 && (
                      // 2.4 — turnos do AGENTE renderizam markdown. Sem rehype-raw → 0 XSS.
                      <AgentProse text={view.message} flow={full} />
                    )}
                    {live && streamCursor}
                  </>
                )}
                {/* A ESCOLHA, ancorada à mensagem que a fez — e só quando o turno terminou (uma lista de
                    botões piscando enquanto o agente ainda escreve convida a responder o que não acabou
                    de ser dito). */}
                {isLastAgent && !busy && askBlock}
              </div>
            );
          })}

          {/* "pensando…" MORA NO CORPO da conversa (estilo Claude Code), no fim do transcript e junto do
              conteúdo que está sendo gerado — não numa barra de status acima do composer, onde ficava longe
              do olhar e não dava a menor ideia de há quanto tempo o agente estava trabalhando. */}
          {busy && <ThinkingLine onCancel={onCancel} quiet={writingText} />}

          {/* Trabalho em voo que NÃO é do operador (o ciclo autônomo). Só quando ele não tem turno próprio rodando
              — dois spinners empilhados diriam que há dois trabalhos quando há um. */}
          {!busy && systemWorking && <TickWorkingLine label={systemWorking} />}

          {/* Diário de decisões do Jido autônomo (slot do host) — no corpo, como o resto da conversa. */}
          {afterTurns}
          </div>
        </div>
      )}

      {/* req 4 — "novas mensagens": aparece SÓ quando o operador rolou p/ cima e chegou conteúdo novo.
          Ele era `sticky bottom-2 z-10` DENTRO do transcript — um membro do conteúdo rolável flutuando POR CIMA
          dele, cobrindo a última linha visível (e como o diário é sempre o último bloco, o que ele tapava era
          justamente o diário, inclusive o histórico expandido, que tem rolagem própria).
          Agora ele vive numa FAIXA PRÓPRIA entre o transcript e o composer: continua parecendo um botão
          flutuante — pill centrado, borda, sombra e fundo OPACO, claramente destacado da conversa — mas o
          espaço dele é RESERVADO no fluxo (o transcript cede ~30px enquanto ele existe), então não há nada
          embaixo para ele cobrir. É o que separa "flutuante" (a aparência que o operador quer) de "sobreposto"
          (o defeito): sem z-index disputando com o conteúdo, a sobreposição deixa de ser possível por
          construção, em vez de depender de acertar a camada. Só no `full`; o compact (popovers) segue igual. */}
      {full && showJump && (
        <div className="flex shrink-0 justify-center px-4 pb-1.5 pt-1">
          <button
            type="button"
            onClick={jumpToBottom}
            className="flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-[12px] font-medium text-fg-muted shadow-[0_2px_10px_rgba(15,15,15,0.16)] ring-1 ring-fg/10 transition hover:text-fg"
          >
            <ChevronDown className={ICON.inline} /> novas mensagens
          </button>
        </div>
      )}

      {/* Faixa ancorada entre o transcript e o composer (o diário do Jido autônomo). Fora do rolável de
          propósito: ela não é conversa, e o que não é conversa não deve nem se misturar às mensagens nem
          sumir de vista quando o operador rola para ler algo antigo. */}
      {beforeComposer}

      {/* Rodapé: erro + composer (ou banner de resolvido). No `full` ele é a CAIXA do composer, pinada
          embaixo (o transcript acima rola) e SEM régua separando: a caixa já se destaca do poço sozinha —
          uma borda-topo em cima dela era a segunda linha dizendo a mesma coisa. No compact é um bloco
          fluido como antes. */}
      {/* `GUTTER` e não um `px-3` próprio: a caixa do composer é a peça mais larga do painel e ela
          precisa nascer na MESMA vertical do texto das mensagens (que rola em `px-4`). Com 12px aqui e
          16px lá, a conversa inteira ficava 4px deslocada em relação ao lugar onde ela é escrita — o tipo
          de desalinho que não se nomeia olhando, mas que faz o painel parecer montado por duas pessoas. */}
      <div className={cn("space-y-2", full && cn("shrink-0 pb-3 pt-1", GUTTER))}>
        {error && (
          <div className={cn("rounded-lg bg-danger/10 px-3 py-2 text-fg", TXT.label)}>{error}</div>
        )}

        {done !== null ? (
          <p className={cn("rounded-lg bg-accent/15 px-3 py-2 font-medium text-fg", TXT.label)}>
            ✓ Resolvido — aplicado.
          </p>
        ) : (
          <div className="space-y-2">
            {/* LEGADO (`compact`): as opções acima do composer. No `full` elas vivem ancoradas ao turno
                que as pediu (askBlock) — perto da pergunta, como todo chat moderno faz. */}
            {options && options.length > 0 && (
              <OptionChips options={options} mode={mode} selected={picked} onToggle={togglePick} disabled={composerLocked} />
            )}
            {/* A PALETA, encostada no campo e crescendo PARA CIMA — ela é a continuação do que está sendo
                digitado, não um popover que aparece em algum lugar da tela. */}
            {menuOpen && (
              <SlashMenu
                commands={matches}
                activeIndex={cmdIndex}
                onPick={runCommand}
                onHover={setCmdIndex}
                busy={busy}
              />
            )}
            {/* A CAIXA: campo + anexos + ações numa peça só (`full`), ou os mesmos pedaços soltos como
                antes (`compact`). O conteúdo é IDÊNTICO nos dois — o que muda é a moldura. */}
            <div className={full ? COMPOSER_BOX : "space-y-2"}>
            {/* F4 — anexos de imagem pendentes (thumbnail + remover) + erro de upload */}
            {onAttachImages && attachments.length > 0 && (
              <div className={cn("flex flex-wrap gap-2", full && "px-1.5 pb-1 pt-1.5")}>
                {attachments.map((a, i) => (
                  <div key={i} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.previewUrl} alt={a.name} className="h-14 w-14 rounded-lg border border-line object-cover" />
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-fg text-surface shadow"
                      aria-label="Remover imagem"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {onAttachImages && attachErr && <p className={cn("text-rose-500", TXT.meta, full && "px-2")}>{attachErr}</p>}
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={
                onAttachImages
                  ? (e) => {
                      const files = Array.from(e.clipboardData?.items ?? [])
                        .filter((it) => it.type.startsWith("image/"))
                        .map((it) => it.getAsFile())
                        .filter((f): f is File => !!f);
                      if (files.length) {
                        e.preventDefault(); // não cola a imagem como texto/base64
                        void addFiles(files);
                      }
                    }
                  : undefined
              }
              onDrop={
                onAttachImages
                  ? (e) => {
                      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
                      if (files.length) {
                        e.preventDefault();
                        void addFiles(files);
                      }
                    }
                  : undefined
              }
              onDragOver={onAttachImages ? (e) => e.preventDefault() : undefined}
              onKeyDown={(e) => {
                // Com a paleta ABERTA o teclado é dela — as mesmas teclas do Claude Code/VS Code:
                // ↑↓ navega, Tab completa o nome no campo, Enter roda, Esc fecha (o texto fica).
                if (menuOpen) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setCmdIndex((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const c = matches[cmdIndex] ?? matches[0];
                    if (c) setText(completionFor(c));
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setCmdDismissed(true);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const c = matches[cmdIndex] ?? matches[0];
                    if (c) runCommand(c);
                    return;
                  }
                }
                // 2.3 — convenção universal de chat: Enter envia, Shift+Enter quebra linha, ⌘/Ctrl+Enter também
                // envia. (Antes só ⌘/Ctrl+Enter enviava e Enter inseria linha.) submit() já guarda busy/done.
                if (e.key !== "Enter") return;
                if (e.shiftKey) return; // nova linha (comportamento default do textarea)
                e.preventDefault();
                submit();
              }}
              rows={1}
              placeholder={placeholder ?? "Responda em texto — ou escolha acima…"}
              className={full ? FIELD_BARE : FIELD}
            />
            <div className={cn("flex items-center justify-between gap-2", full && "px-1")}>
              <div className="flex items-center gap-1">
                {/* Verbosidade: só quando o host NÃO a recolheu para um menu próprio (o Jido a levou p/ o ⋯). */}
                {showModeToggle && (
                  <button
                    type="button"
                    onClick={() => setResponseMode(responseMode === "terse" ? "standard" : "terse")}
                    className={BTN_GHOST}
                    title="Alterna a verbosidade das próximas respostas do agente"
                  >
                    modo: {responseMode === "terse" ? "curto" : "padrão"}
                  </button>
                )}
                {/* F4 — botão de anexo (caminho móvel obrigatório: colar/arrastar não são confiáveis no celular) */}
                {onAttachImages && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        void addFiles(Array.from(e.target.files ?? []));
                        e.target.value = ""; // permite re-anexar o mesmo arquivo
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploading}
                      className={BTN_ICON}
                      aria-label="Anexar imagem"
                      title="Anexar imagem"
                    >
                      {uploading ? <Loader2 className={cn(ICON.inline, "animate-spin")} /> : <ImagePlus className={ICON.inline} />}
                    </button>
                  </>
                )}
                {/* O ⋯ do host, colado no anexo (é onde o Jido guarda contexto/turnos/custo + compactar/nova). */}
                {composerExtra}
              </div>
              <button
                type="button"
                onClick={submit}
                // `nothingToSend`: o botão SEMPRE pareceu disponível — sólido, com o peso da ação primária —
                // mesmo com o campo vazio, quando `submitWith` já saía sem fazer nada. Era um convite que não
                // cumpria: o operador clica, a tela não mexe, e não há como saber se o clique não pegou ou se
                // o agente ficou mudo. Desabilitado, a mesma verdade fica dita ANTES do clique (e o
                // `disabled:opacity-40` do BTN_SOLID já desenha isso).
                disabled={composerLocked || uploading || nothingToSend}
                className={BTN_SOLID}
                // Com fila, enviar durante um turno é legítimo — o rótulo diz o que vai acontecer.
                title={busy && queueWhileBusy ? "O turno atual está em andamento — sua mensagem entra na fila" : undefined}
              >
                Enviar
              </button>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
