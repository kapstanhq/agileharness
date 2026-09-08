// story-dznvez — TAXONOMIA DE MORTE (conservadora). Quando um run headless MORRE, hoje o card não recebe
// NENHUM diagnóstico da causa: o modo de morte (RunnerFailureReason) vive só no registry efêmero (TTL 15min,
// some no restart) + journal/telemetry, e NADA é escrito no card. Este módulo carimba um DIAGNÓSTICO DURÁVEL
// no `findings[]` do card — o "resumo da causa" que faltava — mais um HINT de classe (infra|test|app) para o
// operador rotear a reabertura. É a metade CONSERVADORA aprovada: carimba + hint, NÃO auto-move o card (a
// lição do deploy-revert.ts: auto-rotear por classe congelava cards; o operador decide a lane).
//
// Dois eixos:
//   • MODO da morte (RunnerFailureReason) — já rico: timeout | exit | error | oom-killed | no-op.
//   • CAUSA/classe (FailureClass infra|test|app) — reusa o classifyFailure(ADR-063 4d) dormente, com um
//     FAST-PATH por reason para os modos que o classificador de mensagem não pega (oom/error/no-op).
//
// SERVER-ONLY. As TRANSFORMS são puras (unit-testáveis); stamp/clearRunDeathFinding fazem IO e são
// best-effort (logam e NUNCA lançam — um callback de conclusão de run não pode quebrar por causa de um
// carimbo que não pôde gravar). O hook (registerRunDeathFindings) assina o engine SEM tocar o engine.ts.

import { updateCardOnDisk } from "@/lib/storymap/write";
import type { Card, FailureClass, Finding } from "@/lib/storymap/types";
import { classifyFailure, upsertFinding } from "./findings";
import { getRunnerRegistry } from "./registry";
import type { RunnerFailureReason } from "./types";

/** Um finding de morte por CARD (não por run): a morte mais recente REFRESCA o mesmo finding em vez de
 *  empilhar; recuperar (sucesso) o flipa para `fixed`. Mesma disciplina do loop-guard/budget. */
export const RUN_DEATH_FINDING_ID = "run-death";

/**
 * Deriva o HINT de classe (infra|test|app) da morte a partir do reason (+detail quando é `exit`). PURA.
 * Fast-path por reason (o classificador de MENSAGEM não pega esses modos, cujo detail é sintético do engine):
 *   - oom-killed / error → infra (recurso/spawn/ambiente — nunca o código do card)
 *   - no-op              → app   (sucesso-fantasma: a skill alegou pronto sem entregar/avançar)
 *   - exit               → classifyFailure(detail), mas confia SÓ num sinal POSITIVO de infra/test; um
 *                          "exit 1" seco não tem sinal → UNKNOWN (não inventa 'app' de um código de saída)
 *   - timeout            → UNKNOWN (processo pendurado é ambíguo; o operador investiga)
 */
export function classifyRunDeath(reason: RunnerFailureReason, detail?: string | null): FailureClass | undefined {
  if (reason === "oom-killed" || reason === "error") return "infra";
  if (reason === "no-op") return "app";
  if (reason === "exit") {
    const c = classifyFailure({ message: detail ?? "" });
    // Só um sinal POSITIVO de infra/test é confiável num detail de morte (o fallback 'app' do classifier
    // dispara para QUALQUER mensagem não-vazia — enganoso para um "exit N" seco). Senão: UNKNOWN.
    return c === "infra" || c === "test" ? c : undefined;
  }
  return undefined; // timeout (pendurado) — ambíguo
}

/** Texto de rota por classe — diz ao operador o que a classe significa e para onde reabrir. */
function classHint(failureClass: FailureClass | undefined): string {
  switch (failureClass) {
    case "infra":
      return " Causa provável: INFRA/ambiente (NÃO é o código do card) — não reabra como bug de código; " +
        "verifique env/stack/recursos e re-dispare o run.";
    case "test":
      return " Causa provável: TESTE/spec (o teste está errado, não o app) — ajuste o spec/seletor.";
    case "app":
      return " Causa provável: APP (o código do card / a skill não entregou) — reabra em desenvolver/corrigir.";
    default:
      return " Causa não classificada automaticamente — veja o log do run (runner_status / card_console) " +
        "para o motivo exato.";
  }
}

/**
 * Constrói o finding de DIAGNÓSTICO da morte. severity `high` — um ALERTA DE OPERADOR, NÃO `blocker` (não
 * pode gatear `hasNoBlockers` nem travar o card; é diagnóstico, não veto). Idempotente por
 * {@link RUN_DEATH_FINDING_ID}. Seta `failureClass` só quando classificado (fica esparso). PURA — testada.
 */
