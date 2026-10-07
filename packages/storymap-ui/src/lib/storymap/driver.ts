// The card DRIVER — who moves a card through the pipeline when it is not the column cascade.
//
// PURE and dependency-light on purpose: the cascade kernel (cascade-decision.ts), the engine's dispatch
// guard (runner/engine.ts), the move risk class (entry-effect.ts) and the conductor dispatcher
// (runner/conductor.ts) all ask the SAME question — "is this card conducted?" — and a predicate each of them
// re-derived would be four chances for the answers to drift apart (one of them stays silent, another spawns).

import { CONDUCTOR_DEFAULT_MAX_SESSIONS, MODEL_TIERS } from "./types";
import type { BoardConfig, Card, CardDriver, CardRouting, ModelTier, SessionModel } from "./types";
import { gateAdmitsCard, type BoardGate } from "./runner/board-pace";

/** Is this card driven by a conductor session instead of the column cascade? PURE. */
export function isConducted(card: Pick<Card, "routing"> | null | undefined): boolean {
  return card?.routing?.driver === "conductor";
}

/** The ids of the conducted cards among `cards` — what the copiloto tick and the steward must leave alone. PURE. */
export function conductedCardIds(cards: ReadonlyArray<Pick<Card, "id" | "routing">>): Set<string> {
  return new Set(cards.filter((c) => isConducted(c)).map((c) => c.id));
}

/**
 * The card's routing with `driver` set — or null when it already carries that driver (no write needed, which
 * keeps a re-dispatch or a watcher echo from producing a card write that re-triggers the watcher). An absent
 * routing block is born with `skips: []` — an EMPTY skip set leaves the deterministic skip rules deciding
 * live (routeSkip only honours ids it finds), so marking the driver changes nothing else about the route.
 * PURE.
 */
export function withDriver(
  card: Pick<Card, "routing">,
  driver: CardDriver,
  today: string,
): CardRouting | null {
  if (card.routing?.driver === driver) return null;
  if (card.routing) return { ...card.routing, driver };
  return { skips: [], decidedBy: "rules", decidedAt: today, driver };
}

/**
 * The card's routing with the driver REMOVED — or `undefined` when there is no driver to remove (no write).
 * A routing block that existed only to carry the driver (no skips, no profile, no caps) collapses to null,
 * i.e. back to "the rules decide live", exactly as if the driver had never been set. PURE.
 */
export function withoutDriver(card: Pick<Card, "routing">): CardRouting | null | undefined {
  const r = card.routing;
  if (!r?.driver) return undefined;
  const { driver: _drop, ...rest } = r;
  const meaningful = rest.skips.length > 0 || !!rest.profile || !!rest.modelCap || !!rest.effortCap;
  return meaningful ? rest : null;
}

/**
 * A route edit (`set_card_route` — skips/profile/caps) must not touch WHO drives the card: replacing `routing`
 * wholesale would silently hand a conducted card back to the column cascade, whose next entry would spawn the
 * stale column run the driver exists to prevent. So the fresh driver rides along on a new route, and survives a
 * CLEAR of the route as a routing block that carries only the driver. A card without a driver gets `next`
 * untouched. PURE.
 */
export function preserveDriver(
  next: CardRouting | null,
  prev: CardRouting | null | undefined,
  today: string,
): CardRouting | null {
  const driver = prev?.driver;
  if (!driver) return next;
  if (next) return { ...next, driver };
  return { skips: [], decidedBy: prev?.decidedBy ?? "rules", decidedAt: prev?.decidedAt || today, driver };
}

/** The skill a conductor session runs — the ONE place the slug lives (spawn prompt, recycle, telemetry). */
export const CONDUCTOR_SKILL = "harness-conductor";

/** The slash command that leads a conductor session's first prompt: `/harness-conductor <board>/<cardId>`. PURE. */
export function conductorCommand(board: string, cardId: string): string {
  return `/${CONDUCTOR_SKILL} ${board}/${cardId}`;
}

