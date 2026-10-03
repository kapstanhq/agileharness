import { describe, it, expect } from "vitest";
import { activationNotice } from "./activation-notice";

describe("activationNotice — confirmação honesta da ativação", () => {
  const base = { enabled: true, orchTokenPresent: true, tickMinutes: 30 } as const;

  it("autonomous + armado + token + write-board:auto → OK, diz que vai agir + kick imediato", () => {
    const n = activationNotice({ ...base, mode: "autonomous", writeBoard: "auto" });
    expect(n.level).toBe("ok");
    expect(n.text).toContain("age sozinho");
    expect(n.text).toContain("30min");
    expect(n.text).toContain("disparei um agora");
  });

  it("autonomous com a matriz DEFAULT (write-board:ask) → WARN: ele só LÊ e pede aprovação", () => {
    // a mentira antiga: dizia "vai agir sozinho" mesmo com a matriz mandando toda escrita p/ aprovação humana.
    const n = activationNotice({ ...base, mode: "autonomous" });
    expect(n.level).toBe("warn");
    expect(n.text).toContain("SÓ LEITURA");
  });

  it("autonomous SEM token → WARN inerte (a realidade de hoje)", () => {
    const n = activationNotice({ ...base, mode: "autonomous", orchTokenPresent: false });
    expect(n.level).toBe("warn");
    expect(n.text).toContain("INERTE");
    expect(n.text).toContain("AGILEHARNESS_MCP_TOKEN_ORCH");
  });

  it("autonomous com tick global desarmado → WARN (precede o aviso de token)", () => {
    const n = activationNotice({ ...base, mode: "autonomous", enabled: false, orchTokenPresent: false });
    expect(n.level).toBe("warn");
    expect(n.text).toContain("DESARMADO");
  });

  it("paired → confirma que o humano dirige", () => {
    expect(activationNotice({ ...base, mode: "paired" })).toEqual({ level: "ok", text: expect.stringContaining("você dirige") });
  });

  it("off → confirma desligado", () => {
    expect(activationNotice({ ...base, mode: "off" }).text).toContain("desligado");
  });
});
