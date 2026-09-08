import { describe, expect, it } from "vitest";
import { deriveWorkState, diffIsEmpty, matchWorktree, parseShortstat } from "./service-meters";
import type { ServiceKind, ServiceStatus } from "./types";

const at = (status: ServiceStatus, kind: ServiceKind, claudeStatus?: string | null) =>
  deriveWorkState({ status, kind, claudeStatus });

describe("deriveWorkState — trust order", () => {
  it("reads the CLI's own busy flag as WORKING, and says so", () => {
    expect(at("running", "tmux-master", "busy")).toEqual({ state: "working", source: "cli" });
  });

  it("reads the CLI's idle flag as WAITING — a live process is not work", () => {
    // THE bug this whole module exists for: `status === "running"` painted this green.
    expect(at("running", "tmux-master", "idle")).toEqual({ state: "waiting", source: "cli" });
  });

  it("treats an UNKNOWN flag value as waiting, never as working", () => {
    // Over-reporting work is the failure mode we are correcting; a CLI that grows a third
    // status must not silently start claiming activity we cannot see.
    expect(at("running", "tmux-card", "compacting").state).toBe("waiting");
  });

  it("infers WORKING for a headless child, which never sits at a prompt", () => {
    expect(at("running", "runner-run")).toEqual({ state: "working", source: "run" });
    expect(at("running", "helper-agent")).toEqual({ state: "working", source: "run" });
  });

  it("falls to WAITING for a live shell with no agent in it", () => {
    expect(at("running", "tmux-shell")).toEqual({ state: "waiting", source: "status" });
    expect(at("idle", "tmux-adhoc")).toEqual({ state: "waiting", source: "status" });
  });

  it("lets a terminal outcome win over every other signal", () => {
    // A failed run whose pidfile still says "busy" is failed — the outcome is a fact, the flag is stale.
    expect(at("failed", "runner-run", "busy")).toEqual({ state: "failed", source: "status" });
    expect(at("interrupted", "runner-run", "busy").state).toBe("failed");
    expect(at("done", "runner-run", "busy")).toEqual({ state: "done", source: "status" });
  });
});

describe("deriveWorkState — a TELA corrobora o flag do CLI", () => {
  const withScreen = (claudeStatus: string, screenStillMs: number | null) =>
    deriveWorkState({ status: "running", kind: "tmux-adhoc", claudeStatus, screenStillMs });

  it("O BUG: um `busy` que a tela desmente não é trabalho", () => {
    // Medido em produção (2026-07-30): a sessão `shell` despachou um job em background, parqueou, e
    // ficou com `status:"busy"` gravado no pidfile por 21,9 HORAS — o CLI só escreve o arquivo na
    // TRANSIÇÃO. A tela ficou byte-idêntica o tempo todo (composer vazio depois de um `/clear`), e a
    // interface anunciava "trabalhando", no topo da lista e com o card aberto.
    expect(withScreen("busy", 21.9 * 3600_000)).toEqual({ state: "waiting", source: "stale" });
  });

  it("e um `idle` velho deixa de ser uma chamada à ação (o selo âmbar de 'aguardando VOCÊ')", () => {
    // `needsYou` exige source "cli": ao demover para "stale", uma sessão dormindo há 20h para de usar o
    // mesmo selo de uma que acabou de te perguntar algo.
    expect(withScreen("idle", 20 * 3600_000)).toEqual({ state: "waiting", source: "stale" });
  });

  it("enquanto a tela CORROBORA, o flag continua mandando — inclusive um turno longo", () => {
    // Medido: um pane com turno em voo muda de hash a cada ciclo de 6s (o rodapé conta os segundos), e
    // 90s são ~15 ciclos de folga. Demover cedo demais seria o mesmo erro, espelhado.
    expect(withScreen("busy", 0)).toEqual({ state: "working", source: "cli" });
    expect(withScreen("busy", 89_000)).toEqual({ state: "working", source: "cli" });
    expect(withScreen("idle", 5_000)).toEqual({ state: "waiting", source: "cli" });
  });

  it("SEM evidência de tela nada é demovido — ausência de dado não é prova de nada", () => {
    // Vigia desligado, sessão fora do teto do vigia, ou serviço recém-subido: o comportamento é o
    // anterior, e não uma acusação de imobilidade que ninguém mediu.
    expect(withScreen("busy", null)).toEqual({ state: "working", source: "cli" });
    expect(at("running", "tmux-adhoc", "busy")).toEqual({ state: "working", source: "cli" });
  });

  it("a tela não fabrica estado onde não havia flag nenhum", () => {
    // Um shell puro (sem agente) parado há horas continua sendo apenas "o processo existe".
    expect(deriveWorkState({ status: "running", kind: "tmux-shell", screenStillMs: 9 * 3600_000 })).toEqual({
      state: "waiting",
      source: "status",
    });
  });
});

