import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { patchYamlScalars, patchYamlScalarsChecked, patchYamlToMatch, scalarPatchesBetween } from "./settings-yaml";
import { resetRepoRootCache } from "../paths";

const load = (text: string) => yaml.load(text) as any;
const chat = (path: string[], value: string | number | boolean) => ({ path, value });

describe("patchYamlScalars — mexer em knobs sem reescrever o arquivo", () => {
  const FULL = [
    "version: 1",
    "autorun:",
    "  # Este comentário é DOCUMENTAÇÃO operacional — o trade do gate affected-only mora aqui.",
    "  enabled: true",
    "  maxConcurrent: 2",
    "orchestrator:",
    "  # quando ele acorda",
    "  enabled: true",
    "  tickMinutes: 30",
    "  chat:",
    "    model: opus[1m]",
    "    effort: high",
    "  riskMatrix:",
    "    deploy: ask",
    "",
  ].join("\n");

  it("troca escalares e PRESERVA todo o resto — comentários inclusive", () => {
    const out = patchYamlScalars(FULL, [
      chat(["orchestrator", "chat", "model"], "sonnet"),
      chat(["orchestrator", "chat", "effort"], "xhigh"),
    ]);
    expect(load(out).orchestrator.chat).toEqual({ model: "sonnet", effort: "xhigh" });
    expect(out).toContain("# Este comentário é DOCUMENTAÇÃO operacional");
    expect(out).toContain("# quando ele acorda");
    expect(out.split("\n").length).toBe(FULL.split("\n").length);
    const untouched = (t: string) => t.split("\n").filter((l) => !/model:|effort:/.test(l));
    expect(untouched(out)).toEqual(untouched(FULL));
  });

  it("o SALVAR da engrenagem: 7 knobs de uma vez, nada mais muda", () => {
    const out = patchYamlScalars(FULL, [
      chat(["orchestrator", "enabled"], false),
      chat(["orchestrator", "tickMinutes"], 15),
      chat(["orchestrator", "budget", "maxTicksPerDay"], 40),
      chat(["orchestrator", "budget", "maxCostPerDay"], 12.5),
      chat(["orchestrator", "wake", "enabled"], true),
      chat(["orchestrator", "chat", "model"], "sonnet[1m]"),
      chat(["orchestrator", "chat", "effort"], "medium"),
    ]);
    const o = load(out).orchestrator;
    expect(o).toMatchObject({
      enabled: false,
      tickMinutes: 15,
      budget: { maxTicksPerDay: 40, maxCostPerDay: 12.5 },
      wake: { enabled: true },
      chat: { model: "sonnet[1m]", effort: "medium" },
    });
    // o que a engrenagem NÃO edita continua exatamente onde estava
    expect(o.riskMatrix).toEqual({ deploy: "ask" });
    expect(load(out).autorun).toEqual({ enabled: true, maxConcurrent: 2 });
    expect(out).toContain("# Este comentário é DOCUMENTAÇÃO operacional");
  });

  it("preserva um comentário NA PRÓPRIA linha trocada", () => {
    const src = ["orchestrator:", "  chat:", "    model: opus  # a janela longa custa acima de 200k", ""].join("\n");
    const out = patchYamlScalars(src, [chat(["orchestrator", "chat", "model"], "sonnet[1m]")]);
    expect(load(out).orchestrator.chat.model).toBe("sonnet[1m]");
    expect(out).toContain("# a janela longa custa acima de 200k");
  });

  it("bloco INTERMEDIÁRIO ausente é criado com a indentação das irmãs", () => {
    const src = ["orchestrator:", "  enabled: true", "  tickMinutes: 30", ""].join("\n");
    const out = patchYamlScalars(src, [
      chat(["orchestrator", "budget", "maxTicksPerDay"], 40),
      chat(["orchestrator", "budget", "maxCostPerDay"], 5),
    ]);
    expect(load(out).orchestrator).toMatchObject({
      enabled: true,
      tickMinutes: 30,
      budget: { maxTicksPerDay: 40, maxCostPerDay: 5 },
    });
  });

  it("caminho INTEIRO ausente: cria do zero sem tocar no resto", () => {
    const src = "version: 1\nautorun:\n  enabled: true\n";
    const out = patchYamlScalars(src, [chat(["orchestrator", "chat", "model"], "opus[1m]")]);
    expect(load(out).autorun).toEqual({ enabled: true });
    expect(load(out).orchestrator.chat.model).toBe("opus[1m]");
  });

  it("arquivo VAZIO vira um settings válido", () => {
    const out = patchYamlScalars("", [chat(["orchestrator", "chat", "effort"], "medium")]);
    expect(load(out).orchestrator.chat.effort).toBe("medium");
  });

  it("uma chave homônima em OUTRO bloco não é confundida", () => {
    const src = [
      "autorun:",
      "  chat:",
      "    model: NAO-MEXER",
      "orchestrator:",
      "  chat:",
      "    model: opus",
      "",
    ].join("\n");
    const out = patchYamlScalars(src, [chat(["orchestrator", "chat", "model"], "sonnet")]);
    expect(load(out).autorun.chat.model).toBe("NAO-MEXER");
    expect(load(out).orchestrator.chat.model).toBe("sonnet");
  });

  it("é IDEMPOTENTE — patchar duas vezes com o mesmo valor não muda nada", () => {
    const patches = [chat(["orchestrator", "chat", "model"], "sonnet"), chat(["orchestrator", "tickMinutes"], 20)];
    const once = patchYamlScalars(FULL, patches);
    expect(patchYamlScalars(once, patches)).toBe(once);
  });

  it("tipos: booleano e número vão crus; string ambígua é citada (não vira outro tipo na volta)", () => {
    const out = patchYamlScalars("a:\n  b: 1\n", [
      chat(["a", "flag"], true),
      chat(["a", "num"], 3.5),
      chat(["a", "str"], "true"),
      chat(["a", "vazio"], ""),
      chat(["a", "comentario"], "isto # não é comentário"),
    ]);
    const a = load(out).a;
    expect(a.flag).toBe(true);
    expect(a.num).toBe(3.5);
    expect(a.str).toBe("true");
    expect(a.vazio).toBe("");
    expect(a.comentario).toBe("isto # não é comentário");
  });

  it("lista de patches vazia devolve o texto IDÊNTICO (nem o \\n final se mexe)", () => {
    expect(patchYamlScalars(FULL, [])).toBe(FULL);
  });

  it("CRLF sobrevive (um arquivo editado no Windows não vira um diff de arquivo inteiro)", () => {
    const src = "orchestrator:\r\n  chat:\r\n    model: opus\r\n";
    const out = patchYamlScalars(src, [chat(["orchestrator", "chat", "model"], "sonnet")]);
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });
});

