import { describe, expect, it, vi } from "vitest";
import {
  hasOpenDeployFailure,
  reconcileVerdict,
  readLastDeploySha,
  makeGitContains,
  measureDeployAncestry,
  measureDataOnlySettle,
  applyDeploySettleSuccess,
  settleDeploySuccess,
  scopedDeployDelta,
  monorepoDeltaCount,
  deployUnitScope,
  readDeployUnitShas,
  deployStatePath,
  deployRiskSummary,
  type SettleDeploySuccessDeps,
} from "./deploy-reconcile";
import { DEPLOY_FAILURE_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID } from "@/lib/storymap/demands";
import { resetPublishBreakerForTest } from "./publish-breaker";
import type { ExecFn } from "./worktree";
import type { BoardConfig, Card } from "@/lib/storymap/types";

/** Um card "No ar" carregando o alarme de deploy — a forma exata de cards que ficaram travados num caso real. */
function cardWithAlarm(over: Partial<Card> = {}): Card {
  return {
    id: "s1",
    type: "story",
    status: "concluida",
    findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "falhou" }],
    releasedSha: "aaaa111",
    deployTargets: ["acmeapp", "acme-site"],
    ...over,
  } as unknown as Card;
}

/** Evidência: o último deploy de cada alvo. `contains` simula `git merge-base --is-ancestor`. */
const deployed = (m: Record<string, string | null>) => async (t: string) => m[t] ?? null;
const containsIf = (pairs: Array<[string, string]>) => async (a: string, d: string) =>
  pairs.some(([x, y]) => x === a && y === d);

describe("deploy-reconcile — o deploy-failure é uma AFIRMAÇÃO re-verificável, não uma lápide", () => {
  it("RESOLVE quando o código do card está contido no último deploy de TODOS os alvos (o caso real)", async () => {
    // A prova empírica que motivou o desenho: releasedSha ⊆ lastDeploySha nos dois alvos.
    const v = await reconcileVerdict(
      cardWithAlarm(),
      deployed({ acmeapp: "bbbb222", "acme-site": "cccc333" }),
      containsIf([
        ["aaaa111", "bbbb222"],
        ["aaaa111", "cccc333"],
      ]),
    );
    expect(v).toEqual({ resolved: true, via: ["acmeapp", "acme-site"] });
  });

  it("NÃO resolve quando só UM dos alvos subiu — meio-deploy é exatamente o 'rosto novo, backend velho'", async () => {
    const v = await reconcileVerdict(
      cardWithAlarm(),
      deployed({ acmeapp: "bbbb222", "acme-site": "cccc333" }),
      containsIf([["aaaa111", "bbbb222"]]), // a face NÃO contém o código
    );
    expect(v).toEqual({ resolved: false, reason: "deploy-anterior-ao-codigo" });
  });

  it("NÃO resolve quando o deploy do alvo é ANTERIOR ao código (o alarme é verdadeiro — o card não está no ar)", async () => {
    const v = await reconcileVerdict(
      cardWithAlarm({ deployTargets: ["acmeapp"] }),
      deployed({ acmeapp: "old000" }),
      containsIf([]), // nenhuma ancestralidade → o deploy rodou antes do código pousar
    );
    expect(v.resolved).toBe(false);
  });

  // ── As guardas conservadoras. Evidência ausente NUNCA vira "está no ar": um falso-positivo faz o card
  // MENTIR, que é o defeito que este subsistema inteiro existe para impedir. A assimetria é deliberada.
  it("sem releasedSha (card antigo, pré-carimbo) → não opina", async () => {
    const v = await reconcileVerdict(
      cardWithAlarm({ releasedSha: undefined }),
      deployed({ acmeapp: "bbbb222" }),
      containsIf([]),
    );
    expect(v).toEqual({ resolved: false, reason: "sem-released-sha" });
  });

  it("sem deployTargets → não opina (não adivinha quais unidades importam)", async () => {
    const v = await reconcileVerdict(cardWithAlarm({ deployTargets: [] }), deployed({}), containsIf([]));
    expect(v).toEqual({ resolved: false, reason: "sem-alvos" });
  });

  it("alvo sem arquivo de estado de deploy (nunca publicado) → não opina", async () => {
    const v = await reconcileVerdict(
      cardWithAlarm({ deployTargets: ["acmeapp"] }),
      deployed({ acmeapp: null }),
      containsIf([["aaaa111", "bbbb222"]]),
    );
    expect(v).toEqual({ resolved: false, reason: "alvo-sem-deploy" });
  });

  it("card SEM o alarme aberto é ignorado (não reabre nem re-escreve nada)", async () => {
    const fixed = cardWithAlarm({
      findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "fixed", title: "x" }],
    } as Partial<Card>);
    const v = await reconcileVerdict(fixed, deployed({ acmeapp: "bbbb222" }), containsIf([["aaaa111", "bbbb222"]]));
    expect(v).toEqual({ resolved: false, reason: "sem-finding-aberto" });
  });

  it("hasOpenDeployFailure só enxerga o finding CANÔNICO aberto (outros findings não travam o card)", () => {
    expect(hasOpenDeployFailure(cardWithAlarm())).toBe(true);
    expect(
      hasOpenDeployFailure({
        id: "s2",
        type: "story",
        findings: [{ id: "outro", lens: "general", severity: "high", status: "open", title: "x" }],
      } as unknown as Card),
    ).toBe(false);
  });
});

