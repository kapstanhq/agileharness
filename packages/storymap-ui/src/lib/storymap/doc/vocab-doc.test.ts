// vocab-doc invariants: no-op on prompt-backed rows; lazy migration persists the composed body
// EXACTLY ONCE for legacy rows; title ↔ name; body ↔ prompt.

import { describe, expect, it } from "vitest";
import type { Persona } from "../types";
import { commitVocabDoc, composeVocabBody, projectVocabDoc } from "./vocab-doc";

const promptPersona = (): Persona => ({
  id: "leitor",
  name: "Leitor Assíduo",
  color: "#c0562b",
  prompt: "Compra três livros por mês e relê os favoritos.\n\n## Jobs\n\n- Achar a edição certa sem vasculhar sebos",
});

const legacyPersona = (): Persona => ({
  id: "legado",
  name: "Persona Legada",
  color: "#888",
  role: "Leitor de ficção, 30–50",
  description: "Monta a estante por autor, não por modinha.",
  jobs: ["Achar edições esgotadas", "Montar a lista de desejos do clube de leitura"],
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
    expect(patch.prompt).toContain("Leitor de ficção");
    expect(patch.prompt).toContain("## Jobs");

    // second save (now prompt-backed) is a no-op
    const migrated: Persona = { ...p, prompt: patch.prompt };
    const again = commitVocabDoc(projectVocabDoc(migrated, "persona"), migrated, "persona");
    expect(again.changed).toBe(false);
  });

  it("title edit maps to name; body edit maps to prompt", () => {
    const p = promptPersona();
    const model = projectVocabDoc(p, "persona");
    model.title = "Leitor Assíduo Sebista";
    model.blocks.push({ kind: "paragraph", id: "x", text: "Nota nova." });
    const { patch } = commitVocabDoc(model, p, "persona");
    expect(patch.name).toBe("Leitor Assíduo Sebista");
    expect(patch.prompt).toContain("Nota nova.");
  });

  it("composeVocabBody mirrors the legacy fields for systems too", () => {
    const body = composeVocabBody(
      { id: "vitrine", name: "Vitrine Online", color: "#2f7f86", kind: "Canal", description: "Por onde o leitor vê o catálogo.", constraints: ["Sem frete grátis abaixo de R$ 80"] },
      "system",
    );
    expect(body).toContain("Por onde o leitor vê o catálogo.");
    expect(body).toContain("## Limites & gotchas");
  });
});
