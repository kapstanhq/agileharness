// In-memory registry of EPHEMERAL "helper agents" — the synchronous panel assistants
// (Lean Canvas / Posicionamento / Ideias / Personas, smart capture, triage,
// governance) that run a one-shot `claude -p` via runClaudeJson. Unlike autorun runs they
// never touch the runner engine/journal, so they were invisible on /processes. This registry
// makes them visible WHILE THEY RUN: the choke point (runClaudeJson) registers one on spawn
// and drops it on settle, and /api/processes/stream pushes the live set to the client over
// SSE (a transient row that disappears when the call returns).
//
// SERVER-ONLY, process-global singleton (same pattern as the runner registry). Pure in-memory:
// these live only as long as the call, so there's nothing to persist.

export interface HelperAgent {
  /** stable id for the lifetime of the call */
  id: string;
  /** human label — "Assistente do Lean Canvas · sincronizar", "Captura inteligente", … */
  label: string;
  /** the board view it serves (canvas / posicionamento / captura / triagem / …) */
  view?: string;
  /** board / card context, when the caller has it */
  board?: string;
  cardId?: string;
  /** epoch ms it started */
  startedAt: number;
  /** the spawned claude pid, when known */
  pid?: number;
}

type Listener = (helpers: HelperAgent[]) => void;

class HelperRegistry {
  private helpers = new Map<string, HelperAgent>();
  private listeners = new Set<Listener>();
  private seq = 0;

  /** Register a starting helper; returns its id (pass to end()). */
  start(meta: { label: string; view?: string; board?: string; cardId?: string }): string {
    const id = `helper-${Date.now()}-${++this.seq}`;
    this.helpers.set(id, { id, startedAt: Date.now(), ...meta });
    this.emit();
    return id;
  }

  /** Annotate the helper with its spawned pid (best-effort). */
  setPid(id: string, pid: number): void {
    const h = this.helpers.get(id);
    if (h) h.pid = pid;
  }

  /** Drop a finished helper (no-op if already gone). */
  end(id: string): void {
    if (this.helpers.delete(id)) this.emit();
  }

  list(): HelperAgent[] {
    return [...this.helpers.values()];
  }

  /** Subscribe to the live set (immediately AND on every change). Returns an unsubscribe fn. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const snap = this.list();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* a broken listener must never break the call it's observing */
      }
    }
  }
}

const KEY = Symbol.for("storymap.helperRegistry");
const store = globalThis as unknown as Record<symbol, HelperRegistry>;

export function getHelperRegistry(): HelperRegistry {
  return (store[KEY] ??= new HelperRegistry());
}
