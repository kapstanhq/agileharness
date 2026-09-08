// The WORDS and the pure text rules of a terminal row, split out of `parts.tsx` so they are testable:
// this package's vitest cannot transform `.tsx`, so anything living in a component file is untestable by
// construction. Rendering stays in parts.tsx; the decisions live here.

import type { ServiceMeter } from "@/lib/vps/service-meters";

type StateLike = Pick<ServiceMeter, "state" | "source">;

/**
 * Is this row's state a CALL TO ACTION? An agent that reported itself idle is blocked on the operator —
 * there is a turn to take. A shell that merely sits open is not, and a working session least of all.
 *
 * This is what the chip's prominence is spent on. An earlier draft gave every live row an equally loud
 * word, so "trabalhando" repeated down the column saying nothing that distinguished one row from another,
 * while the ONE row that actually wanted the operator looked the same as its neighbours.
 *
 * `source === "cli"` faz o trabalho pesado aqui, e ganhou um segundo sentido: um flag que a tela
 * DESMENTIU chega como `stale` e sai da chamada à ação sozinho. É o que evita o âmbar que o operador
 * viu — uma sessão dormindo havia 20 horas usando o mesmo selo de "aguardando você" de uma que acabou
 * de te perguntar algo, que é a crítica de abertura do lib/terminal/attention.ts em forma de chip.
 */
export function needsYou(meter: StateLike): boolean {
  return meter.state === "waiting" && meter.source === "cli";
}

/**
 * Esta linha pode oferecer o ENCERRAR?
 *
 * Só a DORMENTE — a que tem um agente dentro cuja tela está congelada há muito tempo (`stale`). É a
 * única cujo encerramento é uma decisão de arrumação e não uma interrupção: quem trabalha não ganha um
 * botão de matar ao lado do nome, e quem acabou de te perguntar algo (`waiting` · `cli`) também não —
 * ali o gesto certo é responder, não encerrar.
 *
 * Isto é uma OFERTA, nunca uma permissão: o veredito é do servidor (`assessKillLive`, fail-closed, na
 * rota DELETE), e ele recusa com o motivo — que a linha mostra em vez de fingir que não pediu.
 */
export function canOfferKill(meter: StateLike): boolean {
  return meter.source === "stale";
}

/** Leitura de contexto mais velha que isto é marcada como velha (o medidor roda a cada 15s). */
export const CONTEXT_STALE_MS = 2 * 60_000;

type ContextLike = Pick<ServiceMeter, "contextPct" | "contextAbsent" | "contextAgeMs">;

/**
 * O que ESCREVER na coluna de contexto — e por quê, no title.
 *
 * Existe porque "—" estava dizendo duas coisas opostas com o mesmo símbolo: "esta sessão é nova (ou
 * você acabou de limpá-la) e ainda não teve um turno para medir" — normal, esperado, temporário — e
 * "eu não consegui ler" — defeito. Com um símbolo só, dar `/clear` num terminal parecia o medidor
 * quebrando, que foi exatamente o relato do operador.
 *
 * A segunda distinção é a IDADE: a leitura vem de um poll de 15s, então logo depois de um `/clear` o
 * número ANTERIOR ainda está na tela por alguns segundos. Ele continua sendo a melhor informação que
 * existe — apagá-lo seria pior —, mas não pode se passar por atual: acima de 2 min ele ganha `~` e
 * recuo. `stale` é devolvido para quem renderiza decidir a cor.
 */
export function contextReading(meter: ContextLike): { text: string; title: string; stale: boolean } {
  if (meter.contextPct != null) {
    const stale = meter.contextAgeMs != null && meter.contextAgeMs >= CONTEXT_STALE_MS;
    const pct = Math.round(meter.contextPct);
    return {
      text: `${stale ? "~" : ""}${pct}%`,
      title: stale
        ? `${pct}% da janela de contexto — leitura de mais de 2 min atrás, pode não refletir a sessão de agora.`
        : `${pct}% da janela de contexto em uso.`,
      stale,
    };
  }
  switch (meter.contextAbsent) {
    case "no-usage":
      return {
        text: "novo",
        title:
          "Sessão nova (ou recém-limpa com /clear): já existe transcript, mas ainda não houve um turno " +
          "do modelo para medir. O número aparece no primeiro turno.",
        stale: false,
      };
    case "unreadable":
      return { text: "—", title: "O transcript desta sessão não pôde ser lido.", stale: false };
    case "unmapped":
      return {
        text: "—",
        title: "Há um Claude aqui, mas não consegui identificar a sessão dele — sem sessão não há leitura honesta.",
        stale: false,
      };
    case "no-claude":
      return { text: "—", title: "Este terminal não tem um agente dentro — não há contexto a medir.", stale: false };
    default:
      return { text: "—", title: "Ainda não li o contexto desta sessão.", stale: false };
  }
}

export function stateLabel(meter: StateLike, compact = false): string {
  switch (meter.state) {
    case "working":
      return "trabalhando";
    case "waiting":
      // The long form only fits where there is room for it; a collapsed row drops the "você" rather
      // than truncating the word that carries the meaning.
      return needsYou(meter) ? (compact ? "aguardando" : "aguardando você") : "ocioso";
    case "failed":
      return "falhou";
    case "done":
      return "concluído";
  }
}

/** Where the claim comes from — said out loud in the tooltip instead of asserted by a colour. */
export function stateHint(meter: StateLike): string {
  switch (meter.source) {
    case "cli":
      return "o próprio Claude reportou este estado";
    case "run":
      return "processo headless em execução — um turno em andamento";
    case "stale":
      // Dizer a EVIDÊNCIA, não o veredito: quem lê isto precisa saber que houve um estado reportado e
      // que ele venceu, senão a linha se parece com um medidor quebrado.
      return "a tela deste terminal está parada — o último estado que o Claude reportou não vale mais";
    case "status":
      return meter.state === "failed" || meter.state === "done"
        ? "desfecho registrado pelo runner"
        : "só sabemos que o processo existe (sem agente para perguntar)";
  }
}

/**
 * Strip the decorative marker an activity line arrives with. The `❯` glyph already marks where the line
 * starts, so a second marker right after it reads as debris in the message.
 *
 * Two sources, both observed on the live box: the `✳ ` the CLI prefixes a status line with, and a lone
 * BRAILLE character — `⠐ Redesign terminal block…` — which is one frozen frame of the CLI's spinner. The
 * braille block (U+2800–U+28FF) is what every terminal spinner animates through, and none of it is ever
 * message content, so the whole range goes.
 *
 * Conservative otherwise: only a LEADING run of known marker characters is removed, never real content —
 * a path, a flag and a shell `$` all begin with punctuation that IS the message.
 */
export function stripLineMarker(text: string): string {
  return text.replace(/^[\s*·•▪◦✳✶✻✽⠀-⣿]+/u, "") || text;
}

/**
 * The width of the prompt glyph's column (`❯` + its gap). Anything that sits UNDER the message — the meter
 * row — indents by exactly this, so the block has ONE left edge for text instead of two a few pixels
 * apart, which reads as a misalignment rather than as a hanging indent.
 */
export const PROMPT_INDENT = "pl-[13px]";
