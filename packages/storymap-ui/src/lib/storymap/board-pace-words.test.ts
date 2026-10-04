import { describe, expect, it } from "vitest";
import {
  featuresToShipWords,
  latchSealWords,
  LATCH_SEAL_HEADLINE,
  PACE_LOADING_VALUE,
  PACE_PANEL_LOADING,
  PACE_PANEL_UNAVAILABLE,
  PACE_UNAVAILABLE_VALUE,
  paceChipFace,
  paceReadState,
  quotaUsageWords,
  minutesUntilMorning,
  paceChipValue,
  paceHistoryLine,
  paceStatusLine,
  paceWhoWords,
  pauseMinutes,
  SCOPE_AXIS_HELP,
  SCOPE_BOUNDS_HELP,
  SCOPE_PRESETS,
  SCOPE_QUOTA_HELP,
  SCOPE_TYPE_WORDS,
  scopeChipSuffix,
  scopeHistoryLine,
  scopeLabel,
  scopeStatusLine,
  scopeWaitingWords,
} from "./board-pace-words";
import type { EffectiveLatch } from "./runner/capacity-governor";
import { FIXES_ONLY_TYPES, paceViewOf, type BoardPaceRow, type PaceScope } from "./runner/board-pace";

const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const view = (row: BoardPaceRow | null, config: { autorunDisabled?: boolean } = {}, unreadable = false) =>
  paceViewOf("acme", config, { rows: row ? [row] : [], unreadable }, NOW, null);

describe("as palavras do ritmo do board", () => {
  it("normal, pausado por você, devagar por um agente — com «há quanto» e «volta às»", () => {
    expect(paceStatusLine(view(null), NOW, "UTC")).toBe("Ritmo normal");
    const mine = view({ board: "acme", owner: { level: "paused", by: { kind: "owner" }, at: iso(NOW - 12 * 60_000), until: iso(NOW + 3 * 3_600_000) } });
    expect(paceStatusLine(mine, NOW, "UTC")).toBe("Pausado por você · há 12 min · volta às 18:00");
    const agent = view({ board: "acme", agent: { level: "slow", by: { kind: "agent" }, at: iso(NOW - 60_000) } });
    expect(paceStatusLine(agent, NOW, "UTC")).toMatch(/^Devagar por um agente · há /);
    expect(paceWhoWords({ kind: "agent" })).toBe("por um agente");
  });

  it("desarmado e registro ilegível dizem o que acontece, sem «quem»", () => {
    expect(paceStatusLine(view(null, { autorunDisabled: true }), NOW)).toMatch(/está desligado/);
    expect(paceStatusLine(view(null, {}, true), NOW)).toMatch(/^Tudo parado: /);
  });

  it("a linha do histórico: quem, há quanto e o motivo; o prazo vencido não tem autor", () => {
    expect(paceHistoryLine({ level: "paused", by: { kind: "agent" }, at: iso(NOW - 2 * 3_600_000), reason: "cota apertada" }, NOW)).toBe("Pausado por um agente · há 2 h — cota apertada");
    expect(paceHistoryLine({ level: "normal", by: { kind: "owner" }, at: iso(NOW - 60_000), expired: true }, NOW)).toMatch(/^Normal \(o prazo venceu\) · há /);
  });

  it("«até amanhã cedo» é a próxima manhã na hora local de quem pausa", () => {
    expect(minutesUntilMorning(new Date(2026, 2, 10, 22, 30), 8)).toBe(9 * 60 + 30);
    expect(minutesUntilMorning(new Date(2026, 2, 10, 6, 0), 8)).toBe(120);
    expect(minutesUntilMorning(new Date(2026, 2, 10, 8, 0), 8)).toBe(24 * 60);
    expect(pauseMinutes("none", new Date())).toBeUndefined();
    expect(pauseMinutes("hour", new Date())).toBe(60);
    expect(pauseMinutes("morning", new Date(2026, 2, 10, 22, 30))).toBe(9 * 60 + 30);
  });
});

