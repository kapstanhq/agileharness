// gate-health — os DOIS produtores que faltavam para capacidades que já existiam declaradas.
//
// O gate do train é excelente a MEDIR e péssimo a CONTAR. Ele já sabe duas coisas que ninguém nunca
// soube depois:
//
//  1. MAIN VERMELHA. A rodada de atribuição roda a suíte na BASE (o HEAD de main pré-merge) para separar
//     "o que este card quebrou" de "o que já estava quebrado". Quando ela acusa falhas pré-existentes, o
//     gate devolve `passed: true` com o log *"a main precisa de conserto à parte"* — e NADA acontece.
//     Nenhum finding, nenhum card, nenhum alarme. Main pode ficar vermelha indefinidamente enquanto toda
//     entrada passa alegremente, porque cada uma é individualmente inocente. É exatamente o padrão
//     "capacidade declarada com zero produtores": parece feature, nunca dispara.
//
//  2. FLAKY. Quando uma falha NOVA não reproduz no retry da suíte inteira, o train integra e agrega o
//     teste em `flaky.json` *"para quarentena futura"*. Nada lê esse arquivo — e ele nem sequer existia
//     no disco do runtime, porque o produtor depende de um caminho raro. A quarentena prometida nunca
//     teve consumidor.
//
// A QUARENTENA AQUI NÃO EXCLUI TESTE. Um teste em quarentena continua rodando e continua sendo
// reportado; o que muda é que a falha dele deixa de ser ATRIBUÍVEL ao submitter — ela entra no mesmo
// balde das falhas pré-existentes da main. Essa é a definição do SOTA (Trunk/Mergify: "remove do
// conjunto obrigatório sem remover da suíte"), e aqui ela sai de graça: o gate JÁ subtrai um conjunto
// de chaves conhecidas antes de decidir. Quarentenar é somar chaves a esse conjunto — três linhas, sem
// flag de vitest, sem tocar na suíte, e sem nunca esconder um resultado.
//
// PURO na decisão, IO isolado no fim (o padrão de landings.ts): as regras são testáveis sem disco.

import { promises as fsp } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";

// ── flaky ────────────────────────────────────────────────────────────────────────────────────────

/** Uma ocorrência de flake, como o train já a grava hoje (formato preservado — o arquivo é compatível). */
export interface FlakyRecord {
  at: string;
  testId: string;
  runId?: string;
  board?: string;
  cardId?: string;
}

export interface QuarantineSpec {
  /** quantas ocorrências na janela para quarentenar. 1 seria pânico; o default exige um PADRÃO. */
  minOccurrences: number;
  /** a janela, em dias — um teste que flakeou 3× ano passado e nunca mais não é flaky, é história. */
  windowDays: number;
  /** teto de testes em quarentena. Estourar o teto não é "muito flake": é a suíte podre, e aí a
   *  quarentena viraria um jeito de não olhar. Acima disto NADA é quarentenado e o motivo é dito. */
  maxQuarantined: number;
}

export const DEFAULT_QUARANTINE: QuarantineSpec = { minOccurrences: 3, windowDays: 30, maxQuarantined: 25 };

export interface QuarantineDecision {
  /** as chaves `<file>::<name>` cujas falhas deixam de ser atribuídas ao submitter */
  testIds: string[];
  /** por que — vai para o log do gate, para a quarentena nunca ser invisível */
  reason: string;
}

/**
 * Quem entra em quarentena AGORA. PURA.
 *
 * Um teste entra quando flakeou `minOccurrences` vezes dentro de `windowDays`. Estourar
 * `maxQuarantined` devolve conjunto VAZIO (não um conjunto capado): quarentenar 40 testes é decidir
 * não olhar para a suíte, e a resposta certa a uma suíte podre é consertá-la, não silenciá-la.
 */
