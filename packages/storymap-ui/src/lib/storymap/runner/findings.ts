import type { FailureClass, Finding } from "@/lib/storymap/types";
import { FindingBatchItemSchema, type FindingBatchItem } from "@/lib/storymap/contracts";

// PURE finding builders for the merge train — the cohesive "stamp a blocker/note onto a card's
// findings[]" concern, lifted out of merge-queue.ts (the god-file) into its own testable home (C4).
// Each is idempotent by a stable per-runId id, so a re-run/redrive REFRESHES its finding instead of
// stacking duplicates. merge-queue.ts's default* wiring (read-modify-write under the card lock) calls
// these; the engine never reaches into the queue to do it. No I/O — operate on a findings[] value.

// ── authorship of a status change (WS-2, 2.3) ───────────────────────────────
/**
 * WHO/WHEN of a finding status change. PURE input — the `at` date is INJECTED by the IO caller (the same
 * discipline as questions.ts's `today` param), so every builder here stays clock-free and testable.
 *
 * `by` is an actor id: "human" (operator via the UI), "copilot" (agent via the `triage_finding` MCP tool),
 * "train:<runId>" (a run's own blockers auto-resolved on integration), "audit:<trigger>" (the capability
 * audit clearing its advisory), "terminal:<status>" (residual mechanism blockers superseded on entry to a
 * terminal status — {@link supersedeStaleTerminalBlockers}). Stamped ONLY on a status CHANGE — minting a
 * finding `open` is not one.
 */
export interface FindingStatusStamp {
  by: string;
  /** YYYY-MM-DD */
  at: string;
}

/**
 * PURE: set a finding's `status`, carrying the authorship stamp when the caller supplied one. The single
 * place the WS-2 (2.3) `statusBy`/`statusAt` pair is written, so no resolver can flip a status and forget
 * the forensics. Without a stamp the fields stay as they were (sparse — legacy callers keep working).
 */
function withStatusStamped<T extends Finding>(finding: T, status: Finding["status"], stamp?: FindingStatusStamp): T {
  return { ...finding, status, ...(stamp ? { statusBy: stamp.by, statusAt: stamp.at } : {}) };
}

// ── minting an id an element-level merge can trust (WS-2, 2.4 / G9) ─────────
/**
 * PURE: mint the id of a REVIEW-LENS finding — `<lens>-<seq>-<provenance>` (e.g.
 * `security-1-8b47e6a7`). The CANONICAL reference for the id shape the harness-review skill's step 5 assigns
 * on write (the sub-agents author no id — see {@link parseFindingBatch}); COOPERATIVE in the same way
 * (the lenses run inside the headless run, below what the engine can see), so the prose mirrors this and
 * this is the single source of the rule.
 *
 * WHY the provenance suffix (autocrítica G9): WS-2 merges `findings[]` BY ID, which assumes an id names
 * the SAME fact on both sides. Mechanism ids already hold (`code-not-landed-<runId>`, `gate-<runId>` —
 * unique by construction), but a lens that mints "f1"/"f2" positionally collides ACROSS RUNS: two
 * different defects sharing an id make the merge treat them as one and DROP main's. 218 such legacy ids
 * exist on the real boards (they pre-date this rule and stay — the merge only mis-fires when the SAME id
 * names DIFFERENT facts, which needs two runs minting anew). `provenance` is the run's sha/runId; `seq`
 * disambiguates several findings from one lens in one run.
 */
export function reviewFindingId(lens: string, seq: number, provenance: string): string {
  const clean = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const prov = clean(provenance).slice(0, 12);
  return `${clean(lens) || "general"}-${seq}${prov ? `-${prov}` : ""}`;
}

/**
 * UPSERT a finding into a card's `findings[]` by id — APPEND when absent, else SHALLOW-MERGE over the
 * existing one in place (board fields win). The single find-or-append-by-id tail the three builders
 * below shared byte-for-byte. Pure.
 */
export function upsertFinding(existing: Finding[], finding: Finding): Finding[] {
  const idx = existing.findIndex((f) => f.id === finding.id);
  if (idx < 0) return [...existing, finding];
  const next = existing.slice();
  next[idx] = { ...next[idx], ...finding };
  return next;
}

/**
 * ADR-063 (4a/4b) — UPSERT by id, but return NULL when the target finding is ALREADY present and identical
 * on the fields we set. That null is load-bearing: the loop-guard / budget-guard write the finding via
 * `updateCardOnDisk`, and a card write re-triggers the fs-watcher → re-eval → the SAME guard → the SAME
 * finding. Without the null-when-unchanged short-circuit, `updateCardOnDisk` would write on every re-eval,
 * spinning an INFINITE write→watch→eval loop. Returning null makes the write idempotent (the loop settles
 * after one pass). The only difference from {@link upsertFinding} is that short-circuit. Pure.
 */
export function upsertFindingIfChanged(existing: Finding[], finding: Finding): Finding[] | null {
  const cur = existing.find((f) => f.id === finding.id);
  if (
    cur &&
    cur.lens === finding.lens &&
    cur.severity === finding.severity &&
    cur.title === finding.title &&
    (cur.detail ?? "") === (finding.detail ?? "") &&
    cur.status === finding.status
  ) {
    return null; // identical finding already on the card → no write (breaks the write→watch→eval loop)
  }
  return upsertFinding(existing, finding);
}

// ── gate-failure blocker (SM-06, AC2) ──────────────────────────────────────
/** Stable id for the gate-failure finding of a run — one per `runId`, so a retry that re-fails
 * UPDATES the existing finding instead of stacking duplicates. */
export function gateBlockerFindingId(runId: string): string {
  return `gate-${runId}`;
}

/**
 * SM-06 (AC2) — PURE: compute the card's `findings[]` after the integration gate reproved a run.
 * Idempotent by {@link gateBlockerFindingId}: a first failure APPENDS a `testing:blocker` finding; a
 * retry that re-fails REFRESHES that same finding's detail/status in place (never duplicates it). Other
 * findings are preserved untouched. A blocker `open` finding holds the card out of `qa-automatizado`
 * (gate `hasNoBlockers`) until the operator clears it.
 */
/** Stable id for a card's flaky-test advisory (one per run — a re-fire UPSERTS instead of stacking). */
export function flakyTestFindingId(runId: string): string {
  return `flaky-test-${runId}`;
}

