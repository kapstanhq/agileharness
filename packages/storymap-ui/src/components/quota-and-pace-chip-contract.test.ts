import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// O rig de teste é node sem DOM (ver card-live-status-surfaces.test.ts): a decisão de texto/estado é testada nas funções
// puras (lib/storymap/board-pace-words.test.ts) e aqui se afirma, contra o fonte, que os componentes OBEDECEM a elas —
// sem isto, voltar a escrever «Normal» como padrão no chip ou pintar o uso pela trava passaria em todos os testes puros.
const src = (rel: string) => {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

describe("o chip de ritmo — não mostra nível antes de ler", () => {
  const chip = src("./nav/BoardPaceChip.tsx");
  it("o rosto do chip vem de paceChipFace, e o nível padrão «normal» não vira texto", () => {
    expect(chip).toContain("paceChipFace(");
    expect(chip).not.toMatch(/view \? paceChipValue\(view\) : paceLabel\(level\)/);
  });
  it("a leitura que falha é lembrada (o painel diz «indisponível»)", () => {
    expect(chip).toMatch(/setFailed\(true\)/);
    expect(chip).toMatch(/setFailed\(false\)/);
    expect(chip).toContain("PACE_PANEL_UNAVAILABLE");
    expect(chip).toContain("PACE_PANEL_LOADING");
  });
  it("enquanto lê, o ícone não é o de «anda» (Play)", () => {
    expect(chip).toMatch(/reading \? <CircleDashed/);
  });
});

describe("o indicador de cota — o uso e a trava são dois sinais", () => {
  const pill = src("./HealthPill.tsx");
  it("o tom do medidor sai só do USO (meterTone), nunca da trava", () => {
    expect(pill).toMatch(/tone=\{meterTone\(pct\)\}/);
    expect(pill).not.toMatch(/latched/);
  });
  it("o cadeado não mora mais dentro do medidor: a trava tem selo próprio, com a frase", () => {
    expect(pill).toContain("latchSealWords(");
    expect(pill).toMatch(/\{seal && \(/);
    expect(pill).toContain("title={seal.title}");
    expect(pill).not.toMatch(/Trava de capacidade engatada — nenhum trabalho/);
  });
  it("o painel da frota repete a frase do selo", () => {
    expect(src("./CapacityPanel.tsx")).toContain("latchSealWords(");
  });
});
