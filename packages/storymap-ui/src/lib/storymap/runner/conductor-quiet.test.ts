// O sinal «condutor quieto no prompt» que sobrevive ao restart do serviço: transcript + tela de agora.

import { describe, expect, it } from "vitest";
import type { TerminalAttention } from "@/lib/terminal/attention";
import { conductorQuiet, lastTurnTransportError, paneHasLiveChildren, paneRestsAtPrompt } from "./conductor-quiet";

const BOX = "────────────────────────────────────────";
const IDLE = ["  Diga continuar nesta sessão quando terminar.", "✻ Sautéed for 1m 34s · done 5:52 AM", BOX, "❯ continuar — aprovei, movi para Integrar", BOX, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"].join("\n");
const WORKING = ["● Calling storymap 2 times… (ctrl+o to expand)", "✻ Deliberating… (3m 48s · ↓ 13.4k tokens)", BOX, "❯ ", BOX, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents"].join("\n");
const SUBAGENTS = [BOX, "❯ ", BOX, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · ↓ to manage", "  ● main", "  ◯ acceptance-verifier  Reading invoice-layout screenshot"].join("\n");
const WAITING_BG = ["● Os três verificadores novos estão rodando.", "✻ Waiting for 3 background agents to finish", BOX, "❯ ", BOX, "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"].join("\n");

describe("paneRestsAtPrompt — a tela de um condutor parado de verdade", () => {
  it("caixa de entrada à vista, sem rodapé de trabalho e sem tarefa em segundo plano ⇒ parado", () => {
    expect(paneRestsAtPrompt(IDLE)).toBe(true);
  });
  it("turno rodando, subagentes vivos ou espera por tarefa em segundo plano ⇒ NÃO está parado", () => {
    expect(paneRestsAtPrompt(WORKING)).toBe(false);
    expect(paneRestsAtPrompt(SUBAGENTS)).toBe(false);
    expect(paneRestsAtPrompt(WAITING_BG)).toBe(false);
  });
  it("sem a caixa de entrada (um shell, uma tela vazia, captura que falhou) não afirma nada", () => {
    expect(paneRestsAtPrompt("root@vps:~# ls\nfoo bar")).toBe(false);
    expect(paneRestsAtPrompt("")).toBe(false);
    expect(paneRestsAtPrompt(null)).toBe(false);
  });
});

describe("conductorQuiet — a foto do vigia quando existe; transcript + tela quando ela não sabe", () => {
  const NOW = Date.UTC(2026, 9, 1, 14, 0);
  const MIN = 60_000;
  const session = { tmuxSession: "agent-conductor-story-x-ab12", transcriptFile: "/t/x.jsonl" };
  const io = (screen: string | null, ageMin: number | null) => ({ capture: async () => screen, mtimeMs: async () => (ageMin == null ? null : NOW - ageMin * MIN) });
  const att = (kind: "idle" | "asking", sinceMin: number) => ({ session: session.tmuxSession, label: "x", kind, since: NOW - sinceMin * MIN, agent: true }) as TerminalAttention;

  it("a foto do vigia vale primeiro: idle dá o tempo; asking nunca é «quieto»", async () => {
    expect(await conductorQuiet(session, att("idle", 12), NOW, io(WORKING, 0))).toEqual({ quietForMs: 12 * MIN, asking: false });
    expect(await conductorQuiet(session, att("asking", 30), NOW, io(IDLE, 30))).toEqual({ quietForMs: null, asking: true });
  });

  // depois de um restart o vigia não declara idle quem ele não viu trabalhar: o condutor parado antes ficava invisível
  it("sem foto (restart do serviço): transcript mudo + tela parada no prompt ⇒ quieto pelo tempo do transcript", async () => {
    expect(await conductorQuiet(session, undefined, NOW, io(IDLE, 25))).toEqual({ quietForMs: 25 * MIN, asking: false });
  });

  it("sem foto e a tela trabalhando, com subagentes vivos, ou transcript recém-escrito ⇒ não sei (nunca «quieto»)", async () => {
    expect((await conductorQuiet(session, undefined, NOW, io(WORKING, 25))).quietForMs).toBeNull();
    expect((await conductorQuiet(session, undefined, NOW, io(SUBAGENTS, 25))).quietForMs).toBeNull();
    expect((await conductorQuiet(session, undefined, NOW, io(IDLE, 1))).quietForMs).toBeNull();
  });

  it("sem transcript registrado, sem mtime, sem captura ou com erro de IO ⇒ não sei", async () => {
    expect((await conductorQuiet({ tmuxSession: "t" }, undefined, NOW, io(IDLE, 25))).quietForMs).toBeNull();
    expect((await conductorQuiet(session, undefined, NOW, io(IDLE, null))).quietForMs).toBeNull();
    expect((await conductorQuiet(session, undefined, NOW, io(null, 25))).quietForMs).toBeNull();
    const broken = { capture: async () => { throw new Error("tmux fora"); }, mtimeMs: async () => NOW - 25 * MIN };
    expect((await conductorQuiet(session, undefined, NOW, broken)).quietForMs).toBeNull();
  });
});

// WP5-F2 — num transcript real, o turno morreu num erro de transporte e a próxima linha da conversa só veio
// bem depois, quando o dono digitou «continue». A forma da linha:
const API_ERROR = JSON.stringify({
  type: "assistant",
  isSidechain: false,
  isApiErrorMessage: true,
  error: "server_error",
  message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: The response stopped arriving. The response above may be incomplete." }] },
});
const TURN_DURATION = JSON.stringify({ type: "system", subtype: "turn_duration" });
const SNAPSHOT = JSON.stringify({ type: "file-history-snapshot" });
const USER_CONTINUE = JSON.stringify({ type: "user", message: { role: "user", content: "continue — sua resposta anterior foi cortada" } });
const ASSISTANT_OK = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Retomando: escrevo o contrato no card. API Error não se repetiu." }] } });
const SIDECHAIN_ERR = JSON.stringify({ type: "assistant", isSidechain: true, isApiErrorMessage: true, message: { content: [{ type: "text", text: "API Error: 529 overloaded" }] } });

describe("lastTurnTransportError — o último turno da conversa morreu num erro de API?", () => {
  it("o caso real: erro sintético seguido do turn_duration e do snapshot ⇒ o texto do erro", () => {
    expect(lastTurnTransportError([ASSISTANT_OK, API_ERROR, TURN_DURATION, SNAPSHOT].join("\n"))).toMatch(/^API Error: The response stopped arriving/);
  });
  it("alguém já falou depois (a linha de retomar, o dono) ⇒ não", () => {
    expect(lastTurnTransportError([API_ERROR, TURN_DURATION, USER_CONTINUE].join("\n"))).toBeNull();
  });
  it("um turno normal que FALA de erro de API não é erro; subagente e linha truncada são pulados", () => {
    expect(lastTurnTransportError([API_ERROR, USER_CONTINUE, ASSISTANT_OK].join("\n"))).toBeNull();
    expect(lastTurnTransportError([ASSISTANT_OK, SIDECHAIN_ERR, '{"type":"assis'].join("\n"))).toBeNull();
    expect(lastTurnTransportError([USER_CONTINUE, SIDECHAIN_ERR].join("\n"))).toBeNull();
  });
  it("versões sem a marca: a mensagem que COMEÇA com «API Error» conta", () => {
    const bare = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "API Error: Request timed out." }] } });
    expect(lastTurnTransportError(bare)).toMatch(/^API Error/);
  });
  it("vazio ou nulo ⇒ não", () => {
    expect(lastTurnTransportError("")).toBeNull();
    expect(lastTurnTransportError(null)).toBeNull();
  });
});

