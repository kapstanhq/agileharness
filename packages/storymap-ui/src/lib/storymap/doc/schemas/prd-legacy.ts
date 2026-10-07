// 📋 A ponte da ESCADA ESTRATÉGICA antiga (as três strings do `board.yaml`) para o PRD em markdown.
//
// MIGRAÇÃO PREGUIÇOSA, não script — o mesmo idioma do `lean-canvas-legacy`, pelos mesmos três
// motivos: zero janela (nada precisa rodar antes de a tela funcionar), nada é sobrescrito (a
// projeção é read-only até alguém gravar) e o corte da prosa em ITENS é revisado por um humano na
// tela, que é onde a decisão pertence.
//
// O mapa (PRD formato 2 — ver `prd.ts`):
//   `positioning`    → seção `propostaValor`    (prosa; era uma frase, continua uma frase)
//   `businessMetric` → seção `metricasSucesso`  (itens com o prefixo «Métrica de negócio: »)
//   `desiredOutcome` → seção `metricasSucesso`  (itens com o prefixo «Resultado-alvo: »)
//
// As outras seções do PRD nascem VAZIAS, e isso é o ponto: elas são exatamente o que a escada não
// dizia. Um board migrado abre com o que sempre teve e com o esqueleto do que faltava.
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
import { PRD_FORMAT, PRD_SCHEMA } from "./prd";

/**
 * De qual campo legado cada seção do PRD se abastece, em que forma e com que prefixo — na ordem em
 * que entram (duas fontes caem em «Métricas de sucesso»; o prefixo diz de qual degrau veio cada uma).
 */
const FROM_LADDER: readonly { section: string; field: keyof BoardConfig; as: "prose" | "items"; prefix?: string }[] = [
  { section: "propostaValor", field: "positioning", as: "prose" },
  { section: "metricasSucesso", field: "desiredOutcome", as: "items", prefix: "Resultado-alvo: " },
  { section: "metricasSucesso", field: "businessMetric", as: "items", prefix: "Métrica de negócio: " },
];

function ladderText(config: BoardConfig, field: keyof BoardConfig): string {
  const value = config[field];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A prosa legada como blocos. `prose` preserva os parágrafos do autor (uma frase de posicionamento é
 * uma frase — cortá-la em itens inventaria uma estrutura que ninguém escreveu); `items` passa pelo
 * MESMO corte conservador do canvas, que só separa onde o autor já tinha separado.
 */
function ladderBlocks(text: string, as: "prose" | "items", nextId: () => string, prefix = ""): DocBlock[] {
  if (!text) return [];
  if (as === "prose") {
    return text
      .split(/\n\s*\n+/)
      .map((p) => p.trim().replace(/\s*\n\s*/g, " "))
      .filter(Boolean)
      .map((t): DocBlock => ({ kind: "paragraph", id: nextId(), text: t }));
  }
  return splitLegacyProse(text).map((t): DocBlock => ({ kind: "bullet", id: nextId(), text: `${prefix}${t}` }));
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
    const blocks = FROM_LADDER.filter((s) => s.section === rule.key).flatMap((s) =>
      ladderBlocks(ladderText(config, s.field), s.as, nextId, s.prefix),
    );
    if (!blocks.length && !rule.required) continue;
    sections.push({ key: rule.key, label: rule.label, blocks });
  }

  return {
    docType: PRD_SCHEMA.docType,
    title: PRD_SCHEMA.title.kind === "fixed" ? PRD_SCHEMA.title.text : "PRD",
    frontmatter: { doc: PRD_SCHEMA.docType, format: PRD_FORMAT },
    sections,
    tail: [],
  };
}

/**
 * Há escada estratégica declarada? A tela distingue "board que nunca declarou norte nenhum" de
 * "board migrado que ainda não escreveu" — e ordenar o trabalho sem norte produz ruído confiante, então a
 * diferença importa a quem lê.
 */
export function hasLegacyStrategy(config: BoardConfig): boolean {
  return FROM_LADDER.some((s) => ladderText(config, s.field).length > 0);
}