describe("deriveWorkState — o TRANSCRIPT é a testemunha que um repaint não engana", () => {
  it("O BUG: um job em background repinta a tela e ressuscitava um flag de 42,6h", () => {
    // Medido em 2026-07-31 na caixa viva: o pane `shell` hospedava a `meu-monorepo-c2`, com
    // `busy` gravado havia 42,6h e um job em background dentro cujo rodapé conta os segundos. A tela
    // NUNCA ficava parada 90s — a régua da tela absolvia o flag, e a home dizia "trabalhando" para um
    // composer parado, ainda por cima colocando esse card no topo e aberto.
    expect(
      deriveWorkState({
        status: "running",
        kind: "tmux-adhoc",
        claudeStatus: "busy",
        screenStillMs: 1_000, // a tela mexeu agora — e mesmo assim
        transcriptIdleMs: 31 * 60_000,
        flagAgeMs: 42.6 * 3600_000,
      }),
    ).toEqual({ state: "waiting", source: "stale" });
  });

  it("um turno de verdade sobrevive às três testemunhas", () => {
    expect(
      deriveWorkState({
        status: "running",
        kind: "tmux-adhoc",
        claudeStatus: "busy",
        screenStillMs: 2_000,
        transcriptIdleMs: 49_000, // o job que de fato trabalhava, medido no mesmo instante
        flagAgeMs: 12 * 60_000,
      }),
    ).toEqual({ state: "working", source: "cli" });
  });

  it("sem os sinais novos o comportamento é EXATAMENTE o anterior", () => {
    expect(
      deriveWorkState({ status: "running", kind: "tmux-adhoc", claudeStatus: "busy", screenStillMs: 1_000 }),
    ).toEqual({ state: "working", source: "cli" });
  });
});

describe("parseShortstat", () => {
  it("parses the full three-clause form", () => {
    expect(parseShortstat(" 3 files changed, 128 insertions(+), 31 deletions(-)\n")).toEqual({
      files: 3,
      added: 128,
      removed: 31,
    });
  });

  it("defaults the clause git OMITS when it is zero", () => {
    expect(parseShortstat(" 1 file changed, 9 insertions(+)\n")).toEqual({ files: 1, added: 9, removed: 0 });
    expect(parseShortstat(" 2 files changed, 4 deletions(-)\n")).toEqual({ files: 2, added: 0, removed: 4 });
  });

  it("returns null for an empty diff — 'não medi' is not 'medi zero'", () => {
    expect(parseShortstat("")).toBeNull();
    expect(parseShortstat("\n")).toBeNull();
  });
});

describe("matchWorktree — the join is the CWD, not the tmux handle", () => {
  const trees = [
    { worktreePath: "/repo/.worktrees/agent-1" },
    { worktreePath: "/repo/.worktrees/agent-12" },
    { worktreePath: "/repo/.worktrees/agent-12/nested" },
  ];

  it("matches a process running inside the tree", () => {
    expect(matchWorktree("/repo/.worktrees/agent-1/packages/storymap-ui", trees)?.worktreePath).toBe(
      "/repo/.worktrees/agent-1",
    );
  });

  it("matches the tree root itself", () => {
    expect(matchWorktree("/repo/.worktrees/agent-1", trees)?.worktreePath).toBe("/repo/.worktrees/agent-1");
  });

  it("does NOT let agent-1 swallow agent-12 — the prefix needs a path boundary", () => {
    expect(matchWorktree("/repo/.worktrees/agent-12/src", trees)?.worktreePath).toBe("/repo/.worktrees/agent-12");
  });

  it("prefers the LONGEST match, so a nested tree wins over its parent", () => {
    expect(matchWorktree("/repo/.worktrees/agent-12/nested/src", trees)?.worktreePath).toBe(
      "/repo/.worktrees/agent-12/nested",
    );
  });

  it("returns null outside every tree, and for an unknown cwd", () => {
    expect(matchWorktree("/repo/packages/storymap-ui", trees)).toBeNull();
    expect(matchWorktree(null, trees)).toBeNull();
    expect(matchWorktree("/repo/.worktrees/agent-1", [])).toBeNull();
  });
});

describe("diffIsEmpty", () => {
  it("separates 'measured and empty' from 'not measurable'", () => {
    expect(diffIsEmpty(null)).toBe(false); // no worktree — the UI shows "—", not "+0 −0"
    expect(diffIsEmpty({ files: 0, added: 0, removed: 0, untracked: 0 })).toBe(true);
  });

  it("counts untracked files as work — a session that only CREATED files produced something", () => {
    expect(diffIsEmpty({ files: 0, added: 0, removed: 0, untracked: 2 })).toBe(false);
  });
});
