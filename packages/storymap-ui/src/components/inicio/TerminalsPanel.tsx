"use client";

// Group 2 of the home — the live terminals, each in ITS OWN dark mini-console card, in an accordion:
// one card is expanded (state, what it is doing entire, and its meters) and the rest collapse to their
// header row (title · state · contexto). Clicking a card's header toggles THAT card — it never navigates.
//
// The accordion is what makes the block fit: three expanded cards pushed everything below the fold, and
// the operator only ever reads one console at a time. A collapsed card still answers the question the
// block exists for — WHICH of these is working and which is idle.
//
// Three click targets, each doing one thing:
//   • the header    → collapse / expand this card (NOT a link; going to /processes from here was wrong)
//   • the body      → open the real terminal (the body is a picture of that tty)
//   • the pencil    → rename the terminal inline
// The block's heading (above the cards) is the only thing that navigates, and it goes to /processes.
//
// RENAMING writes the operator alias through PATCH /api/terminal/sessions — the same store
// (lib/terminal/prefs-store, keyed by tmux session NAME) the terminal page uses, and `listRunningServices`
// already resolves it over the derived label. So a name set here shows up on /processes and on the
// terminal page without this component knowing either of them exists.
//
// What this replaced, and why — the block used to lie by omission:
//   • a green dot from `status === "running"`, which only ever meant "o processo existe". A session stuck
//     for 80h and one mid-turn pulsed identically. The state now comes from the CLI's OWN busy/idle flag
//     (service-meters.ts).
//   • an uptime ("há 80h"), removed outright: it measured the clock, not the work.
//   • two competing greens — a `#7FC79B` "Claude" badge beside a `#4E9E6B` dot.
//   • `truncate` on every console line, which killed the sentence that says what is happening.
//
// Planes: listRunningServices() seeds the list and /api/processes re-polls at 8s; useCardConsoleTail()
// reads the SSE console frames for card runs; useServiceMeters() polls /api/processes/meters at 15s
// (paused when hidden); the real tty stays ttyd at /terminal?b=<session> (Caddy — window.open, never a
// <Link>).
//
// SURFACE: the app's, like every other block on this page. These cards used to paint themselves a dark
// mini-console in both themes ("it mirrors the tty it stands for"), which put THREE ideas of a surface on
// one screen — this warm-dark block, the Inbox's cream paper and the kanban's app surface — and the eye
// read them as three applications stacked vertically. The console FONT stays (the tail is monospaced
// output and wraps like it), because that is what carries the metaphor; the background was never doing it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Link2, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCardConsoleTail, useRunnerSnapshot } from "@/components/RunnerStatusProvider";
import { InlineConfirm } from "@/components/InlineConfirm";
import { canOfferKill } from "@/components/terminal/labels";
import {
  contextReading,
  MeterRow,
  PROMPT_INDENT,
  PromptLine,
  StateChip,
  stripLineMarker,
} from "@/components/terminal/parts";
import { notifyTerminalRenamed } from "@/components/terminal/rename-bus";
import { useServiceMeters } from "@/components/terminal/useServiceMeters";
import { meterFallback, type ServiceMeter } from "@/lib/vps/service-meters";
import { cardSurface } from "@/lib/ui";
import { servesBoard, type RunningService } from "@/lib/vps/types";
import type { BoardSummary } from "@/lib/storymap/types";

/** Vínculo ESTRUTURAL (do card ou do claim da frota) ⇒ não se troca daqui — ver BoardSource. */
function boardLocked(s: RunningService): boolean {
  return s.boardSource === "card" || s.boardSource === "fleet";
}

/**
 * Grava o vínculo terminal→board. O servidor revalida o id E recusa trocar um vínculo estrutural,
 * então uma recusa aqui é informação — devolvemos a mensagem dele em vez de um "não deu" genérico.
 */
