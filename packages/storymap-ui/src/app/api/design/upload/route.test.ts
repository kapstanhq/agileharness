import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect designRefsDir to a tmp dir — a real board dir under storymap/boards/** would pollute the
// checkout and race listBoards()/board-base-pipeline's golden (same lesson as sidecars.test.ts).
const TMP_ROOT = path.join(os.tmpdir(), "ws2-design-upload-route-test");
vi.mock("@/lib/storymap/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storymap/paths")>();
  return {
    ...actual,
    designRefsDir: (boardId: string, batchId: string) => path.join(TMP_ROOT, boardId, "refs", batchId),
  };
});

import { POST } from "./route";

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function pngFile(bytes: Buffer = PNG_BYTES, name = "whatever-the-client-called-it.png"): File {
  // A client-supplied `File.type`/`.name` — the route must NEVER trust either for the write.
  // Wrapped in `new Uint8Array(...)`: @types/node's generic `Buffer<ArrayBufferLike>` isn't
  // structurally assignable to the dom lib's `BlobPart` — a plain Uint8Array is.
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function formWith(fields: Record<string, string | File>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

describe("POST /api/design/upload (D12)", () => {
  it("first call mints a batchId and writes ref-1.<ext>", async () => {
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", file: pngFile() }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.file).toBe("ref-1.png");
    expect(body.batchId).toMatch(/^[a-z0-9]+$/);
    expect(body.path).toBe(`refs/${body.batchId}/ref-1.png`);
  });

  it("a second call with the SAME batch id accumulates ref-2 in the same batch dir", async () => {
    const first = await (await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", file: pngFile() }) }))).json();
    const second = await (
      await POST(
        new Request("http://localhost/api/design/upload", {
          method: "POST",
          body: formWith({ board: "acme", batch: first.batchId, file: new File([JPG_BYTES], "x.jpg", { type: "image/jpeg" }) }),
        }),
      )
    ).json();
    expect(second.batchId).toBe(first.batchId);
    expect(second.file).toBe("ref-2.jpg");
    const dir = path.join(TMP_ROOT, "acme", "refs", first.batchId);
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(["ref-1.png", "ref-2.jpg"]));
  });

  it("400 on an invalid board id (path-traversal charset stripped by sanitizeId)", async () => {
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "../../etc", file: pngFile() }) }));
    expect(res.status).toBe(400);
  });

  it("400 on an invalid batch id", async () => {
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", batch: "..", file: pngFile() }) }));
    expect(res.status).toBe(400);
  });

  it("400 when 'file' is missing", async () => {
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme" }) }));
    expect(res.status).toBe(400);
  });

  it("413 when the file exceeds the 500KB cap", async () => {
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(500 * 1024)]);
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", file: new File([big], "big.png", { type: "image/png" }) }) }));
    expect(res.status).toBe(413);
  });

  it("415 when the CLIENT MIME lies — bytes are a script, not a PNG, despite type:'image/png'", async () => {
    const evil = new File([Buffer.from("#!/bin/sh\necho pwned\n")], "totally-a.png", { type: "image/png" });
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", file: evil }) }));
    expect(res.status).toBe(415);
  });

  it("415 on an unsupported real image type (GIF)", async () => {
    const gif = new File([Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], "x.gif", { type: "image/gif" });
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", file: gif }) }));
    expect(res.status).toBe(415);
  });

  it("413 on the 13th ref of a batch (12-ref cap)", async () => {
    let batchId: string | undefined;
    for (let i = 1; i <= 12; i++) {
      const fields: Record<string, string | File> = { board: "acme", file: pngFile() };
      if (batchId) fields.batch = batchId;
      const body = await (await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: formWith(fields) }))).json();
      batchId = body.batchId;
    }
    const res = await POST(
      new Request("http://localhost/api/design/upload", { method: "POST", body: formWith({ board: "acme", batch: batchId!, file: pngFile() }) }),
    );
    expect(res.status).toBe(413);
  });

  it("400 on a non-multipart body", async () => {
    const res = await POST(new Request("http://localhost/api/design/upload", { method: "POST", body: "not multipart" }));
    expect(res.status).toBe(400);
  });
});
