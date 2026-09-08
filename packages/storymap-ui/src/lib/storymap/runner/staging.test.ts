import { describe, expect, it } from "vitest";
import { partitionPaths, pathsTouchCode, promoteImportedDataPaths } from "./staging";

const PREFIXES = ["packages/"];

describe("pathsTouchCode — Fase 4a routing predicate", () => {
  it("returns false for a board-data-only run (the common ~93% case) → merges to main", () => {
    expect(
      pathsTouchCode(["storymap/boards/storymap/cards/story-x.md"], PREFIXES),
    ).toBe(false);
  });

  it("returns false for a skills/docs-only run (.claude/**, docs/**) → still main", () => {
    expect(
      pathsTouchCode([".claude/skills/harness-do/SKILL.md", "docs/adr/ADR-099.md"], PREFIXES),
    ).toBe(false);
  });

  it("returns true when ANY path is under a code prefix → routes code to stage", () => {
    expect(
      pathsTouchCode(
        ["storymap/boards/acme/cards/story-y.md", "packages/acmeapp/src/feature.ts"],
        PREFIXES,
      ),
    ).toBe(true);
  });

  it("matches the storymap-ui tool's own code (packages/storymap-ui/**)", () => {
    expect(pathsTouchCode(["packages/storymap-ui/src/lib/x.ts"], PREFIXES)).toBe(true);
  });

  it("an empty codePrefixes list means nothing is code → always main (staging inert)", () => {
    expect(pathsTouchCode(["packages/acmeapp/src/x.ts"], [])).toBe(false);
  });

  it("does not false-positive on a path that merely CONTAINS the prefix mid-string", () => {
    // "packages/" must be a PREFIX, not a substring — a file literally named with it elsewhere is data.
    expect(pathsTouchCode(["storymap/boards/x/cards/about-packages-md.md"], PREFIXES)).toBe(false);
  });

  it("honours multiple code prefixes", () => {
    expect(pathsTouchCode(["functions/index.ts"], ["packages/", "functions/"])).toBe(true);
  });
});

describe("partitionPaths — split a run's diff into code (→stage) and data (→main)", () => {
  it("splits a mixed run by prefix, preserving order within each side", () => {
    const { code, data } = partitionPaths(
      [
        "storymap/boards/acme/cards/story.md",
        "packages/acmeapp/src/a.ts",
        ".claude/skills/harness-do/SKILL.md",
        "packages/acmeapp/src/b.ts",
      ],
      PREFIXES,
    );
    expect(code).toEqual(["packages/acmeapp/src/a.ts", "packages/acmeapp/src/b.ts"]);
    expect(data).toEqual([
      "storymap/boards/acme/cards/story.md",
      ".claude/skills/harness-do/SKILL.md",
    ]);
  });

  it("a board-data-only run partitions to all-data, empty-code (→ unchanged main merge)", () => {
    const { code, data } = partitionPaths(["storymap/boards/x/cards/y.md"], PREFIXES);
    expect(code).toEqual([]);
    expect(data).toEqual(["storymap/boards/x/cards/y.md"]);
  });

  it("an empty codePrefixes list puts everything in data (→ all to main)", () => {
    const { code, data } = partitionPaths(["packages/x/a.ts", "storymap/y.md"], []);
    expect(code).toEqual([]);
    expect(data).toEqual(["packages/x/a.ts", "storymap/y.md"]);
  });
});

/**
 * Artefatos DERIVADOS de board-data que MORAM sob um codePrefix (medido em produção, 2026-07-20).
 *
 * O golden `board-base-pipeline.test.ts.snap` fotografa a config resolvida dos boards: a FONTE dele é
 * `storymap/boards/**` (metade DADOS → main), o CAMINHO dele é `packages/**` (metade CÓDIGO → stage).
 * Roteado pelo caminho, o par se parte, e as duas metades ficam ERRADAS ao mesmo tempo:
 *
 *   - em `stage` a regeneração roda contra o board.yaml ANTIGO (stage herda board-data de main) e
 *     reproduz o golden antigo ⇒ a mudança é descartada, o verificador de aterrissagem (#38) vê "sem
 *     delta" e culpa a sessão com "código NÃO aterrissou (flag falsa)" → `returned-to-session`;
 *   - em `main` o board.yaml novo pousa SEM o golden ⇒ a suíte de main fica VERMELHA (medido), e o
 *     gate do train é fail-closed ⇒ congela a fila inteira.
 *
 * A regra estrutural: um derivado acompanha a FONTE de que deriva, nunca o próprio caminho. Declarado
 * na SPEC (`settings.yaml staging.dataDerived`), porque QUAIS artefatos derivam de dados é fato do
 * repositório consumidor — o mecanismo aqui é agnóstico.
 */
