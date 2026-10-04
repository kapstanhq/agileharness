// O REGISTRO DE DECISÕES DO SISTEMA — o que o sistema decidiu em nome do dono (política só-negócio). PURA (zero IO; o
// ledger em disco mora em runner/decision-log.ts, o «Desfazer» em runner/decision-undo.ts).
//
// Em só-negócio o sistema decide sozinho tudo o que não é negócio. O preço disso é a PROVA e o REGISTRO: cada decisão
// tomada em nome do dono entra num ledger durável e só-de-acréscimo — quem decidiu (qual agente), o quê, por quê,
// quando, o card, e um "Desfazer" quando a decisão é reversível. Os produtores: o juiz da triagem (aceitar,
// descartar, juntar), o proxy (respostas e escolhas de tela, com as alternativas), a entrega que chegou ao ar sem a
// aprovação do dono, a publicação, o dilema registrado e o card de conserto do Jido. Este módulo dá:
//   • os construtores das entradas (um por produtor — a forma não diverge entre as portas);
//   • `followUpItems`, a projeção pura para a seção «Acompanhar» do Inbox (a onda 2 desenha; aqui é a lista);
//   • `undoRefusal`, as pré-condições de cada «Desfazer» — a mesma régua do botão e do servidor;
//   • `applyUndoToCard`, o que cada «Desfazer» faz no card (o servidor aplica sob o lock, no card fresco).

import { deliveredStatusIds } from "./delivered";
import { DELIVERY_AUDIT_REOPEN_DEFAULT } from "./delivery-audit";
import { hasStartedConstruction } from "./card-opt-ins";
import { applyReopen } from "./reopen";
import { upsertFinding } from "./runner/findings";
import { revertRecordedDecision } from "./recorded-decisions";
import type { BoardConfig, Card, Finding, RecordedDecision } from "./types";

/** O que o sistema decidiu. `undo` é a entrada que DESFAZ outra (agente humano, `undoOf`). */
export type SystemDecisionKind =
  | "triage-accept"
  | "triage-discard"
  | "triage-duplicate"
  | "proxy-answer"
  | "ui-choice"
  | "delivery-skip"
  | "publish"
  | "dilemma"
  | "recovery-fix-card"
  /** política só-negócio — a revisão de segurança independente que produziu a prova que o deploy pediu. */
  | "security-review"
  /** um aumento de custo projetado DENTRO dos tetos do dono, que o sistema aceitou. */
  | "cost-within-ceiling"
  /** o auditor independente reviu uma entrega técnica sorteada (sem problema, ou um card de conserto). */
  | "technical-audit"
  /** paradas por recurso, fatia 1 — o vigia (runner/stall-watch.ts) refez UMA vez o passo de um card parado sem ninguém. */
  | "stall-retry"
  /** paradas por recurso, fatia 1 — o vigia abriu o card de conserto de um card que seguiu travado depois de refeito. */
  | "stall-fix-card"
  /** paradas por recurso, fatia 3 — o sistema aprovou o aumento do teto de gasto de IA de um card (até +30%, cota no ritmo). */
  | "budget-raise"
  /** paradas por recurso, fatia 4 — o sistema abriu uma vaga extra de condutor (máquina e cota com folga, card pequeno). */
  | "extra-slot"
  /** WP5-F1 — um card SUMIU do disco (fora da lixeira) com a fila do condutor esperando por ele: registro + alerta. */
  | "card-missing"
  /** uma regra do operador autorizou o ciclo extra de verificação de um card (o 3º, uma vez, dentro do teto). */
  | "extra-cycle"
  /** WP5-F2 — o sistema pediu a um condutor que ESTACIONASSE (quieto com fila esperando vaga, erro de transporte que não
   *  passou, ou espera do dono): o trabalho fica guardado e a vaga volta para a fila. Desfazer = reabrir o condutor já. */
  | "conductor-park"
  /** política só-negócio — com as provas produzidas, o produtor da prova republicou o card (o «Re-publicar» de sempre). */
  | "proof-republish"
  /** um card mudou de board (card-transfer.ts) — registrado nos DOIS boards: o que saiu e o que recebeu. */
  | "card-transfer"
  /** o juiz da triagem mandou um card ao board a que ele pertence (o roteamento, triage/judge.ts). */
  | "triage-route"
  | "undo";

