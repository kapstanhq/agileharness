import { describe, expect, it } from "vitest";
import {
  mergeFailedActionsFor,
  blockedTargets,
  optionAsQuickAction,
  prettyCanonicalArgs,
  quickActionFeedback,
  SENSITIVE_AUDIT_CLASSES,
  type QuickAction,
  type QuickActionInvoke,
} from "./quick-actions";
import { moveTargets } from "./move-targets";
import { evaluateGate } from "./gates";
import type { BoardConfig, Card, CardType, StatusDef } from "./types";
import type { MergeFailedCockpitItem } from "./demands";

// O registry por kind (QUICK_ACTIONS_OF) saiu na onda 2 do Inbox: o que cada item oferece mora no modelo do item, e as
// garantias dele (pré-condições com a frase do servidor, efeito externo nomeado, a exclusão de dados que aprova a
// exclusão, B21, B7, F6, B12) vivem em inbox/decision.test.ts. Aqui fica o que é deste módulo: a ponte do modelo para o
// botão compacto, o /processes, os destinos recusados do «Mover» e o retorno do clique.
//
// O rodapé próprio do Kanban (cardNextAction, mergeEntryDemand, runRetryLabel) SAIU junto com os testes
// dele: ele montava a demanda pelo modelo legado e oferecia botão de resolver em card que o sistema estava resolvendo.
// O botão do card agora é a opção do item de Decidir (inbox/decidir-set.test.ts).

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────
const BASE_CARD = {
  id: "c1",
  type: "story" as CardType,
  title: "T",
  storyType: "user",
  status: null,
  parent: null,
  release: null,
  personas: [],
  systems: [],
  links: [],
  narrative: { role: "", want: "", soThat: "" },
  acceptance: [],
  tasks: [],
  rice: {},
  kano: null,
  funnelStage: null,
  findings: [],
  order: 10,
  created: null,
  updated: null,
  body: "",
} as unknown as Card;

const mkCard = (over: Partial<Card> = {}): Card => ({ ...BASE_CARD, ...over });
const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
const mkConfig = (statuses: StatusDef[]): BoardConfig => ({ id: "storymap", name: "AgileHarness", statuses }) as BoardConfig;

// ── Tests ────────────────────────────────────────────────────────────────────────────────────
describe("a ponte do modelo para o botão compacto", () => {
  it("leva o rótulo, a consequência (como descrição) e a recusa; o que o botão não executa fica de fora", () => {
    const a = optionAsQuickAction({
      id: "x", label: "Publicar em produção", consequence: "Publica.", tone: "danger", auditCls: "deploy",
      invoke: { kind: "move-card", boardId: "b", cardId: "c1", status: "deploy" }, done: "ok", disabled: { reason: "em voo" },
      confirm: { title: "t", body: "b" },
    });
    expect(a).toMatchObject({ label: "Publicar em produção", description: "Publica.", disabled: "em voo", confirm: { title: "t", body: "b" } });
    expect(optionAsQuickAction({ id: "y", label: "Responder", consequence: "c", tone: "primary", auditCls: "write-board", invoke: { kind: "answer-question", boardId: "b", cardId: "c1", questionId: "q1" }, done: "ok" })).toBeNull();
    expect(optionAsQuickAction(null)).toBeNull();
  });

  it("o /processes (sem a config do board) mostra as ações de integração falha do modelo", () => {
    const item = { id: "c1:merge-failed:r1", kind: "merge-failed", boardId: "b", cardId: "c1", cardTitle: "T", status: "merge", lane: "travado", severity: "high", runId: "r1", branch: "run/r1" } as MergeFailedCockpitItem;
    const set = mergeFailedActionsFor(item);
    expect(set.primary).toMatchObject({ label: "Integrar de novo", invoke: { kind: "requeue-merge", runId: "r1" } });
    expect(set.secondary.map((a) => a.invoke)).toEqual([{ kind: "discard-branch", branch: "run/r1" }]);
    expect(set.escalate?.invoke.kind).toBe("escalate");
  });
});

describe("SENSITIVE_AUDIT_CLASSES", () => {
  it("é exatamente {run, merge-resolve, deploy, destructive}", () => {
    expect([...SENSITIVE_AUDIT_CLASSES].sort()).toEqual(["deploy", "destructive", "merge-resolve", "run"]);
  });
});

