// ── OS ALIASES DE ENV — a ponte entre os nomes LEGADOS (`STORYMAP_*`, `USM_*`) e os novos (`AGILEHARNESS_*`) ──
//
// POR QUE ISTO EXISTE. A ferramenta nasceu como "StoryMap" e o seu contrato de ambiente carregou o nome:
// 57 variáveis `STORYMAP_*` e 50 `USM_*` contra 27 já batizadas `AGILEHARNESS_*`. Renomear variável de
// ambiente é renomear um CONTRATO EXTERNO — quem as escreve é a unit systemd, o `.env.local`, o
// `EnvironmentFile=` de um tier MCP, o hook de um repositório-alvo que lê o marcador de run. Nada disso
// muda quando o código muda. A regra do plano (doc 10 do umbrella, Fase 4) é a única honesta para um
// contrato assim: **uma versão inteira de convivência**, em que o código lê o nome NOVO, o nome VELHO
// continua funcionando, e o operador é avisado UMA vez nomeando o novo. Só depois se remove.
//
// A REGRA É MECÂNICA, e isso é o controle: `STORYMAP_<x>` e `USM_<x>` viram `AGILEHARNESS_<x>` sem
// exceção. Medido antes de adotar: nenhum sufixo `<x>` existe nas duas famílias ao mesmo tempo, e nenhum
// colide com um nome que já nasceu `AGILEHARNESS_`. Uma tabela à mão, nome por nome, seria o lugar onde
// a próxima variável entra sem alias — a regra por prefixo não tem esse buraco no sentido legado→novo.
// No sentido novo→legado a regra precisa saber a FAMÍLIA (`AGILEHARNESS_TARGET` era `STORYMAP_`, mas
// `AGILEHARNESS_AUTORUN_MAX` era `USM_`), e é para isso que existe o catálogo abaixo — mantido honesto
// por `env-aliases.test.ts`, que enumera toda variável que o código lê e reprova a que não estiver aqui.
//
// ONDE A PONTE É APLICADA (e por que em DOIS lugares):
//   1. no boot do serviço (`server/main.ts`, logo depois do `loadEnvConfig`): o `process.env` passa a ter
//      as duas grafias de tudo o que o operador setou — o código lê a nova; um consumidor que ainda leia
//      a velha (um script, um hook do alvo) continua enxergando-a;
//   2. no chokepoint de spawn (`runner/spawn-env.ts`): o env de um FILHO também sai com as duas grafias,
//      porque o que a ferramenta EMITE para o agente (`AGILEHARNESS_AUTORUN_RUN_ID`, o marcador de run
//      sancionado) é lido por hooks de repositórios que não são nossos — o umbrella lê `STORYMAP_AUTORUN_RUN_ID`.
//
// PURO de propósito: recebe o env, nunca lê `process.env`. A suíte exercita as duas direções, o conflito
// e a idempotência sem tocar no ambiente do processo.

export const PREFIXO_NOVO = "AGILEHARNESS_";

/** As duas famílias legadas. O nome legado é sempre `${familia}_${sufixo}`. */
export type FamiliaLegada = "STORYMAP" | "USM";
export const FAMILIAS_LEGADAS: readonly FamiliaLegada[] = ["STORYMAP", "USM"] as const;

/**
 * O CATÁLOGO: para cada sufixo que o código lê (ou emite) e que já existiu com nome legado, a família
 * de onde veio. É o que permite o sentido novo→legado. Sufixo ausente daqui é NATIVO (nasceu
 * `AGILEHARNESS_`) ou é erro — e o teste decide qual, porque exige que TODO nome lido esteja em um dos
 * dois conjuntos, e que nenhuma entrada daqui seja morta (não lida por ninguém).
 */
