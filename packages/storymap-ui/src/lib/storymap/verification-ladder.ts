// Verification ladder — the PURE, zero-IO heuristic that routes an acceptance
// criterion to the CHEAPEST test layer that can actually prove it.
//
// The harness-qa and harness-tests SKILLs describe this ladder in prose ("Route by the
// ACCEPTANCE's surface" / "Derive the pyramid"): prefer the base of the pyramid,
// escalate only when the criterion genuinely needs a heavier stack. This module
// encodes the SAME taxonomy as code so the routing is deterministic and testable
// (sibling to gate-core.js / pipeline-routing.ts — no IO, no LLM, isomorphic):
//
//   component   — the cheapest layer that renders the surface: UI presence /
//                 mount / nav / renders / visible / breakpoint / mobile|desktop /
//                 layout. Provable with a component/render test. uiObservable.
//   integration — the criterion asserts a data/backend fact (data / API / Cloud
//                 Function / Firestore / persiste|salvo / server-action /
//                 webhook) a render test can't fake. NOT UI-observable.
//   browser     — genuinely visual (animação|transição|scroll|"visualmente"|
//                 cross-viewport|pixel): can only be proven in a real browser.
//                 uiObservable.
//
// Precedence (cheapest-first with two overrides): a genuinely-visual signal wins
// outright (browser — nothing cheaper can prove it); else a data/backend signal
// wins over a render signal (integration — a component test can't prove
// persistence/API); else a render signal (component); else the ambiguous
// fallback: clearly UI-facing → component, otherwise → integration (safe default).
// Matching is word-boundary + case-insensitive so "api" doesn't hit "rápido".

export type VerificationLayer = "component" | "integration" | "browser";

export interface CriterionPlan {
  criterion: string;
  layer: VerificationLayer;
  signals: string[];
  uiObservable: boolean;
}

// Genuinely-visual keywords — only a real browser proves these. Highest priority.
const BROWSER_KEYWORDS = [
  "animação",
  "animacao",
  "animações",
  "animacoes",
  "animation",
  "animated",
  "transição",
  "transicao",
  "transições",
  "transicoes",
  "transition",
  "scroll",
  "scrolling",
  "rolagem",
  "visualmente",
  "visually",
  "visual",
  "pixel",
  "pixels",
  "cross-viewport",
  "cross viewport",
  "viewport",
  "viewports",
  "parallax",
] as const;

// Data / backend keywords — a render test can't fake these; needs a real stack.
const INTEGRATION_KEYWORDS = [
  "dados",
  "data",
  "api",
  "cloud function",
  "cloud-function",
  "firestore",
  "persiste",
  "persistem",
  "persistido",
  "persistida",
  "persistência",
  "persistencia",
  "persist",
  "persists",
  "persisted",
  "salvo",
  "salva",
  "salvos",
  "salvas",
  "salvar",
  "save",
  "saves",
  "saved",
  "server action",
  "server-action",
  "server actions",
  "webhook",
  "webhooks",
  "database",
  "banco de dados",
  "endpoint",
  "endpoints",
  "backend",
  "request",
  "requisição",
  "requisicao",
] as const;

// UI presence / mount / nav / render keywords — the cheapest render layer.
const COMPONENT_KEYWORDS = [
  "aparece",
  "aparecem",
  "appears",
  "appear",
  "monta",
  "montado",
  "montada",
  "mount",
  "mounts",
  "mounted",
  "nav",
  "navbar",
  "navega",
  "navegar",
  "navegação",
  "navegacao",
  "navigation",
  "navigate",
  "menu",
  "renderiza",
  "renderizam",
  "renderizado",
  "renderizada",
  "render",
  "renders",
  "rendered",
  "visível",
  "visivel",
  "visible",
  "exibe",
  "exibem",
  "exibido",
  "exibida",
  "mostra",
  "mostrado",
  "display",
  "displays",
  "displayed",
  "shown",
  "breakpoint",
  "breakpoints",
  "mobile",
  "desktop",
  "layout",
  "presente",
  "presença",
  "presenca",
  "present",
  "presence",
] as const;

// Broader UI-facing hints — used ONLY for the ambiguous fallback (→ component).
const UI_HINT_KEYWORDS = [
  "tela",
  "telas",
  "screen",
  "screens",
  "página",
  "pagina",
  "page",
  "botão",
  "botao",
  "botões",
  "botoes",
  "button",
  "componente",
  "component",
  "cabeçalho",
  "cabecalho",
  "header",
  "footer",
  "rodapé",
  "rodape",
  "card",
  "modal",
  "tooltip",
  "banner",
  "ícone",
  "icone",
  "icon",
  "label",
  "clica",
  "clicar",
  "click",
  "clicks",
  "toca",
  "tap",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Canonical keywords from `keywords` that appear as whole words in `text`. */
function matchKeywords(text: string, keywords: readonly string[]): string[] {
  const found: string[] = [];
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, "iu");
    if (re.test(text) && !found.includes(kw)) found.push(kw);
  }
  return found;
}

/** A layer is UI-observable iff it renders a surface (component or browser). */
function isUiObservable(layer: VerificationLayer): boolean {
  return layer === "component" || layer === "browser";
}

/**
 * Classify ONE acceptance criterion into its cheapest verification layer, the
 * matched keyword `signals`, and whether the layer is UI-observable. Handles
 * PT-BR Gherkin (Dado/Quando/Então) and EN. Deterministic + PURE.
 */
export function classifyCriterion(text: string): {
  layer: VerificationLayer;
  signals: string[];
  uiObservable: boolean;
} {
  const decide = (layer: VerificationLayer, signals: string[]) => ({
    layer,
    signals,
    uiObservable: isUiObservable(layer),
  });

  const browser = matchKeywords(text, BROWSER_KEYWORDS);
  if (browser.length > 0) return decide("browser", browser);

  const integration = matchKeywords(text, INTEGRATION_KEYWORDS);
  if (integration.length > 0) return decide("integration", integration);

  const component = matchKeywords(text, COMPONENT_KEYWORDS);
  if (component.length > 0) return decide("component", component);

  // Ambiguous: clearly UI-facing → component; otherwise the safe default is
  // integration (an unproven data/behaviour fact needs the real stack).
  const uiHint = matchKeywords(text, UI_HINT_KEYWORDS);
  if (uiHint.length > 0) return decide("component", uiHint);

  return decide("integration", []);
}

/**
 * Plan verification for a card's whole `acceptance[]`: classify each criterion,
 * preserving order and the original criterion text. PURE — the caller decides
 * what to do with each plan (author a component test, an integration test, or a
 * browser sweep). Empty in → empty out.
 */
export function planVerification(acceptance: string[]): CriterionPlan[] {
  return acceptance.map((criterion) => {
    const { layer, signals, uiObservable } = classifyCriterion(criterion);
    return { criterion, layer, signals, uiObservable };
  });
}
