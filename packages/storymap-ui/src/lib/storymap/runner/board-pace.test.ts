import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  applyPaceChange,
  applyScopeChange,
  configOnlyGate,
  effectiveScope,
  FIXES_ONLY_TYPES,
  featuresInDelivery,
  gateAdmitsCard,
  holdScopeEntry,
  isNewFeatureCard,
  liveScope,
  normalizeScopeTypes,
  PACE_FILE_VERSION,
  PACE_FILE_VERSION_SCOPE,
  paceFileVersionOf,
  rowExpired,
  SCOPE_BUILD_STATUSES,
  SCOPE_CLASSIFYING_STATUSES,
  SCOPE_DELIVERY_STATUSES,
  SCOPE_FINISHING_STATUSES,
  SCOPE_TYPE_ORDER,
  SCOPE_TYPE_WORDS,
  SCOPE_WAITING_STATUSES,
  scopeAdmitsCard,
  scopeChangeRefusal,
  scopeGatesStatus,
  scopeHoldStatuses,
  scopeInputRefusal,
  scopeNarrowed,
  scopePresetOf,
  scopeTypesOf,
  scopeTypesPhrase,
  scopeWaitingCount,
  scopeWidened,
  storyTypeChangeLine,
  storyTypeChangeRefusal,
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
  type PaceScope,
  type ScopeCard,
  type ScopeChange,
} from "./board-pace";
import type { StoryType } from "@/lib/storymap/frameworks";

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

// ══ O ESCOPO DE TIPOS — o segundo eixo (independente do ritmo) ═══════════════════════════════════════

const scopeLayer = (by: PaceActor, types: StoryType[], over: Partial<PaceScope> = {}): PaceScope => ({ types: normalizeScopeTypes(types), by, at: iso(NOW - 60_000), ...over });
/** o escopo do dono */
const ownerScoped = (types: StoryType[], over: Partial<PaceScope> = {}): BoardPaceRow => ({ board: "acme", ownerScope: scopeLayer(OWNER, types, over) });
/** o escopo dos agentes */
const agentScoped = (types: StoryType[], over: Partial<PaceScope> = {}): BoardPaceRow => ({ board: "acme", agentScope: scopeLayer(AGENT, types, over) });
const FIXES = [...FIXES_ONLY_TYPES];
const card = (over: Partial<ScopeCard> = {}): ScopeCard => ({ id: "story-ex9901", type: "story", storyType: "user", mode: "build", status: "desenvolver", ...over });
const askScope = (types: ScopeChange["types"], by: PaceActor, over: Partial<ScopeChange> = {}): ScopeChange => ({ board: "acme", types, by, ...over });
const refuseScope = (r: BoardPaceRow | null, types: ScopeChange["types"], actor: PaceActor, config: { autorunDisabled?: boolean } = ARMED, unreadable = false) =>
  scopeChangeRefusal(resolveBoardGate(config, r, NOW, unreadable), r, types, actor, NOW);

describe("o escopo em vigor — effectiveScope (a INTERSEÇÃO das camadas)", () => {
  it("sem camada, ou com todos os tipos admitidos: sem limite (null)", () => {
    expect(effectiveScope(null, NOW)).toBeNull();
    expect(effectiveScope({ board: "acme" }, NOW)).toBeNull();
    expect(effectiveScope(ownerScoped([...SCOPE_TYPE_ORDER]), NOW)).toBeNull();
  });

  // tabela completa: dono × agente → os tipos que valem
  const table: Array<[string, StoryType[] | null, StoryType[] | null, StoryType[]]> = [
    ["só o dono", ["bug", "chore"], null, ["bug", "chore"]],
    ["só o agente", null, ["technical"], ["technical"]],
    ["agente dentro do dono", ["bug", "technical", "chore"], ["bug", "chore"], ["bug", "chore"]],
    ["dono dentro do agente", ["bug"], ["bug", "technical", "chore"], ["bug"]],
    ["se cruzam", ["bug", "technical"], ["technical", "chore"], ["technical"]],
    ["iguais", FIXES, FIXES, FIXES],
    ["disjuntos (só numa edição à mão): não admite nada", ["bug"], ["chore"], []],
    ["o preset de consertos", FIXES, null, ["bug", "technical", "chore", "spike"]],
  ];
  it.each(table)("%s", (_name, owner, agent, want) => {
    const row: BoardPaceRow = { board: "acme", ...(owner ? { ownerScope: scopeLayer(OWNER, owner) } : {}), ...(agent ? { agentScope: scopeLayer(AGENT, agent) } : {}) };
    expect(effectiveScope(row, NOW)?.types).toEqual(normalizeScopeTypes(want));
  });

  it("devolve a camada que mais estreita (empate: a do dono), o limite de cada camada e o prazo dessa camada", () => {
    const both: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES), agentScope: scopeLayer(AGENT, ["bug"], { until: iso(NOW + 1000), reason: "economia" }) };
    expect(effectiveScope(both, NOW)).toMatchObject({ types: ["bug"], by: AGENT, reason: "economia", until: iso(NOW + 1000), ownerTypes: normalizeScopeTypes(FIXES), agentTypes: ["bug"] });
    const tie: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES), agentScope: scopeLayer(AGENT, FIXES) };
    expect(effectiveScope(tie, NOW)?.by.kind).toBe("owner");
  });

  it("o prazo de uma camada vencido a tira (mesmo antes da varredura); a outra segue valendo", () => {
    expect(liveScope(scopeLayer(OWNER, FIXES, { until: iso(NOW - 1) }), NOW)).toBeNull();
    expect(liveScope(scopeLayer(OWNER, FIXES, { until: iso(NOW + 1) }), NOW)).not.toBeNull();
    expect(effectiveScope(ownerScoped(FIXES, { until: iso(NOW - 1) }), NOW)).toBeNull();
    const row: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES), agentScope: scopeLayer(AGENT, ["bug"], { until: iso(NOW - 1) }) };
    expect(effectiveScope(row, NOW)?.types).toEqual(normalizeScopeTypes(FIXES));
  });

  it("alargou / estreitou: comparação dos tipos admitidos (null = todos)", () => {
    const fixes = effectiveScope(ownerScoped(FIXES), NOW);
    const bugOnly = effectiveScope(ownerScoped(["bug"]), NOW);
    expect(scopeWidened(fixes, null)).toBe(true);
    expect(scopeNarrowed(fixes, null)).toBe(false);
    expect(scopeWidened(null, fixes)).toBe(false);
    expect(scopeNarrowed(null, fixes)).toBe(true);
    expect(scopeWidened(bugOnly, fixes)).toBe(true);
    expect(scopeNarrowed(bugOnly, fixes)).toBe(false);
    expect(scopeWidened(fixes, fixes)).toBe(false);
    expect(scopeNarrowed(fixes, fixes)).toBe(false);
    // trocar um tipo por outro alarga E estreita
    const other = effectiveScope(ownerScoped(["bug", "user"]), NOW);
    expect(scopeWidened(bugOnly, other)).toBe(true);
    expect(scopeNarrowed(other, bugOnly)).toBe(true);
  });

  it("os tipos: ordem canônica, sem repetição, sem desconhecido; as palavras fixas do dono; o preset reconhecido", () => {
    expect(normalizeScopeTypes(["spike", "bug", "bug", "nada", "user"])).toEqual(["user", "bug", "spike"]);
    expect(SCOPE_TYPE_WORDS).toEqual({ user: "Funcionalidade nova", bug: "Erro", technical: "Trabalho técnico", chore: "Manutenção", spike: "Investigação" });
    expect(scopeTypesPhrase(FIXES)).toBe("Erro, Trabalho técnico, Manutenção e Investigação");
    expect(scopeTypesPhrase(["bug"])).toBe("Erro");
    expect(scopeTypesPhrase([])).toBe("nenhum tipo");
    expect(scopePresetOf(null)).toBe("all");
    expect(scopePresetOf([...SCOPE_TYPE_ORDER])).toBe("all");
    expect(scopePresetOf(FIXES)).toBe("fixes");
    expect(scopePresetOf(["bug", "chore"])).toBe("custom");
    expect(scopeTypesOf("all")).toBeNull();
    expect(scopeTypesOf([...SCOPE_TYPE_ORDER])).toBeNull();
    expect(scopeTypesOf(["spike", "bug"])).toEqual(["bug", "spike"]);
  });
});

