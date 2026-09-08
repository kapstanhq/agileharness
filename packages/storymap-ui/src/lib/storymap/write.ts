import { promises as fs } from "node:fs";
import matter from "gray-matter";
import yaml from "js-yaml";
import { atomicWriteFile } from "./atomic-write";
import { parseCard } from "./contracts";
import { pinCardId } from "./id";
import { boardConfigPath, cardPath, cardsDir, trashDir, trashedCardPath } from "./paths";
import { placementSpec, placementViolation } from "./gate-core";
import { deriveBoardConfigForPersist, readBoardConfig, readCard } from "./repo";
import { withKeyedLock } from "./serialize";
import { isReopenMode } from "./types";
import type { BoardConfig, Card, TrashManifest } from "./types";
import { scheduleBoardDataFlush } from "./runner/board-data-flush";
import { removeTrashEntry, writeTrashManifest } from "./trash";

function todayISO(): string {
  // Server runtime — Date is fine here (unlike workflow scripts).
  return new Date().toISOString().slice(0, 10);
}

/** Lock key serializing every in-process mutation of ONE card file. */
function cardLockKey(boardId: string, cardId: string): string {
  return `card:${boardId}/${cardId}`;
}

/**
 * Board-scoped CREATE lock — serializes the read-all-ids → mint-id → writeCard sequence of the create
 * paths (createCardAction / commitProposalAction / usm_capture commit). The per-card lock can't cover
 * this: the id does not exist until AFTER the unlocked mint, so two concurrent creates of the same
 * DETERMINISTIC slug id (same type+title across the UI + an MCP create) could both observe a free id and
 * the second writeCard would silently overwrite the first card's file. This serializes ONLY creation per
 * board (one short-lived chain per board key); per-card edits + reads stay fully parallel. The nested
 * per-card lock inside writeCard is a distinct key → no deadlock. (createcard-toctou)
 */
export function withCreateLock<T>(boardId: string, fn: () => Promise<T>): Promise<T> {
  return withKeyedLock(`create:${boardId}`, fn);
}

