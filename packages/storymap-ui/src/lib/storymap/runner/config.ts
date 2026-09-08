// Runner config — the resolved, editable form of the autorun runner settings.
// Layers as: DEFAULTS < storymap/settings.yaml < process.env. ENV ALWAYS wins,
// so the operational kill switch (USM_AUTORUN=0) and the other USM_* overrides
// are untouched — and a MISSING settings.yaml means behavior identical to the
// pre-settings era (full back-compat).
//
// Read SYNC + memoized by file mtime: the trigger-runner channel calls
// loadRunnerConfig() at spawn time, so editing settings.yaml in the UI takes
// effect on the next run WITHOUT restarting the dev server.
//
// SERVER-ONLY: imports node:fs. Never import this from a client component — use
// the server actions in app/actions.ts instead.

import { promises as fsp, readFileSync, statSync } from "node:fs";
import yaml from "js-yaml";
import { settingsPath } from "@/lib/storymap/paths";
// A decomposição base+variante do modelo mora em copilot-status (fonte única; só importa `types`).
import { CHAT_EFFORTS, CHAT_MODEL_BASES, composeModel, splitModelVariant } from "@/lib/storymap/copilot/copilot-status";
// story-6h3ioj — o MESMO piso de força que o endpoint MCP aplica por requisição (mcp/auth.ts é
// puro: só node:crypto) julga aqui o VALOR de cada `mcpTokens`. Duas réguas seriam duas verdades,
// e a que apodrece é sempre a do lado que ninguém testa. Ele roda na camada ENV
// (`mcpTokensBackedBySecret`, chamada por `applyEnvOverrides`), NÃO na coerção do arquivo — ver o
// doc-comment de `coerceMcpTokens` para por que a fronteira está exatamente aí.
import { maskSecret, secretWeakness, weaknessAdvice } from "@/lib/storymap/mcp/auth";
// A REGRA de normalização do segredo MCP mora em token-bootstrap (uma só, para o tier primário e os
// escopados) — ver `normalizeScopedMcpTokenEnv` logo abaixo de `mcpSecretWarned`.
import { MCP_TOKEN_ENV, normalizeMcpTokenEnv } from "@/lib/storymap/mcp/token-bootstrap";
import { patchYamlScalars } from "./settings-yaml";
import { columnFlags } from "./flags";
import { deriveCardMaxTurns, deriveCardModelEffort, type CardComplexitySignals } from "./model-routing";
import {
  EFFORT_LEVELS,
  MODEL_TIERS,
  MCP_LEVELS,
  RISK_CLASSES,
  RISK_DISPOSITIONS,
  type Card,
  type EffortLevel,
  type McpLevel,
  type ModelTier,
  type OrchestratorSettings,
  type RiskClass,
  type RiskDisposition,
  type RunnerColumnDefaults,
  type RunnerSettings,
  type StatusDef,
  type TriggerId,
} from "@/lib/storymap/types";

const FAST_TIMEOUT_MS = 6 * 60_000;
// Integration-gate defaults (story-1k7els): the suite run in the staging worktree + its ceiling.
const GATE_CHECK_COMMAND = "vitest run";
const GATE_TIMEOUT_MS = 5 * 60_000;
// Typecheck do gate — canal próprio, por unidade com tsconfig.json (ver types.ts `mergeGate.typecheck`).
const GATE_TYPECHECK_COMMAND = "bunx tsc --noEmit";
// Merge-train re-drive default (story-92ldyt): max re-drives per conflict before the graceful fallback.
const DEFAULT_MAX_REDRIVES = 2;
/**
 * WS-1.5 — how many agent-session worktrees may exist at once (`autorun.sessions.maxWorktrees`). Lives
 * here (not in session-worktree.ts) because config.ts owns every default it coerces, and because importing
 * it from there would close a cycle: session-worktree → worktree → config.
 */
export const DEFAULT_MAX_SESSION_WORKTREES = 4;
// ADR-063 (4b) — default same-column-no-progress loop-guard cap: after 3 consecutive non-advancing runs
// of the same trigger in the same status, the cascade circuit-breaks (writes an operator finding + stops).
const DEFAULT_NO_PROGRESS_MAX = 3;
// Staged-release defaults (Fase 4a): the branch app code is held on, and the path prefixes treated as
// deployable CODE (routed to stage); everything else (storymap/** board data, .claude/** skills) → main.
const STAGING_BRANCH = "stage";
/** Path prefixes that count as deployable CODE — the merge train gates + splits ONLY runs that touch
 * these (board-data runs skip the code gate). Exported so the merge train reads the SAME default. */
export const STAGING_CODE_PREFIXES: readonly string[] = ["packages/"];
/**
 * Default para `autorun.qa.uiSurfacePatterns` — o que conta como superfície visível ao usuário.
 *
 * Deliberadamente APENAS extensões de arquivo de UI, nenhuma pasta e nenhum nome de app: extensão é
 * fato da LINGUAGEM (um `.tsx` renderiza tela em qualquer repo), enquanto "onde a UI mora" é
 * convenção local — cravá-la aqui seria overfitting ao consumidor de hoje e quebraria o próximo.
 * Quem tem convenção própria acrescenta em `settings.yaml` (ex.: `src/views/`). Exportado para os
 * testes medirem o MESMO default que o engine usa.
 */
export const UI_SURFACE_PATTERNS: readonly string[] = [
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
];
/** The git pathspec the engine's no-worktree board-data settle commits (story-apz8sa FIX 2). An
 * isCode:false run only ever mutates `storymap/boards/**` (path-disjoint from product CODE), so its
 * settle commit stages ONLY this prefix — NEVER `git add -A` over the whole shared main tree — so a
 * stray code edit or unrelated board file dirtying the tree can never ride the `board:` commit. */
export const BOARD_DATA_PATHSPEC = "storymap/boards/";
// Last-resort ceiling for ANY run (incl. code skills without costGuard/doMs, like refine).
// Generous — an order of magnitude over the fast watchdog — so it never sabotages a legit
// long run, but it is NEVER null: no run may hold a concurrency slot forever.
const UNIVERSAL_TIMEOUT_MS = 60 * 60_000;

/**
 * Triggers skipped by the autorun cascade when economy mode is on.
 * These have `autorun: true` but use Opus/high — expensive and infrequent enough to run manually.
 */
export const ECONOMY_BLOCKED_AUTORUN_TRIGGERS: readonly TriggerId[] = ["harness-refine", "harness-fix"];

/** Apply economy mode ceiling to a def's model/effort (sonnet max, high max). Pure helper.
 * maxTurns is intentionally NOT capped: economy mode saves via model/effort downgrade only —
 * limiting turns on top would truncate work mid-plan without saving proportional cost. */
function applyEconomyCap(
  def: Pick<StatusDef, "model" | "effort" | "maxTurns" | "mcpConfig">,
): Pick<StatusDef, "model" | "effort" | "maxTurns" | "mcpConfig"> {
  const model: ModelTier | undefined = def.model === "opus" ? "sonnet" : def.model;
  const effort: EffortLevel | undefined =
    def.effort === "xhigh" || def.effort === "max" ? "high" : def.effort;
  // Explicitly reconstruct without maxTurns — avoids minifier treating `maxTurns: undefined`
  // as a no-op when def.maxTurns is already set (e.g. 20 from board.yaml).
  const capped: Pick<StatusDef, "model" | "effort" | "maxTurns" | "mcpConfig"> = {
    model,
    effort,
    mcpConfig: def.mcpConfig,
  };
  return capped;
}

