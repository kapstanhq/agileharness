import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_NAV_GROUPS,
  ALL_NAV_ITEMS,
  NAV_GROUPS,
  SISTEMA_GROUP,
  boardHomeHref,
  groupForView,
  groupLabelForView,
  groupRadicalHref,
  navItemForView,
  URL_ONLY_ITEMS,
  viewHref,
  type BoardView,
} from "@/components/nav/nav-groups";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// O contrato do SELETOR DE GRUPO da barra do topo (fase 1). Os modos de falha são SILENCIOSOS: um grupo que
// abre a ferramenta errada, ou uma tela que diz pertencer a dois grupos, não quebra nada — só desorienta.
// (As miniaturas do popover dos blocos e a geometria "dois de cada lado do Jido" saíram com os blocos: a barra
// não tem mais centro. Os testes delas saíram junto — `GroupNav.tsx` e `LayoutThumb.tsx` foram apagados.)

describe("nav-groups × o seletor de grupo (fase 2: um grupo, uma página)", () => {
  it("os quatro grupos do produto, na ordem do fluxo", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(["Negócio", "Produto", "Design", "Software"]);
  });

  it("cada grupo tem UMA página — e por isso não existe barra de abas", () => {
    for (const g of NAV_GROUPS) expect(g.items, `o grupo ${g.label} voltou a ter abas`).toHaveLength(1);
    expect(read("../BoardHeader.tsx")).not.toMatch(/BlockTabs|sectionTabsFor/);
  });

  it("cada grupo abre a SUA página: Negócio→/negocio, Produto→/produto, Design→/design, Software→/kanban", () => {
    const destinos = Object.fromEntries(NAV_GROUPS.map((g) => [g.label, groupRadicalHref(g, "acme")]));
    expect(destinos).toEqual({
      Negócio: "/board/acme/negocio",
      Produto: "/board/acme/produto",
      Design: "/board/acme/design",
      Software: "/board/acme/kanban",
    });
  });

  it("o gatilho diz o grupo da tela; o Sistema diz «Sistema»; o resto diz «Grupos»", () => {
    const rotulo = (v: BoardView) => groupLabelForView(v);
    expect(rotulo("negocio")).toBe("Negócio");
    expect(rotulo("produto")).toBe("Produto");
    expect(rotulo("design")).toBe("Design");
    expect(rotulo("kanban")).toBe("Software");
    expect(rotulo("config")).toBe("Sistema");
    // uma tela sem grupo não finge ser um: o Inbox e a página do card dizem «Grupos»
    for (const v of ["inbox", "card"] as BoardView[]) expect(rotulo(v)).toBe("Grupos");
  });
});

