// 🟨 A ponte do Lean Canvas ANTIGO (board.yaml `canvas:`) para o documento markdown.
//
// MIGRAÇÃO PREGUIÇOSA, não script: enquanto `docs/lean-canvas.md` não existir, o documento é
// PROJETADO do `board.yaml` em memória; o primeiro save grava o .md e o YAML vira vestígio. É o
// mesmo idioma que o `vocab-doc` já usa para as personas escritas antes do campo `prompt`, e ele
// ganha de um script de migração por três motivos concretos:
//
//   · zero downtime e zero janela — nada precisa rodar antes de a feature funcionar;
//   · nada é sobrescrito: a projeção é read-only até alguém decidir gravar;
//   · quem tem o canvas em prosa achatada (o estado real de hoje) revisa o corte em ITENS na tela,
//     que é onde a decisão pertence — um script quebraria por parágrafo e ninguém olharia.
//
// O que a projeção converte, e para onde:
//   `canvasTags`      → frontmatter `tags`
//   `item.tags`       → o prefixo visível `**Nome** — texto`
//   `item.group`      → um `###` autoral dentro da seção
//   `item.highlight`  → some como campo: o item destacado da proposta de valor vai para a PRIMEIRA
//                       posição, que é de onde a derivação do hero passa a lê-lo.

import type { BoardConfig, CanvasItem, CanvasTag } from "../../types";
import { coerceCanvasBlock } from "../../canvas";
import { blockIdFactory, type DocBlock } from "../doc-model";
import { orderedSections } from "../doc-schema";
import type { SchemaDoc, SectionContent } from "../schema-codec";
import { LEAN_CANVAS_HERO_SECTION, LEAN_CANVAS_SCHEMA } from "./lean-canvas";

/** O texto visível de um item: `**Etiqueta & Outra** — texto` quando etiquetado. */
function itemText(item: CanvasItem, tags: readonly CanvasTag[]): string {
  const names = (item.tags ?? [])
    .map((id) => tags.find((t) => t.id === id)?.name)
    .filter((n): n is string => !!n);
  return names.length ? `**${names.join(" & ")}** — ${item.text}` : item.text;
}

/**
 * O item destacado primeiro — só na seção do hero. Fora dela `highlight` nunca teve efeito visual,
 * então reordenar seria mexer no documento sem motivo.
 */
function ordered(items: readonly CanvasItem[], sectionKey: string): CanvasItem[] {
  if (sectionKey !== LEAN_CANVAS_HERO_SECTION) return [...items];
  const hero = items.find((i) => i.highlight);
  return hero ? [hero, ...items.filter((i) => i !== hero)] : [...items];
}

/**
 * O CORTE da prosa legada em itens.
 *
 * O formato antigo permitia uma string achatada por bloco, e é isso que os boards reais têm hoje: o
 * `problem` do board `storymap` é literalmente `"1. …\n\n2. …\n\n3. …"`. O coercer legado promove
 * isso a UM item — e um item só, com três ideias e uma lista numerada dentro, é o oposto do modelo
 * ("um item = uma ideia") e renderiza como um post-it gigante com lista aninhada.
 *
 * A régua é conservadora de propósito: só corta onde o AUTOR já tinha separado — parágrafo (linha em
 * branco) ou lista de primeiro nível. Um item bem formado é uma frase e não tem nenhum dos dois, então
 * passa intacto. O enumerador de abertura (`1. `, `2) `, `- `) é removido porque a POSIÇÃO na lista
 * passou a carregá-lo; mantê-lo daria "1. 1. …" nas views.
 *
 * Continua sendo um palpite sobre texto de humano — e é por isso que a migração é preguiçosa: o corte
 * aparece na tela para alguém conferir antes do primeiro save, em vez de um script decidir sozinho.
 */
export function splitLegacyProse(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const paragraphs = trimmed.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const pieces =
    paragraphs.length > 1
      ? paragraphs
      : // Parágrafo único que É uma lista (toda linha começa com marcador) → uma linha por item.
        (() => {
          const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
          const allMarked = lines.length > 1 && lines.every((l) => /^(?:[-*+]|\d+[.)])\s+/.test(l));
          return allMarked ? lines : [trimmed];
        })();

  return pieces.map((p) => p.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
}

