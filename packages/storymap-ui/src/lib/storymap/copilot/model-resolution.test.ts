import { describe, expect, it } from "vitest";
import {
  aliasKey,
  coerceResolutions,
  rememberResolution,
  resolvedIdFor,
  versionLabel,
  type ModelResolutions,
} from "./model-resolution";

const NOW = new Date("2026-07-27T20:00:00.000Z");

describe("aliasKey — a janela não é outro modelo", () => {
  it("`opus` e `opus[1m]` são a MESMA chave", () => {
    expect(aliasKey("opus")).toBe("opus");
    expect(aliasKey("opus[1m]")).toBe("opus");
    expect(aliasKey("OPUS[1M]")).toBe("opus");
  });

  it("vazio/indefinido não vira chave", () => {
    expect(aliasKey(undefined)).toBe("");
    expect(aliasKey("  ")).toBe("");
  });
});

describe("rememberResolution — a memória do que o CLI respondeu", () => {
  it("guarda o par pedido→resolvido, sem a variante de janela", () => {
    const t = rememberResolution({}, "opus[1m]", "claude-opus-5", NOW);
    expect(t).toEqual({ opus: { resolved: "claude-opus-5", seenAt: NOW.toISOString() } });
  });

  it("a observação mais NOVA vence (é ela que reflete o CLI de hoje)", () => {
    const t1 = rememberResolution({}, "opus", "claude-opus-4-8", new Date("2026-01-01T00:00:00.000Z"));
    const t2 = rememberResolution(t1, "opus", "claude-opus-5", NOW);
    expect(t2.opus).toEqual({ resolved: "claude-opus-5", seenAt: NOW.toISOString() });
  });

  it("observação IDÊNTICA devolve a mesma tabela (não reescreve o arquivo por nada)", () => {
    const t1 = rememberResolution({}, "sonnet", "claude-sonnet-5", NOW);
    expect(rememberResolution(t1, "sonnet[1m]", "claude-sonnet-5", new Date())).toBe(t1);
  });

  it("famílias diferentes convivem", () => {
    let t: ModelResolutions = {};
    t = rememberResolution(t, "opus", "claude-opus-5", NOW);
    t = rememberResolution(t, "sonnet", "claude-sonnet-5", NOW);
    expect(Object.keys(t).sort()).toEqual(["opus", "sonnet"]);
  });

  it("lixo é ignorado em silêncio — rótulo errado é pior que rótulo ausente", () => {
    const t: ModelResolutions = {};
    expect(rememberResolution(t, "opus", "", NOW)).toBe(t);
    expect(rememberResolution(t, "", "claude-opus-5", NOW)).toBe(t);
    expect(rememberResolution(t, undefined, undefined, NOW)).toBe(t);
  });

  it("não muta a tabela anterior", () => {
    const t1 = rememberResolution({}, "opus", "claude-opus-4-8", NOW);
    rememberResolution(t1, "opus", "claude-opus-5", NOW);
    expect(t1.opus.resolved).toBe("claude-opus-4-8");
  });
});

describe("resolvedIdFor / versionLabel — o que a tela mostra", () => {
  const table = rememberResolution({}, "opus", "claude-opus-5", NOW);

  it("responde pela BASE, com ou sem janela", () => {
    expect(resolvedIdFor(table, "opus")).toBe("claude-opus-5");
    expect(resolvedIdFor(table, "opus[1m]")).toBe("claude-opus-5");
  });

  it("apelido nunca rodado devolve null — a UI diz 'o mais recente', não inventa versão", () => {
    expect(resolvedIdFor(table, "sonnet")).toBeNull();
    expect(versionLabel(table, "sonnet")).toBeNull();
  });
});

describe("coerceResolutions — o arquivo de estado é dado externo", () => {
  it("aceita o que tem forma e descarta o resto", () => {
    const out = coerceResolutions({
      opus: { resolved: "claude-opus-5", seenAt: "2026-07-27T20:00:00.000Z" },
      sonnet: { resolved: "" },
      lixo: 42,
      "": { resolved: "x" },
    });
    expect(Object.keys(out)).toEqual(["opus"]);
  });

  it("entrada sem `seenAt` sobrevive (a versão é o que importa)", () => {
    expect(coerceResolutions({ opus: { resolved: "claude-opus-5" } }).opus.resolved).toBe("claude-opus-5");
  });

  it("qualquer coisa que não seja objeto vira tabela vazia", () => {
    expect(coerceResolutions(null)).toEqual({});
    expect(coerceResolutions([1, 2])).toEqual({});
    expect(coerceResolutions("opus")).toEqual({});
  });
});
