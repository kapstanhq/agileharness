// The AUTONOMY KEY — human × ultra, per board, with a per-story exception. PURE (no IO, no React).
//
// The autonomy table:
//
//   decision point               human                          ultra
//   ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//   interview (user stories)     the owner answers              a PROXY answers (PRD, personas, past decisions),
//                                                               recording its premissas for audit
//   UI choice (2–3 variants)     the owner picks/comments       the proxy picks by rubric
//   delivery proof               notice after (autonomous       notice after, sample audit
//                                classes), else approve before
//   money (spend, vendor, price, the owner                      the owner — an owner-only queue; the rest of the
//   external publication, PRD)                                  board keeps moving
//
// This module answers the three questions every layer asks — the kanban tag, the MCP tools, the proxy dispatcher
// and its writer — from ONE place, so they cannot drift apart:
//   1. what mode is this story in? (`effectiveAutonomy` — the card's exception, else the board, else human);
//   2. may THIS question be answered by the proxy? (`isProxiableQuestion` — the asker's category first, and a
//      deterministic money FLOOR that can only ever make a question MORE human, never less — over the question's
//      TEXT when the asker declared a category, over text+context only when nobody did);
//   3. does a proxy answer go on the owner's audit list? (`shouldAuditProxyAnswer` — a deterministic sample; and
//      ALWAYS when the money floor only matched the context — `relaxedMoneyFloorMatch`).
//
// "LLM does reasoning, code does plumbing": the proxy (runner/proxy.ts) decides WHAT to answer; this file only
// decides WHETHER it may, and it errs toward the owner every time.

import { hasOpenQuestions, openQuestions } from "./questions";
import { ownerClassLabel, ownerClassesOf } from "./owner-classes";
import { AUTONOMY_BOXES, boardAutonomyMode, decisionKeyOfCategory, storyDecides } from "./autonomy-profile";
import { AUTONOMY_DEFAULT_AUDIT_SAMPLE_RATE, AUTONOMY_DEFAULT_TECHNICAL_AUDIT_RATE } from "./types";
import type { AutonomyMode, BoardConfig, Card, CardQuestion, ModelTier, QuestionCategory } from "./types";

/** Where a story's mode came from — shown next to the tag so "why is this ultra?" has an answer. */
export type AutonomySource = "card" | "board" | "default";

export interface EffectiveAutonomy {
  mode: AutonomyMode;
  source: AutonomySource;
}

/**
 * The mode a story runs in: its own exception, else the board's key, else `human`. PURE. The board's key is the one
 * the autonomy PROFILE implies when the board declares it (autonomy-profile.ts `boardAutonomyMode`: any story box on ⇒
 * `ultra`), else the declared `autonomy.mode` — so a hand-edited `mode` can never disagree with the profile.
 */
export function effectiveAutonomy(
  card: Pick<Card, "autonomyMode"> | null | undefined,
  config: Pick<BoardConfig, "autonomy"> | null | undefined,
): EffectiveAutonomy {
  if (card?.autonomyMode) return { mode: card.autonomyMode, source: "card" };
  if (config?.autonomy?.agentDecides || config?.autonomy?.mode) return { mode: boardAutonomyMode(config), source: "board" };
  return { mode: "human", source: "default" };
}

/** The proxy's tier when the board names none: a bounded judgement over a prepared context, not authoring. */
export const PROXY_DEFAULT_MODEL: ModelTier = "sonnet";

/** The board's proxy settings with the defaults applied. PURE. */
export function proxySettings(config: Pick<BoardConfig, "autonomy"> | null | undefined): {
  model: ModelTier;
  auditSampleRate: number;
  technicalAuditSampleRate: number;
} {
  const a = config?.autonomy;
  const rate = (r: number | undefined, dflt: number) => (typeof r === "number" && Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : dflt);
  return {
    model: a?.proxyModel ?? PROXY_DEFAULT_MODEL,
    auditSampleRate: rate(a?.auditSampleRate, AUTONOMY_DEFAULT_AUDIT_SAMPLE_RATE),
    technicalAuditSampleRate: rate(a?.technicalAuditSampleRate, AUTONOMY_DEFAULT_TECHNICAL_AUDIT_RATE),
  };
}

