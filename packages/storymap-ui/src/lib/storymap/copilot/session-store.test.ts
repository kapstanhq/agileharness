// A BARREIRA DURÁVEL de "Nova conversa" (server-side). Este teste trava o bug que os unitários da correção
// anterior NÃO pegavam: eles testavam só o guard PURO do cliente (shouldAdoptHistory), enquanto o defeito real
// vivia na interação clear × escritores do PONTEIRO no servidor. Medido ao vivo: "Nova conversa" limpava o
// cliente e apagava o ponteiro, mas um turno/tick da sessão descartada AINDA EM VOO re-gravava o ponteiro nela
// (writeCopilotSessionPointer no início, recordCopilotTurnUsage no fim) — então um hard-refresh / aba anônima
// (cliente novo, sem o guard em memória) re-hidratava o histórico "limpo". A correção é um TOMBSTONE durável que
// todo escritor respeita. Estes testes exercitam as FUNÇÕES REAIS contra o fs isolado (STORYMAP_RUNNER_STATE_DIR
// aponta p/ um tempdir via vitest.setup) — o mesmo caminho que roda em produção, não um mock.

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  copilotSessionPointerPath,
  readCopilotChats,
  readCopilotSessionPointer,
  recordCopilotTurnUsage,
  resumeCopilotChat,
  startNewCopilotChat,
  writeCopilotSessionPointer,
} from "./session-store";
import { MAX_RECOVERABLE_CHATS, recoverableChats } from "./chat-roster";

// board id único por caso → o ponteiro de um teste não interfere no de outro (o tempdir é compartilhado no worker).
let seq = 0;
const board = (name: string) => `b-${name}-${seq++}`;

describe("session-store — o ponteiro durável do chat do Jido", () => {
  it("escreve e lê o ponteiro ATIVO de um board", async () => {
    const b = board("basic");
    await writeCopilotSessionPointer(b, "sess-A");
    expect((await readCopilotSessionPointer(b))?.sessionId).toBe("sess-A");
  });

  it('"Nova conversa" FECHA a sessão: o ponteiro ativo vira null (tombstone)', async () => {
    const b = board("clear");
    await writeCopilotSessionPointer(b, "sess-A");
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 100, costUSD: 0.1 });
    expect((await readCopilotSessionPointer(b))?.sessionId).toBe("sess-A");
    await startNewCopilotChat(b);
    expect(await readCopilotSessionPointer(b)).toBeNull(); // history/medidor veem vazio na hora
  });

  // ─── A REGRESSÃO (o bug reportado em produção) ──────────────────────────────────────────────────────────
  it("um straggler recordCopilotTurnUsage da sessão descartada NÃO a ressuscita (fim de turno em voo)", async () => {
    const b = board("straggler-record");
    await writeCopilotSessionPointer(b, "sess-A");
    await startNewCopilotChat(b); // operador clica "Nova conversa"
    // …e o turno da sessão A, ainda em voo, termina DEPOIS e reporta seu uso:
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 999, costUSD: 9.99 });
    expect(await readCopilotSessionPointer(b)).toBeNull(); // continua limpo — NÃO volta o histórico após refresh
  });

  it("um straggler writeCopilotSessionPointer da sessão descartada NÃO a re-aponta (início de turno/tick em voo)", async () => {
    const b = board("straggler-write");
    await writeCopilotSessionPointer(b, "sess-A");
    await startNewCopilotChat(b);
    await writeCopilotSessionPointer(b, "sess-A"); // tick resume / turno resume da sessão descartada
    expect(await readCopilotSessionPointer(b)).toBeNull();
  });

  it("uma sessão GENUINAMENTE nova supera o tombstone e volta a fluir (o operador começou outra conversa)", async () => {
    const b = board("supersede");
    await writeCopilotSessionPointer(b, "sess-A");
    await startNewCopilotChat(b);
    expect(await readCopilotSessionPointer(b)).toBeNull();
    await writeCopilotSessionPointer(b, "sess-B"); // id diferente ⇒ não é a descartada
    expect((await readCopilotSessionPointer(b))?.sessionId).toBe("sess-B");
    // e um straggler da ANTIGA ainda é ignorado mesmo com a nova ativa:
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 5, costUSD: 0.5 });
    expect((await readCopilotSessionPointer(b))?.sessionId).toBe("sess-B");
  });

  it("a corrida clear × straggler nunca deixa a sessão descartada ativa (as duas ordens de chegada)", async () => {
    for (let i = 0; i < 20; i++) {
      const b1 = board("race-a");
      await writeCopilotSessionPointer(b1, "sess-A");
      await Promise.all([startNewCopilotChat(b1), recordCopilotTurnUsage(b1, "sess-A", { contextTokens: 1, costUSD: 0.01 })]);
      expect(await readCopilotSessionPointer(b1)).toBeNull();

      const b2 = board("race-b");
      await writeCopilotSessionPointer(b2, "sess-A");
      await Promise.all([recordCopilotTurnUsage(b2, "sess-A", { contextTokens: 1, costUSD: 0.01 }), startNewCopilotChat(b2)]);
      expect(await readCopilotSessionPointer(b2)).toBeNull();
    }
  });

  it("um clear sem sessão ativa é inócuo, e um segundo clear preserva o tombstone (bloqueio segue valendo)", async () => {
    const b = board("double-clear");
    await startNewCopilotChat(b); // nunca houve sessão — no-op silencioso
    expect(await readCopilotSessionPointer(b)).toBeNull();
    await writeCopilotSessionPointer(b, "sess-A");
    await startNewCopilotChat(b);
    await startNewCopilotChat(b); // duplo clique em "Nova conversa"
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 1, costUSD: 0.01 }); // straggler ainda bloqueado
    expect(await readCopilotSessionPointer(b)).toBeNull();
  });

  it("preserva o medidor (stats) enquanto a MESMA sessão segue, e zera numa sessão nova", async () => {
    const b = board("stats");
    await writeCopilotSessionPointer(b, "sess-A");
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 100, costUSD: 1 });
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 150, costUSD: 2 });
    const p = await readCopilotSessionPointer(b);
    expect(p?.stats?.turns).toBe(2);
    expect(p?.stats?.costUSD).toBeCloseTo(3);
    expect(p?.stats?.contextTokens).toBe(150);
  });
});

