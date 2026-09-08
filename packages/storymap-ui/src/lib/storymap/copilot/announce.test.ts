import { describe, expect, it } from "vitest";
import {
  admitAnnouncement,
  announceAlert,
  announceEvent,
  IDLE_ANNOUNCER,
  releaseAnnouncer,
  withPending,
  type CopilotAnnouncement,
} from "./announce";
import { EXPRESSIONS } from "./face";
import type { AgentAlert, AgileHarnessEvent } from "@/lib/notifications/event";

const EVENT: AgileHarnessEvent = {
  id: "e1",
  type: "card.moved",
  boardId: "storymap",
  boardName: "AgileHarness",
  cardId: "story-abc",
  cardType: "story",
  title: "Balão do Jido anuncia mudanças",
  fromStatus: "desenvolver",
  toStatus: "revisar-codigo",
  fromStatusName: "Desenvolver",
  toStatusName: "Revisar código",
  at: 1_700_000_000_000,
};

const ALERT: AgentAlert = {
  id: "term:shell:1",
  kind: "terminal-waiting",
  urgency: "blocking",
  at: 1_700_000_000_000,
  title: "“Terminal do servidor” está esperando você",
  body: "Deseja executar este comando? · parado há 4min",
  tag: "terminal:shell",
  url: "/terminal?b=shell",
};

describe("announceEvent — o que o Jido conta sobre o board", () => {
  it("conta o card que ANDOU, nomeando a coluna de destino", () => {
    const a = announceEvent(EVENT);
    expect(a?.speech.line).toBe("“Balão do Jido anuncia mudanças” entrou em Revisar código.");
    expect(a?.speech.note).toBe("saiu de Desenvolver");
    expect(a?.mood).toBe("conectado");
  });

  it("CALA sobre card de OUTRO board — o stream SSE é global, o Jido do topnav não é", () => {
    // O vigia observa `storymap/boards/` inteiro e o broadcaster não filtra: sem este recorte, a barra
    // de quem está no AgileHarness anunciava card do Nest, sem nem dizer de que board. E este Jido não tem
    // contexto nenhum daquele card. Quem cobre o cross-board são os canais do SO.
    expect(announceEvent(EVENT, "acme")).toBeNull();
    expect(announceEvent(EVENT, "storymap")).not.toBeNull();
    expect(announceEvent(EVENT)).not.toBeNull(); // sem `forBoard` = sem filtro
  });

  it("o filtro de board vale também para a DEMANDA (que vence o tipo do evento)", () => {
    const withDemand = { ...EVENT, demand: { type: "question", label: "1 pergunta", severity: "high", count: 1 } };
    expect(announceEvent(withDemand, "acme")).toBeNull();
  });

  it("CALA sobre uma escrita de card sem demanda — é o ruído que encheria a barra", () => {
    // Um run de agente reescreve o mesmo card várias vezes por minuto. Anunciar cada escrita
    // transformaria o balão num log piscando no canto (foi o que aposentou o feed "Atividade recente").
    expect(announceEvent({ ...EVENT, type: "card.updated" })).toBeNull();
  });

  it("mas ANUNCIA a mesma escrita quando ela passa a precisar de um humano", () => {
    const a = announceEvent({
      ...EVENT,
      type: "card.updated",
      demand: { type: "question", label: "1 pergunta", severity: "high", count: 1 },
    });
    expect(a?.speech.line).toContain("precisa de você: 1 pergunta");
    expect(a?.speech.urgent).toBe(true);
    expect(a?.mood).toBe("surpreso"); // a cara de quem parou e espera
  });

  it("a demanda vence o tipo do evento — e a contagem entra na identidade da fala", () => {
    const one = announceEvent({ ...EVENT, demand: { type: "question", label: "1 pergunta", severity: "high", count: 1 } });
    const two = announceEvent({ ...EVENT, demand: { type: "question", label: "2 perguntas", severity: "high", count: 2 } });
    // Uma segunda pergunta no mesmo card é notícia NOVA; a mesma, repetida pelo poll, não é.
    expect(one?.speech.key).not.toBe(two?.speech.key);
  });

  it("COMEMORA quando o card chega ao fim do pipeline — a única notícia que fecha um ciclo", () => {
    const a = announceEvent({ ...EVENT, toTerminal: true, toStatusName: "No ar" });
    expect(a?.mood).toBe("amoroso"); // braços erguidos + ✦
    expect(a?.speech.line).toBe("“Balão do Jido anuncia mudanças” chegou em No ar.");
    // Quem comemora é a CARA: o texto segue sóbrio, sem emoji nem exclamação (mascote monocromático).
    expect(a?.speech.line).not.toMatch(/[!🎉🥳✨]/u);
  });

  it("o fim de linha é fato de CONFIG — sem o carimbo do servidor, é movimento comum", () => {
    // O cliente NÃO reconhece id de passo (`concluida`): o AgileHarness é genérico e cada board define
    // quais passos terminam. Ausência do carimbo nunca vira comemoração por palpite.
    const a = announceEvent({ ...EVENT, toStatusName: "No ar" });
    expect(a?.mood).toBe("conectado");
  });

  it("a identidade da fala distingue chegar ao fim de só passar por ali", () => {
    const fim = announceEvent({ ...EVENT, toTerminal: true });
    const passo = announceEvent(EVENT);
    expect(fim?.speech.key).not.toBe(passo?.speech.key);
  });

  it("card novo e card removido têm cara própria", () => {
    expect(announceEvent({ ...EVENT, type: "card.created" })?.mood).toBe("piscando");
    expect(announceEvent({ ...EVENT, type: "card.deleted" })?.mood).toBe("triste");
  });

  it("o TOM sai sempre do humor — nunca de uma segunda tabela", () => {
    const a = announceEvent(EVENT);
    expect(a?.speech.tone).toBe(EXPRESSIONS[a!.mood].tone);
  });

  it("sobrevive a um evento sem título/nome de status (o dado nem sempre chega inteiro)", () => {
    const a = announceEvent({ ...EVENT, title: undefined, toStatusName: null, fromStatusName: null });
    expect(a?.speech.line).toContain("story-abc");
    expect(a?.speech.note).toBeUndefined();
  });
});

