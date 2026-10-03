// A POLÍTICA DE DEPLOY DECLARADA PELO ALVO — o que a ferramenta NÃO pode supor do ferramental de publicação. PURO.
//
// POR QUE EXISTE: o motor do deploy carregava defaults do repositório onde nasceu — o lançador (`just`), a receita de
// publicar um app, a de ler o sha no ar, o caminho do arquivo de estado do orquestrador, o prefixo `packages/`, o
// comando que GRAVA a prova. Cada um era um «descubra o repositório do dono» cravado no código. Aqui moram as FORMAS
// desses valores; quem os consome (deploy.ts, product-deploy.ts, deploy-freshness.ts, deploy-reconcile.ts…) lê
// {@link deployPolicyOf} e, sem declaração, RECUSA dizendo a chave exata a declarar — nunca supõe.
//
// ONDE MORA: no bloco `deploy:` de TOPO do settings.yaml — o MESMO que já guarda `canaryCommand`, `targets` e
// `composedFace`. Não existe `target.deploy`: dois endereços para a mesma coisa seriam dívida nova. É o canal do
// OPERADOR (settings.yaml é classe `control`: versionado e sob o gate de código), por isso um comando declarado AQUI não
// passa pela allow-list de `authorizeDeployCommand` (que existe para board-data, editável por agente) — mas continua
// sendo ARGV, sem shell, com placeholders fechados.
//
//   deploy:
//     launchers: [<nome>]            # a allow-list dos lançadores de um comando declarado em board-data
//     recipeRunners: [<nome>]        # quais lançadores são task runners (respondem à cadeia receita→argumento)
//     recipes: [<receita>]           # as receitas que board-data pode nomear
//     legacy:                        # o caminho diff-aware dos `targets`
//       packageRoot: <prefixo/>      # o prefixo que sai de board.yaml `package` para virar o id do alvo
//       command: [<argv…>, "{target}"]
//       plan:    [<argv…>, "{target}"]            # somente leitura
//       scope:   ["<prefixo>/{target}/"]          # escopo de sujeira de um alvo sem board dono
//       state:   <caminho>/{target}.json          # lastDeploySha / units
//     composedFace: { target, recipe, manifest, command?: [<argv…>] }
//     proof:
//       record: { securityReview: [<argv…>, "{file}"], ownerApproval: [<argv…>, "{file}"] }
//       staleMarkers: ["<frase>"]
//
// UNIÃO COM O ENV: `AGILEHARNESS_DEPLOY_LAUNCHERS`/`_RECIPE_RUNNERS`/`_RECIPES` (env do serviço) continuam ADITIVOS —
// quem monta a política efetiva faz settings ∪ env, e o env nunca REMOVE o que o settings declarou. Esse merge é do
// consumidor (deploy-command-guard.ts); aqui só vive a leitura tipada do settings.
//
// SEM DECLARAÇÃO tudo é VAZIO: nenhum comando de board-data roda no passo privilegiado, nenhum alvo legado dispara,
// nenhum estado é lido (sem evidência ⇒ nunca «no ar» por acidente), e a prova não é gravada a partir de TEXTO de log.

import { NEVER_A_DEPLOY_TARGET, deployPolicyFromSettings, taskRunnersMissingFromRecipeRunners } from "./runner/deploy-command-guard";
import { hasControlChar } from "./target-profile";

/** A FORMA de um alvo de deploy: um slug atravessa a superfície de instrução do MCP, um argv e um nome de arquivo sem significar nada. */
export const DEPLOY_TARGET_SLUG = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const LAUNCHER_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;
const RECIPE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const LIST_MAX = 32;
const ARGV_MAX_WORDS = 32;
const ARGV_WORD_MAX = 200;
const PATH_MAX = 160;

/** Os placeholders fechados de cada tipo de argv: `{target}` (o id do alvo, slug) e `{file}` (o arquivo de prova). */
export type ArgvPlaceholder = "target" | "file";

export interface DeployLegacy {
  /** prefixo (com `/` final) que sai de `board.yaml package` para virar o id do alvo. Ausente ⇒ compara `package` inteiro com `targets`. */
  packageRoot?: string;
  /** o comando de publicar um alvo; `{target}` expandido. Ausente ⇒ o disparo recusa («declare deploy.legacy.command»). */
  command?: string[];
  /** o plano (somente leitura); idem. */
  plan?: string[];
  /** prefixos de escopo de sujeira de um alvo sem board dono (`{target}` expandido). Ausente ⇒ escopo vazio = repositório inteiro (conservador). */
  scope?: string[];
  /** o arquivo de estado do orquestrador por alvo (`{target}` expandido). Ausente ⇒ sem evidência (null). */
  state?: string;
}