/** Como desfazer, quando dá. Cada variante é UMA ação com pré-condição (undoRefusal). */
export type UndoHandle =
  /** o card volta à Triagem — agora para o dono (o juiz não re-julga por cima do veto). */
  | { kind: "return-to-triage"; cardId: string; from: string }
  /** a pergunta que o proxy respondeu volta aberta para o dono. */
  | { kind: "reopen-question"; cardId: string; questionId: string }
  /** o que foi para a lixeira volta. */
  | { kind: "restore-trash"; trashKind: "card" | "persona" | "system"; id: string }
  /** a entrega que chegou ao ar sem o dono aprovar volta por refino, com o motivo dele. */
  | { kind: "reopen-card"; cardId: string; deliveredIn: string }
  /** a publicação é revertida para o sha anterior — um card de reversão que o pipeline constrói e publica. */
  | { kind: "republish-previous"; cardId: string; sha: string; previousSha: string }
  /** a decisão registrada de um dilema é desfeita (a razão do dono vira um achado aberto). */
  | { kind: "revert-decision"; cardId: string; decisionId: string }
  /** o card que o sistema abriu (o de conserto) é descartado. */
  | { kind: "discard-card"; cardId: string }
  /** WP5-F2 — o condutor estacionado volta já: o card entra na FRENTE da fila do condutor (IO da ação, não do card). */
  | { kind: "resume-conductor"; cardId: string };

export interface SystemDecision {
  v: 1;
  id: string;
  /** ISO — quando. */
  at: string;
  board: string;
  cardId?: string;
  /** quem decidiu: `triage-judge`, `proxy`, `harness-conductor`, `jido`, `system`… — `human` só no desfazer. */
  agent: string;
  kind: SystemDecisionKind;
  /** o quê, numa frase para o dono. */
  what: string;
  /** por quê — o porquê que o agente registrou (o PRD, as premissas). */
  why: string;
  /** as opções que existiam (escolha de tela, dilema). */
  alternatives?: string[];
  undo?: UndoHandle;
  /** numa entrada `undo`: a decisão que ela desfez. */
  undoOf?: string;
}

type EntryOpts = { at: string; id: string };

// ── os construtores, um por produtor ─────────────────────────────────────────────────────────────────────

const VERDICT_KIND = { accept: "triage-accept", discard: "triage-discard", duplicate: "triage-duplicate" } as const;
const VERDICT_WHAT = { accept: "Aceitou na triagem", discard: "Descartou na triagem", duplicate: "Juntou como duplicata" } as const;

/** O juiz da triagem decidiu `card` (o card JÁ com o veredito e o status novo). Levar ao dono / esperar não é decisão
 *  em nome dele ⇒ null. PURA. */
export function triageJudgeEntry(board: string, card: Card, opts: EntryOpts): SystemDecision | null {
  const d = card.triageDecision;
  if (!d || (d.verdict !== "accept" && d.verdict !== "discard" && d.verdict !== "duplicate")) return null;
  return {
    v: 1,
    id: opts.id,
    at: opts.at,
    board,
    cardId: card.id,
    agent: d.by || "triage-judge",
    kind: VERDICT_KIND[d.verdict],
    what: `${VERDICT_WHAT[d.verdict]}: «${card.title}»${d.duplicateOf ? ` (duplicata de ${d.duplicateOf})` : ""}`,
    why: d.prdAnchor ? `${d.reason} — PRD: ${d.prdAnchor}` : d.reason,
    ...(card.status ? { undo: { kind: "return-to-triage" as const, cardId: card.id, from: card.status } } : {}),
  };
}

