import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardConfig, Card, StatusDef } from "@/lib/storymap/types";

// Regression repro for story-pqd7gs (mode: fix): moving a card by DRAG (or MCP move_card —
// the SAME server action) into an `autorun:true + trigger` column must fire that column's
// skill in-process, NOT only via the fs watcher. Before the fix, moveCardAction merely
// persisted the .md and the run depended on an open SSE tab + a reliable recursive fs.watch
// delivering card.moved — so a drag the watcher missed never started anything (the operator
// had to hit "Rodar agora"). This test drives moveCardAction and asserts the engine spawned.

// next/cache is a Next-only runtime; stub revalidatePath so importing the server action works.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

// The engine spy stands in for the run-skill spawn (never launches a real `claude`).
const runSkill = vi.fn((..._args: unknown[]) => ({ ok: true as const }));
vi.mock("@/lib/storymap/runner/engine", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/engine")>();
  // lastRun (ADR-063 4b loop-guard): the shell reads it before every autorun spawn; here the journal is
  // empty so it returns undefined → the loop-guard resets to 0 and never trips (this mock's config has no
  // noProgressMax anyway). Present so the shell's `getRunnerEngine().lastRun(...)` call doesn't throw.
  return { ...actual, getRunnerEngine: () => ({ runSkill, onComplete: () => () => {}, lastRun: async () => undefined }) };
});

// decideCascade spy — wraps the REAL pure kernel so a NEGATIVE test can prove the GUARD was
// exercised (the action fired evaluateAutorunOnEntry, which reached the kernel) and the kernel
// DECLINED for the right reason, instead of vacuously passing because the feature was never wired.
// The spy records each call AND returns the real decision; the factory only references it lazily
// (inside the wrapper arrow), so the const can be declared after this hoisted vi.mock.
const decideCascadeSpy = vi.fn();
vi.mock("@/lib/notifications/server/channels/cascade-decision", async (orig) => {
  const actual = await orig<typeof import("@/lib/notifications/server/channels/cascade-decision")>();
  return {
    ...actual,
    decideCascade: (...args: Parameters<typeof actual.decideCascade>) => {
      const decision = actual.decideCascade(...args);
      decideCascadeSpy(args, decision);
      return decision;
    },
  };
});

// reconcileCardMergeEntries spy — on a GENUINE status change moveCardAction supersedes a card's
// PARKED merge-queue entry (Front 3); updateCardAction (the MCP / drawer Status path) must do the
// SAME so a reopen-via-update doesn't leave a ghost head-of-line entry while spawning a fresh run
// (story-wy1t7d move-parity). The action dynamic-imports this module, which vi.mock intercepts.
const reconcileCardMergeEntries = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/storymap/runner/merge-queue", () => ({
  getMergeQueue: () => ({ reconcileCardMergeEntries }),
}));

// ENTRY_EFFECTS spy (story-dboh30) — the onEnter side-effect a card fires when it ENTERS a step declaring
// `onEnter` (promote-stage/deploy-board). moveCardAction (drag / MCP move_card) fires it today; updateCardAction
// (the drawer's Status select + Save AND "Mover para") must fire it too — else a human moving a card into a
// release/deploy column via the drawer marks it advanced WITHOUT the code ever being promoted/deployed. We stub
// the whole module (only ENTRY_EFFECTS + runEntryEffect are imported in this graph) so the REAL promoteStageToMain/
// deployBoard (git + systemd) never run. `entryEffectFire` is referenced lazily inside the dispatch arrows so the
// hoisted vi.mock never touches the not-yet-initialised const (mirrors the merge-queue / engine mocks above).
const entryEffectFire = vi.fn(async (..._args: unknown[]) => {});
vi.mock("@/lib/storymap/runner/entry-effects", () => ({
  ENTRY_EFFECTS: {
    "promote-stage": (boardId: string, cardId?: string) => entryEffectFire("promote-stage", boardId, cardId),
    "deploy-board": (boardId: string, cardId?: string) => entryEffectFire("deploy-board", boardId, cardId),
    "promote-and-deploy": (boardId: string, cardId?: string) => entryEffectFire("promote-and-deploy", boardId, cardId),
  },
  runEntryEffect: (effect: string, boardId: string, cardId?: string) => entryEffectFire(effect, boardId, cardId),
}));