/** Build the ordered frontmatter object persisted at the top of a card file. */
export function cardToFrontmatter(card: Card): Record<string, unknown> {
  const isStory = card.type === "story";
  return {
    id: card.id,
    type: card.type,
    title: card.title,
    // storyType + narrative are story-only; the backbone (activity/step) stays lean.
    ...(isStory ? { storyType: card.storyType ?? "user" } : {}),
    status: card.status ?? null,
    parent: card.parent ?? null,
    // Dual-track attribution override (sparse): emit ONLY for a DELIVERY story, keyed on the
    // CURRENT storyType — so a story reclassified user→delivery drops a stale `serves` on its
    // next write, and a user story never carries one. Absent serves means "attribution = parent".
    ...(card.serves && isStory && card.storyType && card.storyType !== "user"
      ? { serves: card.serves }
      : {}),
    // Per-instance routing override (pipeline-owned) — sparse: emit ONLY when there is something to route
    // by (a non-empty skip set OR a WS4 profile/model-effort cap). Absent ⇒ the rules decide live. The
    // WS4 sub-fields (profile/modelCap/effortCap/rationale) are each emitted sparsely — a caps-only routing
    // (empty skips, express profile) round-trips instead of being dropped as "no override".
    ...(card.routing &&
    (card.routing.skips?.length || card.routing.profile || card.routing.modelCap || card.routing.effortCap)
      ? {
          routing: {
            skips: card.routing.skips ?? [],
            decidedBy: card.routing.decidedBy,
            decidedAt: card.routing.decidedAt,
            ...(card.routing.profile ? { profile: card.routing.profile } : {}),
            ...(card.routing.modelCap ? { modelCap: card.routing.modelCap } : {}),
            ...(card.routing.effortCap ? { effortCap: card.routing.effortCap } : {}),
            ...(card.routing.rationale ? { rationale: card.routing.rationale } : {}),
          },
        }
      : {}),
    release: card.release ?? null,
    // SM-02: sparse — only emitted when the story was routed to the unmapped backlog.
    ...(card.unplaced ? { unplaced: true } : {}),
    // WS6 (F5): provenance + explicit unplaced-ack — sparse (a legacy card carries neither).
    ...(card.via ? { via: card.via } : {}),
    ...(card.unplacedAck ? { unplacedAck: { by: card.unplacedAck.by, at: card.unplacedAck.at } } : {}),
    personas: card.personas ?? [],
    systems: card.systems ?? [],
    links: (card.links ?? []).map((l) => ({ rel: l.rel, to: l.to })),
    ...(isStory
      ? {
          narrative: {
            role: card.narrative?.role ?? null,
            want: card.narrative?.want ?? null,
            soThat: card.narrative?.soThat ?? null,
          },
        }
      : {}),
    acceptance: card.acceptance ?? [],
    tasks: (card.tasks ?? []).map((t) => ({ id: t.id, title: t.title, done: t.done })),
    rice: {
      reach: card.rice?.reach ?? null,
      impact: card.rice?.impact ?? null,
      confidence: card.rice?.confidence ?? null,
      effort: card.rice?.effort ?? null,
    },
    kano: card.kano ?? null,
    funnelStage: card.funnelStage ?? null,
    // Prioridade argumentada (reasoning-first) — esparso: só emitido quando avaliada.
    ...(card.priorityCall
      ? {
          priorityCall: {
            rank: card.priorityCall.rank,
            rationale: card.priorityCall.rationale,
            ...(card.priorityCall.riskiestAssumption ? { riskiestAssumption: card.priorityCall.riskiestAssumption } : {}),
            source: card.priorityCall.source,
            assessedAt: card.priorityCall.assessedAt,
            // Ordinais WSJF — esparsos: um call legado (sem eles) continua serializando idêntico.
            // `cohortAt` sai como String porque o YAML re-lê um ISO nu como Date e quebra o round-trip.
            ...(card.priorityCall.wsjf
              ? {
                  wsjf: {
                    value: card.priorityCall.wsjf.value,
                    urgency: card.priorityCall.wsjf.urgency,
                    unlock: card.priorityCall.wsjf.unlock,
                    size: card.priorityCall.wsjf.size,
                    basis: card.priorityCall.wsjf.basis ?? [],
                    cohortSize: card.priorityCall.wsjf.cohortSize ?? 0,
                    cohortAt: String(card.priorityCall.wsjf.cohortAt ?? ""),
                  },
                }
              : {}),
          },
        }
      : {}),
    // Lean bet block + authorship class — sparse. D15 field-drop fix: bet/owner were in the Zod
    // contract AND coerceCard, but never serialized — any app write silently erased them. The bet is
    // emitted only when it has assumptions (mirrors coerceBet, which nulls an assumption-less block).
    ...(card.bet?.assumptions?.length
      ? {
          bet: {
            assumptions: card.bet.assumptions,
            ...(card.bet.riskiestAssumption ? { riskiestAssumption: card.bet.riskiestAssumption } : {}),
            experimentStatus: card.bet.experimentStatus,
          },
        }
      : {}),
    ...(card.owner ? { owner: card.owner } : {}),
    // Triage/intake (ADR-056) — lean: only emitted when set (keeps build cards slim).
    ...(card.severity ? { severity: card.severity } : {}),
    // Bug priority axes (Fase 2) — only emitted when set.
    ...(card.frequency ? { frequency: card.frequency } : {}),
    ...(typeof card.hasWorkaround === "boolean" ? { hasWorkaround: card.hasWorkaround } : {}),
    ...(card.labels?.length ? { labels: card.labels } : {}),
    ...(card.duplicateOf ? { duplicateOf: card.duplicateOf } : {}),
    ...(card.needsHumanReview ? { needsHumanReview: true } : {}),
    ...(card.capture ? { capture: true } : {}),
    ...(card.container ? { container: card.container } : {}), // D7 — style guide generation container
    // HITL questions — only emitted when present, so cards without any stay lean. Round-trips the
    // structured ask/answer so /perguntas can aggregate them and harness-enrich can read the answers.
    ...(card.questions?.length
      ? {
          questions: card.questions.map((q) => ({
            id: q.id,
            text: q.text,
            ...(q.askedBy ? { askedBy: q.askedBy } : {}),
            ...(q.askedAt ? { askedAt: q.askedAt } : {}),
            status: q.status,
            ...(q.answer ? { answer: q.answer } : {}),
            ...(q.answeredAt ? { answeredAt: q.answeredAt } : {}),
            ...(q.answeredBy ? { answeredBy: q.answeredBy } : {}), // F6.3
            ...(q.options?.length ? { options: q.options } : {}),
            ...(q.mode ? { mode: q.mode } : {}),
            ...(q.selectedOptionIds?.length ? { selectedOptionIds: q.selectedOptionIds } : {}),
            ...(q.context ? { context: q.context } : {}),
            ...(q.recommendation ? { recommendation: q.recommendation } : {}),
          })),
        }
      : {}),
    // Pipeline pointers + findings (Fase C/D) — only emitted when set, so the
    // backbone and un-reviewed cards stay lean. Heavy content lives in sidecars.
    ...(card.techPlanReady ? { techPlanReady: true } : {}),
    ...(card.wireframeChosen ? { wireframeChosen: card.wireframeChosen } : {}),
    // QA-visual regime marker (harness-enrich writes it frontmatter-direct; gate-core reads it). D15
    // field-drop fix: absent from this serializer, the NEXT app write erased it. `false` is a real
    // value (story with no UI surface), so the emit keys on typeof, not truthiness.
    ...(typeof card.hasUiSurface === "boolean" ? { hasUiSurface: card.hasUiSurface } : {}),
    // Superfície MEDIDA pelo engine (não declarada). Mesmo motivo do bloco acima: sem esta linha o
    // PRÓXIMO write do app apagaria a evidência — e o gate voltaria a decidir pelo fallback de tipo.
    ...(card.uiSurfaceEvidence
      ? {
          uiSurfaceEvidence: {
            touched: card.uiSurfaceEvidence.touched,
            at: card.uiSurfaceEvidence.at,
            ...(card.uiSurfaceEvidence.paths?.length ? { paths: [...card.uiSurfaceEvidence.paths] } : {}),
            ...(card.uiSurfaceEvidence.runId ? { runId: card.uiSurfaceEvidence.runId } : {}),
          },
        }
      : {}),
    ...(card.findings?.length
      ? {
          findings: card.findings.map((f) => ({
            id: f.id,
            lens: f.lens,
            severity: f.severity,
            title: f.title,
            ...(f.detail ? { detail: f.detail } : {}),
            ...(f.file ? { file: f.file } : {}),
            ...(f.line != null ? { line: f.line } : {}),
            ...(f.suggestion ? { suggestion: f.suggestion } : {}),
            status: f.status,
            // ADR-063 (4d): round-trip the auto-attributed failure class when present (sparse).
            ...(f.failureClass ? { failureClass: f.failureClass } : {}),
            // WS-2 (2.3): round-trip WHO/WHEN last changed the status (sparse). Without this pair of
            // lines the very next app write would DROP the stamp — the field-drop regression the
            // hasUiSurface comment above records.
            ...(f.statusBy ? { statusBy: f.statusBy } : {}),
            ...(f.statusAt ? { statusAt: f.statusAt } : {}),
          })),
        }
      : {}),
    ...(card.reviewedAt ? { reviewedAt: card.reviewedAt } : {}),
    ...(card.reviewCommit ? { reviewCommit: card.reviewCommit } : {}),
    // QA pointers (Fase QA) — only emitted when set, so un-QA'd cards stay lean.
    ...(card.qaPassed ? { qaPassed: true } : {}),
    ...(card.qaRanAt ? { qaRanAt: card.qaRanAt } : {}),
    ...(card.qaCommit ? { qaCommit: card.qaCommit } : {}),
    // O QUE o QA provou (suíte × tela). `false` é valor real — "rodei e NÃO olhei a tela" é
    // exatamente a informação que o gate precisa —, então emite por typeof, nunca por truthiness.
    ...(card.qaEvidence
      ? {
          qaEvidence: {
            ...(typeof card.qaEvidence.suite === "boolean" ? { suite: card.qaEvidence.suite } : {}),
            ...(typeof card.qaEvidence.visual === "boolean" ? { visual: card.qaEvidence.visual } : {}),
            at: card.qaEvidence.at,
            ...(card.qaEvidence.by ? { by: card.qaEvidence.by } : {}),
          },
        }
      : {}),
    // D14 — style-guide conformance stamp (WS-3), written by harness-qa on a guide-bearing board. Sparse:
    // only emitted once set. MUST round-trip through cardToFrontmatter (every write re-reads+rewrites
    // via updateCardOnDisk) — a field with no serializer here is DROPPED on the very write that sets it.
    ...(card.styleGuideCheck
      ? {
          styleGuideCheck: {
            version: card.styleGuideCheck.version,
            hash: card.styleGuideCheck.hash,
            passed: card.styleGuideCheck.passed,
            at: card.styleGuideCheck.at,
          },
        }
      : {}),
    // Fase 4b staged-release dates + WS1.1 deploy watchdog (pipeline-owned) — these MUST round-trip through
    // cardToFrontmatter (every write re-reads+rewrites via updateCardOnDisk), else the stamp is dropped on the
    // SAME write that sets it and read back as undefined forever: release-aging (stagedAt/WS1.5), the release
    // flow (releasedAt) and the deploy-unsettled watchdog (deployFiredAt/WS1.1) could then NEVER fire.
    ...(card.stagedAt ? { stagedAt: card.stagedAt } : {}),
    ...(card.releasedAt ? { releasedAt: card.releasedAt } : {}),
    // A EVIDÊNCIA que a reconciliação de deploy-failure lê (deploy-reconcile.ts). Mesmo footgun de sempre: se
    // não round-trippar aqui, o carimbo morre no próprio write que o cria — e o card nunca mais sara sozinho.
    ...(card.releasedSha ? { releasedSha: card.releasedSha } : {}),
    ...(card.deployTargets?.length ? { deployTargets: card.deployTargets } : {}),
    ...(card.deployFiredAt ? { deployFiredAt: card.deployFiredAt } : {}),
    // deploy-truth WS-1 — the production proof the terminal gate (hasDeployProof) reads. The stamp is
    // written by the settle handler and the VERY NEXT write re-reads+rewrites the card, so without this
    // serializer entry the proof would die on the write that creates it and "No ar" would be unreachable
    // for every code card — the exact footgun the 4-place rule exists for.
    ...(card.deployProof?.sha
      ? {
          deployProof: {
            sha: card.deployProof.sha,
            targets: card.deployProof.targets ?? [],
            at: card.deployProof.at,
            source: card.deployProof.source,
          },
        }
      : {}),
    // ADR-063 (2c) acceptance→spec map — sparse: only emitted once a spec-authoring skill wrote it.
    // MUST round-trip through cardToFrontmatter (every write re-reads+rewrites via updateCardOnDisk),
    // else the gate hasCriteriaSpecs would never see it.
    ...(card.criteriaSpecs?.length
      ? {
          criteriaSpecs: card.criteriaSpecs.map((s) => ({
            criterion: s.criterion,
            ...(s.specPath ? { specPath: s.specPath } : {}),
          })),
        }
      : {}),
    // Durable review/QA range (SM-05) — only emitted when both SHAs are present, so
    // older cards (lone reviewCommit/qaCommit) stay lean. js-yaml serializes the flat
    // `{ base, head }` object as inline frontmatter and reads it back as a plain object.
    ...(card.commitRange?.base && card.commitRange?.head
      ? { commitRange: { base: card.commitRange.base, head: card.commitRange.head } }
      : {}),
    // WS-5.2 proof-carrying build stamp — sparse: only once the engine PROVED the delta already landed.
    // The gate hasBuildEvidence reads it, so the usual footgun bites hardest here: with no serializer the
    // stamp dies on the very write that creates it and the C2 deadlock it exists to break never opens.
    ...(card.buildEvidence?.provenance
      ? {
          buildEvidence: {
            provenance: card.buildEvidence.provenance,
            at: card.buildEvidence.at,
            ...(card.buildEvidence.range ? { range: card.buildEvidence.range } : {}),
            ...(card.buildEvidence.target ? { target: card.buildEvidence.target } : {}),
            ...(card.buildEvidence.runId ? { runId: card.buildEvidence.runId } : {}),
          },
        }
      : {}),
    // Persisted run-diff SHAs (SM-04) — only emitted once the merge train captures
    // them before `git branch -D`, so un-merged cards stay lean. The diff modal falls
    // back to `git diff base..mergeCommit` when the run branch is gone.
    ...(card.diffSnapshot?.base && card.diffSnapshot?.mergeCommit
      ? { diffSnapshot: { base: card.diffSnapshot.base, mergeCommit: card.diffSnapshot.mergeCommit } }
      : {}),
    // Reopen modes (only emitted when set, so build cards stay lean). `mode` is the
    // clear marker every harness-* skill reads; `refinement`/`bugReport`/`retirement` carry the human brief.
    ...(isReopenMode(card.mode) ? { mode: card.mode } : {}),
    // Reabertura R1 one-shot override gate — MUST round-trip to disk (sparse like `unplaced`): the
    // cascade reads the card FRESH from disk, so a flag dropped here means the override never fires.
    // The reopen skill clears it (unset) on its first pass, so a build card never emits the key.
    ...(card.reopenPending ? { reopenPending: true } : {}),
    ...(card.refinement && card.refinement.brief
      ? {
          refinement: {
            brief: card.refinement.brief,
            kinds: card.refinement.kinds ?? [],
            target: card.refinement.target ?? null,
            screenshot: card.refinement.screenshot ?? null,
            openedAt: card.refinement.openedAt ?? todayISO(),
          },
        }
      : {}),
    ...(card.bugReport && card.bugReport.brief
      ? {
          bugReport: {
            brief: card.bugReport.brief,
            severity: card.bugReport.severity ?? "medium",
            expected: card.bugReport.expected ?? null,
            actual: card.bugReport.actual ?? null,
            steps: card.bugReport.steps ?? [],
            target: card.bugReport.target ?? null,
            screenshot: card.bugReport.screenshot ?? null,
            openedAt: card.bugReport.openedAt ?? todayISO(),
          },
        }
      : {}),
    ...(card.retirement && card.retirement.brief
      ? {
          retirement: {
            brief: card.retirement.brief,
            disposition: card.retirement.disposition ?? "descontinuado",
            level: card.retirement.level ?? null,
            scope: card.retirement.scope ?? [],
            target: card.retirement.target ?? null,
            screenshot: card.retirement.screenshot ?? null,
            fromStatus: card.retirement.fromStatus ?? null,
            dataDeletionApproved: card.retirement.dataDeletionApproved === true,
            openedAt: card.retirement.openedAt ?? todayISO(),
          },
        }
      : {}),
    // OST idea block (dual-track) — emitted only for an idea card with a statement, so other
    // cards stay lean. The OST-light fields (Fatia 2) are sparse: each is omitted when empty. WITHOUT this,
    // the whole idea block (statement/evidence/status + the new fields) was silently dropped on write.
    ...(card.idea && card.idea.statement
      ? {
          idea: {
            statement: card.idea.statement,
            evidence: card.idea.evidence ?? null,
            status: card.idea.status,
            ...(card.idea.discardReason ? { discardReason: card.idea.discardReason } : {}),
            ...(card.idea.candidateSolutions?.length ? { candidateSolutions: card.idea.candidateSolutions } : {}),
            ...(card.idea.keyAssumption ? { keyAssumption: card.idea.keyAssumption } : {}),
            ...(card.idea.successSignal ? { successSignal: card.idea.successSignal } : {}),
            ...(card.idea.valueSize
              ? { valueSize: { reach: card.idea.valueSize.reach ?? null, impact: card.idea.valueSize.impact ?? null } }
              : {}),
            ...(card.idea.priorityCall
              ? {
                  priorityCall: {
                    rank: card.idea.priorityCall.rank,
                    rationale: card.idea.priorityCall.rationale,
                    ...(card.idea.priorityCall.riskiestAssumption ? { riskiestAssumption: card.idea.priorityCall.riskiestAssumption } : {}),
                    source: card.idea.priorityCall.source,
                    assessedAt: card.idea.priorityCall.assessedAt,
                  },
                }
              : {}),
          },
        }
      : {}),
    order: card.order ?? 0,
    created: card.created ?? todayISO(),
    updated: todayISO(),
  };
}

