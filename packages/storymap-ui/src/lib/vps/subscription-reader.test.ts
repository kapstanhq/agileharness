import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headroomStatsUrl } from "./subscription-reader";

// A URL do medidor é DECLARADA: env (AGILEHARNESS_HEADROOM_URL) > vps.headroomUrl > nenhuma. As portas abaixo são
// inventadas (7111/7112); nada aqui supõe o proxy de ninguém.
describe("headroomStatsUrl — declarado, nunca assumido", () => {
  it("sem env e sem declaração NÃO há medidor: null, nunca uma porta «convencional»", () => {
    expect(headroomStatsUrl({}, undefined)).toBeNull();
    expect(headroomStatsUrl({}, null)).toBeNull();
    expect(headroomStatsUrl({ AGILEHARNESS_HEADROOM_URL: "   " }, "")).toBeNull();
  });

  it("o valor declarado em settings (vps.headroomUrl) vale, com a barra final removida", () => {
    expect(headroomStatsUrl({}, "http://127.0.0.1:7111")).toBe("http://127.0.0.1:7111/stats");
    expect(headroomStatsUrl({}, "http://127.0.0.1:7111//")).toBe("http://127.0.0.1:7111/stats");
  });

  it("a env vence o settings", () => {
    expect(headroomStatsUrl({ AGILEHARNESS_HEADROOM_URL: "http://127.0.0.1:7112/" }, "http://127.0.0.1:7111")).toBe("http://127.0.0.1:7112/stats");
  });

  it("off / 0 / false / none / disabled na env desligam o medidor, mesmo com o settings declarado", () => {
    for (const off of ["off", "0", "false", "none", "disabled", "OFF"]) {
      expect(headroomStatsUrl({ AGILEHARNESS_HEADROOM_URL: off }, "http://127.0.0.1:7111"), off).toBeNull();
    }
  });

  it("o ARQUIVO não carrega literal de endereço de loopback (a catraca contra voltar a embutir uma porta)", () => {
    const fonte = readFileSync(join(process.cwd(), "src/lib/vps/subscription-reader.ts"), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(fonte).not.toMatch(/127\.0\.0\.1|localhost|\[::1\]/);
    expect(fonte).not.toMatch(/:\d{4,5}\b/);
  });
});
