import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUDGET_CUT_SUBTYPE,
  createNdjsonParser,
  extractFinalResult,
  extractResultUsage,
  isBudgetCutResult,
  isMaxTurnsResult,
  summarizeStreamEvent,
} from "./stream-json";
import {
  BUDGET_CUT_FINDING_ID,
  isBudgetCutEscalated,
  withBudgetCutFinding,
  withBudgetCutResolved,
} from "./findings";
import { registerRunDeathFindings, type RunDeathIo } from "./run-death";
import { RUN_OUTCOMES, diskJournalStore, type JournalEntry } from "./journal";
import { diskTelemetryStore, isSuccessWithWarning, type TelemetryRecord } from "./telemetry";
import { BUDGET_CUT_HOLD_MARKER, precheckNoop } from "./engine";
import { RUN_STATUS_LABEL_PT, runStatusLabel } from "@/lib/storymap/step-rollup";
import { isStuckCardMetric } from "@/lib/storymap/cockpit-collect";
import type { Finding } from "@/lib/storymap/types";

// O CORTE POR ORÇAMENTO como DESFECHO próprio. O CLI encerra um run no teto `--max-budget-usd` com exit 1 —
// o MESMO código de um erro genuíno —, então sem ler o subtype o engine chamaria isto de "exit" e destruiria
// a árvore. A fixture abaixo é uma GRAVAÇÃO REAL (CLI 2.1.281, 2026-09-25): `claude -p … --model haiku
// --max-budget-usd 0.001 --output-format stream-json --verbose`, dois turnos de Read, cortado entre eles; exit 1.
// Só os ids e o caminho do diretório foram trocados (o init ficou com os campos que o parser lê).
const BUDGET_CUT_FIXTURE = readFileSync(
  path.join(process.cwd(), "src/lib/storymap/runner/__fixtures__/stream-json-budget-cut.jsonl"),
  "utf8",
);
const events = BUDGET_CUT_FIXTURE.trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, unknown>);
const result = events[events.length - 1];

describe("a gravação real do corte (fixture) — o que o CLI de fato emite", () => {
  it("o evento terminal é result/error_max_budget_usd com is_error e custo preenchido", () => {
    expect(result.type).toBe("result");
    expect(result.subtype).toBe(BUDGET_CUT_SUBTYPE);
    expect(result.is_error).toBe(true);
    expect(typeof result.total_cost_usd).toBe("number");
    expect(result.total_cost_usd as number).toBeGreaterThan(0.001); // estourou: o teto é checado ENTRE turnos
  });

  it("isBudgetCutResult reconhece SÓ o evento terminal de corte (e não o confunde com max-turns)", () => {
    expect(events.filter(isBudgetCutResult)).toEqual([result]);
    expect(events.some(isMaxTurnsResult)).toBe(false);
    expect(isBudgetCutResult({ type: "result", subtype: "error_max_turns", is_error: true })).toBe(false);
    expect(isBudgetCutResult({ type: "assistant", subtype: BUDGET_CUT_SUBTYPE })).toBe(false);
    expect(isBudgetCutResult(null)).toBe(false);
  });

  it("o parser NDJSON entrega o evento mesmo fatiado em pedaços arbitrários", () => {
    const seen: unknown[] = [];
    const p = createNdjsonParser((o) => seen.push(o));
    for (let i = 0; i < BUDGET_CUT_FIXTURE.length; i += 97) p.feed(BUDGET_CUT_FIXTURE.slice(i, i + 97));
    p.flush();
    expect(seen.filter(isBudgetCutResult)).toHaveLength(1);
  });

  it("custo e subtype saem dos extratores existentes; o console diz que foi o TETO, não um bug", () => {
    expect(extractResultUsage(result)?.costUSD).toBe(result.total_cost_usd);
    expect(extractFinalResult(result)?.subtype).toBe(BUDGET_CUT_SUBTYPE);
    const line = summarizeStreamEvent(result);
    expect(line?.level).toBe("error");
    expect(line?.text).toMatch(/teto de custo/);
    expect(line?.text).toContain("$0.019");
  });
});

