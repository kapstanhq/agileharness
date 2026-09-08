"use client";

// CardDocument (F1) — the card rendered as ONE living markdown document. Replaces the four
// mismatched read widgets (CardSpecRead + CardStrategicContext + CardPipelineArtifacts +
// CardRunHistory) and the two-panel split: a single typographic column, nothing collapsed,
// the real-time run state embedded at the top (StatusRibbon). The rendered drawer ≡ the
// markdown projection (composeCardDocument) ≡ the source of truth.
//
// The pure projection (card-document.ts) decides WHAT renders and in WHICH order; this file
// is the thin React consumer that loads the sidecars, resolves the strategic context, and maps
// each block to a component (rich Markdown / inline ASCII wireframes / inline blockers).

import { useEffect, useMemo, useState } from "react";
import { useToast } from "./Toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Circle, MessageSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  chooseWireframeAction,
  getCardRunHistoryAction,
  getCardTransitionsAction,
  getPlanAction,
  getWireframeAction,
  submitDesignFeedbackAction,
  updateFindingStatusAction,
} from "@/app/actions";
import {
  composeCardDocument,
  cardDocumentIsEmpty,
  splitFindingsBySeverity,
  type CardDocContext,
} from "@/lib/storymap/card-document";
import { computeStepRollups } from "@/lib/storymap/step-rollup";
import { terminalStatusIds } from "@/lib/storymap/views";
import { IDEA_STATUS_BY_ID } from "@/lib/storymap/frameworks";
import { getAddressedIdea } from "@/lib/storymap/idea";
import { openQuestions } from "@/lib/storymap/questions";
import { perguntasHref } from "@/lib/storymap/card-preview";
import type { BoardConfig, Card, Finding, FindingStatus, WireframeDoc } from "@/lib/storymap/types";
import type { TelemetryRecord } from "@/lib/storymap/runner/telemetry";
import type { Transition } from "@/lib/storymap/runner/transitions";
import { Markdown } from "./Markdown";
import { DOC_SECTION } from "./doc/typography";
import { DesignCanvas } from "./wireframe/DesignCanvas";
import { CardRetirement } from "./CardRetirement";
import { CardStageHistory, CardHopTimeline } from "./CardStageHistory";
import { CardQuickActions, RunSubstateBadge, useRunnerSnapshot } from "./RunnerStatusProvider";

