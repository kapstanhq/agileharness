// A FILA DE SAÍDA (outbox) do chat do Jido — o núcleo PURO. Um envio que o operador já confirmou e que o
// servidor ainda NÃO aceitou. Sem React e sem fetch: só as decisões (o que despachar, o que é "ocupado" × o que
// é falha, quanto esperar antes de tentar de novo). O hook (`useCopilotAgent`) é a casca que as executa; a
// lógica mora aqui porque teste de render com RTL está quebrado sob rolldown-vite — mesma disciplina de
// `history-sync` e `escalation-seed`.
//
// O INCIDENTE (2026-07-25). Mandar uma mensagem enquanto o Jido trabalhava devolvia 409 e a mensagem virava
// uma bolha "⚠ Falha no turno: já há um copiloto trabalhando…": o operador tinha de reenviar NA MÃO, e o
// rascunho só sobrevivia porque um remendo o devolvia ao composer. Em qualquer chat de agente (Claude, GPT) o
// envio é ACEITO na hora e SAI quando abre espaço. É essa a mudança de modelo: a regra do servidor ("1 turno
// por board") continua igual — o cliente para de tratá-la como ERRO e passa a tratá-la como FILA.
//
// Invariantes que este módulo carrega:
//  1. Nada que o operador confirmou se perde: o item só sai da fila quando o servidor ACEITA o turno (ou
//     quando o próprio operador o remove).
//  2. Ocupado ≠ falha. Só recusas TRANSITÓRIAS (`BUSY_REASONS`) são re-tentadas; um 409 permanente (sessão
//     atrelada a outro board) é falha e nunca vira laço.
//  3. A espera é LIMITADA e VISÍVEL: backoff com teto, tempo total com teto, e ao esgotar a fila PAUSA (com o
//     texto intacto) em vez de bater no servidor para sempre.

/** Um envio confirmado pelo operador, aguardando espaço. `id` é estável (chave de render + remoção). */
export interface OutboxItem {
  id: string;
  /** o texto do operador (ou o texto CRU da slash command, quando `command` está presente). */
  text: string;
  selectedOptionIds?: string[];
  /** paths absolutos das imagens já subidas (o upload acontece ANTES de entrar na fila). */
  images?: string[];
  /** rótulo de slash command (`SendOptions.command`): vai CRU ao CLI e ecoa como EVENTO, não como fala. */
  command?: string;
  enqueuedAt: number;
}

/** Teto de itens na fila. Não é orçamento de UX — é anti-patologia (loop de UI, dedo preso no Enter). Cheio, o
 *  envio é RECUSADO com aviso (o composer mantém o texto); nunca se dropa item já aceito para caber outro. */
export const OUTBOX_CAP = 25;

/** Motivos de recusa TRANSITÓRIA: o board está ocupado AGORA e vai liberar sozinho. Só estes são re-tentados. */
export const BUSY_REASONS = ["turn-in-flight", "autonomous-tick"] as const;
export type BusyReason = (typeof BUSY_REASONS)[number];

/** Recusa PERMANENTE que também responde 409 (a sessão guardada pertence a outro board): re-tentar nunca
 *  resolve — é falha, e o operador precisa de "Nova conversa". */
export const FATAL_409_REASON = "session-board-mismatch";

/** O que a rota do turno devolveu quando recusou: transitório (fila espera) ou fatal (fila pausa). */
export type TurnRejection = { kind: "busy"; reason: BusyReason } | { kind: "fatal" };

/** Corpo de erro da rota, tolerante a lixo: `{ok:false, error?, reason?}` — nunca lança. */
export function parseRejectionBody(body: string): { error?: string; reason?: string } {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; reason?: unknown };
    return {
      ...(typeof parsed?.error === "string" && parsed.error.trim() ? { error: parsed.error.trim() } : {}),
      ...(typeof parsed?.reason === "string" && parsed.reason.trim() ? { reason: parsed.reason.trim() } : {}),
    };
  } catch {
    return {}; // corpo não-JSON (página de erro de proxy, texto puro) — o chamador cai no genérico
  }
}

function isBusyReason(reason: string | undefined): reason is BusyReason {
  return reason !== undefined && (BUSY_REASONS as readonly string[]).includes(reason);
}

