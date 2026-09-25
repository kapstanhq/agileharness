// lanes-ultra — the new DATA fields, in lockstep across the four places a field must live (type · coerce ·
// contract · serializer/persist). Each case is the regression the missing place would cause:
//   • board `view` / `autonomy` dropped by the coerce ⇒ declared in board.yaml and silently INERT (no lanes, no
//     proxy); dropped by the persist ⇒ any board.yaml save (vocab/canvas) deletes the block from disk;
//   • card `autonomyMode` dropped by the serializer ⇒ the next app write erases the owner's per-story exception;
//   • question `category` dropped ⇒ every question becomes uncategorized (the owner's) — ultra quietly does nothing;
//   • question `proxy` dropped ⇒ a proxy answer loses its premissas/audit trail and passes for the owner's.

import { afterEach, describe, expect, it, vi } from "vitest";
import matter from "gray-matter";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dump } from "js-yaml";
import { coerceAutonomy, coerceBoardNotifications, coerceBoardView, coerceCard, deriveBoardConfigForPersist, readBoardConfig } from "./repo";
import { serializeCard } from "./write";
import { parseBoardConfig, parseCard } from "./contracts";
import { FIXTURE_BOARD } from "./board-fixture";
import { findRepoRoot, resetRepoRootCache } from "./paths";

const roundTrip = (raw: Record<string, unknown>) => {
  const card = coerceCard("story-x", raw, "");
  const parsed = matter(serializeCard(card));
  return { card, back: coerceCard("story-x", parsed.data, parsed.content) };
};

describe("board `view.lanes` — type · coerce · contract · persist", () => {
  it("coerceBoardView: raia sem id/label cai; status aparados; demand true ou lista de tipos CONHECIDOS", () => {
    expect(coerceBoardView(undefined)).toBeUndefined();
    expect(coerceBoardView({ lanes: [] })).toBeUndefined();
    expect(
      coerceBoardView({
        lanes: [
          { id: " a ", label: "A", statuses: [" triage ", "", 3] },
          { id: "", label: "sem id", statuses: [] },
          { id: "b", label: "B", statuses: [], demand: true },
          { id: "c", label: "C", statuses: [], demand: ["question", "inventado", "question"] },
          { id: "d", label: "D", statuses: [], demand: ["inventado"] },
        ],
      }),
    ).toEqual({
      lanes: [
        { id: "a", label: "A", statuses: ["triage"] },
        { id: "b", label: "B", statuses: [], demand: true },
        { id: "c", label: "C", statuses: [], demand: ["question"] },
        { id: "d", label: "D", statuses: [] },
      ],
    });
  });

  it("o contrato aceita o bloco (e recusa um tipo de demanda fora do vocabulário)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const view = { lanes: [{ id: "a", label: "A", statuses: ["triage"], demand: true }] };
    expect(parseBoardConfig({ ...base, view }).ok).toBe(true);
    expect(parseBoardConfig({ ...base, view: { lanes: [{ id: "a", label: "A", statuses: [], demand: ["x"] }] } }).ok).toBe(false);
  });

  it("deriveBoardConfigForPersist EMITE a vista — um save de outra coisa não apaga a linha", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const view = { lanes: [{ id: "a", label: "A", statuses: ["triage"] }] };
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, view })).view).toEqual(view);
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, view: undefined })).view).toBeUndefined();
  });

  it("um board sem os blocos lê `view`/`autonomy` ausentes (sem chave fantasma = legado byte-idêntico)", async () => {
    const cfg = await readBoardConfig(FIXTURE_BOARD);
    expect("view" in cfg).toBe(false);
    expect("autonomy" in cfg).toBe(false);
  });
});

