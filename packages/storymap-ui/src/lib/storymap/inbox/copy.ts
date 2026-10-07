// O TEXTO do Inbox (onda 2 do redesenho) — as regras de escrita que valem para as quatro primeiras partes
// de todo item (a decisão, o que aconteceu, as opções com a consequência, e o «se você não fizer nada»). PURO e
// client-safe: o modelo do item (decision.ts) escreve com estas peças, e a tela só formata o que ele escreveu.
//
// Três regras moram aqui, cada uma com a sua trava:
//   1. O GLOSSÁRIO (ux-report §4.4): nenhum termo interno nas partes 1–4 — settle, gate, train/merge, staged, run,
//      finding, ids de ferramenta, classes de risco, códigos de saída, UUIDs e datas ISO só em «Detalhes». Um teste
//      varre toda decisão de todo kind contra {@link bannedTermsIn}.
//   2. O TEMPO nunca vai cru: o modelo roda no SERVIDOR (o fuso da VPS não é o do dono), então ele escreve um marcador
//      `{t:<ISO>}` / `{d:<ISO>}` e a tela o formata no fuso de quem lê ({@link formatDecisionText}).
//   3. O OBJETO vai entre aspas angulares e curto ({@link quoted}): «Catálogo: a busca por autor ignora acentos…».

import type { CockpitItemKind } from "../demands";

/** Um termo interno que não pode aparecer nas partes 1–4 de um item, e a palavra que o substitui. */
export interface BannedTerm {
  id: string;
  re: RegExp;
  use: string;
}

/**
 * O glossário do redesenho (ux-report §4.4 e a página aprovada pelo dono). A coluna `use` é a palavra certa — o teste
 * a mostra na mensagem de falha, para quem escreveu o texto saber o que pôr no lugar.
 */
export const BANNED_TERMS: readonly BannedTerm[] = [
  { id: "settle", re: /\bsettle\b/i, use: "confirmação da publicação" },
  { id: "gate", re: /\bgates?\b/i, use: "condição da etapa" },
  { id: "train", re: /\btrain\b/i, use: "integração" },
  { id: "merge", re: /\bmerge\b/i, use: "integração" },
  { id: "staged", re: /\bstag(ed|ing)\b/i, use: "homologado" },
  { id: "run", re: /\bruns?\b/i, use: "execução do agente" },
  { id: "finding", re: /\bfindings?\b/i, use: "aviso" },
  { id: "branch", re: /\bbranch\b/i, use: "o trabalho (na integração)" },
  { id: "deploy-verb", re: /\bdeploy(ed|s)?\b/i, use: "publicação" },
  { id: "exit-code", re: /\b(exit|saída)\s*\d+\b/i, use: "o motivo, em palavras" },
  { id: "exit-word", re: /\bexit\b/i, use: "o motivo, em palavras" },
  { id: "iso-date", re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, use: "há 3 h · 20:19 (formatado no fuso de quem lê)" },
  { id: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, use: "(em Detalhes)" },
  { id: "tool-id", re: /\b[a-z]+_[a-z_]+\b/, use: "a ação, dita em palavras" },
  { id: "skill-route", re: /\bharness-[a-z-]+/i, use: "o nome da etapa" },
  { id: "risk-class", re: /\b(write-board|merge-resolve|run-free|destructive)\b/, use: "(em Detalhes)" },
  { id: "time-token", re: /\{[td]:[^}]*\}/, use: "(o marcador de tempo tem de ser formatado)" },
  // Já se achou no Inbox vivo o hash do commit, «CLS», «worktree» e «tmux» na frase que o dono lê.
  { id: "sha", re: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i, use: "(o código, em Detalhes)" },
  { id: "commit", re: /\bcommits?\b/i, use: "a mudança no código" },
  { id: "worktree", re: /\bworktrees?\b/i, use: "a cópia de trabalho" },
  { id: "tmux", re: /\btmux\b/i, use: "a sessão do agente" },
  { id: "cls", re: /\bCLS\b/, use: "a causa, em palavras" },
  // o glossário único (WP3): o dono lê «passo», nunca «etapa». («condutor» → «agente» vale para o texto do item —
  // INBOX_ITEM_TERMS —, mas não aqui: a linha de presença do card ainda distingue o condutor do agente sem cabeça.)
  { id: "etapa", re: /\betapas?\b/i, use: "passo" },
  // o nome técnico de uma parte publicada («face:loja», «functions:loja») chegou à frase do dono em 07/10
  { id: "unit-id", re: /\b[a-z][a-z0-9-]*:[a-z][\w-]*/, use: "a parte do produto, em palavras (o nome técnico em Detalhes)" },
  { id: "fail-closed", re: /\bfail-(closed|open)\b/i, use: "na dúvida, segura (em palavras)" },
];

