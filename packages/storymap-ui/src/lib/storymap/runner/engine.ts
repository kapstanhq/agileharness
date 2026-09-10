// Runner engine — the spawn CORE of the AgileHarness autorun pipeline, extracted from
// the trigger-runner channel as a process-global singleton so BOTH paths share ONE
// concurrency cap + in-flight lock + registry:
//   - the trigger-runner channel  → autorun, event-driven (card enters an auto column)
//   - the `runCardSkillAction`     → manual "Rodar agora" from a card (any column)
// Mirrors getRunnerRegistry's globalThis-Symbol pattern (survives Next dev HMR; the
// channel and a server action load as separate modules but share ONE instance).

import { spawn, type ChildProcess } from "node:child_process";
import { resolverAliasesDeEnv } from "@/lib/storymap/env-aliases";
import { existsSync, mkdirSync, promises as fsp, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
// Frontmatter de card SEMPRE pelo chokepoint (nunca `matter()` direto): estes dois sítios leem o .md
// de uma ÁRVORE DE RUN — a superfície mais exposta, porque o conteúdo é o que o agente/PR acabou de
// escrever. Ver o cabeçalho de frontmatter.ts. `assertStatWithinByteCap` fecha o teto ANTES do read
// (o teto do parse mede uma string já materializada, ou seja, protege o parser e não a memória).
import { assertStatWithinByteCap, describeFrontmatterError, parseFrontmatter } from "@/lib/storymap/frontmatter";
import { boardsDir, cardPath, findRepoRoot, findToolPackageDir, proposalPath, runnerStateDir, sanitizeId, findToolRoot } from "@/lib/storymap/paths";
import { getRunnerRegistry } from "./registry";
import { boardDataAutoPushAllowed } from "./board-data-policy";
import { loadRunnerConfig, maxTurnsResumeMax, resolveCardArgs, resolveColumnArgs } from "./config";
import { newRunSessionId, newScopeNonce } from "./session-id";
import { getRunnerJournal, osBootMs, type RunnerJournalPort, type RunOutcome } from "./journal";
import { getCardClaims, type CardClaimsPort, type ClaimKind } from "./claims";
import { defaultExec, defaultWorktreeOps, runBranch, type WorktreeOps } from "./worktree";
import {
  branchWorkLandedBySplit,
  deltaLanded,
  expectedDeltaOf,
  projectSplitVerdict,
  type DeltaLandedFn,
  type SplitLandedness,
} from "./convergence";
import { pathsTouchUiSurface, uiSurfacePaths } from "./staging";
import { resolveRunBase } from "./run-base";

/** Quantos paths de exemplo a evidência guarda — o suficiente para o operador entender POR QUE o card
 *  foi classificado como tendo tela, sem transformar o card num despejo do diff. */
const UI_SURFACE_EVIDENCE_PATH_CAP = 5;
import { getMergeQueue, type MergeQueuePort } from "./merge-queue";
import { serialCommit, type CommitSerializer } from "./commit-serializer";
import { classifyTrigger, isVpsOverloaded, probeVpsResources, type RunLane, type VpsResources } from "./scheduler";
import { ADVANCE_ON_SUCCESS_SKILLS, capTier, CODE_SKILLS, FULL_AUTONOMY_SKILLS, REQUIRES_CODE_ARTIFACTS_SKILLS, systemPromptFor, tierOf } from "./skill-registry";
import { appendTransition } from "./transitions";
// F0 (ADR-067) — a postura de autonomia: contenção do SO no lugar do bypass de permissão.
// Sete símbolos saíram daqui em 2026-08-05 (detectSandboxSupport, hasExecutable, resolveAutonomyPosture,
// runSetgroupsProbe, runNamespaceProbe, envelopeForSpawn, readTargetSettings): eram resíduo da migração
// para `resolveEnginePosture` e apareciam SÓ na linha de import. Não é higiene cosmética — um import
// morto faz a superfície pública do módulo parecer maior do que é, e um símbolo que "tem chamador de
// produção" é exatamente o que impede alguém de apagá-lo depois.
import { buildSpawnFlags, resolveEnginePosture, spawnContidoCmd, suporteDoHost, unsandboxedFullAllowed } from "./autonomy-sandbox";
import { detectSystemd, runScopeUnit, stopRunScope, wrapWithScope, type StopScopeResult, type SystemdCheck } from "./governor";
import { devServerPidFile, reapDevServerPid, type ReapPidResult } from "./dev-server";
import { createNdjsonParser, extractFinalResult, extractResultUsage, extractSpecialistDelegations, extractToolNames, isMaxTurnsResult, summarizeStreamEvent, type RunResult } from "./stream-json";
import { getTelemetryStore, isSuccessWithWarning, type TelemetryPort } from "./telemetry";
import { readCards, readBoardConfig } from "@/lib/storymap/repo";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { withMergeBackFailureFinding, withCapabilityUnavailableFinding, withCapabilityUnavailableResolved } from "./findings";
import { toolTreeFlags, toolkitFlags } from "./flags";
import {
  resolveToolkit,
  computeToolGap,
  requiredCapabilities,
  applyActiveProviders,
  buildCapabilityNote,
  expectsForActiveProviders,
  type ResolvedToolkit,
  type ActiveProviderChoice,
} from "@/lib/storymap/toolkit";
import { resolveCapabilities, describeUnavailable, type CapabilityResolution } from "./capability-probe";
import { hasUiSurface } from "@/lib/storymap/gate-core";
import { sanitizeSpawnEnv } from "./spawn-env";
import { getAddressedIdea, isAddressesLink } from "@/lib/storymap/idea";
import { applyHeadroomEnv, resolveHeadroomUrl } from "./headroom";
import { DependencyGraph, getDependencyGraph } from "./dep-graph";
import type { EnqueueResult, RunnerFailure } from "./types";
import type { AutonomyTier, BoardConfig, Card, RunnerSettings, StatusDef, TriggerId } from "@/lib/storymap/types";
import { AUTONOMY_TIERS } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "./claude-bin";

/** The headless `/<skill>` command for a trigger. A trigger id IS the skill name (uma convenção
 * validada pelo skill-board-consistency.test), então o comando é só `/<triggerId>` — sem Record
 * exaustivo a manter em lockstep: adicionar uma skill não toca mais aqui. Pure — exported for tests. */
export function commandForTrigger(trigger: TriggerId): string {
  return `/${trigger}`;
}

// SM-09: a board id → its brand-voice doc (relative to repo root). The autorun spawn injects an
// instruction to read this alongside the app's CLAUDE.md, so copy honors the app's voice even from
// a `.md`-only skill that never opens the package. Boards without a brandbook (storymap, admin,
// nimbus, mosaico-app) map to null → only the package CLAUDE.md is injected (AC4). Keyed by the board
// folder/id (the `board` arg of runSkill == the folder under storymap/boards/).
/** The brandbook path for a board — read from its board.yaml `brandbook:` field (source of truth),
 *  or null when unset or shell-unsafe. Like `package:`, this path is interpolated into the spawn
 *  `-p "..."`, so it MUST pass SAFE_PKG_PATH (a typo/hostile quote fails open to no brandbook rather
 *  than corrupting the command). Pure — exported for tests. */
export function brandbookPathFor(boardConfig: BoardConfig | null): string | null {
  const b = boardConfig?.brandbook;
  return b && SAFE_PKG_PATH.test(b) ? b : null;
}

// A board.yaml `package:` path is interpolated verbatim into the headless `-p "..."` shell command
// (via the context note), so — exactly like the board/card SLUG guard above — it MUST be free of
// shell metacharacters (`"`, `;`, `$`, backticks) that could break out of the quotes. Real package
// paths are `packages/<slug>`: letters, digits, `/`, `.`, `_`, `-`. The `package` field is read raw
// from YAML with no schema validation, so a stray quote (typo or hostile config) would otherwise
// corrupt the spawn for every run on that board → we fail-open to the legacy prompt instead.
const SAFE_PKG_PATH = /^[A-Za-z0-9._/-]+$/;

// A board/persona slug safe to interpolate into the `-p "..."` context note (ids only, no paths).
// Stricter than SAFE_PKG_PATH (no `/` or `.`) — mirrors the board/cardId SLUG guard further down.
const SAFE_SLUG = /^[a-z0-9-]+$/i;

/**
 * D13 (canal 1) — the style guide's REPO-RELATIVE path for a board, DERIVED from its slug — never a
 * stored path. board.yaml's `styleGuide` field is the D10 pointer ({version, hash} only — see
 * style-guide.ts `StyleGuidePointer`), path-FREE by design, so the canonical path is always computed
 * here rather than read off config. Mirrors `brandbookPathFor`'s shape (a guarded path-or-null a note
 * can interpolate), but the guard is SAFE_SLUG on the boardId (mirrors the board slug guard in
 * buildContextNote) rather than SAFE_PKG_PATH on a stored string — nothing here is read off disk.
 * Returns null (fail-open) when the board has no published guide yet OR the boardId is off-charset —
 * either way the caller omits the note rather than risk a corrupted spawn. Pure — exported for tests.
 */
export function styleGuidePathFor(boardId: string, boardConfig: BoardConfig | null): string | null {
  if (!boardConfig?.styleGuide) return null;
  if (!boardId || !SAFE_SLUG.test(boardId)) return null;
  return `storymap/boards/${boardId}/design/style-guide.md`;
}

/**
 * D13 (canal 1) — the style-guide note, joined into composeSystemPrompt as its OWN independent part.
 * Deliberately NOT folded into buildContextNote (below), which returns null on its very first line
 * for a board without `package:` — a style guide on a `package:`-less board is a FIRST-CLASS
 * supported case (00-conteudo-do-guia.md §"Semântica das direções": no `package:` ⇒ the generator
 * skips the on-brand direction and offers reference-led + synthesis instead — it never disqualifies
 * the board from having a guide), so nesting this note inside buildContextNote would silently kill it
 * on exactly the boards that most need reference-led/synthesis grounding. One line, path-only,
 * instructs the agent to read the guide BEFORE UI/copy/frontend work and ignore it otherwise — keeps
 * the cost (~30 tokens/run) FLAT across every trigger (enrich/prioritize included — risco 5 do
 * README) instead of growing with guide content. NEVER inlines the guide's prose (which may carry
 * quotes/`$`/newlines) — only the derived path + version, both shell-safe by construction, so this
 * note is safe on the compaction-proof --append-system-prompt-file channel same as buildContextNote.
 * Fail-open to null: no guide yet, or a hostile boardId → composeSystemPrompt drops it, byte-identical
 * to a board with no guide. Pure — exported for tests.
 */
export function buildStyleGuideNote(boardId: string, boardConfig: BoardConfig | null): string | null {
  const guidePath = styleGuidePathFor(boardId, boardConfig);
  if (!guidePath) return null;
  const version = boardConfig?.styleGuide?.version;
  return `O board tem guia de estilo em ${guidePath} (v${version}) — leia ANTES de qualquer trabalho de UI, copy ou frontend; para outros trabalhos, ignore.`;
}

/**
 * SM-09: build the per-app context note injected into the spawn prompt — an explicit instruction to
 * read the target app's `packages/<pkg>/.claude/CLAUDE.md` (+ the board's brandbook when one exists)
 * BEFORE any code or copy, so even a `.md`-only skill (enrich/prioritize/tasks/plan/ux) honors the
 * app's conventions and brand voice it would otherwise never load (the worktree auto-loads ONLY the
 * monorepo-root CLAUDE.md). Returns null when the board has no `package:` mapping — AC4: the note is
 * omitted silently and the spawn never fails. Also returns null when `package:` carries shell-unsafe
 * characters (fail-open to the legacy prompt rather than risk a corrupted command). Pure — exported for tests.
 */
export function buildContextNote(
  boardConfig: BoardConfig | null,
  opts?: { board?: string; personaIds?: string[]; systemIds?: string[]; addressedIdeaId?: string | null },
): string | null {
  const pkg = boardConfig?.package;
  if (!pkg || !SAFE_PKG_PATH.test(pkg)) return null;
  const appClaudePath = `${pkg}/.claude/CLAUDE.md`;
  const brandbook = brandbookPathFor(boardConfig);
  const docs = brandbook ? `${appClaudePath} e ${brandbook}` : appClaudePath;
  let note = `Context: antes de qualquer ação de código ou copy, leia ${docs} para respeitar as convenções específicas deste app.`;
  // story-personas-as-prompt: ground the run in WHO it serves (personas) and WHAT it touches (systems).
  // Both are now authored as full prompts (BoardConfig.personas[].prompt / systems[].prompt), but the
  // prose carries quotes/`$`/newlines and the note is interpolated VERBATIM into `-p "..."` — so we
  // NEVER inline it. Instead we append a SHELL-SAFE pointer: ids + the board slug only (all SLUG-guarded;
  // anything unsafe is dropped, fail-open), telling the agent to READ the rich prompts from board.yaml.
  const board = opts?.board;
  if (board && SAFE_SLUG.test(board)) {
    const slugSafe = (ids?: string[]) => (ids ?? []).filter((id) => typeof id === "string" && SAFE_SLUG.test(id));
    const personaIds = slugSafe(opts?.personaIds);
    const systemIds = slugSafe(opts?.systemIds);
    // story → ideia → Resultado-alvo → métrica de negócio: ancora a especificação no PRD, o documento
    // mais alto do board. Continua PONTEIRO e não conteúdo: o texto do PRD carrega aspas, `$` e
    // quebras de linha, e esta nota é interpolada verbatim num `-p "..."` — inliná-la seria injeção de
    // shell com passos extras. Só o slug viaja, e ele já passou pelo SAFE_SLUG.
    //
    // O ponteiro é incondicional porque o caminho do arquivo é o mesmo tenha o board escrito o PRD ou
    // não: um `read_doc`/leitura num PRD vazio devolve o esqueleto, que É a resposta certa ("este
    // board ainda não declarou norte") — enquanto a nota condicional de antes simplesmente OMITIA a
    // existência do documento, e o agente seguia sem saber que havia onde olhar.
    note += ` O PRD deste board — problema, público, posicionamento, objetivos, escopo e as decisões JÁ TOMADAS — vive em storymap/boards/${board}/docs/prd.md (ou, se o arquivo ainda não existir, na escada estratégica do storymap/boards/${board}/board.yaml). Leia-o e mantenha a especificação alinhada a ele; a seção "Decisões já tomadas" existe para você NÃO re-decidir o que já foi decidido.`;
    if (personaIds.length > 0) {
      note += ` Este item atende a(s) persona(s) ${personaIds.join(", ")} — leia o bloco \`personas\` em storymap/boards/${board}/board.yaml e escreva sob a ótica dela(s).`;
    }
    if (systemIds.length > 0) {
      note += ` Ele toca o(s) sistema(s) ${systemIds.join(", ")} — leia o bloco \`systems\` em storymap/boards/${board}/board.yaml e respeite as capacidades e limites descritos.`;
    }
    // dual-track OST (Fatia 4): uma story pode `addresses` uma ideia (a DOR que ela fecha). Hidrata
    // o run com ela para o agente ver o PORQUÊ, não só a task. Shell-safe: SÓ o id slug-guarded (o statement
    // carrega aspas/`$`/quebras-de-linha → NUNCA inline; aponta para o card). Resolvido FORA (call site), aqui só interpola.
    const oppId = opts?.addressedIdeaId;
    if (oppId && SAFE_SLUG.test(oppId)) {
      note += ` Esta story endereça a ideia ${oppId} — leia o card em storymap/boards/${board}/cards/${oppId}.md (o espaço do problema) para entender a dor que ela fecha, e mantenha o build focado em fechá-la, não só em cumprir a task.`;
    }
  }
  return note;
}

/**
 * The `-p` prompt argument for a headless run: the `/<skill> board/card` command, optionally followed
 * (after a blank line) by a per-app context note (SM-09). Centralizes the shape so buildClaudeCommand
 * and buildResumeCommand stay in lock-step. The note carries no shell metacharacters (only paths +
 * prose), so it is safe inside the `-p "..."` double quotes. Pure — exported for tests.
 */
export function buildPrompt(promptCommand: string, key: string, contextNote?: string | null): string {
  return contextNote ? `${promptCommand} ${key}\n\n${contextNote}` : `${promptCommand} ${key}`;
}

/**
 * story-harness-cc #1 + #3: join the per-app context note (buildContextNote) with the per-skill system
 * invariants (skill-registry systemPromptFor) into the body written to the run's `--append-system-prompt-
 * file`. Either part may be null; returns null when BOTH are absent (⇒ no file written, legacy behavior).
 * Pure — exported for tests.
 */
export function composeSystemPrompt(...parts: (string | null)[]): string | null {
  const cleaned = parts.map((p) => (p ? p.trim() : "")).filter((p) => p.length > 0);
  return cleaned.length ? cleaned.join("\n\n") : null;
}

/**
 * WS3 (F2) — the toolkit NOTE: the step's usage guidance + specialist clause, injected into the
 * COMPACTION-PROOF system-prompt file (re-emitted every turn, survives a long run's compaction) so the
 * prescription "use graphify BEFORE proposing architecture" lives in the durable channel, not only in
 * the SKILL.md prose. Fail-open: no guidance AND no specialists ⇒ null ⇒ composeSystemPrompt drops it ⇒
 * the prompt file is BYTE-IDENTICAL to the legacy body (a step with no toolkit is untouched). Rides the
 * FILE only, never the shell-safe inline fallback (guidance is authored config text that may carry
 * backticks/`$`). Pure — exported for tests.
 */
export function buildToolkitNote(toolkit: ResolvedToolkit | null | undefined): string | null {
  if (!toolkit) return null;
  const lines: string[] = [];
  if (toolkit.guidance && toolkit.guidance.trim()) lines.push(toolkit.guidance.trim());
  // WS4 — specialist delegation clause. DEFENSE IN DEPTH: the agent slug is authored board data that names
  // a Task `subagent_type`; filter it against SAFE_SLUG so an off-charset slug (`x; rm -rf`) is dropped and
  // NOTHING unsafe reaches the prompt. Names each agent + WHEN to engage + the JSON-fenced output contract
  // (the harness-review lens shape), and instructs delegation via the Task tool. No safe specialist ⇒ no clause
  // ⇒ byte-identical legacy prompt (a step with no specialists is untouched).
  const safe = toolkit.specialists.filter((s) => SAFE_SLUG.test(s.agent));
  if (safe.length) {
    lines.push(
      "Especialistas disponíveis — delegue via Task tool (subagent_type) quando a mudança tocar a área do especialista:",
    );
    for (const s of safe) lines.push(`- ${s.agent}: ${s.when}`);
    lines.push(
      "Cada especialista retorna um bloco ```json``` de findings ({lens, severity, title, detail?, file?, " +
        "line?, suggestion?}); consolide o retorno na sua própria saída.",
    );
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * story-harness-adk A1: a DETERMINISTIC snapshot of the card's canonical checkpoint, inlined into the
 * system-prompt body so the headless run sees its state (status / reentry mode / open questions / task
 * progress) VERBATIM every turn — the ADK "{current_step}/{pending_signals}" interpolation under our
 * card-centric topology. The card.md on disk stays the source of truth for the rich body; this is the
 * GUARANTEED mirror of the checkpoint: it rides the system prompt (re-emitted every turn, so it SURVIVES
 * the compaction that summarizes a long run's first user-turn AND a `--resume`), so the agent never
 * silently operates on phantom state from skipping the card re-read. Normally interpolated into a FILE
 * (--append-system-prompt-file). `shellSafe` is for the legacy INLINE fallback (the `-p "..."` arg under
 * shell:true): it omits the free-form question TEXT (emits only the count), since that text is card
 * content that may carry shell metacharacters. status/mode are AUTHORED fields (coerceCard reads them
 * verbatim, no allow-list) so they too are re-validated against SAFE_SLUG and swapped for a placeholder
 * if off-charset (counts are numeric); the snapshot is then fully shell-safe. Question text
 * is whitespace-collapsed so one entry stays one line. Returns null when there's nothing durable to
 * assert (no status) → composeSystemPrompt omits it (fail-open, byte-for-byte the legacy body). Pure —
 * exported for tests.
 */
export function buildStateSnapshot(card: Card | null, opts?: { shellSafe?: boolean }): string | null {
  const status = card?.status;
  if (!card || !status) return null;
  // G8 (defense-in-depth): status/mode are authored card fields (coerceCard takes them verbatim, no
  // allow-list), so in shell-safe mode (the inline `-p "..."` fallback under shell:true) re-validate them
  // against SAFE_SLUG — mirroring the pkg/board/oppId guards in buildContextNote — and swap an off-charset
  // value for a placeholder so NOTHING authored can reach the shell. A pipeline status/mode is always a
  // kebab-case slug, so this never fires in practice; it makes the guarantee LOCAL instead of resting on
  // the distant invariant that only a valid (slug) status ever enqueues a run.
  const safeStatus = opts?.shellSafe && !SAFE_SLUG.test(status) ? "(status fora de charset — releia o card.md)" : status;
  const safeMode = card.mode && (!opts?.shellSafe || SAFE_SLUG.test(card.mode)) ? card.mode : null;
  // G9: this is an ENQUEUE-TIME mirror, not an immutable oracle — the CLI loads the
  // --append-system-prompt-file ONCE per spawn, so on a long multi-turn run these fields can drift from
  // the card.md a human edited meanwhile (e.g. answering a question in Inbox). Instruct the agent to
  // RECONFIRM the live card before advancing, so it never treats a stale checkpoint as gospel.
  const lines = [
    "Estado deste card no momento do enqueue (espelho do card.md no disco). RECONFIRME status e perguntas no card.md ANTES de avançar — se o card foi editado ou o tempo passou, o disco prevalece sobre este espelho:",
    `- status atual: ${safeStatus}`,
  ];
  // "build" is the ordinary forward flow; only a reentry mode (refine/fix/retire) is worth asserting.
  if (safeMode && safeMode !== "build") lines.push(`- modo de reentrada: ${safeMode}`);
  const open = (card.questions ?? []).filter((q) => q && q.status === "open");
  if (open.length > 0) {
    // G8: the question TEXT is free-form card content (may carry `$`/backticks/quotes). In shell-safe
    // mode (the inline fallback riding the `-p "..."` arg under shell:true) emit ONLY the count and
    // point at the card — never the raw text — so nothing off-charset can reach the shell.
    if (opts?.shellSafe) {
      lines.push(`- ${open.length} pergunta(s) em aberto — releia o card.md para o texto e respeite-as antes de avançar.`);
    } else {
      lines.push(`- ${open.length} pergunta(s) em aberto que você DEVE respeitar antes de avançar:`);
      for (const q of open) {
        const text = (q.text ?? "").replace(/\s+/g, " ").trim();
        lines.push(`  - [${q.id}] ${text}`);
      }
    }
  }
  // G7: surface the ~3 most-recent ANSWERED questions (the human's reply landed) so the run that FOLLOWS a
  // HITL answer ACTS on it — buildStateSnapshot used to emit only OPEN ones, so a reply reached the next
  // agent only as raw card content. Skip STALE auto-resolutions (a terminal card closing an unanswered
  // question with a "(sem resposta…)" marker) and shell-safe mode (the answer text is free-form).
  if (!opts?.shellSafe) {
    const answered = (card.questions ?? [])
      .map((q, idx) => ({ q, idx }))
      .filter(
        ({ q }) =>
          q &&
          q.status === "answered" &&
          !!q.answeredAt &&
          ((q.selectedOptionIds?.length ?? 0) > 0 ||
            (!!q.answer && q.answer.trim().length > 0 && !q.answer.startsWith("(sem resposta"))),
      )
      // answeredAt is date-only (YYYY-MM-DD): same-day replies TIE under localeCompare and slice(3) could
      // then drop the freshest one. Tie-break by ORIGINAL index desc (questions are append-only, so a
      // higher index is the later-created/answered one) → a stable, deterministic top-3.
      .sort((a, b) => (b.q.answeredAt ?? "").localeCompare(a.q.answeredAt ?? "") || b.idx - a.idx)
      .slice(0, 3)
      .map(({ q }) => q);
    if (answered.length > 0) {
      lines.push("- pergunta(s) recém-respondida(s) — aja sobre a resposta:");
      for (const q of answered) {
        const text = (q.text ?? "").replace(/\s+/g, " ").trim();
        const ans =
          (q.answer ?? "").replace(/\s+/g, " ").trim() ||
          (q.selectedOptionIds?.length ? `opções: ${q.selectedOptionIds.join(", ")}` : "");
        lines.push(`  - [${q.id}] ${text} → ${ans}`);
      }
    }
  }
  const tasks = card.tasks ?? [];
  if (tasks.length > 0) {
    const done = tasks.filter((t) => t && t.done === true).length;
    lines.push(`- tasks: ${done}/${tasks.length} concluídas`);
  }
  return lines.join("\n");
}

/**
 * Collapse a run's final assistant text (`RunResult.finalText`) into a single trimmed line, capped to
 * `max` chars with an ellipsis. The durable-provenance surfaces it feeds — the telemetry `summary` and
 * the `Decision:` commit trailer — are both SINGLE-LINE (a git trailer value cannot span lines, a
 * `## Histórico` row is one markdown bullet), so newlines/indent are flattened to one space. Returns
 * null for empty/blank input (so the caller omits the line entirely). Pure — exported for tests. (F4)
 */
export function summarizeFinalText(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/**
 * G5: a coarse human-readable age ("há ~12min" / "há ~3h" / "há ~2d") for a handoff's source run, so the
 * next step can weigh how FRESH the previous step's summary is — a hint from a prior lap (after a
 * refine/fix reentry re-ran the same steps) is weaker evidence than one from minutes ago. Empty string
 * for a non-finite/negative delta (clock skew) → the caller omits the age clause. Pure — exported for tests.
 */
export function formatRunAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ~${min}min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ~${h}h`;
  return `há ~${Math.round(h / 24)}d`;
}

/**
 * Deterministic, traceable commit message for an isolated run's worktree commit (f1). Ties the
 * commit back to the skill, the card it built, and the run session — so a `git log` on main reads
 * which autorun produced each merged change. Pure — exported for tests.
 *
 * F4 (git-durable provenance): when `meta` is supplied, the message carries git TRAILERS — a blank
 * line then `Key: value` lines that `git interpret-trailers` / `git log --grep` parse. `Run-Id:` is
 * always emitted (every run commit is greppable by its session); `Decision:` (the agent's own final
 * word, one line) and `Model:` are emitted only when present. This persists "what the run decided"
 * into git itself, complementing the telemetry `summary` (engine.ts used to discard finalText).
 */
export function buildRunCommitMessage(
  trigger: TriggerId,
  board: string,
  cardId: string,
  sessionId: string,
  meta?: { model?: string | null; effort?: string | null; decision?: string | null },
): string {
  const subject = `usm(${trigger}): ${board}/${cardId} [run ${sessionId}]`;
  const trailers: string[] = [];
  const decision = summarizeFinalText(meta?.decision, 140);
  if (decision) trailers.push(`Decision: ${decision}`);
  const model = meta?.model?.trim();
  if (model) {
    const effort = meta?.effort?.trim();
    trailers.push(`Model: ${effort ? `${model} · ${effort}` : model}`);
  }
  trailers.push(`Run-Id: ${sessionId}`);
  return `${subject}\n\n${trailers.join("\n")}`;
}

/**
 * Commit message for the HEAD=estado boundary commit — the pending board mutations (writeCard, never
 * committed) swept onto `main` before a run's worktree is created. The `board:` prefix keeps these
 * separable from the `usm(...)` code commits in `git log` (a board sync vs. a real code change). Pure
 * — exported for tests.
 */
export function buildBoardCommitMessage(board: string, cardId: string): string {
  return `board: estado vivo antes do run (${board}/${cardId})`;
}

/**
 * Quote a single CLI token for the shell spawn. We must keep shell:true (the Windows
 * `claude.cmd` shim resolves from PATH only through a shell), so any token carrying a
 * shell metacharacter would otherwise corrupt — or KILL — the command. HARDENING 1.3: a
 * token stays bare ONLY when every char is shell-neutral (`[A-Za-z0-9_@%+=:,.\/-]` —
 * identifiers, paths, model ids, `mcp__x__y`, `--flags`); everything else is double-quoted.
 * The driver was the canonical `--allowedTools Tool(specifier)` syntax: its parens, unquoted
 * under `sh -c`, are a SYNTAX ERROR that kills the ENTIRE spawn (not just that flag). Double
 * quotes group on both cmd.exe and /bin/sh; our values have no embedded quotes, and `*` is
 * not in the safe set so `Bash(git:*)` is quoted (also blocking unwanted glob expansion).
 * NOTE: still not a general cross-shell escaper — double quotes don't neutralize `$`/backtick
 * (none of our tokens carry them); the global extraArgs escape hatch must still be shell-safe
 * by construction. Pure — exported for tests.
 */
export function quoteArg(token: string): string {
  return /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(token) ? token : `"${token}"`;
}

/**
 * Assemble the headless `claude` shell command line. `contextNote` (SM-09) is the optional per-app
 * read-this-first instruction appended to the `-p` prompt; omitting it reproduces the legacy command
 * byte-for-byte (retrocompat). Pure — exported for tests.
 */
export function buildClaudeCommand(
  bin: string,
  promptCommand: string,
  key: string,
  flags: string[],
  contextNote?: string | null,
): string {
  return `${bin} -p "${buildPrompt(promptCommand, key, contextNote)}" ${flags.map(quoteArg).join(" ")}`.trim();
}

/**
 * Assemble the headless `claude --resume` shell command (story-watchdog-recuperacao-runs-mortos).
 * The boot watchdog REVIVES a run the crash interrupted instead of starting it fresh: `--resume
 * <sessionId>` rehydrates that session's transcript + checkpoint so the skill continues from where
 * it stopped (AC1/AC2). Two deliberate choices vs. buildClaudeCommand:
 *   - keep `-p "<promptCommand> <key>"`: print mode is STILL required (the stream-json output the live
 *     console parses only works under --print), and re-issuing the SAME `/<skill> board/card` prompt
 *     lets the resumed skill pick up — its own per-task idempotency (skip done:true) prevents redoing
 *     finished work, so the re-issue never duplicates (AC2);
 *   - the caller drops `--session-id` from `flags` (a second session id would contradict --resume).
 * Pure — exported for tests.
 */
export function buildResumeCommand(
  bin: string,
  promptCommand: string,
  key: string,
  sessionId: string,
  flags: string[],
  contextNote?: string | null,
): string {
  return `${bin} -p "${buildPrompt(promptCommand, key, contextNote)}" --resume ${sessionId} ${flags.map(quoteArg).join(" ")}`.trim();
}

/**
 * story-1mxmqy: the claude CLI's signature when `--resume <id>` can't find the session on disk
 * ("No conversation found with session ID: <id>"). A resume only ever fails this way because the
 * session expired or was wiped (a service restart, a session-store cleanup) — NOT because the work
 * is wrong. The engine reads this off the spawn's stderr/stdout to fall back to a FRESH dispatch
 * instead of stranding the card as a failure. Exported for the test.
 */
export const RESUME_SESSION_MISSING_RE = /No conversation found with session ID/i;

/**
 * story-1mxmqy: hard cap on resume→fresh fallbacks per card. Past it the run settles as a real failure
 * for the operator instead of churning fresh sessions forever (the loop the cap exists to prevent).
 * Override via AGILEHARNESS_AUTORUN_RESUME_FALLBACK_MAX (default 2; 0 disables the auto-fallback entirely).
 */
export function resumeFallbackMax(): number {
  const n = Number(process.env.AGILEHARNESS_AUTORUN_RESUME_FALLBACK_MAX);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
}

// Code skills write product code + run the TDD suite → duration is unpredictable,
// so they get NO watchdog by default (a clock would sabotage a legit run). A column
// can opt in via `costGuard`, which falls back to this generous ceiling when the
// global code-skill watchdog (timeouts.doMs) is off. Fast skills only edit .md
// fields, so they always carry the fast watchdog.
const DEFAULT_COST_GUARD_MS = 30 * 60_000;
// Long-running skills → unpredictable duration, no fast watchdog. harness-do/harness-review
// write product code + run tests; harness-refine reads the live codebase to diagnose and
// can generate wireframes (it wraps um gerador de wireframe); harness-fix diagnoses + reproduces a
// regression; harness-sync-card diagnoses the live code to reconcile a card — all can
// outrun the fast clock.
/** Long-running (diagnoses/writes code) → no fast watchdog. CODE_SKILLS é a fonte única em
 * skill-registry.ts (antes duplicada aqui e em scheduler.ts). Pure — exported for tests. */
export function isCodeSkill(trigger: TriggerId): boolean {
  return CODE_SKILLS.has(trigger);
}

/**
 * WS-4.2 — the claim KIND a run of `trigger` holds on its card. The kind set is CLOSED (claims.ts), so the
 * pipeline's spec-authoring skills (enrich/grill/plan/ux/ui/capture/style…) map onto `implement`: they ARE
 * the pipeline's work on that card, and treating them as such is precisely what makes a live session's claim
 * block a light run on the same card — the WS-3.4 residual risk (service↔run-light writing one card) that
 * this claim exists to mitigate. Pure — exported for tests.
 */
export function claimKindFor(trigger: TriggerId): ClaimKind {
  if (trigger === "harness-review") return "review";
  if (trigger === "harness-qa") return "qa";
  // Everything else (harness-do/fix/refine/retire/sync-card + the whole light lane) is the card's own build →
  // `implement`. `triage`/`steward` are deliberately NOT run kinds: they belong to the non-run actors (an
  // MCP triage agent, the Autonomous copiloto acting as steward), which is what lets those coexist with a run.
  return "implement";
}

// SECURITY: board/cardId are interpolated into a shell command (shell:true), so they
// MUST be slugs (the sanitizeId charset). A card .md whose filename carries shell
// metacharacters (`"`, `;`, `$`, backticks) would otherwise inject a command — and an
// agent running with --dangerously-skip-permissions could create such a file. We
// refuse anything off-charset rather than spawn it.
const SLUG = /^[a-z0-9-]+$/i;

/**
 * Wall-clock watchdog (ms) for a run — ALWAYS a number, so no run can hold a concurrency
 * slot forever. Code skills: an explicit global `doMs` wins; else a `costGuard` column keeps
 * the responsive 30-min ceiling; else the generous UNIVERSAL ceiling (timeouts.universalMs,
 * ~60 min) — this last branch is what now covers refine/harness-do-without-costGuard, which used
 * to return null (no watchdog). Fast skills keep their own short fast watchdog. Pure — exported for tests.
 */
export function timeoutFor(trigger: TriggerId, def: StatusDef, cfg: RunnerSettings): number {
  if (isCodeSkill(trigger)) {
    if (cfg.autorun.timeouts.doMs) return cfg.autorun.timeouts.doMs;
    return def.costGuard ? DEFAULT_COST_GUARD_MS : cfg.autorun.timeouts.universalMs;
  }
  return cfg.autorun.timeouts.fastMs;
}

/** Small awaitable delay (killTree polls between SIGTERM and SIGKILL). */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// harness-do/harness-review write product code + run tests, harness-enrich renames the card file
// (rm/mv via Bash) during refinement, and harness-refine/harness-fix + harness-sync-card run
// read-only diagnosis (git/grep via Bash) over the live codebase → all need full
// autonomy headless. harness-ux/harness-interview/harness-ui advance the card via `bun packages/storymap-ui/scripts/advance-card.ts`
// (a Bash command) at the end, so they need Bash without prompts too. harness-tasks/
// harness-prioritize/harness-plan only edit storymap data → acceptEdits. harness-grill only writes
// questions into the card (no Bash advance — human-in-the-loop) → acceptEdits.
/** Needs `--dangerously-skip-permissions` (runs Bash/writes code). FULL_AUTONOMY_SKILLS deriva do
 * AGENTS registry (skill-registry.ts) — antes era um Set próprio em lockstep. É o MESMO fato que
 * `tierOf(trigger) === "full"` (story-l9mac9): dois nomes para uma derivação, nunca duas derivações —
 * quem for adicionar uma terceira, derive daqui. Pure — exported for tests. */
export function needsFullAutonomy(trigger: TriggerId): boolean {
  return FULL_AUTONOMY_SKILLS.has(trigger);
}

// ── TIER → FLAGS: a tradução, num só lugar (story-l9mac9) ────────────────────────────────────────────
// Cada tier de {@link AUTONOMY_TIERS} tem UMA postura de CLI. As duas linhas que o autorun usa hoje
// (`full` e `write`) são BYTE-IDÊNTICAS ao que este arquivo emitia antes de os tiers existirem — nomear o
// nível não muda nenhum spawn, e o teste de tabela em autonomy-tier.test.ts fixa isso trigger por trigger.
// Os valores foram conferidos contra o CLI instalado (2026-07-29: `--permission-mode` aceita acceptEdits,
// plan e default), porque um valor recusado na opção mataria o run no arranque com exit 1 mudo — foi assim
// que o tick do copiloto ficou horas morto.
const TIER_PERMISSION_ARGS: Record<AutonomyTier, string[]> = {
  // `full` continua sendo o topo — o tier que escreve código e roda teste sozinho. O que mudou (F0 do
  // plano multi-target; vereditos em ADR-067) é COMO ele compra isso: era `--dangerously-skip-permissions`
  // (+ `IS_SANDBOX=1` para furar a trava de root do próprio CLI, que não isolava nada); passa a ser
  // `acceptEdits` MAIS um settings de sandbox emitido no spawn — `autoAllowBashIfSandboxed` devolve
  // exatamente o Bash não-interativo que era o único motivo da flag perigosa existir, agora dentro de uma
  // fronteira imposta pelo SO. A diferença entre `full` e `write` deixa de estar nesta tabela e passa a
  // estar na presença do sandbox (runner/autonomy-sandbox.ts) — que é onde a contenção realmente mora.
  // `--strict-mcp-config` NÃO entra aqui: flags.ts:61 já o emite sempre, junto dos mounts declarados.
  full: ["--permission-mode", "acceptEdits"],
  // sem shell/editor nativo — a autoridade passa pelo MCP (a postura do tick do copiloto)
  orch: ["--permission-mode", "default"],
  write: ["--permission-mode", "acceptEdits"],
  ro: ["--permission-mode", "plan"],
};

/**
 * As flags de permissão do spawn. `cap` ausente ⇒ o tier declarado da skill, isto é, o comportamento de
 * hoje. Um teto NUNCA promove (capTier) — um board que declara `full` não dá shell a uma skill que roda em
 * `acceptEdits`. Pura — exportada p/ teste.
 */
export function permissionArgs(trigger: TriggerId, cap?: AutonomyTier | null): string[] {
  return TIER_PERMISSION_ARGS[capTier(tierOf(trigger), cap)];
}

/** As flags de UM tier já resolvido. Existe porque a postura pode REBAIXAR o tier depois do teto de
 *  board (sandbox indisponível ⇒ `write`), e as flags têm de vir do tier REAL do spawn. Uma revisão
 *  mostrou que o rebaixamento era calculado e depois descartado: as flags saíam de `permissionArgs`,
 *  derivado do tier NÃO rebaixado. Hoje isso é inócuo porque `full` e `write` emitem o mesmo array —
 *  mas "inócuo por coincidência de tabela" é uma bomba-relógio, não um desenho. */
export function permissionArgsForTier(tier: AutonomyTier): string[] {
  return TIER_PERMISSION_ARGS[tier];
}

// O teto de tier por BOARD (o "piso" que o adotante ganha sem que o dono perca nada). Duas portas, a mais
// específica vencendo: `AGILEHARNESS_AUTORUN_TIER_CAP_<BOARD>` e o global `AGILEHARNESS_AUTORUN_TIER_CAP`. Board id é slug
// (SLUG abaixo), então a chave é determinística: maiúsculas com `-` → `_`.
const TIER_CAP_ENV = "AGILEHARNESS_AUTORUN_TIER_CAP";
/** Um valor de teto inválido já avisado (uma linha por processo, não por run — senão um typo virava enxurrada). */
const tierCapWarned = new Set<string>();

/**
 * Resolve o teto de tier declarado para `board`. AUSENTE ⇒ null = SEM teto = o comportamento de hoje, e é
 * esse o default de todo board existente: nenhum spawn muda de permissão sem alguém ter declarado.
 *
 * Valor NÃO reconhecido ⇒ null + aviso nomeando os valores válidos. Deliberadamente NÃO fail-closed: o teto
 * contém o raio de um agente JÁ autorizado, então um typo que virasse `ro` transformaria o pipeline inteiro
 * em read-only — uma auto-negação de serviço silenciosa, que é o pior desfecho possível para um sistema cujo
 * mandato é ser autônomo. O que o controle IMPEDE é o teto ser aplicado ERRADO em silêncio; o operador lê no
 * journal que o teto que ele pediu não valeu. Pura sobre `env` — exportada p/ teste.
 */
export function resolveTierCap(env: Record<string, string | undefined>, board?: string): AutonomyTier | null {
  const perBoard = board && SLUG.test(board) ? env[`${TIER_CAP_ENV}_${board.toUpperCase().replace(/-/g, "_")}`] : undefined;
  const raw = (perBoard ?? env[TIER_CAP_ENV] ?? "").trim();
  if (!raw) return null;
  if ((AUTONOMY_TIERS as readonly string[]).includes(raw)) return raw as AutonomyTier;
  if (!tierCapWarned.has(raw)) {
    tierCapWarned.add(raw);
    console.warn(
      `[autorun] teto de tier "${raw}" não é um tier válido (${AUTONOMY_TIERS.join("|")}) — NENHUM teto aplicado; os runs seguem no tier declarado de cada skill.`,
    );
  }
  return null;
}

// ── ISOLAMENTO DE REDE: a DECLARAÇÃO e o ponto de extensão (story-u4qb3f) ─────────────────────────────
// O que existe hoje de isolamento REAL é o sandbox estrutural de FS (`cfg.autorun.sandbox`, default OFF):
// node_modules + bun store remontados read-only num namespace de mount por run. Rede não tem nada — e
// declarar uma allowlist que ninguém aplica, em silêncio, seria pior que não ter knob: o operador acharia
// que está contido. Então a declaração existe, viaja para o filho (é o contrato que um wrapper/proxy do
// adotante consome) e ANUNCIA que não é aplicada. `enforced` é literalmente `false` no tipo: o dia em que
// alguém aplicar de fato, o tipo é o que obriga a mexer aqui.
const EGRESS_ENV = "AGILEHARNESS_AUTORUN_EGRESS_ALLOW";
// Charset de HOSTNAME (+ curinga de subdomínio). Recusar o resto não é purismo: este valor vai para o env
// de um filho que roda com shell, então uma entrada com espaço/quote/barra é lixo que não deve viajar.
const EGRESS_HOST = /^\*?[a-z0-9.-]+$/i;
/** Um pedido de allowlist de egresso. `enforced: false` é o fato, não um placeholder. */
export interface EgressDeclaration {
  allow: string[];
  enforced: false;
}
let egressWarned = false;

/**
 * Lê a allowlist de egresso declarada. AUSENTE/vazia ⇒ null: default DESLIGADO, e o spawn não ganha nem uma
 * chave de env — comportamento de hoje, byte por byte. Entradas fora do charset de hostname são descartadas
 * (não viajam para o env do filho). Pura sobre `env`, tirando o aviso de uma-vez-por-processo — exportada p/ teste.
 */
export function resolveEgressDeclaration(env: Record<string, string | undefined>): EgressDeclaration | null {
  const raw = (env[EGRESS_ENV] ?? "").trim();
  if (!raw) return null;
  const allow = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && EGRESS_HOST.test(s));
  if (allow.length === 0) return null;
  if (!egressWarned) {
    egressWarned = true;
    console.warn(
      `[autorun] allowlist de egresso DECLARADA (${allow.join(", ")}) mas NÃO APLICADA: nada neste processo bloqueia saída de rede. ` +
        `O valor viaja no env AGILEHARNESS_EGRESS_ALLOW para um wrapper/proxy que a aplique — sem ele, considere o run com rede ABERTA.`,
    );
  }
  return { allow, enforced: false };
}

/** Test-only: rearma os avisos de uma-vez-por-processo (teto inválido / egresso declarado). */
export function resetAutonomyWarnings(): void {
  tierCapWarned.clear();
  egressWarned = false;
}

// The CLI refuses `--dangerously-skip-permissions` when it runs as root on a POSIX
// host unless IS_SANDBOX=1 — its own guard is
// `platform!=="win32" && getuid()===0 && IS_SANDBOX!=="1"`, dying with
// "--dangerously-skip-permissions cannot be used with root/sudo privileges". The
// autorun spawns inherit the dev server's env, so on a root box (e.g. a Linux
// container) every full-autonomy run would fail at launch. IS_SANDBOX=1 is the
// documented container/CI bypass; scope it to the spawns that actually carry the
// flag — acceptEdits runs never trip the guard, so they keep the env untouched.
// ⚠ IS_SANDBOX=1 NÃO É UM SANDBOX — e o nome, a 2.000 linhas do sandbox de verdade (`cfg.autorun.sandbox`,
// runner/sandbox.ts), é uma armadilha de auditoria (story-u4qb3f pediu para verificar se o sinal é honrado
// por algo ou se é decorativo). A resposta: ele não isola NADA. É o bypass do guard de root DO PRÓPRIO CLI
// — o único efeito é PERMITIR o `--dangerously-skip-permissions` como root. Ou seja, é o oposto de contenção:
// quem lê `IS_SANDBOX=1` no env do filho e conclui "este run está contido" está lendo ao contrário. O
// isolamento estrutural (namespace de mount, node_modules read-only) é OUTRA coisa, opt-in e default OFF.
// ⬆ O BLOCO ACIMA É HISTÓRIA. `needsSandboxEnv()` e a injeção de `IS_SANDBOX=1` foram DELETADAS em F0
// (plano multi-target; ADR-067). O comentário original já dizia a verdade — aquilo não isolava nada, era
// só o bypass da trava de root do CLI — e a troca correta existe desde 2026: contenção do SO via
// `runner/autonomy-sandbox.ts`, que compra o Bash headless com `autoAllowBashIfSandboxed` em vez de com
// desligamento de checagem. Medido nesta caixa: escrita dentro do worktree passa sem prompt; escrita em
// `/root` é negada pelo FILESYSTEM ("Read-only file system"), não pelo julgamento do modelo.
//
// ⚠ SUPERFÍCIES AINDA NA POSTURA ANTIGA — quatro, contadas por lint e não de cabeça. Esta nota já disse
// "3", depois "5", depois "6" — e revisões sucessivas mostraram que nenhuma das três batia: faltavam
// `copilot/agent-session.ts`, `app/actions.ts`, e depois `mcp/dev-tools.ts` + `copilot/protocol.ts`,
// que emitem a flag SEM o env e por isso escapavam de um lint que casava `IS_SANDBOX`. Lista de dívida
// errada é pior que ausente: ela AFIRMA cobertura.
//
// As listas vivas são DIVIDA_FLAG (o sinal primário — quem emite `--dangerously-skip-permissions`) e
// DIVIDA_ENV (quem injeta `IS_SANDBOX=1`), em autonomy-sandbox.test.ts, cobradas por lint exaustivo
// sobre TODO o `src/` (não só `runner/`, que era outro furo). O número aqui é amarrado por teste ao
// número do README, derivado da lista — para esta frase não poder divergir de novo em silêncio.
// Migrá-las no mesmo commit que o autorun trocaria um risco medido por um apagão; entram em F1, com
// prioridade para `mcp/dev-tools.ts` (a tool `run_task`), a única alcançável pelo endpoint MCP externo.

// C1 (PATH com node_modules/.bin) + incidente __NEXT_PROCESSED_ENV (2026-07-09): a sanitização de env
// de filho vive em spawn-env.ts — compartilhada com o launcher de deploy (product-deploy.ts), que sofre
// da MESMA herança de env vivo do next-server. Re-export mantém os importadores/testes existentes.
export { sanitizeSpawnPath } from "./spawn-env";

/** Outcome of asking the engine to run a card's skill. */
export type RunAttempt =
  | { ok: true }
  | { ok: false; reason: "in-flight" | "bad-id" | "cooldown" | "rate-limited"; detail: string };

/**
 * Emitted to onComplete subscribers when a run SETTLES (any outcome). The trigger-
 * runner channel listens to CONTINUE the autorun cascade: when a skill advances its
 * card into the next autorun column, the watcher's card.moved fires WHILE this run
 * still holds the per-card in-flight lock — so that spawn is rejected and the event is
 * lost. Re-evaluating the cascade on completion picks the advanced card up reliably
 * (the skill-advance path the watcher alone can't deliver). `trigger` lets the listener
 * suppress re-firing the SAME skill when the card did NOT advance (no retry loop).
 */
export interface RunCompletion {
  board: string;
  cardId: string;
  trigger: TriggerId;
  outcome: RunOutcome;
  /** story-harness-cc #4: the structured tail of the run (the agent's final message + stop subtype +
   * cost/turns), captured from the terminal stream-json `result` event. Absent when the run died before
   * any result (kill/OOM/timeout) or on the deferred merge-back path. Additive/diagnostic — the cascade
   * still decides from the card on disk; this lets a listener/telemetry surface WHY a run stopped. */
  result?: RunResult;
  /** WS3 (F2) — the capability toolGap (expected-but-unused toolConfig ids). DEFINED (possibly `[]`) on
   *  the SUCCESS emits so the capability audit can act without re-reading telemetry: a non-empty array
   *  STAMPS the SOFT `tooling-unused` finding, an EMPTY array CLEARS a prior one (the step used the tool
   *  this time). UNDEFINED on the cancel/error emits (not a success → the audit ignores it). Note: an
   *  ISOLATED code run that ENQUEUES suppresses this emit (cascade fires from onMergeDone), so its finding
   *  doesn't stamp — but the durable signal still lands in the run's telemetry `toolGap` either way. */
  toolGap?: string[];
}

/**
 * Where a card sits in the admission pipeline right now (story-mcp-enfileiramento-lote-dependencias).
 * Returned by {@link RunnerEngine.getQueueInfo} and folded into the MCP `enqueue` response.
 */
export interface QueueInfo {
  status: "running" | "queued" | "idle";
  lane: RunLane | null;
  /** 0-indexed slot in the lane queue (null = running/idle). */
  position: number | null;
  /** conservative epoch-ms estimate of when the run starts (null = idle). */
  estimatedStart: number | null;
}

// Conservative per-lane average run durations used only to estimate a queued card's start time.
// Light skills are .md-only + short; heavy skills write code + run the TDD suite. Intentionally
// rough — the orchestrator tracks real progress via runner_status (see getQueueInfo's note).
const AVG_LIGHT_RUN_MS = 3 * 60_000;
const AVG_HEAVY_RUN_MS = 12 * 60_000;

/**
 * Anti-replay window for AUTORUN spawns. fs.watch double-fires on Windows and a skill
 * that renames its card re-emits card.created — both can re-trigger the SAME skill on
 * the SAME card right after a run. The in-flight lock covers the run itself; this guards
 * the moments just before/after it. Manual "Rodar agora" passes no window (deliberate).
 */
export const AUTORUN_DEDUPE_MS = 30_000;

/** How long before a pump that left work STRANDED tries again. See {@link pumpRetryNeeded}. */
export const PUMP_RETRY_MS = 30_000;

/** The timer handle the stranded-work retry keeps. `unref` so it can never hold the process open. */
export interface PumpTimer {
  unref?: () => void;
}
/** DI seam for the retry timer (a fake in tests — the pump must be assertable without a real 30s wait). */
export type PumpTimerFn = (fn: () => void, ms: number) => PumpTimer;

/**
 * Is this pump leaving work STRANDED — queued with nobody left to wake it?
 *
 * The pump is EDGE-triggered (a run settles, or a job enqueues) but the heavy lane's gate is
 * LEVEL-based (VPS RAM/load). A level that clears on its own emits no edge, so a heavy run deferred by
 * a transient load spike waits for a wake-up that may never come. It is not a rare corner: the spike is
 * usually the merge train's own gate (it runs the full suite), and the run deferred by it is typically
 * the LAST one — so the board goes idle and there is no future settle to re-pump. That stranded
 * `acme/story-novo-item`'s conflict-redrive for 5h+ (journal `running`, `pid: null`, never spawned),
 * and — because a queued run keeps `isInFlight` true — it also starved the recovery sweep that exists
 * to rescue exactly this: the orphan blocked its own rescuer.
 *
 * TRUE only when NOTHING is running: with a run in flight, its settle IS the edge, so a timer would be
 * redundant (and a busy-loop while the box is legitimately saturated). The light lane can't strand — it
 * has no level gate — so heavy queued + zero running is the whole condition. PURE.
 */
export function pumpRetryNeeded(running: number, heavyQueued: number): boolean {
  return running === 0 && heavyQueued > 0;
}

/**
 * WS-8.1 — how long the "recently cancelled" phase-brake holds a card's autorun cascade after an operator
 * cancel. Long enough to absorb the synchronous re-fire storm (the cancelled run's own settle→cascade + the
 * fs-watch of its advance write, both within ~1s) AND a DELAYED cascade (a merge-back onMergeDone seconds
 * later). Short enough that a forgotten brake never freezes a card for long — and the brake is cleared early
 * on any explicit human resume (move / retry / enqueue), so this ceiling only bites when nobody acts.
 */
export const RECENTLY_CANCELLED_TTL_MS = 60_000;

// Circuit breaker for AUTORUN spawns — a rolling cap on how many runs may START per
// window, across cards. maxConcurrent throttles simultaneity but not the TOTAL, so a
// loop bug or a column toggled on over a big backlog could fan out dozens of opus/max
// runs. The default ceiling is high enough never to bite normal use (a single card's
// cascade is ~6 runs); blowing past it logs + refuses, a deliberate sangria stop.
// Env-tunable (operational knob, like AGILEHARNESS_AUTORUN=0) — NOT in the settings panel, so a
// panel save can't silently drop it. Manual runs are exempt (they pass no window).
const AUTORUN_RATE_MAX_DEFAULT = 30;
const AUTORUN_RATE_WINDOW_MS_DEFAULT = 10 * 60_000;

function autorunRateLimit(): { max: number; windowMs: number } {
  const max = Number(process.env.AGILEHARNESS_AUTORUN_RATE_MAX);
  const win = Number(process.env.AGILEHARNESS_AUTORUN_RATE_WINDOW_MS);
  return {
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : AUTORUN_RATE_MAX_DEFAULT,
    windowMs: Number.isFinite(win) && win > 0 ? Math.floor(win) : AUTORUN_RATE_WINDOW_MS_DEFAULT,
  };
}

/**
 * Reads a card's CURRENT status id from disk (null if absent/unreadable). Injected into
 * the engine (DI, like `spawn`/`journal`) so the falha-fantasma guard — "did the card
 * advance during the run?" — is unit-testable without touching the filesystem.
 *
 * `cwd` (storymap-critical-audit 2026-06): when given, read the card .md from THAT tree instead
 * of main. An isolated run advances its card INSIDE its worktree, so the post-run "after" read
 * MUST look at `worktreePath` — reading main (where the advance only lands at the merge-back)
 * mis-classified a worktree-local advance as "no advance" → a non-clean exit then force-deleted the
 * branch carrying both the code AND the advance. The "before" read stays on main (at enqueue the
 * card still sits in its trigger column there). Omitting `cwd` is the pre-fix behaviour (main).
 */
export type CardStatusReader = (board: string, cardId: string, cwd?: string) => Promise<string | null>;

/** WS2 — SYNC read of a card's frontmatter status from a tree root (the run's worktree, or main). Used at
 *  settle time to capture the run's content advance BEFORE the worktree teardown removes the dir (an async
 *  read would race the removal). Tolerant: absent/garbage → null.
 *
 *  EXPORTADO só para o teste poder provar o teto de bytes SOZINHO. Este sítio é alcançado no fim de cada
 *  run e a árvore que ele lê é a do PRÓPRIO run — não há como exercitá-lo por fora sem montar um run
 *  inteiro, e um controle que só é testado através de outra camada é um controle que ninguém sabe se
 *  ainda funciona (foi assim que o furo do BOM no chokepoint chegou a existir sem teste vermelho). */
export function readCardStatusFromTreeSync(root: string, board: string, cardId: string): string | null {
  try {
    const file = path.join(root, "storymap", "boards", sanitizeId(board), "cards", `${sanitizeId(cardId)}.md`);
    // O que este controle IMPEDE: que um card gigante plantado DENTRO da worktree do run entre inteiro na
    // memória do serviço. O teto do chokepoint mede a string já materializada — recusar depois do
    // `readFileSync` é recusar depois do dano.
    //
    // O ALCANCE EXATO, porque a versão anterior deste comentário prometia mais do que o controle dá:
    // stat-antes-do-read é um PRÉ-FILTRO, não uma garantia. Entre o `stat` e o `readFileSync` a árvore é
    // a worktree do run, escrita CONCORRENTEMENTE pelo agente — quem troque o arquivo por um gigante
    // nessa janela ainda faz o serviço materializar os bytes. O que continua valendo nesse caso é o teto
    // do PARSE (`parseFrontmatter` mede a string), então o documento hostil nunca é parseado; o custo
    // residual é uma materialização. Fechar a janela de verdade exigiria leitura LIMITADA (abrir, medir o
    // handle e ler no máximo teto+1 bytes), o que muda a API de leitura destes dois sítios — trocado
    // aqui por um comentário honesto em vez de uma promessa que o código não cumpre.
    //
    // Arquivo ausente é ROTINA aqui (a árvore do run pode não ter o card): `statSync` lança ENOENT e cai
    // no mesmo catch abaixo, onde `isMissingFileError` o silencia — o desfecho `null` de hoje, intacto.
    assertStatWithinByteCap(statSync(file).size, `${board}/${cardId}.md`);
    const status = (parseFrontmatter(readFileSync(file, "utf8"), `${board}/${cardId}.md`).data as { status?: unknown })
      .status;
    return status != null ? String(status) : null;
  } catch (err) {
    // Tolerante como antes (null → "não avançou"), mas a RECUSA aparece: um card de worktree que o
    // chokepoint barrou é sinal de conteúdo hostil vindo de dentro do run, não de arquivo ausente.
    if (!isMissingFileError(err)) {
      console.warn(`[harness-autorun] frontmatter recusado em ${board}/${cardId}:`, describeFrontmatterError(err));
    }
    return null;
  }
}

/** ENOENT/ENOTDIR — o .md simplesmente não está naquela árvore (rotina), não é recusa de conteúdo. */
function isMissingFileError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * O tamanho do arquivo para alimentar o teto de bytes — ou `undefined` SÓ quando ele não existe.
 *
 * O que esta função IMPEDE: que um `stat` que falhou por qualquer motivo que NÃO é ausência (EACCES,
 * EIO, ELOOP, EPERM num mount plantado dentro da worktree do run) vire "sem sinal de tamanho" e, com
 * isso, um teto que não mede nada. `assertStatWithinByteCap` ignora `size` indefinido DE PROPÓSITO —
 * falta de sinal não pode recusar trabalho legítimo —, então engolir todo erro de stat num
 * `.catch(() => null)` convertia o guard em no-op para quem conseguisse fazer o stat falhar: o
 * caminho de leitura seguia adiante e materializava os bytes. Ausência é a ÚNICA desculpa (é rotina:
 * a árvore do run pode não ter o card); qualquer outra falha PROPAGA e o chamador recusa a leitura.
 */
async function statSizeOrMissing(file: string): Promise<number | undefined> {
  try {
    return (await fsp.stat(file)).size;
  } catch (err) {
    if (isMissingFileError(err)) return undefined;
    throw err;
  }
}

/** O leitor de status PADRÃO (o que roda em produção quando nada é injetado). EXPORTADO pelo mesmo
 *  motivo do `readCardStatusFromTreeSync`: é aqui que vive o gêmeo assíncrono do teto de bytes, e um
 *  controle sem teste próprio é um controle que ninguém sabe se ainda funciona. */
export const defaultReadCardStatus: CardStatusReader = async (board, cardId, cwd) => {
  try {
    if (cwd) {
      // Read the card .md straight from the run's worktree tree — main is unchanged until the
      // merge-back, so this is the only place a worktree-local advance is visible. Parse just the
      // frontmatter `status` (same field coerceCard reads), tolerant to absent/garbage.
      const file = path.join(cwd, "storymap", "boards", sanitizeId(board), "cards", `${sanitizeId(cardId)}.md`);
      // Gêmeo ASSÍNCRONO do teto de `readCardStatusFromTreeSync`: mesma árvore de run, mesma classe de
      // conteúdo, mesmo remédio. Fechar só o sítio sync deixaria o mesmo card gigante entrar por aqui —
      // meia-correção é o que faz o comentário do chokepoint mentir. Arquivo AUSENTE segue rotina
      // (`statSizeOrMissing` devolve `undefined` e o `readFile` lança o mesmo ENOENT de sempre); erro de
      // stat de qualquer outra natureza recusa a leitura em vez de virar um teto cego.
      assertStatWithinByteCap(await statSizeOrMissing(file), `${board}/${cardId}.md`);
      const raw = await fsp.readFile(file, "utf8");
      const status = (parseFrontmatter(raw, `${board}/${cardId}.md`).data as { status?: unknown }).status;
      return status != null ? String(status) : null;
    }
    return (await readCards(board)).find((c) => c.id === cardId)?.status ?? null;
  } catch (err) {
    if (!isMissingFileError(err)) {
      console.warn(`[harness-autorun] frontmatter recusado em ${board}/${cardId}:`, describeFrontmatterError(err));
    }
    return null;
  }
};

/**
 * Reads a board's config (null if absent/unreadable). Injected (DI) so the conflict-redrive handler —
 * which must resolve the StatusDef of the column that owns the conflicting branch's `trigger` (its
 * model/effort/maxTurns policy) before re-running the skill — is unit-testable without the filesystem.
 */
export type BoardConfigReader = (board: string) => Promise<BoardConfig | null>;

const defaultReadBoardConfig: BoardConfigReader = (board) => readBoardConfig(board).catch(() => null);

/**
 * Reads a card's FULL record from disk (null if absent/unreadable). Injected (DI, like
 * {@link CardStatusReader}) so the complexity-aware spawn-flag resolution
 * (story-rotear-model-effort-por-complexidade) — which derives (model, effort) from the card's
 * storyType/rice/tasks — is unit-testable without the filesystem. Fail-open to null: a read error
 * leaves the spawn on the column policy ({@link resolveColumnArgs}), identical to the pre-routing engine.
 */
export type CardReader = (board: string, cardId: string) => Promise<Card | null>;

/**
 * Mutates a card and persists it, returning the written card (null when it could not be written — a missing
 * card, or a mutation that declined). The engine's two settle-time STAMPS go through this: the C2/WS-5.2
 * build-evidence proof and the merge-back failure finding.
 *
 * Injected (DI, like {@link CardReader}) for a reason the other ports don't share: the real writer resolves
 * the board dir off `findRepoRoot()` with NO env override, so a unit test could only exercise a stamp by
 * writing into the REAL board data of the checkout it runs in. That is what left the C2 guard's stamp
 * untested (its `landed` branch RETURNS NULL when the write fails, so on a fixture-less card it is
 * indistinguishable from "not landed"). Prod gets {@link updateCardOnDisk}, unchanged.
 */
export type CardUpdater = (
  board: string,
  cardId: string,
  mutate: (card: Card) => Card | null,
) => Promise<Card | null>;

const defaultReadCard: CardReader = async (board, cardId) => {
  try {
    return (await readCards(board)).find((c) => c.id === cardId) ?? null;
  } catch {
    return null;
  }
};

/**
 * Reads a board's FULL card pool ([] if unreadable). Injected (DI, like {@link CardReader}) so the run's
 * contextNote can resolve the idea a story `addresses` — getAddressedIdea needs the whole
 * pool, not just the one card — WITHOUT coupling the spawn flow to the filesystem in unit tests. Fail-open
 * to []: a read error simply omits the idea clause (byte-identical to the legacy note), never throws.
 */
export type BoardCardsReader = (board: string) => Promise<Card[]>;

const defaultReadBoardCards: BoardCardsReader = async (board) => {
  try {
    return await readCards(board);
  } catch {
    return [];
  }
};

// ── WS-5.3 zero-token PRE-CHECK ──────────────────────────────────────────────────────────────────────
// Before spawning a `claude -p` for (card, trigger), run cheap in-process checks; if one CONCLUSIVELY finds
// "nothing to do", settle the run as a $0 no-op WITHOUT a process. The rule is CONSERVATIVE by construction:
// a false negative costs one run (= status quo), a false positive stalls a card (unacceptable) — so ANY
// doubt returns { noop: false } (spawn normally). The engine gathers the facts (telemetry / card mtime /
// proposal sidecar); this decision is a PURE function so the three cases are unit-testable in isolation.

/** WS-5.3 — the facts the pre-check reasons over (gathered by the engine, so the decision stays pure). */
export interface PrecheckInput {
  trigger: TriggerId;
  origin: "autorun" | "manual" | "conflict-redrive";
  /** the MOST-RECENT settled run of THIS (card, trigger) — from telemetry — or null when the card has none.
   *  `summary` carries the settle's one-liner: Case 1 reads it ONLY to exclude a {@link CLAIM_REFUSED_MARKER}
   *  no-op (a run that never happened is not evidence that there is nothing to do). */
  lastRunOfTrigger?: { status: RunOutcome; startedAt: number; advanced?: boolean; summary?: string | null } | null;
  /** the card .md file mtime (epoch ms), or null when unreadable. Case 1's "did the card change" signal. */
  cardMtimeMs?: number | null;
  /** the card's tasks (case 2 — harness-do/harness-fix). */
  tasks?: { done: boolean }[];
  /** whether the card carries an OPEN blocker finding (case 2 guard — an open blocker means work remains). */
  hasOpenBlocker?: boolean;
  /** case 3 (harness-capture) — the input hash STAMPED on the proposal sidecar (null when unstamped/absent). */
  proposalInputHash?: string | null;
  /** case 3 — the CURRENT input hash (container body + feedback[]); compared to the stamp. */
  currentInputHash?: string | null;
}

export interface PrecheckResult {
  noop: boolean;
  /** operator-facing one-liner (why it was a no-op) — only present when `noop`. */
  reason?: string;
}

/**
 * WS-4.2 — the stable marker stamped on the telemetry summary of a run that never spawned because a claim
 * held the card. It exists so Case 1 below can tell that $0 settle apart from a REAL no-op.
 *
 * WHY THIS MATTERS (the deadlock it prevents): a claim refusal settles as a `no-op` (so the card surfaces
 * honestly on Inbox), and the run never touched the .md — so `mtime <= startedAt` holds forever. Without
 * this marker, Case 1 ("nothing changed since the last no-op") would fire on EVERY later eval and the card
 * would stay wedged LONG AFTER the reservation was released — a claim would have become a permanent lock,
 * the precise failure mode claims.ts is written to prevent (WS-4 AC2: an expired claim ⇒ the next eval spawns
 * normally, no deadlock by orphaned reservation).
 */
export const CLAIM_REFUSED_MARKER = "claim-refused";

/**
 * The stable marker stamped on the telemetry summary of a run that never spawned because the CAPABILITY
 * PREFLIGHT could not prove a required capability on this host.
 *
 * It exists for exactly the reason {@link CLAIM_REFUSED_MARKER} does, and the trap is the same one: this
 * settles as a `no-op`, and the run never touched the .md, so `mtime <= startedAt` would hold forever.
 * Without excluding it from Case 1, fixing the HOST (installing the browser) would leave the card wedged
 * anyway — the environment defect would have become a permanent card lock, which is the precise failure
 * this whole feature exists to abolish. The card's own file cannot change to prove a host got fixed.
 */
export const CAPABILITY_BLOCKED_MARKER = "capability-unavailable";

/**
 * WS-5.3 — the pure pre-check decision. Returns `{ noop: true, reason }` ONLY on strong evidence that a spawn
 * would do nothing; anything uncertain → `{ noop: false }` (spawn). Exported for tests.
 */
export function precheckNoop(input: PrecheckInput): PrecheckResult {
  const { trigger, origin } = input;
  // A conflict-redrive exists to RE-INTEGRATE a preserved branch (never a no-op) — never pre-check it.
  if (origin === "conflict-redrive") return { noop: false };

  // Case 3 — harness-capture idempotency: the proposal sidecar already reflects the CURRENT input (container
  // body + feedback[]). Fires only when the skill STAMPED an input hash on the proposal AND it matches the
  // current input — a retry with a fresh, unchanged proposal is $0 (the incident's $0.47 no-op). No stamp
  // ⇒ inert (spawn), so it can never false-positive before the skill starts stamping.
  if (trigger === "harness-capture") {
    if (input.proposalInputHash != null && input.currentInputHash != null && input.proposalInputHash === input.currentInputHash) {
      return { noop: true, reason: "harness-capture: a proposta já reflete a entrada atual (body + feedback inalterados)" };
    }
    return { noop: false };
  }

  // Case 2 — code build already delivered: harness-do/harness-fix on a card whose tasks are ALL done AND a prior run
  // of this trigger ADVANCED the card (the build integrated), with NO open blocker remaining. This is the
  // eqpdtz $0.99/19-turn no-op: the prior run committed the work, so re-driving from zero finds nothing.
  // The open-blocker guard excludes a card reopened WITH a blocker (merge-back-failure/revert), where a re-run
  // IS needed — so a stalled card is never falsely no-oped.
  if (trigger === "harness-do" || trigger === "harness-fix") {
    const tasks = input.tasks ?? [];
    const allDone = tasks.length > 0 && tasks.every((t) => t.done === true);
    const priorAdvanced = input.lastRunOfTrigger?.advanced === true;
    if (allDone && priorAdvanced && !input.hasOpenBlocker) {
      return { noop: true, reason: `${trigger}: build já concluído (todas as tasks done + um run anterior entregou)` };
    }
  }

  // Case 1 — pure idempotency: the last run of THIS (card, trigger) was a `no-op` AND the card .md has not
  // changed since that run STARTED (mtime ≤ startedAt ⇒ nothing new to process). A false positive is
  // impossible (a real new edit bumps mtime > startedAt); a false negative (the no-op rewrote the .md) just
  // costs one spawn. This is the "no-op is terminal until the card changes" rule (WS-5.2), enforced cheaply.
  const last = input.lastRunOfTrigger;
  // WS-4.2 — a CLAIM-REFUSED settle is excluded: that run never ran, so it proves nothing about there being
  // work to do; it only proves the card was busy at the time. Treating it as a real no-op would wedge the card
  // permanently (the .md can't change if nobody ever runs) — see {@link CLAIM_REFUSED_MARKER}.
  // Same exclusion, same reason, for the CAPABILITY preflight: that settle proves the HOST lacked
  // something, never that the card has nothing to do. Treating it as a real no-op would mean the card
  // could not be re-dispatched after the operator fixed the host (its .md never changed).
  const summary = last?.summary ?? "";
  const wasClaimRefusal = summary.includes(CLAIM_REFUSED_MARKER) || summary.includes(CAPABILITY_BLOCKED_MARKER);
  if (last?.status === "no-op" && !wasClaimRefusal && input.cardMtimeMs != null && input.cardMtimeMs <= last.startedAt) {
    return { noop: true, reason: `${trigger}: nada mudou desde o último no-op (card .md inalterado)` };
  }

  return { noop: false };
}

/** WS-5.3 (case 3) — the deterministic input hash of a capture container: its source body + the refine
 *  feedback[] (oldest-first). NUL-joined so no field-boundary collision is possible. Exported for tests. */
export function captureInputHash(body: string, feedback: string[]): string {
  return createHash("sha256").update([body, ...feedback].join("\u0000")).digest("hex");
}

/**
 * WS-5.3 (case 3) — read the RAW capture proposal sidecar JSON, deliberately NOT through coerceProposalDoc:
 * the coercer's whitelist drops any `inputHash` the harness-capture skill stamps, so the pre-check must read the
 * raw file. Returns the parsed object (or null when absent/unreadable/not-JSON). Inert — safe on every board.
 */
async function readRawProposalSidecar(board: string, cardId: string): Promise<{ inputHash?: unknown; feedback?: unknown } | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(proposalPath(board, cardId), "utf8"));
    return raw && typeof raw === "object" ? (raw as { inputHash?: unknown; feedback?: unknown }) : null;
  } catch {
    return null; // no sidecar / unreadable / malformed → the pre-check simply can't conclude (spawn)
  }
}

export class RunnerEngine {
  private registry = getRunnerRegistry();
  private repoRoot = findRepoRoot();
  private inFlight = new Set<string>(); // `${board}/${id}` with a skill running/queued
  private lastSpawnAt = new Map<string, number>(); // `${board}/${id}:${trigger}` → epoch ms (anti-replay)
  private autorunSpawnTimes: number[] = []; // epoch ms of recent autorun spawns (rate-limit window)
  // Two admission lanes (story-scheduler-lanes-recursos): light skills (.md-only) and heavy ones
  // (code/diagnose/browser) queue separately so a heavy backlog never starves the cheap light runs.
  private lightQueue: Array<() => Promise<void>> = [];
  private heavyQueue: Array<() => Promise<void>> = [];
  // story-mcp-enfileiramento-lote-dependencias: the `${board}/${id}` of each QUEUED job, kept
  // strictly parallel to lightQueue/heavyQueue (pushed in runSkill, shifted in pump in lockstep)
  // so getQueueInfo can report a card's lane + 0-indexed position without changing the closures.
  private lightQueueKeys: string[] = [];
  private heavyQueueKeys: string[] = [];
  private running = 0; // total in-flight across BOTH lanes (drives the global maxConcurrent ceiling)
  private runningHeavy = 0; // subset of `running` in the heavy lane (light = running - runningHeavy)
  private completionListeners = new Set<(ev: RunCompletion) => void>();
  // story-harness-adk G4b: subscribers woken when the engine goes IDLE (the in-flight set drained after a
  // settle) — the recovery sweep then runs event-driven instead of only on the periodic poll.
  private idleListeners = new Set<() => void>();
  private children = new Map<string, ChildProcess>(); // `${board}/${id}` → live child (forceRelease)
  private cancelled = new Set<string>(); // keys force-released while still QUEUED (no child yet)
  // story-#30: keys whose EXECUTING run we deliberately killed (cancel/timeout). The close handler
  // checks this so a SIGKILL escalation (exit 137) is NOT mislabeled as an OOM kill — our kill, not
  // the kernel's cgroup OOM. Cleared in settle()'s finally.
  private forceKilled = new Set<string>();
  // story-vbkazs: keys whose EXECUTING run was DELIBERATELY cancelled by the operator (forceRelease /
  // cancel_run). Distinct from forceKilled (which only guards the OOM-mislabel of a SIGKILL/137): this
  // marks the kill as a deliberate cancel so finish() records the NON-failure outcome "cancelled"
  // instead of "exit". A watchdog TIMEOUT kill never enters this set (it sets `timedOut` only) → stays
  // "timeout"; an OOM 137 enters neither set → stays "oom-killed". Cleared in settle()'s finally.
  private cancelledKills = new Set<string>();
  // story-1mxmqy: per-card tally of resume→fresh fallbacks (a `claude --resume` whose session is gone
  // is re-dispatched FRESH instead of failing). Capped by resumeFallbackMax() so a session store that
  // keeps losing sessions can't churn fresh dispatches forever — past the cap the run settles as a real
  // failure for the operator. Reset to 0 on any successful settle of the card (fresh budget next time).
  private resumeFallbackCount = new Map<string, number>(); // `${board}/${id}` → fallbacks used
  // WS-8.1: the "recently cancelled" phase-brake. When the operator cancels a run (forceRelease), we
  // stamp `${board}/${id}` → { at, status } (the card's status AT the cancel, read after the kill). The
  // autorun re-eval (evaluateAutorunOnEntry — both the run-completion threading path and the fs-watch
  // path) consults this BEFORE spawning/threading: while alive it does NOT spawn — a cancel means "stop
  // THIS card", and the run's own settle→cascade + the fs-watch of its status-advance write would
  // otherwise re-engage the next threaded step 0,4s later (the story-f6rr4p whack-a-mole). In-memory ONLY
  // (a restart in the window loses the brake — acceptable, recovery re-enqueues with its own decision).
  // PER CARD (never per trigger). Cleared by: TTL, a status change away from the captured status (a human
  // moved the card = explicit resume intent), or an explicit manual/redrive re-run (runSkill).
  private recentlyCancelled = new Map<string, { at: number; status: string | null }>();
  /** The live stranded-work retry (see {@link armPumpRetry}); null = nothing waiting. */
  private pumpRetryTimer: PumpTimer | null = null;

  /**
   * Subscribe to run completions (any outcome). Returns an unsubscribe fn. Used by the
   * trigger-runner channel to continue the cascade once a run releases its in-flight
   * lock — see {@link RunCompletion}. Fired AFTER the lock is released and the queue
   * pumped, so a listener may safely (re-)enqueue the next skill for the same card.
   */
  onComplete(fn: (ev: RunCompletion) => void): () => void {
    this.completionListeners.add(fn);
    return () => this.completionListeners.delete(fn);
  }

  /**
   * story-harness-adk G4b: subscribe to the engine going IDLE — fired from emitComplete right after a
   * NON-DEFERRED run settles and drains the in-flight set (no run executing or queued). Lets the recovery
   * sweep run event-driven (an orphaned resumable run is picked up the moment the queue drains) instead of
   * only on the periodic poll. NOTE the deferred caveat: a code-skill run enqueued on the merge train
   * SUPPRESSES its emitComplete (the cascade fires later from onMergeDone), so it does NOT wake onIdle —
   * the periodic poll is the backstop that still picks up an orphan after such a settle. A firing is also
   * idle-gated downstream (merge train + engine), so waking while the train is busy is a safe no-op.
   * Returns an unsubscribe fn.
   */
  onIdle(fn: () => void): () => void {
    this.idleListeners.add(fn);
    return () => this.idleListeners.delete(fn);
  }

  private emitComplete(ev: RunCompletion): void {
    for (const fn of this.completionListeners) {
      try {
        fn(ev);
      } catch (err) {
        console.error("[harness-autorun] completion listener threw", err instanceof Error ? err.message : err);
      }
    }
    // G4b: this completion may have drained the in-flight set — if so the engine is now idle, so wake the
    // idle subscribers (the recovery sweep). Checked AFTER the completion listeners, which the onComplete
    // contract guarantees run post-release, so hasInFlight() reflects the true post-settle state.
    if (this.idleListeners.size > 0 && !this.hasInFlight()) {
      for (const fn of this.idleListeners) {
        try {
          fn();
        } catch (err) {
          console.error("[harness-autorun] idle listener threw", err instanceof Error ? err.message : err);
        }
      }
    }
  }

  /**
   * True when at least one run is executing OR queued (the in-flight lock set is non-empty).
   * story-harness-cc HALF #6: the periodic recovery sweep skips a tick while work is in flight, so it
   * never fights the merge train nor runs reconcileWorktrees (a git subprocess) needlessly. Reads the
   * SAME lock the admission pipeline maintains — no new state.
   */
  hasInFlight(): boolean {
    return this.inFlight.size > 0;
  }

  // `spawn` is injectable so the concurrency cap / in-flight lock / SLUG-security
  // logic is unit-testable without launching real `claude` processes. DI is used
  // instead of vi.mock because module mocking is unavailable on the Bun runtime
  // (see testing-philosophy.md). Production always gets the real node:child_process spawn.
  constructor(
    private spawnProcess: typeof spawn = spawn,
    private journal: RunnerJournalPort = getRunnerJournal(),
    private readCardStatus: CardStatusReader = defaultReadCardStatus,
    private worktreeOps: WorktreeOps = defaultWorktreeOps,
    // SM-2 merge train: on a successful isolated run, the branch is handed to this queue
    // (instead of being torn down) so it integrates serially into main. Injected (DI) so the
    // engine is testable without a real queue; null disables the hand-off (plain teardown).
    private mergeQueue: MergeQueuePort | null = getMergeQueue(),
    // story-ms5rmt: the per-cwd commit mutex shared with the merge queue. Both board-commit
    // boundaries (this engine's start + the merge train's merge-back) route through ONE primitive
    // keyed by cwd, so concurrent commits on the SAME main tree serialize (no .git/index.lock race)
    // while commits on distinct worktrees stay parallel. DI (a fake in tests); prod gets the shared
    // process-global serialCommit so both boundaries enqueue onto the SAME chain.
    private commitSerializer: CommitSerializer = serialCommit,
    // story-scheduler-lanes-recursos: samples free RAM + 1-min load before admitting a HEAVY run.
    // DI (a fake in tests) so the lane/threshold admission is deterministic without touching /proc;
    // prod gets the real probe (reads /proc/meminfo + os.loadavg, fail-open to never-block).
    private probeResources: () => VpsResources = probeVpsResources,
    // SM-4 governor: is `systemd-run` available to wrap a run in a resource scope? DI (a fake in
    // tests) so OOM/scope behavior is deterministic without a real systemd; prod gets the cached
    // real probe (`which systemd-run`, fail-open to "unavailable" → graceful degradation).
    private systemdCheck: SystemdCheck = () => detectSystemd(),
    // story-92ldyt: reads a board's config so the conflict-redrive handler can resolve the StatusDef
    // (column policy) of the trigger that produced the conflicting branch. DI (a fake in tests); prod
    // reads the real board.yaml. Defaults fail-open to null (the re-drive is skipped → legacy pause).
    private readBoardConfig: BoardConfigReader = defaultReadBoardConfig,
    // story-rotear-model-effort-por-complexidade: reads the FULL card at enqueue so the spawn flags are
    // routed by complexity (storyType/rice/tasks) within the column ceiling. DI (a fake in tests); prod
    // reads the real card. Fail-open to null → the spawn degrades to the column policy (resolveColumnArgs).
    private readCard: CardReader = defaultReadCard,
    // story-observabilidade-runs-telemetria: the durable run ledger. settle() writes ONE record per
    // settled run (cost/turns/duration/outcome) here — the forensic twin of the registry's in-memory
    // usage. DI (a fake in tests) so the persistence is unit-testable without touching disk; prod gets
    // the process-global disk-backed singleton.
    private telemetry: TelemetryPort = getTelemetryStore(),
    // story-mcp-enfileiramento-lote-dependencias: the process-global dependency graph backing the MCP
    // enqueue_batch tool. DI (a fresh graph in tests) so dependency-aware enqueueing is unit-testable
    // without the singleton; prod gets the shared one so chat/autorun/scripts see ONE graph.
    private depGraph: DependencyGraph = getDependencyGraph(),
    // story-#30: process-signal sender, injectable so killTree's group-kill escalation is unit-testable
    // WITHOUT signaling real processes. Prod gets process.kill; a test passes a spy. `0` = liveness probe.
    private killProcess: (pid: number, signal?: NodeJS.Signals | 0) => void = (pid, signal) => process.kill(pid, signal),
    // story-koieb3 (dogfood process isolation): the run's cgroup-scope reaper. settle() fire-and-forgets
    // this against the run's OWN `harness-run-<id>.scope` so any process the AGENT spawned and detached out of
    // the killTree process-group — notably the dogfood QA dev server — dies WITH the scope, BY scope, never
    // by loose PID. Internally guarded by isRunScopeUnit, so it can NEVER target storymap.service/a slice.
    // DI (a recording spy in tests) so the settle-stops-scope behavior is unit-testable without real systemd.
    private stopScope: (unit: string | undefined | null) => Promise<StopScopeResult> = (unit) => stopRunScope(unit),
    // story-koieb3 hardening (EDGE 3): the no-systemd fallback dev-server reaper. settle() ALWAYS fires
    // this against the run's recorded QA dev-server PID file (keyed by sessionId) — a harmless no-op when
    // no file exists (the common case: most runs never spawn the QA dev server). When systemd is ABSENT
    // (scopeApplied=false) this is the ONLY teardown for a dev server the agent detached out of killTree's
    // group; when scoped, the scope reap also covers it. It only ever signals the EXACT pid qa-dev-server
    // wrote — never a scanned/loose pid — so it can NEVER reach the prod 3008 service or a sibling run.
    // DI (a recording spy in tests) so the settle-reaps-pidfile behavior is unit-testable without real procs.
    private reapDevServer: (runId: string) => Promise<ReapPidResult> = (runId) => reapDevServerPid(runId),
    // dual-track OST (Fatia 4): reads the board's card pool at enqueue so the contextNote can hydrate the
    // run with the idea the story `addresses` (the PAIN it closes) — getAddressedIdea needs
    // the pool, not just the one card. DI (a fake in tests); prod reads the real cards. Fail-open to []
    // → the idea clause is simply omitted (the legacy note), never blocks a spawn.
    private readBoardCards: BoardCardsReader = defaultReadBoardCards,
    // WS-5 (storymap-parallel-work): "is this delta already in that target?", measured by CONTENT — the ONE
    // ruler the C2 build-evidence guard and the redrive pre-check share (convergence.ts). DI (a fake in
    // tests) so both decisions are unit-testable without a real repo; prod gets read-only git on repoRoot.
    // NEVER throws → its `unknown` verdict authorizes nothing, so a git outage degrades to today's behavior.
    private deltaLandedFn: DeltaLandedFn = (opts) => deltaLanded(defaultExec, findRepoRoot(), opts),
    // WS-4 (storymap-parallel-work): the card-claim registry — the run RESERVES its card at admission and
    // frees it on teardown, so no other agent picks the same card (and nothing writes the card underneath a
    // light run). DI (an in-memory double in tests) for the SAME reason as the journal: the admission path
    // runs on every spawn and must stay free of real disk IO — a test's `flush()` is one macrotask, and the
    // engine's contract is that a run spawns within it. Prod gets the process-global disk-backed singleton.
    // NEVER an integrity lock (see claims.ts): a refusal only avoids waste; the train still gates everything.
    private claims: CardClaimsPort = getCardClaims(),
    // The card mutator behind this engine's two settle-time stamps (C2 build-evidence + merge-back finding).
    // DI (an in-memory double in tests) because the real writer has no path seam — see {@link CardUpdater}.
    // LAST param, so every existing positional caller (the tests + the zero-arg singleton) is unaffected.
    private updateCard: CardUpdater = updateCardOnDisk,
    // The stranded-work retry's timer. DI (a fake in tests) for the usual reason: the behavior under test
    // is "a gated pump re-arms", and asserting it against a real 30s setTimeout would be untestable. Prod
    // gets setTimeout+unref, so an idle service is never held awake by it.
    private setTimer: PumpTimerFn = (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t as unknown as PumpTimer;
    },
    // WS-1.3 (autonomy-endgame): the SPLIT ruler — "did each half land in ITS OWN ref?" — for the redrive
    // pre-check, which measures a BRANCH (not a card's recorded range) and so must ask the question the way
    // the train answers it. Same seam and reasoning as `deltaLandedFn` (a fake in tests, read-only git in
    // prod); a separate port because it takes a branch and resolves the base itself. LAST param, so every
    // existing positional caller stays untouched — the rule the `updateCard` comment above states, and which
    // slotting this in mid-list promptly broke.
    private branchWorkLandedBySplitFn: (branch: string) => Promise<SplitLandedness> = (branch) =>
      branchWorkLandedBySplit(defaultExec, findRepoRoot(), branch, {
        // o branch de integração é DECLARADO (`autorun.staging.branch`); fixar o literal aqui
  // sobrescrevia a declaração do repositório — o train já lia o declarado, as réguas de ciclo de vida não
        stageBranch: loadRunnerConfig().autorun.staging?.branch ?? "stage",
      }),
  ) {
    // story-92ldyt: wire the merge train's conflict re-drive back into this engine. When a run branch
    // conflicts and the train re-drives (instead of pausing), it calls this to RE-RUN the generating
    // skill against the now-updated main. Registered once (the engine + queue are both singletons).
    this.mergeQueue?.setRedriveHandler((params) => this.redrive(params));
    // story-mcp-enfileiramento-lote-dependencias: when a run settles, tell the dependency graph; it
    // returns the cards whose LAST predecessor just settled ok, which we launch now. The graph stays
    // engine-free (it only computes WHO is ready) — the engine does the spawning, here.
    this.onComplete((ev) => {
      for (const e of this.depGraph.onSettled(ev.board, ev.cardId, ev.outcome)) {
        this.runSkill(e.board, e.cardId, e.trigger, e.def, { origin: "manual" });
      }
    });
  }

  /**
   * story-92ldyt: re-run a conflicting branch's generating skill against the updated main. Resolves the
   * column policy (StatusDef) for the trigger from the board config, then spawns the skill carrying the
   * incremented `driveCount` (so the regenerated branch enters the merge train one re-drive deeper) and
   * `origin: "conflict-redrive"` (exempt from the autorun dedupe/rate-limit, like a manual run). Returns
   * the ADMISSION result (audit #5): the train uses a rejection to RECOVER the card to `conflict` instead
   * of stranding it as terminal `re-driving`. Never throws (an unresolvable board/column degrades to ok:false).
   */
  private async redrive(params: {
    board: string;
    cardId: string;
    trigger: TriggerId;
    driveCount: number;
    conflictDetail: string;
    /** WS-2.2: preserved branch (conflicted/run/<id>) with the prior attempt's code, to REUSE. */
    preservedBranch?: string;
  }): Promise<{ ok: boolean; reason?: string; detail?: string }> {
    const { board, cardId, trigger, driveCount, preservedBranch } = params;
    const tag = `[harness-autorun redrive ${trigger} ${board}/${cardId}]`;
    const config = await this.readBoardConfig(board).catch(() => null);
    // The column whose trigger produced the branch carries the exact policy (model/effort/maxTurns)
    // to regenerate with. Absent (board/column gone) → can't faithfully re-run → tell the train to pause.
    const def = config?.statuses.find((s) => s.trigger === trigger);
    if (!def) {
      console.error(`${tag} não foi possível resolver a coluna do trigger — re-drive abortado`);
      return { ok: false, reason: "no-column", detail: "coluna do trigger não encontrada" };
    }
    // WS-5.3 — pre-check de convergência ANTES de re-spawnar: se o próprio trabalho do branch preservado JÁ
    // ESTÁ na base nova (aterrissou por outro caminho — o redrive anterior, um cherry-pick de resgate), o
    // agente fresco não teria NADA a implementar: ele gastaria os turnos, não escreveria código, e cairia no
    // no-op da C2 (foi assim que o qb8z2c re-implementou 3× por ~$13). Prova positiva ⇒ $0, zero spawn, e o
    // carimbo de build-evidence pelo caminho do 5.2. Qualquer outro veredito ⇒ spawna com o context note de
    // reaproveitamento (o pre-check conservador do D11 permanece: dúvida ⇒ spawna).
    if (preservedBranch) {
      const pre = await this.redriveAlreadyLanded(board, cardId, preservedBranch, tag);
      if (pre.kind === "already-landed") {
        console.warn(`${tag} re-drive DISPENSADO ($0, sem spawn): ${pre.detail}`);
        this.registry.appendLog(board, cardId, "info", `⏭ re-drive dispensado: ${pre.detail}`);
        // ok:true — nada foi RECUSADO (o train não deve devolver o card para `conflict`): a entry segue
        // terminal em `re-driving`, o branch preservado fica para o branch-gc colher por conteúdo (WS-5.4),
        // e o card já carrega a evidência que destrava seu gate. Simplesmente não há run para acompanhar.
        return { ok: true, reason: "already-landed", detail: pre.detail };
      }
      // WS-1.3 — a MEIA-ATERRISSAGEM não spawna. O código já está publicado em `stage`: re-implementá-lo é
      // o gasto do qb8z2c, e não conserta a metade que falhou (o defeito estava no `git apply`, não na
      // skill). `ok:false` faz o train parquear a entry como `conflict` COM este detalhe — um card parado e
      // LEGÍVEL, que nomeia a recuperação certa, vale mais que $13 de re-implementação silenciosa. Quem a
      // resolve é o retry da metade de dados (WS-3), não este caminho.
      if (pre.kind === "half-landed") {
        console.warn(`${tag} re-drive RECUSADO (meia-aterrissagem): ${pre.detail}`);
        this.registry.appendLog(board, cardId, "error", `⛔ re-drive recusado: ${pre.detail}`);
        return { ok: false, reason: "half-landed", detail: pre.detail };
      }
    }
    const res = this.runSkill(board, cardId, trigger, def, { origin: "conflict-redrive", driveCount, preservedBranch });
    if (!res.ok) {
      console.warn(`${tag} re-drive recusado: ${res.reason} (${res.detail})`);
      return { ok: false, reason: res.reason, detail: res.detail };
    }
    return { ok: true };
  }

  /**
   * MEDE se o run tocou uma superfície visível e carimba `uiSurfaceEvidence` no card — o FATO que o gate
   * `hasQaPassed` lê antes de qualquer declaração.
   *
   * Existe porque a declaração equivalente (`hasUiSurface`) dependia de uma skill LLM lembrar de um campo
   * opcional, e estava presente em 1 de 311 cards reais: o gate caía sempre no fallback `storyType ===
   * "user"`, e um `chore`/`technical`/`bug` que reescrevia componente passava sem QA visual nenhum. O
   * engine, ao contrário, já tem o diff na mão aqui — medir é barato e não depende de ninguém lembrar.
   *
   * O QUE conta como superfície vem da SPEC (`autorun.qa.uiSurfacePatterns`), nunca de constante daqui:
   * lista vazia ⇒ medição desligada (nenhum carimbo), o que devolve o gate ao caminho declarativo.
   * Best-effort: sem `changedPaths` (ops antiga), erro de git ou write falho ⇒ NÃO carimba. Ausência de
   * evidência é "ninguém mediu", e o gate trata isso como o comportamento de antes — nunca como isenção.
   * NUNCA lança: roda dentro do settle de um run.
   */
  private async stampUiSurfaceEvidence(opts: {
    board: string;
    cardId: string;
    worktreePath: string;
    base: string;
    runId: string;
    tag: string;
  }): Promise<void> {
    const { board, cardId, worktreePath, base, runId, tag } = opts;
    try {
      const patterns = loadRunnerConfig().autorun.qa?.uiSurfacePatterns ?? [];
      if (patterns.length === 0) return; // medição desligada pela spec
      if (!this.worktreeOps.changedPaths) return; // ops sem o método → sem medição (fail-open)
      const changed = await this.worktreeOps.changedPaths(worktreePath, base);
      const touched = pathsTouchUiSurface(changed, patterns);
      const matches = touched ? uiSurfacePaths(changed, patterns).slice(0, UI_SURFACE_EVIDENCE_PATH_CAP) : [];
      await this.updateCard(board, cardId, (card) => ({
        ...card,
        uiSurfaceEvidence: {
          touched,
          at: new Date().toISOString(),
          ...(matches.length ? { paths: matches } : {}),
          runId,
        },
      }));
    } catch (err) {
      console.error(`${tag} medição de superfície de UI falhou:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * WS-5.2 — the THIRD legitimate outcome the C2/O3.5 guard was missing: the card's delta is ALREADY in the
   * run's base, so writing no code was the CORRECT behaviour, not a `sucesso-fantasma`. Asks the shared
   * convergence ruler (never a bespoke check) whether `range` is contained in `target`; on `landed` — and
   * ONLY on `landed`, positive proof by content — stamps the card's `buildEvidence` so the hasBuildEvidence
   * gate opens and the deadlock (story-uae2ag) dies. Any other verdict returns null and the caller keeps its
   * conservative behaviour intact (a REAL sucesso-fantasma is still caught).
   *
   * Best-effort by construction: a card with no recorded delta, an `unknown` verdict, or a failed write all
   * return null. NEVER throws — this runs inside a run-settle callback.
   */
  private async stampBuildEvidenceIfLanded(opts: {
    board: string;
    cardId: string;
    card: Card | null;
    target: string;
    runId: string;
    tag: string;
  }): Promise<string | null> {
    const range = expectedDeltaOf(opts.card);
    if (!range) return null; // no recorded delta → nothing to prove → the guard decides as before
    return this.proveAndStampBuildEvidence({ ...opts, range });
  }

  /**
   * WS-5 — the shared tail of the two consumers (the C2 guard above and the redrive pre-check below): PROVE
   * `range` is contained in `target` and, only then, stamp the card. The two differ ONLY in where the range
   * comes from — the card's recorded delta (C2) or the preserved branch's own work (redrive) — so the proof,
   * the stamp and the fail-closed rules live here once. Returns the operator-facing note, or null when the
   * proof failed / the write failed (the caller stays conservative). NEVER throws.
   */
  private async proveAndStampBuildEvidence(opts: {
    board: string;
    cardId: string;
    range: { base: string; head: string };
    target: string;
    runId: string;
    tag: string;
  }): Promise<string | null> {
    const { board, cardId, range, target, runId, tag } = opts;
    try {
      const res = await this.deltaLandedFn({ range, target });
      if (res.verdict !== "landed") return null;
      return await this.stampAlreadyLanded({ board, cardId, range, target, runId, tag, proofDetail: res.detail });
    } catch (err) {
      // This runs INSIDE a run-settle callback: an escaping rejection would strand the run instead of
      // settling it. A failed proof/stamp is simply "no evidence" → the caller keeps its old behaviour.
      console.error(`${tag} prova/carimbo de convergência falhou:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * WS-1 — the STAMP, split out from the proof above so a caller that already holds a proof does not have to
   * re-measure to record it. That separation is load-bearing, not tidiness: the redrive pre-check proves
   * convergence with the SPLIT ruler (per half, per ref), and re-asking the whole-delta ruler here would
   * answer `absent` for the very work just proven landed — silently undoing the fix. Whoever calls this owes
   * a `landed` proof; this only writes it down. Returns the operator-facing note, or null if the write failed
   * (⇒ don't claim what we couldn't record). NEVER throws.
   */
  private async stampAlreadyLanded(opts: {
    board: string;
    cardId: string;
    range: { base: string; head: string };
    target: string;
    runId: string;
    tag: string;
    proofDetail: string;
  }): Promise<string | null> {
    const { board, cardId, range, target, runId, tag, proofDetail } = opts;
    try {
      const rangeStr = `${range.base}..${range.head}`;
      const stamped = await this.updateCard(board, cardId, (card) => ({
        ...card,
        buildEvidence: {
          provenance: "already-landed" as const,
          at: new Date().toISOString(),
          range: rangeStr,
          target,
          runId,
        },
      }));
      if (!stamped) return null; // couldn't record the proof → don't claim it (caller stays conservative)
      return `o delta do card já está na base do run (${proofDetail}) — build-evidence 'already-landed' carimbada`;
    } catch (err) {
      console.error(`${tag} carimbo de convergência falhou:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * WS-5.3 / WS-1.3 — is the PRESERVED branch's own work already where a fresh redrive would look for it?
   * The range comes from {@link resolveRunBase} (the exact cut point) and NEVER from HEAD/merge-base:
   * measuring `HEAD...branch` would re-attribute the stage code the branch INHERITED to the run, and "the
   * run's own work" would balloon into "everything unreleased" — the confusion run-base.ts exists to kill.
   *
   * WS-1.3 fixed TWO lies this pre-check told, both of which cost real money:
   *
   * 1. IT MEASURED AGAINST ONE REF. It asked `ensureRunBase()` (with staging ON: `stage`) whether the WHOLE
   *    delta was there. But the train SPLITS — code to `stage`, board-data to `main` — so a run that touched
   *    both is never fully in either, and the honest-looking `absent` was structural. `absent` here means
   *    SPAWN, so the fix that landed by another path got re-implemented from zero: the qb8z2c pattern, 3×
   *    for ~$13. Now it asks {@link branchWorkLandedBySplit}, which measures each half against its own ref.
   *
   * 2. IT TESTED `provenance !== "reflog"`. convergence.ts documents that exact literal as the BUG (the
   *    other copy of this ruler carried it): an `agent/*` session branch's exact base is the
   *    `refs/agent-base/<id>` ref, because worktree_refresh's rebase invalidates the reflog — so the reflog
   *    test alone made every session branch permanently unprovable. `isExactBase` = reflog OR base-ref, and
   *    it now lives in ONE place (inside the split ruler), not in a copy here.
   *
   * THE VERDICT IS TERNARY BECAUSE THE TRUTH IS. `string | null` fused three different situations into one
   * "spawn", and the middle one is the incident:
   *   • both halves landed (or don't exist) ⇒ `already-landed`: $0, no spawn, stamp the evidence.
   *   • code landed, data absent ⇒ `half-landed`: the code IS published on `stage` and the board-data is
   *     NOT on `main`. Redriving would re-implement published code AND not fix the data (the failure was in
   *     `git apply`, not in the skill) — so it must NOT spawn. It parks with an honest detail naming the real
   *     recovery; WS-3 is what retries the data half. This is the live shape of a779b5be/f873d987.
   *   • anything `unknown`, or the code absent ⇒ spawn (today's behaviour; doubt spawns, D11).
   *
   * Fail-open at every step: no base, an unmeasurable ref or a failed stamp all mean spawn. NEVER throws.
   */
  private async redriveAlreadyLanded(
    board: string,
    cardId: string,
    preservedBranch: string,
    tag: string,
  ): Promise<
    | { kind: "already-landed"; detail: string }
    | { kind: "half-landed"; detail: string }
    | { kind: "spawn" }
  > {
    try {
      const split = await this.branchWorkLandedBySplitFn(preservedBranch);
      const verdict = projectSplitVerdict(split);

      if (verdict === "landed") {
        // The target we record is the pair of refs the split actually landed in — `stage` alone would be a
        // half-truth on a mixed run, and the stamp is read by a human deciding whether to trust the skip.
        const note = await this.stampAlreadyLanded({
          board,
          cardId,
          range: { base: split.base ?? "run-base", head: preservedBranch },
          target: "stage+main (split)",
          runId: preservedBranch,
          tag,
          proofDetail: split.detail,
        });
        return note ? { kind: "already-landed", detail: note } : { kind: "spawn" };
      }

      if (split.code === "landed" && split.data === "absent") {
        return {
          kind: "half-landed",
          detail:
            `MEIA-ATERRISSAGEM: o código do run ${preservedBranch} está em 'stage'; o board-data NÃO está em 'main'. ` +
            `Re-drivar re-implementaria código já publicado e não consertaria os dados — a recuperação é RETENTAR ` +
            `a metade de dados (split-<runId>-data.patch), não re-rodar a skill. (${split.detail})`,
        };
      }
      return { kind: "spawn" };
    } catch (err) {
      console.warn(`${tag} pre-check de convergência falhou (spawna normalmente):`, err instanceof Error ? err.message : err);
      return { kind: "spawn" };
    }
  }

  /** Is a run for this card currently queued or executing? */
  isInFlight(board: string, cardId: string): boolean {
    return this.inFlight.has(`${board}/${cardId}`);
  }

  /**
   * ADR-063 (4b): the DURABLE facts the autorun loop-guard shell needs about a card's MOST-RECENT run —
   * the status that run processed (`column`), the monotonic same-column no-progress counter it carried
   * (`noProgressRuns`), and its `trigger`. Read from the journal (NOT the in-memory registry) precisely so
   * it survives a service restart: the counter is persisted on the journal entry and re-injected on
   * recovery, so the guard can't be reset merely by bouncing the process. A tiny typed projection, never
   * the whole entry. undefined ⇒ the card has no run on record (⇒ the shell treats it as a fresh column).
   */
  async lastRun(
    board: string,
    cardId: string,
  ): Promise<{ column?: string; noProgressRuns?: number; trigger?: TriggerId } | undefined> {
    const entry = await this.journal.latest?.(board, cardId);
    if (!entry) return undefined;
    return { column: entry.column, noProgressRuns: entry.noProgressRuns, trigger: entry.trigger };
  }

  /**
   * Kill the whole process TREE of a run's child. The child is the OS shell (shell:true); on POSIX the
   * run is spawned `detached` so the shell + its `claude` grandchild form a PROCESS GROUP led by the
   * shell pid — signaling the NEGATIVE pid reaches the grandchild that a bare child.kill() would orphan
   * (story-#30: a `claude -p` survived a cancel for 16min, reparented to init). Escalates SIGTERM →
   * poll(150ms) → SIGKILL, CONFIRMING death via kill(-pid, 0) (throws ESRCH when the whole group is
   * gone). Bare-pid fallback if the group send fails (an edge path spawned non-detached). On Windows,
   * `taskkill /T /F` already tree-kills. Async so the caller awaits the confirmed teardown.
   */
  private async killTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      this.spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      await delay(200);
      return;
    }
    // POSIX: signal the GROUP (negative pid); fall back to the bare pid if that throws (non-detached edge).
    const sig = (s: NodeJS.Signals | 0): void => {
      try {
        this.killProcess(-pid, s);
      } catch {
        try {
          this.killProcess(pid, s);
        } catch {
          /* already gone (ESRCH) */
        }
      }
    };
    const groupAlive = (): boolean => {
      try {
        this.killProcess(-pid, 0); // 0 = liveness probe; throws ESRCH when the group is empty
        return true;
      } catch {
        try {
          this.killProcess(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
    };
    sig("SIGTERM");
    await delay(150);
    if (groupAlive()) {
      sig("SIGKILL"); // claude ignored SIGTERM → force the whole group down
      await delay(100);
    }
  }

  /**
   * Force-release a card's run — the "matar/liberar run travado" control. The universal
   * watchdog (timeoutFor) now caps every run, so this is the ON-DEMAND complement: kill a
   * stuck run before the ceiling, or reach a headless `claude -p` child that tmux can't.
   * If it's executing,
   * kill the child: its `close` runs settle(), which releases the in-flight lock, journals
   * the outcome and pumps the queue. If it's only QUEUED (waiting for a slot), flag it so
   * its start() cancels cleanly when its turn comes. Returns whether anything was released.
   * story-#30: async — it AWAITS the confirmed tree-kill (SIGTERM→SIGKILL on the process group)
   * so the orphan `claude -p` is dead before the slot is reported released.
   */
  async forceRelease(board: string, cardId: string): Promise<{ released: boolean; note?: string }> {
    const key = `${board}/${cardId}`;
    const child = this.children.get(key);
    let released = false;
    let note: string | undefined;
    // A live child and a QUEUED run for the SAME card can't coexist — the running child holds the inFlight
    // lock under the same key, so at most one branch applies. WS-8.2 (drain an already-enqueued next step on
    // cancel) is therefore inherently covered by the queued branch: the moment the chained step actually
    // enqueues, THIS card's live child has already settled and released the lock (they never overlap).
    if (child) {
      this.forceKilled.add(key); // mark so the close handler doesn't mislabel a SIGKILL (137) as OOM
      this.cancelledKills.add(key); // story-vbkazs: a DELIBERATE cancel → finish() records "cancelled", not "exit"
      await this.killTree(child); // group SIGTERM→SIGKILL → child 'close' → settle() does the cleanup
      released = true;
    } else if (this.inFlight.has(key)) {
      // WS-8.2 — a QUEUED (not-yet-spawned) run of this card, e.g. the next threaded step already enqueued.
      // Mark it to self-cancel when the pump dequeues it (start() checks this), then release the in-flight
      // lock immediately — so a re-trigger can enqueue right now instead of waiting for the pump to drain the
      // old entry first. The dequeue path settles it as cancelled with no telemetry.
      this.cancelled.add(key);
      this.inFlight.delete(key);
      // #44: re-stamp the anti-replay window for this card's trigger(s). Freeing the lock above is
      // deliberate (a MANUAL re-run, which passes no dedupe window, should work at once) — but it
      // ALSO reopens the door for an AUTORUN echo (a watcher re-eval, no suppressTrigger) to
      // resurrect the just-cancelled run through the freed lock, BEFORE the pump dequeues+finalizes
      // it. The original spawn stamp has already expired if the run sat queued past the window, so
      // re-stamp NOW: an autorun echo is deduped for the full window; a manual re-run stays allowed.
      const stampNow = Date.now();
      for (const replayKey of this.lastSpawnAt.keys()) {
        if (replayKey.startsWith(`${key}:`)) this.lastSpawnAt.set(replayKey, stampNow);
      }
      released = true;
      note = "na fila — lock liberado; re-enfileirar quando quiser";
    }
    if (!released) return { released: false, note: "nenhuma run ativa para este card" };
    // WS-8.1: arm the phase-brake. Read the card's resting status AFTER the kill (the cancelled run wrote
    // any status-advance to disk before dying, and killTree awaited the confirmed teardown) so the brake
    // knows the exact status the cascade would re-engage from; a later human MOVE to a different status
    // clears it (see recentlyCancelledAgeMs). Fail-open: an unreadable status stores null (a null-status card
    // still brakes; the human-move clear then keys off any non-null status). Set LAST so a read error never
    // aborts the cancel itself.
    const status = await this.readCardStatus(board, cardId).catch(() => null);
    this.recentlyCancelled.set(key, { at: Date.now(), status });
    return note ? { released: true, note } : { released: true };
  }

  /**
   * WS-8.1 — is a card's autorun cascade currently phase-braked by a recent operator cancel? The autorun
   * re-eval calls this BEFORE spawning/threading. Returns the brake's AGE in ms (for the pause log) when a
   * cancel marker exists, is within {@link RECENTLY_CANCELLED_TTL_MS}, AND the card still rests at the status
   * it was cancelled in; otherwise null (no brake). A status change (a human moved the card = explicit resume
   * intent) or the TTL clears the marker as a side effect — so the brake self-releases the moment the operator
   * acts, and NEVER holds past the TTL. `currentStatus` is the caller's freshly-read on-disk status.
   */
  recentlyCancelledAgeMs(board: string, cardId: string, currentStatus: string | null): number | null {
    const key = `${board}/${cardId}`;
    const m = this.recentlyCancelled.get(key);
    if (!m) return null;
    const age = Date.now() - m.at;
    if (age > RECENTLY_CANCELLED_TTL_MS) {
      this.recentlyCancelled.delete(key); // expired → self-release
      return null;
    }
    if (currentStatus !== m.status) {
      this.recentlyCancelled.delete(key); // the card moved (human resume) → drop the brake
      return null;
    }
    return age;
  }

  /** WS-8.1 — drop a card's cancel phase-brake explicitly (an unmistakable human resume: a manual/redrive
   *  re-run via runSkill). Idempotent. */
  clearRecentlyCancelled(board: string, cardId: string): void {
    this.recentlyCancelled.delete(`${board}/${cardId}`);
  }

  /**
   * WS-5.3 — gather the pre-check facts for (card, trigger) and run the pure {@link precheckNoop}. Only READS
   * (in-memory telemetry, at most ONE card-mtime stat, the raw capture proposal for harness-capture) — never
   * writes. FAIL-OPEN: any gather error → { noop: false } (spawn) so a broken pre-check can never stall a card.
   */
  private async runPrecheck(
    board: string,
    cardId: string,
    trigger: TriggerId,
    origin: "autorun" | "manual" | "conflict-redrive",
    card: Card | null,
  ): Promise<PrecheckResult> {
    try {
      // MOST-RECENT settled run of THIS trigger (telemetry is most-recent-first).
      const runs = await this.telemetry.listByCard(board, cardId, 20).catch(() => []);
      const lastRunOfTrigger = runs.find((r) => r.trigger === trigger) ?? null;

      // Case 1 needs the card .md mtime — stat ONLY when the last run was a no-op (the sole consumer) so the
      // hot spawn path stays cheap. Fail-open: an unreadable stat → null → case 1 can't fire (spawn).
      let cardMtimeMs: number | null = null;
      if (lastRunOfTrigger?.status === "no-op") {
        cardMtimeMs = await fsp
          .stat(cardPath(board, cardId))
          .then((s) => s.mtimeMs)
          .catch(() => null);
      }

      // Case 3 (harness-capture) — compare the stamped input hash against the current input (body + feedback[]).
      let proposalInputHash: string | null = null;
      let currentInputHash: string | null = null;
      if (trigger === "harness-capture") {
        const raw = await readRawProposalSidecar(board, cardId);
        const stamped = raw && typeof raw.inputHash === "string" ? raw.inputHash : null;
        if (stamped) {
          proposalInputHash = stamped;
          const feedback = Array.isArray(raw!.feedback) ? raw!.feedback.map((f) => String(f)) : [];
          currentInputHash = captureInputHash(card?.body ?? "", feedback);
        }
      }

      return precheckNoop({
        trigger,
        origin,
        lastRunOfTrigger: lastRunOfTrigger
          ? {
              status: lastRunOfTrigger.status,
              startedAt: lastRunOfTrigger.startedAt,
              advanced: lastRunOfTrigger.advanced,
              // WS-4.2: lets Case 1 exclude a claim-refused settle (a run that never ran) — without it a
              // reservation would wedge the card forever. See CLAIM_REFUSED_MARKER.
              summary: lastRunOfTrigger.summary,
            }
          : null,
        cardMtimeMs,
        tasks: card?.tasks,
        hasOpenBlocker: (card?.findings ?? []).some((f) => f.status === "open" && f.severity === "blocker"),
        proposalInputHash,
        currentInputHash,
      });
    } catch (err) {
      console.error(`[harness-autorun precheck ${board}/${cardId}] falhou — spawn normal:`, err instanceof Error ? err.message : err);
      return { noop: false };
    }
  }

  /**
   * Os runs deste host vão nascer CONTIDOS? Barato, sem efeito colateral, e chamável no PREFLIGHT — que é
   * a única razão de existir separado da postura.
   *
   * POR QUE NÃO `resolveEnginePosture` AQUI, que seria a resposta exata. Duas razões, e a segunda quebraria
   * runs de verdade:
   *   1. ORDEM — o preflight roda ~340 linhas antes de a postura ser computada, e um dos insumos dela é o
   *      `cwd`, que só existe depois da alocação do worktree efêmero. No preflight não há `cwd` para dar.
   *   2. EFEITO COLATERAL — `resolveEnginePosture` GRAVA `sandbox-<key>.json`, e o portão de spawn recompõe
   *      o sha256 desses bytes e ABORTA o run se divergir. Chamá-la duas vezes com a mesma sessionId
   *      escreveria o mesmo caminho com bytes DIFERENTES (aqui o writeRoot seria o repoRoot; no spawn é o
   *      worktree), e todo run morreria no portão. A verificação existe justamente para isso; o erro seria
   *      meu, não dela.
   *
   * O que sobra é a pergunta que NÃO precisa de `cwd`: este host contém, e a válvula global de escape está
   * desligada? `suporteDoHost()` é memoizada por processo e não escreve nada. O `cwd` só influencia a
   * postura por um caminho — um override por target, que apenas RECUSA (contém menos) —, então errar aqui
   * erra na direção de degradar para o fallback, que funciona. A direção oposta é a que devolve card vazio.
   */
  private runWillBeContained(): boolean {
    try {
      return suporteDoHost().available && !unsandboxedFullAllowed(process.env);
    } catch {
      return false; // fail-open, como todo o resto desta camada: na dúvida, não recuse provedor nenhum
    }
  }

  /**
   * CAPABILITY PREFLIGHT — prove the step's REQUIRED capabilities on this host BEFORE spawning.
   *
   * This is the producer the capability contract needs to be more than a declaration. The step declares
   * what it must be able to do (`toolkit.expect` at `expected` level); each provider declares how to prove
   * itself (`toolConfigs.<id>.probe`); this runs those probes (cached, so the hot path pays ~0) and returns
   * which provider is live. An unresolved capability is settled by the caller WITHOUT a process — the
   * difference between a US$6 discovery and a US$0 one.
   *
   * FAIL-OPEN on its own errors: a preflight that cannot run returns [] (spawn normally). It may only ever
   * stop a run on an explicit negative verdict.
   */
  private async runCapabilityPreflight(
    board: string,
    cardId: string,
    def: StatusDef,
    boardConfig: BoardConfig | null,
    card: Card | null,
  ): Promise<CapabilityResolution[]> {
    try {
      // The conditional expectations read CARD facts. `hasUiSurface` comes from gate-core — the canonical
      // evidence-first ruling the gates already use — so the preflight and `hasQaPassed` can never disagree
      // about whether a card has screens. An unreadable card yields undefined ⇒ a `when: uiSurface`
      // requirement does NOT apply (fail-open: never block on a fact we could not read).
      const required = requiredCapabilities(def, boardConfig?.toolConfigs, board, this.repoRoot, {
        uiSurface: card ? hasUiSurface(card) : undefined,
      });
      if (!required.length) return [];
      return await resolveCapabilities(required, { repoRoot: this.repoRoot, contained: this.runWillBeContained() });
    } catch (err) {
      console.error(
        `[harness-autorun preflight ${board}/${cardId}] falhou — spawn normal:`,
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  private pump = () => {
    // Config is read LIVE so the Config panel / settings.yaml can retune mid-session.
    const cfg = loadRunnerConfig().autorun;
    const max = Math.max(1, cfg.maxConcurrent);
    const { lanes, thresholds } = cfg.scheduler;
    // Probe at most ONCE per pump pass: resources don't change within one synchronous drain, and a
    // heavy run is only gated when one is actually waiting (skip the /proc read otherwise).
    let resources: VpsResources | null = null;

    while (this.running < max) {
      const runningLight = this.running - this.runningHeavy;
      const canLight = this.lightQueue.length > 0 && runningLight < lanes.light.maxConcurrent;
      let canHeavy = this.heavyQueue.length > 0 && this.runningHeavy < lanes.heavy.maxConcurrent;
      if (canHeavy) {
        try {
          if (resources === null) resources = this.probeResources();
        } catch (err) {
          // probeResources() reads /proc/meminfo — a failure (e.g. restricted env) must not
          // crash the pump; block heavy lane for this pass and retry next pump cycle.
          console.error("[harness-autorun pump] probeResources falhou — heavy lane bloqueada:", err instanceof Error ? err.message : err);
          canHeavy = false;
        }
        // Hold the heavy run in its queue while the VPS is over the RAM/CPU threshold — without
        // blocking the light lane (its eligibility above is independent of this probe).
        if (resources && isVpsOverloaded(resources, thresholds)) canHeavy = false;
      }
      if (!canLight && !canHeavy) break;

      // Prefer the light lane when both are eligible: light runs are cheap + short, so draining them
      // first keeps the board responsive and frees their slots fast for the heavy backlog.
      const lane: RunLane = canLight ? "light" : "heavy";
      const job = (lane === "light" ? this.lightQueue : this.heavyQueue).shift()!;
      (lane === "light" ? this.lightQueueKeys : this.heavyQueueKeys).shift(); // keep keys in lockstep
      this.running += 1;
      if (lane === "heavy") this.runningHeavy += 1;
      // job() (start) is invoked synchronously so its pre-spawn work keeps its timing, but the
      // returned promise is NO LONGER floating: start() funnels every launch failure through its
      // own try/catch, and this .catch is the LAST-RESORT net — a stray throw must reclaim BOTH
      // counters and never surface as an unhandled rejection.
      void job().catch((err) => {
        console.error(
          "[harness-autorun] start() lançou exceção inesperada (slot recuperado):",
          err instanceof Error ? err.message : err,
        );
        this.running -= 1;
        if (lane === "heavy") this.runningHeavy -= 1;
        this.pump();
      });
    }
    // The loop above exits either satisfied (nothing queued) or GATED. When it exits gated with nothing
    // running, no future edge exists to re-enter it — see {@link pumpRetryNeeded}. Re-arm on a timer so a
    // level condition that clears silently (the VPS cooling down) still gets its run admitted.
    if (pumpRetryNeeded(this.running, this.heavyQueue.length)) this.armPumpRetry();
  };

  /**
   * The stranded-work timer: ONE at a time, self-clearing, `unref`'d so it never holds the process open.
   * Re-entrant by construction — the re-pump either admits the work (and the timer stays disarmed until a
   * future pump strands something again) or re-arms itself, which is the retry.
   */
  private armPumpRetry() {
    if (this.pumpRetryTimer) return; // already waiting — a second timer would just double the probe rate
    this.pumpRetryTimer = this.setTimer(() => {
      this.pumpRetryTimer = null;
      this.pump();
    }, PUMP_RETRY_MS);
  }

  /**
   * Run a harness-* skill headless on a card. Idempotent per card (a second call while
   * one is in-flight is rejected). Shared by autorun + the manual run action so a
   * burst can never exceed maxConcurrent.
   */
  runSkill(
    board: string,
    cardId: string,
    trigger: TriggerId,
    def: StatusDef,
    opts: {
      dedupeWindowMs?: number;
      origin?: "autorun" | "manual" | "conflict-redrive";
      // story-92ldyt: re-drive depth carried by a conflict-redrive run. Propagated onto the merge entry
      // when this run's branch is enqueued, so a re-driven branch that conflicts AGAIN is one deeper.
      driveCount?: number;
      // WS-2.2: on a conflict-redrive, the PRESERVED branch (conflicted/run/<id>) holding the prior
      // attempt's code — surfaced in this run's context note so the agent REUSES it (cherry-pick/inspect)
      // instead of re-implementing from zero (the qb8z2c ~$13 re-implementation loop).
      preservedBranch?: string;
      /**
       * Pre-resolved headroom proxy URL (story-5m0r3n). Caller reads board.yaml +
       * `AGILEHARNESS_HEADROOM_URL` via {@link resolveHeadroomUrl} and passes the result here; the
       * engine probes liveness and injects `ANTHROPIC_BASE_URL` into the spawn env. When omitted,
       * the engine falls back to `AGILEHARNESS_HEADROOM_URL` only (no board.yaml). Null ⇒ direct.
       */
      headroomUrl?: string | null;
      /**
       * story-watchdog-recuperacao-runs-mortos — boot recovery REVIVES a crashed run instead of
       * starting it over. When set, this run spawns `claude --resume <resumeSessionId>` (preserving
       * the prior session's transcript + checkpoint) instead of a fresh `-p` run, and it is journaled
       * under THIS id (not a freshly generated uuid), so the resumed session is the same one on disk.
       */
      resumeSessionId?: string;
      /**
       * story-watchdog-recuperacao-runs-mortos — the original run's ephemeral worktree, still on disk
       * (recovery verified it exists). When set, the resume runs in THIS tree (cwd) instead of creating
       * a fresh one, and the HEAD=estado board commit (boundary-1) is skipped (it ran before the original
       * run). Only meaningful alongside `resumeSessionId`; undefined ⇒ the resume runs in the repo root.
       */
      existingWorktreePath?: string;
      /**
       * story-9s52tu HALF B (HIGH #2): the MONOTONIC max-turns resume depth this run carries. A run
       * re-dispatched after a `--max-turns` settle (in-process resume OR boot recovery) passes the prior
       * count + 1, journaled via recordStart so it SURVIVES into the next cycle (like driveCount). The
       * max-turns settle reads it: once it would reach {@link maxTurnsResumeMax}, the run ESCALATES to a
       * genuine failure instead of preserving + resuming again. Absent ⇒ 0 (a first, never-resumed run).
       */
      maxTurnsResumeCount?: number;
      /**
       * story-harness-cc HALF #5: the MONOTONIC missing-session fallback depth this run carries. A run
       * re-dispatched FRESH after a "No conversation found with session ID" (resumeFallback) passes the
       * prior count + 1; a max-turns in-process resume / boot recovery carry it forward UNCHANGED — all
       * journaled via recordStart so the per-card budget SURVIVES a restart (the in-memory Map does not).
       * The missing-session settle reads it against {@link resumeFallbackMax}. Absent ⇒ 0.
       */
      resumeFallbackCount?: number;
      /**
       * story-harness-adk G6: a one-line distilled summary of the DEAD run's reasoning (summarizeFinalText
       * of its finalText), set by {@link resumeFallback} on the FRESH re-dispatch after a missing `--resume`
       * session. Injected into the fresh run's system-prompt-file so the lost session's reasoning carries
       * forward (the agent doesn't re-tread abandoned dead-ends). Absent ⇒ a normal run.
       */
      resumeNote?: string;
      /**
       * ADR-063 (4b): the card STATUS this run processes + the MONOTONIC same-column-no-progress counter,
       * stamped by the autorun shell (evaluateAutorunOnEntry) so recordStart persists them on the journal
       * entry (surviving a restart). The engine only CARRIES them (into every recordStart, and FORWARD
       * unchanged on its own resume/max-turns/fallback re-dispatch — those are the SAME logical attempt, so
       * it never increments; the shell owns the increment). Absent ⇒ a manual/legacy run (guard inert/reset).
       */
      column?: string;
      noProgressRuns?: number;
    } = {},
  ): RunAttempt {
    const key = `${board}/${cardId}`;
    // Security gate: never interpolate a non-slug id into the spawned shell command.
    if (!SLUG.test(board) || !SLUG.test(cardId)) {
      const detail = `id fora do charset slug: board=${JSON.stringify(board)} card=${JSON.stringify(cardId)}`;
      console.error(`[harness-autorun] recusado ${detail}`);
      return { ok: false, reason: "bad-id", detail };
    }
    // Anti-replay: when the caller passes a window (autorun), refuse a repeat of the
    // SAME trigger on the SAME card within it — absorbs fs.watch double-fires + a
    // rename's card.created echo. Manual runs pass no window, so they're never throttled.
    const replayKey = `${key}:${trigger}`;
    const window = opts.dedupeWindowMs ?? 0;
    if (window > 0) {
      const last = this.lastSpawnAt.get(replayKey);
      if (last !== undefined && Date.now() - last < window) {
        return { ok: false, reason: "cooldown", detail: `re-disparo ignorado (< ${Math.round(window / 1000)}s)` };
      }
      // Circuit breaker: cap how many autorun spawns START per rolling window (across
      // cards), so a loop / mass-toggle can't fan out dozens of opus/max runs.
      const { max, windowMs } = autorunRateLimit();
      const now = Date.now();
      this.autorunSpawnTimes = this.autorunSpawnTimes.filter((t) => now - t < windowMs);
      if (this.autorunSpawnTimes.length >= max) {
        const detail = `limite de ${max} runs/${Math.round(windowMs / 60_000)}min atingido — autorun pausado`;
        console.warn(`[harness-autorun] ${detail} (recusando ${replayKey})`);
        return { ok: false, reason: "rate-limited", detail };
      }
    }
    if (this.inFlight.has(key)) return { ok: false, reason: "in-flight", detail: "já está rodando/na fila" };
    this.inFlight.add(key);
    // Stamp every spawn (manual included) so an immediate autorun echo of the same
    // trigger is deduped even when a manual run kicked it off.
    this.lastSpawnAt.set(replayKey, Date.now());
    if (window > 0) this.autorunSpawnTimes.push(Date.now());

    // Fresh id per run → re-running a card never collides with a prior session ("already in use").
    // Generated at ENQUEUE (not spawn) and journaled NOW with a null pid, so a crash WHILE QUEUED
    // (waiting for a concurrency slot) still leaves a recoverable "running" entry — the pid is
    // upserted once the slot frees and the child actually spawns.
    // story-watchdog: a resume REUSES the crashed run's session id (so `claude --resume` rehydrates
    // the same transcript and the journal keys it identically), instead of minting a fresh one.
    const sessionId = opts.resumeSessionId ?? newRunSessionId();
    const origin = opts.origin ?? "autorun";
    // WS-8.1: an EXPLICIT re-run (a human "Rodar agora"/enqueue = "manual", or a merge-train re-drive =
    // "conflict-redrive") is an unmistakable resume intent → drop any cancel phase-brake on this card so the
    // caller's run (and the cascade it feeds) proceeds. An "autorun" spawn does NOT clear it — that is the
    // very cascade the brake exists to pause.
    if (origin !== "autorun") this.clearRecentlyCancelled(board, cardId);
    const bootMs = osBootMs();
    void this.journal.recordStart({ board, cardId, trigger, sessionId, pid: null, startedAt: Date.now(), osBootMs: bootMs, origin, driveCount: opts.driveCount, maxTurnsResumeCount: opts.maxTurnsResumeCount, resumeFallbackCount: opts.resumeFallbackCount, resumeNote: opts.resumeNote, column: opts.column, noProgressRuns: opts.noProgressRuns });

    // Card status NOW (before the skill runs) → finish() compares it with the post-run
    // status to detect the "falha-fantasma": a non-clean exit AFTER the card already
    // advanced (e.g. error_max_turns once the edits landed) is the skill finishing its
    // work + the CLI erroring — NOT a failure. Read at ENQUEUE (the card still sits in
    // its trigger column; nothing has moved it yet), so it's race-free even while queued.
    const beforeStatusP = this.readCardStatus(board, cardId).catch(() => null);

    // story-rotear-model-effort-por-complexidade: read the FULL card at ENQUEUE (in parallel with
    // beforeStatusP) so the spawn flags can be routed by its complexity signals. The card sits in its
    // trigger column untouched here, so the signals are stable from enqueue to spawn. Fail-open to null
    // → the flags block degrades to the column policy (resolveColumnArgs), identical to before.
    const cardP = this.readCard(board, cardId).catch(() => null);

    // SM-09: read the board config at ENQUEUE (parallel with cardP) so the spawn can inject a
    // per-app context note (read packages/<pkg>/.claude/CLAUDE.md + brandbook before any code/copy).
    // Fail-open to null → buildContextNote returns null and the note is omitted (AC4), identical to
    // the pre-SM-09 spawn. Reuses the same reader the conflict-redrive path already injects.
    const boardConfigP = this.readBoardConfig(board).catch(() => null);

    // story-harness-adk G5 (handoff destilado): read this card's telemetry at ENQUEUE (parallel with
    // cardP/boardConfigP) to surface what the PREVIOUS step concluded — the `summary` (summarizeFinalText
    // of the prior run's finalText) of the most-recent OK run from a DIFFERENT trigger. The finalText is
    // captured + persisted today (trailer `Decision:` + telemetry summary) but was NEVER fed forward;
    // injecting it as a HINT (not a constraint) lets the next skill build on the last one instead of
    // starting blind. Fail-open to null → no handoff clause (identical to before). Most-recent first; the
    // current run has no telemetry row yet (written at settle), so the match is genuinely a prior step.
    const handoffP = this.telemetry
      .listByCard(board, cardId, 12)
      .then((runs) => {
        // The PREVIOUS step = the most-recent OK run from a DIFFERENT trigger. Sort EXPLICITLY by
        // startedAt desc (never rely on listByCard's order) so a reentry — refine/fix re-runs the same
        // steps — can't surface a stale earlier-lap run, and the window is widened (5→12) so many resumes
        // can't push the real predecessor out of view (which would degrade to a fail-open miss). Attach
        // the source run's AGE so the next skill can weigh the hint's freshness (formatRunAge).
        const prev = runs
          .filter((r) => r.status === "ok" && r.trigger !== trigger && !!r.summary && r.summary.trim().length > 0)
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        return prev
          ? { trigger: prev.trigger, summary: prev.summary!.trim(), age: formatRunAge(Date.now() - prev.startedAt) }
          : null;
      })
      .catch(() => null);

    // Admission lane fixed at ENQUEUE (the trigger never changes) and captured in the start closure,
    // so every teardown path frees the SAME counters pump() claimed — runningHeavy can't desync.
    const lane = classifyTrigger(trigger);

    // story-ll5zt3: outer-scope emergency release for pump()'s last-resort catch. The slot counters
    // (running/runningHeavy) are handled by pump's catch; this covers the in-flight lock + child.
    const releaseInFlight = () => {
      this.inFlight.delete(key);
      this.children.delete(key);
    };

    const start = async () => {
      const tag = `[harness-autorun ${trigger} ${key}]`;
      // story-apz8sa: the ONE classification that gates the whole worktree + split-train lifecycle.
      // isCode:true skills (do/review/qa/fix/refine/retire/sync-card) write product code → they get an
      // EPHEMERAL worktree + the merge train. isCode:false skills (capture/enrich/grill/interview/
      // tasks/prioritize/plan/ux/ui) ONLY mutate storymap/boards/** → they spawn in the MAIN tree (like
      // a human editing the board live) and commit their board-data straight to main via the per-cwd
      // serializer at settle, with NO branch and NO merge-train entry. Read once so the create-gate and
      // the settle-commit branch can never disagree (a divergence would orphan or double-commit).
      const isCode = isCodeSkill(trigger);
      // Release the concurrency slot pump() claimed for this run: the global counter always, plus the
      // heavy-lane counter when this run rode the heavy lane. Used by every teardown below.
      const releaseSlot = () => {
        this.running -= 1;
        if (lane === "heavy") this.runningHeavy -= 1;
      };
      // story-harness-cc #1: the per-run --append-system-prompt-file temp path, written just before spawn
      // into the gitignored runner state dir (NOT the worktree — so the agent's own `git add -A` never
      // captures it). Cleaned up in release() below (the universal teardown — covers code AND board-data
      // runs; the queued-cancel path never wrote one, so the unlink is a harmless no-op).
      let systemPromptFile: string | undefined;
      // WS-4.2: true once THIS run reserved the card (see the acquire below). Read by release() so a run torn
      // down BEFORE the acquisition (the queued-cancel path) never releases a reservation it never held.
      let claimHeld = false;
      // story-ll5zt3: idempotent lock + slot release, called from finally in every teardown path.
      // Guarantees the in-flight lock is freed even if registry/journal/worktree throws — a throw
      // before inFlight.delete would otherwise leave the card wedged until a service restart.
      const release = () => {
        this.children.delete(key);
        this.inFlight.delete(key); // idempotent (Set.delete on missing key is a no-op)
        releaseSlot();
        // WS-4.2 — the reservation dies with the run on EVERY path (settle / watchdog timeout / cancel /
        // launch error / max-turns), because release() is the universal teardown. Fire-and-forget: freeing a
        // reservation is anti-waste bookkeeping and must never delay or fail a teardown — and a leak is
        // bounded by the TTL + sweep regardless (the claim always yields; it is not an integrity lock).
        if (claimHeld) {
          claimHeld = false;
          void this.claims
            .release(board, cardId, `run:${sessionId}`)
            .catch((err) => console.error(`${tag} release do claim falhou:`, err instanceof Error ? err.message : err));
        }
        if (systemPromptFile) {
          const f = systemPromptFile;
          systemPromptFile = undefined;
          void fsp.unlink(f).catch(() => {}); // best-effort; a leftover temp is harmless + gitignored
        }
      };
      // Shared teardown for a run force-released WHILE it waited for a slot — it never spawned,
      // so just journal it finished and free the slot + in-flight lock.
      const finishCancelled = () => {
        try {
          this.registry.appendLog(board, cardId, "system", "— cancelado (estava na fila)");
          // story-vbkazs: a deliberate operator cancel is NOT a failure. Record a clean finish (NO
          // RunnerFailure → never a red flag / cockpit-stuck item) and journal/emit the distinct
          // "cancelled" outcome. A queued run never spawned, so there's no telemetry row by design
          // (only the live-child settle() writes telemetry) — preserved.
          this.registry.finish(board, cardId);
          void this.journal.recordFinish(board, cardId, "cancelled", Date.now());
        } finally {
          release(); // always frees lock + slot, even if registry/journal throws
          this.pump();
        }
        this.emitComplete({ board, cardId, trigger, outcome: "cancelled" });
      };
      // Shared teardown for a run that NEVER LAUNCHED (worktree create or spawn threw). Finalize
      // the journaled run (recorded at enqueue) so it isn't re-recovered next boot; emit for
      // cascade symmetry (a non-launched run can't have advanced the card → suppressed no-op).
      const finishLaunchError = (detail: string) => {
        try {
          this.registry.finish(board, cardId, { trigger, reason: "error", at: Date.now(), detail });
          void this.journal.recordFinish(board, cardId, "error", Date.now());
        } finally {
          release();
          this.pump();
        }
        this.emitComplete({ board, cardId, trigger, outcome: "error" });
      };
      // WS-5.3 — settle a ZERO-TOKEN pre-check no-op: the in-process checks concluded there is nothing to do,
      // so we NEVER spawned a process. Record a $0 `no-op` telemetry (so the card surfaces to the HUMAN on
      // Inbox exactly like a real no-op — travado, but NOT copilot-actionable, WS-5.1) marked `pre-check`
      // in the summary, finalize the journaled run, and emit the cascade with outcome "no-op". The completion
      // re-eval carries suppressTrigger, so its loop-guard STOPS (the card never advanced) — no re-spawn, no
      // busy-loop. NOTE: `precheck:true` telemetry is APPROXIMATED via the summary string here (a first-class
      // telemetry field would touch telemetry.ts, outside this WS's file set — flagged in the report).
      const finishPrecheckNoop = (reason: string) => {
        const at = Date.now();
        try {
          this.registry.appendLog(board, cardId, "system", `⚠ pre-check (sem spawn, $0): ${reason}`);
          void this.telemetry
            .recordRun({
              id: sessionId,
              board,
              cardId,
              trigger,
              startedAt: at,
              durationMs: 0,
              turns: null,
              inputTokens: null,
              outputTokens: null,
              costUSD: 0,
              model: null,
              effort: null,
              summary: `pre-check no-op: ${reason}`,
              toolsUsed: null,
              specialistsUsed: null,
              toolGap: null,
              status: "no-op",
              advanced: false,
            })
            .catch((err) => console.error(`${tag} telemetry.recordRun (pre-check) falhou:`, err instanceof Error ? err.message : err));
          // A no-op RunnerFailure so the Processos surface + run-death diagnosis treat it EXACTLY like a real no-op.
          this.registry.finish(board, cardId, { trigger, reason: "no-op", at, detail: reason });
          void this.journal.recordFinish(board, cardId, "no-op", at);
        } finally {
          release();
          this.pump();
        }
        this.emitComplete({ board, cardId, trigger, outcome: "no-op" });
      };

      // Force-released while waiting for a concurrency slot → cancel cleanly (never spawned, no
      // worktree allocated yet).
      if (this.cancelled.delete(key)) return finishCancelled();

      // WS-5.3 — zero-token PRE-CHECK: BEFORE allocating a worktree or spawning `claude -p`, run cheap
      // in-process checks; if one CONCLUSIVELY finds nothing to do, settle as a $0 no-op with NO process.
      // CONSERVATIVE (any doubt spawns). Skipped for conflict-redrive (it re-integrates a preserved branch)
      // and for resume/recovery re-dispatches (they CONTINUE existing work, never start it). A manual "Rodar
      // agora" IS pre-checked — a $0 no-op is the right answer to re-running a card with nothing to do (the
      // incident's $0.47 capture retry / $0.99 harness-do no-op).
      if (origin !== "conflict-redrive" && !opts.resumeSessionId && !opts.existingWorktreePath) {
        const pc = await this.runPrecheck(board, cardId, trigger, origin, await cardP);
        if (pc.noop) {
          console.log(`${tag} pre-check no-op ($0, sem spawn): ${pc.reason}`);
          return finishPrecheckNoop(pc.reason ?? "nada a fazer");
        }
      }

      // CAPABILITY PREFLIGHT — prove what this step REQUIRES before paying for a process. Runs on EVERY
      // dispatch path (a resume/redrive needs its browser just as much as a fresh run), and costs ~0 when
      // the verdicts are cached. On an unresolved capability: stamp the infra DIAGNOSIS on the card and
      // settle $0 — the run that discovered the missing browser the expensive way booted a Next server and
      // seeded four favourites in an emulator first.
      const capabilityResolutions = await this.runCapabilityPreflight(board, cardId, def, await boardConfigP, await cardP);
      const unavailable = capabilityResolutions.filter((r) => r.active === null);
      if (unavailable.length) {
        const detail = unavailable.map((r) => describeUnavailable(r.capability, r.verdicts)).join(" | ");
        console.warn(`${tag} preflight de capacidade REPROVOU (sem spawn, $0): ${detail}`);
        // Best-effort card stamp — a write failure must not change the settle (the telemetry + the log
        // already carry the fact). Awaited so the operator sees the finding by the time the card settles.
        for (const r of unavailable) {
          await updateCardOnDisk(board, cardId, (card) => {
            const next = withCapabilityUnavailableFinding(
              card.findings ?? [],
              r.capability,
              def.name ?? def.id,
              describeUnavailable(r.capability, r.verdicts),
            );
            return next ? { ...card, findings: next } : null; // null → unchanged → skip the write
          }).catch((err) =>
            console.error(`${tag} carimbo de capacidade falhou:`, err instanceof Error ? err.message : err),
          );
        }
        return finishPrecheckNoop(`${CAPABILITY_BLOCKED_MARKER}: ${detail}`);
      }
      // Every required capability proved out → clear any diagnosis a previous dispatch left. This is what
      // makes the operator's fix self-healing: install the binary, and the next dispatch closes the finding
      // itself. (Skipped when nothing was required — no needless card write.)
      for (const r of capabilityResolutions) {
        await updateCardOnDisk(board, cardId, (card) => {
          const next = withCapabilityUnavailableResolved(card.findings ?? [], r.capability, {
            by: "preflight",
            at: new Date().toISOString().slice(0, 10),
          });
          return next ? { ...card, findings: next } : null; // null → nothing open → skip the write
        }).catch((err) =>
          console.error(`${tag} limpeza do finding de capacidade falhou:`, err instanceof Error ? err.message : err),
        );
      }
      // The ACTIVE provider per capability — read by the spawn assembly to swap mounts + tell the agent
      // which route is live (a degrade the run cannot see is a degrade that wastes turns).
      const capabilityChoices: ActiveProviderChoice[] = capabilityResolutions
        .filter((r): r is CapabilityResolution & { active: NonNullable<CapabilityResolution["active"]> } => r.active !== null)
        .map((r) => ({ tool: r.tool, capability: r.capability, active: r.active }));

      // WS-4.2 — RESERVE the card for this run, for EVERY run (the light lane included). Two reasons, and the
      // second is the important one:
      //   (a) anti-waste: nobody else picks a card that is already being worked;
      //   (b) it is the MITIGATION of the WS-3.4 residual risk — a light run edits the RUNTIME checkout's card
      //       by design (commitBoardDataScoped), so while it flies, the claim is what keeps the copiloto /
      //       steward / an MCP agent from writing the SAME card underneath it (last-writer-wins).
      // Scope follows the lane: isCode ⇒ `code` (card-exclusive, D8); light ⇒ `board`. TTL = this run's OWN
      // watchdog (timeoutFor): the run cannot outlive its watchdog, so the reservation cannot outlive the run —
      // no separate heartbeat is needed, and no orphan can outlast the clock that kills its process.
      // A REFUSAL means a live SESSION (or another actor) holds the card: settle a $0 no-op naming the holder
      // instead of burning a run that would only collide in the train. The card surfaces to the HUMAN on
      // Inbox (like any no-op) and the NEXT eval spawns normally once the claim is gone — a claim can
      // delay a run, never deadlock it.
      const claimTtlMs = timeoutFor(trigger, def, loadRunnerConfig());
      const acq = await this.claims
        .acquire({
          board,
          cardId,
          actor: `run:${sessionId}`,
          kind: claimKindFor(trigger),
          scope: isCode ? "code" : "board",
          ttlMs: claimTtlMs,
          note: `run ${trigger}`,
        })
        // FAIL-OPEN: if the claim registry itself is broken, RUN (a reservation store outage must never stop
        // the pipeline — the train/gates remain the real protection). Same posture as the corrupt-file read.
        .catch((err) => {
          console.error(`${tag} acquire do claim falhou — seguindo sem reserva:`, err instanceof Error ? err.message : err);
          return { ok: true as const, claim: null };
        });
      if (!acq.ok) {
        const h = acq.holder;
        const since = new Date(h.acquiredAt).toISOString().slice(11, 16);
        // The marker keeps this settle out of Case 1's idempotency rule (a claim must never wedge a card).
        const reason = `${CLAIM_REFUSED_MARKER}: card reservado por ${h.actor} (${h.kind}/${h.scope}) desde ${since} — não gastei um run que colidiria`;
        console.warn(`${tag} ${reason}`);
        return finishPrecheckNoop(reason);
      }
      claimHeld = acq.claim !== null;

      // Worktree teardown closes over the path/branch, set ONLY when isolation actually allocates
      // one (flag ON). No-op when nothing was created (flag OFF / create skipped) → safe to call on
      // every cancel/fail/settle path. Fire-and-forget; a failed remove is logged and the orphan is
      // reaped by boot recovery (recovery.ts cleanupWorktree).
      let worktreePath: string | undefined;
      let worktreeBranch: string | undefined;
      // WS3 (F2) — the step's resolved toolkit, computed once in the spawn assembly (after boardConfig)
      // and read again at settle for the capability audit's toolGap. Null until resolved / on the paths
      // that never reach the assembly (fail-open → no toolGap).
      let resolvedToolkit: ResolvedToolkit | null = null;
      // The board config the assembly resolved, re-read at settle so the toolGap can re-point its
      // classifiers at the ACTIVE provider (expectsForActiveProviders). Null on paths that never assemble.
      let boardConfigForGap: BoardConfig | null = null;
      // The sha the run's worktree was cut from (its INTEGRATION BASE — `stage` when staging is on).
      // Resolved at boundary-1 (ensureRunBase), threaded into create() and through settle into the merge
      // queue as the entry's `baseCommit`, so every diff/has-work check measures the run's OWN work, not
      // the unreleased code it inherited from `stage`. Undefined ⇒ staging off / no merge queue. (stale-base fix)
      let runBaseCommit: string | undefined;
      // SM-4 governor: true once this run's command is wrapped in a `systemd-run --scope` (a quota
      // was configured for its lane AND systemd is available). finish() reads it to classify a
      // SIGKILL as a CONTAINED OOM kill (the kernel killing the scope's cgroup on MemoryMax breach)
      // rather than a generic kill — set BEFORE the spawn so the close handler can trust it.
      let scopeApplied = false;
      // The NAMED scope this run launched into (`harness-run-<sessionId>.scope`), when one was applied —
      // persisted on the journal so recovery can stop the still-live orphan scope by name before a resume.
      let scopeUnit: string | undefined;
      // The graceful-degradation warning (quota declared but systemd absent), stashed in the launch
      // block and replayed onto the card console AFTER registry.start() resets the log buffer.
      let scopeWarning: string | undefined;
      const removeWorktree = (why: string) => {
        if (!worktreePath || !worktreeBranch) return;
        const wp = worktreePath;
        const wb = worktreeBranch;
        void this.worktreeOps
          .remove(wp, wb)
          .catch((err) =>
            console.error(`${tag} worktree cleanup (${why}) falhou:`, err instanceof Error ? err.message : err),
          );
      };

      // SM-2 success path: COMMIT the run's writes (f1), then detach the worktree dir (KEEP the
      // branch) and enqueue it on the merge train. Only reachable when a tree was created
      // (isolation ON) and a queue is wired. The commit is the missing step that made every
      // isolated run lose its work: the skill edits files in the worktree but never commits, so
      // without this the branch stays == HEAD, `git worktree remove --force` discards the diff and
      // the merge train (`--is-ancestor` true) deletes the branch + marks done — losing code AND the
      // card's status advance. An EMPTY diff (the run changed nothing) makes NO commit → fall to a
      // full remove (dir + branch), never enqueuing a no-op merge (AC3). If anything throws, fall
      // back to a full remove so a tree/branch never leaks.
      //
      // story-r0zr3s: `onResult(enqueued)` is called back once the async work completes. When
      // `enqueued=true` the caller suppresses emitComplete (the cascade fires from the merge-queue's
      // onMergeDone hook AFTER the merge-back lands on main). When `enqueued=false` (empty diff, or
      // an error) the caller emits immediately so the cascade is never permanently lost.
      const commitDetachEnqueue = (onResult: (enqueued: boolean) => void) => {
        if (!worktreePath || !worktreeBranch || !this.mergeQueue) {
          onResult(false);
          return removeWorktree("settle");
        }
        const wp = worktreePath;
        const wb = worktreeBranch;
        const mq = this.mergeQueue;
        void (async () => {
          try {
            // Sweep any changes the skill left UNcommitted into one final `usm(...)` commit. A skill
            // that makes its OWN incremental commits per task (the small-commits flow) leaves nothing
            // here → this is a no-op; the real work is already on the branch.
            // F4: stamp the run's decision (the agent's finalText, captured by the parser above) + the
            // effective spawn model/effort as git trailers, so `git log --grep` reconstructs WHAT each
            // merged run decided — not just which skill produced it.
            const message = buildRunCommitMessage(trigger, board, cardId, sessionId, {
              model: spawnModel,
              effort: spawnEffort,
              decision: lastResult?.finalText,
            });
            try {
              await this.worktreeOps.commit(wp, message);
            } catch (err) {
              // story-yy3hds: proveniência NUNCA custa o trabalho. A mensagem completa carrega texto
              // livre do agente (trailer Decision:) — se o commit dela falhar por QUALQUER razão,
              // re-tenta UMA vez com a mensagem mínima determinística (subject + Run-Id, sem
              // Decision/Model). Se ESTA também falhar (secret-scan block, index.lock, disco), o
              // catch externo PRESERVA o worktree em vez de destruí-lo.
              console.error(
                `${tag} sweep-commit falhou com a mensagem completa; re-tentando com a mínima:`,
                err instanceof Error ? err.message : err,
              );
              await this.worktreeOps.commit(wp, buildRunCommitMessage(trigger, board, cardId, sessionId));
            }
            // Enqueue iff the branch carries ANY un-integrated commit — whether from the skill's own
            // incremental commits OR the sweep above. (The old `committed`-only gate discarded a branch
            // whose work the skill had already committed itself → lost work.) Empty run (branch == HEAD)
            // → nothing to merge: drop the dir + branch, no no-op queue entry.
            // MEDE a superfície de UI ANTES do detach — aqui a árvore ainda existe. É de propósito que
            // isto seja awaited e não fire-and-forget: se a leitura corresse contra o teardown, o carimbo
            // falharia de vez em quando e o gate de QA visual voltaria a decidir pelo fallback de tipo
            // justamente nos runs em que a corrida perdesse. Um produtor intermitente é pior que nenhum:
            // esconde o buraco atrás de "às vezes funciona". Fail-open lá dentro; nunca lança.
            // Sem base de integração não há delta confiável para medir: preferimos NÃO carimbar a
            // carimbar contra a referência errada — "ninguém mediu" é honesto, um `touched: false`
            // medido contra a base errada isentaria o card do QA visual por um erro nosso.
            if (runBaseCommit) {
              await this.stampUiSurfaceEvidence({ board, cardId, worktreePath: wp, base: runBaseCommit, runId: sessionId, tag });
            }
            const hasWork = await this.worktreeOps.hasUnmergedWork(this.repoRoot, wb, runBaseCommit);
            if (!hasWork) {
              await this.worktreeOps.remove(wp, wb, runBaseCommit);
              onResult(false); // nothing to integrate → cascade fires now (no merge pending)
              return;
            }
            await this.worktreeOps.detach(wp); // remove dir, preserve the (now ahead-of-HEAD) branch for the merge
            // story-92ldyt: carry the generating skill (`trigger`) + the re-drive depth onto the entry, so
            // the merge train can RE-DRIVE this branch on a conflict (a present trigger = not ad-hoc) and a
            // re-driven branch enters the queue one `driveCount` deeper (capped by mergeTrain.maxRedrives).
            await mq.enqueueMerge({ runId: sessionId, board, cardId, branch: wb, baseCommit: runBaseCommit, trigger, driveCount: opts.driveCount });
            // A partir daqui a FILA é a dona do branch (deleta/preserva após integrar). Zerar os fechos
            // impede qualquer teardown posterior desta run (release()/removeWorktree em outro caminho de
            // settle) de "preservar" o branch AINDA NA FILA renomeando-o para failed/run/<id> — a corrida
            // que fez a integração do 94bfdb77 ler uma ref sumida como diff vazio e assentar done-vazio.
            worktreePath = undefined;
            worktreeBranch = undefined;
            onResult(true); // story-r0zr3s: enqueued → cascade fires from onMergeDone after the merge-back
          } catch (err) {
            // story-yy3hds: NUNCA mais "caindo p/ remove" — o `worktree remove --force` descartava as
            // edições NÃO-commitadas do run (o data-loss guard do remove só mede trabalho COMMITADO)
            // enquanto o run assentava "ok": trabalho destruído + zero rastro (o sucesso-fantasma do
            // run 5a3103d3). Agora a falha PRESERVA o worktree + branch para recuperação manual e fica
            // VISÍVEL em três superfícies: console do card, journal flipado p/ "error" (Processos) e
            // um finding blocker no card (Inbox) — que segura o avanço no gate hasNoBlockers e é
            // auto-resolvido se um re-run integrar com sucesso (withRunBlockersResolved).
            const detail = err instanceof Error ? err.message : String(err);
            console.error(`${tag} commit+detach+enqueue falhou — PRESERVANDO worktree + branch:`, detail);
            this.registry.appendLog(
              board,
              cardId,
              "error",
              `✗ merge-back falhou: ${detail.slice(0, 200)} — worktree preservado em ${wp} (branch ${wb}); trabalho NÃO integrado`,
            );
            void this.journal.recordFinish(board, cardId, "error", Date.now());
            void this.updateCard(board, cardId, (card) => ({
              ...card,
              findings: withMergeBackFailureFinding(card.findings ?? [], sessionId, wp, wb, detail),
            })).catch((e) =>
              console.error(`${tag} stamp do finding de merge-back falhou:`, e instanceof Error ? e.message : e),
            );
            onResult(false); // a cascade não se perde; o blocker segura o avanço no gate
          }
        })();
      };

      // ONE try around the whole LAUNCH (config load → optional worktree → flags/cmd/env → spawn).
      // Any throw funnels to the catch, which tears down a worktree if one was created and finalizes
      // the run — so a pre-spawn throw can never leak the slot/worktree as an unhandled rejection (f2).
      let child!: ChildProcess;
      let cfg!: RunnerSettings;
      // story-run-panel-richer-info: declared in the outer scope (like child/cfg) so the settle()
      // closure can read them; ASSIGNED inside the try once policyArgs resolves. A pre-spawn throw
      // leaves them null → the telemetry record simply carries model/effort = null.
      let spawnModel: string | null = null;
      let spawnEffort: string | null = null;
      try {
        cfg = loadRunnerConfig();

        // R1 worktree isolation — DEFAULT OFF (the safe default until a merge-queue exists to
        // integrate the per-run branches; see worktreeIsolation in config.ts). ON → allocate an
        // EPHEMERAL git worktree so THIS run's writes are isolated from every other concurrent run,
        // and the spawn's cwd becomes that tree (maxConcurrent > 1 stops racing on the working tree).
        // OFF → cwd = repo root and NO worktree is created or journaled — behavior IDENTICAL to the
        // pre-isolation engine. The slot is already claimed (pump incremented `running`), so holding
        // it across the create await keeps maxConcurrent honored.
        // story-apz8sa: ALSO gated on `isCode` — a worktree (and the split-train hand-off it feeds)
        // exists to isolate CODE writes. An isCode:false run only touches storymap/boards/** (path-
        // disjoint from product code), so it edits the board live on main (no checkout, no branch, no
        // merge-train entry) and commits its board-data at settle, exactly like a human at the keyboard.
        let cwd = this.repoRoot;
        if (opts.existingWorktreePath) {
          // story-watchdog RESUME path: the original run's ephemeral tree is still on disk (recovery
          // verified it). Reuse it as cwd and SKIP both the worktree create AND the HEAD=estado board
          // commit (boundary-1 ran before the original run; a fresh commit here would be a no-op at
          // best, a stale-HEAD race at worst). The branch is derivable from the (reused) sessionId, so
          // the success path can still commit + detach + enqueue the resumed work onto the merge train.
          worktreePath = opts.existingWorktreePath;
          worktreeBranch = runBranch(sessionId);
          cwd = worktreePath;
          // Journal the worktreePath NOW (pid still null), same as the create path, so boot recovery
          // can reap THIS tree if the resumed process dies in the pre-spawn window.
          void this.journal.recordStart({ board, cardId, trigger, sessionId, pid: null, startedAt: Date.now(), osBootMs: bootMs, origin, driveCount: opts.driveCount, maxTurnsResumeCount: opts.maxTurnsResumeCount, resumeFallbackCount: opts.resumeFallbackCount, worktreePath, column: opts.column, noProgressRuns: opts.noProgressRuns });
        } else if (isCode && cfg.autorun.worktreeIsolation && !opts.resumeSessionId) {
          // HEAD=estado boundary 1: commit any pending board mutations on main BEFORE creating the
          // worktree. writeCard writes the card .md to disk WITHOUT committing (working tree = the
          // live board), so a fresh worktree (a checkout of HEAD) would otherwise be born from a
          // STALE commit and the skill would read an obsolete status. A clean tree is a no-op.
          // Serialized via the per-cwd mutex (keyed by repoRoot) shared with the merge train, so a
          // concurrent merge-back never races this commit on .git/index.lock (story-ms5rmt). A failure
          // here throws into the launch try/catch → the run aborts cleanly rather than running off a
          // stale HEAD (the serializer re-raises fn's rejection to the caller).
          await this.commitSerializer(this.repoRoot, () =>
            this.worktreeOps.commitBoardState(this.repoRoot, buildBoardCommitMessage(board, cardId)),
          );
          // Resolve + sync the integration base AFTER the live board commit (so `stage` is synced with the
          // fresh main board data) and BEFORE create — then cut the run's worktree from THAT sha so the run
          // sees the unreleased code in flight. Staging off / no queue ⇒ undefined → create cuts from HEAD
          // (pre-fix behavior). ensureRunBase never throws (degrades to HEAD on a stage sync conflict). (stale-base fix)
          runBaseCommit = await this.mergeQueue?.ensureRunBase();
          const wt = await this.worktreeOps.create(this.repoRoot, sessionId, runBaseCommit);
          worktreePath = wt.worktreePath;
          worktreeBranch = wt.branch;
          cwd = worktreePath;
          // Force-released DURING worktree creation (its await is the one slow step before spawn) →
          // tear the fresh worktree down and cancel cleanly, never spawning.
          if (this.cancelled.delete(key)) {
            removeWorktree("cancelado");
            return finishCancelled();
          }
          // f4: journal the worktreePath NOW — BEFORE the spawn — so boot recovery can reap THIS
          // tree if the process dies in the create→spawn window. The post-spawn upsert below brings
          // the real pid; this intermediate write (fire-and-forget, pid still null) trades one extra
          // journal write for closing the orphaned-worktree gap.
          void this.journal.recordStart({ board, cardId, trigger, sessionId, pid: null, startedAt: Date.now(), osBootMs: bootMs, origin, driveCount: opts.driveCount, resumeFallbackCount: opts.resumeFallbackCount, resumeNote: opts.resumeNote, worktreePath, column: opts.column, noProgressRuns: opts.noProgressRuns });
        }

        // O NOME vira ENDEREÇO aqui, imediatamente antes do spawn. Falhar com a recusa que
        // nomeia a variável é o que troca o exit 127 anônimo por um erro que se conserta.
        const bin = resolvedClaudeBin({ name: cfg.autorun.claudeBin });
        // story-watchdog: a resume binds the session through `--resume <id>`, so a second `--session-id`
        // would contradict it — omit it when resuming. A fresh run keeps `--session-id` so a LATER resume
        // can find this session on disk.
        const sessionFlags = opts.resumeSessionId ? [] : ["--session-id", sessionId];
        // stream-json + verbose feed the live read-only console. SAFETY: if the installed CLI ever
        // rejects these, AGILEHARNESS_AUTORUN_NO_STREAM=1 drops them (keeping --session-id, so resume works).
        const streamFlags =
          process.env.AGILEHARNESS_AUTORUN_NO_STREAM === "1"
            ? sessionFlags
            : ["--output-format", "stream-json", "--verbose", ...sessionFlags];
        // Per-card policy (--model/--effort routed by complexity, --max-turns from the column) + the
        // global extraArgs escape hatch, on top of the permission flags this skill needs. The card was
        // read at enqueue (cardP); a successful read routes model/effort within the column ceiling
        // (resolveCardArgs), a failed/absent read falls back to the column policy (resolveColumnArgs) —
        // fail-open, so a read error never changes behavior. Each token is quoted (quoteArg) so a value
        // with a space survives the shell split.
        const card = await cardP;
        const policyArgs = card ? resolveCardArgs(card, def, cfg) : resolveColumnArgs(def, cfg);
        // story-l9mac9 — o TETO de tier deste board. Ausente (o caso de TODO board hoje) ⇒ null ⇒ o tier
        // declarado da skill, byte-idêntico ao que este spawn sempre emitiu. Só um teto DECLARADO rebaixa,
        // e quando rebaixa, aparece no log: mudança silenciosa de permissão é o que não pode existir.
        const tierCap = resolveTierCap(process.env, board);
        const effectiveTier = capTier(tierOf(trigger), tierCap);
        if (effectiveTier !== tierOf(trigger)) {
          console.log(`${tag} tier: ${tierOf(trigger)} → ${effectiveTier} (teto declarado para o board ${board})`);
        }
        // ── F0: A POSTURA DE AUTONOMIA (ADR-067) ───────────────────────────────────────────────────
        // Onde antes se emitia `--dangerously-skip-permissions` + `IS_SANDBOX=1`, agora se resolve uma
        // POSTURA. Só o tier `full` é afetado — os demais nunca carregaram a flag. O `writeRoot` é o
        // worktree do run quando a skill toca CÓDIGO, e a árvore de dados do board quando não toca —
        // ver a nota no campo, que explica por que "o cwd" era a resposta errada.
        let escapeHatchNeedsRootBypass = false;
        // A postura vive numa função NOMEADA por superfície (`resolveEnginePosture`), que recebe só o
        // que o engine sabe e deriva o resto. Um revisor mediu por que: com os argumentos escritos aqui,
        // trocar `{ isCode, cwd }` por `{ isCode: true, cwd }` fazia o writeRoot das 5 skills não-code
        // virar a RAIZ do repositório, e a suíte COMPLETA não via. O que se testa passou a ser o VALOR
        // que a função devolve, não o texto deste call-site.
        const posture = resolveEnginePosture({ tier: effectiveTier, trigger, isCode, cwd, key: sessionId });
        // A tradução postura → flags vive em buildSpawnFlags (PURA, testada). Ela existe porque um
        // revisor provou que, com a montagem inline, remover o `--settings` do array passava por 2704
        // testes com o log ainda dizendo "sandbox: bubblewrap". Agora a presença da contenção no comando
        // é asserção, não leitura.
        if (posture.kind === "sandboxed") {
          console.log(
            // Lê o `writeRoot` DA POSTURA — o mesmo valor que foi para o settings. Antes imprimia o
            // `cwd`, que para run não-code é a raiz do repositório e NÃO o que foi concedido: o log
            // anunciava um envelope diferente do real. E o gitdir só existe quando há worktree.
            `${tag} sandbox: ${posture.mechanism}${posture.weakerNested ? " (modo weaker)" : ""} ` +
              `— escrita liberada para ${posture.writeRoot} (mais $TMPDIR${isCode ? " e o gitdir do worktree" : ""})`,
          );
          // O envelope de um run de CÓDIGO sem worktree é o repositório INTEIRO — inclusive o código do
          // próprio harness. É uma configuração legítima (quem desliga o isolamento pediu por isso), mas
          // não pode ser silenciosa: é a diferença entre a contenção que a documentação promete e a que
          // este run tem.
          if (isCode && !cfg.autorun.worktreeIsolation) {
            console.error(
              `${tag} ⚠ worktreeIsolation DESLIGADO: a escrita liberada é o REPOSITÓRIO INTEIRO ` +
                `(${posture.writeRoot}), não a árvore de um run. O sandbox ainda impede sair do repositório, ` +
                `mas dentro dele o run alcança o código do próprio harness. Ligue autorun.worktreeIsolation ` +
                `no settings.yaml para o envelope que a documentação descreve.`,
            );
          }
        } else if (posture.kind === "unsandboxed-escape") {
          console.error(`${tag} ⚠ ${posture.warn}`);
        } else if (posture.kind === "refused") {
          // Fail-CLOSED: melhor um run que não começa do que um run sem fronteira nenhuma.
          console.error(`${tag} run RECUSADO: ${posture.reason}`);
          throw new Error(`autonomia sem contencao recusada: ${posture.reason}`);
        } else if (posture.kind === "downgraded" && posture.warn) {
          console.error(`${tag} ⚠ ${posture.warn}`);
        }
        // O tier REAL deste spawn: o rebaixamento da postura (sandbox indisponível) vence o teto de board.
        const tierDoSpawn = posture.kind === "downgraded" ? posture.tier : effectiveTier;
        const spawnFlags = buildSpawnFlags({
          posture,
          permissionArgs: permissionArgsForTier(tierDoSpawn),
          streamFlags,
          policyArgs,
          extraArgs: cfg.autorun.extraArgs,
        });
        const flags = spawnFlags.flags;
        escapeHatchNeedsRootBypass =
          spawnFlags.needsRootBypass && process.platform !== "win32" && process.getuid?.() === 0;

        // story-run-panel-richer-info: capture the EFFECTIVE model/effort this run spawns with (parsed
        // from the resolved policy flags) so the telemetry records the agent that ACTUALLY ran — accurate
        // even after the column policy later changes. settle()/recordRun read these via closure.
        const _miIdx = policyArgs.indexOf("--model");
        const _efIdx = policyArgs.indexOf("--effort");
        spawnModel = _miIdx >= 0 ? policyArgs[_miIdx + 1] ?? null : null;
        spawnEffort = _efIdx >= 0 ? policyArgs[_efIdx + 1] ?? null : null;
        // SM-09: derive the per-app context note from the board config read at enqueue. A null config
        // (read failure) or a board without `package:` yields a null note → omitted silently (AC4).
        // Carried on BOTH the fresh and the resumed spawn so a revived run reads app conventions too.
        const boardConfig = await boardConfigP;
        // WS3 (F2) — resolve the step's declarative toolkit against the board's toolConfigs, then emit its
        // MCP mounts + any hard allowedTools allow-list. columnFlags no longer emits the mcp flags — they
        // come from here, EXISTENCE-FILTERED against the spawn `cwd` (repo root, or the run's worktree when
        // isolated): a mount that isn't on disk (a fresh consumer install with no graph yet) is OMITTED +
        // warned, NEVER breaking the spawn. Absorbs the legacy `mcpConfig` as sugar, so a legacy-only step
        // mounts exactly as before. Stored on the closure so settle can compute the capability toolGap.
        resolvedToolkit = resolveToolkit(def, boardConfig, board, this.repoRoot);
        boardConfigForGap = boardConfig;
        // WS4 — warn on any specialist whose agent slug is off-charset (dropped from the delegation note by
        // buildToolkitNote's SAFE_SLUG filter). Advisory only — a bad slug never breaks the spawn.
        for (const s of resolvedToolkit.specialists) {
          if (!SAFE_SLUG.test(s.agent)) {
            console.warn(`${tag} specialist "${s.id}" tem agent slug fora de charset — omitido da nota: ${s.agent}`);
          }
        }
        // DEGRADE — when the preflight elected a FALLBACK provider, mount that one instead of the primary.
        // Order matters: the swap happens BEFORE the existence filter, so a fallback mount is checked on
        // disk like any other, and the dead primary's mount is gone rather than mounted-but-useless.
        const declaredMounts = applyActiveProviders(
          resolvedToolkit.mcpConfigPaths,
          capabilityChoices,
          boardConfig?.toolConfigs,
          board,
          this.repoRoot,
        );
        const mcpMounts = declaredMounts.filter((p) => {
          if (existsSync(path.resolve(cwd, p))) return true;
          console.warn(`${tag} mcp-config ausente — omitido do spawn: ${p}`);
          return false;
        });
        flags.push(...toolkitFlags(mcpMounts, resolvedToolkit.allowedTools));
        // As SKILLS DA FERRAMENTA. O CLI as descobre subindo do `cwd`, e o `cwd` daqui é o repositório
        // do USUÁRIO — o lugar certo para o filho editar, e o lugar errado para achar `/usm-*` quando a
        // ferramenta mora noutra árvore. Enquanto as duas coincidem isto devolve vazio e o comando fica
        // byte-idêntico; quando divergem, sem esta linha o filho é despachado com uma skill que não
        // existe. Ver `toolTreeFlags` — inclusive por que `--add-dir` é a única saída e o que ela custa.
        flags.push(...toolTreeFlags(findToolRoot(), cwd));
        // dual-track OST (Fatia 4): resolve the idea the story `addresses` OUTSIDE the pure
        // buildContextNote (which stays shell-safe — it takes only the slug id, never the Card whose
        // statement carries quotes/`$`/newlines). Read the pool ONLY when the card actually addresses
        // something (rare) so the hot spawn path — and its deterministic test timing — stays untouched for
        // the 99% of cards with no `addresses` edge. Fail-open to [] → getAddressedIdea → null → no clause.
        const addressedOpp =
          card && card.links?.some(isAddressesLink)
            ? getAddressedIdea(card, await this.readBoardCards(board).catch(() => []))
            : null;
        // story-personas-as-prompt: pass the card's persona + system ids + board slug so the note points
        // the run at WHO it serves and WHAT it touches (the agent reads the rich prompts from board.yaml).
        // card may be null (read failure) → ids undefined → buildContextNote omits the clauses (fail-open).
        const contextNote = buildContextNote(boardConfig, {
          board,
          personaIds: card?.personas,
          systemIds: card?.systems,
          addressedIdeaId: addressedOpp?.id ?? null,
        });
        // story-harness-cc #1 + #3: assemble the SYSTEM-PROMPT body (the persistent per-app/persona/brand
        // contextNote + the per-skill non-negotiable invariants) and pass it via --append-system-prompt-file
        // instead of concatenating it into the `-p` user prompt. WHY: (a) the system prompt is re-emitted
        // every turn and SURVIVES the compaction that summarizes a long run's first user-turn (where the
        // note used to live); (b) a FILE sidesteps shell-escaping the note's literal backticks/`$` under
        // shell:true. Fail-open: empty body → no file/flag (byte-for-byte the legacy command). On a write
        // error OR the AGILEHARNESS_AUTORUN_SYSTEM_PROMPT_FILE=0 knob, fall back to the legacy INLINE note (still
        // supported by buildPrompt) so a CLI flag regression can never strand runs.
        // story-harness-adk A1: inline a deterministic state snapshot (status/mode/open questions/tasks)
        // read fresh from the card at enqueue, so the run sees its canonical checkpoint VERBATIM (the ADK
        // {current_step}/{pending_signals}) without depending on it RE-READING the card.md. File-only,
        // like the per-skill invariants; the legacy inline fallback (knob OFF / write error) carries only
        // contextNote. card may be null (read failure) → snapshot null → omitted (fail-open).
        const stateSnapshot = buildStateSnapshot(card);
        // G5: the distilled hand-off from the PREVIOUS step (telemetry summary, read at enqueue) — a HINT,
        // not a constraint. G6: the distilled reasoning of the DEAD session when this is a missing-session
        // FRESH re-dispatch (opts.resumeNote). Both are free-form prose that may carry shell metacharacters,
        // so they ride the system-prompt FILE only — never the inline `-p` fallback below.
        const handoff = await handoffP;
        const handoffNote = handoff
          ? `Contexto do passo anterior — o run \`${handoff.trigger}\` concluiu${handoff.age ? ` (${handoff.age})` : ""}: ${handoff.summary}. Trate como PISTA do que já foi feito (não como restrição); se o card tiver evidência nova, ela prevalece.`
          : null;
        const resumeNote = opts.resumeNote
          ? `A sessão anterior deste passo foi interrompida e perdida. Ela havia concluído/raciocinado: ${opts.resumeNote.trim()}. Use como PISTA para não refazer becos já descartados; reconfira o estado real no card e no código antes de agir.`
          : null;
        // WS-2.2: a conflict-redrive run carries the PRESERVED branch with the prior attempt's code. Tell the
        // fresh agent to REUSE it (cherry-pick/inspect) — the conflict was in INTEGRATION, not necessarily the
        // code — instead of re-implementing from scratch (the story-qb8z2c ~$13 loop). File-only prose (like
        // handoff/resume): the branch name is a safe slug but this never rides the shell-safe inline fallback.
        const redriveNote = opts.preservedBranch
          ? `Este run é um RE-DRIVE após conflito de INTEGRAÇÃO (não necessariamente do código). JÁ EXISTE uma implementação anterior preservada no branch \`${opts.preservedBranch}\`. ANTES de re-implementar do zero: inspecione-a (\`git log ${opts.preservedBranch}\`, \`git show ${opts.preservedBranch}\`) e REAPROVEITE o que servir (\`git cherry-pick <sha>\` desse branch, ou aplique o diff e re-teste). Re-implementar do zero desperdiça o trabalho já feito — foi exatamente o loop caro do story-qb8z2c.`
          : null;
        // WS3 (F2): the step's toolkit guidance rides the compaction-proof FILE body (not the inline
        // fallback — it's authored config text). Fail-open: null when the step has no toolkit → the body
        // stays byte-identical to the legacy prompt file.
        const toolkitNote = buildToolkitNote(resolvedToolkit);
        // D13 (canal 1) — the style-guide pointer note: a SEPARATE part from contextNote (see
        // buildStyleGuideNote's doc comment for why it isn't folded into buildContextNote). File-only,
        // like toolkitNote — never rides the shell-safe inline fallback below (keeps that fallback
        // byte-identical for every board, guide or not; the note is a pointer, not an invariant).
        const styleGuideNote = buildStyleGuideNote(board, boardConfig);
        // The DEGRADE clause: which provider is live per required capability. File-only (like toolkitNote)
        // and null on the 99% path where every primary won, so the prompt is byte-identical when nothing
        // was swapped. Placed next to toolkitNote — it qualifies the same tool surface.
        const capabilityNote = buildCapabilityNote(capabilityChoices);
        const sysPromptBody = composeSystemPrompt(contextNote, handoffNote, resumeNote, redriveNote, stateSnapshot, toolkitNote, capabilityNote, styleGuideNote, systemPromptFor(trigger));
        // G8: the inline fallback (knob OFF / write error) used to carry ONLY contextNote, silently
        // dropping the A1 state checkpoint AND the per-skill invariants (fix-the-app / scope) on exactly
        // the runs that most need them (incl. a crash-recovered resume, which reuses inlineNote). Compose
        // a SHELL-SAFE fallback body instead: contextNote (regex-guarded) + a shell-safe snapshot (counts,
        // no free-form question text) + the per-skill invariants (plain prose, no shell metacharacters).
        const inlineFallbackBody = composeSystemPrompt(
          contextNote,
          buildStateSnapshot(card, { shellSafe: true }),
          systemPromptFor(trigger),
        );
        let inlineNote: string | null = null;
        if (sysPromptBody && process.env.AGILEHARNESS_AUTORUN_SYSTEM_PROMPT_FILE !== "0") {
          try {
            // SYNC write (tiny file, once per run): keeps the spawn in the SAME tick — an extra async I/O
            // await here would defer the spawn past the test harness's flush() AND needlessly yield the loop.
            const dir = runnerStateDir();
            mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `system-prompt-${sessionId}.txt`);
            writeFileSync(file, sysPromptBody, "utf8");
            systemPromptFile = file; // tracked → release() unlinks it on teardown
            flags.push("--append-system-prompt-file", file);
          } catch (err) {
            console.warn(`${tag} system-prompt file write falhou — fallback inline:`, err instanceof Error ? err.message : err);
            // G8: surface the degradation on the card console — this run carries the shell-safe inline body
            // (no rich snapshot question text), so the operator knows why a long run might drift.
            this.registry.appendLog(board, cardId, "system", "⚠ system-prompt em arquivo falhou — fallback inline (invariantes + checkpoint reduzido, sem texto de pergunta)");
            systemPromptFile = undefined;
            inlineNote = inlineFallbackBody;
          }
        } else if (sysPromptBody) {
          inlineNote = inlineFallbackBody; // knob OFF → shell-safe inline body (contextNote + snapshot-safe + invariants)
        }
        // shell:true so the OS shell resolves `claude` (incl. the .cmd shim on Windows) from PATH.
        // story-watchdog: a resume spawns `claude --resume <id>` (rehydrating the crashed session)
        // instead of a fresh `-p` run — see buildResumeCommand.
        const cmd = opts.resumeSessionId
          ? buildResumeCommand(bin, commandForTrigger(trigger), key, sessionId, flags, inlineNote)
          : buildClaudeCommand(bin, commandForTrigger(trigger), key, flags, inlineNote);
        // ── A CAMADA FAIL-OPEN SAIU AQUI (2026-08-05) ───────────────────────────────────────────
        // Existia um segundo sandbox (`runner/sandbox.ts` + `scripts/ops/harness-run-sandbox.sh`) que
        // remontava node_modules e o store do bun como read-only. Ele saiu junto com o pouso do F0, e
        // o motivo não é redundância: os DOIS CONTRATOS ERAM OPOSTOS. Aquele declarava por escrito
        // "must never, by itself, fail a run" (fail-OPEN); este emite `failIfUnavailable: true` e
        // RECUSA (fail-CLOSED). Duas camadas que discordam sobre o que fazer quando não conseguem
        // proteger é a garantia de que um dia alguém confia na errada — e a errada é sempre a que
        // deixa passar. Risco da remoção, medido: ZERO. O flag nascia `enabled: false`, nenhum board o
        // ligava, e `AGILEHARNESS_AUTORUN_SANDBOX` estava ausente do ambiente do serviço em produção.
        const cmdToScope = cmd;
        // SM-4 governor: wrap the run in a `systemd-run --scope` (MemoryMax/CPUQuota for this lane)
        // so the kernel enforces the resource ceiling the scheduler admitted under. No-op when the
        // lane has no quota or systemd is absent — then the run launches exactly as before (graceful
        // degradation), but we warn loudly when a quota WAS declared yet couldn't be enforced.
        const laneQuota = cfg.autorun.scheduler.lanes[lane];
        // Name the scope after THIS run's sessionId + a per-invocation NONCE so (a) a crash leaves an
        // addressable cgroup (recovery stops it by the EXACT name recorded on the journal before
        // resuming the session — the un-strand fix) AND (b) a RESUMED step never reuses the previous
        // step's scope name — the reuse that let one step's teardown SIGKILL the next and mis-record
        // it as "oom-killed" (story-olr777). The unique name is persisted verbatim (recordStart `unit`).
        const wrapped = wrapWithScope(cmdToScope, laneQuota.memoryMax, laneQuota.cpuQuota, this.systemdCheck(), runScopeUnit(sessionId, newScopeNonce()));
        scopeApplied = wrapped.applied;
        scopeUnit = wrapped.unit;
        if (!scopeApplied && (laneQuota.memoryMax || laneQuota.cpuQuota)) {
          const warn = `systemd-run indisponível — rodando SEM isolamento de recursos (quota da lane ${lane} declarada, não aplicada)`;
          console.warn(`${tag} ${warn}`);
          // Surface on the card console too — but ONLY after registry.start() below, which RESETS this
          // card's log buffer; appending here would be wiped. Stash it and replay it post-start.
          scopeWarning = `⚠ ${warn}`;
        }
        const finalCmd = wrapped.cmd;
        // ── O ÚLTIMO PORTÃO (ADR-067) ──────────────────────────────────────────────────────────────
        // A contenção que a postura prometeu — e que o log já anunciou lá em cima — está no comando que
        // vai de fato rodar? Verificado AQUI, sobre `finalCmd`, depois de todo wrap (scope, sandbox
        // estrutural): é o último ponto em que ainda se sabe o que será executado. Entre
        // `buildSpawnFlags` e esta linha há ~240 linhas, dois `flags.push(...)` e dois wrappers.
        //
        // Por que uma checagem de PRODUÇÃO e não mais um teste: um revisor matou esta fase duas vezes com
        // a MESMA mutação deslocada uma linha por vez (espalhar `postureArgs` fora do array; depois
        // filtrar `--settings` do retorno), e nas duas a suíte inteira — 7027 testes — ficou verde,
        // porque os guardas eram regex sobre a fonte. Um teste afirma que o código está certo hoje; isto
        // faz o sistema RECUSAR-SE a rodar sem a fronteira que ele mesmo prometeu. Impedir, não detectar.
        console.log(`${tag} launching (cwd=${cwd})${scopeApplied ? " [scoped]" : ""}: ${finalCmd}`);
        // Env SANEADO (spawn-env.ts): sem node_modules/.bin no PATH (C1), sem __NEXT_*/NODE_ENV do
        // serviço (o __NEXT_PROCESSED_ENV herdado fazia `next build` dentro de runs pular os .env).
        const baseEnv: NodeJS.ProcessEnv = sanitizeSpawnEnv(process.env);
        // F0 (ADR-067): `IS_SANDBOX=1` MORREU como default. Onde havia o bypass da trava de root, agora há
        // a fronteira do SO — resolvida acima em `posture` e materializada como `--settings <arquivo>`.
        // O bypass só sobrevive dentro da válvula explícita, que já gritou no log quando foi acionada.
        if (escapeHatchNeedsRootBypass) baseEnv.IS_SANDBOX = "1";
        // story-u4qb3f — ISOLAMENTO DE REDE: capacidade OPT-IN nascendo DESLIGADA (a régua do OpenClaw, que
        // entrega `sandbox.mode` com default off). Ausente ⇒ nada acontece, nem uma chave a mais no env do
        // filho. Declarada ⇒ a allowlist viaja para o filho E o processo grita UMA vez que ela NÃO está
        // sendo aplicada por ninguém: o que este controle impede é o operador acreditar que tem isolamento
        // de saída quando não tem. Um knob honesto e inerte é melhor que um sandbox não testado dizendo que isola.
        const egress = resolveEgressDeclaration(process.env);
        if (egress) baseEnv.AGILEHARNESS_EGRESS_ALLOW = egress.allow.join(",");
        // Business-intent guard (story-ns8x0o): inject the run's identity into every spawn
        // so the guard-business-intent hook can discriminate autorun runs from human sessions.
        // The hook blocks on AGILEHARNESS_AUTORUN_RUN_ID present; a human in the notebook has none.
        baseEnv.AGILEHARNESS_AUTORUN_RUN_ID = sessionId;
        baseEnv.AGILEHARNESS_AUTORUN_TRIGGER = trigger;
        // ── ONDE A FERRAMENTA MORA, dito ao filho ────────────────────────────────────────────────
        // O run é cortado num worktree do ALVO, então tudo que ele resolve por caminho relativo cai no
        // repositório do USUÁRIO. Enquanto a ferramenta morava dentro dele, `packages/storymap-ui/…`
        // era caminho válido para as duas coisas; desde a inversão não é mais — e as skills que chamam
        // `scripts/advance-card.ts` ficariam sem endereço, o que CONGELA o card na coluna (medido:
        // nenhum caminho do engine avança card por conta própria; quem avança é esse script).
        //
        // Não é variável nova: `findToolPackageDir()` já a LÊ e a VALIDA pelo marcador `name` do
        // package.json, e um valor errado falha ALTO (ToolRootUnresolvedError) em vez de virar um `cd`
        // para o lugar errado. Aqui só a DECLARAMOS para quem não pode derivá-la — o filho não tem o
        // `import.meta.url` desta árvore. `sanitizeSpawnEnv` é denylist, então ela viaja sozinha.
        baseEnv.AGILEHARNESS_TOOL_ROOT = findToolPackageDir();
        // As chaves acima entraram DEPOIS do chokepoint; a ponte de nomes precisa vê-las — é o marcador de
        // run (`AGILEHARNESS_AUTORUN_RUN_ID`) que o hook do alvo ainda lê como `STORYMAP_AUTORUN_RUN_ID`.
        resolverAliasesDeEnv(baseEnv as Record<string, string | undefined>);
        // ADR-063 Fase 4c: hand the read-only mount plan to the sandbox wrapper script (only set when the
        // sandbox was actually applied above — otherwise the script isn't in the command and these are inert).
        // Headroom proxy injection (story-5m0r3n; cobertura total em 2026-07-28). Resolution order:
        //   1. opts.headroomUrl — caller resolved it from board.yaml + ENV via resolveHeadroomUrl
        //      (the cascade dispatcher / manual actions, which already hold the BoardConfig).
        //   2. ENV/default via resolveHeadroomUrl — para chamadores sem board config em escopo.
        // Hoje o default é LIGADO (headroom.ts): um caller que não passe URL ainda roteia. O que
        // desliga é `board.yaml headroom.enabled:false` ou AGILEHARNESS_HEADROOM_URL=off.
        // A broken sidecar is auto-bypassed (passthrough) — a run NEVER blocks on it.
        const headroom = await applyHeadroomEnv(baseEnv, {
          url: opts.headroomUrl ?? resolveHeadroomUrl(null, process.env),
        });
        if (headroom.url) {
          if (headroom.applied) {
            console.log(`${tag} headroom: ON (proxy=${headroom.url})`);
            this.registry.appendLog(board, cardId, "system", `▸ headroom proxy ativo: ${headroom.url}`);
          } else {
            console.warn(`${tag} headroom configurado em ${headroom.url} mas offline — passthrough`);
            this.registry.appendLog(board, cardId, "system", `⚠ headroom offline em ${headroom.url} — usando API direto`);
          }
        }
        const env = baseEnv;
        // cwd = this run's isolated worktree when isolation is ON, else the shared repo root.
        // story-#30: `detached` on POSIX makes the shell + its `claude` grandchild a PROCESS GROUP
        // (leader = shell pid), so killTree can signal the negative pid and take the grandchild down
        // with it instead of orphaning it. NOT on Windows (taskkill /T already tree-kills; detached
        // there spawns a new console). Under systemd the children stay in the unit's cgroup, so a
        // service restart still kills them (KillMode=control-group) — no restart-survival regression.
        // ── VERIFICA E SPAWNA NA MESMA EXPRESSÃO (ver spawnContidoCmd) ──────────────────────────
        // O `assertContainmentReachedCommand` avulso que existia ~50 linhas acima foi ABSORVIDO aqui.
        // Um revisor mediu o custo daquela distância: trocar `finalCmd` por
        // `finalCmd.replace(/ --settings [^ ]+/, "")` nesta chamada passava em 7167 de 7167 provas —
        // o portão verificava um valor e o processo executava outro.
        child = spawnContidoCmd(posture, finalCmd, (verificado) =>
          this.spawnProcess(verificado, {
            cwd,
            shell: true,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            env,
          }),
          // O argv0 RESOLVIDO ancora o corte da invocação dentro de `finalCmd`. Sem ele o portão
          // procurava um token chamado `claude` — e reprovava um run legítimo sempre que o operador
          // rodasse um binário com outro nome.
          bin,
        );
      } catch (err) {
        // config-load / worktree-create / spawn all funnel here → tear down any worktree + finalize.
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`${tag} launch failed:`, detail);
        removeWorktree("launch-fail");
        return finishLaunchError(detail);
      }

      const startedAt = Date.now();
      this.registry.start(board, cardId, trigger, startedAt, sessionId);
      // Replay the governor's degradation warning now that start() has reset the log buffer.
      if (scopeWarning) this.registry.appendLog(board, cardId, "system", scopeWarning);
      this.children.set(key, child); // tracked so forceRelease can kill a hung run
      this.forceKilled.delete(key); // defensive: a fresh run starts un-force-killed (no stale marker)
      this.cancelledKills.delete(key); // story-vbkazs: a fresh run starts un-cancelled (no stale marker)

      // Upsert the journal entry (created at enqueue) with the REAL pid + the worktree path (present
      // only when isolation is ON), so boot recovery can reap an orphaned tree if THIS process dies.
      void this.journal.recordStart({ board, cardId, trigger, sessionId, pid: child.pid ?? null, startedAt, osBootMs: bootMs, origin, driveCount: opts.driveCount, maxTurnsResumeCount: opts.maxTurnsResumeCount, resumeFallbackCount: opts.resumeFallbackCount, worktreePath, unit: scopeUnit, column: opts.column, noProgressRuns: opts.noProgressRuns });

      // Watchdog: kill a stuck run so it can't hold a concurrency slot forever. ALWAYS armed
      // now (timeoutFor never returns null) — code skills without costGuard/doMs fall back to
      // the generous universal ceiling instead of running unbounded. The kill triggers
      // `close` → finish.
      const timeoutMs = timeoutFor(trigger, def, cfg);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        console.error(`${tag} TIMEOUT após ${Math.round(timeoutMs / 1000)}s — encerrando processo travado`);
        void this.killTree(child); // fire-and-forget: `timedOut` already flags this as our kill
      }, timeoutMs);
      // A watchdog must never, by itself, keep the event loop alive — the long-running dev
      // server holds it up while real runs are in flight, and unref() also stops a
      // never-closing child (unit tests) from leaking the now-always-created timer. Node's
      // Timeout has unref(); under the DOM lib typings setTimeout is typed `number`, so guard it.
      (timer as unknown as { unref?: () => void }).unref?.();

      // story-1mxmqy: set when the spawned `claude --resume` reports its session is gone — the ONLY
      // signal the CLI gives (an stderr/stdout line, then exit 1). finish() reads it to fall back to a
      // fresh dispatch (resumeFallback). Only meaningful on a resume run; a fresh run never sets it.
      let resumeMissingSession = false;
      const scanForMissingSession = (text: string) => {
        if (opts.resumeSessionId && !resumeMissingSession && RESUME_SESSION_MISSING_RE.test(text)) {
          resumeMissingSession = true;
        }
      };
      // story-9s52tu HALF B: set when the terminal `result` event reports the run stopped at the
      // `--max-turns` cap (subtype error_max_turns). finish() reads it to PRESERVE the worktree+branch
      // and mark the run RESUMABLE (the partial task commits survive) instead of force-deleting it like
      // a genuine code error. Only the stream-json result event carries this signal.
      let hitMaxTurns = false;
      // story-harness-cc #4: the structured tail of the run (agent's final message + stop subtype +
      // cost/turns), captured from the terminal `result` event and threaded onto RunCompletion — a
      // first-class return channel complementing the did-the-card-advance-on-disk inference. undefined
      // when the run dies before any result (kill/OOM/timeout).
      let lastResult: RunResult | undefined;
      // The distinct tools this run invoked — accumulated IN-STREAM from the assistant tool_use blocks
      // (so it survives the events.jsonl ring-buffer cap and a crash-before-result). Threaded into
      // telemetry at settle → the step-history "capacidades" markers (graphify/browser/subagents/server).
      const toolsUsed = new Set<string>();
      // WS4 — the specialist agent slugs the run delegated to (Task subagent_type), accumulated in parallel
      // to toolsUsed → durable telemetry. Closes the expected×used loop for specialists.
      const specialistsUsed = new Set<string>();
      // Parse the stream-json stdout into human console frames (registry → SSE).
      const parser = createNdjsonParser((obj) => {
        const s = summarizeStreamEvent(obj);
        if (s) this.registry.appendLog(board, cardId, s.level, s.text);
        for (const name of extractToolNames(obj)) toolsUsed.add(name);
        for (const slug of extractSpecialistDelegations(obj)) specialistsUsed.add(slug);
        // The terminal `result` event carries the run's cost/tokens → surface them live.
        const usage = extractResultUsage(obj);
        if (usage) this.registry.setUsage(board, cardId, usage);
        // …and, when it is a max-turns stop, the resumability signal.
        if (isMaxTurnsResult(obj)) hitMaxTurns = true;
        // story-harness-cc #4: capture the agent's own final message + stop subtype, and surface a trimmed
        // finalText on the card console (the run panel) so the operator SEES why a run stopped — instead of
        // only inferring it from whether the status moved on disk (the sucesso/falha-fantasma guards).
        const fr = extractFinalResult(obj);
        if (fr) {
          lastResult = fr;
          if (fr.finalText) {
            const preview = fr.finalText.length > 280 ? `${fr.finalText.slice(0, 280)}…` : fr.finalText;
            this.registry.appendLog(board, cardId, "result", `▸ resultado do agente: ${preview}`);
          }
        }
      });
      child.stdout?.on("data", (d) => {
        const text = String(d);
        scanForMissingSession(text); // the resume error can surface on stdout under stream-json
        parser.feed(text);
      });
      child.stderr?.on("data", (d) => {
        const text = String(d);
        scanForMissingSession(text); // …and (the observed path) on stderr before the CLI exits 1
        process.stderr.write(`${tag} ${text}`);
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim();
          if (t) this.registry.appendLog(board, cardId, "error", t);
        }
      });

      // Guard: `close` and `error` can both fire — settle exactly once.
      let settled = false;
      // Settle the run exactly once: closing console line, registry, journal, slot
      // release, cascade continuation. Synchronous — the clean-exit path runs it inline.
      const settle = (
        failure: { reason: RunnerFailure["reason"]; detail: string } | undefined,
        outcome: RunOutcome,
        code: number | null,
        note?: string,
        // story-9s52tu HALF B: a max-turns stop is RESUMABLE — the run's ephemeral worktree + branch
        // are PRESERVED (not torn down) carrying the partial task commits, and the journal entry is
        // marked resumable (kept "running", NOT flipped to done) so boot recovery resumes it via
        // `claude --resume`. Set ONLY by the max-turns branch (a genuine error never sets it → its
        // tree is force-deleted as before). Always paired with outcome "max-turns" + no `failure`.
        resumable?: boolean,
      ) => {
        // story-r0zr3s: when the run is enqueued on the merge train, suppress emitComplete here —
        // the cascade fires from onMergeDone AFTER the merge-back lands on main (so evaluateAutorunOnEntry
        // reads the new column, not the stale pre-merge-back status). For empty-diff / error / non-isolated
        // paths, the callback fires emitComplete immediately (same behaviour as before).
        let emitDeferred = false;
        try {
          // WS2 — capture the run's CONTENT advance for the ledger BEFORE the teardown below removes the
          // worktree. Read the post-run status SYNCHRONOUSLY from the run's WORKTREE when isolated (where the
          // skill advanced the card; main only gets it at merge-back), else from main. A change from the
          // pre-run status is this run's own advance (e.g. desenvolver→revisar-codigo) attributed to
          // run:<trigger>; the merge-back records the structural train hops separately (disjoint from/to →
          // no double-count). Sync read = no race with the async teardown; fail-open (unreadable → no record).
          const afterForLedger = readCardStatusFromTreeSync(worktreePath ?? this.repoRoot, board, cardId);
          void beforeStatusP.then((before) => {
            if (before && afterForLedger && before !== afterForLedger) {
              void appendTransition({ board, cardId, from: before, to: afterForLedger, actor: `run:${trigger}`, runId: sessionId });
            }
          });
          // story-1mxmqy: a clean (non-failure) settle clears this card's resume-fallback budget, so a
          // much-later transient missing-session starts fresh instead of inheriting a stale tally.
          if (!failure) this.resumeFallbackCount.delete(key);
          // Closing console line (covers killed runs that emit no `result` event). A
          // suppressed falha-fantasma shows a ⚠ warning, not a ✗ failure.
          this.registry.appendLog(
            board,
            cardId,
            note ? "system" : failure ? "error" : "system",
            note ? `⚠ ${note}` : failure ? `✗ ${failure.detail ?? failure.reason}` : `— encerrado (exit ${code ?? 0})`,
          );
          this.registry.finish(board, cardId, failure && { trigger, at: Date.now(), ...failure });
          // Journal + emit keep the REAL outcome (forense) even when the failure is suppressed.
          // story-9s52tu HALF B: a RESUMABLE max-turns stop does NOT flip the entry to "done" — it
          // stays "running" + resumable so loadInterrupted picks it up and recovery `--resume`s it
          // (mirroring a crash-interrupted run). Every other outcome records a normal finish.
          if (resumable) void this.journal.markResumable(board, cardId, Date.now());
          else void this.journal.recordFinish(board, cardId, outcome, Date.now());
          // story-observabilidade-runs-telemetria: persist ONE telemetry record per settled run (any
          // outcome) — the durable forensic twin of the registry's in-memory usage. The usage comes
          // from the registry (fed by the `result` event); a run killed before that event leaves the
          // token/turn/cost fields null while `status` still reflects the real outcome. Fire-and-forget:
          // telemetry I/O must NEVER hold the concurrency slot or throw into the child `close` handler.
          const usage = this.registry.getUsage(board, cardId);
          // A QA dogfood run brings up a local dev server (`bun run qa-dev`) whose PID file the engine
          // reaps below — a Bash subprocess, invisible as a tool NAME, so stamp a synthetic capability
          // token when the file exists NOW (settle runs before the reap that clears it).
          if (existsSync(devServerPidFile(sessionId))) toolsUsed.add("local-dev-server");
          // WS3 (F2) — the capability toolGap: expected-level toolConfigs whose match found no evidence in
          // toolsUsed. Computed HERE (toolsUsed finalized, resolvedToolkit in closure) → persisted on the
          // run's OWN telemetry record (zero race) AND threaded onto the completion event so the capability
          // audit can stamp the SOFT finding. Empty when the step has no expectation / all were met.
          // The classifiers are re-pointed at the provider that was actually LIVE (expectsForActiveProviders):
          // when a fallback won, the primary's `match` would find nothing and stamp a false "provisioned but
          // unused" advisory on every card — the exact false anomaly computeToolGap is written to avoid.
          const toolGap =
            resolvedToolkit && resolvedToolkit.expects.length
              ? computeToolGap(
                  expectsForActiveProviders(resolvedToolkit.expects, capabilityChoices, boardConfigForGap?.toolConfigs),
                  Array.from(toolsUsed),
                )
              : [];
          void this.telemetry
            .recordRun({
              id: sessionId,
              board,
              cardId,
              trigger,
              startedAt,
              durationMs: Date.now() - startedAt,
              turns: usage?.numTurns ?? null,
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
              costUSD: usage?.costUSD ?? null,
              model: spawnModel,
              effort: spawnEffort,
              // F4: the run's decision, collapsed to one line — was captured for the console then thrown
              // away; now durable so the card document's `## Histórico` shows it. Null when no result event.
              summary: summarizeFinalText(lastResult?.finalText),
              // The run's tool usage (sorted, deduped) → step-history capability markers. Null when empty.
              toolsUsed: toolsUsed.size ? Array.from(toolsUsed).sort() : null,
              // WS4 — the specialist agents the run delegated to (Task subagent_type), INTERSECTED with the
              // step's DECLARED specialists (resolvedToolkit.specialists agent slugs) so the expected×used
              // loop stays honest: a harness-do impl sub-agent (backend/frontend, NOT a registered specialist)
              // no longer pollutes the field (review CONFIRMED). Sorted+deduped; null when none. NOTE (v1):
              // an UNUSED declared specialist is NOT stamped as a finding — specialists are CONDITIONAL, so
              // non-use is expected (unlike an expected tool). Observability only.
              specialistsUsed: (() => {
                const declared = new Set((resolvedToolkit?.specialists ?? []).map((s) => s.agent));
                const used = Array.from(specialistsUsed).filter((slug) => declared.has(slug)).sort();
                return used.length ? used : null;
              })(),
              // WS3 (F2) — capability gap (expected-but-unused), durable aggregate signal. Null when none.
              toolGap: toolGap.length ? toolGap : null,
              status: outcome,
              // story-mzpzb0: SUCESSO-COM-AVISO durável. Quando o card avançou apesar da saída suja, o
              // settle já SUPRIMIU o RunnerFailure (falha-fantasma) mas grava o outcome de morte cru aqui.
              // Derivado dos dois sinais que já temos (sem novo parâmetro): sem failure + outcome de morte.
              // Deixa o Inbox separar isto de uma falha real (mesmo `status`) via isStuckCardMetric.
              advanced: isSuccessWithWarning(!!failure, outcome),
            })
            .catch((err) =>
              console.error(`${tag} telemetry.recordRun falhou:`, err instanceof Error ? err.message : err),
            );
          // Worktree teardown. SM-2 + f1: when an ISOLATED run SUCCEEDED (no failure — clean exit OR a
          // suppressed falha-fantasma where the card advanced), COMMIT its writes onto the run branch,
          // then detach the dir (keeping the branch) and hand it to the merge train, which integrates
          // it into main and owns deleting it after (a diff-vazio commits nothing → full remove, no
          // enqueue). Every other path (real failure, isolation OFF, no queue) tears the whole tree +
          // branch down as before. Fire-and-forget: the slot frees immediately below (git I/O must NOT
          // hold maxConcurrent); a failed commit/detach/remove is logged and reaped by recovery.
          // story-vbkazs: a "cancelled" run has NO failure but its work is INCOMPLETE — it must NOT be
          // committed/enqueued onto the merge train (that would integrate a half-done worktree and, via
          // the dep-graph's outcome==="ok" check, could green-light downstream). Tear its worktree down
          // like a failure path, even though it carries no RunnerFailure.
          if (resumable) {
            // story-9s52tu HALF B: a RESUMABLE max-turns stop — PRESERVE the worktree dir + its
            // `run/<id>` branch exactly as they are (do NOT detach, do NOT remove, do NOT enqueue).
            // The partial task commits live on the branch and the tree stays on disk, so the in-process
            // resume below (and boot recovery, which keeps every resumable run's tree in its keep-set)
            // `--resume`s the SAME session IN it, continuing from where the turn budget ran out.
            //
            // story-9s52tu HALF B (HIGH #1 — root fix): SUPPRESS the generic cascade re-fire for THIS
            // path. The card never advanced (only the not-advanced case reaches here), so the trailing
            // emitComplete would re-evaluate the unchanged trigger column and — once the 30s lastSpawnAt
            // dedupe expires — spawn a FRESH from-scratch run whose recordStart OVERWRITES this resumable
            // journal entry, orphaning the preserved tree (the resume then never happens outside the boot
            // window). Instead we defer the cascade and LIVE re-dispatch the SAME skill in-process with
            // --resume (see the trailing resume block after `finally`). emitDeferred makes the generic
            // emitComplete a no-op for this run ONLY (every normal completion still cascades).
            emitDeferred = true;
            // The light lane reaches here with NO tree — say what actually happened rather than claiming a
            // preservation that didn't occur (an untrue log is how a reader learns the wrong model).
            console.warn(
              worktreePath && worktreeBranch
                ? `${tag} max-turns — preservando worktree + branch; re-dispatch in-process c/ --resume (run ${sessionId})`
                : `${tag} max-turns — run sem worktree (lane light); re-dispatch in-process c/ --resume (run ${sessionId})`,
            );
          } else if (!failure && outcome !== "cancelled" && worktreePath && worktreeBranch && this.mergeQueue) {
            emitDeferred = true;
            commitDetachEnqueue((enqueued) => {
              // story-r0zr3s: if NOT enqueued (empty diff or error), emit cascade now.
              // If enqueued, cascade fires from onMergeDone after the merge-back.
              if (!enqueued) this.emitComplete({ board, cardId, trigger, outcome, result: lastResult, toolGap });
            });
          } else if (!failure && outcome !== "cancelled" && !isCode) {
            // story-apz8sa: a SUCCESSFUL board-data run (isCode:false) has no worktree — the skill wrote
            // the card .md straight onto main but writeCard never commits (the working tree IS the live
            // board "database"). Sweep that edit into one `board:`-prefixed commit on main via the SAME
            // per-cwd serializer the merge train uses, so a concurrent merge-back / another board-data run
            // never races us on .git/index.lock (keyed by repoRoot → distinct cwds stay parallel). This is
            // the no-worktree mirror of the isolated path's commit+detach+enqueue: it mutates the live
            // board exactly like a human at the keyboard, with NO branch and NO merge-train entry.
            //
            // FIX 1 (durability): after the commit lands, PUSH it to origin via the SAME robust path the
            // merge train uses (commitBoardStateAndPush → pushHeadToOrigin: cumulative `git push origin
            // HEAD`, reconcile/merge on non-fast-forward, FAIL-OPEN). Prod runs worktreeIsolation=TRUE, so
            // pre-apz8sa a board-data run reached origin via worktree→merge-train→push; now it commits
            // local-only — without this push the edit would be invisible to other checkouts until the next
            // CODE run's merge-back swept + pushed it. The push runs INSIDE this serializer continuation so
            // it stays ordered with the commit (no index race) and FAILS OPEN (a push outage never crashes).
            // FIX 2 (blast radius): commitBoardStateAndPush stages ONLY `storymap/boards/**` (scoped
            // pathspec, NOT `git add -A`) and ABORTS if the staged diff touches code — a stray code edit on
            // the shared main tree can never ride this `board:` commit.
            //
            // commitBoardStateAndPush empty-diff-guards (clean board delta → no no-op commit, no push) and
            // runs the fail-closed secret scan. Fire-and-forget (the slot frees in `finally` below — git I/O
            // must NOT hold maxConcurrent); the cascade is DEFERRED until the commit+push settles so the next
            // column read is post-commit (a `.finally` fires emitComplete whether the commit lands or the
            // secret scan/guard rejects — a board edit is never lost, only delayed to the next code run's
            // boundary-1 sweep).
            // Auditoria 2026-08-19 — o PUSH é declarado, o commit não. Este settle é o outro caminho
            // (além do flush debounced) que empurra board-data para o `origin` de quem instalou a
            // ferramenta; a mesma régua vale nos dois, senão desligar o push na interface deixaria a
            // porta aberta pelo run. Sem a declaração, versiona local — e o próximo merge-back de um
            // run de CÓDIGO leva tudo junto, porque `git push` é cumulativo.
            emitDeferred = true;
            const empurrarBoard = boardDataAutoPushAllowed();
            void this.commitSerializer(this.repoRoot, () =>
              empurrarBoard
                ? this.worktreeOps.commitBoardStateAndPush(this.repoRoot, buildBoardCommitMessage(board, cardId))
                : this.worktreeOps.commitBoardState(this.repoRoot, buildBoardCommitMessage(board, cardId)),
            )
              .catch((err) =>
                console.error(`${tag} board-data commit (settle) falhou:`, err instanceof Error ? err.message : err),
              )
              .finally(() =>
                this.emitComplete({ board, cardId, trigger, outcome, result: lastResult, toolGap }),
              );
          } else {
            removeWorktree("settle");
          }
        } catch (err) {
          // story-ll5zt3: swallow teardown exceptions so they never escape the child `close`
          // event handler (an uncaught throw there crashes the process). Lock + slot still
          // free via finally regardless.
          console.error(
            `[harness-engine] erro no teardown do run ${board}/${cardId} (lock liberado de qualquer forma):`,
            err instanceof Error ? err.message : err,
          );
        } finally {
          // story-ll5zt3: always free the lock + slot, even if registry/journal/worktree throws.
          this.children.delete(key); // drop the (now-dead) child handle
          this.forceKilled.delete(key); // story-#30: clear the our-kill marker for this settled run
          this.cancelledKills.delete(key); // story-vbkazs: clear the deliberate-cancel marker
          // story-koieb3 (dogfood process isolation): reap the run's ENTIRE cgroup scope at every settle
          // (clean exit / failure / forced release). killTree only signals the spawn's process GROUP — a
          // grandchild the AGENT detached (setsid/nohup/disown), e.g. the dogfood QA dev server, escapes
          // that and would leak past teardown, keeping the scope's cgroup alive (the orphan-dev-server
          // symptom). stopRunScope is GUARDED by isRunScopeUnit → it can NEVER target storymap.service or a
          // slice, and is a harmless exit-5 no-op on an already-collected scope. Fire-and-forget (NOT
          // awaited — the slot is freed below; this must never hold maxConcurrent) and only when a scope was
          // actually applied (systemd present + a lane quota). By SCOPE, never by PID (the koieb3 root fix).
          if (scopeApplied && scopeUnit) {
            void this.stopScope(scopeUnit).catch((e) =>
              console.error(`${tag} stopRunScope no settle falhou:`, e instanceof Error ? e.message : e),
            );
          }
          // story-koieb3 hardening (EDGE 3): no-systemd fallback. ALWAYS reap the run's recorded QA
          // dev-server PID (a no-op when no file exists — most runs). This is the ONLY teardown when
          // systemd is absent (no scope to stop) and a complement when scoped. Signals ONLY the exact
          // pid qa-dev-server wrote → can never hit 3008 or a sibling. Fire-and-forget (must not hold
          // the slot); never throws (the reaper swallows everything internally).
          void this.reapDevServer(sessionId)
            .then((r) => {
              // A guarda de atribuição do reaper (dev-server.ts) RECUSA quando o PID gravado não confere
              // com um dev server — o caso que a contenção cria, porque o número foi gravado dentro de um
              // PID namespace e aqui é lido no host. Recusar é o certo; recusar em SILÊNCIO não é: seria
              // indistinguível de "não havia o que matar", e um dia esconderia um vazamento real.
              if (r.reason === "pid-nao-confere" || r.reason === "pid-ausente" || r.reason === "bad-pid") {
                console.warn(`${tag} reaper do dev server NÃO agiu (${r.reason}, pid=${r.pid ?? "?"}) — o cgroup do scope segue responsável pelo teardown`);
              }
            })
            .catch((e) => console.error(`${tag} reapDevServerPid no settle falhou:`, e instanceof Error ? e.message : e));
          release();
          this.pump();
        }
        // story-9s52tu HALF B (HIGH #1 — root fix): a RESUMABLE max-turns settle LIVE re-dispatches the
        // SAME skill IN-PROCESS with `--resume` + the preserved worktree, so the partial work is actually
        // continued in steady state (not only in the boot-restart window). The in-flight lock + slot are
        // now free (released in `finally` above), so runSkill can re-claim them; it goes through the
        // NORMAL lane/scheduler admission (no bypass of resource limits) and journals under the SAME
        // sessionId so `claude --resume` rehydrates the transcript. NO dedupe window is passed: the
        // original spawn stamped lastSpawnAt at spawn time, so a windowed re-dispatch would be rejected as
        // a "cooldown" repeat — the busy-loop is bounded instead by the MONOTONIC resume counter (the
        // not-advanced settle escalates to a failure once it would reach maxTurnsResumeMax, so this can
        // never re-dispatch unboundedly). A rejected re-dispatch (rate-limit / in-flight race) leaves the
        // resumable journal entry "running" → boot recovery picks it up later (counter intact). Ordered
        // AFTER the cascade-emit guard so it is the ONLY follow-up for the preserved path (emitDeferred is
        // set, so the generic emitComplete above did NOT fire — no fresh-from-scratch spawn can race it).
        // NOTE: NOT gated on `worktreePath`. A light-lane run has no tree by design, and requiring one here
        // was the second half of the same defect as the settle guard above — the resumable entry would be
        // journaled and then never re-dispatched. `--resume` rehydrates from the session id alone; the tree
        // (when there is one) is only carried so the code lane continues in the SAME checkout.
        if (resumable) {
          const nextCount = (opts.maxTurnsResumeCount ?? 0) + 1;
          const re = this.runSkill(board, cardId, trigger, def, {
            resumeSessionId: sessionId,
            existingWorktreePath: worktreePath ?? undefined,
            maxTurnsResumeCount: nextCount,
            // story-harness-cc HALF #5: carry the missing-session fallback budget forward UNCHANGED across a
            // max-turns resume (this is not a fallback) so it stays monotonic/durable for the whole card.
            resumeFallbackCount: opts.resumeFallbackCount,
            origin,
            headroomUrl: opts.headroomUrl,
            driveCount: opts.driveCount,
            // ADR-063 (4b): a max-turns resume is the SAME logical cascade attempt — carry the loop-guard
            // column + no-progress counter FORWARD unchanged (the shell owns the increment, never the engine).
            column: opts.column,
            noProgressRuns: opts.noProgressRuns,
          });
          if (!re.ok) {
            // The resume couldn't claim a slot now (rate-limited / a racing run took the lock). The
            // journal entry stays "running" + resumable, so boot recovery (or the next settle of the
            // racing run) resumes it later with the counter intact — never stranded as a fresh run.
            console.warn(`${tag} resume in-process recusado: ${re.reason}${re.detail ? ` (${re.detail})` : ""} — fica p/ a recovery`);
            this.registry.appendLog(board, cardId, "system", `↻ resume in-process adiado: ${re.reason} — retomável no próximo boot`);
          }
        }
        // CONTINUE the cascade: the in-flight lock is now free, so a listener can spawn
        // the next skill for this card if the run advanced it into another autorun column.
        // story-r0zr3s: suppress for enqueued runs — their cascade fires from onMergeDone.
        if (!emitDeferred) this.emitComplete({ board, cardId, trigger, outcome, result: lastResult });
      };
      // story-1mxmqy: settle a missing-session resume WITHOUT recording a failure, then re-dispatch the
      // column's skill FRESH (new session id, re-issued prompt). The fresh run carries no resumeSessionId,
      // so it can never re-enter this branch; the per-card cap (resumeFallbackCount/resumeFallbackMax)
      // bounds it further so a session store that keeps dropping sessions can't churn forever. `attempt`
      // is the 1-based fallback count (for the operator-facing log).
      const resumeFallback = (attempt: number) => {
        try {
          this.registry.appendLog(
            board,
            cardId,
            "system",
            `↻ sessão de resume inexistente — re-disparando fresco (${attempt}/${resumeFallbackMax()})`,
          );
          this.registry.finish(board, cardId); // clean finish: this attempt never really ran (no failure surfaced)
          void this.journal.recordFinish(board, cardId, "exit", Date.now()); // forensic: the resume attempt DID exit 1
        } catch (err) {
          console.error(`${tag} resumeFallback teardown falhou:`, err instanceof Error ? err.message : err);
        } finally {
          removeWorktree("resume-fallback"); // drop the reused/empty tree (no-op when none was allocated)
          release(); // free the in-flight lock + slot so the fresh dispatch can claim them
          this.pump();
        }
        // Re-dispatch FRESH — no resumeSessionId / existingWorktreePath. Inherits origin/headroom/driveCount.
        // story-harness-cc HALF #5: journal the incremented fallback count (`attempt`) onto the fresh run so
        // the budget SURVIVES a restart — if this fresh run later becomes a resume that goes missing again,
        // boot recovery re-injects it and the cap still bites (it no longer resets to 0 on every boot).
        const re = this.runSkill(board, cardId, trigger, def, {
          origin,
          headroomUrl: opts.headroomUrl,
          driveCount: opts.driveCount,
          resumeFallbackCount: attempt,
          // story-harness-adk G6: carry the DEAD session's distilled reasoning into the fresh run so it
          // isn't thrown away — the lost transcript can't be resumed, but its conclusion can be a hint.
          resumeNote: summarizeFinalText(lastResult?.finalText) ?? undefined,
          // ADR-063 (4b): a missing-session FRESH re-dispatch is still the SAME logical cascade attempt (the
          // card never left its column, the shell never re-evaluated) — carry the loop-guard fields forward
          // UNCHANGED so the counter neither resets nor double-increments across this internal re-dispatch.
          column: opts.column,
          noProgressRuns: opts.noProgressRuns,
        });
        if (!re.ok) {
          console.warn(`${tag} re-dispatch fresco recusado: ${re.reason}`);
          this.registry.appendLog(
            board,
            cardId,
            "error",
            `✗ re-dispatch fresco recusado: ${re.reason}${re.detail ? ` (${re.detail})` : ""}`,
          );
          this.registry.finish(board, cardId, { trigger, reason: "exit", at: Date.now(), detail: `resume-fallback recusado: ${re.reason}` });
          this.emitComplete({ board, cardId, trigger, outcome: "exit", result: lastResult });
        }
      };
      const finish = (code: number | null, errDetail?: string, signal?: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parser.flush();
        // SM-4 governor: an OOM kill inside a SCOPED run is the kernel's cgroup OOM killer enforcing
        // MemoryMax — contained to this run's scope, so it's a distinct "oom-killed" outcome (not a
        // generic kill). It reaches us in TWO shapes: `signal === "SIGKILL"` (the leader is SIGKILL'd
        // and Node reports the signal directly) OR — the shape that actually fires on the VPS —
        // `code === 137` (128 + SIGKILL=9): the scope leader (the `claude` binary that dash exec-opts
        // into from `sh -c "… -- claude …"`) is SIGKILL'd and systemd-run/the shell relays it as an
        // exit code with signal=null. We deliberately do NOT match 143 (128+SIGTERM): killTree (both
        // the watchdog timeout AND forceRelease) sends ONLY SIGTERM, so 143/SIGTERM is OUR kill, not
        // the kernel's, and conflating them would mislabel a forced release as OOM. The `scopeApplied`
        // gate excludes unscoped runs; `!timedOut`/`!errDetail` exclude our own teardown. Without a
        // scope the heuristic is off → falls through to "exit".
        // story-#30: killTree now ESCALATES to SIGKILL (exit 137) when claude ignores SIGTERM, so a
        // force-released run can ALSO surface as 137 — exclude it via `forceKilled` so OUR kill is
        // never mislabeled as the kernel's OOM (same intent as the `!timedOut` guard for the watchdog).
        // story-olr777: the OTHER historical false-OOM — a PREVIOUS step's scope teardown SIGKILLing
        // THIS step after a scope-NAME collision — is now prevented at the source (scope names are
        // unique per invocation via newScopeNonce, and stopRunScope refuses to SIGKILL a scope whose
        // InvocationID changed during its grace). So a scoped SIGKILL/137 not in our sets is a GENUINE
        // cgroup OOM (MemoryMax breach), which is what the `oom-killed` label below now truthfully means.
        const wasForceKilled = this.forceKilled.has(key);
        // story-vbkazs: a DELIBERATE operator cancel (forceRelease added the key to cancelledKills) is
        // its own terminal outcome, NOT a failure. Preempt the timeout/OOM/exit cascade and settle as a
        // NON-failure cancel: NO RunnerFailure (so no red badge / no cockpit-stuck) but outcome
        // "cancelled" so the journal + telemetry record it distinctly and the console shows a neutral ⚠
        // line. A watchdog TIMEOUT (sets `timedOut`, not cancelledKills) and an OOM 137 (neither set)
        // are untouched by this branch — they keep their own outcomes. Ordered FIRST so the deliberate
        // intent wins over the generic killed/exit classification below.
        // PRECEDENCE (story-vbkazs review): a concurrent watchdog TIMEOUT WINS over a deliberate cancel
        // (`&& !timedOut`) — a run the watchdog already flagged as stuck keeps its honest `timeout`
        // outcome even if the operator clicked cancel in the same window, so a hanging skill is never
        // hidden behind a clean-looking cancel in the forensics. Cancel only relabels an otherwise-OK run.
        if (this.cancelledKills.has(key) && !timedOut) {
          console.log(`${tag} cancelado pelo operador (exit ${code}${signal ? `, signal ${signal}` : ""})`);
          return settle(undefined, "cancelled", code, "cancelado pelo operador");
        }
        const isOomKill =
          !timedOut && !errDetail && !wasForceKilled && scopeApplied && (signal === "SIGKILL" || code === 137);
        // A non-null signal means the process was KILLED (external taskkill/kill, OOM) — a
        // failure, not a clean exit. Without this, code===null + signal would map to "ok". An OOM
        // kill is carved out above into its own reason, so exclude it from the generic "killed".
        const killed = !timedOut && !errDetail && signal != null && !isOomKill;
        const failure = timedOut
          ? { reason: "timeout" as const, detail: `sem resposta em ${Math.round(timeoutMs / 1000)}s` }
          : errDetail
            ? { reason: "error" as const, detail: errDetail }
            : isOomKill
              ? { reason: "oom-killed" as const, detail: `OOM kill no scope — MemoryMax excedido (${signal ?? `exit ${code}`})` }
              : (code && code !== 0) || killed
                ? { reason: "exit" as const, detail: killed ? `morto (${signal})` : `exit ${code}` }
                : undefined;
        const outcome: RunOutcome = timedOut
          ? "timeout"
          : errDetail
            ? "error"
            : isOomKill
              ? "oom-killed"
              : (code && code !== 0) || killed
                ? "exit"
                : "ok";
        console.log(`${tag} finished (exit ${code}${signal ? `, signal ${signal}` : ""})${timedOut ? " [TIMEOUT]" : ""}`);

        // story-1mxmqy: a non-clean exit whose ONLY cause is a missing claude session ("No conversation
        // found with session ID") is the session having expired/been wiped — NOT a real failure. Re-
        // dispatch the column's skill FRESH instead of stranding the card. Gated on (a) this being a
        // resume run, (b) the specific CLI signature, and (c) a per-card retry budget, so a genuine
        // exit-1 from real work is untouched and a session store that keeps losing sessions can't loop.
        if (failure && opts.resumeSessionId && resumeMissingSession) {
          // story-harness-cc HALF #5: baseline the per-card budget from the JOURNALED count (carried in
          // opts by boot recovery / a prior fresh re-dispatch) when present, falling back to the in-process
          // Map — so a server restart (which wipes the Map) can't reset the budget to 0 and let a chronic
          // missing-session loop churn fresh dispatches forever.
          const used = opts.resumeFallbackCount ?? this.resumeFallbackCount.get(key) ?? 0;
          const max = resumeFallbackMax();
          if (used < max) {
            this.resumeFallbackCount.set(key, used + 1);
            console.warn(`${tag} resume sem sessão (${opts.resumeSessionId}) — fallback fresco ${used + 1}/${max}`);
            return resumeFallback(used + 1);
          }
          // Budget exhausted: stop auto-retrying and let it settle as a REAL failure (operator decides).
          // Drop the counter so a later MANUAL re-run starts with a fresh budget.
          this.resumeFallbackCount.delete(key);
          console.warn(`${tag} resume sem sessão (${opts.resumeSessionId}) — teto de ${max} fallbacks atingido; falhando p/ o operador`);
          this.registry.appendLog(board, cardId, "error", `✗ resume sem sessão e teto de ${max} re-dispatches atingido — requer operador`);
          // fall through to the normal failure settle below
        }

        // story-9s52tu HALF B: a stop whose cause is the `--max-turns` cap (the stream-json result subtype
        // error_max_turns) is RESUMABLE, NOT a code error — the run made partial progress and `claude
        // --resume` continues from where it stopped. Mirror the falha-fantasma guard's advance check: if
        // the card ADVANCED during the run the work landed → let the normal success-with-warning path
        // commit+enqueue it (no resume needed); only the NOT-advanced case (still mid-build) preserves any
        // tree + marks the run resumable. A genuine error never enters here → force-deleted as before.
        //
        // TWO GUARDS REMOVED (2026-07-18 — acme/story-tlz0dt burned $2.35 and settled as "✓ concluído"):
        //  - `failure &&` — the classification ladder above reads ONLY the exit code, so a max-turns stop
        //    that exits 0 produced `outcome: "ok"` with no failure, skipping this branch entirely. That is
        //    how a run that stopped mid-thought — having written NOTHING to the card — was recorded as an
        //    unqualified success: absent from failures[], from the stuck lane, from the step rollup, from
        //    findings. The only trace was an ephemeral `✗ error_max_turns` console frame printed directly
        //    above a `✓ concluído` that contradicted it. `hitMaxTurns` was known here all along and simply
        //    was not consulted; the CLI's exit code is not the authority on WHY the model stopped.
        //  - `worktreePath && worktreeBranch` — structurally FALSE for every `isCode:false` skill, since
        //    worktrees are allocated only for the code lane. So the entire max-turns mechanism — resume AND
        //    the cap escalation — was unreachable for the ~93% of runs that are light-lane. The guard read
        //    "no tree ⇒ nothing to resume into", conflating "no CODE to preserve" with "no SESSION to
        //    resume": `claude --resume` needs the session id, never a tree. This is the same shape as the
        //    steward deadlock — recovery gated behind an artifact the case it recovers can never present.
        // The kill-flag exclusions below stay: they are what keep a stale max-turns event from hijacking a
        // genuine timeout/OOM/cancel.
        //
        // GUARD ORDERING (review): a max-turns RESUMABLE stop is SPECIFICALLY a clean cap exit (the CLI
        // exited non-zero at the budget) — NOT a run we/the kernel KILLED. So exclude `timedOut` (watchdog
        // SIGTERM), `isOomKill` (kernel cgroup OOM), `wasForceKilled` (operator/escalation SIGKILL) and
        // `killed` (external signal): a stale `error_max_turns` event emitted BEFORE such a kill must NEVER
        // hijack a genuine timeout/OOM/cancel into the resumable path — those keep their own outcomes
        // (AC3). The vbkazs cancel guard already settled above (returns before here), so a cancel can't
        // reach this branch at all; these flags belt-and-suspender the timeout/OOM/external-kill cases.
        if (hitMaxTurns && !timedOut && !isOomKill && !wasForceKilled && !killed) {
          void (async () => {
            const before = await beforeStatusP;
            const after = await this.readCardStatus(board, cardId, worktreePath ?? undefined).catch(() => null);
            if (before && after && before !== after) {
              // The card advanced INSIDE the worktree → the work is complete enough to integrate; the
              // normal falha-fantasma success-with-warning path commits + enqueues it (no resume).
              const note = `max-turns — card avançou ${before} → ${after}; sucesso-com-aviso`;
              console.warn(`${tag} ${note}`);
              return settle(undefined, outcome, code, note);
            }
            // story-9s52tu HALF B (HIGH #2): the card did NOT advance (still mid-build). Decide between
            // PRESERVE+RESUME and ESCALATE by the MONOTONIC resume counter (carried on the journal entry,
            // survived this run's recordStart) vs the cap. The cap is NOT reset each cycle, so a card that
            // exhausts its turn budget every resume without progressing escalates instead of looping.
            const resumeCount = opts.maxTurnsResumeCount ?? 0;
            const cap = maxTurnsResumeMax();
            if (resumeCount >= cap) {
              // Chronically stuck → a GENUINE failure for the operator. Force-delete the preserved tree
              // (no more resumes will reuse it → it must not leak as an orphan) and settle as a real
              // "error" failure: a RunnerFailure surfaces it on the cockpit (failures[]), the journal
              // flips to done (NOT resumable → boot recovery won't pick it up), and the distinct detail
              // names the cap so the operator sees WHY it stopped. The settle's normal teardown runs the
              // removeWorktree("settle") branch (failure ⇒ not preserved, not enqueued).
              const note = `max-turns atingido ${resumeCount}× (teto ${cap}) — card travado, escalando p/ o operador`;
              console.error(`${tag} ${note}`);
              this.registry.appendLog(board, cardId, "error", `✗ ${note}`);
              return settle({ reason: "error", detail: note }, "error", code);
            }
            // Under the cap → PRESERVE worktree + branch and mark RESUMABLE. NO RunnerFailure (it's
            // recoverable, not a hard failure → stays out of failures[]); the distinct "max-turns" outcome
            // + resumable flag drive the journal/recovery resume path. settle() then LIVE re-dispatches the
            // SAME skill in-process with --resume (resumeCount+1), so the preserved tree is actually USED
            // in steady state — not only in the boot-restart window.
            const note = `max-turns atingido (resume ${resumeCount + 1}/${cap}) — preservado p/ resume (\`claude --resume\`)`;
            console.warn(`${tag} ${note}`);
            settle(undefined, "max-turns", code, note, true);
          })();
          return;
        }

        // Clean exit (code 0, no signal/timeout/error). For most skills this is success — settle
        // synchronously, no disk read.
        if (!failure) {
          // Guard de artefatos de código (C2/O3.5, ny4v26): para uma skill que DEVE produzir código
          // (harness-do), uma saída limpa cujo worktree não mudou NADA fora de storymap/boards/ é um
          // sucesso-fantasma de build — o "trabalho" é só o flip do card. Reclassifica como no-op
          // ANTES do teardown: a falha aparece (re-disparável) e o teardown preserva o branch flip-only
          // como failed/* SEM mergear — o card fica em `desenvolver` no main, onde o trabalho deveria
          // ter acontecido. Fail-open em QUALQUER erro de git/leitura (nunca inventa falha) e OFF sem
          // worktree/base/changedPaths (isolation desligada ou ops sem o método).
          if (REQUIRES_CODE_ARTIFACTS_SKILLS.has(trigger) && worktreePath && runBaseCommit && this.worktreeOps.changedPaths) {
            const wp = worktreePath;
            const rbc = runBaseCommit;
            const listChanged = this.worktreeOps.changedPaths.bind(this.worktreeOps);
            void (async () => {
              let codeChanges: string[] | null = null;
              try {
                const changed = await listChanged(wp, rbc);
                codeChanges = changed.filter((p) => !p.startsWith("storymap/boards/"));
              } catch {
                codeChanges = null; // fail-open: erro de git → trata como sucesso normal
              }
              if (codeChanges !== null && codeChanges.length === 0) {
                // WS-5.2 (colisão #4 / story-uae2ag): "nenhum artefato NESTE run" ≠ "nada entregue". Se o
                // delta esperado do card JÁ ESTÁ na base deste run (aterrissou num run anterior, depois
                // superado por um redrive), não reimplementar foi o comportamento CORRETO — é avanço, não
                // no-op. Só uma PROVA POSITIVA por conteúdo (deltaLanded === landed) abre esta porta; ela
                // carimba a build-evidence (o gate destrava) e o run assenta como sucesso-com-aviso. Qualquer
                // outro veredito cai no caminho de sempre — o sucesso-fantasma REAL continua sendo pego.
                const landed = await this.stampBuildEvidenceIfLanded({
                  board,
                  cardId,
                  card: await cardP,
                  target: rbc,
                  runId: sessionId,
                  tag,
                });
                if (landed) {
                  console.warn(`${tag} ${landed}`);
                  settle(undefined, outcome, code, landed);
                  return;
                }
                const note = "saída limpa mas o run não produziu NENHUM artefato de código (só storymap/boards/) — sucesso-fantasma de build (C2/O3.5)";
                console.warn(`${tag} ${note}`);
                settle({ reason: "no-op", detail: note }, "no-op", code);
                return;
              }
              settle(undefined, outcome, code);
            })();
            return;
          }
          // Sucesso-fantasma guard (o espelho do falha-fantasma abaixo): para uma skill que SEMPRE
          // avança o card no sucesso (advancesOnSuccess), uma saída LIMPA que deixou o card na MESMA
          // coluna-trigger é um no-op — a skill alegou sucesso sem fazer nada. Sem isto, o card encalha
          // invisível: nenhuma falha é registrada (não aparece em failures[]) e o dedupe do autorun
          // bloqueia o re-disparo. Reclassificamos como falha "no-op" para que apareça e seja
          // re-disparável manualmente (não auto-retry: um no-op determinístico entraria em loop).
          if (!ADVANCE_ON_SUCCESS_SKILLS.has(trigger)) return settle(undefined, outcome, code); // hot path
          void (async () => {
            const before = await beforeStatusP;
            // Lê o status pós-run do WORKTREE quando isolado (onde o avanço acontece antes do merge-back),
            // igual ao guard falha-fantasma. Fail-open: status ilegível (null) → trata como sucesso (não
            // inventa falha a partir de um erro de leitura), idêntico ao engine pré-fix.
            const after = await this.readCardStatus(board, cardId, worktreePath ?? undefined).catch(() => null);
            if (!before || !after || before !== after) return settle(undefined, outcome, code); // avançou (ou ilegível) → sucesso real
            const note = `saída limpa mas o card não avançou de ${before} — sucesso-fantasma (no-op)`;
            console.warn(`${tag} ${note}`);
            settle({ reason: "no-op", detail: note }, "no-op", code);
          })();
          return;
        }

        // Falha-fantasma guard (async): the process exited non-clean, but if the card
        // ADVANCED during the run (status changed away from where it started), the skill
        // DID land its work → treat as success-with-warning (log + skip the failure),
        // for ANY reason. Only a card that did NOT advance is a real failure.
        void (async () => {
          const before = await beforeStatusP;
          // Read the post-run status from the WORKTREE (where an isolated run advances the card) — main
          // only gets the advance at the merge-back, so reading it here would miss a worktree-local
          // advance and mis-fire the failure (force-deleting the branch + its work). Falls back to main
          // when no worktree (isolation off) → behaviour identical to the pre-fix engine.
          const after = await this.readCardStatus(board, cardId, worktreePath ?? undefined).catch(() => null);
          if (before && after && before !== after) {
            const note = `${failure.reason} (${failure.detail}) — card avançou ${before} → ${after}; sucesso-com-aviso`;
            console.warn(`${tag} ${note}`);
            return settle(undefined, outcome, code, note);
          }
          settle(failure, outcome, code);
        })();
      };
      child.on("close", (code, signal) => finish(code, undefined, signal));
      child.on("error", (err) => {
        console.error(`${tag} error:`, err.message);
        finish(null, err.message);
      });
    };

    (lane === "heavy" ? this.heavyQueue : this.lightQueue).push(start);
    (lane === "heavy" ? this.heavyQueueKeys : this.lightQueueKeys).push(key); // parallel to the queue
    this.pump();
    return { ok: true };
  }

  /**
   * The single dependency-aware enqueue entry point (story-mcp-enfileiramento-lote-dependencias).
   * The MCP `enqueue`/`enqueue_batch` tools, autorun and scripts all funnel through here so the SAME
   * engine (in-flight lock + lanes + worktree isolation) governs every caller (AC4 — no duplicated
   * allocation path).
   *
   * `deps` are "board/cardId" predecessors. A dep is "alive" if it is currently in-flight OR itself
   * blocked in the graph; a dep that is neither has already settled, so it no longer gates this card.
   * When NO alive deps remain, the card runs immediately via {@link runSkill}. When some remain, the
   * card is registered in the {@link DependencyGraph} and starts only after they all settle ok (a
   * FAILED predecessor leaves it blocked-by-failure — held for the operator, never cancelled).
   */
  enqueueWithDeps(
    board: string,
    cardId: string,
    trigger: TriggerId,
    def: StatusDef,
    deps: string[] = [],
    opts: { origin?: "autorun" | "manual"; headroomUrl?: string | null } = {},
  ): EnqueueResult {
    const aliveDeps = deps.filter((d) => {
      const slash = d.indexOf("/");
      if (slash <= 0 || slash === d.length - 1) return false; // not a "board/cardId" key
      const b = d.slice(0, slash);
      const c = d.slice(slash + 1);
      return this.isInFlight(b, c) || this.depGraph.isBlocked(b, c);
    });

    if (aliveDeps.length === 0) {
      const attempt = this.runSkill(board, cardId, trigger, def, {
        origin: opts.origin ?? "manual",
        headroomUrl: opts.headroomUrl,
      });
      if (!attempt.ok) {
        return { id: cardId, board, lane: null, position: null, estimatedStart: null, blocked: false, reason: attempt.reason };
      }
      const info = this.getQueueInfo(board, cardId);
      return {
        id: cardId,
        board,
        lane: classifyTrigger(trigger), // the true lane, even while spawning (info.lane can lag here)
        position: info.position,
        estimatedStart: info.estimatedStart,
        blocked: false,
      };
    }

    this.depGraph.register({
      board,
      cardId,
      trigger,
      def,
      depsRemaining: new Set(aliveDeps),
      failedDeps: new Set(),
      blockedSince: Date.now(),
    });
    return {
      id: cardId,
      board,
      lane: classifyTrigger(trigger),
      position: null,
      estimatedStart: null,
      blocked: true,
      blockedBy: aliveDeps,
    };
  }

  /**
   * Read-only snapshot of where a card sits in the admission pipeline — no mutation. "running"
   * when its skill process is live (or it claimed a slot and is spawning); "queued" with its lane
   * + 0-indexed position when waiting; "idle" otherwise. `estimatedStart` is a deliberately
   * CONSERVATIVE epoch-ms estimate (position × the lane's average run time) — the orchestrator
   * should track real progress via runner_status, not treat it as a promise.
   */
  getQueueInfo(board: string, cardId: string): QueueInfo {
    const key = `${board}/${cardId}`;
    const run = this.registry.snapshot().running.find((r) => r.board === board && r.cardId === cardId);
    if (run) return { status: "running", lane: classifyTrigger(run.trigger), position: null, estimatedStart: Date.now() };

    const li = this.lightQueueKeys.indexOf(key);
    if (li >= 0) return { status: "queued", lane: "light", position: li, estimatedStart: Date.now() + li * AVG_LIGHT_RUN_MS };
    const hi = this.heavyQueueKeys.indexOf(key);
    if (hi >= 0) return { status: "queued", lane: "heavy", position: hi, estimatedStart: Date.now() + hi * AVG_HEAVY_RUN_MS };

    // In-flight but neither in the registry nor a queue ⇒ it claimed a slot and is between dequeue
    // and spawn (the worktree-create await). Report "running": it is committed to start imminently.
    if (this.inFlight.has(key)) return { status: "running", lane: null, position: null, estimatedStart: Date.now() };
    return { status: "idle", lane: null, position: null, estimatedStart: null };
  }
}

const KEY = Symbol.for("storymap.runner.engine");
const store = globalThis as unknown as { [KEY]?: RunnerEngine };

export function getRunnerEngine(): RunnerEngine {
  return (store[KEY] ??= new RunnerEngine());
}
