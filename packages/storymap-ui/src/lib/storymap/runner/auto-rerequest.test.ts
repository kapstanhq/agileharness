// O pedido de autorização do dono que a main deixou velho é refeito pelo sistema (auto-rerequest.ts) — o botão
// «Refazer o pedido agora» (o botão do Inbox; antes, o da Esteira) vira saída de emergência, não o caminho normal.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerApprovalRequest } from "./deploy-proof";
import { freshApprovals, markApprovalsStale, markRerequested, touchDeployBlock, type DeployBlockRow } from "./deploy-blocks";
import {
  autoRerequestStale,
  claimWindow,
  isStaleRequest,
  nudgeAutoRerequest,
  ownerItemRemains,
  resetAutoRerequestForTest,
  resetNudgeForTest,
  rowsToCheck,
  safeDiffArgs,
  type AutoRerequestDeps,
  type PublisherFacts,
} from "./auto-rerequest";
import { authorizeOwnerPublish, type OwnerApprovalDeps } from "./owner-approval";

const OLD = "a".repeat(40);
const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const req = (c: string, files: string[]): OwnerApprovalRequest => ({
  subject: { kind: "diff", hash: hash(c), base: "b".repeat(40), head: OLD, files },
  record: "relay sign {file}",
  units: ["api"],
  rules: ["till-guard"],
});
const row = (over: Partial<DeployBlockRow> = {}): DeployBlockRow => ({
  board: "estufa",
  causeKey: "estufa:owner:money",
  pkg: "estufa",
  phase: "needs-human",
  decider: "owner",
  ownerClass: "money",
  units: ["api"],
  rules: ["till-guard"],
  command: null,
  firstAt: "2026-11-02T10:00:00.000Z",
  lastAt: "2026-11-02T10:00:00.000Z",
  cardIds: ["story-ex7101"],
  planHead: OLD,
  attributedCard: "story-ex7101",
  approvals: [req("1", ["till/charge.ts"])],
  ...over,
});

interface World {
  rows: DeployBlockRow[];
  changed: Record<string, string[] | null>;
  facts: PublisherFacts | null;
  publisher: string | null;
}

function harness(w: World, over: Partial<AutoRerequestDeps> = {}) {
  const measured: Array<{ board: string; planOnly: boolean }> = [];
  const marked: Array<{ board: string; keys: string[]; hashes: string[] }> = [];
  const staleMarked: Array<{ board: string; keys: string[]; drop: string[] }> = [];
  const tried = new Set<string>();
  const deps: AutoRerequestDeps = {
    readRows: async () => w.rows,
    changedSince: async (head, files) => {
      const c = w.changed[head];
      return c === undefined ? [] : c === null ? null : c.filter((f) => files.includes(f));
    },
    publisherOf: async () => (w.publisher ? { board: w.publisher } : null),
    publisherFacts: async () => w.facts,
    markStale: async (board, keys, hashes) => {
      marked.push({ board, keys, hashes });
      w.rows = markApprovalsStale(w.rows, board, keys, hashes);
    },
    mark: async (board, keys, at, drop) => {
      staleMarked.push({ board, keys, drop });
      w.rows = markRerequested(w.rows, board, keys, at, drop);
    },
    unmark: async (board, keys) => {
      w.rows = markRerequested(w.rows, board, keys, null, []);
    },
    measure: async (board, opts) => {
      measured.push({ board, planOnly: !!opts?.planOnly });
      return { ok: true, via: opts?.planOnly ? "plan" : "deploy" };
    },
    now: () => NOW,
    everyMs: 15 * 60_000,
    claim: () => true,
    tried,
    ...over,
  };
  return { deps, measured, marked, staleMarked, tried };
}

const PLAN: PublisherFacts = { organizeOnly: false, held: false, hasPlan: true };
const NO_PLAN: PublisherFacts = { organizeOnly: false, held: false, hasPlan: false };

afterEach(() => {
  resetAutoRerequestForTest();
  resetNudgeForTest();
  vi.useRealTimers();
});

