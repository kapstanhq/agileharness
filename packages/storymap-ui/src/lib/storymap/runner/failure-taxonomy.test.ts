import { describe, it, expect } from "vitest";
import { classifyFailure, type FailureRules } from "./findings";
import { coerceTargetProfileDetailed, QA_FAILURE_TEXT_TAIL_BYTES, qaOf } from "../target-profile";

// The deterministic failure taxonomy. The classifier is a PURE function of observable
// signals; these cases pin the boundary against RunOutcome (process death) and the review `lens`.
//
// O vocabulário de ambiente de UM alvo não mora no código: ele o declara em `settings.yaml → target.qa`. Os casos com
// declaração usam um alvo INVENTADO — um laboratório de testes com máquinas efêmeras («labvm») e licenças contadas,
// nas portas 6060/6061 — para provar que o mecanismo é genérico e que nenhum nome de produto sobrou no código.
const LAB: FailureRules = {
  ports: [6060, 6061],
  failureClasses: [
    { pattern: "labvm (?:pod|node) (?:evicted|lost)", class: "infra" },
    { pattern: "license seat unavailable", class: "infra" },
  ],
};

describe("classifyFailure — infra/test/app auto-attribution (baseline universal, sem declaração)", () => {
  it("attributes env/stack breakage to infra (the card is NOT at fault)", () => {
    for (const message of [
      "Error: Cannot find module 'left-pad-lite'",
      "code: MODULE_NOT_FOUND",
      "listen EADDRINUSE: address already in use :::3008",
      "port 6060 is already in use",
      "FATAL ERROR: JavaScript heap out of memory",
      "spawn bikeshop-cli ENOENT",
      "bash: bikeshop-cli: command not found",
    ]) {
      expect(classifyFailure({ message }), message).toBe("infra");
    }
  });

  it("a porta da PRÓPRIA ferramenta (padrão ou configurada) é ambiente; a de outra instalação não", () => {
    expect(classifyFailure({ message: "esperava o painel em http://127.0.0.1:3008/ e não veio" })).toBe("infra");
    expect(classifyFailure({ message: "esperava o painel em http://127.0.0.1:3500/ e não veio" })).toBe("app");
    expect(classifyFailure({ message: "esperava o painel em http://127.0.0.1:3500/ e não veio" }, { selfPort: 3500 })).toBe("infra");
  });

  it("SEM declaração nenhum vocabulário de produto sobrou no código: o texto do alvo cai em app", () => {
    // o que um alvo declararia (as máquinas dele, as portas dele) NÃO é conhecido da ferramenta
    expect(classifyFailure({ message: "labvm pod evicted during setup" })).toBe("app");
    expect(classifyFailure({ message: "labvm node lost mid-run" })).toBe("app");
    expect(classifyFailure({ message: "license seat unavailable for runner 4" })).toBe("app");
    expect(classifyFailure({ message: "something is holding http://127.0.0.1:6061/ hostage" })).toBe("app");
  });

  it("COM a declaração do alvo, os mesmos textos viram infra", () => {
    expect(classifyFailure({ message: "labvm pod evicted during setup" }, LAB)).toBe("infra");
    expect(classifyFailure({ message: "LABVM NODE LOST mid-run" }, LAB)).toBe("infra"); // flags padrão = i
    expect(classifyFailure({ message: "license seat unavailable for runner 4" }, LAB)).toBe("infra");
    expect(classifyFailure({ message: "something is holding http://127.0.0.1:6061/ hostage" }, LAB)).toBe("infra");
    // a declaração só ACRESCENTA: o baseline continua valendo
    expect(classifyFailure({ message: "code: MODULE_NOT_FOUND" }, LAB)).toBe("infra");
  });

  it("`ECONNREFUSED` NÃO é ambiente no baseline (nem em loopback): quem quiser, declara em target.qa.failureClasses", () => {
    // o baseline universal é o mesmo de antes do lote — acrescentar um padrão aqui mudaria o carimbo failureClass de quem não o pediu
    for (const message of ["connect ECONNREFUSED localhost:5000", "connect ECONNREFUSED ::1:5000", "connect ECONNREFUSED 127.0.0.1:5000", "connect ECONNREFUSED 10.0.0.5:443", "connect ECONNREFUSED api.example.com:443"]) {
      expect(classifyFailure({ message }), message).toBe("app");
    }
    // declarado pelo alvo, vale — e só no que o padrão dele cobre (loopback), não num serviço de terceiros
    const loopback: FailureRules = { failureClasses: [{ pattern: "ECONNREFUSED[^\\n]{0,32}(127\\.0\\.0\\.1|localhost|\\[?::1\\]?)", class: "infra" }] };
    expect(classifyFailure({ message: "connect ECONNREFUSED localhost:5000" }, loopback)).toBe("infra");
    expect(classifyFailure({ message: "connect ECONNREFUSED 10.0.0.5:443" }, loopback)).toBe("app");
  });

  it("a ordem das regras DECLARADAS é a do arquivo (a primeira que casar vence) e qualquer classe vale", () => {
    const rules: FailureRules = {
      failureClasses: [
        { pattern: "depot sync", class: "app" }, // mais específica: o defeito é do produto, mesmo que o texto cite a porta
        { pattern: ":6060", class: "infra" },
      ],
    };
    expect(classifyFailure({ message: "depot sync failed at :6060" }, rules)).toBe("app");
    expect(classifyFailure({ message: "lost :6060" }, rules)).toBe("infra");
  });

  it("uma regra declarada `class: app` vence um padrão do baseline, e `class: test` entra antes da heurística de seletor", () => {
    const rules: FailureRules = {
      failureClasses: [
        { pattern: "cannot find module 'bikeshop-pricing'", class: "app" },
        { pattern: "waiting for selector", class: "app" },
      ],
    };
    expect(classifyFailure({ message: "Error: Cannot find module 'bikeshop-pricing'" }, rules)).toBe("app");
    expect(classifyFailure({ message: "Error: Cannot find module 'other'" }, rules)).toBe("infra");
    expect(classifyFailure({ message: "waiting for selector #pay" }, rules)).toBe("app");
    expect(classifyFailure({ message: "waiting for selector #pay" })).toBe("test");
  });

  it("attributes a bad spec/selector — or a criterion that passes at another layer — to test", () => {
    expect(classifyFailure({ message: "locator.click: Timeout 30000ms exceeded waiting for selector" })).toBe("test");
    expect(classifyFailure({ message: "strict mode violation: getByRole('button') resolved to 3 elements" })).toBe("test");
    expect(classifyFailure({ passedAtOtherLayer: true, message: "expected true to be false" })).toBe("test");
  });

  it("attributes a genuine criterion miss to app", () => {
    expect(classifyFailure({ criterionUnmet: true })).toBe("app");
    // a plain product assertion with none of the infra/test signals → the app didn't meet the criterion
    expect(classifyFailure({ message: "expected 'Salvar' to be visible but it was not" })).toBe("app");
    expect(classifyFailure({ criterionUnmet: true, message: "expected 3 to equal 4" }, LAB)).toBe("app");
  });

  it("resolves most-specific-first: infra wins when signals collide", () => {
    expect(
      classifyFailure({ message: "MODULE_NOT_FOUND thrown while waiting for selector", passedAtOtherLayer: true }),
    ).toBe("infra");
  });

  it("returns undefined with no signal (stays sparse — never invents a class)", () => {
    expect(classifyFailure({})).toBeUndefined();
    expect(classifyFailure({ message: "" })).toBeUndefined();
    expect(classifyFailure({ message: null })).toBeUndefined();
    expect(classifyFailure({}, LAB)).toBeUndefined();
  });
});

