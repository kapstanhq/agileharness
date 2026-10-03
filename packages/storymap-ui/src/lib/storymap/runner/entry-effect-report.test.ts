// Um efeito de entrada (promote-and-deploy / deploy-board / promote-stage)
// roda DEPOIS de a ação de servidor responder. Uma recusa ou um erro dele só existia no log: o dono via
// «Aprovar & avançar: ok», o card ficava parado em Publicar sem nada vermelho. Aqui: todo efeito
// que falha ou é recusado deixa um finding DURÁVEL no card, com o motivo em português; o próximo que roda limpo
// o resolve.

import { describe, expect, it, vi } from "vitest";
import { runReportedEntryEffect, type EntryEffectReportDeps } from "./entry-effect-report";
import { ENTRY_EFFECT_FAILED_FINDING_ID } from "@/lib/storymap/demands";
import { coerceCard } from "@/lib/storymap/repo";
import type { BoardConfig, Card } from "@/lib/storymap/types";

const config = {
  id: "b",
  name: "B",
  statuses: [
    { id: "release", name: "Liberar" },
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", terminal: true },
  ],
} as unknown as BoardConfig;

function world(card: Card = coerceCard("story-x", { type: "story", status: "deploy" }, "")) {
  const state = { card };
  const deps: EntryEffectReportDeps = {
    readConfig: async () => config,
    write: vi.fn(async (_b: string, _c: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(state.card);
      if (next) state.card = next;
      return next;
    }),
    today: () => "2026-09-28",
  };
  return { state, deps };
}

const open = (c: Card) => (c.findings ?? []).find((f) => f.id === ENTRY_EFFECT_FAILED_FINDING_ID && f.status === "open");

describe("runReportedEntryEffect — o efeito que falha depois do clique deixa um fato durável no card", () => {
  it("o efeito LANÇOU ⇒ finding aberto com o motivo em português; o erro segue para quem chamou", async () => {
    const { state, deps } = world();
    await expect(
      runReportedEntryEffect("promote-and-deploy", "b", "story-x", async () => {
        throw new Error("RECUSADO: autorização de outro alvo");
      }, deps),
    ).rejects.toThrow(/RECUSADO/);
    const f = open(state.card);
    expect(f).toBeTruthy();
    expect(f!.title).toMatch(/publicação/i);
    expect(f!.detail).toContain("RECUSADO: autorização de outro alvo");
    expect(f!.severity).toBe("high");
  });

  it("o deploy foi RECUSADO antes de começar (deploy-board devolve `refused`) ⇒ finding com o motivo", async () => {
    const { state, deps } = world();
    await runReportedEntryEffect("deploy-board", "b", "story-x", async () => ({ fired: false, refused: "deploy.kind=command recusado — interpretador não é alvo" }), deps);
    expect(open(state.card)?.detail).toContain("interpretador não é alvo");
  });

  it("a publicação promoveu, mas o deploy NEM COMEÇOU (promote-and-deploy devolve `deployNotStarted`) ⇒ finding", async () => {
    const { state, deps } = world();
    await runReportedEntryEffect(
      "promote-and-deploy",
      "b",
      "story-x",
      async () => ({ promoted: true, deployable: true, revert: false, expectWork: true, changedFiles: [], outcome: "promoted", deployNotStarted: "o board declara `deploy.kind: agent` sem `description`" }),
      deps,
    );
    expect(open(state.card)?.detail).toContain("sem `description`");
  });

  it("o efeito rodou limpo ⇒ o finding de uma falha anterior é RESOLVIDO (e nada é escrito sem falha aberta)", async () => {
    const { state, deps } = world();
    await runReportedEntryEffect("deploy-board", "b", "story-x", async () => ({ fired: false, refused: "x" }), deps);
    expect(open(state.card)).toBeTruthy();
    await runReportedEntryEffect("deploy-board", "b", "story-x", async () => ({ fired: true }), deps);
    expect(open(state.card)).toBeUndefined();
    expect(state.card.findings.find((f) => f.id === ENTRY_EFFECT_FAILED_FINDING_ID)?.status).toBe("fixed");

    const clean = world();
    await runReportedEntryEffect("deploy-board", "b", "story-x", async () => ({ fired: true }), clean.deps);
    expect(clean.state.card.findings).toEqual([]);
  });

  it("uma promoção (promote-stage) que NÃO aterrissou é uma falha do efeito — o card não fica mudo", async () => {
    const { state, deps } = world(coerceCard("story-x", { type: "story", status: "release" }, ""));
    await runReportedEntryEffect(
      "promote-stage",
      "b",
      "story-x",
      async () => ({ promoted: false, deployable: false, revert: true, expectWork: false, changedFiles: [], outcome: "concurrent-work", reason: "outra sessão está nos mesmos arquivos" }),
      deps,
    );
    expect(open(state.card)?.detail).toContain("outra sessão está nos mesmos arquivos");
  });

  it("sem card (a fila de publicação dispara sem card) ⇒ nada a escrever", async () => {
    const { deps } = world();
    await runReportedEntryEffect("deploy-board", "b", undefined, async () => ({ fired: false, refused: "x" }), deps);
    expect(deps.write).not.toHaveBeenCalled();
  });
});
