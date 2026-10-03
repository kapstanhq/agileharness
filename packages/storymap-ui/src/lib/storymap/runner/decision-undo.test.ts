// O «Desfazer» de uma decisão do sistema (política só-negócio) — o núcleo DI da ação de servidor, contra fakes: acha a
// entrada, confere a pré-condição no card FRESCO (sob o lock), aplica, e registra o próprio desfazer no ledger.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { parseSystemDecisionLines, serializeSystemDecision } from "./decision-log";
import { undoSystemDecision, type DecisionUndoDeps } from "./decision-undo";

const statuses = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "enriquecer", name: "Especificar" },
  { id: "desenvolver", name: "Desenvolver", trigger: "harness-do" },
  { id: "cancelado", name: "Cancelado", terminal: true },
];
const config = { id: "b", name: "B", statuses, releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "ultra" } } as unknown as BoardConfig;
const at = "2026-09-28T12:00:00.000Z";

function world(entries: SystemDecision[], cards: Card[]) {
  const state = { cards: cards.map((c) => ({ ...c })), log: [...entries] };
  const transitions: Array<Record<string, unknown>> = [];
  const deps: DecisionUndoDeps = {
    readDecisions: async () => state.log,
    readBoardConfig: async () => config,
    readCard: async (_b, id) => state.cards.find((c) => c.id === id) ?? null,
    updateCard: async (_b, id, fn) => {
      const i = state.cards.findIndex((c) => c.id === id);
      if (i < 0) return null;
      const next = fn(state.cards[i]);
      if (!next) return null;
      state.cards[i] = next;
      return next;
    },
    restoreTrash: vi.fn(async () => ({ ok: true as const })),
    createCard: vi.fn(async (_b: string, c: Card) => ({ ...c, id: "story-revert" })),
    appendDecision: async (e) => {
      state.log.push(e);
    },
    appendTransition: async (t) => {
      transitions.push(t);
    },
    now: () => Date.parse("2026-09-29T09:00:00Z"),
  };
  return { deps, state, transitions };
}

const accept = (over: Partial<SystemDecision> = {}): SystemDecision => ({
  v: 1,
  id: "sd-1",
  at,
  board: "b",
  cardId: "story-a",
  agent: "triage-judge",
  kind: "triage-accept",
  what: "Aceitou «A»",
  why: "serve a aposta 1",
  undo: { kind: "return-to-triage", cardId: "story-a", from: "enriquecer" },
  ...over,
});
const cardA = coerceCard("story-a", { type: "story", storyType: "technical", title: "A", status: "enriquecer", serves: "story-u" }, "");

describe("undoSystemDecision", () => {
  it("volta o card à Triagem, registra o desfazer (quem, o quê, de qual decisão) e a transição do dono", async () => {
    const w = world([accept()], [cardA]);
    const r = await undoSystemDecision(w.deps, { board: "b", decisionId: "sd-1", note: "fora do PRD" });
    expect(r).toMatchObject({ ok: true });
    expect(w.state.cards[0]).toMatchObject({ status: "triage", needsHumanReview: true });
    expect(w.state.log.at(-1)).toMatchObject({ kind: "undo", agent: "human", undoOf: "sd-1", board: "b", cardId: "story-a", why: "fora do PRD" });
    expect(w.transitions).toEqual([expect.objectContaining({ from: "enriquecer", to: "triage", actor: "human", note: "undo:return-to-triage" })]);
  });

  it("recusa no card FRESCO: o card andou depois da decisão ⇒ nada muda, nada é registrado", async () => {
    const w = world([accept()], [{ ...cardA, status: "desenvolver" }]);
    const r = await undoSystemDecision(w.deps, { board: "b", decisionId: "sd-1" });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringMatching(/já andou/) });
    expect(w.state.log).toHaveLength(1);
  });

  it("já desfeita, de outro board, ou inexistente ⇒ recusa", async () => {
    const undone = { v: 1 as const, id: "sd-2", at, board: "b", agent: "human", kind: "undo" as const, what: "x", why: "x", undoOf: "sd-1" };
    expect((await undoSystemDecision(world([accept(), undone], [cardA]).deps, { board: "b", decisionId: "sd-1" })).ok).toBe(false);
    expect((await undoSystemDecision(world([accept()], [cardA]).deps, { board: "outro", decisionId: "sd-1" })).ok).toBe(false);
    expect((await undoSystemDecision(world([], [cardA]).deps, { board: "b", decisionId: "sd-9" })).ok).toBe(false);
  });

  it("restaurar da lixeira delega à restauração de sempre", async () => {
    const w = world([accept({ undo: { kind: "restore-trash", trashKind: "card", id: "story-z" } })], []);
    expect(await undoSystemDecision(w.deps, { board: "b", decisionId: "sd-1" })).toMatchObject({ ok: true });
    expect(w.deps.restoreTrash).toHaveBeenCalledWith("b", "card", "story-z");
  });

  it("desfazer uma publicação abre o card de reversão para o sha anterior (o pipeline o constrói e publica)", async () => {
    const pub = accept({ kind: "publish", undo: { kind: "republish-previous", cardId: "story-a", sha: "bbb2222", previousSha: "aaa1111" } });
    const w = world([pub], [cardA]);
    const r = await undoSystemDecision(w.deps, { board: "b", decisionId: "sd-1", note: "quebrou o login" });
    expect(r).toMatchObject({ ok: true, createdCardId: "story-revert" });
    const created = (w.deps.createCard as ReturnType<typeof vi.fn>).mock.calls[0][1] as Card;
    expect(created).toMatchObject({ storyType: "technical", status: "triage", serves: "story-u" });
    expect(created.body).toMatch(/aaa1111/);
    expect(created.body).toMatch(/quebrou o login/);
  });
});

