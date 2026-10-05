// AS PALAVRAS DO RITMO DO BOARD (runner/board-pace.ts) — o que o botão do cabeçalho mostra. PURO.

import type { StoryType } from "./frameworks";
import { sinceWords, untilWords } from "./card-live-status";
import type { BoardPaceView, PaceActor, PaceChange, ScopePreset, ScopeRecord } from "./runner/board-pace";
import type { GovernorSnapshot } from "./runner/capacity-governor";
import { FIXES_ONLY_TYPES, paceLabel, SCOPE_TYPE_ORDER, SCOPE_TYPE_WORDS, scopePresetOf, scopeTypesPhrase } from "./runner/board-pace";

/** O selo do board só de organização (organize-only.ts) — a mesma frase no chip e no painel. */
export const ORGANIZE_ONLY_SEAL = "Só organização — nada roda sozinho";

// As palavras fixas dos tipos para o dono (a tabela mora em runner/board-pace.ts, que monta as frases do portão; aqui é a
// porta das telas e das tools): Funcionalidade nova (user), Erro (bug), Trabalho técnico (technical), Manutenção (chore),
// Investigação (spike).
export { SCOPE_TYPE_WORDS, SCOPE_TYPE_ORDER, scopeTypesPhrase };

/** Quem pôs o ritmo, para quem está olhando a tela (o dono): «por você» / «por um agente». PURA. */
export function paceWhoWords(by: PaceActor): string {
  return by.kind === "owner" ? "por você" : "por um agente";
}

/**
 * A linha de estado do ritmo: «Ritmo normal», «Pausado por você · há 12 min · volta às 18:00». Para o desarmado e para
 * o registro ilegível, a frase do portão (não há «quem» nem «desde»). PURA.
 */
export function paceStatusLine(
  view: Pick<BoardPaceView, "level" | "label" | "source" | "why" | "by" | "since" | "until"> & Partial<Pick<BoardPaceView, "scope">>,
  now: number,
  timeZone?: string,
): string {
  if (view.source === "organize-only") return `${ORGANIZE_ONLY_SEAL}: você e os agentes leem, escrevem e movem cards; nenhum passo automático dispara e nada chega sozinho.`;
  if (view.source === "disarmed") return "Este board está desligado: nenhum passo automático dispara.";
  if (view.source === "unreadable") return `Tudo parado: ${view.why}.`;
  // O escopo é outro eixo: vai depois do ritmo, na mesma linha («Ritmo normal · Só consertos e manutenção por você · …»). Com o
  // ritmo PAUSADO ele é irrelevante (nada começa, de qualquer tipo): a linha de estado só diz a pausa. A contagem de cards
  // esperando NÃO vai aqui — o painel a diz uma vez, em {@link scopeWaitingWords}.
  const scope = view.scope && view.level !== "paused" ? scopeStatusLine({ scope: view.scope }, now, timeZone) : null;
  if (view.level === "normal") return scope ? `Ritmo normal · ${scope}` : "Ritmo normal";
  const parts = [view.by ? `${view.label} ${paceWhoWords(view.by)}` : view.label];
  const since = view.since ? Date.parse(view.since) : NaN;
  if (Number.isFinite(since)) parts.push(sinceWords(since, now));
  const until = view.until ? Date.parse(view.until) : NaN;
  if (Number.isFinite(until) && until > now) parts.push(untilWords(until, now, timeZone));
  if (scope) parts.push(scope);
  return parts.join(" · ");
}

// ── o escopo de tipos ────────────────────────────────────────────────────────────────────────────────

/** Os dois botões que a tela oferece (a lista guardada já aceita qualquer combinação; a escolha livre vem depois). */
export const SCOPE_PRESETS: ReadonlyArray<{ id: Exclude<ScopePreset, "custom">; label: string; help: string; types: readonly StoryType[] | "all" }> = [
  { id: "all", label: "Tudo", help: "O board pode começar qualquer tipo de trabalho.", types: "all" },
  {
    id: "fixes",
    label: "Só consertos e manutenção",
    help: "Começa erro, trabalho técnico, manutenção e investigação. Não começa funcionalidade nova.",
    types: FIXES_ONLY_TYPES,
  },
];

