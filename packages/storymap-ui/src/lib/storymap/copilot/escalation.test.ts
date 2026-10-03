import { describe, expect, it } from "vitest";
import {
  encodeEscalationRef,
  parseEscalationRef,
  ESCALATION_TEMPLATES,
  type EscalationParams,
  type EscalationRef,
  type EscalationTemplateId,
} from "./escalation";
import { SENSITIVE_AUDIT_CLASSES } from "../quick-actions";
import type { CockpitItem } from "../demands";

const ALL_IDS: EscalationTemplateId[] = [
  "merge-conflict", "merge-gate-failed", "merge-failed-terminal", "deploy-failed", "deploy-unsettled",
  "run-death", "run-inflight-stuck", "run-advanced-warning", "blocker-generic", "blocker-merge-back",
  "blocker-secret-scan", "qa-red", "question-pending", "approval-pending", "proposal-capture",
  "review-triage", "gate-manual-approve", "design-wireframe", "governance-draft", "release-aging",
  "preserved-branch-recovery", "orphan-process-kill", "move-gate-blocked", "unplaced-card", "hitl-card-instructions",
];

// One ref of EVERY kind in the union (roundtrip must be lossless).
const REFS: EscalationRef[] = [
  { templateId: "hitl-card-instructions", kind: "card", boardId: "storymap", cardId: "story-abc" },
  { templateId: "question-pending", kind: "question", boardId: "acme", cardId: "c1", questionId: "q1" },
  { templateId: "blocker-generic", kind: "finding", boardId: "storymap", cardId: "c1", findingId: "f1" },
  { templateId: "merge-conflict", kind: "merge", boardId: "storymap", cardId: "c1", runId: "run-1", entryStatus: "conflict" },
  { templateId: "run-death", kind: "run", boardId: "storymap", cardId: "c1" },
  { templateId: "run-inflight-stuck", kind: "run", boardId: "storymap", cardId: "c1", runId: "run-9" },
  { templateId: "deploy-failed", kind: "deploy", boardId: "storymap", cardId: "c1" },
  { templateId: "preserved-branch-recovery", kind: "branch", boardId: "storymap", branch: "run/abc-123" },
  { templateId: "orphan-process-kill", kind: "process", boardId: "storymap", session: "tmux-card-1" },
  { templateId: "approval-pending", kind: "approval", boardId: "storymap", approvalId: "apr-1" },
  { templateId: "governance-draft", kind: "governance", boardId: "storymap", draftId: "d1" },
  { templateId: "move-gate-blocked", kind: "move-blocked", boardId: "storymap", cardId: "c1", target: "revisao" },
];

/** Encode arbitrary JSON to the wire the same way encodeEscalationRef does (for tampered-payload tests). */
const wire = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");

describe("EscalationRef encode/parse", () => {
  it("roundtrips every kind losslessly", () => {
    for (const ref of REFS) {
      expect(parseEscalationRef(encodeEscalationRef(ref))).toEqual(ref);
    }
  });

  it("rejects tampered / malformed payloads WITHOUT throwing (null)", () => {
    const bad: (string | null | undefined)[] = [
      "",
      null,
      undefined,
      "not base64!!", // char outside [A-Za-z0-9_-]
      Buffer.from("{not json").toString("base64url"), // valid base64url, invalid JSON
      wire({ kind: "bogus", templateId: "deploy-failed", boardId: "x", cardId: "c1" }), // unknown kind
      wire({ kind: "card", templateId: "nope", boardId: "x", cardId: "c1" }), // unknown templateId
      wire({ kind: "card", templateId: "deploy-failed", boardId: "x", cardId: "has space" }), // bad id char
      wire({ kind: "card", templateId: "deploy-failed", boardId: "NOT A SLUG", cardId: "c1" }), // bad board slug
      wire({ kind: "merge", templateId: "merge-conflict", boardId: "x", cardId: "c1", runId: "r1", entryStatus: "weird" }), // bad enum
      "A".repeat(513), // > 512 wire cap
    ];
    for (const raw of bad) {
      expect(parseEscalationRef(raw)).toBeNull();
    }
  });
});

