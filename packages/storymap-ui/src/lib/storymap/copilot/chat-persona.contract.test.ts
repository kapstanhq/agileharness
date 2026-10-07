// O CONTRATO DA PERSONA DO CHAT (fase 6, decisão do dono de 06/10): conversa concisa e em português simples, que
// esconde o técnico (resultado primeiro; o detalhe fica recolhido em «ver detalhes»); copiloto proativo que pede
// confirmação SÓ antes do que é irreversível, caro ou da classe do dono; que conhece os terminais do AgileHarness; e que
// não contorna a trava dura. A régua de confirmação sobrevive a um override de disco da persona.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_VOICE_CLAUSE, CHAT_COMMAND_CENTER_CLAUSE, hitlPurposeById, resolveHitlPrompt, type HitlPurpose } from "../hitl/purpose-registry";

const copilot = hitlPurposeById("copilot")!;
const rendered = resolveHitlPrompt(copilot);

describe("a régua de confirmação", () => {
  it("nomeia os TRÊS gatilhos, e só eles", () => {
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/IRREVERSÍVEL/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/CARA/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/DO DONO/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/SÓ deles/);
    // o resto é feito sem perguntar — o copiloto é proativo, não um formulário de licenças
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/Todo o resto você FAZ sem perguntar/);
  });

  it("a classe do dono inclui QUALQUER código de cobrança (decisão 3), marca, PRD e dados de pessoas", () => {
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/QUALQUER código de cobrança/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/marca/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/PRD/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/dados de pessoas/);
  });

  it("encerrar terminal e publicar estão entre os irreversíveis; a confirmação é uma escolha na conversa", () => {
    const irreversible = CHAT_COMMAND_CENTER_CLAUSE.split("2. CARA")[0];
    expect(irreversible).toMatch(/encerrar um terminal/);
    expect(irreversible).toMatch(/publicar/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/jido-ask/);
  });

  it("a trava dura: recusou, não contorna; e tudo fica registrado em nome do chat", () => {
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/TRAVA DURA/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/NÃO contorne/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/REGISTRADO em nome do chat/);
  });

  it("os terminais seguem SEPARADOS do chat; matar pede confirmação; condutor se para pelo card", () => {
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/SEPARADOS desta conversa/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/`claude_kill` — SEMPRE com confirmação/);
    expect(CHAT_COMMAND_CENTER_CLAUSE).toMatch(/Parar condutor/);
  });

  it("vale mesmo quando a persona é sobrescrita em disco (como a regra de voz)", () => {
    const overridden: HitlPurpose = { ...copilot, id: "copilot-override-teste", defaultPrompt: "persona trocada" };
    const text = resolveHitlPrompt(overridden);
    expect(text).toContain(CHAT_COMMAND_CENTER_CLAUSE);
    expect(text).toContain(AGENT_VOICE_CLAUSE);
    expect(rendered).toContain(CHAT_COMMAND_CENTER_CLAUSE);
  });

  it("só o chat do board a recebe — as conversas de tela continuam sem os poderes nem a régua", () => {
    for (const id of ["doc-editor", "vocab-architect", "capture-disambiguation"]) {
      expect(resolveHitlPrompt(hitlPurposeById(id)!), id).not.toContain(CHAT_COMMAND_CENTER_CLAUSE);
    }
  });
});

describe("a voz: concisa, simples, o técnico recolhido", () => {
  it("resultado primeiro, sem texto técnico na resposta, o detalhe em «ver detalhes»", () => {
    expect(rendered).toMatch(/RESULTADO PRIMEIRO/);
    expect(rendered).toMatch(/SEM TEXTO TÉCNICO/);
    expect(rendered).toMatch(/ver detalhes/);
    expect(rendered).toMatch(/português simples/);
  });

  it("proativo, sem inventar, e a decisão de produto é do dono", () => {
    expect(rendered).toMatch(/PROATIVO/);
    expect(rendered).toMatch(/NUNCA invente/);
    expect(rendered).toMatch(/escolha DELE/);
  });

  it("não se apresenta como orquestrador do fluxo (texto honesto — o motor orquestra, o Jido atende o dono)", () => {
    expect(rendered).not.toMatch(/ORQUESTRADOR/);
    expect(rendered).not.toMatch(/ponta a ponta/);
  });

  it("o turno não cola mais a cláusula de MODO do board (a régua dos autônomos) na persona do chat", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/storymap/copilot/agent-session.ts"), "utf8");
    expect(src).not.toMatch(/tierPersonaClause\(/);
    expect(src).toMatch(/chatSpawnPlan\(/);
    expect(src).toMatch(/createChatNativeRecorder\(/);
  });
});