describe("as palavras do escopo de tipos", () => {
  const OWNER = { kind: "owner" as const };
  const AGENT = { kind: "agent" as const };
  const layer = (by: PaceScope["by"], types: PaceScope["types"], over: Partial<PaceScope> = {}): PaceScope => ({ types, by, at: iso(NOW - 12 * 60_000), ...over });
  const fixes = [...FIXES_ONLY_TYPES];
  const scoped = (row: Partial<BoardPaceRow>, waiting = 0) => {
    const v = view({ board: "acme", ...row });
    return { ...v, scopeWaiting: waiting };
  };

  it("as cinco palavras fixas do dono", () => {
    expect(SCOPE_TYPE_WORDS).toEqual({ user: "Funcionalidade nova", bug: "Erro", technical: "Trabalho técnico", chore: "Manutenção", spike: "Investigação" });
  });

  it("os dois botões da primeira entrega: «Tudo» e «Só consertos e manutenção» (erro, técnico, manutenção, investigação)", () => {
    expect(SCOPE_PRESETS.map((p) => p.label)).toEqual(["Tudo", "Só consertos e manutenção"]);
    expect(SCOPE_PRESETS[0].types).toBe("all");
    expect([...(SCOPE_PRESETS[1].types as readonly string[])].sort()).toEqual(["bug", "chore", "spike", "technical"]);
    expect(SCOPE_PRESETS[1].help).toMatch(/Não começa funcionalidade nova/);
    expect(SCOPE_AXIS_HELP).toMatch(/QUANTO.*O QUE/);
  });

  it("scopeLabel / scopeChipSuffix: o preset tem nome próprio; uma combinação livre diz os tipos", () => {
    expect(scopeLabel(null)).toBe("Tudo");
    expect(scopeLabel(fixes)).toBe("Só consertos e manutenção");
    expect(scopeLabel(["bug", "chore"])).toBe("Só erro e manutenção");
    expect(scopeLabel(["user", "bug"])).toBe("Só funcionalidade nova e erro");
    expect(scopeChipSuffix(view(null))).toBeNull();
    expect(scopeChipSuffix(scoped({ ownerScope: layer(OWNER, fixes) }))).toBe("só consertos");
    expect(scopeChipSuffix(scoped({ ownerScope: layer(OWNER, ["bug"]) }))).toBe("só erro");
  });

  it("a linha do escopo: quem, há quanto e até quando — a contagem de cards esperando NÃO está nela (C9: é dita uma vez, por scopeWaitingWords)", () => {
    const mine = scoped({ ownerScope: layer(OWNER, fixes, { until: iso(NOW + 3 * 3_600_000) }) }, 7);
    expect(scopeStatusLine(mine, NOW, "UTC")).toBe("Só consertos e manutenção por você · há 12 min · tudo volta às 18:00");
    expect(scopeStatusLine(scoped({ agentScope: layer(AGENT, ["bug"]) }, 1), NOW, "UTC")).toBe("Só erro por um agente · há 12 min");
    expect(scopeStatusLine(view(null), NOW)).toBeNull();
  });

  it("C9: a contagem «N cards esperando» aparece UMA vez só no que o painel mostra (a linha de estado + a frase de espera)", () => {
    const v = scoped({ ownerScope: layer(OWNER, fixes) }, 7);
    const shown = [paceStatusLine(v, NOW, "UTC"), scopeWaitingWords(v)].join("\n");
    expect(shown.match(/esperando/g)).toHaveLength(1);
    expect(scopeWaitingWords(v)).toBe("7 cards de funcionalidade esperando");
  });

  it("C9: com o ritmo PAUSADO a linha de estado não carrega o escopo (nada começa, de qualquer tipo)", () => {
    const paused = scoped({ owner: { level: "paused", by: OWNER, at: iso(NOW - 60_000) }, ownerScope: layer(OWNER, fixes) }, 3);
    expect(paceStatusLine(paused, NOW, "UTC")).toBe("Pausado por você · há 1 min");
    const slow = scoped({ owner: { level: "slow", by: OWNER, at: iso(NOW - 60_000) }, ownerScope: layer(OWNER, fixes) }, 3);
    expect(paceStatusLine(slow, NOW, "UTC")).toMatch(/Só consertos e manutenção por você/);
  });

  it("a linha de estado do ritmo leva o escopo junto, em qualquer ritmo — e sem escopo é a de sempre", () => {
    const normal = scoped({ ownerScope: layer(OWNER, fixes) });
    expect(paceStatusLine(normal, NOW, "UTC")).toBe("Ritmo normal · Só consertos e manutenção por você · há 12 min");
    const slow = scoped({ agent: { level: "slow", by: AGENT, at: iso(NOW - 60_000) }, ownerScope: layer(OWNER, fixes) });
    expect(paceStatusLine(slow, NOW, "UTC")).toMatch(/^Devagar por um agente · há 1 min · Só consertos e manutenção por você/);
    expect(paceStatusLine(view(null), NOW)).toBe("Ritmo normal");
    // desarmado e ilegível não falam de escopo (o portão segura tudo antes)
    expect(paceStatusLine(view({ board: "acme", ownerScope: layer(OWNER, fixes) }, { autorunDisabled: true }), NOW)).toMatch(/está desligado/);
    expect(paceStatusLine(view(null, {}, true), NOW)).toMatch(/^Tudo parado: /);
  });

  it("a linha do histórico de escopo: quem e há quanto; «Tudo» e o prazo vencido", () => {
    expect(scopeHistoryLine({ types: fixes, by: AGENT, at: iso(NOW - 2 * 3_600_000), reason: "cota apertada" }, NOW)).toBe("Só consertos e manutenção por um agente · há 2 h — cota apertada");
    expect(scopeHistoryLine({ types: null, by: OWNER, at: iso(NOW - 60_000), expired: true }, NOW)).toMatch(/^Tudo \(o prazo venceu\) · há /);
    expect(scopeHistoryLine({ types: null, by: OWNER, at: iso(NOW - 3_600_000) }, NOW)).toBe("Tudo por você · há 1 h");
  });

  it("o aviso das funcionalidades prontas que vão junto na publicação (R8): no singular, no plural e calado em zero", () => {
    expect(featuresToShipWords(0)).toBeNull();
    expect(featuresToShipWords(1)).toBe("1 funcionalidade pronta na entrega vai junto na próxima publicação.");
    expect(featuresToShipWords(3)).toBe("3 funcionalidades prontas na entrega vão junto na próxima publicação.");
  });
});