async function patchBoard(session: string, board: string | null): Promise<string | null> {
  try {
    const r = await fetch("/api/terminal/sessions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: session, board }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return j?.ok ? null : (j?.error ?? "o servidor recusou vincular este terminal");
  } catch {
    return "a rede falhou ao vincular";
  }
}

/** With the extra cards collapsed to a header row, a few more fit in the same glance than three did. */
const MAX_TERMINALS = 5;

/** A MESMA superfície do resto do app (`cardSurface`) — ver a nota sobre o mini-console no topo. */
const CARD = cn(cardSurface, "overflow-hidden");

function openTerminal(session: string) {
  window.open(`/terminal?b=${encodeURIComponent(session)}`, "_blank", "noopener,noreferrer");
}

/**
 * The header's name, either as text or as the inline rename field. Saving PATCHes the alias and asks the
 * parent to refetch, so the new name arrives the same way every other field does — from the server —
 * rather than being mirrored in local state that could drift from what /processes shows.
 */
function TerminalName({
  service,
  onRenamed,
  grow,
}: {
  service: RunningService;
  onRenamed: () => void;
  /** open card: the name owns the free space. Collapsed: it yields it to the activity line. */
  grow: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // O campo edita o APELIDO, não o rótulo mostrado. Pré-preenchê-lo com `service.label` (o derivado,
  // "Agente · <tarefa>") fazia um salvamento acidental CONGELAR esse texto como apelido manual — o
  // nome parava de acompanhar o que a sessão faz, e nada na tela dizia que isso tinha acontecido.
  const alias = service.alias ?? "";
  const [draft, setDraft] = useState(alias);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only a tmux-backed row can be renamed: the alias store is keyed by session NAME, and a headless run
  // has no session to key. No pencil rather than a pencil that fails.
  const renameable = Boolean(service.tmuxSession);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const save = useCallback(async () => {
    const next = draft.trim();
    setEditing(false);
    if (!service.tmuxSession || next === alias) return;
    setSaving(true);
    try {
      await fetch("/api/terminal/sessions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // An EMPTY alias clears it (prefs-store drops the key), which is how the operator gets the
        // derived name back — so we send the empty string rather than refusing to save it.
        body: JSON.stringify({ name: service.tmuxSession, alias: next }),
      });
      onRenamed();
      // Every other surface that shows terminal names (today: the topnav's Terminal chip, which polls
      // the EXPENSIVE sessions route once a minute) refetches now instead of a minute from now.
      notifyTerminalRenamed();
    } catch {
      /* the next 8s poll re-renders whatever the server actually has */
    } finally {
      setSaving(false);
    }
  }, [draft, alias, service.tmuxSession, onRenamed]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        autoFocus
        maxLength={80}
        // Vazio = sem apelido, e é assim que se volta ao nome derivado. O placeholder mostra qual é
        // ele SEM transformá-lo em texto fixo (era o que o pré-preenchimento fazia).
        placeholder={service.label}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void save();
          if (e.key === "Escape") {
            setDraft(alias);
            setEditing(false);
          }
        }}
        aria-label="Apelido do terminal"
        className="min-w-0 flex-1 rounded border border-accent/50 bg-inset px-1.5 py-px text-[12px] font-semibold text-fg outline-none"
      />
    );
  }

  const startEditing = () => {
    setDraft(alias);
    setEditing(true);
  };

  // The name and its pencil share a gap-less wrapper, and the wrapper is the header's FLEXIBLE cell.
  // That is what keeps the resting header clean: at rest the pencil is a genuine 0×0 (no width, no
  // margin, and no parent `gap` to inherit — `opacity-0` alone left a ~28px hole beside every name),
  // and when it appears its 24px come out of the name's own truncation, so no sibling ever jumps.
  return (
    <span className={cn("flex min-w-0 items-center", grow ? "flex-1" : "max-w-[55%] shrink")}>
      <span className={cn("min-w-0 truncate text-[12px] font-semibold text-fg", saving && "opacity-60")}>
        {service.label}
      </span>
      {renameable && (
        <span
          role="button"
          tabIndex={0}
          title="Renomear este terminal"
          aria-label={`Renomear ${service.label}`}
          onClick={(e) => {
            e.stopPropagation();
            startEditing();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.stopPropagation();
            e.preventDefault();
            startEditing();
          }}
          className={cn(
            "flex h-5 w-0 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded text-fg-subtle opacity-0 transition-all",
            "hover:bg-surface-hover hover:text-fg",
            "group-hover/term:ml-1 group-hover/term:w-5 group-hover/term:opacity-100",
            // Keyboard parity: tabbing to it must reveal it, since a 0-width control is unusable blind.
            "focus-visible:ml-1 focus-visible:w-5 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
          )}
        >
          <Pencil className="h-3 w-3 shrink-0" />
        </span>
      )}
    </span>
  );
}

