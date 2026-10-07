// O vigia de card parado (fatia 1 das «paradas por recurso»): um card num passo em que
// o próximo ator é o SISTEMA, sem ninguém trabalhando e sem nada que explique a espera, tem o passo refeito UMA vez
// depois de 15 minutos; parando de novo, vira card de conserto e item no Inbox. O que tem explicação nunca é tocado.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import { CARD_STALLED_FINDING_ID, DEPLOY_FAILURE_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID, ENTRY_EFFECT_FAILED_FINDING_ID } from "@/lib/storymap/demands";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card, Finding } from "@/lib/storymap/types";
import { classifyStall, isStallCandidate, stalledFinding, sweepStalledCards, type StallFacts, type StallRow, type StallWatchDeps } from "./stall-watch";
import { DEFAULT_PARK_SETTINGS, ladderGraceMs } from "./conductor-pause";
import { resolveBoardGate, type BoardPaceRow } from "./board-pace";
import { batchHandoffPending, batchItemFoldsIntoLead, batchItemsWaiting, conductorHold, conductorSessionFor, queuedForConductor, scopeHeldCards, withBatchItems } from "./stall-watch-deps";
import type { AgentSession } from "./session-worktree";
import { decideCascade } from "@/lib/notifications/server/channels/cascade-decision";

const MIN = 60_000;
const AFTER = 15 * MIN;