describe("board `autonomy` — type · coerce · contract · persist", () => {
  it("coerceAutonomy: modo desconhecido derruba o bloco (⇒ human); modelo e taxa validados; taxa presa em [0,1]", () => {
    expect(coerceAutonomy(undefined)).toBeUndefined();
    expect(coerceAutonomy({ mode: "ultr" })).toBeUndefined();
    expect(coerceAutonomy({ mode: "ultra" })).toEqual({ mode: "ultra" });
    expect(coerceAutonomy({ mode: "ultra", proxyModel: "haiku", auditSampleRate: 0.3 })).toEqual({
      mode: "ultra",
      proxyModel: "haiku",
      auditSampleRate: 0.3,
    });
    expect(coerceAutonomy({ mode: "human", proxyModel: "gpt", auditSampleRate: 7 })).toEqual({ mode: "human", auditSampleRate: 1 });
    expect(coerceAutonomy({ mode: "ultra", auditSampleRate: "" })).toEqual({ mode: "ultra" });
  });

  it("o contrato aceita o bloco e recusa um modo fora do vocabulário", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    expect(parseBoardConfig({ ...base, autonomy: { mode: "ultra", auditSampleRate: 0.2 } }).ok).toBe(true);
    expect(parseBoardConfig({ ...base, autonomy: { mode: "turbo" } }).ok).toBe(false);
  });

  it("deriveBoardConfigForPersist EMITE a chave de autonomia", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const autonomy = { mode: "ultra" as const, auditSampleRate: 0.2 };
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, autonomy })).autonomy).toEqual(autonomy);
  });
});

// v0.9 — os SINAIS CRÍTICOS do board (board.yaml `notifications.criticalTitlePrefixes`): dropado pelo coerce, o
// bloco seria declarado e INERTE (o monitor do produto grita e o dono não ouve); dropado pelo persist, qualquer
// save do board.yaml apagaria a linha do disco.
describe("board `notifications` — type · coerce · contract · persist", () => {
  it("coerceBoardNotifications: só strings não-vazias, sem duplicata, o INÍCIO do prefixo intocado", () => {
    expect(coerceBoardNotifications(undefined)).toBeUndefined();
    expect(coerceBoardNotifications({ criticalTitlePrefixes: [] })).toBeUndefined();
    expect(coerceBoardNotifications({ criticalTitlePrefixes: "[sinal:" })).toBeUndefined();
    expect(
      coerceBoardNotifications({ criticalTitlePrefixes: ["[sinal:scraper:", "  ", 7, "[sinal:scraper:", "[sinal:credits: "] }),
    ).toEqual({ criticalTitlePrefixes: ["[sinal:scraper:", "[sinal:credits:"] });
  });

  it("o contrato aceita o bloco (e recusa prefixo vazio)", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    expect(parseBoardConfig({ ...base, notifications: { criticalTitlePrefixes: ["[sinal:scraper:"] } }).ok).toBe(true);
    expect(parseBoardConfig({ ...base, notifications: { criticalTitlePrefixes: [""] } }).ok).toBe(false);
  });

  it("deriveBoardConfigForPersist EMITE o bloco — um save de outra coisa não apaga os sinais", async () => {
    const base = await readBoardConfig(FIXTURE_BOARD);
    const notifications = { criticalTitlePrefixes: ["[sinal:scraper:"] };
    expect((await deriveBoardConfigForPersist(FIXTURE_BOARD, { ...base, notifications })).notifications).toEqual(notifications);
    expect("notifications" in (await readBoardConfig(FIXTURE_BOARD))).toBe(false);
  });
});

describe("card `autonomyMode` — type · coerce · contract · serializer", () => {
  const raw = { type: "story", status: "pronta", autonomyMode: "ultra" };

  it("round-trip idêntico; ausente segue ausente; valor desconhecido é descartado", () => {
    const { card, back } = roundTrip(raw);
    expect(card.autonomyMode).toBe("ultra");
    expect(back.autonomyMode).toBe("ultra");
    expect(roundTrip({ type: "story", status: "pronta" }).back.autonomyMode).toBeUndefined();
    expect(coerceCard("story-x", { ...raw, autonomyMode: "turbo" }, "").autonomyMode).toBeUndefined();
  });

  it("o contrato Card aceita o modo (e recusa um fora do vocabulário)", () => {
    const card = coerceCard("story-x", raw, "");
    expect(parseCard(card).ok).toBe(true);
    expect(parseCard({ ...card, autonomyMode: "turbo" as never }).ok).toBe(false);
  });
});