export function CardDocument({
  boardId,
  card,
  config,
  cards,
  strategy,
}: {
  boardId: string;
  card: Card;
  config: BoardConfig;
  cards: Card[];
  /** O norte do produto (digest do PRD), resolvido no servidor — `loadDoc` não vive no cliente. */
  strategy: string;
}) {
  const [plan, setPlan] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState<WireframeDoc | null>(null);
  const [history, setHistory] = useState<TelemetryRecord[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { running } = useRunnerSnapshot();

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    Promise.all([
      getPlanAction({ boardId, cardId: card.id }),
      getWireframeAction({ boardId, cardId: card.id }),
      getCardRunHistoryAction({ boardId, cardId: card.id, limit: 8 }),
      getCardTransitionsAction({ boardId, cardId: card.id }),
    ]).then(([p, w, h, t]) => {
      if (!alive) return;
      if (p.ok && p.data) setPlan(p.data.markdown);
      if (w.ok && w.data) setWireframe(w.data.doc);
      if (h.ok && h.data) setHistory(h.data.runs);
      if (t.ok && t.data) setTransitions(t.data.transitions);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [boardId, card.id]);

  // The live run (if any) → highlighted at the top of `## Histórico`.
  const liveRun = running.find((r) => r.board === boardId && r.cardId === card.id) ?? null;

  const strategic = useMemo(() => {
    const idea = getAddressedIdea(card, cards);
    // The effective run policy of the card's CURRENT status (skill/model/effort/turns) — the
    // transparency the old CardStrategicContext "Run" row carried (what the next autorun spends).
    const step = card.status ? config.statuses.find((s) => s.id === card.status) : undefined;
    return {
      norte: strategy.split("\n").filter((l) => l.trim()),
      idea: idea
        ? {
            statement: idea.idea?.statement?.trim() || idea.title,
            statusName: idea.idea?.status ? IDEA_STATUS_BY_ID[idea.idea.status]?.name ?? null : null,
          }
        : null,
      personas: card.personas.map((id) => config.personas.find((p) => p.id === id)?.name).filter((n): n is string => !!n),
      systems: card.systems.map((id) => config.systems.find((s) => s.id === id)?.name).filter((n): n is string => !!n),
      runPolicy: step?.trigger
        ? { skill: step.trigger, model: step.model ?? null, effort: step.effort ?? null, maxTurns: step.maxTurns ?? null }
        : null,
    };
  }, [card, config, cards, strategy]);

  // Fold the durable run ledger + the card's own fields into the per-step rollup that the `## Histórico`
  // table renders (the live run, if any, flagged so its row reads "▸ agora · rodando").
  const rollups = useMemo(
    // 6.3 — feed the durable ledger so the EXECUTION axis (rollup.visited / satisfiedWithoutRun) is real
    // rather than inferred from array position — a column a human moved through no longer reads "não visitado".
    () => computeStepRollups(config, card, history, liveRun?.trigger ?? null, { transitions }),
    // depend on the live trigger STRING (stable), not the liveRun object (a fresh ref per SSE frame).
    [config, card, history, liveRun?.trigger, transitions],
  );

  const ctx: CardDocContext = { strategic, plan, wireframe, rollups };
  const blocks = composeCardDocument(card, ctx);
  const isRetired = card.mode === "retire" && !!card.retirement;
  const empty = loaded && cardDocumentIsEmpty(blocks) && !isRetired && !wireframe && !plan;

  return (
    <div className="space-y-1">
      <StatusRibbon boardId={boardId} card={card} config={config} />

      {isRetired && <CardRetirement boardId={boardId} card={card} />}

      {empty ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-fg-subtle">
          <Circle className="h-8 w-8 opacity-30" />
          <div>
            <p className="text-sm font-medium text-fg-muted">Documento ainda vazio</p>
            <p className="mt-0.5 text-xs">
              Clique em <strong>Editar</strong> para preencher, ou aguarde o /harness-enrich.
            </p>
          </div>
        </div>
      ) : (
        <article className="pb-2">
          {blocks.map((b, i) => {
            // The stateful singleton blocks (wireframe/blockers) get a STABLE key by kind so an async
            // sidecar load (which inserts the wireframe/notas blocks mid-list) doesn't remount them
            // against a different-kind block at the same index. Prose is stateless → index key is fine.
            if (b.kind === "prose")
              return (
                <Markdown key={`prose-${i}`} variant="doc">
                  {b.md}
                </Markdown>
              );
            if (b.kind === "wireframe") return <InlineWireframes key="wireframe" boardId={boardId} cardId={card.id} doc={b.doc} />;
            if (b.kind === "blockers") return <InlineBlockers key="blockers" boardId={boardId} cardId={card.id} findings={b.findings} terminal={terminalStatusIds(config).has(card.status ?? "")} />;
            if (b.kind === "stage-history") return <CardStageHistory key="stage-history" density="full" rollups={b.rollups} />;
            return null;
          })}
        </article>
      )}

      {/* 6.3 — the auditable ledger reader: the card's REAL status trajectory (human moves, run advances, the
          merge verdict, a system deploy-revert), read from the durable WS2 ledger. Shown when there's history. */}
      {loaded && transitions.length > 0 && <CardHopTimeline transitions={transitions} />}
    </div>
  );
}

// ── StatusRibbon — the live state, sticky at the top (replaces the left RunStatePanel) ────────

/**
 * The real-time state band pinned to the top of the document: the status pill, the live run
 * sub-state badge, task progress, open-questions (HITL) link, and the one-tap quick actions
 * (terminal · diff · avançar). It carries the "estado em tempo real" so the document below it
 * stays a calm read. Renders quietly (just the status pill) on an idle card.
 */
function StatusRibbon({ boardId, card, config }: { boardId: string; card: Card; config: BoardConfig }) {
  const statusDef = config.statuses.find((s) => s.id === card.status);
  const doneCount = card.tasks.filter((t) => t.done).length;
  const totalCount = card.tasks.length;
  const openQs = openQuestions(card);

  return (
    // Alinhada à COLUNA de leitura (era `-mx-6 px-6`: uma faixa que vazava 24px de cada lado do texto
    // e, na página inteira — onde a coluna não tem padding próprio —, ficava visivelmente descolada).
    <div className="sticky top-0 z-10 mb-6 rounded-xl border border-line bg-surface/95 px-3 py-2 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        {statusDef && (
          <span
            className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-white"
            style={{ backgroundColor: statusDef.color ?? "#94a3b8" }}
          >
            {statusDef.name}
          </span>
        )}
        <RunSubstateBadge boardId={boardId} cardId={card.id} size="md" />
        {totalCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
            <Check className="h-3.5 w-3.5 text-emerald-500" />
            <span className="tabular-nums">
              {doneCount}/{totalCount} tasks
            </span>
            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover">
              <span
                className="block h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${totalCount ? (doneCount / totalCount) * 100 : 0}%` }}
              />
            </span>
          </span>
        )}
        {openQs.length > 0 && (
          <Link
            href={perguntasHref(boardId, card.id)}
            className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 transition hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
          >
            <MessageSquare className="h-3 w-3" />
            {openQs.length} pergunta{openQs.length > 1 ? "s" : ""}
          </Link>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <CardQuickActions boardId={boardId} cardId={card.id} card={card} config={config} size="md" />
        </span>
      </div>
    </div>
  );
}

