import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import {
  buildOutline,
  expansionForLevel,
  outlineSiblings,
  releaseOptions,
  reorderTarget,
  ROOT_CONTAINER,
  stepsOf,
  storiesOf,
  EMPTY_OUTLINE_QUERY,
  type OutlineQuery,
  type OutlineRow,
} from "./outline";
import type { BoardConfig, Card, StatusDef } from "./types";

// A derivação do OUTLINE do User Story Map. O que estes testes fixam é a PROMESSA da tela:
//   • a árvore só cresce onde se olha (nada de filho de nó fechado na lista);
//   • entrega (dual-track) é FILHA do nó que serve — sob a story E sob o passo;
//   • sob busca/filtro, ramo sem resultado SOME e o que sobrou vem aberto;
//   • story sem lugar NUNCA desaparece (o grupo terminal);
//   • a ordem narrativa continua editável sem arrasto (reorderTarget).

const status = (id: string, extra: Partial<StatusDef> = {}): StatusDef => ({ id, name: id, ...extra });

const config: BoardConfig = {
  id: "b",
  name: "Board",
  statuses: [
    status("triage", { staging: true }),
    status("desenvolver"),
    status("concluida", { terminal: true, delivered: true }),
    status("cancelado", { terminal: true }),
  ],
  releases: [
    { id: "base", name: "Base", order: 1 },
    { id: "depois", name: "Depois", order: 2 },
  ],
  personas: [],
  systems: [],
  linkTypes: [],
};

const card = (id: string, data: Record<string, unknown>): Card => coerceCard(id, data, "");

/** Um board mínimo mas COMPLETO: 2 ações, 3 passos, stories, entregas nos dois nós, 1 órfã. */
function fixture(): Card[] {
  return [
    card("act-agendar", { type: "activity", title: "Agendar consultas", order: 10 }),
    card("act-ex9301", { type: "activity", title: "Cuidar do paciente", order: 20 }),

    card("step-ex9302", { type: "step", title: "Escolher horário na agenda", parent: "act-agendar", order: 10 }),
    card("step-vet", { type: "step", title: "Escolher o veterinário", parent: "act-agendar", order: 20 }),
    card("step-lembrete", { type: "step", title: "Receber lembrete de vacina", parent: "act-ex9301", order: 10 }),

    card("story-ex9201-livres", {
      type: "story", storyType: "user", title: "Ver horários livres da semana",
      parent: "step-ex9302", release: "base", status: "concluida", order: 10,
    }),
    card("story-ex9201-cheia", {
      type: "story", storyType: "user", title: "Ver sugestão quando a agenda está cheia",
      parent: "step-ex9302", release: "base", status: "desenvolver", order: 20,
    }),
    card("story-ex9201-retorno", {
      type: "story", storyType: "user", title: "Priorizar retorno pelo histórico do tutor",
      parent: "step-ex9302", release: "depois", status: null, order: 30,
    }),
    card("story-vet-especialidade", {
      type: "story", storyType: "user", title: "Filtrar por especialidade",
      parent: "step-vet", release: "base", status: "desenvolver", order: 10,
    }),
    card("story-lembrete-ver", {
      type: "story", storyType: "user", title: "Rever lembretes enviados",
      parent: "step-lembrete", release: null, status: null, order: 10,
    }),

    // entrega pendurada numa STORY (serves explícito)
    card("tech-agenda-cache", {
      type: "story", storyType: "technical", title: "Agenda em cache",
      parent: "step-ex9302", serves: "story-ex9201-livres", status: "concluida", order: 10,
    }),
    // entrega pendurada num PASSO (sem serves → cai no parent) — era invisível na grade
    card("bug-agenda-fuso", {
      type: "story", storyType: "bug", title: "Horário aparece no fuso errado",
      parent: "step-ex9302", status: "desenvolver", order: 20,
    }),

    // story sem lugar nenhum
    card("story-orfa", {
      type: "story", storyType: "user", title: "Ideia sem casa", parent: null, unplaced: true, order: 10,
    }),
  ];
}

const q = (over: Partial<OutlineQuery> = {}): OutlineQuery => ({ ...EMPTY_OUTLINE_QUERY, ...over });
const keys = (rows: OutlineRow[]) => rows.map((r) => `${r.kind}:${r.card?.id ?? r.key}`);
const find = (rows: OutlineRow[], id: string) => rows.find((r) => r.card?.id === id);