describe("a pergunta por card — gateAdmitsCard (R2 e R3)", () => {
  const gateFixes = resolveBoardGate(ARMED, ownerScoped(FIXES), NOW);

  it("o portão leva o escopo; portão sem escopo (ou montado à mão, sem o campo) admite tudo", () => {
    expect(gateFixes.scope?.types).toEqual(normalizeScopeTypes(FIXES));
    expect(resolveBoardGate(ARMED, null, NOW).scope).toBeNull();
    expect(configOnlyGate(ARMED).scope).toBeNull();
    expect(gateAdmitsCard({}, card()).admit).toBe(true);
    expect(gateAdmitsCard(resolveBoardGate(ARMED, null, NOW), card()).admit).toBe(true);
  });

  it("a ÚNICA funcionalidade nova é a story `user`: bug, técnico, manutenção e investigação passam; `user` na construção não", () => {
    const types: Array<[StoryType, boolean]> = [
      ["user", false],
      ["bug", true],
      ["technical", true],
      ["chore", true],
      ["spike", true],
    ];
    for (const [storyType, admit] of types) expect(gateAdmitsCard(gateFixes, card({ storyType })).admit, storyType).toBe(admit);
  });

  it("o tipo EFETIVO: um `user` em modo fix conta como erro (passa); refine/retire/build seguem `user`; sem tipo vale `user`", () => {
    expect(gateAdmitsCard(gateFixes, card({ storyType: "user", mode: "fix" })).admit).toBe(true);
    expect(gateAdmitsCard(gateFixes, card({ storyType: "user", mode: "refine" })).admit).toBe(false);
    expect(gateAdmitsCard(gateFixes, card({ storyType: "user", mode: "retire" })).admit).toBe(false);
    expect(gateAdmitsCard(gateFixes, card({ storyType: null })).admit).toBe(false);
    expect(gateAdmitsCard(gateFixes, card({ storyType: "chore", mode: "fix" })).admit).toBe(true);
    // um escopo só de `technical` não admite o `user`+fix (nem o erro) — o card admite se QUALQUER tipo efetivo está no escopo
    const technicalOnly = resolveBoardGate(ARMED, ownerScoped(["technical"]), NOW);
    expect(gateAdmitsCard(technicalOnly, card({ storyType: "user", mode: "fix" })).admit).toBe(false);
    expect(gateAdmitsCard(technicalOnly, card({ storyType: "technical", mode: "fix" })).admit).toBe(true);
  });

  it("só story entra na regra: ideia, atividade e passo seguem como hoje", () => {
    for (const type of ["idea", "activity", "step"] as const) expect(gateAdmitsCard(gateFixes, card({ type, storyType: null })).admit, type).toBe(true);
  });

  it("SÓ A CONSTRUÇÃO é barrada: captura, triagem, dúvidas, especificação, entrevista, a fazer, design e entrega seguem", () => {
    for (const status of SCOPE_BUILD_STATUSES) expect(gateAdmitsCard(gateFixes, card({ status }), "column").admit, status).toBe(false);
    for (const status of ["capturando", "triage", "grill", "enriquecer", "interview", "pronta", "design-ux", "design-ui", "com-design", "ready", "refinar", "corrigir", "descontinuar", "revisar-codigo", "qa-automatizado", "revisao", "merge", "stage", "release", "deploy", "concluida", null]) {
      expect(gateAdmitsCard(gateFixes, card({ status }), "column").admit, String(status)).toBe(true);
    }
  });

  it("o CONDUTOR carrega a story de ponta a ponta: a coluna não importa", () => {
    for (const status of ["interview", "enriquecer", "corrigir", "refinar", "desenvolver", null]) expect(gateAdmitsCard(gateFixes, card({ status }), "conductor").admit, String(status)).toBe(false);
    expect(gateAdmitsCard(gateFixes, card({ status: "interview", storyType: "bug" }), "conductor").admit).toBe(true);
  });

  it("a recusa diz o tipo e o que o board começa, sem jargão; a aprovação não tem frase", () => {
    const v = gateAdmitsCard(gateFixes, card());
    expect(v.why).toBe("Funcionalidade nova fica de fora: o board só começa Erro, Trabalho técnico, Manutenção e Investigação por enquanto");
    expect(gateAdmitsCard(gateFixes, card({ storyType: "bug" })).why).toBe("");
  });

  it("DEVAGAR e escopo são eixos independentes: o escopo vale em qualquer ritmo, e pausado segura antes de olhar tipo", () => {
    const slow = resolveBoardGate(ARMED, { ...byOwner("slow"), ownerScope: scopeLayer(OWNER, FIXES) }, NOW);
    expect(slow).toMatchObject({ level: "slow", held: false });
    expect(gateAdmitsCard(slow, card()).admit).toBe(false);
    expect(gateAdmitsCard(slow, card({ storyType: "bug" })).admit).toBe(true);
    expect(paceCap(3, slow)).toBe(1);
    const normal = resolveBoardGate(ARMED, ownerScoped(FIXES), NOW);
    expect(normal).toMatchObject({ level: "normal", held: false, background: true });
    expect(gateAdmitsCard(normal, card()).admit).toBe(false);
    expect(paceCap(3, normal)).toBe(3);
    const paused = resolveBoardGate(ARMED, { ...byOwner("paused"), ownerScope: scopeLayer(OWNER, FIXES) }, NOW);
    expect(paused).toMatchObject({ level: "paused", held: true });
  });

  it("desarmado e ilegível seguram tudo ANTES de olhar tipo — o portão não leva escopo", () => {
    expect(resolveBoardGate({ autorunDisabled: true }, ownerScoped(FIXES), NOW).scope).toBeUndefined();
    expect(resolveBoardGate(ARMED, ownerScoped(FIXES), NOW, true).scope).toBeUndefined();
    expect(resolveBoardGate(null, ownerScoped(FIXES), NOW).scope).toBeUndefined();
  });

  it("um escopo vencido não barra mais", () => {
    expect(gateAdmitsCard(resolveBoardGate(ARMED, ownerScoped(FIXES, { until: iso(NOW - 1) }), NOW), card()).admit).toBe(true);
  });

  it("isNewFeatureCard: user puro; fix, refine-de-outro-tipo e não-story não", () => {
    expect(isNewFeatureCard(card())).toBe(true);
    expect(isNewFeatureCard(card({ storyType: null }))).toBe(true);
    expect(isNewFeatureCard(card({ mode: "fix" }))).toBe(false);
    expect(isNewFeatureCard(card({ storyType: "chore" }))).toBe(false);
    expect(isNewFeatureCard(card({ type: "idea", storyType: null }))).toBe(false);
  });
});