describe("ESCALATION_TEMPLATES", () => {
  it("is exhaustive over the 25 catalogued scenarios", () => {
    expect(Object.keys(ESCALATION_TEMPLATES).sort()).toEqual([...ALL_IDS].sort());
  });

  it("D8b — every sensitive template requires confirm + carries a non-empty confirmClause; others don't", () => {
    for (const id of ALL_IDS) {
      const t = ESCALATION_TEMPLATES[id];
      expect(t.id).toBe(id);
      if (SENSITIVE_AUDIT_CLASSES.has(t.cls)) {
        expect(t.requiresConfirm).toBe(true);
        expect(t.confirmClause && t.confirmClause.trim().length).toBeGreaterThan(0);
      } else {
        expect(t.requiresConfirm).toBe(false);
        expect(t.confirmClause).toBeUndefined();
      }
    }
  });

  const fullParams: EscalationParams = {
    boardId: "storymap",
    cardId: "card-1",
    runId: "run-1",
    findingId: "f-1",
    questionId: "q-1",
    approvalId: "a-1",
    branch: "run/b-1",
    session: "s-1",
    targetStatus: "revisao",
    extra: { gate: "hasTasks", gateLabel: "QA", draftId: "d-1", reason: "timeout", firedAt: "12:00", stagedAt: "2026-01-01" },
  };
  const RUN_BEARING = new Set<EscalationTemplateId>([
    "merge-conflict", "merge-gate-failed", "merge-failed-terminal", "run-inflight-stuck", "blocker-merge-back", "blocker-secret-scan",
  ]);
  const NON_CARD = new Set<EscalationTemplateId>(["governance-draft", "orphan-process-kill"]);

  it("every instruction cites its target id and is a non-empty string", () => {
    for (const id of ALL_IDS) {
      const text = ESCALATION_TEMPLATES[id].instruction(fullParams);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      if (!NON_CARD.has(id)) expect(text).toContain("card-1");
      if (RUN_BEARING.has(id)) expect(text).toContain("run-1");
    }
  });

  // Reescrito de propósito (revisão do WP2): o texto «publique por unidade» era escolhido por `decider === "system"`, e
  // TODA fase transitória é do sistema (frescor, build, promoção, rosto) — inclusive a da prova, em que re-disparar antes
  // dela é o laço que o caminho needs-proof existe para evitar. Só a saída 3 do sistema (needs-units) pede isso.
  it("deploy-failed com a lacuna de classe do SISTEMA (needs-units): o agente publica por unidade — sem pedir confirmação ao dono", () => {
    const sys = ESCALATION_TEMPLATES["deploy-failed"].instruction({ boardId: "b", cardId: "c1", extra: { decider: "system", phase: "needs-units", causeKey: "acme:system" } });
    expect(sys).toContain("`c1`");
    expect(sys).toContain("acme:system");
    expect(sys).toMatch(/por unidade/);
    expect(sys).not.toMatch(/NÃO re-dispare|me confirmar/);
    // sem causa (ou causa do dono) o texto de sempre
    const generic = ESCALATION_TEMPLATES["deploy-failed"].instruction({ boardId: "b", cardId: "c1" });
    expect(ESCALATION_TEMPLATES["deploy-failed"].instruction({ boardId: "b", cardId: "c1", extra: { decider: "owner", phase: "needs-human" } })).toBe(generic);
  });

  it.each(["freshness", "deploy", "release", "face-stale", "needs-proof"])(
    "deploy-failed com causa do sistema na fase %s: a instrução de DIAGNÓSTICO de sempre (nunca «publique por unidade»)",
    (phase) => {
      const txt = ESCALATION_TEMPLATES["deploy-failed"].instruction({ boardId: "b", cardId: "c1", extra: { decider: "system", phase, causeKey: `acme:${phase}` } });
      expect(txt).toBe(ESCALATION_TEMPLATES["deploy-failed"].instruction({ boardId: "b", cardId: "c1" }));
      expect(txt).toMatch(/diagnostique/);
      expect(txt).not.toMatch(/por unidade|Não é decisão do dono/);
    },
  );

  it("no instruction embeds third-party evidence (invariant 7 — anti prompt-injection)", () => {
    for (const id of ALL_IDS) {
      const text = ESCALATION_TEMPLATES[id].instruction(fullParams);
      for (const blob of ["stderr", "gateLog", "logTail", "<contexto>"]) {
        expect(text).not.toContain(blob);
      }
    }
  });
});

// O mapeamento item → escalar existia DUAS vezes: o `escalate` do registry
// (quick-actions.ts, com modelos específicos por cenário) e `escalationRefFor` aqui (que mandava blocker, gate,
// review, proposta e design para o genérico `hitl-card-instructions`). O Inbox usava o segundo — os modelos
// específicos do registry nunca apareciam lá. O mapeamento por item saiu daqui: o registry é o dono.
describe("escalationRefFor saiu — o registry é o único mapeamento item → escalar (B12)", () => {
  it("o módulo não exporta mais o mapeador por item", async () => {
    const mod = (await import("./escalation")) as Record<string, unknown>;
    expect(mod.escalationRefFor).toBeUndefined();
  });
});
