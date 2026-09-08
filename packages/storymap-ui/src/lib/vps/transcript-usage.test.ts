import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearProjectModelMemo,
  clearSessionContextMemo,
  contextPct,
  contextWindowFor,
  parseLastAssistantUsage,
  parseLastCompactBoundary,
  pickProjectModel,
  readLastUsage,
  readProjectModels,
  readSessionContext,
  resolveWindow,
} from "./transcript-usage";

// Fixtures mirror the shape verified on a live transcript on this box:
//   {"type":"assistant","isSidechain":false,"timestamp":"…","message":{"model":"claude-opus-4-8",
//    "usage":{"input_tokens":2,"cache_creation_input_tokens":582,"cache_read_input_tokens":505650,
//             "output_tokens":1573,"service_tier":"standard"}}}
function assistantLine(
  u: { input: number; cc?: number; cr?: number; out?: number },
  over: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-07-23T13:52:56.870Z",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: u.input,
        cache_creation_input_tokens: u.cc ?? 0,
        cache_read_input_tokens: u.cr ?? 0,
        output_tokens: u.out ?? 0,
        service_tier: "standard",
      },
    },
    ...over,
  });
}

function userLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-23T13:52:50.000Z",
    message: { role: "user", content: "oi" },
    ...over,
  });
}

function compactLine(at: string, postTokens: number | null): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    isSidechain: false,
    timestamp: at,
    content: "Conversation compacted",
    compactMetadata: postTokens === null ? { trigger: "manual" } : { trigger: "manual", preTokens: 667795, postTokens },
  });
}

/** A ~1 KB filler record that is NOT an assistant turn — bulk to push the real record out of the tail. */
function fillerLine(i: number): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-23T13:00:00.000Z",
    message: { role: "user", content: `${i}:${"x".repeat(900)}` },
  });
}

