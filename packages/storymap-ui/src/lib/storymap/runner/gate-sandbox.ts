// gate-sandbox — o SELO: o código do delta roda numa unidade transiente do systemd, não no processo do serviço.
//
// O QUE O GATE EXECUTA É CÓDIGO ESCRITO POR AGENTE — a suíte, o typecheck e o `vitest -u` do delta —, e até
// aqui como o uid do serviço (root na instalação de referência) e com a rede do host. O hotfix de contenção
// (v0.6.0) tirou do ENV as credenciais de nuvem (`spawn-env.ts` neutralizeCloudCredentials), e a própria
// função diz por escrito que aquilo é "HIGIENE, NÃO SANDBOX": o teste hostil ainda lia o disco direto.
//
// ── O QUE FOI MEDIDO NESTE HOST (systemd 255, Ubuntu, serviço como root, 2026-09-25) ─────────────────────
// Cada linha abaixo foi uma sonda real, e cada propriedade do selo existe por causa de uma delas:
//
//   · `ProtectSystem=strict` SOZINHO NÃO FECHA `/root`: com `ProtectHome=no` o systemd deixa `/home`, `/root`
//     e `/run/user` implicitamente RW. Medido: `touch /root/…` passou dentro de uma unidade "strict". Daí
//     `ProtectHome=read-only`.
//   · ROOT COM CAPABILITIES DESFAZ O SELO: dentro da unidade, `umount` do `InaccessiblePaths` expôs a
//     credencial e `mount -o remount,rw /` escreveu fora da árvore. Daí `CapabilityBoundingSet=` VAZIO (root
//     sem capability nenhuma: CapEff=0). Efeito colateral medido e desejado: sem capability, ler
//     `/proc/<pid-do-serviço>/environ` dá EACCES (o kernel exige que o leitor tenha ⊇ as capabilities do
//     alvo) — é o que fecha o env do SERVIÇO (tokens MCP) sem namespace de PID.
//   · O `/run` É UMA SAÍDA: `systemctl` de dentro da unidade falou com o PID 1 como root pelo
//     `/run/systemd/private` (e há dbus, snapd, gpg-agent.ssh, tmux/screen nos sockets do host). Um socket
//     UNIX em montagem read-only continua conectável. Daí `TemporaryFileSystem=/run:ro` (e `PrivateTmp`, que
//     também esconde o socket do tmux do operador em `/tmp`).
//   · `PrivatePIDs=` NÃO EXISTE no 255, e um namespace de PID por `unshare --mount-proc` exige manter
//     CAP_SYS_ADMIN e remonta um `/proc` que desfaz o `ProtectKernelTunables` (medido: `/proc/sys` voltou a
//     aceitar escrita). Entre isolar PID e manter o root sem capability, o selo fica com o segundo.
//     RESIDUAL DECLARADO: a unidade VÊ a lista de processos do host e pode SINALIZAR processos do mesmo uid
//     (um teste hostil pode derrubar o serviço — DoS, não vazamento; o env deles segue ilegível).
//   · `PrivateNetwork=yes` deixa só um loopback PRIVADO: servidor de teste em 127.0.0.1 funciona, a rede do
//     host (inclusive os serviços dele em loopback) não é alcançável.
//
// ── O QUE O SELO NÃO É ─────────────────────────────────────────────────────────────────────────────────
// É uma DENY-LIST sobre um sistema de arquivos legível, não uma allow-list: o que o root lê e não está na
// lista (ver {@link defaultInaccessiblePaths}) continua legível. A diferença para antes é que nada disso
// SAI — sem rede, sem socket do host, sem escrita fora da árvore. Resta um canal que nenhum selo fecha: o que
// a suíte IMPRIME vira log do gate, e o log vira finding no card.
//
// ── PORTABILIDADE ──────────────────────────────────────────────────────────────────────────────────────
// Sem systemd (macOS, container sem PID 1 systemd, serviço não-root sem polkit), a SONDA falha e o gate cai
// no comportamento de hoje — env neutralizado, sem selo — com aviso alto no log de cada gate e no preflight.
// Nunca silencioso: o `isolation` de cada unidade vai no relatório da entrada.
//
// PURO até {@link probeGateSandbox}: montar a argv é uma função; só a sonda executa.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** `systemd` = selado (quando a sonda passa); `none` = o comportamento de antes (env neutralizado, sem selo). */
export type GateIsolationMode = "systemd" | "none";
export const GATE_ISOLATION_MODES: readonly GateIsolationMode[] = ["systemd", "none"] as const;

