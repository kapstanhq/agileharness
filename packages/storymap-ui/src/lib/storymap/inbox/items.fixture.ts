// As FIXTURES do Inbox — um item de cada kind, na forma em que o coletor o entrega, o card em que ele mora, e os quatro
// modos de board (humano / só-negócio, com e sem o Jido). Compartilhadas pelos testes do modelo (decision.test.ts) e do
// contrato (invariants.test.ts): as propriedades do contrato valem sobre EXATAMENTE os mesmos itens que o modelo testa.

import type { BoardConfig, Card, StatusDef } from "../types";
import type { CockpitItem, CockpitItemKind } from "../demands";
import type { DecisionCtx } from "./decision";

// ── O board de teste: a pipeline canônica (os passos do _base, com os gates e efeitos que importam aqui) ─────────
export const st = (id: string, name: string, over: Partial<StatusDef> = {}): StatusDef => ({ id, name, ...over }) as StatusDef;
export const STATUSES: StatusDef[] = [
  st("triage", "Triagem", { staging: true }),
  st("enriquecer", "Especificar", { autorun: true, trigger: "harness-enrich" }),
  st("interview", "Entrevista", { autorun: true, trigger: "harness-interview" }),
  st("com-design", "Aprovar design", { autorun: false, gate: "hasWireframe" }),
  st("ready", "Pronto p/ dev", { autorun: false }),
  st("desenvolver", "Desenvolver", { autorun: false, trigger: "harness-do" }),
  st("revisao", "Aprovar entrega", { autorun: false, laneStep: true }),
  st("merge", "Integrar", { autorun: true, laneStep: true }),
  st("stage", "Homologar", { autorun: true, laneStep: true }),
  st("release", "Liberar", { autorun: false, laneStep: true }),
  st("deploy", "Publicar", { autorun: false, onEnter: "promote-and-deploy", laneStep: true }),
  st("concluida", "No ar", { terminal: true }),
  st("refinar", "Refinar", { autorun: true, gate: "hasRefineBrief", trigger: "harness-refine", hidden: true }),
  st("descontinuar", "Descontinuar", { autorun: true, trigger: "harness-retire", hidden: true }),
  st("arquivados", "Arquivados", { terminal: true }),
  st("cancelado", "Cancelado", { terminal: true }),
];
export const HUMAN: BoardConfig = { id: "b1", name: "Board", statuses: STATUSES } as BoardConfig;
export const ULTRA: BoardConfig = { ...HUMAN, autonomy: { mode: "ultra" } } as BoardConfig;
export const ULTRA_JIDO: BoardConfig = { ...ULTRA, orchestrator: { mode: "autonomous", riskMatrix: { deploy: "auto" } } } as BoardConfig;
export const HUMAN_JIDO: BoardConfig = { ...HUMAN, orchestrator: { mode: "autonomous", riskMatrix: { deploy: "never" } } } as BoardConfig;

export const NOW = Date.parse("2026-09-28T20:00:00Z");
const BASE_CARD = {
  id: "c1",
  type: "story",
  title: "Lista de desejos compartilhada",
  storyType: "user",
  status: "release",
  parent: "step-1",
  release: null,
  personas: [],
  systems: [],
  links: [],
  narrative: { role: "", want: "", soThat: "" },
  acceptance: [],
  tasks: [],
  findings: [],
  order: 10,
  created: "2026-09-20",
  updated: null,
  body: "",
} as unknown as Card;
export const mkCard = (over: Partial<Card> = {}): Card => ({ ...BASE_CARD, ...over });
export const mkItem = (kind: CockpitItemKind, over: Record<string, unknown> = {}): CockpitItem =>
  ({ id: `c1:${kind}`, boardId: "b1", cardId: "c1", cardTitle: "Lista de desejos compartilhada", status: "release", lane: "travado", severity: "high", since: "2026-09-28T17:00:00Z", kind, ...over }) as CockpitItem;

