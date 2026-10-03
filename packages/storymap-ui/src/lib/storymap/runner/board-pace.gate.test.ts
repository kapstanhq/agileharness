// O PORTÃO ÚNICO do board — a guarda de que ele continua único.
//
// Antes do ritmo do board (board-pace.ts), onze pontos do runner liam `config.autorunDisabled` cada um por conta
// própria. Quando a pausa nasceu, bastaria UM deles esquecer de perguntar pelo ritmo para um board pausado seguir
// gastando por aquela porta. Agora todos perguntam a `resolveBoardGate` (pela porta `boardGate` ou por `boardGateNow`),
// e este teste falha se um automático novo voltar a ler `autorunDisabled` direto.
//
// Quem PODE ler o campo: o próprio portão, e quem o PERSISTE ou o REPORTA (nunca quem decide se algo começa).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../..");

/** Onde ler `.autorunDisabled` é legítimo, e por quê. */
const ALLOWED: Record<string, string> = {
  "lib/storymap/runner/board-pace.ts": "o portão",
  "lib/storymap/repo.ts": "lê e persiste o board.yaml",
  "lib/storymap/board-registry.ts": "arma e desarma o board (o escritor do campo)",
  "lib/storymap/mcp/resources.ts": "reporta «armado» ao agente",
  "lib/storymap/mcp/tools.ts": "reporta «armado» na resposta de set_board_autorun",
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("o portão único do board", () => {
  const readers = sources(SRC)
    .filter((file) => /\.autorunDisabled\b/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(SRC, file).split(path.sep).join("/"))
    .sort();

  it("nenhum automático lê `autorunDisabled` por conta própria — todos perguntam ao portão (board-pace.ts)", () => {
    const strays = readers.filter((f) => !(f in ALLOWED));
    expect(strays, `leem .autorunDisabled direto (use gateOf/boardGateNow de runner/board-pace*): ${strays.join(", ")}`).toEqual([]);
  });

  it("a lista de exceções não tem sobra (uma exceção que não lê mais o campo sai da lista)", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual(readers);
  });

  it("cada automático do runner está ligado ao portão", () => {
    // os que decidem começar algo num board — a lista atual. Um novo entra aqui junto com a ligação dele.
    const WIRED = [
      "lib/notifications/server/channels/autorun-eval.ts", // a entrada de coluna (skills, efeitos de entrada)
      "lib/storymap/runner/engine.ts", // o pump dos runs
      "lib/storymap/runner/conductor.ts", // a fila e a adoção de órfãos do condutor
      "lib/storymap/runner/fleet-deps.ts", // os candidatos a órfão + a porta do condutor
      "lib/storymap/runner/proxy.ts", // o procurador
      "lib/storymap/runner/triage-judge.ts", // o juiz da triagem
      "lib/storymap/runner/technical-audit.ts", // o auditor (fundo)
      "lib/storymap/runner/deploy-proof-producer.ts", // o produtor das provas
      "lib/storymap/runner/stall-watch-deps.ts", // o vigia de card parado
      "lib/storymap/runner/card-budget-deps.ts", // o teto de gasto
      "lib/storymap/runner/orchestrator-run.ts", // o copiloto (fundo)
      "lib/storymap/runner/orchestrator-wake.ts", // o despertar do copiloto (fundo)
    ];
    for (const rel of WIRED) {
      const text = readFileSync(path.join(SRC, rel), "utf8");
      expect(/\b(gateOf|boardGateNow|paceAllowsBackground)\(/.test(text), `${rel} não consulta o portão do board`).toBe(true);
    }
  });

  it("as portas de produção dos núcleos com DI recebem o portão de verdade", () => {
    for (const rel of ["proxy-deps.ts", "triage-judge-deps.ts", "technical-audit-deps.ts", "deploy-proof-deps.ts", "fleet-deps.ts"]) {
      const text = readFileSync(path.join(SRC, "lib/storymap/runner", rel), "utf8");
      expect(text.includes("boardGate: boardGateNow"), `${rel} não injeta boardGateNow`).toBe(true);
    }
  });
});
