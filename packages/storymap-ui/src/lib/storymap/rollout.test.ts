// A regra de expansão: o só-negócio fica no board-piloto até ele ter N histórias no
// ar sem NENHUM toque técnico do dono (a medida do item 8). N = `autonomy.rolloutCleanStories` (10 no `_base`). É só
// leitura: diz "pronto: sim/não, N/10" — ligar outro board continua sendo decisão do operador.

import { describe, expect, it } from "vitest";
import { coerceAutonomy, coerceCard, readBaseTemplateConfig } from "./repo";
import { ROLLOUT_CLEAN_STORIES_DEFAULT, rolloutReadiness, type RolloutBoardInput } from "./rollout";
import type { BoardConfig } from "./types";
import type { Transition } from "./runner/transitions";

const statuses = [
  { id: "triagem", name: "Triagem", staging: true },
  { id: "desenvolver", name: "Desenvolver" },
  { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
  { id: "merge", name: "Integrar", autorun: true },
  { id: "concluida", name: "No ar", terminal: true, delivered: true },
];
const config = (autonomy: BoardConfig["autonomy"]) => ({ id: "p", name: "Piloto", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy }) as unknown as BoardConfig;
const hop = (cardId: string, from: string | null, to: string, actor: string, at: string): Transition => ({ v: 1, at, board: "p", cardId, from, to, actor } as Transition);

const cards = [
  coerceCard("story-a", { type: "story", storyType: "technical", title: "Cache", status: "concluida" }, ""),
  coerceCard("story-b", { type: "story", storyType: "technical", title: "Índice", status: "concluida" }, ""),
  coerceCard("story-c", { type: "story", storyType: "user", title: "Plano pago", status: "concluida", businessClasses: { ids: ["money"], reason: "plano pago", by: "juiz", at: "2026-09-20" } }, ""),
  coerceCard("story-d", { type: "story", storyType: "technical", title: "Timeout", status: "concluida", questions: [{ id: "q1", text: "Timeout de 5s ou 10s?", status: "answered", answer: "5s", category: "technical", answeredAt: "2026-09-29" }] }, ""),
  coerceCard("story-e", { type: "story", storyType: "technical", title: "Antiga", status: "concluida" }, ""),
];
const transitions: Transition[] = [
  // a: só sistema e agentes — limpa
  hop("story-a", "desenvolver", "revisao", "cascade", "2026-09-29T10:00:00Z"),
  hop("story-a", "revisao", "merge", "run:orch", "2026-09-29T11:00:00Z"),
  hop("story-a", "merge", "concluida", "system", "2026-09-29T12:00:00Z"),
  // b: o dono aprovou a entrega de uma história técnica — toque técnico
  hop("story-b", "revisao", "merge", "human", "2026-09-29T13:00:00Z"),
  hop("story-b", "merge", "concluida", "system", "2026-09-29T14:00:00Z"),
  // c: o dono aprovou, mas o card toca «dinheiro» — toque de NEGÓCIO, a história conta
  hop("story-c", "revisao", "merge", "human", "2026-09-29T15:00:00Z"),
  hop("story-c", "merge", "concluida", "system", "2026-09-29T16:00:00Z"),
  // d: só sistema nos saltos, mas o dono respondeu uma pergunta técnica — toque técnico
  hop("story-d", "merge", "concluida", "system", "2026-09-29T17:00:00Z"),
  // e: foi ao ar ANTES de o só-negócio valer
  hop("story-e", "merge", "concluida", "system", "2026-09-20T10:00:00Z"),
];
const pilot = (autonomy: BoardConfig["autonomy"], first: string | null = "2026-09-28T00:00:00Z"): RolloutBoardInput => ({ id: "p", name: "Piloto", config: config(autonomy), cards, firstSystemDecisionAt: first });

describe("rolloutReadiness", () => {
  it("conta só o que foi ao ar sem toque técnico do dono, desde que o só-negócio vale", () => {
    const r = rolloutReadiness(transitions, [pilot({ mode: "ultra" })]);
    expect(r.pilots[0]).toMatchObject({ board: "p", since: "2026-09-28T00:00:00Z", sinceSource: "first-system-decision", required: ROLLOUT_CLEAN_STORIES_DEFAULT, live: 4 });
    expect(r.pilots[0].clean.sort()).toEqual(["story-a", "story-c"]);
    expect(r.pilots[0].touched.map((t) => t.cardId).sort()).toEqual(["story-b", "story-d"]);
    expect(r).toMatchObject({ ready: false, line: "Pronto para estender a outros boards: não — 2/10 histórias no ar sem toque técnico seu" });
  });

  it("o N é do board (`autonomy.rolloutCleanStories`); chegou nele, está pronto", () => {
    expect(rolloutReadiness(transitions, [pilot({ mode: "ultra", rolloutCleanStories: 2 })])).toMatchObject({ ready: true, line: expect.stringMatching(/: sim — 2\/2/) });
  });

  it("o período: `since` explícito vence; sem registro de decisões, o ledger inteiro — e o relatório diz qual valeu", () => {
    expect(rolloutReadiness(transitions, [pilot({ mode: "ultra" })], { since: "2026-09-29T12:30:00Z" }).pilots[0]).toMatchObject({ sinceSource: "explicit", live: 3 });
    const whole = rolloutReadiness(transitions, [pilot({ mode: "ultra" }, null)]).pilots[0];
    expect(whole).toMatchObject({ since: null, sinceSource: "whole-ledger", live: 5 });
    expect(whole.clean).toContain("story-e");
  });

  it("só board em só-negócio é piloto; sem piloto, não está pronto", () => {
    expect(rolloutReadiness(transitions, [pilot({ mode: "human" }), pilot(undefined)])).toEqual({
      pilots: [],
      ready: false,
      line: "Pronto para estender a outros boards: não — nenhum board está em só-negócio",
    });
  });

  it("o `_base` declara N = 10 e o contrato aceita; o board pode trocar", async () => {
    expect((await readBaseTemplateConfig()).autonomy?.rolloutCleanStories).toBe(10);
    expect(coerceAutonomy({ rolloutCleanStories: "12" })).toEqual({ rolloutCleanStories: 12 });
    expect(coerceAutonomy({ rolloutCleanStories: 0 })).toBeUndefined();
  });
});

describe("o resumo da semana leva a linha da regra de expansão", () => {
  it("quando o coletor a mede, ela vai junto — e só ela (a regra não liga nada)", async () => {
    const { buildWeeklySummary, weekWindow } = await import("./weekly-summary");
    const r = rolloutReadiness(transitions, [pilot({ mode: "ultra" })]);
    const s = buildWeeklySummary({ week: weekWindow("2026-09-28", "America/Sao_Paulo"), boards: [], transitions: [], decisions: [], runs: [], waiting: [], rollout: { ready: r.ready, line: r.line } });
    expect(s.rollout).toEqual({ ready: false, line: "Pronto para estender a outros boards: não — 2/10 histórias no ar sem toque técnico seu" });
  });
});
