import { describe, expect, it } from "vitest";
import fs from "node:fs";
import yaml from "js-yaml";
import {
  mergeRawById,
  mergeRawConfig,
  readBoardConfig,
  listBoards,
  coerceStatuses,
  deriveBoardConfigForPersist,
} from "./repo";
import { boardConfigPath, baseBoardConfigPath } from "./paths";
import { releaseModeOf, withDerivedDeployAutorun } from "./release-policy";
import { inheritingBoards, optOutBoards } from "./board-fixture";

/** The RAW (un-merged) board.yaml — what the board AUTHORS on disk, before _base inheritance. */
function rawBoard(boardId: string): Record<string, unknown> {
  return (yaml.load(fs.readFileSync(boardConfigPath(boardId), "utf8")) ?? {}) as Record<string, unknown>;
}
/** The RAW _base template. */
function rawBase(): Record<string, unknown> {
  return (yaml.load(fs.readFileSync(baseBoardConfigPath(), "utf8")) ?? {}) as Record<string, unknown>;
}

// B5 — board inheritance (boards/_base). readBoardConfig deep-merges _base UNDER each board, so a
// board declares only its deltas ("novo board = id + deltas"). These cover the merge semantics
// (synthetic) and prove the live boards still resolve the shared linkTypes via inheritance after
// the extraction (Increment 1) — with the identity property that an ABSENT base is a no-op.

describe("mergeRawById — base order + per-id override + append", () => {
  const base = [
    { id: "a", name: "A", v: 1 },
    { id: "b", name: "B", v: 2 },
  ];

  it("preserves BASE order and shallow-overrides a same-id board item", () => {
    const out = mergeRawById(base, [{ id: "b", v: 99, extra: true }]);
    expect(out).toEqual([
      { id: "a", name: "A", v: 1 },
      { id: "b", name: "B", v: 99, extra: true }, // board fields win, base fields fill
    ]);
  });

  it("appends board-only items in order, after the base", () => {
    const out = mergeRawById(base, [{ id: "c", name: "C" }]);
    expect(out).toEqual([base[0], base[1], { id: "c", name: "C" }]);
  });

  it("no board → base unchanged; no base → board unchanged", () => {
    expect(mergeRawById(base, undefined)).toEqual(base);
    expect(mergeRawById(undefined, base)).toEqual(base);
    expect(mergeRawById([], [{ id: "x" }])).toEqual([{ id: "x" }]);
  });
});

describe("mergeRawConfig — pipeline merges by id, vocab is board-wins-else-base", () => {
  const base = {
    statuses: [{ id: "s1", trigger: "t1" }, { id: "s2" }],
    columns: [{ id: "c1" }],
    linkTypes: [{ id: "rel" }],
    personas: [{ id: "basePersona" }],
  };

  it("null base is the IDENTITY on the board (no _base → byte-identical load)", () => {
    const board = { id: "b", statuses: [{ id: "x" }] };
    expect(mergeRawConfig(null, board)).toBe(board);
  });

  it("inherits linkTypes when the board omits them; board personas win outright", () => {
    const merged = mergeRawConfig(base, { id: "b", personas: [{ id: "ownPersona" }] });
    expect(merged.linkTypes).toEqual([{ id: "rel" }]); // inherited
    expect(merged.personas).toEqual([{ id: "ownPersona" }]); // board wins
  });

  it("merges statuses by id: inherits the pipeline, overrides one step", () => {
    const merged = mergeRawConfig(base, { id: "b", statuses: [{ id: "s1", trigger: "t1-override" }, { id: "s3" }] });
    expect(merged.statuses).toEqual([
      { id: "s1", trigger: "t1-override" },
      { id: "s2" },
      { id: "s3" },
    ]);
  });

  it("inheritPipeline:false makes the board OWN its pipeline (no union with base)", () => {
    const merged = mergeRawConfig(base, {
      id: "b",
      inheritPipeline: false,
      statuses: [{ id: "own1" }, { id: "own2" }],
    });
    expect(merged.statuses).toEqual([{ id: "own1" }, { id: "own2" }]); // base s1/s2 NOT inherited
    expect(merged.columns).toBeUndefined(); // board declared none → stays undefined (not base's c1)
    expect(merged.linkTypes).toEqual([{ id: "rel" }]); // vocab still inherited regardless of the flag
  });

  // WS4 — routeProfiles follow the pipeline opt-out (they REFERENCE steps); specialists (agnostic registry)
  // inherit for all. This gating is why deriveBoardConfigForPersist must persist an opt-out board's
  // routeProfiles WHOLE (a diff-against-base would drop identical ones, and the opt-out read never re-inherits).
  it("WS4: routeProfiles are gated by inheritPipeline; specialists inherit for all", () => {
    const wsBase = { routeProfiles: { express: { skips: [] } }, specialists: { sec: { agent: "x", when: "y" } } };
    const inheriting = mergeRawConfig(wsBase, { id: "i" });
    expect(inheriting.routeProfiles).toEqual({ express: { skips: [] } }); // inherited
    expect(inheriting.specialists).toEqual({ sec: { agent: "x", when: "y" } });
    const optOut = mergeRawConfig(wsBase, { id: "o", inheritPipeline: false });
    expect(optOut.routeProfiles).toBeUndefined(); // NOT inherited (its own pipeline lacks the steps)
    expect(optOut.specialists).toEqual({ sec: { agent: "x", when: "y" } }); // registry still inherits
  });
});

