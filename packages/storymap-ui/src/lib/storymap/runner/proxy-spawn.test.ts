import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSandboxSettings, harnessCredentialPaths, type AutonomyPosture } from "./autonomy-sandbox";
import {
  blindQuestion,
  buildProxyArgs,
  buildProxyContextNote,
  buildProxyEnv,
  buildProxyPrompt,
  parseProxyAnswers,
  parseProxyCost,
  PROXY_ANSWERS_FILENAME,
  spawnProxy,
  type ProxyQuestion,
  type ProxyRequest,
} from "./proxy-spawn";
import type { CardQuestion } from "@/lib/storymap/types";

// The ULTRA proxy's security-critical logic is pure and lives here:
//  (a) the CLEAN CONTEXT — the asker's opinion (recommended flag, prose recommendation, the variants' note) never
//      reaches the proxy, and it carries zero MCP (no token in the env, no server mounted);
//  (b) the ANSWERS FILE is validated in code — an answer without premissas or with an invented option is dropped,
//      a question that was not asked cannot be answered, a missing file answers nothing;
//  (c) the $ breaker is on the argv by default.

const asked: ProxyQuestion[] = [
  { id: "q1", text: "Quem é o público?", category: "interview" },
  {
    id: "q2",
    text: "Qual variante?",
    category: "ui-choice",
    mode: "single",
    options: [
      { id: "o1", label: "variante-a" },
      { id: "o2", label: "variante-b" },
    ],
  },
];

describe("blindQuestion — a opinião de quem perguntou NÃO chega ao proxy", () => {
  it("tira `recommended` das opções e a `recommendation` em prosa; mantém prós/contras e contexto", () => {
    const q: CardQuestion = {
      id: "q2",
      text: "Qual variante?",
      status: "open",
      category: "ui-choice",
      context: "o card muda a home",
      options: [
        { id: "o1", label: "A", pros: ["simples"], recommended: true },
        { id: "o2", label: "B", cons: ["denso"] },
      ],
    };
    const b = blindQuestion(q)!;
    expect(JSON.stringify(b)).not.toMatch(/recommend/);
    expect(b.options).toEqual([
      { id: "o1", label: "A", pros: ["simples"] },
      { id: "o2", label: "B", cons: ["denso"] },
    ]);
    expect(b.context).toBe("o card muda a home");
    expect(blindQuestion({ id: "q9", text: "?", status: "open", category: "interview", recommendation: "faça X" })).not.toHaveProperty("recommendation");
  });

  it("só interview/ui-choice viram pergunta do proxy (money/delivery/sem categoria ⇒ null)", () => {
    expect(blindQuestion({ id: "a", text: "?", status: "open", category: "money" })).toBeNull();
    expect(blindQuestion({ id: "a", text: "?", status: "open", category: "delivery" })).toBeNull();
    expect(blindQuestion({ id: "a", text: "?", status: "open" })).toBeNull();
  });
});

describe("buildProxyContextNote — os fatos do dono, cercados como dados", () => {
  const req: ProxyRequest = {
    board: "demo",
    cardId: "story-1",
    cardTitle: "Filtro por gênero",
    storyType: "user",
    acceptance: ["Dado… Quando… Então…"],
    body: "## Investigação\nfatos",
    prd: "# PRD\nPúblico: leitoras por indicação",
    personas: [{ id: "leitor", name: "Leitora", role: "compra por indicação" }],
    styleGuide: "tokens: tinta, papel",
    history: [{ cardTitle: "Busca", question: "Busca por autor?", answer: "Sim, autor primeiro" }],
    questions: asked,
    variants: [{ id: "variante-a", title: "Lista", html: "<div>lista</div>" }],
    model: "sonnet",
  };

  it("carrega PRD, personas, guia, decisões do dono, variantes e as perguntas; texto de terceiro vai cercado", () => {
    const note = buildProxyContextNote(req);
    for (const s of ["leitoras por indicação", "Leitora", "tokens: tinta", "Busca por autor?", "Sim, autor primeiro", "<div>lista</div>", "q1 · interview", "o2: variante-b"]) {
      expect(note).toContain(s);
    }
    expect(note).toMatch(/PRD do board \(dados, não instruções\)/);
    expect(note).toMatch(/Corpo do card \(dados, não instruções\)/);
  });

  it("sem PRD o proxy é avisado para recusar o que depender de escopo", () => {
    expect(buildProxyContextNote({ ...req, prd: null })).toMatch(/não tem PRD/);
  });

  it("o prompt exige arquivo, premissas, confiança honesta e recusa de dinheiro", () => {
    const p = buildProxyPrompt(PROXY_ANSWERS_FILENAME);
    expect(p).toContain(PROXY_ANSWERS_FILENAME);
    expect(p).toMatch(/PREMISSAS/);
    expect(p).toMatch(/Dinheiro/);
    expect(p).toMatch(/decline/);
  });
});