describe("regras declaradas — compilação defensiva e custo", () => {
  const declared = (failureClasses: unknown[], ports?: unknown) => coerceTargetProfileDetailed({ qa: { failureClasses, ...(ports !== undefined ? { ports } : {}) } });

  it("regex inválida, pattern > 200, flag fora de [ims], quantificador aninhado e classe desconhecida são DESCARTADOS (as demais valem)", () => {
    const { profile, discarded } = declared([
      { pattern: "([unclosed", class: "infra" },
      { pattern: "a".repeat(201), class: "infra" },
      { pattern: "ok-flags", class: "infra", flags: "g" },
      { pattern: "(a+)+$", class: "infra" },
      { pattern: "does not matter", class: "catastrophe" },
      { pattern: "labvm pod evicted", class: "infra" },
    ]);
    expect(profile?.qa?.failureClasses).toEqual([{ pattern: "labvm pod evicted", class: "infra" }]);
    expect(discarded).toHaveLength(5);
    expect(classifyFailure({ message: "the labvm pod evicted us" }, qaOf(profile))).toBe("infra");
  });

  it("mais de 40 regras: o excedente é descartado", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ pattern: `rule-${i}-x`, class: "infra" }));
    const { profile, discarded } = declared(many);
    expect(profile?.qa?.failureClasses).toHaveLength(40);
    expect(discarded).toHaveLength(5);
  });

  it("portas fora de 1–65535 ou não inteiras são descartadas; as boas viram infra", () => {
    const { profile } = declared([], [6060, 0, 70000, 1.5, "6061", 6062]);
    expect(profile?.qa?.ports).toEqual([6060, 6062]);
    expect(classifyFailure({ message: "busy :6062" }, qaOf(profile))).toBe("infra");
    expect(classifyFailure({ message: "busy :6061" }, qaOf(profile))).toBe("app");
  });

  it("uma mensagem de 1 MB com regra declarada responde rápido (só o final do texto é lido)", () => {
    const huge = `${"a".repeat(1_000_000)} depot unreachable`;
    const rules: FailureRules = { failureClasses: [{ pattern: "depot\\s+unreachable", class: "infra" }] };
    const t0 = performance.now();
    const cls = classifyFailure({ message: huge }, rules);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(cls).toBe("infra"); // o trecho relevante está no FINAL, que é o que a regra declarada lê
  });

  it("texto MAIOR que o limite: a regra declarada olha a CABEÇA e o RABO (o erro costuma estar numa das pontas)", () => {
    const rules: FailureRules = {
      failureClasses: [
        { pattern: "labvm (?:pod|node) (?:evicted|lost)", class: "infra" },
        { pattern: "depot\\s+unreachable", class: "app" },
      ],
    };
    const meio = "z".repeat(QA_FAILURE_TEXT_TAIL_BYTES + 100);
    // no COMEÇO de um log longo (o rabo sozinho não o veria) — o baseline antigo, que lia tudo, o pegava
    expect(classifyFailure({ message: `labvm pod evicted ${meio}` }, rules)).toBe("infra");
    // no FIM
    expect(classifyFailure({ message: `${meio} depot unreachable` }, rules)).toBe("app");
    // no MEIO de um log gigante (fora das duas pontas) segue sem casar
    const gigante = `${"a".repeat(QA_FAILURE_TEXT_TAIL_BYTES + 10)} labvm pod evicted ${"a".repeat(QA_FAILURE_TEXT_TAIL_BYTES + 10)}`;
    expect(classifyFailure({ message: gigante }, rules)).toBe("app");
    // a ORDEM das regras vale entre as pontas: a regra 1 casa na CABEÇA e a 2 no RABO — vence a 1 (a primeira do arquivo)
    expect(classifyFailure({ message: `labvm node lost ${meio} depot unreachable` }, rules)).toBe("infra");
    // …e invertendo a ordem das regras, vence a que passou a ser a 1ª
    expect(classifyFailure({ message: `labvm node lost ${meio} depot unreachable` }, { failureClasses: [...(rules.failureClasses ?? [])].reverse() })).toBe("app");
  });
});
