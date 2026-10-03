// session-cost — the conductor's spend, estimated from its transcripts. The three facts in the module header
// are each pinned here, because each one silently mis-bills when it is "simplified" away.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  accumulateTranscriptUsage,
  estimateSessionCost,
  priceFor,
  projectDirForCwd,
  readWorktreeSessionCost,
  usageByModel,
} from "./session-cost";

const rec = (o: {
  id?: string;
  model?: string;
  input?: number;
  output?: number;
  read?: number;
  w5?: number;
  w1h?: number;
  write?: number;
  sidechain?: boolean;
  type?: string;
}) =>
  JSON.stringify({
    type: o.type ?? "assistant",
    isSidechain: o.sidechain ?? false,
    requestId: "req",
    message: {
      id: o.id ?? "msg_1",
      model: o.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.read ?? 0,
        cache_creation_input_tokens: o.write ?? (o.w5 ?? 0) + (o.w1h ?? 0),
        ...(o.w5 != null || o.w1h != null ? { cache_creation: { ephemeral_5m_input_tokens: o.w5 ?? 0, ephemeral_1h_input_tokens: o.w1h ?? 0 } } : {}),
      },
    },
  });

describe("priceFor — a tabela embutida (datada) e o fallback por família", () => {
  it("o prefixo mais longo vence (opus-5-5 ≠ opus-5)", () => {
    expect(priceFor("claude-opus-5-5")?.price.input).toBe(4);
    expect(priceFor("claude-opus-5")?.price.input).toBe(5);
    expect(priceFor("claude-sonnet-4-5-20250929")?.price).toMatchObject({ input: 3, output: 15 });
  });

  it("um id desconhecido de família conhecida é APROXIMADO; sem família, sem preço (null, nunca 0)", () => {
    expect(priceFor("claude-opus-9-1")).toMatchObject({ approximate: true });
    expect(priceFor("gpt-x")).toBeNull();
    expect(priceFor(null)).toBeNull();
  });
});

describe("accumulateTranscriptUsage — cada requisição conta UMA vez", () => {
  it("FATO 1: N registros do MESMO message.id (N blocos) não multiplicam o custo", () => {
    const text = [rec({ id: "m1", input: 10, output: 100 }), rec({ id: "m1", input: 10, output: 100 }), rec({ id: "m1", input: 10, output: 100 })].join("\n");
    const u = usageByModel(accumulateTranscriptUsage(text)).get("claude-opus-4-8")!;
    expect(u).toMatchObject({ input: 10, output: 100, requests: 1 });
  });

  it("um snapshot parcial seguido do final fica com o MÁXIMO (nunca subconta nem soma os dois)", () => {
    const text = [rec({ id: "m1", output: 5 }), rec({ id: "m1", output: 250 })].join("\n");
    expect(usageByModel(accumulateTranscriptUsage(text)).get("claude-opus-4-8")!.output).toBe(250);
  });

  it("FATO 2: sub-agentes (isSidechain) ENTRAM na conta — têm janela própria, não carteira própria", () => {
    const text = [rec({ id: "m1", output: 100 }), rec({ id: "m2", output: 50, sidechain: true })].join("\n");
    expect(usageByModel(accumulateTranscriptUsage(text)).get("claude-opus-4-8")!.output).toBe(150);
  });

  it("FATO 3: o split 5m/1h do cache write é respeitado; sem split, tudo no 5m (o lado barato)", () => {
    const split = usageByModel(accumulateTranscriptUsage(rec({ id: "a", w5: 100, w1h: 1000 }))).get("claude-opus-4-8")!;
    expect(split).toMatchObject({ cacheWrite5m: 100, cacheWrite1h: 1000 });
    const flat = usageByModel(accumulateTranscriptUsage(rec({ id: "b", write: 500 }))).get("claude-opus-4-8")!;
    expect(flat).toMatchObject({ cacheWrite5m: 500, cacheWrite1h: 0 });
  });

  it("ignora não-assistant, <synthetic> e linhas truncadas", () => {
    const text = [rec({ id: "u", type: "user", input: 999 }), rec({ id: "s", model: "<synthetic>", input: 999 }), '{"type":"assistant","mess', rec({ id: "ok", input: 1 })].join("\n");
    const byModel = usageByModel(accumulateTranscriptUsage(text));
    expect([...byModel.keys()]).toEqual(["claude-opus-4-8"]);
    expect(byModel.get("claude-opus-4-8")!.requests).toBe(1);
  });
});

describe("estimateSessionCost — o preço", () => {
  it("soma input/output/cache read/writes com os multiplicadores (0.1× / 1.25× / 2×)", () => {
    // opus-4-8: $5 in, $25 out. 1M de cada categoria ⇒ 5 + 25 + 0.5 + 6.25 + 10 = 46.75
    const u = usageByModel(
      accumulateTranscriptUsage(rec({ input: 1_000_000, output: 1_000_000, read: 1_000_000, w5: 1_000_000, w1h: 1_000_000 })),
    );
    const est = estimateSessionCost(u);
    expect(est.costUSD).toBeCloseTo(46.75, 4);
    expect(est.approximate).toBe(false);
    expect(est.inputTokens).toBe(4_000_000);
    expect(est.outputTokens).toBe(1_000_000);
  });

  it("modelo sem preço: custo null (não 0) e marcado aproximado", () => {
    const est = estimateSessionCost(usageByModel(accumulateTranscriptUsage(rec({ model: "mystery-1", input: 10 }))));
    expect(est.costUSD).toBeNull();
    expect(est.unpricedModels).toEqual(["mystery-1"]);
    expect(est.approximate).toBe(true);
  });
});

describe("readWorktreeSessionCost — a ÁRVORE da sessão é a régua (todos os processos + sub-agentes)", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("soma os transcripts do diretório de projeto do worktree (inclui um processo reciclado) e os sub-agentes", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "session-cost-"));
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const cwd = "/repo/.worktrees/agent-1234";
      const dir = projectDirForCwd(cwd, home);
      expect(dir).toBe(path.join(home, ".claude", "projects", "-repo--worktrees-agent-1234"));
      mkdirSync(path.join(dir, "proc-a", "subagents"), { recursive: true });
      writeFileSync(path.join(dir, "proc-a.jsonl"), rec({ id: "a1", output: 100 }));
      writeFileSync(path.join(dir, "proc-b.jsonl"), rec({ id: "b1", output: 50 })); // o processo pós-reciclagem
      writeFileSync(path.join(dir, "proc-a", "subagents", "agent-x.jsonl"), rec({ id: "s1", output: 25 }));
      const est = await readWorktreeSessionCost(cwd, home);
      expect(est?.outputTokens).toBe(175);
      expect(est?.requests).toBe(3);
      // …e OUTRO worktree não entra (o anti-padrão "o transcript mais novo" atribuiria errado).
      const other = projectDirForCwd("/repo/.worktrees/agent-9999", home);
      mkdirSync(other, { recursive: true });
      writeFileSync(path.join(other, "z.jsonl"), rec({ id: "z", output: 9999 }));
      expect((await readWorktreeSessionCost(cwd, home))?.outputTokens).toBe(175);
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("sem diretório/transcripts: null (nada a registrar — nunca um 0 fabricado)", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "session-cost-"));
    expect(await readWorktreeSessionCost("/nao/existe", home)).toBeNull();
    expect(await readWorktreeSessionCost(null)).toBeNull();
  });
});
