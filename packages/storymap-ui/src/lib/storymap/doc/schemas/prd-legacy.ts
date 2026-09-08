// 📋 A ponte da ESCADA ESTRATÉGICA antiga (as três strings do `board.yaml`) para o PRD em markdown.
//
// MIGRAÇÃO PREGUIÇOSA, não script — o mesmo idioma do `lean-canvas-legacy`, pelos mesmos três
// motivos: zero janela (nada precisa rodar antes de a tela funcionar), nada é sobrescrito (a
// projeção é read-only até alguém gravar) e o corte da prosa em ITENS é revisado por um humano na
// tela, que é onde a decisão pertence.
//
// O mapa, e ele é o refactor inteiro em três linhas:
//   `positioning`    → seção `posicionamento`   (prosa; era uma frase, continua uma frase)
//   `businessMetric` → seção `metricaNegocio`   (itens; a prosa achatada é cortada)
//   `desiredOutcome` → seção `resultadoAlvo`    (itens; idem)
//
// As outras dezesseis seções do PRD nascem VAZIAS, e isso é o ponto: elas são exatamente o que a
// escada não dizia. Um board migrado abre com o que sempre teve e com o esqueleto do que faltava.
//
// Os três campos do `board.yaml` NÃO são apagados por este arquivo nem por ninguém nesta onda. Eles
// continuam sendo a fonte enquanto o `.md` não existir, continuam protegidos de escrita direta por
// agente (`HUMAN_BOARD_FIELDS`) e continuam sobrevivendo ao round-trip de leitura/escrita. O que
// muda é QUEM os lê: depois do primeiro save, `loadDoc` para de consultar a projeção e o `.md` passa
// a ser a verdade.

import type { BoardConfig } from "../../types";
import { blockIdFactory, type DocBlock } from "../doc-model";
import { orderedSections } from "../doc-schema";
import type { SchemaDoc, SectionContent } from "../schema-codec";
import { splitLegacyProse } from "./lean-canvas-legacy";
import { PRD_SCHEMA } from "./prd";

/** De qual campo legado cada seção do PRD se abastece, e em que forma ela o recebe. */
const FROM_LADDER: Record<string, { field: keyof BoardConfig; as: "prose" | "items" }> = {
  posicionamento: { field: "positioning", as: "prose" },
  metricaNegocio: { field: "businessMetric", as: "items" },
  resultadoAlvo: { field: "desiredOutcome", as: "items" },
};

function ladderText(config: BoardConfig, field: keyof BoardConfig): string {
  const value = config[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A prosa legada como blocos. `prose` preserva os parágrafos do autor (uma frase de posicionamento é
 * uma frase — cortá-la em itens inventaria uma estrutura que ninguém escreveu); `items` passa pelo
 * MESMO corte conservador do canvas, que só separa onde o autor já tinha separado.
 */
function ladderBlocks(text: string, as: "prose" | "items", nextId: () => string): DocBlock[] {
  if (!text) return [];
  if (as === "prose") {
    return text
      .split(/\n\s*\n+/)
      .map((p) => p.trim().replace(/\s*\n\s*/g, " "))
      .filter(Boolean)
      .map((t): DocBlock => ({ kind: "paragraph", id: nextId(), text: t }));
  }
  return splitLegacyProse(text).map((t): DocBlock => ({ kind: "bullet", id: nextId(), text: t }));
}

/**
 * Projeta a escada estratégica do `board.yaml` como PRD. Uma seção obrigatória entra mesmo vazia — o
 * documento projetado precisa ser tão VÁLIDO quanto um gravado, senão a tela abriria acusando
 * violações que ninguém causou (e o save ficaria travado por elas).
 */
export function projectLegacyPrd(config: BoardConfig): SchemaDoc {
  const nextId = blockIdFactory();
  const sections: SectionContent[] = [];

  for (const rule of orderedSections(PRD_SCHEMA)) {
    const source = FROM_LADDER[rule.key];
    const blocks = source ? ladderBlocks(ladderText(config, source.field), source.as, nextId) : [];
    if (!blocks.length && !rule.required) continue;
    sections.push({ key: rule.key, label: rule.label, blocks });
  }

  return {
    docType: PRD_SCHEMA.docType,
    title: PRD_SCHEMA.title.kind === "fixed" ? PRD_SCHEMA.title.text : "PRD",
    frontmatter: { doc: PRD_SCHEMA.docType },
    sections,
    tail: [],
  };
}

/**
 * Há escada estratégica declarada? A tela distingue "board que nunca declarou norte nenhum" de
 * "board migrado que ainda não escreveu" — e priorizar sem norte produz ruído confiante, então a
 * diferença importa a quem lê.
 */
export function hasLegacyStrategy(config: BoardConfig): boolean {
  return Object.values(FROM_LADDER).some((s) => ladderText(config, s.field).length > 0);
}