/**
 * Uma sessão aberta À MÃO (`claude_new`) num card é de CONDUTOR? Quando a tarefa abre com o comando do condutor, ou o
 * card já é conduzido (`routing.driver`). É o que dá a ela o MESMO recorte do condutor despachado (tools nativas, papel
 * MCP, pacote de contexto, teto de modelo pelo tipo) — antes só o despacho do board marcava o driver, e o condutor aberto
 * à mão nascia com a superfície inteira e o modelo da coluna, mesmo num bug. PURA.
 */
export function isHandOpenedConductor(task: string, card: Pick<Card, "routing"> | null | undefined): boolean {
  return task.trim().startsWith(`/${CONDUCTOR_SKILL}`) || isConducted(card);
}

// ── the CONDUCTOR dispatch policy (board.yaml `conductor`) — pure, read by runner/conductor.ts and by the move
//    risk class (entry-effect.ts), so a scoped agent moving a card into `fromStatus` is classed as what it is: a spawn.

/** A board's conductor policy with the defaults applied. */
export interface ResolvedConductorPolicy {
  /** every status whose ENTRY is the "go" — the string form resolves to a one-element list. */
  fromStatuses: string[];
  maxSessions: number;
  model: SessionModel;
}

/** The authored `fromStatus` (string or list) as a list of non-empty ids. PURE. */
export function conductorFromStatuses(fromStatus: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(fromStatus) ? fromStatus : fromStatus ? [fromStatus] : [];
  return [...new Set(raw.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))];
}

/** The tier a conductor runs on when the board names none: one context carries the whole story. */
export const CONDUCTOR_DEFAULT_MODEL: ModelTier = "opus";

/** The board's conductor policy, resolved — or null when absent or not enabled. PURE. */
export function resolveConductorPolicy(config: Pick<BoardConfig, "conductor"> | null | undefined): ResolvedConductorPolicy | null {
  const c = config?.conductor;
  const fromStatuses = conductorFromStatuses(c?.fromStatus);
  if (!c || c.enabled !== true || !fromStatuses.length) return null;
  return {
    fromStatuses,
    maxSessions: c.maxSessions && c.maxSessions >= 1 ? Math.floor(c.maxSessions) : CONDUCTOR_DEFAULT_MAX_SESSIONS,
    model: c.model ?? CONDUCTOR_DEFAULT_MODEL,
  };
}

/**
 * The model ONE conductor session spawns with. The board's `conductor.model` is the DEFAULT; the card's route
 * cap (`routing.modelCap` — door 2 of D10, stamped by `set_card_route` or a route profile such as `express`)
 * only LOWERS it, exactly as it does for a headless run. Before this the conductor passed the board's model as
 * an explicit override, which beats every card cap: an `express` card still paid for Opus.
 *
 * The long-context variant survives the cap (`opus[1m]` → `sonnet[1m]`, never `sonnet`). A conductor carries a
 * whole story in ONE context (typically hundreds of thousands of tokens), and the AH meter reads a bare model
 * id as a 200k window — a bare `sonnet` would show 50% at 100k tokens and suggest recycling a healthy conductor,
 * throwing away the history that is the reason for a conductor in the first place.
 *
 * Only the CAP is read, never the card's derived model: that one mixes in the COLUMN's tier, and a card
 * dispatched from a sonnet column would silently drop to sonnet. PURE.
 */
export function conductorModelFor(base: SessionModel, cardModelCap: ModelTier | undefined): SessionModel {
  // An unknown cap (a value that slipped past the coercion) is no cap: it must never BECOME the model.
  if (!cardModelCap || MODEL_TIERS.indexOf(cardModelCap) < 0) return base;
  const long = base.endsWith("[1m]");
  const tier = (long ? base.slice(0, -"[1m]".length) : base) as ModelTier;
  if (MODEL_TIERS.indexOf(tier) <= MODEL_TIERS.indexOf(cardModelCap)) return base;
  return long ? (`${cardModelCap}[1m]` as SessionModel) : cardModelCap;
}

