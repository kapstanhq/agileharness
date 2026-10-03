import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = path.join(os.tmpdir(), "ws2-design-ref-route-test");
vi.mock("@/lib/storymap/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storymap/paths")>();
  return {
    ...actual,
    designRefsDir: (boardId: string, batchId: string) => path.join(TMP_ROOT, boardId, "refs", batchId),
  };
});

import { GET } from "./route";

afterEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

async function seedRef(boardId: string, batchId: string, filename: string, bytes: Buffer): Promise<void> {
  const dir = path.join(TMP_ROOT, boardId, "refs", batchId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), bytes);
}

function req(qs: string): Request {
  return new Request(`http://localhost/api/design/ref?${qs}`);
}

describe("GET /api/design/ref (D12)", () => {
  it("serves an existing ref with the right content-type", async () => {
    await seedRef("acme", "batch1", "ref-1.png", Buffer.from([1, 2, 3]));
    const res = await GET(req("board=acme&batch=batch1&file=ref-1.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf).toEqual(Buffer.from([1, 2, 3]));
  });

  it("404 for a ref that doesn't exist on disk (valid shape, absent file)", async () => {
    const res = await GET(req("board=acme&batch=batch1&file=ref-9.png"));
    expect(res.status).toBe(404);
  });

  it("400 on an invalid board id", async () => {
    const res = await GET(req("board=..%2F..%2Fetc&batch=batch1&file=ref-1.png"));
    expect(res.status).toBe(400);
  });

  it("400 on an invalid batch id", async () => {
    const res = await GET(req("board=acme&batch=..&file=ref-1.png"));
    expect(res.status).toBe(400);
  });

  it("400 on a path-traversal filename — the client's path NEVER becomes the served path", async () => {
    await seedRef("acme", "batch1", "ref-1.png", Buffer.from([1]));
    const res = await GET(req(`board=acme&batch=batch1&file=${encodeURIComponent("../../../etc/passwd")}`));
    expect(res.status).toBe(400);
  });

  it("400 on an extension outside the whitelist", async () => {
    const res = await GET(req("board=acme&batch=batch1&file=ref-1.svg"));
    expect(res.status).toBe(400);
  });

  it("400 when a query param is missing entirely", async () => {
    expect((await GET(req("board=acme&batch=batch1"))).status).toBe(400);
    expect((await GET(req("batch=batch1&file=ref-1.png"))).status).toBe(400);
  });
});
