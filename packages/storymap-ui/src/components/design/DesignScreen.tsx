"use client";

// 🟥 DESIGN — a página do guia de estilo (`design/style-guide.md`) como UM documento (fase 2), na casca única das
// páginas de documento (`doc/DocPage`): título, linha de estado, Editar/Salvar e o conteúdo.
//
// A leitura junta as seções na linguagem de quem usa o guia (`style-page.ts`): Tom · Cores (com as amostras e o selo
// AA) · Tipografia (com a escala) · Estética · Componentes · e, recolhidos no fim, Anti-padrões e dívidas. A edição é
// a do modo "Doc" de antes — só a PROSA de cada seção, pelo par `projectStyleDoc`/`commitStyleDoc`, gravada por
// `applyStyleGuideAssistAction` (o ÚNICO escritor do arquivo e do ponteiro, com a checagem de versão). A parte
// estruturada (tokens, escala, léxico, componentes) aparece só-leitura: quem a mantém é o assistente do guia.
// O modo "Estruturado" e o painel de autoria grande saíram: com o guia vazio a página só convida a pedir ao
// assistente, no próprio compositor do rodapé.
//
// Só IMPORTS DE TIPO de style-guide.ts (ele puxa `node:crypto`): o AA e o "está vazio?" chegam prontos do servidor.

import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import { DOC } from "@/components/doc/typography";
import { DocPageShell } from "@/components/doc/DocPage";
import { docStatusLine } from "@/components/doc/doc-page";
import { DocEditor } from "@/components/doc/DocEditor";
import { Markdown } from "@/components/Markdown";
import { StyleSwatches } from "@/components/design/StyleSwatches";
import { TypeScalePreview } from "@/components/design/TypeScalePreview";
import { STYLE_PAGE_GROUPS, STYLE_SUB_LABEL, orderStyleModel } from "@/components/design/style-page";
import { openJidoChat } from "@/components/chat/jido-bus";
import { ToastProvider, useToast } from "@/components/Toast";
import { applyStyleGuideAssistAction, styleGuideChatContextAction } from "@/app/design-actions";
import { commitStyleDoc, projectStyleDoc, STYLE_ALLOWED_BLOCKS, STYLE_DOC_TYPE } from "@/lib/storymap/doc/style-doc";
import { reattachBindings, type DocBlock } from "@/lib/storymap/doc/doc-model";
import { chatSurfaceFor } from "@/lib/storymap/copilot/chat-surfaces";
import type { JidoDocSurface } from "@/components/chat/JidoComposer";
import type { AAReport, StyleGuideDoc } from "@/lib/storymap/style-guide";
import type { Board, BoardSummary } from "@/lib/storymap/types";

/** O rascunho que o estado vazio escreve no compositor (nunca enviado — a pessoa completa e envia). */
export const EMPTY_GUIDE_DRAFT = "Escreva o guia de estilo a partir de ";

export interface DesignScreenProps {
  board: Board;
  boards: BoardSummary[];
  /** o guia publicado, ou null quando vazio (o servidor decide com `isEmptyStyleGuideDoc`). */
  styleGuide: StyleGuideDoc | null;
  /** o contraste de cada par de cor, calculado no servidor (`checkAA`). */
  aa: AAReport | null;
}

/** Com o PRÓPRIO provedor de avisos: sem ele uma recusa de salvar (versão defasada) sumiria calada. */
export function DesignScreen(props: DesignScreenProps) {
  return (
    <ToastProvider>
      <DesignScreenInner {...props} />
    </ToastProvider>
  );
}

