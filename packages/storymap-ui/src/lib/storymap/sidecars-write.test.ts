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
    // O conteúdo de `wireframes` precisa ser um doc JSON: desde o conductor-core o write VALIDA esse kind
    // (wireframe-html/validate.ts — um html que o canvas degradaria em silêncio é recusado com o motivo). O
    // assunto AQUI segue sendo o path derivado + o byte-a-byte gravado, por isso cada kind leva um conteúdo
    // que ele aceita e a asserção compara exatamente esse conteúdo.
    const cases: Array<[(typeof SIDECAR_KINDS)[number], string, string]> = [
      ["plans", "plans/story-abc123.md", "conteúdo"],
      ["wireframes", "wireframes/story-abc123.json", '{"cardId":"story-abc123","options":[],"note":"conteúdo"}'],
      ["proposals", "proposals/story-abc123.json", "conteúdo"],
    ];
    for (const [kind, expected, content] of cases) {
      const res = await writeSidecarByKind("acme", "story-abc123", kind, content);
      expect(res.path, `kind ${kind}`).toBe(expected);
      expect(await fs.readFile(sidecarPathForKind(kind, "acme", "story-abc123"), "utf8")).toBe(content);
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

// conductor-core — o write de `wireframes` VALIDA os artefatos html: o que o canvas degradaria em silêncio
// (html acima do teto → só texto; format html sem html → só texto) é RECUSADO com o artefato nomeado, e nada
// é gravado; o que a sanitização remove mas sobrevive vira AVISO na resposta.
describe("write_sidecar (wireframes) — o html é validado na escrita", () => {
  const doc = (artifact: Record<string, unknown>) =>
    JSON.stringify({ cardId: "story-abc123", status: "draft", options: [], artifacts: [{ id: "variante-a", kind: "screen", title: "A", ...artifact }] });

  it("html acima do teto por artefato: recusado nomeando o artefato, e o arquivo NÃO é escrito", async () => {
    const big = `<div>${"x".repeat(33 * 1024)}</div>`;
    await expect(writeSidecarByKind("acme", "story-abc123", "wireframes", doc({ format: "html", html: big }))).rejects.toThrow(
      /variante-a.*teto/,
    );
    await expect(fs.readFile(sidecarPathForKind("wireframes", "acme", "story-abc123"), "utf8")).rejects.toThrow();
  });

  it("format html SEM html: recusado (o canvas mostraria só texto)", async () => {
    await expect(writeSidecarByKind("acme", "story-abc123", "wireframes", doc({ format: "html" }))).rejects.toThrow(/variante-a.*html/);
  });

  it("html que a sanitização reduz a NADA: recusado", async () => {
    await expect(
      writeSidecarByKind("acme", "story-abc123", "wireframes", doc({ format: "html", html: "<script>x()</script><iframe src=a></iframe>" })),
    ).rejects.toThrow(/sanitiza/);
  });

  it("html válido com vetores removíveis: grava e AVISA", async () => {
    const res = await writeSidecarByKind(
      "acme",
      "story-abc123",
      "wireframes",
      doc({ format: "html", viewport: "mobile", html: `<div style="width:1200px">tela</div><script>x()</script>` }),
    );
    expect(res.path).toBe("wireframes/story-abc123.json");
    expect(res.warnings?.join("\n")).toMatch(/script/);
    expect(res.warnings?.join("\n")).toMatch(/1200px/);
  });

  it("JSON inválido: recusado com o motivo", async () => {
    await expect(writeSidecarByKind("acme", "story-abc123", "wireframes", "{ não é json")).rejects.toThrow(/JSON/);
  });
});