/** As respostas que o proxy APLICOU em `card` (ids em `applied`). A escolha de tela guarda as alternativas. PURA. */
export function proxyAnswerEntries(board: string, card: Card, applied: readonly string[], opts: { at: string; idOf: (questionId: string) => string }): SystemDecision[] {
  const out: SystemDecision[] = [];
  for (const q of card.questions ?? []) {
    if (!applied.includes(q.id) || q.answeredBy !== "proxy") continue;
    const labels = (q.options ?? []).map((o) => o.label);
    const picked = (q.selectedOptionIds ?? []).map((id) => q.options?.find((o) => o.id === id)?.label).filter((x): x is string => !!x);
    const answer = [picked.join(" + "), q.answer].filter(Boolean).join(" — ");
    const ui = (q.category ?? q.classified?.category) === "ui-choice";
    out.push({
      v: 1,
      id: opts.idOf(q.id),
      at: opts.at,
      board,
      cardId: card.id,
      agent: "proxy",
      kind: ui ? "ui-choice" : "proxy-answer",
      what: `${ui ? "Escolheu a tela" : "Respondeu"} «${q.text}»: ${answer || "(sem texto)"}`,
      why: q.proxy?.assumptions ?? "",
      ...(labels.length ? { alternatives: labels } : {}),
      undo: { kind: "reopen-question", cardId: card.id, questionId: q.id },
    });
  }
  return out;
}

/** Um dilema registrado (recorded-decisions.ts). PURA. */
export function dilemmaEntry(board: string, cardId: string, d: RecordedDecision, opts: EntryOpts): SystemDecision {
  return {
    v: 1,
    id: opts.id,
    at: opts.at,
    board,
    cardId,
    agent: d.by,
    kind: "dilemma",
    what: `${d.what}: escolheu «${d.choice}»`,
    why: d.prdAnchor ? `${d.why} — PRD: ${d.prdAnchor}` : d.why,
    alternatives: [...d.options],
    undo: { kind: "revert-decision", cardId, decisionId: d.id },
  };
}

/** O card de conserto que o Jido abriu ao esgotar o limite de um travamento (runner/business-recovery.ts). PURA. */
export function recoveryFixCardEntry(
  board: string,
  input: { itemId: string; cardId: string; cardTitle: string; fixCardId: string },
  opts: EntryOpts,
): SystemDecision {
  return {
    v: 1,
    id: opts.id,
    at: opts.at,
    board,
    cardId: input.fixCardId,
    agent: "jido",
    kind: "recovery-fix-card",
    what: `Abriu um card de conserto para «${input.cardTitle}» (${input.itemId})`,
    why: "o travamento técnico repetiu até o limite de tentativas — o conserto vira trabalho, sem parar o dono",
    undo: { kind: "discard-card", cardId: input.fixCardId },
  };
}

/** Uma entrega que chegou ao ar sem o dono aprovar (o condutor pulou «Aprovar entrega» com a prova). PURA. */
export function deliverySkipEntry(board: string, card: Card, opts: EntryOpts): SystemDecision {
  return {
    v: 1,
    id: opts.id,
    at: opts.at,
    board,
    cardId: card.id,
    agent: "verifier",
    kind: "delivery-skip",
    what: `Entregou «${card.title}» sem parar em «Aprovar entrega»`,
    why: "o verificador independente aprovou pela prova; uma amostra volta para você",
    ...(card.status ? { undo: { kind: "reopen-card" as const, cardId: card.id, deliveredIn: card.status } } : {}),
  };
}

/** Uma publicação que o sistema fez. Sem o sha anterior, não há para onde voltar ⇒ sem «Desfazer». PURA. */
export function publishEntry(board: string, card: Card, input: { sha: string; previousSha?: string | null }, opts: EntryOpts): SystemDecision {
  return {
    v: 1,
    id: opts.id,
    at: opts.at,
    board,
    cardId: card.id,
    agent: "system",
    kind: "publish",
    what: `Publicou «${card.title}» (${input.sha.slice(0, 7)})`,
    why: "a publicação automática provou o código no ar (canário e reversão automática)",
    ...(input.previousSha ? { undo: { kind: "republish-previous" as const, cardId: card.id, sha: input.sha, previousSha: input.previousSha } } : {}),
  };
}

