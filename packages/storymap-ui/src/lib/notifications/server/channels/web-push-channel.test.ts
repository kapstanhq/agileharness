import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { demandPushPayload, isPushConfigured } from "./web-push-channel";
import type { AgileHarnessEvent } from "../../event";

// Behavioral: a pending human demand must produce a cross-device "precisa de você" push even when the
// card did NOT move (the story-rl5v03 root cause — harness-grill wrote questions in place, so the old
// card.moved-only push never fired and the orchestrator was never alerted).

const ev = (demand?: AgileHarnessEvent["demand"]): AgileHarnessEvent => ({
  id: "1",
  type: "card.updated",
  boardId: "storymap",
  cardId: "story-x",
  title: "Refinar X",
  at: 0,
  boardName: "AgileHarness",
  demand,
});

describe("demandPushPayload — cross-device alert on a pending demand (story-rl5v03)", () => {
  it("a question demand → high-priority 'Precisa de você' push carrying the demand label + deep-link", () => {
    const p = demandPushPayload(ev({ type: "question", label: "Responder 2 perguntas", severity: "high", count: 2 }));
    expect(p).not.toBeNull();
    expect(p!.title).toContain("Precisa de você");
    expect(p!.title).toContain("Responder 2 perguntas");
    expect(p!.priority).toBe("high");
    expect(p!.url).toBe("/board/storymap");
    expect(p!.tag).toBe("storymap:storymap:story-x");
  });

  it("a medium-severity gate demand → normal priority", () => {
    expect(demandPushPayload(ev({ type: "gate", label: "Aprovar entrega", severity: "medium" }))!.priority).toBe(
      "normal",
    );
  });

  it("no demand on the event → no push", () => {
    expect(demandPushPayload(ev(undefined))).toBeNull();
  });
});

// ── o contato VAPID é DECLARADO, nunca herdado ───────────────────────────────────────────────────
//
// O default embutido era o `mailto:` do autor. Numa instalação de terceiro isso entrega ao serviço de
// push (FCM/Mozilla/Apple) o endereço de OUTRA PESSOA como responsável pelo tráfego — é para lá que
// ele escreve quando um envio degrada ou é denunciado. O RFC 8292 exige o campo, então não havia
// meio-termo: ou o operador declara o dele, ou o canal não liga.
describe("[ATAQUE] o contato VAPID não é herdado do autor", () => {
  const chaves = { STORYMAP_VAPID_PUBLIC_KEY: "pub", STORYMAP_VAPID_PRIVATE_KEY: "priv" };
  const comEnv = (extra: Record<string, string | undefined>, f: () => void) => {
    const antes: Record<string, string | undefined> = {};
    const todas = { ...chaves, ...extra };
    for (const [k, v] of Object.entries(todas)) {
      antes[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { f(); } finally {
      for (const [k, v] of Object.entries(antes)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };

  it("com as duas chaves mas SEM contato declarado, o push não liga", () => {
    comEnv({ STORYMAP_VAPID_SUBJECT: undefined }, () => {
      expect(isPushConfigured()).toBe(false);
    });
  });

  it("com contato declarado, liga", () => {
    comEnv({ STORYMAP_VAPID_SUBJECT: "mailto:ops@exemplo.org" }, () => {
      expect(isPushConfigured()).toBe(true);
    });
  });

  it("[ATAQUE] um contato que não é mailto:/https: é recusado — o RFC 8292 não aceita texto solto", () => {
    comEnv({ STORYMAP_VAPID_SUBJECT: "ops@exemplo.org" }, () => {
      expect(isPushConfigured()).toBe(false);
    });
  });

  it("o módulo não carrega NENHUM endereço embutido como fallback", () => {
    const src = readFileSync(path.join(__dirname, "web-push-channel.ts"), "utf8");
    expect(src).not.toMatch(/mailto:[a-z0-9._%+-]+@[a-z0-9.-]+/i);
  });
});