function DesignScreenInner({ board, boards, styleGuide, aa }: DesignScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const config = board.config;
  const [editing, setEditing] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [edited, setEdited] = useState<DocBlock[] | null>(null);
  const [saving, setSaving] = useState(false);

  const editModel = useMemo(
    () => (editing && styleGuide ? orderStyleModel(projectStyleDoc(styleGuide)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, epoch],
  );
  const preview = useMemo(
    () => (edited && styleGuide ? commitStyleDoc({ docType: STYLE_DOC_TYPE, title: "Guia de Estilo", blocks: edited }, styleGuide) : null),
    [edited, styleGuide],
  );
  const dirty = !!preview && (preview.changedSections.length > 0 || preview.unbound.length > 0);
  const refused = !!preview && preview.unbound.length > 0;

  const surface = chatSurfaceFor("design");
  const chatSurface: JidoDocSurface | undefined = surface
    ? { view: surface.view, label: surface.label, getContext: () => styleGuideChatContextAction(config.id), empty: !styleGuide }
    : undefined;

  const cancel = () => {
    setEdited(null);
    setEpoch((e) => e + 1);
    setEditing(false);
  };

  const save = async () => {
    if (refused) {
      toast("Há texto fora das seções do guia — mova para dentro de uma seção ou remova antes de salvar.");
      return;
    }
    if (!preview || preview.changedSections.length === 0) {
      cancel();
      return;
    }
    setSaving(true);
    const res = await applyStyleGuideAssistAction({ boardId: config.id, doc: preview.doc, baseVersion: config.styleGuide?.version ?? 0 });
    setSaving(false);
    if (!res.ok) {
      toast(res.error);
      router.refresh(); // versão defasada (alguém publicou por baixo) — re-sincroniza
      return;
    }
    setEdited(null);
    setEditing(false);
    router.refresh();
  };

  const status = !styleGuide
    ? "Ainda vazio"
    : refused
      ? "Há texto fora das seções do guia — não dá para salvar assim"
      : docStatusLine({ editing, dirty, saving, errors: 0 });

  return (
    <DocPageShell
      boards={boards}
      board={board}
      view="design"
      title="Guia de estilo"
      status={status}
      statusTone={refused ? "error" : "ok"}
      editing={editing}
      dirty={dirty}
      saving={saving}
      saveBlocked={refused}
      // guia vazio: não há o que editar à mão — o estado vazio já leva ao assistente (um botão, não dois iguais)
      canEdit={!!styleGuide}
      onEdit={() => setEditing(true)}
      onSave={() => void save()}
      onCancel={cancel}
      chatSurface={chatSurface}
    >
      {!styleGuide ? (
        <EmptyGuide />
      ) : editing && editModel ? (
        <DocEditor
          key={`style-edit-${epoch}`}
          model={editModel}
          allowedBlocks={STYLE_ALLOWED_BLOCKS}
          onChange={(blocks) => setEdited(reattachBindings(blocks, editModel.blocks))}
        />
      ) : (
        <GuideRead guide={styleGuide} aa={aa} />
      )}
    </DocPageShell>
  );
}

/** Guia vazio: uma frase e o convite — o pedido vai pelo compositor do rodapé, já com o começo escrito. */
function EmptyGuide() {
  return (
    <div className="rounded-xl border border-dashed border-line-emphasis bg-surface px-5 py-8 text-center">
      <p className={cn("mx-auto max-w-[460px] text-fg-muted", DOC.body)}>
        O guia diz como o produto fala e se parece — tom, cores, tipografia, estética e componentes. Todo agente que
        desenha uma tela lê daqui.
      </p>
      <button
        type="button"
        onClick={() => openJidoChat({ draft: EMPTY_GUIDE_DRAFT })}
        className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-fg px-4 text-[13px] font-semibold text-canvas transition hover:bg-fg/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg md:h-9"
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        Pedir ao assistente do guia
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

function GuideRead({ guide, aa }: { guide: StyleGuideDoc; aa: AAReport | null }) {
  return (
    <div className="flex flex-col gap-8">
      {STYLE_PAGE_GROUPS.map((g) => {
        const body = (
          <div className="flex flex-col gap-4">
            {g.keys.map((k) => (
              <SectionBody key={k} sectionKey={k} guide={guide} aa={aa} titled={g.keys.length > 1} />
            ))}
          </div>
        );
        if (g.collapsed) {
          return (
            <details key={g.id} className="group rounded-lg border border-line bg-surface px-4 py-3">
              <summary className={cn("flex cursor-pointer list-none items-center gap-2 text-fg-strong [&::-webkit-details-marker]:hidden", DOC.h3)}>
                <ChevronRight className="h-4 w-4 text-fg-subtle transition group-open:rotate-90" aria-hidden />
                {g.label}
              </summary>
              <div className="pt-3">{body}</div>
            </details>
          );
        }
        return (
          <section key={g.id} aria-label={g.label}>
            <h2 className={cn("mb-3 text-fg-strong", DOC.h1)}>{g.label}</h2>
            {body}
          </section>
        );
      })}
    </div>
  );
}

function SectionBody({ sectionKey, guide, aa, titled }: { sectionKey: string; guide: StyleGuideDoc; aa: AAReport | null; titled: boolean }) {
  const parts: ReactNode[] = [];
  const prose = (text: string | undefined) => (text?.trim() ? <Markdown key="prose">{text}</Markdown> : null);

  switch (sectionKey) {
    case "voice": {
      const lex = guide.voice.lexicon;
      // a seção já se chama «Tom»: um «Tom: » no começo do texto repetia o rótulo logo abaixo dele
      parts.push(prose(guide.voice.prose.replace(/^\s*tom\s*:\s*/i, "")));
      if (lex.preferred.length)
        parts.push(
          <SimpleTable key="lex" head={["Use", "Evite"]} rows={lex.preferred.map((p) => [p.use, p.avoid])} />,
        );
      if (lex.forbidden.length) parts.push(<Line key="forb" label="Nunca use" value={lex.forbidden.join(", ")} />);
      if (lex.exceptions.length) parts.push(<Line key="exc" label="Exceções" value={lex.exceptions.join(", ")} />);
      break;
    }
    case "color":
      parts.push(<StyleSwatches key="sw" tokens={guide.color.tokens} aa={aa ?? undefined} />);
      if (guide.color.budgetRules.length) parts.push(<Bullets key="budget" items={guide.color.budgetRules} />);
      parts.push(prose(guide.color.prose));
      break;
    case "typography":
      if (guide.typography.fonts.length)
        parts.push(
          <Line key="fonts" label="Fontes" value={guide.typography.fonts.map((f) => `${f.family} (${f.role})`).join(" · ")} />,
        );
      parts.push(<TypeScalePreview key="scale" scale={guide.typography.scale} />);
      if (guide.typography.rules.length) parts.push(<Bullets key="rules" items={guide.typography.rules} />);
      parts.push(prose(guide.typography.prose));
      break;
    case "identity":
      if (guide.identity.school) parts.push(<Line key="school" label="Escola" value={guide.identity.school} />);
      if (guide.identity.personality.length) parts.push(<Line key="pers" label="Personalidade" value={guide.identity.personality.join(" · ")} />);
      parts.push(prose(guide.identity.prose));
      break;
    case "principles":
      if (guide.principles.items.length)
        parts.push(
          <ol key="items" className={cn("list-decimal space-y-1 pl-5 text-fg", DOC.body)}>
            {guide.principles.items.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>,
        );
      parts.push(prose(guide.principles.prose));
      break;
    case "shape": {
      const radii = Object.entries(guide.shape.radii);
      if (radii.length) parts.push(<Line key="radii" label="Raios" value={radii.map(([k, v]) => `${k} ${v}`).join(" · ")} />);
      if (guide.shape.depth) parts.push(<Line key="depth" label="Profundidade" value={guide.shape.depth} />);
      if (guide.shape.borders) parts.push(<Line key="borders" label="Bordas" value={guide.shape.borders} />);
      parts.push(prose(guide.shape.prose));
      break;
    }
    case "spacing":
      if (guide.spacing.base || guide.spacing.steps.length)
        parts.push(
          <Line key="sp" label="Escala" value={[guide.spacing.base ? `base ${guide.spacing.base}px` : "", guide.spacing.steps.join(" · ")].filter(Boolean).join(" — ")} />,
        );
      parts.push(prose(guide.spacing.prose));
      break;
    case "motion": {
      const d = Object.entries(guide.motion.durations);
      if (d.length) parts.push(<Line key="dur" label="Durações" value={d.map(([k, v]) => `${k} ${v}`).join(" · ")} />);
      parts.push(prose(guide.motion.prose));
      break;
    }
    case "components": {
      const items = guide.components?.items ?? [];
      if (items.length) parts.push(<SimpleTable key="comp" head={["Componente", "Regra"]} rows={items.map((c) => [c.name, c.rule])} />);
      parts.push(prose(guide.components?.prose));
      break;
    }
    case "antiPatterns":
      if (guide.antiPatterns.length)
        parts.push(<SimpleTable key="ap" head={["Sintoma", "Correção"]} rows={guide.antiPatterns.map((a) => [a.symptom, a.fix])} />);
      break;
    case "debt":
      if (guide.debt.knownIssues.length) parts.push(<Bullets key="debt" items={guide.debt.knownIssues} />);
      break;
  }

  const content = parts.filter(Boolean);
  if (!titled && content.length === 0) return <Empty />;
  if (titled && content.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {titled && <h3 className={cn("text-fg-strong", DOC.h3)}>{STYLE_SUB_LABEL[sectionKey] ?? sectionKey}</h3>}
      {content}
    </div>
  );
}

function Empty() {
  return <p className={cn("italic text-fg-muted", DOC.body)}>Ainda vazio — peça ao assistente do guia.</p>;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <p className={cn("text-fg", DOC.body)}>
      <span className="font-medium text-fg-muted">{label}: </span>
      {value}
    </p>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className={cn("list-disc space-y-1 pl-5 text-fg", DOC.body)}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

/** Tabela que rola DENTRO de si: a página nunca rola de lado no celular. */
function SimpleTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className={cn("w-full min-w-[320px] border-collapse text-left", DOC.tableCell)}>
        <thead className={cn("bg-inset/60 text-fg-muted", DOC.tableHead)}>
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn("border-t border-line align-top")}>
              {r.map((c, j) => (
                <td key={j} className="px-3 py-2 text-fg">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
