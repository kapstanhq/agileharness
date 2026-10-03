"use client";

// The shared anatomy of a terminal row — variante A ("Prompt"), worn by BOTH surfaces that show running
// services: the home's Terminais block and /processes. ONE vocabulary, ONE finish — theme tokens.
//
// There used to be a second finish (`tone="console"`): the home's block painted itself a dark mini-console
// in both themes, on the argument that it mirrors the tty it stands for. It was retired because it made the
// home read as three different applications stacked vertically — a warm-dark console block beside cream
// paper cards above app-surface kanban rows, each with its own idea of what a surface is. The metaphor was
// not worth a third palette on one screen: the ANATOMY (state mark, prompt line, meter row) is what makes
// the eye read "terminal", not the background colour. Don't reintroduce a per-surface palette here — a
// finish that only one caller wears is a palette with nobody to keep it honest.
//
// What changed from the old chrome, and why:
//   • the green dot is GONE. `status === "running"` only ever meant "o processo existe"; it painted a
//     stuck session and a working one identically. The state now comes from the CLI's own busy/idle flag
//     (see service-meters.ts).
//   • the two competing greens (`#7FC79B` "Claude" badge vs `#4E9E6B` dot) are gone with it.
//   • uptime is gone outright: it measured the clock, not the work. The meters (contexto/custo/diff) took
//     the slot and answer the question it never did.
//   • PROMINENCE IS NOT UNIFORM. `trabalhando` is motion with no word (it repeated down the column saying
//     nothing); `aguardando você` — the only state with a turn for the operator to take — gets the word,
//     the brand amber and a ring. Semantic red stays for failure only.
//
// The words and the pure text rules live in `./labels` (this package's vitest cannot transform `.tsx`, so
// anything defined here would be untestable); they are re-exported so consumers import one vocabulary.

import { cn } from "@/lib/cn";
import { diffIsEmpty, type ServiceMeter, type WorkState } from "@/lib/vps/service-meters";
import { contextReading, needsYou, PROMPT_INDENT, stateHint, stateLabel, stripLineMarker } from "./labels";

export { contextReading, needsYou, PROMPT_INDENT, stateHint, stateLabel, stripLineMarker };

const INK = "text-fg";
const DIM = "text-fg-muted";
const FAINT = "text-fg-subtle";
const ACCENT = "text-accent";
const DANGER = "text-danger";

/** The LOUD one — reserved for the state that wants the operator (see needsYou). */
const CHIP_ATTENTION = "text-accent bg-accent/[0.14] ring-1 ring-inset ring-accent/30";

const CHIP_QUIET: Record<WorkState, string> = {
  working: "text-fg-muted",
  waiting: "text-fg-muted bg-surface-hover",
  failed: "text-danger bg-danger/10",
  done: "text-fg-muted bg-surface-hover",
};

/** A hollow ring for anything not working — reads as "existe, mas não se mexe" at a glance. */
function IdleMark({ state, attention = false }: { state: WorkState; attention?: boolean }) {
  const failed = state === "failed";
  return (
    <span
      aria-hidden
      className={cn(
        "h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]",
        failed
          ? "border-transparent bg-danger"
          : attention
            ? "border-accent"
            : "border-fg-subtle",
      )}
    />
  );
}

/**
 * The trailing "…" of a live line — THE working signal, and the only one. Three staggered dots, not the
 * old block caret (a solid blinking block at the end of a sentence read as a typo in the message) and not
 * the rising bars that briefly sat in the header beside it (two animations for one fact, in one card).
 *
 * It appears EXACTLY ONCE per row: at the end of the message when there is a message, in the state slot
 * when there isn't (a collapsed card has no line to end). See StateChip's `hideWorking`.
 */
