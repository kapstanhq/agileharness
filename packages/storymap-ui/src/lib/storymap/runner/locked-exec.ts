// locked-exec — o NÚCLEO PURO da «Execução aprovada»: um agente propõe um comando que a TRAVA DURA do host recusa a
// qualquer agente (o argv exato, o comando que desfaz e como conferir que deu certo); o DONO aprova no Inbox (clique +
// tela de confirmação, na sessão de operador); e o SERVIÇO — nunca o agente — roda aquele comando UMA vez, dentro de
// 15 minutos, confere, e desfaz sozinho se a conferência falhar.
//
// Por que existe: o que a trava proíbe a agentes não deixa de ser necessário — só deixa de poder ser feito SEM o dono.
// Sem um caminho próprio, sobra o dono reproduzir à mão, fora da ferramenta, o que o agente pediu: sem registro, sem
// prova de que rodou exatamente aquilo e sem volta pronta. Aqui o pedido é um argv exato, auditável, com conferência e
// desfazer declarados ANTES do clique — e quem executa é o serviço, uma vez, sob a decisão do dono.
//
// As garantias, nesta ordem (cada uma tem teste):
//   1. só o OPERADOR COM SESSÃO decide ({@link mayDecideLockedExec}) — nem o agente pelo MCP (mesmo com o token
//      `full`), nem o procurador, nem o próprio serviço;
//   2. a autorização é PRESA ao pedido exato: o hash do JSON canônico (argv, PROGRAMA resolvido de cada comando,
//      desfazer, conferências, prazo, cwd) é o que o dono viu e o que o executor confere antes de rodar;
//   3. USO ÚNICO e PRAZO CURTO: aprovada, a execução começa em até {@link LOCKED_EXEC_TTL_MS}; passou, expira;
//   4. a trava decide o que pode ganhar o botão (o classificador do host — locked-exec-classifier.ts); a ferramenta
//      não conhece nenhum comando de nenhum produto;
//   5. o argv não é ENGODO para a trava: a trava julga TEXTO de shell e o executor roda argv SEM shell — os dois só
//      concordam sobre o que vai rodar quando nenhum argumento carrega sintaxe de shell e o programa não é um
//      interpretador (um `python3 -c "…# $(comando-travado)"` sairia «travado e aprovável» e rodaria o python).
//      {@link argvRefusal} recusa os dois;
//   6. nenhum argumento LÊ UM ARQUIVO: um `--de-arquivo=/caminho` faria o conteúdo do arquivo (que o agente pode
//      escrever e trocar na janela) entrar no comando sem aparecer ao dono nem no hash. Argumento com forma de caminho
//      ({@link argPathRefusal}) é recusado; o relativo que sobra roda num diretório vazio e novo, e o serviço confere,
//      antes de CADA passo, que nenhum argumento aponta para algo que exista ali.
//
// PURO: zero IO. O disco, os processos e o relógio são do serviço (locked-exec-service.ts).

import { createHash } from "node:crypto";

/** A validade da autorização do dono: aprovada, a execução tem de COMEÇAR dentro deste prazo (decisão do dono, 15 min). */
export const LOCKED_EXEC_TTL_MS = 15 * 60_000;
/** O teto de cada conferência (preflight ou verify). */
export const LOCKED_EXEC_CHECK_TIMEOUT_MS = 60_000;
/** O que se guarda da saída de cada passo — só a cauda (1 KB); o comando pode imprimir muito, o Inbox mostra pouco. */
export const LOCKED_EXEC_TAIL_CHARS = 1024;
/**
 * O diretório de trabalho de TODO passo: um diretório NOVO e VAZIO, criado pelo serviço a cada passo e apagado depois.
 * É o que vai na spec (no hash) — nunca a raiz do alvo, onde um argumento relativo leria um arquivo do agente.
 */
export const LOCKED_EXEC_CWD = "(diretório vazio, novo a cada passo)";
/** Um desfecho final arquivado há mais disto sai da listagem (o arquivo fica; a auditoria também). */
export const LOCKED_EXEC_LIST_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Inundação: no máximo tantos pedidos PENDENTES por card e por board. */
export const LOCKED_EXEC_MAX_PENDING_PER_CARD = 2;
export const LOCKED_EXEC_MAX_PENDING_PER_BOARD = 10;