const configOf = (mode: "auto" | "manual" = "auto") =>
  ({
    id: "b",
    name: "B",
    release: { mode },
    statuses: [
      { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
      { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed" },
      { id: "merge", name: "Integrar", autorun: true },
      { id: "release", name: "Liberar", onEnter: "promote-stage" },
      { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
      { id: "concluida", name: "No ar", terminal: true },
    ],
    releases: [],
    personas: [],
    systems: [],
    linkTypes: [],
  }) as unknown as BoardConfig;

const cardIn = (status: string, extra: Record<string, unknown> = {}): Card => coerceCard("story-x", { type: "story", storyType: "bug", title: "Exportar a lista de pedidos", status, ...extra }, "");
const finding = (id: string, status: Finding["status"] = "open"): Finding => ({ id, lens: "general", severity: "medium", title: id, status });
const FREE: StallFacts = { inFlight: false, deployRunning: false, publishOpen: false, proofPending: false, breakerHeld: false, conductor: null };
const conducted = (status = "desenvolver") => cardIn(status, { routing: { driver: "conductor" } });
const conductorFacts = (c: Partial<NonNullable<StallFacts["conductor"]>>): StallFacts => ({ ...FREE, conductor: { live: true, queued: false, quietForMs: null, asking: false, declaredWaiting: false, ...c } });

describe("classifyStall — quando um card está parado sem dono", () => {
  // Caso real: revisão aprovada, finding de prova fechado, republicação perdida.
  it("o caso típico: card no passo de publicar, sem carimbo, sem finding aberto, sem prova pendente e sem run", () => {
    const card = cardIn("deploy", { findings: [finding(DEPLOY_FAILURE_FINDING_ID, "fixed")] });
    expect(classifyStall(card, configOf("auto"), FREE, AFTER)).toEqual({ subject: { kind: "entry-effect", effect: "promote-and-deploy", stepId: "deploy", stepName: "Publicar" }, autoRetry: true });
  });

  it("board de publicação manual: é parado, mas o sistema não refaz o passo sozinho", () => {
    expect(classifyStall(cardIn("deploy"), configOf("manual"), FREE, AFTER)).toMatchObject({ subject: { kind: "entry-effect" }, autoRetry: false });
  });

  it("qualquer passo com efeito de entrada conta (liberar), não só o de publicar", () => {
    expect(classifyStall(cardIn("release"), configOf(), FREE, AFTER)).toMatchObject({ subject: { kind: "entry-effect", effect: "promote-stage", stepName: "Liberar" } });
  });

  // Caso real: aprovado pelo dono, ficou em «Integrar» — a cascata só atravessa esse passo num
  // evento de entrada, e o que a segurava naquele momento caiu depois.
  it("passo de PASSAGEM (autorun, sem skill, sem efeito): card parado ali é do sistema, e refazer é reavaliar a cascata", () => {
    expect(classifyStall(cardIn("merge"), configOf("manual"), FREE, AFTER)).toEqual({ subject: { kind: "passage", stepId: "merge", stepName: "Integrar" }, autoRetry: true });
    expect(isStallCandidate(cardIn("merge"), configOf())).toBe(true);
    // com alguém nele, ou com pergunta aberta, não é parado
    expect(classifyStall(cardIn("merge"), configOf(), { ...FREE, inFlight: true }, AFTER)).toBeNull();
    expect(classifyStall(cardIn("merge", { questions: [{ id: "q1", text: "?", status: "open" }] }), configOf(), FREE, AFTER)).toBeNull();
    // a cascata parou de propósito (espera o dono; o disjuntor da publicação guarda a tentativa): tem sinal próprio
    expect(classifyStall(cardIn("merge"), configOf(), { ...FREE, ownerHeld: true }, AFTER)).toBeNull();
    expect(classifyStall(cardIn("merge"), configOf(), { ...FREE, breakerHeld: true }, AFTER)).toBeNull();
  });

  it.each([
    ["publicação em voo (deployFiredAt)", cardIn("deploy", { deployFiredAt: "2026-03-05T04:34" }), FREE],
    ["finding de publicação aberto", cardIn("deploy", { findings: [finding(DEPLOY_FAILURE_FINDING_ID)] }), FREE],
    ["publicação sem prova aberta", cardIn("deploy", { findings: [finding(DEPLOY_UNPROVEN_FINDING_ID)] }), FREE],
    ["efeito de entrada que falhou (já tem item próprio)", cardIn("deploy", { findings: [finding(ENTRY_EFFECT_FAILED_FINDING_ID)] }), FREE],
    ["deploy rodando", cardIn("deploy"), { ...FREE, deployRunning: true }],
    ["pedido de publicação aberto ou segurado", cardIn("deploy"), { ...FREE, publishOpen: true }],
    ["prova pendente no produtor", cardIn("deploy"), { ...FREE, proofPending: true }],
    ["o disjuntor de publicação segura o card", cardIn("deploy"), { ...FREE, breakerHeld: true }],
    ["run, merge ou reserva viva", cardIn("deploy"), { ...FREE, inFlight: true }],
    ["pergunta aberta no card", cardIn("deploy", { questions: [{ id: "q1", text: "Publicar agora?", status: "open" }] }), FREE],
  ])("o que tem explicação não é parado: %s", (_name, card, facts) => {
    expect(classifyStall(card as Card, configOf(), facts as StallFacts, AFTER)).toBeNull();
  });

  it("passo terminal, e passo que espera o humano ou uma skill de coluna, ficam de fora", () => {
    expect(classifyStall(cardIn("concluida"), configOf(), FREE, AFTER)).toBeNull();
    expect(classifyStall(cardIn("revisao"), configOf(), FREE, AFTER)).toBeNull();
    expect(classifyStall(cardIn("desenvolver"), configOf(), FREE, AFTER)).toBeNull();
    expect(isStallCandidate(cardIn("revisao"), configOf())).toBe(false);
    expect(isStallCandidate(cardIn("deploy"), configOf())).toBe(true);
    expect(isStallCandidate(conducted(), configOf())).toBe(true);
  });

  describe("card conduzido", () => {
    it("sem fato (a sonda do tmux falhou) ninguém é julgado", () => {
      expect(classifyStall(conducted(), configOf(), FREE, AFTER)).toBeNull();
    });
    it("condutor morto e fora da fila ⇒ parado; na fila ⇒ esperando vaga, não parado", () => {
      expect(classifyStall(conducted(), configOf(), conductorFacts({ live: false, queued: false }), AFTER)).toEqual({ subject: { kind: "conductor-dead", stepId: "desenvolver", stepName: "Desenvolver" }, autoRetry: false });
      expect(classifyStall(conducted(), configOf(), conductorFacts({ live: false, queued: true }), AFTER)).toBeNull();
    });
    it("condutor vivo e quieto no prompt além do limite ⇒ parado; trabalhando, ou quieto há pouco, não", () => {
      expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: AFTER }), AFTER)).toMatchObject({ subject: { kind: "conductor-quiet" }, autoRetry: false });
      expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: AFTER - 1 }), AFTER)).toBeNull();
      expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: null }), AFTER)).toBeNull();
    });
    it("pausa declarada e prompt desenhado (menu, s/N) já têm o seu sinal", () => {
      expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: AFTER * 4, declaredWaiting: true }), AFTER)).toBeNull();
      expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: AFTER * 4, asking: true }), AFTER)).toBeNull();
    });
    // Caso real: um card que toca dados de pessoas; o condutor morreu num erro de API em
    // «Desenvolver» e ficou horas invisível, porque «o card espera o dono» valia em QUALQUER passo.
    describe("card que toca uma classe do dono (só-negócio)", () => {
      const ultra = { ...configOf(), autonomy: { mode: "ultra" } } as unknown as BoardConfig;
      const personal = (status: string) => cardIn(status, { routing: { driver: "conductor" }, businessClasses: { ids: ["personal-data"], by: "triage-judge", at: "2026-03-05" } });
      it("num passo de construção NÃO está esperando o dono: condutor morto ou quieto é parado", () => {
        expect(classifyStall(personal("desenvolver"), ultra, conductorFacts({ live: false }), AFTER)).toMatchObject({ subject: { kind: "conductor-dead" } });
        expect(classifyStall(personal("desenvolver"), ultra, conductorFacts({ quietForMs: AFTER }), AFTER)).toMatchObject({ subject: { kind: "conductor-quiet" } });
      });
      it("no passo em que o dono aprova a entrega, espera por regra — o condutor quieto ali não é travamento", () => {
        expect(classifyStall(personal("revisao"), ultra, conductorFacts({ quietForMs: AFTER * 8 }), AFTER)).toBeNull();
        // sem classe do dono, o mesmo condutor quieto no mesmo passo é parado
        expect(classifyStall(conducted("revisao"), ultra, conductorFacts({ quietForMs: AFTER * 8 }), AFTER)).toMatchObject({ subject: { kind: "conductor-quiet" } });
      });
    });

    it("nunca é refeito sozinho nesta fatia, nem em board que publica sozinho", () => {
      expect(classifyStall(conducted("deploy"), configOf("auto"), conductorFacts({ live: false }), AFTER)?.autoRetry).toBe(false);
    });
  });
});

describe("stalledFinding — o texto que o dono lê", () => {
  it("diz o passo, desde quando, o que o sistema tentou e onde está o conserto", () => {
    const f = stalledFinding({ kind: "entry-effect", effect: "promote-and-deploy", stepId: "deploy", stepName: "Publicar" }, { since: "04h34", retried: true, autoRetry: true, fixCardId: "story-fix" });
    expect(f).toMatchObject({ id: CARD_STALLED_FINDING_ID, severity: "high", status: "open", title: "Parado em «Publicar» sem ninguém cuidando" });
    expect(f.detail).toMatch(/desde 04h34/);
    expect(f.detail).toMatch(/refez o passo uma vez e ele parou de novo/);
    expect(f.detail).toMatch(/card story-fix/);
  });
  it("num board manual explica por que o sistema não refez", () => {
    const f = stalledFinding({ kind: "entry-effect", effect: "promote-and-deploy", stepId: "deploy", stepName: "Publicar" }, { since: "04h34", retried: false, autoRetry: false, fixCardId: null });
    expect(f.detail).toMatch(/só publica com você/);
  });
});