/** Baseline used when settings.yaml is absent — identical to legacy env defaults. */
export const DEFAULT_RUNNER_SETTINGS: RunnerSettings = {
  version: 1,
  economyMode: false,
  autorun: {
    enabled: true,
    resumeOnBoot: true,
    maxConcurrent: 2,
    // ADR-063 (4b) loop-guard cap (default 3; 0 disables) — the "same-column-no-progress" circuit breaker.
    // (4a) cardBudgetUSD is intentionally ABSENT here: undefined = DISABLED (opt-in only, no behaviour change).
    noProgressMax: DEFAULT_NO_PROGRESS_MAX,
    timeouts: { fastMs: FAST_TIMEOUT_MS, doMs: null, universalMs: UNIVERSAL_TIMEOUT_MS },
    claudeBin: "claude",
    extraArgs: [],
    // ── DEFAULT VIRADO EM F0 (ADR-067), e o motivo é uma reprovação ────────────────────────────────
    // Nascia `false`. O `settings.yaml` do dono liga `true`, então TODA a medição de contenção da fase
    // foi feita numa configuração que o adotante NÃO herdava — o erro clássico de medir num lugar e
    // enviar outro. Com `false` nenhum worktree é criado, o `cwd` do run permanece a raiz do
    // repositório, e o sandbox emite `allowWrite: [<raiz>]`: a escrita liberada é o repositório
    // INTEIRO, incluindo o código do próprio harness, `.claude/` e os hooks. A promessa de manchete
    // ("escrita liberada só para a árvore do run") era falsa exatamente para quem instalasse do zero.
    // Ligar por default alinha o produto com o que a documentação descreve e com o que o dono roda em
    // produção há meses. Quem precisa do modo antigo desliga explicitamente — e recebe um aviso alto,
    // porque a diferença é de perímetro, não de conveniência.
    worktreeIsolation: true,
    // Integration gate DEFAULT OFF — a dormant capability turned on via settings.yaml / USM_AUTORUN_MERGE_GATE=1.
    mergeGate: {
      enabled: false,
      checkCommand: GATE_CHECK_COMMAND,
      timeoutMs: GATE_TIMEOUT_MS,
      retryOnNewFailure: true,
      // Typecheck DEFAULT ON (D8: gate nunca cego) — a atribuição por árvore o torna seguro: base
      // vermelha é perdoada e nomeada, nunca congela a fila. Só roda em unidade com tsconfig.json.
      typecheck: { enabled: true, command: GATE_TYPECHECK_COMMAND },
    },
    // Merge-train re-drive (story-92ldyt): a conflict re-runs the generating skill against the updated
    // main instead of pausing, up to this cap, then degrades to the legacy `conflict` pause.
    // WS-10/D14: `semanticResolution` DEFAULT ON — a divergence climbs the ladder (convergência → filtro
    // determinístico → juiz `harness-resolve`) antes de chegar ao humano. Boot flag; false ⇒ comportamento de
    // hoje byte-idêntico (a escada nem roda git). Ver runner/semantic-resolution.ts.
    mergeTrain: { maxRedrives: DEFAULT_MAX_REDRIVES, semanticResolution: true },
    // Staged release (Fase 4a) DEFAULT OFF — a dormant capability: a run touching `packages/**` routes
    // its CODE to the `stage` branch (held for a human release gate) while board data lands on main.
    // Off ⇒ every run merges to main as before. Boot-fixed (not hot-reloaded). USM_AUTORUN_STAGING=1/0.
    // `dataDerived` empty by default: routing stays pure path-prefix until a repo declares otherwise.
    staging: { enabled: false, branch: STAGING_BRANCH, codePrefixes: [...STAGING_CODE_PREFIXES], dataDerived: [] },
    // Medição da superfície de UI: ON por default (ao contrário das capacidades dormentes acima) —
    // ela só ACRESCENTA um fato ao card; quem decide o que fazer com ele é o gate.
    qa: { uiSurfacePatterns: [...UI_SURFACE_PATTERNS] },
    // Fila de publicação DEFAULT OFF — uma capacidade que reinicia o serviço não se liga sozinha. A
    // política POR BOARD saiu daqui (era `boards: []`) e virou `release.mode` no board.yaml, cujo
    // default é `manual`: mesmo com este master switch ligado por engano, nada publica sozinho.
    publishQueue: { enabled: false },
    // Permissive baseline: lane caps high (99) and thresholds off (RAM floor 0, load ceiling 999)
    // → a config without a `scheduler` section admits exactly like the pre-scheduler engine.
    scheduler: {
      lanes: { light: { maxConcurrent: 99 }, heavy: { maxConcurrent: 99 } },
      thresholds: { ramFreeMb: 0, loadAvg1: 999 },
    },
    // WS-1.5 — cap on simultaneous agent-session worktrees (`worktree_open`). Unlike the permissive
    // scheduler baseline above, this default is REAL (4, not 99): a session tree is opened by an agent on
    // demand with nothing else throttling it, so an absent config must still protect the box.
    sessions: { maxWorktrees: DEFAULT_MAX_SESSION_WORKTREES },
  },
  columnDefaults: {},
  // WS8 (F7) — board copiloto/orchestrator DEFAULT OFF: the in-process tick never fires unless a settings.yaml
  // opt-in flips `enabled` AND a board declares orchestrator.mode != off. Byte-identical to no Jido.
  orchestrator: {
    enabled: false,
    tickMinutes: 30,
    budget: { maxTicksPerDay: 20, maxCostPerDay: 10 },
    notifyBudget: { maxPushesPerDay: 12 },
    chat: { model: "opus", effort: "medium" },
    // WAKE — acordar por evento vem LIGADO por default, mas é INERTE sem um board `autonomous` (o wake só
    // agenda; quem decide spawnar é o tick, com todos os seus gates). Um board em off/paired nunca acorda.
    wake: { enabled: true, debounceSeconds: 45, cooldownMinutes: 5 },
  },
};

function asModel(v: unknown): ModelTier | undefined {
  return MODEL_TIERS.includes(v as ModelTier) ? (v as ModelTier) : undefined;
}
function asEffort(v: unknown): EffortLevel | undefined {
  return EFFORT_LEVELS.includes(v as EffortLevel) ? (v as EffortLevel) : undefined;
}
function asPosInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
// ADR-063 (4b): a cap that treats 0 as a MEANINGFUL "disable" (unlike asPosInt, which rejects 0). A
// set non-negative integer (incl. 0) → its floor; undefined/garbage/negative → undefined (fall to default).
function asNonNegInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
// ADR-063 (4a): a positive REAL $ budget (fractional dollars are valid). undefined/garbage/≤0 → undefined
// (the feature stays OFF — a 0/negative budget would freeze the card, so it reads as "not configured").
function asPosNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
// Thresholds may legitimately be 0 (ramFreeMb: 0 = "never block on RAM") and fractional
// (loadAvg1: 3.5), so they need a non-negative real coercion, not asPosInt (which floors + rejects 0).
function asNonNegNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
// Is an env var actually SET to a meaningful value? Used for the zero-valid threshold overrides where
// Number("") === 0 would otherwise turn an empty/whitespace var into a real (degenerate) 0 override.
function isSetEnv(v: string | undefined): v is string {
  return v != null && v.trim() !== "";
}
// A non-empty trimmed string or undefined — used for the lane `memoryMax` quota (a systemd
// MemoryMax value like "2G"). We do NOT validate the systemd format here (systemd rejects an
// invalid value at runtime, degrading gracefully); we only reject empty/blank → "no quota".
function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  return [];
}

// Build one scheduler lane from raw YAML over a default cap. The SM-4 quota fields
// (`memoryMax`/`cpuQuota`) are OPTIONAL and only set when present+valid, so an unconfigured
// lane object has NO quota keys (back-compat: deep-equals the permissive default lane).
function coerceLane(raw: any, defaultMax: number): { maxConcurrent: number; memoryMax?: string; cpuQuota?: number } {
  const lane: { maxConcurrent: number; memoryMax?: string; cpuQuota?: number } = {
    maxConcurrent: asPosInt(raw.maxConcurrent) ?? defaultMax,
  };
  const memoryMax = asNonEmptyString(raw.memoryMax);
  if (memoryMax) lane.memoryMax = memoryMax;
  const cpuQuota = asPosInt(raw.cpuQuota);
  if (cpuQuota) lane.cpuQuota = cpuQuota;
  return lane;
}