// R1 / B5 incr. 2 — the canonical Stage→Step pipeline lives in boards/_base. The `storymap` board
// (its origin) inherits it with zero delta; product boards `acme`/`orbit` keep their own older
// pipeline via `inheritPipeline:false`. (The byte-identity of every RESOLVED config across this move
// is proven separately by board-base-pipeline.test.ts's golden snapshots.)
describe("canonical pipeline in _base (R1) — storymap inherits, product boards opt out", () => {
  // steps that exist ONLY in the canonical _base pipeline, never in the product pipeline.
  const CANONICAL_ONLY = ["grill", "interview", "design-ui", "ready", "merge", "stage", "release", "deploy"];

  it("o board.yaml que HERDA carrega SÓ deltas mínimos por passo — nunca re-inlina a pipeline do _base", () => {
    for (const board of inheritingBoards()) {
    const raw = rawBoard(board);
    // It inherits the canonical pipeline from _base. It MAY tune a step's operational facets
    // (autorun/model/effort — exactly what the kanban toggles persist; e.g. storymap opts its own
    // code-gen steps into full autonomy), but each such delta must be MINIMAL: an { id, ...facet }
    // object, NEVER a re-inlined full step (which carries name/description/column and would sever
    // future _base propagation). See audit #9.
    for (const s of (raw.statuses as Array<Record<string, unknown>>) ?? []) {
      expect(Object.keys(s), "delta must carry an id").toContain("id");
      expect(Object.keys(s), `delta must be minimal, not a re-inlined full step: ${JSON.stringify(s)}`)
        .not.toContain("name");
    }
    expect(raw.columns, "never re-inlines _base's columns").toBeUndefined();
    expect(raw.linkTypes, "never re-inlines _base's linkTypes").toBeUndefined();
    expect(raw.inheritPipeline).toBeUndefined(); // not opted out → it inherits
    expect(raw.releases).toBeDefined(); // but it DOES keep its own vocab deltas
    }
  });

  it("o board que herda RESOLVE a pipeline canônica Stage→Step (steps + columns) a partir do _base", async () => {
    for (const board of inheritingBoards()) {
    const cfg = await readBoardConfig(board);
    expect(cfg.statuses.map((s) => s.id)).toEqual(expect.arrayContaining(CANONICAL_ONLY));
    // 6-column redesign: the old `todo`/`ready`/`in-progress` columns collapsed — `pronta` joined
    // `discovery` (its go/no-go exit) and `ready`+the dev steps merged into a single `construcao`
    // column. ADR-059 entrega colapsada keeps the `entrega` column (per-card delivery stepper over its
    // 5 laneStep steps). The `reentry` ColumnDef stays (its statuses reference it) but never renders —
    // story-ql5mjm made refinar/corrigir/descontinuar all `hidden`, eliminating the Reabertura column.
    expect(cfg.columns?.map((c) => c.id)).toEqual([
      "backlog", "discovery", "prepare", "construcao", "entrega", "live", "reentry", "archive",
    ]);
    }
  });

  it("o board OPT-OUT mantém a pipeline própria (nenhum passo canônico-exclusivo vaza para ele)", async () => {
    for (const board of optOutBoards()) {
      expect(rawBoard(board).inheritPipeline, `${board} precisa optar por sair`).toBe(false);
      const cfg = await readBoardConfig(board);
      const ids = new Set(cfg.statuses.map((s) => s.id));
      for (const only of CANONICAL_ONLY) {
        expect(ids.has(only), `${board} NÃO pode herdar o passo canônico-exclusivo \`${only}\``).toBe(false);
      }
      expect(cfg.columns, `${board} não tem colunas de estágio`).toBeUndefined();
    }
  });

  it("o board que HERDA resolve as colunas canônicas (sem opt-out declarado)", async () => {
    for (const board of inheritingBoards()) {
      expect(rawBoard(board).inheritPipeline, `${board} não opta por sair`).toBeUndefined();
      const cfg = await readBoardConfig(board);
      const ids = new Set(cfg.statuses.map((s) => s.id));
      for (const only of CANONICAL_ONLY) {
        expect(ids.has(only), `${board} tem de herdar o passo canônico \`${only}\``).toBe(true);
      }
      expect(cfg.columns?.map((c) => c.id), `${board} resolve as colunas canônicas`).toEqual([
        "backlog", "discovery", "prepare", "construcao", "entrega", "live", "reentry", "archive",
      ]);
    }
  });
});

