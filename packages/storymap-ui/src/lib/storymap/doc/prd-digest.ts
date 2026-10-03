// 🧭 O DIGEST do PRD — o norte do board em algumas linhas, para os prompts que não podem carregar o
// documento inteiro.
//
// Por que existe, em vez de simplesmente injetar o PRD: ele entra em TODO prompt de priorização, de
// captura e no cabeçalho de cada card. Um PRD bem escrito tem dezesseis seções e é longo de
// propósito — inliná-lo em cada turno pagaria o documento inteiro por uma decisão que só precisa do
// norte, e afogaria o que o prompt realmente pergunta. Quem precisa do resto chama `read_doc`; o
// ponteiro para o arquivo viaja no contexto de todo run.
//
// O CORTE (as cinco seções abaixo) é: o que orienta uma decisão e é barato de ler.
//   · `resumo`          — a orientação: o que é isto, para quem, por que agora;
//   · `posicionamento`  — a promessa contra a qual tudo se mede (era a escada inteira, antes);
//   · `resultadoAlvo`   — o vértice ao qual as stories sobem (leading);
//   · `metricaNegocio`  — o resultado do resultado (lagging);
//   · `escopo`          — o que está dentro e o que está fora. É a seção que mais corta ruído: uma
//                         demanda que cai em «Fora, por ora» não precisa ser pontuada, precisa ser
//                         recusada.
//
// O que ficou de FORA e por quê: problema, público, jornadas, requisitos, decisões, riscos. Todas
// importam — para ESCREVER o card, não para decidir a ordem dele. Elas são caras (listas longas) e
// o agente que precisa delas está numa tarefa em que ler o documento é o trabalho.
//
// PURO: sem `node:fs`, sem React. Recebe o `SchemaDoc` já carregado — quem chama `loadDoc` é a casca
// (server action, tool de MCP, engine), que já é assíncrona.

import type { DocBlock } from "./doc-model";
import { sectionContent, sectionItems, type SchemaDoc } from "./schema-codec";

/** As seções que moldam decisão e são baratas — o digest é exatamente isto, nesta ordem. */
export const PRD_DIGEST_SECTIONS = [
  { key: "resumo", label: "Resumo", as: "prose" },
  { key: "posicionamento", label: "Posicionamento", as: "prose" },
  { key: "resultadoAlvo", label: "Resultado-alvo", as: "items" },
  { key: "metricaNegocio", label: "Métrica de negócio", as: "items" },
  { key: "escopo", label: "Escopo", as: "grouped" },
] as const;

/**
 * O teto por seção. Não é economia de token: é a garantia de que um PRD que cresceu não empurre,
 * sozinho, o resto do prompt (âncoras, alvos, o que já foi entregue) para fora da janela. Quem
 * estoura o teto vê `…` e sabe que há mais — o documento inteiro está a um `read_doc` de distância.
 */
const MAX_CHARS_POR_SECAO = 700;

/** Os textos de uma seção de prosa, na ordem em que se leem. Heading não entra: é rótulo, não texto. */
function proseText(blocks: readonly DocBlock[]): string {
  return blocks
    .map((b) => ("text" in b && b.kind !== "heading" ? String(b.text ?? "") : ""))
    .map((t) => t.trim())
    .filter(Boolean)
    .join(" ");
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS_POR_SECAO) return text;
  // Corta na última fronteira de palavra antes do teto — cortar no meio de uma palavra faz o leitor
  // (humano ou modelo) gastar atenção decidindo se o texto está corrompido.
  const cut = text.slice(0, MAX_CHARS_POR_SECAO);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_CHARS_POR_SECAO * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Uma linha de seção, ou `null` quando ela está vazia (o digest não anuncia o que não foi escrito). */
function digestLine(doc: SchemaDoc, spec: (typeof PRD_DIGEST_SECTIONS)[number]): string | null {
  if (spec.as === "prose") {
    const text = proseText(sectionContent(doc, spec.key)?.blocks ?? []);
    return text ? `${spec.label}: ${truncate(text)}` : null;
  }

  const items = sectionItems(doc, spec.key).filter((i) => i.text.trim());
  if (!items.length) return null;

  if (spec.as === "items") return `${spec.label}: ${truncate(items.map((i) => i.text.trim()).join("; "))}`;

  // `grouped` — o grupo autoral é o dado, não decoração: em «Escopo», "Nesta versão" e "Fora, por
  // ora" são leituras OPOSTAS do mesmo item, e achatá-las diria a coisa errada.
  const grupos = new Map<string, string[]>();
  for (const item of items) {
    const g = item.group?.trim() || "—";
    grupos.set(g, [...(grupos.get(g) ?? []), item.text.trim()]);
  }
  return [...grupos.entries()]
    .map(([grupo, textos]) =>
      grupo === "—"
        ? `${spec.label}: ${truncate(textos.join("; "))}`
        : `${spec.label} — ${grupo}: ${truncate(textos.join("; "))}`,
    )
    .join("\n");
}

/**
 * O norte do board como bloco de texto. Vazio ⇒ o board não declarou norte nenhum, e quem depende
 * disto deve DIZER isso em vez de seguir: priorizar sem norte produz ruído confiante, que é pior
 * que não priorizar (a ordem sai com aparência de julgamento e sem julgamento nenhum dentro).
 */
export function prdDigest(doc: SchemaDoc | null | undefined): string {
  if (!doc) return "";
  return PRD_DIGEST_SECTIONS.map((spec) => digestLine(doc, spec))
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** O board declarou norte? (o gate de priorização, e o aviso que a tela mostra quando não.) */
export function hasPrdDigest(doc: SchemaDoc | null | undefined): boolean {
  return prdDigest(doc).length > 0;
}

/**
 * O norte, ou a frase que DIZ que não há norte.
 *
 * Existe porque um prompt não pode receber string vazia onde esperava contexto: o modelo preenche a
 * lacuna com plausibilidade e devolve um julgamento com aparência de fundamento. Dizer "ainda não
 * declarado" é a informação — e é ela que faz o agente pedir em vez de inventar.
 */
export function strategyOrAbsence(strategy: string): string {
  return strategy.trim() || "(estratégia ainda não declarada no board — o PRD ainda está vazio)";
}
