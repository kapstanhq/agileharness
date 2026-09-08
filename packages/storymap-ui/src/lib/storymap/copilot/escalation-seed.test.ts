import { describe, expect, it } from "vitest";
import { seedFromCopilotParam, stripCopilotParam } from "./escalation-seed";
import { encodeEscalationRef, escalationInstructionFor, type EscalationRef } from "./escalation";

describe("escalation-seed", () => {
  it("seedFromCopilotParam decodes a valid ref and rejects junk without throwing", () => {
    const ref: EscalationRef = { templateId: "merge-conflict", kind: "merge", boardId: "storymap", cardId: "c1", runId: "r1", entryStatus: "conflict" };
    expect(seedFromCopilotParam(encodeEscalationRef(ref))).toEqual(ref);
    for (const junk of [null, "", "not base64!!", "AAAA"]) {
      expect(seedFromCopilotParam(junk)).toBeNull();
    }
  });

  it("stripCopilotParam removes only copilot, preserves the rest", () => {
    expect(stripCopilotParam("copilot=abc&focus=c1")).toBe("focus=c1");
    expect(stripCopilotParam("focus=c1&copilot=abc")).toBe("focus=c1");
    expect(stripCopilotParam("copilot=abc")).toBe("");
    expect(stripCopilotParam("")).toBe("");
  });

  it("escalationInstructionFor produces the seed instruction for a ref (generic client-side)", () => {
    const ref: EscalationRef = { templateId: "merge-conflict", kind: "merge", boardId: "storymap", cardId: "c1", runId: "r1", entryStatus: "conflict" };
    const instr = escalationInstructionFor(ref);
    expect(instr).toContain("r1");
    expect(instr).toContain("c1");
  });

  // O restore-de-rascunho por 409 (`shouldRestoreSeedDraft` / `shouldRestoreManualDraft` + avisos) foi APOSENTADO
  // pela fila de saída: um envio recusado por ocupação não volta ao composer porque nunca sai da fila. Os testes
  // que o cobriam saíram com ele — o comportamento novo é testado em `outbox.test.ts`.
});
