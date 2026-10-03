import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summaryLine } from "@/lib/storymap/inbox/entries";

// O NÚMERO do Inbox é o de DECIDIR em toda superfície que o mostra (decisão 1 do dono): a barra, a aba do celular, a
// fala do Jido e a home. Contrato sobre a fonte (o rig não renderiza React) — e a frase da contagem, sobre a função.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("a leitura da barra conta só Decidir", () => {
  it("getInboxSummaryAction devolve `total` = Decidir de TODOS os boards, por board, e as linhas de Decidir", () => {
    const actions = read("../../app/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function getInboxSummaryAction("), actions.indexOf("/** One row in the board-header trash drawer"));
    expect(fn).toMatch(/collectInbox\(\)/);
    expect(fn).toMatch(/const total = snapshot\.boards\.reduce\(\(n, b\) => n \+ b\.decidir, 0\)/);
    expect(fn).toMatch(/byBoard = Object\.fromEntries\(snapshot\.boards\.map\(\(b\) => \[b\.id, b\.decidir\]\)\)/);
    expect(fn).toMatch(/const entries = decidir\.map/);
  });

  it("o chip, a aba do celular, a fala do Jido e o seletor de boards leem esse mesmo número", () => {
    const header = read("../BoardHeader.tsx");
    // WP4: a leitura é a loja compartilhada (useInboxSummary.ts, a mesma da raia do dono no Kanban) e nasce `null` —
    // antes da 1ª resposta o chip não afirma «0».
    expect(header).toMatch(/const inbox = useInboxSummary\(\)/);
    expect(header).toMatch(/<CopilotChip [^>]*needsYou=\{inbox\?\.total \?\? 0\}/);
    expect(header).toMatch(/<ActionsChip boardId=\{config\.id\} total=\{inbox\?\.total \?\? null\}/);
    expect(header).toMatch(/inboxCount=\{inbox\?\.total \?\? null\}/);
    expect(header).toMatch(/<BoardCrumb [^>]*counts=\{inbox\?\.byBoard \?\? null\}/);
    // uma leitura só: nenhuma varredura por board a mais
    expect(header).not.toMatch(/getBoardDemandsAction/);
  });

  it("a home conta Decidir e diz o resto em palavras", () => {
    const home = read("../inicio/InboxPanel.tsx");
    expect(home).toMatch(/summary\.decidir/);
    expect(home).toMatch(/acompanhando/);
  });
});

describe("a frase da contagem", () => {
  it("«3 para decidir · 2 acompanhando», e o que ninguém cuida só quando há", () => {
    expect(summaryLine({ decidir: 3, acompanhar: 2, stalled: 0 })).toBe("3 para decidir · 2 acompanhando");
    expect(summaryLine({ decidir: 0, acompanhar: 4, stalled: 1 })).toBe("0 para decidir · 4 acompanhando · 1 sem ninguém cuidando");
  });
});
