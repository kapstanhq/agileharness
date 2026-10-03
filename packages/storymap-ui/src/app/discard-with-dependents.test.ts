import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, TrashManifest } from "@/lib/storymap/types";

// O «Descartar» do Inbox num card com dependentes: antes o clique voltava com «reancore-os primeiro». Agora
// o card leva junto, para a lixeira, o que só existe por causa dele — e UM «Desfazer» restaura todos. Sobre um board e
// uma lixeira em memória: o que se fixa aqui é a regra (quem vai, quem segura, a ordem, o grupo), não o disco.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let store: Card[] = [];
let trash: Array<{ card: Card; manifest: TrashManifest }> = [];
let trashOrder: string[] = [];
let failTrashOf: string | null = null;
const config = { id: "b", name: "B", statuses: [{ id: "triagem", name: "Triagem" }, { id: "no-ar", name: "No ar", terminal: true }] } as unknown as BoardConfig;

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return { ...actual, readCards: async () => store.map((c) => ({ ...c })), readBoardConfig: async () => config };
});
vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    trashCardFile: async (_b: string, id: string, manifest: TrashManifest) => {
      if (failTrashOf === id) throw new Error("disco cheio");
      const card = store.find((c) => c.id === id);
      if (!card) return false;
      store = store.filter((c) => c.id !== id);
      trash.push({ card, manifest });
      trashOrder.push(id);
      return true;
    },
    restoreCardFile: async (_b: string, id: string) => {
      const hit = trash.find((t) => t.card.id === id);
      if (!hit) return { ok: false, error: "card não está na lixeira (já restaurado ou expirado)" };
      trash = trash.filter((t) => t !== hit);
      store.push(hit.card);
      return { ok: true };
    },
    updateCardOnDisk: async (_b: string, id: string, mutate: (c: Card) => Card | null) => {
      const idx = store.findIndex((c) => c.id === id);
      if (idx < 0) return null;
      const next = mutate({ ...store[idx] });
      if (next) store[idx] = next;
      return next;
    },
  };
});
vi.mock("@/lib/storymap/trash", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/trash")>();
  return {
    ...actual,
    readTrashManifest: async (_b: string, _k: string, id: string) => trash.find((t) => t.card.id === id)?.manifest ?? null,
    listTrashManifests: async () => trash.map((t) => t.manifest),
  };
});
vi.mock("@/lib/storymap/smart-capture/proposal", () => ({ deleteProposal: async () => {} }));
let claimed = new Set<string>();
vi.mock("@/lib/storymap/runner/claims", () => ({ getCardClaims: () => ({ claimedCardIds: async () => claimed }) }));
let inFlight = new Set<string>();
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: () => ({ isInFlight: (_b: string, id: string) => inFlight.has(id) }) }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn() }));

import { deleteCardAction, restoreDeletedAction } from "@/app/actions";
import { runWithMcpActor } from "@/lib/storymap/mcp/actor";

const mk = (over: Partial<Card>): Card => ({ id: "x", type: "story", title: "t", status: "triagem", parent: null, links: [], ...over }) as Card;
const ids = () => store.map((c) => c.id).sort();

beforeEach(() => {
  store = [
    mk({ id: "ideia", title: "Publicar posts toda semana" }),
    mk({ id: "entrega", title: "Agendador de posts", serves: "ideia" }),
    mk({ id: "tarefa", title: "Tela do agendador", parent: "entrega" }),
    mk({ id: "vizinho", title: "Outro card", parent: "passo", links: [{ rel: "relates-to", to: "tarefa" }, { rel: "relates-to", to: "ideia" }] }),
  ];
  trash = [];
  trashOrder = [];
  failTrashOf = null;
  claimed = new Set();
  inFlight = new Set();
});

