// O VIGIA DE CARD PARADO — fatia 1 das «paradas por recurso».
//
// O que ele pega: um card num passo em que o PRÓXIMO ATOR É O SISTEMA, sem ninguém trabalhando nele e sem nada que
// explique a espera. Um caso real que o motivou: a revisão de segurança
// aprovou, o finding de prova fechou, a republicação não aconteceu — e o card ficou em «Publicar» com o código na
// main, sem `deployFiredAt`, sem finding aberto, sem prova pendente e sem run. Nenhum vigia existente olha esse
// estado: o `deploy-unsettled` precisa do carimbo, o `effect-failed` precisa do finding, o reconcile só anda com prova.
//
// A regra do operador: «Tenta de novo e avisa se falhar» — 15 minutos parado, o sistema refaz o passo UMA vez; se parar
// de novo, abre um card de conserto e o item aparece no Inbox.
//
// As travas (cada uma é um jeito de um vigia ingênuo fazer estrago):
//   • SÓ O QUE É DO SISTEMA: passo com efeito de entrada (publicar/liberar/promover), passo de PASSAGEM (autorun
//     sem skill e sem efeito — «Integrar», «Stage»: a cascata só o atravessa num evento de entrada, e um evento
//     perdido ou uma trava que caiu depois deixavam o card ali para sempre) ou card conduzido. Um
//     passo que espera o humano ou uma skill de coluna não é «parado» — é fila, e tem os seus próprios sinais.
//   • EXPLICADO NÃO É PARADO: publicação em voo (`deployFiredAt`), deploy rodando, pedido de publicação aberto ou
//     segurado, prova pendente, finding de publicação aberto, o disjuntor de publicação segurando o card, run/merge/
//     reserva viva, pergunta aberta, e a decisão que é só do dono NO PASSO em que ele aprova a entrega. Cada um
//     desses já tem dono e sinal no Inbox.
//   • O RELÓGIO É DO VIGIA: «há 15 minutos» conta do momento em que ELE viu o card sem dono, num ledger durável —
//     não do ledger de transições (que cai para `card.created`, granular por dia, e faria o primeiro sweep depois de
//     um deploy refazer dezenas de passos de uma vez) nem de um Map em memória (um restart viraria «uma vez por boot»).
//   • UMA VEZ É UMA VEZ: a tentativa fica no ledger enquanto o card estiver naquele passo, mesmo que ele passe um
//     tempo «explicado» no meio. Parou de novo ⇒ escala, não tenta outra vez.
//   • REFAZER SÓ ONDE O BOARD PUBLICA SOZINHO (`release.mode: auto`): num board de publicação manual o passo de
//     publicar é uma parada humana por desenho — lá o vigia só avisa.
//   • CONDUTOR: o vigia só AVISA (morto sem fila, ou quieto no prompt sem pausa declarada). Reabrir um condutor por
//     cima de trabalho não integrado não é dele. WP5-F2: o condutor quieto que a ESCADA do estacionar está tratando
//     (erro de transporte, ou fila esperando vaga — conductor-pause.ts) não é aviso enquanto a escada tem prazo; só o
//     que passou dela é. E o card parado num status de condutor SEM ator nenhum (sem driver, sem fila — a admissão só
//     acontece na entrada) passa a ser coberto: o vigia refaz a entrada uma vez e, parando de novo, escala.
// Núcleo DI, irmão do produtor da prova (deploy-proof-producer.ts); as deps de produção moram em stall-watch-deps.ts.

import { CARD_STALLED_FINDING_ID, DEPLOY_FAILURE_FINDING_ID, DEPLOY_UNPROVEN_FINDING_ID, ENTRY_EFFECT_FAILED_FINDING_ID } from "@/lib/storymap/demands";
import { isDeliveryApprovalStep } from "@/lib/storymap/delivery-audit";
import { isConducted } from "@/lib/storymap/driver";
import { isConductorOrphan } from "./conductor";
import { ownerDecisionsOnCard } from "@/lib/storymap/owner-waiting";
import { openQuestions } from "@/lib/storymap/questions";
import { publishesItself, releaseModeOf } from "@/lib/storymap/release-policy";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { BoardConfig, Card, EntryEffect, Finding } from "@/lib/storymap/types";
import { newSystemDecisionId } from "./decision-log";

