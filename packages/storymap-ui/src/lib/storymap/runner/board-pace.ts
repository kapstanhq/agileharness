// O RITMO DO BOARD — pausar, andar devagar ou andar normal. PURO (zero IO; o arquivo mora em board-pace-store.ts e a
// ação com os efeitos, em board-pace-actions.ts).
//
// POR QUE EXISTE: o único interruptor por board era `autorunDisabled`, no board.yaml — sem botão (só um
// agente o acionava), liga/desliga apenas, sem dizer quem desligou nem por quê, sem prazo, e sem parar o que já estava
// rodando. O operador pediu um jeito de ele E o agente que orquestra pausarem um board inteiro para não gastar cota à toa,
// e de ajustarem a velocidade sem editar configuração.
//
// TRÊS POSIÇÕES:
//   • `paused` — nada automático COMEÇA no board. O que estava rodando termina (`drain`) ou é parado e guardado para
//     voltar na retomada (`stop`).
//   • `slow`   — um card por vez (uma sessão de condutor, um run de coluna) e sem os automáticos de fundo (o auditor
//     sorteado, o copiloto). O que destrava o card em voo (procurador, juiz, provas, vigia) segue.
//   • `normal` — o que o board declara.
//
// O PORTÃO ÚNICO: {@link resolveBoardGate} responde por `autorunDisabled` (o board nunca armado) E pelo ritmo. Todo
// automático pergunta a ele — nenhum lê `autorunDisabled` por conta própria (board-pace.gate.test.ts guarda isso).
//
// DUAS CAMADAS, e o ritmo em vigor é o MAIS LENTO delas (regra do operador: «um agente só desfaz a pausa que um agente
// fez»). Cada board guarda um freio do DONO e um freio dos AGENTES, separados:
//   • desacelerar é de todos — um agente põe (ou aperta) o freio dos agentes em qualquer board;
//   • o agente só mexe na camada dele: nunca passa do que o dono fixou, e nada do que ele grave muda o freio do dono
//     (nem o prazo, nem o modo, nem «de quem é» a pausa — era a brecha de uma camada só: re-pausar por cima virava o
//     agente o autor, e ele retomava);
//   • o dono manda nas duas: a escolha dele substitui o freio dele e apaga o dos agentes.
//
// O ESTADO É DE OPERAÇÃO, não do produto: fica no estado do runner (como a trava de capacidade), não no board.yaml —
// pausar não gera commit de board, e o `autorunDisabled` continua sendo só «este board nunca foi armado».
//
// UM SEGUNDO EIXO, INDEPENDENTE DO RITMO — o ESCOPO DE TIPOS: o ritmo diz QUANTO / QUÃO RÁPIDO o board anda; o escopo diz
// O QUÊ ele pode COMEÇAR sozinho (hoje: «Só consertos e manutenção» = tudo menos funcionalidade nova). NÃO é um quarto
// nível de ritmo: quebraria a ordem linear (`paceRank`), o teto (`paceCap`) e a regra «acelerar». A matriz:
//   • pausado            ⇒ o escopo é irrelevante (nada começa);
//   • devagar + escopo   ⇒ um por vez, só dentro do escopo, sem os de fundo;
//   • normal  + escopo   ⇒ velocidade cheia, mas nada de tipo fora do escopo começa.
// Mesmas DUAS CAMADAS do ritmo (dono / agentes), cada uma com prazo próprio; o escopo em vigor é a INTERSEÇÃO dos tipos
// admitidos pelas camadas. Um agente só limita (e só desfaz o limite que um agente pôs); só o dono alarga, e o que o dono
// grava apaga o escopo dos agentes. Ver `effectiveScope`, `gateAdmitsCard`, `applyScopeChange`.

import type { StoryType } from "@/lib/storymap/frameworks";
import { cardTypeKeys } from "@/lib/storymap/kanban-filter";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import { ORGANIZE_ONLY_WHY } from "@/lib/storymap/organize-only-core";

export type PaceLevel = "paused" | "slow" | "normal";
export const PACE_LEVELS: readonly PaceLevel[] = ["paused", "slow", "normal"];
export function isPaceLevel(v: unknown): v is PaceLevel {
  return typeof v === "string" && (PACE_LEVELS as readonly string[]).includes(v);
}

/** A ordem das posições: maior = mais rápido. PURA. */
const RANK: Record<PaceLevel, number> = { paused: 0, slow: 1, normal: 2 };
export function paceRank(level: PaceLevel): number {
  return RANK[level];
}

/** Como a pausa trata o que já está rodando: `drain` deixa terminar, `stop` para e guarda para a retomada. */
export type PauseMode = "drain" | "stop";
export function isPauseMode(v: unknown): v is PauseMode {
  return v === "drain" || v === "stop";
}

/** Quem mudou o ritmo. `id` é um rótulo de auditoria (o nome do token do agente), nunca um segredo. */
export interface PaceActor {
  kind: "owner" | "agent";
  id?: string;
}

/** UM freio (o do dono ou o dos agentes): o ritmo que ele impõe, quem pôs, quando, por quê e até quando. */
export interface PaceHold {
  level: Exclude<PaceLevel, "normal">;
  by: PaceActor;
  at: string;
  reason?: string;
  /** ISO — quando este freio sai sozinho (ou afrouxa para {@link resumeTo}). Ausente = sem prazo. */
  until?: string;
  /** a pausa com prazo foi posta sobre um board que andava devagar: vencido o prazo, o freio volta a `slow`. */
  resumeTo?: "slow";
  mode?: PauseMode;
}

/**
 * O que a pausa (ou o escopo) segurou num card, para devolver quando ela sair. Uma entrada por (card, CAUSA): a pausa e o
 * escopo guardam e devolvem as suas separadamente — sair da pausa não devolve o que o escopo ainda segura, e alargar o
 * escopo não devolve o que a pausa ainda segura.
 */
export interface PaceHeldEntry {
  cardId: string;
  /**
   * `stopped` = um run em voo foi parado (pausa); `entry` = o card entrou num passo e o disparo foi retido (pausa);
   * `scope` = o card está fora do que o board pode começar (escopo): um run da fila foi tirado, ou um disparo recusado.
   */
  why: "stopped" | "entry" | "scope";
  at: string;
}

/** Uma mudança de ritmo, para o histórico curto do board. `level` é o que foi PEDIDO. */
export interface PaceChange {
  level: PaceLevel;
  by: PaceActor;
  at: string;
  reason?: string;
  until?: string;
  mode?: PauseMode;
  /** a mudança foi o PRAZO vencendo (ninguém clicou). */
  expired?: true;
}

/** A linha de um board no arquivo de ritmo. Board sem linha (ou sem freio nenhum) = `normal`. */
export interface BoardPaceRow {
  board: string;
  /** o freio do dono. */
  owner?: PaceHold;
  /** o freio dos agentes. */
  agent?: PaceHold;
  /** o escopo de tipos do dono (ausente = todos os tipos). Só existe no arquivo VERSÃO 2. */
  ownerScope?: PaceScope;
  /** o escopo de tipos dos agentes (ausente = todos os tipos). Só existe no arquivo VERSÃO 2. */
  agentScope?: PaceScope;
  held?: PaceHeldEntry[];
  history?: PaceChange[];
  /** as últimas mudanças de ESCOPO (separado de `history`: um binário antigo não deve ler escopo como ritmo). */
  scopeHistory?: ScopeRecord[];
}

/** Quantas mudanças o histórico guarda (as mais recentes). */
export const PACE_HISTORY_MAX = 20;
/** O teto de entradas retidas guardadas por board (um board pausado por dias não pode crescer sem fim). */
export const PACE_HELD_MAX = 500;
/** Em `slow`: quantas sessões de condutor, e quantos runs de coluna, o board carrega de uma vez. */
export const SLOW_MAX_PARALLEL = 1;
/** O prazo máximo de um freio com volta automática (30 dias): acima disso, é um freio sem prazo. */
export const PACE_UNTIL_MAX_MS = 30 * 24 * 60 * 60_000;
export const PACE_REASON_MAX = 300;

function validIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

// ── os freios em vigor ───────────────────────────────────────────────────────────────────────────────

/** O prazo deste freio já venceu? PURA. */
export function holdExpired(h: Pick<PaceHold, "until"> | null | undefined, now: number): boolean {
  return !!h && validIso(h.until) && Date.parse(h.until) <= now;
}

/**
 * O freio EM VIGOR agora: o próprio, enquanto o prazo não vence; vencido, o `slow` para onde ele afrouxa — ou nada. O
 * prazo vencido já conta, mesmo antes de a varredura gravar. PURA.
 */
