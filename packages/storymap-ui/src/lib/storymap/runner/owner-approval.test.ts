// «Autorizar publicar» — do pedido que o plano de publicação traz até o sim do dono gravado (owner-approval.ts).
// O caso que este módulo conserta: o plano parava por uma regra de dinheiro do alvo, o dono já tinha aprovado a
// entrega do card, e não existia tela onde dizer ESTE sim — o Inbox dizia «Ninguém resolve daqui» e a publicação do
// board inteiro esperava atrás de um card.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DeployCause } from "@/lib/storymap/types";
import { OWNER_APPROVAL_PLACEHOLDER, OWNER_APPROVAL_SCHEMA, buildOwnerApproval, ownerApprovalRequestsOf, parseDeployExit3Report, type OwnerApprovalRequest } from "./deploy-proof";
import { approvalsForCause, backfillDeployApprovals, grantDeployApprovals, mutateDeployBlocks, readDeployBlocks, touchDeployBlock, upsertDeployBlock, type DeployBlockRow } from "./deploy-blocks";
import { approvalRefusedAsStale, authorizeOwnerPublish, type OwnerApprovalDeps, type RecordOutcome } from "./owner-approval";

const HEAD = "f".repeat(40);
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const subject = (c: string, files: string[]) => ({ kind: "diff" as const, hash: hash(c), base: "abc1234", head: HEAD, files });
const RECORD = `node tools/sign-off.mjs ${OWNER_APPROVAL_PLACEHOLDER}`;
const request = (c: string, files: string[], units: string[]): OwnerApprovalRequest => ({ subject: subject(c, files), record: RECORD, units, rules: ["ledger-guard"] });

const MONEY: DeployCause = { pkg: "shop", phase: "needs-human", units: ["api"], rules: ["ledger-guard"], ownerClass: "money", decider: "owner", causeKey: "shop:owner:money", headSha: HEAD };
const SYSTEM: DeployCause = { pkg: "shop", phase: "needs-human", units: ["job"], rules: ["unit-manual-only"], ownerClass: null, decider: "system", causeKey: "shop:system" };
const AT = "2026-10-02T12:00:00.000Z";

describe("o pedido de autorização, lido do plano", () => {
  const planLine = (human: unknown[]) => JSON.stringify({ status: "needs-human", head: HEAD, plan: { status: "needs-human", human } });

  it("as entradas de dinheiro trazem `ownerApproval`; um pedido por MUDANÇA (hash), com as unidades e as regras somadas", () => {
    const a = { subject: subject("a", ["pay/a.ts", "pay/b.ts"]), record: RECORD };
    const b = { subject: subject("b", ["fn/c.ts"]), record: RECORD };
    const report = parseDeployExit3Report(
      planLine([
        { unit: "api", file: "pay/a.ts", rule: "ledger-guard", ownerApproval: a },
        { unit: "api", file: "pay/b.ts", rule: "ledger-module", ownerApproval: a },
        { unit: "job", file: null, rule: "unit-manual-only" },
        { unit: "functions", file: "fn/c.ts", rule: "unit-outside-scope", owner: true, ownerApproval: b },
      ]),
    );
    expect(report.ownerApprovals).toEqual([
      { subject: a.subject, record: RECORD, units: ["api"], rules: ["ledger-guard", "ledger-module"] },
      { subject: b.subject, record: RECORD, units: ["functions"], rules: ["unit-outside-scope"] },
    ]);
  });

  it("pedido que não amarra a uma mudança exata não vira botão: sem hash válido, sem base/head, sem arquivos ou sem comando", () => {
    const ok = subject("a", ["x.ts"]);
    expect(ownerApprovalRequestsOf([{ ownerApproval: { subject: { ...ok, hash: "sha256:curto" }, record: RECORD } }])).toEqual([]);
    expect(ownerApprovalRequestsOf([{ ownerApproval: { subject: { ...ok, base: undefined }, record: RECORD } }])).toEqual([]);
    expect(ownerApprovalRequestsOf([{ ownerApproval: { subject: { ...ok, files: [] }, record: RECORD } }])).toEqual([]);
    expect(ownerApprovalRequestsOf([{ ownerApproval: { subject: { ...ok, kind: "content" }, record: RECORD } }])).toEqual([]);
    expect(ownerApprovalRequestsOf([{ ownerApproval: { subject: ok, record: "  " } }])).toEqual([]);
    expect(ownerApprovalRequestsOf("lixo")).toEqual([]);
    expect(parseDeployExit3Report("sem json").ownerApprovals).toEqual([]);
  });

  it("a autorização copia o ASSUNTO do pedido — quem autoriza não escolhe o que está autorizando", () => {
    const req = request("a", ["pay/a.ts"], ["api"]);
    expect(buildOwnerApproval(req, { at: AT, via: "inbox", card: "story-ex0001" })).toEqual({
      schema: OWNER_APPROVAL_SCHEMA,
      subject: req.subject,
      approvedBy: "owner",
      via: "inbox",
      approvedAt: AT,
      card: "story-ex0001",
    });
    expect("card" in buildOwnerApproval(req, { at: AT, via: "inbox", card: null })).toBe(false);
  });
});

