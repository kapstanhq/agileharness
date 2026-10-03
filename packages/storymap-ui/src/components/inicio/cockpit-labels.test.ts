import { describe, expect, it } from "vitest";
import {
  approvalAbsentState,
  approvalRequesterText,
  cardAbsentState,
  hostNoticeAbsentState,
  receiptAbsentState,
  systemDecisionAbsentState,
  docProposalHeadline,
  docProposalNotices,
  governanceDecision,
  inboxAbsentState,
  governanceSections,
  meterRenewMessage,
  previewList,
} from "./cockpit-labels";
import { PRD_SCHEMA } from "@/lib/storymap/doc/schemas/prd";
import type { KeepaliveNowOutcome } from "@/lib/storymap/runner/capacity-service";
import type { GovernanceChange, GovernanceDraft } from "@/lib/storymap/types";
import { inboxItemHref } from "@/lib/storymap/deep-links";
import { governanceItemsFromDrafts } from "@/lib/storymap/demands";

// (As tabelas de rótulo por kind, as cores de raia, o título e o resumo por kind saíram na onda 2 do Inbox: o texto de
// cada item é do modelo — lib/storymap/inbox/decision.ts —, e as garantias delas vivem em inbox/decision.test.ts.)

// ── A proposta de governança como DECISÃO (v0.9.2) ────────────────────────────────────────────────
// O defeito: o rascunho do PRD vinha INTEIRO antes do Aprovar, que ficava muito abaixo da dobra no celular; e o título
// do item era a lista de chaves ("prd.resumo + prd.problema + …").

/** Um rascunho do PRD INTEIRO: uma mudança por seção do schema (topo e subseções), como o de um board que propõe o PRD completo. */
const fullPrd: GovernanceChange[] = PRD_SCHEMA.sections.map((sec) => ({
  artifact: "prd",
  field: sec.key,
  before: "",
  after: `texto de ${sec.label}`,
  label: `PRD · ${sec.label}`,
}));
const topLevel = PRD_SCHEMA.sections.filter((sec) => sec.level === 2);

describe("governanceSections", () => {
  it("no PRD conta a seção de TOPO: a subseção entra como a seção que a contém, sem repetir", () => {
    const sections = governanceSections(fullPrd);
    expect(fullPrd.length).toBe(20);
    expect(sections).toHaveLength(16);
    expect(sections).toEqual(topLevel.map((sec) => sec.label));
  });

  it("nos outros artefatos cada campo tocado é uma unidade, com o rótulo do proponente", () => {
    expect(
      governanceSections([
        { artifact: "canvas", field: "problem", before: "", after: "x", label: "Canvas · Problema" },
        { artifact: "canvas", field: "problem", before: "", after: "y", label: "Canvas · Problema" },
        { artifact: "desiredOutcome", field: null, before: "", after: "z" },
      ]),
    ).toEqual(["Canvas · Problema", "resultado-alvo"]);
  });
});

describe("governanceDecision", () => {
  it("o PRD inteiro vira UMA manchete — o que se decide e o tamanho: «Aprovar o PRD do board — 16 seções»", () => {
    const d = governanceDecision({ changes: fullPrd, conflicts: [] })!;
    expect(d.headline).toBe("Aprovar o PRD do board — 16 seções");
    expect(d.readLabel).toBe("Ler o rascunho completo (16 seções)");
    expect(d.sections).toHaveLength(16);
  });

  it("conflitos entram na manchete — o dono vê que o Aprovar está bloqueado antes de tentar", () => {
    expect(governanceDecision({ changes: fullPrd, conflicts: ["PRD · Posicionamento"] })!.headline).toBe(
      "Aprovar o PRD do board — 16 seções, 1 conflito",
    );
    const one: GovernanceChange[] = [{ artifact: "positioning", field: null, before: "a", after: "b" }];
    expect(governanceDecision({ changes: one, conflicts: ["positioning", "x"] })!.headline).toBe(
      "Aprovar o posicionamento — 2 conflitos",
    );
  });

  it("um artefato só, uma mudança: sem contagem; várias: contadas; canvas por bloco; vários artefatos: nomeados", () => {
    const one: GovernanceChange[] = [{ artifact: "desiredOutcome", field: null, before: "a", after: "b" }];
    expect(governanceDecision({ changes: one, conflicts: [] })).toMatchObject({
      headline: "Aprovar o resultado-alvo",
      readLabel: "Ver o antes e depois (1 mudança)",
    });
    const canvas: GovernanceChange[] = [
      { artifact: "canvas", field: "problem", before: "", after: "x" },
      { artifact: "canvas", field: "solution", before: "", after: "y" },
    ];
    expect(governanceDecision({ changes: canvas, conflicts: [] })!.headline).toBe("Aprovar o Lean Canvas — 2 blocos");
    const mixed: GovernanceChange[] = [...one, ...canvas];
    expect(governanceDecision({ changes: mixed, conflicts: [] })!.headline).toBe(
      "Aprovar mudanças no board — resultado-alvo + Lean Canvas",
    );
  });

  it("sem mudança nenhuma ⇒ null (a tela cai no rótulo do kind)", () => {
    expect(governanceDecision({ changes: [], conflicts: [] })).toBeNull();
  });

});

