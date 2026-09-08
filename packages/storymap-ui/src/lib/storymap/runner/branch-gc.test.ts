import { describe, expect, it } from "vitest";
import { classifyBranch, runBranchGc, ageDaysFromUnix, type BranchGcJournalEntry } from "./branch-gc";
import type { Landedness } from "./convergence";
import type { PreservedBranch } from "./preserved-branches";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-15T12:00:00Z");

describe("classifyBranch — harvest only SUPERSEDED, never delete uncertain work", () => {
  const opts = { harvestAfterDays: 7, staleAfterDays: 30 };
  it("superseded + older than the harvest window → harvest", () => {
    expect(classifyBranch({ superseded: true, ageDays: 8 }, opts)).toBe("harvest");
  });
  it("superseded + within the window → keep (strict >)", () => {
    expect(classifyBranch({ superseded: true, ageDays: 2 }, opts)).toBe("keep");
    expect(classifyBranch({ superseded: true, ageDays: 7 }, opts)).toBe("keep");
  });
  it("NOT superseded + older than the stale window → stale advisory (NEVER harvest)", () => {
    expect(classifyBranch({ superseded: false, ageDays: 60 }, opts)).toBe("stale-advisory");
  });
  it("NOT superseded + within the stale window → keep", () => {
    expect(classifyBranch({ superseded: false, ageDays: 10 }, opts)).toBe("keep");
  });
  it("WS-2.3: superseded CODE branch whose code is NOT integrated → keep-unmerged-code (never harvest)", () => {
    // The qb8z2c loss vector: a superseded-by-redrive snapshot, aged past the window, whose code never
    // reached main/stage. The verdict says "safe to harvest" but the code guard OVERRIDES it — fail closed.
    expect(classifyBranch({ superseded: true, ageDays: 30, touchesCode: true, codeIntegrated: false }, opts)).toBe("keep-unmerged-code");
  });
  it("WS-2.3: superseded CODE branch whose code IS integrated → harvest (guard doesn't over-keep)", () => {
    expect(classifyBranch({ superseded: true, ageDays: 30, touchesCode: true, codeIntegrated: true }, opts)).toBe("harvest");
  });
  it("WS-2.3: superseded NON-code branch is harvested even with codeIntegrated:false (guard is code-only)", () => {
    expect(classifyBranch({ superseded: true, ageDays: 30, touchesCode: false, codeIntegrated: false }, opts)).toBe("harvest");
  });
  it("WS-5.4: contentLanded LIBERA um branch que a ancestralidade não limpou → harvested-landed-content", () => {
    // Cherry-pick/squash: sha novo, patch-id novo, conteúdo salvo em main/stage. Era exatamente isto que
    // ficava preso em keep-unmerged-code para sempre.
    expect(
      classifyBranch({ superseded: true, ageDays: 30, touchesCode: true, codeIntegrated: false, contentLanded: true }, opts),
    ).toBe("harvested-landed-content");
  });
  it("WS-5.4: contentLanded respeita a MESMA janela de carência (o humano ainda pode olhar antes)", () => {
    expect(
      classifyBranch({ superseded: true, ageDays: 2, touchesCode: true, codeIntegrated: false, contentLanded: true }, opts),
    ).toBe("keep");
  });
  it("WS-5.4: contentLanded:false não muda NADA (só acusa quem prova; ele só absolve)", () => {
    expect(
      classifyBranch({ superseded: true, ageDays: 30, touchesCode: true, codeIntegrated: false, contentLanded: false }, opts),
    ).toBe("keep-unmerged-code");
  });
});

describe("ageDaysFromUnix", () => {
  it("computes whole/fractional days from a unix timestamp", () => {
    expect(ageDaysFromUnix((NOW - 8 * DAY) / 1000, NOW)).toBeCloseTo(8, 5);
  });
  it("is null for a future-dated tip (clock skew) and for a missing timestamp", () => {
    expect(ageDaysFromUnix((NOW + 5 * DAY) / 1000, NOW)).toBeNull();
    expect(ageDaysFromUnix(null, NOW)).toBeNull();
  });
});