/**
 * Um card mudou de board (card-transfer.ts): DUAS entradas, uma em cada board — o de origem diz para onde ele foi (sem
 * `cardId`: o card não está mais lá), o de destino diz de onde veio. `agent`: `human` (o dono pela tela), `agent` (um
 * agente pela tool) ou `triage-judge` (o roteamento da triagem). PURA.
 */
export function cardTransferEntries(
  input: { fromBoard: string; fromName: string; toBoard: string; toName: string; cardId: string; title: string; agent: string; reason?: string | null; warnings?: readonly string[] },
  opts: { at: string; idOf: (side: "from" | "to") => string },
): [SystemDecision, SystemDecision] {
  const kind: SystemDecisionKind = input.agent === "triage-judge" ? "triage-route" : "card-transfer";
  const why = [input.reason?.trim() || (kind === "triage-route" ? "o card pertence a outro board" : "sem motivo informado"), ...(input.warnings ?? [])].join(" · ");
  return [
    { v: 1, id: opts.idOf("from"), at: opts.at, board: input.fromBoard, agent: input.agent, kind, what: `Mudou «${input.title}» para o board «${input.toName}»`, why },
    { v: 1, id: opts.idOf("to"), at: opts.at, board: input.toBoard, cardId: input.cardId, agent: input.agent, kind, what: `Recebeu «${input.title}» do board «${input.fromName}»`, why },
  ];
}

// ── a projeção para o «Acompanhar» ───────────────────────────────────────────────────────────────────────

/** Quem decidiu, em português, para o dono. PURA. */
export function agentLabel(agent: string): string {
  const known: Record<string, string> = {
    "triage-judge": "Juiz da triagem",
    proxy: "Procurador",
    // o glossário único do Inbox: o dono lê «agente», nunca «condutor» (o nome de dentro de quem conduz um card)
    "harness-conductor": "Agente",
    jido: "Jido",
    verifier: "Verificador",
    // o produtor da prova de deploy (runner/deploy-proof-producer.ts `PRODUCER_AGENT`): republica e abre consertos
    "deploy-proof": "Produtor da prova de deploy",
    // quem mudou um card de board por uma tool (card-transfer.ts) — um agente, sem o nível do token no texto do dono
    agent: "Agente",
    system: "Sistema",
    human: "Você",
  };
  return known[agent] ?? agent;
}

/** O que o «Desfazer» de uma decisão faz, numa frase para o dono (o rótulo do botão explica o efeito). PURA. */
export function undoLabel(u: UndoHandle): string {
  switch (u.kind) {
    case "return-to-triage":
      return "Desfazer: voltar à Triagem para você decidir";
    case "reopen-question":
      return "Desfazer: reabrir a pergunta para você responder";
    case "restore-trash":
      return "Desfazer: restaurar da lixeira";
    case "reopen-card":
      return "Desfazer: reabrir a entrega (diga o motivo)";
    case "republish-previous":
      return "Desfazer: reverter a publicação";
    case "revert-decision":
      return "Desfazer esta decisão";
    case "discard-card":
      return "Desfazer: descartar este card";
    case "resume-conductor":
      return "Desfazer: reabrir o condutor agora";
  }
}

export interface FollowUpItem extends SystemDecision {
  /** ainda dá para desfazer (tem handle e ninguém desfez). A pré-condição do card é checada no clique. */
  undoable: boolean;
  /** quando o dono desfez, se desfez. */
  undoneAt?: string;
}

/** As decisões do board (mais novas primeiro, desde `since`), sem as entradas de desfazer, com o que ainda pode ser
 *  desfeito. PURA. */
