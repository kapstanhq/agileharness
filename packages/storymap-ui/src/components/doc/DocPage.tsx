"use client";

// 📄 DocPage — a PÁGINA de um documento do board (fase 2): Negócio (o Business Model Canvas), Produto (o PRD) e,
// pela mesma casca, Design (o guia de estilo, em design/DesignScreen).
//
// Uma casca só, e simples de propósito: a barra do topo; abaixo, o TÍTULO do documento, UMA linha de estado
// («Salvo», «Alterações não salvas», o que impede de salvar, em linguagem simples) e UM botão Editar/Salvar; depois,
// o conteúdo. Não há trocador de views (documento/markdown/tabela/quadro): cada documento tem a SUA vista fixa —
// o canvas é um quadro, o PRD e o guia são documentos — e o modo de edição dela. A conversa da página é o
// compositor do rodapé, falando com o assistente DO documento (`BoardHeader.chatSurface`), e não um trilho lateral.
//
// O que a página NÃO decide: onde os bytes moram. Toda mutação passa pelas funções PURAS do codec e só
// `saveDocAction` toca o disco (no guia, `applyStyleGuideAssistAction`).

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Inbox, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { aboveComposer, composerGutter } from "@/lib/ui";
import { BoardHeader } from "@/components/BoardHeader";
import { DocRead } from "@/components/doc/DocRead";
import { DocEditor } from "@/components/doc/DocEditor";
import { BoardView as DocBoardView } from "@/components/doc/views/BoardView";
import { SmartCaptureModal } from "@/components/SmartCaptureModal";
import { ToastProvider, useToast } from "@/components/Toast";
import { docChatContextAction, saveDocAction } from "@/app/doc-actions";
import { docProposalHeadline, type DocProposalNotice } from "@/components/inbox/cockpit-labels";
import { chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { docEntry } from "@/lib/storymap/doc/doc-registry";
import { allowedBlocksFor } from "@/lib/storymap/doc/view-contracts";
import { collectSchemaDoc, parseSchemaBody, schemaDocToModel, serializeSchemaDoc, type SchemaDoc } from "@/lib/storymap/doc/schema-codec";
import type { SchemaViolation } from "@/lib/storymap/doc/doc-schema";
import type { JidoDocSurface } from "@/components/chat/JidoComposer";
import { docPageLayout, docStatusLine, isSchemaDocEmpty, readModelWithHints } from "@/components/doc/doc-page";
import { DOC } from "@/components/doc/typography";
import { openJidoChat } from "@/components/chat/jido-bus";
import type { BoardView } from "@/components/nav/nav-groups";
import type { Board, BoardSummary } from "@/lib/storymap/types";

// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DocPageShellProps {
  boards: BoardSummary[];
  board: Board;
  view: BoardView;
  title: string;
  /** a linha de estado; `tone` decide a cor (erro em vermelho). */
  status: string;
  statusTone?: "ok" | "error";
  editing: boolean;
  /** há alteração por salvar (acende o lembrete acima do compositor). */
  dirty: boolean;
  saving: boolean;
  /** Salvar recusado agora (há problema que impede). O botão continua clicável: o clique diz por quê. */
  saveBlocked?: boolean;
  /** false ⇒ não há o que editar à mão (o guia ainda vazio): o botão Editar some. */
  canEdit?: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  /** o que vem logo abaixo do título (proposta pendente, a lista de problemas). */
  notices?: ReactNode;
  /** a largura da coluna: o quadro usa a tela; o documento, a medida de leitura. */
  wide?: boolean;
  chatSurface?: JidoDocSurface;
  /** `/criar` do compositor nesta página (o PRD semeia a captura com o que ele diz construir). */
  onCapture?: (initialText?: string) => void;
  /** camada sobreposta controlada pela página (um modal). */
  overlay?: ReactNode;
  children: ReactNode;
}

