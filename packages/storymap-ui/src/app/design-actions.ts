"use server";

// 🟥 Style Guide (bloco de Design) — server actions for the guide as a PLAIN SOURCE-OF-TRUTH DOCUMENT.
// A human (or agent) authors it directly via prompt/instruction; there are NO options to approve and
// style NEVER gates a card. Thin shells — the kernel decisions (coerce/compile/checkAA/hash) all live
// in style-guide.ts; this file only wires IO.
//
// promoteStyleGuideDoc is the SINGLE writer of the canonical (`design/style-guide.md` + the board.yaml
// `styleGuide` pointer): it re-coerces the doc, refuses a stale `baseVersion` (plain optimistic
// concurrency), compiles the .md (D3 — never a byte of the LLM), bumps `version+1` and writes the hash.
// checkAA (WCAG contrast) is INFORMATIONAL only for the human — it never blocks a write from the page.
// applyStyleGuideAssistAction is the human-authoring path (the Design page's Editar/Salvar);
// writeStyleGuideSectionAction is an agent's path (the MCP `write_styleguide`): one section, never the tom, and
// a contrast regression refused. Both route through promoteStyleGuideDoc.

import { requireSession } from "@/lib/auth/action-guard";
import { promises as fs } from "node:fs";
import { revalidatePath } from "next/cache";
import { readBoardConfig } from "@/lib/storymap/repo";
import { writeBoardConfig } from "@/lib/storymap/write";
import { findRepoRoot, resolveBoundFilePath } from "@/lib/storymap/paths";
import { readStyleGuide, writeStyleGuide } from "@/lib/storymap/sidecars";
import {
  agentStyleSectionWrite,
  checkAA,
  coerceStyleGuideDoc,
  compileStyleGuideMd,
  computeStyleGuideHash,
  isEmptyStyleGuideDoc,
  styleGuideToPrompt,
} from "@/lib/storymap/style-guide";
import { auditTokensAgainstCss, type DriftReport } from "@/lib/storymap/style-drift";
import type { BoardConfig } from "@/lib/storymap/types";
import type { AAReport, StyleGuideDoc, StyleGuidePointer } from "@/lib/storymap/style-guide";

type Result<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

