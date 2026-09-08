// Unit tests for ownership.js — the business-intent authorship guard.
// Covers the AC1–AC4 matrix: owner×flag.
//
// AC1: run writes board.yaml human field without proposal flag → BLOCKED
// AC2: run writes in proposals/ zone → ALLOWED (draft)
// AC3: human (no STORYMAP_AUTORUN_RUN_ID) → NEVER blocked (tested in hook)
// AC4: run writes card.md / code → ALLOWED (agent territory)

import { describe, it, expect } from "vitest";
import {
  OWNER,
  HUMAN_BOARD_FIELDS,
  isProposalPath,
  isBoardYamlPath,
  isPrdDocPath,
  isCardPath,
  evaluateOwnerGuard,
} from "./ownership.js";

describe("OWNER constants", () => {
  it("exports the three ownership values", () => {
    expect(OWNER.HUMAN).toBe("human");
    expect(OWNER.PROPOSABLE).toBe("proposable");
    expect(OWNER.AGENT).toBe("agent");
  });
});

describe("o PRD é owner:human — o documento mais alto do board", () => {
  it("um run que reescreve o PRD é BLOQUEADO, e a recusa nomeia as DUAS saídas", () => {
    const v = evaluateOwnerGuard({
      filePath: "storymap/boards/acme/docs/prd.md",
      board: "acme",
      runId: "run-123",
    });
    expect(v, "o PRD ficou desprotegido — um run reescreve o norte de tudo, calado").not.toBeNull();
    expect(v?.owner).toBe("human");
    // A recusa tem de ser SEGUÍVEL: sem as duas saídas o agente só sabe que não pode, e tenta de novo.
    expect(v?.fix).toContain("propose_change");
    expect(v?.fix).toContain("/prd");
  });

  it("reconhece o caminho em qualquer board e com separador do Windows; NÃO casa vizinhos", () => {
    expect(isPrdDocPath("storymap/boards/acme/docs/prd.md")).toBe(true);
    expect(isPrdDocPath("storymap\\boards\\acme\\docs\\prd.md")).toBe(true);
    // Os vizinhos continuam owner:agent — a régua é do PRD, não de `docs/` inteiro.
    expect(isPrdDocPath("storymap/boards/acme/docs/lean-canvas.md")).toBe(false);
    expect(isPrdDocPath("storymap/boards/acme/cards/story-1.md")).toBe(false);
    expect(isPrdDocPath("docs/prd.md")).toBe(false);
  });

  it("a zona de proposals continua livre, mesmo com nome de PRD", () => {
    // `proposals/` é rascunho por caminho (owner:proposable) e vem ANTES na régua — é a saída que a
    // recusa oferece, e ela não pode estar fechada.
    expect(evaluateOwnerGuard({
      filePath: "storymap/boards/acme/proposals/prd.md",
      board: "acme",
      runId: "run-123",
    })).toBeNull();
  });
});

describe("HUMAN_BOARD_FIELDS", () => {
  it("includes the protected strategy + vocab fields", () => {
    expect(HUMAN_BOARD_FIELDS).toContain("positioning");
    expect(HUMAN_BOARD_FIELDS).toContain("businessMetric");
    expect(HUMAN_BOARD_FIELDS).toContain("desiredOutcome");
    expect(HUMAN_BOARD_FIELDS).toContain("canvas");
    // The canvas TAG vocabulary is as human-owned as the canvas itself: an autorun that recoloured or
    // renamed the operator's segments would silently rewrite how the whole canvas reads.
    expect(HUMAN_BOARD_FIELDS).toContain("canvasTags");
    expect(HUMAN_BOARD_FIELDS).toContain("releases");
    expect(HUMAN_BOARD_FIELDS).toContain("personas");
  });
});

describe("isProposalPath", () => {
  it("matches storymap proposals zone (forward slash)", () => {
    expect(isProposalPath("storymap/boards/acme/proposals/idea-123.json")).toBe(true);
  });
  it("matches with leading repo root", () => {
    expect(isProposalPath("/root/repo/storymap/boards/storymap/proposals/foo.yaml")).toBe(true);
  });
  it("matches with backslash (Windows)", () => {
    expect(isProposalPath("storymap\\boards\\acme\\proposals\\idea.json")).toBe(true);
  });
  it("does NOT match cards/", () => {
    expect(isProposalPath("storymap/boards/acme/cards/story-abc.md")).toBe(false);
  });
  it("does NOT match board.yaml", () => {
    expect(isProposalPath("storymap/boards/acme/board.yaml")).toBe(false);
  });
});

describe("isBoardYamlPath", () => {
  it("matches storymap/boards/<board>/board.yaml", () => {
    expect(isBoardYamlPath("storymap/boards/acme/board.yaml")).toBe(true);
    expect(isBoardYamlPath("storymap/boards/storymap/board.yaml")).toBe(true);
  });
  it("does NOT match cards/", () => {
    expect(isBoardYamlPath("storymap/boards/acme/cards/story.md")).toBe(false);
  });
  it("does NOT match nested yaml", () => {
    expect(isBoardYamlPath("storymap/boards/acme/config/board.yaml")).toBe(false);
  });
});

