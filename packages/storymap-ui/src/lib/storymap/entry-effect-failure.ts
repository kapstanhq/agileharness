// O FATO durável de um efeito de entrada que falhou DEPOIS do clique.
//
// Um efeito de entrada (promote-stage / deploy-board / promote-and-deploy) roda depois de a ação de servidor
// responder: moveCardAction/updateCardAction/republishCardAction devolviam `ok` e o efeito corria solto
// (`void …catch(console.error)`). Uma recusa dele — o descritor de deploy inválido, o comando não autorizado, a
// autorização do preflight recusada no registry, uma promoção adiada — ou um erro só existiam no log do serviço, e
// o dono lia «Aprovar & avançar: ok» sobre um card que nunca foi publicado (incidente do efeito silencioso). Este módulo é a parte
// PURA do conserto: o finding que o relatório do efeito grava (e resolve) no card, e a leitura do resultado de
// cada efeito. Client-safe (a projeção do Inbox lê o mesmo id).

import { ENTRY_EFFECT_FAILED_FINDING_ID } from "./demands";
import type { EntryEffect, Finding } from "./types";

/** O que cada efeito É, em palavras do dono — sujeito das frases do finding e do retorno do clique. */
export const ENTRY_EFFECT_WHAT: Record<EntryEffect, string> = {
  "promote-stage": "a promoção do código para a main",
  "deploy-board": "o deploy",
  "promote-and-deploy": "a publicação (código para a main + deploy)",
};

/** O título do finding: o fato, no passado, sem jargão. */
export const ENTRY_EFFECT_FAILED_TITLE: Record<EntryEffect, string> = {
  "promote-stage": "A promoção do código para a main não aconteceu",
  "deploy-board": "O deploy não começou",
  "promote-and-deploy": "A publicação não aconteceu",
};

/**
 * A RECUSA que o resultado de um efeito carrega, ou null quando ele rodou. Leitura ESTRUTURAL — o resultado é
 * `unknown` no mapa ENTRY_EFFECTS, e o campo pertence a quem o devolve:
 *  - `deploy-board` → `DeployResult.refused` (deploy.ts: descritor inválido, comando/autorização recusados);
 *  - `promote-and-deploy` → `ReleaseOutcome.deployNotStarted` (a promoção aterrissou, o deploy nem começou). A
 *    promoção que FALHA não conta aqui: ela já reverte o card com o finding `deploy-failure`, e um segundo fato
 *    para a mesma falha seria o item duplicado que o B6 existe para apagar;
 *  - `promote-stage` → `ReleaseOutcome.revert` (a promoção não aterrissou; standalone, ninguém mais o diz).
 * PURE.
 */
export function entryEffectRefusal(effect: EntryEffect, result: unknown): string | null {
  const r = (result ?? {}) as { refused?: unknown; deployNotStarted?: unknown; revert?: unknown; reason?: unknown; outcome?: unknown };
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  switch (effect) {
    case "deploy-board":
      return text(r.refused);
    case "promote-and-deploy":
      return text(r.deployNotStarted);
    case "promote-stage":
      return r.revert === true ? (text(r.reason) ?? `a promoção terminou em «${String(r.outcome ?? "?")}»`) : null;
  }
}

/**
 * O finding de um efeito que falhou em `stepName`. `reason` vai inteiro (truncado) no detalhe — é a frase que o
 * dono precisa para agir. severity `high`: alerta de operador, nunca `blocker` (não pode gatear o próximo passo).
 * PURE.
 */
export function buildEntryEffectFailedFinding(effect: EntryEffect, stepName: string, reason: string): Finding {
  return {
    id: ENTRY_EFFECT_FAILED_FINDING_ID,
    lens: "general",
    severity: "high",
    title: ENTRY_EFFECT_FAILED_TITLE[effect],
    detail: `Ao entrar em «${stepName}», ${ENTRY_EFFECT_WHAT[effect]} não aconteceu. Motivo: ${reason.slice(0, 600)}`,
    suggestion: `Resolva o motivo acima e tente de novo — ${ENTRY_EFFECT_WHAT[effect]} roda outra vez a partir de «${stepName}», sem mover o card.`,
    status: "open",
  };
}

/**
 * `findings` com a falha gravada (upsert por id: uma por card, a mais recente vence e REABRE). null quando a
 * mesma falha já está aberta com o mesmo texto — a escrita idempotente que não re-dispara o watcher em laço.
 * PURE.
 */
export function withEntryEffectFailure(findings: readonly Finding[], failure: Finding): Finding[] | null {
  const cur = findings.find((f) => f.id === failure.id);
  if (cur && cur.status === "open" && cur.title === failure.title && (cur.detail ?? "") === (failure.detail ?? "")) return null;
  if (!cur) return [...findings, failure];
  return findings.map((f) => (f.id === failure.id ? failure : f));
}

/** `findings` com a falha aberta RESOLVIDA (o efeito rodou limpo), ou null quando não há falha aberta. PURE. */
export function withEntryEffectResolved(findings: readonly Finding[], by: string, at: string): Finding[] | null {
  if (!findings.some((f) => f.id === ENTRY_EFFECT_FAILED_FINDING_ID && f.status === "open")) return null;
  return findings.map((f) =>
    f.id === ENTRY_EFFECT_FAILED_FINDING_ID && f.status === "open" ? { ...f, status: "fixed" as const, statusBy: by, statusAt: at } : f,
  );
}
