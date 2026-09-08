import { describe, expect, it } from "vitest";
import { historySignature, shouldAdoptHistory, shouldPollHistory } from "./history-sync";
import type { HitlTurn } from "@/lib/storymap/hitl/types";

/** um turno de agente com N segmentos de tool — a forma que o tick produz enquanto trabalha. */
const agentWith = (segs: number, lastOutput = ""): HitlTurn => ({
  role: "agent",
  message: "",
  segments: Array.from({ length: segs }, (_, i) => ({
    type: "tool" as const,
    segId: `h${i}`,
    name: "get_card",
    summary: "",
    status: "done" as const,
    ...(i === segs - 1 && lastOutput ? { output: lastOutput } : {}),
  })),
});

const notice: HitlTurn = { role: "notice", kind: "tick", text: "Acordei sozinho — ciclo periódico" };

describe("historySignature", () => {
  it("MUDA quando o turno do agente cresce por dentro, mesmo com o nº de turnos igual", () => {
    // é ESTE o caso que o gate de length não via — medido no transcript vivo do acme:
    // turns=15 segs=9 → turns=15 segs=13, 30s de trabalho sem uma mudança em turns.length.
    const a = [notice, agentWith(9)];
    const b = [notice, agentWith(13)];
    expect(a.length).toBe(b.length); // o gate antigo comparava SÓ isto ⇒ nunca adotava
    expect(historySignature(a)).not.toBe(historySignature(b));
  });

  it("MUDA quando a saída de uma tool chega (a tool fecha)", () => {
    expect(historySignature([agentWith(2)])).not.toBe(historySignature([agentWith(2, "resultado")]));
  });

  it("MUDA quando texto streama dentro do mesmo segmento", () => {
    const t = (text: string): HitlTurn[] => [{ role: "agent", message: "", segments: [{ type: "text", segId: "h0", text }] }];
    expect(historySignature(t("Analis"))).not.toBe(historySignature(t("Analisando o board…")));
  });

  it("é ESTÁVEL: mesma entrada ⇒ mesma assinatura (senão o poll adotaria a cada 2s e o thread piscaria)", () => {
    const turns = [notice, agentWith(5, "x")];
    expect(historySignature(turns)).toBe(historySignature([notice, agentWith(5, "x")]));
  });

  it("lista vazia tem assinatura própria", () => {
    expect(historySignature([])).toBe("0");
  });
});

describe("shouldAdoptHistory — o gate do poll near-live", () => {
  it("ADOTA o tick trabalhando: mesmo nº de turnos, conteúdo novo (o bug do congelamento)", () => {
    const before = [notice, agentWith(9)];
    const now = [notice, agentWith(13)];
    expect(shouldAdoptHistory(now, before.length, historySignature(before))).toBe(true);
  });

  it("NÃO adota quando nada mudou (preserva os ecos locais — greeting, respostas, aprovações)", () => {
    const turns = [notice, agentWith(9)];
    expect(shouldAdoptHistory(turns, turns.length, historySignature(turns))).toBe(false);
  });

  it("NÃO adota servidor VAZIO (conversa nova só com greeting local não pode ser apagada)", () => {
    expect(shouldAdoptHistory([], 0, null)).toBe(false);
    expect(shouldAdoptHistory([], 3, "qualquer")).toBe(false);
  });

  it("NÃO adota servidor MENOR que o já sincronizado (quem tem turnos a mais aqui é o operador)", () => {
    // local: 2 do servidor + 3 ecos locais; servidor segue com 2 e não mudou ⇒ nada a adotar.
    const server = [notice, agentWith(2)];
    expect(shouldAdoptHistory(server, 5, "assinatura-de-outra-coisa")).toBe(false);
  });

  it("ADOTA quando o servidor cresce em turnos (o caso que o gate antigo já cobria — sem regressão)", () => {
    const before = [notice, agentWith(3)];
    const now = [notice, agentWith(3), notice];
    expect(shouldAdoptHistory(now, before.length, historySignature(before))).toBe(true);
  });

  it("primeira sincronização (sig null) adota o que o servidor tiver", () => {
    expect(shouldAdoptHistory([notice], 0, null)).toBe(true);
  });
});

describe('shouldAdoptHistory — guard de "Nova conversa" (sessão descartada)', () => {
  const server = [notice, agentWith(9)];

  it("NÃO re-adota o transcript da sessão que o operador acabou de descartar", () => {
    // o ponteiro do servidor ainda devolve a sessão antiga (deleção perdeu a corrida) — o guard segura.
    expect(
      shouldAdoptHistory(server, 0, null, { serverSessionId: "sess-antiga", clearedSessionId: "sess-antiga" }),
    ).toBe(false);
  });

  it("ADOTA quando o servidor já é uma sessão DIFERENTE da descartada (trabalho novo / tick)", () => {
    expect(
      shouldAdoptHistory(server, 0, null, { serverSessionId: "sess-nova", clearedSessionId: "sess-antiga" }),
    ).toBe(true);
  });

  it("guard inerte quando não há sessão descartada (comportamento original preservado)", () => {
    expect(shouldAdoptHistory(server, 0, null, { serverSessionId: "sess-antiga", clearedSessionId: null })).toBe(true);
    expect(shouldAdoptHistory(server, 0, null)).toBe(true);
  });

  it("guard inerte quando o servidor não reporta sessionId (não pode casar com a descartada)", () => {
    expect(
      shouldAdoptHistory(server, 0, null, { serverSessionId: null, clearedSessionId: "sess-antiga" }),
    ).toBe(true);
  });
});

// O CONGELAMENTO do incidente de 2026-07-25: um 409 deixava o chat em `status:"error"` e o poll — gated em
// `status === "idle"` — morria para sempre; o painel só voltava a carregar conteúdo depois de um F5.
describe("shouldPollHistory — o poll só para durante o MEU streaming", () => {
  it("roda ocioso E em erro (um chat que errou é quando MAIS se precisa ver o outro lado trabalhando)", () => {
    expect(shouldPollHistory("idle")).toBe(true);
    expect(shouldPollHistory("error")).toBe(true);
  });

  it("para durante o próprio turno streamando (ali a verdade é o SSE — adotar clobbaria o turno em voo)", () => {
    expect(shouldPollHistory("typing")).toBe(false);
  });
});