describe("o pedido velho, sem rodar deploy", () => {
  it("é velho quando algum arquivo do assunto mudou na main desde o head do pedido", () => {
    const a = req("1", ["till/charge.ts", "till/refund.ts"]);
    expect(isStaleRequest(a, ["till/refund.ts"])).toBe(true);
    expect(isStaleRequest(a, ["garden/beds.ts"])).toBe(false);
    expect(isStaleRequest(a, [])).toBe(false);
    // não dá para saber ⇒ não é velho (na dúvida, nada se mexe)
    expect(isStaleRequest(a, null)).toBe(false);
  });

  it("olha só a causa do dono parada pedindo alguém, com pedidos, e que não está refazendo", () => {
    const rerequesting = row({ causeKey: "k2", rerequestedAt: new Date(NOW - 60_000).toISOString() });
    const expired = row({ causeKey: "k3", rerequestedAt: new Date(NOW - 2 * 60 * 60_000).toISOString() });
    const rows = [row(), row({ causeKey: "k1", decider: "system" }), rerequesting, expired, row({ causeKey: "k4", approvals: undefined }), row({ causeKey: "k5", phase: "needs-proof" })];
    expect(rowsToCheck(rows, NOW).map((r) => r.causeKey)).toEqual(["estufa:owner:money", "k3"]);
  });

  it("os argumentos do git: só sha e caminhos relativos sem `..` nem cara de opção — o resto não vira argumento", () => {
    expect(safeDiffArgs(OLD, ["till/charge.ts"])).toEqual(["diff", "--name-only", OLD, "main", "--", "till/charge.ts"]);
    expect(safeDiffArgs("main", ["x.ts"])).toBeNull();
    expect(safeDiffArgs(OLD, ["--output=/tmp/x"])).toBeNull();
    expect(safeDiffArgs(OLD, ["../fora.ts"])).toBeNull();
    expect(safeDiffArgs(OLD, ["/abs.ts"])).toBeNull();
    expect(safeDiffArgs(OLD, ["a\nb"])).toBeNull();
    expect(safeDiffArgs(OLD, [])).toBeNull();
  });
});

describe("a re-medição automática", () => {
  it("pedido velho + board com plano ⇒ refaz PELO PLANO (só lê), marca «refazendo o pedido…» e tira o velho do botão", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: PLAN, publisher: "estufa" };
    const h = harness(w);
    const r = await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([{ board: "estufa", planOnly: true }]);
    expect(h.staleMarked).toEqual([{ board: "estufa", keys: ["estufa:owner:money"], drop: [hash("1")] }]);
    expect(w.rows[0].rerequestedAt).toBeTruthy();
    expect(w.rows[0].approvals).toBeUndefined();
    expect(r.actions[0]).toMatchObject({ kind: "rerequested", outcome: { ok: true, via: "plan" } });
  });

  it("pedido que ainda vale (nenhum arquivo do assunto mudou) ⇒ nada roda", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["garden/beds.ts"] }, facts: PLAN, publisher: "estufa" };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([]);
    expect(h.marked).toEqual([]);
  });

  it("DEBOUNCE: no máximo uma re-medição por pacote na janela", async () => {
    const claim = claimWindow(15 * 60_000);
    let now = NOW;
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: PLAN, publisher: "estufa" };
    const h = harness(w, { claim, now: () => now, tried: { has: () => false, add: () => {} } });
    await autoRerequestStale(h.deps);
    // o pedido voltou (outra causa velha do mesmo pacote) dentro da janela: não re-mede
    w.rows = [row({ causeKey: "estufa:owner:other" })];
    now += 5 * 60_000;
    const second = await autoRerequestStale(h.deps);
    expect(second.actions[0]).toMatchObject({ kind: "skipped", why: "debounced" });
    now += 11 * 60_000;
    await autoRerequestStale(h.deps);
    expect(h.measured).toHaveLength(2);
  });

  it("um pedido é refeito sozinho no máximo UMA vez: se o plano devolve o mesmo hash, ele vale para o alvo (sem laço)", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: PLAN, publisher: "estufa" };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    w.rows = [row()]; // o plano re-listou o MESMO pedido
    await autoRerequestStale(h.deps);
    expect(h.measured).toHaveLength(1);
  });

  it("desligada (`everyMs` 0) ⇒ nada lê nem roda", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: PLAN, publisher: "estufa" };
    const h = harness(w, { everyMs: 0 });
    const r = await autoRerequestStale(h.deps);
    expect(r).toEqual({ checked: 0, actions: [] });
    expect(h.measured).toEqual([]);
  });

  it("board SÓ DE ORGANIZAÇÃO ⇒ nada: nem medir, nem marcar", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: { ...PLAN, organizeOnly: true }, publisher: "estufa" };
    const h = harness(w);
    const r = await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([]);
    expect(h.marked).toEqual([]);
    expect(w.rows[0].staleApprovals).toBeUndefined();
    expect(r.actions[0]).toMatchObject({ kind: "skipped", why: "organize-only" });
  });

  it("board PAUSADO com plano ⇒ ainda re-mede pelo plano (medir não é trabalho novo e não publica)", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: { ...PLAN, held: true }, publisher: "estufa" };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([{ board: "estufa", planOnly: true }]);
  });
});