describe("prettyCanonicalArgs (D12 — fim da aprovação às cegas)", () => {
  it("pretty-prints valid canonical JSON", () => {
    expect(prettyCanonicalArgs('{"a":1,"b":"x"}')).toBe(JSON.stringify({ a: 1, b: "x" }, null, 2));
  });

  it("falls back to the raw string on invalid/truncated JSON — never throws", () => {
    const truncated = '{"a":1,"b":"trunca';
    expect(() => prettyCanonicalArgs(truncated)).not.toThrow();
    expect(prettyCanonicalArgs(truncated)).toBe(truncated);
  });
});

describe("blockedTargets", () => {
  it("blockedTargets is the exact complement of moveTargets over the same checkGate", () => {
    const cfg = mkConfig([st("cur", "Cur"), st("gated", "Gated", { gate: "hasTasks" }), st("free", "Free")]);
    const card = mkCard({ id: "c1", status: "cur", tasks: [] }); // fails hasTasks
    const bts = blockedTargets(card, cfg);
    expect(bts.map((b) => b.status.id)).toEqual(["gated"]);
    const verdict = evaluateGate(card, "gated", cfg)!;
    expect(bts[0].gateLabel).toBe(verdict.label);
    expect(bts[0].message).toBe(verdict.message);

    const moveable = new Set(moveTargets(card, cfg).map((t) => t.status.id));
    const blocked = new Set(bts.map((b) => b.status.id));
    // disjoint, and their union is exactly config.statuses minus the current one.
    expect([...moveable].filter((id) => blocked.has(id))).toEqual([]);
    expect([...new Set([...moveable, ...blocked])].sort()).toEqual(["free", "gated"]);
  });
});

describe("B2 — o retorno do clique diz o que iniciou ou o que foi recusado, nunca «<rótulo>: ok»", () => {
  const INVOKES: QuickActionInvoke[] = [
    { kind: "move-card", boardId: "b", cardId: "c1", status: "next" },
    { kind: "run-skill", boardId: "b", cardId: "c1" },
    { kind: "force-release", boardId: "b", cardId: "c1" },
    { kind: "resolve-merge", runId: "r1", action: "merged" },
    { kind: "resolve-merge", runId: "r1", action: "aborted" },
    { kind: "resolve-gate", runId: "r1", action: "retry" },
    { kind: "resolve-gate", runId: "r1", action: "abort" },
    { kind: "update-finding", boardId: "b", cardId: "c1", findingId: "f1", status: "fixed" },
    { kind: "discard-branch", branch: "run/r1" },
    { kind: "requeue-merge", runId: "r1" },
    { kind: "accept-triage", boardId: "b", cardId: "c1" },
    { kind: "delete-card", boardId: "b", cardId: "c1" },
    { kind: "republish", boardId: "b", cardId: "c1" },
    { kind: "approve-data-deletion", boardId: "b", cardId: "c1" },
  ];
  const action = (invoke: QuickActionInvoke): QuickAction => ({ id: "x", label: "Rótulo", tone: "neutral", auditCls: "write-board", destination: "Próximo", invoke });

  it.each(INVOKES.map((i) => [`${i.kind}${"action" in i ? `:${i.action}` : ""}`, i] as const))("%s: sucesso sem desfecho do servidor ⇒ frase própria", (_n, invoke) => {
    const fb = quickActionFeedback(action(invoke), { ok: true });
    expect(fb.tone).toBe("success");
    expect(fb.text.length).toBeGreaterThan(8);
    expect(fb.text).not.toMatch(/: ok$/);
    expect(fb.text).not.toMatch(/^Rótulo/);
  });

  it("o desfecho do servidor vence (ex.: «iniciado» para uma publicação)", () => {
    const fb = quickActionFeedback(action({ kind: "republish", boardId: "b", cardId: "c1" }), {
      ok: true,
      data: { outcome: { status: "started", message: "Publicação iniciada em «Publicar»." } },
    });
    expect(fb).toEqual({ tone: "success", text: "Publicação iniciada em «Publicar»." });
  });

  it("a recusa diz o motivo do servidor", () => {
    expect(quickActionFeedback(action({ kind: "run-skill", boardId: "b", cardId: "c1" }), { ok: false, error: "card conduzido" })).toEqual({
      tone: "error",
      text: "card conduzido",
    });
  });
});

