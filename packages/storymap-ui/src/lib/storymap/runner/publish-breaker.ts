// publish-breaker — o DISJUNTOR da publicação automática: quantas vezes seguidas a cascata já tentou levar UM card ao
// ar e falhou, e quando ela pode tentar de novo.
//
// POR QUE EXISTE (um laço de publicação que roda sem parar se ninguém o freia). A parada «Liberar» (`release`) era HUMANA: o revert
// de um deploy falho devolvia o card para lá e o deploy só recomeçava quando alguém clicava (deploy-revert.ts:
// "Human-gated, so a failure whose cause is unfixed never auto-retry-loops"). Quando `release` virou uma
// passagem automática (`autorun: true`, `release.mode: auto`), a garantia de não-laço, que era o CLIQUE,
// sumiu sem ser substituída. Um deploy do alvo que sai com o código de «precisa de humano» (determinístico, a
// causa não muda sozinha) passa a: reverter para Liberar → a cascata re-encaminha na hora → novo deploy → exit 3…
// a cada passada, sem parar, em vários cards: uma enxurrada de transições e de disparos de deploy (cada um lê o que
// está no ar em vários serviços) e uma escrita de card atrás da outra. O caminho `needs-proof` JÁ tinha
// evitado o revert pelo mesmo motivo; esta peça generaliza a defesa para TODA falha que volta a `release`.
//
// A REGRA (pura, em {@link nextPublishAttempt} / {@link publishHoldReason}):
//   · falha DETERMINÍSTICA (`needs-human`, `needs-proof`): a causa só muda quando alguém age — espera longa e poucas
//     tentativas (a nova tentativa só ajuda se a pessoa publicou a unidade à mão e não clicou);
//   · falha TRANSITÓRIA (todo o resto: timeout, preflight de frescor, promoção concorrente…): recuo exponencial;
//   · ESGOTADO o limite, o sistema PARA de tentar sozinho e o card espera o botão «Publicar» (que sempre passa — o
//     disjuntor só governa a CASCATA, nunca um ato explícito de quem clica);
//   · uma falha só conta se a anterior é recente: depois de 24h de silêncio o histórico é esquecido.
// O sucesso (settle ok) zera o card. Quem vence o relógio é `retryDuePublishes` (publish-retry.ts), que re-avalia a
// cascata quando o recuo vence — sem ele a espera nunca acabaria, porque a cascata é movida a evento.
//
// POR CAUSA, NÃO POR CARD. O deploy publica o pacote INTEIRO no HEAD: quando ele para, para pela mesma causa
// para todo card que espera. O registro por card dava a cada um o seu relógio — N linhas, N tentativas agendadas para
// bem menos causas, e cada tentativa lê o que está no ar em vários serviços. Agora a linha é da CAUSA (`causeKey`, deploy-blocks.ts) e
// segura todos os cards dela (`cardIds`): uma tentativa por causa por intervalo. Um card que chega DENTRO do intervalo e
// falha pela mesma causa só ENTRA na linha (não conta tentativa nem empurra o relógio). A borda solta a linha antes do
// relógio: o fato que segurava sumiu (o plano não a lista mais, o preflight passou) ⇒ `releaseCause` põe `nextAt` em agora;
// as 6 h ficam só como rede de segurança. A borda CONTA contra o teto e tira o esgotamento uma vez só (duas fontes que
// discordam sempre não podem virar um deploy real a cada janela de re-medição). A linha sem `causeKey` é a de antes (por
// card) e segue valendo até migrar.
//
// O FÔLEGO É SEPARADO DO RELÓGIO (`leaseUntil`). Antes, o fôlego da re-tentativa empurrava `nextAt` — e a própria
// reavaliação que ele protegia lia a trava armada e SEGURAVA o card: a re-tentativa automática nunca encaminhava
// (o `nextAt` de vários cards eram fôlegos, e `consecutive` ficava parado em 1).
//
// SERVER-ONLY (node:fs). Espelha pending-effects.ts: store injetável, persist atômico, carga única memoizada.

import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runnerStateDir } from "@/lib/storymap/paths";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

export type PublishFailureClass = "deterministic" | "transient";

