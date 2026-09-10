import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cardPath,
  designDir,
  designRefsDir,
  findRepoRoot,
  resolveBoundFilePath,
  runnerStateDir,
  sanitizeId,
  storymapDir,
  styleGuideMdPath,
} from "./paths";

// sanitizeId is the ONLY guard preventing a malicious/garbage card id from
// escaping the storymap data dir via path traversal. Every card/sidecar path
// routes its id through it, so a regression here is a filesystem-write security
// hole (the server writes .md/.json under whatever id reaches disk).
describe("sanitizeId — path-traversal guard", () => {
  it("strips dots and slashes (defeats ../ traversal)", () => {
    expect(sanitizeId("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeId("a/b\\c")).toBe("abc");
    expect(sanitizeId("..")).toBe("");
    expect(sanitizeId("./foo")).toBe("foo");
  });

  it("strips a drive letter / colon and absolute prefixes", () => {
    expect(sanitizeId("C:\\Windows\\System32")).toBe("CWindowsSystem32");
    expect(sanitizeId("/abs/path")).toBe("abspath");
  });

  it("returns '' for null/undefined (no crash)", () => {
    expect(sanitizeId(null as unknown as string)).toBe("");
    expect(sanitizeId(undefined as unknown as string)).toBe("");
  });

  it("truncates to 100 chars", () => {
    expect(sanitizeId("a".repeat(250))).toHaveLength(100);
  });

  it("keeps a legit kebab id intact", () => {
    expect(sanitizeId("story-foo-2")).toBe("story-foo-2");
    expect(sanitizeId("act-Avaliacao-de-Eventos")).toBe("act-Avaliacao-de-Eventos");
  });
});

// cardPath composes <root>/storymap/boards/<board>/cards/<id>.md routing BOTH
// the board and the card id through sanitizeId. Asserted cross-platform via
// path.basename so the test passes on win32 (\) and posix (/).
describe("cardPath — composes a sanitized, traversal-safe path", () => {
  it("a traversal id can never escape: no '..' survives and basename is safe", () => {
    const p = cardPath("acme", "../../evil");
    expect(p).not.toContain("..");
    expect(path.basename(p)).toBe("evil.md");
  });

  it("a malicious board id is sanitized too", () => {
    const p = cardPath("../../../secret", "story-x");
    expect(p).not.toContain("..");
    expect(path.basename(p)).toBe("story-x.md");
  });

  it("a normal id yields <id>.md under a cards/ dir", () => {
    const p = cardPath("acme", "story-foo-2");
    expect(path.basename(p)).toBe("story-foo-2.md");
    expect(p).toContain(`${path.sep}cards${path.sep}`);
  });
});

// Style Guide (bloco de Design, D2/D7/D12) — every path routes board/batch/container ids through
// sanitizeId (same traversal guard as cardPath), and the pointer in board.yaml carries NO path at
// all (D10's "racional do ponteiro sem path") — the canonical path is always DERIVED from the slug.
describe("Style Guide paths — traversal-safe, derived from the board slug (D10)", () => {
  it("styleGuideMdPath resolves under <board>/design/style-guide.md", () => {
    const p = styleGuideMdPath("acme");
    expect(path.basename(p)).toBe("style-guide.md");
    expect(p).toContain(`${path.sep}design${path.sep}`);
    expect(p).toContain(`${path.sep}acme${path.sep}`);
  });

  it("a malicious board id can never escape styleGuideMdPath", () => {
    const p = styleGuideMdPath("../../../secret");
    expect(p).not.toContain("..");
    expect(path.basename(p)).toBe("style-guide.md");
  });

  it("designRefsDir is per-batch (D12: refs are immutable per batch) and sanitizes both ids", () => {
    const p = designRefsDir("acme", "b7k2");
    expect(p).toContain(`${path.sep}design${path.sep}refs${path.sep}b7k2`);
    const traversal = designRefsDir("acme", "../../evil");
    expect(traversal).not.toContain("..");
  });
});

// SENTINELA do isolamento de estado. O redirecionamento de `storymap/.runner` para um temp dir
// (vitest.setup.ts) é invisível quando funciona — e quando quebra, quebra em SILÊNCIO: a suíte volta a
// escrever no estado do serviço vivo. Foi assim que fixtures de teste (board "acme", card "c1") entraram no
// diário do Jido e no ledger de auditoria, tornando a trilha do operador não-confiável. Este teste falha
// alto nesse dia, em vez de deixar a contaminação passar despercebida por semanas.
describe("runnerStateDir — isolamento do estado vivo durante os testes", () => {
  it("NÃO resolve para dentro do repositório enquanto a suíte roda", () => {
    const dir = runnerStateDir();
    const insideRepo = !path.relative(findRepoRoot(), dir).startsWith("..");
    expect(
      insideRepo,
      `runnerStateDir() resolveu para ${dir} — DENTRO do repo. A suíte está escrevendo no estado do serviço ` +
        `vivo (journal/budget/auditoria). Confira setupFiles + vitest.setup.ts (AGILEHARNESS_RUNNER_STATE_DIR).`,
    ).toBe(false);
    expect(dir).not.toBe(path.join(storymapDir(), ".runner"));
  });

  it("lê o override a CADA chamada (não o congela no load do módulo)", () => {
    // Se o valor fosse capturado no import, o setup do vitest chegaria tarde demais para metade dos módulos.
    const prev = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    try {
      process.env.AGILEHARNESS_RUNNER_STATE_DIR = "/tmp/storymap-state-a";
      expect(runnerStateDir()).toBe("/tmp/storymap-state-a");
      process.env.AGILEHARNESS_RUNNER_STATE_DIR = "/tmp/storymap-state-b";
      expect(runnerStateDir()).toBe("/tmp/storymap-state-b");
    } finally {
      process.env.AGILEHARNESS_RUNNER_STATE_DIR = prev;
    }
  });

  it("sem override, cai no diretório canônico do repo (o comportamento de PRODUÇÃO segue intacto)", () => {
    const prev = process.env.AGILEHARNESS_RUNNER_STATE_DIR;
    try {
      delete process.env.AGILEHARNESS_RUNNER_STATE_DIR;
      expect(runnerStateDir()).toBe(path.join(storymapDir(), ".runner"));
    } finally {
      process.env.AGILEHARNESS_RUNNER_STATE_DIR = prev;
    }
  });
});

describe("resolveBoundFilePath — repo-root-relative binding resolution (AgileHarness convention), package-guarded", () => {
  const ROOT = "/repo";
  it("resolves a repo-relative binding under the board's package (the WS-4 double-prefix regression)", () => {
    // A guide's tokenBindings.file — like package:/brandbook:/SystemDef.paths — is repo-ROOT-relative.
    // The prior resolver joined it to <root>/<pkg>/<file> → <root>/packages/acmeapp/packages/acmeapp/…
    // → "unreadable". It must resolve straight from the root instead.
    expect(resolveBoundFilePath(ROOT, "packages/acmeapp", "packages/acmeapp/web/tailwind.config.ts")).toBe(
      path.resolve("/repo/packages/acmeapp/web/tailwind.config.ts"),
    );
    expect(resolveBoundFilePath(ROOT, "packages/acmeapp", "packages/acmeapp/web/src/app/globals.css")).toBe(
      path.resolve("/repo/packages/acmeapp/web/src/app/globals.css"),
    );
  });
  it("does NOT resolve a bare PACKAGE-relative path — the convention is repo-root-relative", () => {
    // "web/globals.css" resolves to <root>/web/globals.css — OUTSIDE the package → null (documents the rule).
    expect(resolveBoundFilePath(ROOT, "packages/acmeapp", "web/globals.css")).toBeNull();
  });
  it("rejects a file outside the board's own package (a board binds only to its own tokens)", () => {
    expect(resolveBoundFilePath(ROOT, "packages/acmeapp", "packages/other/globals.css")).toBeNull();
  });
  it("rejects a traversal that escapes the package", () => {
    expect(resolveBoundFilePath(ROOT, "packages/acmeapp", "packages/acmeapp/../../secret.css")).toBeNull();
  });
  it("rejects a hostile charset in pkg or file (fail-closed to null, never throws)", () => {
    expect(resolveBoundFilePath(ROOT, "packages/acmeapp", "packages/acmeapp/x.css; rm -rf /")).toBeNull();
    expect(resolveBoundFilePath(ROOT, "pack ages/acmeapp", "packages/acmeapp/x.css")).toBeNull();
  });
});
