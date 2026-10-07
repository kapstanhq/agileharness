import { describe, expect, it } from "vitest";
import { ASK_FORMAT, askFormatProblems, bannedTermsIn, clip, dayToken, formatDecisionText, localTimeFormatter, quoted, relativeWithClock, staleDays, staleLabel, timeToken } from "./copy";

const NOW = Date.parse("2026-09-28T23:19:00Z"); // 20:19 em São Paulo
const TZ = "America/Sao_Paulo";

describe("o glossário", () => {
  it("pega cada termo interno que o dono não lê", () => {
    const samples: Array<[string, string]> = [
      ["Deploy disparado sem confirmação (settle não chegou)", "settle"],
      ["O gate de integração falhou", "gate"],
      ["o merge train parou", "train"],
      ["Código staged há 3d", "staged"],
      ["Run falhou: exit", "run"],
      ["Triar achado: finding aberto", "finding"],
      ["Disparado em 2026-09-27T22:27:46.743Z", "iso-date"],
      ["run 3f2a9c1e-1b2c-4d5e-8f90-1234567890ab", "uuid"],
      ["Jido pede: move_card", "tool-id"],
      ["processo terminou com saída 3", "exit-code"],
      ["Skill: harness-enrich", "skill-route"],
      ["classe write-board", "risk-class"],
    ];
    for (const [text, id] of samples) expect(bannedTermsIn(text).map((t) => t.id), text).toContain(id);
  });

  it("deixa passar o texto que o redesenho aprovou", () => {
    for (const text of [
      "Publicar «Manifesto» em produção?",
      "A execução do agente foi encerrada no meio — em geral, por um reinício do serviço.",
      "Trava a fila de integração de todo o board.",
      "Fica na Triagem; nenhum agente mexe.",
      "Vence em 07/10 e o board fica como está.",
    ]) {
      expect(bannedTermsIn(text), text).toEqual([]);
    }
  });
});

describe("o tempo, no fuso de quem lê", () => {
  const fmt = localTimeFormatter(NOW, TZ);

  it("formata os marcadores: hoje/ontem/amanhã com a hora; dia sozinho", () => {
    expect(formatDecisionText(`vence ${timeToken("2026-09-28T22:00:00Z")}`, fmt)).toBe("vence hoje às 19:00");
    expect(formatDecisionText(`vence ${timeToken("2026-09-29T20:00:00Z")}`, fmt)).toBe("vence amanhã às 17:00");
    expect(formatDecisionText(`em ${dayToken("2026-10-07T00:00:00Z")}`, fmt)).toBe("em 06/10");
    expect(formatDecisionText(`em ${timeToken("não é data")}`, fmt)).toBe("em em data desconhecida");
  });

  it("«há 12 min · 20:07» — a idade relativa mais o relógio local; dias viram data", () => {
    expect(relativeWithClock("2026-09-28T23:07:00Z", NOW, TZ)).toBe("há 12 min · 20:07");
    expect(relativeWithClock("2026-09-28T20:19:00Z", NOW, TZ)).toBe("há 3 h · 17:19");
    expect(relativeWithClock("2026-09-24T12:00:00Z", NOW, TZ)).toBe("há 4 dias · 24/09");
    expect(relativeWithClock(null, NOW, TZ)).toBeNull();
  });

  it("uma data pura conta DIAS do calendário de quem lê, nunca horas desde a meia-noite UTC", () => {
    // NOW é 28/09 20:19 em São Paulo (29/09 em UTC): a proposta de 28/09 é de hoje para o dono
    expect(relativeWithClock("2026-09-28", NOW, TZ)).toBe("hoje · 28/09");
    expect(relativeWithClock("2026-09-27", NOW, TZ)).toBe("ontem · 27/09");
    expect(relativeWithClock("2026-09-24", NOW, TZ)).toBe("há 4 dias · 24/09");
  });
});

describe("o glossário — nomes técnicos que vazaram em 07/10", () => {
  it("pega o nome técnico de uma parte publicada e o «fail-closed»", () => {
    expect(bannedTermsIn("Autorizar a publicação do código de negócio em face:loja?").map((t) => t.id)).toContain("unit-id");
    expect(bannedTermsIn("a publicação ficou retida (fail-closed)").map((t) => t.id)).toContain("fail-closed");
  });
  it("não confunde frase com dois-pontos, endereço ou marcador de tempo", () => {
    expect(bannedTermsIn("O que aconteceu: nada foi publicado.")).toEqual([]);
    expect(bannedTermsIn("Veja em https://exemplo.test/ajuda")).toEqual([]);
  });
});

describe("o objeto e o parado", () => {
  it("aspas angulares, cortado sem quebrar a leitura", () => {
    expect(quoted("Cadastrar 40 títulos do acervo de usados")).toBe("«Cadastrar 40 títulos do acervo de usados»");
    expect(quoted("x".repeat(80), 20)).toBe(`«${"x".repeat(19)}…»`);
    expect(quoted("")).toBe("«este card»");
    expect(clip("uma frase bem longa que precisa ser cortada no lugar certo", 30)).toBe("uma frase bem longa que…");
  });

  it("parado a partir de 30 dias", () => {
    expect(staleDays("2026-07-08T10:00:00Z", NOW)).toBe(82);
    expect(staleDays("2026-09-01T10:00:00Z", NOW)).toBeNull();
    expect(staleDays(undefined, NOW)).toBeNull();
    expect(staleLabel(81)).toBe("parado há 81 dias");
    expect(staleLabel(1)).toBe("parado há 1 dia");
  });
});

describe("fase 3 — o formato de uma pergunta de agente (ask_question)", () => {
  const ok = {
    context: "A busca do catálogo já acha livros pelo título. Para achar pelo autor, ela pode ignorar acentos ou exigir a grafia exata.",
    text: "A busca por autor deve ignorar acentos?",
    options: [{ label: "Ignorar acentos (Jose acha José)" }, { label: "Exigir a grafia exata" }],
  };
  it("aceita a pergunta no formato (o exemplo das skills)", () => {
    expect(askFormatProblems({ questions: [ok] })).toEqual([]);
    expect(askFormatProblems({ texts: ["Pode publicar a vitrine nova hoje?"] })).toEqual([]);
  });
  it("recusa pergunta vazia, chamada vazia e texto livre vazio", () => {
    expect(askFormatProblems({})).toHaveLength(1);
    expect(askFormatProblems({ questions: [{ ...ok, text: "  " }] })[0]).toMatch(/text está vazio/);
    expect(askFormatProblems({ texts: [""] })[0]).toMatch(/vazio/);
  });
  it("recusa fora dos tamanhos: pergunta longa, contexto longo, 1 ou 5 opções, rótulo que não cabe num botão", () => {
    expect(askFormatProblems({ questions: [{ ...ok, text: "x".repeat(ASK_FORMAT.textMax + 1) }] })[0]).toMatch(/máximo 240/);
    expect(askFormatProblems({ questions: [{ ...ok, context: "x".repeat(ASK_FORMAT.contextMax + 1) }] })[0]).toMatch(/context/);
    expect(askFormatProblems({ questions: [{ ...ok, options: [{ label: "Só uma" }] }] })[0]).toMatch(/de 2 a 4/);
    expect(askFormatProblems({ questions: [{ ...ok, options: ["a", "b", "c", "d", "e"].map((label) => ({ label })) }] })[0]).toMatch(/de 2 a 4/);
    expect(askFormatProblems({ questions: [{ ...ok, options: [{ label: "y".repeat(81) }, { label: "Outra" }] }] })[0]).toMatch(/botão/);
  });
});
