import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, it, expect, vi } from "vitest";

// ── O PORTÃO É ESPIONADO, NÃO SUBSTITUÍDO (F0 · ADR-067) ────────────────────────────────────────────
// `vi.fn(orig.…)` embrulha a implementação REAL: o teste consegue afirmar COM QUE argv o portão foi
// chamado (a propriedade que interessa) sem trocar o guarda por um dublê que aprova tudo — se o argv
// estiver errado, ele continua abortando aqui exatamente como abortaria em produção.
vi.mock("./autonomy-sandbox", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./autonomy-sandbox")>();
  return { ...orig, assertContainmentReachedArgv: vi.fn(orig.assertContainmentReachedArgv) };
});

import {
  assertContainmentReachedArgv,
  buildSandboxSettings,
  harnessCredentialPaths,
  type AutonomyPosture,
} from "./autonomy-sandbox";
import { buildJudgeArgs, buildJudgeContextNote, parseVerdict, spawnResolutionJudge, VERDICT_FILENAME } from "./resolution-judge-spawn";
import type { JudgeRequest } from "./semantic-resolution";

// WS-10.1 — the VERDICT PARSER is where the judge's word meets the code that decides. Every rejection below
// is a fail-closed decision (invariant 6): the parser's job is to refuse to be a rubber stamp. These tests
// are the teeth of "doubt ⇒ substantive" at the boundary — the SKILL.md asks nicely; this enforces.

const FILES = ["packages/x/src/a.ts", "packages/x/src/b.ts"];
const ok = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    hunks: [{ file: FILES[0], hunk: "<<<<<<<\na\n=======\nb\n>>>>>>>", verdict: "cosmetic", rationale: "mesmo comentário reescrito", ...over }],
  });

describe("parseVerdict — o contrato que o juiz NÃO pode afrouxar", () => {
  it("aceita um veredito bem-formado", () => {
    const r = parseVerdict(ok(), FILES);
    expect("hunks" in r && r.hunks).toHaveLength(1);
    expect("hunks" in r && r.hunks[0].verdict).toBe("cosmetic");
  });

  it("JSON inválido ⇒ erro (nunca 'assumo que era cosmético')", () => {
    const r = parseVerdict("{ isto não é json", FILES);
    expect("error" in r && r.error).toContain("JSON inválido");
  });

  it("sem o array `hunks` ⇒ erro", () => {
    expect("error" in parseVerdict(JSON.stringify({ resolved: true }), FILES)).toBe(true);
  });

  it("hunks VAZIO ⇒ erro — 'não julguei nada' é falha de julgar, não inocência", () => {
    const r = parseVerdict(JSON.stringify({ hunks: [] }), FILES);
    expect("error" in r && r.error).toContain("nada provado");
  });

  it("ACEITE 4 — um veredito DESCONHECIDO não é coagido a cosmetic nem a substantive: é erro", () => {
    // "probably-cosmetic" é exatamente o que um juiz inseguro tentaria emitir. Coagir p/ cosmetic
    // auto-resolveria em cima de lixo; coagir p/ substantive esconderia um prompt quebrado.
    const r = parseVerdict(ok({ verdict: "probably-cosmetic" }), FILES);
    expect("error" in r && r.error).toContain("veredito desconhecido");
  });

  it("um hunk sobre arquivo FORA da divergência invalida o veredito INTEIRO (o juiz olhou outra árvore)", () => {
    const r = parseVerdict(ok({ file: "packages/outro/z.ts" }), FILES);
    expect("error" in r && r.error).toContain("outra árvore");
  });

  it("veredito sem `rationale` ⇒ erro — um veredito sem porquê não é auditável", () => {
    const r = parseVerdict(ok({ rationale: "" }), FILES);
    expect("error" in r && r.error).toContain("rationale");
  });

  it("preserva o veredito `substantive` tal e qual (o caminho da escalação)", () => {
    const r = parseVerdict(ok({ verdict: "substantive", rationale: "duas implementações diferentes" }), FILES);
    expect("hunks" in r && r.hunks[0].verdict).toBe("substantive");
  });
});

