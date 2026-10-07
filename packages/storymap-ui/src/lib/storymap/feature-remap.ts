// 🔁 RENOMEAR uma funcionalidade do PRD não pode soltar os cards dela (fase 7, plano §3).
//
// O card guarda o ID da funcionalidade (`card.feature`), e o id é o slug do `###` (doc/prd-features.ts): trocar o título
// troca o id. Esta remarcação roda DEPOIS que o PRD foi gravado (doc/schema-doc-io.ts `writeSchemaDoc` — a porta única
// da proposta aprovada E da edição do dono) e reescreve o `feature` dos cards da funcionalidade renomeada.
//
// O casamento ({@link featureRenames}, PURO) é conservador — na dúvida, NÃO adivinha: o card cai em «Outros» e a âncora
// o religa (runner/feature-anchor.ts). A ordem:
//   1. FAMÍLIAS de slug repetido (`mural`, `mural-2`…): os membros casam só pelo TEXTO — o id dentro da família não
//      vale (apagar o primeiro repetido desloca o id do segundo);
//   2. id presente nos dois lados = a mesma funcionalidade;
//   3. o que sobrou com o MESMO texto = renomeada;
//   4. sobrou exatamente UMA de cada lado e nada mais mudou no documento = renomeada (título e texto editados juntos);
//   5. o resto é ambíguo (apagada, nova, ou não dá para saber).
// Um id antigo que NÃO casou mas que o documento novo usa para OUTRA funcionalidade (o deslocamento da família) é
// LIMPO nos cards — sem isso eles entrariam calados na funcionalidade errada.
//
// Falha da remarcação nunca derruba a gravação do PRD: o card não reescrito fica com o id velho ⇒ «Outros» ⇒ âncora.

import type { PrdFeature } from "./doc/prd-features";
import { docSlug } from "./doc/prd-features";
import type { Card } from "./types";

/** Uma remarcação: os cards em `from` passam a `to`; `to: null` = limpar (o card vai a «Outros» e a âncora o religa). */
export interface FeatureRemap {
  from: string;
  to: string | null;
}

/** O texto de uma funcionalidade para comparar (espaços colapsados). Vazio não serve de prova. */
function bodyKey(f: Pick<PrdFeature, "markdown">): string {
  return f.markdown.replace(/\s+/g, " ").trim();
}

/** A família de um id: o slug do NOME (antes da desduplicação). */
function familyOf(f: Pick<PrdFeature, "id" | "name">): string {
  return docSlug(f.name) || f.id;
}

/** Casa por texto, só pares ÚNICOS (dois com o mesmo texto de um lado ⇒ nenhum casa). */
function matchByBody(olds: readonly PrdFeature[], news: readonly PrdFeature[]): [PrdFeature, PrdFeature][] {
  const count = (list: readonly PrdFeature[]) => {
    const m = new Map<string, PrdFeature[]>();
    for (const f of list) {
      const k = bodyKey(f);
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), f]);
    }
    return m;
  };
  const o = count(olds);
  const n = count(news);
  const pairs: [PrdFeature, PrdFeature][] = [];
  for (const [k, os] of o) {
    const ns = n.get(k);
    if (os.length === 1 && ns?.length === 1) pairs.push([os[0], ns[0]]);
  }
  return pairs;
}

/**
 * As remarcações entre o PRD de antes e o de depois (ver o cabeçalho). Só devolve o que MUDA o card: um id mantido não
 * aparece. PURA.
 */
