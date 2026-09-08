// resolution-judge-spawn — the IO behind rung 2 of the ladder (WS-10.1): ONE headless `/harness-resolve` run
// that reads a text divergence and judges each hunk cosmetic × substantive.
//
// The DIVISION OF LABOUR with semantic-resolution.ts is the whole design: that module decides WHEN to judge
// and owns the safety invariants; this one only knows HOW to spawn. The precedent is exact — the engine wires
// `RedriveHandler` the same way, and orchestrator-spawn.ts is the existing non-card spawn this is modelled on
// (the infra spawns an LLM without the copilot being on; the judge is infra, like the redrive).
//
// WHY THE WRAPPER, NOT THE LLM, IS THE AUTHORITY — the three things this file refuses to delegate:
//   1. THE WORKTREE, E AGORA A CERCA DO SO (F0 · ADR-067). Fresh, cut from the TARGET's current tip, torn
//      down at the end. The judge physically cannot write to stage/main (invariant 1) because it is never
//      in a checkout of them. Containment by construction beats containment by instruction: a prompt that
//      says "don't touch main" is a wish. Mas o worktree limitava só ONDE o agente estava, não o que ele
//      podia alcançar DAQUI: o spawn comprava autonomia plena com bypass de permissão, e o juiz é
//      alcançável EM BANDA (um run contido produz o diff que faz o merge train chamá-lo, sem humano no
//      meio). Era uma porta nomeada para SAIR da contenção do autorun. Hoje a autonomia vem da POSTURA
//      (`resolveJudgePosture`) — sandbox do SO quando há, RECUSA quando o modo é `required` e não há,
//      rebaixamento com perda real de Bash quando é `preferred` — e o portão confere, no argv final, que
//      a cerca prometida chegou ao comando.
//   2. THE ALL-OR-NOTHING RULE (invariant 2). The judge REPORTS verdicts; the code decides whether they add
//      up to a resolution. `allCosmetic()` is checked HERE, in TypeScript, before a single byte is committed
//      — so an LLM that judges 3 hunks cosmetic, 1 substantive and then helpfully resolves the 3 anyway gets
//      its work thrown away, not merged. The one place a partial resolution could enter is closed in code.
//   3. THE TRAILER (invariant 4). Machine-generated from the verdict the wrapper validated, never typed by
//      the judge — a provenance stamp the subject is trusted to write is not provenance.
//
// FAIL-CLOSED EVERYWHERE (invariant 6): a spawn error, a timeout, an unreadable verdict file, a malformed
// JSON, a verdict for a file that was never in the divergence — every one of them returns `error` and
// resolves NOTHING. This module never throws; the ladder above turns an error into an escalation.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { makeHarnessTempDir } from "./temp";
import os from "node:os";
import { boardsDir, runnerStateDir } from "@/lib/storymap/paths";
import {
  spawnContidoArgv,
  buildSpawnFlags,
  envelopeForSpawn,
  readTargetSettings,
  resolveAutonomyPosture,
  suporteDoHost,
  type AutonomyPosture,
  type PosturaDeps,
} from "./autonomy-sandbox";
import { mcpContainmentFlags } from "./flags";
import { buildAgentSpawnEnv } from "./headroom";
import { resolutionTrailer, type HunkAnalysis, type HunkVerdictKind, type JudgePort, type JudgeRequest, type JudgeVerdict } from "./semantic-resolution";
import { allCosmetic } from "./semantic-resolution";
import type { ExecFn } from "./worktree";

/** The judge's wall-clock budget. Generous relative to the work (read N hunks, emit a verdict) and bounded:
 *  an overrun is `judge-failed` ⇒ the human decides, which is exactly today's behaviour. */
const JUDGE_TIMEOUT_MS = 10 * 60_000;

/** The file the judge writes its verdict to, inside its own worktree. A FILE (not the final assistant
 *  message) because a verdict must be machine-read: prose "I think these are cosmetic" is not a contract,
 *  and parsing English to decide whether to merge code is how a judge becomes a rubber stamp. */
