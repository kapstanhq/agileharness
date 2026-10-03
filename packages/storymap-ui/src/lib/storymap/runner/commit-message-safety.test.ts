// A mensagem de commit do sweep é TEXTO LIVRE e NUNCA pode passar por interpolação de shell.
//
// A mensagem do sweep-commit do merge-back carrega o finalText do agente no trailer `Decision:` —
// markdown arbitrário. `commitAllPending` a interpolava em `git commit -m "<msg>"` via /bin/sh, e
// aspas duplas NÃO neutralizam `` ` ``/`$(…)`/`\`:
//   - backticks BALANCEADOS: o sh EXECUTAVA o conteúdo como comando (injeção silenciosa — os
//     code-spans do texto sumiam da mensagem integrada);
//   - backtick ÍMPAR (a truncagem de 140 chars do summarizeFinalText corta no meio de um
//     code-span): "Syntax error: EOF in backquote substitution" → o commit lança → o catch
//     do engine force-removia o worktree com o trabalho não-commitado dentro e o run
//     assentava "ok" (um sucesso-fantasma).
//
// Estes testes cravam o contrato: a mensagem chega ao git BYTE-EXATA, qualquer que seja o
// conteúdo (git real, repo temporário isolado — mesmo harness de split-integration).

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRepoRoot } from "@/lib/storymap/paths";
import { buildRunCommitMessage, summarizeFinalText } from "./engine";
import { isolatedGitExec } from "./git-test-env";
import { commitAllPending, defaultExec, type ExecFn } from "./worktree";

// Um finalText típico de agente: truncado em 140 chars pelo summarizeFinalText, o corte cai
// logo após o backtick de abertura de `hasQaPassed` — 5 backticks (ímpar) → o gatilho
// determinístico do "EOF in backquote substitution". O teste mede o TRUNCAMENTO em 140 caracteres:
// mudar o texto muda o ponto de corte e a paridade dos backticks (o sanity abaixo vigia isso).
const INCIDENT_FINAL_TEXT =
  "Pronto. A etapa terminou sem pendencias.\n\n## `/harness-qa acme/story-4` — Concluido\n\n" +
  "**Resultado:** `qa-automatizado → revisao` (gate `hasQaPassed` ok — suite verde, nenhum achado aberto)";

const CASES: Array<{ name: string; message: string }> = [
  {
    name: "backtick ímpar (truncagem no meio de um code-span — o gatilho do incidente)",
    message: buildRunCommitMessage("harness-review", "acme", "story-4", "run-x", {
      model: "opus",
      effort: "high",
      decision: INCIDENT_FINAL_TEXT,
    }),
  },
  {
    name: "backticks balanceados (a injeção SILENCIOSA — sh executava o conteúdo)",
    message: "usm(usm-qa): acme/story-1 [run r2]\n\nDecision: usei `git log` e `vitest run` para verificar\nRun-Id: r2",
  },
  {
    name: "substituição $(…)",
    message: "usm(usm-do): acme/story-2 [run r3]\n\nDecision: o card usa $(date) no template\nRun-Id: r3",
  },
  {
    name: "aspas duplas e barra invertida",
    message: 'usm(usm-do): acme/story-3 [run r4]\n\nDecision: o texto "entre aspas" e o path C:\\x quebravam o -m\nRun-Id: r4',
  },
];

describe("commitAllPending — mensagem de commit byte-exata, sem interpretação de shell", () => {
  let tmpRoot: string;
  let repo: string;
  let exec: ExecFn;
  // repoRoot REAL do monorepo: só localiza scripts/git-hooks/scan-secrets.mjs (o secret scan
  // roda com cwd = repo temporário, sobre o diff staged de lá).
  const repoRoot = findRepoRoot();

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "usm-commit-msg-safety-"));
    repo = path.join(tmpRoot, "repo");
    await fsp.mkdir(repo, { recursive: true });
    exec = isolatedGitExec(defaultExec, tmpRoot);
    await exec(`git init -q -b main`, { cwd: repo });
    await exec(`git config user.email test@test.local`, { cwd: repo });
    await exec(`git config user.name usm-test`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "seed.txt"), "seed\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q -m seed`, { cwd: repo });
  }, 30_000);

  afterAll(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  for (const [i, c] of CASES.entries()) {
    it(
      `preserva a mensagem com ${c.name}`,
      async () => {
        await fsp.writeFile(path.join(repo, "work.txt"), `work-${i}\n`);
        const { committed } = await commitAllPending(exec, repo, repoRoot, c.message);
        expect(committed).toBe(true);
        // Byte-exata: nada foi executado, engolido ou re-quotado pelo shell. (%B emite a
        // mensagem crua; git normaliza apenas o(s) \n finais.)
        const { stdout } = await exec(`git log -1 --format=%B`, { cwd: repo });
        expect(stdout.replace(/\n+$/, "")).toBe(c.message.replace(/\n+$/, ""));
        // E a árvore ficou limpa (o sweep de fato commitou o trabalho).
        const status = await exec(`git status --porcelain`, { cwd: repo });
        expect(status.stdout.trim()).toBe("");
      },
      30_000,
    );
  }

  it("sanity: o Decision truncado do caso 1 tem backticks em número ímpar", () => {
    // Documenta POR QUE o caso 1 é o gatilho: se summarizeFinalText mudar a truncagem e este
    // sanity quebrar, o caso 1 continua válido (byte-exatidão), só perde o realismo forense.
    const decision = summarizeFinalText(INCIDENT_FINAL_TEXT, 140);
    const backticks = (decision?.match(/`/g) ?? []).length;
    expect(backticks % 2).toBe(1);
  });
});
