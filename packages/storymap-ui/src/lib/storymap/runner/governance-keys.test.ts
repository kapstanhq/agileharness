// As chaves de GOVERNANÇA do board.yaml não vêm de um worktree: o merge train aterrissa o resto da mudança, mas devolve
// `organizeOnly` ao valor vivo de main — ligar ou desligar o modo «só organização» é decisão do operador.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOARD_YAML_RE, organizeOnlyIn, restoreGovernanceKeys } from "./governance-keys";

const base = (extra = "") => `id: caderno\nname: Caderno\nstatuses:\n  - id: triage\n    name: Triagem\n${extra}`;

describe("restoreGovernanceKeys", () => {
  it("um run que LIGA o modo: a chave volta a desligada e o resto da mudança fica", () => {
    const live = base();
    const landed = base("organizeOnly: true\n").replace("name: Caderno", "name: Caderno novo");
    const fixed = restoreGovernanceKeys(landed, live)!;
    expect(organizeOnlyIn(fixed)).toBe(false);
    expect(fixed).toContain("name: Caderno novo");
  });

  it("um run que DESLIGA o modo (em qualquer grafia): a chave volta a ligada", () => {
    const live = base("organizeOnly: true\n");
    for (const landed of [base(), base("organizeOnly: false\n"), base('"organizeOnly": false\n')]) {
      const fixed = restoreGovernanceKeys(landed, live)!;
      expect(organizeOnlyIn(fixed)).toBe(true);
    }
  });

  it("grafias que o YAML aceita para ligar também são devolvidas", () => {
    for (const on of ["organizeOnly: True\n", "organizeOnly: TRUE\n", '"organizeOnly": true\n', "organizeOnly: !!bool true\n"]) {
      expect(organizeOnlyIn(base(on))).toBe(true);
      expect(organizeOnlyIn(restoreGovernanceKeys(base(on), base())!)).toBe(false);
    }
  });

  it("sem mudança na chave ⇒ null (nada a corrigir); main ilegível ⇒ null (não é o train quem decide)", () => {
    expect(restoreGovernanceKeys(base("organizeOnly: true\n"), base("organizeOnly: true\n"))).toBeNull();
    expect(restoreGovernanceKeys(base(), base())).toBeNull();
    expect(restoreGovernanceKeys(base("organizeOnly: true\n"), "id: [quebrado")).toBeNull();
  });

  it("board.yaml novo (sem versão viva) não nasce no modo pelo worktree", () => {
    expect(organizeOnlyIn(restoreGovernanceKeys(base("organizeOnly: true\n"), null)!)).toBe(false);
  });

  it("o caminho de board.yaml é reconhecido (relativo e absoluto)", () => {
    expect(BOARD_YAML_RE.test("storymap/boards/caderno/board.yaml")).toBe(true);
    expect(BOARD_YAML_RE.test("/srv/alvo/storymap/boards/caderno/board.yaml")).toBe(true);
    expect(BOARD_YAML_RE.test("storymap/boards/caderno/cards/story-ex0001.md")).toBe(false);
  });
});

it("o merge train aplica a devolução no board.yaml que aterrissa (catraca estrutural)", () => {
  const src = readFileSync(fileURLToPath(new URL("./merge-queue.ts", import.meta.url)), "utf8");
  expect(src).toMatch(/lineData\.filter\(\(p\) => BOARD_YAML_RE\.test\(p\)\)/);
  expect(src).toMatch(/restoreGovernanceKeys\(landed, liveText\)/);
});

it("o merge train devolve a exceção de autonomia do CARD à de main (catraca estrutural)", () => {
  const src = readFileSync(fileURLToPath(new URL("./merge-queue.ts", import.meta.url)), "utf8");
  // lida ANTES do patch, para todo card que o run traz (patch por linha e 3-way)…
  expect(src).toMatch(/for \(const f of data\.filter\(\(p\) => CARD_MD_RE\.test\(p\)\)\) \{[\s\S]{0,200}cardGovLive\.set\(f, cardGovernanceOf\(/);
  // …e devolvida depois do 3-way, sob a trava do card
  expect(src).toMatch(/restoreCardGovernance\(landed, live\)/);
  expect(src.indexOf("restoreCardGovernance(landed, live)")).toBeGreaterThan(src.indexOf("mergeCardThreeWay(baseCard, mainCard, runCard"));
});