/**
 * A marca, no `routing.rationale`, de um teto que o SERVIÇO carimbou pelo TIPO do card ({@link withTypeModelCap}) — e
 * não um teto que alguém escolheu (`set_card_route`, um perfil de rota, o operador). O carimbado pelo tipo é
 * recalculado a cada despacho: um bug que passa a tocar uma classe do dono volta ao modelo do board, em vez de ficar
 * preso no Sonnet que ganhou quando era um bug comum.
 */
export const TYPE_MODEL_CAP_MARK = "teto do condutor pelo tipo do card";

/** O teto em `routing.modelCap` foi carimbado pelo tipo (não escolhido por alguém)? PURA. */
function isTypeStampedCap(routing: CardRouting | null | undefined): boolean {
  return !!routing?.modelCap && !!routing.rationale?.startsWith(TYPE_MODEL_CAP_MARK);
}

/** A gravidade que conta como risco ALTO (dono, 07/10: «bug grave vai de Opus» — `high` e `blocker`). */
const HIGH_RISK_SEVERITIES: ReadonlySet<string> = new Set(["blocker", "high"]);

/** Risco ALTO para o teto do condutor: o card toca uma classe do dono, ou a gravidade é `high`/`blocker`. PURA. */
function conductorHighRisk(card: Pick<Card, "businessClasses" | "severity" | "bugReport">): boolean {
  return (
    (card.businessClasses?.ids?.length ?? 0) > 0 ||
    HIGH_RISK_SEVERITIES.has(card.severity ?? "") ||
    HIGH_RISK_SEVERITIES.has(card.bugReport?.severity ?? "")
  );
}

/**
 * O teto que o TIPO dá (decisão do dono, 06/10: «Sonnet para bug e manutenção; Opus SÓ em história de usuário e risco
 * alto»): todo tipo que NÃO é história de usuário (bug, manutenção, técnica, spike — e a reabertura em `mode: fix`, que é
 * um bug) roda em Sonnet sem risco alto; a história de usuário e o risco alto ficam no modelo do board. Card sem tipo
 * declarado fica no modelo do board (não se sabe se é de usuário — o lado que não rebaixa um caso que o dono quer em
 * Opus). PURA.
 */
function typeModelCap(card: Pick<Card, "storyType" | "mode" | "businessClasses" | "severity" | "bugReport">): ModelTier | undefined {
  if (conductorHighRisk(card)) return undefined;
  if (card.mode === "fix") return "sonnet";
  if (card.storyType && card.storyType !== "user") return "sonnet";
  return undefined;
}

/** A palavra do tipo no carimbo do teto. PURA. */
function typeWords(card: Pick<Card, "storyType" | "mode">): string {
  if (card.mode === "fix" || card.storyType === "bug") return "bug";
  if (card.storyType === "chore") return "manutenção";
  if (card.storyType === "technical") return "história técnica";
  if (card.storyType === "spike") return "spike";
  return String(card.storyType ?? "card");
}

/**
 * O TETO de modelo de um condutor pelo TIPO do card (decisão do dono, 06/10): todo tipo que não é história de usuário
 * (bug, manutenção, técnica, spike, e a reabertura em `mode: fix`) roda em Sonnet por padrão; a história de usuário segue
 * no modelo do board. RISCO ALTO fica no modelo do board em qualquer tipo: o card toca uma classe do dono
 * (`businessClasses`) ou a gravidade é `blocker`. (A gravidade `high` NÃO conta como risco alto — leitura a confirmar com
 * o dono; o teste conductor-model-cap a fixa para a mudança ser deliberada.)
 *
 * O teto EXPLÍCITO do card (`routing.modelCap` de `set_card_route`, de um perfil de rota ou do operador) sempre vence —
 * inclusive um `opus` que diz «este bug precisa do modelo grande». O teto que o próprio serviço carimbou pelo tipo
 * ({@link TYPE_MODEL_CAP_MARK}) não conta como explícito: é recalculado. O resultado entra em {@link conductorModelFor},
 * que só BAIXA o modelo do board (nunca sobe — o modelo do board é a escolha do operador, e «Opus em risco alto» quer
 * dizer que o risco alto não é rebaixado, não que um board configurado em Sonnet passe a pagar Opus) e preserva a janela
 * longa (`opus[1m]` → `sonnet[1m]`). PURA.
 */
