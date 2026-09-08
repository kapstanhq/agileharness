// 🔌 O teste de PRODUTOR da capacidade `doc-write` — a caneta do agente no documento.
//
// Existe por uma lição cara e registrada: criar uma CLASSE DE RISCO nova não basta para o agente
// poder usá-la. A disposição é resolvida contra a `riskMatrix` DO BOARD, e **nenhuma matriz já
// persistida declara uma classe que acabou de nascer** — nem a de um board em Copiloto, escrita antes
// de a classe existir. Sem a linha no `defaultDisposition`, toda chamada vira pedido de aprovação
// órfão, em TODOS os boards. Foi o que quase matou a escrita do Explorador (ADR-066), e o que a
// suíte NÃO pegava, porque os testes das actions chamam a server action direto e nunca o caminho
// MCP/guard.
//
// Então este arquivo prova a corrente inteira, ponta a ponta, no nível em que ela de fato quebra:
// classe → disposição default → montagem no token de LEITURA → superfície de chat → persona.

import { describe, expect, it } from "vitest";
import { levelAllows, riskClassForTool } from "../mcp/register";
import { defaultDisposition, dispositionFor } from "../runner/orchestrator-policy";
import { chatSurfaceFor } from "../copilot/chat-surfaces";
import { hitlPurposeById } from "../hitl/purpose-registry";
import { RISK_CLASSES } from "../types";
import { docEntry, docTypes } from "./doc-registry";
import { validateSchema } from "./doc-schema";

const WRITE_ANN = { readOnlyHint: false, destructiveHint: false };
const READ_ANN = { readOnlyHint: true };

describe("doc-write — a classe existe e está classificada", () => {
  it("`doc-write` é uma classe de risco declarada", () => {
    expect(RISK_CLASSES).toContain("doc-write");
  });

  it("write_doc tem a classe própria; read_doc é leitura", () => {
    expect(riskClassForTool("write_doc")).toBe("doc-write");
    expect(riskClassForTool("read_doc")).toBe("read");
  });
});

describe("doc-write — a armadilha do DEFAULT (a que quase matou o idea-write)", () => {
  it("a disposição default é `auto` — senão cada parágrafo escrito abriria aprovação órfã", () => {
    expect(defaultDisposition("doc-write")).toBe("auto");
  });

  it("um board SEM matriz persistida resolve `auto` (é o estado de todo board existente hoje)", () => {
    expect(dispositionFor(null, "doc-write")).toBe("auto");
    expect(dispositionFor({ riskMatrix: {} } as never, "doc-write")).toBe("auto");
  });

  it("um board que QUEIRA humano no loop declara `ask` e a matriz vence", () => {
    expect(dispositionFor({ riskMatrix: { "doc-write": "ask" } } as never, "doc-write")).toBe("ask");
  });
});

describe("doc-write — o token de LEITURA monta a caneta (é o ponto inteiro)", () => {
  it("`ro` monta write_doc: uma conversa de tela escreve no documento sem receber o board junto", () => {
    expect(levelAllows("ro", "write_doc", WRITE_ANN)).toBe(true);
    expect(levelAllows("ro", "read_doc", READ_ANN)).toBe(true);
  });

  it("…e continua SEM o poder de mover card, publicar ou abrir shell", () => {
    // A contenção que justifica dar a caneta: a caneta é só a caneta.
    expect(levelAllows("ro", "move_card", WRITE_ANN)).toBe(false);
    expect(levelAllows("ro", "deploy", { readOnlyHint: false, destructiveHint: true, openWorldHint: true })).toBe(false);
    expect(levelAllows("ro", "run_task", { readOnlyHint: false, destructiveHint: false, openWorldHint: true })).toBe(false);
  });
});

describe("doc-write — a superfície que consome a capacidade EXISTE", () => {
  // Capacidade declarada com ZERO produtores é a forma nº1 de "feature no ar que ninguém alcança".
  it("a tela do canvas tem conversa declarada, e o propósito dela resolve", () => {
    const surface = chatSurfaceFor("canvas");
    expect(surface, "a tela `canvas` precisa de entrada em CHAT_SURFACES").toBeDefined();
    const purpose = hitlPurposeById(surface!.purposeId);
    expect(purpose, `propósito "${surface!.purposeId}" não existe no registro`).toBeDefined();
  });

  it("o propósito roda com token de LEITURA e sem caneta no repositório", () => {
    const purpose = hitlPurposeById(chatSurfaceFor("canvas")!.purposeId)!;
    expect(purpose.mcpLevel, "a escrita vem da classe `doc-write`, não do token full").toBe("ro");
    for (const tool of ["Write", "Edit", "NotebookEdit"]) {
      expect(purpose.deniedTools ?? "", `${tool} tem de estar negado`).toContain(tool);
    }
  });

  it("a persona ENSINA a regra que a gravação impõe (rótulo travado, chave ≠ rótulo)", () => {
    const purpose = hitlPurposeById("doc-editor")!;
    expect(purpose.defaultPrompt).toMatch(/TRAVADO/);
    expect(purpose.defaultPrompt).toMatch(/read_doc/);
    expect(purpose.defaultPrompt).toMatch(/write_doc/);
  });
});

describe("doc-registry — o allowlist fail-closed", () => {
  it("docType desconhecido devolve undefined (o chamador recusa)", () => {
    expect(docEntry("../../etc/passwd")).toBeUndefined();
    expect(docEntry("nao-existe")).toBeUndefined();
  });

  it("todo documento registrado tem schema bem formado e rota", () => {
    expect(docTypes().length).toBeGreaterThan(0);
    for (const type of docTypes()) {
      const entry = docEntry(type)!;
      expect(validateSchema(entry.schema), `schema de ${type}`).toEqual([]);
      expect(entry.view, `rota de ${type}`).toBeTruthy();
      expect(entry.label, `rótulo de ${type}`).toBeTruthy();
    }
  });

  it("o Lean Canvas declara a projeção do LEGADO — sem ela, o agente gravaria vazio por cima", () => {
    // A armadilha concreta: sem `legacyProject`, um board ainda não migrado lê o esqueleto VAZIO, e o
    // primeiro write_doc materializa um .md vazio POR CIMA do canvas que ainda vivia no board.yaml.
    expect(docEntry("lean-canvas")?.legacyProject).toBeTypeOf("function");
  });
});
