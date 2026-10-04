// locked-exec-service — o LADO COM IO da «Execução aprovada» (o núcleo puro e as garantias estão em locked-exec.ts).
//
// O store mora em `runnerStateDir()/approved-exec/` — o diretório de estado do serviço, onde o sandbox dos agentes NÃO
// escreve (o dado de board, onde mora o precedente `approvals/`, é gravável por um run de board-data):
//   <id>.json         um pedido (spec + estado + resultado de cada passo), escrito atômico (tmp + rename);
//   <id>.claim        criado com O_EXCL por QUEM roda o comando — entre processos, só um ganha;
//   <id>.undo.claim   o mesmo, para o desfazer pedido pelo dono;
//   audit.jsonl       quem propôs/aprovou/recusou/rodou/desfez, quando e com que desfecho.
//
// Quem chama o quê:
//   · `propose`  — a tool MCP do agente. Não executa NADA: confere o card e o escopo do agente, resolve o PROGRAMA de
//                  cada comando (o caminho real, fora do repositório), classifica todos pela trava do host e grava o
//                  pedido pendente;
//   · `approve` / `reject` / `undo` / `keep` / `ack` — as server actions do DONO (operator-session; a régua é
//                  `mayDecideLockedExec`, reaplicada AQUI para nenhuma outra porta esquecê-la);
//   · `recoverOnBoot` — a instrumentação, uma vez por processo. NUNCA executa.
//
// A EXECUÇÃO só parte da aprovação EM MEMÓRIA deste processo (o `grants` que `approve` preenche): o disco diz o estado,
// mas não autoriza — um registro `approved` escrito por outra mão (ou que sobreviveu a um restart) não roda nada.
// Antes de rodar: reconfere hash e prazo, ganha o claim exclusivo, reclassifica TODOS os comandos, resolve de novo os
// programas (o mesmo caminho real, senão «stale»), refaz o preflight; roda sem shell; confere; desfaz se falhar.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile } from "@/lib/storymap/atomic-write";
import { findRepoRoot, runnerStateDir } from "@/lib/storymap/paths";
import {
  LOCKED_EXEC_CHECK_TIMEOUT_MS,
  LOCKED_EXEC_CWD,
  LOCKED_EXEC_FINAL,
  LOCKED_EXEC_LIST_RETENTION_MS,
  LOCKED_EXEC_MAX_PENDING_PER_BOARD,
  LOCKED_EXEC_MAX_PENDING_PER_CARD,
  LOCKED_EXEC_TTL_MS,
  allCommands,
  argCandidates,
  checkPassed,
  lockedExecExpired,
  lockedExecHash,
  lockedExecWindowValid,
  mayDecideLockedExec,
  normalizeLockedExecProposal,
  specOf,
  tailOf,
  type LockedCheck,
  type LockedExecDraft,
  type LockedExecProposalInput,
  type LockedExecPrograms,
  type LockedExecRecord,
  type LockedExecStep,
} from "./locked-exec";
import { checkPrefixesFromEnv, classifierFromEnv, matchesCheckPrefix, type ClassifyFn } from "./locked-exec-classifier";
import { notifyLockedExec } from "./locked-exec-notify";
import { elideCredentialBytes } from "./findings";
import { lookupOnPath } from "./host-tools";
import { sanitizeSpawnEnv } from "./spawn-env";

/** O que um passo devolve. `stdout` é a saída INTEIRA (até o teto) — a conferência a lê; o disco guarda só a cauda. */
export interface LockedExecRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Roda UM processo, sem shell, com teto. `argv[0]` é o caminho ABSOLUTO já resolvido. Nunca lança: falha vira `error`.
 * Injetável no teste.
 */
export type LockedExecRunFn = (argv: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<LockedExecRunResult>;

/** O teto de saída guardada em memória por stream (passou, fica a parte final — a conferência lê a cauda). */
export const LOCKED_EXEC_OUTPUT_CAP = 4 * 1024 * 1024;

class CappedText {
  private chunks: string[] = [];
  private size = 0;
  truncated = false;
  push(b: Buffer): void {
    const s = b.toString("utf8");
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > LOCKED_EXEC_OUTPUT_CAP && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.truncated = true;
    }
  }
  text(): string {
    const all = this.chunks.join("");
    return all.length > LOCKED_EXEC_OUTPUT_CAP ? all.slice(all.length - LOCKED_EXEC_OUTPUT_CAP) : all;
  }
}

/**
 * O executor de produção. O filho nasce num GRUPO próprio (`detached`): no tempo esgotado o timer mata o grupo inteiro
 * com SIGKILL — um programa que ignora SIGTERM, ou um neto que segurasse os pipes, não prende o serviço. stdin fechado:
 * um comando que pergunta algo não espera ninguém (e vira falha).
 */
export const defaultLockedExecRun: LockedExecRunFn = (argv, opts) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (r: LockedExecRunResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd,
        env: sanitizeSpawnEnv(process.env),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finish({ exitCode: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const out = new CappedText();
    const errOut = new CappedText();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* já morreu */
        }
      }
    }, opts.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => out.push(b));
    child.stderr?.on("data", (b: Buffer) => errOut.push(b));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ exitCode: null, stdout: out.text(), stderr: errOut.text(), error: e.message.split("\n")[0] });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const error = timedOut ? `tempo esgotado (${Math.round(opts.timeoutMs / 1000)} s)` : code === null ? `encerrado pelo sinal ${signal ?? "?"}` : undefined;
      finish({ exitCode: timedOut ? null : code, stdout: out.text(), stderr: errOut.text(), ...(error ? { error } : {}) });
    });
  });

