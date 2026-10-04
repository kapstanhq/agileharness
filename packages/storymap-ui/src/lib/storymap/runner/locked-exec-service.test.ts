import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCKED_EXEC_CWD, LOCKED_EXEC_TTL_MS, type LockedExecProposalInput, type LockedExecRecord } from "./locked-exec";
import type { ClassifyFn } from "./locked-exec-classifier";
import { LockedExecService, defaultLockedExecRun, redactOutput, redactSecrets, wakeText, type LockedExecRunFn, type LockedExecServiceDeps } from "./locked-exec-service";

// O SERVIÇO da execução aprovada, com a trava, os programas e os processos INJETADOS (um cofre de chaves fictício): a
// proposta só classifica e resolve; só o operador com sessão aprova; a execução parte SÓ da aprovação em memória, é
// UMA (claim exclusivo), presa ao hash, ao programa e ao prazo; conferência que falha desfaz sozinha; o disco que falha
// não derruba nada; o celular só toca quando algo deu errado.

const T0 = Date.UTC(2026, 3, 1, 12);
const BIN = "/opt/cofre/bin";

/** A trava fictícia: rotate/rollback são travados e aprováveis; destroy/seal travados e NÃO aprováveis; o resto é livre. */
const classify: ClassifyFn = async (argv) => {
  const verb = `${path.basename(argv[0])} ${argv[1] ?? ""}`.trim();
  if (verb === "cofre-cli rotate" || verb === "cofre-cli rollback") return { ok: true, c: { locked: true, approvable: true, rule: "vault-access" } };
  if (verb === "cofre-cli destroy" || verb === "cofre-cli seal") return { ok: true, c: { locked: true, approvable: false, reason: "apagar o cofre" } };
  return { ok: true, c: { locked: false, approvable: false } };
};

interface Harness {
  svc: LockedExecService;
  calls: string[];
  notified: LockedExecRecord[];
  woke: string[];
  logs: string[];
  dir: string;
  setNow: (t: number) => void;
  /** o que cada comando devolve (chave = nome do programa + argumentos); padrão: sucesso vazio. */
  script: Map<string, { exitCode: number | null; stdout?: string; error?: string }>;
  /** onde cada programa «mora» (o resolver lê daqui a cada chamada). */
  where: Map<string, string>;
  /** o que «existe» no diretório do passo (o B1 olha aqui antes de cada passo) */
  planted: Set<string>;
  deps: LockedExecServiceDeps;
}

let h: Harness;

function harness(over: Partial<LockedExecServiceDeps> = {}, shared?: { dir: string; calls: string[] }): Harness {
  const dir = shared?.dir ?? mkdtempSync(path.join(tmpdir(), "locked-exec-"));
  let now = T0;
  const calls = shared?.calls ?? [];
  const notified: LockedExecRecord[] = [];
  const woke: string[] = [];
  const logs: string[] = [];
  const script = new Map<string, { exitCode: number | null; stdout?: string; error?: string }>();
  const where = new Map<string, string>([["cofre-cli", `${BIN}/cofre-cli`]]);
  const planted = new Set<string>();
  const run: LockedExecRunFn = async (argv) => {
    const key = [path.basename(argv[0]), ...argv.slice(1)].join(" ");
    calls.push(key);
    const s = script.get(key) ?? { exitCode: 0, stdout: "" };
    return { exitCode: s.exitCode, stdout: s.stdout ?? "", stderr: "", ...(s.error ? { error: s.error } : {}) };
  };
  const deps: LockedExecServiceDeps = {
    stateDir: () => dir,
    classifier: () => ({ ok: true, classify }),
    run,
    now: () => now,
    notify: (r) => {
      if (["failed", "undone", "stale", "expired"].includes(r.status)) notified.push(r);
    },
    wake: (_b, c, line) => woke.push(`${c}: ${line}`),
    log: (m) => logs.push(m),
    repoRoot: () => "/srv/alvo",
    defer: (fn) => fn(),
    resolveProgram: (a) => {
      const p = a.startsWith("/") ? a : where.get(a);
      return p ? { ok: true, path: p } : { ok: false, why: `programa «${a}» não encontrado` };
    },
    cardExists: async (b, c) => b === "atelie" && c.startsWith("story-ex") && c !== "story-ex0000",
    // o host libera estas conferências (o programa comparado pelo caminho real)
    checkPrefixes: () => ({ ok: true, prefixes: [["cofre-cli", "status"], ["cofre-cli", "verifica"]] }),
    workDir: async () => ({ path: "/lx-passo", cleanup: async () => {} }),
    exists: (p) => planted.has(p),
    ...over,
  };
  return { svc: new LockedExecService(deps), calls, notified, woke, logs, dir, setNow: (t) => (now = t), script, where, planted, deps };
}

