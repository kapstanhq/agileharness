// A ATIVIDADE DOS AGENTES na 2ª barra do Kanban — quem fez o quê no board, do mais recente para o mais antigo.
//
// Três diários já existem e nenhum foi feito para o dono ler: o ledger de transições (runner/transitions.ts — cada
// salto de status com QUEM o causou), as execuções encerradas (`.runner/events.jsonl`, `RunEvent`) e o diário do Jido
// (copilot/activity.ts). Aqui eles viram UMA lista, em português simples, com a marca de quem agiu:
//   condutor  — a sessão longa que leva o card de ponta a ponta (o card está conduzido);
//   execucao  — a execução curta de uma coluna armada (o salto `run:<passo>`);
//   juiz      — um auxiliar (o juiz de conflitos, ou um agente escopado que não é o condutor do card);
//   motor     — o código que orquestra (cascata, integração, publicação) — não é agente;
//   jido      — o agente do board, só quando ele mesmo age;
//   voce      — o dono, pela tela.
//
// PURO e seguro no cliente: só tipos dos diários entram aqui; quem lê os arquivos é a action (app/activity-actions.ts).
// O texto passa pelo glossário do Inbox (inbox/copy.ts): nada de «run», «merge», «etapa», ids de passo — o teste varre.

import type { Transition } from "./runner/transitions";
import type { RunEvent } from "./runner/event-log";
import type { CopilotActivityEntry, CopilotActivityKind } from "./copilot/activity";

/** Quem agiu — a marca desenhada (components/kanban/AgentMark.tsx) e o rótulo da linha. */
export type ActivityWho = "condutor" | "execucao" | "juiz" | "motor" | "jido" | "voce";

/** O rótulo de quem agiu, como a lista mostra embaixo do texto. */
export const ACTIVITY_WHO_LABEL: Record<ActivityWho, string> = {
  condutor: "Condutor",
  execucao: "Execução de coluna",
  juiz: "Auxiliar",
  motor: "Motor",
  jido: "Jido",
  voce: "Você",
};

/** Uma linha da atividade. `cardId` null = sobre o board inteiro (a linha diz «Board»). */
export interface ActivityItem {
  /** estável entre leituras — a lista anima só a linha nova. */
  id: string;
  /** epoch ms. */
  at: number;
  who: ActivityWho;
  cardId: string | null;
  cardTitle: string | null;
  text: string;
}

/** O teto da lista (o chip mostra a primeira; o painel, todas). */
export const ACTIVITY_LIMIT = 30;

/** O que o núcleo precisa saber do board para escrever as frases. */
export interface ActivityContext {
  /** os cards vivos do board: título e se um condutor o leva agora. Card fora daqui (lixeira, outro board) não entra. */
  cards: ReadonlyMap<string, { title: string; conducted: boolean }>;
  /** o nome do passo pelo id do status (o `name` do board.yaml); id desconhecido ⇒ undefined. */
  statusName: (statusId: string) => string | undefined;
  /** o nome do passo que a execução roda, pelo gatilho dela (o status que declara o `trigger`); desconhecido ⇒ undefined. */
  triggerStep: (trigger: string) => string | undefined;
}

/** Os gatilhos que não moram numa coluna (ou que o board não declara) — o nome do passo em palavras. */
const TRIGGER_WORDS: Record<string, string> = {
  "harness-sync-card": "Sincronizar",
  "harness-resolve": "Conflito",
};

/** O gatilho do juiz de conflitos: é um auxiliar, não uma execução de coluna. */
const JUDGE_TRIGGERS = new Set(["harness-resolve"]);

/** A marca de quem causou um salto de status. PURA. */
export function classifyTransitionActor(actor: string, conducted: boolean): ActivityWho {
  if (actor === "human") return "voce";
  if (actor === "cascade" || actor === "system" || actor === "merge") return "motor";
  // fase 6 — o PAPEL que o MCP grava (mcp/actor.ts `actorRole`): a Sentinela e o chat são o Jido (o mesmo rosto); o
  // procurador e os críticos do serviço são auxiliares; uma sessão externa só é «condutor» no card que ela conduz.
  if (actor.startsWith("conductor:")) return "condutor";
  if (actor === "sentinel" || actor === "chat") return "jido";
  if (actor === "proxy" || actor === "critic") return "juiz";
  if (actor.startsWith("external:") || actor.startsWith("session:")) return conducted ? "condutor" : "juiz";
  if (actor.startsWith("run:")) {
    const who = actor.slice(4);
    // `run:orch` = um agente escopado pelo MCP (transitionActorLabel). No card conduzido ele É o condutor; fora dele é
    // uma sessão auxiliar (orquestração externa, revisor…) — não ganha o rosto de quem constrói.
    if (who === "orch") return conducted ? "condutor" : "juiz";
    if (JUDGE_TRIGGERS.has(who)) return "juiz";
    return "execucao";
  }
  return "motor";
}

