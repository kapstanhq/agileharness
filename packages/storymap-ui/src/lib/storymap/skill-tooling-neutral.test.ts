import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import { KNOWN_CHECKS, KNOWN_DEV, KNOWN_DOCS } from "@/lib/storymap/target-profile";

// UMA SKILL NÃO PRESCREVE O FERRAMENTAL DE UM REPOSITÓRIO (lote D).
//
// A ferramenta nasceu dentro do monorepo de um produto, e as skills diziam ao agente COMO aquele repositório
// trabalha: qual executor chamar, em que arquivo ler as regras de teste, em que moeda está o teto. Num outro
// repositório a instrução manda rodar um comando que não existe — e o agente é headless: a falha não aparece como erro,
// aparece como card parado. O alvo DECLARA o que é dele (storymap/settings.yaml → target.checks / docs / dev /
// currency / reviewLenses) e a skill remete ao NOME («o check `test` do `target_profile`»), com a frase «descubra o
// comando nas instruções do repositório» quando o alvo não declarou.
//
// Este teste é a CATRACA, e o teto é ZERO: nenhuma skill, comando, texto de assistente ou linha de código do
// `_base/board.yaml` volta a trazer receita de executor, pasta de regras, ADR ou moeda do repositório de origem. Ele
// substitui a tabela de «dívida declarada» que skill-commands-travel.test.ts carregava (13/3/1 receitas): ao zerar, a
// tabela saiu, e esta régua passou a medir o vocabulário inteiro, não só o `just`.
//
// EXTRAÇÃO CONSERVADORA, de propósito: as skills são escritas em inglês, onde «just» é advérbio comum («just add»,
// «just the card»). Casar a palavra solta encheria isto de falso positivo e o guarda seria afrouxado no primeiro susto.
// Então o `just` só conta nas duas notações canônicas de comando: linha dentro de bloco cercado (```) e trecho em crase.

const ROOT = findRepoRoot();
const CLAUDE = path.join(ROOT, ".claude");
const BASE_BOARD = path.join(ROOT, "storymap", "boards", "_base", "board.yaml");

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walkMarkdown(p, acc);
    else if (e.endsWith(".md")) acc.push(p);
  }
  return acc;
}

/** Tudo que vira instrução de agente: skills (e os arquivos auxiliares delas), comandos e textos de assistente. */
function textSources(): string[] {
  return [
    ...walkMarkdown(path.join(CLAUDE, "skills")),
    ...walkMarkdown(path.join(CLAUDE, "commands")),
    ...walkMarkdown(path.join(CLAUDE, "storymap-assistants")),
  ];
}

