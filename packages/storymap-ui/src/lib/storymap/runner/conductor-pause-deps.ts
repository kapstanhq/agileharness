// A PARADA DO CONDUTOR (conductor-pause.ts) ligada à produção: o registro de sessões, a sonda do tmux, a foto do
// vigia de terminais e a fila do condutor. Resolvido por chamada (o settings é lido vivo).

import { currentTerminalAttention } from "@/lib/terminal/attention-watch";
import { capturePane } from "@/lib/terminal/tmux";
import { deliverToSession, pressOptionKey, sessionRunsClaude } from "@/lib/vps/tmux";
import type { PurgeFilter } from "./board-pace-actions";
import { admitConductorCard, isSlotWait } from "./conductor";
import { updateCardOnDisk } from "@/lib/storymap/write";
import { upsertFindingIfChanged } from "./findings";
import {
  PARK_IGNORED_FINDING_ID,
  parkBoardConductors,
  parkWaitingConductors,
  wakeConductor,
  type ConductorParkReport,
  type ConductorParkState,
  type WakeBy,
  type WakeOutcome,
} from "./conductor-pause";
import { conductorQuiet, type ConductorQuiet } from "./conductor-quiet";
import { loadRunnerConfig } from "./config";
import { appendSystemDecision, newSystemDecisionId } from "./decision-log";
import { cardDependencyWait, defaultConductorDeps, pumpConductorsNow } from "./fleet-deps";
import { healPermissionPrompts, type PromptHealReport, type PromptHealState } from "./permission-prompt-heal";
import { lastPendingToolUse, type PendingToolUse } from "./permission-prompt";
import { QUIET_IO } from "./stall-watch-deps";
import { sessionCardIds } from "./session-worktree";
import { readCards } from "@/lib/storymap/repo";
import type { Card } from "@/lib/storymap/types";

function paneDeps() {
  const base = defaultConductorDeps();
  return {
    base,
    pane: {
      sessions: base.sessions,
      liveTmux: base.liveTmux,
      heartbeatAlive: base.heartbeatAlive,
      treeGone: base.treeGone,
      readCard: base.readCard,
      readBoardConfig: base.readBoardConfig,
      runsClaude: (tmux: string) => sessionRunsClaude(tmux),
      deliver: async (tmux: string, text: string) => (await deliverToSession(tmux, text, { submit: true })).ok,
      // fase 7: os outros cards do lote do líder (a marca `batch.id` no card) — a resposta a um item retoma o lote inteiro
      batchItems: async (board: string, lead: Card) => (lead.batch ? (await readCards(board)).filter((c) => c.id !== lead.id && c.batch?.id === lead.batch?.id) : []),
    },
  };
}

/** Uma resposta foi gravada no card: entrega ao condutor vivo, ou retoma o card estacionado na frente da fila. */
export async function wakeConductorNow(board: string, cardId: string, questionIds: readonly string[], by: WakeBy, line?: string): Promise<WakeOutcome> {
  const { base, pane } = paneDeps();
  const out = await wakeConductor(
    { ...pane, admitResume: (b, c) => admitConductorCard(base, b, c, { resume: true }) },
    { board, cardId, questionIds, by, ...(line ? { line } : {}) },
  );
  // a retomada não espera o próximo tick da frota (até 60 s) para tentar a vaga
  if (out === "resumed") void pumpConductorsNow().catch(() => {});
  return out;
}

/** WP5-F2 — o «Desfazer» de um estacionamento: o card volta para a FRENTE da fila e o pump tenta a vaga já. */
export async function resumeConductorNow(board: string, cardId: string): Promise<void> {
  await admitConductorCard(defaultConductorDeps(), board, cardId, { resume: true });
  void pumpConductorsNow().catch(() => {});
}

const PARK_STATE_KEY = Symbol.for("agileharness.conductor.parkState");

/** Algum dos cards passa no predicado do recorte? Um predicado que falha conta como «não». */
async function anyCardMatches(cardIds: readonly string[], only: PurgeFilter): Promise<boolean> {
  for (const id of cardIds) if (await Promise.resolve(only(id)).catch(() => false)) return true;
  return false;
}