/**
 * A INVARIANTE DE HIERARQUIA, imposta no ponto por onde toda escrita de card passa.
 *
 * Por que AQUI e não em cada superfície: existem hoje três server actions que criam card, um punhado
 * de tools MCP, a captura, o backfill e o merge-back. Validar em cada uma é garantir que a próxima
 * nasça sem validação — foi exatamente assim que 132 cards ficaram fora da hierarquia (a triagem, que
 * nunca passou pai, sozinha respondia pela maior fatia). Um card fora da hierarquia deixa de ser
 * REPRESENTÁVEL: quem tentar gravá-lo recebe um erro que diz o que falta.
 *
 * Custo: UMA leitura extra de card por escrita — `placementSpec` diz qual é a âncora, e só ela é
 * carregada. Nada de varrer o board.
 *
 * Fail-closed de verdade: se a violação existe, a escrita não acontece. As isenções (contêiner,
 * ideia, quarentena `staging`, terminal) são decididas dentro de `placementSpec`, não aqui —
 * este arquivo não conhece a regra, só a aplica.
 */
async function assertPlacement(boardId: string, card: Card): Promise<void> {
  let config: BoardConfig | null = null;
  try {
    config = await readBoardConfig(boardId);
  } catch {
    // Board ilegível: não é papel desta checagem derrubar a escrita por isso — o drift-alarm do
    // contrato e o próprio leitor de board já gritam. Segue com a checagem de FORMA (sem config,
    // placementSpec não consegue ver quarentena/terminal, então nem isso é seguro) → não valida.
    return;
  }
  const spec = placementSpec(card, config);
  if (!spec) return; // isento por desenho
  const anchor = spec.anchorId ? await readCard(boardId, spec.anchorId) : null;
  const violation = placementViolation(card, (id) => (id === spec.anchorId ? anchor : null), config);
  if (!violation) return;
  throw new Error(
    `${violation.message} (card ${boardId}/${card.id}). Todo card vive na hierarquia do mapa: ` +
      `passo sob ação, user story sob passo, entrega sob a user story que ela serve.`,
  );
}

