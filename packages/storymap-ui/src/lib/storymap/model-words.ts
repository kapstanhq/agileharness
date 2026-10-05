// O nome do modelo como o dono lê. PURA.

/** «opus[1m]» → «Opus (contexto longo)»: o nome técnico fica no title. PURA. */
export function modelWords(model: string): string {
  const m = /^(opus|sonnet|haiku|fable)(?:\[(\d+)m\])?/i.exec(model.trim());
  if (!m) return model;
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return m[2] ? `${name} (contexto longo)` : name;
}

