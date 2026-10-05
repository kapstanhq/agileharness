// O PEDIDO DE AUTORIZAÇÃO QUE ENVELHECEU — refeito pelo sistema, sem ninguém clicar.
//
// O QUE FALTAVA. Um pedido de autorização do dono («Autorizar publicar», owner-approval.ts) é preso à mudança EXATA: o
// diff base..head de alguns arquivos. Quando a main anda e mexe num desses arquivos, o pedido passa a autorizar o que já
// não existe — e até aqui o sistema só descobria isso quando o dono clicava (a gravação era recusada por «stale») ou
// quando o operador apertava «Refazer os pedidos de publicação» na Esteira. Nos dois casos, alguém fazia um passo que
// era do sistema.
//
// O QUE ISTO FAZ. Barato, sem rodar deploy: para cada linha `needs-human` do dono com pedidos, pergunta ao git se algum
// arquivo do assunto mudou entre o `head` do pedido e a main de agora (`git diff --name-only <head> main -- <arquivos>`).
// Mudou ⇒ o pedido é VELHO, e o sistema o refaz pelo MESMO caminho do botão (owner-approval.ts
// `rerequestPublishRequests`) — o Inbox mostra «refazendo o pedido…» no lugar do botão até o pedido novo chegar, no
// mesmo item (o item é da causa; a causa não muda).
//
// O QUE NUNCA FAZ: publicar por efeito colateral. A re-medição é o plano declarado (`deploy.planCommand`, que só lê).
// Sem plano, o caminho do botão é o deploy do board sem card — que não publica nada SÓ enquanto houver item do dono
// pendente. Então: sem plano, só refaz quando sobra um pedido do dono que ainda vale (o deploy vai parar nele) e o board
// não está segurado pelo ritmo; senão marca os pedidos como velhos (`staleApprovals`) e o Inbox diz «use Refazer» — o
// botão da Esteira vira a saída de emergência, não o caminho normal.
//
// Ritmo: board PAUSADO ainda re-mede pelo plano (medir não é trabalho novo e não publica nada); o deploy sem card, não
// (é trabalho de publicação, e o ritmo segura). Board SÓ DE ORGANIZAÇÃO: nada — nem medir, nem marcar.
// No máximo uma re-medição por pacote a cada `deploy.autoRerequestEveryMinutes` (padrão 15; 0 desliga).
//
// Quando roda: no tick de recuperação (a reconciliação de deploy de todos os boards) e quando a main anda (um pouso do
// train na main, o fim de um deploy) — por {@link nudgeAutoRerequest}, que junta os avisos de perto num só.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findRepoRoot } from "@/lib/storymap/paths";
import type { OwnerApprovalRequest } from "./deploy-proof";
import { isRerequesting, markApprovalsStale, mutateDeployBlocks, readDeployBlocks, type DeployBlockRow } from "./deploy-blocks";
import { defaultRerequestDeps, rerequestPublishRequests, type RerequestDeps, type RerequestOutcome } from "./owner-approval";

const pexecFile = promisify(execFile);

/** O padrão da janela entre duas re-medições automáticas do mesmo pacote (minutos). */
export const AUTO_REREQUEST_EVERY_MIN_DEFAULT = 15;

/** O que se lê do board que publica o pacote para decidir o caminho. */
export interface PublisherFacts {
  /** board só de organização: nada automático, nem medir. */
  organizeOnly: boolean;
  /** o ritmo segura o board (pausado, desarmado ou ilegível): nada de deploy sem card. */
  held: boolean;
  /** o board declara `deploy.planCommand` (a medição que não publica). */
  hasPlan: boolean;
}

