// Product-app deploy registry — the SINGLE SOURCE of "deploy a product app from the board" (Fase 5).
//
// A product board ships via `just orch-deploy <target>` (the deployment's own diff-deploy
// orchestrator — hosting + functions + cloud-run). This registry spawns that command
// DETACHED-ish (a child process of the storymap service — a product deploy does NOT restart storymap,
// so unlike the storymap self-deploy it needs no systemd-run / unit), streams its output to a log file,
// and tracks the job status (running/done/failed). It is the SAME mechanism the MCP `deploy` tool has
// always used (extracted here from mcp/dev-tools.ts) — now ALSO reused by the onEnter `deploy-board`
// effect (runner/deploy.ts deployBoard), so a card dragged into "Publicar" fires the same observable
// path as a manual MCP deploy (no parallel implementation, no per-app hardcoding).
//
// SERVER-ONLY (node:child_process / node:fs). globalThis-pinned singleton (survives Next HMR). The
// launch side-effect is injected (DeployLauncher) so the registry logic is unit-testable without
// spawning real processes or touching the filesystem.

import { createWriteStream, existsSync, mkdirSync, readFileSync, promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import { loadRunnerConfig } from "./config";
import { sanitizeSpawnEnv } from "./spawn-env";
// story-frente3 — o `just` do lançador default passa pela régua declarado > PATH > recusa.
import { resolveHostTool } from "./host-tools";
import { launchDeployAgent, type DeployAgentSpec, type DeployAgentVerdict } from "./deploy-agent-spawn";

/**
 * OS ALVOS DEPLOYÁVEIS DESTE DEPLOYMENT — lidos do settings.yaml do ALVO, não do fonte deste motor.
 *
 * ISTO ERA UM LITERAL AQUI, com sete nomes de produto de um único monorepo. Por que
 * mudou: a lista alimentava `z.enum()` em três tools MCP, e um `z.enum` viaja LITERALMENTE dentro do
 * `tools/list` — logo o catálogo de apps de um dono era parte do CONTRATO PUBLICADO do protocolo, lido
 * por qualquer cliente. Um motor que outros repositórios vão usar não pode carregar o catálogo de um
 * deles; e um contrato publicado é a coisa mais cara de desfazer depois que há consumidores externos.
 *
 * VAZIO É RESPOSTA VÁLIDA, e é o default de um alvo que nunca declarou nada: nenhum alvo legado ⇒
 * `deployPkgForPackage` devolve null para tudo ⇒ o dispatch cai no ramo "nada a deployar" que já
 * existe. Um adotante publica declarando `deploy:` nos próprios boards (o descritor kind=command|agent),
 * que é o caminho agnóstico; esta lista existe para quem já publicava por CONVENÇÃO (o basename de
 * `package` é o alvo) antes de o descritor existir.
 *
 * SÍNCRONA, DE PROPÓSITO. `deployPkgForPackage` é consumida no reaper de BOOT (instrumentation.ts), que
 * decide o que NÃO re-disparar. Uma leitura assíncrona aqui contaminaria a ordem de boot. `readFileSettings`
 * é síncrona e memoizada por mtime, então editar o settings.yaml passa a valer sem reiniciar o serviço —
 * o oposto de um enum congelado no registro da tool (o handler MCP é cacheado por credencial).
 */
export function productDeployTargets(): readonly string[] {
  return loadRunnerConfig().deploy?.targets ?? [];
}

/**
 * Resolve a BoardConfig.package (e.g. "packages/<app>") to its deployable target id ("<app>"), or null
 * when the package is absent / not a declared target of this deployment. PURE — `targets` is injected so
 * the resolution is testable without touching settings, and the board-aware deploy routing derives the
 * orch-deploy target from this, never from a hardcoded app name.
 *
 * ⚠️ SEMÂNTICA DE ALLOWLIST, NÃO DE DERIVAÇÃO — e o `null` é lido com DOIS sentidos diferentes:
 * `deploy.ts` entende "não é um alvo de produto" e `instrumentation.ts` entende "é seguro no boot". O
 * pacote do próprio harness não está entre os alvos, e é por isso que ele responde null nos dois — ele
 * publica por systemd-run, não por `orch-deploy`. Uma versão que derivasse "todo board com package é
 * deployável" quebraria os dois sentidos de uma vez: o harness tentaria se auto-deployar pelo caminho
 * errado E deixaria de ser boot-safe.
 */
export function deployPkgForPackage(
  boardPackage: string | undefined,
  targets: readonly string[] = productDeployTargets(),
): string | null {
  if (!boardPackage) return null;
  const base = boardPackage.replace(/^packages\//, "").replace(/\/+$/, "");
  return targets.includes(base) ? base : null;
}

// story-efwo30 — A SUPERFÍCIE COMPOSTA: um alvo de deploy RESERVADO, que não é um app (não está em
// `deploy.targets`). Ela é um artefato único construído a partir das árvores web de VÁRIOS apps + o SDK
// compartilhado, publicado por uma receita própria FORA de qualquer manifesto de pacote (nenhum manifesto
// tem unidade de hosting, de propósito). Serve de chave de job no ProductDeployRegistry quando um release
// de board tocou a face, para ela andar pelo MESMO caminho rastreado/observável/idempotente de um deploy
// de app (ver o launcher default).
//
// OS TRÊS VALORES SAÍRAM DAQUI (eram literais) E FORAM PARA O settings.yaml DO ALVO. Motivo: "existe uma
// face composta, ela se chama X, publica-se com a receita Y e o manifesto Z declara o que a compõe" é
// config de UM repositório, não propriedade do motor — e enquanto foi literal aqui, o nome do produto de
// um dono viajava no fonte de uma ferramenta que outros repositórios vão usar.
//
// AUSENTE ⇒ este alvo não tem superfície composta. Isso NÃO é degradação silenciosa: é o estado `absent`,
// distinto de `unreadable`, e a diferença é o que impede uma face velha de passar por "No ar" (ver
// {@link composedFaceManifestStatus}).
const composedFaceCfg = () => loadRunnerConfig().deploy?.composedFace;

/** O alvo reservado da superfície composta, ou null quando este deployment não declara uma. */
export function composedFaceTarget(): string | null {
  return composedFaceCfg()?.target ?? null;
}

/** A receita que publica a superfície composta, ou null quando não há face declarada. */
export function composedFaceRecipe(): string | null {
  return composedFaceCfg()?.recipe ?? null;
}

/**
 * O caminho do manifesto da superfície composta, relativo à raiz do alvo — ou null se não houver face.
 *
 * Era uma constante exportada, e `oss-tree.ts` a importava para NOMEAR o arquivo que não viaja na
 * extração. Não importa mais: um caminho que vem do settings do alvo não tem como ser chave estática de
 * um mapa em código agnóstico. Quem precisa saber se há face pergunta pela DECLARAÇÃO
 * ({@link composedFaceManifestStatus}), que é a pergunta honesta — "este alvo declara uma superfície
 * composta?" — e não "este arquivo do umbrella existe?".
 */
export function composedFaceManifestRel(): string | null {
  return composedFaceCfg()?.manifest ?? null;
}

// story-g9kxo9 (2B) — which promoted paths COMPOSE the merged face. DERIVED from the SINGLE SOURCE the
// deployment DECLARES (the same manifest its own merge-build reads), so the gate can
// never silently fall behind what the face actually publishes — no more hand-kept mirror + drift-guard.
// Read via fs from the repo root at module load (server-only module — zero bundler coupling; findRepoRoot is
// memoized and already used below). Semantics mirror the merge-build matchesAny (gitignore-glob → anchored
// regex): a `**` glob is a directory PREFIX; a bare filename is an EXACT root file (so `packages/x/package.json`
// is NOT a face change). Derivation guarded by product-deploy.test.ts; manifest shape by the deployment.
interface ComposedFaceManifest {
  apps: { id: string; webDir: string; sub: string; turboPkg: string }[];
  sharedGlobs: string[];
}
// ── CARGA LAZY E OPCIONAL (F0 do plano multi-target) ────────────────────────────────────────────────
//
// O QUE MUDOU E POR QUÊ. Este bloco lia o manifesto em **module load** e LANÇAVA se ele não existisse.
// Como este módulo está na cadeia de import do dispatcher, um alvo que não seja este monorepo derrubava
// o serviço no `import`, antes de qualquer código multi-target rodar — é o PRIMEIRO erro que um segundo
// target produz, e o mais barato de detectar.
//
// A superfície composta é config de UM repositório, não uma propriedade do motor. Ausente ⇒
// simplesmente não há superfície composta. Mas a degradação é RUIDOSA e RASTREÁVEL, não silenciosa: o
// gate original lançava justamente para não deixar uma face velha passar por "No ar", e essa preocupação
// continua válida. Por isso `composedFaceManifestStatus()` — quem decide sobre publicação consulta e sabe
// distinguir "não há superfície composta declarada" de "havia e não consegui ler".
type FaceManifestStatus = "loaded" | "absent" | "unreadable";

type FaceManifestEntry = { manifest: ComposedFaceManifest | null; status: FaceManifestStatus };

// ── O QUE O CACHE MEMOIZA, E O QUE ELE DELIBERADAMENTE NÃO MEMOIZA (achado de revisão) ───────────────
//
// A versão anterior era um `let cache: … | null` único, preenchido nos TRÊS ramos — inclusive no
// `unreadable` de raiz irresolúvel. Duas consequências, ambas medidas:
//
//   1. ENVENENAMENTO PERMANENTE. Uma primeira chamada num contexto sem raiz resolvível fixava
//      `unreadable` para o resto da vida do processo, e a partir dali `requiresComposedFacePublish` caía
//      no ramo conservador para QUALQUER diff. O sintoma em produção é silencioso e caro: todo promote
//      republica a face composta, para sempre, até o serviço reiniciar. Não era hipotético —
//      `paths-fail-loud.test.ts` o produzia de propósito.
//   2. CACHE NÃO CHAVEADO PELA ENTRADA. A raiz É o insumo da leitura, e um cache escalar significa que,
//      com N alvos, o primeiro contamina os demais. Chavear agora custa uma linha; chavear depois de F1
//      custaria caçar um bug de contaminação cruzada.
//
// Logo: `Map<raiz, entrada>`, e **estado de erro não entra no mapa**. `unreadable` é sempre re-tentado —
// é uma condição transitória (raiz ainda não declarada, disco indisponível, arquivo sendo escrito), e
// cachear falha transitória é como um sistema fica preso num modo degradado sem ninguém entender por quê.
// `absent` É memoizado: "este alvo não declara superfície composta" é um fato estável do alvo.
const faceManifestCache = new Map<string, FaceManifestEntry>();

function loadComposedFaceManifest(): FaceManifestEntry {
  // ⚠️ A RAIZ VEM PRIMEIRO, E A ORDEM É UMA PROPRIEDADE DE SEGURANÇA — não estilo.
  //
  // Escrevi isto ao contrário na primeira versão (checar a DECLARAÇÃO antes da raiz, para um alvo sem
  // face não tocar disco), e `paths-fail-loud.test.ts` reprovou. Ele estava certo, e a razão é sutil: a
  // declaração mora no settings.yaml DO ALVO, e ler o settings exige a raiz. Sem raiz, o carregador cai
  // nos defaults — e defaults dizem "nenhuma face declarada", que é INDISTINGUÍVEL de um alvo que
  // realmente não tem face. Concluir `absent` ali faria `touchesComposedFace` responder false para
  // qualquer diff, e uma face velha passaria por "No ar": exatamente o buraco que o `throw` original
  // protegia, e que uma revisão anterior já tinha pego neste mesmo ponto.
  //
  // NÃO SABER É `unreadable`. Só depois de ter a raiz é que a ausência de declaração significa mesmo
  // "este alvo não tem superfície composta".
  let root: string;
  try {
    root = findRepoRoot();
  } catch {
    // Raiz não resolvida NÃO propaga daqui (é problema de quem chamou sem alvo) — mas também NÃO é
    // "absent". Uma revisão pegou este mapeamento: `absent` significa "nenhuma superfície DECLARADA", e
    // com ele um alvo cuja raiz não resolve concluiria "o diff não toca a face" e publicaria uma face
    // velha como se estivesse no ar — exatamente o buraco que o `throw` original protegia. Não saber é
    // `unreadable`, que o consumidor trata de forma conservadora.
    // NÃO CACHEADO: sem raiz não há chave, e "ainda não sei a raiz" é transitório por definição.
    return { manifest: null, status: "unreadable" };
  }
  // COM a raiz na mão, a ausência de declaração é um fato do alvo: ele não tem superfície composta —
  // e agora essa conclusão é honesta, porque o settings foi de fato consultado.
  const rel = composedFaceManifestRel();
  if (!rel) return { manifest: null, status: "absent" };
  // A chave inclui o CAMINHO DECLARADO, não só a raiz: o manifesto agora vem do settings do alvo, então
  // dois alvos podem declarar caminhos diferentes — e o mesmo alvo pode trocar o seu. Chavear só pela raiz
  // devolveria o manifesto antigo depois da troca, que é a contaminação que este cache já foi corrigido
  // uma vez para não ter.
  const chave = `${root}\u0000${rel}`;
  const memo = faceManifestCache.get(chave);
  if (memo) return memo;
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    const entry: FaceManifestEntry = { manifest: null, status: "absent" };
    faceManifestCache.set(chave, entry); // fato estável do alvo
    return entry;
  }
  try {
    const entry: FaceManifestEntry = {
      manifest: JSON.parse(readFileSync(file, "utf8")) as ComposedFaceManifest,
      status: "loaded",
    };
    faceManifestCache.set(chave, entry);
    return entry;
  } catch (err) {
    // Existe mas não parseia: isso É anormal e não pode virar "não há superfície". Grita — e NÃO cacheia,
    // para que corrigir o arquivo tenha efeito sem reiniciar o serviço.
    console.error(
      `[storymap] product-deploy: ${file} existe mas não pôde ser lido — ` +
        `${err instanceof Error ? err.message : String(err)}. Nenhuma superfície composta será considerada.`,
    );
    return { manifest: null, status: "unreadable" };
  }
}

/** Test-only: descarta a memoização do manifesto (todos os alvos). */
export function resetComposedFaceManifestCache(): void {
  faceManifestCache.clear();
}

/** Distingue "não declarado" de "declarado e ilegível" — quem decide publicação precisa da diferença. */
export function composedFaceManifestStatus(): FaceManifestStatus {
  return loadComposedFaceManifest().status;
}

/** Prefixos de diretório que compõem a superfície. Vazio ⇒ nenhuma superfície composta declarada. */
export function composedFacePrefixes(): string[] {
  const { manifest } = loadComposedFaceManifest();
  if (!manifest) return [];
  return [
    ...manifest.apps.map((a) => `${a.webDir}/`), // packages/<app>/web/ → a sub-rota da face
    ...manifest.sharedGlobs.filter((g) => g.endsWith("/**")).map((g) => g.slice(0, -"**".length)), // e.g. um SDK compartilhado
  ];
}

/** Arquivos de raiz que compõem a superfície. Vazio ⇒ nenhuma superfície composta declarada. */
export function composedFaceFiles(): string[] {
  const { manifest } = loadComposedFaceManifest();
  return manifest ? manifest.sharedGlobs.filter((g) => !g.includes("*")) : [];
}

/**
 * story-efwo30 — PURE: does this promoted diff require publishing the composed face? True when any changed
 * path is under an app's web tree / the shared SDK, or is a root workspace file that shifts dependency
 * resolution. `orch-deploy <pkg>` (backend/functions only) does NOT cover the face, so a true here means the
 * board deploy must ALSO fire the declared face recipe before the card can truthfully claim "No ar".
 */
export function touchesComposedFace(files: string[]): boolean {
  // ⚠ A PROPRIEDADE DE SEGURANÇA QUE O `throw` ANTIGO PROTEGIA (achado de revisão): o código original
  // lançava em vez de degradar para um gate vazio, "which would let a stale face pass as No ar".
  // Remover o throw sem recuperar isso trocaria um crash barulhento por um falso "não toca" silencioso.
  // Por isso os três estados são distintos, e só UM deles significa "não há superfície":
  //   absent     ⇒ nenhuma superfície composta DECLARADA neste alvo  ⇒ false é a resposta correta
  //   unreadable ⇒ existe e não pôde ser lido ⇒ NÃO SABEMOS ⇒ conservador: assume que toca
  //   loaded     ⇒ decide pelos prefixos
  if (composedFaceManifestStatus() === "unreadable") {
    console.error(
      "[storymap] product-deploy: manifesto da superfície ilegível — assumindo que o diff TOCA a face " +
        "(conservador). Um 'não toca' aqui publicaria uma face velha como se estivesse no ar.",
    );
    return true;
  }
  const prefixes = composedFacePrefixes();
  const rootFiles = composedFaceFiles();
  return files.some((f) => prefixes.some((p) => f.startsWith(p)) || rootFiles.includes(f));
}

export interface DeployJob {
  pkg: string;
  pid: number | null;
  logFile: string;
  startedAt: number;
  /** monotonic start sequence — stable tie-breaker for `latest()` when two starts share a `startedAt` ms. */
  startSeq: number;
  finishedAt?: number;
  status: "running" | "done" | "failed";
  exitCode?: number;
  /** story-harness-adk G3: the board + card that TRIGGERED this deploy (threaded from the onEnter effect),
   *  so an onDone subscriber can act on the specific card (revert it on failure). Absent for a manual MCP
   *  deploy with no card context. */
  board?: string;
  cardId?: string;
  /** story-5vv8n1 (t5): the release that fired this deploy just promoted NEW code, so a diff-aware deploy
   *  MUST do real work — a ~0s no-drift settle then means nothing shipped (see {@link deploySettledWithoutWork}). */
  expectWork?: boolean;
}

/** story-harness-adk G3: the event an onDone subscriber receives when a deploy SETTLES (done/failed). */
export interface DeployDoneEvent {
  pkg: string;
  ok: boolean;
  exitCode: number;
  /** the board + card that triggered the deploy (present when fired from a card's onEnter effect). */
  board?: string;
  cardId?: string;
  /** story-5vv8n1 (t5): wall-clock the deploy ran for (finishedAt − startedAt). A real orch-deploy is minutes;
   *  a no-drift diff-aware deploy exits in ~0s. */
  durationMs: number;
  /** story-5vv8n1 (t5): the deploy was expected to do real work (new code was promoted). */
  expectWork?: boolean;
  /** D-AG2 — false when the job ran a board-DECLARED deploy (shell command / agent) instead of the legacy
   *  diff-aware `just orch-deploy`. The instant-noop guard ({@link deploySettledWithoutWork}) only means
   *  something for a diff-aware deploy, so declared deploys are exempt. Absent (legacy) ⇒ diff-aware. */
  diffAware?: boolean;
  /** D-AG4 — the deploy AGENT's claimed published sha (from its verdict). A CLAIM, not proof: the settle
   *  re-measures it with the single ancestry ruler before any deployProof is stamped. Absent otherwise. */
  liveSha?: string;
}

/** story-5vv8n1 (t5): below this, a settled deploy did NO real work. A real orch-deploy (build + upload +
 *  Cloud Run revision) takes MINUTES; a diff-aware deploy of un-drifted code exits near-instantly. */
export const DEPLOY_INSTANT_NOOP_MS = 5_000;

/**
 * story-5vv8n1 (t5) — PURE: did a deploy SETTLE successfully but do NO real work? A diff-aware orch-deploy of
 * code that never reached main sees no drift → exits exit-0 in ~0s. That is NOT confirmation the code is live,
 * so when the release EXPECTED work (it promoted new code) an instant no-drift settle must be treated as a
 * failed publish (revert), not a green "No Ar". Guarded by `expectWork` so a LEGIT idempotent re-deploy (code
 * already live, nothing to ship) is never falsely reverted. Exported for tests.
 *
 * D-AG2 — the guard applies ONLY to the legacy diff-aware orch-deploy path (`diffAware !== false`). The
 * "~0s means nothing shipped" inference is a property of THAT tool (a no-drift diff exit), not of deploys
 * in general: a board-declared shell command (`vercel deploy --prod` on a warm cache, a one-line rsync)
 * can legitimately finish in under 5s having genuinely published — reverting it would be a false failure
 * the operator cannot distinguish from a real one. Declared deploys answer for themselves via their exit
 * code + the settle's proof measurement (no proof ⇒ the card holds in Publicando anyway — fail-closed).
 */
export function deploySettledWithoutWork(ev: DeployDoneEvent): boolean {
  return ev.ok && ev.expectWork === true && ev.diffAware !== false && ev.durationMs < DEPLOY_INSTANT_NOOP_MS;
}

/** The launch side-effect (spawn + log streaming), injected so the registry is testable. */
export interface DeployLaunch {
  pid: number | null;
  /** Register the completion callback; the launcher invokes it with the exit code (null/-1 on spawn error). */
  whenDone(cb: (code: number | null) => void): void;
  /** D-AG3 — the deploy AGENT's parsed verdict, read by the registry AT CLOSE TIME (inside whenDone) so
   *  the done event can carry `liveSha`. Absent for every non-agent launch. */
  verdict?: () => DeployAgentVerdict | null;
}

/**
 * D-AG2/D-AG3 — HOW a start is launched when the board DECLARES its own deploy (BoardConfig.deploy).
 * Absent spec ⇒ the legacy `just --yes orch-deploy <target>` / declared-face-recipe path, byte-identical.
 *   - "shell": the user's declared command, run `bash -lc` from the repo root (login shell, so the
 *     owner's PATH tooling — vercel, flyctl, gcloud — resolves as it would in their terminal);
 *   - "agent": one bounded headless claude following the board's declared recipe (deploy-agent-spawn).
 * Either way the launch feeds the SAME job tracking + onDone cycle — no parallel mechanism.
 */
export type DeployLaunchSpec = { kind: "shell"; command: string } | DeployAgentSpec;

export type DeployLauncher = (pkg: string, logFile: string, spec?: DeployLaunchSpec) => DeployLaunch;

/**
 * The log file an orch-deploy of `pkg` streams to (re-read by `tail` / deploy_status).
 *
 * ⚠️ O `pkg` É SANITIZADO AQUI, e não só onde ele entra. Enquanto os alvos eram um `z.enum` de constante
 * de código, o enum era — por acidente — a única coisa impedindo um alvo com `../` de escapar do diretório
 * de logs por esta interpolação. Os alvos agora vêm de configuração, o enum deu lugar a validação em
 * tempo de chamada, e uma barreira que existe por acidente não é barreira: ela vale enquanto ninguém
 * acrescenta um segundo caminho de entrada. Mesma peneira que `deployStatePath` já aplica ao alvo — o
 * precedente é do próprio módulo vizinho. Para um alvo em forma de slug (todos, depois do coerce) isto é
 * a identidade.
 */
export function logFileFor(pkg: string, root: string = findRepoRoot()): string {
  const seguro = pkg.replace(/[^a-z0-9_-]/gi, "");
  return path.join(root, ".artifacts", "logs", `mcp-deploy-${seguro}.log`);
}

/**
 * story-efwo30 — the `just` recipe (args after `--yes`) a deploy TARGET maps to. The reserved composed-face
 * target publishes the merged web face with the deployment's DECLARED recipe; every other id is a diff-aware
 * `orch-deploy <target>`. Keeps the ONE registry/launcher able to drive both without a parallel mechanism.
 *
 * `face` é injetável para manter a função PURA (era pura quando o alvo da face era uma constante de código;
 * continuar pura é o que deixa a tabela de casos testável sem tocar em settings).
 */
export function deployCommandFor(
  target: string,
  face: { target: string | null; recipe: string | null } = { target: composedFaceTarget(), recipe: composedFaceRecipe() },
): string[] {
  return face.target && face.recipe && target === face.target ? [face.recipe] : ["orch-deploy", target];
}

/** Default launcher: `just --yes <recipe>` as a child of this process, streaming to the log. The recipe is
 *  `orch-deploy <target>` for an app, or the declared recipe for the reserved composed-face target.
 *  D-AG2/D-AG3 — a `spec` reroutes the SAME launch shape to the board's DECLARED deploy: "shell" spawns
 *  the owner's command via `bash -lc`; "agent" delegates to deploy-agent-spawn (which owns its log
 *  stream + verdict). Everything downstream (tracking, onDone, revert, settle) is shared, by design. */
const defaultLauncher: DeployLauncher = (pkg, logFile, spec) => {
  if (spec?.kind === "agent") return launchDeployAgent(spec, { logFile });
  mkdirSync(path.dirname(logFile), { recursive: true });
  const out = createWriteStream(logFile, { flags: "w" });
  // Env SANEADO (spawn-env.ts): o serviço é um next-server cujo process.env VIVO carrega
  // __NEXT_PROCESSED_ENV=true — herdado, faz o `next build` da face PULAR o .env.production
  // (NEXT_PUBLIC_* undefined → auth/invalid-api-key; incidente 2026-07-09, gap do story-g9kxo9).
  let child;
  if (spec?.kind === "shell") {
    // D-AG2 — the board's declared deploy command, verbatim, from the repo root. `bash -lc` (login
    // shell) so the owner's profile PATH (vercel/flyctl/…) resolves like their own terminal would.
    out.write(`[deploy ${pkg}] $ ${spec.command}\n`);
    child = spawn("bash", ["-lc", spec.command], { cwd: findRepoRoot(), windowsHide: true, env: sanitizeSpawnEnv(process.env) });
  } else {
    // story-frente3 — `just` é ferramenta do HOST e o justfile do umbrella NÃO viaja na extração. Um
    // ENOENT aqui aparecia como "deploy falhou exit -1" com o log vazio: o `spawn` erra ANTES de escrever
    // qualquer linha, então o operador via um veredito sem causa. A recusa é escrita NO LOG (a superfície
    // que o deploy_status mostra) e o job termina com código não-zero — falha honesta, com o porquê.
    const just = resolveHostTool("just");
    if (!just.ok) {
      out.end(`[deploy ${pkg}] RECUSADO: ${just.refusal}\n`);
      return { pid: null, whenDone: (cb) => { setImmediate(() => cb(-1)); } };
    }
    const args = ["--yes", ...deployCommandFor(pkg)];
    out.write(`[deploy ${pkg}] ${just.path} ${args.join(" ")}\n`);
    child = spawn(just.path, args, { cwd: findRepoRoot(), windowsHide: true, env: sanitizeSpawnEnv(process.env) });
  }
  child.stdout?.on("data", (d) => out.write(d));
  child.stderr?.on("data", (d) => out.write(d));
  let onDone: ((code: number | null) => void) | undefined;
  child.on("close", (code) => {
    out.end(`\n[deploy ${pkg}] finished exit ${code}\n`);
    onDone?.(code);
  });
  child.on("error", (e) => {
    out.end(`\n[deploy ${pkg}] spawn error: ${e.message}\n`);
    onDone?.(-1);
  });
  return { pid: child.pid ?? null, whenDone: (cb) => { onDone = cb; } };
};

export class ProductDeployRegistry {
  private jobs = new Map<string, DeployJob>();
  private seq = 0;
  // story-harness-adk G3: subscribers notified when a deploy SETTLES (done/failed). Mirrors
  // engine.onComplete / mergeQueue.onMergeDone — lets the cascade wake on the deploy the harness ITSELF
  // launched, to confirm "No ar" on success or REVERT the optimistically-terminal card on failure (the
  // deploy was fire-and-forget, so a failed deploy used to leave the card lying "No ar" with no recovery).
  private doneListeners = new Set<(ev: DeployDoneEvent) => void>();

  constructor(private launcher: DeployLauncher = defaultLauncher) {}

  /** Subscribe to deploy completions; returns an unsubscribe fn (mirrors engine.onComplete). */
  onDone(cb: (ev: DeployDoneEvent) => void): () => void {
    this.doneListeners.add(cb);
    return () => this.doneListeners.delete(cb);
  }

  private emitDone(ev: DeployDoneEvent): void {
    for (const cb of this.doneListeners) {
      try {
        cb(ev);
      } catch (err) {
        console.error("[harness-deploy] done listener threw:", err instanceof Error ? err.message : err);
      }
    }
  }

  isRunning(pkg: string): boolean {
    return this.jobs.get(pkg)?.status === "running";
  }
  get(pkg: string): DeployJob | undefined {
    return this.jobs.get(pkg);
  }
  latest(): DeployJob | undefined {
    // startedAt desc, then startSeq desc — the seq is the stable tie-breaker when two deploys share a ms.
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt || b.startSeq - a.startSeq)[0];
  }

  /** Spawn `just --yes orch-deploy <pkg>` (via the launcher), tracking the job. `ctx` threads the board +
   *  card that triggered the deploy (an onEnter effect), so onDone subscribers can act on that card.
   *  story-5vv8n1 (t5): `ctx.expectWork` records that the release promoted NEW code, so an instant no-drift
   *  settle can be flagged as "nothing shipped" (deploySettledWithoutWork).
   *  D-AG2/D-AG3: an optional `spec` reroutes the launch to a board-DECLARED deploy (shell command /
   *  agent) with the job key = the board id — same tracking, same onDone, same everything downstream.
   *  The done event then carries `diffAware:false` (instant-noop exemption) and, for an agent whose
   *  verdict claimed one, `liveSha` (a claim the settle re-measures — D-AG4). */
  start(pkg: string, ctx?: { board: string; cardId: string; expectWork?: boolean }, spec?: DeployLaunchSpec): DeployJob {
    const logFile = logFileFor(pkg);
    const launch = this.launcher(pkg, logFile, spec);
    const startedAt = Date.now();
    const job: DeployJob = { pkg, pid: launch.pid, logFile, startedAt, startSeq: (this.seq += 1), status: "running", board: ctx?.board, cardId: ctx?.cardId, expectWork: ctx?.expectWork };
    launch.whenDone((code) => {
      const finishedAt = Date.now();
      job.status = code === 0 ? "done" : "failed";
      job.exitCode = code ?? -1;
      job.finishedAt = finishedAt;
      // D-AG3 — the agent's verdict is read HERE, at close time (it exists by now: the launch settles it
      // before invoking whenDone). Keys are added CONDITIONALLY so a legacy event stays byte-identical.
      const liveSha = launch.verdict?.()?.liveSha;
      // G3: notify subscribers so the cascade reacts to the deploy the harness launched (confirm / revert).
      this.emitDone({
        pkg,
        ok: code === 0,
        exitCode: code ?? -1,
        board: ctx?.board,
        cardId: ctx?.cardId,
        durationMs: finishedAt - startedAt,
        expectWork: ctx?.expectWork,
        ...(spec ? { diffAware: false as const } : {}),
        ...(liveSha ? { liveSha } : {}),
      });
    });
    this.jobs.set(pkg, job);
    return job;
  }

  async tail(job: DeployJob, n: number): Promise<string> {
    try {
      const c = await fsp.readFile(job.logFile, "utf8");
      return c.split("\n").slice(-n).join("\n");
    } catch {
      return "(sem log ainda)";
    }
  }
}

const KEY = Symbol.for("storymap.runner.productDeploy");
const store = globalThis as unknown as { [KEY]?: ProductDeployRegistry };

/** The process-global registry — shared by the MCP `deploy`/`deploy_status` tools AND the onEnter effect. */
export function getProductDeploy(): ProductDeployRegistry {
  return (store[KEY] ??= new ProductDeployRegistry());
}