describe("buildJudgeContextNote — os FATOS da divergência, agnóstico de aplicação", () => {
  const req: JudgeRequest = {
    sides: { ours: "main", theirs: "stage", files: FILES },
    base: "abc123",
    origin: "release",
    board: "acme",
    conflictDetail: "error: patch failed",
  };

  it("nomeia os dois lados, a base e todos os arquivos", () => {
    const note = buildJudgeContextNote(req, VERDICT_FILENAME);
    expect(note).toContain("main");
    expect(note).toContain("stage");
    expect(note).toContain("abc123");
    for (const f of FILES) expect(note).toContain(f);
    expect(note).toContain(VERDICT_FILENAME);
  });

  it("diz ao juiz que ele NÃO alcança stage/main e que o gate roda de novo (invariante 1)", () => {
    const note = buildJudgeContextNote(req, VERDICT_FILENAME);
    expect(note).toContain("worktree FRESCO");
    expect(note).toContain("SUÍTE roda");
  });

  it("D13 — nenhuma palavra de linguagem/framework vaza para o prompt do juiz", () => {
    const note = buildJudgeContextNote(req, VERDICT_FILENAME).toLowerCase();
    for (const word of ["typescript", "react", "next.js", "firebase", "python", "javascript"]) {
      expect(note).not.toContain(word);
    }
  });
});

// ── F0 (ADR-067) — A CONTENÇÃO DO JUIZ ──────────────────────────────────────────────────────────────
// O juiz é alcançável EM BANDA a partir de um run já contido: o run produz o diff, o diff diverge, o
// merge train chama o juiz. Enquanto ele comprava autonomia com bypass de permissão, a fronteira do
// autorun tinha uma porta nomeada para sair dela — como root, sobre o mesmo código.
//
// As duas provas que este bloco cobra, e que um lint de regex sobre a fonte NÃO dá: (a) postura
// RECUSADA não spawna nada; (b) o portão é chamado com o argv FINAL, antes do spawn. Por isso o spawn
// é INJETADO e capturado, em vez de inspecionado no texto.

const SETTINGS_DIR = mkdtempSync(path.join(os.tmpdir(), "ah-judge-fence-"));
const STATE_ROOT = path.join(SETTINGS_DIR, "state");

/** Cada teste que precisa de uma raiz de repositório cria a sua — e todas são APAGADAS no fim. Sem isto
 *  uma passada do portão deixava quatro diretórios órfãos em /tmp (a cerca + um repo por teste). */
const TMP_DIRS: string[] = [SETTINGS_DIR];
function repoTmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ah-judge-repo-"));
  TMP_DIRS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of TMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** Uma postura `sandboxed` com um settings REAL no disco — o portão lê o arquivo e confere sha + cerca,
 *  então um caminho inventado só exercitaria o ramo de erro de leitura, nunca a forma do argv.
 *  `desarmar` deixa o teste produzir a cerca DESARMADA (ponteiro válido, conteúdo que não contém). */
function posturaContida(writeRoot: string, desarmar?: (sandbox: Record<string, unknown>) => void): AutonomyPosture {
  const settings = buildSandboxSettings({ writeRoot, credentialsDir: STATE_ROOT });
  desarmar?.(settings.sandbox as Record<string, unknown>);
  const bytes = JSON.stringify(settings);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const file = path.join(SETTINGS_DIR, `sandbox-${sha.slice(0, 12)}.json`);
  writeFileSync(file, bytes, "utf8");
  return {
    kind: "sandboxed",
    tier: "full",
    settingsFile: file,
    settingsSha256: sha,
    credentialPaths: harnessCredentialPaths(STATE_ROOT),
  denyWrite: [],
    mechanism: "bubblewrap",
    weakerNested: false,
    writeRoot,
  };
}

const REQ: JudgeRequest = {
  sides: { ours: "main", theirs: "stage", files: ["packages/x/src/a.ts"] },
  base: "abc123",
  origin: "train",
  board: "acme",
};

/** git falso: tudo passa, MENOS o `apply --3way` — que precisa falhar para existir divergência a julgar. */
function execFalso(registro: string[]) {
  return async (command: string) => {
    registro.push(command);
    if (/\bapply --3way\b/.test(command)) throw Object.assign(new Error("conflito"), { stdout: "", stderr: "CONFLICT" });
    return { stdout: "", stderr: "" };
  };
}