export const SUFIXOS_LEGADOS: Readonly<Record<string, FamiliaLegada>> = {
  // ── o motor de autorun (família USM, a mais antiga) ──
  AUTORUN: "USM",
  AUTORUN_CARD_BUDGET_USD: "USM",
  AUTORUN_CLAUDE_BIN: "USM",
  AUTORUN_EGRESS_ALLOW: "USM",
  AUTORUN_EXTRA_ARGS: "USM",
  AUTORUN_LANE_HEAVY_CPU_QUOTA: "USM",
  AUTORUN_LANE_HEAVY_MAX: "USM",
  AUTORUN_LANE_HEAVY_MEMORY_MAX: "USM",
  AUTORUN_LANE_LIGHT_CPU_QUOTA: "USM",
  AUTORUN_LANE_LIGHT_MAX: "USM",
  AUTORUN_LANE_LIGHT_MEMORY_MAX: "USM",
  AUTORUN_LOAD_AVG_1: "USM",
  AUTORUN_LOAD_AVG_1_PER_CORE: "USM",
  AUTORUN_MAX: "USM",
  AUTORUN_MAXTURNS_RESUME_MAX: "USM",
  AUTORUN_MERGE_GATE: "USM",
  AUTORUN_NO_PROGRESS_MAX: "USM",
  AUTORUN_NO_STREAM: "USM",
  AUTORUN_OPEN_TERMINAL: "USM",
  AUTORUN_RAM_FREE_MB: "USM",
  AUTORUN_RATE_MAX: "USM",
  AUTORUN_RATE_WINDOW_MS: "USM",
  AUTORUN_RECOVERY_SWEEP_MS: "USM",
  AUTORUN_RESUME_FALLBACK_MAX: "USM",
  AUTORUN_RESUME_ON_BOOT: "USM",
  AUTORUN_SANDBOX: "USM",
  AUTORUN_SESSIONS_MAX_WORKTREES: "USM",
  AUTORUN_STAGING: "USM",
  AUTORUN_SYSTEM_PROMPT_FILE: "USM",
  AUTORUN_TIER_CAP: "USM",
  AUTORUN_TIMEOUT_DO_MS: "USM",
  AUTORUN_TIMEOUT_MS: "USM",
  AUTORUN_TIMEOUT_UNIVERSAL_MS: "USM",
  AUTORUN_WORKTREE: "USM",
  BRANCH_GC_ENABLED: "USM",
  COPILOT_TIMEOUT_MS: "USM",
  EGRESS_ALLOW: "USM",
  FLEET_RECONCILE_MS: "USM",
  PROBE_TTL_FAIL_MS: "USM",
  PROBE_TTL_OK_MS: "USM",
  PUBLISH_EMBARGO_TTL_MS: "USM",
  SESSION_GC_GRACE_MS: "USM",
  SMART_CAPTURE_EFFORT: "USM",
  SMART_CAPTURE_MODEL: "USM",
  SMART_CAPTURE_TIMEOUT_MS: "USM",
  // ── os MARCADORES de run que a ferramenta EMITE para o filho (família STORYMAP, apesar do `AUTORUN_`) ──
  // É por eles que um hook do repositório-alvo distingue um run sancionado de uma edição manual.
  AUTORUN_RUN_ID: "STORYMAP",
  AUTORUN_TRIGGER: "STORYMAP",
  // ── o serviço, os canais e a observabilidade (família STORYMAP) ──
  BOARD_AUTOCOMMIT: "STORYMAP",
  BOARD_AUTOPUSH: "STORYMAP",
  BOARD_FLUSH_MS: "STORYMAP",
  CCUSAGE_CMD: "STORYMAP",
  DEPLOY_CANARY_COMMAND: "STORYMAP",
  DIST_DIR: "STORYMAP",
  ENGINE: "STORYMAP",
  FEEDBACK_EMBED_ORIGINS: "STORYMAP",
  FEEDBACK_INGEST_TOKENS: "STORYMAP",
  FEEDBACK_TERMINAL: "STORYMAP",
  FRONTMATTER_MAX_BYTES: "STORYMAP",
  FRONTMATTER_MAX_DEPTH: "STORYMAP",
  FRONTMATTER_MAX_NODES: "STORYMAP",
  HEADROOM_URL: "STORYMAP",
  MCP_TOKEN: "STORYMAP",
  MCP_TOKEN_ORCH: "STORYMAP",
  MCP_TOKEN_RO: "STORYMAP",
  ORCH_ENABLED: "STORYMAP",
  RUNNER_STATE_DIR: "STORYMAP",
  SELF_URL: "STORYMAP",
  SERVER_OUT: "STORYMAP",
  SLACK_WEBHOOK_URL: "STORYMAP",
  TARGET: "STORYMAP",
  TERMINAL_WATCH_MAX: "STORYMAP",
  TERMINAL_WATCH_SECONDS: "STORYMAP",
  TERM_PROMPT_PATTERN: "STORYMAP",
  USAGE_MAX_AGE_MIN: "STORYMAP",
  VAPID_PRIVATE_KEY: "STORYMAP",
  VAPID_PUBLIC_KEY: "STORYMAP",
  VAPID_SUBJECT: "STORYMAP",
  WEEKLY_TOKEN_LIMIT: "STORYMAP",
};

