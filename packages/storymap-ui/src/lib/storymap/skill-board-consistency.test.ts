import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { findRepoRoot } from "@/lib/storymap/paths";
import { mergeRawConfig } from "@/lib/storymap/repo";
import { STORY_TYPE_IDS } from "@/lib/storymap/frameworks";
import { boardIdsOnDisk, inheritingBoards, optOutBoards, pipelineBoards } from "@/lib/storymap/board-fixture";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStorymapTools } from "@/lib/storymap/mcp/tools";
import { registerDevTools } from "@/lib/storymap/mcp/dev-tools";
import { registerOnboarding } from "@/lib/storymap/mcp/onboarding";
import { readSkillTrees } from "@/lib/storymap/skills-drift";
import * as publicationGate from "../../../../../scripts/oss/publication-gate.mjs";

/** Os termos privados do operador, fora do repositório; sem o arquivo (um contribuidor), a lista é vazia. */
const PRIVATE_TERMS = (() => {
  const g = publicationGate as unknown as { defaultTermsFile: () => string; loadPrivateTerms: (file: string) => Array<{ re: RegExp }> | null };
  return g.loadPrivateTerms(g.defaultTermsFile()) ?? [];
})();

// Skill ↔ board consistency.
//
// Each harness-* skill DOCUMENTS, in its SKILL.md frontmatter, the column it READS
// ("Reads a card in status `X`" / "sitting in `X`") and the status TRANSITION it
// performs ("advances `X` -> `Y`"). The board.yaml is the source of truth for which
// columns exist and their order. This test cross-checks the two so a skill (or a
// board) can't drift into: (a) referencing a column that does not exist, (b) a
// transition that runs OUTSIDE the pipeline flow (backward / sideways), or (c) a
// pipeline skill wired to the wrong column.
//
// Extraction is deliberately scoped to the canonical notations to avoid false
// positives: we parse ONLY the frontmatter (not the body, which carries prose like
// "read the `design-ux` status `autorun`" where `autorun` is a flag, not a column),
// and we match ONLY `in status `X`` / `sitting in `X`` and the `->` arrow forms.

const ROOT = findRepoRoot();
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");

interface StatusDef {
  id: string;
  trigger?: string;
}
interface BoardDoc {
  statuses: StatusDef[];
}