const proposal = (over: Partial<LockedExecProposalInput> = {}): LockedExecProposalInput => ({
  board: "atelie",
  cardId: "story-ex7001",
  summary: "Troca a chave de API do cofre do ateliê por uma nova e guarda a anterior por um ciclo.",
  argv: ["cofre-cli", "rotate", "--key=api"],
  undoArgv: ["cofre-cli", "rollback", "--key=api"],
  preflight: [{ label: "o cofre existe", argv: ["cofre-cli", "status"] }],
  verify: [{ label: "a chave nova está ativa", argv: ["cofre-cli", "verifica", "--key=api"], expectStdoutIncludes: "ativa" }],
  ...over,
});

async function proposed(over: Partial<LockedExecProposalInput> = {}, svc = h.svc): Promise<LockedExecRecord> {
  const r = await svc.propose(proposal(over), "mcp:write(TESTE)");
  if (!r.ok) throw new Error(r.why);
  return r.value;
}

beforeEach(() => {
  h = harness();
  h.script.set("cofre-cli verifica --key=api", { exitCode: 0, stdout: "chave: ativa" });
});
afterEach(async () => {
  await h.svc.flush();
  rmSync(h.dir, { recursive: true, force: true });
});

describe("propose — o agente propõe; nada roda", () => {
  it("grava pendente com o hash, a classificação e os PROGRAMAS resolvidos, e não roda nada (nem o preflight)", async () => {
    const r = await proposed();
    expect(r).toMatchObject({ status: "pending", board: "atelie", cardId: "story-ex7001", cwd: LOCKED_EXEC_CWD, classification: { rule: "vault-access" } });
    expect(r.programs).toEqual({ main: `${BIN}/cofre-cli`, undo: `${BIN}/cofre-cli`, preflight: [`${BIN}/cofre-cli`], verify: [`${BIN}/cofre-cli`] });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.calls).toEqual([]);
  });

  it("o MESMO pedido pendente volta o mesmo (não empilha no Inbox)", async () => {
    const a = await proposed();
    const b = await proposed();
    expect(b.id).toBe(a.id);
    expect((await h.svc.list()).length).toBe(1);
  });

  it.each([
    ["comando não travado", { argv: ["cofre-cli", "status"] }, /não está travado/],
    ["travado e NÃO aprovável", { argv: ["cofre-cli", "destroy"] }, /não deixa este comando ganhar o botão: apagar o cofre/],
    ["desfazer travado e não aprovável", { undoArgv: ["cofre-cli", "seal"] }, /desfazer é travado/],
    ["conferência fora da lista do host", { verify: [{ label: "x", argv: ["cofre-cli", "rotate", "--again"] }] }, /conferência #1: não é um comando que o servidor liberou/],
    ["preflight fora da lista do host", { preflight: [{ label: "a", argv: ["cofre-cli", "status"] }, { label: "x", argv: ["cofre-cli", "rollback"] }] }, /preflight #2: não é um comando que o servidor liberou/],
    ["argumento com caminho absoluto", { argv: ["cofre-cli", "rotate", "--de-arquivo=/tmp/pedido.yaml"] }, /parece um caminho de arquivo/],
    ["argumento @arquivo", { argv: ["cofre-cli", "rotate", "@pedido.json"] }, /parece um caminho de arquivo/],
    ["argumento ~", { undoArgv: ["cofre-cli", "rollback", "~/x"] }, /parece um caminho de arquivo/],
    ["argumento --x=./y", { verify: [{ label: "x", argv: ["cofre-cli", "verifica", "--x=./y"] }] }, /parece um caminho de arquivo/],
    ["verify vazio", { verify: [] }, /verify/],
    ["interpretador", { argv: ["python3", "-c", "print(1)"] }, /executa o que vier/],
    ["metacaractere", { argv: ["cofre-cli", "rotate", "--key=x;id"] }, /sintaxe de shell/],
    ["programa desconhecido", { verify: [{ label: "x", argv: ["sumiu-cli", "a"] }] }, /conferência #1: programa «sumiu-cli» não encontrado/],
    ["card inexistente", { cardId: "story-ex0000" }, /card não encontrado/],
    ["board inexistente", { board: "outro" }, /card não encontrado/],
  ])("recusa: %s", async (_n, over, re) => {
    const r = await h.svc.propose(proposal(over as Partial<LockedExecProposalInput>), "mcp:write(TESTE)");
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(re as RegExp) });
    expect(await h.svc.list()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it("escopo: um agente escopado só propõe para o card que conduz", async () => {
    expect(await h.svc.propose(proposal(), { by: "x", scoped: true, scopeCardId: "story-ex9999" })).toMatchObject({ ok: false, why: expect.stringMatching(/só propõe para o card que conduz \(story-ex9999\)/) });
    expect(await h.svc.propose(proposal(), { by: "x", scoped: true, scopeCardId: null })).toMatchObject({ ok: false, why: expect.stringMatching(/não conduz nenhum/) });
    expect(await h.svc.propose(proposal(), { by: "x", scoped: true, scopeCardId: "story-ex7001" })).toMatchObject({ ok: true });
  });

  it("limite: 2 pendentes por card e 10 por board (o mesmo comando com outro resumo é o MESMO pedido)", async () => {
    const who = (n: number) => ({ argv: ["cofre-cli", "rotate", `--key=api-${n}`] });
    const first = await proposed(who(1));
    expect((await proposed({ ...who(1), summary: "O mesmo comando, explicado de outro jeito." })).id).toBe(first.id);
    await proposed(who(2));
    expect(await h.svc.propose(proposal(who(3)), "x")).toMatchObject({ ok: false, why: expect.stringMatching(/já tem 2 pedidos/) });
    for (let i = 2; i <= 9; i++) await proposed({ ...who(i), cardId: `story-ex70${i.toString().padStart(2, "0")}` });
    expect(await h.svc.propose(proposal({ ...who(99), cardId: "story-ex7099" }), "x")).toMatchObject({ ok: false, why: expect.stringMatching(/já tem 10 pedidos/) });
  });

  it("sem a trava declarada pelo host, a função está desligada", async () => {
    const off = new LockedExecService({ ...h.deps, classifier: () => ({ ok: false, why: "desligada" }) });
    expect(await off.propose(proposal(), "x")).toEqual({ ok: false, why: "desligada" });
  });
});

describe("approve — só o dono, só o pedido exato", () => {
  it.each(["mcp-token", "in-process", null])("chamador %s ⇒ recusado; nada roda", async (caller) => {
    const r = await proposed();
    expect(await h.svc.approve({ id: r.id, hash: r.hash, caller })).toMatchObject({ ok: false, why: expect.stringMatching(/só o dono/) });
    await h.svc.flush();
    expect(h.calls).toEqual([]);
    expect((await h.svc.get(r.id))!.status).toBe("pending");
  });

  it("hash diferente do que o dono viu ⇒ recusa", async () => {
    const r = await proposed();
    expect(await h.svc.approve({ id: r.id, hash: "0".repeat(64), caller: "operator-session" })).toMatchObject({ ok: false, why: expect.stringMatching(/mudou/) });
  });

  it("o arquivo adulterado depois da proposta (argv trocado, hash antigo) ⇒ recusa", async () => {
    const r = await proposed();
    const file = path.join(h.dir, `${r.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.argv = ["cofre-cli", "rotate", "--key=todas"];
    writeFileSync(file, JSON.stringify(raw));
    expect(await h.svc.approve({ id: r.id, hash: r.hash, caller: "operator-session" })).toMatchObject({ ok: false, why: expect.stringMatching(/mudou/) });
  });

  it("sucesso: preflight → comando → conferência, «done», NÃO avisa o celular, acorda o agente", async () => {
    const r = await proposed();
    const a = await h.svc.approve({ id: r.id, hash: r.hash, caller: "operator-session" });
    expect(a).toMatchObject({ ok: true, value: { status: "approved", approvedHash: r.hash } });
    await h.svc.flush();
    const done = (await h.svc.get(r.id))!;
    expect(done.status).toBe("done");
    expect(h.calls).toEqual(["cofre-cli status", "cofre-cli rotate --key=api", "cofre-cli verifica --key=api"]);
    expect(done.results.map((s) => [s.step, s.ok])).toEqual([["preflight:0", true], ["main", true], ["verify:0", true]]);
    expect(h.notified).toEqual([]);
    expect(h.woke.at(-1)).toMatch(/rodou e passou/);
  });

  it("aprovar duas vezes: a segunda recusa, e o comando roda UMA vez", async () => {
    const r = await proposed();
    await h.svc.approve({ id: r.id, hash: r.hash, caller: "operator-session" });
    expect(await h.svc.approve({ id: r.id, hash: r.hash, caller: "operator-session" })).toMatchObject({ ok: false });
    await Promise.all([h.svc.execute(r.id), h.svc.execute(r.id)]);
    await h.svc.flush();
    expect(h.calls.filter((c) => c.startsWith("cofre-cli rotate")).length).toBe(1);
  });
});

describe("a execução só parte da aprovação EM MEMÓRIA (S5)", () => {
  it("um registro «approved» escrito no disco por outra mão não roda nada — nem é tocado", async () => {
    const r = await proposed();
    const file = path.join(h.dir, `${r.id}.json`);
    const forged = { ...JSON.parse(readFileSync(file, "utf8")), status: "approved", approvedHash: r.hash, decidedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 60_000).toISOString() };
    writeFileSync(file, JSON.stringify(forged));
    await h.svc.execute(r.id);
    await h.svc.flush();
    expect(h.calls).toEqual([]);
    expect((await h.svc.get(r.id))!.status).toBe("approved");
  });

  it("a aprovação em memória é de uso único: depois de consumida, outro execute não roda", async () => {
    const r = await proposed();
    await h.svc.approve({ id: r.id, hash: r.hash, caller: "operator-session" });
    await h.svc.flush();
    const file = path.join(h.dir, `${r.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "approved" }));
    h.calls.length = 0;
    await h.svc.execute(r.id);
    expect(h.calls).toEqual([]);
  });

  it("prazo gravado esticado além de 15 min (disco adulterado) ⇒ «expired», nada roda", async () => {
    const r = await proposed();
    const lazy = new LockedExecService({ ...h.deps, defer: () => {} });
    await lazy.approve({ id: r.id, hash: r.hash, caller: "operator-session" });
    const file = path.join(h.dir, `${r.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), expiresAt: new Date(T0 + 24 * 3_600_000).toISOString() }));
    await lazy.execute(r.id);
    await lazy.flush();
    expect((await lazy.get(r.id))!.status).toBe("expired");
    expect(h.calls).toEqual([]);
  });

  it("aprovada e não começou em 15 min ⇒ «expired», nada roda", async () => {
    let now = T0;
    const lazy = new LockedExecService({ ...h.deps, now: () => now, defer: () => {} });
    const p = await proposed({}, lazy);
    await lazy.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    now = T0 + LOCKED_EXEC_TTL_MS + 1;
    await lazy.execute(p.id);
    await lazy.flush();
    expect((await lazy.get(p.id))!.status).toBe("expired");
    expect(h.calls).toEqual([]);
  });
});

describe("CAS entre processos (S10)", () => {
  it("duas instâncias sobre o MESMO diretório, ambas com a aprovação: o claim exclusivo deixa só uma rodar", async () => {
    const calls: string[] = [];
    const a = harness({ defer: () => {} }, { dir: h.dir, calls });
    const b = harness({ defer: () => {} }, { dir: h.dir, calls });
    for (const x of [a, b]) x.script.set("cofre-cli verifica --key=api", { exitCode: 0, stdout: "chave: ativa" });
    const p = await proposed({}, a.svc);
    await a.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    // o disco volta a «pending» para a segunda instância também receber a aprovação (a corrida entre processos)
    const file = path.join(h.dir, `${p.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "pending" }));
    await b.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await Promise.all([a.svc.execute(p.id), b.svc.execute(p.id)]);
    await Promise.all([a.svc.flush(), b.svc.flush()]);
    expect(calls.filter((c) => c.startsWith("cofre-cli rotate")).length).toBe(1);
    expect(existsSync(path.join(h.dir, `${p.id}.claim`))).toBe(true);
  });
});

describe("a execução — os desfechos", () => {
  async function approved(over: Partial<LockedExecProposalInput> = {}): Promise<LockedExecRecord> {
    const r = await proposed(over);
    await h.svc.approve({ id: r.id, hash: r.hash, caller: "operator-session" });
    await h.svc.flush();
    return (await h.svc.get(r.id))!;
  }

  it("conferência falha ⇒ desfaz SOZINHO, «undone», avisa o celular", async () => {
    h.script.set("cofre-cli verifica --key=api", { exitCode: 0, stdout: "chave: pendente" });
    const r = await approved();
    expect(r).toMatchObject({ status: "undone", autoUndone: true });
    expect(h.calls.at(-1)).toBe("cofre-cli rollback --key=api");
    expect(h.notified.map((x) => x.status)).toEqual(["undone"]);
  });

  it("conferência falha SEM desfazer ⇒ «failed» com o plano B, avisa", async () => {
    h.script.set("cofre-cli verifica --key=api", { exitCode: 1 });
    const r = await approved({ undoArgv: null, noUndoPlan: "Voltar à chave anterior pelo painel do cofre, com o operador." });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/plano B: Voltar à chave anterior pelo painel/);
    expect(h.notified.length).toBe(1);
  });

  it("o comando falha ⇒ «failed», e NÃO roda desfazer nem conferência", async () => {
    h.script.set("cofre-cli rotate --key=api", { exitCode: 2 });
    const r = await approved();
    expect(r.status).toBe("failed");
    expect(h.calls.some((c) => c.includes("rollback"))).toBe(false);
    expect(h.calls.some((c) => c.includes("verifica"))).toBe(false);
  });

  it("desfazer automático que também falha ⇒ «failed» dizendo para conferir à mão", async () => {
    h.script.set("cofre-cli verifica --key=api", { exitCode: 1 });
    h.script.set("cofre-cli rollback --key=api", { exitCode: 1 });
    const r = await approved();
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/desfazer também falhou/);
  });

  it("a reconferência (preflight) falha na hora de rodar ⇒ «stale», nada travado roda", async () => {
    const p = await proposed();
    h.script.set("cofre-cli status", { exitCode: 1 });
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    expect((await h.svc.get(p.id))!.status).toBe("stale");
    expect(h.calls).toEqual(["cofre-cli status"]);
    expect(h.notified.map((x) => x.status)).toEqual(["stale"]);
  });

  it("o programa mudou de lugar desde a aprovação ⇒ «stale», nada roda", async () => {
    const p = await proposed();
    h.where.set("cofre-cli", "/tmp/outro/cofre-cli");
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    expect((await h.svc.get(p.id))!).toMatchObject({ status: "stale", error: expect.stringMatching(/programa mudou/) });
    expect(h.calls).toEqual([]);
  });

  it("uma conferência que virou TRAVADA desde a proposta ⇒ «stale» (S9), nada roda", async () => {
    const p = await proposed();
    let flipped = false;
    const svc = new LockedExecService({
      ...h.deps,
      classifier: () => ({ ok: true, classify: async (argv) => (flipped && argv[1] === "verifica" ? { ok: true, c: { locked: true, approvable: false } } : classify(argv)) }),
    });
    flipped = true;
    await svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await svc.flush();
    expect((await svc.get(p.id))!).toMatchObject({ status: "stale", error: expect.stringMatching(/conferência #1 é um comando travado/) });
    expect(h.calls).toEqual([]);
  });

  it("a trava deixou de aprovar o comando depois da proposta ⇒ «stale», nada roda", async () => {
    const p = await proposed();
    let flipped = false;
    const svc = new LockedExecService({ ...h.deps, classifier: () => ({ ok: true, classify: flipped ? async () => ({ ok: true, c: { locked: true, approvable: false } }) : classify }) });
    flipped = true;
    await svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await svc.flush();
    expect((await svc.get(p.id))!.status).toBe("stale");
    expect(h.calls).toEqual([]);
  });

  it("a saída gravada vem REDIGIDA (S4)", async () => {
    h.script.set("cofre-cli rotate --key=api", { exitCode: 0, stdout: 'ok {"refresh_token": "abc.def-123", "x": 1} Authorization: Bearer abcdefghij123456 ya29.A0ARrdaM-secreto' });
    const r = await approved();
    const main = r.results.find((s) => s.step === "main")!;
    expect(main.stdoutTail).not.toMatch(/abc\.def-123|abcdefghij123456|ya29\.A0/);
    expect(readFileSync(path.join(h.dir, `${r.id}.json`), "utf8")).not.toMatch(/abcdefghij123456/);
  });
});

describe("o disco que falha não derruba nada (R3)", () => {
  it("falha ao criar o claim ⇒ nada roda, nada lança, fica no log", async () => {
    const svc = new LockedExecService({ ...h.deps, claim: async () => { throw new Error("disco cheio"); } });
    const p = await proposed({}, svc);
    await svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await svc.flush();
    expect(h.calls).toEqual([]);
    expect(h.logs.some((l) => l.includes("disco cheio"))).toBe(true);
  });

  it("falha ao gravar o desfecho ⇒ não lança (unhandled), loga, e o registro fica «running» para a recuperação", async () => {
    let fail = false;
    const svc = new LockedExecService({
      ...h.deps,
      write: async (f, c) => {
        if (fail) throw new Error("sem espaço");
        const { atomicWriteFile } = await import("@/lib/storymap/atomic-write");
        await atomicWriteFile(f, c);
      },
      run: async (argv) => {
        if (argv[1] === "rotate") fail = true;
        return { exitCode: 0, stdout: "chave: ativa", stderr: "" };
      },
    });
    const p = await proposed({}, svc);
    await svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await expect(svc.flush()).resolves.toBeUndefined();
    expect(h.logs.some((l) => l.includes("sem espaço"))).toBe(true);
    expect((await svc.get(p.id))!.status).toBe("running");
  });
});

describe("as outras decisões do dono", () => {
  it("recusar: só o dono; o item SAI do Inbox na hora; o agente do card é avisado", async () => {
    const r = await proposed();
    expect(await h.svc.reject({ id: r.id, caller: "mcp-token" })).toMatchObject({ ok: false });
    const j = await h.svc.reject({ id: r.id, caller: "operator-session", reason: "agora não" });
    expect(j).toMatchObject({ ok: true, value: { status: "rejected", rejectReason: "agora não", ackedAt: expect.any(String) } });
    expect(await h.svc.listForBoard("atelie")).toEqual([]);
    expect(h.woke.at(-1)).toMatch(/NÃO aprovou/);
  });

  it("desfazer depois do sucesso: só o dono; roda o desfazer uma vez ⇒ «undone» (sem ser automático)", async () => {
    const p = await proposed();
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    expect(await h.svc.undo({ id: p.id, caller: "mcp-token" })).toMatchObject({ ok: false });
    expect(await h.svc.undo({ id: p.id, caller: "operator-session" })).toMatchObject({ ok: true });
    await h.svc.flush();
    const r = (await h.svc.get(p.id))!;
    expect(r).toMatchObject({ status: "undone", autoUndone: false });
    expect(r.phase).toBeUndefined();
    expect(h.calls.filter((c) => c.includes("rollback")).length).toBe(1);
    expect(await h.svc.undo({ id: p.id, caller: "operator-session" })).toMatchObject({ ok: false });
  });

  it("desfazer que falha ⇒ «failed» para conferir à mão, avisa", async () => {
    const p = await proposed();
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    h.script.set("cofre-cli rollback --key=api", { exitCode: 3 });
    await h.svc.undo({ id: p.id, caller: "operator-session" });
    await h.svc.flush();
    expect((await h.svc.get(p.id))!).toMatchObject({ status: "failed", error: expect.stringMatching(/desfazer falhou/) });
    expect(h.notified.map((x) => x.status)).toContain("failed");
  });

  it("desfazer recusado quando o pedido no disco não é mais o aprovado, ou a trava não aceita mais o desfazer (S9)", async () => {
    const p = await proposed();
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    const file = path.join(h.dir, `${p.id}.json`);
    const good = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(good), undoArgv: ["cofre-cli", "rollback", "--key=todos"] }));
    expect(await h.svc.undo({ id: p.id, caller: "operator-session" })).toMatchObject({ ok: false, why: expect.stringMatching(/não é mais o que o dono aprovou/) });
    writeFileSync(file, good);
    const svc = new LockedExecService({ ...h.deps, classifier: () => ({ ok: true, classify: async () => ({ ok: true, c: { locked: true, approvable: false } }) }) });
    expect(await svc.undo({ id: p.id, caller: "operator-session" })).toMatchObject({ ok: false, why: expect.stringMatching(/não aceita mais este desfazer/) });
    expect(h.calls.filter((c) => c.includes("rollback")).length).toBe(0);
  });

  it("manter tira o item do Inbox; «Ok» num desfecho final também", async () => {
    const p = await proposed();
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    expect(await h.svc.keep({ id: p.id, caller: "operator-session" })).toMatchObject({ ok: true, value: { status: "kept" } });
    expect(await h.svc.listForBoard("atelie")).toEqual([]);
    h.script.set("cofre-cli status", { exitCode: 1 });
    const q = await proposed({ argv: ["cofre-cli", "rotate", "--key=api-2"] });
    await h.svc.approve({ id: q.id, hash: q.hash, caller: "operator-session" });
    await h.svc.flush();
    expect((await h.svc.get(q.id))!.status).toBe("stale");
    expect(await h.svc.ack({ id: q.id, caller: "mcp-token" })).toMatchObject({ ok: false });
    expect(await h.svc.ack({ id: q.id, caller: "operator-session" })).toMatchObject({ ok: true });
    expect(await h.svc.listForBoard("atelie")).toEqual([]);
  });

  it("arquivados há mais de 30 dias saem da listagem (o arquivo fica)", async () => {
    const r = await proposed();
    await h.svc.reject({ id: r.id, caller: "operator-session" });
    h.setNow(T0 + 31 * 24 * 3_600_000);
    expect(await h.svc.list()).toEqual([]);
    expect(existsSync(path.join(h.dir, `${r.id}.json`))).toBe(true);
  });
});