export function featureRenames(before: readonly PrdFeature[], after: readonly PrdFeature[]): FeatureRemap[] {
  const familySize = new Map<string, number>();
  for (const side of [before, after]) {
    const local = new Map<string, number>();
    for (const f of side) local.set(familyOf(f), (local.get(familyOf(f)) ?? 0) + 1);
    for (const [k, v] of local) familySize.set(k, Math.max(familySize.get(k) ?? 0, v));
  }
  const inFamily = (f: PrdFeature) => (familySize.get(familyOf(f)) ?? 0) > 1;

  const pairs: [PrdFeature, PrdFeature][] = [];
  const oldLeft = new Set(before);
  const newLeft = new Set(after);
  const take = (o: PrdFeature, n: PrdFeature) => {
    pairs.push([o, n]);
    oldLeft.delete(o);
    newLeft.delete(n);
  };

  // 1. famílias de slug repetido: só o texto casa.
  const families = new Set([...before, ...after].filter(inFamily).map(familyOf));
  for (const fam of families) {
    const os = before.filter((f) => familyOf(f) === fam);
    const ns = after.filter((f) => familyOf(f) === fam);
    for (const [o, n] of matchByBody(os, ns)) take(o, n);
  }
  // 2. o mesmo id dos dois lados (fora das famílias).
  const newById = new Map(after.filter((f) => !inFamily(f)).map((f) => [f.id, f] as const));
  for (const o of [...oldLeft]) {
    if (inFamily(o)) continue;
    const n = newById.get(o.id);
    if (n && newLeft.has(n)) take(o, n);
  }
  // 3. o mesmo texto.
  for (const [o, n] of matchByBody([...oldLeft], [...newLeft])) take(o, n);
  // 4. sobrou uma de cada lado e nada mais mudou.
  const nothingElseChanged = pairs.every(([o, n]) => o.id === n.id && bodyKey(o) === bodyKey(n));
  if (oldLeft.size === 1 && newLeft.size === 1 && nothingElseChanged) take([...oldLeft][0], [...newLeft][0]);

  const out: FeatureRemap[] = [];
  for (const [o, n] of pairs) if (o.id !== n.id) out.push({ from: o.id, to: n.id });
  // 5. o id que não casou mas foi REUSADO por outra funcionalidade: limpar (senão o card muda de funcionalidade calado).
  const newIds = new Set(after.map((f) => f.id));
  for (const o of oldLeft) if (newIds.has(o.id)) out.push({ from: o.id, to: null });
  return out;
}

/** O que a remarcação precisa do disco (o serviço passa os de verdade; os testes, os seus). */
export interface FeatureRemapDeps {
  readCards(board: string): Promise<Card[]>;
  /** a escrita sob a trava do card (write.ts `updateCardOnDisk`). */
  updateCard(board: string, cardId: string, mutate: (current: Card) => Card | null): Promise<Card | null>;
  /** uma linha de registro por card reescrito (e uma por falha). */
  log(line: string): void;
}

export interface FeatureRemapResult {
  rewritten: string[];
  failed: string[];
}

async function defaultDeps(): Promise<FeatureRemapDeps> {
  const [{ readCards }, { updateCardOnDisk }] = await Promise.all([import("./repo"), import("./write")]);
  return { readCards, updateCard: updateCardOnDisk, log: (line) => console.info(line) };
}

/**
 * Aplica as remarcações de {@link featureRenames} aos cards do board, um por um, sob a trava de cada card. NUNCA
 * lança: um card que falha fica com o id velho (⇒ «Outros» ⇒ âncora) e deixa uma linha de registro.
 */
export async function remapFeatureIds(
  board: string,
  before: readonly PrdFeature[],
  after: readonly PrdFeature[],
  deps?: FeatureRemapDeps,
): Promise<FeatureRemapResult> {
  const result: FeatureRemapResult = { rewritten: [], failed: [] };
  const remaps = featureRenames(before, after);
  if (!remaps.length) return result;
  const to = new Map(remaps.map((r) => [r.from, r.to] as const));
  let d: FeatureRemapDeps;
  let cards: Card[];
  try {
    d = deps ?? (await defaultDeps());
    cards = await d.readCards(board);
  } catch (err) {
    console.warn(`[feature-remap] ${board}: cards ilegíveis, remarcação adiada à âncora —`, err instanceof Error ? err.message : err);
    return result;
  }
  for (const card of cards) {
    const from = card.feature?.trim();
    if (!from || !to.has(from)) continue;
    const next = to.get(from) ?? null;
    try {
      const written = await d.updateCard(board, card.id, (current) =>
        current.feature?.trim() === from ? { ...current, feature: next ?? undefined } : null,
      );
      if (!written) continue;
      result.rewritten.push(card.id);
      d.log(
        next
          ? `[feature-remap] ${board}/${card.id}: funcionalidade renomeada: ${from} → ${next}`
          : `[feature-remap] ${board}/${card.id}: funcionalidade ${from} saiu do PRD (o id passou a outra) — o card vai a «Outros»`,
      );
    } catch (err) {
      result.failed.push(card.id);
      d.log(`[feature-remap] ${board}/${card.id}: remarcação ${from} → ${next ?? "Outros"} falhou (${err instanceof Error ? err.message : String(err)}) — a âncora religa`);
    }
  }
  return result;
}
