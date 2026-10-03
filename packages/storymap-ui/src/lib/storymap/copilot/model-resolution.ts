// QUAL Opus? — o apelido do modelo (`opus`, `sonnet`) e a VERSÃO que ele virou de fato.
//
// O CLI documenta `--model` assim: "provide an alias for the latest model (e.g. 'fable', 'opus', or
// 'sonnet') OR a model's full name". Ou seja, `opus` é uma PROMESSA ("o mais novo da família"), não um
// modelo — hoje `claude-opus-5`, amanhã outro. Por isso a tela mostrava só "opus" e o operador ficava sem
// saber se estava rodando 4.8 ou 5.
//
// A tentação é uma tabela `opus → "Opus 5"` no código. Ela seria MENTIRA na semana seguinte ao próximo
// lançamento — e este pacote já tem a regra escrita: o tier se lê da CONFIG/realidade, nunca de um segundo
// mapa hardcoded (packages/storymap-ui/.claude/CLAUDE.md § Papéis × modelos).
//
// A verdade existe e é de graça: o próprio CLI ANUNCIA o id resolvido no evento `system/init` de cada
// spawn (`{"type":"system","subtype":"init","model":"claude-sonnet-5"}` — verificado na CLI 2.1.220). Este
// módulo é a memória disso: cada turno OBSERVA o par (apelido pedido → id resolvido) e a UI lê a tabela.
// Modelo novo no CLI ⇒ o rótulo se atualiza sozinho no primeiro turno, sem ninguém editar código.
//
// PURO aqui (merge/lookup, testável); o IO fica no wrapper de disco ao final.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { splitModelVariant } from "./copilot-status";

/** O que se sabe sobre um apelido: em que id ele caiu, e quando isso foi observado. */
export interface ModelResolution {
  /** o id COMPLETO que o CLI reportou (`claude-opus-5`). */
  readonly resolved: string;
  /** ISO do último turno que observou isto — o que envelhece a informação. */
  readonly seenAt: string;
}

/** apelido BASE (`opus`, `sonnet`) → o que ele resolveu. A janela (`[1m]`) não muda o modelo. */
export type ModelResolutions = Record<string, ModelResolution>;

/**
 * A chave: o apelido SEM a variante de janela. `opus` e `opus[1m]` são o mesmo modelo em janelas
 * diferentes — guardar os dois separados duplicaria a mesma verdade e deixaria metade da tela desatualizada
 * conforme o operador alternasse o 1M.
 */
export function aliasKey(model: string | undefined): string {
  return splitModelVariant(model).base.trim().toLowerCase();
}

/** O id resolvido também vem com a variante quando ela foi pedida — a VERSÃO é a base dele. */
function normalizeResolved(resolved: string): string {
  return splitModelVariant(resolved).base.trim();
}

/**
 * Registra uma observação. PURA — devolve a tabela nova (a antiga não é tocada).
 *
 * Observação vazia/absurda é IGNORADA em silêncio: este dado é decoração de rótulo, e um id malformado
 * na tela seria pior que a ausência dele. A observação mais recente vence — é ela que reflete o CLI de hoje.
 */
export function rememberResolution(
  table: ModelResolutions,
  requested: string | undefined,
  resolved: string | undefined,
  now: Date,
): ModelResolutions {
  const key = aliasKey(requested);
  const id = normalizeResolved(resolved ?? "");
  if (!key || !id) return table;
  const prev = table[key];
  if (prev && prev.resolved === id) return table; // nada mudou — não reescreve o arquivo por nada
  return { ...table, [key]: { resolved: id, seenAt: now.toISOString() } };
}

/** O id resolvido de um modelo pedido, ou null quando este apelido nunca rodou aqui. Pura. */
export function resolvedIdFor(table: ModelResolutions, model: string | undefined): string | null {
  return table[aliasKey(model)]?.resolved ?? null;
}

/**
 * O rótulo de VERSÃO de um apelido, para a UI. `null` quando ainda não se sabe — e nesse caso a tela diz
 * "o mais recente", que é literalmente o que o apelido significa, em vez de inventar um número.
 */
export function versionLabel(table: ModelResolutions, model: string | undefined): string | null {
  return resolvedIdFor(table, model);
}

// ── O DISCO ─────────────────────────────────────────────────────────────────────────────────────────
// Um arquivinho no estado do runner. É CACHE de observação, não configuração: apagá-lo só faz a UI voltar
// a dizer "o mais recente" até o próximo turno reensinar. Por isso todo o IO aqui é best-effort e mudo —
// nada disto pode derrubar um turno do Jido.

function resolutionsPath(): string {
  return path.join(runnerStateDir(), "model-aliases.json");
}

/** Lê a tabela aprendida. Nunca lança — arquivo ausente/corrompido é tabela vazia. */
export async function readModelResolutions(): Promise<ModelResolutions> {
  try {
    return coerceResolutions(JSON.parse(await fs.readFile(resolutionsPath(), "utf8")));
  } catch {
    return {};
  }
}

/**
 * Registra o que o CLI respondeu neste turno. Chamado do funil de eventos do spawn (agent-session), então
 * é fire-and-forget: um erro de escrita aqui não pode custar a resposta que o operador está lendo.
 */
export async function rememberModelResolution(requested: string | undefined, resolved: string | undefined): Promise<void> {
  try {
    const before = await readModelResolutions();
    const after = rememberResolution(before, requested, resolved, new Date());
    if (after === before) return; // nada novo — não toca no disco
    await fs.mkdir(runnerStateDir(), { recursive: true });
    await fs.writeFile(resolutionsPath(), `${JSON.stringify(after, null, 2)}\n`, "utf8");
  } catch {
    /* best-effort: a tela só perde um rótulo */
  }
}

/** Coerção defensiva do que estiver no disco (arquivo de estado, editável à mão / de outra versão). */
export function coerceResolutions(raw: unknown): ModelResolutions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ModelResolution> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim() || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const resolved = typeof v.resolved === "string" ? v.resolved.trim() : "";
    if (!resolved) continue;
    out[key.trim().toLowerCase()] = {
      resolved,
      seenAt: typeof v.seenAt === "string" && v.seenAt.trim() ? v.seenAt : new Date(0).toISOString(),
    };
  }
  return out;
}
