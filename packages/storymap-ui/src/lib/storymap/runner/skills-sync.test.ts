// sync_skills — copia para o alvo SÓ as skills que faltam, pelo worktree de sessão + merge train; RECUSA
// sobrescrever uma que difere sem que ela seja nomeada em `overwrite`; nunca escreve no checkout de runtime.

import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { overwriteRefusal, planSkillsSync, syncSkills, type SkillsSyncDeps } from "./skills-sync";
import { readSkillTrees, type SkillTree } from "@/lib/storymap/skills-drift";
import { findRepoRoot } from "@/lib/storymap/paths";

const tree = (name: string, body: string): SkillTree => ({ name, files: { "SKILL.md": body } });
const TOOL = [tree("harness-conductor", "v2"), tree("harness-qa", "v0.7"), tree("harness-grill", "g")];
const TARGET = [tree("harness-qa", "customizada"), tree("harness-grill", "g")];

describe("planSkillsSync", () => {
  it("FALTA ⇒ copia; DIFERE ⇒ fica (sem pedido); igual ⇒ nada", () => {
    const p = planSkillsSync(TOOL, TARGET);
    expect(p).toMatchObject({ copy: ["harness-conductor"], overwrite: [], keptDiffering: ["harness-qa"], ignoredOverwrite: [] });
    expect(p.drift.same).toEqual(["harness-grill"]);
  });

  it("overwrite só vale para quem DIFERE; o resto é ignorado e DITO", () => {
    const p = planSkillsSync(TOOL, TARGET, ["harness-qa", "harness-grill", "harness-conductor", "harness-inventada", " "]);
    expect(p.overwrite).toEqual(["harness-qa"]);
    expect(p.keptDiffering).toEqual([]);
    expect(p.ignoredOverwrite.map((x) => x.name)).toEqual(["harness-grill", "harness-conductor", "harness-inventada"]);
  });
});

function fakes(over: Partial<SkillsSyncDeps> = {}) {
  const written: Array<{ from: string; to: string }> = [];
  const calls: string[] = [];
  const deps: SkillsSyncDeps = {
    toolRoot: "/tool",
    targetRoot: "/runtime",
    readTrees: (root) => (root === "/tool" ? TOOL : TARGET),
    openWorktree: vi.fn(async () => {
      calls.push("open");
      return { ok: true as const, sessionId: "s1", path: "/wt/s1" };
    }),
    exists: () => false,
    copyTree: vi.fn(async (from: string, to: string) => {
      written.push({ from, to });
    }),
    submit: vi.fn(async () => {
      calls.push("submit");
      return { ok: true as const, pinnedSha: "abcdef1234567" };
    }),
    discard: vi.fn(async () => {
      calls.push("discard");
    }),
    ...over,
  };
  return { deps, written, calls };
}

describe("syncSkills", () => {
  it("copia a que FALTA para o WORKTREE da sessão (nunca para o runtime) e submete ao train", async () => {
    const { deps, written, calls } = fakes();
    const r = await syncSkills(deps);
    expect(r).toMatchObject({ ok: true, submitted: true, sessionId: "s1", copied: ["harness-conductor"], overwritten: [] });
    expect(written).toEqual([
      { from: path.join("/tool", ".claude", "skills", "harness-conductor"), to: path.join("/wt/s1", ".claude", "skills", "harness-conductor") },
    ]);
    expect(written.every((w) => !w.to.startsWith("/runtime"))).toBe(true);
    expect(calls).toEqual(["open", "submit"]);
    expect(vi.mocked(deps.submit).mock.calls[0][1]).toMatch(/faltavam: harness-conductor/);
    expect(r.ok && r.submitted && r.next).toMatch(/wait_for_submit.*worktree_discard/);
  });

  it("RECUSA sobrescrever a que difere sem pedido: a qa customizada nunca é tocada", async () => {
    const { deps, written } = fakes();
    await syncSkills(deps);
    expect(written.some((w) => w.to.includes("harness-qa"))).toBe(false);
  });

  it("com overwrite nomeando-a, sobrescreve — e só ela", async () => {
    const { deps, written } = fakes();
    const r = await syncSkills(deps, { overwrite: ["harness-qa"] });
    expect(r).toMatchObject({ ok: true, submitted: true, copied: ["harness-conductor"], overwritten: ["harness-qa"] });
    expect(written.map((w) => path.basename(w.to))).toEqual(["harness-conductor", "harness-qa"]);
  });

  it("tudo igual (e nada pedido) ⇒ nenhum worktree é aberto", async () => {
    const { deps, calls } = fakes({ readTrees: () => TOOL });
    expect(await syncSkills(deps)).toMatchObject({ ok: true, submitted: false });
    expect(calls).toEqual([]);
  });

  it("dryRun ⇒ só o plano, nada aberto nem escrito", async () => {
    const { deps, calls, written } = fakes();
    const r = await syncSkills(deps, { dryRun: true });
    expect(r).toMatchObject({ ok: true, submitted: false, plan: { copy: ["harness-conductor"], keptDiffering: ["harness-qa"] } });
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it("a skill já existe na BASE de integração (runtime atrasado) ⇒ não copia por cima, descarta o worktree vazio", async () => {
    const { deps, calls, written } = fakes({ exists: (p) => p.endsWith("harness-conductor") });
    const r = await syncSkills(deps);
    expect(r).toMatchObject({ ok: true, submitted: false });
    expect(written).toEqual([]);
    expect(calls).toEqual(["open", "discard"]);
  });

  it("submissão recusada ⇒ o worktree é descartado e o erro volta com o plano", async () => {
    const { deps, calls } = fakes({ submit: async () => ({ ok: false as const, reason: "cap de sessões" }) });
    const r = await syncSkills(deps);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/cap de sessões/) });
    expect(calls).toEqual(["open", "discard"]);
  });

  it("worktree recusado (cap/VPS) ⇒ erro, nada escrito", async () => {
    const { deps, written } = fakes({ openWorktree: async () => ({ ok: false as const, reason: "máquina saturada" }) });
    expect(await syncSkills(deps)).toMatchObject({ ok: false, reason: expect.stringMatching(/máquina saturada/) });
    expect(written).toEqual([]);
  });
});