describe("a fronteira da construção é declarativa — conferida contra o board base", () => {
  const base = loadYaml(readFileSync(path.resolve(__dirname, "../../../../../../storymap/boards/_base/board.yaml"), "utf8")) as { statuses: Array<{ id: string; column?: string; trigger?: string }> };
  const ids = base.statuses.map((s) => s.id);

  it("a lista da construção = a coluna «Construção» do board base menos o buffer `ready` (+ `quebrar-tasks`, dos boards de produto antigos)", () => {
    const construcao = base.statuses.filter((s) => s.column === "construcao" && s.id !== "ready").map((s) => s.id);
    expect(construcao).toEqual(["plano-tecnico", "desenvolver", "revisar-codigo", "qa-automatizado"]);
    // C4 («deixa terminar»): a fronteira é o COMEÇO da construção; a revisão e a QA (fechamento) ficam fora dela
    expect([...SCOPE_BUILD_STATUSES].filter((id) => id !== "quebrar-tasks")).toEqual(["plano-tecnico", "desenvolver"]);
    expect([...SCOPE_BUILD_STATUSES, ...SCOPE_FINISHING_STATUSES].filter((id) => id !== "quebrar-tasks")).toEqual(construcao);
    expect(SCOPE_BUILD_STATUSES).toContain("quebrar-tasks");
    expect(SCOPE_FINISHING_STATUSES).toEqual(["revisar-codigo", "qa-automatizado"]);
  });

  it("C4: a revisão de código e a QA terminam o que o desenvolvimento começou — o escopo não as barra, nem as conta como espera", () => {
    for (const status of SCOPE_FINISHING_STATUSES) {
      expect(scopeGatesStatus(status), status).toBe(false);
      expect(SCOPE_WAITING_STATUSES, status).not.toContain(status);
      expect(gateAdmitsCard(resolveBoardGate(ARMED, ownerScoped(FIXES), NOW), card({ status }), "column").admit, status).toBe(true);
    }
    // mas o CONDUTOR continua levando a story de ponta a ponta: a coluna não importa para ele
    expect(gateAdmitsCard(resolveBoardGate(ARMED, ownerScoped(FIXES), NOW), card({ status: "revisar-codigo" }), "conductor").admit).toBe(false);
  });

  it("nada do que anda para o tipo ser decidido, nem da entrega, está na fronteira — e todo id existe no board", () => {
    const stays = ["capturando", "triage", "grill", "enriquecer", "interview", "pronta", "design-ux", "design-ui", "com-design", "ready", "refinar", "corrigir", "descontinuar", "revisar-codigo", "qa-automatizado", "revisao", "merge", "stage", "release", "deploy"];
    for (const id of stays) {
      expect(ids, id).toContain(id);
      expect(scopeGatesStatus(id), id).toBe(false);
    }
    for (const id of [...SCOPE_WAITING_STATUSES, ...SCOPE_FINISHING_STATUSES, ...SCOPE_DELIVERY_STATUSES, ...SCOPE_CLASSIFYING_STATUSES]) if (id !== "quebrar-tasks") expect(ids, id).toContain(id);
    expect(scopeGatesStatus(null)).toBe(false);
    expect(scopeGatesStatus("desenvolver")).toBe(true);
  });

  it("a classificação acaba na especificação (é o `enriquecer` que decide o tipo); a entrega e a espera não se misturam com a construção", () => {
    expect(SCOPE_CLASSIFYING_STATUSES).toEqual(["capturando", "triage", "grill", "enriquecer"]);
    expect(SCOPE_DELIVERY_STATUSES.filter((s) => SCOPE_BUILD_STATUSES.includes(s))).toEqual([]);
    for (const s of SCOPE_BUILD_STATUSES) expect(SCOPE_WAITING_STATUSES).toContain(s);
  });
});

describe("quem pode mudar o escopo — scopeChangeRefusal (R5)", () => {
  it("o DONO põe qualquer escopo, alarga e libera tudo, em qualquer estado", () => {
    expect(refuseScope(null, FIXES, OWNER)).toBeNull();
    expect(refuseScope(ownerScoped(["bug"]), "all", OWNER)).toBeNull();
    expect(refuseScope(ownerScoped(["bug"]), FIXES, OWNER)).toBeNull();
    expect(refuseScope(agentScoped(["bug"]), "all", OWNER)).toBeNull();
  });

  it("o AGENTE estreita livremente um board sem limite do dono (inclusive o escopo de outro agente)", () => {
    expect(refuseScope(null, FIXES, AGENT)).toBeNull();
    expect(refuseScope(null, ["bug"], AGENT)).toBeNull();
    expect(refuseScope(agentScoped(["bug"]), FIXES, AGENT)).toBeNull(); // desfaz/ajusta o limite que um agente pôs
    expect(refuseScope(agentScoped(FIXES), "all", AGENT)).toBeNull();
  });

  // tabela: o limite do dono × o que o agente pede
  const ownerLimit = ["bug", "technical", "chore"] as StoryType[];
  const askTable: Array<[string, ScopeChange["types"], boolean]> = [
    ["o mesmo limite do dono", ownerLimit, true],
    ["mais estreito que o do dono", ["bug"], true],
    ["um tipo além do dono", ["bug", "spike"], false],
    ["funcionalidade nova, que o dono deixou de fora", ["user"], false],
    // C11: «Tudo» de um agente é «tirar a camada DELE» (sobra o escopo do dono) — não é alargar além do dono, então não se recusa
    ["tudo", "all", true],
    ["os cinco tipos", [...SCOPE_TYPE_ORDER], true],
  ];
  it.each(askTable)("o dono limitou a Erro/Técnico/Manutenção e o agente pede: %s", (_n, types, allowed) => {
    const out = refuseScope(ownerScoped(ownerLimit), types, AGENT);
    if (allowed) expect(out).toBeNull();
    else expect(out).toMatch(/O dono limitou este board a Erro, Trabalho técnico e Manutenção: só ele alarga/);
  });

  it("a frase diz o que o agente pediu além do limite", () => {
    expect(refuseScope(ownerScoped(ownerLimit), ["bug", "spike", "user"], AGENT)).toContain("o pedido incluía Funcionalidade nova e Investigação");
  });

  it("o limite do dono com prazo VENCIDO não segura mais o agente", () => {
    expect(refuseScope(ownerScoped(ownerLimit, { until: iso(NOW - 1) }), "all", AGENT)).toBeNull();
  });

  it("o agente alarga o PRÓPRIO limite até onde o dono admite (nunca além)", () => {
    const row: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, ownerLimit), agentScope: scopeLayer(AGENT, ["bug"]) };
    expect(refuseScope(row, ownerLimit, AGENT)).toBeNull();
    expect(refuseScope(row, ["bug", "spike", "user"], AGENT)).toMatch(/só ele alarga/);
  });

  it("C11: o agente que pede «Tudo» sob o limite do dono TIRA a camada dele: o escopo em vigor vira o do dono (não alarga) e o histórico registra isso", () => {
    const row: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, ownerLimit), agentScope: scopeLayer(AGENT, ["bug"]) };
    expect(refuseScope(row, "all", AGENT)).toBeNull();
    const r = applyScopeChange(row, askScope("all", AGENT), NOW);
    expect(r.changed).toBe(true);
    expect(r.row.agentScope).toBeUndefined();
    expect(r.row.ownerScope).toEqual(row.ownerScope);
    expect(r.after?.types).toEqual(normalizeScopeTypes(ownerLimit));
    expect(r.widened).toBe(true); // alargou do limite do agente para o do dono — nunca além dele
    expect(effectiveScope(r.row, NOW)?.types).toEqual(normalizeScopeTypes(ownerLimit));
    expect(r.row.scopeHistory?.at(-1)).toMatchObject({ types: normalizeScopeTypes(ownerLimit), by: AGENT });
  });

  it("registro ilegível: o agente não grava NADA; o dono regrava", () => {
    expect(refuseScope(null, FIXES, AGENT, ARMED, true)).toMatch(/só o dono/);
    expect(refuseScope(null, "all", AGENT, ARMED, true)).toMatch(/só o dono/);
    expect(refuseScope(null, FIXES, OWNER, ARMED, true)).toBeNull();
  });

  it("board desarmado: o escopo pode ser posto (não acelera nada)", () => {
    expect(refuseScope(null, FIXES, AGENT, { autorunDisabled: true })).toBeNull();
    expect(refuseScope(null, FIXES, OWNER, { autorunDisabled: true })).toBeNull();
  });
});

