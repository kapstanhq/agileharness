import { describe, expect, it } from "vitest";
import { checkArgv, coerceTargetProfile, expandTargetTemplate, resolveTargetProfile, targetProfileNote, type TargetProfile } from "./target-profile";
import { parseDeclaredArgv } from "./runner/deploy-command-guard";
import { buildContextNote } from "./runner/engine";
import { coerceRunnerSettings } from "./runner/config";
import type { BoardConfig } from "./types";

const PROFILE: TargetProfile = {
  checks: { test: "npm test --workspace {pkg}", typecheck: "npx tsc --noEmit -p {package}", validate: "make validate" },
  dev: { up: "npm run dev --workspace {pkg}", down: "make dev-down" },
  docs: { conventions: "{package}/CONVENTIONS.md", testing: "docs/testing.md", security: "docs/security.md" },
};
const SHOP = { board: "shop", package: "packages/shop" };

describe("o perfil do alvo — o que o repositório declara", () => {
  it("aceita os três blocos e descarta, peça a peça, o que não tem forma", () => {
    const p = coerceTargetProfile({
      checks: { test: "  npm test  ", "nome ruim": "x", vazio: "  ", numero: 3, comControle: "a\nb", longo: "x".repeat(301) },
      dev: { up: "npm run dev" },
      docs: { testing: "docs/testing.md", absoluto: "/etc/passwd", sobe: "../fora.md", espaco: "docs/minhas regras.md", aspas: 'docs/"x".md' },
    });
    expect(p).toEqual({ checks: { test: "npm test" }, dev: { up: "npm run dev" }, docs: { testing: "docs/testing.md" } });
  });

  it("sem nada aproveitável (ou sem o bloco) o alvo não declarou perfil", () => {
    for (const raw of [undefined, null, "x", [], {}, { checks: {} }, { docs: { a: "/abs" } }]) expect(coerceTargetProfile(raw)).toBeUndefined();
  });

  it("vem do settings.yaml pelo canal do operador, e some quando o arquivo não o declara", () => {
    expect(coerceRunnerSettings({ target: { checks: { test: "make test" } } }).target).toEqual({ checks: { test: "make test" }, dev: {}, docs: {} });
    expect(coerceRunnerSettings({}).target).toBeUndefined();
  });
});

describe("os moldes — {pkg}, {package}, {board}", () => {
  it("preenche com o pacote do board; uma chave que não é molde fica como está", () => {
    expect(expandTargetTemplate("npm test --workspace {pkg}", SHOP)).toBe("npm test --workspace shop");
    expect(expandTargetTemplate("{package}/CONVENTIONS.md", SHOP)).toBe("packages/shop/CONVENTIONS.md");
    expect(expandTargetTemplate("make test-{board}", SHOP)).toBe("make test-shop");
    expect(expandTargetTemplate("echo {outra}", SHOP)).toBe("echo {outra}");
    expect(expandTargetTemplate("make validate", { board: "shop" })).toBe("make validate");
  });

  it("nunca devolve um comando pela metade: board sem pacote, ou pacote/board que não é seguro, é null", () => {
    expect(expandTargetTemplate("npm test --workspace {pkg}", { board: "shop" })).toBeNull();
    expect(expandTargetTemplate("npm test --workspace {pkg}", { board: "shop", package: "packages/../etc" })).toBeNull();
    expect(expandTargetTemplate("npm test --workspace {pkg}", { board: "shop", package: 'packages/shop"; reboot' })).toBeNull();
    expect(expandTargetTemplate("make test-{board}", { board: "shop; reboot" })).toBeNull();
  });

  it("o perfil de um board deixa de fora o que não pôde ser preenchido", () => {
    expect(resolveTargetProfile(PROFILE, SHOP)).toEqual({
      checks: { test: "npm test --workspace shop", typecheck: "npx tsc --noEmit -p packages/shop", validate: "make validate" },
      dev: { up: "npm run dev --workspace shop", down: "make dev-down" },
      docs: { conventions: "packages/shop/CONVENTIONS.md", testing: "docs/testing.md", security: "docs/security.md" },
    });
    const noPkg = resolveTargetProfile(PROFILE, { board: "ideias" });
    expect(noPkg.checks).toEqual({ validate: "make validate" });
    expect(noPkg.docs).toEqual({ testing: "docs/testing.md", security: "docs/security.md" });
    expect(resolveTargetProfile(undefined, SHOP)).toEqual({ checks: {}, dev: {}, docs: {} });
  });
});

describe("rodar um check declarado — lista de palavras, sem shell", () => {
  it("o check declarado vira argv preenchida com o pacote do board", () => {
    expect(checkArgv(PROFILE, SHOP, "test", parseDeclaredArgv)).toEqual({ argv: ["npm", "test", "--workspace", "shop"] });
  });

  it("recusa com a frase: check não declarado (dizendo os que há), alvo sem perfil, board sem pacote, sintaxe de shell", () => {
    expect(checkArgv(PROFILE, SHOP, "e2e", parseDeclaredArgv)).toMatchObject({ refusal: expect.stringMatching(/não declara o check "e2e".*test, typecheck, validate/) });
    expect(checkArgv(undefined, SHOP, "test", parseDeclaredArgv)).toMatchObject({ refusal: expect.stringMatching(/não declara nenhum check/) });
    expect(checkArgv(PROFILE, { board: "ideias" }, "test", parseDeclaredArgv)).toMatchObject({ refusal: expect.stringMatching(/não mapeia um pacote/) });
    const chained: TargetProfile = { checks: { test: "npm test && npm run lint" }, dev: {}, docs: {} };
    expect(checkArgv(chained, SHOP, "test", parseDeclaredArgv)).toMatchObject({ refusal: expect.stringMatching(/sintaxe de shell/) });
  });

  it("subir o ambiente e publicar não são checks: só as chaves de `checks` rodam", () => {
    expect(checkArgv(PROFILE, SHOP, "up", parseDeclaredArgv)).toMatchObject({ refusal: expect.stringMatching(/não declara o check "up"/) });
  });
});

describe("a nota do perfil no prompt do agente", () => {
  it("aponta os documentos e NOMEIA os checks — o texto de um comando nunca entra", () => {
    const note = targetProfileNote(resolveTargetProfile(PROFILE, SHOP));
    expect(note).toContain("testes: docs/testing.md");
    expect(note).toContain("segurança: docs/security.md");
    expect(note).toContain("checks: test, typecheck, validate");
    expect(note).toContain("dev: up, down");
    expect(note).not.toMatch(/npm|make|tsc/);
    expect(note).not.toMatch(/["'`$]/); // atravessa um prompt entre aspas
    expect(targetProfileNote({ checks: {}, dev: {}, docs: {} })).toBeNull();
  });

  it("com perfil, a nota do run aponta as convenções DECLARADAS; sem perfil, o caminho de sempre", () => {
    const board = { id: "shop", name: "Shop", package: "packages/shop" } as unknown as BoardConfig;
    const declared = buildContextNote(board, { board: "shop", targetProfile: PROFILE });
    expect(declared).toContain("leia packages/shop/CONVENTIONS.md");
    expect(declared).not.toContain(".claude/CLAUDE.md");
    expect(declared).toContain("Perfil do alvo:");
    expect(declared).toContain("testes: docs/testing.md");
    const legacy = buildContextNote(board, { board: "shop" });
    expect(legacy).toContain("leia packages/shop/.claude/CLAUDE.md");
    expect(legacy).not.toContain("Perfil do alvo");
  });
});
