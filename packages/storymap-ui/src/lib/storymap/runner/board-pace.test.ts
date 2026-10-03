import { describe, expect, it } from "vitest";
import {
  applyPaceChange,
  configOnlyGate,
  effectivePaceLevel,
  effectivePauseMode,
  expirePace,
  gateOf,
  holdInForce,
  holdPaceEntry,
  PACE_HELD_MAX,
  PACE_HISTORY_MAX,
  paceCap,
  paceChangeRefusal,
  paceInputRefusal,
  paceSuggestion,
  paceViewOf,
  parsePaceFile,
  resolveBoardGate,
  serializePaceFile,
  type BoardPaceRow,
  type PaceActor,
  type PaceHold,
  type PaceLevel,
} from "./board-pace";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER: PaceActor = { kind: "owner" };
const AGENT: PaceActor = { kind: "agent", id: "TOKEN_ORCH" };
const ARMED = {};
const hold = (by: PaceActor, level: PaceHold["level"] = "paused", over: Partial<PaceHold> = {}): PaceHold => ({ level, by, at: iso(NOW - 60_000), ...over });
/** o freio do dono */
const byOwner = (level: PaceHold["level"] = "paused", over: Partial<PaceHold> = {}): BoardPaceRow => ({ board: "acme", owner: hold(OWNER, level, over) });
/** o freio dos agentes */
const byAgent = (level: PaceHold["level"] = "paused", over: Partial<PaceHold> = {}): BoardPaceRow => ({ board: "acme", agent: hold(AGENT, level, over) });
const ask = (level: PaceLevel, by: PaceActor, over: Partial<{ reason: string; forMinutes: number; mode: "drain" | "stop" }> = {}) => ({ board: "acme", level, by, ...over });

describe("o portão do board — resolveBoardGate", () => {
  it("sem linha e armado: ritmo normal, nada segurado, os de fundo rodam", () => {
    expect(resolveBoardGate(ARMED, null, NOW)).toMatchObject({ level: "normal", held: false, background: true, source: "default" });
  });

  it("desarmado segura tudo — e vence qualquer linha de ritmo", () => {
    const g = resolveBoardGate({ autorunDisabled: true }, { board: "acme" }, NOW);
    expect(g).toMatchObject({ level: "paused", held: true, background: false, source: "disarmed" });
    expect(configOnlyGate({ autorunDisabled: true }).held).toBe(true);
    expect(configOnlyGate({}).held).toBe(false);
  });

  it("configuração ilegível segura (a direção segura)", () => {
    expect(resolveBoardGate(null, null, NOW)).toMatchObject({ held: true, source: "unreadable" });
  });

  it("registro de ritmo ILEGÍVEL segura todo board — ilegível não é «sem pausa»", () => {
    expect(resolveBoardGate(ARMED, null, NOW, true)).toMatchObject({ level: "paused", held: true, source: "unreadable" });
  });

  it("pausado segura; devagar não segura, mas desliga os de fundo; a frase diz quem pôs", () => {
    expect(resolveBoardGate(ARMED, byOwner("paused"), NOW)).toMatchObject({ held: true, background: false, source: "pace", why: "board pausado pelo dono" });
    expect(resolveBoardGate(ARMED, byAgent("slow"), NOW)).toMatchObject({ held: false, background: false, why: "board em ritmo devagar por um agente" });
  });

  it("DUAS CAMADAS: vale o freio mais lento; no empate, o do dono", () => {
    const both: BoardPaceRow = { board: "acme", owner: hold(OWNER, "slow"), agent: hold(AGENT, "paused") };
    expect(effectivePaceLevel(both, NOW)).toBe("paused");
    expect(holdInForce(both, NOW)?.by.kind).toBe("agent");
    const tie: BoardPaceRow = { board: "acme", owner: hold(OWNER, "paused"), agent: hold(AGENT, "paused") };
    expect(holdInForce(tie, NOW)?.by.kind).toBe("owner");
    const ownerSlower: BoardPaceRow = { board: "acme", owner: hold(OWNER, "paused"), agent: hold(AGENT, "slow") };
    expect(holdInForce(ownerSlower, NOW)?.by.kind).toBe("owner");
  });

  it("o prazo vencido já conta como retomado, antes de a varredura gravar", () => {
    expect(effectivePaceLevel(byOwner("paused", { until: iso(NOW - 1) }), NOW)).toBe("normal");
    expect(effectivePaceLevel(byOwner("paused", { until: iso(NOW - 1), resumeTo: "slow" }), NOW)).toBe("slow");
    expect(effectivePaceLevel(byOwner("paused", { until: iso(NOW + 1) }), NOW)).toBe("paused");
    expect(resolveBoardGate(ARMED, byOwner("paused", { until: iso(NOW - 1) }), NOW).held).toBe(false);
    // o freio do agente vence e o do dono continua
    const both: BoardPaceRow = { board: "acme", owner: hold(OWNER, "slow"), agent: hold(AGENT, "paused", { until: iso(NOW - 1) }) };
    expect(effectivePaceLevel(both, NOW)).toBe("slow");
  });

  it("o modo da pausa em vigor é «parar agora» se algum freio que pausa pediu", () => {
    expect(effectivePauseMode(byOwner("paused", { mode: "drain" }), NOW)).toBe("drain");
    expect(effectivePauseMode({ board: "acme", owner: hold(OWNER, "paused", { mode: "drain" }), agent: hold(AGENT, "paused", { mode: "stop" }) }, NOW)).toBe("stop");
    expect(effectivePauseMode(byOwner("slow"), NOW)).toBeNull();
  });

  it("gateOf: sem a porta injetada, só a configuração responde", () => {
    expect(gateOf(undefined, "acme", { autorunDisabled: true }).source).toBe("disarmed");
    expect(gateOf(() => resolveBoardGate(ARMED, byOwner(), NOW), "acme", ARMED).source).toBe("pace");
  });

  it("paceCap: normal mantém, devagar vira um por vez, pausado zera", () => {
    expect(paceCap(3, resolveBoardGate(ARMED, null, NOW))).toBe(3);
    expect(paceCap(3, resolveBoardGate(ARMED, byOwner("slow"), NOW))).toBe(1);
    expect(paceCap(3, resolveBoardGate(ARMED, byOwner(), NOW))).toBe(0);
  });
});

