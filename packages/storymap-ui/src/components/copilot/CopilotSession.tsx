"use client";

// A SESSÃO da conversa: quanto de contexto já foi, quantos turnos, quanto custou — e as ações que esses números
// justificam (compactar / começar de novo / verbosidade).
//
// Antes isso era uma FAIXA PERMANENTE no topo do chat: ~34px de régua com barra, %, turnos, custo e dois botões,
// visíveis o tempo todo. Só que nada ali muda a cada segundo e nenhuma daquelas ações é frequente — era chrome
// permanente pagando aluguel numa tela de notebook, onde a altura do corpo é o recurso escasso.
//
// Agora a informação se divide pelo que ela É:
//  • CONTÍNUA e de relance (a pressão de contexto) → `ContextRing`: um ANEL de 16px no composer, ao lado do
//    anexo — o medidor onde Claude/ChatGPT o põem. (Já foi uma barra de 3px sob o header, o `ContextRail`:
//    custava pouca altura e muita leitura — um filete atravessando o painel lê como divisória, não como
//    medidor. Aposentado.)
//  • CONSULTÁVEL (os números exatos) e RARA (as ações) → `SessionMenu`, que agora ABRE PELO PRÓPRIO ANEL: o
//    ícone que mostra o estado da conversa é o mesmo que dá acesso ao que fazer com ela.
//
// Nada foi removido: os mesmos números, as mesmas ações, um clique de distância.

import { useCallback, useEffect, useState } from "react";
import { Gauge, Loader2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { BAR, ICON, RING, type Tone } from "./ui";
import { MenuBlock, MenuItem, MenuSep, Popover } from "./Popover";
import { onCopilotSessionChanged } from "./meter-bus";
import { copilotSessionMeterAction, type CopilotSessionMeter as Meter } from "@/app/copilot-actions";
import { CHAT_CONTEXT_WINDOW, contextPressure, formatAge, formatTokens } from "@/lib/storymap/copilot/copilot-status";
import type { HitlResponseMode } from "@/lib/storymap/hitl/types";

export interface SessionState {
  meter: Meter | null;
  /** 0–100 da janela do MODELO (não de uma constante). */
  pct: number;
  tone: Tone;
  advice: string;
  idleMs: number;
}

/**
 * Lê o medidor da sessão e o mantém fresco. Uma leitura só — o rail e o menu bebem daqui.
 *
 * `view` é a RAIA: cada tela tem a sua conversa, com contexto, turnos e custo próprios (o servidor já resolvia
 * por raia — `copilotSessionMeterAction(boardId, view)`; era o cliente que só sabia pedir a do board). Sem ele, o
 * anel de uma conversa de tela media a conversa do Jido do board: dois números diferentes no mesmo lugar da tela.
 */
export function useSessionMeter(
  boardId: string,
  active: boolean,
  onPressure?: (tone: "ok" | "warn" | "danger") => void,
  view?: string,
): SessionState {
  const [meter, setMeter] = useState<Meter | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(() => {
    copilotSessionMeterAction(boardId, view)
      .then(setMeter)
      .catch(() => {});
  }, [boardId, view]);

  // Re-lê quando o turno TERMINA (é aí que as stats mudam) e a cada 60s (p/ a idade envelhecer sozinha).
  useEffect(() => {
    refresh();
  }, [refresh, active]);
  // …E quando a sessão muda FORA do ciclo de turno — "Nova conversa"/"Compactar". Sem isto a barra seguia
  // mostrando o contexto da conversa que o operador acabou de descartar até o próximo turno (ver meter-bus.ts).
  useEffect(() => onCopilotSessionChanged((b) => b === boardId && refresh()), [boardId, refresh]);
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // a janela vem do SERVIDOR, derivada do modelo que o turno realmente roda (1M só na variante `[1m]`).
  const windowTokens = meter?.contextWindow || CHAT_CONTEXT_WINDOW;
  const { pct, tone, advice } = contextPressure(meter?.contextTokens ?? 0, windowTokens);

  useEffect(() => {
    if (meter) onPressure?.(tone);
  }, [meter, tone, onPressure]);

  return {
    meter,
    pct,
    tone,
    advice,
    idleMs: meter ? nowMs - new Date(meter.lastTurnAt).getTime() : 0,
  };
}

/** O raio do anel na viewBox de 16 — o resto (circunferência, offset) sai daqui. */
const RING_R = 6;
const RING_C = 2 * Math.PI * RING_R;

/**
 * A PRESSÃO DE CONTEXTO como ÍCONE — o anel que enche, no lugar onde Claude e ChatGPT o põem: junto do
 * composer, não atravessado na tela.
 *
 * Antes era uma barra de 3px de largura TOTAL sob o header (`ContextRail`). Ela custava quase nada de altura,
 * mas custava LEITURA: um filete colorido cruzando o painel inteiro lê como divisória ou como barra de
 * carregamento — o operador não associa "a linha verde embaixo do header" a "a sessão está enchendo". Um anel
 * de 16px é o mesmo dado com a gramática certa (um MEDIDOR, redondo e pequeno, ao lado das ações da conversa),
 * e some de vez do caminho da leitura.
 *
 * Os dígitos continuam a um toque: este anel É o gatilho do menu da sessão (ver {@link SessionMenu}).
 */
export function ContextRing({ session, active }: { session: SessionState; active: boolean }) {
  const { meter, pct, tone } = session;
  const filled = meter ? Math.max(2, pct) : 0;
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden>
      {/* o trilho — o anel vazio existe SEMPRE, senão uma conversa nova não teria medidor nenhum na tela. */}
      <circle cx="8" cy="8" r={RING_R} fill="none" strokeWidth="2.5" className="stroke-line-emphasis" />
      <circle
        cx="8"
        cy="8"
        r={RING_R}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        // começa às 12h (o -90°) e enche no sentido horário, como todo medidor redondo.
        transform="rotate(-90 8 8)"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - filled / 100)}
        className={cn("transition-all duration-500", RING[tone], active && "animate-pulse")}
      />
    </svg>
  );
}