export function followUpItems(entries: readonly SystemDecision[], opts: { board: string; since?: string }): FollowUpItem[] {
  const undoneAt = new Map<string, string>();
  for (const e of entries) if (e.kind === "undo" && e.undoOf && e.board === opts.board) undoneAt.set(e.undoOf, e.at);
  return entries
    .filter((e) => e.board === opts.board && e.kind !== "undo" && (!opts.since || e.at >= opts.since))
    .map((e) => ({ ...e, undoable: !!e.undo && !undoneAt.has(e.id), ...(undoneAt.has(e.id) ? { undoneAt: undoneAt.get(e.id) } : {}) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ── o «Desfazer» ─────────────────────────────────────────────────────────────────────────────────────────

/** O que a pré-condição precisa ver (o card FRESCO, o board, o motivo do dono). */
export interface UndoContext {
  config: BoardConfig;
  card?: Card | null;
  undone?: boolean;
  note?: string | null;
}

/** Por que este «Desfazer» não pode rodar agora — ou null. A MESMA régua do botão e do servidor. PURA. */
export function undoRefusal(entry: SystemDecision, ctx: UndoContext): string | null {
  const u = entry.undo;
  if (!u) return "esta decisão não tem como desfazer";
  if (ctx.undone) return "esta decisão já foi desfeita";
  if (u.kind === "restore-trash") return null; // a restauração tem a própria recusa (o manifesto sumiu, expirou)
  const card = ctx.card;
  if (!card) return `o card ${"cardId" in u ? u.cardId : ""} não existe mais neste board`;
  const where = ctx.config.statuses.find((s) => s.id === card.status)?.name ?? card.status ?? "—";
  switch (u.kind) {
    case "return-to-triage":
      if (!ctx.config.statuses.some((s) => s.staging)) return "o board não tem Triagem para onde voltar";
      return card.status === u.from ? null : `o card já andou depois da decisão (está em «${where}») — desfazer agora atropelaria o trabalho`;
    case "reopen-question": {
      const q = card.questions?.find((x) => x.id === u.questionId);
      // o proxy (uma resposta em nome do dono) e o SISTEMA (a aprovação de teto pela regra, card-budget.ts) são os dois
      // que respondem sozinhos; uma resposta de gente não se desfaz por aqui.
      return q && q.status === "answered" && (q.answeredBy === "proxy" || q.answeredBy === "system") ? null : "a pergunta não está respondida pelo sistema (alguém já mexeu nela)";
    }
    case "reopen-card":
      if (!ctx.note?.trim()) return "diga o motivo: o que está errado nesta entrega (o refino parte dele)";
      if (!ctx.config.statuses.some((s) => s.id === DELIVERY_AUDIT_REOPEN_DEFAULT)) return `o board não tem o passo «${DELIVERY_AUDIT_REOPEN_DEFAULT}» para reabrir`;
      return card.status && deliveredStatusIds(ctx.config).has(card.status) ? null : `o card já saiu do ar (está em «${where}»)`;
    case "republish-previous":
      return u.previousSha ? null : "não há publicação anterior para onde voltar";
    case "revert-decision": {
      const d = card.decisions?.find((x) => x.id === u.decisionId);
      if (!d) return "a decisão registrada não existe mais no card";
      return d.reverted ? "esta decisão já foi desfeita" : null;
    }
    case "discard-card":
      if (!ctx.config.statuses.some((s) => s.id === DISCARD_STATUS)) return `o board não tem o passo «${DISCARD_STATUS}»`;
      return hasStartedConstruction(card, ctx.config) ? `a construção do card já começou (está em «${where}»)` : null;
    case "resume-conductor":
      if (card.routing?.driver !== "conductor") return "o card não está mais com o condutor (alguém o devolveu às colunas)";
      return ctx.config.statuses.find((s) => s.id === card.status)?.terminal ? `o card já terminou (está em «${where}»)` : null;
  }
}

/** Onde o card de conserto desfeito vai (o mesmo terminal do descarte da triagem). */
const DISCARD_STATUS = "cancelado";

const undoFinding = (id: string, title: string, detail: string): Finding => ({ id, lens: "general", severity: "high", status: "open", title, detail });

/**
 * O que um «Desfazer» faz NO CARD (as variantes que mexem no card; lixeira e reversão de publicação são IO da ação).
 * Chame {@link undoRefusal} antes, sobre o mesmo card. PURA.
 */
export function applyUndoToCard(
  u: Exclude<UndoHandle, { kind: "restore-trash" } | { kind: "republish-previous" } | { kind: "resume-conductor" }>,
  card: Card,
  config: Pick<BoardConfig, "statuses">,
  opts: { today: string; note?: string | null },
): Card {
  const note = opts.note?.trim() ?? "";
  switch (u.kind) {
    case "return-to-triage": {
      const staging = config.statuses.find((s) => s.staging)?.id ?? card.status;
      return {
        ...card,
        status: staging,
        needsHumanReview: true,
        // o veto do dono: o card é DELE agora — `hold` impede o juiz de re-julgar por cima do desfazer.
        triageDecision: { verdict: "hold", reason: `você desfez a decisão do sistema${note ? `: ${note}` : ""}`, by: "human", at: opts.today },
      };
    }
    case "reopen-question": {
      const questions = (card.questions ?? []).map((q) => {
        if (q.id !== u.questionId) return q;
        const who = q.answeredBy === "system" ? "do sistema" : "do proxy";
        const history = `[resposta ${who} desfeita pelo dono em ${opts.today}] ${q.answer ?? ""}`.trim();
        const { answer: _a, answeredAt: _t, answeredBy: _b, selectedOptionIds: _s, ...rest } = q;
        return {
          ...rest,
          status: "open" as const,
          context: [q.context, history, q.proxy ? `Premissas do proxy: ${q.proxy.assumptions}` : "", note ? `Motivo do dono: ${note}` : ""].filter(Boolean).join("\n"),
          // `reopened` é final: esta pergunta nunca mais vai ao proxy (autonomy.ts proxyRefusal) — e, numa pergunta de
          // teto, o sistema também não a aprova de novo (card-budget.ts lê este carimbo).
          // Uma resposta SEM registro de proxy (a aprovação do sistema) ganha um com premissa não vazia: o leitor do
          // card descarta um registro sem premissas (repo.ts coerceProxyAnswer), e o carimbo sumiria na primeira leitura.
          proxy: { ...(q.proxy ?? { assumptions: `resposta ${who}, sem premissas registradas`, confidence: 0 }), auditedAt: opts.today, auditOutcome: "reopened" as const },
        };
      });
      return { ...card, questions };
    }
    case "reopen-card": {
      const reopened = applyReopen(card, {
        mode: "refine",
        refinement: { brief: `Entrega desfeita pelo dono: ${note}`, kinds: ["functionality"], target: null, screenshot: null, openedAt: opts.today },
      });
      return {
        ...reopened,
        status: DELIVERY_AUDIT_REOPEN_DEFAULT,
        reopenPending: true,
        findings: upsertFinding(card.findings ?? [], undoFinding("owner-undo-delivery", "Entrega desfeita pelo dono", note)),
      };
    }
    case "revert-decision": {
      const d = card.decisions?.find((x) => x.id === u.decisionId);
      const decisions = revertRecordedDecision(card.decisions ?? [], u.decisionId, { by: "human", at: opts.today, note });
      const detail = [`Decisão: ${d?.what ?? u.decisionId} (escolhido: ${d?.choice ?? "?"})`, d ? `Como desfazer: ${d.undo}` : "", note ? `Motivo do dono: ${note}` : ""]
        .filter(Boolean)
        .join("\n");
      return { ...card, decisions, findings: upsertFinding(card.findings ?? [], undoFinding(`owner-undo-${u.decisionId}`, "Decisão registrada desfeita pelo dono", detail)) };
    }
    case "discard-card":
      return { ...card, status: DISCARD_STATUS, needsHumanReview: undefined };
  }
}
