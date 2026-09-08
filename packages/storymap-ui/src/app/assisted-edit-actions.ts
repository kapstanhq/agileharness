"use server";

// Server actions for the operator's editing bench (Fase 3) — the "edit the brain" surface.
// Capabilities the <AssistedEditor> + the Orquestração screen compose:
//   1. requestAssistedEditAction — ask a view-assistant agent (headless claude -p, persona from the
//      registry/override) to help, in one of three MODES: aprender (explica), editar (reescreve),
//      sincronizar (lê o CÓDIGO real e deriva o valor — bootstrap). Returns the agent's answer; nothing
//      is persisted until the operator approves (the inline accept/refine/approve loop).
//   2. saveGovernanceFieldAction — persist a strategy-ladder / Canvas edit through the conflict-gated
//      GOVERNANCE path (propose → approve), so direct + agent-proposed edits take the SAME audited route.
//   3. read/writeSkillAction — read/write a harness-* SKILL.md (path-guarded).
//   4. read/writeAssistantPromptAction — read/write a view-assistant's SYSTEM PROMPT (override file),
//      so the operator can tune the agents themselves from the Orquestração screen.

import { requireSession } from "@/lib/auth/action-guard";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { revalidatePath } from "next/cache";
import type { BoardConfig, GovernanceArtifact, GovernanceChange } from "@/lib/storymap/types";
import { readBoardConfig } from "@/lib/storymap/repo";
import { findRepoRoot } from "@/lib/storymap/paths";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import { detectSystemDrift, type GitRunner, type SystemDrift } from "@/lib/storymap/system-drift";
import {
  assistantPromptPath,
  buildAssistedEditPrompt,
  skillMdPath,
  stripAgentPreamble,
  FALLBACK_ROLE,
  type AssistedEditKind,
  type AssistedEditMode,
} from "@/lib/storymap/assisted-edit";
import { assistantById, assistantForKind } from "@/lib/storymap/assistant-registry";
import { isEmptyCanvasValue } from "@/lib/storymap/canvas";
import { proposeChangeAction, approveGovernanceDraftAction, patchSystemAction } from "./actions";