describe("transcript-usage — nível de contexto (puro)", () => {
  it("usa o ÚLTIMO turno como NÍVEL, nunca a soma dos turnos", () => {
    const chunk = [
      assistantLine({ input: 100, cc: 10, cr: 20, out: 30 }),
      assistantLine({ input: 200, cc: 10, cr: 20, out: 30 }),
      assistantLine({ input: 300, cc: 1, cr: 2, out: 3 }),
    ].join("\n");

    const usage = parseLastAssistantUsage(chunk);

    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(300);
    expect(usage?.contextTokens).toBe(306); // 300 + 1 + 2 + 3 — só o terceiro registro
    // O turno N já carrega toda a conversa anterior: somar contaria a mesma coisa N vezes.
    expect(usage?.contextTokens).toBeLessThan(600);
  });

  it("inclui output_tokens no nível (a resposta do modelo também ocupa a janela)", () => {
    const usage = parseLastAssistantUsage(assistantLine({ input: 10, cc: 20, cr: 30, out: 40 }));

    expect(usage?.contextTokens).toBe(100);
    expect(usage?.outputTokens).toBe(40);
  });

  it("lê o effort do TOPO do registro (irmão de `message`), e null quando ausente", () => {
    // Verificado num transcript vivo desta caixa (claude 2.1.220): `effort` é top-level, NÃO fica
    // dentro de `message` — procurá-lo lá devolveria null para toda sessão.
    expect(parseLastAssistantUsage(assistantLine({ input: 10 }, { effort: "xhigh" }))?.effort).toBe("xhigh");
    // Registro sem o campo (CLI mais antigo) é AUSENTE, não "esforço desconhecido" inventado.
    expect(parseLastAssistantUsage(assistantLine({ input: 10 }))?.effort).toBeNull();
    expect(parseLastAssistantUsage(assistantLine({ input: 10 }, { effort: "   " }))?.effort).toBeNull();
  });

  it("ignora usage que não esteja em type:assistant", () => {
    const chunk = [
      assistantLine({ input: 100, cc: 0, cr: 0, out: 0 }),
      userLine({ message: { role: "user", usage: { input_tokens: 9999, output_tokens: 9999 } } }),
    ].join("\n");

    expect(parseLastAssistantUsage(chunk)?.contextTokens).toBe(100);
  });

  it("ignora isSidechain (sub-agente tem janela própria)", () => {
    const chunk = [
      assistantLine({ input: 100, cc: 0, cr: 0, out: 0 }),
      assistantLine({ input: 777, cc: 0, cr: 0, out: 0 }, { isSidechain: true }),
    ].join("\n");

    expect(parseLastAssistantUsage(chunk)?.contextTokens).toBe(100);
  });

  it("linha malformada não é fatal — devolve o último registro válido", () => {
    const chunk = [
      assistantLine({ input: 100, cc: 0, cr: 0, out: 0 }),
      "{broken",
      assistantLine({ input: 200, cc: 0, cr: 0, out: 5 }),
      "isso não é json",
    ].join("\n");

    expect(parseLastAssistantUsage(chunk)?.contextTokens).toBe(205);
  });

  it("sem turno do modelo devolve null, nunca 0", () => {
    const chunk = [userLine(), JSON.stringify({ type: "system", subtype: "hook", timestamp: "x" }), userLine()].join(
      "\n",
    );

    expect(parseLastAssistantUsage(chunk)).toBeNull();
  });

  it("janela vem do modelo, não do transcript", () => {
    expect(contextWindowFor("opus[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-4-8")).toBe(200_000);
    expect(contextWindowFor(null)).toBeNull();
  });

  it("pct NÃO é clampado — 253% é reportado como 253%", () => {
    const over = contextPct(506_234, 200_000);
    expect(over).toBeGreaterThan(100);
    expect(over).toBeCloseTo(253.1, 1);

    expect(contextPct(506_234, 1_000_000)).toBe(50.6);
    expect(contextPct(1, null)).toBeNull();
  });

  it("compactação é detectada e não vira diff — o nível segue sendo o do turno", () => {
    const chunk = [
      assistantLine({ input: 100, cc: 0, cr: 0, out: 6 }, { timestamp: "2026-07-23T13:00:00.000Z" }),
      compactLine("2026-07-23T13:30:00.000Z", 15_749),
    ].join("\n");

    const compact = parseLastCompactBoundary(chunk);
    expect(compact).not.toBeNull();
    expect(compact?.postTokens).toBe(15_749);
    // postTokens é informativo: o NÍVEL continua vindo do registro de assistant.
    expect(parseLastAssistantUsage(chunk)?.contextTokens).toBe(106);
  });

  it("resolveWindow: config com [1m] vence o id pelado, e a observação falseia um limite impossível", () => {
    expect(resolveWindow({ model: "claude-opus-4-8", configuredModel: "opus[1m]", observedTokens: 150_000 })).toEqual({
      limit: 1_000_000,
      source: "config",
    });
    expect(resolveWindow({ model: "claude-opus-4-8", configuredModel: null, observedTokens: 150_000 })).toEqual({
      limit: 200_000,
      source: "model",
    });
    // 506_234 tokens NÃO cabem em 200k: o limite é provadamente errado → sobe para o tier que cabe.
    expect(resolveWindow({ model: "claude-opus-4-8", configuredModel: null, observedTokens: 506_234 })).toEqual({
      limit: 1_000_000,
      source: "observed",
    });
    expect(resolveWindow({ model: "modelo-desconhecido", configuredModel: null, observedTokens: 10 }).limit).toBeNull();
  });
});