// Master switch ON (live-evaluated by the helper); the rest of the config is irrelevant here.
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/runner/config")>();
  return { ...actual, loadRunnerConfig: () => ({ autorun: { enabled: true } }) as never };
});

// The board: a manual source column + an autorun:true column carrying a trigger (harness-do).
const autorunCol: StatusDef = { id: "desenvolver", name: "Em desenvolvimento", trigger: "harness-do", autorun: true };
// A `release`-style column that declares an onEnter effect (promote-stage): ENTERING it must FIRE the effect,
// whether the entry comes via a drag (moveCardAction) or the drawer Save/Mover para (updateCardAction) — story-dboh30.
const onEnterCol: StatusDef = { id: "release", name: "Release", onEnter: "promote-stage" };
const boardConfig: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [{ id: "quebrar-tasks", name: "Quebrar tasks" }, autorunCol, onEnterCol],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

// A triage-intake board for acceptTriageCardAction (story-wy1t7d): a `triage` staging lane plus the
// routed entry lanes acceptRoute targets — `corrigir` (bug, gate hasBugReport, autorun harness-fix),
// `enriquecer` (feature, autorun harness-enrich) and a MANUAL `refinar` (autorun:false → cascade STOPs,
// proving the gate/autorun-respecting branch). Mirrors the real board's lane shape.
const triageBoardConfig: BoardConfig = {
  id: "tb",
  name: "TB",
  statuses: [
    // `staging: true` é o que MARCA a quarentena — a mesma faceta que o Inbox usa para cobrar a revisão
    // (needsTriageReview) e que o aceite exige. O fixture antes só tinha o id "triage" e passava porque a
    // ação comparava o id literal; hoje a régua é a faceta, então o fixture precisa modelar o board real
    // (`boards/_base`: triage tem `staging: true`).
    { id: "triage", name: "Triagem", staging: true },
    { id: "corrigir", name: "Corrigir", trigger: "harness-fix", autorun: true, gate: "hasBugReport" },
    { id: "refinar", name: "Refinar", trigger: "harness-refine", autorun: false, gate: "hasRefineBrief" },
    { id: "enriquecer", name: "Enriquecer", trigger: "harness-enrich", autorun: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

// The card on disk — `updateCardOnDisk` mutates this shared ref, `readCards` reflects it,
// so the helper reads the card already sitting in its new (autorun) status.
let cardOnDisk: Card;

const configFor = (boardId: string): BoardConfig =>
  boardId === "tb" ? triageBoardConfig : boardConfig;

vi.mock("@/lib/storymap/repo", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/repo")>();
  return {
    ...actual,
    readBoardConfig: async (boardId: string) => configFor(boardId),
    readCards: async () => [cardOnDisk],
    readCard: async () => cardOnDisk,
  };
});

vi.mock("@/lib/storymap/write", async (orig) => {
  const actual = await orig<typeof import("@/lib/storymap/write")>();
  return {
    ...actual,
    updateCardOnDisk: async (_b: string, _id: string, mutate: (c: Card) => Card | null) => {
      const next = mutate(cardOnDisk);
      if (next) cardOnDisk = next;
      return next;
    },
    writeCard: async () => {},
  };
});

import { acceptTriageCardAction, moveCardAction, updateCardAction } from "./actions";
import { coerceCard } from "@/lib/storymap/repo";

// Let the fire-and-forget helper promise chain settle (disk reads resolve on the microtask
// queue; one macrotask flush is enough since the mocks resolve immediately).
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The CascadeDecision the spy's LAST call returned (its `reason` when it stopped). Lets a negative
// test assert the kernel was reached AND declined for the right reason — not merely "no spawn".
// Each spy call is recorded as [args, decision]; the wrapper passes the REAL decision as arg #2.
const lastCascadeDecision = (): { action: string; reason?: string } | undefined => {
  const calls = decideCascadeSpy.mock.calls;
  const last = calls[calls.length - 1];
  return last ? (last[1] as { action: string; reason?: string }) : undefined;
};
// The card argument decideCascade was called with, for a given landed status (proves the kernel was
// reached with the card actually sitting in that status — not some upstream/echoed call).
const cascadeCalledWithStatus = (status: string): boolean =>
  decideCascadeSpy.mock.calls.some(([args]) => ((args as [Card])[0]?.status) === status);

beforeEach(() => {
  runSkill.mockClear();
  decideCascadeSpy.mockClear();
  reconcileCardMergeEntries.mockClear();
  entryEffectFire.mockClear();
  // A card with ≥1 task (so the hasTasks gate on `desenvolver` passes) starting upstream.
  cardOnDisk = coerceCard(
    "story-x",
    {
      type: "story",
      storyType: "bug",
      status: "quebrar-tasks",
      tasks: [{ id: "t1", title: "fazer", done: false }],
    },
    "",
  );
});

afterEach(() => vi.clearAllMocks());

describe("moveCardAction — autorun fires in-process on drag / MCP move_card (story-pqd7gs)", () => {
  it("a move into an autorun:true+trigger column spawns the column's skill", async () => {
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", status: "desenvolver" });
    expect(res.ok).toBe(true);
    await flush();
    expect(runSkill).toHaveBeenCalledTimes(1);
    const [board, cardId, trigger, def] = runSkill.mock.calls[0];
    expect({ board, cardId, trigger, defId: (def as StatusDef).id }).toEqual({
      board: "b",
      cardId: "story-x",
      trigger: "harness-do",
      defId: "desenvolver",
    });
    // The REFERENCE behavior update_card must mirror: a genuine move supersedes any parked merge entry.
    expect(reconcileCardMergeEntries).toHaveBeenCalledWith("b", "story-x");
  });

  it("a pure reorder (no status change) does NOT spawn anything NOR reconcile a parked entry", async () => {
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", order: 50 });
    expect(res.ok).toBe(true);
    await flush();
    expect(runSkill).not.toHaveBeenCalled();
    expect(reconcileCardMergeEntries).not.toHaveBeenCalled();
  });

  // --- SM-02: moveCardAction toggles the unplaced flag on an explicit reparent ----
  it("drops unplaced when a story is parented onto a step (leaves the backlog lane)", async () => {
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", status: "quebrar-tasks", parent: null, unplaced: true },
      "",
    );
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", parent: "step-1" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.parent).toBe("step-1");
    expect(cardOnDisk.unplaced).toBeUndefined();
  });

  it("sets unplaced when a story is explicitly un-mapped to parent:null", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", status: "quebrar-tasks", parent: "step-1" }, "");
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", parent: null });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.parent).toBeNull();
    expect(cardOnDisk.unplaced).toBe(true);
  });

  it("does NOT migrate a legacy orphan on a pure reorder (parent untouched)", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", status: "quebrar-tasks", parent: null }, "");
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", order: 50 });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.parent).toBeNull();
    expect(cardOnDisk.unplaced).toBeUndefined();
  });

  it("a same-column reorder (Kanban resubmits the UNCHANGED status + a new order) does NOT re-fire the skill", async () => {
    // The Kanban drag always passes `status` alongside `order`, even when the card stays
    // in its column — so the guard must compare against the PREVIOUS status, not merely
    // check that `status` was supplied. A card already resting in an autorun column that
    // gets reordered must not re-spawn its skill (story-pqd7gs regression guard).
    cardOnDisk = coerceCard(
      "story-x",
      {
        type: "story",
        storyType: "bug",
        status: "desenvolver",
        tasks: [{ id: "t1", title: "fazer", done: false }],
      },
      "",
    );
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", status: "desenvolver", order: 99 });
    expect(res.ok).toBe(true);
    await flush();
    expect(runSkill).not.toHaveBeenCalled();
  });
});