/**
 * O board foi pausado com «parar agora» (board-pace.ts): pede a cada condutor vivo dele que estacione. Com `only`, pede só
 * aos condutores cujo card o predicado aponta (um recorte por card). O ESCOPO DE TIPOS NÃO usa isto: estreitar o escopo
 * deixa o que já executa TERMINAR (condutores vivos nunca são estacionados por ele); a assinatura fica coerente com a purga
 * da fila do engine (`PurgeFilter`) para o dia em que um modo «parar» do escopo existir.
 */
export async function parkBoardConductorsNow(board: string, only?: PurgeFilter): Promise<Array<{ cardId: string; tmuxSession: string }>> {
  const store = globalThis as unknown as { [PARK_STATE_KEY]?: ConductorParkState };
  const { pane } = paneDeps();
  const attention = new Map(currentTerminalAttention().map((t) => [t.session, t]));
  const now = Date.now();
  const asking = new Set<string>();
  // Os condutores do recorte: o predicado é lido UMA vez por sessão, aqui, e o passe de estacionar enxerga só eles.
  const mine = new Set<string>();
  for (const s of await pane.sessions().catch(() => [])) {
    if (s.driver !== "conductor" || s.board !== board || !s.tmuxSession) continue;
    // fase 7: uma sessão de LOTE entra no recorte quando QUALQUER card dela (o líder ou um item) está nele
    if (only && !(await anyCardMatches(sessionCardIds(s), only))) continue;
    mine.add(s.sessionId);
    if ((await conductorQuiet(s, attention.get(s.tmuxSession), now, QUIET_IO)).asking) asking.add(s.tmuxSession);
  }
  const scoped = only ? { ...pane, sessions: async () => (await pane.sessions()).filter((s) => mine.has(s.sessionId)) } : pane;
  return parkBoardConductors({ ...scoped, asking: (tmux) => asking.has(tmux), state: (store[PARK_STATE_KEY] ??= new Map()) }, board);
}

/** O passe da escada (lembrar, retomar, estacionar) do tick da frota. */
export async function parkWaitingConductorsNow(): Promise<ConductorParkReport> {
  const store = globalThis as unknown as { [PARK_STATE_KEY]?: ConductorParkState };
  const { base, pane } = paneDeps();
  const attention = new Map(currentTerminalAttention().map((t) => [t.session, t]));
  const now = Date.now();
  // O «quieto» de cada condutor, lido uma vez por passe: a foto do vigia quando ela sabe, senão transcript + tela
  // (conductor-quiet.ts — depois de um restart a foto não reconhece quem já estava parado), sempre com a árvore de
  // processos do pane (filho vivo = trabalho) e o último turno do transcript (erro de transporte).
  const quiet = new Map<string, ConductorQuiet>();
  for (const s of await pane.sessions().catch(() => [])) {
    if (s.driver !== "conductor" || !s.tmuxSession) continue;
    quiet.set(s.tmuxSession, await conductorQuiet(s, attention.get(s.tmuxSession), now, QUIET_IO));
  }
  // A fila que espera VAGA, por board: sem ela ninguém é lembrado nem estacionado por quietude.
  const waiters = new Map<string, number>();
  for (const e of await base.queue.load().catch(() => [])) if (isSlotWait(e.lastWaitKind)) waiters.set(e.board, (waiters.get(e.board) ?? 0) + 1);
  return parkWaitingConductors({
    ...pane,
    settings: () => loadRunnerConfig().autorun.park,
    quietForMs: (tmux) => quiet.get(tmux)?.quietForMs ?? null,
    asking: (tmux) => quiet.get(tmux)?.asking ?? false,
    transportError: (tmux) => quiet.get(tmux)?.transportError ?? null,
    childBusy: (tmux) => quiet.get(tmux)?.childBusy === true,
    slotWaiters: (board) => waiters.get(board) ?? 0,
    requeue: async (board, cardId, place) => {
      await admitConductorCard(base, board, cardId, place === "resume" ? { resume: true } : { yielded: true });
      void pumpConductorsNow().catch(() => {});
    },
    record: appendSystemDecision,
    newId: newSystemDecisionId,
    // fase 6 (6D): esperar OUTRA história estaciona com o driver; o pedido ignorado é repetido e depois vai ao operador
    dependencyWait: (board, card, config) => cardDependencyWait(board, card, config),
    escalateIgnoredPark: async (board, cardId, detail) => {
      await updateCardOnDisk(board, cardId, (card) => {
        const findings = upsertFindingIfChanged(card.findings ?? [], {
          id: PARK_IGNORED_FINDING_ID,
          lens: "general",
          severity: "high",
          title: "o condutor ignorou o pedido de estacionar",
          detail,
          status: "open",
        });
        return findings ? { ...card, findings } : null;
      });
    },
    state: (store[PARK_STATE_KEY] ??= new Map()),
  });
}

