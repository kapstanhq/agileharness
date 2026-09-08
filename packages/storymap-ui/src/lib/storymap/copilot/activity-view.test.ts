// O diário do Jido é um RECALL enxuto: tiers por tipo, decisões repetidas colapsadas, texto capado. Estes
// testes travam as três regras puras que o mantêm assim (o componente só as renderiza).

import { describe, it, expect } from "vitest";
import type { CopilotActivityEntry } from "./activity";
import { tierOf, groupActivity, summarizeEntry, diarySentence } from "./activity-view";

const entry = (over: Partial<CopilotActivityEntry> & Pick<CopilotActivityEntry, "id" | "kind" | "text">): CopilotActivityEntry => ({
  at: "2026-07-16T17:13:00.000Z",
  ...over,
});

describe("tierOf — o peso visual de cada tipo de evento", () => {
  it("trabalho (finished/acted), atenção (asked/refused), erro e ruído (woke/stood-down) caem em tiers distintos", () => {
    expect(tierOf("finished")).toBe("work");
    expect(tierOf("acted")).toBe("work");
    expect(tierOf("asked")).toBe("attention");
    expect(tierOf("refused")).toBe("attention");
    expect(tierOf("error")).toBe("error");
    expect(tierOf("woke")).toBe("idle");
    expect(tierOf("stood-down")).toBe("idle");
  });
});

describe("groupActivity — colapsa stand-downs (e afins) consecutivos idênticos", () => {
  it("4 'Fiquei de fora' idênticos consecutivos viram UMA linha com count=4 e o 'desde' na entrada mais antiga", () => {
    // ordem decrescente (mais nova primeiro), como o feed passa
    const newestFirst: CopilotActivityEntry[] = [
      entry({ id: "5", kind: "stood-down", text: "Fiquei de fora: você está no comando.", at: "2026-07-16T17:43:00Z" }),
      entry({ id: "4", kind: "stood-down", text: "Fiquei de fora: você está no comando.", at: "2026-07-16T17:33:00Z" }),
      entry({ id: "3", kind: "stood-down", text: "Fiquei de fora: você está no comando.", at: "2026-07-16T17:23:00Z" }),
      entry({ id: "2", kind: "stood-down", text: "Fiquei de fora: você está no comando.", at: "2026-07-16T17:13:00Z" }),
    ];
    const groups = groupActivity(newestFirst);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(4);
    expect(groups[0].entry.id).toBe("5"); // a representante é a MAIS NOVA
    expect(groups[0].sinceAt).toBe("2026-07-16T17:13:00Z"); // o "desde" é a MAIS ANTIGA
  });

  it("textos diferentes NÃO colapsam (motivos distintos ficam em linhas próprias)", () => {
    const groups = groupActivity([
      entry({ id: "3", kind: "stood-down", text: "Parei por budget." }),
      entry({ id: "2", kind: "stood-down", text: "Fiquei de fora: você está no comando." }),
      entry({ id: "1", kind: "finished", text: "Movi 2 cards." }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.count === 1)).toBe(true);
  });

  it("só corridas CONSECUTIVAS colapsam (um mesmo texto separado por outro evento vira dois grupos)", () => {
    const groups = groupActivity([
      entry({ id: "3", kind: "stood-down", text: "Fiquei de fora." }),
      entry({ id: "2", kind: "finished", text: "Terminei um ciclo." }),
      entry({ id: "1", kind: "stood-down", text: "Fiquei de fora." }),
    ]);
    expect(groups).toHaveLength(3);
  });

  it("lista vazia ⇒ nenhum grupo", () => {
    expect(groupActivity([])).toEqual([]);
  });
});

describe("summarizeEntry — cada entrada do diário cabe num recall (cap ~250)", () => {
  it("texto curto passa intacto", () => {
    expect(summarizeEntry("Movi 2 cards.")).toBe("Movi 2 cards.");
  });

  it("texto longo é capado no limite com reticências, nunca no meio de uma palavra", () => {
    const long = "palavra ".repeat(60).trim(); // ~479 chars, todas fronteiras de palavra
    const out = summarizeEntry(long, 250);
    expect(out.length).toBeLessThanOrEqual(250);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/palavr…$/); // cortou numa fronteira de palavra, não no meio
  });

  it("prefere cortar no fim de uma SENTENÇA quando há uma lá pra frente", () => {
    const text = `${"a".repeat(180)}. ${"b".repeat(180)}`;
    const out = summarizeEntry(text, 250);
    expect(out.endsWith(".…")).toBe(true); // corta logo após o ponto da 1ª frase (sem o espaço) + reticências
    expect(out).not.toContain("b"); // ficou só a primeira frase
  });
});

