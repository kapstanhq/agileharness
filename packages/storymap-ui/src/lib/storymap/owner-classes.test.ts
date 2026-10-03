import { describe, expect, it } from "vitest";
import { DEFAULT_OWNER_CLASSES, MONEY_CLASS, ownerClassLabel, ownerClassesOf } from "./owner-classes";

// As classes do dono: o PISO neutro da ferramenta e a redação que o alvo declara. Os exemplos declarados abaixo são
// inventados (uma oficina de bicicletas fictícia).
describe("DEFAULT_OWNER_CLASSES — o piso neutro", () => {
  it("as quatro classes padrão, nesta ordem, cada uma com rótulo e descrição", () => {
    expect(DEFAULT_OWNER_CLASSES.map((c) => c.id)).toEqual(["money", "brand-voice", "prd", "personal-data"]);
    for (const c of DEFAULT_OWNER_CLASSES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(20);
    }
  });

  it("nenhuma descrição traz exemplo de produto de um repositório específico", () => {
    for (const c of DEFAULT_OWNER_CLASSES) {
      expect(c.description, c.id).not.toMatch(/\bex\.|por exemplo/i);
    }
    // a de dinheiro fala em termos gerais — serviço pago de que o produto depende — e MANTÉM a cláusula da troca de modelo/
    // fornecedor de IA (muda custo e qualidade: a decisão de dinheiro que passa por «técnica»), sem citar produto nenhum
    expect(DEFAULT_OWNER_CLASSES[0].description).toMatch(/serviço pago de que o produto depende/);
    expect(DEFAULT_OWNER_CLASSES[0].description).toMatch(/trocar .*o modelo ou o fornecedor de IA que atende o usuário do produto \(muda custo e qualidade\)/);
  });
});

describe("ownerClassesOf — o alvo declara a redação dele; o piso de dinheiro nunca se desliga", () => {
  it("sem declaração valem as classes padrão", () => {
    expect(ownerClassesOf(undefined)).toEqual([...DEFAULT_OWNER_CLASSES]);
    expect(ownerClassesOf({ autonomy: { ownerClasses: [] } } as never)).toEqual([...DEFAULT_OWNER_CLASSES]);
  });

  it("a declaração do alvo vence o padrão (a redação dele, o exemplo dele)", () => {
    const money = { id: "money", label: "Dinheiro", description: "Qualquer gasto novo, inclusive trocar a transportadora das entregas da oficina de bicicletas." };
    const declared = ownerClassesOf({ autonomy: { ownerClasses: [money, { id: "legal", label: "Jurídico", description: "contratos com fornecedores" }] } } as never);
    expect(declared.map((c) => c.id)).toEqual(["money", "legal"]);
    expect(declared[0].description).toBe(money.description);
  });

  it("um board que declara só OUTRAS classes mantém o piso `money` (a do padrão neutro)", () => {
    const cls = ownerClassesOf({ autonomy: { ownerClasses: [{ id: "legal", label: "Jurídico", description: "contratos" }] } } as never);
    expect(cls.map((c) => c.id)).toEqual([MONEY_CLASS, "legal"]);
    expect(cls[0]).toEqual(DEFAULT_OWNER_CLASSES[0]);
  });

  it("o rótulo vem da classe declarada; classe desconhecida mostra o próprio id", () => {
    const cfg = { autonomy: { ownerClasses: [{ id: "legal", label: "Jurídico", description: "contratos" }] } } as never;
    expect(ownerClassLabel("legal", cfg)).toBe("Jurídico");
    expect(ownerClassLabel("sem-esta", cfg)).toBe("sem-esta");
    expect(ownerClassLabel("money", undefined)).toBe("Dinheiro e preço");
  });
});
