import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { findRepoRoot } from "@/lib/storymap/paths";
import { mergeRawConfig } from "@/lib/storymap/repo";
import { STORY_TYPE_IDS } from "@/lib/storymap/frameworks";
import { inheritingBoards, optOutBoards, pipelineBoards } from "@/lib/storymap/board-fixture";

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
// migrated in Fase 5 / ADR-057, dropping `inheritPipeline:false`), while `orbit` still opts out
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
  return m ? m[1] : "";
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

    // COLETA-ENTÃO-ASSERTA, e não `expect` dentro do laço. MEDIDO (2026-08-12, com
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

    // AC2 — ERA warn-only, e virou CATRACA (2026-08-12).
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