/** Persist a card WITHOUT acquiring the lock — call only from inside a held lock. */
async function writeCardUnlocked(boardId: string, card: Card): Promise<void> {
  await assertPlacement(boardId, card);
  await fs.mkdir(cardsDir(boardId), { recursive: true });
  // B1 — the Card contract as a LIVE drift alarm at the write chokepoint (the UI drawer + every
  // mutating MCP tool flow through here). The card must satisfy CardSchema (proven for all on-disk
  // cards by contracts.test); a write that would persist a malformed card is surfaced LOUDLY but
  // still proceeds (log-only — never blocks a write; the alarm just makes the drift visible).
  const check = parseCard(card);
  if (!check.ok) {
    console.error(
      `[storymap] card "${boardId}/${card.id}" não conforma ao contrato Card (B1 drift):`,
      JSON.stringify(check.issues).slice(0, 600),
    );
  }
  await atomicWriteFile(cardPath(boardId, card.id), serializeCard(card));
}

/**
 * Serialize a card to its on-disk `.md` file string (frontmatter + body) — the SINGLE source of truth
 * for the on-disk representation, shared by writeCard and the explicit-path writers. Default gray-matter
 * yaml dump produces valid YAML; date round-trip (YAML 1.1 parses bare timestamps as Date) is normalized
 * on read in repo.ts.
 */