/** Coerce raw YAML into RunnerSettings, layered over defaults (no ENV yet). */
export function coerceRunnerSettings(raw: unknown): RunnerSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as any;
  const a = (r.autorun && typeof r.autorun === "object" ? r.autorun : {}) as any;
  const t = (a.timeouts && typeof a.timeouts === "object" ? a.timeouts : {}) as any;
  const cd = (r.columnDefaults && typeof r.columnDefaults === "object" ? r.columnDefaults : {}) as any;
  const d = DEFAULT_RUNNER_SETTINGS;

  // scheduler (lanes + thresholds), each field independently coerced over the permissive defaults
  // so a partial/absent section still yields a complete, valid scheduler config.
  const mg = (a.mergeGate && typeof a.mergeGate === "object" ? a.mergeGate : {}) as any;
  const dmg = d.autorun.mergeGate!;
  const mt = (a.mergeTrain && typeof a.mergeTrain === "object" ? a.mergeTrain : {}) as any;
  const dmt = d.autorun.mergeTrain!;
  const st = (a.staging && typeof a.staging === "object" ? a.staging : {}) as any;
  const dst = d.autorun.staging!;
  const qa = (a.qa && typeof a.qa === "object" ? a.qa : {}) as any;
  const dqa = d.autorun.qa!;
  const pq = (a.publishQueue && typeof a.publishQueue === "object" ? a.publishQueue : {}) as any;
  const dpq = d.autorun.publishQueue!;
  const sc = (a.scheduler && typeof a.scheduler === "object" ? a.scheduler : {}) as any;
  const scLanes = (sc.lanes && typeof sc.lanes === "object" ? sc.lanes : {}) as any;
  const scLight = (scLanes.light && typeof scLanes.light === "object" ? scLanes.light : {}) as any;
  const scHeavy = (scLanes.heavy && typeof scLanes.heavy === "object" ? scLanes.heavy : {}) as any;
  const scTh = (sc.thresholds && typeof sc.thresholds === "object" ? sc.thresholds : {}) as any;
  const ds = d.autorun.scheduler;
  const ss = (a.sessions && typeof a.sessions === "object" ? a.sessions : {}) as any;

  const columnDefaults: RunnerColumnDefaults = {};
  const cdModel = asModel(cd.model);
  if (cdModel) columnDefaults.model = cdModel;
  const cdEffort = asEffort(cd.effort);
  if (cdEffort) columnDefaults.effort = cdEffort;
  const cdMax = asPosInt(cd.maxTurns);
  if (cdMax) columnDefaults.maxTurns = cdMax;

  return {
    version: asPosInt(r.version) ?? d.version,
    economyMode: typeof r.economyMode === "boolean" ? r.economyMode : false,
    autorun: {
      enabled: typeof a.enabled === "boolean" ? a.enabled : d.autorun.enabled,
      resumeOnBoot: typeof a.resumeOnBoot === "boolean" ? a.resumeOnBoot : d.autorun.resumeOnBoot,
      maxConcurrent: asPosInt(a.maxConcurrent) ?? d.autorun.maxConcurrent,
      // ADR-063 (4b): non-negative int (0 = disable); garbage/negative → the default cap. (4a) cardBudgetUSD
      // stays OFF unless a POSITIVE number is present — the key is omitted otherwise (mirrors the lane quotas).
      noProgressMax: asNonNegInt(a.noProgressMax) ?? d.autorun.noProgressMax,
      ...(asPosNum(a.cardBudgetUSD) !== undefined ? { cardBudgetUSD: asPosNum(a.cardBudgetUSD) } : {}),
      timeouts: {
        fastMs: asPosInt(t.fastMs) ?? d.autorun.timeouts.fastMs,
        doMs: t.doMs == null ? null : (asPosInt(t.doMs) ?? null),
        // Never null — a missing/invalid value falls back to the generous default ceiling,
        // so an old config without this field still loads a working universal watchdog.
        universalMs: asPosInt(t.universalMs) ?? d.autorun.timeouts.universalMs,
      },
      claudeBin:
        typeof a.claudeBin === "string" && a.claudeBin.trim() ? a.claudeBin.trim() : d.autorun.claudeBin,
      extraArgs: asStringArray(a.extraArgs),
      worktreeIsolation:
        typeof a.worktreeIsolation === "boolean" ? a.worktreeIsolation : d.autorun.worktreeIsolation,
      mergeGate: {
        enabled: typeof mg.enabled === "boolean" ? mg.enabled : dmg.enabled,
        checkCommand:
          typeof mg.checkCommand === "string" && mg.checkCommand.trim() ? mg.checkCommand.trim() : dmg.checkCommand,
        timeoutMs: asPosInt(mg.timeoutMs) ?? dmg.timeoutMs,
        retryOnNewFailure: typeof mg.retryOnNewFailure === "boolean" ? mg.retryOnNewFailure : (dmg.retryOnNewFailure ?? true),
        // Affected-only selection: opt-in per board. Requires a non-empty `command` template; else it
        // stays whatever the default carries (undefined ⇒ full suite). See runner/affected-gate.ts.
        affected:
          mg.affected && typeof mg.affected === "object" && typeof mg.affected.command === "string" && mg.affected.command.trim()
            ? {
                enabled: typeof mg.affected.enabled === "boolean" ? mg.affected.enabled : false,
                command: mg.affected.command.trim(),
                fullSuitePaths: asStringArray(mg.affected.fullSuitePaths),
              }
            : dmg.affected,
        // P-7 — o escopo do gate. Coerção EXPLÍCITA e não um spread: Zod/coerce que não conhece um campo
        // o DROPA, e um campo dropado é uma capacidade INERTE que parece ligada (foi o que aconteceu com
        // `deploy.surfaces`, inerte por dias porque o coerce não o carregava). Só entram entradas cujo
        // valor é um comando string não-vazio; o resto é ignorado em silêncio e cai no fallback, que é o
        // comportamento de hoje.
        scope:
          mg.scope && typeof mg.scope === "object"
            ? {
                packages: Object.fromEntries(
                  Object.entries((mg.scope.packages ?? {}) as Record<string, unknown>).filter(
                    (e): e is [string, string] => typeof e[1] === "string" && e[1].trim().length > 0,
                  ),
                ),
                ...(asPosInt(mg.scope.maxUnits) ? { maxUnits: asPosInt(mg.scope.maxUnits)! } : {}),
                // Mesma disciplina do bloco acima: campo que o coerce não carrega vira capacidade INERTE que
                // PARECE ligada. `cwd` não-vazio é o mínimo que torna a declaração útil; sem ele a entrada é
                // ignorada e cai no default histórico, que é o comportamento de hoje.
                ...(mg.scope.fallback && typeof mg.scope.fallback === "object" && asNonEmptyString((mg.scope.fallback as Record<string, unknown>).cwd)
                  ? {
                      fallback: {
                        cwd: asNonEmptyString((mg.scope.fallback as Record<string, unknown>).cwd)!,
                        ...(asNonEmptyString((mg.scope.fallback as Record<string, unknown>).command) ? { command: asNonEmptyString((mg.scope.fallback as Record<string, unknown>).command)! } : {}),
                      },
                    }
                  : {}),
              }
            : dmg.scope,
        // Typecheck do gate — MESMA disciplina (coerção EXPLÍCITA, nunca spread): campo que o coerce não
        // carrega vira capacidade INERTE que parece ligada. E aqui o risco tem o sinal INVERTIDO do
        // habitual: o DEFAULT é LIGADO, então dropar a chave não desligaria uma capacidade — LIGARIA uma
        // à revelia de quem escreveu `enabled: false`. Por isso o BOOLEAN CRU é aceito como atalho:
        // `typecheck: false` (e o `off` do YAML, que o parser resolve como false) é a grafia natural do
        // desligamento — recusá-la em silêncio ligaria o verificador à revelia do operador. `command` só
        // entra não-vazio, senão fica o default.
        typecheck:
          typeof mg.typecheck === "boolean"
            ? { enabled: mg.typecheck, command: dmg.typecheck!.command }
            : {
                enabled:
                  mg.typecheck && typeof mg.typecheck === "object" && typeof (mg.typecheck as Record<string, unknown>).enabled === "boolean"
                    ? ((mg.typecheck as Record<string, unknown>).enabled as boolean)
                    : dmg.typecheck!.enabled,
                command:
                  mg.typecheck && typeof mg.typecheck === "object" && asNonEmptyString((mg.typecheck as Record<string, unknown>).command)
                    ? asNonEmptyString((mg.typecheck as Record<string, unknown>).command)!
                    : dmg.typecheck!.command,
              },
      },
      mergeTrain: {
        maxRedrives: asPosInt(mt.maxRedrives) ?? dmt.maxRedrives,
        // Only an EXPLICIT boolean overrides the default — a typo'd/absent value keeps the ladder ON rather
        // than silently disabling it (the same coercion shape as mergeGate.enabled).
        semanticResolution: typeof mt.semanticResolution === "boolean" ? mt.semanticResolution : dmt.semanticResolution,
      },
      staging: {
        enabled: typeof st.enabled === "boolean" ? st.enabled : dst.enabled,
        branch: asNonEmptyString(st.branch) ?? dst.branch,
        // An explicit (even empty) array is honored; a missing/invalid value falls back to the default.
        // An EMPTY list means "nothing is code" → every run merges to main (staging effectively inert).
        codePrefixes: Array.isArray(st.codePrefixes) ? asStringArray(st.codePrefixes) : [...dst.codePrefixes],
        dataDerived: coerceDataDerived(st.dataDerived),
      },
      qa: {
        // Mesma regra do `codePrefixes`: um array EXPLÍCITO (mesmo vazio) vence — vazio significa
        // "nada é superfície" e desliga a medição de propósito; ausente/inválido cai no default.
        uiSurfacePatterns: Array.isArray(qa.uiSurfacePatterns)
          ? asStringArray(qa.uiSurfacePatterns)
          : [...dqa.uiSurfacePatterns],
      },
      // `boards` foi removido de propósito: um `boards:` sobrando num settings.yaml antigo é IGNORADO,
      // e isso é seguro por construção — a política que ele carregava (quem publica sozinho) tem default
      // `manual` no board.yaml, então ignorá-lo nunca liga nada, só deixa de ligar. O lint de settings
      // avisa quando a chave morta ainda está lá.
      publishQueue: { enabled: typeof pq.enabled === "boolean" ? pq.enabled : dpq.enabled },
      scheduler: {
        lanes: {
          light: coerceLane(scLight, ds.lanes.light.maxConcurrent),
          heavy: coerceLane(scHeavy, ds.lanes.heavy.maxConcurrent),
        },
        thresholds: {
          ramFreeMb: asNonNegNum(scTh.ramFreeMb) ?? ds.thresholds.ramFreeMb,
          loadAvg1: asNonNegNum(scTh.loadAvg1) ?? ds.thresholds.loadAvg1,
          // Portable per-core ceiling. asPosNum (not asNonNegNum): 0 per core would mean "never admit",
          // which as a THRESHOLD is a footgun, and as a config typo is indistinguishable from an empty
          // value — so a non-positive reads as "not configured" and the absolute applies.
          ...(asPosNum(scTh.loadAvg1PerCore) != null ? { loadAvg1PerCore: asPosNum(scTh.loadAvg1PerCore)! } : {}),
        },
      },
      // WS-1.5 — `asPosInt` rejects 0/negatives/garbage, so a typo can never silently open the gate to
      // unlimited session worktrees (nor pin it shut at 0): it falls back to the real default.
      sessions: {
        maxWorktrees: asPosInt(ss.maxWorktrees) ?? d.autorun.sessions.maxWorktrees,
      },
    },
    columnDefaults,
    ...(coerceDeploySettings(r.deploy) ? { deploy: coerceDeploySettings(r.deploy) } : {}),
    orchestrator: coerceOrchestratorSettings(r.orchestrator, d.orchestrator!),
    ...(coerceMcpTokens(r.mcpTokens) ? { mcpTokens: coerceMcpTokens(r.mcpTokens) } : {}),
  };
}