describe("buildOutline — progressive disclosure (a árvore só cresce onde se olha)", () => {
  it("fechado, mostra APENAS as ações (e o grupo das órfãs)", () => {
    const { rows } = buildOutline(fixture(), config, q());
    expect(keys(rows)).toEqual(["activity:act-agendar", "activity:act-ex9301", "orphans:orphans"]);
  });

  it("abrir uma ação revela os passos dela — e só dela", () => {
    const { rows } = buildOutline(fixture(), config, q({ open: { "a:act-agendar": true } }));
    expect(keys(rows)).toEqual([
      "activity:act-agendar",
      "step:step-ex9302",
      "step:step-vet",
      "activity:act-ex9301",
      "orphans:orphans",
    ]);
  });

  it("abrir o passo revela stories, a entrega DO PASSO e o convite de criação", () => {
    const { rows } = buildOutline(
      fixture(),
      config,
      q({ open: { "a:act-agendar": true, "a:act-agendar/s:step-ex9302": true } }),
    );
    expect(keys(rows)).toEqual([
      "activity:act-agendar",
      "step:step-ex9302",
      "story:story-ex9201-livres",
      "story:story-ex9201-cheia",
      "story:story-ex9201-retorno",
      // a entrega que serve o PASSO fica no mesmo nível das stories (dual-track)
      "delivery:bug-agenda-fuso",
      "add:a:act-agendar/s:step-ex9302/+",
      "step:step-vet",
      "activity:act-ex9301",
      "orphans:orphans",
    ]);
  });

  it("a entrega de uma STORY só aparece quando a story abre", () => {
    const open = {
      "a:act-agendar": true,
      "a:act-agendar/s:step-ex9302": true,
    };
    const closed = buildOutline(fixture(), config, q({ open }));
    expect(find(closed.rows, "tech-agenda-cache")).toBeUndefined();
    expect(find(closed.rows, "story-ex9201-livres")?.expandable).toBe(true);
    expect(find(closed.rows, "story-ex9201-livres")?.childCount).toBe(1);

    const storyKey = "a:act-agendar/s:step-ex9302/y:story-ex9201-livres";
    const opened = buildOutline(fixture(), config, q({ open: { ...open, [storyKey]: true } }));
    const delivery = find(opened.rows, "tech-agenda-cache");
    expect(delivery?.kind).toBe("delivery");
    expect(delivery?.depth).toBe(3);
    expect(delivery?.eyebrow).toBe("Técnica");
  });
});

describe("buildOutline — o resumo e o medidor de cada ramo", () => {
  it("a ação resume passos × stories e mede o progresso do ramo inteiro", () => {
    const { rows } = buildOutline(fixture(), config, q());
    const act = find(rows, "act-agendar")!;
    expect(act.summary).toBe("2 passos · 4 stories");
    expect(act.eyebrow).toBe("ação 1 de 2");
    // 4 stories de backbone: 1 entregue, 2 andando, 1 aberta
    expect(act.progress).toEqual({ done: 1, doing: 2, open: 1, archived: 0, total: 4 });
  });

  it("passo sem story diz 'sem stories' em vez de mentir um número", () => {
    const cards = [
      card("act", { type: "activity", title: "A", order: 10 }),
      card("step", { type: "step", title: "S", parent: "act", order: 10 }),
    ];
    const { rows } = buildOutline(cards, config, q({ open: { "a:act": true } }));
    expect(find(rows, "step")?.summary).toBe("sem stories");
    expect(find(rows, "step")?.expandable).toBe(false);
  });

  it("sob filtro, resumo e medidor falam da MESMA população", () => {
    // "Agendar consultas" tem 4 stories (1 entregue); filtrando por `depois` sobra 1, em aberto.
    // Se o medidor continuasse medindo as 4, a linha diria "1 story" ao lado de uma barra verde.
    const { rows } = buildOutline(fixture(), config, q({ release: "depois" }));
    const act = find(rows, "act-agendar")!;
    expect(act.summary).toBe("2 passos · 1 story");
    expect(act.progress).toEqual({ done: 0, doing: 0, open: 1, archived: 0, total: 1 });
  });

  it("cancelado conta como ARQUIVADO — nem entregue nem pendente", () => {
    const cards = [
      card("act", { type: "activity", title: "A", order: 10 }),
      card("step", { type: "step", title: "S", parent: "act", order: 10 }),
      card("s1", { type: "story", storyType: "user", title: "x", parent: "step", status: "cancelado", order: 10 }),
    ];
    const { rows } = buildOutline(cards, config, q());
    expect(find(rows, "act")?.progress).toEqual({ done: 0, doing: 0, open: 0, archived: 1, total: 0 });
  });
});