/** `autorun.stall` do settings: quanto tempo sem dono vira «parado» e quantas vezes o sistema refaz o passo. */
export interface StallSettings {
  afterMinutes: number;
  retries: number;
}

export const DEFAULT_STALL_SETTINGS: StallSettings = { afterMinutes: 15, retries: 1 };
const LEDGER_MAX_ROWS = 500;

/** O que o vigia sabe do mundo em volta de UM card — tudo o que faria a espera ser legítima. */
export interface StallFacts {
  /** run do engine, entrada viva no merge train ou reserva (claim) viva no card. */
  inFlight: boolean;
  /** um deploy de algum alvo do card está rodando (ou um self-deploy está pendente). */
  deployRunning: boolean;
  /** o board tem pedido de publicação aberto (esperando, segurado por embargo ou publicando). */
  publishOpen: boolean;
  /** o produtor da prova tem um pedido pendente para este card. */
  proofPending: boolean;
  /** o disjuntor de publicação guarda uma tentativa deste card (ele decide quando tentar de novo). */
  breakerHeld: boolean;
  /**
   * Só para passo de passagem: a cascata SEGURA este card por uma decisão que é do dono (ela tem o seu próprio item
   * no Inbox) — é espera declarada, não travamento. Ausente ⇒ não segura.
   */
  ownerHeld?: boolean;
  /**
   * Só para card conduzido. `null` = não deu para saber (a sonda do tmux falhou) ⇒ ninguém é julgado.
   * `quietForMs` é há quanto tempo a sessão viva está no prompt sem mexer (`null` = trabalhando ou não observada).
   */
  conductor: null | {
    live: boolean;
    queued: boolean;
    quietForMs: number | null;
    asking: boolean;
    declaredWaiting: boolean;
    /**
     * WP5-F2 — quanto a mais de quietude a ESCADA do estacionar ainda tem para agir neste condutor (lembrete/retomada e
     * o pedido de estacionar): enquanto ela tem prazo, a quietude é tratada, não travamento. Ausente/0 ⇒ nenhuma escada.
     */
    ladderGraceMs?: number;
  };
}

export type StallSubject =
  | { kind: "entry-effect"; effect: EntryEffect; stepId: string; stepName: string }
  /** passo que a cascata só atravessa (autorun, sem skill, sem efeito): refazer = reavaliar a cascata. */
  | { kind: "passage"; stepId: string; stepName: string }
  | { kind: "conductor-dead"; stepId: string; stepName: string }
  | { kind: "conductor-quiet"; stepId: string; stepName: string }
  /** WP5-F2 — status em que o condutor assume o card, sem driver e sem fila: ninguém vai pegá-lo. Refazer = a entrada. */
  | { kind: "conductor-unassigned"; stepId: string; stepName: string };

export interface StallClassification {
  subject: StallSubject;
  /** o sistema pode refazer o passo sozinho (só efeito de entrada, só em board que publica sozinho). */
  autoRetry: boolean;
}

const openFinding = (card: Pick<Card, "findings">, id: string): Finding | undefined => card.findings?.find((f) => f.id === id && f.status === "open");

/** O finding de «parado» ABERTO do card, se houver. PURA. */
export function openStalled(card: Pick<Card, "findings">): Finding | null {
  return openFinding(card, CARD_STALLED_FINDING_ID) ?? null;
}

/**
 * Este card está, AGORA, num passo do sistema sem dono e sem explicação? `null` = não (ou não dá para saber).
 * PURA — é a régua inteira do vigia; o tempo (há quanto isso dura) é do ledger, em {@link sweepStalledCards}.
 */