/** WS8 — coerce the orchestrator deployment settings over the OFF-by-default baseline. Tolerant. */
function coerceOrchestratorSettings(raw: unknown, d: OrchestratorSettings): OrchestratorSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as any;
  const b = (o.budget && typeof o.budget === "object" ? o.budget : {}) as any;
  const nb = (o.notifyBudget && typeof o.notifyBudget === "object" ? o.notifyBudget : {}) as any;
  const w = (o.wake && typeof o.wake === "object" ? o.wake : {}) as any;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
    tickMinutes: asPosInt(o.tickMinutes) ?? d.tickMinutes,
    budget: {
      maxTicksPerDay: asPosInt(b.maxTicksPerDay) ?? d.budget!.maxTicksPerDay,
      maxCostPerDay: asPosNum(b.maxCostPerDay) ?? d.budget!.maxCostPerDay,
    },
    notifyBudget: { maxPushesPerDay: asPosInt(nb.maxPushesPerDay) ?? d.notifyBudget!.maxPushesPerDay },
    chat: coerceChatSettings(o.chat, d.chat),
    riskMatrix: coerceRiskMatrix(o.riskMatrix) ?? d.riskMatrix,
    wake: {
      enabled: typeof w.enabled === "boolean" ? w.enabled : d.wake!.enabled,
      // asNonNegInt: 0 é um valor SIGNIFICATIVO aqui (sem debounce / sem cooldown), não "use o default".
      debounceSeconds: asNonNegInt(w.debounceSeconds) ?? d.wake!.debounceSeconds,
      cooldownMinutes: asNonNegInt(w.cooldownMinutes) ?? d.wake!.cooldownMinutes,
    },
  };
}

/**
 * Coerce a matriz de risco de ESCOPO REPO (settings.yaml orchestrator.riskMatrix). Tolerante e fail-safe:
 * classe desconhecida ou disposição inválida é DESCARTADA (nunca vira `auto` por engano), matriz vazia vira
 * undefined (= "não declarada", cai no default conservador). O clamp de NEVER_AUTO não é feito aqui e sim em
 * `dispositionFor` — defesa em profundidade: um settings.yaml editado à mão pula qualquer lint, nunca o clamp.
 */
function coerceRiskMatrix(raw: unknown): Partial<Record<RiskClass, RiskDisposition>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Partial<Record<RiskClass, RiskDisposition>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(RISK_CLASSES as readonly string[]).includes(k)) continue;
    if (!(RISK_DISPOSITIONS as readonly string[]).includes(v as string)) continue;
    out[k as RiskClass] = v as RiskDisposition;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * `staging.dataDerived` — artefatos que MORAM sob um `codePrefixes` mas DERIVAM de board-data.
 *
 * Fail-CLOSED por entrada: uma declaração incompleta (sem `artifact`, sem `sources`, sem `regen` ou sem
 * `cwd`) é DESCARTADA em vez de aceita pela metade. O motivo é assimetria de dano: aceitar meia
 * declaração rotearia o artefato para a metade de dados SEM saber regenerá-lo — exatamente o estado que
 * deixa `main` vermelho e congela o train (o defeito que esta config existe para fechar). Descartar só
 * devolve o comportamento antigo, que é ruim mas conhecido.
 */
function coerceDataDerived(raw: unknown): NonNullable<RunnerSettings["autorun"]["staging"]>["dataDerived"] {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<NonNullable<RunnerSettings["autorun"]["staging"]>["dataDerived"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const artifact = asNonEmptyString(o.artifact);
    const cwd = asNonEmptyString(o.cwd);
    const regen = asNonEmptyString(o.regen);
    const sources = Array.isArray(o.sources) ? asStringArray(o.sources) : [];
    if (!artifact || !cwd || !regen || sources.length === 0) continue;
    out.push({ artifact, sources, cwd, regen });
  }
  return out;
}

// F3.3 — vocabulário conhecido do chat do Jido; valor fora dele cai no default (nunca persiste lixo).
// A LISTA vive em copilot/copilot-status (isomórfica): é a mesma que a engrenagem e o `/model` oferecem —
// duas cópias seriam a UI oferecendo um valor que esta coerção descarta em silêncio.
const CHAT_MODELS = new Set<string>(CHAT_MODEL_BASES);
const CHAT_EFFORTS_SET = new Set<string>(CHAT_EFFORTS);

/**
 * O modelo do chat se decompõe em BASE (`opus`) + VARIANTE de contexto longo (`[1m]`) — é o que
 * `splitModelVariant` já formaliza, e a UI oferece as duas escolhas separadamente.
 *
 * A validação comparava a string INTEIRA contra o vocabulário, então `opus[1m]` — um valor que a
 * própria UI escreve — não era reconhecido e caía no default `opus`. A escolha do operador era
 * descartada em SILÊNCIO, com dois efeitos: a barra de contexto passava a medir contra 200k em vez
 * de 1M (barra vermelha e rosto "cansado" com a sessão folgada) e, pior, o turno era realmente
 * spawnado com `--model opus` — o chat rodava com a janela CURTA que o operador tinha desligado.
 *
 * Agora a BASE é validada contra o vocabulário e a variante é preservada.
 */
function coerceChatSettings(raw: unknown, d: OrchestratorSettings["chat"]): { model: string; effort: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bruto = typeof o.model === "string" ? o.model.trim() : "";
  const { base, long } = splitModelVariant(bruto);
  const model = CHAT_MODELS.has(base) ? composeModel(base, long) : d?.model ?? "opus";
  const effort = typeof o.effort === "string" && CHAT_EFFORTS_SET.has(o.effort) ? o.effort : d?.effort ?? "high";
  return { model, effort };
}

/**
 * story-6h3ioj — o env-var de um token de autoridade MCP tem de se CHAMAR como um: prefixo
 * obrigatório `STORYMAP_MCP_TOKEN*`, nome em formato de env var.
 *
 * O que a allowlist IMPEDE: que quem escreve `settings.yaml` transforme uma variável ALHEIA já
 * presente no ambiente do serviço numa credencial MCP. Sem ela, `tokenEnv: HOSTNAME` (ou `USER`,
 * ou um `*_TOKEN` de outro serviço, ou qualquer valor que o atacante possa adivinhar/já conhecer)
 * virava a chave de um endpoint público que monta tools que rodam `claude
 * --dangerously-skip-permissions` nesta máquina. Zero custo de capacidade: o operador declara
 * quantos tokens quiser, só precisa nomear a env var pelo que ela é.
 */
const MCP_TOKEN_ENV_PREFIX = "STORYMAP_MCP_TOKEN";
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * A ÚNICA régua de "este nome pode ser o env-var de um token MCP" — usada tanto por quem LÊ a
 * declaração (`coerceMcpTokens`) quanto por quem ESCREVE no ambiente do serviço
 * (`normalizeScopedMcpTokenEnv`).
 *
 * Existir em UM lugar é o controle, não um detalhe de estilo: o nome vem de um arquivo de DADOS
 * (`settings.yaml`, `mcpTokens[].tokenEnv`) e a normalização faz `env[name] = …`. Com a validação só
 * no leitor, bastava um call-site novo chamar o normalizador direto para quem edita board-data
 * escolher QUAL variável do ambiente do processo vivo é sobrescrita — `PATH`, `NODE_OPTIONS`,
 * `LD_PRELOAD`, `GIT_SSH_COMMAND` —, e daí sai execução de código no serviço que roda como root, não
 * apenas uma credencial indevida. Validar no ESCRITOR fecha a escrita mesmo por um caminho que ainda
 * não existe.
 */
export function isMcpTokenEnvName(name: string): boolean {
  return ENV_VAR_NAME_RE.test(name) && name.startsWith(MCP_TOKEN_ENV_PREFIX);
}

/**
 * O nível concedido quando a entrada NÃO declara um (ou declara lixo): o MENOS privilegiado.
 *
 * `MCP_LEVELS` é ordenado do menos para o mais privilegiado, e `full` é o último — derivar daqui em
 * vez de escrever `"ro"` mantém a garantia se a lista crescer por baixo.
 */
const LEAST_PRIVILEGED_MCP_LEVEL: McpLevel = MCP_LEVELS[0];