/**
 * Redige SEGREDO de uma saída antes de ela ir ao disco ou ao Inbox: as formas conhecidas (token OAuth, chave PEM,
 * campos de credencial em JSON, Bearer, chave de acesso) e, por cima, o elisor de bytes com forma de credencial do
 * runner (findings.ts `elideCredentialBytes`). PURA.
 */
export function redactSecrets(text: string): string {
  return redactOnce(text);
}

/**
 * A saída de um passo, pronta para o disco: redigida linha a linha E com as linhas juntas (um segredo partido em duas
 * linhas também é pego); se o texto junto revela algo que o por-linha não via, guarda a versão junta (sem quebras).
 * Corta a cauda DEPOIS de redigir. Defesa em profundidade: o agente nunca recebe a saída. PURA.
 */
export function redactOutput(text: string): string {
  const perLine = redactOnce(text);
  const joined = perLine.replace(/\r?\n/g, "");
  const joinedRed = redactOnce(joined);
  return tailOf(joinedRed !== joined ? joinedRed : perLine);
}

function redactOnce(text: string): string {
  const red = "[redigido]";
  const out = text
    .replace(/-----BEGIN [^-]*-----[\s\S]*?(?:-----END [^-]*-----|$)/g, red)
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, red)
    .replace(/("(?:refresh_token|client_secret|private_key|private_key_id|access_token|id_token|password|secret|api_key|apiKey)"\s*:\s*)"(?:[^"\\]|\\.)*"/g, `$1"${red}"`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${red}`)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, red);
  return elideCredentialBytes(out);
}

export interface LockedExecServiceDeps {
  stateDir?: () => string;
  /** o classificador da trava do host — ou o porquê de a feature estar inerte. Resolvido por chamada. */
  classifier?: () => { ok: true; classify: ClassifyFn } | { ok: false; why: string };
  run?: LockedExecRunFn;
  now?: () => number;
  /** o aviso de falha (o barramento). Só é chamado nos estados que avisam (o notificador filtra de novo). */
  notify?: (r: LockedExecRecord) => void;
  /** acorda o agente do card com o desfecho. Nunca deve lançar. */
  wake?: (board: string, cardId: string, line: string) => void;
  log?: (msg: string) => void;
  repoRoot?: () => string;
  /** como começar a execução sem prender a action (padrão: setImmediate). */
  defer?: (fn: () => void) => void;
  /** o caminho REAL e absoluto do programa de um argv — ou o porquê de não servir. */
  resolveProgram?: (argv0: string) => { ok: true; path: string } | { ok: false; why: string };
  /** o card existe no board? (a proposta mora num card real) */
  cardExists?: (board: string, cardId: string) => Promise<boolean>;
  /** gravação atômica (injetável para provar o que acontece quando o disco falha). */
  write?: (file: string, content: string) => Promise<void>;
  /** cria o arquivo de claim com O_EXCL: true = ganhou; false = outro já tinha. Erro de disco lança. */
  claim?: (file: string) => Promise<boolean>;
  /** os prefixos de argv que o HOST libera para conferir (preflight/verify) — ou o porquê de a função estar inerte. */
  checkPrefixes?: () => { ok: true; prefixes: string[][] } | { ok: false; why: string };
  /** o diretório de trabalho de UM passo: novo e vazio; `cleanup` o apaga. */
  workDir?: () => Promise<{ path: string; cleanup: () => Promise<void> }>;
  /** existe algo neste caminho? (lstat: um link quebrado também conta) */
  exists?: (p: string) => boolean;
}

/** Quem propõe, visto pela tool: um agente escopado só propõe para o card que ele conduz. */
export interface LockedExecProposer {
  by: string;
  scoped: boolean;
  /** o card do escopo do agente (o da sessão que ele conduz); null = não se sabe. Ignorado quando `scoped` é false. */
  scopeCardId: string | null;
}

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; why: string };

const ID_RE = /^lx-[0-9a-f]{10}$/;

/** Resolve o programa no PATH do serviço (ou o absoluto), pelo caminho REAL, e exige que ele esteja FORA do alvo. */
export function makeProgramResolver(repoRoot: () => string, env: NodeJS.ProcessEnv = process.env) {
  return (argv0: string): { ok: true; path: string } | { ok: false; why: string } => {
    const clean = sanitizeSpawnEnv(env);
    const found = path.isAbsolute(argv0) ? argv0 : argv0.includes("/") ? null : lookupOnPath(argv0, clean);
    if (!found) return { ok: false, why: `programa «${argv0}» não encontrado no PATH do serviço` };
    let real: string;
    let root: string;
    try {
      real = realpathSync(found);
    } catch {
      return { ok: false, why: `programa «${argv0}» não existe` };
    }
    try {
      root = realpathSync(repoRoot());
    } catch {
      return { ok: false, why: "a raiz do repositório alvo não se resolve" };
    }
    const rel = path.relative(root, real);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { ok: false, why: `o programa «${argv0}» mora dentro do repositório alvo (${real}) — um agente o editaria` };
    }
    return { ok: true, path: real };
  };
}

async function defaultCardExists(board: string, cardId: string): Promise<boolean> {
  try {
    const { readCard } = await import("@/lib/storymap/repo");
    return !!(await readCard(board, cardId));
  } catch {
    return false;
  }
}

