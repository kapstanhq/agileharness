// MUDAR UM CARD DE BOARD — o IO. Duas metades: (1) o orquestrador contra fakes — recusa medida no servidor, a ordem
// dos efeitos, o salto no ledger e a decisão nos DOIS boards; (2) a escrita de verdade num alvo temporário — o card e os
// anexos vão para o board novo com o MESMO id, a origem some, e os vínculos de quem ficou caem.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { coerceCard, readCards } from "@/lib/storymap/repo";
import { planPath, refineDir, resetRepoRootCache } from "@/lib/storymap/paths";
import { serializeCard } from "@/lib/storymap/write";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import { moveCardFiles, stripLinksTo, transferCard, type CardTransferDeps } from "./card-transfer-service";

const statuses = [
  { id: "triage", name: "Triagem", staging: true },
  { id: "enriquecer", name: "Especificar" },
];
const cfgOf = (id: string, name: string) => ({ id, name, statuses, releases: [], personas: [], systems: [], linkTypes: [] }) as unknown as BoardConfig;

function fakes(over: Partial<CardTransferDeps> = {}) {
  // na Triagem: sem âncora, é onde o card é representável (a régua de hierarquia da escrita)
  const card = coerceCard("story-poda", { type: "story", storyType: "technical", title: "Afiar as tesouras de poda", status: "triage" }, "");
  const calls: string[] = [];
  const records: SystemDecision[] = [];
  const transitions: unknown[] = [];
  const deps: CardTransferDeps = {
    listBoards: async () => [
      { id: "estufa", name: "Estufa" },
      { id: "galpao", name: "Galpão" },
    ],
    readBoardConfig: async (b) => (b === "estufa" ? cfgOf("estufa", "Estufa") : b === "galpao" ? cfgOf("galpao", "Galpão") : null),
    readCards: async (b) => (b === "estufa" ? [card] : []),
    busy: async () => ({}),
    moveFiles: async (_f, _t, _id, mutate) => {
      calls.push("moveFiles");
      return mutate(card);
    },
    stripLinks: async () => {
      calls.push("stripLinks");
      return ["story-vizinho"];
    },
    rehome: async () => void calls.push("rehome"),
    appendTransition: async (t) => void transitions.push(t),
    record: async (e) => void records.push(e),
    after: () => void calls.push("after"),
    now: () => Date.parse("2026-05-04T10:00:00.000Z"),
    log: () => {},
    ...over,
  };
  return { deps, calls, records, transitions };
}

