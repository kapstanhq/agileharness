import { describe, expect, it } from "vitest";
import { FINDING_FIX_LABEL, buildFindingFixCard, findingFixRefusal, severityWords } from "./finding-fix";
import type { Card, Finding } from "./types";

const finding = (over: Partial<Finding> = {}): Finding =>
  ({ id: "f1", lens: "general", severity: "medium", status: "open", title: "Etiquetas antigas não trazem a data do reajuste", detail: "Só as etiquetas impressas depois da mudança têm a data.", suggestion: "Reimprimir as etiquetas antigas numa única remessa.", ...over }) as Finding;
const card = (over: Partial<Card> = {}): Card => ({ id: "story-ex0001", type: "story", title: "Imprimir etiqueta de preço", status: "release", findings: [finding()], ...over }) as Card;

describe("findingFixRefusal — a mesma frase no Inbox e no servidor", () => {
  it("aviso aberto ⇒ pode; tratado ou sumido ⇒ a recusa diz qual", () => {
    expect(findingFixRefusal(card(), "f1")).toBeNull();
    expect(findingFixRefusal(card({ findings: [finding({ status: "acknowledged" })] }), "f1")).toBe("Este aviso já foi tratado.");
    expect(findingFixRefusal(card(), "outro")).toBe("Este aviso não existe mais no card.");
    expect(findingFixRefusal(null, "f1")).toBe("Este aviso não existe mais no card.");
  });
});

describe("buildFindingFixCard — o conserto é um card novo no começo do fluxo, ligado à origem", () => {
  const build = (origin: Card) => buildFindingFixCard({ origin, finding: origin.findings[0], entryStatus: "triage", cards: [origin], today: "2026-10-02" });

  it("entrega técnica no passo de entrada, com o aviso, o detalhe e a sugestão no corpo", () => {
    const fix = build(card());
    expect(fix).toMatchObject({ type: "story", storyType: "technical", status: "triage", title: "Conserto: Etiquetas antigas não trazem a data do reajuste", labels: [FINDING_FIX_LABEL], links: [{ rel: "relates-to", to: "story-ex0001" }] });
    expect(fix.id).not.toBe("story-ex0001");
    expect(fix.body).toContain("- Card de origem: story-ex0001 — Imprimir etiqueta de preço");
    expect(fix.body).toContain("- Aviso (general, média): Etiquetas antigas não trazem a data do reajuste");
    expect(fix.body).toContain("Só as etiquetas impressas depois da mudança têm a data.");
    expect(fix.body).toContain("## O que a revisão sugere\n\nReimprimir as etiquetas antigas numa única remessa.");
    expect(fix.body).toContain("O dono mandou corrigir pelo Inbox em 2026-10-02.");
  });

  it("serve a MESMA história de usuário da origem: a própria origem quando ela é a história; senão, a que ela serve", () => {
    expect(build(card()).serves).toBe("story-ex0001");
    expect(build(card({ storyType: "user" })).serves).toBe("story-ex0001");
    expect(build(card({ storyType: "bug", serves: "story-ex0002" })).serves).toBe("story-ex0002");
    expect("serves" in build(card({ storyType: "technical", serves: undefined, parent: null }))).toBe(false);
  });

  it("aviso sem detalhe nem sugestão: o corpo não inventa seção vazia", () => {
    const fix = build(card({ findings: [finding({ detail: undefined, suggestion: undefined })] }));
    expect(fix.body).not.toContain("## O que a revisão sugere");
  });

  it("a importância vai em palavras", () => {
    expect([severityWords("high"), severityWords("medium"), severityWords("low"), severityWords("blocker"), severityWords("outra"), severityWords(null)]).toEqual(["alta", "média", "baixa", "bloqueante", "outra", ""]);
  });
});