export function liveHold(h: PaceHold | null | undefined, now: number): PaceHold | null {
  if (!h) return null;
  if (!holdExpired(h, now)) return h;
  if (h.level === "paused" && h.resumeTo === "slow") return { level: "slow", by: h.by, at: h.until as string, ...(h.reason ? { reason: h.reason } : {}) };
  return null;
}

/** O freio que MANDA agora: o mais lento dos dois em vigor (empate: o do dono). Null = ritmo normal. PURA. */
export function holdInForce(row: BoardPaceRow | null | undefined, now: number): PaceHold | null {
  const owner = liveHold(row?.owner, now);
  const agent = liveHold(row?.agent, now);
  if (!owner || !agent) return owner ?? agent;
  return paceRank(agent.level) < paceRank(owner.level) ? agent : owner;
}

/** O ritmo em vigor AGORA. PURA. */
export function effectivePaceLevel(row: BoardPaceRow | null | undefined, now: number): PaceLevel {
  return holdInForce(row, now)?.level ?? "normal";
}

/** O modo da pausa em vigor: `stop` se algum freio que pausa pediu «parar agora». Null fora da pausa. PURA. */
export function effectivePauseMode(row: BoardPaceRow | null | undefined, now: number): PauseMode | null {
  const pausing = [liveHold(row?.owner, now), liveHold(row?.agent, now)].filter((h): h is PaceHold => h?.level === "paused");
  if (!pausing.length) return null;
  return pausing.some((h) => h.mode === "stop") ? "stop" : "drain";
}

/** Algum freio da linha tem prazo vencido e ainda não varrido? PURA. */
export function paceExpired(row: BoardPaceRow | null | undefined, now: number): boolean {
  return holdExpired(row?.owner, now) || holdExpired(row?.agent, now);
}

// ── o ESCOPO DE TIPOS ────────────────────────────────────────────────────────────────────────────────

/**
 * Os tipos de story que o escopo conhece, NA ORDEM em que a tela os mostra (a única «funcionalidade nova» é o `user`).
 * É também a ordem canônica de toda lista de tipos guardada ou devolvida por aqui.
 */
export const SCOPE_TYPE_ORDER: readonly StoryType[] = ["user", "bug", "technical", "chore", "spike"];

/** As palavras fixas dos tipos, para o dono — sem jargão. (Re-exportadas por board-pace-words.ts.) */
export const SCOPE_TYPE_WORDS: Record<StoryType, string> = {
  user: "Funcionalidade nova",
  bug: "Erro",
  technical: "Trabalho técnico",
  chore: "Manutenção",
  spike: "Investigação",
};

/** O preset «Só consertos e manutenção»: tudo que NÃO é funcionalidade nova (erro, trabalho técnico, manutenção, investigação). */
export const FIXES_ONLY_TYPES: readonly StoryType[] = ["bug", "technical", "chore", "spike"];

export function isScopeType(v: unknown): v is StoryType {
  return typeof v === "string" && (SCOPE_TYPE_ORDER as readonly string[]).includes(v);
}

/** Tira o repetido e o desconhecido e põe na ordem canônica. PURA. */
export function normalizeScopeTypes(types: readonly unknown[]): StoryType[] {
  return SCOPE_TYPE_ORDER.filter((t) => types.includes(t));
}

/** «Erro, Trabalho técnico e Manutenção». PURA. */
export function scopeTypesPhrase(types: readonly StoryType[]): string {
  const words = normalizeScopeTypes(types).map((t) => SCOPE_TYPE_WORDS[t]);
  if (words.length <= 1) return words[0] ?? "nenhum tipo";
  return `${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}`;
}

/** Os presets que a tela oferece (a lista guardada já aceita qualquer combinação — a escolha livre vem depois). */
export type ScopePreset = "all" | "fixes" | "custom";

/** Qual preset é esta lista? `null` (sem escopo) = «Tudo». PURA. */
export function scopePresetOf(types: readonly StoryType[] | null): ScopePreset {
  if (!types) return "all";
  const set = normalizeScopeTypes(types);
  if (set.length === SCOPE_TYPE_ORDER.length) return "all";
  return set.length === FIXES_ONLY_TYPES.length && FIXES_ONLY_TYPES.every((t) => set.includes(t)) ? "fixes" : "custom";
}

/**
 * UMA camada do escopo (a do dono ou a dos agentes): os tipos que ela ADMITE, quem pôs, quando, por quê e até quando.
 * Nunca guarda «todos os tipos» — isso é a ausência da camada.
 */
export interface PaceScope {
  /** os tipos admitidos (ordem canônica, sem repetição, nunca vazio). */
  types: StoryType[];
  by: PaceActor;
  at: string;
  reason?: string;
  /** ISO — quando esta camada sai sozinha (o escopo alarga). Ausente = sem prazo. */
  until?: string;
}

/** Uma mudança de escopo, para o histórico curto. `types` null = «Tudo» (a camada saiu). */
export interface ScopeRecord {
  types: StoryType[] | null;
  by: PaceActor;
  at: string;
  reason?: string;
  until?: string;
  /** a mudança foi o PRAZO vencendo (ninguém clicou). */
  expired?: true;
}

/** O pedido de mudança de escopo (a entrada de {@link applyScopeChange} e de changeBoardScopeNow). */
export interface ScopeChange {
  board: string;
  /** os tipos que o board pode COMEÇAR; `"all"` (ou os cinco) = sem limite. */
  types: readonly StoryType[] | "all";
  by: PaceActor;
  reason?: string;
  /** em quantos minutos o limite sai sozinho (só vale para um limite, não para «Tudo»). */
  forMinutes?: number;
}

/** O prazo desta camada já venceu? PURA. */
export function scopeLayerExpired(s: Pick<PaceScope, "until"> | null | undefined, now: number): boolean {
  return holdExpired(s, now);
}

/** A camada em vigor agora (prazo vencido = já saiu, mesmo antes de a varredura gravar). PURA. */
export function liveScope(s: PaceScope | null | undefined, now: number): PaceScope | null {
  return s && !scopeLayerExpired(s, now) ? s : null;
}

/** O escopo que MANDA agora: a interseção dos tipos admitidos pelas camadas em vigor. */
export interface EffectiveScope {
  /** os tipos que o board pode começar (a interseção; ordem canônica; pode ser vazio numa edição à mão). */
  types: StoryType[];
  /** a camada que mais estreita (empate: a do dono) — quem pôs, quando, por quê, até quando. */
  by: PaceActor;
  at: string;
  reason?: string;
  until?: string;
  /** o limite do DONO (um agente não passa disso); null = o dono não limita. */
  ownerTypes: StoryType[] | null;
  /** o limite dos agentes; null = nenhum. */
  agentTypes: StoryType[] | null;
}

/**
 * O escopo em vigor AGORA: a INTERSEÇÃO dos tipos admitidos pelas camadas vivas. Null = nenhum limite (todos os tipos
 * podem começar). Uma camada com prazo vencido já não conta. PURA.
 */
export function effectiveScope(row: BoardPaceRow | null | undefined, now: number): EffectiveScope | null {
  const owner = liveScope(row?.ownerScope, now);
  const agent = liveScope(row?.agentScope, now);
  if (!owner && !agent) return null;
  const types = SCOPE_TYPE_ORDER.filter((t) => (!owner || owner.types.includes(t)) && (!agent || agent.types.includes(t)));
  if (types.length === SCOPE_TYPE_ORDER.length) return null;
  const layer = !agent ? (owner as PaceScope) : !owner ? agent : agent.types.length < owner.types.length ? agent : owner;
  return {
    types,
    by: layer.by,
    at: layer.at,
    ...(layer.reason ? { reason: layer.reason } : {}),
    ...(layer.until ? { until: layer.until } : {}),
    ownerTypes: owner ? owner.types : null,
    agentTypes: agent ? agent.types : null,
  };
}

/** Os tipos admitidos por um escopo (null = todos). */
function admittedTypes(s: Pick<EffectiveScope, "types"> | null | undefined): readonly StoryType[] {
  return s ? s.types : SCOPE_TYPE_ORDER;
}

/** O escopo ALARGOU: algum tipo antes recusado passou a ser admitido. PURA. */
export function scopeWidened(before: EffectiveScope | null, after: EffectiveScope | null): boolean {
  const b = admittedTypes(before);
  return admittedTypes(after).some((t) => !b.includes(t));
}

/** O escopo ESTREITOU: algum tipo antes admitido passou a ser recusado. PURA. */
export function scopeNarrowed(before: EffectiveScope | null, after: EffectiveScope | null): boolean {
  const a = admittedTypes(after);
  return admittedTypes(before).some((t) => !a.includes(t));
}

