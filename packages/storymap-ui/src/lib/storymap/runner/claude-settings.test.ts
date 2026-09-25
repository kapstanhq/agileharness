import { describe, expect, it } from "vitest";
import { readInheritedDefaultMode } from "./claude-settings";

const layers = (files: Record<string, unknown>) => (f: string) => {
  if (!(f in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const v = files[f];
  return typeof v === "string" ? v : JSON.stringify(v);
};
const opts = (files: Record<string, unknown>) => ({ home: "/home/op", managedPath: "/etc/managed.json", readFile: layers(files) });

describe("readInheritedDefaultMode — a precedência do CLI", () => {
  it("usuário sozinho decide quando ninguém acima fala", () => {
    expect(readInheritedDefaultMode("/repo", opts({ "/home/op/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } } }))).toBe(
      "bypassPermissions",
    );
  });
  it("projeto vence usuário; local vence projeto; política gerenciada vence todos", () => {
    const base = {
      "/home/op/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } },
      "/repo/.claude/settings.json": { permissions: { defaultMode: "acceptEdits" } },
    };
    expect(readInheritedDefaultMode("/repo", opts(base))).toBe("acceptEdits");
    expect(readInheritedDefaultMode("/repo", opts({ ...base, "/repo/.claude/settings.local.json": { permissions: { defaultMode: "plan" } } }))).toBe("plan");
    expect(readInheritedDefaultMode("/repo", opts({ ...base, "/etc/managed.json": { permissions: { defaultMode: "default" } } }))).toBe("default");
  });
  it("camada sem a chave, ausente ou ilegível cai para a próxima; nada ⇒ undefined", () => {
    expect(
      readInheritedDefaultMode("/repo", opts({ "/repo/.claude/settings.json": { hooks: {} }, "/repo/.claude/settings.local.json": "{ quebrado", "/home/op/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions" } } })),
    ).toBe("bypassPermissions");
    expect(readInheritedDefaultMode("/repo", opts({}))).toBeUndefined();
  });
});
