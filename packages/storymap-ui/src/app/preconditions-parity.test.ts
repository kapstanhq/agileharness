// A paridade que o teste do registry não enxerga: a AÇÃO DE SERVIDOR tem de
// recusar pela MESMA função pura que o botão usa para se desabilitar. Uma régua copiada à mão diverge no primeiro
// gate novo — foi o caso de «Aceitar → Refinar» (a recusa só existia no servidor). Asserção sobre a FONTE: a
// presença da chamada dentro do corpo da ação é o contrato.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");

function body(action: string): string {
  const start = source.indexOf(`export async function ${action}(`);
  expect(start, action).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function ", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("F6 — cada ação recusa pela pré-condição exportada que o Inbox usa", () => {
  it.each([
    ["moveCardAction", "moveRefusal("],
    ["updateCardAction", "moveRefusal("],
    ["acceptTriageCardAction", "acceptTriageRefusal("],
    ["runCardSkillAction", "runSkillRefusal("],
    ["republishCardAction", "republishRefusal("],
    ["approveDataDeletionAction", "dataDeletionRefusal("],
  ])("%s chama %s", (action, call) => {
    expect(body(action)).toContain(call);
  });

  it("as pré-condições vêm de UM módulo (preconditions.ts)", () => {
    expect(source).toMatch(/from "@\/lib\/storymap\/preconditions"/);
  });
});
