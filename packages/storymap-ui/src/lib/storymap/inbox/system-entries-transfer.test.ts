// A mudança de board no «Acompanhar»: legível nos DOIS boards — de onde o card saiu (para onde foi) e onde chegou (de
// onde veio), com quem mudou dito em português e o porquê.

import { describe, expect, it } from "vitest";
import { cardTransferEntries, followUpItems } from "../system-decisions";
import { systemDecisionEntry } from "./system-entries";
import type { BoardConfig } from "../types";

const config = { id: "galpao", name: "Galpão", statuses: [], releases: [], personas: [], systems: [], linkTypes: [] } as unknown as BoardConfig;
const at = "2026-05-04T10:00:00.000Z";

describe("mudança de board no Acompanhar", () => {
  const entries = (agent: string) =>
    cardTransferEntries(
      { fromBoard: "estufa", fromName: "Estufa", toBoard: "galpao", toName: "Galpão", cardId: "story-caixa", title: "Trocar o papel das caixas", agent, reason: "os arquivos são do galpão" },
      { at, idOf: (side) => `d-${side}` },
    );

  it("cada board vê a sua metade: a origem sem card (ele não está mais lá), o destino com o card", () => {
    const all = entries("human");
    expect(followUpItems(all, { board: "estufa" }).map((d) => [d.what, d.cardId ?? null])).toEqual([["Mudou «Trocar o papel das caixas» para o board «Galpão»", null]]);
    expect(followUpItems(all, { board: "galpao" }).map((d) => [d.what, d.cardId])).toEqual([["Recebeu «Trocar o papel das caixas» do board «Estufa»", "story-caixa"]]);
  });

  it("pelo dono: «Você decidiu: <motivo>» — nunca «Você decidiu por você»; por um agente: «Agente decidiu por você»", () => {
    const [, toHuman] = entries("human");
    const eHuman = systemDecisionEntry({ ...toHuman, undoable: false }, { boardId: "galpao", boardName: "Galpão", config });
    expect(eHuman.decision.happened).toBe("Você decidiu: os arquivos são do galpão");
    expect(eHuman.decision.details).toContainEqual({ label: "Quem decidiu", value: "Você" });
    const [, toAgent] = entries("agent");
    expect(systemDecisionEntry({ ...toAgent, undoable: false }, { boardId: "galpao", boardName: "Galpão", config }).decision.happened).toBe("Agente decidiu por você: os arquivos são do galpão");
  });

  it("o roteamento da triagem é dito como tal (o juiz mandou o card ao board dele)", () => {
    const [, to] = entries("triage-judge");
    expect(to.kind).toBe("triage-route");
    expect(systemDecisionEntry({ ...to, undoable: false }, { boardId: "galpao", boardName: "Galpão", config }).decision.happened).toMatch(/^Juiz da triagem decidiu por você/);
  });
});
