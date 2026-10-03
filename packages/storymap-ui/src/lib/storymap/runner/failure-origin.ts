// A ORIGEM DE UMA FALHA — da FERRAMENTA (o ambiente em que o agente roda: o sandbox, o binário do agente, o host) ou
// do PRODUTO (o código, o teste, a skill que não entregou). PURA: evidência em texto entra, veredito sai — sem IO, para
// que o leitor do Inbox (decision-class.ts, que roda também no cliente) e o carimbo do run (run-death.ts) usem a MESMA
// régua.
//
// POR QUE EXISTE: um card morreu VÁRIAS vezes como `no-op` («o agente concluiu que não havia
// trabalho») com o mesmo texto final — «toda chamada de Bash falha na sandbox, com apply-seccomp: write
// /proc/self/setgroups ... Permission denied». O diagnóstico carimbado disse «Causa provável: APP … reabra em
// desenvolver/corrigir», o item foi ao dono com «Tentar de novo», e o dono apertou o botão de novo e de novo. Nenhuma
// resposta dele mudaria o desfecho: o conserto mora no host (AppArmor × user namespace aninhado), não no card. Uma
// falha cuja origem é a ferramenta NUNCA é decisão do dono (decision-class.ts) — esta é a régua que diz qual é.
//
// COMO JULGA, do mais específico para o mais geral:
//   1. ASSINATURAS conhecidas da ferramenta no texto (a postura rebaixada sem shell, seccomp/setgroups, userns
//      aninhado, bwrap, spawn ENOENT do binário do agente, EACCES do sandbox, a postura de contenção recusada) ⇒
//      `tool`, com uma assinatura ESTÁVEL (`<id>/<erro>`) e o hash dela — o mesmo defeito em vários runs dá a mesma
//      chave, mesmo com «...» × «…» no texto. É a ÚNICA porta para `tool`;
//   2. a classe JÁ atribuída por quem tem mais contexto (run-death, QA): `infra` ⇒ `environment`; `app`/`test` ⇒
//      `product`; `null` = já julgada e sem classe ⇒ `unknown` (o texto não é relido por cima do juízo);
//   3. sem classe atribuída, o classificador de mensagens que já existe (classifyFailure).
//
// POR QUE `infra` NÃO É `tool` (revisão do contrato): `tool` passa por cima do modo do board — vai ao sistema em
// QUALQUER modo, com o motivo «tentar de novo dá o mesmo desfecho». Isso só é verdade quando há uma assinatura do
// defeito no host. O carimbo do run-death põe `infra` em todo `error`/`oom-killed`: o teto de max-turns, a OOM por
// contenção de memória, o «API Error 529», o lock do worktree — falhas do AMBIENTE que às vezes passam sozinhas e que
// num board humano continuam do dono. `environment` segue a régua normal do modo.

import type { FailureClass } from "@/lib/storymap/types";
import { classifyFailure } from "./findings";

/**
 * `tool` = um defeito conhecido do host/da ferramenta (assinatura); `environment` = o ambiente do run falhou sem
 * assinatura (recurso, rede, API, stack do produto); `product` = o código/teste/skill; `unknown` = ninguém sabe.
 */
export type FailureOrigin = "tool" | "environment" | "product" | "unknown";

/** O que se sabe de uma falha. */
export interface FailureEvidence {
  /** o texto cru: o texto final do agente, o erro de ferramenta, a mensagem do spec, o detalhe da morte. */
  text?: string | null;
  /** a classe já atribuída por quem tem mais contexto. `null` = julgada sem classe; ausente = ninguém julgou. */
  failureClass?: FailureClass | null;
  /** um critério de PRODUTO falhou (o teste vermelho no diff do card). */
  criterionUnmet?: boolean;
}