function stepWords(ctx: ActivityContext, trigger: string): string | undefined {
  return ctx.triggerStep(trigger) ?? TRIGGER_WORDS[trigger];
}

function statusWords(ctx: ActivityContext, id: string | null): string | undefined {
  if (!id) return undefined;
  return ctx.statusName(id);
}

/** A frase de um salto de status. PURA. */
export function transitionText(t: Pick<Transition, "from" | "to" | "actor" | "note">, who: ActivityWho, ctx: ActivityContext): string {
  const to = statusWords(ctx, t.to) ?? "o próximo passo";
  const from = statusWords(ctx, t.from);
  const note = t.note ?? "";
  switch (who) {
    case "voce":
      if (note === "undo" || note.startsWith("undo:")) return `Você desfez; o card voltou para ${to}.`;
      if (note === "reopen:refine") return `Você reabriu para melhorar; foi para ${to}.`;
      if (note === "reopen:fix") return `Você reabriu para corrigir; foi para ${to}.`;
      if (note === "reopen:retire") return `Você pediu para descontinuar; foi para ${to}.`;
      if (note.startsWith("revive")) return `Você trouxe de volta; foi para ${to}.`;
      return `Você moveu para ${to}.`;
    case "motor":
      if (t.actor === "merge") return `Integrou o trabalho; o card foi para ${to}.`;
      if (note === "deploy:reverted") return `Desfez a publicação; o card voltou para ${to}.`;
      if (note === "deploy:already-live") return `Viu que já estava no ar; foi para ${to}.`;
      return `Seguiu para ${to}.`;
    case "execucao":
      return from ? `Terminou ${from} e levou para ${to}.` : `Terminou o passo e levou para ${to}.`;
    case "condutor":
      return from ? `Levou de ${from} para ${to}.` : `Levou para ${to}.`;
    default:
      return `Levou para ${to}.`;
  }
}

/** A frase de uma execução encerrada, pelo desfecho. PURA. */
export function runEventText(ev: Pick<RunEvent, "trigger" | "outcome">, ctx: ActivityContext): string {
  const step = stepWords(ctx, ev.trigger);
  const em = step ? ` em ${step}` : "";
  switch (ev.outcome) {
    case "ok":
      return step ? `Terminou ${step}.` : "Terminou o passo.";
    case "no-op":
      return step ? `Olhou ${step} e não havia o que fazer.` : "Olhou o passo e não havia o que fazer.";
    case "error":
      return `Parou com erro${em}.`;
    case "timeout":
      return `Passou do tempo${em} e parou.`;
    case "oom-killed":
      return `Ficou sem memória${em} e parou.`;
    case "cancelled":
      return `Foi interrompida${em}.`;
    case "max-turns":
      return `Chegou ao limite de tentativas${em}.`;
    case "budget-cut":
      return `Parou para não passar da cota${em}.`;
    default:
      return `Parou antes de terminar${em}.`;
  }
}

/**
 * O que cada ferramenta do board faz, em palavras de quem lê o Kanban (o feito, 3ª pessoa) — sem «cópia de trabalho»,
 * «sessão», nome de ferramenta nem classe de risco. O diário do Jido guarda o nome técnico (ou a frase do chat); aqui ele
 * vira a frase da atividade.
 */
