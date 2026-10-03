"use client";

// CardCreateScreen — criar um card como PÁGINA (`/board/[b]/card/novo`). Irmã da CardDocScreen: o
// mesmo shell, as mesmas visões (Documento · Markdown · Campos), o mesmo save bar — só que o card
// ainda não existe em disco, então o Salvar é `createCardAction` e, ao gravar, a página TROCA de
// URL para o card recém-nascido (`router.replace`), que é onde o trabalho continua.
//
// Por que uma tela separada e não um `mode="create"` na CardDocScreen: quase tudo que a página de um
// card faz pressupõe um card em disco (o documento composto com histórico e canvas, mover pelo
// pipeline, sincronizar, refinar, os blocos de prioridade e rota). Um `if (create)` em cada um deles
// seria uma segunda tela escondida dentro da primeira — o mesmo vício do drawer, que carregava dois
// modos e duas superfícies no mesmo componente de 1.500 linhas.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, SlidersHorizontal } from "lucide-react";
import { cardHref } from "@/lib/storymap/deep-links";
import { BoardHeader } from "@/components/BoardHeader";
import { DocShell } from "@/components/doc/DocShell";
import { DocEditor } from "@/components/doc/DocEditor";
import { DocTitle } from "@/components/doc/DocTitle";
import { CardFields } from "@/components/card/CardFields";
import { createCardAction } from "@/app/actions";
import {
  CARD_ALLOWED_BLOCKS,
  CARD_DOC_TYPE,
  commitCardDoc,
  projectCardDoc,
} from "@/lib/storymap/doc/card-doc";
import { reattachBindings, reattachSections, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { parseDocMd, serializeDocMd } from "@/lib/storymap/doc/md-codec";
import { makeDraftCard } from "@/lib/storymap/draft";
import { makeId } from "@/lib/storymap/id";
import type { Board, BoardConfig, BoardSummary, Card, CardType } from "@/lib/storymap/types";
import { useToast } from "@/components/Toast";

export interface CardCreateInit {
  type: CardType;
  parent: string | null;
  release: string | null;
  status: string | null;
}

export function CardCreateScreen({
  board,
  boards,
  init,
}: {
  board: Board;
  boards: BoardSummary[];
  init: CardCreateInit;
}) {
  const router = useRouter();
  const toast = useToast();
  const [config, setConfig] = useState<BoardConfig>(board.config);

  // O rascunho nasce UMA vez: `makeDraftCard` cunha um id livre de colisão e o `order` do fim do
  // grupo, lendo os cards de agora. Re-cunhar a cada render trocaria o id debaixo do autor.
  //
  // O título SEMENTE só existe para o BACKBONE, onde o id é o slug do título (`makeId`): uma
  // atividade sem título viraria `activity-sem-titulo` (o default do makeDraftCard). Story não
  // precisa — o id é aleatório (`randomCardId`) e o título é opcional por desenho, então ela abre
  // em branco, com o convite do placeholder.
  const [draft, setDraft] = useState<Card>(() =>
    makeDraftCard({
      type: init.type,
      title: init.type === "activity" ? "Nova atividade" : init.type === "step" ? "Novo step" : "",
      parent: init.parent,
      release: init.release,
      status: init.status,
      cards: board.cards,
    }),
  );
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [saving, setSaving] = useState(false);

  const deps = useMemo(
    () => ({ personas: config.personas, statusName: null }),
    [config.personas],
  );

  // Capturado na montagem (e no descarte, pelo epoch): re-projetar a cada tecla remontaria o editor.
  const editModel = useMemo(
    () => projectCardDoc(draft, deps),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editorEpoch],
  );

  const handleDocChange = (blocks: DocBlock[]) => {
    setDraft((d) =>
      commitCardDoc(
        { docType: CARD_DOC_TYPE, title: d.title, blocks: reattachBindings(blocks, editModel.blocks) },
        d,
      ).card,
    );
  };

  const markdownSource = () => serializeDocMd(projectCardDoc(draft, deps), { includeTitle: true });

  const applyMarkdown = (markdown: string) => {
    const base = projectCardDoc(draft, deps);
    const parsed = parseDocMd(markdown, { docType: CARD_DOC_TYPE, stripTitle: true });
    const blocks = reattachSections(reattachBindings(parsed.blocks, base.blocks), base.blocks);
    setDraft((d) => commitCardDoc({ docType: CARD_DOC_TYPE, title: parsed.title || d.title, blocks }, d).card);
  };

  const backHref = `/board/${config.id}/mapa`;

  const save = async () => {
    setSaving(true);
    // O id do BACKBONE é o slug do título, e o título só fica pronto agora — cunhar no rascunho e
    // não re-cunhar deixava um "Escolher plano" gravado como `step-novo-step` (o que a gaveta fazia).
    // Story não entra: o id dela é aleatório e estável desde o rascunho.
    const existing = new Set(board.cards.map((c) => c.id));
    const card: Card =
      draft.type === "story" || !draft.title.trim()
        ? draft
        : { ...draft, id: makeId(draft.type, draft.title, existing) };
    const res = await createCardAction({ boardId: config.id, card });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      return;
    }
    // createCardAction pode ter ajustado o id numa colisão — siga o que ele gravou.
    const saved = res.data?.card ?? card;
    router.replace(cardHref(config.id, saved.id));
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={config} view="mapa" subnav={false} />
      <div className="min-h-0 flex-1">
        <DocShell
          docType={CARD_DOC_TYPE}
          title={draft.title || "Novo card"}
          backHref={backHref}
          views={[
            {
              id: "doc",
              label: "Documento",
              icon: FileText,
              render: () => (
                <div className="space-y-3">
                  <DocTitle
                    value={draft.title}
                    onChange={(title) => setDraft((d) => ({ ...d, title }))}
                    placeholder="Título — opcional, o /harness-enrich sugere depois"
                  />
                  <DocEditor
                    key={`card-create-${editorEpoch}`}
                    model={editModel}
                    allowedBlocks={CARD_ALLOWED_BLOCKS}
                    onChange={handleDocChange}
                  />
                </div>
              ),
            },
            {
              id: "campos",
              label: "Campos",
              icon: SlidersHorizontal,
              render: () => (
                <CardFields
                  boardId={config.id}
                  config={config}
                  cards={board.cards}
                  card={draft}
                  draft={draft}
                  mode="create"
                  onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                  onConfigChanged={setConfig}
                  onSaved={setDraft}
                />
              ),
            },
          ]}
          markdown={{ read: markdownSource, write: applyMarkdown, epoch: editorEpoch }}
          mode="edit"
          // Sempre "sujo": a barra é o único caminho para gravar, e um card novo que ninguém
          // gravou não existe. Descartar volta para de onde se veio.
          dirty
          saving={saving}
          onSave={save}
          onDiscard={() => router.back()}
        />
      </div>
    </div>
  );
}