// ── A proposta pendente vista de DENTRO do documento ──────────────────────────────────────────────
// Quem abria o PRD via o texto de sempre: a versão nova esperava no Inbox, e a
// tela do documento não dava sinal nenhum. O aviso diz que existe, o tamanho, quem propôs — e leva ao item.

describe("docProposalHeadline", () => {
  it("uma: diz que existe e que o que está na tela é a versão aprovada", () => {
    expect(docProposalHeadline(1)).toBe(
      "Há uma proposta pendente para este documento — o que você vê abaixo é a versão aprovada.",
    );
  });

  it("várias: contadas na mesma frase", () => {
    expect(docProposalHeadline(3)).toBe(
      "Há 3 propostas pendentes para este documento — o que você vê abaixo é a versão aprovada.",
    );
  });
});

describe("docProposalNotices", () => {
  const draft = (over: Partial<GovernanceDraft> = {}): GovernanceDraft => ({
    id: "c91e-draft",
    board: "b",
    status: "pending",
    reason: "",
    origin: { skill: "claude-code-session", cardId: null },
    changes: fullPrd,
    createdAt: "2026-03-11",
    decidedAt: null,
    ...over,
  });

  it("leva à página do MESMO item que o Inbox mostra — o id é o do cockpit, não uma segunda construção", () => {
    const d = draft();
    const [notice] = docProposalNotices([d], "b");
    const [item] = governanceItemsFromDrafts([d], new Map(), "b", Date.parse("2026-03-11T12:00:00Z"));
    expect(notice.href).toBe(inboxItemHref("b", item.id));
    expect(notice.href).toBe("/board/b/inbox/gov%3Ac91e-draft");
    expect(notice.draftId).toBe("c91e-draft");
  });

  it("o detalhe: o tamanho na unidade do Inbox, quem propôs e o dia — «16 seções», como no título do item", () => {
    expect(docProposalNotices([draft()], "b")[0].detail).toBe(
      "16 seções · proposta por um agente (claude-code-session) · em 11/03",
    );
  });

  it("sem `origin.skill` a proposta é de uma pessoa (a UI não o preenche, `propose_change` sim)", () => {
    const humana = draft({ origin: null, changes: fullPrd.slice(0, 1) });
    expect(docProposalNotices([humana], "b")[0].detail).toBe("1 seção · proposta por uma pessoa · em 11/03");
  });

  it("no Lean Canvas a unidade é o bloco; data ilegível some do detalhe em vez de virar lixo", () => {
    const canvas = draft({
      createdAt: "ontem",
      changes: [
        { artifact: "canvas", field: "problem", before: null, after: { items: [] } },
        { artifact: "canvas", field: "solution", before: null, after: { items: [] } },
      ],
    });
    expect(docProposalNotices([canvas], "b")[0].detail).toBe("2 blocos · proposta por um agente (claude-code-session)");
  });

  it("uma linha por proposta, na ordem recebida", () => {
    const notices = docProposalNotices([draft({ id: "x" }), draft({ id: "y" })], "b");
    expect(notices.map((n) => n.draftId)).toEqual(["x", "y"]);
  });
});

// ── O item que não está no Inbox ─────────────────────────────────────────────────────────────────
// A página do item dizia «Este item já foi resolvido» para QUALQUER id que não achasse — inclusive o de um link
// quebrado para um item pendente. Agora ela diz o que sabe: o desfecho real, quando é uma proposta em disco; senão,
// que o item não está lá.

