// Pure projection behind GET /api/feedback/destinations — turns the board's cards + the LIVE tmux
// sessions into the minimal DISCOVERY catalog the overlay's send-step picker renders. It is RICH
// enough to RECOGNISE a target (human label, relative activity, idle/busy) but deliberately OMITS the
// fleet ops-intel (absolute cwd, USD cost, git branch, live activity phrase) that would turn the
// picker into a recon dump. It also excludes TERMINAL cards (a closed/shipped card is a poor refine
// target) and REDACTS every label without proven affinity to THIS board — a FOREIGN-board session's
// card title AND a card-less session's free-text label both collapse to a board-neutral recogniser
// (the operator picking a paste target doesn't need to read acme's backlog). Pure (injected) →
// unit-testable; the route does the IO (readCards + terminalStatusIds, buildEnrichedSessions, filter).

export interface DestinationOption {
  kind: "card" | "session";
  /** the routing target: a cardId or a tmux session name */
  id: string;
  label: string;
  /** recognition only — relative activity / status; NEVER ops-intel (no cwd/cost/branch/phrase) */
  sublabel?: string;
  /** a running session → the picker warns before pasting into a working agent */
  busy?: boolean;
}

export interface CardLike {
  id: string;
  title?: string;
  updatedMs?: number;
  capture?: boolean;
  /** true when the card sits in a TERMINAL status (done/no ar/discontinued/duplicado/…) — a poor
   *  refine target, so it's dropped from the picker. The route computes it from the board config's
   *  terminalStatusIds; the pure fn just honours the flag (kept config-agnostic → unit-testable). */
  terminal?: boolean;
}

export interface SessionLike {
  name: string;
  label: string;
  status: "running" | "idle";
  createdAt: number | null;
  /** The MASTER control session (`claude*`, the box orchestrator) — the ONLY paste-forbidden class.
   *  Deliberately NARROW: NOT the broad kill-`protected` (which flags EVERY live-agent session — the
   *  valid targets), and NOT the durable infra `shell` (the operator's own interactive session usually
   *  lives there and IS a valid target when it hosts a Claude agent). The sink re-enforces the same. */
  master: boolean;
  card: { board: string; cardId: string; title: string | null } | null;
}

export function relativeTime(now: number, then: number | null | undefined): string {
  if (!then || then <= 0 || then > now) return "";
  const s = Math.floor((now - then) / 1000);
  if (s < 60) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export function projectDestinations(input: {
  board: string;
  cards: CardLike[];
  sessions: SessionLike[];
  sessionEnabled: boolean;
  now: number;
  cardLimit?: number;
}): DestinationOption[] {
  const { board, cards, sessions, sessionEnabled, now } = input;
  const cardLimit = input.cardLimit ?? 30;

  const cardOptions: DestinationOption[] = cards
    .filter((c) => Boolean(c.id) && !c.capture && !c.terminal)
    .slice()
    .sort((a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0))
    .slice(0, cardLimit)
    .map((c) => {
      const rel = relativeTime(now, c.updatedMs);
      return { kind: "card", id: c.id, label: c.title || c.id, ...(rel ? { sublabel: rel } : {}) };
    });

  // Sessions ONLY when the terminal round-trip is enabled — recon (this list) and action (the paste)
  // ship together or not at all. Exclude ONLY the MASTER orchestrator (`claude*`) — NOT every
  // kill-`protected` one (that is every live agent = the valid targets), and NOT the durable `shell`
  // (the operator's own interactive session usually lives there and IS a valid target). The sink
  // re-enforces the SAME `master` exclusion server-side, so picker and sink agree by construction.
  // Labels are redacted by board affinity (foreign card title AND card-less free label → neutral).
  const sessionOptions: DestinationOption[] = !sessionEnabled
    ? []
    : sessions
        .filter((s) => Boolean(s.name) && !s.master)
        .map((s) => {
          // The DISPLAY label is the one the operator already recognises everywhere else (/processes,
          // the terminal tab bar): the session's own name — its alias, else "Agente · <tarefa>".
          //
          // It used to collapse to the bare tmux name for a CARD-LESS session, on the theory that a
          // fleet agent's free-text task could name another board's work. In practice that hid the
          // ONLY thing that distinguishes one terminal from another: two sessions called `shell` and
          // `teminal-upgrade` say nothing about which is which, and the operator picking a paste
          // target could not tell them apart. Recognition IS this picker's job.
          //
          // A FOREIGN-board CARD is a different matter and stays redacted — that rule is about not
          // dumping another board's backlog titles here, and nothing about it changed.
          const foreignCard = s.card != null && s.card.board !== board;
          const label = foreignCard ? `${s.card!.cardId} · (outro board)` : s.label || s.name;
          // The tmux name is the routing identity (`?b=` / the paste target). Once the label is
          // descriptive it no longer shows the name, so carry it here — recognisable AND addressable.
          const status = s.status === "running" ? "trabalhando agora" : relativeTime(now, s.createdAt);
          const sub = [label === s.name ? "" : s.name, status].filter(Boolean).join(" · ");
          return {
            kind: "session",
            id: s.name,
            label,
            ...(sub ? { sublabel: sub } : {}),
            busy: s.status === "running",
          };
        });

  return [...cardOptions, ...sessionOptions];
}