describe("descartar um card COM o que depende dele", () => {
  it("sem pedir (`withDependents` ausente) a recusa de sempre continua — e nada sai do board", async () => {
    const r = await deleteCardAction({ boardId: "b", cardId: "ideia" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Adiar — não agora/);
    expect(ids()).toEqual(["entrega", "ideia", "tarefa", "vizinho"]);
  });

  it("com o pedido: o card e TODA a cadeia vão para a lixeira com a mesma marca; os links de quem fica são limpos", async () => {
    const r = await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true, reason: "descartado pelo Inbox" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data?.trashed.sort()).toEqual(["entrega", "ideia", "tarefa"]);
    expect(ids()).toEqual(["vizinho"]);
    // do mais longe para o mais perto, o card por último: uma falha no meio nunca deixa um dependente sem o card dele
    expect(trashOrder).toEqual(["tarefa", "entrega", "ideia"]);
    const groups = new Set(trash.map((t) => t.manifest.group));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toMatch(/^ideia@\d{4}-/);
    expect(r.ok && r.data?.unlinked).toEqual(["vizinho"]);
    expect(store[0].links).toEqual([]);
  });

  it("UM desfazer restaura todos: restaurar o card com `withGroup` traz a cadeia inteira de volta", async () => {
    await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true });
    const r = await restoreDeletedAction({ boardId: "b", kind: "card", id: "ideia", withGroup: true });
    expect(r.ok).toBe(true);
    expect(r.ok && r.data?.restored.sort()).toEqual(["entrega", "ideia", "tarefa"]);
    expect(r.ok && r.data?.notRestored).toEqual([]);
    expect(ids()).toEqual(["entrega", "ideia", "tarefa", "vizinho"]);
    expect(trash).toEqual([]);
    expect(store.find((c) => c.id === "entrega")?.serves).toBe("ideia"); // a ancoragem voltou com o card
  });

  it("restaurar SEM `withGroup` (a gaveta da lixeira) traz só o card pedido", async () => {
    await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true });
    const r = await restoreDeletedAction({ boardId: "b", kind: "card", id: "ideia" });
    expect(r.ok && r.data?.restored).toEqual(["ideia"]);
    expect(ids()).toEqual(["ideia", "vizinho"]);
  });

  it("um dependente que já PRODUZIU trabalho segura o descarte inteiro, com a frase do dono", async () => {
    store = store.map((c) => (c.id === "tarefa" ? { ...c, qaPassed: true } as Card : c));
    const r = await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("Não dá para descartar junto: «Tela do agendador», que depende deste card, já passou pela verificação. Abra esse card e decida o que fazer com ele; depois descarte este.");
    expect(ids()).toEqual(["entrega", "ideia", "tarefa", "vizinho"]);
    expect(trash).toEqual([]);
  });

  it("alguém trabalhando AGORA num dependente (reserva viva ou run em voo) também segura", async () => {
    claimed = new Set(["entrega"]);
    expect(await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true })).toMatchObject({ ok: false, error: expect.stringMatching(/«Agendador de posts».*trabalhando nele agora/) });
    claimed = new Set();
    inFlight = new Set(["tarefa"]);
    expect(await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true })).toMatchObject({ ok: false, error: expect.stringMatching(/«Tela do agendador».*trabalhando nele agora/) });
    expect(trash).toEqual([]);
  });

  it("um AGENTE não descarta em grupo — apaga um card por vez", async () => {
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "T" }, () => deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true }));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Só o dono descarta/) });
    expect(ids()).toEqual(["entrega", "ideia", "tarefa", "vizinho"]);
  });

  it("card SEM dependentes: `withDependents` não muda nada (um card, sem marca de grupo)", async () => {
    const r = await deleteCardAction({ boardId: "b", cardId: "tarefa", withDependents: true });
    expect(r.ok && r.data?.trashed).toEqual(["tarefa"]);
    expect(trash[0].manifest.group).toBeUndefined();
  });

  it("falha de disco no meio: o que sobrou no board ainda é uma árvore inteira (nenhum dependente sem o card dele)", async () => {
    failTrashOf = "entrega";
    const r = await deleteCardAction({ boardId: "b", cardId: "ideia", withDependents: true });
    expect(r.ok).toBe(false);
    expect(ids()).toEqual(["entrega", "ideia", "vizinho"]); // só a folha saiu; «entrega» segue servindo «ideia»
    expect(store.find((c) => c.id === "entrega")?.serves).toBe("ideia");
  });
});
