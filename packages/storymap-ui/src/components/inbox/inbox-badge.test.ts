import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summaryLine } from "@/lib/storymap/inbox/entries";

// O NÚMERO do Inbox é o de DECIDIR em toda superfície que o mostra (decisão 1 do dono): o ícone da barra do topo (no
// board e nas páginas app-level), o painel dele e o seletor de projetos. Contrato sobre a fonte (o rig não renderiza React) — e a frase da contagem, sobre a função.

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

  it("o ícone do Inbox e o seletor de projetos da barra leem esse mesmo número", () => {
    const header = read("../BoardHeader.tsx");
    // WP4: a leitura é a loja compartilhada (useInboxSummary.ts, a mesma da raia do dono no Kanban) e nasce `null` —
    // antes da 1ª resposta o ícone não afirma «0».
    expect(header).toMatch(/const inbox = useInboxSummary\(\)/);
    // numa página de BOARD o ícone conta só o board aberto (o mesmo `byBoard` do seletor de projetos) e lista só as
    // decisões dele; o total de todos os boards fica na barra das páginas do app (/inbox)
    expect(header).toMatch(/<InboxIconLink\s+href=\{inboxHref\(config\.id\)\}\s+total=\{inbox \? \(inbox\.byBoard\[config\.id\] \?\? 0\) : null\}/);
    expect(header).toMatch(/entries=\{boardInbox\}\s+scope="board"/);
    expect(header).toMatch(/const boardInbox = useMemo\(\(\) => \(inbox\?\.entries \?\? \[\]\)\.filter\(\(e\) => e\.boardId === config\.id\)/);
    expect(header).toMatch(/<ProjectSwitcher [^>]*counts=\{inbox\?\.byBoard \?\? null\}/);
    // uma leitura só: nenhuma varredura por board a mais
    expect(header).not.toMatch(/getBoardDemandsAction/);
    // a barra das páginas app-level (/inbox, /processes, /semana) lê a MESMA loja
    expect(read("../nav/TopBar.tsx")).toMatch(/<InboxIconLink href="\/inbox" total=\{inbox\?\.total \?\? null\}/);
    // o /inbox do app empresta a barra do 1º board, mas o ícone ali conta TODOS (o mesmo número do «Precisa de você»
    // da página) — visto no ar (v0.11.0): «Precisa de você 2» com o ícone em 0, porque contava só o board emprestado
    expect(header).toMatch(/inboxScope = "board"/);
    expect(header).toMatch(
      /inboxScope === "all" \? \(\s*<InboxIconLink href="\/inbox" total=\{inbox\?\.total \?\? null\} acompanhar=\{inbox\?\.acompanhar \?\? 0\} entries=\{inbox\?\.entries \?\? \[\]\} \/>/,
    );
    expect(read("../../app/inbox/page.tsx")).toMatch(/<BoardHeader [^>]*view="inbox" inboxScope="all"/);
    // as páginas de BOARD não passam `inboxScope` (ficam no padrão, só o board aberto)
    expect(read("../CockpitView.tsx")).not.toMatch(/inboxScope/);
    // A aba do celular e a fala do Jido SAÍRAM de propósito (fase 1): a navegação inferior deu o rodapé ao
    // compositor do chat, e o mascote deixou a barra. O número tem um consumidor a menos, não uma fonte a mais.
    expect(header).not.toMatch(/MobileBottomNav|MobileInboxTab|CopilotChip/);
  });

  it("o painel do Inbox na barra conta o que precisa de você e diz o resto em palavras (a frase da fase 3)", () => {
    const link = read("../shell/InboxIconLink.tsx");
    expect(link).toMatch(/\$\{total\} precisa\$\{total === 1 \? "" : "m"\} de você · \$\{acompanhar\} com os agentes/);
    expect(link).toMatch(/Nada precisa de você\$\{where\} agora\./);
  });
});

describe("a frase da contagem", () => {
  it("«3 para decidir · 2 acompanhando», e o que ninguém cuida só quando há", () => {
    expect(summaryLine({ decidir: 3, acompanhar: 2, stalled: 0 })).toBe("3 para decidir · 2 acompanhando");
    expect(summaryLine({ decidir: 0, acompanhar: 4, stalled: 1 })).toBe("0 para decidir · 4 acompanhando · 1 sem ninguém cuidando");
  });
});
