// parseHitlTurn — texto do agente → HitlAgentTurn validado. Reusa a extração tolerante de JSON
// (extractJsonObject) e o stripAgentPreamble (defesa de tom) da captura/assisted-edit. PURO/testável.

import { extractJsonObject } from "../smart-capture/parse";
import { stripAgentPreamble } from "../assisted-edit";
import type { HitlAgentTurn, HitlOption } from "./types";

/** Normaliza as opções (id estável, descrição/pros/cons não-vazios, recommended). Vazio → undefined. */
function parseOptions(raw: unknown): HitlOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HitlOption[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!label) continue;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `o${out.length + 1}`;
    const opt: HitlOption = { id, label };
    // A DESCRIÇÃO tem precedência de leitura sobre pros/cons na tela — é a frase com que o agente explica a
    // opção. Aceita os apelidos que o modelo tende a usar quando ninguém o corrige.
    const desc = [o.description, o.detail, o.hint].find((v) => typeof v === "string" && v.trim());
    if (typeof desc === "string") opt.description = desc.trim();
    const pros = Array.isArray(o.pros) ? o.pros.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
    const cons = Array.isArray(o.cons) ? o.cons.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
    if (pros.length) opt.pros = pros;
    if (cons.length) opt.cons = cons;
    if (o.recommended === true) opt.recommended = true;
    out.push(opt);
  }
  return out.length ? out : undefined;
}

export function parseHitlTurn(raw: string): HitlAgentTurn {
  const obj = extractJsonObject(raw) as Record<string, unknown>;
  const message = typeof obj.message === "string" ? stripAgentPreamble(obj.message).trim() : "";
  const options = parseOptions(obj.options);
  const mode = obj.mode === "multi" ? "multi" : obj.mode === "single" ? "single" : undefined;
  const turn: HitlAgentTurn = { role: "agent", message };
  if (options) turn.options = options;
  if (mode) turn.mode = mode;
  if (obj.done !== undefined && obj.done !== null) turn.done = obj.done;
  return turn;
}