describe("transferCard — o orquestrador", () => {
  it("muda o card: escrita, vínculos, histórico, salto no ledger do board NOVO e uma decisão em CADA board", async () => {
    const { deps, calls, records, transitions } = fakes();
    const r = await transferCard(deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", reason: "a ferramenta é do galpão", by: "human" });
    expect(r).toMatchObject({ ok: true, fromStatus: "triage", toStatus: "triage" });
    expect(calls).toEqual(["moveFiles", "stripLinks", "rehome", "after"]);
    expect(transitions).toEqual([
      { board: "galpao", cardId: "story-poda", from: "triage", to: "triage", actor: "human", note: "transfer:estufa→galpao" },
    ]);
    expect(records.map((e) => [e.board, e.cardId ?? null, e.kind, e.what])).toEqual([
      ["estufa", null, "card-transfer", "Mudou «Afiar as tesouras de poda» para o board «Galpão»"],
      ["galpao", "story-poda", "card-transfer", "Recebeu «Afiar as tesouras de poda» do board «Estufa»"],
    ]);
    expect(records[1].why).toMatch(/a ferramenta é do galpão/);
    expect(r.ok && r.warnings.join(" ")).toMatch(/1 card\(s\) do board antigo tinham vínculo/);
  });

  it("o roteamento da triagem é registrado como tal (e o ator é o juiz)", async () => {
    const { deps, records, transitions } = fakes();
    await transferCard(deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", reason: "pacote de lá", by: "triage-judge" });
    expect(records.every((e) => e.kind === "triage-route" && e.agent === "triage-judge")).toBe(true);
    expect(transitions[0]).toMatchObject({ actor: "run:triage-judge" });
  });

  it("o que trabalha no card é medido no servidor: ocupado ⇒ recusa e NADA é escrito", async () => {
    const moveFiles = vi.fn();
    const { deps, records } = fakes({ busy: async () => ({ session: true }), moveFiles });
    const r = await transferCard(deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "agent" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/sessão de trabalho/) });
    expect(moveFiles).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("a ocupação é MEDIDA DE NOVO sob os locks: um trabalho que começou depois da 1ª medição recusa e nada é escrito", async () => {
    let n = 0;
    const { deps, records } = fakes({ busy: async () => (++n === 1 ? {} : { claim: true }) });
    const r = await transferCard(deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "agent" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/reservado/) });
    expect(n).toBe(2);
    expect(records).toEqual([]);
  });

  it("um AGENTE mudando para um board mais permissivo: o card entra pela Triagem de lá; o OPERADOR mantém o passo", async () => {
    // a âncora existe nos dois boards (uma história de usuário de mesmo id): o passo é representável lá
    const placed = coerceCard("story-poda", { type: "story", storyType: "technical", title: "Afiar", status: "enriquecer", serves: "story-mudas" }, "");
    const anchorThere = coerceCard("story-mudas", { type: "story", storyType: "user", title: "Ver as mudas", status: "enriquecer", parent: "step-x" }, "");
    const stepThere = coerceCard("step-x", { type: "step", title: "Passo", status: null }, "");
    const strict = { config: { autonomy: { mode: "human" } }, pace: "slow", admits: true } as never;
    const loose = { config: { autonomy: { mode: "ultra" }, release: { mode: "auto" } }, pace: "normal", admits: true } as never;
    const mk = () =>
      fakes({
        readCards: async (b) => (b === "estufa" ? [placed] : [stepThere, anchorThere]),
        moveFiles: async (_f, _t, _id, mutate) => mutate(placed),
        regime: async (b) => (b === "estufa" ? strict : loose),
      });
    const agent = await transferCard(mk().deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "agent" });
    expect(agent).toMatchObject({ ok: true, fromStatus: "enriquecer", toStatus: "triage" });
    expect(agent.ok && agent.warnings.join(" ")).toMatch(/mais permissivo/);
    const judge = await transferCard(mk().deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "triage-judge" });
    expect(judge).toMatchObject({ ok: true, toStatus: "triage" });
    const human = await transferCard(mk().deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "human" });
    expect(human).toMatchObject({ ok: true, toStatus: "enriquecer" });
    // destino igual ou mais estrito: o agente mantém o passo
    const same = await transferCard(fakes({ readCards: async (b) => (b === "estufa" ? [placed] : [stepThere, anchorThere]), moveFiles: async (_f, _t, _id, m) => m(placed), regime: async () => strict }).deps, {
      fromBoard: "estufa",
      toBoard: "galpao",
      cardId: "story-poda",
      by: "agent",
    });
    expect(same).toMatchObject({ ok: true, toStatus: "enriquecer" });
  });

  it("o plano não cabe no board novo (sem âncora e sem Triagem lá) ⇒ recusa com o motivo, nada registrado", async () => {
    const semTriagem = { id: "galpao", name: "Galpão", statuses: [{ id: "enriquecer", name: "Especificar" }], releases: [], personas: [], systems: [], linkTypes: [] } as unknown as BoardConfig;
    const placed = coerceCard("story-poda", { type: "story", storyType: "technical", title: "Afiar", status: "enriquecer", serves: "story-x" }, "");
    const { deps, records } = fakes({
      readBoardConfig: async (b) => (b === "galpao" ? semTriagem : cfgOf("estufa", "Estufa")),
      readCards: async (b) => (b === "estufa" ? [placed] : []),
      moveFiles: async (_f, _t, _id, mutate) => mutate(placed),
    });
    const r = await transferCard(deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "human" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/não tem Triagem/) });
    expect(records).toEqual([]);
  });

  it("board de destino inexistente ⇒ recusa", async () => {
    const { deps } = fakes();
    expect(await transferCard(deps, { fromBoard: "estufa", toBoard: "marte", cardId: "story-poda", by: "human" })).toMatchObject({ ok: false, error: expect.stringMatching(/não existe/) });
  });

  it("a escrita sumiu com o card (mutado por outro) ⇒ recusa sem registrar nada", async () => {
    const { deps, records } = fakes({ moveFiles: async () => null });
    expect(await transferCard(deps, { fromBoard: "estufa", toBoard: "galpao", cardId: "story-poda", by: "human" })).toMatchObject({ ok: false });
    expect(records).toEqual([]);
  });
});