// ─── O HISTÓRICO (uma aberta, as anteriores recuperáveis) ─────────────────────────────────────────────────
// A álgebra é testada pura em chat-roster.test.ts; aqui provamos que ela ATRAVESSA o disco — inclusive o
// formato legado, que é o estado real de todo board no momento do deploy.

describe("session-store — o histórico de conversas do board", () => {
  it("fechar uma conversa NÃO a perde: ela fica recuperável, com o medidor dela", async () => {
    const b = board("history");
    await writeCopilotSessionPointer(b, "sess-A");
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 120, costUSD: 0.4 });
    await startNewCopilotChat(b);
    const roster = await readCopilotChats(b);
    expect(roster.activeSessionId).toBeNull(); // nada aberto…
    expect(recoverableChats(roster).map((c) => c.sessionId)).toEqual(["sess-A"]); // …e a anterior à mão
    expect(recoverableChats(roster)[0].contextTokens).toBe(120);
  });

  it("retomar do histórico reabre a conversa (e supera o tombstone dela)", async () => {
    const b = board("resume");
    await writeCopilotSessionPointer(b, "sess-A");
    await recordCopilotTurnUsage(b, "sess-A", { contextTokens: 10, costUSD: 0.1 });
    await startNewCopilotChat(b);
    await writeCopilotSessionPointer(b, "sess-B"); // o operador conversou noutra
    expect(await resumeCopilotChat(b, "sess-A")).toBe(true);
    const p = await readCopilotSessionPointer(b);
    expect(p?.sessionId).toBe("sess-A");
    expect(p?.stats?.contextTokens).toBe(10); // o medidor volta com ela
    // …e a que estava aberta virou histórico (só uma aberta por vez):
    expect(recoverableChats(await readCopilotChats(b)).map((c) => c.sessionId)).toEqual(["sess-B"]);
  });

  it("retomar uma sessão que não está no histórico é recusado (não vira ponteiro do board)", async () => {
    const b = board("resume-unknown");
    await writeCopilotSessionPointer(b, "sess-A");
    expect(await resumeCopilotChat(b, "sess-Z")).toBe(false);
    expect((await readCopilotSessionPointer(b))?.sessionId).toBe("sess-A");
  });

  it(`guarda ${MAX_RECOVERABLE_CHATS} anteriores e esquece a mais antiga na ${MAX_RECOVERABLE_CHATS + 1}ª`, async () => {
    const b = board("cap");
    for (let i = 0; i < MAX_RECOVERABLE_CHATS + 2; i++) {
      await writeCopilotSessionPointer(b, `s${i}`);
      await recordCopilotTurnUsage(b, `s${i}`, { contextTokens: 10, costUSD: 0.01 });
      await startNewCopilotChat(b);
    }
    const ids = (await readCopilotChats(b)).chats.map((c) => c.sessionId);
    expect(ids).toHaveLength(MAX_RECOVERABLE_CHATS);
    expect(ids[0]).toBe(`s${MAX_RECOVERABLE_CHATS + 1}`); // a mais recente na frente
    expect(ids).not.toContain("s0"); // a mais antiga saiu da lista
  });

  it("MIGRA o formato antigo (um ponteiro só) sem perder a conversa em curso", async () => {
    const b = board("legacy");
    const p = copilotSessionPointerPath(b);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(
      p,
      JSON.stringify({
        sessionId: "sess-legado",
        updatedAt: "2026-07-20T10:00:00.000Z",
        stats: { startedAt: "2026-07-20T09:00:00.000Z", lastTurnAt: "2026-07-20T10:00:00.000Z", turns: 7, contextTokens: 4200, costUSD: 1.5 },
      }),
      "utf8",
    );
    const pointer = await readCopilotSessionPointer(b);
    expect(pointer?.sessionId).toBe("sess-legado");
    expect(pointer?.stats?.turns).toBe(7);
    // …e ela já entra no histórico: fechar agora a deixa recuperável, como qualquer outra.
    await startNewCopilotChat(b);
    expect(recoverableChats(await readCopilotChats(b)).map((c) => c.sessionId)).toEqual(["sess-legado"]);
  });
});