/** spawn falso: registra o argv EXATO que o CLI receberia e sai 0 sem nunca criar um processo. */
function spawnFalso(capturado: { args?: readonly string[]; portaoJaChamado?: number; env?: NodeJS.ProcessEnv }) {
  return ((_bin: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
    capturado.args = args;
    capturado.env = opts?.env;
    capturado.portaoJaChamado = vi.mocked(assertContainmentReachedArgv).mock.calls.length;
    const em = new EventEmitter() as EventEmitter & { kill: () => void };
    em.kill = () => {};
    setTimeout(() => em.emit("exit", 0), 0);
    return em;
  }) as unknown as typeof import("node:child_process").spawn;
}

describe("spawnResolutionJudge — a contenção do juiz (F0)", () => {
  beforeEach(() => {
    vi.mocked(assertContainmentReachedArgv).mockClear();
    // O proxy de headroom não é objeto deste teste; sem o opt-out, cada spawn sondaria localhost.
    vi.stubEnv("STORYMAP_HEADROOM_URL", "off");
  });

  it("(a) postura RECUSADA ⇒ o juiz NÃO spawna, e a divergência sobe para o humano", async () => {
    const registro: string[] = [];
    const capturado: { args?: readonly string[] } = {};
    const r = await spawnResolutionJudge(REQ, {
      claudeBin: "claude",
      repoRoot: repoTmp(),
      exec: execFalso(registro),
      resolvePosture: () => ({ kind: "refused", reason: "sandbox exigido e indisponível" }),
      spawn: spawnFalso(capturado),
    });
    expect(capturado.args, "a postura recusou e mesmo assim um agente nasceu").toBeUndefined();
    // A recusa é aplicada ANTES da montagem: o portão nem chega a ser consultado. (Ele TAMBÉM recusa
    // uma postura `refused` — defesa em profundidade —, mas depender disso deixaria o ramo de recusa
    // deste módulo livre para sumir sem que nenhum teste percebesse.)
    expect(vi.mocked(assertContainmentReachedArgv), "a recusa chegou a montar um comando").not.toHaveBeenCalled();
    expect(r.error).toContain("sandbox exigido e indisponível");
    expect(r.resolvedRef, "recusa não pode produzir resolução").toBeUndefined();
    expect(r.hunks).toEqual([]);
    // E a árvore do juiz é desmontada — a recusa não deixa worktree órfão para trás.
    expect(registro.some((c) => /worktree remove/.test(c))).toBe(true);
  });

  it("(b) o PORTÃO é chamado com o argv FINAL, ANTES do spawn — e o argv carrega a cerca, não o bypass", async () => {
    const repoRoot = repoTmp();
    const registro: string[] = [];
    const capturado: { args?: readonly string[]; portaoJaChamado?: number; env?: NodeJS.ProcessEnv } = {};
    let worktree = "";
    let posturaUsada: ReturnType<typeof posturaContida> | undefined;
    vi.stubEnv("STORYMAP_MCP_TOKEN", "full-xyz");
    // O pai AFIRMA estar num sandbox — o caso MEDIDO nesta caixa (o serviço herda a chave de quem o
    // iniciou). O filho contido não pode receber isso por herança: quem afirma tem de ser quem decidiu.
    vi.stubEnv("IS_SANDBOX", "1");
    await spawnResolutionJudge(REQ, {
      claudeBin: "claude",
      repoRoot,
      exec: execFalso(registro),
      resolvePosture: (cwd) => {
        posturaUsada = posturaContida(cwd);
        worktree = cwd;
        return posturaUsada;
      },
      spawn: spawnFalso(capturado),
    });

    // ⚠ Este bloco espionava `assertContainmentReachedArgv` por fora. O portão foi ABSORVIDO pelo
    // estrangulamento (`spawnContidoArgv`), que verifica e spawna na mesma expressão — a chamada agora é
    // interna e o espião não a vê. Trocar espionagem por OBSERVAÇÃO é o certo de qualquer forma: o que
    // importa não é "o portão foi chamado", é "o argv que o processo recebeu carrega a cerca".
    const chamadas = [capturado.args].filter(Boolean);
    expect(chamadas, "nenhum comando chegou ao spawn — o run não nasceu").toHaveLength(1);
    // A propriedade que um regex sobre a fonte não dá: o que o portão VIU é byte-a-byte o que o CLI
    // recebeu. Uma mutação que filtre o `--settings` entre a checagem e o spawn quebra esta igualdade.
    // A ordem "portão antes do spawn" deixou de ser uma pergunta: as duas viraram uma expressão só
    // (`spawnContidoArgv`). O que resta afirmar é o que o processo RECEBEU.
    // E o comando é o da postura contida: aponta a cerca, declara o modo load-bearing, e não pula nada.
    const args = [...(capturado.args ?? [])];
    expect(args).toContain("--settings");
    expect(args[args.indexOf("--settings") + 1]).toBe((posturaUsada as Extract<AutonomyPosture, { kind: "sandboxed" }>).settingsFile);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args.some((a) => a.includes("skip-permissions"))).toBe(false);
    // O envelope de escrita é o worktree do juiz (o mundo dele), não a raiz do repositório.
    expect((posturaUsada as Extract<AutonomyPosture, { kind: "sandboxed" }>).writeRoot).toBe(worktree);
    expect(worktree.startsWith(repoRoot)).toBe(true);
    // ── O ENV DO FILHO, no spawn REAL (não só na função pura) ────────────────────────────────────
    // IS_SANDBOX=1 é o bypass que o CLI exige para aceitar autonomia plena como root. Numa postura
    // CONTIDA ele não tem o que fazer — e era emitido incondicionalmente, que é o default que
    // reintroduz o bypass justamente onde a fase acabou de tirá-lo.
    expect(capturado.env?.IS_SANDBOX, "postura contida não pode declarar IS_SANDBOX").toBeUndefined();
    // O env passa pelo chokepoint (sanitizeSpawnEnv ⊕ headroom): nenhum tier de credencial MCP viaja.
    expect(Object.keys(capturado.env ?? {}).filter((k) => k.startsWith("STORYMAP_MCP_TOKEN"))).toEqual([]);
  });

  it("(c) o portão é LOAD-BEARING: settings que não é fronteira ⇒ erro e NENHUM spawn", async () => {
    // Prova que o portão não é decorativo neste caminho: com a cerca desarmada (`enabled: false`), o
    // ponteiro continua válido e o comando continua bem-formado — só o CONTEÚDO mente. Quem pega isso é
    // a leitura do arquivo no instante do spawn, e o resultado tem de ser "não roda".
    const registro: string[] = [];
    const capturado: { args?: readonly string[] } = {};
    const r = await spawnResolutionJudge(REQ, {
      claudeBin: "claude",
      repoRoot: repoTmp(),
      exec: execFalso(registro),
      resolvePosture: (cwd) => posturaContida(cwd, (sandbox) => void (sandbox.enabled = false)),
      spawn: spawnFalso(capturado),
    });
    expect(capturado.args, "a cerca estava desarmada e o agente nasceu assim mesmo").toBeUndefined();
    expect(r.error).toContain("[autonomy]");
    expect(r.resolvedRef).toBeUndefined();
  });
});