export function DocPageShell({
  boards,
  board,
  view,
  title,
  status,
  statusTone = "ok",
  editing,
  dirty,
  saving,
  saveBlocked,
  canEdit = true,
  onEdit,
  onSave,
  onCancel,
  notices,
  wide,
  chatSurface,
  onCapture,
  overlay,
  children,
}: DocPageShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <BoardHeader boards={boards} config={board.config} view={view} chatSurface={chatSurface} onSmartCapture={onCapture} />
      <main className={cn("mx-auto w-full min-w-0 flex-1 px-4 pt-6 sm:px-8 sm:pt-8", wide ? "max-w-[1280px]" : "max-w-[820px]", composerGutter)}>
        <header className="mb-5 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* o título da PÁGINA é o degrau de cima da escala (typography.ts): acima das seções (DOC.h1) do PRD e do guia */}
            <h1 className={cn("text-fg-strong", DOC.title)}>{title}</h1>
            <p
              role="status"
              aria-live="polite"
              className={cn("mt-1 text-[13px] leading-snug", statusTone === "error" ? "text-danger" : "text-fg-muted")}
            >
              {status}
            </p>
          </div>
          {/* UM botão: Editar ⇄ Salvar. Cancelar só existe enquanto se edita. Alvos de 40px no celular. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {editing && (
              <button
                type="button"
                onClick={onCancel}
                disabled={saving}
                className="h-10 rounded-lg px-3 text-[13px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg disabled:opacity-50 md:h-8"
              >
                Cancelar
              </button>
            )}
            {(editing || canEdit) && (
            <button
              type="button"
              onClick={editing ? onSave : onEdit}
              disabled={saving}
              aria-disabled={editing && saveBlocked ? true : undefined}
              title={editing && saveBlocked ? "Corrija o que está marcado antes de salvar" : undefined}
              className={cn(
                "h-10 rounded-lg px-4 text-[13px] font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg disabled:opacity-60 md:h-8",
                // Salvar só é o botão PRINCIPAL quando há o que salvar: «nada mudou ainda» com um botão cheio pedia um
                // clique que não faz nada
                editing && dirty
                  ? saveBlocked
                    ? "bg-line-emphasis text-fg-muted"
                    : "bg-fg text-canvas hover:bg-fg/85"
                  : "border border-line bg-surface text-fg hover:bg-surface-hover",
              )}
            >
              {editing ? (saving ? "Salvando…" : "Salvar") : "Editar"}
            </button>
            )}
          </div>
        </header>
        {notices}
        {children}
      </main>
      {/* Uma faixa fina acima do compositor enquanto há alteração por salvar: quem rolou o documento até o fim não
          precisa subir para lembrar que falta salvar. */}
      {editing && dirty && (
        <div className={cn("pointer-events-none sticky z-20 flex justify-center pb-2", aboveComposer)}>
          <span className="rounded-full bg-fg px-3 py-1 text-[12px] font-medium text-canvas shadow-sm">Alterações não salvas</span>
        </div>
      )}
      {overlay}
    </div>
  );
}

