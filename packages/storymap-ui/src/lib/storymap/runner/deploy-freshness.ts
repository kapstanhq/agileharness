// O PREFLIGHT DE FRESCOR — nenhum deploy de PRODUTO sai de um checkout que não carrega o que já está no ar.
//
// POR QUE ELE EXISTE (medido em 2026-09-24). O serviço publica produto a partir do SEU checkout do alvo
// (o de runtime): `just --yes orch-deploy <alvo>`, o `deploy.command` declarado, o agente de deploy — todos
// rodam da raiz desse checkout. O dono do produto também publica de OUTRA máquina: empurra para o upstream
// e deploya de lá. Nada no caminho de deploy do motor buscava o upstream antes, então o checkout de runtime
// podia estar DEZENAS de commits atrás do que estava no ar — e um deploy autônomo teria REGREDIDO produção
// para código mais velho, em silêncio. O detector de drift do próprio alvo não ajudava: ele trata "o ar
// está À FRENTE do HEAD" como "em sincronia", porque a pergunta dele é outra (o HEAD tem algo a publicar?).
//
// A PERGUNTA DESTE MÓDULO é a que faltava: "publicar DAQUI pode fazer o ar andar para TRÁS?". Ela é
// respondida por medição, em ordem, e a primeira que não passa RECUSA (fail-closed — não saber é recusar):
//   1. o branch atual tem upstream, e o `git fetch` dele funciona (com teto de tempo);
//   2. o HEAD NÃO está atrás do upstream (`rev-list --count HEAD..@{u}` = 0);
//   3. não há mudança NÃO COMMITADA em arquivo rastreado DENTRO do escopo do deploy — o mesmo escopo que a
//      promoção leva (`release-scope.ts`). Sujeira FORA do escopo é ignorada de propósito: o checkout de
//      runtime tem, legitimamente, configuração local da ferramenta modificada;
//   4. OPCIONAL: se o board declara `deploy.liveShaCommand`, o HEAD tem de DESCENDER de todo sha que ele
//      imprimir (`merge-base --is-ancestor <sha> HEAD`). Não declarado ⇒ a checagem é PULADA com uma linha
//      de log explícita — nunca aprovada em silêncio.
//
// A AUTORIZAÇÃO É UM OBJETO, NÃO UM BOOLEANO. Um "ok" devolve uma {@link DeployClearance} que só este módulo
// sabe cunhar (um WeakSet privado — um `as DeployClearance` NÃO a forja), amarrada ao ALVO que vai subir,
// de uso ÚNICO e com validade curta. `ProductDeployRegistry.start` exige uma e a resgata
// ({@link redeemDeployClearance}) antes de lançar qualquer coisa. É isso que torna o preflight uma
// OBRIGAÇÃO: uma superfície nova de deploy de produto que não passe por aqui não tem como lançar — o
// registry recusa. É a mesma lição do chokepoint de env de spawn e da régua de comandos declarados.
//
// O ESCAPE É HUMANO: `AGILEHARNESS_DEPLOY_FRESHNESS=off` no env do SERVIÇO, lido na hora de cada chamada
// (sem restart para desligar... nem para religar). Ele só existe para o operador que SABE o que está
// fazendo, e grita no log toda vez que é usado. Qualquer outro valor mantém o preflight LIGADO.
//
// O QUE ELE NÃO COBRE, dito em vez de fingido: o self-deploy da ferramenta (systemd-run, `runner/deploy.ts`)
// não é deploy de produto — ele reconstrói o PACOTE DA FERRAMENTA que está rodando, de outra árvore, e a
// ferramenta se atualiza pelo canal de release dela. O censo (`deploy-freshness-chokepoint.test.ts`)
// registra essa isenção por nome.
//
// PURO nas decisões (parse de porcelain, escopo, shas); o IO é o `exec` injetado. Sem imports de repo/config:
// `product-deploy.ts` importa este módulo, e aquele lê manifesto em tempo de carga.

import type { ExecFn } from "./worktree";
import { authorizeDeployCommand, quoteArgv, shSingleQuote } from "./deploy-command-guard";