describe("inboxAbsentState", () => {
  const AGORA = Date.parse("2026-09-25T12:00:00Z");
  const decidida = (over: Partial<GovernanceDraft>): GovernanceDraft => ({
    id: "d1",
    board: "b",
    status: "approved",
    reason: "",
    origin: { skill: "harness-plan", cardId: null },
    changes: [],
    createdAt: "2026-09-20",
    decidedAt: "2026-09-24",
    ...over,
  });

  it("sem proposta em disco: não afirma que foi resolvido — pode ter sido, ou o link pode estar quebrado", () => {
    const st = inboxAbsentState(null, AGORA);
    expect(st.title).toBe("Este item não está no Inbox.");
    expect(st.detail).toBe("Ele pode já ter sido resolvido — ou o link pode estar quebrado.");
    expect(`${st.title} ${st.detail}`).not.toMatch(/já foi resolvido\./);
  });

  it("aprovada: o desfecho e o dia; por revisor par quando foi ele", () => {
    expect(inboxAbsentState(decidida({}), AGORA)).toEqual({
      title: "Esta proposta já foi aprovada.",
      detail: "Aprovada em 24/09 — as mudanças já valem no board.",
    });
    expect(inboxAbsentState(decidida({ approvedBy: "peer:run-7" }), AGORA).detail).toBe(
      "Aprovada em 24/09 por um revisor par — as mudanças já valem no board.",
    );
  });

  it("rejeitada × retirada: a segunda é do proponente, não um «não» de quem decide", () => {
    expect(inboxAbsentState(decidida({ status: "rejected" }), AGORA)).toEqual({
      title: "Esta proposta foi rejeitada.",
      detail: "Rejeitada em 24/09 — o board ficou como estava.",
    });
    expect(inboxAbsentState(decidida({ status: "rejected", withdrawnBy: "agent" }), AGORA)).toEqual({
      title: "Esta proposta foi retirada.",
      detail: "Retirada por quem a propôs em 24/09 — o board ficou como estava.",
    });
  });

  it("pendente e vencida: saiu do Inbox pelo prazo, sem decisão", () => {
    const st = inboxAbsentState(decidida({ status: "pending", decidedAt: null, createdAt: "2026-09-01" }), AGORA);
    expect(st.title).toBe("Esta proposta venceu sem decisão.");
    expect(st.detail).toBe(
      "Ficou mais de 14 dias pendente e saiu do Inbox — o board ficou como estava. Se ela ainda fizer sentido, peça uma nova.",
    );
  });

  it("pendente e NÃO vencida (mas fora da lista): não inventa desfecho — cai no texto honesto genérico", () => {
    const st = inboxAbsentState(decidida({ status: "pending", decidedAt: null, createdAt: "2026-09-25" }), AGORA);
    expect(st).toEqual(inboxAbsentState(null, AGORA));
  });

  it("sem data de decisão: o desfecho sem o dia, nunca «em undefined»", () => {
    expect(inboxAbsentState(decidida({ decidedAt: null }), AGORA).detail).toBe("Aprovada — as mudanças já valem no board.");
  });
});