/** The categories a proxy may answer in ultra mode — BUSINESS-ONLY since plan v4 (decision-class.ts): every
 *  technical category, each within the board's profile box (autonomy-profile.ts `decisionKeyOfCategory`). `owner` and
 *  `money` are the owner's in every mode; `guardrail` goes to a diff reviewer; an UNCATEGORIZED question is the
 *  owner's until the classifier judges it (question-classifier.ts). */
export const PROXIABLE_CATEGORIES: readonly QuestionCategory[] = ["interview", "ui-choice", "technical", "delivery"];

/** The category a question EFFECTIVELY has: the asker's, else the classifier's verdict, else none. PURE. */
export function effectiveQuestionCategory(q: Pick<CardQuestion, "category" | "classified">): QuestionCategory | undefined {
  return q.category ?? q.classified?.category;
}

/** The `[humano]` marker the conductor skill prefixes to an always-human question's context (or text). */
const OWNER_ONLY_MARKER = /^\s*\[humano\]/i;

/**
 * The money FLOOR — deliberately small and literal: price, vendor and spend words (pt/en). It only ever turns a
 * proxiable question into the owner's; it never makes one proxiable. A false positive costs the owner one
 * answer; a false negative would let a proxy commit money — so the list leans wide on exactly these words and
 * stops there (anything subtler is the asker's job: category `money`).
 */
const MONEY_TERMS =
  /\b(pre[çc]os?|pricing|prices?|fornecedor(es)?|vendors?|gastos?|spend(ing)?|or[çc]amentos?|budgets?|assinaturas?|subscriptions?|plano pago|paid plan|cobran[çc]as?|billing|custo mensal|monthly cost)\b/i;

/**
 * Is this question the OWNER's in every mode? PURE. Três sinais, nesta ordem:
 *   1. a categoria `money` declarada por quem perguntou — absoluta;
 *   2. o marcador `[humano]` no texto ou no contexto — absoluto (a skill o exige em dinheiro de verdade);
 *   3. as palavras de dinheiro (MONEY_TERMS) — sobre O QUE SE DECIDE, não sobre a narrativa:
 *      · pergunta COM categoria declarada ⇒ só o `text` (o sujeito da decisão). «Qual fornecedor de SMS?» segue do
 *        dono mesmo declarada `technical`;
 *      · pergunta SEM categoria (texto livre, legado — quem não sabe se classificar) ⇒ `text` + `context`.
 *
 * POR QUE O CONTEXTO SAIU: o piso lia `text+context` antes da categoria do autor, e o contexto que a skill do
 * condutor EXIGE («o que custa», «Gasto até aqui») acendia o piso. Perguntas de protocolo técnico (do tipo «tento de
 * novo?») iam ao dono como «Dinheiro e preço» só porque o contexto citava, de passagem, um rótulo de preço de uma
 * tela ou a linha de gasto da sessão. Em perguntas com categoria declarada, os acertos do piso
 * eram falsos positivos, todos pelo contexto.
 * O custo estruturado de uma pergunta mora em `costUsd` — e o piso NUNCA o lê (gasto de IA do card é do card-budget).
 */
export function isOwnerOnlyQuestion(q: Pick<CardQuestion, "category" | "text" | "context">): boolean {
  if (q.category === "money") return true;
  if (OWNER_ONLY_MARKER.test(q.text ?? "") || OWNER_ONLY_MARKER.test(q.context ?? "")) return true;
  return MONEY_TERMS.test(q.category ? (q.text ?? "") : `${q.text ?? ""}\n${q.context ?? ""}`);
}

