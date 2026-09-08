import { describe, expect, it } from "vitest";
import {
  buildArchitectureTree,
  buildCardNeighborhood,
  buildProposalGroups,
  proposedKeysInTree,
  ROOT_GROUP_KEY,
  UNANCHORED_KEY,
  type ArchitectureNode,
} from "./architecture-tree";
import type { ProposedItem } from "./types";
import type { BoardConfig, Card } from "../types";

// A árvore que a revisão desenha. O caso que motivou este módulo é o "agenda": o board já tem a user
// story da tela, e o pedido é mais trabalho SOBRE ela. A árvore precisa mostrar a story existente com
// o item novo pendurado nela — e não o item novo num grupo "sem encaixe", que era o que acontecia
// porque `serves` não era aresta.

const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "concluida", name: "Concluída", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (over: Partial<Card> & Pick<Card, "id" | "type">): Card =>
  ({ title: over.id, parent: null, order: 0, links: [], ...over }) as Card;

const BOARD: Card[] = [
  card({ id: "act-perfil", type: "activity", title: "Gerir meu perfil" }),
  card({ id: "step-agenda", type: "step", title: "Curar a agenda pessoal", parent: "act-perfil" }),
  card({ id: "story-agenda", type: "story", storyType: "user", title: "Consultar a agenda salva", parent: "step-agenda", status: "concluida" }),
  card({ id: "story-cache", type: "story", storyType: "technical", title: "Cachear a consulta", serves: "story-agenda" }),
  card({ id: "step-outro", type: "step", title: "Outro passo", parent: "act-perfil" }),
];

const item = (over: Partial<ProposedItem>): ProposedItem => ({
  tempId: "i1",
  type: "story",
  title: "Item",
  rationale: "",
  ...over,
});

/** Caminho legível "chave > chave" de cada folha, para asserir a FORMA da árvore de uma vez. */
const paths = (roots: ArchitectureNode[]): string[] => {
  const out: string[] = [];
  const walk = (n: ArchitectureNode, trail: string[]) => {
    const here = [...trail, n.key];
    if (!n.children.length) out.push(here.join(" > "));
    n.children.forEach((c) => walk(c, here));
  };
  roots.forEach((r) => walk(r, []));
  return out;
};