/**
 * WS1.3 — an ADVISORY finding (severity "low", NEVER "blocker" → it gates NOTHING) recording that the merge
 * gate INTEGRATED the card despite a NEW test failure that did NOT reproduce on a full-suite retry (flaky).
 * The operator sees the card shipped + which tests flaked (also aggregated in flaky.json for quarantine).
 */
export function withFlakyTestFinding(existing: Finding[], runId: string, testIds: string[]): Finding[] {
  const list = testIds.slice(0, 8).join(", ").slice(0, 400);
  return upsertFinding(existing, {
    id: flakyTestFindingId(runId),
    lens: "testing",
    severity: "low",
    title: `teste flaky não reproduziu no retry (${testIds.length}) — card integrado mesmo assim`,
    ...(list ? { detail: `Falha(s) NOVA(s) que sumiram no retry da suíte completa (candidatas a quarentena): ${list}` } : {}),
    status: "open",
  });
}

/** Stable id for a card's tooling-unused advisory — one per STEP (trigger), card-scoped: the same step's
 *  next run REFRESHES the same advisory (or clears it), never stacks; a different step has its own. */
export function toolingUnusedFindingId(trigger: string): string {
  return `tooling-unused-${trigger}`;
}

/**
 * WS3 (F2) — a SOFT advisory (severity "low", lens "general", NEVER a blocker → it gates NOTHING; the
 * lesson from the fail-closed footgun) recording that a run SUCCEEDED on a step that PROVISIONED a
 * capability (e.g. the codegraph MCP) at `expected` level but never exercised it (no `match` hit in
 * toolsUsed). The operator sees "graphify estava disponível mas não foi usado" — the durable, gate-free
 * nudge behind the >60% adoption goal. Idempotent by {@link toolingUnusedFindingId} (per step). Never
 * holds a card.
 */
export function withToolingUnusedFinding(existing: Finding[], trigger: string, toolGap: string[], stepLabel?: string): Finding[] {
  const tools = toolGap.slice(0, 6).join(", ").slice(0, 200);
  const where = stepLabel ? ` no passo "${stepLabel}"` : "";
  return upsertFinding(existing, {
    id: toolingUnusedFindingId(trigger),
    lens: "general",
    severity: "low",
    title: `capacidade provisionada mas não usada${where}: ${tools}`,
    detail: `O step declara estas ferramentas como esperadas mas o run não as exercitou (nenhum match em toolsUsed): ${tools}. Considere consultá-las na próxima passagem — é um aviso, não bloqueia o avanço.`,
    status: "open",
  });
}

/**
 * WS3 (F2) — CLEAR the step's tooling-unused advisory when a later run of the SAME step exercised the
 * tool (empty toolGap on a success). Flips open→fixed for that step's id, leaving other findings intact.
 * Returns null when there is nothing open to clear, so the IO caller skips the write (mirrors
 * withRunBlockersResolved / clearRunDeathFinding — never spins a write→watch→eval loop).
 */
export function withToolingUnusedResolved(
  existing: Finding[],
  trigger: string,
  stamp?: FindingStatusStamp,
): Finding[] | null {
  const id = toolingUnusedFindingId(trigger);
  if (!existing.some((f) => f.id === id && f.status === "open")) return null;
  return existing.map((f) => (f.id === id && f.status === "open" ? withStatusStamped(f, "fixed", stamp) : f));
}

/** Stable per-card id for the WS4 route-undersized advisory. Card-scoped (one route decision per card). */
export function routeUndersizedFindingId(): string {
  return "route-undersized";
}

/**
 * WS4 (furo do juiz #1) — a MEDIUM, NON-blocking advisory that a card's ROUTE looks under-dimensioned: it
 * carries real UI surface (`hasUiSurface`) yet its `routing.skips` bypassed the DESIGN block. NOT a blocker
 * (it gates nothing — a human decides whether to reopen with a fuller route); it just surfaces the mismatch
 * an `express`-style route can create so the design work isn't silently skipped. Idempotent (single id).
 */
export function withRouteUndersizedFinding(existing: Finding[], skipped: string[]): Finding[] {
  const steps = skipped.slice(0, 6).join(", ");
  return upsertFinding(existing, {
    id: routeUndersizedFindingId(),
    lens: "general",
    severity: "medium",
    title: `rota subdimensionada: card com superfície de UI pulou o design (${steps})`,
    detail:
      `O card declara superfície de UI (hasUiSurface) mas a rota pulou passos de design (${steps}). ` +
      "Se há telas/jornada novas, considere reabrir com uma rota mais completa (ou ajustar a rota via " +
      "set_card_route). Aviso — não bloqueia o avanço; um humano decide.",
    status: "open",
  });
}

/** CLEAR the route-undersized advisory when a later run finds the route no longer under-dimensioned (the
 *  route was fixed / the UI-surface flag flipped). Returns null when nothing is open (skips the write). */
export function withRouteUndersizedResolved(existing: Finding[], stamp?: FindingStatusStamp): Finding[] | null {
  const id = routeUndersizedFindingId();
  if (!existing.some((f) => f.id === id && f.status === "open")) return null;
  return existing.map((f) => (f.id === id && f.status === "open" ? withStatusStamped(f, "fixed", stamp) : f));
}

export function withGateBlockerFinding(existing: Finding[], runId: string, gateLog: string): Finding[] {
  // 800 (not 200): the gate now reports an ACTIONABLE summary (the failing tests + their assertions
  // attributed to THIS card's diff), so the operator/agent needs to see it, not a truncated head.
  const detail = gateLog.slice(0, 800) || undefined;
  return upsertFinding(existing, {
    id: gateBlockerFindingId(runId),
    lens: "testing",
    severity: "blocker",
    title: "merge gate falhou",
    ...(detail ? { detail } : {}),
    status: "open",
  });
}

// ── secret-scan blocker (SM-08) ─────────────────────────────────────────────
/** Stable id for the secret-scan blocker finding of a run — one per `runId`, so a re-run that re-blocks
 * UPDATES the existing finding instead of stacking duplicates (mirrors {@link gateBlockerFindingId}). */