export function buildRunDeathFinding(
  reason: RunnerFailureReason,
  detail: string | null | undefined,
  failureClass: FailureClass | undefined,
  today: string,
): Finding {
  const cause = detail ? ` (${detail})` : "";
  return {
    id: RUN_DEATH_FINDING_ID,
    lens: "general",
    severity: "high",
    title: `run morreu: ${reason}`,
    detail:
      `O run headless morreu com '${reason}'${cause} em ${today}.` +
      classHint(failureClass) +
      ` Diagnóstico automático (story-dznvez) — não-bloqueante, o card NÃO foi movido.`,
    status: "open",
    ...(failureClass ? { failureClass } : {}),
  };
}

/**
 * Carimba o diagnóstico no card: UPSERT do finding, SEM mudar o status (conservador — nada de auto-rotear).
 * Vale para qualquer tipo de card (um run de card técnico também morre). PURA — exportada para testes.
 */
export function applyRunDeathFinding(card: Card, finding: Finding): Card {
  return { ...card, findings: upsertFinding(card.findings ?? [], finding) };
}

/**
 * RECUPERAÇÃO: quando um run posterior do card SUCEDE (ou o merge-back landa), o diagnóstico de morte fica
 * obsoleto — flipa o finding de morte open→fixed, deixando os outros findings intactos. PURA. Retorna o
 * card equivalente quando não há finding de morte aberto (o caller pula a escrita via null).
 */
export function applyRunDeathResolved(card: Card): Card {
  const findings = (card.findings ?? []).map((f) =>
    f.id === RUN_DEATH_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const } : f,
  );
  return { ...card, findings };
}

/**
 * IO: carimba o diagnóstico de morte no card. Best-effort — loga e NUNCA lança. Idempotente (upsert por id).
 */
export async function stampRunDeathFinding(
  board: string,
  cardId: string,
  reason: RunnerFailureReason,
  detail?: string | null,
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const failureClass = classifyRunDeath(reason, detail);
    const finding = buildRunDeathFinding(reason, detail, failureClass, today);
    await updateCardOnDisk(board, cardId, (card) => applyRunDeathFinding(card, finding));
    console.warn(
      `[run-death ${board}/${cardId}] morte '${reason}'${detail ? ` (${detail})` : ""} → diagnóstico ` +
        `carimbado (classe=${failureClass ?? "unknown"}, não-bloqueante, card não movido)`,
    );
  } catch (err) {
    console.error(`[run-death ${board}/${cardId}] carimbo falhou:`, err instanceof Error ? err.message : err);
  }
}

/** IO: limpa (fixed) o diagnóstico de morte quando o card recupera. Best-effort; pula a escrita se não há
 *  finding de morte aberto (evita write a cada conclusão de run). Nunca lança. */
export async function clearRunDeathFinding(board: string, cardId: string): Promise<void> {
  try {
    await updateCardOnDisk(board, cardId, (card) => {
      const hasOpen = (card.findings ?? []).some((f) => f.id === RUN_DEATH_FINDING_ID && f.status === "open");
      if (!hasOpen) return null; // nada a limpar → sem escrita
      return applyRunDeathResolved(card);
    });
  } catch (err) {
    console.error(`[run-death ${board}/${cardId}] limpeza falhou:`, err instanceof Error ? err.message : err);
  }
}

/** Fontes de evento mínimas (portas) — evitam acoplar run-death ao tipo concreto do engine/merge-queue. */
interface CompletionSource {
  onComplete(fn: (ev: { board: string; cardId: string }) => void): () => void;
}
interface MergeDoneSource {
  onMergeDone(fn: (ev: { board: string; cardId: string }) => void): () => void;
}

/**
 * Assina a conclusão de run para carimbar/limpar o diagnóstico de morte — chamado UMA vez pelo
 * trigger-runner-channel (ao lado de setupEventLog), sem tocar o engine.ts.
 *
 * Discriminador morte-real × sucesso-com-aviso: o engine SUPRIME o RunnerFailure quando o card avançou
 * (falha-fantasma, story-mzpzb0), então a PRESENÇA de um RunnerFailure fresco no registry (mesmo singleton
 * do engine) separa uma morte real (carimba) de um sucesso/sucesso-com-aviso (limpa). Um merge-back
 * (onMergeDone) = o trabalho integrou = recuperado → limpa também (cobre o sucesso ISOLADO, que sai por
 * onMergeDone e não por onComplete).
 */
export function registerRunDeathFindings(engine: CompletionSource, mergeQueue: MergeDoneSource): void {
  engine.onComplete((ev) => {
    const failure = getRunnerRegistry()
      .snapshot()
      .failures.find((f) => f.board === ev.board && f.cardId === ev.cardId);
    if (failure) void stampRunDeathFinding(ev.board, ev.cardId, failure.reason, failure.detail);
    else void clearRunDeathFinding(ev.board, ev.cardId);
  });
  mergeQueue.onMergeDone((ev) => void clearRunDeathFinding(ev.board, ev.cardId));
}