describe("o pedido de escopo — scopeInputRefusal", () => {
  it("aceita o comum e recusa o malformado, com a frase", () => {
    expect(scopeInputRefusal(askScope(FIXES, OWNER, { forMinutes: 60, reason: "semana de consertos" }))).toBeNull();
    expect(scopeInputRefusal(askScope("all", OWNER))).toBeNull();
    expect(scopeInputRefusal(askScope(["nada" as StoryType], OWNER))).toMatch(/Tipo desconhecido/);
    expect(scopeInputRefusal(askScope([], OWNER))).toMatch(/ao menos um tipo/);
    expect(scopeInputRefusal(askScope("x" as never, OWNER))).toMatch(/lista/);
    expect(scopeInputRefusal(askScope("all", OWNER, { forMinutes: 10 }))).toMatch(/prazo vale para limitar/);
    expect(scopeInputRefusal(askScope([...SCOPE_TYPE_ORDER], OWNER, { forMinutes: 10 }))).toMatch(/prazo vale para limitar/);
    expect(scopeInputRefusal(askScope(FIXES, OWNER, { forMinutes: 0 }))).toMatch(/maior que zero/);
    expect(scopeInputRefusal(askScope(FIXES, OWNER, { forMinutes: 60 * 24 * 31 }))).toMatch(/30 dias/);
    expect(scopeInputRefusal(askScope(FIXES, OWNER, { reason: "x".repeat(301) }))).toMatch(/300 caracteres/);
  });
});

