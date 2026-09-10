// O portão do boot. Cada caso aqui é uma resposta a "este processo pode mexer no repo?", e a tabela
// inteira existe porque a resposta errada nas DUAS direções custa coisas muito diferentes:
// inerte por engano = código parado em stage (visível, reversível); armado por engano = segundo merge
// train, worktree de agente removido e deploy por cima de outro (o incidente de 2026-07-23).

import { describe, expect, it } from "vitest";
import { engineArmedDecision, engineInertWarning } from "./engine-armed";

describe("engineArmedDecision — default ESTRUTURAL", () => {
  it("ARMA no checkout canônico (.git é diretório)", () => {
    const v = engineArmedDecision({ flag: undefined, gitIsDirectory: true });
    expect(v.armed).toBe(true);
    expect(v.reason).toMatch(/canônico/);
  });

  it("NÃO arma num git worktree (.git é arquivo) — o caso que motivou o portão", () => {
    const v = engineArmedDecision({ flag: undefined, gitIsDirectory: false });
    expect(v.armed).toBe(false);
    expect(v.reason).toMatch(/worktree/);
  });

  it("NÃO arma quando não deu para ler .git — 'não sei' é inerte, nunca armado", () => {
    expect(engineArmedDecision({ flag: undefined, gitIsDirectory: null }).armed).toBe(false);
  });

  it("o caso PERIGOSO não exige que ninguém configure nada", () => {
    // Quem sobe um servidor de dentro de um worktree está validando UI e não pensaria num env var —
    // por isso o default tem de estar certo sozinho, sem flag.
    expect(engineArmedDecision({ flag: undefined, gitIsDirectory: false }).armed).toBe(false);
  });
});

describe("engineArmedDecision — flags explícitas", () => {
  it("`off` desliga MESMO no checkout canônico (desligar sempre é obedecido)", () => {
    const v = engineArmedDecision({ flag: "off", gitIsDirectory: true });
    expect(v.armed).toBe(false);
    expect(v.reason).toMatch(/off/);
  });

  it("`on` é o escape hatch — arma mesmo num worktree", () => {
    const v = engineArmedDecision({ flag: "on", gitIsDirectory: false });
    expect(v.armed).toBe(true);
    expect(v.reason).toMatch(/on/);
  });

  it.each(["ON", " on ", "Off", "OFF\n"])("aceita %j (trim + case-insensitive)", (flag) => {
    const expected = flag.trim().toLowerCase() === "on";
    expect(engineArmedDecision({ flag, gitIsDirectory: false }).armed).toBe(expected);
  });

  // A trava contra o typo: `AGILEHARNESS_ENGINE=true` NÃO pode armar um worktree. Só o literal exato
  // `on` arma onde o default diz que não — armar tem de ser um ato deliberado, nunca um erro de digitação.
  it.each(["true", "1", "yes", "sim", "onn", "enabled", ""])(
    "%j NÃO arma um worktree — cai no default estrutural",
    (flag) => {
      expect(engineArmedDecision({ flag, gitIsDirectory: false }).armed).toBe(false);
    },
  );

  it("um valor lixo tampouco DESARMA o checkout canônico (só `off` desarma)", () => {
    expect(engineArmedDecision({ flag: "banana", gitIsDirectory: true }).armed).toBe(true);
  });
});

describe("direção da falha", () => {
  // A única combinação que pode armar sem `on` explícito é a do checkout canônico. Enumerar isso
  // aqui é o que impede uma "simplificação" futura de trocar a ordem dos ramos sem perceber.
  const FLAGS = [undefined, "", "true", "1", "banana", "onn"];
  const GITS: Array<boolean | null> = [false, null];

  it.each(FLAGS)("flag %j nunca arma fora do checkout canônico", (flag) => {
    for (const gitIsDirectory of GITS) {
      expect(engineArmedDecision({ flag, gitIsDirectory }).armed, `git=${gitIsDirectory}`).toBe(false);
    }
  });

  it("todo veredito traz um motivo legível (board INERTE ≠ board OCIOSO)", () => {
    for (const flag of [...FLAGS, "on", "off"]) {
      for (const gitIsDirectory of [true, false, null] as Array<boolean | null>) {
        const { reason } = engineArmedDecision({ flag, gitIsDirectory });
        expect(reason.trim().length, `${flag}/${gitIsDirectory}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("engineInertWarning", () => {
  it("nomeia o que ficou desligado E o que continua funcionando", () => {
    const w = engineInertWarning("git worktree (.git é arquivo)");
    expect(w).toContain("MOTOR INERTE");
    expect(w).toContain("git worktree");
    for (const off of ["service.lock", "merge train", "publicação", "copiloto"]) {
      expect(w, off).toContain(off);
    }
    expect(w).toContain("SSE"); // senão o operador acha que a instância está quebrada
  });

  it("diz como armar mesmo assim", () => {
    expect(engineInertWarning("qualquer")).toContain("AGILEHARNESS_ENGINE=on");
  });
});