/** O slice de todas as unidades do gate — `systemctl status agileharness-gate.slice` agrega o que está rodando. */
export const GATE_SLICE = "agileharness-gate.slice";

/** A ÚNICA forma de nome de unidade que o gate cria — e a única que ele aceita PARAR. */
const GATE_UNIT_RE = /^ah-gate-[a-z0-9-]{1,80}\.service$/;

/** O contexto de UMA execução de gate, já resolvido (modo efetivo + caminhos). */
export interface GateSeal {
  /** o modo EFETIVO — `systemd` só quando pedido E a sonda passou. */
  mode: GateIsolationMode;
  /** por que este modo: o operador lê isto quando o gate caiu para `none`. */
  reason: string;
  /** a árvore do gate: o ÚNICO lugar gravável (além de `writablePaths`). */
  treePath: string;
  /** a raiz do repositório: visível read-only (os node_modules da árvore são links para cá). */
  repoRoot: string;
  /** caminhos a esconder (arquivo ou diretório). Os ausentes são ignorados. */
  inaccessiblePaths: readonly string[];
  /** caches extras graváveis declarados pelo operador. Os ausentes são ignorados. */
  writablePaths: readonly string[];
  /** a identidade da execução — entra no nome da unidade. */
  runId: string;
}

/** Uma invocação pronta: a string que vai ao `exec` (shell), a argv EXATA que ela executa, e o env. */
export interface GateInvocation {
  /** a linha de shell — é o que o `ExecFn` recebe. */
  command: string;
  /** a argv que essa linha executa, palavra por palavra — é o que vai para o log e o relatório da entrada. */
  argv: string[];
  /** o env do exec (o do selo copia-o por `--setenv=NOME`, sem valor na linha de comando). */
  env: NodeJS.ProcessEnv;
  /** a unidade transiente, quando selada — o que o timeout precisa parar. */
  unit?: string;
  isolation: GateIsolationMode;
}

/** POSIX single-quote de UMA palavra. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Caminhos que o systemd aceita numa propriedade de lista SEM precisar de escape: absolutos, sem espaço, sem
 * `:` (separador de BindPaths), sem aspas/barra-invertida/controle. Um caminho fora disso não entra — e o
 * chamador fica sabendo ({@link buildSealedInvocation} devolve `skipped`).
 */
function propSafe(p: string): boolean {
  return path.isAbsolute(p) && !/[\s:"'\\%$`\x00-\x1f]/.test(p);
}

/** Um nome de variável de ambiente que pode virar `--setenv=NOME`. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * As credenciais conhecidas que o selo esconde por default — sob o HOME do serviço e do sistema. A lista é
 * de LOCAIS PADRÃO de CLIs/SDKs (fato das ferramentas, não deste repositório); o que for específico do
 * deployment entra por `mergeGate.sealed.inaccessiblePaths`. PURA.
 */
export function defaultInaccessiblePaths(home: string): string[] {
  const h = (rel: string) => path.join(home, rel);
  return [
    h(".ssh"),
    h(".aws"),
    h(".azure"),
    h(".config/gcloud"),
    h(".claude"),
    h(".claude.json"),
    h(".config/gh"),
    h(".config/git/credentials"),
    h(".git-credentials"),
    h(".docker"),
    h(".kube"),
    h(".gnupg"),
    h(".npmrc"),
    h(".netrc"),
    h(".pypirc"),
    h(".cargo/credentials.toml"),
    h(".terraform.d"),
    "/etc/ssh",
    "/etc/shadow",
    "/etc/gshadow",
  ];
}

/**
 * Nome de unidade determinístico por execução: `ah-gate-<runId saneado>-<nonce>.service`. O nonce existe
 * porque o mesmo run roda N comandos (unidades, rodada base, retry) e uma unidade com `--collect` pode ainda
 * estar sendo coletada quando a próxima nasce. PURA.
 */
export function gateUnitName(runId: string, nonce: string): string {
  const id = runId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40).replace(/^-|-$/g, "") || "x";
  const n = nonce.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "0";
  return `ah-gate-${id}-${n}.service`;
}