// ── a escrita de verdade, num alvo temporário ─────────────────────────────────────────────────────────────────
describe("moveCardFiles / stripLinksTo — no disco", () => {
  let root = "";
  let alvoAnterior: string | undefined;
  const boardsDir = () => path.join(root, "storymap", "boards");
  const writeBoard = (id: string, name: string) => {
    mkdirSync(path.join(boardsDir(), id, "cards"), { recursive: true });
    writeFileSync(path.join(boardsDir(), id, "board.yaml"), `id: ${id}\nname: ${name}\n`);
  };
  const writeCard = (board: string, card: Card) => writeFileSync(path.join(boardsDir(), board, "cards", `${card.id}.md`), serializeCard(card));

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "ah-transfer-"));
    // o `_base` da própria ferramenta (o pipeline canônico) — o alvo de teste herda dele, como um alvo real
    const toolBase = path.resolve(__dirname, "../../../../../../storymap/boards/_base");
    cpSync(toolBase, path.join(boardsDir(), "_base"), { recursive: true });
    writeBoard("estufa", "Estufa");
    writeBoard("galpao", "Galpão");
    alvoAnterior = process.env.AGILEHARNESS_TARGET;
    process.env.AGILEHARNESS_TARGET = root;
    resetRepoRootCache();
  });
  afterAll(() => {
    if (alvoAnterior === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = alvoAnterior;
    resetRepoRootCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("grava no destino com o MESMO id, leva os anexos, apaga a origem — e os vínculos de quem ficou caem", async () => {
    const card = coerceCard("story-vaso", { type: "story", storyType: "technical", title: "Trocar os vasos rachados", status: "enriquecer" }, "texto");
    const vizinho = coerceCard("story-vizinho", { type: "story", storyType: "technical", title: "Vizinho", status: "triage", links: [{ rel: "relates-to", to: "story-vaso" }] }, "");
    writeCard("estufa", card);
    writeCard("estufa", vizinho);
    mkdirSync(path.dirname(planPath("estufa", "story-vaso")), { recursive: true });
    writeFileSync(planPath("estufa", "story-vaso"), "# plano");
    mkdirSync(refineDir("estufa", "story-vaso"), { recursive: true });
    writeFileSync(path.join(refineDir("estufa", "story-vaso"), "antes.png"), "png");

    const written = await moveCardFiles("estufa", "galpao", "story-vaso", (fresh) => ({ ...fresh, title: `${fresh.title} (mudado)` }));
    expect(written?.id).toBe("story-vaso");
    expect(existsSync(path.join(boardsDir(), "estufa", "cards", "story-vaso.md"))).toBe(false);
    expect((await readCards("galpao")).find((c) => c.id === "story-vaso")?.title).toBe("Trocar os vasos rachados (mudado)");
    expect(readFileSync(planPath("galpao", "story-vaso"), "utf8")).toBe("# plano");
    expect(existsSync(path.join(refineDir("galpao", "story-vaso"), "antes.png"))).toBe(true);
    expect(existsSync(planPath("estufa", "story-vaso"))).toBe(false);

    expect(await stripLinksTo("estufa", "story-vaso")).toEqual(["story-vizinho"]);
    expect((await readCards("estufa")).find((c) => c.id === "story-vizinho")?.links).toEqual([]);
  });

  it("o destino já tem o id ⇒ lança antes de tocar a origem", async () => {
    const a = coerceCard("story-dup", { type: "story", title: "A", status: "enriquecer" }, "");
    writeCard("estufa", a);
    writeCard("galpao", a);
    await expect(moveCardFiles("estufa", "galpao", "story-dup", (f) => f)).rejects.toThrow(/já existe/);
    expect(existsSync(path.join(boardsDir(), "estufa", "cards", "story-dup.md"))).toBe(true);
  });

  it("card que sumiu da origem ⇒ null, nada escrito", async () => {
    expect(await moveCardFiles("estufa", "galpao", "story-fantasma", (f) => f)).toBeNull();
  });
});
