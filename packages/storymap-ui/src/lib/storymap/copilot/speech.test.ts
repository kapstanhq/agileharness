import { describe, expect, it } from "vitest";
import { copilotSpeech } from "./speech";
import { EXPRESSIONS, type MoodId } from "./face";
import type { CopilotActivityEntry } from "./activity";
import type { TerminalAttention } from "@/lib/terminal/attention";

const ALL_MOODS = Object.keys(EXPRESSIONS) as MoodId[];
const NOW = Date.parse("2026-07-27T12:10:00.000Z");

const entry = (over: Partial<CopilotActivityEntry> = {}): CopilotActivityEntry => ({
  id: "1",
  at: "2026-07-27T12:00:00.000Z",
  kind: "finished",
  text: "Revisei o board e movi 2 cards.",
  ...over,
});

/** As entradas de RUÍDO que enchiam o balão: o tick olhando o board e decidindo não agir. */
const standDown = (n: number): CopilotActivityEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `sd-${i}`,
    at: new Date(NOW - (i + 1) * 60_000).toISOString(),
    kind: "stood-down" as const,
    text: "Olhei o board: nada acionável para mim agora (nenhum card travado, conflito de merge ou pergunta que eu resolva).",
  }));

const terminal = (over: Partial<TerminalAttention> = {}): TerminalAttention => ({
  session: "cop-ui",
  label: "Melhorias de UI",
  kind: "asking",
  since: NOW - 4 * 60_000,
  agent: true,
  ...over,
});

