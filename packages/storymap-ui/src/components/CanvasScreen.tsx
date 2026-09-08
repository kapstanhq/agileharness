"use client";

// CanvasScreen — o Lean Canvas como DOCUMENTO, e as views como projeções dele.
//
// A inversão que esta tela materializa: a fonte da verdade é `storymap/boards/<board>/docs/
// lean-canvas.md` (markdown + frontmatter), e documento / fonte / quadro / tabela são quatro
// leituras do MESMO texto. Antes era o contrário — a estrutura no `board.yaml` era canônica e o
// documento era uma projeção que reancorava item por item para não perder identidade.
//
// O que isso apaga, e não volta:
//   · a view de markdown do canvas era SÓ LEITURA porque `itemId` não viajava no texto. Não há mais
//     itemId (nada precisa dele), então a fonte é editável como em qualquer outro documento;
//   · as quatro views não têm caminho de escrita próprio — todas mutam o `SchemaDoc` pelas funções
//     puras do codec, e só `saveDocAction` toca o disco.
//
// O CORPO da tela mora em `doc/SchemaDocScreen` e é genérico sobre o schema: as views vêm de
// `availableViews`, os blocos do editor de `allowedBlocksFor`, e o arranjo do quadro do layout
// opcional. Esta camada só nomeia QUAL documento é — era isso que sete telas repetiam à mão.

import { SchemaDocScreen } from "@/components/doc/SchemaDocScreen";
import { LEAN_CANVAS_SCHEMA } from "@/lib/storymap/doc/schemas/lean-canvas";
import type { SchemaDoc } from "@/lib/storymap/doc/schema-codec";
import type { SchemaViolation } from "@/lib/storymap/doc/doc-schema";
import type { Board, BoardSummary } from "@/lib/storymap/types";

export interface CanvasScreenProps {
  board: Board;
  boards: BoardSummary[];
  /** o documento lido do disco — ou projetado do `board.yaml` enquanto o .md não existir. */
  initialDoc: SchemaDoc;
  initialViolations: SchemaViolation[];
}

export function CanvasScreen({ board, boards, initialDoc, initialViolations }: CanvasScreenProps) {
  return (
    <SchemaDocScreen
      board={board}
      boards={boards}
      schema={LEAN_CANVAS_SCHEMA}
      view="canvas"
      title="Lean Canvas"
      initialDoc={initialDoc}
      initialViolations={initialViolations}
    />
  );
}