// ── a pergunta POR CARD ──────────────────────────────────────────────────────────────────────────────

/**
 * A FRONTEIRA DA CONSTRUÇÃO — as colunas em que um card de tipo fora do escopo NÃO COMEÇA a construir sozinho: o plano técnico,
 * a decomposição em tarefas e o desenvolvimento. (Medido no board base, `storymap/boards/_base/board.yaml`, coluna
 * «Construção» menos o buffer `ready` e menos as duas colunas de fechamento, abaixo.) UMA lista nomeada; o teste a confere
 * contra o board base. `quebrar-tasks` é a coluna de tarefas dos boards de produto antigos (a canônica decompõe no
 * `plano-tecnico`).
 *
 * O QUE JÁ COMEÇOU TERMINA (decisão do dono: «deixa terminar»): `revisar-codigo` e `qa-automatizado` NÃO estão aqui, embora o
 * board base as ponha na coluna «Construção». Um card só chega a elas depois de o `desenvolver` ter escrito o código; barrá-las
 * deixaria a funcionalidade PARADA e anotada, com código escrito e sem revisão nem QA, sem nunca chegar à entrega. O escopo
 * barra o COMEÇO da construção; revisar e provar o que já foi escrito é terminar. (Limite conhecido: quem MOVE um card de
 * funcionalidade direto para uma delas, sem passar pelo `desenvolver`, não é barrado por este escopo — mover card é uma
 * decisão explícita do dono ou do agente, e as comportas de cada coluna seguem valendo.)
 *
 * FICAM FORA, e andam normalmente para o tipo ser decidido: captura, triagem, dúvidas, especificação (`enriquecer`),
 * entrevista, estimativa (`priorizar`), o go/no-go (`pronta`), o design, e as portas de reentrada (`refinar`, `corrigir`,
 * `descontinuar` — diagnóstico, não construção). Também ficam fora as colunas de ENTREGA (`revisao`, `merge`, `stage`,
 * `release`, `deploy`): terminar e publicar o que já foi construído não é «começar» (a fila de publicação, o merge train, o
 * run manual e as ações do operador nunca são barrados pelo escopo).
 */
export const SCOPE_BUILD_STATUSES: readonly string[] = ["plano-tecnico", "quebrar-tasks", "desenvolver"];

/**
 * As colunas de FECHAMENTO da construção — revisão de código e QA automatizada: o que o `desenvolver` deixou escrito termina
 * aqui e segue para a entrega, mesmo que o escopo tenha estreitado no meio do caminho. Não são barradas (ver {@link SCOPE_BUILD_STATUSES}).
 */
export const SCOPE_FINISHING_STATUSES: readonly string[] = ["revisar-codigo", "qa-automatizado"];

/**
 * As colunas em que um card de funcionalidade fora do escopo ESPERA para ser construído (o que o painel conta como
 * «esperando»): do go/no-go e do design até o desenvolvimento. Fora disso o card ainda está sendo decidido, está terminando
 * (revisão e QA) ou já foi construído. Quem conta de fato como segurado é {@link scopeHoldsCard}.
 */
export const SCOPE_WAITING_STATUSES: readonly string[] = ["pronta", "design-ux", "design-ui", "com-design", "ready", ...SCOPE_BUILD_STATUSES];

/** As colunas de ENTREGA: o código já construído esperando para ir (ou indo) ao ar com a próxima publicação. */
export const SCOPE_DELIVERY_STATUSES: readonly string[] = ["revisao", "merge", "stage", "release"];

/**
 * As colunas em que o tipo AINDA está sendo decidido (a captura é `user` por padrão; é a especificação — `enriquecer` — que
 * classifica de verdade). Até aqui, classificar um card é livre; depois, mudar de `user` para outro tipo é do dono.
 */
export const SCOPE_CLASSIFYING_STATUSES: readonly string[] = ["capturando", "triage", "grill", "enriquecer"];

/** O que a pergunta por card lê do card (um `Pick`, para os testes e os núcleos). */
export type ScopeCard = Pick<Card, "id" | "type" | "storyType" | "mode" | "status">;

/** O que o escopo precisa saber de um card, tirado do card na mão — todo chamador do engine que já leu o card o passa (`scopeCard`). */
export function scopeCardOf(card: Pick<Card, "id" | "type" | "storyType" | "mode" | "status">): ScopeCard {
  return { id: card.id, type: card.type, storyType: card.storyType, mode: card.mode, status: card.status };
}

/** Quem pergunta: um passo de COLUNA (só a construção é barrada) ou o CONDUTOR (carrega a story de ponta a ponta — qualquer coluna). */
export type ScopeUse = "column" | "conductor";

export interface ScopeVerdict {
  admit: boolean;
  /** a frase para o motivo de espera e para o log — sem jargão. Vazia quando admite. */
  why: string;
}

const ADMIT: ScopeVerdict = { admit: true, why: "" };

/** Esta coluna é de construção (a fronteira do escopo)? */
export function scopeGatesStatus(status: string | null | undefined): boolean {
  return !!status && SCOPE_BUILD_STATUSES.includes(status);
}

/**
 * O card é uma FUNCIONALIDADE NOVA? A única é a story `user`; um `user` em modo `fix` conta como erro (o tipo EFETIVO
 * `cardTypeKeys`: um card pode ter mais de um). Só story entra na regra. PURA.
 */
export function isNewFeatureCard(card: Pick<Card, "type" | "storyType" | "mode">): boolean {
  return card.type === "story" && cardTypeKeys(card).every((t) => t === "user");
}

/**
 * A pergunta POR CARD, sobre um escopo já resolvido. Só story entra na regra (ideia, atividade, passo e contêiner seguem
 * como sempre). Um card admite se QUALQUER um dos tipos efetivos dele está no escopo. Em `column`, só a construção é
 * barrada; em `conductor`, a coluna não importa (o condutor leva a story inteira). PURA.
 */
export function scopeAdmitsCard(scope: EffectiveScope | null | undefined, card: ScopeCard, use: ScopeUse = "column"): ScopeVerdict {
  if (!scope || card.type !== "story") return ADMIT;
  if (use === "column" && !scopeGatesStatus(card.status)) return ADMIT;
  const keys = cardTypeKeys(card);
  if (keys.some((t) => scope.types.includes(t))) return ADMIT;
  return { admit: false, why: `${SCOPE_TYPE_WORDS[keys[0]]} fica de fora: o board só começa ${scopeTypesPhrase(scope.types)} por enquanto` };
}

/**
 * A pergunta POR CARD que todo automático que COMEÇA trabalho faz, logo depois do portão do board. Admite o que o escopo
 * do portão admite. Portão sem escopo (ou sem o campo) admite tudo. PURA.
 */
export function gateAdmitsCard(gate: Pick<BoardGate, "scope">, card: ScopeCard, use: ScopeUse = "column"): ScopeVerdict {
  return scopeAdmitsCard(gate.scope, card, use);
}

/** O que a pergunta «o escopo está segurando este card?» lê do card: os campos do escopo mais o roteamento (quem o conduz). */
export type ScopeHoldCard = ScopeCard & Partial<Pick<Card, "routing">>;

/** O contexto do board que a pergunta precisa (tudo opcional: sem ele, a régua de um board sem condutor e sem nada em voo). */
export interface ScopeHoldContext {
  /** os status de despacho do condutor do board (`conductor.fromStatus`); ausente = o board não tem condutor. */
  conductorFrom?: readonly string[];
  /** os ids dos cards com um run do engine em voo agora (o que executa TERMINA — não está esperando). */
  inFlight?: ReadonlySet<string>;
}

/**
 * Os status em que o escopo SEGURA de verdade um card que ninguém conduz e que nenhum run executa: a construção (a coluna de
 * skill recusa o disparo na entrada) e, num board com condutor, os status de despacho dele (o condutor não é despachado) —
 * menos os de classificação, onde a skill de especificação roda e só o despacho espera. Design (`design-ux`/`design-ui`/
 * `com-design`), a espera `pronta`/`ready` e o fechamento (revisão e QA) NÃO são barrados: ali o card anda. PURA.
 */
export function scopeHoldStatuses(conductorFrom: readonly string[] = []): readonly string[] {
  return [...SCOPE_BUILD_STATUSES, ...conductorFrom.filter((s) => !SCOPE_BUILD_STATUSES.includes(s) && !SCOPE_CLASSIFYING_STATUSES.includes(s))];
}