/** É uma unidade do gate (e portanto algo que o gate pode parar)? Nunca o serviço, nunca um slice. */
export function isGateUnit(unit: string | undefined | null): unit is string {
  return typeof unit === "string" && GATE_UNIT_RE.test(unit);
}

/** As propriedades do selo, na ordem em que vão para a argv. `network` decide o `PrivateNetwork`. PURA. */
export function sealProperties(seal: GateSeal, network: "deny" | "allow", timeoutMs: number): { props: string[]; skipped: string[] } {
  const skipped: string[] = [];
  const props: string[] = [
    // O sistema de arquivos inteiro read-only — e o HOME também (strict SOZINHO deixa /root RW; medido).
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    // Root SEM capability: não desmonta o InaccessiblePaths, não remonta /, não lê o environ do serviço.
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "NoNewPrivileges=yes",
    // /tmp, /dev e IPC privados: nada de socket do tmux/sandbox do operador em /tmp, nada de /dev do host.
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "PrivateIPC=yes",
    // /run VAZIO: sem /run/systemd/private, dbus, snapd, gpg-agent — sockets que falam com o host como root.
    "TemporaryFileSystem=/run:ro",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "ProtectProc=invisible",
    // O relógio de parede é do SYSTEMD, não do cliente: matar o `systemd-run` não para a unidade (medido).
    `RuntimeMaxSec=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
  ];
  if (network === "deny") props.push("PrivateNetwork=yes");
  // Com rede, o resolv.conf aponta para /run/systemd/resolve — que o /run vazio esconderia.
  else props.push("BindReadOnlyPaths=-/run/systemd/resolve");

  // A raiz do repositório read-only (os node_modules da árvore são links para ela) — `-`: tolera ausência.
  // Nunca o MESMO caminho da árvore (nem um caminho dentro dela): dois binds no mesmo ponto e o read-only
  // vence — a árvore ficaria read-only e o gate mediria um erro de escrita (medido na primeira sonda).
  const rootIsTreeOrInside = seal.repoRoot === seal.treePath || seal.repoRoot.startsWith(`${seal.treePath}/`);
  if (rootIsTreeOrInside) {
    /* a árvore (gravável) já cobre */
  } else if (propSafe(seal.repoRoot)) props.push(`BindReadOnlyPaths=-${seal.repoRoot}`);
  else skipped.push(seal.repoRoot);
  // A árvore: o ÚNICO lugar gravável. SEM `-` — sem a árvore não há o que medir, e o systemd recusa alto.
  if (propSafe(seal.treePath)) props.push(`BindPaths=${seal.treePath}`);
  else skipped.push(seal.treePath);
  for (const w of seal.writablePaths) {
    if (propSafe(w)) props.push(`BindPaths=-${w}`);
    else skipped.push(w);
  }
  for (const p of seal.inaccessiblePaths) {
    if (propSafe(p)) props.push(`InaccessiblePaths=-${p}`);
    else skipped.push(p);
  }
  return { props, skipped };
}

/**
 * Monta a invocação de UM comando do gate. `none` ⇒ o comando exatamente como antes (`/bin/sh -c`). `systemd`
 * ⇒ `systemd-run --wait --pipe --collect` com o selo, o env copiado NOME a NOME (os valores nunca aparecem na
 * linha de comando — `--setenv=NOME` sem `=` faz o systemd-run copiar do próprio env) e
 * `--expand-environment=no` (o default EXPANDE `${VAR}` na argv — medido: `'${FOO}'` virou `bar`, e um
 * comando com `$` seria reescrito pelo systemd antes de o shell vê-lo). PURA.
 */
export function buildSealedInvocation(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  network?: "deny" | "allow";
  seal: GateSeal | undefined;
  nonce: string;
}): GateInvocation & { skipped: string[] } {
  const { command, cwd, env, timeoutMs, seal } = opts;
  if (!seal || seal.mode !== "systemd") {
    return { command, argv: ["/bin/sh", "-c", command], env, isolation: "none", skipped: [] };
  }
  const unit = gateUnitName(seal.runId, opts.nonce);
  const { props, skipped } = sealProperties(seal, opts.network ?? "deny", timeoutMs);
  // /tmp dentro da unidade é PRIVADO: um TMPDIR herdado apontando para fora dele seria read-only.
  const sealedEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: "/tmp" };
  const names = Object.keys(sealedEnv)
    .filter((k) => sealedEnv[k] !== undefined && ENV_NAME_RE.test(k))
    .sort();
  const argv = [
    "systemd-run",
    "--wait",
    "--pipe",
    "--collect",
    "--quiet",
    "--expand-environment=no",
    `--unit=${unit}`,
    `--slice=${GATE_SLICE}`,
    `--working-directory=${cwd}`,
    ...names.map((n) => `--setenv=${n}`),
    ...props.map((p) => `--property=${p}`),
    "--",
    "/bin/sh",
    "-c",
    command,
  ];
  return { command: argv.map(sq).join(" "), argv, env: sealedEnv, unit, isolation: "systemd", skipped };
}

/** O resultado da sonda — `ok:false` sempre traz o motivo (é o que vai para o log e o preflight). */
export interface SandboxProbe {
  ok: boolean;
  detail: string;
}

/** A marca que o script da sonda imprime quando TODAS as verificações passam. */
const PROBE_OK = "AH-GATE-SEALED-OK";

/**
 * O script que a sonda roda DENTRO da unidade: cada linha é uma propriedade do selo que precisa valer, e a
 * marca só sai se todas valerem. `sh` puro (dash): nada de `/dev/tcp`. E SEM RESÍDUO: as checagens de
 * escrita usam `[ -w ]` (access(2), que responde EROFS de montagem read-only) em vez de `touch` — uma sonda
 * que falhasse criaria arquivo em `/etc` do host exatamente no host onde o selo não existe.
 *   · CapEff zerado (root sem capability);
 *   · só `lo` no namespace de rede (lido de /proc/self, que é do LEITOR — não do sysfs de quem montou);
 *   · `/etc` e o HOME read-only; a árvore gravável;
 *   · `/run/systemd/private` invisível.
 */
export function probeScript(treePath: string, home: string = os.homedir()): string {
  const t = sq(treePath);
  const h = sq(home);
  return [
    `grep -q '^CapEff:[[:space:]]*0*$' /proc/self/status || { echo 'capabilities presentes'; exit 11; }`,
    `[ "$(awk 'NR>2{print $1}' /proc/self/net/dev)" = 'lo:' ] || { echo 'rede do host visível'; exit 12; }`,
    `[ -w /etc ] && { echo '/etc gravável'; exit 13; }`,
    `[ -d ${h} ] && [ -w ${h} ] && { echo 'HOME gravável'; exit 14; }`,
    `[ -w ${t} ] || { echo 'árvore não gravável'; exit 15; }`,
    `[ -e /run/systemd/private ] && { echo 'socket do PID 1 visível'; exit 16; }`,
    `echo ${PROBE_OK}`,
  ].join("\n");
}

/** Executor síncrono da sonda (DI para teste). `null` = não foi possível executar. */
export type ProbeRunner = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => {
  code: number;
  stdout: string;
  stderr: string;
} | null;

const defaultProbeRunner: ProbeRunner = (cmd, args, opts) => {
  try {
    const r = spawnSync(cmd, args, { env: opts.env, timeout: opts.timeoutMs, encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch {
    return null;
  }
};

/**
 * A SONDA: roda o selo INTEIRO (as mesmas propriedades de {@link sealProperties}) sobre um diretório
 * descartável e só diz `ok` se o script de {@link probeScript} provar cada propriedade de dentro. Presença
 * do binário não é prova — um `systemd-run` sem PID 1 systemd, ou sem permissão (não-root sem polkit),
 * existe e falha. Não lança.
 */
export function probeGateSandbox(opts: {
  run?: ProbeRunner;
  platform?: NodeJS.Platform;
  tmpBase?: string;
  mkdtemp?: (prefix: string) => string;
  rm?: (p: string) => void;
} = {}): SandboxProbe {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return { ok: false, detail: `plataforma ${platform}: sem systemd` };
  const run = opts.run ?? defaultProbeRunner;
  // A árvore descartável pode viver em /tmp: o selo a liga por BindPaths, que atravessa o PrivateTmp
  // (medido). Um diretório temporário é o que todo adotante tem.
  const mk = opts.mkdtemp ?? ((prefix: string) => mkdtempSync(prefix));
  const rm = opts.rm ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  let root: string;
  let tree: string;
  try {
    // A MESMA forma da produção: a árvore ANINHADA na raiz do repositório (read-only por cima, gravável dentro).
    root = mk(path.join(opts.tmpBase ?? os.tmpdir(), "ah-gate-probe-"));
    tree = path.join(root, "tree");
    mkdirSync(tree);
  } catch (err) {
    return { ok: false, detail: `não criou a árvore da sonda: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const seal: GateSeal = {
      mode: "systemd",
      reason: "sonda",
      treePath: tree,
      repoRoot: root,
      inaccessiblePaths: [],
      writablePaths: [],
      runId: "probe",
    };
    const inv = buildSealedInvocation({
      command: probeScript(tree),
      cwd: tree,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv,
      timeoutMs: 20_000,
      seal,
      nonce: Math.random().toString(36).slice(2, 10),
    });
    const r = run(inv.argv[0], inv.argv.slice(1), { env: inv.env, timeoutMs: 30_000 });
    if (!r) return { ok: false, detail: "systemd-run não executou (ausente do PATH?)" };
    if (r.code === 0 && r.stdout.includes(PROBE_OK)) return { ok: true, detail: "selo provado de dentro (sem capability, sem rede, /run vazio, só a árvore gravável)" };
    const why = `${r.stdout} ${r.stderr}`.replace(/\s+/g, " ").trim().slice(0, 240);
    return { ok: false, detail: `a sonda do selo falhou (exit ${r.code}): ${why || "sem saída"}` };
  } finally {
    try {
      rm(root);
    } catch {
      /* best-effort */
    }
  }
}

