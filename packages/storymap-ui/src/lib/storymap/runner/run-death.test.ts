import { describe, expect, it } from "vitest";
import {
  RUN_DEATH_FINDING_ID,
  classifyRunDeath,
  buildRunDeathFinding,
  applyRunDeathFinding,
  applyRunDeathResolved,
} from "./run-death";
import type { Card, Finding } from "@/lib/storymap/types";

// story-dznvez — a TAXONOMIA DE MORTE conservadora. Toda morte de run deixa um DIAGNÓSTICO durável no
// card (o "resumo da causa" que faltava) + um HINT de classe (infra/test/app) para o operador rotear —
// SEM auto-mover o card (a lição do deploy-revert: auto-rotear congela cards). O modo de morte
// (RunnerFailureReason) já é rico; a CAUSA reusa o classifyFailure(infra|test|app) dormente do ADR-063 4d,
// com um fast-path por reason para os modos que o classificador de mensagem não pega (oom/timeout/error).

describe("classifyRunDeath — reason (+detail) → FailureClass hint", () => {
  it("oom-killed e error são INFRA (recurso/ambiente, não é o código do card)", () => {
    expect(classifyRunDeath("oom-killed")).toBe("infra");
    expect(classifyRunDeath("error")).toBe("infra");
  });

  it("no-op é APP (sucesso-fantasma: a skill alegou pronto sem fazer/avançar)", () => {
    expect(classifyRunDeath("no-op")).toBe("app");
  });

  it("exit reusa o classifyFailure só quando o detail tem sinal REAL de infra/test", () => {
    expect(classifyRunDeath("exit", "Error: Cannot find module 'firebase-functions'")).toBe("infra");
    expect(classifyRunDeath("exit", "listen EADDRINUSE: address already in use :::3008")).toBe("infra");
    expect(classifyRunDeath("exit", "strict mode violation: getByRole resolved to 3 elements")).toBe("test");
  });

  it("exit sem sinal (só 'exit N') fica UNKNOWN — não inventa 'app' de um código de saída seco", () => {
    expect(classifyRunDeath("exit", "exit 1")).toBeUndefined();
    expect(classifyRunDeath("exit", "morto (SIGKILL)")).toBeUndefined();
    expect(classifyRunDeath("exit")).toBeUndefined();
  });

  it("timeout é ambíguo (processo pendurado) → UNKNOWN, o operador investiga", () => {
    expect(classifyRunDeath("timeout", "sem resposta em 360s")).toBeUndefined();
  });
});

describe("buildRunDeathFinding — diagnóstico durável, high non-blocker, com hint de classe", () => {
  it("é um finding general/high/open idempotente com o modo + detail + failureClass", () => {
    const f = buildRunDeathFinding("oom-killed", "OOM kill no scope — MemoryMax excedido", "infra", "2026-07-08");
    expect(f.id).toBe(RUN_DEATH_FINDING_ID);
    expect(f.lens).toBe("general");
    expect(f.severity).toBe("high"); // operator alert, NÃO blocker (não pode gatear/travar o card)
    expect(f.status).toBe("open");
    expect(f.failureClass).toBe("infra");
    expect(f.title).toMatch(/oom-killed/);
    expect(f.detail).toContain("MemoryMax");
    expect(f.detail).toMatch(/infra/i); // o hint de rota está no texto para o operador
  });

  it("sem failureClass (unknown) NÃO seta o campo e o texto não afirma uma classe", () => {
    const f = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    expect(f.failureClass).toBeUndefined();
    expect(f.detail).toContain("exit 1");
  });
});

const card = (over: Partial<Card> = {}): Card =>
  ({ id: "c1", type: "story", status: "desenvolver", findings: [], ...over }) as Card;

describe("applyRunDeathFinding — carimba SEM mover o card (conservador)", () => {
  it("faz upsert do finding e PRESERVA o status (não auto-move)", () => {
    const f = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    const out = applyRunDeathFinding(card({ status: "desenvolver" }), f);
    expect(out.status).toBe("desenvolver"); // conservador: nada de auto-rotear
    expect(out.findings).toHaveLength(1);
    expect(out.findings![0].id).toBe(RUN_DEATH_FINDING_ID);
  });

  it("é idempotente por id — re-carimbar REFRESCA em vez de empilhar", () => {
    const f1 = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    const f2 = buildRunDeathFinding("timeout", "sem resposta em 360s", undefined, "2026-07-08");
    let out = applyRunDeathFinding(card(), f1);
    out = applyRunDeathFinding(out, f2);
    expect(out.findings).toHaveLength(1);
    expect(out.findings![0].title).toMatch(/timeout/);
  });

  it("preserva outros findings (não-morte) intactos", () => {
    const other: Finding = { id: "loop-guard-c1", lens: "general", severity: "high", title: "x", status: "open" };
    const f = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    const out = applyRunDeathFinding(card({ findings: [other] }), f);
    expect(out.findings).toHaveLength(2);
  });
});

describe("applyRunDeathResolved — limpa o diagnóstico quando o card recupera", () => {
  it("flipa o finding de morte open→fixed ao suceder, sem tocar os outros", () => {
    const death: Finding = { id: RUN_DEATH_FINDING_ID, lens: "general", severity: "high", title: "run morreu: exit", status: "open" };
    const other: Finding = { id: "loop-guard-c1", lens: "general", severity: "high", title: "x", status: "open" };
    const out = applyRunDeathResolved(card({ findings: [death, other] }));
    expect(out.findings!.find((f) => f.id === RUN_DEATH_FINDING_ID)!.status).toBe("fixed");
    expect(out.findings!.find((f) => f.id === "loop-guard-c1")!.status).toBe("open");
  });

  it("no-op quando não há finding de morte (retorna o card equivalente)", () => {
    const out = applyRunDeathResolved(card({ findings: [] }));
    expect(out.findings).toHaveLength(0);
  });
});