/** Um item de cada kind, na forma em que o coletor o entrega — e o card em que ele mora. */
export const FIXTURES: Record<CockpitItemKind, { item: CockpitItem; card: Card }> = {
  question: { item: mkItem("question", { id: "c1:q:q1", lane: "pergunta", status: "desenvolver", questionId: "q1", prompt: "Qual cor usar no botão principal?", options: [], mode: "single" }), card: mkCard({ status: "desenvolver" }) },
  blocker: { item: mkItem("blocker", { id: "c1:b:f1", status: "desenvolver", findingId: "f1", title: "Falta tratar o caso vazio" }), card: mkCard({ status: "desenvolver" }) },
  finding: { item: mkItem("finding", { id: "c1:f:f2", lane: "pergunta", severity: "medium", findingId: "f2", title: "Texto do botão pode ser mais claro", findingSeverity: "medium" }), card: mkCard() },
  "deploy-failed": { item: mkItem("deploy-failed", { findingId: "deploy-failure", title: "A publicação falhou" }), card: mkCard({ status: "release" }) },
  gate: { item: mkItem("gate", { id: "c1:approval:release", lane: "aprovar", severity: "medium", gateLabel: "Liberar" }), card: mkCard({ status: "release" }) },
  approval: { item: mkItem("approval", { id: "apr:a1", lane: "aprovar", status: null, gateLabel: "Um agente pede", tool: "move_card", args: JSON.stringify({ cardId: "c1", status: "revisao" }), riskClass: "write-board", expiresAt: "2026-09-29T20:00:00Z" }), card: mkCard() },
  review: { item: mkItem("review", { id: "c1:review", lane: "pergunta", severity: "medium", status: "triage" }), card: mkCard({ status: "triage", needsHumanReview: true }) },
  stuck: { item: mkItem("stuck", { id: "c1:stuck:exit", status: "enriquecer", trigger: "harness-enrich", outcome: "exit", reason: "exit" }), card: mkCard({ status: "enriquecer" }) },
  conflict: { item: mkItem("conflict", { id: "c1:conflict:r1", runId: "r1", conflictKind: "merge-conflict" }), card: mkCard({ status: "merge" }) },
  proposal: {
    item: mkItem("proposal", { id: "c1:proposal", lane: "aprovar", status: "capturando", summary: "Três ideias sobre convites", items: [{ tempId: "t1", type: "story", title: "Convidar" }], rounds: 0 }),
    card: mkCard({ status: "capturando", capture: true }),
  },
  design: {
    item: mkItem("design", { id: "c1:design", lane: "aprovar", status: "com-design", journey: null, options: [], artifacts: [{ id: "a1", kind: "screen" }], feedback: [], chosenId: "a1" }),
    card: mkCard({ status: "com-design", wireframeChosen: "a1" }),
  },
  governance: {
    item: mkItem("governance", { id: "gov:d1", lane: "aprovar", cardId: "", status: null, draftId: "d1", changes: [{ artifact: "prd", field: "glossario", before: null, after: "x" }], reason: "Duas seções novas", conflicts: [], since: "2026-09-23" }),
    card: mkCard(),
  },
  "deploy-unsettled": { item: mkItem("deploy-unsettled", { status: "deploy", deployFiredAt: "2026-09-28T18:00:00Z", held: { title: "Não provou" } }), card: mkCard({ status: "deploy", deployFiredAt: "2026-09-28T18:00:00Z" }) },
  "release-aging": { item: mkItem("release-aging", { stagedAt: "2026-09-20", ageDays: 8 }), card: mkCard({ status: "release", stagedAt: "2026-09-20" }) },
  "merge-failed": { item: mkItem("merge-failed", { id: "c1:merge-failed:r1", runId: "r1", branch: "run/r1", failureReason: "boom" }), card: mkCard({ status: "merge" }) },
  "proxy-audit": { item: mkItem("proxy-audit", { id: "c1:pa:q1", lane: "aprovar", questionId: "q1", prompt: "Qual cor?", answer: "Verde", assumptions: "o guia", confidence: 0.9 }), card: mkCard() },
  "delivery-audit": { item: mkItem("delivery-audit", { id: "c1:da", lane: "aprovar", status: "concluida", sampledAt: "2026-09-27", before: "sem convite", after: "com convite" }), card: mkCard({ status: "concluida" }) },
  "publish-approval": {
    item: mkItem("publish-approval", {
      id: "plan-ask:loja:owner:money",
      cardId: "",
      cardTitle: "Publicação do board",
      status: null,
      lane: "aprovar",
      causeKey: "loja:owner:money",
      pkg: "loja",
      ownerClass: "money",
      approvals: [{ hash: `sha256:${"b".repeat(64)}`, files: ["src/cobranca/precos.ts"], units: ["face:loja"], rules: ["codigo-de-cobranca"] }],
      rerequesting: false,
      stale: false,
    }),
    card: mkCard(),
  },
  "meter-stalled": { item: mkItem("meter-stalled", { id: "host:meter-stalled:1", cardId: "", status: null, stalledSince: NOW - 3_600_000, detectedAt: NOW, detail: "sem leitura" }), card: mkCard() },
  "data-deletion": {
    item: mkItem("data-deletion", { id: "c1:data-deletion", lane: "aprovar", status: "descontinuar", brief: "remover o convite", scope: [], target: null }),
    card: mkCard({ status: "descontinuar", mode: "retire", retirement: { brief: "remover o convite", disposition: "descontinuado", level: "excluir-tudo", scope: [], target: null, dataDeletionApproved: false } as unknown as Card["retirement"] }),
  },
  "effect-failed": { item: mkItem("effect-failed", { id: "c1:effect-failed", status: "deploy", findingId: "entry-effect-failed", title: "A publicação não aconteceu", effect: "promote-and-deploy", stepName: "Publicar" }), card: mkCard({ status: "deploy" }) },
  stalled: {
    item: mkItem("stalled", {
      id: "c1:stalled",
      status: "deploy",
      findingId: "card-stalled",
      findingTitle: "Parado em «Publicar» sem ninguém cuidando",
      findingDetail: "Parado desde ontem. O sistema refez o passo uma vez e abriu o conserto story-fix1.",
      stepName: "Publicar",
      retryable: true,
      effect: "promote-and-deploy",
    }),
    card: mkCard({ status: "deploy" }),
  },
  "locked-exec": {
    item: mkItem("locked-exec", {
      id: "lx:lx-00000000a1",
      lane: "aprovar",
      status: "desenvolver",
      lockedExecId: "lx-00000000a1",
      hash: "a".repeat(64),
      execStatus: "pending",
      summary: "Troca a chave de API do cofre por uma nova e guarda a anterior por um ciclo.",
      why: null,
      command: "cofre-cli rotate --key=api",
      program: "/opt/cofre/bin/cofre-cli",
      undoCommand: "cofre-cli rollback --key=api",
      undoProgram: "/opt/cofre/bin/cofre-cli",
      noUndoPlan: null,
      preflight: [],
      verify: [{ label: "a chave nova está ativa", command: "cofre-cli verifica --key=api", program: "/opt/cofre/bin/cofre-cli", criterion: "passa se terminar com código 0" }],
      timeoutSec: 300,
      proposedBy: "mcp:write(TESTE)",
      proposedAt: "2026-09-28T17:00:00Z",
      lockRule: "vault-access",
      expiresAt: null,
      finishedAt: null,
      undoing: false,
      autoUndone: false,
      error: null,
      rejectReason: null,
      steps: [],
    }),
    card: mkCard({ status: "desenvolver" }),
  },
  // fase 3 — as alavancas da Esteira e os avisos do host (sem card: `cardId` "")
  "publish-held": {
    item: mkItem("publish-held", {
      id: "pub:pub-ex9001",
      cardId: "",
      cardTitle: "Publicação do board",
      status: null,
      lane: "aprovar",
      requestId: "pub-ex9001",
      reason: "trabalho vivo nos mesmos arquivos — sessão s-ex9001, arquivos src/catalogo/busca.ts",
      heldCount: 14,
      nextAttemptAt: "2026-09-28T20:05:00Z",
      blocked: true,
    }),
    card: mkCard(),
  },
  "stage-idle": { item: mkItem("stage-idle", { id: "stage:b1", cardId: "", cardTitle: "Entregas prontas", status: null, lane: "aprovar", severity: "medium", pending: 3, hours: 30, canPublish: true }), card: mkCard() },
  "capacity-latch": {
    item: mkItem("capacity-latch", { id: "host:latch:1", cardId: "", cardTitle: "Cota da conta", status: null, level: "soft", reason: "janela de 7 dias em 93% (trava em 92%)", trippedBy: "auto:week", halt: false }),
    card: mkCard(),
  },
  "host-health": {
    item: mkItem("host-health", { id: "host:health:S1", cardId: "", cardTitle: "Saúde da ferramenta", status: null, signals: [{ id: "S1", label: "Cards parados", detail: "4 cards parados há mais de um dia" }], at: "2026-09-28T19:55:00Z" }),
    card: mkCard(),
  },
  sentinel: {
    item: mkItem("sentinel", { id: "sentinel:stalled-run:b1:x", cardId: "c1", cardTitle: "Livro de exemplo", status: null, causeKey: "stalled-run:b1:x", causeId: "stalled-run-abc12", diagnosis: "A execução do card parou sem saída; a cópia de trabalho está limpa.", cardIds: ["c1"], tried: false }),
    card: mkCard(),
  },
  "push-off": { item: mkItem("push-off", { id: "host:push-off", cardId: "", cardTitle: "Aviso no celular", status: null, lane: "aprovar", severity: "low", since: null }), card: mkCard() },
};

export const KINDS = Object.keys(FIXTURES) as CockpitItemKind[];
export const ctx = (config: BoardConfig, card: Card | undefined, now = NOW): DecisionCtx => ({ config, card, now, tier: config === ULTRA_JIDO || config === HUMAN_JIDO ? (config === ULTRA_JIDO ? "autonomo" : "copiloto") : "chat" });

/** Toda variante que as tabelas de kind produzem — os dois modos, com e sem o Jido. */
export const MODES: Array<[string, BoardConfig]> = [
  ["humano", HUMAN],
  ["só-negócio", ULTRA],
  ["só-negócio + Jido", ULTRA_JIDO],
  ["humano + Jido", HUMAN_JIDO],
];