/** Teto do `git fetch` do upstream. Um fetch pendurado não pode segurar a publicação — e estourar é recusa. */
export const DEPLOY_FRESHNESS_FETCH_TIMEOUT_MS = 60_000;
/** Teto do `deploy.liveShaCommand` declarado. */
export const DEPLOY_FRESHNESS_LIVE_SHA_TIMEOUT_MS = 60_000;
/** Validade de uma autorização: ela é cunhada IMEDIATAMENTE antes do lançamento; guardar uma é o defeito. */
export const DEPLOY_CLEARANCE_TTL_MS = 60_000;
/** Teto de shas aceitos de um `liveShaCommand` (um por unidade publicada). Mais que isso é saída errada. */
const MAX_LIVE_SHAS = 64;
const GIT_TIMEOUT_MS = 30_000;

export type FreshnessRefusalCode =
  | "git-failed"
  | "detached-head"
  | "no-upstream"
  | "fetch-failed"
  | "behind"
  | "dirty"
  | "live-sha-refused"
  | "live-sha-failed"
  | "live-sha-garbage"
  | "live-sha-unknown"
  | "live-not-ancestor";

/** O que um deploy pede ao preflight. */
export interface DeployFreshnessRequest {
  /** O ALVO que este deploy publica — a chave de job do registry (o app do `orch-deploy`, o id do board de um
   *  deploy declarado, o alvo da face composta). A autorização sai amarrada a ele. */
  target: string;
  /** A raiz do checkout de onde o deploy RODA (o de runtime). */
  repoRoot: string;
  /** O escopo do deploy: prefixos de diretório (com `/` final) e/ou arquivos exatos, relativos à raiz.
   *  VAZIO ⇒ o repositório inteiro (não saber o escopo não pode virar "nada a checar"). */
  scope: readonly string[];
  /** `board.yaml` `deploy.liveShaCommand` de cada board que publica este alvo (normalmente UM) — board-data,
   *  então cada um passa pela régua dos comandos declarados. Vazio/ausente ⇒ a checagem é pulada COM log. */
  liveShaCommands?: readonly (string | undefined)[];
  /** Quem pede — só para o log (`board nook`, `mcp deploy <alvo>`, `face <alvo> (board x)`). */
  label: string;
}

/** O IO do preflight. `exec` é o de produção; os demais são costuras de TESTE (o censo reprova um chamador
 *  de produção que injete `env`: o escape tem de vir do env do SERVIÇO, nunca de um argumento). */
export interface DeployFreshnessDeps {
  exec: ExecFn;
  env?: Record<string, string | undefined>;
  log?: (level: "info" | "warn" | "error", line: string) => void;
  now?: () => number;
  fetchTimeoutMs?: number;
  liveShaTimeoutMs?: number;
}

/** A autorização de UM lançamento: cunhada só aqui, amarrada ao alvo, uso único, validade curta. */
export interface DeployClearance {
  readonly target: string;
  readonly repoRoot: string;
  /** o HEAD medido (null só no escape humano, que não mede nada). */
  readonly head: string | null;
  readonly issuedAt: number;
  /** true quando veio do escape `AGILEHARNESS_DEPLOY_FRESHNESS=off` — nada foi checado. */
  readonly bypassed: boolean;
  /** a linha legível do que foi medido (ou do que foi pulado). */
  readonly summary: string;
}

export type DeployFreshnessVerdict =
  | { ok: true; clearance: DeployClearance; bypassed: boolean; summary: string }
  | { ok: false; code: FreshnessRefusalCode; reason: string };

// ── A cunhagem ────────────────────────────────────────────────────────────────────────────────────────
// Um WeakSet de MÓDULO: só este arquivo adiciona, e pertencer a ele é a única prova aceita. Um objeto com o
// mesmo formato (ou um `as DeployClearance`) não pertence — é por isso que a marca não é um tipo.
const cunhadas = new WeakSet<object>();

function cunhar(c: Omit<DeployClearance, "issuedAt">, now: number): DeployClearance {
  const clearance: DeployClearance = Object.freeze({ ...c, issuedAt: now });
  cunhadas.add(clearance);
  return clearance;
}

/**
 * Resgata a autorização para lançar `target`: devolve `null` quando ela vale (e a CONSOME — uso único), ou o
 * motivo nomeado da recusa. Quem chama é `ProductDeployRegistry.start`, e só ele: é o ponto em que um deploy
 * de produto vira processo.
 */
