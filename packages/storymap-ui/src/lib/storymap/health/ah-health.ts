// O RELATÓRIO DE SAÚDE DO AGILEHARNESS — doze sinais, cada um com um limiar declarado. PURO (zero IO, zero relógio:
// quem chama passa `now`). O coletor (health-collect.ts) lê o disco e monta os `HealthInputs`; o tick
// (health-deps.ts) anota o resultado e abre o card de conserto.
//
// POR QUE EXISTE. Num caso real o dono descobriu, olhando a tela, o que o sistema já sabia espalhado: itens no Decidir
// sem uma só decisão de negócio, quase todo o Inbox sendo ruído, cards na raia «Precisa de você» que o Inbox não pedia,
// uma fila parada em Liberar por horas com nada no ar, falhas idênticas de sandbox repetidas e um card cujo arquivo
// dizia `corrigir` enquanto o ledger dizia `release`. Cada vigia (stall-watch, fila do condutor, disjuntor de publicação, touches) media
// uma fatia isolada e jogava o resultado no journal; ninguém somava, ninguém comparava com um limiar, ninguém
// transformava um sinal estourado em trabalho. O `service_health` só mede liveness. Aqui os sinais viram UM relatório
// comparável no tempo (`healthDelta`) — a linha de base ANTES dos consertos e a régua que diz se cada conserto funcionou.
//
// CONVENÇÕES (valem para todos os sinais, para o limiar ser lido sem ambiguidade):
//   • todo sinal é «menor é melhor»; o nível sobe quando o valor fica ESTRITAMENTE ACIMA do limiar (`>`): âmbar acima
//     de `amber`, vermelho acima de `red`. Um limiar «≥ 3» é declarado como 2;
//   • `null` + nível `unknown` = «não medível» — nunca verde. Um sinal que não consegue medir NÃO diz que está bem
//     (foi assim que o rollout_readiness declarou «pronto» às cegas, com 0% das ações atribuídas a alguém);
//   • quando o vermelho tem uma segunda condição (S1, S4, S5, S6) o texto `rule` do sinal a diz em palavras.
//
// NADA aqui conhece produto, board ou usuário: os ids vêm dos inputs, e os limiares do `settings.yaml` (health:).

// ── níveis, ids e limiares ───────────────────────────────────────────────────────────────────────────

export type HealthLevel = "ok" | "amber" | "red" | "unknown";

export const HEALTH_SIGNAL_IDS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12"] as const;
export type HealthSignalId = (typeof HEALTH_SIGNAL_IDS)[number];

/** Os limiares. Os defaults vêm do diagnóstico original; o `settings.yaml` (`health:`) sobrepõe campo a campo. */
export interface HealthThresholds {
  /** S1 — quantos itens de Decidir SEM razão de negócio. Vermelho: quantos deles nem opção executável têm (`red`). */
  s1: { amber: number; red: number };
  /** S2 — % das linhas do Inbox FORA do contrato ({@link isInboxNoise}); abaixo de `minLines` delas o sinal não sai do verde. */
  s2: { amber: number; red: number; minLines: number };
  /** S3 — cards que a raia de demanda e o Decidir NÃO têm em comum (diferença simétrica). */
  s3: { amber: number; red: number };
  /** S4 — agentes problemáticos (quieto, terminal órfão, claim sem sessão). Vermelho: o mais antigo segura claim há mais de `red` min. */
  s4: { amber: number; red: number; idleMinutes: number };
  /** S5 — cards parados num passo do sistema. Âmbar: sendo vigiados (`amber`); vermelho: escalados (`red`). */
  s5: { amber: number; red: number };
  /** S6 — horas sem nada no ar com fila de publicação. Vermelho também: o maior grupo com a mesma causa passa de `redGroup`. */
  s6: { amber: number; red: number; redGroup: number };
  /** S7 — horas que o card mais antigo espera uma vaga de condutor. */
  s7: { amber: number; red: number };
  /** S8 — saltos de status não humanos de UM card dentro da janela. */
  s8: { amber: number; red: number; windowMinutes: number };
  /** S9 — cards cujo arquivo e cujo ledger discordam do status. */
  s9: { amber: number; red: number };
  /** S10 — a mesma assinatura de falha da FERRAMENTA, repetida dentro da janela. */
  s10: { amber: number; red: number; windowHours: number };
  /** S11 — toques técnicos do dono por história no ar; sem `minAttributionPct` de ações atribuídas, não é medível. */
  s11: { amber: number; red: number; minAttributionPct: number; windowHours: number };
  /** S12 — minutos que uma pergunta técnica espera sem o proxy. */
  s12: { amber: number; red: number };
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  s1: { amber: 0, red: 0 },
  s2: { amber: 20, red: 50, minLines: 5 },
  s3: { amber: 0, red: 2 },
  s4: { amber: 0, red: 30, idleMinutes: 15 },
  s5: { amber: 0, red: 0 },
  s6: { amber: 2, red: 4, redGroup: 2 },
  s7: { amber: 2, red: 4 },
  s8: { amber: 10, red: 30, windowMinutes: 60 },
  s9: { amber: 0, red: 2 },
  s10: { amber: 0, red: 1, windowHours: 24 },
  s11: { amber: 0, red: 0.5, minAttributionPct: 90, windowHours: 24 },
  s12: { amber: 30, red: 120 },
};

/** Os knobs do tick (o `health:` do settings, fora dos limiares). */
export interface HealthSettings {
  /** de quantos em quantos minutos o tick mede; 0 = desligado. */
  tickMinutes: number;
  /** quantos dias o health.jsonl guarda. */
  retentionDays: number;
  /** quantas leituras SEGUIDAS no vermelho abrem o card de conserto. */
  redTicks: number;
  thresholds: HealthThresholds;
}

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = {
  tickMinutes: 5,
  retentionDays: 7,
  redTicks: 2,
  thresholds: DEFAULT_HEALTH_THRESHOLDS,
};

/** Sobrepõe só as folhas NUMÉRICAS finitas e não negativas; qualquer outra coisa mantém o default. PURA. */
function overlayNumbers<T extends object>(defaults: T, raw: unknown): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, dflt] of Object.entries(defaults)) {
    const v = src[key];
    if (dflt && typeof dflt === "object") out[key] = overlayNumbers(dflt as object, v);
    else out[key] = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
  }
  return out as T;
}