describe("deploy-reconcile — leitura da evidência (fail-closed em toda falha de IO)", () => {
  // O molde do arquivo de estado é DECLARADO pelo alvo (`deploy.legacy.state`): estes casos o injetam, em vez de ler o settings da máquina.
  const ESTADO = "estado-das-publicacoes/{target}.json";

  it("readLastDeploySha devolve null quando o arquivo não existe (sem evidência ⇒ não resolve)", async () => {
    expect(await readLastDeploySha("/tmp/nao-existe-repo-xyz", "acmeapp", ESTADO)).toBeNull();
  });

  it("readLastDeploySha rejeita um id de alvo com traversal (o caminho nunca escapa do molde)", async () => {
    // sanitização: "../../etc" vira "etcpasswd" → no máximo lê um arquivo inexistente DENTRO do molde, nunca sobe na árvore
    expect(await readLastDeploySha("/tmp/nao-existe-repo-xyz", "../../etc/passwd", ESTADO)).toBeNull();
    expect(deployStatePath("/repo", "../../etc/passwd", ESTADO)).toBe("/repo/estado-das-publicacoes/etcpasswd.json");
    expect(deployStatePath("/repo", "../..", ESTADO)).toBeNull(); // nada sobrou do id ⇒ nenhum caminho
  });

  it("deployStatePath: o caminho é o do molde DECLARADO com {target} expandido (qualquer layout, nenhum suposto)", () => {
    expect(deployStatePath("/repo", "acmeapp", "estado-das-publicacoes/{target}.json")).toBe("/repo/estado-das-publicacoes/acmeapp.json");
    expect(deployStatePath("/repo", "acmeapp", "ops/{target}/ultimo.json")).toBe("/repo/ops/acmeapp/ultimo.json");
  });

  it("SEM molde declarado não há evidência: null (nunca «no ar» por acidente) e UM aviso diz a chave a declarar", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(deployStatePath("/repo", "acmeapp", null)).toBeNull();
      expect(await readLastDeploySha("/repo", "acmeapp", null)).toBeNull();
      expect(await readDeployUnitShas("/repo", "acmeapp", null)).toBeNull();
      const avisos = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("deploy.legacy.state"));
      expect(avisos.length, "o aviso sai UMA vez por processo, não a cada leitura").toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("readLastDeploySha lê o `lastDeploySha` do arquivo DECLARADO", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "last-sha-"));
    try {
      mkdirSync(path.join(root, "estado-das-publicacoes"), { recursive: true });
      writeFileSync(path.join(root, "estado-das-publicacoes", "bicicleta.json"), JSON.stringify({ lastDeploySha: "abc1234" }));
      writeFileSync(path.join(root, "estado-das-publicacoes", "ruim.json"), JSON.stringify({ lastDeploySha: "não-é-sha" }));
      expect(await readLastDeploySha(root, "bicicleta", ESTADO)).toBe("abc1234");
      expect(await readLastDeploySha(root, "ruim", ESTADO)).toBeNull();
      // outro layout declarado ⇒ o arquivo do primeiro layout NÃO é lido
      expect(await readLastDeploySha(root, "bicicleta", "outro-lugar/{target}.json")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deployRiskSummary usa o escopo e o estado DECLARADOS; sem escopo declarado diz qual chave declarar", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "risk-"));
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("rev-list") ? { stdout: "7\n", stderr: "" } : { stdout: "aaa1111 mexe na bicicleta\n", stderr: "" };
    };
    try {
      mkdirSync(path.join(root, "estado-das-publicacoes"), { recursive: true });
      writeFileSync(path.join(root, "estado-das-publicacoes", "bicicleta.json"), JSON.stringify({ lastDeploySha: "abc1234" }));
      const declarado = await deployRiskSummary(exec, root, "bicicleta", { scope: ["oficinas/{target}/"], state: ESTADO });
      expect(declarado.baseSha).toBe("abc1234");
      expect(declarado.monorepoSinceBase).toBe(7);
      expect(declarado.scoped.count).toBe(1);
      expect(calls.some((c) => c.includes('"oficinas/bicicleta/"'))).toBe(true);
      expect(declarado.note).toContain("(escopo: oficinas/bicicleta/, deps compartilhadas à parte): 1");
      // sem escopo declarado: nenhum delta escopado é contado e a nota diz o que declarar
      const semEscopo = await deployRiskSummary(exec, root, "bicicleta", { scope: [], state: ESTADO });
      expect(semEscopo.scoped.count).toBe(0);
      expect(semEscopo.note).toMatch(/settings\.yaml → deploy\.legacy\.scope/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makeGitContains: exit 0 = contém; exit≠0 (ou git ilegível) = NÃO contém — nunca 'no ar' por acidente", async () => {
    const ok = makeGitContains(async () => ({ stdout: "", stderr: "" }), "/repo");
    expect(await ok("a", "b")).toBe(true);

    const nope = makeGitContains(async () => {
      throw Object.assign(new Error("exit 1"), { code: 1 });
    }, "/repo");
    expect(await nope("a", "b")).toBe(false);

    const broken = makeGitContains(async () => {
      throw new Error("git não encontrado");
    }, "/repo");
    expect(await broken("a", "b")).toBe(false); // erro desconhecido também é NÃO (fail-closed)
  });
});

// ── WS-3 — o settle de SUCESSO: prova → carimbo → terminal (a régua única, reusada) ─────────

/** O pipeline mínimo com o passo que CARREGA o deploy + o terminal gatado — a forma do _base pós-deploy-truth. */
const settleConfig: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "release", name: "Liberar" },
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" },
    { id: "concluida", name: "No ar", gate: "hasDeployProof", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
} as unknown as BoardConfig;

/** Um card COM código, ESPERANDO em Publicando (a forma nova do WS-3). */
function waitingCard(over: Partial<Card> = {}): Card {
  return {
    id: "s1",
    type: "story",
    title: "t",
    status: "deploy",
    stagedAt: "2026-07-16",
    releasedSha: "aaaa111",
    deployTargets: ["acmeapp"],
    deployFiredAt: "2026-07-17T11:00:00.000Z",
    findings: [],
    order: 10,
    created: null,
    updated: null,
    body: "",
    ...over,
  } as unknown as Card;
}

const OPTS = { source: "registry-ondone" as const, now: "2026-07-17T12:00:00.000Z", today: "2026-07-17" };

