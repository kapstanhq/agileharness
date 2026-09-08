"use client";

// EstiloScreen — the style-guide content screen. When the guide is EMPTY, the authoring flow
// (EstiloView's AuthorPanel) renders untouched. When PUBLISHED: Doc (Notion-style, default) ⇄
// "Estruturado" (the legacy EstiloView). Doc edits touch ONLY the per-section prose and ride
// applyStyleGuideAssistAction — the optimistic-concurrency chokepoint (baseVersion) that compiles
// the canonical .md and bumps the version; the structured half projects read-only.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileText, LayoutPanelTop } from "lucide-react";
import { BoardHeader } from "@/components/BoardHeader";
import { EstiloView, type EstiloViewProps } from "@/components/EstiloView";
import { DocShell, DocToolbar } from "@/components/doc/DocShell";
import { DocRead } from "@/components/doc/DocRead";
import { DocEditor } from "@/components/doc/DocEditor";
import { applyStyleGuideAssistAction } from "@/app/design-actions";
import {
  commitStyleDoc,
  projectStyleDoc,
  STYLE_ALLOWED_BLOCKS,
  STYLE_DOC_TYPE,
} from "@/lib/storymap/doc/style-doc";
import { reattachBindings, reattachSections, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { parseDocMd, serializeDocMd } from "@/lib/storymap/doc/md-codec";
import { useDocViewPref } from "@/lib/storymap/doc/use-doc-view-pref";
import { useToast } from "@/components/Toast";

export function EstiloScreen(props: EstiloViewProps) {
  const { board, boards, styleGuide, hasPublishedGuide } = props;
  const router = useRouter();
  const toast = useToast();
  const config = board.config;
  const { viewId, setViewId } = useDocViewPref(STYLE_DOC_TYPE, { viewId: "doc", width: "medium" });

  const [mode, setMode] = useState<"read" | "edit">("read");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [editedBlocks, setEditedBlocks] = useState<DocBlock[] | null>(null);
  const [saving, setSaving] = useState(false);

  const readModel = useMemo(
    () => (hasPublishedGuide && styleGuide ? projectStyleDoc(styleGuide) : null),
    [hasPublishedGuide, styleGuide],
  );
  const editModel = useMemo(
    () => (mode === "edit" && styleGuide ? projectStyleDoc(styleGuide) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, editorEpoch],
  );

  // Sem depender do `editModel`: as edições podem vir do editor rico OU da visão Markdown (que vive
  // fora do modo "edit") — atrelar a prévia ao editor rico deixava um texto editado na fonte sem
  // barra de salvar, ou seja, perdido no primeiro refresh.
  const commitPreview = useMemo(() => {
    if (!editedBlocks || !styleGuide) return null;
    return commitStyleDoc(
      { docType: STYLE_DOC_TYPE, title: "Guia de Estilo", blocks: editedBlocks },
      styleGuide,
    );
  }, [editedBlocks, styleGuide]);

  const dirty =
    !!commitPreview && (commitPreview.changedSections.length > 0 || commitPreview.unbound.length > 0);
  const refused = !!commitPreview && commitPreview.unbound.length > 0;

  const discard = () => {
    setEditedBlocks(null);
    setEditorEpoch((e) => e + 1);
  };

  const save = async () => {
    // A recusa é DITA, não muda o botão (a visão Markdown não tem onde pendurar o aviso inline).
    if (refused) {
      toast("Conteúdo fora das seções do guia não tem onde viver — mova para dentro de uma seção ou remova.");
      return;
    }
    if (!commitPreview || commitPreview.changedSections.length === 0) return;
    setSaving(true);
    const res = await applyStyleGuideAssistAction({
      boardId: config.id,
      doc: commitPreview.doc,
      baseVersion: config.styleGuide?.version ?? 0,
    });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      router.refresh(); // baseVersion stale (alguém promoveu por baixo) — re-sincroniza
      return;
    }
    setEditedBlocks(null);
    setMode("read");
    router.refresh();
  };

  // Empty guide → the authoring flow, untouched (no doc to project yet).
  if (!hasPublishedGuide || !styleGuide || !readModel) {
    return <EstiloView {...props} />;
  }

  const markdownSource = () =>
    serializeDocMd({ ...readModel, blocks: editedBlocks ?? readModel.blocks }, { includeTitle: true });

  const applyMarkdown = (markdown: string) => {
    const parsed = parseDocMd(markdown, { docType: STYLE_DOC_TYPE, stripTitle: true });
    setEditedBlocks(reattachSections(reattachBindings(parsed.blocks, readModel.blocks), readModel.blocks));
  };

  const viewDefs = [
    { id: "doc", label: "Documento", icon: FileText },
    { id: "estruturado", label: "Estruturado", icon: LayoutPanelTop },
  ];

  if (viewId === "estruturado") {
    // A view legada carrega o próprio chrome — o SUB-TOPNAV é o MESMO (DocToolbar), então a troca é
    // sempre reversível.
    return (
      <EstiloView
        {...props}
        subnav={
          <DocToolbar
            inline
            views={viewDefs}
            activeViewId="estruturado"
            onViewChange={(id) => setViewId(id)}
          />
        }
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={config} view="estilo" />
      <div className="min-h-0 flex-1">
        <DocShell
          docType={STYLE_DOC_TYPE}
          title="Guia de Estilo"
          // O Estruturado é a única view que vive FORA do shell (traz o próprio chrome) — as de
          // dentro (documento, markdown) o shell resolve sozinho; só ela é interceptada aqui.
          viewId={viewId === "estruturado" ? "doc" : viewId}
          onViewChange={(id) => {
            if (id !== "estruturado") setViewId(id);
            else if (!dirty) setViewId("estruturado");
            else toast("Salve ou descarte as mudanças antes de trocar de view.");
          }}
          views={[
            {
              id: "doc",
              label: "Documento",
              icon: FileText,
              render: () =>
                mode === "edit" && editModel ? (
                  <div className="space-y-3">
                    {refused && commitPreview && (
                      <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <p>
                          Conteúdo fora das seções do guia não tem onde viver — mova para dentro de uma
                          seção conhecida ou remova antes de salvar.
                        </p>
                      </div>
                    )}
                    <DocEditor
                      key={`style-edit-${editorEpoch}`}
                      model={editModel}
                      allowedBlocks={STYLE_ALLOWED_BLOCKS}
                      onChange={(blocks) =>
                        setEditedBlocks(reattachBindings(blocks, editModel.blocks))
                      }
                    />
                  </div>
                ) : (
                  <DocRead model={readModel} />
                ),
            },
            { id: "estruturado", label: "Estruturado", icon: LayoutPanelTop, render: () => null },
          ]}
          mode={mode}
          onModeChange={(m) => {
            if (m === "read" && dirty) {
              toast("Salve ou descarte as mudanças antes de sair da edição.");
              return;
            }
            setEditedBlocks(null);
            setMode(m);
          }}
          markdown={{ read: markdownSource, write: applyMarkdown, epoch: editorEpoch }}
          exportMarkdown={() =>
            serializeDocMd(readModel, { includeProperties: true, includeTitle: true })
          }
          dirty={dirty}
          saving={saving}
          onSave={save}
          onDiscard={discard}
        />
      </div>
    </div>
  );
}
