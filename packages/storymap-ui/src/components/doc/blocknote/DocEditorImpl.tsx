"use client";

// DocEditorImpl — the actual BlockNote editing surface for a DocModel (doc-model.ts). Loaded ONLY
// client-side via next/dynamic (see ../DocEditor.tsx — SSR has no DOM for ProseMirror to mount on).
//
// - Slash menu: BlockNote's own default items are gated on which block types are actually registered
//   in the schema (schema.tsx) AND further filtered here down to `allowedBlocks` (a caller may want,
//   say, a canvas surface that never offers "Tabela").
// - Drag-handle menu: replaced (not appended to) with the actions this doc model actually supports —
//   e é aqui que mora o gesto que faltava, TRANSFORMAR EM (o "turn into" do Notion). Sem ele um
//   parágrafo nascia parágrafo e morria parágrafo: dava para editar o texto de dentro e nada mais.
//   Para um `section` (bloco ANCORADO, sem conteúdo inline próprio) o equivalente é DESFAZER A SEÇÃO —
//   o rótulo vira um título de verdade e os filhos sobem para o corpo do documento, que é como se
//   "tira o bloco de um texto" sem perder uma linha do que estava escrito.
// - Theme: BlockNote's own `--bn-*` vars are remapped in ./theme.css; light/dark is read off
//   `document.documentElement`'s `.dark` class (the app's own dark-mode toggle), not matchMedia.
// - onChange: debounced 150ms so a keystroke burst doesn't spam the caller with `blockNoteToDoc`
//   conversions (Object mapping over the whole tree on every keystroke would be wasteful).

