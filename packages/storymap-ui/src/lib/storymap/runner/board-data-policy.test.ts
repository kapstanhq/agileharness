import { describe, expect, it } from "vitest";
import {
  BOARD_AUTOCOMMIT_ENV,
  BOARD_AUTOPUSH_ENV,
  boardDataAutoCommitAllowed,
  boardDataAutoPushAllowed,
  boardDataWriterDecision,
  planBoardDataFlush,
} from "./board-data-policy";

// A régua que a auditoria de extração (2026-08-19) obrigou a existir. Ver o cabeçalho do módulo: o
// flush debounced commitava E empurrava no repositório de quem instalou a ferramenta com um único
// portão (`process.env.VITEST`), sem knob, sem documentação e sem consultar o portão do boot.

describe("commitar é o valor do produto — nasce LIGADO", () => {
  it("sem declaração, versiona", () => {
    expect(boardDataAutoCommitAllowed({})).toBe(true);
  });
  it("o literal `0` desliga — e só ele", () => {
    expect(boardDataAutoCommitAllowed({ [BOARD_AUTOCOMMIT_ENV]: "0" })).toBe(false);
    expect(boardDataAutoCommitAllowed({ [BOARD_AUTOCOMMIT_ENV]: "off" })).toBe(true);
  });
});

describe("empurrar é distribuição — nasce DESLIGADO", () => {
  it("[ATAQUE] sem declaração, NÃO empurra para o origin de quem instalou", () => {
    // O defeito medido: editar um card na interface dava `git push origin HEAD` no repositório do
    // adotante. O remoto pode ser compartilhado, protegido, ou disparar CI na conta de outra pessoa.
    expect(boardDataAutoPushAllowed({})).toBe(false);
  });

  it("liga com o literal `1`", () => {
    expect(boardDataAutoPushAllowed({ [BOARD_AUTOPUSH_ENV]: "1" })).toBe(true);
    expect(boardDataAutoPushAllowed({ [BOARD_AUTOPUSH_ENV]: " 1 " })).toBe(true);
  });

  it("[ATAQUE] valores 'truthy' que NÃO são o literal não ligam — inclusive os que parecem negar", () => {
    // A disciplina do AGILEHARNESS_ENGINE=on aplicada aqui: com uma régua frouxa (`!!valor`), escrever
    // `AGILEHARNESS_BOARD_AUTOPUSH=no` LIGARIA a escrita num remoto de terceiro, por ser string não-vazia.
    for (const v of ["no", "false", "off", "true", "yes", "0", "sim"]) {
      expect(boardDataAutoPushAllowed({ [BOARD_AUTOPUSH_ENV]: v }), `"${v}" não pode ligar`).toBe(false);
    }
  });
});

describe("motor INERTE não versiona — a mesma régua do boot, não uma segunda", () => {
  it("checkout canônico (.git é diretório) versiona", () => {
    expect(boardDataWriterDecision({}, true).armed).toBe(true);
  });

  it("[ATAQUE] dentro de um `git worktree` (.git é arquivo) NÃO versiona", () => {
    // Defeito conhecido desta casa antes da correção: um servidor subido de dentro de um worktree —
    // o que se faz para validar UI — commitava board-data no repositório compartilhado.
    const v = boardDataWriterDecision({}, false);
    expect(v.armed).toBe(false);
    expect(v.reason).toMatch(/worktree/);
  });

  it("[ATAQUE] sem saber ler `.git` (o ZIP baixado, por exemplo) NÃO versiona — na dúvida, inerte", () => {
    expect(boardDataWriterDecision({}, null).armed).toBe(false);
  });

  it("o desligamento explícito do motor vence até no checkout canônico", () => {
    expect(boardDataWriterDecision({ AGILEHARNESS_ENGINE: "off" }, true).armed).toBe(false);
  });
});

describe("planBoardDataFlush — a decisão completa, no lugar em que dá para medi-la", () => {
  const armado = { armed: true, reason: "checkout canônico (.git é diretório)" };
  const inerte = { armed: false, reason: "git worktree (.git é arquivo)" };

  it("caso NORMAL de quem instalou: versiona local, NÃO empurra", () => {
    expect(planBoardDataFlush({}, armado)).toEqual({ versiona: true, empurra: false });
  });

  it("com a declaração, versiona e empurra", () => {
    expect(planBoardDataFlush({ [BOARD_AUTOPUSH_ENV]: "1" }, armado)).toEqual({ versiona: true, empurra: true });
  });

  it("[ATAQUE] motor inerte não versiona — nem com o push declarado", () => {
    const plano = planBoardDataFlush({ [BOARD_AUTOPUSH_ENV]: "1" }, inerte);
    expect(plano.versiona).toBe(false);
    expect(!plano.versiona && plano.motivo).toMatch(/inerte/);
  });

  it("o motivo da recusa é legível — quem for depurar precisa saber QUAL trava mordeu", () => {
    const porCommit = planBoardDataFlush({ [BOARD_AUTOCOMMIT_ENV]: "0" }, armado);
    expect(!porCommit.versiona && porCommit.motivo).toContain(BOARD_AUTOCOMMIT_ENV);
  });
});
