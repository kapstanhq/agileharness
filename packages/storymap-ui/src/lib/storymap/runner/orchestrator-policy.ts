// orchestrator-policy.ts — WS8 (F7) — PURE policy kernel for the board copiloto/orchestrator. NO I/O: it
// answers "given this board's declarative policy, may the copiloto act autonomously on an action of this
// RISK CLASS?" and lints a riskMatrix for the business invariant "a human owns the irreversible actions".
// The tick/wake/state/skill runtime (documented follow-up) consumes these; the kernel decides, not the shell.

import { DEFAULT_NEVER_RISK_CLASSES, NEVER_AUTO_RISK_CLASSES, RISK_CLASSES } from "../types";
import type { OrchestratorPolicy, RiskClass, RiskDisposition } from "../types";

/**
 * Fase 5.1/5.9 — the ENFORCEMENT capability signal that gates `mode: autonomous`. The Copiloto config tab reads
 * autonomousModeSafe() to unlock the toggle→autonomous, and setBoardOrchestratorModeAction accepts the write,
 * once it is true. Single source of truth — never hard-code the booleans elsewhere.
 *
 * `mcpTokenLevelsEnforced` (6.5): the register.ts McpLevel filter — a scoped `write` token mounts no
 * deploy/destructive/spawn tool, and the tick spawn uses --allowedTools mcp__storymap (no built-in Bash).
 *
 * `riskMatrixEnforced` is now TRUE (F5.9 — flipped 2026-07-11 with operator approval). What made it safe (the
 * whole F5 batch): a PER-CALL guard (mcp/guard.ts) consults the board riskMatrix on EVERY scoped-token tool
 * call; move_card/accept_triage are re-gated at the TARGET column's DYNAMIC class (a move into a deploy column
 * resolves `deploy`, into an autorun column `run` — not the static write-board); the harness-* spawn env no longer
 * carries STORYMAP_MCP_TOKEN (5.0b) so a run can't recover the full MCP surface; governance approve/reject is
 * full-only; a rate limiter + an audit ledger backstop it.
 *
 * F8 (2026-07-12, operator decision) then OPENED the pipeline: a board may declare `run`/`merge-resolve`/
 * `deploy` as `auto`, because an orchestrator that cannot run a skill, unpark the train or publish cannot
 * deliver end-to-end — it can only nag. The lock that made THAT safe is the `run`/`run-free` split (types.ts):
 * the pipeline verbs take a **cardId** (bounded by the board's own registered skills), the free verbs take a
 * **prompt** (a shell) — and only the free ones stay human-only. So the F5.0 rule "run:auto = deploy without
 * approval" no longer holds: the shell it feared IS `run-free`, and that is still forbidden (and not even
 * mounted: the `orch` MCP level never registers it).
 *
 * Turning the CAPABILITY on does NOT turn any board autonomous — every board defaults to mode `off` and stays
 * there until a human explicitly opts it in per board; AND the tick only spawns when STORYMAP_MCP_TOKEN_ORCH is
 * also exported in the service env. Two more locks beyond this flag.
 *
 * ⚠️ Este comentário dizia "(unset today)" sobre o token — e isso deixou de ser verdade em 2026-07-12, quando
 * ele passou a ser exportado pelo drop-in systemd `/etc/systemd/system/storymap.service.d/orch-token.conf`.
 * A frase sobreviveu à mudança e virou a fonte da crença de que o Jido estava inerte; uma investigação
 * inteira foi conduzida sobre essa premissa falsa até o env do processo vivo desmenti-la. NÃO afirme aqui o
 * estado do AMBIENTE (que muda fora do git) — descreva só a REGRA (sem token, não spawna).
 */
export const ORCHESTRATOR_ENFORCEMENT = {
  /** the riskMatrix is enforced per-call for scoped tokens (mcp/guard.ts) + move_card dynamic gate + run-escalation. */
  riskMatrixEnforced: true,
  /** 6.5 — the MCP token levels (McpLevel) filter the tools mounted for an orchestrator run (register.ts). SHIPPED. */
  mcpTokenLevelsEnforced: true,
} as const;

/** Fase 5.1/5.9 — is it SAFE to run a board in `autonomous` mode? True now that the F5 per-call guard +
 *  move_card dynamic gate + approvals + run-escalation enforce the riskMatrix on every scoped-token action. */
export function autonomousModeSafe(): boolean {
  return ORCHESTRATOR_ENFORCEMENT.riskMatrixEnforced;
}

/** The conservative default disposition for a risk class the board's matrix doesn't name: escalate. A class
 *  that may NEVER be auto defaults to `never`; everything else to `ask` (a human decides). Read defaults to
 *  auto (reading is always safe). */