describe("partitionPaths — derivado de dados acompanha a FONTE, não o caminho", () => {
  const GOLDEN = "packages/storymap-ui/src/lib/storymap/__snapshots__/board-base-pipeline.test.ts.snap";
  const DERIVED = [GOLDEN];

  it("manda o golden derivado de board-data para DATA, mesmo morando sob packages/", () => {
    const { code, data } = partitionPaths(
      ["storymap/boards/_base/board.yaml", GOLDEN],
      PREFIXES,
      DERIVED,
    );
    // O PONTO: sem isto o golden ia para `code`, regenerava contra a fonte errada e nunca pousava.
    expect(code).toEqual([]);
    expect(data).toEqual(["storymap/boards/_base/board.yaml", GOLDEN]);
  });

  it("não contamina código de verdade: o .ts continua em code, só o derivado migra", () => {
    const { code, data } = partitionPaths(
      ["packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts", GOLDEN],
      PREFIXES,
      DERIVED,
    );
    expect(code).toEqual(["packages/storymap-ui/src/lib/storymap/runner/merge-queue.ts"]);
    expect(data).toEqual([GOLDEN]);
  });

  it("um golden derivado de CÓDIGO (não declarado) segue em code — a regra é declarativa, não 'todo .snap'", () => {
    const codeGolden = "packages/acmeapp/tests/unit/web/__snapshots__/jsonld-builders.test.ts.snap";
    const { code, data } = partitionPaths([codeGolden], PREFIXES, DERIVED);
    expect(code).toEqual([codeGolden]);
    expect(data).toEqual([]);
  });

  it("sem declaração nenhuma, o particionamento é BYTE-IDÊNTICO ao de hoje (nada muda por acidente)", () => {
    const paths = ["storymap/boards/_base/board.yaml", GOLDEN, "packages/x/a.ts"];
    expect(partitionPaths(paths, PREFIXES, [])).toEqual(partitionPaths(paths, PREFIXES));
  });
});

describe("promoteImportedDataPaths — o que o código IMPORTA viaja com o código", () => {
  // O incidente real (2026-07-22): um commit adicionou `scripts/vitest/workspace-fs-allow.mjs` e os 4
  // `vitest.config.ts` que o importam. `codePrefixes: [packages/]` mandou os configs para stage e o
  // helper para main — stage ficou com 4 configs importando um arquivo ausente (ERR_MODULE_NOT_FOUND
  // no load), e worktree de run é cortado de stage, então quebraria o gate de todo run seguinte.
  const src = (files: Record<string, string>) => (p: string) => files[p] ?? null;

  it("promove o arquivo de dados que o código importa (o incidente do vitest.config)", () => {
    const code = ["packages/orbit/vitest.config.ts"];
    const data = ["scripts/vitest/workspace-fs-allow.mjs", "storymap/boards/x/cards/c1.md"];
    const result = promoteImportedDataPaths(
      code,
      data,
      src({
        "packages/orbit/vitest.config.ts":
          "import { workspaceFsAllow } from '../../scripts/vitest/workspace-fs-allow.mjs';",
      }),
    );

    expect(result.promoted).toEqual(["scripts/vitest/workspace-fs-allow.mjs"]);
    expect(result.code).toContain("scripts/vitest/workspace-fs-allow.mjs");
    expect(result.data).not.toContain("scripts/vitest/workspace-fs-allow.mjs");
    // O card segue sendo dado — a promoção não varre a metade inteira.
    expect(result.data).toContain("storymap/boards/x/cards/c1.md");
  });

  it("resolve especificador SEM extensão pelas formas que Node/TS aceitam", () => {
    const result = promoteImportedDataPaths(
      ["packages/app/a.ts"],
      ["tools/helper.ts"],
      src({ "packages/app/a.ts": "import x from '../../tools/helper';" }),
    );
    expect(result.promoted).toEqual(["tools/helper.ts"]);
  });

  it("é TRANSITIVO — o promovido que importa outro dado também leva o segundo", () => {
    const result = promoteImportedDataPaths(
      ["packages/app/a.ts"],
      ["tools/one.mjs", "tools/two.mjs"],
      src({
        "packages/app/a.ts": "import { one } from '../../tools/one.mjs';",
        "tools/one.mjs": "export { two } from './two.mjs';",
      }),
    );
    expect(result.promoted.sort()).toEqual(["tools/one.mjs", "tools/two.mjs"]);
    expect(result.data).toEqual([]);
  });

  it("NUNCA promove board data — se o código importa card, isso é defeito para o operador ver, não para mascarar", () => {
    const result = promoteImportedDataPaths(
      ["packages/app/a.ts"],
      ["storymap/boards/x/cards/c1.md"],
      src({ "packages/app/a.ts": "import c from '../../storymap/boards/x/cards/c1.md';" }),
    );
    expect(result.promoted).toEqual([]);
    expect(result.data).toEqual(["storymap/boards/x/cards/c1.md"]);
  });

  it("sem import cruzado, a partição fica IDÊNTICA (a regra não tem efeito colateral)", () => {
    const code = ["packages/app/a.ts"];
    const data = ["docs/guia.md", "storymap/boards/x/cards/c1.md"];
    const result = promoteImportedDataPaths(code, data, src({ "packages/app/a.ts": "export const a = 1;" }));

    expect(result.promoted).toEqual([]);
    expect(result.code).toEqual(code);
    expect(result.data).toEqual(data);
  });

  it("ignora import relativo que aponta para arquivo NÃO tocado pelo run", () => {
    const result = promoteImportedDataPaths(
      ["packages/app/a.ts"],
      ["docs/guia.md"],
      src({ "packages/app/a.ts": "import x from '../../tools/nao-mudou.mjs';" }),
    );
    expect(result.promoted).toEqual([]);
    expect(result.data).toEqual(["docs/guia.md"]);
  });
});