/**
 * A RÉGUA DO RETRY: esta recusa vai liberar sozinha (espera) ou não (falha)?
 *
 * Só 409 é candidato a espera — é o código que a rota usa para "1 turno por board". Dentro dele quem decide é o
 * `reason` legível por máquina, NUNCA o texto do erro (texto é copy: muda sem aviso e não é contrato).
 *  • `reason` transitório  ⇒ espera.
 *  • `reason` ausente      ⇒ espera. É o servidor ANTIGO (aba aberta atravessando um deploy): antes do campo,
 *    todo 409 alcançável do chat era ocupado. O teto de espera limita o dano se for o caso permanente.
 *  • `reason` desconhecido ⇒ FALHA. Conservador de propósito: sem saber se libera, esperar é que viraria laço.
 */
export function classifyTurnRejection(status: number, body: string): TurnRejection {
  if (status !== 409) return { kind: "fatal" };
  const { reason } = parseRejectionBody(body);
  if (isBusyReason(reason)) return { kind: "busy", reason };
  if (reason === undefined) return { kind: "busy", reason: "turn-in-flight" };
  return { kind: "fatal" };
}

/** Backoff das re-tentativas contra um board ocupado. Curto no começo (o turno pareado costuma ser rápido) e com
 *  TETO baixo: cada tentativa re-resolve o contexto FRESCO do board (o board se move enquanto se espera), então o
 *  teto é o que segura o custo dessa leitura — e 8s é também o pior atraso entre "abriu espaço" e "saiu". */
const BUSY_BACKOFF_MS = [1_500, 3_000, 5_000, 8_000] as const;

export function busyBackoffMs(attempt: number): number {
  const i = Math.min(Math.max(Math.trunc(attempt), 0), BUSY_BACKOFF_MS.length - 1);
  return BUSY_BACKOFF_MS[i];
}

/** Teto do tempo TOTAL de espera de um item. Casa com o TTL do lease de pareamento (15min) e é maior que o
 *  watchdog do turno (10min): dentro dele, qualquer ocupação legítima já terminou. Ao esgotar, a fila PAUSA. */
export const MAX_BUSY_WAIT_MS = 15 * 60_000;

export function busyWaitExhausted(waitedMs: number): boolean {
  return waitedMs >= MAX_BUSY_WAIT_MS;
}

/** Enfileira preservando a ORDEM de digitação. `accepted:false` só no teto (o composer mantém o texto). */
export function enqueueOutbox(queue: readonly OutboxItem[], item: OutboxItem): { queue: OutboxItem[]; accepted: boolean } {
  if (queue.length >= OUTBOX_CAP) return { queue: [...queue], accepted: false };
  return { queue: [...queue, item], accepted: true };
}

/** Remove um item (o ✕ do operador, ou o despacho aceito pelo servidor). Idempotente. */
export function dropOutboxItem(queue: readonly OutboxItem[], id: string): OutboxItem[] {
  return queue.filter((i) => i.id !== id);
}

/** O próximo a despachar: a CABEÇA da fila, e só quando ela não está pausada. FIFO estrito — um chat é uma
 *  conversa, e reordenar o que o operador disse mudaria o sentido. */
export function nextOutboxItem(queue: readonly OutboxItem[], opts: { paused: boolean }): OutboxItem | null {
  if (opts.paused) return null;
  return queue[0] ?? null;
}

/** id estável e legível por sequência (o hook mantém o contador) — determinístico, testável, sem Math.random. */
export function makeOutboxId(seq: number): string {
  return `q${seq}`;
}

/** O que a bolha da fila mostra: uma slash command aparece pelo seu rótulo; um envio só-com-imagem tem texto vazio. */
export function outboxItemLabel(item: OutboxItem): string {
  if (item.command) return item.command;
  if (item.text.trim()) return item.text;
  const n = item.images?.length ?? 0;
  return n ? `(${n} ${n === 1 ? "imagem" : "imagens"})` : "(vazio)";
}

/** "1 mensagem na fila" / "3 mensagens na fila" — a contagem que o operador lê. (Plural em PT-BR troca o -m
 *  por -ns: sufixar "s" produziria "mensagems", que é o defeito que este comentário existe para não repetir.) */
export function outboxSummary(n: number): string {
  return `${n} ${n === 1 ? "mensagem" : "mensagens"} na fila`;
}

