// parseTranscriptTurns — ler a CONVERSA de uma sessão em vez de raspar a tela (M3/M6).
//
// A forma do JSONL aqui foi tirada de um transcript REAL do Claude Code (1994 linhas), não inventada:
// um turno do assistente vem quebrado em linhas `text` / `thinking` / `tool_use`, e o `tool_result` do
// usuário é máquina respondendo à máquina, não conversa.

import { describe, expect, it } from "vitest";
import { parseTranscriptTurns } from "./claude-transcript";

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");

const assistant = (blocks: unknown[], timestamp?: string) => ({
  type: "assistant",
  ...(timestamp ? { timestamp } : {}),
  message: { role: "assistant", content: blocks },
});
const userText = (text: string, timestamp?: string) => ({
  type: "user",
  ...(timestamp ? { timestamp } : {}),
  message: { role: "user", content: text },
});
const toolResult = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });

describe("parseTranscriptTurns", () => {
  it("extrai turnos de usuário e assistente na ordem", () => {
    const r = parseTranscriptTurns(jsonl(userText("oi"), assistant([{ type: "text", text: "olá" }])));
    expect(r.turns).toEqual([
      { role: "user", text: "oi" },
      { role: "assistant", text: "olá" },
    ]);
  });

  it("FUNDE linhas consecutivas do mesmo papel num turno só (o CLI quebra o turno)", () => {
    const r = parseTranscriptTurns(
      jsonl(
        assistant([{ type: "text", text: "vou olhar" }]),
        assistant([{ type: "tool_use", name: "Bash" }]),
        assistant([{ type: "text", text: "achei" }]),
      ),
    );
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ role: "assistant", text: "vou olhar\nachei", tools: ["Bash"] });
  });

  it("DESCARTA o raciocínio interno — é o maior bloco do turno e não é a resposta", () => {
    const r = parseTranscriptTurns(
      jsonl(assistant([{ type: "thinking", thinking: "x".repeat(50_000) }, { type: "text", text: "a resposta" }])),
    );
    expect(r.turns[0].text).toBe("a resposta");
  });

  it("guarda só os NOMES das tools — o corpo é o que estoura o orçamento de token", () => {
    const r = parseTranscriptTurns(
      jsonl(assistant([{ type: "tool_use", name: "Read", input: { file: "x".repeat(10_000) } }, { type: "text", text: "li" }])),
    );
    expect(r.turns[0].tools).toEqual(["Read"]);
    expect(JSON.stringify(r.turns[0])).not.toContain("xxxxxxxxxx");
  });

  it("tool_result NÃO é turno de conversa (máquina falando com máquina)", () => {
    const r = parseTranscriptTurns(jsonl(userText("oi"), assistant([{ type: "tool_use", name: "Bash" }]), toolResult()));
    expect(r.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("devolve os ÚLTIMOS maxTurns e conta os omitidos", () => {
    const r = parseTranscriptTurns(
      jsonl(userText("1"), assistant([{ type: "text", text: "2" }]), userText("3"), assistant([{ type: "text", text: "4" }])),
      { maxTurns: 2 },
    );
    expect(r.turns.map((t) => t.text)).toEqual(["3", "4"]);
    expect(r.dropped).toBe(2);
  });

  it("o CURSOR é o contrato incremental: reler a partir dele devolve zero turnos", () => {
    const raw = jsonl(userText("oi"), assistant([{ type: "text", text: "olá" }]));
    const primeira = parseTranscriptTurns(raw);
    const segunda = parseTranscriptTurns(raw, { sinceLine: primeira.cursor });
    expect(segunda.turns).toEqual([]);
    expect(segunda.cursor).toBe(primeira.cursor);
  });

  it("com sinceLine devolve SÓ o que chegou depois", () => {
    const antes = jsonl(userText("oi"), assistant([{ type: "text", text: "olá" }]));
    const cursor = parseTranscriptTurns(antes).cursor;
    const depois = `${antes}\n${jsonl(userText("e agora?"), assistant([{ type: "text", text: "pronto" }]))}`;
    const r = parseTranscriptTurns(depois, { sinceLine: cursor });
    expect(r.turns.map((t) => t.text)).toEqual(["e agora?", "pronto"]);
  });

  it("trunca um turno gigante com o tamanho original no marcador", () => {
    const r = parseTranscriptTurns(jsonl(assistant([{ type: "text", text: "y".repeat(9000) }])), { maxChars: 200 });
    expect(r.turns[0].text).toContain("[truncado: 9000 chars]");
    expect(r.turns[0].text.length).toBeLessThan(300);
  });

  it("linha corrompida é PULADA, nunca fatal (o CLI escreve enquanto a gente lê)", () => {
    const raw = `${JSON.stringify(userText("oi"))}\n{isso não é json\n${JSON.stringify(assistant([{ type: "text", text: "ok" }]))}`;
    expect(parseTranscriptTurns(raw).turns.map((t) => t.text)).toEqual(["oi", "ok"]);
  });

  it("linhas de controle do CLI (mode, attachment, file-history) não viram turno", () => {
    const r = parseTranscriptTurns(
      jsonl({ type: "mode", mode: "normal" }, { type: "attachment" }, { type: "file-history-snapshot" }, userText("oi")),
    );
    expect(r.turns).toEqual([{ role: "user", text: "oi" }]);
    expect(r.cursor).toBe(4); // o cursor conta TODAS as linhas, não só as de conversa
  });

  it("transcript vazio devolve nada, sem lançar", () => {
    expect(parseTranscriptTurns("")).toEqual({ cursor: 0, turns: [], skipped: 0, dropped: 0 });
  });

  it("preserva o timestamp do último bloco do turno", () => {
    const r = parseTranscriptTurns(
      jsonl(assistant([{ type: "text", text: "a" }], "2026-07-31T10:00:00Z"), assistant([{ type: "text", text: "b" }], "2026-07-31T10:05:00Z")),
    );
    expect(r.turns[0].at).toBe("2026-07-31T10:05:00Z");
  });
});