// As telas APAGADAS na fase 2 (decisão do dono): nenhuma volta à navegação por um item esquecido, e a rota
// antiga de cada uma redireciona em vez de dar 404 (links velhos, deep links de agentes, skills de terceiros).
describe("nav-groups × as telas que saíram", () => {
  const APAGADAS = ["mapa", "ideias", "vocabulario", "metricas", "orquestracao", "priorizacao"];
  const RENOMEADAS = ["canvas", "prd", "estilo", "posicionamento"];

  it("nenhum item de navegação aponta para elas", () => {
    const ids = ALL_NAV_ITEMS.map((i) => i.id as string);
    const hrefs = ALL_NAV_ITEMS.map((i) => i.href("acme"));
    for (const v of [...APAGADAS, ...RENOMEADAS]) {
      expect(ids).not.toContain(v);
      expect(hrefs).not.toContain(`/board/acme/${v}`);
    }
  });

  it("a rota de cada uma é só um redirecionamento", () => {
    const destino: Record<string, string> = {
      mapa: "kanban",
      ideias: "kanban",
      metricas: "kanban",
      orquestracao: "kanban",
      priorizacao: "kanban",
      vocabulario: "produto",
      canvas: "negocio",
      prd: "produto",
      estilo: "design",
      posicionamento: "produto",
    };
    for (const [rota, alvo] of Object.entries(destino)) {
      const src = read(`../../app/board/[boardId]/${rota}/page.tsx`);
      expect(src, `/${rota} deveria redirecionar`).toMatch(/permanentRedirect\(/);
      expect(src, `/${rota} deveria ir para /${alvo}`).toContain(`/${alvo}\``);
      // nenhuma tela é montada ali — a rota não carrega mais componente nenhum
      expect(src).not.toMatch(/from "@\/components\//);
    }
  });

  // A tela de criar card saiu com o Mapa (fase 5C): `/card/novo` vive num segmento aninhado, fora do laço acima.
  it("/card/novo é só um redirecionamento para o Kanban", () => {
    const src = read("../../app/board/[boardId]/card/novo/page.tsx");
    expect(src).toMatch(/permanentRedirect\(/);
    expect(src).toContain("/kanban`");
    expect(src).not.toMatch(/from "@\/components\//);
  });
});

describe("nav-groups × os dois planos (grupos × Sistema)", () => {
  it("o Sistema NÃO entra no seletor de grupo — a porta dele é a engrenagem", () => {
    expect(NAV_GROUPS.map((g) => g.id)).not.toContain(SISTEMA_GROUP.id);
    // e a engrenagem lista as telas dele a partir da MESMA fonte (nunca uma lista escrita à mão)
    expect(read("./BoardMenu.tsx")).toMatch(/SISTEMA_GROUP\.items\.map/);
  });

  it("nenhuma view mora em DOIS lugares — cada tela tem UM dono", () => {
    const ids = [...ALL_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)), ...URL_ONLY_ITEMS.map((i) => i.id)];
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("toda tela do Sistema é achável por rota e devolve o grupo Sistema", () => {
    for (const item of SISTEMA_GROUP.items) {
      expect(navItemForView(item.id)).toBe(item);
      expect(groupForView(item.id)?.id).toBe(SISTEMA_GROUP.id);
      expect(ALL_NAV_ITEMS).toContain(item);
    }
  });

  it("as telas só-por-URL não têm grupo, mas trocar de board continua nelas", () => {
    // hoje a lista está VAZIA (a Priorização saiu na fase 5 e a rota dela redireciona): a garantia vale para a próxima
    expect(URL_ONLY_ITEMS.map((i) => i.id as string)).not.toContain("priorizacao");
    for (const item of URL_ONLY_ITEMS) {
      expect(groupForView(item.id)).toBeUndefined();
      expect(viewHref(item.id, "outro")).toBe(item.href("outro"));
    }
  });

  // A Esteira saiu na fase 3 (o trem mora no Kanban; as alavancas, no Inbox): nem grupo, nem só-por-URL — a rota
  // antiga redireciona para o Kanban (next.config.js).
  it("a Esteira não é mais uma tela da navegação", () => {
    expect(ALL_NAV_ITEMS.some((i) => i.href("b").endsWith("/entrega"))).toBe(false);
  });
});

// O Início foi ELIMINADO (fase 1): a casa do board é o Kanban. Todo fallback de navegação cai nele.
describe("nav-groups × a casa do board é o Kanban", () => {
  it("boardHomeHref aponta para o Kanban", () => {
    expect(boardHomeHref("acme")).toBe("/board/acme/kanban");
  });

  it("não sobrou view nem item do Início", () => {
    expect(ALL_NAV_ITEMS.map((i) => i.id as string)).not.toContain("inicio");
    expect(read("./nav-groups.ts")).not.toMatch(/\/inicio\b/);
  });
});

// As views TRANSVERSAIS — as que estão no union mas não moram em grupo nenhum. Elas são o mecanismo que deixa
// uma página de DETALHE não afirmar seção nenhuma, e o modo de falha é silencioso: dar um `NavItem` a uma delas
// passa a emitir uma rota inexistente na troca de board.
describe("nav-groups × views transversais (o detalhe não pertence a seção)", () => {
  const TRANSVERSAIS: BoardView[] = ["processes", "card"];

  it("não moram em grupo nenhum", () => {
    for (const view of TRANSVERSAIS) expect(groupForView(view)).toBeUndefined();
  });

  it("não têm NavItem — com um, a troca de board emitiria /board/<b>/card (404) em vez da casa do board", () => {
    for (const view of TRANSVERSAIS) {
      expect(navItemForView(view)).toBeUndefined();
      expect(viewHref(view, "acme")).toBe(boardHomeHref("acme"));
    }
  });
});