describe("transcript-usage — leitura de cauda (fs real)", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    clearSessionContextMemo();
    dir = mkdtempSync(path.join(os.tmpdir(), "transcript-usage-"));
    // Isola o default do operador: sem settings.json aqui, readConfiguredModel devolve null.
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    clearSessionContextMemo();
    rmSync(dir, { recursive: true, force: true });
  });

  it("tail escalona quando o registro está fora do orçamento", async () => {
    const file = path.join(dir, "grande.jsonl");
    const head: string[] = [];
    for (let i = 0; i < 600; i++) head.push(fillerLine(i)); // ~600 KB antes do registro
    const tail: string[] = [];
    for (let i = 0; i < 300; i++) tail.push(fillerLine(1000 + i)); // ~300 KB depois dele
    const content = [...head, assistantLine({ input: 111_000, cc: 1, cr: 2, out: 3 }), ...tail].join("\n");
    writeFileSync(file, content);

    // A janela de 256 KB começa no meio de uma linha de filler (que precisa ser descartada sem explodir)
    // e não alcança o registro — só a escalada 256 KB → 1 MB devolve a verdade.
    const read = await readLastUsage(file, 256 * 1024);

    expect(read).not.toBeNull();
    expect(read?.usage?.contextTokens).toBe(111_006);
  });

  it("a primeira linha parcial é descartada — fragmento de JSON não vira registro", async () => {
    const file = path.join(dir, "parcial.jsonl");
    const budget = 8 * 1024;
    const real = assistantLine({ input: 111, cc: 0, cr: 0, out: 0 });
    // A ARMADILHA: linha inteira é `@@@@…{json}` — inválida como linha (prefixo de lixo), mas o SUFIXO
    // a partir do `{` é um assistant record perfeitamente parseável com outro número.
    const trap = assistantLine({ input: 999_999, cc: 0, cr: 0, out: 0 });
    const junk = "@".repeat(64);

    const filler = `${userLine()}\n`;
    const tailTarget = budget - Buffer.byteLength(trap) - 1; // "\n" depois da armadilha
    let tail = "";
    while (Buffer.byteLength(tail) + Buffer.byteLength(filler) <= tailTarget) tail += filler;
    tail += " ".repeat(tailTarget - Buffer.byteLength(tail));

    // size - budget cai EXATAMENTE no `{` da armadilha → a janela começa num fragmento válido.
    writeFileSync(file, `${real}\n${junk}${trap}\n${tail}`);

    const read = await readLastUsage(file, budget);

    expect(read?.usage?.contextTokens).toBe(111);
    expect(read?.usage?.inputTokens).not.toBe(999_999);
  });

  it("memo invalida por mtime/size — um turno novo nunca é servido do cache", async () => {
    const file = path.join(dir, "sessao.jsonl");
    writeFileSync(file, `${assistantLine({ input: 100, cc: 0, cr: 0, out: 0 })}\n`);

    const first = await readSessionContext(file);
    expect(first?.contextTokens).toBe(100);

    appendFileSync(file, `${assistantLine({ input: 200, cc: 0, cr: 0, out: 5 })}\n`);
    const bump = Date.now() / 1000 + 5;
    utimesSync(file, bump, bump);

    const second = await readSessionContext(file);
    expect(second?.contextTokens).toBe(205);
    expect(second?.limit).toBe(200_000); // id pelado, sem [1m] em lugar nenhum
    expect(second?.limitSource).toBe("model");
  });
});

// ── Achados de revisão adversarial, fixados aqui para não reincidirem ──────────
describe("resolveWindow — o default global NÃO governa uma sessão de outra família", () => {
  it("config `opus[1m]` NÃO se aplica a uma sessão sonnet — seria subnotificar 5x", () => {
    // Esta caixa tem `~/.claude/settings.json` com model "opus[1m]", enquanto a maior parte do
    // trabalho da frota roda em sonnet (janela de 200k). Aplicar o default a todo painel media uma
    // sessão sonnet contra 1M: 40% viravam 8%, e o operador só descobriria ao estourar.
    expect(resolveWindow({ model: "claude-sonnet-5", configuredModel: "opus[1m]", observedTokens: 100 }))
      .toEqual({ limit: 200_000, source: "model" });
  });

  it("config `opus[1m]` SE aplica quando a família bate", () => {
    expect(resolveWindow({ model: "claude-opus-4-8", configuredModel: "opus[1m]", observedTokens: 100 }))
      .toEqual({ limit: 1_000_000, source: "config" });
  });

  it("um pin explícito do spawner vence o default do operador", () => {
    // `--model sonnet` foi escolhido para ESTA sessão; o default do operador não a descreve.
    expect(resolveWindow({
      model: "claude-sonnet-5", pinnedModel: "sonnet", configuredModel: "opus[1m]", observedTokens: 100,
    })).toEqual({ limit: 200_000, source: "model" });
    // e um pin que carrega [1m] é o único sinal que precisa ser respeitado
    expect(resolveWindow({
      model: "claude-opus-4-8", pinnedModel: "opus[1m]", configuredModel: null, observedTokens: 100,
    })).toEqual({ limit: 1_000_000, source: "config" });
  });

  it("sem modelo observado, o default ainda vale — não há o que o contradiga", () => {
    expect(resolveWindow({ model: null, configuredModel: "opus[1m]", observedTokens: 100 }))
      .toEqual({ limit: 1_000_000, source: "config" });
  });
});