/**
 * O escopo está SEGURANDO este card agora? É a pergunta única do painel («N cards esperando») e da linha do card
 * («Esperando: fora do que o board pode começar»): só vale para o card parado num status que o escopo realmente barra, que
 * ninguém conduz (um condutor vivo ou parado já tem a sua linha — o que começou antes de estreitar termina) e que nenhum run
 * executa (idem). PURA.
 */
export function scopeHoldsCard(scope: EffectiveScope | null | undefined, card: ScopeHoldCard, ctx: ScopeHoldContext = {}): boolean {
  if (!scope || card.type !== "story" || !card.status) return false;
  if (card.routing?.driver === "conductor") return false;
  if (ctx.inFlight?.has(card.id)) return false;
  if (!scopeHoldStatuses(ctx.conductorFrom).includes(card.status)) return false;
  return !scopeAdmitsCard(scope, card, "conductor").admit;
}

/** Quantos cards o escopo está segurando agora (o «N cards esperando» do painel; ver {@link scopeHoldsCard}). PURA. */
export function scopeWaitingCount(cards: readonly ScopeHoldCard[], scope: EffectiveScope | null | undefined, ctx: ScopeHoldContext = {}): number {
  if (!scope) return 0;
  return cards.filter((c) => scopeHoldsCard(scope, c, ctx)).length;
}

/** Quantas funcionalidades novas já construídas esperam na entrega e vão junto na próxima publicação. PURA. */
export function featuresInDelivery(cards: readonly ScopeCard[]): number {
  return cards.filter((c) => isNewFeatureCard(c) && !!c.status && SCOPE_DELIVERY_STATUSES.includes(c.status)).length;
}

// ── a troca de tipo (R6) ─────────────────────────────────────────────────────────────────────────────

/**
 * Por que ESTE ator não pode trocar o tipo DESTE card — ou null. Enquanto o escopo limita o board, o tipo é a catraca: um
 * agente que reclassificasse uma funcionalidade já classificada como «Manutenção» furaria o limite. Então: um card que JÁ
 * estava classificado como `user` (passou da especificação) só o DONO troca para outro tipo; classificar um card NOVO (ainda
 * na captura/triagem/dúvidas/especificação) continua livre. Sem escopo, ou para o dono, nunca recusa. PURA.
 */
export function storyTypeChangeRefusal(
  scope: EffectiveScope | null | undefined,
  card: Pick<Card, "type" | "storyType" | "status">,
  after: StoryType,
  actor: PaceActor,
): string | null {
  if (!scope || actor.kind === "owner" || card.type !== "story") return null;
  const before = card.storyType ?? "user";
  if (before !== "user" || after === "user") return null;
  if (!card.status || SCOPE_CLASSIFYING_STATUSES.includes(card.status)) return null;
  return (
    `Este card já está classificado como ${SCOPE_TYPE_WORDS.user} e o board só começa ${scopeTypesPhrase(scope.types)} por enquanto: ` +
    `só o dono troca o tipo dele (abra o card e troque o tipo, ou peça no Inbox). Um agente classifica o que ainda é novo.`
  );
}

/** A linha da trilha de auditoria de uma troca de tipo sob escopo: antes, depois e autor. PURA. */
export function storyTypeChangeLine(card: Pick<Card, "id" | "storyType">, after: StoryType, actor: PaceActor): string {
  const who = actor.kind === "owner" ? "pelo dono" : `por um agente${actor.id ? ` (${actor.id})` : ""}`;
  return `${card.id}: tipo ${SCOPE_TYPE_WORDS[card.storyType ?? "user"]} → ${SCOPE_TYPE_WORDS[after]} ${who}, com o escopo do board limitado`;
}

// ── o portão ─────────────────────────────────────────────────────────────────────────────────────────

/** De onde veio a resposta do portão. */
export type BoardGateSource = "organize-only" | "disarmed" | "pace" | "unreadable" | "default";

/** O que TODO automático pergunta antes de começar algo num board. */
export interface BoardGate {
  level: PaceLevel;
  /** nada automático começa (pausado, desarmado, ou o arquivo de ritmo não se lê). */
  held: boolean;
  /** os automáticos de fundo rodam (só em `normal`). */
  background: boolean;
  source: BoardGateSource;
  /** a frase para o motivo de espera e para o log — sem jargão. */
  why: string;
  /**
   * O ESCOPO DE TIPOS em vigor (segundo eixo, independente do ritmo): o que o board pode COMEÇAR. Ausente/null = todos os
   * tipos (e é o que as portas montadas à mão, sem o campo, dizem). Pergunte por card com {@link gateAdmitsCard}. Só vem
   * preenchido quando o portão responde pelo ritmo ou pelo padrão — desarmado e ilegível seguram tudo antes de olhar tipo.
   */
  scope?: EffectiveScope | null;
}

const WHO: Record<PaceActor["kind"], string> = { owner: "pelo dono", agent: "por um agente" };

/**
 * O PORTÃO. `config` é a configuração do board (null = ilegível ⇒ segura, a direção segura); `row` é a linha de ritmo
 * (ausente = normal); `unreadable` diz que o ARQUIVO de ritmo existe e não se lê — ilegível não é «sem pausa»: lido
 * como vazio, um board que o dono pausou voltaria a gastar sozinho. PURA.
 */
export function resolveBoardGate(
  config: Pick<BoardConfig, "autorunDisabled" | "organizeOnly"> | null | undefined,
  row: BoardPaceRow | null | undefined,
  now: number,
  unreadable = false,
): BoardGate {
  if (!config) return { level: "paused", held: true, background: false, source: "unreadable", why: "a configuração do board não pôde ser lida" };
  // Só organização vem ANTES do desarmado: é o mais forte (nada age nem chega sozinho — organize-only.ts).
  if (config.organizeOnly) return { level: "paused", held: true, background: false, source: "organize-only", why: ORGANIZE_ONLY_WHY };
  if (config.autorunDisabled) return { level: "paused", held: true, background: false, source: "disarmed", why: "o board está desarmado (o autorun dele está desligado)" };
  if (unreadable) {
    return { level: "paused", held: true, background: false, source: "unreadable", why: "o registro de ritmo dos boards não pôde ser lido — retome o board para regravá-lo" };
  }
  const hold = holdInForce(row, now);
  const scope = effectiveScope(row, now);
  if (!hold) return { level: "normal", held: false, background: true, source: row ? "pace" : "default", why: "ritmo normal", scope };
  if (hold.level === "slow") return { level: "slow", held: false, background: false, source: "pace", why: `board em ritmo devagar ${WHO[hold.by.kind]}`, scope };
  return { level: "paused", held: true, background: false, source: "pace", why: `board pausado ${WHO[hold.by.kind]}`, scope };
}

/** O portão de quem só tem a configuração (os núcleos sem a porta de ritmo ligada, e os testes deles). PURA. */
export function configOnlyGate(config: Pick<BoardConfig, "autorunDisabled" | "organizeOnly"> | null | undefined): BoardGate {
  return resolveBoardGate(config, null, 0);
}

/** A porta que os núcleos recebem: a produção liga `boardGateNow` (board-pace-store.ts); sem ela, só a configuração responde. */
export type BoardGatePort = (board: string, config: Pick<BoardConfig, "autorunDisabled" | "organizeOnly"> | null | undefined) => BoardGate;

/** O portão pelo que o núcleo tem: a porta injetada, ou só a configuração. PURA (a porta é quem faz IO). */
export function gateOf(port: BoardGatePort | undefined, board: string, config: Pick<BoardConfig, "autorunDisabled" | "organizeOnly"> | null | undefined): BoardGate {
  return port ? port(board, config) : configOnlyGate(config);
}

/** O teto de trabalho em paralelo do board sob o ritmo: `normal` mantém, `slow` vira um por vez, `paused` zera. PURA. */
export function paceCap(max: number, gate: Pick<BoardGate, "level" | "held">): number {
  if (gate.held) return 0;
  return gate.level === "slow" ? Math.min(max, SLOW_MAX_PARALLEL) : max;
}

// ── a mudança ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Por que ESTE ator não pode pedir ESTE ritmo — ou null. A mesma frase na tool, na ação e no botão. PURA.
 * Desacelerar (ou manter) é de todos. O dono manda nas duas camadas; um agente nunca passa do que o dono fixou.
 */