function world(opts: { card?: Card; mode?: "auto" | "manual"; facts?: StallFacts; master?: boolean; admission?: string | null; retries?: number } = {}) {
  const state = {
    card: opts.card ?? cardIn("deploy"),
    config: configOf(opts.mode ?? "auto"),
    facts: opts.facts ?? FREE,
    rows: [] as StallRow[],
    decisions: [] as SystemDecision[],
    lines: [] as string[],
    now: Date.parse("2026-03-05T04:35:00Z"),
    admission: opts.admission ?? null,
    persisted: 0,
  };
  const deps: StallWatchDeps = {
    ledger: {
      load: async () => state.rows,
      persist: async (rows) => {
        state.rows = rows;
        state.persisted += 1;
      },
    },
    masterEnabled: () => opts.master ?? true,
    settings: () => ({ afterMinutes: 15, retries: opts.retries ?? 1 }),
    admission: () => state.admission,
    boards: async () => [{ id: "b", config: state.config, cards: [state.card] }],
    facts: vi.fn(async () => state.facts),
    retry: vi.fn(async () => ({ ok: true })),
    reevaluate: vi.fn(async () => ({ ok: true })),
    openFixCard: vi.fn(async () => "story-fix"),
    stamp: vi.fn(async (_b: string, _c: string, f: Finding) => {
      state.card = { ...state.card, findings: [...(state.card.findings ?? []).filter((x) => x.id !== f.id), f] };
    }),
    clear: vi.fn(async () => {
      state.card = { ...state.card, findings: (state.card.findings ?? []).map((f) => (f.id === CARD_STALLED_FINDING_ID ? { ...f, status: "fixed" as const } : f)) };
    }),
    record: async (e) => {
      state.decisions.push(e);
    },
    clock: (ms) => `${new Date(ms).toISOString().slice(11, 13)}h${new Date(ms).toISOString().slice(14, 16)}`,
    now: () => state.now,
    log: (l) => state.lines.push(l),
  };
  const sweep = async (advanceMin = 0) => {
    state.now += advanceMin * MIN;
    return sweepStalledCards(deps);
  };
  return { deps, state, sweep };
}

describe("sweepStalledCards — board fora da varredura (pausado/desarmado)", () => {
  const row = (status: string, escalated = true): StallRow => ({
    key: `b2/story-y@${status}`, board: "b2", cardId: "story-y", status, firstSeenAt: 1, attempts: 1, ...(escalated ? { escalatedAt: 2 } : {}),
  });
  it("a linha escalada sai quando o card, lido direto, chegou ao fim, mudou de passo ou sumiu", async () => {
    for (const now of ["concluida", "revisao", null]) {
      const { deps, state, sweep } = world();
      state.rows = [row("deploy")];
      deps.cardStatus = vi.fn(async () => now);
      await sweep();
      expect(state.rows.find((r) => r.board === "b2"), String(now)).toBeUndefined();
    }
  });
  it("o card ainda no mesmo passo (ou a leitura falhou) mantém a linha; sem a porta, nada muda", async () => {
    const still = world();
    still.state.rows = [row("deploy")];
    still.deps.cardStatus = vi.fn(async () => "deploy");
    await still.sweep();
    expect(still.state.rows.find((r) => r.board === "b2")).toBeTruthy();
    const failing = world();
    failing.state.rows = [row("deploy")];
    failing.deps.cardStatus = vi.fn(async () => {
      throw new Error("ilegível");
    });
    await failing.sweep();
    expect(failing.state.rows.find((r) => r.board === "b2")).toBeTruthy();
    const legacy = world();
    legacy.state.rows = [row("deploy")];
    await legacy.sweep();
    expect(legacy.state.rows.find((r) => r.board === "b2")).toBeTruthy();
  });
});