/**
 * Famílias por PREFIXO de sufixo, para os nomes DINÂMICOS que o catálogo exato não pode enumerar: todo
 * tier de credencial MCP (`MCP_TOKEN`, `_ORCH`, `_RO`, `_SESSION` e o que `settings.yaml` declarar
 * amanhã) e o teto de tier por board (`AUTORUN_TIER_CAP_<BOARD>`). O exato vence o prefixo.
 */
export const PREFIXOS_LEGADOS: readonly (readonly [prefixo: string, familia: FamiliaLegada])[] = [
  ["MCP_TOKEN", "STORYMAP"],
  ["AUTORUN_TIER_CAP_", "USM"],
] as const;

/**
 * Os sufixos que NASCERAM `AGILEHARNESS_` — nunca tiveram nome legado, e por isso não ganham twin no
 * sentido novo→legado. Enumerados para que o teste possa exigir que todo nome lido seja OU legado OU
 * nativo: um nome fora dos dois conjuntos é uma variável nova que entrou sem decisão.
 */
export const SUFIXOS_NATIVOS: readonly string[] = [
  "ALLOW_PUBLIC_BIND",
  "ALLOW_UNSANDBOXED_FULL",
  "AUTH_TOKEN",
  "BUN",
  "CLAUDE",
  "DEPLOY_LAUNCHERS",
  "DEPLOY_RECIPES",
  "DEPLOY_RECIPE_RUNNERS",
  "DEV",
  "HOST",
  "JUST",
  "OPS_REPORT_SCRIPT",
  "ORIGIN_TRUST",
  "PORT",
  "PUBLIC_URL",
  "QA_SEED_PROBE_URL",
  "REAPER_MODE",
  "SANDBOX_ALLOWED_DOMAINS",
  "SANDBOX_MODE",
  "SANDBOX_WEAKER_NESTED",
  "SERVICE_UNIT",
  "SESSION_SECRET",
  "TOOL_ROOT",
  "TTYD_URL",
  "UPDATE_LOG",
  "UPDATE_SCRIPT",
] as const;

/** A família legada de um SUFIXO (`TARGET` → `STORYMAP`), ou undefined quando é nativo/desconhecido. */
export function familiaLegadaDe(sufixo: string): FamiliaLegada | undefined {
  const exato = SUFIXOS_LEGADOS[sufixo];
  if (exato) return exato;
  for (const [prefixo, familia] of PREFIXOS_LEGADOS) if (sufixo.startsWith(prefixo)) return familia;
  return undefined;
}

/** true para `STORYMAP_*` e `USM_*`. */
export function ehNomeLegado(nome: string): boolean {
  return FAMILIAS_LEGADAS.some((f) => nome.startsWith(`${f}_`) && nome.length > f.length + 1);
}

/** `STORYMAP_X` | `USM_X` → `AGILEHARNESS_X`. Mecânico: qualquer sufixo. undefined se não é legado. */
export function nomeNovoDe(legado: string): string | undefined {
  for (const f of FAMILIAS_LEGADAS) {
    const p = `${f}_`;
    if (legado.startsWith(p) && legado.length > p.length) return `${PREFIXO_NOVO}${legado.slice(p.length)}`;
  }
  return undefined;
}

