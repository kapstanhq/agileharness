import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// story-cl1mi9: writeBugScreenshots writes under bugsDir(). Redirect it to a tmp dir so the test
// NEVER writes under storymap/boards/** — a real board dir would race listBoards() in the parallel
// board-base-pipeline golden test and make it flaky. Extended (bloco de Design WS-0) with the
// design/ path functions so readStyleGuide/writeStyleGuide get the SAME redirection.
const TMP_ROOT = path.join(os.tmpdir(), "cl1mi9-sidecars-test");
vi.mock("./paths", () => ({
  bugsDir: (boardId: string, cardId: string) => path.join(TMP_ROOT, boardId, cardId),
  designDir: (boardId: string) => path.join(TMP_ROOT, boardId, "design"),
  styleGuideMdPath: (boardId: string) => path.join(TMP_ROOT, boardId, "design", "style-guide.md"),
}));

import {
  coerceProposalDoc,
  readStyleGuide,
  writeBugScreenshots,
  writeStyleGuide,
} from "./sidecars";
import { coerceStyleGuideDoc, isEmptyStyleGuideDoc } from "./style-guide";

// F4 — o sidecar de proposta era LOSSY: o read descartava addresses/body/narrative/acceptance + o
// OST-light, fazendo o caminho assíncrono (Inbox) mostrar/criar menos que o síncrono. Aqui travamos
// a fidelidade total do round-trip de leitura.
describe("coerceProposalDoc — fidelidade total (F4)", () => {
  it("reidrata addresses/body/narrative/acceptance + OST-light", () => {
    const raw = {
      summary: "resumo",
      items: [
        {
          tempId: "i1",
          type: "idea",
          title: "Dor central",
          candidateSolutions: ["skeleton", "optimistic render"],
          keyAssumption: "a lentidão vem do layout",
          successSignal: "tempo até o feed personalizado",
          valueSize: { reach: 100, impact: 2 },
        },
        {
          tempId: "i2",
          type: "story",
          title: "Ver feed personalizado",
          storyType: "user",
          parent: "i1",
          addresses: "i1",
          body: "contexto e decisões",
          narrative: { role: "usuário", want: "ver o feed certo", soThat: "não perder tempo" },
          acceptance: ["Dado que carrego, então vejo o curado"],
        },
      ],
    };
    const doc = coerceProposalDoc("c1", raw);
    const idea = doc.items[0];
    expect(idea.candidateSolutions).toEqual(["skeleton", "optimistic render"]);
    expect(idea.keyAssumption).toBe("a lentidão vem do layout");
    expect(idea.successSignal).toBe("tempo até o feed personalizado");
    expect(idea.valueSize).toEqual({ reach: 100, impact: 2 });
    const story = doc.items[1];
    expect(story.addresses).toBe("i1");
    expect(story.body).toBe("contexto e decisões");
    expect(story.narrative).toEqual({ role: "usuário", want: "ver o feed certo", soThat: "não perder tempo" });
    expect(story.acceptance).toEqual(["Dado que carrego, então vejo o curado"]);
  });

  it("omite os campos esparsos quando ausentes (card lean)", () => {
    const doc = coerceProposalDoc("c1", { items: [{ tempId: "i1", type: "story", title: "T" }] });
    const it = doc.items[0];
    expect(it.addresses).toBeUndefined();
    expect(it.body).toBeUndefined();
    expect(it.narrative).toBeUndefined();
    expect(it.candidateSolutions).toBeUndefined();
    expect(it.valueSize).toBeUndefined();
  });

  it("1.6 — preserva tasks pré-semeadas no round-trip do sidecar (WS7 umbrella; espelha parse.ts)", () => {
    const doc = coerceProposalDoc("c1", {
      items: [
        {
          tempId: "i1",
          type: "story",
          title: "Umbrella",
          tasks: [{ id: "a", title: "T1" }, { title: "T2" }, "T3", { title: "  " }, 42],
        },
      ],
    });
    // {id,title} kept · {title} kept · bare string coerced to {title} · empty-title + off-shape dropped
    expect(doc.items[0].tasks).toEqual([{ id: "a", title: "T1" }, { title: "T2" }, { title: "T3" }]);
  });

  it("1.6 — story sem tasks → campo ausente (lean, não cria [])", () => {
    const doc = coerceProposalDoc("c1", { items: [{ tempId: "i1", type: "story", title: "T" }] });
    expect(doc.items[0].tasks).toBeUndefined();
  });

  it("preserva o MODO estender (targetCardId) — sem ele o item degrada para 'cria um card novo'", () => {
    const doc = coerceProposalDoc("c1", {
      items: [{ tempId: "i1", type: "story", title: "Mais trabalho no selo", targetCardId: "story-x", tasks: ["T1"] }],
    });
    expect(doc.items[0].targetCardId).toBe("story-x");
  });

  it("preserva o sinal de incerteza da classificação (confidence/ambiguous) — é o que pede desambiguação", () => {
    const doc = coerceProposalDoc("c1", {
      items: [
        { tempId: "i1", type: "story", title: "Incerto", confidence: 0.45, ambiguous: true },
        { tempId: "i2", type: "story", title: "Certo" },
      ],
    });
    expect(doc.items[0].confidence).toBe(0.45);
    expect(doc.items[0].ambiguous).toBe(true);
    // ausente = alta confiança: nada de default 0/false que ligaria o ⚠ em todo item
    expect(doc.items[1].confidence).toBeUndefined();
    expect(doc.items[1].ambiguous).toBeUndefined();
  });
});