/**
 * WS8 / story-6h3ioj — coerce a FORMA dos tokens de AUTORIDADE MCP ({tokenEnv, level}[]).
 *
 * Fail-closed por entrada, com recusa NOMEADA no log. Duas coisas que esta coerção IMPEDE, e que
 * antes ela permitia:
 *
 *  1. **Nível por omissão.** Uma entrada sem `level` (ou com `level: root`, ou `level: 1`) era
 *     descartada — mas o descarte não era o problema; o problema é o que a leitura no route.ts faz
 *     com o que sobra: `resolveActor` devolve o nível DECLARADO. Agora o nível é declarado por
 *     entrada e validado contra `MCP_LEVELS`; ausente/inválido cai no MENOS privilegiado, nunca em
 *     `full`. `full` continua concedível — mas só DITO por extenso.
 *  2. **Env var alheia** (ver `MCP_TOKEN_ENV_PREFIX`).
 *
 * **Só FORMA, de propósito — o VALOR do segredo é julgado em `mcpTokensBackedBySecret`.** Esta
 * função julga o que o `settings.yaml` DECLARA, e o resultado é memoizado por mtime do arquivo
 * (`readFileSettings`). Ler `process.env` aqui — como a primeira versão deste hardening fazia —
 * amarra uma decisão sobre o AMBIENTE ao mtime de um arquivo que não mudou: se a env do token
 * ainda não estava posta no primeiro `loadRunnerConfig()` (unidade systemd que sobe antes do
 * EnvironmentFile, secret manager que injeta tarde, `docker run` sem `--env-file`), a credencial
 * VÁLIDA que chegasse depois ficava invisível até alguém TOCAR o settings.yaml — um 404 do MCP sem
 * causa aparente, isto é, perda de capacidade do orquestrador autônomo. O piso de força não foi
 * afrouxado; ele só passou a ser aplicado no momento do USO.
 *
 * Exportada para os testes medirem a MESMA coerção que o load usa (idem `applyEnvOverrides`).
 */
export function coerceMcpTokens(raw: unknown): { tokenEnv: string; level: McpLevel }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { tokenEnv: string; level: McpLevel }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const tokenEnv = typeof (e as any).tokenEnv === "string" ? (e as any).tokenEnv.trim() : "";
    if (!tokenEnv) continue;
    if (!isMcpTokenEnvName(tokenEnv)) {
      console.warn(
        `[mcp] mcpTokens: entrada RECUSADA — tokenEnv "${tokenEnv}" não é um env-var de token MCP ` +
          `(exigido: prefixo ${MCP_TOKEN_ENV_PREFIX}). Uma variável de ambiente alheia não vira credencial MCP.`,
      );
      continue;
    }
    const declared = (e as any).level;
    const declaredOk = typeof declared === "string" && (MCP_LEVELS as readonly string[]).includes(declared);
    const level: McpLevel = declaredOk ? (declared as McpLevel) : LEAST_PRIVILEGED_MCP_LEVEL;
    if (!declaredOk) {
      console.warn(
        `[mcp] mcpTokens: ${tokenEnv} sem level válido (recebido: ${JSON.stringify(declared)}) — ` +
          `assumindo "${LEAST_PRIVILEGED_MCP_LEVEL}" (o menos privilegiado). Declare o level explicitamente.`,
      );
    }
    out.push({ tokenEnv, level });
  }
  return out.length ? out : undefined;
}

/**
 * Memo do log de recusa por entrada: `tokenEnv` → estado já avisado (`<fraqueza>:<comprimento>`).
 *
 * `mcpTokensBackedBySecret` roda a cada `loadRunnerConfig()` — ou seja, a cada requisição do
 * endpoint MCP. Sem este memo, uma env var ausente viraria uma linha de log por requisição
 * (journald inundado, e o aviso que importa afogado no meio). A chave inclui o ESTADO, então
 * trocar um segredo fraco por outro fraco avisa de novo; e uma entrada que fica forte é esquecida,
 * para uma regressão futura voltar a avisar. Nunca guarda o valor do segredo, só o comprimento —
 * a mesma informação que `maskSecret` já publica.
 */
const mcpSecretWarned = new Map<string, string>();

/**
 * story-6h3ioj (onda 2) — NORMALIZA a env de um tier ESCOPADO (`STORYMAP_MCP_TOKEN_ORCH`, `_RO`, ou
 * qualquer `mcpTokens[].tokenEnv`) e devolve o valor que vai autenticar.
 *
 * O que isto IMPEDE: que uma credencial VÁLIDA seja aprovada na config e devolva 404 em TODA
 * requisição, sem log. `secretWeakness` julga o valor TRIMADO (aprova) enquanto `isMcpTokenValid`
 * compara o valor CRU byte-a-byte com o que o agente apresenta — e o agente apresenta o trimado
 * (`orchestrator-run.ts`/`session-spawn.ts` montam a URL do MCP com `process.env.X?.trim()`). Um byte
 * de `\n` de um `Environment=` de systemd, de um `.env.local` editado à mão ou de um secret manager
 * fazia os dois lados divergirem: perda TOTAL e SILENCIOSA da porta do orquestrador autônomo. Era o
 * mesmo modo de falha já consertado para o token PRIMÁRIO — só faltava valer para os escopados.
 *
 * A regra NÃO é reimplementada aqui: `normalizeMcpTokenEnv` normaliza a chave FIXA do tier primário,
 * então passamos a ela uma VISTA de uma chave só e escrevemos o resultado de volta na env real. Duas
 * cópias da regra seriam duas verdades, e a que apodrece é sempre a do lado que ninguém testa.
 * (Parametrizar a chave em token-bootstrap dispensaria a vista — é a simplificação natural, e mora
 * naquele arquivo.)
 *
 * ⚠️ ESTA FUNÇÃO ESCREVE NO AMBIENTE DO PROCESSO VIVO (`env[name] = …`) com um `name` que nasce em
 * board-data. Por isso o nome é validado AQUI, no escritor, contra a mesma régua do leitor
 * ({@link isMcpTokenEnvName}) — o que a validação IMPEDE está no doc-comment dela. Nome fora da forma
 * devolve `undefined` sem tocar a env: a entrada não autentica, e nada do ambiente é reescrito.
 */
export function normalizeScopedMcpTokenEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isMcpTokenEnvName(name)) {
    // Aviso memoizado pela MESMA trava de ruído das outras recusas por entrada: este caminho roda a cada
    // `loadRunnerConfig()`, isto é, a cada requisição do endpoint MCP. A chave do memo tem NAMESPACE
    // próprio (sufixo `#forma`, que nenhum nome válido de env var pode conter) porque a recusa por FORMA
    // DO NOME e a recusa por segredo fraco convivem para o mesmo `tokenEnv`: compartilhar a chave faria
    // as duas se sobrescreverem em alternância a cada requisição — o memo viraria o próprio flood que
    // ele existe para evitar.
    const memo = `${name}#forma`;
    if (mcpSecretWarned.get(memo) !== "nome-invalido") {
      mcpSecretWarned.set(memo, "nome-invalido");
      console.warn(
        `[mcp] mcpTokens: tokenEnv "${name}" RECUSADO na normalização — não é um env-var de token MCP ` +
          `(exigido: prefixo ${MCP_TOKEN_ENV_PREFIX}). Nenhuma variável do ambiente do serviço foi escrita.`,
      );
    }
    return undefined;
  }
  const bruto = env[name];
  if (bruto == null) return undefined;
  // O `as` é por causa da augmentação do Next (que torna `NODE_ENV` obrigatório em `ProcessEnv`): esta
  // vista existe justamente para carregar UMA chave, e nada em `normalizeMcpTokenEnv` lê outra.
  const vista = { [MCP_TOKEN_ENV]: bruto } as unknown as NodeJS.ProcessEnv;
  normalizeMcpTokenEnv(vista);
  const valor = vista[MCP_TOKEN_ENV];
  // Escreve de volta SÓ quando mudou: a env do serviço é estado global, e um write por requisição
  // (mcpTokensBackedBySecret roda a cada `loadRunnerConfig()`) seria churn sem verdade nova.
  if (valor !== undefined && valor !== bruto) env[name] = valor;
  return valor;
}

/**
 * story-6h3ioj — das entradas DECLARADAS (`coerceMcpTokens`), as que HOJE são seguradas por um
 * segredo forte de verdade. Roda na camada ENV, portanto sem cache: é o `process.env` deste
 * instante que decide.
 *
 * O que ela IMPEDE: que uma declaração aponte para uma env var vazia/ausente (credencial fantasma,
 * prometendo na config um nível que nada segura e escondendo o erro de deploy atrás de um 404
 * silencioso) ou para um valor adivinhável (curto/degenerado) e ainda assim conceda autoridade MCP.
 * É o MESMO piso que `isMcpTokenValid` aplica por requisição no endpoint (`secretWeakness`) —
 * defesa em profundidade, não substituição: aqui a entrada nem chega a existir como credencial.
 *
 * O que ela NÃO faz: recusar para sempre. Uma env var que chegue depois do primeiro load é
 * reconhecida na chamada seguinte, sem tocar o settings.yaml.
 *
 * É TAMBÉM onde a env de cada tier escopado é NORMALIZADA (ver `normalizeScopedMcpTokenEnv`): aqui
 * porque este é o único ponto por onde toda credencial escopada passa antes de a route.ts comparar, e
 * porque esta camada não é memoizada — um valor sujo consertado no ambiente vale na leitura seguinte.
 */