describe("quem pode mudar o ritmo — paceChangeRefusal", () => {
  const refuse = (r: BoardPaceRow | null, next: PaceLevel, actor: PaceActor, config: { autorunDisabled?: boolean } = ARMED, unreadable = false) =>
    paceChangeRefusal(resolveBoardGate(config, r, NOW, unreadable), r, next, actor, NOW);

  it("desacelerar é de todos: o agente pausa e reduz um board em qualquer ritmo", () => {
    expect(refuse(null, "paused", AGENT)).toBeNull();
    expect(refuse(null, "slow", AGENT)).toBeNull();
    expect(refuse(byOwner("slow"), "paused", AGENT)).toBeNull();
  });

  it("o agente NÃO retoma nem acelera além do que o dono fixou", () => {
    expect(refuse(byOwner("paused"), "normal", AGENT)).toMatch(/só ele retoma/);
    expect(refuse(byOwner("paused"), "slow", AGENT)).toMatch(/só ele retoma/);
    expect(refuse(byOwner("slow"), "normal", AGENT)).toMatch(/«Devagar»/);
  });

  it("o agente desfaz o freio que um AGENTE pôs — até o limite do dono; o dono desfaz qualquer um", () => {
    expect(refuse(byAgent("paused"), "normal", AGENT)).toBeNull();
    expect(refuse(byAgent("paused"), "normal", OWNER)).toBeNull();
    expect(refuse(byOwner("paused"), "normal", OWNER)).toBeNull();
    const ownerSlowAgentPaused: BoardPaceRow = { board: "acme", owner: hold(OWNER, "slow"), agent: hold(AGENT, "paused") };
    expect(refuse(ownerSlowAgentPaused, "slow", AGENT)).toBeNull(); // volta ao que o dono fixou
    expect(refuse(ownerSlowAgentPaused, "normal", AGENT)).toMatch(/só ele retoma/);
  });

  it("o freio do dono com prazo VENCIDO não limita mais o agente", () => {
    const row: BoardPaceRow = { board: "acme", owner: hold(OWNER, "paused", { until: iso(NOW - 1) }), agent: hold(AGENT, "paused") };
    expect(refuse(row, "normal", AGENT)).toBeNull();
  });

  it("board desarmado não é acelerado por mudança de ritmo — nem pelo dono (armar é um gesto à parte)", () => {
    expect(refuse(null, "normal", OWNER, { autorunDisabled: true })).toMatch(/desarmado/);
    expect(refuse(null, "paused", AGENT, { autorunDisabled: true })).toBeNull(); // pausar um desarmado não acelera nada
  });

  it("registro ilegível: o agente não grava NADA (regravar soltaria os outros boards); o dono regrava", () => {
    expect(refuse(null, "paused", AGENT, ARMED, true)).toMatch(/só o dono/);
    expect(refuse(null, "normal", AGENT, ARMED, true)).toMatch(/só o dono/);
    expect(refuse(null, "normal", OWNER, ARMED, true)).toBeNull();
    expect(refuse(null, "paused", OWNER, ARMED, true)).toBeNull();
  });
});

