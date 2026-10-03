// O RITMO DO BOARD (board-pace.ts) em disco: `board-pace.json` no estado do runner, e o PORTÃO que a produção consulta.
//
// A leitura é SÍNCRONA e em cache (assinatura do arquivo: mtime + tamanho): o pump do engine e o pump do condutor
// perguntam a cada passada, e não podem esperar IO. O serviço é o único escritor; a escrita vai por uma cadeia do
// processo (ler-mudar-gravar atômico) e derruba o cache.
//
// ILEGÍVEL NÃO É VAZIO: um arquivo que existe e não se lê segura TODOS os boards (board-pace.ts `resolveBoardGate`) até
// alguém regravar — lido como vazio, um board que o dono pausou voltaria a gastar sozinho.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { BoardConfig } from "@/lib/storymap/types";
import { holdPaceEntry, parsePaceFile, resolveBoardGate, serializePaceFile, type BoardGate, type BoardPaceRow, type PaceHeldEntry } from "./board-pace";

/** O arquivo de ritmo — ao lado dos outros livros do runner. */
export function boardPaceFile(dir: string = runnerStateDir()): string {
  return path.join(dir, "board-pace.json");
}

export interface BoardPaceSnapshot {
  rows: BoardPaceRow[];
  /** o arquivo existe e não pôde ser lido/julgado. */
  unreadable: boolean;
}

interface Cached extends BoardPaceSnapshot {
  file: string;
  sig: string;
}

// Do PROCESSO, não do módulo: o Next instancia o arquivo uma vez por camada, e o cache e a cadeia têm de ser um só.
const CACHE_KEY = Symbol.for("agileharness.board-pace.cache");
const CHAIN_KEY = Symbol.for("agileharness.board-pace.chain");
const holder = globalThis as unknown as { [CACHE_KEY]?: Cached; [CHAIN_KEY]?: Promise<unknown> };

const EMPTY: BoardPaceSnapshot = { rows: [], unreadable: false };

/** O ritmo de todos os boards, agora. Nunca lança: sem arquivo (ou sem diretório de estado) ⇒ vazio; ilegível ⇒ `unreadable`. */
export function readBoardPace(fileOverride?: string): BoardPaceSnapshot {
  let file: string;
  try {
    file = fileOverride ?? boardPaceFile();
  } catch {
    return EMPTY; // sem diretório de estado não há arquivo — nenhum board foi pausado por aqui
  }
  let sig: string;
  try {
    const st = fs.statSync(file);
    sig = `${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY;
    return { rows: [], unreadable: true };
  }
  const hit = holder[CACHE_KEY];
  if (hit && hit.file === file && hit.sig === sig) return hit;
  let snap: BoardPaceSnapshot;
  try {
    const rows = parsePaceFile(fs.readFileSync(file, "utf8"));
    snap = rows ? { rows, unreadable: false } : { rows: [], unreadable: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY;
    snap = { rows: [], unreadable: true };
  }
  holder[CACHE_KEY] = { ...snap, file, sig };
  return snap;
}

/** A linha de ritmo de um board (ausente = normal). */
export function boardPaceRow(board: string, fileOverride?: string): BoardPaceRow | null {
  return readBoardPace(fileOverride).rows.find((r) => r.board === board) ?? null;
}

/**
 * O PORTÃO da produção: o que todo automático pergunta antes de começar algo no board. Síncrono, em cache, nunca lança.
 * `config` null = o board não pôde ser lido ⇒ segura.
 */
export function boardGateNow(board: string, config: Pick<BoardConfig, "autorunDisabled"> | null | undefined, now: number = Date.now()): BoardGate {
  const snap = readBoardPace();
  return resolveBoardGate(config, snap.rows.find((r) => r.board === board) ?? null, now, snap.unreadable);
}

/**
 * Muda o arquivo sob a cadeia: lê com rigor, aplica `fn` (PURA) e grava atômico. `fn` recebe as linhas (vazias quando o
 * arquivo não se lê — `unreadable` diz) e devolve as novas, ou null para não gravar. REJEITA quando a gravação falha:
 * quem pausou precisa saber que não pausou.
 */
export function mutateBoardPace(
  fn: (rows: BoardPaceRow[], unreadable: boolean) => BoardPaceRow[] | null,
  fileOverride?: string,
): Promise<BoardPaceRow[] | null> {
  const run = (holder[CHAIN_KEY] ?? Promise.resolve()).then(async () => {
    const file = fileOverride ?? boardPaceFile();
    holder[CACHE_KEY] = undefined;
    const snap = readBoardPace(file);
    const next = fn(snap.rows, snap.unreadable);
    if (!next) return null;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // O ilegível que vai ser regravado fica guardado ao lado: é a única evidência do que havia.
    if (snap.unreadable) await fsp.copyFile(file, `${file}.ilegivel`).catch(() => {});
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, serializePaceFile(next), "utf8");
    await fsp.rename(tmp, file);
    holder[CACHE_KEY] = undefined;
    return next;
  });
  holder[CHAIN_KEY] = run.catch(() => {});
  return run;
}

/**
 * Anota o que a PAUSA segurou num card (um disparo de coluna retido, um run parado), para a retomada devolver. Só grava
 * quando o board está de fato pausado pelo ritmo; nunca lança (a anotação é a rede — sem ela, o vigia de card parado
 * ainda pega o card depois da retomada).
 */
export async function holdBoardEntry(board: string, cardId: string, why: PaceHeldEntry["why"], now: number = Date.now()): Promise<void> {
  try {
    await mutateBoardPace((rows, unreadable) => {
      if (unreadable) return null;
      const at = rows.findIndex((r) => r.board === board);
      if (at < 0) return null;
      const next = holdPaceEntry(rows[at], { cardId, why, at: new Date(now).toISOString() }, now);
      return next === rows[at] ? null : rows.map((r, n) => (n === at ? next : r));
    });
  } catch (err) {
    console.error(`[board-pace] anotar o que a pausa segurou em ${board}/${cardId} falhou:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Só o RITMO, sem o desarmado: os automáticos de FUNDO do board rodam agora? O copiloto pergunta por aqui — ele nunca
 * obedeceu ao `autorunDisabled` (um board de sessão guiada pode ter copiloto), mas obedece à pausa e ao devagar.
 */
export function paceAllowsBackground(board: string, now: number = Date.now()): boolean {
  return boardGateNow(board, {}, now).background;
}