export function decideQuarantine(
  records: readonly FlakyRecord[],
  now: number,
  spec: QuarantineSpec = DEFAULT_QUARANTINE,
): QuarantineDecision {
  const cutoff = now - spec.windowDays * 86_400_000;
  const counts = new Map<string, number>();
  for (const r of records) {
    const at = Date.parse(r?.at ?? "");
    if (!Number.isFinite(at) || at < cutoff) continue;
    if (!r.testId) continue;
    counts.set(r.testId, (counts.get(r.testId) ?? 0) + 1);
  }
  const eligible = [...counts.entries()]
    .filter(([, n]) => n >= spec.minOccurrences)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  if (eligible.length === 0) return { testIds: [], reason: "nenhum teste com padrão de flake na janela" };
  if (eligible.length > spec.maxQuarantined) {
    return {
      testIds: [],
      reason:
        `${eligible.length} testes elegíveis a quarentena (teto ${spec.maxQuarantined}) — NENHUM quarentenado: ` +
        `esse volume é suíte podre, não flake isolado, e silenciá-la seria decidir não olhar`,
    };
  }
  return { testIds: eligible, reason: `${eligible.length} teste(s) em quarentena (≥${spec.minOccurrences} flakes em ${spec.windowDays}d)` };
}

function flakyPath(): string {
  return path.join(runnerStateDir(), "flaky.json");
}

/** Lê o ledger de flakes. Ausente/ilegível ⇒ `[]` — a quarentena é uma OTIMIZAÇÃO; falhar em lê-la só
 *  significa não quarentenar ninguém, que é o comportamento de hoje. Nunca lança. */
export async function readFlakyRecords(file: string = flakyPath()): Promise<FlakyRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    return Array.isArray(parsed) ? (parsed.filter((r) => r && typeof (r as FlakyRecord).testId === "string") as FlakyRecord[]) : [];
  } catch {
    return [];
  }
}

/** Quem está em quarentena agora, como Set pronto para a subtração do gate. Nunca lança. */
export async function quarantinedTestIds(
  now: number = Date.now(),
  spec: QuarantineSpec = DEFAULT_QUARANTINE,
): Promise<QuarantineDecision> {
  return decideQuarantine(await readFlakyRecords(), now, spec);
}

// ── main vermelha ────────────────────────────────────────────────────────────────────────────────

/** Uma falha, no mesmo shape que o gate já produz (file/name/message). */
export interface RedTest {
  file: string;
  name: string;
  message?: string;
}

/**
 * O estado atual da main, como o gate o vê. Um SNAPSHOT (não um append-only): a pergunta é "a main está
 * vermelha AGORA?", e um histórico responderia outra coisa. O ledger de eventos que já existe
 * (transitions/journal) guarda o passado; aqui o que importa é o presente e desde quando.
 */
export interface MainRedState {
  /** desde quando a main está vermelha (ISO) — é o número que constrange, não a contagem */
  since: string;
  /** a última vez que medimos */
  at: string;
  /** o sha de main medido */
  sha: string;
  /** as falhas pré-existentes, capadas */
  failures: RedTest[];
  /** quantas medições seguidas viram vermelho — sobe a cada entrada que passa por cima do problema */
  observations: number;
}

const MAIN_RED_MAX_FAILURES = 12;

function mainRedPath(): string {
  return path.join(runnerStateDir(), "main-red.json");
}

/**
 * Decide o PRÓXIMO estado a partir do anterior + a medição atual. PURA (o `now`/`sha` entram por
 * parâmetro), que é o que torna a regra do `since` testável: ele preserva o início do episódio enquanto
 * a main seguir vermelha e só reinicia depois de um verde. Sem isso, "vermelha há 3 dias" viraria
 * "vermelha desde a última medição", que é a versão inofensiva — e inútil — do mesmo fato.
 */
export function nextMainRedState(
  prev: MainRedState | null,
  measurement: { failures: readonly RedTest[]; sha: string; at: string },
): MainRedState | null {
  if (measurement.failures.length === 0) return null; // verde ⇒ o episódio acabou; o estado some
  return {
    since: prev?.since ?? measurement.at,
    at: measurement.at,
    sha: measurement.sha,
    failures: measurement.failures.slice(0, MAIN_RED_MAX_FAILURES),
    observations: (prev?.observations ?? 0) + 1,
  };
}

/** Lê o estado. Ausente/ilegível ⇒ null (main presumida verde — este arquivo nunca autoriza uma ação
 *  destrutiva, só informa, então falhar em lê-lo custa uma linha de UI, não um risco). Nunca lança. */
export async function readMainRed(file: string = mainRedPath()): Promise<MainRedState | null> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    const s = parsed as MainRedState;
    return s && typeof s.since === "string" && Array.isArray(s.failures) ? s : null;
  } catch {
    return null;
  }
}

/**
 * Registra a medição do gate. Best-effort e non-fatal por contrato: telemetria NUNCA pode perturbar o
 * train (a mesma disciplina de recordMergeOutcome). Devolve o estado novo para quem quiser logar.
 */
