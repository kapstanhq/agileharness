// OST edge helpers — traceability between stories and the pains they address.
// The `addresses` linkType (story → idea) is declared in _base/board.yaml.

import type { Card, CardLink, IdeaFields } from "./types";

/** The canonical rel id for the story→idea traceability edge. */
export const ADDRESSES_REL = "addresses" as const;

/** True when a CardLink is a story→idea `addresses` edge. */
export function isAddressesLink(link: CardLink): boolean {
  return link.rel === ADDRESSES_REL;
}

/** True when a card's links[] contain at least one `addresses` edge. */
export function resolvesToIdea(links: CardLink[]): boolean {
  return links.some(isAddressesLink);
}

/**
 * Resolve the idea a story addresses (its FIRST `addresses` edge) against a card pool.
 * Returns the idea Card (type "idea") or null when the story addresses none, the target
 * is missing, or the target isn't an idea. Used to HYDRATE the run context (engine
 * buildContextNote) + the card's value view, so a build agent sees the PAIN its story closes — not
 * just the task. Pure.
 */
export function getAddressedIdea(card: Card, pool: Card[]): Card | null {
  const edge = card.links.find(isAddressesLink);
  if (!edge) return null;
  const target = pool.find((c) => c.id === edge.to);
  return target && target.type === "idea" ? target : null;
}

/**
 * The rollup of an idea: every story in the pool that `addresses` it (solution-space cards pointing
 * UP at this problem-space card). The inverse of {@link getAddressedIdea}; powers the
 * "N stories endereçando" count + traceability. Pure.
 */
export function cardsAddressing(idea: Card, pool: Card[]): Card[] {
  return pool.filter(
    (c) => c.type === "story" && c.links.some((l) => isAddressesLink(l) && l.to === idea.id),
  );
}

/** O que o `create_idea` do MCP recebe — os campos de exploração de uma ideia, todos opcionais. */
export interface IdeaCaptureInput {
  title?: string;
  statement?: string;
  evidence?: string;
  candidateSolutions?: string[];
  keyAssumption?: string;
  successSignal?: string;
}

/**
 * O `create_idea` virou ATALHO da captura: a tela de Ideias saiu e uma ideia nova entra como card da Triagem, igual a
 * qualquer captura. Esta função monta o título e o texto do card a partir dos campos de exploração (o enunciado abre o
 * texto; o resto vira seções curtas). Sem título nem enunciado ⇒ `null` (o chamador recusa). Pura.
 */
export function ideaAsTriageCard(input: IdeaCaptureInput): { title: string; body: string } | null {
  const statement = input.statement?.trim() ?? "";
  const title = input.title?.trim() || statement;
  if (!title) return null;
  const sections: string[] = [];
  if (statement && statement !== title) sections.push(statement);
  const evidence = input.evidence?.trim();
  if (evidence) sections.push(`**O que sustenta:** ${evidence}`);
  const paths = (input.candidateSolutions ?? []).map((s) => s.trim()).filter(Boolean);
  if (paths.length) sections.push(["**Caminhos possíveis:**", ...paths.map((p) => `- ${p}`)].join("\n"));
  const assumption = input.keyAssumption?.trim();
  if (assumption) sections.push(`**Premissa mais arriscada:** ${assumption}`);
  const signal = input.successSignal?.trim();
  if (signal) sections.push(`**Como saber que deu certo:** ${signal}`);
  return { title, body: sections.join("\n\n") };
}

/**
 * A IMPRESSÃO DIGITAL do bloco `idea` — a base de comparação do anti-clobber (ver `expectedIdea` em
 * updateCardAction). Canônica de propósito: as chaves são emitidas em ORDEM FIXA, porque `JSON.stringify`
 * depende da ordem de inserção e um `delete` + re-atribuição (que a persistência esparsa faz o tempo todo)
 * reordena o objeto — a mesma armadilha que já quebrou a invariante no-op ≡ no-write do documento.
 *
 * Cobre só o que o AUTOR escreve. `status`/`discardReason` ficam de fora: quem os move é o humano, por outra
 * superfície, e incluí-los faria um descarte legítimo invalidar a edição de texto que está em curso. Pura.
 */
export function ideaFingerprint(idea: IdeaFields | null | undefined): string {
  if (!idea) return "";
  return JSON.stringify([
    idea.statement ?? "",
    idea.evidence ?? "",
    idea.keyAssumption ?? "",
    idea.successSignal ?? "",
    idea.candidateSolutions ?? [],
  ]);
}