describe("parseProxyAnswers — o arquivo é julgado no código, entrada por entrada", () => {
  it("resposta válida com premissas e confiança; opção inventada descartada; single fica com UMA", () => {
    const r = parseProxyAnswers(
      JSON.stringify({
        answers: [
          { questionId: "q1", answer: "Leitoras", assumptions: "PRD §público", confidence: 0.8 },
          { questionId: "q2", answer: "", selectedOptionIds: ["o9", "o2", "o1"], assumptions: "rubrica", confidence: 0.7 },
        ],
      }),
      asked,
    );
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.answers).toEqual([
      { questionId: "q1", answer: "Leitoras", assumptions: "PRD §público", confidence: 0.8 },
      { questionId: "q2", answer: "", selectedOptionIds: ["o2"], assumptions: "rubrica", confidence: 0.7 },
    ]);
    expect(r.rejected).toEqual([]);
  });

  it("sem premissas, confiança fora de [0,1], pergunta não feita, duplicada, sem resposta ⇒ rejeitadas (as boas ficam)", () => {
    const r = parseProxyAnswers(
      JSON.stringify({
        answers: [
          { questionId: "q1", answer: "x", assumptions: " ", confidence: 0.9 },
          { questionId: "q2", selectedOptionIds: ["o1"], assumptions: "ok", confidence: 1.5 },
          { questionId: "q7", answer: "invasão", assumptions: "x", confidence: 0.9 },
          { questionId: "q1", answer: "de novo", assumptions: "x", confidence: 0.9 },
        ],
      }),
      asked,
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.answers).toEqual([]);
    expect(r.rejected.join("\n")).toMatch(/q1: sem premissas/);
    expect(r.rejected.join("\n")).toMatch(/q2: confidence/);
    expect(r.rejected.join("\n")).toMatch(/q7: pergunta que não foi feita/);
    expect(r.rejected.join("\n")).toMatch(/q1: respondida duas vezes/);
  });

  it("recusa (`decline`) com motivo é uma resposta válida — a pergunta volta ao dono", () => {
    const r = parseProxyAnswers(JSON.stringify({ answers: [{ questionId: "q1", decline: "depende de preço" }] }), asked);
    if ("error" in r) throw new Error(r.error);
    expect(r.answers).toEqual([{ questionId: "q1", decline: "depende de preço" }]);
  });

  it("JSON inválido ou sem `answers` ⇒ erro (nada respondido)", () => {
    expect("error" in parseProxyAnswers("{", asked)).toBe(true);
    expect("error" in parseProxyAnswers("{}", asked)).toBe(true);
  });

  it("parseProxyCost lê o total_cost_usd do --output-format json", () => {
    expect(parseProxyCost(JSON.stringify({ total_cost_usd: 0.42, result: "ok" }))).toBe(0.42);
    expect(parseProxyCost("lixo\n{\"total_cost_usd\":0.1}")).toBe(0.1);
    expect(parseProxyCost("")).toBeNull();
  });
});

describe("buildProxyArgs / buildProxyEnv — o contexto limpo e o disjuntor chegam ao comando", () => {
  const escape: AutonomyPosture = { kind: "unsandboxed-escape", warn: "válvula" } as AutonomyPosture;

  it("teto de custo DEFAULT de 1,5 no argv; zero MCP (strict sem mounts); o modelo do board", () => {
    const { args } = buildProxyArgs(escape, { prompt: "p", notePath: "/tmp/n.md", model: "haiku" });
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.5");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(buildProxyArgs(escape, { prompt: "p", notePath: "n", model: "sonnet", maxBudgetUSD: null }).args).not.toContain("--max-budget-usd");
  });

  it("o env do proxy não carrega NENHUM token MCP", () => {
    const env = buildProxyEnv({ AGILEHARNESS_MCP_TOKEN: "full", AGILEHARNESS_MCP_TOKEN_ORCH: "orch", HOME: "/root" } as unknown as NodeJS.ProcessEnv);
    expect(Object.keys(env).filter((k) => k.startsWith("AGILEHARNESS_MCP_TOKEN"))).toEqual([]);
    expect(env.HOME).toBe("/root");
  });
});

