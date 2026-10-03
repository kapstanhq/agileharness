import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_REVIEW_LENSES,
  QA_FAILURE_TEXT_TAIL_BYTES,
  checkArgv,
  coerceTargetProfile,
  coerceTargetProfileDetailed,
  currencyOf,
  expandTargetTemplate,
  hasNestedQuantifier,
  isLoopbackUrlWithPort,
  layoutOf,
  matchDeclaredFailureClass,
  qaOf,
  resolveTargetProfile,
  reviewLensIdsOf,
  reviewLensesOf,
  targetProfileNote,
  warnTargetDiscards,
  type TargetProfile,
} from "./target-profile";
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
  it("só as convenções são leitura obrigatória; os outros documentos são consulta — e o texto de um comando nunca entra", () => {
    const note = targetProfileNote(resolveTargetProfile(PROFILE, SHOP))!;
    expect(note).toContain("leia antes de agir os documentos do alvo — convenções: packages/shop/CONVENTIONS.md");
    // os demais vão por caminho, sem forçar a leitura (custo de contexto em TODO run headless)
    expect(note).toContain("consulte quando o trabalho pedir (não precisa ler tudo antes) — testes: docs/testing.md; segurança: docs/security.md");
    expect(note).not.toMatch(/leia antes de agir[^.]*testes:/);
    expect(note).toContain("checks: test, typecheck, validate");
    expect(note).toContain("dev: up, down");
    expect(note).not.toMatch(/npm|make|tsc/);
    expect(note).not.toMatch(/["'`$]/); // atravessa um prompt entre aspas
    expect(targetProfileNote({ checks: {}, dev: {}, docs: {} })).toBeNull();
  });

  it("sem convenções, nenhum documento é «leia antes de agir»", () => {
    const note = targetProfileNote({ checks: {}, dev: {}, docs: { testing: "docs/testing.md" } })!;
    expect(note).not.toContain("leia antes de agir");
    expect(note).toContain("consulte quando o trabalho pedir");
  });

  it("com perfil, a nota do run aponta as convenções DECLARADAS; sem perfil, manda ler as instruções do repositório (nenhum caminho inventado)", () => {
    const board = { id: "shop", name: "Shop", package: "packages/shop" } as unknown as BoardConfig;
    const declared = buildContextNote(board, { board: "shop", targetProfile: PROFILE })!;
    expect(declared).toContain("leia packages/shop/CONVENTIONS.md");
    expect(declared).not.toContain(".claude/CLAUDE.md");
    expect(declared).toContain("Perfil do alvo:");
    expect(declared).toContain("testes: docs/testing.md");
    expect(declared).not.toContain("descubra o comando"); // há checks declarados
    const neutral = buildContextNote(board, { board: "shop" })!;
    expect(neutral).not.toContain(".claude/CLAUDE.md");
    expect(neutral).toContain("leia as instruções do repositório e do pacote packages/shop");
    expect(neutral).toContain("descubra o comando nas instruções do repositório");
    expect(neutral).not.toContain("Perfil do alvo");
  });

  it("a convenção declarada com {package} vira o caminho do pacote do board, na mesma frase de contexto", () => {
    // estufa de mudas: as convenções moram num arquivo próprio de cada pacote; só dois checks declarados, sem dev.
    const declared: TargetProfile = {
      checks: { lint: "task lint --pkg={pkg}", build: "task build --pkg={pkg}" },
      dev: {},
      docs: { conventions: "{package}/docs/CONVENTIONS.md" },
    };
    for (const pkg of ["apps/estufa", "apps/viveiro"]) {
      const board = { id: "x", name: "X", package: pkg } as unknown as BoardConfig;
      const note = buildContextNote(board, { board: "x", targetProfile: declared })!;
      expect(note.startsWith(`Context: antes de qualquer ação de código ou copy, leia ${pkg}/docs/CONVENTIONS.md para respeitar as convenções específicas deste app.`)).toBe(true);
      // só conventions declarado ⇒ nenhuma linha de «consulte»
      expect(note).not.toContain("consulte quando");
      expect(note).toContain("(checks: lint, build)");
    }
  });
});


// ── o esquema ampliado (lote D): moeda, lentes, layout, QA ───────────────────────────────────────────────────────
// Fixtures INVENTADAS (uma oficina de bicicletas); nenhuma derivada de um alvo real.

