import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// WS-3 (copilot-actionability) — contract-over-SOURCE for the Inbox cockpit renderers
// (CockpitView.tsx). The AgileHarness UI test rig is node-env with no DOM renderer (jsdom/testing-library
// are absent, the include glob is `*.test.ts` only — invariant 5), so, mirroring the pattern of
// `kanban-card-footer.test.ts`, the contract is asserted against the component SOURCE: the presence
// (or absence) of a symbol IS the assertion. Guards the non-negotiables of the WS:
//   (a) DeployFailedRenderer NEVER references updateFindingStatusAction (risk 7 — the finding only
//       resolves via the settle webhook, never the UI).
//   (b) EVERY registered renderer ends in <ItemActions> — a GRAMÁTICA ÚNICA de ação (§3.6 + o WS da
//       decisão rápida). Antes o contrato era "cada renderer renderiza <EscalateButton>", e ele passava
//       com 15 fileiras montadas à mão, cada uma numa ordem/peso diferente. Agora a fileira é UMA: o
//       Jido (e o "Abrir card", e o peso do primário) vive DENTRO dela — logo o contrato move-se para
//       "todo renderer passa por ItemActions" + "ItemActions garante o Jido", que é a MESMA garantia
//       de antes e mais forte (também fixa a ORDEM, que a versão anterior não cobria).
//   (c) The ApprovalRenderer `apr:` branch references item.args (D12 — fim da aprovação às cegas).
//   (d) GateRenderer references MovePreview (§3.3 — the Devolver from→para visual preview).
const source = readFileSync(fileURLToPath(new URL("./CockpitView.tsx", import.meta.url)), "utf8");

/** Ordered function markers as they appear in CockpitView.tsx — used to bound each renderer's block to
 *  [its own start, the NEXT marker's start) so an assertion never accidentally reads into a neighbor. */
const MARKERS = [
  "function ItemActions(", // a fileira compartilhada — não é um KIND_RENDERER, só o limite superior
  "function QuestionRenderer(",
  "function FindingRenderer(",
  "function BlockerRenderer(",
  "function DeployFailedRenderer(",
  "function DeployFailureLogModal(", // helper, not a KIND_RENDERER entry — only used as a boundary
  "function ApprovalRenderer(",
  "function GateRenderer(",
  "function ReviewRenderer(",
  "function StuckRenderer(",
  "function ConflictRenderer(",
  "function ProposalRenderer(",
  "function DesignRenderer(",
  "function DeployUnsettledRenderer(", // WS-5
  "function ReleaseAgingRenderer(", // WS-5
  "function MergeFailedRenderer(", // WS-5
  "function GovernanceRenderer(",
] as const;