export function redeemDeployClearance(clearance: unknown, target: string, now: number = Date.now()): string | null {
  if (!clearance || typeof clearance !== "object" || !cunhadas.has(clearance)) {
    return (
      `deploy de ${target} sem autorização do preflight de frescor — todo deploy de produto passa por ` +
      `checkDeployFreshness (runner/deploy-freshness.ts) antes de lançar; nada foi executado`
    );
  }
  const c = clearance as DeployClearance;
  if (c.target !== target) {
    return `autorização de frescor emitida para "${c.target}" usada para lançar "${target}" — nada foi executado`;
  }
  if (now - c.issuedAt > DEPLOY_CLEARANCE_TTL_MS) {
    return (
      `autorização de frescor de ${target} VENCIDA (${Math.round((now - c.issuedAt) / 1000)}s > ` +
      `${DEPLOY_CLEARANCE_TTL_MS / 1000}s) — ela é cunhada imediatamente antes do lançamento; nada foi executado`
    );
  }
  cunhadas.delete(clearance); // uso único: resgatada, deixa de valer
  return null;
}

// ── O escape humano ───────────────────────────────────────────────────────────────────────────────────

/**
 * O operador desligou o preflight? Só o literal `off` (sem diferenciar caixa) desliga. Qualquer outro valor
 * — inclusive um plausível como `0` ou `false` — mantém LIGADO: o erro de digitação cai do lado seguro, e o
 * chamador avisa que o valor foi ignorado (ver {@link freshnessEscapeIgnoredValue}).
 */
export function freshnessDisabledByOperator(env: Record<string, string | undefined>): boolean {
  return (env.AGILEHARNESS_DEPLOY_FRESHNESS ?? "").trim().toLowerCase() === "off";
}

/** O valor declarado que NÃO desligou nada (para o aviso), ou null quando ausente/vazio/`off`. */
export function freshnessEscapeIgnoredValue(env: Record<string, string | undefined>): string | null {
  const raw = (env.AGILEHARNESS_DEPLOY_FRESHNESS ?? "").trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw;
}

// ── Partes PURAS ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Os caminhos de `git status --porcelain=v1 -z` (sem não-rastreados). Numa renomeação/cópia a entrada traz
 * DOIS caminhos (`XY novo\0origem\0`) e os dois contam: tirar um arquivo de dentro do escopo também é
 * mudar o escopo.
 */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (/[RC]/.test(xy)) {
      const origem = parts[i + 1];
      if (origem) files.push(origem);
      i++;
    }
  }
  return files;
}

/** `file` está no escopo? Prefixo com `/` final casa por diretório; sem `/` casa o arquivo exato OU o
 *  diretório de mesmo nome. Escopo VAZIO ⇒ tudo está no escopo (fail-closed). */
export function pathInScope(file: string, scope: readonly string[]): boolean {
  if (scope.length === 0) return true;
  return scope.some((raw) => {
    const s = raw.replace(/^\.\//, "");
    if (!s) return true;
    return s.endsWith("/") ? file.startsWith(s) : file === s || file.startsWith(`${s}/`);
  });
}

/** Os caminhos sujos que caem dentro do escopo, sem repetição. */
export function dirtyInScope(files: readonly string[], scope: readonly string[]): string[] {
  return [...new Set(files.filter((f) => pathInScope(f, scope)))];
}

const SHA_LINE = /^[0-9a-f]{7,64}$/i;

/**
 * O contrato de `deploy.liveShaCommand`: stdout = UM OU MAIS shas de commit, um por linha (um por unidade
 * publicada, se a publicação tiver várias). Linhas em branco são toleradas; QUALQUER outra coisa é lixo e
 * devolve `null` — um comando que imprime prosa não está dizendo o que está no ar, e adivinhar seria aprovar.
 */
export function parseLiveShas(stdout: string): string[] | null {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0 || lines.length > MAX_LIVE_SHAS) return null;
  if (!lines.every((l) => SHA_LINE.test(l))) return null;
  return [...new Set(lines.map((l) => l.toLowerCase()))];
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 10) : "?");

/** A mensagem de um erro do `exec` (promisify(exec) rejeita com stderr/código anexados). */
function execErrorText(e: unknown): string {
  const err = e as { stderr?: string; message?: string; killed?: boolean; signal?: string };
  if (err?.killed || err?.signal === "SIGTERM") return "estourou o teto de tempo";
  const txt = (err?.stderr || err?.message || String(e)).trim();
  return txt.split("\n").filter(Boolean).slice(-2).join(" / ").slice(0, 240);
}