describe("buildArchitectureTree — o existente e o novo no mesmo desenho", () => {
  it("pendura a ENTREGA proposta sob a user story que ela serve, com a cadeia de ancestrais", () => {
    const roots = buildArchitectureTree(
      [item({ tempId: "novo", storyType: "chore", title: "Reagrupar por dia", serves: "story-agenda" })],
      BOARD,
      config,
    );
    // a árvore mostra Ação › Passo › Story existente › (entrega existente + a nova)
    expect(paths(roots)).toEqual([
      "act-perfil > step-agenda > story-agenda > story-cache",
      "act-perfil > step-agenda > story-agenda > novo",
    ]);
  });

  it("mostra os IRMÃOS já existentes da âncora — é o que torna a duplicata visível", () => {
    const roots = buildArchitectureTree(
      [item({ tempId: "novo", storyType: "user", title: "Story irmã", parent: "step-agenda" })],
      BOARD,
      config,
    );
    // sob o step aparecem a story que já existe (com a entrega dela) E a proposta
    expect(paths(roots)).toEqual([
      "act-perfil > step-agenda > story-agenda > story-cache",
      "act-perfil > step-agenda > novo",
    ]);
  });

  it("o item que ESTENDE não vira nó — vira trabalho DENTRO do card existente", () => {
    const extend = item({ tempId: "ext", targetCardId: "story-agenda", tasks: [{ title: "agrupar por dia" }] });
    const roots = buildArchitectureTree([extend], BOARD, config);
    expect(paths(roots)).toEqual(["act-perfil > step-agenda > story-agenda > story-cache"]);
    const story = roots[0]!.children[0]!.children[0]!;
    expect(story.key).toBe("story-agenda");
    expect(story.extendedBy.map((i) => i.tempId)).toEqual(["ext"]);
    // e ele continua contabilizado como item proposto presente na árvore
    expect(proposedKeysInTree(roots).has("ext")).toBe(true);
  });

  it("aninha o backbone PROPOSTO no mesmo lote (resolve por tempId)", () => {
    const roots = buildArchitectureTree(
      [
        item({ tempId: "s1", type: "step", title: "Passo novo", parent: "act-perfil" }),
        item({ tempId: "u1", storyType: "user", title: "Story nova", parent: "s1" }),
      ],
      BOARD,
      config,
    );
    // e a vizinhança da activity vem junto (profundidade 2): é o que evita propor um passo que já
    // existe — o mesmo mecanismo que expõe a duplicata um nível abaixo.
    expect(paths(roots)).toEqual([
      "act-perfil > step-agenda > story-agenda",
      "act-perfil > step-outro",
      "act-perfil > s1 > u1",
    ]);
  });

  it("item sem âncora vai para a raiz sintética 'sem lugar' — visível, nunca sumindo", () => {
    const roots = buildArchitectureTree([item({ tempId: "solto", storyType: "user", title: "Solta" })], BOARD, config);
    expect(roots.map((r) => r.key)).toEqual([UNANCHORED_KEY]);
    expect(roots[0]!.children.map((c) => c.key)).toEqual(["solto"]);
  });

  it("item com âncora QUEBRADA também aparece — senão o operador não sabe quem derrubou o lote", () => {
    const roots = buildArchitectureTree(
      [item({ tempId: "quebrado", storyType: "user", title: "Aponta fantasma", parent: "step-fantasma" })],
      BOARD,
      config,
    );
    expect(proposedKeysInTree(roots).has("quebrado")).toBe(true);
  });

  it("nenhum item proposto some da árvore, em qualquer combinação", () => {
    const items = [
      item({ tempId: "a", storyType: "user", parent: "step-agenda" }),
      item({ tempId: "b", storyType: "bug", serves: "story-agenda" }),
      item({ tempId: "c", targetCardId: "story-agenda", tasks: [{ title: "x" }] }),
      item({ tempId: "d", storyType: "user" }),
      item({ tempId: "e", type: "step", parent: "act-perfil" }),
    ];
    const roots = buildArchitectureTree(items, BOARD, config);
    expect([...proposedKeysInTree(roots)].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("contextChildren:false enxuga — só a cadeia da âncora, sem a vizinhança", () => {
    const roots = buildArchitectureTree(
      [item({ tempId: "novo", storyType: "chore", serves: "story-agenda" })],
      BOARD,
      config,
      { contextChildren: false },
    );
    expect(paths(roots)).toEqual(["act-perfil > step-agenda > story-agenda > novo"]);
  });
});

// A LEITURA da revisão: "onde entra" (um caminho de texto) × "o que entra" (os cards novos). O que o
// operador reclamou da versão anterior: a vizinhança inteira do passo (bugs, entregas, stories irmãs)
// era desenhada como nó de primeira classe e afogava o único card novo do lote.
describe("buildProposalGroups — só o caminho até o pai, nunca a vizinhança", () => {
  it("dá UM grupo com a cadeia de ancestrais no caminho e só o item novo como conteúdo", () => {
    const groups = buildProposalGroups(
      [item({ tempId: "novo", storyType: "bug", title: "Bug novo", serves: "story-agenda" })],
      BOARD,
      config,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("story-agenda");
    expect(groups[0]!.path.map((c) => c.id)).toEqual(["act-perfil", "step-agenda", "story-agenda"]);
    // a entrega que JÁ existe sob a story (story-cache) NÃO entra — é vizinhança, não decisão
    expect(groups[0]!.nodes.map((n) => n.key)).toEqual(["novo"]);
  });

  it("um item por âncora diferente = um grupo por âncora, cada um com o seu caminho", () => {
    const groups = buildProposalGroups(
      [
        item({ tempId: "a", storyType: "user", parent: "step-agenda" }),
        item({ tempId: "b", storyType: "user", parent: "step-outro" }),
      ],
      BOARD,
      config,
    );
    expect(groups.map((g) => [g.key, g.nodes.map((n) => n.key)])).toEqual([
      ["step-agenda", ["a"]],
      ["step-outro", ["b"]],
    ]);
  });

  it("backbone proposto no mesmo lote continua ANINHADO dentro do grupo (não vira grupo)", () => {
    const groups = buildProposalGroups(
      [
        item({ tempId: "s1", type: "step", title: "Passo novo", parent: "act-perfil" }),
        item({ tempId: "u1", storyType: "user", title: "Story nova", parent: "s1" }),
      ],
      BOARD,
      config,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("act-perfil");
    expect(groups[0]!.nodes.map((n) => n.key)).toEqual(["s1"]);
    expect(groups[0]!.nodes[0]!.children.map((n) => n.key)).toEqual(["u1"]);
  });

  it("ESTENDER entra no grupo da âncora, como trabalho DENTRO dela — nunca como card novo", () => {
    const groups = buildProposalGroups(
      [item({ tempId: "ext", targetCardId: "story-agenda", tasks: [{ title: "agrupar por dia" }] })],
      BOARD,
      config,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.nodes).toEqual([]);
    expect(groups[0]!.extendedBy.map((i) => i.tempId)).toEqual(["ext"]);
  });

  it("activity/ideia novas caem no grupo do TOPO; sem lugar cai no grupo de quarentena", () => {
    const groups = buildProposalGroups(
      [
        item({ tempId: "act", type: "activity", title: "Ação nova" }),
        item({ tempId: "solto", storyType: "user", title: "Solta" }),
      ],
      BOARD,
      config,
    );
    expect(groups.map((g) => g.key)).toEqual([ROOT_GROUP_KEY, UNANCHORED_KEY]);
    expect(groups[0]!.nodes.map((n) => n.key)).toEqual(["act"]);
    expect(groups[1]!.nodes.map((n) => n.key)).toEqual(["solto"]);
  });

  it("nenhum item proposto some dos grupos, em qualquer combinação", () => {
    const items = [
      item({ tempId: "a", storyType: "user", parent: "step-agenda" }),
      item({ tempId: "b", storyType: "bug", serves: "story-agenda" }),
      item({ tempId: "c", targetCardId: "story-agenda", tasks: [{ title: "x" }] }),
      item({ tempId: "d", storyType: "user" }),
      item({ tempId: "e", type: "step", parent: "act-perfil" }),
      item({ tempId: "f", type: "idea", title: "Dor" }),
    ];
    const seen = new Set<string>();
    const walk = (n: ArchitectureNode) => {
      seen.add(n.key);
      n.children.forEach(walk);
    };
    for (const g of buildProposalGroups(items, BOARD, config)) {
      g.nodes.forEach(walk);
      g.extendedBy.forEach((i) => seen.add(i.tempId));
    }
    expect([...seen].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

// A MESMA árvore, centrada num card que já existe — o que o DETALHE do card mostra. Substitui as duas
// linhas "Pai (step): — / Serve: X", que obrigavam o operador a montar a hierarquia de cabeça.
describe("buildCardNeighborhood — onde eu vivo, quem mais vive aqui, o que pende de mim", () => {
  it("de uma ENTREGA: sobe até a ação e mostra os irmãos da mesma story", () => {
    const board = [...BOARD, card({ id: "story-outra-entrega", type: "story", storyType: "bug", title: "Outro bug", serves: "story-agenda" })];
    const roots = buildCardNeighborhood("story-cache", board, config);
    expect(paths(roots)).toEqual([
      // a cadeia inteira acima + as duas entregas irmãs sob a story
      "act-perfil > step-agenda > story-agenda > story-cache",
      "act-perfil > step-agenda > story-agenda > story-outra-entrega",
    ]);
  });

  it("de uma USER STORY: mostra o que pende dela (as entregas) e os irmãos sob o passo", () => {
    const board = [...BOARD, card({ id: "story-irma", type: "story", storyType: "user", title: "Story irmã", parent: "step-agenda" })];
    const roots = buildCardNeighborhood("story-agenda", board, config);
    expect(paths(roots)).toEqual([
      "act-perfil > step-agenda > story-agenda > story-cache",
      "act-perfil > step-agenda > story-irma",
    ]);
  });

  it("card sem lugar nenhum devolve só ele mesmo — nada a inventar", () => {
    const solto = card({ id: "story-solta", type: "story", storyType: "user", title: "Solta" });
    const roots = buildCardNeighborhood("story-solta", [...BOARD, solto], config);
    expect(paths(roots)).toEqual(["story-solta"]);
  });

  it("id inexistente devolve vazio (a UI cai no estado 'ainda sem lugar')", () => {
    expect(buildCardNeighborhood("nao-existe", BOARD, config)).toEqual([]);
  });
});