describe("para onde a notícia LEVA", () => {
  it("card que se moveu leva à página dele", () => {
    expect(announceEvent(EVENT)?.href).toBe("/board/storymap/card/story-abc");
  });

  it("card REMOVIDO não leva a lugar nenhum — link morto é pior que nenhum link", () => {
    expect(announceEvent({ ...EVENT, type: "card.deleted" })?.href).toBeUndefined();
  });

  it("mudança de configuração do board não tem tela própria", () => {
    expect(announceEvent({ ...EVENT, type: "board.updated" })?.href).toBeUndefined();
  });

  it("o que PEDE algo de você leva ao card (é onde se responde)", () => {
    const a = announceEvent({
      ...EVENT,
      demand: { type: "question", label: "1 pergunta", severity: "high", count: 1 },
    });
    expect(a?.href).toBe("/board/storymap/card/story-abc");
  });

  it("o aviso de terminal leva ao MESMO lugar que a notificação do sistema", () => {
    // O contrato do AgentAlert já exige `url` ("um aviso que interrompe e não leva a lugar nenhum
    // transfere para o operador o trabalho de descobrir de onde ele veio") — era o balão que a ignorava.
    expect(announceAlert(ALERT).href).toBe(ALERT.url);
  });
});

describe("announceAlert — os avisos do agente (terminais)", () => {
  it("usa o MESMO texto que a notificação do sistema e o push", () => {
    const a = announceAlert(ALERT);
    expect(a.speech.line).toBe(ALERT.title);
    expect(a.speech.note).toBe(ALERT.body);
  });

  it("o que TRAVA trabalho interrompe (cara de espera e mais tempo na tela); o resto é cortesia", () => {
    const blocking = announceAlert(ALERT);
    const pending = announceAlert({ ...ALERT, kind: "terminal-quiet", urgency: "pending" });
    expect(blocking.mood).toBe("surpreso");
    expect(blocking.speech.urgent).toBe(true);
    expect(pending.mood).toBe("piscando");
    expect(pending.speech.urgent).toBe(false);
    expect(blocking.dwellMs).toBeGreaterThan(pending.dwellMs);
  });
});

