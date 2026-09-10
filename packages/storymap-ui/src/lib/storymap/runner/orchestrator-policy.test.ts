import { describe, expect, it } from "vitest";
import {
  autonomousModeSafe,
  defaultDisposition,
  dispositionFor,
  mayActAutonomously,
  lintRiskMatrix,
  ORCHESTRATOR_ENFORCEMENT,
} from "./orchestrator-policy";
import type { OrchestratorPolicy } from "../types";

const policy = (over: Partial<OrchestratorPolicy> = {}): OrchestratorPolicy => ({ mode: "autonomous", ...over });

describe("orchestrator-policy (WS8) — declarative risk kernel", () => {
  it("defaultDisposition: read=auto, deploy/destructive=never, run/merge-resolve/write-board=ask (F5.0)", () => {
    expect(defaultDisposition("read")).toBe("auto");
    // ADR-066 — a classe do Explorador. Sem default `auto`, nenhuma matriz já persistida a declara (ela é
    // NOVA), toda escrita no documento vira pedido de aprovação, e a capacidade fica declarada e inalcançável.
    expect(defaultDisposition("idea-write")).toBe("auto");
    expect(defaultDisposition("write-board")).toBe("ask");
    expect(defaultDisposition("deploy")).toBe("never");
    expect(defaultDisposition("destructive")).toBe("never");
    // F5.0 — run/merge-resolve NÃO podem ser auto (NEVER_AUTO) mas ESCALAM por padrão (ask), não never.
    expect(defaultDisposition("run")).toBe("ask");
    expect(defaultDisposition("merge-resolve")).toBe("ask");
  });

  it("dispositionFor: F8 — o board PODE declarar run/merge-resolve/deploy auto; run-free/destructive são CLAMPADOS", () => {
    expect(dispositionFor(policy({ riskMatrix: { "write-board": "auto" } }), "write-board")).toBe("auto");
    // F8 — as três classes do PIPELINE agora honram o `auto` declarado: é o que faz um orquestrador entregar
    // (rodar a skill da coluna, desparquear a train, publicar) em vez de só enfileirar aprovações.
    expect(dispositionFor(policy({ riskMatrix: { run: "auto" } }), "run")).toBe("auto");
    expect(dispositionFor(policy({ riskMatrix: { "merge-resolve": "auto" } }), "merge-resolve")).toBe("auto");
    expect(dispositionFor(policy({ riskMatrix: { deploy: "auto" } }), "deploy")).toBe("auto");
    // …mas o CLAMP (defesa em profundidade sobre o lint) segue absoluto nas duas classes que nenhum board pode
    // conceder: `run-free` (um prompt com Bash pleno ⇒ contornaria todos os outros cadeados) e `destructive`.
    expect(dispositionFor(policy({ riskMatrix: { "run-free": "auto" } }), "run-free")).toBe("ask");
    expect(dispositionFor(policy({ riskMatrix: { destructive: "auto" } }), "destructive")).toBe("ask");
    // absent class → conservative default (deploy NÃO é herdado: um board que não pediu, não publica).
    expect(dispositionFor(policy(), "run")).toBe("ask");
    expect(dispositionFor(policy(), "deploy")).toBe("never");
    expect(dispositionFor(policy(), "run-free")).toBe("never");
    expect(dispositionFor(policy(), "read")).toBe("auto");
  });

  it("mayActAutonomously: only in autonomous mode AND auto disposition", () => {
    const p = policy({ riskMatrix: { "write-board": "auto", run: "auto", "merge-resolve": "ask" } });
    expect(mayActAutonomously(p, "write-board")).toBe(true);
    expect(mayActAutonomously(p, "run")).toBe(true); // F8 — declarado auto ⇒ roda a skill da coluna sozinho
    expect(mayActAutonomously(p, "merge-resolve")).toBe(false); // ask
    expect(mayActAutonomously(p, "deploy")).toBe(false); // não declarado ⇒ default never (deploy é opt-in)
    expect(mayActAutonomously({ ...p, riskMatrix: { "run-free": "auto" } }, "run-free")).toBe(false); // clampado
    // paired/off never act autonomously, even on an auto class.
    expect(mayActAutonomously({ ...p, mode: "paired" }, "write-board")).toBe(false);
    expect(mayActAutonomously({ ...p, mode: "off" }, "write-board")).toBe(false);
    expect(mayActAutonomously(undefined, "read")).toBe(false);
  });

  it("lintRiskMatrix: F8 — run-free/destructive=auto REPROVAM; run/merge/deploy=auto PASSAM; unknown flagged", () => {
    // as duas que nenhum board pode conceder — o lint é a 1ª barreira (o clamp é a 2ª)
    expect(lintRiskMatrix(policy({ riskMatrix: { "run-free": "auto" } })).join(" ")).toMatch(/run-free.*proibido|irreversíveis/);
    expect(lintRiskMatrix(policy({ riskMatrix: { destructive: "auto" } })).length).toBe(1);
    // F8 — a matriz do orquestrador que ENTREGA é LEGAL (era exatamente o que o lint reprovava antes)
    expect(lintRiskMatrix(policy({ riskMatrix: { run: "auto" } }))).toEqual([]);
    expect(lintRiskMatrix(policy({ riskMatrix: { "merge-resolve": "auto" } }))).toEqual([]);
    expect(lintRiskMatrix(policy({ riskMatrix: { deploy: "auto" } }))).toEqual([]);
    expect(lintRiskMatrix(policy({ riskMatrix: { "bogus-class": "auto" } as never })).join(" ")).toMatch(/desconhecida/);
    expect(
      lintRiskMatrix(
        policy({ riskMatrix: { read: "auto", "write-board": "auto", run: "auto", "merge-resolve": "auto", deploy: "auto" } }),
      ),
    ).toEqual([]); // ← a matriz "entregar de ponta a ponta" do popover
    expect(lintRiskMatrix(undefined)).toEqual([]);
  });

  it("autonomousModeSafe reflects ORCHESTRATOR_ENFORCEMENT.riskMatrixEnforced (Fase 5.9 — flipped TRUE)", () => {
    expect(autonomousModeSafe()).toBe(ORCHESTRATOR_ENFORCEMENT.riskMatrixEnforced);
    // F5.9 (2026-07-11, operator-approved): riskMatrixEnforced is now TRUE — the F5 per-call guard
    // (mcp/guard.ts) + move_card/accept_triage dynamic gate + run-escalation + approvals close the pre-flip
    // gap ("a scoped move could deploy via the pipeline"). The CAPABILITY is on; no board auto-becomes
    // autonomous (mode defaults off, per-board opt-in required, and the tick also needs AGILEHARNESS_MCP_TOKEN_ORCH).
    expect(ORCHESTRATOR_ENFORCEMENT.riskMatrixEnforced).toBe(true);
    expect(ORCHESTRATOR_ENFORCEMENT.mcpTokenLevelsEnforced).toBe(true);
  });
});
