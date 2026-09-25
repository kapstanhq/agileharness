// O CARIMBO DE QA do condutor — pelo MESMO caminho honesto da harness-qa, e nunca pelo approve_qa (a saída do
// OPERADOR). Achado do piloto real (v0.8.2, uma coleta de lixo trivial): o condutor fez MOLDAR → CONSTRUIR → train
// e, na projeção, chamou approve_qa — que desde o gate honesto (v0.7.0) é a saída HUMANA —, então o card parou no
// QA pedindo o dono. QA não é um dos pontos humanos do plano (entrevista, interface, dinheiro, prova da entrega).
//
// Duas metades, as duas presas aqui:
//   • o MECANISMO existe: o condutor grava qaPassed/qaRanAt/qaCommit/qaEvidence no card do PRÓPRIO worktree, e o
//     merge 3-way do train leva esses campos à main mesmo quando a main mexeu no card no meio do caminho (as
//     escritas MCP do condutor: tasks, status) — e o gate hasQaPassed passa na main por causa deles;
//   • a SKILL manda fazer isso, com as regras de honestidade de cada flag, e diz que approve_qa é do operador.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MERGE_BACK_PIPELINE_FIELDS, mergeCardThreeWay } from "./card-merge";
import { checkGate } from "./gates";
import { coerceCard } from "./repo";
import { findRepoRoot } from "./paths";
import type { BoardConfig, Card } from "./types";

const STAMP_FIELDS = ["qaPassed", "qaRanAt", "qaCommit", "qaEvidence"] as const;

const config: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: true },
    { id: "qa-automatizado", name: "QA", trigger: "harness-qa", autorun: true },
    { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

describe("o mecanismo: o carimbo no worktree chega à main pelo train", () => {
  // o card no instante em que o worktree foi cortado
  const base = coerceCard("story-gc", { type: "story", storyType: "chore", status: "pronta", title: "GC de cards" }, "");
  // a MAIN andou por MCP enquanto o condutor trabalhava: tasks gravadas, card movido para desenvolver
  const main: Card = { ...base, status: "desenvolver", tasks: [{ id: "t1", title: "coletar", done: true }] };
  // o card do WORKTREE: o carimbo de QA e as evidências de review, sem ter visto o que a main fez
  const run: Card = {
    ...base,
    commitRange: { base: "aaaa111", head: "bbbb222" },
    reviewedAt: "2026-09-25",
    reviewCommit: "bbbb222",
    qaPassed: true,
    qaRanAt: "2026-09-25",
    qaCommit: "bbbb222",
    qaEvidence: { suite: true, visual: false, at: "2026-09-25T06:00:00.000Z", by: "harness-conductor" },
  };

  it("os quatro campos do carimbo são do PIPELINE no merge de volta (o lado do run vence)", () => {
    for (const f of STAMP_FIELDS) expect(MERGE_BACK_PIPELINE_FIELDS as readonly string[]).toContain(f);
  });

  it("o card mesclado tem o carimbo do worktree E o que a main fez (status, tasks) — e passa o hasQaPassed", () => {
    const merged = mergeCardThreeWay(base, main, run);
    expect(merged).toMatchObject({ status: "desenvolver", qaPassed: true, qaCommit: "bbbb222", qaEvidence: { suite: true, by: "harness-conductor" } });
    expect(merged.tasks).toEqual(main.tasks);
    expect(checkGate(merged, "revisao", config)).toBeNull();
  });

  it("o gate honesto segue honesto: card com código e só o bit qaPassed (sem evidência de suíte/tela) NÃO passa", () => {
    const { qaEvidence: _e, ...semEvidencia } = run;
    const merged = mergeCardThreeWay(base, main, semEvidencia as Card);
    expect(checkGate(merged, "revisao", config)).not.toBeNull();
    const falso = mergeCardThreeWay(base, main, { ...run, qaEvidence: { suite: false, visual: false, at: "2026-09-25T06:00:00.000Z" } });
    expect(checkGate(falso, "revisao", config)).not.toBeNull();
  });
});

describe("a skill: o condutor carimba no worktree, com honestidade, e nunca chama approve_qa", () => {
  const skill = readFileSync(path.join(findRepoRoot(), ".claude", "skills", "harness-conductor", "SKILL.md"), "utf8");

  it("nenhuma instrução chama approve_qa (a tool aparece só como a saída do OPERADOR)", () => {
    expect(skill).not.toMatch(/approve_qa\(\{/);
    expect(skill).toMatch(/`approve_qa` \| the OPERATOR's exit[^\n]*never call it/);
    expect(skill).toMatch(/Never call `approve_qa`/);
  });

  it("o PUBLICAR grava os quatro campos no card do worktree, com a regra de cada flag", () => {
    const publicar = skill.slice(skill.indexOf("## 4 · PUBLICAR"), skill.indexOf("## Pauses"));
    for (const f of STAMP_FIELDS) expect(publicar, f).toContain(`\`${f}`);
    expect(publicar).toMatch(/`suite: true` ONLY if YOU ran the package suite[\s\S]*IN YOUR WORKTREE[\s\S]*count of tests executed \(> 0\)/);
    expect(publicar).toMatch(/`visual: true` ONLY if the clean-context verifier swept/);
    expect(publicar).toMatch(/SAME honest path `harness-qa` uses/);
  });
});