/** O `_base/board.yaml` em LINHAS DE CÓDIGO: o comentário de um desenvolvedor pode explicar a história e dar exemplo. */
function baseBoardCodeLines(): string[] {
  return readFileSync(BASE_BOARD, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"));
}

/** As invocações de `just <receita>` nas duas notações canônicas (bloco cercado e crase). */
function justInvocations(md: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      const t = line.trim().replace(/^\$\s+/, "").replace(/^>\s*/, "");
      if (/^just\s+[a-z]/.test(t)) found.push(t);
      continue;
    }
    for (const m of line.matchAll(/`just\s+([a-z][\w-]*)/g)) found.push(`just ${m[1]}`);
  }
  return found;
}

/**
 * `bun run (test|dev|build)` é o script do projeto de QUEM escreveu a skill. Nestas skills ele fala da PRÓPRIA ferramenta
 * (o AgileHarness), não do alvo, e por isso é a única exceção declarada: harness-qa (a seção dogfood roda o storymap-ui do
 * worktree), harness-orchestrator (o serviço da ferramenta, que não se mata) e harness-setup (instalar a ferramenta).
 */
const BUN_RUN_SELF_TOOL = new Set(["harness-qa", "harness-orchestrator", "harness-setup"]);

/** Os padrões proibidos — cada um com o REMÉDIO que o teste dá a quem o reintroduzir. */
const FORBIDDEN: Array<{ name: string; re: RegExp; fix: string }> = [
  { name: "runner de teste/typecheck cravado (`vitest`, `tsc`)", re: /\bbunx?\s+(vitest|tsc)\b/, fix: "peça o check `testUnit`/`typecheck` ao `target_profile` e rode o comando declarado" },
  { name: "`npm` cravado", re: /\bnpm\b/, fix: "não nomeie o gerenciador de pacotes: descubra o comando nas instruções do repositório" },
  { name: "pasta de regras do repositório de origem (`.claude/rules/`)", re: /\.claude\/rules\//, fix: "aponte um documento do perfil: `target_profile` → docs.testing / security / devEnvironment" },
  { name: "ADR do repositório de origem", re: /docs\/adr|\bADR-\d/, fix: "remeta às instruções do repositório; a ferramenta não conhece os ADRs de ninguém" },
  { name: "`.claude/CLAUDE.md` cravado", re: /\.claude\/CLAUDE\.md/, fix: "use `target_profile` → docs.conventions, ou «as instruções do repositório»" },
  { name: "`packages/<x>/CLAUDE.md` cravado", re: /packages\/<[^>]+>\/[^\s]*CLAUDE\.md/, fix: "use `target_profile` → docs.conventions" },
  { name: "layout `packages/<pkg>` cravado", re: /packages\/<[a-z]+>/, fix: "diga «o pacote do board» (`package:` do board.yaml)" },
  { name: "moeda do repositório de origem (R$ / chave *BRL)", re: /\bR\$\s?\d|\bmonthlyBRL\b|\bbaselineMonthlyBRL\b|\bcashMonthlyBRL\b|\binfraMonthlyBRL\b/, fix: "use a moeda do alvo: `monthlyAmount`, `cashMonthly`… (a moeda vem do board ou de target.currency)" },
  { name: "lente de domínio embutida (`firestore`, `nextjs`) como vocabulário da ferramenta", re: /\b(firestore|nextjs)\s*\|/, fix: "as lentes de domínio são do alvo: leia `reviewLenses` no `target_profile`" },
  { name: "script da FERRAMENTA citado relativo ao cwd do alvo (`node scripts/visual-sweep.mjs`)", re: /node\s+scripts\/(visual-sweep|capability-probe)/, fix: 'use "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/../../scripts/…" (a env é injetada em todo run; o fallback cobre a mão)' },
  { name: "gerenciador de pacotes alheio (`pnpm`, `yarn`)", re: /\b(pnpm|yarn)\b/, fix: "não nomeie o gerenciador de pacotes: descubra o comando nas instruções do repositório" },
  { name: "infraestrutura de produto cravada (`firebase`, `emulator`)", re: /\b(firebase|emulators?)\b/i, fix: "diga «backing service» / «stack local do produto»: quais existem é do alvo (target.dev, as instruções do repositório)" },
];

/** `make <alvo>` em bloco cercado ou crase (a palavra solta «make» é o verbo inglês: «make the card…»). */
function makeInvocations(md: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      const t = line.trim().replace(/^\$\s+/, "").replace(/^>\s*/, "");
      if (/^make\s+[a-z-]+/.test(t)) found.push(t);
      continue;
    }
    for (const m of line.matchAll(/`make\s+([a-z][\w-]*)/g)) found.push(`make ${m[1]}`);
  }
  return found;
}

/** `bun run (test|dev|build)` fora das skills que falam da própria ferramenta. */
function bunRunScripts(file: string, md: string): string[] {
  if (BUN_RUN_SELF_TOOL.has(path.basename(path.dirname(file)))) return [];
  return [...md.matchAll(/\bbun run (test|dev|build)\b/g)].map((m) => m[0]);
}

