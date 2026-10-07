// vocab-doc invariant: a row still on the LEGACY structured fields composes a draft body from them — the body the
// agent's write path (`vocab-actions.ts`) starts from before it appends, so nothing the row already said is lost.

import { describe, expect, it } from "vitest";
import type { Persona } from "../types";
import { composeVocabBody } from "./vocab-doc";

const legacyPersona = (): Persona => ({
  id: "legado",
  name: "Persona Legada",
  color: "#888",
  role: "Leitor de ficção, 30–50",
  description: "Monta a estante por autor, não por modinha.",
  jobs: ["Achar edições esgotadas", "Montar a lista de desejos do clube de leitura"],
});

describe("vocab-doc", () => {
  it("a persona legada vira um corpo com o papel, a descrição e os jobs", () => {
    const body = composeVocabBody(legacyPersona(), "persona");
    expect(body).toContain("Leitor de ficção");
    expect(body).toContain("Monta a estante por autor");
    expect(body).toContain("## Jobs\n\n- Achar edições esgotadas");
  });

  it("composeVocabBody mirrors the legacy fields for systems too", () => {
    const body = composeVocabBody(
      { id: "vitrine", name: "Vitrine Online", color: "#2f7f86", kind: "Canal", description: "Por onde o leitor vê o catálogo.", constraints: ["Sem frete grátis abaixo de R$ 80"] },
      "system",
    );
    expect(body).toContain("Por onde o leitor vê o catálogo.");
    expect(body).toContain("## Limites & gotchas");
  });

  it("uma linha sem nada declarado compõe um corpo vazio (nada inventado)", () => {
    expect(composeVocabBody({ id: "x", name: "X", color: "#888" }, "persona")).toBe("");
  });
});