export interface DeployProofDecl {
  record?: { securityReview?: string[]; ownerApproval?: string[] };
  /** frases que marcam um veredito como de OUTRO assunto (stale). Ausente ⇒ nunca stale. */
  staleMarkers?: string[];
}

/** O que `deploy:` ganha além de canaryCommand/targets/composedFace. Todos opcionais; ausente = não declarado. */
export interface DeployPolicyDecl {
  launchers?: string[];
  recipeRunners?: string[];
  recipes?: string[];
  legacy?: DeployLegacy;
  proof?: DeployProofDecl;
}

type Warn = (message: string) => void;

function nameList(raw: unknown, key: string, shape: RegExp, warn: Warn, extraReject?: (v: string) => string | null): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    warn(`[storymap] settings deploy.${key}: DESCARTADO — deveria ser uma lista de nomes.`);
    return undefined;
  }
  const ok: string[] = [];
  const bad: unknown[] = [];
  for (const item of raw) {
    const v = typeof item === "string" ? item.trim() : "";
    const why = v && shape.test(v) ? (extraReject?.(v) ?? null) : "forma";
    if (why) bad.push(item);
    else if (ok.length < LIST_MAX && !ok.includes(v)) ok.push(v);
  }
  if (bad.length) {
    warn(`[storymap] settings deploy.${key}: ${bad.length} item(ns) DESCARTADO(s) por forma inválida (exigido ${shape}${extraReject ? ", fora da lista de interpretadores/shells" : ""}): ${bad.map((b) => JSON.stringify(b)).join(", ").slice(0, 200)}.`);
  }
  return ok.length ? ok : undefined;
}

/**
 * Um argv-molde declarado: LISTA de palavras (nunca texto de shell), 1–32 palavras de ≤ 200 caracteres, sem caractere
 * de controle, a primeira sem `/` (um NOME resolvido pelo PATH do operador, não um arquivo escolhido por dado). Os
 * placeholders `{nome}` só podem ser os de `allowed`; um desconhecido (`{pkg}`) descarta o comando inteiro — nunca um
 * comando pela metade. `required` exige que o placeholder apareça (um comando de prova sem `{file}` não prova nada).
 */
export function coerceArgvTemplate(raw: unknown, allowed: readonly ArgvPlaceholder[], path: string, warn: Warn, required: readonly ArgvPlaceholder[] = []): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const reject = (why: string): undefined => {
    warn(`[storymap] settings ${path}: comando DESCARTADO — ${why}. Declare uma LISTA de palavras (argv), sem shell.`);
    return undefined;
  };
  if (!Array.isArray(raw)) return reject("deveria ser uma lista de palavras, não um texto");
  if (!raw.length || raw.length > ARGV_MAX_WORDS) return reject(`exige de 1 a ${ARGV_MAX_WORDS} palavras`);
  const words: string[] = [];
  for (const w of raw) {
    if (typeof w !== "string" || !w || w.length > ARGV_WORD_MAX || hasControlChar(w)) return reject(`palavra vazia, não-texto, com mais de ${ARGV_WORD_MAX} caracteres ou com caractere de controle`);
    words.push(w);
  }
  if (words[0].includes("/")) return reject("a primeira palavra deve ser o NOME do programa, sem `/`");
  const seen = new Set<string>();
  for (const w of words) {
    for (const m of w.matchAll(/\{([A-Za-z]+)\}/g)) {
      if (!(allowed as readonly string[]).includes(m[1])) return reject(`placeholder {${m[1]}} desconhecido aqui (aceitos: ${allowed.map((a) => `{${a}}`).join(", ") || "nenhum"})`);
      seen.add(m[1]);
    }
  }
  for (const need of required) if (!seen.has(need)) return reject(`exige o placeholder {${need}}`);
  return words;
}

