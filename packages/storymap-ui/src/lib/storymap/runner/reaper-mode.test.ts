// F0 — o modo relatório dos reapers. Cada `it` protege a única classe de operação SEM DESFAZER do
// sistema: `git branch -D` e `git worktree remove --force` sobre uma raiz resolvida.

import { describe, expect, it, vi } from "vitest";
import { guardDestructive, resolveReaperMode } from "./reaper-mode";

const DIA = 86_400_000;
const AGORA = Date.parse("2026-08-03T00:00:00Z");

describe("o interruptor global", () => {
  it("default é `delete` — mudar isso acumularia órfãos numa instalação que hoje funciona", () => {
    // Cautela que quebra a operação não é cautela; é regressão com nome bonito.
    expect(resolveReaperMode({})).toBe("delete");
  });

  it("`report` exige a palavra exata (nada de truthiness ligando um modo de operação)", () => {
    expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "report" })).toBe("report");
    expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "REPORT" })).toBe("report");
    expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "1" })).toBe("delete");
    expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "sim" })).toBe("delete");
  });
});

// Os testes da política POR ALVO viviam aqui e saíram junto com a função: ela não tinha consumidor de
// produção, e testar a fundo um comportamento que ninguém chama é cobertura que mede a si mesma. Volta
// em F3, com o registro de alvos que lhe dá sujeito.

describe("guardDestructive — o modo relatório NÃO EXECUTA, e isso é medido", () => {
  it("em `report`, a operação destrutiva não é chamada NENHUMA vez", async () => {
    const run = vi.fn(async () => true);
    const vistos: unknown[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await guardDestructive("report", { kind: "branch", ref: "run/x", wouldDeleteAt: AGORA }, run, (x) =>
        vistos.push(x),
      );
      expect(run).not.toHaveBeenCalled(); // a asserção que importa
      expect(r).toBe(false); // mesmo formato de "não apagou" que os chamadores já tratam
      expect(vistos).toHaveLength(1);
      expect(warn).toHaveBeenCalled(); // silencioso seria um freio que ninguém percebe estar puxado
    } finally {
      warn.mockRestore();
    }
  });

  it("em `delete`, executa e devolve o resultado real — o modo seguro não vira caminho paralelo", async () => {
    const run = vi.fn(async () => true);
    expect(await guardDestructive("delete", { kind: "branch", ref: "run/x", wouldDeleteAt: AGORA }, run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("o boot usa o guard — a deleção de branch não voltou a ser chamada direto", () => {
    // Regressão: o valor deste mecanismo é zero se o call-site de boot o contornar.
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../../instrumentation.ts"), "utf8");
    // multi-linha: o call-site foi reformatado quando ganhou o onReport.
    expect(src).toMatch(/guardDestructive\(\s*reaperMode/);
  });
});

describe("valor PRESENTE e não reconhecido não passa calado (achado de revisão)", () => {
  it("um typo no modo relatório GRITA — quem pediu o freio não pode receber a serra em silêncio", () => {
    // Medido pelo revisor: `reprot`, `dry-run` e `true` caíam todos em `delete` sem uma linha de log.
    const erros: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void erros.push(a.join(" "));
    try {
      expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "reprot" })).toBe("delete");
      expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "dry-run" })).toBe("delete");
    } finally {
      console.error = orig;
    }
    expect(erros).toHaveLength(2);
    expect(erros[0]).toMatch(/reprot/);
    expect(erros[0], "o aviso precisa dizer o que vai acontecer, não só que o valor é inválido").toMatch(/APAGAR/);
  });

  it("ausente e vazio continuam SILENCIOSOS — quem não declarou não errou", () => {
    const erros: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void erros.push(a.join(" "));
    try {
      expect(resolveReaperMode({})).toBe("delete");
      expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "" })).toBe("delete");
      expect(resolveReaperMode({ AGILEHARNESS_REAPER_MODE: "report" })).toBe("report");
    } finally {
      console.error = orig;
    }
    expect(erros).toEqual([]);
  });
});
