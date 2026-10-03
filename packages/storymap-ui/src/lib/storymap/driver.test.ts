// The card DRIVER + the conductor dispatch policy — the pure answers every other layer asks.

import { describe, expect, it } from "vitest";
import {
  conductorCommand,
  conductorConfigProblem,
  CONDUCTOR_SCOPE_WAIT_KIND,
  conductorEntryVerdict,
  conductorModelFor,
  conductorTask,
  isConducted,
  preserveDriver,
  resolveConductorPolicy,
  withDriver,
  withoutDriver,
} from "./driver";
import { moveRiskClass } from "./entry-effect";
import { resolveBoardGate, type BoardPaceRow } from "./runner/board-pace";
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
      fromStatuses: ["pronta"],
      maxSessions: 2,
      model: "opus",
    });
  });

  it("o board sobrescreve cap e modelo", () => {
    expect(resolveConductorPolicy(board({ enabled: true, fromStatus: "pronta", maxSessions: 1, model: "sonnet" }))).toEqual({
      fromStatuses: ["pronta"],
      maxSessions: 1,
      model: "sonnet",
    });
  });

  it("o modelo pode ser a variante de 1M — é o que o condutor usa num alvo de piso de contexto alto", () => {
    expect(resolveConductorPolicy(board({ enabled: true, fromStatus: "pronta", model: "opus[1m]" }))?.model).toBe("opus[1m]");
  });

  it("fromStatus em LISTA resolve para todos os ids (e uma lista vazia é desligado)", () => {
    expect(resolveConductorPolicy(board({ enabled: true, fromStatus: ["enriquecer", "pronta"] }))?.fromStatuses).toEqual([
      "enriquecer",
      "pronta",
    ]);
    expect(resolveConductorPolicy(board({ enabled: true, fromStatus: [] }))).toBeNull();
  });
});