// R1 hardening — the save-back path. The UI server actions hand writeBoardConfig the FULLY RESOLVED
// config; deriveBoardConfigForPersist strips it back to the board's deltas so a save does NOT (a)
// re-inline _base's canonical pipeline into storymap/board.yaml (reverting R1 + severing future
// _base propagation) nor (b) drop an opt-out board's inheritPipeline:false (silently triggering
// Fase 5). Caught by the adversarial review of R1.
describe("deriveBoardConfigForPersist — a save round-trips to deltas, never re-inlines _base", () => {
  it("storymap (inherits): a save strips the resolved pipeline back to MINIMAL deltas, never re-inlines _base", async () => {
    for (const board of inheritingBoards()) {
    const persisted = await deriveBoardConfigForPersist(board, await readBoardConfig(board));
    // The resolved config carries the full 27-status pipeline; the persist path must reduce it back to
    // the board's own deltas. Any surviving status delta must be MINIMAL (id + facet), never a
    // re-inlined full step — otherwise a save would shadow _base forever (the bug this guards).
    for (const s of (persisted.statuses as Array<Record<string, unknown>>) ?? []) {
      expect(Object.keys(s), `persisted delta must be minimal, not a re-inline: ${JSON.stringify(s)}`)
        .not.toContain("name");
    }
    expect(persisted.columns, "must NOT re-inline the inherited 11 columns").toBeUndefined();
    expect(persisted.linkTypes, "linkTypes are inherited → omitted").toBeUndefined();
    expect(persisted.inheritPipeline, "storymap does not opt out").toBeUndefined();
    expect(persisted.releases, "but keeps its own vocab").toBeDefined();
    expect(persisted.personas).toBeDefined();
    expect(persisted.systems).toBeDefined();
    }
  });

  it("o board OPT-OUT: PRESERVA inheritPipeline:false + a pipeline própria inteira (sem Fase 5 silenciosa)", async () => {
    for (const board of optOutBoards()) {
      const persisted = await deriveBoardConfigForPersist(board, await readBoardConfig(board));
      expect(persisted.inheritPipeline, `${board} tem de manter a flag de opt-out`).toBe(false);
      expect((persisted.statuses as unknown[])?.length ?? 0, `${board} é dono da própria pipeline`).toBeGreaterThan(0);
      expect(persisted.columns, `${board} não tem colunas`).toBeUndefined();
    }
  });

  it("round-trips LOSSLESSLY: re-resolving the persisted delta reproduces the resolved pipeline", async () => {
    const baseRaw = rawBase();
    for (const b of await listBoards()) {
      const config = await readBoardConfig(b.id);
      const persisted = await deriveBoardConfigForPersist(b.id, config);
      // A re-resolução tem de espelhar o PIPELINE INTEIRO de readBoardConfig, e ele ganhou um estágio:
      // o `autorun` do passo Publicar é DERIVADO de `release.mode` (nunca autorado, e por isso também
      // nunca persistido). Sem `withDerivedDeployAutorun` aqui o teste compararia a resolução completa
      // contra uma resolução pela metade — e cobraria do persist justamente o campo que ele tem o dever
      // de NÃO gravar. O invariante segue idêntico: delta persistido + mesma resolução = mesmo resultado.
      const merged = mergeRawConfig(baseRaw, persisted);
      const reResolved = withDerivedDeployAutorun(
        coerceStatuses(merged.statuses),
        releaseModeOf(merged as Parameters<typeof releaseModeOf>[0]),
      );
      expect(reResolved, `${b.id} statuses must survive a save round-trip unchanged`).toEqual(config.statuses);
    }
  });

  it("o `autorun` derivado do passo Publicar NUNCA é persistido — nem quando difere do _base", async () => {
    // O board sujeito é `release.mode: auto` ⇒ resolve com autorun:true enquanto o _base tem false. Sem
    // a poda no persist, um save gravaria `autorun: true` no board.yaml: a segunda verdade de volta,
    // agora congelada em disco e sobrevivendo a uma troca futura do modo.
    const board = inheritingBoards()[0];
    const config = await readBoardConfig(board);
    expect(config.statuses.find((s) => s.id === "deploy")?.autorun, `${board} resolve auto`).toBe(true);
    const persisted = await deriveBoardConfigForPersist(board, config);
    const step = ((persisted.statuses as Array<Record<string, unknown>>) ?? []).find((s) => s.id === "deploy");
    expect(step && "autorun" in step, "o passo deploy não pode levar `autorun` para o yaml").toBeFalsy();
  });

  it("audit #9 — a per-step override persists ONLY the changed key, so a later _base change still propagates", async () => {
    const board = inheritingBoards()[0];
    const config = await readBoardConfig(board);
    // Pick a triggered step the board does NOT already override, so flipping its `autorun` ADDS exactly
    // one fresh delta — exactly what the kanban autorun toggle does on the inheriting storymap board
    // (the per-step config edit that used to re-inline the whole _base step).
    const alreadyOverridden = new Set(
      ((rawBoard(board).statuses as Array<{ id: string }>) ?? []).map((s) => s.id),
    );
    const target = config.statuses.find((s) => s.trigger && !alreadyOverridden.has(s.id))!;
    const flipped = {
      ...config,
      statuses: config.statuses.map((s) => (s.id === target.id ? { ...s, autorun: !s.autorun } : s)),
    };

    const persisted = await deriveBoardConfigForPersist(board, flipped);
    const deltas = (persisted.statuses as Array<Record<string, unknown>>) ?? [];

    // (1) MINIMAL: the flipped step persists as ONLY { id, autorun }, and EVERY surviving delta stays
    // minimal (id + facet) — never a re-inlined full step.
    const targetDelta = deltas.find((d) => d.id === target.id)!;
    expect(targetDelta).toEqual({ id: target.id, autorun: !target.autorun });
    for (const d of deltas) {
      expect(Object.keys(d), `delta must be minimal, not a re-inline: ${JSON.stringify(d)}`).not.toContain("name");
    }

    // (2) PROPAGATION: a later canonical change to a DIFFERENT field of the SAME step in _base still
    // reaches the board (the old full-step inline would have shadowed it forever).
    const modifiedBase = JSON.parse(JSON.stringify(rawBase())) as { statuses: Array<Record<string, unknown>> };
    modifiedBase.statuses.find((s) => s.id === target.id)!.description = "DESCRIÇÃO CANÔNICA NOVA";
    const reResolved = coerceStatuses(mergeRawConfig(modifiedBase, persisted).statuses).find((s) => s.id === target.id)!;
    expect(reResolved.description, "the _base change propagated past the board override").toBe("DESCRIÇÃO CANÔNICA NOVA");
    expect(reResolved.autorun, "AND the board's own override is preserved").toBe(!target.autorun);
  });
});