async function defaultWorkDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "lx-passo-"));
  await fsp.chmod(dir, 0o700);
  return { path: dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

function defaultExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultClaim(file: string): Promise<boolean> {
  try {
    const h = await fsp.open(file, "wx");
    await h.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

const EXEC_CHECK_HINT = "a lista do host em AGILEHARNESS_EXEC_CHECK_PREFIXES";
const GROUP_WORDS = { main: "o comando", undo: "o desfazer", preflight: "preflight", verify: "conferência" } as const;
const groupLabel = (g: keyof typeof GROUP_WORDS, i: number) => (g === "main" || g === "undo" ? GROUP_WORDS[g] : `${GROUP_WORDS[g]} #${i + 1}`);

export class LockedExecService {
  private readonly d: Required<Omit<LockedExecServiceDeps, "classifier">> & Pick<LockedExecServiceDeps, "classifier">;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  /** As aprovações DESTE processo — a única origem de uma execução. id → o hash aprovado e o prazo. */
  private readonly grants = new Map<string, { hash: string; expiresAt: number }>();

  constructor(deps: LockedExecServiceDeps = {}) {
    const repoRoot = deps.repoRoot ?? findRepoRoot;
    const log = deps.log ?? ((m: string) => console.log(`[locked-exec] ${m}`));
    this.d = {
      stateDir: deps.stateDir ?? (() => path.join(runnerStateDir(), "approved-exec")),
      classifier: deps.classifier,
      run: deps.run ?? defaultLockedExecRun,
      now: deps.now ?? Date.now,
      notify: deps.notify ?? ((r) => notifyLockedExec(r)),
      wake:
        deps.wake ??
        ((board, cardId, line) => {
          void import("./conductor-pause-deps")
            .then((m) => m.wakeConductorNow(board, cardId, [], "owner", line))
            .then((outcome) => log(`${board}/${cardId}: agente do card avisado (${outcome})`))
            .catch((err) => log(`${board}/${cardId}: não foi possível avisar o agente — ${err instanceof Error ? err.message : String(err)}`));
        }),
      log,
      repoRoot,
      defer: deps.defer ?? ((fn) => void setImmediate(fn)),
      resolveProgram: deps.resolveProgram ?? makeProgramResolver(repoRoot),
      cardExists: deps.cardExists ?? defaultCardExists,
      write: deps.write ?? atomicWriteFile,
      claim: deps.claim ?? defaultClaim,
      checkPrefixes: deps.checkPrefixes ?? (() => checkPrefixesFromEnv(process.env)),
      workDir: deps.workDir ?? defaultWorkDir,
      exists: deps.exists ?? defaultExists,
    };
  }

  private classifierOrWhy(): { ok: true; classify: ClassifyFn } | { ok: false; why: string } {
    try {
      return this.d.classifier ? this.d.classifier() : classifierFromEnv(this.d.repoRoot);
    } catch (err) {
      return { ok: false, why: `a trava do host não pôde ser consultada: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── o store ────────────────────────────────────────────────────────────────────────────────────────

  private file(id: string, suffix = ".json"): string {
    return path.join(this.d.stateDir(), `${id}${suffix}`);
  }

  /** Serializa as escritas (ler-conferir-gravar) deste processo. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async get(id: string): Promise<LockedExecRecord | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file(id), "utf8")) as LockedExecRecord;
      return raw && raw.v === 1 && raw.id === id ? raw : null;
    } catch {
      return null;
    }
  }

  /** Todos os pedidos — menos os desfechos finais arquivados há mais de 30 dias (os arquivos e a auditoria ficam). */
  async list(): Promise<LockedExecRecord[]> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.d.stateDir());
    } catch {
      return [];
    }
    const cutoff = this.d.now() - LOCKED_EXEC_LIST_RETENTION_MS;
    const out: LockedExecRecord[] = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      const r = await this.get(n.slice(0, -5));
      if (!r) continue;
      const at = Date.parse(r.ackedAt ?? r.finishedAt ?? r.decidedAt ?? r.proposedAt);
      if (LOCKED_EXEC_FINAL.has(r.status) && r.ackedAt && Number.isFinite(at) && at < cutoff) continue;
      out.push(r);
    }
    return out.sort((a, z) => a.proposedAt.localeCompare(z.proposedAt));
  }

  /** Os pedidos que o Inbox de um board mostra: tudo que o dono ainda não arquivou. */
  async listForBoard(board: string): Promise<LockedExecRecord[]> {
    return (await this.list()).filter((r) => r.board === board && !r.ackedAt);
  }

  private async write(r: LockedExecRecord): Promise<void> {
    await fsp.mkdir(this.d.stateDir(), { recursive: true });
    await this.d.write(this.file(r.id), `${JSON.stringify(r, null, 2)}\n`);
  }

  private async audit(entry: Record<string, unknown>): Promise<void> {
    try {
      await fsp.mkdir(this.d.stateDir(), { recursive: true });
      await fsp.appendFile(path.join(this.d.stateDir(), "audit.jsonl"), `${JSON.stringify({ at: new Date(this.d.now()).toISOString(), ...entry })}\n`);
    } catch (err) {
      this.d.log(`auditoria falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── classificar e resolver ─────────────────────────────────────────────────────────────────────────

  /** Os programas de todos os comandos (o caminho real). Falhou um ⇒ o motivo, nomeando qual. */
  private resolvePrograms(d: LockedExecDraft): ServiceResult<LockedExecPrograms> {
    const at = (argv: string[], what: string): ServiceResult<string> => {
      const r = this.d.resolveProgram(argv[0]);
      return r.ok ? { ok: true, value: r.path } : { ok: false, why: `${what}: ${r.why}` };
    };
    const main = at(d.argv, "o comando");
    if (!main.ok) return main;
    let undo: string | null = null;
    if (d.undoArgv) {
      const u = at(d.undoArgv, "o desfazer");
      if (!u.ok) return u;
      undo = u.value;
    }
    const preflight: string[] = [];
    for (const [i, c] of d.preflight.entries()) {
      const p = at(c.argv, `preflight #${i + 1}`);
      if (!p.ok) return p;
      preflight.push(p.value);
    }
    const verify: string[] = [];
    for (const [i, c] of d.verify.entries()) {
      const p = at(c.argv, `conferência #${i + 1}`);
      if (!p.ok) return p;
      verify.push(p.value);
    }
    return { ok: true, value: { main: main.value, undo, preflight, verify } };
  }

  /** Toda conferência começa com um prefixo que o HOST liberou para conferir? */
  private checksAllowed(d: LockedExecDraft, programs: LockedExecPrograms, prefixes: string[][]): ServiceResult<true> {
    const groups: Array<["preflight" | "verify", LockedCheck[], string[]]> = [
      ["preflight", d.preflight, programs.preflight],
      ["verify", d.verify, programs.verify],
    ];
    for (const [g, checks, progs] of groups) {
      for (const [i, c] of checks.entries()) {
        if (!matchesCheckPrefix(c.argv, progs[i], prefixes, this.d.resolveProgram)) {
          return { ok: false, why: `${groupLabel(g, i)}: não é um comando que o servidor liberou para conferir (${EXEC_CHECK_HINT})` };
        }
      }
    }
    return { ok: true, value: true };
  }

  /**
   * Classifica TODOS os comandos pela trava (em paralelo): o principal tem de ser travado E aprovável; o desfazer, se
   * travado, aprovável; toda conferência, LIVRE. Devolve a classificação do principal, ou o motivo da recusa.
   */
  private async classifyAll(classify: ClassifyFn, d: LockedExecDraft): Promise<ServiceResult<{ rule?: string; klass?: string; reason?: string }>> {
    const cmds = allCommands(d);
    const results = await Promise.all(cmds.map((c) => classify(c.argv)));
    for (const [i, r] of results.entries()) {
      const c = cmds[i];
      if (!r.ok) return { ok: false, why: r.why };
      const what = groupLabel(c.group, c.index);
      if (c.group === "main") {
        if (!r.c.locked) return { ok: false, why: "este comando não está travado — a trava não o recusa a agentes, então rode você mesmo" };
        if (!r.c.approvable) return { ok: false, why: `a trava não deixa este comando ganhar o botão${r.c.reason ? `: ${r.c.reason}` : ""} — ele continua só do dono, no terminal` };
      } else if (c.group === "undo") {
        if (r.c.locked && !r.c.approvable) return { ok: false, why: `o desfazer é travado e não aprovável${r.c.reason ? `: ${r.c.reason}` : ""}` };
      } else if (r.c.locked) {
        return { ok: false, why: `${what} é um comando travado — conferência tem de ser só leitura` };
      }
    }
    const main = results[0] as Extract<(typeof results)[number], { ok: true }>;
    return { ok: true, value: { ...(main.c.rule ? { rule: main.c.rule } : {}), ...(main.c.klass ? { klass: main.c.klass } : {}), ...(main.c.reason ? { reason: main.c.reason } : {}) } };
  }

  // ── a proposta (o agente) ──────────────────────────────────────────────────────────────────────────

  /**
   * O agente propõe. NADA roda aqui — nem o comando, nem as conferências: o serviço não tem a jaula do agente, e um
   * comando escolhido pelo agente rodaria como o serviço, sem clique de ninguém. Tudo o que este serviço executa —
   * preflight, comando, conferências, desfazer — entrou no hash que o DONO aprovou. (O agente confere a situação antes
   * de propor, na jaula dele.) O mesmo pedido pendente volta em vez de empilhar.
   */
  async propose(input: LockedExecProposalInput, proposer: LockedExecProposer | string): Promise<ServiceResult<LockedExecRecord>> {
    const who: LockedExecProposer = typeof proposer === "string" ? { by: proposer, scoped: false, scopeCardId: null } : proposer;
    const cl = this.classifierOrWhy();
    if (!cl.ok) return { ok: false, why: cl.why };
    const prefixes = this.d.checkPrefixes();
    if (!prefixes.ok) return { ok: false, why: prefixes.why };
    const n = normalizeLockedExecProposal(input, LOCKED_EXEC_CWD);
    if (!n.ok) return { ok: false, why: n.why };
    const { draft, board, cardId } = n.value;

    if (who.scoped && who.scopeCardId !== cardId) {
      return { ok: false, why: who.scopeCardId ? `um agente escopado só propõe para o card que conduz (${who.scopeCardId})` : "um agente escopado só propõe para o card que conduz — esta sessão não conduz nenhum" };
    }
    if (!(await this.d.cardExists(board, cardId))) return { ok: false, why: `card não encontrado: ${board}/${cardId}` };

    const programs = this.resolvePrograms(draft);
    if (!programs.ok) return programs;
    const allowed = this.checksAllowed(draft, programs.value, prefixes.prefixes);
    if (!allowed.ok) return allowed;
    const classified = await this.classifyAll(cl.classify, draft);
    if (!classified.ok) return classified;

    const spec = { ...draft, programs: programs.value };
    const hash = lockedExecHash(spec);
    return this.serial(async (): Promise<ServiceResult<LockedExecRecord>> => {
      const all = await this.list();
      const same = all.find((r) => r.status === "pending" && r.hash === hash && r.board === board && r.cardId === cardId);
      if (same) return { ok: true, value: same };
      const pending = all.filter((r) => r.status === "pending");
      if (pending.filter((r) => r.board === board && r.cardId === cardId).length >= LOCKED_EXEC_MAX_PENDING_PER_CARD) {
        return { ok: false, why: `este card já tem ${LOCKED_EXEC_MAX_PENDING_PER_CARD} pedidos esperando o dono — espere a decisão dele` };
      }
      if (pending.filter((r) => r.board === board).length >= LOCKED_EXEC_MAX_PENDING_PER_BOARD) {
        return { ok: false, why: `este board já tem ${LOCKED_EXEC_MAX_PENDING_PER_BOARD} pedidos esperando o dono — espere as decisões dele` };
      }
      const rec: LockedExecRecord = {
        v: 1,
        id: `lx-${randomBytes(5).toString("hex")}`,
        board,
        cardId,
        summary: n.value.summary,
        why: n.value.why,
        ...spec,
        hash,
        classification: classified.value,
        proposedBy: who.by,
        proposedAt: new Date(this.d.now()).toISOString(),
        status: "pending",
        results: [],
      };
      await this.write(rec);
      await this.audit({ action: "propose", id: rec.id, board, cardId, by: who.by, hash });
      return { ok: true, value: rec };
    });
  }

  // ── as decisões do dono ────────────────────────────────────────────────────────────────────────────

  /**
   * O DONO aprova o pedido EXATO que viu (`hash`). Grava a autorização no disco (o estado) e EM MEMÓRIA (a única coisa
   * que deixa a execução partir), com prazo de 15 min, e dispara a execução sem prender a action.
   */
  async approve(input: { id: string; hash: string; caller: string | null; via?: string }): Promise<ServiceResult<LockedExecRecord>> {
    const may = mayDecideLockedExec(input.caller);
    if (!may.ok) return { ok: false, why: may.why };
    const out = await this.serial(async (): Promise<ServiceResult<LockedExecRecord>> => {
      const r = await this.get(String(input.id ?? ""));
      if (!r) return { ok: false, why: "pedido não encontrado" };
      if (r.status !== "pending") return { ok: false, why: `este pedido já foi decidido (${r.status})` };
      if (input.hash !== r.hash || lockedExecHash(specOf(r)) !== r.hash) {
        return { ok: false, why: "o pedido mudou desde que você o viu — recarregue e confira de novo" };
      }
      const now = this.d.now();
      const next: LockedExecRecord = {
        ...r,
        status: "approved",
        decidedAt: new Date(now).toISOString(),
        approvedHash: r.hash,
        approvedVia: input.via ?? "inbox",
        expiresAt: new Date(now + LOCKED_EXEC_TTL_MS).toISOString(),
      };
      await this.write(next);
      this.grants.set(r.id, { hash: r.hash, expiresAt: now + LOCKED_EXEC_TTL_MS });
      await this.audit({ action: "approve", id: r.id, by: input.caller, hash: r.hash, expiresAt: next.expiresAt });
      return { ok: true, value: next };
    });
    if (out.ok) this.startRun(out.value.id);
    return out;
  }

  /** O dono recusa: nada roda, e o item sai do Inbox na hora (o agente do card é avisado). */
  async reject(input: { id: string; caller: string | null; reason?: string | null }): Promise<ServiceResult<LockedExecRecord>> {
    const may = mayDecideLockedExec(input.caller);
    if (!may.ok) return { ok: false, why: may.why };
    const out = await this.serial(async (): Promise<ServiceResult<LockedExecRecord>> => {
      const r = await this.get(String(input.id ?? ""));
      if (!r) return { ok: false, why: "pedido não encontrado" };
      if (r.status !== "pending") return { ok: false, why: `este pedido já foi decidido (${r.status})` };
      const reason = (input.reason ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 600);
      const at = new Date(this.d.now()).toISOString();
      const next: LockedExecRecord = { ...r, status: "rejected", decidedAt: at, ackedAt: at, ...(reason ? { rejectReason: reason } : {}) };
      await this.write(next);
      await this.audit({ action: "reject", id: r.id, by: input.caller, ...(reason ? { reason } : {}) });
      return { ok: true, value: next };
    });
    if (out.ok) this.d.wake(out.value.board, out.value.cardId, wakeText(out.value));
    return out;
  }

  /**
   * O dono manda DESFAZER um comando que deu certo. Antes de aceitar: o pedido no disco ainda é o que ele aprovou, o
   * desfazer ainda é aceitável pela trava e o programa dele é o mesmo. Roda uma vez, fora da action.
   */
  async undo(input: { id: string; caller: string | null }): Promise<ServiceResult<LockedExecRecord>> {
    const may = mayDecideLockedExec(input.caller);
    if (!may.ok) return { ok: false, why: may.why };
    const pre = await this.get(String(input.id ?? ""));
    if (!pre) return { ok: false, why: "pedido não encontrado" };
    if (pre.status !== "done") return { ok: false, why: `só dá para desfazer um comando que rodou e deu certo (este está «${pre.status}»)` };
    if (!pre.undoArgv || !pre.programs.undo) return { ok: false, why: "este comando não tem desfazer" };
    const check = await this.undoStillValid(pre);
    if (!check.ok) return check;
    const out = await this.serial(async (): Promise<ServiceResult<LockedExecRecord>> => {
      const r = await this.get(pre.id);
      if (!r || r.status !== "done" || r.hash !== pre.hash) return { ok: false, why: "o pedido mudou — recarregue" };
      if (this.inflight.has(r.id)) return { ok: false, why: "este pedido já está rodando" };
      const next: LockedExecRecord = { ...r, status: "running", phase: "undo" };
      await this.write(next);
      await this.audit({ action: "undo-requested", id: r.id, by: input.caller });
      return { ok: true, value: next };
    });
    if (out.ok) this.startUndo(out.value.id);
    return out;
  }

  /** O desfazer ainda vale? Hash aprovado, programa igual, a trava ainda o aceita. */
  private async undoStillValid(r: LockedExecRecord): Promise<ServiceResult<true>> {
    if (!r.approvedHash || r.hash !== r.approvedHash || lockedExecHash(specOf(r)) !== r.approvedHash) {
      return { ok: false, why: "o pedido gravado não é mais o que o dono aprovou — o desfazer não roda" };
    }
    if (!r.undoArgv || !r.programs.undo) return { ok: false, why: "este comando não tem desfazer" };
    const prog = this.d.resolveProgram(r.undoArgv[0]);
    if (!prog.ok || prog.path !== r.programs.undo) return { ok: false, why: "o programa do desfazer mudou desde a aprovação — confira à mão" };
    const cl = this.classifierOrWhy();
    if (!cl.ok) return { ok: false, why: cl.why };
    const k = await cl.classify(r.undoArgv);
    if (!k.ok) return { ok: false, why: k.why };
    if (k.c.locked && !k.c.approvable) return { ok: false, why: "a trava não aceita mais este desfazer — confira à mão" };
    return { ok: true, value: true };
  }

  /** O dono MANTÉM um comando que deu certo: o item sai do Inbox (o desfazer deixa de ser oferecido). */
  async keep(input: { id: string; caller: string | null }): Promise<ServiceResult<LockedExecRecord>> {
    return this.finalize(input, (r) => r.status === "done", "kept", "só um comando que rodou e deu certo pode ser mantido");
  }

  /** O dono dá «Ok» num desfecho que só informa (falhou, desfeito, recusado, expirado, desatualizado). */
  async ack(input: { id: string; caller: string | null }): Promise<ServiceResult<LockedExecRecord>> {
    return this.finalize(input, (r) => LOCKED_EXEC_FINAL.has(r.status) && r.status !== "kept", null, "este pedido ainda não terminou");
  }

  private async finalize(
    input: { id: string; caller: string | null },
    allowed: (r: LockedExecRecord) => boolean,
    to: "kept" | null,
    refusal: string,
  ): Promise<ServiceResult<LockedExecRecord>> {
    const may = mayDecideLockedExec(input.caller);
    if (!may.ok) return { ok: false, why: may.why };
    return this.serial(async (): Promise<ServiceResult<LockedExecRecord>> => {
      const r = await this.get(String(input.id ?? ""));
      if (!r) return { ok: false, why: "pedido não encontrado" };
      if (r.ackedAt) return { ok: true, value: r };
      if (!allowed(r)) return { ok: false, why: refusal };
      const next: LockedExecRecord = { ...r, ...(to ? { status: to } : {}), ackedAt: new Date(this.d.now()).toISOString() };
      await this.write(next);
      await this.audit({ action: to ?? "ack", id: r.id, by: input.caller });
      return { ok: true, value: next };
    });
  }

  // ── a execução (só deste serviço, só da aprovação em memória) ───────────────────────────────────────

  private track(p: Promise<void>): void {
    const tracked = p
      .catch((err) => this.d.log(`execução em segundo plano falhou: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  private startRun(id: string): void {
    this.d.defer(() => this.track(this.execute(id)));
  }

  private startUndo(id: string): void {
    this.d.defer(() => this.track(this.executeUndo(id)));
  }

  /** Espera as execuções em voo (o teste, e o desligamento). */
  async flush(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
    await this.chain;
  }

  /** O desfecho: grava, audita, avisa (se for o caso) e acorda o agente do card. Lança só se o disco falhar. */
  private async settle(r: LockedExecRecord, action: string): Promise<void> {
    await this.serial(async () => {
      await this.write(r);
      await this.audit({ action, id: r.id, status: r.status, ...(r.error ? { error: r.error } : {}) });
    });
    try {
      this.d.notify(r);
    } catch {
      /* o aviso nunca derruba o desfecho */
    }
    if (r.status !== "kept") this.d.wake(r.board, r.cardId, wakeText(r));
    this.d.log(`${r.board}/${r.cardId} ${r.id}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
  }

  /** Último recurso: algo lançou no meio — tenta gravar «failed»; se nem isso der, só o log sobra. Nunca lança. */
  private async failSafe(id: string, err: unknown, phase: string): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.d.log(`${id}: erro interno (${phase}) — ${msg}`);
    try {
      const r = await this.get(id);
      if (r && r.status === "running") {
        const base: LockedExecRecord = { ...r, status: "failed", finishedAt: new Date(this.d.now()).toISOString(), error: `erro interno: ${msg} — confira à mão o estado` };
        delete base.phase;
        await this.settle(base, "finish");
      }
    } catch (err2) {
      this.d.log(`${id}: nem a falha pôde ser gravada — ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
  }

  /**
   * A EXECUÇÃO de um pedido aprovado. Só parte da aprovação EM MEMÓRIA deste processo (consumida aqui: uso único); o
   * disco tem de concordar (approved, mesmo hash, prazo coerente); e o claim `<id>.claim` (O_EXCL) decide, entre
   * processos, quem roda. Sem a aprovação em memória, NADA acontece — nem o estado no disco é tocado.
   */
  async execute(id: string): Promise<void> {
    if (this.inflight.has(id)) return;
    const grant = this.grants.get(id);
    if (!grant) {
      this.d.log(`${id}: sem aprovação deste processo — nada roda`);
      return;
    }
    this.inflight.add(id);
    try {
      const claimed = await this.serial(async (): Promise<LockedExecRecord | null> => {
        const r = await this.get(id);
        if (!r || r.status !== "approved") return null;
        // a aprovação é de uso único: consumida já, roda ou não
        this.grants.delete(id);
        const now = this.d.now();
        const end = (status: "expired" | "failed", error: string): LockedExecRecord => ({ ...r, status, finishedAt: new Date(now).toISOString(), error });
        if (now > grant.expiresAt || lockedExecExpired(r, now) || !lockedExecWindowValid(r)) {
          return end("expired", "a execução não começou dentro dos 15 minutos da autorização");
        }
        if (!r.approvedHash || grant.hash !== r.approvedHash || r.hash !== r.approvedHash || lockedExecHash(specOf(r)) !== r.approvedHash) {
          return end("failed", "o pedido gravado não é mais o que o dono aprovou — nada rodou");
        }
        if (!(await this.d.claim(this.file(id, ".claim")))) {
          this.d.log(`${id}: outro processo já roda este pedido`);
          return null;
        }
        const running: LockedExecRecord = { ...r, status: "running", startedAt: new Date(now).toISOString() };
        await this.write(running);
        await this.audit({ action: "claim", id });
        return running;
      });
      if (!claimed) return;
      if (claimed.status !== "running") {
        await this.settle(claimed, claimed.status);
        return;
      }
      await this.settle(await this.runSteps(claimed), "finish");
    } catch (err) {
      await this.failSafe(id, err, "execução");
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * Roda UM passo num diretório NOVO e VAZIO. Antes, confere que nenhum argumento aponta para algo que exista ali (o
   * conteúdo de um arquivo não estaria no que o dono aprova): achou ⇒ `blocked`, e o passo não roda. O diretório é
   * apagado depois. Nunca lança por causa do passo (o erro vira resultado).
   */
  private async stepRun(argv: readonly string[], program: string, timeoutMs: number): Promise<{ blocked: string } | { result: LockedExecRunResult }> {
    const wd = await this.d.workDir();
    try {
      for (const c of argCandidates(argv)) {
        if (this.d.exists(path.resolve(wd.path, c))) {
          return { blocked: `o argumento «${c.slice(0, 80)}» aponta para um arquivo que existe — o conteúdo dele não estaria no que o dono aprovou` };
        }
      }
      return { result: await this.d.run([program, ...argv.slice(1)], { cwd: wd.path, timeoutMs }) };
    } finally {
      await wd.cleanup().catch((err) => this.d.log(`diretório do passo não apagado: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  private async runCheck(c: LockedCheck, program: string, name: string): Promise<{ blocked: string } | { step: LockedExecStep }> {
    const t0 = this.d.now();
    const out = await this.stepRun(c.argv, program, LOCKED_EXEC_CHECK_TIMEOUT_MS);
    if ("blocked" in out) return out;
    return { step: stepOf(name, out.result, checkPassed(c, out.result), this.d.now() - t0) };
  }

  /** Os passos: reclassifica e re-resolve tudo, refaz o preflight, roda, confere, desfaz se preciso. Nunca lança. */
  private async runSteps(r: LockedExecRecord): Promise<LockedExecRecord> {
    const results: LockedExecStep[] = [];
    const end = (status: LockedExecRecord["status"], extra: Partial<LockedExecRecord> = {}): LockedExecRecord => ({
      ...r,
      ...extra,
      status,
      results,
      finishedAt: new Date(this.d.now()).toISOString(),
    });

    // a trava ainda deixa TUDO? (a configuração do host pode ter mudado desde a proposta)
    const cl = this.classifierOrWhy();
    if (!cl.ok) return end("stale", { error: cl.why });
    const k = await this.classifyAll(cl.classify, r);
    if (!k.ok) return end("stale", { error: `a trava mudou desde a aprovação: ${k.why} — nada rodou` });
    // os programas ainda são os que o dono viu?
    const progs = this.resolvePrograms(r);
    if (!progs.ok) return end("stale", { error: `${progs.why} — nada rodou` });
    if (JSON.stringify(progs.value) !== JSON.stringify(r.programs)) return end("stale", { error: "um programa mudou de lugar desde a aprovação — nada rodou" });
    // as conferências ainda são as que o host libera?
    const prefixes = this.d.checkPrefixes();
    if (!prefixes.ok) return end("stale", { error: `${prefixes.why} — nada rodou` });
    const allowed = this.checksAllowed(r, r.programs, prefixes.prefixes);
    if (!allowed.ok) return end("stale", { error: `${allowed.why} — nada rodou` });

    // ainda faz sentido? (a decisão do dono: reconferir antes de rodar)
    for (const [i, c] of r.preflight.entries()) {
      const pf = await this.runCheck(c, r.programs.preflight[i], `preflight:${i}`);
      if ("blocked" in pf) return end("stale", { error: `${pf.blocked} — nada rodou` });
      results.push(pf.step);
      if (!pf.step.ok) return end("stale", { error: `a situação mudou: o preflight «${c.label}» não passou — nada rodou` });
    }

    const t0 = this.d.now();
    const mainRun = await this.stepRun(r.argv, r.programs.main, r.timeoutSec * 1000);
    if ("blocked" in mainRun) return end("stale", { error: `${mainRun.blocked} — nada rodou` });
    const main = mainRun.result;
    const mainOk = !main.error && main.exitCode === 0;
    results.push(stepOf("main", main, mainOk, this.d.now() - t0));
    if (!mainOk) {
      // o comando falhou: não se desfaz o que não aconteceu (e um desfazer sobre estado desconhecido pode piorar)
      return end("failed", { error: `o comando falhou (${main.error ?? `saída ${main.exitCode}`})` });
    }

    const failedChecks: string[] = [];
    for (const [i, c] of r.verify.entries()) {
      const v = await this.runCheck(c, r.programs.verify[i], `verify:${i}`);
      if ("blocked" in v) {
        // o comando JÁ rodou: uma conferência barrada conta como conferência que falhou (e o desfazer vem)
        results.push({ step: `verify:${i}`, ok: false, exitCode: null, stdoutTail: "", stderrTail: "", durationMs: 0, error: v.blocked });
        failedChecks.push(c.label);
        continue;
      }
      results.push(v.step);
      if (!v.step.ok) failedChecks.push(c.label);
    }
    if (!failedChecks.length) return end("done");

    const why = `a conferência falhou (${failedChecks.map((l) => `«${l}»`).join(", ")})`;
    if (!r.undoArgv || !r.programs.undo) return end("failed", { error: `${why} e não há desfazer — plano B: ${r.noUndoPlan ?? "—"}` });
    const t1 = this.d.now();
    const undoRun = await this.stepRun(r.undoArgv, r.programs.undo, r.timeoutSec * 1000);
    if ("blocked" in undoRun) return end("failed", { error: `${why} e o desfazer foi barrado (${undoRun.blocked}) — confira à mão` });
    const u = undoRun.result;
    const undoOk = !u.error && u.exitCode === 0;
    results.push(stepOf("undo", u, undoOk, this.d.now() - t1));
    if (!undoOk) return end("failed", { error: `${why} e o desfazer também falhou (${u.error ?? `saída ${u.exitCode}`}) — confira à mão` });
    return end("undone", { autoUndone: true, error: `${why}; o comando foi desfeito sozinho` });
  }

  /** O desfazer pedido pelo dono — reconferido (hash, programa, trava) e com claim próprio. Nunca lança. */
  async executeUndo(id: string): Promise<void> {
    if (this.inflight.has(id)) return;
    this.inflight.add(id);
    try {
      const r = await this.get(id);
      if (!r || r.status !== "running" || r.phase !== "undo" || !r.undoArgv || !r.programs.undo) return;
      const valid = await this.undoStillValid(r);
      const base: LockedExecRecord = { ...r, finishedAt: new Date(this.d.now()).toISOString() };
      delete base.phase;
      if (!valid.ok) {
        await this.settle({ ...base, status: "failed", error: `o desfazer não rodou: ${valid.why}` }, "undo");
        return;
      }
      if (!(await this.d.claim(this.file(id, ".undo.claim")))) {
        this.d.log(`${id}: outro processo já roda este desfazer`);
        return;
      }
      const t0 = this.d.now();
      const undoRun = await this.stepRun(r.undoArgv, r.programs.undo, r.timeoutSec * 1000);
      if ("blocked" in undoRun) {
        await this.settle({ ...base, status: "failed", error: `o desfazer não rodou: ${undoRun.blocked}` }, "undo");
        return;
      }
      const u = undoRun.result;
      const ok = !u.error && u.exitCode === 0;
      const done: LockedExecRecord = { ...base, results: [...r.results, stepOf("undo", u, ok, this.d.now() - t0)], finishedAt: new Date(this.d.now()).toISOString() };
      await this.settle(
        ok ? { ...done, status: "undone", autoUndone: false } : { ...done, status: "failed", error: `o desfazer falhou (${u.error ?? `saída ${u.exitCode}`}) — confira à mão` },
        "undo",
      );
    } catch (err) {
      await this.failSafe(id, err, "desfazer");
    } finally {
      this.inflight.delete(id);
    }
  }

  /**
   * Uma vez por processo. NUNCA executa: a aprovação vive na memória do processo que a recebeu — um `approved` que
   * sobreviveu ao restart EXPIRA (o dono aprova de novo, vendo o pedido de novo); o que estava RODANDO quando o serviço
   * caiu vira falha (não se sabe até onde foi — o dono confere à mão). Nunca lança.
   */
  async recoverOnBoot(): Promise<void> {
    try {
      const now = this.d.now();
      for (const r of await this.list()) {
        if (r.status === "approved") {
          await this.settle({ ...r, status: "expired", finishedAt: new Date(now).toISOString(), error: "o serviço reiniciou antes de rodar — aprove de novo" }, "expire");
        } else if (r.status === "running") {
          const base: LockedExecRecord = { ...r };
          delete base.phase;
          await this.settle({ ...base, status: "failed", finishedAt: new Date(now).toISOString(), error: "o serviço reiniciou no meio da execução — confira à mão o estado" }, "orphan");
        }
      }
    } catch (err) {
      this.d.log(`recuperação no boot falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Um passo com as caudas REDIGIDAS (o disco e o Inbox nunca veem o segredo que o comando imprimiu). */
function stepOf(name: string, r: LockedExecRunResult, ok: boolean, durationMs: number): LockedExecStep {
  return {
    step: name,
    ok,
    exitCode: r.exitCode,
    stdoutTail: redactOutput(r.stdout),
    stderrTail: redactOutput(r.stderr),
    durationMs,
    ...(r.error ? { error: redactSecrets(r.error).slice(0, 300) } : {}),
  };
}

/** A linha que o agente do card recebe com o desfecho (ele relê pelo `locked_command_status`). PURA. */
export function wakeText(r: LockedExecRecord): string {
  const what: Record<string, string> = {
    rejected: "o dono NÃO aprovou",
    done: "o dono aprovou e o comando rodou e passou nas conferências",
    undone: r.autoUndone ? "o comando rodou, a conferência falhou e ele foi desfeito sozinho" : "o dono desfez o comando",
    failed: "o comando aprovado falhou",
    stale: "o comando aprovado não rodou (a situação mudou)",
    expired: "a autorização expirou antes de rodar",
  };
  return `continuar — ${what[r.status] ?? `o pedido ${r.id} mudou de estado (${r.status})`} (pedido ${r.id}). Leia o desfecho com locked_command_status antes de seguir.`;
}

const SERVICE_KEY = Symbol.for("agileharness.lockedExec.service");

/** O serviço do processo (singleton, como o governador). */
export function getLockedExecService(): LockedExecService {
  const g = globalThis as unknown as { [SERVICE_KEY]?: LockedExecService };
  if (!g[SERVICE_KEY]) g[SERVICE_KEY] = new LockedExecService();
  return g[SERVICE_KEY]!;
}