describe("paneHasLiveChildren — o claude do pane tem filho vivo (ferramenta, suíte em segundo plano)?", () => {
  // Observado no host: condutor em repouso = claude sem filhos; uma chamada de ferramenta = `bash -c source …`.
  const claude = (pid: number, ppid: number) => ({ pid, ppid, claude: true });
  const proc = (pid: number, ppid: number) => ({ pid, ppid, claude: false });
  it("o pane é o próprio claude: sem filho ⇒ false; com filho (a suíte) ⇒ true", () => {
    expect(paneHasLiveChildren([100], [claude(100, 1), proc(200, 1)])).toBe(false);
    expect(paneHasLiveChildren([100], [claude(100, 1), proc(101, 100), proc(102, 101)])).toBe(true);
  });
  it("o pane é um shell que lançou o claude: só os filhos DO CLAUDE contam", () => {
    expect(paneHasLiveChildren([50], [proc(50, 1), claude(100, 50)])).toBe(false);
    expect(paneHasLiveChildren([50], [proc(50, 1), claude(100, 50), proc(101, 100)])).toBe(true);
  });
  it("sem claude na árvore, sem pane ou sem tabela ⇒ não sei (null)", () => {
    expect(paneHasLiveChildren([50], [proc(50, 1), proc(51, 50)])).toBeNull();
    expect(paneHasLiveChildren([], [claude(1, 0)])).toBeNull();
    expect(paneHasLiveChildren([1], [])).toBeNull();
  });
});