/**
 * O medidor do composer: o ANEL de contexto é o gatilho; dentro dele, os números da sessão + as ações raras.
 *
 * "Nova conversa" NÃO mora mais aqui (nem na engrenagem): ela subiu para o cabeçalho, à direita, com o ícone
 * de compor (ver CopilotChats.tsx). Ela era a ação mais frequente do painel, escondida em dois menus e
 * desenhada com um ↺ que promete DESFAZER — o operador hesitava justamente por não saber o que perdia. O que
 * fica aqui é o que a leitura destes números justifica: compactar (sem trocar de conversa) e a verbosidade.
 */
export function SessionMenu({
  session,
  active,
  onCompact,
  responseMode,
  setResponseMode,
}: {
  session: SessionState;
  active: boolean;
  onCompact: () => void;
  responseMode: HitlResponseMode;
  setResponseMode: (m: HitlResponseMode) => void;
}) {
  const { meter, pct, tone, idleMs } = session;
  // align=left: o menu mora na BORDA ESQUERDA do composer — ancorado à direita, o painel abria para fora da tela.
  // O gatilho é o ANEL (o medidor de contexto) e não mais um `⋯` mudo: o ícone que abre as ações da conversa é o
  // mesmo que MOSTRA o estado dela — um item a menos na barra e nenhuma informação a menos na tela.
  return (
    <Popover
      label="Contexto e ações da conversa"
      title={
        meter
          ? `Contexto: ${formatTokens(meter.contextTokens)} de ${formatTokens(meter.contextWindow || CHAT_CONTEXT_WINDOW)} (${pct}%) · ${session.advice}`
          : "Conversa nova — sem contexto acumulado."
      }
      align="left"
      trigger={<ContextRing session={session} active={active} />}
    >
      {(close) => (
        <>
          <MenuBlock>
            {meter ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-hover">
                    <span className={cn("block h-full rounded-full", BAR[tone])} style={{ width: `${Math.max(2, pct)}%` }} />
                  </span>
                  <span className="shrink-0 tabular-nums text-fg-muted">{pct}%</span>
                </div>
                <div className="text-fg-subtle">
                  {formatTokens(meter.contextTokens)} de contexto · {meter.turns} {meter.turns === 1 ? "turno" : "turnos"}
                  {meter.costUSD > 0 ? ` · $${meter.costUSD.toFixed(2)}` : ""}
                </div>
                <div className="text-fg-subtle">{active ? "respondendo agora…" : `ociosa há ${formatAge(idleMs)}`}</div>
              </>
            ) : (
              <div className="text-fg-subtle">Conversa nova — sem contexto acumulado.</div>
            )}
          </MenuBlock>

          <MenuSep />

          <MenuItem
            icon={active ? <Loader2 className={cn(ICON.inline, "animate-spin")} /> : <Minimize2 className={ICON.inline} />}
            disabled={active}
            onClick={() => {
              onCompact();
              close();
            }}
            title="Resume a conversa e libera contexto, mantendo a MESMA sessão (/compact)."
          >
            Compactar
          </MenuItem>

          <MenuSep />

          <MenuItem
            icon={<Gauge className={ICON.inline} />}
            hint={responseMode === "terse" ? "curto" : "padrão"}
            onClick={() => setResponseMode(responseMode === "terse" ? "standard" : "terse")}
            title="Alterna a verbosidade das próximas respostas do agente."
          >
            Verbosidade
          </MenuItem>
        </>
      )}
    </Popover>
  );
}