export function mcpTokensBackedBySecret(
  declared: { tokenEnv: string; level: McpLevel }[] | undefined,
): { tokenEnv: string; level: McpLevel }[] | undefined {
  if (!declared?.length) return undefined;
  const out: { tokenEnv: string; level: McpLevel }[] = [];
  for (const t of declared) {
    const valor = normalizeScopedMcpTokenEnv(t.tokenEnv);
    const weak = secretWeakness(valor);
    if (weak) {
      const estado = `${weak}:${(valor ?? "").trim().length}`;
      if (mcpSecretWarned.get(t.tokenEnv) !== estado) {
        mcpSecretWarned.set(t.tokenEnv, estado);
        console.warn(
          `[mcp] mcpTokens: entrada ${t.tokenEnv} RECUSADA — o segredo ${maskSecret(valor)} ` +
            `${weaknessAdvice(weak)}`,
        );
      }
      continue;
    }
    mcpSecretWarned.delete(t.tokenEnv);
    out.push({ ...t });
  }
  return out.length ? out : undefined;
}

/**
 * A FORMA de um alvo de deploy. É a MESMA peneira que `mcp/instruction-surface.test.ts` aplica às
 * constantes que podem aparecer na superfície de instrução — replicada aqui de propósito, porque agora
 * a origem do valor é DADO editável e não mais uma constante de código revisada.
 *
 * Um alvo atravessa três fronteiras onde a forma importa mais que o conteúdo:
 *   1. a mensagem de erro de uma tool MCP, que o modelo do outro lado lê com autoridade de prompt;
 *   2. o argv de `just <receita> <alvo>`, montado sem shell;
 *   3. o nome de arquivo do log (`mcp-deploy-<alvo>.log`), sob a raiz do alvo.
 * Um slug atravessa as três sem significar nada em nenhuma. Uma frase com espaço e pontuação vira
 * instrução na primeira e caminho na terceira.
 */
const DEPLOY_TARGET_SLUG = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

/** Um caminho de manifesto seguro: relativo, sem subir de diretório, sem raiz absoluta. */
const isSafeRelPath = (p: string): boolean =>
  p.length > 0 &&
  p.length <= 200 &&
  !p.startsWith("/") &&
  !/^[A-Za-z]:/.test(p) &&
  !p.split(/[\\/]/).includes("..");

/**
 * The deployment-wide `deploy:` block.
 *
 *   `canaryCommand`  — the DEFAULT publication-fidelity canary for boards that declare none of their own.
 *   `targets`        — the app names this deployment publishes via the legacy diff-aware path. THEY USED
 *                      TO BE A LITERAL IN THE ENGINE'S SOURCE, which put one deployment's product catalog
 *                      in the PUBLISHED MCP contract (see RunnerSettings.deploy in types.ts).
 *   `composedFace`   — the multi-app merged surface, when this deployment has one.
 *
 * Strict on values (a blank string is no command, not an empty command) so an accidental
 * `canaryCommand: ""` disables the check LOUDLY (absent) rather than spawning an empty shell.
 *
 * ⚠️ O QUE MUDA COM `targets` E POR QUE ESTE COERCER PENEIRA EM VEZ DE REPROVAR. Enquanto a lista era
 * código, a revisão de PR era a peneira. Agora ela é dado que qualquer um com acesso ao settings.yaml
 * escreve, e o valor chega — por caminhos que já existem — à superfície de instrução do MCP e a um argv.
 * Um item fora da forma é DESCARTADO com aviso, e não faz o carregamento inteiro falhar: settings.yaml
 * é o arquivo que segura o serviço de pé, e um typo num alvo não pode derrubar autorun, gate e tokens
 * junto. O aviso é a parte que não pode faltar — descarte silencioso é como um alvo some do contrato
 * sem ninguém entender por quê (e a mensagem que o operador veria apontaria para a causa errada).
 */
function coerceDeploySettings(raw: unknown): RunnerSettings["deploy"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: NonNullable<RunnerSettings["deploy"]> = {};

  const cmd = r.canaryCommand;
  if (typeof cmd === "string" && cmd.trim()) out.canaryCommand = cmd.trim();

  if (Array.isArray(r.targets)) {
    const aceitos: string[] = [];
    const recusados: unknown[] = [];
    for (const t of r.targets) {
      if (typeof t === "string" && DEPLOY_TARGET_SLUG.test(t)) aceitos.push(t);
      else recusados.push(t);
    }
    if (recusados.length) {
      console.warn(
        `[storymap] settings deploy.targets: ${recusados.length} alvo(s) DESCARTADO(s) por forma inválida ` +
          `(exigido ${DEPLOY_TARGET_SLUG}): ${recusados.map((t) => JSON.stringify(t)).join(", ")}. ` +
          `Um alvo atravessa a superfície de instrução do MCP e um argv — só slug atravessa sem significar nada.`,
      );
    }
    if (aceitos.length) out.targets = aceitos;
  }

  const face = r.composedFace;
  if (face && typeof face === "object" && !Array.isArray(face)) {
    const f = face as Record<string, unknown>;
    const target = typeof f.target === "string" ? f.target.trim() : "";
    const recipe = typeof f.recipe === "string" ? f.recipe.trim() : "";
    const manifest = typeof f.manifest === "string" ? f.manifest.trim() : "";
    // Os três são obrigatórios JUNTOS: uma face meio declarada não tem como ser publicada nem medida, e
    // aceitá-la pela metade produziria o pior estado — o motor achando que HÁ face e não sabendo publicá-la.
    if (DEPLOY_TARGET_SLUG.test(target) && DEPLOY_TARGET_SLUG.test(recipe) && isSafeRelPath(manifest)) {
      out.composedFace = { target, recipe, manifest };
    } else {
      console.warn(
        "[storymap] settings deploy.composedFace: descritor DESCARTADO — exige `target` e `recipe` em forma de " +
          `slug e \`manifest\` como caminho relativo sem "..". Recebido: ${JSON.stringify(face)}. ` +
          "Sem face composta declarada, um release que toque a face NÃO encadeia a publicação dela.",
      );
    }
  }

  return Object.keys(out).length ? out : undefined;
}

