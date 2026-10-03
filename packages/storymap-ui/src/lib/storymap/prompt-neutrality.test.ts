// GUARDA DE NEUTRALIDADE DOS PROMPTS — o que a ferramenta diz a um agente não supõe o ferramental de um repositório.
//
// POR QUE EXISTE: uma instrução como «commite com tal variável ligada» só faz sentido no repositório que tem aquele hook
// de pré-commit. Em qualquer outro ela é inócua na melhor hipótese e, na pior, ensina o agente a desligar uma trava. O
// prompt diz só «com `git commit`» e remete às instruções do próprio repositório; este teste é a CATRACA: nenhum prompt,
// skill de runtime ou texto de agente traz convenção de hook, receita de executor ou variável de bypass.
//
// O QUE ELE VARRE: o texto que vira instrução de agente — o copiloto (copilot/**, hitl/**), o proxy do dono, o
// classificador de perguntas, o juiz da triagem e a captura inteligente — em LINHAS DE CÓDIGO (comentário de
// desenvolvedor pode explicar a história).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_VOICE_CLAUSE, HITL_PURPOSES, resolveHitlPrompt } from "./hitl/purpose-registry";

const ROOT = join(process.cwd(), "src/lib/storymap");

/** As pastas/arquivos cujo texto vira instrução de agente. */
const PROMPT_SOURCES = ["copilot", "hitl", "triage", "smart-capture", "runner/proxy-spawn.ts", "question-classifier.ts"];

function walk(p: string, acc: string[] = []): string[] {
  const s = statSync(p);
  if (s.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e), acc);
  else if (/\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p)) acc.push(p);
  return acc;
}

const isCommentLine = (t: string) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");

/** A FORMA genérica de uma variável de bypass de hook: `SKIP_…`, `ALLOW_…`, `BYPASS_…`, `NO_…` (nenhum nome em particular). */
const BYPASS_VAR = /\b(?:SKIP|ALLOW|BYPASS|NO)_[A-Z][A-Z0-9_]{2,}\b/;

/** Padrões que NENHUM prompt pode ter: variável de ambiente colada a um comando git, receita de executor de um repo. */
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "variável de bypass de hook", re: BYPASS_VAR },
  { name: "VAR=1 antes de um comando git (convenção de hook de um repositório)", re: /\b[A-Z][A-Z0-9_]{3,}=1 git\b/ },
  { name: "receita de executor `just <receita>` (o executor é do alvo — target.checks)", re: /`just [a-z][\w-]*/ },
  { name: "`--no-verify` (pular hook é decisão do humano, nunca do prompt)", re: /--no-verify/ },
];

describe("prompt-neutrality — nenhum prompt traz convenção de hook ou executor de um repositório", () => {
  const files = PROMPT_SOURCES.flatMap((s) => walk(join(ROOT, s)));

  it("a varredura enxerga os prompts (pastas existem e têm arquivos)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("hitl/purpose-registry.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("runner/proxy-spawn.ts"))).toBe(true);
  });

  it("zero ocorrências proibidas em linhas de código dos arquivos que viram instrução de agente", () => {
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((ln, i) => {
          const t = ln.trim();
          if (isCommentLine(t)) return;
          for (const rule of FORBIDDEN) if (rule.re.test(ln)) offenders.push(`${f.replace(ROOT, "")}:${i + 1} [${rule.name}] → ${t.slice(0, 90)}`);
        });
    }
    expect(offenders, "Um prompt não pode supor o hook nem o executor de um repositório: remeta ao CLAUDE.md/AGENTS.md do alvo ou a `target_profile`.").toEqual([]);
  });

  it("o texto RENDERIZADO de cada propósito do copiloto também passa (inclui o que é montado em tempo de execução)", () => {
    expect(HITL_PURPOSES.length).toBeGreaterThan(0);
    for (const purpose of HITL_PURPOSES) {
      const rendered = resolveHitlPrompt(purpose);
      for (const rule of FORBIDDEN) expect(rendered, `${purpose.id}: ${rule.name}`).not.toMatch(rule.re);
    }
    for (const rule of FORBIDDEN) expect(AGENT_VOICE_CLAUSE, rule.name).not.toMatch(rule.re);
  });

  it("o prompt do copiloto manda commitar com `git commit` e remete às regras do repositório (não a uma variável)", () => {
    const base = HITL_PURPOSES.map((p) => resolveHitlPrompt(p)).find((t) => /git commit/.test(t));
    expect(base, "algum propósito do copiloto cita o commit").toBeTruthy();
    expect(base).toMatch(/instruções do repositório/);
  });

  it("a guarda PEGA o defeito: um texto de prompt com variável de bypass antes do git commit é recusado", () => {
    for (const ruim of ["faça SKIP_LINT_CHECK=1 git commit -m wip", "rode com BYPASS_HOOKS ligado", "QUIET_MODE=1 git commit"]) {
      expect(FORBIDDEN.some((r) => r.re.test(ruim)), ruim).toBe(true);
    }
    expect(FORBIDDEN.some((r) => r.re.test("faça o commit com `git commit`"))).toBe(false);
  });
});