export const VERDICT_FILENAME = ".harness-resolution.json";

/** `--max-turns` for the judge. The `mechanical` profile carries no maxTurns of its own (WS-7 §7.2: the lean
 *  budget falls out of size-neutral signals ⇒ MAXTURNS_LEAN_BASELINE). This spawn is card-less, so there are
 *  no card signals to be neutral ABOUT — we name the same lean number directly rather than fabricating a
 *  synthetic card to route (which is the "spawn a resolution using the conflicted card's own signals" trap
 *  model-routing.ts explicitly warns about: it would scale the budget back UP). */
const JUDGE_MAX_TURNS = 40;

/** The judge's model/effort. WS-7 §7.2 declares `mechanical` = {modelCap: sonnet, effortCap: medium} in
 *  `_base/board.yaml`, and D10 puts "conflict resolution / semantic judge" on that profile ALWAYS. We pass
 *  the caps EXPLICITLY rather than resolving the profile: a board may opt out of the inherited pipeline and
 *  own its `routeProfiles`, so `resolveRouteProfile(MECHANICAL_PROFILE_ID)` returning null must mean "fall
 *  back to explicit sonnet/medium", NEVER "spawn uncapped" (model-routing.ts, D13 — the core cannot assume
 *  the consumer's config). The judge has no column and no card, so doors 1 and 2 have nothing to say here;
 *  naming the tier is not a fourth door, it is this spawn's only door. */
const JUDGE_MODEL = "sonnet";
const JUDGE_EFFORT = "medium";

/** The verdict JSON the judge writes. Validated structurally before it is trusted — see {@link parseVerdict}. */
interface RawVerdictDoc {
  hunks?: unknown;
  resolved?: unknown;
}

/**
 * Parse + VALIDATE the judge's verdict file. Returns the hunks, or an error string.
 *
 * Every rejection here is a fail-closed decision, not pedantry:
 *   - a non-`cosmetic`/`substantive` verdict string is NOT coerced to either. An unknown verdict means the
 *     judge did not answer the question it was asked, and defaulting it to `cosmetic` would auto-resolve on
 *     garbage while defaulting to `substantive` would silently hide a broken prompt. It is an ERROR.
 *   - a verdict naming a file OUTSIDE the divergence is an ERROR, not a filtered-out row: it means the judge
 *     is reasoning about a different tree than the one we are resolving, and the hunks it DID judge cannot
 *     be trusted either.
 *   - an empty hunk list is an ERROR (`allCosmetic` would also reject it, but saying so HERE gives the
 *     operator "the judge judged nothing" instead of the misleading "it found something substantive").
 * PURE — exported for tests.
 */
export function parseVerdict(raw: string, expectedFiles: readonly string[]): { hunks: HunkAnalysis[] } | { error: string } {
  let doc: RawVerdictDoc;
  try {
    doc = JSON.parse(raw) as RawVerdictDoc;
  } catch (err) {
    return { error: `veredito ilegível (JSON inválido): ${String(err instanceof Error ? err.message : err).slice(0, 120)}` };
  }
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.hunks)) {
    return { error: "veredito sem o array `hunks` — o juiz não respondeu no contrato" };
  }
  if (doc.hunks.length === 0) {
    return { error: "o juiz não emitiu veredito nenhum (hunks: []) — nada provado, nada resolvido" };
  }
  const allowed = new Set(expectedFiles);
  const hunks: HunkAnalysis[] = [];
  for (const [i, item] of doc.hunks.entries()) {
    if (!item || typeof item !== "object") return { error: `hunk #${i} não é um objeto` };
    const h = item as Record<string, unknown>;
    const file = typeof h.file === "string" ? h.file.trim() : "";
    const verdict = typeof h.verdict === "string" ? h.verdict.trim() : "";
    const rationale = typeof h.rationale === "string" ? h.rationale.trim() : "";
    const hunk = typeof h.hunk === "string" ? h.hunk : "";
    if (!file) return { error: `hunk #${i} sem \`file\`` };
    if (!allowed.has(file)) {
      return { error: `hunk #${i} julga \`${file}\`, que não está na divergência — o juiz olhou outra árvore` };
    }
    if (verdict !== "cosmetic" && verdict !== "substantive") {
      return { error: `hunk #${i} (${file}) tem veredito desconhecido \`${verdict}\` — dúvida ⇒ substantivo, escalado` };
    }
    if (!rationale) return { error: `hunk #${i} (${file}) sem \`rationale\` — um veredito sem porquê não é auditável` };
    hunks.push({ file, hunk, verdict: verdict as HunkVerdictKind, rationale });
  }
  return { hunks };
}

