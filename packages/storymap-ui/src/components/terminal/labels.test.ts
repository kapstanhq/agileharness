import { describe, expect, it } from "vitest";
import { canOfferKill, CONTEXT_STALE_MS, contextReading, needsYou, stateLabel, stripLineMarker } from "./labels";

describe("contextReading — 'ainda não mediu' e 'não consegui ler' param de usar o mesmo símbolo", () => {
  const read = (over: Partial<Parameters<typeof contextReading>[0]> = {}) =>
    contextReading({ contextPct: null, contextAbsent: null, contextAgeMs: null, ...over });

  it("uma sessão recém-limpa DIZ que é nova — o '—' fazia o /clear parecer defeito", () => {
    // O caminho real: `/clear` cria um transcript novo (medido: o pidfile aponta o novo em ≤12s), que
    // ainda não tem turno do modelo. Isso é normal e temporário, e não podia ler igual a um erro.
    const r = read({ contextAbsent: "no-usage" });
    expect(r.text).toBe("novo");
    expect(r.title).toContain("/clear");
    expect(r.stale).toBe(false);
  });

  it("a ignorância continua sendo '—', com o motivo em cada caso", () => {
    expect(read({ contextAbsent: "unreadable" }).text).toBe("—");
    expect(read({ contextAbsent: "unmapped" }).text).toBe("—");
    expect(read({ contextAbsent: "no-claude" }).text).toBe("—");
    expect(read().text).toBe("—");
    // motivos DIFERENTES — um '—' mudo é o que não se quer
    const titles = new Set(
      (["unreadable", "unmapped", "no-claude"] as const).map((a) => read({ contextAbsent: a }).title),
    );
    expect(titles.size).toBe(3);
  });

  it("o número manda sobre qualquer motivo de ausência", () => {
    expect(read({ contextPct: 63.4, contextAbsent: "unreadable" }).text).toBe("63%");
  });

  it("leitura velha continua aparecendo, mas marcada — nunca some, nunca se passa por atual", () => {
    expect(read({ contextPct: 83, contextAgeMs: CONTEXT_STALE_MS - 1 })).toMatchObject({ text: "83%", stale: false });
    const old = read({ contextPct: 83, contextAgeMs: CONTEXT_STALE_MS });
    expect(old.text).toBe("~83%");
    expect(old.stale).toBe(true);
    expect(old.title).toContain("2 min");
  });

  it("sem idade não há acusação de velhice — ausência de dado nunca vira veredito", () => {
    expect(read({ contextPct: 12, contextAgeMs: null }).stale).toBe(false);
  });
});

describe("stripLineMarker", () => {
  it("drops the decorative marker the activity line arrives with", () => {
    expect(stripLineMarker("✳ Redesign terminal block")).toBe("Redesign terminal block");
    expect(stripLineMarker("· Redesign terminal block")).toBe("Redesign terminal block");
    expect(stripLineMarker("• rodando os testes")).toBe("rodando os testes");
  });

  it("drops a frozen SPINNER frame — the braille char the live box actually sends", () => {
    // Observed verbatim on /api/processes: the CLI's spinner animates through the braille block, and
    // whichever frame it was on when the pane title was read ends up glued to the message.
    expect(stripLineMarker("⠐ Redesign terminal block visual and info display")).toBe(
      "Redesign terminal block visual and info display",
    );
    expect(stripLineMarker("⣷ rodando a suíte")).toBe("rodando a suíte");
  });

  it("leaves a normal line untouched", () => {
    expect(stripLineMarker("Aplicando a lente de segurança")).toBe("Aplicando a lente de segurança");
  });

  it("never eats a leading path, flag or shell glyph — those ARE the content", () => {
    expect(stripLineMarker("/root/meu-monorepo")).toBe("/root/meu-monorepo");
    expect(stripLineMarker("--changed origin/main")).toBe("--changed origin/main");
    expect(stripLineMarker("$ bun run build")).toBe("$ bun run build");
  });

  it("returns the original rather than an empty string when the line is ONLY markers", () => {
    // An empty prompt line would look broken; showing the odd glyph is the lesser evil.
    expect(stripLineMarker("· ·")).toBe("· ·");
  });
});

describe("stateLabel / needsYou", () => {
  it("marks only a CLI-reported idle agent as needing the operator", () => {
    expect(needsYou({ state: "waiting", source: "cli" })).toBe(true);
    // a plain shell sitting open asks nothing of anyone
    expect(needsYou({ state: "waiting", source: "status" })).toBe(false);
    expect(needsYou({ state: "working", source: "cli" })).toBe(false);
  });

  it("shortens 'aguardando você' only where the row is compact", () => {
    const m = { state: "waiting", source: "cli" } as const;
    expect(stateLabel(m)).toBe("aguardando você");
    expect(stateLabel(m, true)).toBe("aguardando");
  });

  it("calls a shell with no agent OCIOSO, never 'aguardando você'", () => {
    expect(stateLabel({ state: "waiting", source: "status" })).toBe("ocioso");
  });

  it("um flag VENCIDO pela tela deixa de ser chamada à ação — vira ocioso", () => {
    // Uma sessão dormindo há 20h usava o mesmo selo âmbar de uma que acabou de te perguntar algo.
    expect(needsYou({ state: "waiting", source: "stale" })).toBe(false);
    expect(stateLabel({ state: "waiting", source: "stale" })).toBe("ocioso");
  });
});

describe("canOfferKill — o encerrar é oferecido só ao DORMENTE", () => {
  it("oferece para a linha cujo estado a tela desmentiu", () => {
    expect(canOfferKill({ state: "waiting", source: "stale" })).toBe(true);
  });

  it("NÃO oferece para quem trabalha nem para quem está te esperando", () => {
    // Um botão de matar ao lado de quem trabalha é um acidente esperando acontecer; e para quem
    // acabou de perguntar algo o gesto certo é responder.
    expect(canOfferKill({ state: "working", source: "cli" })).toBe(false);
    expect(canOfferKill({ state: "waiting", source: "cli" })).toBe(false);
    expect(canOfferKill({ state: "working", source: "run" })).toBe(false);
  });

  it("NÃO oferece quando só sabemos que o processo existe (sem agente para perguntar)", () => {
    expect(canOfferKill({ state: "waiting", source: "status" })).toBe(false);
  });
});