describe("skills/comandos/assistentes e _base/board.yaml não prescrevem o ferramental de um repositório", () => {
  const sources = textSources();

  it("nenhuma receita `just <receita>` (a receita é do ALVO — target.checks)", () => {
    const offenders: string[] = [];
    for (const f of sources) for (const inv of justInvocations(readFileSync(f, "utf8"))) offenders.push(`${path.relative(ROOT, f)}: "${inv}"`);
    expect(
      offenders.join("\n"),
      "uma skill mandando rodar uma receita de executor: o agente é headless e a falha vira card parado. Peça o check ao `target_profile` e diga «descubra o comando nas instruções do repositório» quando o alvo não declarou.",
    ).toBe("");
  });

  it("nenhum `make <alvo>` (a receita é do ALVO — target.checks)", () => {
    const offenders: string[] = [];
    for (const f of sources) for (const inv of makeInvocations(readFileSync(f, "utf8"))) offenders.push(`${path.relative(ROOT, f)}: "${inv}"`);
    expect(offenders.join("\n"), "uma skill mandando rodar `make <alvo>`: peça o check ao perfil do alvo").toBe("");
  });

  it("nenhum `bun run test|dev|build` do projeto de origem (exceção declarada: as skills que falam da PRÓPRIA ferramenta)", () => {
    const offenders: string[] = [];
    for (const f of sources) for (const inv of bunRunScripts(f, readFileSync(f, "utf8"))) offenders.push(`${path.relative(ROOT, f)}: "${inv}"`);
    expect(offenders.join("\n"), "script do projeto de origem: peça o check ao perfil do alvo (target.checks) ou descubra o comando nas instruções do repositório").toBe("");
  });

  for (const rule of FORBIDDEN) {
    it(`zero ocorrências de: ${rule.name}`, () => {
      const offenders: string[] = [];
      for (const f of sources) {
        readFileSync(f, "utf8").split("\n").forEach((ln, i) => {
          if (rule.re.test(ln)) offenders.push(`${path.relative(ROOT, f)}:${i + 1} → ${ln.trim().slice(0, 100)}`);
        });
      }
      baseBoardCodeLines().forEach((ln) => {
        if (rule.re.test(ln)) offenders.push(`storymap/boards/_base/board.yaml → ${ln.trim().slice(0, 100)}`);
      });
      expect(offenders.join("\n"), `remédio: ${rule.fix}`).toBe("");
    });
  }

  // `$AGILEHARNESS_TOOL_ROOT` é injetada em todo run do engine, mas uma skill rodada à mão (ou um probe no ambiente do
  // serviço) a tem vazia — e `"$VAR/../../scripts/x"` vira `/../../scripts/x`, um caminho que não existe, em silêncio.
  it("todo caminho de script da ferramenta (`visual-sweep.mjs`) traz o fallback da env (`:-` ou `:+`)", () => {
    const offenders: string[] = [];
    const check = (where: string, ln: string, i: number) => {
      if (/AGILEHARNESS_TOOL_ROOT/.test(ln) && /scripts\/visual-sweep\.mjs/.test(ln) && !/AGILEHARNESS_TOOL_ROOT:[-+]/.test(ln)) offenders.push(`${where}:${i + 1} → ${ln.trim().slice(0, 110)}`);
    };
    let seen = 0;
    for (const f of sources) readFileSync(f, "utf8").split("\n").forEach((ln, i) => { if (/scripts\/visual-sweep\.mjs/.test(ln)) seen++; check(path.relative(ROOT, f), ln, i); });
    readFileSync(BASE_BOARD, "utf8").split("\n").forEach((ln, i) => { if (/scripts\/visual-sweep\.mjs/.test(ln)) seen++; check("storymap/boards/_base/board.yaml", ln, i); });
    expect(seen, "o teste não viu nenhuma referência: ficou vácuo").toBeGreaterThan(4);
    expect(offenders.join("\n"), 'use "${AGILEHARNESS_TOOL_ROOT:-packages/storymap-ui}/../../scripts/visual-sweep.mjs"').toBe("");
  });

  it("NÃO-VACUIDADE: a varredura leu skills de verdade e cada padrão ACUSA um texto fabricado", () => {
    expect(sources.length).toBeGreaterThan(20);
    for (const must of ["harness-qa", "harness-do", "harness-tests", "harness-conductor", "harness-review"]) {
      expect(sources.some((f) => f.includes(path.join("skills", must, "SKILL.md"))), must).toBe(true);
    }
    expect(sources.some((f) => f.includes("harness-triage-shared"))).toBe(true); // os arquivos auxiliares também
    expect(baseBoardCodeLines().length).toBeGreaterThan(100);

    // o extrator de `just`: bloco cercado e crase contam; o advérbio inglês NÃO
    const md = ["```bash", "just test-widgets", "```", "rode `just validate` antes.", "You should just add the field.", "Pass just the card id."].join("\n");
    expect(justInvocations(md)).toEqual(["just test-widgets", "just validate"]);

    // um controle por padrão proibido (texto INVENTADO que o padrão tem de pegar)
    const controls: Record<string, string> = {
      "runner de teste/typecheck cravado (`vitest`, `tsc`)": "run bunx vitest run src/a.test.ts",
      "`npm` cravado": "then npm test",
      "pasta de regras do repositório de origem (`.claude/rules/`)": "read .claude/rules/testing.md",
      "ADR do repositório de origem": "see docs/adr/ADR-001.md",
      "`.claude/CLAUDE.md` cravado": "read the .claude/CLAUDE.md first",
      "`packages/<x>/CLAUDE.md` cravado": "read packages/<pkg>/.claude/CLAUDE.md",
      "layout `packages/<pkg>` cravado": "under `packages/<pkg>/tests`",
      "moeda do repositório de origem (R$ / chave *BRL)": "a ceiling of R$ 90 or monthlyBRL: 5",
      "lente de domínio embutida (`firestore`, `nextjs`) como vocabulário da ferramenta": "lens (one of firestore|security|perf)",
      "script da FERRAMENTA citado relativo ao cwd do alvo (`node scripts/visual-sweep.mjs`)": "node scripts/visual-sweep.mjs --probe",
      "gerenciador de pacotes alheio (`pnpm`, `yarn`)": "then run yarn test or pnpm install",
      "infraestrutura de produto cravada (`firebase`, `emulator`)": "boot the Auth emulator for the sweep",
    };
    for (const rule of FORBIDDEN) {
      expect(controls[rule.name], `falta um controle para: ${rule.name}`).toBeTruthy();
      expect(rule.re.test(controls[rule.name]!), `o padrão não acusou o controle de: ${rule.name}`).toBe(true);
    }
    // `make` e `bun run`: o verbo inglês NÃO conta; a notação de comando conta; a exceção da ferramenta passa
    expect(makeInvocations(["```bash", "make test-all", "```", "rode `make lint` antes.", "make the card ready", "We make sure."].join("\n"))).toEqual(["make test-all", "make lint"]);
    expect(bunRunScripts(path.join("skills", "harness-do", "SKILL.md"), "then bun run test:unit")).toEqual(["bun run test"]);
    expect(bunRunScripts(path.join("skills", "harness-qa", "SKILL.md"), "then bun run test:unit")).toEqual([]);

    // …e o advérbio / a frase de descoberta NÃO são acusados
    for (const ok of ["just add the card", "descubra o comando nas instruções do repositório", "(README, CLAUDE.md/AGENTS.md)", "the board package (`package:` in `board.yaml`)", "read the `target` block of `storymap/settings.yaml`"]) {
      expect(FORBIDDEN.some((r) => r.re.test(ok)), ok).toBe(false);
    }
  });
});

