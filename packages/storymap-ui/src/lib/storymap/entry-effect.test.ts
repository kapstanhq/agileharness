import { describe, expect, it } from "vitest";
import { entryEffect, moveRiskClass } from "./entry-effect";
import type { BoardConfig } from "./types";

// Cobre o ORQUESTRADOR (#5 do review): qual efeito-ao-entrar dispara numa transição. Era a regressão
// mais perigosa e SEM teste (um typo na condição → deploy no card/status errado, ou nunca). O refactor
// B3 (onEnter + dispatch) tornou a decisão pura → testável sem disparar git/systemd reais.
const board: BoardConfig = {
  id: "b",
  name: "B",
  statuses: [
    { id: "release", name: "Liberar" }, // ADR-059: ponto de descanso, sem onEnter (promote moveu p/ deploy)
    { id: "deploy", name: "Publicar", onEnter: "promote-and-deploy" }, // a cadeia do Deploy (promote + deploy)
    { id: "legacy-release", name: "Publicação", onEnter: "promote-stage" }, // efeitos legados ainda válidos
    { id: "legacy-deploy", name: "Deploy", onEnter: "deploy-board" },
    { id: "desenvolver", name: "Dev", autorun: true, trigger: "harness-do" }, // F5.3 — coluna de RUN (autorun+trigger)
    { id: "plain", name: "Plain" }, // sem onEnter, sem autorun/trigger — coluna manual
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

describe("entryEffect — decisão de dispatch (B3 + ADR-059)", () => {
  it("retorna o efeito ao ENTRAR num step com onEnter (mudança REAL de status)", () => {
    // ADR-059: o Deploy dispara a cadeia promote-and-deploy ao entrar a partir do descanso em release.
    expect(entryEffect(board, "deploy", "release")).toBe("promote-and-deploy");
    // release não tem mais onEnter — o promote saiu daqui e virou parte da cadeia do Deploy.
    expect(entryEffect(board, "release", "revisao")).toBeNull();
    // Os efeitos legados (promote-stage / deploy-board) seguem despacháveis se um step os declarar.
    expect(entryEffect(board, "legacy-release", "revisao")).toBe("promote-stage");
    expect(entryEffect(board, "legacy-deploy", "legacy-release")).toBe("deploy-board");
  });

  it("null num reorder/reparent na mesma coluna (prevStatus === toStatus) — não re-dispara", () => {
    expect(entryEffect(board, "release", "release")).toBeNull();
    expect(entryEffect(board, "deploy", "deploy")).toBeNull();
  });

  it("null para step SEM onEnter, status nulo/undefined, ou status desconhecido", () => {
    expect(entryEffect(board, "plain", "x")).toBeNull();
    expect(entryEffect(board, null, "x")).toBeNull();
    expect(entryEffect(board, undefined, "x")).toBeNull();
    expect(entryEffect(board, "inexistente", "x")).toBeNull();
  });
});

describe("moveRiskClass — F5.3: a classe de risco pelo EFEITO da coluna-alvo", () => {
  it("coluna com onEnter (promote/deploy) ⇒ deploy", () => {
    expect(moveRiskClass(board, "deploy", "release")).toBe("deploy");
    expect(moveRiskClass(board, "legacy-release", "revisao")).toBe("deploy");
    expect(moveRiskClass(board, "legacy-deploy", "release")).toBe("deploy");
  });
  it("coluna autorun COM trigger ⇒ run", () => {
    expect(moveRiskClass(board, "desenvolver", "revisao")).toBe("run");
  });
  it("coluna manual (sem efeito) / reorder na mesma coluna / alvo nulo ⇒ write-board", () => {
    expect(moveRiskClass(board, "plain", "x")).toBe("write-board");
    expect(moveRiskClass(board, "deploy", "deploy")).toBe("write-board"); // mesma coluna, sem re-disparo
    expect(moveRiskClass(board, null, "x")).toBe("write-board");
    expect(moveRiskClass(board, "inexistente", "x")).toBe("write-board");
  });

  // autonomy-endgame WS-5.4 — o ROTEAMENTO que a doutrina do Autônomo manda, provado ponta a ponta. Diante de
  // um defeito real num finding de review, a doutrina (tier.ts:167) manda: "devolva o PRÓPRIO card para
  // `desenvolver` (o fix anda com o card, com teste). Você não tem shell: quem edita código é o run da coluna."
  // Isso nunca tinha sido testado. As duas metades da regra:
  it("WS-5.4 — devolver o card p/ `desenvolver` dispara o run da coluna (classe `run`), não abre um shell", () => {
    // O tick move o card de volta a `desenvolver` (uma coluna autorun+trigger). O move é classificado `run` —
    // ou seja, dispara a skill headless que O BOARD registrou p/ a coluna, com (board, cardId) e sem texto
    // livre. É o "Rodar agora" que o humano aperta. O tick não escreveu uma linha: ele DESPACHOU quem escreve.
    expect(moveRiskClass(board, "desenvolver", "revisar-codigo")).toBe("run");
    // E NÃO é `deploy`/`run-free`/`destructive`: devolver o card não publica nada nem abre um shell.
    expect(moveRiskClass(board, "desenvolver", "revisar-codigo")).not.toBe("deploy");
    expect(["run-free", "destructive"]).not.toContain(moveRiskClass(board, "desenvolver", "revisar-codigo"));
  });
});