describe("o pedido — paceInputRefusal", () => {
  it("aceita o pedido comum e recusa o malformado, com a frase", () => {
    expect(paceInputRefusal(ask("paused", OWNER, { mode: "stop", forMinutes: 60, reason: "noite" }))).toBeNull();
    expect(paceInputRefusal(ask("slow", OWNER, { forMinutes: 30 }))).toBeNull();
    expect(paceInputRefusal(ask("rápido" as never, OWNER))).toMatch(/Ritmo desconhecido/);
    expect(paceInputRefusal(ask("normal", OWNER, { forMinutes: 10 }))).toMatch(/prazo vale para pausar/);
    expect(paceInputRefusal(ask("paused", OWNER, { forMinutes: 0 }))).toMatch(/maior que zero/);
    expect(paceInputRefusal(ask("paused", OWNER, { forMinutes: 60 * 24 * 31 }))).toMatch(/30 dias/);
    expect(paceInputRefusal(ask("slow", OWNER, { mode: "stop" }))).toMatch(/só vale para a pausa/);
    expect(paceInputRefusal(ask("paused", OWNER, { reason: "x".repeat(301) }))).toMatch(/300 caracteres/);
  });
});

describe("a mudança — applyPaceChange", () => {
  it("o agente pausa um board normal: grava no freio DOS AGENTES quem, quando, o motivo e o modo (padrão: deixar terminar)", () => {
    const r = applyPaceChange(null, ask("paused", AGENT, { reason: "  cota apertada  " }), NOW);
    expect(r).toMatchObject({ changed: true, level: "paused", mode: "drain", enteredPause: true, stopNow: false });
    expect(r.row.agent).toEqual({ level: "paused", by: AGENT, at: iso(NOW), reason: "cota apertada", mode: "drain" });
    expect(r.row.owner).toBeUndefined();
    expect(r.row.history).toHaveLength(1);
  });

  it("A BRECHA FECHADA: o agente que re-pausa por cima da pausa do dono NÃO vira o autor nem mexe no freio do dono", () => {
    const owned = byOwner("paused", { mode: "drain", reason: "decisão minha" });
    const r = applyPaceChange(owned, ask("paused", AGENT, { mode: "stop", forMinutes: 5, reason: "economia" }), NOW);
    expect(r.row.owner).toEqual(owned.owner); // intocado: nem prazo, nem modo, nem motivo, nem autor
    expect(r.row.agent).toMatchObject({ level: "paused", mode: "stop", until: iso(NOW + 300_000) });
    expect(r.stopNow).toBe(true); // apertar é permitido: a pausa virou «parar agora»
    // …e quando o freio do agente vence, o board continua pausado pelo dono
    const later = NOW + 600_000;
    expect(effectivePaceLevel(r.row, later)).toBe("paused");
    expect(paceChangeRefusal(resolveBoardGate(ARMED, r.row, later), r.row, "normal", AGENT, later)).toMatch(/só ele retoma/);
  });

  it("o agente que pede normal só tira o freio DELE: o do dono fica", () => {
    const row: BoardPaceRow = { board: "acme", owner: hold(OWNER, "slow"), agent: hold(AGENT, "paused") };
    const r = applyPaceChange(row, ask("slow", AGENT), NOW);
    expect(r.level).toBe("slow");
    expect(r.row.owner).toEqual(row.owner);
  });

  it("o dono manda nas duas camadas: a escolha dele substitui o freio dele e apaga o dos agentes", () => {
    const agentPaused = byAgent("paused", { reason: "economia" });
    const takeover = applyPaceChange(agentPaused, ask("paused", OWNER), NOW);
    expect(takeover.changed).toBe(true); // o dono apertou «Pausado» num board pausado por agente: agora a pausa é dele
    expect(takeover.row.owner?.by).toEqual(OWNER);
    expect(takeover.row.agent).toBeUndefined();
    const resume = applyPaceChange({ board: "acme", owner: hold(OWNER, "slow"), agent: hold(AGENT, "paused") }, ask("normal", OWNER), NOW);
    expect(resume.level).toBe("normal");
    expect(resume.row.owner).toBeUndefined();
    expect(resume.row.agent).toBeUndefined();
  });

  it("«parar agora» pede para parar o que roda — e trocar de deixar-terminar para parar-agora também", () => {
    expect(applyPaceChange(null, ask("paused", OWNER, { mode: "stop" }), NOW)).toMatchObject({ enteredPause: true, stopNow: true });
    expect(applyPaceChange(byOwner("paused", { mode: "drain" }), ask("paused", OWNER, { mode: "stop" }), NOW)).toMatchObject({ changed: true, enteredPause: false, stopNow: true });
    expect(applyPaceChange(byOwner("paused", { mode: "stop" }), ask("paused", OWNER, { mode: "stop" }), NOW)).toMatchObject({ changed: false, stopNow: false });
  });

  it("pedir o ritmo que já está em vigor não grava — e não apaga o motivo", () => {
    expect(applyPaceChange(null, ask("normal", OWNER), NOW).changed).toBe(false);
    const paused = byAgent("paused", { mode: "drain", reason: "cota" });
    const again = applyPaceChange(paused, ask("paused", AGENT), NOW);
    expect(again.changed).toBe(false);
    expect(again.row).toBe(paused);
  });

  it("pausa com prazo sobre um board devagar volta a devagar; sobre um board normal, volta a normal", () => {
    const fromSlow = applyPaceChange(byOwner("slow"), ask("paused", OWNER, { forMinutes: 60 }), NOW);
    expect(fromSlow.row.owner).toMatchObject({ level: "paused", until: iso(NOW + 3_600_000), resumeTo: "slow" });
    expect(effectivePaceLevel(fromSlow.row, NOW + 3_600_001)).toBe("slow");
    const fromNormal = applyPaceChange(null, ask("paused", OWNER, { forMinutes: 60 }), NOW);
    expect(fromNormal.row.owner?.resumeTo).toBeUndefined();
    expect(effectivePaceLevel(fromNormal.row, NOW + 3_600_001)).toBe("normal");
    const slowFor = applyPaceChange(null, ask("slow", OWNER, { forMinutes: 30 }), NOW);
    expect(slowFor.row.owner).toMatchObject({ level: "slow", until: iso(NOW + 1_800_000) });
  });

  it("sair da pausa DEVOLVE o que ela segurou; seguir pausado mantém", () => {
    const held = [{ cardId: "c1", why: "stopped" as const, at: iso(NOW - 1000) }];
    const paused: BoardPaceRow = { ...byOwner("paused", { mode: "drain" }), held };
    const resumed = applyPaceChange(paused, ask("normal", OWNER), NOW);
    expect(resumed.released).toEqual(held);
    expect(resumed.row.held).toBeUndefined();
    expect(applyPaceChange(paused, ask("slow", OWNER), NOW).released).toEqual(held);
    const again = applyPaceChange(paused, ask("paused", OWNER, { mode: "stop" }), NOW);
    expect(again.released).toEqual([]);
    expect(again.row.held).toEqual(held);
    // o agente tira o freio dele, mas o dono segue pausando: nada é devolvido
    const both: BoardPaceRow = { board: "acme", owner: hold(OWNER, "paused"), agent: hold(AGENT, "paused", { mode: "stop" }), held };
    const agentLifts = applyPaceChange(both, ask("paused", AGENT, { mode: "drain" }), NOW);
    expect(agentLifts.released).toEqual([]);
    expect(agentLifts.row.held).toEqual(held);
  });

  it("entre o prazo vencer e a varredura gravar, nenhuma entrada retida se perde", () => {
    const held = [{ cardId: "c1", why: "entry" as const, at: iso(NOW - 1000) }];
    const expired: BoardPaceRow = { ...byOwner("paused", { until: iso(NOW - 1) }), held };
    expect(applyPaceChange(expired, ask("slow", OWNER), NOW).released).toEqual(held);
    expect(applyPaceChange(expired, ask("paused", OWNER), NOW).row.held).toEqual(held);
  });

  it("o histórico guarda só as mudanças mais recentes", () => {
    let r: BoardPaceRow | null = null;
    for (let i = 0; i < PACE_HISTORY_MAX + 5; i += 1) r = applyPaceChange(r, ask(i % 2 ? "normal" : "paused", OWNER), NOW + i).row;
    expect(r?.history).toHaveLength(PACE_HISTORY_MAX);
  });
});