/**
 * A pergunta que o piso ANTIGO (texto + contexto) mandaria ao dono e o piso atual deixa ir ao proxy: categoria
 * declarada não-dinheiro, nenhum sinal do piso no texto, e palavra de dinheiro só no CONTEXTO. PURA.
 *
 * É a MITIGAÇÃO que o afrouxamento do piso exige: uma pergunta de
 * dinheiro de verdade, mal categorizada como técnica pelo autor («Uso a API X?», com «US$ 200/mês de assinatura» no
 * contexto), iria ao proxy e só cairia na amostra comum — um gasto decidido sem o dono ver. A resposta do proxy a ela
 * vai SEMPRE à auditoria do dono ({@link applyProxyAnswers}), em Acompanhar: o dono vê e pode reabrir, nada espera por
 * ele. Sem janela de expiração: o risco não expira, e o volume é pequeno (a maior parte
 * era prosa de custo que o ciclo extra tipado — request_extra_cycle — tirou do contexto).
 */
export function relaxedMoneyFloorMatch(q: Pick<CardQuestion, "category" | "text" | "context">): boolean {
  if (!q.category || isOwnerOnlyQuestion(q)) return false;
  return MONEY_TERMS.test(q.context ?? "");
}

/**
 * O piso da MARCA — tão literal quanto o de dinheiro: falar em nome da marca FORA do produto (redes sociais, e-mail ou
 * push em massa, imprensa). Só empurra para o dono, e só num board que declara a classe `brand-voice` (o default
 * declara). O texto de DENTRO do produto (telas, botões) não casa: é do guia de marca, não do dono.
 */
const BRAND_TERMS =
  /\b(redes sociais|social media|instagram|tiktok|linkedin|facebook|newsletter|e-?mail (em massa|marketing|para (todos|toda a base|muitos))|mass e-?mails?|push (em massa|para (todos|toda a base|muitos))|imprensa|press release)\b/i;

/** A classe que a marca aponta (owner-classes.ts). */
const BRAND_CLASS = "brand-voice";

/**
 * O PISO de uma pergunta: a classe do dono que ela toca pelos sinais literais — dinheiro (`money`: a categoria, o
 * marcador `[humano]`, as palavras de dinheiro) e marca (`brand-voice`, quando o board declara a classe), ou null.
 * Vale MESMO com uma categoria declarada pelo autor: nesse caso lê só o TEXTO (o sujeito da decisão); sem categoria, o
 * texto e o contexto. Só empurra para o dono, nunca tira dele. PURA.
 */
export function ownerFloorClass(
  q: Pick<CardQuestion, "category" | "text" | "context">,
  config?: Pick<BoardConfig, "autonomy"> | null,
): string | null {
  if (isOwnerOnlyQuestion(q)) return "money";
  if (!ownerClassesOf(config).some((c) => c.id === BRAND_CLASS)) return null;
  return BRAND_TERMS.test(q.category ? (q.text ?? "") : `${q.text ?? ""}\n${q.context ?? ""}`) ? BRAND_CLASS : null;
}

/**
 * Is this question a decision of the OWNER — the floor ({@link ownerFloorClass}: money, `[humano]`, brand) OR a business
 * category (`owner`, declared by the asker or judged by the classifier)? The one reader every agent-facing door uses:
 * the proxy never takes it, the copiloto never answers it (`answer_question` refuses), and the Inbox marks it. PURE.
 */
export function isOwnerDecisionQuestion(
  q: Pick<CardQuestion, "category" | "text" | "context" | "classified">,
  config?: Pick<BoardConfig, "autonomy"> | null,
): boolean {
  return ownerFloorClass(q, config) !== null || effectiveQuestionCategory(q) === "owner";
}