describe("applyDeploySettleSuccess — PURO: a decisão completa de um settle ok", () => {
  it("prova medida ⇒ carimba deployProof + limpa deployFiredAt + avança deploy → concluida PELO GATE", () => {
    const d = applyDeploySettleSuccess(waitingCard(), settleConfig, { proven: true, sha: "aaaa111", targets: ["acmeapp"] }, OPTS);
    expect(d.advancedTo).toBe("concluida");
    expect(d.stampedProof).toBe(true);
    expect(d.next).toMatchObject({
      status: "concluida",
      deployProof: { sha: "aaaa111", targets: ["acmeapp"], at: OPTS.now, source: "registry-ondone" },
    });
    expect(d.next!.deployFiredAt).toBeUndefined();
  });

  it("settle ok SEM prova ⇒ card FICA em Publicando COM deployFiredAt (o watchdog segue armado) — fail-closed", () => {
    const d = applyDeploySettleSuccess(waitingCard(), settleConfig, { proven: false, reason: "deploy-anterior-ao-codigo" }, OPTS);
    expect(d.advancedTo).toBeNull();
    expect(d.heldReason).toMatch(/deploy-anterior-ao-codigo/);
    expect(d.proven).toBe(false); // é isto que dá a um card de CARONA o deploy próprio (deploy-attached.ts)
    // O card FICA: mesmo status, watchdog armado (um alvo pode provar depois — a face encadeada).
    expect(d.next!.status).toBe("deploy");
    expect(d.next!.deployFiredAt).toBe("2026-07-17T11:00:00.000Z");
  });

  // Num caso real, o settle chegou OK e não provou (`codigo-sem-release`) — e isso só existia no log.
  // O Inbox mostrava um item «espera sua aprovação» sem nada para aprovar. O settle que segura o card agora DEIXA
  // O MOTIVO NO CARD (um finding próprio, em português e com o conserto), que é o que o Inbox lê.
  it("settle ok SEM prova ⇒ o motivo fica NO CARD, em português, com o que resolve", () => {
    const d = applyDeploySettleSuccess(
      waitingCard({ releasedSha: undefined, stagedAt: undefined, commitRange: { base: "b0", head: "h9" } } as Partial<Card>),
      settleConfig,
      { proven: false, reason: "codigo-sem-release" },
      OPTS,
    );
    const f = d.next!.findings!.find((x) => x.id === DEPLOY_UNPROVEN_FINDING_ID);
    expect(f).toMatchObject({ status: "open", severity: "high" });
    expect(f!.title).toMatch(/deploy rodou/i);
    expect(f!.detail).toMatch(/nenhum release registrou/); // o motivo, sem jargão
    expect(f!.detail).toContain("codigo-sem-release"); // e o código, para quem for investigar
    expect(f!.suggestion).toMatch(/Re-publicar/); // o conserto
  });

  it("o mesmo motivo no settle seguinte não reescreve o card; a prova que chega depois o resolve", () => {
    const held = applyDeploySettleSuccess(waitingCard(), settleConfig, { proven: false, reason: "deploy-anterior-ao-codigo" }, OPTS).next!;
    const again = applyDeploySettleSuccess(held, settleConfig, { proven: false, reason: "deploy-anterior-ao-codigo" }, OPTS);
    expect(again.next).toBeNull(); // nada mudou ⇒ write pulado
    const proven = applyDeploySettleSuccess(held, settleConfig, { proven: true, sha: "aaaa111", targets: ["acmeapp"] }, OPTS);
    expect(proven.advancedTo).toBe("concluida");
    expect(proven.next!.findings!.find((x) => x.id === DEPLOY_UNPROVEN_FINDING_ID)?.status).toBe("fixed");
  });

  it("`proven` separa «o deploy não carregou o código» de «provado e avançado»", () => {
    expect(applyDeploySettleSuccess(waitingCard(), settleConfig, { proven: true, sha: "aaaa111", targets: ["acmeapp"] }, OPTS).proven).toBe(true);
    const noCode = waitingCard({ stagedAt: undefined, releasedSha: undefined, deployTargets: undefined });
    expect(applyDeploySettleSuccess(noCode, settleConfig, null, OPTS).proven).toBe(true); // nada a provar
  });

  it("card SEM código (sem stagedAt e sem commitRange) avança SEM carimbo — nada a provar (D-DT8)", () => {
    const noCode = waitingCard({ stagedAt: undefined, releasedSha: undefined, deployTargets: undefined });
    const d = applyDeploySettleSuccess(noCode, settleConfig, null, OPTS);
    expect(d.advancedTo).toBe("concluida");
    expect(d.stampedProof).toBe(false);
    expect(d.next!.deployProof).toBeUndefined(); // prova não é inventada — o gate passa pela régua no-code
    expect(d.next!.deployFiredAt).toBeUndefined();
  });

  it("settle ok resolve o finding deploy-failure obsoleto (recuperação revert → reentra → ok)", () => {
    const c = waitingCard({
      findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "falhou" }],
    } as Partial<Card>);
    const d = applyDeploySettleSuccess(c, settleConfig, { proven: true, sha: "aaaa111", targets: ["acmeapp"] }, OPTS);
    expect(d.next!.findings![0].status).toBe("fixed");
    expect(d.advancedTo).toBe("concluida");
  });

  it("card TERMINAL histórico sem nada a limpar é INTOCADO (write pulado — sem migração/backfill)", () => {
    const done = waitingCard({ status: "concluida", deployFiredAt: undefined });
    const d = applyDeploySettleSuccess(done, settleConfig, { proven: false, reason: "sem-alvos" }, OPTS);
    expect(d.next).toBeNull();
    expect(d.advancedTo).toBeNull();
  });

  it("card terminal EM TRÂNSITO (era otimista) com prova: ganha carimbo + limpeza, mas NÃO se move", () => {
    const inTransit = waitingCard({ status: "concluida" });
    const d = applyDeploySettleSuccess(inTransit, settleConfig, { proven: true, sha: "aaaa111", targets: ["acmeapp"] }, OPTS);
    expect(d.next!.status).toBe("concluida"); // já terminal — nenhum move
    expect(d.next!.deployProof?.sha).toBe("aaaa111");
    expect(d.next!.deployFiredAt).toBeUndefined();
    expect(d.advancedTo).toBeNull();
  });

  it("evidenceOnly (reconcile-evidence) SEM prova em card com código = no-op absoluto (sem autoridade)", () => {
    const c = waitingCard({
      findings: [{ id: DEPLOY_FAILURE_FINDING_ID, lens: "general", severity: "high", status: "open", title: "x" }],
    } as Partial<Card>);
    const d = applyDeploySettleSuccess(c, settleConfig, { proven: false, reason: "alvo-sem-deploy" }, {
      ...OPTS,
      source: "reconcile-evidence",
      evidenceOnly: true,
    });
    expect(d.next).toBeNull(); // nem o finding é resolvido — evidência ausente não é um settle
  });

  it("prova DATA-ONLY (follow-up A): carimba {sha de main, targets: [board-data]} e atravessa PELO gate hasDeployProof", () => {
    // O gate NÃO mudou: continua exigindo o carimbo. O que muda é que o settle SABE carimbar este caso —
    // e a travessia abaixo passa pelo checkGate REAL (gate-core), não por um bypass.
    const c = waitingCard({
      stagedAt: undefined,
      releasedSha: undefined,
      deployTargets: undefined,
      commitRange: { base: "r0", head: "r9" },
    } as Partial<Card>);
    const d = applyDeploySettleSuccess(
      c,
      settleConfig,
      { proven: true, sha: "main999", targets: ["board-data"], dataOnlyRange: { base: "r0", head: "r9" } },
      { ...OPTS, source: "reconcile-evidence", evidenceOnly: true },
    );
    expect(d.advancedTo).toBe("concluida");
    expect(d.stampedProof).toBe(true);
    expect(d.next).toMatchObject({
      status: "concluida",
      deployProof: { sha: "main999", targets: ["board-data"], at: OPTS.now, source: "reconcile-evidence" },
    });
    expect(d.next!.deployFiredAt).toBeUndefined();
  });

  it("perguntas abertas são resolvidas como stale ao entrar no terminal (mesma regra do forward da cascata)", () => {
    const c = waitingCard({
      questions: [{ id: "q1", text: "?", askedBy: "harness-review", askedAt: "2026-07-16", status: "open" }],
    } as unknown as Partial<Card>);
    const d = applyDeploySettleSuccess(c, settleConfig, { proven: true, sha: "aaaa111", targets: ["acmeapp"] }, OPTS);
    expect(d.next!.questions![0].status).toBe("answered");
  });
});