describe("sweepStalledCards — refaz uma vez, depois avisa", () => {
  it("o relógio é do vigia: a primeira vista só começa a contar; antes dos 15 minutos nada acontece", async () => {
    const { deps, sweep } = world();
    expect(await sweep()).toEqual([{ board: "b", cardId: "story-x", action: "watching" }]);
    expect(await sweep(14)).toEqual([]);
    expect(deps.retry).not.toHaveBeenCalled();
    expect(deps.stamp).not.toHaveBeenCalled();
  });

  it("o caminho inteiro: 15 min ⇒ refaz o passo UMA vez; parou de novo ⇒ conserto + aviso; e nada mais se repete", async () => {
    const { deps, state, sweep } = world();
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "retried" }]);
    expect(deps.retry).toHaveBeenCalledWith("b", "story-x", "promote-and-deploy");
    expect(state.decisions.at(-1)).toMatchObject({ kind: "stall-retry", agent: "system", cardId: "story-x", what: expect.stringMatching(/Refez o passo «Publicar»/) });
    // o relógio recomeça: só depois de MAIS 15 minutos parado é que escala
    expect(await sweep(14)).toEqual([]);
    expect(await sweep(1)).toEqual([{ board: "b", cardId: "story-x", action: "escalated", detail: "story-fix" }]);
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(deps.openFixCard).toHaveBeenCalledTimes(1);
    expect((deps.openFixCard as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatch(/refez o passo uma vez e ele parou de novo/);
    const stamped = (deps.stamp as ReturnType<typeof vi.fn>).mock.calls[0][2] as Finding;
    expect(stamped).toMatchObject({ id: CARD_STALLED_FINDING_ID, status: "open" });
    expect(stamped.detail).toMatch(/card story-fix/);
    expect(state.decisions.at(-1)).toMatchObject({ kind: "stall-fix-card", cardId: "story-fix", undo: { kind: "discard-card", cardId: "story-fix" } });
    // já está no Inbox: mais nenhuma tentativa, mais nenhum card de conserto
    for (let i = 0; i < 4; i++) await sweep(20);
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(deps.openFixCard).toHaveBeenCalledTimes(1);
    expect(deps.stamp).toHaveBeenCalledTimes(1);
  });

  it("passo de passagem: aos 15 minutos a cascata é REAVALIADA (não um efeito refeito); parou de novo ⇒ conserto + aviso", async () => {
    const { deps, state, sweep } = world({ card: cardIn("merge"), mode: "manual" });
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "retried" }]);
    expect(deps.reevaluate).toHaveBeenCalledWith("b", "story-x");
    expect(deps.retry).not.toHaveBeenCalled();
    expect(state.decisions.at(-1)).toMatchObject({ kind: "stall-retry", what: expect.stringMatching(/Refez o passo «Integrar»/) });
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "escalated", detail: "story-fix" }]);
    expect(((deps.stamp as ReturnType<typeof vi.fn>).mock.calls[0][2] as Finding).detail).toMatch(/em «Integrar» sem nada acontecendo.*ninguém trabalhando nele/);
  });

  it("«uma vez» sobrevive a um intervalo com dono: tentou, publicou em voo, parou de novo ⇒ escala, não tenta outra", async () => {
    const { deps, state, sweep } = world();
    await sweep();
    await sweep(15); // refez
    state.card = { ...state.card, deployFiredAt: "2026-03-05T04:51" }; // o deploy da nova tentativa está em voo
    expect(await sweep(5)).toEqual([]);
    expect(state.rows[0]).toMatchObject({ attempts: 1, firstSeenAt: null });
    state.card = { ...state.card, deployFiredAt: undefined }; // …e sumiu sem deixar rastro
    await sweep(5);
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "escalated", detail: "story-fix" }]);
    expect(deps.retry).toHaveBeenCalledTimes(1);
  });

  it("a tentativa é gravada ANTES de agir: uma que lança não vira laço, e fica no registro", async () => {
    const { deps, state, sweep } = world();
    deps.retry = vi.fn(async () => {
      throw new Error("efeito recusou");
    });
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "retried", detail: "efeito recusou" }]);
    expect(state.rows[0].attempts).toBe(1);
    expect(state.decisions.at(-1)?.why).toMatch(/a nova tentativa recusou: efeito recusou/);
    expect(await sweep(15)).toMatchObject([{ action: "escalated" }]);
    expect(deps.retry).toHaveBeenCalledTimes(1);
  });

  it("board de publicação manual: nenhuma tentativa — direto para o conserto e o aviso, dizendo por quê", async () => {
    const { deps, sweep } = world({ mode: "manual" });
    await sweep();
    expect(await sweep(15)).toMatchObject([{ action: "escalated" }]);
    expect(deps.retry).not.toHaveBeenCalled();
    expect(((deps.stamp as ReturnType<typeof vi.fn>).mock.calls[0][2] as Finding).detail).toMatch(/só publica com você/);
  });

  it("máquina ou cota apertadas seguram a TENTATIVA (sem contá-la); o relógio não zera", async () => {
    const { deps, state, sweep } = world({ admission: "janela de 5 horas em 91%" });
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "held", detail: "janela de 5 horas em 91%" }]);
    expect(state.rows[0].attempts).toBe(0);
    state.admission = null;
    expect(await sweep(5)).toMatchObject([{ action: "retried" }]);
    expect(deps.retry).toHaveBeenCalledTimes(1);
  });

  it("o card voltou a ter dono: o aviso sai; parou outra vez: o aviso volta, sem segundo card de conserto", async () => {
    const { deps, state, sweep } = world();
    await sweep();
    await sweep(15);
    await sweep(15); // escalou
    state.facts = { ...FREE, deployRunning: true }; // alguém apertou «tentar de novo»
    expect(await sweep(5)).toEqual([{ board: "b", cardId: "story-x", action: "cleared" }]);
    expect(deps.clear).toHaveBeenCalledWith("b", "story-x");
    state.facts = FREE;
    await sweep(5);
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "restamped" }]);
    expect(deps.openFixCard).toHaveBeenCalledTimes(1);
    expect(((deps.stamp as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[2] as Finding).detail).toMatch(/card story-fix/);
  });

  it("saiu do passo: a linha é história — num passo novo a conta recomeça", async () => {
    const { state, sweep } = world();
    await sweep();
    await sweep(15); // refez em «deploy»
    state.card = { ...state.card, status: "concluida" };
    await sweep(5);
    expect(state.rows).toEqual([]);
    state.card = { ...state.card, status: "release" };
    expect(await sweep(5)).toEqual([{ board: "b", cardId: "story-x", action: "watching" }]);
    expect(state.rows[0]).toMatchObject({ status: "release", attempts: 0 });
  });

  it("condutor morto: nenhum passo é refeito e nenhum card de conserto nasce — só o aviso", async () => {
    const { deps, sweep } = world({ card: conducted(), facts: conductorFacts({ live: false, queued: false }) });
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "escalated" }]);
    expect(deps.retry).not.toHaveBeenCalled();
    expect(deps.openFixCard).not.toHaveBeenCalled();
    expect(((deps.stamp as ReturnType<typeof vi.fn>).mock.calls[0][2] as Finding).title).toBe("O condutor deste card encerrou e ninguém assumiu");
  });

  it("autorun desligado: o vigia não olha nada; card que não é candidato não custa uma leitura de fatos", async () => {
    const off = world({ master: false });
    expect(await off.sweep()).toEqual([]);
    expect(off.deps.facts).not.toHaveBeenCalled();
    const resting = world({ card: cardIn("revisao") });
    expect(await resting.sweep()).toEqual([]);
    expect(resting.deps.facts).not.toHaveBeenCalled();
  });

  it("um erro no meio não derruba quem chama e deixa rastro no log", async () => {
    const { deps, state, sweep } = world();
    deps.boards = async () => {
      throw new Error("disco fora");
    };
    expect(await sweep()).toEqual([]);
    expect(state.lines.join("\n")).toMatch(/a varredura falhou — disco fora/);
  });
});