describe("question `category` + `proxy` — type · coerce · contract · serializer", () => {
  const q = {
    id: "q1",
    text: "Quem é o público?",
    status: "answered",
    answer: "Leitoras",
    answeredBy: "proxy",
    category: "interview",
    proxy: { assumptions: "PRD §público: leitoras por indicação", confidence: 0.8, runId: "r1", audit: true },
  };

  it("round-trip idêntico dos dois campos", () => {
    const { back } = roundTrip({ type: "story", status: "grill", questions: [q] });
    expect(back.questions?.[0]).toMatchObject({ category: "interview", answeredBy: "proxy", proxy: q.proxy });
  });

  it("categoria desconhecida cai; registro de proxy SEM premissas ou com confiança fora de [0,1] cai inteiro", () => {
    const c1 = coerceCard("story-x", { type: "story", questions: [{ ...q, category: "vibes" }] }, "");
    expect(c1.questions?.[0].category).toBeUndefined();
    const c2 = coerceCard("story-x", { type: "story", questions: [{ ...q, proxy: { assumptions: " ", confidence: 0.5 } }] }, "");
    expect(c2.questions?.[0].proxy).toBeUndefined();
    const c3 = coerceCard("story-x", { type: "story", questions: [{ ...q, proxy: { assumptions: "x", confidence: 2 } }] }, "");
    expect(c3.questions?.[0].proxy).toBeUndefined();
  });

  it("o contrato Card aceita os campos e recusa categoria fora do vocabulário", () => {
    const card = coerceCard("story-x", { type: "story", status: "grill", questions: [q] }, "");
    expect(parseCard(card).ok).toBe(true);
    expect(parseCard({ ...card, questions: [{ ...card.questions![0], category: "vibes" as never }] }).ok).toBe(false);
  });
});

// The READ path end to end: a board.yaml on disk (over the REAL `_base`) declaring the three blocks — the
// whitelist builder in resolveBoardConfigFromOwnRaw is the fourth place a board field must live, and only a real
// read proves it is wired (the coerce/persist units above can all be green with the builder line missing).
describe("readBoardConfig — os blocos declarados chegam ao config resolvido", () => {
  const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
  const tmp: string[] = [];
  afterEach(() => {
    delete process.env.AGILEHARNESS_TARGET;
    resetRepoRootCache();
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const boardOnDisk = (raw: Record<string, unknown>): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ah-lanes-"));
    tmp.push(root);
    writeFileSync(path.join(root, "turbo.json"), "{}\n");
    mkdirSync(path.join(root, "storymap", "boards", "lab", "cards"), { recursive: true });
    cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
    writeFileSync(path.join(root, "storymap", "boards", "lab", "board.yaml"), dump({ id: "lab", name: "Lab", ...raw }));
    process.env.AGILEHARNESS_TARGET = root;
    resetRepoRootCache();
    return "lab";
  };

  it("view.lanes, autonomy e conductor.fromStatus em lista — lidos do disco", async () => {
    const lanes = [
      { id: "a", label: "A", statuses: ["triage"] },
      { id: "voce", label: "Precisa de você", statuses: ["revisao"], demand: true },
    ];
    const board = boardOnDisk({
      view: { lanes },
      autonomy: { mode: "ultra", auditSampleRate: 0.3 },
      conductor: { enabled: true, fromStatus: ["enriquecer", "corrigir"] },
      notifications: { criticalTitlePrefixes: ["[sinal:scraper:", "[sinal:credits:"] },
    });
    const cfg = await readBoardConfig(board);
    expect(cfg.view).toEqual({ lanes });
    expect(cfg.autonomy).toEqual({ mode: "ultra", auditSampleRate: 0.3 });
    expect(cfg.conductor).toEqual({ enabled: true, fromStatus: ["enriquecer", "corrigir"] });
    expect(cfg.notifications).toEqual({ criticalTitlePrefixes: ["[sinal:scraper:", "[sinal:credits:"] });
  });

  it("um mapa de raias torto GRITA no log do serviço (nunca apaga o board)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const board = boardOnDisk({ view: { lanes: [{ id: "a", label: "A", statuses: ["triage", "fantasma"] }] } });
    const cfg = await readBoardConfig(board);
    expect(cfg.view?.lanes).toHaveLength(1);
    const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/view\.lanes: a raia 'A' lista o status 'fantasma'/);
    expect(logged).toMatch(/view\.lanes: o status 'desenvolver' \(Desenvolver\) não está em nenhuma raia/);
  });
});