/**
 * O texto do botão do cabeçalho: o ritmo e, quando o board limita o que começa, o escopo — «Normal · só consertos»,
 * «Devagar · só consertos». Desarmado e ilegível não levam escopo (seguram tudo antes de olhar tipo). PURA.
 */
export function paceChipValue(view: Pick<BoardPaceView, "level" | "source" | "scope">): string {
  if (view.source === "organize-only") return "Só organização";
  if (view.source === "disarmed") return "Desligado";
  const suffix = view.source === "unreadable" ? null : scopeChipSuffix(view);
  return suffix ? `${paceLabel(view.level)} · ${suffix}` : paceLabel(view.level);
}

/** A frase de cards que esperam por causa do escopo («3 cards de funcionalidade esperando»). Null quando nenhum espera. PURA. */
export function scopeWaitingWords(view: Pick<BoardPaceView, "scope" | "scopeWaiting">): string | null {
  const n = view.scopeWaiting;
  if (!view.scope || n <= 0) return null;
  // com o preset de consertos, o que espera é, por definição, funcionalidade nova; num recorte livre, só se diz «cards»
  const kind = scopePresetOf(view.scope.types) === "fixes" ? " de funcionalidade" : "";
  return `${n} ${n === 1 ? `card${kind} esperando` : `cards${kind} esperando`}`;
}

/** Uma frase que separa os dois eixos, para o painel não sugerir que o escopo poupa cota sozinho. */
export const SCOPE_AXIS_HELP = "O ritmo muda QUANTO o board anda; o escopo muda O QUE ele pode começar sozinho.";

/** O aviso de que limitar o que o board começa não é economizar: o gasto é do ritmo. */
export const SCOPE_QUOTA_HELP = "Limitar o escopo não gasta menos por si: o board anda na mesma velocidade, só com outro tipo de trabalho. Para poupar cota, use o ritmo.";

/** O que fica de pé quando o escopo limita: a captura, a triagem e a especificação seguem, e a entrega não é segurada. */
export const SCOPE_BOUNDS_HELP = "Só segura a construção: capturar, triar e especificar seguem, e o que já foi construído é publicado normalmente. O que já está rodando termina.";