const exitCodeOf = (e: unknown): number | null => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "number" ? c : null;
};

// ── O preflight ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Mede se é seguro publicar `req.target` a partir de `req.repoRoot`. Nunca lança: um erro de medição é uma
 * RECUSA nomeada. Um `ok` traz a {@link DeployClearance} que o registry exige para lançar.
 */
export async function checkDeployFreshness(
  req: DeployFreshnessRequest,
  deps: DeployFreshnessDeps,
): Promise<DeployFreshnessVerdict> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const tag = `[deploy-freshness ${req.label}]`;
  const log =
    deps.log ??
    ((level: "info" | "warn" | "error", line: string) =>
      level === "error" ? console.error(line) : level === "warn" ? console.warn(line) : console.log(line));
  const refuse = (code: FreshnessRefusalCode, reason: string): DeployFreshnessVerdict => {
    log("error", `${tag} RECUSADO (${code}) — deploy de ${req.target} NÃO executado: ${reason}`);
    return { ok: false, code, reason };
  };

  // O ESCAPE, lido AGORA (não no boot): desligar e religar não pedem restart.
  if (freshnessDisabledByOperator(env)) {
    const summary =
      `PREFLIGHT DE FRESCOR DESLIGADO por AGILEHARNESS_DEPLOY_FRESHNESS=off — deploy de ${req.target} segue ` +
      `SEM fetch, SEM checar atraso, sujeira nem o sha no ar. Isto pode REGREDIR produção; religue apagando a variável`;
    log("warn", `${tag} ⚠ ${summary}`);
    return { ok: true, bypassed: true, summary, clearance: cunhar({ target: req.target, repoRoot: req.repoRoot, head: null, bypassed: true, summary }, now()) };
  }
  const ignorado = freshnessEscapeIgnoredValue(env);
  if (ignorado) {
    log("warn", `${tag} AGILEHARNESS_DEPLOY_FRESHNESS=${JSON.stringify(ignorado)} IGNORADO — só "off" desliga; o preflight segue LIGADO`);
  }

  const cwd = req.repoRoot;
  // GIT_TERMINAL_PROMPT=0: um fetch que pedisse credencial ficaria pendurado até o teto, sem dizer por quê.
  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string, timeout = GIT_TIMEOUT_MS) => deps.exec(`git ${args}`, { cwd, timeout, env: gitEnv });

  // 1. HEAD e branch.
  let head: string;
  try {
    head = (await git("rev-parse --verify HEAD")).stdout.trim();
  } catch (e) {
    return refuse("git-failed", `não foi possível ler o HEAD de ${cwd} (${execErrorText(e)})`);
  }
  let branch: string;
  try {
    branch = (await git("symbolic-ref --quiet --short HEAD")).stdout.trim();
    if (!branch) throw new Error("vazio");
  } catch {
    return refuse(
      "detached-head",
      `HEAD destacado em ${cwd} (${short(head)}) — sem branch não há upstream contra o qual provar que este ` +
        `checkout carrega o que está no ar. Faça checkout do branch de publicação e reentre no Deploy`,
    );
  }

  // 2. O upstream e o fetch dele.
  let trackingRef: string;
  let remote: string;
  let mergeRef: string;
  try {
    trackingRef = (await git(`rev-parse --symbolic-full-name ${shSingleQuote("@{upstream}")}`)).stdout.trim();
    remote = (await git(`config --get ${shSingleQuote(`branch.${branch}.remote`)}`)).stdout.trim();
    mergeRef = (await git(`config --get ${shSingleQuote(`branch.${branch}.merge`)}`)).stdout.trim();
    if (!trackingRef || !remote || !mergeRef) throw new Error("incompleto");
  } catch {
    return refuse(
      "no-upstream",
      `o branch ${branch} em ${cwd} não tem upstream — não há como provar que ele carrega o que está no ar. ` +
        `Configure-o (git -C ${cwd} branch --set-upstream-to=origin/${branch}) e reentre no Deploy`,
    );
  }
  const upstream = trackingRef.replace(/^refs\/remotes\//, "").replace(/^refs\/heads\//, "");
  if (remote === ".") {
    log("info", `${tag} upstream ${upstream} é LOCAL (remote ".") — nada a buscar`);
  } else {
    try {
      // `+merge:tracking` atualiza EXATAMENTE a ref que o `@{u}` lê (com qualquer refspec configurado), e
      // `--no-write-fetch-head` não pisa no FETCH_HEAD que a promoção deste mesmo checkout usa para reconciliar.
      await git(
        `fetch --quiet --no-tags --no-write-fetch-head ${shSingleQuote(remote)} ` +
          shSingleQuote(`+${mergeRef}:${trackingRef}`),
        deps.fetchTimeoutMs ?? DEPLOY_FRESHNESS_FETCH_TIMEOUT_MS,
      );
    } catch (e) {
      return refuse(
        "fetch-failed",
        `git fetch de ${remote} (${mergeRef}) falhou em ${cwd}: ${execErrorText(e)} — sem o estado atual do ` +
          `upstream não há como provar que este checkout está em dia. Verifique rede/credenciais e reentre no Deploy`,
      );
    }
  }

  // 3. Atraso (e avanço, só para o log).
  let behind: number;
  let ahead: number;
  try {
    behind = Number((await git(`rev-list --count ${shSingleQuote(`HEAD..${trackingRef}`)}`)).stdout.trim());
    ahead = Number((await git(`rev-list --count ${shSingleQuote(`${trackingRef}..HEAD`)}`)).stdout.trim());
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) throw new Error("contagem ilegível");
  } catch (e) {
    return refuse("git-failed", `não foi possível comparar HEAD com ${upstream} em ${cwd} (${execErrorText(e)})`);
  }
  if (behind > 0) {
    const diverged = ahead > 0 ? ` (e ${ahead} à frente — DIVERGIU; reconcilie com git pull --rebase)` : "";
    return refuse(
      "behind",
      `o checkout ${cwd} (${branch} em ${short(head)}) está ${behind} commit(s) ATRÁS de ${upstream}${diverged} — ` +
        `publicar daqui faria produção REGREDIR para código mais velho do que o já publicado. Rode ` +
        `\`git -C ${cwd} pull --ff-only\` e reentre no Deploy`,
    );
  }

  // 4. Sujeira dentro do escopo.
  let dirty: string[];
  let foraDoEscopo = 0;
  try {
    const out = (await git("--no-optional-locks status --porcelain=v1 -z --untracked-files=no")).stdout;
    const all = [...new Set(parsePorcelainZ(out))];
    dirty = dirtyInScope(all, req.scope);
    foraDoEscopo = all.length - dirty.length;
  } catch (e) {
    return refuse("git-failed", `não foi possível ler o estado da árvore de ${cwd} (${execErrorText(e)})`);
  }
  if (dirty.length > 0) {
    const amostra = dirty.slice(0, 5).join(", ") + (dirty.length > 5 ? ` e mais ${dirty.length - 5}` : "");
    return refuse(
      "dirty",
      `${dirty.length} arquivo(s) rastreado(s) com mudança NÃO COMMITADA dentro do escopo do deploy em ${cwd} ` +
        `(${amostra}) — publicar daqui mandaria para o ar bytes que não estão em commit nenhum. Commite e ` +
        `pushe (ou descarte) e reentre no Deploy`,
    );
  }
  const escopoTxt = req.scope.length === 0 ? "repositório inteiro (escopo não declarado)" : req.scope.join(" ");

  // 5. O sha no ar (opcional, declarado pelo board).
  const declarados = [...new Set((req.liveShaCommands ?? []).map((c) => c?.trim()).filter((c): c is string => !!c))];
  const vistos: string[] = [];
  if (declarados.length === 0) {
    log("info", `${tag} deploy.liveShaCommand não declarado — ancestralidade do sha no ar NÃO checada (só fetch/atraso/sujeira)`);
  }
  for (const declared of declarados) {
    const verdict = authorizeDeployCommand(declared);
    if (!verdict.argv) {
      return refuse(
        "live-sha-refused",
        `deploy.liveShaCommand (${declared}) recusado pela régua dos comandos declarados — ${verdict.refusal}`,
      );
    }
    let stdout: string;
    try {
      stdout = (
        await deps.exec(quoteArgv(verdict.argv), {
          cwd,
          timeout: deps.liveShaTimeoutMs ?? DEPLOY_FRESHNESS_LIVE_SHA_TIMEOUT_MS,
        })
      ).stdout;
    } catch (e) {
      return refuse(
        "live-sha-failed",
        `deploy.liveShaCommand (${declared}) falhou: ${execErrorText(e)} — sem saber o que está no ar não há como ` +
          `provar que este deploy não regride. Conserte o comando e reentre no Deploy`,
      );
    }
    const shas = parseLiveShas(stdout);
    if (!shas) {
      return refuse(
        "live-sha-garbage",
        `deploy.liveShaCommand (${declared}) imprimiu algo que não é sha de commit (${JSON.stringify(
          String(stdout ?? "").trim().slice(0, 80),
        )}) — o contrato é: stdout = um sha por linha, nada mais`,
      );
    }
    for (const sha of shas) {
      let full: string;
      try {
        full = (await git(`rev-parse --verify --quiet ${shSingleQuote(`${sha}^{commit}`)}`)).stdout.trim();
        if (!full) throw new Error("vazio");
      } catch {
        return refuse(
          "live-sha-unknown",
          `o sha no ar ${sha} (de deploy.liveShaCommand) não existe neste checkout mesmo depois do fetch de ` +
            `${upstream} — o que está no ar saiu de um commit que nunca chegou ao upstream. Pushe-o (ou publique ` +
            `de onde ele existe) e reentre no Deploy`,
        );
      }
      try {
        await git(`merge-base --is-ancestor ${shSingleQuote(full)} HEAD`);
      } catch (e) {
        if (exitCodeOf(e) === 1) {
          return refuse(
            "live-not-ancestor",
            `o sha no ar ${short(full)} NÃO é ancestral do HEAD ${short(head)} de ${cwd} — publicar daqui ` +
              `regrediria (ou divergiria de) produção. Traga o checkout para um commit que descenda de ` +
              `${short(full)} (git pull) e reentre no Deploy`,
          );
        }
        return refuse("git-failed", `não foi possível comparar o sha no ar ${short(full)} com o HEAD (${execErrorText(e)})`);
      }
      vistos.push(short(full));
    }
  }
  const liveTxt =
    declarados.length === 0
      ? "deploy.liveShaCommand não declarado — ancestralidade do sha no ar NÃO checada"
      : `sha(s) no ar ${vistos.join(", ")} ancestral(is) do HEAD`;

  const summary =
    `HEAD ${short(head)} em dia com ${upstream}${ahead > 0 ? ` (+${ahead} à frente)` : ""}; escopo limpo ` +
    `(${escopoTxt}${foraDoEscopo > 0 ? `; ${foraDoEscopo} arquivo(s) sujo(s) FORA do escopo ignorado(s)` : ""}); ${liveTxt}`;
  log("info", `${tag} OK — ${summary}`);
  return {
    ok: true,
    bypassed: false,
    summary,
    clearance: cunhar({ target: req.target, repoRoot: req.repoRoot, head, bypassed: false, summary }, now()),
  };
}

/**
 * PURO — o escopo de sujeira de um alvo LEGADO (`orch-deploy <alvo>`, a tool MCP `deploy`), que não chega
 * por um board: a união do escopo de promoção de todo board cujo `package` resolve para o alvo, e — quando
 * nenhum resolve (um alvo sem board) — o diretório de convenção `packages/<alvo>/`. Também devolve os
 * `liveShaCommand` declarados por esses boards (sem repetição). `boards` chega JÁ LIDO pelo chamador.
 */
export function legacyTargetFreshnessInputs(
  target: string,
  boards: readonly { package?: string; scope: readonly string[]; liveShaCommand?: string }[],
): { scope: string[]; liveShaCommands: string[] } {
  const donos = boards.filter((b) => b.package && b.package.replace(/^packages\//, "").replace(/\/+$/, "") === target);
  const scope = donos.length > 0 ? [...new Set(donos.flatMap((b) => b.scope))] : [`packages/${target}/`];
  const liveShaCommands = [
    ...new Set(donos.map((b) => b.liveShaCommand?.trim()).filter((c): c is string => !!c)),
  ];
  return { scope, liveShaCommands };
}
