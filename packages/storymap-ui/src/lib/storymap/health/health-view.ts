// O BLOCO «SAÚDE DA FERRAMENTA» de /processes — o modelo PURO que a tela desenha, e o resumo da última leitura que a rota de
// versão devolve. Zero IO, zero relógio (quem chama passa `now`).
//
// A TELA LÊ, NÃO MEDE. O tick (health-deps.ts) anexa uma leitura ao health.jsonl a cada 5 min; a página lê a ÚLTIMA e a
// desenha. Remedir na renderização custaria o Inbox de todos os boards por visita — e daria à tela um número diferente do
// que o card `[saude:*]` e a tool `ah_health` mostram. Por isso o modelo nasce de um `HealthRecord`, não de `HealthInputs`.
//
// O QUE A TELA NUNCA ESCONDE: sem leitura é «sem leitura ainda» (não um verde), leitura velha é «parou de medir» (não um
// verde congelado), e sinal que não mede é «não medível» (o mesmo `unknown` do relatório). Uma tela de saúde que mostra
// verde quando o medidor está desligado é pior que nenhuma.

import {
  healthSignalCatalog,
  worstLevel,
  type HealthLevel,
  type HealthRecord,
  type HealthSettings,
  type HealthSignalId,
} from "./ah-health";

/** A palavra de cada nível — a TELA sempre escreve o nível, nunca só a cor. */
export const HEALTH_LEVEL_TEXT: Readonly<Record<HealthLevel, string>> = {
  ok: "ok",
  amber: "atenção",
  red: "vermelho",
  unknown: "não medível",
};

export type HealthMark = "check" | "filled" | "ring";

export interface HealthTone {
  /** a classe do ponto (forma + cor); vazia em `check` (o ícone carrega a cor pelo texto). */
  dot: string;
  /** a tinta do nível escrito. */
  text: string;
  mark: HealthMark;
}

/**
 * A cor de cada nível, nos tokens de estado (`--state-*`, globals.css) — uma cor, um significado, e sempre com forma e
 * palavra junto. A escolha é deliberada e foge do âmbar: no vocabulário único do Kanban e do nav, âmbar é «precisa de
 * você», e um sinal de saúde NUNCA é do dono (é trabalho do sistema; o dono só é chamado pelo que cai nas classes dele).
 *   • ok          — verde, só como texto, com o ✓ (como «No ar»);
 *   • amber       — violeta preenchido: a vez é do SISTEMA (a mesma cor de «integrando/publicando»);
 *   • red         — terracota preenchido: falhou e algo precisa ser consertado (`--danger`, o único vermelho);
 *   • unknown     — cinza, círculo vazio: não dá para medir (a mesma forma de «parado»).
 */
export const HEALTH_TONE: Readonly<Record<HealthLevel, HealthTone>> = {
  ok: { dot: "", text: "text-state-live", mark: "check" },
  amber: { dot: "bg-state-delivering", text: "text-fg", mark: "filled" },
  red: { dot: "bg-danger", text: "text-danger", mark: "filled" },
  unknown: { dot: "border-[1.5px] border-state-idle bg-transparent", text: "text-fg-subtle", mark: "ring" },
};

export interface HealthPanelRow {
  id: HealthSignalId;
  label: string;
  level: HealthLevel;
  /** o nível em palavras. */
  levelText: string;
  /** «11 itens», «83%», «não medível», «sem leitura». */
  valueText: string;
  /** a linha de evidência do dia (a que o tick gravou); `null` para leitura sem ela. */
  detail: string | null;
  /** a regra em palavras, para quem quiser saber o que acende o sinal (vai no `title` da linha). */
  rule: string;
}

/** `empty` nenhuma leitura · `fresh` leitura recente · `stale` leitura velha demais · `off` o tick está desligado. */
export type HealthPanelState = "empty" | "fresh" | "stale" | "off";

export interface HealthPanelModel {
  state: HealthPanelState;
  /** ISO da leitura mostrada; `null` quando não há. */
  at: string | null;
  /** o pior nível da leitura; `null` sem leitura. */
  worst: HealthLevel | null;
  /** a frase de cima: o pior nível e a contagem por nível. */
  headline: string;
  /** o aviso de estado (sem leitura, velha, tick desligado); `null` quando está tudo em ordem. */
  note: string | null;
  rows: HealthPanelRow[];
}

