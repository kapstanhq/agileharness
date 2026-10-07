// A saudação do Jido conta o MESMO que o Inbox. O caso vivo: o cockpit cru tinha 19 itens (Acompanhar, o aviso do host
// repetido por board, o que o sistema já resolve) e o Inbox, 0 em Decidir — o Jido dizia «19 itens para revisar».

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { inboxSections, inboxSummary, type InboxEntry } from "./entries";
import { GREETING_INBOX_WAIT_MS, greetingSummary, inboxForGreeting, needsYouForBoard } from "./needs-you";

const entry = (board: string, id: string, extra: { bucket?: "decidir" | "acompanhar"; banner?: boolean } = {}): InboxEntry =>
  ({
    key: `${board}/${id}`,
    boardId: board,
    boardName: board,
    itemId: id,
    cardId: `story-ex9${id.padStart(3, "0")}`,
    cardTitle: id,
    kind: "question",
    causeKey: id,
    facets: [],
    decision: {
      bucket: extra.bucket ?? "decidir",
      banner: extra.banner ?? false,
      ask: `Decidir ${id}?`,
      askVerb: "Decidir",
      options: [],
      dot: "amber",
      since: "2026-10-01T10:00:00Z",
      next: { who: "voce", label: "você" },
    },
  }) as unknown as InboxEntry;

/** O resumo da barra como `getInboxSummaryAction` o monta: o Decidir de cada board pelo `inboxSummary` dele. */
function barSummary(entries: InboxEntry[], boards: string[]) {
  return { byBoard: Object.fromEntries(boards.map((b) => [b, inboxSummary(entries.filter((e) => e.boardId === b)).decidir])) };
}

const ENTRIES: InboxEntry[] = [
  entry("livraria", "1"),
  entry("livraria", "2"),
  entry("livraria", "3", { bucket: "acompanhar" }),
  entry("livraria", "host", { banner: true }),
  entry("atendimento", "4", { bucket: "acompanhar" }),
  entry("atendimento", "5", { bucket: "acompanhar" }),
  entry("atendimento", "host", { banner: true }),
];

describe("a saudação do Jido conta o Inbox", () => {
  it("o número da fala == o Decidir do Inbox do board (a tela e o ícone), não o total cru", () => {
    const summary = barSummary(ENTRIES, ["livraria", "atendimento"]);
    for (const board of ["livraria", "atendimento"]) {
      const own = ENTRIES.filter((e) => e.boardId === board);
      const inboxPage = inboxSummary(own).decidir; // a tela /board/<id>/inbox
      const headerIcon = inboxSections(own).decidir.length; // o ícone da barra (entradas de Decidir do board)
      expect(needsYouForBoard(summary, board)).toBe(inboxPage);
      expect(needsYouForBoard(summary, board)).toBe(headerIcon);
      expect(needsYouForBoard(summary, board)).toBeLessThan(own.length); // o total cru diria mais
    }
    expect(greetingSummary({ needsYou: needsYouForBoard(summary, "livraria"), questions: 0, approvals: 0 })).toBe(
      "Você tem 2 itens para decidir.",
    );
    // Inbox em 0 para o board ⇒ a fala não inventa itens, mesmo com 3 coisas cruas no cockpit
    expect(greetingSummary({ needsYou: needsYouForBoard(summary, "atendimento"), questions: 0, approvals: 0 })).toBe(
      "Nada urgente no momento.",
    );
  });

  it("board fora do resumo conta 0; sem resumo (não medido) a fala não afirma número", () => {
    expect(needsYouForBoard({ byBoard: {} }, "outro")).toBe(0);
    expect(needsYouForBoard(null, "livraria")).toBeNull();
    expect(greetingSummary({ needsYou: null, questions: 0, approvals: 0 })).toBe("");
    expect(greetingSummary({ needsYou: null, questions: 1, approvals: 2 })).toBe(
      "Você tem 1 pergunta em aberto, 2 ações do Jido aguardando aprovação.",
    );
    expect(greetingSummary({ needsYou: 1, questions: 0, approvals: 0 })).toBe("Você tem 1 item para decidir.");
  });
});

describe("a leitura do Inbox não segura o chat", () => {
  it("resumo a tempo ⇒ o número; lenta ⇒ null no prazo; rejeitada ou com erro síncrono ⇒ null", async () => {
    vi.useFakeTimers();
    try {
      const summary = { byBoard: { livraria: 2 } };
      await expect(inboxForGreeting(() => Promise.resolve(summary))).resolves.toBe(summary);

      let late = false;
      const slow = inboxForGreeting(() => new Promise<typeof summary>(() => {}), 1500).then((v) => {
        late = true;
        return v;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(late).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(slow).resolves.toBeNull();

      await expect(inboxForGreeting(() => Promise.reject(new Error("rede")))).resolves.toBeNull();
      await expect(
        inboxForGreeting(() => {
          throw new Error("síncrono");
        }),
      ).resolves.toBeNull();
      expect(GREETING_INBOX_WAIT_MS).toBeLessThanOrEqual(2000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// O CONTRATO no fonte do chat (o rig é node sem DOM e não transforma JSX — lê o .tsx como texto): a saudação conta
// pelo Inbox, com prazo, e não volta a ler a contagem crua do cockpit.
describe("CopilotChat usa o número do Inbox na saudação", () => {
  const chat = readFileSync(fileURLToPath(new URL("../../../components/CopilotChat.tsx", import.meta.url)), "utf8");
  it("greetingSummary lê needsYouForBoard(inbox, boardId), e o inbox vem de inboxForGreeting", () => {
    expect(chat).toMatch(/greetingSummary\(\{\s*needsYou:\s*needsYouForBoard\(inbox, boardId\)/);
    expect(chat).toMatch(/Promise\.all\(\[copilotContextAction\(boardId\), inboxForGreeting\(readInboxSummary\)\]\)/);
    expect(chat).not.toMatch(/needsYouCount/);
  });
});