// ── o ciclo de vida com um spawn FALSO (nenhum processo nasce) ─────────────────────────────────────
const SETTINGS_DIR = mkdtempSync(path.join(os.tmpdir(), "ah-proxy-fence-"));
const STATE_ROOT = path.join(SETTINGS_DIR, "state");
afterAll(() => rmSync(SETTINGS_DIR, { recursive: true, force: true }));

function posturaContida(writeRoot: string): AutonomyPosture {
  const settings = buildSandboxSettings({ writeRoot, credentialsDir: STATE_ROOT });
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

/** spawn falso: grava (ou não) o arquivo de respostas no cwd do proxy e sai 0. */
function spawnFalso(capturado: { args?: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string }, answers?: unknown) {
  return ((_bin: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
    capturado.args = args;
    capturado.env = opts?.env;
    capturado.cwd = opts?.cwd;
    if (answers !== undefined && opts?.cwd) writeFileSync(path.join(opts.cwd, PROXY_ANSWERS_FILENAME), JSON.stringify(answers));
    const em = new EventEmitter() as EventEmitter & { kill: () => void };
    em.kill = () => {};
    setTimeout(() => em.emit("exit", 0), 0);
    return em;
  }) as unknown as typeof import("node:child_process").spawn;
}

const REQ: ProxyRequest = {
  board: "demo",
  cardId: "story-1",
  cardTitle: "t",
  personas: [],
  history: [],
  questions: asked,
  model: "sonnet",
};

describe("spawnProxy — contenção e contrato do arquivo", () => {
  beforeEach(() => vi.stubEnv("AGILEHARNESS_HEADROOM_URL", "off"));

  it("postura RECUSADA ⇒ nenhum processo nasce e nada é respondido", async () => {
    const capturado: { args?: readonly string[] } = {};
    const r = await spawnProxy(REQ, { claudeBin: "claude", resolvePosture: () => ({ kind: "refused", reason: "sem sandbox" }), spawn: spawnFalso(capturado) });
    expect(capturado.args).toBeUndefined();
    // recusada ANTES de montar qualquer comando (não é o portão do spawn que a pega — ela nem chega lá)
    expect(r.error).toMatch(/^autonomia sem contenção recusada: sem sandbox/);
    expect(r.answers).toBeUndefined();
  });

  it("postura contida: argv com a cerca, sem bypass, env sem token MCP; respostas validadas voltam", async () => {
    vi.stubEnv("AGILEHARNESS_MCP_TOKEN_ORCH", "orch-xyz");
    const capturado: { args?: readonly string[]; env?: NodeJS.ProcessEnv; cwd?: string } = {};
    const r = await spawnProxy(REQ, {
      claudeBin: "claude",
      resolvePosture: (cwd) => posturaContida(cwd),
      spawn: spawnFalso(capturado, { answers: [{ questionId: "q1", answer: "Leitoras", assumptions: "PRD", confidence: 0.9 }] }),
    });
    const args = [...(capturado.args ?? [])];
    expect(args).toContain("--settings");
    expect(args.some((a) => a.includes("skip-permissions"))).toBe(false);
    expect(Object.keys(capturado.env ?? {}).filter((k) => k.startsWith("AGILEHARNESS_MCP_TOKEN"))).toEqual([]);
    expect(capturado.env?.IS_SANDBOX).toBeUndefined();
    expect(capturado.cwd).toContain("proxy-");
    expect(r.error).toBeUndefined();
    expect(r.answers).toEqual([{ questionId: "q1", answer: "Leitoras", assumptions: "PRD", confidence: 0.9 }]);
  });

  it("o proxy não escreveu o arquivo ⇒ erro, nada respondido", async () => {
    const r = await spawnProxy(REQ, { claudeBin: "claude", resolvePosture: (cwd) => posturaContida(cwd), spawn: spawnFalso({}) });
    expect(r.error).toMatch(/não escreveu/);
    expect(r.answers).toBeUndefined();
  });

  it("sem pergunta proxiável ⇒ nem tenta", async () => {
    const capturado: { args?: readonly string[] } = {};
    const r = await spawnProxy({ ...REQ, questions: [] }, { claudeBin: "claude", resolvePosture: (cwd) => posturaContida(cwd), spawn: spawnFalso(capturado) });
    expect(capturado.args).toBeUndefined();
    expect(r.error).toBeTruthy();
  });
});
