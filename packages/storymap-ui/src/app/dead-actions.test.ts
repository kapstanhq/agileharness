// B9 (parte) — `getPendingDemandsAction` agregava o modelo legado (Demand) de todos os boards para uma «Central» que
// nenhuma tela chamava mais: código morto que ainda definia uma terceira leitura de «precisa de você». Saiu.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");

describe("B9 — a ação morta saiu", () => {
  it("getPendingDemandsAction não existe mais", () => {
    expect(source).not.toMatch(/export async function getPendingDemandsAction\b/);
  });
});
