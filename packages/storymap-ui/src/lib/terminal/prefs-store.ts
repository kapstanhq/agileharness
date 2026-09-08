// Operator UI prefs for the web terminal — per-session display ALIAS + PINNED flag, keyed by tmux
// session NAME (never cardId: non-card sessions have a name but no card). Durable JSON in the
// gitignored runner state dir, mirroring notifications/server/push-store.ts.
//
// Why an in-process lock is enough: the Next server is the SOLE writer — the static terminal page
// can't touch the filesystem; it mutates prefs only via PATCH /api/terminal/sessions. So there is no
// cross-process last-writer-wins risk (contrast board-data, which agents also write, hence the D4
// hook). Server-only (node:fs).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { runnerStateDir, terminalPrefsPath } from "@/lib/storymap/paths";
import { withKeyedLock } from "@/lib/storymap/serialize";

export interface SessionPref {
  /** operator display name; absent ⇒ fall back to the derived label */
  alias?: string;
  /** favorite — sorts to the top of the picker / tab bar */
  pinned?: boolean;
  /**
   * The board this terminal serves, when the OPERATOR linked it by hand. Absent ⇒ no manual link.
   *
   * Only ever a FALLBACK: a session whose board is structural (a `card-<board>__<id>` terminal, a
   * fleet session with a claim) keeps that board — see `boardForTmux` in lib/vps/processes. Without
   * this field a hand-opened tmux (`shell`, `term-2`) had no board at all and `servesBoard` filtered
   * it out of EVERY board's home, with no lever for the operator to change that.
   */
  board?: string;
}
export type TerminalPrefs = Record<string, SessionPref>;

const ALIAS_MAX = 80;
/** Um board id é um nome de diretório sob `storymap/boards/` — curto por construção. */
const BOARD_ID_MAX = 80;

/** Every stored pref (empty object on missing/corrupt file — never throws). */
export function loadPrefs(): TerminalPrefs {
  try {
    const obj = JSON.parse(readFileSync(terminalPrefsPath(), "utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as TerminalPrefs) : {};
  } catch {
    return {};
  }
}

/** Atomic write: per-pid temp then rename over the target (a reader never sees a half-written map). */
function persist(prefs: TerminalPrefs): void {
  const dir = runnerStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = terminalPrefsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2), "utf8");
  renameSync(tmp, file);
}

/**
 * Read-modify-write one session's pref under the `terminal-prefs` lock. Only the keys PRESENT in
 * `patch` change; `alias: null|""` clears the alias; `board: null|""` clears the link; `pinned:
 * false` clears the flag. A pref that becomes empty drops its whole entry so the file stays tidy.
 * Returns the resulting pref.
 */
export async function setPref(
  name: string,
  patch: { alias?: string | null; pinned?: boolean; board?: string | null },
): Promise<SessionPref> {
  return withKeyedLock("terminal-prefs", async () => {
    const prefs = loadPrefs();
    const next: SessionPref = { ...(prefs[name] ?? {}) };

    if ("alias" in patch) {
      const a = patch.alias;
      if (a == null || String(a).trim() === "") delete next.alias;
      else next.alias = String(a).trim().slice(0, ALIAS_MAX);
    }
    if ("pinned" in patch) {
      if (patch.pinned) next.pinned = true;
      else delete next.pinned;
    }
    // "sem board" é um estado legítimo, não a ausência de uma escolha — por isso limpar é explícito
    // (null/""), do mesmo jeito que o apelido. Quem valida se o id EXISTE é a rota (contra
    // listBoards): um vínculo pendurado filtraria para nada em silêncio.
    if ("board" in patch) {
      const b = patch.board;
      if (b == null || String(b).trim() === "") delete next.board;
      else next.board = String(b).trim().slice(0, BOARD_ID_MAX);
    }

    if (Object.keys(next).length === 0) delete prefs[name];
    else prefs[name] = next;
    persist(prefs);
    return prefs[name] ?? {};
  });
}

/**
 * Derruba as prefs de sessões que NÃO EXISTEM MAIS. Devolve os nomes podados — `[]` quando não havia o
 * que podar, para o chamador não escrever no disco a cada ciclo.
 *
 * POR QUE ISTO PRECISA EXISTIR. A rota DELETE já apagava a pref ao matar um terminal, e o comentário
 * dela diz o porquê: a chave é o NOME tmux, então uma sessão futura que reuse o nome herdaria o apelido
 * de outra. Só que matar pela app é UM dos caminhos de morte — `exit` no shell, `tmux kill-session`, um
 * reboot da máquina e o ttyd fechando não passam por lá. Todos os outros deixavam a entrada órfã para
 * sempre, e era assim que a lista de Terminais acabava exibindo o nome de um terminal que não existe
 * mais (a queixa literal do operador). A decisão de que a pref não sobrevive à sessão já estava tomada;
 * o que faltava era valer para as outras portas de saída.
 *
 * A TRAVA QUE NÃO PODE SAIR: uma lista VAZIA nunca poda. `listSessions()` devolve `[]` tanto para "esta
 * máquina não tem sessão" quanto para "o tmux não respondeu" — e apagar num engano desses levaria TODOS
 * os apelidos do operador de uma vez, sem desfazer.
 */
export async function prunePrefs(liveNames: readonly string[]): Promise<string[]> {
  if (liveNames.length === 0) return [];
  return withKeyedLock("terminal-prefs", async () => {
    const prefs = loadPrefs();
    const alive = new Set(liveNames);
    const dropped = Object.keys(prefs).filter((name) => !alive.has(name));
    if (dropped.length === 0) return []; // nada mudou ⇒ nenhuma escrita
    for (const name of dropped) delete prefs[name];
    persist(prefs);
    return dropped;
  });
}