/** A preserved branch fixture — only the fields the GC reads. */
const pb = (over: Partial<PreservedBranch>): PreservedBranch => ({
  branch: "failed/run/x",
  sessionId: "x",
  kind: "failed",
  origin: "run", // WS-1: `session` branches take the SAME rules — see the agent/* replay at the bottom
  board: null,
  cardId: null,
  cardTitle: null,
  cardStatus: null,
  subject: "",
  ageRelative: "",
  ownCommits: 1,
  filesChanged: 1,
  touchesCode: false,
  verdict: "stale-board-data",
  baseProvenance: "reflog",
  superseded: true,
  needsAttention: false,
  reason: "",
  recoverHint: "",
  ...over,
});

describe("runBranchGc — harvest via the shared verdict, journal, dryRun-safe", () => {
  const ages: Record<string, number> = {
    "failed/run/super-old": 8,
    "conflicted/run/redrive-old": 30,
    "failed/run/code-old": 40,
    "failed/run/super-fresh": 2,
    "failed/run/unknown-old": 90,
  };
  const branches: PreservedBranch[] = [
    pb({ branch: "failed/run/super-old", verdict: "stale-board-data", superseded: true }),
    pb({ branch: "conflicted/run/redrive-old", kind: "conflicted", verdict: "superseded-by-redrive", superseded: true, touchesCode: true }),
    pb({ branch: "failed/run/code-old", verdict: "unintegrated-code", superseded: false, needsAttention: true, touchesCode: true }),
    pb({ branch: "failed/run/super-fresh", verdict: "integrated", superseded: true }),
    pb({ branch: "failed/run/unknown-old", verdict: "unknown", superseded: false }),
  ];
  const deps = (dryRun: boolean) => {
    const deletes: string[] = [];
    const journal: BranchGcJournalEntry[] = [];
    return {
      deletes,
      journal,
      run: (advisedThisRun?: Set<string>) =>
        runBranchGc({
          listPreserved: async () => branches,
          ageDaysOf: async (b) => ages[b] ?? null,
          deleteBranch: async (b) => {
            deletes.push(b);
            return true;
          },
          now: NOW,
          dryRun,
          journal: (e) => void journal.push(e),
          advisedThisRun,
        }),
    };
  };

  it("harvests the aged SUPERSEDED branches (incl. a redrive loser); flags unintegrated code; NEVER touches unknown", async () => {
    const d = deps(false);
    const res = await d.run();
    expect(d.deletes.sort()).toEqual(["conflicted/run/redrive-old", "failed/run/super-old"]);
    const by = Object.fromEntries(res.map((e) => [e.branch, e]));
    expect(by["failed/run/super-old"]).toMatchObject({ action: "harvest", deleted: true });
    expect(by["conflicted/run/redrive-old"]).toMatchObject({ action: "harvest", deleted: true, verdict: "superseded-by-redrive" });
    expect(by["failed/run/code-old"]).toMatchObject({ action: "stale-advisory", deleted: false }); // unique code → advisory, never deleted
    expect(by["failed/run/unknown-old"]).toMatchObject({ action: "stale-advisory", deleted: false }); // fail closed
    expect(by["failed/run/super-fresh"]).toBeUndefined(); // fresh → keep, not journaled
  });

  it("WS-2.3: a superseded CODE branch whose code is NOT on main/stage is KEPT (kept-unmerged-code)", async () => {
    // The qb8z2c protection: conflicted/run/* snapshots hold the ONLY copies of the fix; the verdict marks
    // them superseded-by-redrive → harvestable, but codeReachedMainOrStage says the code never landed.
    const deletes: string[] = [];
    const res = await runBranchGc({
      listPreserved: async () => [
        pb({ branch: "conflicted/run/qb8z2c", kind: "conflicted", verdict: "superseded-by-redrive", superseded: true, touchesCode: true }),
      ],
      ageDaysOf: async () => 30, // aged well past the harvest window
      deleteBranch: async (b) => { deletes.push(b); return true; },
      now: NOW,
      dryRun: false,
      journal: () => {},
      codeReachedMainOrStage: async () => false, // code is NOT on main nor stage → fail closed
    });
    expect(deletes).toEqual([]); // NEVER harvested
    expect(res[0]).toMatchObject({ branch: "conflicted/run/qb8z2c", action: "keep-unmerged-code", deleted: false });
  });

  it("WS-2.3: the SAME branch IS harvested once its code reached main/stage (guard releases it)", async () => {
    const deletes: string[] = [];
    const res = await runBranchGc({
      listPreserved: async () => [
        pb({ branch: "conflicted/run/qb8z2c", kind: "conflicted", verdict: "superseded-by-redrive", superseded: true, touchesCode: true }),
      ],
      ageDaysOf: async () => 30,
      deleteBranch: async (b) => { deletes.push(b); return true; },
      now: NOW,
      dryRun: false,
      journal: () => {},
      codeReachedMainOrStage: async () => true, // code landed → safe to harvest
    });
    expect(deletes).toEqual(["conflicted/run/qb8z2c"]);
    expect(res[0]).toMatchObject({ action: "harvest", deleted: true });
  });

  // ── WS-5.4 — colheita por CONVERGÊNCIA DE CONTEÚDO ────────────────────────────────────────────────────
  // A ancestralidade é cega ao cherry-pick/squash, então o guard WS-2.3 acima segurava PARA SEMPRE um branch
  // cujo código estava salvo em main/stage — lixo imortal por outra porta. Só `landed` (prova positiva)
  // solta o branch; tudo mais mantém o fail-closed.
  const stuckCodeBranch = () =>
    pb({ branch: "conflicted/run/qb8z2c", kind: "conflicted", verdict: "superseded-by-redrive", superseded: true, touchesCode: true });
  const runWithContent = async (contentLanded: () => Promise<Landedness>, ageDays = 30) => {
    const deletes: string[] = [];
    const res = await runBranchGc({
      listPreserved: async () => [stuckCodeBranch()],
      ageDaysOf: async () => ageDays,
      deleteBranch: async (b) => { deletes.push(b); return true; },
      now: NOW,
      dryRun: false,
      journal: () => {},
      codeReachedMainOrStage: async () => false, // ancestralidade NÃO prova nada (é o caso do cherry-pick)
      contentLandedInMainOrStage: contentLanded,
    });
    return { deletes, res };
  };

  it("WS-5.4: branch cujo conteúdo ATERRISSOU (cherry-pick) é colhido — harvested-landed-content", async () => {
    const { deletes, res } = await runWithContent(async () => "landed");
    expect(deletes).toEqual(["conflicted/run/qb8z2c"]);
    expect(res[0]).toMatchObject({ action: "harvested-landed-content", deleted: true });
  });

  it("WS-5.4: QUALQUER hunk não contido (partial) MANTÉM o branch — kept-unmerged-code", async () => {
    const { deletes, res } = await runWithContent(async () => "partial");
    expect(deletes).toEqual([]);
    expect(res[0]).toMatchObject({ action: "keep-unmerged-code", deleted: false });
  });

  it("WS-5.4: `absent`/`unknown` mantêm o branch (fail-closed intacto)", async () => {
    for (const verdict of ["absent", "unknown"] as const) {
      const { deletes, res } = await runWithContent(async () => verdict);
      expect(deletes).toEqual([]);
      expect(res[0]).toMatchObject({ action: "keep-unmerged-code" });
    }
  });

  it("WS-5.4: a sonda de convergência LANÇANDO é fail-closed (mantém), nunca colhe", async () => {
    const { deletes, res } = await runWithContent(async () => { throw new Error("git down"); });
    expect(deletes).toEqual([]);
    expect(res[0]).toMatchObject({ action: "keep-unmerged-code" });
  });

  it("WS-5.4: conteúdo aterrissado mas DENTRO da janela de carência ⇒ keep (a graça do operador não muda)", async () => {
    const { deletes, res } = await runWithContent(async () => "landed", 2);
    expect(deletes).toEqual([]);
    expect(res).toEqual([]); // keep → nem journaled
  });

  it("WS-5.4: sem a sonda injetada, o comportamento pré-WS-5.4 é IDÊNTICO (branch cherry-picked segue kept)", async () => {
    const deletes: string[] = [];
    const res = await runBranchGc({
      listPreserved: async () => [stuckCodeBranch()],
      ageDaysOf: async () => 30,
      deleteBranch: async (b) => { deletes.push(b); return true; },
      now: NOW,
      dryRun: false,
      journal: () => {},
      codeReachedMainOrStage: async () => false,
      // contentLandedInMainOrStage ABSENT → caminho de conteúdo desligado
    });
    expect(deletes).toEqual([]);
    expect(res[0]).toMatchObject({ action: "keep-unmerged-code" });
  });

  it("WS-2.3: the integration check THROWING is fail-closed (treated as un-integrated → kept)", async () => {
    const deletes: string[] = [];
    await runBranchGc({
      listPreserved: async () => [
        pb({ branch: "conflicted/run/x", kind: "conflicted", verdict: "superseded-by-redrive", superseded: true, touchesCode: true }),
      ],
      ageDaysOf: async () => 30,
      deleteBranch: async (b) => { deletes.push(b); return true; },
      now: NOW,
      dryRun: false,
      journal: () => {},
      codeReachedMainOrStage: async () => { throw new Error("git down"); },
    });
    expect(deletes).toEqual([]); // fail-closed → never harvested
  });

  it("dryRun → journals the harvest PLAN but deletes nothing", async () => {
    const d = deps(true);
    const res = await d.run();
    expect(d.deletes).toEqual([]);
    expect(res.filter((e) => e.action === "harvest").every((e) => e.deleted === false)).toBe(true);
  });

  it("a stale advisory is journaled ONCE per process — a repeating tick does not re-log it (the 2480-line bug)", async () => {
    const d = deps(false);
    const advised = new Set<string>();
    await d.run(advised); // tick 1
    await d.run(advised); // tick 2 — same advisories
    const advisories = d.journal.filter((e) => e.action === "stale-advisory").map((e) => e.branch);
    // code-old + unknown-old advised exactly once each across both ticks.
    expect(advisories.sort()).toEqual(["failed/run/code-old", "failed/run/unknown-old"]);
  });

  it("a branch with no resolvable age is skipped (never harvested)", async () => {
    const deletes: string[] = [];
    const res = await runBranchGc({
      listPreserved: async () => [pb({ branch: "failed/run/nodate", superseded: true })],
      ageDaysOf: async () => null,
      deleteBranch: async (b) => {
        deletes.push(b);
        return true;
      },
      now: NOW,
      dryRun: false,
      journal: () => {},
    });
    expect(res).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it("a listing failure degrades to [] (never throws)", async () => {
    const res = await runBranchGc({
      listPreserved: async () => {
        throw new Error("git down");
      },
      ageDaysOf: async () => 10,
      deleteBranch: async () => true,
      now: NOW,
      dryRun: false,
      journal: () => {},
    });
    expect(res).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A TENTATIVA PERDEDORA DE UM CARD QUE ENTREGOU.
//
// Medição de 2026-07-27: 18 branches presas em `keep-unmerged-code`, base EXATA em 28/28 (o dado
// existia). NOVE delas eram snapshots `superseded-by-redrive` de cards `concluida` cujo delta próprio
// media `landed` — e TRÊS eram as tentativas perdedoras do próprio qb8z2c, o incidente que criou o
// guard fail-closed. Ele estava preservando a evidência do incidente que existe para prevenir, muito
// depois de o incidente estar resolvido, porque a régua dele é ancestralidade e não convergência.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("classifyBranch — a prova sobre o CARD solta a tentativa perdedora", () => {
  const OPTS = { harvestAfterDays: 7, staleAfterDays: 30 };
  const loser = (over: Record<string, unknown> = {}) => ({
    superseded: true,
    ageDays: 30,
    touchesCode: true,
    codeIntegrated: false, // ancestralidade NÃO limpa — é o estado das 18 presas
    ...over,
  });

  it("card entregou (provado) ⇒ colhe, e o journal diz QUAL prova soltou", () => {
    expect(classifyBranch(loser({ cardDelivered: true }), OPTS)).toBe("harvested-card-delivered");
  });

  it("SEM a prova, nada muda: o guard fail-closed segura como sempre segurou", () => {
    expect(classifyBranch(loser(), OPTS)).toBe("keep-unmerged-code");
    expect(classifyBranch(loser({ cardDelivered: false }), OPTS)).toBe("keep-unmerged-code");
  });

  it("a prova NÃO atropela a carência — a janela para um humano olhar continua de pé", () => {
    expect(classifyBranch(loser({ cardDelivered: true, ageDays: 3 }), OPTS)).toBe("keep");
  });

  it("a prova de CONTEÚDO (mais forte, sobre a própria branch) tem precedência", () => {
    // Duas provas verdadeiras ⇒ vence a que fala da branch, não a que fala do card: o journal fica
    // dizendo a verdade mais específica sobre por que aquela branch podia ir.
    expect(classifyBranch(loser({ cardDelivered: true, contentLanded: true }), OPTS)).toBe("harvested-landed-content");
  });

  it("a regra é ESTREITA: sem a prova, uma branch que não toca código segue no caminho normal", () => {
    expect(classifyBranch({ superseded: true, ageDays: 30, touchesCode: false }, OPTS)).toBe("harvest");
  });
});

describe("runBranchGc — a terceira prova é a mais estreita: quase ninguém chega a pagá-la", () => {
  const base = {
    ageDaysOf: async () => 30,
    deleteBranch: async () => true,
    now: 0,
    dryRun: false,
    journal: () => {},
  };
  const branch = (over: Partial<PreservedBranch> = {}) =>
    ({
      branch: "conflicted/run/abc",
      sessionId: "abc",
      kind: "conflicted",
      origin: "run",
      board: "acme",
      cardId: "story-1",
      touchesCode: true,
      verdict: "superseded-by-redrive",
      superseded: true,
      ...over,
    }) as unknown as PreservedBranch;

  it("colhe a tentativa perdedora quando o card provadamente entregou", async () => {
    const deleted: string[] = [];
    const out = await runBranchGc({
      ...base,
      listPreserved: async () => [branch()],
      deleteBranch: async (b) => (deleted.push(b), true),
      codeReachedMainOrStage: async () => false,
      contentLandedInMainOrStage: async () => "absent",
      cardDeliveredLanded: async () => true,
    });
    expect(out[0]).toMatchObject({ action: "harvested-card-delivered", deleted: true });
    expect(deleted).toEqual(["conflicted/run/abc"]);
  });

  it("NÃO pergunta pelo card quando a branch não é uma tentativa perdedora — a régua é estreita", async () => {
    let asked = 0;
    await runBranchGc({
      ...base,
      listPreserved: async () => [branch({ verdict: "unintegrated-code" })],
      codeReachedMainOrStage: async () => false,
      contentLandedInMainOrStage: async () => "absent",
      cardDeliveredLanded: async () => (asked++, true),
    });
    expect(asked).toBe(0);
  });

  it("NÃO pergunta pelo card quando o CONTEÚDO já soltou a branch — no máximo uma prova paga por branch", async () => {
    let asked = 0;
    await runBranchGc({
      ...base,
      listPreserved: async () => [branch()],
      codeReachedMainOrStage: async () => false,
      contentLandedInMainOrStage: async () => "landed",
      cardDeliveredLanded: async () => (asked++, true),
    });
    expect(asked).toBe(0);
  });

  it("a sonda que EXPLODE conta como 'não provou' — fail-closed, nunca uma deleção por acidente", async () => {
    const deleted: string[] = [];
    const out = await runBranchGc({
      ...base,
      listPreserved: async () => [branch()],
      deleteBranch: async (b) => (deleted.push(b), true),
      codeReachedMainOrStage: async () => false,
      contentLandedInMainOrStage: async () => "absent",
      cardDeliveredLanded: async () => {
        throw new Error("git morreu");
      },
    });
    expect(out[0].action).toBe("keep-unmerged-code");
    expect(deleted).toEqual([]);
  });

  it("dep AUSENTE ⇒ regra DESLIGADA (comportamento anterior, byte-idêntico)", async () => {
    const out = await runBranchGc({
      ...base,
      listPreserved: async () => [branch()],
      codeReachedMainOrStage: async () => false,
      contentLandedInMainOrStage: async () => "absent",
    });
    expect(out[0].action).toBe("keep-unmerged-code");
  });
});