// ── InlineWireframes — journey + design canvas IN the flow (Canvas v2) ────────────────────────

/**
 * The journey + the design canvas, inline in the document. Both surfaces (this drawer + the
 * Inbox cockpit) share JourneyView + DesignCanvas, so a doc renders identically everywhere:
 * per-artifact feedback (approve · change · set primary) replaces the old single-choice
 * "Escolher esta" — legacy options docs render through the same path via the selector bridge.
 * Legacy HTML-format OPTIONS still only show the muted note (the F2 contract); new `html`
 * ARTIFACTS render in the sandboxed HtmlArtifactFrame inside DesignCanvas.
 */
function InlineWireframes({ boardId, cardId, doc }: { boardId: string; cardId: string; doc: WireframeDoc }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const hasArtifacts = doc.artifacts.length > 0 || doc.options.some((o) => o.format !== "html");
  const htmlCount = doc.options.filter((o) => o.format === "html").length;
  const journey = doc.journey;

  const setPrimary = async (artifactId: string) => {
    setBusy(true);
    const res = await chooseWireframeAction({ boardId, cardId, optionId: artifactId });
    setBusy(false);
    if (res.ok) router.refresh();
    else toast(res.error);
  };

  const sendFeedback = async (artifactId: string | null, note: string, kind: "change" | "approve") => {
    setBusy(true);
    const res = await submitDesignFeedbackAction({ boardId, cardId, artifactId, note, kind });
    setBusy(false);
    if (res.ok) router.refresh();
    else toast(res.error);
  };

  return (
    <section>
      {/* The journey renders INSIDE the canvas as its first card (same chrome as the artifact
          cards, own feedback field) — no separate journey block above it. */}
      {(journey || hasArtifacts) && (
        <div>
          <DesignCanvas doc={doc} journey={journey} busy={busy} onSetPrimary={setPrimary} onFeedback={sendFeedback} />
        </div>
      )}

      {htmlCount > 0 && !hasArtifacts && (
        <p className="mt-2 text-[11px] italic leading-snug text-fg-subtle">
          {htmlCount} wireframe{htmlCount > 1 ? "s" : ""} HTML legado — não renderizado nesta superfície
          ASCII-only; rode <span className="font-mono">/harness-ux</span> para regerar em ASCII.
        </p>
      )}
    </section>
  );
}

// ── InlineBlockers (F3) — open findings as simple lines, not a checklist widget ──────────────

const SEV_DOT: Record<string, string> = {
  blocker: "bg-rose-500",
  high: "bg-amber-500",
  medium: "bg-sky-400",
  low: "bg-fg-subtle",
};

/**
 * Open findings rendered as ONE line each (severity dot · title · resolver), the detail hidden
 * until expanded — replacing the 6-field card-with-borders widget. The gate (hasNoBlockers)
 * still keys off the well-formed open blockers in card.findings; this only changes how they READ.
 */
