// story-ex0068 — TAXONOMIA DE MORTE (conservadora). Quando um run headless MORRE, hoje o card não recebe
// NENHUM diagnóstico da causa: o modo de morte (RunnerFailureReason) vive só no registry efêmero (TTL 15min,
// some no restart) + journal/telemetry, e NADA é escrito no card. Este módulo carimba um DIAGNÓSTICO DURÁVEL
// no `findings[]` do card — o "resumo da causa" que faltava — mais um HINT de classe (infra|test|app) para o
// operador rotear a reabertura. É a metade CONSERVADORA aprovada: carimba + hint, NÃO auto-move o card (a
// lição do deploy-revert.ts: auto-rotear por classe congelava cards; o operador decide a lane).
//
// Dois eixos:
//   • MODO da morte (RunnerFailureReason) — já rico: timeout | exit | error | oom-killed | no-op.
//   • CAUSA/classe (FailureClass infra|test|app) — reusa o classifyFailure (4d) dormente, com um
//     FAST-PATH por reason para os modos que o classificador de mensagem não pega (oom/error/no-op).
//
// SERVER-ONLY. As TRANSFORMS são puras (unit-testáveis); stamp/clearRunDeathFinding fazem IO e são
// best-effort (logam e NUNCA lançam — um callback de conclusão de run não pode quebrar por causa de um
// carimbo que não pôde gravar). O hook (registerRunDeathFindings) assina o engine SEM tocar o engine.ts.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { STEP_LABEL_BY_TRIGGER } from "@/lib/storymap/step-rollup";
import type { Card, FailureClass, Finding, TriggerId } from "@/lib/storymap/types";
import { shellDeniedWarning } from "./autonomy-sandbox";
import { classifyFailure, upsertFinding, withBudgetCutResolved, type FailureRules } from "./findings";
import { loadRunnerConfig } from "./config";
import { resolveServiceProbePort } from "./host-tools";
import { qaOf } from "@/lib/storymap/target-profile";
import { nextRunDeathRepeats, noOpVariant, runDeathTitle, toolSignature, type FailureOriginVerdict } from "./failure-origin";
import { getRunnerRegistry } from "./registry";
import { capTier, tierOf } from "./skill-registry";
import type { RunnerFailureReason } from "./types";

/** Um finding de morte por CARD (não por run): a morte mais recente REFRESCA o mesmo finding em vez de
 *  empilhar; recuperar (sucesso) o flipa para `fixed`. Mesma disciplina do loop-guard/budget. */
export const RUN_DEATH_FINDING_ID = "run-death";

/**
 * Deriva o HINT de classe (infra|test|app) da morte a partir do reason (+detail quando é `exit`). PURA.
 * PRIMEIRO, a assinatura da FERRAMENTA no texto final do agente ou no detalhe (failure-origin.ts): o sandbox que recusa
 * todo Bash (apply-seccomp/setgroups), o binário do agente ausente, a postura recusada ⇒ infra, em QUALQUER modo de
 * morte. Num caso real, 3 `no-op` seguidos de um mesmo card diziam no texto final «toda chamada de Bash falha
 * na sandbox, com apply-seccomp: write /proc/self/setgroups ... Permission denied» e o carimbo dizia «APP».
 * O aviso da postura REBAIXADA do spawn (`postureWarn`: o passo `full` rodou sem shell) conta como essa assinatura.
 * Depois, o fast-path por reason (o classificador de MENSAGEM não pega esses modos, cujo detail é sintético do engine):
 *   - error do TETO de max-turns → UNKNOWN: o engine o assenta como `error` («card travado, escalando p/ o operador»),
 *                          mas é o card que não coube nas voltas, não o ambiente (achado numa revisão)
 *   - oom-killed / error → infra (recurso/spawn/ambiente — nunca o código do card; a origem é `environment`, que segue
 *                          o modo do board — só uma assinatura da ferramenta passa por cima dele, failure-origin.ts)
 *   - no-op              → app   (sucesso-fantasma: a skill alegou pronto sem entregar/avançar)
 *   - exit               → classifyFailure(detail), mas confia SÓ num sinal POSITIVO de infra/test; um
 *                          "exit 1" seco não tem sinal → UNKNOWN (não inventa 'app' de um código de saída)
 *   - timeout            → UNKNOWN (processo pendurado é ambíguo; o operador investiga)
 */
