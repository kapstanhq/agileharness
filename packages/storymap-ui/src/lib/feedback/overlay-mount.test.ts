import { describe, expect, it } from "vitest";

import { PATHNAME_HEADER, shouldMountOverlay } from "@/lib/feedback/overlay-mount";

describe("onde o overlay de feedback é montado", () => {
  it("NÃO monta na tela de login", () => {
    // Regressão direta: com o overlay montado ali, `/ah-overlay.js` é um recurso gateado, o portão
    // o redirecionava para /login e o navegador recusava o HTML como JS (ERR_BLOCKED_BY_ORB).
    expect(shouldMountOverlay("/login")).toBe(false);
  });

  it("monta nas superfícies que exigem sessão", () => {
    for (const p of ["/", "/board/acme/kanban", "/processes", "/perguntas", "/feedback-lab"]) {
      expect(shouldMountOverlay(p), p).toBe(true);
    }
  });

  it("não monta em nenhuma rota pública — a régua é a do portão, não um '/login' cravado", () => {
    for (const p of ["/login", "/api/health", "/api/auth/login"]) {
      expect(shouldMountOverlay(p), p).toBe(false);
    }
  });

  it("pathname desconhecido MONTA — o carimbo falhar não pode apagar o overlay do app inteiro", () => {
    expect(shouldMountOverlay(null)).toBe(true);
    expect(shouldMountOverlay(undefined)).toBe(true);
    expect(shouldMountOverlay("")).toBe(true);
  });

  it("o nome do header é minúsculo (Headers normaliza) e não colide com os do proxy", () => {
    expect(PATHNAME_HEADER).toBe(PATHNAME_HEADER.toLowerCase());
    expect(PATHNAME_HEADER.startsWith("x-forwarded")).toBe(false);
  });
});