// O PIPELINE HÍBRIDO: num board com condutor, os passos `autorunOnlyInColumns` não rodam skill — a cascata só os
// atravessa. Um card NÃO conduzido parado ali (o gate do próximo passo falhou, a entrada se perdeu, ou o card já estava
// ali quando o board passou ao condutor) é do sistema: antes o vigia o lia como «fila da skill» e ele ficava ali para
// sempre, sem aviso. Os dois caminhos reais: a story sem aceite na Entrevista, e o refino visual que atravessa Jornada
// e Telas mudas e para no gate do desenho.
describe("pipeline híbrido — passo do meio sem skill neste board é PASSAGEM", () => {
  const interview = { id: "interview", name: "Entrevista", trigger: "harness-interview", autorun: true, autorunOnlyInColumns: true };
  const telas = [
    { id: "design-ui", name: "Telas", trigger: "harness-ui", autorun: true, autorunOnlyInColumns: true },
    { id: "com-design", name: "Aprovar design", gate: "hasWireframe" },
  ];
  // a Entrevista a caminho de «A fazer» (o caso da story sem aceite); Telas a caminho do gate do desenho (o refino)
  const hybrid = (pipeline?: "columns", design = false) =>
    ({
      ...configOf(),
      ...(pipeline ? { pipeline } : {}),
      conductor: { enabled: true, fromStatus: ["pronta"] },
      statuses: [
        ...(design ? telas : [interview]),
        { id: "pronta", name: "A fazer", gate: "hasRefinement" },
        { id: "concluida", name: "No ar", terminal: true },
      ],
    }) as unknown as BoardConfig;

  it("story sem aceite parada na Entrevista: a cascata para no gate, e o vigia a vê (passagem, refazer = reavaliar)", () => {
    const stuck = cardIn("interview", { storyType: "user" });
    expect(decideCascade(stuck, hybrid())).toMatchObject({ action: "stop" });
    expect(isStallCandidate(stuck, hybrid())).toBe(true);
    expect(classifyStall(stuck, hybrid(), FREE, AFTER)).toEqual({ subject: { kind: "passage", stepId: "interview", stepName: "Entrevista" }, autoRetry: true });
    // modo por colunas: a skill do passo roda — é fila de skill, não travamento
    expect(isStallCandidate(stuck, hybrid("columns"))).toBe(false);
    expect(classifyStall(stuck, hybrid("columns"), FREE, AFTER)).toBeNull();
  });

  it("refino visual parado em Telas no gate do desenho: o vigia o vê; com a reabertura pendente, é fila da skill de refino", () => {
    const refine = cardIn("design-ui", { storyType: "user", mode: "refine", narrative: { role: "leitor", want: "achar", soThat: "comprar" }, acceptance: ["a"] });
    expect(decideCascade(refine, hybrid(undefined, true))).toMatchObject({ action: "stop" });
    expect(classifyStall(refine, hybrid(undefined, true), FREE, AFTER)).toMatchObject({ subject: { kind: "passage", stepId: "design-ui" } });
    const pending = cardIn("design-ui", { storyType: "user", mode: "refine", reopenPending: true });
    expect(decideCascade(pending, hybrid(undefined, true))).toEqual({ action: "run", trigger: "harness-refine" });
    expect(classifyStall(pending, hybrid(undefined, true), FREE, AFTER)).toBeNull();
  });

  it("um card conduzido no passo do meio continua com a régua do condutor", () => {
    expect(classifyStall(cardIn("interview", { routing: { driver: "conductor" } }), hybrid(), conductorFacts({ live: false }), AFTER)).toMatchObject({ subject: { kind: "conductor-dead" } });
  });
});