describe("admitAnnouncement — mostrar, engolir ou contar", () => {
  const news = (key: string): CopilotAnnouncement => ({
    speech: { line: `fala ${key}`, key, tone: "neutral", urgent: false },
    mood: "conectado",
    dwellMs: 5_500,
  });

  it("com o balão livre, mostra e passa a segurar a chave", () => {
    const r = admitAnnouncement(IDLE_ANNOUNCER, news("a"));
    expect(r.show?.speech.key).toBe("a");
    expect(r.next).toEqual({ showingKey: "a", skipped: 0, deferred: null });
  });

  it("ENGOLE o eco: a mesma notícia, com ela ainda na tela, não re-abre nem renova o relógio", () => {
    const first = admitAnnouncement(IDLE_ANNOUNCER, news("a"));
    const echo = admitAnnouncement(first.next, news("a"));
    expect(echo.show).toBeNull();
    expect(echo.next).toBe(first.next); // estado intocado — o relógio segue o da primeira
  });

  it("mas ANUNCIA de novo depois que ela expirou — recorrência não é eco", () => {
    // O defeito que isto trava: a versão anterior guardava a última chave para SEMPRE, então um card
    // que voltasse à mesma coluna horas depois (mesma identidade, notícia legítima) ficava mudo.
    const first = admitAnnouncement(IDLE_ANNOUNCER, news("a"));
    const depoisDeExpirar = admitAnnouncement(IDLE_ANNOUNCER, news("a"));
    expect(first.show).not.toBeNull();
    expect(depoisDeExpirar.show?.speech.key).toBe("a");
  });

  it("notícia nova sobre uma na tela SUBSTITUI e conta a que ficou para trás", () => {
    let s = admitAnnouncement(IDLE_ANNOUNCER, news("a")).next;
    const b = admitAnnouncement(s, news("b"));
    expect(b.show?.speech.note).toContain("+1");
    s = b.next;
    const c = admitAnnouncement(s, news("c"));
    expect(c.show?.speech.note).toContain("+2");
  });

  it("SEGURADO, nada troca debaixo do cursor — a notícia nova fica represada", () => {
    // Medido na validação ao vivo: um aviso de terminal chegou entre o hover e o clique, trocou o link
    // e o clique aterrissou noutro lugar. Superfície que muda de destino no meio do gesto é armadilha.
    const s = admitAnnouncement(IDLE_ANNOUNCER, news("a")).next;
    const durante = admitAnnouncement(s, news("b"), { held: true });
    expect(durante.show).toBeNull();
    expect(durante.next.showingKey).toBe("a"); // o que está na tela (e o link dele) não mudou
    expect(durante.next.deferred?.speech.key).toBe("b");
  });

  it("ao SOLTAR, a represada assume — e conta a que ela deslocou", () => {
    const s = admitAnnouncement(IDLE_ANNOUNCER, news("a")).next;
    const held = admitAnnouncement(s, news("b"), { held: true }).next;
    const solta = releaseAnnouncer(held);
    expect(solta.show?.speech.key).toBe("b");
    expect(solta.show?.speech.note).toContain("+1"); // "a" ficou para trás
    expect(solta.next.deferred).toBeNull();
  });

  it("duas chegando seguradas: só a última assume, e o '+N' conta as duas que ficaram", () => {
    let s = admitAnnouncement(IDLE_ANNOUNCER, news("a")).next;
    s = admitAnnouncement(s, news("b"), { held: true }).next;
    s = admitAnnouncement(s, news("c"), { held: true }).next;
    const solta = releaseAnnouncer(s);
    expect(solta.show?.speech.key).toBe("c");
    expect(solta.show?.speech.note).toContain("+2"); // "a" e "b"
  });

  it("soltar sem nada represado não inventa notícia", () => {
    const s = admitAnnouncement(IDLE_ANNOUNCER, news("a")).next;
    expect(releaseAnnouncer(s).show).toBeNull();
  });

  it("com o balão livre a contagem RECOMEÇA (o '+N' fala da janela, não do uptime)", () => {
    const s = admitAnnouncement(admitAnnouncement(IDLE_ANNOUNCER, news("a")).next, news("b")).next;
    expect(s.skipped).toBe(1);
    expect(admitAnnouncement(IDLE_ANNOUNCER, news("c")).show?.speech.note).toBeUndefined();
  });
});

describe("withPending — o que sobra quando várias notícias caem na mesma janela", () => {
  it("acrescenta a contagem à nota, sem perder o que ela já dizia", () => {
    const a = withPending(announceEvent(EVENT)!, 3);
    expect(a.speech.note).toBe("saiu de Desenvolver · +3 mudanças antes desta");
  });

  it("nenhuma pendente ⇒ a notícia passa intacta", () => {
    const base = announceEvent(EVENT)!;
    expect(withPending(base, 0)).toBe(base);
  });
});

describe("o vocabulário da interface", () => {
  it("nenhuma fala do Jido usa o jargão interno do desenho do agente", () => {
    // "Mascote" é como o CÓDIGO chama o desenho; o operador conhece o Jido (ou "o agente"). Jargão
    // interno vazando para a tela é o defeito que originou este módulo.
    const falas = [
      announceEvent(EVENT),
      announceEvent({ ...EVENT, type: "card.created" }),
      announceEvent({ ...EVENT, type: "card.deleted" }),
      announceEvent({ ...EVENT, type: "board.updated" }),
      announceAlert(ALERT),
    ]
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .flatMap((a) => [a.speech.line, a.speech.note ?? ""]);
    for (const fala of falas) expect(fala.toLowerCase()).not.toContain("mascote");
  });
});
