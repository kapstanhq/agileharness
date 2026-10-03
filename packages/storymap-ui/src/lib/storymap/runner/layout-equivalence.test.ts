// LOTE D (layout) — um alvo que DECLARA o seu layout: o código não supõe pastas; tudo sai do settings.
//
// Repositório INVENTADO (uma cooperativa de entregas): os módulos moram em `modules/<m>`, cada um com uma camada
// `client` e/ou `server`, o branch de integração chama `integracao` e há um prefixo de código extra fora dos módulos
// (`infra/scripts/`). Este arquivo prova, lendo o settings pelo caminho de PRODUÇÃO (`loadRunnerConfig` sobre um alvo
// temporário, não um objeto montado à mão), que:
//   · o plano de links de worktree segue os globs de `target.layout.workspaces` (e só eles);
//   · a régua de código, o branch de integração e o pacote de um snapshot saem do settings;
//   · a suíte padrão do gate declarada chega ao runner.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetRepoRootCache } from "@/lib/storymap/paths";
import { layoutOf } from "@/lib/storymap/target-profile";
import { loadRunnerConfig } from "./config";
import { packageDirOf, verificationDemand } from "./merge-queue";
import { declaredCodePrefixes, partitionPaths, stagingBranchOf } from "./staging";
import { defaultWorktreeFs, planNodeModulesLinks } from "./worktree";

const SETTINGS_DA_COOPERATIVA = [
  "target:",
  "  layout:",
  '    packages: ["modules/*"]',
  '    workspaces: ["modules/*/client", "modules/*/server"]',
  "autorun:",
  "  mergeGate:",
  "    scope:",
  "      fallback:",
  "        cwd: modules/rotas",
  "        command: bun test --bail",
  "  staging:",
  "    enabled: true",
  "    branch: integracao",
  "    codePrefixes: [modules/, infra/scripts/]",
  "",
].join("\n");

describe("alvo que DECLARA o layout — tudo sai do settings", () => {
  let tmp: string;
  let alvoAnterior: string | undefined;

  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ah-equiv-"));
    await fsp.mkdir(path.join(tmp, "storymap", "boards", "entregas"), { recursive: true });
    await fsp.writeFile(path.join(tmp, "storymap", "settings.yaml"), SETTINGS_DA_COOPERATIVA, "utf8");
    // O repositório: três módulos, camadas client/server, node_modules (gitignored — só existem no disco do checkout principal).
    const mk = (rel: string) => fsp.mkdir(path.join(tmp, rel), { recursive: true });
    for (const rel of [
      "node_modules",
      "modules/rotas/client/node_modules",
      "modules/rotas/server/node_modules",
      "modules/rotas/node_modules", // o módulo em si NÃO é workspace aqui: fica de fora
      "modules/frota/server/node_modules",
      "modules/frota/server/assets", // não é node_modules
      "modules/caixa/client",
      "infra/scripts",
    ]) {
      await mk(rel);
    }
    alvoAnterior = process.env.AGILEHARNESS_TARGET;
    process.env.AGILEHARNESS_TARGET = tmp;
    resetRepoRootCache();
  });

  afterAll(async () => {
    if (alvoAnterior === undefined) delete process.env.AGILEHARNESS_TARGET;
    else process.env.AGILEHARNESS_TARGET = alvoAnterior;
    resetRepoRootCache();
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("o settings declarado chega inteiro a `layoutOf` (workspaces, packages, branch e prefixos)", () => {
    expect(layoutOf(loadRunnerConfig())).toEqual({
      workspaces: ["modules/*/client", "modules/*/server"],
      packages: ["modules/*"],
      stagingBranch: "integracao",
      codePrefixes: ["modules/", "infra/scripts/"],
    });
  });

  it("[PRODUÇÃO] o plano de links de worktree — lido do settings, sem argumento — segue SÓ os globs declarados", async () => {
    const wt = "/wt-entregas";
    const plano = (await planNodeModulesLinks(defaultWorktreeFs, tmp, wt)).map((l) => l.linkPath).sort();
    expect(plano).toEqual(
      [
        path.join(wt, "node_modules"),
        path.join(wt, "modules/frota/server/node_modules"),
        path.join(wt, "modules/rotas/client/node_modules"),
        path.join(wt, "modules/rotas/server/node_modules"),
      ].sort(),
    );
  });

  it("o branch de integração e a régua de código do train saem do settings", () => {
    const staging = loadRunnerConfig().autorun.staging;
    expect(stagingBranchOf(staging)).toBe("integracao");
    const prefixos = declaredCodePrefixes(staging);
    expect(prefixos).toEqual(["modules/", "infra/scripts/"]);
    const arquivos = ["storymap/boards/entregas/cards/story-ex9968.md", "modules/rotas/server/mapa.ts", "infra/scripts/podar.sh", "docs/guia.md"];
    expect(partitionPaths(arquivos, prefixos)).toEqual({
      code: ["modules/rotas/server/mapa.ts", "infra/scripts/podar.sh"],
      data: ["storymap/boards/entregas/cards/story-ex9968.md", "docs/guia.md"],
    });
    expect(verificationDemand(["storymap/boards/entregas/cards/story-ex9968.md"], prefixos).needsVerification).toBe(false);
    expect(verificationDemand(["infra/scripts/podar.sh"], prefixos).needsVerification).toBe(true);
  });

  it("o pacote de um snapshot sai de `target.layout.packages`", () => {
    const globs = layoutOf(loadRunnerConfig()).packages ?? [];
    const esperado: Array<[string, string | null]> = [
      ["modules/rotas/server/__snapshots__/mapa.snap", "modules/rotas"],
      ["modules/caixa/client/x.snap", "modules/caixa"],
      ["infra/scripts/x.snap", null],
      ["README.md", null],
    ];
    for (const [f, pkg] of esperado) expect(packageDirOf(f, globs), f).toBe(pkg);
  });

  it("a suíte padrão do gate declarada (`mergeGate.scope.fallback`) chega ao runner", () => {
    expect(loadRunnerConfig().autorun.mergeGate?.scope?.fallback).toMatchObject({ cwd: "modules/rotas", command: "bun test --bail" });
  });
});