export function secretScanBlockerFindingId(runId: string): string {
  return `secret-scan-${runId}`;
}

/** Entropia de Shannon do texto (bits/char) — a mesma régua do scanner de segredo da raiz. */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let e = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Um "run" opaco do alfabeto de credencial. `.`/`/`/`:` NÃO entram: eles partem caminho e URL em
 *  segmentos, que é o que mantém `packages/storymap-ui/...` fora do julgamento. */
const RUN_OPACO = /[A-Za-z0-9_-]{24,}/g;

/** Um segmento com forma de PALAVRA (`storymap`, `AUTORUN`, `0001`) ou de grupo HEX minúsculo
 *  (`b38597ce`, `3ef1` — os pedaços de um UUID/runId). Curto por definição.
 *
 *  O QUE A ÚLTIMA CLÁUSULA IMPEDE: que a isenção de "identificador segmentado" devolva INTEIRO um token
 *  de credencial que por acaso vem hifenizado. Um segmento como `abcDEF123456` casa `^[a-z][A-Za-z0-9]*$`
 *  — e com ele um token de bot do Slack (`xoxb-<dígitos>-<dígitos>-<run>`, uma forma que este mesmo
 *  repositório detecta por prefixo em `scan-secrets.mjs`) saía legível para `findings[].detail`, que é
 *  board-data COMMITADA. Maiúscula E dígito no MESMO segmento é assinatura de alfabeto sorteado, não de
 *  palavra escrita por gente: `storymap`, `agent`, `AUTORUN`, `0001` e os grupos hex de um UUID seguem
 *  passando, porque nenhum deles mistura as duas coisas. */
function ehSegmentoDeIdentificador(p: string): boolean {
  if (p.length > 12) return false;
  if (/^[A-Z][A-Z0-9]*$/.test(p) || /^[0-9]+$/.test(p) || /^[0-9a-f]+$/.test(p)) return true;
  return /^[a-z][A-Za-z0-9]*$/.test(p) && !(/[A-Z]/.test(p) && /[0-9]/.test(p));
}

/**
 * O token é um IDENTIFICADOR segmentado escrito por gente/máquina — runId (`agent-<uuid>`), branch
 * (`failed/agent/<uuid>`), nome de env (`USM_AUTORUN_NO_PROGRESS_MAX`), nome de pacote kebab?
 *
 * MESMA régua do `looksLikeHumanIdentifier` (scripts/git-hooks/scan-secrets.mjs), reimplementada aqui de
 * propósito: um import daqui para `scripts/` amarraria o pacote publicável ao layout do umbrella.
 *
 * Exigir que CADA segmento tenha forma de palavra/hex é o que impede o buraco óbvio da versão "só
 * segmentado basta": um token base64url às vezes cai com `-`/`_` bem espalhados, e os pedaços dele
 * (`Kj8mQ2xR`) não são camelCase, nem SCREAMING, nem hex — logo não passam.
 */
function ehIdentificadorSegmentado(tok: string): boolean {
  const partes = tok.split(/[-_]/).filter(Boolean);
  return partes.length >= 2 && partes.every(ehSegmentoDeIdentificador);
}

/**
 * Larguras de DIGEST que aparecem legitimamente num diagnóstico do train: sha1 (40), sha256 (64),
 * sha512 (128). Hex FORA dessas larguras não é nome de objeto git — e 32 chars hex é justamente a forma
 * de chave de provedor que a outra camada desta onda passou a detectar (`looksLikeSecretValue` com
 * `declared`), então ela não pode sair intacta daqui.
 *
 * RISCO RESIDUAL assumido e consciente: um hex de exatamente 40/64/128 chars é indistinguível de um sha
 * pela forma, e o journal do train é feito deles — elidi-los tornaria toda mensagem de integração
 * ilegível, o que faria alguém desligar o portão inteiro.
 */
const LARGURAS_DE_DIGEST = new Set([40, 64, 128]);

/**
 * ELIDE material com forma de credencial de um texto que vai para `findings[].detail`.
 *
 * O que este controle IMPEDE: que bytes de um segredo cheguem a board-data COMMITADA. O `detail` do
 * blocker de secret-scan é texto LIVRE de quem chamou — o merge train passa a mensagem de erro do
 * `exec`, que carrega a linha de comando e o stderr do filho — e o card é gravado por
 * `updateCardOnDisk` e integrado pelo train: depois daqui é commit, e commit de segredo não se desfaz.
 * O scanner da raiz já mascara o VALOR nos achados dele (`redact`, scan-secrets.mjs); esta é a segunda
 * trava, para o caminho em que o texto NÃO veio de lá.
 *
 * Deliberadamente MAIS agressivo que o detector do scanner (piso de 24 chars, não 32): aqui o custo de
 * um falso positivo é um identificador elidido numa mensagem de diagnóstico, e o de um falso negativo é
 * credencial publicada.
 *
 * A régua é a FORMA DO TOKEN (segmentação e largura), não a contagem de classes de caractere. Foi a
 * contagem que abriu duas portas grandes, e as duas eram formas COMUNS de credencial:
 *  - `!/[A-Z]/ → intacto` devolvia inteiro qualquer token sem maiúscula — e metade dos alfabetos de
 *    credencial (hex, base32 minúsculo, boa parte das chaves de provedor) não tem uma;
 *  - a isenção `^[0-9a-fA-F-]+$` devolvia inteiro TODO hex, inclusive os 32 chars que são exatamente a
 *    forma que a outra camada desta onda foi alargada para DETECTAR. O detector pegava e o portão
 *    deixava os bytes seguirem para `findings[].detail` — board-data commitada.
 *
 * O que fica legível, e é por isso que o portão sobrevive ao uso: runId/branch/UUID e nome de env
 * (identificador segmentado), sha1/sha256/sha512 (largura de digest), caminho (partido por `/` e `.`,
 * que não estão no alfabeto de `RUN_OPACO`) e identificador de código sem dígito.
 */
