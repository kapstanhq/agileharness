// locked-exec-classifier — QUEM DIZ se um comando está travado e se ele pode ganhar o botão «Aprovar e rodar».
//
// A ferramenta não conhece comando de produto nenhum, e não decide sozinha o que é perigoso: quem decide é a TRAVA DO
// HOST — o mesmo código que recusa os comandos dos agentes. O host declara, no AMBIENTE DO SERVIÇO, como perguntar a
// ela:
//
//   AGILEHARNESS_EXEC_CLASSIFIER='["/caminho/do/classificador"]'
//
// Contrato: o serviço roda esse argv (sem shell, com teto), manda no stdin `{"command": "<linha de shell>", "cwd":
// "<raiz do alvo>"}` e lê do stdout UM objeto JSON:
//
//   {"locked": bool, "klass"?: string, "rule"?: string, "reason"?: string, "approvable"?: bool}
//
// `locked` = a trava recusaria isto a um agente; `approvable` = a configuração da trava (do dono, no host) deixa este
// tipo de comando ganhar o botão. Qualquer coisa fora do contrato (saída ≠ 0, JSON torto, campo de tipo errado, tempo
// esgotado) RECUSA — o classificador que falha nunca vira «pode».
//
// Por que no ambiente do serviço e NUNCA no settings.yaml/board.yaml: o dado de board chega à main pelo merge train (um
// agente o edita); o ambiente do serviço é do host. Um agente que pudesse apontar o classificador para um script dele
// escolheria o que é aprovável. Sem a declaração, a feature fica INERTE e diz por quê.
//
// A MESMA régua vale para a CONFIGURAÇÃO da trava: o que é aprovável mora nela, e uma trava que caísse numa config dentro
// do repositório alvo (editável por agente) deixaria o agente escolher. Por isso o serviço exige
// `AGILEHARNESS_EXEC_LOCK_CONFIG` no PRÓPRIO ambiente — absoluto, existente, um objeto JSON legível e FORA do repositório
// alvo (pelo caminho real) — e a repassa ao classificador com o MESMO nome; o filho roda sem `CLAUDE_PROJECT_DIR` e com o
// diretório de trabalho na raiz do sistema (nada que o leve a procurar outra config no repositório). Faltou qualquer
// uma: inerte.

import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { LockedExecClassification } from "./locked-exec";
import { shellQuote } from "./locked-exec";
import { sanitizeSpawnEnv } from "./spawn-env";

export const EXEC_CLASSIFIER_ENV = "AGILEHARNESS_EXEC_CLASSIFIER";
/** A configuração da trava declarada pelo host — validada aqui e repassada ao classificador com este mesmo nome. */
export const EXEC_LOCK_CONFIG_ENV = "AGILEHARNESS_EXEC_LOCK_CONFIG";
export const CLASSIFIER_TIMEOUT_MS = 10_000;

export interface Classification extends LockedExecClassification {
  locked: boolean;
  approvable: boolean;
}

export type ClassifyResult = { ok: true; c: Classification } | { ok: false; why: string };
export type ClassifyFn = (argv: readonly string[]) => Promise<ClassifyResult>;

/**
 * Lê a declaração do classificador. `null` = não declarado (a feature fica inerte); erro = declarado errado (recusa,
 * dizendo o que está errado). PURA.
 */
export function classifierArgvFromEnv(env: Record<string, string | undefined>): { ok: true; argv: string[] } | { ok: false; why: string } | null {
  const raw = (env[EXEC_CLASSIFIER_ENV] ?? "").trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, why: `${EXEC_CLASSIFIER_ENV} não é um JSON (esperado: um array com o programa e os argumentos)` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((a) => typeof a !== "string" || !a || a.includes("\0"))) {
    return { ok: false, why: `${EXEC_CLASSIFIER_ENV} tem de ser um array de textos não vazios` };
  }
  return { ok: true, argv: parsed as string[] };
}

/** Lê a resposta do classificador — ESTRITA: um campo de tipo errado invalida a resposta inteira. PURA. */
export function parseClassification(stdout: string): Classification | null {
  let o: unknown;
  try {
    o = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.locked !== "boolean") return null;
  if (r.approvable !== undefined && typeof r.approvable !== "boolean") return null;
  for (const k of ["klass", "rule", "reason"] as const) if (r[k] !== undefined && typeof r[k] !== "string") return null;
  return {
    locked: r.locked,
    // não travado não tem o que aprovar; travado sem a palavra explícita da trava NÃO é aprovável
    approvable: r.locked === true && r.approvable === true,
    ...(typeof r.klass === "string" ? { klass: r.klass.slice(0, 80) } : {}),
    ...(typeof r.rule === "string" ? { rule: r.rule.slice(0, 80) } : {}),
    ...(typeof r.reason === "string" ? { reason: r.reason.slice(0, 400) } : {}),
  };
}