export interface AutoRerequestDeps extends RerequestDeps {
  readRows(): Promise<DeployBlockRow[]>;
  /**
   * Quais de `files` mudaram entre o commit `head` e a main de agora. null = não dá para saber (git falhou, head
   * desconhecido, arquivo com forma estranha) ⇒ o pedido NÃO é tido como velho (na dúvida, nada se mexe).
   */
  changedSince(head: string, files: readonly string[]): Promise<string[] | null>;
  publisherFacts(board: string): Promise<PublisherFacts | null>;
  markStale(board: string, causeKeys: string[], hashes: string[]): Promise<void>;
  /** a janela por pacote em ms; 0 = desligada. */
  everyMs: number;
  /** reserva a janela do pacote (true = pode re-medir agora). */
  claim(pkg: string, now: number): boolean;
  /**
   * Os pedidos (hash) que esta passada já refez uma vez. O alvo calcula o hash da mudança: se a re-medição devolveu o
   * MESMO hash, o pedido vale para ele (o git só achou diferença de ref — um head que não é ancestral da main, por
   * exemplo) e refazê-lo de novo seria um laço. Um pedido é refeito sozinho no máximo uma vez.
   */
  tried: { has(hash: string): boolean; add(hash: string): unknown };
}

export type AutoRerequestAction =
  | { pkg: string; kind: "rerequested"; outcome: RerequestOutcome; stale: string[] }
  | { pkg: string; kind: "marked-stale"; board: string | null; stale: string[]; why: string }
  | { pkg: string; kind: "skipped"; why: "organize-only" | "debounced" | "unreadable"; stale: string[] };

export interface AutoRerequestReport {
  checked: number;
  actions: AutoRerequestAction[];
}

/** O pedido é VELHO: algum arquivo do assunto está entre os que mudaram desde o head dele. `changed` null ⇒ não sabe ⇒ não. PURA. */
export function isStaleRequest(request: Pick<OwnerApprovalRequest, "subject">, changed: readonly string[] | null): boolean {
  if (!changed?.length) return false;
  const files = new Set(request.subject.files);
  return changed.some((f) => files.has(f));
}

/** As linhas que a verificação olha: do dono, paradas pedindo alguém, com pedidos, e não já refazendo. PURA. */
export function rowsToCheck(rows: readonly DeployBlockRow[], now: number): DeployBlockRow[] {
  return rows.filter((r) => r.decider === "owner" && r.phase === "needs-human" && !!r.approvals?.length && !isRerequesting(r, now));
}

/**
 * Sem plano declarado, o deploy sem card só é seguro (não publica) enquanto sobra um pedido do dono que AINDA VALE no
 * pacote: o deploy para nele. Os velhos não contam (o alvo os pede de novo, mas pode ser que não — o código que os
 * pedia pode ter saído da main, e aí o deploy publicaria). PURA.
 */
export function ownerItemRemains(rows: readonly DeployBlockRow[], pkg: string, staleHashes: ReadonlySet<string>): boolean {
  return rows.some(
    (r) =>
      r.pkg === pkg &&
      r.decider === "owner" &&
      r.phase === "needs-human" &&
      (r.approvals ?? []).some((a) => !staleHashes.has(a.subject.hash) && !(r.staleApprovals ?? []).includes(a.subject.hash) && !(r.granted ?? []).includes(a.subject.hash)),
  );
}

