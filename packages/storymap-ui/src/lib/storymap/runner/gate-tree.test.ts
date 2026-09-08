import { describe, expect, it } from "vitest";
import { prepareGateTree, type GateTreeDeps, type GateTreeOpts } from "./gate-tree";

const OPTS: GateTreeOpts = {
  repoRoot: "/repo",
  treePath: "/repo/.worktrees/gate-r1",
  treeBranch: "gate/r1",
  baseline: "stage",
  deltaBase: "base0",
  deltaHead: "pinned1",
  patchFile: "/repo/storymap/.runner/gate-r1.patch",
};

/** exec falso: casa por substring de comando, na ordem de inserção; o default é sucesso vazio. */
function makeDeps(
  behaviour: Array<{ match: string; stdout?: string; stderr?: string; fail?: boolean }>,
  extra: Partial<GateTreeDeps> = {},
): { deps: GateTreeDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: GateTreeDeps = {
    exec: async (cmd: string) => {
      calls.push(cmd);
      const rule = behaviour.find((b) => cmd.includes(b.match));
      if (rule?.fail) {
        const err = Object.assign(new Error("boom"), { stdout: rule.stdout ?? "", stderr: rule.stderr ?? "" });
        throw err;
      }
      return { stdout: rule?.stdout ?? "", stderr: rule?.stderr ?? "" };
    },
    fs: {} as GateTreeDeps["fs"],
    provisionNodeModules: async () => {},
    regenerateSnapshots: async () => ({ status: "noop" }),
    join: (...p) => p.join("/"),
    readFile: async () => "",
    ...extra,
  };
  return { deps, calls };
}

describe("prepareGateTree — a árvore do gate é a que a aterrissagem vai produzir", () => {
  it("corta a árvore da BASELINE (stage), não do HEAD do repo — a mudança que fecha a régua duplicada", async () => {
    const { deps, calls } = makeDeps([
      { match: "rev-parse HEAD", stdout: "stageSha\n" },
      { match: "diff --name-only", stdout: "packages/app/a.ts\n" },
    ]);
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: true, baseSha: "stageSha" });
    expect(calls.some((c) => c.includes('worktree add') && c.includes('"stage"'))).toBe(true);
  });

  it("aplica o MESMO patch que o split (diff base..pinned + apply --index --3way)", async () => {
    const { deps, calls } = makeDeps([
      { match: "rev-parse HEAD", stdout: "stageSha" },
      { match: "diff --name-only", stdout: "packages/app/a.ts" },
    ]);
    await prepareGateTree(deps, OPTS);
    expect(calls.some((c) => c.includes('diff --binary --no-renames "base0".."pinned1"'))).toBe(true);
    expect(calls.some((c) => c.includes("apply --index --3way"))).toBe(true);
  });

  it("`--no-renames` no diff de nomes — sem isso um `git mv` deixa o arquivo velho vivo", async () => {
    const { deps, calls } = makeDeps([
      { match: "rev-parse HEAD", stdout: "s" },
      { match: "diff --name-only", stdout: "a.ts" },
    ]);
    await prepareGateTree(deps, OPTS);
    expect(calls.some((c) => c.includes("diff --name-only --no-renames"))).toBe(true);
  });

  it("patch que NÃO aplica ⇒ `conflict` COM artefato, e a suíte nunca roda", async () => {
    const { deps } = makeDeps(
      [
        { match: "rev-parse HEAD", stdout: "s" },
        { match: "diff --name-only", stdout: "packages/app/a.ts" },
        { match: "apply --index --3way", fail: true, stderr: "error: patch failed: packages/app/a.ts:12" },
        { match: "--diff-filter=U", stdout: "packages/app/a.ts" },
      ],
      { readFile: async () => "ctx\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n" },
    );
    const res = await prepareGateTree(deps, OPTS);
    if (res.ok || res.kind !== "conflict") throw new Error(`esperava conflict, veio ${JSON.stringify(res)}`);
    expect(res.conflict.files).toEqual(["packages/app/a.ts"]);
    expect(res.conflict.hunks).toHaveLength(1);
    expect(res.log).toContain("mesmo apply que a aterrissagem faz");
  });

  it("falha de INFRA é `setup` (inconclusivo), NUNCA `conflict` — não se acusa o submitter por worktree add", async () => {
    const { deps } = makeDeps([{ match: "worktree add", fail: true, stderr: "fatal: já existe" }]);
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: false, kind: "setup" });
  });

  it("node_modules que não provisiona é `setup`, não reprovação de código", async () => {
    const { deps } = makeDeps([{ match: "rev-parse HEAD", stdout: "s" }], {
      provisionNodeModules: async () => {
        throw new Error("link falhou");
      },
    });
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: false, kind: "setup" });
  });

  it("delta VAZIO é um resultado legítimo, não um erro nem um 'passou' fabricado", async () => {
    const { deps, calls } = makeDeps([
      { match: "rev-parse HEAD", stdout: "s" },
      { match: "diff --name-only", stdout: "" },
    ]);
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: true, snapRegenerated: false });
    expect(calls.some((c) => c.includes("apply --index"))).toBe(false);
  });

  it("snapshots saem do patch e voltam por REGENERAÇÃO (git nunca mescla binário)", async () => {
    let regenArgs: string[] = [];
    const { deps, calls } = makeDeps(
      [
        { match: "rev-parse HEAD", stdout: "s" },
        { match: "diff --name-only", stdout: "packages/app/a.ts\npackages/app/__snapshots__/x.snap" },
      ],
      {
        regenerateSnapshots: async (_tree, snaps) => {
          regenArgs = snaps;
          return { status: "regenerated" };
        },
      },
    );
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: true, snapRegenerated: true });
    expect(regenArgs).toEqual(["packages/app/__snapshots__/x.snap"]);
    // o .snap NÃO entra no pathspec do patch
    const patchCmd = calls.find((c) => c.includes("diff --binary")) ?? "";
    expect(patchCmd).toContain("packages/app/a.ts");
    expect(patchCmd).not.toContain(".snap");
  });

  it("run SÓ de snapshot não gera patch nenhum, e ainda assim prepara a árvore", async () => {
    const { deps, calls } = makeDeps(
      [
        { match: "rev-parse HEAD", stdout: "s" },
        { match: "diff --name-only", stdout: "packages/app/__snapshots__/x.snap" },
      ],
      { regenerateSnapshots: async () => ({ status: "regenerated" }) },
    );
    const res = await prepareGateTree(deps, OPTS);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes("diff --binary"))).toBe(false);
  });

  it("`vitest -u` vermelho na regeneração é do DELTA (conflict), não infra — regen não maquia teste", async () => {
    const { deps } = makeDeps(
      [
        { match: "rev-parse HEAD", stdout: "s" },
        { match: "diff --name-only", stdout: "packages/app/__snapshots__/x.snap" },
      ],
      { regenerateSnapshots: async () => ({ status: "failed", detail: "2 testes falharam" }) },
    );
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: false, kind: "conflict" });
    if (res.ok) throw new Error("unreachable");
    expect(res.log).toContain("2 testes falharam");
  });

  it("commita o delta na árvore para o `--changed <baseSha>` e o reset da atribuição funcionarem", async () => {
    const { deps, calls } = makeDeps([
      { match: "rev-parse HEAD", stdout: "stageSha" },
      { match: "diff --name-only", stdout: "a.ts" },
    ]);
    const res = await prepareGateTree(deps, OPTS);
    expect(res).toMatchObject({ ok: true, baseSha: "stageSha" });
    expect(calls.some((c) => c.includes("commit --no-verify --allow-empty"))).toBe(true);
  });
});