import { useEffect, useMemo, useRef, useState } from "react";
import { filterSuggestionItems, type BlockNoteEditor } from "@blocknote/core";
import { SideMenuExtension } from "@blocknote/core/extensions";
import { pt } from "@blocknote/core/locales";
import {
  DragHandleMenu,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useBlockNoteEditor,
  useComponentsContext,
  useCreateBlockNote,
  useExtensionState,
  type DefaultReactSuggestionItem,
  type SideMenuProps,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import "./theme.css";
import { ClipboardCopy, Copy, CornerLeftDown, Trash2, Type } from "lucide-react";
import { serializeBlockMd } from "@/lib/storymap/doc/md-codec";
import type { DocBlock, DocBlockKind, DocModel } from "@/lib/storymap/doc/doc-model";
import { blockNoteToDoc, docToBlockNote } from "./adapter";
import { docSchema, DOC_SECTION_AGENT_EVENT, type DocBlockNoteBlock, type DocBlockNotePartialBlock } from "./schema";

export interface DocEditorImplProps {
  model: DocModel;
  readOnly?: boolean;
  allowedBlocks: DocBlockKind[];
  onChange(blocks: DocBlock[]): void;
  onSectionAgent?(binding: string, label: string): void;
}

// ── theme (read the app's own .dark toggle — no matchMedia) ─────────────────────────────────────

function useIsDarkMode(): boolean {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setIsDark(root.classList.contains("dark"));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

// ── slash menu (default items filtered to allowedBlocks) ────────────────────────────────────────

type DocEditor = BlockNoteEditor<
  typeof docSchema.blockSchema,
  typeof docSchema.inlineContentSchema,
  typeof docSchema.styleSchema
>;

const DEFAULT_SLASH_KEYS: Partial<Record<DocBlockKind, readonly string[]>> = {
  heading: ["heading", "heading_2", "heading_3"],
  paragraph: ["paragraph"],
  bullet: ["bullet_list"],
  numbered: ["numbered_list"],
  todo: ["check_list"],
  toggle: ["toggle_list"],
  quote: ["quote"],
  code: ["code_block"],
  table: ["table"],
  divider: ["divider"],
  image: ["image"],
};

// `DefaultReactSuggestionItem` deliberately Omits `key` (it would collide with React's own `key`
// prop when an item is spread onto JSX) — but the dictionary key each item was built from is still
// there at runtime (react's getDefaultReactSlashMenuItems spreads the core item, key included).
type SlashItemWithKey = DefaultReactSuggestionItem & { key: string };

/**
 * O menu "/" oferece só o que o documento sabe guardar. `section` e `properties` NÃO estão aqui de
 * propósito: são blocos de PROJEÇÃO (uma região ancorada a um campo da entidade, um espelho
 * read-only), e desde que a seção passou a ler como TÍTULO, uma seção livre criada à mão seria um
 * heading que serializa como blockquote — um sósia com regra própria. Quem quer um título usa
 * "Título"; quem quer destaque usa "Citação", a única caixa do documento.
 */
function useSlashMenuItems(editor: DocEditor, allowedBlocks: DocBlockKind[]) {
  return useMemo(() => {
    return async (query: string): Promise<DefaultReactSuggestionItem[]> => {
      const allowedKeys = new Set<string>();
      for (const kind of allowedBlocks) {
        for (const key of DEFAULT_SLASH_KEYS[kind] ?? []) allowedKeys.add(key);
      }
      const items: DefaultReactSuggestionItem[] = (getDefaultReactSlashMenuItems(editor) as SlashItemWithKey[]).filter(
        (item) => allowedKeys.has(item.key),
      );
      return filterSuggestionItems(items, query);
    };
  }, [editor, allowedBlocks]);
}

// ── side menu / drag-handle menu ────────────────────────────────────────────────────────────────

function stripBlockId(block: DocBlockNoteBlock): DocBlockNotePartialBlock {
  const { id: _id, children, ...rest } = block;
  return { ...rest, children: children.map(stripBlockId) } as DocBlockNotePartialBlock;
}

/** "Transformar em" — o alvo, o rótulo em PT e o `DocBlockKind` que o autoriza (allowedBlocks). */
interface TurnIntoTarget {
  label: string;
  kind: DocBlockKind;
  type: string;
  props?: Record<string, unknown>;
}

const TURN_INTO: TurnIntoTarget[] = [
  { label: "Texto", kind: "paragraph", type: "paragraph" },
  { label: "Título 1", kind: "heading", type: "heading", props: { level: 1 } },
  { label: "Título 2", kind: "heading", type: "heading", props: { level: 2 } },
  { label: "Título 3", kind: "heading", type: "heading", props: { level: 3 } },
  { label: "Lista", kind: "bullet", type: "bulletListItem" },
  { label: "Lista numerada", kind: "numbered", type: "numberedListItem" },
  { label: "Tarefa", kind: "todo", type: "checkListItem" },
  { label: "Alternável", kind: "toggle", type: "toggleListItem" },
  { label: "Citação", kind: "quote", type: "quote" },
  { label: "Código", kind: "code", type: "codeBlock" },
];

/** Blocos que NÃO se transformam: os de projeção. Um `section` ganha "Desfazer seção" no lugar. */
const STRUCTURAL_TYPES = new Set(["section", "docProperties"]);

function DocDragHandleMenu({ allowedBlocks }: { allowedBlocks: DocBlockKind[] }) {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor(docSchema);
  // SideMenuExtension's state is schema-agnostic (Block<any,any,any>) regardless of the editor's
  // own schema — this editor only ever holds docSchema blocks, so the cast is safe.
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  }) as DocBlockNoteBlock | undefined;

  if (!Components || !block) return null;

  const section = block.type === "section" ? block : null;
  const targets = TURN_INTO.filter(
    (t) => allowedBlocks.includes(t.kind) && !(t.type === block.type && matchesProps(block, t)),
  );

  /**
   * DESFAZER A SEÇÃO: o rótulo vira um título de verdade e os filhos sobem para o nível do
   * documento. É a saída de quem quer "tirar o bloco" sem perder o texto de dentro — apagar a seção
   * levaria os filhos junto (eles são filhos DELA), que era exatamente a armadilha.
   */
  const unwrapSection = (target: NonNullable<typeof section>) => {
    const label = String(target.props.label ?? "").trim();
    const replacement: DocBlockNotePartialBlock[] = [];
    if (label) {
      replacement.push({ type: "heading", props: { level: 2 }, content: label } as DocBlockNotePartialBlock);
    }
    replacement.push(...target.children.map(stripBlockId));
    if (!replacement.length) replacement.push({ type: "paragraph" } as DocBlockNotePartialBlock);
    editor.replaceBlocks([target], replacement);
  };

  return (
    <DragHandleMenu>
      {!STRUCTURAL_TYPES.has(block.type) && targets.length > 0 && (
        <Components.Generic.Menu.Root sub position="right">
          <Components.Generic.Menu.Trigger sub>
            <Components.Generic.Menu.Item className="bn-menu-item" subTrigger icon={<Type className="h-3.5 w-3.5" />}>
              Transformar em
            </Components.Generic.Menu.Item>
          </Components.Generic.Menu.Trigger>
          <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown">
            {targets.map((target) => (
              <Components.Generic.Menu.Item
                key={`${target.type}-${target.label}`}
                className="bn-menu-item"
                onClick={() =>
                  editor.updateBlock(block, {
                    type: target.type,
                    ...(target.props ? { props: target.props } : {}),
                  } as never)
                }
              >
                {target.label}
              </Components.Generic.Menu.Item>
            ))}
          </Components.Generic.Menu.Dropdown>
        </Components.Generic.Menu.Root>
      )}

      {section && (
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          icon={<CornerLeftDown className="h-3.5 w-3.5" />}
          onClick={() => unwrapSection(section)}
        >
          Desfazer seção
        </Components.Generic.Menu.Item>
      )}

      <Components.Generic.Menu.Item
        className="bn-menu-item"
        icon={<Copy className="h-3.5 w-3.5" />}
        onClick={() => editor.insertBlocks([stripBlockId(block)], block, "after")}
      >
        Duplicar
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Item
        className="bn-menu-item"
        icon={<ClipboardCopy className="h-3.5 w-3.5" />}
        onClick={() => {
          const [docBlock] = blockNoteToDoc([block]);
          void navigator.clipboard.writeText(serializeBlockMd(docBlock));
        }}
      >
        Copiar como Markdown
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Item
        className="bn-menu-item"
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={() => editor.removeBlocks([block])}
      >
        Excluir
      </Components.Generic.Menu.Item>
    </DragHandleMenu>
  );
}