describe("conductorQuiet — o filho vivo é um FATO ao lado da quietude, nunca a apaga; o último turno vem junto", () => {
  const NOW = Date.UTC(2026, 9, 1, 20, 10);
  const MIN = 60_000;
  const session = { tmuxSession: "agent-conductor-story-x-ab12", transcriptFile: "/t/x.jsonl" };
  const base = { capture: async () => IDLE, mtimeMs: async () => NOW - 8 * MIN };
  // Revisão do WP5-F2: o filho vivo zerava `quietForMs` sem teto — um dev server subido no VERIFICAR, um watcher ou um
  // MCP stdio deixavam o condutor invisível PARA SEMPRE ao estacionar do dono, à escada e ao aviso do vigia. Quanto
  // tempo o filho segura a vaga é decisão de quem consome (conductor-pause.ts), com teto.
  it("tela parada e transcript mudo com filho vivo (ou sonda sem resposta) ⇒ quieto há quanto, com `childBusy`", async () => {
    expect(await conductorQuiet(session, undefined, NOW, { ...base, busy: async () => true })).toEqual({ quietForMs: 8 * MIN, asking: false, childBusy: true });
    expect(await conductorQuiet(session, undefined, NOW, { ...base, busy: async () => null })).toEqual({ quietForMs: 8 * MIN, asking: false, childBusy: true });
    // a foto do vigia (idle) também passa pela sonda de processos
    const idle = { session: session.tmuxSession, label: "x", kind: "idle", since: NOW - 12 * MIN, agent: true } as TerminalAttention;
    expect(await conductorQuiet(session, idle, NOW, { ...base, busy: async () => true })).toEqual({ quietForMs: 12 * MIN, asking: false, childBusy: true });
  });
  it("filho vivo há 1 h com o transcript parado há 1 h ⇒ quieto há 1 h (o processo esquecido não esconde o condutor)", async () => {
    const out = await conductorQuiet(session, undefined, NOW, { capture: async () => IDLE, mtimeMs: async () => NOW - 60 * MIN, busy: async () => true });
    expect(out.quietForMs).toBe(60 * MIN);
    expect(out.childBusy).toBe(true);
  });
  it("quieto de verdade e o turno morreu num erro de API ⇒ quieto, com o texto do erro", async () => {
    const out = await conductorQuiet(session, undefined, NOW, { ...base, busy: async () => false, tail: async () => [API_ERROR, TURN_DURATION].join("\n") });
    expect(out).toEqual({ quietForMs: 8 * MIN, asking: false, transportError: expect.stringMatching(/^API Error/) });
    const clean = await conductorQuiet(session, undefined, NOW, { ...base, busy: async () => false, tail: async () => ASSISTANT_OK });
    expect(clean).toEqual({ quietForMs: 8 * MIN, asking: false });
  });
});

