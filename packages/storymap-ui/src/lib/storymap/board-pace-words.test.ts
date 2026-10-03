import { describe, expect, it } from "vitest";
import { minutesUntilMorning, paceHistoryLine, paceStatusLine, paceWhoWords, pauseMinutes } from "./board-pace-words";
import { paceViewOf, type BoardPaceRow } from "./runner/board-pace";

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
