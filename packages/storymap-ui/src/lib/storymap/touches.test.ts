// A MEDIDA de toques HUMANOS por história, a partir do ledger de transições (o ator de cada salto:
// humano × sistema, run e agentes), separados em NEGÓCIO × TÉCNICO. A linha de base abaixo usa um ledger inventado
// de três histórias.

import { describe, expect, it } from "vitest";
import { coerceCard } from "./repo";
import { parseTransitionsLines } from "./runner/transitions";
import { classifyActor, touchesPerStory } from "./touches";
import type { BoardConfig, Card } from "./types";

const statuses = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true },
  { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
  { id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true },
  { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
  { id: "merge", name: "Integrar", autorun: true },
  { id: "stage", name: "Homologar", autorun: true },
  { id: "release", name: "Liberar", autorun: false },
  { id: "deploy", name: "Publicar", autorun: false, onEnter: "promote-and-deploy" },
  { id: "concluida", name: "No ar", gate: "hasDeployProof", terminal: true, delivered: true },
];
const config = { id: "armazem", name: "Livraria", statuses, releases: [], personas: [], systems: [], linkTypes: [] } as unknown as BoardConfig;

// Ledger de transições inventado: três histórias de uma livraria, com o mesmo formato de `storymap/.runner/transitions.jsonl`.
const PILOT = `
{"v":1,"at":"2026-06-08T09:14:05.311Z","board":"armazem","cardId":"story-ex9101","from":"triage","to":"enriquecer","actor":"human","note":"accept-triage"}
{"v":1,"at":"2026-06-08T09:20:17.940Z","board":"armazem","cardId":"story-ex9102","from":"triage","to":"enriquecer","actor":"run:orch","note":"accept-triage"}
{"v":1,"at":"2026-06-08T09:31:48.027Z","board":"armazem","cardId":"story-ex9101","from":"enriquecer","to":"desenvolver","actor":"run:orch"}
{"v":1,"at":"2026-06-08T10:05:52.113Z","board":"armazem","cardId":"story-ex9102","from":"enriquecer","to":"desenvolver","actor":"run:orch"}
{"v":1,"at":"2026-06-08T10:12:33.660Z","board":"armazem","cardId":"story-ex9101","from":"desenvolver","to":"desenvolver","actor":"merge","runId":"a91c04e2","note":"merge:approved"}
{"v":1,"at":"2026-06-08T10:41:09.386Z","board":"armazem","cardId":"story-ex9102","from":"desenvolver","to":"revisao","actor":"run:orch"}
{"v":1,"at":"2026-06-08T12:48:16.219Z","board":"armazem","cardId":"story-ex9101","from":"desenvolver","to":"revisao","actor":"run:orch"}
{"v":1,"at":"2026-06-10T16:20:41.205Z","board":"armazem","cardId":"story-ex9101","from":"revisao","to":"merge","actor":"human"}
{"v":1,"at":"2026-06-10T16:20:42.011Z","board":"armazem","cardId":"story-ex9101","from":"merge","to":"stage","actor":"cascade"}
{"v":1,"at":"2026-06-10T16:20:43.490Z","board":"armazem","cardId":"story-ex9101","from":"stage","to":"release","actor":"cascade"}
{"v":1,"at":"2026-06-10T16:21:30.552Z","board":"armazem","cardId":"story-ex9102","from":"revisao","to":"merge","actor":"human"}
{"v":1,"at":"2026-06-10T16:21:31.277Z","board":"armazem","cardId":"story-ex9102","from":"merge","to":"stage","actor":"cascade"}
{"v":1,"at":"2026-06-10T16:21:32.805Z","board":"armazem","cardId":"story-ex9102","from":"stage","to":"release","actor":"cascade"}
{"v":1,"at":"2026-06-12T11:02:09.738Z","board":"armazem","cardId":"story-ex9101","from":"release","to":"deploy","actor":"human"}
{"v":1,"at":"2026-06-12T11:03:44.208Z","board":"armazem","cardId":"story-ex9102","from":"release","to":"deploy","actor":"human"}
{"v":1,"at":"2026-06-12T11:09:27.455Z","board":"armazem","cardId":"story-ex9101","from":"deploy","to":"concluida","actor":"system","note":"deploy:settled:registry-ondone"}
{"v":1,"at":"2026-06-12T11:15:02.671Z","board":"armazem","cardId":"story-ex9102","from":"deploy","to":"release","actor":"system","note":"deploy:reverted"}
{"v":1,"at":"2026-06-12T11:40:18.349Z","board":"armazem","cardId":"story-ex9102","from":"release","to":"deploy","actor":"human"}
{"v":1,"at":"2026-06-12T11:52:36.900Z","board":"armazem","cardId":"story-ex9102","from":"deploy","to":"release","actor":"run:orch"}
{"v":1,"at":"2026-06-12T13:05:27.514Z","board":"armazem","cardId":"story-ex9102","from":"release","to":"deploy","actor":"human"}
{"v":1,"at":"2026-06-12T13:11:50.082Z","board":"armazem","cardId":"story-ex9102","from":"deploy","to":"concluida","actor":"system","note":"deploy:settled:registry-ondone"}
{"v":1,"at":"2026-06-12T14:02:11.620Z","board":"armazem","cardId":"story-ex9103","from":"triage","to":"enriquecer","actor":"run:orch","note":"accept-triage"}
{"v":1,"at":"2026-06-12T14:40:03.771Z","board":"armazem","cardId":"story-ex9103","from":"enriquecer","to":"desenvolver","actor":"run:orch"}
{"v":1,"at":"2026-06-12T15:21:46.309Z","board":"armazem","cardId":"story-ex9103","from":"desenvolver","to":"revisao","actor":"run:orch"}
{"v":1,"at":"2026-06-12T17:30:12.846Z","board":"armazem","cardId":"story-ex9103","from":"revisao","to":"merge","actor":"human"}
{"v":1,"at":"2026-06-12T17:30:13.904Z","board":"armazem","cardId":"story-ex9103","from":"merge","to":"stage","actor":"cascade"}
{"v":1,"at":"2026-06-12T17:30:15.372Z","board":"armazem","cardId":"story-ex9103","from":"stage","to":"release","actor":"cascade"}
{"v":1,"at":"2026-06-12T17:41:55.093Z","board":"armazem","cardId":"story-ex9103","from":"release","to":"deploy","actor":"human"}
{"v":1,"at":"2026-06-12T17:49:41.730Z","board":"armazem","cardId":"story-ex9103","from":"deploy","to":"concluida","actor":"system","note":"deploy:settled:registry-ondone"}
`;
const transitions = parseTransitionsLines(PILOT);
const tech = (id: string, over: Record<string, unknown> = {}): Card => coerceCard(id, { type: "story", storyType: "technical", title: id, ...over }, "");
const cards = [tech("story-ex9101"), tech("story-ex9102"), tech("story-ex9103")];

describe("quem é quem no ledger", () => {
  it("human é o dono; cascade/system/merge são o sistema; run:* são agentes (o Jido, o juiz, o condutor)", () => {
    expect(classifyActor("human")).toBe("human");
    for (const a of ["cascade", "system", "merge"]) expect(classifyActor(a)).toBe("system");
    for (const a of ["run:orch", "run:triage-judge", "run:harness-do"]) expect(classifyActor(a)).toBe("agent");
  });
});

describe("touchesPerStory — a linha de base", () => {
  const report = touchesPerStory(transitions, { board: "armazem", cards, config });
  const of = (id: string) => report.stories.find((s) => s.cardId === id)!;

  it("ex9101: 3 toques humanos técnicos — aceitar, aprovar a entrega, publicar", () => {
    expect(of("story-ex9101").human).toMatchObject({ hops: 3, points: ["triage-accept", "delivery-approval", "publish"], business: 0, technical: 3 });
  });

  it("ex9102 e ex9103: aprovar a entrega e publicar (o aceite foi de um AGENTE pelo token ORCH), com as republicações de ex9102", () => {
    expect(of("story-ex9102").human).toMatchObject({ hops: 4, points: ["delivery-approval", "publish"], business: 0, technical: 4 });
    expect(of("story-ex9103").human).toMatchObject({ hops: 2, points: ["delivery-approval", "publish"], business: 0, technical: 2 });
    expect(of("story-ex9102").agent).toBeGreaterThan(0);
    // o aceite existiu — feito por agente — e fica visível como ponto de decisão de agente
    expect(of("story-ex9102").agentPoints).toContain("triage-accept");
  });

  it("o resumo do board: histórias, média de toques e de pontos de decisão humanos, negócio × técnico", () => {
    expect(report.summary).toMatchObject({ stories: 3, humanHops: 9, business: 0, technical: 9 });
    expect(report.summary.meanHumanPoints).toBeCloseTo(7 / 3, 5);
  });
});

describe("negócio × técnico", () => {
  it("um card que toca uma classe do dono conta os toques humanos como NEGÓCIO", () => {
    const money = tech("story-ex9103", { businessClasses: { ids: ["money"], reason: "API paga", by: "triage-judge", at: "x" } });
    const r = touchesPerStory(transitions, { board: "armazem", cards: [money], config });
    expect(r.stories.find((s) => s.cardId === "story-ex9103")!.human).toMatchObject({ business: 2, technical: 0 });
  });

  it("perguntas que o dono respondeu entram à parte, pela classe da pergunta", () => {
    const withQs = tech("story-ex9103", {
      questions: [
        { id: "q1", text: "Qual provedor de e-mail transacional contratamos?", status: "answered", answer: "x", category: "money" },
        { id: "q2", text: "Cursor ou offset?", status: "answered", answer: "cursor", category: "technical" },
        { id: "q3", text: "?", status: "answered", answer: "y", answeredBy: "proxy", category: "technical", proxy: { assumptions: "p", confidence: 1 } },
      ],
    });
    const r = touchesPerStory(transitions, { board: "armazem", cards: [withQs], config });
    expect(r.stories.find((s) => s.cardId === "story-ex9103")!.answers).toEqual({ business: 1, technical: 1 });
  });

  it("o período filtra pelo instante do salto", () => {
    const r = touchesPerStory(transitions, { board: "armazem", cards, config, since: "2026-06-12T00:00:00Z" });
    expect(r.stories.find((s) => s.cardId === "story-ex9103")!.human.hops).toBe(2);
    expect(r.stories.find((s) => s.cardId === "story-ex9101")!.human.points).toEqual(["publish"]);
  });
});
