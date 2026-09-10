import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── O PORTÃO É ESPIONADO, NÃO SUBSTITUÍDO (F0 · ADR-067) ────────────────────────────────────────────
// `vi.fn(orig.…)` embrulha a implementação REAL: dá para afirmar COM QUE argv o portão foi chamado sem
// trocar o guarda por um dublê que aprova tudo.
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
import {
  buildPeerReviewContextNote,
  buildPeerReviewPrompt,
  buildReviewerArgs,
  buildReviewerEnv,
  parsePeerVerdict,
  spawnPeerReview,
  type PeerReviewRequest,
} from "./peer-review-spawn";

// autonomo-liberdade-humana M1 — the SECURITY-critical logic of peer review is pure and lives here:
//  (a) the BLINDING — the reviewer's context note must carry the objective diff but NEVER the proponent's case;
//  (b) FAIL-CLOSED parsing — anything short of an explicit, rationale-backed `approve` approves NOTHING.
// The spawn lifecycle itself (a real headless claude in an isolated temp dir) is validated live, like the
// resolution judge; the wrapper's authority is these two pure guarantees.

describe("parsePeerVerdict — fail-closed (M1)", () => {
  it("approve com rationale ⇒ aceito", () => {
    const r = parsePeerVerdict(JSON.stringify({ verdict: "approve", rationale: "coerente com o card" }));
    expect(r).toEqual({ verdict: "approve", rationale: "coerente com o card", concerns: [] });
  });

  it("reject SEM rationale ⇒ aceito (rejeitar nada aplica, é seguro)", () => {
    const r = parsePeerVerdict(JSON.stringify({ verdict: "reject" }));
    expect("error" in r).toBe(false);
    if (!("error" in r)) expect(r.verdict).toBe("reject");
  });

  it("approve SEM rationale ⇒ ERRO (aprovação de governança sem porquê não é auditável)", () => {
    const r = parsePeerVerdict(JSON.stringify({ verdict: "approve", rationale: "  " }));
    expect("error" in r).toBe(true);
  });

  it("verdict desconhecido ('maybe') ⇒ ERRO, NUNCA coerção", () => {
    const r = parsePeerVerdict(JSON.stringify({ verdict: "maybe", rationale: "x" }));
    expect("error" in r).toBe(true);
  });

  it("JSON inválido ⇒ ERRO", () => {
    expect("error" in parsePeerVerdict("{ not json")).toBe(true);
  });

  it("objeto vazio / sem verdict ⇒ ERRO", () => {
    expect("error" in parsePeerVerdict("{}")).toBe(true);
    expect("error" in parsePeerVerdict("null")).toBe(true);
  });
});

describe("buildPeerReviewContextNote — BLINDING (M1)", () => {
  const req: PeerReviewRequest = {
    board: "acme",
    draftId: "gd-1",
    changes: [{ artifact: "positioning", label: "Posicionamento", before: "antes-XYZZY", after: "depois-PLUGH" }],
    cardContext: "Card story-1: Melhorar copy\nAceite:\n- clareza",
    // NOTE: PeerReviewRequest has NO `reason` field by design — the proponent's argument cannot even be passed.
  };

  it("carrega os FATOS: o antes, o depois e o contexto objetivo do card", () => {
    const note = buildPeerReviewContextNote(req);
    expect(note).toContain("antes-XYZZY");
    expect(note).toContain("depois-PLUGH");
    expect(note).toContain("Melhorar copy");
    expect(note).toContain("Board: acme");
  });

  it("diz ao revisor que ele é INDEPENDENTE e está isolado (não alcança o board)", () => {
    const note = buildPeerReviewContextNote(req);
    expect(note.toLowerCase()).toContain("isolado");
    // e não vaza nenhum campo de argumento do proponente — o tipo não tem `reason`, então é estrutural.
    expect(note).not.toContain("reason");
  });
});

