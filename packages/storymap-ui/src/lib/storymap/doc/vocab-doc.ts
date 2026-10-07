// 📄 vocab-doc — the BODY of a persona/system row. The vocabulary rows in board.yaml stay canonical; the
// primary field is `prompt`. Rows authored before the prompt model have no prompt yet, so a writer that appends to
// one starts from a body composed of the LEGACY structured fields (role/description/jobs/pains/gains, or
// description/capabilities/constraints) — the lazy migration. Legacy fields stay untouched in the YAML.
//
// The Personas & Sistemas screen (and its document editor: the persona/system ⇄ DocModel projection) left in
// phase 2; the only writer now is the agent path (`app/vocab-actions.ts`, MCP `write_vocab`).

import type { Persona, SystemDef } from "../types";

/** The draft body of a row authored before the prompt model — composed from its LEGACY structured fields. */
export function composeVocabBody(entity: Persona | SystemDef, kind: "persona" | "system"): string {
  const parts: string[] = [];
  if (kind === "persona") {
    const p = entity as Persona;
    if (p.role?.trim()) parts.push(p.role.trim());
    if (p.description?.trim()) parts.push(p.description.trim());
    if (p.jobs?.length) parts.push("## Jobs\n\n" + p.jobs.map((j) => `- ${j}`).join("\n"));
    if (p.pains?.length) parts.push("## Dores\n\n" + p.pains.map((j) => `- ${j}`).join("\n"));
    if (p.gains?.length) parts.push("## Ganhos\n\n" + p.gains.map((g) => `- ${g}`).join("\n"));
  } else {
    const s = entity as SystemDef;
    if (s.description?.trim()) parts.push(s.description.trim());
    if (s.capabilities?.length)
      parts.push("## Capacidades\n\n" + s.capabilities.map((c) => `- ${c}`).join("\n"));
    if (s.constraints?.length)
      parts.push("## Limites & gotchas\n\n" + s.constraints.map((c) => `- ${c}`).join("\n"));
  }
  return parts.join("\n\n");
}
