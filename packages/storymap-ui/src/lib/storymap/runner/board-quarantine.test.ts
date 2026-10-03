import { exec as nodeExec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";
import { isolatedGitExec } from "./git-test-env";
import { describePosix } from "./test-platform";
import { commitWithQuarantine, quarantinedOwnCard, secretScanSuspects } from "./board-quarantine";
import { commitBoardDataScoped, makeWorktreeOps, type ExecFn } from "./worktree";

// WP5-F1 — A QUARENTENA mora no PONTO ÚNICO dos commits de board-data (commitBoardDataScoped), não só no flush. Num caso real
// o scan recusou dezenas de vezes um trecho de UM card (um identificador longo em crase que o agente escreveu no corpo). O flush
// passou a isolá-lo, mas o card continuava sujo no disco, e TODO commit de fronteira o stageava de novo e falhava inteiro:
// o do engine antes de cortar o worktree de um run de código (nenhum run nascia), o settle de um run de board-data e o do
// train antes do merge-back. Aqui o scanner é o DE VERDADE do repositório, num git real.
const BAD = "storymap/boards/b/cards/story-bad.md";
const GOOD = "storymap/boards/b/cards/story-good.md";
const NOVO = "storymap/boards/b/cards/story-novo.md";

const scanRefusal = (...paths: string[]) =>
  `secret-scan bloqueou o board commit (cwd /r): Command failed: node scan-secrets.mjs --staged\n🔒 secret scan BLOCKED the commit:\n\n` +
  paths.map((p, i) => `  ✗ [naked-high-entropy-token] ${p}:${43 + i} → abcd…wxyz`).join("\n");

describe("secretScanSuspects — quem o scanner nomeou entre os arquivos staged", () => {
  it("nomeia só o caminho staged citado pelo scanner, com as linhas dele", () => {
    const out = secretScanSuspects(scanRefusal(BAD), [GOOD, BAD, NOVO]);
    expect(out).toEqual([{ path: BAD, detail: `✗ [naked-high-entropy-token] ${BAD}:43 → abcd…wxyz` }]);
  });
  it("casa o caminho INTEIRO: `x.md` não é suspeito por aparecer dentro de `x.md.bak`", () => {
    expect(secretScanSuspects(`  ✗ [r] storymap/boards/b/cards/x.md.bak:1 → …`, ["storymap/boards/b/cards/x.md"])).toEqual([]);
  });
  it("scanner que não nomeia arquivo do board (erro interno) ⇒ nenhum suspeito (o flush segue fail-closed)", () => {
    expect(secretScanSuspects("[scan-secrets] INTERNAL_ERROR could not scan diff: maxBuffer", [BAD, GOOD])).toEqual([]);
  });
});

describe("commitWithQuarantine — um arquivo recusado não trava o commit dos demais", () => {
  it("isola o que o scanner nomeou e refaz o commit sem ele", async () => {
    const excludes: string[][] = [];
    const res = await commitWithQuarantine({
      commit: async (exclude) => {
        excludes.push([...exclude]);
        if (!exclude.includes(BAD)) throw new Error(scanRefusal(BAD));
        return { committed: true };
      },
      stagedPaths: async () => [GOOD, BAD],
    });
    expect(excludes).toEqual([[], [BAD]]);
    expect(res.result).toEqual({ committed: true });
    expect(res.quarantined.map((q) => q.path)).toEqual([BAD]);
  });

  it("falha que não é recusa do scan é relançada intacta (nada de quarentena)", async () => {
    const boom = new Error("board-data commit ABORTADO: o diff staged toca código");
    await expect(commitWithQuarantine({ commit: async () => { throw boom; }, stagedPaths: async () => [BAD] })).rejects.toBe(boom);
  });

  it("recusa que não nomeia nenhum arquivo staged é relançada (o scan nunca é contornado)", async () => {
    const err = new Error("secret-scan bloqueou o board commit: [scan-secrets] INTERNAL_ERROR");
    await expect(commitWithQuarantine({ commit: async () => { throw err; }, stagedPaths: async () => [BAD, GOOD] })).rejects.toBe(err);
  });

  it("recusa que insiste no MESMO arquivo depois de isolado é relançada (sem laço)", async () => {
    let calls = 0;
    await expect(
      commitWithQuarantine({
        commit: async () => {
          calls++;
          throw new Error(scanRefusal(BAD));
        },
        stagedPaths: async () => [BAD],
      }),
    ).rejects.toThrow(/secret-scan bloqueou/);
    expect(calls).toBe(2);
  });
});

describe("quarantinedOwnCard — só o run do PRÓPRIO card em quarentena não nasce", () => {
  const q = [{ path: BAD, detail: "x" }];
  it("o card do run está entre os isolados ⇒ devolve a entrada", () => {
    expect(quarantinedOwnCard(q, "b", "story-bad")).toEqual({ path: BAD, detail: "x" });
  });
  it("outro card, outro board ou nada isolado ⇒ undefined (o run nasce)", () => {
    expect(quarantinedOwnCard(q, "b", "story-good")).toBeUndefined();
    expect(quarantinedOwnCard(q, "c", "story-bad")).toBeUndefined();
    expect(quarantinedOwnCard(undefined, "b", "story-bad")).toBeUndefined();
  });
});

/** Um token com a forma que o scanner recusa (≥32, maiúscula+minúscula+dígito, alta entropia), gerado na hora. */
function credentialShapedToken(): string {
  for (;;) {
    const t = randomBytes(30).toString("base64url").slice(0, 40);
    if (/[a-z]/.test(t) && /[A-Z]/.test(t) && /[0-9]/.test(t)) return t;
  }
}

describePosix("quarentena em git real — todo commit de board-data isola o card recusado e versiona o resto", () => {
  let tmpRoot: string;
  let repo: string;
  let exec: ExecFn;
  let badText: string;
  const g = async (args: string) => (await exec(`git ${args}`, { cwd: repo, timeout: 30_000 })).stdout;
  const committedFiles = async () => (await g(`show --name-only --format= HEAD`)).split("\n").filter(Boolean).sort();

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "board-quarantine-"));
    exec = isolatedGitExec(promisify(nodeExec) as unknown as ExecFn, tmpRoot);
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(path.join(repo, "scripts", "git-hooks"), { recursive: true });
    await fsp.mkdir(path.join(repo, "storymap", "boards", "b", "cards"), { recursive: true });
    await fsp.copyFile(path.join(findRepoRoot(), "scripts", "git-hooks", "scan-secrets.mjs"), path.join(repo, "scripts", "git-hooks", "scan-secrets.mjs"));
    await fsp.writeFile(path.join(repo, GOOD), "---\nid: story-good\nstatus: a\n---\n");
    await fsp.writeFile(path.join(repo, BAD), "---\nid: story-bad\nstatus: a\n---\n");
    await g(`init -q`);
    await g(`config user.email t@example.test`);
    await g(`config user.name tester`);
    await g(`add -A`);
    await g(`commit -q --no-verify -m base`);
    // o estado do caso real: o card recusado SUJO no disco; outro card mudou e um card NOVO apareceu
    badText = `---\nid: story-bad\nstatus: b\n---\n\n\`${credentialShapedToken()}\`\n`;
    await fsp.writeFile(path.join(repo, BAD), badText);
    await fsp.writeFile(path.join(repo, GOOD), "---\nid: story-good\nstatus: b\n---\n");
    await fsp.writeFile(path.join(repo, NOVO), "---\nid: story-novo\nstatus: triagem\n---\n");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  const expectQuarantined = async (res: { committed: boolean; quarantined?: ReadonlyArray<{ path: string }> }) => {
    expect(res.committed).toBe(true);
    expect((res.quarantined ?? []).map((q) => q.path)).toEqual([BAD]);
    expect(await committedFiles()).toEqual([GOOD, NOVO].sort());
    // o card recusado NÃO se perdeu nem foi versionado: está no disco, modificado, fora do índice
    expect(await fsp.readFile(path.join(repo, BAD), "utf8")).toBe(badText);
    expect((await g(`status --porcelain -- ${BAD}`)).trim()).toBe(`M ${BAD}`);
  };

  it("boundary-2 do train (commitBoardDataScoped direto): commita o resto, o recusado fica no disco", async () => {
    await expectQuarantined(await commitBoardDataScoped(exec, repo, "board: estado vivo antes do merge-back", ["packages/"]));
  });

  it("boundary-1 do engine e settle de board-data (WorktreeOps.commitBoardState): commita o resto", async () => {
    await expectQuarantined(await makeWorktreeOps(exec).commitBoardState(repo, "board: estado vivo (b/story-good)"));
  });

  it("o card recusado já STAGED por uma tentativa anterior (o índice que o scan recusou) também sai do commit", async () => {
    await g(`add -- storymap/boards/`);
    await expectQuarantined(await commitBoardDataScoped(exec, repo, "board: x", ["packages/"]));
  });

  it("depois que o valor sai do card, o próximo commit de fronteira o versiona (o scan nunca foi afrouxado)", async () => {
    await commitBoardDataScoped(exec, repo, "board: 1", ["packages/"]);
    await fsp.writeFile(path.join(repo, BAD), "---\nid: story-bad\nstatus: b\n---\n\nidentificador reescrito sem forma de credencial\n");
    const res = await commitBoardDataScoped(exec, repo, "board: 2", ["packages/"]);
    expect(res).toEqual({ committed: true });
    expect(await committedFiles()).toEqual([BAD]);
  });

  it("só o card recusado e nada mais: board limpo + recusado ⇒ nada a commitar, recusado relatado", async () => {
    await g(`add -- ${GOOD} ${NOVO}`);
    await g(`commit -q --no-verify -m resto`);
    const res = await commitBoardDataScoped(exec, repo, "board: x", ["packages/"]);
    expect(res.committed).toBe(false);
    expect((res.quarantined ?? []).map((q) => q.path)).toEqual([BAD]);
  });
});