/**
 * A coluna de contexto do cabeçalho — largura fixa, para o olho descer o bloco por ela.
 *
 * As palavras e a régua de "leitura velha" vivem em `./labels` (testáveis); aqui fica só a tinta: uma
 * leitura velha recua e ganha `~`, uma sessão recém-limpa diz "novo" em vez de repetir o "—" que
 * também significa "não consegui ler".
 */
function ContextCell({ meter }: { meter: ServiceMeter }) {
  const ctx = contextReading(meter);
  return (
    <span
      title={ctx.title}
      className={cn(
        "w-9 text-right font-mono text-[10.5px] tabular-nums",
        ctx.stale ? "text-fg-subtle/60" : "text-fg-subtle",
      )}
    >
      {ctx.text}
    </span>
  );
}

/**
 * O seletor de board do cabeçalho — a MESMA forma do "encerrar": armado, a pergunta ocupa a linha
 * inteira, porque espremer uma escolha ao lado do nome, do estado e do contexto a tornaria o menor
 * elemento da linha.
 *
 * Só existe para vínculo MANUAL: um terminal de card/frota tem board estrutural, e trocá-lo faria
 * esta home listar o terminal do card de outro board (o servidor recusa de qualquer forma).
 */
function BoardPicker({
  service,
  boards,
  onDone,
  onCancel,
}: {
  service: RunningService;
  boards: BoardSummary[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (next: string) => {
      if (!service.tmuxSession) return;
      if ((next || "") === (service.board ?? "")) {
        onCancel();
        return;
      }
      setBusy(true);
      const err = await patchBoard(service.tmuxSession, next || null);
      setBusy(false);
      if (err) {
        setError(err);
        return;
      }
      onDone();
    },
    [service.tmuxSession, service.board, onDone, onCancel],
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <span className="shrink-0 text-[11.5px] text-fg-muted">Board deste terminal:</span>
      <select
        autoFocus
        disabled={busy}
        defaultValue={service.board ?? ""}
        aria-label="Board deste terminal"
        onChange={(e) => void save(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
        }}
        className="min-w-0 flex-1 rounded border border-line bg-inset px-1.5 py-0.5 text-[11.5px] text-fg outline-none focus-visible:border-accent"
      >
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
        {/* "Sem board" é uma escolha, não um cancelamento: sem ela um vínculo errado não teria desfazer. */}
        <option value="">— sem board —</option>
      </select>
      {error && <span className="shrink-0 text-[11px] text-danger">{error}</span>}
      <button
        type="button"
        onClick={onCancel}
        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle hover:bg-surface-hover hover:text-fg"
      >
        cancelar
      </button>
    </div>
  );
}

/**
 * ONE terminal card, open or collapsed. Its own component because the console tail is a HOOK: reading it
 * inside the parent's `.map` would call hooks in a loop whose length changes as processes come and go.
 */
function TerminalCard({
  service,
  meter,
  open,
  boards,
  onToggle,
  onRefresh,
}: {
  service: RunningService;
  meter: ServiceMeter;
  open: boolean;
  /** o vocabulário do seletor de board — já vem do servidor na home, sem fetch extra */
  boards: BoardSummary[];
  onToggle: () => void;
  /** re-busca a lista do servidor — depois de renomear, de vincular E depois de encerrar */
  onRefresh: () => void;
}) {
  // Card runs stream real console frames over SSE; a bare tmux session has no run key (no frames), so it
  // falls back to the server-derived `activity` line (intentional pane title / command · cwd). The raw tty
  // text stays server-only — `capturePane` has no HTTP surface, so we never fake printed output.
  const [frame] = useCardConsoleTail(service.board ?? "", service.cardId ?? "", 1);
  const canAttach = service.attachable && Boolean(service.tmuxSession);

  // O encerrar vive na linha: armado → confirma → o servidor decide. `armed` some sozinho quando a
  // linha deixa de ser dormente (o agente voltou a trabalhar entre o clique e a confirmação) — uma
  // pergunta pendente sobre um estado que mudou não pode continuar de pé.
  const [armed, setArmed] = useState(false);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  // O seletor de board divide o cabeçalho com o "encerrar": um de cada vez, senão duas perguntas
  // disputariam a mesma linha.
  const [picking, setPicking] = useState(false);
  const offersBoardPick = Boolean(service.tmuxSession) && !boardLocked(service) && boards.length > 0;
  const offersKill = canOfferKill(meter) && Boolean(service.tmuxSession);
  useEffect(() => {
    if (!offersKill) {
      setArmed(false);
      setKillError(null);
    }
  }, [offersKill]);

  const kill = useCallback(async () => {
    if (!service.tmuxSession) return;
    setKilling(true);
    try {
      const r = await fetch("/api/terminal/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: service.tmuxSession }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string };
      if (j?.ok) {
        setArmed(false);
        onRefresh();
        return;
      }
      // A recusa do guarda é a informação mais útil da interação — ela diz POR QUE aquele terminal não
      // pode morrer. Mostrar "não deu" no lugar dela seria esconder a única explicação que existe.
      setKillError(j?.reason ?? j?.error ?? "o servidor recusou encerrar este terminal");
    } catch {
      setKillError("a rede falhou ao encerrar");
    } finally {
      setKilling(false);
    }
  }, [service.tmuxSession, onRefresh]);

  const line = stripLineMarker(frame?.text ?? service.activity ?? service.detail ?? "sem saída recente");
  // An `error` frame IS the message, so it wears the failure ink even before the run's status catches up.
  const danger = frame?.level === "error" || meter.state === "failed";

  const body = (
    <>
      <PromptLine state={meter.state} muted={meter.state !== "working" && !danger} danger={danger}>
        {line}
      </PromptLine>
      {/* contexto stays in the HEADER in both states (see below) — the body would move a reading that
          the operator scans by column down into the card, and print it twice while open. */}
      <MeterRow meter={meter} className={PROMPT_INDENT} hideContext />
    </>
  );

  return (
    <div className={cn(CARD, "group/term")}>
      {/* The header toggles THIS card. A <div role="button"> rather than a <button>, because the rename
          pencil and its input live inside it and a button cannot legally contain either. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onToggle();
        }}
        title={open ? "Recolher" : "Abrir"}
        className={cn(
          "flex cursor-pointer items-center gap-2 px-2.5 transition hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
          // A altura fixa é o que mantém a coluna de linhas alinhada em repouso; armado, ela cede para
          // a pergunta caber inteira (é o único momento em que o cabeçalho tem algo a dizer).
          armed ? "min-h-8 py-1.5" : "h-8",
          open && "border-b border-line",
        )}
      >
        {/* Armado, a pergunta OCUPA o cabeçalho inteiro. Espremê-la ao lado do nome, do estado e do
            contexto deixaria a decisão mais destrutiva do bloco como o menor elemento da linha. */}
        {armed ? (
          <InlineConfirm
            question={`Encerrar “${service.label}”? O que estiver rodando dentro morre.`}
            confirmLabel="encerrar"
            busy={killing}
            error={killError}
            onConfirm={() => void kill()}
            onCancel={() => {
              setArmed(false);
              setKillError(null);
            }}
          />
        ) : picking ? (
          <BoardPicker
            service={service}
            boards={boards}
            onDone={() => {
              setPicking(false);
              onRefresh();
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <>
            <TerminalName service={service} onRenamed={onRefresh} grow={open} />
            {/* Collapsed, the free space to the right of the name was empty while the one thing it could
                answer — what this terminal is DOING — was only visible by opening the card. It goes here,
                after a separator and a weight down from the name, so the name still reads as the title. */}
            {!open && line && (
              <>
                <span aria-hidden className="shrink-0 text-[10.5px] text-fg-subtle">
                  ·
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-normal text-fg-muted">{line}</span>
              </>
            )}
            {/* State + contexto travel together, tight, at the right edge — two readings of the same
                "how is it going", so they read as one group instead of two floating chips. Contexto stays
                here OPEN AS WELL: it is the card's title bar, one fixed-width column the eye runs down the
                block, and letting it fall into the body on expand moved it (and only for the open card). */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {/* Trocar/desfazer o board — mesma discrição do lápis e da lixeira. Aqui ele só corrige
                  ou desfaz: todo card DESTE bloco já é deste board (o filtro é estrito). Quem VINCULA
                  um terminal solto é a seção "sem board" no rodapé — é lá que ele está visível. */}
              {offersBoardPick && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Trocar o board deste terminal (ou desvincular)"
                  aria-label={`Trocar o board de ${service.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPicking(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.stopPropagation();
                    e.preventDefault();
                    setPicking(true);
                  }}
                  className={cn(
                    "flex h-5 w-0 cursor-pointer items-center justify-center overflow-hidden rounded text-fg-subtle opacity-0 transition-all",
                    "hover:bg-surface-hover hover:text-fg",
                    "group-hover/term:w-5 group-hover/term:opacity-100",
                    "focus-visible:w-5 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                  )}
                >
                  <Link2 className="h-3 w-3 shrink-0" />
                </span>
              )}
              {/* O encerrar só aparece na linha DORMENTE (canOfferKill), e só ao passar o ponteiro —
                  mesma discrição do lápis: uma lixeira permanente ao lado de cada terminal convida ao
                  acidente que a confirmação existe para evitar. */}
              {offersKill && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Encerrar este terminal"
                  aria-label={`Encerrar ${service.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setArmed(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.stopPropagation();
                    e.preventDefault();
                    setArmed(true);
                  }}
                  className={cn(
                    "flex h-5 w-0 cursor-pointer items-center justify-center overflow-hidden rounded text-fg-subtle opacity-0 transition-all",
                    "hover:bg-danger/10 hover:text-danger",
                    "group-hover/term:w-5 group-hover/term:opacity-100",
                    "focus-visible:w-5 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger",
                  )}
                >
                  <Trash2 className="h-3 w-3 shrink-0" />
                </span>
              )}
              {/* Open, the message below already ends in the dots — the header must not animate the same
                  fact a second time. Collapsed, the dots ARE the state slot. */}
              <StateChip meter={meter} compact={!open} hideWorking={open} />
              <ContextCell meter={meter} />
            </span>
          </>
        )}
      </div>

      {/* The body IS the terminal's picture, so the body is what opens the terminal. */}
      {open &&
        (canAttach ? (
          <button
            type="button"
            onClick={() => openTerminal(service.tmuxSession!)}
            title="Abrir o terminal"
            aria-label={`Abrir o terminal de ${service.label}`}
            className="grid w-full gap-2 px-2.5 pb-2.5 pt-2 text-left font-mono transition hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          >
            {body}
          </button>
        ) : (
          <div className="grid gap-2 px-2.5 pb-2.5 pt-2 font-mono">{body}</div>
        ))}
    </div>
  );
}

/**
 * Os terminais que não pertencem a board NENHUM — e o botão que os traz para este.
 *
 * O DEFEITO que esta seção fecha: o operador tinha 3 terminais abertos em /terminal e nenhum
 * aparecia no bloco de nenhuma home. Estava tudo "certo" (`servesBoard` é estrita e eles não têm
 * board), mas a tela onde a ausência se NOTA era justamente a que não dizia nada sobre ela. Mandar
 * o operador para /terminal adivinhar o motivo é o que se está evitando aqui.
 *
 * Não é uma segunda lista de terminais: é uma fila de atribuição. Por isso as linhas são compactas,
 * sem console, sem medidor — o que se faz com elas é uma coisa só.
 */
function UnlinkedTerminals({
  services,
  boardId,
  boardName,
  onLinked,
}: {
  services: RunningService[];
  boardId: string;
  boardName: string;
  onLinked: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const link = useCallback(
    async (session: string) => {
      setBusy(session);
      setError(null);
      const err = await patchBoard(session, boardId);
      setBusy(null);
      if (err) setError(err);
      else onLinked();
    },
    [boardId, onLinked],
  );

  if (services.length === 0) return null;
  const shown = services.slice(0, MAX_TERMINALS);
  const hidden = services.length - shown.length;

  return (
    <div className="mt-2">
      <p className="px-0.5 pb-1.5 text-[11px] text-fg-subtle">
        {services.length === 1 ? "1 terminal sem board" : `${services.length} terminais sem board`} — não
        {services.length === 1 ? " aparece" : " aparecem"} na home de nenhum board
      </p>
      <div className={cn(CARD, "divide-y divide-line")}>
        {shown.map((s) => (
          <div key={s.id} className="flex items-center gap-2 px-2.5 py-1.5">
            <span className="min-w-0 truncate text-[12px] text-fg-muted">{s.label}</span>
            {s.activity && (
              <>
                <span aria-hidden className="shrink-0 text-[10.5px] text-fg-subtle">
                  ·
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle">
                  {stripLineMarker(s.activity)}
                </span>
              </>
            )}
            <button
              type="button"
              disabled={busy === s.tmuxSession}
              onClick={() => void link(s.tmuxSession!)}
              title={`Vincular “${s.label}” a ${boardName}`}
              className="ml-auto shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-fg-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {busy === s.tmuxSession ? "vinculando…" : "vincular"}
            </button>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <p className="px-0.5 pt-1.5 text-[11px] text-fg-subtle">
          e mais {hidden} —{" "}
          <a href="/terminal" className="underline hover:text-accent">
            ver todos os terminais
          </a>
        </p>
      )}
      {error && <p className="px-0.5 pt-1.5 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

export function TerminalsPanel({
  boardId,
  boardName,
  boards,
  initialServices,
}: {
  boardId: string;
  /** o nome legível deste board — o rótulo do "vincular a …" */
  boardName: string;
  /** vocabulário do seletor; já vem do servidor na home (o switcher usa a mesma lista) */
  boards: BoardSummary[];
  initialServices: RunningService[];
}) {
  const [services, setServices] = useState<RunningService[]>(initialServices);
  const [openId, setOpenId] = useState<string | null>(null);
  const { running } = useRunnerSnapshot();
  const meters = useServiceMeters();

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/processes", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j?.services)) setServices(j.services as RunningService[]);
    } catch {
      /* keep last snapshot */
    }
  }, []);

  // Keep the list live: immediate refresh + 8s poll of the server-merged process list. Re-runs (fresh
  // fetch) whenever the live runner snapshot changes so a new/finished run appears without the tick lag.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh, running.length]);

  // DESTE board, e só dele. `/api/processes` responde pela MÁQUINA inteira (é o que /processes e
  // /terminal precisam) — a home de um board não: um terminal de outro board aqui é ruído que o
  // operador não tem como atribuir. A régua é a estrita (`servesBoard`), então o que não tem board —
  // master, shell, terminal do Jido, sessão sem card — vive nas telas da máquina, não nesta.
  // O filtro vale para as DUAS entradas: o `initialServices` do servidor e cada repoll de 8s.
  //
  // Operator-relevant terminals: live runs first, then anything attachable (drop finished/idle noise).
  // Within that, a session the meters say is WORKING outranks one that is merely open — the card that is
  // expanded by default should be the one actually producing.
  const rows = useMemo(() => {
    const relevant = services.filter(
      (s) =>
        servesBoard(s, boardId) &&
        (s.status === "running" || s.attachable || s.lane === "terminal"),
    );
    const rank = (s: RunningService) => {
      if (meters[s.id]?.state === "working") return 0;
      return s.status === "running" ? 1 : s.attachable ? 2 : 3;
    };
    return [...relevant].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_TERMINALS);
  }, [services, meters, boardId]);

  // Os SEM board — nem deste, nem de outro: ninguém os reivindica. São os únicos que esta home pode
  // adotar sem tirar de ninguém, e por isso são os únicos que ela mostra fora do próprio recorte
  // (um terminal de OUTRO board continua fora daqui — é ruído que o operador não pode atribuir).
  // Só linha de terminal de verdade: um run headless não tem sessão para vincular.
  // Sem `slice` aqui de propósito: quem corta é a seção, que também DIZ que cortou. Um corte
  // silencioso nesta lista se leria como "é só isso que existe" — o oposto do que ela serve.
  const unlinked = useMemo(
    () => services.filter((s) => !s.board && s.attachable && Boolean(s.tmuxSession)),
    [services],
  );

  // The open card is the operator's choice while it still exists; otherwise the top one (the ranking
  // above puts the working session there). Derived rather than stored, so a row that dies never leaves
  // the block with everything collapsed. `openId === ""` is the deliberate all-collapsed state that
  // clicking the open card's header produces.
  const openRow = openId === "" ? null : (rows.find((s) => s.id === openId) ?? rows[0]);

  return (
    <section aria-label="Terminais">
      <div className="mb-3 flex items-center gap-2 px-0.5">
        {/* The block's link lives on its TITLE (no separate "Ver todos" pill) — a chevron nudging on
            hover. The cards themselves never navigate.
            O destino é a PÁGINA DOS TERMINAIS, não /processes: um bloco chamado "Terminais" que leva à
            lista de PROCESSOS manda o operador para uma tela vizinha e mais fria toda vez que ele quis
            simplesmente ir para o terminal. `<a>` e não `<Link>` — /terminal é um asset estático servido
            de public/, então uma navegação de cliente do App Router não o alcança. */}
        <a href="/terminal" className="group inline-flex items-center gap-2">
          <span className="text-[15.5px] font-semibold tracking-tight text-fg transition group-hover:text-accent">
            Terminais
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:text-accent" />
        </a>
        <span className="flex-1" />
      </div>

      {rows.length === 0 && unlinked.length === 0 ? (
        <div className={cn(CARD, "px-4 py-10 text-center")}>
          {/* "nenhum terminal ATIVO" passou a mentir quando o bloco virou por board: pode haver
              terminal vivo — de outro board, ou sem board nenhum. O vazio diz o que é verdade
              (deste board), e o título logo acima já leva a /terminal, que mostra a máquina toda.
              Ele só aparece quando NÃO há nem sequer um terminal solto para adotar: com solto, o
              vazio seria um beco (a queixa original — nenhum terminal em lugar nenhum e nada a
              fazer), e quem entra no lugar dele é a fila de atribuição abaixo. */}
          <p className="font-mono text-[11.5px] text-fg-subtle">nenhum terminal deste board</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((s) => {
            const isOpen = s.id === openRow?.id;
            return (
              <TerminalCard
                key={s.id}
                service={s}
                meter={meters[s.id] ?? meterFallback(s)}
                open={isOpen}
                boards={boards}
                onToggle={() => setOpenId(isOpen ? "" : s.id)}
                onRefresh={() => void refresh()}
              />
            );
          })}
        </div>
      )}

      <UnlinkedTerminals
        services={unlinked}
        boardId={boardId}
        boardName={boardName}
        onLinked={() => void refresh()}
      />
    </section>
  );
}
