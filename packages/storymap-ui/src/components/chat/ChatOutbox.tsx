"use client";

// A FILA DE SAÍDA e a TARJA de aviso — as duas peças de corpo que TODO chat usa, morando fora do cockpit.
//
// Por que num módulo próprio, e não dentro do CopilotChat de onde saíram: o núcleo compartilhado (ChatPanel)
// precisa das duas, e o cockpit do board é um CONSUMIDOR do núcleo. Deixá-las no CopilotChat faria o núcleo
// importar do seu próprio consumidor — um ciclo que o bundler resolve em silêncio e que quebra na hora em que
// alguém mudar a ordem de avaliação dos módulos. A regra: o que os dois usam mora abaixo dos dois.

import type { ReactNode } from "react";
import { Clock, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { BTN_GHOST, BTN_ICON, BUBBLE, DIVIDER, DOT, ICON, NOTICE_BAND, TXT, type Tone } from "@/components/copilot/ui";
import {
  OUTBOX_PAUSED_NOTICE,
  OUTBOX_SENDING_NOTICE,
  outboxItemLabel,
  outboxSummary,
  outboxWaitingNotice,
  type BusyReason,
  type OutboxItem,
} from "@/lib/storymap/copilot/outbox";

/**
 * A FILA DE SAÍDA, no corpo da conversa — o que o operador já mandou e ainda não saiu.
 *
 * Fica DEPOIS do transcript e ANTES do diário, na coluna da direita (é fala do operador), com bolha TRACEJADA e
 * tinta apagada: a forma diz "isto ainda não é conversa". A linha de estado acima diz por que ainda não saiu, e
 * cada bolha tem ✕ — a única maneira de um envio sair da fila sem ir ao agente é o operador decidir isso.
 *
 * Por que aqui e não dentro do `turns`: o poll near-live substitui o thread pelo transcript DURÁVEL do servidor
 * a cada mudança; um item de fila que morasse no thread piscaria para fora da tela a cada adoção. A fila é
 * estado do cliente até o servidor aceitá-la — e o render segue essa fronteira.
 */
export function OutboxList({
  items,
  paused,
  waitingReason,
  selfBusy,
  onRemove,
  onResume,
}: {
  items: OutboxItem[];
  paused: boolean;
  waitingReason: BusyReason | null;
  /** o turno DO PRÓPRIO operador está streamando ⇒ a fila espera por ele (não está "enviando"). */
  selfBusy: boolean;
  onRemove: (id: string) => void;
  onResume: () => void;
}) {
  if (!items.length) return null;
  // A linha de estado precisa ser VERDADEIRA nos quatro casos, senão ela vira ruído: pausada, esperando um
  // ocupado que o servidor nomeou, esperando o turno que o próprio operador começou, ou saindo agora.
  const state = paused
    ? OUTBOX_PAUSED_NOTICE
    : waitingReason
      ? outboxWaitingNotice(waitingReason)
      : selfBusy
        ? outboxWaitingNotice("turn-in-flight")
        : OUTBOX_SENDING_NOTICE;
  return (
    <div className="flex flex-col items-end gap-1.5" role="status" aria-live="polite">
      <div className={cn("flex max-w-full items-center gap-1.5 text-fg-subtle", TXT.meta)}>
        {paused ? <Clock className={ICON.inline} /> : <Loader2 className={cn(ICON.inline, "animate-spin text-accent")} />}
        <span className="truncate">
          {outboxSummary(items.length)} · {state}
        </span>
        {paused && (
          <button type="button" onClick={onResume} className={cn(BTN_GHOST, "text-fg-muted")}>
            retomar
          </button>
        )}
      </div>
      {items.map((item) => (
        <div key={item.id} className="flex max-w-full items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className={BTN_ICON}
            aria-label="Remover da fila"
            title="Remover da fila"
          >
            <X className={ICON.inline} />
          </button>
          <span className={cn(BUBBLE, "rounded-br-md border border-dashed border-line bg-transparent text-fg-muted")}>
            {outboxItemLabel(item)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A TARJA de aviso do topo do painel — no cockpit, o ciclo autônomo em voo.
 *
 * Antes eram duas tarjas pintadas inteiras, cada uma com sua paleta crua (`bg-amber-50/text-amber-700` e
 * `bg-indigo-50/text-indigo-700` — e o indigo nem existe na identidade). Agora superfície e tinta são neutras e o
 * ESTADO vive no ponto de `DOT[tone]`, a porta ÚNICA de cor do painel (copilot/ui.ts) — a mesma regra que o resto
 * do chat já seguia. Exportada porque o BANNER é um slot: quem tem o que avisar constrói a tarja com esta forma.
 */
export function NoticeBand({ tone, pulse, children }: { tone: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <div className={cn(DIVIDER, NOTICE_BAND)} role="status">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone], pulse && "animate-pulse")} />
      {children}
    </div>
  );
}