export function elideCredentialBytes(text: string): string {
  const oculto = (tok: string) => `oculto (${tok.length} chars)`;
  return text.replace(RUN_OPACO, (tok) => {
    if (ehIdentificadorSegmentado(tok)) return tok; // runId, UUID, branch, SCREAMING_SNAKE, kebab
    const ehHex = /^[0-9a-fA-F]+$/.test(tok);
    if (ehHex && LARGURAS_DE_DIGEST.has(tok.length)) return tok; // sha de commit / digest
    // Hex fora de largura de digest é credencial até prova em contrário, e SEM checar entropia: a
    // entropia empírica de ~24-32 amostras de um alfabeto de 16 símbolos flutua em torno do próprio
    // teto (4.0), então usar 3.6 como corte aqui é sorteio, não régua.
    if (ehHex) return oculto(tok);
    if (!/[0-9]/.test(tok)) return tok; // sem dígito: nome de função/identificador, não sorteio
    if (shannonEntropy(tok) < 3.6) return tok;
    return oculto(tok);
  });
}

/**
 * SM-08 — PURE: compute the card's `findings[]` after the merge-commit secret scan blocked the push.
 * Idempotent by {@link secretScanBlockerFindingId}: a first block APPENDS a `security:blocker` finding;
 * a retry that re-blocks REFRESHES that same finding in place (never duplicates). Other findings are
 * preserved. A blocker `open` finding holds the card out of `qa-automatizado` (gate `hasNoBlockers`).
 *
 * O detail passa por {@link elideCredentialBytes} ANTES do corte de 200 chars — cortar primeiro deixaria
 * a metade de um segredo atravessar, e é este detail que o train commita no card.
 */
export function withSecretScanBlockerFinding(existing: Finding[], runId: string, detail: string): Finding[] {
  const d = elideCredentialBytes(detail).slice(0, 200) || undefined;
  return upsertFinding(existing, {
    id: secretScanBlockerFindingId(runId),
    lens: "security",
    severity: "blocker",
    title: "secret scan bloqueou o push do merge commit",
    ...(d ? { detail: d } : {}),
    status: "open",
  });
}

// ── CARD-scoped mechanism-blocker prefixes — the single source shared by two resolvers ──
/**
 * PURE predicate — is `id` a CARD-scoped MECHANISM blocker (a train stamps one when a split HALF fails to
 * land: code-not-landed / data-not-landed / merge-back)? The three prefixes are shared by
 * {@link withRunBlockersResolved}'s card-wide arm and by {@link supersedeStaleTerminalBlockers}, so a
 * future 4th mechanism prefix can't be wired into one and forgotten in the other. Deliberately EXCLUDES the
 * run-scoped `gate-`/`secret-scan-` ids and every human/review/deploy-failure finding (all disjoint ids) —
 * those are never mechanism residue.
 */
export function isMechanismBlockerId(id: string): boolean {
  return (
    id.startsWith(MERGE_BACK_FINDING_PREFIX) ||
    id.startsWith(CODE_NOT_LANDED_FINDING_PREFIX) ||
    id.startsWith(DATA_NOT_LANDED_FINDING_PREFIX)
  );
}

// ── clear a run's OWN auto-stamped blockers on successful integration (audit #6) ──
/**
 * PURE: compute the card's `findings[]` after a run's branch SUCCESSFULLY integrates — flips THIS
 * run's own gate-failure + secret-scan blockers (by {@link gateBlockerFindingId} /
 * {@link secretScanBlockerFindingId}) from `open` → `fixed`. Idempotent and RUN-SCOPED: it touches
 * ONLY the two ids the train itself stamped for `runId`, never a human/harness-review finding (different
 * ids). Without this, a `retry`-then-pass (or any re-merge after a gate/secret block) left a stale
 * `open` blocker, and `hasNoBlockers` held the card out of `qa-automatizado` FOREVER with no automated
 * remedy (audit #6 — durable, self-perpetuating spec/reality drift). Other findings are untouched.
 */
export function withRunBlockersResolved(existing: Finding[], runId: string, stamp?: FindingStatusStamp): Finding[] {
  const ours = new Set([gateBlockerFindingId(runId), secretScanBlockerFindingId(runId)]);
  // story-yy3hds: o blocker de merge-back é CARD-scoped (prefixo), não run-scoped — ele foi stampado
  // por um run ANTERIOR que falhou, então uma integração posterior BEM-SUCEDIDA de qualquer run deste
  // card prova que o caminho voltou a funcionar (e o board-data novo supersede o worktree preservado).
  // Sem isto, o blocker antigo (id do run morto) travaria hasNoBlockers para sempre — o mesmo drift
  // auto-perpetuante do audit #6. autonomy-reliability WS-1.2: o blocker `code-not-landed-*` é do MESMO
  // molde — CARD-scoped, stampado por um run cujo código não aterrissou; uma integração posterior
  // bem-sucedida (o redrive que finalmente aplicou, ou um re-run humano) prova que o código chegou ao
  // stage → limpa o blocker retroativo (senão o card fica travado em revisar-codigo para sempre).
  // autonomy-endgame WS-3.4: `data-not-landed-*` é o ESPELHO exato do de cima e limpa pela MESMA porta —
  // uma integração posterior bem-sucedida deste card prova que o board-data chegou a main (foi o retry da
  // metade que aplicou, ou um re-run). Auto-limpante pelo mesmo caminho do irmão, por construção.
  return existing.map((f) =>
    (ours.has(f.id) || isMechanismBlockerId(f.id)) && f.status === "open"
      ? withStatusStamped(f, "fixed", stamp)
      : f,
  );
}

// ── supersede residual mechanism blockers when a card ENTERS a terminal status ──
/**
 * PURE (mirrors the {@link withToolingUnusedResolved} resolver family): when a card ENTERS a TERMINAL
 * status, supersede (open → fixed, stamped) its residual CARD-scoped MECHANISM blockers
 * ({@link isMechanismBlockerId} — code/data-not-landed + merge-back). Returns `null` when there is nothing
 * open to supersede, so the IO caller SKIPS the write — terminal entry can re-fire (boot recovery, the
 * optimistic `autoEnterTerminal → concluida` path) and a no-op write would spin the fs-watch→eval→write loop.
 *
 * WHY it is honest, not a bypass: `hasNoBlockers` gates entry to `qa-automatizado`, so a card cannot ADVANCE
 * toward terminal with an open mechanism blocker — the ONLY way a terminal card carries one is a blocker
 * stamped AFTER it already passed the gate (the recovery sweep re-processing a stale run branch; WS-1.2). At
 * terminal the ship already happened by another path (or the card was retired), so the "código/board-data não
 * aterrissou" blocker is provably stale/moot → superseding it is the truth, and it is what stops the false red
 * "Bloqueio" chip stranded on a shipped card — the self-perpetuating drift {@link withRunBlockersResolved}
 * guards against, which NEVER fires for a terminal card because it never re-integrates. It NEVER touches the
 * run-scoped `gate-`/`secret-scan-` blockers (terminal is no evidence a test/secret defect was fixed) nor any
 * deploy-failure/human/review finding (disjoint ids). Only `status === "open"` flips, so an operator's
 * `wontfix`/`acknowledged` survives.
 */
