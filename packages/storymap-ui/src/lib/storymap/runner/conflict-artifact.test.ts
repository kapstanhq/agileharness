import { describe, expect, it } from "vitest";
import {
  CONFLICT_HUNK_CAP,
  capArtifact,
  captureConflictArtifact,
  describeConflictArtifact,
  extractConflictHunks,
  parseApplyStderr,
  type CaptureDeps,
} from "./conflict-artifact";

const fakeDeps = (opts: {
  unmerged?: string[];
  files?: Record<string, string>;
  execThrows?: boolean;
}): CaptureDeps => ({
  exec: async () => {
    if (opts.execThrows) throw new Error("git morreu");
    return { stdout: (opts.unmerged ?? []).join("\n"), stderr: "" };
  },
  readFile: async (abs: string) => {
    const rel = abs.replace(/^\/tree\//, "");
    const content = opts.files?.[rel];
    if (content === undefined) throw new Error("ENOENT");
    return content;
  },
  join: (cwd, rel) => `${cwd}/${rel}`,
});

const conflicted = (ours: string, theirs: string) =>
  `linha de contexto\n<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs\nrodapé\n`;

describe("parseApplyStderr — a fonte que sobrevive ao apply que NÃO stageia nada", () => {
  it("extrai o caminho de `patch failed: <path>:<line>`", () => {
    const out = parseApplyStderr("error: patch failed: packages/app/src/a.ts:42\nerror: packages/app/src/a.ts: patch does not apply");
    expect(out).toEqual(["packages/app/src/a.ts"]);
  });

  it("extrai o caminho do erro de patch binário sem index line", () => {
    const out = parseApplyStderr("error: cannot apply binary patch to 'packages/app/icon.png' without full index line");
    expect(out).toEqual(["packages/app/icon.png"]);
  });

  it("dedupe entre formatos diferentes que nomeiam o MESMO arquivo", () => {
    const out = parseApplyStderr(
      ["error: patch failed: a.ts:1", "error: a.ts: patch does not apply", "error: patch failed: b.ts:9"].join("\n"),
    );
    expect(out).toEqual(["a.ts", "b.ts"]);
  });

  it("NUNCA inventa um caminho a partir de ruído — linha que não casa é ignorada", () => {
    expect(parseApplyStderr("Applying patch…\nwarning: 1 line adds whitespace errors\n")).toEqual([]);
    expect(parseApplyStderr("")).toEqual([]);
  });
});

describe("extractConflictHunks", () => {
  it("recorta a região entre os marcadores, com os marcadores", () => {
    const hunks = extractConflictHunks("a.ts", conflicted("const a = 1;", "const a = 2;"));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe("a.ts");
    expect(hunks[0].hunk).toContain("<<<<<<< ours");
    expect(hunks[0].hunk).toContain("const a = 1;");
    expect(hunks[0].hunk).toContain("const a = 2;");
    expect(hunks[0].hunk).toContain(">>>>>>> theirs");
    // o contexto de fora NÃO entra — o hunk é a divergência, não o arquivo
    expect(hunks[0].hunk).not.toContain("rodapé");
  });

  it("recorta VÁRIAS regiões do mesmo arquivo", () => {
    const content = conflicted("a1", "a2") + conflicted("b1", "b2");
    expect(extractConflictHunks("a.ts", content)).toHaveLength(2);
  });

  it("arquivo SEM marcadores devolve [] — é resposta, não falha", () => {
    expect(extractConflictHunks("a.ts", "const a = 1;\n")).toEqual([]);
  });

  it("capa o texto do hunk", () => {
    const big = conflicted("x".repeat(5000), "y".repeat(5000));
    const [hunk] = extractConflictHunks("a.ts", big);
    expect(hunk.hunk.length).toBe(CONFLICT_HUNK_CAP);
  });

  it("região ABERTA (sem marcador de fim) ainda é capturada — é a mais informativa que existe", () => {
    const truncatedFile = "ctx\n<<<<<<< ours\nlinha\n=======\noutra\n";
    const hunks = extractConflictHunks("a.ts", truncatedFile);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].hunk).toContain("=======");
  });

  it("abertura sem NENHUM separador não vira hunk (não é conflito, é texto que começa com <<<)", () => {
    expect(extractConflictHunks("a.md", "<<<<<<< isto é prosa\nnada mais\n")).toEqual([]);
  });
});