// quick-fix yaml-comments: um TOGGLE (economia, «só organização») edita a linha da chave e nada mais — o arquivo não é
// re-serializado. A prova por leitura de volta é o que impede a edição textual de gravar um valor errado.
describe("patchYamlScalarsChecked — a edição no lugar só passa provada", () => {
  const FILE = [
    "# Configuração do runner — NÃO APAGUE os comentários: são a documentação de operação.",
    "economyMode: false # liga o teto sonnet/high",
    "autorun:",
    "  # por que o teto é 2: ver o caderno",
    "  maxParallel: 2",
    "",
  ].join("\n");

  it("troca só a linha da chave; comentários e o resto atravessam", () => {
    const out = patchYamlScalarsChecked(FILE, [{ path: ["economyMode"], value: true }])!;
    expect(out).toBe(FILE.replace("economyMode: false", "economyMode: true"));
    expect(out).toContain("NÃO APAGUE os comentários");
    expect(out).toContain("# por que o teto é 2");
  });

  it("chave ausente nasce, e o resto do documento continua igual", () => {
    const out = patchYamlScalarsChecked("autorun:\n  maxParallel: 2 # dois\n", [{ path: ["organizeOnly"], value: true }])!;
    expect(yaml.load(out)).toEqual({ organizeOnly: true, autorun: { maxParallel: 2 } });
    expect(out).toContain("# dois");
  });

  it("remoção: só a linha da chave sai; chave ausente não muda nada; um BLOCO nunca é removido por aqui", () => {
    expect(patchYamlScalarsChecked(FILE, [{ path: ["economyMode"], delete: true }])).toBe(FILE.replace("economyMode: false # liga o teto sonnet/high\n", ""));
    expect(patchYamlScalarsChecked(FILE, [{ path: ["organizeOnly"], delete: true }])).toBe(FILE);
    expect(patchYamlScalarsChecked(FILE, [{ path: ["autorun"], delete: true }])).toBeNull();
  });

  it("um formato que a edição textual não cobre (fluxo) devolve null — nunca um valor errado", () => {
    expect(patchYamlScalarsChecked("{economyMode: false, autorun: {maxParallel: 2}}\n", [{ path: ["autorun", "maxParallel"], value: 3 }])).toBeNull();
  });
});

