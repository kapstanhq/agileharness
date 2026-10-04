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
  it("o rosto do chip vem INTEIRO de paceChipFace: texto, dica e rótulo — nada de nível escrito à parte", () => {
    expect(chip).toMatch(/const face = paceChipFace\(view, failed, Date\.now\(\)\);/);
    // o bloco do <NavChip …/> do cabeçalho: tudo o que ele DIZ é `face.*`
    const ini = chip.indexOf("<NavChip");
    const navChip = chip.slice(ini, chip.indexOf("{open && (", ini));
    expect(navChip.length).toBeGreaterThan(50);
    expect(navChip).toMatch(/value=\{reading \? <span[^>]*>\{face\.value\}<\/span> : face\.value\}/);
    expect(navChip).toMatch(/title=\{face\.title\}/);
    expect(navChip).toMatch(/ariaLabel=\{face\.ariaLabel\}/);
    // nenhum texto de nível montado fora da função pura (era assim que «Normal» aparecia antes de ler)
    expect(navChip).not.toMatch(/paceLabel\(|paceChipValue\(|"Normal"|'Normal'/);
  });
  it("o painel do celular diz no título o MESMO texto do chip pronto (paceChipValue é o value do rosto «ready»)", () => {
    expect(chip).toMatch(/<NavPopoverTitle meta=\{view \? paceChipValue\(view\) : undefined\}>Ritmo do board<\/NavPopoverTitle>/);
    expect(chip).toMatch(/<NavPopoverTitle meta=\{view \? face\.value : undefined\}>Ritmo do board<\/NavPopoverTitle>/);
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
