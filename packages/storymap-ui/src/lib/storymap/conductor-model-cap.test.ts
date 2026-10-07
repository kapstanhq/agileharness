// O modelo do condutor pelo TIPO do card (decisão do dono, 06/10): «Sonnet para bug e manutenção; Opus SÓ em história
// de usuário e risco alto» — todo tipo que não é de usuário roda em Sonnet; o teto explícito do card sempre vence.

import { describe, expect, it } from "vitest";
import { conductorModelCapFor, conductorModelFor, isHandOpenedConductor, TYPE_MODEL_CAP_MARK, withTypeModelCap } from "./driver";
import type { Card } from "./types";

type CapInput = Parameters<typeof conductorModelCapFor>[0];
const card = (over: Partial<Card> = {}): CapInput => ({ storyType: "user", ...over }) as CapInput;

describe("conductorModelCapFor", () => {
  it("bug, chore e uma história reaberta em `mode: fix` ⇒ sonnet", () => {
    expect(conductorModelCapFor(card({ storyType: "bug" }))).toBe("sonnet");
    expect(conductorModelCapFor(card({ storyType: "chore" }))).toBe("sonnet");
    expect(conductorModelCapFor(card({ storyType: "user", mode: "fix" }))).toBe("sonnet");
  });

  it("história técnica e spike também ⇒ sonnet (Opus é SÓ de história de usuário e de risco alto)", () => {
    expect(conductorModelCapFor(card({ storyType: "technical" }))).toBe("sonnet");
    expect(conductorModelCapFor(card({ storyType: "spike" }))).toBe("sonnet");
    expect(withTypeModelCap(card({ storyType: "technical" }), "2026-10-07")?.rationale).toContain("história técnica");
  });

  it("história de usuário, ou card sem tipo declarado ⇒ sem teto (o modelo do board, Opus por padrão)", () => {
    expect(conductorModelCapFor(card({ storyType: "user" }))).toBeUndefined();
    expect(conductorModelCapFor(card({ storyType: null }))).toBeUndefined();
  });

  it("risco alto numa história técnica fica no modelo do board", () => {
    expect(conductorModelCapFor(card({ storyType: "technical", businessClasses: { ids: ["personal-data"], reason: "coleta", by: "triage-judge", at: "2026-10-06" } }))).toBeUndefined();
  });

  it("risco alto volta ao Opus mesmo num bug: classe do dono marcada, ou gravidade `high`/`blocker`", () => {
    expect(conductorModelCapFor(card({ storyType: "bug", businessClasses: { ids: ["money"], reason: "cobrança", by: "triage-judge", at: "2026-10-06" } }))).toBeUndefined();
    expect(conductorModelCapFor(card({ storyType: "bug", severity: "blocker" }))).toBeUndefined();
    expect(
      conductorModelCapFor(card({ storyType: "user", mode: "fix", bugReport: { severity: "blocker" } as Card["bugReport"] })),
    ).toBeUndefined();
    // a gravidade `high` TAMBÉM é risco alto (dono, 07/10: «bug grave vai de Opus»); `medium` segue em Sonnet
    expect(conductorModelCapFor(card({ storyType: "bug", severity: "high" }))).toBeUndefined();
    expect(conductorModelCapFor(card({ storyType: "bug", bugReport: { severity: "high" } as Card["bugReport"] }))).toBeUndefined();
    expect(conductorModelCapFor(card({ storyType: "bug", severity: "medium" }))).toBe("sonnet");
  });

  it("o teto EXPLÍCITO do card vence o derivado — para baixo e para cima", () => {
    const routing = (modelCap: "opus" | "sonnet") => ({ skips: [], decidedBy: "human" as const, decidedAt: "2026-10-06", modelCap });
    expect(conductorModelCapFor(card({ storyType: "bug", routing: routing("opus") }))).toBe("opus");
    expect(conductorModelCapFor(card({ storyType: "user", routing: routing("sonnet") }))).toBe("sonnet");
  });

  it("composto com conductorModelFor: só BAIXA o modelo do board e mantém a janela de 1M", () => {
    expect(conductorModelFor("opus[1m]", conductorModelCapFor(card({ storyType: "bug" })))).toBe("sonnet[1m]");
    expect(conductorModelFor("opus[1m]", conductorModelCapFor(card({ storyType: "user" })))).toBe("opus[1m]");
    expect(conductorModelFor("sonnet", conductorModelCapFor(card({ storyType: "bug", routing: { skips: [], decidedBy: "human", decidedAt: "x", modelCap: "opus" } })))).toBe("sonnet");
  });
});

describe("withTypeModelCap — o carimbo do teto pelo tipo, na admissão (visível no card)", () => {
  const today = "2026-10-07";
  it("bug sem teto ⇒ carimba sonnet com a marca do serviço; o carimbo certo não regrava", () => {
    const r = withTypeModelCap(card({ storyType: "bug" }), today);
    expect(r).toMatchObject({ modelCap: "sonnet", skips: [], decidedBy: "rules", decidedAt: today });
    expect(r?.rationale?.startsWith(TYPE_MODEL_CAP_MARK)).toBe(true);
    expect(withTypeModelCap(card({ storyType: "bug", routing: r! }), today)).toBeNull();
  });

  it("preserva o resto do routing (o driver do condutor) e nunca toca um teto escolhido por alguém", () => {
    const conducted = { skips: [], decidedBy: "rules" as const, decidedAt: "2026-10-01", driver: "conductor" as const };
    expect(withTypeModelCap(card({ storyType: "chore", routing: conducted }), today)).toMatchObject({ driver: "conductor", modelCap: "sonnet" });
    const chosen = { ...conducted, modelCap: "opus" as const, rationale: "o operador quer o modelo grande" };
    expect(withTypeModelCap(card({ storyType: "bug", routing: chosen }), today)).toBeNull();
    expect(withTypeModelCap(card({ storyType: "user" }), today)).toBeNull();
  });

  it("um bug carimbado que passa a ser RISCO ALTO volta ao modelo do board: o carimbo não prende o card no Sonnet", () => {
    const stamped = withTypeModelCap(card({ storyType: "bug" }), today)!;
    const money = { ids: ["money"], reason: "cobrança", by: "merge-train", at: today };
    const risky = card({ storyType: "bug", routing: stamped, businessClasses: money });
    expect(conductorModelCapFor(risky)).toBeUndefined();
    const cleared = withTypeModelCap(risky, today);
    expect(cleared?.modelCap).toBeUndefined();
    expect(cleared?.rationale).toBeUndefined();
    // e um teto ESCOLHIDO (sem a marca) segue vencendo, mesmo em risco alto
    expect(conductorModelCapFor(card({ storyType: "bug", businessClasses: money, routing: { skips: [], decidedBy: "human", decidedAt: today, modelCap: "sonnet" } }))).toBe("sonnet");
  });
});

describe("isHandOpenedConductor — o claude_new de um condutor ganha o recorte do despachado", () => {
  it("pela tarefa que abre com o comando do condutor, ou pelo card já conduzido", () => {
    expect(isHandOpenedConductor("/harness-conductor demo/story-ex9701 — conduzir a story", null)).toBe(true);
    expect(isHandOpenedConductor("revisar o diff", { routing: { skips: [], decidedBy: "rules", decidedAt: "x", driver: "conductor" } })).toBe(true);
    expect(isHandOpenedConductor("revisar o diff", { routing: undefined })).toBe(false);
    expect(isHandOpenedConductor("veja /harness-conductor depois", null)).toBe(false);
  });
});
