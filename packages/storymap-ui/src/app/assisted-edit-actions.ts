"use server";

// Server actions for the operator's editing bench (Fase 3) — what is left of the "edit the brain" surface:
//   1. requestAssistedEditAction — ask a view-assistant agent (headless claude -p, persona from the
//      registry/override) to help, in one of three MODES: aprender (explica), editar (reescreve),
//      sincronizar (lê o CÓDIGO real e deriva o valor — SÓ leitura). Returns the agent's answer; nothing
//      is persisted until the operator approves.
//   2. detectSystemDriftAction / stampSystemPromptAction — the Inbox "sistemas mudaram" panel.
// NADA aqui grava skill ou prompt em disco: o `findRepoRoot()` em produção é o checkout de RUNTIME,
// compartilhado. Os gravadores de SKILL.md e de override de prompt foram apagados (quick-fix skill-writes);
// um editor de skill, se voltar, abre um worktree e integra pelo merge train, como código.

import { requireSession } from "@/lib/auth/action-guard";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readBoardConfig } from "@/lib/storymap/repo";
import { findRepoRoot } from "@/lib/storymap/paths";
import { runClaudeJson } from "@/lib/storymap/smart-capture/claude";
import { detectSystemDrift, type GitRunner, type SystemDrift } from "@/lib/storymap/system-drift";
import {
  assistantPromptPath,
  assistedEditRunOptions,
  buildAssistedEditPrompt,
  stripAgentPreamble,
  FALLBACK_ROLE,
  type AssistedEditKind,
  type AssistedEditMode,
} from "@/lib/storymap/assisted-edit";
import { assistantForKind } from "@/lib/storymap/assistant-registry";
import { readStyleGuide } from "@/lib/storymap/sidecars";
import { brandVoiceNote } from "@/lib/storymap/style-guide";
import { patchSystemAction } from "./actions";

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
 * `sincronizar` runs with READ tools only (longer budget) so the agent can investigate the real code —
 * explicit default permission mode + write tools denied + Read/Grep/Glob allowed (assistedEditRunOptions); never
 * skip-permissions in the runtime checkout.
 */
export async function requestAssistedEditAction(input: {
  kind: AssistedEditKind;
  mode: AssistedEditMode;
  label: string;
  current: string;
  instruction: string;
  context?: string;
  /** o board do artefato, quando há um: é dele que vem a voz de marca (o Guia de Estilo). */
  boardId?: string;
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
      brandVoice: input.boardId ? brandVoiceNote(await readStyleGuide(input.boardId).catch(() => null)) : "",
    });
    // sincronizar investiga o código real → mais tempo, SÓ leitura (assistedEditRunOptions: modo default explícito, as
    // tools de escrita negadas e só Read/Grep/Glob liberadas — antes era skip-permissions como root no checkout de runtime).
    // Surface this assistant on /processes while it runs (origin "ajuda").
    const helperContext = {
      label: `${assistant?.label ?? input.label ?? "Assistente"} · ${mode}`,
      view: assistant?.view,
    };
    const raw = await runClaudeJson(prompt, { ...assistedEditRunOptions(mode), context: helperContext });
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