describe("target.currency — moeda validada de verdade, nunca suposta", () => {
  it("aceita código ISO conhecido + locale canônico + neutralWrites", () => {
    expect(coerceTargetProfile({ currency: { code: "EUR", locale: "pt-pt", neutralWrites: true } })).toEqual({
      checks: {},
      dev: {},
      docs: {},
      currency: { code: "EUR", locale: "pt-PT", neutralWrites: true },
    });
  });

  it("um bloco só com currency NÃO é «sem perfil»", () => {
    expect(coerceTargetProfile({ currency: { code: "USD" } })?.currency).toEqual({ code: "USD" });
  });

  it("código inválido (minúsculo, desconhecido, longo, não-texto) descarta a moeda inteira", () => {
    for (const code of ["usd", "XXQ", "REAIS", "", 840, null, ["USD"]]) {
      const { profile, discarded } = coerceTargetProfileDetailed({ currency: { code, locale: "en-US" } });
      expect(profile).toBeUndefined();
      expect(discarded.map((d) => d.path)).toContain("target.currency.code");
    }
    expect(coerceTargetProfileDetailed({ currency: "USD" }).profile).toBeUndefined();
  });

  it("locale e neutralWrites inválidos caem sozinhos; o código fica", () => {
    const { profile, discarded } = coerceTargetProfileDetailed({ currency: { code: "USD", locale: "não é locale!", neutralWrites: "sim" } });
    expect(profile?.currency).toEqual({ code: "USD" });
    expect(discarded.map((d) => d.path)).toEqual(["target.currency.locale", "target.currency.neutralWrites"]);
  });

  it("currencyOf: o declarado ou undefined — nunca uma moeda do repositório de origem", () => {
    expect(currencyOf(undefined)).toBeUndefined();
    expect(currencyOf({ checks: {}, dev: {}, docs: {} })).toBeUndefined();
    expect(currencyOf(coerceTargetProfile({ currency: { code: "CHF" } }))).toEqual({ code: "CHF" });
  });
});

describe("target.reviewLenses — as embutidas são do núcleo, as de domínio são do alvo", () => {
  it("sem declaração só há as embutidas, com nome neutro e sem revisor", () => {
    const lenses = reviewLensesOf(undefined);
    expect(lenses.map((l) => l.id)).toEqual(["security", "testing", "perf", "general", "design"]);
    expect(lenses.every((l) => !l.declared && !l.agent)).toBe(true);
    expect(reviewLensIdsOf(undefined)).toEqual(CORE_REVIEW_LENSES.map((l) => l.id));
  });

  it("uma lente nova soma; uma embutida só sobrescreve (nunca some)", () => {
    const t = coerceTargetProfile({
      reviewLenses: {
        brakes: { name: "Freios", description: "folga, desgaste e regulagem das pastilhas", agent: "brake-reviewer", when: "o diff toca o sistema de freio", mandatoryWhen: "o diff toca o cabo do freio" },
        security: { agent: "lock-reviewer" },
      },
    });
    const lenses = reviewLensesOf(t);
    expect(lenses.map((l) => l.id)).toEqual(["security", "testing", "perf", "general", "design", "brakes"]);
    expect(lenses.find((l) => l.id === "security")).toMatchObject({ name: "Segurança", agent: "lock-reviewer", declared: true });
    expect(lenses.find((l) => l.id === "brakes")).toMatchObject({ name: "Freios", agent: "brake-reviewer", mandatoryWhen: "o diff toca o cabo do freio", declared: true });
  });

  it("descarta, peça a peça, id fora da forma, lente nova sem name/description, agent fora de slug, texto longo ou com controle", () => {
    const { profile, discarded } = coerceTargetProfileDetailed({
      reviewLenses: {
        "Id Ruim": { name: "x", description: "y" },
        semNome: { description: "só a descrição" },
        gears: { name: "Marchas", description: "regulagem do câmbio", agent: "../fora", when: "a\nb" },
        longa: { name: "Longa", description: "x".repeat(301) },
        perf: "nada",
      },
    });
    expect(Object.keys(profile?.reviewLenses ?? {})).toEqual(["gears"]);
    expect(profile?.reviewLenses?.gears).toEqual({ name: "Marchas", description: "regulagem do câmbio" });
    const paths = discarded.map((d) => d.path).join(" | ");
    expect(paths).toMatch(/Id Ruim/);
    expect(paths).toMatch(/semNome/);
    expect(paths).toMatch(/gears.*agent/);
    expect(paths).toMatch(/longa/);
  });

  it("limita a 24 lentes", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`lens-${i}`, { name: `L${i}`, description: "d" }]));
    expect(Object.keys(coerceTargetProfile({ reviewLenses: many })?.reviewLenses ?? {})).toHaveLength(24);
  });
});

