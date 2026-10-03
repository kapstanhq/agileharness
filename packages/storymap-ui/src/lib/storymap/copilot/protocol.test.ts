import { describe, it, expect } from "vitest";
import {
  assistantContextTokens,
  buildCopilotTurnArgs,
  CHAT_DENIED_TOOLS,
  createCopilotInterpreter,
  toolCallSummary,
  serializeSse,
  parseSseBuffer,
  imagePromptTail,
  composeCopilotPrompt,
  terminalChipFor,
  RESUME_SESSION_MISSING_RE,
  type CopilotSseEvent,
} from "./protocol";

/** Feed a sequence of stream-json objects through a fresh interpreter and flatten the emitted SSE events. */
function run(objs: unknown[]): CopilotSseEvent[] {
  const interp = createCopilotInterpreter();
  return objs.flatMap((o) => interp.feed(o));
}

describe("buildCopilotTurnArgs", () => {
  const base = { model: "opus", effort: "high", sessionId: "s-123", resume: false } as const;

  it("fresh turn uses --session-id and pins stream-json + skip-permissions", () => {
    const args = buildCopilotTurnArgs({ ...base, mcpConfigPath: "/tmp/mcp.json", systemPromptPath: "/tmp/p.txt" });
    expect(args).toContain("-p");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose"]));
    expect(args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--include-partial-messages"); // streaming inline token-a-token
    expect(args).toEqual(expect.arrayContaining(["--append-system-prompt-file", "/tmp/p.txt"]));
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config", "/tmp/mcp.json"]));
    // fresh → --session-id, NOT --resume
    const i = args.indexOf("--session-id");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("s-123");
    expect(args).not.toContain("--resume");
  });

  it("resume turn uses --resume and never --session-id (contradiction)", () => {
    const args = buildCopilotTurnArgs({ ...base, resume: true, mcpConfigPath: "/tmp/mcp.json" });
    const i = args.indexOf("--resume");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("s-123");
    expect(args).not.toContain("--session-id");
  });

  it("degrades WITHOUT mcp config (no token) — only native tools, no --mcp-config", () => {
    const args = buildCopilotTurnArgs({ ...base });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--append-system-prompt-file");
  });

  // Estado CHAT do Jido: a metade NATIVA da contenção read-only (a outra metade é o token MCP `ro`, escolhido
  // pelo agent-session — ver o cabeçalho de segurança lá). `deny` REMOVE a tool da superfície, e é isso que faz
  // "não edita nada" deixar de ser um pedido à persona.
  it("deniedTools (estado Chat) NEGA as tools nativas de escrita — e mantém Bash (diagnóstico)", () => {
    const args = buildCopilotTurnArgs({ ...base, deniedTools: CHAT_DENIED_TOOLS });
    const i = args.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(-1);
    const denied = args[i + 1].split(",");
    expect(denied).toEqual(expect.arrayContaining(["Write", "Edit", "NotebookEdit"]));
    // Bash FICA por decisão do Operador: sem ele o Chat perde o poder de diagnosticar (ler log, git log, spike).
    expect(denied).not.toContain("Bash");
  });

  it("sem deniedTools (Copiloto/Autônomo) não passa --disallowedTools — eles agem por desenho", () => {
    expect(buildCopilotTurnArgs({ ...base })).not.toContain("--disallowedTools");
  });

  it("a lista é do CALLER: um propósito pode negar um recorte próprio", () => {
    const args = buildCopilotTurnArgs({ ...base, deniedTools: "Write,Edit" });
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Write,Edit");
  });
});

describe("toolCallSummary", () => {
  it("prefers command, then file_path/path, truncates at 120", () => {
    expect(toolCallSummary({ command: "git status" })).toBe("git status");
    expect(toolCallSummary({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolCallSummary({ session: "cop-x", name: "cop-x" })).toBe("cop-x"); // name is a session-ish arg
    const long = "x".repeat(200);
    expect(toolCallSummary({ command: long }).length).toBe(120);
    expect(toolCallSummary({ command: long }).endsWith("…")).toBe(true);
  });
  it("collapses whitespace and handles non-object", () => {
    expect(toolCallSummary({ command: "a\n  b\tc" })).toBe("a b c");
    expect(toolCallSummary(null)).toBe("");
    expect(toolCallSummary("nope")).toBe("");
    expect(toolCallSummary({})).toBe("");
  });
});

describe("createCopilotInterpreter (streaming inline por segmentos — schema real CLI 2.1.207)", () => {
  it("system/init → init(sessionId + MODELO RESOLVIDO) + frame de sessão iniciada", () => {
    // O `model` do init é a ÚNICA fonte da versão: o operador pede o apelido `opus` (que o CLI define como
    // "o mais recente da família") e só aqui se descobre em que id ele caiu. Carregá-lo no evento é o que
    // deixa a tela responder "qual Opus?" sem uma tabela chumbada que envelhece a cada lançamento.
    const evs = run([{ type: "system", subtype: "init", session_id: "abc", model: "claude-opus-5" }]);
    expect(evs[0]).toEqual({ kind: "init", sessionId: "abc", model: "claude-opus-5" });
    expect(evs[1]?.kind).toBe("frame");
  });

  it("init SEM modelo continua válido — o campo é opcional, não uma promessa do CLI", () => {
    const evs = run([{ type: "system", subtype: "init", session_id: "abc" }]);
    expect(evs[0]).toEqual({ kind: "init", sessionId: "abc" });
  });

  it("texto streama token-a-token no MESMO segId, na ordem, criando o segmento vazio no content_block_start", () => {
    const evs = run([
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "vou " } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "checar" } } },
    ]);
    expect(evs).toEqual([
      { kind: "text-delta", segId: "s0", text: "" },
      { kind: "text-delta", segId: "s0", text: "vou " },
      { kind: "text-delta", segId: "s0", text: "checar" },
    ]);
  });

  it("uma tool: start (running) → input (do assistant, autoritativo) → end (casado pelo tool_use_id)", () => {
    const evs = run([
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "T1", name: "Bash", input: {} } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"echo' } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "T1", name: "Bash", input: { command: "echo ola" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "T1", is_error: false, content: "ola" }] } },
      { type: "result", subtype: "success", result: "feito", usage: { input_tokens: 4, output_tokens: 1 } },
    ]);
    expect(evs).toEqual([
      { kind: "tool-start", segId: "s0", name: "Bash", summary: "" }, // input {} no start → summary vazio
      { kind: "tool-input", segId: "s0", input: '{"command":"echo ola"}', summary: "echo ola" }, // summary do input autoritativo do assistant
      { kind: "tool-end", segId: "s0", ok: true, output: "ola" },
      { kind: "final", usage: expect.objectContaining({ tokens: 5 }) },
    ]);
  });

  it("tool_result com content em ARRAY de blocos (tools MCP) → output achatado p/ texto legível", () => {
    const evs = run([
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "T9", name: "get_card", input: {} } } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "T9", content: [{ type: "text", text: "card X" }, { type: "text", text: "linha 2" }] }] } },
    ]);
    expect(evs.at(-1)).toEqual({ kind: "tool-end", segId: "s0", ok: true, output: "card X\nlinha 2" });
  });

  it("tool com erro → tool-end ok:false; result de erro → error", () => {
    const end = run([
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "T2", name: "Bash", input: {} } } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "T2", is_error: true, content: "boom" }] } },
    ]);
    expect(end.at(-1)).toEqual({ kind: "tool-end", segId: "s0", ok: false, output: "boom" });
    const err = run([{ type: "result", subtype: "error_max_turns", is_error: true, result: "estourou" }]);
    expect(err[0]).toEqual({ kind: "error", message: "estourou" });
  });

  it("F2 — uma tool de terminal carrega terminalUrl no tool-input", () => {
    const evs = run([
      { type: "stream_event", event: { type: "message_start" } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "T3", name: "term_new", input: {} } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "T3", name: "term_new", input: { name: "acme-build" } }] } },
    ]);
    expect(evs.find((e) => e.kind === "tool-input")).toMatchObject({ kind: "tool-input", terminalUrl: "/terminal?b=cop-acme-build" });
  });

  it("FALLBACK sem --include-partial-messages: um assistant com texto (sem stream_event) → text-delta inteiro", () => {
    const evs = run([{ type: "assistant", message: { content: [{ type: "text", text: "resposta direta" }] } }]);
    expect(evs).toEqual([{ kind: "text-delta", segId: "s0", text: "resposta direta" }]);
  });

  it("ruído / shapes estranhos → []", () => {
    const interp = createCopilotInterpreter();
    expect(interp.feed({ type: "stream_event", event: { type: "message_stop" } })).toEqual([]);
    expect(interp.feed(null)).toEqual([]);
    expect(interp.feed("nope")).toEqual([]);
  });
});

