import { describe, expect, it } from "vitest";
import { projectDestinations, relativeTime, type CardLike, type SessionLike } from "./destinations";

const NOW = 1_000_000_000_000;
const mins = (n: number) => NOW - n * 60_000;

const cards: CardLike[] = [
  { id: "story-old", title: "Antigo", updatedMs: mins(120) },
  { id: "story-new", title: "Novo", updatedMs: mins(2) },
  { id: "cap-1", title: "Container", updatedMs: mins(1), capture: true },
  { id: "story-mid", title: "Meio", updatedMs: mins(30) },
  { id: "story-done", title: "Concluído", updatedMs: mins(1), terminal: true }, // terminal → dropped
];

const sessions: SessionLike[] = [
  // A running worker agent is kill-`protected` (class-4) but NOT the master → a valid paste target.
  { name: "agent-a", label: "story-a · Faz A", status: "running", createdAt: mins(10), master: false, card: { board: "storymap", cardId: "story-a", title: "Faz A" } },
  // The MASTER orchestrator (`claude*`) — the ONLY excluded class.
  { name: "claude-jonatas", label: "orquestrador", status: "running", createdAt: mins(300), master: true, card: null },
  // The durable infra shell — the operator's own interactive session usually lives here → INCLUDED.
  { name: "shell", label: "Terminal do servidor", status: "idle", createdAt: mins(20), master: false, card: null },
  { name: "agent-acme", label: "nk-1 · Nest thing", status: "idle", createdAt: mins(45), master: false, card: { board: "acme", cardId: "nk-1", title: "Nest thing" } },
];

describe("projectDestinations — the picker's minimal, board-pinned catalog", () => {
  it("cards: recents-first, capture containers excluded, title||id label", () => {
    const opts = projectDestinations({ board: "storymap", cards, sessions: [], sessionEnabled: false, now: NOW });
    const cardOpts = opts.filter((o) => o.kind === "card");
    expect(cardOpts.map((o) => o.id)).toEqual(["story-new", "story-mid", "story-old"]); // desc, no cap-1/terminal
    expect(cardOpts[0].label).toBe("Novo");
  });

  it("cards: TERMINAL cards (done/archived) are excluded — you can't refine a closed card", () => {
    const opts = projectDestinations({ board: "storymap", cards, sessions: [], sessionEnabled: false, now: NOW });
    const ids = opts.filter((o) => o.kind === "card").map((o) => o.id);
    expect(ids).not.toContain("story-done"); // terminal
    expect(ids).toContain("story-new");      // active cards still listed
  });

  it("cards: caps at cardLimit", () => {
    const many: CardLike[] = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, title: `t${i}`, updatedMs: NOW - i }));
    const opts = projectDestinations({ board: "storymap", cards: many, sessions: [], sessionEnabled: false, now: NOW, cardLimit: 5 });
    expect(opts.filter((o) => o.kind === "session")).toHaveLength(0);
    expect(opts).toHaveLength(5);
  });

  it("sessions omitted entirely when the terminal round-trip is disabled", () => {
    const opts = projectDestinations({ board: "storymap", cards: [], sessions, sessionEnabled: false, now: NOW });
    expect(opts.filter((o) => o.kind === "session")).toHaveLength(0);
  });

  it("sessions: enabled → lists worker agents AND the infra shell (operator's own); DROPS only the MASTER", () => {
    const opts = projectDestinations({ board: "storymap", cards: [], sessions, sessionEnabled: true, now: NOW });
    const s = opts.filter((o) => o.kind === "session");
    // shell is INCLUDED (operator's own interactive session); agent-a kept though kill-protected; only claude-jonatas (master) dropped.
    expect(s.map((o) => o.id).sort()).toEqual(["agent-a", "agent-acme", "shell"]);
  });

  it("a session shows the name the operator recognises; only a FOREIGN board's card title is redacted", () => {
    const opts = projectDestinations({ board: "storymap", cards: [], sessions, sessionEnabled: true, now: NOW });
    const own = opts.find((o) => o.id === "agent-a");
    const foreign = opts.find((o) => o.id === "agent-acme");
    const cardless = opts.find((o) => o.id === "shell");
    expect(own?.label).toBe("story-a · Faz A");           // card on THIS board → descriptive label kept
    expect(foreign?.label).toBe("nk-1 · (outro board)");  // foreign card → title still redacted
    expect(foreign?.label).not.toContain("Nest thing");
    // A card-less session is what a fleet terminal usually IS; its descriptive name is the only thing
    // that tells two terminals apart, so it is shown (the bare tmux name told the operator nothing).
    expect(cardless?.label).toBe("Terminal do servidor");
  });

  it("the tmux name rides in the sublabel whenever the label no longer shows it", () => {
    const opts = projectDestinations({ board: "storymap", cards: [], sessions, sessionEnabled: true, now: NOW });
    // routing identity is never lost: the id IS the tmux name, and the sublabel names it too
    expect(opts.find((o) => o.id === "shell")?.sublabel).toBe("shell · há 20min");
    expect(opts.find((o) => o.id === "agent-a")?.sublabel).toBe("agent-a · trabalhando agora");
  });

  it("busy flag + sublabel: running → 'trabalhando agora'; idle → relative created time", () => {
    const opts = projectDestinations({ board: "storymap", cards: [], sessions, sessionEnabled: true, now: NOW });
    const running = opts.find((o) => o.id === "agent-a");
    const idle = opts.find((o) => o.id === "agent-acme");
    expect(running?.busy).toBe(true);
    expect(running?.sublabel).toContain("trabalhando agora");
    expect(idle?.busy).toBe(false);
    expect(idle?.sublabel).toContain("há 45min");
  });

  it("the projection NEVER carries ops-intel — only {kind,id,label,sublabel?,busy?}", () => {
    const opts = projectDestinations({ board: "storymap", cards, sessions, sessionEnabled: true, now: NOW });
    const allowed = new Set(["kind", "id", "label", "sublabel", "busy"]);
    for (const o of opts) {
      for (const k of Object.keys(o)) expect(allowed.has(k)).toBe(true);
    }
  });
});

describe("relativeTime buckets", () => {
  it("formats seconds/minutes/hours/days and guards junk", () => {
    expect(relativeTime(NOW, NOW - 30_000)).toBe("agora");
    expect(relativeTime(NOW, mins(5))).toBe("há 5min");
    expect(relativeTime(NOW, NOW - 3 * 3_600_000)).toBe("há 3h");
    expect(relativeTime(NOW, NOW - 2 * 86_400_000)).toBe("há 2d");
    expect(relativeTime(NOW, null)).toBe("");
    expect(relativeTime(NOW, NOW + 5000)).toBe(""); // future → junk, empty
  });
});