const TOOL_PLAIN: Readonly<Record<string, readonly [string, string]>> = {
  move_card: ["moveu um card", "mover um card"],
  update_card: ["atualizou um card", "atualizar um card"],
  create_card: ["criou um card", "criar um card"],
  create_idea: ["registrou uma ideia na Triagem", "registrar uma ideia na Triagem"],
  triage_finding: ["tratou um aviso", "tratar um aviso"],
  answer_question: ["respondeu uma pergunta", "responder uma pergunta"],
  ask_question: ["fez uma pergunta", "fazer uma pergunta"],
  record_decision: ["registrou uma decisão", "registrar uma decisão"],
  write_sidecar: ["atualizou o plano de um card", "atualizar o plano de um card"],
  propose_change: ["propôs uma mudança", "propor uma mudança"],
  propose_locked_command: ["pediu para rodar um comando travado", "rodar um comando travado"],
  request_peer_review: ["pediu uma revisão", "pedir uma revisão"],
  report_issue: ["relatou um problema", "relatar um problema"],
  worktree_open: ["começou a mexer no código", "começar a mexer no código"],
  worktree_submit: ["entregou o código para entrar no produto", "entregar o código para entrar no produto"],
  worktree_discard: ["terminou de mexer no código", "terminar de mexer no código"],
  worktree_refresh: ["atualizou o código em que trabalha", "atualizar o código em que trabalha"],
  set_card_driver: ["mudou quem leva um card", "mudar quem leva um card"],
  defer_card: ["adiou um card", "adiar um card"],
  undefer_card: ["retomou um card adiado", "retomar um card adiado"],
  transfer_card: ["mudou um card de board", "mudar um card de board"],
  enqueue: ["pôs um card na fila", "pôr um card na fila"],
  enqueue_batch: ["pôs cards na fila", "pôr cards na fila"],
  claude_new: ["chamou outro agente para trabalhar", "chamar outro agente para trabalhar"],
  pause_board: ["mudou o ritmo do board", "mudar o ritmo do board"],
  resume_board: ["mudou o ritmo do board", "mudar o ritmo do board"],
  set_board_autorun: ["mudou o trabalho automático do board", "mudar o trabalho automático do board"],
  usm_capture: ["registrou uma ideia", "registrar uma ideia"],
  approve_qa: ["aprovou o teste de um card", "aprovar o teste de um card"],
  approve_review: ["aprovou a revisão de um card", "aprovar a revisão de um card"],
  choose_wireframe: ["escolheu a tela de um card", "escolher a tela de um card"],
  design_feedback: ["comentou a tela de um card", "comentar a tela de um card"],
  refine_card: ["pediu um ajuste num card", "pedir um ajuste num card"],
  report_bug: ["relatou um defeito", "relatar um defeito"],
  revive_card: ["reviveu um card", "reviver um card"],
  sync_card: ["conferiu um card com o código", "conferir um card com o código"],
  add_finding: ["registrou um aviso", "registrar um aviso"],
  set_tasks: ["atualizou as tarefas de um card", "atualizar as tarefas de um card"],
  set_card_route: ["mudou o caminho de um card", "mudar o caminho de um card"],
  set_card_links: ["ligou cards entre si", "ligar cards entre si"],
  request_budget: ["pediu mais verba para um card", "pedir mais verba para um card"],
  request_extra_cycle: ["pediu mais uma volta para um card", "pedir mais uma volta para um card"],
  run_skill: ["pôs um agente para trabalhar num card", "pôr um agente para trabalhar num card"],
  cancel_run: ["parou o trabalho de um agente", "parar o trabalho de um agente"],
  resolve_merge: ["resolveu um conflito no código", "resolver um conflito no código"],
  delete_card: ["mandou um card para a lixeira", "mandar um card para a lixeira"],
  restore_deleted: ["tirou um card da lixeira", "tirar um card da lixeira"],
  discontinue_card: ["descontinuou um card", "descontinuar um card"],
  write_doc: ["atualizou um documento do board", "atualizar um documento do board"],
  save_persona: ["atualizou as personas do board", "atualizar as personas do board"],
  save_system: ["atualizou os sistemas do board", "atualizar os sistemas do board"],
};
const TOOL_GENERIC: readonly [string, string] = ["fez uma ação no board", "fazer uma ação no board"];
/**
 * A ferramenta que a tabela não conhece ainda: o TIPO da ação (a classe de risco gravada junto) diz o que ela fez, em
 * palavras — «mexeu num documento do board», «rodou um processo». Classe desconhecida ⇒ a frase genérica.
 */