describe("terminalChipFor", () => {
  it("term_new normalizes the slug to cop-<name>; other terminal tools use session as-is", () => {
    expect(terminalChipFor("term_new", { name: "acme-build" })).toBe("/terminal?b=cop-acme-build");
    expect(terminalChipFor("term_new", { name: "cop-x" })).toBe("/terminal?b=cop-x");
    expect(terminalChipFor("claude_send", { session: "card-acme__s" })).toBe("/terminal?b=card-acme__s");
  });
  it("non-terminal tools and missing/unsafe sessions → null", () => {
    expect(terminalChipFor("Bash", { command: "ls" })).toBeNull();
    expect(terminalChipFor("claude_new", {})).toBeNull();
    expect(terminalChipFor("claude_send", { session: "bad name!" })).toBeNull();
  });
});

describe("RESUME_SESSION_MISSING_RE", () => {
  it("matches the CLI's missing-session signature", () => {
    expect(RESUME_SESSION_MISSING_RE.test("Error: No conversation found with session ID: abc")).toBe(true);
    expect(RESUME_SESSION_MISSING_RE.test("all good")).toBe(false);
  });
});

describe("serializeSse", () => {
  it("wraps as data: <json>\\n\\n", () => {
    expect(serializeSse({ kind: "init", sessionId: "x" })).toBe('data: {"kind":"init","sessionId":"x"}\n\n');
  });
});

