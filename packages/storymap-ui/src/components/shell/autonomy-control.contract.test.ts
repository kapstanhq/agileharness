import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTONOMY_BOXES, PRESET_LABEL, alwaysOwnerPoints } from "@/lib/storymap/autonomy-profile";
import { autonomyPillWords } from "./autonomy-pill-words";

// O CONTRATO do controle único de autonomia (fase 4), contra o fonte (o rig é node sem DOM — ver
// app-bar.contract.test.ts). Fixa: UM painel e DUAS portas (a pílula da barra, à esquerda do anel da cota, e a seção no
// topo da engrenagem); os dois modos prontos; as caixas com o efeito e o motivo da trava; a lista do que é sempre do
// dono; a escrita única com recibo e «Desfazer». E prova a AUSÊNCIA das portas antigas — o seletor Chat / Copiloto /
// Autônomo, o editor da matriz de risco, o selo ultra/humano —, para nenhuma voltar por acréscimo.

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const src = (rel: string) => readFileSync(here(rel), "utf8");
const control = src("./AutonomyControl.tsx");
const gear = src("./SettingsMenu.tsx");
const header = src("../BoardHeader.tsx");

/** O código sem os comentários — o histórico das portas antigas pode ser CONTADO no comentário, não montado. */
const code = (text: string) => text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Todo .tsx/.ts (sem testes) sob components/ — onde uma porta de autonomia poderia reaparecer. */
function componentSources(): Array<{ file: string; text: string }> {
  const root = here("..");
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: p.slice(root.length + 1), text: code(readFileSync(p, "utf8")) });
    }
  };
  walk(root);
  return out;
}

describe("um painel, duas portas", () => {
  it("a pílula fica na barra do topo, logo à ESQUERDA do anel da cota", () => {
    expect(header).toMatch(/<AutonomyPill config=\{config\} \/>\s*<QuotaRing /);
  });
  it("a engrenagem abre com a seção de autonomia no TOPO, antes da linha da RAM e da lista do board", () => {
    const section = gear.indexOf("<AutonomyMenuSection config={config}");
    expect(section).toBeGreaterThan(-1);
    expect(section).toBeLessThan(gear.indexOf("{ram != null && ("));
    expect(section).toBeLessThan(gear.indexOf("<BoardMenu"));
    expect(header).toMatch(/<SettingsMenu config=\{config\} /);
  });
  it("as duas portas leem e escrevem pelo MESMO estado, e «Ajustar caixa a caixa» abre o painel da pílula", () => {
    expect(control.match(/useBoardAutonomy\(config\)/g)?.length).toBe(2);
    expect(control).toMatch(/<AutonomyPanel state=\{state\} onClose=\{close\} \/>/);
    expect(control).toMatch(/onOpenPanel\(\);\s*openAutonomyPanel\(\);/);
    expect(control).toMatch(/window\.addEventListener\(OPEN_EVENT, onOpen\)/);
    // uma porta muda, a outra relê
    expect(control).toMatch(/window\.dispatchEvent\(new CustomEvent\(CHANGED_EVENT, \{ detail: boardId \}\)\)/);
  });
  it("só UMA escrita: o escritor único do perfil (operador-apenas no servidor)", () => {
    expect(control).toMatch(/import \{ getBoardAutonomyAction, setBoardAutonomyAction, type AutonomyUndo \} from "@\/app\/board-autonomy-actions";/);
    expect(control).toMatch(/await setBoardAutonomyAction\(\{ boardId, \.\.\.input \}\)/);
  });
});

