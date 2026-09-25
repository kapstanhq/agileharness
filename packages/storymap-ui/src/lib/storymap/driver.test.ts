// The card DRIVER + the conductor dispatch policy — the pure answers every other layer asks.

import { describe, expect, it } from "vitest";
import {
  conductorCommand,
  conductorConfigProblem,
  conductorEntryVerdict,
  conductorTask,
  isConducted,
  preserveDriver,
  resolveConductorPolicy,
  withDriver,
  withoutDriver,
} from "./driver";
import { moveRiskClass } from "./entry-effect";
import type { BoardConfig, CardRouting, StatusDef } from "./types";

const statuses: StatusDef[] = [
  { id: "triage", name: "Triagem" },
  { id: "pronta", name: "Pronta", autorun: false },
  { id: "enriquecer", name: "Especificar", trigger: "harness-enrich", autorun: true },
  { id: "desenvolver", name: "Dev", trigger: "harness-do", autorun: true },
  { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
  { id: "concluida", name: "No ar", terminal: true },
];
const board = (conductor?: BoardConfig["conductor"]): BoardConfig => ({
  id: "b",
  name: "B",
  statuses,
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  ...(conductor ? { conductor } : {}),
});
const story = { type: "story" as const, status: "pronta", capture: undefined, container: undefined };

describe("isConducted / withDriver / withoutDriver", () => {
  it("só `routing.driver: conductor` é conduzido", () => {
    expect(isConducted({ routing: { skips: [], decidedBy: "rules", decidedAt: "", driver: "conductor" } })).toBe(true);
    expect(isConducted({ routing: { skips: ["x"], decidedBy: "rules", decidedAt: "" } })).toBe(false);
    expect(isConducted({ routing: null })).toBe(false);
    expect(isConducted(null)).toBe(false);
  });

  it("marcar num card SEM routing nasce com skips vazio (as regras seguem decidindo o resto)", () => {
    expect(withDriver({ routing: null }, "conductor", "2026-09-25")).toEqual({
      skips: [],
      decidedBy: "rules",
      decidedAt: "2026-09-25",
      driver: "conductor",
    });
  });

  it("marcar preserva a rota que já existia (skips, perfil, tetos)", () => {
    const r: CardRouting = { skips: ["interview"], decidedBy: "agent", decidedAt: "d", profile: "express", modelCap: "sonnet" };
    expect(withDriver({ routing: r }, "conductor", "x")).toEqual({ ...r, driver: "conductor" });
  });

  it("marcar um card JÁ conduzido é no-op (null ⇒ sem escrita ⇒ sem loop do watcher)", () => {
    expect(withDriver({ routing: { skips: [], decidedBy: "rules", decidedAt: "", driver: "conductor" } }, "conductor", "x")).toBeNull();
  });

  it("limpar um routing que só existia pelo driver volta a null (as regras decidem ao vivo)", () => {
    expect(withoutDriver({ routing: { skips: [], decidedBy: "rules", decidedAt: "", driver: "conductor" } })).toBeNull();
  });

  it("limpar preserva uma rota com substância", () => {
    expect(withoutDriver({ routing: { skips: ["interview"], decidedBy: "agent", decidedAt: "d", driver: "conductor" } })).toEqual({
      skips: ["interview"],
      decidedBy: "agent",
      decidedAt: "d",
    });
  });

  it("limpar sem driver é undefined (nada a escrever)", () => {
    expect(withoutDriver({ routing: null })).toBeUndefined();
  });
});

describe("preserveDriver — editar/limpar a ROTA não devolve o card à cascata", () => {
  const conducted: CardRouting = { skips: [], decidedBy: "rules", decidedAt: "d0", driver: "conductor" };

  it("uma rota NOVA herda o driver do card", () => {
    expect(preserveDriver({ skips: ["interview"], decidedBy: "human", decidedAt: "d1" }, conducted, "d1")).toEqual({
      skips: ["interview"],
      decidedBy: "human",
      decidedAt: "d1",
      driver: "conductor",
    });
  });

  it("LIMPAR a rota (null) num card conduzido mantém um routing só com o driver", () => {
    expect(preserveDriver(null, conducted, "d1")).toEqual({ skips: [], decidedBy: "rules", decidedAt: "d0", driver: "conductor" });
  });

  it("card sem driver: a rota passa intacta (inclusive o null)", () => {
    expect(preserveDriver(null, null, "d1")).toBeNull();
    const r: CardRouting = { skips: ["x"], decidedBy: "human", decidedAt: "d1" };
    expect(preserveDriver(r, { skips: [], decidedBy: "rules", decidedAt: "" }, "d1")).toBe(r);
  });
});

describe("resolveConductorPolicy", () => {
  it("ausente ou desligado ⇒ null", () => {
    expect(resolveConductorPolicy(board())).toBeNull();
    expect(resolveConductorPolicy(board({ enabled: false, fromStatus: "pronta" }))).toBeNull();
  });

  it("defaults: 2 sessões por board e opus", () => {
    expect(resolveConductorPolicy(board({ enabled: true, fromStatus: "pronta" }))).toEqual({
      fromStatus: "pronta",
      maxSessions: 2,
      model: "opus",
    });
  });

  it("o board sobrescreve cap e modelo", () => {
    expect(resolveConductorPolicy(board({ enabled: true, fromStatus: "pronta", maxSessions: 1, model: "sonnet" }))).toEqual({
      fromStatus: "pronta",
      maxSessions: 1,
      model: "sonnet",
    });
  });
});

describe("conductorEntryVerdict — só uma STORY entrando em fromStatus", () => {
  const on = board({ enabled: true, fromStatus: "pronta" });

  it("story em fromStatus ⇒ dispatch", () => {
    expect(conductorEntryVerdict(story, on)).toEqual({ dispatch: true });
  });

  it("outro status, board desligado, step/activity, contêiner ⇒ não", () => {
    expect(conductorEntryVerdict({ ...story, status: "enriquecer" }, on).dispatch).toBe(false);
    expect(conductorEntryVerdict(story, board()).dispatch).toBe(false);
    expect(conductorEntryVerdict({ ...story, type: "step" as const }, on).dispatch).toBe(false);
    expect(conductorEntryVerdict({ ...story, capture: true }, on).dispatch).toBe(false);
  });

  it("um fromStatus TERMINAL nunca despacha (card pronto não ganha condutor)", () => {
    expect(conductorEntryVerdict({ ...story, status: "concluida" }, board({ enabled: true, fromStatus: "concluida" })).dispatch).toBe(false);
  });

  it("o comando e a tarefa carregam board/card", () => {
    expect(conductorCommand("b", "story-x")).toBe("/harness-conductor b/story-x");
    expect(conductorTask("b", "story-x")).toContain("/harness-conductor b/story-x");
  });
});

describe("moveRiskClass — a classe é o que o move SPAWNA (conductor-aware)", () => {
  const on = board({ enabled: true, fromStatus: "pronta" });
  const conducted = { ...story, routing: { skips: [], decidedBy: "rules" as const, decidedAt: "", driver: "conductor" as const } };
  const plain = { ...story, routing: null };

  it("card CONDUZIDO entrando numa coluna armada é write-board (nenhuma skill dispara nele)", () => {
    expect(moveRiskClass(on, "desenvolver", "pronta", conducted)).toBe("write-board");
  });

  it("o mesmo move de um card NÃO conduzido segue `run`", () => {
    expect(moveRiskClass(on, "desenvolver", "pronta", plain)).toBe("run");
  });

  it("uma story NÃO conduzida entrando em fromStatus é `run` (abre uma sessão condutora)", () => {
    expect(moveRiskClass(on, "pronta", "triage", plain)).toBe("run");
    // …sem conductor no board, a mesma coluna manual segue benigna.
    expect(moveRiskClass(board(), "pronta", "triage", plain)).toBe("write-board");
  });

  it("onEnter segue `deploy` mesmo conduzido (efeitos de entrada não são skills de coluna)", () => {
    expect(moveRiskClass(on, "deploy", "pronta", conducted)).toBe("deploy");
  });

  it("sem card, a classificação legada é idêntica", () => {
    expect(moveRiskClass(on, "desenvolver", "pronta")).toBe("run");
    expect(moveRiskClass(on, "pronta", "triage")).toBe("write-board");
  });
});

describe("conductorConfigProblem — o alarme de um conductor que nunca dispararia", () => {
  it("fromStatus inexistente ou terminal num board ligado ⇒ problema; ok/desligado ⇒ null", () => {
    expect(conductorConfigProblem(board({ enabled: true, fromStatus: "nao-existe" }))).toMatch(/NUNCA/);
    expect(conductorConfigProblem(board({ enabled: true, fromStatus: "concluida" }))).toMatch(/terminal/);
    expect(conductorConfigProblem(board({ enabled: true, fromStatus: "pronta" }))).toBeNull();
    expect(conductorConfigProblem(board({ enabled: false, fromStatus: "nao-existe" }))).toBeNull();
    expect(conductorConfigProblem(board())).toBeNull();
  });
});