/**
 * O bloco `health:` do settings.yaml, por cima dos defaults. Os knobs do tick (`tickMinutes`, `retentionDays`,
 * `redTicks`) e os limiares (`s1` … `s12`) moram lado a lado no bloco:
 *
 *     health:
 *       tickMinutes: 5
 *       redTicks: 2
 *       s6: { amber: 2, red: 4, redGroup: 2 }
 *
 * PURA e TOLERANTE: bloco ausente, não-mapa ou com valor inválido (texto, negativo, NaN) devolve o default daquela
 * folha — um typo no settings nunca desliga um sinal nem o deixa mais frouxo em silêncio. `retentionDays` e `redTicks`
 * pedem pelo menos 1; `tickMinutes: 0` DESLIGA o tick (o único jeito declarado de silenciar o relatório numa emergência).
 */
export function coerceHealthSettings(raw: unknown): HealthSettings {
  const knobs = overlayNumbers({ tickMinutes: DEFAULT_HEALTH_SETTINGS.tickMinutes, retentionDays: DEFAULT_HEALTH_SETTINGS.retentionDays, redTicks: DEFAULT_HEALTH_SETTINGS.redTicks }, raw);
  return {
    tickMinutes: Math.floor(knobs.tickMinutes),
    retentionDays: Math.max(1, Math.floor(knobs.retentionDays)),
    redTicks: Math.max(1, Math.floor(knobs.redTicks)),
    thresholds: overlayNumbers(DEFAULT_HEALTH_THRESHOLDS, raw),
  };
}

// ── o relatório ─────────────────────────────────────────────────────────────────────────────────────

export interface HealthSignal {
  id: HealthSignalId;
  /** o nome curto, em português. */
  label: string;
  /** o número medido; `null` = não medível. */
  value: number | null;
  unit: string;
  level: HealthLevel;
  /** os limiares efetivos (acima de `amber` âmbar, acima de `red` vermelho). */
  threshold: { amber: number; red: number };
  /** a regra em palavras — a única parte que diz a segunda condição do vermelho, quando há. */
  rule: string;
  /** até 5 ids `board/card` que explicam o número. */
  evidence: string[];
  /** uma linha: o que o número diz hoje. */
  detail: string;
  /** o primeiro passo do conserto (vai para o card `[saude:<id>]`). */
  fixHint: string;
}

export interface HealthReport {
  /** ISO do instante da medida. */
  at: string;
  signals: HealthSignal[];
  /** o pior nível entre os sinais (`unknown` conta abaixo de `amber`: não medível não é alarme, mas também não é verde). */
  worst: HealthLevel;
}

// ── os inputs: dados simples, montados pelo coletor ──────────────────────────────────────────────────

/** Uma linha do Inbox, já reduzida ao que os sinais leem. */
export interface HealthInboxEntry {
  board: string;
  cardId: string;
  kind: string;
  bucket: "decidir" | "acompanhar";
  decider: "owner" | "system";
  /** a classe de negócio do veredito; `null` = o dono por outra razão (modo humano, trava do núcleo, pedido dele). */
  ownerClass: string | null;
  /** a classe de dono veio SÓ do piso de palavras de dinheiro — a categoria que o autor declarou não é dinheiro. */
  floorOnly: boolean;
  /** quantas opções habilitadas MUDAM o desfecho (ver {@link isOutcomeOption}). */
  executable: number;
  /**
   * Em Acompanhar: a linha é do conjunto que o contrato deixa lá (RC2/C8) — o que o dono combinou rever (aceite de
   * triagem de história `user`, amostra de entrega dentro do prazo) ou trabalho do sistema em andamento. Quem decide é o
   * coletor, que vê o tipo da decisão do sistema e o card. Em Decidir não é lido.
   */
  followUpAllowed: boolean;
}

/** Os cards que a raia de demanda de um board mostra. */
export interface HealthDemandLane {
  board: string;
  laneId: string;
  cardIds: string[];
}

export interface HealthCard {
  board: string;
  cardId: string;
  status: string | null;
}

export interface HealthTransition {
  board: string;
  cardId: string;
  to: string;
  /** ms desde a época. */
  at: number;
  actor: string;
}

export interface HealthPublishWaiting {
  board: string;
  cardId: string;
}

export interface HealthPublishHeld {
  board: string;
  cardId: string;
  phase: string;
  exitCode: number | null;
  /** a causa normalizada, quando o disjuntor souber dizê-la; senão a causa é `fase + código de saída`. */
  causeKey?: string;
}

/** Um agente da frota, reduzido ao que o S4 lê. */
export interface HealthFleetRow {
  agentId: string;
  board: string | null;
  cardId: string | null;
  /** o processo existe e a sessão está viva (a MESMA definição da frota). */
  alive: boolean;
  isConductor: boolean;
  /** há quanto tempo está quieto no prompt (evidência: transcript + tela); `null` = trabalhando ou não dá para saber. */
  quietForMs: number | null;
  /** declarou uma espera (`report_progress`) — quieto de propósito. */
  declaredWaiting: boolean;
  /** um prompt desenhado na tela espera o dono. */
  asking: boolean;
  /** o worktree da sessão sumiu do disco. */
  worktreeMissing: boolean;
  /** há quanto tempo a sessão segura o claim do card; `null` = sem claim. */
  claimAgeMs: number | null;
}

/** Um claim de sessão ainda vivo, com o fato de a sessão dona estar viva ou não. */
export interface HealthClaim {
  board: string;
  cardId: string;
  actor: string;
  claimAgeMs: number;
  holderAlive: boolean;
}

export interface HealthQueueEntry {
  board: string;
  cardId: string;
  /** ms desde a época em que entrou na fila. */
  queuedAt: number;
  /** o motivo da última espera, como a fila do condutor gravou (`board-paused`, `slots:…`). Ausente = não sabido. */
  waitKind?: string;
}

export interface HealthStallRow {
  key: string;
  /** desde quando o card está sem dono; `null` = no momento ele tem dono. */
  firstSeenAt: number | null;
  escalatedAt?: number;
}

export interface HealthToolFailure {
  /** a assinatura estável da falha da ferramenta (ex.: `sandbox:seccomp`). */
  signature: string;
  at: number;
  board: string;
  cardId: string;
}

/** Uma pergunta técnica ainda aberta, sem resposta do proxy. */
export interface HealthOpenTechnicalQuestion {
  board: string;
  cardId: string;
  questionId: string;
  /** `askedAt` como está no card: ISO completo ou só a data (formato antigo). */
  askedAt: string | null;
}