describe("o painel", () => {
  it("os dois modos prontos, com a frase de cada um; «Personalizada» quando as caixas não batem", () => {
    expect(control).toMatch(/id: "minima", hint: "Você aprova cada passo; os agentes trabalham e param para perguntar\."/);
    expect(control).toMatch(/id: "maxima", hint: "Os agentes decidem o técnico, aprovam, publicam e fazem deploy; você só decide o que é seu\."/);
    expect(control).toMatch(/state\.preset === "personalizada" &&/);
    expect(control).toMatch(/role=\{compact \? "menuitemradio" : "radio"\}/);
  });
  it("uma caixa por decisão, com o efeito em uma linha e, travada, o motivo (deploy exige publicar; publicar exige a entrega)", () => {
    expect(control).toMatch(/\{AUTONOMY_BOXES\.map\(\(b\) => \(\s*<Box key=\{b\.key\} state=\{state\} k=\{b\.key\} \/>/);
    expect(control).toMatch(/const blocked = meta\.soon \? "em breve" : on \? null : dependencyBlock\(state\.view\.profile, k\);/);
    expect(control).toMatch(/disabled=\{state\.busy \|\| blocked !== null\}/);
    expect(control).toMatch(/\{meta\.soon \? "Em breve\." : blocked \? `Travada: \$\{blocked\}\.` : meta\.effect\}/);
    // as caixas do pedido estão todas lá (a régua e os textos moram no módulo do perfil)
    const keys = AUTONOMY_BOXES.map((b) => b.key);
    for (const k of ["spec", "design", "delivery", "publish", "deploy", "spendRaise", "copilot", "sentinel"]) expect(keys).toContain(k);
  });
  it("«Sempre seus, em qualquer modo»: lista TRAVADA (sem caixa), com a frase de que não se desliga", () => {
    const owner = control.slice(control.indexOf('id="ah-autonomy-owner"'));
    expect(owner).toMatch(/Sempre seus, em qualquer modo/);
    expect(owner).toMatch(/\{ALWAYS_OWNER_NOTE\}/);
    expect(owner).toMatch(/state\.view\.alwaysOwner\.map/);
    expect(owner).not.toMatch(/type="checkbox"/);
    // a trava do servidor («Aprovar e rodar») e o dinheiro estão na lista de qualquer board
    const points = alwaysOwnerPoints({ autonomy: undefined });
    expect(points.some((p) => p.id === "money")).toBe(true);
    expect(points.some((p) => /Aprovar e rodar/.test(p.detail))).toBe(true);
  });
  it("salva na hora, com o recibo e «Desfazer» num rodapé grudado (visível no celular depois de rolar)", () => {
    // O COMPORTAMENTO do desfazer (devolve a foto exata, nunca propaga dependência) é fixado contra o escritor real em
    // app/board-autonomy-actions.test.ts — aqui só a superfície: o recibo anunciado, o botão e o rodapé grudado.
    expect(control).toMatch(/role="status"/);
    expect(control).toMatch(/>\s*Desfazer\s*</);
    expect(control).toMatch(/<SaveFeedback state=\{state\} sticky \/>\s*<\/div>/);
    expect(control).toMatch(/sticky bottom-0/);
    // o desfazer manda a FOTO do servidor, nunca o perfil de antes como mudança de caixas
    expect(code(control)).not.toMatch(/change\(\{ patch: prev/);
    expect(control).toMatch(/void change\(\{ restore: to \}, true\)/);
  });
  it("um board legado incoerente MOSTRA o conflito (não o corrige em silêncio); a caixa «em breve» fica travada", () => {
    expect(control).toMatch(/state\.view\.conflicts\.length > 0 &&/);
  });
});

describe("celular e acessibilidade", () => {
  it("no celular a pílula é as barras do NÍVEL + a palavra curta (nunca uma letra solta); o rótulo inteiro do md para cima e no aria-label", () => {
    expect(control).toMatch(/<LevelIcon preset=\{state\.preset\}[^>]*\/>[\s\S]{0,260}\{words\.short\}[\s\S]{0,40}<span className="hidden whitespace-nowrap text-\[12px\] md:inline">/);
    expect(control).toMatch(/aria-label=\{words\.ariaLabel\}/);
    expect(control).toMatch(/title=\{words\.title\}/);
    expect(control).not.toMatch(/LEVEL_LETTER/);
    // abaixo de 360px a palavra cede a largura ao nome do board: ficam só as barras
    expect(control).toMatch(/<span aria-hidden className="[^"]*max-\[359px\]:hidden md:hidden">\s*\{words\.short\}/);
  });
  it("as palavras da pílula: curta legível no celular, o nível INTEIRO no rótulo acessível", () => {
    expect(autonomyPillWords("maxima").short).toBe("Máx");
    expect(autonomyPillWords("minima").short).toBe("Mín");
    expect(autonomyPillWords("personalizada").short).toBe("Pers.");
    for (const p of ["maxima", "minima", "personalizada"] as const) {
      const w = autonomyPillWords(p);
      // nenhuma letra solta: a palavra curta tem ao menos 3 letras
      expect(w.short.replace(/\P{L}/gu, "").length).toBeGreaterThanOrEqual(3);
      expect(w.ariaLabel).toBe(`Autonomia: ${PRESET_LABEL[p]} — abrir o painel de autonomia`);
      expect(w.title).toContain(`Autonomia: ${PRESET_LABEL[p]}`);
    }
  });
  it("com uma caixa fora do modo pronto, o nível é «Personalizada» nas três portas, e a diferença vai junto", () => {
    expect(control).toMatch(/preset: shownPresetOf\(view\.profile\), gap: presetGapWords\(view\.profile\)/);
    expect(control).toMatch(/autonomyPillWords\(state\.preset, state\.gap\)/);
    const w = autonomyPillWords("personalizada", "Máxima, sem a Sentinela");
    expect(w.short).toBe("Pers.");
    expect(w.ariaLabel).toBe("Autonomia: Personalizada (Máxima, sem a Sentinela) — abrir o painel de autonomia");
    expect(code(control)).not.toMatch(/presetOf\(view\.profile, view\.explicit\)/);
  });
  it("o painel é uma folha de baixo no celular e 360px no computador, preso à borda direita da barra; fecha com Esc, clique fora e o X", () => {
    expect(control).toMatch(/"fixed inset-x-0 bottom-0 max-h-\[85dvh\]/);
    expect(control).toMatch(/md:w-\[360px\]/);
    expect(control).toMatch(/md:right-4 md:top-\[58px\]/);
    expect(control).not.toMatch(/md:absolute/);
    expect(control).toMatch(/useHoverPopover\(\)/); // Esc + clique fora + um popover da barra por vez
    expect(control).toMatch(/title="Fechar \(Esc\)"/);
    expect(control).toMatch(/motion-safe:animate-spin/);
  });
});

describe("as portas antigas saíram (e não voltam)", () => {
  const files = componentSources();
  it("nenhum componente escreve autonomia por outro caminho", () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/setBoardOrchestratorModeAction|setBoardRiskMatrixAction|setCardAutonomyAction/);
      expect(text, file).not.toMatch(/\bRiskMatrixEditor\b|\bTIER_META\b|\btierUnlocked\b/);
    }
  });
  it("o painel antigo do Jido sumiu; a aba Jido da configuração é só o runtime (acordar e gastar)", () => {
    expect(existsSync(here("../CopilotConfigPanel.tsx"))).toBe(false);
    const runtime = code(src("../JidoRuntimePanel.tsx"));
    expect(runtime).not.toMatch(/Chat \/ Copiloto \/ Autônomo|Matriz de risco|riskMatrix/);
  });
  it("o compositor do Jido não tem mais seletor de modo; o card não tem selo ultra/humano", () => {
    const controls = code(src("../copilot/CopilotChatControls.tsx"));
    expect(controls).not.toMatch(/role="menuitemradio"|pickTier|tierMatrix/);
    for (const { file, text } of files) expect(text, file).not.toMatch(/autonomyMode/);
  });
});