/** The context note handed to the judge. The escada + the invariants live in the SKILL.md (the prompt is part
 *  of the delivery); THIS note carries only the FACTS of this divergence — the D4 context-note pattern from
 *  the sister plan. Kept free of any language/framework word: the judge is application-agnostic by
 *  construction (D13), and a note that said "this is TypeScript" would be the first crack in that. PURE. */
export function buildJudgeContextNote(req: JudgeRequest, verdictPath: string): string {
  return [
    "# Divergência a julgar",
    "",
    `Origem: ${req.origin === "train" ? "merge train (integração de um run)" : "release (promoção stage→main)"}`,
    req.board ? `Board: ${req.board}` : "",
    req.cardId ? `Card: ${req.cardId}` : "",
    "",
    `Lado ALVO (o que já existe, e o que você MANTÉM quando os dois lados são equivalentes): \`${req.sides.ours}\``,
    `Lado ENTRANTE (o delta que tenta entrar): \`${req.sides.theirs}\``,
    `Base do delta: \`${req.base}\``,
    "",
    "Arquivos divergentes:",
    ...req.sides.files.map((f) => `- \`${f}\``),
    "",
    req.conflictDetail ? `Detalhe do conflito (stderr do git):\n\`\`\`\n${req.conflictDetail.slice(0, 500)}\n\`\`\`\n` : "",
    "Você está num worktree FRESCO e ISOLADO, cortado do lado ALVO. Você NÃO tem acesso a stage/main —",
    "e não deve tentar obtê-lo. O artefato que você produzir RE-ENTRA pelo mecanismo normal e a SUÍTE roda",
    "de novo sobre ele.",
    "",
    `Escreva seu veredito em \`${verdictPath}\` (JSON, contrato na SKILL.md). SEM veredito legível, nada é`,
    "resolvido e a divergência sobe para o humano.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** DI surface — the real spawn in prod, a fake in tests. Mirrors OrchestratorSpawnDeps. */
export interface JudgeSpawnDeps {
  /** the `claude` binary (settings.autorun.claudeBin) */
  claudeBin: string;
  exec: ExecFn;
  repoRoot: string;
  /** wall-clock budget; default {@link JUDGE_TIMEOUT_MS} */
  timeoutMs?: number;
  /**
   * DI da POSTURA (F0 · ADR-067). Em produção nenhum call-site passa isto: a postura vem de
   * {@link resolveJudgePosture}, o mesmo resolvedor do autorun. Existe para o teste poder exercitar
   * as duas pontas que importam — a RECUSA (que não pode spawnar) e a postura contida (cujo argv o
   * portão tem de aprovar) — sem depender de bwrap/socat estarem instalados na máquina de quem roda
   * a suíte. Injetar aqui não afrouxa nada: o que sai daqui ainda atravessa o portão, que lê o
   * settings NO DISCO e aborta se ele não for uma fronteira.
   */
  resolvePosture?: (cwd: string, key: string) => AutonomyPosture;
  /** DI do spawn — o teste captura o argv FINAL entregue ao CLI. Produção usa o `spawn` do node. */
  spawn?: typeof spawn;
}

/**
 * A POSTURA DE AUTONOMIA deste spawn (F0 · ADR-067) — o mesmo caminho do autorun e do `run_task`.
 *
 * ── POR QUE ESTA SUPERFÍCIE MIGROU ─────────────────────────────────────────────────────────────────
 * O juiz é alcançável EM BANDA a partir de um run já contido: o run produz um diff, o diff diverge, o
 * merge train chama o juiz — sem humano no meio. Enquanto ele comprava autonomia com bypass de
 * permissão, a fronteira do autorun tinha uma porta nomeada: bastava um run contido gerar a divergência
 * certa para nascer, sobre o MESMO código, um agente sem contenção nenhuma rodando como root. A cerca
 * não é uma cerca se um lado dela emite quem a pula.
 *
 * ── O ENVELOPE ─────────────────────────────────────────────────────────────────────────────────────
 * `isCode: true` com o `cwd` = o worktree FRESCO do juiz. Ele é o mundo inteiro deste spawn (invariante
 * 1), e é a árvore que o sandbox libera para escrita.
 *
 * ⚠ E o `projectRoot` é ESSE worktree, não `findRepoRoot()`. A detecção da cerca ampliável precisa ler
 * a cadeia de `.claude/settings.json` que o CLI de fato mescla, e o CLI sobe do cwd até o topo do
 * REPOSITÓRIO — que num worktree linkado é o próprio worktree (o `.git` de lá é um arquivo, e
 * `diretoriosDeSettings` para nele). Apontar para o checkout principal trocaria a cadeia certa por
 * outra: o arquivo que um run ANTERIOR pode ter escrito DENTRO desta árvore — o vetor de escalação
 * entre runs que a checagem existe para cortar — deixaria de ser lido, e a defesa ficaria inerte
 * exatamente onde ela é o único guarda.
 */
export function resolveJudgePosture(cwd: string, key: string, deps: PosturaDeps = {}): AutonomyPosture {
  return resolveAutonomyPosture({
    // Não é skill de board (o merge train spawna o juiz de conflito): sem isenção por trigger.
    trigger: null,
    tier: "full",
    // Ver a nota gêmea em `resolveReviewerPosture`: `suporteDoHost()` no lugar dos quatro argumentos
    // montados aqui, e `deps` para o teste poder INJETAR e afirmar sobre o valor entregue — em vez de
    // afirmar com regex sobre a fonte que a chamada está escrita, que foi reprovado três vezes.
    support: deps.support ?? suporteDoHost(),
    env: deps.env ?? process.env,
    ...envelopeForSpawn({ isCode: true, cwd, boardDataDir: boardsDir(), stateDir: runnerStateDir() }),
    stateRoot: runnerStateDir(),
    key,
    readTarget: deps.readTarget ?? readTargetSettings,
    writeSettings: deps.writeSettings,
  });
}

/**
 * O ARGV do juiz, PURO — a montagem sai do meio da função de IO para que a propriedade "a contenção
 * chegou ao comando" seja asserção, e não leitura de código. É a mesma lição de `buildSpawnFlags`:
 * inline, um revisor removeu o `--settings` e a suíte inteira ficou verde.
 *
 * `permissionArgs` vazio SÓ na válvula explícita: `--permission-mode` e o bypass de permissão se
 * excluem no CLI. Em todo o resto o modo é `acceptEdits`, que é load-bearing — as ferramentas nativas
 * de escrita rodam in-process e o sandbox do SO não as contém (medição da ADR-067).
 */
export function buildJudgeArgs(posture: AutonomyPosture, notePath: string): { args: string[]; needsRootBypass: boolean } {
  const { flags, needsRootBypass } = buildSpawnFlags({
    posture,
    permissionArgs: posture.kind === "unsandboxed-escape" ? [] : ["--permission-mode", "acceptEdits"],
    // O worktree limita os ARQUIVOS; nunca limitou a superfície MCP. O juiz não declara mounts, então
    // não recebe nenhum — um juiz mecânico de conflito não tem o que fazer com os conectores do dono.
    extraArgs: mcpContainmentFlags(),
  });
  return {
    args: [
      "-p",
      "/harness-resolve",
      "--output-format",
      "json",
      "--model",
      JUDGE_MODEL,
      "--effort",
      JUDGE_EFFORT,
      "--max-turns",
      String(JUDGE_MAX_TURNS),
      "--append-system-prompt-file",
      notePath,
      ...flags,
    ],
    needsRootBypass,
  };
}

/** Run one command, resolving with the exit code instead of throwing — the whole module treats a non-zero
 *  exit as an ANSWER to be classified, never as an exception to bubble. */
async function git(deps: JudgeSpawnDeps, cwd: string, cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const r = await deps.exec(`git ${cmd}`, { cwd, timeout: 60_000 });
    return { ok: true, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return { ok: false, stdout: String(e?.stdout ?? ""), stderr: String(e?.stderr ?? "") };
  }
}

/**
 * Spawn the `/harness-resolve` judge for ONE divergence and await its verdict. The lifecycle:
 *
 *   1. cut a FRESH worktree from `sides.ours` (the target's CURRENT tip — never a stale base: the whole
 *      point is to judge against what the target holds NOW);
 *   2. reapply the incoming delta onto it with `--3way`, so the conflicting regions are materialized as
 *      real conflict markers the judge can READ (a judge reasoning off a diff summary would be guessing);
 *   3. run the judge; it resolves the markers (if it deems them cosmetic) and writes its verdict file;
 *   4. VALIDATE: every hunk cosmetic (checked here, in code) ⇒ commit with the trailer and hand back the
 *      branch; anything else ⇒ commit NOTHING, return the analysis, tear the tree down.
 *
 * Never throws. Returns `error` on every failure mode (invariant 6).
 */
export async function spawnResolutionJudge(req: JudgeRequest, deps: JudgeSpawnDeps): Promise<JudgeVerdict> {
  const runId = randomUUID();
  const short = runId.slice(0, 8);
  const branch = `resolve/${short}`;
  const worktreePath = path.join(deps.repoRoot, ".worktrees", `resolve-${short}`);
  const tag = `[harness-resolve ${short}]`;
  let created = false;

  const teardown = async () => {
    if (!created) return;
    // --force: the tree carries the judge's edits (resolved or not); we are DONE with it either way. The
    // branch is deleted with it on an escalation — the forensic record is the ANALYSIS (persisted by the
    // caller onto the entry), not a pile of abandoned worktrees. On a RESOLUTION the caller has already
    // taken the ref (the branch outlives this teardown; `worktree remove` drops the checkout, not the ref).
    await git(deps, deps.repoRoot, `worktree remove --force ${JSON.stringify(worktreePath)}`);
  };

  try {
    // 1 — a fresh worktree of the TARGET's current tip. `-B` so a leftover ref from a crashed prior judge
    // never blocks the cut (the branch name is uuid-scoped, so this can only ever hit our own debris).
    const add = await git(deps, deps.repoRoot, `worktree add --force -B ${JSON.stringify(branch)} ${JSON.stringify(worktreePath)} ${JSON.stringify(req.sides.ours)}`);
    if (!add.ok) return { hunks: [], runId, error: `worktree do juiz falhou: ${add.stderr.slice(0, 200)}` };
    created = true;

    // 2 — reapply the incoming delta so the divergence exists as CONFLICT MARKERS in a real tree. Scoped to
    // the divergent files: the judge must reason about the conflict, not about everything else the delta
    // happens to carry. `--3way` is what produces markers instead of a flat reject.
    const spec = req.sides.files.map((f) => JSON.stringify(f)).join(" ");
    const patchFile = path.join(worktreePath, ".harness-resolution.patch");
    const diff = await git(deps, deps.repoRoot, `diff --binary ${JSON.stringify(req.base)}..${JSON.stringify(req.sides.theirs)} -- ${spec} > ${JSON.stringify(patchFile)}`);
    if (!diff.ok) {
      await teardown();
      return { hunks: [], runId, error: `diff do delta falhou: ${diff.stderr.slice(0, 200)}` };
    }
    // A clean apply here means there is NO conflict to judge — the caller's divergence was resolved by the
    // fresh base (the target moved). Report it as an error rather than "resolved": this module's contract is
    // to JUDGE a divergence, and silently returning a resolution for a conflict that evaporated would let a
    // stale caller re-enter an artifact it never analysed. Rung 0 exists to catch this case honestly.
    const apply = await git(deps, deps.repoRoot, `-C ${JSON.stringify(worktreePath)} apply --3way ${JSON.stringify(patchFile)}`);
    await fs.rm(patchFile, { force: true }).catch(() => {});
    if (apply.ok) {
      await teardown();
      return { hunks: [], runId, error: "o delta aplicou LIMPO na base atual — não há divergência a julgar (o alvo mudou)" };
    }

    // 3 — run the judge inside its worktree.
    //
    // A POSTURA é resolvida AQUI, e não antes: a detecção da cerca ampliável lê o estado ATUAL da
    // árvore que o juiz vai ocupar, e essa árvore só existe depois do passo 1. Um run anterior que
    // tenha escrito `.claude/settings.json` no código sob julgamento aparece nesta leitura — é
    // justamente o caminho de escalação entre runs que a checagem corta.
    const posture = (deps.resolvePosture ?? resolveJudgePosture)(worktreePath, `resolve-${runId}`);
    if (posture.kind === "refused") {
      // Fail-closed, na mesma moeda de todo o resto do módulo (invariante 6): sem contenção não há
      // juiz, e sem juiz a divergência sobe para o humano — que é o comportamento de hoje, não uma
      // regressão. Melhor um conflito escalado do que um agente sem cerca sobre o código do run.
      await teardown();
      return { hunks: [], runId, error: `autonomia sem contenção recusada: ${posture.reason}` };
    }
    if (posture.kind === "downgraded" || posture.kind === "unsandboxed-escape") console.warn(`${tag} ⚠ ${posture.warn}`);

    const verdictPath = path.join(worktreePath, VERDICT_FILENAME);
    // 181 órfãos vieram daqui: a remoção só existia em dois RAMOS, e `teardown()` remove o worktree,
    // não este diretório — qualquer throw entre a criação e o ramo vazava. Agora ele nasce na raiz do
    // harness, que a varredura alcança.
    const noteDir = await makeHarnessTempDir("harness-resolve");
    const notePath = path.join(noteDir, "context.md");
    const outPath = path.join(noteDir, "out.json");
    const errPath = path.join(noteDir, "err.txt");
    await fs.writeFile(notePath, buildJudgeContextNote(req, VERDICT_FILENAME), "utf8");

    const spawnFailure = await runJudge(deps, { worktreePath, notePath, outPath, errPath, tag, posture });
    if (spawnFailure) {
      await fs.rm(noteDir, { recursive: true, force: true }).catch(() => {});
      await teardown();
      return { hunks: [], runId, error: spawnFailure };
    }

    // 4 — the verdict, validated in code.
    const rawVerdict = await fs.readFile(verdictPath, "utf8").catch(() => "");
    await fs.rm(noteDir, { recursive: true, force: true }).catch(() => {});
    if (!rawVerdict.trim()) {
      await teardown();
      return { hunks: [], runId, error: `o juiz não escreveu ${VERDICT_FILENAME} — sem veredito, nada resolvido` };
    }
    const parsed = parseVerdict(rawVerdict, req.sides.files);
    if ("error" in parsed) {
      await teardown();
      return { hunks: [], runId, error: parsed.error };
    }

    // INVARIANT 2, enforced in code: anything short of "every hunk cosmetic" commits NOTHING. The judge's
    // edits die with the worktree; the operator gets the analysis. This is the line that makes "3 cosmetic +
    // 1 substantive ⇒ none applied" a property of the system rather than a hope about the prompt.
    if (!allCosmetic(parsed.hunks)) {
      await teardown();
      return { hunks: parsed.hunks, runId };
    }

    // Every hunk cosmetic ⇒ materialize the artifact. The verdict file itself is REMOVED before the commit:
    // it is the judge's scratch channel, not part of the delta, and shipping it to stage would put a
    // machine's homework into the product tree.
    await fs.rm(verdictPath, { force: true }).catch(() => {});
    const leftover = await git(deps, deps.repoRoot, `-C ${JSON.stringify(worktreePath)} diff --check`);
    if (!leftover.ok) {
      // `diff --check` fails when conflict markers survive: the judge said "all cosmetic" but left the tree
      // in conflict. Trust the TREE over the claim — an artifact with markers would be a broken tree that
      // only the gate would catch, and inv. 1 says the gate is the backstop, not the first line.
      await teardown();
      return { hunks: parsed.hunks, runId, error: "o juiz alegou tudo cosmético mas deixou marcadores de conflito na árvore — resolução descartada" };
    }
    const add2 = await git(deps, deps.repoRoot, `-C ${JSON.stringify(worktreePath)} add -A`);
    if (!add2.ok) {
      await teardown();
      return { hunks: parsed.hunks, runId, error: `stage da resolução falhou: ${add2.stderr.slice(0, 160)}` };
    }
    // --no-verify mirrors every other unattended commit in the runner (the split/release commits): the
    // security gate is the secret-scan the NORMAL mechanism runs when this artifact re-enters, not a
    // pre-commit hook here.
    const msg = `resolve: divergência cosmética resolvida pelo juiz (${parsed.hunks.length} hunk(s))\n\n${resolutionTrailer(parsed.hunks.length, runId)}`;
    const committed = await git(deps, deps.repoRoot, `-C ${JSON.stringify(worktreePath)} commit --no-verify -m ${JSON.stringify(msg)}`);
    if (!committed.ok) {
      await teardown();
      return { hunks: parsed.hunks, runId, error: `commit da resolução falhou: ${committed.stderr.slice(0, 160)}` };
    }
    const head = await git(deps, deps.repoRoot, `rev-parse ${JSON.stringify(branch)}`);
    await teardown(); // drop the CHECKOUT; the branch/ref survives for the caller to re-enter
    if (!head.ok || !head.stdout.trim()) {
      return { hunks: parsed.hunks, runId, error: "não foi possível resolver o sha da resolução" };
    }
    console.log(`${tag} resolveu ${parsed.hunks.length} hunk(s) cosmético(s) → ${branch}`);
    return { hunks: parsed.hunks, runId, resolvedRef: branch };
  } catch (err) {
    await teardown().catch(() => {});
    return { hunks: [], runId, error: `juiz falhou: ${String(err instanceof Error ? err.message : err).slice(0, 200)}` };
  }
}

/** Spawn the CLI and await its exit. Returns an error string, or null on a clean run. Stdout/stderr go to
 *  FILES, never pipes — the orchestrator-spawn lesson: a CLI that dies at startup writes its only clue to
 *  stderr, and an `ignore`d stderr turns every launch failure into a mute "exit 1". */
async function runJudge(
  deps: JudgeSpawnDeps,
  opts: { worktreePath: string; notePath: string; outPath: string; errPath: string; tag: string; posture: AutonomyPosture },
): Promise<string | null> {
  const { args, needsRootBypass } = buildJudgeArgs(opts.posture, opts.notePath);
  // ── O ÚLTIMO PORTÃO, DEPOIS DE TODA A MONTAGEM ───────────────────────────────────────────────────
  // Roda sobre o argv EXATO que vai para o CLI, imediatamente antes do spawn: é o último ponto em que
  // ainda se pode saber o que será executado. Uma checagem mais cedo verificaria outra coisa que não a
  // executada — e foi assim que a mesma mutação (descartar o `--settings` entre a montagem e o spawn)
  // passou verde duas vezes noutras superfícies. Ele LÊ o settings no disco: se o arquivo não for uma
  // fronteira, ou tiver mudado desde a postura, aborta. O throw vira erro do módulo (nunca escapa) e o
  // erro é fail-closed — nada é resolvido.
  const env = await buildAgentSpawnEnv(process.env); // sanitizeSpawnEnv ⊕ headroom (2026-07-28)
  // ── IS_SANDBOX: AFIRMADO SÓ NA VÁLVULA, E NUNCA HERDADO ─────────────────────────────────────────
  // É o que o CLI exige para aceitar autonomia plena rodando como root. Antes era emitido sempre que o
  // serviço fosse root — ou seja, um juiz CONTIDO nascia declarando ao CLI que já estava num sandbox
  // (que quem monta é o harness), e um default que reintroduz o bypass é exatamente o que a lente de
  // deriva do tier existe para pegar. Agora só a postura de escape o liga (`needsRootBypass`).
  //
  // O `delete` NÃO é simetria decorativa: MEDIDO nesta caixa, o processo do serviço pode já carregar
  // `IS_SANDBOX=1` no próprio ambiente (herdado de quem o iniciou), e `sanitizeSpawnEnv` não remove
  // essa chave — então o filho receberia a afirmação sem nenhuma superfície a ter pedido. Uma
  // declaração de contenção que chega por herança é a classe "defesa presente e sem sujeito" que este
  // trabalho remove: quem afirma tem de ser quem decidiu.
  if (needsRootBypass && process.platform !== "win32" && process.getuid?.() === 0) env.IS_SANDBOX = "1";
  else delete env.IS_SANDBOX;

  const out = await fs.open(opts.outPath, "a");
  const err = await fs.open(opts.errPath, "a");
  const doSpawn = deps.spawn ?? spawn;
  try {
    return await new Promise<string | null>((resolve) => {
      // ── VERIFICA E SPAWNA NA MESMA EXPRESSÃO ─────────────────────────────────────────────
      // O assert avulso que existia ~25 linhas acima foi ABSORVIDO aqui. Ele estava certo em
      // rodar sobre o argv exato, mas um revisor mediu no engine o preço da distância: com o
      // assert numa linha e o spawn em outra, reescrever o valor no meio passava na suíte
      // inteira. O throw daqui é capturado pelo `catch` do módulo — fail-closed, nada aprovado.
      const child = spawnContidoArgv(opts.posture, args, (verificado) =>
        doSpawn(deps.claudeBin, verificado as string[], {
        cwd: opts.worktreePath, // the judge's whole world (invariant 1)
        stdio: ["ignore", out.fd, err.fd],
          env,
        }),
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(`o juiz estourou o orçamento de ${Math.round((deps.timeoutMs ?? JUDGE_TIMEOUT_MS) / 1000)}s`);
      }, deps.timeoutMs ?? JUDGE_TIMEOUT_MS);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(`spawn do juiz falhou: ${e.message}`);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        // A non-zero exit does NOT short-circuit: the judge may have written a valid verdict and then died on
        // teardown. The verdict FILE is the contract (that is why it is a file) — let the caller read it and
        // decide. A run that died WITHOUT writing one is caught there, with a clearer message than "exit 1".
        if (code !== 0) console.warn(`${opts.tag} juiz saiu com exit ${code} — lendo o veredito assim mesmo`);
        resolve(null);
      });
    });
  } finally {
    await Promise.all([out.close(), err.close()]).catch(() => {});
  }
}

/** The real {@link JudgePort} — what the train/release wire in prod. */
export function makeJudgePort(deps: JudgeSpawnDeps): JudgePort {
  return (req) => spawnResolutionJudge(req, deps);
}