/** O nome do escopo: «Tudo», «Só consertos e manutenção» ou «Só erro e manutenção». `null` = sem limite. PURA. */
export function scopeLabel(types: readonly StoryType[] | null): string {
  const preset = scopePresetOf(types);
  if (preset === "all") return "Tudo";
  if (preset === "fixes") return "Só consertos e manutenção";
  const words = SCOPE_TYPE_ORDER.filter((t) => (types ?? []).includes(t)).map((t) => SCOPE_TYPE_WORDS[t].toLowerCase());
  if (!words.length) return "Só nada";
  return `Só ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}`}`;
}

/** O complemento curto do botão do cabeçalho: «só consertos» / «só erro e manutenção». Null sem limite. PURA. */
export function scopeChipSuffix(view: Pick<BoardPaceView, "scope">): string | null {
  if (!view.scope) return null;
  return scopePresetOf(view.scope.types) === "fixes" ? "só consertos" : scopeLabel(view.scope.types).toLowerCase();
}

/**
 * A linha de estado do escopo: «Só consertos e manutenção por você · há 12 min · tudo volta às 18:00». Null sem limite. PURA.
 * Não carrega a contagem de cards esperando: ela é dita uma vez só, por {@link scopeWaitingWords}.
 */
export function scopeStatusLine(view: Pick<BoardPaceView, "scope">, now: number, timeZone?: string): string | null {
  const s = view.scope;
  if (!s) return null;
  const parts = [`${scopeLabel(s.types)} ${paceWhoWords(s.by)}`];
  const since = Date.parse(s.since);
  if (Number.isFinite(since)) parts.push(sinceWords(since, now));
  const until = s.until ? Date.parse(s.until) : NaN;
  if (Number.isFinite(until) && until > now) parts.push(`tudo ${untilWords(until, now, timeZone)}`);
  return parts.join(" · ");
}

/** Uma linha do histórico de escopo: «Só consertos e manutenção por um agente · há 2 h — motivo». PURA. */
export function scopeHistoryLine(r: ScopeRecord, now: number): string {
  const head = r.expired ? `${scopeLabel(r.types)} (o prazo venceu)` : `${scopeLabel(r.types)} ${paceWhoWords(r.by)}`;
  const at = Date.parse(r.at);
  return [Number.isFinite(at) ? `${head} · ${sinceWords(at, now)}` : head, r.reason].filter(Boolean).join(" — ");
}

/** O aviso de que o escopo não segura o que já foi construído. Null quando nada espera. PURA. */
export function featuresToShipWords(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 funcionalidade pronta na entrega vai junto na próxima publicação."
    : `${n} funcionalidades prontas na entrega vão junto na próxima publicação.`;
}

/** Uma linha do histórico: «Pausado por um agente · há 2 h — motivo». PURA. */
export function paceHistoryLine(c: PaceChange, now: number): string {
  const head = c.expired ? `${paceLabel(c.level)} (o prazo venceu)` : `${paceLabel(c.level)} ${paceWhoWords(c.by)}`;
  const at = Date.parse(c.at);
  return [Number.isFinite(at) ? `${head} · ${sinceWords(at, now)}` : head, c.reason].filter(Boolean).join(" — ");
}

/** Quantos minutos faltam até a próxima manhã (hora local de quem chama) — o prazo «até amanhã cedo». PURA. */
export function minutesUntilMorning(now: Date, hour = 8): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000));
}

/** Os prazos que o botão oferece para uma pausa. `minutes` null = sem prazo. */
export const PAUSE_DURATIONS: ReadonlyArray<{ id: "none" | "hour" | "morning"; label: string }> = [
  { id: "none", label: "Sem prazo" },
  { id: "hour", label: "1 hora" },
  { id: "morning", label: "Até amanhã cedo" },
];

export function pauseMinutes(id: "none" | "hour" | "morning", now: Date): number | undefined {
  if (id === "hour") return 60;
  if (id === "morning") return minutesUntilMorning(now);
  return undefined;
}

// ── a LEITURA do ritmo: o chip não mente enquanto lê ─────────────────────────────────────────────────────
//
// Antes da primeira leitura o chip caía em «Normal» (o nível padrão) enquanto o painel já dizia «Lendo o ritmo do board…» —
// e, segundos depois, virava «Devagar · só consertos». Mostrar o ritmo ERRADO como se fosse o certo engana justo quem olha
// o chip para decidir se gasta cota. Sem leitura o chip diz que está lendo (sem texto de NÍVEL e sem o ícone de «anda»);
// se a leitura falhar, diz «Ritmo indisponível» — nunca «Normal».

/** Em que pé está a leitura do ritmo: lendo pela primeira vez, falhou sem nada para mostrar, ou há ritmo. */
export type PaceReadState = "loading" | "unavailable" | "ready";

/** O texto do chip enquanto a primeira leitura não chega: sem nível. */
export const PACE_LOADING_VALUE = "Ritmo…";
/** O texto do chip quando a leitura falhou e não há nenhuma anterior para mostrar. */
export const PACE_UNAVAILABLE_VALUE = "Ritmo indisponível";
/** O painel enquanto lê. */
export const PACE_PANEL_LOADING = "Lendo o ritmo do board…";
/** O painel quando a leitura falhou (a próxima tentativa vem sozinha na próxima batida do relógio do chip). */
export const PACE_PANEL_UNAVAILABLE = "Ritmo indisponível: não consegui ler o ritmo do board agora. Tento de novo em instantes.";

/**
 * Em que pé está a leitura. Uma leitura BOA anterior vale mais que um erro novo (o ritmo muda por ação de gente, não a cada
 * segundo): se já há `view`, o estado é «ready» mesmo que a última tentativa tenha falhado. PURA.
 */
export function paceReadState(view: unknown, failed: boolean): PaceReadState {
  if (view) return "ready";
  return failed ? "unavailable" : "loading";
}

/** O que o chip do cabeçalho mostra: texto, dica e rótulo de acessibilidade — por estado de leitura. PURA. */
export function paceChipFace(view: BoardPaceView | null, failed: boolean, now: number, timeZone?: string): { state: PaceReadState; value: string; title: string; ariaLabel: string } {
  const state = paceReadState(view, failed);
  if (state === "ready" && view) {
    const value = paceChipValue(view);
    return { state, value, title: paceStatusLine(view, now, timeZone), ariaLabel: `Ritmo do board — ${value}` };
  }
  if (state === "unavailable") {
    return { state, value: PACE_UNAVAILABLE_VALUE, title: PACE_PANEL_UNAVAILABLE, ariaLabel: "Ritmo do board — indisponível" };
  }
  return { state: "loading", value: PACE_LOADING_VALUE, title: PACE_PANEL_LOADING, ariaLabel: "Ritmo do board — lendo" };
}

// ── a tela de COTA: «uso da semana» é uma coisa, «trava engatada» é outra ────────────────────────────────────
//
// O indicador da barra dizia «Cota 7d 4%» em vermelho, com cadeado, quando a TRAVA DE CAPACIDADE estava engatada: 4% é o
// USO, e o vermelho parecia cota crítica quando era a trava (um estado do governador, que pode ter sido posto por gente,
// por um agente ou por uma janela que já virou). O uso fica neutro (só a régua de uso o torna vermelho); a trava ganha
// selo e frase PRÓPRIOS. Só apresentação e texto: a lógica do governador não muda.

/** O texto curto do selo da trava, ao lado do medidor de uso. */
export const LATCH_SEAL_LABEL = "Trava";
/** A frase da trava, sempre a mesma: o que ela faz. */
export const LATCH_SEAL_HEADLINE = "Trava engatada: nada automático começa";

/** O medidor de uso da semana: valor, dica e rótulo — sem uma palavra sobre trava. PURA. */
export function quotaUsageWords(i: { pct: number | null; estimate: boolean; stale: boolean; ageWords?: string }): { value: string; title: string; ariaLabel: string } {
  const n = i.pct != null ? Math.round(i.pct) : null;
  const value = `Cota 7d ${n != null ? `${n}%${i.estimate ? "≈" : ""}` : "—"}`;
  const title = i.stale
    ? `Uso Claude — número defasado (proxy atualizou ${i.ageWords ?? "há tempos"})`
    : n != null
      ? `Uso Claude — ${n}% da semana${i.estimate ? " (estimativa local)" : ""}`
      : "Uso Claude — sessão · semana · Sonnet";
  return { value, title, ariaLabel: `Uso Claude${n != null ? ` — ${n}% da semana` : ""}` };
}

/**
 * O selo da TRAVA de capacidade, separado do uso. Null sem trava. `note` é a frase extra quando o USO já caiu abaixo dos
 * tetos de trava (7d e 5h): sem ela o operador vê «trava» com 4% de uso e acha que é defeito.
 *   · trava posta pela MEDIÇÃO e mole (`auto:week`/`auto:five-hour`) — solta sozinha quando a janela vira (latchAutoRelease):
 *     «o uso já baixou: a trava solta sozinha quando a janela virar ou a cota for zerada, ou pelo operador»;
 *   · qualquer outra (operador, agente, dura, uso extra pago, HALT) — a janela virar NÃO solta: a frase não promete isso.
 * `usageWeekPct` é o número que a tela já mostra (o do proxy); sem ele cai na leitura do governador. PURA.
 */
export function latchSealWords(
  g: Pick<GovernorSnapshot, "latch" | "reading" | "caps"> | null | undefined,
  usageWeekPct?: number | null,
): { label: string; headline: string; note: string | null; title: string; usageBelow: boolean } | null {
  const latch = g?.latch;
  if (!g || !latch) return null;
  const week = usageWeekPct ?? g.reading?.usage7dPct ?? null;
  const five = g.reading?.usage5hPct ?? null;
  const usageBelow =
    latch.source !== "halt" &&
    latch.trippedBy !== "auto:extra-usage" &&
    week != null &&
    week < g.caps.latchWeekPct &&
    (five == null || five < g.caps.latchFiveHourPct);
  const releasesWithWindow = latch.level === "soft" && /^auto:(week|five-hour)$/.test(latch.trippedBy);
  const note = !usageBelow
    ? null
    : releasesWithWindow
      ? "o uso já baixou: a trava solta sozinha quando a janela virar ou a cota for zerada, ou pelo operador"
      : "o uso já baixou, mas a trava segue: só o operador solta";
  return { label: LATCH_SEAL_LABEL, headline: LATCH_SEAL_HEADLINE, note, title: note ? `${LATCH_SEAL_HEADLINE} — ${note}` : LATCH_SEAL_HEADLINE, usageBelow };
}