describe("a mudança de escopo — applyScopeChange", () => {
  it("o agente limita um board sem limite: grava na camada DOS AGENTES (quem, quando, motivo, prazo) e diz que estreitou", () => {
    const r = applyScopeChange(null, askScope(FIXES, AGENT, { reason: "  cota apertada  ", forMinutes: 60 }), NOW);
    expect(r).toMatchObject({ changed: true, narrowed: true, widened: false, before: null });
    expect(r.row.agentScope).toEqual({ types: normalizeScopeTypes(FIXES), by: AGENT, at: iso(NOW), reason: "cota apertada", until: iso(NOW + 3_600_000) });
    expect(r.row.ownerScope).toBeUndefined();
    expect(r.after?.types).toEqual(normalizeScopeTypes(FIXES));
    expect(r.row.scopeHistory).toEqual([{ types: normalizeScopeTypes(FIXES), by: AGENT, at: iso(NOW), reason: "cota apertada", until: iso(NOW + 3_600_000) }]);
  });

  it("o dono manda nas duas camadas: o que ele grava substitui a dele e APAGA a dos agentes", () => {
    const both: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES), agentScope: scopeLayer(AGENT, ["bug"]) };
    const r = applyScopeChange(both, askScope(["bug", "chore"], OWNER), NOW);
    expect(r.row.ownerScope?.types).toEqual(["bug", "chore"]);
    expect(r.row.agentScope).toBeUndefined();
    expect(r).toMatchObject({ widened: true, narrowed: false }); // o limite do agente (só erro) saiu: passou a admitir manutenção
    const free = applyScopeChange(both, askScope("all", OWNER), NOW);
    expect(free.row.ownerScope).toBeUndefined();
    expect(free.row.agentScope).toBeUndefined();
    expect(free).toMatchObject({ after: null, widened: true });
    expect(free.row.scopeHistory?.at(-1)).toMatchObject({ types: null, by: OWNER });
  });

  it("um agente que pede por cima não mexe na camada do dono (nem tipos, nem prazo, nem autor)", () => {
    const owned = ownerScoped(FIXES, { reason: "decisão minha" });
    const r = applyScopeChange(owned, askScope(["bug"], AGENT), NOW);
    expect(r.row.ownerScope).toEqual(owned.ownerScope);
    expect(r.row.agentScope?.types).toEqual(["bug"]);
    expect(r).toMatchObject({ narrowed: true, widened: false });
  });

  it("o agente que pede «Tudo» só tira a camada DELE: a do dono fica e o escopo em vigor é o do dono", () => {
    const both: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES), agentScope: scopeLayer(AGENT, ["bug"]) };
    const r = applyScopeChange(both, askScope(FIXES, AGENT), NOW);
    expect(r.row.ownerScope).toEqual(both.ownerScope);
    expect(r.after?.types).toEqual(normalizeScopeTypes(FIXES));
    expect(r.widened).toBe(true);
  });

  it("pedir o que já está em vigor não grava — e não apaga o motivo", () => {
    const owned = ownerScoped(FIXES, { reason: "semana de consertos" });
    const again = applyScopeChange(owned, askScope(FIXES, OWNER, { reason: "semana de consertos" }), NOW);
    expect(again.changed).toBe(false);
    expect(again.row).toBe(owned);
    expect(applyScopeChange(null, askScope("all", OWNER), NOW).changed).toBe(false);
    // sem motivo novo, o motivo da mesma camada nos mesmos tipos continua
    const keep = applyScopeChange({ ...owned, agentScope: scopeLayer(AGENT, ["bug"]) }, askScope(FIXES, OWNER), NOW);
    expect(keep.changed).toBe(true); // o dono assumiu: a camada do agente saiu
    expect(keep.row.ownerScope?.reason).toBe("semana de consertos");
  });

  it("NÃO TOCA NO RITMO: gravar escopo mantém os freios e o histórico de ritmo; gravar ritmo mantém os escopos", () => {
    const paced: BoardPaceRow = { ...byOwner("slow"), agent: hold(AGENT, "paused"), history: [{ level: "slow", by: OWNER, at: iso(NOW - 1) }] };
    const scoped = applyScopeChange(paced, askScope(FIXES, OWNER), NOW);
    expect(scoped.row.owner).toEqual(paced.owner);
    expect(scoped.row.agent).toEqual(paced.agent);
    expect(scoped.row.history).toEqual(paced.history);
    // …e o dono mexendo no RITMO não apaga o escopo do agente (só o freio do agente sai): são eixos independentes
    const row: BoardPaceRow = { board: "acme", agent: hold(AGENT, "paused"), agentScope: scopeLayer(AGENT, ["bug"]), ownerScope: scopeLayer(OWNER, FIXES) };
    const resumed = applyPaceChange(row, ask("normal", OWNER), NOW);
    expect(resumed.row.agent).toBeUndefined();
    expect(resumed.row.agentScope).toEqual(row.agentScope);
    expect(resumed.row.ownerScope).toEqual(row.ownerScope);
    const slowed = applyPaceChange(row, ask("slow", AGENT), NOW);
    expect(slowed.row.agentScope).toEqual(row.agentScope);
    expect(slowed.row.ownerScope).toEqual(row.ownerScope);
  });

  it("O QUE O ESCOPO SEGURA volta quando ele alarga ou sai — e NÃO volta quando estreita; a pausa não é tocada", () => {
    const heldScope = [{ cardId: "story-ex9901", why: "scope" as const, at: iso(NOW - 1000) }];
    const heldPause = [{ cardId: "story-ex9902", why: "entry" as const, at: iso(NOW - 1000) }];
    const row: BoardPaceRow = { ...ownerScoped(["bug"]), ...byOwner("paused"), held: [...heldPause, ...heldScope] };
    const widen = applyScopeChange(row, askScope(FIXES, OWNER), NOW);
    expect(widen.released).toEqual(heldScope);
    expect(widen.row.held).toEqual(heldPause);
    const narrow = applyScopeChange({ ...row, ownerScope: scopeLayer(OWNER, FIXES) }, askScope(["bug"], OWNER), NOW);
    expect(narrow.released).toEqual([]);
    expect(narrow.row.held).toEqual([...heldPause, ...heldScope]);
    const free = applyScopeChange(row, askScope("all", OWNER), NOW);
    expect(free.released).toEqual(heldScope);
    expect(free.row.held).toEqual(heldPause);
  });

  it("sair da PAUSA não devolve o que o escopo ainda segura, e alargar o escopo não devolve o que a pausa ainda segura", () => {
    const heldScope = [{ cardId: "story-ex9901", why: "scope" as const, at: iso(NOW - 1000) }];
    const heldPause = [{ cardId: "story-ex9902", why: "stopped" as const, at: iso(NOW - 1000) }];
    const row: BoardPaceRow = { ...byOwner("paused"), ownerScope: scopeLayer(OWNER, FIXES), held: [...heldPause, ...heldScope] };
    const resumed = applyPaceChange(row, ask("normal", OWNER), NOW);
    expect(resumed.released).toEqual(heldPause);
    expect(resumed.row.held).toEqual(heldScope);
    const stillPaused = applyPaceChange(row, ask("paused", OWNER, { mode: "stop" }), NOW);
    expect(stillPaused.row.held).toEqual([...heldPause, ...heldScope]);
  });

  it("o histórico de escopo guarda só as mudanças mais recentes, separado do de ritmo", () => {
    let r: BoardPaceRow | null = null;
    for (let i = 0; i < PACE_HISTORY_MAX + 5; i += 1) r = applyScopeChange(r, askScope(i % 2 ? "all" : FIXES, OWNER), NOW + i).row;
    expect(r?.scopeHistory).toHaveLength(PACE_HISTORY_MAX);
    expect(r?.history).toBeUndefined();
  });
});

describe("o prazo do escopo — expirePace / rowExpired", () => {
  it("só o prazo do ESCOPO venceu: o limite sai, o ritmo não muda, devolve o que o escopo segurava e registra que foi o prazo", () => {
    const heldScope = [{ cardId: "story-ex9901", why: "scope" as const, at: iso(NOW - 1000) }];
    const row: BoardPaceRow = { ...ownerScoped(FIXES, { until: iso(NOW - 1) }), ...byAgent("slow"), held: heldScope };
    expect(rowExpired(row, NOW)).toBe(true);
    const e = expirePace(row, NOW);
    expect(e).toMatchObject({ paceDue: false, scopeDue: true, faster: false, level: "slow", released: [] });
    expect(e?.releasedScope).toEqual(heldScope);
    expect(e?.row.ownerScope).toBeUndefined();
    expect(e?.row.agent).toEqual(row.agent);
    expect(e?.row.held).toBeUndefined();
    expect(e?.row.history).toBeUndefined();
    expect(e?.row.scopeHistory?.at(-1)).toMatchObject({ types: null, expired: true, by: OWNER });
    expect(e?.scopeBefore?.types).toEqual(normalizeScopeTypes(FIXES));
    expect(e?.scopeAfter).toBeNull();
  });

  it("vence o limite do AGENTE e o do dono segue: o escopo alarga até o do dono; o que ele segurava volta para ser re-varrido", () => {
    const heldScope = [{ cardId: "story-ex9901", why: "scope" as const, at: iso(NOW - 1000) }];
    const row: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES), agentScope: scopeLayer(AGENT, ["bug"], { until: iso(NOW - 1) }), held: heldScope };
    const e = expirePace(row, NOW);
    expect(e?.scopeAfter?.types).toEqual(normalizeScopeTypes(FIXES));
    expect(e?.releasedScope).toEqual(heldScope);
    expect(e?.row.agentScope).toBeUndefined();
    expect(e?.row.ownerScope).toEqual(row.ownerScope);
  });

  it("vence o limite do dono e o do agente (mais estreito) segue: o escopo NÃO alargou — nada é devolvido", () => {
    const heldScope = [{ cardId: "story-ex9901", why: "scope" as const, at: iso(NOW - 1000) }];
    const row: BoardPaceRow = { board: "acme", ownerScope: scopeLayer(OWNER, FIXES, { until: iso(NOW - 1) }), agentScope: scopeLayer(AGENT, ["bug"]), held: heldScope };
    const e = expirePace(row, NOW);
    expect(e?.scopeAfter?.types).toEqual(["bug"]);
    expect(e?.releasedScope).toEqual([]);
    expect(e?.row.held).toEqual(heldScope);
  });

  it("ritmo E escopo vencendo juntos: cada um devolve o seu, e os dois históricos recebem a linha", () => {
    const row: BoardPaceRow = {
      board: "acme",
      owner: hold(OWNER, "paused", { until: iso(NOW - 1) }),
      ownerScope: scopeLayer(OWNER, FIXES, { until: iso(NOW - 1) }),
      held: [
        { cardId: "story-ex9901", why: "scope", at: iso(NOW - 1000) },
        { cardId: "story-ex9902", why: "stopped", at: iso(NOW - 1000) },
      ],
    };
    const e = expirePace(row, NOW);
    expect(e).toMatchObject({ paceDue: true, scopeDue: true, faster: true, level: "normal" });
    expect(e?.released.map((h) => h.cardId)).toEqual(["story-ex9902"]);
    expect(e?.releasedScope.map((h) => h.cardId)).toEqual(["story-ex9901"]);
    expect(e?.row.history?.at(-1)).toMatchObject({ expired: true });
    expect(e?.row.scopeHistory?.at(-1)).toMatchObject({ expired: true });
  });

  it("nenhum prazo vencido: null (o escopo sem prazo nunca vence)", () => {
    expect(expirePace(ownerScoped(FIXES), NOW)).toBeNull();
    expect(expirePace(ownerScoped(FIXES, { until: iso(NOW + 1) }), NOW)).toBeNull();
    expect(rowExpired(ownerScoped(FIXES), NOW)).toBe(false);
  });
});

