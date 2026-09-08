"use client";

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  BUG_SEVERITY_BY_ID,
  DISPOSITION_BY_ID,
  IMPROVEMENT_KIND_BY_ID,
  REMOVAL_LEVEL_BY_ID,
} from "@/lib/storymap/frameworks";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { isLegacyOrphan, needsPlacement } from "@/lib/storymap/unplaced";
import { needsTriageReview } from "@/lib/storymap/demands";
import { terminalStatusIds } from "@/lib/storymap/views";
import { liveOpenBlockers } from "@/lib/storymap/runner/findings";

/**
 * Mode (refine/fix/retire) + triage (severity / needs-review / duplicate) signal badges shown atop a
 * story card — shared by the Kanban, the map (ADR-056 Fase 2) AND the home feed, so a bug / triage
 * item is visually distinct EVERYWHERE.
 *
 * Notion/GitHub-grade chips: soft, low-chroma, TOKENISED — never raw Tailwind `red-100`/`emerald-50`/
 * `sky-50`, no ALL-CAPS shouting, no emoji. A chip carries at most ONE hue, and it carries it the way
 * the identity does: a whisper of the semantic token behind graphite ink (danger reads as terracota
 * ink because it passes AA), or — for the green/amber signals whose full hue fails AA as text — a tiny
 * coloured DOT beside neutral ink. Hierarchy comes from that dot, not from a loud fill.
 */
const BADGE =
  "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium leading-none";
/** The default chip — a faint warm well with muted ink, kin to the mono id chip. */
const NEUTRAL = "bg-fg/[0.05] text-fg-muted";
/** The one tint loud enough to double as ink: terracota danger clears AA over its own wash. */
const DANGER = "bg-danger/[0.10] text-danger";

/** A 6px hue dot — how a soft neutral chip carries a colour whose ink alone would fail contrast. */
function Dot({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", className)} style={style} />
  );
}

