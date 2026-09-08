// A POLÍTICA de entrega de texto num pane tmux (`planSessionDelivery`) — o núcleo puro do fix F1.
//
// O defeito que estes testes travam: `claude_send` entregava tudo com `send-keys -l` cru, então um
// prompt multi-linha virava N submits num agente Claude e N COMANDOS EXECUTADOS num shell `cop-*`.
//
// ⚠️ Todo byte de controle neste arquivo vai como ESCAPE (`\x1b`, `\x00`), nunca literal: um NUL cru
// num arquivo versionado quebra o split do merge train.

import { describe, expect, it } from "vitest";
import { classifyListSessions, isMasterSessionName, planSessionDelivery, sanitizeTerminalText,
  planKeySequence,
  TECLAS_PERMITIDAS,
  MAX_TECLAS_POR_CHAMADA,
} from "./tmux";

const ESC = "\x1b";
const NUL = "\x00";
const BEL = "\x07";
const DEL = "\x7f";
const CR = "\r";

const CLAUDE = { runsClaude: true, isMaster: false };
const SHELL = { runsClaude: false, isMaster: false };

describe("sanitizeTerminalText", () => {
  it("mantém tab, newline e texto imprimível", () => {
    expect(sanitizeTerminalText("oi\tmundo\nlinha 2")).toBe("oi\tmundo\nlinha 2");
  });

  it("derruba ESC — é o que impede forjar os marcadores de bracketed paste", () => {
    // `ESC[201~` é o TERMINADOR do bracketed paste: sobrevivendo o ESC, o payload sairia do bloco inerte.
    expect(sanitizeTerminalText(`antes${ESC}[201~depois`)).toBe("antes[201~depois");
  });

  it("derruba os demais controles C0 e o DEL", () => {
    expect(sanitizeTerminalText(`a${NUL}b${BEL}c${DEL}d`)).toBe("abcd");
  });

  it("derruba o CR — sozinho ele também submete num REPL", () => {
    expect(sanitizeTerminalText(`a${CR}b`)).toBe("ab");
  });

  it("preserva acentos e emoji (code points fora do BMP não são controle)", () => {
    expect(sanitizeTerminalText("ação 🚀")).toBe("ação 🚀");
  });
});

describe("planSessionDelivery — alvo é um agente Claude", () => {
  it("entrega multi-linha como UMA colagem, nunca fatiada em vários submits", () => {
    expect(planSessionDelivery(CLAUDE, "primeira linha\nsegunda linha\nterceira")).toMatchObject({
      ok: true,
      mode: "paste",
      lines: 3,
    });
  });

  it("usa colagem também para uma linha só (não há caso em que digitar seja melhor)", () => {
    expect(planSessionDelivery(CLAUDE, "oi")).toMatchObject({ ok: true, mode: "paste", lines: 1 });
  });

  it("não exige multiline: o consentimento existe por causa do SHELL, não do agente", () => {
    expect(planSessionDelivery(CLAUDE, "a\nb").ok).toBe(true);
  });
});

describe("planSessionDelivery — alvo é um shell", () => {
  it("RECUSA multi-linha sem consentimento, e a recusa diz que cada linha executa", () => {
    const plan = planSessionDelivery(SHELL, "cd /tmp\necho ok");
    if (plan.ok) throw new Error("esperava recusa");
    expect(plan.reason).toContain("SHELL");
    expect(plan.reason).toContain("multiline:true");
  });

  it("aceita multi-linha COM consentimento explícito", () => {
    expect(planSessionDelivery(SHELL, "cd /tmp\nls", { multiline: true })).toMatchObject({
      ok: true,
      mode: "keys",
      lines: 2,
    });
  });

  it("uma linha só passa direto — é o fluxo term_new normal", () => {
    expect(planSessionDelivery(SHELL, "just test-storymap")).toMatchObject({ ok: true, mode: "keys" });
  });

  it("conta as linhas DEPOIS de sanitizar — um ESC no meio não esconde a quebra", () => {
    expect(planSessionDelivery(SHELL, `echo a${ESC}\necho b`).ok).toBe(false);
  });

  it("um CR sozinho NÃO vira linha nova (ele é removido, não convertido em quebra)", () => {
    expect(planSessionDelivery(SHELL, `echo${CR}ok`)).toMatchObject({ ok: true, mode: "keys", lines: 1 });
  });
});

describe("planSessionDelivery — a sessão MASTER", () => {
  it("é recusada por padrão, com a alavanca nomeada na recusa", () => {
    const plan = planSessionDelivery({ runsClaude: true, isMaster: true }, "oi");
    if (plan.ok) throw new Error("esperava recusa");
    expect(plan.reason).toContain("confirmMaster:true");
  });

  it("passa com confirmMaster — a capacidade fica, só o acidente morre", () => {
    expect(planSessionDelivery({ runsClaude: true, isMaster: true }, "oi", { confirmMaster: true })).toMatchObject({
      ok: true,
      mode: "paste",
    });
  });

  it("o master é checado ANTES do modo — vale para um shell master também", () => {
    expect(planSessionDelivery({ runsClaude: false, isMaster: true }, "ls").ok).toBe(false);
  });
});