export function classifyStall(card: Card, config: BoardConfig, facts: StallFacts, quietMs: number): StallClassification | null {
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def || def.terminal) return null;
  const step = { stepId: def.id, stepName: def.name };
  // Alguém já está nele, ou ele espera uma resposta: uma pergunta aberta (o proxy ou o dono respondem) «espera para
  // sempre» por regra de produto — não é travamento.
  if (facts.inFlight) return null;
  if (openQuestions(card).length) return null;
  // A decisão que é só do dono (o card toca dados de pessoas, dinheiro…) só explica a espera ONDE ela é esperada: no
  // passo em que ele aprova a entrega. Um card dessa classe em qualquer outro passo NÃO está esperando o dono — e
  // tratá-lo como se estivesse escondeu por horas um condutor que morreu num erro de API (num caso real, um card
  // dessa classe parado em «Desenvolver»).
  if (isDeliveryApprovalStep(def) && ownerDecisionsOnCard(card, config).length) return null;

  if (isConducted(card)) {
    const c = facts.conductor;
    if (!c) return null; // a sonda falhou: sem fato, sem veredito
    if (!c.live) return c.queued ? null : { subject: { kind: "conductor-dead", ...step }, autoRetry: false };
    // vivo: uma pausa DECLARADA e um prompt desenhado (menu, s/N) já têm o seu sinal
    if (c.declaredWaiting || c.asking) return null;
    if (c.quietForMs != null && c.quietForMs >= quietMs + Math.max(0, c.ladderGraceMs ?? 0)) return { subject: { kind: "conductor-quiet", ...step }, autoRetry: false };
    return null;
  }

  // Status de condutor SEM ator (WP5-F2): a admissão só acontece na entrada; perdida a entrada, ninguém o pega — nem o
  // condutor, nem a skill da coluna (a entrada daquele status é do condutor). O pump admite órfãos a cada varredura;
  // aqui é a rede: refazer = reavaliar a entrada (que admite), e parar de novo vira conserto.
  if (isConductorOrphan(card, config)) return { subject: { kind: "conductor-unassigned", ...step }, autoRetry: true };

  if (!def.onEnter) {
    // Passo de PASSAGEM: a cascata o atravessa sozinha na entrada. Parado ali, ou um evento se perdeu, ou o que o
    // segurava (um gate, a espera do dono) caiu depois — reavaliar é a MESMA decisão da entrada, com todas as travas.
    // A espera pelo dono e o disjuntor da publicação já têm o seu sinal: aí a cascata parou de propósito.
    if (isPassageStep(def)) return facts.ownerHeld || facts.breakerHeld ? null : { subject: { kind: "passage", ...step }, autoRetry: true };
    return null; // passo de humano ou de skill de coluna: fila, não travamento
  }
  if (card.deployFiredAt) return null; // publicação em voo — o `deploy-unsettled` cuida do prazo dela
  if (openFinding(card, DEPLOY_FAILURE_FINDING_ID) || openFinding(card, DEPLOY_UNPROVEN_FINDING_ID) || openFinding(card, ENTRY_EFFECT_FAILED_FINDING_ID)) return null;
  if (facts.deployRunning || facts.publishOpen || facts.proofPending || facts.breakerHeld) return null;
  return { subject: { kind: "entry-effect", effect: def.onEnter, ...step }, autoRetry: publishesItself(releaseModeOf(config)) };
}

/** Uma linha do ledger: o que o vigia já viu e já fez por um card NAQUELE passo. */
export interface StallRow {
  /** `<board>/<cardId>@<status>` */
  key: string;
  board: string;
  cardId: string;
  status: string;
  /** desde quando o card está sem dono, sem interrupção; `null` = no momento ele tem dono (as tentativas ficam). */
  firstSeenAt: number | null;
  /** quantas vezes o sistema já refez o passo. */
  attempts: number;
  retriedAt?: number;
  /** já virou item no Inbox (e card de conserto, quando cabe). */
  escalatedAt?: number;
  fixCardId?: string;
}

export interface StallBoard {
  id: string;
  config: BoardConfig;
  cards: Card[];
  /**
   * Os cards que o ESCOPO DE TIPOS do board (board-pace.ts) segura de propósito: tipo que o board não pode começar,
   * esperando um condutor que a adoção nega enquanto o escopo valer. Estão parados DE PROPÓSITO (como o adiado e o board
   * pausado): o vigia não os conta, não refaz o passo e não abre card de conserto. Ausente ⇒ nenhum.
   */
  scopeHeld?: ReadonlySet<string>;
}