// WP5-F2 — caso real: vários cards em status de condutor (interview/enriquecer/refinar) sem driver, sem fila e sem
// ninguém; o vigia não os via (não eram passo do sistema). E o condutor quieto que a escada do estacionar está tratando
// não vira aviso enquanto ela tem prazo.
describe("status de condutor SEM ator", () => {
  const withConductor = { ...configOf(), conductor: { enabled: true, fromStatus: ["desenvolver"] } } as unknown as BoardConfig;
  const orphan = () => cardIn("desenvolver", { storyType: "technical" });

  it("card no fromStatus sem driver é parado do sistema; com driver, fora do status, ou com alguém nele, não", () => {
    expect(isStallCandidate(orphan(), withConductor)).toBe(true);
    expect(classifyStall(orphan(), withConductor, FREE, AFTER)).toEqual({ subject: { kind: "conductor-unassigned", stepId: "desenvolver", stepName: "Desenvolver" }, autoRetry: true });
    expect(classifyStall(orphan(), configOf(), FREE, AFTER)).toBeNull(); // board sem condutor: é fila da skill
    expect(classifyStall(orphan(), withConductor, { ...FREE, inFlight: true }, AFTER)).toBeNull();
    expect(classifyStall(cardIn("desenvolver", { questions: [{ id: "q1", text: "?", status: "open" }] }), withConductor, FREE, AFTER)).toBeNull();
  });

  it("15 min sem ninguém ⇒ reavalia a ENTRADA (que chama o condutor) uma vez; parou de novo ⇒ conserto + aviso", async () => {
    const { deps, state, sweep } = world({ card: orphan(), mode: "manual" });
    state.config = withConductor;
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "retried" }]);
    expect(deps.reevaluate).toHaveBeenCalledWith("b", "story-x");
    expect(state.decisions.at(-1)).toMatchObject({ kind: "stall-retry", what: expect.stringMatching(/Chamou o condutor/), why: expect.stringMatching(/sem condutor e fora da fila/) });
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "escalated", detail: "story-fix" }]);
    const f = (deps.stamp as ReturnType<typeof vi.fn>).mock.calls[0][2] as Finding;
    expect(f.title).toBe("Parado em «Desenvolver» sem condutor e sem fila");
    expect(f.detail).toMatch(/chamou o condutor de novo uma vez/);
  });

  it("condutor quieto que a escada trata (fila esperando vaga, erro de API): sem aviso enquanto ela tem prazo; depois dele, aviso", () => {
    const grace = 20 * MIN;
    expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: AFTER + grace - 1, ladderGraceMs: grace }), AFTER)).toBeNull();
    expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: AFTER + grace, ladderGraceMs: grace }), AFTER)).toMatchObject({ subject: { kind: "conductor-quiet" } });
  });

  // Revisão do WP5-F2: o filho vivo no pane apagava a quietude na fonte, e o vigia nunca avisava — um dev server esquecido
  // segurava a vaga por horas. Agora o filho só estende o prazo da escada (pela janela dele), e o vigia avisa depois.
  it("filho vivo há 1 h com o transcript parado há 1 h e fila esperando: o vigia avisa (o prazo da escada com o filho já passou)", () => {
    const grace = ladderGraceMs(DEFAULT_PARK_SETTINGS, { transportError: false, slotWaiters: 2, childBusy: true });
    expect(AFTER + grace).toBeLessThanOrEqual(60 * MIN);
    expect(classifyStall(conducted(), configOf(), conductorFacts({ quietForMs: 60 * MIN, ladderGraceMs: grace }), AFTER)).toMatchObject({ subject: { kind: "conductor-quiet" } });
  });
});


// O ESCOPO DE TIPOS (board-pace.ts, T2): a funcionalidade que o board não pode começar espera num passo de condutor SEM
// driver e SEM fila — a adoção de órfãos a nega de propósito. Isso é parada DE PROPÓSITO (como o adiado e o board pausado):
// o vigia não conta o relógio, não refaz o passo e não abre card de conserto.
describe("escopo de tipos — parado DE PROPÓSITO não é travamento", () => {
  const AT = "2026-10-02T12:00:00.000Z";
  const NOW = Date.parse(AT) + 1000;
  const withConductor = { ...configOf(), conductor: { enabled: true, fromStatus: ["desenvolver"] } } as unknown as BoardConfig;
  const feature = (extra: Record<string, unknown> = {}) => cardIn("desenvolver", { storyType: "user", ...extra });
  const fixesRow = (): BoardPaceRow => ({ board: "b", ownerScope: { types: ["bug", "technical", "chore", "spike"], by: { kind: "owner" }, at: AT } });
  const gate = resolveBoardGate({}, fixesRow(), NOW);

  describe("scopeHeldCards — quem o escopo segura", () => {
    it("só o órfão do condutor de tipo fora do escopo: funcionalidade sim; conserto, conduzido e outro passo não", () => {
      const cards = [
        coerceCard("f1", { type: "story", storyType: "user", status: "desenvolver" }, ""),
        coerceCard("f2", { type: "story", status: "desenvolver" }, ""), // sem storyType vale user
        coerceCard("b1", { type: "story", storyType: "bug", status: "desenvolver" }, ""),
        coerceCard("f3", { type: "story", storyType: "user", status: "desenvolver", routing: { driver: "conductor" } }, ""), // já começou
        coerceCard("f4", { type: "story", storyType: "user", status: "deploy" }, ""), // entrega: nunca barrada
      ];
      expect([...scopeHeldCards(cards, withConductor, gate)].sort()).toEqual(["f1", "f2"]);
    });
    it("sem escopo, ou com o conductor desligado no board, ninguém é segurado", () => {
      const cards = [coerceCard("f1", { type: "story", storyType: "user", status: "desenvolver" }, "")];
      expect(scopeHeldCards(cards, withConductor, resolveBoardGate({}, null, NOW)).size).toBe(0);
      expect(scopeHeldCards(cards, configOf(), gate).size).toBe(0);
    });
    it("C10: um card em coluna de CLASSIFICAÇÃO (a skill de especificação roda ali) não entra: o vigia segue valendo", () => {
      const conductorFromSpec = { ...configOf(), conductor: { enabled: true, fromStatus: ["enriquecer", "desenvolver"] } } as unknown as BoardConfig;
      const cards = [
        coerceCard("spec", { type: "story", storyType: "user", status: "enriquecer" }, ""),
        coerceCard("build", { type: "story", storyType: "user", status: "desenvolver" }, ""),
      ];
      expect([...scopeHeldCards(cards, conductorFromSpec, gate)]).toEqual(["build"]);
    });
    it("um `user` em modo `fix` (erro) não é segurado", () => {
      const cards = [coerceCard("f1", { type: "story", storyType: "user", mode: "fix", status: "desenvolver" }, "")];
      expect(scopeHeldCards(cards, withConductor, gate).size).toBe(0);
    });
  });

  it("a funcionalidade segurada pelo escopo: o relógio não conta, nada é refeito, nenhum conserto nasce — por mais que o tempo passe", async () => {
    const { deps, state, sweep } = world({ card: feature(), mode: "manual" });
    state.config = withConductor;
    (deps as { boards: StallWatchDeps["boards"] }).boards = async () => [{ id: "b", config: state.config, cards: [state.card], scopeHeld: new Set(["story-x"]) }];
    expect(await sweep()).toEqual([]);
    for (let i = 0; i < 6; i++) expect(await sweep(60)).toEqual([]);
    expect(deps.reevaluate).not.toHaveBeenCalled();
    expect(deps.openFixCard).not.toHaveBeenCalled();
    expect(deps.stamp).not.toHaveBeenCalled();
    expect(state.rows.every((r) => r.firstSeenAt === null)).toBe(true);
  });

  it("o MESMO card sem o escopo é parado como sempre (a prova de que é o escopo, e não o card)", async () => {
    const { deps, state, sweep } = world({ card: feature(), mode: "manual" });
    state.config = withConductor;
    await sweep();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "retried" }]);
    expect(deps.reevaluate).toHaveBeenCalledWith("b", "story-x");
  });

  it("o escopo ALARGOU: o relógio recomeça do zero (não escala de uma vez por tempo que o card passou esperando de propósito)", async () => {
    const { deps, state, sweep } = world({ card: feature(), mode: "manual" });
    state.config = withConductor;
    const held = new Set(["story-x"]);
    (deps as { boards: StallWatchDeps["boards"] }).boards = async () => [{ id: "b", config: state.config, cards: [state.card], scopeHeld: held }];
    await sweep();
    await sweep(600); // 10 horas esperando de propósito
    held.clear(); // o dono alargou
    expect(await sweep(1)).toEqual([{ board: "b", cardId: "story-x", action: "watching" }]);
    expect(deps.reevaluate).not.toHaveBeenCalled();
    expect(await sweep(15)).toEqual([{ board: "b", cardId: "story-x", action: "retried" }]);
  });

  it("um aviso de «parado» que já estava aberto sai quando o escopo passa a segurar o card", async () => {
    const stalled = feature({ findings: [finding(CARD_STALLED_FINDING_ID)] });
    const { deps, state, sweep } = world({ card: stalled, mode: "manual" });
    state.config = withConductor;
    (deps as { boards: StallWatchDeps["boards"] }).boards = async () => [{ id: "b", config: state.config, cards: [state.card], scopeHeld: new Set(["story-x"]) }];
    expect(await sweep()).toEqual([{ board: "b", cardId: "story-x", action: "cleared" }]);
    expect(deps.clear).toHaveBeenCalledWith("b", "story-x");
  });

  it("o card JÁ conduzido (começou antes de o escopo estreitar) continua sob vigia: condutor morto é aviso de verdade", () => {
    const c = feature({ routing: { driver: "conductor" } });
    expect(classifyStall(c, withConductor, conductorFacts({ live: false, queued: false }), AFTER)).toMatchObject({ subject: { kind: "conductor-dead" } });
  });
});

