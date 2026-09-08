"use client";

// O MENU DO SISTEMA — o conteúdo do ⚙ (desktop) e do sheet "Mais" (celular), escrito UMA vez.
//
// Antes eram duas listas paralelas dentro de `BoardHeader` (OverflowMenu + MoreTab) que precisavam
// ser editadas em par para não divergir — e já divergiam: a Lixeira só existia no desktop, o modo
// econômico tinha dois desenhos de switch, o tema tinha dois tamanhos de linha. Aqui a lista é UMA;
// o INVÓLUCRO (popover no desktop, bottom-sheet no celular) é do chamador.
//
// A organização é por ESCOPO — do mais local ao mais global —, porque era esse o embaralhamento
// antigo: um menu anunciado como "gestão DESTE board" guardava preferência de NAVEGADOR (som/push),
// um ajuste que vale para o PIPELINE INTEIRO (modo econômico) e utilitários do APP (tema/recarregar),
// todos com o mesmo peso visual. Agora cada seção declara o seu alcance no cabeçalho ("neste
// navegador", "todos os boards") — ninguém mais precisa adivinhar se um toggle vale só aqui.
//
// O que SAIU deste menu (e para onde):
//   • filtros + "detalhes dos cards" → a barra da própria view (`nav/ViewControls`): controle de
//     conteúdo mora junto do conteúdo, e um filtro ligado deixa de ficar escondido atrás de um ícone
//     (o badge no gatilho era um remendo para o esconderijo);
//   • "Atividade recente" → o diário do Jido (`copilot/CopilotActivityFeed`), que é durável; a lista
//     daqui era memória volátil — nascia vazia a cada F5, sumia ao fechar o menu e, por viver num
//     `useState` do header sempre montado, re-renderizava a barra a cada evento SSE;
//   • "Terminal (shell VPS)" → já era um medidor PERMANENTE do topnav (`TerminalChip`, com a lista
//     de sessões); no celular ele continua no sheet, onde não há chip.
//
// O que ENTROU (e por quê): as TELAS do Sistema — Orquestração e Métricas — que moravam no popover do
// bloco Software, ao lado do Kanban. Elas não são etapa do fluxo de produto; são a oficina. Com elas
// aqui, o menu deixa de ser "o resto" e passa a ser a porta ÚNICA da máquina: as três telas, com o
// mesmo peso e o mesmo alcance declarado das demais linhas. Antes a Configuração tinha TRÊS portas
// (este menu, o popover do bloco e uns cartões de atalho dentro da própria Configuração) — e nenhuma
// delas dizia que as outras existiam.
//
// A ordem das seções segue o ESCOPO, do mais local ao mais global: as telas deste board, depois o que
// vale para o app inteiro (Processos), depois os avisos deste navegador, depois o pipeline todo.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Bell,
  BellOff,
  Coins,
  Cpu,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { getEconomyModeAction, setEconomyModeAction } from "@/app/actions";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/useTheme";
import { SISTEMA_GROUP } from "@/components/nav/nav-groups";
import type { BoardNotifications } from "@/components/notifications/NotificationCenter";

/**
 * O modo econômico é um ajuste do RUNNER (storymap/settings.yaml), não deste board: ligado, todo o
 * pipeline cai para sonnet/high e harness-refine/fix deixam de rodar sozinhos (~55% menos custo). Por
 * isso o estado é lido FORA do menu (o chamador o mantém): assim o gatilho ⋯ consegue mostrar que
 * ele está ativo com o menu FECHADO — antes essa mudança silenciosa de qualidade era invisível.
 */
export interface EconomyMode {
  /** `null` enquanto a leitura inicial não voltou (o switch nasce desabilitado). */
  enabled: boolean | null;
  pending: boolean;
  toggle: () => void;
}

/**
 * `active` = este consumidor precisa do valor AGORA. O ⋯ do desktop precisa sempre (o ponto do
 * gatilho depende dele); o sheet do celular só quando abre — e ele fica MONTADO no desktop (só
 * escondido por `md:hidden`), então sem esta porta a leitura sairia duas vezes por página.
 */
export function useEconomyMode(active = true): EconomyMode {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!active) return;
    let alive = true;
    getEconomyModeAction().then((r) => {
      if (alive && r.ok) setEnabled(r.data!.economyMode);
    });
    return () => {
      alive = false;
    };
  }, [active]);
  const toggle = useCallback(() => {
    setEnabled((cur) => {
      const next = !cur;
      startTransition(async () => {
        const r = await setEconomyModeAction({ enabled: next });
        if (!r.ok) setEnabled(!next); // reverte só o que falhou
      });
      return next; // otimista
    });
  }, []);
  return { enabled, pending, toggle };
}