export interface StallWatchDeps {
  ledger: { load(): Promise<StallRow[]>; persist(rows: StallRow[]): Promise<void> };
  masterEnabled(): boolean;
  settings(): StallSettings;
  /** janela da conta e máquina: um motivo de recusa, ou null. Só segura a TENTATIVA, nunca o aviso. */
  admission(): string | null;
  /** os boards em que a automação age (autorun ligado), com config e cards frescos do disco. */
  boards(): Promise<StallBoard[]>;
  /** os fatos de um card — só chamada para card não terminal em passo do sistema (o resto nem é candidato). */
  facts(board: StallBoard, card: Card): Promise<StallFacts>;
  /** refaz o efeito de entrada do passo, como o próprio serviço (o mesmo caminho do «Re-publicar»). */
  retry(board: string, cardId: string, effect: EntryEffect): Promise<{ ok: boolean; error?: string }>;
  /** reavalia a cascata para o card (a mesma decisão do evento de entrada) — o «refazer» de um passo de passagem. */
  reevaluate(board: string, cardId: string): Promise<{ ok: boolean; error?: string }>;
  /** abre um card de conserto técnico ligado ao card — o id, ou null. */
  openFixCard(board: string, card: Card, reason: string): Promise<string | null>;
  /** grava (upsert) o finding de «parado» no card. */
  stamp(board: string, cardId: string, finding: Finding): Promise<void>;
  /** fecha o finding de «parado»: o card voltou a ter dono. */
  clear(board: string, cardId: string): Promise<void>;
  record(entry: SystemDecision): Promise<void>;
  /** a hora de um instante, como o dono a lê (ex.: «07h53»). */
  clock(ms: number): string;
  now?(): number;
  log?(line: string): void;
}

export type StallAction = "watching" | "retried" | "escalated" | "restamped" | "cleared" | "held";
export interface StallReport {
  board: string;
  cardId: string;
  action: StallAction;
  detail?: string;
}

const keyOf = (board: string, cardId: string, status: string) => `${board}/${cardId}@${status}`;
const upsert = (rows: StallRow[], row: StallRow) => [...rows.filter((r) => r.key !== row.key), row].slice(-LEDGER_MAX_ROWS);

/** Um passo que a cascata só ATRAVESSA: autorun ligado, sem skill de coluna e sem efeito de entrada. PURA. */
export function isPassageStep(def: Pick<BoardConfig["statuses"][number], "autorun" | "trigger" | "onEnter" | "terminal">): boolean {
  return def.autorun === true && !def.trigger && !def.onEnter && !def.terminal;
}

/** Só card não terminal em passo do sistema entra na conta — o resto nem custa uma leitura de fatos. PURA. */
export function isStallCandidate(card: Card, config: BoardConfig): boolean {
  const def = config.statuses.find((s) => s.id === card.status);
  if (!def || def.terminal) return false;
  return isConducted(card) || !!def.onEnter || isPassageStep(def) || isConductorOrphan(card, config);
}

/** O texto do finding, já em linguagem de dono (o Inbox o mostra como está). PURO. */
export function stalledFinding(subject: StallSubject, o: { since: string; retried: boolean; autoRetry: boolean; fixCardId: string | null }): Finding {
  const fix = o.fixCardId ? ` O conserto virou o card ${o.fixCardId}.` : "";
  let title: string;
  let detail: string;
  if (subject.kind === "conductor-unassigned") {
    title = `Parado em «${subject.stepName}» sem condutor e sem fila`;
    const tried = o.retried ? "O sistema chamou o condutor de novo uma vez e o card seguiu sem ninguém." : "O sistema não conseguiu chamar o condutor.";
    detail = `O card está em «${subject.stepName}», um passo em que um condutor assume o card, mas desde ${o.since} nenhum condutor foi chamado para ele e ele não está na fila. ${tried}${fix}`;
  } else if (subject.kind === "entry-effect" || subject.kind === "passage") {
    title = `Parado em «${subject.stepName}» sem ninguém cuidando`;
    const tried = o.retried
      ? "O sistema refez o passo uma vez e ele parou de novo."
      : o.autoRetry
        ? "O sistema não conseguiu refazer o passo."
        : "O sistema não refez o passo sozinho, porque este board só publica com você.";
    const nothing = subject.kind === "passage" ? "ninguém trabalhando nele e nenhuma pergunta aberta" : "nenhuma publicação em andamento, nenhuma prova pendente e nenhum aviso aberto";
    detail = `O card está em «${subject.stepName}» sem nada acontecendo desde ${o.since}: ${nothing}. ${tried}${fix}`;
  } else if (subject.kind === "conductor-dead") {
    title = "O condutor deste card encerrou e ninguém assumiu";
    detail = `O card segue marcado como conduzido em «${subject.stepName}», mas desde ${o.since} não há sessão viva nem lugar na fila para ele. O trabalho que a sessão fez continua guardado. Para retomar, abra um condutor novo para o card ou devolva o card ao fluxo das colunas.`;
  } else {
    title = "O condutor está parado sem pedir nada";
    detail = `A sessão que conduz este card está quieta desde ${o.since}, sem pergunta aberta e sem pausa declarada. Abra o terminal dela para ver onde parou; se ela espera uma decisão, responda lá.`;
  }
  return { id: CARD_STALLED_FINDING_ID, lens: "general", severity: "high", status: "open", title, detail };
}