/** Um caminho-molde relativo (para `state`/`scope`): sem raiz, sem `..`, só caracteres de caminho, `{target}` como único placeholder. */
function coercePathTemplate(raw: unknown, path: string, warn: Warn): string | undefined {
  if (typeof raw !== "string") {
    if (raw !== undefined && raw !== null) warn(`[storymap] settings ${path}: DESCARTADO — deveria ser um caminho relativo (texto).`);
    return undefined;
  }
  const v = raw.trim();
  const placeholders = [...v.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
  const ok =
    v.length > 0 &&
    v.length <= PATH_MAX &&
    /^[A-Za-z0-9._/{}-]+$/.test(v) &&
    !v.startsWith("/") &&
    !v.split("/").includes("..") &&
    placeholders.every((p) => p === "target") &&
    // chaves soltas que não formam `{target}` (ex.: `a{b`) não são molde
    v.replace(/\{target\}/g, "").indexOf("{") === -1 &&
    v.replace(/\{target\}/g, "").indexOf("}") === -1;
  if (!ok) {
    warn(`[storymap] settings ${path}: caminho DESCARTADO — exige caminho relativo (sem \`..\`, sem raiz, ≤ ${PATH_MAX}) com {target} como único placeholder.`);
    return undefined;
  }
  return v;
}

function coerceLegacy(raw: unknown, warn: Warn): DeployLegacy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("[storymap] settings deploy.legacy: DESCARTADO — deveria ser um mapa { packageRoot?, command?, plan?, scope?, state? }.");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: DeployLegacy = {};
  if (r.packageRoot !== undefined) {
    const p = typeof r.packageRoot === "string" ? r.packageRoot.trim().replace(/\/*$/, "/") : "";
    if (p.length > 1 && p.length <= PATH_MAX && /^[A-Za-z0-9._/-]+$/.test(p) && !p.startsWith("/") && !p.split("/").includes("..")) out.packageRoot = p;
    else warn("[storymap] settings deploy.legacy.packageRoot: DESCARTADO — exige um caminho relativo (sem `..`, sem raiz).");
  }
  const command = coerceArgvTemplate(r.command, ["target"], "deploy.legacy.command", warn);
  if (command) out.command = command;
  const plan = coerceArgvTemplate(r.plan, ["target"], "deploy.legacy.plan", warn);
  if (plan) out.plan = plan;
  if (r.scope !== undefined) {
    if (!Array.isArray(r.scope)) warn("[storymap] settings deploy.legacy.scope: DESCARTADO — deveria ser uma lista de prefixos de caminho.");
    else {
      const scope = r.scope.map((s, i) => coercePathTemplate(s, `deploy.legacy.scope[${i}]`, warn)).filter((s): s is string => !!s).slice(0, 16);
      if (scope.length) out.scope = scope;
    }
  }
  const state = coercePathTemplate(r.state, "deploy.legacy.state", warn);
  if (state) out.state = state;
  return Object.keys(out).length ? out : undefined;
}

function coerceProof(raw: unknown, warn: Warn): DeployProofDecl | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("[storymap] settings deploy.proof: DESCARTADO — deveria ser um mapa { record?, staleMarkers? }.");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: DeployProofDecl = {};
  if (r.record !== undefined) {
    if (!r.record || typeof r.record !== "object" || Array.isArray(r.record)) warn("[storymap] settings deploy.proof.record: DESCARTADO — deveria ser um mapa { securityReview?, ownerApproval? }.");
    else {
      const rec = r.record as Record<string, unknown>;
      const record: NonNullable<DeployProofDecl["record"]> = {};
      const sec = coerceArgvTemplate(rec.securityReview, ["file"], "deploy.proof.record.securityReview", warn, ["file"]);
      const own = coerceArgvTemplate(rec.ownerApproval, ["file"], "deploy.proof.record.ownerApproval", warn, ["file"]);
      if (sec) record.securityReview = sec;
      if (own) record.ownerApproval = own;
      if (Object.keys(record).length) out.record = record;
    }
  }
  if (r.staleMarkers !== undefined) {
    if (!Array.isArray(r.staleMarkers)) warn("[storymap] settings deploy.proof.staleMarkers: DESCARTADO — deveria ser uma lista de frases.");
    else {
      const markers = r.staleMarkers
        .map((m) => (typeof m === "string" ? m.trim() : ""))
        .filter((m, i, all) => m.length > 0 && m.length <= 80 && !hasControlChar(m) && all.indexOf(m) === i)
        .slice(0, 8);
      if (markers.length) out.staleMarkers = markers;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * As chaves NOVAS do bloco `deploy:` (tudo menos canaryCommand/targets/composedFace, que continuam em config.ts).
 * Tolerante: peça fora da forma é DESCARTADA com aviso e o resto segue; nada lança. PURA salvo o `warn`.
 */
export function coerceDeployPolicy(
  raw: Record<string, unknown>,
  warn: Warn = (m) => console.warn(m),
  env: Record<string, string | undefined> = process.env,
): DeployPolicyDecl {
  const out: DeployPolicyDecl = {};
  // Um lançador nunca pode ser shell/interpretador, nem quando o OPERADOR escreve: a allow-list é o que impede board-data
  // de virar execução arbitrária, e um `launchers: [bash]` reabriria o buraco por engano.
  const launchers = nameList(raw.launchers, "launchers", LAUNCHER_NAME, warn, (v) => (NEVER_A_DEPLOY_TARGET.has(v) ? "interpretador" : null));
  const recipeRunners = nameList(raw.recipeRunners, "recipeRunners", LAUNCHER_NAME, warn, (v) => (NEVER_A_DEPLOY_TARGET.has(v) ? "interpretador" : null));
  const recipes = nameList(raw.recipes, "recipes", RECIPE_NAME, warn);
  if (launchers) out.launchers = launchers;
  if (recipeRunners) out.recipeRunners = recipeRunners;
  if (recipes) out.recipes = recipes;
  // LINT DE SEGURANÇA, não suposição de ferramental: um lançador que é task runner conhecido e não foi declarado em
  // `recipeRunners` (nem no env aditivo) perde a régua da cadeia receita→argumento em silêncio. A política EFETIVA
  // (settings ∪ env) é a que decide, então o env que declara `recipeRunners` também silencia o aviso.
  for (const runner of taskRunnersMissingFromRecipeRunners(deployPolicyFromSettings(out, env))) {
    warn(
      `[storymap] settings deploy.launchers: ⚠ \`${runner}\` é um task runner conhecido mas NÃO está em deploy.recipeRunners ` +
        `(nem em AGILEHARNESS_DEPLOY_RECIPE_RUNNERS). Sem isso ele recebe só a régua de lançador comum, e um argumento de ` +
        `comando de board-data como \`$(…)\` ou \`a; b\` seria interpolado como TEXTO na linha de shell da receita, executando ` +
        `com o privilégio do serviço. Declare \`deploy.recipeRunners: [${runner}]\`.`,
    );
  }
  const legacy = coerceLegacy(raw.legacy, warn);
  if (legacy) out.legacy = legacy;
  const proof = coerceProof(raw.proof, warn);
  if (proof) out.proof = proof;
  return out;
}

/** O que o consumidor lê. CADA campo ausente é «não declarado»: lista vazia / undefined. */
export interface ResolvedDeployPolicy {
  launchers: string[];
  recipeRunners: string[];
  recipes: string[];
  /** `deploy.targets` (os ids que o caminho diff-aware publica). */
  targets: string[];
  legacy: DeployLegacy;
  proof: { record: { securityReview?: string[]; ownerApproval?: string[] }; staleMarkers: string[] };
  composedFace?: { target: string; recipe: string; manifest: string; command?: string[] };
  canaryCommand?: string;
}

/** O que a resolução lê do RunnerSettings (estrutural: este módulo não importa types.ts). */
export interface DeploySource {
  deploy?: DeployPolicyDecl & {
    canaryCommand?: string;
    targets?: string[];
    composedFace?: { target: string; recipe: string; manifest: string; command?: string[] };
  };
}

/** A política de deploy DECLARADA — vazia onde o alvo não declarou. NUNCA um default do repositório de origem. PURA. */
export function deployPolicyOf(settings: DeploySource | null | undefined): ResolvedDeployPolicy {
  const d = settings?.deploy;
  return {
    launchers: [...(d?.launchers ?? [])],
    recipeRunners: [...(d?.recipeRunners ?? [])],
    recipes: [...(d?.recipes ?? [])],
    targets: [...(d?.targets ?? [])],
    legacy: { ...(d?.legacy ?? {}) },
    proof: { record: { ...(d?.proof?.record ?? {}) }, staleMarkers: [...(d?.proof?.staleMarkers ?? [])] },
    ...(d?.composedFace ? { composedFace: { ...d.composedFace } } : {}),
    ...(d?.canaryCommand ? { canaryCommand: d.canaryCommand } : {}),
  };
}

/**
 * Preenche um argv-molde. Devolve null quando falta um valor ou quando ele não é seguro para virar argumento: `{target}`
 * tem de ser slug ({@link DEPLOY_TARGET_SLUG}); `{file}` um caminho de caracteres seguros, sem `..`. Nunca um comando
 * pela metade. PURA.
 */
export function expandArgvTemplate(argv: readonly string[], values: Partial<Record<ArgvPlaceholder, string>>): string[] | null {
  const safe: Record<ArgvPlaceholder, (v: string) => boolean> = {
    target: (v) => DEPLOY_TARGET_SLUG.test(v),
    file: (v) => v.length > 0 && v.length <= 400 && /^[A-Za-z0-9._/-]+$/.test(v) && !v.split("/").includes(".."),
  };
  const out: string[] = [];
  for (const word of argv) {
    let bad = false;
    const expanded = word.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
      if (name !== "target" && name !== "file") return whole;
      const v = values[name];
      if (v === undefined || !safe[name](v)) {
        bad = true;
        return "";
      }
      return v;
    });
    if (bad) return null;
    out.push(expanded);
  }
  return out;
}

/** Preenche um caminho-molde (`state`/`scope`) com `{target}`. Null se o alvo não é slug. PURA. */
export function expandPathTemplate(template: string, target: string): string | null {
  if (!DEPLOY_TARGET_SLUG.test(target)) return null;
  return template.replace(/\{target\}/g, target);
}