export function supersedeStaleTerminalBlockers(existing: Finding[], stamp?: FindingStatusStamp): Finding[] | null {
  if (!existing.some((f) => isMechanismBlockerId(f.id) && f.status === "open")) return null;
  return existing.map((f) =>
    isMechanismBlockerId(f.id) && f.status === "open" ? withStatusStamped(f, "fixed", stamp) : f,
  );
}

/**
 * PURE — the OPEN `blocker` findings that should be treated as LIVE for a card, given whether the card is
 * in a TERMINAL status. This is the SINGLE source every blocker READ-surface consumes (the Kanban chip, the
 * card-document blockers block, the MCP `slim` count, the step rollup) so "a terminal card shows no stale
 * mechanism blocker" holds UNIFORMLY — the display backstop for the {@link supersedeStaleTerminalBlockers}
 * write-path, and the ONLY defense for the routes a server chokepoint can't intercept (the harness-retire skill
 * archives to `arquivados` by writing the card `.md` directly, integrated by the merge train — no supersede
 * runs there, yet the residual mechanism blocker is exactly as stale). On a terminal card the residual
 * mechanism blockers ({@link isMechanismBlockerId}) are dropped; a genuine NON-mechanism blocker still counts
 * (it would be actionable — though `hasNoBlockers` normally prevents a card reaching terminal with one).
 * `isTerminal=false` (the default) returns EVERY open blocker — byte-identical to the pre-fix
 * `severity==="blocker" && status==="open"` filter, so non-terminal callers are unchanged.
 */
export function liveOpenBlockers(findings: Finding[] | undefined, isTerminal = false): Finding[] {
  const open = (findings ?? []).filter((f) => f.severity === "blocker" && f.status === "open");
  return isTerminal ? open.filter((f) => !isMechanismBlockerId(f.id)) : open;
}

// ── merge-back failure preserved the worktree (story-yy3hds) ────────────────
/** Prefixo dos findings de falha de merge-back — prefix-matched por {@link withRunBlockersResolved}
 * (qualquer integração posterior do card resolve o blocker; ver o racional lá). */
export const MERGE_BACK_FINDING_PREFIX = "merge-back-";

/** Stable id do finding de falha de merge-back — um por `runId`, re-stamp refresca em vez de duplicar. */
export function mergeBackFailureFindingId(runId: string): string {
  return `${MERGE_BACK_FINDING_PREFIX}${runId}`;
}

/**
 * story-yy3hds — PURE: o sweep-commit/detach/enqueue do merge-back falhou em TODAS as tentativas e o
 * engine PRESERVOU o worktree + branch (em vez do antigo remove --force, que destruía as edições não-
 * commitadas do run enquanto ele assentava "ok" — o sucesso-fantasma do run 5a3103d3). O finding é
 * `blocker`/`open` — segura o card no gate `hasNoBlockers` até um humano recuperar o worktree citado
 * OU um re-run integrar com sucesso (auto-resolve via {@link withRunBlockersResolved}).
 */
export function withMergeBackFailureFinding(
  existing: Finding[],
  runId: string,
  worktreePath: string,
  branch: string,
  detail: string,
): Finding[] {
  return upsertFinding(existing, {
    id: mergeBackFailureFindingId(runId),
    lens: "general",
    severity: "blocker",
    title: "merge-back falhou — worktree preservado, trabalho NÃO integrado",
    detail: `${detail.slice(0, 200)} · worktree: ${worktreePath} · branch: ${branch}`,
    status: "open",
  });
}

// ── conflicted-branch preserved (SM-07) ─────────────────────────────────────
/** Stable id for the SM-07 conflicted-branch finding — one per `runId`, so re-stamping the same
 * redrive REFRESHES the finding instead of stacking duplicates. */
export function conflictedBranchFindingId(runId: string): string {
  return `conflicted-${runId}`;
}

/**
 * SM-07 — PURE: compute the card's `findings[]` after a redrive PRESERVED the conflicted branch.
 * Appends (or refreshes, idempotent by {@link conflictedBranchFindingId}) a `low`/`general` finding
 * naming the `conflicted/<orig>` branch so the operator can find and apply the original diff if the
 * regenerated run diverges. Severity `low` → does NOT block the `hasNoBlockers` gate (only `blocker`
 * does); the operator can mark it `wontfix` once they no longer need the preserved branch.
 */
export function withConflictedBranchFinding(
  existing: Finding[],
  runId: string,
  conflictedBranch: string,
  driveAttempt: number,
): Finding[] {
  return upsertFinding(existing, {
    id: conflictedBranchFindingId(runId),
    lens: "general",
    severity: "low",
    title: `Branch preservada: ${conflictedBranch}`,
    detail: `Tentativa ${driveAttempt}: conflito no merge; a branch foi renomeada para inspeção manual antes de re-executar a skill.`,
    status: "open",
  });
}

// ── code-not-landed blocker (autonomy-reliability WS-1.2) ───────────────────
/** Prefixo dos findings "código não aterrissou" — prefix-matched por {@link withRunBlockersResolved}
 * (qualquer integração posterior BEM-SUCEDIDA do card prova que o código chegou ao stage → limpa o
 * blocker; mesmo racional do {@link MERGE_BACK_FINDING_PREFIX}). */
export const CODE_NOT_LANDED_FINDING_PREFIX = "code-not-landed-";

/** Stable id do finding "código não aterrissou" — um por `runId` (o run cuja metade CODE do split
 * falhou), então re-stampar refresca em vez de empilhar. */
export function codeNotLandedFindingId(runId: string): string {
  return `${CODE_NOT_LANDED_FINDING_PREFIX}${runId}`;
}

