import { describe, expect, it } from "vitest";
import { classifyWorktree, runWorktreeGc, type WorktreeGcFacts, type WorktreeGcVerdict } from "./worktree-gc";

const dir = (name: string) => ({ name, path: `/repo/.worktrees/${name}` });
const facts = (over: Partial<Record<keyof WorktreeGcFacts, string[]>> = {}): WorktreeGcFacts => ({
  activeRunIds: new Set(over.activeRunIds ?? []),
  allRunIds: new Set(over.allRunIds ?? []),
  liveRunIds: new Set(over.liveRunIds ?? []),
});

describe("classifyWorktree — só um NÃO comprovado libera", () => {
  it("gate-* sem entrada ATIVA é órfã: a limpeza do gate não rodou (um kill não executa `finally`)", () => {
    expect(classifyWorktree(dir("gate-abc"), facts()).action).toBe("orphan-gate");
  });

  it("gate-* com entrada ATIVA fica — o gate pode estar rodando agora", () => {
    expect(classifyWorktree(dir("gate-abc"), facts({ activeRunIds: ["abc"] })).action).toBe("keep");
  });

  it("gate-* de uma entrada PARKEADA é órfã — parkeado não roda gate", () => {
    expect(classifyWorktree(dir("gate-abc"), facts({ allRunIds: ["abc"] })).action).toBe("orphan-gate");
  });

  it("run-* com run VIVO fica", () => {
    expect(classifyWorktree(dir("run-abc"), facts({ liveRunIds: ["abc"] })).action).toBe("keep");
  });

  it("run-* com entrada PARKEADA fica — o operador ainda pode retomá-la, e a árvore é o material dela", () => {
    expect(classifyWorktree(dir("run-abc"), facts({ allRunIds: ["abc"] })).action).toBe("keep");
  });

  it("run-* sem run vivo e sem NENHUMA entrada é órfã: nada vai avançá-la nem limpá-la", () => {
    expect(classifyWorktree(dir("run-abc"), facts()).action).toBe("orphan-run");
  });

  it("agent-* NUNCA é julgada aqui — uma sessão fica horas ociosa por desenho, e já ceifamos uma", () => {
    expect(classifyWorktree(dir("agent-abc"), facts()).action).toBe("keep");
  });

  it("nome desconhecido fica — não saber de quem é jamais vira licença para apagar", () => {
    expect(classifyWorktree(dir("dev-efficiency"), facts()).action).toBe("keep");
  });
});

