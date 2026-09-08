import { describe, it, expect } from "vitest";
import { parseTranscriptTurns, stripComposedPrompt, sliceHistoryPage, titleFromTranscript } from "./transcript-history";
import { composeCopilotPrompt } from "./protocol";
import type { HitlAgentTurn, HitlHumanTurn, HitlTurn } from "@/lib/storymap/hitl/types";

/** Um transcript é NDJSON — cada linha é um objeto. */
const j = (o: unknown) => JSON.stringify(o);

describe("stripComposedPrompt — recupera o texto do humano do prompt composto", () => {
  it("remove o bloco de contexto, a linha de modo terse e os tails de imagem", () => {
    const composed = composeCopilotPrompt({
      context: "# Board: Nest\nEstado ...",
      text: "por que o card X travou?",
      responseMode: "terse",
      images: ["/a.png", "/b.png"],
    });
    const { text, imageCount } = stripComposedPrompt(composed);
    expect(text).toBe("por que o card X travou?");
    expect(imageCount).toBe(2);
  });

  it("sem contexto/modo/imagem → devolve o texto intacto", () => {
    expect(stripComposedPrompt("oi, tudo bem?")).toEqual({ text: "oi, tudo bem?", imageCount: 0 });
  });
});

describe("parseTranscriptTurns — reconstrói o thread do transcript durável do CLI", () => {
  it("humano → agente(tool done + texto), casando o tool_result pelo tool_use_id (shape real capturado)", () => {
    const lines = [
      j({ type: "queue-operation", operation: "x" }), // meta — ignorada
      j({ type: "user", message: { role: "user", content: "Roda a tool Bash com o comando: echo hello-storymap." } }),
      j({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hello-storymap" } }] } }),
      j({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello-storymap", is_error: false }] } }),
      j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "feito" }] } }),
    ];
    const turns = parseTranscriptTurns(lines);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ role: "human", text: "Roda a tool Bash com o comando: echo hello-storymap." });
    const agent = turns[1] as HitlAgentTurn;
    expect(agent.role).toBe("agent");
    const segs = agent.segments!;
    expect(segs[0]).toMatchObject({ type: "tool", name: "Bash", summary: "echo hello-storymap", status: "done", output: "hello-storymap" });
    expect(segs[0]).toMatchObject({ input: '{"command":"echo hello-storymap"}' });
    expect(segs[1]).toMatchObject({ type: "text", text: "feito" });
  });

  it("tool_result de erro rebaixa o segmento p/ status error", () => {
    const turns = parseTranscriptTurns([
      j({ type: "user", message: { content: "faz algo" } }),
      j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "false" } }] } }),
      j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }] } }),
    ]);
    const seg = (turns[1] as HitlAgentTurn).segments![0];
    expect(seg).toMatchObject({ type: "tool", status: "error", output: "boom" });
  });

  it("agrupa múltiplos assistant + tool_results ENTRE dois humanos num ÚNICO turno de agente", () => {
    const turns = parseTranscriptTurns([
      j({ type: "user", message: { content: "primeiro" } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "vou checar" }, { type: "tool_use", id: "a", name: "Read", input: { file_path: "/x" } }] } }),
      j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "conteudo" }] } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "pronto" }] } }),
      j({ type: "user", message: { content: "segundo" } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ]);
    expect(turns.map((t) => t.role)).toEqual(["human", "agent", "human", "agent"]);
    expect((turns[1] as HitlAgentTurn).segments).toHaveLength(3); // texto + tool + texto, tudo num turno
  });

  it("strip do wrapper de contexto num prompt real de copiloto + pula meta/sidechain", () => {
    const composed = composeCopilotPrompt({ context: "# Board: Nest", text: "status?", responseMode: "standard" });
    const turns = parseTranscriptTurns([
      j({ type: "assistant", isMeta: true, message: { content: [{ type: "text", text: "IGNORAR (meta)" }] } }),
      j({ type: "user", isSidechain: true, message: { content: "IGNORAR (sidechain)" } }),
      j({ type: "user", message: { content: composed } }),
      j({ type: "assistant", message: { content: [{ type: "text", text: "tudo certo" }] } }),
    ]);
    expect(turns).toHaveLength(2);
    expect((turns[0] as HitlHumanTurn).text).toBe("status?"); // wrapper removido
    expect((turns[1] as HitlAgentTurn).segments![0]).toMatchObject({ text: "tudo certo" });
  });

  it("linhas quebradas / vazias não derrubam o parse", () => {
    const turns = parseTranscriptTurns(["{ nao é json", "", j({ type: "user", message: { content: "oi" } })]);
    expect(turns).toEqual([{ role: "human", text: "oi" }]);
  });

  it("tool de terminal carrega terminalUrl no segmento", () => {
    const turns = parseTranscriptTurns([
      j({ type: "user", message: { content: "abre um terminal" } }),
      j({ type: "assistant", message: { content: [{ type: "tool_use", id: "tn", name: "term_new", input: { name: "acme-build" } }] } }),
    ]);
    expect((turns[1] as HitlAgentTurn).segments![0]).toMatchObject({ type: "tool", terminalUrl: "/terminal?b=cop-acme-build" });
  });
});