export function classifyRunDeath(
  reason: RunnerFailureReason,
  detail?: string | null,
  finalText?: string | null,
  postureWarn?: string | null,
  /** o que o alvo declarou do ambiente de teste dele (`target.qa`); ausente = só o baseline universal. */
  rules?: FailureRules,
): FailureClass | undefined {
  if (toolSignature(finalText) || toolSignature(detail) || toolSignature(postureWarn)) return "infra";
  if (reason === "error" && MAX_TURNS_CAP.test(detail ?? "")) return undefined;
  if (reason === "oom-killed" || reason === "error") return "infra";
  if (reason === "no-op") return "app";
  if (reason === "exit") {
    const c = classifyFailure({ message: detail ?? "" }, rules);
    // Só um sinal POSITIVO de infra/test é confiável num detail de morte (o fallback 'app' do classifier
    // dispara para QUALQUER mensagem não-vazia — enganoso para um "exit N" seco). Senão: UNKNOWN.
    return c === "infra" || c === "test" ? c : undefined;
  }
  return undefined; // timeout (pendurado) — ambíguo
}

/** O detalhe que o engine escreve quando o card esgota o teto de retomadas por max-turns (engine.ts, settle `error`). */
const MAX_TURNS_CAP = /max-turns atingido \d+× \(teto \d+\)/;

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
  /** a assinatura da FERRAMENTA achada no texto (failure-origin.ts), o passo que rodou (o nome no board) e quantas
   *  vezes seguidas a mesma morte veio — no mesmo passo, com o mesmo tipo de no-op. */
  opts: { tool?: FailureOriginVerdict | null; step?: string | null; repeats?: number } = {},
): Finding {
  const cause = detail ? ` (${detail})` : "";
  const tool = opts.tool?.origin === "tool" ? opts.tool : null;
  const repeats = opts.repeats ?? 1;
  return {
    id: RUN_DEATH_FINDING_ID,
    lens: "general",
    severity: "high",
    title: runDeathTitle(reason, { step: opts.step, variant: noOpVariant(reason, detail), toolSignature: tool?.signature, repeats }),
    detail:
      `O run headless morreu com '${reason}'${cause} em ${today}.` +
      (tool
        ? ` Origem: a FERRAMENTA — ${tool.label}: «${tool.excerpt}». Não é o código do card nem uma decisão do dono: ` +
          `rodar de novo dá o mesmo desfecho enquanto o ambiente não for consertado.`
        : classHint(failureClass)) +
      (repeats >= 2 ? ` É a ${repeats}ª vez seguida que o run morre assim.` : "") +
      ` Diagnóstico automático (story-ex0068) — não-bloqueante, o card NÃO foi movido.`,
    status: "open",
    ...(failureClass ? { failureClass } : {}),
  };
}

/**
 * O PRÓXIMO diagnóstico de morte para este card — a classe, a origem e a repetição, sobre o card FRESCO (sob a trava).
 * PURA. A repetição soma quando o diagnóstico aberto é a MESMA morte (motivo, passo, tipo de no-op e origem — o
 * título-base, failure-origin.ts); qualquer outra recomeça em 1.
 */