describe("o prazo — expirePace", () => {
  it("sem prazo vencido: null", () => {
    expect(expirePace(byOwner(), NOW)).toBeNull();
    expect(expirePace(byOwner("paused", { until: iso(NOW + 1) }), NOW)).toBeNull();
  });

  it("vencido: o freio sai (ou afrouxa para devagar), devolve o que segurou e registra no histórico que foi o prazo", () => {
    const held = [{ cardId: "c1", why: "entry" as const, at: iso(NOW - 1000) }];
    const e = expirePace({ ...byOwner("paused", { until: iso(NOW - 1), resumeTo: "slow" }), held }, NOW);
    expect(e).toMatchObject({ level: "slow", faster: true });
    expect(e?.row.owner).toMatchObject({ level: "slow" });
    expect(e?.row.owner?.until).toBeUndefined();
    expect(e?.row.held).toBeUndefined();
    expect(e?.released).toEqual(held);
    expect(e?.row.history?.at(-1)).toMatchObject({ level: "slow", expired: true });
    const gone = expirePace(byAgent("paused", { until: iso(NOW - 1) }), NOW);
    expect(gone).toMatchObject({ level: "normal", faster: true });
    expect(gone?.row.agent).toBeUndefined();
  });

  it("vence o freio do agente e o do dono segue pausando: nada é devolvido", () => {
    const held = [{ cardId: "c1", why: "stopped" as const, at: iso(NOW - 1000) }];
    const e = expirePace({ board: "acme", owner: hold(OWNER, "paused"), agent: hold(AGENT, "paused", { until: iso(NOW - 1) }), held }, NOW);
    expect(e).toMatchObject({ level: "paused", faster: false, released: [] });
    expect(e?.row.held).toEqual(held);
    expect(e?.row.agent).toBeUndefined();
  });
});

