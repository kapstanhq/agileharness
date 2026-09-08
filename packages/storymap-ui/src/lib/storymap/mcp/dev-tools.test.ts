import { afterAll, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  assertContainmentReachedArgv,
  buildSandboxSettings,
  harnessCredentialPaths,
  serializeSandboxSettings,
} from "../runner/autonomy-sandbox";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setServerLevel } from "./register";
import { registerDevTools } from "./dev-tools";
import { runWithMcpActor } from "./actor";
import { promises as fs } from "node:fs";

// A matriz de risco de ESCOPO REPO (settings.yaml) que o guard consulta — controlável por teste. `undefined`
// (o default) = não declarada, que é o estado real do repo hoje.
let repoRiskMatrix: Record<string, string> | undefined;
vi.mock("@/lib/storymap/runner/config", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadRunnerConfig: () => {
      const real = (actual.loadRunnerConfig as () => Record<string, unknown>)();
      return { ...real, orchestrator: { ...(real.orchestrator as object), riskMatrix: repoRiskMatrix } };
    },
  };
});
import os from "node:os";
import path from "node:path";
import {
  isSecretPath,
  isSafeRef,
  isAllowedCheck,
  isSafeSessionName,
  pollSessionAlive,
  buildRunTaskArgs,
  contextPctFromTranscript,
  computeContextPct,
  suggestRecycle,
  findNewTranscript,
  parseWorktreeList,
  classifyWorktrees,
  RECYCLE_THRESHOLD,
  waitForIdleCore,
  copSessionName,
} from "./dev-tools";

describe("copSessionName — F2: valida o slug e força o prefixo cop-", () => {
  it("aceita um slug válido e prefixa", () => {
    expect(copSessionName("acme-build")).toBe("cop-acme-build");
    expect(copSessionName("x")).toBe("cop-x");
    expect(copSessionName("A_1-b")).toBe("cop-A_1-b");
  });
  it("tolera um cop- redundante (strip + revalida)", () => {
    expect(copSessionName("cop-acme")).toBe("cop-acme");
    expect(copSessionName(" cop-acme ")).toBe("cop-acme");
  });
  it("rejeita vazio, caracteres inseguros, início inválido e >64", () => {
    expect(copSessionName("")).toBeNull();
    expect(copSessionName("a b")).toBeNull(); // espaço
    expect(copSessionName("-x")).toBeNull(); // não começa com [A-Za-z0-9_]
    expect(copSessionName("a$b")).toBeNull(); // char inseguro
    expect(copSessionName("a".repeat(65))).toBeNull(); // >64
    expect(copSessionName("a".repeat(64))).toBe(`cop-${"a".repeat(64)}`); // 64 ok
  });
});

const noSleep = (): Promise<void> => Promise.resolve();

// story-97gpdm — o core do wait_for_session_idle: polla um `sample()` (token que MUDA a cada atividade —
// no wrapper, o hash da tela via capture-pane) até ele ficar ESTÁVEL por `idleMs` (= o Claude parou de
// responder), ou até o timeout. Determinístico via samples + clock/sleep injetados.
describe("waitForIdleCore — detecta ocioso por estabilidade do sample (poll)", () => {
  // clock que avança `pollMs` a cada sleep — modela o tempo passando entre polls
  function harness(samples: Array<string | null>, { idleMs = 30, timeoutMs = 1000, pollMs = 10 } = {}) {
    let t = 0;
    let i = 0;
    const deps = {
      sample: () => Promise.resolve(samples[Math.min(i++, samples.length - 1)]),
      sleep: () => {
        t += pollMs;
        return Promise.resolve();
      },
      now: () => t,
    };
    return waitForIdleCore(deps, { idleMs, timeoutMs, pollMs });
  }

  it("tela estável por idleMs ⇒ 'idle'", async () => {
    // sample constante "A": estável desde o 1º; após ~idleMs/pollMs polls → idle
    const r = await harness(["A", "A", "A", "A", "A", "A"]);
    expect(r.state).toBe("idle");
  });

  it("atividade (tela muda) RESETA o relógio de estabilidade → não declara idle cedo", async () => {
    // muda em quase todo poll → nunca estável por idleMs antes do timeout
    const r = await harness(["A", "B", "C", "D", "E"], { idleMs: 30, timeoutMs: 50, pollMs: 10 });
    expect(r.state).toBe("timeout");
  });

  it("estabiliza DEPOIS de um período de atividade ⇒ 'idle'", async () => {
    const r = await harness(["A", "B", "C", "C", "C", "C", "C"], { idleMs: 30, timeoutMs: 1000, pollMs: 10 });
    expect(r.state).toBe("idle");
  });

  it("sample null (não dá pra ler a tela) ⇒ 'unknown' (nunca finge ocioso)", async () => {
    const r = await harness([null]);
    expect(r.state).toBe("unknown");
  });
});