/** A política, num lugar só (os testes leem daqui — um número mudado aqui muda o contrato, não uma cópia). */
export const PUBLISH_BACKOFF = {
  transient: { baseMs: 10 * MIN_MS, factor: 4, capMs: 6 * HOUR_MS, maxConsecutive: 5 },
  deterministic: { delayMs: 6 * HOUR_MS, maxConsecutive: 3 },
  /** depois deste silêncio desde a última falha, a próxima começa a contagem do zero */
  forgetAfterMs: 24 * HOUR_MS,
  /** ao re-avaliar um card vencido, ele ganha este fôlego antes de poder vencer de novo (a avaliação pode não encaminhar) */
  retryLeaseMs: 10 * MIN_MS,
} as const;

/**
 * `needs-human`/`needs-units`/`needs-proof` só mudam quando ALGUÉM age (o dono decide, o sistema publica a unidade ou
 * conserta a tabela de classes, a prova sai) — repetir o deploy antes disso só repete a recusa; quem antecipa a nova
 * tentativa é a BORDA (o fato mudou), não o relógio. Qualquer outra fase pode passar sozinha.
 */
export function classifyPublishFailure(phase: string | undefined): PublishFailureClass {
  return phase === "needs-human" || phase === "needs-units" || phase === "needs-proof" ? "deterministic" : "transient";
}

export interface PublishAttempt {
  board: string;
  /** o card que a próxima tentativa re-encaminha primeiro (o último que CONTOU uma tentativa por esta linha). */
  cardId: string;
  /** a causa desta linha (DeployCause.causeKey) — a chave do registro. Ausente = linha por card (anterior às causas). */
  causeKey?: string;
  /** todos os cards que a causa segura (inclui `cardId`). Ausente = só `cardId`. */
  cardIds?: string[];
  /** a fase da última falha (`needs-human`, `freshness`, `release`, `deploy`…) */
  phase: string;
  exitCode: number | null;
  /** falhas SEGUIDAS até aqui (a desta inclusive) */
  consecutive: number;
  lastAt: number;
  /** a partir daqui a cascata pode encaminhar de novo */
  nextAt: number;
  /** passou do limite: a cascata não tenta mais sozinha (o botão «Publicar» segue valendo) */
  exhausted: boolean;
  /** o fôlego da re-tentativa em curso: até aqui a linha não vence de novo. NUNCA segura a cascata (só `due`). */
  leaseUntil?: number;
}

/** Os cards que a linha segura. PURA. */
export function attemptCardIds(a: Pick<PublishAttempt, "cardId" | "cardIds">): string[] {
  return a.cardIds?.length ? a.cardIds : [a.cardId];
}

/** O teto de falhas seguidas da classe — passado dele, a cascata não tenta mais sozinha. PURA. */
function maxConsecutiveOf(cls: PublishFailureClass): number {
  return cls === "deterministic" ? PUBLISH_BACKOFF.deterministic.maxConsecutive : PUBLISH_BACKOFF.transient.maxConsecutive;
}

/** Quanto esperar depois da `consecutive`-ésima falha seguida (1 = a primeira). PURA. */
export function backoffDelayMs(cls: PublishFailureClass, consecutive: number): number {
  if (cls === "deterministic") return PUBLISH_BACKOFF.deterministic.delayMs;
  const { baseMs, factor, capMs } = PUBLISH_BACKOFF.transient;
  return Math.min(baseMs * factor ** Math.max(0, consecutive - 1), capMs);
}

/**
 * O próximo registro depois de mais uma falha. PURA — `prev` é o registro anterior (ou undefined).
 *
 * Numa linha de CAUSA, a falha de OUTRO card que chega DENTRO do intervalo (antes de `nextAt`), ou numa linha já
 * esgotada, não é uma tentativa nova: é mais um card parado pela mesma causa — ele ENTRA na linha e nada mais muda. Conta:
 * a falha que chega com o intervalo vencido (a re-tentativa agendada, ou o primeiro card depois dela — que vira o
 * representante) e a do próprio representante de novo (alguém o publicou pelo botão). Assim a onda de re-tentativa, em
 * que todos os cards da causa falham juntos, conta UMA vez.
 */
