"use client";

// O DIÁRIO do Jido autônomo — um RECALL enxuto do que ele fez e do que decidiu NÃO fazer.
//
// ONDE ele vive (e por que mudou): era um BLOCO NO CORPO da conversa (slot afterTurns), depois do último
// turno — título em caixa alta, filete e ~60px de altura permanentes, misturado às mensagens. Duas coisas
// erradas nisso: (1) ele roubava do transcript o espaço que é o recurso escasso do painel, e (2) ele não é
// conversa — ninguém falou aquilo com você. Agora é uma FAIXA de uma linha acima do composer (fora do
// transcript, que rola por baixo dela), mostrando só a decisão MAIS RECENTE; um toque abre o histórico com
// rolagem PRÓPRIA. E ela só existe quando o board está em modo AUTÔNOMO — em modo Chat o Jido não age
// sozinho, então o diário é história parada: ela continua a um hover de distância, no balão do mascote no
// topnav.
//
// É um LOG para escanear de relance, não onde a substância mora: cada linha é curta (ícone + frase capada +
// horário), com a MESMA gramática visual das tool-calls do thread. Três regras (puras, em activity-view.ts) o
// mantêm enxuto:
//   1. TIER por tipo — trabalho (finished/acted), atenção (asked/refused/handed-back) e erro se destacam; o
//      ruído de fundo (woke/scheduled/stood-down) recua em cor mais fraca. O cliente pinta por tier, nunca por
//      regex no texto — por isso quem precisa de destaque ganha um KIND próprio, não uma exceção no render:
//      `handed-back` ("desisti, é seu, re-arme") vinha como `stood-down` e era pintado como ruído, e
//      `scheduled` ("vou olhar em Ns") vinha como `woke` e era pintado como ação.
//   2. COLAPSO de repetidos — "Fiquei de fora…" a cada tick lia como spam e empurrava o resto para baixo; corridas
//      consecutivas idênticas viram UMA linha com contador ("×4 desde 17:13").
//   3. RESUMO por entrada — o texto é capado (~250) com o completo no tooltip.
// Mostra os grupos mais recentes (teto pequeno para não empurrar as mensagens do operador); o restante fica atrás
// de "ver histórico", com rolagem PRÓPRIA. Ordem DECRESCENTE (o mais novo em cima).

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Ban, Check, ChevronDown, Clock, Hand, Moon, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { copilotActivityAction } from "@/app/copilot-actions";
import type { CopilotActivityEntry, CopilotActivityKind } from "@/lib/storymap/copilot/activity";
import {
  ACTIVITY_MAX_ENTRIES,
  type ActivityGroup,
  type ActivityTier,
  diarySentence,
  groupActivity,
  summarizeEntry,
  tierOf,
} from "@/lib/storymap/copilot/activity-view";

/**
 * Quantas entradas o feed busca. É o MESMO teto com que o servidor poda o jsonl (ACTIVITY_MAX_ENTRIES): pedir
 * mais do que se armazena é pedir o que não existe, e armazenar mais do que se mostra é acumular lixo. Um número.
 */
const FETCH_LIMIT = ACTIVITY_MAX_ENTRIES;
/** Teto de caracteres de cada linha do diário (o texto completo vai no tooltip). */
const ENTRY_MAX_CHARS = 250;

const ICON: Record<CopilotActivityKind, typeof Zap> = {
  woke: Zap, // disparou de verdade
  scheduled: Clock, // só marcou horário — relógio, não raio: promessa não usa o ícone de ação
  "stood-down": Moon,
  finished: Check,
  acted: Check,
  asked: Hand,
  "handed-back": Hand, // o mesmo ícone do "preciso de você" — porque é exatamente isso
  refused: Ban,
  error: AlertTriangle,
};

/** Cor do ÍCONE por tipo (o sinal por evento). */
const TONE: Record<CopilotActivityKind, string> = {
  woke: "text-accent",
  scheduled: "text-fg-subtle", // recuado: o raio em cor de destaque era o que fazia a promessa parecer trabalho
  "stood-down": "text-fg-subtle",
  finished: "text-emerald-700 dark:text-emerald-400",
  acted: "text-emerald-700 dark:text-emerald-400",
  asked: "text-amber-700 dark:text-amber-400",
  "handed-back": "text-amber-700 dark:text-amber-400", // âmbar de "sua vez", igual ao asked
  refused: "text-rose-600 dark:text-rose-400",
  error: "text-rose-600 dark:text-rose-400",
};

