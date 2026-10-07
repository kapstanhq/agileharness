// AS PALAVRAS DO RITMO DO BOARD (runner/board-pace.ts) — o que a pílula de ritmo do Kanban e o seu painel mostram. PURO.

import type { StoryType } from "./frameworks";
import { sinceWords, untilWords } from "./card-live-status";
import type { BoardPaceView, PaceActor, ScopePreset } from "./runner/board-pace";
import type { GovernorSnapshot } from "./runner/capacity-governor";
import { FIXES_ONLY_TYPES, SCOPE_TYPE_ORDER, SCOPE_TYPE_WORDS, scopePresetOf, scopeTypesPhrase } from "./runner/board-pace";

/** O selo do board só de organização (organize-only.ts) — a mesma frase no chip e no painel. */
export const ORGANIZE_ONLY_SEAL = "Só organização — nada roda sozinho";

/**
 * O botão do OPERADOR que liga e desliga o modo (setOrganizeOnlyAction) e as confirmações, em palavras simples: o que
 * deixa de acontecer, e que o que estava rodando volta quando desligar.
 */
export const ORGANIZE_ONLY_TURN_ON = "Tornar só organização";
export const ORGANIZE_ONLY_TURN_OFF = "Voltar a trabalhar sozinho";
export const ORGANIZE_ONLY_CONFIRM_ON =
  "Tornar este board só de organização? Nada roda sozinho neste board: nem agentes de coluna, nem condutor, nem consertos automáticos, nem publicação. Você e os agentes continuam lendo, escrevendo e movendo cards. O que estiver rodando para e volta quando você desligar.";
export const ORGANIZE_ONLY_CONFIRM_OFF =
  "Voltar a trabalhar sozinho? Os passos automáticos deste board voltam a disparar agentes (o que gasta cota), e o trabalho que o modo tinha parado volta à fila.";
export const ORGANIZE_ONLY_TURN_ON_HELP = "Para um board que só serve para anotar e organizar: nada automático age nele.";

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
 * A frase do escopo depois da linha de estado do painel. PAUSADO, nada novo começa (de tipo nenhum): a frase diz isso
 * e que o escopo vale quando o board voltar — «Pausado… Só começa consertos» contradizia a pausa. PURA.
 */
export function scopeSentenceWords(preset: ScopePreset, paused: boolean): string {
  if (paused) {
    return preset === "fixes"
      ? "Nada novo começa enquanto estiver pausado; ao retomar, só começa consertos e manutenção."
      : "Nada novo começa enquanto estiver pausado.";
  }
  return preset === "fixes" ? "Só começa consertos e manutenção." : "Pode começar qualquer tipo de trabalho.";
}

/** A frase de cards que esperam por causa do escopo («3 cards de funcionalidade esperando»). Null quando nenhum espera. PURA. */
export function scopeWaitingWords(view: Pick<BoardPaceView, "scope" | "scopeWaiting">): string | null {
  const n = view.scopeWaiting;
  if (!view.scope || n <= 0) return null;
  // com o preset de consertos, o que espera é, por definição, funcionalidade nova; num recorte livre, só se diz «cards»
  const kind = scopePresetOf(view.scope.types) === "fixes" ? " de funcionalidade" : "";
  return `${n} ${n === 1 ? `card${kind} esperando` : `cards${kind} esperando`}`;
}

/** O nome do escopo: «Tudo», «Só consertos e manutenção» ou «Só erro e manutenção». `null` = sem limite. PURA. */
export function scopeLabel(types: readonly StoryType[] | null): string {
  const preset = scopePresetOf(types);
  if (preset === "all") return "Tudo";
  if (preset === "fixes") return "Só consertos e manutenção";
  const words = SCOPE_TYPE_ORDER.filter((t) => (types ?? []).includes(t)).map((t) => SCOPE_TYPE_WORDS[t].toLowerCase());
  if (!words.length) return "Só nada";
  return `Só ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}`}`;
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

/** O texto do chip enquanto a primeira leitura não chega: sem nível. Uma frase INTEIRA — «Ritmo…» lia como rótulo
 *  cortado (em 390px parecia a pílula truncada, não «lendo»). */
export const PACE_LOADING_VALUE = "Lendo o ritmo…";
/** O texto do chip quando a leitura falhou e não há nenhuma anterior para mostrar. */
export const PACE_UNAVAILABLE_VALUE = "Ritmo indisponível";
/** O painel enquanto lê. */
export const PACE_PANEL_LOADING = "Lendo o ritmo do board…";
/** O painel quando a leitura falhou (a próxima tentativa vem sozinha na próxima batida do relógio do chip). */
export const PACE_PANEL_UNAVAILABLE = "Ritmo indisponível: não consegui ler o ritmo do board agora. Tento de novo em instantes.";

/**
 * O rosto da pílula de ritmo do Kanban (fase 1): o que o board está FAZENDO — «Rodando», «Devagar», «Pausado» —, não a
 * posição do botão («Normal»). A mesma regra do chip: sem leitura, nenhum nível (lendo / indisponível). PURA.
 */
export function paceRunningFace(view: Pick<BoardPaceView, "level" | "source"> | null, failed: boolean): string {
  if (!view) return failed ? PACE_UNAVAILABLE_VALUE : PACE_LOADING_VALUE;
  if (view.source === "disarmed") return "Desligado";
  if (view.source === "organize-only") return "Só organização";
  if (view.source === "unreadable") return "Ritmo ilegível";
  if (view.level === "paused") return "Pausado";
  if (view.level === "slow") return "Devagar";
  return "Rodando";
}

/** A confirmação de LIGAR um board desligado — a pílula de ritmo e o `/retomar` do Jido dizem a MESMA frase. */
export const PACE_ARM_CONFIRM =
  "Este board está desligado. Ligar faz os passos automáticos dele dispararem agentes sozinhos, o que gasta cota. Ligar agora?";

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
      : "Uso Claude — sem dado da cota ainda";
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