/** As propostas pendentes para este documento: a versão aprovada é a da tela, a nova espera no Inbox. */
export function DocProposalNoticeBar({ proposals }: { proposals: DocProposalNotice[] }) {
  if (!proposals.length) return null;
  return (
    <section
      aria-label="Proposta pendente"
      data-doc-proposals={proposals.length}
      className="mb-4 flex items-start gap-2 rounded-lg border border-accent/40 bg-accent/[0.06] px-3 py-2.5 text-[13px]"
    >
      <Inbox className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-medium leading-snug text-fg">{docProposalHeadline(proposals.length)}</p>
        <ul className="space-y-1.5">
          {proposals.map((p) => (
            <li key={p.draftId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-0 flex-1 text-[12px] leading-snug text-fg-muted">{p.detail}</span>
              <Link
                href={p.href}
                className="inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-fg transition hover:bg-primary-hover md:h-7"
              >
                Ver e aprovar
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** O que o documento tem de errado, em lista curta: erros (recusam o salvamento) antes dos avisos. */
function ViolationList({ violations }: { violations: SchemaViolation[] }) {
  if (!violations.length) return null;
  const list = [...violations.filter((v) => v.severity === "error"), ...violations.filter((v) => v.severity !== "error")];
  const hasError = list[0]?.severity === "error";
  return (
    <ul
      className={cn(
        "mb-4 space-y-0.5 rounded-lg border px-3 py-2.5 text-[13px] leading-snug",
        hasError ? "border-danger/30 bg-danger/[0.06] text-danger" : "border-line bg-inset/60 text-fg-muted",
      )}
    >
      {list.slice(0, 6).map((v, i) => (
        <li key={i}>{v.message}</li>
      ))}
      {list.length > 6 && <li className="text-fg-subtle">e mais {list.length - 6}…</li>}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SchemaDocPageProps {
  board: Board;
  boards: BoardSummary[];
  /** o docType registrado (`doc-registry`) — dele saem o schema, o rótulo e a vista. */
  docType: string;
  /** a página (rota, seletor de grupo e raia da conversa). */
  view: BoardView;
  initialDoc: SchemaDoc;
  initialViolations: SchemaViolation[];
  pendingProposals?: DocProposalNotice[];
  /**
   * O PRD: o recorte que descreve O QUE construir, resolvido no servidor. `/criar` sem texto nesta página abre a
   * captura semeada com ele (propor → revisar → aplicar), em vez de um botão a mais na página.
   */
  backlogSeed?: string;
}

/** A página de um documento de SCHEMA (o canvas, o PRD). Com o PRÓPRIO provedor de avisos: sem ele o `toast` cai no
 *  contexto vazio e uma recusa de salvar sumiria calada. */
export function SchemaDocPage(props: SchemaDocPageProps) {
  return (
    <ToastProvider>
      <SchemaDocPageInner {...props} />
    </ToastProvider>
  );
}

function SchemaDocPageInner({
  board,
  boards,
  docType,
  view,
  initialDoc,
  initialViolations,
  pendingProposals = [],
  backlogSeed,
}: SchemaDocPageProps) {
  const router = useRouter();
  const toast = useToast();
  const config = board.config;
  const entry = docEntry(docType);
  const schema = entry?.schema;

  const [saved, setSaved] = useState<SchemaDoc>(initialDoc);
  const [draft, setDraft] = useState<SchemaDoc>(initialDoc);
  const [editing, setEditing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [violations, setViolations] = useState<SchemaViolation[]>(initialViolations);
  const [capture, setCapture] = useState<{ initialText?: string } | null>(null);

  const dirty = useMemo(
    () => (schema ? serializeSchemaDoc(draft, schema) !== serializeSchemaDoc(saved, schema) : false),
    [draft, saved, schema],
  );
  // Sem o título do modelo: o da PÁGINA (a casca) já nomeia o documento — repeti-lo no corpo dizia "PRD" duas vezes.
  // Uma seção vazia mostra a DICA do schema como legenda discreta (o BMC já mostrava; o PRD mostrava só o título).
  const readModel = useMemo(() => (schema ? { ...readModelWithHints(saved, schema), title: "" } : null), [saved, schema]);
  const empty = useMemo(() => isSchemaDocEmpty(saved), [saved]);
  // Capturado quando a EDIÇÃO começa (o epoch reabre): enquanto montado, o editor é dono da superfície —
  // re-semear a cada tecla brigaria com o cursor.
  const editModel = useMemo(
    () => (editing && schema ? schemaDocToModel(draft, schema) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, epoch],
  );

  const surface = chatSurfaceFor(view);
  const chatSurface: JidoDocSurface | undefined = surface
    ? { view: surface.view, label: surface.label, getContext: () => docChatContextAction(config.id, docType), empty: isSchemaDocEmpty(saved) }
    : undefined;

  if (!schema || !entry) return null;

  const errors = violations.filter((v) => v.severity === "error");

  /** Toda mutação passa por aqui: revalida contra o schema para a linha de estado saber o que dizer. */
  const apply = (next: SchemaDoc) => {
    setDraft(next);
    const md = serializeSchemaDoc(next, schema);
    setViolations(parseSchemaBody(stripFrontmatter(md), schema, next.frontmatter).violations);
  };

  const cancel = () => {
    setDraft(saved);
    setViolations(initialViolations);
    setEpoch((e) => e + 1);
    setEditing(false);
  };

  const save = async () => {
    if (!dirty) {
      setEditing(false);
      return;
    }
    if (errors.length) {
      toast("Corrija o que está marcado antes de salvar.");
      return;
    }
    setSaving(true);
    const res = await saveDocAction({ boardId: config.id, docType, doc: draft });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      if (res.violations?.length) setViolations(res.violations);
      return;
    }
    setSaved(draft);
    setEditing(false);
    router.refresh();
  };

  const layout = docPageLayout(docType);
  const content =
    layout === "quadro" ? (
      // O quadro edita no lugar (as notas viram campo); fora da edição ele é só leitura.
      <DocBoardView doc={editing ? draft : saved} schema={schema} onChange={editing ? apply : undefined} />
    ) : editing && editModel ? (
      <DocEditor
        key={`${docType}-edit-${epoch}`}
        model={editModel}
        allowedBlocks={allowedBlocksFor(schema)}
        onChange={(blocks) => apply(collectSchemaDoc(blocks, schema, { title: draft.title, frontmatter: draft.frontmatter }).doc)}
      />
    ) : empty && surface?.emptyStart ? (
      <EmptyDoc text={surface.emptyStart.text} label={surface.emptyStart.label} prompt={surface.emptyStart.prompt} />
    ) : readModel ? (
      <DocRead model={readModel} />
    ) : null;

  return (
    <DocPageShell
      boards={boards}
      board={board}
      view={view}
      title={entry.label}
      status={empty && !editing ? "Ainda vazio" : docStatusLine({ editing, dirty, saving, errors: errors.length })}
      statusTone={errors.length ? "error" : "ok"}
      editing={editing}
      dirty={dirty}
      saving={saving}
      saveBlocked={errors.length > 0}
      onEdit={() => setEditing(true)}
      onSave={() => void save()}
      onCancel={cancel}
      wide={layout === "quadro"}
      chatSurface={chatSurface}
      onCapture={backlogSeed !== undefined ? (text) => setCapture({ initialText: text?.trim() ? text : backlogSeed || undefined }) : undefined}
      notices={
        <>
          <DocProposalNoticeBar proposals={pendingProposals} />
          <ViolationList violations={violations} />
        </>
      }
      overlay={
        capture ? (
          <SmartCaptureModal
            boardId={config.id}
            config={config}
            cards={board.cards}
            initialText={capture.initialText}
            onClose={() => {
              setCapture(null);
              router.refresh();
            }}
            onCreated={() => router.refresh()}
            onOpenCard={(id) => router.push(`/board/${config.id}/card/${encodeURIComponent(id)}`)}
          />
        ) : undefined
      }
    >
      {content}
    </DocPageShell>
  );
}

/**
 * Documento ainda vazio: uma frase e UM botão, que abre a conversa da página com o pedido de começar já escrito (a
 * pessoa revisa e envia — nada é enviado sozinho). Mesmo desenho do estado vazio do guia de estilo.
 */
function EmptyDoc({ text, label, prompt }: { text: string; label: string; prompt: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line-emphasis bg-surface px-5 py-8 text-center">
      <p className={cn("mx-auto max-w-[460px] text-fg-muted", DOC.body)}>{text}</p>
      <button
        type="button"
        onClick={() => openJidoChat({ draft: prompt })}
        className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-fg px-4 text-[13px] font-semibold text-canvas transition hover:bg-fg/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg md:h-9"
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        {label}
      </button>
    </div>
  );
}

/** O corpo depois do frontmatter — o parse do corpo é sempre sobre o texto sem o cabeçalho. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}
