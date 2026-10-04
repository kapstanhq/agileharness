// A auditoria das entregas TÉCNICAS não vai para o dono: um auditor independente revê uma
// amostra; com problema, abre um card de conserto; sem veredito, tenta de novo até o teto e desiste registrando.
// Até o teto de rodadas de revisão ninguém pergunta ao dono; no teto (review-rounds.ts), a pergunta vai a ele e nenhum
// card de conserto nasce.

import { describe, expect, it, vi } from "vitest";
import { coerceCard } from "@/lib/storymap/repo";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { memoryProxyLedger } from "./proxy";
import {
  TECHNICAL_AUDIT_MAX_ATTEMPTS,
  auditTechnicalDelivery,
  startTechnicalAudit,
  sweepTechnicalAudits,
  type TechnicalAuditDeps,
  type TechnicalAuditPending,
} from "./technical-audit";
import { resolveBoardGate } from "./board-pace";

const config = { id: "b", name: "B", statuses: [{ id: "concluida", name: "No ar", terminal: true, delivered: true }], releases: [], personas: [], systems: [], linkTypes: [], autonomy: { mode: "ultra" } } as unknown as BoardConfig;
const delivered = (): Card =>
  coerceCard("story-x", { type: "story", storyType: "technical", title: "Cache do catálogo de livros", status: "concluida" }, "## Prova da entrega\n\n- leitura 35% mais rápida (bench em anexo)\n");
const range = { base: "a".repeat(40), head: "b".repeat(40) };
const pending = (over: Partial<TechnicalAuditPending> = {}): TechnicalAuditPending => ({ board: "b", cardId: "story-x", range, at: "2026-09-28T12:00:00Z", ...over });

function world(opts: { audit?: TechnicalAuditDeps["audit"]; master?: boolean } = {}) {
  const state = { pending: [] as TechnicalAuditPending[], decisions: [] as SystemDecision[] };
  const deps: TechnicalAuditDeps = {
    ledger: memoryProxyLedger(),
    pending: { load: async () => state.pending, save: async (l) => void (state.pending = l) },
    masterEnabled: () => opts.master ?? true,
    admission: () => null,
    readCard: async () => delivered(),
    readBoardConfig: async () => config,
    materialize: vi.fn(async () => ({ diff: "diff --git a/x b/x", files: [] })),
    audit: vi.fn(opts.audit ?? (async () => ({ runId: "r1", model: "sonnet", output: { verdict: "approve" as const, summary: "faz o que a prova diz", findings: [] } }))),
    openFixCard: vi.fn(async () => "story-fix"),
    record: async (e) => void state.decisions.push(e),
    log: () => {},
  };
  return { deps, state };
}