describe("sliceHistoryPage — paginação do fim p/ o começo", () => {
  const mk = (n: number): HitlTurn[] => Array.from({ length: n }, (_, i) => ({ role: "human", text: `t${i}` }));

  it("1ª página = as últimas `limit`; nextCursor aponta p/ o começo da janela", () => {
    const page = sliceHistoryPage(mk(10), 4);
    expect((page.turns as HitlHumanTurn[]).map((t) => t.text)).toEqual(["t6", "t7", "t8", "t9"]);
    expect(page.nextCursor).toBe("6");
  });

  it("página mais antiga via `before`; nextCursor null quando chega no início", () => {
    const page = sliceHistoryPage(mk(10), 4, 6);
    expect((page.turns as HitlHumanTurn[]).map((t) => t.text)).toEqual(["t2", "t3", "t4", "t5"]);
    expect(sliceHistoryPage(mk(10), 4, 2).nextCursor).toBeNull(); // t0,t1 — não há mais antigas
  });

  it("tudo cabe numa página → nextCursor null", () => {
    expect(sliceHistoryPage(mk(3), 40).nextCursor).toBeNull();
  });
});

// LEITURA AO VIVO — o poll near-live relê o transcript ENQUANTO o tick trabalha (medido: o CLI escreve o .jsonl
// incrementalmente, 30→82 linhas em 70s). Uma tool_use sem tool_result ainda não terminou; marcá-la "done" na
// criação fazia a tool em VOO aparecer com o ✓ de concluída — era esse o "nada aparece ao vivo".
describe("transcript LIDO AO VIVO (tick em voo)", () => {
  const assistantToolUse = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "mcp__storymap__list_cards", input: { board: "acme" } }] },
  });
  const toolResult = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "3 cards" }] },
  });

  it("tool_use SEM tool_result (em voo agora) fica running — não mente que terminou", () => {
    const turns = parseTranscriptTurns([assistantToolUse]);
    const seg = (turns[0] as HitlAgentTurn).segments![0];
    expect(seg).toMatchObject({ type: "tool", name: "mcp__storymap__list_cards", status: "running" });
  });

  it("chegando o tool_result, a MESMA tool fecha em done (transcript completo ⇒ nada fica running)", () => {
    const turns = parseTranscriptTurns([assistantToolUse, toolResult]);
    const seg = (turns[0] as HitlAgentTurn).segments![0];
    expect(seg).toMatchObject({ type: "tool", status: "done", output: "3 cards" });
  });
});

// O RÓTULO da conversa na lista de histórico: a PRIMEIRA fala do operador (a régua do `--resume` do CLI).
describe("titleFromTranscript — como uma conversa se chama na lista", () => {
  const human = (text: string) => j({ type: "user", message: { content: text } });
  const agent = (text: string) => j({ type: "assistant", message: { content: [{ type: "text", text }] } });

  it("é a 1ª fala do operador, DESCASCADA do bloco de contexto", () => {
    const composed = composeCopilotPrompt({ context: "# Board: Nest\nEstado…", text: "por que o merge train travou?" });
    expect(titleFromTranscript([agent("oi"), human(composed), human("e agora?")])).toBe("por que o merge train travou?");
  });

  it("um COMANDO não batiza a conversa (é evento, não fala) — o rótulo é a fala seguinte", () => {
    // A casca que o CLI grava quando o painel dispara uma barra (ver tick-turn.parseCommandInvocation).
    const compact = human("<command-name>/compact</command-name>\n<command-message>compact</command-message>");
    expect(titleFromTranscript([compact, human("investiga o deploy do acme")])).toBe("investiga o deploy do acme");
  });

  it("uma fala longa é cortada com reticências (é uma linha de menu)", () => {
    const title = titleFromTranscript([human("x".repeat(200))])!;
    expect(title).toHaveLength(72);
    expect(title.endsWith("…")).toBe(true);
  });

  it("conversa sem fala humana (só o tick escreveu) não recebe rótulo inventado", () => {
    expect(titleFromTranscript([agent("rodei o ciclo")])).toBeNull();
    expect(titleFromTranscript([])).toBeNull();
  });
});
