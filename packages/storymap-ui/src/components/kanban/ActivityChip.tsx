"use client";

// A ATIVIDADE na 2ª barra do Kanban — o que os agentes (e você) fizeram no board, do mais recente para o mais antigo.
// O chip mostra só o último acontecimento (marca de quem agiu + card + frase + tempo) e «+N»; passar o mouse abre a
// lista na hora, e ela fecha com uma carência de 180 ms (dá para levar o mouse do chip até a lista); o clique FIXA a
// lista aberta. Clicar no card de uma linha filtra o Kanban por ele. No celular o chip vira um ícone com o contador.
//
// Os dados vêm de `getBoardActivityAction` (núcleo puro em lib/storymap/activity-feed.ts). Ao vivo: relê quando o
// Inbox do board muda (`inbox.changed`), quando um card deste board muda (SSE `card.*`) e a cada 60 s.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { History } from "lucide-react";
import { cn } from "@/lib/cn";
import { getBoardActivityAction } from "@/app/activity-actions";
import { ACTIVITY_WHO_LABEL, relativeShort, type ActivityItem } from "@/lib/storymap/activity-feed";
import { displayTitle } from "@/lib/storymap/display-title";
import { useStorymapEvents } from "@/components/RunnerStatusProvider";
import { useInboxChanged } from "@/components/inbox/useInboxChanged";
// o relógio da tela (0 no servidor e no 1º render: a hidratação não discorda), para «4 min» virar «5 min» sem releitura
import { useNow } from "@/components/inbox/useNow";
import { AgentMark } from "./AgentMark";
import { useDismiss } from "./KanbanFilterMenu";

const POLL_MS = 60_000;
const CLOSE_GRACE_MS = 180;

/** A atividade do board: lida ao montar, a cada minuto e quando algo do board muda. `failed` = nunca houve leitura boa. */
function useBoardActivity(boardId: string) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const r = await getBoardActivityAction(boardId).catch(() => null);
    if (r?.ok) {
      setItems(r.data);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, [boardId]);
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
  }, [load]);
  useInboxChanged(() => void load(), { boards: [boardId] });
  // `card.*` deste board: uma rajada de escritas (o motor move vários cards) vira UMA releitura
  const burst = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useStorymapEvents((ev) => {
    if (ev.boardId !== boardId || !ev.type.startsWith("card.")) return;
    clearTimeout(burst.current);
    burst.current = setTimeout(() => void load(), 600);
  });
  useEffect(() => () => clearTimeout(burst.current), []);
  return { items, failed };
}

/** A entrada da linha nova (desliza da esquerda). Folha única, içada pelo React 19. */
function TickStyles() {
  return (
    <style href="ah-activity-tick" precedence="default">{`
@keyframes ahActTickIn{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
.ah-act-tick{animation:ahActTickIn .5s ease-out}
@media (prefers-reduced-motion:reduce){.ah-act-tick{animation:none!important}}
`}</style>
  );
}

export interface ActivityChipProps {
  boardId: string;
  /** a pessoa clicou no card de uma linha: o Kanban busca/realça esse card. */
  onFocusCard: (cardId: string, title: string) => void;
  className?: string;
}