describe("planSessionDelivery — texto vazio", () => {
  it("recusa string em branco", () => {
    expect(planSessionDelivery(CLAUDE, "   ").ok).toBe(false);
  });

  it("recusa um texto que só tinha bytes de controle", () => {
    const plan = planSessionDelivery(CLAUDE, `${NUL}${BEL}${ESC}`);
    if (plan.ok) throw new Error("esperava recusa");
    expect(plan.reason).toContain("controle");
  });
});

// F2 — a sonda que separa "zero sessões" de "não consegui perguntar". Quem lê esta resposta DECIDE
// ÓBITO e libera claims; colapsar os dois casos entregaria os cards da frota inteira num timeout.
describe("classifyListSessions", () => {
  it("exit 0 → os nomes (primeira coluna, o resto do formato é ignorado)", () => {
    const r = classifyListSessions({ code: 0, stdout: "agent-a\nshell\ncop-build\n", stderr: "" });
    expect(r).toEqual({ ok: true, names: ["agent-a", "shell", "cop-build"] });
  });

  it("exit 0 com saída vazia → zero sessões, e isso É um fato", () => {
    expect(classifyListSessions({ code: 0, stdout: "\n", stderr: "" })).toEqual({ ok: true, names: [] });
  });

  it("'no server running' → o tmux RESPONDEU: sem servidor, todo pane registrado morreu junto", () => {
    const r = classifyListSessions({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-0/default" });
    expect(r).toEqual({ ok: true, names: [] });
  });

  it("timeout/erro desconhecido → NÃO SEI (é o que impede o óbito em massa)", () => {
    const r = classifyListSessions({ code: 1, stdout: "", stderr: "Command failed: timeout" });
    expect(r.ok).toBe(false);
  });

  it("falha sem stderr nenhum também é NÃO SEI, com o código no motivo", () => {
    const r = classifyListSessions({ code: 137, stdout: "", stderr: "" });
    if (r.ok) throw new Error("esperava não-sei");
    expect(r.reason).toContain("137");
  });
});

describe("isMasterSessionName", () => {
  it.each([
    ["claude", true],
    ["claude-jonatas", true],
    ["claudia", false],
    ["agent-f0753938", false],
    ["cop-acme-build", false],
    ["shell", false],
  ])("%s → %s", (name, expected) => {
    expect(isMasterSessionName(name as string)).toBe(expected);
  });
});

// -- planKeySequence: vocabulario fechado, e o que fica de fora ---------------------------------
//
// MEDIDO em 2026-08-28, numa simulacao de onboarding: uma sessao que cai num FORMULARIO de opcoes
// fica INALCANCAVEL de fora. `claude_send` remove todo byte de controle (com razao: ESC em sessao
// alheia e injecao) e navegar o formulario exige seta/Tab. A sessao presa contradiz o `/terminal`
// autenticado e o "destravar do celular", que sao promessas do produto.
//
// A saida e NOMEAR em vez de afrouxar: o vocabulario e fechado e o byte nunca vem do chamador.
describe("planKeySequence: vocabulario fechado, e o que fica de fora", () => {
  const comum = { isMaster: false };

  it("[NAO-VACUIDADE] o vocabulario traz o que navega um formulario", () => {
    expect(TECLAS_PERMITIDAS.length).toBeGreaterThan(5);
    for (const t of ["Up", "Down", "Tab", "Enter", "Space", "Escape"]) {
      expect(TECLAS_PERMITIDAS as readonly string[]).toContain(t);
    }
  });

  it("aceita a sequencia que resolve o caso real: descer, marcar, submeter", () => {
    const r = planKeySequence(comum, ["Down", "Space", "Enter"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.keys).toEqual(["Down", "Space", "Enter"]);
  });

  it("[ATAQUE] RECUSA byte cru: e o vetor que a sanitizacao do claude_send fecha", () => {
    for (const cru of ["\u001b", "\u001b[A", "\r", "\u0003", "C-m"]) {
      const r = planKeySequence(comum, [cru]);
      expect(r.ok, `aceitou ${JSON.stringify(cru)}`).toBe(false);
    }
  });

  it("[ATAQUE] RECUSA interromper/encerrar/suspender, e a recusa DIZ onde ir", () => {
    for (const k of ["C-c", "C-d", "C-z"]) {
      const r = planKeySequence(comum, [k]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain(k);
        expect(r.reason, "recusa sem saida faz o agente tentar de novo igual").toContain("claude_kill");
      }
    }
  });

  it("a recusa NOMEIA a tecla rejeitada e lista as permitidas", () => {
    const r = planKeySequence(comum, ["Down", "F13", "Enter"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("F13");
      expect(r.reason).toContain("Up");
    }
  });

  it("sequencia vazia e recusada, e uma rajada tambem, com o teto NOMEADO", () => {
    expect(planKeySequence(comum, []).ok).toBe(false);
    const rajada = Array.from({ length: MAX_TECLAS_POR_CHAMADA + 1 }, () => "Down");
    const r = planKeySequence(comum, rajada);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(String(MAX_TECLAS_POR_CHAMADA));
  });

  it("a sessao MASTER exige consentimento, e o consentimento a libera", () => {
    const sem = planKeySequence({ isMaster: true }, ["Enter"]);
    expect(sem.ok).toBe(false);
    if (!sem.ok) expect(sem.reason).toContain("confirmMaster");
    expect(planKeySequence({ isMaster: true }, ["Enter"], { confirmMaster: true }).ok).toBe(true);
  });
});
