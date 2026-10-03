// O deploy declarado que diz «PRECISA DE VOCÊ» — o contrato da saída 3 de `deploy.kind: command`.
//
// O PROBLEMA. Um comando de deploy declarado pode sair com 3: «há unidade que só um humano publica — nada foi
// publicado», e imprimir quais unidades e a receita de cada uma. Tratar isso como falha gera o aviso errado
// («Deploy de produção falhou — reentrar no Deploy»): nada falhou, o comando fez o que devia, e reentrar só repete o 3
// — a unidade continua esperando a mão do dono. Faltaria dizer qual unidade e qual receita.
//
// O CONTRATO (documentado em storymap/boards/_base/board.yaml, bloco `deploy`). Um comando de deploy declarado
// que sai com {@link DEPLOY_NEEDS_HUMAN_EXIT} diz: nada foi publicado, há algo que alguém precisa destravar. O que
// ele imprimir por último é o recado (a receita); se imprimir uma linha JSON com `status: "needs-human"` (ou
// `"needs-units"`, o contrato novo), a lista `human` (no topo ou em `plan`) nomeia as unidades (`{unit}` ou o nome) e as
// regras. QUEM destrava não é o status único: é a régua de deploy-blocks.ts, entrada por entrada (um mesmo plano pode
// misturar regras de dinheiro, do dono, e lacunas de configuração, do sistema — e o status único mandaria tudo ao dono).
// O contrato é do COMANDO: o agente de deploy responde por veredito, e o orch-deploy legado não dá sentido
// ao 3 — para eles, 3 segue sendo falha.
//
// Leitura PURA + um read best-effort (nunca lança — um callback de deploy não pode quebrar por um log ausente).
// SERVER-ONLY (node:fs). Mesma fiação do FACE_GATE_FAIL (face-gate-detail.ts): o lançador grava a saída do
// filho em logFileFor(pkg), e este módulo a lê de volta no settle.

import { promises as fsp } from "node:fs";
import { logFileFor, type DeployDoneEvent } from "./product-deploy";
import type { DeployFailureDetail } from "./deploy-revert";
import { parseDeployExit3Report, type DeployExit3Report } from "./deploy-proof";

/** A saída com que um deploy DECLARADO (`kind: command`) diz «precisa de você — nada foi publicado». */
export const DEPLOY_NEEDS_HUMAN_EXIT = 3;

/** Quantas linhas finais da saída do comando viram o recado (o fim é onde o comando fala com o dono). */
const MESSAGE_MAX_LINES = 12;
const MESSAGE_MAX_CHARS = 1500;

/** PURE: este settle é o comando declarado pedindo o dono (e não uma falha)? */
export function isDeployNeedsHuman(ev: Pick<DeployDoneEvent, "ok" | "exitCode" | "declaredKind">): boolean {
  return !ev.ok && ev.declaredKind === "command" && ev.exitCode === DEPLOY_NEEDS_HUMAN_EXIT;
}

export interface NeedsHumanReport {
  /** as unidades que o plano segurou, na ordem, sem repetição — [] quando o comando não as declarou. */
  units: string[];
  /** as últimas linhas que o comando imprimiu (o recado dele ao dono), ou null quando não há nenhuma. */
  message: string | null;
}

/** A moldura que o PRÓPRIO lançador escreve no log (`[deploy <alvo>] $ …`, `[deploy <alvo>] finished exit N`). */
const FRAME_RE = /^\[deploy [^\]]*\]/;

function jsonObject(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function unitsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const h of list) {
    const u = typeof h === "string" ? h : h && typeof h === "object" ? (h as { unit?: unknown }).unit : null;
    if (typeof u === "string" && u.trim()) out.push(u.trim());
  }
  return out;
}

/**
 * PURE: o que o comando disse, lido do log do deploy. As unidades vêm da ÚLTIMA linha JSON com
 * `status: "needs-human"` (a lista `human`, no topo ou em `plan`); o recado são as últimas linhas que não são
 * nem moldura do lançador nem JSON. Nunca inventa: sem JSON ⇒ sem unidades; log vazio ⇒ recado null.
 */
