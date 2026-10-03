import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimNavPopover,
  hasOpenNavPopover,
  releaseNavPopover,
} from "@/components/nav/popover-arbiter";

/**
 * O árbitro existe por um bug concreto: o painel de um BLOCO (Design) e o balão do JIDO abriam ao
 * mesmo tempo, sobrepostos. Cada painel sabia fechar a si mesmo ao perder o ponteiro, mas o fecha
 * dos blocos mora no CONTÊINER que TEM o Jido dentro — ir do bloco para o mascote nunca "saía" do
 * contêiner. Os testes abaixo travam a invariante que substituiu aquela coordenação por vizinhança.
 */
describe("popover-arbiter — um painel por vez na barra", () => {
  /** O registry é estado de MÓDULO: cada teste começa com a barra fechada. */
  beforeEach(() => {
    const drain = () => {};
    claimNavPopover(drain);
    releaseNavPopover(drain);
  });

  it("começa sem nenhum painel aberto", () => {
    expect(hasOpenNavPopover()).toBe(false);
  });

  it("abrir um segundo painel FECHA o primeiro — o bug do bloco + Jido", () => {
    const closeBloco = vi.fn();
    const closeJido = vi.fn();

    claimNavPopover(closeBloco); // hover no bloco "Design"
    expect(closeBloco).not.toHaveBeenCalled();

    claimNavPopover(closeJido); // ponteiro atravessa para o mascote
    expect(closeBloco).toHaveBeenCalledTimes(1);
    expect(closeJido).not.toHaveBeenCalled();
  });

  it("vale nos DOIS sentidos — o balão aberto cede a vez ao bloco", () => {
    const closeJido = vi.fn();
    const closeBloco = vi.fn();

    claimNavPopover(closeJido);
    claimNavPopover(closeBloco);

    expect(closeJido).toHaveBeenCalledTimes(1);
    expect(closeBloco).not.toHaveBeenCalled();
  });

  it("re-tomar a vez sendo o dono é NO-OP — atravessar de um bloco a outro só troca o conteúdo", () => {
    // Os blocos partilham UM estado (BlockNav), logo UMA identidade de `close`: trocar de bloco não
    // pode fazer o painel fechar a si mesmo no caminho (piscada) — só muda qual bloco está aberto.
    const closeBlocos = vi.fn();

    claimNavPopover(closeBlocos);
    claimNavPopover(closeBlocos);
    claimNavPopover(closeBlocos);

    expect(closeBlocos).not.toHaveBeenCalled();
    expect(hasOpenNavPopover()).toBe(true);
  });

  it("quem já foi SUBSTITUÍDO não apaga o registro do sucessor ao sair de cena", () => {
    // Esta é a ordem real do React: o novo painel reivindica, o antigo só então processa o próprio
    // fechamento e chama release. Sem a checagem de identidade, esse release atrasado zeraria o
    // registry e o PRÓXIMO painel a abrir não teria a quem fechar — o bug de volta.
    const closeAntigo = vi.fn();
    const closeNovo = vi.fn();
    const closeTerceiro = vi.fn();

    claimNavPopover(closeAntigo);
    claimNavPopover(closeNovo); // sucessor assume
    releaseNavPopover(closeAntigo); // limpeza atrasada do antigo — não pode limpar nada

    expect(hasOpenNavPopover()).toBe(true);

    claimNavPopover(closeTerceiro);
    expect(closeNovo).toHaveBeenCalledTimes(1);
  });

  it("o dono atual devolve a vez ao fechar", () => {
    const close = vi.fn();

    claimNavPopover(close);
    releaseNavPopover(close);

    expect(hasOpenNavPopover()).toBe(false);
    // E o fechamento é do CHAMADOR: devolver a vez nunca invoca o próprio `close`.
    expect(close).not.toHaveBeenCalled();
  });

  it("fechado, abrir o painel seguinte não chama ninguém", () => {
    const closeA = vi.fn();
    const closeB = vi.fn();

    claimNavPopover(closeA);
    releaseNavPopover(closeA);
    claimNavPopover(closeB);

    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
  });
});