// story-dboh30: entering a column that declares an `onEnter` effect (promote-stage/deploy-board) must FIRE
// that effect — NOT ONLY via moveCardAction (drag / MCP move_card), but ALSO via updateCardAction (the
// drawer's Status select + Save, and its "Mover para" confirm). Both drawer paths persist the WHOLE card
// through updateCardAction (so unsaved authorial edits aren't lost — moveCardAction writes only position
// fields), so the fix must live in updateCardAction. Before it, updateCardAction fired the autorun cascade +
// merge reconcile on a status change but SKIPPED the ENTRY_EFFECT → a human moving a card into release/deploy
// via the drawer marked it advanced WITHOUT the code ever being promoted/deployed (the story-byel8k root
// cause, on the ACTION layer the MCP-tool fix didn't cover).
describe("onEnter ENTRY_EFFECT parity — moveCardAction AND updateCardAction fire it (story-dboh30)", () => {
  it("moveCardAction into an onEnter:promote-stage column fires the effect (control — the reference behavior)", async () => {
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", status: "release" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("release");
    await flush();
    expect(entryEffectFire).toHaveBeenCalledTimes(1);
    expect(entryEffectFire).toHaveBeenCalledWith("promote-stage", "b", "story-x");
  });

  it("updateCardAction (drawer Save / Mover para) into an onEnter:promote-stage column fires the effect", async () => {
    // The drawer bundles a Status change with the authorial draft in ONE updateCardAction call; a move into
    // `release` must fire promote-stage exactly like the drag path — else the card advances but the staged
    // code is never promoted to main (card diverges from code reality). This is the story-dboh30 regression.
    const draft = coerceCard("story-x", { type: "story", storyType: "bug", status: "release", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: draft });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("release");
    await flush();
    expect(entryEffectFire).toHaveBeenCalledTimes(1);
    expect(entryEffectFire).toHaveBeenCalledWith("promote-stage", "b", "story-x");
  });

  it("a plain edit (status unchanged) does NOT fire the onEnter effect via updateCardAction", async () => {
    // The card already rests in `release`; a Save touching only the title must NOT re-fire promote-stage (the
    // prevStatus === card.status guard) — else every body/title edit on a shipped card would re-promote to main.
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "bug", status: "release", title: "orig", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const draft = coerceCard("story-x", { type: "story", storyType: "bug", status: "release", title: "renamed", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: draft });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.title).toBe("renamed");
    await flush();
    expect(entryEffectFire).not.toHaveBeenCalled();
  });
});