/** Uma passada: acha os pedidos velhos e os refaz (ou marca). Nunca lança. */
export async function autoRerequestStale(deps: AutoRerequestDeps): Promise<AutoRerequestReport> {
  const report: AutoRerequestReport = { checked: 0, actions: [] };
  if (!(deps.everyMs > 0)) return report;
  try {
    const now = deps.now();
    const rows = await deps.readRows();
    const candidates = rowsToCheck(rows, now);
    report.checked = candidates.length;
    if (!candidates.length) return report;
    // uma pergunta ao git por (head, arquivos) nesta passada
    const asked = new Map<string, Promise<string[] | null>>();
    const changedOf = (a: OwnerApprovalRequest) => {
      const key = `${a.subject.head}\u0000${a.subject.files.join("\u0000")}`;
      if (!asked.has(key)) asked.set(key, a.subject.head ? deps.changedSince(a.subject.head, a.subject.files).catch(() => null) : Promise.resolve(null));
      return asked.get(key)!;
    };
    const staleByPkg = new Map<string, Set<string>>();
    for (const row of candidates) {
      for (const a of row.approvals ?? []) {
        if (deps.tried.has(a.subject.hash) || !isStaleRequest(a, await changedOf(a))) continue;
        const set = staleByPkg.get(row.pkg) ?? new Set<string>();
        set.add(a.subject.hash);
        staleByPkg.set(row.pkg, set);
      }
    }
    for (const [pkg, staleSet] of staleByPkg) {
      const stale = [...staleSet];
      const pkgRows = candidates.filter((r) => r.pkg === pkg);
      const pub = await deps.publisherOf(pkg).catch(() => null);
      const facts = pub ? await deps.publisherFacts(pub.board).catch(() => null) : null;
      if (pub && !facts) {
        report.actions.push({ pkg, kind: "skipped", why: "unreadable", stale });
        continue;
      }
      if (facts?.organizeOnly) {
        report.actions.push({ pkg, kind: "skipped", why: "organize-only", stale });
        continue;
      }
      const viaPlan = !!pub && !!facts?.hasPlan;
      const viaDeploy = !!pub && !!facts && !facts.hasPlan && !facts.held && ownerItemRemains(rows, pkg, staleSet);
      if (!viaPlan && !viaDeploy) {
        // não dá para refazer sem arriscar publicar: os pedidos velhos saem do botão e o Inbox diz «use Refazer»
        const already = pkgRows.every((r) => (r.approvals ?? []).every((a) => !staleSet.has(a.subject.hash) || (r.staleApprovals ?? []).includes(a.subject.hash)));
        if (!already) {
          for (const board of new Set(pkgRows.map((r) => r.board))) {
            await deps.markStale(board, pkgRows.filter((r) => r.board === board).map((r) => r.causeKey), stale);
          }
        }
        const why = !pub ? "nenhum board publica o pacote" : facts?.held ? "o deploy sem card espera o ritmo do board" : "sem deploy.planCommand, o deploy sem card poderia publicar";
        report.actions.push({ pkg, kind: "marked-stale", board: pub?.board ?? null, stale, why });
        continue;
      }
      if (!deps.claim(pkg, now)) {
        report.actions.push({ pkg, kind: "skipped", why: "debounced", stale });
        continue;
      }
      for (const h of stale) deps.tried.add(h);
      const outcome = await rerequestPublishRequests(deps, { pkg, rows: pkgRows, staleHashes: stale, planOnly: viaPlan }).catch(
        (err): RerequestOutcome => ({ ok: false, reason: "not-run", board: pub?.board ?? null, error: err instanceof Error ? err.message : String(err) }),
      );
      report.actions.push({ pkg, kind: "rerequested", outcome, stale });
      console.log(`[auto-rerequest ${pkg}] ${stale.length} pedido(s) do dono envelheceram (a main mexeu nos arquivos) — ${outcome.ok ? `refazendo pelo ${outcome.via === "plan" ? "plano" : "deploy sem card"} no board «${outcome.board}»` : `não refeito: ${outcome.error}`}`);
    }
  } catch (err) {
    console.error("[auto-rerequest] passada falhou:", err instanceof Error ? err.message : err);
  }
  return report;
}

// ── a janela por pacote ─────────────────────────────────────────────────────────────────────────────────

const CLAIM_KEY = Symbol.for("agileharness.auto-rerequest.claimedAt");
const claimedAt = ((globalThis as Record<symbol, unknown>)[CLAIM_KEY] ??= new Map<string, number>()) as Map<string, number>;

/** A janela do pacote, guardada em memória (um restart a reabre — no pior caso, uma medição a mais). */
export function claimWindow(everyMs: number): (pkg: string, now: number) => boolean {
  return (pkg, now) => {
    const last = claimedAt.get(pkg);
    if (last != null && now - last < everyMs) return false;
    claimedAt.set(pkg, now);
    return true;
  };
}

const TRIED_KEY = Symbol.for("agileharness.auto-rerequest.tried");
const TRIED_KEEP = 500;
const triedHashes = ((globalThis as Record<symbol, unknown>)[TRIED_KEY] ??= new Set<string>()) as Set<string>;

/** Os hashes já refeitos uma vez (em memória, com teto: o mais antigo sai primeiro). */
export const triedRegistry = {
  has: (h: string) => triedHashes.has(h),
  add: (h: string) => {
    triedHashes.add(h);
    if (triedHashes.size > TRIED_KEEP) triedHashes.delete(triedHashes.values().next().value as string);
  },
};