export function paceChangeRefusal(gate: BoardGate, row: BoardPaceRow | null | undefined, next: PaceLevel, actor: PaceActor, now: number): string | null {
  // Com o registro ilegível, QUALQUER gravação o regrava do zero — e os outros boards voltariam a `normal`. Só o dono.
  if (gate.source === "unreadable" && actor.kind !== "owner") return "O registro de ritmo não pôde ser lido: só o dono o regrava (retomando ou pausando o board).";
  if (paceRank(next) <= paceRank(gate.level)) return null;
  if (gate.source === "disarmed") return "Este board está desarmado: armar é um gesto à parte (set_board_autorun), não uma mudança de ritmo.";
  if (actor.kind === "owner") return null;
  const owner = liveHold(row?.owner, now);
  if (owner && paceRank(next) > paceRank(owner.level)) {
    return `O dono segurou este board em «${paceLabel(owner.level)}»: só ele retoma ou acelera além disso. Um agente só desfaz o freio que um agente pôs.`;
  }
  return null;
}

export interface PaceChangeInput {
  board: string;
  level: PaceLevel;
  by: PaceActor;
  reason?: string;
  /** em quantos minutos o ritmo volta sozinho (só para `paused`/`slow`). */
  forMinutes?: number;
  mode?: PauseMode;
}

/** O pedido é válido? Devolve a frase do defeito, ou null. PURA. */
export function paceInputRefusal(input: PaceChangeInput): string | null {
  if (!isPaceLevel(input.level)) return "Ritmo desconhecido: use paused, slow ou normal.";
  if (input.reason != null && input.reason.length > PACE_REASON_MAX) return `O motivo passa de ${PACE_REASON_MAX} caracteres.`;
  if (input.forMinutes != null) {
    if (input.level === "normal") return "O prazo vale para pausar ou andar devagar, não para o ritmo normal.";
    if (!Number.isFinite(input.forMinutes) || input.forMinutes <= 0) return "O prazo tem de ser um número de minutos maior que zero.";
    if (input.forMinutes * 60_000 > PACE_UNTIL_MAX_MS) return "O prazo máximo é de 30 dias; acima disso, pause sem prazo.";
  }
  if (input.mode != null && !isPauseMode(input.mode)) return "Modo de pausa desconhecido: use drain ou stop.";
  if (input.mode != null && input.level !== "paused") return "O modo (drain/stop) só vale para a pausa.";
  return null;
}

export interface PaceChangeResult {
  /** a linha nova (um board que voltou a `normal` mantém a linha: é ela que guarda o histórico). */
  row: BoardPaceRow;
  /** algo foi gravado de novo (pedir o que já está em vigor, sem prazo novo, não grava). */
  changed: boolean;
  /** o ritmo em vigor DEPOIS da mudança (o mais lento das duas camadas — pode não ser o pedido). */
  level: PaceLevel;
  /** o modo da pausa em vigor depois (null fora da pausa). */
  mode: PauseMode | null;
  /** o board ENTROU em pausa agora: quem chama tira o que está na fila. */
  enteredPause: boolean;
  /** a pausa passou a ser «parar agora»: quem chama para o que está rodando. */
  stopNow: boolean;
  /** saiu de pausado: estas entradas voltam ao pipeline. */
  released: PaceHeldEntry[];
}

const sameHold = (a: PaceHold | undefined, b: PaceHold | undefined): boolean =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.level === b.level &&
    a.by.kind === b.by.kind &&
    (a.until ?? null) === (b.until ?? null) &&
    (a.mode ?? null) === (b.mode ?? null) &&
    (a.resumeTo ?? null) === (b.resumeTo ?? null) &&
    (a.reason ?? null) === (b.reason ?? null));

/**
 * Aplica a mudança à linha do board. Não julga QUEM pode (isso é {@link paceChangeRefusal}, antes). O DONO substitui o
 * freio dele e apaga o dos agentes; um AGENTE só escreve o freio dos agentes. Uma pausa com prazo posta sobre um board
 * devagar volta a `slow` quando vence. O que a pausa segurou atravessa enquanto o board seguir pausado e é devolvido
 * quando ele sai dela. PURA.
 */
export function applyPaceChange(row: BoardPaceRow | null | undefined, input: PaceChangeInput, now: number): PaceChangeResult {
  const before = effectivePaceLevel(row, now);
  const beforeMode = effectivePauseMode(row, now);
  const at = new Date(now).toISOString();
  const reason = input.reason?.trim() || undefined;
  const until = input.forMinutes != null && input.level !== "normal" ? new Date(now + input.forMinutes * 60_000).toISOString() : undefined;
  const mine = input.by.kind === "owner" ? row?.owner : row?.agent;
  const hold: PaceHold | undefined =
    input.level === "normal"
      ? undefined
      : {
          level: input.level,
          by: input.by,
          at,
          // sem motivo novo, o motivo do MESMO freio no mesmo ritmo continua valendo (repetir o pedido não o apaga)
          ...((reason ?? (mine?.level === input.level ? mine.reason : undefined)) ? { reason: reason ?? mine?.reason } : {}),
          ...(until ? { until } : {}),
          ...(until && input.level === "paused" && before === "slow" ? { resumeTo: "slow" as const } : {}),
          ...(input.level === "paused" ? { mode: input.mode ?? "drain" } : {}),
        };
  const owner = input.by.kind === "owner" ? hold : row?.owner;
  const agent = input.by.kind === "owner" ? undefined : hold;
  const changed = !sameHold(owner, row?.owner) || !sameHold(agent, row?.agent);
  if (!changed) {
    return { row: row ?? { board: input.board }, changed: false, level: before, mode: beforeMode, enteredPause: false, stopNow: false, released: [] };
  }
  // O ESCOPO é outro eixo: mudar o ritmo não toca nele (nem o do dono, nem o dos agentes) — por isso `carryScope`.
  const base: BoardPaceRow = { board: input.board, ...(owner ? { owner } : {}), ...(agent ? { agent } : {}), ...carryScope(row) };
  const level = effectivePaceLevel(base, now);
  const mode = effectivePauseMode(base, now);
  const change: PaceChange = { level: input.level, by: input.by, at, ...(reason ? { reason } : {}), ...(until ? { until } : {}), ...(hold?.mode ? { mode: hold.mode } : {}) };
  // O que a linha GRAVADA guarda vale mesmo com um prazo vencido e ainda não varrido: quem segue pausando mantém, quem
  // sai da pausa devolve — nunca se perde uma entrada retida entre o vencimento e a varredura. O que o ESCOPO segura
  // (`why: "scope"`) não é da pausa: atravessa a mudança de ritmo intacto.
  const { pause, scope } = splitHeld(row?.held);
  const kept = [...(level === "paused" ? pause : []), ...scope];
  return {
    row: { ...base, ...(kept.length ? { held: kept } : {}), history: [...(row?.history ?? []), change].slice(-PACE_HISTORY_MAX) },
    changed: true,
    level,
    mode,
    enteredPause: level === "paused" && before !== "paused",
    stopNow: level === "paused" && mode === "stop" && !(before === "paused" && beforeMode === "stop"),
    released: level !== "paused" ? pause : [],
  };
}

/** Separa o que a pausa segura do que o escopo segura (cada um tem a sua hora de voltar). */
function splitHeld(held: readonly PaceHeldEntry[] | undefined): { pause: PaceHeldEntry[]; scope: PaceHeldEntry[] } {
  const all = held ?? [];
  return { pause: all.filter((h) => h.why !== "scope"), scope: all.filter((h) => h.why === "scope") };
}

/** Os campos de ESCOPO da linha — o que toda reescrita da linha por outro motivo tem de levar junto. */
function carryScope(row: BoardPaceRow | null | undefined): Pick<BoardPaceRow, "ownerScope" | "agentScope" | "scopeHistory"> {
  return {
    ...(row?.ownerScope ? { ownerScope: row.ownerScope } : {}),
    ...(row?.agentScope ? { agentScope: row.agentScope } : {}),
    ...(row?.scopeHistory?.length ? { scopeHistory: row.scopeHistory } : {}),
  };
}

// ── a mudança de ESCOPO ──────────────────────────────────────────────────────────────────────────────

/** Os tipos do pedido em lista canônica; `null` = «Tudo» (`"all"` ou os cinco tipos). Desconhecidos saem. PURA. */
export function scopeTypesOf(types: readonly StoryType[] | "all"): StoryType[] | null {
  if (types === "all") return null;
  const set = normalizeScopeTypes(types);
  return set.length === SCOPE_TYPE_ORDER.length ? null : set;
}