const CLASS_PLAIN: Readonly<Record<string, readonly [string, string]>> = {
  read: ["consultou o board", "consultar o board"],
  "write-board": ["mudou algo no board", "mudar algo no board"],
  "doc-write": ["mexeu num documento do board", "mexer num documento do board"],
  "reversible-delete": ["mandou algo para a lixeira", "mandar algo para a lixeira"],
  run: ["rodou um processo", "rodar um processo"],
  "run-free": ["rodou um comando", "rodar um comando"],
  session: ["chamou outro agente para trabalhar", "chamar outro agente para trabalhar"],
  "merge-resolve": ["resolveu um conflito no código", "resolver um conflito no código"],
  "peer-review": ["pediu uma revisão", "pedir uma revisão"],
  deploy: ["publicou em produção", "publicar em produção"],
  destructive: ["fez uma ação que não tem volta", "fazer uma ação que não tem volta"],
};
/** A ferramenta em palavras: a tabela, senão o tipo da ação (`cls`), senão a frase genérica. */
const toolWords = (tool: string, cls?: string): readonly [string, string] => TOOL_PLAIN[tool] ?? (cls ? CLASS_PLAIN[cls] : undefined) ?? TOOL_GENERIC;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** As frases que o diário já gravou em palavras e ainda trazem jargão (a tabela antiga do chat) → a frase simples. */
const PHRASE_PLAIN: ReadonlyArray<readonly [RegExp, string]> = [
  [/abriu uma cópia de trabalho/g, TOOL_PLAIN.worktree_open[0]],
  [/abrir uma cópia de trabalho/g, TOOL_PLAIN.worktree_open[1]],
  [/mandou um trabalho para integração/g, TOOL_PLAIN.worktree_submit[0]],
  [/mandar um trabalho para integração/g, TOOL_PLAIN.worktree_submit[1]],
  [/encerrou uma cópia de trabalho/g, TOOL_PLAIN.worktree_discard[0]],
  [/encerrar uma cópia de trabalho/g, TOOL_PLAIN.worktree_discard[1]],
  [/atualizou uma cópia de trabalho/g, TOOL_PLAIN.worktree_refresh[0]],
  [/atualizar uma cópia de trabalho/g, TOOL_PLAIN.worktree_refresh[1]],
  [/abriu uma sessão de agente/g, TOOL_PLAIN.claude_new[0]],
  [/abrir uma sessão de agente/g, TOOL_PLAIN.claude_new[1]],
  [/mudou quem conduz um card/g, TOOL_PLAIN.set_card_driver[0]],
  [/mudar quem conduz um card/g, TOOL_PLAIN.set_card_driver[1]],
];

/** A classe de risco entre parênteses — em código (`write-board`) ou já em palavras («abre sessão») — sai da frase. */
const RISK_PAREN =
  / \((?:read|write-board|doc-write|reversible-delete|run|session|merge-resolve|peer-review|deploy|run-free|destructive|só leitura|mexe no board|mexe em documento|apaga com volta|roda um processo|abre sessão|resolve integração|revisão|publicação|comando livre|destrutivo)\)/g;

/** Um id cunhado pela ferramenta (uuid) — não é nome de ninguém. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * QUEM fez uma linha do diário do Jido. O diário não é só dele: pela porta do Jido passam também o condutor de um card
 * e os agentes de fora (uma sessão no terminal), e a frase começa por eles. A marca do Jido (a antena) fica SÓ no que
 * o Jido fez; o resto ganha a marca de quem fez, e a frase troca o nome técnico (o id da sessão, o do card) por
 * palavras. PURA.
 */
export function diaryActor(text: string): { who: ActivityWho; text: string } {
  const lead: ReadonlyArray<readonly [RegExp, ActivityWho, string]> = [
    [/^(?:O|o) condutor do card \S+ /, "condutor", "O condutor "],
    [/^O agente de um card /, "condutor", "O condutor "],
    // o agente de fora se NOMEIA (`external:<nome>`): o nome que ele escolheu diz quem foi — fica, entre aspas; um id
    // cunhado (uuid) não diz nada e sai
    [/^Um agente de fora \(([^)\s]{1,40})\) /, "juiz", "Um agente de fora («$1») "],
    [/^Um agente de fora(?: \([^)]*\))? /, "juiz", "Um agente de fora "],
    [/^Uma sessão de (?:agente|trabalho)(?: \([^)]*\))? /, "juiz", "Outro agente "],
    [/^Um agente /, "juiz", "Outro agente "],
  ];
  for (const [re, who, subject] of lead) {
    const m = re.exec(text);
    if (!m) continue;
    if (m[1] && UUID_RE.test(m[1])) continue; // o nome é um id cunhado: a regra seguinte o tira
    return { who, text: text.replace(re, subject) };
  }
  return { who: "jido", text };
}