/** Só para teste: esquece as janelas e os hashes já refeitos. */
export function resetAutoRerequestForTest(): void {
  claimedAt.clear();
  triedHashes.clear();
}

// ── a borda de produção ─────────────────────────────────────────────────────────────────────────────────

/** Um commit em forma de sha e arquivos relativos sem `..` nem cara de opção — o resto não vira argumento do git. PURA. */
export function safeDiffArgs(head: string, files: readonly string[]): string[] | null {
  if (!/^[0-9a-f]{7,40}$/.test(head)) return null;
  if (!files.length || files.length > 500) return null;
  for (const f of files) {
    if (!f || f.length > 400 || f.startsWith("-") || f.startsWith("/") || f.split("/").includes("..") || /[\u0000-\u001f]/.test(f)) return null;
  }
  return ["diff", "--name-only", head, "main", "--", ...files];
}

/** As dependências de produção. */
export async function defaultAutoRerequestDeps(): Promise<AutoRerequestDeps> {
  const [{ loadRunnerConfig }, { readBoardConfig }, { isOrganizeOnly }, { boardGateNow }] = await Promise.all([
    import("./config"),
    import("@/lib/storymap/repo"),
    import("@/lib/storymap/organize-only-core"),
    import("./board-pace-store"),
  ]);
  const minutes = loadRunnerConfig().deploy?.autoRerequestEveryMinutes ?? AUTO_REREQUEST_EVERY_MIN_DEFAULT;
  const everyMs = minutes * 60_000;
  return {
    ...defaultRerequestDeps(),
    readRows: () => readDeployBlocks(),
    // sem shell: o assunto vem da saída do plano do alvo, e um nome de arquivo nunca vira comando
    changedSince: async (head, files) => {
      const args = safeDiffArgs(head, files);
      if (!args) return null;
      try {
        const { stdout } = await pexecFile("git", args, { cwd: findRepoRoot(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      } catch {
        return null;
      }
    },
    publisherFacts: async (board) => {
      const config = await readBoardConfig(board).catch(() => null);
      if (!config) return null;
      return { organizeOnly: isOrganizeOnly(config), held: boardGateNow(board, config).held, hasPlan: !!config.deploy?.planCommand?.trim() };
    },
    markStale: async (board, keys, hashes) => {
      await mutateDeployBlocks((rows) => markApprovalsStale(rows, board, keys, hashes));
    },
    everyMs,
    claim: claimWindow(everyMs),
    tried: triedRegistry,
  };
}

/** Roda uma passada com as dependências de produção. Nunca lança. */
export async function runAutoRerequest(): Promise<AutoRerequestReport> {
  try {
    return await autoRerequestStale(await defaultAutoRerequestDeps());
  } catch (err) {
    console.error("[auto-rerequest] montar a passada falhou:", err instanceof Error ? err.message : err);
    return { checked: 0, actions: [] };
  }
}

// ── o aviso «a main andou» ──────────────────────────────────────────────────────────────────────────────

/** Quanto esperar depois do aviso antes de olhar (junta os avisos de perto — um train que pousa vários de uma vez). */
export const NUDGE_DELAY_MS = 30_000;
const NUDGE_KEY = Symbol.for("agileharness.auto-rerequest.nudge");
const nudge = ((globalThis as Record<symbol, unknown>)[NUDGE_KEY] ??= { timer: null as ReturnType<typeof setTimeout> | null }) as {
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * A main andou (um pouso do train, o fim de um deploy): olha os pedidos daqui a pouco. Vários avisos dentro da espera
 * viram uma passada só; a janela por pacote ainda vale dentro dela. Nunca lança.
 */
export function nudgeAutoRerequest(run: () => Promise<unknown> = runAutoRerequest, delayMs = NUDGE_DELAY_MS): void {
  if (nudge.timer) return;
  nudge.timer = setTimeout(() => {
    nudge.timer = null;
    void run().catch(() => {});
  }, delayMs);
  (nudge.timer as { unref?: () => void }).unref?.();
}

/** Só para teste: cancela o aviso pendente. */
export function resetNudgeForTest(): void {
  if (nudge.timer) clearTimeout(nudge.timer);
  nudge.timer = null;
}