function InlineBlockers({ boardId, cardId, findings, terminal }: { boardId: string; cardId: string; findings: Finding[]; terminal?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  // 4.4 — separate REAL blockers (held out of QA by the gate) from soft advisories (tooling-unused,
  // route-undersized, …) so the operator distinguishes a hard block from a hint at a glance. Presentation
  // only — the hasNoBlockers gate keys off severity==='blocker' in gate-core.js regardless.
  const { blockers, advisories, triaged } = splitFindingsBySeverity(findings, { terminal });
  if (blockers.length === 0 && advisories.length === 0 && triaged.length === 0) return null;

  /**
   * SEM OTIMISMO — o mesmo contrato do QuickActionButton (invariant 9), e aqui isso é um CONSERTO, não uma
   * escolha de estilo. O que existia: um `setItems` otimista seguido de `if (res.ok) router.refresh()` — ou
   * seja, no ramo `!res.ok` NADA acontecia. O finding sumia da lista na tela (pintado como resolvido) e
   * continuava `open` no disco; o gate seguia travado e o operador não tinha como saber por quê. Um erro
   * silencioso numa ação de triagem é pior que a ação não existir: ele mente sobre o estado do gate.
   * O `router.refresh()` no sucesso é o que repinta a linha com o status REAL vindo do servidor — por isso
   * não há estado local de findings nenhum aqui (o `useState`/`useEffect` que os espelhava era a fonte da
   * mentira, e nem sequer era necessário: o server component já reentrega a lista a cada refresh).
   */
  const setStatus = async (id: string, status: FindingStatus, label: string) => {
    setPendingId(id);
    const res = await updateFindingStatusAction({ boardId, cardId, findingId: id, status });
    setPendingId(null);
    if (!res.ok) {
      toast(res.error);
      return;
    }
    toast(`${label}: ok`, "success");
    router.refresh();
  };

  return (
    <div>
      {blockers.length > 0 && (
        <section>
          <h2 className={DOC_SECTION}>
            Bloqueios <span className="text-rose-500">({blockers.length})</span>
          </h2>
          <ul className="space-y-1">
            {blockers.map((f) => (
              <BlockerRow key={f.id} finding={f} pending={pendingId === f.id} onResolve={setStatus} />
            ))}
          </ul>
        </section>
      )}
      {advisories.length > 0 && (
        <section>
          <h2 className={DOC_SECTION}>
            Avisos <span className="text-amber-500">({advisories.length})</span>
          </h2>
          <ul className="space-y-1">
            {advisories.map((f) => (
              <BlockerRow key={f.id} finding={f} pending={pendingId === f.id} onResolve={setStatus} />
            ))}
          </ul>
        </section>
      )}
      {/* Os TRIADOS — o que já tem desfecho. Não é trabalho (nenhum botão, tom apagado): é o RASTRO, e é o que
          torna "o agente resolve, o humano supervisiona" verificável em vez de uma promessa. Cada linha diz o
          desfecho e QUEM o deu (statusNote), então uma triagem do Autônomo com a qual você não concorda é
          visível — e reversível pelo Inbox/MCP — em vez de ter sumido sem deixar marca. */}
      {triaged.length > 0 && (
        <section>
          <h2 className={DOC_SECTION}>
            Triados <span className="text-fg-subtle">({triaged.length})</span>
          </h2>
          <ul className="space-y-1 opacity-60">
            {triaged.map((f) => (
              <BlockerRow key={f.id} finding={f} pending={false} onResolve={setStatus} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * O que cada `status` DIZ nesta linha, e por que o rótulo importa: o widget antes imprimia o literal `aberto`
 * em TODA linha (o filtro é por severity, nunca por status — um finding já triado seguia se anunciando como
 * aberto). O texto agora é o estado real, e ele carrega a divisão de trabalho: `open` é o único que espera
 * alguém. Ver {@link statusNote} para o "quem".
 */
const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  open: "aberto",
  acknowledged: "conhecido",
  fixed: "resolvido",
  wontfix: "não será corrigido",
};

/**
 * QUEM deu o desfecho — o pedaço que o operador não tinha e mais precisa agora que o Autônomo triAGE sozinho:
 * "isto está fechado, mas fui EU ou foi ele?". Os dados já existiam no card e não tinham superfície
 * (`Finding.statusBy`/`statusAt`, gravados por `triage_finding`/`updateFindingStatusAction`).
 *
 * `statusBy` é ESPARSO por contrato (types.ts): ausente significa "nunca triado / anterior ao campo" — nunca
 * "foi o humano". Por isso um finding fechado sem `statusBy` não ganha atribuição inventada: ele só diz o
 * status. Os atores vêm de `triage_finding`: "human" · "copilot" · "train:<runId>" · "audit:<trigger>".
 */
function statusNote(finding: Finding): string | null {
  if (finding.status === "open") return "esperando você";
  const by = finding.statusBy;
  if (!by) return null;
  const who = by === "human" ? "por você" : by === "copilot" ? "pelo agente" : `por ${by}`;
  return finding.statusAt ? `${who} · ${finding.statusAt}` : who;
}

function BlockerRow({
  finding,
  pending,
  onResolve,
}: {
  finding: Finding;
  pending: boolean;
  onResolve: (id: string, status: FindingStatus, label: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!(finding.detail || finding.file || finding.suggestion);
  const isBlocker = finding.severity === "blocker";
  const note = statusNote(finding);
  const open = finding.status === "open";

  // Os MESMOS rótulos do registry de quick-actions (Inbox) — antes eram `resolver`/`ignorar` aqui e
  // "Marcar resolvido"/"Não corrigir" lá, para o MESMO ato e a MESMA server action. E `ignorar` era a pior das
  // duas: ele não ignora nada — escreve `wontfix`, que num blocker LIBERA o gate e deixa o card avançar sem o
  // conserto. Um botão que diz "ignorar" e destrava produção é uma armadilha.
  const acts: Array<{ status: FindingStatus; label: string; danger?: boolean }> = isBlocker
    ? [
        { status: "fixed", label: "Marcar resolvido" },
        { status: "wontfix", label: "Não corrigir", danger: true },
      ]
    : // Um AVISO tem o terceiro desfecho — e é o mais comum: "eu vi, é conhecido, fica registrado". Mesma
      // ordem/rótulos do QUICK_ACTIONS_OF.finding.
      [
        { status: "acknowledged", label: "Registrar como conhecido" },
        { status: "fixed", label: "Marcar resolvido" },
        { status: "wontfix", label: "Não corrigir" },
      ];

  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center gap-2.5 text-[13.5px]">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", SEV_DOT[finding.severity] ?? "bg-fg-subtle")} />
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((v) => !v)}
          className={cn("min-w-0 flex-1 truncate text-left text-fg", hasDetail && "hover:text-fg-muted")}
          title={hasDetail ? "Ver detalhe" : undefined}
        >
          {finding.title}
        </button>
        <span className="shrink-0 text-[11px] text-fg-subtle">
          {FINDING_STATUS_LABEL[finding.status]}
          {note ? ` · ${note}` : ""}
        </span>
        {/* Já triado ⇒ sem botões: o desfecho está dado e a linha vira registro. Re-triar é `open`→X, e voltar
            para `open` não é um desfecho que esta superfície ofereça (ver QuickActionInvoke.update-finding). */}
        {open &&
          acts.map((a) => (
            <button
              key={a.status}
              type="button"
              disabled={pending}
              onClick={() => {
                // Confirmação SÓ onde o ato é de fato perigoso: `wontfix` num BLOCKER destrava o gate
                // (hasNoBlockers) e o card anda sem o conserto. É a mesma assimetria do registry, que
                // confirma o wontfix do blocker e nada num aviso — um aviso não gateia nada.
                if (a.danger && !confirm(`Não corrigir?\n\nMarca ${finding.id} como wontfix — o card avança sem o conserto.`)) return;
                onResolve(finding.id, a.status, a.label);
              }}
              className={cn(
                "shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] font-medium transition hover:bg-surface-hover",
                a.danger ? "text-fg-subtle" : "text-fg-muted",
                pending && "cursor-not-allowed opacity-50",
              )}
            >
              {pending ? "…" : a.label}
            </button>
          ))}
      </div>
      {expanded && hasDetail && (
        <div className="mt-2 space-y-1.5 border-t border-line-muted pl-4 pt-2 text-[13px] leading-relaxed text-fg-muted">
          {finding.file && (
            <p className="font-mono text-[11px] text-fg-subtle">
              {finding.file}
              {finding.line != null ? `:${finding.line}` : ""}
              <span className="ml-1.5 font-sans not-italic">· {finding.lens}</span>
            </p>
          )}
          {finding.detail && <p>{finding.detail}</p>}
          {finding.suggestion && <p className="rounded bg-inset px-2 py-1">💡 {finding.suggestion}</p>}
        </div>
      )}
    </li>
  );
}
