// A ÁRVORE DE ARQUITETURA da revisão — o que JÁ EXISTE e o que SERÁ CRIADO, num desenho só.
//
// A árvore anterior (`proposal-tree.ts`) só enxergava o LOTE: montava arestas `parent` entre itens
// propostos e resolvia o pai existente para uma linha de cabeçalho ("sob ↳ Step «…»"). Faltava
// justamente o contexto que decide a revisão:
//   • os cards que já vivem naquele lugar — sem eles não dá para julgar "isto é duplicata ou é
//     filho?", que foi exatamente a dúvida do operador ao ver "possível duplicata de story-…";
//   • o eixo `serves`: uma entrega proposta sob uma user story existente NÃO é aresta de `parent`,
//     então ela caía no grupo "sem encaixe (novo backbone)" — a arquitetura CERTA desenhada como se
//     fosse a errada;
//   • o modo ESTENDER, que não cria card nenhum e por definição pendura num card existente.
//
// Este módulo é PURO e não sabe nada de React: recebe os itens propostos + os cards do board e
// devolve a árvore unificada. A regra de "onde cada item ancora" NÃO é reimplementada aqui — vem de
// `placementSpec` (gate-core), a mesma que o chokepoint de escrita usa.

import { placementSpec } from "../gate-core";
import { byOrder } from "../order";
import type { BoardConfig, Card } from "../types";
import type { ProposedItem } from "./types";

export type NodeOrigin = "existing" | "proposed";

export interface ArchitectureNode {
  /** `existing` = já está no board (contexto, esmaecido); `proposed` = este lote vai criar. */
  origin: NodeOrigin;
  /** id do card (existing) ou tempId (proposed) — chave estável de render. */
  key: string;
  title: string;
  /** o card existente, quando origin === "existing". */
  card?: Card;
  /** o item proposto, quando origin === "proposed". */
  item?: ProposedItem;
  /**
   * Itens do lote que ESTENDEM este card existente (só acrescentam tasks). Ficam no próprio nó em vez
   * de virarem filhos: eles não são um card, são trabalho DENTRO deste.
   */
  extendedBy: ProposedItem[];
  children: ArchitectureNode[];
}

/** O que um card existente É, em PT-BR, para o rótulo do nó. */
export function existingCardLabel(card: Card): string {
  if (card.type === "activity") return "Ação";
  if (card.type === "step") return "Passo";
  if (card.type === "idea") return "Ideia";
  const st = card.storyType ?? "user";
  return st === "user" ? "User story" : `Entrega · ${st}`;
}

/**
 * O nó do mapa a que um card EXISTENTE está preso — `serves` vence `parent` (é o `servesTarget` do
 * dual-track). Uma definição só, usada pela árvore da proposta E pela vizinhança do card.
 */
export function anchorOfCard(c: Card): string | null {
  const isDelivery = c.type === "story" && !!c.storyType && c.storyType !== "user";
  return (isDelivery ? (c.serves ?? c.parent) : c.parent) ?? null;
}

/**
 * A âncora que um item declara — id + se ele ancora por `serves` ou por `parent`. Deriva de
 * `placementSpec` (fonte única). Um item em modo ESTENDER ancora no `targetCardId`.
 */
export function proposedAnchorId(item: ProposedItem, config: BoardConfig): string | null {
  if (item.targetCardId) return item.targetCardId;
  const spec = placementSpec(
    { type: item.type, storyType: item.storyType ?? null, parent: item.parent ?? null, serves: item.serves ?? null } as Card,
    config,
  );
  return spec && !spec.rootOnly ? spec.anchorId : null;
}

/**
 * Monta a árvore de arquitetura. Devolve as RAÍZES a renderizar:
 *  • cada card existente que serve de âncora entra com a sua CADEIA DE ANCESTRAIS (para o operador
 *    ler "Ação › Passo › Story" e saber onde está), e com os FILHOS que já existem sob a âncora —
 *    é isso que torna a duplicata visível ao lado do item novo;
 *  • itens propostos penduram sob a sua âncora (existente ou do próprio lote);
 *  • itens sem âncora nenhuma caem numa raiz sintética (`key: UNANCHORED_KEY`), que a UI rotula
 *    como "ainda sem lugar" — legítimo, porque eles nascem na quarentena.
 *
 * `contextChildren` liga a exibição dos filhos JÁ EXISTENTES de cada âncora (default true). É o que
 * dá o contexto de vizinhança; desligue para uma visão enxuta.
 */
