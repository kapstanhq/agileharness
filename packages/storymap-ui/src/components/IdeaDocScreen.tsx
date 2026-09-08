"use client";

// IdeaDocScreen — a Ideia como DOCUMENTO em tela cheia (`/board/[b]/ideia/[id]`), ADR-066.
//
// É aqui que a Ideia deixa de ser um formulário de cinco campos e vira um texto: os campos OST
// aparecem como caixas ancoradas (`idea-doc`) no meio da escrita livre, e o autor pode ignorá-las
// completamente e só escrever. Mesma estrada de save do card (updateCardAction + expectedBody
// anti-clobber), então o Explorador — que escreve neste mesmo documento — nunca sobrescreve edição
// não-salva do humano.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Lightbulb, Sparkles } from "lucide-react";
import { BoardHeader } from "@/components/BoardHeader";
import { IdeaDocActions } from "@/components/IdeaDocActions";
import { DocShell } from "@/components/doc/DocShell";
import { DocEditor } from "@/components/doc/DocEditor";
import { DocRead } from "@/components/doc/DocRead";
import { DocTitle } from "@/components/doc/DocTitle";
import { updateCardAction } from "@/app/actions";
import {
  IDEA_ALLOWED_BLOCKS,
  IDEA_DOC_TYPE,
  commitIdeaDoc,
  ideaSectionAnchors,
  projectIdeaDoc,
} from "@/lib/storymap/doc/idea-doc";
import { reattachBindings, reattachSections, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { parseDocMd, serializeDocMd } from "@/lib/storymap/doc/md-codec";
import { cardsAddressing, ideaFingerprint } from "@/lib/storymap/idea";
import type { Board, BoardSummary, Card } from "@/lib/storymap/types";
import { useToast } from "@/components/Toast";
import { ViewChat } from "@/components/ViewChat";
import { ChatDock, ChatDockGhost, useChatRailVisible } from "@/components/chat/ChatDock";
import { chatDockFor, chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { ideasChatContextAction } from "@/app/idea-actions";

export function IdeaDocScreen({
  board,
  boards,
  card,
  initialMode = "read",
}: {
  board: Board;
  boards: BoardSummary[];
  card: Card;
  /** "edit" quando se chega da criação (`?editar=1`): a ideia acabou de nascer e o próximo gesto é
   *  escrever — cair em leitura obrigaria um clique em "Editar" só para começar. */
  initialMode?: "read" | "edit";
}) {
  const router = useRouter();
  const toast = useToast();
  const config = board.config;

  const [draft, setDraft] = useState<Card>(card);
  const [baselineBody, setBaselineBody] = useState<string>(card.body);
  // A base de comparação do anti-clobber, capturada na CARGA — é contra ela que o disco é conferido no save.
  const [baselineIdea, setBaselineIdea] = useState<string>(() => ideaFingerprint(card.idea));
  const [docTouched, setDocTouched] = useState(false);
  const [mode, setMode] = useState<"read" | "edit">(initialMode);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [saving, setSaving] = useState(false);

  // ── O Explorador, com ESTA ideia ANEXADA ──────────────────────────────────────────────────────
  // Mesma raia da bancada (`view: "ideias"`): abrir uma ideia não começa conversa nova. Ancorado no desktop,
  // folha no celular — a mesma régua da listagem, vinda da MESMA entrada do registro.
  //
  // O foco é um ANEXO, não uma saudação nova (ver chat/ChatContext): a conversa CONTINUA e ganha um chip
  // acima do composer dizendo o que ela está lendo. Soltar o chip (`focused=false`) devolve o escopo à
  // bancada inteira — e o `getContext` para de mandar o documento no turno seguinte, de verdade.
  const railVisible = useChatRailVisible();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chatOpen = railVisible || sheetOpen;
  const [focused, setFocused] = useState(true);
  const [chatContext, setChatContext] = useState<string | null>(null);
  useEffect(() => {
    if (!chatOpen) return;
    let alive = true;
    void ideasChatContextAction(config.id, focused ? card.id : undefined)
      .then((c) => alive && setChatContext(c))
      .catch(() => alive && setChatContext("Não consegui ler esta ideia."));
    return () => {
      alive = false;
    };
    // `focused` nas deps de propósito: soltar o anexo RE-LÊ o contexto de abertura sem a ideia — senão o
    // chip sumiria da tela e o documento continuaria no bloco de dados, que é a mentira oposta.
  }, [chatOpen, focused, config.id, card.id]);

  const deps = useMemo(
    () => ({ addressedCount: cardsAddressing(card, board.cards).length }),
    [card, board.cards],
  );
  const readModel = useMemo(() => projectIdeaDoc(card, deps), [card, deps]);
  const editModel = useMemo(
    // `scaffold` SÓ na edição: em leitura uma caixa vazia seria ruído; ao editar ela é o convite.
    () => (mode === "edit" ? projectIdeaDoc(draft, { ...deps, scaffold: true }) : null),
    // Capturado na ENTRADA da edição (o epoch reinicia no descarte): re-projetar a cada onChange
    // remontaria o editor e comeria o cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, editorEpoch],
  );

  const ideaChanged = JSON.stringify(draft.idea) !== JSON.stringify(card.idea);
  const dirty = docTouched || draft.title !== card.title || draft.body !== card.body || ideaChanged;

  const handleDocChange = (blocks: DocBlock[]) => {
    if (!editModel) return;
    setDocTouched(true);
    setDraft((d) =>
      commitIdeaDoc(
        { docType: IDEA_DOC_TYPE, title: d.title, blocks: reattachBindings(blocks, editModel.blocks) },
        d,
      ).card,
    );
  };

  const discard = () => {
    setDraft(card);
    setDocTouched(false);
    setEditorEpoch((e) => e + 1);
  };

  // ── a MESMA ideia, em markdown cru ─────────────────────────────────────────────────────────────
  // A fonte sai do RASCUNHO (não do card salvo), então alternar Documento ⇄ Markdown no meio de uma
  // edição mostra o que se acabou de escrever. Na volta, `reattachBindings` + `reattachSections`
  // reancoram as regiões: `> **A ideia**` (a forma canônica) e também `## A ideia`, que é o que a
  // pessoa naturalmente digita agora que uma seção LÊ como título.
  const markdownSource = () =>
    serializeDocMd(projectIdeaDoc(draft, { ...deps, scaffold: true }), { includeTitle: true });

  const applyMarkdown = (markdown: string) => {
    const base = projectIdeaDoc(draft, { ...deps, scaffold: true });
    // O catálogo COMPLETO de âncoras (não só as seções que a projeção emitiu): é o que deixa
    // escrever `## O que sustenta` na fonte para PREENCHER um campo hoje vazio — sem ele o texto
    // cairia no corpo livre, porque a seção vazia nem aparece no modelo projetado.
    const anchors = [...base.blocks, ...ideaSectionAnchors()];
    const parsed = parseDocMd(markdown, { docType: IDEA_DOC_TYPE, stripTitle: true });
    const blocks = reattachSections(reattachBindings(parsed.blocks, anchors), anchors);
    setDocTouched(true);
    setDraft((d) => commitIdeaDoc({ docType: IDEA_DOC_TYPE, title: parsed.title || d.title, blocks }, d).card);
  };

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    // A Ideia vive FORA do pipeline (status null), então não há avanço de cascata a proteger — o
    // expectedStatus do card não se aplica. O expectedBody continua valendo, e é ele que segura o
    // Explorador (que escreve neste documento) contra a edição que você ainda não salvou.
    // Os DOIS guards vão SEMPRE, não só quando o documento foi tocado. O Explorador escreve neste mesmo
    // documento enquanto você o lê: uma edição só de campo (pela aba "Campos") salvava o snapshot inteiro,
    // incluindo o corpo e o bloco `idea` como estavam quando a página carregou — apagando em silêncio o que o
    // agente tinha acabado de apurar. Com os guards, esse save é RECUSADO com o motivo, e nada some.
    const res = await updateCardAction({
      boardId: config.id,
      card: draft,
      expectedBody: baselineBody,
      expectedIdea: baselineIdea,
    });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      router.refresh();
      return;
    }
    const saved = res.data?.card ?? draft;
    setDraft(saved);
    setBaselineBody(saved.body);
    setBaselineIdea(ideaFingerprint(saved.idea));
    setDocTouched(false);
    setMode("read");
    router.refresh();
  };

  return (
    // Como na bancada: com o rail ancorado a PÁGINA é dona do viewport e o documento é que rola, para o composer
    // do chat ficar parado no rodapé. Layout por CSS (`lg:`), montagem por JS (`railVisible`).
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
      <BoardHeader boards={boards} config={config} view="ideias" subnav={false} dockedChat={railVisible} />
      <div className="flex min-h-0 flex-1">
        <div className="quiet-scroll min-w-0 flex-1 lg:overflow-y-auto">
        <DocShell
          docType={IDEA_DOC_TYPE}
          title={draft.title || card.id}
          backHref={`/board/${config.id}/ideias`}
          // UMA visão só: o DOCUMENTO. A aba "Campos" foi removida (decisão do Operador) — cinco
          // textareas espelhando o que o texto já diz eram justamente o que fazia a Ideia parecer uma
          // story de formulário, e manter as duas superfícies de escrita significava duas verdades sobre
          // o mesmo parágrafo. O que NÃO era escrita — decidir o estado da exploração, gerar as tarefas —
          // não morava no formulário por natureza, e agora fica ao lado do documento (IdeaDocActions).
          views={[
            {
              id: "doc",
              label: "Documento",
              icon: FileText,
              render: () =>
                mode === "edit" && editModel ? (
                  <div className="space-y-3">
                    <DocTitle
                      value={draft.title}
                      onChange={(title) => setDraft((d) => ({ ...d, title }))}
                      placeholder="Do que é esta ideia?"
                    />
                    <DocEditor
                      key={`idea-page-edit-${card.id}-${editorEpoch}`}
                      model={editModel}
                      allowedBlocks={IDEA_ALLOWED_BLOCKS}
                      onChange={handleDocChange}
                    />
                  </div>
                ) : (
                  <>
                    {/* Só em leitura: em edição você está redigindo, e uma barra de decisões ali
                        convidaria a decidir no meio de uma frase. */}
                    <IdeaDocActions boardId={config.id} card={card} />
                    <DocRead model={readModel} />
                  </>
                ),
            },
          ]}
          markdown={{ read: markdownSource, write: applyMarkdown, epoch: editorEpoch }}
          mode={mode}
          outline={mode === "read"}
          onModeChange={(m) => {
            if (m === "read" && dirty) {
              toast("Salve ou descarte as mudanças antes de sair da edição.");
              return;
            }
            discard();
            setMode(m);
          }}
          exportMarkdown={() => serializeDocMd(readModel, { includeProperties: true, includeTitle: true })}
          dirty={dirty}
          saving={saving}
          onSave={save}
          onDiscard={discard}
        />
        </div>

        {!railVisible && <ChatDockGhost />}

        {/* O MESMO Explorador da bancada — mesma raia, mesmo histórico. Abrir uma ideia não começa uma conversa
            nova: só diz de qual delas estamos falando (o `focusId` no contexto). É a régua do Operador — o chat
            é por TELA, não por artefato — e é o que deixa ele comparar esta ideia com as outras sem trocar de
            conversa. O `getContext` re-resolve a cada turno, então o documento que ele lê é o salvo AGORA. */}
        <ChatDock
          mode={chatDockFor("ideias")}
          open={chatOpen}
          onClose={() => setSheetOpen(false)}
          label={chatSurfaceFor("ideias")?.label ?? "Explorador"}
        >
          <ViewChat
            boardId={config.id}
            view="ideias"
            context={chatContext ?? "Carregando a ideia…"}
            getContext={() => ideasChatContextAction(config.id, focused ? card.id : undefined)}
            // A MESMA saudação da bancada, de propósito. É a mesma conversa: reescrever a primeira fala a
            // cada navegação mentiria sobre o que foi dito — e, com transcript, ela nem apareceria. Quem
            // conta que esta ideia está em foco é o ANEXO abaixo, que descreve o presente.
            greeting={
              "Estou vendo a bancada inteira. Posso investigar uma ideia (ler o código, o board, buscar fora), " +
              "comparar duas, ou apontar o que falta numa delas. Por onde começamos?"
            }
            // O chip fica na tela nos DOIS estados: preso (o agente lê o documento) e solto (apagado, com
            // `+`). Some-lo ao soltar faria do gesto uma porta de mão única — só a recarga traria de volta,
            // e nada na tela diria isso.
            contextRefs={[
              {
                id: card.id,
                kind: "Ideia",
                label: card.title || card.id,
                icon: <Lightbulb className="h-3 w-3" />,
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
          Explorador
        </button>
      )}
    </div>
  );
}
