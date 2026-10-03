import { describe, expect, it } from "vitest";
import { createFlushScheduler, nextFlushDelayMs, openQuarantinePaths, QUARANTINE_FINDING_ID, quarantineFinding, quarantineFindingUpdate } from "./board-data-flush";

// O agendador do flush de board-data: debounce COM TETO. O debounce puro rearmava o timer a cada escrita e, com escritas
// mais frequentes que a janela quieta, NUNCA disparava. Num caso real, o laço de publicação escrevia um card a cada
// poucos segundos por horas, e vários cards ficaram sujos no checkout de runtime sem um único commit.

/** Relógio e timers manuais: nada de timer real, nada de espera. */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    /** avança o relógio, disparando os timers na ordem em que vencem */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = end;
    },
  };
}

describe("nextFlushDelayMs — a janela quieta, mas nunca além do teto", () => {
  it("no começo da rajada espera a janela inteira", () => {
    expect(nextFlushDelayMs(1_000, 1_000, 5_000, 60_000)).toBe(5_000);
  });
  it("perto do teto espera só o que falta (o disparo não escorrega além dele)", () => {
    expect(nextFlushDelayMs(0, 58_000, 5_000, 60_000)).toBe(2_000);
  });
  it("FRONTEIRA: no instante do teto e depois dele dispara já (0, nunca negativo)", () => {
    expect(nextFlushDelayMs(0, 60_000, 5_000, 60_000)).toBe(0);
    expect(nextFlushDelayMs(0, 75_000, 5_000, 60_000)).toBe(0);
  });
});

describe("createFlushScheduler", () => {
  const make = (over: { debounceMs?: number; maxWaitMs?: number } = {}) => {
    const c = clock();
    const fires: number[] = [];
    const s = createFlushScheduler({
      debounceMs: over.debounceMs ?? 5_000,
      maxWaitMs: over.maxWaitMs ?? 60_000,
      now: c.now,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      fire: () => fires.push(c.now()),
    });
    return { c, s, fires };
  };

  it("uma escrita isolada dispara UMA vez, depois da janela quieta", () => {
    const { c, s, fires } = make();
    s.schedule();
    c.advance(4_999);
    expect(fires).toEqual([]);
    c.advance(1);
    expect(fires).toEqual([5_000]);
    expect(s.pending()).toBe(false);
  });

  it("uma rajada curta (10 escritas em 1 s) vira UM disparo — o debounce continua coalescendo", () => {
    const { c, s, fires } = make();
    for (let i = 0; i < 10; i++) {
      s.schedule();
      c.advance(100);
    }
    c.advance(10_000);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toBe(1_000 + 5_000 - 100); // a última escrita foi em t=900; dispara 5 s depois
  });

  it("[A PROPRIEDADE DO INCIDENTE] escritas a cada 2 s por 10 min: dispara a cada ≤60 s, não nunca", () => {
    const { c, s, fires } = make();
    for (let t = 0; t < 10 * 60_000; t += 2_000) {
      s.schedule();
      c.advance(2_000);
    }
    expect(fires.length).toBeGreaterThanOrEqual(9);
    // e o intervalo entre disparos nunca passa do teto
    const gaps = fires.map((t, i) => t - (fires[i - 1] ?? 0));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60_000);
  });

  it("depois de um disparo a contagem do teto recomeça na PRÓXIMA rajada (não herda a anterior)", () => {
    const { c, s, fires } = make();
    s.schedule();
    c.advance(5_000); // dispara
    c.advance(120_000); // silêncio longo
    s.schedule();
    c.advance(5_000);
    expect(fires).toEqual([5_000, 130_000]);
  });

  it("o teto nunca é menor que a janela quieta (uma configuração incoerente não dispara antes do debounce)", () => {
    const { c, s, fires } = make({ debounceMs: 5_000, maxWaitMs: 5_000 });
    s.schedule();
    c.advance(3_000);
    s.schedule(); // rearma: restam 2 s até o teto
    c.advance(1_999);
    expect(fires).toEqual([]);
    c.advance(1);
    expect(fires).toEqual([5_000]);
  });
});

// WP5-F1 — o ACHADO da quarentena. O isolamento mora no commit de board-data (board-quarantine.test.ts); o flush é o
// dono só do aviso no card: um card recusado ficou fora do git sem ninguém saber por quê.
describe("quarantineFinding — o achado que o card em quarentena carrega", () => {
  it("é do sistema, de segurança, não-bloqueante, aponta arquivo e linha", () => {
    const BAD = "storymap/boards/b/cards/story-bad.md";
    const f = quarantineFinding({ path: BAD, detail: `✗ [naked-high-entropy-token] ${BAD}:175 → abcd…wxyz` });
    expect(f).toMatchObject({ id: QUARANTINE_FINDING_ID, lens: "security", severity: "high", status: "open", file: BAD, line: 175 });
    expect(f.detail).toContain("FORA do commit");
  });
});

// WP5-F2 — resíduos da quarentena: a triagem do dono era desfeita no flush seguinte (o `status` entrava na
// comparação), e o conjunto acompanhado só existia na memória do processo (depois de um restart o achado de um card
// já limpo nunca fechava).
describe("quarantineFindingUpdate — a triagem do dono vale", () => {
  const q = { path: "storymap/boards/b/cards/story-x.md", detail: "storymap/boards/b/cards/story-x.md:12 high-entropy-backtick" };
  const minted = () => quarantineFinding(q);
  it("primeira quarentena: o achado nasce aberto; o mesmo achado aberto não reescreve", () => {
    expect(quarantineFindingUpdate([], q)).toEqual([minted()]);
    expect(quarantineFindingUpdate([minted()], q)).toBeNull();
  });
  it("o dono triou (wontfix) o MESMO achado ⇒ nada é reescrito; um trecho NOVO reabre", () => {
    const triaged = { ...minted(), status: "wontfix" as const, statusBy: "human", statusAt: "2026-10-01" };
    expect(quarantineFindingUpdate([triaged], q)).toBeNull();
    const other = { ...q, detail: "storymap/boards/b/cards/story-x.md:40 aws-access-key-id" };
    expect(quarantineFindingUpdate([triaged], other)?.[0]).toMatchObject({ status: "open", detail: expect.stringMatching(/:40/) });
  });
  it("fechado pelo próprio flush (o card tinha voltado limpo) e de novo em quarentena ⇒ reabre", () => {
    const closed = { ...minted(), status: "fixed" as const, statusBy: "board-flush", statusAt: "2026-10-01" };
    expect(quarantineFindingUpdate([closed], q)?.[0]).toMatchObject({ status: "open" });
  });
});

describe("openQuarantinePaths — o que acompanhar depois de um restart", () => {
  it("só os achados de quarentena ABERTOS, pelo caminho do achado (ou o do card)", () => {
    const open = (file?: string) => ({ ...quarantineFinding({ path: file ?? "x", detail: "d" }), ...(file ? {} : { file: undefined }) });
    const boards = [
      {
        id: "b",
        cards: [
          { id: "story-a", findings: [open("storymap/boards/b/cards/story-a.md")] },
          { id: "story-b", findings: [{ ...open("storymap/boards/b/cards/story-b.md"), status: "fixed" as const }] },
          { id: "story-c", findings: [open()] },
          { id: "story-d" },
        ],
      },
    ];
    expect(openQuarantinePaths(boards)).toEqual(["storymap/boards/b/cards/story-a.md", "storymap/boards/b/cards/story-c.md"]);
  });
});