export function conductorModelCapFor(
  card: Pick<Card, "storyType" | "mode" | "businessClasses" | "severity" | "routing" | "bugReport">,
): ModelTier | undefined {
  if (card.routing?.modelCap && !isTypeStampedCap(card.routing)) return card.routing.modelCap;
  return typeModelCap(card);
}

/**
 * O CARIMBO do teto pelo tipo, na admissão (decisão do dono: «o juiz de triagem/condutor carimba o teto no início»): o
 * `routing` do card com `modelCap` + a marca {@link TYPE_MODEL_CAP_MARK} no `rationale`, para o card, a tela e o
 * histórico mostrarem QUAL teto valeu. `null` ⇒ nada a gravar: o card já tem um teto escolhido por alguém (esse vence),
 * ou o carimbo já está certo. Um carimbo que deixou de valer (o card virou risco alto ou mudou de tipo) é REMOVIDO. PURA.
 */
export function withTypeModelCap(
  card: Pick<Card, "storyType" | "mode" | "businessClasses" | "severity" | "routing" | "bugReport">,
  today: string,
): CardRouting | null {
  const r = card.routing;
  if (r?.modelCap && !isTypeStampedCap(r)) return null;
  const cap = typeModelCap(card);
  if (isTypeStampedCap(r) && r!.modelCap === cap) return null;
  if (!cap) {
    if (!isTypeStampedCap(r)) return null;
    const { modelCap: _cap, rationale: _why, ...rest } = r!;
    return rest;
  }
  const rationale = `${TYPE_MODEL_CAP_MARK}: ${typeWords(card)} sem risco alto → ${cap}`;
  if (r) return { ...r, modelCap: cap, rationale };
  return { skips: [], decidedBy: "rules", decidedAt: today, modelCap: cap, rationale };
}

/** The human-readable task of a conductor session (/processes, the claim note, the retry-spawn key). PURE. */
export function conductorTask(board: string, cardId: string): string {
  return `${conductorCommand(board, cardId)} — conduzir a story de ponta a ponta`;
}

/** Quantos candidatos de lote a tarefa nomeia, no máximo (o teto do lote cabe em 3 itens; o resto fica na fila). */
export const CONDUCTOR_BATCH_CANDIDATES_MAX = 8;

/**
 * A TAREFA de um condutor de correção/manutenção com CANDIDATOS de lote (fase 7, decisão 5 do dono): a de sempre + os
 * ids dos itens da MESMA funcionalidade que esperam na fila. Só os ids — quem escolhe é a sessão (`claim_batch`, tudo ou
 * nada, antes de submeter o plano). Sem candidato, a tarefa de sempre. PURA.
 */
export function conductorBatchTask(board: string, cardId: string, candidates: readonly string[]): string {
  const ids = [...new Set(candidates.filter((id) => id !== cardId && /^[A-Za-z0-9_.-]{1,80}$/.test(id)))].slice(0, CONDUCTOR_BATCH_CANDIDATES_MAX);
  if (!ids.length) return conductorTask(board, cardId);
  return (
    `${conductorTask(board, cardId)} — LOTE possível: ${ids.join(", ")} esperam na fila, na mesma funcionalidade ` +
    `(correção/manutenção). Escolha quais levar (ref/batch.md) e pegue-os com claim_batch ANTES de submeter o plano`
  );
}

export type ConductorEntryVerdict = { dispatch: true } | { dispatch: false; reason: string; scopeRefused?: true };

/**
 * A classe de ESPERA da fila do condutor quando o card é de um tipo que o escopo do board não deixa começar (board-pace.ts,
 * segundo eixo do ritmo). Estável (o texto do motivo traz a frase do tipo); é o `lastWaitKind` da entrada na fila.
 */
export const CONDUCTOR_SCOPE_WAIT_KIND = "tipo-nao-admitido";

