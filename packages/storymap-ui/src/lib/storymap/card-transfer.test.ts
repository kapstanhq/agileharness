// MUDAR UM CARD DE BOARD — a regra pura: quando recusa (e com que frase), e o que o card vira no board novo (status,
// âncora, vínculos, trilha, achado que pede a âncora, condutor que fica para trás).

import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { entryStatusOf, heldByForcedTransfer, planCardTransfer, transferRefusal, transferRegimeLoosening, TRANSFER_ANCHOR_FINDING_ID, type TransferRegime } from "./card-transfer";
import { coerceCard } from "./repo";
import { serializeCard } from "./write";
import { parseCard } from "./contracts";
import type { Card } from "./types";

const story = (id: string, over: Record<string, unknown> = {}): Card => coerceCard(id, { type: "story", title: id, status: "enriquecer", ...over }, "corpo original");
const node = (id: string, type: "step" | "activity", title: string): Card => coerceCard(id, { type, title, status: null }, "");

// Dois boards inventados: a «Estufa» (mudas) e o «Galpão» (logística).
const estufaStep = node("step-regar", "step", "Regar as mudas");
const estufaUser = story("story-ver-mudas", { storyType: "user", title: "Ver as mudas prontas", parent: "step-regar" });
const galpaoStep = node("step-empacotar", "step", "Empacotar pedidos");
const galpaoUser = story("story-etiquetas", { storyType: "user", title: "Imprimir etiquetas", parent: "step-empacotar" });

const toConfigSame = { statuses: [{ id: "triage", name: "Triagem", staging: true }, { id: "enriquecer", name: "Especificar" }] };
const toConfigOther = { statuses: [{ id: "entrada", name: "Entrada", staging: true }, { id: "fazendo", name: "Fazendo" }] };

const refusalBase = {
  fromBoard: "estufa",
  toBoard: "galpao",
  card: story("story-x", { storyType: "technical" }),
  toConfig: { id: "galpao", ...toConfigSame },
  toHasCard: false,
  busy: {},
  dependents: [] as Array<{ id: string; title: string }>,
};

describe("transferRefusal — quando a mudança de board recusa", () => {
  it("livre ⇒ null", () => {
    expect(transferRefusal(refusalBase)).toBeNull();
  });

  it.each([
    ["mesmo board", { toBoard: "estufa" }, /já está neste board/],
    ["destino inexistente", { toConfig: null }, /não existe/],
    ["card inexistente", { card: null }, /não existe no board de origem/],
    ["passo do mapa", { card: node("step-y", "step", "Y") }, /só histórias e ideias/],
    ["id repetido no destino", { toHasCard: true }, /id não pode se repetir/],
    ["run em voo", { busy: { run: true } }, /agente rodando/],
    ["reserva", { busy: { claim: true } }, /reservado/],
    ["sessão aberta", { busy: { session: true } }, /sessão de trabalho/],
    ["fila de integração", { busy: { mergeQueue: true } }, /fila de integração/],
    ["publicação", { busy: { publishing: true } }, /sendo publicado/],
    ["ancora outros", { dependents: [{ id: "story-filho", title: "Filho" }] }, /se ancoram neste/],
  ])("%s ⇒ recusa com o motivo", (_name, over, re) => {
    expect(transferRefusal({ ...refusalBase, ...(over as object) })).toMatch(re);
  });

  it("card conduzido (mesmo estacionado à espera do dono) ⇒ recusa: o `driver` é o que reabre o condutor", () => {
    const conducted = story("story-c", { storyType: "technical", routing: { skips: [], decidedBy: "rules", decidedAt: "2026-05-01", driver: "conductor" } });
    expect(transferRefusal({ ...refusalBase, card: conducted })).toMatch(/conduzido por um agente/);
  });

  it("pergunta do teto de rodadas ABERTA ⇒ recusa; respondida ⇒ livre", () => {
    const q = (status: "open" | "answered") => ({ id: "q1", text: "Teto de rodadas de revisão: a revisão de «X» achou problema de novo, depois de 2 rodadas. Como seguir?", status });
    expect(transferRefusal({ ...refusalBase, card: story("story-q", { storyType: "technical", questions: [q("open")] }) })).toMatch(/teto de rodadas/);
    expect(transferRefusal({ ...refusalBase, card: story("story-q", { storyType: "technical", questions: [q("answered")] }) })).toBeNull();
  });

  it("ideia muda de board", () => {
    expect(transferRefusal({ ...refusalBase, card: coerceCard("idea-z", { type: "idea", title: "Z", status: null }, "") })).toBeNull();
  });
});

