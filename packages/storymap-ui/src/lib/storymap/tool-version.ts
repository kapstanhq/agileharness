// A VERSÃO QUE ESTÁ NO AR — o recibo que `contrib/ah-release` deixa em `dist/ah-version.json` no swap.
//
// POR QUE EXISTE. Até a v0.9.23 não havia como PROVAR qual código o serviço vivo roda: `/api/health` é magro de
// propósito (não conta versão a quem não tem sessão), e um swap digitado à mão podia deixar o bundle de uma versão com o
// `.next` de outra sem que nada acusasse. O release agora escreve {tag, sha, at, prev, buildId} do lado do bundle que ele
// mesmo colocou no ar; a rota autenticada `/api/version` e a tool `ah_health` dizem a versão a partir DELE, e o release
// confere `/api/version == tag` depois do restart (e volta atrás se divergir).
//
// A VERSÃO NO AR É A DO BOOT, NÃO A DO DISCO (revisão do WP6b). A primeira versão desta leitura relia o arquivo a
// cada request — e o arquivo diz o que está no DISCO, não o que o processo carregou. Reproduzido: o ah-release grava o
// recibo v0.9.27 no swap e é morto (timeout do tool) antes do restart; o processo v0.9.26 continua no ar, lê o recibo
// novo e responde v0.9.27; a reexecução do release cai no caminho idempotente e imprime «já no ar e conferido» com exit 0
// — uma prova falsa. Agora o processo tira uma FOTO do recibo no boot (`captureToolVersionAtBoot`, chamada no topo do
// `register()` de instrumentation.ts) e é ela que se diz no ar; um recibo diferente no disco é «restart pendente».
//
// O RECIBO SÓ VALE PARA O BUILD QUE ELE DESCREVE. O release grava o BUILD_ID do `.next` que pôs no lugar; no boot o
// processo lê o BUILD_ID do build que ele serve. Se não batem, o build foi trocado por outro caminho depois do release —
// o self-deploy da fila de publicação (runner/deploy.ts, SWAP_AND_RESTART) troca `.next` e o bundle sem tocar no recibo,
// e um swap manual também — e a resposta honesta é «versão desconhecida, e por quê», nunca a tag que já não roda.
//
// O ARQUIVO MORA NO PACOTE QUE RODA (`findToolPackageDir`, o mesmo âncora do bundle e do `.next`), nunca no alvo: a
// versão da FERRAMENTA não é dado de nenhum board. Ausente = este build não passou pelo release (dev, build manual) — e
// isso é uma resposta legítima, dita com o porquê, nunca um número inventado.
//
// PURO na decisão (`parseToolVersion`, `runningToolVersion`, `pendingToolRelease`, `toolReleaseNote`); o IO fino é
// `readToolVersion`, `captureToolVersionAtBoot` e `readLiveToolVersion`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { findToolPackageDir } from "./paths";

/** O que o release grava. `prev` é a versão que estava no ar antes (para o rollback saber para onde voltar). */
export interface ToolVersion {
  tag: string;
  /** o commit da tag (o prefixo hexadecimal basta para conferir; o release grava inteiro). */
  sha: string;
  /** ISO do instante do swap. */
  at: string;
  prev: string | null;
  /** o BUILD_ID do `.next` que o release pôs no ar com este recibo — o que liga o recibo ao build que roda. */
  buildId: string;
}

/** Onde o release grava, relativo ao pacote da ferramenta. */
export const TOOL_VERSION_FILE = path.join("dist", "ah-version.json");

const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
/** O alfabeto do BUILD_ID que o `next build` gera (nanoid); entra em texto de motivo, então nada além dele. */
const BUILD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** O conteúdo de `ah-version.json` já validado, ou `null` (texto que não é JSON, campo faltando ou fora da forma). PURA. */
export function parseToolVersion(raw: string): ToolVersion | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (typeof o.tag !== "string" || !TAG.test(o.tag)) return null;
  if (typeof o.sha !== "string" || !SHA.test(o.sha)) return null;
  if (typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return null;
  if (o.prev != null && (typeof o.prev !== "string" || !TAG.test(o.prev))) return null;
  if (typeof o.buildId !== "string" || !BUILD_ID.test(o.buildId)) return null;
  return { tag: o.tag, sha: o.sha, at: o.at, prev: typeof o.prev === "string" ? o.prev : null, buildId: o.buildId };
}

export type ToolVersionRead = { version: ToolVersion; reason: null } | { version: null; reason: string };

/** O que ESTE processo viu ao subir: o recibo do disco naquele instante e o BUILD_ID do build que ele carregou. */
export interface ToolVersionAtBoot {
  receipt: ToolVersionRead;
  /** `null` quando o BUILD_ID não pôde ser lido (dev, `.next` ausente). */
  buildId: string | null;
}

/** A versão no ar e o release que espera restart — o que a rota e a tool devolvem. */
export interface LiveToolVersion {
  /** a versão que o processo RODA (a foto do boot, ligada ao build pelo BUILD_ID). */
  running: ToolVersionRead;
  /** o recibo que está no disco e ainda não roda: um release gravou depois do boot e o restart não veio. */
  pending: ToolVersion | null;
}

/**
 * A versão que roda, a partir da foto do boot: o recibo só vale se o BUILD_ID que ele grava for o do build que o processo
 * carregou. Sem recibo, o motivo dele passa adiante. PURA.
 */
