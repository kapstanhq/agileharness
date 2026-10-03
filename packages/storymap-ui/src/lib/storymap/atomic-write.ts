// Escrita atômica de arquivo de board-data — a primitiva de IO compartilhada.
//
// Vivia privada em write.ts; foi extraída (WS-3.2) quando o write_sidecar do MCP passou a precisar
// EXATAMENTE da mesma garantia. Módulo próprio (em vez de exportar de write.ts) porque sidecars.ts
// consome os dois lados e um import sidecars→write arrastaria repo/contracts/serialize junto só por
// causa de 10 linhas de fs.

import { promises as fs } from "node:fs";
import path from "node:path";

let tmpCounter = 0;

/**
 * Atomic write: stage the content in a temp sibling, then rename(2) it over the
 * target. rename is atomic within a volume, so a reader (the fs watcher, a server
 * action, or a harness-* agent process mid-poll) NEVER observes a half-written file — it
 * sees either the old bytes or the complete new ones, never a torn frontmatter that
 * makes gray-matter/js-yaml throw. The temp name carries pid + a counter so a parallel
 * writer (a second dev process / concurrent session) can't collide on it, and ends in
 * `.tmp` (not `.md`) so the watcher's `.md` filter skips it.
 */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpCounter++}.tmp`);
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