describe("copilotSpeech — o balão do topnav", () => {
  it("dá uma fala não-vazia para TODO humor (nenhum mascote mudo)", () => {
    for (const mood of ALL_MOODS) {
      const s = copilotSpeech({ mood, now: NOW });
      expect(s.line.trim().length).toBeGreaterThan(0);
      expect(s.key).toBe(`mood:${mood}`);
      expect(s.tone).toBe(EXPRESSIONS[mood].tone);
    }
  });

  it("o humor URGENTE ganha do diário — uma confirmação parada vale mais que a última decisão", () => {
    const s = copilotSpeech({ mood: "panico", activity: [entry()], now: NOW });
    expect(s.key).toBe("mood:panico");
    expect(s.urgent).toBe(true);
    expect(s.tone).toBe("danger");
  });

  it("em repouso ele conta a última ação REAL", () => {
    const s = copilotSpeech({ mood: "feliz", activity: [entry({ text: "Movi o card X para revisão." })], now: NOW });
    expect(s.line).toBe("Movi o card X para revisão.");
    expect(s.key).toBe("act:1");
    expect(s.sourceId).toBe("1");
  });

  // ── O DEFEITO QUE MOTIVOU A REESCRITA ────────────────────────────────────────────────────────────
  describe("nunca repetir o histórico", () => {
    it("PULA os ciclos vazios e fala da última ação real (o bug do 'nada acionável' ×3)", () => {
      const activity = [...standDown(3), entry({ id: "real", text: "Publiquei o card story-x." })];
      const s = copilotSpeech({ mood: "dormindo", activity, now: NOW });
      expect(s.line).toBe("Publiquei o card story-x.");
      expect(s.line).not.toContain("nada acionável");
      expect(s.sourceId).toBe("real");
    });

    it("conta os ciclos vazios na NOTA em vez de repeti-los na fala", () => {
      const activity = [...standDown(4), entry({ id: "real" })];
      const s = copilotSpeech({ mood: "dormindo", activity, now: NOW });
      expect(s.note).toContain("4 ciclos sem trabalho");
    });

    it("um único ciclo vazio não vira ruído na nota (1 é o normal de um board em dia)", () => {
      const s = copilotSpeech({ mood: "dormindo", activity: [...standDown(1), entry({ id: "real" })], now: NOW });
      expect(s.note ?? "").not.toContain("ciclos sem trabalho");
    });

    it("SÓ ciclos vazios ⇒ ele fala do próprio estado, nunca a frase do diário", () => {
      const s = copilotSpeech({ mood: "dormindo", activity: standDown(5), now: NOW });
      expect(s.line).not.toContain("nada acionável");
      expect(s.key).toBe("mood:dormindo");
      expect(s.sourceId).toBeUndefined();
      expect(s.note).toContain("5 ciclos sem trabalho");
    });

    it("expõe o `sourceId` para o histórico poder EXCLUIR a entrada que virou fala", () => {
      const activity = [entry({ id: "a" }), entry({ id: "b" })];
      const s = copilotSpeech({ mood: "feliz", activity, now: NOW });
      expect(s.sourceId).toBe("a");
      expect(activity.filter((e) => e.id !== s.sourceId).map((e) => e.id)).toEqual(["b"]);
    });
  });

  // ── TERMINAIS ────────────────────────────────────────────────────────────────────────────────────
  describe("terminais esperando o operador", () => {
    it("um terminal parado num prompt VENCE o recap — ele trava trabalho", () => {
      const s = copilotSpeech({
        mood: "dormindo",
        activity: [entry({ text: "Terminei um ciclo." })],
        terminals: [terminal({ question: "Deseja executar este comando?" })],
        now: NOW,
      });
      expect(s.line).toContain("Melhorias de UI");
      expect(s.line).toContain("4min");
      expect(s.line).toContain("Deseja executar este comando?");
      expect(s.urgent).toBe(true);
      expect(s.tone).toBe("warn");
    });

    it("dois ou mais: conta e nomeia, sem virar parágrafo", () => {
      const s = copilotSpeech({
        mood: "feliz",
        terminals: [terminal(), terminal({ session: "b", label: "Merge" }), terminal({ session: "c", label: "Chat" })],
        now: NOW,
      });
      expect(s.line).toContain("3 terminais");
      expect(s.line).toContain("Melhorias de UI");
      expect(s.line.length).toBeLessThanOrEqual(141);
    });

    it("a identidade é (sessão, desde quando) — reler o mesmo prompt não é fala nova", () => {
      const t = terminal();
      expect(copilotSpeech({ mood: "feliz", terminals: [t], now: NOW }).key).toBe(
        copilotSpeech({ mood: "feliz", terminals: [t], now: NOW + 30_000 }).key,
      );
      expect(copilotSpeech({ mood: "feliz", terminals: [terminal({ since: NOW })], now: NOW }).key).not.toBe(
        copilotSpeech({ mood: "feliz", terminals: [t], now: NOW }).key,
      );
    });

    it("com humor urgente, o terminal desce para a nota — nenhum bloqueio some por causa de outro", () => {
      const s = copilotSpeech({ mood: "panico", terminals: [terminal()], now: NOW });
      expect(s.key).toBe("mood:panico");
      expect(s.note).toContain("1 terminal esperando você");
    });

    it("terminal apenas QUIETO não toma a fala — vira medidor na nota", () => {
      const s = copilotSpeech({
        mood: "dormindo",
        activity: [entry({ text: "Terminei um ciclo." })],
        terminals: [terminal({ kind: "idle", question: undefined })],
        now: NOW,
      });
      expect(s.line).toBe("Terminei um ciclo.");
      expect(s.note).toContain("1 terminal quieto");
    });
  });

  // ── OCUPADO ──────────────────────────────────────────────────────────────────────────────────────
  it("ocupado, o recap de ROTINA espera a vez — mas o 'preciso de você' fala mesmo assim", () => {
    const rotina = copilotSpeech({ mood: "codigo", activity: [entry({ kind: "finished" })], now: NOW });
    expect(rotina.key).toBe("mood:codigo");

    const pedido = copilotSpeech({
      mood: "codigo",
      activity: [entry({ kind: "asked", text: "Preciso que você decida X." })],
      now: NOW,
    });
    expect(pedido.key).toBe("act:1");
    expect(pedido.tone).toBe("warn");
    expect(pedido.urgent).toBe(true);
  });

  // ── NOTA ─────────────────────────────────────────────────────────────────────────────────────────
  describe("a nota (os medidores)", () => {
    it("diz há quanto tempo foi a última ação e quantos itens esperam você", () => {
      const s = copilotSpeech({ mood: "feliz", activity: [entry()], needsYou: 3, now: NOW });
      expect(s.note).toContain("há 10min");
      expect(s.note).toContain("3 itens esperam você");
    });

    it("singular correto e zero omitido (um '0 itens' é mobília, não informação)", () => {
      expect(copilotSpeech({ mood: "feliz", needsYou: 1, now: NOW }).note).toContain("1 item espera você");
      expect(copilotSpeech({ mood: "feliz", needsYou: 0, now: NOW }).note).toBeUndefined();
      expect(copilotSpeech({ mood: "feliz", now: NOW }).note).toBeUndefined();
    });

    it("nunca vira um parágrafo", () => {
      const s = copilotSpeech({
        mood: "feliz",
        activity: [...standDown(9), entry({ id: "real" })],
        terminals: [terminal({ kind: "idle" })],
        needsYou: 12,
        now: NOW,
      });
      expect((s.note ?? "").length).toBeLessThanOrEqual(81);
    });
  });

  it("achata e capa o texto do diário — um balão é uma frase, não um parágrafo", () => {
    const s = copilotSpeech({
      mood: "feliz",
      activity: [entry({ text: `## Título\n\n${"palavra ".repeat(60)}` })],
      now: NOW,
    });
    expect(s.line).not.toContain("\n");
    expect(s.line.length).toBeLessThanOrEqual(141);
  });
});
