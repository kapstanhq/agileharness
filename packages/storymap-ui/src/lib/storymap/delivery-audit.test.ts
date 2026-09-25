// A auditoria por amostra das ENTREGAS AUTÔNOMAS (modo ultra) — as respostas puras. Cada caso é uma linha da regra:
// só entrega (status `delivered`), só ultra efetivo, só caminho autônomo (o dono não aprovou), amostra determinística
// pelo card; Confirmar fecha; Reabrir devolve a story pelo refino com o motivo como finding.

import { describe, expect, it } from "vitest";
import {
  DELIVERY_AUDIT_FINDING_ID,
  applyDeliveryAuditOutcome,
  deliveryAuditDecision,
  deliveryAuditKey,
  deliveryProofOf,
  isAutonomousDelivery,
  isDeliverySampled,
  isPendingDeliveryAudit,
  stampDeliveryAudit,
} from "./delivery-audit";
import { auditDraw } from "./autonomy";
import type { BoardConfig, Card } from "./types";

const cfg = (over: Partial<BoardConfig> = {}): BoardConfig => ({
  id: "b",
  name: "B",
  statuses: [
    { id: "desenvolver", name: "Desenvolver", trigger: "harness-do", autorun: true },
    { id: "revisao", name: "Aprovar entrega", gate: "hasQaPassed", autorun: false },
    { id: "merge", name: "Integrar", autorun: true },
    { id: "release", name: "Liberar", autorun: false },
    { id: "concluida", name: "No ar", terminal: true, delivered: true },
    { id: "arquivados", name: "Arquivados", terminal: true },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
  autonomy: { mode: "ultra" },
  ...over,
});

/** Ids que caem / não caem na amostra padrão (0,2) — escolhidos pelo MESMO sorteio que o código usa. */
const ids = Array.from({ length: 200 }, (_, i) => `story-${i}`);
const SAMPLED = ids.find((id) => auditDraw(deliveryAuditKey("b", id)) < 0.2)!;
const UNSAMPLED = ids.find((id) => auditDraw(deliveryAuditKey("b", id)) >= 0.2)!;

const card = (over: Partial<Card> = {}): Card =>
  ({ id: SAMPLED, type: "story", title: "Filtro por gênero", status: "concluida", findings: [], ...over }) as unknown as Card;

const hop = (from: string, actor: string, at = "2026-09-25T10:00:00Z") => ({ at, from, actor });

describe("deliveryAuditDecision — quando uma chegada a 'No ar' vira auditoria do dono", () => {
  it("ultra + caminho autônomo + amostrado ⇒ audita", () => {
    expect(deliveryAuditDecision({ board: "b", card: card(), config: cfg(), transitions: [hop("revisao", "run:orch")] })).toEqual({ sample: true });
  });

  it("modo HUMAN não muda (board human, board sem o bloco, ou exceção human da story)", () => {
    const t = [hop("revisao", "run:orch")];
    expect(deliveryAuditDecision({ board: "b", card: card(), config: cfg({ autonomy: { mode: "human" } }), transitions: t }).sample).toBe(false);
    expect(deliveryAuditDecision({ board: "b", card: card(), config: cfg({ autonomy: undefined }), transitions: t }).sample).toBe(false);
    expect(deliveryAuditDecision({ board: "b", card: card({ autonomyMode: "human" }), config: cfg(), transitions: t }).sample).toBe(false);
    // e o inverso: a exceção ULTRA da story num board human audita
    expect(deliveryAuditDecision({ board: "b", card: card({ autonomyMode: "ultra" }), config: cfg({ autonomy: undefined }), transitions: t }).sample).toBe(true);
  });

  it("o DONO aprovou a entrega (a última travessia do passo de aprovação foi humana) ⇒ não audita", () => {
    const v = deliveryAuditDecision({ board: "b", card: card(), config: cfg(), transitions: [hop("revisao", "human")] });
    expect(v).toEqual({ sample: false, reason: "o dono aprovou esta entrega" });
  });

  it("vale a travessia MAIS RECENTE: aprovado pelo dono numa volta antiga, autônomo agora ⇒ audita", () => {
    const t = [hop("revisao", "run:orch", "2026-09-25T12:00:00Z"), hop("revisao", "human", "2026-09-20T12:00:00Z")];
    expect(isAutonomousDelivery(t, cfg())).toBe(true);
    expect(isAutonomousDelivery([...t, hop("revisao", "human", "2026-09-26T00:00:00Z")], cfg())).toBe(false);
  });

  it("sem registro da travessia (ledger vazio/compactado) ⇒ conta como autônoma: na dúvida, o dono vê", () => {
    expect(deliveryAuditDecision({ board: "b", card: card(), config: cfg(), transitions: [] }).sample).toBe(true);
    // saltos que não saem do passo de aprovação não contam
    expect(isAutonomousDelivery([hop("desenvolver", "human"), hop("merge", "human")], cfg())).toBe(true);
  });

  it("PUBLICAR não é aprovar: o dono clicar em Liberar→Publicar (release manual) não tira a entrega da amostra", () => {
    // a parada manual de publicação também é autorun:false — mas não é o gate da prova da entrega (hasQaPassed)
    expect(isAutonomousDelivery([hop("revisao", "run:orch", "2026-09-24T00:00:00Z"), hop("release", "human")], cfg())).toBe(true);
  });

  it("fora da amostra ⇒ não audita; a amostra é determinística pelo card", () => {
    const v = deliveryAuditDecision({ board: "b", card: card({ id: UNSAMPLED }), config: cfg(), transitions: [] });
    expect(v).toEqual({ sample: false, reason: "fora da amostra" });
    for (let i = 0; i < 3; i++) {
      expect(isDeliverySampled("b", SAMPLED, 0.2)).toBe(true);
      expect(isDeliverySampled("b", UNSAMPLED, 0.2)).toBe(false);
    }
    expect(isDeliverySampled("b", SAMPLED, 0)).toBe(false);
    expect(isDeliverySampled("b", UNSAMPLED, 1)).toBe(true);
    // a taxa do board (autonomy.auditSampleRate) é a que vale
    expect(deliveryAuditDecision({ board: "b", card: card({ id: UNSAMPLED }), config: cfg({ autonomy: { mode: "ultra", auditSampleRate: 1 } }), transitions: [] }).sample).toBe(true);
  });

  it("terminal que NÃO é entrega (arquivado), board sem a faceta `delivered`, ou card que não é story ⇒ não audita", () => {
    expect(deliveryAuditDecision({ board: "b", card: card({ status: "arquivados" }), config: cfg(), transitions: [] }).sample).toBe(false);
    const semFaceta = cfg({ statuses: cfg().statuses.map((s) => ({ ...s, delivered: undefined })) });
    expect(deliveryAuditDecision({ board: "b", card: card(), config: semFaceta, transitions: [] }).sample).toBe(false);
    expect(deliveryAuditDecision({ board: "b", card: card({ type: "step" }), config: cfg(), transitions: [] }).sample).toBe(false);
  });

  it("já há uma auditoria PENDENTE ⇒ não carimba de novo; uma FECHADA de uma entrega anterior é substituída", () => {
    const pending = card({ deliveryAudit: { sampledAt: "2026-09-20" } });
    expect(deliveryAuditDecision({ board: "b", card: pending, config: cfg(), transitions: [] }).sample).toBe(false);
    const closed = card({ deliveryAudit: { sampledAt: "2026-09-20", auditedAt: "2026-09-21", outcome: "confirmed" } });
    expect(deliveryAuditDecision({ board: "b", card: closed, config: cfg(), transitions: [] }).sample).toBe(true);
    expect(stampDeliveryAudit(closed, "2026-09-25").deliveryAudit).toEqual({ sampledAt: "2026-09-25", deliveredIn: "concluida" });
  });
});

describe("applyDeliveryAuditOutcome — Confirmar / Reabrir", () => {
  const pending = () => card({ deliveryAudit: { sampledAt: "2026-09-25", deliveredIn: "concluida" }, routing: { skips: [], decidedBy: "rules", decidedAt: "2026-09-24", driver: "conductor" } as Card["routing"] });

  it("Confirmar fecha a auditoria e não mexe em mais nada", () => {
    const r = applyDeliveryAuditOutcome(pending(), cfg(), { outcome: "confirmed", today: "2026-09-26" });
    expect("card" in r && r.card.deliveryAudit).toEqual({ sampledAt: "2026-09-25", deliveredIn: "concluida", auditedAt: "2026-09-26", outcome: "confirmed" });
    expect("card" in r && r.card.status).toBe("concluida");
    expect(isPendingDeliveryAudit("card" in r ? r.card : pending())).toBe(false);
  });

  it("Reabrir SEM motivo é recusado (o refino parte dele)", () => {
    expect(applyDeliveryAuditOutcome(pending(), cfg(), { outcome: "reopened", today: "2026-09-26", note: "  " })).toMatchObject({ error: expect.stringMatching(/motivo/) });
  });

  it("Reabrir devolve a story pelo REFINO, com o motivo como finding aberto e sem o condutor", () => {
    const r = applyDeliveryAuditOutcome(pending(), cfg(), { outcome: "reopened", today: "2026-09-26", note: "o filtro some ao voltar da página" });
    if (!("card" in r)) throw new Error(r.error);
    expect(r.card).toMatchObject({ status: "desenvolver", mode: "refine", reopenPending: true, routing: null });
    expect(r.card.refinement?.brief).toContain("o filtro some ao voltar da página");
    expect(r.card.findings?.find((f) => f.id === DELIVERY_AUDIT_FINDING_ID)).toMatchObject({ status: "open", severity: "high", detail: "o filtro some ao voltar da página" });
    expect(r.card.deliveryAudit).toMatchObject({ auditedAt: "2026-09-26", outcome: "reopened", note: "o filtro some ao voltar da página" });
  });

  it("recusa: nada pendente; card que já saiu de 'No ar'; destino fora da lista do Refinar", () => {
    expect(applyDeliveryAuditOutcome(card(), cfg(), { outcome: "confirmed", today: "x" })).toMatchObject({ error: expect.any(String) });
    const moved = { ...pending(), status: "desenvolver" };
    expect(applyDeliveryAuditOutcome(moved, cfg(), { outcome: "reopened", today: "x", note: "n" })).toMatchObject({ error: expect.stringMatching(/já saiu/) });
    // …mas Confirmar ainda fecha a auditoria dela
    expect("card" in applyDeliveryAuditOutcome(moved, cfg(), { outcome: "confirmed", today: "x" })).toBe(true);
    expect(applyDeliveryAuditOutcome(pending(), cfg(), { outcome: "reopened", today: "x", note: "n", destination: "merge" })).toMatchObject({ error: expect.stringMatching(/destino/) });
  });
});

describe("deliveryProofOf — a Prova da entrega que o Inbox mostra", () => {
  it("extrai só a seção, até o próximo ##", () => {
    const body = "## Investigação\nx\n\n## Prova da entrega\n- **O que mudou:** filtro\n- **Testes:** 3 novos\n\n## Premissas\ny";
    expect(deliveryProofOf(body)).toBe("- **O que mudou:** filtro\n- **Testes:** 3 novos");
  });

  it("ausente ou vazia ⇒ null; longa ⇒ cortada com reticências", () => {
    expect(deliveryProofOf("## Outra\nx")).toBeNull();
    expect(deliveryProofOf("## Prova da entrega\n\n## Próxima")).toBeNull();
    expect(deliveryProofOf(undefined)).toBeNull();
    expect(deliveryProofOf(`## Prova da entrega\n${"a".repeat(3000)}`)!.endsWith("…")).toBe(true);
  });
});