export const UNANCHORED_KEY = "__sem-lugar__";

export function buildArchitectureTree(
  items: ProposedItem[],
  cards: Card[],
  config: BoardConfig,
  opts: { contextChildren?: boolean } = {},
): ArchitectureNode[] {
  const contextChildren = opts.contextChildren ?? true;
  const byId = new Map(cards.map((c) => [c.id, c]));
  const byTempId = new Map(items.map((i) => [i.tempId, i]));

  // ── 1. quais cards existentes precisam aparecer: as âncoras + a cadeia de ancestrais delas ──
  const needed = new Set<string>();
  const addWithAncestors = (id: string) => {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      needed.add(cur);
      cur = anchorOfCard(byId.get(cur)!);
    }
  };
  for (const it of items) {
    const anchor = proposedAnchorId(it, config);
    if (anchor && byId.has(anchor)) addWithAncestors(anchor);
  }

  // ── 2. a VIZINHANÇA já existente de cada âncora — o contexto que decide a revisão ──
  // Profundidade 2 a partir da âncora, deliberadamente: sob um PASSO isso traz as user stories dele
  // E as entregas de cada uma (é o que expõe "esta superfície já tem story, e ela já tem trabalho"),
  // e sob uma ACTIVITY traz os passos e as stories. Ir mais fundo despejaria a subárvore inteira;
  // parar em 1 esconderia justamente a prateleira que motivou este módulo.
  const CONTEXT_DEPTH = 2;
  if (contextChildren) {
    const childrenOf = new Map<string, Card[]>();
    for (const c of cards) {
      const a = anchorOfCard(c);
      if (a) childrenOf.set(a, [...(childrenOf.get(a) ?? []), c]);
    }
    const anchors = new Set(
      items.map((it) => proposedAnchorId(it, config)).filter((id): id is string => !!id && byId.has(id)),
    );
    const addDescendants = (id: string, depth: number) => {
      if (depth > CONTEXT_DEPTH) return;
      for (const child of childrenOf.get(id) ?? []) {
        needed.add(child.id);
        addDescendants(child.id, depth + 1);
      }
    };
    for (const a of anchors) addDescendants(a, 1);
  }

  // ── 3. materializa os nós ──
  const nodes = new Map<string, ArchitectureNode>();
  for (const id of needed) {
    const card = byId.get(id)!;
    nodes.set(id, { origin: "existing", key: id, title: card.title, card, extendedBy: [], children: [] });
  }
  for (const it of items) {
    if (it.targetCardId) continue; // não vira nó: é trabalho DENTRO de um card existente
    nodes.set(it.tempId, { origin: "proposed", key: it.tempId, title: it.title, item: it, extendedBy: [], children: [] });
  }

  // ── 4. liga as arestas ──
  const roots: ArchitectureNode[] = [];
  const unanchored: ArchitectureNode = {
    origin: "proposed",
    key: UNANCHORED_KEY,
    title: "",
    extendedBy: [],
    children: [],
  };

  for (const id of needed) {
    const card = byId.get(id)!;
    const a = anchorOfCard(card);
    const parentNode = a ? nodes.get(a) : null;
    if (parentNode) parentNode.children.push(nodes.get(id)!);
    else roots.push(nodes.get(id)!);
  }
  for (const it of items) {
    if (it.targetCardId) {
      const target = nodes.get(it.targetCardId);
      if (target) target.extendedBy.push(it);
      else unanchored.children.push({ origin: "proposed", key: it.tempId, title: it.title, item: it, extendedBy: [], children: [] });
      continue;
    }
    const node = nodes.get(it.tempId)!;
    const spec = placementSpec(
      { type: it.type, storyType: it.storyType ?? null, parent: it.parent ?? null, serves: it.serves ?? null } as Card,
      config,
    );
    // Raiz LEGÍTIMA: activity (rootOnly) e o que não vive no backbone (idea). Vai para o topo.
    if (!spec || spec.rootOnly) {
      roots.push(node);
      continue;
    }
    const parentNode = spec.anchorId ? nodes.get(spec.anchorId) : null;
    if (parentNode) parentNode.children.push(node);
    else {
      // Sem âncora (decisão adiada, legítima na quarentena) OU âncora QUEBRADA: o item NÃO some da
      // tela. Sumir seria pior — se for âncora quebrada o commit recusa por causa dele, e o operador
      // não saberia qual item olhar.
      unanchored.children.push(node);
    }
  }
  if (unanchored.children.length) roots.push(unanchored);

  // ── 5. ordena: existentes primeiro (contexto), depois os novos; estável por `order`/ordem original ──
  const origIndex = new Map(items.map((i, idx) => [i.tempId, idx] as const));
  const sortChildren = (n: ArchitectureNode) => {
    n.children.sort((a, b) => {
      if (a.origin !== b.origin) return a.origin === "existing" ? -1 : 1;
      if (a.card && b.card) return byOrder(a.card, b.card);
      return (origIndex.get(a.key) ?? 0) - (origIndex.get(b.key) ?? 0);
    });
    n.children.forEach(sortChildren);
  };
  roots.forEach(sortChildren);
  roots.sort((a, b) => {
    if (a.key === UNANCHORED_KEY) return 1;
    if (b.key === UNANCHORED_KEY) return -1;
    if (a.card && b.card) return byOrder(a.card, b.card);
    return 0;
  });
  return roots;
}