/**
 * Termos que só o TEXTO DE UM ITEM do Inbox não usa (as partes 1–4), além do glossário comum. Vazio desde a fase 3: o
 * dono nomeou o condutor no próprio Inbox («o condutor encerrou e ninguém assumiu» → «Parar condutor», decisão de
 * 06/10) — a palavra deixou de ser jargão para ele. A lista fica para o próximo termo só do item.
 */
export const INBOX_ITEM_TERMS: readonly BannedTerm[] = [];

/** Os termos que o texto de um ITEM contém — o glossário comum mais o do item (vazio = limpo). PURA. */
export function itemTermsIn(text: string): BannedTerm[] {
  return [...BANNED_TERMS, ...INBOX_ITEM_TERMS].filter((t) => t.re.test(text));
}

/**
 * O teto de uma pergunta (a parte 1): uma linha que o dono lê no celular. O texto cru do agente (a pergunta inteira, o
 * título longo) vai para Detalhes — o modelo do item o põe lá quando corta.
 */
export const ASK_MAX = 140;

const TOKEN_LEN_RE = /\{[td]:[^}]*\}/g;

/**
 * A pergunta cortada no teto, contando cada marcador de tempo pelo que a tela mostra («hoje às 20:19»), nunca no meio
 * de um marcador (um `{t:…` cortado chegaria cru à tela). Já cabe ⇒ a mesma string. PURA.
 */
export function clampAsk(ask: string, max = ASK_MAX): string {
  const shown = ask.replace(TOKEN_LEN_RE, "hoje às 20:19");
  if (shown.length <= max) return ask;
  const cut = clip(ask.replace(TOKEN_LEN_RE, ""), max);
  return cut.replace(/\{[td]:[^}]*$/, "").trimEnd();
}

/**
 * O SUBSTANTIVO curto de cada kind — «Precisa de você: <o quê>» na pílula do card e no push (≤ 24 caracteres). Nunca o
 * rótulo de uma opção («Pedir ao Jido…»): o quê espera o dono, não o botão. EXAUSTIVO (o Record obriga).
 */
export const INBOX_KIND_NOUN: Readonly<Record<CockpitItemKind, string>> = {
  question: "Pergunta",
  blocker: "Problema da revisão",
  finding: "Aviso da revisão",
  "deploy-failed": "Publicação parada",
  gate: "Aprovação",
  approval: "Pedido de agente",
  review: "Triagem",
  stuck: "Agente parado",
  conflict: "Integração parada",
  proposal: "Proposta de cards",
  design: "Design para aprovar",
  governance: "Mudança no PRD",
  "deploy-unsettled": "Publicação sem prova",
  "release-aging": "Publicação atrasada",
  "merge-failed": "Integração falhou",
  "proxy-audit": "Resposta do procurador",
  "delivery-audit": "Entrega para revisar",
  "meter-stalled": "Medidor de uso parado",
  "data-deletion": "Apagar dados",
  "effect-failed": "Ação que não rodou",
  stalled: "Card parado",
  "locked-exec": "Comando para aprovar",
  "publish-approval": "Autorizar publicação",
  "publish-held": "Publicação segurada",
  "stage-idle": "Entregas esperando",
  "capacity-latch": "Cota no limite",
  "host-health": "Saúde da ferramenta",
  sentinel: "Diagnóstico da Sentinela",
  "push-off": "Aviso no celular",
};

/** Os termos do glossário que `text` contém (vazio = limpo). PURA. */
export function bannedTermsIn(text: string): BannedTerm[] {
  return BANNED_TERMS.filter((t) => t.re.test(text));
}

/** O objeto de uma frase, entre aspas angulares, cortado em `max` caracteres. PURA. */
export function quoted(title: string | null | undefined, max = 60): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim() || "este card";
  return `«${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}»`;
}

