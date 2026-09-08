import { describe, expect, it } from "vitest";
import {
  batchIsFull,
  isRefSizeOk,
  isValidRefFilename,
  isValidSlugId,
  MAX_REF_BYTES,
  MAX_REFS_PER_BATCH,
  nextRefIndex,
  refContentType,
  sniffImageExt,
} from "./design-upload-guard";

describe("isValidSlugId — board/batch id guard", () => {
  it("accepts a plain slug", () => {
    expect(isValidSlugId("acme")).toBe(true);
    expect(isValidSlugId("a1b2c3")).toBe(true);
  });
  it("rejects empty/absent", () => {
    expect(isValidSlugId("")).toBe(false);
    expect(isValidSlugId(undefined)).toBe(false);
    expect(isValidSlugId(null)).toBe(false);
    expect(isValidSlugId(42)).toBe(false);
  });
  it("rejects anything sanitizeId would silently strip (path traversal, slashes, spaces)", () => {
    expect(isValidSlugId("..")).toBe(false);
    expect(isValidSlugId("../../etc")).toBe(false);
    expect(isValidSlugId("a/b")).toBe(false);
    expect(isValidSlugId("board id")).toBe(false);
    expect(isValidSlugId("board.id")).toBe(false);
  });
  it("rejects an oversized id (>100 chars)", () => {
    expect(isValidSlugId("a".repeat(101))).toBe(false);
    expect(isValidSlugId("a".repeat(100))).toBe(true);
  });
});

describe("isValidRefFilename — server-generated filename regex", () => {
  it("accepts the exact server-generated shape", () => {
    expect(isValidRefFilename("ref-1.png")).toBe(true);
    expect(isValidRefFilename("ref-12.jpg")).toBe(true);
    expect(isValidRefFilename("ref-3.jpeg")).toBe(true);
    expect(isValidRefFilename("ref-9.webp")).toBe(true);
  });
  it("rejects a client-supplied path — never the client's filename becomes the path", () => {
    expect(isValidRefFilename("../../../etc/passwd")).toBe(false);
    expect(isValidRefFilename("ref-1.png/../../secret")).toBe(false);
    expect(isValidRefFilename("/etc/passwd")).toBe(false);
    expect(isValidRefFilename("ref-1.png\0.jpg")).toBe(false);
  });
  it("rejects an extension outside the whitelist", () => {
    expect(isValidRefFilename("ref-1.gif")).toBe(false);
    expect(isValidRefFilename("ref-1.svg")).toBe(false);
    expect(isValidRefFilename("ref-1.heic")).toBe(false);
    expect(isValidRefFilename("ref-1.PNG")).toBe(false); // server always writes lowercase
  });
  it("rejects a malformed index or missing prefix", () => {
    expect(isValidRefFilename("ref-.png")).toBe(false);
    expect(isValidRefFilename("ref-1x.png")).toBe(false);
    expect(isValidRefFilename("1.png")).toBe(false);
    expect(isValidRefFilename("")).toBe(false);
  });
});

describe("sniffImageExt — magic bytes, never the client-declared mime", () => {
  it("recognizes a PNG signature", () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffImageExt(buf)).toBe("png");
  });
  it("recognizes a JPEG signature", () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    expect(sniffImageExt(buf)).toBe("jpg");
  });
  it("recognizes a WEBP (RIFF….WEBP) signature", () => {
    const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageExt(buf)).toBe("webp");
  });
  it("rejects a GIF, an SVG (text) and any other type outside the whitelist", () => {
    expect(sniffImageExt(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF89a
    expect(sniffImageExt(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImageExt(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // PE/EXE header
  });
  it("never throws on a short/empty buffer — a mislabeled 3-byte upload is just rejected", () => {
    expect(sniffImageExt(new Uint8Array([]))).toBeNull();
    expect(sniffImageExt(new Uint8Array([0xff]))).toBeNull();
  });
  it("a file claiming to be a PNG by client mime but whose BYTES are a script is rejected", () => {
    const fakePng = new TextEncoder().encode("#!/bin/sh\necho pwned\n");
    expect(sniffImageExt(fakePng)).toBeNull();
  });
});

describe("isRefSizeOk — the 500KB per-file cap", () => {
  it("accepts anything from 1 byte up to the cap", () => {
    expect(isRefSizeOk(1)).toBe(true);
    expect(isRefSizeOk(MAX_REF_BYTES)).toBe(true);
  });
  it("rejects 0 bytes and anything past the cap", () => {
    expect(isRefSizeOk(0)).toBe(false);
    expect(isRefSizeOk(MAX_REF_BYTES + 1)).toBe(false);
    expect(isRefSizeOk(-5)).toBe(false);
  });
});

describe("batchIsFull / nextRefIndex — the 12-refs-per-batch cap", () => {
  it("is not full below the cap, full at/above it", () => {
    expect(batchIsFull(0)).toBe(false);
    expect(batchIsFull(MAX_REFS_PER_BATCH - 1)).toBe(false);
    expect(batchIsFull(MAX_REFS_PER_BATCH)).toBe(true);
    expect(batchIsFull(MAX_REFS_PER_BATCH + 1)).toBe(true);
  });
  it("the 13th upload lands on a full batch", () => {
    // 12 refs already on disk (indices 1..12) → the 13th call sees existingRefCount=12 → full.
    expect(batchIsFull(12)).toBe(true);
    expect(nextRefIndex(12)).toBe(13); // the index it WOULD get, were the batch not full — route rejects first.
  });
  it("nextRefIndex is contiguous (1-based)", () => {
    expect(nextRefIndex(0)).toBe(1);
    expect(nextRefIndex(1)).toBe(2);
  });
});

describe("refContentType", () => {
  it("maps every whitelisted extension", () => {
    expect(refContentType("ref-1.png")).toBe("image/png");
    expect(refContentType("ref-1.jpg")).toBe("image/jpeg");
    expect(refContentType("ref-1.jpeg")).toBe("image/jpeg");
    expect(refContentType("ref-1.webp")).toBe("image/webp");
  });
  it("falls back to a safe generic type for anything unexpected", () => {
    expect(refContentType("ref-1")).toBe("application/octet-stream");
    expect(refContentType("ref-1.exe")).toBe("application/octet-stream");
  });
});