export function serializeCard(card: Card): string {
  return matter.stringify(`\n${(card.body ?? "").trim()}\n`, cardToFrontmatter(card));
}

/**
 * Atomically write a card to an EXPLICIT absolute path — for callers that operate on a SPECIFIC checkout
 * rather than the findRepoRoot-derived cardPath: the merge train integrating a run's card into main at
 * `cfg.repoRoot` (story-r4o4wo, field-level 3-way merge), which must NOT resolve to the running service's
 * checkout the way writeCard does. Runs the SAME B1 contract drift-alarm as writeCard (log-only, never
 * blocks). The caller owns serialization order (the merge train's per-cwd mutex) and dir existence.
 */
export async function writeCardToPath(absPath: string, card: Card): Promise<void> {
  const check = parseCard(card);
  if (!check.ok) {
    console.error(
      `[storymap] card "${card.id}" (${absPath}) não conforma ao contrato Card (B1 drift):`,
      JSON.stringify(check.issues).slice(0, 600),
    );
  }
  await atomicWriteFile(absPath, serializeCard(card));
}

export async function writeCard(boardId: string, card: Card): Promise<void> {
  await withKeyedLock(cardLockKey(boardId, card.id), () => writeCardUnlocked(boardId, card));
}

/**
 * Read-modify-write a single card atomically against concurrent in-process writers.
 * Re-reads the card FRESH from disk inside the lock, applies `mutate`, and persists —
 * so the caller never clobbers fields a concurrent action / cascade forward changed
 * after it loaded its own snapshot (the storymap-drawer-pipeline-fields-clobber class
 * of bug, here generalized to every mutation, not just the drawer).
 *
 * `mutate` receives the fresh card and returns the next card (or null to skip the
 * write — e.g. nothing changed). It may THROW to abort with a user-facing message
 * (e.g. a failed gate); the throw propagates to the caller. Returns the written card,
 * or null when the card no longer exists or `mutate` opted out.
 */