/** Apply process.env overrides on top of file/default settings (ENV wins). Exported for tests. */
export function applyEnvOverrides(s: RunnerSettings): RunnerSettings {
  const env = process.env;
  const next: RunnerSettings = {
    ...s,
    autorun: {
      ...s.autorun,
      timeouts: { ...s.autorun.timeouts },
      mergeGate: s.autorun.mergeGate ? { ...s.autorun.mergeGate } : undefined,
      staging: s.autorun.staging
        ? {
            ...s.autorun.staging,
            codePrefixes: [...s.autorun.staging.codePrefixes],
            // Deep-clone when PRESENT, and stay absent when absent: an env override may only move
            // `enabled`. Materializing `dataDerived: []` here would have this layer inventing config the
            // file never declared — invisible today (empty ≡ absent) but exactly the kind of silent
            // normalization that later reads as an intentional declaration.
            ...(s.autorun.staging.dataDerived
              ? { dataDerived: s.autorun.staging.dataDerived.map((d) => ({ ...d, sources: [...d.sources] })) }
              : {}),
          }
        : undefined,
      scheduler: {
        lanes: {
          light: { ...s.autorun.scheduler.lanes.light },
          heavy: { ...s.autorun.scheduler.lanes.heavy },
        },
        thresholds: { ...s.autorun.scheduler.thresholds },
      },
      sessions: { ...s.autorun.sessions },
    },
    columnDefaults: { ...s.columnDefaults },
    deploy: s.deploy ? { ...s.deploy } : undefined,
    orchestrator: s.orchestrator ? { ...s.orchestrator } : undefined,
    // story-6h3ioj — a força do SEGREDO é julgada AQUI, não na coerção do arquivo: esta camada não é
    // memoizada (roda a cada loadRunnerConfig(), logo a cada requisição do endpoint MCP), então uma env
    // var que chegue depois do primeiro load passa a autenticar sem precisar tocar o settings.yaml.
    mcpTokens: mcpTokensBackedBySecret(s.mcpTokens),
  };
  if (env.USM_AUTORUN === "0") next.autorun.enabled = false;
  if (env.USM_AUTORUN_RESUME_ON_BOOT === "0") next.autorun.resumeOnBoot = false;
  // WS8 — the copiloto kill-switch: STORYMAP_ORCH_ENABLED=0 forces it off (mirrors USM_AUTORUN=0).
  if (env.STORYMAP_ORCH_ENABLED === "0" && next.orchestrator) next.orchestrator.enabled = false;
  // The fidelity canary is a deployment concern, so it gets the same ENV escape hatch as the rest:
  // set it empty to DISABLE the check on a box that cannot reach the published surface.
  if (typeof env.STORYMAP_DEPLOY_CANARY_COMMAND === "string") {
    next.deploy = { ...next.deploy, canaryCommand: env.STORYMAP_DEPLOY_CANARY_COMMAND };
  }
  if (env.STORYMAP_ORCH_ENABLED === "1" && next.orchestrator) next.orchestrator.enabled = true;
  const max = asPosInt(env.USM_AUTORUN_MAX);
  if (max) next.autorun.maxConcurrent = max;
  // ADR-063 (4b): the loop-guard cap. 0 is a VALID value (disable), so — like the RAM/load thresholds —
  // an EMPTY/whitespace var must read as "unset" (keep the file value), NOT coerce to 0 via Number("").
  if (isSetEnv(env.USM_AUTORUN_NO_PROGRESS_MAX)) {
    const noProgress = asNonNegInt(env.USM_AUTORUN_NO_PROGRESS_MAX);
    if (noProgress !== undefined) next.autorun.noProgressMax = noProgress;
  }
  // ADR-063 (4a): the opt-in per-card $ backstop. A positive float enables it; unset/blank/≤0/garbage
  // leaves the file value untouched (an empty/0 value is NOT a real budget → never silently freezes a card).
  const cardBudget = asPosNum(env.USM_AUTORUN_CARD_BUDGET_USD);
  if (cardBudget !== undefined) next.autorun.cardBudgetUSD = cardBudget;
  const fast = asPosInt(env.USM_AUTORUN_TIMEOUT_MS);
  if (fast) next.autorun.timeouts.fastMs = fast;
  const doMs = asPosInt(env.USM_AUTORUN_TIMEOUT_DO_MS);
  if (doMs) next.autorun.timeouts.doMs = doMs;
  const universal = asPosInt(env.USM_AUTORUN_TIMEOUT_UNIVERSAL_MS);
  if (universal) next.autorun.timeouts.universalMs = universal;
  if (env.USM_AUTORUN_CLAUDE_BIN) next.autorun.claudeBin = env.USM_AUTORUN_CLAUDE_BIN;
  if (env.USM_AUTORUN_EXTRA_ARGS != null) next.autorun.extraArgs = asStringArray(env.USM_AUTORUN_EXTRA_ARGS);
  if (env.USM_AUTORUN_WORKTREE === "1") next.autorun.worktreeIsolation = true;
  else if (env.USM_AUTORUN_WORKTREE === "0") next.autorun.worktreeIsolation = false;
  // Integration gate (story-1k7els): a 1/0 master switch over the file value. Ensure the object exists
  // (an old file/default without the section) before flipping it, defaulting the rest of the fields.
  if (env.USM_AUTORUN_MERGE_GATE === "1" || env.USM_AUTORUN_MERGE_GATE === "0") {
    // O fallback vem dos DEFAULTS canônicos, nunca de um literal local: o literal antigo já divergiu
    // deles em duas chaves (retryOnNewFailure, typecheck) — um mergeGate montado por esta via nasceria
    // sem elas e desligaria capacidades default-ON em silêncio.
    const base = next.autorun.mergeGate ?? { ...DEFAULT_RUNNER_SETTINGS.autorun.mergeGate! };
    next.autorun.mergeGate = { ...base, enabled: env.USM_AUTORUN_MERGE_GATE === "1" };
  }
  // Staged release (Fase 4a): a 1/0 master switch over the file value. Ensure the object exists (an old
  // file/default without the section) before flipping it, defaulting branch + codePrefixes. Boot-fixed —
  // the queue reads this once at construction, so this override takes effect on the next service start.
  if (env.USM_AUTORUN_STAGING === "1" || env.USM_AUTORUN_STAGING === "0") {
    const base = next.autorun.staging ?? {
      enabled: false,
      branch: STAGING_BRANCH,
      codePrefixes: [...STAGING_CODE_PREFIXES],
    };
    next.autorun.staging = { ...base, enabled: env.USM_AUTORUN_STAGING === "1" };
  }
  // (2026-08-05) O master switch `USM_AUTORUN_SANDBOX` foi REMOVIDO junto com a camada fail-open que
  // ele governava (`runner/sandbox.ts`), quando o F0 pousou — os dois contratos eram opostos, e o F0
  // RECUSA quando não consegue conter. O `if` de corpo vazio que sobrou aqui ficou 15 dias prometendo
  // uma alavanca inexistente, e a chave `autorun.sandbox.enabled` viajava no settings.yaml publicado
  // dizendo o mesmo. `config-dead-knobs.test.ts` guarda a classe: interruptor publicado sem leitor.
  // scheduler lane caps (positive int) + thresholds (non-negative real, 0 allowed)
  const laneLight = asPosInt(env.USM_AUTORUN_LANE_LIGHT_MAX);
  if (laneLight) next.autorun.scheduler.lanes.light.maxConcurrent = laneLight;
  const laneHeavy = asPosInt(env.USM_AUTORUN_LANE_HEAVY_MAX);
  if (laneHeavy) next.autorun.scheduler.lanes.heavy.maxConcurrent = laneHeavy;
  // SM-4 governor: per-lane resource quotas (memoryMax string / cpuQuota positive int). Each is an
  // operational override of the systemd-run scope limits; an unset/blank/invalid value leaves the
  // file/default untouched (no quota stays no quota — never silently disables enforcement to 0).
  const lightMem = asNonEmptyString(env.USM_AUTORUN_LANE_LIGHT_MEMORY_MAX);
  if (lightMem) next.autorun.scheduler.lanes.light.memoryMax = lightMem;
  const lightCpu = asPosInt(env.USM_AUTORUN_LANE_LIGHT_CPU_QUOTA);
  if (lightCpu) next.autorun.scheduler.lanes.light.cpuQuota = lightCpu;
  const heavyMem = asNonEmptyString(env.USM_AUTORUN_LANE_HEAVY_MEMORY_MAX);
  if (heavyMem) next.autorun.scheduler.lanes.heavy.memoryMax = heavyMem;
  const heavyCpu = asPosInt(env.USM_AUTORUN_LANE_HEAVY_CPU_QUOTA);
  if (heavyCpu) next.autorun.scheduler.lanes.heavy.cpuQuota = heavyCpu;
  // 0 is a VALID threshold (ramFreeMb: 0 = never block on RAM) so we can't use the truthy guard the
  // lane caps use — but an EMPTY/whitespace env value must read as "unset" (fall through to the file),
  // NOT coerce to 0 via Number(""), which would silently disable RAM gating / freeze the heavy lane.
  if (isSetEnv(env.USM_AUTORUN_RAM_FREE_MB)) {
    const ramFree = asNonNegNum(env.USM_AUTORUN_RAM_FREE_MB);
    if (ramFree !== undefined) next.autorun.scheduler.thresholds.ramFreeMb = ramFree;
  }
  if (isSetEnv(env.USM_AUTORUN_LOAD_AVG_1)) {
    const loadAvg = asNonNegNum(env.USM_AUTORUN_LOAD_AVG_1);
    if (loadAvg !== undefined) next.autorun.scheduler.thresholds.loadAvg1 = loadAvg;
  }
  // Parity with the file knob: the portable per-core ceiling is overridable too, so an operator can retune
  // a host without editing settings.yaml. Positive-only (see the file coercion for why 0 is rejected).
  if (isSetEnv(env.USM_AUTORUN_LOAD_AVG_1_PER_CORE)) {
    const perCore = asPosNum(env.USM_AUTORUN_LOAD_AVG_1_PER_CORE);
    if (perCore !== undefined) next.autorun.scheduler.thresholds.loadAvg1PerCore = perCore;
  }
  // WS-1.5 — session worktree cap (positive int; same truthy guard as the lane caps: 0 is not a meaningful
  // cap here, and an invalid value must leave the file/default in force rather than lock sessions out).
  const sessMax = asPosInt(env.USM_AUTORUN_SESSIONS_MAX_WORKTREES);
  if (sessMax) next.autorun.sessions.maxWorktrees = sessMax;
  return next;
}

let cache: { mtimeMs: number; settings: RunnerSettings } | null = null;

/** Read settings.yaml from disk (no ENV), coerced. Memoized by mtime. */
export function readFileSettings(): RunnerSettings {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(settingsPath()).mtimeMs;
  } catch {
    cache = null;
    return DEFAULT_RUNNER_SETTINGS; // no file → pure defaults
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.settings;
  try {
    const raw = readFileSync(settingsPath(), "utf8");
    const settings = coerceRunnerSettings(yaml.load(raw));
    cache = { mtimeMs, settings };
    return settings;
  } catch {
    return DEFAULT_RUNNER_SETTINGS;
  }
}

/** The EFFECTIVE runner config the channel runs with (defaults < file < ENV). */
export function loadRunnerConfig(): RunnerSettings {
  return applyEnvOverrides(readFileSettings());
}

/** Persist edited settings to storymap/settings.yaml (o editor COMPLETO da página de config).
 *  ⚠️ REESCREVE o arquivo por `yaml.dump` — os COMENTÁRIOS se perdem. Para mexer em algumas chaves use
 *  {@link writeOrchestratorSettings} (escrita cirúrgica); este caminho é só para quem edita o todo. */
export async function writeRunnerSettings(settings: RunnerSettings): Promise<void> {
  const out = yaml.dump(settings, { lineWidth: 120, noRefs: true });
  await fsp.writeFile(settingsPath(), out, "utf8");
  cache = null; // force reload on next read
}