export interface HealthInputs {
  /** ms desde a época. */
  now: number;
  inbox: HealthInboxEntry[];
  /** só os boards que têm uma raia de demanda. */
  demandLanes: HealthDemandLane[];
  /** o status de cada história, como está no ARQUIVO do card. */
  cards: HealthCard[];
  transitions: HealthTransition[];
  /** os status «No ar» de cada board. */
  deliveredStatuses: Record<string, string[]>;
  /** os cards que esperam publicação (Liberar/Publicar). */
  publishWaiting: HealthPublishWaiting[];
  publishHeld: HealthPublishHeld[];
  /** a sonda do tmux respondeu? Sem ela ninguém é julgado: o S4 diz «não medível», nunca «tudo bem». */
  fleetKnown: boolean;
  fleet: HealthFleetRow[];
  /** terminais tmux de condutor sem linha no registro. */
  orphanTerminals: string[];
  claims: HealthClaim[];
  conductorQueue: HealthQueueEntry[];
  stall: HealthStallRow[];
  toolFailures: HealthToolFailure[];
  /** das ações MCP da janela, quantas dizem QUEM as fez (sessão/ator). */
  attribution: { actions: number; attributed: number };
  touches: { liveStories: number; technicalTouches: number; ownerSessionActions: number };
  openTechnicalQuestions: HealthOpenTechnicalQuestion[];
  /**
   * Os boards PAUSADOS agora (o freio em vigor — do dono ou dos agentes — é `paused`). Uma espera que o dono escolheu
   * não é a ferramenta travada: S6 e S7 não contam o trabalho desses boards (só o citam no detalhe). Ausente = nenhum.
   */
  pausedBoards?: string[];
  /**
   * Quando cada board saiu da pausa pela última vez (ms desde a época). Retomado o board, a espera conta DA RETOMADA —
   * sem isso, o sinal ficaria vermelho no instante em que o dono religa um board parado há dias. Ausente = sem pausa.
   */
  resumedAt?: Record<string, number>;
}

/** Os invokes que NÃO mudam o desfecho: ler o passo a passo, pedir ao Jido, abrir um link, olhar o status. */
const NON_OUTCOME_INVOKES: ReadonlySet<string> = new Set(["howto", "escalate", "link", "show-publish-status"]);

/**
 * Esta opção muda o desfecho do item? É a régua da invariante «Decidir só com uma opção que o dono possa usar»: ela
 * descarta o que só informa (`howto`, `escalate`, `link`, `show-publish-status`) e a ação de auditoria só-leitura. O
 * teste antigo só excluía `howto`, então «Pedir ao Jido» contava como decisão (itens de publicação que tinham
 * só «como fazer» e «pedir ao Jido» e mesmo assim passavam). PURA.
 */
export function isOutcomeOption(option: { invoke: { kind: string }; auditCls: string; disabled?: unknown }): boolean {
  return !option.disabled && !NON_OUTCOME_INVOKES.has(option.invoke.kind) && option.auditCls !== "read";
}

// ── pequenas peças ──────────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const key = (board: string, cardId: string): string => `${board}/${cardId}`;
const top = (ids: Iterable<string>, n = 5): string[] => [...new Set(ids)].slice(0, n);
const RANK: Record<HealthLevel, number> = { ok: 0, unknown: 1, amber: 2, red: 3 };
const worseOf = (a: HealthLevel, b: HealthLevel): HealthLevel => (RANK[a] >= RANK[b] ? a : b);

/** O pior de uma lista de níveis (`unknown` pesa abaixo de `amber`: não medível não é alarme, mas também não é verde). PURA. */
export function worstLevel(levels: Iterable<HealthLevel>): HealthLevel {
  let worst: HealthLevel = "ok";
  for (const l of levels) worst = worseOf(worst, l);
  return worst;
}

