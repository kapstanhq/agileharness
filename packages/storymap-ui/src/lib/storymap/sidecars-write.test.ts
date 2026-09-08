import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// WS-3.2 — testes de write_sidecar (a superfície MCP que torna a política D4 CUMPRÍVEL).
//
// Arquivo próprio (e não sidecars.test.ts) porque aquele mocka `./paths` com um STUB PARCIAL — só as
// 5 funções de que precisa —, e tudo o que write_sidecar usa (planPath/wireframePath/proposalPath/
// boardDir/sanitizeId) sairia `undefined` lá dentro.
//
// O mock aqui espalha o módulo REAL e relocaliza APENAS A RAIZ (para um tmp, jamais storymap/boards/**
// vivo — um dir de board real ainda por cima corre com o golden de board-base-pipeline e o deixa
// flaky). O que está SOB TESTE — `sanitizeId`, a defesa de verdade contra traversal — permanece o
// real: as overrides o chamam. Um mock que reimplementasse a sanitização estaria testando a si mesmo.
const TMP_ROOT = path.join(os.tmpdir(), "ws3-sidecar-write-test");
vi.mock("./paths", async (importOriginal) => {
  const real = await importOriginal<typeof import("./paths")>();
  const boardDir = (boardId: string) => path.join(TMP_ROOT, real.sanitizeId(boardId));
  return {
    ...real,
    boardDir,
    planPath: (b: string, c: string) => path.join(boardDir(b), "plans", `${real.sanitizeId(c)}.md`),
    wireframePath: (b: string, c: string) => path.join(boardDir(b), "wireframes", `${real.sanitizeId(c)}.json`),
    proposalPath: (b: string, c: string) => path.join(boardDir(b), "proposals", `${real.sanitizeId(c)}.json`),
  };
});

import { SIDECAR_KINDS, MAX_SIDECAR_BYTES, sidecarPathForKind, writeSidecarByKind } from "./sidecars";

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("write_sidecar — o path é DERIVADO, nunca aceito do chamador (WS-3.2)", () => {
  it("grava cada kind da allowlist no path canônico do board", async () => {
    const cases: Array<[(typeof SIDECAR_KINDS)[number], string]> = [
      ["plans", "plans/story-abc123.md"],
      ["wireframes", "wireframes/story-abc123.json"],
      ["proposals", "proposals/story-abc123.json"],
    ];
    for (const [kind, expected] of cases) {
      const res = await writeSidecarByKind("acme", "story-abc123", kind, "conteúdo");
      expect(res.path, `kind ${kind}`).toBe(expected);
      expect(await fs.readFile(sidecarPathForKind(kind, "acme", "story-abc123"), "utf8")).toBe("conteúdo");
    }
  });

  it("um cardId de TRAVERSAL não escapa do dir do board — o id sanitizado vira um nome comum", async () => {
    const evil = "../../../../etc/passwd";
    const derived = sidecarPathForKind("plans", "acme", evil);
    const boardRoot = path.join(TMP_ROOT, "acme");

    // A asserção que importa: o path derivado está CONTIDO no board, com traversal nenhum sobrando.
    expect(path.relative(boardRoot, derived).startsWith("..")).toBe(false);
    expect(derived).not.toContain("..");
    expect(derived.startsWith(boardRoot + path.sep)).toBe(true);

    // E o efeito real em disco: escreve dentro do board, e /etc/passwd continua intocado.
    const res = await writeSidecarByKind("acme", evil, "plans", "não deveria escapar");
    expect(res.path.startsWith("plans/")).toBe(true);
    expect(res.path).not.toContain("..");
    expect(await fs.readFile(derived, "utf8")).toBe("não deveria escapar");
  });

  it("um BOARD de traversal também é neutralizado (a raiz do tmp contém tudo)", async () => {
    const res = await writeSidecarByKind("../../evil", "story-abc123", "plans", "x");
    expect(res.path).toBe("plans/story-abc123.md");
    const derived = sidecarPathForKind("plans", "../../evil", "story-abc123");
    expect(path.relative(TMP_ROOT, derived).startsWith("..")).toBe(false);
  });

  it("recusa um kind fora da allowlist (sem escrever nada)", async () => {
    await expect(writeSidecarByKind("acme", "story-abc123", "cards", "id: hack")).rejects.toThrow(/kind inválido/);
    // `cards` seria a superfície perigosa (o card é escrito por update_card, com lock); board.yaml idem.
    await expect(writeSidecarByKind("acme", "story-abc123", "../cards", "x")).rejects.toThrow(/kind inválido/);
    await expect(writeSidecarByKind("acme", "story-abc123", "board.yaml", "x")).rejects.toThrow(/kind inválido/);
    await expect(fs.readdir(TMP_ROOT)).rejects.toThrow(); // nada foi criado
  });

  it("recusa id vazio / que some na sanitização", async () => {
    await expect(writeSidecarByKind("acme", "", "plans", "x")).rejects.toThrow(/obrigatórios/);
    await expect(writeSidecarByKind("", "story-abc123", "plans", "x")).rejects.toThrow(/obrigatórios/);
    await expect(writeSidecarByKind("acme", "///", "plans", "x")).rejects.toThrow(/obrigatórios/);
  });

  it("recusa conteúdo acima do teto (e o teto conta BYTES, não chars)", async () => {
    await expect(
      writeSidecarByKind("acme", "story-abc123", "plans", "a".repeat(MAX_SIDECAR_BYTES + 1)),
    ).rejects.toThrow(/grande demais/);
    // "é" = 2 bytes em utf8 → um conteúdo com metade dos chars do teto ainda estoura
    await expect(
      writeSidecarByKind("acme", "story-abc123", "plans", "é".repeat(MAX_SIDECAR_BYTES / 2 + 1)),
    ).rejects.toThrow(/grande demais/);
  });

  it("substitui o sidecar existente e reporta os bytes escritos", async () => {
    await writeSidecarByKind("acme", "story-abc123", "plans", "v1");
    const res = await writeSidecarByKind("acme", "story-abc123", "plans", "v2 — mais longo");
    expect(await fs.readFile(sidecarPathForKind("plans", "acme", "story-abc123"), "utf8")).toBe("v2 — mais longo");
    expect(res.bytes).toBe(Buffer.byteLength("v2 — mais longo", "utf8"));
  });

  it("é atômico: nenhum .tmp sobra no dir do sidecar", async () => {
    await writeSidecarByKind("acme", "story-abc123", "wireframes", JSON.stringify({ options: [] }));
    const entries = await fs.readdir(path.join(TMP_ROOT, "acme", "wireframes"));
    expect(entries).toEqual(["story-abc123.json"]);
  });
});