export interface FailureOriginVerdict {
  origin: FailureOrigin;
  /** a assinatura estável de uma falha da ferramenta (`sandbox-seccomp/permission-denied`), ou null (só `tool` tem). */
  signature: string | null;
  /** o hash curto (FNV-1a, 8 hex) da assinatura — a chave compacta de dedup (card de conserto, repetição). */
  hash: string | null;
  /** o que a origem quer dizer, em linguagem de dono (a assinatura, ou o ambiente que falhou), ou null. */
  label: string | null;
  /** o trecho do texto que casou (≤ 200 caracteres), para o diagnóstico; null quando não veio do texto. */
  excerpt: string | null;
}

/**
 * As assinaturas da FERRAMENTA. Ordem = especificidade: a postura rebaixada (o run inteiro sem shell — o aviso dela
 * cita o setgroups como CAUSA, e o que o dono precisa ler é o efeito no run) antes do passo de seccomp, e este antes
 * do setgroups genérico.
 */
const TOOL_SIGNATURES: ReadonlyArray<{ id: string; label: string; re: RegExp }> = [
  // O aviso que autonomy-sandbox.ts (resolveAutonomyPosture) escreve quando um passo `full` roda rebaixado a `write`
  // — sem shell, por sandbox indisponível no host ou AGILEHARNESS_SANDBOX_MODE=off. Um passo `full` é o que precisa
  // do Bash; sem ele, o run termina em no-op e o texto final do agente já não traz o erro do sandbox. O carimbo
  // (run-death.ts) junta este aviso à evidência da morte.
  { id: "posture-no-shell", label: "o run rodou sem shell (a postura foi rebaixada) e este passo depende do Bash", re: /REBAIXADO full → write[^\n]*/i },
  { id: "sandbox-seccomp", label: "o sandbox do agente não deixa o Bash rodar (passo de seccomp)", re: /apply-seccomp\b[^\n]*/i },
  {
    id: "sandbox-setgroups",
    label: "o sandbox do agente não consegue montar o user namespace (setgroups)",
    re: /\/proc\/self\/setgroups[^\n]*(?:permission denied|operation not permitted|eperm|i\/o error|capability-restricted)[^\n]*/i,
  },
  { id: "sandbox-userns", label: "o kernel restringe o user namespace do sandbox", re: /(?:nested userns|user namespace)[^\n]*(?:restricted|denied|not permitted)[^\n]*/i },
  { id: "sandbox-bwrap", label: "o bubblewrap recusou montar o sandbox", re: /\bbwrap: [^\n]*/i },
  { id: "sandbox-eacces", label: "o sandbox negou acesso (EACCES)", re: /sandbox[^\n]*\beacces\b[^\n]*|\beacces\b[^\n]*sandbox[^\n]*/i },
  { id: "claude-enoent", label: "o binário do agente não foi encontrado pelo serviço", re: /spawn \S*claude\S* ENOENT[^\n]*/i },
  { id: "posture-refused", label: "a contenção do run foi recusada antes de começar", re: /autonomia sem conten[cç][aã]o recusada[^\n]*/i },
];

/** O ERRO dentro do trecho — a parte da assinatura que distingue «permissão negada» de «binário ausente». */
const ERRNO = /(permission denied|operation not permitted|i\/o error|no such file or directory|capability-restricted|enoent|eacces|eperm)/i;

/** FNV-1a 32 bits em 8 hex — determinístico, sem dependência. */
function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const verdict = (origin: FailureOrigin, signature: string | null, label: string | null, excerpt: string | null): FailureOriginVerdict => ({
  origin,
  signature,
  hash: signature ? fnv8(signature) : null,
  label,
  excerpt,
});