describe("runWorktreeGc", () => {
  const collect = () => {
    const journal: Array<WorktreeGcVerdict & { removed: boolean }> = [];
    return { journal, fn: (v: WorktreeGcVerdict & { removed: boolean }) => void journal.push(v) };
  };

  it("remove as órfãs e deixa o resto em paz", async () => {
    const removed: string[] = [];
    const j = collect();
    const res = await runWorktreeGc({
      listDirs: async () => [dir("gate-a"), dir("run-b"), dir("agent-c"), dir("run-d")],
      facts: async () => facts({ allRunIds: ["d"] }),
      isDirty: async () => false,
      remove: async (p) => {
        removed.push(p);
        return true;
      },
      journal: j.fn,
    });
    expect(removed).toEqual(["/repo/.worktrees/gate-a", "/repo/.worktrees/run-b"]);
    expect(res).toEqual({ scanned: 4, removed: 2, rescued: 0, keptDirty: 0, orphanDirs: 0 });
  });

  it("árvore ORIGINAL suja SEM resgate configurado é preservada (o comportamento anterior)", async () => {
    const removed: string[] = [];
    const j = collect();
    const res = await runWorktreeGc({
      listDirs: async () => [dir("run-b")],
      facts: async () => facts(),
      isDirty: async () => true,
      remove: async (p) => {
        removed.push(p);
        return true;
      },
      journal: j.fn,
    });
    expect(removed).toEqual([]);
    expect(res.keptDirty).toBe(1);
    expect(j.journal[0].reason).toContain("SUJA");
  });

  it("erro ao medir a sujeira conta como SUJA — 'não consegui olhar' nunca vira 'está limpa'", async () => {
    const removed: string[] = [];
    const res = await runWorktreeGc({
      listDirs: async () => [dir("run-b")],
      facts: async () => facts(),
      isDirty: async () => {
        throw new Error("git morreu");
      },
      remove: async (p) => {
        removed.push(p);
        return true;
      },
    });
    expect(removed).toEqual([]);
    expect(res.keptDirty).toBe(1);
  });

  it("dryRun observa e não remove", async () => {
    const removed: string[] = [];
    const j = collect();
    const res = await runWorktreeGc({
      listDirs: async () => [dir("run-b")],
      facts: async () => facts(),
      isDirty: async () => false,
      remove: async (p) => {
        removed.push(p);
        return true;
      },
      journal: j.fn,
      dryRun: true,
    });
    expect(removed).toEqual([]);
    expect(res.removed).toBe(0);
    expect(j.journal[0].removed).toBe(false);
  });

  it("não conseguir LISTAR não remove nada e não lança — a varredura mora num tick que não pode cair", async () => {
    const res = await runWorktreeGc({
      listDirs: async () => {
        throw new Error("fs morreu");
      },
      facts: async () => facts(),
      isDirty: async () => false,
      remove: async () => true,
    });
    expect(res).toEqual({ scanned: 0, removed: 0, rescued: 0, keptDirty: 0, orphanDirs: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RESGATE + DEDUPE. Medido em produção (27/07, primeiro tick com o GC no ar): 5 árvores órfãs
// detectadas, 5 PRESERVADAS por sujeira, 0 removidas — e a linha repetindo a cada 2 minutos. O
// fail-closed estava certo e mesmo assim o GC era um no-op ruidoso.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("runWorktreeGc — salvar o byte antes de recolher a árvore", () => {
  const orphanRun = () => dir("run-b");
  const orphanGate = () => dir("gate-a");

  it("árvore ORIGINAL suja: COMMITA o trabalho e só então remove", async () => {
    const rescued: Array<[string, string]> = [];
    const removed: string[] = [];
    const res = await runWorktreeGc({
      listDirs: async () => [orphanRun()],
      facts: async () => facts(),
      isDirty: async () => true,
      rescue: async (p, b) => (rescued.push([p, b]), { rescued: true }),
      remove: async (p) => (removed.push(p), true),
    });
    expect(rescued).toEqual([["/repo/.worktrees/run-b", "run/b"]]); // o branch vem do NOME
    expect(removed).toEqual(["/repo/.worktrees/run-b"]);
    expect(res).toMatchObject({ removed: 1, rescued: 1, keptDirty: 0 });
  });

  it("árvore DERIVADA (gate) suja é removida SEM resgate — a sujeira dela é resíduo, não trabalho", async () => {
    let asked = 0;
    const removed: string[] = [];
    const res = await runWorktreeGc({
      listDirs: async () => [orphanGate()],
      facts: async () => facts(),
      isDirty: async () => true,
      rescue: async () => (asked++, { rescued: true }),
      remove: async (p) => (removed.push(p), true),
    });
    expect(asked).toBe(0); // nada a salvar: tudo reconstruível da entry
    expect(removed).toEqual(["/repo/.worktrees/gate-a"]);
    expect(res).toMatchObject({ removed: 1, rescued: 0 });
  });

  it("resgate que FALHA torna a árvore intocável — não conseguir salvar PROÍBE remover", async () => {
    const removed: string[] = [];
    const j: Array<Record<string, unknown>> = [];
    const res = await runWorktreeGc({
      listDirs: async () => [orphanRun()],
      facts: async () => facts(),
      isDirty: async () => true,
      rescue: async () => {
        throw new Error("secret-scan bloqueou o commit");
      },
      remove: async (p) => (removed.push(p), true),
      journal: (v) => void j.push(v as unknown as Record<string, unknown>),
    });
    expect(removed).toEqual([]); // a garantia
    expect(res).toMatchObject({ removed: 0, rescued: 0, keptDirty: 1 });
    expect(String(j[0].reason)).toContain("RESGATE FALHOU");
    expect(String(j[0].reason)).toContain("única cópia");
  });

  it("árvore original LIMPA não paga resgate nenhum", async () => {
    let asked = 0;
    const res = await runWorktreeGc({
      listDirs: async () => [orphanRun()],
      facts: async () => facts(),
      isDirty: async () => false,
      rescue: async () => (asked++, { rescued: true }),
      remove: async () => true,
    });
    expect(asked).toBe(0);
    expect(res).toMatchObject({ removed: 1, rescued: 0 });
  });
});

describe("runWorktreeGc — o log não repete a mesma não-notícia a cada 2 minutos", () => {
  it("a linha de uma árvore que FICA sai UMA vez por processo", async () => {
    const j: string[] = [];
    const seen = new Set<string>();
    const deps = {
      listDirs: async () => [dir("run-b")],
      facts: async () => facts(),
      isDirty: async () => true, // suja e sem resgate ⇒ fica, tick após tick
      remove: async () => true,
      journal: (v: { name: string }) => void j.push(v.name),
      journaledThisRun: seen,
    };
    await runWorktreeGc(deps);
    await runWorktreeGc(deps);
    await runWorktreeGc(deps);
    expect(j).toEqual(["run-b"]); // 3 ticks, 1 linha — antes eram 3 (e ~720/dia)
  });

  it("um EVENTO (remoção/resgate) fala SEMPRE — dedupe é para não-notícia, não para fato", async () => {
    const j: string[] = [];
    const seen = new Set<string>();
    const deps = {
      listDirs: async () => [dir("run-b")],
      facts: async () => facts(),
      isDirty: async () => false,
      remove: async () => true,
      journal: (v: { name: string }) => void j.push(v.name),
      journaledThisRun: seen,
    };
    await runWorktreeGc(deps);
    await runWorktreeGc(deps);
    expect(j).toEqual(["run-b", "run-b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// INCIDENTE 2026-07-27 — "pasta em .worktrees/" NÃO é "worktree".
//
// As 4 pastas `run-*` do runtime tinham o registro em `.git/worktrees/<id>` já podado: eram
// DIRETÓRIOS. E como ficam dentro do repo, todo `git -C <pasta>` subia e respondia sobre o repo
// PRINCIPAL — então o resgate commitou em `main`, com uma mensagem que promete `failed/run/<id>`, e a
// varredura anunciou "trabalho SALVO". Medir uma coisa e agir sobre outra.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("runWorktreeGc — a PRIMEIRA pergunta é 'isto é um worktree?'", () => {
  const probes = (registered: boolean) => {
    const touched: string[] = [];
    return {
      touched,
      deps: {
        listDirs: async () => [dir("run-b")],
        facts: async () => facts(),
        isRegisteredWorktree: async () => registered,
        isDirty: async () => (touched.push("isDirty"), true),
        rescue: async () => (touched.push("rescue"), { rescued: true }),
        remove: async () => (touched.push("remove"), true),
      },
    };
  };

  it("pasta NÃO registrada: nada é medido, resgatado ou removido", async () => {
    const { deps, touched } = probes(false);
    const res = await runWorktreeGc(deps);
    expect(touched).toEqual([]); // NENHUM git rodou lá dentro — é a correção inteira
    expect(res).toMatchObject({ orphanDirs: 1, removed: 0, rescued: 0, keptDirty: 0 });
  });

  it("a pasta órfã é rotulada e explicada, não silenciada", async () => {
    const j: Array<Record<string, unknown>> = [];
    const { deps } = probes(false);
    await runWorktreeGc({ ...deps, journal: (v) => void j.push(v as unknown as Record<string, unknown>) });
    expect(j[0].action).toBe("orphan-dir");
    expect(String(j[0].reason)).toContain("DIRETÓRIO órfão");
    expect(String(j[0].reason)).toContain("rm -rf"); // a saída é do humano, e está escrita
  });

  it("worktree REGISTRADO segue o caminho normal — a guarda não muda o caso saudável", async () => {
    const { deps, touched } = probes(true);
    const res = await runWorktreeGc(deps);
    expect(touched).toEqual(["isDirty", "rescue", "remove"]);
    expect(res).toMatchObject({ removed: 1, rescued: 1, orphanDirs: 0 });
  });

  it("sonda que EXPLODE conta como NÃO registrada — 'não consegui confirmar' nunca autoriza rodar git lá", async () => {
    const { deps, touched } = probes(true);
    const res = await runWorktreeGc({
      ...deps,
      isRegisteredWorktree: async () => {
        throw new Error("git morreu");
      },
    });
    expect(touched).toEqual([]);
    expect(res.orphanDirs).toBe(1);
  });

  it("sem a sonda, comportamento anterior (o chamador que não sabe perguntar)", async () => {
    const { deps, touched } = probes(true);
    const { isRegisteredWorktree, ...semSonda } = deps;
    void isRegisteredWorktree;
    await runWorktreeGc(semSonda);
    expect(touched).toEqual(["isDirty", "rescue", "remove"]);
  });
});