describe("target.layout — globs relativos, nunca `**`", () => {
  it("aceita globs de segmentos literais e `*`, normaliza a barra final e deduplica", () => {
    expect(coerceTargetProfile({ layout: { workspaces: ["apps/*", "apps/*/web/", "apps/*"], packages: ["apps/*"] } })?.layout).toEqual({
      workspaces: ["apps/*", "apps/*/web"],
      packages: ["apps/*"],
    });
  });

  it("descarta `**`, `..`, raiz absoluta, barra invertida, caractere fora da lista e não-texto", () => {
    const { profile, discarded } = coerceTargetProfileDetailed({ layout: { workspaces: ["a/**", "../x", "/abs", "a\\b", "a b", 3, "ok/*"], outra: 1 } });
    expect(profile?.layout).toEqual({ workspaces: ["ok/*"] });
    expect(discarded.filter((d) => d.path.startsWith("target.layout.workspaces[")).length).toBe(6);
    expect(discarded.map((d) => d.path)).toContain('target.layout."outra"');
  });

  it("`[]` literal é uma declaração («nenhum»); uma lista da qual nada sobrou é «não declarado»", () => {
    expect(coerceTargetProfile({ layout: { workspaces: [] } })?.layout).toEqual({ workspaces: [] });
    expect(coerceTargetProfile({ layout: { workspaces: ["**"] } })).toBeUndefined();
  });

  it("layoutOf lê target.layout e só o staging que o ARQUIVO declarou (indeclarado ≠ [])", () => {
    const t = coerceTargetProfile({ layout: { packages: ["apps/*"] } });
    expect(layoutOf({ target: t })).toEqual({ packages: ["apps/*"] });
    expect(layoutOf(undefined)).toEqual({});
    const st = { branch: "stage", codePrefixes: ["apps/"] };
    expect(layoutOf({ autorun: { staging: st } })).toEqual({});
    expect(layoutOf({ autorun: { staging: { ...st, declared: { codePrefixes: true } } } })).toEqual({ codePrefixes: ["apps/"] });
    expect(layoutOf({ autorun: { staging: { branch: "release", codePrefixes: [], declared: { branch: true, codePrefixes: true } } } })).toEqual({ stagingBranch: "release", codePrefixes: [] });
  });
});