/**
 * autonomy-reliability WS-1.2 — PURE: compute a card's `findings[]` após a metade CODE do split (agora
 * PRIMEIRA — ADR do train atômico) falhar em aterrissar o código em `stage`. Com o CODE-antes-de-DATA, a
 * metade DATA NÃO roda quando o código falha → o card NÃO avança e as tasks NÃO viram `done`; este finding
 * `blocker`/`open` segura o card no gate `hasNoBlockers` (lane travado do Inbox) para a telemetria-`ok`
 * deixar de contradizer o kanban ("done" fantasma sem código — a causa do lost-impl do story-qb8z2c, ~$13
 * de re-implementação). Nomeia a branch preservada (onde o código encalhado vive, p/ recuperar via
 * cherry-pick — ver WS-2) e o detalhe do conflito. Idempotente por {@link codeNotLandedFindingId}; um
 * redrive/re-run bem-sucedido auto-resolve via {@link withRunBlockersResolved}.
 */
export function withCodeNotLandedFinding(
  existing: Finding[],
  runId: string,
  preservedBranch: string,
  detail?: string,
): Finding[] {
  const tail = detail ? ` · ${detail.slice(0, 240)}` : "";
  return upsertFinding(existing, {
    id: codeNotLandedFindingId(runId),
    lens: "general",
    severity: "blocker",
    title: "integração falhou — código NÃO aterrissou (card não avançou)",
    detail:
      `A metade CODE do split falhou (run ${runId}): o código não aplicou/aterrissou em stage, então a ` +
      `metade DATA não rodou e o card permaneceu no status pré-integração (a verdade). Código preservado ` +
      `na branch "${preservedBranch}" — recupere-o (inspeção / git cherry-pick) ou re-execute a skill; ` +
      `uma integração posterior bem-sucedida limpa este blocker automaticamente.${tail}`,
    status: "open",
  });
}

// ── data-not-landed blocker (autonomy-endgame WS-3.4) ───────────────────────
/** Prefixo do finding "board-data não aterrissou" — o ESPELHO de {@link CODE_NOT_LANDED_FINDING_PREFIX},
 *  prefix-matched pelo mesmo {@link withRunBlockersResolved} (a metade de dados aterrissando depois limpa
 *  o blocker sozinha). */
export const DATA_NOT_LANDED_FINDING_PREFIX = "data-not-landed-";

/** Stable id do finding "board-data não aterrissou" — um por `runId`, então re-stampar refresca em vez
 *  de empilhar. */
export function dataNotLandedFindingId(runId: string): string {
  return `${DATA_NOT_LANDED_FINDING_PREFIX}${runId}`;
}

/**
 * autonomy-endgame WS-3.4 — PURE: o card's `findings[]` depois que a metade DATA do split falhou em aplicar
 * em `main` COM o código já a salvo em `stage`. É o ESPELHO que faltava.
 *
 * A invariante do train atômico (`dataLanded ⇒ codeStaged`) protege contra dados-sem-código, e o irmão
 * {@link withCodeNotLandedFinding} cobre código-que-não-aterrissou. A assimetria: NINGUÉM modelou
 * código-aterrissou-mas-dados-não. O doc do detector dizia, sobre esse caso, *"codeStaged true → excluded,
 * **code is safe on `stage`**"* — verdadeiro sobre o CÓDIGO e cego sobre o CARD. O resíduo exato:
 * story-novo-item ficou em `desenvolver` com 6 tasks `false` enquanto a feature ESTAVA staged, o gate
 * `hasBuildEvidence` recusou pedindo "marque as tasks como done", e ninguém viu — 2 entries assim estão
 * presas no runtime agora (a779b5be, f873d987).
 *
 * O detalhe NOMEIA A RECUPERAÇÃO CERTA e recusa a errada, porque o instinto do operador diante de "falhou"
 * é re-drivar — e re-drivar aqui re-implementa código JÁ PUBLICADO (o padrão qb8z2c, ~$13) sem tocar na
 * causa (a falha foi no `git apply`, não na skill). Idempotente por {@link dataNotLandedFindingId}; a
 * metade de dados aterrissando depois auto-resolve via {@link withRunBlockersResolved}.
 */
export function withDataNotLandedFinding(
  existing: Finding[],
  runId: string,
  detail?: string,
): Finding[] {
  const tail = detail ? ` · ${detail.slice(0, 240)}` : "";
  return upsertFinding(existing, {
    id: dataNotLandedFindingId(runId),
    lens: "general",
    severity: "blocker",
    title: "integração meio-aterrissada — código em stage, board-data NÃO em main",
    detail:
      `A metade CODE do split aterrissou (o código do run ${runId} está em "stage" e VAI subir na próxima ` +
      `release, como qualquer código staged), mas a metade DATA não aplicou em "main" — então o card ` +
      `permaneceu no status pré-integração e as tasks não foram marcadas. O card está parado; a feature, não. ` +
      `RECUPERAÇÃO: retentar a metade de dados (o patch já está em disco: split-${runId}-data.patch). ` +
      `NÃO re-drivar: um redrive re-implementaria código já publicado e não consertaria os dados (a falha ` +
      `foi no git apply, não na skill). Uma aterrissagem posterior da metade de dados limpa este blocker ` +
      `automaticamente.${tail}`,
    status: "open",
  });
}

// ── cooperative structured-output validation of a lens sub-agent's finding batch (harness #2) ──
/**
 * PURE: validate a harness-review lens sub-agent's `finding-batch` payload STRICTLY — the CANONICAL
 * reference for the shape the skill instructs each lens to emit (a JSON array of authorable findings:
 * `{ lens, severity, title, detail?, file?, line?, suggestion? }`, NO `id`/`status`). Accepts `raw` as
 * an already-parsed ARRAY, or as a STRING it `JSON.parse`s first (a fenced ```json finding-batch block).
 *
 * COOPERATIVE, not enforceable: the lens/specialist sub-agents run at the 2nd level INSIDE the headless
 * `claude -p`, which the engine never sees — so the engine cannot force this. The skill (the orchestrator
 * the engine DOES spawn) calls the equivalent of this BEFORE writing findings to the card; if it fails,
 * the skill re-asks the sub-agent (≤2×) and otherwise FAILS CLOSED (keeps the card put, writes nothing).
 * This function is the single source of the strict shape that prose mirrors. NOT the tolerant
 * `coerceFindings` (repo.ts) — that stays the lenient GENERAL read path; this is the strict author path.
 *
 * FAIL-CLOSED: `ok` is `true` ONLY when the input parses AND every item validates. On any bad item (or a
 * `JSON.parse` failure), `ok` is `false`; `items` carries only the items that DID validate, and `errors`
 * describes each failure (by `item[<index>]`, or a top-level parse/shape message). Never throws.
 */