/** «há 3 min», «há 2 h», «há 1 d» — a idade da leitura em palavras. PURA. */
export function ageWords(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / (24 * 60))} d`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** O singular das unidades dos sinais — «1 cards», «1 saltos» eram o que a tela dizia. */
const UNIT_SINGULAR: Readonly<Record<string, string>> = {
  cards: "card",
  itens: "item",
  agentes: "agente",
  saltos: "salto",
  repetições: "repetição",
};

/** Número em pt-BR: vírgula decimal («6,4», nunca «6.4»). PURA. */
function num(value: number): string {
  return String(value).replace(".", ",");
}

/** O valor de um sinal escrito com a unidade (`%` cola no número; singular no 1). PURA. */
export function valueText(value: number | null, unit: string): string {
  if (value == null) return "não medível";
  if (unit === "%") return `${num(value)}%`;
  return `${num(value)} ${value === 1 ? (UNIT_SINGULAR[unit] ?? unit) : unit}`;
}

/**
 * A linha de evidência em português de gente: vírgula decimal, «(s)» resolvido pelo número, «1 cards» no singular e os
 * códigos internos de bloqueio em palavras. O texto vem gravado pelo tick (não dá para refazê-lo na origem sem reescrever
 * leituras antigas), então a tela o arruma ao desenhar. PURA.
 */
export function humanDetail(text: string): string {
  return text
    // só a grandeza com unidade («6.4 h», «4.5 min», «12.5%») — versões e ids («v1.2») ficam como estão
    .replace(/(^|[\s(])(\d+)\.(\d+)(?=\s?(?:h|min|d|s|%)(?![\p{L}\d]))/gu, "$1$2,$3")
    .replace(/\b(\d+) (\p{L}+)\(s\)/gu, (_m, n: string, w: string) => `${n} ${n === "1" ? w : `${w}s`}`)
    .replace(/\b1 (cards|itens|agentes|saltos|repetições)\b/g, (_m, u: string) => `1 ${UNIT_SINGULAR[u] ?? u}`)
    .replace(/\(needs-human\|(\d+)\)/g, "(espera uma pessoa · $1)")
    .replace(/\bneeds-human\b/g, "espera uma pessoa")
    .replace(/\bledger\b/g, "histórico de status");
}

/** Quantos ticks sem leitura nova até a tela chamar a leitura de velha (um atraso ou outro é normal; 3 seguidos não). */
const STALE_AFTER_TICKS = 3;

/**
 * O modelo do bloco a partir das leituras gravadas (só a ÚLTIMA importa; o resto pode estar vazio). PURA.
 *
 * Os 12 sinais saem SEMPRE, na ordem dos ids — comparável de uma visita para outra. Um sinal que a leitura não traz (de um
 * tick de uma versão com menos sinais) aparece como «sem leitura», nunca some.
 */
export function healthPanelModel(
  records: readonly HealthRecord[],
  settings: Pick<HealthSettings, "tickMinutes" | "thresholds">,
  now: number,
): HealthPanelModel {
  const last = records.length ? [...records].sort((a, z) => a.at.localeCompare(z.at))[records.length - 1] : null;
  const catalog = healthSignalCatalog(settings.thresholds);
  const rows: HealthPanelRow[] = catalog.map((info) => {
    const s = last?.signals[info.id];
    return {
      id: info.id,
      label: info.label,
      level: s?.level ?? "unknown",
      levelText: HEALTH_LEVEL_TEXT[s?.level ?? "unknown"],
      valueText: s ? valueText(s.value, info.unit) : "sem leitura",
      detail: s?.detail ? humanDetail(s.detail) : null,
      rule: info.rule,
    };
  });

  const off = settings.tickMinutes <= 0;
  if (!last) {
    return {
      state: off ? "off" : "empty",
      at: null,
      worst: null,
      headline: "Sem leitura ainda",
      note: off
        ? "O tick de saúde está desligado (health.tickMinutes: 0) e não há nenhuma leitura gravada."
        : `O tick mede a cada ${settings.tickMinutes} min; a primeira leitura aparece aqui assim que ele rodar.`,
      rows,
    };
  }

  const age = now - Date.parse(last.at);
  const worst = worstLevel(rows.map((r) => r.level));
  const count = (level: HealthLevel) => rows.filter((r) => r.level === level).length;
  const parts = [
    count("red") ? plural(count("red"), "vermelho", "vermelhos") : null,
    count("amber") ? `${count("amber")} em atenção` : null,
    `${count("ok")} ok`,
    count("unknown") ? plural(count("unknown"), "não medível", "não medíveis") : null,
  ].filter((p): p is string => p !== null);
  const headline = `${parts.join(" · ")} — lido ${ageWords(age)}`;

  const stale = off || age > STALE_AFTER_TICKS * settings.tickMinutes * 60_000;
  return {
    state: off ? "off" : stale ? "stale" : "fresh",
    at: last.at,
    worst,
    headline,
    note: off
      ? "O tick de saúde está desligado (health.tickMinutes: 0): esta é a última leitura gravada, não o estado de agora."
      : stale
        ? `A última leitura foi ${ageWords(age)} — o tick mede a cada ${settings.tickMinutes} min e não anda: confira se o serviço está medindo. Os números abaixo podem não ser os de agora.`
        : null,
    rows,
  };
}

/** O resumo curto da última leitura para a rota de versão: quando, o pior nível e quem está vermelho/em atenção. PURA. */
export function lastReadingSummary(record: HealthRecord | null): { at: string; worst: HealthLevel; red: HealthSignalId[]; amber: HealthSignalId[] } | null {
  if (!record) return null;
  const entries = Object.entries(record.signals) as Array<[HealthSignalId, { level: HealthLevel }]>;
  const ids = (level: HealthLevel) => entries.filter(([, s]) => s.level === level).map(([id]) => id);
  return { at: record.at, worst: worstLevel(entries.map(([, s]) => s.level)), red: ids("red"), amber: ids("amber") };
}