describe("target.qa — portas, sondas de loopback e classes de falha com dentes", () => {
  const QA = {
    ports: [6060, 6061, 6060, 0, 70000, "6062", 1.5],
    health: [
      { name: "preview", url: "http://127.0.0.1:6060/" },
      { name: "queue", url: "http://localhost:6061/ping" },
      { name: "remoto", url: "http://example.com:80/" },
      { name: "semPorta", url: "http://127.0.0.1/" },
      { name: "cred", url: "http://u:p@127.0.0.1:6060/" },
      { name: "Nome Ruim", url: "http://127.0.0.1:6060/" },
      { name: "preview", url: "http://127.0.0.1:6069/" },
      { name: "ftp", url: "ftp://127.0.0.1:21/" },
    ],
    seeded: { url: "http://127.0.0.1:6061/fixtures/loaded" },
    failureClasses: [
      { pattern: "^ledger shard \\d+ offline$", class: "infra" },
      { pattern: "(a+)+$", class: "infra" },
      { pattern: "([", class: "infra" },
      { pattern: "x", class: "outra" },
      { pattern: "y", class: "test", flags: "g" },
      { pattern: "z", class: "app", flags: "is" },
      { pattern: "", class: "app" },
      { pattern: "w".repeat(201), class: "app" },
    ],
  };

  it("aceita o que tem forma e descarta o resto peça a peça", () => {
    const { profile, discarded } = coerceTargetProfileDetailed({ qa: QA });
    expect(profile?.qa).toEqual({
      ports: [6060, 6061],
      health: [
        { name: "preview", url: "http://127.0.0.1:6060/" },
        { name: "queue", url: "http://localhost:6061/ping" },
      ],
      seeded: { url: "http://127.0.0.1:6061/fixtures/loaded" },
      failureClasses: [
        { pattern: "^ledger shard \\d+ offline$", class: "infra" },
        { pattern: "z", class: "app", flags: "is" },
      ],
    });
    expect(discarded.length).toBeGreaterThanOrEqual(14);
  });

  it("uma URL só vale em loopback, com porta e sem credencial", () => {
    expect(isLoopbackUrlWithPort("http://[::1]:6060/x")).toBe(true);
    for (const bad of ["http://10.0.0.5:80/", "http://127.0.0.1/", "http://a@127.0.0.1:1/", "file:///etc/passwd", "http://127.0.0.1:1/ x", 5, undefined]) expect(isLoopbackUrlWithPort(bad)).toBe(false);
  });

  it("detecta quantificador aninhado mas não confunde com quantificador fora do grupo", () => {
    for (const bad of ["(a+)+", "(\\w*)*", "(x{1,5})+", "((a+))+", "(a|b+c)*"]) expect(hasNestedQuantifier(bad)).toBe(true);
    for (const ok of ["\\bseat\\b.*\\brevoked\\b", "a(b|c)d+", "(abc)+", "[+*](x)", "\\(a+\\)+", "(a)?"]) expect(hasNestedQuantifier(ok)).toBe(false);
  });

  it("qaOf: vazio quando não declarado, e o declarado quando há", () => {
    expect(qaOf(undefined)).toEqual({ declared: false, ports: [], health: [], failureClasses: [] });
    const q = qaOf(coerceTargetProfile({ qa: { ports: [6060] } }));
    expect(q).toMatchObject({ declared: true, ports: [6060], health: [], failureClasses: [] });
  });

  it("matchDeclaredFailureClass: a primeira que casa vence, lê só o final do texto e pula regra quebrada", () => {
    const rules = [
      { pattern: "SHARD \\d+ OFFLINE", class: "infra" as const },
      { pattern: "assertion", class: "test" as const },
      { pattern: "(", class: "app" as const },
    ];
    expect(matchDeclaredFailureClass("ledger shard 7 offline (retrying)", rules)).toBe("infra");
    expect(matchDeclaredFailureClass("Assertion failed", rules)).toBe("test");
    expect(matchDeclaredFailureClass("nada a ver", rules)).toBeUndefined();
    expect(matchDeclaredFailureClass("x", undefined)).toBeUndefined();
    const longo = "shard 7 offline" + "z".repeat(QA_FAILURE_TEXT_TAIL_BYTES + 10);
    expect(matchDeclaredFailureClass(longo, rules)).toBeUndefined(); // o começo ficou fora da janela
  });

  it("uma regex declarada não trava o processo (teto de texto + sem aninhamento)", () => {
    const t0 = Date.now();
    const rules = coerceTargetProfile({ qa: { failureClasses: [{ pattern: "shard \\d{1,4} (offline|lost)", class: "infra" }] } })?.qa?.failureClasses;
    matchDeclaredFailureClass("shard ".repeat(50_000), rules);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("o aviso de descarte — o fail-open continua, mas não é mudo", () => {
  afterEach(() => vi.restoreAllMocks());

  it("escreve UMA linha por bloco, com o caminho e sem o valor hostil", () => {
    const linhas: string[] = [];
    coerceTargetProfile({ checks: { "nome ruim": "x", test: "make test" }, docs: { sobe: "../fora.md" }, currency: { code: "nope" }, tipo: 1, deploy: { x: 1 } }, (l) => linhas.push(l));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatch(/\[storymap\] settings target: 5 entrada\(s\) DESCARTADA\(s\)/);
    expect(linhas[0]).toContain('target.checks."nome ruim"');
    expect(linhas[0]).toContain("target.docs.\"sobe\"");
    expect(linhas[0]).toContain("target.currency.code");
    expect(linhas[0]).toContain("bloco `deploy:` de topo");
    expect(linhas[0]).not.toContain("../fora.md");
    expect(linhas[0]).not.toContain("\n");
  });

  it("não avisa quando nada foi descartado, e nunca lança", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    coerceTargetProfile({ checks: { test: "make test" } });
    expect(spy).not.toHaveBeenCalled();
    for (const raw of [undefined, null, 3, "x", [], { checks: 5, qa: [], layout: "x", reviewLenses: 7, currency: [] }]) expect(() => coerceTargetProfile(raw, () => {})).not.toThrow();
    warnTargetDiscards([], () => {
      throw new Error("não deveria chamar");
    });
  });

  it("encolhe uma lista longa de descartes", () => {
    const linhas: string[] = [];
    warnTargetDiscards(Array.from({ length: 30 }, (_, i) => ({ path: `target.x${i}`, why: "r" })), (l) => linhas.push(l));
    expect(linhas[0]).toMatch(/30 entrada\(s\)/);
    expect(linhas[0]).toMatch(/e mais 18/);
  });
});