export function TypingDots() {
  return (
    <span aria-hidden className={cn("ml-[2px] inline-flex items-baseline gap-[2px]", ACCENT)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="term-dot inline-block h-[3px] w-[3px] rounded-full bg-current"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

/**
 * The state marker. Its size is its priority, so it is NOT one uniform chip:
 *
 *   • working   → the three dots, no word. "Trabalhando" written on every live row was the same word
 *                 repeated down the column, spending the most space on the state that asks nothing of
 *                 anyone. And the dots appear ONCE per row: pass `hideWorking` where the message below
 *                 already ends in them, so one card never animates the same fact twice.
 *   • aguardando você → the loud one: word + amber + ring. This is the row with a turn to take.
 *   • ocioso / falhou / concluído → quiet chips; present, not shouting.
 *
 * The word survives in `title` for every state, so nothing is lost to someone hovering or using a
 * screen reader — only to the visual column.
 */
export function StateChip({
  meter,
  compact = false,
  hideWorking = false,
}: {
  meter: Pick<ServiceMeter, "state" | "source">;
  /** collapsed rows: shorter word, tighter box — the mark and the colour still carry the state */
  compact?: boolean;
  /** the prompt line below is visible and already ends in the dots — don't repeat them up here */
  hideWorking?: boolean;
}) {
  const label = stateLabel(meter, compact);

  if (meter.state === "working") {
    if (hideWorking) return null;
    return (
      <span
        title={`${label} — ${stateHint(meter)}`}
        aria-label={label}
        className="inline-flex shrink-0 items-center"
      >
        <TypingDots />
      </span>
    );
  }

  const attention = needsYou(meter);
  return (
    <span
      title={stateHint(meter)}
      className={cn(
        "inline-flex shrink-0 items-center rounded font-bold uppercase tracking-[0.08em]",
        compact ? "gap-1 px-1 py-px text-[9.5px]" : "gap-1.5 px-1.5 py-[2px] text-[10px]",
        attention ? CHIP_ATTENTION : CHIP_QUIET[meter.state],
      )}
    >
      <IdleMark state={meter.state} attention={attention} />
      {label}
    </span>
  );
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(2).replace(".", ",")}`;
}

/**
 * The meters row — what replaced the uptime. Every cell is omitted when the number does not exist, so the
 * row never renders a zero it did not measure (`diff: null` = sem árvore para medir; `+0 −0` = medi e a
 * sessão não escreveu nada, which is a finding worth showing).
 *
 * Two zones, and the split is semantic: the MEASUREMENTS (contexto/custo/diff — readings of how the work
 * is going) flow from the left, and the SETUP (modelo · effort — what the session is thinking WITH, which
 * does not move) sits at the right edge. The setup used to be one more cell in the flow, where a long
 * model id shoved the numbers around and nothing lined up between rows.
 *
 * The context BAR is gone: a 3px sliver repeating down a column of cards was decoration, and the number
 * beside it already said the thing. Where a surface shows contexto in its own header (the home's
 * accordion), pass `hideContext` so one card never prints the same reading twice.
 */
export function MeterRow({
  meter,
  className,
  hideContext = false,
}: {
  meter: ServiceMeter;
  className?: string;
  /** the surrounding chrome already shows contexto — don't repeat it in the body */
  hideContext?: boolean;
}) {
  const d = meter.diff;
  const empty = diffIsEmpty(d);
  const sep = <span className={cn(FAINT)}>·</span>;

  const cells: React.ReactNode[] = [];
  if (meter.contextPct != null && !hideContext) {
    // Uma leitura velha continua aparecendo — some seria pior —, mas marcada (`~` e recuo): logo depois
    // de um `/clear` o número anterior sobrevive até o próximo ciclo do medidor, e sem a marca ele
    // afirma um estado que já não existe.
    const ctx = contextReading(meter);
    cells.push(
      <span key="ctx" title={ctx.title}>
        contexto{" "}
        <b className={cn("font-semibold tabular-nums", ctx.stale ? DIM : INK)}>{ctx.text}</b>
      </span>,
    );
  }
  if (meter.costUSD != null) {
    cells.push(
      <span key="cost" className={cn("font-semibold tabular-nums", INK)}>
        {fmtCost(meter.costUSD)}
      </span>,
    );
  }
  if (d) {
    cells.push(
      <span
        key="diff"
        className="tabular-nums"
        title={
          empty
            ? "a árvore desta sessão está limpa — nada escrito ainda"
            : `${d.files} arquivo(s) alterado(s)${d.untracked > 0 ? ` · ${d.untracked} novo(s)` : ""}`
        }
      >
        {empty ? (
          <span className={cn(FAINT)}>sem escrita</span>
        ) : (
          <>
            <b className={cn("font-semibold", INK)}>+{d.added}</b>{" "}
            <b className={cn("font-semibold", DANGER)}>−{d.removed}</b>
            {d.untracked > 0 && <span className={cn(" ", FAINT)}> +{d.untracked} novo</span>}
          </>
        )}
      </span>,
    );
  }
  // The setup, as ONE right-aligned unit. Both halves answer "com o que ela está pensando", so they are
  // written together — and either alone is still worth saying (a session whose transcript has no `effort`
  // record still has a model).
  const setup = [meter.model, meter.effort].filter(Boolean).join(" · ");

  if (cells.length === 0 && !setup) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px]", DIM, className)}>
      {cells.map((c, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && sep}
          {c}
        </span>
      ))}
      {setup && (
        <span className={cn("ml-auto shrink-0", FAINT)} title="modelo · esforço de raciocínio">
          {setup}
        </span>
      )}
    </div>
  );
}

/**
 * The prompt line — the thing that makes the eye read "terminal" without a fake window frame. The message
 * WRAPS: it used to be `truncate`d, which killed the sentence that says what is happening ("Aplicando
 * correção em Termin…"). `overflow-wrap: anywhere` because console output carries paths and shas that have
 * no spaces to break on.
 *
 * While working it ends in three animated dots (TypingDots) instead of the old block caret, which read as
 * a typo in the message rather than as a cursor.
 */
export function PromptLine({
  state,
  children,
  muted = false,
  danger = false,
}: {
  state: WorkState;
  children: React.ReactNode;
  muted?: boolean;
  /** failure text: the line itself is the error, so it wears the danger ink */
  danger?: boolean;
}) {
  const dots = state === "working";
  // Bind the dots to the LAST WORD so they can never wrap alone onto a line of their own — an orphaned
  // row of three dots under the message reads as a rendering bug, not as "ainda escrevendo". Only a plain
  // string can be split this way; anything richer just gets the dots appended.
  let body: React.ReactNode = children;
  if (dots && typeof children === "string") {
    const text = children.trimEnd();
    const cut = text.lastIndexOf(" ");
    body =
      cut > 0 ? (
        <>
          {text.slice(0, cut + 1)}
          <span className="whitespace-nowrap">
            {text.slice(cut + 1)}
            <TypingDots />
          </span>
        </>
      ) : (
        <span className="whitespace-nowrap">
          {text}
          <TypingDots />
        </span>
      );
  } else if (dots) {
    body = (
      <>
        {children}
        <TypingDots />
      </>
    );
  }

  return (
    // `items-baseline` so the glyph sits ON the first line's baseline instead of floating above it.
    <div className="grid grid-cols-[auto_1fr] items-baseline gap-1.5">
      <span aria-hidden className={cn("text-[11.5px] leading-[1.65]", state === "working" ? ACCENT : FAINT)}>
        ❯
      </span>
      <p
        className={cn(
          "m-0 text-[11.5px] leading-[1.65] [overflow-wrap:anywhere]",
          danger ? DANGER : muted ? DIM : INK,
        )}
      >
        {body}
      </p>
    </div>
  );
}