// ── A janela de 1M que o transcript não sabe dizer (incidente 2026-08-02) ──────
describe("pickProjectModel — o registro do CLI por projeto", () => {
  it("casa pelo id PELADO e devolve o id COMPLETO (com o sufixo)", () => {
    // O transcript grava `claude-opus-5`; `~/.claude.json` grava `claude-opus-5[1m]`. A junção é o id
    // pelado — não um palpite por família, que confundiria opus-5 com opus-4-8.
    expect(pickProjectModel(["claude-opus-5[1m]"], "claude-opus-5")).toBe("claude-opus-5[1m]");
    expect(pickProjectModel(["claude-sonnet-5", "claude-opus-5[1m]"], "claude-opus-5")).toBe("claude-opus-5[1m]");
  });

  it("recusa quando o registro não descreve ESTA sessão", () => {
    expect(pickProjectModel(["claude-opus-5[1m]"], "claude-sonnet-5")).toBeNull(); // outro modelo
    expect(pickProjectModel(["claude-opus-5[1m]"], null)).toBeNull(); // sem âncora
    expect(pickProjectModel([], "claude-opus-5")).toBeNull(); // projeto sem registro
  });

  it("AMBÍGUO é recusa — as duas variantes rodaram aqui e o registro não diz qual é esta", () => {
    // Chutar a de 1M SUBNOTIFICARIA uma sessão de 200k cheia, que é a direção perigosa: o operador
    // leria 20% numa sessão prestes a compactar.
    expect(pickProjectModel(["claude-opus-5", "claude-opus-5[1m]"], "claude-opus-5")).toBeNull();
  });
});

describe("resolveWindow — o registro do projeto entra entre o pin e o default global", () => {
  it("projeto com `[1m]` resolve a janela que o id pelado não consegue expressar", () => {
    expect(
      resolveWindow({
        model: "claude-opus-5",
        projectModel: "claude-opus-5[1m]",
        configuredModel: null,
        observedTokens: 195_425,
      }),
    ).toEqual({ limit: 1_000_000, source: "config" });
  });

  it("o registro do projeto NÃO atravessa famílias", () => {
    expect(
      resolveWindow({ model: "claude-sonnet-5", projectModel: "claude-opus-5[1m]", configuredModel: null, observedTokens: 100 }),
    ).toEqual({ limit: 200_000, source: "model" });
  });

  it("um pin explícito do spawner continua vencendo o registro do projeto", () => {
    expect(
      resolveWindow({
        model: "claude-sonnet-5",
        pinnedModel: "sonnet",
        projectModel: "claude-sonnet-5[1m]",
        configuredModel: null,
        observedTokens: 100,
      }),
    ).toEqual({ limit: 200_000, source: "model" });
  });
});