describe("nunca publicar por efeito colateral da re-medição", () => {
  it("sem plano e SEM outro pedido do dono que ainda valha ⇒ o deploy sem card não roda; os velhos ficam marcados (use Refazer)", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: NO_PLAN, publisher: "estufa" };
    const h = harness(w);
    const r = await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([]);
    expect(w.rows[0].staleApprovals).toEqual([hash("1")]);
    expect(r.actions[0]).toMatchObject({ kind: "marked-stale", board: "estufa" });
  });

  it("sem plano, com um pedido do dono que ainda vale no pacote ⇒ o deploy sem card refaz (ele para nesse pedido)", async () => {
    const both = row({ approvals: [req("1", ["till/charge.ts"]), req("2", ["till/ledger.ts"])] });
    const w: World = { rows: [both], changed: { [OLD]: ["till/charge.ts"] }, facts: NO_PLAN, publisher: "estufa" };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([{ board: "estufa", planOnly: false }]);
  });

  it("sem plano e board PAUSADO ⇒ nenhum deploy, mesmo com pedido que ainda vale", async () => {
    const both = row({ approvals: [req("1", ["till/charge.ts"]), req("2", ["till/ledger.ts"])] });
    const w: World = { rows: [both], changed: { [OLD]: ["till/charge.ts"] }, facts: { ...NO_PLAN, held: true }, publisher: "estufa" };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([]);
    expect(w.rows[0].staleApprovals).toEqual([hash("1")]);
  });

  it("o pedido que o dono já autorizou não conta como item restante", () => {
    const r1 = row({ approvals: [req("1", ["a.ts"]), req("2", ["b.ts"])], granted: [hash("2")] });
    expect(ownerItemRemains([r1], "estufa", new Set([hash("1")]))).toBe(false);
    expect(ownerItemRemains([r1], "estufa", new Set())).toBe(true);
    expect(ownerItemRemains([row({ approvals: [req("2", ["b.ts"])], staleApprovals: [hash("2")] })], "estufa", new Set())).toBe(false);
  });

  it("sem board que publique o pacote ⇒ só marca", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: null, publisher: null };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    expect(h.measured).toEqual([]);
    expect(w.rows[0].staleApprovals).toEqual([hash("1")]);
  });

  it("a marca é idempotente: a segunda passada não regrava", async () => {
    const w: World = { rows: [row()], changed: { [OLD]: ["till/charge.ts"] }, facts: NO_PLAN, publisher: "estufa" };
    const h = harness(w);
    await autoRerequestStale(h.deps);
    await autoRerequestStale(h.deps);
    expect(h.marked).toHaveLength(1);
  });
});

describe("o livro e o botão", () => {
  it("o pedido marcado velho não é um pedido que vale; o plano relido apaga a marca", () => {
    const r = row({ approvals: [req("1", ["a.ts"]), req("2", ["b.ts"])] });
    const [marked] = markApprovalsStale([r], "estufa", ["estufa:owner:money"], [hash("1"), hash("9")]);
    expect(marked.staleApprovals).toEqual([hash("1")]);
    expect(freshApprovals(marked).map((a) => a.subject.hash)).toEqual([hash("2")]);
    const cause = { pkg: "estufa", phase: "needs-human" as const, units: ["api"], rules: ["till-guard"], ownerClass: "money", decider: "owner" as const, causeKey: "estufa:owner:money" };
    const [touched] = touchDeployBlock([marked], "estufa", cause, "2026-11-03T10:05:00.000Z", [req("3", ["a.ts"])]);
    expect(touched.staleApprovals).toBeUndefined();
    expect(freshApprovals(touched).map((a) => a.subject.hash)).toEqual([hash("3")]);
  });

  it("o clique em «Autorizar» nunca grava um pedido que o sistema já sabe velho", async () => {
    const r = row({ approvals: [req("1", ["a.ts"])], staleApprovals: [hash("1")] });
    const recorded: string[] = [];
    const deps: OwnerApprovalDeps = {
      readRow: async () => r,
      record: async (a) => {
        recorded.push(a.subject.hash);
        return { ok: true };
      },
      grant: async () => {},
      republish: async () => ({ ok: true }),
      rerequest: async () => ({ ok: true, board: "estufa", via: "plan" }),
      now: () => NOW,
    };
    const out = await authorizeOwnerPublish(deps, { board: "estufa", causeKey: "estufa:owner:money" });
    expect(recorded).toEqual([]);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain("Refazer o pedido agora"); // a alavanca do próprio item do Inbox (a Esteira saiu na fase 3)
  });
});

describe("o aviso «a main andou»", () => {
  it("vários avisos dentro da espera viram UMA passada", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    nudgeAutoRerequest(run, 1_000);
    nudgeAutoRerequest(run, 1_000);
    nudgeAutoRerequest(run, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(run).toHaveBeenCalledTimes(1);
    nudgeAutoRerequest(run, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
