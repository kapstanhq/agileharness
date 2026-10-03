import { describe, expect, it } from "vitest";
import {
  ALL_NAV_GROUPS,
  ALL_NAV_ITEMS,
  INICIO_ITEM,
  NAV_GROUPS,
  SISTEMA_GROUP,
  THUMB_KINDS,
  groupForView,
  groupRadicalHref,
  isBlockGroup,
  navItemForView,
  splitGroupsAroundCenter,
  viewHref,
  type BoardView,
} from "@/components/nav/nav-groups";

// O contrato do popover de telas do topnav. Todas as asserções aqui existem porque o modo de falha é
// SILENCIOSO: uma ferramenta sem miniatura não quebra nada — ela só aparece como um quadrado genérico
// no meio de nove retratos, e ninguém repara no code review.

describe("nav-groups × miniaturas do popover", () => {
  it("toda ferramenta de todo bloco tem uma miniatura declarada", () => {
    const sem = NAV_GROUPS.flatMap((g) =>
      g.items.filter((i) => !i.thumb).map((i) => `${g.id}/${i.id}`),
    );
    expect(sem).toEqual([]);
  });

  it("nenhuma miniatura fica ÓRFÃ (declarada e usada por ferramenta nenhuma)", () => {
    // A recíproca do teste acima: um `ThumbKind` que ninguém consome é desenho morto — o desenho
    // existe, o Record de `LayoutThumb` obriga a entrada, e nada nunca o renderiza.
    const usadas = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.thumb)));
    expect([...THUMB_KINDS].filter((k) => !usadas.has(k))).toEqual([]);
  });

  it("cada ferramenta tem a SUA miniatura — nenhuma repetida entre telas", () => {
    const usadas = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.thumb));
    expect(usadas.length).toBe(new Set(usadas).size);
  });
});

describe("nav-groups × geometria do centro da barra", () => {
  it("o split ao redor do Jido cobre TODOS os blocos, na ordem, sem repetir", () => {
    const [antes, depois] = splitGroupsAroundCenter();
    expect([...antes, ...depois].map((g) => g.id)).toEqual(NAV_GROUPS.map((g) => g.id));
    // Ímpar sobra para a ESQUERDA (o Jido continua encostado no meio, não pulando de lado).
    expect(antes.length - depois.length).toBeGreaterThanOrEqual(0);
    expect(antes.length - depois.length).toBeLessThanOrEqual(1);
  });

  it("o destino do clique no bloco é a PRIMEIRA ferramenta — a mesma que abre o popover à esquerda", () => {
    for (const g of NAV_GROUPS) {
      expect(groupRadicalHref(g, "acme")).toBe(g.items[0].href("acme"));
    }
  });
});

// O contrato dos DOIS PLANOS (produto × máquina). Cada asserção aqui trava um modo de falha que a
// reorganização acabou de desfazer — e que volta sozinho no primeiro item novo mal-colocado.
describe("nav-groups × os dois planos (blocos × Sistema)", () => {
  it("o Sistema NÃO é bloco do topnav — o centro da barra é só do produto", () => {
    expect(NAV_GROUPS.map((g) => g.id)).not.toContain(SISTEMA_GROUP.id);
    expect(isBlockGroup(SISTEMA_GROUP)).toBe(false);
    for (const g of NAV_GROUPS) expect(isBlockGroup(g)).toBe(true);
  });

  it("nenhuma tela do Sistema declara miniatura — a superfície dele é o menu do ⚙, não o popover", () => {
    expect(SISTEMA_GROUP.items.filter((i) => i.thumb).map((i) => i.id)).toEqual([]);
  });

  it("nenhuma view mora em DOIS grupos — cada tela tem UM dono (a duplicata era Configurações)", () => {
    const ids = ALL_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("toda tela do Sistema é achável por rota e devolve o grupo Sistema (é o que monta a barra de abas)", () => {
    for (const item of SISTEMA_GROUP.items) {
      expect(navItemForView(item.id)).toBe(item);
      expect(groupForView(item.id)?.id).toBe(SISTEMA_GROUP.id);
      expect(ALL_NAV_ITEMS).toContain(item);
    }
  });

  it("o Sistema tem ≥2 telas — com uma só a barra de abas não é montada e ele ficaria sem irmãs à mão", () => {
    expect(SISTEMA_GROUP.items.length).toBeGreaterThanOrEqual(2);
  });
});

// As views TRANSVERSAIS — as que estão no union mas não moram em grupo nenhum. Elas são o mecanismo
// que deixa uma página de DETALHE não acender bloco nenhum, e o modo de falha é silencioso: dar um
// `NavItem` a uma delas não quebra teste nenhum hoje — só passa a emitir uma rota inexistente na
// troca de board, e a página volta a acender o bloco errado.
describe("nav-groups × views transversais (o detalhe não pertence a seção)", () => {
  const TRANSVERSAIS: BoardView[] = ["processes", "card"];

  it("não moram em grupo nenhum — é isso que apaga o realce do bloco no topnav", () => {
    for (const view of TRANSVERSAIS) {
      expect(groupForView(view)).toBeUndefined();
    }
  });

  it("não têm NavItem — com um, a troca de board emitiria /board/<b>/card (404) em vez do Início", () => {
    for (const view of TRANSVERSAIS) {
      expect(navItemForView(view)).toBeUndefined();
      expect(viewHref(view, "acme")).toBe(INICIO_ITEM.href("acme"));
    }
  });
});