export function nextPublishAttempt(
  prev: PublishAttempt | undefined,
  key: { board: string; cardId: string; causeKey?: string },
  detail: { phase?: string; exitCode?: number | null },
  now: number,
): PublishAttempt {
  if (prev && key.causeKey && (prev.exhausted || (now < prev.nextAt && key.cardId !== prev.cardId))) {
    const cardIds = [...new Set([...attemptCardIds(prev), key.cardId])];
    return { ...prev, causeKey: key.causeKey, cardIds };
  }
  const phase = detail.phase ?? "deploy";
  const cls = classifyPublishFailure(phase);
  const carried = prev && now - prev.lastAt <= PUBLISH_BACKOFF.forgetAfterMs ? prev.consecutive : 0;
  const consecutive = carried + 1;
  const max = maxConsecutiveOf(cls);
  return {
    board: key.board,
    cardId: key.cardId,
    ...(key.causeKey ? { causeKey: key.causeKey, cardIds: [...new Set([key.cardId, ...(prev ? attemptCardIds(prev) : [])])] } : {}),
    phase,
    exitCode: detail.exitCode ?? null,
    consecutive,
    lastAt: now,
    nextAt: now + backoffDelayMs(cls, consecutive),
    exhausted: consecutive >= max,
  };
}

function waitLabel(ms: number): string {
  const min = Math.max(1, Math.round(ms / MIN_MS));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const PHASE_LABEL: Record<string, string> = {
  "needs-human": "a publicação espera uma decisão do dono",
  "needs-units": "há unidade sem classe de publicação — trabalho do sistema",
  "needs-proof": "falta uma prova",
  freshness: "o preflight de frescor recusou",
  release: "a promoção para main falhou",
  "deploy-noop": "o deploy não fez nada",
  "face-stale": "o rosto não atualizou",
};

/**
 * Por que a cascata NÃO deve encaminhar este card agora — em português, para o log e para a superfície — ou null
 * (livre: nunca falhou, ou o recuo já venceu). Um registro esgotado segura até alguém publicar. PURA.
 */
export function publishHoldReason(attempt: PublishAttempt | undefined, now: number): string | null {
  if (!attempt) return null;
  const why = PHASE_LABEL[attempt.phase] ?? `o deploy falhou${attempt.exitCode != null ? ` (exit ${attempt.exitCode})` : ""}`;
  if (attempt.exhausted) {
    return (
      `a publicação falhou ${attempt.consecutive}× seguidas (${why}) e o sistema parou de tentar sozinho — ` +
      `resolva a causa e publique pelo botão «Publicar»`
    );
  }
  if (now >= attempt.nextAt) return null;
  return (
    `a publicação falhou ${attempt.consecutive}× seguidas (${why}); nova tentativa automática em ` +
    `${waitLabel(attempt.nextAt - now)} — ou publique você pelo botão «Publicar»`
  );
}

/**
 * Quando a cascata vai tentar de novo SOZINHA (ms), ou null (nunca falhou, já venceu, ou esgotou — aí só o botão). É o que
 * deixa o Inbox não oferecer «Publicar de novo» como ação arriscada num item que o sistema já vai re-tentar às HH:MM
 * (num caso real, o botão «danger» aparecia em itens de frescor cuja re-tentativa estava agendada). PURA.
 */
export function publishRetryAt(attempt: PublishAttempt | undefined, now: number): number | null {
  if (!attempt || attempt.exhausted || attempt.nextAt <= now) return null;
  return attempt.nextAt;
}

// ── o registro durável ──────────────────────────────────────────────────────────────────────────────────

export interface PublishBreakerStore {
  load(): Promise<PublishAttempt[]>;
  /**
   * Carga SÍNCRONA, opcional. O registro é um arquivo de poucas linhas lido UMA vez por processo, e quem o consulta é o
   * caminho quente da cascata (toda avaliação de card). Uma carga assíncrona ali põe I/O no meio de cada primeira avaliação
   * e abre uma janela sem estado logo após o boot — com a leitura síncrona o estado existe antes da primeira decisão.
   */
  loadSync?(): PublishAttempt[];
  persist(rows: PublishAttempt[]): Promise<void>;
}

/** A chave de uma linha: a da causa quando há, senão a do card (o formato de antes — linhas antigas seguem valendo). */
const keyOf = (board: string, cardId: string, causeKey?: string) => (causeKey ? `${board}/causa:${causeKey}` : `${board}/${cardId}`);
const keyOfRow = (a: PublishAttempt) => keyOf(a.board, a.cardId, a.causeKey);

/** A linha sem o card: o próximo da fila vira o representante; sem nenhum, null (a linha some). PURA. */
function withoutCard(a: PublishAttempt, cardId: string): PublishAttempt | null {
  const rest = attemptCardIds(a).filter((c) => c !== cardId);
  if (rest.length === 0) return null;
  return { ...a, cardId: a.cardId === cardId ? rest[0] : a.cardId, ...(a.causeKey ? { cardIds: rest } : {}) };
}

export class PublishBreaker {
  private entries = new Map<string, PublishAttempt>();
  // carga única memoizada: todo chamador concorrente espera a MESMA resolução e MESCLA (nunca sobrescreve) — uma
  // falha gravada durante a carga sobrevive à cópia velha do disco.
  private loadOnce?: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PublishBreakerStore,
    private readonly now: () => number = Date.now,
  ) {}

  private merge(rows: PublishAttempt[]): void {
    for (const r of rows) {
      const k = keyOfRow(r);
      if (!this.entries.has(k)) this.entries.set(k, r);
    }
  }

  ensureLoaded(): Promise<void> {
    if (this.loadOnce) return this.loadOnce;
    if (this.store.loadSync) {
      try {
        this.merge(this.store.loadSync());
      } catch {
        /* ilegível ⇒ começa vazio (a mesma regra da carga assíncrona) */
      }
      return (this.loadOnce = Promise.resolve());
    }
    return (this.loadOnce = this.store
      .load()
      .catch(() => [] as PublishAttempt[])
      .then((rows) => this.merge(rows)));
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain.then(async () => {
      await this.store.persist([...this.entries.values()]).catch((err) => {
        console.error("[publish-breaker] persist falhou:", err instanceof Error ? err.message : err);
      });
    });
  }

  /** A chave da linha que segura o card agora (a da causa dele, ou a dele por card), ou null. */
  private keyHolding(board: string, cardId: string): string | null {
    for (const [k, a] of this.entries) if (a.board === board && attemptCardIds(a).includes(cardId)) return k;
    return null;
  }

  /** Tira o card das linhas do board que NÃO são `except` (um card é segurado por uma causa de cada vez). */
  private detach(board: string, cardId: string, except: string | null): PublishAttempt | undefined {
    let legacy: PublishAttempt | undefined;
    for (const [k, a] of [...this.entries]) {
      if (k === except || a.board !== board || !attemptCardIds(a).includes(cardId)) continue;
      if (!a.causeKey) legacy = a; // a linha antiga POR CARD: a contagem dela migra para a causa (não recomeça do zero)
      const rest = withoutCard(a, cardId);
      if (rest) this.entries.set(k, rest);
      else this.entries.delete(k);
    }
    return legacy;
  }

  /**
   * Mais uma falha de publicação deste card — SÍNCRONA, para o revert registrá-la DENTRO do lock do card, antes de o
   * write que devolve o card a `release` ficar visível: a reavaliação da cascata que esse write provoca já lê a
   * trava. (Registrar depois deixaria uma janela em que o eco do watcher encaminha o card de novo.) Seguro antes de
   * a carga terminar: a carga MESCLA e nunca sobrescreve uma chave já presente.
   *
   * Com `causeKey`, a linha é a da causa: o card sai de qualquer outra linha (mudou de causa) e a contagem de uma linha
   * antiga POR CARD vira o ponto de partida da linha da causa quando ela ainda não existe (migração sem zerar o recuo).
   */
  recordFailureNow(board: string, cardId: string, detail: { phase?: string; exitCode?: number | null; causeKey?: string }): PublishAttempt {
    const key = keyOf(board, cardId, detail.causeKey);
    const detached = this.detach(board, cardId, key);
    const legacy = detail.causeKey ? detached : undefined;
    const prev = this.entries.get(key) ?? (legacy ? { ...legacy, causeKey: detail.causeKey, cardIds: [cardId] } : undefined);
    const next = nextPublishAttempt(prev, { board, cardId, causeKey: detail.causeKey }, detail, this.now());
    this.entries.set(key, next);
    this.schedulePersist();
    return next;
  }

  async recordFailure(board: string, cardId: string, detail: { phase?: string; exitCode?: number | null; causeKey?: string }): Promise<PublishAttempt> {
    await this.ensureLoaded();
    return this.recordFailureNow(board, cardId, detail);
  }

  /**
   * Põe o card sob a linha da sua causa SEM contar tentativa — o backfill do card que falhou antes de as causas existirem
   * (deploy-blocks.ts). A linha antiga por card dele migra (a contagem e o relógio dela); sem nenhuma, nasce uma com o
   * recuo da classe a partir de agora, porque um card parado sem trava seria re-encaminhado no próximo evento.
   */
  async adoptCard(board: string, cardId: string, causeKey: string, phase: string): Promise<PublishAttempt> {
    await this.ensureLoaded();
    const key = keyOf(board, cardId, causeKey);
    const legacy = this.detach(board, cardId, key);
    const cur = this.entries.get(key);
    let next: PublishAttempt;
    if (cur) next = { ...cur, cardIds: [...new Set([...attemptCardIds(cur), cardId])] };
    else if (legacy) next = { ...legacy, cardId, causeKey, cardIds: [cardId], phase };
    else next = nextPublishAttempt(undefined, { board, cardId, causeKey }, { phase }, this.now());
    this.entries.set(key, next);
    this.schedulePersist();
    return next;
  }

  /**
   * A publicação DEU CERTO: a causa que segurava este card acabou (o deploy do pacote passou). A linha inteira é SOLTA —
   * o card sai, e os outros que ela segurava vencem agora (a re-tentativa os leva; o deploy deles é o mesmo, já verde).
   * Idempotente.
   */
  async clear(board: string, cardId: string): Promise<void> {
    await this.ensureLoaded();
    const k = this.keyHolding(board, cardId);
    if (!k) return;
    const rest = withoutCard(this.entries.get(k)!, cardId);
    if (rest && rest.causeKey) this.entries.set(k, { ...rest, nextAt: Math.min(rest.nextAt, this.now()), exhausted: false, leaseUntil: undefined });
    else this.entries.delete(k);
    this.schedulePersist();
  }

  /** O card saiu do caminho (apagado, concluído, movido): só ele sai da linha; a causa segue segurando os outros. */
  async forget(board: string, cardId: string): Promise<void> {
    await this.ensureLoaded();
    const k = this.keyHolding(board, cardId);
    if (!k) return;
    const rest = withoutCard(this.entries.get(k)!, cardId);
    if (rest) this.entries.set(k, rest);
    else this.entries.delete(k);
    this.schedulePersist();
  }

  /**
   * A BORDA: o fato que segurava a causa sumiu (o plano não a lista mais, o preflight passou). A linha vence AGORA e a
   * re-tentativa leva todos os cards dela. Devolve os cards; [] quando não há linha; null quando a borda RECUSA (abaixo)
   * — quem fecha a causa precisa saber disso para não dizer «o sistema tenta de novo» a um card que segue segurado.
   *
   * A borda CONTA contra o teto: a tentativa que ela antecipa é uma tentativa como qualquer outra (a falha seguinte soma
   * em `consecutive`). E ela tira o esgotamento UMA vez só — enquanto `consecutive` não passou do teto (a linha esgotou
   * pelo relógio; o fato novo merece uma chance). A falha depois dessa chance passa do teto, e a próxima borda não solta
   * mais: a borda compara duas fontes (o plano de agora e a causa que o revert montou do log), e se elas discordam sempre
   * a causa é «vista sumir» a cada janela de re-medição — sem o limite, o deploy real rodava de 15 em 15 min para sempre.
   */
  async releaseCause(board: string, causeKey: string, at: number = this.now()): Promise<string[] | null> {
    await this.ensureLoaded();
    const k = keyOf(board, "", causeKey);
    const cur = this.entries.get(k);
    if (!cur) return [];
    if (cur.exhausted && cur.consecutive > maxConsecutiveOf(classifyPublishFailure(cur.phase))) return null;
    this.entries.set(k, { ...cur, nextAt: Math.min(cur.nextAt, at), exhausted: false, leaseUntil: undefined });
    this.schedulePersist();
    return attemptCardIds(cur);
  }

  /** O motivo de segurar a cascata para este card agora, ou null. O fôlego (`leaseUntil`) nunca segura. */
  async holdReason(board: string, cardId: string, at: number = this.now()): Promise<string | null> {
    await this.ensureLoaded();
    const k = this.keyHolding(board, cardId);
    return publishHoldReason(k ? this.entries.get(k) : undefined, at);
  }

  /** Quando a re-tentativa automática deste card acontece (ver {@link publishRetryAt}), ou null. */
  async retryAt(board: string, cardId: string, at: number = this.now()): Promise<number | null> {
    await this.ensureLoaded();
    const k = this.keyHolding(board, cardId);
    return publishRetryAt(k ? this.entries.get(k) : undefined, at);
  }

  /** As LINHAS cujo recuo venceu, fora do fôlego, e que ainda podem tentar sozinhas (as esgotadas esperam o botão). */
  async due(at: number = this.now()): Promise<PublishAttempt[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].filter((a) => !a.exhausted && a.nextAt <= at && (a.leaseUntil ?? 0) <= at);
  }

  /** O fôlego depois de re-avaliar: a avaliação pode não encaminhar, e a linha não pode vencer a cada tick. Só adia. */
  async lease(board: string, cardId: string, until: number): Promise<void> {
    await this.ensureLoaded();
    const k = this.keyHolding(board, cardId);
    const cur = k ? this.entries.get(k) : undefined;
    if (!k || !cur || (cur.leaseUntil ?? 0) >= until) return;
    this.entries.set(k, { ...cur, leaseUntil: until });
    this.schedulePersist();
  }

  /**
   * Uma visão POR CARD (uma entrada para cada card que uma linha segura, com `cardId` = ele). É o que os leitores de «este
   * card está segurado?» precisam (o vigia de parada, a varredura que esquece quem saiu do caminho) — eles continuam
   * comparando `board`+`cardId`, sem saber de causa.
   */
  async snapshot(): Promise<PublishAttempt[]> {
    await this.ensureLoaded();
    return [...this.entries.values()].flatMap((a) => attemptCardIds(a).map((cardId) => ({ ...a, cardId })));
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }
}

