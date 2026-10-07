// O glossário do dono vale no Kanban novo: nenhuma frase fixa do quadro (o motivo da caixinha, os pedidos escritos,
// os rótulos do trem, as legendas do fluxo e os nomes dos estados) usa um termo do motor que o Inbox proíbe.
//
// UMA exceção, consciente: «etapa». O glossário (WP3) troca «etapa» por «passo», mas os textos do desenho da fase 1 —
// que a spec manda usar ao pé da letra («Mover para outra etapa…», «Rodar a etapa agora», «Na fila desta etapa.») —
// dizem «etapa». A divergência fica para o dono da spec decidir; os termos do MOTOR (train, merge, run…) seguem banidos.
import { describe, expect, it } from "vitest";
import { bannedTermsIn } from "./inbox/copy";
import { kanbanCopyStrings } from "./kanban-copy";
import { FLOW_STATE_LABEL, flowCaption, groupingWords, queuedIncludesWords, quietBoardWords, quietLaneWords, type FlowState, type LaneRole } from "./kanban-features";

const DESIGN_WORDS = new Set(["etapa"]);

describe("as palavras do Kanban", () => {
  it("nenhuma frase fixa usa um termo proibido do glossário", () => {
    const roles: LaneRole[] = ["intake", "shaping", "building", "verifying", "delivery", "live", "generic"];
    const all = (s: FlowState) => (s === "attention" || s === "error" || s === "running" ? 1 : 0);
    const captions = roles.flatMap((r) => [
      ...flowCaption(r, { count: all, total: 3, paused: false, avgMinutes: 12, today: 2, perDay: 1.4 }),
      ...flowCaption(r, { count: () => 0, total: 0, paused: true }),
    ]);
    // as frases do «Exceções» sem exceção e do agrupamento por funcionalidade
    const quiet = [...Object.values(quietLaneWords(11)), ...Object.values(quietBoardWords(["queued"]) ?? {}), ...Object.values(quietBoardWords(["queued"], 2) ?? {}), queuedIncludesWords({ waiting: 2, forgotten: 1 }), groupingWords(11, 2)];
    // a legenda pode trazer o resto curto (o 3º elemento, opcional) — entra também
    const texts = [...kanbanCopyStrings(), ...Object.values(FLOW_STATE_LABEL), ...captions, ...quiet].filter((t): t is string => Boolean(t));
    const offenders = texts
      .map((t) => ({ t, terms: bannedTermsIn(t).map((b) => b.id).filter((id) => !DESIGN_WORDS.has(id)) }))
      .filter((x) => x.terms.length);
    expect(offenders).toEqual([]);
  });
});