describe("o que o escopo segura — holdPaceEntry / holdScopeEntry", () => {
  const at = iso(NOW);
  it("só anota com um escopo em vigor; uma entrada por card; não conta como pausa", () => {
    const none = byOwner("slow");
    expect(holdPaceEntry(none, { cardId: "c1", why: "scope", at }, NOW)).toBe(none);
    let r = holdPaceEntry(ownerScoped(FIXES), { cardId: "c1", why: "scope", at }, NOW);
    r = holdPaceEntry(r, { cardId: "c1", why: "scope", at }, NOW);
    expect(r.held).toEqual([{ cardId: "c1", why: "scope", at }]);
    expect(holdScopeEntry(ownerScoped(FIXES, { until: iso(NOW - 1) }), { cardId: "c1", why: "scope", at }, NOW).held).toBeUndefined();
  });

  it("a pausa e o escopo guardam o MESMO card cada um na sua gaveta", () => {
    const paused: BoardPaceRow = { ...byOwner("paused"), ownerScope: scopeLayer(OWNER, FIXES) };
    let r = holdPaceEntry(paused, { cardId: "c1", why: "entry", at }, NOW);
    r = holdPaceEntry(r, { cardId: "c1", why: "scope", at }, NOW);
    r = holdPaceEntry(r, { cardId: "c1", why: "stopped", at }, NOW);
    expect(r.held).toEqual([
      { cardId: "c1", why: "stopped", at },
      { cardId: "c1", why: "scope", at },
    ]);
  });

  it("o teto de 500 vale para o total, e a pausa e o escopo não o estouram", () => {
    let r = ownerScoped(FIXES);
    for (let i = 0; i < PACE_HELD_MAX + 10; i += 1) r = holdPaceEntry(r, { cardId: `c${i}`, why: "scope", at }, NOW);
    expect(r.held).toHaveLength(PACE_HELD_MAX);
    const full = holdPaceEntry({ ...r, ...byOwner("paused") }, { cardId: "outro", why: "entry", at }, NOW);
    expect(full.held).toHaveLength(PACE_HELD_MAX);
  });
});