// ── fase 7: o LOTE do condutor — nenhum «condutor encerrou» falso para um item, e um aviso só quando o lote acaba ──
describe("fase 7 — lote do condutor no vigia de card parado", () => {
  const BATCH = { id: "lote-a", lead: "story-ex9101", sessionId: "lote-1", at: "2026-03-05T04:00:00Z" };
  const batchCard = (id: string, title: string, extra: Partial<Card> = {}): Card => ({
    ...coerceCard(id, { type: "story", storyType: "bug", title, status: "desenvolver", routing: { driver: "conductor" } }, ""),
    batch: BATCH,
    ...extra,
  });
  const lead = batchCard("story-ex9101", "Corrigir o filtro de datas");
  const itemA = batchCard("story-ex9102", "Ajustar o rótulo do filtro");
  const itemB = batchCard("story-ex9103", "Manter o filtro ao voltar");
  const cards = [lead, itemA, itemB];
  const board = { id: "b", cards, config: configOf() };
  const session: AgentSession = {
    sessionId: "lote-1",
    agentId: "lote-1",
    role: "implement",
    task: "conduzir o lote",
    board: "b",
    cardId: lead.id,
    driver: "conductor",
    tmuxSession: "cond-lote",
    openedAt: "2026-03-05T04:00:00Z",
    heartbeatAt: "2026-03-05T04:00:00Z",
    batch: { id: "lote-a", featureKey: "func-a", cardIds: [itemA.id, itemB.id], dropped: [] },
  };
  const alive = () => true;
  const dead = () => false;

  it("um ITEM de um lote vivo acha a sessão do lote: nada de «condutor encerrou» falso", () => {
    const hold = conductorHold(itemA, board, [session], [], alive);
    expect(hold).toMatchObject({ session: { sessionId: "lote-1" }, queued: false, foldedIntoLead: false });
    // os fatos do vigia para o item: vivo ⇒ nenhum veredito
    expect(classifyStall(itemA, configOf(), conductorFacts({ live: !!hold.session, queued: hold.queued }), AFTER)).toBeNull();
  });

  it("o item que SAIU do lote não é mais da sessão", () => {
    const dropped = { ...session, batch: { ...session.batch!, dropped: [{ cardId: itemB.id, reason: "falhou", at: "2026-03-05T04:10:00Z" }] } };
    expect(conductorSessionFor([dropped], "b", itemB.id, alive)).toBeUndefined();
    expect(conductorSessionFor([dropped], "b", itemA.id, alive)?.sessionId).toBe("lote-1");
  });

  it("o item levado pela entrada do líder na fila (retomada do train) tem lugar na fila", () => {
    const queue = [{ board: "b", cardId: lead.id, handoff: { runId: "lote-1", status: "done", batchCardIds: [itemA.id] } }];
    expect(queuedForConductor(queue, "b", itemA.id)).toBe(true);
    expect(queuedForConductor(queue, "b", itemB.id)).toBe(false);
    expect(conductorHold(itemA, board, [], queue, dead)).toMatchObject({ queued: true, foldedIntoLead: false });
  });

  it("a entrega do lote ainda no train (passagem sem veredito) conta como alguém no item", () => {
    const pending = [{ board: "b", cardId: lead.id, runId: "lote-1" }];
    expect(batchHandoffPending(pending, "b", itemA)).toBe(true);
    expect(batchHandoffPending([{ ...pending[0], verdict: { status: "done" } }], "b", itemA)).toBe(false);
    expect(batchHandoffPending(pending, "b", { batch: undefined })).toBe(false);
    expect(batchHandoffPending(pending, "other", itemA)).toBe(false);
  });

  it("sessão do lote MORTA: o líder é «condutor encerrou» e cada item entra no aviso dele (sem veredito próprio)", () => {
    expect(conductorHold(lead, board, [session], [], dead)).toMatchObject({ session: undefined, queued: false, foldedIntoLead: false });
    for (const item of [itemA, itemB]) expect(conductorHold(item, board, [session], [], dead)).toMatchObject({ foldedIntoLead: true });
  });

  it("o item NÃO entra no aviso do líder quando o líder tem dono, saiu do lote, foi devolvido ao fluxo ou terminou", () => {
    const other: AgentSession = { ...session, sessionId: "novo", agentId: "novo", batch: undefined };
    expect(conductorHold(itemA, board, [other], [], alive).foldedIntoLead).toBe(false); // condutor novo só no líder
    expect(conductorHold(itemA, board, [], [{ board: "b", cardId: lead.id }], dead).foldedIntoLead).toBe(false);
    const variants: Card[] = [
      { ...lead, batch: undefined },
      { ...lead, routing: undefined },
      { ...lead, status: "concluida" },
    ];
    for (const l of variants) expect(batchItemFoldsIntoLead(itemA, [l, itemA], configOf(), () => false)).toBe(false);
    expect(batchItemFoldsIntoLead(lead, cards, configOf(), () => false)).toBe(false); // o líder carrega o aviso
  });

  it("o aviso do líder NOMEIA os itens que esperam junto; sem lote, o aviso fica como está", () => {
    const base = stalledFinding({ kind: "conductor-dead", stepId: "desenvolver", stepName: "Desenvolver" }, { since: "04h20", retried: false, autoRetry: false, fixCardId: null });
    const items = batchItemsWaiting(lead, cards);
    expect(items.map((i) => i.id)).toEqual([itemA.id, itemB.id]);
    const f = withBatchItems(base, items);
    expect(f.detail).toContain(base.detail);
    expect(f.detail).toContain("«Ajustar o rótulo do filtro» (story-ex9102) e «Manter o filtro ao voltar» (story-ex9103)");
    expect(f.detail).toContain("esperam junto com ele");
    expect(batchItemsWaiting(itemA, cards)).toEqual([]); // só o líder nomeia
    expect(withBatchItems(base, [])).toBe(base);
    expect(withBatchItems(base, [items[0]]).detail).toContain("o item «Ajustar o rótulo do filtro» (story-ex9102) depende");
  });

  it("de ponta a ponta: a sessão do lote morre ⇒ UM aviso no Inbox, no líder, nomeando os dois itens; os itens não ganham aviso", async () => {
    const state = { cards: [...cards], rows: [] as StallRow[], now: Date.parse("2026-03-05T04:35:00Z"), stamped: [] as Array<{ cardId: string; f: Finding }> };
    const deps: StallWatchDeps = {
      ledger: { load: async () => state.rows, persist: async (rows) => void (state.rows = rows) },
      masterEnabled: () => true,
      settings: () => ({ afterMinutes: 15, retries: 1 }),
      admission: () => null,
      boards: async () => [{ id: "b", config: configOf(), cards: state.cards }],
      // os fatos do conduzido, montados pela MESMA régua do vigia de produção (conductorHold), com a sessão do lote morta
      facts: async (b, card) => {
        const hold = conductorHold(card, b, [session], [], dead);
        return hold.foldedIntoLead ? FREE : conductorFacts({ live: !!hold.session, queued: hold.queued });
      },
      retry: async () => ({ ok: true }),
      reevaluate: async () => ({ ok: true }),
      openFixCard: async () => null,
      // o `stamp` de produção: o aviso do líder ganha os itens do lote
      stamp: async (_b, cardId, f) => {
        const stamped = withBatchItems(f, batchItemsWaiting(state.cards.find((c) => c.id === cardId), state.cards));
        state.stamped.push({ cardId, f: stamped });
      },
      clear: async () => {},
      record: async () => {},
      clock: () => "04h35",
      now: () => state.now,
      log: () => {},
    };
    await sweepStalledCards(deps);
    state.now += AFTER;
    const out = await sweepStalledCards(deps);
    expect(out.filter((r) => r.action === "escalated").map((r) => r.cardId)).toEqual([lead.id]);
    expect(state.stamped).toHaveLength(1);
    expect(state.stamped[0].cardId).toBe(lead.id);
    expect(state.stamped[0].f.title).toBe("O condutor deste card encerrou e ninguém assumiu");
    expect(state.stamped[0].f.detail).toContain(itemA.id);
    expect(state.stamped[0].f.detail).toContain(itemB.id);
  });
});