export function nextRunDeathFinding(
  card: Pick<Card, "findings">,
  input: {
    reason: RunnerFailureReason;
    detail?: string | null;
    finalText?: string | null;
    today: string;
    /** o passo que rodou, como o board o mostra (o trigger traduzido). */
    step?: string | null;
    /** o aviso da postura REBAIXADA do spawn (autonomy-sandbox.ts shellDeniedWarning): o passo rodou sem shell. */
    postureWarn?: string | null;
    /** as regras de ambiente do alvo (`target.qa`), já resolvidas por quem tem IO ({@link declaredFailureRules}). */
    rules?: FailureRules;
  },
): Finding {
  const tool = toolSignature(input.finalText) ?? toolSignature(input.detail) ?? toolSignature(input.postureWarn);
  const failureClass = classifyRunDeath(input.reason, input.detail, input.finalText, input.postureWarn, input.rules);
  const open = (card.findings ?? []).find((f) => f.id === RUN_DEATH_FINDING_ID && f.status === "open");
  const base = runDeathTitle(input.reason, { step: input.step, variant: noOpVariant(input.reason, input.detail), toolSignature: tool?.signature });
  const repeats = nextRunDeathRepeats(open?.title, base);
  return buildRunDeathFinding(input.reason, input.detail, failureClass, input.today, { tool, step: input.step, repeats });
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

/** Um desfecho de run no log de eventos (event-log.ts) — o mínimo que a releitura precisa. */
export interface SettledRunEvent {
  board?: string;
  cardId?: string;
  outcome?: string;
  result?: { finalText?: string };
}

/** Os desfechos de MORTE que o carimbo diagnostica (o corte por orçamento tem o finding dele, budget-cut). */
const DEATH_OUTCOMES: ReadonlySet<string> = new Set<RunnerFailureReason>(["error", "timeout", "oom-killed", "exit", "no-op"]);

/**
 * A RELEITURA de um diagnóstico carimbado ANTES de o carimbo ler o texto final do agente — antes dessa leitura toda morte por
 * sandbox saía «Causa provável: APP», e o card só seria re-carimbado num run novo (que o dono teria de disparar: o
 * no-op não roda de novo sozinho com o card igual). Pelos desfechos do card no log de eventos, em ordem: se o último é
 * a MESMA morte do diagnóstico aberto e o texto final dele carrega uma assinatura da ferramenta, re-carimba com a
 * origem e a contagem das mortes iguais seguidas (no caso real, 3). null = nada a mudar. PURA.
 */
export function restampRunDeathFromEvents(card: Card, settled: readonly SettledRunEvent[], today: string): Card | null {
  const open = (card.findings ?? []).find((f) => f.id === RUN_DEATH_FINDING_ID && f.status === "open");
  const last = settled.at(-1);
  if (!open || !last?.outcome || !DEATH_OUTCOMES.has(last.outcome)) return null;
  const tool = toolSignature(last.result?.finalText);
  if (!tool) return null;
  const reason = last.outcome as RunnerFailureReason;
  // só o diagnóstico ANTIGO desta mesma morte (sem a origem) é relido; o já carimbado com a origem fica como está
  if (nextRunDeathRepeats(open.title, runDeathTitle(reason)) < 2) return null;
  let repeats = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    const e = settled[i];
    if (e.outcome !== last.outcome || toolSignature(e.result?.finalText)?.signature !== tool.signature) break;
    repeats++;
  }
  return applyRunDeathFinding(card, buildRunDeathFinding(reason, null, "infra", today, { tool, repeats }));
}

/**
 * IO, uma vez no boot: relê, pelo log de eventos, os diagnósticos de morte abertos cuja causa era a FERRAMENTA (ver
 * {@link restampRunDeathFromEvents}). Só toca o card cujo último desfecho tem assinatura da ferramenta — no caso real,
 * um punhado. Best-effort: um log ausente ou ilegível não é erro; nunca lança.
 */
export async function backfillRunDeathOrigins(): Promise<void> {
  try {
    const raw = await readFile(path.join(runnerStateDir(), "events.jsonl"), "utf8").catch(() => "");
    const byCard = new Map<string, SettledRunEvent[]>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: (SettledRunEvent & { type?: string }) | null = null;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.type !== "settled" || !ev.board || !ev.cardId) continue;
      const key = `${ev.board}\u0000${ev.cardId}`;
      byCard.set(key, [...(byCard.get(key) ?? []), ev]);
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, evs] of byCard) {
      if (!toolSignature(evs.at(-1)?.result?.finalText)) continue;
      const [board, cardId] = key.split("\u0000");
      let changed = false;
      await updateCardOnDisk(board, cardId, (card) => {
        const next = restampRunDeathFromEvents(card, evs, today);
        changed = next !== null;
        return next;
      }).catch(() => null);
      if (changed) console.warn(`[run-death ${board}/${cardId}] diagnóstico relido pelo log de eventos: a origem é a ferramenta`);
    }
  } catch (err) {
    console.error("[run-death] releitura dos diagnósticos falhou:", err instanceof Error ? err.message : err);
  }
}