// ── A LEITURA da revisão: grupos "onde entra" → "o que entra" ────────────────────────────────────
//
// A árvore acima desenha TUDO (contexto incluso) e é a fonte da verdade estrutural. Mas para REVISAR
// uma proposta o operador só precisa de duas coisas: **onde** cada item novo vai morar e **o que** ele
// é. Desenhar o contexto como nós de primeira classe (uma caixa por card existente, com a vizinhança
// em profundidade 2) afogava os 1-2 cards novos no meio de dezenas de linhas de cards que já existem —
// bugs, entregas e irmãos que a decisão não usa. Aqui a cadeia de existentes vira UM CAMINHO de texto
// (Ação › Passo › Story) e os itens novos ficam sozinhos como conteúdo.

/** Grupo da revisão: um lugar do mapa (o caminho) + os itens do lote que nascem ali. */
export interface ProposalGroup {
  /** id da âncora existente, ou `ROOT_GROUP_KEY` / `UNANCHORED_KEY`. */
  key: string;
  /** cadeia de cards EXISTENTES até a âncora — a âncora é o ÚLTIMO. Vazia = topo do mapa. */
  path: Card[];
  /** itens propostos que ancoram aqui (subárvores, quando o lote propõe backbone novo). */
  nodes: ArchitectureNode[];
  /** itens em modo ESTENDER: não criam card, só acrescentam tasks à âncora. */
  extendedBy: ProposedItem[];
}

/** Grupo dos itens que nascem no TOPO do mapa (activity nova, ideia) — sem pai por definição. */
export const ROOT_GROUP_KEY = "__topo__";

/**
 * Achata a árvore em grupos de revisão. Deriva de `buildArchitectureTree` com `contextChildren:false`:
 * só a CADEIA de ancestrais de cada âncora entra — nunca os irmãos/vizinhos, que são ruído na decisão
 * (a duplicata suspeita continua nomeada no próprio item, por `duplicateOf`).
 */