describe("buildOutline — totais do board (o cabeçalho não mente sob filtro)", () => {
  it("conta o board INTEIRO, e `matched` conta só o que passa pelo filtro", () => {
    const all = buildOutline(fixture(), config, q());
    expect(all.totals).toEqual({ activities: 2, steps: 3, stories: 6, delivery: 2, done: 1, matched: 6 });

    const filtered = buildOutline(fixture(), config, q({ release: "base" }));
    expect(filtered.totals.stories).toBe(6);
    expect(filtered.totals.matched).toBe(3);
  });
});

describe("buildOutline — busca e filtros", () => {
  it("a busca abre tudo sozinha e poda os ramos sem resultado", () => {
    const { rows, filtering } = buildOutline(fixture(), config, q({ search: "retorno" }));
    expect(filtering).toBe(true);
    expect(keys(rows)).toEqual([
      "activity:act-agendar",
      "step:step-ex9302",
      "story:story-ex9201-retorno",
    ]);
  });

  it("acha sem acento e por id", () => {
    expect(keys(buildOutline(fixture(), config, q({ search: "sugestao" })).rows)).toContain(
      "story:story-ex9201-cheia",
    );
    expect(keys(buildOutline(fixture(), config, q({ search: "story-lembrete-ver" })).rows)).toContain(
      "story:story-lembrete-ver",
    );
  });

  it("sob busca não oferece o convite de criação (o '+' é gesto do mapa inteiro)", () => {
    const { rows } = buildOutline(fixture(), config, q({ search: "agenda" }));
    expect(rows.some((r) => r.kind === "add")).toBe(false);
  });

  it("filtrar por release esconde o passo que ficou sem nenhuma story", () => {
    const { rows } = buildOutline(fixture(), config, q({ release: "depois" }));
    expect(keys(rows)).toEqual([
      "activity:act-agendar",
      "step:step-ex9302",
      "story:story-ex9201-retorno",
    ]);
  });

  it("filtrar por status atravessa todos os níveis", () => {
    const { rows } = buildOutline(
      fixture(),
      config,
      q({ filters: { status: "concluida", persona: "", system: "" } }),
    );
    expect(keys(rows)).toEqual([
      "activity:act-agendar",
      "step:step-ex9302",
      "story:story-ex9201-livres",
      // a entrega DA STORY passa no mesmo filtro e vem junto; a do PASSO (em desenvolver) some
      "delivery:tech-agenda-cache",
    ]);
  });
});

describe("buildOutline — agrupamento por release", () => {
  it("troca a raiz: release → passo (com a ação como contexto) → story", () => {
    const { rows } = buildOutline(fixture(), config, q({ grouping: "release", open: { "r:base": true } }));
    const base = rows.find((r) => r.kind === "release" && r.title === "Base")!;
    expect(base.summary).toBe("3 stories · 2 passos");
    const step = rows.find((r) => r.kind === "step" && r.card?.id === "step-ex9302")!;
    // a ação deixou de ser a raiz: ela vira CONTEXTO do passo (prosa), não uma coordenada
    expect(step.eyebrow).toBe("Agendar consultas");
    expect(step.eyebrowKind).toBe("context");
  });

  it("release vazia não vira linha (a fatia não existe no board)", () => {
    const rows = buildOutline(fixture(), config, q({ grouping: "release" })).rows;
    expect(rows.filter((r) => r.kind === "release").map((r) => r.title)).toEqual([
      "Base",
      "Depois",
      "Sem release",
    ]);
  });
});