export async function recordMainRedMeasurement(
  measurement: { failures: readonly RedTest[]; sha: string },
  file: string = mainRedPath(),
): Promise<MainRedState | null> {
  try {
    const prev = await readMainRed(file);
    const next = nextMainRedState(prev, { ...measurement, at: new Date().toISOString() });
    if (!next) {
      await fsp.rm(file, { force: true }).catch(() => {});
      if (prev) console.log(`[gate-health] main VERDE de novo (estava vermelha desde ${prev.since})`);
      return null;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fsp.rename(tmp, file);
    // O grito. Um log por medição é ruído; um log que diz HÁ QUANTO TEMPO e QUANTAS entradas passaram
    // por cima é uma dívida com juros visíveis.
    console.warn(
      `[gate-health] main VERMELHA desde ${next.since} (${next.observations}ª observação, ${next.failures.length} teste(s)): ` +
        next.failures.slice(0, 3).map((f) => `${f.file.split(/[\\/]/).pop()} › ${f.name}`).join(" | "),
    );
    return next;
  } catch (err) {
    console.warn("[gate-health] não consegui registrar o estado da main (não-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Uma rodada VERDE do gate autoriza declarar a main verde — e portanto APAGAR o estado?
 *
 * O PRODUTOR QUE FALTAVA DO PRODUTOR. O P-8 deu um registrador à medição de falhas pré-existentes, mas
 * a atribuição — a rodada sobre a BASE — só acontece quando a árvore MESCLADA falha. Entrada verde
 * nunca re-mede a main, então um episódio vermelho podia entrar e NUNCA mais sair: o arquivo só some
 * com uma medição verde, e medição verde nunca chegava. Medido em 2026-08-25 — a main tinha sido
 * consertada e o painel seguia anunciando 5 falhas de dois dias antes.
 *
 * A inferência que vale: se a suíte COMPLETA passou sobre (base + este delta) e o delta aterrissa,
 * então a main fica verde — qualquer falha que houvesse na base foi consertada por este delta, senão
 * ela teria aparecido aqui também. A inferência NÃO vale com seleção por afetados: ali a rodada mede um
 * SUBCONJUNTO, e "verde" não fala das suítes que não rodaram. Nesse caso não se declara nada — um
 * painel velho que se anuncia velho é melhor que um painel que apaga um vermelho que ninguém mediu.
 */
export function corridaVerdeLimpaMainRed(run: { ok: boolean; affectedOnly: boolean }): boolean {
  return run.ok && !run.affectedOnly;
}

/**
 * Uma linha para superfícies de status (runner_status/ops). `null` ⇒ nada a dizer. PURA.
 *
 * ELA DIZ O QUE SABE, NO TEMPO CERTO — e isso custou uma sessão inteira para virar regra. O estado só é
 * re-medido quando ALGUÉM PASSA PELO GATE: main que fica verde sem ninguém integrar continua sendo
 * anunciada como vermelha, indefinidamente. Em 2026-08-25 a linha dizia "5 teste(s)" enquanto a medição
 * do dia dizia 1 — o retrato era de uma árvore de gate de dois dias antes, e eu repeti o número dela
 * para o dono como se fosse o presente.
 *
 * Um alarme que afirma o presente sobre uma medição passada é pior que nenhum: ele treina quem lê a
 * ignorá-lo. Por isso a linha carrega QUANDO mediu e SOBRE QUAL sha — o leitor decide se ainda vale, e
 * o custo é zero (nada de git no caminho de um status). O `sha` já estava no estado e ninguém o mostrava.
 */
export function describeMainRed(state: MainRedState | null, now: number = Date.now()): string | null {
  if (!state) return null;
  const days = Math.max(0, Math.floor((now - Date.parse(state.since)) / 86_400_000));
  const age = days >= 1 ? `há ${days}d` : "hoje";
  const medidaEm = state.at.slice(0, 16).replace("T", " ");
  return (
    `main VERMELHA ${age} (desde ${state.since.slice(0, 10)}): ${state.failures.length} teste(s) pré-existente(s) — ` +
    `NENHUM card é reprovado por eles, e ninguém está consertando. ` +
    `Medição de ${medidaEm}Z sobre ${state.sha.slice(0, 9)}: só é re-medida quando alguém passa pelo gate, ` +
    `então confirme na main de hoje antes de repetir este número`
  );
}
