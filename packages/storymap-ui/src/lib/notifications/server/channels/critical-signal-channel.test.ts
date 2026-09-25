// Os sinais críticos DECLARADOS pelo board: um card que nasce com um prefixo de board.yaml
// `notifications.criticalTitlePrefixes` vira o aviso `critical-signal` — uma vez por card, e nunca por outra escrita.

import { describe, expect, it, vi } from "vitest";
import { createCriticalSignalChannel, criticalSignalAlert } from "./critical-signal-channel";
import { shouldPush } from "../../push-policy";
import type { AgentAlert, AgileHarnessEvent } from "../../event";

const PREFIXES = ["[sinal:scraper:", "[sinal:sources:source_silent", "[sinal:credits:"];
const created = (cardId: string, title: string, boardId = "loja"): AgileHarnessEvent => ({
  id: `e-${cardId}`,
  type: "card.created",
  boardId,
  boardName: "Loja",
  cardId,
  title,
  at: 0,
});

function channel(prefixes: string[] | null = PREFIXES) {
  const published: AgentAlert[] = [];
  const readBoardConfig = vi.fn(async () => (prefixes ? { notifications: { criticalTitlePrefixes: prefixes } } : {}));
  const ch = createCriticalSignalChannel({ readBoardConfig, publish: (a) => published.push(a), now: () => 42 });
  return { ch, published, readBoardConfig };
}

describe("critical-signal channel", () => {
  it("card NOVO com prefixo declarado ⇒ um aviso critical-signal que empurra por padrão, levando ao card", async () => {
    const { ch, published } = channel();
    await ch.notify(created("story-1", "[sinal:scraper:fonte-a] 0 eventos em 26h"));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: "critical-signal",
      event: "critical-signal",
      urgency: "blocking",
      body: "[sinal:scraper:fonte-a] 0 eventos em 26h",
      url: "/board/loja/card/story-1",
      boardId: "loja",
    });
    expect(shouldPush(published[0].event)).toBe(true);
  });

  it("UMA vez por card: o mesmo card.created reentregue não avisa de novo", async () => {
    const { ch, published } = channel();
    await ch.notify(created("story-1", "[sinal:credits:fornecedor-x] saldo zerado"));
    await ch.notify(created("story-1", "[sinal:credits:fornecedor-x] saldo zerado"));
    await ch.notify(created("story-2", "[sinal:credits:fornecedor-x] saldo zerado"));
    expect(published.map((a) => a.tag)).toEqual(["critical-signal:loja:story-1", "critical-signal:loja:story-2"]);
  });

  it("título sem prefixo, prefixo no meio, ou outra escrita (update/move) do card ⇒ nada", async () => {
    const { ch, published } = channel();
    await ch.notify(created("story-3", "Investigar [sinal:scraper:x]"));
    await ch.notify(created("story-4", "Nova tela de eventos"));
    await ch.notify({ ...created("story-5", "[sinal:scraper:x]"), type: "card.updated" });
    await ch.notify({ ...created("story-6", "[sinal:scraper:x]"), type: "card.moved" });
    expect(published).toEqual([]);
  });

  it("board sem prefixos declarados (ou ilegível) nunca avisa — o núcleo não sabe o que é sinal de ninguém", async () => {
    const none = channel(null);
    await none.ch.notify(created("story-7", "[sinal:scraper:x]"));
    expect(none.published).toEqual([]);
    const broken = createCriticalSignalChannel({ readBoardConfig: async () => { throw new Error("yaml"); }, publish: () => { throw new Error("não deveria"); } });
    await expect(broken.notify(created("story-8", "[sinal:scraper:x]"))).resolves.toBeUndefined();
  });

  it("criticalSignalAlert: o título nomeia o board; sem título do card, o corpo é o prefixo", () => {
    const a = criticalSignalAlert({ ...created("s", ""), title: undefined }, "[sinal:scraper:", 1);
    expect(a).toMatchObject({ title: "Sinal crítico — Loja", body: "[sinal:scraper:" });
  });
});
