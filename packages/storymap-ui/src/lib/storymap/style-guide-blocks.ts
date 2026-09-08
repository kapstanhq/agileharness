// 🟥 Style Guide — THE section registry (D5, 00-conteudo-do-guia.md). One source for the 10
// canonical sections, shared by the VIEW (which lays out the "estilo" block), the SERVER (which
// prompts the authoring assistant with the key list + quality bar) and the coercer (which drops any
// section key this registry doesn't know). Duplicating this list is how an agent starts hallucinating
// section keys the UI can't render — so it lives here, once. Mirrors canvas-blocks.ts's anatomy
// (CANVAS_BLOCKS) on purpose — same shape, same reasons.

/** How a section is authored/rendered: pure structured tokens, pure prose, or both. */
export type StyleSectionKind = "tokens" | "prose" | "mixed";

export interface StyleSectionDef {
  /** the key inside StyleGuideDoc — also the compiled-.md heading anchor and the governance `field`. */
  key: string;
  label: string;
  /** the quality bar for this section — becomes the empty-state placeholder AND the agent's prompt hint. */
  hint: string;
  kind: StyleSectionKind;
  /**
   * The section's cell in the view's 2-column grid (lg+). Static class strings on purpose: Tailwind
   * scans source text, so a computed class would never be generated (mirrors CanvasBlockDef.cell).
   */
  cell?: string;
}

// Registry order = compiled-.md order = agent fill order (00-conteudo-do-guia.md §"As 10 seções").
export const STYLE_SECTIONS: readonly StyleSectionDef[] = [
  {
    key: "identity",
    label: "Identidade",
    hint: "Nomeia uma escola REAL (ex.: \"editorial suíço\") + 3-5 adjetivos acionáveis; a prosa explica o que a marca NÃO é.",
    kind: "mixed",
    cell: "lg:col-span-2",
  },
  {
    key: "principles",
    label: "Princípios",
    hint: "3-6 princípios ORDENADOS — conflito entre dois, o de cima vence; cada um com consequência prática (\"logo, nunca X\").",
    kind: "mixed",
    cell: "lg:col-span-2",
  },
  {
    key: "color",
    label: "Cor",
    hint: "Papéis semânticos com par de contraste (on), regra de uso e budget do accent — nunca hex solto.",
    kind: "mixed",
    cell: "lg:col-span-2",
  },
  {
    key: "typography",
    label: "Tipografia",
    hint: "Fontes + escala REAL (tamanho/altura de linha, não só nomes) com regra de uso por nível.",
    kind: "mixed",
    cell: "lg:col-span-2",
  },
  {
    key: "spacing",
    label: "Espaçamento",
    hint: "Base + steps da escala (não valores ad-hoc); regra \"só valores da escala\".",
    kind: "mixed",
    cell: "lg:col-span-1",
  },
  {
    key: "shape",
    label: "Forma",
    hint: "Raio, profundidade e bordas — política explícita (ex.: \"sombras: nenhuma\").",
    kind: "mixed",
    cell: "lg:col-span-1",
  },
  {
    key: "motion",
    label: "Movimento",
    hint: "Poucos tokens nomeados (fast/base/slow) + quando NÃO animar.",
    kind: "mixed",
    cell: "lg:col-span-1",
  },
  {
    key: "voice",
    label: "Voz (léxico de UI)",
    hint: "Pares preferido/evite, proibidos (lintável) e exceções documentadas — cobre microcopy de interface.",
    kind: "mixed",
    cell: "lg:col-span-1",
  },
  {
    key: "antiPatterns",
    label: "Anti-padrões",
    hint: "Sintoma → fix, concreto e observável (\"gradiente em CTA → usar primary sólido\") — não platitude.",
    kind: "tokens",
    cell: "lg:col-span-1",
  },
  {
    key: "debt",
    label: "Débito visual",
    hint: "Cada item nomeia o resquício E onde vive (\"telas legadas X ainda usam azul #4B76E8\").",
    kind: "tokens",
    cell: "lg:col-span-1",
  },
] as const;

/** Every valid section key — the allowlist a proposal direction is validated against. */
export const STYLE_SECTION_KEYS: readonly string[] = STYLE_SECTIONS.map((s) => s.key);

export const STYLE_SECTION_BY_KEY: ReadonlyMap<string, StyleSectionDef> = new Map(
  STYLE_SECTIONS.map((s) => [s.key, s]),
);

/** Human label of a section key — falls back to the key so an unknown key stays legible in a diff. */
export function styleSectionLabel(key: string): string {
  return STYLE_SECTION_BY_KEY.get(key)?.label ?? key;
}