export const LOCKED_EXEC_LIMITS = {
  summaryMin: 10,
  summaryMax: 600,
  whyMax: 1200,
  argvMax: 64,
  argMax: 4096,
  noUndoPlanMin: 10,
  noUndoPlanMax: 1200,
  preflightMax: 5,
  verifyMin: 1,
  verifyMax: 5,
  labelMax: 160,
  expectIncludesMax: 200,
  timeoutSecMin: 10,
  timeoutSecMax: 900,
  timeoutSecDefault: 300,
} as const;

/**
 * Os estados. A régua das transições mora no serviço; aqui, só os nomes e quais são finais.
 *   pending → approved → running → done | failed | undone
 *   pending → rejected · approved → expired (não começou no prazo) · approved → stale (a reconferência falhou)
 *   done → undone (o dono desfez) · done → kept (o dono manteve)
 */
export type LockedExecStatus =
  | "pending"
  | "approved"
  | "running"
  | "done"
  | "failed"
  | "undone"
  | "rejected"
  | "expired"
  | "stale"
  | "kept";

/** Estados em que nada mais roda sozinho (o item do Inbox só informa, até o dono dar «Ok»). */
export const LOCKED_EXEC_FINAL: ReadonlySet<LockedExecStatus> = new Set(["failed", "undone", "rejected", "expired", "stale", "kept"]);

/**
 * Uma conferência: um comando LIVRE (a trava não o recusa) que diz se o mundo está como devia. O critério é LITERAL —
 * código de saída e, se declarado, um trecho que a saída tem de conter. Nada de regex vinda do agente (ReDoS).
 */
export interface LockedCheck {
  /** o que a conferência prova, em português curto («o cofre responde que a chave nova está ativa»). */
  label: string;
  argv: string[];
  /** o código de saída esperado (padrão 0). */
  expectExit?: number;
  /** um trecho LITERAL que a saída padrão tem de conter. */
  expectStdoutIncludes?: string;
}

/** O que a trava do host disse sobre o comando principal na hora da proposta (para o Inbox e a auditoria). */
export interface LockedExecClassification {
  klass?: string;
  rule?: string;
  reason?: string;
}

/** O resultado de um passo (o comando, uma conferência, o desfazer). As caudas já vêm REDIGIDAS (sem segredo). */
export interface LockedExecStep {
  /** "preflight:<n>" · "main" · "verify:<n>" · "undo" */
  step: string;
  ok: boolean;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  /** o motivo quando o passo nem chegou a rodar direito (programa ausente, tempo esgotado). */
  error?: string;
}

/**
 * O PROGRAMA de cada comando, resolvido pelo serviço na proposta (o caminho real, absoluto, fora do repositório). Entra
 * no hash e na tela do dono; antes de rodar, o serviço resolve de novo e exige o MESMO caminho.
 */
export interface LockedExecPrograms {
  main: string;
  undo: string | null;
  preflight: string[];
  verify: string[];
}

/** A proposta normalizada, ainda sem os programas resolvidos (o resolver é IO — é do serviço). */
export interface LockedExecDraft {
  argv: string[];
  undoArgv: string[] | null;
  noUndoPlan: string | null;
  preflight: LockedCheck[];
  verify: LockedCheck[];
  timeoutSec: number;
  cwd: string;
}

/** A spec completa — o que entra no hash. */
export interface LockedExecSpec extends LockedExecDraft {
  programs: LockedExecPrograms;
}

export interface LockedExecRecord extends LockedExecSpec {
  v: 1;
  id: string;
  board: string;
  cardId: string;
  /** o que acontece, nas palavras do AGENTE — a tela o mostra DEPOIS do bloco estruturado, rotulado. */
  summary: string;
  why: string | null;
  /** sha256 do JSON canônico da spec ({@link lockedExecHash}). */
  hash: string;
  classification: LockedExecClassification;
  /** quem propôs DE VERDADE (o rótulo do ator MCP). */
  proposedBy: string;
  proposedAt: string;
  status: LockedExecStatus;
  /** `running` com `phase: "undo"` = o desfazer pedido pelo dono está rodando (o comando já tinha dado certo). */
  phase?: "undo";
  decidedAt?: string;
  /** o hash que o DONO aprovou — o executor exige que a spec no disco ainda o produza. */
  approvedHash?: string;
  approvedVia?: string;
  expiresAt?: string;
  startedAt?: string;
  finishedAt?: string;
  results: LockedExecStep[];
  /** a conferência falhou e o serviço desfez sozinho. */
  autoUndone?: boolean;
  /** o porquê de um estado de falha, em português. */
  error?: string;
  rejectReason?: string;
  /** o dono deu «Ok» num item final (ou recusou): ele sai do Inbox. */
  ackedAt?: string;
}