/** `>`: acima de `red` é vermelho, acima de `amber` é âmbar. */
function grade(value: number, t: { amber: number; red: number }): HealthLevel {
  if (value > t.red) return "red";
  if (value > t.amber) return "amber";
  return "ok";
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** O chão do relógio de um board: a espera nunca conta de antes da última retomada da pausa. */
const sinceResume = (i: HealthInputs, board: string, since: number): number => Math.max(since, i.resumedAt?.[board] ?? -Infinity);

/** O trecho do detalhe que cita o que ficou de fora por pausa — o sinal fica verde, mas a espera continua visível. */
const pausedNote = (n: number, one: string, many: string): string => (n ? `; ${plural(n, one, many)} em board pausado (não conta)` : "");

type SignalBody = Pick<HealthSignal, "label" | "unit" | "fixHint"> & Partial<Pick<HealthSignal, "rule">>;

function signal(id: HealthSignalId, body: SignalBody, t: { amber: number; red: number }, found: { value: number | null; level: HealthLevel; evidence?: string[]; detail: string }): HealthSignal {
  return {
    id,
    label: body.label,
    value: found.value,
    unit: body.unit,
    level: found.level,
    threshold: { amber: t.amber, red: t.red },
    rule: body.rule ?? `âmbar acima de ${t.amber} ${body.unit}, vermelho acima de ${t.red} ${body.unit}`,
    evidence: top(found.evidence ?? []),
    detail: found.detail,
    fixHint: body.fixHint,
  };
}

// ── S1 — Decidir sem negócio ─────────────────────────────────────────────────────────────────────────

/** O dono tem uma razão de NEGÓCIO para decidir isto? Classe de dono declarada, e não só o piso de palavras. */
const hasBusinessReason = (e: HealthInboxEntry): boolean => e.decider === "owner" && e.ownerClass != null && !e.floorOnly;

function s1(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const decidir = i.inbox.filter((e) => e.bucket === "decidir");
  const noBusiness = decidir.filter((e) => !hasBusinessReason(e));
  const noAction = noBusiness.filter((e) => e.executable === 0);
  const level = noAction.length > t.s1.red ? "red" : noBusiness.length > t.s1.amber ? "amber" : "ok";
  return signal(
    "S1",
    {
      label: "Decidir sem negócio",
      unit: "itens",
      rule: `âmbar com mais de ${t.s1.amber} item(ns) em Decidir sem classe de negócio do dono; vermelho com mais de ${t.s1.red} deles sem nenhuma opção que mude o desfecho`,
      fixHint: "Rotear por UMA régua: o que não é decisão de negócio vira Acompanhar (com o próximo passo) ou registro, nunca Decidir; falha da própria ferramenta não vai ao dono.",
    },
    t.s1,
    {
      value: noBusiness.length,
      level,
      evidence: noBusiness.map((e) => key(e.board, e.cardId)),
      detail: `${plural(noBusiness.length, "item", "itens")} em Decidir sem razão de negócio (${noAction.length} sem opção que mude o desfecho) de ${decidir.length} em Decidir`,
    },
  );
}

// ── S2 — ruído do Inbox ──────────────────────────────────────────────────────────────────────────────

/**
 * Esta linha do Inbox está FORA do contrato? Em Decidir: o dono não tem razão de negócio, ou não tem uma opção que
 * mude o desfecho (as mesmas réguas do S1). Em Acompanhar: não é o que o dono combinou rever nem trabalho do sistema
 * em andamento — é registro (ex.: as decisões do sistema que não eram aceite de história `user`). PURA.
 *
 * POR QUE NÃO «tudo que não é decisão para o dono». A primeira fórmula contava toda linha de Acompanhar como ruído: o
 * estado-alvo (Acompanhar enxuto, nenhuma decisão pendente) dava 100% vermelho, e o número só melhorava quando o dono
 * ACUMULAVA decisões — um incentivo ao contrário, ligado a um card de conserto que nunca fecharia por delta.
 */
export function isInboxNoise(e: HealthInboxEntry): boolean {
  return e.bucket === "decidir" ? !hasBusinessReason(e) || e.executable === 0 : !e.followUpAllowed;
}

function s2(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const total = i.inbox.length;
  const noise = i.inbox.filter(isInboxNoise);
  const pct = total === 0 ? 0 : Math.round((noise.length / total) * 100);
  // Denominador pequeno oscila (1 linha solta de 2 já é 50%): abaixo de `minLines` linhas fora do contrato o número é
  // dito, mas não acende — o S1 já pega, uma a uma, as de Decidir.
  const level = noise.length < t.s2.minLines ? "ok" : grade(pct, t.s2);
  return signal(
    "S2",
    {
      label: "Ruído do Inbox",
      unit: "%",
      rule: `âmbar acima de ${t.s2.amber}%, vermelho acima de ${t.s2.red}% das linhas do Inbox fora do contrato (Decidir sem negócio ou sem opção que mude o desfecho; Acompanhar que é só registro); com menos de ${t.s2.minLines} linhas fora do contrato, não sai do verde`,
      fixHint: "Acompanhar só guarda o que o dono combinou rever e o trabalho do sistema em andamento; o resto vai para o registro, com «Desfazer» preservado.",
    },
    t.s2,
    {
      value: pct,
      level,
      evidence: noise.filter((e) => e.cardId).map((e) => key(e.board, e.cardId)),
      detail:
        total === 0
          ? "o Inbox está vazio"
          : `${noise.length} de ${total} linhas do Inbox fora do contrato` + (noise.length > 0 && noise.length < t.s2.minLines ? ` (abaixo do mínimo de ${t.s2.minLines} para pesar)` : ""),
    },
  );
}

// ── S3 — raia de demanda × Decidir ───────────────────────────────────────────────────────────────────

function s3(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const decidirOf = new Map<string, Set<string>>();
  for (const e of i.inbox) {
    if (e.bucket !== "decidir") continue;
    const set = decidirOf.get(e.board) ?? new Set<string>();
    set.add(e.cardId);
    decidirOf.set(e.board, set);
  }
  const evidence: string[] = [];
  let inLaneOnly = 0;
  let inDecidirOnly = 0;
  for (const lane of i.demandLanes) {
    const decidir = decidirOf.get(lane.board) ?? new Set<string>();
    const inLane = new Set(lane.cardIds);
    for (const id of inLane) {
      if (decidir.has(id)) continue;
      inLaneOnly++;
      evidence.push(key(lane.board, id));
    }
    for (const id of decidir) {
      if (inLane.has(id)) continue;
      inDecidirOnly++;
      evidence.push(key(lane.board, id));
    }
  }
  const diff = inLaneOnly + inDecidirOnly;
  return signal(
    "S3",
    { label: "Raia «Precisa de você» × Decidir", unit: "cards", fixHint: "A raia de demanda deve listar exatamente os cards em Decidir do Inbox (nunca por status): uma só derivação para «precisa de você»." },
    t.s3,
    { value: diff, level: grade(diff, t.s3), evidence, detail: `${inLaneOnly} na raia sem estar em Decidir e ${inDecidirOnly} em Decidir fora da raia` },
  );
}

// ── S4 — agentes ociosos, órfãos e claims sem sessão ─────────────────────────────────────────────────

function s4(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const body = {
    label: "Agentes ociosos ou órfãos",
    unit: "agentes",
    rule: `âmbar com mais de ${t.s4.amber} agente(s) quieto(s) há ${t.s4.idleMinutes} min sem espera declarada, terminal órfão ou claim sem sessão; vermelho quando algum segura o card há mais de ${t.s4.red} min`,
    fixHint: "Condutor quieto com fila esperando: lembrete e depois estacionar; terminal sem linha ou worktree apagado não conta como vaga; claim sem sessão viva é liberado.",
  };
  if (!i.fleetKnown) return signal("S4", body, t.s4, { value: null, level: "unknown", detail: "não medível: a sonda do tmux não respondeu" });
  const idleMs = t.s4.idleMinutes * MIN_MS;
  type Bad = { id: string; heldMs: number | null; why: string };
  const bad: Bad[] = [];
  for (const r of i.fleet) {
    const ref = r.board && r.cardId ? key(r.board, r.cardId) : r.agentId;
    if (r.alive && r.worktreeMissing) bad.push({ id: ref, heldMs: r.claimAgeMs, why: "terminal vivo com o worktree apagado" });
    else if (r.alive && r.isConductor && !r.declaredWaiting && !r.asking && r.quietForMs != null && r.quietForMs >= idleMs) {
      bad.push({ id: ref, heldMs: r.claimAgeMs, why: `condutor quieto há ${Math.round(r.quietForMs / MIN_MS)} min` });
    }
  }
  for (const name of i.orphanTerminals) bad.push({ id: name, heldMs: null, why: "terminal de condutor sem linha no registro" });
  for (const c of i.claims) if (!c.holderAlive) bad.push({ id: key(c.board, c.cardId), heldMs: c.claimAgeMs, why: "claim sem sessão viva" });
  const oldestHeld = bad.reduce((m, b) => Math.max(m, b.heldMs ?? 0), 0);
  const level: HealthLevel = bad.length === 0 ? "ok" : oldestHeld > t.s4.red * MIN_MS ? "red" : bad.length > t.s4.amber ? "amber" : "ok";
  return signal("S4", body, t.s4, {
    value: bad.length,
    level,
    evidence: bad.map((b) => b.id),
    detail: bad.length ? bad.slice(0, 3).map((b) => `${b.id}: ${b.why}`).join("; ") : "nenhum agente ocioso, órfão ou com claim sem sessão",
  });
}

// ── S5 — cards parados num passo do sistema ──────────────────────────────────────────────────────────

function s5(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const watching = i.stall.filter((r) => r.firstSeenAt != null);
  const escalated = watching.filter((r) => r.escalatedAt != null);
  const level = escalated.length > t.s5.red ? "red" : watching.length > t.s5.amber ? "amber" : "ok";
  return signal(
    "S5",
    {
      label: "Cards parados num passo do sistema",
      unit: "cards",
      rule: `âmbar com mais de ${t.s5.amber} card(s) sem dono sendo vigiado(s); vermelho com mais de ${t.s5.red} já escalado(s)`,
      fixHint: "Achar por que o passo não andou sozinho e corrigir a causa; o card parado só volta a andar com o passo refeito.",
    },
    t.s5,
    {
      value: watching.length,
      level,
      evidence: watching.map((r) => r.key.replace(/@.*$/, "")),
      detail: `${watching.length} vigiado(s), ${escalated.length} escalado(s)`,
    },
  );
}

// ── S6 — vazão até o ar ──────────────────────────────────────────────────────────────────────────────

/**
 * Quantas horas um board passou COM fila de publicação e SEM nada chegar ao ar; e o maior grupo com a mesma causa.
 *
 * Por board, a conta começa no mais tarde de dois instantes: a última entrega e a entrada do card mais antigo da fila
 * (o último salto dele no ledger — a entrada no status em que espera). Medir só «desde a última entrega» acusava um board
 * calmo: o card que ACABOU de entrar em release num board que entregou pela última vez há 3 semanas dava centenas de
 * horas de uma vez (e um `[saude:S6]` em 10 min), e o delta de um conserto noutro board aparecia como «piorou». Card
 * sem salto no ledger não prova desde quando espera: conta da última entrega (sem entrega, de agora).
 */
function s6(input: HealthInputs, t: HealthThresholds): HealthSignal {
  // Board pausado: a fila de publicação dele é escolha de quem pausou, não vazão travada — sai da conta (e do grupo
  // por causa), e o detalhe diz quantos cards ficaram de fora.
  const paused = new Set(input.pausedBoards ?? []);
  const pausedWaiting = input.publishWaiting.filter((w) => paused.has(w.board)).length;
  const i: HealthInputs = paused.size
    ? { ...input, publishWaiting: input.publishWaiting.filter((w) => !paused.has(w.board)), publishHeld: input.publishHeld.filter((h) => !paused.has(h.board)) }
    : input;
  const lastMove = new Map<string, number>();
  const lastDelivered = new Map<string, number>();
  const delivered = new Map(Object.entries(i.deliveredStatuses).map(([b, ids]) => [b, new Set(ids)]));
  for (const tr of i.transitions) {
    const k = key(tr.board, tr.cardId);
    if (tr.at > (lastMove.get(k) ?? 0)) lastMove.set(k, tr.at);
    if (delivered.get(tr.board)?.has(tr.to) && tr.at > (lastDelivered.get(tr.board) ?? 0)) lastDelivered.set(tr.board, tr.at);
  }
  const waitingByBoard = new Map<string, HealthPublishWaiting[]>();
  for (const w of i.publishWaiting) waitingByBoard.set(w.board, [...(waitingByBoard.get(w.board) ?? []), w]);

  let hours = 0;
  const evidence: string[] = [];
  for (const [board, waiting] of waitingByBoard) {
    const delivered = lastDelivered.get(board);
    const queueSince = Math.min(...waiting.map((w) => lastMove.get(key(w.board, w.cardId)) ?? delivered ?? i.now));
    const since = sinceResume(i, board, Math.max(delivered ?? -Infinity, queueSince));
    const h = Math.max(0, i.now - since) / HOUR_MS;
    if (h > hours) hours = h;
    evidence.push(...waiting.map((w) => key(w.board, w.cardId)));
  }

  const groups = new Map<string, string[]>();
  for (const h of i.publishHeld) {
    const cause = h.causeKey ?? `${h.phase}|${h.exitCode ?? "-"}`;
    groups.set(cause, [...(groups.get(cause) ?? []), key(h.board, h.cardId)]);
  }
  const biggest = [...groups.entries()].sort((a, z) => z[1].length - a[1].length)[0];
  const groupSize = biggest?.[1].length ?? 0;

  const level: HealthLevel = groupSize > t.s6.redGroup ? "red" : grade(hours, t.s6);
  const waitingCount = i.publishWaiting.length;
  return signal(
    "S6",
    {
      label: "Vazão até o ar",
      unit: "h",
      rule: `âmbar acima de ${t.s6.amber} h sem nada no ar com fila de publicação, vermelho acima de ${t.s6.red} h — ou quando mais de ${t.s6.redGroup} cards esperam pela MESMA causa`,
      fixHint: "Uma pendência de publicação é do pacote, não do card: agrupar por causa, decidir quem resolve (dono ou sistema) e abrir UM conserto por causa, nunca N itens.",
    },
    t.s6,
    {
      value: round1(hours),
      level,
      evidence: [...(biggest?.[1] ?? []), ...evidence],
      detail: waitingCount
        ? `${round1(hours)} h com fila e nada no ar; ${plural(waitingCount, "card espera", "cards esperam")} publicação` + (groupSize >= 2 ? `, ${groupSize} pela mesma causa (${biggest![0]})` : "") + pausedNote(pausedWaiting, "card espera", "cards esperam")
        : "nenhum card espera publicação" + pausedNote(pausedWaiting, "card espera", "cards esperam"),
    },
  );
}

// ── S7 — a fila do condutor ──────────────────────────────────────────────────────────────────────────

function s7(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const body = { label: "Fila do condutor", unit: "h", fixHint: "Vaga presa por condutor quieto ou terminal zumbi: lembrete, estacionar e só então admitir o próximo; a espera grava o motivo real." };
  // Board pausado pelo freio EM VIGOR: a espera é escolha de quem pausou, não vaga presa — sai da conta e fica citada
  // no detalhe. Retomado o board, conta da retomada. O `waitKind` gravado pela fila NÃO basta: ele só é reescrito a
  // cada passada do despachante, então um despachante morto depois da retomada deixaria «board-paused» velho e o S7
  // verde para sempre — exatamente a falha que o S7 existe para pegar.
  const paused = new Set(i.pausedBoards ?? []);
  const isPaused = (q: HealthQueueEntry): boolean => paused.has(q.board);
  const pausedCount = i.conductorQueue.filter(isPaused).length;
  const queue = i.conductorQueue.filter((q) => !isPaused(q)).map((q) => ({ ...q, queuedAt: sinceResume(i, q.board, q.queuedAt) }));
  const note = pausedNote(pausedCount, "card espera", "cards esperam");
  if (queue.length === 0) return signal("S7", body, t.s7, { value: 0, level: "ok", detail: "ninguém espera uma vaga de condutor" + note });
  // O card que espera há mais tempo: a idade da fila não pode ficar escondida atrás de uma entrada nova de maior prioridade.
  const sorted = [...queue].sort((a, z) => a.queuedAt - z.queuedAt);
  const hours = Math.max(0, i.now - sorted[0].queuedAt) / HOUR_MS;
  return signal("S7", body, t.s7, {
    value: round1(hours),
    level: grade(hours, t.s7),
    evidence: sorted.map((q) => key(q.board, q.cardId)),
    detail: `${plural(queue.length, "card espera", "cards esperam")} uma vaga; o mais antigo há ${round1(hours)} h` + note,
  });
}

// ── S8 — churn de status ─────────────────────────────────────────────────────────────────────────────

function s8(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const since = i.now - t.s8.windowMinutes * MIN_MS;
  const per = new Map<string, number>();
  for (const tr of i.transitions) {
    if (tr.actor === "human" || tr.at <= since || tr.at > i.now) continue;
    const k = key(tr.board, tr.cardId);
    per.set(k, (per.get(k) ?? 0) + 1);
  }
  const ranked = [...per.entries()].sort((a, z) => z[1] - a[1]);
  const max = ranked[0]?.[1] ?? 0;
  return signal(
    "S8",
    {
      label: "Churn de status",
      unit: "saltos",
      rule: `âmbar acima de ${t.s8.amber} saltos não humanos de um card em ${t.s8.windowMinutes} min, vermelho acima de ${t.s8.red}`,
      fixHint: "Guarda genérica no ponto único da transição automática: idas e voltas A↔B do mesmo card param a cascata com o motivo escrito.",
    },
    t.s8,
    {
      value: max,
      level: grade(max, t.s8),
      evidence: ranked.filter(([, n]) => n > t.s8.amber).map(([k]) => k),
      detail: ranked.length ? `${ranked[0][0]}: ${max} saltos não humanos em ${t.s8.windowMinutes} min` : `nenhum card saltou na última janela de ${t.s8.windowMinutes} min`,
    },
  );
}

// ── S9 — arquivo do card × ledger ────────────────────────────────────────────────────────────────────

function s9(i: HealthInputs, t: HealthThresholds): HealthSignal {
  // Em empate de instante, vale o último a ser anexado (o ledger é append-only).
  const last = new Map<string, HealthTransition>();
  for (const tr of i.transitions) {
    const k = key(tr.board, tr.cardId);
    const cur = last.get(k);
    if (!cur || tr.at >= cur.at) last.set(k, tr);
  }
  const diverged = i.cards.filter((c) => {
    const tr = last.get(key(c.board, c.cardId));
    return tr != null && c.status != null && tr.to !== c.status;
  });
  return signal(
    "S9",
    { label: "Card × histórico de status", unit: "cards", fixHint: "Toda mudança de status do arquivo deve passar pelo escritor que grava a transição (e o merge do card pelo train deve reaplicar, não sobrescrever, as escritas de MCP)." },
    t.s9,
    {
      value: diverged.length,
      level: grade(diverged.length, t.s9),
      evidence: diverged.map((c) => key(c.board, c.cardId)),
      detail: diverged.length
        ? diverged.slice(0, 3).map((c) => `${key(c.board, c.cardId)}: arquivo «${c.status}», ledger «${last.get(key(c.board, c.cardId))!.to}»`).join("; ")
        : "o status de todo card com histórico bate com o último salto do ledger",
    },
  );
}

// ── S10 — falha repetida da ferramenta ───────────────────────────────────────────────────────────────

function s10(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const since = i.now - t.s10.windowHours * HOUR_MS;
  const bySignature = new Map<string, HealthToolFailure[]>();
  for (const f of i.toolFailures) {
    if (f.at <= since) continue;
    bySignature.set(f.signature, [...(bySignature.get(f.signature) ?? []), f]);
  }
  const worst = [...bySignature.entries()].sort((a, z) => z[1].length - a[1].length)[0];
  const count = worst?.[1].length ?? 0;
  return signal(
    "S10",
    {
      label: "Falha repetida da ferramenta",
      unit: "repetições",
      rule: `âmbar com mais de ${t.s10.amber} falha(s) da ferramenta, vermelho com mais de ${t.s10.red} (a mesma assinatura em ${t.s10.windowHours} h)`,
      fixHint: "Falha da FERRAMENTA (sandbox, spawn, binário) não é do produto e não vai ao dono: um conserto por assinatura no board da própria ferramenta.",
    },
    t.s10,
    {
      value: count,
      level: grade(count, t.s10),
      evidence: (worst?.[1] ?? []).map((f) => key(f.board, f.cardId)),
      detail: worst ? `a assinatura «${worst[0]}» se repetiu ${count}x em ${t.s10.windowHours} h` : "nenhuma falha da ferramenta na janela",
    },
  );
}

// ── S11 — toque técnico do dono ──────────────────────────────────────────────────────────────────────

function s11(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const body = {
    label: "Toque técnico do dono",
    unit: "toques/história",
    rule: `âmbar acima de ${t.s11.amber}, vermelho acima de ${t.s11.red} toque(s) técnico(s) do dono por história no ar; sem ${t.s11.minAttributionPct}% das ações atribuídas a alguém, não é medível`,
    fixHint: "Cada ação MCP deve carregar o ator (sessão, run, humano): só assim a sessão do próprio dono deixa de passar por autonomia.",
  };
  const { actions, attributed } = i.attribution;
  const pct = actions > 0 ? Math.round((attributed / actions) * 100) : null;
  if (pct == null || pct < t.s11.minAttributionPct) {
    return signal("S11", body, t.s11, {
      value: null,
      level: "unknown",
      detail: pct == null ? "não medível: nenhuma ação MCP na janela" : `não medível: só ${pct}% das ações MCP dizem quem as fez (mínimo ${t.s11.minAttributionPct}%)`,
    });
  }
  const touches = i.touches.technicalTouches + i.touches.ownerSessionActions;
  const value = round2(touches / Math.max(1, i.touches.liveStories));
  return signal("S11", body, t.s11, {
    value,
    level: grade(value, t.s11),
    detail: `${touches} toque(s) técnico(s) do dono em ${plural(i.touches.liveStories, "história", "histórias")} no ar (atribuição ${pct}%)`,
  });
}

// ── S12 — latência de pergunta técnica ───────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function s12(i: HealthInputs, t: HealthThresholds): HealthSignal {
  const body = {
    label: "Pergunta técnica sem resposta",
    unit: "min",
    fixHint: "Pergunta técnica é do proxy: responde em minutos, pelo PRD, e registra as premissas; o `askedAt` precisa gravar a hora para a latência ser medida.",
  };
  let worstMin = 0;
  let worstIsFloor = false;
  const evidence: string[] = [];
  const imprecise: string[] = [];
  for (const q of i.openTechnicalQuestions) {
    const ref = `${key(q.board, q.cardId)}#${q.questionId}`;
    const raw = q.askedAt?.trim() ?? "";
    const dateOnly = DATE_ONLY.test(raw);
    // Só a data (formato antigo): o mais cedo que a pergunta pode ter sido feita é o FIM daquele dia — esse piso nunca
    // dá falso alarme; quando ele ainda não estoura, a latência fica «não medível» em vez de chutada.
    const asked = dateOnly ? Date.parse(`${raw}T00:00:00Z`) + 24 * HOUR_MS : Date.parse(raw);
    if (!Number.isFinite(asked)) {
      imprecise.push(ref);
      continue;
    }
    const min = Math.max(0, (i.now - asked) / MIN_MS);
    if (dateOnly && min <= t.s12.amber) imprecise.push(ref);
    if (min > t.s12.amber) evidence.push(ref);
    if (min > worstMin) {
      worstMin = min;
      worstIsFloor = dateOnly;
    }
  }
  if (worstMin <= t.s12.amber && imprecise.length > 0) {
    return signal("S12", body, t.s12, {
      value: null,
      level: "unknown",
      evidence: imprecise,
      detail: `não medível: ${plural(imprecise.length, "pergunta técnica aberta tem", "perguntas técnicas abertas têm")} só a data (sem hora) em askedAt`,
    });
  }
  return signal("S12", body, t.s12, {
    value: Math.round(worstMin),
    level: grade(worstMin, t.s12),
    evidence,
    detail: i.openTechnicalQuestions.length ? `a pergunta técnica mais antiga espera há ${worstIsFloor ? "pelo menos " : ""}${Math.round(worstMin)} min sem o proxy` : "nenhuma pergunta técnica aberta",
  });
}

