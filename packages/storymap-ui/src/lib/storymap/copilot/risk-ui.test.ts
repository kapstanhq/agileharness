import { describe, it, expect } from "vitest";
import { dispositionsFor } from "./risk-ui";

describe("dispositionsFor — F3: o clamp do kernel fica visível na UI", () => {
  it("classes seguras oferecem auto/ask/never", () => {
    expect(dispositionsFor("write-board")).toEqual(["auto", "ask", "never"]);
    expect(dispositionsFor("read")).toEqual(["auto", "ask", "never"]);
  });
  it("F8 — run-free/destructive (NEVER_AUTO) oferecem só ask/never: a UI não oferece o que o kernel clampa", () => {
    expect(dispositionsFor("run-free")).toEqual(["ask", "never"]);
    expect(dispositionsFor("destructive")).toEqual(["ask", "never"]);
  });
  it("F8 — as classes do PIPELINE (run/merge/deploy) oferecem auto: o operador PODE conceder", () => {
    expect(dispositionsFor("run")).toEqual(["auto", "ask", "never"]);
    expect(dispositionsFor("merge-resolve")).toEqual(["auto", "ask", "never"]);
    expect(dispositionsFor("deploy")).toEqual(["auto", "ask", "never"]);
  });
});
