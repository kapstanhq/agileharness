// Quando o painel ADOTA o histórico durável do servidor (o poll near-live do B-lite). PURO/testado.
//
// O B-lite nasceu com o gate errado: "adota quando o servidor CRESCE", medido em NÚMERO DE TURNOS
// (`turns.length > lastSyncedLen`). O problema é que essa não é a unidade em que o trabalho do tick cresce.
// O `parseTranscriptTurns` agrupa TODA a atividade do agente entre dois turnos de user num ÚNICO turno de
// agente — então, enquanto o tick trabalha, o número de turnos fica CONGELADO e só os SEGMENTOS de dentro
// daquele turno crescem. Medido no transcript vivo do acme, num tick real:
//
//     turns=15  segs= 9   18:04:39
//     turns=15  segs=10   18:04:40
//     turns=15  segs=12   18:04:40
//     turns=15  segs=13   18:05:07     ← 30s de trabalho, `turns.length` não mudou UMA vez
//
// Com o gate de length, `15 > 15` é falso a cada poll ⇒ nenhum setState ⇒ o thread fica CONGELADO durante o
// ciclo inteiro. O operador via o resultado só depois (pelo diário, que tem poll próprio) — exatamente o
// sintoma relatado. Não era falta de streaming: o CLI escreve o transcript INCREMENTALMENTE (medido: 30→82
// linhas em 70s de run) e o tick JÁ escreve na sessão durável (WS2A) — o dado estava no disco, ao vivo, e o
// cliente é que se recusava a olhar.
//
// A unidade certa é CONTEÚDO, não contagem. `historySignature` resume o que o operador veria; mudou a
// assinatura, adota.

import type { HitlTurn } from "@/lib/storymap/hitl/types";

/**
 * Assinatura barata e ESTÁVEL do que o servidor tem. Captura o que muda quando o agente trabalha DENTRO de um
 * turno (nº de segmentos, tamanho do texto que streama, status/tamanho da saída de cada tool) — não só o nº de
 * turnos. Determinística: mesma entrada ⇒ mesma saída (nunca use aqui algo que varie sozinho, como Date.now,
 * ou o poll adotaria a cada 2s e o thread piscaria).
 */
export function historySignature(turns: readonly HitlTurn[]): string {
  const parts: string[] = [String(turns.length)];
  for (const t of turns) {
    if (t.role === "human") {
      parts.push(`h${t.text.length}`);
    } else if (t.role === "notice") {
      parts.push(`n${t.text.length}`);
    } else if (t.segments) {
      // o turno do agente é onde o trabalho do tick cresce ao vivo: 1 marca por segmento.
      let s = `a${t.segments.length}:`;
      for (const seg of t.segments) {
        s += seg.type === "text" ? `t${seg.text.length},` : `x${seg.status}${(seg.output ?? "").length},`;
      }
      parts.push(s);
    } else {
      parts.push(`m${t.message.length}`); // turno legado (popovers HITL): só a mensagem
    }
  }
  return parts.join("|");
}

/**
 * O painel deve ADOTAR o que o servidor devolveu? Puro — o hook só executa a decisão.
 *
 * Quatro guardas, cada uma pagando um erro real:
 *  1. `!turns.length` ⇒ NÃO. Servidor sem transcript (conversa nova, ponteiro ausente, fetch degradado) não
 *     pode apagar a pintura local — foi por isso que o gate original exigia crescimento.
 *  2. sessão DESCARTADA ⇒ NÃO. O operador acabou de clicar "Nova conversa": nunca re-adotar o transcript da
 *     sessão que ele jogou fora, mesmo que a deleção do ponteiro no servidor tenha perdido a corrida com o poll
 *     (a action é best-effort/assíncrona) ou que um tick a tenha re-apontado por um instante. Assim que uma
 *     sessão GENUINAMENTE nova é observada, o chamador solta o guard (clearedSessionId volta a null) e o
 *     trabalho novo volta a fluir. Sem isto o histórico limpo reaparecia sozinho em segundos (bug real).
 *  3. assinatura IGUAL ⇒ NÃO. Sem mudança não há setState; é o que preserva os ecos locais (greeting,
 *     respostas de pergunta, aprovações) que só existem no cliente.
 *  4. `turns.length < syncedLen` ⇒ NÃO. O servidor ENCOLHEU em relação ao que já sincronizamos: quem tem
 *     turnos a mais aqui é o operador (ecos locais), e adotar os apagaria. `>=` (e não `>`) é a diferença que
 *     conserta o congelamento: o mesmo NÚMERO de turnos com conteúdo NOVO é exatamente o tick trabalhando.
 */
/**
 * O poll near-live deve RODAR neste estado do chat?
 *
 * Só NÃO roda enquanto o operador tem o PRÓPRIO turno streamando: ali a verdade é o SSE, e adotar o transcript
 * no meio clobbaria o turno em voo.
 *
 * O gate ERRADO — e o segundo defeito do incidente de 2026-07-25 — era `status === "idle"`. Um 409 ("já há um
 * copiloto trabalhando neste board") deixava o hook em `status: "error"`, e NADA o tirava de lá sem uma nova
 * interação do operador: o poll morria e o painel CONGELAVA — o trabalho do ciclo autônomo parava de chegar, a
 * conversa não crescia mais, e só um F5 ressuscitava (foi exatamente o que o operador relatou). "Não estou
 * streamando" é a condição real; "estou ocioso" era uma aproximação que confundia ERRO com OCUPADO — e um chat
 * que erra é justamente quando o operador MAIS precisa ver o que está acontecendo do outro lado.
 */
export function shouldPollHistory(status: "idle" | "typing" | "error"): boolean {
  return status !== "typing";
}

export function shouldAdoptHistory(
  turns: readonly HitlTurn[],
  syncedLen: number,
  syncedSig: string | null,
  opts?: { serverSessionId?: string | null; clearedSessionId?: string | null },
): boolean {
  if (!turns.length) return false;
  if (opts?.clearedSessionId && opts.serverSessionId && opts.serverSessionId === opts.clearedSessionId) return false;
  if (turns.length < syncedLen) return false;
  return historySignature(turns) !== syncedSig;
}