/** O write de um settle que chegou e NÃO provou: o card fica onde estava, com o watchdog, e ganha o MOTIVO. */
function expectHeldWrite(writes: Card[], reason: string) {
  expect(writes).toHaveLength(1);
  expect(writes[0].status).toBe("deploy");
  expect(writes[0].deployFiredAt).toBeTruthy();
  expect(writes[0].deployProof).toBeUndefined();
  const f = writes[0].findings?.find((x) => x.id === DEPLOY_UNPROVEN_FINDING_ID);
  expect(f?.status).toBe("open");
  expect(f?.detail).toContain(`(código: ${reason})`);
}

describe("settleDeploySuccess — IO com DI: mede pela régua única e escreve sob o lock", () => {
  /** Monta deps 100% fake — nada de git/fs/disco; captura o write e a transition. */
  function makeDeps(card: Card, over: Partial<SettleDeploySuccessDeps> = {}) {
    const writes: Card[] = [];
    const transitions: unknown[] = [];
    const reevaluated: string[] = [];
    const deps: SettleDeploySuccessDeps = {
      repoRoot: "/repo",
      exec: (async () => ({ stdout: "", stderr: "" })) as ExecFn,
      readConfig: async () => settleConfig,
      readBoardCards: async () => [card],
      write: (async (_b: string, _c: string, mutate: (cur: Card) => Card | null) => {
        const next = mutate(card);
        if (next) writes.push(next);
        return next;
      }) as unknown as typeof import("@/lib/storymap/write").updateCardOnDisk,
      transition: (async (t: unknown) => {
        transitions.push(t);
      }) as unknown as SettleDeploySuccessDeps["transition"],
      reevaluate: async (_b, c) => {
        reevaluated.push(c);
      },
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      ...over,
    };
    return { deps, writes, transitions, reevaluated };
  }

  it("alvo ÚNICO publicado (ancestralidade ok) ⇒ carimba deployProof com o sha REAL medido + avança (teste 3)", async () => {
    const card = waitingCard();
    const { deps, writes, transitions, reevaluated } = makeDeps(card, {
      deployedShaFor: async (t) => (t === "acmeapp" ? "bbbb222" : null),
      contains: async (a, d2) => a === "aaaa111" && d2 === "bbbb222",
    });
    const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
    expect(d?.advancedTo).toBe("concluida");
    expect(writes[0].deployProof).toMatchObject({ sha: "aaaa111", targets: ["acmeapp"], source: "registry-ondone" });
    expect(transitions[0]).toMatchObject({ from: "deploy", to: "concluida", actor: "system", note: "deploy:settled:registry-ondone" });
    expect(reevaluated).toEqual(["s1"]);
  });

  // O disjuntor da publicação (publish-breaker.ts): o deploy terminou BEM ⇒ a contagem de falhas seguidas zera — provado ou
  // não. "Sem prova" é o finding deploy-unproven, outra coisa; deixar a contagem viva faria o próximo revert (uma falha
  // sem relação, semanas depois) herdar um recuo de horas que este sucesso já pagou.
  it("o deploy terminou bem ⇒ zera o disjuntor da publicação do card — mesmo quando a prova não fecha", async () => {
    const cleared: string[] = [];
    const clearPublishBreaker = async (b: string, c: string) => void cleared.push(`${b}/${c}`);
    const proven = makeDeps(waitingCard(), { deployedShaFor: async () => "bbbb222", contains: async () => true, clearPublishBreaker });
    await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps: proven.deps });
    expect(cleared).toEqual(["b/s1"]);

    cleared.length = 0;
    const unproven = makeDeps(waitingCard(), { deployedShaFor: async () => null, contains: async () => false, clearPublishBreaker });
    const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps: unproven.deps });
    expect(d?.advancedTo).toBeNull(); // não provou, não avançou…
    expect(cleared).toEqual(["b/s1"]); // …mas o deploy rodou bem: a contagem de falhas zera
  });

  it("o FREIO nunca impede o settle: sem o registro do disjuntor o card ainda avança ao provar", async () => {
    resetPublishBreakerForTest();
    vi.stubEnv("AGILEHARNESS_RUNNER_STATE_DIR", ""); // sob o vitest, `runnerStateDir()` lança sem o override
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { deps } = makeDeps(waitingCard(), { deployedShaFor: async () => "bbbb222", contains: async () => true }); // sem clearPublishBreaker ⇒ o de produção
      const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
      expect(d?.advancedTo).toBe("concluida");
    } finally {
      vi.unstubAllEnvs();
      err.mockRestore();
    }
  });

  // Reescrito de propósito: a linha do disjuntor é da CAUSA. A evidência que avança UM card (sem código, ou já no ar)
  // não prova que a causa acabou — soltar a linha faria os outros cards dela re-tentarem contra a mesma recusa. Só o card
  // sai da linha (forget); quem solta a linha inteira é o deploy que terminou bem (clear, acima).
  it("a varredura por EVIDÊNCIA: sem prova não mexe; com prova tira SÓ o card da linha — nunca solta a causa", async () => {
    const cleared: string[] = [];
    const forgotten: string[] = [];
    const clearPublishBreaker = async (b: string, c: string) => void cleared.push(`${b}/${c}`);
    const forgetPublishBreaker = async (b: string, c: string) => void forgotten.push(`${b}/${c}`);
    // sem prova (nada publicado ainda): a tentativa pode estar em voo — a contagem de falhas fica
    const noProof = makeDeps(waitingCard(), { deployedShaFor: async () => null, contains: async () => false, clearPublishBreaker, forgetPublishBreaker });
    await settleDeploySuccess("b", "s1", { source: "reconcile-evidence", deps: noProof.deps });
    expect([...cleared, ...forgotten]).toEqual([]);
    // com prova (publicado fora do board, p.ex. pela CLI): o card avança e sai da linha; a causa segue segurando os outros
    const proof = makeDeps(waitingCard(), { deployedShaFor: async () => "bbbb222", contains: async () => true, clearPublishBreaker, forgetPublishBreaker });
    const d = await settleDeploySuccess("b", "s1", { source: "reconcile-evidence", deps: proof.deps });
    expect(d?.advancedTo).toBe("concluida");
    expect(forgotten).toEqual(["b/s1"]);
    expect(cleared).toEqual([]);
  });

  // Num board só-negócio a publicação entra no registro de decisões do sistema, com o «Desfazer»
  // para o sha que estava no ar antes (a prova anterior do card, senão a base do intervalo dele). Board human: não.
  it("só-negócio: a publicação provada vai para o registro de decisões, com o sha anterior para desfazer", async () => {
    const card = waitingCard({ deployProof: { sha: "old0001", targets: ["acmeapp"], at: "2026-07-10", source: "registry-ondone" } } as Partial<Card>);
    const recordDecision = vi.fn(async () => {});
    const { deps } = makeDeps(card, {
      readConfig: async () => ({ ...settleConfig, autonomy: { mode: "ultra" } }),
      deployedShaFor: async (t) => (t === "acmeapp" ? "bbbb222" : null),
      contains: async (a, d2) => a === "aaaa111" && d2 === "bbbb222",
      recordDecision,
    });
    await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "publish", cardId: "s1", undo: { kind: "republish-previous", cardId: "s1", sha: "aaaa111", previousSha: "old0001" } }),
    );
    const human = vi.fn(async () => {});
    await settleDeploySuccess("b", "s1", {
      source: "registry-ondone",
      deps: makeDeps(waitingCard(), { deployedShaFor: async () => "bbbb222", contains: async () => true, recordDecision: human }).deps,
    });
    expect(human).not.toHaveBeenCalled();
  });

  it("backend ok mas FACE chained pendente ⇒ NÃO avança (a régua exige TODOS os alvos); face ok ⇒ avança (teste 4)", async () => {
    const card = waitingCard({ deployTargets: ["acmeapp", "acme-site"] });
    // 1º settle (backend): a face ainda não publicou o sha do card.
    const pending = makeDeps(card, {
      deployedShaFor: async (t) => (t === "acmeapp" ? "bbbb222" : "old0000"),
      contains: async (a, d2) => a === "aaaa111" && d2 === "bbbb222",
    });
    const d1 = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps: pending.deps });
    expect(d1?.advancedTo).toBeNull();
    // o card segue em Publicando com o watchdog armado — e agora com o MOTIVO (a face ainda não publicou)
    expectHeldWrite(pending.writes, "deploy-anterior-ao-codigo");
    expect(card.deployFiredAt).toBeTruthy();
    // 2º settle (face publicou): agora TODOS os alvos contêm o sha ⇒ prova + avanço.
    const done = makeDeps(card, {
      deployedShaFor: async (t) => (t === "acmeapp" ? "bbbb222" : "cccc333"),
      contains: async (a, d2) => a === "aaaa111" && (d2 === "bbbb222" || d2 === "cccc333"),
    });
    const d2 = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps: done.deps });
    expect(d2?.advancedTo).toBe("concluida");
    expect(done.writes[0].deployProof?.targets).toEqual(["acmeapp", "acme-site"]);
  });

  it("SELF-deploy (webhook, sem targets): mede contra o HEAD do checkout — mesma régua de ancestralidade", async () => {
    const card = waitingCard({ deployTargets: undefined });
    const { deps, writes } = makeDeps(card, {
      headSha: async () => "head999",
      contains: async (a, d2) => a === "aaaa111" && d2 === "head999",
    });
    const d = await settleDeploySuccess("b", "s1", { source: "settle-webhook", selfDeploy: true, deps });
    expect(d?.advancedTo).toBe("concluida");
    expect(writes[0].deployProof).toMatchObject({ sha: "aaaa111", targets: ["self"], source: "settle-webhook" });
  });

  // ── C2 do plano da inversão: a prova sai do repositório DA FERRAMENTA ─────────────────────────────
  // A prova do self-deploy afirma "o artefato publicado é o serviço reconstruído do checkout — o sha
  // publicado é o HEAD de onde o build rodou". Ela media o HEAD do ALVO. Enquanto as duas árvores
  // coincidiram isso foi verdade por acidente; quando divergem, a frase vira mentira e o card vai a
  // "No Ar" com prova de outro repositório. Este caso NÃO injeta `headSha`/`contains` de propósito:
  // é o caminho REAL, com o exec de verdade, que precisa ser medido.
  it("SELF-deploy: o HEAD e a ancestralidade saem da raiz da FERRAMENTA, não da do alvo", async () => {
    const card = waitingCard({ deployTargets: undefined });
    const cwds: string[] = [];
    const { deps } = makeDeps(card, {
      repoRoot: "/alvo",
      toolRoot: "/ferramenta",
      exec: (async (cmd: string, o?: { cwd?: string }) => {
        cwds.push(`${o?.cwd ?? "?"} :: ${cmd}`);
        // HEAD da ferramenta; e a ancestralidade (git merge-base --is-ancestor) sai 0 = contido
        return { stdout: cmd.includes("rev-parse HEAD") ? "headFerramenta\n" : "", stderr: "" };
      }) as unknown as ExecFn,
    });

    await settleDeploySuccess("b", "s1", { source: "settle-webhook", selfDeploy: true, deps });

    const head = cwds.find((c) => c.includes("rev-parse HEAD"));
    expect(head, "o HEAD do self-deploy não foi medido").toBeTruthy();
    expect(head).toContain("/ferramenta ::");
    expect(head).not.toContain("/alvo ::");
    // e a ancestralidade sai da MESMA raiz do head: ela só significa algo dentro de UM repositório.
    for (const c of cwds.filter((x) => x.includes("merge-base") || x.includes("rev-list"))) {
      expect(c).toContain("/ferramenta ::");
    }
  });

  it("card com código SEM targets e SEM self-deploy ⇒ não prova (sem-alvos), card fica (fail-closed)", async () => {
    const card = waitingCard({ deployTargets: [] });
    const { deps, writes } = makeDeps(card);
    const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
    expect(d?.advancedTo).toBeNull();
    expect(d?.heldReason).toMatch(/sem-alvos/);
    expectHeldWrite(writes, "sem-alvos");
  });

  // ── Follow-up A — o fio do settle para a classe-limbo data-only ────────────────────────────────────────

  /** O card data-only PRESO em Publicando: commitRange do harness-review, nada staged/promovido, nenhum alvo. */
  const dataOnlyCard = (over: Partial<Card> = {}) =>
    waitingCard({
      stagedAt: undefined,
      releasedSha: undefined,
      deployTargets: undefined,
      commitRange: { base: "r0", head: "r9" },
      ...over,
    } as Partial<Card>);

  it("data-only ATRAVESSA: a varredura por evidência prova pela metade de dados e carimba {sha de main, board-data}", async () => {
    const card = dataOnlyCard();
    const { deps, writes, transitions } = makeDeps(card, {
      measureDataOnly: async (r) => ({ proven: true, sha: "main999", targets: ["board-data"], dataOnlyRange: r }),
    });
    const d = await settleDeploySuccess("b", "s1", { source: "reconcile-evidence", deps });
    expect(d?.advancedTo).toBe("concluida");
    expect(d?.stampedProof).toBe(true);
    expect(writes[0].deployProof).toMatchObject({ sha: "main999", targets: ["board-data"], source: "reconcile-evidence" });
    expect(writes[0].deployFiredAt).toBeUndefined();
    expect(transitions[0]).toMatchObject({ from: "deploy", to: "concluida", note: "deploy:settled:reconcile-evidence" });
  });

  it("card MISTO sem release segue preso: a varredura por evidência sem prova é no-op ABSOLUTO", async () => {
    const card = dataOnlyCard();
    const { deps, writes } = makeDeps(card, {
      measureDataOnly: async () => ({ proven: false, reason: "codigo-sem-release" }),
    });
    const d = await settleDeploySuccess("b", "s1", { source: "reconcile-evidence", deps });
    expect(d?.advancedTo).toBeNull();
    expect(writes).toEqual([]); // evidenceOnly + não-provado ⇒ nem toca o card (watchdog segue armado)
    expect(card.deployFiredAt).toBeTruthy();
  });

  it("num settle REAL (registry-ondone) o motivo aparece no heldReason: misto ⇒ codigo-sem-release; medição falha ⇒ medicao-indisponivel", async () => {
    for (const reason of ["codigo-sem-release", "medicao-indisponivel"] as const) {
      const { deps, writes } = makeDeps(dataOnlyCard(), {
        measureDataOnly: async () => ({ proven: false, reason }),
      });
      const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
      expect(d?.advancedTo).toBeNull();
      expect(d?.heldReason).toContain(reason);
      expectHeldWrite(writes, reason); // o motivo sai do log e vai para o card
    }
  });

  it("a medição data-only SÓ entra sem releasedSha: card promovido segue na régua de ancestralidade", async () => {
    const calls: unknown[] = [];
    const card = waitingCard({ commitRange: { base: "r0", head: "r9" } } as Partial<Card>); // releasedSha presente
    const { deps, writes } = makeDeps(card, {
      measureDataOnly: async (r) => {
        calls.push(r);
        return { proven: false, reason: "medicao-indisponivel" };
      },
      deployedShaFor: async () => "bbbb222",
      contains: async (a, d2) => a === "aaaa111" && d2 === "bbbb222",
    });
    const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
    expect(calls).toEqual([]); // ancestralidade manda quando há release
    expect(d?.advancedTo).toBe("concluida");
    expect(writes[0].deployProof).toMatchObject({ sha: "aaaa111", targets: ["acmeapp"] });
  });

  it("staleness da prova data-only sob o lock: o card ganhou releasedSha no meio ⇒ prova DESCARTADA (ancestralidade passa a mandar)", async () => {
    const card = dataOnlyCard();
    const writes: Card[] = [];
    const { deps } = makeDeps(card, {
      measureDataOnly: async (r) => ({ proven: true, sha: "main999", targets: ["board-data"], dataOnlyRange: r }),
      write: (async (_b: string, _c: string, mutate: (cur: Card) => Card | null) => {
        const fresh = dataOnlyCard({ releasedSha: "nova999" } as Partial<Card>);
        const next = mutate(fresh);
        if (next) writes.push(next);
        return next;
      }) as unknown as SettleDeploySuccessDeps["write"],
    });
    const d = await settleDeploySuccess("b", "s1", { source: "reconcile-evidence", deps });
    expect(d?.advancedTo).toBeNull();
    expect(writes).toEqual([]); // nunca terminar um card com código promovido via prova de board-data
  });

  it("staleness da prova data-only sob o lock: o commitRange mudou no meio ⇒ prova DESCARTADA", async () => {
    const card = dataOnlyCard();
    const writes: Card[] = [];
    const { deps } = makeDeps(card, {
      measureDataOnly: async (r) => ({ proven: true, sha: "main999", targets: ["board-data"], dataOnlyRange: r }),
      write: (async (_b: string, _c: string, mutate: (cur: Card) => Card | null) => {
        const fresh = dataOnlyCard({ commitRange: { base: "r0", head: "OUTRO" } } as Partial<Card>);
        const next = mutate(fresh);
        if (next) writes.push(next);
        return next;
      }) as unknown as SettleDeploySuccessDeps["write"],
    });
    const d = await settleDeploySuccess("b", "s1", { source: "reconcile-evidence", deps });
    expect(d?.advancedTo).toBeNull();
    expect(writes).toEqual([]);
  });

  it("guard de staleness sob o lock: releasedSha mudou entre a medição e o write ⇒ prova DESCARTADA", async () => {
    const card = waitingCard();
    const { deps, writes } = makeDeps(card, {
      deployedShaFor: async () => "bbbb222",
      contains: async () => true,
      // o write lê um card FRESCO cuja base mudou (outro writer re-promoveu):
      write: (async (_b: string, _c: string, mutate: (cur: Card) => Card | null) => {
        const fresh = waitingCard({ releasedSha: "nova999" });
        const next = mutate(fresh);
        if (next) writes.push(next);
        return next;
      }) as unknown as SettleDeploySuccessDeps["write"],
    });
    const d = await settleDeploySuccess("b", "s1", { source: "registry-ondone", deps });
    expect(d?.advancedTo).toBeNull(); // a prova medida não fala mais deste card — não avança
    // e o motivo registrado é o honesto — a base mudou no meio da medição —, não «o card não tem sha»
    expectHeldWrite(writes, "medicao-indisponivel");
  });
});