/** A frase de uma linha do diário, em palavras simples (sem nome de ferramenta, classe de risco nem jargão). PURA. */
export function diaryPlain(text: string): string {
  let t = text
    // «Executei `move_card` sozinho (write-board).» / «… executou move_card (write-board).» — com ou sem crase
    // a classe de risco logo depois (`(write-board)`) entra no lugar da frase genérica quando a ferramenta é nova
    .replace(/\bExecutei `?([a-z]+(?:_[a-z]+)+)`?( sozinho)?(?=(?: \(([a-z-]+)\))?)/g, (_m, tool: string, alone?: string, cls?: string) => `${cap(toolWords(tool, cls)[0])}${alone ? " sozinho" : ""}`)
    .replace(/\bexecutou `?([a-z]+(?:_[a-z]+)+)`?(?=(?: \(([a-z-]+)\))?)/g, (_m, tool: string, cls?: string) => toolWords(tool, cls)[0])
    .replace(/\b(para|pediu) `?([a-z]+(?:_[a-z]+)+)`?(?=(?: \(([a-z-]+)\))?)/g, (_m, w: string, tool: string, cls?: string) => `${w === "pediu" ? "pediu para" : "para"} ${toolWords(tool, cls)[1]}`)
    .replace(/`([a-z]+(?:_[a-z]+)+)`/g, (_m, tool: string) => `«${(TOOL_PLAIN[tool] ?? TOOL_GENERIC)[1]}»`);
  for (const [re, plain] of PHRASE_PLAIN) t = t.replace(re, plain);
  return t.replace(RISK_PAREN, "");
}

/**
 * O card de uma linha do diário, pelo `detail` que a guarda do MCP grava («board/card-id»). Só um card vivo deste board
 * (em `ctx.cards`); sem card, ou card fora daqui, a linha fala do board. PURA.
 */
export function diaryCardOf(detail: string | undefined, ctx: Pick<ActivityContext, "cards">): { id: string; title: string } | null {
  const slash = detail?.indexOf("/") ?? -1;
  if (!detail || slash <= 0) return null;
  const id = detail.slice(slash + 1).trim();
  const card = id ? ctx.cards.get(id) : undefined;
  return card ? { id, title: card.title } : null;
}

/** As decisões do Jido que entram na atividade: só quando ele AGE (ou pede, recusa, devolve, erra) — o resto é ruído. */
const COPILOT_KINDS: ReadonlySet<CopilotActivityKind> = new Set(["acted", "asked", "refused", "finished", "handed-back", "error"]);