describe("buildJudgeArgs — a tradução postura → argv (PURA)", () => {
  it("postura CONTIDA: cerca + modo load-bearing, e a superfície MCP fechada", () => {
    const p = posturaContida("/wt");
    const { args, needsRootBypass } = buildJudgeArgs(p, "/tmp/nota.md");
    expect(args.slice(0, 2)).toEqual(["-p", "/harness-resolve"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--settings") + 1]).toBe((p as Extract<AutonomyPosture, { kind: "sandboxed" }>).settingsFile);
    expect(needsRootBypass, "postura contida não precisa do bypass de root").toBe(false);
    expect(() => assertContainmentReachedArgv(p, args)).not.toThrow();
  });

  it("postura REBAIXADA: perde o Bash DE VERDADE (sem cerca, sem shell) e passa no portão", () => {
    const p: AutonomyPosture = { kind: "downgraded", tier: "write", warn: "sem sandbox neste host" };
    const { args, needsRootBypass } = buildJudgeArgs(p, "/tmp/nota.md");
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Bash");
    expect(args.some((a) => a.includes("skip-permissions"))).toBe(false);
    expect(needsRootBypass).toBe(false);
    expect(() => assertContainmentReachedArgv(p, args)).not.toThrow();
  });

  it("a válvula explícita sinaliza o bypass de root — descartá-lo faria o CLI recusar o comando", () => {
    const p: AutonomyPosture = { kind: "unsandboxed-escape", tier: "full", warn: "declarado" };
    const { args, needsRootBypass } = buildJudgeArgs(p, "/tmp/nota.md");
    expect(needsRootBypass).toBe(true);
    // `--permission-mode` e o bypass se excluem no CLI: a válvula emite um, e só um.
    expect(args).not.toContain("--permission-mode");
  });
});
