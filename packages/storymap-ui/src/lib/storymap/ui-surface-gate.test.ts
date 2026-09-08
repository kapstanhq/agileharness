// O gate de QA VISUAL — por que ele deixava passar, e o que agora o segura.
//
// Incidente (2026-07-22): um card `chore` de 12 arquivos, 100% UI (toasts, tarjas, um item de painel),
// atravessou `hasQaPassed` sem NENHUM sweep visual. Três defeitos encadeados:
//
//   D1  `hasUiSurface` (a DECLARAÇÃO) estava em 1 de 311 cards reais — uma skill LLM tinha de lembrar
//       de um campo opcional. Na prática o tier "boolean explícito vence" era letra morta e quem
//       decidia era sempre o fallback `storyType === "user"`, que sub-classifica por construção.
//   D2  quem RODA o QA (`harness-qa`) ramifica por `storyType`, e nunca leu `hasUiSurface` — então mesmo
//       declarar `true` não faria browser nenhum abrir.
//   D3  `qaPassed` é UM bit para DUAS provas (suíte verde × tela inspecionada). Um gate que pergunta
//       `qaPassed === true` não consegue exigir a segunda — e por isso o sweep visual nunca foi, de
//       fato, exigível, apesar do comentário no kernel afirmar que era.
//
// A correção é por EVIDÊNCIA, não por declaração (mesmo princípio de buildEvidence/deployProof): o
// engine MEDE o diff do run e carimba o fato; o QA registra O QUE provou. Estes testes fixam os três.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GATES, hasUiSurface, qaVisualProof } from "./gate-core";
import { coerceCard } from "./repo";
import { pathsTouchUiSurface, uiSurfacePaths } from "./runner/staging";
import { UI_SURFACE_PATTERNS } from "./runner/config";

const card = (data: Record<string, any>) => coerceCard("t", { type: "story", ...data }, "");
const okWith = (data: Record<string, any>) => GATES.hasQaPassed.ok(card(data));
const measured = (touched: boolean, paths?: string[]) => ({
  uiSurfaceEvidence: { touched, at: "2026-07-22T10:00:00.000Z", ...(paths ? { paths } : {}) },
});

describe("classificador de superfície (puro) — por extensão, sem overfitting no consumidor", () => {
  it("reconhece um componente e uma folha de estilo", () => {
    expect(pathsTouchUiSurface(["packages/app/src/components/Toast.tsx"], UI_SURFACE_PATTERNS)).toBe(true);
    expect(pathsTouchUiSurface(["packages/app/src/app/globals.css"], UI_SURFACE_PATTERNS)).toBe(true);
  });

  it("NÃO confunde lógica/config/board-data com tela", () => {
    expect(
      pathsTouchUiSurface(
        ["packages/app/src/lib/pricing.ts", "storymap/boards/b/cards/x.md", "tsconfig.json"],
        UI_SURFACE_PATTERNS,
      ),
    ).toBe(false);
  });

  it("padrão iniciado por '.' casa por SUFIXO; os demais por SUBSTRING de path", () => {
    expect(pathsTouchUiSurface(["src/views/Home.qml"], [".qml"])).toBe(true);
    expect(pathsTouchUiSurface(["src/views/Home.ts"], ["src/views/"])).toBe(true);
    expect(pathsTouchUiSurface(["src/lib/Home.ts"], ["src/views/"])).toBe(false);
  });

  it("lista VAZIA desliga o classificador (nada é superfície) — a spec manda", () => {
    expect(pathsTouchUiSurface(["a/Toast.tsx"], [])).toBe(false);
    expect(uiSurfacePaths(["a/Toast.tsx"], [])).toEqual([]);
  });

  it("devolve QUAIS arquivos decidiram (o operador precisa poder falsificar o veredito)", () => {
    expect(uiSurfacePaths(["a/T.tsx", "b/lib.ts", "c/s.css"], UI_SURFACE_PATTERNS)).toEqual(["a/T.tsx", "c/s.css"]);
  });

  // AgileHarness é ferramenta genérica: o default não pode presumir a árvore DESTE repo. Extensão é
  // fato da linguagem; pasta/nome de app é convenção local e vai na spec, nunca aqui.
  it("o default é SÓ extensão — nenhum caminho ou nome de app cravado", () => {
    for (const p of UI_SURFACE_PATTERNS) {
      expect(p.startsWith(".")).toBe(true);
      expect(p).not.toMatch(/[/\\]/);
    }
  });
});