describe("o livro de causas guarda o pedido, uma vez por causa", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "owner-approval-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reqA = request("a", ["pay/a.ts"], ["api"]);
  const up = (rows: DeployBlockRow[], cardId: string, cause: DeployCause, approvals?: OwnerApprovalRequest[]) =>
    upsertDeployBlock(rows, { board: "shop", cardId, cause, at: AT, command: "deploy", ...(approvals !== undefined ? { approvals } : {}) });

  it("a falha que traz o plano grava os pedidos na linha do DONO; a linha do sistema nunca os carrega", () => {
    let rows = up([], "c1", MONEY, [reqA]);
    rows = up(rows, "c2", SYSTEM, [reqA]);
    expect(rows.find((r) => r.causeKey === MONEY.causeKey)?.approvals).toEqual([reqA]);
    expect("approvals" in rows.find((r) => r.causeKey === SYSTEM.causeKey)!).toBe(false);
  });

  it("o plano de AGORA manda: lista vazia apaga o pedido (o dono já autorizou); settle sem plano legível não mexe", () => {
    let rows = up([], "c1", MONEY, [reqA]);
    rows = up(rows, "c2", MONEY); // sem plano: fica como estava
    expect(rows[0].approvals).toEqual([reqA]);
    expect(rows[0].cardIds).toEqual(["c1", "c2"]);
    rows = up(rows, "c3", MONEY, []); // o plano não pede mais nada
    expect("approvals" in rows[0]).toBe(false);
  });

  it("a re-medição pelo plano atualiza o pedido (o código andou ⇒ a mudança a autorizar é outra)", () => {
    const reqB = request("b", ["pay/a.ts"], ["api"]);
    const rows = up([], "c1", MONEY, [reqA]);
    expect(touchDeployBlock(rows, "shop", MONEY, AT, [reqB])[0].approvals).toEqual([reqB]);
    expect(touchDeployBlock(rows, "shop", MONEY, AT)[0].approvals).toEqual([reqA]);
    expect("approvals" in touchDeployBlock(rows, "shop", MONEY, AT, [])[0]).toBe(false);
  });

  it("o que o dono autorizou sai da linha na hora (pelo hash); o que não foi atendido fica", () => {
    const reqB = request("b", ["fn/c.ts"], ["functions"]);
    const rows = up([], "c1", MONEY, [reqA, reqB]);
    expect(grantDeployApprovals(rows, "shop", MONEY.causeKey, [reqA.subject.hash])[0].approvals).toEqual([reqB]);
    expect("approvals" in grantDeployApprovals(rows, "shop", MONEY.causeKey, [reqA.subject.hash, reqB.subject.hash])[0]).toBe(false);
    expect(grantDeployApprovals(rows, "outro", MONEY.causeKey, [reqA.subject.hash])).toEqual(rows);
  });

  it("o pedido sobrevive à ida e volta do disco; um pedido torto no arquivo é descartado, a linha fica", async () => {
    const file = path.join(dir, "deploy-blocks.json");
    await mutateDeployBlocks((r) => up(r, "c1", MONEY, [reqA]), file);
    expect((await readDeployBlocks(file))[0].approvals).toEqual([reqA]);
    await mutateDeployBlocks((r) => r.map((row) => ({ ...row, approvals: [{ subject: { kind: "diff" }, record: "x" } as unknown as OwnerApprovalRequest] })), file);
    const back = await readDeployBlocks(file);
    expect(back).toHaveLength(1);
    expect("approvals" in back[0]).toBe(false);
  });
});