/** Roda um processo com stdin e teto. Injetável no teste. */
export type ClassifierRun = (
  argv: readonly string[],
  stdin: string,
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;

export const defaultClassifierRun: ClassifierRun = (argv, stdin, opts) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        argv[0],
        argv.slice(1),
        { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 256 * 1024, env: opts.env, windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(err && code === null ? { error: err.message.split("\n")[0] } : {}) });
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
    }
  });

/**
 * Monta o classificador a partir da declaração do host. O ambiente do filho é o saneado do serviço + a config da trava
 * (se o serviço a tem), e nada mais vindo do agente.
 */
export function makeClassifier(deps: {
  argv: readonly string[];
  cwd: () => string;
  run?: ClassifierRun;
  env?: Record<string, string | undefined>;
  /** reconfere, a CADA consulta, que a config da trava segue válida e fora do repositório (ela pode mudar no disco). */
  preflight?: () => { ok: true } | { ok: false; why: string };
}): ClassifyFn {
  const run = deps.run ?? defaultClassifierRun;
  const source = deps.env ?? process.env;
  return async (argv) => {
    const env = sanitizeSpawnEnv(source as NodeJS.ProcessEnv);
    if (source[EXEC_LOCK_CONFIG_ENV]) env[EXEC_LOCK_CONFIG_ENV] = source[EXEC_LOCK_CONFIG_ENV];
    // a trava não pode achar o repositório por conta própria (e cair na config dele): nem a variável do projeto,
    // nem o diretório de trabalho dentro dele. O cwd que ela JULGA vai no stdin.
    delete env.CLAUDE_PROJECT_DIR;
    if (deps.preflight) {
      const pre = deps.preflight();
      if (!pre.ok) return { ok: false, why: pre.why };
    }
    const cwd = deps.cwd();
    const r = await run(deps.argv, JSON.stringify({ command: shellQuote(argv), cwd }), { cwd: path.parse(cwd || "/").root || "/", timeoutMs: CLASSIFIER_TIMEOUT_MS, env });
    if (r.error || r.code !== 0) {
      return { ok: false, why: `a trava do host não respondeu (${r.error ?? `saída ${r.code}`}) — sem resposta, nada é aprovável` };
    }
    const c = parseClassification(r.stdout);
    if (!c) return { ok: false, why: "a trava do host respondeu fora do contrato — sem resposta válida, nada é aprovável" };
    return { ok: true, c };
  };
}

/**
 * A config da trava é do HOST? `AGILEHARNESS_EXEC_LOCK_CONFIG` no ambiente do serviço, caminho absoluto, arquivo existente com um
 * objeto JSON, e — pelo caminho REAL dos dois — fora do repositório alvo. PURA salvo as leituras injetáveis.
 */
export function lockConfigRefusal(
  env: Record<string, string | undefined>,
  repoRoot: string,
  io: { realpath?: (p: string) => string; read?: (p: string) => string; isFile?: (p: string) => boolean } = {},
): string | null {
  const realpath = io.realpath ?? ((p: string) => realpathSync(p));
  const read = io.read ?? ((p: string) => readFileSync(p, "utf8"));
  const isFile = io.isFile ?? ((p: string) => statSync(p).isFile());
  const raw = (env[EXEC_LOCK_CONFIG_ENV] ?? "").trim();
  const off = "a função está desligada";
  if (!raw) return `o host não declarou a configuração da trava (${EXEC_LOCK_CONFIG_ENV} no ambiente do serviço) — ${off}`;
  if (!path.isAbsolute(raw)) return `${EXEC_LOCK_CONFIG_ENV} tem de ser um caminho absoluto — ${off}`;
  let real: string;
  let root: string;
  try {
    real = realpath(raw);
    if (!isFile(real)) return `${EXEC_LOCK_CONFIG_ENV} não aponta para um arquivo — ${off}`;
  } catch {
    return `${EXEC_LOCK_CONFIG_ENV} aponta para um arquivo que não existe — ${off}`;
  }
  try {
    root = realpath(repoRoot);
  } catch {
    return `a raiz do repositório alvo não se resolve — ${off}`;
  }
  const rel = path.relative(root, real);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return `a configuração da trava mora DENTRO do repositório alvo (um agente a editaria) — mova-a para fora; ${off}`;
  }
  try {
    const parsed = JSON.parse(read(real)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `a configuração da trava não é um objeto JSON — ${off}`;
  } catch {
    return `a configuração da trava não é um JSON legível (a trava cairia noutra config) — ${off}`;
  }
  return null;
}