describe("conductor.fromStatus em LISTA — o aceite manda o card a status diferentes por tipo", () => {
  const multi = board({ enabled: true, fromStatus: ["pronta", "enriquecer"] });

  it("uma story entrando em QUALQUER status da lista é despachada; fora dela, não", () => {
    expect(conductorEntryVerdict(story, multi)).toEqual({ dispatch: true });
    expect(conductorEntryVerdict({ ...story, status: "enriquecer" }, multi)).toEqual({ dispatch: true });
    expect(conductorEntryVerdict({ ...story, status: "desenvolver" }, multi).dispatch).toBe(false);
  });

  it("a forma string segue valendo sozinha (retrocompatível)", () => {
    const single = board({ enabled: true, fromStatus: "pronta" });
    expect(conductorEntryVerdict(story, single)).toEqual({ dispatch: true });
    expect(conductorEntryVerdict({ ...story, status: "enriquecer" }, single).dispatch).toBe(false);
  });

  it("a classe de risco reconhece cada status da lista como spawn (`run`)", () => {
    const plain = { ...story, routing: null };
    expect(moveRiskClass(multi, "enriquecer", "triage", plain)).toBe("run");
  });

  it("o alarme julga CADA id da lista: um typo ou um terminal no meio é problema", () => {
    expect(conductorConfigProblem(board({ enabled: true, fromStatus: ["pronta", "nao-existe"] }))).toMatch(/nao-existe/);
    expect(conductorConfigProblem(board({ enabled: true, fromStatus: ["pronta", "concluida"] }))).toMatch(/terminal/);
    expect(conductorConfigProblem(multi)).toBeNull();
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

  it("um card ADIADO (não agora) nunca despacha — nem na entrada, nem como órfão", () => {
    expect(conductorEntryVerdict({ ...story, deferred: { reason: "fora do ciclo", since: "2026-10-02", by: "human" } }, on)).toEqual({ dispatch: false, reason: "card adiado (não agora)" });
  });

  it("um fromStatus TERMINAL nunca despacha (card pronto não ganha condutor)", () => {
    expect(conductorEntryVerdict({ ...story, status: "concluida" }, board({ enabled: true, fromStatus: "concluida" })).dispatch).toBe(false);
  });

  it("o comando e a tarefa carregam board/card", () => {
    expect(conductorCommand("b", "story-x")).toBe("/harness-conductor b/story-x");
    expect(conductorTask("b", "story-x")).toContain("/harness-conductor b/story-x");
  });
});

describe("conductorEntryVerdict — o ESCOPO DE TIPOS do board (board-pace.ts) é a última pergunta", () => {
  const on = board({ enabled: true, fromStatus: "pronta" });
  const NOW = Date.parse("2026-10-02T12:00:01.000Z");
  const fixesOnly = resolveBoardGate({}, { board: "b", ownerScope: { types: ["bug", "technical", "chore", "spike"], by: { kind: "owner" }, at: "2026-10-02T12:00:00.000Z" } } as BoardPaceRow, NOW);
  const noScope = resolveBoardGate({}, null, NOW);

  it("a classe de espera da fila tem nome estável", () => {
    expect(CONDUCTOR_SCOPE_WAIT_KIND).toBe("tipo-nao-admitido");
  });

  it("funcionalidade nova (user) é recusada com a frase do dono e a marca `scopeRefused`", () => {
    const v = conductorEntryVerdict({ ...story, id: "s1", storyType: "user" }, on, fixesOnly);
    expect(v).toEqual({
      dispatch: false,
      reason: "Funcionalidade nova fica de fora: o board só começa Erro, Trabalho técnico, Manutenção e Investigação por enquanto",
      scopeRefused: true,
    });
  });

  it("card sem storyType vale user (o padrão) e é recusado; bug, technical, chore e spike despacham", () => {
    expect(conductorEntryVerdict({ ...story, id: "s1" }, on, fixesOnly).dispatch).toBe(false);
    for (const storyType of ["bug", "technical", "chore", "spike"] as const) {
      expect(conductorEntryVerdict({ ...story, id: "s1", storyType }, on, fixesOnly)).toEqual({ dispatch: true });
    }
  });

  it("um `user` em modo `fix` conta como erro e despacha; em modo `refine` continua funcionalidade", () => {
    expect(conductorEntryVerdict({ ...story, id: "s1", storyType: "user", mode: "fix" }, on, fixesOnly).dispatch).toBe(true);
    expect(conductorEntryVerdict({ ...story, id: "s1", storyType: "user", mode: "refine" }, on, fixesOnly).dispatch).toBe(false);
  });

  it("a recusa por tipo só aparece quando TODO o resto admitiria: as outras razões não carregam `scopeRefused`", () => {
    const user = { ...story, id: "s1", storyType: "user" as const };
    expect(conductorEntryVerdict({ ...user, status: "enriquecer" }, on, fixesOnly)).toMatchObject({ dispatch: false, reason: expect.stringContaining("fora de fromStatus") });
    expect(conductorEntryVerdict({ ...user, status: "enriquecer" }, on, fixesOnly)).not.toHaveProperty("scopeRefused");
    expect(conductorEntryVerdict(user, board(), fixesOnly)).not.toHaveProperty("scopeRefused");
    expect(conductorEntryVerdict({ ...user, deferred: { reason: "x", since: "2026-10-02", by: "human" } }, on, fixesOnly)).toEqual({ dispatch: false, reason: "card adiado (não agora)" });
    expect(conductorEntryVerdict({ ...user, type: "step" as const }, on, fixesOnly)).not.toHaveProperty("scopeRefused");
  });

  it("sem escopo (portão sem limite, ausente ou nulo) a régua é a de sempre", () => {
    const user = { ...story, id: "s1", storyType: "user" as const };
    expect(conductorEntryVerdict(user, on, noScope)).toEqual({ dispatch: true });
    expect(conductorEntryVerdict(user, on, null)).toEqual({ dispatch: true });
    expect(conductorEntryVerdict(user, on)).toEqual({ dispatch: true });
  });

  it("a classe de risco do move NÃO muda (ela não conhece o escopo: continua «run» para o que despacharia sem ele)", () => {
    expect(moveRiskClass(on, "pronta", "triage", { ...story, routing: null })).toBe("run");
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

describe("conductorModelFor — o teto de modelo do CARD vale para o condutor (porta 2 do D10)", () => {
  it("sem teto no card: o modelo do board, intacto (o comportamento de antes)", () => {
    expect(conductorModelFor("opus[1m]", undefined)).toBe("opus[1m]");
    expect(conductorModelFor("opus", undefined)).toBe("opus");
    expect(conductorModelFor("sonnet[1m]", undefined)).toBe("sonnet[1m]");
  });

  it("teto sonnet sobre um condutor opus: desce para sonnet, MANTENDO a janela de 1M", () => {
    // O condutor carrega a história inteira (tipicamente centenas de milhares de tokens) e o medidor do AH lê um id seco como
    // janela de 200k: sem o sufixo a UI mostraria 50% aos 100k e sugeriria reciclar um condutor saudável.
    expect(conductorModelFor("opus[1m]", "sonnet")).toBe("sonnet[1m]");
    expect(conductorModelFor("opus", "sonnet")).toBe("sonnet");
  });

  it("um teto só BAIXA: opus sobre sonnet, ou o mesmo tier, não muda nada", () => {
    expect(conductorModelFor("sonnet[1m]", "opus")).toBe("sonnet[1m]");
    expect(conductorModelFor("sonnet", "opus")).toBe("sonnet");
    expect(conductorModelFor("opus[1m]", "opus")).toBe("opus[1m]");
    expect(conductorModelFor("sonnet[1m]", "sonnet")).toBe("sonnet[1m]");
  });

  it("um teto fora dos tiers conhecidos não é teto — e jamais vira o modelo", () => {
    expect(conductorModelFor("opus[1m]", "haiku" as never)).toBe("opus[1m]");
    expect(conductorModelFor("opus", "" as never)).toBe("opus");
  });
});