describe("buildOutline — story sem lugar", () => {
  it("nunca some: vira grupo no fim, com contagem", () => {
    const { rows, orphanCount } = buildOutline(fixture(), config, q({ open: { orphans: true } }));
    expect(orphanCount).toBe(1);
    const group = rows.find((r) => r.kind === "orphans")!;
    expect(group.summary).toBe("1 story");
    expect(find(rows, "story-orfa")?.depth).toBe(1);
  });

  it("conta só o que AINDA deve um lugar — órfã encerrada é história, não dívida", () => {
    const cards = [
      ...fixture(),
      card("story-orfa-feita", {
        type: "story", storyType: "user", title: "Órfã já entregue",
        parent: null, unplaced: true, status: "concluida", order: 20,
      }),
      card("story-orfa-cancelada", {
        type: "story", storyType: "user", title: "Órfã cancelada",
        parent: null, unplaced: true, status: "cancelado", order: 30,
      }),
    ];
    const { orphanCount, rows } = buildOutline(cards, config, q({ open: { orphans: true } }));
    expect(orphanCount).toBe(1);
    expect(find(rows, "story-orfa-feita")).toBeUndefined();
    expect(find(rows, "story-orfa-cancelada")).toBeUndefined();
  });

  it("some quando o filtro corrente não a alcança — e o grupo some junto", () => {
    const { rows, orphanCount } = buildOutline(fixture(), config, q({ release: "base" }));
    expect(orphanCount).toBe(0);
    expect(rows.some((r) => r.kind === "orphans")).toBe(false);
  });
});

describe("releaseOptions — o seletor de release", () => {
  it("ordena pela ordem declarada, com 'Sem release' no fim e a contagem real", () => {
    expect(releaseOptions(config, fixture())).toEqual([
      { id: "base", name: "Base", count: 3 },
      { id: "depois", name: "Depois", count: 1 },
      { id: "none", name: "Sem release", count: 2 },
    ]);
  });
});

describe("expansionForLevel — o controle 'Abrir até'", () => {
  it("nível 1 fecha tudo; 2 abre as ações; 3 abre também os passos", () => {
    const cards = fixture();
    expect(expansionForLevel(cards, config, "fluxo", 1)).toEqual({});
    expect(expansionForLevel(cards, config, "fluxo", 2)).toEqual({
      "a:act-agendar": true,
      "a:act-ex9301": true,
      orphans: false,
    });
    const l3 = expansionForLevel(cards, config, "fluxo", 3);
    expect(l3["a:act-agendar/s:step-ex9302"]).toBe(true);
    expect(l3.orphans).toBe(true);
  });

  it("as chaves batem EXATAMENTE com as que buildOutline produz", () => {
    const cards = fixture();
    const open = expansionForLevel(cards, config, "fluxo", 3);
    const { rows } = buildOutline(cards, config, q({ open }));
    // com tudo aberto até stories, as 5 stories de backbone aparecem
    expect(rows.filter((r) => r.kind === "story").length).toBe(6);
  });
});

describe("reorderTarget — a ordem narrativa sem arrasto", () => {
  it("sobe/desce um passo dentro da ação", () => {
    const cards = fixture();
    const container = stepsOf("act-agendar");
    expect(outlineSiblings(cards, container).map((c) => c.id)).toEqual(["step-ex9302", "step-vet"]);
    // step-vet (order 20) subindo cai ANTES de step-ex9302 (order 10)
    expect(reorderTarget(cards, container, "step-vet", -1)).toBe(0);
    // step-ex9302 descendo cai depois de step-vet
    expect(reorderTarget(cards, container, "step-ex9302", 1)).toBe(30);
  });

  it("devolve null nas pontas (o botão fica desabilitado, nada é gravado)", () => {
    const cards = fixture();
    expect(reorderTarget(cards, ROOT_CONTAINER, "act-agendar", -1)).toBeNull();
    expect(reorderTarget(cards, ROOT_CONTAINER, "act-ex9301", 1)).toBeNull();
  });

  it("os irmãos de uma story são as stories DO PASSO, na ordem — nunca as entregas", () => {
    const cards = fixture();
    expect(outlineSiblings(cards, storiesOf("step-ex9302")).map((c) => c.id)).toEqual([
      "story-ex9201-livres",
      "story-ex9201-cheia",
      "story-ex9201-retorno",
    ]);
  });

  it("cada linha declara o container correto", () => {
    const { rows } = buildOutline(
      fixture(),
      config,
      q({ open: { "a:act-agendar": true, "a:act-agendar/s:step-ex9302": true } }),
    );
    expect(find(rows, "act-agendar")?.container).toBe(ROOT_CONTAINER);
    expect(find(rows, "step-ex9302")?.container).toBe(stepsOf("act-agendar"));
    expect(find(rows, "story-ex9201-cheia")?.container).toBe(storiesOf("step-ex9302"));
    // entrega não é ordem narrativa
    expect(find(rows, "bug-agenda-fuso")?.container).toBeNull();
  });
});
