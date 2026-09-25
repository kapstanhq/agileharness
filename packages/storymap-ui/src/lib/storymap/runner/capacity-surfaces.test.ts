import { describe, expect, it, vi } from "vitest";
import { spawnPeerReview, type PeerReviewRequest } from "./peer-review-spawn";
import { spawnResolutionJudge } from "./resolution-judge-spawn";
import { climbLadder, type JudgeRequest } from "./semantic-resolution";
import { spawnWorkSession, type SessionSpawnDeps } from "./session-spawn";
import { CAPACITY_HELD_MARKER, type GateVerdict, type Initiator } from "./capacity-governor";

// As superfícies AUTOMÁTICAS fora do engine — o revisor par, o juiz de conflito e a sessão aberta pelo copiloto —
// passam pelo MESMO governador de capacidade. Retidas, nada nasce (nem worktree, nem claim, nem processo); o
// operador nunca é retido. E o juiz retido NÃO gasta a única tentativa semântica da entry: ele não julgou nada.

function gate(held: boolean) {
  const asked: Initiator[] = [];
  const admission = (i: Initiator): GateVerdict => {
    asked.push(i);
    if (i === "operator" || !held) return { admit: true, reason: i === "operator" ? "operator" : "admit", detail: "", retryAt: null };
    return { admit: false, reason: "five-hour", detail: "janela de 5 horas em 88%", retryAt: null };
  };
  return { admission, asked };
}

const peerReq = (initiator?: Initiator): PeerReviewRequest => ({
  board: "acme",
  draftId: "d1",
  changes: [{ artifact: "prd", field: "resumo", label: "Resumo", before: "a", after: "b" }],
  ...(initiator ? { initiator } : {}),
});

describe("revisor par", () => {
  it("pedido por automação e retido ⇒ nenhum revisor nasce; o erro nomeia o governador (a proposta segue pendente)", async () => {
    const g = gate(true);
    const spawn = vi.fn();
    const v = await spawnPeerReview(peerReq("automation"), { claudeBin: "claude", admission: g.admission, spawn: spawn as never });
    expect(v.error).toContain(CAPACITY_HELD_MARKER);
    expect(v.error).toContain("5 horas");
    expect(v.verdict).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("sem iniciador declarado ⇒ tratado como automação (o conservador)", async () => {
    const g = gate(true);
    const v = await spawnPeerReview(peerReq(), { claudeBin: "claude", admission: g.admission, spawn: vi.fn() as never });
    expect(g.asked).toEqual(["automation"]);
    expect(v.error).toContain(CAPACITY_HELD_MARKER);
  });

  it("pedido pelo operador ⇒ o governador não segura (segue para a postura/spawn)", async () => {
    const g = gate(true);
    const v = await spawnPeerReview(peerReq("operator"), {
      claudeBin: "claude",
      admission: g.admission,
      spawn: vi.fn() as never,
      resolvePosture: () => ({ kind: "refused", reason: "sem contenção nesta bancada" }),
    });
    expect(g.asked).toEqual(["operator"]);
    expect(v.error ?? "").not.toContain(CAPACITY_HELD_MARKER);
  });
});

describe("juiz de conflito", () => {
  const req: JudgeRequest = { sides: { ours: "stage", theirs: "run/x", files: ["packages/x/a.ts"] }, base: "abc", origin: "train" };

  it("retido ⇒ nenhum `git worktree add`, nenhum spawn, veredito marcado `held`", async () => {
    const g = gate(true);
    const exec = vi.fn();
    const spawn = vi.fn();
    const v = await spawnResolutionJudge(req, { claudeBin: "claude", exec: exec as never, repoRoot: "/nao/existe", admission: g.admission, spawn: spawn as never });
    expect(v).toMatchObject({ held: true, hunks: [] });
    expect(v.error).toContain(CAPACITY_HELD_MARKER);
    expect(g.asked).toEqual(["automation"]); // o juiz é SEMPRE automação
    expect(exec).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("na escada: juiz retido é `skipped` (não gasta a tentativa), juiz que MORREU é `judge-failed`", async () => {
    const deps = (judge: () => Promise<{ hunks: []; runId: string; error?: string; held?: boolean }>) => ({
      // degrau 1 (whitespace) precisa dizer "diferem" para a escada chegar ao juiz: `git diff --quiet` LANÇA
      // com exit 1 (é assim que o exec promisificado reporta um código ≠ 0)
      exec: vi.fn(async () => {
        throw Object.assign(new Error("differ"), { code: 1 });
      }) as never,
      repoRoot: "/r",
      enabled: true,
      judge,
    });
    const held = await climbLadder(deps(async () => ({ hunks: [], runId: "", error: `${CAPACITY_HELD_MARKER}: x`, held: true })), req);
    expect(held.outcome).toBe("skipped");
    expect(held.detail).toContain("nenhuma tentativa gasta");
    const died = await climbLadder(deps(async () => ({ hunks: [], runId: "r", error: "timeout" })), req);
    expect(died.outcome).toBe("judge-failed");
  });
});

describe("sessão aberta pela automação (claude_new de um agente escopado)", () => {
  // Deps que EXPLODEM se tocados: a recusa por capacidade tem de acontecer antes de claim, árvore ou tmux.
  const untouchable = (admission: SessionSpawnDeps["admission"]): SessionSpawnDeps =>
    ({
      worktree: new Proxy({}, { get: () => { throw new Error("worktree tocado"); } }),
      claims: {
        conflictFor: async () => {
          throw new Error("claim consultado");
        },
        acquire: async () => {
          throw new Error("claim adquirido");
        },
        release: async () => {},
      },
      cardRoute: async () => null,
      tmux: { exists: async () => false, create: async () => ({ ok: false }), survives: async () => false, kill: async () => {} },
      findTranscript: async () => null,
      fs: { mkdir: vi.fn(), writeFile: vi.fn() },
      claudeBin: "claude",
      repoRoot: "/r",
      stateDir: "/s",
      port: 3008,
      admission,
    }) as unknown as SessionSpawnDeps;

  it("copiloto + retido ⇒ capacity_held ANTES de qualquer efeito", async () => {
    const g = gate(true);
    const r = await spawnWorkSession(untouchable(g.admission), { role: "implement", task: "fazer x", board: "acme", cardId: "c1", spawnedBy: "copilot" });
    expect(r).toMatchObject({ ok: false, code: "capacity_held" });
    expect(!r.ok && r.reason).toContain(CAPACITY_HELD_MARKER);
  });

  it("sessão do OPERADOR (human) nunca consulta o governador", async () => {
    const g = gate(true);
    // as deps que explodem fazem a chamada falhar ADIANTE (claim/árvore) — nunca por capacidade, e o governador
    // nem é perguntado
    await expect(
      spawnWorkSession(untouchable(g.admission), { role: "implement", task: "fazer x", board: "acme", cardId: "c1", spawnedBy: "human" }),
    ).rejects.toThrow(/tocado|claim/);
    expect(g.asked).toEqual([]);
  });
});
