// B21 (auditoria do Inbox) — a tentativa de entrega (`deployFiredAt` + `deployTargets` + o
// `deploy-unproven` aberto) é encerrada NA CHOKEPOINT de escrita (updateCardOnDisk) sempre que o card sai do passo de
// publicação por qualquer caminho que não seja o avanço do próprio settle. Sem isso, um card
// movido para outra coluna por um agente (MCP move_card) levaria o carimbo junto, e o Inbox mostraria no mesmo card
// «deploy sem confirmação» ao lado de uma ação de avançar que já não faz sentido.
//
// DISCO DE VERDADE: um alvo temporário com o `_base` real, um board e a hierarquia mínima. É a única forma de provar
// que o caminho de cada ação passa pela chokepoint — um updateCardOnDisk falso provaria só o próprio mock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({ evaluateAutorunOnEntry: vi.fn(async () => {}) }));
vi.mock("@/lib/storymap/runner/merge-queue", () => ({ getMergeQueue: () => ({ reconcileCardMergeEntries: async () => {} }) }));
vi.mock("@/lib/storymap/runner/entry-effects", () => ({ runEntryEffect: vi.fn(async () => {}), ENTRY_EFFECTS: {} }));

import { findRepoRoot, resetRepoRootCache } from "@/lib/storymap/paths";
import { readCard } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { CARD_STALLED_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID } from "@/lib/storymap/demands";
import { discontinueCardAction, moveCardAction, updateCardAction } from "./actions";

const BASE_REAL = path.join(findRepoRoot(), "storymap", "boards", "_base");
let root = "";

function cardFile(id: string, data: Record<string, unknown>) {
  writeFileSync(path.join(root, "storymap", "boards", "lab", "cards", `${id}.md`), matter.stringify("\n", data));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ah-b21-"));
  writeFileSync(path.join(root, "turbo.json"), "{}\n");
  mkdirSync(path.join(root, "storymap", "boards", "lab", "cards"), { recursive: true });
  cpSync(BASE_REAL, path.join(root, "storymap", "boards", "_base"), { recursive: true });
  writeFileSync(path.join(root, "storymap", "boards", "lab", "board.yaml"), "id: lab\nname: Lab\n");
  process.env.AGILEHARNESS_TARGET = root;
  resetRepoRootCache();
  cardFile("act-1", { id: "act-1", type: "activity", title: "Ação", status: null, parent: null });
  cardFile("step-1", { id: "step-1", type: "step", title: "Passo", status: null, parent: "act-1" });
  cardFile("story-x", {
    id: "story-x",
    type: "story",
    storyType: "user",
    title: "Publicar a coisa",
    status: "deploy",
    parent: "step-1",
    deployFiredAt: "2026-04-14T10:05:31.208Z",
    deployTargets: ["alvo"],
    findings: [{ id: DEPLOY_UNPROVEN_FINDING_ID, lens: "general", severity: "high", title: "Publicado sem prova", status: "open" }],
  });
});

afterEach(() => {
  delete process.env.AGILEHARNESS_TARGET;
  resetRepoRootCache();
  rmSync(root, { recursive: true, force: true });
});

async function expectAttemptClosed() {
  const c = await readCard("lab", "story-x");
  expect(c?.status).not.toBe("deploy");
  expect(c?.deployFiredAt).toBeUndefined();
  expect(c?.deployTargets ?? []).toEqual([]);
  expect(c?.findings.find((f) => f.id === DEPLOY_UNPROVEN_FINDING_ID)?.status).toBe("fixed");
}

describe("B21 — sair de Publicar encerra a tentativa de entrega, por qualquer caminho", () => {
  it("move à mão / MCP move_card (moveCardAction)", async () => {
    const res = await moveCardAction({ boardId: "lab", cardId: "story-x", status: "release" });
    expect(res.ok, !res.ok ? res.error : "").toBe(true);
    await expectAttemptClosed();
  });

  it("gaveta / MCP update_card (updateCardAction)", async () => {
    const card = (await readCard("lab", "story-x"))!;
    const res = await updateCardAction({ boardId: "lab", card: { ...card, status: "release" } });
    expect(res.ok, !res.ok ? res.error : "").toBe(true);
    await expectAttemptClosed();
  });

  it("descontinuar (discontinueCardAction → Arquivados)", async () => {
    const res = await discontinueCardAction({ boardId: "lab", cardId: "story-x", brief: "saiu do produto", disposition: "abandonado" });
    expect(res.ok, !res.ok ? res.error : "").toBe(true);
    await expectAttemptClosed();
  });

  it("qualquer escrita que mude o status (a chokepoint, direto)", async () => {
    await updateCardOnDisk("lab", "story-x", (c) => ({ ...c, status: "release" }));
    await expectAttemptClosed();
  });

  it("uma escrita que NÃO tira o card de Publicar mantém a tentativa viva", async () => {
    await updateCardOnDisk("lab", "story-x", (c) => ({ ...c, title: "Publicar a coisa (v2)" }));
    const c = await readCard("lab", "story-x");
    expect(c?.deployFiredAt).toBe("2026-04-14T10:05:31.208Z");
    expect(c?.deployTargets).toEqual(["alvo"]);
  });
});

// Paradas por recurso, fatia 1 — o achado `card-stalled` (o vigia) é do passo onde o card parou: a MESMA chokepoint o
// fecha quando o card muda de status. O card aqui não carrega NADA da tentativa de entrega (sem carimbo, sem alvos):
// é a pré-checagem `carries` de closeStepAttemptOnExit que tem de enxergar o achado sozinho.
describe("o card parado sem ninguém cuidando — sair do passo fecha o achado do vigia", () => {
  const stalled = { id: CARD_STALLED_FINDING_ID, lens: "general", severity: "high", title: "Parado em «Liberar» sem ninguém cuidando", status: "open" };
  beforeEach(() => {
    cardFile("story-s", { id: "story-s", type: "story", storyType: "user", title: "Card parado", status: "release", parent: "step-1", findings: [stalled] });
  });

  it("qualquer escrita que mude o status fecha o achado, assinada pelo sistema, com a data de hoje", async () => {
    await updateCardOnDisk("lab", "story-s", (c) => ({ ...c, status: "revisao" }));
    const f = (await readCard("lab", "story-s"))?.findings.find((x) => x.id === CARD_STALLED_FINDING_ID);
    expect(f).toMatchObject({ status: "fixed", statusBy: "system:saiu-do-passo", statusAt: new Date().toISOString().slice(0, 10) });
  });

  it("uma escrita que NÃO muda o status mantém o achado aberto (o card segue parado)", async () => {
    await updateCardOnDisk("lab", "story-s", (c) => ({ ...c, title: "Card parado (v2)" }));
    const f = (await readCard("lab", "story-s"))?.findings.find((x) => x.id === CARD_STALLED_FINDING_ID);
    expect(f?.status).toBe("open");
  });
});