/** A entrada da proposta como chega do MCP (o zod valida os tipos; aqui, os limites e a coerência). */
export interface LockedExecProposalInput {
  board: string;
  cardId: string;
  summary: string;
  why?: string | null;
  argv: string[];
  undoArgv: string[] | null;
  noUndoPlan?: string | null;
  preflight?: LockedCheck[];
  verify: LockedCheck[];
  timeoutSec?: number;
}

export type Normalized<T> = { ok: true; value: T } | { ok: false; why: string };

// ── a régua do argv e do texto ───────────────────────────────────────────────────────────────────────

/** Controle C0/DEL e os marcadores de direção (bidi) que fazem um texto parecer outro na tela. */
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f‎‏؜‪-‮⁦-⁩]/;
/** Sintaxe de shell num argumento: substituição, encadeamento, redireção (e controle/bidi, acima). */
const SHELL_SYNTAX = /\$\(|`|[;|&<>]/;

/**
 * Programas que executam o que vier nos argumentos (interpretadores, shells, invólucros de execução). Com um deles
 * como programa, a linha que a trava julga não é o que roda: recusados como programa de QUALQUER comando. Casa também
 * o nome com versão (`python3.11`, `node22`).
 */
export const INTERPRETER_PROGRAMS: readonly string[] = [
  "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "eval", "exec", "xargs", "sudo", "doas", "su", "nice", "ionice",
  "timeout", "nohup", "stdbuf", "time", "command", "builtin", "python", "python2", "python3", "node", "nodejs", "bun",
  "deno", "perl", "ruby", "php", "lua", "awk", "gawk", "busybox", "ssh",
];
const INTERPRETER_RE = new RegExp(`^(?:${INTERPRETER_PROGRAMS.join("|")})(?:[0-9]+(?:\\.[0-9]+)*)?$`);

function baseName(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/** O programa é um interpretador/invólucro? PURA. */
export function isInterpreterProgram(argv0: string): boolean {
  return INTERPRETER_RE.test(baseName(argv0).toLowerCase());
}

/**
 * Por que este argv não pode virar pedido (ou null). Vale para TODO comando: o principal, o desfazer e cada
 * conferência. PURA.
 */
export function argvRefusal(argv: unknown, what: string): string | null {
  if (!Array.isArray(argv) || argv.length === 0) return `${what}: precisa de ao menos o programa`;
  if (argv.length > LOCKED_EXEC_LIMITS.argvMax) return `${what}: mais de ${LOCKED_EXEC_LIMITS.argvMax} argumentos`;
  for (const [i, a] of argv.entries()) {
    if (typeof a !== "string") return `${what}: todo argumento é texto`;
    if (a.length > LOCKED_EXEC_LIMITS.argMax) return `${what}: argumento com mais de ${LOCKED_EXEC_LIMITS.argMax} caracteres`;
    if (CONTROL_OR_BIDI.test(a)) return `${what}: o argumento #${i} tem quebra de linha, caractere de controle ou de direção`;
    if (SHELL_SYNTAX.test(a)) return `${what}: o argumento #${i} tem sintaxe de shell ($(, crase, ; | & < >) — o servidor roda sem shell, e a trava julgaria outro comando`;
  }
  const program = argv[0] as string;
  if (!program.trim()) return `${what}: o programa está vazio`;
  const pathWhy = argPathRefusal(argv as string[], what);
  if (pathWhy) return pathWhy;
  if (program.includes("/")) {
    if (!program.startsWith("/")) return `${what}: programa com «/» tem de ser caminho absoluto (relativo resolveria contra o repositório)`;
    if (program.split("/").includes("..")) return `${what}: o caminho do programa não pode ter «..»`;
  }
  if (isInterpreterProgram(program)) return `${what}: «${baseName(program)}» executa o que vier nos argumentos — a trava não julgaria o que de fato roda`;
  return null;
}

/**
 * Os candidatos a CAMINHO de um argv (o programa, argv[0], tem a regra própria): cada argumento e, se ele começa com
 * «-», também o que vem depois do primeiro «=» (`--de-arquivo=x`). PURA.
 */