// ── o relatório inteiro ─────────────────────────────────────────────────────────────────────────────

/** Mede os doze sinais. PURA: o mesmo input dá o mesmo relatório. */
export function computeHealth(inputs: HealthInputs, thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HealthReport {
  const signals = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12].map((fn) => fn(inputs, thresholds));
  return { at: new Date(inputs.now).toISOString(), signals, worst: worstLevel(signals.map((s) => s.level)) };
}

/** «4 vermelhos (S2, S5…) · 4 em atenção (S1…) · 2 ok · 2 não medíveis». PURA. */
export function summarizeSignals(signals: readonly Pick<HealthSignal, "id" | "level">[]): string {
  const ids = (level: HealthLevel) => signals.filter((s) => s.level === level).map((s) => s.id);
  const group = (level: HealthLevel, one: string, many: string, withIds: boolean): string | null => {
    const list = ids(level);
    if (!list.length) return null;
    return `${list.length} ${list.length === 1 ? one : many}${withIds ? ` (${list.join(", ")})` : ""}`;
  };
  return [group("red", "vermelho", "vermelhos", true), group("amber", "em atenção", "em atenção", true), group("ok", "ok", "ok", false), group("unknown", "não medível", "não medíveis", true)]
    .filter((p): p is string => p !== null)
    .join(" · ");
}

