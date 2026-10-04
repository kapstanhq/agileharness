// O item do Inbox de um pedido de EXECUÇÃO APROVADA (runner/locked-exec*): a projeção PURA de um registro do serviço
// para o que a tela mostra. Mora fora do serviço porque o coletor do cockpit a usa e os testes do Inbox também — sem
// puxar processo, disco ou relógio.

import type { DemandSeverity, LockedExecCockpitItem } from "./demands";
import type { LockedExecRecord } from "./runner/locked-exec";
import { checkCriterion, shellQuote } from "./runner/locked-exec";

const SHORT_OUTPUT = 400;

function shortOutput(stdout: string, stderr: string): string {
  const out = (stdout.trim() || stderr.trim()).replace(/^…/, "");
  return out.length <= SHORT_OUTPUT ? out : `…${out.slice(out.length - SHORT_OUTPUT)}`;
}

/** Em que faixa o item mora: o que deu errado é «travado»; o resto (decidir, acompanhar, desfazer) é «aprovar». */
function laneOf(r: LockedExecRecord): { lane: LockedExecCockpitItem["lane"]; severity: DemandSeverity } {
  if (r.status === "failed" || r.status === "stale" || r.status === "expired") return { lane: "travado", severity: "high" };
  if (r.status === "undone" && r.autoUndone) return { lane: "travado", severity: "high" };
  if (r.status === "pending") return { lane: "aprovar", severity: "high" };
  return { lane: "aprovar", severity: "medium" };
}

/** O item do Inbox de um pedido, para o board dele. PURA. Null para o que já saiu do Inbox (o dono arquivou). */
export function lockedExecItem(r: LockedExecRecord, card: { title: string; status: string | null } | null): LockedExecCockpitItem | null {
  if (r.ackedAt || r.status === "kept") return null;
  const { lane, severity } = laneOf(r);
  return {
    id: `lx:${r.id}`,
    kind: "locked-exec",
    boardId: r.board,
    cardId: r.cardId,
    cardTitle: card?.title ?? r.cardId,
    status: card?.status ?? null,
    lane,
    severity,
    since: r.finishedAt ?? r.decidedAt ?? r.proposedAt,
    lockedExecId: r.id,
    hash: r.hash,
    execStatus: r.status,
    summary: r.summary,
    why: r.why,
    command: shellQuote(r.argv),
    program: r.programs.main,
    undoCommand: r.undoArgv ? shellQuote(r.undoArgv) : null,
    undoProgram: r.programs.undo,
    noUndoPlan: r.noUndoPlan,
    preflight: r.preflight.map((c, i) => ({ label: c.label, command: shellQuote(c.argv), program: r.programs.preflight[i] ?? "?", criterion: checkCriterion(c) })),
    verify: r.verify.map((c, i) => ({ label: c.label, command: shellQuote(c.argv), program: r.programs.verify[i] ?? "?", criterion: checkCriterion(c) })),
    timeoutSec: r.timeoutSec,
    proposedBy: r.proposedBy,
    proposedAt: r.proposedAt,
    lockRule: r.classification.rule ?? r.classification.klass ?? null,
    expiresAt: r.expiresAt ?? null,
    finishedAt: r.finishedAt ?? null,
    undoing: r.status === "running" && r.phase === "undo",
    autoUndone: !!r.autoUndone,
    error: r.error ?? null,
    rejectReason: r.rejectReason ?? null,
    steps: r.results.map((s) => ({
      step: s.step,
      ok: s.ok,
      exitCode: s.exitCode,
      output: shortOutput(s.stdoutTail, s.stderrTail),
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}
