// As skills que a ferramenta distribui × as do alvo — medido em árvores REAIS (tmp). FALTA / DIFERE / igual, a
// comparação por árvore (não só o SKILL.md), e o que não entra na conta (skills só do alvo, não-harness, links).

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureSkills, readSkillTrees, skillDrift } from "./skills-drift";
import { skillsCheck, runPreflight, preflightMessage } from "./preflight";

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true });
});

/** Um checkout com as skills dadas: nome → { arquivo relativo → conteúdo }. */
function checkout(skills: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ah-skills-"));
  tmp.push(root);
  for (const [name, files] of Object.entries(skills)) {
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(root, ".claude", "skills", name, rel);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, body);
    }
  }
  return root;
}

const TOOL = {
  "harness-conductor": { "SKILL.md": "condutor v2" },
  "harness-qa": { "SKILL.md": "qa v0.7", "refs/gates.md": "hasQaPassed exige suíte" },
  "harness-grill": { "SKILL.md": "grill" },
};

describe("skillDrift — FALTA / DIFERE / igual", () => {
  it("o caso medido no alvo de referência: o condutor FALTA, a qa DIFERE, o grill é igual", () => {
    const tool = readSkillTrees(checkout(TOOL));
    const target = readSkillTrees(
      checkout({
        "harness-qa": { "SKILL.md": "qa v0.6", "refs/gates.md": "hasQaPassed exige suíte" },
        "harness-grill": { "SKILL.md": "grill" },
      }),
    );
    expect(skillDrift(tool, target)).toEqual({
      missing: ["harness-conductor"],
      differ: [{ name: "harness-qa", files: ["SKILL.md"] }],
      same: ["harness-grill"],
    });
  });

  it("compara a ÁRVORE: um arquivo de apoio a mais ou diferente é diferença, mesmo com o SKILL.md igual", () => {
    const tool = readSkillTrees(checkout(TOOL));
    const target = readSkillTrees(checkout({ ...TOOL, "harness-qa": { "SKILL.md": "qa v0.7", "refs/gates.md": "outra coisa", "extra.md": "x" } }));
    expect(skillDrift(tool, target).differ).toEqual([{ name: "harness-qa", files: ["extra.md", "refs/gates.md"] }]);
  });

  it("skill só do alvo, skill que não é harness-*, e link simbólico não entram na conta", () => {
    const target = checkout({ ...TOOL, "harness-do-alvo": { "SKILL.md": "minha" }, "nook-eval": { "SKILL.md": "do produto" } });
    symlinkSync("/etc", path.join(target, ".claude", "skills", "harness-link"));
    const t = readSkillTrees(target);
    expect(t.map((x) => x.name)).toEqual(["harness-conductor", "harness-do-alvo", "harness-grill", "harness-qa"]);
    expect(skillDrift(readSkillTrees(checkout(TOOL)), t)).toMatchObject({ missing: [], differ: [] });
  });

  it("alvo sem .claude/skills ⇒ nenhuma skill (todas FALTAM); raiz ilegível ⇒ measureSkills diz null", () => {
    const empty = checkout({});
    expect(readSkillTrees(empty)).toEqual([]);
    expect(skillDrift(readSkillTrees(checkout(TOOL)), []).missing).toEqual(["harness-conductor", "harness-grill", "harness-qa"]);
    expect(measureSkills(null, empty)).toBeNull();
    const broken = { readdir: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }, read: () => Buffer.from("") };
    expect(measureSkills("/a", "/b", broken)).toBeNull();
  });
});

describe("preflight `skills.distributed`", () => {
  const probe = (target: Record<string, Record<string, string>>) => measureSkills(checkout(TOOL), checkout(target));

  it("FALTA ⇒ degraded, com a lista (e as que diferem junto) e o conserto sync_skills", () => {
    const c = skillsCheck(probe({ "harness-qa": { "SKILL.md": "velha" }, "harness-grill": { "SKILL.md": "grill" } }));
    expect(c.status).toBe("degraded");
    expect(c.observed).toContain("harness-conductor");
    expect(c.observed).toContain("harness-qa");
    expect(c.remedy).toMatch(/sync_skills/);
  });

  it("só DIFERE ⇒ aviso (warn) com a lista — e o conserto diz que nada é sobrescrito sozinho", () => {
    const c = skillsCheck(probe({ ...TOOL, "harness-qa": { "SKILL.md": "customizada", "refs/gates.md": "hasQaPassed exige suíte" } }));
    expect(c).toMatchObject({ status: "warn" });
    expect(c.observed).toContain("harness-qa (SKILL.md)");
    expect(c.remedy).toMatch(/overwrite/);
  });

  it("igual ⇒ ok; o alvo sendo o próprio checkout da ferramenta ⇒ ok; não medido ⇒ unknown", () => {
    expect(skillsCheck(probe(TOOL)).status).toBe("ok");
    const same = checkout(TOOL);
    expect(skillsCheck(measureSkills(same, same))).toMatchObject({ status: "ok", observed: expect.stringMatching(/É o checkout da ferramenta/) });
    expect(skillsCheck(null).status).toBe("unknown");
  });

  it("no relatório: a sonda AUSENTE não cria o check; um aviso aparece no bloco sem virar reprovação", () => {
    expect(runPreflight({ versions: { node: "22.0.0", bun: "1.3.0" } }).checks.some((c) => c.id === "skills.distributed")).toBe(false);
    const report = runPreflight({
      versions: { node: "22.0.0", bun: "1.3.0" },
      skills: probe({ ...TOOL, "harness-qa": { "SKILL.md": "customizada", "refs/gates.md": "hasQaPassed exige suíte" } }),
    });
    const c = report.checks.find((x) => x.id === "skills.distributed")!;
    expect(c.status).toBe("warn");
    const msg = preflightMessage({ checks: [c], worst: "warn" });
    expect(msg).toMatch(/1 aviso/);
    expect(msg).toContain("skills.distributed");
    expect(msg).not.toMatch(/NÃO passaram/);
  });
});