describe("auditTechnicalDelivery", () => {
  it("sem problema: fica registrado, e nada mais acontece", async () => {
    const { deps, state } = world();
    expect(await auditTechnicalDelivery(deps, pending())).toEqual({ action: "passed" });
    const input = (deps.audit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input).toMatchObject({ cardId: "story-x", range, proof: expect.stringMatching(/35% mais rápida/) });
    expect(deps.openFixCard).not.toHaveBeenCalled();
    expect(state.decisions).toEqual([expect.objectContaining({ kind: "technical-audit", agent: "technical-auditor", what: expect.stringMatching(/sem problema/) })]);
  });

  it("com problema: um card de conserto com os achados — que se desfaz descartando o card", async () => {
    const out = { verdict: "reject" as const, summary: "a leitura serve catálogo vencido", findings: [{ severity: "high" as const, title: "expiração do cache" }] };
    const { deps, state } = world({ audit: async () => ({ runId: "r2", model: "sonnet", output: out }) });
    expect(await auditTechnicalDelivery(deps, pending())).toEqual({ action: "fix-card", fixId: "story-fix" });
    expect(deps.openFixCard).toHaveBeenCalledWith("b", "story-x", out, { extraRound: false, mark: null });
    expect(state.decisions.at(-1)).toMatchObject({ kind: "technical-audit", undo: { kind: "discard-card", cardId: "story-fix" } });
    // a mesma entrega não é auditada de novo
    expect(await auditTechnicalDelivery(deps, pending())).toMatchObject({ action: "skipped" });
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });

  it("no teto de rodadas: a pergunta foi ao dono e NENHUM card de conserto nasce — fica registrado", async () => {
    const out = { verdict: "reject" as const, summary: "a expiração ainda vaza", findings: [{ severity: "high" as const, title: "expiração" }] };
    const { deps, state } = world({ audit: async () => ({ runId: "r4", model: "sonnet", output: out }) });
    deps.roundsGate = vi.fn(async () => ({ gate: "asked" as const, mark: null }));
    expect(await auditTechnicalDelivery(deps, pending())).toEqual({ action: "owner-asked" });
    expect(deps.roundsGate).toHaveBeenCalledWith("b", "story-x", "a expiração ainda vaza", false);
    expect(deps.openFixCard).not.toHaveBeenCalled();
    expect(state.decisions.at(-1)).toMatchObject({ kind: "technical-audit", what: expect.stringMatching(/teto de rodadas/) });
  });

  it("a rodada que o dono pagou: o conserto nasce marcado como rodada extra", async () => {
    const out = { verdict: "reject" as const, summary: "x", findings: [] };
    const { deps } = world({ audit: async () => ({ runId: "r5", model: "sonnet", output: out }) });
    const mark = { root: "b/story-x", round: 3, extra: true };
    deps.roundsGate = vi.fn(async () => ({ gate: "open-extra" as const, mark }));
    expect(await auditTechnicalDelivery(deps, pending())).toEqual({ action: "fix-card", fixId: "story-fix" });
    // a marca de cadeia vai junto para o conserto nascer marcado NA MESMA escrita
    expect(deps.openFixCard).toHaveBeenCalledWith("b", "story-x", out, { extraRound: true, mark });
  });

  it("um achado CRÍTICO vai ao portão como grave (pergunta de novo mesmo depois de «aceitar»)", async () => {
    const out = { verdict: "reject" as const, summary: "vaza a chave", findings: [{ severity: "critical" as const, title: "chave no log" }] };
    const { deps } = world({ audit: async () => ({ runId: "r7", model: "sonnet", output: out }) });
    deps.roundsGate = vi.fn(async () => ({ gate: "asked" as const, mark: null }));
    await auditTechnicalDelivery(deps, pending());
    expect(deps.roundsGate).toHaveBeenCalledWith("b", "story-x", "vaza a chave", true);
  });

  it("depois de o dono aceitar o risco ou mandar parar: nenhum conserto e nenhuma pergunta nova — fica registrado", async () => {
    for (const gate of ["accepted", "stopped"] as const) {
      const out = { verdict: "reject" as const, summary: "a expiração ainda vaza", findings: [] };
      const { deps, state } = world({ audit: async () => ({ runId: `r-${gate}`, model: "sonnet", output: out }) });
      deps.roundsGate = vi.fn(async () => ({ gate, mark: null }));
      expect(await auditTechnicalDelivery(deps, pending())).toEqual({ action: "owner-asked" });
      expect(deps.openFixCard).not.toHaveBeenCalled();
      expect(state.decisions.at(-1)).toMatchObject({ what: expect.stringMatching(gate === "accepted" ? /aceitou o risco/ : /mandou parar/) });
    }
  });

  it("o portão do teto falhando: o conserto abre como antes (nunca esconde um achado)", async () => {
    const out = { verdict: "reject" as const, summary: "x", findings: [] };
    const { deps } = world({ audit: async () => ({ runId: "r6", model: "sonnet", output: out }) });
    deps.roundsGate = vi.fn(async () => {
      throw new Error("disco");
    });
    expect(await auditTechnicalDelivery(deps, pending())).toEqual({ action: "fix-card", fixId: "story-fix" });
  });

  it("o auditor falhando: tenta até o teto e desiste registrando — ninguém é chamado", async () => {
    const { deps, state } = world({ audit: async () => ({ runId: "r3", model: "sonnet", error: "timeout" }) });
    const seen: string[] = [];
    for (let i = 0; i < TECHNICAL_AUDIT_MAX_ATTEMPTS + 2; i++) seen.push((await auditTechnicalDelivery(deps, pending())).action);
    expect(seen).toEqual(["failed", "gave-up", "skipped", "skipped"]);
    expect(deps.audit).toHaveBeenCalledTimes(TECHNICAL_AUDIT_MAX_ATTEMPTS);
    expect(deps.openFixCard).not.toHaveBeenCalled();
    expect(state.decisions).toEqual([expect.objectContaining({ what: expect.stringMatching(/não rodou/), why: expect.stringMatching(/ninguém foi chamado/) })]);
  });

  it("sem o intervalo de commits: não há o que ler — registra e encerra; autorun desligado: espera", async () => {
    const none = world();
    expect(await auditTechnicalDelivery(none.deps, pending({ range: null }))).toMatchObject({ action: "gave-up" });
    expect(none.deps.audit).not.toHaveBeenCalled();
    const off = world({ master: false });
    expect(await auditTechnicalDelivery(off.deps, pending())).toMatchObject({ action: "waiting" });
    expect(off.deps.audit).not.toHaveBeenCalled();
  });

  // O auditor é trabalho de FUNDO (runner/board-pace.ts): com o board pausado OU devagar ele espera — só o ritmo normal o roda.
  it("ritmo do board: pausado e devagar ⇒ espera; normal ⇒ audita", async () => {
    const at = "2026-10-02T12:00:00.000Z";
    for (const level of ["paused", "slow"] as const) {
      const w = world();
      w.deps.boardGate = (_b, config) => resolveBoardGate(config, { board: "b", owner: { level, by: { kind: "owner" }, at } }, Date.parse(at) + 1000);
      expect(await auditTechnicalDelivery(w.deps, pending())).toMatchObject({ action: "waiting", reason: expect.stringMatching(/o auditor espera/) });
      expect(w.deps.audit).not.toHaveBeenCalled();
    }
    const normal = world();
    normal.deps.boardGate = (_b, config) => resolveBoardGate(config, null, Date.parse(at));
    expect(await auditTechnicalDelivery(normal.deps, pending())).toMatchObject({ action: "passed" });
  });
});