/**
 * Does the card's CURRENT status make it a conductor dispatch? PURE — the shell calls it on every entry.
 * Only STORY cards are conducted (activities/steps are map structure; a capture container or a style-guide
 * container is not a unit of delivery), and only a non-terminal `fromStatus` (a terminal status is "done").
 *
 * `gate` (opcional): o portão do board com o ESCOPO DE TIPOS. O condutor leva a story de ponta a ponta, então a pergunta
 * é `use: "conductor"` (qualquer coluna): uma funcionalidade nova que o board não pode começar NÃO é despachada. A recusa
 * por tipo é a ÚLTIMA — só aparece quando todo o resto admitiria — e vem marcada (`scopeRefused`) para quem chama distinguir
 * «espera pelo escopo» (o card volta sozinho quando o escopo alargar) de «não é caso de condutor». Sem `gate`, a régua é a de sempre.
 */
export function conductorEntryVerdict(
  card: Pick<Card, "type" | "status" | "capture" | "container" | "deferred"> & Partial<Pick<Card, "id" | "storyType" | "mode" | "reopenPending">>,
  config: BoardConfig,
  gate?: Pick<BoardGate, "scope"> | null,
): ConductorEntryVerdict {
  // «Adiado — não agora» (deferral.ts): o dono quer, mas não agora. Nem a entrada nem a adoção de órfãos o admitem.
  if (card.deferred) return { dispatch: false, reason: "card adiado (não agora)" };
  // Fase 6 (6D) — a REABERTURA pendente (refinar/reportar bug, reopen.ts) roda a skill dela PRIMEIRO, no passo de destino
  // (skip-routing.ts `triggerForCard`); ela limpa `reopenPending` e só então o card pode ganhar um condutor. Antes o
  // condutor era chamado por cima e parava no PRE-VOO (P0) — uma sessão gasta para nada.
  if (card.reopenPending) return { dispatch: false, reason: "reabertura pendente — a skill da reabertura roda antes do condutor" };
  const policy = resolveConductorPolicy(config);
  if (!policy) return { dispatch: false, reason: "conductor desligado neste board" };
  if (!card.status || !policy.fromStatuses.includes(card.status)) {
    return { dispatch: false, reason: `status '${card.status}' fora de fromStatus [${policy.fromStatuses.join(", ")}]` };
  }
  if (card.type !== "story") return { dispatch: false, reason: `card do tipo '${card.type}' não é conduzido (só story)` };
  if (card.capture || card.container) return { dispatch: false, reason: "contêiner (captura/guia) não é conduzido" };
  if (config.statuses.find((s) => s.id === card.status)?.terminal) return { dispatch: false, reason: "fromStatus é terminal" };
  if (gate) {
    const scope = gateAdmitsCard(gate, { id: card.id ?? "", type: card.type, storyType: card.storyType ?? null, mode: card.mode, status: card.status }, "conductor");
    if (!scope.admit) return { dispatch: false, reason: scope.why, scopeRefused: true };
  }
  return { dispatch: true };
}


/**
 * Why a board's `conductor` block can never fire — or null. PURE. An `enabled: true` whose `fromStatus` names no
 * status of the board (a typo, a renamed column) would be the worst kind of failure: declared, accepted by the
 * contract, and silently inert. The board reader surfaces it as a LOUD drift alarm (it never refuses the read —
 * a board does not go dark over a knob), and the lint half is here so it can be tested.
 */
export function conductorConfigProblem(config: Pick<BoardConfig, "conductor" | "statuses">): string | null {
  const c = config.conductor;
  if (!c?.enabled) return null;
  // Each id of the list is judged on its own: ONE typo in a list of four is a quarter of the acceptances that
  // never get a conductor — as inert as a wrong single status, just harder to notice.
  for (const id of conductorFromStatuses(c.fromStatus)) {
    const st = config.statuses.find((s) => s.id === id);
    if (!st) return `conductor.fromStatus '${id}' não é um status deste board — a dispatch do condutor NUNCA dispararia para ele`;
    if (st.terminal) return `conductor.fromStatus '${id}' é terminal — um card pronto nunca ganha condutor`;
  }
  return null;
}