describe("capArtifact — o excedente é CONTADO, nunca cortado em silêncio", () => {
  it("conta os arquivos e hunks que ficaram de fora", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const hunks = files.map((f) => ({ file: f, hunk: "h" }));
    const art = capArtifact(files, hunks, { maxFiles: 3, maxHunks: 2 });
    expect(art.files).toHaveLength(3);
    expect(art.hunks).toHaveLength(2);
    expect(art.truncatedFiles).toBe(22);
    expect(art.truncatedHunks).toBe(23);
  });

  it("sem excedente, não carrega os contadores", () => {
    const art = capArtifact(["a.ts"], [{ file: "a.ts", hunk: "h" }]);
    expect(art.truncatedFiles).toBeUndefined();
    expect(art.truncatedHunks).toBeUndefined();
  });
});

describe("captureConflictArtifact — as DUAS fontes", () => {
  it("conflito de 3-way: lê os não-mergeados do índice E os hunks da árvore", async () => {
    const deps = fakeDeps({
      unmerged: ["packages/app/a.ts"],
      files: { "packages/app/a.ts": conflicted("nosso", "deles") },
    });
    const art = await captureConflictArtifact(deps, "/tree");
    expect(art.files).toEqual(["packages/app/a.ts"]);
    expect(art.hunks).toHaveLength(1);
    expect(art.hunks[0].hunk).toContain("nosso");
  });

  it("apply que RECUSA seco (índice limpo): o stderr é a única fonte, e ela responde", async () => {
    const deps = fakeDeps({ unmerged: [] });
    const art = await captureConflictArtifact(deps, "/tree", {
      applyStderr: "error: patch failed: packages/app/b.ts:10\nerror: packages/app/b.ts: patch does not apply",
    });
    expect(art.files).toEqual(["packages/app/b.ts"]);
    expect(art.hunks).toEqual([]); // sem marcadores para ler — e isso é honesto
  });

  it("une as duas fontes sem duplicar, com os não-mergeados PRIMEIRO (mais informativos sob o cap)", async () => {
    const deps = fakeDeps({
      unmerged: ["a.ts"],
      files: { "a.ts": conflicted("1", "2") },
    });
    const art = await captureConflictArtifact(deps, "/tree", {
      applyStderr: "error: patch failed: b.ts:1\nerror: patch failed: a.ts:1",
    });
    expect(art.files).toEqual(["a.ts", "b.ts"]);
  });

  it("git quebrado NÃO lança — degrada para a fonte do stderr", async () => {
    const deps = fakeDeps({ execThrows: true });
    const art = await captureConflictArtifact(deps, "/tree", { applyStderr: "error: patch failed: c.ts:3" });
    expect(art.files).toEqual(["c.ts"]);
  });

  it("arquivo ilegível some dos hunks mas PERMANECE em files — o nome é o essencial", async () => {
    const deps = fakeDeps({ unmerged: ["sumiu.ts"] }); // readFile joga ENOENT
    const art = await captureConflictArtifact(deps, "/tree");
    expect(art.files).toEqual(["sumiu.ts"]);
    expect(art.hunks).toEqual([]);
  });

  it("nada em lugar nenhum ⇒ artefato vazio (e o chamador mantém o detalhe original)", async () => {
    const art = await captureConflictArtifact(fakeDeps({ unmerged: [] }), "/tree");
    expect(art.files).toEqual([]);
    expect(describeConflictArtifact(art)).toBeUndefined();
  });
});

describe("describeConflictArtifact — a frase que substitui as nove palavras inúteis", () => {
  it("nomeia os arquivos e conta as regiões", () => {
    const text = describeConflictArtifact({
      files: ["a.ts", "b.ts"],
      hunks: [{ file: "a.ts", hunk: "h" }],
    });
    expect(text).toBe("diverge em: a.ts, b.ts · 1 região(ões) divergente(s)");
  });

  it("acima de 5 arquivos, resume com a contagem", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    expect(describeConflictArtifact({ files, hunks: [] })).toContain("(+2)");
  });

  it("sinaliza o que ficou além do teto", () => {
    expect(describeConflictArtifact({ files: ["a"], hunks: [], truncatedFiles: 9 })).toContain("[+9 além do teto]");
  });

  it("artefato ausente/vazio ⇒ undefined (nunca uma linha vazia fingindo informação)", () => {
    expect(describeConflictArtifact(undefined)).toBeUndefined();
    expect(describeConflictArtifact({ files: [], hunks: [] })).toBeUndefined();
  });
});