describe("o arquivo com escopo — versão 1 / 2 e o fail-closed do binário antigo (T1)", () => {
  /** O leitor do binário ANTIGO, congelado: a única versão que ele conhece é a 1 (parsePaceFile de antes do escopo). */
  const legacyParse = (raw: string): unknown[] | null => {
    try {
      const data = JSON.parse(raw) as { version?: unknown; rows?: unknown };
      return data?.version !== 1 || !Array.isArray(data.rows) ? null : (data.rows as unknown[]);
    } catch {
      return null;
    }
  };
  const scoped: BoardPaceRow[] = [
    {
      board: "acme",
      owner: hold(OWNER, "slow"),
      ownerScope: scopeLayer(OWNER, FIXES, { reason: "semana de consertos", until: iso(NOW + 1000) }),
      agentScope: scopeLayer(AGENT, ["bug", "chore"]),
      held: [{ cardId: "story-ex9901", why: "scope", at: iso(NOW) }],
      history: [{ level: "slow", by: OWNER, at: iso(NOW) }],
      scopeHistory: [
        { types: normalizeScopeTypes(FIXES), by: OWNER, at: iso(NOW), reason: "semana de consertos", until: iso(NOW + 1000) },
        { types: null, by: OWNER, at: iso(NOW + 1), expired: true },
      ],
    },
    { board: "other", history: [{ level: "normal", by: OWNER, at: iso(NOW) }] },
  ];
  const unscoped: BoardPaceRow[] = [{ board: "acme", owner: hold(OWNER, "slow"), held: [{ cardId: "c1", why: "entry", at: iso(NOW) }] }, { board: "other" }];

  it("SEM escopo grava a versão 1 (nada muda para o binário antigo); COM escopo grava a versão 2", () => {
    expect(PACE_FILE_VERSION).toBe(1);
    expect(PACE_FILE_VERSION_SCOPE).toBe(2);
    expect(paceFileVersionOf(unscoped)).toBe(1);
    expect(paceFileVersionOf([])).toBe(1);
    expect(paceFileVersionOf(scoped)).toBe(2);
    expect(paceFileVersionOf([{ board: "a", agentScope: scopeLayer(AGENT, ["bug"]) }])).toBe(2);
    expect(JSON.parse(serializePaceFile(unscoped)).version).toBe(1);
    expect(JSON.parse(serializePaceFile(scoped)).version).toBe(2);
    // um escopo que saiu (mas deixou histórico) volta a ser versão 1: o histórico de escopo é ignorável pelo leitor antigo
    const lifted = [{ ...scoped[0], ownerScope: undefined, agentScope: undefined, held: undefined }];
    expect(paceFileVersionOf(lifted)).toBe(1);
  });

  it("vai e volta nas duas versões, com tudo (escopo, histórico de escopo, entradas `scope`)", () => {
    expect(parsePaceFile(serializePaceFile(scoped))).toEqual(scoped);
    expect(parsePaceFile(serializePaceFile(unscoped))).toEqual(unscoped);
  });

  it("C3: o histórico de escopo SOBREVIVE à ida e volta pelo arquivo quando a última camada sai (limitar → «Tudo» → serializar → ler)", () => {
    const limited = applyScopeChange(null, askScope(FIXES, OWNER, { reason: "semana de consertos" }), NOW).row;
    const freed = applyScopeChange(limited, askScope("all", OWNER), NOW + 1000).row;
    expect(freed.ownerScope).toBeUndefined();
    const raw = serializePaceFile([freed]);
    expect(JSON.parse(raw).version).toBe(1); // sem camada ⇒ o arquivo volta à versão que o binário antigo lê
    const back = parsePaceFile(raw);
    expect(back).toEqual([freed]);
    expect(back?.[0].scopeHistory).toHaveLength(2);
    expect(back?.[0].scopeHistory?.at(-1)).toMatchObject({ types: null, by: OWNER });
  });

  it("C3: o registro de «o prazo venceu» também atravessa o arquivo (o prazo vencido sempre tira a última camada)", () => {
    const row: BoardPaceRow = { ...ownerScoped(FIXES, { until: iso(NOW - 1) }), scopeHistory: [{ types: normalizeScopeTypes(FIXES), by: OWNER, at: iso(NOW - 5000) }] };
    const expired = expirePace(row, NOW)?.row as BoardPaceRow;
    const back = parsePaceFile(serializePaceFile([expired]));
    expect(back?.[0].scopeHistory?.at(-1)).toMatchObject({ types: null, expired: true });
    expect(back?.[0].scopeHistory).toHaveLength(2);
  });

  it("C3: aceitar o histórico na versão 1 NÃO afrouxa o fail-closed — camada e `held.why = scope` na v1 seguem ilegíveis", () => {
    const file = (rows: unknown) => JSON.stringify({ version: 1, rows });
    expect(parsePaceFile(file([{ board: "acme", scopeHistory: [{ types: null, by: OWNER, at: iso(NOW) }] }]))?.[0].scopeHistory).toHaveLength(1);
    expect(parsePaceFile(file([{ board: "acme", ownerScope: scopeLayer(OWNER, FIXES) }]))).toBeNull();
    expect(parsePaceFile(file([{ board: "acme", held: [{ cardId: "c1", why: "scope", at: iso(NOW) }] }]))).toBeNull();
  });

  it("um arquivo ANTIGO (versão 1, sem o campo) é lido como «todos os tipos»", () => {
    const old = JSON.stringify({ version: 1, rows: [{ board: "acme", owner: hold(OWNER, "paused"), held: [{ cardId: "c1", why: "stopped", at: iso(NOW) }] }] });
    const rows = parsePaceFile(old);
    expect(rows).toHaveLength(1);
    expect(rows?.[0].ownerScope).toBeUndefined();
    expect(resolveBoardGate(ARMED, rows?.[0] ?? null, NOW).scope).toBeNull();
  });

  it("FAIL-CLOSED: o binário ANTIGO lê a versão 2 como ilegível (null ⇒ segura TODOS os boards) — nunca descarta o escopo em silêncio", () => {
    expect(legacyParse(serializePaceFile(unscoped))).not.toBeNull(); // a v1 segue lida como sempre
    expect(legacyParse(serializePaceFile(scoped))).toBeNull(); // a v2 não
    const rows = legacyParse(serializePaceFile(scoped));
    // e o portão do binário antigo, com o arquivo ilegível, segura tudo (a parte do portão já é do código de hoje)
    expect(resolveBoardGate(ARMED, null, NOW, rows === null)).toMatchObject({ held: true, source: "unreadable" });
  });

  it("o leitor novo é rígido com a versão 2: versão desconhecida, escopo malformado e sinais de escopo na versão 1 são ilegíveis", () => {
    const file = (version: number, rows: unknown) => JSON.stringify({ version, rows });
    const layer = (over: Record<string, unknown> = {}) => ({ ...scopeLayer(OWNER, FIXES), ...over });
    expect(parsePaceFile(file(3, []))).toBeNull();
    expect(parsePaceFile(file(2, []))).toEqual([]);
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer() }]))).toHaveLength(1);
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer({ types: [] }) }]))).toBeNull(); // vazio não existe
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer({ types: ["bug", "epico"] }) }]))).toBeNull(); // tipo desconhecido
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer({ types: "bug" }) }]))).toBeNull();
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer({ by: AGENT }) }]))).toBeNull(); // a camada errada
    expect(parsePaceFile(file(2, [{ board: "acme", agentScope: layer({ by: OWNER }) }]))).toBeNull();
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer({ until: "amanhã" }) }]))).toBeNull();
    expect(parsePaceFile(file(2, [{ board: "acme", ownerScope: layer({ at: "ontem" }) }]))).toBeNull();
    // na versão 1 não existe escopo: um sinal dele é um arquivo incoerente
    expect(parsePaceFile(file(1, [{ board: "acme", ownerScope: layer() }]))).toBeNull();
    expect(parsePaceFile(file(1, [{ board: "acme", agentScope: layer({ by: AGENT }) }]))).toBeNull();
    expect(parsePaceFile(file(1, [{ board: "acme", held: [{ cardId: "c1", why: "scope", at: iso(NOW) }] }]))).toBeNull();
  });

  it("o histórico de escopo malformado é descartado (como o de ritmo), sem derrubar a linha", () => {
    const rows = parsePaceFile(
      JSON.stringify({ version: 2, rows: [{ board: "acme", ownerScope: scopeLayer(OWNER, FIXES), scopeHistory: [{ types: ["x"], by: OWNER, at: iso(NOW) }, { types: null, by: OWNER, at: iso(NOW) }] }] }),
    );
    expect(rows?.[0].scopeHistory).toEqual([{ types: null, by: OWNER, at: iso(NOW) }]);
  });
});

describe("a projeção com escopo", () => {
  it("a tela e a tool leem o escopo: tipos, preset, quem, desde, até, o limite do dono, quantos esperam e o histórico (mais novo primeiro)", () => {
    const r: BoardPaceRow = {
      board: "acme",
      ownerScope: scopeLayer(OWNER, FIXES),
      agentScope: scopeLayer(AGENT, ["bug", "chore"], { reason: "cota", until: iso(NOW + 3_600_000) }),
      held: [
        { cardId: "story-ex9901", why: "scope", at: iso(NOW) },
        { cardId: "story-ex9902", why: "scope", at: iso(NOW) },
        { cardId: "story-ex9903", why: "entry", at: iso(NOW) },
      ],
      scopeHistory: [
        { types: FIXES, by: OWNER, at: iso(NOW - 5000) },
        { types: ["bug", "chore"], by: AGENT, at: iso(NOW - 1000) },
      ],
    };
    const v = paceViewOf("acme", ARMED, { rows: [r], unreadable: false }, NOW, null);
    expect(v.scope).toEqual({ types: ["bug", "chore"], preset: "custom", by: AGENT, since: r.agentScope?.at, reason: "cota", until: r.agentScope?.until, ownerTypes: normalizeScopeTypes(FIXES) });
    expect(v).toMatchObject({ level: "normal", scopeWaiting: 2, waiting: 0, featuresToShip: 0 });
    expect(v.scopeHistory.map((h) => h.by.kind)).toEqual(["agent", "owner"]);
    expect(paceViewOf("acme", ARMED, { rows: [ownerScoped(FIXES)], unreadable: false }, NOW, null).scope?.preset).toBe("fixes");
  });

  it("sem escopo, desarmado e ilegível: scope null; o `waiting` da pausa não conta o que o escopo segura", () => {
    expect(paceViewOf("acme", ARMED, { rows: [], unreadable: false }, NOW, null)).toMatchObject({ scope: null, scopeWaiting: 0, scopeHistory: [] });
    expect(paceViewOf("acme", { autorunDisabled: true }, { rows: [ownerScoped(FIXES)], unreadable: false }, NOW, null).scope).toBeNull();
    expect(paceViewOf("acme", ARMED, { rows: [], unreadable: true }, NOW, null).scope).toBeNull();
    const both: BoardPaceRow = { ...byOwner("paused"), ownerScope: scopeLayer(OWNER, FIXES), held: [{ cardId: "a", why: "stopped", at: iso(NOW) }, { cardId: "b", why: "scope", at: iso(NOW) }] };
    expect(paceViewOf("acme", ARMED, { rows: [both], unreadable: false }, NOW, null)).toMatchObject({ waiting: 1, scopeWaiting: 1, level: "paused" });
  });
});

