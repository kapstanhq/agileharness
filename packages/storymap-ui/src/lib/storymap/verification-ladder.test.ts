import { describe, expect, it } from "vitest";
import { classifyCriterion, planVerification } from "./verification-ladder";
import type { VerificationLayer } from "./verification-ladder";

// Criterion → cheapest-layer TABLE. Each row is an acceptance criterion (as it
// would read on a card — PT-BR Gherkin Dado/Quando/Então or EN), the layer the
// coded ladder should route it to, and whether that layer is UI-observable. The
// table mirrors the taxonomy the harness-qa / harness-tests SKILLs describe in prose:
// component (cheapest render/mount/nav) → integration (data/API/persistence) →
// browser (genuinely visual: animation/scroll/pixel). uiObservable is derived
// from the layer (component|browser = true, integration = false).
const cases: {
  name: string;
  text: string;
  layer: VerificationLayer;
  uiObservable: boolean;
  signal?: string; // one keyword we expect to appear in signals
}[] = [
  // — component: UI presence / mount / nav / renders / breakpoint (PT + EN) —
  {
    name: "PT: bottom nav aparece no mobile → component",
    text: "Dado que estou no mobile, quando abro /account, então a bottom nav aparece",
    layer: "component",
    uiObservable: true,
    signal: "nav",
  },
  {
    name: "EN: navigation bar renders on desktop → component",
    text: "The navigation bar renders on desktop",
    layer: "component",
    uiObservable: true,
    signal: "renders",
  },
  {
    name: "PT: componente monta e fica visível → component",
    text: "Então o componente monta e fica visível na tela",
    layer: "component",
    uiObservable: true,
    signal: "monta",
  },
  // — integration: data / API / Cloud Function / Firestore / persiste (PT + EN) —
  {
    name: "PT: dados salvos no Firestore → integration",
    text: "Então os dados são salvos no Firestore",
    layer: "integration",
    uiObservable: false,
    signal: "firestore",
  },
  {
    name: "EN: Cloud Function persists via the API → integration",
    text: "The Cloud Function persists the record via the API",
    layer: "integration",
    uiObservable: false,
    signal: "cloud function",
  },
  {
    name: "PT: webhook persiste a assinatura → integration",
    text: "Quando o webhook do Asaas chega, então a assinatura é persistida",
    layer: "integration",
    uiObservable: false,
    signal: "webhook",
  },
  {
    name: "EN: server action saves the profile → integration",
    text: "The server action saves the profile",
    layer: "integration",
    uiObservable: false,
    signal: "server action",
  },
  // — browser: genuinely visual (animation / transition / scroll / pixel) —
  {
    name: "PT: animação dispara ao scroll → browser",
    text: "Então a animação de entrada do card dispara ao scroll",
    layer: "browser",
    uiObservable: true,
    signal: "animação",
  },
  {
    name: "EN: transition is visually smooth across viewports → browser",
    text: "The card transition is visually smooth across viewports",
    layer: "browser",
    uiObservable: true,
    signal: "transition",
  },
  {
    name: "PT: sombra bate pixel a pixel → browser",
    text: "A sombra deve bater pixel a pixel com o design",
    layer: "browser",
    uiObservable: true,
    signal: "pixel",
  },
  // — ambiguous but clearly UI-facing → component (PT + EN) —
  {
    name: "PT: usuário vê a tela de boas-vindas → component (ui-facing fallback)",
    text: "Então o usuário vê a tela de boas-vindas",
    layer: "component",
    uiObservable: true,
    signal: "tela",
  },
  {
    name: "EN: welcome screen greets the user → component (ui-facing fallback)",
    text: "The welcome screen greets the user",
    layer: "component",
    uiObservable: true,
    signal: "screen",
  },
  // — ambiguous, no UI signal → integration (safe default) —
  {
    name: "PT: sistema calcula o valor total → integration (default)",
    text: "Então o sistema calcula o valor total corretamente",
    layer: "integration",
    uiObservable: false,
  },
  // — mixed precedence: data/API beats render → integration —
  {
    name: "PT: lista renderiza os dados da API → integration (data beats render)",
    text: "Então a lista renderiza os dados vindos da API",
    layer: "integration",
    uiObservable: false,
    signal: "api",
  },
  // — mixed precedence: genuinely-visual beats data → browser —
  {
    name: "PT: animação aparece quando os dados chegam da API → browser (visual wins)",
    text: "A animação aparece quando os dados chegam da API",
    layer: "browser",
    uiObservable: true,
    signal: "animação",
  },
];

describe("classifyCriterion — criterion shape → cheapest verification layer", () => {
  for (const c of cases) {
    it(c.name, () => {
      const got = classifyCriterion(c.text);
      expect(got.layer).toBe(c.layer);
      expect(got.uiObservable).toBe(c.uiObservable);
      // uiObservable is always derived from the layer, never contradictory.
      expect(got.uiObservable).toBe(c.layer === "component" || c.layer === "browser");
      if (c.signal) {
        expect(got.signals).toContain(c.signal);
      }
    });
  }

  it("returns empty signals for a criterion with no keyword (pure default)", () => {
    const got = classifyCriterion("Então o sistema calcula o valor total corretamente");
    expect(got.signals).toEqual([]);
    expect(got.layer).toBe("integration");
  });

  it("does not false-match 'api' inside 'rápido' (word-boundary matching)", () => {
    // "rápido" contains the substring "api"; word-boundary matching must NOT
    // treat it as an integration signal. With no real keyword it falls to the
    // integration DEFAULT — but with EMPTY signals, proving no false match.
    const got = classifyCriterion("Então o carregamento é rápido");
    expect(got.signals).not.toContain("api");
    expect(got.signals).toEqual([]);
    expect(got.layer).toBe("integration");
  });

  it("is case-insensitive", () => {
    expect(classifyCriterion("THE NAV RENDERS").layer).toBe("component");
    expect(classifyCriterion("os DADOS são SALVOS").layer).toBe("integration");
  });
});

describe("planVerification — maps an acceptance list to CriterionPlan[]", () => {
  it("preserves order, text, and per-criterion classification", () => {
    const acceptance = [
      "Então a bottom nav aparece no mobile",
      "Então os dados são salvos no Firestore",
      "Então a animação dispara ao scroll",
    ];
    const plans = planVerification(acceptance);
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.criterion)).toEqual(acceptance);
    expect(plans.map((p) => p.layer)).toEqual(["component", "integration", "browser"]);
    expect(plans.map((p) => p.uiObservable)).toEqual([true, false, true]);
    expect(plans[0].signals).toContain("nav");
  });

  it("returns [] for an empty acceptance list", () => {
    expect(planVerification([])).toEqual([]);
  });
});
