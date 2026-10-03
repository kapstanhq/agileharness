"use client";

// O ESTADO DO JIDO que a barra precisa, lido UMA vez por board.
//
// Três consumidores no topnav querem o mesmo fato — o mascote (para o humor), o balão (para saber se um
// ciclo está em voo) e a política de aviso (para saber o MODO). Cada um chamando `orchestratorOverviewAction`
// seria o mesmo trabalho de servidor três vezes por minuto, com três respostas que podem discordar entre si
// por até um poll inteiro (o clássico "a barra diz autônomo e o painel diz copiloto").
//
// Aqui vira um hook só, chamado no topo do header e passado para baixo por prop. A alternativa — um contexto
// novo — pagaria um provider por uma leitura que tem exatamente um dono.

import { useEffect, useState } from "react";
import { orchestratorOverviewAction } from "@/app/copilot-actions";
import { copilotStatus, type CopilotStatusLevel } from "@/lib/storymap/copilot/copilot-status";
import { copilotTier, type CopilotTier } from "@/lib/storymap/copilot/tier";

/** Ritmo do poll: o mesmo dos demais medidores da barra (o estado do Jido muda em minutos, não em segundos). */
const POLL_MS = 60_000;

export interface CopilotOverview {
  /** o nível para o ROSTO (ligado? desarmado? sem token?) — a mesma função pura que o painel do chat usa. */
  level: CopilotStatusLevel | undefined;
  /** o MODO (chat/copiloto/autônomo) — projeção de (mode, riskMatrix.deploy), nunca um campo novo. */
  tier: CopilotTier;
  /** um ciclo autônomo está EM VOO agora. */
  running: boolean;
  /** o primeiro fetch já voltou (com dado OU com erro) — quem espera hidratação usa isto. */
  loaded: boolean;
}

/** Estado inicial honesto: `chat` é o modo mais conservador (o que menos autoriza e menos silencia). */
const INITIAL: CopilotOverview = { level: undefined, tier: "chat", running: false, loaded: false };

export function useCopilotOverview(boardId: string): CopilotOverview {
  const [overview, setOverview] = useState<CopilotOverview>(INITIAL);

  useEffect(() => {
    let alive = true;
    const load = () =>
      orchestratorOverviewAction(boardId)
        .then((o) => {
          if (!alive || !o) return;
          setOverview({
            level: copilotStatus({
              mode: o.boardMode,
              enabled: o.settings.enabled.value,
              orchTokenPresent: o.orchTokenPresent,
              writeBoard: o.riskMatrix["write-board"],
              deploy: o.riskMatrix["deploy"],
            }).level,
            // O tier sai da MESMA projeção que o guard por chamada lê (copilotTier ⇒ dispositionFor), a
            // partir da matriz RESOLVIDA — nunca de uma segunda regra escrita aqui.
            tier: copilotTier({ mode: o.boardMode, riskMatrix: o.riskMatrix }),
            running: Boolean(o.state?.running),
            loaded: true,
          });
        })
        .catch(() => {})
        // `finally` e não só o `then`: um overview que FALHA também encerra a hidratação — senão um erro de
        // rede deixaria o balão mudo para sempre, esperando um dado que não vem.
        .finally(() => alive && setOverview((prev) => (prev.loaded ? prev : { ...prev, loaded: true })));
    load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [boardId]);

  return overview;
}