/** Por que ainda não saiu — nomeia QUEM está ocupando, que é a diferença entre esperar e achar que travou. */
export function outboxWaitingNotice(reason: BusyReason): string {
  return reason === "autonomous-tick"
    ? "O ciclo autônomo está agindo neste board — envio automático quando ele terminar."
    : "Aguardando o turno atual terminar — envio automático quando liberar.";
}

/** O desfecho de UMA tentativa de turno — é o que o pump lê para decidir entre seguir, esperar ou pausar. */
export type TurnAttempt =
  /** o servidor ACEITOU o turno (o item já saiu da fila e entrou na conversa). */
  | { kind: "sent" }
  /** o servidor RECUSOU por ocupação transitória — o item continua na fila, na mesma posição. */
  | { kind: "busy"; reason: BusyReason }
  /** falha real (ou incerta): o item continua na fila e ela PAUSA — o operador decide. */
  | { kind: "fatal" }
  /** cancelado/desmontado/superado — quem abortou já decidiu o que fazer com a fila. */
  | { kind: "aborted" };

/** O mundo de que o pump depende. Tudo injetado — é o que o deixa testável sem React, sem rede e sem timers. */
export interface OutboxPumpDeps {
  /** a cabeça da fila (já respeitando a pausa), ou null se não há o que despachar. */
  next(): OutboxItem | null;
  /** uma tentativa de despacho — quem fala com o servidor. */
  attempt(item: OutboxItem): Promise<TurnAttempt>;
  /** espera (interrompível) entre re-tentativas. */
  sleep(ms: number): Promise<void>;
  now(): number;
  /** o painel ainda está montado? (desmontar não deve deixar um laço vivo). */
  alive(): boolean;
  /** por que a cabeça ainda não saiu — null limpa o estado de espera. */
  onWaiting(reason: BusyReason | null): void;
  /** a espera total estourou o teto: pausa + avisa. */
  onExhausted(): void;
  /** falha real: pausa (o item fica na fila, intacto). */
  onFatal(): void;
}

/**
 * O PUMP: drena a fila EM ORDEM, um turno por vez.
 *
 * Toda a política de "quando reenviar" vive aqui, em código puro e testável — e é exatamente a política que o
 * incidente pedia: ocupado ⇒ espera e tenta de novo (mesmo item, mesma posição); aceito ⇒ segue para o próximo;
 * falha real ⇒ para e devolve a decisão ao operador (sem perder nada); cancelado ⇒ para sem inventar nada.
 *
 * Quem chama garante a SERIALIZAÇÃO (um pump por chat) — dois laços sobre a mesma fila mandariam fora de ordem.
 */
export async function runOutboxPump(deps: OutboxPumpDeps): Promise<void> {
  let attempt = 0;
  let waitStartedAt = 0;
  for (;;) {
    if (!deps.alive()) return;
    const item = deps.next();
    if (!item) {
      deps.onWaiting(null);
      return; // fila vazia OU pausada — nada sai atrás do operador
    }
    const result = await deps.attempt(item);
    if (!deps.alive()) return;
    if (result.kind === "busy") {
      const now = deps.now();
      if (!waitStartedAt) waitStartedAt = now;
      if (busyWaitExhausted(now - waitStartedAt)) {
        deps.onWaiting(null);
        deps.onExhausted();
        return;
      }
      deps.onWaiting(result.reason);
      await deps.sleep(busyBackoffMs(attempt++)); // backoff cresce dentro da MESMA espera
      continue; // MESMO item, mesma posição
    }
    // saiu do estado de espera: o relógio e o backoff zeram para o próximo item.
    attempt = 0;
    waitStartedAt = 0;
    deps.onWaiting(null);
    if (result.kind === "aborted") return;
    if (result.kind === "fatal") {
      deps.onFatal();
      return;
    }
  }
}

export const OUTBOX_PAUSED_NOTICE = "Fila pausada — nada foi perdido.";
export const OUTBOX_SENDING_NOTICE = "Enviando…";
export const OUTBOX_STUCK_NOTICE =
  "O board seguiu ocupado por 15 minutos — pausei a fila (sua mensagem está intacta). Retome quando quiser, ou cancele o ciclo em Processos.";
export const OUTBOX_FULL_NOTICE = `Fila cheia (${OUTBOX_CAP} mensagens) — espere alguma sair antes de mandar outra.`;