/**
 * IO: o spawn deste passo rodou SEM shell (a postura `full` rebaixada a `write`)? O aviso do rebaixamento, ou null. O
 * tier é o do spawn (o da skill sob o teto declarado para o board, como o engine o calcula); a postura sai da MESMA
 * função do engine, com as sondas memoizadas deste processo (autonomy-sandbox.ts shellDeniedWarning). O engine é
 * importado sob demanda: ele já está carregado (é dele o evento de conclusão), e o teste deste módulo não o carrega.
 * Best-effort: qualquer falha ⇒ null (sem evidência, o carimbo segue como antes).
 */
async function spawnShellDenied(board: string, trigger: string): Promise<string | null> {
  try {
    const { resolveTierCap } = await import("./engine");
    return shellDeniedWarning(capTier(tierOf(trigger as TriggerId), resolveTierCap(process.env, board)), trigger);
  } catch {
    return null;
  }
}

/**
 * IO: o que o alvo DECLAROU do ambiente de teste dele (`settings.yaml → target.qa`), no formato que o classificador
 * lê, mais a porta em que esta instalação da ferramenta escuta. Lido a cada carimbo (o settings é relido por mtime).
 * Nunca lança: settings ilegível ⇒ só o baseline universal.
 */
export function declaredFailureRules(): FailureRules {
  try {
    const qa = qaOf(loadRunnerConfig().target);
    return { ports: qa.ports, failureClasses: qa.failureClasses, selfPort: resolveServiceProbePort() };
  } catch {
    return {};
  }
}

/**
 * IO: carimba o diagnóstico de morte no card. Best-effort — loga e NUNCA lança. Idempotente (upsert por id).
 */
