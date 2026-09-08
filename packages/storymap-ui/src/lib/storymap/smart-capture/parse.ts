// Turn the agent's text answer into a validated Proposal. The LLM is asked for raw
// JSON, but defends against the usual drift: code fences, a stray sentence before
// the object, unknown vocab ids, missing/duplicate tempIds, dangling parent refs.

import { isStoryType } from "../frameworks";
import { CARD_TYPES } from "../types";
import type { BoardConfig, Card, CardType } from "../types";
import type { Proposal, ProposedItem } from "./types";

/** Best-effort: locate and parse the first balanced JSON object in `raw`. */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(text);
  } catch {
    // fall through to brace-scan
  }
  const start = text.indexOf("{");
  if (start < 0) throw new Error("Resposta do agente não contém JSON.");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  throw new Error("Não consegui isolar um JSON válido na resposta do agente.");
}

function asStringArray(raw: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x)).filter((x) => allowed.has(x)))];
}

/** Free string array (no vocab allowlist) — trimmed, non-empty, deduped. Used for OST candidateSolutions. */
function asStringArrayFree(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((x) => String(x).trim()).filter((x) => x.length > 0))];
}

/** Parse an OST value-size {reach,impact} → null when neither axis is a finite number (sparse). */
function parseValueSize(raw: unknown): { reach: number | null; impact: number | null } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const num = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
  const reach = num(v.reach);
  const impact = num(v.impact);
  if (reach == null && impact == null) return null;
  return { reach, impact };
}

/**
 * Sanitize the OST-light fields (candidateSolutions/keyAssumption/successSignal/valueSize) — only
 * meaningful on an `idea` item. Returns only fields with real content; absent/empty → omitted.
 */
function parseIdeaFields(
  o: Record<string, unknown>,
): Pick<ProposedItem, "candidateSolutions" | "keyAssumption" | "successSignal" | "valueSize"> {
  const result: Pick<ProposedItem, "candidateSolutions" | "keyAssumption" | "successSignal" | "valueSize"> = {};
  const cs = asStringArrayFree(o.candidateSolutions);
  if (cs.length) result.candidateSolutions = cs;
  if (typeof o.keyAssumption === "string" && o.keyAssumption.trim()) result.keyAssumption = o.keyAssumption.trim();
  if (typeof o.successSignal === "string" && o.successSignal.trim()) result.successSignal = o.successSignal.trim();
  const vs = parseValueSize(o.valueSize);
  if (vs) result.valueSize = vs;
  return result;
}

/**
 * Sanitize the optional rich fields (narrative/acceptance/body) from a raw item.
 * Returns only fields that have real content; absent/malformed → field omitted.
 */
function parseRichFields(o: Record<string, unknown>): Pick<ProposedItem, "narrative" | "acceptance" | "body" | "tasks"> {
  const result: Pick<ProposedItem, "narrative" | "acceptance" | "body" | "tasks"> = {};

  // narrative: object with role/want/soThat; omit if all null/empty
  if (o.narrative !== undefined && o.narrative !== null && typeof o.narrative === "object" && !Array.isArray(o.narrative)) {
    const n = o.narrative as Record<string, unknown>;
    const role = typeof n.role === "string" && n.role.trim() ? n.role.trim() : null;
    const want = typeof n.want === "string" && n.want.trim() ? n.want.trim() : null;
    const soThat = typeof n.soThat === "string" && n.soThat.trim() ? n.soThat.trim() : null;
    if (role !== null || want !== null || soThat !== null) {
      result.narrative = { role, want, soThat };
    }
  }

  // acceptance: array of non-empty strings (free text, no vocab allowlist)
  if (Array.isArray(o.acceptance)) {
    const acc = o.acceptance.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
    if (acc.length > 0) result.acceptance = acc;
  }

  // body: trimmed string; omit if empty
  if (typeof o.body === "string" && o.body.trim()) {
    result.body = o.body.trim();
  }

  // WS7 (F6) — tasks: a pre-seeded decomposition of an umbrella card. Accept {id?, title} objects OR bare
  // strings (title). Keep only non-empty titles; drop off-shape entries (tolerant, like acceptance).
  if (Array.isArray(o.tasks)) {
    const tasks = o.tasks
      .map((t) => {
        if (typeof t === "string") return t.trim() ? { title: t.trim() } : null;
        if (t && typeof t === "object") {
          const title = typeof (t as Record<string, unknown>).title === "string" ? String((t as Record<string, unknown>).title).trim() : "";
          if (!title) return null;
          const id = typeof (t as Record<string, unknown>).id === "string" ? String((t as Record<string, unknown>).id).trim() : "";
          return id ? { id, title } : { title };
        }
        return null;
      })
      .filter((t): t is { id?: string; title: string } => t != null);
    if (tasks.length) result.tasks = tasks;
  }

  return result;
}

