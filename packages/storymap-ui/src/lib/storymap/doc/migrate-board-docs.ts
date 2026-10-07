// 🔁 A migração dos documentos de um board para os formatos novos — GRAVANDO, no servidor.
//
//   1. `docs/prd.md` no formato 1 → guarda o original em `docs/.archive/prd-v1.md` (nunca sobrescreve
//      uma cópia; sufixa a data), grava o PRD formato 2 e o `docs/contexto.md` (se houver conteúdo;
//      se o contexto já existir, ACRESCENTA em «Outras notas» só o que ele ainda não tem).
//   2. Sem `docs/business-model-canvas.md` e com Lean Canvas (o arquivo `docs/lean-canvas.md` ou o
//      `canvas:` do `board.yaml`) → grava o BMC; o `lean-canvas.md`, se havia, vai para
//      `docs/.archive/lean-canvas.md`.
//
// IDEMPOTENTE: um PRD com `format: 2` e um BMC que já existe não são tocados, então rodar duas vezes
// não muda um byte. O `board.yaml` NUNCA é tocado (o `canvas:` antigo fica como estava — é a fonte da
// projeção para quem ainda não tem o arquivo, e apagá-lo seria decidir pelo dono).
//
// Chamada uma vez no boot para todos os boards (`instrumentation.ts`); `loadDoc` faz o mesmo em
// MEMÓRIA, então a ordem entre o deploy e o boot não importa para quem lê. Toda escrita passa por
// `writeSchemaDoc` (validação do schema + escrita atômica).

import { promises as fs } from "node:fs";
import { boardDocPath } from "../paths";
import { listBoards, readBoardConfig } from "../repo";
import type { BoardConfig } from "../types";
import { migrateLeanCanvasToBmc, migratePrdV1 } from "./migrations";
import { archiveDocFile, readPrdV1, readSchemaDoc, writeSchemaDoc } from "./schema-doc-io";
import { BMC_SCHEMA } from "./schemas/business-model-canvas";
import { LEAN_CANVAS_DOC_TYPE, LEAN_CANVAS_SCHEMA } from "./schemas/lean-canvas";
import { hasLegacyLeanCanvas, projectLegacyLeanCanvas } from "./schemas/lean-canvas-legacy";
import { PRD_SCHEMA } from "./schemas/prd";

export interface BoardDocsMigration {
  board: string;
  /** os arquivos gravados ou movidos, relativos a `docs/` — vazio ⇒ nada a fazer. */
  migrated: string[];
}

type Log = (line: string) => void;

const defaultLog: Log = (line) => console.info(line);

/** Migra os documentos de UM board. Erro de um passo não impede o outro; ambos viram exceção no fim. */
export async function migrateBoardDocs(
  boardId: string,
  opts: { config?: BoardConfig; log?: Log; now?: Date } = {},
): Promise<BoardDocsMigration> {
  const log = opts.log ?? defaultLog;
  const migrated: string[] = [];
  const errors: unknown[] = [];

  // ── 1. PRD formato 1 → 2 + contexto ───────────────────────────────────────────
  try {
    const v1 = await readPrdV1(boardId);
    if (v1) {
      // `writeSchemaDoc` valida o PRD novo ANTES de tocar o disco e, por estar sobre um formato 1, grava
      // primeiro o contexto e a cópia do original (`carried`) — a mesma rotina de quem salva o PRD pela
      // tela antes do boot. PRD recusado ⇒ nada arquivado, e a próxima rodada tenta de novo do zero.
      const w = await writeSchemaDoc(boardId, PRD_SCHEMA, migratePrdV1(v1.doc).prd, { now: opts.now, log });
      if (!w.ok) throw new Error(`prd.md recusado: ${w.error}`);
      migrated.push(...(w.carried ?? []), "prd.md");
      log(`[docs] ${boardId}: prd.md migrado para o formato 2 (original em docs/.archive/)`);
    }
  } catch (err) {
    errors.push(err);
  }

  // ── 2. Lean Canvas → Business Model Canvas ────────────────────────────────────
  try {
    const bmc = await readSchemaDoc(boardId, BMC_SCHEMA);
    if (!bmc.exists) {
      const leanFile = await readSchemaDoc(boardId, LEAN_CANVAS_SCHEMA);
      const config = leanFile.exists ? undefined : (opts.config ?? (await readBoardConfig(boardId)));
      const source = leanFile.exists ? leanFile.doc : config && hasLegacyLeanCanvas(config) ? projectLegacyLeanCanvas(config) : null;
      if (source) {
        const w = await writeSchemaDoc(boardId, BMC_SCHEMA, migrateLeanCanvasToBmc(source));
        if (!w.ok) throw new Error(`business-model-canvas.md recusado: ${w.error}`);
        migrated.push("business-model-canvas.md");
        log(`[docs] ${boardId}: business-model-canvas.md criado a partir do Lean Canvas (${leanFile.exists ? "lean-canvas.md" : "board.yaml"})`);
        if (leanFile.exists) {
          const leanPath = boardDocPath(boardId, LEAN_CANVAS_DOC_TYPE);
          await archiveDocFile(boardId, leanPath, "lean-canvas.md", opts.now);
          await fs.rm(leanPath, { force: true });
          migrated.push(".archive/lean-canvas.md");
          log(`[docs] ${boardId}: lean-canvas.md movido para docs/.archive/`);
        }
      }
    }
  } catch (err) {
    errors.push(err);
  }

  if (errors.length) {
    const detail = errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" · ");
    throw new Error(`migração dos documentos de ${boardId}: ${detail}`);
  }
  return { board: boardId, migrated };
}

/**
 * Migra TODOS os boards — a rotina do boot. Nunca lança: o erro de um board vira uma linha de log e
 * os outros seguem (um documento ilegível não pode derrubar o serviço).
 */
export async function migrateAllBoardDocs(opts: { log?: Log } = {}): Promise<BoardDocsMigration[]> {
  const log = opts.log ?? defaultLog;
  const out: BoardDocsMigration[] = [];
  let boards: { id: string }[] = [];
  try {
    boards = await listBoards();
  } catch (err) {
    log(`[docs] migração dos documentos: não consegui listar os boards — ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  for (const b of boards) {
    try {
      out.push(await migrateBoardDocs(b.id, { log }));
    } catch (err) {
      log(`[docs] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
