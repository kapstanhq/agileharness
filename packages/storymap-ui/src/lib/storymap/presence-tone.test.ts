// A cor de cada presença — o que o dono aprende uma vez e lê igual em toda tela:
//   • o mapa é exaustivo e só `working` pulsa (um pulso sobre quem não trabalha era uma mentira);
//   • a fila e o parado nunca usam a cor do dono nem a do erro (âmbar «na fila» no card contradizia o nav);
//   • os tokens `--state-*` passam AA nos dois temas: ≥4,5:1 quando viram TEXTO, ≥3:1 quando são forma/filete.
// Contraste medido sobre os TOKENS de globals.css (a fórmula do WCAG 2.x), como o inbox-a11y.test.ts faz.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CARD_PRESENCE, CARD_PRESENCES, presencePulses, type CardLiveKind } from "./card-live-status";
import { LEGEND_ORDER, PRESENCE_TONE, presenceTone } from "./presence-tone";

const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

type Rgb = [number, number, number];
function tokens(selector: string): Record<string, Rgb> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, Rgb> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}
const lum = ([r, g, b]: Rgb) => {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const light = tokens(":root");
const dark = { ...light, ...tokens(".dark") };

describe("os tokens de estado passam AA nos dois temas", () => {
  it.each([
    ["claro", light],
    ["escuro", dark],
  ])("tema %s: as cores que viram TEXTO passam de 4,5:1 na superfície e no papel", (_t, t) => {
    for (const k of ["state-working", "state-delivering", "state-live", "danger"]) {
      for (const bg of ["surface", "canvas"]) expect(contrast(t[k], t[bg]), `${k}/${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["claro", light],
    ["escuro", dark],
  ])("tema %s: toda cor de estado, como filete ou forma, passa de 3:1 na superfície", (_t, t) => {
    for (const k of ["state-owner", "state-working", "state-delivering", "state-idle", "danger"]) {
      expect(contrast(t[k], t.surface), k).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    ["claro", light],
    ["escuro", dark],
  ])("tema %s: a letra sobre o âmbar do dono e sobre o terracota passa de 4,5:1", (_t, t) => {
    expect(contrast(t["state-owner-fg"], t["state-owner"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["danger-fg"], t.danger)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("PRESENCE_TONE — uma cor, um significado", () => {
  it("cobre as seis presenças, e a legenda as lista uma vez cada", () => {
    expect(Object.keys(PRESENCE_TONE).sort()).toEqual([...CARD_PRESENCES].sort());
    expect([...LEGEND_ORDER].sort()).toEqual([...CARD_PRESENCES].sort());
  });

  it("só quem trabalha pulsa — e a régua é a mesma de card-live-status", () => {
    for (const p of CARD_PRESENCES) expect(PRESENCE_TONE[p].pulse, p).toBe(presencePulses(p));
  });

  it("a fila e o parado nunca usam a cor do dono nem a do erro; a fila é tracejada, o parado é o círculo vazio", () => {
    for (const kind of ["queued", "quiet", "waiting"] as CardLiveKind[]) {
      const t = presenceTone({ kind, presence: CARD_PRESENCE[kind] });
      expect(`${t.dot} ${t.rail} ${t.text}`).not.toMatch(/state-owner|danger/);
    }
    expect(presenceTone({ kind: "queued", presence: "waiting" }).mark).toBe("dashed");
    expect(presenceTone({ kind: "quiet", presence: "waiting" }).mark).toBe("ring");
  });

  it("âmbar é só do dono; terracota só do que falhou; verde só no texto do «No ar»", () => {
    for (const p of CARD_PRESENCES) {
      const all = `${PRESENCE_TONE[p].dot} ${PRESENCE_TONE[p].rail} ${PRESENCE_TONE[p].text}`;
      if (p !== "owner") expect(all, p).not.toMatch(/state-owner/);
      if (p !== "stopped") expect(all, p).not.toMatch(/danger/);
      if (p !== "live") expect(all, p).not.toMatch(/state-live/);
    }
    expect(PRESENCE_TONE.live.rail).toBe("bg-transparent");
    expect(PRESENCE_TONE.live.mark).toBe("none");
  });
});