/** Cor do TEXTO por tier: o ruído (idle) recua; trabalho/atenção/erro ganham a tinta cheia. */
const TIER_TEXT: Record<ActivityTier, string> = {
  work: "text-fg-muted",
  attention: "text-fg",
  error: "text-fg",
  idle: "text-fg-subtle",
};

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Uma decisão (ou uma corrida colapsada delas): ícone + frase capada + contador + horário. */
function ActivityRow({ group }: { group: ActivityGroup }) {
  const e = group.entry;
  const Icon = ICON[e.kind] ?? Zap;
  const tier = tierOf(e.kind);
  // FRASE CORRIDA primeiro, cap depois — nesta ordem. Capar antes de achatar gastava os 250 chars com o cerco
  // markdown (`##`, `**`, pipes de tabela) e podia cortar no meio de uma tabela, deixando um pipe órfão na linha.
  const sentence = diarySentence(e.text);
  const short = summarizeEntry(sentence, ENTRY_MAX_CHARS);
  // o tooltip carrega a frase COMPLETA (achatada também — um title com \n e tabela não é legível como tooltip).
  const fullTitle = e.detail ? `${sentence} · ${e.detail}` : sentence;
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-snug" title={fullTitle}>
      <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", TONE[e.kind] ?? "text-fg-subtle")} />
      <span className={cn("min-w-0 flex-1", TIER_TEXT[tier])}>
        {short}
        {e.detail && <span className="ml-1 text-fg-subtle">· {e.detail}</span>}
        {group.count > 1 && (
          <span className="ml-1 whitespace-nowrap text-fg-subtle">
            ×{group.count} desde {hhmm(group.sinceAt)}
          </span>
        )}
      </span>
      <span className="shrink-0 tabular-nums text-[11px] text-fg-subtle">{hhmm(e.at)}</span>
    </div>
  );
}

export function CopilotActivityFeed({ boardId, pollMs = 10_000 }: { boardId: string; pollMs?: number }) {
  const [entries, setEntries] = useState<CopilotActivityEntry[]>([]);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    copilotActivityAction(boardId, FETCH_LIMIT)
      .then((e) => setEntries(e ?? []))
      .catch(() => {});
  }, [boardId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, Math.max(3_000, pollMs));
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  // A action devolve em ordem CRONOLÓGICA (o jsonl é append-only); aqui o mais novo vem primeiro e as corridas
  // idênticas consecutivas colapsam numa linha com contador.
  const groups = useMemo(() => groupActivity([...entries].reverse()), [entries]);

  if (!groups.length) return null;
  // A FAIXA mostra a decisão mais recente e só ela: é o "o que ele fez por último", que é o que se olha de
  // relance. O anterior é consulta — e consulta mora atrás do toque, com rolagem própria.
  const newest = groups[0];
  const e = newest.entry;
  const Icon = ICON[e.kind] ?? Zap;
  const sentence = diarySentence(e.text);

  return (
    <div className="shrink-0 border-t border-line bg-inset">
      {/* ABERTA, a mesma linha vira o TÍTULO da seção — não a repetição da 1ª entrada. Manter a frase aqui
          com a lista logo abaixo mostrava a decisão mais recente duas vezes na mesma tela. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Diário do Jido autônomo — o que ele fez e o que decidiu NÃO fazer. Toque para ver o histórico."
        className="flex w-full items-center gap-1.5 px-4 py-1.5 text-left transition hover:bg-surface-hover"
      >
        {open ? (
          <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
            Jido autônomo · {groups.length} {groups.length === 1 ? "decisão" : "decisões"}
          </span>
        ) : (
          <>
            <Icon className={cn("h-3 w-3 shrink-0", TONE[e.kind] ?? "text-fg-subtle")} />
            <span className={cn("min-w-0 flex-1 truncate text-[11px]", TIER_TEXT[tierOf(e.kind)])}>{sentence}</span>
            {newest.count > 1 && <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">×{newest.count}</span>}
            <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">{hhmm(e.at)}</span>
          </>
        )}
        <ChevronDown className={cn("h-3 w-3 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>

      {/* teto de altura + rolagem PRÓPRIA: o histórico nunca empurra o composer para fora da tela. */}
      {open && (
        <div className="max-h-48 space-y-1 overflow-y-auto border-t border-line-muted px-4 py-2">
          {groups.map((g) => (
            <ActivityRow key={g.key} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}
