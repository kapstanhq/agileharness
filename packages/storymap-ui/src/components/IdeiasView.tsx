"use client";

// 🟩 Produto · Ideias — a LISTA do que ainda NÃO foi decidido (ADR-066). Uma Ideia é um card
// type:"idea" FORA do pipeline (sem status, sem gate, sem autorun): ela amadurece como documento
// até virar decisão — gerar as tarefas que a executam, ou ser descartada com motivo.
// Renderizada pelo <IdeaBlock> REUTILIZÁVEL (o mesmo bloco do HUB da captura), em variante "row".
// A lista tem SELEÇÃO + AÇÕES EM LOTE (<BatchActionBar>). Clicar uma linha abre o detalhe.
// A contagem de tarefas que endereçam (edge `addresses`) dá a rastreabilidade ideia→entrega.

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronRight, Lightbulb, Loader2, Plus, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { BoardHeader } from "@/components/BoardHeader";
import { PageHeader } from "@/components/nav/PageTabs";
import { ViewChat } from "@/components/ViewChat";
import { ChatDock, ChatDockGhost, useChatRailVisible } from "@/components/chat/ChatDock";
import { chatDockFor, chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { IdeaBlock } from "@/components/entity/IdeaBlock";
import { BatchActionBar, type BatchAction } from "@/components/entity/BatchActionBar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ToastProvider, useToast } from "@/components/Toast";
import { deleteCardAction } from "@/app/actions";
import { createIdeaAction, generateTasksForIdeaAction, ideasChatContextAction } from "@/app/idea-actions";
import { cardsAddressing, groupIdeasByStatus } from "@/lib/storymap/idea";
import { batchActionsFor, confirmFor } from "@/lib/storymap/entity-actions";
import { runBatch, toggleId } from "@/lib/storymap/selection";
import { formatIdeaTs, ideaTs } from "@/lib/storymap/idea-recency";
import type { Board, BoardSummary, Card } from "@/lib/storymap/types";

export function IdeiasView({
  board,
  boards,
  cards,
}: {
  board: Board;
  boards: BoardSummary[];
  cards: Card[];
}) {
  return (
    <ToastProvider>
      <IdeiasInner board={board} boards={boards} cards={cards} />
    </ToastProvider>
  );
}

function IdeiasInner({
  board,
  boards,
  cards,
}: {
  board: Board;
  boards: BoardSummary[];
  cards: Card[];
}) {
  const boardId = board.config.id;
  const router = useRouter();
  const toast = useToast();
  const ideas = cards.filter((c) => c.type === "idea");

  // `now` só existe após montar → o TIMESTAMP de cada linha (que depende do fuso) renderiza
  // client-side, evitando mismatch de hidratação (servidor em UTC ≠ navegador local). O agrupamento
  // não usa `now`: ele é por estado de exploração, e estado não tem fuso.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const groups = groupIdeasByStatus(ideas);
  // Encerradas (Decidida/Descartada) nascem FECHADAS: o que a bancada pede é o que está em aberto.
  // Estado local e não `?tab=` — abrir uma gaveta não é navegar.
  const [openTerminal, setOpenTerminal] = useState<Set<string>>(new Set());
  const toggleTerminal = (key: string) =>
    setOpenTerminal((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ── Seleção + lote ────────────────────────────────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [genId, setGenId] = useState<string | null>(null); // single async generate em andamento
  const [batchBusy, setBatchBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[] } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // A confirmação de GERAR — mesma forma da de excluir. Uma pergunta serve a linha (1 id) e ao lote (N).
  const [confirmGen, setConfirmGen] = useState<{ ids: string[] } | null>(null);

  // ── O Explorador (a conversa DESTA TELA) ──────────────────────────────────────────────────────
  // No desktop ele é ANCORADO: parte do layout, sempre aberto (ver ChatDock e o `dock: "rail"` da superfície).
  // No celular vira folha, e aí o botão do cabeçalho é o que a abre. `chatOpen` só governa a folha — o rail é
  // permanente por definição, e é por isso que ele nasce `true`.
  //
  // O contexto de abertura é buscado no mount; a cada turno o `getContext` do painel re-resolve fresco (a
  // bancada se move enquanto se conversa — inclusive por escrita do próprio agente).
  const railVisible = useChatRailVisible();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chatOpen = railVisible || sheetOpen;
  const [chatContext, setChatContext] = useState<string | null>(null);
  useEffect(() => {
    if (!chatOpen || chatContext !== null) return;
    let alive = true;
    void ideasChatContextAction(boardId)
      .then((c) => alive && setChatContext(c))
      .catch(() => alive && setChatContext("Não consegui ler a bancada de ideias."));
    return () => {
      alive = false;
    };
  }, [chatOpen, chatContext, boardId]);
  const selectionActive = selected.size > 0;
  const selectedCards = ideas.filter((o) => selected.has(o.id));

  const toggleSelect = (id: string) => setSelected((s) => toggleId(s, id, !s.has(id)));
  const clearSelection = () => setSelected(new Set());
  const selectAll = () => setSelected(new Set(ideas.map((o) => o.id)));

  // Single "gerar stories" da bancada = caminho ASSÍNCRONO próprio (→ proposta no Inbox).
  //
  // O clique só PERGUNTA (ver confirmGen); quem roda de verdade é o `runGenerate` abaixo, depois do "Gerar".
  // A ação custa um agente, minutos e tokens, e o alvo dela na linha fica a 24px do «Excluir» — foi assim que
  // um toque de raspão disparou uma captura inteira que ninguém queria.
  const runGenerate = async (id: string) => {
    if (genId || batchBusy) return;
    setGenId(id);
    const res = await generateTasksForIdeaAction({ boardId, cardId: id });
    setGenId(null);
    if (res.ok) {
      toast("Gerando as tarefas — a proposta vai aparecer no Inbox.", "success", {
        label: "Ver no Inbox",
        onClick: () => router.push(`/board/${boardId}/inbox`),
      });
      router.refresh();
    } else {
      toast(res.error, "error");
    }
  };

  const runBatchGenerate = async () => {
    const ids = [...selected];
    if (!ids.length || batchBusy) return;
    setBatchBusy(true);
    const { okIds, failed } = await runBatch(ids, (id) => generateTasksForIdeaAction({ boardId, cardId: id }));
    setBatchBusy(false);
    setSelected(new Set());
    router.refresh();
    toast(
      failed.length === 0
        ? `${okIds.length} ${okIds.length === 1 ? "ideia enviada" : "ideias enviadas"} para o Inbox.`
        : `${okIds.length} enviada(s); ${failed.length} falhou(ram).`,
      failed.length ? "error" : "success",
      failed.length
        ? undefined
        : { label: "Ver no Inbox", onClick: () => router.push(`/board/${boardId}/inbox`) },
    );
  };

  const runDelete = async () => {
    if (!confirmDelete || deleting) return;
    const ids = confirmDelete.ids;
    setDeleting(true);
    const { okIds, failed } = await runBatch(ids, (id) => deleteCardAction({ boardId, cardId: id }));
    setDeleting(false);
    setConfirmDelete(null);
    setSelected(new Set());
    router.refresh();
    toast(
      `${okIds.length} ${okIds.length === 1 ? "ideia excluída" : "ideias excluídas"}${failed.length ? `; ${failed.length} falhou(ram)` : ""}.`,
      failed.length ? "error" : "success",
    );
  };

  // Aviso de desvínculo: soma das stories que endereçam as dores prestes a serem excluídas.
  const deleteUnlinkWarn = confirmDelete
    ? confirmDelete.ids.reduce((sum, id) => {
        const o = ideas.find((c) => c.id === id);
        return sum + (o ? cardsAddressing(o, cards).length : 0);
      }, 0)
    : 0;

  // Ações de lote derivadas do registry declarativo (batchable + aplicável a TODAS as selecionadas).
  // As duas PERGUNTAM antes: o registry diz quais precisam de confirmação, e aqui ninguém decide de novo.
  const batchBarActions: BatchAction[] = batchActionsFor(selectedCards)
    .map((a): BatchAction | null => {
      if (a.id === "generate-stories")
        return {
          id: a.id,
          label: `Gerar tarefas (${selected.size})`,
          icon: a.icon,
          tone: a.tone,
          onRun: () => setConfirmGen({ ids: [...selected] }),
        };
      if (a.id === "delete")
        return { id: a.id, label: `Excluir (${selected.size})`, icon: a.icon, tone: a.tone, onRun: () => setConfirmDelete({ ids: [...selected] }) };
      return null;
    })
    .filter((a): a is BatchAction => a !== null);

  return (
    // Com o rail ancorado, a PÁGINA é dona do viewport e o CONTEÚDO é que rola — assim o composer do chat fica
    // parado no rodapé em vez de subir com a lista. Isto é decidido por CSS (`lg:`), não por `railVisible`,
    // embora as duas réguas sejam a MESMA largura: `railVisible` só fica verdadeiro DEPOIS do mount, e até lá o
    // contêiner ficaria com altura indefinida. Layout por CSS, montagem por JS.
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
      <BoardHeader boards={boards} config={board.config} view="ideias" subnav dockedChat={railVisible} />
      <div className="flex min-h-0 flex-1">
        <main
          className={cn(
            // `pb-24` é a folga da nav inferior do celular (h-14 + safe-area). Sem ela a última ideia
            // ficava ATRÁS da barra: esta tela não usa `.board-scroll`, que é quem dá essa folga de
            // graça — é o mesmo defeito que o contrato de Priorização guarda com um `toMatch(/pb-24/)`.
            // `md:px-6` como as irmãs: com `px-4` só, o título desta tela assentava 8px à esquerda das
            // outras três e a página deslizava de lado ao trocar de aba — o mesmo defeito da largura,
            // uma ordem de grandeza menor e por isso mais fácil de deixar passar (medido: 288 vs 296).
            "quiet-scroll mx-auto w-full max-w-4xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-8 lg:overflow-y-auto",
            selectionActive && "pb-28 md:pb-28",
          )}
        >
        {/* O MESMO cabeçalho das telas irmãs (`nav/PageHeader`) — o ícone tinha um `text-emerald-500`
            escolhido à mão, sem variante escura e diferente do próprio tom do bloco Produto. */}
        <PageHeader
          title="Ideias"
          icon={Lightbulb}
          description="O que ainda não foi decidido — uma funcionalidade cogitada, a suspeita de um defeito, uma dúvida técnica, um incômodo. Escreva livre, peça ao agente para investigar e ampliar, e só então decida: gerar as tarefas que executam a ideia, ou descartá-la dizendo por quê."
          actions={
            /* UMA conversa para a tela inteira (não uma por ideia): o Explorador enxerga todas e compara.
               Com o rail ancorado, este botão SOME: ele abriria o que já está na tela, e um botão que não muda
               nada é pior que nenhum. Ele volta a existir no celular, onde a conversa é folha. */
            railVisible ? null : (
              <button
                type="button"
                onClick={() => setSheetOpen((s) => !s)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition",
                  sheetOpen
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-line bg-surface text-fg-muted hover:bg-surface-hover hover:text-fg",
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Explorador
              </button>
            )
          }
        />
        <NewIdeaForm boardId={boardId} />

        {ideas.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-line bg-surface px-4 py-12 text-center text-sm text-fg-subtle">
            Nenhuma ideia ainda. Anote acima o que você ainda não decidiu — uma dúvida, uma intuição, um incômodo.
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {groups.map((g) => {
              // Encerrada = gaveta fechada por padrão. Aberta (ou grupo em aberto) = lista à mostra.
              const collapsed = g.terminal && !openTerminal.has(g.key);
              const list = (
                <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                  {g.items.map((o) => (
                    <li key={o.id}>
                      <IdeaBlock
                        idea={o}
                        pool={cards}
                        variant="row"
                        selectable
                        selected={selected.has(o.id)}
                        selectionActive={selectionActive}
                        onToggleSelect={() => toggleSelect(o.id)}
                        ts={now !== null ? formatIdeaTs(ideaTs(o), now) : null}
                        handlers={{
                          // As DUAS só perguntam. O «Gerar» da linha vive a 24px do «Excluir» — o clique
                          // de raspão que ele custava era o defeito, não o clique certo.
                          "generate-stories": { run: () => setConfirmGen({ ids: [o.id] }), busy: genId === o.id, disabled: batchBusy },
                          delete: { run: () => setConfirmDelete({ ids: [o.id] }) },
                        }}
                        // ADR-066: abrir uma Ideia é abrir o DOCUMENTO dela, não um modal de cinco
                        // campos — a exploração precisa da tela inteira. O modal continua existindo
                        // para a edição rápida a partir do HUB da captura.
                        onOpen={() => router.push(`/board/${boardId}/ideia/${o.id}`)}
                      />
                    </li>
                  ))}
                </ul>
              );
              return (
                <section key={g.key}>
                  {g.label &&
                    (g.terminal ? (
                      <button
                        type="button"
                        onClick={() => toggleTerminal(g.key)}
                        aria-expanded={!collapsed}
                        title={g.hint}
                        className="mb-1.5 flex w-full items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle transition hover:text-fg-muted"
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
                        />
                        <GroupDot color={g.color} />
                        {g.label} <span className="text-fg-subtle/60">· {g.items.length}</span>
                      </button>
                    ) : (
                      <h2
                        title={g.hint}
                        className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
                      >
                        <GroupDot color={g.color} />
                        {g.label} <span className="text-fg-subtle/60">· {g.items.length}</span>
                      </h2>
                    ))}
                  {!collapsed && list}
                </section>
              );
            })}
          </div>
        )}
        </main>

        {/* Antes do rail existir, o LUGAR dele — reservado por CSS para a página não "assentar" a cada visita. */}
        {!railVisible && <ChatDockGhost />}

        {/* O Explorador. Ancorado no desktop (parte do layout, sem X — painel permanente não fecha); folha no
            celular. Ele NUNCA cobre o topnav: quem garante isso é o ChatDock. */}
        <ChatDock
          mode={chatDockFor("ideias")}
          open={chatOpen}
          onClose={() => setSheetOpen(false)}
          label={chatSurfaceFor("ideias")?.label ?? "Explorador"}
        >
          <ViewChat
            boardId={boardId}
            view="ideias"
            context={chatContext ?? "Carregando a bancada de ideias…"}
            getContext={() => ideasChatContextAction(boardId)}
            greeting={
              "Estou vendo a bancada inteira. Posso investigar uma ideia (ler o código, o board, buscar fora), " +
              "comparar duas, ou apontar o que falta numa delas. Por onde começamos?"
            }
            onClose={railVisible ? undefined : () => setSheetOpen(false)}
          />
        </ChatDock>
      </div>

      {/* Barra de lote — fixa no fundo da viewport. No mobile fica ACIMA da nav inferior (h-14, md:hidden). */}
      {selectionActive && (
        <div className="fixed inset-x-0 bottom-14 z-40 md:bottom-0">
          <div className="mx-auto max-w-4xl shadow-[0_-1px_12px_rgba(0,0,0,0.06)]">
            <BatchActionBar
              count={selected.size}
              total={ideas.length}
              onSelectAll={selectAll}
              onClear={clearSelection}
              actions={batchBarActions}
              busy={batchBusy}
            />
          </div>
        </div>
      )}

      {/* GERAR TAREFAS — a mesma pergunta da exclusão, com a cópia vinda do catálogo (entity-actions). Ela
          serve a linha e o lote: o que muda é só quantos ids estão na mão. */}
      {confirmGen &&
        (() => {
          const c = confirmFor("generate-stories", confirmGen.ids.length)!;
          const ids = confirmGen.ids;
          return (
            <ConfirmDialog
              title={c.title}
              description={c.description}
              confirmLabel={genId || batchBusy ? "Gerando…" : c.confirmLabel}
              confirmDisabled={Boolean(genId) || batchBusy}
              tone={c.tone}
              onCancel={() => setConfirmGen(null)}
              onConfirm={() => {
                setConfirmGen(null);
                // Uma ideia usa o caminho single (que acende o spinner NA LINHA); N usam o de lote.
                if (ids.length === 1) void runGenerate(ids[0]);
                else void runBatchGenerate();
              }}
            />
          );
        })()}

      {confirmDelete && (
        <ConfirmDialog
          title={confirmDelete.ids.length === 1 ? "Excluir ideia?" : `Excluir ${confirmDelete.ids.length} ideias?`}
          description={
            deleteUnlinkWarn > 0
              ? `${deleteUnlinkWarn} story(ies) perderão o vínculo com a dor. Vai para a lixeira do board — recuperável por 7 dias.`
              : "Vai para a lixeira do board — recuperável por 7 dias."
          }
          confirmLabel={deleting ? "Excluindo…" : "Excluir"}
          tone="danger"
          confirmDisabled={deleting}
          onConfirm={runDelete}
          onCancel={() => {
            if (!deleting) setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

/** O pontinho de estado do cabeçalho de grupo — a MESMA cor que `IdeaBlock` pinta na linha, vinda de
 *  `IDEA_STATUSES` (não uma paleta paralela: o grupo e as linhas dentro dele têm de bater). */
function GroupDot({ color }: { color: string }) {
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function NewIdeaForm({ boardId }: { boardId: string }) {
  const router = useRouter();
  // `?nova=1` — o destino do "Criar ▾ → Ideia" do topnav: chegar na página já com o campo aberto e o
  // cursor dentro dele. Sem isto o menu prometia "anotar uma ideia" e entregava uma lista, cobrando
  // mais um clique exatamente no momento em que a ideia ainda é volátil.
  const search = useSearchParams();
  const [open, setOpen] = useState(search.get("nova") === "1");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Criar = NOMEAR e entrar. Antes eram duas caixas (enunciado + evidência) que devolviam você para a
  // lista — a ideia nascia num formulário e o documento ficava a mais um clique de distância, o que
  // contradizia o ADR-066 (o documento É a ideia; o formulário é atalho). Agora o único campo é o
  // nome, e o resto — enunciado, evidência, caminhos — se escreve dentro do documento, que abre já em
  // modo de edição com a caixa do enunciado aberta (`scaffold`).
  const create = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    const res = await createIdeaAction({ boardId, title: t });
    if (res.ok && res.data) {
      router.push(`/board/${boardId}/ideia/${res.data.card.id}?editar=1`);
      return; // segue ocupado até a navegação: nada de piscar o campo vazio de volta
    }
    setBusy(false);
    setError(res.ok ? "A ideia foi criada, mas não consegui abri-la." : res.error);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
      >
        <Plus className="h-4 w-4" /> Nova ideia
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <div className="space-y-1">
        <label className="text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Nome da ideia</label>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") { setOpen(false); setError(null); }
          }}
          placeholder="Ex.: o operador não consegue dirigir o sistema top-down"
          className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] leading-relaxed text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent"
        />
        <p className="text-[11px] text-fg-subtle">
          O resto você escreve dentro dela — vamos abrir o documento em seguida.
        </p>
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 leading-snug">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0 opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={create}
          disabled={busy || !title.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-[12px] font-semibold text-primary-fg transition hover:bg-primary-hover disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {busy ? "Abrindo…" : "Criar e escrever"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:bg-surface-hover disabled:opacity-50"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

