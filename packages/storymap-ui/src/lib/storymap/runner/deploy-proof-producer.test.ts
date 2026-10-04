// Item 9 — o PRODUTOR da prova que falta: para cada revisão de segurança pedida pelo deploy automático do alvo, um revisor
// INDEPENDENTE (contexto limpo, não quem escreveu o código) julga o assunto; o veredito é gravado pela receita do alvo
// (que recalcula o hash e recusa assunto velho) e o card é republicado pelo mesmo caminho do «Re-publicar». Veredito
// negativo reabre o card com os achados; esgotadas as tentativas, um card de conserto. Nunca pergunta ao dono.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { coerceCard } from "@/lib/storymap/repo";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { memoryProxyLedger } from "./proxy";
import { applyDeployNeedsProofHold, parseDeployExit3Report, type DeployExit3Report } from "./deploy-proof";
import { buildDeployFailureFinding } from "./deploy-revert";
import { settleFailureDetail } from "./deploy-needs-human";
import {
  MAX_PROOF_ROUNDS,
  MAX_REVIEW_ATTEMPTS,
  PRODUCER_AGENT,
  produceDeployProofs,
  startDeployProofs,
  sweepDeployProofs,
  type DeployProofDeps,
  type ProofPending,
} from "./deploy-proof-producer";

const LOG = readFileSync(fileURLToPath(new URL("./__fixtures__/publish-needs-proof.txt", import.meta.url)), "utf8");
const FULL = parseDeployExit3Report(LOG);
const ONLY_DIFF: DeployExit3Report = { ...FULL, security: [FULL.security[0]], other: [] };