/**
 * UMA varredura: para cada card em passo do sistema, sem dono e sem explicação há `afterMinutes`, refaz o passo uma
 * vez (quando é seguro) e, parando de novo, abre o conserto e grava o aviso. Nunca lança.
 */
export async function sweepStalledCards(deps: StallWatchDeps): Promise<StallReport[]> {
  const log = deps.log ?? ((l: string) => console.log(`[stall-watch] ${l}`));
  const now = (deps.now ?? Date.now)();
  const out: StallReport[] = [];
  try {
    if (!deps.masterEnabled()) return out;
    const settings = deps.settings();
    const afterMs = Math.max(1, settings.afterMinutes) * 60_000;
    let rows = await deps.ledger.load();
    const before = JSON.stringify(rows);
    /** todo card AINDA no passo da sua linha (parado ou não) — as outras linhas são história e saem. */
    const inStep = new Set<string>();
    const boardsSeen = new Set<string>();

    const decision = (board: string, cardId: string, kind: SystemDecision["kind"], what: string, why: string): SystemDecision => ({
      v: 1,
      id: newSystemDecisionId(),
      at: new Date(now).toISOString(),
      board,
      cardId,
      agent: "system",
      kind,
      what,
      why,
    });

    for (const board of await deps.boards()) {
      boardsSeen.add(board.id);
      for (const card of board.cards) {
        const key = keyOf(board.id, card.id, card.status ?? "");
        const row = rows.find((r) => r.key === key);
        if (!isStallCandidate(card, board.config)) continue;
        inStep.add(key);
        // Parado DE PROPÓSITO pelo escopo de tipos: tem explicação (como um card com pergunta aberta). O aviso que já
        // estivesse aberto sai e o relógio zera — se o escopo alargar, a contagem recomeça do zero em vez de escalar de uma vez.
        const verdict = board.scopeHeld?.has(card.id) ? null : classifyStall(card, board.config, await deps.facts(board, card), afterMs);

        if (!verdict) {
          // O card tem dono de novo (ou uma explicação). O aviso sai; as tentativas FICAM enquanto ele estiver no passo.
          if (openStalled(card)) {
            await deps.clear(board.id, card.id);
            out.push({ board: board.id, cardId: card.id, action: "cleared" });
          }
          if (row && row.firstSeenAt != null) rows = upsert(rows, { ...row, firstSeenAt: null });
          continue;
        }

        if (!row || row.firstSeenAt == null) {
          rows = upsert(rows, { key, board: board.id, cardId: card.id, status: card.status ?? "", attempts: row?.attempts ?? 0, ...(row ?? {}), firstSeenAt: now });
          out.push({ board: board.id, cardId: card.id, action: "watching" });
          continue;
        }
        if (now - row.firstSeenAt < afterMs) continue;

        const since = deps.clock(row.firstSeenAt);
        const { subject } = verdict;

        if (row.escalatedAt) {
          // Já está no Inbox. Se o aviso saiu no meio (alguém tentou de novo) e o card parou outra vez, o aviso volta —
          // sem outro card de conserto.
          if (!openStalled(card)) {
            await deps.stamp(board.id, card.id, stalledFinding(subject, { since, retried: row.attempts > 0, autoRetry: verdict.autoRetry, fixCardId: row.fixCardId ?? null }));
            out.push({ board: board.id, cardId: card.id, action: "restamped" });
          }
          continue;
        }

        if ((subject.kind === "entry-effect" || subject.kind === "passage" || subject.kind === "conductor-unassigned") && verdict.autoRetry && row.attempts < settings.retries) {
          const refused = deps.admission();
          if (refused) {
            out.push({ board: board.id, cardId: card.id, action: "held", detail: refused });
            continue; // máquina ou cota apertadas: a tentativa espera; o relógio não zera
          }
          // A tentativa é contada ANTES de agir: uma que lança não vira laço. O relógio recomeça — parar de novo por
          // mais `afterMinutes` é o que escala.
          rows = upsert(rows, { ...row, attempts: row.attempts + 1, retriedAt: now, firstSeenAt: now });
          await deps.ledger.persist(rows);
          const r = await (subject.kind === "entry-effect" ? deps.retry(board.id, card.id, subject.effect) : deps.reevaluate(board.id, card.id)).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
          await deps
            .record(
              decision(
                board.id,
                card.id,
                "stall-retry",
                subject.kind === "conductor-unassigned" ? `Chamou o condutor para «${card.title}», parado em «${subject.stepName}»` : `Refez o passo «${subject.stepName}» de «${card.title}»`,
                `${subject.kind === "conductor-unassigned" ? `o card estava nesse passo desde ${since} sem condutor e fora da fila` : `o card estava nesse passo desde ${since} sem publicação em andamento, prova pendente nem aviso aberto`}${r.ok ? "" : ` (a nova tentativa recusou: ${r.error ?? "?"})`}`,
              ),
            )
            .catch(() => {});
          log(`${board.id}/${card.id}: parado em ${subject.stepId} desde ${since} — passo refeito (${row.attempts + 1}/${settings.retries})${r.ok ? "" : `; recusou: ${r.error ?? "?"}`}`);
          out.push({ board: board.id, cardId: card.id, action: "retried", ...(r.ok ? {} : { detail: r.error }) });
          continue;
        }

        // Escala: marca ANTES de agir (um restart no meio não abre dois cards de conserto).
        rows = upsert(rows, { ...row, escalatedAt: now });
        await deps.ledger.persist(rows);
        let fixCardId: string | null = null;
        if (subject.kind === "entry-effect" || subject.kind === "passage" || subject.kind === "conductor-unassigned") {
          const reason = `ficou em «${subject.stepName}» sem nada acontecendo desde ${since}${row.attempts > 0 ? "; o sistema refez o passo uma vez e ele parou de novo" : ""}`;
          fixCardId = await deps.openFixCard(board.id, card, reason).catch(() => null);
          if (fixCardId) rows = upsert(rows, { ...row, escalatedAt: now, fixCardId });
        }
        await deps.stamp(board.id, card.id, stalledFinding(subject, { since, retried: row.attempts > 0, autoRetry: verdict.autoRetry, fixCardId }));
        if (fixCardId) {
          await deps
            .record({
              ...decision(board.id, fixCardId, "stall-fix-card", `Abriu um card de conserto para «${card.title}», parado em «${subject.stepName}» (${fixCardId})`, `o card ${card.id} ficou sem ninguém cuidando desde ${since}, mesmo depois de o passo ser refeito`),
              undo: { kind: "discard-card", cardId: fixCardId },
            })
            .catch(() => {});
        }
        log(`${board.id}/${card.id}: ${subject.kind} em ${subject.stepId} desde ${since} — aviso no Inbox${fixCardId ? ` + conserto ${fixCardId}` : ""}`);
        out.push({ board: board.id, cardId: card.id, action: "escalated", ...(fixCardId ? { detail: fixCardId } : {}) });
      }
    }

    // O card saiu do passo (ou sumiu): a linha é história. Linhas de um board que não foi lido agora ficam.
    rows = rows.filter((r) => !boardsSeen.has(r.board) || inStep.has(r.key));
    if (JSON.stringify(rows) !== before) await deps.ledger.persist(rows);
  } catch (err) {
    log(`a varredura falhou — ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