export function argCandidates(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of argv.slice(1)) {
    out.push(a);
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq >= 0) out.push(a.slice(eq + 1));
    }
  }
  return out;
}

/**
 * Algum argumento tem FORMA de caminho de arquivo? (`/…`, `./…`, `../…`, `~…`, `@…`, ou um segmento «..» no meio).
 * O conteúdo de um arquivo não estaria no que o dono aprova. PURA.
 */
export function argPathRefusal(argv: readonly string[], what: string): string | null {
  for (const c of argCandidates(argv)) {
    if (/^(?:@|~|\/|\.\/|\.\.\/)/.test(c) || c === "." || c === ".." || c.split("/").includes("..")) {
      return `${what}: o argumento «${c.slice(0, 80)}» parece um caminho de arquivo — o conteúdo do arquivo não estaria no que o dono aprova`;
    }
  }
  return null;
}

/** O texto que o dono lê (resumo, rótulo, plano B) não carrega quebra/controle/bidi — senão forja a tela. PURA. */
function textRefusal(s: string, what: string): string | null {
  return CONTROL_OR_BIDI.test(s) ? `${what}: sem quebra de linha, caractere de controle ou de direção` : null;
}

function normalizeCheck(raw: unknown, what: string): Normalized<LockedCheck> {
  if (!raw || typeof raw !== "object") return { ok: false, why: `${what}: não é um objeto` };
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  if (!label || label.length > LOCKED_EXEC_LIMITS.labelMax) return { ok: false, why: `${what}: o rótulo (label) é obrigatório e curto` };
  const labelWhy = textRefusal(label, `${what}: rótulo`);
  if (labelWhy) return { ok: false, why: labelWhy };
  const argvWhy = argvRefusal(o.argv, what);
  if (argvWhy) return { ok: false, why: argvWhy };
  const out: LockedCheck = { label, argv: [...(o.argv as string[])] };
  if (o.expectExit !== undefined) {
    if (!Number.isInteger(o.expectExit) || (o.expectExit as number) < 0 || (o.expectExit as number) > 255) {
      return { ok: false, why: `${what}: expectExit é um inteiro de 0 a 255` };
    }
    out.expectExit = o.expectExit as number;
  }
  if (o.expectStdout !== undefined) return { ok: false, why: `${what}: expectStdout (regex) não existe — use expectStdoutIncludes (texto literal)` };
  if (o.expectStdoutIncludes !== undefined) {
    const inc = o.expectStdoutIncludes;
    if (typeof inc !== "string" || !inc || inc.length > LOCKED_EXEC_LIMITS.expectIncludesMax) {
      return { ok: false, why: `${what}: expectStdoutIncludes é um texto de 1 a ${LOCKED_EXEC_LIMITS.expectIncludesMax} caracteres` };
    }
    const incWhy = textRefusal(inc, `${what}: expectStdoutIncludes`);
    if (incWhy) return { ok: false, why: incWhy };
    out.expectStdoutIncludes = inc;
  }
  return { ok: true, value: out };
}

/**
 * Valida e normaliza a proposta: limites, argv sem engodo, texto sem forja, a coerência «sem desfazer ⇒ plano B
 * obrigatório», ao menos uma conferência. O `cwd` é do serviço (a raiz do alvo), nunca do agente. PURA.
 */
