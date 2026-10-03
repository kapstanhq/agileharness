import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { patchYamlScalars } from "./settings-yaml";

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
