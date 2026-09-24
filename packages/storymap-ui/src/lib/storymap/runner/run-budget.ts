// run-budget — os TETOS DE CUSTO por processo (`claude --max-budget-usd`), numa fonte só e PURA.
//
// ── O QUE ISTO É, E O QUE NÃO É ──────────────────────────────────────────────────────────────────────
// É um DISJUNTOR contra run desembestado: um run que entra em loop, relê o repositório inteiro, ou
// perde o fio num card grande demais continua gastando até o watchdog de relógio matá-lo — e o relógio
// não sabe nada de dinheiro. O CLI já sabe parar por dinheiro (`--max-budget-usd`, verificado ENTRE
// turnos, então o estouro máximo é um turno) e o AgileHarness nunca passava a flag.
//
// NÃO é ritmo (pacing). O teto não distribui gasto ao longo do dia, não prioriza card, não desacelera
// nada: ele só existe para cortar o caso patológico. Por isso os defaults são largos — max(2×p90, p99)
// do custo nocional histórico de cada skill — e um run normal nunca encosta neles. Quem controla ritmo
// e gasto acumulado são outras peças: o orçamento diário do copiloto (`orchestrator.budget`), o
// backstop vitalício por card (`autorun.cardBudgetUSD`, ADR-063 4a) e o loop-guard (4b).
//
// NÃO é uma porta de roteamento. model-routing.ts proíbe uma "quarta porta" (um mapa skill→modelo
// cravado no runner). Esta tabela é skill→TETO, não skill→modelo: ela nunca escolhe tier, effort nem
// turnos; só limita quanto um processo pode gastar antes de ser interrompido. Um teto não é uma rota.
//
// PURO: só lê de types.ts (isomórfico). Quem lê settings/env é config.ts; quem emite a flag é flags.ts.

import { TRIGGER_IDS, type RunnerSettings, type TriggerId } from "@/lib/storymap/types";

/**
 * O teto default por skill, em USD. Derivado do custo nocional histórico como max(2×p90, p99): largo o
 * bastante para não cortar um run legítimo lento, estreito o bastante para parar um loop antes de ele
 * virar dezenas de dólares. Skill ausente daqui cai em {@link FALLBACK_RUN_BUDGET_USD}.
 */
export const DEFAULT_RUN_BUDGET_USD: Readonly<Partial<Record<TriggerId, number>>> = {
  "harness-do": 23.8,
  "harness-review": 13.9,
  "harness-plan": 11.1,
  "harness-sync-card": 10.9,
  "harness-fix": 7.8,
  "harness-qa": 7.5,
  "harness-grill": 4.7,
  "harness-ui": 4.3,
  "harness-enrich": 3.5,
  "harness-ux": 3.5,
  "harness-interview": 3.3,
  "harness-prioritize": 2.8,
  "harness-capture": 2.6,
};

/** O teto de qualquer skill sem linha própria na tabela acima (sem histórico para derivar um número). */
export const FALLBACK_RUN_BUDGET_USD = 8;

/**
 * Um valor de teto em USD, com a coerção ESTRITA que um disjuntor pede. `0` é SIGNIFICATIVO (desliga o
 * teto) — e é justamente por isso que a string vazia NÃO pode virar 0 por `Number("")`: um campo em
 * branco no YAML ou uma env var vazia desligaria a proteção em silêncio. Aceita número finito ≥ 0 ou
 * string numérica não-vazia; qualquer outra coisa (negativo, NaN, booleano, objeto) ⇒ undefined, e o
 * chamador cai no default — o lado em que o teto continua LIGADO.
 */
export function coerceBudgetUSD(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim());
  else return undefined;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** `autorun.maxBudgetUSD`: um número (teto GLOBAL de todo run) ou um mapa `trigger → número`. */
export type RunBudgetSetting = NonNullable<RunnerSettings["autorun"]["maxBudgetUSD"]>;

/**
 * Coerção de `autorun.maxBudgetUSD`. Fail-closed POR ENTRADA e sem spread do objeto cru: só entram chaves
 * que são um TriggerId conhecido com um valor que {@link coerceBudgetUSD} aceita. Uma chave com typo
 * (`harness-dooo`) ou um valor lixo é DESCARTADO com aviso — e a skill segue no default da tabela, com o
 * teto ligado. Um mapa do qual não sobra nada é "não declarado" (undefined), nunca `{}` fingindo configuração.
 */
export function coerceRunBudgetSetting(raw: unknown): RunBudgetSetting | undefined {
  if (raw == null) return undefined;
  const global = coerceBudgetUSD(raw);
  if (global !== undefined) return global;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`[storymap] settings autorun.maxBudgetUSD: valor inválido ${JSON.stringify(raw)} — mantidos os tetos default por skill.`);
    return undefined;
  }
  const out: Partial<Record<TriggerId, number>> = {};
  const recusados: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = coerceBudgetUSD(v);
    if ((TRIGGER_IDS as readonly string[]).includes(k) && n !== undefined) out[k as TriggerId] = n;
    else recusados.push(k);
  }
  if (recusados.length) {
    console.warn(
      `[storymap] settings autorun.maxBudgetUSD: ${recusados.length} entrada(s) DESCARTADA(s) (skill desconhecida ` +
        `ou valor inválido): ${recusados.join(", ")} — essas skills seguem no teto default.`,
    );
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * O teto EFETIVO de um run do engine para `trigger`, ou `null` quando desligado. A env já foi aplicada
 * sobre `setting` em config.ts (ENV vence arquivo), então aqui só há "o valor em vigor": um NÚMERO vale
 * para toda skill; um MAPA vale para as skills que ele nomeia e as demais caem na tabela; ausente ⇒
 * tabela. `0` em qualquer camada desliga.
 */
export function resolveRunBudgetUSD(trigger: TriggerId, setting: RunBudgetSetting | undefined): number | null {
  let v: number | undefined;
  if (typeof setting === "number") v = setting;
  else if (setting && typeof setting === "object") v = setting[trigger];
  if (v === undefined) v = DEFAULT_RUN_BUDGET_USD[trigger] ?? FALLBACK_RUN_BUDGET_USD;
  return v > 0 ? v : null;
}
