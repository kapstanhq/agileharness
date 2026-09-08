import { describe, it, expect } from "vitest";
import { rearmAllowed, rearmNoopItem } from "./noop-rearm";
import { emptyOrchestratorState, itemsInNoopBackoff, readOrchestratorState, writeOrchestratorState } from "./orchestrator-state";
import { readCopilotActivity } from "@/lib/storymap/copilot/activity";
import { AUTONOMO_DOCTRINE_VERSION } from "@/lib/storymap/copilot/tier";

// WS-12.3 (D16) — as três saídas do backoff têm DONO. Aqui as duas explícitas: o humano (1 clique, sem
// justificativa) e o steward (só com prova de que o fato mudou — dúvida ⇒ o item fica com o humano).

const NOW = Date.parse("2026-07-16T15:00:00Z");
const seeded = async (board: string) => {
  await writeOrchestratorState(board, { ...emptyOrchestratorState(NOW), noopByItem: { "story-xfleex:approval:release": { streak: 4, doctrine: AUTONOMO_DOCTRINE_VERSION } } });
};

describe("WS-12.3 — rearmAllowed: a política, pura", () => {
  it("o humano re-arma sem prova nenhuma (advisory — ele não deve satisfação à máquina)", () => {
    expect(rearmAllowed("human")).toEqual({ ok: true });
  });

  it("o steward SEM prova NÃO re-arma, e a recusa diz o que fazer (fail-closed, igual a D14/D11)", () => {
    const r = rearmAllowed("steward");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/PROVA/);
  });

  it("prova com detalhe VAZIO não é prova (uma alegação não destrava)", () => {
    expect(rearmAllowed("steward", { kind: "deploy-recovered", detail: "   " }).ok).toBe(false);
  });

  it("o steward COM prova de fato re-arma", () => {
    expect(rearmAllowed("steward", { kind: "deploy-recovered", detail: "deploy de story-abc passou às 15:40" })).toEqual({ ok: true });
  });
});

describe("WS-12.3 — rearmNoopItem: destrava e deixa rastro", () => {
  it("o re-arm humano zera o streak (o item volta a ser acionável) e o diário registra QUEM re-armou", async () => {
    const board = `probe-rearm-h-${Math.floor(NOW % 100000)}`;
    await seeded(board);
    expect(await rearmNoopItem({ board, itemId: "story-xfleex:approval:release", by: "human" })).toEqual({ ok: true });

    const after = await readOrchestratorState(board, NOW);
    expect(itemsInNoopBackoff(after).size).toBe(0);
    expect((await readCopilotActivity(board)).at(-1)?.text).toMatch(/re-armou/i);
  });

  it("o steward SEM prova não toca no estado — o item continua em backoff, com o humano", async () => {
    const board = `probe-rearm-s0-${Math.floor(NOW % 100000)}`;
    await seeded(board);
    const r = await rearmNoopItem({ board, itemId: "story-xfleex:approval:release", by: "steward" });
    expect(r.ok).toBe(false);
    expect(itemsInNoopBackoff(await readOrchestratorState(board, NOW))).toEqual(new Set(["story-xfleex:approval:release"]));
  });

  it("o steward COM prova re-arma e ANOTA a prova no diário (auditável pelo operador)", async () => {
    const board = `probe-rearm-s1-${Math.floor(NOW % 100000)}`;
    await seeded(board);
    const proof = { kind: "delta-landed", detail: "deltaLanded: patch-id no alvo (main)" } as const;
    expect(await rearmNoopItem({ board, itemId: "story-xfleex:approval:release", by: "steward", proof })).toEqual({ ok: true });

    expect(itemsInNoopBackoff(await readOrchestratorState(board, NOW)).size).toBe(0);
    const last = (await readCopilotActivity(board)).at(-1);
    expect(last?.text).toMatch(/delta-landed/);
    expect(last?.detail).toBe(proof.detail);
  });

  it("prova `deploy-recovered` do steward: destrava E a ENTRADA PERSISTE com o carimbo (o teto não se apaga)", async () => {
    // As duas saídas escrevem coisas DIFERENTES: o humano apaga a entrada; a máquina zera o streak e carimba.
    // Se o steward passasse por clearNoopItem, cada re-arm apagaria a prova de que ele já re-armou — um teto
    // que esquece não é teto, e o re-arm de máquina seria ilimitado por construção.
    const board = `probe-rearm-s2-${Math.floor(NOW % 100000)}`;
    await writeOrchestratorState(board, {
      ...emptyOrchestratorState(NOW),
      noopByItem: { "story-xfleex:approval:release": { streak: 4, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: false } } },
    });
    const proof = { kind: "deploy-recovered", detail: "alvos e superfície declarada carregam 47a8edd9c" } as const;
    expect(await rearmNoopItem({ board, itemId: "story-xfleex:approval:release", by: "steward", proof })).toEqual({ ok: true });

    const after = await readOrchestratorState(board, NOW);
    expect(itemsInNoopBackoff(after).size).toBe(0); // destravou
    const entry = after.noopByItem?.["story-xfleex:approval:release"];
    expect(entry?.streak).toBe(0);
    expect(entry?.rearmedByStewardAt).toBeTruthy(); // o teto sobrevive ao re-arm que ele limita
    expect(entry?.observed).toEqual({ deployProven: false }); // e a baseline também
    expect((await readCopilotActivity(board)).at(-1)?.text).toMatch(/deploy-recovered/);
  });
});