export function CardBadges({
  card,
  config,
  compact = false,
}: {
  card: Card;
  config?: BoardConfig;
  /**
   * Feed density: keep only the EXCEPTION signals (the card is a bug/refine/retire, or it holds an
   * open blocker) and drop the board-management chips (severity, triage-review, placement, duplicate,
   * release-state) — in the home feed the stage grouping + the tri-state dot already carry lifecycle
   * and status, so those chips would just be noise echoing the column.
   */
  compact?: boolean;
}) {
  const badges: ReactNode[] = [];

  if (card.mode === "refine") {
    const kinds = card.refinement?.kinds ?? [];
    badges.push(
      <span key="refine" className={cn(BADGE, NEUTRAL)}>
        <Dot className="bg-accent" />
        Refino
        {kinds.length
          ? ` · ${kinds.length === 1 ? IMPROVEMENT_KIND_BY_ID[kinds[0]].name : `${kinds.length} tipos`}`
          : ""}
      </span>,
    );
  }

  if (card.mode === "fix" && card.bugReport) {
    badges.push(
      <span
        key="fix"
        title={BUG_SEVERITY_BY_ID[card.bugReport.severity]?.short}
        className={cn(BADGE, DANGER)}
      >
        Bug · {BUG_SEVERITY_BY_ID[card.bugReport.severity]?.name ?? card.bugReport.severity}
      </span>,
    );
  }

  if (card.mode === "retire" && card.retirement) {
    badges.push(
      <span
        key="retire"
        title={[
          DISPOSITION_BY_ID[card.retirement.disposition]?.short,
          card.retirement.level ? REMOVAL_LEVEL_BY_ID[card.retirement.level]?.short : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        className={cn(BADGE, NEUTRAL)}
      >
        {DISPOSITION_BY_ID[card.retirement.disposition]?.name ?? "Arquivado"}
        {card.retirement.level ? ` · ${REMOVAL_LEVEL_BY_ID[card.retirement.level]?.name}` : ""}
      </span>,
    );
  }

  // Triage severity on a card NOT already in fix mode (a bug born in `triage`, where severity is the
  // first-class field). Board-management noise in the feed → only outside `compact`.
  if (!compact && card.mode !== "fix" && card.severity) {
    const sev = BUG_SEVERITY_BY_ID[card.severity];
    badges.push(
      <span key="sev" title={sev?.short} className={cn(BADGE, NEUTRAL)}>
        <Dot style={{ backgroundColor: sev?.color }} />
        {sev?.name ?? card.severity}
      </span>,
    );
  }

  // MESMA regra do CTA e do item de Inbox (needsTriageReview): a cobrança de revisão de triagem
  // só vale enquanto o card está na quarentena. Sem `config` o badge se cala.
  if (!compact && needsTriageReview(card, config?.statuses.find((s) => s.id === card.status))) {
    badges.push(
      <span
        key="review"
        title="Triagem de baixa confiança — precisa de revisão humana"
        className={cn(BADGE, NEUTRAL)}
      >
        <Dot className="bg-accent" />
        Revisar
      </span>,
    );
  }

  // Fase 4.3: a story the `hasPlacement` gate will HOLD at construction — no parent, no serves, no
  // unplacedAck. The tooltip names the gate + the two ways out.
  if (!compact && needsPlacement(card)) {
    badges.push(
      <span
        key="unplaced"
        title="Sem lugar no mapa (sem pai, sem serves, sem aceite). O gate hasPlacement a segura antes da construção — abra o card → Posição no mapa: defina um pai/serves, ou clique “Aceitar sem lugar”."
        className={cn(BADGE, NEUTRAL)}
      >
        <Dot className="bg-accent" />
        sem lugar
      </span>,
    );
  }

  // SM-02 AC3: a LEGACY orphan (parentless story without the intentional `unplaced` flag) is INVISIBLE
  // no mapa (AgileHarnessOutline), so flag it here instead of letting it vanish. Suppressed when `needsPlacement`
  // already flags it (that's the more actionable signal).
  if (!compact && isLegacyOrphan(card) && !needsPlacement(card)) {
    badges.push(
      <span
        key="orphan"
        title="Story sem step pai — não aparece no mapa (backbone). Abra e defina um pai, ou arraste-a no mapa."
        className={cn(BADGE, NEUTRAL)}
      >
        <Dot className="bg-accent" />
        Órfã
      </span>,
    );
  }

  if (!compact && card.duplicateOf) {
    badges.push(
      <span key="dup" title={`Duplicado de ${card.duplicateOf}`} className={cn(BADGE, NEUTRAL)}>
        Dup · {card.duplicateOf}
      </span>,
    );
  }

  // Open BLOCKER finding (held out of QA by gate hasNoBlockers). An exception signal — kept in the feed.
  // On a TERMINAL card (No Ar / retired) a MECHANISM blocker (code/data-not-landed, merge-back) is STALE — it is
  // superseded on terminal entry (supersedeStaleTerminalBlockers) and can never re-integrate, so showing
  // "Bloqueio" on a shipped card is the false-"travado" anti-pattern. So on a terminal card we ignore mechanism
  // blockers and show the chip ONLY for a genuine NON-mechanism open blocker. Kept in LOCKSTEP with the
  // write-path supersede ("hidden ⟺ superseded" — nothing that isn't auto-cleared is ever hidden). Fail-OPEN
  // without `config` (can't resolve terminality → keep the pre-fix behaviour). Non-terminal cards: unaffected.
  const isTerminal = config ? terminalStatusIds(config).has(card.status ?? "") : false;
  if (liveOpenBlockers(card.findings, isTerminal).length) {
    badges.push(
      <span
        key="blocker"
        title="Tem finding(s) blocker em aberto — resolva (fixed/wontfix) antes de avançar"
        className={cn(BADGE, DANGER)}
      >
        <Dot className="bg-danger" />
        Bloqueio
      </span>,
    );
  }

  // Fase 4b release state — lifecycle chips, echoed by the column in the feed → only outside `compact`.
  if (!compact && card.releasedAt) {
    badges.push(
      <span
        key="released"
        title={`Código promovido para main (release) em ${card.releasedAt}`}
        className={cn(BADGE, NEUTRAL)}
      >
        <Dot className="bg-primary" />
        Released
      </span>,
    );
  } else if (!compact && card.stagedAt) {
    badges.push(
      <span
        key="staged"
        title={`Código integrado na branch stage em ${card.stagedAt} — aguardando release`}
        className={cn(BADGE, NEUTRAL)}
      >
        <Dot className="bg-accent" />
        Staged
      </span>,
    );
  }

  if (!badges.length) return null;
  // `mb-1` only in the stacked card (StoryCard puts badges above the title); the feed drops it so the
  // chips sit centred inside its inline row.
  return <div className={cn("flex flex-wrap items-center gap-1", !compact && "mb-1")}>{badges}</div>;
}