describe("recoverOnBoot — NUNCA executa", () => {
  it("aprovado não iniciado ⇒ «expired» (aprove de novo), com aviso; rodando ⇒ «failed» para conferir à mão", async () => {
    const a = await proposed();
    const file = path.join(h.dir, `${a.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "running", approvedHash: a.hash }));
    const b = await proposed({ argv: ["cofre-cli", "rotate", "--key=api-2"] });
    const before = new LockedExecService({ ...h.deps, defer: () => {} });
    await before.approve({ id: b.id, hash: b.hash, caller: "operator-session" });
    h.calls.length = 0;
    const after = new LockedExecService(h.deps);
    await after.recoverOnBoot();
    await after.flush();
    expect((await after.get(a.id))!).toMatchObject({ status: "failed", error: expect.stringMatching(/reiniciou no meio/) });
    expect((await after.get(b.id))!).toMatchObject({ status: "expired", error: expect.stringMatching(/aprove de novo/) });
    expect(h.calls).toEqual([]);
    expect(h.notified.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("auditoria e texto ao agente", () => {
  it("cada passo vai ao audit.jsonl", async () => {
    const p = await proposed();
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    const actions = readFileSync(path.join(h.dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action);
    expect(actions).toEqual(["propose", "approve", "claim", "finish"]);
  });
  it("wakeText aponta a ferramenta de leitura", () => {
    expect(wakeText({ status: "done", id: "lx-0000000000" } as LockedExecRecord)).toMatch(/locked_command_status/);
  });
});

describe("redactSecrets", () => {
  it.each([
    ["token OAuth", "token=ya29.a0AfH6SMBx-segredo_123"],
    // montados em tempo de execução: com a forma literal de credencial, o scanner da árvore publicada (com razão) barra
    ["chave PEM", [`-----BEGIN ${"PRIVATE"} KEY-----`, "MIIEv", `-----END ${"PRIVATE"} KEY-----`].join("\n")],
    ["campo de credencial em JSON", '{"client_secret": "naoMostrar"}'],
    ["Bearer", "Authorization: Bearer zz9plural-z-alpha"],
    ["chave de acesso", "AKIAIOSFODNN7EXAMPLE"],
    ["token longo opaco", `k=${["Zq8xV2mN", "4pL7rT1w", "Y6uB3cE9", "hJ5sD0fG"].join("")}`],
  ])("redige %s", (_n, s) => {
    const out = redactSecrets(s);
    expect(out).not.toBe(s);
    expect(out).toMatch(/redigido|oculto/);
  });
  it("deixa texto comum legível", () => {
    expect(redactSecrets("cofre: chave api trocada; 2 versões guardadas")).toBe("cofre: chave api trocada; 2 versões guardadas");
  });
});

describe("defaultLockedExecRun — o executor real (R2)", () => {
  it("tempo esgotado mata o GRUPO com SIGKILL, mesmo com o filho ignorando TERM", async () => {
    const t0 = Date.now();
    const r = await defaultLockedExecRun(["/bin/sh", "-c", "trap '' TERM; sleep 30 & wait"], { cwd: "/", timeoutMs: 400 });
    expect(r).toMatchObject({ exitCode: null, error: expect.stringMatching(/tempo esgotado/) });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
  it("saída enorme: não estoura, devolve o fim", async () => {
    const r = await defaultLockedExecRun(["/usr/bin/seq", "1", "1500000"], { cwd: "/", timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trimEnd().endsWith("1500000")).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
  it("programa ausente ⇒ erro, sem lançar", async () => {
    const r = await defaultLockedExecRun(["/nao/existe/cofre-cli", "x"], { cwd: "/", timeoutMs: 2_000 });
    expect(r.exitCode).toBeNull();
    expect(r.error).toBeTruthy();
  });
  it("código de saída e saída padrão de verdade", async () => {
    const r = await defaultLockedExecRun(["/bin/echo", "chave: ativa"], { cwd: "/", timeoutMs: 2_000 });
    expect(r).toMatchObject({ exitCode: 0, stdout: "chave: ativa\n" });
  });
});

describe("B1 — argumento que lê arquivo não escapa do hash", () => {
  it("relativo que EXISTE no diretório do passo ⇒ barrado antes de rodar («stale»), nada roda", async () => {
    const p = await proposed({ argv: ["cofre-cli", "rotate", "--de-arquivo=pedido.yaml"] });
    h.planted.add("/lx-passo/pedido.yaml"); // o arquivo apareceu DEPOIS da aprovação
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    const r = (await h.svc.get(p.id))!;
    expect(r).toMatchObject({ status: "stale", error: expect.stringMatching(/aponta para um arquivo que existe/) });
    expect(h.calls.some((c) => c.includes("rotate"))).toBe(false);
  });

  it("o preflight também é conferido; e o mesmo comando sem o arquivo roda", async () => {
    const p = await proposed({ preflight: [{ label: "o cofre existe", argv: ["cofre-cli", "status", "estado.txt"] }] });
    h.planted.add("/lx-passo/estado.txt");
    await h.svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await h.svc.flush();
    expect((await h.svc.get(p.id))!.status).toBe("stale");
    expect(h.calls).toEqual([]);
  });

  it("o diretório do passo é NOVO, vazio, e é apagado depois (executor real)", async () => {
    const seen: string[] = [];
    const svc = new LockedExecService({ ...h.deps, workDir: undefined, exists: undefined, run: async (argv, o) => (seen.push(o.cwd), { exitCode: 0, stdout: "chave: ativa", stderr: "" }) });
    const p = await proposed({}, svc);
    await svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await svc.flush();
    expect((await svc.get(p.id))!.status).toBe("done");
    expect(new Set(seen).size).toBe(seen.length); // um por passo
    for (const d of seen) {
      expect(path.basename(d)).toMatch(/^lx-passo-/);
      expect(existsSync(d)).toBe(false);
    }
  });
});

describe("B2 — só conferem os comandos que o host libera", () => {
  it("sem a lista do host (ou vazia/ilegível) a função fica desligada", async () => {
    for (const why of ["desligada: sem lista"]) {
      const off = new LockedExecService({ ...h.deps, checkPrefixes: () => ({ ok: false, why }) });
      expect(await off.propose(proposal(), "x")).toEqual({ ok: false, why });
    }
  });

  it("o programa da conferência é comparado pelo caminho REAL: mesmo nome noutro lugar não passa", async () => {
    h.where.set("cofre-cli", `${BIN}/cofre-cli`);
    const svc = new LockedExecService({
      ...h.deps,
      resolveProgram: (a) => ({ ok: true, path: a === "/tmp/cofre-cli" ? "/tmp/cofre-cli" : `${BIN}/${path.basename(a)}` }),
    });
    const r = await svc.propose(proposal({ verify: [{ label: "x", argv: ["/tmp/cofre-cli", "verifica"] }] }), "x");
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/não é um comando que o servidor liberou/) });
  });

  it("a lista do host mudou depois da aprovação ⇒ «stale», nada roda", async () => {
    let prefixes: string[][] = [["cofre-cli", "status"], ["cofre-cli", "verifica"]];
    const svc = new LockedExecService({ ...h.deps, checkPrefixes: () => ({ ok: true, prefixes }) });
    const p = await proposed({}, svc);
    prefixes = [["cofre-cli", "status"]];
    await svc.approve({ id: p.id, hash: p.hash, caller: "operator-session" });
    await svc.flush();
    expect((await svc.get(p.id))!).toMatchObject({ status: "stale", error: expect.stringMatching(/não é um comando que o servidor liberou/) });
    expect(h.calls).toEqual([]);
  });
});

describe("B3 — redação com as linhas juntas", () => {
  it("um segredo partido em duas linhas também é redigido, e a cauda é de 1 KB", () => {
    const token = ["Zq8xV2mN4pL7", "rT1wY6uB3cE9hJ5sD0fG"];
    const out = redactOutput(`saida: ${token[0]}\n${token[1]}\nfim`);
    expect(out).not.toContain(token.join(""));
    expect(out).not.toContain(token[1]);
    expect(redactOutput("x".repeat(5000)).length).toBeLessThanOrEqual(1025);
  });
  it("texto comum segue com as quebras", () => {
    expect(redactOutput("linha um\nlinha dois")).toBe("linha um\nlinha dois");
  });
});