/** O pedido de escopo é válido? Devolve a frase do defeito, ou null. PURA. */
export function scopeInputRefusal(input: ScopeChange): string | null {
  if (input.types !== "all") {
    if (!Array.isArray(input.types)) return "Os tipos têm de ser uma lista (ou «all»).";
    if (input.types.some((t) => !isScopeType(t))) return `Tipo desconhecido: use ${SCOPE_TYPE_ORDER.join(", ")}.`;
    if (!input.types.length) return "Escolha ao menos um tipo; para não começar nada, pause o board.";
  }
  if (input.reason != null && input.reason.length > PACE_REASON_MAX) return `O motivo passa de ${PACE_REASON_MAX} caracteres.`;
  if (input.forMinutes != null) {
    if (scopeTypesOf(input.types) === null) return "O prazo vale para limitar o que o board começa, não para liberar tudo.";
    if (!Number.isFinite(input.forMinutes) || input.forMinutes <= 0) return "O prazo tem de ser um número de minutos maior que zero.";
    if (input.forMinutes * 60_000 > PACE_UNTIL_MAX_MS) return "O prazo máximo é de 30 dias; acima disso, limite sem prazo.";
  }
  return null;
}

/**
 * Por que ESTE ator não pode pedir ESTES tipos — ou null. A mesma frase na tool, na ação e no botão. O dono manda nas
 * duas camadas; um agente nunca passa do que o dono admitiu (e, com o registro ilegível, nada grava). PURA.
 */
export function scopeChangeRefusal(gate: Pick<BoardGate, "source">, row: BoardPaceRow | null | undefined, types: readonly StoryType[] | "all", actor: PaceActor, now: number): string | null {
  if (gate.source === "unreadable" && actor.kind !== "owner") return "O registro de ritmo não pôde ser lido: só o dono o regrava (retomando ou pausando o board).";
  if (actor.kind === "owner") return null;
  const owner = liveScope(row?.ownerScope, now);
  if (!owner) return null;
  // «Tudo» pedido por um agente com o limite do DONO vivo é «tirar a camada do agente» — o que sobra é o escopo do dono, nunca
  // além dele (applyScopeChange tira a camada, não grava «todos os tipos»). Recusar seria punir quem só quer desfazer o limite
  // que ele mesmo pôs; o escopo em vigor não alarga.
  const wanted = scopeTypesOf(types);
  if (wanted === null) return null;
  const want = wanted;
  const beyond = want.filter((t) => !owner.types.includes(t));
  if (!beyond.length) return null;
  return `O dono limitou este board a ${scopeTypesPhrase(owner.types)}: só ele alarga o que pode começar (o pedido incluía ${scopeTypesPhrase(beyond)}). Um agente só desfaz o limite que um agente pôs.`;
}

export interface ScopeChangeResult {
  /** a linha nova. */
  row: BoardPaceRow;
  /** algo foi gravado de novo (pedir o que já está em vigor não grava). */
  changed: boolean;
  /** o escopo em vigor antes e depois (null = todos os tipos). */
  before: EffectiveScope | null;
  after: EffectiveScope | null;
  /** algum tipo antes admitido passou a ser recusado: quem chama tira da fila o que ficou fora. */
  narrowed: boolean;
  /** algum tipo antes recusado passou a ser admitido: quem chama devolve o que esperava. */
  widened: boolean;
  /** as entradas que o escopo segurava e voltam ao pipeline (alargou, ou o limite saiu). */
  released: PaceHeldEntry[];
}

const sameScopeLayer = (a: PaceScope | undefined, b: PaceScope | undefined): boolean =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.types.length === b.types.length &&
    a.types.every((t, n) => b.types[n] === t) &&
    a.by.kind === b.by.kind &&
    (a.until ?? null) === (b.until ?? null) &&
    (a.reason ?? null) === (b.reason ?? null));

/**
 * Aplica a mudança de escopo à linha. Não julga QUEM pode (isso é {@link scopeChangeRefusal}, antes). O DONO substitui a
 * camada dele e apaga a dos agentes; um AGENTE só escreve a camada dos agentes. «Tudo» tira a camada. Não toca no ritmo. PURA.
 */
export function applyScopeChange(row: BoardPaceRow | null | undefined, input: ScopeChange, now: number): ScopeChangeResult {
  const before = effectiveScope(row, now);
  const at = new Date(now).toISOString();
  const types = scopeTypesOf(input.types);
  const reason = input.reason?.trim() || undefined;
  const until = types && input.forMinutes != null ? new Date(now + input.forMinutes * 60_000).toISOString() : undefined;
  const mine = input.by.kind === "owner" ? row?.ownerScope : row?.agentScope;
  const sameTypes = !!types && !!mine && types.length === mine.types.length && types.every((t, n) => mine.types[n] === t);
  const layer: PaceScope | undefined = types
    ? {
        types,
        by: input.by,
        at,
        // sem motivo novo, o motivo da MESMA camada com os mesmos tipos continua valendo (repetir o pedido não o apaga)
        ...((reason ?? (sameTypes ? mine?.reason : undefined)) ? { reason: reason ?? mine?.reason } : {}),
        ...(until ? { until } : {}),
      }
    : undefined;
  const ownerScope = input.by.kind === "owner" ? layer : row?.ownerScope;
  const agentScope = input.by.kind === "owner" ? undefined : layer;
  const changed = !sameScopeLayer(ownerScope, row?.ownerScope) || !sameScopeLayer(agentScope, row?.agentScope);
  if (!changed) return { row: row ?? { board: input.board }, changed: false, before, after: before, narrowed: false, widened: false, released: [] };
  // Um agente que pede «Tudo» sob o limite vivo do dono só tira a camada DELE: o que vale depois é o escopo do dono, e é isso
  // que o histórico registra (não um «Tudo» que nunca valeu).
  const recordedTypes = types ?? (input.by.kind === "agent" ? (liveScope(row?.ownerScope, now)?.types ?? null) : null);
  const record: ScopeRecord = { types: recordedTypes, by: input.by, at, ...(reason ? { reason } : {}), ...(until ? { until } : {}) };
  const { pause, scope } = splitHeld(row?.held);
  const draft: BoardPaceRow = {
    board: input.board,
    ...(row?.owner ? { owner: row.owner } : {}),
    ...(row?.agent ? { agent: row.agent } : {}),
    ...(ownerScope ? { ownerScope } : {}),
    ...(agentScope ? { agentScope } : {}),
  };
  const after = effectiveScope(draft, now);
  const widened = scopeWidened(before, after);
  const narrowed = scopeNarrowed(before, after);
  // O que o escopo segurava volta quando ele alarga ou sai; o que a pausa segura não é daqui (fica como está).
  const released = !after || widened ? scope : [];
  const kept = [...pause, ...(released.length ? [] : scope)];
  return {
    row: {
      ...draft,
      ...(kept.length ? { held: kept } : {}),
      ...(row?.history?.length ? { history: row.history } : {}),
      scopeHistory: [...(row?.scopeHistory ?? []), record].slice(-PACE_HISTORY_MAX),
    },
    changed: true,
    before,
    after,
    narrowed,
    widened,
    released,
  };
}

export interface PaceExpiry {
  row: BoardPaceRow;
  /** o ritmo em vigor depois. */
  level: PaceLevel;
  /** o ritmo ficou mais rápido por causa do prazo. */
  faster: boolean;
  /** o que a PAUSA segurava e volta ao pipeline (a pausa saiu). */
  released: PaceHeldEntry[];
  /** um prazo de FREIO venceu. */
  paceDue: boolean;
  /** um prazo de ESCOPO venceu. */
  scopeDue: boolean;
  /** o escopo em vigor antes do vencimento (com as camadas ainda valendo) e depois — quem chama re-varre o que alargou. */
  scopeBefore: EffectiveScope | null;
  scopeAfter: EffectiveScope | null;
  /** o que o ESCOPO segurava e volta ao pipeline (o escopo alargou ou saiu). */
  releasedScope: PaceHeldEntry[];
}

/** Algum prazo da linha (de freio OU de escopo) venceu e ainda não foi varrido? PURA. */
export function rowExpired(row: BoardPaceRow | null | undefined, now: number): boolean {
  return paceExpired(row, now) || scopeLayerExpired(row?.ownerScope, now) || scopeLayerExpired(row?.agentScope, now);
}

/**
 * Os prazos vencidos da linha: cada freio vencido sai (ou afrouxa para `slow`), cada camada de escopo vencida sai, e o
 * que a pausa (ou o escopo) segurava é devolvido se ela saiu. Sem prazo vencido devolve null. PURA.
 */
