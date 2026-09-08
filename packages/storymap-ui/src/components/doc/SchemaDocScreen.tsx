"use client";

// 📄 SchemaDocScreen — a TELA de um documento de schema, genérica sobre o schema.
//
// Ela existe porque a alternativa já tinha nome: o subsistema de documento nasceu com sete telas
// repetindo a MESMA máquina de estados (saved/draft/mode/epoch/saving/violations + dirty + apply +
// save + descarte + a fiação da conversa), ~120 linhas cada, e o relatório de arquitetura registrou
// isso como a fatia óbvia seguinte. Acrescentar o PRD como oitava cópia teria transformado um
// defeito conhecido em precedente.
//
// O que é GENÉRICO aqui, e por que pode ser:
//   · as VIEWS não são uma lista escrita à mão — vêm de `availableViews(schema)`. É a promessa
//     declarada da Camada 3 ("a view diz o que EXIGE; todo documento que satisfaz a ganha de
//     graça") sendo cumprida em vez de reafirmada. Um schema com duas seções de itens ganha quadro
//     e tabela sem ninguém decidir por ele;
//   · os BLOCOS do editor vêm de `allowedBlocksFor(schema)` pelo mesmo argumento;
//   · o LAYOUT do quadro é refinamento opcional: `boardLayoutFor` devolvendo `null` cai na grade
//     automática, e isso é caminho normal, não caso degradado.
//
// O que a tela NÃO decide: onde os bytes moram. Toda mutação passa pelas funções PURAS do codec e
// só `saveDocAction` toca o disco — as quatro superfícies (documento, fonte, quadro, tabela)
// compartilham UM rascunho, UMA barra e UM save, então trocar de view nunca perde o que foi
// digitado, e nenhuma delas tem caminho de escrita próprio.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileText, LayoutGrid, MessagesSquare, Table2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { BoardHeader } from "@/components/BoardHeader";
import { DocShell, type DocViewDef } from "@/components/doc/DocShell";
import { DocRead } from "@/components/doc/DocRead";
import { DocEditor } from "@/components/doc/DocEditor";
import { BoardView as DocBoardView } from "@/components/doc/views/BoardView";
import { TableView } from "@/components/doc/views/TableView";
import { ViewChat } from "@/components/ViewChat";
import { ChatDock, ChatDockGhost, useChatRailVisible } from "@/components/chat/ChatDock";
import { chatDockFor, chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import { useToast } from "@/components/Toast";
import { docChatContextAction, saveDocAction } from "@/app/doc-actions";
import { allowedBlocksFor, availableViews } from "@/lib/storymap/doc/view-contracts";
import {
  collectSchemaDoc,
  parseSchemaBody,
  schemaDocToModel,
  serializeSchemaDoc,
  type SchemaDoc,
} from "@/lib/storymap/doc/schema-codec";
import type { DocSchema, SchemaViolation } from "@/lib/storymap/doc/doc-schema";
import type { BoardView } from "@/components/nav/nav-groups";
import type { Board, BoardSummary } from "@/lib/storymap/types";

export interface SchemaDocScreenProps {
  board: Board;
  boards: BoardSummary[];
  /** O contrato do documento — dele saem as views, os blocos do editor e a validação. */
  schema: DocSchema;
  /** O id da view: rota, realce da navegação e chave da conversa desta tela. */
  view: BoardView;
  /** O nome que o operador lê no sub-topnav. */
  title: string;
  /** O documento lido do disco — ou projetado do `board.yaml` enquanto o `.md` não existir. */
  initialDoc: SchemaDoc;
  initialViolations: SchemaViolation[];
  /** Ação própria do documento na barra (ao lado do botão da conversa) — o genérico não a conhece. */
  toolbarExtra?: ReactNode;
  /** Camada sobreposta que a tela dona controla (um modal). Fica FORA do fluxo do documento. */
  overlay?: ReactNode;
}

export function SchemaDocScreen({
  board,
  boards,
  schema,
  view,
  title,
  initialDoc,
  initialViolations,
  toolbarExtra,
  overlay,
}: SchemaDocScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const config = board.config;

  const [saved, setSaved] = useState<SchemaDoc>(initialDoc);
  const [draft, setDraft] = useState<SchemaDoc>(initialDoc);
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [epoch, setEpoch] = useState(0);
  const [saving, setSaving] = useState(false);
  const [violations, setViolations] = useState<SchemaViolation[]>(initialViolations);

  // A conversa da TELA (uma só, ancorada — a mesma régua da bancada de Ideias). No desktop ela é parte
  // do layout e nasce aberta; no celular vira folha, e o botão do cabeçalho é o que a abre.
  const railVisible = useChatRailVisible();
  const [sheetOpen, setSheetOpen] = useState(false);
  const chatOpen = railVisible || sheetOpen;
  const [chatContext, setChatContext] = useState<string | null>(null);
  const surface = chatSurfaceFor(view);

  useEffect(() => {
    if (!chatOpen || chatContext !== null) return;
    let alive = true;
    void docChatContextAction(config.id, schema.docType)
      .then((c) => alive && setChatContext(c ?? "Não consegui ler o documento."))
      .catch(() => alive && setChatContext("Não consegui ler o documento."));
    return () => {
      alive = false;
    };
  }, [chatOpen, chatContext, config.id, schema.docType]);

  const dirty = useMemo(
    () => serializeSchemaDoc(draft, schema) !== serializeSchemaDoc(saved, schema),
    [draft, saved, schema],
  );
  const blocking = violations.filter((v) => v.severity === "error");

  /** Toda mutação passa por aqui: revalida contra o schema para a barra saber o que dizer. */
  const apply = (next: SchemaDoc) => {
    setDraft(next);
    const md = serializeSchemaDoc(next, schema);
    setViolations(parseSchemaBody(stripFrontmatter(md), schema, next.frontmatter).violations);
  };

  const readModel = useMemo(() => schemaDocToModel(saved, schema), [saved, schema]);
  // Capturado quando a EDIÇÃO começa (o epoch reabre): enquanto montado, o editor é dono da
  // superfície — re-semear a cada tecla brigaria com o cursor.
  const editModel = useMemo(
    () => (mode === "edit" ? schemaDocToModel(draft, schema) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, epoch],
  );

  const discard = () => {
    setDraft(saved);
    setViolations(initialViolations);
    setEpoch((e) => e + 1);
  };

  const save = async () => {
    if (blocking.length) {
      toast("Corrija o que está marcado antes de salvar.");
      return;
    }
    setSaving(true);
    const res = await saveDocAction({ boardId: config.id, docType: schema.docType, doc: draft });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      if (res.violations?.length) setViolations(res.violations);
      return;
    }
    setSaved(draft);
    setMode("read");
    router.refresh();
  };

  // As views DERIVADAS do schema, na ordem do catálogo. `markdown` fica de fora porque a fonte é
  // ancorada pelo próprio DocShell (ela não é um item do seletor, é o par imediato do documento).
  const RENDERERS: Record<string, () => DocViewDef> = {
    documento: () => ({
      id: "documento",
      label: "Documento",
      icon: FileText,
      render: () =>
        mode === "edit" && editModel ? (
          <DocEditor
            key={`${schema.docType}-edit-${epoch}`}
            model={editModel}
            allowedBlocks={allowedBlocksFor(schema)}
            onChange={(blocks) =>
              apply(
                collectSchemaDoc(blocks, schema, {
                  title: draft.title,
                  frontmatter: draft.frontmatter,
                }).doc,
              )
            }
          />
        ) : (
          <DocRead model={readModel} />
        ),
    }),
    quadro: () => ({
      id: "quadro",
      label: "Quadro",
      icon: LayoutGrid,
      fullWidth: true,
      render: () => <DocBoardView doc={draft} schema={schema} onChange={apply} />,
    }),
    tabela: () => ({
      id: "tabela",
      label: "Tabela",
      icon: Table2,
      fullWidth: true,
      render: () => <TableView doc={draft} schema={schema} />,
    }),
  };

  const views: DocViewDef[] = availableViews(schema)
    .filter((v) => v.id !== "markdown")
    .map((v) => RENDERERS[v.id])
    .filter(Boolean)
    .map((make) => make());

  return (
    // Com o rail ancorado a PÁGINA é dona do viewport e o CONTEÚDO é que rola — assim o composer do chat
    // fica parado no rodapé em vez de subir com o documento. Decidido por CSS (`lg:`), não por
    // `railVisible`: este só fica verdadeiro DEPOIS do mount, e até lá a altura ficaria indefinida.
    <div className="flex min-h-screen flex-col bg-canvas lg:h-screen lg:overflow-hidden">
      {/* `dockedChat` suprime a gaveta do Jido do board: o mascote nunca aparece em dois lugares (o
          face-bus é chaveado por board, e dois painéis publicariam humor na mesma chave). */}
      <BoardHeader boards={boards} config={config} view={view} dockedChat={railVisible} />
      <div className="flex min-h-0 flex-1">
        {/* `min-w-0` NÃO é enfeite: um item flex nasce com `min-width: auto` e por isso cresce até a
            largura INTRÍNSECA do conteúdo — aqui o cluster de ações do sub-topnav esticava a coluna a
            399px num viewport de 375, e a página inteira passava a rolar de lado no celular. Medido
            na validação visual (24px de overflow); o `tsc` e a suíte não têm como ver isto. */}
        <div className="min-h-0 min-w-0 flex-1 lg:overflow-hidden">
          <DocShell
            docType={schema.docType}
            title={title}
            views={views}
            banner={violations.length > 0 ? <ViolationBanner violations={violations} /> : undefined}
            markdown={{
              read: () => serializeSchemaDoc(draft, schema),
              write: (markdown) => {
                const { doc } = parseSchemaBody(stripFrontmatter(markdown), schema, draft.frontmatter);
                apply(doc);
              },
              epoch,
            }}
            mode={mode}
            onModeChange={(m) => {
              if (m === "read" && dirty) {
                toast("Salve ou descarte as mudanças antes de sair da edição.");
                return;
              }
              setMode(m);
            }}
            // No celular a conversa é FOLHA e precisa de quem a abra; com o rail ancorado o botão
            // sumiria de propósito — ele abriria o que já está na tela, e botão que não muda nada é
            // pior que botão nenhum.
            toolbarExtra={
              <>
                {toolbarExtra}
                {railVisible || !surface ? null : (
                  <button
                    type="button"
                    onClick={() => setSheetOpen((s) => !s)}
                    className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
                  >
                    <MessagesSquare className="h-3.5 w-3.5" />
                    {surface.label}
                  </button>
                )}
              </>
            }
            exportMarkdown={() => serializeSchemaDoc(saved, schema)}
            dirty={dirty}
            saving={saving}
            saveDisabled={blocking.length > 0}
            onSave={save}
            onDiscard={discard}
          />
        </div>

        {/* O fantasma reserva a coluna por CSS antes da hidratação, para o layout não "assentar". */}
        {!railVisible && <ChatDockGhost />}
        {surface && (
          <ChatDock
            mode={chatDockFor(view)}
            open={chatOpen}
            onClose={() => setSheetOpen(false)}
            label={surface.label}
          >
            <ViewChat
              boardId={config.id}
              view={view}
              context={chatContext ?? "Lendo o documento…"}
              // Re-resolvido FRESCO a cada turno: é o que faz o agente enxergar o que acabei de editar
              // na tela, em vez de responder sobre o documento de quando a conversa começou.
              getContext={() => docChatContextAction(config.id, schema.docType)}
              onClose={railVisible ? undefined : () => setSheetOpen(false)}
            />
          </ChatDock>
        )}
      </div>
      {overlay}
    </div>
  );
}

/**
 * O que o documento tem de errado, dito onde a pessoa está olhando. Erros primeiro (recusam o
 * salvamento) e avisos depois — a diferença importa: um aviso é trabalho em andamento, um erro é
 * esqueleto quebrado.
 */
function ViolationBanner({ violations }: { violations: SchemaViolation[] }) {
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const list = [...errors, ...warnings];
  const isError = errors.length > 0;

  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]",
        isError
          ? "border-danger/30 bg-danger/[0.06] text-danger"
          : "border-line-emphasis bg-inset/60 text-fg-muted",
      )}
      role={isError ? "alert" : "status"}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">
          {isError
            ? `${errors.length} ${errors.length === 1 ? "problema impede" : "problemas impedem"} de salvar`
            : `${warnings.length} ${warnings.length === 1 ? "observação" : "observações"}`}
        </p>
        <ul className="mt-1 space-y-0.5">
          {list.slice(0, 6).map((v, i) => (
            <li key={i} className="leading-snug">
              {v.message}
            </li>
          ))}
          {list.length > 6 && <li className="text-fg-subtle">e mais {list.length - 6}…</li>}
        </ul>
      </div>
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
