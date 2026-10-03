import { describe, expect, it } from "vitest";
import {
  chatSignals,
  deriveMood,
  EXPRESSIONS,
  faceFor,
  isReadOnlyTool,
  isWorking,
  moodDot,
  scariestRisk,
  toolKey,
  type MoodId,
} from "./face";

const ALL_MOODS = Object.keys(EXPRESSIONS) as MoodId[];

describe("tools", () => {
  it("tira o prefixo MCP", () => {
    expect(toolKey("mcp__storymap__move_card")).toBe("move_card");
    expect(toolKey("mcp__claude_ai_AgileHarness__get_card")).toBe("get_card");
    expect(toolKey("Bash")).toBe("bash");
    expect(toolKey("Read")).toBe("read");
  });

  it("sabe quem só lê", () => {
    expect(isReadOnlyTool("Read")).toBe(true);
    expect(isReadOnlyTool("mcp__storymap__get_card")).toBe(true);
    expect(isReadOnlyTool("mcp__storymap__git_diff")).toBe(true);
  });

  it("o que não está na tabela conta como ESCRITA (falha para o lado seguro)", () => {
    expect(isReadOnlyTool("Bash")).toBe(false);
    expect(isReadOnlyTool("Write")).toBe(false);
    expect(isReadOnlyTool("mcp__storymap__move_card")).toBe(false);
    expect(isReadOnlyTool("mcp__storymap__deploy")).toBe(false);
    expect(isReadOnlyTool("tool_que_nao_existe_ainda")).toBe(false);
  });
});

describe("scariestRisk", () => {
  it("acha a classe irreversível no meio da fila", () => {
    expect(scariestRisk(["read", "write-board", "deploy"])).toBe("deploy");
    expect(scariestRisk(["write-board", "destructive"])).toBe("destructive");
  });
  it("sem nada assustador, devolve a primeira (ou nada)", () => {
    expect(scariestRisk(["write-board", "read"])).toBe("write-board");
    expect(scariestRisk([])).toBeNull();
  });
});

describe("deriveMood — a prioridade é a regra de produto do rosto", () => {
  it("repouso amigável quando não há nada acontecendo", () => {
    expect(deriveMood({})).toBe("feliz");
    expect(deriveMood({ chat: "idle" })).toBe("feliz");
  });

  it("erro do turno ganha de tudo", () => {
    expect(deriveMood({ chat: "error", runningTool: "Bash", pendingApprovals: 3, streamingText: true })).toBe("erro");
  });

  it("conexão caída / retry da API viram glitch (mas não passam na frente de um erro)", () => {
    expect(deriveMood({ interrupted: true })).toBe("glitch");
    expect(deriveMood({ straining: true })).toBe("glitch");
    expect(deriveMood({ chat: "error", interrupted: true })).toBe("erro");
  });

  it("aprovação pendente para o rosto — e uma irreversível o apavora", () => {
    expect(deriveMood({ pendingApprovals: 1 })).toBe("surpreso");
    expect(deriveMood({ pendingApprovals: 1, topRisk: "write-board" })).toBe("surpreso");
    expect(deriveMood({ pendingApprovals: 1, topRisk: "deploy" })).toBe("panico");
    expect(deriveMood({ pendingApprovals: 2, topRisk: "destructive" })).toBe("panico");
  });

  it("a aprovação pendente ganha da tool rodando (ele está PARADO esperando você)", () => {
    expect(deriveMood({ pendingApprovals: 1, runningTool: "Bash" })).toBe("surpreso");
  });

  it("tool de leitura = pensativo; tool que mexe = código", () => {
    expect(deriveMood({ chat: "typing", runningTool: "Read" })).toBe("pensativo");
    expect(deriveMood({ chat: "typing", runningTool: "mcp__storymap__list_cards" })).toBe("pensativo");
    expect(deriveMood({ chat: "typing", runningTool: "Bash" })).toBe("codigo");
    expect(deriveMood({ chat: "typing", runningTool: "mcp__storymap__update_card" })).toBe("codigo");
  });

  it("a tool ganha do texto (a pill viva é o que o operador está olhando)", () => {
    expect(deriveMood({ chat: "typing", runningTool: "Bash", streamingText: true })).toBe("codigo");
  });

  it("falando quando está cuspindo texto", () => {
    expect(deriveMood({ chat: "typing", streamingText: true })).toBe("falando");
  });

  it("pensativo quando o turno saiu e nada voltou ainda", () => {
    expect(deriveMood({ chat: "typing" })).toBe("pensativo");
  });

  it("reage à SUA decisão: aprovou → amoroso, rejeitou → triste", () => {
    expect(deriveMood({ chat: "idle", delighted: true })).toBe("amoroso");
    expect(deriveMood({ chat: "idle", dejected: true })).toBe("triste");
  });

  it("conectado quando o tick autônomo está rodando", () => {
    expect(deriveMood({ chat: "idle", autonomousRunning: true, level: "auto-active" })).toBe("conectado");
  });

  it("dorme quando o board não vai acordá-lo", () => {
    expect(deriveMood({ level: "off" })).toBe("dormindo");
    expect(deriveMood({ level: "auto-disarmed" })).toBe("dormindo");
    expect(deriveMood({ level: "auto-inert" })).toBe("dormindo");
  });

  it("NÃO dorme durante uma conversa, mesmo com o board desligado (o chat funciona sempre)", () => {
    expect(deriveMood({ level: "off", chat: "typing" })).toBe("pensativo");
    expect(deriveMood({ level: "off", chat: "typing", streamingText: true })).toBe("falando");
  });

  it("fica cansado quando a janela de contexto está estourando", () => {
    expect(deriveMood({ chat: "idle", contextTone: "danger" })).toBe("triste");
    expect(deriveMood({ chat: "idle", contextTone: "warn" })).toBe("feliz");
  });

  it("faceFor devolve os metadados do humor", () => {
    expect(faceFor({ chat: "error" }).id).toBe("erro");
    expect(faceFor({ chat: "error" }).tone).toBe("danger");
    expect(faceFor({}).short).toBe("tranquilo");
  });
});