export function expirePace(row: BoardPaceRow, now: number): PaceExpiry | null {
  const paceDue = paceExpired(row, now);
  const scopeDue = scopeLayerExpired(row.ownerScope, now) || scopeLayerExpired(row.agentScope, now);
  if (!paceDue && !scopeDue) return null;
  // «antes» = o que a linha dizia com os prazos ainda valendo
  const stored = [row.owner, row.agent].filter((h): h is PaceHold => !!h);
  const before = stored.reduce<PaceLevel>((acc, h) => (paceRank(h.level) < paceRank(acc) ? h.level : acc), "normal");
  const owner = liveHold(row.owner, now) ?? undefined;
  const agent = liveHold(row.agent, now) ?? undefined;
  const ownerScope = liveScope(row.ownerScope, now) ?? undefined;
  const agentScope = liveScope(row.agentScope, now) ?? undefined;
  const base: BoardPaceRow = {
    board: row.board,
    ...(owner ? { owner } : {}),
    ...(agent ? { agent } : {}),
    ...(ownerScope ? { ownerScope } : {}),
    ...(agentScope ? { agentScope } : {}),
  };
  const level = effectivePaceLevel(base, now);
  const at = new Date(now).toISOString();
  const { pause, scope } = splitHeld(row.held);
  const scopeBefore = effectiveScope(row, Number.NEGATIVE_INFINITY);
  const scopeAfter = effectiveScope(base, now);
  const scopeReleased = scopeDue && (!scopeAfter || scopeWidened(scopeBefore, scopeAfter));
  const keptHeld = [...(level === "paused" ? pause : []), ...(scopeReleased ? [] : scope)];
  let history = row.history;
  if (paceDue) {
    const by = (holdExpired(row.owner, now) ? row.owner : row.agent)?.by ?? { kind: "owner" as const };
    history = [...(row.history ?? []), { level, by, at, expired: true as const }].slice(-PACE_HISTORY_MAX);
  }
  let scopeHistory = row.scopeHistory;
  if (scopeDue) {
    const expiredLayer = scopeLayerExpired(row.ownerScope, now) ? row.ownerScope : row.agentScope;
    const rec: ScopeRecord = { types: scopeAfter ? scopeAfter.types : null, by: expiredLayer?.by ?? { kind: "owner" }, at, expired: true };
    scopeHistory = [...(row.scopeHistory ?? []), rec].slice(-PACE_HISTORY_MAX);
  }
  return {
    row: { ...base, ...(keptHeld.length ? { held: keptHeld } : {}), ...(history?.length ? { history } : {}), ...(scopeHistory?.length ? { scopeHistory } : {}) },
    level,
    faster: paceDue && paceRank(level) > paceRank(before),
    released: level !== "paused" ? pause : [],
    paceDue,
    scopeDue,
    scopeBefore,
    scopeAfter,
    releasedScope: scopeReleased ? scope : [],
  };
}

/**
 * Anota o que a pausa — ou o escopo — segurou num card (uma entrada por card e por CAUSA: a mais forte vence — `stopped`
 * sobre `entry`). A pausa só guarda com a linha PAUSADA agora; o escopo (`why: "scope"`) só guarda com um escopo em vigor
 * ({@link holdScopeEntry}). Fora disso devolve a mesma linha. PURA.
 */
export function holdPaceEntry(row: BoardPaceRow, entry: PaceHeldEntry, now: number): BoardPaceRow {
  if (entry.why === "scope") return holdScopeEntry(row, entry, now);
  if (effectivePaceLevel(row, now) !== "paused") return row;
  const held = row.held ?? [];
  const at = held.findIndex((h) => h.cardId === entry.cardId && h.why !== "scope");
  if (at >= 0) {
    if (held[at].why === "stopped" || entry.why === "entry") return row;
    return { ...row, held: held.map((h, n) => (n === at ? entry : h)) };
  }
  if (held.length >= PACE_HELD_MAX) return row;
  return { ...row, held: [...held, entry] };
}

/** Anota o que o ESCOPO segurou num card (uma entrada por card). Sem escopo em vigor, ou repetida, ou no teto: a mesma linha. PURA. */
export function holdScopeEntry(row: BoardPaceRow, entry: PaceHeldEntry, now: number): BoardPaceRow {
  if (!effectiveScope(row, now)) return row;
  const held = row.held ?? [];
  if (held.some((h) => h.cardId === entry.cardId && h.why === "scope")) return row;
  if (held.length >= PACE_HELD_MAX) return row;
  return { ...row, held: [...held, { cardId: entry.cardId, why: "scope", at: entry.at }] };
}

// ── as palavras ──────────────────────────────────────────────────────────────────────────────────────

const LABEL: Record<PaceLevel, string> = { paused: "Pausado", slow: "Devagar", normal: "Normal" };
export function paceLabel(level: PaceLevel): string {
  return LABEL[level];
}

/** O que cada posição faz, numa frase — o texto de ajuda do controle e da tool. */
export const PACE_HELP: Record<PaceLevel, string> = {
  paused: "Nada automático começa neste board.",
  slow: "Um card por vez, sem os agentes de fundo.",
  normal: "O ritmo que o board declara.",
};

/** A sugestão de ritmo a partir da cota: fora do ritmo da semana, andar devagar. PURA. */
export function paceSuggestion(gate: Pick<BoardGate, "level">, quota: { onPace: boolean; detail: string } | null): { level: PaceLevel; why: string } | null {
  if (!quota || quota.onPace || gate.level !== "normal") return null;
  return { level: "slow", why: quota.detail };
}

/** O ritmo de um board como a tela e a tool o mostram — uma projeção só, para as duas portas não divergirem. */
export interface BoardPaceView {
  board: string;
  level: PaceLevel;
  label: string;
  /** nada automático começa agora. */
  held: boolean;
  source: BoardGateSource;
  why: string;
  /** quem pôs o ritmo em vigor e quando (null em `normal`, no desarmado e no ilegível). */
  by: PaceActor | null;
  since: string | null;
  reason: string | null;
  /** quando o ritmo em vigor afrouxa sozinho. */
  until: string | null;
  mode: PauseMode | null;
  /** o que o DONO fixou (um agente não passa disso); null = o dono não segura este board. */
  ownerLimit: Exclude<PaceLevel, "normal"> | null;
  /** quantos cards a pausa está segurando para devolver na retomada. */
  waiting: number;
  /** as últimas mudanças, a mais recente primeiro. */
  history: PaceChange[];
  suggestion: { level: PaceLevel; why: string } | null;
  /** o ESCOPO de tipos em vigor (o que o board pode começar); null = todos os tipos (e sempre null no desarmado e no ilegível). */
  scope: ScopeView | null;
  /**
   * quantos cards o escopo está segurando. A projeção pura conta as entradas retidas; quem tem os cards
   * (`boardPaceViewNow`) a substitui pela contagem real dos cards de tipo fora do escopo que esperam para ser construídos.
   */
  scopeWaiting: number;
  /** as últimas mudanças de escopo, a mais recente primeiro. */
  scopeHistory: ScopeRecord[];
  /** funcionalidades novas já construídas na entrega, que vão junto na próxima publicação (só `boardPaceViewNow` calcula; 0 aqui). */
  featuresToShip: number;
}

/** O escopo como a tela e a tool o mostram. */
export interface ScopeView {
  types: StoryType[];
  preset: ScopePreset;
  /** quem pôs o limite que mais estreita, e quando. */
  by: PaceActor;
  since: string;
  reason: string | null;
  /** quando o limite afrouxa sozinho. */
  until: string | null;
  /** o que o DONO admitiu (um agente não passa disso); null = o dono não limita este board. */
  ownerTypes: StoryType[] | null;
}

/** A projeção. `quota` null = sem leitura confiável da cota (nenhuma sugestão sai de um palpite). PURA. */
export function paceViewOf(
  board: string,
  config: Pick<BoardConfig, "autorunDisabled" | "organizeOnly"> | null | undefined,
  snap: { rows: readonly BoardPaceRow[]; unreadable: boolean },
  now: number,
  quota: { onPace: boolean; detail: string } | null,
): BoardPaceView {
  const row = snap.rows.find((r) => r.board === board) ?? null;
  const gate = resolveBoardGate(config, row, now, snap.unreadable);
  const hold = gate.source === "pace" ? holdInForce(row, now) : null;
  const scope = gate.source === "pace" || gate.source === "default" ? (gate.scope ?? null) : null;
  return {
    board,
    level: gate.level,
    label: paceLabel(gate.level),
    held: gate.held,
    source: gate.source,
    why: gate.why,
    by: hold?.by ?? null,
    since: hold?.at ?? null,
    reason: hold?.reason ?? null,
    until: hold && !holdExpired(hold, now) ? (hold.until ?? null) : null,
    mode: gate.source === "pace" ? effectivePauseMode(row, now) : null,
    ownerLimit: gate.source === "pace" ? (liveHold(row?.owner, now)?.level ?? null) : null,
    waiting: gate.source === "pace" && gate.level === "paused" ? splitHeld(row?.held).pause.length : 0,
    history: [...(row?.history ?? [])].reverse(),
    suggestion: paceSuggestion(gate, quota),
    scope: scope
      ? {
          types: scope.types,
          preset: scopePresetOf(scope.types),
          by: scope.by,
          since: scope.at,
          reason: scope.reason ?? null,
          until: scope.until ?? null,
          ownerTypes: scope.ownerTypes,
        }
      : null,
    scopeWaiting: scope ? splitHeld(row?.held).scope.length : 0,
    scopeHistory: [...(row?.scopeHistory ?? [])].reverse(),
    featuresToShip: 0,
  };
}