/** Quem respondeu é o DONO? (a resposta pela UI não carimba autor — ausente é humano). */
export function answeredByOwner(q: Pick<CardQuestion, "status" | "answeredBy">): boolean {
  if (q.status !== "answered") return false;
  const by = q.answeredBy?.trim();
  return !by || by === "human" || by === "operator" || by.startsWith("human:");
}

/**
 * Por que um AGENTE (o copiloto, o condutor, qualquer token de MCP) não pode responder esta pergunta — ou null. PURA.
 *   · a resposta do DONO nunca é sobrescrita por um agente (nem «corrigida»);
 *   · a pergunta que o dono REABRIU numa auditoria, ou que o procurador devolveu, é dele para sempre;
 *   · a decisão do dono (o piso, a categoria `owner`) espera o dono;
 *   · mudar um teste existente (`guardrail`) também: a regra é um revisor de diff independente, nunca quem perguntou —
 *     e esse revisor ainda não existe, então é do dono (decision-class.ts GUARDRAIL_REASON);
 *   · com `card` (o chamador é um agente ESCOPADO — mcp/actor.ts isScopedActor): a caixa do perfil que governa a
 *     categoria (entrevista/técnica ⇒ `spec`, tela ⇒ `design`, entrega ⇒ `delivery`) desligada para esta story ⇒ a
 *     decisão espera o dono. Sem isso as caixas paravam o procurador, mas não o copiloto nem o condutor.
 */
export function agentAnswerRefusal(
  q: Pick<CardQuestion, "status" | "answeredBy" | "category" | "text" | "context" | "classified" | "proxy">,
  config?: Pick<BoardConfig, "autonomy"> | null,
  card?: Pick<Card, "autonomyMode"> | null,
): string | null {
  if (answeredByOwner(q)) return "o dono já respondeu esta pergunta — um agente não sobrescreve a resposta dele";
  if (q.proxy?.auditOutcome === "reopened") return "o dono reabriu esta pergunta numa auditoria — agora ela é dele, para sempre";
  if (q.proxy?.declined) return "o procurador devolveu esta pergunta ao dono — ela é dele, para sempre";
  if (q.status !== "open") return null;
  if (isOwnerDecisionQuestion(q, config)) return "decisão só do dono (dinheiro, marca, [humano] ou uma classe de negócio)";
  const category = effectiveQuestionCategory(q);
  if (category === "guardrail") return "mudar um teste existente é do revisor de diff independente (lançado pelo serviço) ou do dono — nenhum agente a responde";
  const key = card ? decisionKeyOfCategory(category) : null;
  if (card && key && !storyDecides(card, config, key)) {
    const box = AUTONOMY_BOXES.find((b) => b.key === key)?.label ?? key;
    return `a autonomia deste board deixa esta decisão com o dono («${box}» desligada)`;
  }
  return null;
}

/**
 * Um AGENTE (o Jido, a frota) pode pegar uma pergunta desta categoria nesta story? A mesma régua da recusa do
 * `answer_question` (agentAnswerRefusal), reduzida ao que o item do Inbox carrega: `guardrail` nunca; e a categoria cuja
 * caixa do perfil está desligada também não. Quem lê: o Inbox (o Jido «pega» a pergunta e ela sai de Decidir) e o tick
 * (que acordaria para uma pergunta que a tool recusaria) — sem isto a pergunta sumia do dono para um agente que não pode
 * respondê-la. PURA.
 */
export function agentMayTakeQuestion(
  category: QuestionCategory | undefined,
  card: Pick<Card, "autonomyMode"> | null | undefined,
  config: Pick<BoardConfig, "autonomy"> | null | undefined,
): boolean {
  if (category === "guardrail") return false;
  const key = decisionKeyOfCategory(category);
  return !key || storyDecides(card, config, key);
}

