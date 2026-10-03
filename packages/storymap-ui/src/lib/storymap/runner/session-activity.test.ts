import { describe, expect, it } from "vitest";
import { parsePorcelainZPaths, worktreeTouchedWithin } from "./session-activity";

const Z = (...entries: string[]) => entries.join("\0") + "\0";

describe("parsePorcelainZPaths — os caminhos sujos, sem desfazer quoting", () => {
  it("lê modificado, adicionado e não-rastreado", () => {
    expect(parsePorcelainZPaths(Z(" M src/a.ts", "A  src/b.ts", "?? novo.txt"))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "novo.txt",
    ]);
  });

  it("num rename, pula a ORIGEM (ela não existe mais no disco)", () => {
    expect(parsePorcelainZPaths(Z("R  novo.ts", "velho.ts", " M outro.ts"))).toEqual(["novo.ts", "outro.ts"]);
  });

  it("caminho com espaço e acento chega literal (é para isso que o -z existe)", () => {
    expect(parsePorcelainZPaths(Z(" M src/ação de teste.ts"))).toEqual(["src/ação de teste.ts"]);
  });

  it("saída vazia (árvore limpa) → nenhum caminho", () => {
    expect(parsePorcelainZPaths("")).toEqual([]);
  });

  it("respeita o teto de entradas", () => {
    const many = Z(...Array.from({ length: 50 }, (_, i) => ` M f${i}.ts`));
    expect(parsePorcelainZPaths(many, 10)).toHaveLength(10);
  });
});

describe("worktreeTouchedWithin — a prova de vida que o heartbeat não dá", () => {
  const HOUR = 3600_000;
  const now = () => 1_000 * HOUR;

  const deps = (stdout: string, mtimes: Record<string, number>, onExec?: () => void) => ({
    exec: async () => {
      onExec?.();
      return { stdout, stderr: "" };
    },
    mtimeMs: async (p: string) => mtimes[p] ?? null,
    now,
  });

  it("arquivo sujo tocado agora ⇒ VIVA (não reapável)", async () => {
    const d = deps(Z(" M src/a.ts"), { "/wt/src/a.ts": now() - 5 * 60_000 });
    expect(await worktreeTouchedWithin(d, "/wt", 6 * HOUR)).toBe(true);
  });

  it("tudo sujo mas parado há mais que a janela ⇒ pode reapar", async () => {
    const d = deps(Z(" M src/a.ts", "?? b.txt"), {
      "/wt/src/a.ts": now() - 9 * HOUR,
      "/wt/b.txt": now() - 8 * HOUR,
    });
    expect(await worktreeTouchedWithin(d, "/wt", 6 * HOUR)).toBe(false);
  });

  it("árvore LIMPA ⇒ false (não há trabalho fora do git; quem decide é o heartbeat)", async () => {
    let execs = 0;
    const d = deps("", {}, () => execs++);
    expect(await worktreeTouchedWithin(d, "/wt", 6 * HOUR)).toBe(false);
    expect(execs).toBe(1);
  });

  it("git ilegível ⇒ VIVA (fail-closed: 'não sei' nunca autoriza apagar)", async () => {
    const d = {
      exec: async () => {
        throw new Error("fatal: not a git repository");
      },
      now,
    };
    expect(await worktreeTouchedWithin(d, "/wt", 6 * HOUR)).toBe(true);
  });

  it("CURTO-CIRCUITA no primeiro arquivo recente (não faz stat da árvore inteira)", async () => {
    const statted: string[] = [];
    const d = {
      exec: async () => ({ stdout: Z(" M a.ts", " M b.ts", " M c.ts"), stderr: "" }),
      mtimeMs: async (p: string) => {
        statted.push(p);
        return now() - 60_000; // o PRIMEIRO já é recente
      },
      now,
    };
    expect(await worktreeTouchedWithin(d, "/wt", 6 * HOUR)).toBe(true);
    expect(statted).toEqual(["/wt/a.ts"]);
  });

  it("arquivo sumido no meio da varredura não conta como atividade", async () => {
    const d = deps(Z(" M some.ts"), {}); // mtimeMs → null
    expect(await worktreeTouchedWithin(d, "/wt", 6 * HOUR)).toBe(false);
  });
});
