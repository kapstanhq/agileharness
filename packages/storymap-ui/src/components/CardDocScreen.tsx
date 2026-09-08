"use client";

// CardDocScreen — o card como PÁGINA (`/board/[b]/card/[id]`). Desde a aposentadoria do
// CardEditorDrawer, esta é a ÚNICA superfície de detalhe de card do app: todo clique em card, de
// qualquer tela (Kanban, Mapa, Inbox, Priorização), chega aqui, e o Voltar devolve à tela de origem
// real (BackButton → useHistoryBack; o `backHref` é só a rede para quem abriu num link direto).
//
// TRÊS VISÕES da mesma verdade, e cada campo tem UMA delas:
//   · Documento — título, narrativa (leitura), critérios de aceite, corpo, e os blocos projetados
//                 (canvas de design, bloqueios, histórico, trajeto) via <CardDocument>
//   · Markdown  — a fonte canônica do mesmo documento, editável (md-codec)
//   · Campos    — o que o documento NÃO sabe dizer: classificação, narrativa (escrita), lugar,
//                 vocabulário, tasks, prioridade, rota, links (<CardFields>)
// As três dividem UM rascunho, UMA barra de alterações e UM save — era isso que o drawer, sendo uma
// superfície paralela com estado próprio, não conseguia oferecer.
//
// As AÇÕES do card (mover, sincronizar, refinar, reportar bug, descontinuar, excluir) vivem no
// sub-topnav: "Mover para" como ação primária, o resto no menu "…".
//
// Guards de escrita (herdados do drawer, sem mudança): `expectedStatus` = o status de quando a
// página abriu (anti-revert do avanço da cascata) e `expectedBody` = o corpo de quando abriu
// (anti-clobber contra MCP/autorun), renovado a cada save bem-sucedido.

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Archive, Bug, FileText, RefreshCw, SlidersHorizontal, Trash2, Wand2 } from "lucide-react";
import { cardHref } from "@/lib/storymap/deep-links";
import { BoardHeader } from "@/components/BoardHeader";
import { CardDocument } from "@/components/CardDocument";
import { DocShell, type DocMenuItem } from "@/components/doc/DocShell";
import { DocEditor } from "@/components/doc/DocEditor";
import { DocTitle } from "@/components/doc/DocTitle";
import { CardFields } from "@/components/card/CardFields";
import { CardMoveMenu } from "@/components/card/CardMoveMenu";
import { ConfirmDialog, MovePreview } from "@/components/ConfirmDialog";
import { RefineModal } from "@/components/RefineModal";
import { BugModal } from "@/components/BugModal";
import { DiscontinueModal } from "@/components/DiscontinueModal";
import { deleteCardAction, syncCardAction, updateCardAction } from "@/app/actions";
import {
  CARD_ALLOWED_BLOCKS,
  CARD_DOC_TYPE,
  commitCardDoc,
  projectCardDoc,
} from "@/lib/storymap/doc/card-doc";
import { reattachBindings, reattachSections, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { parseDocMd, serializeDocMd } from "@/lib/storymap/doc/md-codec";
import { moveTargets } from "@/lib/storymap/move-targets";
import { isReopenableStatus } from "@/lib/storymap/reopen";
import type { Board, BoardConfig, BoardSummary, Card } from "@/lib/storymap/types";
import { useToast } from "@/components/Toast";

/** "Descontinuar" pode sair de QUALQUER status — menos de dentro do próprio fluxo de retirada. */
const RETIRE_FLOW_STATUSES = new Set(["descontinuar", "arquivados"]);

export const CAMPOS_VIEW_ID = "campos";

export function CardDocScreen({
  board,
  boards,
  card,
  strategy,
}: {
  board: Board;
  boards: BoardSummary[];
  card: Card;
  /** O norte do produto (digest do PRD), resolvido pela página. */
  strategy: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const [config, setConfig] = useState<BoardConfig>(board.config);

  const [draft, setDraft] = useState<Card>(card);
  const [baselineStatus] = useState<string | null>(card.status ?? null);
  const [baselineBody, setBaselineBody] = useState<string>(card.body);
  const [docTouched, setDocTouched] = useState(false);
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Visão vinda do link (`?view=campos`): quem manda alguém "definir o lugar" (o toast de movimento
  // recusado do Kanban) precisa aterrissar NO formulário, não na leitura. Com o param, a visão passa
  // a ser controlada por esta tela; sem ele, o shell resolve pela preferência salva.
  const [viewOverride, setViewOverride] = useState<string | null>(params.get("view"));

  // Ações que abrem um diálogo próprio.
  const [refining, setRefining] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [discontinuing, setDiscontinuing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ statusId: string; statusName: string; color: string } | null>(null);

  const deps = useMemo(
    () => ({
      personas: config.personas,
      statusName: config.statuses.find((s) => s.id === card.status)?.name ?? card.status,
    }),
    [config, card.status],
  );
  const readModel = useMemo(() => projectCardDoc(card, deps), [card, deps]);
  const editModel = useMemo(
    () => (mode === "edit" ? projectCardDoc(draft, deps) : null),
    // Captura na ENTRADA da edição (epoch reinicia no descarte) — re-projetar a cada onChange
    // remontaria o editor e perderia o cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, editorEpoch],
  );

  // Dirty CAMPO A CAMPO (nunca um JSON.stringify do card inteiro: a ordem das chaves muda com um
  // spread e acusaria "mudou" sem mudança, gravando por nada).
  const fieldsChanged =
    draft.type !== card.type ||
    (draft.status ?? null) !== (card.status ?? null) ||
    (draft.storyType ?? null) !== (card.storyType ?? null) ||
    (draft.parent ?? null) !== (card.parent ?? null) ||
    (draft.release ?? null) !== (card.release ?? null) ||
    (draft.serves ?? null) !== (card.serves ?? null) ||
    (draft.kano ?? null) !== (card.kano ?? null) ||
    (draft.funnelStage ?? null) !== (card.funnelStage ?? null) ||
    JSON.stringify(draft.narrative) !== JSON.stringify(card.narrative) ||
    JSON.stringify(draft.personas) !== JSON.stringify(card.personas) ||
    JSON.stringify(draft.systems) !== JSON.stringify(card.systems) ||
    JSON.stringify(draft.tasks) !== JSON.stringify(card.tasks) ||
    JSON.stringify(draft.rice) !== JSON.stringify(card.rice) ||
    JSON.stringify(draft.links) !== JSON.stringify(card.links);

  const dirty =
    docTouched ||
    draft.title !== card.title ||
    draft.body !== card.body ||
    JSON.stringify(draft.acceptance) !== JSON.stringify(card.acceptance) ||
    fieldsChanged;

  const handleDocChange = (blocks: DocBlock[]) => {
    if (!editModel) return;
    setDocTouched(true);
    setDraft((d) =>
      commitCardDoc(
        { docType: CARD_DOC_TYPE, title: d.title, blocks: reattachBindings(blocks, editModel.blocks) },
        d,
      ).card,
    );
  };

  const discard = () => {
    setDraft(card);
    setDocTouched(false);
    setEditorEpoch((e) => e + 1);
  };

  // ── o card em markdown cru ─────────────────────────────────────────────────────────────────────
  // A fonte é o documento EDITÁVEL do card (a mesma projeção do editor rico: narrativa + aceite +
  // corpo), não o documento composto da leitura — plano, telas e histórico são projeções read-only,
  // e oferecer para editar o que não tem caminho de volta seria mentir sobre o que o Salvar faz.
  const markdownSource = () => serializeDocMd(projectCardDoc(draft, deps), { includeTitle: true });

  const applyMarkdown = (markdown: string) => {
    const base = projectCardDoc(draft, deps);
    const parsed = parseDocMd(markdown, { docType: CARD_DOC_TYPE, stripTitle: true });
    const blocks = reattachSections(reattachBindings(parsed.blocks, base.blocks), base.blocks);
    setDocTouched(true);
    setDraft((d) => commitCardDoc({ docType: CARD_DOC_TYPE, title: parsed.title || d.title, blocks }, d).card);
  };

  const persist = async (next: Card): Promise<boolean> => {
    setSaving(true);
    const res = await updateCardAction({
      boardId: config.id,
      card: next,
      expectedStatus: baselineStatus,
      ...(docTouched ? { expectedBody: baselineBody } : {}),
    });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      router.refresh();
      return false;
    }
    const saved = res.data?.card ?? next;
    setDraft(saved);
    setBaselineBody(saved.body);
    setDocTouched(false);
    router.refresh();
    return true;
  };

  const save = async () => {
    if (!dirty) return;
    if (await persist(draft)) setMode("read");
  };

  // Mover: persiste o rascunho INTEIRO com o novo status (para não perder edição não salva), com o
  // gate conferido no servidor.
  const moveTo = async (statusId: string) => {
    await persist({ ...draft, status: statusId });
  };

  const sync = async () => {
    setSyncing(true);
    const res = await syncCardAction({ boardId: config.id, cardId: card.id });
    setSyncing(false);
    if (res.ok) toast("Sincronizando este card com o código — acompanhe no console do card (🖥).", "success");
    else toast(res.error);
  };

  const doDelete = async () => {
    const res = await deleteCardAction({ boardId: config.id, cardId: card.id });
    if (res.ok) router.push(`/board/${config.id}/kanban`);
    else toast(res.error);
  };

  /**
   * Um diálogo (refinar / reportar bug / descontinuar) grava o card DIRETO no servidor e devolve o
   * card novo. Re-semear o rascunho com ele é obrigatório: sem isso o `draft` seguiria com o status
   * anterior (o `useState` inicial não re-lê a prop quando o RSC recarrega), e o próximo Salvar
   * mandaria de volta um card já superado.
   */
  const adoptSaved = (saved: Card) => {
    setDraft(saved);
    setBaselineBody(saved.body);
    setDocTouched(false);
    router.refresh();
  };

  const isStory = card.type === "story";
  const moves = isStory ? moveTargets(draft, config) : [];
  const currentStatus = config.statuses.find((s) => s.id === draft.status);
  const reopenable = isReopenableStatus(card);
  const retirable = isStory && card.status != null && !RETIRE_FLOW_STATUSES.has(card.status);

  const menuItems: DocMenuItem[] = [
    {
      key: "sync",
      icon: RefreshCw,
      label: syncing ? "Sincronizando…" : "Sincronizar",
      hint: "Revisa o card vs. o código real e o reposiciona",
      disabled: syncing,
      onClick: sync,
    },
    ...(reopenable
      ? [
          {
            key: "refine",
            icon: Wand2,
            label: "Refinar",
            hint: "Reabrir para melhoria (UI / UX / copy / funcionalidade)",
            onClick: () => setRefining(true),
          } as DocMenuItem,
          {
            key: "bug",
            icon: Bug,
            label: "Reportar bug",
            hint: "Reabrir para corrigir uma regressão (com teste)",
            onClick: () => setReporting(true),
          } as DocMenuItem,
        ]
      : []),
    { key: "div-danger", divider: true },
    ...(retirable
      ? [
          {
            key: "retire",
            icon: Archive,
            label: "Descontinuar",
            hint: "Tira a feature do app (desativar ↔ excluir) e arquiva o card",
            danger: true,
            onClick: () => setDiscontinuing(true),
          } as DocMenuItem,
        ]
      : []),
    {
      key: "delete",
      icon: Trash2,
      label: "Excluir card",
      hint: "Apaga o registro do board — não a feature. Use Descontinuar p/ isso.",
      danger: true,
      onClick: () => setConfirmDelete(true),
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {/* Página de DETALHE: sem a segunda barra (as abas Kanban/Métricas/… da seção). O que nomeia e
          controla esta tela é a barra do documento logo abaixo (voltar + título + ações) — duas
          barras empilhadas roubavam altura e diziam a mesma coisa duas vezes.

          `view="card"` e não `"kanban"`: esta tela é o detalhe de UM card, alcançada de QUALQUER
          seção (Kanban, Mapa, Inbox, Priorização). Declarando-se Kanban ela acendia o bloco
          **Software** no centro da barra — abrir uma story do Mapa fazia o realce saltar de Produto
          para Software, dizendo que você tinha trocado de seção sem ter trocado. `card` é
          transversal (não mora em grupo nenhum, como `processes`), então nenhum bloco acende. O
          `backHref` abaixo segue no Kanban de propósito: ele é só a rede do link direto — quem
          chegou navegando volta à tela real pelo `useHistoryBack` do BackButton. */}
      <BoardHeader boards={boards} config={config} view="card" subnav={false} />
      <div className="min-h-0 flex-1">
        <DocShell
          docType={CARD_DOC_TYPE}
          title={draft.title || card.id}
          backHref={`/board/${config.id}/kanban`}
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
                      placeholder="Título"
                    />
                    <DocEditor
                      key={`card-page-edit-${card.id}-${editorEpoch}`}
                      model={editModel}
                      allowedBlocks={CARD_ALLOWED_BLOCKS}
                      onChange={handleDocChange}
                    />
                  </div>
                ) : (
                  // O documento COMPLETO — a mesma montagem de blocos que o board projeta (faixa de
                  // status, canvas de design, bloqueios, histórico, trajeto). Um scroll só; a trilha
                  // do DocShell navega por âncora.
                  <CardDocument boardId={config.id} card={card} config={config} cards={board.cards} strategy={strategy} />
                ),
            },
            {
              id: CAMPOS_VIEW_ID,
              label: "Campos",
              icon: SlidersHorizontal,
              render: () => (
                <CardFields
                  boardId={config.id}
                  config={config}
                  cards={board.cards}
                  card={card}
                  draft={draft}
                  onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                  onConfigChanged={setConfig}
                  onSaved={(saved) => {
                    setDraft(saved);
                    router.refresh();
                  }}
                  onOpenCard={(id) => router.push(cardHref(config.id, id))}
                />
              ),
            },
          ]}
          markdown={{ read: markdownSource, write: applyMarkdown, epoch: editorEpoch }}
          viewId={viewOverride ?? undefined}
          onViewChange={viewOverride ? setViewOverride : undefined}
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
          toolbarExtra={
            <CardMoveMenu
              targets={moves}
              disabled={saving}
              onPick={(s) =>
                setPendingMove({ statusId: s.id, statusName: s.name, color: s.color ?? "#94a3b8" })
              }
            />
          }
          menuItems={menuItems}
          exportMarkdown={() => serializeDocMd(readModel, { includeProperties: true, includeTitle: true })}
          dirty={dirty}
          saving={saving}
          onSave={save}
          onDiscard={discard}
        />
      </div>

      {refining && (
        <RefineModal
          boardId={config.id}
          statuses={config.statuses}
          card={card}
          onCancel={() => setRefining(false)}
          onDone={(saved) => {
            setRefining(false);
            adoptSaved(saved);
          }}
        />
      )}
      {reporting && (
        <BugModal
          boardId={config.id}
          statuses={config.statuses}
          card={card}
          onCancel={() => setReporting(false)}
          onDone={(saved) => {
            setReporting(false);
            adoptSaved(saved);
          }}
        />
      )}
      {discontinuing && (
        <DiscontinueModal
          boardId={config.id}
          card={card}
          onCancel={() => setDiscontinuing(false)}
          onDone={(saved) => {
            setDiscontinuing(false);
            adoptSaved(saved);
          }}
        />
      )}
      {pendingMove && (
        <ConfirmDialog
          title="Mover card"
          description={draft.title || card.id}
          confirmLabel="Mover"
          onCancel={() => setPendingMove(null)}
          onConfirm={() => {
            const { statusId } = pendingMove;
            setPendingMove(null);
            void moveTo(statusId);
          }}
        >
          <MovePreview
            fromName={currentStatus?.name ?? "Sem status"}
            fromColor={currentStatus?.color ?? "#94a3b8"}
            toName={pendingMove.statusName}
            toColor={pendingMove.color}
          />
        </ConfirmDialog>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Excluir card"
          description={`“${draft.title || card.id}” será removido do board, e os links/pais que apontam para ele serão limpos. Isso apaga o registro de planejamento — para tirar a feature do app preservando o histórico, use Descontinuar.`}
          confirmLabel="Excluir"
          tone="danger"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void doDelete();
          }}
        />
      )}
    </div>
  );
}
