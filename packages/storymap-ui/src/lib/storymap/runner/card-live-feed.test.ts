import { describe, expect, it } from "vitest";
import type { AgentAction } from "./agent-actions";
import type { ConductorQueueEntry } from "./conductor";
import type { AgentSession } from "./session-worktree";
import {
  CardLiveHub,
  conductorQueueFacts,
  diffIsDue,
  DIFF_MIN_INTERVAL_MS,
  sessionEvidence,
  sessionFacts,
  shortstatToDiff,
  throttleWindows,
  type CardLiveSources,
  type EvidenceIo,
} from "./card-live-feed";

const NOW = Date.parse("2026-09-28T22:20:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const min = (n: number) => n * 60_000;

const act = (over: Partial<AgentAction>): AgentAction =>
  ({ v: 1, at: iso(NOW - min(5)), tool: "move_card", cls: "write-board", disposition: "auto", outcome: "throttled", board: "armazem", ...over }) as AgentAction;

const sess = (over: Partial<AgentSession>): AgentSession => ({
  sessionId: "s1",
  agentId: "s1",
  role: "implement",
  task: "/harness-conductor story-ex0004",
  board: "armazem",
  cardId: "story-ex0004",
  driver: "conductor",
  tmuxSession: "agent-conductor-story-ex0004-jnme",
  worktreePath: "/wt/s1",
  baseCommit: "36777085",
  openedAt: iso(NOW - min(20)),
  heartbeatAt: iso(NOW - min(1)),
  ...over,
});

describe("shortstatToDiff", () => {
  it("lê arquivos, inserções e remoções", () => {
    expect(shortstatToDiff(" 14 files changed, 442 insertions(+), 8 deletions(-)\n")).toEqual({ files: 14, additions: 442, deletions: 8 });
    expect(shortstatToDiff(" 1 file changed, 3 insertions(+)")).toEqual({ files: 1, additions: 3, deletions: 0 });
    expect(shortstatToDiff("")).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe("throttleWindows — o limite de ações por hora, por board", () => {
  it("a última ação freada com a volta no futuro fecha o board", () => {
    const w = throttleWindows(
      [
        act({ at: iso(NOW - min(30)), retryAfter: "2026-09-28T22:00:00.000Z" }), // janela velha, já aberta
        act({ at: iso(NOW - min(4)), retryAfter: "2026-09-28T23:00:00.000Z" }),
        act({ at: iso(NOW - min(2)), outcome: "executed" }),
        act({ board: "other", at: iso(NOW - min(1)), outcome: "executed" }),
      ],
      NOW,
    );
    expect(w).toEqual([{ board: "armazem", at: iso(NOW - min(4)), until: "2026-09-28T23:00:00.000Z" }]);
  });

  it("uma linha antiga, sem o campo, ainda serve pela nota", () => {
    const w = throttleWindows([act({ note: "limite de 20 ações/hora; tentar de novo a partir de 2026-09-28T23:00:00.000Z" })], NOW);
    expect(w[0]?.until).toBe("2026-09-28T23:00:00.000Z");
  });

  it("janela já aberta ou sem board ⇒ nada", () => {
    expect(throttleWindows([act({ retryAfter: iso(NOW - 1) }), act({ board: undefined, retryAfter: iso(NOW + min(9)) })], NOW)).toEqual([]);
  });
});

describe("conductorQueueFacts — a fila do condutor", () => {
  it("a posição conta por board, na ordem do arquivo (= a ordem de despacho)", () => {
    const e = (board: string, cardId: string, over: Partial<ConductorQueueEntry> = {}): ConductorQueueEntry => ({ board, cardId, queuedAt: iso(NOW), attempts: 0, ...over });
    const f = conductorQueueFacts([e("armazem", "a"), e("other", "x"), e("armazem", "b", { lastWaitKind: "slots", lastWaitReason: "2 condutor(es) vivo(s) no board — esperando uma vaga" })]);
    expect(f.map((q) => [q.board, q.cardId, q.position, q.total])).toEqual([
      ["armazem", "a", 1, 2],
      ["other", "x", 1, 1],
      ["armazem", "b", 2, 2],
    ]);
    expect(f[2].waitReason).toMatch(/esperando uma vaga/);
  });
});

describe("sessionFacts — só as sessões vivas, em cards", () => {
  it("a tmux decide quem está vivo; sem sonda, vale o heartbeat", () => {
    const rows = [
      sess({ sessionId: "alive" }),
      sess({ sessionId: "dead-tmux", tmuxSession: "gone", cardId: "c2" }),
      sess({ sessionId: "cardless", cardId: undefined }),
      sess({ sessionId: "old", tmuxSession: undefined, heartbeatAt: iso(NOW - 7 * 60 * min(1)), cardId: "c3" }),
    ];
    const live = new Set(["agent-conductor-story-ex0004-jnme"]);
    expect(sessionFacts(rows, live, NOW, new Map()).map((s) => s.sessionId)).toEqual(["alive"]);
    // a sonda não respondeu: o heartbeat (6h) decide — a sessão de tmux sumida mas de heartbeat recente conta
    expect(sessionFacts(rows, null, NOW, new Map()).map((s) => s.sessionId)).toEqual(["alive", "dead-tmux"]);
  });

  it("carrega o relato e o diff medido", () => {
    const progress = { phase: "construir" as const, at: iso(NOW), phaseSince: iso(NOW) };
    const [f] = sessionFacts([sess({ progress })], null, NOW, new Map([["s1", { files: 14, additions: 442, deletions: 8 }]]));
    expect(f).toMatchObject({ board: "armazem", cardId: "story-ex0004", conductor: true, progress, diff: { files: 14 } });
  });

  it("anexa a evidência medida; sem medida, só o que o registro já provou (nunca o heartbeat)", () => {
    const rows = [sess({ sessionId: "medida" }), sess({ sessionId: "registro", cardId: "c2", lastActivityAt: iso(NOW - min(9)) }), sess({ sessionId: "nada", cardId: "c3" })];
    const facts = sessionFacts(rows, null, NOW, new Map(), new Map([["medida", { lastActivityAt: iso(NOW - 5_000), busy: true }]]));
    expect(facts[0]).toMatchObject({ lastActivityAt: iso(NOW - 5_000), busy: true });
    expect(facts[1].lastActivityAt).toBe(iso(NOW - min(9)));
    expect(facts[2].lastActivityAt).toBeUndefined();
  });
});

describe("sessionEvidence — a prova de trabalho de uma sessão viva", () => {
  const BUSY = "● Rodando a suíte…\n\n✻ Pouncing… (59s · ↓ 4.8k tokens · esc to interrupt)\n\n❯ \n";
  const PROMPT = "● Pronto: submeti.\n\n❯ \n";
  const io = (over: Partial<EvidenceIo> & { screen?: string | null; mtime?: number | null } = {}) => {
    const calls = { capture: 0 };
    const out: EvidenceIo = {
      exists: async () => true,
      mtimeMs: async () => (over.mtime === undefined ? NOW - min(10) : over.mtime),
      capture: async () => {
        calls.capture++;
        return over.screen === undefined ? PROMPT : over.screen;
      },
      ...over,
    };
    return { io: out, calls };
  };
  const s = (over: Partial<AgentSession> = {}) => sess({ transcriptFile: "/t/s1.jsonl", ...over });

  it("a pasta de trabalho sumiu com o tmux vivo ⇒ zumbi (e nada mais é medido)", async () => {
    const { io: x, calls } = io({ exists: async () => false });
    expect(await sessionEvidence(s(), undefined, NOW, x)).toEqual({ zombie: true });
    expect(calls.capture).toBe(0);
  });

  it("«não deu para saber» da pasta nunca vira zumbi", async () => {
    const { io: x } = io({ exists: async () => null });
    expect((await sessionEvidence(s(), undefined, NOW, x)).zombie).toBeUndefined();
  });

  it("transcript escrito há menos de 2 min: é a atividade, e a tela nem é capturada", async () => {
    const { io: x, calls } = io({ mtime: NOW - 30_000 });
    expect(await sessionEvidence(s(), undefined, NOW, x)).toEqual({ lastActivityAt: iso(NOW - 30_000) });
    expect(calls.capture).toBe(0);
  });

  it("transcript calado há 10 min com a tela TRABALHANDO (suíte longa) ⇒ busy", async () => {
    const { io: x } = io({ screen: BUSY });
    expect(await sessionEvidence(s(), undefined, NOW, x)).toEqual({ lastActivityAt: iso(NOW - min(10)), busy: true });
  });

  it("transcript calado há 10 min com a tela no prompt ⇒ só a atividade velha (a presença diz «parado»)", async () => {
    const { io: x } = io({ screen: PROMPT });
    expect(await sessionEvidence(s(), undefined, NOW, x)).toEqual({ lastActivityAt: iso(NOW - min(10)) });
  });

  it("a captura falhou ⇒ não é prova de trabalho", async () => {
    const { io: x } = io({ screen: null });
    expect((await sessionEvidence(s(), undefined, NOW, x)).busy).toBeUndefined();
  });

  it("o vigia já sabe (idle/asking) ⇒ a tela não é capturada de novo", async () => {
    const { io: x, calls } = io({ screen: BUSY });
    const idle = { session: "agent-conductor-story-ex0004-jnme", label: "x", kind: "idle" as const, since: NOW - min(12), agent: true };
    expect(await sessionEvidence(s(), idle, NOW, x)).toEqual({ lastActivityAt: iso(NOW - min(10)) });
    expect(calls.capture).toBe(0);
  });

  it("o registro (relato, submit) mais novo que o transcript vence", async () => {
    const { io: x } = io({ mtime: NOW - min(30), screen: PROMPT });
    expect((await sessionEvidence(s({ lastActivityAt: iso(NOW - min(3)) }), undefined, NOW, x)).lastActivityAt).toBe(iso(NOW - min(3)));
  });

  it("uma captura que lança não vira prova de trabalho nem derruba o feed", async () => {
    const { io: x } = io({
      capture: async () => {
        throw new Error("tmux sumiu");
      },
    });
    expect(await sessionEvidence(s({ lastActivityAt: iso(NOW - min(20)) }), undefined, NOW, x)).toEqual({ lastActivityAt: iso(NOW - min(10)) });
  });

  it("uma pasta ilegível que lança fica como «não sei», e o transcript que lança não apaga o que o registro provou", async () => {
    const { io: x } = io({
      exists: async () => {
        throw new Error("EACCES");
      },
      mtimeMs: async () => {
        throw new Error("EIO");
      },
    });
    expect(await sessionEvidence(s({ lastActivityAt: iso(NOW - min(20)) }), undefined, NOW, x)).toEqual({ lastActivityAt: iso(NOW - min(20)) });
  });
});

describe("diffIsDue — o diff tem teto de frequência", () => {
  it("sem árvore/base nunca; com medida recente, espera o intervalo", () => {
    expect(diffIsDue(sess({ worktreePath: undefined }), undefined, NOW)).toBe(false);
    expect(diffIsDue(sess({}), undefined, NOW)).toBe(true);
    expect(diffIsDue(sess({}), { at: NOW - 1000 }, NOW)).toBe(false);
    expect(diffIsDue(sess({}), { at: NOW - DIFF_MIN_INTERVAL_MS }, NOW)).toBe(true);
  });
});

describe("CardLiveHub.collect — um retrato, com o diff medido no máximo uma vez por intervalo", () => {
  it("mede só a sessão viva e reaproveita a medida dentro do intervalo", async () => {
    let now = NOW;
    let measures = 0;
    const src: CardLiveSources = {
      loadSessions: async () => [sess({}), sess({ sessionId: "dead", tmuxSession: "gone", cardId: "c2" })],
      loadConductorQueue: async () => [{ board: "armazem", cardId: "q", queuedAt: iso(NOW), attempts: 0 }],
      readActions: async () => [act({ retryAfter: "2026-09-28T23:00:00.000Z" })],
      liveTmux: async () => new Set(["agent-conductor-story-ex0004-jnme"]),
      judging: () => ["armazem/t"],
      measureDiff: async () => {
        measures++;
        return { files: 14, additions: 442, deletions: 8 };
      },
      attention: () => [],
      evidenceIo: { exists: async () => true, mtimeMs: async () => now - 20_000, capture: async () => null },
      now: () => now,
    };
    const hub = new CardLiveHub(async () => src);
    const a = await hub.collect();
    expect(a.sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(a.sessions[0].diff).toEqual({ files: 14, additions: 442, deletions: 8 });
    expect(a.queue[0].cardId).toBe("q");
    expect(a.throttles[0].board).toBe("armazem");
    expect(a.judging).toEqual(["armazem/t"]);
    expect(measures).toBe(1);
    now += 15_000;
    await hub.collect();
    expect(measures).toBe(1); // dentro do intervalo: nenhuma medida nova
    now += DIFF_MIN_INTERVAL_MS;
    await hub.collect();
    expect(measures).toBe(2);
  });

  it("uma fonte que falha vira vazio; as outras seguem", async () => {
    const hub = new CardLiveHub(async () => ({
      loadSessions: async () => {
        throw new Error("registro ilegível");
      },
      loadConductorQueue: async () => [{ board: "armazem", cardId: "q", queuedAt: iso(NOW), attempts: 0 }],
      readActions: async () => [],
      liveTmux: async () => null,
      judging: () => {
        throw new Error("x");
      },
      measureDiff: async () => null,
      attention: () => {
        throw new Error("vigia desligado");
      },
      evidenceIo: { exists: async () => true, mtimeMs: async () => null, capture: async () => null },
      now: () => NOW,
    }));
    const f = await hub.collect();
    expect(f.sessions).toEqual([]);
    expect(f.queue).toHaveLength(1);
    expect(f.judging).toEqual([]);
  });

  it("cada sessão viva sai com a evidência dela: o zumbi marcado, a que trabalha com a atividade", async () => {
    const hub = new CardLiveHub(async () => ({
      loadSessions: async () => [
        sess({ transcriptFile: "/t/s1.jsonl" }),
        sess({ sessionId: "z", cardId: "c2", tmuxSession: "agent-conductor-c2-ab12", worktreePath: "/wt/apagada", transcriptFile: "/t/z.jsonl" }),
      ],
      loadConductorQueue: async () => [],
      readActions: async () => [],
      liveTmux: async () => new Set(["agent-conductor-story-ex0004-jnme", "agent-conductor-c2-ab12"]),
      judging: () => [],
      measureDiff: async () => null,
      attention: () => [],
      evidenceIo: { exists: async (dir) => dir !== "/wt/apagada", mtimeMs: async () => NOW - 40_000, capture: async () => null },
      now: () => NOW,
    }));
    const f = await hub.collect();
    expect(f.sessions.find((s) => s.sessionId === "s1")).toMatchObject({ lastActivityAt: iso(NOW - 40_000) });
    expect(f.sessions.find((s) => s.sessionId === "z")).toMatchObject({ zombie: true });
  });
});