/** Os inputs de uma instalação sem nada: o chão do catálogo (nenhum dado, nenhuma leitura). */
const EMPTY_INPUTS: HealthInputs = {
  now: 0,
  inbox: [],
  demandLanes: [],
  cards: [],
  transitions: [],
  deliveredStatuses: {},
  publishWaiting: [],
  publishHeld: [],
  fleetKnown: false,
  fleet: [],
  orphanTerminals: [],
  claims: [],
  conductorQueue: [],
  stall: [],
  toolFailures: [],
  attribution: { actions: 0, attributed: 0 },
  touches: { liveStories: 0, technicalTouches: 0, ownerSessionActions: 0 },
  openTechnicalQuestions: [],
};

/** O que cada sinal É, sem o que ele mediu: o nome, a unidade, a regra em palavras, os limiares e o primeiro passo. */
export type HealthSignalInfo = Pick<HealthSignal, "id" | "label" | "unit" | "threshold" | "rule" | "fixHint">;

/**
 * O catálogo dos doze sinais, com os limiares EFETIVOS. É a fonte única de rótulo/unidade/regra para quem só LÊ uma
 * leitura gravada (a tela de /processes): o ledger não guarda texto (só valor, nível e a linha do dia), e copiar os
 * nomes numa tabela da tela os deixaria divergir dos que `computeHealth` escreve. Sai de `computeHealth` sobre uma
 * instalação vazia — zero IO, zero relógio. PURA.
 */
