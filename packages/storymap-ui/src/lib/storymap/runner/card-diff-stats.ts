// O TAMANHO DO TRABALHO de muitos cards numa ida só — «+442 −8 · 14 arquivos» na linha de estado do Kanban.
//
// O Kanban mostrava esse número (story-ex0148) por UMA chamada por card, e só para card com sessão de execução no
// diário — o card conduzido (que integra pelo worktree da sessão, sem execução no diário) ficou sem número nenhum, e
// era exatamente o card que o dono queria medir. Aqui: UMA chamada por board, as mesmas fontes duráveis do rodapé
// antigo (o branch da execução ainda vivo; o `commitRange` da revisão; o `diffSnapshot` da integração), e sempre
// `--shortstat` (nunca o diff inteiro). Um intervalo de shas é imutável ⇒ a medida dele vale para sempre (cache); a de
// um branch vivo vale {@link LIVE_BRANCH_TTL_MS}. Card sem nenhuma das fontes não custa git.
//
// (A árvore de uma SESSÃO viva é medida pelo feed `card-live` — card-live-feed.ts —, não aqui.)

import type { Card } from "@/lib/storymap/types";
import type { DiffStat } from "@/lib/storymap/card-live-status";
import { shortstatToDiff } from "./card-live-feed";

export const LIVE_BRANCH_TTL_MS = 60_000;
export const MAX_CARDS_PER_CALL = 300;
const IMMUTABLE_CAP = 4000;

export interface CardDiffDeps {
  /** `git <args>` na raiz do repositório → stdout. */
  git(args: string[]): Promise<string>;
  /** o branch da execução mais recente do card, SE ainda existe, com a base de integração quando conhecida. */
  runBranchFor(board: string, cardId: string): Promise<{ branch: string; base?: string } | null>;
  now?(): number;
}

const immutable = new Map<string, DiffStat | null>();
const liveBranch = new Map<string, { at: number; stat: DiffStat | null }>();

/** TEST SEAM — zera os caches. */
export function resetCardDiffCache(): void {
  immutable.clear();
  liveBranch.clear();
}

async function shortstat(deps: CardDiffDeps, range: string): Promise<DiffStat | null> {
  try {
    return shortstatToDiff(await deps.git(["diff", "--shortstat", range]));
  } catch {
    return null;
  }
}

async function rangeStat(deps: CardDiffDeps, base: string, head: string): Promise<DiffStat | null> {
  const key = `${base}..${head}`;
  if (immutable.has(key)) return immutable.get(key)!;
  const stat = await shortstat(deps, key);
  if (immutable.size >= IMMUTABLE_CAP) immutable.delete(immutable.keys().next().value!);
  immutable.set(key, stat);
  return stat;
}

const hasWork = (d: DiffStat | null): d is DiffStat => !!d && d.files + d.additions + d.deletions > 0;

/** O tamanho de UM card, da fonte mais fresca à mais durável. */
async function cardStat(deps: CardDiffDeps, board: string, card: Pick<Card, "id" | "commitRange" | "diffSnapshot">, hasRun: boolean): Promise<DiffStat | null> {
  const now = (deps.now ?? Date.now)();
  if (hasRun) {
    const k = `${board}/${card.id}`;
    const cached = liveBranch.get(k);
    if (cached && now - cached.at < LIVE_BRANCH_TTL_MS) {
      if (hasWork(cached.stat)) return cached.stat;
    } else {
      const run = await deps.runBranchFor(board, card.id).catch(() => null);
      const stat = run ? await shortstat(deps, run.base ? `${run.base}..${run.branch}` : `main...${run.branch}`) : null;
      liveBranch.set(k, { at: now, stat });
      if (hasWork(stat)) return stat;
    }
  }
  const cr = card.commitRange;
  if (cr?.base && cr?.head) {
    const s = await rangeStat(deps, cr.base.trim(), cr.head.trim());
    if (hasWork(s)) return s;
  }
  const snap = card.diffSnapshot;
  if (snap?.base && snap?.mergeCommit) {
    const s = await rangeStat(deps, snap.base.trim(), snap.mergeCommit.trim());
    if (hasWork(s)) return s;
  }
  return null;
}

/**
 * O tamanho do trabalho de vários cards de um board. `withRun` = os ids com execução no diário (o único caso que
 * pergunta pelo branch vivo). Só devolve quem tem trabalho medido. Nunca lança.
 */
export async function cardsDiffStats(
  deps: CardDiffDeps,
  board: string,
  cards: readonly Pick<Card, "id" | "commitRange" | "diffSnapshot">[],
  withRun: ReadonlySet<string>,
): Promise<Record<string, DiffStat>> {
  const out: Record<string, DiffStat> = {};
  for (const card of cards.slice(0, MAX_CARDS_PER_CALL)) {
    const hasRun = withRun.has(card.id);
    if (!hasRun && !card.commitRange && !card.diffSnapshot) continue; // nada a medir: nenhum git
    const stat = await cardStat(deps, board, card, hasRun).catch(() => null);
    if (hasWork(stat)) out[card.id] = stat;
  }
  return out;
}
