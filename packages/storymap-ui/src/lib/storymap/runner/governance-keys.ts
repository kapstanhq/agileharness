// As CHAVES DE GOVERNANÇA do board.yaml (e do card) — o que só o operador decide e que, por isso, o merge train nunca
// aceita de um worktree. Hoje: `organizeOnly` (o board só de organização) e a AUTONOMIA (autonomy-profile.ts: o perfil
// `autonomy.agentDecides` e as chaves que ele mantém coerentes — `autonomy.mode`, `release.mode`, `orchestrator`). Um run (ou uma sessão) que altera essa chave no board.yaml
// do seu worktree tem o resto da mudança aterrissado normalmente, mas o valor da chave volta ao que está vivo em main;
// um board.yaml NOVO nasce sem autonomia de agente; e a exceção POR CARD (`autonomyMode`, `ownerReviewsUi`) também
// volta à de main (restoreCardGovernance).
// PURO: recebe textos, devolve o texto corrigido (ou null quando não há nada a corrigir).

import yaml from "js-yaml";
import { parseYamlMap } from "@/lib/storymap/frontmatter";
import { autonomyKeysFingerprint } from "@/lib/storymap/autonomy-profile";
import type { AutonomyMode, BoardConfig, Card } from "@/lib/storymap/types";

/** A impressão digital da AUTONOMIA de um board.yaml como texto; null quando não se parseia. */
export function autonomyIn(raw: string): string | null {
  try {
    return autonomyKeysFingerprint(parseYamlMap(raw) as unknown as Pick<BoardConfig, "autonomy" | "release" | "orchestrator">);
  } catch {
    return null;
  }
}

/** O caminho de um board.yaml (relativo ao repositório ou absoluto). */
export const BOARD_YAML_RE = /(^|\/)boards\/[^/]+\/board\.yaml$/;

/** O valor de `organizeOnly` como o parser do board o lê; null quando o texto não se parseia. */
export function organizeOnlyIn(raw: string): boolean | null {
  try {
    return parseYamlMap(raw).organizeOnly === true;
  } catch {
    return null;
  }
}

/** Uma linha de topo que declara a chave (qualquer grafia de chave que o YAML aceita: nua ou entre aspas). */
const KEY_LINE = /^(?:organizeOnly|"organizeOnly"|'organizeOnly')[ \t]*:.*(?:\r?\n|$)/gm;

/** Um mapa YAML (objeto simples), ou null. */
const asMap = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Um board.yaml NOVO (que main ainda não tem) chegando de um worktree: sem nenhuma autonomia de agente. Tira o bloco
 * explícito (`autonomy.agentDecides`) e as chaves coerentes que dão autonomia (`autonomy.mode`, `release.mode`,
 * `orchestrator.mode` e a matriz de risco) — o board nasce na Mínima, e só o operador o sobe pelo painel. Devolve o
 * texto corrigido, ou null quando não há nada a tirar (o texto que aterrissou fica byte a byte). PURA.
 */
export function stripAgentAutonomy(raw: string): string | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseYamlMap(raw);
  } catch {
    return null;
  }
  let changed = false;
  const drop = (obj: Record<string, unknown> | null, key: string) => {
    if (obj && key in obj) {
      delete obj[key];
      changed = true;
    }
  };
  const autonomy = asMap(doc.autonomy);
  drop(autonomy, "agentDecides");
  if (autonomy?.mode === "ultra") drop(autonomy, "mode");
  const release = asMap(doc.release);
  if (release?.mode === "auto") drop(release, "mode");
  const orch = asMap(doc.orchestrator);
  if (Object.values(asMap(orch?.riskMatrix) ?? {}).includes("auto")) drop(orch, "riskMatrix");
  if (orch?.mode === "autonomous") {
    orch.mode = "off";
    changed = true;
  }
  for (const k of ["autonomy", "release"] as const) {
    const m = asMap(doc[k]);
    if (m && Object.keys(m).length === 0) delete doc[k];
  }
  return changed ? yaml.dump(doc, { lineWidth: 120, noRefs: true }) : null;
}