describe("previewList", () => {
  it("até `max` nomes, o resto contado", () => {
    expect(previewList(["a", "b"])).toBe("a, b");
    expect(previewList(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d e mais 2");
    expect(previewList(["a", "b", "c"], 2)).toBe("a, b e mais 1");
  });
});

// ── O medidor de cota parado: aviso compacto + «Renovar agora» (v0.9.2) ──────────────────────────────

describe("meterRenewMessage", () => {
  const ALL: KeepaliveNowOutcome[] = ["renewed", "still-stalled", "failed", "not-configured", "no-meter"];

  it.each(ALL)("dá a %s uma frase", (outcome) => {
    expect(meterRenewMessage({ outcome, detail: "" }).text.trim().length).toBeGreaterThan(0);
  });

  it("só «renovado» é sucesso; «não configurado» diz a QUEM pedir e O QUÊ", () => {
    expect(meterRenewMessage({ outcome: "renewed", detail: "ok" })).toEqual({
      tone: "success",
      text: "Medidor renovado — a automação volta a entrar.",
    });
    const nc = meterRenewMessage({ outcome: "not-configured", detail: "" });
    expect(nc.tone).not.toBe("success");
    expect(nc.text).toContain("operador do host");
    expect(nc.text).toContain("AGILEHARNESS_METER_KEEPALIVE");
    for (const o of ALL.filter((x) => x !== "renewed")) expect(meterRenewMessage({ outcome: o, detail: "" }).tone, o).not.toBe("success");
  });

  it("a falha carrega o erro do keepalive", () => {
    expect(meterRenewMessage({ outcome: "failed", detail: "exit 1 — not logged in" })).toEqual({
      tone: "error",
      text: "O keepalive falhou: exit 1 — not logged in",
    });
  });
});

// B4 / F7 (auditoria do Inbox) — o pedido dizia «Jido pede» para QUALQUER agente — inclusive uma sessão
// externa de orquestração com outra credencial. O Inbox diz quem pede, em palavras.
describe("approvalRequesterText — quem pede, em palavras (B4)", () => {
  it("credencial por env, handle, o legado e o desconhecido", () => {
    expect(approvalRequesterText("mcp:write(AGILEHARNESS_MCP_TOKEN_ORCH)")).toBe("Um agente com a credencial AGILEHARNESS_MCP_TOKEN_ORCH");
    expect(approvalRequesterText("handle:h-3f2a")).toBe("Um agente com o acesso h-3f2a");
    expect(approvalRequesterText("run:orch")).toBe("Um agente autônomo");
    expect(approvalRequesterText(undefined)).toBe("Um agente");
    for (const who of ["mcp:write(AGILEHARNESS_MCP_TOKEN_ORCH)", "handle:h", "run:orch", undefined]) {
      expect(approvalRequesterText(who)).not.toMatch(/Jido/);
    }
  });
});

// B8 — a proposta substituída por uma mais nova não some em silêncio: o link antigo diz o que houve e leva à nova.
describe("inboxAbsentState — proposta SUBSTITUÍDA (B8)", () => {
  it("diz que foi substituída e aponta a página da nova", () => {
    const st = inboxAbsentState(
      { status: "rejected", createdAt: "2026-09-23", decidedAt: "2026-09-25", approvedBy: null, withdrawnBy: null, supersededBy: "d-nova" },
      Date.parse("2026-09-28T12:00:00Z"),
      "b",
    );
    expect(st.title).toMatch(/substituída/);
    expect(st.href).toBe("/board/b/inbox/gov%3Ad-nova");
  });
});

// B11 (auditoria do Inbox) — a página de um PEDIDO de agente que saiu do Inbox dizia «pode já ter sido
// resolvido — ou o link pode estar quebrado», embora o sidecar soubesse o desfecho.
describe("approvalAbsentState — o desfecho real do pedido (B11)", () => {
  const base = { requestedAt: "2026-09-27T14:32:00.000Z", expiresAt: "2026-09-28T14:32:00.000Z", decidedAt: "2026-09-27T15:45:00.000Z" };
  it("autorizado, executado, negado e vencido — cada um diz o que aconteceu", () => {
    expect(approvalAbsentState({ ...base, status: "granted" }).title).toMatch(/autoriza/i);
    expect(approvalAbsentState({ ...base, status: "consumed" }).detail).toMatch(/executou/);
    expect(approvalAbsentState({ ...base, status: "rejected" }).title).toMatch(/negado/i);
    const expired = approvalAbsentState({ ...base, status: "expired", decidedAt: undefined });
    expect(expired.title).toMatch(/venceu/i);
    expect(expired.detail).toMatch(/não executou/);
    expect(approvalAbsentState(null).title).toBe("Este item não está no Inbox.");
  });

  it("o aviso do host que sumiu: o medidor voltou", () => {
    expect(hostNoticeAbsentState("host:meter-stalled:123")?.title).toMatch(/medidor/i);
    expect(hostNoticeAbsentState("c1:review")).toBeNull();
  });
});

describe("onda 2, passo 5 — a página de um item que sumiu diz o DESFECHO que os registros sabem", () => {
  const rec = {
    v: 1 as const,
    id: "rc-1",
    at: "2026-09-28T19:00:00Z",
    board: "b",
    itemId: "story-a:review",
    cardId: "story-a",
    kind: "review",
    ask: "Aceitar «Busca» como trabalho?",
    text: "«Busca» foi para «Entrevista».",
    undo: { kind: "move-back" as const, boardId: "b", cardId: "story-a", from: "interview", to: "triage", toStaging: true },
  };

  it("o dono decidiu: o que aconteceu, quando, e o «Desfazer» enquanto vale", () => {
    const s = receiptAbsentState(rec);
    expect(s.title).toBe("Você já decidiu isto.");
    expect(s.detail).toBe("«Busca» foi para «Entrevista». Decidido {t:2026-09-28T19:00:00Z}.");
    expect(s.undo).toEqual({ receiptId: "rc-1", label: "Desfazer: voltar à Triagem" });
    const undone = receiptAbsentState(rec, "2026-09-28T19:05:00Z");
    expect(undone.title).toMatch(/depois desfez/);
    expect(undone.undo).toBeUndefined();
  });

  it("o sistema decidiu: quem, o quê e por quê", () => {
    const s = systemDecisionAbsentState({ agent: "triage-judge", what: "Aceitou «B»", why: "o PRD pede", at: "2026-09-28T18:00:00Z" });
    expect(s.title).toBe("O sistema decidiu isto.");
    expect(s.detail).toBe("Juiz da triagem, {t:2026-09-28T18:00:00Z}: Aceitou «B» — por quê: o PRD pede.");
  });

  it("sem registro, mas o card existe: onde ele está agora — nunca «pode ser um link quebrado»", () => {
    const s = cardAbsentState({ id: "story-a", title: "Busca", status: "interview" }, { id: "b", statuses: [{ id: "interview", name: "Entrevista" }] as never });
    expect(s.detail).toBe("Ninguém registrou uma decisão aqui; «Busca» está agora em «Entrevista».");
    expect(s.href).toBe("/board/b/card/story-a");
  });
});