describe("entryStatusOf — a porta de entrada do board", () => {
  it("a Triagem (staging), senão o primeiro passo", () => {
    expect(entryStatusOf(toConfigOther)).toBe("entrada");
    expect(entryStatusOf({ statuses: [{ id: "a", name: "A" }, { id: "b", name: "B" }] })).toBe("a");
  });
});

const plan = (card: Card, over: Partial<Parameters<typeof planCardTransfer>[0]> = {}) =>
  planCardTransfer({
    card,
    fromBoard: "estufa",
    fromName: "Estufa",
    toBoard: "galpao",
    toName: "Galpão",
    fromCards: [estufaStep, estufaUser, card],
    toConfig: toConfigSame,
    toCards: [galpaoStep, galpaoUser],
    by: "human",
    reason: "os arquivos são do galpão",
    at: "2026-05-04T10:00:00.000Z",
    ...over,
  });

describe("planCardTransfer — o card no board novo", () => {
  const delivery = story("story-caixa", {
    storyType: "technical",
    title: "Trocar o papel das caixas",
    serves: "story-ver-mudas",
    links: [{ rel: "relates-to", to: "story-ver-mudas" }, { rel: "relates-to", to: "story-etiquetas" }],
    routing: { skips: [], decidedBy: "rules", decidedAt: "2026-05-01", driver: "conductor" },
  });

  it("o mesmo status quando o destino o tem (com âncora de lá); a trilha registra de onde veio, quem, por quê e a âncora antiga", () => {
    const p = plan(delivery, { anchor: "story-etiquetas" });
    expect(p.error).toBeUndefined();
    expect(p.toStatus).toBe("enriquecer");
    expect(p.card.transfers).toEqual([
      {
        from: "estufa",
        to: "galpao",
        at: "2026-05-04T10:00:00.000Z",
        by: "human",
        reason: "os arquivos são do galpão",
        fromStatus: "enriquecer",
        previousAnchor: { id: "story-ver-mudas", title: "Ver as mudas prontas" },
      },
    ]);
    expect(p.card.id).toBe("story-caixa");
  });

  it("sem o passo no destino ⇒ a porta de entrada dele, com aviso", () => {
    const p = plan(delivery, { toConfig: toConfigOther });
    expect(p.toStatus).toBe("entrada");
    expect(p.warnings.join(" ")).toMatch(/não tem o passo «enriquecer»/);
  });

  it("sem âncora num passo que exige lugar ⇒ entra pela Triagem de lá (o único lugar onde é representável)", () => {
    const p = plan(delivery);
    expect(p.error).toBeUndefined();
    expect(p.toStatus).toBe("triage");
    expect(p.warnings.join(" ")).toMatch(/entrou pela Triagem/);
  });

  it("sem âncora e sem Triagem no destino ⇒ recusa (nada a escrever), dizendo para informar a âncora", () => {
    const p = plan(delivery, { toConfig: { statuses: [{ id: "enriquecer", name: "Especificar" }] } });
    expect(p.error).toMatch(/não tem Triagem/);
  });

  it("concluída (passo terminal) muda de board sem âncora e sem mudar de passo", () => {
    const done = { ...delivery, status: "concluida" } as Card;
    const p = plan(done, { toConfig: { statuses: [...toConfigSame.statuses, { id: "concluida", name: "No ar", terminal: true }] } });
    expect(p.error).toBeUndefined();
    expect(p.toStatus).toBe("concluida");
  });

  it("sem âncora: a antiga cai, o card fica sem lugar e um achado pede a âncora; vínculos de fora caem e vão ao corpo", () => {
    const p = plan(delivery);
    expect(p.card.serves).toBeNull();
    expect(p.card.parent).toBeNull();
    expect(p.card.unplaced).toBe(true);
    expect(p.card.findings.find((f) => f.id === TRANSFER_ANCHOR_FINDING_ID)).toMatchObject({ status: "open", severity: "medium" });
    expect(p.card.links).toEqual([{ rel: "relates-to", to: "story-etiquetas" }]);
    expect(p.droppedLinks).toEqual([{ rel: "relates-to", to: "story-ver-mudas" }]);
    expect(p.card.body).toMatch(/## Veio do board «Estufa» \(estufa\)/);
    expect(p.card.body).toMatch(/story-ver-mudas — Ver as mudas prontas/);
    expect(p.card.body.startsWith("corpo original")).toBe(true);
  });

  it("entrega só serve uma HISTÓRIA DE USUÁRIO: um passo como âncora não vale", () => {
    const p = plan(delivery, { anchor: "step-empacotar" });
    expect(p.card.serves).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/serve uma HISTÓRIA DE USUÁRIO/);
  });

  it("com âncora válida: entrega serve a história do board novo, sem achado", () => {
    const p = plan(delivery, { anchor: "story-etiquetas" });
    expect(p.card.serves).toBe("story-etiquetas");
    expect(p.card.unplaced).toBeUndefined();
    expect(p.card.findings.some((f) => f.id === TRANSFER_ANCHOR_FINDING_ID)).toBe(false);
  });

  it("história de usuário só mora sob um PASSO do board novo", () => {
    const u = story("story-u", { storyType: "user", parent: "step-regar" });
    expect(plan(u, { anchor: "step-empacotar" }).card.parent).toBe("step-empacotar");
    const bad = plan(u, { anchor: "story-etiquetas" });
    expect(bad.card.parent).toBeNull();
    expect(bad.warnings.join(" ")).toMatch(/mora sob um PASSO/);
    expect(bad.card.findings.some((f) => f.id === TRANSFER_ANCHOR_FINDING_ID)).toBe(true);
  });

  it("âncora inventada não grava id do board errado", () => {
    const p = plan(delivery, { anchor: "story-ver-mudas" });
    expect(p.card.serves).toBeNull();
    expect(p.warnings.join(" ")).toMatch(/não existe no board de destino/);
  });

  it("o condutor é do board antigo: o `driver` sai, o resto do roteamento fica", () => {
    const p = plan(delivery, { anchor: "story-etiquetas" });
    expect(p.card.routing).toEqual({ skips: [], decidedBy: "rules", decidedAt: "2026-05-01" });
  });

  it("uma segunda mudança acrescenta à trilha (não a substitui)", () => {
    const first = plan(delivery, { anchor: "story-etiquetas" }).card;
    const back = planCardTransfer({
      card: first,
      fromBoard: "galpao",
      toBoard: "estufa",
      fromCards: [galpaoStep, galpaoUser, first],
      toConfig: toConfigSame,
      toCards: [estufaStep, estufaUser],
      by: "agent",
      at: "2026-05-05T10:00:00.000Z",
      anchor: "story-ver-mudas",
    }).card;
    expect(back.transfers?.map((t) => `${t.from}>${t.to}`)).toEqual(["estufa>galpao", "galpao>estufa"]);
  });

  it("a trilha sobrevive à escrita e à leitura do arquivo, e o contrato a aceita", () => {
    const card = plan(delivery).card;
    const parsed = matter(serializeCard(card));
    const back = coerceCard(card.id, parsed.data, parsed.content);
    expect(back.transfers).toEqual(card.transfers);
    expect(parseCard(back).ok).toBe(true);
  });
});

