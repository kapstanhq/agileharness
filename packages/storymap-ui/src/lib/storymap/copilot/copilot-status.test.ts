// A VERDADE do Jido num board — a fonte única que o chip persistente, o tooltip e a confirmação de
// ativação usam. O bug que estes testes travam: "auto" aceso significando QUATRO coisas diferentes (agindo,
// inerte por falta de token, tick desarmado, ou só-leitura) sem o operador conseguir distinguir.

import { describe, it, expect } from "vitest";
import {
  composeModel,
  splitModelVariant,
  contextPressure,
  contextWindowForModel,
  CHAT_CONTEXT_WINDOW,
  CHAT_CONTEXT_WINDOW_1M,
  copilotStatus,
  formatAge,
  formatCountdown,
  formatTokens,
} from "./copilot-status";

const base = { enabled: true, orchTokenPresent: true, writeBoard: "auto" as const };

describe("copilotStatus", () => {
  it("off: não age sozinho — mas deixa CLARO que o chat continua funcionando", () => {
    const s = copilotStatus({ ...base, mode: "off" });
    expect(s.level).toBe("off");
    expect(s.inert).toBe(false);
    expect(s.detail).toMatch(/chat/i); // o rótulo "off" mentia: nunca desligou o chat
  });

  it("paired: sugere, não age", () => {
    expect(copilotStatus({ ...base, mode: "paired" }).level).toBe("paired");
  });

  it("autônomo com o tick global desarmado ⇒ INERTE (e o chip avisa)", () => {
    const s = copilotStatus({ ...base, mode: "autonomous", enabled: false });
    expect(s.level).toBe("auto-disarmed");
    expect(s.inert).toBe(true);
    expect(s.tone).toBe("warn");
  });

  it("autônomo sem o token do orquestrador ⇒ INERTE (o spawn é pulado)", () => {
    const s = copilotStatus({ ...base, mode: "autonomous", orchTokenPresent: false });
    expect(s.level).toBe("auto-inert");
    expect(s.inert).toBe(true);
    expect(s.detail).toMatch(/STORYMAP_MCP_TOKEN_ORCH/);
  });

  it("autônomo mas com write-board em `ask` ⇒ SÓ LEITURA (não é inerte: ele lê e pede aprovação)", () => {
    const s = copilotStatus({ ...base, mode: "autonomous", writeBoard: "ask" });
    expect(s.level).toBe("auto-readonly");
    expect(s.tone).toBe("warn");
    expect(s.inert).toBe(false);
  });

  it("autônomo, armado, com token e write-board:auto ⇒ agindo de verdade", () => {
    const s = copilotStatus({ ...base, mode: "autonomous" });
    expect(s.level).toBe("auto-active");
    expect(s.tone).toBe("ok");
    expect(s.inert).toBe(false);
  });

  it("Copiloto (deploy não-auto) ⇒ chip diz que ROTINAS são dele mas deploy/decisões param em você", () => {
    const s = copilotStatus({ ...base, mode: "autonomous", deploy: "ask" });
    expect(s.level).toBe("auto-active");
    expect(s.detail).toMatch(/deploy/i);
    expect(s.detail).toMatch(/produto|decis/i);
    // não pode mais afirmar que rodar/merge exigem o humano (o Copiloto os faz sozinho)
    expect(s.detail).not.toMatch(/resolver merge.*exig/i);
  });

  it("Autônomo (deploy:auto) ⇒ chip diz que PUBLICA sozinho", () => {
    const s = copilotStatus({ ...base, mode: "autonomous", deploy: "auto" });
    expect(s.level).toBe("auto-active");
    expect(s.label).toBe("publica");
    expect(s.detail).toMatch(/PUBLICA/);
  });

  it("a ordem dos gates é a do RUNTIME: tick desarmado ganha do token ausente", () => {
    // se ambos faltam, avisar do token seria enganoso — sem o tick nada roda de qualquer forma.
    const s = copilotStatus({ mode: "autonomous", enabled: false, orchTokenPresent: false, writeBoard: "auto" });
    expect(s.level).toBe("auto-disarmed");
  });
});

describe("formatCountdown", () => {
  it("segundos, minutos e horas", () => {
    expect(formatCountdown(40_000)).toBe("40s");
    expect(formatCountdown(12 * 60_000)).toBe("12min");
    expect(formatCountdown(95 * 60_000)).toBe("1h35");
  });
  it("já passou ⇒ 'agora' (nunca um número negativo na tela)", () => {
    expect(formatCountdown(-5_000)).toBe("agora");
    expect(formatCountdown(0)).toBe("agora");
  });
});