describe("moveCardAction — status-existence guard (storymap-critical-audit #3)", () => {
  it("rejects a move to a status NOT in the board config — never persists a phantom status, never spawns", async () => {
    const before = cardOnDisk.status; // "quebrar-tasks"
    // A typo / renamed-column id (the MCP move_card status is a free z.string()): without the guard
    // checkGate returns null (no gate on an unknown status) and the card persists OUTSIDE the pipeline.
    const res = await moveCardAction({ boardId: "b", cardId: "story-x", status: "desenvolveer" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/inexistente/);
    await flush();
    expect(runSkill).not.toHaveBeenCalled(); // never spawned a skill on a phantom status
    expect(cardOnDisk.status).toBe(before); // the write never happened — card stays put
  });
});

describe("updateCardAction — a plain Save never reverts a concurrent on-disk advance (audit #4)", () => {
  it("PRESERVES the disk status when the user didn't touch status (drawer opened on the OLD status)", async () => {
    // The drawer opened while the card was in quebrar-tasks; the cascade then advanced it on disk to
    // desenvolver. The user edits only the body and Saves with the stale baseline → must NOT revert.
    cardOnDisk = coerceCard("story-x", { type: "story", status: "desenvolver", title: "orig", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const draft = coerceCard("story-x", { type: "story", status: "quebrar-tasks", title: "edited", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: draft, expectedStatus: "quebrar-tasks" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("desenvolver"); // advance PRESERVED (not reverted to quebrar-tasks)
    expect(cardOnDisk.title).toBe("edited"); // the user's real edit still lands
  });

  it("APPLIES an intentional status change (draft status differs from the baseline)", async () => {
    cardOnDisk = coerceCard("story-x", { type: "story", status: "quebrar-tasks", title: "orig", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const moved = coerceCard("story-x", { type: "story", status: "desenvolver", title: "orig", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: moved, expectedStatus: "quebrar-tasks" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("desenvolver"); // the explicit move (select / Mover para) is honored
  });
});

// story-wy1t7d: accept_triage and update_card (the MCP mutation actions) must cascade into the
// autorun lane exactly like a UI drag / MCP move_card — they share moveCardAction's in-process
// evaluateAutorunOnEntry trigger, guarded so a NON-status change never spawns.
describe("acceptTriageCardAction — autorun fires in-process on accept into a routed lane (story-wy1t7d)", () => {
  it("aceitar é privilégio da QUARENTENA (faceta staging), não de um id chamado 'triage'", async () => {
    // A régua é declarativa: quem pode ser aceito é quem está num passo `staging: true`. Um card que já
    // saiu da quarentena (aqui, já em `corrigir`) é recusado — e o botão do Inbox some pela MESMA régua,
    // então a UI nunca oferece o que o servidor recusaria.
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "bug", status: "corrigir", title: "t", bugReport: { brief: "quebrou" } },
      "",
    );
    const res = await acceptTriageCardAction({ boardId: "tb", cardId: "story-x" });
    expect(res.ok).toBe(false);
    expect(cardOnDisk.status).toBe("corrigir"); // nada se moveu
    await flush();
    expect(runSkill).not.toHaveBeenCalled();
  });

  it("a triage bug routed to `corrigir` (autorun harness-fix) spawns the lane's skill", async () => {
    // A bug with a bugReport.brief (satisfies the corrigir hasBugReport gate); acceptRoute sends a
    // storyType:bug to `corrigir` — an autorun:true+trigger lane → the cascade must RUN harness-fix.
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "bug", status: "triage", bugReport: { brief: "quebra ao salvar" } },
      "",
    );
    const res = await acceptTriageCardAction({ boardId: "tb", cardId: "story-x" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("corrigir");
    await flush();
    expect(runSkill).toHaveBeenCalledTimes(1);
    const [board, cardId, trigger, def] = runSkill.mock.calls[0];
    expect({ board, cardId, trigger, defId: (def as StatusDef).id }).toEqual({
      board: "tb",
      cardId: "story-x",
      trigger: "harness-fix",
      defId: "corrigir",
    });
  });

  it("a triage feature routed to `enriquecer` (autorun harness-enrich) spawns the lane's skill", async () => {
    // A non-user feature (storyType technical) routes to `enriquecer` per acceptRoute → autorun harness-enrich.
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "technical", status: "triage", title: "feature" },
      "",
    );
    const res = await acceptTriageCardAction({ boardId: "tb", cardId: "story-x" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("enriquecer");
    await flush();
    expect(runSkill).toHaveBeenCalledTimes(1);
    const [, , trigger, def] = runSkill.mock.calls[0];
    expect(trigger).toBe("harness-enrich");
    expect((def as StatusDef).id).toBe("enriquecer");
  });

  it("a triage refinement routed to a MANUAL `refinar` lane does NOT spawn (cascade STOPs on autorun:false) — criterion 2", async () => {
    // mode:refine routes to `refinar`, which on this board is autorun:false → decideCascade returns
    // STOP(manual). The card still MOVES (accept succeeds), but no skill fires — proving the new
    // trigger respects autorun/gates identically to the drag path.
    cardOnDisk = coerceCard(
      "story-x",
      { type: "story", storyType: "user", mode: "refine", status: "triage", refinement: { brief: "melhorar o copy" } },
      "",
    );
    const res = await acceptTriageCardAction({ boardId: "tb", cardId: "story-x" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("refinar");
    await flush();
    // PROVE THE GUARD (not the mere absence of the feature): the accept DID fire the in-process
    // cascade — decideCascade was reached with the card sitting in its landed `refinar` status —
    // and the kernel DECLINED (stop/manual) because that lane is autorun:false. A vacuous test that
    // only asserts `runSkill` not-called would also pass if the trigger were never wired at all;
    // this asserts it WAS wired and correctly stopped.
    expect(decideCascadeSpy).toHaveBeenCalled();
    expect(cascadeCalledWithStatus("refinar")).toBe(true);
    expect(lastCascadeDecision()).toEqual({ action: "stop", reason: "manual" });
    expect(runSkill).not.toHaveBeenCalled();
  });
});

describe("updateCardAction — an intentional status change cascades into autorun, a plain edit does NOT (story-wy1t7d)", () => {
  it("an intentional status change into an autorun column fires the column's skill", async () => {
    // No expectedStatus (the MCP update_card path): the persisted status (desenvolver) differs from the
    // disk status before the save (quebrar-tasks) → the cascade RUNs harness-do, like a drag/move_card.
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "bug", status: "quebrar-tasks", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const draft = coerceCard("story-x", { type: "story", storyType: "bug", status: "desenvolver", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: draft });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("desenvolver");
    await flush();
    expect(runSkill).toHaveBeenCalledTimes(1);
    const [board, cardId, trigger, def] = runSkill.mock.calls[0];
    expect({ board, cardId, trigger, defId: (def as StatusDef).id }).toEqual({
      board: "b",
      cardId: "story-x",
      trigger: "harness-do",
      defId: "desenvolver",
    });
    // move-parity (story-wy1t7d): a genuine status change via update_card must ALSO supersede any
    // PARKED merge-queue entry for this card — the SECOND thing moveCardAction does on a real move.
    // Without the reconcile call this assertion FAILS (a card reopened via update_card would spawn a
    // fresh run while a ghost head-of-line entry lingers → refutes AC#3 'behaviorally identical').
    expect(reconcileCardMergeEntries).toHaveBeenCalledTimes(1);
    expect(reconcileCardMergeEntries).toHaveBeenCalledWith("b", "story-x");
  });

  it("a non-status edit (only the title changes) does NOT spawn anything NOR reconcile a parked entry", async () => {
    // The card already rests in the autorun column; a plain Save touching only the title must NOT
    // re-fire the column's skill (the prevStatus === card.status guard).
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "bug", status: "desenvolver", title: "orig", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const draft = coerceCard("story-x", { type: "story", storyType: "bug", status: "desenvolver", title: "renamed", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: draft });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("desenvolver");
    expect(cardOnDisk.title).toBe("renamed");
    await flush();
    // PROVE THE GUARD: the actions-level `card.status === prevStatus` check short-circuits BEFORE
    // the cascade — so evaluateAutorunOnEntry is never even called and the kernel is never reached.
    // (A vacuous "no spawn" would also pass if the cascade ran but decideCascade happened to stop.)
    expect(decideCascadeSpy).not.toHaveBeenCalled();
    expect(runSkill).not.toHaveBeenCalled();
    // move-parity: a plain edit must NOT supersede a parked merge entry either — superseding a still-
    // valid parked integration on every body/title Save would silently drop the operator's queued work.
    expect(reconcileCardMergeEntries).not.toHaveBeenCalled();
  });

  it("the audit#4 preserve branch does NOT spawn (no spurious re-fire of an already-advanced card)", async () => {
    // The cascade advanced the card to desenvolver on disk AFTER the drawer opened on quebrar-tasks.
    // A plain Save (expectedStatus quebrar-tasks, draft status quebrar-tasks) preserves the disk status
    // → card.status (desenvolver) === prevStatus (desenvolver read from disk) → guard holds, NO spawn.
    cardOnDisk = coerceCard("story-x", { type: "story", storyType: "bug", status: "desenvolver", title: "orig", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const draft = coerceCard("story-x", { type: "story", storyType: "bug", status: "quebrar-tasks", title: "edited", tasks: [{ id: "t1", title: "t", done: false }] }, "");
    const res = await updateCardAction({ boardId: "b", card: draft, expectedStatus: "quebrar-tasks" });
    expect(res.ok).toBe(true);
    expect(cardOnDisk.status).toBe("desenvolver"); // advance preserved
    await flush();
    // PROVE THE GUARD: the preserve branch sets merged.status = prev.status, so card.status
    // (desenvolver) === prevStatus (desenvolver, read fresh from disk) → the actions-level guard
    // short-circuits BEFORE the cascade; evaluateAutorunOnEntry is never called, the kernel never
    // reached. This distinguishes "preserve correctly suppressed the re-fire" from "feature absent".
    expect(decideCascadeSpy).not.toHaveBeenCalled();
    expect(runSkill).not.toHaveBeenCalled(); // but NOT re-triggered
    // move-parity: the preserve branch is NOT a genuine status change → it must NOT supersede a
    // parked merge entry (the card never actually moved on disk; it stayed at the advanced status).
    expect(reconcileCardMergeEntries).not.toHaveBeenCalled();
  });
});