describe("isSecretPath — denylist de segredos (defesa em profundidade)", () => {
  it("bloqueia .env e variantes", () => {
    expect(isSecretPath("packages/storymap-ui/.env.local")).toBe(true);
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath("packages/x/.env.production")).toBe(true);
    // .env.example também casa — bloqueio conservador (não vaza nada, é só placeholder)
    expect(isSecretPath(".env.example")).toBe(true);
  });
  it("bloqueia chaves/credenciais/service accounts", () => {
    expect(isSecretPath("config/service-account.json")).toBe(true);
    expect(isSecretPath("foo/serviceAccount.json")).toBe(true);
    expect(isSecretPath("certs/server.pem")).toBe(true);
    expect(isSecretPath("keys/app.key")).toBe(true);
    expect(isSecretPath("secrets/db.txt")).toBe(true);
    expect(isSecretPath("anything/credentials.yaml")).toBe(true);
    expect(isSecretPath("home/.ssh/id_rsa")).toBe(true);
  });
  it("permite código-fonte normal", () => {
    expect(isSecretPath("packages/storymap-ui/src/lib/storymap/paths.ts")).toBe(false);
    expect(isSecretPath("README.md")).toBe(false);
    expect(isSecretPath("packages/acmeapp/api/index.ts")).toBe(false);
  });
});

describe("isSafeRef — refs git seguras (anti flag/shell injection)", () => {
  it("aceita refs comuns", () => {
    for (const ref of ["HEAD", "HEAD~3", "main", "42ab9d66", "origin/main", "v1.2.3", "HEAD^"]) {
      expect(isSafeRef(ref)).toBe(true);
    }
  });
  it("recusa flags, espaços e metachars", () => {
    for (const ref of ["-rf", "--upload-pack=evil", "HEAD; rm -rf /", "$(whoami)", "a`b`", "x|y", ""]) {
      expect(isSafeRef(ref)).toBe(false);
    }
  });
});

describe("isAllowedCheck — allowlist de targets just (run_check)", () => {
  it("permite checks", () => {
    for (const t of ["test-storymap", "validate-all", "lint", "typecheck", "build-acmeapp", "ci-test", "test-acmeapp-unit"]) {
      expect(isAllowedCheck(t)).toBe(true);
    }
  });
  it("BLOQUEIA deploy/dev/orch e metachars de shell", () => {
    for (const t of ["deploy-orbit", "dev-storymap", "orch-deploy", "test && rm -rf /", "test;deploy", "validate-all ", "chat-acmeapp"]) {
      expect(isAllowedCheck(t)).toBe(false);
    }
  });
});

describe("isSafeSessionName — nome de sessão tmux (claude_*)", () => {
  it("aceita slugs", () => {
    for (const s of ["claude", "mcp-acmeapp", "dev_1", "Sessao-2", "a"]) {
      expect(isSafeSessionName(s)).toBe(true);
    }
  });
  it("recusa vazio, primeiro-char hífen (flag), espaços, metachars e >64 chars", () => {
    for (const s of ["", "-x", "--rf", "a b", "a;b", "a$b", "a/b", "a.b", "a".repeat(65)]) {
      expect(isSafeSessionName(s)).toBe(false);
    }
  });
});