/** A assinatura de ferramenta que o texto carrega, ou null. PURA. */
export function toolSignature(text: string | null | undefined): FailureOriginVerdict | null {
  const t = text ?? "";
  if (!t) return null;
  for (const s of TOOL_SIGNATURES) {
    const m = s.re.exec(t);
    if (!m) continue;
    const excerpt = m[0].replace(/[`*]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    const errno = (ERRNO.exec(excerpt)?.[1] ?? "falha").toLowerCase().replace(/[\s/]+/g, "-");
    return verdict("tool", `${s.id}/${errno}`, s.label, excerpt);
  }
  return null;
}

/** A origem de uma falha. PURA. Só uma assinatura dá `tool` (ver o cabeçalho). */
export function failureOrigin(e: FailureEvidence): FailureOriginVerdict {
  const sig = toolSignature(e.text);
  if (sig) return sig;
  const cls = e.failureClass !== undefined ? e.failureClass : classifyFailure({ message: e.text ?? "", criterionUnmet: e.criterionUnmet });
  if (cls === "infra") return verdict("environment", null, "o ambiente do run falhou (recurso, rede, API) — não é o código do card", null);
  if (cls === "app" || cls === "test") return verdict("product", null, null, null);
  return verdict("unknown", null, null, null);
}

// ── a REPETIÇÃO de uma morte de run ───────────────────────────────────────────────────────────────────────────────
// O diagnóstico de morte (run-death.ts) é UM finding por card, refrescado a cada morte. Quantas vezes SEGUIDAS a mesma
// morte se repetiu vai no título, num formato que só este módulo escreve e lê — o leitor do Inbox precisa saber «é o
// mesmo no-op de novo» sem IO (decision-class.ts), e o título é o que o item já carrega.
//
// «A MESMA morte» = o mesmo motivo, no mesmo PASSO, com o mesmo TIPO de no-op e a mesma origem — tudo no título-base.
// O passo e o tipo entraram numa revisão do contrato: o diagnóstico só fecha com um run de SUCESSO (mover o card à
// mão não o fecha), então um no-op em «Especificar» num dia e um no-op de build em «Desenvolver» dias depois contavam
// como «2ª vez seguida», e o veredito tirava a decisão do dono com «tentar de novo não muda nada». Um título antigo
// (sem o passo) nunca soma com um novo — a contagem recomeça, do lado seguro.

const REPEAT_SUFFIX = / · (\d+)ª vez seguida$/;

/** O no-op de BUILD (C2/O3.5: o run «avançou», mas não produziu nenhum artefato de código) — o detalhe que o engine
 *  escreve. É outro desfecho que o no-op de avanço (o card não andou), e não soma com ele. */
const BUILD_NO_OP = /NENHUM artefato de c[óo]digo/i;

/** O tipo do no-op pelo detalhe do engine: `sem código` (o de build), ou null (o de avanço, ou outro motivo). PURA. */
export function noOpVariant(reason: string, detail: string | null | undefined): string | null {
  return reason === "no-op" && BUILD_NO_OP.test(detail ?? "") ? "sem código" : null;
}

/**
 * O título do diagnóstico de morte: o motivo (e o tipo de no-op), o passo, a falha da ferramenta quando é ela, e a
 * repetição a partir da 2ª. `step` = o nome do passo que rodou, como o board o mostra. PURA.
 */
export function runDeathTitle(
  reason: string,
  opts: { step?: string | null; variant?: string | null; toolSignature?: string | null; repeats?: number } = {},
): string {
  const base =
    `run morreu: ${reason}${opts.variant ? ` ${opts.variant}` : ""}${opts.step ? ` em «${opts.step}»` : ""}` +
    (opts.toolSignature ? ` · falha da ferramenta (${opts.toolSignature.split("/")[0]})` : "");
  const n = opts.repeats ?? 1;
  return n >= 2 ? `${base} · ${n}ª vez seguida` : base;
}

/** Quantas vezes seguidas a morte deste título aconteceu (1 quando o título não diz). PURA. */
export function runDeathRepeats(title: string | null | undefined): number {
  const m = REPEAT_SUFFIX.exec(title ?? "");
  return m ? Number(m[1]) : 1;
}

/** A repetição da PRÓXIMA morte: +1 quando o diagnóstico aberto é a mesma morte (motivo e origem), senão 1. PURA. */
export function nextRunDeathRepeats(openTitle: string | null | undefined, nextBaseTitle: string): number {
  if (!openTitle) return 1;
  return openTitle.replace(REPEAT_SUFFIX, "") === nextBaseTitle ? runDeathRepeats(openTitle) + 1 : 1;
}