describe("isCardPath", () => {
  it("matches storymap/boards/<board>/cards/<id>.md", () => {
    expect(isCardPath("storymap/boards/acme/cards/story-abc.md")).toBe(true);
  });
  it("does NOT match board.yaml", () => {
    expect(isCardPath("storymap/boards/acme/board.yaml")).toBe(false);
  });
});

// ── evaluateOwnerGuard ────────────────────────────────────────────────────────

const BOARD_YAML_PATH = "storymap/boards/acme/board.yaml";
const CARD_PATH = "storymap/boards/acme/cards/story-abc.md";
const PROPOSALS_PATH = "storymap/boards/acme/proposals/idea-1.json";
const CODE_PATH = "packages/acmeapp/src/index.ts";
const RUN_ID = "run-test-123";

// AC4: cards/.md → owner:agent → allow
describe("AC4 — card.md is owner:agent → always allowed", () => {
  it("allows a run writing to cards/", () => {
    const result = evaluateOwnerGuard({
      filePath: CARD_PATH,
      board: "acme",
      beforeYaml: null,
      afterYaml: null,
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });

  it("allows a run writing to code files", () => {
    const result = evaluateOwnerGuard({
      filePath: CODE_PATH,
      board: "acme",
      beforeYaml: null,
      afterYaml: null,
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });
});

// AC2: proposals/ zone → owner:proposable rascunho → allow
describe("AC2 — proposals/ zone → owner:proposable → allowed as draft", () => {
  it("allows a run writing to proposals/", () => {
    const result = evaluateOwnerGuard({
      filePath: PROPOSALS_PATH,
      board: "acme",
      beforeYaml: null,
      afterYaml: { desiredOutcome: "new value" },
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });
});

// AC1: board.yaml, human field changed, run present → BLOCKED
describe("AC1 — board.yaml human field changed by run → BLOCKED", () => {
  it("blocks when personas changes", () => {
    const before = { personas: [{ id: "p1", name: "Alice" }], statuses: [] };
    const after = { personas: [{ id: "p1", name: "Alice" }, { id: "p2", name: "Bob" }], statuses: [] };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: RUN_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.owner).toBe("human");
    expect(result!.fields).toContain("personas");
    expect(result!.message).toContain(RUN_ID);
    expect(result!.message).toContain("personas");
  });

  it("blocks when releases changes", () => {
    const before = { releases: [{ id: "r1", name: "v1" }] };
    const after = { releases: [{ id: "r1", name: "v1" }, { id: "r2", name: "v2" }] };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: RUN_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("releases");
  });

  it("blocks when desiredOutcome changes (forward-declared field)", () => {
    const before = { desiredOutcome: null };
    const after = { desiredOutcome: "Dominar a mosaico" };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: RUN_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("desiredOutcome");
  });

  it("reports ALL changed human fields in one violation", () => {
    const before = { personas: [], releases: [], statuses: [] };
    const after = { personas: [{ id: "p1" }], releases: [{ id: "r1" }], statuses: [] };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: RUN_ID,
    });
    expect(result).not.toBeNull();
    expect(result!.fields).toContain("personas");
    expect(result!.fields).toContain("releases");
  });

  it("includes the run id in the violation message", () => {
    const before = { personas: [] };
    const after = { personas: [{ id: "p1" }] };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: "my-run-id-abc",
    });
    expect(result!.message).toContain("my-run-id-abc");
  });
});

// AC4 on board.yaml: only NON-human fields changed → allow
describe("AC4 — board.yaml with only non-human field changes → allowed", () => {
  it("allows when only statuses changes", () => {
    const before = { personas: [{ id: "p1" }], statuses: [] };
    const after = { personas: [{ id: "p1" }], statuses: [{ id: "s1" }] };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });

  it("allows when only the card's own fields (systems, etc.) change", () => {
    const before = { personas: [{ id: "p1" }], systems: [] };
    const after = { personas: [{ id: "p1" }], systems: [{ id: "sys1" }] };
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: before,
      afterYaml: after,
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });
});

// Lenient: unparseable afterYaml → allow
describe("lenient — unparseable content → allow", () => {
  it("returns null when afterYaml is null", () => {
    const result = evaluateOwnerGuard({
      filePath: BOARD_YAML_PATH,
      board: "acme",
      beforeYaml: { personas: [] },
      afterYaml: null,
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });

  it("returns null when filePath is null/undefined", () => {
    const result = evaluateOwnerGuard({
      filePath: null as unknown as string,
      board: "acme",
      beforeYaml: null,
      afterYaml: { personas: [] },
      runId: RUN_ID,
    });
    expect(result).toBeNull();
  });
});