describe("o clique do dono — authorizeOwnerPublish", () => {
  const reqA = request("a", ["pay/a.ts", "pay/b.ts"], ["api"]);
  const reqB = request("b", ["fn/c.ts"], ["functions"]);
  const row = (over: Partial<DeployBlockRow> = {}): DeployBlockRow => ({
    board: "shop",
    causeKey: MONEY.causeKey,
    pkg: "shop",
    phase: "needs-human",
    decider: "owner",
    ownerClass: "money",
    units: ["api"],
    rules: ["ledger-guard"],
    command: "deploy",
    firstAt: AT,
    lastAt: AT,
    cardIds: ["c1", "c2", "c3"],
    planHead: HEAD,
    attributedCard: "c2",
    approvals: [reqA, reqB],
    ...over,
  });

  function harness(opts: { row?: DeployBlockRow | null; record?: (hash: string) => RecordOutcome; publishes?: string[] } = {}) {
    const recorded: Array<{ approval: unknown; hash: string }> = [];
    const granted: string[][] = [];
    const tried: string[] = [];
    const deps: OwnerApprovalDeps = {
      readRow: async () => (opts.row === undefined ? row() : opts.row),
      record: async (approval, req) => {
        recorded.push({ approval, hash: req.subject.hash });
        return opts.record ? opts.record(req.subject.hash) : { ok: true };
      },
      grant: async (_b, _k, hashes) => {
        granted.push(hashes);
      },
      republish: async (_b, cardId) => {
        tried.push(cardId);
        return { ok: (opts.publishes ?? ["c2"]).includes(cardId) };
      },
      now: () => Date.parse(AT),
    };
    return { deps, recorded, granted, tried };
  }
  const run = (h: ReturnType<typeof harness>) => authorizeOwnerPublish(h.deps, { board: "shop", causeKey: MONEY.causeKey });

  it("grava UMA autorização por pedido (do dono, via inbox, com o card que carrega o código), tira os pedidos da linha e republica", async () => {
    const h = harness();
    const res = await run(h);
    expect(res).toMatchObject({ ok: true, recorded: 2, stale: 0, republished: "c2" });
    expect(h.recorded.map((r) => r.approval)).toEqual([
      { schema: OWNER_APPROVAL_SCHEMA, subject: reqA.subject, approvedBy: "owner", via: "inbox", approvedAt: AT, card: "c2" },
      { schema: OWNER_APPROVAL_SCHEMA, subject: reqB.subject, approvedBy: "owner", via: "inbox", approvedAt: AT, card: "c2" },
    ]);
    expect(h.granted).toEqual([[reqA.subject.hash, reqB.subject.hash]]);
    expect(h.tried).toEqual(["c2"]); // o card que carrega o código primeiro — e um só basta (o deploy é do pacote)
  });

  it("o card âncora não está num passo que publica: tenta o próximo da causa", async () => {
    const h = harness({ publishes: ["c3"] });
    expect(await run(h)).toMatchObject({ ok: true, republished: "c3" });
    expect(h.tried).toEqual(["c2", "c1", "c3"]);
  });

  it("nenhum card republica agora: a autorização fica gravada e a mensagem não promete publicação", async () => {
    const h = harness({ publishes: [] });
    const res = await run(h);
    expect(res).toMatchObject({ ok: true, recorded: 2, republished: null });
    expect(res.ok && res.message).toMatch(/próxima publicação do board/);
  });

  it("sem pedido na linha (já autorizado, causa do sistema, ou linha ausente): recusa e NÃO grava nada", async () => {
    for (const r of [null, row({ approvals: undefined }), row({ decider: "system" })]) {
      const h = harness({ row: r });
      const res = await run(h);
      expect(res.ok).toBe(false);
      expect(h.recorded).toEqual([]);
      expect(h.tried).toEqual([]);
    }
  });

  it("o código guardado mudou desde o pedido (o alvo recusa como OUTRA mudança): nada é autorizado, e a publicação roda para refazer o pedido", async () => {
    const h = harness({ record: () => ({ ok: false, stale: true, error: "recusado: o pedido descreve OUTRA mudança" }) });
    const res = await run(h);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/mudou desde este pedido/);
    expect(h.granted).toEqual([]);
    expect(h.tried).toEqual(["c2"]);
  });

  it("o comando do board falhou: erro com o porquê, nada concedido, nada republicado", async () => {
    const h = harness({ record: () => ({ ok: false, stale: false, error: "permissão negada no store" }) });
    const res = await run(h);
    expect(!res.ok && res.error).toMatch(/não pôde ser gravada: permissão negada no store/);
    expect(h.granted).toEqual([]);
    expect(h.tried).toEqual([]);
  });

  it("parcial: o que gravou sai da linha e republica; o resto é dito na mensagem", async () => {
    const h = harness({ record: (x) => (x === reqA.subject.hash ? { ok: true } : { ok: false, stale: true, error: "OUTRA mudança" }) });
    const res = await run(h);
    expect(res).toMatchObject({ ok: true, recorded: 1, stale: 1 });
    expect(h.granted).toEqual([[reqA.subject.hash]]);
    expect(res.ok && res.message).toMatch(/1 de 2 pedido\(s\)/);
  });

  it("a recusa do alvo por mudança velha é reconhecida pelas frases que o ALVO declarou (nas línguas que ele quiser)", () => {
    const marcas = ["OUTRA mudança", "another change"];
    expect(approvalRefusedAsStale("recusado: o pedido descreve OUTRA mudança (hash não confere)", marcas)).toBe(true);
    expect(approvalRefusedAsStale("the owner approval is for another change", marcas)).toBe(true);
    expect(approvalRefusedAsStale("ENOENT: no such file", marcas)).toBe(false);
  });

  it("SEM marcas declaradas nunca é «stale» — a ferramenta não traz frase de fábrica do script de ninguém", () => {
    expect(approvalRefusedAsStale("recusado: o pedido descreve OUTRA mudança", [])).toBe(false);
    expect(approvalRefusedAsStale("the owner approval is for another change", [])).toBe(false);
  });
});