export function normalizeLockedExecProposal(
  input: LockedExecProposalInput,
  cwd: string,
): Normalized<{ draft: LockedExecDraft; board: string; cardId: string; summary: string; why: string | null }> {
  const board = typeof input.board === "string" ? input.board.trim() : "";
  const cardId = typeof input.cardId === "string" ? input.cardId.trim() : "";
  if (!board) return { ok: false, why: "board é obrigatório" };
  // o Inbox não tem item órfão: a proposta mora no card que a pediu (e o agente do card é acordado no fim).
  if (!cardId) return { ok: false, why: "cardId é obrigatório — a proposta mora no card que a pediu" };
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (summary.length < LOCKED_EXEC_LIMITS.summaryMin || summary.length > LOCKED_EXEC_LIMITS.summaryMax) {
    return { ok: false, why: `summary: de ${LOCKED_EXEC_LIMITS.summaryMin} a ${LOCKED_EXEC_LIMITS.summaryMax} caracteres, em português simples — é o que o dono lê` };
  }
  const summaryWhy = textRefusal(summary, "summary");
  if (summaryWhy) return { ok: false, why: summaryWhy };
  const why = typeof input.why === "string" && input.why.trim() ? input.why.trim() : null;
  if (why && why.length > LOCKED_EXEC_LIMITS.whyMax) return { ok: false, why: `why: até ${LOCKED_EXEC_LIMITS.whyMax} caracteres` };
  const whyWhy = why ? textRefusal(why, "why") : null;
  if (whyWhy) return { ok: false, why: whyWhy };
  const argvWhy = argvRefusal(input.argv, "argv");
  if (argvWhy) return { ok: false, why: argvWhy };
  let undoArgv: string[] | null = null;
  if (input.undoArgv !== null && input.undoArgv !== undefined) {
    const undoWhy = argvRefusal(input.undoArgv, "undoArgv");
    if (undoWhy) return { ok: false, why: undoWhy };
    undoArgv = [...input.undoArgv];
  }
  const planRaw = typeof input.noUndoPlan === "string" ? input.noUndoPlan.trim() : "";
  if (!undoArgv && (planRaw.length < LOCKED_EXEC_LIMITS.noUndoPlanMin || planRaw.length > LOCKED_EXEC_LIMITS.noUndoPlanMax)) {
    return { ok: false, why: "sem undoArgv, o noUndoPlan (o plano B, em português) é obrigatório — o dono decide sabendo que não há volta" };
  }
  const planWhy = !undoArgv ? textRefusal(planRaw, "noUndoPlan") : null;
  if (planWhy) return { ok: false, why: planWhy };
  const noUndoPlan = undoArgv ? null : planRaw;
  const preflightRaw = input.preflight ?? [];
  if (!Array.isArray(preflightRaw) || preflightRaw.length > LOCKED_EXEC_LIMITS.preflightMax) {
    return { ok: false, why: `preflight: até ${LOCKED_EXEC_LIMITS.preflightMax} conferências` };
  }
  const verifyRaw = input.verify;
  if (!Array.isArray(verifyRaw) || verifyRaw.length < LOCKED_EXEC_LIMITS.verifyMin || verifyRaw.length > LOCKED_EXEC_LIMITS.verifyMax) {
    return { ok: false, why: `verify: de ${LOCKED_EXEC_LIMITS.verifyMin} a ${LOCKED_EXEC_LIMITS.verifyMax} conferências — sem conferência não há como desfazer sozinho` };
  }
  const preflight: LockedCheck[] = [];
  for (const [i, c] of preflightRaw.entries()) {
    const n = normalizeCheck(c, `preflight #${i + 1}`);
    if (!n.ok) return n;
    preflight.push(n.value);
  }
  const verify: LockedCheck[] = [];
  for (const [i, c] of verifyRaw.entries()) {
    const n = normalizeCheck(c, `conferência #${i + 1}`);
    if (!n.ok) return n;
    verify.push(n.value);
  }
  const t = input.timeoutSec ?? LOCKED_EXEC_LIMITS.timeoutSecDefault;
  if (!Number.isInteger(t) || t < LOCKED_EXEC_LIMITS.timeoutSecMin || t > LOCKED_EXEC_LIMITS.timeoutSecMax) {
    return { ok: false, why: `timeoutSec: inteiro de ${LOCKED_EXEC_LIMITS.timeoutSecMin} a ${LOCKED_EXEC_LIMITS.timeoutSecMax}` };
  }
  return {
    ok: true,
    value: { board, cardId, summary, why, draft: { argv: [...input.argv], undoArgv, noUndoPlan, preflight, verify, timeoutSec: t, cwd } },
  };
}

/** Todos os argv de uma spec/rascunho, com o nome do grupo (para classificar e resolver em lote). PURA. */
export function allCommands(d: LockedExecDraft): Array<{ group: "main" | "undo" | "preflight" | "verify"; index: number; argv: string[] }> {
  return [
    { group: "main" as const, index: 0, argv: d.argv },
    ...(d.undoArgv ? [{ group: "undo" as const, index: 0, argv: d.undoArgv }] : []),
    ...d.preflight.map((c, i) => ({ group: "preflight" as const, index: i, argv: c.argv })),
    ...d.verify.map((c, i) => ({ group: "verify" as const, index: i, argv: c.argv })),
  ];
}