// git for the drift detector — execFile (shell:false): args are an array, so a glob/SHA from board.yaml
// is NEVER shell-interpreted. SERVER-ONLY. Bounded timeout/buffer so a hung/huge log can't stall a render.
const execFileP = promisify(execFile);
const gitRunner: GitRunner = async (args, cwd) => {
  const { stdout } = await execFileP("git", args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/**
 * "Nothing is here" — for the governance conflict gate. Beyond null/"" it must also swallow the
 * canvas's empty shapes (`[]`, `{items:[]}`): the gate JSON-compares `before` against the canonical,
 * so without this the FIRST fill of an unset block (before `{items:[]}` vs canonical `undefined`)
 * would be refused as a phantom conflict. Single source: the canvas kernel.
 */
function isEmptyish(v: unknown): boolean {
  return isEmptyCanvasValue(v);
}

function canonicalOf(config: BoardConfig, artifact: GovernanceArtifact, field: string | null): unknown {
  const cur = (config as unknown as Record<string, unknown>)[artifact];
  if (field == null) return cur;
  return cur && typeof cur === "object" ? (cur as Record<string, unknown>)[field] : undefined;
}

/**
 * The effective system prompt of an assistant: the disk override if present, else the registry
 * default. Exported (not just used here) — design-actions.ts's styleguide assistant (WS-4) reuses this
 * SAME resolver rather than re-implementing the override-file lookup a second time.
 */
export async function resolveAssistantPrompt(id: string, fallback: string): Promise<string> {
  await requireSession("resolveAssistantPrompt");
  const p = assistantPromptPath(id);
  if (!p) return fallback;
  try {
    const content = (await fs.readFile(p, "utf8")).trim();
    return content || fallback;
  } catch {
    return fallback; // no override file → default
  }
}

/**
 * Ask a view-assistant agent to help with an artifact, in one MODE. No persistence — the operator
 * reviews the proposal/guidance and approves (or refines, or edits by hand) in the <AssistedEditor>.
 *  - editar/sincronizar → returns the full new value (proposal to diff/approve).
 *  - aprender           → returns prose guidance (the UI shows it, doesn't apply it).
 * `sincronizar` runs WITH read tools (longer budget) so the agent can investigate the real code.
 */
export async function requestAssistedEditAction(input: {
  kind: AssistedEditKind;
  mode: AssistedEditMode;
  label: string;
  current: string;
  instruction: string;
  context?: string;
}): Promise<Result<{ proposal: string }>> {
  await requireSession("requestAssistedEditAction");
  try {
    const mode: AssistedEditMode = input.mode ?? "editar";
    const instruction = input.instruction?.trim() ?? "";
    // editar/aprender precisam de um pedido; sincronizar deriva do código (pedido opcional).
    if (!instruction && mode !== "sincronizar") {
      return { ok: false, error: "Descreva o que você quer que o agente faça." };
    }
    const assistant = assistantForKind(input.kind);
    const systemPrompt = assistant ? await resolveAssistantPrompt(assistant.id, assistant.defaultPrompt) : FALLBACK_ROLE;
    const prompt = buildAssistedEditPrompt({
      systemPrompt,
      kind: input.kind,
      mode,
      label: input.label,
      current: input.current ?? "",
      instruction,
      context: input.context,
    });
    // sincronizar investiga o código real → mais tempo + ferramentas de leitura (read-only por prompt).
    // Surface this assistant on /processes while it runs (origin "ajuda").
    const helperContext = {
      label: `${assistant?.label ?? input.label ?? "Assistente"} · ${mode}`,
      view: assistant?.view,
    };
    const raw =
      mode === "sincronizar"
        ? await runClaudeJson(prompt, {
            timeoutMs: 600_000,
            effort: "high",
            dangerouslySkipPermissions: true,
            context: helperContext,
          })
        : await runClaudeJson(prompt, { context: helperContext });
    // editar/sincronizar devem devolver o VALOR cru — remove cerca/preâmbulo que o modelo cole apesar
    // do contrato; aprender devolve prosa explicativa de propósito e fica intocada.
    const proposal = mode === "aprender" ? raw.trim() : stripAgentPreamble(raw);
    if (!proposal) return { ok: false, error: "O agente não retornou uma resposta. Tente reescrever o pedido." };
    return { ok: true, data: { proposal } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Persist a governance-owned board field (positioning/businessMetric/desiredOutcome / canvas[block]) through the conflict-gated
 * propose→approve path. Reconciles an empty `before` with the live canonical so the FIRST edit of an
 * unset field isn't falsely refused; a genuine concurrent change still trips the gate.
 */
export async function saveGovernanceFieldAction(input: {
  boardId: string;
  artifact: GovernanceArtifact;
  field: string | null;
  before: unknown;
  after: unknown;
  label?: string;
  reason?: string;
}): Promise<Result> {
  await requireSession("saveGovernanceFieldAction");
  try {
    const live = await readBoardConfig(input.boardId);
    const canonical = canonicalOf(live, input.artifact, input.field);
    const before = isEmptyish(input.before) && isEmptyish(canonical) ? canonical : input.before;

    const change: GovernanceChange = {
      artifact: input.artifact,
      field: input.field,
      before,
      after: input.after,
      label: input.label ?? null,
    };
    const proposed = await proposeChangeAction({
      boardId: input.boardId,
      reason: input.reason?.trim() || "edição direta na bancada",
      origin: { skill: null, cardId: null },
      changes: [change],
    });
    if (!proposed.ok) return proposed;
    return await approveGovernanceDraftAction({ boardId: input.boardId, draftId: proposed.data!.draftId });
  } catch (e) {
    return fail(e);
  }
}

/** Read a harness-* SKILL.md (path-guarded). Returns the file content. */
export async function readSkillAction(input: { skill: string }): Promise<Result<{ content: string }>> {
  await requireSession("readSkillAction");
  try {
    const p = skillMdPath(input.skill);
    if (!p) return { ok: false, error: `Skill inválida: ${input.skill}` };
    const content = await fs.readFile(p, "utf8");
    return { ok: true, data: { content } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Write a harness-* SKILL.md (path-guarded). The operator is the authority — no governance gate (it's a
 * file). Read at runtime by the headless claude, so it takes effect on the next run WITHOUT a rebuild;
 * persistence across deploys still needs a commit on the VPS checkout (ADR-058).
 */
export async function writeSkillAction(input: { skill: string; content: string }): Promise<Result> {
  await requireSession("writeSkillAction");
  try {
    const p = skillMdPath(input.skill);
    if (!p) return { ok: false, error: `Skill inválida: ${input.skill}` };
    const content = input.content ?? "";
    if (!content.trim()) return { ok: false, error: "O conteúdo da skill não pode ficar vazio." };
    await fs.writeFile(p, content, "utf8");
    revalidatePath(`/board`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Read a view-assistant's effective system prompt (disk override if present, else registry default). */
export async function readAssistantPromptAction(input: {
  id: string;
}): Promise<Result<{ content: string; isDefault: boolean }>> {
  await requireSession("readAssistantPromptAction");
  try {
    const assistant = assistantById(input.id);
    if (!assistant) return { ok: false, error: `Assistente desconhecido: ${input.id}` };
    const p = assistantPromptPath(input.id);
    if (!p) return { ok: false, error: `Assistente inválido: ${input.id}` };
    try {
      const override = (await fs.readFile(p, "utf8")).trim();
      if (override) return { ok: true, data: { content: override, isDefault: false } };
    } catch {
      // no override file → fall through to the default
    }
    return { ok: true, data: { content: assistant.defaultPrompt, isDefault: true } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Write a view-assistant's system prompt override (path-guarded). Only known assistant ids are
 * accepted. Like SKILL.md: read at runtime by the next assisted-edit request, no rebuild; commit to persist.
 */
export async function writeAssistantPromptAction(input: { id: string; content: string }): Promise<Result> {
  await requireSession("writeAssistantPromptAction");
  try {
    const assistant = assistantById(input.id);
    if (!assistant) return { ok: false, error: `Assistente desconhecido: ${input.id}` };
    const p = assistantPromptPath(input.id);
    if (!p) return { ok: false, error: `Assistente inválido: ${input.id}` };
    const content = input.content ?? "";
    if (!content.trim()) return { ok: false, error: "O prompt do assistente não pode ficar vazio." };
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    revalidatePath(`/board`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Detect which of a board's SYSTEMS are STALE — their code (SystemDef.paths) changed since the prompt
 * was last synced (SystemDef.syncedCommit). Powers the Inbox "sistemas mudaram" panel. Cheap +
 * deterministic (a `git log` per anchored system); returns the current HEAD an approval re-stamps. A
 * read/git failure degrades to an empty list (the panel just shows nothing) — never throws to the UI.
 */
export async function detectSystemDriftAction(input: {
  boardId: string;
}): Promise<Result<{ head: string; drift: SystemDrift[] }>> {
  await requireSession("detectSystemDriftAction");
  try {
    const config = await readBoardConfig(input.boardId);
    const { head, drift } = await detectSystemDrift(findRepoRoot(), config.systems, gitRunner);
    return { ok: true, data: { head, drift } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Save a system's PROMPT and re-anchor the drift baseline by stamping `syncedCommit = HEAD` in ONE step
 * — so syncing (from the Inbox drift panel OR the bench) always clears the drift it resolved. Reads
 * HEAD via git; if HEAD can't be read (no git / detached) it saves the prompt anyway WITHOUT the stamp
 * (the save never blocks on git). Reuses patchSystemAction's fresh-read anti-clobber merge.
 */
export async function stampSystemPromptAction(input: {
  boardId: string;
  systemId: string;
  prompt: string;
}): Promise<Result> {
  await requireSession("stampSystemPromptAction");
  try {
    let head: string | undefined;
    try {
      head = (await gitRunner(["rev-parse", "HEAD"], findRepoRoot())).trim() || undefined;
    } catch {
      head = undefined;
    }
    const patch = head ? { prompt: input.prompt, syncedCommit: head } : { prompt: input.prompt };
    const res = await patchSystemAction({ boardId: input.boardId, systemId: input.systemId, patch });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  } catch (e) {
    return fail(e);
  }
}