/** Corta uma frase livre (texto de agente) em `max` caracteres, sem quebrar no meio de uma palavra. PURA. */
export function clip(text: string | null | undefined, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** «2 cards», «1 card». PURA. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── O tempo, formatado por quem lê ─────────────────────────────────────────────────────────────────────

/** Um instante, para a tela formatar como data e hora («07/10 às 14:32», «hoje às 20:19»). */
export function timeToken(iso: string): string {
  return `{t:${iso}}`;
}

/** Um instante, para a tela formatar só como dia («07/10»). */
export function dayToken(iso: string): string {
  return `{d:${iso}}`;
}

/** Como a tela formata os marcadores de tempo — no fuso dela. */
export interface TimeFormatter {
  /** data e hora: «hoje às 20:19», «ontem às 09:12», «07/10 às 14:32». */
  at(ms: number): string;
  /** só o dia: «07/10». */
  day(ms: number): string;
}

const TOKEN_RE = /\{([td]):([^}]*)\}/g;

/** Troca os marcadores `{t:…}`/`{d:…}` pelo tempo formatado. Um marcador ilegível vira «em data desconhecida». PURA. */
export function formatDecisionText(text: string, fmt: TimeFormatter): string {
  return text.replace(TOKEN_RE, (_m, kind: string, iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "em data desconhecida";
    return kind === "d" ? fmt.day(ms) : fmt.at(ms);
  });
}

/**
 * O formatador de datas no fuso do DONO (`timeZone` — owner-timezone.ts; a tela o recebe do layout por
 * components/OwnerTimeZone.tsx). Sem ele vale o fuso do processo — só para um teste isolado. `now` decide
 * «hoje»/«ontem»; `now` 0 (o primeiro render, antes do relógio da tela) escreve o dia em vez de «hoje»: o texto do
 * SSR e o da hidratação não dependem do relógio de nenhum dos dois.
 */
export function localTimeFormatter(now: number, timeZone?: string): TimeFormatter {
  const dayKey = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const clock = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" });
  const day = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "2-digit" });
  const today = now ? dayKey(now) : null;
  const yesterday = now ? dayKey(now - 86_400_000) : null;
  const tomorrow = now ? dayKey(now + 86_400_000) : null;
  return {
    at: (ms) => {
      const k = dayKey(ms);
      const prefix = k === today ? "hoje" : k === yesterday ? "ontem" : k === tomorrow ? "amanhã" : day(ms);
      return `${prefix} às ${clock(ms)}`;
    },
    day,
  };
}

/** «12 min», «3 h», «4 dias» — a idade de algo, em palavras. PURA. */
export function ageWords(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "agora";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return plural(d, "dia", "dias");
}

/**
 * «há 12 min · 20:19» — a idade relativa MAIS o relógio do dono (`timeZone`; ele lê as duas coisas de uma vez: quanto
 * tempo e a que horas). Mais de um dia: «há 4 dias · 24/09». null sem data legível. PURA.
 */
export function relativeWithClock(iso: string | null | undefined, now: number, timeZone?: string): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const age = now - ms;
  // uma DATA pura (YYYY-MM-DD — a proposta de PRD nasce assim) é um dia do calendário, não um instante: convertê-la
  // para o fuso do dono a jogaria para a véspera (meia-noite UTC é 21h do dia anterior em São Paulo), e contar horas
  // desde a meia-noite dizia «há 8 h» de uma proposta de minutos atrás. A idade dela é em DIAS do calendário do dono.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (dateOnly) {
    const today = new Date(now).toLocaleDateString("en-CA", { timeZone }); // YYYY-MM-DD no fuso de quem lê
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - ms) / 86_400_000);
    const rel = days <= 0 ? "hoje" : days === 1 ? "ontem" : `há ${plural(days, "dia", "dias")}`;
    return `${rel} · ${dateOnly[3]}/${dateOnly[2]}`;
  }
  const words = ageWords(age);
  const rel = words === "agora" ? "agora" : `há ${words}`;
  const clock =
    age < 86_400_000
      ? new Date(ms).toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" })
      : new Date(ms).toLocaleDateString("pt-BR", { timeZone, day: "2-digit", month: "2-digit" });
  return `${rel} · ${clock}`;
}

// ── Parado há muito tempo ──────────────────────────────────────────────────────────────────────────────

/** A partir de quantos dias um item é «parado» (a decisão 3 do dono: 30 dias). */
export const STALE_DAYS = 30;