// Toda gravação de config que só muda ESCALARES passa pela edição no lugar (o yaml.dump apagava os comentários a cada
// salvamento da bancada); listas e blocos ainda reescrevem o arquivo — com a mesma prova decidindo.
describe("patchYamlToMatch / scalarPatchesBetween — a config inteira, no lugar, quando só escalares mudam", () => {
  const BOARD = [
    "# ⚠ comentário do time: não apague",
    "id: demo",
    "name: Livraria # o nome que a tela mostra",
    "autonomy:",
    "  # por que ultra: ver o caderno",
    "  mode: ultra",
    "personas:",
    "  - id: leitor",
    "    name: Leitor",
    "",
  ].join("\n");
  const parsed = () => yaml.load(BOARD) as Record<string, unknown>;

  it("troca de escalar (raiz e aninhado), chave nova e chave removida: só as linhas mudam, comentários ficam", () => {
    const target = { ...parsed(), name: "Sebo", autonomy: { mode: "semi" }, organizeOnly: true };
    const out = patchYamlToMatch(BOARD, target)!;
    expect(out).not.toBeNull();
    expect(yaml.load(out)).toEqual(target);
    expect(out).toContain("# ⚠ comentário do time: não apague");
    expect(out).toContain("name: Sebo # o nome que a tela mostra");
    expect(out).toContain("# por que ultra: ver o caderno");
    const { name: _drop, ...noName } = parsed();
    const del = patchYamlToMatch(BOARD, noName)!;
    expect(yaml.load(del)).toEqual(noName);
    expect(del).toContain("# ⚠ comentário do time");
  });

  it("nada mudou ⇒ o mesmo texto", () => {
    expect(patchYamlToMatch(BOARD, parsed())).toBe(BOARD);
  });

  it("lista ou bloco mudou ⇒ null (quem chama reescreve)", () => {
    expect(patchYamlToMatch(BOARD, { ...parsed(), personas: [{ id: "leitor", name: "Leitora" }] })).toBeNull();
    expect(patchYamlToMatch(BOARD, { ...parsed(), conductor: { enabled: true } })).toBeNull();
    const { autonomy: _a, ...noBlock } = parsed();
    expect(patchYamlToMatch(BOARD, noBlock)).toBeNull();
    expect(scalarPatchesBetween({ a: 1 }, { a: null })).toBeNull();
    expect(scalarPatchesBetween({ a: "x" }, { a: "linha\noutra" })).toBeNull();
  });
});

describe("toggles gravam NO LUGAR (settings.yaml e board.yaml)", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ah-toggle-"));
    mkdirSync(path.join(dir, "storymap", "boards", "demo"), { recursive: true });
    vi.stubEnv("AGILEHARNESS_TARGET", dir);
    resetRepoRootCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRepoRootCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("economia: só a linha muda, e um override de ENV em vigor NÃO vaza para o arquivo", async () => {
    const file = path.join(dir, "storymap", "settings.yaml");
    const before = "# caderno de operação\neconomyMode: false\nautorun:\n  enabled: false # desligado de propósito\n";
    writeFileSync(file, before);
    vi.stubEnv("AGILEHARNESS_AUTORUN", "1");
    const { patchRunnerSettingsScalars } = await import("./config");
    await patchRunnerSettingsScalars([{ path: ["economyMode"], value: true }]);
    expect(readFileSync(file, "utf8")).toBe(before.replace("economyMode: false", "economyMode: true"));
  });

  it("«só organização» do board: a linha nasce/muda e os comentários do board.yaml ficam", async () => {
    const file = path.join(dir, "storymap", "boards", "demo", "board.yaml");
    const before = "# ⚠ NÃO APAGUE package: — explica o escopo da publicação\nid: demo\nname: Livraria\npackage: loja\n";
    writeFileSync(file, before);
    const { patchBoardConfigScalars } = await import("../write");
    expect(await patchBoardConfigScalars("demo", [{ path: ["organizeOnly"], value: true }])).toBe(true);
    const on = readFileSync(file, "utf8");
    expect(on).toContain("NÃO APAGUE package:");
    expect(yaml.load(on)).toEqual({ id: "demo", name: "Livraria", package: "loja", organizeOnly: true });
    // desligar REMOVE a linha (sem chave fantasma) e devolve o arquivo exatamente como era
    expect(await patchBoardConfigScalars("demo", [{ path: ["organizeOnly"], delete: true }])).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("writeBoardConfig: salvamento que só muda escalar edita no lugar; mudança de lista reescreve", async () => {
    const file = path.join(dir, "storymap", "boards", "demo", "board.yaml");
    const before = "# ⚠ NÃO APAGUE package: — explica o escopo da publicação\nid: demo\nname: Livraria # nome na tela\npackage: loja\n";
    writeFileSync(file, before);
    const { writeBoardConfig } = await import("../write");
    const cfg = yaml.load(before) as Record<string, unknown>;
    await writeBoardConfig("demo", { ...cfg, name: "Sebo" } as never);
    expect(readFileSync(file, "utf8")).toBe(before.replace("name: Livraria", "name: Sebo"));
    await writeBoardConfig("demo", { ...cfg, name: "Sebo", personas: [{ id: "leitor", name: "Leitor" }] } as never);
    const rewritten = readFileSync(file, "utf8");
    expect(yaml.load(rewritten)).toMatchObject({ id: "demo", name: "Sebo", personas: [{ id: "leitor", name: "Leitor" }] });
    expect(rewritten).not.toContain("NÃO APAGUE");
  });
});