describe("o pedido chega ao livro sem esperar uma nova tentativa de publicar", () => {
  const reqA = request("a", ["pay/a.ts"], ["api"]);
  const reqOther: OwnerApprovalRequest = { ...request("c", ["brand/x.ts"], ["web"]), rules: ["brand-voice"] };
  const base = (over: Partial<DeployBlockRow> = {}): DeployBlockRow => ({
    board: "shop",
    causeKey: MONEY.causeKey,
    pkg: "shop",
    phase: "needs-human",
    decider: "owner",
    ownerClass: "money",
    units: ["api"],
    rules: ["ledger-guard"],
    command: "deploy",
    firstAt: AT,
    lastAt: AT,
    cardIds: ["c1"],
    planHead: HEAD,
    attributedCard: "c1",
    ...over,
  });
  const report = (approvals: OwnerApprovalRequest[]) => ({ ...parseDeployExit3Report(""), status: "needs-human" as const, ownerApprovals: approvals });

  it("a linha do dono sem pedido o lê da última saída do deploy — só o que cobre uma regra DELA", () => {
    const rows = backfillDeployApprovals([base()], "shop", () => report([reqA, reqOther]));
    expect(rows[0].approvals).toEqual([reqA]);
  });

  it("nunca sobrescreve o que a linha já sabe, nunca toca causa do sistema nem outro board", () => {
    const known = base({ approvals: [request("z", ["pay/z.ts"], ["api"])] });
    const sys = base({ causeKey: "shop:system", decider: "system", ownerClass: null });
    const other = base({ board: "outro" });
    expect(backfillDeployApprovals([known, sys, other], "shop", () => report([reqA]))).toEqual([known, sys, other]);
  });

  it("o que o dono JÁ autorizou não volta a virar botão por um log antigo; um assunto novo, sim", () => {
    const granted = grantDeployApprovals([base({ approvals: [reqA] })], "shop", MONEY.causeKey, [reqA.subject.hash]);
    expect(granted[0].granted).toEqual([reqA.subject.hash]);
    expect("approvals" in backfillDeployApprovals(granted, "shop", () => report([reqA]))[0]).toBe(false);
    const reqNew = request("d", ["pay/a.ts"], ["api"]);
    expect(backfillDeployApprovals(granted, "shop", () => report([reqA, reqNew]))[0].approvals).toEqual([reqNew]);
  });

  it("sem log legível (ou sem pedido nele): a linha fica como está", () => {
    expect(backfillDeployApprovals([base()], "shop", () => null)).toEqual([base()]);
    expect(backfillDeployApprovals([base()], "shop", () => report([]))).toEqual([base()]);
  });

  it("um board com duas causas do dono: cada pedido vai para a causa cuja regra ele cobre", () => {
    expect(approvalsForCause([reqA, reqOther], ["brand-voice"])).toEqual([reqOther]);
    expect(approvalsForCause([reqA, reqOther], [])).toEqual([reqA, reqOther]);
    expect(approvalsForCause(undefined, ["ledger-guard"])).toBeUndefined();
  });
});