function loadRaw(file: string): Record<string, unknown> {
  return (yaml.load(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
}
// Since B5/Fase 5 the canonical Stage→Step pipeline lives in `boards/_base`; a board's OWN board.yaml
// declares only deltas. Resolve each board the way the runtime does (raw board ⊕ _base via
// mergeRawConfig) so this lint sees the SAME pipeline the engine walks — `storymap` inherits the
// canonical pipeline (its board.yaml has no `statuses`), product boards opt out and keep their own.
const BASE_RAW = loadRaw(path.join(ROOT, "storymap", "boards", "_base", "board.yaml"));
function loadBoard(board: string): BoardDoc {
  const raw = loadRaw(path.join(ROOT, "storymap", "boards", board, "board.yaml"));
  return mergeRawConfig(BASE_RAW, raw) as unknown as BoardDoc;
}

// Boards DIVERGE (Stage→Step + board-aware advance): `storymap` AND `acme` resolve to the CANONICAL
// superset (inherit _base's grill/interview/design-ui/ready/merge/stage/release/deploy — `acme`
// migrated in Fase 5, dropping `inheritPipeline:false`), while `orbit` still opts out
// (`inheritPipeline:false`) and keeps the older PRODUCT pipeline. The harness-* skills are SHARED but
// board-aware (they advance via `advance-card`, not a hardcoded status), so a skill may legitimately
// reference any board's column. Hence:
//   - VALID = the UNION of every board's column ids (membership check).
//   - forward-flow is judged PER BOARD — an arrow is "forward" if forward in SOME board
//     whose pipeline contains both endpoints.
const BOARD_IDS = pipelineBoards();
const ORDERS = BOARD_IDS.map((b) => loadBoard(b).statuses.map((s) => s.id));
const VALID = new Set(ORDERS.flat());

// trigger (== skill name) -> column id, across ALL boards' autorun wiring (a trigger
// maps to the same column id wherever it appears).
const triggerToColumn = new Map<string, string>();
for (const order of BOARD_IDS.map(loadBoard))
  for (const s of order.statuses) if (s.trigger) triggerToColumn.set(s.trigger, s.id);

/** The SKILL.md frontmatter block (between the first two `---`), where the wiring lives. */
function skillFrontmatter(skill: string): string {
  const raw = readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  return fm ? fm[1] : raw;
}

/** The SKILL.md body — everything AFTER the closing `---` of the frontmatter. The
 *  prose where a skill describes, in human words, the gate/routing/status rules it
 *  acts on. Drift hides here: an outdated status name or a routing rule that no
 *  longer matches `gates.ts`/`pipeline-routing.ts` is invisible to a frontmatter-only
 *  lint. We re-apply the (deliberately strict) status extractors to it below. */
function skillBody(skill: string): string {
  const raw = readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
  const m = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  // Uma skill dividida em NÚCLEO + `ref/` (o condutor) continua UMA skill: a prosa de regra que saiu do SKILL.md para
  // os arquivos de apoio é lida aqui junto — sem isso a divisão tiraria do lint justamente as seções mais longas.
  return [m ? m[1] : "", ...skillRefTexts(skill)].join("\n");
}

/** Os arquivos de apoio de uma skill (`ref/*.md`), em ordem — a parte da regra que o núcleo manda ler sob demanda. */
function skillRefFiles(skill: string): string[] {
  const dir = path.join(SKILLS_DIR, skill, "ref");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}
function skillRefTexts(skill: string): string[] {
  return skillRefFiles(skill).map((f) => readFileSync(path.join(SKILLS_DIR, skill, "ref", f), "utf8"));
}

// `A` -> `B` (separate backticks) OR `A -> B` (single backtick pair) — both occur.
function extractArrows(text: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  const sep = /`([a-z][a-z-]*)`\s*->\s*`([a-z][a-z-]*)`/g;
  const one = /`([a-z][a-z-]*)\s*->\s*([a-z][a-z-]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(text))) out.push({ from: m[1], to: m[2] });
  while ((m = one.exec(text))) out.push({ from: m[1], to: m[2] });
  return out;
}

// "in status `X`" / "sitting in `X`" — the column the skill reads (its entry).
// `\s+` (not a literal space) so it still matches when the YAML-folded frontmatter
// wraps the line between "status" and the backticked id.
function extractEntries(text: string): string[] {
  const out: string[] = [];
  const re = /(?:in status|sitting in)\s+`([a-z][a-z-]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// Explicit `storyType: X` references in prose — both the backtick-wrapped canonical
// form (`` `storyType: bug` ``) and the bare prose form (`storyType: chore`). Scoped
// to the `storyType:` + value shape so a placeholder (`storyType: <type>`) or a bare
// mention of the field (`` `storyType` ``, no value) never matches — only a concrete
// value does, and that value MUST be a real member of STORY_TYPE_IDS.
function extractStoryTypeRefs(text: string): string[] {
  const out: string[] = [];
  const re = /`?storyType:\s*([a-z][a-z-]*)`?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

const VALID_STORY_TYPES = new Set<string>(STORY_TYPE_IDS);

// AC2 — prose that DESCRIBES gate/routing/storyType rules is describing behaviour that
// actually LIVES in pipeline-routing.ts / gates.ts / frameworks.ts. When the prose
// names such a rule but cites no source file, a maintainer can change the source and
// never notice the prose went stale. We flag those as drift CANDIDATES (warn-only —
// never a build failure; the signal is the CI log line, surfacing skills to review).
const ROUTING_KEYWORDS = [
  "storyType",
  "hasTasks",
  "hasRefinement",
  "hasWireframe",
  "hasQaPassed",
  "hasNoBlockers",
  "pipeline-routing",
  "needsUiDesign",
];
const SOURCE_FILES = ["pipeline-routing.ts", "gates.ts", "frameworks.ts"];

/** True when prose names a gate/routing rule but cites no source file → drift candidate. */
function needsCitationWarning(body: string): boolean {
  const hasKeyword = ROUTING_KEYWORDS.some((k) => body.includes(k));
  const hasCitation = SOURCE_FILES.some((f) => body.includes(f));
  return hasKeyword && !hasCitation;
}

const skillDirs = readdirSync(SKILLS_DIR).filter(
  (d) => d.startsWith("harness-") && existsSync(path.join(SKILLS_DIR, d, "SKILL.md")),
);

describe("skill ↔ board consistency", () => {
  // O invariante que este teste guarda é `inheritPipeline`, e ele NÃO é sobre três boards nomeados.
  // A versão anterior cravava `acme`/`storymap`/`orbit` — dado de produto do dono, que a régua
  // a antiga lista de extração cortava e que portanto não existe neste repositório (lá isto era ENOENT). Trocar os
  // nomes pela CLASSIFICAÇÃO (`inheritPipeline: false` ou não, lido do próprio yaml) prova a mesma
  // coisa em qualquer árvore e sobre TODOS os boards, não sobre três — no monorepo continua cobrindo
  // acme/storymap/orbit, e cobre os fixtures demo/demo-legado por cima.
  //
  // O ponto de ancoragem é o `_base`, não "um board comparado com outro": com um único board herdeiro
  // na árvore (o caso do repo extraído) uma comparação board-a-board ficaria verde por não ter par.
  it("todo board que herda resolve para a pipeline canônica do `_base`; quem opta por sair, não", () => {
    const CANONICAL = new Set((BASE_RAW.statuses as StatusDef[]).map((s) => s.id));
    expect(CANONICAL.size, "`_base` sem statuses — a pipeline canônica sumiu e o lint mediria o vazio").toBeGreaterThan(
      0,
    );

    const herdam = inheritingBoards();
    const optamPorSair = optOutBoards();
    // Não-vacuidade dos DOIS lados: cada classe tem de ter sujeito nesta árvore. Os fixtures garantem
    // isso nas duas (demo herda; demo-legado declara `inheritPipeline:false`).
    expect(herdam.length, "nenhum board herdeiro nesta árvore").toBeGreaterThan(0);
    expect(optamPorSair.length, "nenhum board com `inheritPipeline:false` — o opt-out ficaria sem prova").toBeGreaterThan(
      0,
    );

    for (const b of herdam) {
      // Herdeiro só declara DELTAS por passo ({ id, faceta }); o conjunto de ids resolvido tem de ser
      // exatamente o canônico. Re-inlinar a pipeline no board cortaria a propagação do `_base` — e é
      // isso que esta igualdade reprova.
      expect(new Set(loadBoard(b).statuses.map((s) => s.id)), `board "${b}" herda mas divergiu do _base`).toEqual(
        CANONICAL,
      );
    }
    for (const b of optamPorSair) {
      // `inheritPipeline:false` tem de SIGNIFICAR algo: um board que opta por sair e mesmo assim
      // resolve para o conjunto canônico não está exercitando a porta de saída — está fingindo.
      expect(
        new Set(loadBoard(b).statuses.map((s) => s.id)),
        `board "${b}" declara \`inheritPipeline:false\` mas resolveu para a pipeline canônica`,
      ).not.toEqual(CANONICAL);
    }
  });

  it("every board column with a trigger has a matching harness-* skill", () => {
    for (const [trigger] of triggerToColumn) {
      expect(
        existsSync(path.join(SKILLS_DIR, trigger, "SKILL.md")),
        `board triggers \`${trigger}\` but .claude/skills/${trigger}/SKILL.md is missing`,
      ).toBe(true);
    }
  });

  it("found the expected harness-* skills (sanity)", () => {
    expect(skillDirs.length).toBeGreaterThanOrEqual(triggerToColumn.size);
  });

  // WS-10.1 — the COLUMN-LESS guard. `harness-resolve` (the semantic judge) is born ONLY from the train's or
  // the release's conflict disposition, exactly as the re-drive is born from the RedriveHandler. Wiring it
  // to a board column would let the PIPELINE spawn a judge for a card that has no divergence to judge —
  // it would find no conflict markers, have nothing to adjudicate, and burn a spawn to say so. It is also
  // excluded from COLUMN_TRIGGER_IDS (types.ts), so repo.ts would reject such a board.yaml at load; this
  // test is the SECOND lock, on the data, so the drift is caught in CI rather than at a boot nobody watches.
  const COLUMN_LESS = ["harness-resolve", "harness-sync-card"];
  it.each(COLUMN_LESS)("`%s` is column-less — no board column may declare it as a trigger", (skill) => {
    expect(
      triggerToColumn.has(skill),
      `${skill} is column-less by design (it is spawned by the runner, not by the pipeline), ` +
        `but a board.yaml declares it as a column trigger`,
    ).toBe(false);
  });

  // Deterministic teeth for the AC2 warn detector (the per-skill check is warn-only).
  it("citation-warning detector fires on uncited rules, stays silent when cited", () => {
    expect(needsCitationWarning("the cascade routes by storyType into the next lane")).toBe(true);
    expect(needsCitationWarning("checks the hasNoBlockers gate before advancing")).toBe(true);
    // Same rule, now citing the source file → no warning.
    expect(needsCitationWarning("routes by storyType — see pipeline-routing.ts")).toBe(false);
    expect(needsCitationWarning("the hasTasks gate, defined in gates.ts")).toBe(false);
    // No routing/gate vocabulary at all → nothing to warn about.
    expect(needsCitationWarning("writes the narrative and acceptance criteria")).toBe(false);
  });

  // A GUARDA ANTI-VÁCUO DOS EXTRATORES.
  //
  // Converter os laços acima para coleta-então-asserta faz os testes SOBREVIVEREM à exigência de
  // asserção — mas não devolve a medição perdida: com corpus vazio, a lista de ofensores é `[]` e o
  // teste segue verde sem conferir nada. Esta é a asserção que separa "não achei desvio" de "não
  // achei nada". Se um extrator quebrar (uma mudança de notação no SKILL.md, um regex que deixa de
  // casar), o lint inteiro fica cego — e é aqui que isso aparece, em vez de num verde tranquilo.
  it("os extratores acham o que conferir (senão o lint inteiro mede zero)", () => {
    const totalEntradas = skillDirs.reduce((n, s) => n + extractEntries(skillFrontmatter(s)).length, 0);
    const totalSetas = skillDirs.reduce((n, s) => n + extractArrows(skillFrontmatter(s)).length, 0);
    expect(skillDirs.length, "nenhum skill no disco — a suíte inteira não teria sujeito").toBeGreaterThan(0);
    expect(totalEntradas, "nenhum skill declara entry status — o lint de coluna não mede nada").toBeGreaterThan(0);
    expect(totalSetas, "nenhum skill declara transição — o lint de forward não mede nada").toBeGreaterThan(0);
  });

  describe.each(skillDirs)("%s", (skill) => {
    const fm = skillFrontmatter(skill);
    const arrows = extractArrows(fm);
    const entries = extractEntries(fm);
    const ownColumn = triggerToColumn.get(skill);

    // COLETA-ENTÃO-ASSERTA, e não `expect` dentro do laço. MEDIDO (com
    // `expect.requireAssertions`): para 5 dos 21 skills este laço é VAZIO — o `expect` nunca era
    // alcançado e o teste passava sem medir nada. A forma abaixo asserta uma vez, SEMPRE, e a
    // mensagem melhora de quebra: em vez de morrer no primeiro desvio, ela lista todos.
    it("references only REAL board columns (entries + transitions)", () => {
      const fora = [
        ...entries.filter((id) => !VALID.has(id)).map((id) => `entry status \`${id}\``),
        ...arrows.filter((a) => !VALID.has(a.from)).map((a) => `transition from \`${a.from}\``),
        ...arrows.filter((a) => !VALID.has(a.to)).map((a) => `transition to \`${a.to}\``),
      ].map((t) => `${skill}: ${t} is not a column in board.yaml`);
      expect(fora).toEqual([]);
    });

    // AC1 — the SAME column extractors applied to the PROSE BODY, not just the
    // frontmatter. The notations are strict enough (`in status `X`` / `` `A` -> `B` ``)
    // that flags/fields (`autorun`, `techPlanReady`, …) never trip them, so any status
    // token caught here that isn't a real column is genuine prose drift, not a false
    // positive. A misspelled status name ("pronta p/ build" vs `pronta`) fails the test.
    const body = skillBody(skill);
    const bodyArrows = extractArrows(body);
    const bodyEntries = extractEntries(body);

    it("body references only REAL board columns (entries + transitions)", () => {
      const fora = [
        ...bodyEntries.filter((id) => !VALID.has(id)).map((id) => `entry status \`${id}\``),
        ...bodyArrows.filter((a) => !VALID.has(a.from)).map((a) => `transition from \`${a.from}\``),
        ...bodyArrows.filter((a) => !VALID.has(a.to)).map((a) => `transition to \`${a.to}\``),
      ].map((t) => `${skill} body: ${t} is not a column in board.yaml`);
      expect(fora).toEqual([]);
    });

    // AC3 — when a SKILL.md spells out a concrete `storyType: X` value, X must be a
    // member of STORY_TYPE_IDS (frameworks.ts, the source of truth). If frameworks.ts
    // renames/removes a type, the skills naming it light up here — and adding a new
    // type that a skill already documents passes cleanly. We scan frontmatter + body.
    it("references only REAL storyTypes from frameworks.ts", () => {
      const full = `${fm}\n${body}`;
      const fora = extractStoryTypeRefs(full)
        .filter((st) => !VALID_STORY_TYPES.has(st))
        .map((st) => `${skill}: storyType \`${st}\` is not in STORY_TYPE_IDS (frameworks.ts)`);
      expect(fora).toEqual([]);
    });

    // AC2 — ERA warn-only, e virou CATRACA.
    //
    // O bloco antigo só fazia `console.warn`, e isso o tornava o único teste da suíte sem NENHUMA
    // asserção — passava medindo zero, nos 21 skills. Um aviso que ninguém coleta já era zero
    // medição: ele saía no meio de milhares de linhas de saída, a cada passada, e o número de
    // skills sem citação podia CRESCER sem que nada mudasse de cor.
    //
    // A saída não foi inventar uma asserção que reprovasse os 13 de hoje — isso seria trocar um
    // vácuo por um vermelho permanente, que alguém desliga na primeira sexta-feira. É uma catraca,
    // o mesmo idioma da whitelist de dívida que este repositório já usa: a lista SÓ ENCOLHE. Um
    // skill NOVO sem citação reprova; um skill que GANHA citação tem de sair da lista (senão a
    // entrada fica obsoleta e a segunda asserção pega).
    const SEM_CITACAO_CONHECIDOS = new Set([
      "harness-do", "harness-grill", "harness-interview", "harness-plan", "harness-qa", "harness-review", "harness-ship",
      "harness-story", "harness-sync-card", "harness-tasks", "harness-tests", "harness-ui", "harness-ux",
    ]);

    it("prose routing/gate rules cite a source file (catraca: a lista só encolhe)", () => {
      const semCitacao = needsCitationWarning(body);
      const conhecido = SEM_CITACAO_CONHECIDOS.has(skill);
      if (semCitacao && !conhecido) {
        expect.fail(
          `${skill}: a prosa nomeia regra de gate/roteamento (${ROUTING_KEYWORDS.join(", ")}) sem citar ` +
            `o arquivo que a possui (${SOURCE_FILES.join(" / ")}). Cite a fonte — a prosa deriva na ` +
            `próxima mudança de política e ninguém percebe.`,
        );
      }
      // O OUTRO LADO DA CATRACA: entrada obsoleta é tão ruim quanto skill novo sem citação, porque
      // ela transforma um progresso real em permissão silenciosa para regredir.
      expect(
        conhecido && !semCitacao ? `${skill} passou a citar a fonte — remova-o de SEM_CITACAO_CONHECIDOS` : null,
      ).toBeNull();
    });

    it("transitions move FORWARD in the pipeline (no out-of-flow arrow)", () => {
      // Divergent boards: the arrow must be forward in SOME board whose pipeline holds
      // both endpoints. No board holding both = drift.
      const paraTras = arrows
        .filter(
          (a) =>
            !ORDERS.some((o) => {
              const fi = o.indexOf(a.from);
              const ti = o.indexOf(a.to);
              return fi >= 0 && ti >= 0 && ti > fi;
            }),
        )
        .map((a) => `${skill}: transition \`${a.from}\` -> \`${a.to}\` is not forward in any board's pipeline order`);
      expect(paraTras).toEqual([]);
    });

    // A skill that a board column TRIGGERS must read that very column and start its
    // transition there (the producer runs ON its column). Re-entry/router skills
    // (harness-fix/harness-refine) describe their routes in prose, not `->`, so they have no
    // arrows here — only the entry assertion applies to them.
    if (ownColumn) {
      it(`operates on its own column \`${ownColumn}\` (reads it / transitions from it)`, () => {
        // The producer either documents the entry ("in status `X`") or transitions
        // FROM it ("`X` -> `Y`") — accept either as evidence it runs on its column.
        const operatesOnOwn = entries.includes(ownColumn) || arrows.some((a) => a.from === ownColumn);
        expect(
          operatesOnOwn,
          `${skill}: SKILL.md should read or transition from its column \`${ownColumn}\``,
        ).toBe(true);
        for (const a of arrows) {
          expect(a.from, `${skill}: arrow \`${a.from}\` -> \`${a.to}\` should start at its column \`${ownColumn}\``).toBe(
            ownColumn,
          );
        }
      });
    }
  });
});

// ── harness-cycle: a skill do ciclo de conserto e melhoria da FERRAMENTA ────────────────────────────────────────────
//
// As outras skills `harness-*` rodam sobre as colunas de um board e já são lidas pelo `describe.each` acima (colunas
// reais, setas para frente, citação de fonte). Esta é diferente: é o procedimento de uma SESSÃO que conserta a própria
// ferramenta, e o que a prende à realidade não é uma coluna, é a SUPERFÍCIE MCP — ela manda a sessão «chamar `ah_health`»,
// e se a tool for renomeada ou nunca existir, o ciclo inteiro vira instrução morta que ninguém percebe (a sessão
// improvisa). Por isso este bloco confere (a) que toda tool citada existe de verdade, montada pelo mesmo registro que o
// servidor usa, e (b) que a skill continua genérica: nenhum nome de produto, nenhum id de board fixo.

/** Os nomes de TODA tool que o servidor monta no nível `full` (o mesmo registro do pino de instruções). */
function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  const server = { registerTool: (name: string) => void names.add(name) } as unknown as McpServer;
  // As tools de operação só montam quando a instalação declara o script que elas chamam; a skill pode citá-las.
  const antes = process.env.AGILEHARNESS_OPS_REPORT_SCRIPT;
  process.env.AGILEHARNESS_OPS_REPORT_SCRIPT = process.execPath;
  try {
    registerOnboarding(server);
    registerStorymapTools(server);
    registerDevTools(server);
  } finally {
    if (antes === undefined) delete process.env.AGILEHARNESS_OPS_REPORT_SCRIPT;
    else process.env.AGILEHARNESS_OPS_REPORT_SCRIPT = antes;
  }
  return names;
}

/**
 * As tools que um texto cita: um identificador `snake_case` (com ao menos um `_`) sozinho entre crases, ou seguido de `(`
 * — a forma em que uma skill manda CHAMAR uma tool. Caminho (`health.jsonl`), variável de ambiente (maiúscula) e comando
 * (`ah-release`) não casam, de propósito: o extrator mede tools, não qualquer coisa entre crases.
 */
function citedTools(text: string): string[] {
  return [...new Set([...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?:\(|`)/g)].map((m) => m[1]))];
}

/**
 * Nome privado do operador (os termos do gate de publicação, quando a instalação os declara — o mesmo critério do
 * agnostic-lint) ou id de board que existe nesta árvore.
 */
function productOrBoardNames(text: string): string[] {
  const hits = new Set<string>();
  for (const t of PRIVATE_TERMS) {
    const m = t.re.exec(text);
    if (m) hits.add(m[0].toLowerCase());
  }
  for (const id of boardIdsOnDisk().filter((b) => !b.startsWith("_"))) {
    if (new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(text)) hits.add(id);
  }
  return [...hits];
}

describe("harness-cycle — o ciclo de conserto da ferramenta", () => {
  const SKILL = "harness-cycle";
  const text = existsSync(path.join(SKILLS_DIR, SKILL, "SKILL.md")) ? readFileSync(path.join(SKILLS_DIR, SKILL, "SKILL.md"), "utf8") : "";

  it("existe e entra no lint de colunas das demais (o describe.each a enxerga)", () => {
    expect(text.length, "a skill harness-cycle sumiu (.claude/skills/harness-cycle/SKILL.md)").toBeGreaterThan(0);
    expect(skillDirs).toContain(SKILL);
  });

  it("só cita tools MCP que EXISTEM — e cita as do ciclo (a medida e a conferência da versão)", () => {
    const real = registeredToolNames();
    expect(real.size, "o registro não montou nenhuma tool — o teste mediria o vazio").toBeGreaterThan(50);
    const cited = citedTools(text);
    expect(cited, "o extrator não achou nenhuma tool citada — a skill perdeu a medida ou o extrator quebrou").toContain("ah_health");
    expect(cited.filter((t) => !real.has(t)).map((t) => `${SKILL}: cita a tool \`${t}\`, que o servidor não monta`)).toEqual([]);
  });

  it("o extrator tem dentes: uma tool inventada é pega, e caminho, variável de ambiente e comando não são confundidos com tool", () => {
    const real = registeredToolNames();
    const amostra = "chame `ah_health` e `ferramenta_que_nao_existe({ a })`; veja `health.jsonl`, `AGILEHARNESS_SELF_BOARD` e `contrib/ah-release`";
    expect(citedTools(amostra)).toEqual(["ah_health", "ferramenta_que_nao_existe"]);
    expect(citedTools(amostra).filter((t) => !real.has(t))).toEqual(["ferramenta_que_nao_existe"]);
  });

  it("é GENÉRICA: nenhum nome de produto e nenhum id de board fixo (os boards vêm de `<board>` e do que a instalação declara)", () => {
    expect(productOrBoardNames(text)).toEqual([]);
    // o detector tem dentes sobre texto que o viola
    expect(productOrBoardNames("valide com os cards do board demo-legado")).toContain("demo-legado");
  });

  it("é distribuída por sync_skills: entra no conjunto de skills `harness-*` que a ferramenta leva ao alvo", () => {
    const tree = readSkillTrees(ROOT).find((t) => t.name === SKILL);
    expect(tree, `${SKILL} não está entre as skills que a ferramenta distribui`).toBeDefined();
    expect(Object.keys(tree!.files)).toContain("SKILL.md");
  });

  // Revisão do WP6b: os critérios de saída liam `delta.worsened`, que conta oscilação de número dentro do mesmo nível — no
  // ledger vivo ele veio cheio em 10 de 10 pares de leituras sem release no meio. Seguida ao pé da letra, a skill
  // nunca fechava um ciclo e mandava desfazer conserto bom.
  it("«nenhum outro sinal piorou» é julgado por `worsenedLevel` (subiu de nível), nunca por `worsened` vazio", () => {
    expect(text).toMatch(/worsenedLevel/);
    expect(text, "um critério ainda exige `worsened` vazio").not.toMatch(/`(delta\.)?worsened` vazio/);
  });

  // Revisão do WP6b: liberar a tag de uma branch não integrada fazia o ciclo seguinte (cortado da main) apagar o conserto
  // anterior da produção em silêncio. O ah-release recusa; a skill tem de mandar integrar antes de taguear.
  it("integra na main ANTES de taguear, volta atrás só com `--rollback` e roda o release em segundo plano", () => {
    expect(text).toMatch(/integr\w+ (a sua branch )?na main/i);
    expect(text).toMatch(/--rollback/);
    expect(text).toMatch(/segundo plano/);
  });
});

// ── harness-conductor: NÚCLEO + ref/ ──────────────────────────────────────────────────────────────────────────────────
//
// A skill do condutor era um arquivo de ~76KB (~25k tokens) que entrava inteiro no primeiro turno de toda sessão. Agora é
// um NÚCLEO (~10KB: o mapa, os blocos como checklist, as salvaguardas) e arquivos `ref/` que o núcleo manda ler no bloco
// que os usa. O risco de uma divisão assim é PERDER regra no caminho — uma frase que ninguém copiou é uma regra que o
// condutor deixa de seguir sem ninguém ver. Este bloco prova: (a) o núcleo é pequeno; (b) todo `ref/` existe e é citado
// pelo núcleo (nenhum órfão, nenhum link morto); (c) as seções e as regras-chave da skill original continuam na ÁRVORE;
// (d) toda tool que a skill manda chamar existe e é montada pelo conjunto `conductor` — ou está na lista do que ela PROÍBE.
describe("harness-conductor — núcleo + ref/ (nenhuma regra perdida)", () => {
  const SKILL = "harness-conductor";
  const core = readFileSync(path.join(SKILLS_DIR, SKILL, "SKILL.md"), "utf8");
  const refs = skillRefFiles(SKILL);
  const tree = [core, ...skillRefTexts(SKILL)].join("\n");
  const flat = (t: string) => t.replace(/\s*\n\s*(?:>\s*)?/g, " ");

  it("o núcleo é pequeno (≤ 12KB) e o resto mora em ref/", () => {
    expect(Buffer.byteLength(core, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect(refs.length).toBeGreaterThanOrEqual(8);
  });

  it("todo ref/ é citado pelo núcleo e todo ref/ citado existe", () => {
    const cited = [...new Set([...core.matchAll(/`ref\/([a-z0-9-]+\.md)`/g)].map((m) => m[1]))];
    expect(cited.length).toBeGreaterThan(0);
    expect(refs.filter((f) => !cited.includes(f)).map((f) => `ref/${f} não é citado pelo núcleo (órfão)`)).toEqual([]);
    expect(cited.filter((f) => !refs.includes(f)).map((f) => `o núcleo cita ref/${f}, que não existe`)).toEqual([]);
  });

  it("toda seção da skill original continua na árvore", () => {
    const SECOES = [
      "## Starting a conductor",
      "## The model in one table",
      "## The two write channels (and why gates see only one)",
      "## The driver and the claim",
      "## Safe landings (the projection rule)",
      "## MCP surface you use (verified shapes)",
      "## Tell the board where you are (`report_progress`)",
      "## 0 · PRE-VOO",
      "## 1 · MOLDAR (shape)",
      "## 2 · CONSTRUIR (build)",
      "## 3 · VERIFICAR (verify)",
      "## If this session runs on Sonnet (pilot)",
      "## 4 · PUBLICAR (publish)",
      "## Pauses — what the operator does",
      "## Estacionar e retomar (park & resume)",
      "## Budget",
      "## The autonomy PROFILE",
      "## ULTRA mode = BUSINESS-ONLY (the autonomy key)",
      "## Guardrails",
      "## Known limits",
      "## Report (end of each turn that closes a block)",
    ];
    expect(SECOES.filter((h) => !tree.includes(h))).toEqual([]);
  });

  it("as regras-chave continuam escritas (núcleo ou ref/)", () => {
    const REGRAS = [
      "Never call `approve_qa`",
      "never call `approve_qa`/`approve_review`",
      "**Never deploy**",
      "**Never edit the runtime checkout or the `stage` worktree**",
      "**Control paths are off-limits**",
      "Existing tests are control paths: never edit, skip or delete one",
      "From here these tests are LOCKED",
      "At most **2** returns to CONSTRUIR",
      "request_extra_cycle({board, cardId, loopsUsed: 2",
      "`suite: true` ONLY if YOU ran the package suite",
      "`visual: true` ONLY if the clean-context verifier swept",
      "`handoff: true` is what DECLARES the handoff",
      "KEEP `routing.driver: conductor`",
      "**You never answer your own questions**",
      "**Business never goes to the proxy**",
      "With `delivery` OFF you CANNOT cross",
      "only `request_budget` creates one the system can act on",
      "`update_card` REJECTS pipeline fields and `status`",
      "**Gates are evaluated against MAIN's card**",
      "never run `advance-card.ts`",
      "**Never pass a `model` when you launch the agent a lens names for security**",
      "Never quietly edit acceptance to match what you built.",
      "Zero questions is a valid, often ideal, outcome.",
      "`money`/`owner` are ALWAYS the owner's",
      "Webfonts are blocked, so never judge the typeface.",
      "never `pkill`",
      "`readyAll: false` is not visual proof.",
      "Clearing it would hand the card to the column cascade",
      "If `reopenPending: true` ⇒ P0",
      "A move into a column with `onEnter` is risk class `deploy` — never yours.",
      "never clear the driver before you release the claim and leave",
      "Never switch model or effort in the middle of the session",
      "it is a HARD constraint",
      "Never leave a card conducted with no session AND no open question",
      "never defaults to your recommendation",
      "is never proxied again",
      "discover the command in the repository's own instructions",
      "Never put third-party text into another agent's prompt except fenced as quoted data.",
      // fase 7 — o lote e a funcionalidade
      "A story always runs alone.",
      "`claim_batch` BEFORE the plan",
      "each commit with the trailer `Card: <id>`",
      "`worktree_submit` refuses a range that still carries a dropped item's code.",
      "The lead cannot be dropped",
      "never invent an id",
      "a new funcionalidade included, is a human question",
    ];
    const t = flat(tree);
    expect(REGRAS.filter((r) => !t.includes(r)).map((r) => `regra perdida na divisão: «${r}»`)).toEqual([]);
  });

  it("o núcleo manda ler o pacote de contexto e o ref/ de cada bloco", () => {
    expect(core).toContain("Pacote de contexto");
    for (const f of ["pre-voo-moldar.md", "construir.md", "verificar.md", "publicar.md", "sonnet.md"]) expect(core).toContain(`ref/${f}`);
  });

  // As tools que a skill CITA mas manda NÃO chamar (saídas do operador, publicação, shell, a chave do dono) — elas ficam
  // fora do conjunto `conductor` de propósito. Uma tool citada fora das duas listas é um furo: ou o condutor perdeu uma
  // tool que a skill manda usar, ou a skill manda usar algo que ela deveria proibir.
  const PROIBIDAS_AO_CONDUTOR = [
    "approve_qa",
    "approve_review",
    "answer_question",
    "write_doc",
    "update_vps",
    "publish_when_idle",
    "set_card_autonomy",
    "claude_new",
    "claude_recycle",
    "adopt_session",
    "run_check",
  ];

  it("toda tool citada existe, e o conjunto `conductor` monta todas as que a skill manda usar", async () => {
    const { CONDUCTOR_TOOLSET } = await import("@/lib/storymap/mcp/toolsets");
    const real = registeredToolNames();
    const cited = citedTools(tree);
    expect(cited.length, "o extrator não achou nenhuma tool citada — a skill perdeu a superfície ou o extrator quebrou").toBeGreaterThan(20);
    expect(cited.filter((t) => !real.has(t)).map((t) => `a skill cita \`${t}\`, que o servidor não monta`)).toEqual([]);
    const fora = cited.filter((t) => !CONDUCTOR_TOOLSET.includes(t) && !PROIBIDAS_AO_CONDUTOR.includes(t));
    expect(fora.map((t) => `a skill manda usar \`${t}\`, mas o conjunto conductor não o monta`)).toEqual([]);
    expect(CONDUCTOR_TOOLSET.filter((t) => PROIBIDAS_AO_CONDUTOR.includes(t))).toEqual([]);
    expect(CONDUCTOR_TOOLSET.filter((t) => !real.has(t)).map((t) => `o conjunto conductor lista \`${t}\`, que não existe`)).toEqual([]);
  });
});

// ── harness-anchor: a skill da ÂNCORA (fase 7) ──────────────────────────────────────────────────────────────────────
//
// A âncora não roda numa coluna: o SERVIÇO a lança (runner/feature-anchor.ts → anchor-spawn.ts) com uma credencial que
// só escreve `feature`. O que a prende à realidade é a superfície MCP — o conjunto `anchor` (toolsets.ts) — e o contrato
// com o serviço: o `(card <id>)` no fim do contexto da pergunta (o serviço aplica a resposta por ele), a opção «Deixar em
// Outros», o `askedBy` e a linha final `ANCORA {...}` (o desfecho que o gatilho lê).
describe("harness-anchor — a âncora das funcionalidades do PRD", () => {
  const SKILL = "harness-anchor";
  const file = path.join(SKILLS_DIR, SKILL, "SKILL.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";

  it("existe e entra no lint de colunas das demais (o describe.each a enxerga)", () => {
    expect(text.length, "a skill harness-anchor sumiu").toBeGreaterThan(0);
    expect(skillDirs).toContain(SKILL);
  });

  it("toda tool citada existe e o conjunto `anchor` monta todas", async () => {
    const { ANCHOR_TOOLSET } = await import("@/lib/storymap/mcp/toolsets");
    const real = registeredToolNames();
    const cited = citedTools(text);
    expect(cited, "o extrator não achou as tools da âncora").toEqual(expect.arrayContaining(["update_card", "ask_question", "propose_change", "get_vocabulary"]));
    expect(cited.filter((t) => !real.has(t)).map((t) => `${SKILL}: cita \`${t}\`, que o servidor não monta`)).toEqual([]);
    expect(cited.filter((t) => !ANCHOR_TOOLSET.includes(t)).map((t) => `${SKILL}: manda usar \`${t}\`, fora do conjunto anchor`)).toEqual([]);
  });

  it("fala o contrato que o serviço lê (feature-anchor.ts): o card da pergunta, «Deixar em Outros», o askedBy e a linha ANCORA", async () => {
    const { ANCHOR_ASKED_BY, ANCHOR_LEAVE_OPTION } = await import("@/lib/storymap/runner/feature-anchor");
    expect(text).toContain("`(card <id>)`");
    expect(text).toContain(ANCHOR_LEAVE_OPTION);
    expect(text).toContain(`askedBy: "${ANCHOR_ASKED_BY}"`);
    expect(text).toMatch(/ANCORA \{"outros":\[/);
    expect(text).toMatch(/ONE grouped/);
    expect(text).toMatch(/ONLY `feature`/);
  });

  it("é GENÉRICA e é distribuída por sync_skills", () => {
    expect(productOrBoardNames(text)).toEqual([]);
    const tree = readSkillTrees(ROOT).find((t) => t.name === SKILL);
    expect(tree, `${SKILL} não está entre as skills que a ferramenta distribui`).toBeDefined();
  });
});

describe("as skills que criam ou reescrevem cards põem a funcionalidade (fase 7)", () => {
  it.each(["harness-capture", "harness-enrich", "harness-fix", "harness-sync-card", "harness-conductor"])("%s manda pôr `feature` pelo vocabulário, sem inventar", (skill) => {
    const t = [readFileSync(path.join(SKILLS_DIR, skill, "SKILL.md"), "utf8"), ...skillRefTexts(skill)].join("\n");
    expect(t).toMatch(/`feature`/);
    expect(t).toMatch(/`get_vocabulary` → `features`/);
  });
});