describe("overwrite é do operador — um token escopado só traz as que faltam", () => {
  it("escopado + overwrite ⇒ recusa, e nada é aberto nem escrito", async () => {
    const { deps, calls, written } = fakes();
    const r = await syncSkills(deps, { overwrite: ["harness-qa"], scoped: true });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/token full/) });
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it("escopado SEM overwrite ⇒ copia as que faltam normalmente", async () => {
    const { deps } = fakes();
    expect(await syncSkills(deps, { scoped: true })).toMatchObject({ ok: true, submitted: true, copied: ["harness-conductor"] });
  });

  it("overwriteRefusal: operador (não escopado) pode; lista vazia/em branco não conta como pedido", () => {
    expect(overwriteRefusal(["harness-qa"], false)).toBeNull();
    expect(overwriteRefusal([" "], true)).toBeNull();
    expect(overwriteRefusal(undefined, true)).toBeNull();
    expect(overwriteRefusal(["harness-qa"], true)).toMatch(/operador/);
  });
});

// A skill do condutor virou NÚCLEO + ref/ (o detalhe de cada bloco num arquivo que o núcleo manda ler). O sync leva a
// skill como ÁRVORE — se levasse só o SKILL.md, o alvo ficaria com um núcleo que manda ler arquivos que não existem nele.
describe("a skill dividida viaja inteira (núcleo + ref/)", () => {
  const real = readSkillTrees(findRepoRoot()).find((t) => t.name === "harness-conductor");

  it("a árvore da ferramenta carrega os ref/ do condutor ao lado do SKILL.md", () => {
    expect(real).toBeDefined();
    const files = Object.keys(real!.files);
    expect(files).toContain("SKILL.md");
    for (const f of ["ref/pre-voo-moldar.md", "ref/construir.md", "ref/verificar.md", "ref/publicar.md"]) expect(files).toContain(f);
  });

  it("um alvo com o condutor ANTIGO (só o SKILL.md) DIFERE — trocar exige o pedido do operador, e a cópia leva o diretório", async () => {
    const antigo: SkillTree = { name: "harness-conductor", files: { "SKILL.md": "monolito antigo" } };
    const p = planSkillsSync([real!], [antigo]);
    expect(p.copy).toEqual([]);
    expect(p.keptDiffering).toEqual(["harness-conductor"]);
    const { deps, written } = fakes({ readTrees: (root) => (root === "/tool" ? [real!] : [antigo]) });
    const r = await syncSkills(deps, { overwrite: ["harness-conductor"] });
    expect(r).toMatchObject({ ok: true, submitted: true, overwritten: ["harness-conductor"] });
    // copyTree recebe o DIRETÓRIO da skill (núcleo e ref/ juntos), nunca o arquivo
    expect(written).toEqual([{ from: path.join("/tool", ".claude", "skills", "harness-conductor"), to: path.join("/wt/s1", ".claude", "skills", "harness-conductor") }]);
  });
});
