// As ENTRADAS do digest do PRD (prd-digest.ts), para quem o desenha linha a linha (o bloco de contexto do card).
//
// O digest é «uma linha por seção», mas o TEXTO de uma seção de prosa pode trazer quebras de linha próprias (um
// parágrafo escrito com quebras suaves). Cortar o digest em todo `\n` partia uma frase em vários parágrafos curtos —
// e partia também o par de um `**negrito**` ou de um `código`, que então vazava como marcador ou como negrito
// até o fim do pedaço seguinte. Aqui uma entrada começa SÓ onde começa um rótulo de seção do digest; qualquer
// outra linha continua a entrada anterior (com um espaço, a mesma junção que o digest faz entre blocos). PURA.

import { PRD_DIGEST_SECTIONS } from "./prd-digest";

const LABELS = PRD_DIGEST_SECTIONS.map((s) => s.label);

/** A linha abre uma entrada do digest? (`Rótulo: …` ou `Rótulo — grupo: …`) */
function opensEntry(line: string): boolean {
  return LABELS.some((label) => line.startsWith(`${label}:`) || line.startsWith(`${label} — `));
}

/** O digest em entradas, uma por seção (ou grupo), com as quebras internas de cada uma desfeitas. PURA. */
export function digestEntries(strategy: string): string[] {
  const out: string[] = [];
  for (const raw of strategy.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (out.length === 0 || opensEntry(line)) out.push(line);
    else out[out.length - 1] = `${out[out.length - 1]} ${line}`;
  }
  return out;
}
