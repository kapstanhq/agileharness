"use client";

// DocShell — the standard chrome around every doc-subsystem screen (card page, canvas, style guide,
// …): ONE sub-topnav (DocToolbar, exported and REUSABLE on sibling views — the legacy grid/editors
// render the SAME toolbar so switching views is always reversible), ONE centred reading column, ONE
// save bar. Content-agnostic: `views[].render()` supplies the body.
//
// Sub-topnav discipline: the MAIN topnav (BoardHeader) owns the board/view LINKS — the toolbar never
// repeats them. It shows at most a back arrow (page-style surfaces), the plain-text title, the
// mode/view controls and the "…" menu (Copiar Markdown + largura live THERE, not as loose buttons).
//
// View/width preference persists via useDocViewPref (localStorage, SSR-safe). Which view is ACTUALLY
// active is resolved by the pure `resolveDefaultView` (unit-testable without a DOM — doc-shell.test.ts).

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DocOutline } from "@/components/doc/DocOutline";
import { DocMarkdown } from "@/components/doc/DocMarkdown";
import {
  ArrowLeft,
  BookOpen,
  Check,
  Code2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { BackButton, NavPopover, useHoverPopover } from "@/components/nav/NavShell";
import { useDocViewPref, type DocWidth } from "@/lib/storymap/doc/use-doc-view-pref";

export interface DocViewDef {
  id: string;
  label: string;
  icon: LucideIcon;
  render: () => ReactNode;
  /**
   * true ⇒ a view sai da COLUNA DE LEITURA e ocupa a largura toda.
   *
   * A coluna estreita é o que faz um documento se ler bem; um QUADRO dentro dela fica espremido a
   * ponto de deixar de ser quadro. Quem decide é a view, não a tela — assim toda superfície que
   * ganhar um quadro herda o comportamento certo sem repetir a regra.
   */
  fullWidth?: boolean;
}

/**
 * A visão MARKDOWN, embutida no shell em vez de repetida em cinco telas: toda superfície de doc tem
 * a mesma dupla — o documento e a fonte que o gera. `write` ausente ⇒ a visão é só leitura (a
 * superfície não tem caminho de volta para a entidade); presente ⇒ o texto digitado volta pelo
 * mesmo commit do editor rico, e a barra de salvar do shell aparece igual.
 */
export interface DocMarkdownDef {
  read: () => string;
  write?: (markdown: string) => void;
  /** Muda ⇒ o texto é re-sedeado da fonte (o mesmo gesto do `editorEpoch` do editor rico). */
  epoch?: number;
}

export const MARKDOWN_VIEW_ID = "markdown";

/**
 * Uma ação da superfície no menu "…". Existe porque a página do card precisou absorver as ações que
 * só o drawer tinha (mover, sincronizar, refinar, reportar bug, descontinuar, excluir) — e o lugar
 * delas num documento é o overflow do topo, não uma barra de botões no rodapé.
 */
export interface DocMenuItem {
  key: string;
  /** separador — os demais campos são ignorados */
  divider?: boolean;
  label?: string;
  icon?: LucideIcon;
  hint?: string;
  /** linha destrutiva: vermelha, e por convenção abaixo de um separador */
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

/**
 * A folga do rodapé no CELULAR. A nav inferior é `fixed` e `md:hidden` (BoardHeader) — 57px medidos —,
 * então um `py-8` (32px) deixa o fim do documento PASSAR POR BAIXO dela: a última linha existe, rola,
 * e não há como alcançá-la. As telas irmãs (Ideias, Priorização, Inbox) já reservavam `pb-24`; as
 * superfícies de DOCUMENTO não, porque nasceram com a folga simétrica do `py-8`.
 *
 * Fica no shell, e não em cada tela, porque o defeito é do shell: seis superfícies (canvas, estilo,
 * posicionamento, vocabulário, card, card-novo) o herdavam de uma vez só.
 */
const BOTTOM_GUTTER = "pb-24 md:pb-8";

const WIDTH_PX: Record<DocWidth, number> = { narrow: 680, medium: 820, wide: 1040 };
const WIDTH_LABEL: Record<DocWidth, string> = { narrow: "Estreito", medium: "Médio", wide: "Largo" };
const WIDTHS: DocWidth[] = ["narrow", "medium", "wide"];

/**
 * The active view id: the saved id when it still names a real view, else `views[0]` — and "" when
 * there are no views at all. Pure so it's testable without mounting anything (see doc-shell.test.ts).
 */
export function resolveDefaultView(views: DocViewDef[], saved: string | null): string {
  if (saved && views.some((v) => v.id === saved)) return saved;
  return views[0]?.id ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DocToolbar — the reusable sub-topnav
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DocToolbarProps {
  /** Back arrow for page-style surfaces (card page, vocab detail). Absent ⇒ no arrow. */
  backHref?: string;
  /** Plain-text title. NEVER a link — the main topnav owns the navigation links. Optional: the
   *  INLINE mode drops it (the tab bar + document heading already name the surface). */
  title?: string;
  mode?: "read" | "edit";
  /** Absent ⇒ hide the Ler/Editar toggle. */
  onModeChange?: (m: "read" | "edit") => void;
  /** Absent ⇒ hide the "Pedir ao agente" button. */
  onAgentAsk?: () => void;
  agentBusy?: boolean;
  /** View switcher (2+ views). The toolbar only needs id/label/icon. */
  views?: Pick<DocViewDef, "id" | "label" | "icon">[];
  activeViewId?: string;
  onViewChange?: (id: string) => void;
  /** "…" menu item: Copiar Markdown (with inline feedback). */
  exportMarkdown?: () => string;
  /** "…" menu section: reading-column width. */
  width?: DocWidth;
  onWidthChange?: (w: DocWidth) => void;
  /** INLINE: render ONLY the action cluster (no header bar, no title/back). For tab surfaces that
   *  float the actions at the top of the document body instead of a third full-width bar. */
  inline?: boolean;
  /** A ação PRIMÁRIA da superfície, à esquerda do alternador de visões (a página do card põe
   *  "Mover para" aqui: é o gesto que faz o card andar, e não pertence a um overflow). */
  toolbarExtra?: ReactNode;
  /** Itens da superfície no menu "…", abaixo dos itens do próprio shell. */
  menuItems?: DocMenuItem[];
}

export function DocToolbar({
  backHref,
  title,
  mode,
  onModeChange,
  onAgentAsk,
  agentBusy,
  views = [],
  activeViewId,
  onViewChange,
  exportMarkdown,
  width,
  onWidthChange,
  inline,
  toolbarExtra,
  menuItems = [],
}: DocToolbarProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (!exportMarkdown) return;
    try {
      await navigator.clipboard.writeText(exportMarkdown());
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions, insecure context) — dev tool, fail silently.
    }
  };

  const overflow = useHoverPopover();
  const actionRows = menuItems.filter((item) => !item.divider);
  const hasMenu = !!exportMarkdown || (!!width && !!onWidthChange) || actionRows.length > 0;

  const actionCluster = (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        // `mb-6`: no modo INLINE a barra é o primeiro item do fluxo da coluna, e nada depois dela
        // trazia folga própria — o título do documento tem `mb-8` mas nenhuma margem no topo, o
        // quadro começa na borda do primeiro cartão e a tabela no cabeçalho. Medido: 0px de folga
        // visível nas TRÊS views. O aviso de validação só tornou o defeito ÓBVIO porque tem borda e
        // fundo — ele encostava na barra. A folga é da BARRA, não de cada view: assim toda superfície
        // (e toda view futura) nasce respirando, em vez de cada uma lembrar de reservar o espaço.
        inline ? "mb-6 justify-end" : "shrink-0",
      )}
    >
        {/* EDITAR é a ação primária da tela e mora AQUI, visível (correção 2026-08-01).
            Ela tinha sido empurrada para dentro do menu "…" quando "Editar com IA" virou o caminho
            primário — e o gesto mais óbvio de uma página de conteúdo ficou escondido atrás de três
            pontinhos. Com o markdown virando a fonte da verdade, editar o documento é o gesto
            central da tela: ele não pode custar dois cliques e uma descoberta. */}
        {onModeChange && (
          <button
            type="button"
            onClick={() => onModeChange(mode === "edit" ? "read" : "edit")}
            aria-pressed={mode === "edit"}
            className={cn(
              // O âmbar MOLDURA, não escreve. `text-accent` sobre `bg-accent/10` media 2.03:1 no tema
              // claro (medido) — o rótulo do gesto primário da tela era o texto menos legível dela.
              // A identidade do pacote já dizia como resolver: "hierarquia por tamanho/peso/espaço,
              // não por cor". A borda e o fundo âmbar seguem marcando qual é a ação; o texto é `fg`.
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition",
              mode === "edit"
                ? "border border-line bg-surface-hover text-fg"
                : "border border-accent/40 bg-accent/10 text-fg hover:bg-accent/20",
            )}
          >
            {mode === "edit" ? (
              <>
                <BookOpen className="h-3.5 w-3.5" /> Concluir
              </>
            ) : (
              <>
                <Pencil className="h-3.5 w-3.5" /> Editar
              </>
            )}
          </button>
        )}

        {onAgentAsk && (
          <button
            type="button"
            onClick={onAgentAsk}
            disabled={agentBusy}
            className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {agentBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Pedir ao agente
          </button>
        )}

        {toolbarExtra}

        {views.length > 1 && onViewChange && (
          <div className="flex items-center rounded-full border border-line bg-inset p-0.5">
            {views.map((v) => {
              const ViewIcon = v.icon;
              const isActive = v.id === activeViewId;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => onViewChange(v.id)}
                  title={v.label}
                  aria-label={v.label}
                  aria-pressed={isActive}
                  className={cn(
                    // `min-h-[30px]`: sem ele o botão SÓ-ÍCONE (a view inativa no celular) media 26px
                    // enquanto o ativo, que tem texto, media 30px — dois defeitos num: alvo de toque
                    // abaixo do piso do pacote, e alturas desiguais dentro da mesma pílula.
                    "flex min-h-[30px] items-center gap-1 rounded-full px-2.5 py-1.5 text-[12px] font-medium transition",
                    isActive ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
                  )}
                >
                  <ViewIcon className="h-3.5 w-3.5 shrink-0" />
                  {/* No CELULAR só a view ATIVA diz o nome; as outras são ícone. Com quatro rótulos o
                      alternador sozinho media 367px num viewport de 375 — ele tomava uma linha inteira e
                      empurrava o menu "…" para uma TERCEIRA, que ficava vazia à direita. Esconder o
                      rótulo do que não está selecionado devolve a linha sem custar orientação: quem
                      precisa saber onde está lê o rótulo aceso, e os demais têm `title`/`aria-label`. */}
                  <span className={cn(isActive ? "inline" : "hidden sm:inline")}>{v.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {hasMenu && (
          <div
            ref={overflow.ref}
            className="relative"
            onMouseEnter={overflow.openNow}
            onMouseLeave={overflow.closeSoon}
          >
            <button
              type="button"
              onClick={() => overflow.setOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={overflow.open}
              title="Mais opções"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-hover hover:text-fg",
                overflow.open && "bg-surface-hover text-fg",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {overflow.open && (
              <NavPopover align="right" label="Mais opções" className="w-48">
                {/* "Editar" NÃO mora mais aqui — virou botão primário no cluster acima. O menu fica
                    com o que é ocasional: copiar a fonte, largura, e as ações da superfície. */}
                {exportMarkdown && (
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] text-fg transition hover:bg-surface-hover"
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Code2 className="h-3.5 w-3.5 text-fg-muted" />}
                    {copied ? "Copiado ✓" : "Copiar Markdown"}
                  </button>
                )}
                {actionRows.length > 0 && (
                  <>
                    {!!exportMarkdown && <div className="my-1 h-px bg-line-muted" />}
                    {menuItems.map((item) =>
                      item.divider ? (
                        <div key={item.key} className="my-1 h-px bg-line-muted" />
                      ) : (
                        <button
                          key={item.key}
                          type="button"
                          disabled={item.disabled}
                          onClick={() => {
                            overflow.setOpen(false);
                            item.onClick?.();
                          }}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition disabled:opacity-50",
                            item.danger ? "hover:bg-danger/10" : "hover:bg-surface-hover",
                          )}
                        >
                          {item.icon && (
                            <item.icon
                              className={cn(
                                "mt-0.5 h-3.5 w-3.5 shrink-0",
                                item.danger ? "text-danger" : "text-fg-muted",
                              )}
                            />
                          )}
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn("block text-[12px]", item.danger ? "text-danger" : "text-fg")}
                            >
                              {item.label}
                            </span>
                            {item.hint && (
                              <span className="block text-[11px] leading-snug text-fg-subtle">{item.hint}</span>
                            )}
                          </span>
                        </button>
                      ),
                    )}
                  </>
                )}
                {width && onWidthChange && (
                  <>
                    <p className="px-1 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                      Largura
                    </p>
                    {WIDTHS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => {
                          onWidthChange(w);
                          overflow.setOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-1.5 py-1.5 text-left text-[12px] text-fg transition hover:bg-surface-hover"
                      >
                        {WIDTH_LABEL[w]}
                        {width === w && <Check className="h-3.5 w-3.5 text-accent" />}
                      </button>
                    ))}
                  </>
                )}
              </NavPopover>
            )}
          </div>
        )}
      </div>
  );

  // Modo INLINE (superfícies-tab): sem a barra `<header>` e sem título — a BlockTabs acima já nomeia a
  // ferramenta e o corpo já traz o heading; devolvemos só o cluster de ações para o caller flutuar no
  // topo do corpo do documento. Páginas de DETALHE (card/vocab, com backHref) seguem com a barra.
  if (inline) return actionCluster;

  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {backHref && (
          <BackButton
            fallbackHref={backHref}
            title="Voltar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            <ArrowLeft className="h-4 w-4" />
          </BackButton>
        )}
        <span className="min-w-0 truncate text-[13.5px] font-medium text-fg">{title}</span>
      </div>
      {actionCluster}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DocShell — toolbar + centred column + save bar
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DocShellProps {
  docType: string;
  /** Plain-text title for the toolbar (never a link — the main topnav owns links). */
  title: string;
  /** Back arrow for page-style surfaces (card page, vocab detail). */
  backHref?: string;
  /** views[0] = default when there is no (or an orphaned) saved preference. */
  views: DocViewDef[];
  /** Presente ⇒ o shell acrescenta a visão "Markdown" ao alternador (ver DocMarkdownDef). */
  markdown?: DocMarkdownDef;
  mode: "read" | "edit";
  /** Absent ⇒ hide the Editar/Ler toggle. */
  onModeChange?: (m: "read" | "edit") => void;
  /** Absent ⇒ hide "Copiar Markdown" in the "…" menu. */
  exportMarkdown?: () => string;
  /** Absent ⇒ hide the "Pedir ao agente" button. */
  onAgentAsk?: () => void;
  agentBusy?: boolean;
  /** default true */
  showWidthControl?: boolean;
  /** true ⇒ render the sticky navigation rail (DocOutline) beside the content on wide screens —
   *  the fullscreen single-scroll surfaces (card page) opt in; drawers/small docs don't need it. */
  outline?: boolean;
  dirty?: boolean;
  saving?: boolean;
  /** true ⇒ há mudança pendente, mas ela NÃO pode ser gravada (o documento está inválido). */
  saveDisabled?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
  /**
   * Uma faixa da superfície acima do conteúdo, dentro da coluna de leitura — onde o documento diz o
   * que há de errado com ele. Fica no shell (e não em cada tela) porque toda superfície de documento
   * validado precisa do mesmo lugar para isso, e cinco lugares diferentes seriam cinco desenhos.
   */
  banner?: ReactNode;
  /**
   * CONTROLLED view mode: when provided, the parent owns which view is active (it may even unmount
   * this shell for a view that brings its own chrome — the canvas grid does). Absent ⇒ the shell
   * resolves and persists the view itself via useDocViewPref.
   */
  viewId?: string;
  onViewChange?: (id: string) => void;
  /** Ação primária no sub-topnav (ver DocToolbarProps). */
  toolbarExtra?: ReactNode;
  /** Itens da superfície no menu "…" (ver DocMenuItem). */
  menuItems?: DocMenuItem[];
  children?: never;
}

export function DocShell({
  docType,
  title,
  backHref,
  views: authoredViews,
  markdown,
  mode,
  onModeChange,
  exportMarkdown,
  onAgentAsk,
  agentBusy,
  showWidthControl = true,
  outline = false,
  dirty,
  saving,
  saveDisabled,
  onSave,
  onDiscard,
  banner,
  viewId: controlledViewId,
  onViewChange,
  toolbarExtra,
  menuItems,
}: DocShellProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // A visão Markdown é do SHELL, não das telas: toda superfície de doc tem a mesma dupla
  // (documento ⇄ fonte), e repetir a fiação em cinco telas era o caminho para cinco variações dela.
  const views = useMemo(() => {
    if (!markdown) return authoredViews;
    const mdView: DocViewDef = {
      id: MARKDOWN_VIEW_ID,
      label: "Markdown",
      icon: Code2,
      render: () => (
        <DocMarkdown key={`md-${markdown.epoch ?? 0}`} value={markdown.read()} onChange={markdown.write} />
      ),
    };
    // Logo DEPOIS do documento, não no fim: a fonte é o par imediato dele. Onde há uma terceira
    // superfície (o Grid do canvas, o Estruturado do guia), ela continua sendo a última.
    return [authoredViews[0], mdView, ...authoredViews.slice(1)].filter(Boolean);
  }, [authoredViews, markdown]);

  const { viewId: savedViewId, setViewId: setSavedViewId, width, setWidth } = useDocViewPref(docType, {
    viewId: views[0]?.id ?? "",
    width: "medium",
  });
  const setViewId = onViewChange ?? setSavedViewId;
  const activeViewId =
    controlledViewId !== undefined
      ? controlledViewId
      : resolveDefaultView(views, savedViewId || null);
  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  // Superfície-TAB (sem backHref) ⇒ a barra `<header>` do DocToolbar é supérflua: a BlockTabs acima já
  // nomeia a ferramenta e o corpo já traz o heading. Nesses casos a toolbar vai INLINE (só o cluster de
  // ações, flutuando no topo do corpo). Detalhe (card/vocab, com backHref) mantém a barra com voltar+título.
  const inline = !backHref;
  // Na visão Markdown o par Ler/Editar não significa nada (a fonte já É editável, ou já é só
  // leitura): esconder o item evita o estado morto de "editar" um documento que não está na tela.
  const onDocModeChange = activeViewId === MARKDOWN_VIEW_ID ? undefined : onModeChange;
  const toolbar = (
    <DocToolbar
      backHref={backHref}
      title={title}
      mode={mode}
      onModeChange={onDocModeChange}
      onAgentAsk={onAgentAsk}
      agentBusy={agentBusy}
      views={views}
      activeViewId={activeViewId}
      onViewChange={setViewId}
      exportMarkdown={exportMarkdown}
      width={showWidthControl ? width : undefined}
      onWidthChange={showWidthControl ? setWidth : undefined}
      inline={inline}
      toolbarExtra={toolbarExtra}
      menuItems={menuItems}
    />
  );

  // Uma view de largura total ignora a preferência de coluna (ver DocViewDef.fullWidth).
  const columnMaxWidth = activeView?.fullWidth ? undefined : WIDTH_PX[width];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!inline && toolbar}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {outline ? (
          // Single scroll with a sticky rail: the outline navigates blocks/sub-blocks by anchor —
          // nothing collapses, the whole document stays one continuous scroll.
          <div className={cn("mx-auto flex w-full max-w-[1400px] items-start justify-center gap-8 px-4 pt-8 sm:px-8", BOTTOM_GUTTER)}>
            <aside className="sticky top-8 hidden max-h-[calc(100vh-160px)] overflow-y-auto xl:block">
              <DocOutline contentRef={contentRef} scrollRef={scrollRef} />
            </aside>
            <div ref={contentRef} className="w-full min-w-0" style={{ maxWidth: columnMaxWidth }}>
              {inline && toolbar}
              {banner}
              {activeView?.render()}
            </div>
          </div>
        ) : (
          <div className={cn("mx-auto w-full px-4 pt-8 sm:px-8", BOTTOM_GUTTER)} style={{ maxWidth: columnMaxWidth }}>
            {inline && toolbar}
            {banner}
            {activeView?.render()}
          </div>
        )}

        {dirty && (
          <div className="sticky bottom-0 z-20 flex items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:px-8">
            <span className={cn("text-[12.5px]", saveDisabled ? "text-danger" : "text-fg-muted")}>
              {saveDisabled ? "Corrija o que está marcado para poder salvar" : "Alterações não salvas"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDiscard}
                className="rounded-md border border-line px-3 py-1.5 text-[12.5px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
              >
                Descartar
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={saving || saveDisabled}
                title={saveDisabled ? "O documento está inválido — veja o aviso acima." : undefined}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-fg transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Salvar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