describe("budget-cut é um RunOutcome de primeira classe — nenhuma camada o descarta", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "ah-budget-cut-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("RUN_OUTCOMES tem budget-cut, e toda tabela exaustiva o rotula", () => {
    expect(RUN_OUTCOMES).toContain("budget-cut");
    for (const o of RUN_OUTCOMES) expect(RUN_STATUS_LABEL_PT[o], o).toBeTruthy();
    expect(runStatusLabel("budget-cut")).toMatch(/teto de custo/);
  });

  it("o journal em disco preserva um entry com outcome budget-cut (o zod não o derruba)", async () => {
    const store = diskJournalStore(tmp);
    const entry: JournalEntry = {
      board: "acme",
      cardId: "story-1",
      trigger: "harness-do",
      sessionId: "s-1",
      pid: null,
      startedAt: 1,
      status: "done",
      endedAt: 2,
      outcome: "budget-cut",
    };
    await store.persist([entry]);
    expect((await store.load()).map((e) => e.outcome)).toEqual(["budget-cut"]);
  });

  it("a telemetria em disco preserva um registro status budget-cut com o seu custo", async () => {
    const store = diskTelemetryStore(path.join(tmp, "telemetry.json"));
    const rec = {
      id: "s-1",
      board: "acme",
      cardId: "story-1",
      trigger: "harness-do",
      startedAt: 1,
      durationMs: 5064,
      turns: 2,
      inputTokens: null,
      outputTokens: null,
      costUSD: 0.0191536,
      model: "sonnet",
      effort: "high",
      status: "budget-cut",
    } as TelemetryRecord;
    await store.persist([rec]);
    const [back] = await store.load();
    expect(back.status).toBe("budget-cut");
    expect(back.costUSD).toBe(0.0191536);
  });

  it("um corte SEM avanço é travado no Inbox; um corte depois de avançar é sucesso-com-aviso", () => {
    expect(isStuckCardMetric({ lastStatus: "budget-cut", lastAdvanced: false })).toBe(true);
    expect(isStuckCardMetric({ lastStatus: "budget-cut", lastAdvanced: true })).toBe(false);
    expect(isSuccessWithWarning(false, "budget-cut")).toBe(true); // avançou ⇒ o engine suprimiu a falha
    expect(isSuccessWithWarning(true, "budget-cut")).toBe(false); // falha real
  });
});

describe("o finding do corte — idempotente por run, escalado no SEGUNDO corte seguido", () => {
  const facts = (runId: string) => ({ trigger: "harness-do", runId, capUSD: 23.8, costUSD: 24.31 });

  it("o PRIMEIRO corte pede para fatiar/re-planejar, severidade medium (nunca blocker)", () => {
    const out = withBudgetCutFinding([], facts("run-a"))!;
    const f = out.find((x) => x.id === BUDGET_CUT_FINDING_ID)!;
    expect(f.severity).toBe("medium");
    expect(f.status).toBe("open");
    expect(f.title).toMatch(/fatie ou re-planeje/);
    expect(f.detail).toContain("$23.80");
    expect(f.detail).toContain("$24.31");
    expect(isBudgetCutEscalated(out)).toBe(false);
  });

  it("o MESMO run carimbado de novo é no-op (null) — um settle duplicado nunca vira escalada", () => {
    const once = withBudgetCutFinding([], facts("run-a"))!;
    expect(withBudgetCutFinding(once, facts("run-a"))).toBeNull();
  });

  it("um SEGUNDO corte (outro run) com o finding ainda aberto escala para high e para o humano", () => {
    const once = withBudgetCutFinding([], facts("run-a"))!;
    const twice = withBudgetCutFinding(once, facts("run-b"))!;
    expect(twice.filter((x) => x.id === BUDGET_CUT_FINDING_ID)).toHaveLength(1); // refresca, não empilha
    const f = twice.find((x) => x.id === BUDGET_CUT_FINDING_ID)!;
    expect(f.severity).toBe("high");
    expect(f.detail).toMatch(/NÃO vai re-disparar/);
    expect(isBudgetCutEscalated(twice)).toBe(true);
  });

  it("um finding TRIADO (fixed/wontfix/acknowledged) recomeça a contagem: o próximo corte é o primeiro", () => {
    const escalated = withBudgetCutFinding(withBudgetCutFinding([], facts("run-a"))!, facts("run-b"))!;
    for (const status of ["fixed", "wontfix", "acknowledged"] as const) {
      const triaged: Finding[] = escalated.map((f) => (f.id === BUDGET_CUT_FINDING_ID ? { ...f, status } : f));
      expect(isBudgetCutEscalated(triaged), status).toBe(false);
      const again = withBudgetCutFinding(triaged, facts("run-c"))!;
      expect(again.find((x) => x.id === BUDGET_CUT_FINDING_ID)!.severity, status).toBe("medium");
    }
  });

  it("recuperação flipa open→fixed com autoria; nada aberto ⇒ null (sem escrita)", () => {
    const open = withBudgetCutFinding([], facts("run-a"))!;
    const fixed = withBudgetCutResolved(open, { by: "run:recovered", at: "2026-09-25" })!;
    const f = fixed.find((x) => x.id === BUDGET_CUT_FINDING_ID)!;
    expect(f.status).toBe("fixed");
    expect(f.statusBy).toBe("run:recovered");
    expect(withBudgetCutResolved(fixed)).toBeNull();
    expect(withBudgetCutResolved([])).toBeNull();
  });
});

