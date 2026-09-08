import { describe, expect, it } from "vitest";
import { deriveLabel, derivePhrase } from "./enrich";
import type { RunningService } from "@/lib/vps/types";

// The HARD CONSTRAINT: not every session has a card. These pin the label + phrase priority so
// card-less sessions (shell, cop-*, agent-*, master) always degrade to something meaningful.

function svc(over: Partial<RunningService>): RunningService {
  return {
    id: "x",
    kind: "tmux-adhoc",
    label: over.label ?? "x",
    status: "idle",
    lane: "terminal",
    attachable: true,
    ...over,
  } as RunningService;
}

describe("deriveLabel — prioridade nome amigável", () => {
  it("1) o apelido do operador vence tudo", () => {
    expect(deriveLabel("agent-1", "meu apelido", svc({ label: "Terminal · story-x", board: "n", cardId: "story-x", cardTitle: "T" }), "tarefa")).toBe("meu apelido");
  });
  it("2) título do card quando há card", () => {
    expect(deriveLabel("card-acme__story-x", null, svc({ board: "acme", cardId: "story-x", cardTitle: "Comprar" }), undefined)).toBe("story-x · Comprar");
  });
  it("3) o label derivado (não-cru) quando não há card", () => {
    expect(deriveLabel("claude-jonatas", null, svc({ label: "Claude master (interativo)" }), undefined)).toBe("Claude master (interativo)");
  });
  it("4) a task da frota para um agent-* sem serviço atribuído", () => {
    expect(deriveLabel("agent-abc", null, undefined, "refatorando o guard")).toBe("Agente · refatorando o guard");
  });
  it("5) último recurso: o nome cru", () => {
    expect(deriveLabel("scratch", null, svc({ label: "scratch" }), undefined)).toBe("scratch");
    expect(deriveLabel("scratch", null, undefined, undefined)).toBe("scratch");
  });
  it("6) o `shell` cru vira um rótulo legível — a interface chama a sessão tmux de terminal", () => {
    expect(deriveLabel("shell", null, svc({ label: "shell" }), undefined)).toBe("Terminal do servidor");
    expect(deriveLabel("shell", null, undefined, undefined)).toBe("Terminal do servidor");
    // mas um apelido do operador ainda vence tudo
    expect(deriveLabel("shell", "meu shell", undefined, undefined)).toBe("meu shell");
  });
});

describe("derivePhrase — o que a sessão está fazendo", () => {
  it("pane_title intencional vence", () => {
    const r = derivePhrase("compilando o pacote", undefined, undefined, "bash", "/x", "s");
    expect(r).toEqual({ phrase: "compilando o pacote", source: "pane_title" });
  });
  it("ignora o pane_title default (= comando/hostname) e cai no detail", () => {
    const r = derivePhrase("bash", svc({ detail: "Claude vivo · 12m" }), undefined, "bash", "/x", "s");
    expect(r).toEqual({ phrase: "Claude vivo · 12m", source: "detail" });
  });
  it("sem detail, usa a task durável da frota", () => {
    const r = derivePhrase("", undefined, "abrindo o worktree", "bash", "/x", "s");
    expect(r.source).toBe("task");
    expect(r.phrase).toBe("abrindo o worktree");
  });
  it("por fim, comando + cwd curto", () => {
    const r = derivePhrase("", undefined, undefined, "bash", "/root/meu-monorepo/packages/storymap-ui", "s");
    expect(r.source).toBe("command");
    expect(r.phrase).toBe("bash · …/packages/storymap-ui");
  });
  it("nada a dizer ⇒ none", () => {
    expect(derivePhrase("", undefined, undefined, "", "", "s")).toEqual({ phrase: "", source: "none" });
  });
});
