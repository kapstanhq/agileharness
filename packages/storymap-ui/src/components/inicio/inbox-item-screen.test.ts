// A página do item escrevia o título, o status e o id DUAS vezes. Desde a reescrita do Inbox
// ela desenha o item com o cartão único (InboxItemCard `page`), que tem UM cabeçalho — a decisão. Asserção sobre a
// fonte (o rig de teste não renderiza React).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./InboxItemScreen.tsx", import.meta.url)), "utf8");

describe("F17 — a página do item tem UM cabeçalho", () => {
  it("desenha o item com o cartão único, na densidade de página — e não escreve um segundo título", () => {
    expect(source).toMatch(/<InboxItemCard\b[^>]*density="page"/);
    expect(source).not.toMatch(/<h1\b/);
    expect(source).not.toMatch(/CockpitItemDetail/);
  });
});
