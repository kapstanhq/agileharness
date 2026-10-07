// Fase 7 — o SPIKE do train com um LOTE (plano §8, risco 3), em git DE VERDADE. Uma sessão de lote mexe no card do líder
// e nos cards dos itens no worktree dela (o carimbo do QA, a prova da entrega); enquanto isso o SERVIÇO grava a marca do
// lote (`batch`) nos três cards de main (`claim_batch`, commitado pelo flush do board) e congela o assunto do plano no
// disco do líder (`planHash`, ainda não versionado). A metade de dados do train tem de levar os TRÊS cards e fundi-los
// por campo: o que é do run (o carimbo) chega a main, e a marca do lote — campo do pipeline que só o serviço escreve —
// sobrevive nos três. Sem isto, um item perdia a marca na integração e saía do lote calado (o orçamento, a parada única
// e o «Agora: N correções» do Kanban dependem dela). Fixtures inventadas (story-ex97NN).

import { exec as nodeExec } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";
import { ensureRunnerStateDir, isolatedGitExec } from "./git-test-env";
import { makeMergeQueue, type MergeQueueStore } from "./merge-queue";
import { describePosix } from "./test-platform";
import type { MergeQueueEntry } from "./types";
import type { ExecFn } from "./worktree";

let exec = promisify(nodeExec) as unknown as ExecFn;

function memStore(): MergeQueueStore & { read: () => MergeQueueEntry[] } {
  let saved: MergeQueueEntry[] = [];
  return {
    load: async () => saved.map((e) => ({ ...e })),
    persist: async (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
    read: () => saved,
  };
}

const CARDS = "storymap/boards/tb/cards";
const IDS = ["story-ex9701", "story-ex9702", "story-ex9703"] as const;
const cardPath = (id: string) => `${CARDS}/${id}.md`;
const cardText = (id: string, extra: string[] = [], body = "corpo") =>
  ["---", `id: ${id}`, "type: story", "storyType: bug", `title: Conserto ${id}`, "status: desenvolver", ...extra, "---", "", body, ""].join("\n");
const batchLines = (planHash?: string) => [
  "batch:",
  "  id: lote-ex9700",
  "  lead: story-ex9701",
  "  sessionId: sess-ex9700",
  "  at: '2026-10-07T00:00:00.000Z'",
  ...(planHash ? [`  planHash: ${planHash}`] : []),
];

describePosix("o train integra um LOTE (real git) — fase 7: a marca do lote sobrevive nos três cards", () => {
  let tmpRoot: string;
  let repo: string;
  let baseBranch: string;
  const g = (args: string) => exec(`git ${args}`, { cwd: repo });
  const write = async (rel: string, text: string) => {
    await fsp.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fsp.writeFile(path.join(repo, rel), text);
  };

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sm-batch-train-"));
    exec = isolatedGitExec(exec, tmpRoot);
    await ensureRunnerStateDir();
    repo = path.join(tmpRoot, "main");
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.copyFile(path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"), path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"));
    await write(".gitignore", "node_modules\n.worktrees/\n");
    await write("packages/app/catalogo.ts", "export const filtro = 1;\n");
    for (const id of IDS) await write(cardPath(id), cardText(id));
    await g(`init -q`);
    await g(`config user.email t@example.test`);
    await g(`config user.name tester`);
    await g(`add -A`);
    await g(`commit -q --no-verify -m base`);
    baseBranch = (await g(`rev-parse --abbrev-ref HEAD`)).stdout.trim();

    // O WORKTREE da sessão de lote: um commit por item (o trailer `Card:`), o código e os três cards com o carimbo.
    await g(`checkout -q -b agent/sess-ex9700`);
    await write("packages/app/catalogo.ts", "export const filtro = 2;\n");
    for (const id of IDS) await write(cardPath(id), cardText(id, ["qaPassed: true"], `corpo\n\n## Prova da entrega\n- ${id} conferido`));
    await g(`add -A`);
    await g(`commit -q --no-verify -m "lote: conserta a busca do catálogo" -m "Card: story-ex9701" -m "Card: story-ex9702" -m "Card: story-ex9703"`);
    await g(`checkout -q ${baseBranch}`);

    // MAIN depois do corte: o claim_batch carimbou a marca nos três (o flush commitou)…
    for (const id of IDS) await write(cardPath(id), cardText(id, batchLines()));
    await g(`add -A`);
    await g(`commit -q --no-verify -m "board: estado vivo"`);
    // …e o plano do lote foi congelado no disco do líder, ainda sem flush (a escrita viva de MCP)
    await write(cardPath("story-ex9701"), cardText("story-ex9701", batchLines("0123456789abcdef.a1b2c3d4")));
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(`${repo}-stage`)} --force`, { cwd: repo }).catch(() => {});
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("os três cards chegam a main com o carimbo do run E a marca do lote (com o plano congelado no líder)", async () => {
    const store = memStore();
    const mq = makeMergeQueue({
      readCardTransitions: async () => [],
      repoRoot: repo,
      exec,
      store,
      now: () => 1000,
      staging: { enabled: true, branch: "stage", codePrefixes: ["packages/"] },
      persistDiffSnapshot: async () => {},
      stampStaged: async () => {},
      addSecretScanBlocker: async () => {},
      addDataNotLandedBlocker: async () => {},
      addCodeNotLandedBlocker: async () => {},
      persistConflictedBranchFinding: async () => {},
      addGateBlocker: async () => {},
      clearRunBlockers: async () => {},
      isCardTerminal: async () => false,
      cleanTreeRecheck: { attempts: 1, delayMs: 0 },
      sleep: async () => {},
    });
    await mq.enqueueMerge({ runId: "sess-ex9700", board: "tb", cardId: "story-ex9701", branch: "agent/sess-ex9700" });
    await mq.whenIdle();
    const entry = store.read()[0];
    expect(entry?.status, entry?.failureReason ?? entry?.conflictDetail ?? "").toBe("done");
    expect(entry?.split).toEqual({ codeStaged: true, dataLanded: true });

    for (const id of IDS) {
      const text = await fsp.readFile(path.join(repo, cardPath(id)), "utf8");
      expect(text, id).toContain("qaPassed: true");
      expect(text, id).toContain("Prova da entrega");
      expect(text, id).toMatch(/batch:\n\s+id: lote-ex9700\n\s+lead: story-ex9701\n\s+sessionId: sess-ex9700/);
    }
    expect(await fsp.readFile(path.join(repo, cardPath("story-ex9701")), "utf8")).toContain("planHash: 0123456789abcdef.a1b2c3d4");
    // o código foi para stage, como em qualquer integração
    expect((await g(`show stage:packages/app/catalogo.ts`)).stdout).toContain("filtro = 2");
  });
});