describe("a fila durável", () => {
  it("o que espera fica para a varredura; o que termina sai", async () => {
    const off = world({ master: false });
    await startTechnicalAudit(off.deps, pending());
    expect(off.state.pending).toHaveLength(1);
    const on = world();
    on.state.pending = off.state.pending;
    expect(await sweepTechnicalAudits(on.deps)).toEqual([{ board: "b", cardId: "story-x", action: "passed" }]);
    expect(on.state.pending).toEqual([]);
  });
});

describe("o auditor é o revisor independente com a lente de ENTREGA", () => {
  it("o contexto traz a prova da entrega e a mudança; o veredito é o mesmo arquivo; o teto é o da auditoria técnica", async () => {
    const { buildSecurityReviewArgs, buildSecurityReviewContext, buildSecurityReviewPrompt } = await import("./security-review-spawn");
    const { DEFAULT_SURFACE_BUDGET_USD } = await import("./run-budget");
    const ctx = buildSecurityReviewContext({
      board: "b",
      cardId: "story-x",
      reviewer: "code-reviewer",
      role: "Você revisa código.",
      lens: "delivery",
      delivery: { title: "Cache do catálogo", proof: "- leitura 35% mais rápida" },
      subject: { kind: "diff", hash: "head:x", base: range.base, head: range.head, files: ["src/a.ts"] },
      material: { diff: "diff --git a/src/a.ts b/src/a.ts", files: [] },
      model: "sonnet",
    });
    expect(ctx).toMatch(/Auditoria técnica independente/);
    expect(ctx).toMatch(/35% mais rápida/);
    expect(ctx).not.toMatch(/Hash do assunto/);
    expect(buildSecurityReviewPrompt("v.json", "delivery")).toMatch(/auditor técnico INDEPENDENTE[\s\S]*card de conserto/);
    const { args } = buildSecurityReviewArgs({ kind: "unsandboxed-escape" } as never, { prompt: "p", notePath: "n", model: "sonnet", lens: "delivery" });
    expect(args.join(" ")).toContain(`--max-budget-usd ${DEFAULT_SURFACE_BUDGET_USD.technicalAudit}`);
  });
});