describe("readSessionContext — a leitura que o operador viu errada", () => {
  let dir: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    clearSessionContextMemo();
    clearProjectModelMemo();
    dir = mkdtempSync(path.join(os.tmpdir(), "transcript-usage-proj-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    clearSessionContextMemo();
    clearProjectModelMemo();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Um turno real desta caixa: id PELADO, como todo transcript grava. */
  function opus5Line(total: number): string {
    return JSON.stringify({
      type: "assistant",
      isSidechain: false,
      timestamp: "2026-08-02T15:53:10.769Z",
      effort: "xhigh",
      message: { model: "claude-opus-5", usage: { input_tokens: total, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
    });
  }

  function writeClaudeJson(projects: Record<string, string[]>): void {
    const entries = Object.fromEntries(
      Object.entries(projects).map(([cwd, models]) => [
        cwd,
        { lastModelUsage: Object.fromEntries(models.map((m) => [m, { inputTokens: 1 }])) },
      ]),
    );
    writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ projects: entries }));
  }

  it("uma sessão de 1M recém-limpa lê 19.5%, não os 98% que mandavam reciclá-la", async () => {
    // O incidente, com os números medidos: `/clear` às 15:48, e às 15:53 o transcript marcava 195.425
    // tokens. Contra 200k isso é 98% — vermelho, "quase cheio", logo depois de limpar. A sessão rodava
    // `claude-opus-5[1m]`: 19.5%. O único lugar da caixa que sabia do sufixo era o `~/.claude.json`.
    const file = path.join(dir, "sessao.jsonl");
    writeFileSync(file, `${opus5Line(195_425)}\n`);
    writeClaudeJson({ "/root/meu-monorepo": ["claude-opus-5[1m]"] });

    const ctx = await readSessionContext(file, null, "/root/meu-monorepo");

    expect(ctx?.contextTokens).toBe(195_425);
    expect(ctx?.limit).toBe(1_000_000);
    expect(ctx?.limitSource).toBe("config");
    expect(ctx?.pct).toBe(19.5);
  });

  it("sem o cwd (ou fora do projeto registrado) nada é inventado — segue o id pelado", async () => {
    const file = path.join(dir, "sem-cwd.jsonl");
    writeFileSync(file, `${opus5Line(195_425)}\n`);
    writeClaudeJson({ "/root/meu-monorepo": ["claude-opus-5[1m]"] });

    expect((await readSessionContext(file, null))?.limit).toBe(200_000);
    clearSessionContextMemo();
    expect((await readSessionContext(file, null, "/outro/projeto"))?.limit).toBe(200_000);
  });

  it("`~/.claude.json` ausente/ilegível é ausência de sinal, nunca uma exceção", () => {
    expect(readProjectModels("/root/meu-monorepo")).toEqual([]);
    writeFileSync(path.join(dir, ".claude.json"), "{ isto não é json");
    expect(readProjectModels("/root/meu-monorepo")).toEqual([]);
    expect(readProjectModels(null)).toEqual([]);
  });

  it("o memo do `.claude.json` invalida por mtime/size — trocar de modelo não fica preso no cache", () => {
    writeClaudeJson({ "/p": ["claude-opus-5[1m]"] });
    expect(readProjectModels("/p")).toEqual(["claude-opus-5[1m]"]);

    writeClaudeJson({ "/p": ["claude-sonnet-5"], "/q": ["claude-opus-5[1m]"] });
    const bump = Date.now() / 1000 + 5;
    utimesSync(path.join(dir, ".claude.json"), bump, bump);

    expect(readProjectModels("/p")).toEqual(["claude-sonnet-5"]);
  });
});

describe("parseLastAssistantUsage — registro <synthetic> não é turno do modelo", () => {
  it("um <synthetic> mais novo NÃO zera a leitura da sessão", () => {
    // O CLI emite este registro numa interrupção / erro de API. Toda a usage é 0 — e 0 É um número,
    // então a guarda de tipo o aceitava. Sendo o mais recente, ele reportava uma sessão real como
    // "0 tokens · 0.0%": um zero fabricado, exatamente o que o contrato de ausência proíbe.
    const real = JSON.stringify({
      type: "assistant", isSidechain: false, timestamp: "2026-07-23T10:00:00.000Z",
      message: { model: "claude-opus-4-8", usage: { input_tokens: 2, cache_creation_input_tokens: 300, cache_read_input_tokens: 104_000, output_tokens: 700 } },
    });
    const synthetic = JSON.stringify({
      type: "assistant", isSidechain: false, timestamp: "2026-07-23T10:00:05.000Z",
      message: { model: "<synthetic>", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
    });
    const got = parseLastAssistantUsage(`${real}\n${synthetic}\n`);
    expect(got?.contextTokens).toBe(105_002);
    expect(got?.model).toBe("claude-opus-4-8");
  });
});