describe("hasUiSurface — evidência MEDIDA > declaração > fallback por tipo", () => {
  it("D1: a evidência decide mesmo num `chore` (o caso exato que vazou)", () => {
    expect(hasUiSurface(card({ storyType: "chore", ...measured(true) }))).toBe(true);
  });

  it("a evidência vence uma declaração CONTRÁRIA — fato ganha de opinião", () => {
    expect(hasUiSurface(card({ storyType: "user", hasUiSurface: false, ...measured(true) }))).toBe(true);
    expect(hasUiSurface(card({ storyType: "user", hasUiSurface: true, ...measured(false) }))).toBe(false);
  });

  it("sem evidência, a declaração ainda vale (card cujo trabalho ainda não rodou)", () => {
    expect(hasUiSurface(card({ storyType: "chore", hasUiSurface: true }))).toBe(true);
    expect(hasUiSurface(card({ storyType: "user", hasUiSurface: false }))).toBe(false);
  });

  it("sem evidência nem declaração, o fallback legado — byte-idêntico ao de antes", () => {
    expect(hasUiSurface(card({ storyType: "user" }))).toBe(true);
    expect(hasUiSurface(card({ storyType: "chore" }))).toBe(false);
  });

  it("card não-story (activity/step) nunca tem superfície QA-ável", () => {
    expect(hasUiSurface(coerceCard("a", { type: "activity", ...measured(true) }, ""))).toBe(false);
  });
});

describe("qaVisualProof — ausente é DESCONHECIDO, não negativo", () => {
  it("sem qaEvidence → null (não acusa um card antigo de ter pulado a tela)", () => {
    expect(qaVisualProof(card({ qaPassed: true }))).toBeNull();
  });

  it("registra os dois vereditos", () => {
    expect(qaVisualProof(card({ qaEvidence: { visual: true, at: "x" } }))).toBe(true);
    expect(qaVisualProof(card({ qaEvidence: { suite: true, visual: false, at: "x" } }))).toBe(false);
  });
});

describe("hasQaPassed — o vazamento fechado, sem travar card em voo", () => {
  it("REPRO do incidente: chore com UI medida + qaPassed vindo só da suíte → BLOQUEIA", () => {
    expect(okWith({ storyType: "chore", qaPassed: true, ...measured(true, ["src/components/Toast.tsx"]) })).toBe(false);
  });

  it("o mesmo card com a prova visual registrada → PASSA", () => {
    expect(
      okWith({
        storyType: "chore",
        qaPassed: true,
        ...measured(true),
        qaEvidence: { suite: true, visual: true, at: "2026-07-22T10:00:00.000Z" },
      }),
    ).toBe(true);
  });

  it("um QA que declara honestamente que NÃO olhou a tela não passa", () => {
    expect(
      okWith({ storyType: "chore", qaPassed: true, ...measured(true), qaEvidence: { suite: true, visual: false, at: "x" } }),
    ).toBe(false);
  });

  it("superfície medida como AUSENTE → a suíte é a prova completa (não deadlocka infra)", () => {
    expect(okWith({ storyType: "user", qaPassed: true, ...measured(false) })).toBe(true);
  });

  it("ZERO-MIGRAÇÃO: sem medição, o veredito é o de antes — qaPassed basta", () => {
    expect(okWith({ storyType: "user", qaPassed: true })).toBe(true);
    expect(okWith({ storyType: "user" })).toBe(false);
    expect(okWith({ storyType: "chore" })).toBe(true);
  });

  it("evidência malformada não vira isenção (coerce derruba o objeto inteiro)", () => {
    // `touched` não-booleano ⇒ a evidência some ⇒ cai no caminho declarativo, NUNCA em "sem superfície".
    const c = card({ storyType: "user", qaPassed: true, uiSurfaceEvidence: { touched: "sim", at: "x" } });
    expect(c.uiSurfaceEvidence).toBeUndefined();
    expect(hasUiSurface(c)).toBe(true);
  });
});

describe("PRODUTOR — o teste que faltava (uma trava sem produtor não é trava)", () => {
  // D1 nasceu assim: um campo LIDO por um gate e escrito por ninguém em código. O gate parecia existir
  // e nunca disparava. Este teste falha se a evidência voltar a não ter quem a escreva.
  const SRC = join(__dirname, "..", "..");
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) acc.push(p);
    }
    return acc;
  };
  const sources = walk(SRC).map((p) => ({ p, text: readFileSync(p, "utf8") }));

  it("uiSurfaceEvidence tem um produtor em código de produção (o engine)", () => {
    const writers = sources.filter((f) => /uiSurfaceEvidence:\s*\{/.test(f.text));
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.some((f) => f.p.includes("runner/engine.ts"))).toBe(true);
  });

  it("qaEvidence tem um produtor humano (approve_qa) — a saída quando a skill não coopera", () => {
    const writers = sources.filter((f) => /qaEvidence:\s*\{/.test(f.text));
    expect(writers.some((f) => f.p.includes("app/actions.ts"))).toBe(true);
  });

  it("ambos sobrevivem a um write (serializer) — campo sem serializer é descartado no disco", () => {
    const writeTs = readFileSync(join(__dirname, "write.ts"), "utf8");
    expect(writeTs).toMatch(/uiSurfaceEvidence/);
    expect(writeTs).toMatch(/qaEvidence/);
  });

  it("ambos sobrevivem a um Save do drawer (pipeline-owned em card-merge)", () => {
    const merge = readFileSync(join(__dirname, "card-merge.ts"), "utf8");
    expect(merge).toMatch(/"uiSurfaceEvidence"/);
    expect(merge).toMatch(/"qaEvidence"/);
  });
});