/**
 * Devolve o board.yaml que aterrissou com as chaves de governança de volta ao valor vivo de main (`liveText`), ou null
 * quando nada muda. `organizeOnly` por linha; a AUTONOMIA inteira (o board.yaml volta ao de main quando ela mudou num
 * worktree — e, num board NOVO, sai toda: `stripAgentAutonomy`). Se a correção por linha não chegar ao valor esperado
 * (uma forma exótica), devolve o texto vivo inteiro: perder a parte não-governança dessa mudança é melhor que deixar um
 * worktree mudar a chave.
 */
export function restoreGovernanceKeys(landedText: string, liveText: string | null): string | null {
  // A AUTONOMIA mudada num worktree: as chaves dela são aninhadas (blocos), então não há correção por linha segura — o
  // board.yaml volta inteiro ao de main (a regra de sempre: perder a parte não-governança é melhor que deixar um
  // worktree mudar o que os agentes decidem sozinhos).
  if (liveText !== null) {
    const liveA = autonomyIn(liveText);
    const landedA = autonomyIn(landedText);
    if (liveA !== null && landedA !== null && liveA !== landedA) return liveText;
  }
  // Um board NOVO não nasce com autonomia de agente: main não tem o que restaurar, então ela sai.
  const stripped = liveText === null ? stripAgentAutonomy(landedText) : null;
  const text = stripped ?? landedText;
  const live = liveText === null ? false : organizeOnlyIn(liveText);
  const landed = organizeOnlyIn(text);
  if (live === null) return stripped; // main ilegível: não é o train quem decide
  if (landed === live) return stripped;
  let next = text.replace(KEY_LINE, "");
  if (live) next = `${next.replace(/\s*$/, "")}\norganizeOnly: true\n`;
  if (organizeOnlyIn(next) === live) return next;
  return liveText ?? text.replace(KEY_LINE, "");
}

// ── a exceção de autonomia POR CARD ──────────────────────────────────────────────────────────────────────────────

/** As chaves de governança de um card: a exceção de autonomia e o pedido do dono de ver as telas. */
export interface CardGovernance {
  autonomyMode: AutonomyMode | null;
  ownerReviewsUi: boolean;
}

/** As chaves de governança de um card (null = o card não existe em main). PURA. */
export function cardGovernanceOf(card: Pick<Card, "autonomyMode" | "ownerReviewsUi"> | null | undefined): CardGovernance | null {
  return card ? { autonomyMode: card.autonomyMode ?? null, ownerReviewsUi: card.ownerReviewsUi === true } : null;
}

/**
 * O card que aterrissou de um worktree com as chaves de governança de volta às de main — ou null quando já batem. Um
 * agente edita o card do PRÓPRIO worktree à vontade (o train funde o frontmatter), e `autonomyMode: ultra` ali liberaria
 * «Aprovar entrega» para aquele card; só o operador muda a exceção (`set_card_autonomy`, classe destrutiva). Card NOVO
 * (main não o tem): nasce sem exceção; o pedido de ver as telas, que só aperta, fica. PURA.
 */
export function restoreCardGovernance<T extends Pick<Card, "autonomyMode" | "ownerReviewsUi">>(landed: T, live: CardGovernance | null): T | null {
  const wantMode = live?.autonomyMode ?? null;
  const wantUi = live ? live.ownerReviewsUi : landed.ownerReviewsUi === true;
  if ((landed.autonomyMode ?? null) === wantMode && (landed.ownerReviewsUi === true) === wantUi) return null;
  const { autonomyMode: _m, ownerReviewsUi: _u, ...rest } = landed;
  return { ...rest, ...(wantMode ? { autonomyMode: wantMode } : {}), ...(wantUi ? { ownerReviewsUi: true } : {}) } as T;
}
