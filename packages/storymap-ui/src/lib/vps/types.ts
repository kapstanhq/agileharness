// VPS observability + the unified "running service" model.
//
// Two concerns, both surfaced on the /processes page and the navbar health strip:
//   1. Box health — RAM / disk / CPU load + the Claude Code usage window (the
//      "acelerar ou frear" gauge: how much quota is LEFT before it resets).
//   2. Running services — every Claude on the box, merging the autorun runner's
//      headless `claude -p` children (card-linked, tracked in the journal) with the
//      box's tmux sessions (attachable in a real terminal). These are two disjoint
//      worlds; RunningService bridges them so one list shows them all.
//
// Isomorphic (NO node deps): the server collector produces these, the client renders
// them. Keep it free of `node:*` imports so it can be imported from client components.

// --- Box health -------------------------------------------------------------

export interface RamMetric {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  /** 0..100 */
  usedPct: number;
}

export interface DiskMetric {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  /** 0..100 */
  usedPct: number;
  mount: string;
}

export interface LoadMetric {
  avg1: number;
  avg5: number;
  avg15: number;
  cores: number;
  /** 1-min load as a % of cores (0..100, can exceed if oversubscribed → clamped by UI) */
  pct1: number;
}

/**
 * The active Claude Code rate-limit window (a ~5h block, read via ccusage). The headline
 * number the user asked for is `remainingPct` — "% de uso restante até resetar a cota" —
 * with `resetsInMinutes` answering "quando reseta". burn rate + projection say whether the
 * window will be exhausted before it resets, so the user can decide to accelerate or brake.
 */
export interface TokenWindow {
  source: "ccusage";
  /** epoch ms — when this window started */
  startedAt: number;
  /** epoch ms — when the quota resets (the block's end) */
  resetsAt: number;
  /** minutes until reset (>= 0) */
  resetsInMinutes: number;
  /** tokens consumed in this window so far */
  usedTokens: number;
  /** USD spent in this window so far */
  costUSD: number;
  /** the window's token budget (configured via settings/env, else auto-detected from the
   * biggest prior window). null when unknown → the % fields are null and the UI shows
   * raw usage + burn + reset time instead. */
  limitTokens: number | null;
  /** % of the budget STILL AVAILABLE (the headline gauge); null when no limit is known */
  remainingPct: number | null;
  /** % of the budget already consumed; null when no limit is known */
  usedPct: number | null;
  /** ccusage's projected total tokens for the full window at the current burn rate */
  projectedTokens: number | null;
  /** projected to blow past the budget before the window resets? null when no limit */
  willExceedBeforeReset: boolean | null;
  burnTokensPerMin: number | null;
  burnCostPerHour: number | null;
  models: string[];
}

/** A single rolling rate-limit window (Anthropic subscription), expressed as % already used. */
export interface UsageBucket {
  /** 0..100 — % of the window already consumed */
  usedPct: number;
  /** minutes until this window resets (>= 0) */
  resetsInMinutes: number;
}

/**
 * The REAL Claude subscription usage — polled server-side by the headroom proxy directly from
 * Anthropic and surfaced verbatim, so it shows the SAME numbers as Claude's `/usage` screen.
 * Preferred over the ccusage estimate (`TokenWindow`) whenever present, because it is the
 * authoritative server-side figure: ccusage can only estimate from local transcript token
 * counts against a guessed weekly limit, which drifts badly from the plan's real windows.
 */
export interface UsageWindow {
  source: "subscription";
  /** 5-hour rolling session window */
  session: UsageBucket | null;
  /** 7-day rolling window across all models (the weekly brake signal) */
  week: UsageBucket | null;
  /** 7-day Sonnet-only window */
  weekSonnet: UsageBucket | null;
  /** pay-as-you-go extra usage, when enabled on the plan */
  extra: { enabled: boolean; usedUsd: number; limitUsd: number } | null;
  /** epoch ms the proxy last polled Anthropic (staleness signal) */
  polledAt: number | null;
  /**
   * True when `polledAt` is older than the freshness budget (or absent) — i.e. the proxy's
   * subscription poller has stalled and these numbers no longer track Claude's `/usage`.
   * The parser sets a placeholder `false` (it has no clock); `metrics.ts` recomputes it every
   * snapshot against `now`. The UI MUST NOT present a stale window as authoritative — it shows
   * the last-known number muted + a "defasado há Xh" marker instead of a confident color.
   */
  stale: boolean;
}

