import { describe, expect, it } from "vitest";
import { decodeImageDataUrl, isShotSizeOk, isValidShotFilename, MAX_SHOT_BYTES, shotUrl } from "./shots";

// A 1x1 PNG (real magic bytes) — the smallest thing that survives the route's sniff.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("decodeImageDataUrl — the ONLY way bytes enter the shot store", () => {
  it("decodes a whitelisted png/jpeg/webp data URL", () => {
    const out = decodeImageDataUrl(`data:image/png;base64,${PNG_1X1}`);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out!.length).toBeGreaterThan(8);
    expect([out![0], out![1], out![2], out![3]]).toEqual([0x89, 0x50, 0x4e, 0x47]); // real PNG magic
  });

  it("rejects a NON-whitelisted image type (svg can carry script)", () => {
    expect(decodeImageDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(decodeImageDataUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toBeNull();
  });

  it("rejects non-image and junk payloads", () => {
    expect(decodeImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(decodeImageDataUrl("javascript:alert(1)")).toBeNull();
    expect(decodeImageDataUrl("https://evil.example/x.png")).toBeNull();
    expect(decodeImageDataUrl("")).toBeNull();
    expect(decodeImageDataUrl(null)).toBeNull();
    expect(decodeImageDataUrl(42)).toBeNull();
  });

  it("rejects a data URL whose base64 body carries non-base64 characters", () => {
    expect(decodeImageDataUrl("data:image/png;base64,<<<not base64>>>")).toBeNull();
  });
});

describe("shot filename + size guards (server-generated shape only)", () => {
  it("accepts the server-generated shape", () => {
    expect(isValidShotFilename("shot-1.png")).toBe(true);
    expect(isValidShotFilename("shot-12.webp")).toBe(true);
    expect(isValidShotFilename("shot-3.jpeg")).toBe(true);
  });

  it("rejects traversal, nesting and anything client-shaped", () => {
    expect(isValidShotFilename("../../etc/passwd")).toBe(false);
    expect(isValidShotFilename("shot-1.png/../../x")).toBe(false);
    expect(isValidShotFilename("a/shot-1.png")).toBe(false);
    expect(isValidShotFilename("shot-1.svg")).toBe(false); // not in the whitelist
    expect(isValidShotFilename("shot-.png")).toBe(false);
    expect(isValidShotFilename("")).toBe(false);
    expect(isValidShotFilename(null)).toBe(false);
  });

  it("caps the per-image size", () => {
    expect(isShotSizeOk(1024)).toBe(true);
    expect(isShotSizeOk(MAX_SHOT_BYTES)).toBe(true);
    expect(isShotSizeOk(MAX_SHOT_BYTES + 1)).toBe(false);
    expect(isShotSizeOk(0)).toBe(false);
    expect(isShotSizeOk(Number.NaN)).toBe(false);
  });
});

describe("shotUrl — the reference that lands on the card", () => {
  it("builds a same-origin, root-relative URL with encoded params", () => {
    const url = shotUrl("storymap", "abc123", "shot-1.png");
    expect(url.startsWith("/api/feedback/shot?")).toBe(true);
    expect(url).toContain("board=storymap");
    expect(url).toContain("batch=abc123");
    expect(url).toContain("file=shot-1.png");
    expect(url.startsWith("//")).toBe(false); // never protocol-relative
  });
});