const TEXT_MAX = 160;
function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1).trimEnd()}…` : t;
}

function toMs(at: string | number): number {
  if (typeof at === "number") return at;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Janela em que uma execução que terminou bem e o salto que ela causou são o MESMO acontecimento. */
const SAME_EVENT_MS = 5 * 60_000;

/**
 * O motor encadeia saltos do mesmo card em segundos (a publicação confirma que já estava no ar e o card segue para o
 * fim): duas linhas seguidas — «Seguiu para No ar» e, embaixo, «Viu que já estava no ar; foi para Publicar» — liam
 * como se o card tivesse voltado. Uma cadeia de saltos do motor no mesmo card, cada um a menos de 5 min do anterior,
 * vira UMA linha: a do destino final, com o motivo do primeiro quando ele diz algo («Viu que já estava no ar; foi para
 * No ar.»). Muda `items` no lugar. PURA quanto ao resto.
 */
function collapseMotorChains(items: ActivityItem[]): void {
  const byCard = new Map<string, ActivityItem[]>();
  for (const it of items) if (it.who === "motor" && it.cardId) byCard.set(it.cardId, [...(byCard.get(it.cardId) ?? []), it]);
  const drop = new Set<ActivityItem>();
  for (const rows of byCard.values()) {
    rows.sort((a, b) => a.at - b.at);
    for (let k = 1; k < rows.length; k++) {
      const prev = rows[k - 1];
      const cur = rows[k];
      if (cur.at - prev.at > SAME_EVENT_MS) continue;
      drop.add(prev);
      const why = prev.text.includes("; ") ? prev.text.slice(0, prev.text.indexOf("; ")) : null;
      const dest = /^Seguiu para (.+)\.$/.exec(cur.text)?.[1];
      if (why && dest) cur.text = `${why}; foi para ${dest}.`;
    }
  }
  for (let i = items.length - 1; i >= 0; i--) if (drop.has(items[i])) items.splice(i, 1);
}

/**
 * Funde os três diários numa lista, do mais recente para o mais antigo, com no máximo `limit` linhas. PURA.
 *
 * - Um salto ou uma execução de um card que não está em `ctx.cards` fica de fora (card na lixeira ou de outro board).
 * - Uma execução que terminou BEM e o salto `run:<mesmo passo>` do mesmo card, perto no tempo, são uma linha só (fica
 *   o salto: ele diz para onde o card foi).
 * - Do Jido entram só as decisões em que ele age; a linha fala do board (o diário não carrega o card). Uma linha do
 *   diário que outro agente causou (um agente de fora, o condutor) leva a marca DELE, não a do Jido (`diaryActor`).
 */
export function mergeActivity(
  sources: { transitions: readonly Transition[]; runs: readonly RunEvent[]; copilot: readonly CopilotActivityEntry[] },
  ctx: ActivityContext,
  limit: number = ACTIVITY_LIMIT,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  const advancedByRun: Array<{ cardId: string; trigger: string; at: number }> = [];

  for (const t of sources.transitions) {
    const card = ctx.cards.get(t.cardId);
    const at = toMs(t.at);
    if (!card || !Number.isFinite(at)) continue;
    if (t.from === t.to) continue;
    const who = classifyTransitionActor(String(t.actor), card.conducted);
    if (String(t.actor).startsWith("run:")) advancedByRun.push({ cardId: t.cardId, trigger: String(t.actor).slice(4), at });
    out.push({ id: `t:${t.cardId}:${t.at}:${t.to}`, at, who, cardId: t.cardId, cardTitle: card.title, text: transitionText(t, who, ctx) });
  }

  collapseMotorChains(out);

  for (const ev of sources.runs) {
    const card = ctx.cards.get(ev.cardId);
    const at = toMs(ev.at);
    if (!card || !Number.isFinite(at)) continue;
    if (ev.outcome === "ok" && advancedByRun.some((a) => a.cardId === ev.cardId && a.trigger === ev.trigger && Math.abs(a.at - at) <= SAME_EVENT_MS)) continue;
    const who: ActivityWho = JUDGE_TRIGGERS.has(ev.trigger) ? "juiz" : "execucao";
    out.push({ id: `r:${ev.cardId}:${ev.at}:${ev.trigger}`, at, who, cardId: ev.cardId, cardTitle: card.title, text: runEventText(ev, ctx) });
  }

  for (const e of sources.copilot) {
    if (!COPILOT_KINDS.has(e.kind)) continue;
    const at = toMs(e.at);
    const raw = clip(e.text ?? "");
    if (!Number.isFinite(at) || !raw) continue;
    // a marca é de QUEM fez (o diário do Jido também guarda o que outros agentes fizeram pela porta dele)
    const { who, text } = diaryActor(diaryPlain(raw));
    // o card da ação (o `detail` do diário é «board/card»): a linha diz SOBRE O QUE foi, quando o card está vivo aqui
    const card = diaryCardOf(e.detail, ctx);
    out.push({ id: `j:${e.id}`, at, who, cardId: card?.id ?? null, cardTitle: card?.title ?? null, text });
  }

  const seen = new Set<string>();
  return out
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .slice(0, Math.max(0, limit));
}

/**
 * O tempo relativo curto da atividade: «agora», «4 min», «2 h», «ontem», «3 dias». PURA. Um instante no futuro (relógio
 * de outra máquina adiantado) conta como «agora» — nunca «-2 min».
 */
export function relativeShort(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000);
  if (!Number.isFinite(min) || min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "ontem" : `${d} dias`;
}