describe("imagePromptTail / composeCopilotPrompt", () => {
  it("imagePromptTail: 0/1/N images, ignores blanks", () => {
    expect(imagePromptTail([])).toBe("");
    expect(imagePromptTail(["/a.png"])).toContain("abra com a tool Read: /a.png");
    const two = imagePromptTail(["/a.png", " ", "/b.jpg"]);
    expect(two.match(/Imagem anexada/g)?.length).toBe(2);
  });
  it("composeCopilotPrompt wraps context as data, adds terse line + image tails", () => {
    const p = composeCopilotPrompt({ context: "board X", text: "roda git status", images: ["/a.png"], responseMode: "terse" });
    expect(p).toContain("<contexto>\nboard X\n</contexto>");
    expect(p).toContain("CURTO e direto");
    expect(p).toContain("roda git status");
    expect(p).toContain("Read: /a.png");
    // standard mode + no context = just the text
    expect(composeCopilotPrompt({ text: "oi", responseMode: "standard" })).toBe("oi");
  });

  // A TÉCNICA (chat-surfaces `techniques`) é instrução de MÉTODO e viaja como modo do turno. Os dois lugares
  // onde seria natural — e errado — colocá-la estão travados aqui:
  //  • colada ao texto do operador ⇒ o eco no transcript exibiria um parágrafo que ele não escreveu;
  //  • dentro do <contexto> ⇒ o bloco é declarado ao modelo como DADO a ignorar como comando, então a
  //    instrução seria, por contrato, para ser desobedecida.
  it("a técnica entra como MODO — fora do <contexto> e antes do texto do humano", () => {
    const p = composeCopilotPrompt({
      context: "bancada de ideias",
      text: "e essa aqui?",
      instruction: "Trabalhe em modo VALIDAÇÃO: tente derrubar a ideia.",
    });
    expect(p).toContain("modo VALIDAÇÃO");
    // fora do bloco de dados
    expect(p.slice(p.indexOf("<contexto>"), p.indexOf("</contexto>"))).not.toContain("modo VALIDAÇÃO");
    // e antes do que o humano digitou (o texto dele continua sendo a última coisa que o modelo lê)
    expect(p.indexOf("modo VALIDAÇÃO")).toBeLessThan(p.indexOf("e essa aqui?"));
  });

  it("a técnica qualifica-se com a verbosidade, e some quando não há nenhuma ligada", () => {
    const both = composeCopilotPrompt({ text: "vai", instruction: "Modo X.", responseMode: "terse" });
    // a técnica diz COMO trabalhar; a verbosidade diz QUÃO CURTO responder — e o segundo qualifica o primeiro
    expect(both.indexOf("Modo X.")).toBeLessThan(both.indexOf("CURTO e direto"));
    expect(composeCopilotPrompt({ text: "vai", instruction: "   " })).toBe("vai");
    expect(composeCopilotPrompt({ text: "vai" })).toBe("vai");
  });
});

describe("parseSseBuffer", () => {
  it("extracts complete events and keeps a partial tail as rest", () => {
    const wire =
      serializeSse({ kind: "init", sessionId: "s1" }) +
      serializeSse({ kind: "tool-start", segId: "s0", name: "Bash", summary: "git status" }) +
      'data: {"kind":"final","us'; // partial
    const { events, rest } = parseSseBuffer(wire);
    expect(events).toEqual([
      { kind: "init", sessionId: "s1" },
      { kind: "tool-start", segId: "s0", name: "Bash", summary: "git status" },
    ]);
    expect(rest).toBe('data: {"kind":"final","us');
  });

  it("round-trips serialize→parse and ignores malformed data lines", () => {
    const good = serializeSse({ kind: "frame", level: "info", text: "oi" });
    const { events } = parseSseBuffer(`data: not-json\n\n${good}`);
    expect(events).toEqual([{ kind: "frame", level: "info", text: "oi" }]);
  });
});

// ── O TAMANHO DO CONTEXTO (o "1635k ctx · 100%" num chat novo) ────────────────────────────────────────────
describe("assistantContextTokens — mede o contexto, não o consumo do turno", () => {
  it("soma o prompt (input + os dois caches) + a geração DAQUELA chamada", () => {
    const ev = {
      type: "assistant",
      message: {
        usage: { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 20_000, output_tokens: 300 },
      },
    };
    expect(assistantContextTokens(ev)).toBe(21_300);
  });

  it("o evento `result` NÃO serve (é o agregado do turno — a fonte do 1635k)", () => {
    expect(assistantContextTokens({ type: "result", usage: { input_tokens: 1_600_000 } })).toBeNull();
  });

  it("assistant sem usage / lixo ⇒ null (o medidor mantém o último valor conhecido)", () => {
    expect(assistantContextTokens({ type: "assistant", message: {} })).toBeNull();
    expect(assistantContextTokens(null)).toBeNull();
    expect(assistantContextTokens({ type: "assistant", message: { usage: {} } })).toBeNull();
  });
});