describe("board inheritance — live boards resolve shared linkTypes via _base", () => {
  // story-sbfutw: 4 legados (sem from/to) + 5 tipados (estratégia↔entrega).
  const EXPECTED = [
    { id: "depends-on", name: "Depende de" },
    { id: "relates-to", name: "Relacionado a" },
    { id: "blocks", name: "Bloqueia" },
    { id: "duplicates", name: "Duplica" },
    { id: "serves", name: "Serve", from: ["canvas", "inputMetric"], to: ["desiredOutcome"] },
    { id: "references", name: "Referencia", from: ["canvas"], to: ["persona", "release", "idea", "activity"] },
    { id: "moves", name: "Move", from: ["idea"], to: ["inputMetric"] },
    { id: "addresses", name: "Endereça", from: ["story"], to: ["idea"] },
    { id: "targets", name: "Mira", from: ["story", "idea"], to: ["persona"] },
  ];

  it("every board inherits the 9 canonical linkTypes (4 legados + 5 tipados) via _base", async () => {
    const boards = await listBoards();
    expect(boards.length).toBeGreaterThan(0);
    for (const b of boards) {
      const cfg = await readBoardConfig(b.id);
      expect(cfg.linkTypes).toEqual(EXPECTED);
    }
  });

  it("listBoards SKIPS the _base template (it is not a board)", async () => {
    const boards = await listBoards();
    expect(boards.map((b) => b.id)).not.toContain("_base");
    expect(boards.map((b) => b.id)).not.toContain("base");
  });
});