export function buildProposalGroups(items: ProposedItem[], cards: Card[], config: BoardConfig): ProposalGroup[] {
  const roots = buildArchitectureTree(items, cards, config, { contextChildren: false });
  const groups: ProposalGroup[] = [];
  let rootGroup: ProposalGroup | null = null;

  const visitExisting = (node: ArchitectureNode, trail: Card[]) => {
    const path = [...trail, node.card!];
    const proposed = node.children.filter((c) => c.origin === "proposed");
    if (proposed.length || node.extendedBy.length) {
      groups.push({ key: node.key, path, nodes: proposed, extendedBy: node.extendedBy });
    }
    for (const child of node.children) if (child.origin === "existing") visitExisting(child, path);
  };

  for (const root of roots) {
    if (root.key === UNANCHORED_KEY) {
      groups.push({ key: UNANCHORED_KEY, path: [], nodes: root.children, extendedBy: [] });
    } else if (root.origin === "existing") {
      visitExisting(root, []);
    } else if (rootGroup) {
      rootGroup.nodes.push(root);
    } else {
      rootGroup = { key: ROOT_GROUP_KEY, path: [], nodes: [root], extendedBy: [] };
      groups.push(rootGroup); // na posição em que o primeiro item de topo apareceu
    }
  }
  return groups;
}

/** Todos os tempIds de itens PROPOSTOS presentes na árvore — para a UI garantir que nada some. */
export function proposedKeysInTree(roots: ArchitectureNode[]): Set<string> {
  const out = new Set<string>();
  const walk = (n: ArchitectureNode) => {
    if (n.origin === "proposed" && n.item) out.add(n.key);
    n.extendedBy.forEach((it) => out.add(it.tempId));
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/**
 * A VIZINHANÇA de um card já existente — a mesma árvore, centrada nele, para o DETALHE do card.
 *
 * Responde de um olhar as três perguntas que duas linhas de texto ("Pai (step): — / Serve: X") não
 * respondem: **onde eu vivo** (a cadeia Ação › Passo › Story acima), **quem mais vive aqui** (os
 * irmãos sob a mesma âncora) e **o que pende de mim** (os filhos). Todos os nós são `existing`; quem
 * desenha marca o foco comparando `key === focusId`.
 *
 * Escopo deliberado — vizinhança, não o board inteiro: ancestrais + irmãos + descendentes até
 * profundidade 2. Mais que isso vira o mapa, que já tem a sua própria tela.
 */
export function buildCardNeighborhood(focusId: string, cards: Card[], config: BoardConfig): ArchitectureNode[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const focus = byId.get(focusId);
  if (!focus) return [];

  const childrenOf = new Map<string, Card[]>();
  for (const c of cards) {
    const a = anchorOfCard(c);
    if (a) childrenOf.set(a, [...(childrenOf.get(a) ?? []), c]);
  }

  const needed = new Set<string>([focusId]);
  // ancestrais (onde eu vivo)
  let cur = anchorOfCard(focus);
  const seen = new Set<string>([focusId]);
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    needed.add(cur);
    cur = anchorOfCard(byId.get(cur)!);
  }
  // irmãos (quem mais vive aqui)
  const parentId = anchorOfCard(focus);
  if (parentId) for (const sib of childrenOf.get(parentId) ?? []) needed.add(sib.id);
  // descendentes até profundidade 2 (o que pende de mim)
  const addDescendants = (id: string, depth: number) => {
    if (depth > 2) return;
    for (const child of childrenOf.get(id) ?? []) {
      needed.add(child.id);
      addDescendants(child.id, depth + 1);
    }
  };
  addDescendants(focusId, 1);

  const nodes = new Map<string, ArchitectureNode>();
  for (const id of needed) {
    const card = byId.get(id)!;
    nodes.set(id, { origin: "existing", key: id, title: card.title, card, extendedBy: [], children: [] });
  }
  const roots: ArchitectureNode[] = [];
  for (const id of needed) {
    const a = anchorOfCard(byId.get(id)!);
    const parentNode = a ? nodes.get(a) : null;
    if (parentNode) parentNode.children.push(nodes.get(id)!);
    else roots.push(nodes.get(id)!);
  }
  const sortChildren = (n: ArchitectureNode) => {
    n.children.sort((a, b) => (a.card && b.card ? byOrder(a.card, b.card) : 0));
    n.children.forEach(sortChildren);
  };
  roots.forEach(sortChildren);
  return roots;
}
