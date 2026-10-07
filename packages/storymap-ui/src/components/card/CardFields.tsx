"use client";

// CardFields — os CAMPOS ESTRUTURADOS de um card, como uma visão da própria página do card
// (`Documento · Markdown · Campos`). Saiu de dentro do CardEditorDrawer, que era o único lugar do
// app onde eles existiam — e por isso o drawer sobrevivia como superfície paralela à página.
//
// ── O que mora AQUI e o que mora no DOCUMENTO (uma verdade por campo) ────────────────────────────
// Aqui fica só o que o documento NÃO sabe dizer: classificação, narrativa, lugar, vocabulário,
// tasks, prioridade, rota e links. O que o documento JÁ edita não se repete aqui:
//   · título          → o `<h1>` (DocTitle) da visão Documento, ou o `# ` da visão Markdown
//   · critérios de aceite → a região ancorada de todos do documento (card-doc.ts)
//   · corpo           → o documento inteiro
// O drawer duplicava os três (um input de título, uma lista de aceite e um textarea de body ao lado
// do documento). Duas superfícies de escrita para o mesmo campo é o que faz um lado apagar o outro
// em silêncio — foi o mesmo motivo que tirou a aba "Campos" da Ideia.
//
// A NARRATIVA é a exceção que confirma a regra: o documento a projeta como seção READ-bound (uma
// frase composta; devolver prosa para role/want/soThat seria adivinhação com perda — ver card-doc.ts),
// então o único lugar onde ela se EDITA é aqui.
//
// Estado: este componente não guarda rascunho nenhum — recebe `draft` e devolve patches por
// `onChange`. Quem é dono do rascunho, do dirty e do save é a página (CardDocScreen), a mesma que
// serve as outras duas visões; assim as três compartilham UM save e UMA barra de alterações.

import { useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { VOCAB_PALETTE } from "@/components/Swatches";
import { slugify } from "@/lib/storymap/id";
import { isDeliveryStory } from "@/lib/storymap/unplaced";
import { optInsEditable } from "@/lib/storymap/card-opt-ins";
import { STORY_TYPE_DEFS, STORY_TYPE_BY_ID, narrativeSentence } from "@/lib/storymap/frameworks";
import type { StoryType } from "@/lib/storymap/frameworks";
import { savePersonaAction, saveSystemAction } from "@/app/actions";
import type { BoardConfig, Card, CardType, NamedColor, StoryNarrative, Task } from "@/lib/storymap/types";
import { PlacementBlock } from "@/components/PlacementBlock";
import { RouteBlock } from "@/components/RouteBlock";
import { DOC } from "@/components/doc/typography";
import { useToast } from "@/components/Toast";

const PALETTE = VOCAB_PALETTE;

const inputCls =
  "w-full rounded-lg border border-line bg-inset px-3 py-2 text-[15px] text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent";

const inputLgCls =
  "w-full rounded-xl border border-line bg-inset px-4 py-3 text-base text-fg outline-none transition focus:border-accent focus:ring-2 focus:ring-accent";

/** Listas longas (tasks) colapsam nos primeiros N + "ver mais". */
const LIST_PREVIEW_MAX = 3;

export interface CardFieldsProps {
  boardId: string;
  config: BoardConfig;
  cards: Card[];
  /** O card COMO ESTÁ EM DISCO — os blocos autocontidos (Rota/Lugar) escrevem sozinhos. */
  card: Card;
  /** O rascunho editável (dono: a página). */
  draft: Card;
  onChange: (patch: Partial<Card>) => void;
  /** "create" esconde os blocos que exigem um card já persistido. */
  mode?: "create" | "edit";
  onConfigChanged: (config: BoardConfig) => void;
  /** RouteBlock persiste sozinho e devolve o card atualizado. */
  onSaved: (card: Card) => void;
  /** Navegar para outro card (a árvore de vizinhança do Lugar). */
  onOpenCard?: (id: string) => void;
}

export function CardFields({
  boardId,
  config,
  cards,
  card,
  draft,
  onChange,
  mode = "edit",
  onConfigChanged,
  onSaved,
  onOpenCard,
}: CardFieldsProps) {
  const toast = useToast();
  const isStory = draft.type === "story";
  // A MESMA régua que o servidor usa para recusar (card-opt-ins.ts): num card novo, o rascunho; num existente, o disco.
  const optInsOpen = optInsEditable(mode === "create" ? draft : card, config);
  const [newPersona, setNewPersona] = useState("");
  const [newSystem, setNewSystem] = useState("");
  const [newTask, setNewTask] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [linkRel, setLinkRel] = useState(config.linkTypes[0]?.id ?? "");
  const [tasksExpanded, setTasksExpanded] = useState(false);

  const addTask = () => {
    const title = newTask.trim();
    if (!title) return;
    const existing = new Set(draft.tasks.map((t) => t.id));
    let n = draft.tasks.length + 1;
    let id = `t${n}`;
    while (existing.has(id)) id = `t${++n}`;
    const task: Task = { id, title, done: false };
    onChange({ tasks: [...draft.tasks, task] });
    setNewTask("");
  };
  const editTask = (idx: number, patch: Partial<Task>) =>
    onChange({ tasks: draft.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });
  const removeTask = (idx: number) => onChange({ tasks: draft.tasks.filter((_, i) => i !== idx) });

  const parentOptions =
    draft.type === "story"
      ? cards.filter((c) => c.type === "step")
      : draft.type === "step"
        ? cards.filter((c) => c.type === "activity")
        : [];

  // Dual-track: uma entrega (technical/bug/chore/spike) implementa uma USER STORY — escolhida aqui
  // para aparecer na prateleira dela. Vazio = usa o Pai (a atribuição padrão).
  const serveOptions = [
    ...cards.filter((c) => c.type === "story" && c.storyType === "user"),
    ...cards.filter((c) => c.type === "step"),
    ...cards.filter((c) => c.type === "activity"),
  ];

  const toggleVocab = (key: "personas" | "systems", id: string) =>
    onChange({
      [key]: draft[key].includes(id) ? draft[key].filter((x) => x !== id) : [...draft[key], id],
    } as Partial<Card>);

  // Criar uma persona/sistema aqui é ANTI-CLOBBER de propósito: `savePersonaAction`/`saveSystemAction`
  // re-leem o board config do DISCO e mexem só no próprio array. O caminho antigo mandava
  // `{...config, [kind]: [...]}` — o snapshot INTEIRO que este drawer carrega desde que a página
  // carregou — para `updateBoardConfigAction`, que grava sem re-ler: qualquer edição feita nesse meio
  // tempo em OUTRA parte da config (o prompt de uma persona salvo em Personas & Sistemas, o modo do
  // copiloto, a policy de uma coluna) era silenciosamente revertida. E o estado local passa a vir do
  // `config` DEVOLVIDO, não do objeto montado no cliente, senão a próxima escrita reintroduz o snapshot.
  const addVocab = async (kind: "personas" | "systems", name: string) => {
    const trimmed = name.trim();
    const id = slugify(trimmed);
    if (!id) return;
    const list = config[kind];
    if (!list.some((x) => x.id === id)) {
      const color = PALETTE[list.length % PALETTE.length];
      const item: NamedColor = { id, name: trimmed, color };
      const res =
        kind === "personas"
          ? await savePersonaAction({ boardId, persona: item })
          : await saveSystemAction({ boardId, system: item });
      if (!res.ok) {
        toast(res.error);
        return;
      }
      // A persona nasce SEM `prompt` — o bench de Personas & Sistemas é onde ela é escrita como o
      // system-prompt que um agente adota. Aqui só se dá nome ao que o card precisa referenciar.
      if (res.data) onConfigChanged(res.data.config);
    }
    if (!draft[kind].includes(id)) onChange({ [kind]: [...draft[kind], id] } as Partial<Card>);
    if (kind === "personas") setNewPersona("");
    else setNewSystem("");
  };

  const addLink = () => {
    if (!linkTarget || !linkRel) return;
    if (draft.links.some((l) => l.to === linkTarget && l.rel === linkRel)) return;
    onChange({ links: [...draft.links, { rel: linkRel, to: linkTarget }] });
    setLinkTarget("");
  };

  const titleOf = (id: string) => cards.find((c) => c.id === id)?.title ?? id;
  const relName = (id: string) => config.linkTypes.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="space-y-10">
      {/* ── Classificação ───────────────────────────────────────────────────────────────────── */}
      <Section title="Classificação">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo">
            <select
              value={draft.type}
              onChange={(e) => onChange({ type: e.target.value as CardType })}
              className={inputCls}
            >
              <option value="activity">activity</option>
              <option value="step">step</option>
              <option value="story">story</option>
            </select>
          </Field>
          <Field label="Status">
            <select
              value={draft.status ?? ""}
              onChange={(e) => onChange({ status: e.target.value || null })}
              className={inputCls}
            >
              <option value="">—</option>
              {config.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {isStory && (
          <div className="mt-5">
            <Label>Tipo de story</Label>
            <FieldHint>
              A natureza do trabalho. Define o template da narrativa e ajuda humanos e agentes a
              entender o que é.
            </FieldHint>
            <select
              value={draft.storyType ?? "user"}
              onChange={(e) => onChange({ storyType: e.target.value as StoryType })}
              className={cn(inputLgCls, "mt-1.5")}
            >
              {STORY_TYPE_DEFS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <StoryTypeHint storyType={draft.storyType ?? "user"} />
          </div>
        )}
      </Section>

      {/* ── As escolhas do dono no início do card (card-opt-ins.ts) ─────────────────── */}
      {isStory && (
        <Section title="Antes de construir">
          <FieldHint>
            Opcional. Diga isto antes de o card começar a ser construído — depois, o plano e a tela já partiram
            daqui.
          </FieldHint>
          <div className="mt-3">
            <Field label="Tecnologia (opcional)">
              <input
                value={draft.techPreference ?? ""}
                onChange={(e) => onChange({ techPreference: e.target.value || undefined })}
                disabled={!optInsOpen}
                placeholder="Ex.: usar o mesmo serviço de mapas que o app já usa"
                className={cn(inputCls, "disabled:bg-inset disabled:text-fg-subtle")}
              />
            </Field>
            <FieldHint>Se você indicar, o plano técnico segue esta tecnologia como regra.</FieldHint>
          </div>
          <label className="mt-3 flex items-center gap-2 text-[15px] text-fg">
            <input
              type="checkbox"
              checked={draft.ownerReviewsUi === true}
              onChange={(e) => onChange({ ownerReviewsUi: e.target.checked || undefined })}
              disabled={!optInsOpen}
              className="h-4 w-4 shrink-0 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed"
            />
            Quero ver as opções de tela
          </label>
          <FieldHint>Sem marcar, o sistema escolhe a tela pelo guia de estilo e registra as alternativas.</FieldHint>
          {!optInsOpen && (
            <p className="mt-2 text-[13px] text-fg-muted">
              Este card já começou a ser construído: estas escolhas ficaram fixas. Para mudar, reabra o card.
            </p>
          )}
        </Section>
      )}

      {/* ── Narrativa (o documento a projeta READ-bound — aqui é o único lugar de escrita) ──── */}
      {isStory && (
        <Section title="Narrativa">
          <NarrativeFields
            storyType={draft.storyType ?? "user"}
            narrative={draft.narrative}
            onChange={(narrative) => onChange({ narrative })}
          />
        </Section>
      )}

      {/* ── Lugar ───────────────────────────────────────────────────────────────────────────── */}
      <Section title="Lugar">
        {mode !== "create" && isStory && (
          <div className="mb-5">
            <PlacementBlock card={card} cards={cards} config={config} onOpenCard={onOpenCard} />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pai">
            <select
              value={draft.parent ?? ""}
              onChange={(e) => onChange({ parent: e.target.value || null })}
              disabled={draft.type === "activity"}
              className={cn(inputCls, "disabled:bg-inset disabled:text-fg-subtle")}
            >
              <option value="">—</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Release">
            <select
              value={draft.release ?? ""}
              onChange={(e) => onChange({ release: e.target.value || null })}
              className={inputCls}
            >
              <option value="">Sem release</option>
              {config.releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {isDeliveryStory(draft) && (
          <div className="mt-3">
            <Field label="Implementa a story (entrega)">
              <select
                value={draft.serves ?? ""}
                onChange={(e) => onChange({ serves: e.target.value || undefined })}
                className={inputCls}
                title="A user story que esta entrega implementa (aparece na prateleira dela). Vazio = usa o Pai."
              >
                <option value="">Usar o Pai ({draft.parent ?? "—"})</option>
                {serveOptions.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.type === "activity" ? "▸ atividade · " : n.type === "step" ? "• step · " : "↳ story · "}
                    {n.title}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        )}
      </Section>

      {/* ── Vocabulário ─────────────────────────────────────────────────────────────────────── */}
      <Section title="Vocabulário">
        <VocabField
          label="Personas"
          items={config.personas}
          selected={draft.personas}
          onToggle={(id) => toggleVocab("personas", id)}
          newValue={newPersona}
          onNewValue={setNewPersona}
          onAdd={() => addVocab("personas", newPersona)}
        />
        <div className="mt-5">
          <VocabField
            label="Sistemas"
            items={config.systems}
            selected={draft.systems}
            onToggle={(id) => toggleVocab("systems", id)}
            newValue={newSystem}
            onNewValue={setNewSystem}
            onAdd={() => addVocab("systems", newSystem)}
          />
        </div>
      </Section>

      {/* ── Tasks ───────────────────────────────────────────────────────────────────────────── */}
      <Section
        title="Tasks"
        aside={
          draft.tasks.length > 0
            ? `${draft.tasks.filter((t) => t.done).length}/${draft.tasks.length}`
            : undefined
        }
      >
        <div className="space-y-1.5">
          {draft.tasks.length === 0 && <p className="text-[13px] text-fg-subtle">Nenhuma task ainda.</p>}
          {(tasksExpanded ? draft.tasks : draft.tasks.slice(0, LIST_PREVIEW_MAX)).map((t, idx) => (
            <div key={t.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => editTask(idx, { done: e.target.checked })}
                className="h-4 w-4 shrink-0 cursor-pointer accent-emerald-600"
                aria-label={`Concluir ${t.title}`}
              />
              <input
                value={t.title}
                onChange={(e) => editTask(idx, { title: e.target.value })}
                className={cn(inputCls, "flex-1 text-[14px]", t.done && "text-fg-subtle line-through")}
              />
              <button
                type="button"
                onClick={() => removeTask(idx)}
                className="text-fg-subtle transition hover:text-danger"
                aria-label="Remover task"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <ListDisclosureToggle
            total={draft.tasks.length}
            max={LIST_PREVIEW_MAX}
            expanded={tasksExpanded}
            onToggle={() => setTasksExpanded((v) => !v)}
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTask();
              }
            }}
            placeholder="+ adicionar task"
            className={cn(inputCls, "flex-1")}
          />
          <button
            type="button"
            onClick={addTask}
            className="rounded-md border border-line p-1.5 text-fg-muted transition hover:bg-surface-hover"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </Section>

      {/* ── Rota ────────────────────────────────────────────────────────────────────────────── */}
      {mode !== "create" && isStory && (
        <Section title="Rota">
          <RouteBlock boardId={boardId} card={card} config={config} onSaved={onSaved} />
        </Section>
      )}

      {/* ── Links ───────────────────────────────────────────────────────────────────────────── */}
      <Section title="Links">
        <div className="space-y-1.5">
          {draft.links.length === 0 && <p className="text-[13px] text-fg-subtle">Nenhum link.</p>}
          {draft.links.map((l, idx) => (
            <div
              key={`${l.rel}-${l.to}-${idx}`}
              className="flex items-center gap-2 rounded border border-line px-2 py-1 text-[13px]"
            >
              <span className="rounded bg-surface-hover px-1 py-0.5 text-fg-muted">{relName(l.rel)}</span>
              <span className="flex-1 truncate text-fg">{titleOf(l.to)}</span>
              <button
                type="button"
                onClick={() => onChange({ links: draft.links.filter((_, i) => i !== idx) })}
                className="text-fg-subtle transition hover:text-danger"
                aria-label="Remover link"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={linkRel} onChange={(e) => setLinkRel(e.target.value)} className={cn(inputCls, "w-36")}>
            {config.linkTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select
            value={linkTarget}
            onChange={(e) => setLinkTarget(e.target.value)}
            className={cn(inputCls, "min-w-0 flex-1")}
          >
            <option value="">escolher card…</option>
            {cards
              .filter((c) => c.id !== card.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.id})
                </option>
              ))}
          </select>
          <button
            type="button"
            onClick={addLink}
            className="rounded-md border border-line p-1.5 text-fg-muted transition hover:bg-surface-hover"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </Section>

      <p className="border-t border-line pt-4 text-[13px] leading-relaxed text-fg-subtle">
        O <strong className="font-medium text-fg-muted">título</strong>, os{" "}
        <strong className="font-medium text-fg-muted">critérios de aceite</strong> e o{" "}
        <strong className="font-medium text-fg-muted">corpo</strong> se editam no Documento — cada campo
        tem UMA superfície de escrita.
      </p>
    </div>
  );
}

// ── peças ────────────────────────────────────────────────────────────────────────────────────────

/** Uma seção dos campos — título na mesma escala de um `##` do documento ao lado. */
function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className={cn("mb-3 flex items-baseline gap-2 text-fg", DOC.h1)}>
        {title}
        {aside && <span className="text-[14px] font-normal tabular-nums text-fg-subtle">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[13px] font-medium text-fg-muted">{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * Texto de apoio sob um rótulo. Serve de documentação para humanos E de contexto para os LLMs que
 * leem o formulário renderizado / o schema do card.
 */
function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[12.5px] leading-snug text-fg-muted">{children}</p>;
}

/** "ver mais (N) / ver menos" sob uma lista que passa de `max` itens. */
function ListDisclosureToggle({
  total,
  max,
  expanded,
  onToggle,
}: {
  total: number;
  max: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= max) return null;
  const hidden = total - max;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1 text-[12px] font-medium text-fg-subtle transition hover:text-fg-muted"
    >
      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
      {expanded ? "ver menos" : `ver mais (${hidden})`}
    </button>
  );
}

/** Descrição rica do tipo de story escolhido: significado + template de escrita. */
function StoryTypeHint({ storyType }: { storyType: StoryType }) {
  const def = STORY_TYPE_BY_ID[storyType];
  return (
    <div className="mt-2 border-l-[3px] border-line-emphasis pl-3">
      <p className="text-[13.5px] font-medium text-fg">{def.short}</p>
      <p className="mt-0.5 text-[12.5px] leading-snug text-fg-muted">
        <span className="font-medium text-fg-subtle">Template:</span> {def.template}
      </p>
      <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
        <span className="font-medium text-fg-subtle">Título:</span> {def.titleGuide.form}
      </p>
      <p className="mt-0.5 text-[12.5px] leading-snug">
        <span className="font-medium text-fg">✓ {def.titleGuide.good}</span>
        <span className="mx-1.5 text-fg-subtle">·</span>
        <span className="text-fg-subtle line-through">✗ {def.titleGuide.bad}</span>
      </p>
    </div>
  );
}

function VocabField({
  label,
  items,
  selected,
  onToggle,
  newValue,
  onNewValue,
  onAdd,
}: {
  label: string;
  items: (NamedColor & { role?: string; description?: string })[];
  selected: string[];
  onToggle: (id: string) => void;
  newValue: string;
  onNewValue: (v: string) => void;
  onAdd: () => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 && <span className="text-[13px] text-fg-subtle">Nenhum definido.</span>}
        {items.map((it) => {
          const active = selected.includes(it.id);
          const tip = [it.role, it.description].filter(Boolean).join(" — ");
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => onToggle(it.id)}
              title={tip || undefined}
              className={cn(
                "inline-flex items-center rounded-md px-2.5 py-1 text-[13px] font-medium transition",
                active ? "bg-primary text-primary-fg" : "bg-surface-hover text-fg-muted hover:text-fg",
              )}
            >
              {it.name}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={newValue}
          onChange={(e) => onNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={`+ adicionar ${label.toLowerCase()}`}
          className={cn(inputCls, "flex-1")}
        />
        <button
          type="button"
          onClick={onAdd}
          className="rounded-md border border-line p-1.5 text-fg-muted transition hover:bg-surface-hover"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * A narrativa ágil em três partes. Os conectores (Como/quero/para vs. Para/precisamos/de modo que)
 * seguem o storyType. Aviso suave quando incompleta — o gate `hasRefinement` é quem obriga na
 * entrada de "A fazer".
 */
function NarrativeFields({
  storyType,
  narrative,
  onChange,
}: {
  storyType: StoryType;
  narrative: StoryNarrative;
  onChange: (n: StoryNarrative) => void;
}) {
  const c = STORY_TYPE_BY_ID[storyType].connectors;
  const patch = (key: keyof StoryNarrative, raw: string) =>
    onChange({ ...narrative, [key]: raw.trim() === "" ? null : raw });
  const complete = Boolean(narrative.role && narrative.want && narrative.soThat);
  const preview = narrativeSentence(c, { role: narrative.role ?? "…", want: narrative.want ?? "…", soThat: narrative.soThat ?? "…" }) ?? "";

  return (
    <div>
      <FieldHint>
        A user story em 3 partes. Guarde só o miolo em cada campo — o conector (“{c.role}…”) já vem do
        tipo. É o que torna a story refinável. No Documento ela aparece como frase, em leitura.
      </FieldHint>
      <div className="space-y-2">
        <NarrativeRow connector={c.role} value={narrative.role} onChange={(v) => patch("role", v)} />
        <NarrativeRow connector={c.want} value={narrative.want} onChange={(v) => patch("want", v)} />
        <NarrativeRow connector={c.soThat} value={narrative.soThat} onChange={(v) => patch("soThat", v)} />
      </div>
      <p className={cn("mt-2 text-[13px] italic leading-snug", complete ? "text-fg-muted" : "text-danger")}>
        {preview}
      </p>
      {!complete && (
        <p className="mt-0.5 text-[12px] leading-snug text-fg-subtle">
          Recomendado preencher as três partes — torna-se obrigatório para entrar em “A fazer”.
        </p>
      )}
    </div>
  );
}

function NarrativeRow({
  connector,
  value,
  onChange,
}: {
  connector: string;
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-28 shrink-0 pt-3.5 text-right text-[13px] font-medium leading-tight text-fg-muted">
        {connector}
      </span>
      <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={cn(inputLgCls, "flex-1")} />
    </div>
  );
}