// O botão e o painel do cabeçalho (components/nav/BoardPaceChip.tsx) não têm teste de renderização neste pacote: o que
// eles dizem sai destas funções puras, e é aqui que se fixa.
describe("o botão do cabeçalho e o painel do escopo", () => {
  const ownerFixes = (extra: Partial<PaceScope> = {}): BoardPaceRow => ({
    board: "acme",
    ownerScope: { types: [...FIXES_ONLY_TYPES], by: { kind: "owner" }, at: iso(NOW - 60_000), ...extra },
  });

  it("o chip diz o ritmo e, com limite, «só consertos»: «Normal · só consertos», «Devagar · só consertos»", () => {
    expect(paceChipValue(view(null))).toBe("Normal");
    expect(paceChipValue(view(ownerFixes()))).toBe("Normal · só consertos");
    const slow = view({ ...ownerFixes(), agent: { level: "slow", by: { kind: "agent" }, at: iso(NOW - 60_000) } });
    expect(paceChipValue(slow)).toBe("Devagar · só consertos");
    // pausado: o escopo é irrelevante para o ritmo, mas segue dito (volta com a retomada)
    const paused = view({ ...ownerFixes(), owner: { level: "paused", by: { kind: "owner" }, at: iso(NOW - 60_000) } });
    expect(paceChipValue(paused)).toBe("Pausado · só consertos");
  });

  it("um recorte livre aparece pelas palavras dos tipos, em minúsculas", () => {
    const only = view({ board: "acme", ownerScope: { types: ["bug", "chore"], by: { kind: "owner" }, at: iso(NOW - 60_000) } });
    expect(paceChipValue(only)).toBe("Normal · só erro e manutenção");
  });

  it("desarmado e ilegível não levam escopo: seguram tudo antes de olhar tipo", () => {
    expect(paceChipValue(view(ownerFixes(), { autorunDisabled: true }))).toBe("Desligado");
    expect(paceChipValue(view(ownerFixes(), {}, true))).toBe("Pausado");
  });

  it("o rosto do chip, estado a estado: lendo, indisponível e pronto (pausado/devagar/normal × sem e com escopo)", () => {
    expect(paceChipFace(null, false, NOW)).toEqual({ state: "loading", value: PACE_LOADING_VALUE, title: PACE_PANEL_LOADING, ariaLabel: "Ritmo do board — lendo" });
    expect(paceChipFace(null, true, NOW)).toEqual({ state: "unavailable", value: PACE_UNAVAILABLE_VALUE, title: PACE_PANEL_UNAVAILABLE, ariaLabel: "Ritmo do board — indisponível" });
    const at = iso(NOW - 60_000);
    const casos: Array<[BoardPaceRow, string]> = [
      [{ board: "acme" }, "Normal"],
      [{ board: "acme", agent: { level: "slow", by: { kind: "agent" }, at } }, "Devagar"],
      [{ board: "acme", owner: { level: "paused", by: { kind: "owner" }, at } }, "Pausado"],
      [ownerFixes(), "Normal · só consertos"],
      [{ ...ownerFixes(), agent: { level: "slow", by: { kind: "agent" }, at } }, "Devagar · só consertos"],
      [{ ...ownerFixes(), owner: { level: "paused", by: { kind: "owner" }, at } }, "Pausado · só consertos"],
    ];
    for (const [row, rotulo] of casos) {
      const face = paceChipFace(view(row), false, NOW);
      expect(face, rotulo).toMatchObject({ state: "ready", value: rotulo, ariaLabel: `Ritmo do board — ${rotulo}` });
      // uma leitura boa anterior vale mais que um erro novo
      expect(paceChipFace(view(row), true, NOW).value, rotulo).toBe(rotulo);
    }
    // o valor de leitura nunca é um nível (o chip não afirma «Normal» antes de ler)
    for (const v of [PACE_LOADING_VALUE, PACE_UNAVAILABLE_VALUE]) expect(["Normal", "Devagar", "Pausado"]).not.toContain(v);
  });

  it("escopo vencido some do chip junto com o prazo", () => {
    expect(paceChipValue(view(ownerFixes({ until: iso(NOW - 1_000) })))).toBe("Normal");
  });

  it("«N cards de funcionalidade esperando» (preset de consertos) e «N cards esperando» (recorte livre); nada quando nenhum espera", () => {
    const fixes = view(ownerFixes());
    expect(scopeWaitingWords({ ...fixes, scopeWaiting: 0 })).toBeNull();
    expect(scopeWaitingWords({ ...fixes, scopeWaiting: 1 })).toBe("1 card de funcionalidade esperando");
    expect(scopeWaitingWords({ ...fixes, scopeWaiting: 7 })).toBe("7 cards de funcionalidade esperando");
    const free = view({ board: "acme", ownerScope: { types: ["bug"], by: { kind: "owner" }, at: iso(NOW - 60_000) } });
    expect(scopeWaitingWords({ ...free, scopeWaiting: 3 })).toBe("3 cards esperando");
    // sem limite não há o que esperar por causa do escopo
    expect(scopeWaitingWords({ ...view(null), scopeWaiting: 5 })).toBeNull();
  });

  it("o painel explica que o escopo muda O QUÊ e o ritmo muda O QUANTO — e que o escopo sozinho não poupa cota", () => {
    expect(SCOPE_AXIS_HELP).toMatch(/QUANTO.*O QUE/);
    expect(SCOPE_QUOTA_HELP).toMatch(/não gasta menos/);
    expect(SCOPE_QUOTA_HELP).toMatch(/poupar cota, use o ritmo/);
    expect(SCOPE_BOUNDS_HELP).toMatch(/só segura a construção/i);
    expect(SCOPE_BOUNDS_HELP).toMatch(/publicado normalmente/);
  });

  it("os dois botões do painel: «Tudo» e «Só consertos e manutenção», com a ajuda em português claro", () => {
    expect(SCOPE_PRESETS.map((p) => p.label)).toEqual(["Tudo", "Só consertos e manutenção"]);
    const fixes = SCOPE_PRESETS.find((p) => p.id === "fixes")!;
    expect(fixes.help).toMatch(/erro, trabalho técnico, manutenção e investigação/);
    expect(fixes.help).toMatch(/Não começa funcionalidade nova/);
  });
});