describe("acoplamento skill ↔ perfil do alvo", () => {
  const skills = walkMarkdown(path.join(CLAUDE, "skills")).filter((f) => f.endsWith("SKILL.md"));
  const skillText = (name: string) => readFileSync(path.join(CLAUDE, "skills", name, "SKILL.md"), "utf8");
  /** O texto numa linha só: uma frase quebrada entre linhas (ou entre `>` de citação) continua sendo a mesma frase. */
  const flat = (name: string) => skillText(name).replace(/\s*\n\s*(?:>\s*)?/g, " ");

  it("todo check/doc/dev citado numa skill existe no vocabulário do perfil (KNOWN_CHECKS / KNOWN_DOCS / KNOWN_DEV)", () => {
    const known = { checks: new Set<string>(KNOWN_CHECKS), docs: new Set<string>(KNOWN_DOCS), dev: new Set<string>(KNOWN_DEV) };
    const bad: string[] = [];
    let seen = 0;
    for (const f of skills) {
      const md = readFileSync(f, "utf8");
      for (const m of md.matchAll(/(?:target\.|`)(checks|docs|dev)\.([A-Za-z]+)\b/g)) {
        seen++;
        if (!known[m[1] as keyof typeof known].has(m[2]!)) bad.push(`${path.relative(ROOT, f)}: ${m[1]}.${m[2]}`);
      }
    }
    expect(seen, "o teste não viu nenhuma citação: ele ficou vácuo").toBeGreaterThan(5);
    expect(bad.join("\n"), "uma skill cita um check/doc/dev que o perfil do alvo não conhece").toBe("");
  });

  it("toda skill que manda rodar teste pede o check ao `target_profile` e dá a frase de descoberta", () => {
    for (const name of ["harness-do", "harness-qa", "harness-tests", "harness-conductor", "harness-review"]) {
      const md = flat(name);
      expect(md, `${name} não menciona target_profile`).toContain("target_profile");
      expect(md, `${name} não traz a frase de descoberta`).toContain("discover the command in the repository's own instructions");
    }
  });

  // O run `harness-*` headless sobe com --strict-mcp-config SEM o MCP do AgileHarness (spawn-env.ts remove os
  // AGILEHARNESS_MCP_TOKEN*): mandar uma skill de COLUNA chamar `target_profile` como caminho principal é mandar o agente
  // para uma ferramenta que ele não tem — e a falha vira card sem teste rodado. A fonte do run é o arquivo
  // (storymap/settings.yaml → target); o MCP só vale numa sessão de condutor e a skill diz isso.
  it("as skills de COLUNA (headless) leem o bloco `target` do settings.yaml; `target_profile` é só o atalho da sessão com MCP", () => {
    for (const name of ["harness-do", "harness-qa", "harness-tests", "harness-review"]) {
      const md = flat(name);
      expect(md, `${name} não manda ler storymap/settings.yaml (a fonte do run headless)`).toContain("storymap/settings.yaml");
      for (const m of md.matchAll(/target_profile/g)) {
        const around = md.slice(Math.max(0, m.index! - 220), m.index! + 220);
        expect(around, `${name}: target_profile sem o contexto «MCP montado» → ${around}`).toMatch(/MCP (?:is|storymap)|MCP is mounted|mounted|conductor session/i);
      }
    }
  });

  it("nenhuma skill manda um run usar `run_check` (ele roda no checkout de runtime, não no worktree do run)", () => {
    for (const name of ["harness-do", "harness-qa", "harness-tests", "harness-conductor", "harness-review"]) {
      const md = flat(name);
      for (const m of md.matchAll(/run_check/g)) {
        // citar `run_check` para AVISAR que ele não serve é o certo; mandar chamá-lo não
        const around = md.slice(Math.max(0, m.index! - 160), m.index! + 200);
        expect(around, `${name}: ${around}`).toMatch(/runtime checkout|your worktree/i);
      }
    }
  });

  it("as skills que autoram finding remetem às lentes do alvo, não a uma lista cravada", () => {
    expect(skillText("harness-review")).toContain("reviewLenses");
    expect(skillText("harness-conductor")).toContain("reviewLenses");
  });
});