/**
 * Headroom compression effectiveness — proves the proxy is actually doing work, not merely
 * "connected". `requestsCompressed === 0` means no run traffic is flowing through the proxy
 * yet (the green liveness dot alone is misleading), so the UI can tell the truth.
 */
export interface HeadroomSavings {
  /** OVERALL % token reduction across all traffic (0 = nothing compressed yet). Small for
   * cache-heavy workloads — most volume is prompt-cache reads the proxy can't compress. */
  savingsPct: number;
  /** average % reduction on the requests it ACTUALLY compressed — shows the proxy IS working
   * even when the overall % is tiny (few requests had compressible content). */
  avgCompressionPct: number;
  /** tokens removed by the proxy */
  tokensSaved: number;
  /** how many API requests the proxy has actually compressed */
  requestsCompressed: number;
  /** USD saved */
  savedUsd: number;
}

export interface VpsMetrics {
  /** epoch ms this snapshot was collected */
  at: number;
  ram: RamMetric | null;
  disk: DiskMetric | null;
  load: LoadMetric | null;
  tokens: TokenWindow | null;
  /** why `tokens` is null (e.g. ccusage unavailable) — surfaced as a tooltip */
  tokenError?: string;
  /** the REAL Claude subscription windows (headroom proxy → Anthropic); preferred over `tokens` */
  usage: UsageWindow | null;
  /** headroom compression effectiveness; null when the proxy/stats are unavailable */
  headroom: HeadroomSavings | null;
}

// --- Running services -------------------------------------------------------

export type ServiceKind =
  | "runner-run" // a headless `claude -p` autorun/manual child, card-linked
  | "tmux-master" // the interactive master Claude session (tmux `claude`)
  | "tmux-shell" // a plain bash shell session (tmux `shell`)
  | "tmux-card" // a tmux session materialized to resume a card's run (`card-<board>-<id>`)
  | "tmux-copilot" // F2 — a raw-shell terminal the copiloto created via term_new (`cop-<slug>`)
  | "tmux-adhoc" // any other tmux session
  | "claude-external" // a stray `claude` process (from ps) started OUTSIDE the system (SSH/manual) — inspect/kill only
  | "helper-agent"; // a synchronous panel assistant (runClaudeJson) — transient, surfaced only WHILE it runs

export type ServiceStatus =
  | "running" // executing right now
  | "interrupted" // journal says "running" but no live process (crash/restart) → resumable
  | "done" // finished cleanly (recent)
  | "failed" // finished with an error/timeout (recent)
  | "idle"; // a tmux session that exists but isn't doing work

/**
 * WHICH LIST a service belongs to — the page's primary split, and the answer to "is the machine
 * working?".
 *
 * `pipeline` is the ONLY lane that answers yes: work the SYSTEM is driving (a runner run, a card's
 * terminal, the copiloto, a panel assistant). A human's shell and a claude someone started over SSH
 * are real processes and stay inspectable/killable — but they are not the board making progress, so
 * they never inflate the "rodando agora" count. (Before this split the page counted the operator's
 * own SSH session — and the very Bash call rendering the page — as pipeline work.)
 */
export type ServiceLane =
  | "pipeline" // the system is doing card work here
  | "terminal" // a human's tmux session (shell/master/ad-hoc)
  | "externo"; // a claude started outside the system (SSH/manual) — inspect or kill, nothing more

const LANE_BY_KIND: Record<ServiceKind, ServiceLane> = {
  "runner-run": "pipeline",
  "helper-agent": "pipeline",
  "tmux-card": "pipeline",
  "tmux-copilot": "pipeline",
  "tmux-master": "terminal",
  "tmux-shell": "terminal",
  "tmux-adhoc": "terminal",
  "claude-external": "externo",
};

/** The lane a service kind belongs to. Single source of truth — server collector AND client agree. */
export function laneOf(kind: ServiceKind): ServiceLane {
  return LANE_BY_KIND[kind];
}

/**
 * WHO originated this Claude service — the lens the operator filters by on /processes.
 * Derived (not stored on the run): kanban = autorun cascade, manual = "Rodar agora" /
 * "Sincronizar" or a hand-opened tmux, merge = the train re-driving a conflict, ajuda =
 * a synchronous panel assistant (Lean Canvas/Posicionamento/…), externo = a stray `claude`
 * started outside the system (SSH/tmux).
 */
export type OriginKind = "kanban" | "manual" | "merge" | "ajuda" | "externo";