describe("a leitura do ritmo — o chip não diz «Normal» enquanto lê", () => {
  const slowFixes = () => ({ ...view({ board: "acme", owner: { level: "slow", by: { kind: "owner" }, at: iso(NOW - 60_000) }, ownerScope: { types: [...FIXES_ONLY_TYPES], by: { kind: "owner" }, at: iso(NOW - 60_000) } }), scopeWaiting: 0 });

  it("sem leitura e sem falha: «Ritmo…», sem texto de nível", () => {
    const f = paceChipFace(null, false, NOW);
    expect(f.state).toBe("loading");
    expect(f.value).toBe(PACE_LOADING_VALUE);
    expect(f.value).not.toMatch(/normal|devagar|pausado/i);
    expect(f.ariaLabel).not.toMatch(/normal/i);
  });

  it("a leitura falhou e não há nenhuma: «Ritmo indisponível», nunca «Normal»", () => {
    const f = paceChipFace(null, true, NOW);
    expect(f.state).toBe("unavailable");
    expect(f.value).toBe(PACE_UNAVAILABLE_VALUE);
    expect(`${f.value} ${f.title} ${f.ariaLabel}`).not.toMatch(/normal/i);
    expect(f.title).toBe(PACE_PANEL_UNAVAILABLE);
  });

  it("com leitura: o ritmo real (o caso do dono — «Devagar · só consertos»)", () => {
    const f = paceChipFace(slowFixes(), false, NOW, "UTC");
    expect(f.state).toBe("ready");
    expect(f.value).toBe("Devagar · só consertos");
    expect(f.ariaLabel).toBe("Ritmo do board — Devagar · só consertos");
  });

  it("uma leitura boa vale mais que um erro novo (o poll que falha não apaga o ritmo)", () => {
    expect(paceReadState(slowFixes(), true)).toBe("ready");
    expect(paceChipFace(slowFixes(), true, NOW).value).toBe("Devagar · só consertos");
    expect(paceReadState(null, false)).toBe("loading");
    expect(paceReadState(null, true)).toBe("unavailable");
  });
});

