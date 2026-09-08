"use client";

// PrdScreen — o PRD, o documento MAIS ALTO do board.
//
// Ele substituiu a tela de Posicionamento, e a diferença não é de rótulo. Ali eram três strings do
// `board.yaml` (`positioning`, `businessMetric`, `desiredOutcome`) projetadas como documento: fora
// do registro, logo inalcançáveis por `read_doc`/`write_doc`, e sem conversa (`chatSurfaceFor`
// devolvia `undefined`). Aqui é um documento de verdade — markdown em disco, schema, as três portas
// de escrita, e um agente que lê e escreve nele pela superfície canônica.
//
// O corpo é o `SchemaDocScreen` genérico. O que esta camada acrescenta é a única coisa que o
// genérico não pode saber: a saída DAQUI para o resto do board. O PRD é a fonte, e "gerar o mapa"
// é a primeira derivação — ela reusa a captura inteira (propor → revisar → aplicar), semeada com o
// recorte do documento que descreve o trabalho, em vez de ganhar um caminho de criação próprio.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitBranchPlus } from "lucide-react";
import { SchemaDocScreen } from "@/components/doc/SchemaDocScreen";
import { SmartCaptureModal } from "@/components/SmartCaptureModal";
import { PRD_SCHEMA } from "@/lib/storymap/doc/schemas/prd";
import type { SchemaDoc } from "@/lib/storymap/doc/schema-codec";
import type { SchemaViolation } from "@/lib/storymap/doc/doc-schema";
import type { Board, BoardSummary } from "@/lib/storymap/types";

export interface PrdScreenProps {
  board: Board;
  boards: BoardSummary[];
  /** o documento lido do disco — ou projetado da escada estratégica enquanto o .md não existir. */
  initialDoc: SchemaDoc;
  initialViolations: SchemaViolation[];
  /**
   * O recorte do PRD que descreve O QUE construir (jornadas · escopo · solução), resolvido no
   * servidor. Vazio ⇒ o documento ainda não diz o que fazer, e o botão de gerar o mapa não aparece:
   * uma captura semeada com nada devolveria uma proposta inventada, com a mesma cara de uma boa.
   */
  backlogSeed: string;
}

export function PrdScreen({ board, boards, initialDoc, initialViolations, backlogSeed }: PrdScreenProps) {
  const router = useRouter();
  const [capturaAberta, setCapturaAberta] = useState(false);
  const config = board.config;

  return (
    <SchemaDocScreen
      board={board}
      boards={boards}
      schema={PRD_SCHEMA}
      view="prd"
      title="PRD"
      initialDoc={initialDoc}
      initialViolations={initialViolations}
      toolbarExtra={
        backlogSeed ? (
          <button
            type="button"
            onClick={() => setCapturaAberta(true)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
            title="Propõe o backbone e as stories a partir das jornadas, do escopo e da solução deste PRD"
          >
            <GitBranchPlus className="h-3.5 w-3.5" />
            Gerar mapa
          </button>
        ) : undefined
      }
      overlay={
        capturaAberta ? (
          <SmartCaptureModal
            boardId={config.id}
            config={config}
            cards={board.cards}
            // Semeado, não automático: a captura abre com o recorte já escrito e o operador revisa
            // ANTES de propor. Um botão que fosse direto da leitura do documento para cards criados
            // pularia as duas conferências que a captura existe para dar (o texto e a árvore).
            initialText={backlogSeed}
            onClose={() => {
              setCapturaAberta(false);
              router.refresh();
            }}
            onCreated={() => router.refresh()}
            onOpenCard={(id) => router.push(`/board/${config.id}/card/${id}`)}
            onOpenIdeas={() => router.push(`/board/${config.id}/ideias`)}
          />
        ) : undefined
      }
    />
  );
}