describe("isWorking — trabalho de verdade, não recência", () => {
  it("conta o que está ACONTECENDO agora", () => {
    expect(isWorking({ autonomousRunning: true })).toBe(true);
    expect(isWorking({ chat: "typing" })).toBe(true);
    expect(isWorking({ chat: "typing", runningTool: "Bash" })).toBe(true);
    expect(isWorking({ chat: "typing", streamingText: true })).toBe(true);
  });

  it("NÃO conta 'conversamos há pouco' — foi o bug do mascote âmbar com o Jido parado", () => {
    expect(isWorking({ chat: "idle", recentTurn: true })).toBe(false);
    expect(isWorking({ chat: "idle", recentTurn: true, level: "auto-active" })).toBe(false);
  });

  it("nem repouso, nem parado esperando você, nem quebrado", () => {
    expect(isWorking({})).toBe(false);
    expect(isWorking({ chat: "idle", pendingApprovals: 2, topRisk: "deploy" })).toBe(false);
    expect(isWorking({ chat: "error" })).toBe(false);
  });
});

describe("moodDot — o selo só acende com algo que pede o olho", () => {
  it("repouso NÃO tem ponto (é o silêncio que dá sentido ao ponto quando acende)", () => {
    expect(moodDot("feliz")).toBeNull();
    expect(moodDot("pensativo")).toBeNull();
    expect(moodDot("dormindo")).toBeNull();
    expect(moodDot("piscando")).toBeNull();
  });

  it("verde = ele está agindo; âmbar = parou e espera você; rosa = quebrou", () => {
    expect(moodDot("conectado")).toBe("live");
    expect(moodDot("amoroso")).toBe("live");
    expect(moodDot("codigo")).toBe("live");
    expect(moodDot("surpreso")).toBe("attention");
    expect(moodDot("triste")).toBe("attention");
    expect(moodDot("erro")).toBe("danger");
    expect(moodDot("glitch")).toBe("danger");
    expect(moodDot("panico")).toBe("danger");
  });

  it("todo humor resolve para uma cor da barra ou para nenhuma — nunca para outra coisa", () => {
    for (const mood of ALL_MOODS) {
      expect([null, "live", "attention", "danger"], mood).toContain(moodDot(mood));
    }
  });
});