/** O classificador de produção (do ambiente do serviço), ou o motivo de estar inerte/errado. */
export function classifierFromEnv(
  cwd: () => string,
  env: Record<string, string | undefined> = process.env,
): { ok: true; classify: ClassifyFn } | { ok: false; why: string } {
  const decl = classifierArgvFromEnv(env);
  if (!decl) {
    return { ok: false, why: `o host não declarou a trava para a execução aprovada (${EXEC_CLASSIFIER_ENV} no ambiente do serviço) — a função está desligada` };
  }
  if (!decl.ok) return decl;
  const refusal = lockConfigRefusal(env, cwd());
  if (refusal) return { ok: false, why: refusal };
  const preflight = () => {
    const r = lockConfigRefusal(env, cwd());
    return r ? { ok: false as const, why: r } : { ok: true as const };
  };
  return { ok: true, classify: makeClassifier({ argv: decl.argv, cwd, env, preflight }) };
}

// ── as CONFERÊNCIAS que o host libera ────────────────────────────────────────────────────────────────
//
// «Não travado» não quer dizer «só leitura»: um comando livre pode escrever, e as conferências rodam como o serviço. Por
// isso o que pode CONFERIR é uma lista que o HOST declara — prefixos exatos de argv — no ambiente do serviço:
//
//   AGILEHARNESS_EXEC_CHECK_PREFIXES='[["cofre-cli","status"],["relogio-cli","consulta","--resumo"]]'
//
// Uma conferência (preflight ou verify) só vale se o argv dela COMEÇA com um dos prefixos: o programa comparado pelo
// caminho real dos dois lados, o resto por igualdade de texto. Sem a lista (ou ilegível, ou vazia), a função fica
// inerte. Nunca do settings.yaml/board-data — o agente edita esses.

export const EXEC_CHECK_PREFIXES_ENV = "AGILEHARNESS_EXEC_CHECK_PREFIXES";

/** A lista de prefixos declarada pelo host, ou o porquê de a função estar inerte. PURA. */
export function checkPrefixesFromEnv(env: Record<string, string | undefined>): { ok: true; prefixes: string[][] } | { ok: false; why: string } {
  const off = "a função está desligada";
  const raw = (env[EXEC_CHECK_PREFIXES_ENV] ?? "").trim();
  if (!raw) return { ok: false, why: `o host não declarou que comandos podem conferir (${EXEC_CHECK_PREFIXES_ENV} no ambiente do serviço) — ${off}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, why: `${EXEC_CHECK_PREFIXES_ENV} não é um JSON (esperado: uma lista de listas de textos) — ${off}` };
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((p) => !Array.isArray(p) || p.length === 0 || p.some((x) => typeof x !== "string" || !x || x.includes("\0")))
  ) {
    return { ok: false, why: `${EXEC_CHECK_PREFIXES_ENV} tem de ser uma lista NÃO vazia de listas de textos não vazios — ${off}` };
  }
  return { ok: true, prefixes: parsed as string[][] };
}

/**
 * A conferência começa EXATAMENTE com algum prefixo liberado? O programa é comparado pelo caminho real resolvido dos
 * dois lados (`programPath` = o da conferência; o do prefixo é resolvido aqui), o resto por igualdade de texto. PURA
 * salvo o resolver injetado.
 */
export function matchesCheckPrefix(
  argv: readonly string[],
  programPath: string,
  prefixes: readonly (readonly string[])[],
  resolve: (argv0: string) => { ok: true; path: string } | { ok: false; why: string },
): boolean {
  return prefixes.some((p) => {
    if (argv.length < p.length) return false;
    const prog = resolve(p[0]);
    if (!prog.ok || prog.path !== programPath) return false;
    for (let i = 1; i < p.length; i++) if (argv[i] !== p[i]) return false;
    return true;
  });
}