export async function stampRunDeathFinding(
  board: string,
  cardId: string,
  reason: RunnerFailureReason,
  detail?: string | null,
  /** o texto final do agente (o `result` do stream) — onde a falha da ferramenta aparece (ex.: o sandbox recusou o Bash). */
  finalText?: string | null,
  /** o passo que rodou (o trigger da falha): entra na chave da repetição e diz se o spawn rodou sem shell. */
  trigger?: string | null,
  /** de onde vêm as regras de ambiente do alvo; injetável para o teste não tocar o disco. */
  rulesOf: () => FailureRules = declaredFailureRules,
): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const step = trigger ? (STEP_LABEL_BY_TRIGGER[trigger] ?? trigger) : null;
    const postureWarn = trigger ? await spawnShellDenied(board, trigger) : null;
    let finding: Finding | null = null;
    await updateCardOnDisk(board, cardId, (card) => {
      finding = nextRunDeathFinding(card, { reason, detail, finalText, today, step, postureWarn, rules: rulesOf() });
      return applyRunDeathFinding(card, finding);
    });
    const f = finding as Finding | null;
    console.warn(
      `[run-death ${board}/${cardId}] morte '${reason}'${detail ? ` (${detail})` : ""} → diagnóstico ` +
        `carimbado (${f?.title ?? "?"}, classe=${f?.failureClass ?? "unknown"}, não-bloqueante, card não movido)`,
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

/**
 * IO: o card RECUPEROU (um run posterior sucedeu, ou o trabalho integrou) → o finding de corte por orçamento
 * fica obsoleto: flipa open→fixed, e o próximo corte volta a contar como o PRIMEIRO (a escalada ao humano é
 * sobre cortes SEGUIDOS). Best-effort; pula a escrita quando não há finding aberto. Nunca lança.
 */
export async function clearBudgetCutFinding(board: string, cardId: string): Promise<void> {
  try {
    await updateCardOnDisk(board, cardId, (card) => {
      const next = withBudgetCutResolved(card.findings ?? [], {
        by: "run:recovered",
        at: new Date().toISOString().slice(0, 10),
      });
      return next ? { ...card, findings: next } : null; // nada aberto → sem escrita
    });
  } catch (err) {
    console.error(`[run-death ${board}/${cardId}] limpeza do budget-cut falhou:`, err instanceof Error ? err.message : err);
  }
}

/** Fontes de evento mínimas (portas) — evitam acoplar run-death ao tipo concreto do engine/merge-queue. */
interface CompletionSource {
  onComplete(fn: (ev: { board: string; cardId: string; trigger?: string; outcome?: string; result?: { finalText?: string } }) => void): () => void;
}
interface MergeDoneSource {
  onMergeDone(fn: (ev: { board: string; cardId: string }) => void): () => void;
}

/**
 * Os desfechos SEM RunnerFailure que NÃO provam recuperação do card: um cancelamento do operador (trabalho
 * incompleto por decisão) e uma parada em max-turns (o run segue, retomado). Nenhum dos dois pode zerar a
 * contagem de cortes por orçamento — senão cancelar um run bastaria para o próximo corte parecer o primeiro.
 */
const NOT_A_RECOVERY = new Set(["cancelled", "max-turns"]);

/** O IO que o hook dispara — injetável para a prova observar QUAL carimbo/limpeza cada desfecho produz. */
export interface RunDeathIo {
  failures: () => Array<{ board: string; cardId: string; trigger?: string; reason: RunnerFailureReason; detail?: string }>;
  stamp: (
    board: string,
    cardId: string,
    reason: RunnerFailureReason,
    detail?: string | null,
    finalText?: string | null,
    trigger?: string | null,
  ) => void | Promise<void>;
  clearDeath: (board: string, cardId: string) => void | Promise<void>;
  clearBudgetCut: (board: string, cardId: string) => void | Promise<void>;
  /** a releitura de boot dos diagnósticos antigos ({@link backfillRunDeathOrigins}); ausente no teste. */
  backfill?: () => void | Promise<void>;
}

const defaultRunDeathIo: RunDeathIo = {
  failures: () => getRunnerRegistry().snapshot().failures,
  stamp: stampRunDeathFinding,
  clearDeath: clearRunDeathFinding,
  clearBudgetCut: clearBudgetCutFinding,
  backfill: backfillRunDeathOrigins,
};

/**
 * Assina a conclusão de run para carimbar/limpar o diagnóstico de morte — chamado UMA vez pelo
 * trigger-runner-channel (ao lado de setupEventLog), sem tocar o engine.ts.
 *
 * Discriminador morte-real × sucesso-com-aviso: o engine SUPRIME o RunnerFailure quando o card avançou
 * (falha-fantasma, story-ex0105), então a PRESENÇA de um RunnerFailure fresco no registry (mesmo singleton
 * do engine) separa uma morte real (carimba) de um sucesso/sucesso-com-aviso (limpa). Um merge-back
 * (onMergeDone) = o trabalho integrou = recuperado → limpa também (cobre o sucesso ISOLADO, que sai por
 * onMergeDone e não por onComplete).
 */
export function registerRunDeathFindings(
  engine: CompletionSource,
  mergeQueue: MergeDoneSource,
  io: RunDeathIo = defaultRunDeathIo,
): void {
  void io.backfill?.();
  engine.onComplete((ev) => {
    const failure = io.failures().find((f) => f.board === ev.board && f.cardId === ev.cardId);
    // Um corte por orçamento já tem o SEU diagnóstico — o finding `budget-cut` que o engine carimbou no settle
    // (com o teto, o gasto e o pedido de fatiar/re-planejar). Carimbar também "run morreu: budget-cut" seriam
    // dois alarmes para um fato, e o genérico diria menos que o específico.
    if (failure?.reason === "budget-cut") return;
    if (failure) void io.stamp(ev.board, ev.cardId, failure.reason, failure.detail, ev.result?.finalText, failure.trigger ?? ev.trigger);
    else {
      void io.clearDeath(ev.board, ev.cardId);
      if (!NOT_A_RECOVERY.has(ev.outcome ?? "")) void io.clearBudgetCut(ev.board, ev.cardId);
    }
  });
  mergeQueue.onMergeDone((ev) => {
    void io.clearDeath(ev.board, ev.cardId);
    void io.clearBudgetCut(ev.board, ev.cardId);
  });
}