/** Há quantos dias inteiros o item espera, quando passou do limite — ou null. PURA. */
export function staleDays(since: string | null | undefined, now: number, limit = STALE_DAYS): number | null {
  const ms = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(ms)) return null;
  const days = Math.floor((now - ms) / 86_400_000);
  return days >= limit ? days : null;
}

/** «parado há N dias». PURA. */
export function staleLabel(days: number): string {
  return `parado há ${plural(days, "dia", "dias")}`;
}

/** O motivo PADRÃO de reabrir uma entrega pelo «Desfazer» — o clique roda já (um clique em todo lugar); quem quiser outro motivo o escreve no card. */
export const REOPEN_DEFAULT_NOTE = "O dono reabriu esta entrega pelo Inbox.";

// ── O formato de uma pergunta de agente (ask_question) ───────────────────────────────────────────────────

/**
 * Os tetos de uma pergunta que um agente faz ao dono (fase 3: mensagens dos agentes em linguagem simples). O Inbox mostra
 * `context` como «O que aconteceu», `text` como «O que eu preciso de você» e cada opção como um botão de um clique — então
 * cada parte tem de caber no papel dela. Generosos de propósito: o teto pega o parágrafo colado, não a frase longa.
 */
export const ASK_FORMAT = {
  textMax: 240,
  contextMax: 400,
  optionsMin: 2,
  optionsMax: 4,
  // = o botão do Inbox (decision.ts `OPTION_LABEL_MAX`): um rótulo aceito aqui nunca chega cortado no botão
  optionLabelMax: 60,
  recommendationMax: 240,
  freeTextMax: 300,
} as const;

/** Uma pergunta como o agente a manda (o recorte de `ask_question` que o formato julga). */
export interface AskShape {
  text: string;
  context?: string;
  options?: ReadonlyArray<{ label: string }>;
  recommendation?: string;
}

/**
 * O que está FORA do formato numa chamada de `ask_question` — vazio = aceita. Cada linha diz o que corrigir, em
 * português, para o agente refazer a chamada. PURA.
 */
export function askFormatProblems(input: { texts?: readonly string[]; questions?: readonly AskShape[] }): string[] {
  const out: string[] = [];
  const F = ASK_FORMAT;
  if (!input.texts?.length && !input.questions?.length) out.push("mande ao menos uma pergunta (`texts` ou `questions`).");
  (input.texts ?? []).forEach((t, i) => {
    if (!t.trim()) out.push(`texts[${i}] está vazio: escreva a pergunta.`);
    else if (t.trim().length > F.freeTextMax) out.push(`texts[${i}] tem ${t.trim().length} caracteres (máximo ${F.freeTextMax}): uma pergunta, não um relatório.`);
  });
  (input.questions ?? []).forEach((q, i) => {
    const at = `questions[${i}]`;
    const text = q.text?.trim() ?? "";
    if (!text) out.push(`${at}.text está vazio: escreva o que você precisa da pessoa, numa pergunta.`);
    else if (text.length > F.textMax) out.push(`${at}.text tem ${text.length} caracteres (máximo ${F.textMax}): uma pergunta só; o porquê vai em context.`);
    if (q.context && q.context.trim().length > F.contextMax) out.push(`${at}.context tem ${q.context.trim().length} caracteres (máximo ${F.contextMax}): o que aconteceu, em 1–2 frases.`);
    const opts = q.options ?? [];
    if (opts.length && (opts.length < F.optionsMin || opts.length > F.optionsMax)) out.push(`${at}.options tem ${opts.length} (use de ${F.optionsMin} a ${F.optionsMax}, cada uma uma ação curta).`);
    opts.forEach((o, j) => {
      const label = o.label?.trim() ?? "";
      if (!label) out.push(`${at}.options[${j}].label está vazio.`);
      else if (label.length > F.optionLabelMax) out.push(`${at}.options[${j}].label tem ${label.length} caracteres (máximo ${F.optionLabelMax}): vira um botão — uma ação curta; o detalhe vai em pros/cons.`);
    });
    if (q.recommendation && q.recommendation.trim().length > F.recommendationMax) out.push(`${at}.recommendation tem ${q.recommendation.trim().length} caracteres (máximo ${F.recommendationMax}).`);
  });
  return out;
}