export function runningToolVersion(boot: ToolVersionAtBoot): ToolVersionRead {
  const { receipt, buildId } = boot;
  if (!receipt.version) return receipt;
  const { tag } = receipt.version;
  if (!buildId) {
    return { version: null, reason: `o BUILD_ID do build em execução não pôde ser lido no boot: o recibo ${tag} não se liga a ele` };
  }
  if (receipt.version.buildId !== buildId) {
    return {
      version: null,
      reason:
        `o build em execução (${buildId}) não é o do recibo ${tag} (${receipt.version.buildId}): ` +
        `o build foi trocado fora do contrib/ah-release (self-deploy ou troca manual)`,
    };
  }
  return receipt;
}

const sameReceipt = (a: ToolVersion, b: ToolVersion) =>
  a.tag === b.tag && a.sha === b.sha && a.at === b.at && a.prev === b.prev && a.buildId === b.buildId;

/** O recibo do disco quando ele NÃO é o que o processo leu no boot (release gravado depois do boot), senão `null`. PURA. */
export function pendingToolRelease(boot: ToolVersionAtBoot, diskNow: ToolVersionRead): ToolVersion | null {
  const disk = diskNow.version;
  if (!disk) return null;
  const booted = boot.receipt.version;
  return booted && sameReceipt(booted, disk) ? null : disk;
}

/** A nota que acompanha a versão no ar: o motivo de não haver versão e/ou o release que espera restart. PURA. */
export function toolReleaseNote(live: LiveToolVersion): string | null {
  const parts: string[] = [];
  if (live.running.reason) parts.push(live.running.reason);
  if (live.pending) {
    parts.push(
      `o disco já tem o recibo de ${live.pending.tag} (gravado em ${live.pending.at}), mas este processo subiu antes dele: ` +
        `restart pendente — a versão no ar é a que ele carregou no boot`,
    );
  }
  return parts.length ? parts.join("; ") : null;
}

function resolvePackageDir(packageDir?: string): string | null {
  try {
    return packageDir ?? findToolPackageDir();
  } catch {
    return null;
  }
}

const NO_ROOT = "a raiz da ferramenta não foi resolvida (AGILEHARNESS_TOOL_ROOT)";

/**
 * O recibo que está no DISCO agora. Nunca lança: sem raiz resolvida, sem arquivo ou com arquivo malformado a resposta é
 * `version: null` com o MOTIVO. Não é «a versão no ar» — essa é {@link readLiveToolVersion}.
 */
export function readToolVersion(packageDir?: string): ToolVersionRead {
  const dir = resolvePackageDir(packageDir);
  if (!dir) return { version: null, reason: NO_ROOT };
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, TOOL_VERSION_FILE), "utf8");
  } catch {
    return { version: null, reason: `${TOOL_VERSION_FILE} ausente — este build não passou por contrib/ah-release` };
  }
  const version = parseToolVersion(raw);
  return version
    ? { version, reason: null }
    : { version: null, reason: `${TOOL_VERSION_FILE} ilegível (esperado {tag, sha, at, prev, buildId})` };
}

/** O BUILD_ID do build que o servidor serve: o `distDir` vem do mesmo env que o `next.config.js` lê. */
function readBuildId(packageDir: string): string | null {
  try {
    const id = readFileSync(path.join(packageDir, process.env.AGILEHARNESS_DIST_DIR || ".next", "BUILD_ID"), "utf8").trim();
    return BUILD_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// `globalThis` + `Symbol.for`, como em runner/boot-signal.ts: `instrumentation.ts` e a rota podem ser empacotados em
// grafos de módulo diferentes no mesmo processo, e um estado de módulo daria duas fotos.
const BOOT_KEY = Symbol.for("agileharness.toolVersionAtBoot");
type BootSlot = Record<symbol, ToolVersionAtBoot | undefined>;

/**
 * Tira a foto do boot: o recibo e o BUILD_ID que estão no disco AGORA, guardados para a vida do processo. Chamada no topo
 * do `register()` — o mais perto possível do instante em que o Next carregou o build. Idempotente: a primeira foto vence.
 */
export function captureToolVersionAtBoot(packageDir?: string): ToolVersionAtBoot {
  const g = globalThis as unknown as BootSlot;
  const existing = g[BOOT_KEY];
  if (existing) return existing;
  const dir = resolvePackageDir(packageDir);
  const snapshot: ToolVersionAtBoot = dir
    ? { receipt: readToolVersion(dir), buildId: readBuildId(dir) }
    : { receipt: { version: null, reason: NO_ROOT }, buildId: null };
  g[BOOT_KEY] = snapshot;
  return snapshot;
}

/**
 * A versão no ar (a foto do boot) e o release que espera restart (o disco de agora). Sem foto — o `register()` não rodou
 * (teste, `next dev` sem instrumentação) ou um request chegou na fração de segundo antes dele —, a primeira leitura VIRA a
 * foto: logo depois do boot o disco ainda é o que o processo carregou.
 */
export function readLiveToolVersion(packageDir?: string): LiveToolVersion {
  const boot = captureToolVersionAtBoot(packageDir);
  return { running: runningToolVersion(boot), pending: pendingToolRelease(boot, readToolVersion(packageDir)) };
}

/** Só para teste: esquece a foto do boot (cada caso monta o seu pacote descartável). */
export function resetToolVersionAtBoot(): void {
  delete (globalThis as unknown as BootSlot)[BOOT_KEY];
}
