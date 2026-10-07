// A FRONTEIRA DE PUBLICAÇÃO — o modelo de leitura de "o que está no stage e ainda não está no ar", e a régua de
// quando um pedido de publicação segurado virou BLOQUEIO.
//
// Nasceu como o modelo da página de Entrega (a Esteira), que juntava frota, train, stage e fila de publicação numa
// tela só. A Esteira saiu na fase 3 — as alavancas dela moram no Inbox (o pedido segurado, «Publicar as N
// entregas», «Refazer o pedido agora») — e daqui sobrou o que o Inbox e o dreno da fila consomem: a fronteira de um
// board (`delivery-deps` `frontierOf`) e as réguas dos pedidos segurados.
//
// PURO por construção: nada de fs, git ou config — o chamador injeta (ver `delivery-deps.ts`).

import type { PublishRequest } from "./publish-queue";
import type { ReleaseMode } from "@/lib/storymap/types";

/** Um commit já integrado ao stage e ainda não promovido: uma entrega pronta, invisível para quem usa. */
export interface StagedDelivery {
  sha: string;
  subject: string;
  at: string;
  /** a sessão que a produziu, quando o assunto do commit a nomeia. */
  sessionId?: string;
}

/** A fronteira de um board: o que está no ar, o que está no stage e o que separa os dois. */
export interface BoardFrontier {
  board: string;
  /**
   * Como a publicação deste board é ORIGINADA (`board.yaml release.mode`). `manual` = acumula até
   * alguém pedir; `auto` = o sistema pede sozinho. NÃO é permissão: em ambos a página oferece o botão.
   */
  releaseMode: ReleaseMode;
  /**
   * A máquina de publicação existe (kill-switch global + staging)? É a permissão, e ela independe do
   * board — separá-la do modo é a correção: uma flag só respondia as duas e apagava o botão junto.
   */
  canPublish: boolean;
  /** board só de organização: nada publica dali (o botão some e a action recusa) */
  organizeOnly?: boolean;
  liveSha: string | null;
  liveAt: string | null;
  stageSha: string | null;
  /** as entregas LISTADAS — capadas para a raia mostrar entregas, não o histórico do repositório. */
  staged: StagedDelivery[];
  /**
   * Quantas entregas existem de fato entre a fronteira publicada e o stage. Separado de `staged.length`
   * porque a lista é TRUNCADA: acima do teto, contar a lista fazia "N entregas ainda não no ar" reportar
   * o teto como se fosse o total — e este é o número que decide publicar.
   */
  stagedTotal: number;
  /**
   * Quantos arquivos do escopo a stage tem MAIS NOVOS que a main (stage-content.ts) — a régua por conteúdo que decide se
   * há entrega pendente. Ausente = não medido (sem stage, git que não respondeu).
   */
  pendingFiles?: number;
}

/**
 * Os pedidos SEGURADOS: esperando há tempo suficiente para o sistema já ter dito por quê. É o único
 * item da página que pede uma decisão humana, e era exatamente o que não tinha superfície nenhuma —
 * `heldSince`/`heldCount`/`reason` existiam no disco e morriam lá.
 */
export function heldRequests(rows: readonly PublishRequest[]): PublishRequest[] {
  return rows.filter((r) => r.status === "waiting" && !!r.heldSince);
}

/**
 * Espera longa com contagem alta é BLOQUEIO, não lentidão — a régua que a doc do `publish_status` já
 * prescreve, aqui como código para ninguém a reinventar por olhômetro.
 *
 * É A régua, no singular: além da UI, o DRENO a consulta para disparar o aviso na borda em que um pedido
 * vira bloqueio (`publish-queue` `onBlocked`). Uma segunda cópia lá seria a que apodrece — e apodreceria
 * calada, porque as duas só divergem no dia em que alguém mexer num dos limiares.
 */
export function isBlocked(req: PublishRequest, now: number, opts?: { minMs?: number; minCount?: number }): boolean {
  if (req.status !== "waiting" || !req.heldSince) return false;
  const minMs = opts?.minMs ?? 10 * 60_000;
  const minCount = opts?.minCount ?? 10;
  const held = now - Date.parse(req.heldSince);
  return Number.isFinite(held) && held >= minMs && (req.heldCount ?? 0) >= minCount;
}

// ── Parse do log de commits staged ───────────────────────────────────────────────────────────────

/**
 * O formato do `git log` que {@link parseStagedLog} entende: sha, data ISO e assunto, NESTA ordem,
 * separados por espaço. Os dois primeiros campos nunca contêm espaço, então o assunto — que contém — é
 * simplesmente "o resto da linha". Deliberadamente SEM `%x00`: um separador NUL viaja mal neste
 * repositório (o split do merge train quebra em arquivo com byte NUL) e não compraria nada aqui.
 */
export const STAGED_LOG_FORMAT = "%H %cI %s";

/** `usm(sessão): código staged (sessão <uuid>)` — o rastro que liga um commit do stage à sessão dona. */
const SESSION_IN_SUBJECT = /\(sess(?:ão|ao)\s+([0-9a-f-]{8,})\)/i;

/**
 * Converte a saída de `git log --format=${STAGED_LOG_FORMAT}` em entregas. Tolerante por LINHA (uma
 * linha malformada é descartada, não derruba a lista) — mesmo princípio do journal: um artefato de
 * diagnóstico nunca pode ficar em branco por causa de um registro estranho.
 */
/**
 * Quantas entregas existem de fato, dado o `git rev-list --count` e o que coube na lista truncada.
 *
 * A regra que importa é a de FALHA: contagem ilegível — ou menor que a própria lista, o que só acontece
 * se as duas leituras discordarem — cai no tamanho da lista. Sub-reportar é o erro barato (a página
 * mostra o que tem); inventar um total é o caro, porque este é o número em cima do qual alguém aperta
 * "Publicar". Vizinho de `parseStagedLog` de propósito: mesma família, mesma disciplina de tolerar
 * saída estranha do git em vez de confiar nela.
 */
export function stagedTotalOf(countStdout: string | null | undefined, listed: number): number {
  const n = Number.parseInt((countStdout ?? "").trim(), 10);
  return Number.isFinite(n) && n >= listed ? n : listed;
}

export function parseStagedLog(stdout: string): StagedDelivery[] {
  const out: StagedDelivery[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace < 0) continue;
    const sha = trimmed.slice(0, firstSpace);
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const rest = trimmed.slice(firstSpace + 1);
    const secondSpace = rest.indexOf(" ");
    const at = secondSpace < 0 ? rest : rest.slice(0, secondSpace);
    if (!at) continue;
    const subject = secondSpace < 0 ? "" : rest.slice(secondSpace + 1).trim();
    const sessionId = subject.match(SESSION_IN_SUBJECT)?.[1];
    out.push({ sha, subject, at, ...(sessionId ? { sessionId } : {}) });
  }
  return out;
}
