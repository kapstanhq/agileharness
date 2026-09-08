// A sonda de trabalho vivo, contra um repositório git DE VERDADE — o cenário que motivou o mecanismo:
// uma sessão reescrevendo um arquivo enquanto OUTRA publica o mesmo arquivo. O caso decisivo é o
// trabalho NÃO-COMMITADO: é assim que uma sessão passa a maior parte do tempo, e um diff de branch é
// cego para ele. Mock não pega isso — só git pega.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec as nodeExec } from "node:child_process";
import { promisify } from "node:util";
import { integratedShas, liveWorkInRepo } from "./concurrent-work";
import type { ExecFn } from "./worktree";
import type { AgentSession } from "./session-worktree";

const exec = promisify(nodeExec) as unknown as ExecFn;

const session = (over: Partial<AgentSession>): AgentSession =>
  ({
    sessionId: "s1",
    agentId: "s1",
    role: "session",
    task: "t",
    openedAt: "2026-01-01T00:00:00Z",
    heartbeatAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as AgentSession;

describe("liveWorkInRepo — quem está mexendo em quê, agora", () => {
  let root: string;
  let repo: string;
  let wt: string;
  let base: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "conc-"));
    repo = path.join(root, "repo");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "app", "a.ts"), "a\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "b.ts"), "b\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@t.t`, { cwd: repo });
    await exec(`git config user.name t`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q -m base`, { cwd: repo });
    base = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();

    // Uma sessão viva: commitou a.ts no branch dela E está com b.ts sujo na árvore (mid-rewrite).
    wt = path.join(root, "wt-s1");
    await exec(`git worktree add -q -b agent/s1 ${JSON.stringify(wt)} ${base}`, { cwd: repo });
    await fsp.writeFile(path.join(wt, "packages", "app", "a.ts"), "a mexido\n");
    await exec(`git add -A`, { cwd: wt });
    await exec(`git commit -q -m "trabalho commitado"`, { cwd: wt });
    await fsp.writeFile(path.join(wt, "packages", "app", "b.ts"), "b sendo reescrito agora\n");
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(wt)} --force`, { cwd: repo }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("vê o commitado E o NÃO-COMMITADO da sessão (o não-commitado é o caso que motivou tudo)", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ branch: "agent/s1", baseCommit: base, worktreePath: wt })],
      queued: [],
    });
    expect(live).toHaveLength(1);
    expect(live[0].owner).toBe("agent/s1");
    expect(live[0].files.sort()).toEqual(["packages/app/a.ts", "packages/app/b.ts"]);
  });

  // ── RENAME: onde a sonda ficava CEGA ──────────────────────────────────────────────────────────
  // Numa sonda de segurança, reportar de menos é o defeito grave — a promoção conclui "sem colisão" e
  // aplica por cima do arquivo que a outra sessão está removendo. Os dois casos abaixo produziam
  // exatamente isso: o `--name-only` com detecção de rename esconde a ponta ANTIGA de um `git mv`
  // commitado, e o `--porcelain` a esconde num `git mv` ainda staged.
  it("um `git mv` COMMITADO reporta AS DUAS pontas (a antiga sumia do diff)", async () => {
    const wt2 = path.join(root, "wt-mv");
    await exec(`git worktree add -q -b agent/mv ${JSON.stringify(wt2)} ${base}`, { cwd: repo });
    try {
      await exec(`git mv packages/app/a.ts packages/app/renomeado.ts`, { cwd: wt2 });
      await exec(`git commit -q -m "move"`, { cwd: wt2 });
      const live = await liveWorkInRepo({
        exec,
        repoRoot: repo,
        sessions: [session({ branch: "agent/mv", baseCommit: base, worktreePath: wt2 })],
        queued: [],
      });
      expect(live[0].files.sort()).toEqual(["packages/app/a.ts", "packages/app/renomeado.ts"]);
    } finally {
      await exec(`git worktree remove ${JSON.stringify(wt2)} --force`, { cwd: repo }).catch(() => {});
      await exec(`git branch -D agent/mv`, { cwd: repo }).catch(() => {});
    }
  });

  it("um `git mv` ainda STAGED (não commitado) reporta AS DUAS pontas", async () => {
    const wt3 = path.join(root, "wt-mv2");
    await exec(`git worktree add -q -b agent/mv2 ${JSON.stringify(wt3)} ${base}`, { cwd: repo });
    try {
      await exec(`git mv packages/app/b.ts packages/app/movido.ts`, { cwd: wt3 });
      const live = await liveWorkInRepo({
        exec,
        repoRoot: repo,
        sessions: [session({ branch: "agent/mv2", baseCommit: base, worktreePath: wt3 })],
        queued: [],
      });
      expect(live[0].files.sort()).toEqual(["packages/app/b.ts", "packages/app/movido.ts"]);
    } finally {
      await exec(`git worktree remove ${JSON.stringify(wt3)} --force`, { cwd: repo }).catch(() => {});
      await exec(`git branch -D agent/mv2`, { cwd: repo }).catch(() => {});
    }
  });

  it("NÃO reporta a própria sessão que está publicando (senão toda publicação se auto-bloqueia)", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ branch: "agent/s1", baseCommit: base, worktreePath: wt })],
      queued: [],
      excludeSessionId: "s1",
    });
    expect(live).toEqual([]);
  });

  it("inclui o que está na fila do train, nomeado pelo runId", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [],
      queued: [{ runId: "r9", branch: "agent/s1", baseCommit: base }],
    });
    expect(live).toEqual([{ owner: "fila:r9", files: ["packages/app/a.ts"] }]);
  });

  it("uma ref sumida devolve vazio em vez de explodir — a sonda nunca derruba a publicação", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ branch: "agent/nao-existe", baseCommit: base, worktreePath: "/nao/existe" })],
      queued: [{ runId: "r0", branch: "tambem-nao-existe", baseCommit: base }],
    });
    expect(live).toEqual([]);
  });

  /**
   * A sessão ADOTADA é o caso que quase escapou. Ela tem claims e visibilidade mas NENHUMA árvore
   * isolada — não há diff nem status para ler. Omiti-la faria a sonda responder "nada concorrente" para
   * trabalho que existe: falsa garantia justamente no cenário em que alguém edita sem isolamento, que é
   * o que motivou o embargo manual. Medido em produção: a sessão que reescrevia o acme era exatamente
   * assim (adopted:true, sem branch, sem worktree).
   */
  it("a sessão ADOTADA (sem árvore) declara território pelo BOARD — não some da sonda", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ sessionId: "adot1", agentId: "adot1", adopted: true, board: "acme" })],
      queued: [],
      boardPackage: (b) => (b === "acme" ? "packages/acmeapp/" : undefined),
    });
    expect(live).toHaveLength(1);
    expect(live[0].files).toEqual(["packages/acmeapp/"]);
    // Nomeia o motivo, não só o id: quem lê a recusa precisa entender por que um board inteiro está ocupado.
    expect(live[0].owner).toContain("sem árvore isolada");
  });

  it("sessão adotada SEM board declarado não vira território — não dá para inventar escopo", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ sessionId: "adot2", agentId: "adot2", adopted: true })],
      queued: [],
      boardPackage: () => "packages/acmeapp/",
    });
    expect(live).toEqual([]);
  });

  it("uma entrada SEM baseCommit é omitida (não dá para medir o delta, e chutar o branch inteiro mentiria)", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [],
      queued: [{ runId: "r1", branch: "agent/s1" }],
    });
    expect(live).toEqual([]);
  });
});

/**
 * REGRESSÃO (2026-07-23): a sonda travava a promoção do trabalho que a própria sessão JÁ integrou no
 * stage. Como `session.baseCommit` é a base de ABERTURA e não avança no submit, `baseCommit..branch`
 * incluía o código já submetido/integrado; a promoção de stage→main carrega esse mesmo código, e a
 * interseção (release.ts) batia → `concurrent-work` a cada tick enquanto a sessão dona seguisse viva.
 * Com N sessões via terminal, o deploy congelava. O fix: medir contra o HEAD do stage (`integrationRef`)
 * — trabalho integrado (conteúdo idêntico) some; sobra só o REALMENTE não-integrado.
 */
describe("liveWorkInRepo — não trava a promoção do trabalho JÁ integrado (fix multi-sessão)", () => {
  let root: string;
  let repo: string;
  let wt: string;
  let base: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "conc-integrated-"));
    repo = path.join(root, "repo");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "app", "a.ts"), "a\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "b.ts"), "b\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@t.t`, { cwd: repo });
    await exec(`git config user.name t`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q -m base`, { cwd: repo });
    base = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();

    // `stage` = a integração viva: a.ts foi para v2 (o trabalho da sessão, integrado) e b.ts para v2 (de
    // OUTRA sessão — a nossa está atrás dele).
    await exec(`git checkout -q -b stage`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "a.ts"), "a v2\n");
    await fsp.writeFile(path.join(repo, "packages", "app", "b.ts"), "b v2\n");
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q -m "trabalho no stage"`, { cwd: repo });
    await exec(`git checkout -q ${base}`, { cwd: repo }); // destaca na base, fora do branch stage

    // A sessão: commitou a.ts=v2 (IDÊNTICO ao stage — o trabalho dela que já integrou) E d.ts NOVO (ainda
    // não integrado). NÃO tocou b.ts → fica ATRÁS do stage nesse arquivo.
    wt = path.join(root, "wt-s2");
    await exec(`git worktree add -q -b agent/s2 ${JSON.stringify(wt)} ${base}`, { cwd: repo });
    await fsp.writeFile(path.join(wt, "packages", "app", "a.ts"), "a v2\n");
    await fsp.writeFile(path.join(wt, "packages", "app", "d.ts"), "d\n");
    await exec(`git add -A`, { cwd: wt });
    await exec(`git commit -q -m "trabalho da sessão (a.ts já integrado + d.ts novo)"`, { cwd: wt });
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(wt)} --force`, { cwd: repo }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("com integrationRef=stage: NÃO reporta o arquivo já integrado (a.ts) nem o que está atrás (b.ts) — só o novo (d.ts)", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ sessionId: "s2", agentId: "s2", branch: "agent/s2", baseCommit: base, worktreePath: wt })],
      queued: [],
      integrationRef: "stage",
    });
    expect(live).toHaveLength(1);
    // a.ts (idêntico ao stage → integrado) e b.ts (a sessão está atrás) SOMEM; só d.ts (real, não-integrado) fica.
    expect(live[0].files.sort()).toEqual(["packages/app/d.ts"]);
  });

  it("SEM integrationRef (fallback antigo): reportaria o arquivo já integrado (a.ts) — a prova do bug que o fix conserta", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ sessionId: "s2", agentId: "s2", branch: "agent/s2", baseCommit: base, worktreePath: wt })],
      queued: [],
    });
    expect(live).toHaveLength(1);
    // O comportamento ANTIGO: a.ts (já integrado) entra e travaria a promoção do próprio código.
    expect(live[0].files.sort()).toEqual(["packages/app/a.ts", "packages/app/d.ts"]);
  });
});

/**
 * REGRESSÃO (2026-07-28) — O DEADLOCK que o fix de 2026-07-23 não alcançou, porque ele consertava o caso
 * de arquivos DISJUNTOS e o embargo existe justamente para o caso SOBREPOSTO.
 *
 * Duas sessões mexem no MESMO arquivo. A integra primeiro; B integra depois, por cima. A partir daí, para
 * a sessão A: o arquivo está no diff-desde-a-base dela (ela mudou) E diverge do stage (que já carrega o
 * trabalho posterior de B) — a interseção NUNCA esvazia, e A embarga a publicação de B para sempre, mesmo
 * com a entrada dela `done` e a árvore limpa. Medido em produção: 33 tentativas seguradas, e 11 dos 15
 * pedidos segurados do histórico morreram `superseded` sem nunca publicar.
 *
 * O termo que decide passou a ser a FRONTEIRA DE INTEGRAÇÃO da própria sessão (`integrated`), que é local
 * e por isso não latcha.
 */
describe("liveWorkInRepo — sessão integrada NÃO embarga quem mexeu no mesmo arquivo depois", () => {
  let root: string;
  let repo: string;
  let wtA: string;
  let base: string;
  let integradoDeA: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "conc-deadlock-"));
    repo = path.join(root, "repo");
    await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
    await fsp.writeFile(path.join(repo, "packages", "app", "shared.ts"), "v0\n");
    await exec(`git init -q`, { cwd: repo });
    await exec(`git config user.email t@t.t`, { cwd: repo });
    await exec(`git config user.name t`, { cwd: repo });
    await exec(`git add -A`, { cwd: repo });
    await exec(`git commit -q -m base`, { cwd: repo });
    base = (await exec(`git rev-parse HEAD`, { cwd: repo })).stdout.trim();

    // Sessão A: muda shared.ts e SUBMETE. O train pina este sha e o integra.
    wtA = path.join(root, "wt-a");
    await exec(`git worktree add -q -b agent/a ${JSON.stringify(wtA)} ${base}`, { cwd: repo });
    await fsp.writeFile(path.join(wtA, "packages", "app", "shared.ts"), "v0 + A\n");
    await exec(`git add -A`, { cwd: wtA });
    await exec(`git commit -q -m "trabalho de A"`, { cwd: wtA });
    integradoDeA = (await exec(`git rev-parse HEAD`, { cwd: wtA })).stdout.trim();

    // `stage` recebe A e, DEPOIS, o trabalho de B no MESMO arquivo. É o que põe o branch de A atrás.
    await exec(`git checkout -q -b stage ${base}`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "shared.ts"), "v0 + A\n");
    await exec(`git commit -q -am "A integrado"`, { cwd: repo });
    await fsp.writeFile(path.join(repo, "packages", "app", "shared.ts"), "v0 + A + B\n");
    await exec(`git commit -q -am "B integrado por cima"`, { cwd: repo });
    await exec(`git checkout -q ${base}`, { cwd: repo });
  });

  afterAll(async () => {
    await exec(`git worktree remove ${JSON.stringify(wtA)} --force`, { cwd: repo }).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  });

  const sessaoA = () =>
    session({ sessionId: "a", agentId: "a", branch: "agent/a", baseCommit: base, worktreePath: wtA });

  it("SEM a fronteira de integração o embargo LATCHA — o arquivo já integrado de A segue reportado", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [sessaoA()],
      queued: [],
      integrationRef: "stage",
    });
    // A prova do deadlock: A não tem NADA pendente e mesmo assim ocupa o arquivo.
    expect(live).toEqual([{ owner: "agent/a", files: ["packages/app/shared.ts"] }]);
  });

  it("COM a fronteira de integração: A não reporta nada — o trabalho dela aterrissou", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [sessaoA()],
      queued: [],
      integrationRef: "stage",
      integrated: new Map([["a", integradoDeA]]),
    });
    expect(live).toEqual([]);
  });

  it("o que A commitar DEPOIS da integração volta a contar (a guarda não foi desligada)", async () => {
    await fsp.writeFile(path.join(wtA, "packages", "app", "novo.ts"), "novo\n");
    await exec(`git add -A`, { cwd: wtA });
    await exec(`git commit -q -m "trabalho novo, ainda não submetido"`, { cwd: wtA });
    try {
      const live = await liveWorkInRepo({
        exec,
        repoRoot: repo,
        sessions: [sessaoA()],
        queued: [],
        integrationRef: "stage",
        integrated: new Map([["a", integradoDeA]]),
      });
      expect(live).toEqual([{ owner: "agent/a", files: ["packages/app/novo.ts"] }]);
    } finally {
      await exec(`git reset -q --hard ${integradoDeA}`, { cwd: wtA });
    }
  });

  it("sha integrado FORA da história do branch (rebase do worktree_refresh) cai na base — conservador", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [sessaoA()],
      queued: [],
      integrationRef: "stage",
      // um sha real do repo, mas que NÃO é ancestral de agent/a — é o que sobra depois de um rebase.
      integrated: new Map([["a", "stage"]]),
    });
    expect(live).toEqual([{ owner: "agent/a", files: ["packages/app/shared.ts"] }]);
  });

  it("casa também pelo agentId — a árvore pertence ao agente, que sobrevive à reciclagem da sessão", async () => {
    const live = await liveWorkInRepo({
      exec,
      repoRoot: repo,
      sessions: [session({ sessionId: "reciclada", agentId: "a", branch: "agent/a", baseCommit: base, worktreePath: wtA })],
      queued: [],
      integrationRef: "stage",
      integrated: new Map([["a", integradoDeA]]),
    });
    expect(live).toEqual([]);
  });
});

describe("integratedShas — a fronteira é a ÚLTIMA aterrissagem de cada sessão", () => {
  it("fica com o pinnedSha do `done` mais recente", () => {
    const m = integratedShas([
      { runId: "s1", status: "done", pinnedSha: "velho", mergeEndedAt: 100 },
      { runId: "s1", status: "done", pinnedSha: "novo", mergeEndedAt: 200 },
    ]);
    expect(m.get("s1")).toBe("novo");
  });

  it("ignora o que não aterrissou — em voo, falho ou devolvido não são fronteira", () => {
    const m = integratedShas([
      { runId: "s1", status: "waiting", pinnedSha: "a" },
      { runId: "s2", status: "failed", pinnedSha: "b" },
      { runId: "s3", status: "returned-to-session", pinnedSha: "c" },
      { runId: "s4", status: "merging", pinnedSha: "d" },
    ]);
    expect(m.size).toBe(0);
  });

  it("uma entrada `done` sem sha pinado não vira fronteira (não dá para medir de um sha que não existe)", () => {
    expect(integratedShas([{ runId: "s1", status: "done" }]).size).toBe(0);
  });
});