/**
 * Os knobs do bloco `orchestrator` que as superfícies do chat editam (a engrenagem e o `/model`) → o
 * CAMINHO de cada um no YAML. Esta tabela é o contrato: knob novo = UMA entrada aqui + o campo no patch.
 * O nome de fora é achatado de propósito (`maxTicksPerDay`, não `budget.maxTicksPerDay`) — quem chama
 * pensa em knob, não em árvore.
 */
const ORCHESTRATOR_PATHS = {
  enabled: ["orchestrator", "enabled"],
  tickMinutes: ["orchestrator", "tickMinutes"],
  maxTicksPerDay: ["orchestrator", "budget", "maxTicksPerDay"],
  maxCostPerDay: ["orchestrator", "budget", "maxCostPerDay"],
  wakeEnabled: ["orchestrator", "wake", "enabled"],
  model: ["orchestrator", "chat", "model"],
  effort: ["orchestrator", "chat", "effort"],
} as const satisfies Record<string, readonly string[]>;

/** O que se pode gravar cirurgicamente. Campo AUSENTE = não tocar (é a razão de existir deste caminho). */
export type OrchestratorSettingsPatch = Partial<{
  enabled: boolean;
  tickMinutes: number;
  maxTicksPerDay: number;
  maxCostPerDay: number;
  wakeEnabled: boolean;
  model: string;
  effort: string;
}>;

/**
 * Grava SÓ os knobs informados no settings.yaml, preservando o arquivo (comentários, ordem, chaves alheias).
 *
 * Por que não `writeRunnerSettings`: ele faz `yaml.dump` do objeto e o js-yaml não carrega comentários —
 * medido, uma troca de modelo apagou 60 linhas de documentação operacional. E há um segundo ganho, mais
 * silencioso: um patch PARCIAL não tem como clobbar o que ele não conhece. O caminho antigo obrigava o
 * cliente a carregar o RunnerSettings inteiro e devolvê-lo por spread — se um campo novo aparecesse no
 * arquivo e o cliente estivesse com uma cópia velha, salvar o popover o apagaria. Aqui isso é impossível
 * por construção. A edição textual vive em settings-yaml.ts (pura, testada).
 */
export async function writeOrchestratorSettings(patch: OrchestratorSettingsPatch): Promise<void> {
  const patches = (Object.keys(ORCHESTRATOR_PATHS) as (keyof typeof ORCHESTRATOR_PATHS)[])
    .filter((k) => patch[k] !== undefined)
    .map((k) => ({ path: ORCHESTRATOR_PATHS[k], value: patch[k]! }));
  if (!patches.length) return;
  const path = settingsPath();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    /* arquivo ainda não existe — o patch cria um settings mínimo e válido */
  }
  await fsp.writeFile(path, patchYamlScalars(text, patches), "utf8");
  cache = null; // force reload on next read
}

/** Which USM_* env overrides are currently active (so the UI can flag them). */
export function activeEnvOverrides(): string[] {
  const e = process.env;
  return [
    "USM_AUTORUN",
    "USM_AUTORUN_RESUME_ON_BOOT",
    "USM_AUTORUN_MAX",
    "USM_AUTORUN_NO_PROGRESS_MAX",
    "USM_AUTORUN_CARD_BUDGET_USD",
    "USM_AUTORUN_TIMEOUT_MS",
    "USM_AUTORUN_TIMEOUT_DO_MS",
    "USM_AUTORUN_TIMEOUT_UNIVERSAL_MS",
    "USM_AUTORUN_CLAUDE_BIN",
    "USM_AUTORUN_EXTRA_ARGS",
    "USM_AUTORUN_WORKTREE",
    "USM_AUTORUN_MERGE_GATE",
    "USM_AUTORUN_STAGING",
    "USM_AUTORUN_LANE_LIGHT_MAX",
    "USM_AUTORUN_LANE_HEAVY_MAX",
    "USM_AUTORUN_LANE_LIGHT_MEMORY_MAX",
    "USM_AUTORUN_LANE_LIGHT_CPU_QUOTA",
    "USM_AUTORUN_LANE_HEAVY_MEMORY_MAX",
    "USM_AUTORUN_LANE_HEAVY_CPU_QUOTA",
    "USM_AUTORUN_RAM_FREE_MB",
    "USM_AUTORUN_LOAD_AVG_1",
    "USM_AUTORUN_LOAD_AVG_1_PER_CORE",
  ].filter((k) => e[k] != null && e[k] !== "");
}

/** Per-column CLI flags for a spawn (model/effort/max-turns), policy-resolved. */
export function resolveColumnArgs(def: StatusDef, config: RunnerSettings): string[] {
  return columnFlags(config.economyMode ? applyEconomyCap(def) : def, config.columnDefaults);
}

/**
 * Per-CARD CLI flags for a spawn — the complexity-aware sibling of {@link resolveColumnArgs}
 * (story-rotear-model-effort-por-complexidade). Lifts the card's complexity signals, derives the
 * (model, effort) within the column pair as DEFAULT + TETO (see {@link deriveCardModelEffort}), and
 * the per-card `--max-turns` within the column's maxTurns as the CEILING (story-9s52tu HALF A, see
 * {@link deriveCardMaxTurns}), emitting the same flag shape as a column resolve. Only `--model`/
 * `--effort`/`--max-turns` shift per card; the per-column MCP config is untouched. `resolveColumnArgs`
 * stays the path for the card-less callers (redrive, the existing tests).
 */
export function cardComplexitySignals(card: Card): CardComplexitySignals {
  return {
    storyType: card.storyType,
    riceEffort: card.rice?.effort,
    taskCount: card.tasks?.length ?? 0,
    severity: card.severity ?? card.bugReport?.severity,
  };
}

/**
 * The (model, effort) a card routes to in a given column — {@link resolveCardArgs} minus the flag encoding
 * and minus `--max-turns`. Extracted so a caller that spawns something OTHER than a headless run can route
 * through the SAME door instead of re-deriving it (WS-6.2: an agent session on a card gets the card's own
 * rule — model-routing.ts's canonical table calls this "door 3", and a fourth door is forbidden). `maxTurns`
 * stays out on purpose: it is a headless run's turn budget, meaningless for a session a human can talk to.
 */
export function resolveCardRoute(
  card: Card,
  def: StatusDef,
  config: RunnerSettings,
): { model: ModelTier | undefined; effort: EffortLevel | undefined } {
  const signals = cardComplexitySignals(card);
  // The EFFECTIVE column pair (def field, then the global default) is both the default and the ceiling.
  const columnModel = def.model ?? config.columnDefaults.model;
  const columnEffort = def.effort ?? config.columnDefaults.effort;
  // WS4 — the card's per-instance route caps (from a named RouteProfile via harness-enrich) tighten the ceiling
  // teto-sob-teto: an `express` card pays even an opus column in sonnet without skipping the step.
  return deriveCardModelEffort(signals, columnModel, columnEffort, card.routing?.modelCap, card.routing?.effortCap);
}

export function resolveCardArgs(card: Card, def: StatusDef, config: RunnerSettings): string[] {
  const signals = cardComplexitySignals(card);
  const { model, effort } = resolveCardRoute(card, def, config);
  // story-9s52tu HALF A: the column's maxTurns (def field, then the global default) is the CEILING;
  // scale a per-card effective value within [lean baseline, ceiling] by the card's size so a small
  // card gets a lean budget and a big one (w9n03r) reaches the ceiling (~220). An undefined ceiling
  // (no per-column maxTurns) stays undefined → no flag, CLI default (identical to before).
  const columnMaxTurns = def.maxTurns ?? config.columnDefaults.maxTurns;
  const maxTurns = deriveCardMaxTurns(signals, columnMaxTurns);
  // Substitute model/effort + the scaled maxTurns; mcpConfig rides the column unchanged. The scaled
  // maxTurns is already ≤ the ceiling, so columnFlags' own columnDefaults fallback is a no-op here
  // (the resolved def carries the per-card value or undefined when the column has no ceiling).
  const resolved = {
    ...def,
    model: model ?? def.model,
    effort: effort ?? def.effort,
    maxTurns: maxTurns ?? def.maxTurns,
  };
  return columnFlags(config.economyMode ? applyEconomyCap(resolved) : resolved, config.columnDefaults);
}

/**
 * story-9s52tu HALF B (HIGH #2): hard cap on how many times a SINGLE card may be auto-resumed after a
 * `--max-turns` settle before the run ESCALATES to a genuine failure instead of looping forever. The
 * counter is MONOTONIC across resume cycles (carried on the journal entry, surviving recordStart like
 * driveCount) — it is NOT reset each cycle, so a chronically-stuck card (one that exhausts its turn
 * budget every resume without making progress) hits this cap and surfaces to the operator (force-deleted
 * worktree + an "error" finish + an operator finding) rather than silently churning resumes. Override
 * via USM_AUTORUN_MAXTURNS_RESUME_MAX (default 2; 0 disables auto-resume entirely → the first max-turns
 * settle escalates straight to a failure). This is the busy-loop bound for the in-process resume.
 */
export function maxTurnsResumeMax(): number {
  const n = Number(process.env.USM_AUTORUN_MAXTURNS_RESUME_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}