let cachedProbe: SandboxProbe | null = null;

/** A sonda, uma vez por processo (a disponibilidade do systemd não muda com o serviço de pé). */
export function cachedGateSandboxProbe(): SandboxProbe {
  if (!cachedProbe) cachedProbe = probeGateSandbox();
  return cachedProbe;
}

/** Test-only: esquece a sonda memorizada. */
export function resetGateSandboxProbeCache(): void {
  cachedProbe = null;
}

/**
 * O modo EFETIVO: pedido `systemd` + sonda ok ⇒ `systemd`; pedido `systemd` + sonda falha ⇒ `none` com o
 * motivo (o fallback de portabilidade, nunca silencioso); pedido `none` ⇒ `none` declarado. PURA.
 */
export function resolveGateIsolation(
  requested: GateIsolationMode | undefined,
  probe: () => SandboxProbe,
): { mode: GateIsolationMode; reason: string } {
  if ((requested ?? "systemd") === "none") return { mode: "none", reason: "isolamento DESLIGADO por config (mergeGate.isolation: none)" };
  const p = probe();
  return p.ok
    ? { mode: "systemd", reason: p.detail }
    : { mode: "none", reason: `⚠ SEM SELO — systemd indisponível: ${p.detail}. O código do delta roda como o uid do serviço, com a rede do host (só o env é neutralizado).` };
}

/** Linha de parada da unidade que o timeout deixou viva — só para nomes de unidade do gate. PURA. */
export function stopUnitCommand(unit: string): string | null {
  return isGateUnit(unit) ? `systemctl stop ${sq(unit)}` : null;
}