export async function updateCardOnDisk(
  boardId: string,
  cardId: string,
  mutate: (current: Card) => Card | null,
): Promise<Card | null> {
  return withKeyedLock(cardLockKey(boardId, cardId), async () => {
    const current = await readCard(boardId, cardId);
    if (!current) return null;
    const next = mutate(current);
    if (!next) return null;
    // Id immutability contract (card-id-immutability fix): the id is permanent — the
    // filename stem + every parent/link/run-branch reference. Pin the mutation result
    // back to the on-disk id so no transformation can rewrite it (which would also
    // orphan the old file, since writeCardUnlocked writes to cardPath(next.id)).
    const pinned = pinCardId(next, current.id);
    await writeCardUnlocked(boardId, pinned);
    return pinned;
  });
}

export async function deleteCardFile(boardId: string, cardId: string): Promise<void> {
  await withKeyedLock(cardLockKey(boardId, cardId), () =>
    fs.rm(cardPath(boardId, cardId), { force: true }),
  );
}

/**
 * autonomo-liberdade-humana M2 — SOFT-delete a card: move its `.md` into `.trash/` and drop the restore manifest,
 * under the SAME per-card lock as every other card write (so it serializes with the service). Returns true if a
 * card was trashed, false if there was nothing at that path (idempotent, like deleteCardFile's `force`). The
 * caller (deleteCardAction) still strips dangling refs from other cards — restore re-materializes the CARD, not
 * the topology (the manifest records the stripped refs for the operator, but does not auto-re-link).
 */