/**
 * DE ONDE veio o board de um serviço — `card` (o nome `card-<board>__<id>` ou o próprio run),
 * `fleet` (o registro da frota: worktree_open / claude_new) ou `manual` (o operador vinculou à mão
 * na página do terminal / na home).
 *
 * Não é enfeite: é o que separa um vínculo ESTRUTURAL (imutável — trocá-lo faria a home de um board
 * listar o terminal do card de OUTRO) de um EDITÁVEL. A UI usa para travar o seletor e dizer de onde
 * veio; a rota PATCH re-deriva e recusa a troca de um estrutural (fail-closed). A regra de
 * precedência vive em `boardForTmux` (lib/vps/processes) — aqui fica só o vocabulário, porque este
 * módulo é isomórfico e o cliente também precisa dele.
 */
export type BoardSource = "card" | "fleet" | "manual";

/** One Claude service on the box — a runner run OR a tmux session, unified. */
export interface RunningService {
  /** stable, URL-safe id for /processes/[id]. `run:<board>/<cardId>` or `tmux:<session>`. */
  id: string;
  kind: ServiceKind;
  /** human label for the list row */
  label: string;
  /** o APELIDO que o operador deu a este terminal, quando existe um — `label` já o incorpora, mas quem
   *  EDITA o nome precisa saber se há um apelido de verdade ou só um rótulo derivado (ver processes.ts) */
  alias?: string;
  status: ServiceStatus;
  /** which list it belongs to (derived from `kind`) — only `pipeline` counts as the machine working */
  lane: ServiceLane;
  /** who originated it (derived) — the operator's filter lens */
  origin?: OriginKind;

  // card link — always for runner runs; derived from the session name for tmux-card.
  board?: string;
  /** POR QUE esta linha está neste board (ver BoardSource). Absent quando não há board. */
  boardSource?: BoardSource;
  cardId?: string;
  cardTitle?: string;

  /** the skill (runner runs only) */
  trigger?: string;

  // resume / terminal handoff
  /** `claude --resume <sessionId>` target (runner runs) */
  sessionId?: string;
  /** an attachable tmux session name — the web terminal opens `/terminal?b=<name>` */
  tmuxSession?: string;
  /** can the user open a real terminal for this service right now? */
  attachable: boolean;
  /** is a tmux client currently attached to its session? */
  attached?: boolean;

  // what-is-this — the row's honest self-description for the home Terminais cards.
  /** true when a Claude AGENT is driving this terminal (vs a plain shell) — the "Claude" vs shell
   *  badge. Derived: claude-driven kinds, OR a live `claude` found inside a tmux session's tree
   *  (so an ad-hoc session that someone launched claude into reads as Claude, not shell). */
  agent?: boolean;
  /** the live foreground command of a tmux session's active pane (e.g. `bash`, `zsh`, `claude`) —
   *  the shell badge label when this is NOT an agent terminal. */
  runtimeCmd?: string;
  /** a clean one-line "what it is doing" (intentional pane title, else `command · cwd`) for tmux
   *  sessions — the home console's fallback line, in place of the raw "Claude vivo · <etime>". */
  activity?: string;

  // lifecycle
  /** epoch ms it started (runner runs), or null */
  startedAt?: number | null;
  /** human uptime when startedAt is unknown (from `ps` etime) */
  uptimeText?: string;
  pid?: number | null;
  /** outcome label for finished runs (ok / exit / timeout / error) */
  outcome?: string;
  /** short extra detail (failure reason, etc.) */
  detail?: string;

  // usage (runner runs, when reported)
  costUSD?: number | null;
  tokens?: number | null;
}

/**
 * Esta linha pertence ao board pedido? A régua ESTRITA — só o que carrega o board.
 *
 * A caixa é compartilhada entre N boards (um serviço, N boards, um host), então a lista crua de
 * `listRunningServices` é machine-level POR DESENHO: é exatamente o que /processes e /terminal
 * precisam. A HOME de um board é o oposto — ela responde por UM recorte, e um terminal de outro
 * board ali é ruído que o operador não tem como atribuir.
 *
 * Estrita de propósito, e DIFERENTE do `belongsToBoard` da Esteira (que deixa o sem-board aparecer
 * em todos): trabalho sem board — master, shell, terminal do Jido, sessão sem card — segue inteiro
 * nas telas da MÁQUINA, e some da home. Duas telas, duas perguntas, duas réguas.
 *
 * Pura e agnóstica: nenhum id de board é conhecido aqui, então qualquer instalação com qualquer
 * conjunto de boards lê a mesma regra.
 */
export function servesBoard(service: Pick<RunningService, "board">, boardId: string): boolean {
  return !!service.board && service.board === boardId;
}