/** Blocos que NÃO recebem um cursor de texto (atômicos, ou com uma geometria própria). */
const NO_TEXT_CURSOR = new Set(["docProperties", "section", "divider", "image", "table"]);

/** O primeiro bloco do documento que aceita um cursor de texto — descendo em filhos (uma seção). */
function firstTextBlock(blocks: DocBlockNoteBlock[]): DocBlockNoteBlock | undefined {
  for (const block of blocks) {
    if (!NO_TEXT_CURSOR.has(block.type)) return block;
    const nested = block.children.length ? firstTextBlock(block.children) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Um heading só é "o mesmo tipo" quando o NÍVEL também bate (senão Título 1→2 sumiria da lista). */
function matchesProps(block: DocBlockNoteBlock, target: TurnIntoTarget): boolean {
  if (!target.props) return true;
  const props = block.props as Record<string, unknown>;
  return Object.entries(target.props).every(([key, value]) => props[key] === value);
}

// ── editor ───────────────────────────────────────────────────────────────────────────────────────

export default function DocEditorImpl({ model, readOnly, allowedBlocks, onChange, onSectionAgent }: DocEditorImplProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isDark = useIsDarkMode();

  const dictionary = useMemo(
    () => ({
      ...pt,
      placeholders: { ...pt.placeholders, default: "Escreva algo, ou digite \"/\" para comandos…" },
    }),
    [],
  );

  // Only the FIRST render seeds the editor — later `model` changes flow through `onChange`, not a
  // remount (useCreateBlockNote's own deps=[] below already ignores subsequent option changes).
  const initialContent = useMemo(() => {
    const blocks = docToBlockNote(model.blocks);
    return blocks.length ? blocks : [{ type: "paragraph" as const }];
    // O disable vive AQUI, colado no array de deps: é nesta linha que a regra reporta, e o comentário
    // anterior (uma linha acima do `useMemo(`) nunca a cobriu — a intenção estava documentada mas o
    // silenciamento não funcionava, e o aviso sobrevivia sem que ninguém percebesse.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semear só no 1º render é o comportamento pretendido (ver acima)
  }, []);

  const editor = useCreateBlockNote({ schema: docSchema, initialContent, dictionary }, []);
  const getSlashMenuItems = useSlashMenuItems(editor, allowedBlocks);

  // O cursor nasce no primeiro bloco que ACEITA texto — descendo para dentro de uma seção quando
  // ela é o primeiro bloco. Sem isto ele nascia num bloco atômico (`content: "none"`: as
  // propriedades, ou a própria seção), o ProseMirror o marcava com uma seleção de NÓ, e o documento
  // abria com aquele bloco contornado, como se estivesse prestes a ser apagado.
  useEffect(() => {
    const first = firstTextBlock(editor.document);
    if (!first) return;
    try {
      editor.setTextCursorPosition(first, "start");
    } catch {
      // um documento só de blocos atômicos não tem posição de texto — seguir sem cursor é correto.
    }
  }, [editor]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = editor.onChange((ed) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => onChangeRef.current(blockNoteToDoc(ed.document)), 150);
    });
    return () => {
      unsubscribe();
      if (timeout) clearTimeout(timeout);
    };
  }, [editor]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onSectionAgent) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ binding: string; label: string }>).detail;
      if (detail) onSectionAgent(detail.binding, detail.label);
    };
    container.addEventListener(DOC_SECTION_AGENT_EVENT, handler);
    return () => container.removeEventListener(DOC_SECTION_AGENT_EVENT, handler);
  }, [onSectionAgent]);

  // O menu do grip precisa saber o que o documento autoriza (é ele que filtra "Transformar em"), e
  // o SideMenu recebe um COMPONENTE — daí o wrapper memoizado em vez de uma closure nova por render
  // (uma identidade nova remontaria o menu a cada frame do hover).
  const sideMenu = useMemo(() => {
    const Menu = () => <DocDragHandleMenu allowedBlocks={allowedBlocks} />;
    const Rendered = (props: SideMenuProps) => <SideMenu {...props} dragHandleMenu={Menu} />;
    Rendered.displayName = "DocSideMenu";
    return Rendered;
  }, [allowedBlocks]);

  return (
    <div ref={containerRef} className="doc-editor" data-section-agent={onSectionAgent ? "on" : "off"}>
      <BlockNoteView
        editor={editor}
        editable={!readOnly}
        theme={isDark ? "dark" : "light"}
        slashMenu={false}
        sideMenu={false}
      >
        <SuggestionMenuController triggerCharacter="/" getItems={getSlashMenuItems} />
        <SideMenuController sideMenu={sideMenu} />
      </BlockNoteView>
    </div>
  );
}