export async function trashCardFile(boardId: string, cardId: string, manifest: TrashManifest): Promise<boolean> {
  return withKeyedLock(cardLockKey(boardId, cardId), async () => {
    const src = cardPath(boardId, cardId);
    try {
      await fs.access(src);
    } catch {
      return false; // nothing to trash
    }
    await fs.mkdir(trashDir(boardId), { recursive: true });
    await fs.rename(src, trashedCardPath(boardId, cardId)); // atomic move within the board dir (same fs)
    await writeTrashManifest(boardId, { ...manifest, restorePath: src }); // record where it came from
    return true;
  });
}

/**
 * M2 — RESTORE a soft-deleted card: move its `.md` back from `.trash/` to `cards/` and clear the trash entry.
 * Refuses (fail-safe) if the trashed file is gone (already restored/GC'd) or if a card with that id was
 * re-created in the meantime (restoring would clobber it). Under the per-card lock.
 */
export async function restoreCardFile(boardId: string, cardId: string): Promise<{ ok: boolean; error?: string }> {
  return withKeyedLock(cardLockKey(boardId, cardId), async () => {
    const trashed = trashedCardPath(boardId, cardId);
    try {
      await fs.access(trashed);
    } catch {
      return { ok: false, error: "card não está na lixeira (já restaurado ou expirado)" };
    }
    const dest = cardPath(boardId, cardId);
    try {
      await fs.access(dest);
      return { ok: false, error: "já existe um card com esse id — o id foi reutilizado; renomeie antes de restaurar" };
    } catch {
      /* dest is free — good */
    }
    await fs.rename(trashed, dest);
    await removeTrashEntry(boardId, { kind: "card", id: cardId });
    return { ok: true };
  });
}

