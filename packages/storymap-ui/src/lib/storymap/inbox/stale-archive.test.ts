// «ARQUIVAR OS ANTIGOS» (onda 2, passo 6): o item parado há mais de 30 dias é marcado («parado há N dias») e pode ir
// para o arquivo de uma vez — com confirmação, reversível (adiado, com «Desfazer»), e só o que a MESMA régua aceita na
// tela e no servidor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BoardConfig, Card, StatusDef } from "../types";
import type { CockpitItem } from "../demands";
import { bannedTermsIn, staleLabel } from "./copy";
import { archivableStale, itemEntries, foldByCard } from "./entries";
import { STALE_ARCHIVE_MAX, staleArchiveBrief, staleArchiveCopy, staleArchivePlan, staleArchiveReceiptText } from "./stale-archive";

const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
const STATUSES = [
  st("triage", "Triagem", { staging: true }),
  st("interview", "Entrevista", { autorun: true }),
  st("release", "Liberar", { autorun: false, laneStep: true }),
  st("concluida", "No ar", { terminal: true }),
  st("arquivados", "Arquivados", { terminal: true }),
];
const CONFIG = { id: "b1", name: "Livraria", statuses: STATUSES } as BoardConfig;
const NOW = Date.parse("2026-09-28T20:00:00Z");
const OLD = "2026-07-08T12:00:00Z"; // 82 dias
const card = (id: string, over: Partial<Card> = {}): Card =>
  ({ id, type: "story", title: `Card ${id}`, storyType: "user", status: "triage", parent: "step-1", findings: [], tasks: [], acceptance: [], links: [], personas: [], systems: [], created: "2026-07-01", ...over }) as unknown as Card;
const item = (kind: string, cardId: string, over: Record<string, unknown> = {}): CockpitItem =>
  ({ id: `${cardId}:${kind}`, kind, boardId: "b1", cardId, cardTitle: `Card ${cardId}`, status: "triage", lane: "pergunta", severity: "medium", since: OLD, ...over }) as CockpitItem;

function entries(config: BoardConfig, cards: Card[], items: CockpitItem[]) {
  return foldByCard(itemEntries(items, { boardId: "b1", boardName: "Livraria", config, cardsById: new Map(cards.map((c) => [c.id, c])), now: NOW }));
}

describe("a marca «parado há N dias»", () => {
  it("passa de 30 dias, a linha diz há quanto tempo", () => {
    const [e] = entries(CONFIG, [card("c1", { needsHumanReview: true })], [item("review", "c1")]);
    expect(e.stale).toEqual({ days: 82, archivable: true });
    expect(staleLabel(82)).toBe("parado há 82 dias");
    const [fresh] = entries(CONFIG, [card("c1", { needsHumanReview: true })], [item("review", "c1", { since: "2026-09-20T12:00:00Z" })]);
    expect(fresh.stale).toBeUndefined();
  });
});

describe("o que «Arquivar os antigos» alcança", () => {
  it("só itens de DECIDIR parados, um por card, de histórias vivas", () => {
    const cards = [
      card("c1", { needsHumanReview: true }),
      card("c2", { needsHumanReview: true, capture: true } as Partial<Card>),
      card("c3", { status: "concluida" }),
      card("c4", { needsHumanReview: true }),
    ];
    const list = entries(CONFIG, cards, [
      item("review", "c1"),
      item("finding", "c1", { id: "c1:f:f1", findingId: "f1", title: "Aviso", findingSeverity: "low" }),
      item("review", "c2"),
      item("review", "c3"),
      item("review", "c4", { since: "2026-09-27T12:00:00Z" }),
    ]);
    expect(archivableStale(list).map((e) => e.cardId)).toEqual(["c1"]);
  });

  it("um board SEM o arquivo não oferece arquivar — o item segue marcado como parado", () => {
    const noArchive = { ...CONFIG, statuses: STATUSES.filter((s) => s.id !== "arquivados") } as BoardConfig;
    const list = entries(noArchive, [card("c1", { needsHumanReview: true })], [item("review", "c1")]);
    expect(list[0].stale).toEqual({ days: 82, archivable: false });
    expect(archivableStale(list)).toEqual([]);
  });

  it("o servidor re-confere: o que não está mais parado fica de fora, com o porquê; pedido repetido conta uma vez", () => {
    const list = entries(CONFIG, [card("c1", { needsHumanReview: true })], [item("review", "c1")]);
    const plan = staleArchivePlan(
      [
        { boardId: "b1", cardId: "c1" },
        { boardId: "b1", cardId: "c1" },
        { boardId: "b1", cardId: "c9" },
      ],
      list,
    );
    expect(plan.archive.map((e) => e.cardId)).toEqual(["c1"]);
    expect(plan.refused).toEqual([{ boardId: "b1", cardId: "c9", reason: expect.stringMatching(/não está mais parado/) }]);
    expect(STALE_ARCHIVE_MAX).toBe(200);
  });
});

describe("o texto — confirmação que diz o que acontece, sem jargão", () => {
  it("singular e plural, e a promessa de que nada é apagado", () => {
    expect(staleArchiveCopy(1)).toMatchObject({ line: "1 item parado há mais de 30 dias", title: "Arquivar 1 item parado?", done: "1 item foi para o arquivo." });
    const many = staleArchiveCopy(12);
    expect(many.title).toBe("Arquivar 12 itens parados?");
    expect(many.body).toMatch(/nada é apagado/);
    expect(many.body).toMatch(/Resolvido hoje/);
    const texts = [...Object.values(many), ...Object.values(staleArchiveCopy(1)), staleArchiveBrief(82), staleArchiveReceiptText({ cardTitle: "Busca" }, 82)];
    for (const t of texts) expect(bannedTermsIn(t), t).toEqual([]);
  });
});

describe("a tela e o servidor", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("a linha fica sob Decidir, sempre montada (o recibo sobrevive a Decidir vazio), e confirma antes de arquivar", () => {
    const sections = read("../../../components/inbox/InboxSections.tsx");
    expect(sections).toMatch(/const stale = useMemo\(\(\) => archivableStale\(decidir\)/);
    expect(sections).toMatch(/<StaleArchive entries=\{stale\} \/>/);
    const ui = read("../../../components/inbox/StaleArchive.tsx");
    expect(ui).toMatch(/onClick=\{\(\) => setConfirming\(true\)\}/);
    expect(ui).toMatch(/<ConfirmDialog/);
    expect(ui).toMatch(/Desfazer tudo/);
    expect(ui).toMatch(/undoInboxReceiptAction\(/);
  });
  it("o servidor re-coleta, arquiva como ADIADO e deixa um recibo com «tirar do arquivo» por card", () => {
    const actions = read("../../../app/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function archiveStaleItemsAction("), actions.indexOf("The owner closes an item of the PROXY AUDIT list"));
    expect(fn).toMatch(/collectBoardInbox\(b\)/);
    expect(fn).toMatch(/staleArchivePlan\(requested, current\)/);
    expect(fn).toMatch(/disposition: "postergado"/);
    expect(fn).toMatch(/undo: \{ kind: "revive-card"/);
  });
});