// story-cl1mi9: multi-image evidence for a captured bug. writeBugScreenshots decodes N data URLs to
// bugs/<id>/context-N.<ext>, skips invalid/empty entries (contiguous numbering), and returns the
// stored filenames — distinct from writeBugScreenshot's single current.<ext>.
describe("writeBugScreenshots — persists N context images (story-cl1mi9)", () => {
  afterEach(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  });

  const PNG = "data:image/png;base64,iVBORw0KGgo="; // small valid-ish png header bytes
  const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

  it("writes context-N.<ext> for each valid data URL and returns the filenames", async () => {
    const files = await writeBugScreenshots("b1", "story-x", [PNG, JPG]);
    expect(files).toEqual(["context-1.png", "context-2.jpg"]);
    // the bytes actually landed on disk under the (redirected) bug dir
    const dir = path.join(TMP_ROOT, "b1", "story-x");
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(["context-1.png", "context-2.jpg"]));
  });

  it("skips invalid entries and numbers the survivors contiguously", async () => {
    const files = await writeBugScreenshots("b1", "story-y", ["not-a-data-url", PNG, "", JPG]);
    expect(files).toEqual(["context-1.png", "context-2.jpg"]);
  });

  it("returns [] and creates no dir for an empty/all-invalid input", async () => {
    const files = await writeBugScreenshots("b1", "story-z", ["nope", ""]);
    expect(files).toEqual([]);
    await expect(fs.readdir(path.join(TMP_ROOT, "b1", "story-z"))).rejects.toThrow();
  });
});

// Style Guide (bloco de Design WS-0, D2/D3/D7) — sidecar IO round-trips. writeStyleGuide NEVER
// persists raw bytes (D3): it always regrows design/style-guide.md via compileStyleGuideMd, so a
// read-back is the fixed point of the kernel's own compile/parse pair (proved standalone in
// style-guide.test.ts) — here we only prove the FILE round-trips through the real filesystem.
describe("readStyleGuide / writeStyleGuide (D2/D3)", () => {
  afterEach(async () => {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  });

  it("a board with no guide yet reads as null (no crash)", async () => {
    expect(await readStyleGuide("board-sem-guia")).toBeNull();
  });

  it("ROUND-TRIPs a doc through the real filesystem (compile → write → read → parse)", async () => {
    const doc = coerceStyleGuideDoc({
      meta: { version: 1, updatedAt: "2026-07-15", sources: { refs: [] } },
      identity: { school: "editorial urbano", personality: ["direto"], prose: "" },
      color: { tokens: [{ role: "primary", value: "#FF4F00", on: "#FFFFFF", usage: "cta" }] },
    });
    await writeStyleGuide("board-x", doc);
    const read = await readStyleGuide("board-x");
    expect(read).toEqual(doc);
    // and the bytes on disk carry the GERADO warning + the frontmatter delimiter (D2: machine+prose).
    const raw = await fs.readFile(path.join(TMP_ROOT, "board-x", "design", "style-guide.md"), "utf8");
    expect(raw).toMatch(/^<!-- GERADO/);
    expect(raw).toContain("---\n");
  });

  it("a re-write REPLACES the file deterministically (no stale content survives)", async () => {
    await writeStyleGuide("board-y", coerceStyleGuideDoc({ identity: { school: "escola 1" } }));
    await writeStyleGuide("board-y", coerceStyleGuideDoc({ identity: { school: "escola 2" } }));
    const read = await readStyleGuide("board-y");
    expect(read?.identity.school).toBe("escola 2");
  });

  it("a corrupted/truncated file on disk degrades to a coerced doc, never throws", async () => {
    const dir = path.join(TMP_ROOT, "board-z", "design");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "style-guide.md"), "not a compiled guide at all", "utf8");
    const read = await readStyleGuide("board-z");
    expect(read).not.toBeNull();
    expect(isEmptyStyleGuideDoc(read!)).toBe(true);
  });
});