describe("a tela de cota — uso da semana é uma coisa, trava engatada é outra", () => {
  const CAPS = { weekCapPct: 80, weekCapLast24hPct: 90, fiveHourCapPct: 85, latchWeekPct: 92, latchFiveHourPct: 90 };
  const reading = (usage7dPct: number, usage5hPct: number | null = 10) => ({ usage7dPct, usage5hPct, resetsAt7d: NOW + 86_400_000, resetsAt5h: NOW + 3_600_000, polledAt: NOW, extraUsageEnabled: false, stale: false });
  const latch = (over: Partial<EffectiveLatch> = {}): EffectiveLatch => ({ level: "soft", reason: "janela de 7 dias em 93%", at: NOW - 3_600_000, trippedBy: "auto:week", source: "file", ...over });
  const gov = (l: EffectiveLatch | null, r = reading(4)) => ({ latch: l, reading: r, caps: CAPS });

  it("o medidor de uso não fala de trava, com ou sem trava engatada", () => {
    const w = quotaUsageWords({ pct: 4, estimate: false, stale: false });
    expect(w.value).toBe("Cota 7d 4%");
    expect(w.title).toBe("Uso Claude — 4% da semana");
    expect(`${w.value} ${w.title} ${w.ariaLabel}`).not.toMatch(/trava/i);
    expect(quotaUsageWords({ pct: 4.4, estimate: true, stale: false }).value).toBe("Cota 7d 4%≈");
    expect(quotaUsageWords({ pct: null, estimate: false, stale: false }).value).toBe("Cota 7d —");
    expect(quotaUsageWords({ pct: 40, estimate: false, stale: true, ageWords: "há 2h" }).title).toBe("Uso Claude — número defasado (proxy atualizou há 2h)");
  });

  it("sem trava não há selo", () => {
    expect(latchSealWords(gov(null), 4)).toBeNull();
    expect(latchSealWords(null)).toBeNull();
    expect(latchSealWords(undefined)).toBeNull();
  });

  it("trava com uso ALTO: a frase da trava, sem dizer que o uso baixou", () => {
    const s = latchSealWords(gov(latch(), reading(95)), 95)!;
    expect(s.headline).toBe(LATCH_SEAL_HEADLINE);
    expect(s.headline).toMatch(/nada automático começa/);
    expect(s.usageBelow).toBe(false);
    expect(s.note).toBeNull();
    expect(s.title).toBe(LATCH_SEAL_HEADLINE);
  });

  it("trava posta pela medição com o uso já abaixo do teto: «o uso já baixou… solta sozinha quando a janela virar ou a cota for zerada»", () => {
    const s = latchSealWords(gov(latch()), 4)!;
    expect(s.usageBelow).toBe(true);
    expect(s.note).toBe("o uso já baixou: a trava solta sozinha quando a janela virar ou a cota for zerada, ou pelo operador");
    expect(s.title).toContain(LATCH_SEAL_HEADLINE);
    expect(s.title).toContain(s.note!);
  });

  it("trava do operador/agente/dura NÃO promete soltar com a janela", () => {
    for (const l of [latch({ trippedBy: "operator" }), latch({ trippedBy: "mcp:soft" }), latch({ level: "hard" }), latch({ trippedBy: "unknown" })]) {
      const s = latchSealWords(gov(l), 4)!;
      expect(s.note).toBe("o uso já baixou, mas a trava segue: só o operador solta");
      expect(s.note).not.toMatch(/janela virar/);
    }
  });

  it("uso extra (pago) e HALT do host: o uso baixo não é o assunto", () => {
    expect(latchSealWords(gov(latch({ trippedBy: "auto:extra-usage" })), 4)!.note).toBeNull();
    expect(latchSealWords(gov(latch({ source: "halt", level: "hard", trippedBy: "host:HALT" })), 4)!.note).toBeNull();
  });

  it("a janela de 5h ainda no teto conta como uso alto; sem 5h medida só o 7d decide; o número da tela vence a leitura", () => {
    expect(latchSealWords(gov(latch(), reading(4, 91)), 4)!.usageBelow).toBe(false);
    expect(latchSealWords(gov(latch(), reading(4, null)), 4)!.usageBelow).toBe(true);
    // a tela mostra o do proxy (4%); a leitura do governador (95%) é velha — vale o que o operador está vendo
    expect(latchSealWords(gov(latch(), reading(95)), 4)!.usageBelow).toBe(true);
    // sem número da tela, cai na leitura do governador
    expect(latchSealWords(gov(latch(), reading(95)))!.usageBelow).toBe(false);
    // sem nenhum número de uso não se afirma que baixou
    expect(latchSealWords({ latch: latch(), reading: null, caps: CAPS })!.note).toBeNull();
  });
});
