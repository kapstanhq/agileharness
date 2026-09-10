// "Esta sessão de agente ainda está viva?" — a regra, em UM lugar, legível por qualquer camada.
//
// POR QUE ESTE MÓDULO EXISTE. A resposta já vivia em `session-worktree.ts`, mas quem mais precisa
// dela é o teardown de baixo nível (`worktree.ts` → `remove`), e `session-worktree.ts` importa
// `worktree.ts`: perguntar de lá fecharia um ciclo. Extrair a regra (em vez de duplicá-la no guard)
// mantém UMA verdade sobre liveness — uma segunda cópia seria a que apodrece.
//
// A leitura é SÍNCRONA e tolerante de propósito: o guard roda no caminho de uma remoção destrutiva,
// onde "não consegui ler o registro" não pode virar exceção nem, muito menos, autorização.

import { readFileSync } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";

/**
 * Quanto tempo uma sessão SEM heartbeat novo ainda conta como viva. Deliberadamente GENEROSO: o
 * custo de esperar é um diretório vazado (barato — node_modules são links); o custo de errar é
 * apagar a árvore de um agente NO MEIO DA EDIÇÃO, que é justamente o incidente que este módulo
 * existe para impedir.
 *
 * ⚠️ ELE SOZINHO NÃO BASTA, e isso é lição de incidente (2026-07-27): o carimbo mede "chamou uma tool
 * MCP", não "está trabalhando". Uma sessão INTERATIVA edita, builda e roda teste por horas sem tocar
 * no MCP — e foi assim que uma árvore com 14 arquivos editados venceu o TTL e foi apagada. Por isso a
 * prova de vida tem hoje DUAS pernas, e a segunda mede o trabalho em vez do carimbo:
 *   • `runner/session-activity.ts` — algum arquivo SUJO da árvore foi tocado dentro da janela?
 *   • `runner/worktree.ts rescueUncommitted` — e, mesmo que a resposta erre, o não-commitado vira
 *     commit ANTES de qualquer `--force`, então "reapar cedo" nunca mais significa "perder".
 * Mexer neste número não substitui nenhuma das duas.
 */
export const SESSION_HEARTBEAT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Quanto tempo uma sessão SEM heartbeat novo ainda EMBARGA uma publicação (release.ts
 * `concurrent-work`). MENOR que o TTL acima DE PROPÓSITO, porque a decisão é outra e o risco é oposto.
 *
 * O TTL de 6h protege uma ação DESTRUTIVA (apagar a árvore de um agente): errar cedo apaga trabalho, e
 * por isso ele é generoso. O embargo NÃO É DESTRUTIVO — pular uma sessão na sonda não toca em arquivo,
 * branch nem árvore dela: no pior caso `main` anda e o `worktree_submit` seguinte encontra um conflito,
 * que é o caminho DESENHADO (3-way + gate → `returned-to-session` → `worktree_refresh` → re-submeter).
 * Já o custo de errar para o outro lado é concreto e foi medido em produção (2026-07-27): uma sessão
 * morta às 23:33 segurou a publicação do board inteiro — inclusive a do conserto DESTE bug — porque
 * herdava as 6h calibradas para a decisão destrutiva. Publicação parada é indisponibilidade; conflito
 * de merge é rotina.
 *
 * 90min: folgado o bastante para uma sessão que está de fato trabalhando (o heartbeat é carimbado a CADA
 * tool call MCP, e um trecho longo de edição sem nenhuma chamada raramente passa disso), curto o bastante
 * para produção não ficar refém de quem não volta mais.
 */
export const PUBLISH_EMBARGO_TTL_MS = 90 * 60 * 1000; // 90min

/**
 * A janela de embargo, do env (`AGILEHARNESS_PUBLISH_EMBARGO_TTL_MS`). Lixo/<=0 → o default; nunca desligada
 * (embargo infinito é o bug, embargo zero seria perder a guarda). TETO no TTL de liveness: uma sessão
 * já considerada MORTA para todo o resto do sistema não pode seguir embargando aqui. Pura — exportada
 * para teste.
 */
export function publishEmbargoTtlMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AGILEHARNESS_PUBLISH_EMBARGO_TTL_MS;
  const n = raw == null || raw === "" ? NaN : Number(raw);
  const chosen = Number.isFinite(n) && n > 0 ? Math.floor(n) : PUBLISH_EMBARGO_TTL_MS;
  return Math.min(chosen, SESSION_HEARTBEAT_TTL_MS);
}

/** O mínimo que o guard precisa saber de uma sessão — o registro carrega bem mais. */
export interface SessionLiveness {
  sessionId: string;
  heartbeatAt: string;
  /** ausente ⇒ sessão ADOTADA (6.2), que não tem árvore por desenho */
  worktreePath?: string;
  task?: string;
}

/**
 * Heartbeat dentro do TTL? Um carimbo AUSENTE ou ilegível lê como VIVA — fail-closed: um erro de
 * parse nunca pode autorizar a remoção da árvore de alguém que está trabalhando.
 */
export function isSessionAlive(
  session: Pick<SessionLiveness, "heartbeatAt">,
  now: number,
  ttlMs: number = SESSION_HEARTBEAT_TTL_MS,
): boolean {
  const beat = Date.parse(session.heartbeatAt);
  if (!Number.isFinite(beat)) return true;
  return now - beat < ttlMs;
}

/** `agent/<uuid>` → o uuid. Qualquer outra forma (run/…, stage, main) → null. */
export function agentSessionIdFromBranch(branch: string | undefined): string | null {
  if (!branch) return null;
  const m = /^agent\/(.+)$/.exec(branch);
  return m ? m[1] : null;
}

export function sessionsFilePath(): string {
  return path.join(runnerStateDir(), "sessions.json");
}

/**
 * O registro, lido do disco. Nunca lança: um registro ausente/corrompido devolve `null`, que o
 * chamador DEVE tratar como "não sei" — e "não sei" jamais autoriza uma remoção.
 */
export function readSessionsFromDisk(file: string = sessionsFilePath()): SessionLiveness[] | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const rows = Array.isArray(raw) ? raw : raw?.sessions;
    return Array.isArray(rows) ? (rows as SessionLiveness[]) : null;
  } catch {
    return null;
  }
}

export type BranchLiveness =
  | { live: true; sessionId: string; task?: string }
  | { live: false; reason: "not-a-session-branch" | "unknown-session" | "heartbeat-expired" }
  | { live: "unknown"; reason: "registry-unreadable" };

/**
 * PURA: dado o conteúdo do registro, esta branch pertence a uma sessão VIVA?
 *
 * `unknown` (registro ilegível) é um terceiro estado de propósito — colapsá-lo em `false` seria
 * exatamente o bug que já varreu frota inteira uma vez: uma falha de leitura virando "todo mundo
 * morreu".
 */
export function branchLiveness(
  branch: string,
  sessions: SessionLiveness[] | null,
  now: number,
  ttlMs: number = SESSION_HEARTBEAT_TTL_MS,
): BranchLiveness {
  const sessionId = agentSessionIdFromBranch(branch);
  if (!sessionId) return { live: false, reason: "not-a-session-branch" };
  if (sessions === null) return { live: "unknown", reason: "registry-unreadable" };
  const row = sessions.find((s) => s.sessionId === sessionId);
  if (!row) return { live: false, reason: "unknown-session" };
  return isSessionAlive(row, now, ttlMs)
    ? { live: true, sessionId, task: row.task }
    : { live: false, reason: "heartbeat-expired" };
}