export function ActivityChip({ boardId, onFocusCard, className }: ActivityChipProps) {
  const { items, failed } = useBoardActivity(boardId);
  const now = useNow();
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const open = hover || pinned;
  useDismiss(open, () => {
    clearTimeout(timer.current);
    setHover(false);
    setPinned(false);
  }, ref);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Hover só com MOUSE: no toque o «enter» emulado abriria e o clique logo depois fixaria — o toque usa só o clique.
  const enter = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    setHover(true);
  };
  const leave = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(false), CLOSE_GRACE_MS);
  };
  const togglePin = () => {
    clearTimeout(timer.current);
    if (pinned) {
      setPinned(false);
      setHover(false);
    } else setPinned(true);
  };
  const focusCard = (it: ActivityItem) => {
    if (!it.cardId || !it.cardTitle) return;
    onFocusCard(it.cardId, it.cardTitle);
    setPinned(false);
    setHover(false);
  };

  const list = items ?? [];
  const latest = list[0];
  const more = list.length > 1 ? `+${list.length - 1}` : "";
  const empty = items !== null && list.length === 0;
  const chipText = items === null ? (failed ? "Atividade indisponível agora" : "Lendo a atividade…") : empty ? "Nenhuma atividade ainda" : null;
  const latestTitle = latest ? `${latest.cardTitle ? displayTitle(latest.cardTitle) : "Board"} — ${latest.text} (${relativeShort(latest.at, now)})` : chipText ?? "";

  return (
    <div ref={ref} onPointerEnter={enter} onPointerLeave={leave} className={cn("relative min-w-0", className)}>
      <TickStyles />
      {/* computador: o último acontecimento por extenso */}
      <button
        type="button"
        onClick={togglePin}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={latestTitle || "Atividade dos agentes"}
        className={cn(
          "hidden h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[12.5px] text-fg-muted transition hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:flex",
          open && "bg-inset",
        )}
      >
        {latest ? (
          // O TEMPO nunca sai e o TÍTULO não some: o título do card não encolhe (só trunca se passar do teto, ~45% do
          // chip), quem cede a largura é a frase, que trunca; o tempo (e o «+N», logo depois deste bloco) ficam fixos.
          // Antes os dois encolhiam juntos e um título curto virava «Bo…». O bloco NÃO estica (`flex-1` deixava um vão
          // largo entre o tempo e o «+N»): o tempo e o «+N» vêm colados ao texto, como no desenho («agora +7»).
          <span key={latest.id} className="ah-act-tick flex min-w-0 shrink items-center gap-2 whitespace-nowrap">
            <span className="flex-none">
              <AgentMark kind={latest.who} size={16} />
            </span>
            <b className="max-w-[45%] shrink-0 truncate font-semibold text-fg">{latest.cardTitle ? displayTitle(latest.cardTitle) : "Board"}</b>
            <span className="min-w-0 flex-auto truncate">{latest.text}</span>
            <span className="flex-none text-[11.5px] text-fg-subtle">{relativeShort(latest.at, now)}</span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg-subtle">{chipText}</span>
        )}
        {more && <span className="flex-none text-[12px] text-fg-subtle">{more}</span>}
      </button>
      {/* celular: ícone com o contador (alvo de toque de 40px) */}
      <button
        type="button"
        onClick={togglePin}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Atividade dos agentes${list.length ? ` (${list.length})` : ""}`}
        title="Atividade dos agentes"
        className={cn(
          "flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg px-2 text-fg-muted transition hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden",
          open && "bg-inset",
        )}
      >
        {latest ? <AgentMark kind={latest.who} size={16} /> : <History className="h-4 w-4" aria-hidden />}
        {list.length > 0 && <span className="text-[12px] font-semibold tabular-nums text-fg">{list.length}</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Atividade dos agentes"
          className="absolute right-0 top-full z-40 mt-1.5 flex w-[min(440px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[0_14px_36px_rgba(15,15,15,.16)] md:left-0 md:right-auto"
        >
          <div className="flex items-center gap-2 px-3.5 pb-2 pt-3">
            {/* numa linha só: no celular (358px de popover) o subtítulo sai — com ele o cabeçalho quebrava em
                dois blocos de duas linhas ao lado do botão */}
            <span className="whitespace-nowrap text-[13px] font-semibold text-fg">Atividade dos agentes</span>
            <span className="hidden whitespace-nowrap text-[12px] text-fg-subtle sm:inline">mais recente primeiro</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={togglePin}
              className="h-10 rounded-md border border-line bg-surface px-2 text-[12px] text-fg-muted transition hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:h-6"
            >
              {pinned ? "Recolher" : "Fixar aberto"}
            </button>
          </div>
          <div className="max-h-[min(380px,calc(100dvh-var(--ah-topbar-h,52px)-var(--jido-composer-h,0px)-140px))] overflow-y-auto px-1.5 pb-1.5">
            {list.length === 0 ? (
              <p className="px-2 py-3 text-[12.5px] text-fg-subtle">{chipText}</p>
            ) : (
              <ol className="flex flex-col">
                {list.map((it, i) => (
                  <li
                    key={it.id}
                    className={cn("grid grid-cols-[20px_minmax(0,1fr)_52px] items-start gap-2.5 rounded-lg px-2 py-2.5", i > 0 && "border-t border-inset", i === 0 && "ah-act-tick")}
                  >
                    <span className="pt-px">
                      <AgentMark kind={it.who} size={18} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {it.cardId && it.cardTitle ? (
                        <button
                          type="button"
                          onClick={() => focusCard(it)}
                          title="Mostrar este card no Kanban"
                          // o título QUEBRA linha (o desenho deixa o link do card inteiro, sublinhado), nunca «…»
                          className="w-fit max-w-full text-left text-[12.5px] font-semibold leading-snug text-fg underline [overflow-wrap:anywhere] max-md:-my-3 max-md:py-3 decoration-line-emphasis underline-offset-[3px] hover:decoration-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {displayTitle(it.cardTitle)}
                        </button>
                      ) : (
                        <b className="text-[12.5px] font-semibold text-fg">Board</b>
                      )}
                      <span className="text-[12.5px] leading-snug text-fg-muted">{it.text}</span>
                      <span className="text-[11px] text-fg-subtle">{ACTIVITY_WHO_LABEL[it.who]}</span>
                    </span>
                    <span className="pt-px text-right text-[11.5px] text-fg-subtle">{relativeShort(it.at, now)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