// ── O MEDIDOR da sessão do chat (contexto/idade) ──────────────────────────────────────────────────────────
describe("contextPressure — quando compactar ou limpar", () => {
  it("folgado ⇒ ok (sem alarme falso)", () => {
    const r = contextPressure(20_000);
    expect(r.pct).toBe(10);
    expect(r.tone).toBe("ok");
  });

  it("passando da metade ⇒ warn (sugere compactar)", () => {
    const r = contextPressure(120_000);
    expect(r.tone).toBe("warn");
    expect(r.advice).toMatch(/compactar/i);
  });

  it("quase cheio ⇒ danger (compacte ou comece de novo)", () => {
    const r = contextPressure(180_000);
    expect(r.pct).toBe(90);
    expect(r.tone).toBe("danger");
  });

  it("nunca passa de 100% nem fica negativo (a janela pode ser menor que o real)", () => {
    expect(contextPressure(500_000).pct).toBe(100);
    expect(contextPressure(-1).pct).toBe(0);
  });
});

describe("formatTokens / formatAge", () => {
  it("tokens compactos", () => {
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(1_240)).toBe("1.2k");
    expect(formatTokens(45_300)).toBe("45k");
  });
  it("idade legível", () => {
    expect(formatAge(30_000)).toBe("agora");
    expect(formatAge(12 * 60_000)).toBe("12min");
    expect(formatAge(3 * 3_600_000)).toBe("3h");
    expect(formatAge(50 * 3_600_000)).toBe("2d");
  });
});


// A janela era a constante chumbada 200_000, com um comentário que dizia "o CLI roda opus" enquanto o settings
// dizia sonnet. Na API todo modelo atual já é 1M — mas o CLI do Claude Code só entrega a janela longa quando o id
// pede a VARIANTE `[1m]`. Logo: janela é função do modelo, e a barra de contexto precisa medir contra a real.
describe("contextWindowForModel — a janela é do MODELO, não uma constante", () => {
  it("a variante [1m] entrega 1M (é assim que se pede contexto longo no CLI)", () => {
    expect(contextWindowForModel("claude-opus-4-8[1m]")).toBe(CHAT_CONTEXT_WINDOW_1M);
    expect(contextWindowForModel("opus[1m]")).toBe(CHAT_CONTEXT_WINDOW_1M);
  });

  it("sem a variante, a janela é a padrão — um `--model sonnet` seco NÃO liga o contexto longo", () => {
    expect(contextWindowForModel("sonnet")).toBe(CHAT_CONTEXT_WINDOW);
    expect(contextWindowForModel("claude-opus-4-8")).toBe(CHAT_CONTEXT_WINDOW);
  });

  it("modelo ausente/vazio cai no padrão (nunca NaN — a barra dividiria por lixo)", () => {
    expect(contextWindowForModel(undefined)).toBe(CHAT_CONTEXT_WINDOW);
    expect(contextWindowForModel("")).toBe(CHAT_CONTEXT_WINDOW);
  });

  it("a pressão mede contra a janela DADA — 300k tokens é 30% em 1M, não 100% estourado", () => {
    expect(contextPressure(300_000, contextWindowForModel("opus[1m]")).pct).toBe(30);
    expect(contextPressure(300_000, contextWindowForModel("sonnet")).pct).toBe(100);
  });
});

describe("splitModelVariant / composeModel — a janela é uma VARIANTE do id, não um modelo à parte", () => {
  it("separa base e variante", () => {
    expect(splitModelVariant("opus")).toEqual({ base: "opus", long: false });
    expect(splitModelVariant("opus[1m]")).toEqual({ base: "opus", long: true });
    expect(splitModelVariant("claude-opus-4-8[1M]")).toEqual({ base: "claude-opus-4-8", long: true });
    expect(splitModelVariant(undefined)).toEqual({ base: "", long: false });
  });

  it("compõe sem duplicar o sufixo", () => {
    expect(composeModel("opus", true)).toBe("opus[1m]");
    expect(composeModel("opus", false)).toBe("opus");
    expect(composeModel("opus[1m]", true)).toBe("opus[1m]"); // idempotente
    expect(composeModel("opus[1m]", false)).toBe("opus"); // desliga de verdade
  });

  it("o que a UI compõe é o que decide o teto da barra de contexto", () => {
    expect(contextWindowForModel(composeModel("opus", true))).toBe(1_000_000);
    expect(contextWindowForModel(composeModel("opus", false))).toBe(200_000);
  });
});
