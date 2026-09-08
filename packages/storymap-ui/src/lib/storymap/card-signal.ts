// O SINAL de um card para o julgamento de prioridade. Puro, zero IO.
//
// O gargalo do sistema antigo não era o modelo, era a DIETA dele: os "irmãos" chegavam ao prompt como
// `título [tier atual: X]` (quatro linhas de código), e o card-foco como título + soThat + 5 critérios.
// Personas, entrevistas, severidade e qualquer noção de tamanho ficavam de fora — ou seja, pedia-se um
// julgamento de valor sem mostrar para QUEM, com que EVIDÊNCIA, e a que CUSTO.
//
// Aqui a regra é oposta e tem um limite: despejar o corpo do card estoura o orçamento e afoga o sinal.
// Então cada card vira um bloco COMPACTO (~70 tokens) em que toda linha é opcional e só aparece quando
// há substância. Card nu (o caso "PRD acabou de gerar 40 cards") produz duas linhas, roda igual, e sai
// com confiança BAIXA — declarada, não escondida.
//
// `basis[]` é a contrapartida honesta: registra QUE sinais existiam no momento do julgamento, e é o que
// a tela usa para não deixar o motor soar certo sobre um card vazio.

import type { BoardConfig, Card, Persona } from "./types";

/** Quais seções do corpo valem como evidência. Vem da spec (settings.yaml → prioritization.sections)
 *  para o pacote seguir agnóstico de aplicação; este é só o default conservador. */
export const DEFAULT_EVIDENCE_SECTIONS = ["Entrevistas", "Estado atual", "Reporte"] as const;

/**
 * Fatia uma seção do corpo pelo título do heading.
 *
 * TRÊS armadilhas reais, todas cobertas por teste:
 *  1. o heading carrega SUFIXO — o que existe no disco é `## Entrevistas (3 usuários)`, então casar
 *     `^## Entrevistas$` devolve zero;
 *  2. a seção contém sub-headings `###` — o terminador precisa de `[^#]` depois dos dois `#`, senão
 *     `#{1,2}` casa os dois primeiros de `###` e a fatia morre no primeiro sub-título;
 *  3. `$` NÃO serve de terminador aqui: com a flag `m` ele casa no fim de CADA linha, e o
 *     quantificador preguiçoso para na primeira quebra devolvendo uma linha só. O fim de entrada de
 *     verdade é `(?![\s\S])`.
 */
export function bodySection(body: string, name: string): string | null {
  if (!body) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s*${esc}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,2}[^#]|(?![\\s\\S]))`, "im");
  const m = body.match(re);
  const out = m?.[1]?.trim();
  return out ? out : null;
}

/** A parte mais densa de uma seção de entrevista: a Síntese, quando o autor a escreveu. */
function interviewGist(body: string): string | null {
  const sec = bodySection(body, "Entrevistas");
  if (!sec) return null;
  const synth = sec.match(/^###\s*S[íi]ntese[^\n]*\n([\s\S]*?)(?=\n#{1,3}[^#]|(?![\s\S]))/im)?.[1]?.trim();
  return squash(synth || sec, 260);
}

/** Uma linha só, sem markdown, truncada — o corpo do card é prosa longa e não cabe cru. */
function squash(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const flat = s
    .replace(/\*\*/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A persona em forma LEVE. O schema é bimodal na base real — o board `storymap` descreve personas por
 * `prompt` (um system prompt inteiro), os outros por `description`/`jobs`/`pains`/`gains`. Despejar a
 * forma integral custou 2.776 tokens contra 257 da leve, fator ~10×, sem ganho de julgamento. `role`
 * existe nos dois modos, então é ele que carrega a identidade; a primeira dor entra quando declarada.
 */
function personaLine(p: Persona): string {
  const role = squash(p.role, 90);
  const pain = squash(p.pains?.[0], 70);
  return [p.name, role && `— ${role}`, pain && `(dor: ${pain})`].filter(Boolean).join(" ");
}

export interface CardSignalCtx {
  config: BoardConfig;
  /** ids de cards que possuem plano técnico em disco — dica de TAMANHO, apurada por quem tem IO. */
  hasPlan?: Set<string>;
  /** título do nó do mapa em que o card mora — dá o "onde isto encaixa" sem custo. */
  anchorTitle?: string | null;
}

export interface CardSignal {
  text: string;
  /** que sinais REAIS entraram — vira `wsjf.basis` e, na tela, a confiança */
  basis: string[];
}

/**
 * O bloco compacto de UM card. Toda linha é condicional: o que não existe não vira ruído nem mentira.
 */
export function cardSignal(card: Card, ctx: CardSignalCtx): CardSignal {
  const basis: string[] = [];
  const lines: string[] = [];

  const head = [
    `[${card.id}]`,
    card.title,
    `· ${card.storyType ?? "user"}`,
    ctx.anchorTitle ? `· em: ${ctx.anchorTitle}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  lines.push(head);

  const soThat = squash(card.narrative?.soThat, 160);
  if (soThat) {
    lines.push(`  para: ${soThat}`);
    basis.push("soThat");
  }

  // Dois critérios + a contagem. Cinco inteiros (o que o prompt antigo mandava) custam mais e
  // informam menos: o 3º ao 5º repetem o mesmo eixo de valor.
  const acc = card.acceptance ?? [];
  if (acc.length) {
    const shown = acc.slice(0, 2).map((a) => squash(a, 120)).filter(Boolean);
    lines.push(`  aceite(${acc.length}): ${shown.join(" / ")}`);
    basis.push("aceite");
  }

  const personas = (card.personas ?? [])
    .map((id) => ctx.config.personas?.find((p) => p.id === id))
    .filter((p): p is Persona => !!p);
  if (personas.length) {
    lines.push(`  personas: ${personas.map(personaLine).join(" · ")}`);
    basis.push("personas");
  }

  // Severidade é o insumo de URGÊNCIA de um bug — sem ela, um blocker pontua baixo em valor (não
  // entrega nada novo) e baixo em destravamento, e some da fila. Cobertura real alta: 120 cards.
  const sev = card.severity ?? card.bugReport?.severity ?? null;
  if (sev) {
    const wa = card.hasWorkaround === true ? " · com contorno" : card.hasWorkaround === false ? " · sem contorno" : "";
    lines.push(`  severidade: ${sev}${wa}${card.frequency ? ` · frequência: ${card.frequency}` : ""}`);
    basis.push("severidade");
  }

  const gist = interviewGist(card.body ?? "");
  if (gist) {
    lines.push(`  entrevista: ${gist}`);
    basis.push("entrevista");
  }

  // TAMANHO entra como SINAL, nunca como número calculado: `tasks.length` e a existência de plano
  // técnico têm cobertura muito melhor que `rice.effort` (que no nimbus é ZERO), e o ordinal `size` é
  // um julgamento — não uma conta sobre um campo que quase ninguém preencheu.
  const effortBits = [
    card.tasks?.length ? `${card.tasks.length} tarefas` : null,
    ctx.hasPlan?.has(card.id) ? "plano técnico ✓" : null,
    card.systems?.length ? `toca ${card.systems.join(",")}` : null,
  ].filter(Boolean);
  if (effortBits.length) {
    lines.push(`  tamanho: ${effortBits.join(" · ")}`);
    basis.push("esforco");
  }

  return { text: lines.join("\n"), basis };
}
