import { describe, expect, it } from "vitest";
import { currentMcpActor, isScopedActor, runWithMcpActor, transitionActorLabel } from "./actor";

describe("mcp actor (F5.1) — AsyncLocalStorage identity", () => {
  it("currentMcpActor is undefined outside a request context (internal call → fail-open)", () => {
    expect(currentMcpActor()).toBeUndefined();
    expect(isScopedActor()).toBe(false);
    expect(transitionActorLabel()).toBe("human");
  });

  it("propagates the actor through the sync + async chain", async () => {
    await runWithMcpActor({ level: "write", tokenEnv: "STORYMAP_MCP_TOKEN_ORCH" }, async () => {
      expect(currentMcpActor()).toEqual({ level: "write", tokenEnv: "STORYMAP_MCP_TOKEN_ORCH" });
      expect(isScopedActor()).toBe(true);
      expect(transitionActorLabel()).toBe("run:orch");
      // survives an await (the ALS store rides the async chain)
      await Promise.resolve();
      expect(isScopedActor()).toBe(true);
    });
    // store is gone after the callback returns
    expect(currentMcpActor()).toBeUndefined();
  });

  it("a `full` operator token is NOT a scoped actor (the guard must not gate the human)", () => {
    runWithMcpActor({ level: "full", tokenEnv: "STORYMAP_MCP_TOKEN" }, () => {
      expect(isScopedActor()).toBe(false);
      expect(transitionActorLabel()).toBe("human");
    });
  });

  it("a `ro` token is scoped too (read-only agent still isn't the operator)", () => {
    runWithMcpActor({ level: "ro" }, () => {
      expect(isScopedActor()).toBe(true);
      expect(transitionActorLabel()).toBe("run:orch");
    });
  });
});