// FRASE CORRIDA — o diário é uma linha de 11px renderizada como TEXTO PURO. O `summary` de um run chega como
// relatório markdown do LLM (tabela, `##`, `**`), e sem achatar isso virava sopa de pipes numa linha só.
describe("diarySentence", () => {
  it("achata o relatório markdown REAL de um `finished` (board acme) numa frase corrida", () => {
    // trecho verbatim do .runner/copilot-activity/acme.jsonl — 55 das 368 entradas tinham esta forma.
    const real =
      "**Release column is empty. The curation cluster is fully closed.**\n\n" +
      "## Como estamos indo — trilha de curadoria 100% no ar\n\n" +
      "### 🎯 Feed / curadoria (step-feed)\n" +
      "| Card | O que entrega | Status |\n" +
      "|---|---|---|\n" +
      "| `story-qb8z2c` | Resumo nunca vira descrição | **No ar** |";
    const out = diarySentence(real);
    expect(out).toBe(
      "Release column is empty. The curation cluster is fully closed. " +
        "Como estamos indo — trilha de curadoria 100% no ar. 🎯 Feed / curadoria (step-feed)",
    );
    expect(out).not.toContain("|"); // tabela: descartada, não achatada
    expect(out).not.toContain("\n");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("tira as crases das NOSSAS próprias entradas (o guard escreve `Executei \\`move_card\\``)", () => {
    expect(diarySentence("Executei `move_card` sozinho (reversible).")).toBe("Executei move_card sozinho (reversible).");
  });

  it("costura fragmentos com '. ' só quando falta pontuação", () => {
    expect(diarySentence("Movi 2 cards\nTudo verde")).toBe("Movi 2 cards. Tudo verde");
    expect(diarySentence("Movi 2 cards.\nTudo verde")).toBe("Movi 2 cards. Tudo verde");
    expect(diarySentence("Movi 2 cards:\nTudo verde")).toBe("Movi 2 cards: Tudo verde");
  });

  it("vira prosa: bullets, títulos, quotes e links perdem o cerco e mantêm o texto", () => {
    expect(diarySentence("## Resumo\n- movi o card\n- pedi aprovação")).toBe("Resumo. movi o card. pedi aprovação");
    expect(diarySentence("> nota importante")).toBe("nota importante");
    expect(diarySentence("veja o [card](https://x.dev/c/1)")).toBe("veja o card");
    expect(diarySentence("1. primeiro\n2. segundo")).toBe("primeiro. segundo");
  });

  it("descarta blocos de código inteiros (não são frase)", () => {
    expect(diarySentence("falhou aqui:\n```ts\nconst x = 1;\n```\nvou tentar de novo")).toBe(
      "falhou aqui: vou tentar de novo",
    );
  });

  it("é inerte sobre uma frase que já é frase (o tickOutcomeText já nasce corrido)", () => {
    const already = "Parei por budget — já usei 12/12 ticks · $4.10/$5 hoje. Zera na virada do dia.";
    expect(diarySentence(already)).toBe(already);
  });

  // Achado do spike contra o diário REAL do acme: a entrada estava truncada na origem, no meio de um negrito —
  // o par nunca casava e o `**` chegava cru à linha. Idem para um negrito que atravessa a quebra de linha.
  it("tira marcador ÓRFÃO: entrada truncada no meio do negrito", () => {
    expect(diarySentence("devolveu o card para Desenvolver. **Não enfil")).toBe(
      "devolveu o card para Desenvolver. Não enfil",
    );
  });

  it("tira marcador ÓRFÃO: negrito atravessando a quebra de linha", () => {
    expect(diarySentence("**Não enfileirei\no redrive**")).toBe("Não enfileirei. o redrive");
  });

  it("tira crase órfã (bloco de código aberto e não fechado)", () => {
    expect(diarySentence("rodei `git status")).toBe("rodei git status");
  });

  it("aguenta vazio/lixo sem lançar", () => {
    expect(diarySentence("")).toBe("");
    expect(diarySentence("\n\n |---| \n")).toBe("");
    expect(diarySentence(undefined as unknown as string)).toBe("");
  });
});

// O tier é a ÚNICA porta pela qual o cliente pinta (nunca regex no texto) — então quem precisa de destaque
// precisa de um KIND próprio. Estes dois nasceram do incidente do acme (07-17): o tick parou 10h e o diário
// pintou a parada como trabalho.
describe("tierOf — promessa é ruído; desistência é a sua vez", () => {
  it("`handed-back` (desisti, é seu, re-arme) é ATENÇÃO — não pode recuar como ruído", () => {
    expect(tierOf("handed-back")).toBe("attention");
    expect(tierOf("handed-back")).not.toBe(tierOf("stood-down")); // era pintado igual ao ruído
  });

  it("`scheduled` (vou olhar em Ns) é RUÍDO — uma promessa não pode ter o peso de um ciclo que rodou", () => {
    expect(tierOf("scheduled")).toBe("idle");
  });

  it("`woke` volta a significar SÓ o disparo real (a promessa saiu de cima dele)", () => {
    expect(tierOf("woke")).toBe("idle"); // o ciclo em si é ruído; o que ele FEZ vem no finished (work)
    expect(tierOf("finished")).toBe("work");
  });
});