/**
 * Navegação por teclado de menu (WAI-ARIA): ao abrir, o foco cai no primeiro item; ↑/↓ percorrem,
 * Home/End vão às pontas. Devolve o ref que deve embrulhar os itens. Existia `aria-haspopup` e
 * Escape, mas o menu era inalcançável sem mouse — abria e o foco ficava no gatilho.
 */
export function useMenuKeyboard(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const items = () =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-menuitem]")).filter(
        (el) => !el.hasAttribute("disabled"),
      );
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      const list = items();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      const go = (n: number) => {
        e.preventDefault();
        list[(n + list.length) % list.length]?.focus();
      };
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(list.length - 1);
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [open]);
  return ref;
}

/**
 * As linhas do menu do board. Sem os filtros e sem o feed: só COMANDOS, agrupados pelo alcance de
 * cada um. Densidade única (13px / linha de 36px) para desktop e celular — o alvo de toque antigo
 * (26px) ficava abaixo do mínimo confortável e obrigava a um segundo desenho no sheet.
 */
export function BoardMenu({
  boardId,
  notifications: n,
  economy,
  trashCount,
  onOpenTrash,
  onRefresh,
  onNavigate,
}: {
  boardId: string;
  notifications: BoardNotifications;
  economy: EconomyMode;
  trashCount: number;
  onOpenTrash: () => void;
  onRefresh: () => void;
  /** fecha o invólucro quando o item navega para outra página. */
  onNavigate: () => void;
}) {
  const { theme, toggle: toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const pushBlocked = n.pushState === "unsupported" || n.pushState === "denied" || n.pushBusy;

  return (
    <div className="flex flex-col">
      {/* As TELAS do Sistema saem de `SISTEMA_GROUP` — a MESMA fonte que monta a barra de abas dentro
          delas. Uma lista escrita à mão aqui divergiria da barra no primeiro item novo, que é
          exatamente como a Lixeira ficou anos só no desktop. */}
      <MenuSection label="Sistema" meta="este board">
        {SISTEMA_GROUP.items.map((it) => (
          <MenuLink
            key={it.id}
            href={it.href(boardId)}
            icon={it.icon}
            label={it.label}
            hint={it.hint}
            onClick={onNavigate}
          />
        ))}
        <MenuAction
          icon={Trash2}
          label="Lixeira"
          hint="Cards arquivados — dá para reviver"
          badge={trashCount > 0 ? trashCount : undefined}
          onClick={onOpenTrash}
        />
      </MenuSection>

      {/* A máquina não é deste board: os runs headless, a fila de merge e a saúde da VPS são do APP
          inteiro. Fica aqui porque a pergunta ("por que meu card não anda?") nasce olhando um board —
          e o cabeçalho avisa o alcance antes do clique. */}
      <MenuSection label="Máquina" meta="todos os boards">
        <MenuLink
          href="/processes"
          icon={Cpu}
          label="Processos"
          hint="Runs ativos, falhas e saúde da VPS"
          onClick={onNavigate}
        />
      </MenuSection>

      {/* Os três canais do MESMO aviso, na MESMA gramática (som · navegador · celular). Antes cada
          um se descrevia numa gramática diferente ("Som a cada mudança" / "Notificação do sistema" /
          "Push no celular (app)") e o que decidia a escolha — QUANDO cada canal alcança você — só
          existia no `title`, invisível no toque. Agora é a linha de baixo de cada um. */}
      {/* O `meta` diz as DUAS coisas que decidem se um aviso chega até você: ONDE valem estes botões
          (este navegador) e O QUE o modo do Jido deixa passar por eles. A segunda metade era invisível
          — trocar o modo mudava o volume dos avisos sem nada na tela dizer isso. */}
      <MenuSection label="Notificações" meta={`neste navegador · ${n.alertPolicy.toLowerCase()}`}>
        <MenuSwitch
          icon={n.soundOn ? Volume2 : VolumeX}
          label="Som"
          hint="Toca a cada mudança no board"
          on={n.soundOn}
          onToggle={n.toggleSound}
        />
        <MenuSwitch
          icon={n.webOn ? Bell : BellOff}
          label="No navegador"
          hint={n.webSupported ? "Avisa com a aba em segundo plano" : "Este navegador não suporta"}
          on={n.webOn}
          onToggle={n.toggleWeb}
          disabled={!n.webSupported}
        />
        <MenuSwitch
          icon={Smartphone}
          label="No celular"
          hint={n.pushHint}
          on={n.pushState === "subscribed"}
          onToggle={n.togglePush}
          disabled={pushBlocked}
        />
      </MenuSection>

      {/* Alcance GLOBAL — está aqui por ser o knob que o operador mais alterna, mas o cabeçalho diz
          em voz alta que ele não é deste board (é o runner inteiro). */}
      <MenuSection label="Pipeline" meta="todos os boards">
        <MenuSwitch
          icon={Coins}
          tone="warn"
          label="Modo econômico"
          hint={
            economy.enabled
              ? "Tudo em sonnet/high · ~55% menos custo"
              : "Modelos originais — opus onde configurado"
          }
          on={economy.enabled === true}
          onToggle={economy.toggle}
          disabled={economy.pending || economy.enabled === null}
        />
      </MenuSection>

      {/* Utilitários do APP — pequenos de propósito: são os itens de menor frequência do menu, e o
          rodapé em duas colunas os tira da fila principal sem escondê-los. */}
      <div className="mt-1.5 flex items-center gap-1 border-t border-line-muted pt-1.5">
        <MenuFootAction
          icon={isDark ? Sun : Moon}
          label={isDark ? "Tema claro" : "Tema escuro"}
          onClick={toggleTheme}
        />
        <MenuFootAction
          icon={RefreshCw}
          label="Recarregar"
          title="Relê os cards do disco (o board já se atualiza sozinho a cada evento)"
          onClick={onRefresh}
        />
      </div>
    </div>
  );
}

/** Um grupo do menu. O `meta` é o ALCANCE — a informação que faltava para o operador saber o que
 *  um toggle atinge sem precisar abrir a documentação. */
function MenuSection({ label, meta, children }: { label: string; meta?: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5 flex flex-col border-t border-line-muted pt-1.5 first:mt-0 first:border-t-0 first:pt-0">
      <p className="flex items-baseline gap-1.5 px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
        {label}
        {meta && <span className="font-normal normal-case tracking-normal text-fg-subtle/80">· {meta}</span>}
      </p>
      {children}
    </div>
  );
}

/** A linha base: 36px de alvo, ícone de 16px, rótulo 13px e um `hint` de 11px que diz o efeito. */
const ROW =
  "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none";

function RowBody({
  icon: Icon,
  iconTone,
  label,
  hint,
  trailing,
}: {
  icon: LucideIcon;
  iconTone?: string;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <>
      <Icon className={cn("h-4 w-4 shrink-0", iconTone ?? "text-fg-subtle")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{label}</span>
        {/* O hint QUEBRA (não trunca): ele é o motivo da escolha — cortado com reticências vira
            enfeite. O rótulo, esse sim, trunca: é curto por contrato. */}
        {hint && <span className="block text-[11px] leading-tight text-fg-subtle">{hint}</span>}
      </span>
      {trailing}
    </>
  );
}

function MenuLink({
  href,
  icon,
  label,
  hint,
  onClick,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <Link href={href} role="menuitem" data-menuitem onClick={onClick} className={ROW}>
      <RowBody icon={icon} label={label} hint={hint} />
    </Link>
  );
}

function MenuAction({
  icon,
  label,
  hint,
  badge,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" data-menuitem onClick={onClick} className={ROW}>
      <RowBody
        icon={icon}
        label={label}
        hint={hint}
        trailing={
          badge != null ? (
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-surface-hover px-1.5 text-[11px] font-semibold tabular-nums text-fg-muted">
              {badge}
            </span>
          ) : undefined
        }
      />
    </button>
  );
}

/** UM switch para o menu inteiro (som, sistema, push, econômico) — antes eram dois desenhos quase
 *  iguais em arquivos diferentes. `role=menuitemcheckbox` + `aria-checked` para o leitor de tela
 *  anunciar o ESTADO, que o `<button>` mudo de antes não dizia. */
function MenuSwitch({
  icon,
  label,
  hint,
  on,
  onToggle,
  disabled,
  tone = "positive",
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
  tone?: "positive" | "warn";
}) {
  const accent = tone === "warn" ? "bg-amber-500" : "bg-emerald-500";
  const iconOn = tone === "warn" ? "text-amber-500" : "text-emerald-700 dark:text-emerald-400";
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      data-menuitem
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={cn(ROW, disabled && "cursor-not-allowed opacity-60 hover:bg-transparent")}
    >
      <RowBody
        icon={icon}
        iconTone={on && !disabled ? iconOn : undefined}
        label={label}
        hint={hint}
        trailing={
          <span
            aria-hidden
            className={cn(
              "inline-flex h-[18px] w-8 shrink-0 items-center rounded-full p-0.5 transition",
              on && !disabled ? accent : "bg-line-emphasis",
            )}
          >
            <span className={cn("h-3.5 w-3.5 rounded-full bg-white shadow-sm transition", on && "translate-x-3.5")} />
          </span>
        }
      />
    </button>
  );
}

/** Utilitário do rodapé: meia-largura, sem hint — o peso visual conta a frequência de uso. */
function MenuFootAction({
  icon: Icon,
  label,
  title,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menuitem
      title={title}
      onClick={onClick}
      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg focus-visible:bg-surface-hover focus-visible:outline-none"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      {label}
    </button>
  );
}
