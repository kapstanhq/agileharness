import { describe, expect, it } from "vitest";
import { QUOTA_WINDOW_MIN, quotaPace, ringDash } from "@/components/shell/quota-pace";

// O veredito do anel compara o uso com o ESPERADO HOJE (a fração da janela de 7 dias que já passou).
const DAY = 24 * 60;
const atDay = (d: number) => QUOTA_WINDOW_MIN - d * DAY; // resetsInMinutes com `d` dias já passados

describe("quotaPace — o veredito pela régua do esperado", () => {
  it("bem abaixo: 7% usado com 2 dias passados (29% esperado)", () => {
    const p = quotaPace(7, atDay(2));
    expect(p).toMatchObject({ usedPct: 7, expectedPct: 29, day: 2, verdict: "below", verdictLabel: "Bem abaixo do ritmo" });
    expect(p.help).toBe("Usou 7% com 29% da janela passada. Sobra cota: dá para o board andar mais rápido.");
  });

  it("bem abaixo num board com 1 condutor e escopo «Só consertos»: as alavancas do desenho", () => {
    expect(quotaPace(7, atDay(2), { conductorSlots: 1, scopeFixes: true }).help).toBe(
      "Usou 7% com 29% da janela passada. Sobra cota: dá para ligar o 2º condutor ou voltar o escopo para Tudo.",
    );
    expect(quotaPace(7, atDay(2), { conductorSlots: 2, scopeFixes: true }).help).toContain("Sobra cota: dá para voltar o escopo para Tudo.");
  });

  it("no ritmo: dentro de 10 pontos do esperado, com a projeção do fechamento", () => {
    const p = quotaPace(28, atDay(2));
    expect(p.verdict).toBe("on");
    expect(p.verdictLabel).toBe("No ritmo");
    expect(p.help).toBe("Usou 28% com 29% da janela passada. Neste passo a cota fecha a semana perto de 98%.");
    // no ritmo, mas um pouco acima: a projeção passa de 100% e vira «acaba em N dias»
    expect(quotaPace(35, atDay(2))).toMatchObject({ verdict: "on" });
    expect(quotaPace(35, atDay(2)).help).toContain("Neste passo a cota acaba em cerca de 5,7 dias.");
  });

  it("acima: diz em quantos dias a cota acaba e sugere frear", () => {
    const p = quotaPace(58, atDay(2));
    expect(p.verdict).toBe("above");
    expect(p.help).toContain("Neste passo a cota acaba em cerca de 3,4 dias.");
    expect(p.help).toContain("Sugestão: andar devagar.");
    expect(quotaPace(58, atDay(2), { conductorSlots: 2 }).help).toContain("Sugestão: andar devagar ou 1 condutor.");
  });

  it("o dia da janela fica entre 1 e 7 (logo depois do reset é o dia 1; no fim, o 7)", () => {
    expect(quotaPace(0, QUOTA_WINDOW_MIN).day).toBe(1);
    expect(quotaPace(90, 0).day).toBe(7);
    expect(quotaPace(90, 0).expectedPct).toBe(100);
  });

  it("sem saber quando zera, não inventa esperado nem veredito — só o uso", () => {
    for (const r of [null, undefined, -5, QUOTA_WINDOW_MIN + 1, Number.NaN]) {
      const p = quotaPace(40, r as number | null | undefined);
      expect(p).toMatchObject({ usedPct: 40, expectedPct: null, day: null, verdict: null, verdictLabel: null });
      expect(p.help).toBe("Usou 40% da cota desta semana.");
    }
  });

  it("o uso é preso a 0..100", () => {
    expect(quotaPace(140, atDay(3)).usedPct).toBe(100);
    expect(quotaPace(-3, atDay(3)).usedPct).toBe(0);
  });
});

describe("ringDash — o traço do anel", () => {
  it("cheio proporcional à circunferência de 88", () => {
    expect(ringDash(7)).toBe("6.2 88");
    expect(ringDash(100)).toBe("88.0 88");
    expect(ringDash(null)).toBe("0.0 88");
    expect(ringDash(250)).toBe("88.0 88");
  });
});