/**
 * The CONSERVATIVE default category — only for the writer that genuinely cannot know: a PLAIN free-text question
 * (`ask_question` `texts`, a follow-up typed with no structure). Every other writer declares the category itself
 * (the grill/review/conductor skills, the structured `ask_question`, the steward). This can only ever point a
 * question at the OWNER: `money` when the owner-only floor matches (money words, the `[humano]` marker), and
 * NOTHING otherwise — an uncategorized question is the owner's ({@link proxyRefusal}), and guessing `interview`
 * from prose would hand a decision to the proxy on a hunch. It never returns a proxiable category. PURE.
 */
export function defaultQuestionCategory(q: Pick<CardQuestion, "text" | "context">): QuestionCategory | undefined {
  return isOwnerOnlyQuestion({ text: q.text, context: q.context }) ? "money" : undefined;
}

/**
 * Why a question is not the proxy's — or null when it is. PURE (the dispatcher logs it; tests pin it). The proxy has
 * a SCOPE: the board's autonomy profile (autonomy-profile.ts) — entrevista/técnica só com a caixa `spec`, escolha de
 * tela só com `design`, entrega só com `delivery` (a exceção do card sobrepõe as três). Nada do dono entra no escopo:
 * o piso (dinheiro, marca, `[humano]`), a categoria `owner`, o card que toca uma classe do dono, a pergunta que o dono
 * reabriu ou que o procurador já devolveu, e a `guardrail` (mudar teste existente vai ao revisor de diff).
 */
export function proxyRefusal(
  q: Pick<CardQuestion, "status" | "category" | "text" | "context" | "proxy" | "ownerClass" | "classified">,
  card: Pick<Card, "autonomyMode" | "ownerReviewsUi"> & Partial<Pick<Card, "businessClasses">>,
  config: Pick<BoardConfig, "autonomy">,
): string | null {
  if (q.status !== "open") return "pergunta já respondida";
  if (effectiveAutonomy(card, config).mode !== "ultra") return "story em modo human";
  // The owner REOPENED a proxy answer on audit: that question is theirs now, for good — re-proxying it would
  // overrule the very human the audit exists for.
  if (q.proxy?.auditOutcome === "reopened") return "o dono reabriu a resposta do proxy — agora é dele";
  // The proxy already handed it back (declined, or failed on it past the cap): it is the owner's for good.
  if (q.proxy?.declined) return "o proxy devolveu esta pergunta ao dono";
  const floor = ownerFloorClass(q, config);
  if (floor === "money") return "decisão de dinheiro/só do dono — nunca vai ao proxy";
  if (floor) return `decisão do dono («${ownerClassLabel(floor, config)}») — nunca vai ao proxy`;
  const category = effectiveQuestionCategory(q);
  if (category === "owner") {
    const cls = q.ownerClass ?? q.classified?.ownerClass;
    return `decisão de negócio do dono${cls ? ` («${ownerClassLabel(cls, config)}»)` : ""} — nunca vai ao proxy`;
  }
  // O card TOCA uma classe do dono (a marca de um juiz): o procurador não decide nada nele — erra para o dono.
  const touched = card.businessClasses?.ids.find((id) => id.trim());
  if (touched) return `o card toca «${ownerClassLabel(touched, config)}» — as perguntas dele são do dono`;
  if (!category) return "pergunta sem categoria — é do dono até o classificador julgá-la (técnica vai ao proxy)";
  if (category === "guardrail") return "mudar teste existente vai ao revisor de diff independente (reprovado ou em modo humano, ao dono) — nunca ao procurador";
  // «Quero ver as opções de tela» (card-opt-ins.ts): a escolha de tela DESTE card o dono pediu para fazer.
  if (category === "ui-choice" && card.ownerReviewsUi) return "o dono pediu para ver as opções de tela deste card — a escolha é dele";
  if (!PROXIABLE_CATEGORIES.includes(category)) return `categoria '${category}' não é do proxy`;
  // O ESCOPO: a caixa do perfil que governa esta categoria precisa estar ligada para esta story.
  const key = decisionKeyOfCategory(category);
  if (key && !storyDecides(card, config, key)) {
    const box = AUTONOMY_BOXES.find((b) => b.key === key)?.label ?? key;
    return `a autonomia do board deixa «${box}» com o dono`;
  }
  return null;
}