/** `AGILEHARNESS_X` → `STORYMAP_X` | `USM_X` pelo catálogo. undefined para nativo ou desconhecido. */
export function nomeLegadoDe(novo: string): string | undefined {
  if (!novo.startsWith(PREFIXO_NOVO)) return undefined;
  const sufixo = novo.slice(PREFIXO_NOVO.length);
  const familia = familiaLegadaDe(sufixo);
  return familia ? `${familia}_${sufixo}` : undefined;
}

export interface ParDeAlias {
  legado: string;
  novo: string;
}

export interface ResultadoDosAliases {
  /** nomes legados que o ambiente trazia SEM o novo — o que o operador ainda escreve na grafia antiga. */
  legadosEmUso: ParDeAlias[];
  /** cada chave criada por esta passagem, e de onde o valor veio. */
  preenchidos: { de: string; para: string }[];
  /** as duas grafias presentes com valores DIFERENTES: a nova venceu, a velha ficou como estava. */
  conflitos: ParDeAlias[];
}

const definido = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/**
 * Aplica a ponte a um env, MUTANDO-O, e devolve o que fez:
 *   · legado→novo, para QUALQUER `STORYMAP_*`/`USM_*` presente (regra mecânica, sem catálogo);
 *   · novo→legado, para os `AGILEHARNESS_*` cujo sufixo o catálogo conhece (nativo não ganha twin).
 * Nunca sobrescreve um valor presente: com as duas grafias e valores diferentes, a NOVA vence e o par vai
 * para `conflitos`. Vazio conta como ausente. Idempotente: a segunda passagem não muda nada nem acusa
 * legado em uso (o twin já existe, igual).
 */
export function resolverAliasesDeEnv(env: Record<string, string | undefined>): ResultadoDosAliases {
  const out: ResultadoDosAliases = { legadosEmUso: [], preenchidos: [], conflitos: [] };
  // Snapshot das chaves: as passagens inserem no próprio objeto.
  const chaves = Object.keys(env);
  for (const legado of chaves) {
    if (!ehNomeLegado(legado)) continue;
    const valor = env[legado];
    if (!definido(valor)) continue;
    const novo = nomeNovoDe(legado)!;
    const atual = env[novo];
    if (!definido(atual)) {
      env[novo] = valor;
      out.preenchidos.push({ de: legado, para: novo });
      out.legadosEmUso.push({ legado, novo });
    } else if (atual !== valor) {
      out.conflitos.push({ legado, novo });
    }
  }
  for (const novo of Object.keys(env)) {
    if (!novo.startsWith(PREFIXO_NOVO)) continue;
    const valor = env[novo];
    if (!definido(valor)) continue;
    const legado = nomeLegadoDe(novo);
    if (!legado) continue;
    if (!definido(env[legado])) {
      env[legado] = valor;
      out.preenchidos.push({ de: novo, para: legado });
    }
  }
  return out;
}

/**
 * A linha de aviso do boot — UMA, nomeando cada legado e o nome que o substitui. null quando não há o
 * que avisar. É o "avisa uma vez nomeando o novo" do plano: o operador lê o que trocar, e o serviço não
 * repete a cada request.
 */
export function avisoDeLegados(r: ResultadoDosAliases): string | null {
  if (r.legadosEmUso.length === 0 && r.conflitos.length === 0) return null;
  const partes: string[] = [];
  if (r.legadosEmUso.length > 0) {
    const pares = [...r.legadosEmUso]
      .sort((a, b) => a.legado.localeCompare(b.legado))
      .map((p) => `${p.legado} → ${p.novo}`)
      .join(", ");
    partes.push(
      `[env] nomes LEGADOS em uso (continuam funcionando nesta versão; serão removidos na próxima minor): ${pares}`,
    );
  }
  if (r.conflitos.length > 0) {
    const pares = [...r.conflitos]
      .sort((a, b) => a.legado.localeCompare(b.legado))
      .map((p) => `${p.legado} ≠ ${p.novo}`)
      .join(", ");
    partes.push(`[env] as duas grafias presentes com valores DIFERENTES — a nova venceu: ${pares}`);
  }
  return partes.join("\n");
}