export function parseFindingBatch(raw: unknown): { ok: boolean; items: FindingBatchItem[]; errors: string[] } {
  let value: unknown = raw;
  // A fenced ```json finding-batch block arrives as a STRING — parse it first.
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (e) {
      return { ok: false, items: [], errors: [`JSON inválido: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  if (!Array.isArray(value)) {
    return { ok: false, items: [], errors: ["finding-batch deve ser um ARRAY de findings"] };
  }

  const items: FindingBatchItem[] = [];
  const errors: string[] = [];
  value.forEach((entry, i) => {
    const parsed = FindingBatchItemSchema.safeParse(entry);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
        .join("; ");
      errors.push(`item[${i}] inválido: ${detail}`);
    }
  });

  // Fail-closed: ok only when EVERY item validated (and the array parsed at all).
  return { ok: errors.length === 0, items, errors };
}

// ── ADR-063 (4d) failure taxonomy ───────────────────────────────────────────
/**
 * Signals a QA/verification run already has when a spec goes red — the INPUTS to the deterministic
 * failure classifier. Kept minimal + explicit so the attribution is a pure function of observable
 * facts, not an LLM judgement call (the turns the ADR wants to reclaim).
 */
export interface FailureSignals {
  /** raw error/log text from the failing run/spec (the primary infra/test discriminator) */
  message?: string | null;
  /** the SAME criterion passes at another (cheaper) layer → the failing spec/layer is the defect, not the app */
  passedAtOtherLayer?: boolean;
  /** an assertion about PRODUCT behaviour failed (the criterion is genuinely unmet) */
  criterionUnmet?: boolean;
}

// Env/stack breakage — the run's environment failed, NOT the card. Mirrors the "QA infra" vocabulary
// enumerated in .claude/skills/harness-qa/SKILL.md so prose and code stay in lockstep.
const INFRA_PATTERNS: RegExp[] = [
  /MODULE_NOT_FOUND/i,
  /cannot find module/i,
  /enter a string value/i, // interactive emulator prompt that hangs headless
  /EADDRINUSE|address already in use|port \d+ (is )?(already )?in use/i,
  /:(3008|9099|5001|8080|9199)\b/, // storymap / shared emulator ports contended
  /(javascript )?heap out of memory|out of memory|oom-?killed/i,
  /ENOENT[\s\S]*node_modules/i,
  /firebase[\s\S]{0,60}emulator/i, // "the firebase emulator suite" — order-independent of a leading "could not start"
  /emulator[\s\S]{0,40}(exited|crashed|failed|could not|não sob|error)/i,
  /command not found|spawn \S+ ENOENT/i,
  /ETIMEDOUT|timed out (starting|booting|waiting for the (dev )?server)/i,
];
// Bad spec/selector — the test is wrong, not the app.
const TEST_PATTERNS: RegExp[] = [
  /strict mode violation/i,
  /waiting for (selector|locator)/i,
  /locator\(/i,
  /getby(testid|role|text)\b/i,
  /selector .* resolved to \d+ elements/i,
  /no (node|element) found for selector/i,
];

/**
 * ADR-063 (4d): auto-attribute a QA red to `infra` | `test` | `app` from observable signals — so the
 * agent stops spending turns DECIDING whose defect it is. Deterministic + ordered (most-specific first):
 * env breakage (infra) → bad-spec/selector or passes-elsewhere (test) → genuine criterion miss (app).
 * Returns undefined when there is no signal to attribute (stays sparse). PURE.
 */
export function classifyFailure(signals: FailureSignals): FailureClass | undefined {
  const msg = typeof signals.message === "string" ? signals.message : "";
  if (msg && INFRA_PATTERNS.some((re) => re.test(msg))) return "infra";
  if (signals.passedAtOtherLayer === true) return "test";
  if (msg && TEST_PATTERNS.some((re) => re.test(msg))) return "test";
  if (signals.criterionUnmet === true) return "app";
  // A plain assertion failure (message present, none of the above) is the product not meeting the
  // criterion → app. With no message and no flag there is nothing to attribute.
  if (msg) return "app";
  return undefined;
}

// ── ADR-063 (4b) same-column-no-progress loop-guard finding ─────────────────
/** Stable id for the loop-guard finding of a card — ONE per card (not per run), so the guard tripping
 * again for the same card refreshes/no-ops the same finding instead of stacking duplicates. */
export function loopGuardFindingId(cardId: string): string {
  return `loop-guard-${cardId}`;
}

/**
 * ADR-063 (4b) — PURE: compute a card's `findings[]` after the autorun loop-guard tripped (the card ran
 * `runs` consecutive non-advancing times in `status`). Idempotent by {@link loopGuardFindingId} AND
 * null-when-unchanged (via {@link upsertFindingIfChanged}) so the guard's `updateCardOnDisk` write can't
 * spin the fs-watcher into an infinite re-eval loop. Severity `high` (NOT `blocker` — it must NOT gate
 * `hasNoBlockers`/`revisao`; it's an operator alert, not a code defect). Returns null when the identical
 * finding is already present. Detail spells out the override paths (move / manual run / raise the cap).
 */
export function withLoopGuardFinding(
  existing: Finding[],
  cardId: string,
  status: string,
  runs: number,
): Finding[] | null {
  return upsertFindingIfChanged(existing, {
    id: loopGuardFindingId(cardId),
    lens: "general",
    severity: "high",
    title: "autorun em loop — mesmo status sem avançar",
    detail:
      `O autorun rodou ${runs} vez(es) seguidas em '${status}' sem o card avançar de coluna — ` +
      `circuit-breaker acionado (ADR-063 4b), auto-dispatch pausado para este card. Para destravar: ` +
      `mova o card para outra coluna, rode a skill à mão ("Rodar agora"), ou aumente USM_AUTORUN_NO_PROGRESS_MAX.`,
    status: "open",
  });
}

// ── WS1.4 — pending-effect boot re-fire FAILURE finding ─────────────────────
/** Stable id for the pending-effect re-fire-failed finding — ONE per (card, effect), so a re-fire that
 * fails again on a later boot REFRESHES the same finding instead of stacking duplicates. */
export function pendingEffectFailureFindingId(cardId: string, effect: string): string {
  return `pending-effect-${cardId}-${effect}`;
}

/**
 * WS1.4 — PURE: compute a card's `findings[]` after a boot re-fire of an un-resolved onEnter effect
 * (promote-stage / deploy-board / promote-and-deploy) THREW. Before, `recoverPendingEffects` swallowed
 * that with `.catch(() => {})`, so a re-deployed effect that failed on boot died mute and the card kept
 * lying "liberado/no ar" with un-promoted code. Severity `high` (an operator alert, NOT a `blocker` gate:
 * the effect is one-shot-resolved either way, so this must not wedge `hasNoBlockers`). Idempotent by
 * {@link pendingEffectFailureFindingId}.
 */
export function withPendingEffectFailureFinding(
  existing: Finding[],
  cardId: string,
  effect: string,
  error: string,
): Finding[] {
  return upsertFinding(existing, {
    id: pendingEffectFailureFindingId(cardId, effect),
    lens: "general",
    severity: "high",
    title: "efeito re-disparado no boot FALHOU",
    detail:
      `O efeito onEnter "${effect}" re-disparado na recuperação de boot lançou: ${error.slice(0, 300)}. ` +
      `O card pode ter avançado ("liberado"/"no ar") sem o promote/deploy concluir — verifique manualmente ` +
      `(harness-ship / just orch-deploy) ou rearraste o card.`,
    status: "open",
  });
}

// ── ADR-063 (4a) per-card lifetime $ budget finding ─────────────────────────
/** Stable id for the card-budget finding — ONE per card, so re-tripping refreshes/no-ops it. */
export function cardBudgetFindingId(cardId: string): string {
  return `card-budget-${cardId}`;
}

/**
 * ADR-063 (4a) — PURE: compute a card's `findings[]` after its lifetime $ backstop tripped (the card spent
 * `spentUSD` across `runs` runs, ≥ the `budgetUSD` ceiling). Idempotent + null-when-unchanged (via
 * {@link upsertFindingIfChanged}) so the guard's `updateCardOnDisk` write is loop-safe. Severity `high`
 * (operator alert, not a blocker gate). Returns null when the identical finding already exists.
 */
export function withCardBudgetFinding(
  existing: Finding[],
  cardId: string,
  spentUSD: number,
  budgetUSD: number,
  runs: number,
): Finding[] | null {
  return upsertFindingIfChanged(existing, {
    id: cardBudgetFindingId(cardId),
    lens: "general",
    severity: "high",
    title: "orçamento do card estourado",
    detail:
      `O card gastou $${spentUSD.toFixed(2)} em ${runs} run(s), atingindo o teto de $${budgetUSD.toFixed(2)} ` +
      `(ADR-063 4a) — auto-dispatch pausado para este card. Para retomar: aumente USM_AUTORUN_CARD_BUDGET_USD ` +
      `ou investigue por que ele não avança.`,
    status: "open",
  });
}

/** Stable id of the capability-unavailable diagnostic — one per CAPABILITY, card-scoped. Per-capability
 *  (not per-run) so the same missing browser REFRESHES one entry instead of stacking one per attempt. */
export function capabilityUnavailableFindingId(capability: string): string {
  return `capability-unavailable-${capability}`;
}

/**
 * A step could not run because a capability it REQUIRES could not be proved on this host.
 *
 * `severity: "high"` + `failureClass: "infra"` — deliberately NOT a `blocker`, for the same reason
 * {@link buildRunDeathFinding} isn't: this is a DIAGNOSIS, not a veto on the card. The distinction is the
 * whole point of the class. A blocker says "this card's work is wrong"; this says "this HOST can't do the
 * work". Filing it as a blocker (which is what the incident's `harness-qa` run did) hides an environment
 * defect inside the product-defect channel: the card stalls behind a veto no card-level change can lift,
 * the cockpit shows it beside real code findings, and nothing records that EVERY card hitting this step
 * will fail identically.
 *
 * The card still cannot advance dishonestly — the step's own gate (e.g. `hasQaPassed`, which requires the
 * visual evidence) is what holds it, and holds it with the right message. Idempotent per capability.
 */
export function withCapabilityUnavailableFinding(
  existing: Finding[],
  capability: string,
  stepLabel: string,
  detail: string,
): Finding[] | null {
  return upsertFindingIfChanged(existing, {
    id: capabilityUnavailableFindingId(capability),
    lens: "general",
    severity: "high",
    failureClass: "infra",
    title: `capacidade "${capability}" indisponível neste host — ${stepLabel} não pôde rodar`,
    detail:
      `${detail}. O run NÃO foi disparado (nenhum token gasto): provar antes é o que evita a varredura que ` +
      `descobre a ausência depois de subir stack e semear dados. Isto é AMBIENTE, não defeito do card — ` +
      `nenhuma mudança no card conserta, e todo card que passar por este passo vai parar igual. ` +
      `Conserto: instale/plugue o provedor (ou declare um \`fallback\` que funcione neste host em ` +
      `board.yaml → toolConfigs) — o próximo dispatch re-testa sozinho, sem restart.`,
    status: "open",
  });
}

/** CLEAR the capability diagnostic once a later dispatch proved the capability. Returns null when nothing
 *  is open (skips the write — no write→watch→eval loop), mirroring the other resolvers here. */
export function withCapabilityUnavailableResolved(
  existing: Finding[],
  capability: string,
  stamp?: FindingStatusStamp,
): Finding[] | null {
  const id = capabilityUnavailableFindingId(capability);
  if (!existing.some((f) => f.id === id && f.status === "open")) return null;
  return existing.map((f) => (f.id === id && f.status === "open" ? withStatusStamped(f, "fixed", stamp) : f));
}