const config = {
  id: "b",
  name: "B",
  statuses: [
    { id: "corrigir", name: "Corrigir", gate: "hasBugReport", trigger: "harness-fix" },
    { id: "release", name: "Liberar" },
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as unknown as BoardConfig;

const heldCard = (): Card => {
  const finding = buildDeployFailureFinding(settleFailureDetail({ ok: false, exitCode: 3, declaredKind: "command", pkg: "loja" } as never, { exit3: FULL }), "2026-09-28");
  return applyDeployNeedsProofHold(coerceCard("story-x", { type: "story", storyType: "technical", title: "Auth na rota", status: "deploy" }, ""), finding);
};

function world(opts: { review?: DeployProofDeps["review"]; record?: DeployProofDeps["recordVerdict"]; card?: Card; master?: boolean } = {}) {
  const state = { card: opts.card ?? heldCard(), pending: [] as ProofPending[], decisions: [] as SystemDecision[] };
  const deps: DeployProofDeps = {
    ledger: memoryProxyLedger(),
    pending: {
      load: async () => state.pending,
      save: async (list) => {
        state.pending = list;
      },
    },
    masterEnabled: () => opts.master ?? true,
    admission: () => null,
    readCard: async () => state.card,
    readBoardConfig: async () => config,
    materialize: vi.fn(async (subject) => ({ diff: `diff de ${subject.files.join(",")}`, files: [] })),
    review: vi.fn(opts.review ?? (async () => ({ runId: "run-1", model: "sonnet", output: { verdict: "approve" as const, summary: "sem risco", findings: [] } }))),
    recordVerdict: vi.fn(opts.record ?? (async () => ({ ok: true as const }))),
    resolveFinding: vi.fn(async () => {}),
    republish: vi.fn(async () => ({ ok: true })),
    reopen: vi.fn(async () => true),
    openFixCard: vi.fn(async () => "story-fix"),
    record: async (e) => {
      state.decisions.push(e);
    },
    log: () => {},
  };
  return { deps, state };
}
const pending = (report: DeployExit3Report = ONLY_DIFF): ProofPending => ({ board: "b", cardId: "story-x", report, at: "2026-09-28T12:00:00Z" });

describe("produceDeployProofs", () => {
  it("aprovado: o revisor julga o ASSUNTO pedido, o veredito é gravado, o finding fecha e o card é republicado", async () => {
    const { deps, state } = world();
    expect(await produceDeployProofs(deps, pending())).toMatchObject({ action: "republished" });
    expect(deps.materialize).toHaveBeenCalledWith(ONLY_DIFF.security[0].subject);
    expect((deps.review as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ board: "b", cardId: "story-x", request: ONLY_DIFF.security[0] });
    const verdict = (deps.recordVerdict as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(verdict).toMatchObject({ schema: "deploy-proof/security-review@1", subject: ONLY_DIFF.security[0].subject, verdict: "approve", reviewer: { agent: "security-reviewer", runId: "run-1" } });
    expect(deps.resolveFinding).toHaveBeenCalledWith("b", "story-x");
    expect(deps.republish).toHaveBeenCalledWith("b", "story-x");
    // o laço inteiro no registro: a revisão aprovada e a republicação
    expect(state.decisions).toEqual([
      expect.objectContaining({ kind: "security-review", agent: "security-reviewer", cardId: "story-x", what: expect.stringMatching(/aprovou/) }),
      expect.objectContaining({ kind: "proof-republish", agent: PRODUCER_AGENT, cardId: "story-x", what: expect.stringMatching(/Republicou/) }),
    ]);
  });

  it("quem decidiu é o revisor que o ALVO pediu — a ferramenta não supõe o nome do agente; a republicação é do produtor", async () => {
    const { deps, state } = world();
    const pedido = { ...ONLY_DIFF.security[0], reviewer: "revisor-de-cofre" };
    expect(await produceDeployProofs(deps, pending({ ...ONLY_DIFF, security: [pedido] }))).toMatchObject({ action: "republished" });
    expect((deps.recordVerdict as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ reviewer: { agent: "revisor-de-cofre" } });
    expect(state.decisions.map((d) => d.agent)).toEqual(["revisor-de-cofre", PRODUCER_AGENT]);
    expect(state.decisions.some((d) => d.agent === "security-reviewer")).toBe(false);
  });

  it("duas revisões pedidas (a mudança e o conteúdo das regras): duas revisões, UMA republicação", async () => {
    const { deps } = world();
    await produceDeployProofs(deps, pending({ ...FULL, other: [] }));
    expect(deps.review).toHaveBeenCalledTimes(2);
    expect(deps.republish).toHaveBeenCalledTimes(1);
  });

  it("reprovado: o card é reaberto com os achados, nada é republicado, e ninguém pergunta ao dono", async () => {
    const { deps, state } = world({ review: async () => ({ runId: "run-2", model: "sonnet", output: { verdict: "reject", summary: "aceita token vencido", findings: [{ severity: "high", title: "token vencido" }] } }) });
    expect(await produceDeployProofs(deps, pending())).toMatchObject({ action: "reopened" });
    expect(deps.reopen).toHaveBeenCalledWith("b", "story-x", expect.objectContaining({ verdict: "reject" }));
    expect(deps.republish).not.toHaveBeenCalled();
    expect(state.decisions.at(-1)).toMatchObject({ kind: "security-review", what: expect.stringMatching(/reprovou/) });
  });

  it("o revisor falhando: tentativas contadas por assunto; no teto, UM card de conserto — e mais nenhuma revisão", async () => {
    const { deps } = world({ review: async () => ({ runId: "run-x", model: "sonnet", error: "timeout" }) });
    for (let i = 0; i < MAX_REVIEW_ATTEMPTS + 2; i++) await produceDeployProofs(deps, pending());
    expect(deps.review).toHaveBeenCalledTimes(MAX_REVIEW_ATTEMPTS);
    expect(deps.openFixCard).toHaveBeenCalledTimes(1);
    expect((deps.openFixCard as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatch(/revisão de segurança/);
  });

  it("uma prova que o AH não produz (o ensaio de rollback) vira card de conserto; a revisão sai, mas não se republica", async () => {
    const { deps } = world();
    expect(await produceDeployProofs(deps, pending(FULL))).toMatchObject({ action: "fix-card" });
    expect(deps.review).toHaveBeenCalledTimes(2);
    expect(deps.republish).not.toHaveBeenCalled();
    expect((deps.openFixCard as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatch(/drill/);
  });

  it("assunto velho (o HEAD andou): republica para receber o pedido novo — com teto de rodadas", async () => {
    const { deps } = world({ record: async () => ({ ok: false as const, stale: true, error: "the verdict is for another subject" }) });
    for (let i = 0; i < MAX_PROOF_ROUNDS + 2; i++) await produceDeployProofs(deps, pending({ ...ONLY_DIFF, security: [{ ...ONLY_DIFF.security[0], subject: { ...ONLY_DIFF.security[0].subject, hash: `sha256:${String(i).repeat(64).slice(0, 64)}` } }] }));
    expect(deps.republish).toHaveBeenCalledTimes(MAX_PROOF_ROUNDS);
    expect(deps.openFixCard).toHaveBeenCalledTimes(1);
  });

  it("o card saiu de Publicar: nada a fazer; autorun desligado: espera", async () => {
    const moved = world({ card: { ...heldCard(), status: "release" } });
    expect(await produceDeployProofs(moved.deps, pending())).toMatchObject({ action: "skipped" });
    expect(moved.deps.review).not.toHaveBeenCalled();
    const off = world({ master: false });
    expect(await produceDeployProofs(off.deps, pending())).toMatchObject({ action: "waiting" });
    expect(off.deps.review).not.toHaveBeenCalled();
  });

  // A revisão aprovou, o finding de needs-proof fechou e a republicação não
  // aconteceu. Sem o finding o produtor passou a pular o card: parado em Publicar, nada pendente, ninguém avisado.
  it("a republicação recusa: o finding de prova FICA aberto (o card continua à vista) e o motivo vai para o log", async () => {
    const { deps } = world();
    const lines: string[] = [];
    deps.log = (l) => lines.push(l);
    deps.republish = vi.fn(async () => ({ ok: false, error: "o passo não dispara nada" }));
    expect(await produceDeployProofs(deps, pending())).toMatchObject({ action: "failed", reason: expect.stringMatching(/republicação recusou/) });
    expect(deps.resolveFinding).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/b\/story-x: a republicação recusou .*o passo não dispara nada/);
  });

  it("a republicação LANÇA: nunca em silêncio, o finding fica aberto, e as tentativas da varredura têm teto", async () => {
    const { deps, state } = world();
    const lines: string[] = [];
    deps.log = (l) => lines.push(l);
    deps.republish = vi.fn(async () => {
      throw new Error("chamador não identificado");
    });
    state.pending = [pending()];
    for (let i = 0; i < MAX_PROOF_ROUNDS + 2; i++) await sweepDeployProofs(deps);
    expect(deps.resolveFinding).not.toHaveBeenCalled();
    expect(deps.review).toHaveBeenCalledTimes(1); // o assunto aprovado não é revisado de novo
    expect(deps.republish).toHaveBeenCalledTimes(MAX_PROOF_ROUNDS);
    expect(deps.openFixCard).toHaveBeenCalledTimes(1); // no teto vira trabalho, e o pedido sai da fila
    expect(state.pending).toEqual([]);
    expect(lines.filter((l) => /o produtor da prova falhou — chamador não identificado/.test(l))).toHaveLength(MAX_PROOF_ROUNDS);
  });

  it("republicado, mas fechar o finding falha: o desfecho é final — nunca uma segunda republicação", async () => {
    const { deps, state } = world();
    deps.resolveFinding = vi.fn(async () => {
      throw new Error("disco cheio");
    });
    state.pending = [pending()];
    expect(await sweepDeployProofs(deps)).toEqual([{ board: "b", cardId: "story-x", action: "republished" }]);
    await sweepDeployProofs(deps);
    expect(deps.republish).toHaveBeenCalledTimes(1);
    expect(state.pending).toEqual([]);
  });

  it("um assunto já aprovado (restart no meio) não é revisado de novo", async () => {
    const { deps } = world();
    await produceDeployProofs(deps, pending());
    await produceDeployProofs(deps, pending());
    expect(deps.review).toHaveBeenCalledTimes(1);
  });
});

describe("a fila durável (um restart não perde o pedido)", () => {
  it("start guarda o pedido e o tira ao terminar; o que espera fica para a varredura", async () => {
    const off = world({ master: false });
    await startDeployProofs(off.deps, pending());
    expect(off.state.pending).toHaveLength(1);
    const on = world();
    on.state.pending = off.state.pending;
    const rep = await sweepDeployProofs(on.deps);
    expect(rep).toEqual([{ board: "b", cardId: "story-x", action: "republished" }]);
    expect(on.state.pending).toEqual([]);
  });
});
