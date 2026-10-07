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

describe("a pílula de ritmo — não mostra nível antes de ler", () => {
  // Era o chip do cabeçalho (nav/BoardPaceChip); desde a fase 1 o ritmo mora na 2ª barra do Kanban
  // (kanban/KanbanPaceControl). A garantia é a mesma: tudo o que a pílula e o painel DIZEM sobre a leitura sai das
  // funções puras de board-pace-words (testadas lá), nunca de um nível escrito à parte.
  const pill = src("./kanban/KanbanPaceControl.tsx");
  it("o rosto da pílula vem INTEIRO de paceRunningFace — nada de nível escrito à parte", () => {
    expect(pill).toMatch(/const face = paceRunningFace\(view, failed\);/);
    expect(pill).toMatch(/\{face\}<\/b>/);
    // nenhum texto de nível montado fora da função pura (era assim que «Normal» aparecia antes de ler)
    expect(pill).not.toMatch(/function paceFaceLabel|"Rodando"|'Rodando'/);
  });
  it("a leitura que falha é lembrada (o painel diz «indisponível»), e uma leitura boa não é apagada por um erro novo", () => {
    expect(pill).toMatch(/setFailed\(true\)/);
    expect(pill).toMatch(/setFailed\(false\)/);
    expect(pill).toMatch(/failed \? PACE_PANEL_UNAVAILABLE : PACE_PANEL_LOADING/);
    // só a leitura BOA troca a vista; a falha só marca `failed`
    expect(pill).toMatch(/if \(r\?\.ok\) \{\s*setView\(r\.data\);\s*setFailed\(false\);\s*\} else \{\s*setFailed\(true\);/);
  });
  it("enquanto lê, o botão ⏸/▶ fica desligado e não mostra o «anda» (Play)", () => {
    expect(pill).toMatch(/const quickDisabled = !view \|\|/);
    expect(pill).toMatch(/\{paused \|\| disarmed \? <PlayGlyph \/> : <PauseGlyph \/>\}/);
  });
  it("ligar um board desligado pede confirmação — a MESMA frase do `/retomar` do Jido", () => {
    expect(pill).toMatch(/if \(disarmed\) \{\s*const yes = window\.confirm\(PACE_ARM_CONFIRM\);\s*if \(!yes\) return;\s*return apply\(level, \{ arm: true \}\);/);
  });
  it("o chip antigo saiu do cabeçalho — não há dois controles de ritmo", () => {
    expect(src("./nav/BoardPaceChip.tsx")).toBe("");
  });
});

describe("o indicador de cota — o uso e a trava são dois sinais", () => {
  // Era o HealthPill; desde a fase 1 é o ANEL da barra do topo (shell/QuotaRing). A garantia é a mesma.
  const pill = src("./shell/QuotaRing.tsx");
  it("o tom do medidor sai só do USO (meterTone), nunca da trava", () => {
    expect(pill).toMatch(/const tone = meterTone\(pct\);/);
    expect(pill).not.toMatch(/latched/);
  });
  it("o cadeado não mora dentro do medidor: a trava tem selo próprio, com a frase", () => {
    expect(pill).toContain("latchSealWords(");
    expect(pill).toMatch(/\{seal && \(/);
    expect(pill).toContain("title={seal.title}");
    expect(pill).not.toMatch(/Trava de capacidade engatada — nenhum trabalho/);
  });
  it("o HealthPill saiu (virou o anel) — não há dois medidores de cota", () => {
    expect(src("./HealthPill.tsx")).toBe("");
  });
  it("o painel da frota saiu com a página de Métricas (fase 2) — o selo da trava mora só no anel", () => {
    expect(src("./CapacityPanel.tsx")).toBe("");
  });
});
