// OST edge helpers — traceability between stories and the pains they address.
// The `addresses` linkType (story → idea) is declared in _base/board.yaml.

import { IDEA_STATUSES, IDEA_TERMINAL_STATUS_IDS, type IdeaStatus } from "./frameworks";
import { ideaTs } from "./idea-recency";
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
 * UP at this problem-space card). The inverse of {@link getAddressedIdea}; powers the Ideias
 * bench's "N stories endereçando" count + traceability. Pure.
 */
export function cardsAddressing(idea: Card, pool: Card[]): Card[] {
  return pool.filter(
    (c) => c.type === "story" && c.links.some((l) => isAddressesLink(l) && l.to === idea.id),
  );
}

/**
 * O AGRUPAMENTO da bancada de Ideias — por estado de EXPLORAÇÃO, na ordem do ciclo de vida
 * (Nova → Explorando → Decidida → Descartada).
 *
 * Antes a lista agrupava por RECÊNCIA (esta semana / este mês / antigas), e essa é outra pergunta:
 * recência responde "no que eu mexi", exploração responde "o que eu ainda não decidi" — e é esta que
 * a tela existe para responder (uma Ideia, por ADR-066, amadurece como documento ATÉ virar decisão).
 * Como efeito colateral bom, o agrupamento deixa de depender de fuso horário: a dança
 * `now === null` que existia só para não quebrar a hidratação morre com o agrupamento por data.
 *
 * Três garantias que o fazem degradar bem numa bancada pequena — hoje os boards têm 1 a 3 ideias, e
 * cabeçalho para grupo de um item é enfeite:
 *   • grupos vazios não saem;
 *   • com UM grupo não-vazio, `label` vem `null` (o chamador não desenha cabeçalho) — a tela volta a
 *     ser exatamente a lista plana de antes, e ganha os cabeçalhos sozinha quando o backlog cresce;
 *   • os ENCERRADOS (`IDEA_TERMINAL_STATUS_IDS`) vêm marcados `terminal`, para o chamador colapsá-los
 *     no fim — separados, nunca fundidos num "Encerradas", que esconderia QUAL desfecho.
 *
 * Ideia sem `status` cai em "open" — o mesmo default de `repo.ts` na leitura e de `IdeaBlock` no
 * pontinho da linha, para o grupo e o ponto nunca discordarem. Pura.
 */
export function groupIdeasByStatus(ideas: Card[]): IdeaStatusGroup[] {
  const byStatus = new Map<IdeaStatus, Card[]>();
  for (const idea of ideas) {
    const status = idea.idea?.status ?? "open";
    const bucket = byStatus.get(status);
    if (bucket) bucket.push(idea);
    else byStatus.set(status, [idea]);
  }
  const groups = IDEA_STATUSES.filter((s) => (byStatus.get(s.id)?.length ?? 0) > 0).map((s) => ({
    key: s.id,
    label: s.name as string | null,
    hint: s.short,
    color: s.color,
    terminal: IDEA_TERMINAL_STATUS_IDS.includes(s.id),
    // Dentro do grupo, o mais recente no topo — `ideaTs` segue sendo a régua de "quando chegou".
    items: [...(byStatus.get(s.id) ?? [])].sort((a, b) => ideaTs(b) - ideaTs(a)),
  }));
  if (groups.length === 1) return [{ ...groups[0], label: null }];
  return groups;
}

export interface IdeaStatusGroup {
  key: IdeaStatus;
  /** `null` quando não há o que distinguir (um grupo só) — o chamador omite o cabeçalho. */
  label: string | null;
  hint: string;
  color: string;
  /** Exploração ENCERRADA (decidida/descartada) — o chamador colapsa. */
  terminal: boolean;
  items: Card[];
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