describe("o que a pausa segura — holdPaceEntry", () => {
  const at = iso(NOW);
  it("uma entrada por card; `stopped` vence `entry`; fora da pausa nada é guardado", () => {
    let r = holdPaceEntry(byOwner(), { cardId: "c1", why: "entry", at }, NOW);
    r = holdPaceEntry(r, { cardId: "c1", why: "entry", at }, NOW);
    expect(r.held).toHaveLength(1);
    r = holdPaceEntry(r, { cardId: "c1", why: "stopped", at }, NOW);
    expect(r.held).toEqual([{ cardId: "c1", why: "stopped", at }]);
    r = holdPaceEntry(r, { cardId: "c1", why: "entry", at }, NOW);
    expect(r.held?.[0].why).toBe("stopped");
    const slow = byOwner("slow");
    expect(holdPaceEntry(slow, { cardId: "c2", why: "entry", at }, NOW)).toBe(slow);
    const expired = byOwner("paused", { until: iso(NOW - 1) });
    expect(holdPaceEntry(expired, { cardId: "c3", why: "entry", at }, NOW)).toBe(expired);
  });

  it("tem teto: um board pausado por dias não cresce sem fim", () => {
    let r = byOwner();
    for (let i = 0; i < PACE_HELD_MAX + 10; i += 1) r = holdPaceEntry(r, { cardId: `c${i}`, why: "entry", at }, NOW);
    expect(r.held).toHaveLength(PACE_HELD_MAX);
  });
});

