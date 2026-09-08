import { describe, expect, it } from "vitest";
import { buildHitlPrompt } from "./prompt";
import { parseHitlTurn } from "./parse";
import { AGENT_VOICE_CLAUSE, hitlPurposeById, resolveHitlPrompt, HITL_PURPOSES } from "./purpose-registry";
import type { HitlTranscript } from "./types";

// O núcleo HITL é puro (prompt/parse/registry) — a regressão aqui quebra qualquer consumidor.

describe("buildHitlPrompt", () => {
  const base = {
    systemPrompt: "PERSONA-X",
    doneContract: "{ tipo }",
    transcript: { turns: [] } as HitlTranscript,
  };

  it("inclui persona, contrato de done e o contrato JSON", () => {
    const p = buildHitlPrompt({ ...base, responseMode: "standard" });
    expect(p).toContain("PERSONA-X");
    expect(p).toContain("{ tipo }");
    expect(p).toContain('"message"');
    expect(p).toContain("APENAS um objeto JSON");
  });

  it("2.2 — COM doneContract: convida a emitir done e inclui o campo no shape JSON", () => {
    const p = buildHitlPrompt({ ...base, responseMode: "standard" });
    expect(p).toMatch(/emita "done"/);
    expect(p).toContain('"done"?: { tipo }');
  });

  it("2.2 — SEM doneContract (chat aberto): PROÍBE done e OMITE o campo do shape JSON", () => {
    const p = buildHitlPrompt({ systemPrompt: "PERSONA-Y", responseMode: "standard", transcript: { turns: [] } });
    expect(p).toMatch(/NUNCA emita "done"/);
    expect(p).not.toContain('"done"?'); // o campo some do contrato JSON → o modelo não é convidado a encerrar
  });

  it("o modo terse pede estilo terminal; o standard permite contexto", () => {
    expect(buildHitlPrompt({ ...base, responseMode: "terse" })).toContain("CURTO/DIRETO");
    expect(buildHitlPrompt({ ...base, responseMode: "standard" })).toContain("PADRÃO");
  });

  it("replaya o transcript inteiro (humano + agente)", () => {
    const transcript: HitlTranscript = {
      turns: [
        { role: "human", text: "é bug?", selectedOptionIds: ["o1"] },
        { role: "agent", message: "Parece defeito. Confirma?" },
      ],
    };
    const p = buildHitlPrompt({ ...base, responseMode: "terse", transcript });
    expect(p).toContain("HUMANO:");
    expect(p).toContain("é bug?");
    expect(p).toContain("escolheu: o1");
    expect(p).toContain("VOCÊ (agente): Parece defeito. Confirma?");
  });

  it("renderiza o contexto como DADO (delimitado), não instrução", () => {
    const p = buildHitlPrompt({ ...base, responseMode: "terse", context: "item: feed pisca" });
    expect(p).toContain("## Contexto (DADO");
    expect(p).toContain("item: feed pisca");
  });
});

describe("parseHitlTurn", () => {
  it("extrai message (strip de preâmbulo), options normalizadas, mode e done", () => {
    const raw = JSON.stringify({
      message: "Claro! É um bug ou uma dor?",
      options: [
        { label: "Bug", pros: ["corrige rápido"], cons: [""], recommended: true },
        { id: "x", label: "Dor", pros: [] },
        { label: "" },
      ],
      mode: "single",
      done: null,
    });
    const t = parseHitlTurn(raw);
    expect(t.role).toBe("agent");
    expect(t.message.length).toBeGreaterThan(0);
    expect(t.options).toHaveLength(2); // o vazio é dropado
    expect(t.options![0].id).toBe("o1"); // id sintetizado
    expect(t.options![0].recommended).toBe(true);
    expect(t.options![0].cons).toBeUndefined(); // cons vazio → omitido
    expect(t.options![1].id).toBe("x"); // id preservado
    expect(t.mode).toBe("single");
    expect(t.done).toBeUndefined(); // null → não resolve
  });

  it("tolera cercas de código e devolve done quando presente", () => {
    const raw = '```json\n{ "message": "ok", "done": { "type": "story", "storyType": "bug" } }\n```';
    const t = parseHitlTurn(raw);
    expect(t.message).toBe("ok");
    expect(t.done).toEqual({ type: "story", storyType: "bug" });
    expect(t.options).toBeUndefined();
  });
});

describe("purpose-registry", () => {
  it("resolve um propósito conhecido e rejeita o desconhecido", () => {
    expect(hitlPurposeById("capture-disambiguation")?.id).toBe("capture-disambiguation");
    expect(hitlPurposeById("nao-existe")).toBeUndefined();
  });

  it("WS8: o propósito 'copilot' existe, é uma conversa ABERTA (sem doneContract)", () => {
    const p = hitlPurposeById("copilot");
    expect(p?.id).toBe("copilot");
    expect(p?.doneContract).toBeUndefined(); // chat aberto — nunca resolve com payload
    expect(p?.defaultPrompt).toMatch(/COPILOTO/i);
  });

  it("resolveHitlPrompt cai no defaultPrompt quando não há override em disco", () => {
    const p = HITL_PURPOSES[0];
    expect(resolveHitlPrompt(p).startsWith(p.defaultPrompt)).toBe(true);
  });

  // A REGRA DE VOZ é do REGISTRO, não de cada persona: ela sai por `resolveHitlPrompt`, que é por onde
  // TODO consumidor passa (o turno agêntico e o HITL de um turno só). O que este teste trava não é a
  // frase — é o lugar: uma persona nova nasce com a regra sem ninguém lembrar de copiá-la, e um
  // override de disco (que troca o que o agente FAZ) não consegue derrubar a língua em que ele fala.
  it("toda persona resolvida carrega a regra de voz — inclusive sob override de disco", () => {
    for (const p of HITL_PURPOSES) {
      expect(resolveHitlPrompt(p)).toContain(AGENT_VOICE_CLAUSE);
    }
    expect(AGENT_VOICE_CLAUSE).toMatch(/NUNCA cite o NOME de uma ferramenta/);
    // e o recorte que a torna usável: o mundo do OPERADOR continua sendo citado com precisão.
    expect(AGENT_VOICE_CLAUSE).toMatch(/caminho de arquivo|id de card/i);
  });

  // W5.2 — o Explorador de Ideias. O que este teste protege não é a existência do propósito, é o RECORTE de
  // poder dele: ler muito, escrever só no documento. Um `mcpLevel: "full"` aqui daria a uma conversa de
  // exploração o direito de mover card e disparar deploy.
  it("o propósito 'idea-explorer' é read-only no board e não edita arquivos", () => {
    const p = hitlPurposeById("idea-explorer");
    expect(p?.mcpLevel).toBe("ro");
    const denied = (p?.deniedTools ?? "").split(",");
    expect(denied).toEqual(expect.arrayContaining(["Write", "Edit", "NotebookEdit"]));
    expect(denied).not.toContain("Bash"); // diagnóstico read-only continua possível (decisão do Operador)
    expect(p?.doneContract).toBeUndefined(); // explorar não resolve com payload — quem decide é o humano
  });

  it("o Explorador NÃO promete criar tarefas sozinho (a decisão é do humano)", () => {
    // A persona é o único lugar onde isto pode vazar: se ela mandar "crie os cards ao final", ele cria — e a
    // Ideia volta a virar cascata automática, que é o que o ADR-066 desfez.
    const prompt = hitlPurposeById("idea-explorer")!.defaultPrompt;
    expect(prompt).toMatch(/NÃO crie card/i);
    expect(prompt).toMatch(/ação do HUMANO/i);
  });
});