describe("measureDeployAncestry — a régua ÚNICA extraída (reusada por reconcile E settle)", () => {
  it("prova quando TODOS os alvos contêm o releasedSha; devolve o sha e os alvos medidos", async () => {
    const m = await measureDeployAncestry(
      { releasedSha: "aaaa111", deployTargets: ["a", "b"] },
      async (t) => (t === "a" ? "d1" : "d2"),
      async () => true,
    );
    expect(m).toEqual({ proven: true, sha: "aaaa111", targets: ["a", "b"] });
  });

  it("fail-closed em toda ausência: sem releasedSha / sem alvos / alvo sem deploy / sem ancestralidade", async () => {
    expect(await measureDeployAncestry({ releasedSha: undefined, deployTargets: ["a"] }, async () => "d", async () => true)).toEqual({ proven: false, reason: "sem-released-sha" });
    expect(await measureDeployAncestry({ releasedSha: "x", deployTargets: [] }, async () => "d", async () => true)).toEqual({ proven: false, reason: "sem-alvos" });
    expect(await measureDeployAncestry({ releasedSha: "x", deployTargets: ["a"] }, async () => null, async () => true)).toEqual({ proven: false, reason: "alvo-sem-deploy" });
    expect(await measureDeployAncestry({ releasedSha: "x", deployTargets: ["a"] }, async () => "d", async () => false)).toEqual({ proven: false, reason: "deploy-anterior-ao-codigo" });
  });
});