// ── pedidos de permissão de ferramenta (permission-prompt.ts) ───────────────────────────────────────────────────

const HEAL_STATE_KEY = Symbol.for("agileharness.permissionPrompt.state");
/** quanto do FIM de cada transcript é lido para achar a chamada sem resultado. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

async function tailOf(file: string): Promise<string> {
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * A chamada de ferramenta que espera a resposta, achada nos transcripts da sessão: o principal e os dos SUBAGENTES
 * (`<sessão>/subagents/agent-*.jsonl` — foi um subagente revisor que abriu o pedido). Vale a mais recente que
 * ainda não tem resultado.
 */
async function pendingToolOf(transcriptFile: string | undefined): Promise<PendingToolUse | null> {
  if (!transcriptFile) return null;
  const { readdir, stat } = await import("node:fs/promises");
  const path = await import("node:path");
  const files: Array<{ file: string; mtime: number }> = [];
  const add = async (file: string) => {
    const st = await stat(file).catch(() => null);
    if (st?.isFile()) files.push({ file, mtime: st.mtimeMs });
  };
  await add(transcriptFile);
  const subDir = path.join(transcriptFile.replace(/\.jsonl$/, ""), "subagents");
  for (const name of await readdir(subDir).catch(() => [] as string[])) if (/^agent-.*\.jsonl$/.test(name)) await add(path.join(subDir, name));
  files.sort((a, z) => z.mtime - a.mtime);
  for (const f of files.slice(0, 4)) {
    const hit = lastPendingToolUse(await tailOf(f.file).catch(() => ""));
    if (hit) return hit;
  }
  return null;
}

/** O isolamento da sessão: o worktree dela e o scratch que o Claude Code lhe dá (`/tmp/claude-<uid>/<worktree com / e . → ->`). */
function rootsOf(worktree: string | undefined, cwd: string | undefined) {
  const tree = (worktree ?? cwd ?? "").replace(/\/+$/, "");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return { worktree: tree, scratch: `/tmp/claude-${uid}/${tree.replace(/[/.]/g, "-")}` };
}

/**
 * O passe que destrava pedidos de permissão de ferramenta nas sessões da frota (permission-prompt.ts): ninguém do negócio
 * responde «posso rodar este rm?», então o sistema aprova o falso positivo provado, recusa o que o isolamento não prova
 * e recusa o que não consegue julgar quando o prazo vence. Nenhuma sessão fica horas num pedido.
 */
export async function healPermissionPromptsNow(): Promise<PromptHealReport> {
  const store = globalThis as unknown as { [HEAL_STATE_KEY]?: PromptHealState };
  const { pane } = paneDeps();
  return healPermissionPrompts({
    sessions: pane.sessions,
    liveTmux: pane.liveTmux,
    heartbeatAlive: pane.heartbeatAlive,
    runsClaude: pane.runsClaude,
    screen: (tmux) => capturePane(tmux, 70),
    pendingTool: (s) => pendingToolOf(s.transcriptFile),
    roots: (s) => rootsOf(s.worktreePath, s.cwd),
    press: async (tmux, key) => (await pressOptionKey(tmux, key)).ok,
    record: appendSystemDecision,
    newId: newSystemDecisionId,
    state: (store[HEAL_STATE_KEY] ??= new Map()),
  });
}