describe("o arquivo — parsePaceFile", () => {
  it("vai e volta", () => {
    const rows: BoardPaceRow[] = [
      {
        board: "acme",
        owner: hold(OWNER, "paused", { reason: "noite", until: iso(NOW + 1000), resumeTo: "slow", mode: "stop" }),
        agent: hold(AGENT, "slow"),
        held: [{ cardId: "c1", why: "entry", at: iso(NOW) }],
        history: [{ level: "paused", by: AGENT, at: iso(NOW) }],
      },
      { board: "other", history: [{ level: "normal", by: OWNER, at: iso(NOW) }] },
    ];
    expect(parsePaceFile(serializePaceFile(rows))).toEqual(rows);
  });

  it("o que não se lê com rigor é null — nunca «vazio»", () => {
    const file = (rows: unknown) => JSON.stringify({ version: 1, rows });
    expect(parsePaceFile("{")).toBeNull();
    expect(parsePaceFile(JSON.stringify({ version: 99, rows: [] }))).toBeNull();
    expect(parsePaceFile(file("x"))).toBeNull();
    expect(parsePaceFile(file([{ owner: hold(OWNER) }]))).toBeNull(); // sem board
    expect(parsePaceFile(file([{ board: "acme", owner: { ...hold(OWNER), level: "voando" } }]))).toBeNull();
    expect(parsePaceFile(file([{ board: "acme", owner: { ...hold(OWNER), by: { kind: "x" } } }]))).toBeNull();
    expect(parsePaceFile(file([{ board: "acme", owner: { ...hold(OWNER), until: "amanhã" } }]))).toBeNull();
    // um freio na camada errada é ilegível: o freio do dono só o dono assina
    expect(parsePaceFile(file([{ board: "acme", owner: hold(AGENT) }]))).toBeNull();
    expect(parsePaceFile(file([]))).toEqual([]);
  });
});

describe("a projeção e a sugestão", () => {
  it("a tela e a tool leem a mesma coisa: ritmo, quem, desde, até, o limite do dono, quantos esperam, histórico do mais novo ao mais velho", () => {
    const r: BoardPaceRow = {
      board: "acme",
      owner: hold(OWNER, "slow"),
      agent: hold(AGENT, "paused", { reason: "cota", until: iso(NOW + 3_600_000), mode: "stop" }),
      held: [
        { cardId: "c1", why: "stopped", at: iso(NOW) },
        { cardId: "c2", why: "entry", at: iso(NOW) },
      ],
      history: [
        { level: "slow", by: OWNER, at: iso(NOW - 5000) },
        { level: "paused", by: AGENT, at: iso(NOW - 1000) },
      ],
    };
    const v = paceViewOf("acme", ARMED, { rows: [r], unreadable: false }, NOW, null);
    expect(v).toMatchObject({ level: "paused", label: "Pausado", held: true, source: "pace", by: AGENT, reason: "cota", until: r.agent?.until, mode: "stop", ownerLimit: "slow", waiting: 2, suggestion: null });
    expect(v.history.map((h) => h.level)).toEqual(["paused", "slow"]);
  });

  it("com o prazo vencido a linha já não fala por «quem pôs»", () => {
    const v = paceViewOf("acme", ARMED, { rows: [byOwner("paused", { until: iso(NOW - 1) })], unreadable: false }, NOW, null);
    expect(v).toMatchObject({ level: "normal", by: null, since: null, until: null, ownerLimit: null, waiting: 0 });
  });

  it("desarmado e ilegível não têm «quem»", () => {
    expect(paceViewOf("acme", { autorunDisabled: true }, { rows: [byOwner()], unreadable: false }, NOW, null)).toMatchObject({ source: "disarmed", held: true, by: null, ownerLimit: null });
    expect(paceViewOf("acme", ARMED, { rows: [], unreadable: true }, NOW, null)).toMatchObject({ source: "unreadable", held: true, by: null });
  });

  it("a sugestão só sai com leitura real da cota, fora do ritmo, e com o board em normal", () => {
    const normal = resolveBoardGate(ARMED, null, NOW);
    expect(paceSuggestion(normal, null)).toBeNull();
    expect(paceSuggestion(normal, { onPace: true, detail: "ok" })).toBeNull();
    expect(paceSuggestion(normal, { onPace: false, detail: "a semana já consumiu 80% da cota com 50% do tempo decorrido" })).toEqual({
      level: "slow",
      why: "a semana já consumiu 80% da cota com 50% do tempo decorrido",
    });
    expect(paceSuggestion(resolveBoardGate(ARMED, byOwner("slow"), NOW), { onPace: false, detail: "x" })).toBeNull();
  });
});