/** May the proxy answer this question now? PURE. */
export function isProxiableQuestion(
  q: Pick<CardQuestion, "status" | "category" | "text" | "context" | "proxy" | "ownerClass" | "classified">,
  card: Pick<Card, "autonomyMode" | "ownerReviewsUi"> & Partial<Pick<Card, "businessClasses">>,
  config: Pick<BoardConfig, "autonomy">,
): boolean {
  return proxyRefusal(q, card, config) === null;
}

/** The card's open questions the proxy may answer (empty when the story is human or none qualify). PURE. */
export function proxiableQuestions(
  card: Pick<Card, "autonomyMode" | "questions" | "ownerReviewsUi"> & Partial<Pick<Card, "businessClasses">>,
  config: Pick<BoardConfig, "autonomy">,
): CardQuestion[] {
  if (!hasOpenQuestions(card)) return [];
  if (effectiveAutonomy(card, config).mode !== "ultra") return [];
  return openQuestions(card).filter((q) => isProxiableQuestion(q, card, config));
}

/** The card's open questions only the owner may answer (money / marked / a business class) — the owner-only queue. */
export function ownerOnlyOpenQuestions(card: Pick<Card, "questions">, config?: Pick<BoardConfig, "autonomy"> | null): CardQuestion[] {
  return openQuestions(card).filter((q) => isOwnerDecisionQuestion(q, config));
}

/** Below this confidence a proxy answer ALWAYS goes on the audit list, sampled or not. */
export const PROXY_LOW_CONFIDENCE = 0.5;

/**
 * A deterministic [0, 1) draw for `key` (FNV-1a) — the same answer every time for the same question, so the sample
 * is reproducible (a test pins it; an audit can re-derive why an answer was or was not sampled). PURE.
 */