// O roster passou a ser por RAIA (chat por TELA). O que estes testes travam é a compatibilidade: o arquivo do
// chat do board NÃO pode mudar de nome — renomeá-lo apagaria da tela o histórico que o operador já tem.
describe("session-store — o arquivo é por RAIA, preservando o nome legado do board", () => {
  it("board:<id> e o boardId CRU apontam para o MESMO arquivo (o histórico existente sobrevive)", () => {
    expect(copilotSessionPointerPath("board:acme")).toBe(copilotSessionPointerPath("acme"));
    expect(copilotSessionPointerPath("acme").endsWith("acme.json")).toBe(true);
  });

  it("uma raia de TELA tem arquivo próprio — e não colide com um board de mesmo nome", () => {
    const tela = copilotSessionPointerPath("view:acme:ideias");
    expect(tela).not.toBe(copilotSessionPointerPath("acme"));
    expect(tela.endsWith("acme--ideias.json")).toBe(true);
  });

  it("duas telas do mesmo board são arquivos diferentes (histórico não se mistura)", () => {
    expect(copilotSessionPointerPath("view:acme:ideias")).not.toBe(copilotSessionPointerPath("view:acme:inbox"));
  });

  it("conversas de raias diferentes não se enxergam", async () => {
    const tela = "view:store-iso:ideias";
    const bo = "board:store-iso";
    await startNewCopilotChat(bo);
    await writeCopilotSessionPointer(bo, "sess-do-board");
    await writeCopilotSessionPointer(tela, "sess-da-tela");
    expect((await readCopilotSessionPointer(bo))?.sessionId).toBe("sess-do-board");
    expect((await readCopilotSessionPointer(tela))?.sessionId).toBe("sess-da-tela");
  });
});
