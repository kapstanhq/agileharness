// O SINAL de um card (o push e a linha do card no Kanban) — o «o quê» que espera o dono é um substantivo curto, nunca o
// rótulo de um botão («Pedir ao Jido…»), e o sinal só existe quando o Inbox mostra o card em Decidir.

import { describe, expect, it } from "vitest";
import type { CockpitItemKind } from "../demands";
import type { Card } from "../types";
import { cardInboxSignal } from "./card-signal";
import { INBOX_KIND_NOUN } from "./copy";
import { decideItem } from "./decision";
import { FIXTURES, HUMAN, KINDS, MODES, NOW, ctx, mkCard } from "./items.fixture";

describe("o «o quê» do sinal", () => {
  it("cada kind tem um substantivo de até 24 caracteres", () => {
    for (const kind of KINDS) {
      expect(INBOX_KIND_NOUN[kind].length, kind).toBeGreaterThan(0);
      expect(INBOX_KIND_NOUN[kind].length, kind).toBeLessThanOrEqual(24);
    }
  });

  it("nunca é o rótulo de uma opção do item (o que espera o dono não é um botão)", () => {
    for (const [, config] of MODES) {
      for (const kind of KINDS) {
        const d = decideItem(FIXTURES[kind].item, ctx(config, FIXTURES[kind].card));
        const labels = [...d.options, ...d.more].map((o) => o.label);
        expect(labels, kind).not.toContain(INBOX_KIND_NOUN[kind as CockpitItemKind]);
        expect(INBOX_KIND_NOUN[kind]).not.toMatch(/Pedir ao Jido/);
      }
    }
  });

  it("o card com uma decisão em Decidir carrega o sinal com o «o quê»; sem decisão, não há sinal", () => {
    const atRelease = mkCard({ status: "release", stagedAt: "2026-09-20", reviewedAt: "2026-09-19" } as Partial<Card>);
    const sig = cardInboxSignal(atRelease, HUMAN, "b1", { now: NOW });
    expect(sig?.what).toBe(INBOX_KIND_NOUN[sig!.kind]);
    expect(sig?.label).not.toMatch(/Pedir ao Jido/);
    expect(cardInboxSignal(mkCard({ status: "concluida" }), HUMAN, "b1", { now: NOW })).toBeNull();
  });
});