describe("measureDeployAncestry POR UNIDADE — o card prova pelas unidades que o código dele toca", () => {
  // O caso: o pacote não ficava todo verde (uma unidade sem classe segurava o deploy inteiro), então o estado do
  // PACOTE parava de avançar — e um card cujo código só morava em edge-api nunca provava, mesmo com edge-api publicado depois.
  const blocked = (over: Partial<Card> = {}): Card =>
    ({
      id: "s1",
      type: "story",
      status: "release",
      releasedSha: "rel1",
      deployTargets: ["armazem"],
      findings: [
        {
          id: DEPLOY_FAILURE_FINDING_ID,
          lens: "general",
          severity: "high",
          status: "open",
          title: "parada",
          deployCause: { pkg: "armazem", phase: "needs-units", units: ["edge-job-x"], rules: ["unit-operator-only"], ownerClass: null, decider: "system", causeKey: "armazem:system", headSha: "head1", driftUnits: ["edge-api", "edge-worker"] },
        },
      ],
      ...over,
    }) as unknown as Card;
  // rel1 ⊆ head1 (o plano viu o código do card); edge-api e edge-worker publicados em new1 ⊇ rel1; o pacote parado em old0
  const contains = containsIf([["rel1", "head1"], ["rel1", "new1"]]);
  const pkgState = deployed({ armazem: "old0" });

  it("unidade tocada com sha ⊇ releasedSha ⇒ PROVADO mesmo com o estado do pacote antigo", async () => {
    const m = await measureDeployAncestry(blocked(), pkgState, contains, async () => ({ "edge-api": "new1", "edge-worker": "new1", "edge-job-x": "old0" }));
    expect(m).toEqual({ proven: true, sha: "rel1", targets: ["armazem"] });
    // e a reconciliação do finding usa a mesma régua
    expect(await reconcileVerdict(blocked(), pkgState, contains, async () => ({ "edge-api": "new1", "edge-worker": "new1" }))).toEqual({ resolved: true, via: ["armazem"] });
  });

  it("uma unidade do escopo ATRÁS ⇒ não provado", async () => {
    const m = await measureDeployAncestry(blocked(), pkgState, contains, async () => ({ "edge-api": "new1", "edge-worker": "old0" }));
    expect(m).toEqual({ proven: false, reason: "deploy-anterior-ao-codigo" });
  });

  it("fail-closed: unidade sem sha gravado, alvo sem mapa de unidades ou escopo visto num HEAD sem o código ⇒ régua do PACOTE", async () => {
    expect(await measureDeployAncestry(blocked(), pkgState, contains, async () => ({ "edge-api": "new1" }))).toEqual({ proven: false, reason: "deploy-anterior-ao-codigo" });
    expect(await measureDeployAncestry(blocked(), pkgState, contains, async () => null)).toEqual({ proven: false, reason: "deploy-anterior-ao-codigo" });
    const older = containsIf([["rel1", "new1"]]); // o plano que deu o escopo NÃO tinha o código do card
    expect(await measureDeployAncestry(blocked(), pkgState, older, async () => ({ "edge-api": "new1", "edge-worker": "new1" }))).toEqual({ proven: false, reason: "deploy-anterior-ao-codigo" });
    // sem escopo no card: a régua do pacote, como sempre
    expect(deployUnitScope({ findings: [] })).toBeNull();
    expect(await measureDeployAncestry(blocked({ findings: [] }), deployed({ armazem: "new1" }), contains, async () => ({}))).toEqual({ proven: true, sha: "rel1", targets: ["armazem"] });
  });

  it("readDeployUnitShas: só o MAPA unidade → sha (a lista antiga de nomes não serve como prova)", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const root = mkdtempSync(path.join(tmpdir(), "unit-shas-"));
    try {
      const estado = "estado-das-publicacoes/{target}.json"; // o molde que o alvo declara (deploy.legacy.state)
      mkdirSync(path.join(root, "estado-das-publicacoes"), { recursive: true });
      writeFileSync(path.join(root, "estado-das-publicacoes", "armazem.json"), JSON.stringify({ lastDeploySha: "abc1234", units: { "edge-api": "abcdef1", lixo: "não-sha" } }));
      writeFileSync(path.join(root, "estado-das-publicacoes", "velho.json"), JSON.stringify({ lastDeploySha: "abc1234", units: ["edge-api"] }));
      expect(await readDeployUnitShas(root, "armazem", estado)).toEqual({ "edge-api": "abcdef1" });
      expect(await readDeployUnitShas(root, "velho", estado)).toBeNull();
      expect(await readDeployUnitShas(root, "ausente", estado)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Follow-up A (deploy-truth) — a classe-LIMBO do card DATA-ONLY: commitRange sem releasedSha nunca prova
// por ancestralidade; a saída é a régua particionada do train (rangeLandedBySplit, convergence.ts). A régua
// real roda em git de verdade nos testes de convergence.test.ts; aqui provamos a DECISÃO (mapeamento
// fail-closed + o fio do settle) com a medição injetada.

describe("measureDataOnlySettle — partição do commitRange, fail-closed em toda ponta", () => {
  const RANGE = { base: "r0", head: "r9" };
  const exec: ExecFn = async () => ({ stdout: "", stderr: "" });

  it("julga só o ENTREGÁVEL: passa à régua o filtro dos cards vivos do board (o serviço os reescreve o tempo todo)", async () => {
    let filter: ((p: string) => boolean) | undefined;
    await measureDataOnlySettle(exec, "/repo", RANGE, {
      rangeLanded: async (_e, _r, opts) => {
        filter = opts.ignoreDataPaths;
        return { code: "n/a", data: "landed" };
      },
      resolveRefSha: async () => "main999",
    });
    expect(filter).toBeTypeOf("function");
    expect(filter!("storymap/boards/armazem/cards/story-ex0040.md")).toBe(true); // card vivo: fora do julgamento
    expect(filter!("scripts/deploy/checks/coverage.mjs")).toBe(false); // a entrega: dentro
    expect(filter!("storymap/boards/armazem/plans/story-ex0040.md")).toBe(false); // plano/doc/design é conteúdo, não estado vivo
    expect(filter!("storymap/boards/armazem/docs/prd.md")).toBe(false);
  });

  it("metade de código VAZIA + dados ATERRISSADOS em main ⇒ prova {sha de main, targets: [board-data]} + o range medido", async () => {
    const seen: unknown[] = [];
    const m = await measureDataOnlySettle(exec, "/repo", RANGE, {
      rangeLanded: async (_e, _r, opts) => {
        seen.push(opts);
        return { code: "n/a", data: "landed" };
      },
      resolveRefSha: async (ref) => (ref === "main" ? "main999" : null),
    });
    expect(m).toEqual({ proven: true, sha: "main999", targets: ["board-data"], dataOnlyRange: RANGE });
    // a régua recebe o range do card e mede a metade de DADOS contra main (o default da produção de board-data)
    expect(seen[0]).toMatchObject({ range: RANGE, dataRef: "main" });
  });

  it("metade de código NÃO-vazia (card misto sem release) ⇒ codigo-sem-release — NADA muda, segue preso", async () => {
    for (const code of ["landed", "absent", "partial"] as const) {
      const m = await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: async () => ({ code, data: "landed" }),
        resolveRefSha: async () => "main999",
      });
      expect(m).toEqual({ proven: false, reason: "codigo-sem-release" });
    }
  });

  it("dados não provados (absent/partial) ⇒ board-data-nao-aterrissou (o range vazio {absent,absent} cai ANTES em codigo-sem-release — fail-closed igual)", async () => {
    for (const data of ["absent", "partial"] as const) {
      const m = await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: async () => ({ code: "n/a", data }),
        resolveRefSha: async () => "main999",
      });
      expect(m).toEqual({ proven: false, reason: "board-data-nao-aterrissou" });
    }
  });

  // Num caso real, o train integrou os scripts de deploy do card; commits posteriores mexeram nos mesmos arquivos; na
  // ponta de main a pós-imagem do card não existe mais e ele ficou em «Publicando» sem saída.
  describe("a TESTEMUNHA: o recibo de dados do train quando a ponta de main já não é idêntica", () => {
    const tipAbsentButLandedAt = (landedAt: string[]) => async (_e: unknown, _r: unknown, opts: { dataRef?: string }) =>
      ({ code: "n/a" as const, data: opts.dataRef && landedAt.includes(opts.dataRef) ? ("landed" as const) : ("absent" as const) });

    it("recibo que main ainda contém + entregável idêntico NAQUELE commit ⇒ provado (com o sha atual de main)", async () => {
      const m = await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: tipAbsentButLandedAt(["rec1"]),
        resolveRefSha: async () => "main999",
        receiptShas: async () => ["rec2", "rec1"],
        contains: async () => true,
      });
      expect(m).toEqual({ proven: true, sha: "main999", targets: ["board-data"], dataOnlyRange: RANGE });
    });

    it("sem recibo, recibo fora de main, ou recibo em que o entregável NÃO confere ⇒ segue preso", async () => {
      const held = { proven: false, reason: "board-data-nao-aterrissou" };
      expect(await measureDataOnlySettle(exec, "/repo", RANGE, { rangeLanded: tipAbsentButLandedAt(["rec1"]), resolveRefSha: async () => "main999" })).toEqual(held);
      expect(
        await measureDataOnlySettle(exec, "/repo", RANGE, { rangeLanded: tipAbsentButLandedAt(["rec1"]), resolveRefSha: async () => "main999", receiptShas: async () => ["rec1"], contains: async () => false }),
      ).toEqual(held);
      expect(
        await measureDataOnlySettle(exec, "/repo", RANGE, { rangeLanded: tipAbsentButLandedAt([]), resolveRefSha: async () => "main999", receiptShas: async () => ["rec1"], contains: async () => true }),
      ).toEqual(held);
      // um leitor de recibos que falha não vira prova
      expect(
        await measureDataOnlySettle(exec, "/repo", RANGE, { rangeLanded: tipAbsentButLandedAt(["rec1"]), resolveRefSha: async () => "main999", receiptShas: async () => { throw new Error("ledger ilegível"); }, contains: async () => true }),
      ).toEqual(held);
    });

    it("a testemunha não substitui a régua do código: metade de código presente continua `codigo-sem-release`", async () => {
      const m = await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: async () => ({ code: "landed", data: "absent" }),
        resolveRefSha: async () => "main999",
        receiptShas: async () => ["rec1"],
        contains: async () => true,
      });
      expect(m).toEqual({ proven: false, reason: "codigo-sem-release" });
    });
  });

  it("medição indisponível (unknown em qualquer metade, ou sha de main irresolvível) ⇒ medicao-indisponivel", async () => {
    expect(
      await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: async () => ({ code: "unknown", data: "landed" }),
        resolveRefSha: async () => "main999",
      }),
    ).toEqual({ proven: false, reason: "medicao-indisponivel" });
    expect(
      await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: async () => ({ code: "n/a", data: "unknown" }),
        resolveRefSha: async () => "main999",
      }),
    ).toEqual({ proven: false, reason: "medicao-indisponivel" });
    expect(
      await measureDataOnlySettle(exec, "/repo", RANGE, {
        rangeLanded: async () => ({ code: "n/a", data: "landed" }),
        resolveRefSha: async () => null,
      }),
    ).toEqual({ proven: false, reason: "medicao-indisponivel" });
  });
});

