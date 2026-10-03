"use client";

// VocabDocScreen — the detail page of ONE persona/system as a Notion-style document (the simplified
// LISTING stays in /vocabulario; identity CRUD — create/rename/colour/delete — stays there too).
// The doc edits the PRIMARY `prompt` (+ title→name) through the existing patch actions
// (fresh-read anti-clobber); a legacy row lazy-migrates its composed body into `prompt` on first save.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Server, Sparkles, UserRound } from "lucide-react";
import { BoardHeader } from "@/components/BoardHeader";
import { DocShell } from "@/components/doc/DocShell";
import { DocRead } from "@/components/doc/DocRead";
import { DocEditor } from "@/components/doc/DocEditor";
import { DocTitle } from "@/components/doc/DocTitle";
import { ViewChat } from "@/components/ViewChat";
import { ChatDock, ChatDockGhost, useChatRailVisible } from "@/components/chat/ChatDock";
import { chatDockFor, chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { vocabChatContextAction } from "@/app/vocab-actions";
import { patchPersonaAction, patchSystemAction } from "@/app/actions";
import {
  commitVocabDoc,
  projectVocabDoc,
  VOCAB_ALLOWED_BLOCKS,
} from "@/lib/storymap/doc/vocab-doc";
import { reattachBindings, reattachSections, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { parseDocMd, serializeDocMd } from "@/lib/storymap/doc/md-codec";
import type { Board, BoardSummary, Persona, SystemDef } from "@/lib/storymap/types";
import { useToast } from "@/components/Toast";

export function VocabDocScreen({
  board,
  boards,
  kind,
  entity,
  referencedByCount,
}: {
  board: Board;
  boards: BoardSummary[];
  kind: "persona" | "system";
  entity: Persona | SystemDef;
  referencedByCount: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const config = board.config;

  const [mode, setMode] = useState<"read" | "edit">("read");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [editedBlocks, setEditedBlocks] = useState<DocBlock[] | null>(null);
  const [title, setTitle] = useState(entity.name);
  const [saving, setSaving] = useState(false);

  // ── O Arquiteto, com ESTA linha ANEXADA ───────────────────────────────────────────────────────
  // Mesma raia da listagem (`view: "vocabulario"`): abrir uma persona não começa conversa nova — só diz
  // de qual delas estamos falando. É a régua do Operador (o chat é por TELA, não por artefato), e aqui
  // ela paga caro: o que faz um vocabulário prestar é a DISTINÇÃO entre as linhas, e um agente que só
  // enxergasse a linha aberta jamais poderia dizer que ela é a mesma pessoa que a de baixo.
  //
  // O foco é um ANEXO, não uma saudação nova: a conversa CONTINUA e ganha um chip acima do composer
  // dizendo o que ela está lendo. Soltar o chip devolve o escopo ao vocabulário inteiro — e o
  // `getContext` para de mandar o prompt completo desta linha no turno seguinte, de verdade.
  const railVisible = useChatRailVisible();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chatOpen = railVisible || sheetOpen;
  const [focused, setFocused] = useState(true);
  const [chatContext, setChatContext] = useState<string | null>(null);
  const focusRef = useMemo(() => ({ kind, id: entity.id }), [kind, entity.id]);
  useEffect(() => {
    if (!chatOpen) return;
    let alive = true;
    void vocabChatContextAction(config.id, focused ? focusRef : undefined)
      .then((c) => alive && setChatContext(c))
      .catch(() => alive && setChatContext("Não consegui ler o vocabulário deste board."));
    return () => {
      alive = false;
    };
    // `focused` nas deps de propósito: soltar o anexo RE-LÊ o contexto sem esta linha em foco — senão o
    // chip sumiria da tela e o prompt continuaria no bloco de dados, que é a mentira oposta.
  }, [chatOpen, focused, config.id, focusRef]);

  const readModel = useMemo(
    () => projectVocabDoc(entity, kind, { referencedByCount }),
    [entity, kind, referencedByCount],
  );
  const editModel = useMemo(
    () => (mode === "edit" ? projectVocabDoc(entity, kind, { referencedByCount }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, editorEpoch],
  );

  // A base é o modelo de EDIÇÃO quando ele existe e o de leitura fora dele: as edições agora também
  // podem chegar da visão Markdown, que vive fora do modo "edit" — atrelar a prévia ao editor rico
  // deixava um texto editado na fonte sem barra de salvar (perdido no primeiro refresh).
  const baseModel = editModel ?? readModel;
  const commitPreview = useMemo(() => {
    const blocks = editedBlocks ?? baseModel.blocks;
    return commitVocabDoc(
      { docType: baseModel.docType, title, blocks: reattachBindings(blocks, baseModel.blocks) },
      entity,
      kind,
    );
  }, [baseModel, editedBlocks, title, entity, kind]);

  // dirty exige interação (bloco editado OU título mudado) — abrir-e-fechar de linha legada nunca
  // dispara a migração sozinho (lazy, mas só com um save INTENCIONAL).
  const interacted = editedBlocks !== null || title !== entity.name;
  const dirty = interacted && !!commitPreview && commitPreview.changed;

  const discard = () => {
    setEditedBlocks(null);
    setTitle(entity.name);
    setEditorEpoch((e) => e + 1);
  };

  const markdownSource = () =>
    serializeDocMd({ ...readModel, title, blocks: editedBlocks ?? readModel.blocks }, { includeTitle: true });

  const applyMarkdown = (markdown: string) => {
    const parsed = parseDocMd(markdown, { docType: readModel.docType, stripTitle: true });
    if (parsed.title) setTitle(parsed.title);
    setEditedBlocks(reattachSections(reattachBindings(parsed.blocks, readModel.blocks), readModel.blocks));
  };

  const save = async () => {
    if (!commitPreview || !dirty) return;
    setSaving(true);
    const res =
      kind === "persona"
        ? await patchPersonaAction({
            boardId: config.id,
            personaId: entity.id,
            patch: commitPreview.patch,
          })
        : await patchSystemAction({
            boardId: config.id,
            systemId: entity.id,
            patch: commitPreview.patch,
          });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      router.refresh();
      return;
    }
    setEditedBlocks(null);
    setMode("read");
    router.refresh();
  };

  return (
    // Como na listagem: com o rail ancorado a PÁGINA é dona do viewport e o documento é que rola, para
    // o composer do chat ficar parado no rodapé. Layout por CSS (`lg:`), montagem por JS (`railVisible`).
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
      {/* Página de DETALHE ⇒ `subnav={false}`: sem a barra de abas do Produto. Sem isso — e era o
          caso — esta era a ÚNICA tela de detalhe da família que empilhava as abas da seção SOBRE a
          barra do próprio documento (voltar + título + ações), exatamente o que a prop existe para
          evitar. As irmãs (CardDocScreen, IdeaDocScreen) já optavam por fora. */}
      <BoardHeader boards={boards} config={config} view="vocabulario" subnav={false} dockedChat={railVisible} />
      <div className="flex min-h-0 flex-1">
        <div className="quiet-scroll min-w-0 flex-1 lg:overflow-y-auto">
        <DocShell
          docType={readModel.docType}
          title={entity.name}
          backHref={`/board/${config.id}/vocabulario`}
          views={[
            {
              id: "doc",
              label: "Documento",
              icon: FileText,
              render: () =>
                mode === "edit" && editModel ? (
                  <div className="space-y-3">
                    <DocTitle value={title} onChange={setTitle} placeholder="Nome" />
                    <DocEditor
                      key={`vocab-edit-${editorEpoch}`}
                      model={editModel}
                      allowedBlocks={VOCAB_ALLOWED_BLOCKS}
                      onChange={(blocks) => setEditedBlocks(blocks)}
                    />
                  </div>
                ) : (
                  <DocRead model={readModel} />
                ),
            },
          ]}
          markdown={{ read: markdownSource, write: applyMarkdown, epoch: editorEpoch }}
          mode={mode}
          onModeChange={(m) => {
            if (m === "read" && dirty) {
              toast("Salve ou descarte as mudanças antes de sair da edição.");
              return;
            }
            discard();
            setMode(m);
          }}
          exportMarkdown={() =>
            serializeDocMd(readModel, { includeProperties: true, includeTitle: true })
          }
          dirty={dirty}
          saving={saving}
          onSave={save}
          onDiscard={discard}
        />
        </div>

        {!railVisible && <ChatDockGhost />}

        {/* O MESMO Arquiteto da listagem — mesma raia, mesmo histórico. O `getContext` re-resolve a cada
            turno, então o prompt que ele lê é o SALVO agora (o que estiver só no editor ainda não é fato). */}
        <ChatDock
          mode={chatDockFor("vocabulario")}
          open={chatOpen}
          onClose={() => setSheetOpen(false)}
          label={chatSurfaceFor("vocabulario")?.label ?? "Arquiteto"}
        >
          <ViewChat
            boardId={config.id}
            view="vocabulario"
            context={chatContext ?? "Carregando o vocabulário do board…"}
            getContext={() => vocabChatContextAction(config.id, focused ? focusRef : undefined)}
            // A MESMA saudação da listagem, de propósito: é a mesma conversa, e reescrever a primeira fala a
            // cada navegação mentiria sobre o que já foi dito. Quem conta que ESTA linha está em foco é o
            // ANEXO abaixo, que descreve o presente.
            greeting={
              "Estou vendo as personas e os sistemas deste board. Posso encarnar uma persona para mostrar onde " +
              "ela está genérica, apontar duas que se sobrepõem, ou ler o código e sincronizar o prompt de um " +
              "sistema com o que ele de fato faz. Por onde começamos?"
            }
            contextRefs={[
              {
                id: entity.id,
                kind: kind === "persona" ? "Persona" : "Sistema",
                label: entity.name || entity.id,
                icon:
                  kind === "persona" ? <UserRound className="h-3 w-3" /> : <Server className="h-3 w-3" />,
                attached: focused,
                onToggle: () => setFocused((f) => !f),
              },
            ]}
            onClose={railVisible ? undefined : () => setSheetOpen(false)}
          />
        </ChatDock>
      </div>

      {/* No celular a conversa é folha, e este é o botão que a chama (no desktop ela já está na tela). */}
      {!railVisible && !sheetOpen && (
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="fixed bottom-20 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2.5 text-[12px] font-medium text-fg-muted shadow-lg transition hover:text-fg"
        >
          <Sparkles className="h-4 w-4" />
          Arquiteto
        </button>
      )}
    </div>
  );
}
