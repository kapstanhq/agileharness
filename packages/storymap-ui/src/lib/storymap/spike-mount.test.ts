import { describe, expect, it } from "vitest";
import { readBoardConfig } from "@/lib/storymap/repo";
import { findRepoRoot } from "@/lib/storymap/paths";
import { resolveToolkit, applyActiveProviders } from "@/lib/storymap/toolkit";
import { FIXTURE_BOARD } from "@/lib/storymap/board-fixture";

// O mount REAL do passo de QA, lido do board no disco (puro — sem probe, sem card).
//
// Duas correções em relação à versão de spike deste arquivo: (a) o sujeito é o board FIXTURE, que
// viaja na extração — antes era um board de produto do dono, que não viaja e virava ENOENT no
// repositório extraído; (b) o `appendFileSync` para um scratchpad de OUTRA sessão saiu. Aquele
// caminho não existe em máquina nenhuma além daquela, então o teste morria de ENOENT no log e não
// na asserção. As asserções são as mesmas.
describe("mount real do step de QA (puro — sem probe, sem card)", () => {
  it("o toolkit resolve o mount, e com o primário ativo ele PERMANECE montado", async () => {
    const cfg = await readBoardConfig(FIXTURE_BOARD);
    const qa = cfg.statuses.find((s) => s.id === "qa-automatizado")!;
    expect(qa, "a pipeline canônica precisa ter o passo `qa-automatizado`").toBeTruthy();
    const declared = resolveToolkit(qa, cfg, FIXTURE_BOARD, findRepoRoot()).mcpConfigPaths;

    const primary = [{ tool: "browser", capability: "browser", active: { id: "browser" } }];
    const fallback = [{ tool: "browser", capability: "browser", active: { id: "browser-script" } }];

    expect(declared).toEqual(["storymap/qa-mcp.json"]);
    // primário vivo → o mount fica; fallback sem mount vivo → o mount morto SAI (montar um servidor
    // cujas tools todas falham é pior que não montar: o agente as vê, tenta e queima turno).
    expect(applyActiveProviders(declared, primary, cfg.toolConfigs, FIXTURE_BOARD, findRepoRoot())).toEqual([
      "storymap/qa-mcp.json",
    ]);
    expect(applyActiveProviders(declared, fallback, cfg.toolConfigs, FIXTURE_BOARD, findRepoRoot())).toEqual([]);
  });
});