// ── o arquivo ────────────────────────────────────────────────────────────────────────────────────────

/** A versão do arquivo SEM escopo — a que um binário antigo lê. */
export const PACE_FILE_VERSION = 1;
/**
 * A versão do arquivo COM escopo (ao menos uma camada gravada). É de propósito um número que o leitor antigo NÃO conhece:
 * `parsePaceFile` da versão 1 devolve null para qualquer outra versão, o arquivo vira «ilegível» e o portão segura TODOS
 * os boards (fail-closed). Sem isso, um binário antigo leria a linha, descartaria o escopo em silêncio e o board voltaria a
 * gastar em funcionalidade nova (fail-open) — e ainda REGRAVARIA o arquivo sem o escopo.
 */
export const PACE_FILE_VERSION_SCOPE = 2;

/** A versão que estas linhas pedem: 2 só quando alguma guarda uma camada de escopo; senão 1 (compatível com o binário antigo). PURA. */
export function paceFileVersionOf(rows: readonly BoardPaceRow[]): number {
  return rows.some((r) => r.ownerScope || r.agentScope) ? PACE_FILE_VERSION_SCOPE : PACE_FILE_VERSION;
}

function actorOf(v: unknown): PaceActor | null {
  const o = v as { kind?: unknown; id?: unknown } | null;
  if (!o || (o.kind !== "owner" && o.kind !== "agent")) return null;
  return { kind: o.kind, ...(typeof o.id === "string" && o.id ? { id: o.id } : {}) };
}

/** Um freio do arquivo. `undefined` = ausente; `null` = presente e ILEGÍVEL (a linha inteira não pode ser julgada). */
function holdOf(v: unknown, kind: PaceActor["kind"]): PaceHold | undefined | null {
  if (v == null) return undefined;
  const o = v as Record<string, unknown>;
  const by = actorOf(o.by);
  if (!by || by.kind !== kind || (o.level !== "paused" && o.level !== "slow") || !validIso(o.at)) return null;
  if (o.until != null && !validIso(o.until)) return null;
  return {
    level: o.level,
    by,
    at: o.at,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
    ...(validIso(o.until) ? { until: o.until } : {}),
    ...(o.resumeTo === "slow" ? { resumeTo: "slow" as const } : {}),
    ...(isPauseMode(o.mode) ? { mode: o.mode } : {}),
  };
}

/** Uma camada de escopo do arquivo. `undefined` = ausente; `null` = presente e ILEGÍVEL (tipos vazios ou desconhecidos incluídos). */
function scopeOf(v: unknown, kind: PaceActor["kind"]): PaceScope | undefined | null {
  if (v == null) return undefined;
  const o = v as Record<string, unknown>;
  const by = actorOf(o.by);
  if (!by || by.kind !== kind || !validIso(o.at)) return null;
  if (!Array.isArray(o.types) || !o.types.length || o.types.some((t) => !isScopeType(t))) return null;
  if (o.until != null && !validIso(o.until)) return null;
  return {
    types: normalizeScopeTypes(o.types),
    by,
    at: o.at,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
    ...(validIso(o.until) ? { until: o.until } : {}),
  };
}

function changeOf(v: unknown): PaceChange | null {
  const o = v as Record<string, unknown> | null;
  const by = actorOf(o?.by);
  if (!o || !by || !isPaceLevel(o.level) || !validIso(o.at)) return null;
  return {
    level: o.level,
    by,
    at: o.at,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
    ...(validIso(o.until) ? { until: o.until } : {}),
    ...(isPauseMode(o.mode) ? { mode: o.mode } : {}),
    ...(o.expired === true ? { expired: true as const } : {}),
  };
}

function scopeRecordOf(v: unknown): ScopeRecord | null {
  const o = v as Record<string, unknown> | null;
  const by = actorOf(o?.by);
  if (!o || !by || !validIso(o.at)) return null;
  if (o.types !== null && (!Array.isArray(o.types) || !o.types.length || o.types.some((t) => !isScopeType(t)))) return null;
  return {
    types: o.types === null ? null : normalizeScopeTypes(o.types as unknown[]),
    by,
    at: o.at,
    ...(typeof o.reason === "string" && o.reason ? { reason: o.reason } : {}),
    ...(validIso(o.until) ? { until: o.until } : {}),
    ...(o.expired === true ? { expired: true as const } : {}),
  };
}

/** `withScope`: o arquivo é da versão 2. Na versão 1, qualquer sinal de escopo é incoerente (nenhum escritor o grava lá) ⇒ ilegível. */
function rowOf(v: unknown, withScope: boolean): BoardPaceRow | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.board !== "string" || !o.board) return null;
  const owner = holdOf(o.owner, "owner");
  const agent = holdOf(o.agent, "agent");
  if (owner === null || agent === null) return null;
  if (!withScope && (o.ownerScope != null || o.agentScope != null)) return null;
  const ownerScope = scopeOf(o.ownerScope, "owner");
  const agentScope = scopeOf(o.agentScope, "agent");
  if (ownerScope === null || agentScope === null) return null;
  let incoherent = false;
  const held = Array.isArray(o.held)
    ? o.held.flatMap((h): PaceHeldEntry[] => {
        const e = h as Record<string, unknown> | null;
        if (!(e && typeof e.cardId === "string" && e.cardId && (e.why === "stopped" || e.why === "entry" || e.why === "scope") && validIso(e.at))) return [];
        if (e.why === "scope" && !withScope) incoherent = true;
        return [{ cardId: e.cardId, why: e.why, at: e.at }];
      })
    : [];
  if (incoherent) return null;
  const history = Array.isArray(o.history) ? o.history.flatMap((c) => changeOf(c) ?? []) : [];
  // O histórico de escopo vale em QUALQUER versão: quando a última camada sai («Tudo», ou o prazo vence) o arquivo volta à versão 1,
  // e é justamente aí que o registro de quem alargou — e o «o prazo venceu» — precisa sobreviver. Um binário antigo ignora o campo
  // que não conhece, então o fail-closed fica intacto: ele continua recusando só as CAMADAS (`ownerScope`/`agentScope`) e o
  // `held.why = "scope"` na versão 1, que é o que garante que ninguém lê um limite em silêncio como «sem limite».
  const scopeHistory = Array.isArray(o.scopeHistory) ? o.scopeHistory.flatMap((c) => scopeRecordOf(c) ?? []) : [];
  return {
    board: o.board,
    ...(owner ? { owner } : {}),
    ...(agent ? { agent } : {}),
    ...(ownerScope ? { ownerScope } : {}),
    ...(agentScope ? { agentScope } : {}),
    ...(held.length ? { held } : {}),
    ...(history.length ? { history } : {}),
    ...(scopeHistory.length ? { scopeHistory } : {}),
  };
}

/**
 * O arquivo de ritmo, lido com RIGOR: null quando ele não pode ser julgado — JSON quebrado, versão desconhecida, `rows`
 * que não é lista, ou uma linha cujo board, cujo freio ou cujo escopo não se lê. Quem chama trata null como «todo board
 * segurado» ({@link resolveBoardGate} com `unreadable`). Lê as versões 1 e 2 (a 2 só existe com escopo gravado). PURA.
 */
export function parsePaceFile(raw: string): BoardPaceRow[] | null {
  try {
    const data = JSON.parse(raw) as { version?: unknown; rows?: unknown };
    const version = data?.version;
    if ((version !== PACE_FILE_VERSION && version !== PACE_FILE_VERSION_SCOPE) || !Array.isArray(data.rows)) return null;
    const out: BoardPaceRow[] = [];
    for (const r of data.rows) {
      const row = rowOf(r, version === PACE_FILE_VERSION_SCOPE);
      if (!row) return null;
      out.push(row);
    }
    return out;
  } catch {
    return null;
  }
}

/** Grava na versão 1 enquanto NENHUM board tem escopo (o binário antigo segue lendo), e na 2 assim que algum tem. */
export function serializePaceFile(rows: readonly BoardPaceRow[]): string {
  return JSON.stringify({ version: paceFileVersionOf(rows), rows }, null, 2);
}