describe("buildReviewerEnv — o revisor não recebe NENHUM token MCP (M1, hardening pós-review)", () => {
  it("remove o token FULL E o token SCOPED orch (o revisor precisa de zero MCP)", () => {
    const env = buildReviewerEnv({
      AGILEHARNESS_MCP_TOKEN: "full-xyz",
      AGILEHARNESS_MCP_TOKEN_ORCH: "orch-xyz",
      PATH: "/usr/bin",
      HOME: "/root",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.AGILEHARNESS_MCP_TOKEN).toBeUndefined();
    expect(env.AGILEHARNESS_MCP_TOKEN_ORCH).toBeUndefined(); // a chave que sanitizeSpawnEnv sozinho DEIXAVA passar
    expect(env.HOME).toBe("/root"); // env legítimo preservado
  });
});

describe("buildPeerReviewPrompt — contrato (M1)", () => {
  it("exige o veredito em ARQUIVO com o schema, e manda REJEITAR na dúvida", () => {
    const p = buildPeerReviewPrompt(".harness-peer-review.json");
    expect(p).toContain(".harness-peer-review.json");
    expect(p).toContain('"verdict"');
    expect(p.toUpperCase()).toContain("REJEITE"); // default seguro
    expect(p.toLowerCase()).toContain("independente");
  });
});

// ── F0 (ADR-067) — A CONTENÇÃO DO REVISOR ───────────────────────────────────────────────────────────
// O revisor é alcançável EM BANDA: um agente autônomo já contido chama `request_peer_review` e daí
// nascia um agente NÃO contido, como root, sobre conteúdo que o próprio proponente escreveu. O tempdir
// e o env sem token MCP escolhiam ONDE ele estava e O QUE ele sabia — nunca o que ele podia EXECUTAR.
//
// As duas provas que este bloco cobra, e que um lint de regex sobre a fonte NÃO dá: (a) postura
// RECUSADA não spawna nada; (b) o portão é chamado com o argv FINAL, antes do spawn.

const SETTINGS_DIR = mkdtempSync(path.join(os.tmpdir(), "ah-peer-fence-"));
const STATE_ROOT = path.join(SETTINGS_DIR, "state");

/** A cerca escrita em disco é lida DURANTE o spawn; por isso só some no fim de tudo. Sem esta remoção
 *  cada passada do portão deixava um `/tmp/ah-peer-fence-XXXXXX` com os settings dentro. */
afterAll(() => {
  rmSync(SETTINGS_DIR, { recursive: true, force: true });
});

/** Postura `sandboxed` com settings REAL no disco — o portão lê o arquivo e confere sha + cerca.
 *  `desarmar` produz a cerca DESARMADA (ponteiro válido, conteúdo que não contém). */
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

const PEDIDO: PeerReviewRequest = {
  board: "acme",
  draftId: "gd-1",
  changes: [{ artifact: "positioning", before: "antes", after: "depois" }],
};

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

describe("spawnPeerReview — a contenção do revisor (F0)", () => {
  beforeEach(() => {
    vi.mocked(assertContainmentReachedArgv).mockClear();
    // O proxy de headroom não é objeto deste teste; sem o opt-out, cada spawn sondaria localhost.
    vi.stubEnv("AGILEHARNESS_HEADROOM_URL", "off");
  });

  it("(a) postura RECUSADA ⇒ o revisor NÃO spawna, e a proposta segue pendente para um humano", async () => {
    const capturado: { args?: readonly string[] } = {};
    const r = await spawnPeerReview(PEDIDO, {
      claudeBin: "claude",
      resolvePosture: () => ({ kind: "refused", reason: "o alvo declara sandbox próprio" }),
      spawn: spawnFalso(capturado),
    });
    expect(capturado.args, "a postura recusou e mesmo assim um agente nasceu").toBeUndefined();
    // A recusa é aplicada ANTES da montagem — o portão nem é consultado (ele também recusaria, mas
    // depender disso deixaria o ramo deste módulo livre para sumir sem teste nenhum reclamar).
    expect(vi.mocked(assertContainmentReachedArgv), "a recusa chegou a montar um comando").not.toHaveBeenCalled();
    expect(r.error).toContain("o alvo declara sandbox próprio");
    expect(r.verdict, "recusa não pode produzir veredito — nada é aprovado").toBeUndefined();
  });

  it("(b) o PORTÃO é chamado com o argv FINAL, ANTES do spawn — e o argv carrega a cerca, não o bypass", async () => {
    const capturado: { args?: readonly string[]; portaoJaChamado?: number; env?: NodeJS.ProcessEnv } = {};
    let tempdir = "";
    let posturaUsada: ReturnType<typeof posturaContida> | undefined;
    vi.stubEnv("AGILEHARNESS_MCP_TOKEN_ORCH", "orch-xyz");
    // O pai AFIRMA estar num sandbox — o caso MEDIDO nesta caixa (o serviço herda a chave de quem o
    // iniciou). O filho contido não pode receber isso por herança: quem afirma tem de ser quem decidiu.
    vi.stubEnv("IS_SANDBOX", "1");
    await spawnPeerReview(PEDIDO, {
      claudeBin: "claude",
      resolvePosture: (cwd) => {
        tempdir = cwd;
        posturaUsada = posturaContida(cwd);
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
    // A ordem "portão antes do spawn" deixou de ser uma asserção porque deixou de ser uma pergunta: as
    // duas viraram uma expressão só. O que resta afirmar é o que o processo RECEBEU.
    const args = [...(capturado.args ?? [])];
    expect(args[args.indexOf("--settings") + 1], "o argv do spawn não aponta para a cerca desta postura").toBe(
      (posturaUsada as Extract<AutonomyPosture, { kind: "sandboxed" }>).settingsFile,
    );
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args.some((a) => a.includes("skip-permissions"))).toBe(false);
    // O envelope de escrita é o tempdir do revisor — o mais estreito que existe aqui: não é checkout
    // de nada, e NÃO é a árvore de dados do board (que é justamente o que ele propõe alterar).
    expect((posturaUsada as Extract<AutonomyPosture, { kind: "sandboxed" }>).writeRoot).toBe(tempdir);
    expect(tempdir).toContain("harness-peer-review-");
    // ── O ENV DO FILHO, no spawn REAL (não só na função pura) ────────────────────────────────────
    // IS_SANDBOX=1 é o bypass que o CLI exige para aceitar autonomia plena como root. Numa postura
    // CONTIDA ele não tem o que fazer: setá-lo é anunciar ao CLI um sandbox que quem contém é o
    // harness. Era incondicional — um default que reintroduz o bypass é o que a fase remove.
    expect(capturado.env?.IS_SANDBOX, "postura contida não pode declarar IS_SANDBOX").toBeUndefined();
    // E o invariante "revisor sem credencial" agora vale no caminho de spawn, não só no unitário puro.
    expect(Object.keys(capturado.env ?? {}).filter((k) => k.startsWith("AGILEHARNESS_MCP_TOKEN"))).toEqual([]);
  });

  it("(c) o portão é LOAD-BEARING: settings que não é fronteira ⇒ erro e NENHUM spawn", async () => {
    const capturado: { args?: readonly string[] } = {};
    const r = await spawnPeerReview(PEDIDO, {
      claudeBin: "claude",
      // Ponteiro válido, comando bem-formado — só o CONTEÚDO mente (a cerca desligada). Quem pega isso
      // é a leitura do arquivo no instante do spawn.
      resolvePosture: (cwd) => posturaContida(cwd, (sandbox) => void (sandbox.allowUnsandboxedCommands = true)),
      spawn: spawnFalso(capturado),
    });
    expect(capturado.args, "a cerca estava desarmada e o agente nasceu assim mesmo").toBeUndefined();
    expect(r.error).toContain("[autonomy]");
    expect(r.verdict).toBeUndefined();
  });
});

describe("buildReviewerArgs — a tradução postura → argv (PURA)", () => {
  const opts = { prompt: "julgue", notePath: "/tmp/nota.md" };

  it("postura CONTIDA: cerca + modo load-bearing, e a superfície MCP fechada", () => {
    const p = posturaContida("/wt");
    const { args, needsRootBypass } = buildReviewerArgs(p, opts);
    expect(args.slice(0, 2)).toEqual(["-p", "julgue"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args[args.indexOf("--settings") + 1]).toBe((p as Extract<AutonomyPosture, { kind: "sandboxed" }>).settingsFile);
    expect(needsRootBypass, "postura contida não precisa do bypass de root").toBe(false);
    expect(() => assertContainmentReachedArgv(p, args)).not.toThrow();
  });

  it("postura REBAIXADA: perde o Bash DE VERDADE (sem cerca, sem shell) e passa no portão", () => {
    const p: AutonomyPosture = { kind: "downgraded", tier: "write", warn: "sem sandbox neste host" };
    const { args, needsRootBypass } = buildReviewerArgs(p, opts);
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Bash");
    expect(args.some((a) => a.includes("skip-permissions"))).toBe(false);
    expect(needsRootBypass).toBe(false);
    expect(() => assertContainmentReachedArgv(p, args)).not.toThrow();
  });

  it("a válvula explícita sinaliza o bypass de root — descartá-lo faria o CLI recusar o comando", () => {
    const p: AutonomyPosture = { kind: "unsandboxed-escape", tier: "full", warn: "declarado" };
    const { args, needsRootBypass } = buildReviewerArgs(p, opts);
    expect(needsRootBypass).toBe(true);
    expect(args).not.toContain("--permission-mode");
  });
});