/** Os blocos de uma seção: itens sem grupo primeiro, depois cada grupo com o seu `###`. */
/** Itens do canvas \u2192 blocos do documento. EXPORTADO porque a escrita governada precisa da MESMA\n *  conversão que a projeção usa \u2014 duas conversões divergiriam, e a governada seria a que ninguém vê. */
export function sectionBlocks(
  items: readonly CanvasItem[],
  tags: readonly CanvasTag[],
  nextId: () => string,
): DocBlock[] {
  const blocks: DocBlock[] = [];
  /**
   * Um item legado pode carregar VÁRIAS ideias (ver splitLegacyProse) — então cada um vira 1..N
   * bullets. O prefixo de etiqueta acompanha só o PRIMEIRO pedaço: repeti-lo em todos afirmaria que o
   * autor etiquetou cada ideia separadamente, o que ele não fez.
   */
  const bullets = (item: CanvasItem): DocBlock[] => {
    const pieces = splitLegacyProse(item.text);
    if (!pieces.length) return [];
    return pieces.map((text, i) => ({
      kind: "bullet" as const,
      id: nextId(),
      text: i === 0 ? itemText({ ...item, text }, tags) : text,
    }));
  };

  for (const item of items) if (!item.group?.trim()) blocks.push(...bullets(item));

  const groups: string[] = [];
  for (const item of items) {
    const g = item.group?.trim();
    if (g && !groups.includes(g)) groups.push(g);
  }
  for (const group of groups) {
    blocks.push({ kind: "heading", id: nextId(), level: 3, text: group });
    for (const item of items) if (item.group?.trim() === group) blocks.push(...bullets(item));
  }
  return blocks;
}

/**
 * Projeta o canvas do `board.yaml` como documento. Uma seção sem item nenhum ainda entra (vazia)
 * quando é obrigatória — o documento projetado precisa ser tão válido quanto um gravado, senão a
 * tela abriria com violações que ninguém causou.
 */
export function projectLegacyLeanCanvas(config: BoardConfig): SchemaDoc {
  const nextId = blockIdFactory();
  const tags = config.canvasTags ?? [];
  const canvas = config.canvas ?? {};
  const sections: SectionContent[] = [];

  for (const rule of orderedSections(LEAN_CANVAS_SCHEMA)) {
    // Passa pelo COERCER (canvas.ts é o dono único da forma) em vez de ler `.items` direto: o formato
    // mais antigo guarda uma STRING por bloco, e um `.items` cru sobre ela devolve vazio — o que
    // apagaria o canvas na tela, e o primeiro save gravaria esse vazio. `readBoardConfig` já coage no
    // caminho normal; depender disso deixaria a projeção correta só por sorte do chamador.
    const items = ordered(coerceCanvasBlock(canvas[rule.key])?.items ?? [], rule.key);
    if (!items.length && !rule.required) continue;
    sections.push({ key: rule.key, label: rule.label, blocks: sectionBlocks(items, tags, nextId) });
  }

  const frontmatter: Record<string, unknown> = { doc: LEAN_CANVAS_SCHEMA.docType };
  if (tags.length) {
    frontmatter.tags = tags.map((t) => ({ id: t.id, name: t.name, ...(t.color ? { color: t.color } : {}) }));
  }

  return {
    docType: LEAN_CANVAS_SCHEMA.docType,
    title: LEAN_CANVAS_SCHEMA.title.kind === "fixed" ? LEAN_CANVAS_SCHEMA.title.text : "Lean Canvas",
    frontmatter,
    sections,
    tail: [],
  };
}

/** Há algo no canvas legado? (a tela distingue "nunca preenchido" de "migrado e vazio"). */
export function hasLegacyLeanCanvas(config: BoardConfig): boolean {
  const canvas = config.canvas ?? {};
  return Object.values(canvas).some((block) => (coerceCanvasBlock(block)?.items.length ?? 0) > 0);
}
