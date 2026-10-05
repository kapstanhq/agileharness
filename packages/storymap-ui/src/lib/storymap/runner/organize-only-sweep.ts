// O que estava EM VOO quando um board virou «só organização» (organize-only.ts) — a varredura que desliga e DEVOLVE.
//
// Ligar o modo é uma chave de GOVERNANÇA (só a tela do operador a muda; o merge train não a aceita de um worktree e um
// agente por MCP não a liga nem desliga — ver organize-only.ts). Daí em diante o portão segura tudo que ainda vai
// COMEÇAR; o que já estava rodando (um run de coluna, um condutor vivo) é desligado aqui, no tick de recuperação, pelo
// MESMO caminho da pausa com «parar agora» (board-pace-actions.ts): tira os runs do engine e pede aos condutores que
// estacionem. Como a pausa, os cards tirados ficam RETIDOS (runnerStateDir()/organize-only-held.json) e VOLTAM ao
// pipeline quando o modo é desligado — desligar não pode ser um jeito silencioso de perder trabalho em voo.
// Idempotente — sem nada em voo e nada retido, não faz nada nem loga.

import fs from "node:fs/promises";
import path from "node:path";
import { listBoards, readBoardConfig } from "@/lib/storymap/repo";
import { ORGANIZE_ONLY_WHY, isOrganizeOnly } from "@/lib/storymap/organize-only-core";
import { runnerStateDir } from "@/lib/storymap/paths";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import type { BoardConfig } from "@/lib/storymap/types";

/** Os cards tirados de cada board pelo modo, à espera de voltar: board → [{cardId, at}]. */
export type OrganizeOnlyHeld = Record<string, Array<{ cardId: string; at: string }>>;

export interface OrganizeOnlySweepDeps {
  boards(): Promise<string[]>;
  readConfig(board: string): Promise<Pick<BoardConfig, "organizeOnly"> | null>;
  stopRuns(board: string, reason: string): Promise<Array<{ cardId: string }>>;
  parkConductors(board: string): Promise<Array<{ cardId: string }>>;
  /** o registro dos retidos (opcional: sem ele, a varredura só desliga — o comportamento antigo). */
  held?: { load(): Promise<OrganizeOnlyHeld>; save(next: OrganizeOnlyHeld): Promise<void> };
  /** devolve UM card retido ao pipeline (o mesmo caminho da saída da pausa). */
  rearm?(board: string, cardId: string): Promise<void>;
  now?(): number;
  log?(line: string): void;
}

export interface OrganizeOnlySweepRow {
  board: string;
  stopped: string[];
  parked: string[];
  /** cards devolvidos ao pipeline porque o modo foi desligado. */
  released?: string[];
}

/** Desliga o que estiver em voo em cada board só de organização e devolve o retido de quem saiu do modo. Nunca lança. */
export async function sweepOrganizeOnlyInFlight(deps: OrganizeOnlySweepDeps): Promise<OrganizeOnlySweepRow[]> {
  const log = deps.log ?? ((l: string) => console.log(`[organize-only] ${l}`));
  const out: OrganizeOnlySweepRow[] = [];
  const held: OrganizeOnlyHeld = deps.held ? await deps.held.load().catch(() => ({})) : {};
  let heldChanged = false;
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const boards = await deps.boards().catch(() => [] as string[]);
  for (const board of boards) {
    const config = await deps.readConfig(board).catch(() => null);
    if (!isOrganizeOnly(config)) {
      // Saiu do modo (ou nunca esteve): o que ficou retido por ele volta ao pipeline. Config ilegível ⇒ não devolve
      // agora (na dúvida, nada roda sozinho), tenta na próxima passada.
      const waiting = held[board] ?? [];
      if (!waiting.length || config === null || !deps.rearm) continue;
      const released: string[] = [];
      const kept: Array<{ cardId: string; at: string }> = [];
      for (const e of waiting) {
        try {
          await deps.rearm(board, e.cardId);
          released.push(e.cardId);
        } catch (err) {
          kept.push(e);
          log(`${board}/${e.cardId}: devolver ao pipeline falhou (${err instanceof Error ? err.message : String(err)}) — tenta de novo na próxima passada`);
        }
      }
      if (kept.length) held[board] = kept;
      else delete held[board];
      heldChanged = true;
      if (released.length) {
        log(`${board}: saiu do modo só organização — ${released.length} card(s) devolvido(s) ao pipeline (${released.join(", ")})`);
        out.push({ board, stopped: [], parked: [], released });
      }
      continue;
    }
    const stopped = (await deps.stopRuns(board, ORGANIZE_ONLY_WHY).catch(() => [] as Array<{ cardId: string }>)).map((r) => r.cardId);
    const parked = (await deps.parkConductors(board).catch(() => [] as Array<{ cardId: string }>)).map((r) => r.cardId);
    if (!stopped.length && !parked.length) continue;
    if (stopped.length && deps.held) {
      const list = held[board] ?? [];
      for (const cardId of stopped) if (!list.some((e) => e.cardId === cardId)) list.push({ cardId, at });
      held[board] = list;
      heldChanged = true;
    }
    log(`${board}: ${ORGANIZE_ONLY_WHY} — ${stopped.length} run(s) tirado(s) e retido(s) (${stopped.join(", ") || "—"}), ${parked.length} condutor(es) estacionando (${parked.join(", ") || "—"})`);
    out.push({ board, stopped, parked });
  }
  // Retidos de um board que sumiu da lista: descarta (não há para onde devolver).
  for (const b of Object.keys(held)) {
    if (!boards.includes(b) && boards.length) {
      delete held[b];
      heldChanged = true;
    }
  }
  if (heldChanged && deps.held) await deps.held.save(held).catch((err) => log(`não gravou os retidos: ${err instanceof Error ? err.message : String(err)}`));
  return out;
}

const HELD_FILE = () => path.join(runnerStateDir(), "organize-only-held.json");

/** As portas de produção: as MESMAS da pausa com «parar agora» e da devolução na saída da pausa. */
export async function defaultOrganizeOnlySweepDeps(): Promise<OrganizeOnlySweepDeps> {
  const { defaultBoardPaceDeps } = await import("./board-pace-actions");
  const pace = defaultBoardPaceDeps();
  return {
    boards: async () => (await listBoards()).map((b) => b.id),
    readConfig: (board) => readBoardConfig(board).catch(() => null),
    stopRuns: (board, reason) => pace.stopRuns(board, reason, { running: true }),
    parkConductors: (board) => pace.parkConductors(board),
    held: {
      load: async () => {
        try {
          const raw = JSON.parse(await fs.readFile(HELD_FILE(), "utf8")) as unknown;
          return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as OrganizeOnlyHeld) : {};
        } catch {
          return {};
        }
      },
      save: async (next) => {
        await fs.mkdir(path.dirname(HELD_FILE()), { recursive: true });
        await atomicWriteFile(HELD_FILE(), `${JSON.stringify(next, null, 2)}\n`);
      },
    },
    // a mesma devolução da saída da pausa: solta o freio anti-cascata e reavalia a entrada da coluna
    rearm: (board, cardId) => pace.rearm(board, { cardId, why: "stopped", at: new Date().toISOString() }),
  };
}