const VERSION = 1;
// Os campos da causa e o fôlego são OPCIONAIS: a linha gravada antes deles (por card) segue legível, sem migração de versão.
const AttemptSchema = z.object({
  board: z.string(),
  cardId: z.string(),
  causeKey: z.string().min(1).optional(),
  cardIds: z.array(z.string().min(1)).optional(),
  phase: z.string(),
  exitCode: z.number().nullable(),
  consecutive: z.number().int().min(1),
  lastAt: z.number(),
  nextAt: z.number(),
  exhausted: z.boolean(),
  leaseUntil: z.number().optional(),
});

/** O conteúdo do arquivo → as linhas válidas. Versão desconhecida, JSON quebrado e linha inválida valem como vazio. */
function parseAttempts(raw: string): PublishAttempt[] {
  try {
    const data = JSON.parse(raw);
    if (data?.version !== VERSION || !Array.isArray(data.entries)) return [];
    const ok: PublishAttempt[] = [];
    for (const r of data.entries) {
      const p = AttemptSchema.safeParse(r);
      if (p.success) ok.push(p.data);
    }
    return ok;
  } catch {
    return [];
  }
}

/** Store em disco: tmp + rename atômicos; um arquivo de outra versão ou ilegível vale como vazio (começa limpo). */
export function diskPublishBreakerStore(dir: string): PublishBreakerStore {
  const file = path.join(dir, "deploy-attempts.json");
  const tmp = `${file}.tmp`;
  return {
    async load() {
      try {
        return parseAttempts(await fsp.readFile(file, "utf8"));
      } catch {
        return []; // ausente (ENOENT) ou ilegível
      }
    },
    loadSync() {
      try {
        return parseAttempts(readFileSync(file, "utf8"));
      } catch {
        return [];
      }
    },
    async persist(rows) {
      await fsp.mkdir(dir, { recursive: true });
      const body = JSON.stringify({ version: VERSION, entries: rows }, null, 2);
      await fsp.writeFile(tmp, body, "utf8");
      await fsp.rename(tmp, file);
    },
  };
}

const KEY = Symbol.for("storymap.runner.publishBreaker");
const holder = globalThis as unknown as { [KEY]?: PublishBreaker };

/** O disjuntor do processo (um só — o revert, a cascata e a varredura precisam ver o MESMO registro). */
export function getPublishBreaker(): PublishBreaker {
  return (holder[KEY] ??= new PublishBreaker(diskPublishBreakerStore(runnerStateDir())));
}

/**
 * O disjuntor, ou null quando não puder ser obtido (o diretório de estado do runner não resolve). O FREIO NUNCA PODE IMPEDIR
 * a operação que ele acompanha: o revert que devolve o card a «Liberar» e o settle que o avança precisam acontecer mesmo
 * sem registro — no pior caso volta o comportamento anterior ao disjuntor. Quem grava/zera usa este acessor.
 */
export function tryGetPublishBreaker(): PublishBreaker | null {
  try {
    return getPublishBreaker();
  } catch (err) {
    console.error("[publish-breaker] indisponível (seguindo sem o freio):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Só para teste: descarta o singleton (o próximo `getPublishBreaker` relê o disco). */
export function resetPublishBreakerForTest(): void {
  delete holder[KEY];
}
