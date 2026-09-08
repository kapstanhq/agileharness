import { describe, expect, it } from "vitest";
import { CHAT_SURFACES, chatDockFor, chatSurfaceFor } from "./chat-surfaces";
import { hitlPurposeById } from "../hitl/purpose-registry";

describe("chat-surfaces — o registro de conversas por TELA", () => {
  it("a tela de Ideias tem UMA conversa (não uma por ideia)", () => {
    const s = chatSurfaceFor("ideias");
    expect(s?.purposeId).toBe("idea-explorer");
  });

  it("a tela do PRD tem conversa, e ela reusa o propósito de documento", () => {
    // O PRD é o documento mais alto do board; escrevê-lo sem agente ao lado era o defeito da tela que
    // ele substituiu (o Posicionamento não tinha chat NENHUM — `chatSurfaceFor` devolvia undefined).
    const s = chatSurfaceFor("prd");
    expect(s?.purposeId, "o PRD ficou sem conversa").toBe("doc-editor");
    // As duas técnicas que não existem no canvas — são elas que justificam um repertório próprio.
    const ids = (s?.techniques ?? []).map((t) => t.id);
    expect(ids).toContain("entrevistar");
    expect(ids).toContain("pronto-para-agente");
  });

  it("tela sem entrada não tem chat — o caller decide, e o correto é recusar", () => {
    expect(chatSurfaceFor("priorizacao")).toBeUndefined();
    expect(chatSurfaceFor("nao-existe")).toBeUndefined();
  });

  // O módulo é DADO PURO porque o cliente o lê (os atalhos são montados no navegador). Um import do registro
  // de personas aqui arrastaria `node:fs` para o bundle — o build reprova, e este teste diz por quê.
  it("a tabela não importa nada de servidor (ela é lida pelo navegador)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./chat-surfaces.ts", import.meta.url), "utf8"),
    );
    expect(src).not.toMatch(/^import .*(node:|purpose-registry)/m);
  });

  // O contrato modular: uma entrada declarativa por tela, e o propósito carrega persona/tier/poder. Uma
  // entrada apontando para um propósito que não existe é bug de CONFIGURAÇÃO — resolver "meio-caminho"
  // (superfície sem persona) daria um agente sem instrução nenhuma rodando com tools.
  it("toda superfície aponta para um propósito que EXISTE no registro", () => {
    for (const s of CHAT_SURFACES) {
      expect(hitlPurposeById(s.purposeId), `superfície «${s.view}» aponta para propósito inexistente`).toBeDefined();
    }
  });

  it("os atalhos são só datilografia poupada: rótulo curto + um prompt de verdade", () => {
    for (const s of CHAT_SURFACES)
      for (const a of s.quickActions ?? []) {
        expect(a.label.length).toBeLessThanOrEqual(28);
        expect(a.prompt.length).toBeGreaterThan(40); // um atalho que manda "resuma" não poupa nada
      }
  });

  it("view é slug (ela entra na chave da raia e no nome de arquivo do histórico)", () => {
    for (const s of CHAT_SURFACES) expect(s.view).toMatch(/^[a-z0-9-]+$/);
  });

  it("uma tela só pode ter UMA conversa (nada de duas entradas disputando a mesma raia)", () => {
    expect(new Set(CHAT_SURFACES.map((s) => s.view)).size).toBe(CHAT_SURFACES.length);
  });

  // ── AS TÉCNICAS ────────────────────────────────────────────────────────────────────────────────────────
  // Uma técnica é o MÉTODO (como atacar), não o assunto e não um poder novo. Estes contratos existem porque as
  // três maneiras de errar uma técnica são silenciosas: id repetido (a preferência salva vira ambígua), rótulo
  // comprido (o seletor deixa de caber na barra) e prompt curto demais (um "seja criativo" não muda método
  // nenhum — só gasta tokens e dá a impressão de que o botão faz algo).
  it("as técnicas têm id único por tela — a preferência salva aponta para UMA delas", () => {
    for (const s of CHAT_SURFACES) {
      const ids = (s.techniques ?? []).map((t) => t.id);
      expect(new Set(ids).size, `superfície «${s.view}» tem técnicas com id repetido`).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("técnica é rótulo curto (cabe na barra) + instrução de método de verdade", () => {
    for (const s of CHAT_SURFACES)
      for (const t of s.techniques ?? []) {
        expect(t.label.length, `«${t.id}» tem rótulo comprido demais para o seletor`).toBeLessThanOrEqual(18);
        expect(t.hint.length).toBeGreaterThan(10);
        expect(t.hint.length).toBeLessThanOrEqual(60);
        // Um fragmento curto não é um método: ele precisa dizer o que fazer, em que ordem e o que não fazer.
        expect(t.prompt.length, `«${t.id}» não descreve um método`).toBeGreaterThan(120);
      }
  });

  // A bancada de Ideias é tela de TRABALHO com o agente: a conversa é o meio, não uma consulta ocasional.
  // Se um dia ela virar gaveta, que seja uma decisão consciente e não um default que escorregou.
  it("a tela de Ideias ancora a conversa no layout (rail), e o default é rail", () => {
    expect(chatDockFor("ideias")).toBe("rail");
    expect(chatDockFor("uma-tela-sem-entrada")).toBe("rail");
  });
});