export function healthSignalCatalog(thresholds: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HealthSignalInfo[] {
  return computeHealth(EMPTY_INPUTS, thresholds).signals.map(({ id, label, unit, threshold, rule, fixHint }) => ({ id, label, unit, threshold, rule, fixHint }));
}

// ── o delta: antes × depois ─────────────────────────────────────────────────────────────────────────

export type HealthTrend = "melhorou" | "piorou" | "igual" | "não medível";

export interface HealthSignalDelta {
  id: HealthSignalId;
  before: number | null;
  after: number | null;
  beforeLevel: HealthLevel;
  afterLevel: HealthLevel;
  trend: HealthTrend;
}

export interface HealthDelta {
  signals: HealthSignalDelta[];
  improved: HealthSignalId[];
  /** pioraram em qualquer medida — inclusive só o número, dentro do mesmo nível. Informativo: oscila o tempo todo. */
  worsened: HealthSignalId[];
  /**
   * SUBIRAM DE NÍVEL (ok → atenção → vermelho), com os dois lados medidos. É o campo que decide «nada piorou» num ciclo
   * de conserto: num ledger vivo (11 leituras sem release no meio) `worsened` veio cheio em quase todos os pares — S2,
   * S7 e S8 sobem e descem no número o tempo todo — e só um par teve piora de nível. Julgado por `worsened`, nenhum ciclo
   * fecharia e todo conserto bom seria desfeito.
   */
  worsenedLevel: HealthSignalId[];
  /** uma linha para o card e para o resumo da semana. */
  line: string;
}

/**
 * O MÍNIMO de uma leitura para comparar: o id, o valor e o nível de cada sinal. Um `HealthReport` (a medida de agora) e
 * um `HealthRecord` (a linha compacta do health.jsonl, via {@link recordAsReading}) cabem nele — por isso o delta de
 * «agora × a última leitura gravada» não precisa remedir nada nem inventar um relatório com rótulos que o ledger não guarda.
 */
export interface HealthReading {
  signals: ReadonlyArray<Pick<HealthSignal, "id" | "value" | "level">>;
}

/** A leitura gravada no health.jsonl, na forma que o delta compara. PURA. */
export function recordAsReading(record: HealthRecord): HealthReading {
  return {
    signals: HEALTH_SIGNAL_IDS.flatMap((id) => {
      const s = record.signals[id];
      return s ? [{ id, value: s.value, level: s.level }] : [];
    }),
  };
}

/** Compara duas leituras sinal a sinal: o nível manda; com o mesmo nível, o número (menor é melhor). PURA. */
export function healthDelta(before: HealthReading, after: HealthReading): HealthDelta {
  const was = new Map(before.signals.map((s) => [s.id, s]));
  const signals: HealthSignalDelta[] = [];
  for (const now of after.signals) {
    const prev = was.get(now.id);
    if (!prev) continue;
    let trend: HealthTrend;
    if (prev.value == null || now.value == null) trend = "não medível";
    else if (RANK[now.level] !== RANK[prev.level]) trend = RANK[now.level] < RANK[prev.level] ? "melhorou" : "piorou";
    else trend = now.value < prev.value ? "melhorou" : now.value > prev.value ? "piorou" : "igual";
    signals.push({ id: now.id, before: prev.value, after: now.value, beforeLevel: prev.level, afterLevel: now.level, trend });
  }
  const pick = (trend: HealthTrend) => signals.filter((s) => s.trend === trend);
  const fmt = (list: HealthSignalDelta[]) => (list.length ? list.map((s) => `${s.id} (${s.before}→${s.after})`).join(", ") : "nenhum");
  return {
    signals,
    improved: pick("melhorou").map((s) => s.id),
    worsened: pick("piorou").map((s) => s.id),
    // «piorou» já exige os dois valores; aqui os dois NÍVEIS também são medidos (fora do «não medível») e o de depois é pior.
    worsenedLevel: pick("piorou")
      .filter((s) => s.beforeLevel !== "unknown" && s.afterLevel !== "unknown" && RANK[s.afterLevel] > RANK[s.beforeLevel])
      .map((s) => s.id),
    line: `melhorou: ${fmt(pick("melhorou"))}; piorou: ${fmt(pick("piorou"))}`,
  };
}

// ── o registro do tick e a regra «vermelho em N leituras» ────────────────────────────────────────────

/**
 * O que o tick fez pelo card de um sinal vermelho em sequência. `covered`: o card deste EPISÓDIO vermelho já existe e
 * foi fechado (pelo recibo de release, ou descartado pelo dono) — com o sinal ainda vermelho, um card novo seria a
 * duplicata do mesmo problema; quem reabre o antigo é a validação do release, não o tick.
 */
export type HealthCardOutcome =
  | { outcome: "created"; cardId: string }
  | { outcome: "exists"; cardId: string }
  | { outcome: "covered"; cardId: string }
  | { outcome: "skipped"; reason: string };

/** O teto da linha de evidência que a leitura gravada carrega (o `detail` do sinal): uma linha, não um parágrafo. */
export const RECORD_DETAIL_MAX = 160;

/**
 * A linha que o tick anexa ao health.jsonl: compacta — sem os ids de evidência, só o valor, o nível e UMA linha dizendo
 * o que o número quer dizer hoje (`detail`) —, o bastante para a tendência, para a regra «vermelho em N leituras» e para
 * a tela de /processes mostrar o relatório SEM remedir (a página lê a última linha; medir de novo a cada renderização
 * custaria o Inbox de todos os boards por visita). `detail` é opcional: leituras anteriores a ele continuam válidas.
 */
export interface HealthRecord {
  v: 1;
  /** ISO. */
  at: string;
  signals: Partial<Record<HealthSignalId, { value: number | null; level: HealthLevel; detail?: string }>>;
  /** o que o tick fez por cada sinal vermelho em sequência — estruturado: o próximo tick lê daqui qual card cobre o episódio. */
  cards?: Partial<Record<HealthSignalId, HealthCardOutcome>>;
}

/** Uma linha só e com teto: quebra de linha vira espaço, o excesso vira reticências. PURA. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function toHealthRecord(report: HealthReport, cards?: HealthRecord["cards"]): HealthRecord {
  const signals: HealthRecord["signals"] = {};
  for (const s of report.signals) signals[s.id] = { value: s.value, level: s.level, ...(s.detail ? { detail: oneLine(s.detail, RECORD_DETAIL_MAX) } : {}) };
  return { v: 1, at: report.at, signals, ...(cards && Object.keys(cards).length ? { cards } : {}) };
}

/**
 * Os sinais vermelhos em `redTicks` leituras SEGUIDAS (a atual e as `redTicks - 1` anteriores). Leituras com mais de
 * 3 ticks de distância não são «seguidas»: depois de o serviço ficar parado por horas, um vermelho antigo mais um
 * vermelho de agora não são duas leituras seguidas — a regra existe para não abrir card por um pico. PURA.
 */
export function redStreaks(history: readonly HealthRecord[], current: HealthReport, settings: Pick<HealthSettings, "redTicks" | "tickMinutes">): HealthSignal[] {
  const reds = current.signals.filter((s) => s.level === "red");
  if (settings.redTicks <= 1) return reds;
  const maxGapMs = 3 * settings.tickMinutes * MIN_MS;
  const previous = [...history].sort((a, z) => z.at.localeCompare(a.at)).slice(0, settings.redTicks - 1);
  if (previous.length < settings.redTicks - 1) return [];
  let newer = Date.parse(current.at);
  for (const p of previous) {
    const at = Date.parse(p.at);
    if (!Number.isFinite(at) || newer - at > maxGapMs) return [];
    newer = at;
  }
  return reds.filter((s) => previous.every((p) => p.signals[s.id]?.level === "red"));
}

/**
 * O card que já cobre o episódio vermelho ATUAL do sinal, ou `null` quando o episódio ainda não tem card. Um episódio é
 * a sequência de leituras desde a última em que o sinal esteve FORA do vermelho (`ok` ou `amber`); o card que o tick
 * criou ou achou dentro dela o cobre até o fim — inclusive depois de fechado. PURA.
 *
 * POR QUE. O dedup só por «card aberto» deixava nascer uma duplicata no tick seguinte ao release (o S6 mede horas desde a
 * última entrega e segue vermelho logo depois do conserto) e outra a cada vez que o dono descartava o card: cada uma um
 * julgamento novo da triagem, a cada 5 min, sem teto. «Não medível» e leitura sem o sinal não provam que o vermelho
 * passou: não fecham o episódio.
 */
export function episodeCover(history: readonly HealthRecord[], id: HealthSignalId): string | null {
  let cover: string | null = null;
  for (const r of [...history].sort((a, z) => a.at.localeCompare(z.at))) {
    const level = r.signals[id]?.level;
    if (level === "ok" || level === "amber") cover = null;
    const card = r.cards?.[id];
    if (card && card.outcome !== "skipped") cover = card.cardId;
  }
  return cover;
}
