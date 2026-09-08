// WS-11.2 / D15 (card storymap/story-pxj9gz) — lift the face gate's OWN verdict out of the deploy log and
// into the card's finding, so a rejected deploy names {package, step, first error line} instead of the
// generic "Deploy de produção falhou (exit 1) para mosaico-site … veja o log de 32KB".
//
// WHY THIS IS NOT COSMETIC. On 2026-07-16 that generic sentence was the ONLY thing the board showed for two
// completely different defects — a promotion bug (story-sf4vyb) and a cross-app gate veto (this one). They
// were indistinguishable, so the whole day was spent debugging the wrong one; the real cause (an orphan
// `.next/types` stub in nimbus, an app the deploy did not even rebuild) only surfaced after the first was
// fixed. Scoping the gate (11.1) stops the CROSS-APP veto; this stops the ERASURE. A legitimate in-scope
// veto still has to say what broke — the other half of the same family.
//
// The wire: predeploy-face-gate.mjs prints `FACE_GATE_FAIL {json}` as its last stdout line → the deploy
// launcher streams the child's stdout into logFileFor("mosaico-site") → this module greps it back out on
// settle → DeployFailureDetail.reason → buildDeployFailureFinding concatenates it as "Motivo: …".
//
// PURE parse + a best-effort read (never throws — a deploy callback must not break on a missing log).
// SERVER-ONLY (node:fs).

import { promises as fsp } from "node:fs";
import { logFileFor } from "./product-deploy";

/** The marker predeploy-face-gate.mjs prints. MUST match lib/turbo-failure.mjs's FACE_GATE_FAIL_MARKER —
 *  the two live in different languages, so face-gate-detail.test.ts asserts the .mjs still emits this
 *  exact string (a silent rename would make every face veto anonymous again, which is the bug this fixes). */
export const FACE_GATE_FAIL_MARKER = "FACE_GATE_FAIL";

/** The gate's structured verdict. `pkg` is null when the failure owns no package (a timeout / killed suite). */
export interface FaceGateFail {
  pkg: string | null;
  task: string;
  firstError: string | null;
}

/**
 * PURE: the gate's verdict carried in a deploy log, or null when there is none (the deploy failed for some
 * other reason — a firebase error, a build failure — and must NOT be dressed up as a gate rejection).
 * Reads the LAST marker line: the log holds one deploy, but a re-run appending would leave older ones, and
 * the freshest verdict is the one that decided this exit.
 */
export function parseFaceGateFail(log: string): FaceGateFail | null {
  if (!log) return null;
  let found: FaceGateFail | null = null;
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(`${FACE_GATE_FAIL_MARKER} `)) continue;
    try {
      const parsed = JSON.parse(line.slice(FACE_GATE_FAIL_MARKER.length + 1)) as Partial<FaceGateFail>;
      if (typeof parsed?.task !== "string") continue; // malformed ⇒ ignore, never crash the revert path
      found = {
        pkg: typeof parsed.pkg === "string" ? parsed.pkg : null,
        task: parsed.task,
        firstError: typeof parsed.firstError === "string" ? parsed.firstError : null,
      };
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * PURE: the verdict as the one-line `reason` a finding shows — e.g.
 * `o gate do rosto reprovou nimbus#typecheck: .next/types/app/waitlist/page.ts(2,24): error TS2307: …`.
 * null when the log carries no gate verdict (caller then omits `reason`, i.e. today's behaviour).
 */
export function faceGateReason(log: string): string | null {
  const fail = parseFaceGateFail(log);
  if (!fail) return null;
  const where = fail.pkg ? `${fail.pkg}#${fail.task}` : fail.task;
  return `o gate do rosto reprovou ${where}: ${fail.firstError ?? "(sem linha de erro legível — veja o log)"}`;
}

/**
 * Best-effort: read the face deploy's log and return the gate's verdict as a finding `reason`. null when the
 * log is unreadable/absent or carries no verdict — the caller then reverts exactly as before (never worse).
 */
export async function readFaceGateReason(pkg: string): Promise<string | null> {
  try {
    return faceGateReason(await fsp.readFile(logFileFor(pkg), "utf8"));
  } catch {
    return null;
  }
}