// salvage (endgame §5.4a) — a metade "devolver o card DISPARA a coluna", provada no board REAL do incidente.
// Doutrina do Autônomo (copilot/tier.ts): defeito real que cabe no escopo do card ⇒ "devolva o PRÓPRIO card
// para `desenvolver`". Isso só conserta alguma coisa se a coluna de destino DISPARAR o harness-* headless que
// escreve o fix — no acme (o único board autônomo), `desenvolver` herda `trigger: harness-do` do _base e liga
// `autorun: true` no delta, e moveRiskClass classifica o move como `run` (o move É o disparo). Se este teste
// quebrar, a doutrina manda o card para uma coluna que não dispara nada — o bug é do roteamento (board.yaml
// ou entry-effect), não deste teste.
describe("doutrina de resolução × board real — devolver o card para `desenvolver` dispara o run", () => {
  it("desenvolver: autorun herdado+ligado, trigger harness-do, e o move de volta classifica como `run`", async () => {
    const { entryEffect, moveRiskClass } = await import("./entry-effect");
    const board = inheritingBoards()[0];
    const cfg = await readBoardConfig(board);
    const dev = cfg.statuses.find((s) => s.id === "desenvolver");
    expect(dev, `o board ${board} precisa ter a coluna \`desenvolver\``).toBeTruthy();
    expect(dev?.autorun, "desenvolver precisa ser autorun (o delta do board liga)").toBe(true);
    expect(dev?.trigger, "desenvolver precisa ter trigger (herdado do _base)").toBe("harness-do");
    // o move de volta (revisar-codigo → desenvolver, o caminho exato da doutrina) é um DISPARO de run…
    expect(moveRiskClass(cfg, "desenvolver", "revisar-codigo")).toBe("run");
    // …e não um efeito onEnter de deploy (a classificação certa importa: `deploy` pediria outro guard).
    expect(entryEffect(cfg, "desenvolver", "revisar-codigo")).toBeNull();
  });
});
