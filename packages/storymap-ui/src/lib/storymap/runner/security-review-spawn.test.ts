import { describe, expect, it } from "vitest";

import { SECURITY_REVIEW_MODEL, TECHNICAL_AUDIT_MODEL, buildSecurityReviewArgs, reviewModelFor } from "./security-review-spawn";
import type { AutonomyPosture } from "./autonomy-sandbox";

// Só o contrato do modelo/esforço/teto por lente: o resto do spawn é exercitado pelos testes da prova de deploy.
const posture = { kind: "unsandboxed-escape", warn: "v" } as AutonomyPosture;

describe("o modelo de cada lente do revisor independente (só Sonnet e Opus; segurança em Opus)", () => {
  it("a lente de SEGURANÇA — o portão das rules em produção — roda em Opus; a auditoria técnica de uma entrega, em Sonnet", () => {
    expect(SECURITY_REVIEW_MODEL).toBe("opus");
    expect(TECHNICAL_AUDIT_MODEL).toBe("sonnet");
    expect(reviewModelFor()).toBe("opus");
    expect(reviewModelFor("security")).toBe("opus");
    expect(reviewModelFor("delivery")).toBe("sonnet");
  });

  it("o argv leva o modelo da lente e esforço high (em low o Sonnet 5.5 pode declarar pronto sem conferir)", () => {
    const sec = buildSecurityReviewArgs(posture, { prompt: "p", notePath: "/tmp/n.md", model: reviewModelFor("security"), lens: "security" }).args;
    expect(sec[sec.indexOf("--model") + 1]).toBe("opus");
    expect(sec[sec.indexOf("--effort") + 1]).toBe("high");
    const del = buildSecurityReviewArgs(posture, { prompt: "p", notePath: "/tmp/n.md", model: reviewModelFor("delivery"), lens: "delivery" }).args;
    expect(del[del.indexOf("--model") + 1]).toBe("sonnet");
    expect(del[del.indexOf("--effort") + 1]).toBe("high");
  });

  it("o teto de custo padrão acompanha o preço: 4 para a segurança em Opus, 2 para a auditoria em Sonnet", () => {
    const sec = buildSecurityReviewArgs(posture, { prompt: "p", notePath: "/tmp/n.md", model: "opus", lens: "security" }).args;
    expect(sec[sec.indexOf("--max-budget-usd") + 1]).toBe("4");
    const del = buildSecurityReviewArgs(posture, { prompt: "p", notePath: "/tmp/n.md", model: "sonnet", lens: "delivery" }).args;
    expect(del[del.indexOf("--max-budget-usd") + 1]).toBe("2");
  });
});