/** JSON canônico da spec — chaves em ordem fixa, campos opcionais ausentes de verdade (não `undefined`). PURA. */
export function canonicalLockedExecSpec(s: LockedExecSpec): string {
  const check = (c: LockedCheck) => ({
    label: c.label,
    argv: c.argv,
    expectExit: c.expectExit ?? 0,
    expectStdoutIncludes: c.expectStdoutIncludes ?? null,
  });
  return JSON.stringify({
    argv: s.argv,
    undoArgv: s.undoArgv,
    noUndoPlan: s.noUndoPlan,
    preflight: s.preflight.map(check),
    verify: s.verify.map(check),
    timeoutSec: s.timeoutSec,
    cwd: s.cwd,
    programs: { main: s.programs.main, undo: s.programs.undo, preflight: s.programs.preflight, verify: s.programs.verify },
  });
}

/** sha256 (hex) da spec canônica — o que o dono aprova e o executor reconfere. PURA. */
export function lockedExecHash(s: LockedExecSpec): string {
  return createHash("sha256").update(canonicalLockedExecSpec(s)).digest("hex");
}

/** A spec de um registro (o que o hash cobre) — para reconferir o que está no disco. PURA. */
export function specOf(r: LockedExecSpec): LockedExecSpec {
  return {
    argv: r.argv,
    undoArgv: r.undoArgv,
    noUndoPlan: r.noUndoPlan,
    preflight: r.preflight,
    verify: r.verify,
    timeoutSec: r.timeoutSec,
    cwd: r.cwd,
    programs: r.programs,
  };
}

/**
 * O argv como UMA linha de shell POSIX (cada elemento entre aspas simples). É o que o classificador do host lê — a
 * trava julga texto de comando — e o que o Inbox mostra ao dono. Nunca é executado: o executor roda o argv sem shell.
 */
export function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A conferência passou? Código de saída igual ao esperado E, se declarado, o trecho literal na saída. PURA. */
export function checkPassed(check: LockedCheck, r: { exitCode: number | null; stdout: string; error?: string }): boolean {
  if (r.error) return false;
  if (r.exitCode !== (check.expectExit ?? 0)) return false;
  if (check.expectStdoutIncludes !== undefined) return r.stdout.includes(check.expectStdoutIncludes);
  return true;
}

/** O critério de uma conferência, em português, para a tela do dono. PURA. */
export function checkCriterion(check: LockedCheck): string {
  const code = `passa se terminar com código ${check.expectExit ?? 0}`;
  return check.expectStdoutIncludes !== undefined ? `${code} e a saída contiver “${check.expectStdoutIncludes}”` : code;
}

/** A cauda de uma saída (o Inbox mostra pouco; o disco guarda pouco). PURA. */
export function tailOf(s: string, n: number = LOCKED_EXEC_TAIL_CHARS): string {
  return s.length <= n ? s : `…${s.slice(s.length - n)}`;
}

/** A autorização passou do prazo sem a execução começar? PURA. */
export function lockedExecExpired(r: Pick<LockedExecRecord, "expiresAt">, now: number): boolean {
  if (!r.expiresAt) return true;
  const t = Date.parse(r.expiresAt);
  return !Number.isFinite(t) || now > t;
}

/** O prazo gravado é coerente com a decisão (nunca mais que 15 min depois dela)? PURA. */
export function lockedExecWindowValid(r: Pick<LockedExecRecord, "expiresAt" | "decidedAt">): boolean {
  const exp = Date.parse(r.expiresAt ?? "");
  const dec = Date.parse(r.decidedAt ?? "");
  return Number.isFinite(exp) && Number.isFinite(dec) && exp >= dec && exp - dec <= LOCKED_EXEC_TTL_MS;
}

/**
 * Quem pode DECIDIR (aprovar, recusar, desfazer, manter, dar «Ok»): só o operador com sessão. A server action passa
 * pelo guard comum (que deixa passar também o agente pelo MCP e o próprio serviço) e relê o chamador
 * (`resolveActionCaller`) — esta é a régua. PURA.
 */
export function mayDecideLockedExec(caller: string | null | undefined): { ok: true } | { ok: false; why: string } {
  if (caller !== "operator-session") {
    return { ok: false, why: "só o dono, na sessão dele, decide um comando travado — nem agente nem o próprio serviço" };
  }
  return { ok: true };
}
