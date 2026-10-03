// model.ts — a resolução de model/effort do JIDO, em UM lugar só.
//
// POR QUE UM MÓDULO PRÓPRIO: o chat (copilot/agent-session.ts) e o tick autônomo
// (runner/orchestrator-spawn.ts) COMPARTILHAM a mesma sessão durável do board (o ponteiro board→sessionId, e
// portanto o MESMO transcript do CLI). Rodar os dois em modelos diferentes significa uma sessão cuja janela de
// contexto muda conforme quem a escreveu por último — e a barra de contexto, que mede contra a janela do chat,
// passa a mentir sempre que o tick escreve. Logo a resolução tem de ser UMA.
//
// Ela não podia morar em agent-session.ts (de onde nasceu): esse módulo já importa `buildOrchestratorMcpConfig`
// de runner/orchestrator-spawn, então o spawn do tick importar de volta fecharia um CICLO. Aqui, o módulo só
// depende de config + registry de purposes — ambos folhas — e os dois consumidores importam deste ponto.

import { loadRunnerConfig } from "../runner/config";
import { hitlPurposeById } from "../hitl/purpose-registry";

/**
 * O default de contexto longo. O CLI do Claude Code trata a janela de 1M como uma VARIANTE que se pede pelo
 * sufixo `[1m]` no id do modelo — um `--model opus` seco roda na janela padrão de 200k. Sem o sufixo, uma
 * conversa (ou uma sessão de tick, que é threaded entre ticks e cresce sem parar) morria no teto de 200k sem
 * que ninguém tivesse escolhido isso. O preço premium de contexto longo só incide ACIMA de 200k tokens, então
 * o default é seguro; o operador desliga em `settings.yaml` (`orchestrator.chat.model`).
 */
export const DEFAULT_COPILOT_MODEL = "opus[1m]";

/**
 * Resolve model/effort de UM turno agêntico: request > `settings.orchestrator.chat` > default do propósito >
 * {@link DEFAULT_COPILOT_MODEL}. É a MESMA função que o chat e o tick chamam — ver o cabeçalho deste arquivo.
 *
 * O knob de settings (`orchestrator.chat`) vale SÓ para o Jido do board: ele é a preferência do operador para
 * AQUELE chat. Para outro propósito (ex.: o Explorador de Ideias, declarado sonnet/medium) ele não se aplica —
 * senão o tier declarado no propósito seria decorativo, e uma conversa de exploração herdaria o opus[1m] que o
 * operador escolheu para orquestrar o board.
 */
export function resolveCopilotModelEffort(
  reqModel?: string,
  reqEffort?: string,
  purposeId = "copilot",
): { model: string; effort: string } {
  const p = hitlPurposeById(purposeId);
  const chat = purposeId === "copilot" ? loadRunnerConfig().orchestrator?.chat : undefined;
  return {
    model: (reqModel || chat?.model || p?.model || DEFAULT_COPILOT_MODEL).trim(),
    effort: (reqEffort || chat?.effort || p?.effort || "medium").trim(),
  };
}