describe("o topnav depois do fix — o caso que o operador reportou", () => {
  // Conversa de 20min atrás, chat parado, board ligado, nenhum tick rodando: era ROSTO ÂMBAR +
  // PONTO VERDE PULSANDO. Nada estava acontecendo — o "estado" era o relógio.
  const conversouHaPouco = { chat: "idle" as const, recentTurn: true, level: "auto-active" as const };

  it("conversa recente com o Jido parado: rosto em repouso e NENHUM ponto", () => {
    const mood = deriveMood(conversouHaPouco);
    expect(mood).toBe("feliz");
    expect(isWorking(conversouHaPouco)).toBe(false);
    expect(moodDot(mood)).toBeNull();
  });

  it("tick autônomo rodando: ponto verde PULSANDO — e agora ele quer dizer isso", () => {
    const agindoSozinho = { ...conversouHaPouco, autonomousRunning: true };
    const mood = deriveMood(agindoSozinho);
    expect(mood).toBe("conectado");
    expect(EXPRESSIONS[mood].short).toBe("agindo sozinho");
    expect(isWorking(agindoSozinho)).toBe(true);
    expect(moodDot(mood)).toBe("live");
  });

  it("aprovação parada há horas: ponto ÂMBAR e estático — antes não havia ponto nenhum", () => {
    const esperandoVoce = { chat: "idle" as const, recentTurn: false, pendingApprovals: 1 };
    const mood = deriveMood(esperandoVoce);
    expect(mood).toBe("surpreso");
    expect(moodDot(mood)).toBe("attention");
    expect(isWorking(esperandoVoce)).toBe(false); // estático: nada está acontecendo, esse é o ponto
  });
});

describe("registro — metadados de cada humor", () => {
  it("toda expressão declara id coerente, rótulo de acessibilidade e tom", () => {
    for (const mood of ALL_MOODS) {
      const e = EXPRESSIONS[mood];
      expect(e.id, mood).toBe(mood);
      expect(e.label.length, mood).toBeGreaterThan(3);
      expect(e.short.length, mood).toBeGreaterThan(0);
      expect(["ok", "warn", "danger", "neutral", "accent"], mood).toContain(e.tone);
    }
  });
});

describe("chatSignals — do turno pendente para os sinais do humor", () => {
  const textSeg = (segId: string, text: string) => ({ type: "text" as const, segId, text });
  const toolSeg = (name: string, status: string) => ({ type: "tool" as const, segId: `t-${name}`, name, status });

  it("texto crescendo no fim de um turno vivo = falando", () => {
    const s = chatSignals({
      status: "typing",
      turns: [{ role: "agent", segments: [textSeg("a", "oi, deix")] }],
    });
    expect(s.streamingText).toBe(true);
    expect(s.runningTool).toBeNull();
    expect(deriveMood(s)).toBe("falando");
  });

  it("uma tool rodando ganha do texto anterior (a pill viva manda)", () => {
    const s = chatSignals({
      status: "typing",
      turns: [{ role: "agent", segments: [textSeg("a", "vou ler"), toolSeg("Read", "running")] }],
    });
    expect(s.runningTool).toBe("Read");
    expect(deriveMood(s)).toBe("pensativo");
  });

  it("segmento-sentinela de morte SEM recuperação depois = interrompido (glitch)", () => {
    const s = chatSignals({
      status: "idle",
      turns: [{ role: "agent", segments: [textSeg("dropped", "")] }],
    });
    expect(s.interrupted).toBe(true);
    expect(deriveMood(s)).toBe("glitch");
  });

  it("um `reconnect` depois do sentinela cancela o glitch", () => {
    const s = chatSignals({
      status: "idle",
      turns: [{ role: "agent", segments: [textSeg("dropped", ""), textSeg("reconnect", "voltei")] }],
    });
    expect(s.interrupted).toBe(false);
  });
});