// === claude_new: poll de persistência pós-spawn (AC1, t1/t2/t8) ============
describe("pollSessionAlive — contrato honesto de claude_new", () => {
  it("resolve true quando a sessão sobrevive a TODA a janela de poll", async () => {
    let checks = 0;
    const alive = await pollSessionAlive(
      async () => {
        checks++;
        return true;
      },
      { intervalMs: 500, timeoutMs: 5_000, sleep: noSleep },
    );
    expect(alive).toBe(true);
    // 5000 / 500 = 10 verificações ao longo da janela
    expect(checks).toBe(10);
  });

  it("resolve false (session_lost) assim que uma verificação reporta sessão sumida", async () => {
    let checks = 0;
    const alive = await pollSessionAlive(
      async () => {
        checks++;
        return checks < 3; // viva nas 2 primeiras, some na 3ª
      },
      { intervalMs: 500, timeoutMs: 5_000, sleep: noSleep },
    );
    expect(alive).toBe(false);
    expect(checks).toBe(3); // para no primeiro check negativo (curto-circuito)
  });

  it("faz ao menos uma verificação mesmo com janela menor que o intervalo", async () => {
    let checks = 0;
    const alive = await pollSessionAlive(async () => (checks++, true), {
      intervalMs: 500,
      timeoutMs: 100,
      sleep: noSleep,
    });
    expect(alive).toBe(true);
    expect(checks).toBe(1);
  });
});