/** Lock key serializing every in-process mutation of ONE board.yaml. */
function configLockKey(boardId: string): string {
  return `config:${boardId}`;
}

/** O corpo da gravação, SEM o lock — para quem já está dentro dele (ver updateBoardConfigOnDisk). */
async function writeBoardConfigUnlocked(boardId: string, config: BoardConfig): Promise<void> {
  // Persist only the board's DELTAS vs `_base` — never the resolved/inherited pipeline. The save
  // actions hand us the fully-resolved config; dumping it verbatim would re-inline `_base`'s
  // canonical pipeline (reverting R1) and drop an opt-out board's `inheritPipeline:false` (silently
  // triggering Fase 5). deriveBoardConfigForPersist round-trips to the same resolved config.
  const persisted = await deriveBoardConfigForPersist(boardId, config);
  const out = yaml.dump(persisted, { lineWidth: 120, noRefs: true });
  await atomicWriteFile(boardConfigPath(boardId), out);
}

export async function writeBoardConfig(boardId: string, config: BoardConfig): Promise<void> {
  await withKeyedLock(configLockKey(boardId), () => writeBoardConfigUnlocked(boardId, config));
  // #2: board.yaml is written by the human/bancada surface only (the engine never writes config during a
  // run) and was left UNCOMMITTED until a later run settled. Version it via the debounced scoped flush —
  // the single choke point for every config write (save/patch/delete persona+system, governance approve).
  scheduleBoardDataFlush();
}

/**
 * Read-modify-write do `board.yaml` ATÔMICO — o gêmeo de {@link updateCardOnDisk} para a config.
 *
 * Ele existe porque `writeBoardConfig` tranca a GRAVAÇÃO e mais nada: quem lê fora do lock, muta o
 * snapshot e grava está numa corrida clássica de LOST UPDATE. Com escritores humanos (um clique de
 * cor, um rename) as janelas nunca se cruzavam e o defeito ficou latente por todo o tempo em que a
 * bancada foi a única superfície.
 *
 * O AGENTE é que o acordou (2026-08-02): um modelo pode emitir VÁRIOS `tool_use` numa única mensagem,
 * e o cliente MCP os despacha em PARALELO. O Arquiteto classificou as 7 personas do board numa
 * tacada — sete leituras do mesmo snapshot, sete gravações, e sobrou o tipo de UMA. Não houve erro
 * nenhum no caminho: as sete responderam `ok: true`, seis simplesmente sumiram. É a forma mais cara
 * de falha que existe — silenciosa e com recibo de sucesso.
 *
 * `mutate` recebe a config FRESCA (lida dentro do lock) e devolve a próxima — ou `null` para não
 * gravar nada (nada mudou / a entidade não existe). Pode LANÇAR para abortar com mensagem ao usuário.
 * Devolve a config gravada, ou `null` quando o mutate desistiu.
 */
export async function updateBoardConfigOnDisk(
  boardId: string,
  mutate: (current: BoardConfig) => BoardConfig | null,
): Promise<BoardConfig | null> {
  const written = await withKeyedLock(configLockKey(boardId), async () => {
    const current = await readBoardConfig(boardId);
    const next = mutate(current);
    if (!next) return null;
    await writeBoardConfigUnlocked(boardId, next);
    return next;
  });
  // Fora do lock de propósito: o flush é debounced e toca git, não o arquivo — segurá-lo aqui dentro
  // só alargaria a seção crítica que este bloco existe para manter curta.
  if (written) scheduleBoardDataFlush();
  return written;
}