describe("transferRegimeLoosening — o destino é mais permissivo?", () => {
  const strict: TransferRegime = { config: { autonomy: { mode: "human" } as never, release: { mode: "manual" } }, pace: "slow", admits: false };
  it("igual ⇒ vazio; destino mais estrito ⇒ vazio", () => {
    expect(transferRegimeLoosening({}, strict, strict)).toEqual([]);
    expect(transferRegimeLoosening({}, { ...strict, pace: "normal", admits: true }, strict)).toEqual([]);
  });
  it("cada eixo mais solto aparece com o motivo", () => {
    const loose: TransferRegime = {
      config: { autonomy: { mode: "ultra" } as never, release: { mode: "auto" }, orchestrator: { riskMatrix: { "write-board": "auto" } } as never },
      pace: "normal",
      admits: true,
    };
    const why = transferRegimeLoosening({}, { ...strict, config: { ...strict.config, orchestrator: { riskMatrix: { "write-board": "ask" } } as never } }, loose).join(" | ");
    expect(why).toMatch(/decide sozinho/);
    expect(why).toMatch(/publicação é pedida sozinha/);
    expect(why).toMatch(/ritmo é mais rápido/);
    expect(why).toMatch(/escopo de tipos/);
    expect(why).toMatch(/matriz de risco libera mais \(.*write-board/);
  });
  it("a exceção de modo do PRÓPRIO card viaja com ele: não conta como afrouxar", () => {
    const loose: TransferRegime = { ...strict, config: { ...strict.config, autonomy: { mode: "ultra" } as never } };
    expect(transferRegimeLoosening({ autonomyMode: "human" }, strict, loose)).toEqual([]);
  });
});

describe("planCardTransfer — mudança de um agente para um destino mais permissivo, e a entrada na Triagem", () => {
  const triaged = story("story-julgado", {
    storyType: "technical",
    status: "enriquecer",
    serves: "story-etiquetas",
    triageDecision: { verdict: "accept", reason: "serve o PRD", by: "triage-judge", at: "2026-05-01" },
  });
  const toCards = [galpaoStep, galpaoUser];
  it("forceEntry ⇒ o card entra pela Triagem do destino, com o motivo, e o veredito antigo vai para a trilha", () => {
    const p = planCardTransfer({
      card: triaged, fromBoard: "estufa", toBoard: "galpao", fromCards: [triaged], toConfig: { ...toConfigSame, autonomy: { mode: "ultra" } as never }, toCards,
      by: "agent", at: "2026-05-04T10:00:00.000Z", forceEntry: ["lá a publicação é pedida sozinha"],
    });
    expect(p.error).toBeUndefined();
    expect(p.toStatus).toBe("triage");
    expect(p.warnings.join(" ")).toMatch(/mais permissivo \(lá a publicação é pedida sozinha\)/);
    expect(p.card.triageDecision).toBeUndefined();
    expect(p.card.needsHumanReview).toBeUndefined(); // destino só-negócio: o juiz de lá julga
    expect(p.card.transfers?.at(-1)?.previousTriage).toEqual({ verdict: "accept", reason: "serve o PRD" });
  });
  it("em modo humano no destino, entrar na Triagem pede revisão humana", () => {
    const p = planCardTransfer({
      card: triaged, fromBoard: "estufa", toBoard: "galpao", fromCards: [triaged], toConfig: { ...toConfigSame, autonomy: { mode: "human" } as never }, toCards,
      by: "agent", at: "2026-05-04T10:00:00.000Z", forceEntry: ["x"],
    });
    expect(p.card.needsHumanReview).toBe(true);
    expect(p.card.triageDecision).toBeUndefined();
  });
  it("sem forceEntry (o operador, ou destino igual/mais estrito): mantém o passo e o veredito", () => {
    const p = planCardTransfer({
      card: triaged, fromBoard: "estufa", toBoard: "galpao", fromCards: [triaged], toConfig: toConfigSame, toCards,
      by: "human", at: "2026-05-04T10:00:00.000Z",
    });
    expect(p.toStatus).toBe("enriquecer");
    expect(p.card.triageDecision).toMatchObject({ verdict: "accept" });
  });
  it("entrar na Triagem por falta de âncora também zera o veredito (o juiz de lá julga de novo)", () => {
    const loose = story("story-sem-ancora", { storyType: "technical", status: "enriquecer", serves: "story-ver-mudas", triageDecision: { verdict: "accept", reason: "r", by: "j", at: "2026-05-01" } });
    const p = planCardTransfer({
      card: loose, fromBoard: "estufa", toBoard: "galpao", fromCards: [estufaStep, estufaUser, loose], toConfig: toConfigSame, toCards,
      by: "human", at: "2026-05-04T10:00:00.000Z",
    });
    expect(p.toStatus).toBe("triage");
    expect(p.card.triageDecision).toBeUndefined();
  });
});

describe("transferRegimeLoosening — os eixos do dono, do gasto, da auditoria e do copiloto", () => {
  const base: TransferRegime = { config: { autonomy: { mode: "ultra" } as never, release: { mode: "manual" } }, pace: "normal", admits: true };
  const withAut = (a: Record<string, unknown>, orch?: Record<string, unknown>): TransferRegime => ({ ...base, config: { ...base.config, autonomy: { mode: "ultra", ...a } as never, ...(orch ? { orchestrator: orch as never } : {}) } });
  it("uma classe do dono que existe aqui e não lá", () => {
    const from = withAut({ ownerClasses: [{ id: "money", label: "Dinheiro", description: "" }, { id: "brand", label: "Marca", description: "" }] });
    const to = withAut({ ownerClasses: [{ id: "money", label: "Dinheiro", description: "" }] });
    expect(transferRegimeLoosening({}, from, to).join(" ")).toMatch(/não são do dono: brand/);
    expect(transferRegimeLoosening({}, to, from)).toEqual([]);
  });
  it("teto de gasto maior (ou ausente) lá", () => {
    expect(transferRegimeLoosening({}, withAut({ budget: { cashMonthly: 50 } }), withAut({ budget: { cashMonthly: 80 } })).join(" ")).toMatch(/teto de gasto \(cash\) é maior/);
    expect(transferRegimeLoosening({}, withAut({ budget: { infraMonthly: 50 } }), withAut({})).join(" ")).toMatch(/teto de gasto \(infra\)/);
    expect(transferRegimeLoosening({}, withAut({ budget: { cashMonthly: 80 } }), withAut({ budget: { cashMonthly: 50 } }))).toEqual([]);
  });
  it("amostra de auditoria técnica menor lá", () => {
    expect(transferRegimeLoosening({}, withAut({ technicalAuditSampleRate: 0.5 }), withAut({ technicalAuditSampleRate: 0.1 })).join(" ")).toMatch(/auditoria técnica revê menos/);
    expect(transferRegimeLoosening({}, withAut({ technicalAuditSampleRate: 0.1 }), withAut({ technicalAuditSampleRate: 0.5 }))).toEqual([]);
  });
  it("copiloto mais solto lá", () => {
    expect(transferRegimeLoosening({}, withAut({}, { mode: "paired" }), withAut({}, { mode: "autonomous" })).join(" ")).toMatch(/copiloto age mais sozinho/);
    expect(transferRegimeLoosening({}, withAut({}, { mode: "autonomous" }), withAut({}, { mode: "off" }))).toEqual([]);
  });
});

describe("planCardTransfer — a entrada FORÇADA zera a evidência do pipeline", () => {
  const worked = story("story-feito", {
    storyType: "technical",
    status: "enriquecer",
    serves: "story-etiquetas",
    qaPassed: true,
    qaRanAt: "2026-05-01",
    qaCommit: "abc",
    qaEvidence: { suite: true, at: "2026-05-01T00:00:00Z" },
    reviewedAt: "2026-05-01",
    reviewCommit: "abc",
    techPlanReady: true,
    wireframeChosen: "opcao-b",
    tasks: [{ id: "t1", title: "a", done: true }, { id: "t2", title: "b", done: false }],
  });
  it("evidência zerada, retrato na trilha, marca de forçada; tasks voltam a não feitas", () => {
    const p = planCardTransfer({
      card: worked, fromBoard: "estufa", toBoard: "galpao", fromCards: [worked], toConfig: toConfigSame, toCards: [galpaoStep, galpaoUser],
      by: "agent", at: "2026-05-04T10:00:00.000Z", forceEntry: ["lá o sistema decide sozinho"],
    });
    expect(p.card).toMatchObject({ qaPassed: undefined, qaRanAt: null, qaCommit: null, qaEvidence: undefined, reviewedAt: null, reviewCommit: null, techPlanReady: undefined, wireframeChosen: null });
    expect(p.card.tasks.every((t) => !t.done)).toBe(true);
    const t = p.card.transfers?.at(-1);
    expect(t?.forced).toBe(true);
    expect(t?.previousEvidence).toEqual({ qaPassed: true, qaRanAt: "2026-05-01", qaCommit: "abc", hadQaEvidence: true, reviewedAt: "2026-05-01", reviewCommit: "abc", techPlanReady: true, wireframeChosen: "opcao-b", tasksDone: ["t1"] });
    // o card da mudança forçada espera o juiz de lá
    expect(heldByForcedTransfer(p.card, toConfigSame)).toBe(true);
    expect(heldByForcedTransfer({ ...p.card, triageDecision: { verdict: "accept", reason: "r", by: "j", at: "d" } }, toConfigSame)).toBe(false);
  });
  it("sem forçar (o operador): a evidência fica e não há marca", () => {
    const p = planCardTransfer({ card: worked, fromBoard: "estufa", toBoard: "galpao", fromCards: [worked], toConfig: toConfigSame, toCards: [galpaoStep, galpaoUser], by: "human", at: "2026-05-04T10:00:00.000Z" });
    expect(p.card.qaPassed).toBe(true);
    expect(p.card.transfers?.at(-1)?.forced).toBeUndefined();
    expect(heldByForcedTransfer(p.card, toConfigSame)).toBe(false);
  });
});