// === run_task: headless sem sessão tmux (AC2, t3/t4/t5/t9) =================
describe("buildRunTaskArgs — argv do claude headless", () => {
  // ── F0 (ADR-067): ESTA TOOL MIGROU PARA A CONTENÇÃO DO SO ────────────────────────────────────────
  // `run_task` era uma das sete superfícies que ainda emitiam `--dangerously-skip-permissions`, e a
  // ÚNICA alcançável de fora: é tool do endpoint MCP, que fica na internet pública por desenho. As
  // outras seis exigem sessão autenticada no painel. Uma revisão apontou que deixar justamente esta
  // para depois mantinha a fase "externamente explorável" — e o custo de migrar era este arquivo.
  //
  // A postura é OBRIGATÓRIA no argumento. A primeira versão da migração manteve um ramo legado que
  // ainda emitia a flag quando ela não vinha; um caminho sem consumidor de produção que emite
  // exatamente aquilo que a fase existe para remover é dívida disfarçada de compatibilidade.
  // O portão LÊ o settings apontado (ver verificarSettingsNoDisco), então o fixture escreve um arquivo
  // real — um caminho inventado testaria só o ramo de erro de leitura, não a forma do argv.
  const CRED_DIR = "/state";
  const feito = (() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ah-rt-"));
    const f = path.join(dir, "sandbox-k.json");
    const bytes = serializeSandboxSettings(buildSandboxSettings({ writeRoot: "/wt", credentialsDir: CRED_DIR }));
    writeFileSync(f, bytes, "utf8");
    return { dir, f, sha: createHash("sha256").update(bytes).digest("hex") };
  })();
  const settingsReal = feito.f;
  // O fixture é LIDO pelo portão durante os testes (verificarSettingsNoDisco), então só pode ser
  // removido no fim do describe — apagar antes trocaria o órfão em /tmp por um erro de leitura.
  afterAll(() => {
    rmSync(feito.dir, { recursive: true, force: true });
  });
  // A postura carrega o sha dos bytes escritos e as credenciais que promete negar — o portão confere
  // as duas coisas, então um fixture incompleto passaria a testar o ramo de erro em vez do feliz.
  const sandboxed = {
    kind: "sandboxed" as const,
    tier: "full" as const,
    settingsFile: settingsReal,
    settingsSha256: feito.sha,
    credentialPaths: harnessCredentialPaths(CRED_DIR),
    denyWrite: [],
    mechanism: "bubblewrap",
    weakerNested: false,
    writeRoot: "/wt",
  };

  it("passa o prompt como UM único argv (sem shell) e carrega a CONTENÇÃO, não a flag perigosa", () => {
    const { args } = buildRunTaskArgs("diagnostique a sessão; rm -rf / $(whoami)", sandboxed);
    expect(args).toEqual([
      "-p",
      "diagnostique a sessão; rm -rf / $(whoami)", // literal — metachars não são interpretados
      "--output-format",
      "text",
      "--permission-mode",
      "acceptEdits",
      "--settings",
      settingsReal,
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("O ARGV PASSA NO PORTÃO — a forma montada aqui é a que a fase considera válida", () => {
    // A versão anterior deste teste CIMENTAVA por `toEqual` um argv SEM `--permission-mode` — ou seja,
    // um teste fixando exatamente a forma que `assertContainmentReachedArgv` rejeita. Um teste que
    // protege uma configuração insegura é pior que teste nenhum: ele impede a correção.
    const { args } = buildRunTaskArgs("oi", sandboxed);
    expect(() => assertContainmentReachedArgv(sandboxed, args)).not.toThrow();
  });

  it("postura REBAIXADA ⇒ perde o Bash de verdade (sem contenção, sem shell)", () => {
    const p = { kind: "downgraded" as const, tier: "write" as const, warn: "sem sandbox" };
    const { args } = buildRunTaskArgs("oi", p);
    expect(args).toEqual([
      "-p",
      "oi",
      "--output-format",
      "text",
      "--permission-mode",
      "acceptEdits",
      "--disallowedTools",
      "Bash",
    ]);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(() => assertContainmentReachedArgv(p, args)).not.toThrow();
  });

  it("a válvula explícita emite a flag E sinaliza que o bypass de root é necessário", () => {
    // `needsRootBypass` era DESCARTADO pelo call-site, então a válvula produzia um comando que o
    // próprio CLI recusa quando o serviço roda como root — uma alavanca declarada e quebrada.
    const p = { kind: "unsandboxed-escape" as const, tier: "full" as const, warn: "declarado" };
    const { args, needsRootBypass } = buildRunTaskArgs("oi", p);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(needsRootBypass, "sem isto o call-site não injeta IS_SANDBOX e o CLI recusa como root").toBe(true);
  });

  it("o call-site CHAMA o portão e consome o needsRootBypass — não é estrutura inerte", () => {
    // Regressão do defeito exato que uma revisão provou por mutação: filtrar `--settings` do argv
    // logo antes do `pexec` deixava a suíte inteira verde, porque o portão não era chamado aqui.
    const src = readFileSync(path.join(__dirname, "dev-tools.ts"), "utf8");
    // O guarda de regex foi substituído: a chamada avulsa do portão foi ABSORVIDA pelo estrangulamento
    // (`spawnContidoArgv`), que verifica e spawna na MESMA expressão. Ver o bloco (22) de autonomy-sandbox.test.ts.
    expect(src).toMatch(/spawnContidoArgv\(posturaEfetiva, args,/);
    expect(src).toMatch(/needsRootBypass\s*&&/);
    // ⚠ A checagem de ORDEM ("o portão vem antes do spawn") SAIU, e é o achado que a motivou: um
    // revisor mediu que, com 12 linhas entre as duas, `pexec("claude", args.filter(...))` passava em
    // 7167 de 7167 provas. Ordem não é suficiente — verificar e executar viraram uma expressão só, e o
    // que prova a propriedade agora é comportamental (bloco (22) de autonomy-sandbox.test.ts: comando
    // adulterado ⇒ LANÇA **e** o spawn não é chamado).
    expect(src).not.toMatch(/assertContainmentReachedArgv\(posturaEfetiva, args\);/);
  });

  it("nunca passa argumentos de tmux — run_task não cria sessão", () => {
    const { args } = buildRunTaskArgs("oi", sandboxed);
    expect(args.some((a) => /tmux|new-session|-s\b/.test(a))).toBe(false);
  });
});

// === claude_sessions: contextPct + suggestRecycle (AC3/AC4, t6/t7) =========
describe("contextPctFromTranscript — % de contexto a partir do transcript JSONL", () => {
  const line = (usage: Record<string, number>, wrap = false) =>
    JSON.stringify(wrap ? { type: "assistant", message: { usage } } : { usage });

  it("usa o ÚLTIMO uso de tokens (snapshot mais recente do contexto)", () => {
    const jsonl = [
      line({ input_tokens: 1_000 }),
      line({ input_tokens: 50_000, cache_read_input_tokens: 50_000 }), // 100k → 50%
    ].join("\n");
    expect(contextPctFromTranscript(jsonl, 200_000)).toBe(50);
  });

  it("soma input + cache creation + cache read", () => {
    const jsonl = line({ input_tokens: 10_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 30_000 });
    // 60k / 200k = 30%
    expect(contextPctFromTranscript(jsonl, 200_000)).toBe(30);
  });

  it("lê usage aninhado em message.usage (formato Claude Code)", () => {
    const jsonl = line({ input_tokens: 120_000 }, true); // 60%
    expect(contextPctFromTranscript(jsonl, 200_000)).toBe(60);
  });

  it("limita a 100 e ignora linhas malformadas", () => {
    const jsonl = ["{ lixo não-json", "", line({ input_tokens: 500_000 })].join("\n");
    expect(contextPctFromTranscript(jsonl, 200_000)).toBe(100);
  });

  it("retorna null quando não há nenhum uso de tokens (degrada, não finge 0%)", () => {
    expect(contextPctFromTranscript("", 200_000)).toBeNull();
    expect(contextPctFromTranscript(line({ output_tokens: 10 } as Record<string, number>), 200_000)).toBeNull();
  });
});

describe("suggestRecycle — recicla a partir de ~50% (AC4)", () => {
  it(`true quando contextPct >= ${RECYCLE_THRESHOLD}`, () => {
    expect(suggestRecycle(50)).toBe(true);
    expect(suggestRecycle(73)).toBe(true);
    expect(suggestRecycle(100)).toBe(true);
  });
  it("false abaixo do limite ou quando indeterminável (null)", () => {
    expect(suggestRecycle(49)).toBe(false);
    expect(suggestRecycle(0)).toBe(false);
    expect(suggestRecycle(null)).toBe(false);
  });
});

describe("computeContextPct — wrapper de arquivo (degrada para null)", () => {
  it("lê um transcript real e calcula o %", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ctxpct-"));
    const file = path.join(dir, "session.jsonl");
    await fs.writeFile(file, JSON.stringify({ usage: { input_tokens: 100_000 } }), "utf8");
    expect(await computeContextPct(file, 200_000)).toBe(50);
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("retorna null para arquivo inexistente (não lança)", async () => {
    expect(await computeContextPct(path.join(os.tmpdir(), "nao-existe-xyz.jsonl"))).toBeNull();
  });
});

// (F8) O bloco `parseTmuxSessions` saiu junto com a função: `claude_sessions` passou a usar
// `lib/vps/tmux.ts listSessions()`, que já é parseada e testada como primitivo único.

// === worktree_list: parse do `git worktree list --porcelain` (story-08969p) =====
describe("parseWorktreeList — parse do porcelain do git worktree list", () => {
  it("parseia múltiplos worktrees (runtime + stage + run) com path/HEAD/branch", () => {
    const porcelain = [
      "worktree /root/meu-monorepo",
      "HEAD 832370d63aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /root/meu-monorepo-stage",
      "HEAD 7812fa59daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/stage",
      "",
      "worktree /root/meu-monorepo/.worktrees/run-abc123",
      "HEAD def4560000000000000000000000000000000000",
      "branch refs/heads/run/abc123",
      "",
    ].join("\n");
    const out = parseWorktreeList(porcelain);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ path: "/root/meu-monorepo", head: "832370d63aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", branch: "main", detached: false });
    // refs/heads/ é removido do branch
    expect(out[1].branch).toBe("stage");
    expect(out[2].branch).toBe("run/abc123");
  });

  it("marca detached (sem branch) e bare, e não confunde registros", () => {
    const porcelain = [
      "worktree /repo",
      "bare",
      "",
      "worktree /repo/detached-wt",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "detached",
      "",
    ].join("\n");
    const out = parseWorktreeList(porcelain);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ path: "/repo", bare: true, branch: null });
    expect(out[1]).toMatchObject({ path: "/repo/detached-wt", detached: true, branch: null });
  });

  it("captura locked/prunable (com razão opcional)", () => {
    const porcelain = [
      "worktree /repo/wt",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/run/xyz",
      "locked reason de lock",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\n");
    const [wt] = parseWorktreeList(porcelain);
    expect(wt.locked).toBe(true);
    expect(wt.lockedReason).toBe("reason de lock");
    expect(wt.prunable).toBe(true);
  });

  it("não duplica nem perde o último registro quando falta a linha em branco final", () => {
    const porcelain = [
      "worktree /a",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /b",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/run/last",
    ].join("\n"); // sem "" final
    const out = parseWorktreeList(porcelain);
    expect(out.map((w) => w.path)).toEqual(["/a", "/b"]);
  });

  it("retorna [] para entrada vazia", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("classifyWorktrees — rótulo de papel + diagnóstico de órfão (merge-back travado)", () => {
  const base = { head: "x", detached: false, bare: false, locked: false, prunable: false };
  const wt = (path: string, branch: string | null) => ({ ...base, path, branch });

  it("rotula runtime (path === repoRoot), stage (branch === stageBranch), run (run/<id>) e other", () => {
    const out = classifyWorktrees(
      [
        wt("/root/repo", "main"),
        wt("/root/repo-stage", "stage"),
        wt("/root/repo/.worktrees/run-s1", "run/s1"),
        wt("/root/repo/.worktrees/gate-x", "gate/x"),
      ],
      { repoRoot: "/root/repo", runningSessionIds: ["s1"], stageBranch: "stage", parkedBranches: [] },
    );
    expect(out.map((w) => w.role)).toEqual(["runtime", "stage", "run", "other"]);
  });

  it("run com sessão ATIVA → active:true, orphan:false", () => {
    const [run] = classifyWorktrees([wt("/r/.worktrees/run-live", "run/live")], {
      repoRoot: "/r",
      runningSessionIds: ["live"],
      stageBranch: "stage",
      parkedBranches: [],
    });
    expect(run).toMatchObject({ role: "run", sessionId: "live", active: true, orphan: false, parkedMerge: false });
  });

  it("run SEM sessão viva e SEM merge parkado → ÓRFÃO (sinal de merge-back travado)", () => {
    const [run] = classifyWorktrees([wt("/r/.worktrees/run-ghost", "run/ghost")], {
      repoRoot: "/r",
      runningSessionIds: [],
      stageBranch: "stage",
      parkedBranches: [],
    });
    expect(run).toMatchObject({ role: "run", sessionId: "ghost", active: false, orphan: true, parkedMerge: false });
  });

  it("run SEM sessão viva mas com merge PARKADO → parkedMerge:true, NÃO é órfão (a fila ainda o rastreia)", () => {
    const [run] = classifyWorktrees([wt("/r/.worktrees/run-parked", "run/parked")], {
      repoRoot: "/r",
      runningSessionIds: [],
      stageBranch: "stage",
      // o branch parkado pode vir com refs/heads/ — deve normalizar
      parkedBranches: ["refs/heads/run/parked"],
    });
    expect(run).toMatchObject({ active: false, parkedMerge: true, orphan: false });
  });
});

describe("findNewTranscript — acha o .jsonl mais novo após `since`", () => {
  it("escolhe o transcript com mtime > since, o mais recente entre projetos", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projects-"));
    const projA = path.join(root, "encoded-cwd-a");
    const projB = path.join(root, "encoded-cwd-b");
    await fs.mkdir(projA, { recursive: true });
    await fs.mkdir(projB, { recursive: true });

    const old = path.join(projA, "old.jsonl");
    const fresh = path.join(projB, "fresh.jsonl");
    await fs.writeFile(old, "{}", "utf8");
    await fs.writeFile(fresh, "{}", "utf8");

    // Marca o "old" no passado e o "fresh" no futuro relativo a `since`.
    const since = Date.now();
    const past = new Date(since - 60_000);
    const future = new Date(since + 60_000);
    await fs.utimes(old, past, past);
    await fs.utimes(fresh, future, future);

    const found = await findNewTranscript(since, root);
    expect(found).toBe(fresh);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("retorna null quando nenhum arquivo é mais novo que since", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "projects-"));
    const proj = path.join(root, "p");
    await fs.mkdir(proj, { recursive: true });
    const f = path.join(proj, "a.jsonl");
    await fs.writeFile(f, "{}", "utf8");
    const past = new Date(Date.now() - 120_000);
    await fs.utimes(f, past, past);
    expect(await findNewTranscript(Date.now(), root)).toBeNull();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("degrada para null se o diretório de projetos não existe", async () => {
    expect(await findNewTranscript(0, path.join(os.tmpdir(), "nao-existe-projects-xyz"))).toBeNull();
  });
});

// A modalidade DESTRUTIVA de uma tool cuja classe de risco é uniforme. `reconcile_stage` tem duas: `sync`
// (segura, preserva o não-liberado) e `reset` (`reset --hard`, DESCARTA os commits únicos do stage). Como a
// classe de risco é por TOOL, um `merge-resolve: auto` declarado para o escopo repo concederia as duas de uma
// vez. Este corte garante que o `auto` só possa habilitar a metade segura.
describe("reconcile_stage — mode='reset' é do OPERADOR, nunca de um ator escopado", () => {
  function reconcileHandler() {
    let handler: ((a: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
    const server = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "registerTool"
            ? (name: string, _cfg: unknown, fn: (a: Record<string, unknown>) => Promise<CallToolResult>) => {
                if (name === "reconcile_stage") handler = fn;
              }
            : () => {},
      },
    ) as unknown as McpServer;
    setServerLevel(server, "full");
    registerDevTools(server);
    if (!handler) throw new Error("reconcile_stage não foi registrada");
    return handler as (a: Record<string, unknown>) => Promise<CallToolResult>;
  }

  // SEM a concessão, quem responde é o guard (escopo repo, ask → recusa). O corte do handler é a SEGUNDA
  // linha: ele só entra em cena depois que o operador concede `merge-resolve: auto`, que é exatamente quando
  // a modalidade destrutiva passaria de carona. Testar as duas camadas separadas mantém a asserção honesta.
  it("SEM concessão: o guard recusa antes, nomeando a alavanca do settings.yaml", async () => {
    const r = await runWithMcpActor({ level: "orch", tokenEnv: "STORYMAP_MCP_TOKEN_ORCH" }, () =>
      reconcileHandler()({ mode: "reset", confirmReset: true }),
    );
    expect(r.isError).toBe(true);
    expect(String((r.content as { text: string }[])[0].text)).toContain("orchestrator.riskMatrix.merge-resolve");
  });

  it("COM `merge-resolve: auto` concedido: o guard libera, mas o corte do handler barra o reset", async () => {
    repoRiskMatrix = { "merge-resolve": "auto" };
    try {
      const r = await runWithMcpActor({ level: "orch", tokenEnv: "STORYMAP_MCP_TOKEN_ORCH" }, () =>
        reconcileHandler()({ mode: "reset", confirmReset: true }),
      );
      expect(r.isError).toBe(true);
      const text = String((r.content as { text: string }[])[0].text);
      expect(text).toContain("só o operador"); // a concessão NÃO arrastou a modalidade destrutiva
      expect(text).toContain("mode='sync'");
    } finally {
      repoRiskMatrix = undefined;
    }
  });

  it("COM a concessão, mode='sync' passa do corte (a metade segura é o que o `auto` habilita)", async () => {
    repoRiskMatrix = { "merge-resolve": "auto" };
    try {
      const r = await runWithMcpActor({ level: "orch", tokenEnv: "STORYMAP_MCP_TOKEN_ORCH" }, () =>
        reconcileHandler()({ mode: "sync" }),
      );
      // Chega na lógica real (staging desabilitado no ambiente de teste); o que importa é que a recusa NÃO é
      // a do corte de operador nem a do guard.
      const text = String((r.content as { text: string }[])[0].text);
      expect(text).not.toContain("só o operador");
      expect(text).not.toContain("orchestrator.riskMatrix");
    } finally {
      repoRiskMatrix = undefined;
    }
  });
});

// ─── story-frente3: as tools deixaram de conhecer a máquina do autor ─────────────────────────────
//
// Duas tools carregavam um endereço desta caixa: `update_vps` rodava `bash /root/update.sh` COMO ROOT, e
// `run_check`/`deploy_plan` faziam `spawn("just", …)` enquanto o justfile do umbrella não viaja na
// extração. Na máquina de quem clona a primeira executa o que houver naquele caminho e a segunda estoura
// ENOENT sem dizer o que instalar. Agora as duas RECUSAM, e a recusa ensina.
describe("tools do host — recusa declarada em vez de endereço cravado (story-frente3)", () => {
  function handlerDe(nome: string) {
    let handler: ((a: Record<string, unknown>) => Promise<CallToolResult>) | null = null;
    const server = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "registerTool"
            ? (name: string, _cfg: unknown, fn: (a: Record<string, unknown>) => Promise<CallToolResult>) => {
                if (name === nome) handler = fn;
              }
            : () => {},
      },
    ) as unknown as McpServer;
    setServerLevel(server, "full");
    registerDevTools(server);
    if (!handler) throw new Error(`${nome} não foi registrada`);
    return handler as (a: Record<string, unknown>) => Promise<CallToolResult>;
  }
  const texto = (r: CallToolResult) => String((r.content as { text: string }[])[0].text);

  it("[ATAQUE] `update_vps` sem script declarado NÃO executa nada — e diz o que declarar", async () => {
    vi.stubEnv("AGILEHARNESS_UPDATE_SCRIPT", "");
    try {
      const r = await handlerDe("update_vps")({});
      expect(r.isError).toBe(true);
      const t = texto(r);
      expect(t).toContain("AGILEHARNESS_UPDATE_SCRIPT");
      // A propriedade que importa: NÃO há default. Um caminho default seria a aposta de que o arquivo
      // naquele endereço, na máquina do OUTRO, faz o que o nome sugere — e esta tool roda como root.
      expect(t).not.toContain("/root/update.sh");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("`update_status` sem log declarado DIZ que não há log, em vez de fingir que o update não começou", async () => {
    vi.stubEnv("AGILEHARNESS_UPDATE_LOG", "");
    try {
      const r = await handlerDe("update_status")({});
      const t = texto(r);
      expect(t).toContain("AGILEHARNESS_UPDATE_LOG");
      expect(t).not.toContain("/var/log/storymap-update.log");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("[ATAQUE] `run_check` sem `just` alcançável recusa nomeando o que instalar/declarar", async () => {
    vi.stubEnv("AGILEHARNESS_JUST", "");
    vi.stubEnv("PATH", "");
    try {
      const r = await handlerDe("run_check")({ target: "validate-all" });
      expect(r.isError).toBe(true);
      expect(texto(r)).toContain("AGILEHARNESS_JUST");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