describe("risco de deploy ESCOPADO por pacote (o número do pacote ao lado do monorepo inteiro)", () => {
  it("scopedDeployDelta: conta e lista SÓ os commits que tocaram os paths da unidade", async () => {
    const exec: ExecFn = async (cmd) => {
      // o pathspec escopado precisa estar no comando (senão devolveríamos o monorepo inteiro)
      expect(cmd).toContain("git log --oneline");
      expect(cmd).toContain('"packages/acmeapp/"');
      return { stdout: "a41c9e07 story-ex0310\n7d03b2f8 este card\n", stderr: "" };
    };
    const r = await scopedDeployDelta(exec, "/repo", "e5b81d36", ["packages/acmeapp/"]);
    expect(r.count).toBe(2);
    expect(r.commits.map((c) => c.sha)).toEqual(["a41c9e07", "7d03b2f8"]);
    expect(r.commits[0].subject).toBe("story-ex0310");
  });

  it("scopedDeployDelta: base vazia ou erro de git ⇒ delta 0 (nunca lança)", async () => {
    const throwing: ExecFn = async () => {
      throw new Error("git down");
    };
    expect(await scopedDeployDelta(throwing, "/repo", "", ["packages/acmeapp/"])).toEqual({ count: 0, commits: [] });
    expect(await scopedDeployDelta(throwing, "/repo", "base", ["packages/acmeapp/"])).toEqual({ count: 0, commits: [] });
  });

  it("monorepoDeltaCount: devolve o número monorepo-wide (que sozinho exagera o deploy do pacote)", async () => {
    const exec: ExecFn = async (cmd) => {
      expect(cmd).toContain("git rev-list --count");
      return { stdout: "57\n", stderr: "" };
    };
    expect(await monorepoDeltaCount(exec, "/repo", "e5b81d36")).toBe(57);
    // o escopado do mesmo range é MUITO menor → é o que transforma um número assustador em decisão informada
    const scopedExec: ExecFn = async () => ({ stdout: "a41c9e07 x\n7d03b2f8 y\n", stderr: "" });
    expect((await scopedDeployDelta(scopedExec, "/repo", "e5b81d36", ["packages/acmeapp/"])).count).toBe(2);
  });
});
