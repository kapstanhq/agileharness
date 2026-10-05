// O item do Inbox do pedido de autorização que o plano listou sem card (publish-approval-item.ts) e a decisão dele
// (inbox/decision.ts). Fixtures INVENTADAS: o board `feira` publica o pacote `feira`.

import { describe, expect, it } from "vitest";
import type { OwnerApprovalRequest } from "./runner/deploy-proof";
import type { DeployBlockRow } from "./runner/deploy-blocks";
import { publishApprovalItems } from "./publish-approval-item";
import { decideItem } from "./inbox/decision";
import { ULTRA, HUMAN } from "./inbox/items.fixture";
import { authorizeOwnerPublish, type OwnerApprovalDeps } from "./runner/owner-approval";

const NOW = Date.UTC(2026, 9, 6, 1, 0);
const req = (c: string, file: string): OwnerApprovalRequest => ({
  subject: { kind: "diff", hash: `sha256:${c.repeat(64)}`, base: "0a1b2c3", head: "a1b2c3d", files: [file] },
  record: "./registrar-sim <approval.json>",
  units: ["vitrine"],
  rules: ["taxa-de-entrega"],
});
const row = (over: Partial<DeployBlockRow> = {}): DeployBlockRow => ({
  board: "feira",
  causeKey: "feira:owner:?",
  pkg: "feira",
  phase: "needs-human",
  decider: "owner",
  ownerClass: null,
  units: ["vitrine"],
  rules: ["taxa-de-entrega"],
  command: "./publicar feira",
  firstAt: "2026-10-06T00:00:00Z",
  lastAt: "2026-10-06T00:00:00Z",
  cardIds: [],
  planHead: null,
  attributedCard: null,
  approvals: [req("c", "web/entrega/taxa.ts")],
  planSourced: true,
  ...over,
});

describe("publishApprovalItems — só a linha do plano, do dono, sem card, com algo a mostrar", () => {
  it("o pedido que vale vira item do board, sem card, com a causa e os arquivos", () => {
    const [item] = publishApprovalItems([row()], "feira", NOW);
    expect(item).toMatchObject({ kind: "publish-approval", boardId: "feira", cardId: "", causeKey: "feira:owner:?", rerequesting: false, stale: false, lane: "aprovar" });
    expect(item.approvals).toEqual([{ hash: `sha256:${"c".repeat(64)}`, files: ["web/entrega/taxa.ts"], units: ["vitrine"], rules: ["taxa-de-entrega"] }]);
  });
  it("nada: outro board, linha de card, linha comum, do sistema, ou tudo já autorizado", () => {
    expect(publishApprovalItems([row()], "outro", NOW)).toEqual([]);
    expect(publishApprovalItems([row({ cardIds: ["c1"] })], "feira", NOW)).toEqual([]);
    expect(publishApprovalItems([row({ planSourced: undefined })], "feira", NOW)).toEqual([]);
    expect(publishApprovalItems([row({ decider: "system" })], "feira", NOW)).toEqual([]);
    expect(publishApprovalItems([row({ approvals: undefined, granted: [`sha256:${"c".repeat(64)}`] })], "feira", NOW)).toEqual([]);
  });
  it("refazendo (dentro da janela) e velho são estados do item, sem pedido a autorizar", () => {
    const redo = publishApprovalItems([row({ rerequestedAt: new Date(NOW - 60_000).toISOString() })], "feira", NOW)[0];
    expect(redo.rerequesting).toBe(true);
    expect(publishApprovalItems([row({ rerequestedAt: new Date(NOW - 31 * 60_000).toISOString() })], "feira", NOW)[0].rerequesting).toBe(false);
    const stale = publishApprovalItems([row({ staleApprovals: [`sha256:${"c".repeat(64)}`] })], "feira", NOW)[0];
    expect(stale).toMatchObject({ stale: true, approvals: [] });
  });
});

describe("a decisão do item — o mesmo «Autorizar publicar» da publicação parada", () => {
  const decide = (over: Partial<DeployBlockRow> = {}, config = ULTRA) => {
    const [item] = publishApprovalItems([row({ board: config.id, ...over })], config.id, NOW);
    return decideItem(item, { config, now: NOW, tier: "chat" });
  };
  it("pedido que vale ⇒ Decidir, com o botão que grava a autorização da CAUSA do livro (em qualquer modo)", () => {
    for (const config of [ULTRA, HUMAN]) {
      const d = decide({}, config);
      expect(d.bucket).not.toBe("acompanhar");
      expect(d.askVerb).toBe("Autorizar");
      expect(d.options[0]).toMatchObject({ id: "authorize-publish", invoke: { kind: "authorize-publish", boardId: config.id, causeKey: "feira:owner:?" } });
    }
  });
  it("refazendo ⇒ Acompanhar, sem botão; velho ⇒ Acompanhar, com a Esteira", () => {
    const redo = decide({ rerequestedAt: new Date(NOW - 60_000).toISOString() });
    expect(redo).toMatchObject({ bucket: "acompanhar", askVerb: null, options: [] });
    const stale = decide({ staleApprovals: [`sha256:${"c".repeat(64)}`] });
    expect(stale).toMatchObject({ bucket: "acompanhar", askVerb: null, options: [] });
    expect(stale.more.some((o) => o.invoke.kind === "link" && o.invoke.href.endsWith("/entrega"))).toBe(true);
  });
});

describe("o clique na linha sem card grava e não republica nada", () => {
  it("a autorização é gravada, o pedido sai da linha, nenhum card é republicado e a mensagem diz isso", async () => {
    const recorded: string[] = [];
    const granted: string[][] = [];
    const deps: OwnerApprovalDeps = {
      readRow: async () => row(),
      record: async (_a, r) => {
        recorded.push(r.subject.hash);
        return { ok: true };
      },
      grant: async (_b, _k, h) => {
        granted.push(h);
      },
      republish: async () => {
        throw new Error("não devia republicar");
      },
      rerequest: async () => ({ ok: true, board: "feira", via: "plan" }),
      now: () => NOW,
    };
    const res = await authorizeOwnerPublish(deps, { board: "feira", causeKey: "feira:owner:?" });
    expect(res).toMatchObject({ ok: true, recorded: 1, republished: null });
    expect(recorded).toEqual([`sha256:${"c".repeat(64)}`]);
    expect(granted).toEqual([[`sha256:${"c".repeat(64)}`]]);
    if (res.ok) expect(res.message).toMatch(/próxima publicação do board/);
  });
});