describe("os números do painel — scopeWaitingCount / featuresInDelivery (R8)", () => {
  const scope = effectiveScope(ownerScoped(FIXES), NOW);
  const cards: ScopeCard[] = [
    card({ id: "story-ex9911", status: "pronta" }), // funcionalidade esperando
    card({ id: "story-ex9912", status: "desenvolver" }), // funcionalidade esperando
    card({ id: "story-ex9913", status: "desenvolver", storyType: "bug" }), // erro: anda
    card({ id: "story-ex9914", status: "triage" }), // ainda sendo decidido: não espera
    card({ id: "story-ex9915", status: "stage" }), // já construída: vai junto
    card({ id: "story-ex9916", status: "revisao" }), // idem
    card({ id: "story-ex9917", status: "release", storyType: "chore" }), // não é funcionalidade
    card({ id: "story-ex9918", status: "release", mode: "fix" }), // erro
    card({ id: "story-ex9919", status: "concluida" }), // já no ar
    card({ id: "story-ex9920", status: "pronta", type: "idea", storyType: null }),
  ];
  it("conta as funcionalidades que o escopo SEGURA (construção), e as já construídas na entrega", () => {
    // `pronta` (go/no-go) e o design não são barrados: ali o card anda, então não contam como espera
    expect(scopeWaitingCount(cards, scope)).toBe(1);
    expect(scopeWaitingCount(cards, null)).toBe(0);
    expect(featuresInDelivery(cards)).toBe(2);
    expect(featuresInDelivery([])).toBe(0);
  });

  it("C5: não conta o que está TERMINANDO (condutor, run em voo) nem o design; conta o despacho do condutor (menos a classificação)", () => {
    const wait = (over: Partial<ScopeCard> & { routing?: unknown }) => card({ id: "story-ex9930", status: "desenvolver", ...over }) as ScopeCard;
    const conducted = wait({ routing: { skips: [], decidedBy: "rules", decidedAt: "2026-10-01", driver: "conductor" } } as never);
    expect(scopeWaitingCount([wait({})], scope)).toBe(1);
    expect(scopeWaitingCount([conducted], scope)).toBe(0); // um condutor (vivo ou parado) já tem a sua linha: o que começou termina
    expect(scopeWaitingCount([wait({})], scope, { inFlight: new Set(["story-ex9930"]) })).toBe(0); // um run o está terminando
    expect(scopeWaitingCount([wait({})], scope, { inFlight: new Set(["outro"]) })).toBe(1);
    for (const status of ["design-ux", "design-ui", "com-design", "pronta", "ready", "revisar-codigo", "qa-automatizado"]) {
      expect(scopeWaitingCount([wait({ status })], scope), status).toBe(0);
    }
    // board com condutor: o despacho dele também é barrado (interview, corrigir…), menos a classificação (a skill roda ali)
    const ctx = { conductorFrom: ["enriquecer", "interview", "refinar"] };
    expect(scopeWaitingCount([wait({ status: "interview" })], scope, ctx)).toBe(1);
    expect(scopeWaitingCount([wait({ status: "refinar" })], scope, ctx)).toBe(1);
    expect(scopeWaitingCount([wait({ status: "enriquecer" })], scope, ctx)).toBe(0);
    expect(scopeWaitingCount([wait({ status: "interview" })], scope, {})).toBe(0); // sem condutor, a entrevista anda
    expect(scopeHoldStatuses(["enriquecer", "interview", "desenvolver"])).toEqual([...SCOPE_BUILD_STATUSES, "interview"]);
  });
});

describe("a troca de tipo sob escopo — storyTypeChangeRefusal (R6)", () => {
  const scope = effectiveScope(ownerScoped(FIXES), NOW);
  const classified = { type: "story" as const, storyType: "user" as const, status: "desenvolver" };

  it("sem escopo, ou pelo dono: nunca recusa", () => {
    expect(storyTypeChangeRefusal(null, classified, "chore", AGENT)).toBeNull();
    expect(storyTypeChangeRefusal(scope, classified, "chore", OWNER)).toBeNull();
  });

  it("um agente NÃO tira de `user` um card já classificado (passou da especificação); a frase diz o que fazer", () => {
    for (const status of ["pronta", "interview", "design-ux", "plano-tecnico", "desenvolver", "revisao", "release"]) {
      expect(storyTypeChangeRefusal(scope, { ...classified, status }, "chore", AGENT), status).toMatch(/só o dono troca o tipo dele/);
    }
    expect(storyTypeChangeRefusal(scope, classified, "bug", AGENT)).toContain("Funcionalidade nova");
  });

  it("classificar um card NOVO (captura, triagem, dúvidas, especificação, ou sem coluna) continua livre para o agente", () => {
    for (const status of [...SCOPE_CLASSIFYING_STATUSES, null]) expect(storyTypeChangeRefusal(scope, { ...classified, status }, "bug", AGENT), String(status)).toBeNull();
  });

  it("só a saída de `user` é barrada: virar `user`, trocar entre os outros tipos e card que não é story passam", () => {
    expect(storyTypeChangeRefusal(scope, { ...classified, storyType: "bug" }, "user", AGENT)).toBeNull();
    expect(storyTypeChangeRefusal(scope, { ...classified, storyType: "bug" }, "chore", AGENT)).toBeNull();
    expect(storyTypeChangeRefusal(scope, classified, "user", AGENT)).toBeNull();
    expect(storyTypeChangeRefusal(scope, { ...classified, type: "idea", storyType: null }, "chore", AGENT)).toBeNull();
    expect(storyTypeChangeRefusal(scope, { ...classified, storyType: null }, "chore", AGENT)).not.toBeNull(); // sem tipo = `user`
  });

  it("a linha da trilha de auditoria: antes, depois e autor", () => {
    expect(storyTypeChangeLine({ id: "story-ex9901", storyType: "user" }, "chore", AGENT)).toBe(
      "story-ex9901: tipo Funcionalidade nova → Manutenção por um agente (TOKEN_ORCH), com o escopo do board limitado",
    );
    expect(storyTypeChangeLine({ id: "story-ex9901", storyType: "bug" }, "user", OWNER)).toContain("Funcionalidade nova pelo dono");
  });
});