export function defaultDisposition(riskClass: RiskClass): RiskDisposition {
  if (riskClass === "read") return "auto";
  // ADR-065 — o ciclo de vida do worktree da PRÓPRIA sessão. `auto` por DEFAULT porque o controle real não é a
  // aprovação: é o GATE do merge train, que roda a suíte inteira antes de qualquer split (um submit ruim é
  // reprovado e VOLTA para a sessão — nunca publica). Escalar por default aqui não adicionaria segurança: a
  // maioria destas chamadas não tem board para escapar a aprovação (a sessão card-less é legítima no ADR-065),
  // então o default `ask` virava RECUSA — a frota inteira parada, sem nenhum ganho de contenção. Um board que
  // queira humano no loop declara `session: ask` e a matriz vence (dispositionFor).
  if (riskClass === "session") return "auto";
  // ADR-066 — escrever num documento de IDEIA. `auto` por default pelo mesmo motivo de `read`: a Ideia vive
  // FORA do pipeline (sem status, sem trigger, sem coluna), então a escrita não move entrega, não cruza gate e
  // não dispara autorun — e a tool é estruturalmente incapaz de mais que isso (recusa card que não é ideia,
  // nunca esvazia campo, nunca substitui o corpo, não alcança status/parent/links).
  //
  // O default IMPORTA aqui, e é o que quase passou batido: `idea-write` é classe NOVA, então nenhuma matriz já
  // persistida a declara — nem a de um board em Copiloto, escrita antes de a classe existir. Sem esta linha, a
  // capacidade inteira caía em `ask` e o Explorador abria um pedido de aprovação por parágrafo escrito, em
  // TODOS os boards. Um board que queira humano no loop declara `idea-write: ask` e a matriz vence.
  if (riskClass === "idea-write") return "auto";
  // Escrever numa SEÇÃO de um DOCUMENTO de board (Lean Canvas e os próximos). Mesmíssima armadilha do
  // `idea-write`, e ela vale repetir porque é o que quase matou aquela feature: classe NOVA não existe
  // em nenhuma matriz já persistida — nem na de um board em Copiloto, escrita antes de a classe nascer.
  // Sem esta linha o default cai em `ask` e o agente abre um pedido de aprovação órfão por parágrafo
  // escrito, em TODOS os boards. Um board que queira humano no loop declara `doc-write: ask`.
  if (riskClass === "doc-write") return "auto";
  // F5.0/F8 — deploy/run-free/destructive default a `never` (deploy é OPT-IN explícito: um board que não pediu
  // não publica em produção só porque o Jido acordou); run/merge-resolve ESCALAM (ask) por padrão — o tick
  // pede aprovação, não recusa em silêncio. Um board só age sozinho no que a matriz DECLARA.
  if (DEFAULT_NEVER_RISK_CLASSES.includes(riskClass)) return "never";
  return "ask";
}

/** The RESOLVED disposition for a risk class: the board matrix's value, clamped so a NEVER_AUTO class
 *  (`run-free`/`destructive`) can never resolve to `auto` even if board.yaml says so (defense-in-depth over
 *  the lint — a hand-edited board.yaml skips the lint, never the clamp), else the conservative default. PURE. */
export function dispositionFor(policy: OrchestratorPolicy | null | undefined, riskClass: RiskClass): RiskDisposition {
  const declared = policy?.riskMatrix?.[riskClass];
  const resolved = declared ?? defaultDisposition(riskClass);
  if (resolved === "auto" && NEVER_AUTO_RISK_CLASSES.includes(riskClass)) return "ask"; // kernel guard
  return resolved;
}

/**
 * May the copiloto act AUTONOMOUSLY on an action of `riskClass`? True only when the board is in `autonomous`
 * mode AND the resolved disposition is `auto`. In `paired` mode the human drives (the copiloto suggests, never
 * acts unattended); in `off` mode nothing. PURE — the single gate the tick/wake spawner consults. `ask`/`never`
 * always return false (the caller escalates via ask_question or drops).
 */
export function mayActAutonomously(policy: OrchestratorPolicy | null | undefined, riskClass: RiskClass): boolean {
  if (policy?.mode !== "autonomous") return false;
  return dispositionFor(policy, riskClass) === "auto";
}

/**
 * WS8/F8 — LINT a board's riskMatrix (board-integrity): a NEVER_AUTO class (`run-free`/`destructive`) set to
 * `auto` REPROVES — the business invariant is that a human owns the shell and the irreversible actions. NOTE
 * `run`/`merge-resolve`/`deploy: auto` are now LEGAL (F8): a board opts into an orchestrator that delivers.
 * Also reproves an unknown risk class / disposition (typo guard). Returns named errors (empty when valid). PURE.
 */
export function lintRiskMatrix(policy: OrchestratorPolicy | null | undefined): string[] {
  const errors: string[] = [];
  const matrix = policy?.riskMatrix;
  if (!matrix) return errors;
  const knownClasses = new Set<string>(RISK_CLASSES);
  for (const [cls, disp] of Object.entries(matrix)) {
    if (!knownClasses.has(cls)) {
      errors.push(`riskMatrix: classe de risco desconhecida "${cls}"`);
      continue;
    }
    if (disp === "auto" && NEVER_AUTO_RISK_CLASSES.includes(cls as RiskClass)) {
      errors.push(`riskMatrix: "${cls}: auto" é proibido — ações irreversíveis SEMPRE escalam para o humano (use ask/never)`);
    }
  }
  return errors;
}
