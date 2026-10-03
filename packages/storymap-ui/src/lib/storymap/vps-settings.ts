// O BLOCO `vps:` DO SETTINGS — o que é do HOST onde o serviço roda, não do repositório alvo. PURO.
//
// POR QUE EXISTE: dois números da máquina do dono estavam cravados no código — o limite semanal de tokens da assinatura
// (o denominador do «% usado») e o endereço do proxy de uso de onde o medidor lê o `/stats`. Quem instala em outra máquina
// herdaria um percentual calculado contra um orçamento que não é o dele, e um medidor apontando para uma porta que pode
// ser OUTRA coisa. Agora eles são declaração do operador:
//
//   vps:
//     weeklyTokenLimit: <tokens por semana>   # ausente ⇒ sem % (a UI mostra «sem limite»); nenhum balde inventado
//     headroomUrl: http://127.0.0.1:<porta>   # ausente ⇒ nenhum medidor; o governador de capacidade fica INERTE
//
// `headroomUrl` é só LEITURA do `/stats` (medidor + governador). NÃO roteia o tráfego dos agentes — isso continua sendo
// `AGILEHARNESS_HEADROOM_URL`/`board.yaml headroom`, porque a mesma env que lê também liga o roteamento de TODOS os spawns
// sem board, e confundir os dois seria uma mudança observável. Precedência de quem consome: env > `vps.*` > nada.
//
// Só LOOPBACK com porta e sem credencial: a URL é buscada pelo SERVIÇO (SSRF). Um proxy em outro host se declara pelo env
// do serviço, que é outro canal de confiança.
//
// Por que um bloco tipado e não um `yaml.load` solto (como `metrics.ts` fazia): o painel de configuração reescreve o
// settings.yaml a partir do `RunnerSettings` — uma chave que o coerce não carrega SOME na primeira gravação.

import { isLoopbackUrlWithPort } from "./target-profile";

export interface VpsSettings {
  /** tokens por semana (inteiro positivo). */
  weeklyTokenLimit?: number;
  /** base do proxy de uso (sem `/` final, sem caminho de consulta). */
  headroomUrl?: string;
}

/** Um limite semanal plausível: inteiro positivo até 10^13 (acima disso é um zero a mais, não um plano). */
const WEEKLY_MAX = 1e13;

/** O bloco `vps:` tolerante: peça fora da forma é DESCARTADA com aviso, o resto segue; sem nada aproveitável ⇒ undefined. */
export function coerceVpsSettings(raw: unknown, warn: (m: string) => void = (m) => console.warn(m)): VpsSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn("[storymap] settings vps: DESCARTADO — deveria ser um mapa { weeklyTokenLimit?, headroomUrl? }.");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: VpsSettings = {};
  if (r.weeklyTokenLimit !== undefined) {
    const n = typeof r.weeklyTokenLimit === "number" ? r.weeklyTokenLimit : Number.NaN;
    if (Number.isFinite(n) && n >= 1 && n <= WEEKLY_MAX) out.weeklyTokenLimit = Math.floor(n);
    else warn("[storymap] settings vps.weeklyTokenLimit: DESCARTADO — exige um número inteiro positivo de tokens por semana; sem ele o % usado não é calculado.");
  }
  if (r.headroomUrl !== undefined) {
    const u = typeof r.headroomUrl === "string" ? r.headroomUrl.trim().replace(/\/+$/, "") : "";
    let clean = false;
    try {
      const parsed = u ? new URL(u) : null;
      clean = !!parsed && parsed.pathname === "/" && !parsed.search && !parsed.hash;
    } catch {
      clean = false;
    }
    if (clean && isLoopbackUrlWithPort(u)) out.headroomUrl = u;
    else warn("[storymap] settings vps.headroomUrl: DESCARTADO — exige http(s) em loopback com porta, sem credencial nem caminho (ex.: http://127.0.0.1:<porta>); sem ele não há medidor.");
  }
  return Object.keys(out).length ? out : undefined;
}

/** O que a resolução lê do RunnerSettings (estrutural). */
export interface VpsSource {
  vps?: VpsSettings;
}

/** O `vps:` declarado; `{}` quando o alvo não declarou — NUNCA o limite nem a porta da máquina de origem. PURA. */
export function vpsOf(settings: VpsSource | null | undefined): VpsSettings {
  return { ...(settings?.vps ?? {}) };
}