describe("precheckNoop — o terceiro run de um card cortado duas vezes é RETIDO ($0, sem processo)", () => {
  it("escalado ⇒ no-op com o marcador, para autorun E manual (o run_skill do copiloto chega como manual)", () => {
    for (const origin of ["autorun", "manual"] as const) {
      const r = precheckNoop({ trigger: "harness-do", origin, budgetCutEscalated: true });
      expect(r.noop, origin).toBe(true);
      expect(r.reason).toContain(BUDGET_CUT_HOLD_MARKER);
    }
  });

  it("não escalado ⇒ segue (o primeiro corte ainda admite uma nova tentativa)", () => {
    expect(precheckNoop({ trigger: "harness-do", origin: "autorun", budgetCutEscalated: false }).noop).toBe(false);
    expect(precheckNoop({ trigger: "harness-do", origin: "autorun" }).noop).toBe(false);
  });

  it("um conflict-redrive não é retido (ele re-integra um branch; nunca é pre-checado)", () => {
    expect(precheckNoop({ trigger: "harness-do", origin: "conflict-redrive", budgetCutEscalated: true }).noop).toBe(false);
  });

  it("a RETENÇÃO não é evidência de 'nada a fazer' — o Caso 1 a ignora (senão travaria o card para sempre)", () => {
    const r = precheckNoop({
      trigger: "harness-do",
      origin: "autorun",
      budgetCutEscalated: false,
      lastRunOfTrigger: { status: "no-op", startedAt: 1_000, summary: `pre-check no-op: ${BUDGET_CUT_HOLD_MARKER}: …` },
      cardMtimeMs: 500, // o .md não mudou desde a retenção
    });
    expect(r.noop).toBe(false);
  });
});

describe("registerRunDeathFindings — o corte tem o SEU diagnóstico; só recuperação real zera a contagem", () => {
  function harness(failures: ReturnType<RunDeathIo["failures"]>) {
    const calls: string[] = [];
    let onComplete!: (ev: { board: string; cardId: string; outcome?: string }) => void;
    let onMergeDone!: (ev: { board: string; cardId: string }) => void;
    registerRunDeathFindings(
      { onComplete: (fn) => ((onComplete = fn), () => {}) },
      { onMergeDone: (fn) => ((onMergeDone = fn), () => {}) },
      {
        failures: () => failures,
        stamp: (_b, _c, reason) => void calls.push(`stamp:${reason}`),
        clearDeath: () => void calls.push("clearDeath"),
        clearBudgetCut: () => void calls.push("clearBudgetCut"),
      },
    );
    return { calls, complete: (outcome?: string) => onComplete({ board: "acme", cardId: "story-1", outcome }), merged: () => onMergeDone({ board: "acme", cardId: "story-1" }) };
  }

  it("um corte NÃO carimba 'run morreu' por cima do finding budget-cut (um fato, um alarme)", () => {
    const h = harness([{ board: "acme", cardId: "story-1", reason: "budget-cut", detail: "cortado" }]);
    h.complete("budget-cut");
    expect(h.calls).toEqual([]);
  });

  it("um sucesso limpa os dois; cancelamento e max-turns NÃO zeram a contagem de cortes", () => {
    const h = harness([]);
    h.complete("ok");
    expect(h.calls).toEqual(["clearDeath", "clearBudgetCut"]);
    h.calls.length = 0;
    h.complete("cancelled");
    expect(h.calls).toEqual(["clearDeath"]);
    h.calls.length = 0;
    h.complete("max-turns");
    expect(h.calls).toEqual(["clearDeath"]);
  });

  it("um merge-back (o trabalho integrou) limpa os dois; outras mortes seguem carimbando", () => {
    const h = harness([]);
    h.merged();
    expect(h.calls).toEqual(["clearDeath", "clearBudgetCut"]);
    const d = harness([{ board: "acme", cardId: "story-1", reason: "exit", detail: "exit 1" }]);
    d.complete("exit");
    expect(d.calls).toEqual(["stamp:exit"]);
  });
});