export function auditDraw(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** Does this proxy answer go on the owner's audit list? A low-confidence answer always; the rest by the sample. */
export function shouldAuditProxyAnswer(key: string, confidence: number, sampleRate: number): boolean {
  if (!(confidence >= PROXY_LOW_CONFIDENCE)) return true;
  return auditDraw(key) < sampleRate;
}

/** The stable key a proxy answer is sampled and ledgered by. */
export function proxyAnswerKey(board: string, cardId: string, questionId: string): string {
  return `${board}/${cardId}/${questionId}`;
}

/** A proxy answer still waiting for the owner's audit. */
export function isPendingProxyAudit(q: Pick<CardQuestion, "answeredBy" | "proxy">): boolean {
  return q.answeredBy === "proxy" && q.proxy?.audit === true && !q.proxy.auditedAt;
}

/** One answer the proxy returned, already validated against its question (runner/proxy.ts). */
export interface ProxyAnswerInput {
  questionId: string;
  answer: string;
  selectedOptionIds?: string[];
  assumptions: string;
  confidence: number;
}

/**
 * APPLY proxy answers to a card's questions — the writer's pure half (it runs under the card lock over a FRESH
 * read). Each answer lands only if its question is STILL open and STILL proxiable on this fresh card: the owner
 * may have answered it meanwhile, turned the story `human`, or the asker may have re-categorized it. Stamps
 * `answeredBy: "proxy"` and the audit record. Returns the new list and which ids landed (the same array when
 * none did — the caller skips the write). PURE.
 */
export function applyProxyAnswers(
  card: Pick<Card, "autonomyMode" | "questions" | "ownerReviewsUi"> & Partial<Pick<Card, "businessClasses">>,
  config: Pick<BoardConfig, "autonomy">,
  board: string,
  cardId: string,
  answers: readonly ProxyAnswerInput[],
  opts: { today: string; runId?: string },
): { questions: CardQuestion[]; applied: string[] } {
  const existing = card.questions ?? [];
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const { auditSampleRate } = proxySettings(config);
  const applied: string[] = [];
  const next = existing.map((q) => {
    const a = byId.get(q.id);
    if (!a || !isProxiableQuestion(q, card, config)) return q;
    const optionIds = (a.selectedOptionIds ?? []).filter((id) => q.options?.some((o) => o.id === id));
    const text = a.answer.trim();
    if (!text && !optionIds.length) return q;
    applied.push(q.id);
    // o caso que o piso afrouxado deixou passar vai sempre à auditoria; o resto, pela amostra de sempre
    const audit = relaxedMoneyFloorMatch(q) || shouldAuditProxyAnswer(proxyAnswerKey(board, cardId, q.id), a.confidence, auditSampleRate);
    return {
      ...q,
      status: "answered" as const,
      answer: text || undefined,
      answeredAt: opts.today,
      answeredBy: "proxy",
      ...(optionIds.length ? { selectedOptionIds: optionIds } : {}),
      proxy: {
        assumptions: a.assumptions.trim(),
        confidence: a.confidence,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(audit ? { audit: true } : {}),
      },
    };
  });
  return { questions: applied.length ? next : existing, applied };
}

/**
 * The proxy HANDS BACK questions to the owner — it declined them, or it failed on them past its attempt cap. The
 * hand-back is written ON the question (`proxy.declined`, with the reason as the record's text and confidence 0),
 * so every pure reader — the Inbox, the lane view, the dispatcher — sees at once that the owner must answer it,
 * with no ledger to consult. Only still-OPEN questions change. Returns the same array when nothing did. PURE.
 */
export function markProxyDeclined(
  existing: CardQuestion[],
  items: ReadonlyArray<{ questionId: string; reason: string; ownerClass?: string }>,
  opts: { runId?: string } = {},
): CardQuestion[] {
  const byId = new Map(items.map((i) => [i.questionId, i]));
  let changed = false;
  const next = existing.map((q) => {
    const item = byId.get(q.id);
    if (item === undefined || q.status !== "open" || q.proxy?.declined) return q;
    changed = true;
    return {
      ...q,
      proxy: {
        assumptions: item.reason.trim() || "o proxy não respondeu",
        confidence: 0,
        declined: true,
        // a CLASSE do dono que o proxy apontou ao recusar: é o que deixa o Inbox dizer «toca Dinheiro e preço»
        ...(item.ownerClass ? { ownerClass: item.ownerClass } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
      },
    };
  });
  return changed ? next : existing;
}

/**
 * The owner closes an audit item: `confirmed` keeps the proxy's answer; `reopened` sends the question BACK to the
 * owner (open again, the proxy's answer kept in the record as history, so the next reader sees what was assumed).
 * Only a pending proxy audit changes; anything else returns the same array. PURE.
 */
export function resolveProxyAudit(
  existing: CardQuestion[],
  questionId: string,
  outcome: "confirmed" | "reopened",
  today: string,
): CardQuestion[] {
  const q = existing.find((x) => x.id === questionId);
  if (!q || !isPendingProxyAudit(q)) return existing;
  return existing.map((x) => {
    if (x.id !== questionId || !x.proxy) return x;
    const proxy = { ...x.proxy, auditedAt: today, auditOutcome: outcome };
    if (outcome === "confirmed") return { ...x, proxy };
    const note = `[resposta do proxy reaberta pelo dono em ${today}] ${x.answer ?? ""}`.trim();
    const { answer: _a, answeredAt: _t, answeredBy: _b, selectedOptionIds: _s, ...rest } = x;
    return {
      ...rest,
      status: "open" as const,
      // The owner must see what the proxy assumed before answering: the answer moves into the context, never lost.
      context: [x.context, note, `Premissas do proxy: ${x.proxy.assumptions}`].filter(Boolean).join("\n"),
      proxy,
    };
  });
}
