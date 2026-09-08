// vocab-doc invariants: no-op on prompt-backed rows; lazy migration persists the composed body
// EXACTLY ONCE for legacy rows; title ↔ name; body ↔ prompt.

import { describe, expect, it } from "vitest";
import type { Persona } from "../types";
import { commitVocabDoc, composeVocabBody, projectVocabDoc } from "./vocab-doc";

const promptPersona = (): Persona => ({
  id: "curioso",
  name: "Curioso Cultural",
  color: "#0ea5e9",
  prompt: "Você é o Curioso Cultural.\n\n## Jobs\n\n- Descobrir eventos sem garimpar",
});

const legacyPersona = (): Persona => ({
  id: "legado",
  name: "Persona Legada",
  color: "#888",
  role: "Adulto urbano, 28–45",
  description: "Ama a cena da mosaico.",
  jobs: ["Descobrir eventos", "Planejar o programa do grupo"],
});

describe("vocab-doc", () => {
  it("no-op: prompt-backed row commits with zero changes", () => {
    const p = promptPersona();
    const { changed, patch } = commitVocabDoc(projectVocabDoc(p, "persona"), p, "persona");
    expect(changed).toBe(false);
    expect(patch).toEqual({});
  });

  it("legacy row projects the composed body and the FIRST save migrates it into prompt", () => {
    const p = legacyPersona();
    const model = projectVocabDoc(p, "persona");
    expect(model.blocks.some((b) => b.kind === "heading" && b.text === "Jobs")).toBe(true);

    const { changed, patch } = commitVocabDoc(model, p, "persona");
    expect(changed).toBe(true);
    expect(patch.prompt).toContain("Adulto urbano");
    expect(patch.prompt).toContain("## Jobs");

    // second save (now prompt-backed) is a no-op
    const migrated: Persona = { ...p, prompt: patch.prompt };
    const again = commitVocabDoc(projectVocabDoc(migrated, "persona"), migrated, "persona");
    expect(again.changed).toBe(false);
  });

  it("title edit maps to name; body edit maps to prompt", () => {
    const p = promptPersona();
    const model = projectVocabDoc(p, "persona");
    model.title = "Curioso Cultural POA";
    model.blocks.push({ kind: "paragraph", id: "x", text: "Nota nova." });
    const { patch } = commitVocabDoc(model, p, "persona");
    expect(patch.name).toBe("Curioso Cultural POA");
    expect(patch.prompt).toContain("Nota nova.");
  });

  it("composeVocabBody mirrors the legacy fields for systems too", () => {
    const body = composeVocabBody(
      { id: "wa", name: "Canal WhatsApp", color: "#4FA873", kind: "Canal", description: "Ponto de contato principal.", constraints: ["Sem botões de reply"] },
      "system",
    );
    expect(body).toContain("Ponto de contato principal.");
    expect(body).toContain("## Limites & gotchas");
  });
});