/**
 * Parse + sanitize the agent's answer against the board's real vocabulary. Items
 * with no usable title are dropped. `parent` keeps existing-card-ids and in-batch
 * tempId refs; anything dangling becomes null (commit resolves the rest).
 */
export function parseProposal(raw: string, config: BoardConfig, cards: Card[]): Proposal {
  const obj = extractJsonObject(raw) as { summary?: unknown; items?: unknown };
  const rawItems = Array.isArray(obj.items) ? obj.items : [];

  const personaIds = new Set(config.personas.map((p) => p.id));
  const systemIds = new Set(config.systems.map((s) => s.id));
  const releaseIds = new Set(config.releases.map((r) => r.id));
  const existingIds = new Set(cards.map((c) => c.id));

  // First pass: shape each item + assign stable, unique tempIds.
  const usedTempIds = new Set<string>();
  let counter = 0;
  const items: ProposedItem[] = [];
  for (const r of rawItems) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;

    const type: CardType = CARD_TYPES.includes(o.type as CardType) ? (o.type as CardType) : "story";
    let tempId = typeof o.tempId === "string" && o.tempId.trim() ? o.tempId.trim() : "";
    if (!tempId || usedTempIds.has(tempId)) {
      do {
        tempId = `i${++counter}`;
      } while (usedTempIds.has(tempId));
    }
    usedTempIds.add(tempId);

    const item: ProposedItem = {
      tempId,
      type,
      title,
      storyType:
        type === "story" ? (isStoryType(o.storyType) ? o.storyType : "user") : null,
      parent: typeof o.parent === "string" && o.parent.trim() ? o.parent.trim() : null,
      // Dual-track: only delivery stories carry serves; user/backbone always null.
      serves:
        type === "story" && o.storyType && o.storyType !== "user" &&
        typeof o.serves === "string" && o.serves.trim()
          ? o.serves.trim()
          : null,
      release:
        type === "story" && typeof o.release === "string" && releaseIds.has(o.release)
          ? o.release
          : null,
      personas: asStringArray(o.personas, personaIds),
      systems: asStringArray(o.systems, systemIds),
      rationale: typeof o.rationale === "string" ? o.rationale.trim() : "",
      // confiança na CLASSIFICAÇÃO (0..1, clamp); ausente → null (= alta). ambiguous só quando true.
      confidence:
        typeof o.confidence === "number" && Number.isFinite(o.confidence)
          ? Math.max(0, Math.min(1, o.confidence))
          : null,
      ...(o.ambiguous === true ? { ambiguous: true } : {}),
      duplicateOf:
        typeof o.duplicateOf === "string" && existingIds.has(o.duplicateOf)
          ? o.duplicateOf
          : null,
      // ESTENDER um card existente em vez de criar. Ao contrário de `duplicateOf` (que degrada para
      // null quando o id não resolve, porque é só um aviso), aqui um id inválido é PRESERVADO para o
      // commit recusar o lote: silenciar isto transformaria "acrescente 3 tasks à story X" em "crie
      // uma 4ª story", que é a decisão oposta. Só id do BOARD — tempId do lote não vale (estender
      // algo que ainda não existe é criar).
      targetCardId:
        typeof o.targetCardId === "string" && o.targetCardId.trim() ? o.targetCardId.trim() : null,
      // dual-track OST: a STORY may address an idea (existing id or in-batch tempId); story-only.
      addresses:
        type === "story" && typeof o.addresses === "string" && o.addresses.trim()
          ? o.addresses.trim()
          : null,
      ...parseRichFields(o),
      ...(type === "idea" ? parseIdeaFields(o) : {}),
    };
    items.push(item);
  }

  // Second pass: a parent (and a dual-track `serves`) must be an existing card id or another
  // item's tempId; a dangling/self ref is dropped (commit falls serves back to parent).
  for (const item of items) {
    if (item.parent && !existingIds.has(item.parent) && !usedTempIds.has(item.parent)) {
      item.parent = null;
    }
    // An item cannot be its own parent.
    if (item.parent === item.tempId) item.parent = null;
    if (item.serves && !existingIds.has(item.serves) && !usedTempIds.has(item.serves)) {
      item.serves = null;
    }
    if (item.serves === item.tempId) item.serves = null;
    // addresses (story→idea): keep existing-id / in-batch tempId; drop dangling/self.
    if (item.addresses && !existingIds.has(item.addresses) && !usedTempIds.has(item.addresses)) {
      item.addresses = null;
    }
    if (item.addresses === item.tempId) item.addresses = null;
  }

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  return { items, summary };
}