describe("o ledger em disco — uma linha JSON por decisão, leitura tolerante", () => {
  it("serializa uma linha e lê de volta; linha torta é pulada; filtro por board", () => {
    const raw = [serializeSystemDecision(accept()), "{torta\n", serializeSystemDecision(accept({ id: "sd-2", board: "outro" }))].join("");
    expect(parseSystemDecisionLines(raw).map((e) => e.id)).toEqual(["sd-1", "sd-2"]);
    expect(parseSystemDecisionLines(raw, { board: "b" }).map((e) => e.id)).toEqual(["sd-1"]);
  });
});

// WP5-F2 — o sistema estacionou um condutor parado (quieto com fila esperando vaga, ou erro de API que não passou).
// «Desfazer» = reabrir o condutor já: o card entra na FRENTE da fila do condutor.
describe("undoSystemDecision — estacionamento de condutor", () => {
  const park = (): SystemDecision => ({ v: 1, id: "sd-park", at, board: "b", cardId: "story-c", agent: "system", kind: "conductor-park", what: "Estacionou o condutor de «C»", why: "quieto", undo: { kind: "resume-conductor", cardId: "story-c" } });
  const conductedC = (status = "desenvolver") => coerceCard("story-c", { type: "story", title: "C", status, routing: { skips: [], decidedBy: "rules", decidedAt: "2026-10-01", driver: "conductor" } }, "");

  it("reabre o condutor (retomada na frente da fila) e registra o desfazer; o card não é escrito", async () => {
    const w = world([park()], [conductedC()]);
    const resumed: string[] = [];
    w.deps.resumeConductor = async (b, c) => void resumed.push(`${b}/${c}`);
    expect(await undoSystemDecision(w.deps, { board: "b", decisionId: "sd-park" })).toEqual({ ok: true });
    expect(resumed).toEqual(["b/story-c"]);
    expect(w.state.cards[0]).toEqual(conductedC());
    expect(w.state.log.at(-1)).toMatchObject({ kind: "undo", undoOf: "sd-park", what: expect.stringMatching(/frente da fila do condutor/) });
  });

  it("recusa quando o card saiu do condutor ou terminou — e sem a dep, diz que não sabe reabrir", async () => {
    const plain = world([park()], [coerceCard("story-c", { type: "story", title: "C", status: "desenvolver" }, "")]);
    plain.deps.resumeConductor = vi.fn(async () => {});
    expect(await undoSystemDecision(plain.deps, { board: "b", decisionId: "sd-park" })).toMatchObject({ ok: false, error: expect.stringMatching(/não está mais com o condutor/) });
    const done = world([park()], [conductedC("cancelado")]);
    done.deps.resumeConductor = vi.fn(async () => {});
    expect(await undoSystemDecision(done.deps, { board: "b", decisionId: "sd-park" })).toMatchObject({ ok: false, error: expect.stringMatching(/já terminou/) });
    expect(plain.deps.resumeConductor).not.toHaveBeenCalled();
    const bare = world([park()], [conductedC()]);
    expect(await undoSystemDecision(bare.deps, { board: "b", decisionId: "sd-park" })).toMatchObject({ ok: false, error: expect.stringMatching(/não sabe reabrir/) });
  });
});