export function parseNeedsHumanReport(log: string): NeedsHumanReport {
  const text: string[] = [];
  let units: string[] = [];
  for (const raw of (log ?? "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || FRAME_RE.test(line.trim())) continue;
    const obj = jsonObject(line.trim());
    if (obj) {
      if (obj.status === "needs-human" || obj.status === "needs-units") {
        const plan = obj.plan && typeof obj.plan === "object" ? (obj.plan as Record<string, unknown>) : null;
        const found = unitsOf(obj.human).length > 0 ? unitsOf(obj.human) : unitsOf(plan?.human);
        units = [...new Set(found)];
      }
      continue;
    }
    text.push(line);
  }
  const tail = text.slice(-MESSAGE_MAX_LINES).join("\n").trim();
  return { units, message: tail ? tail.slice(-MESSAGE_MAX_CHARS) : null };
}

/**
 * Best-effort: o RELATÓRIO da saída 3 no log do deploy de `pkg` — needs-human (dinheiro, do dono) × needs-proof (falta
 * uma prova, do sistema; deploy-proof.ts). Log ausente/ilegível ⇒ `status: null`. Nunca lança.
 */
export async function readDeployExit3Report(pkg: string): Promise<DeployExit3Report> {
  try {
    return parseDeployExit3Report(await fsp.readFile(logFileFor(pkg), "utf8"));
  } catch {
    return parseDeployExit3Report("");
  }
}

/** Best-effort: o recado do comando no log do deploy de `pkg`. Log ausente/ilegível ⇒ nada. Nunca lança. */
export async function readNeedsHumanReport(pkg: string): Promise<NeedsHumanReport> {
  try {
    return parseNeedsHumanReport(await fsp.readFile(logFileFor(pkg), "utf8"));
  } catch {
    return { units: [], message: null };
  }
}

/**
 * PURE: o settle de deploy que NÃO confirmou (saída ≠ 0, ou exit 0 sem trabalho) vira o detalhe do revert.
 * Um lugar só decide a fase — antes ela era um ternário dentro do canal, e o 3 do comando declarado caía em
 * «deploy» (falha genérica). `faceReason` é o veredito do gate da face (face-gate-detail.ts), quando houver.
 */
export function settleFailureDetail(
  ev: DeployDoneEvent,
  extra: { needsHuman?: NeedsHumanReport; exit3?: DeployExit3Report; faceReason?: string | null } = {},
): DeployFailureDetail {
  // A saída 3 DIVIDIDA pela última linha JSON: `needs-proof` (falta uma prova para esta mudança
  // exata) é trabalho do SISTEMA (deploy-proof-producer.ts). O resto da saída 3 leva o relatório inteiro ao revert, que
  // tem a config do board e decide pela régua de deploy-blocks.ts quem destrava: o dono (`needs-human`) ou o sistema
  // (`needs-units`). A fase daqui é PROVISÓRIA — e a saída 3 sem JSON legível segue do dono (fail-closed).
  if (isDeployNeedsHuman(ev) && extra.exit3?.status === "needs-proof") {
    return { pkg: ev.pkg, exitCode: ev.exitCode, phase: "needs-proof", proofReport: extra.exit3 };
  }
  if (isDeployNeedsHuman(ev)) {
    const report = extra.needsHuman ?? { units: [], message: null };
    return {
      pkg: ev.pkg,
      exitCode: ev.exitCode,
      phase: extra.exit3?.status === "needs-units" ? "needs-units" : "needs-human",
      ...(report.units.length > 0 ? { units: report.units } : {}),
      ...(report.message ? { commandSays: report.message } : {}),
      ...(extra.exit3?.humanRules.length ? { humanRules: extra.exit3.humanRules } : {}),
      ...(extra.exit3?.status ? { plan: extra.exit3 } : {}),
    };
  }
  return {
    pkg: ev.pkg,
    exitCode: ev.exitCode,
    phase: ev.ok ? "deploy-noop" : "deploy",
    reason: extra.faceReason ?? undefined,
  };
}