function region(marker: (typeof MARKERS)[number]): string {
  const idx = MARKERS.indexOf(marker);
  expect(idx, `marker present: ${marker}`).toBeGreaterThanOrEqual(0);
  const start = source.indexOf(marker);
  expect(start, `marker found in source: ${marker}`).toBeGreaterThan(-1);
  const nextMarker = MARKERS[idx + 1];
  const end = nextMarker ? source.indexOf(nextMarker, start) : source.length;
  if (nextMarker) expect(end, `next marker found: ${nextMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

// The 15 real KIND_RENDERER entries (DeployFailureLogModal e ItemActions são helpers, não entradas).
const RENDERER_MARKERS = MARKERS.filter(
  (m) => m !== "function DeployFailureLogModal(" && m !== "function ItemActions(",
);

describe("KIND_RENDERER registers a distinct renderer per CockpitItemKind (15: 14 da WS-5 + `finding`)", () => {
  it("routes every kind through a distinct renderer function", () => {
    const kindRendererBlock = source.slice(
      source.indexOf("const KIND_RENDERER"),
      source.indexOf("// ── Shell: ToastProvider wrapper"),
    );
    for (const kind of [
      "question",
      "blocker",
      "finding",
      "deploy-failed",
      "gate",
      "approval",
      "review",
      "stuck",
      "conflict",
      "proposal",
      "design",
      "governance",
      "deploy-unsettled",
      "release-aging",
      "merge-failed",
    ]) {
      // A hyphenated kind ("deploy-failed") is an invalid bare identifier, so it's a QUOTED key in the
      // object literal ("deploy-failed": …) — match the literal key text either way.
      const key = kind.includes("-") ? `"${kind}":` : `${kind}:`;
      expect(kindRendererBlock).toContain(key);
    }
    // gate now routes through the extracted GateRenderer — NOT the shared ApprovalRenderer (§3.3).
    expect(kindRendererBlock).toMatch(/gate:\s*\(item, ctx\) => <GateRenderer/);
    expect(kindRendererBlock).toMatch(/approval:\s*\(item, ctx\) => <ApprovalRenderer/);
  });
});

describe("(a) risk 7 — DeployFailedRenderer never marks the finding resolved from the UI", () => {
  it("does NOT CALL updateFindingStatusAction anywhere in its body (a doc comment naming it is fine)", () => {
    expect(region("function DeployFailedRenderer(")).not.toMatch(/updateFindingStatusAction\(/);
  });

  it("still offers Re-publicar (qa.primary) and the read-only Ver log affordance", () => {
    const block = region("function DeployFailedRenderer(");
    expect(block).toMatch(/quickActionsFor\(item, ctx\.config, ctx\.card\)/);
    expect(block).toMatch(/Ver log/);
  });
});

describe("(b) uma gramática só de ação — todo renderer termina em <ItemActions>", () => {
  it.each(RENDERER_MARKERS)("%s renderiza <ItemActions …/>", (marker) => {
    expect(region(marker)).toMatch(/<ItemActions\b/);
  });

  it("o Jido vive DENTRO da fileira — uma ocorrência no arquivo inteiro, nenhuma solta num renderer", () => {
    expect(source.match(/<EscalateButton\b/g)?.length).toBe(1);
    expect(region("function ItemActions(")).toMatch(/<EscalateButton\b/);
  });

  it("a ORDEM é fixa: ação principal → alternativas → afordâncias → Abrir card → Jido", () => {
    const block = region("function ItemActions(");
    const at = (needle: string) => {
      const i = block.indexOf(needle);
      expect(i, `presente na fileira: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("{lead}")).toBeLessThan(at("qa.primary"));
    expect(at("qa.primary")).toBeLessThan(at("qa?.secondary"));
    expect(at("qa?.secondary")).toBeLessThan(at("{trail}"));
    expect(at("{trail}")).toBeLessThan(at("{openCardLabel}"));
    expect(at("{openCardLabel}")).toBeLessThan(at("<EscalateButton"));
  });

  it("só a PRIMÁRIA tem peso de botão cheio (size md); as demais ficam discretas", () => {
    const block = region("function ItemActions(");
    expect(block.match(/size="md"/g)?.length).toBe(1);
    // e ela é a do registry — o `lead` (submit de formulário inline) usa a classe PRIMARY_BTN
    expect(block.slice(block.indexOf("qa.primary"), block.indexOf("qa?.secondary"))).toMatch(/size="md"/);
  });
});

describe("(c) D12 — ApprovalRenderer's apr: branch shows the canonical args", () => {
  it("references item.args (the evidence block + the confirm) — fim da aprovação às cegas", () => {
    const block = region("function ApprovalRenderer(");
    expect(block).toMatch(/item\.args/);
    expect(block).toMatch(/prettyCanonicalArgs/);
  });

  it("still delegates the non-apr: (data-deletion) fallback to GateRenderer, byte-preserved", () => {
    expect(region("function ApprovalRenderer(")).toMatch(/return <GateRenderer item={item} ctx={ctx} \/>;/);
  });
});

describe("(d) GateRenderer põe o DESTINO no botão, não solto ao lado dele", () => {
  // Supersede o §3.3 (que exigia um <MovePreview> no corpo). Aquela seta era a do DEVOLVER, mas ficava sem
  // legenda ao lado de uma fileira cujo primeiro botão é o Aprovar — e lia-se como um avanço INVERTIDO, com
  // três nomes de passo na tela (chip do cabeçalho + "Próximo: …" + a seta) e nenhum amarrado ao seu botão.
  it("passa withDestination aos botões de ação (cada gatilho diz para onde ELE manda)", () => {
    // O destino no rótulo virou propriedade da FILEIRA (vale para todo kind que move algo — aceitar da
    // triagem imprime "Aceitar → Refinar" pela mesma via), não mais um opt-in que cada renderer lembrava.
    expect(region("function ItemActions(")).toMatch(/withDestination/);
  });

  it("não renderiza mais um MovePreview solto no corpo do item", () => {
    expect(region("function GateRenderer(")).not.toMatch(/<MovePreview\b/);
  });

  it("não repete o nome do passo ATUAL como se fosse o alvo (o chip do cabeçalho já o mostra)", () => {
    // Num gate de pipeline gateLabel === nome do status atual; só imprimimos quando ACRESCENTA algo.
    expect(region("function GateRenderer(")).toMatch(/extraLabel/);
  });

  it("dispatches via QUICK_ACTIONS_OF.gate directly (not the kind-keyed quickActionsFor facade)", () => {
    // The data-deletion fallback item carries kind "approval" — quickActionsFor would route it to the
    // WRONG entry (empty primary). GateRenderer must call the gate entry directly regardless of caller.
    expect(region("function GateRenderer(")).toMatch(/QUICK_ACTIONS_OF\.gate\(/);
  });
});