function fail<T = unknown>(e: unknown): Result<T> {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** Mirrors actions.ts's own local helper — a design-actions write always touches the whole board. */
function revalidateBoard(boardId: string): void {
  revalidatePath(`/board/${boardId}`, "layout");
}

/**
 * THE promotion core (D10) — the ONLY function that ever writes `BoardConfig.styleGuide` +
 * `design/style-guide.md`. Re-coerces `rawDoc` server-side (Invariant 7 — wire→disk fixed point:
 * never trust a doc as final, even one already coerced once upstream), refuses on a stale
 * `baseVersion` (plain optimistic concurrency — the canonical must still be what this write was
 * decided against, so two edits racing don't silently clobber each other), compiles + writes the
 * canonical (D3 — never a byte of the LLM), and advances the pointer to `{version: baseVersion+1, hash}`.
 *
 * checkAA (WCAG contrast) is INFORMATIONAL only — surfaced by the view/get_styleguide, it NEVER blocks
 * a write: the guide is a plain source-of-truth document a human authors, not a gate.
 *
 * `applyStyleGuideAssistAction` (the human-authoring / drift-sync apply) calls THIS — the single writer
 * of the canonical.
 */
async function promoteStyleGuideDoc(
  boardId: string,
  rawDoc: unknown,
  opts: {
    /** the canonical version this write was decided against — a stale value is refused (optimistic concurrency). */
    baseVersion: number;
  },
): Promise<Result<{ pointer: StyleGuidePointer }>> {
  try {
    const config = await readBoardConfig(boardId);
    const currentVersion = config.styleGuide?.version ?? 0;
    // Plain optimistic-concurrency guard: refuse if the canonical moved since this write was decided,
    // so two edits racing don't silently clobber each other. (Not an approval airgap — the guide is a
    // plain source-of-truth document, not a gated decision.)
    if (opts.baseVersion !== currentVersion) {
      return {
        ok: false,
        error: `O guia canônico avançou para v${currentVersion} enquanto você editava (base v${opts.baseVersion}). Recarregue e reaplique.`,
      };
    }

    const doc = coerceStyleGuideDoc(rawDoc);

    const now = new Date().toISOString();
    const finalDoc: StyleGuideDoc = {
      ...doc,
      meta: {
        ...doc.meta,
        version: currentVersion + 1,
        updatedAt: now,
      },
    };

    // D3 — the canonical is NEVER a byte of the LLM: hash the bytes compileStyleGuideMd deterministically
    // regrows from the coerced doc (writeStyleGuide recompiles the SAME pure function internally — same
    // input, same output — so the pointer's hash and the file on disk can never drift apart).
    const hash = computeStyleGuideHash(compileStyleGuideMd(finalDoc));
    await writeStyleGuide(boardId, finalDoc);

    // D10 — the ONLY chokepoint that writes the board.yaml pointer.
    const pointer: StyleGuidePointer = { version: finalDoc.meta.version, hash, updatedAt: now };
    const nextConfig: BoardConfig = { ...config, styleGuide: pointer };
    await writeBoardConfig(boardId, nextConfig);

    revalidateBoard(boardId);
    return { ok: true, data: { pointer } };
  } catch (e) {
    return fail(e);
  }
}

// ── 🟥 Drift panel + authoring/sync assistant ───────────────────────────────────────────────────
//
// (b) styleGuideDriftAction: READ-ONLY. Resolves the board's `package:`, reads the files the guide's
// `tokenBindings` point to (or a heuristic default set when the guide declares none), and runs the
// PURE `auditTokensAgainstCss` (WS-0). Fails OPEN to "não aplicável" — a board with no `package:` or
// no published guide is not an error, it's simply nothing to audit (D15).
// (a) applyStyleGuideAssistAction (the page) and writeStyleGuideSectionAction (an agent, by MCP) both route
// through `promoteStyleGuideDoc` above — the SINGLE writer of the canonical.

/** Mirrors engine.ts's own SAME-NAMED guard (`buildContextNote`) — a `package:` path is embedded
 *  into a spawn prompt there; here it is joined onto the filesystem for an actual read, so it MUST
 *  pass this same shell-metachar-free charset before ever touching `fs`. */
const SAFE_PKG_PATH = /^[A-Za-z0-9._/-]+$/;

/** Common CSS/token entry points to scan when the guide declares no `tokenBindings` — fed to the
 *  PURE `auditTokensAgainstCss` heuristic fallback, which itself flags every finding computed this
 *  way as low-confidence (D6). Covers both `packages/<app>/web/...` (the multi-app convention) and a
 *  package that IS the web root (no `web/` subdir, e.g. this very tool). */
const DEFAULT_CSS_CANDIDATES = ["web/src/app/globals.css", "src/app/globals.css", "web/tailwind.config.ts", "tailwind.config.ts"];

/**
 * Resolve a REPO-ROOT-RELATIVE product-file reference (a guide's `tokenBindings.file`, or a default
 * candidate below) to an absolute path. Delegates to the shared, unit-tested `resolveBoundFilePath`
 * (paths.ts), so the drift audit resolves paths with the SAME convention as `package:`/`brandbook:`/
 * `SystemDef.paths` — all repo-root-relative. (The prior version joined to `<repoRoot>/<pkg>/<rel>`,
 * double-prefixing a repo-relative binding into a non-existent path → every bound token read
 * "unreadable" — the systematic drift bug this fixes.) Guarded to the board's package; null on any
 * violation — caller degrades to "unreadable"/skip, NEVER throws. Read-only (WS-4 CRITICAL).
 */
function resolveProductFile(pkg: string, repoRelFile: string): string | null {
  return resolveBoundFilePath(findRepoRoot(), pkg, repoRelFile);
}

export interface StyleGuideDriftResult {
  /** false when the board has no `package:` or no published guide yet — "não aplicável", never an error. */
  applicable: boolean;
  report: DriftReport;
  /** repo-relative paths actually read for this audit (empty when not applicable). */
  filesRead: string[];
  /** WS-4 gotcha: headless (isCode:true) runs execute in a `stage` worktree; this action reads the
   *  RUNTIME checkout (main) — a stage×main divergence during a release window can surface as false
   *  drift. Fixed disclosure string, cheap and honest (05-ws4.md "[confirmar]" resolved to this). */
  note: string;
}

const DRIFT_RUNTIME_NOTE =
  "Comparado contra a árvore de runtime (o checkout onde o serviço AgileHarness roda) — durante uma janela " +
  "de release, código ainda em voo num worktree de stage pode aparecer aqui como divergência falsa.";

/**
 * O guia como CONTEXTO da conversa da página de Design (o compositor do rodapé), relido a cada turno — o que acabou
 * de ser salvo entra na próxima resposta. O assistente grava uma seção por vez com `write_styleguide` (o tom não: ali
 * ele propõe), e a pessoa grava pelo Editar/Salvar da página — os dois pelo mesmo escritor único (`promoteStyleGuideDoc`).
 */
export async function styleGuideChatContextAction(boardId: string): Promise<string | undefined> {
  await requireSession("styleGuideChatContextAction");
  const guide = await readStyleGuide(boardId);
  const note =
    "Leia com get_styleguide e grave UMA seção por vez com write_styleguide (cores, tipografia, estética, componentes, " +
    "anti-padrões, dívidas). O TOM (voz) é da marca, do dono — ali só proponha, na conversa. Cor que reprove o " +
    "contraste AA é recusada.";
  if (!guide || isEmptyStyleGuideDoc(guide)) {
    return ["## Documento em foco: guia de estilo (design/style-guide.md)", "", "O guia deste board ainda está VAZIO.", "", note].join("\n");
  }
  return ["## Documento em foco: guia de estilo (design/style-guide.md)", "", note, "", styleGuideToPrompt(guide)].join("\n");
}

/**
 * (b) — the drift audit server action. Report-only (D15): never writes product code, never
 * auto-corrects. `package:` absent, unsafe, or no guide published yet → `applicable:false` (fail-open,
 * never throws to the UI).
 */
export async function styleGuideDriftAction(input: { boardId: string }): Promise<Result<StyleGuideDriftResult>> {
  await requireSession("styleGuideDriftAction");
  try {
    const config = await readBoardConfig(input.boardId);
    const pkg = config.package;
    if (!pkg || !SAFE_PKG_PATH.test(pkg)) {
      return { ok: true, data: { applicable: false, report: { findings: [] }, filesRead: [], note: DRIFT_RUNTIME_NOTE } };
    }
    const doc = await readStyleGuide(input.boardId);
    if (!doc || isEmptyStyleGuideDoc(doc)) {
      return { ok: true, data: { applicable: false, report: { findings: [] }, filesRead: [], note: DRIFT_RUNTIME_NOTE } };
    }

    const bindings = doc.tokenBindings;
    const candidateRelPaths =
      bindings && Object.keys(bindings).length > 0
        ? // tokenBindings.file is already repo-root-relative (AgileHarness convention) — pass through.
          Array.from(new Set(Object.values(bindings).map((b) => b.file)))
        : // Defaults are package-relative SUFFIXES — join the board's `package:` to make them
          // repo-root-relative too, so both branches feed `resolveProductFile` the same convention.
          DEFAULT_CSS_CANDIDATES.map((rel) => `${pkg}/${rel}`);

    const files: { path: string; text: string }[] = [];
    for (const rel of candidateRelPaths) {
      const abs = resolveProductFile(pkg, rel);
      if (!abs) continue;
      try {
        const text = await fs.readFile(abs, "utf8");
        files.push({ path: rel, text });
      } catch {
        // absent/unreadable — auditTokensAgainstCss reports "unreadable" for any BOUND role that names
        // this file; the heuristic fallback simply scans one fewer candidate. Never throws.
      }
    }

    const report = auditTokensAgainstCss(doc, files);
    return {
      ok: true,
      data: { applicable: true, report, filesRead: files.map((f) => f.path), note: DRIFT_RUNTIME_NOTE },
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * (a) — apply an authored/sync'd guide the operator reviewed. Routes through `promoteStyleGuideDoc` —
 * the SINGLE writer of the canonical (re-coerce + version bump + hash + compile + flush). This IS the
 * human-authoring write: the operator writes/edits the guide directly, there is no container/proposal
 * and nothing to approve.
 */
export async function applyStyleGuideAssistAction(input: {
  boardId: string;
  doc: StyleGuideDoc;
  baseVersion: number;
}): Promise<Result<{ pointer: StyleGuidePointer }>> {
  await requireSession("applyStyleGuideAssistAction");
  return promoteStyleGuideDoc(input.boardId, input.doc, { baseVersion: input.baseVersion });
}

/**
 * A escrita de um AGENTE numa seção do guia — o que a tool `write_styleguide` chama (decisão do dono, 06/10:
 * cores, tipografia, estética e componentes os agentes mantêm; o tom é do dono). A decisão é do kernel puro
 * (`agentStyleSectionWrite`: seção do dono, formato e regressão de AA recusados); a gravação passa pelo MESMO
 * `promoteStyleGuideDoc` — o escritor único do arquivo e do ponteiro segue sendo um só.
 */
export async function writeStyleGuideSectionAction(input: {
  boardId: string;
  section: string;
  value: unknown;
}): Promise<Result<{ section: string; pointer: StyleGuidePointer; aa: AAReport }>> {
  await requireSession("writeStyleGuideSectionAction");
  try {
    const config = await readBoardConfig(input.boardId);
    const prev = (await readStyleGuide(input.boardId)) ?? coerceStyleGuideDoc(null);
    const decided = agentStyleSectionWrite(prev, input.section, input.value);
    if (!decided.ok) return { ok: false, error: decided.error };
    const res = await promoteStyleGuideDoc(input.boardId, decided.doc, { baseVersion: config.styleGuide?.version ?? 0 });
    if (!res.ok) return res;
    return { ok: true, data: { section: input.section, pointer: res.data!.pointer, aa: checkAA(decided.doc) } };
  } catch (e) {
    return fail(e);
  }
}
