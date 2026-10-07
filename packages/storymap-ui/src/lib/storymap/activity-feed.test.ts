import { describe, expect, it } from "vitest";
import {
  ACTIVITY_LIMIT,
  ACTIVITY_WHO_LABEL,
  classifyTransitionActor,
  diaryActor,
  diaryCardOf,
  diaryPlain,
  mergeActivity,
  relativeShort,
  runEventText,
  transitionText,
  type ActivityContext,
} from "./activity-feed";
import { bannedTermsIn } from "./inbox/copy";
import { RUN_OUTCOMES } from "./runner/journal";
import type { Transition } from "./runner/transitions";
import type { RunEvent } from "./runner/event-log";
import type { CopilotActivityEntry } from "./copilot/activity";

// A atividade dos agentes (2ª barra do Kanban): três diários viram UMA lista em português simples, do mais recente para
// o mais antigo, com a marca de quem agiu. Fixtures inventadas no vocabulário da livraria de demonstração.

const NOW = Date.parse("2026-03-10T15:00:00.000Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const STATUS: Record<string, string> = { enriquecer: "Especificar", interview: "Entrevista", desenvolver: "Desenvolver", "revisar-codigo": "Revisar", revisao: "Aprovar entrega", concluida: "No ar" };
const TRIGGER: Record<string, string> = { "harness-enrich": "Especificar", "harness-do": "Desenvolver", "harness-review": "Revisar" };

const ctx = (cards: Record<string, { title: string; conducted?: boolean }> = {}): ActivityContext => ({
  cards: new Map(Object.entries(cards).map(([id, c]) => [id, { title: c.title, conducted: c.conducted ?? false }])),
  statusName: (id) => STATUS[id],
  triggerStep: (t) => TRIGGER[t],
});

const CARDS = {
  "story-ex9101": { title: "Buscar livro por autor" },
  "story-ex9102": { title: "Lista de desejos", conducted: true },
  "story-ex9103": { title: "Cupom no carrinho" },
};

const tr = (over: Partial<Transition> & Pick<Transition, "cardId" | "to" | "actor">, minAgo: number): Transition => ({
  v: 1,
  at: iso(minAgo),
  board: "demo",
  from: null,
  ...over,
});
const run = (over: Partial<RunEvent> & Pick<RunEvent, "cardId" | "trigger" | "outcome">, minAgo: number): RunEvent => ({
  type: "settled",
  board: "demo",
  at: NOW - minAgo * 60_000,
  ...over,
});
const jido = (over: Partial<CopilotActivityEntry>, minAgo: number): CopilotActivityEntry => ({
  id: `j-${minAgo}`,
  at: iso(minAgo),
  kind: "acted",
  text: "Organizei a fila de reposição do estoque.",
  ...over,
});

describe("classifyTransitionActor — quem causou o salto", () => {
  it("o dono pela tela é «Você»; cascata, sistema e integração são o Motor", () => {
    expect(classifyTransitionActor("human", false)).toBe("voce");
    for (const a of ["cascade", "system", "merge"]) expect(classifyTransitionActor(a, false)).toBe("motor");
  });
  it("`run:<passo>` é a execução de coluna; o juiz de conflitos é auxiliar", () => {
    expect(classifyTransitionActor("run:harness-enrich", false)).toBe("execucao");
    expect(classifyTransitionActor("run:harness-resolve", false)).toBe("juiz");
  });
  it("o agente escopado (`run:orch`) é o condutor SÓ no card conduzido; fora dele é auxiliar", () => {
    expect(classifyTransitionActor("run:orch", true)).toBe("condutor");
    expect(classifyTransitionActor("run:orch", false)).toBe("juiz");
  });
  it("fase 6 — o PAPEL gravado: condutor, Sentinela/chat (o Jido), procurador/revisor (auxiliar), sessão de fora", () => {
    expect(classifyTransitionActor("conductor:story-ex9101", false)).toBe("condutor");
    expect(classifyTransitionActor("sentinel", false)).toBe("jido");
    expect(classifyTransitionActor("chat", false)).toBe("jido");
    expect(classifyTransitionActor("proxy", true)).toBe("juiz");
    expect(classifyTransitionActor("critic", true)).toBe("juiz");
    expect(classifyTransitionActor("external:claude-code", false)).toBe("juiz");
    expect(classifyTransitionActor("session:ex-tmux", true)).toBe("condutor");
  });
  it("cada marca tem rótulo", () => {
    expect(ACTIVITY_WHO_LABEL).toMatchObject({ condutor: "Condutor", execucao: "Execução de coluna", juiz: "Auxiliar", motor: "Motor", jido: "Jido", voce: "Você" });
  });
});

describe("as frases", () => {
  const c = ctx(CARDS);
  it("o salto diz para onde, pelo NOME do passo (nunca o id)", () => {
    expect(transitionText({ from: "enriquecer", to: "interview", actor: "run:harness-enrich" }, "execucao", c)).toBe("Terminou Especificar e levou para Entrevista.");
    expect(transitionText({ from: "desenvolver", to: "revisar-codigo", actor: "human" }, "voce", c)).toBe("Você moveu para Revisar.");
    expect(transitionText({ from: "revisao", to: "concluida", actor: "merge" }, "motor", c)).toBe("Integrou o trabalho; o card foi para No ar.");
    expect(transitionText({ from: "concluida", to: "revisao", actor: "system", note: "deploy:reverted" }, "motor", c)).toBe("Desfez a publicação; o card voltou para Aprovar entrega.");
    expect(transitionText({ from: "interview", to: "desenvolver", actor: "run:orch" }, "condutor", c)).toBe("Levou de Entrevista para Desenvolver.");
    expect(transitionText({ from: "revisao", to: "desenvolver", actor: "human", note: "undo" }, "voce", c)).toBe("Você desfez; o card voltou para Desenvolver.");
  });
  it("status desconhecido não vaza o id cru", () => {
    expect(transitionText({ from: null, to: "status_misterioso", actor: "cascade" }, "motor", c)).toBe("Seguiu para o próximo passo.");
  });
  it("a execução encerrada diz o desfecho em palavras", () => {
    expect(runEventText({ trigger: "harness-do", outcome: "error" }, c)).toBe("Parou com erro em Desenvolver.");
    expect(runEventText({ trigger: "harness-review", outcome: "ok" }, c)).toBe("Terminou Revisar.");
    expect(runEventText({ trigger: "harness-qa", outcome: "timeout" }, c)).toBe("Passou do tempo e parou.");
  });
  it("NENHUMA frase usa termo interno (o glossário do Inbox): todo desfecho, todo ator, toda nota", () => {
    const texts: string[] = [];
    for (const outcome of RUN_OUTCOMES) {
      for (const trigger of ["harness-do", "harness-resolve", "harness-sync-card", "harness-desconhecido"]) texts.push(runEventText({ trigger: trigger as RunEvent["trigger"], outcome }, c));
    }
    const notes = [undefined, "undo", "undo:inbox", "reopen:refine", "reopen:fix", "reopen:retire", "revive:postergado", "deploy:reverted", "deploy:already-live"];
    for (const actor of ["human", "cascade", "system", "merge", "run:harness-enrich", "run:harness-resolve", "run:orch"]) {
      for (const note of notes) {
        for (const conducted of [true, false]) {
          const who = classifyTransitionActor(actor, conducted);
          texts.push(transitionText({ from: "enriquecer", to: "interview", actor: actor as Transition["actor"], note }, who, c));
          texts.push(transitionText({ from: null, to: "nao-existe", actor: actor as Transition["actor"], note }, who, c));
        }
      }
    }
    const dirty = texts.map((t) => ({ t, terms: bannedTermsIn(t).map((b) => b.id) })).filter((x) => x.terms.length);
    expect(dirty).toEqual([]);
  });
});

describe("mergeActivity — uma lista, do mais recente para o mais antigo", () => {
  it("funde os três diários na ordem do tempo, com a marca e o card de cada linha", () => {
    const items = mergeActivity(
      {
        transitions: [tr({ cardId: "story-ex9101", from: "enriquecer", to: "interview", actor: "run:harness-enrich" }, 30), tr({ cardId: "story-ex9102", from: "interview", to: "desenvolver", actor: "run:orch" }, 2)],
        runs: [run({ cardId: "story-ex9103", trigger: "harness-do", outcome: "error" }, 10)],
        copilot: [jido({}, 5)],
      },
      ctx(CARDS),
    );
    expect(items.map((i) => [i.who, i.cardTitle])).toEqual([
      ["condutor", "Lista de desejos"],
      ["jido", null],
      ["execucao", "Cupom no carrinho"],
      ["execucao", "Buscar livro por autor"],
    ]);
    expect(items[0].at).toBe(NOW - 2 * 60_000);
  });

  it("a execução que terminou bem e o salto que ela causou são UMA linha (fica o salto)", () => {
    const items = mergeActivity(
      {
        transitions: [tr({ cardId: "story-ex9101", from: "enriquecer", to: "interview", actor: "run:harness-enrich" }, 3)],
        runs: [run({ cardId: "story-ex9101", trigger: "harness-enrich", outcome: "ok" }, 3)],
        copilot: [],
      },
      ctx(CARDS),
    );
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("Terminou Especificar e levou para Entrevista.");
  });

  it("uma execução que PAROU não some, mesmo com um salto perto", () => {
    const items = mergeActivity(
      {
        transitions: [tr({ cardId: "story-ex9101", from: "enriquecer", to: "interview", actor: "run:harness-enrich" }, 3)],
        runs: [run({ cardId: "story-ex9101", trigger: "harness-enrich", outcome: "error" }, 3)],
        copilot: [],
      },
      ctx(CARDS),
    );
    expect(items).toHaveLength(2);
  });

  it("card que não está no board (lixeira, outro board) fica de fora; salto sem mudança também", () => {
    const items = mergeActivity(
      {
        transitions: [tr({ cardId: "story-ex9999", to: "interview", actor: "human" }, 1), tr({ cardId: "story-ex9101", from: "interview", to: "interview", actor: "cascade" }, 1)],
        runs: [run({ cardId: "story-ex9998", trigger: "harness-do", outcome: "ok" }, 1)],
        copilot: [],
      },
      ctx(CARDS),
    );
    expect(items).toEqual([]);
  });

  it("do Jido entram só as decisões em que ele age — acordar, agendar e ficar quieto são ruído", () => {
    const items = mergeActivity(
      {
        transitions: [],
        runs: [],
        copilot: [jido({ id: "a", kind: "woke" }, 1), jido({ id: "b", kind: "scheduled" }, 2), jido({ id: "c", kind: "stood-down" }, 3), jido({ id: "d", kind: "asked", text: "Pedi sua aprovação para mover um card." }, 4)],
      },
      ctx(CARDS),
    );
    expect(items.map((i) => i.id)).toEqual(["j:d"]);
    expect(items[0]).toMatchObject({ who: "jido", cardId: null, cardTitle: null });
  });

  it("a linha do diário que OUTRO agente causou leva a marca dele (a antena é só do Jido) e sai em palavras simples", () => {
    const items = mergeActivity(
      {
        transitions: [],
        runs: [],
        copilot: [
          jido({ id: "a", text: "Um agente de fora (agente-x) encerrou uma cópia de trabalho (abre sessão)." }, 1),
          jido({ id: "b", text: "Uma sessão de agente (0d3c9a1e-1111-4222-8333-944445555666) executou worktree_submit (session)." }, 2),
          jido({ id: "c", text: "O condutor do card story-ex9102 executou `move_card` (write-board)." }, 3),
          jido({ id: "d", text: "Executei `create_card` sozinho (write-board)." }, 4),
          jido({ id: "e", kind: "asked", text: "Parei e pedi sua aprovação para `propose_change` (write-board)." }, 5),
        ],
      },
      ctx(CARDS),
    );
    expect(items.map((i) => [i.who, i.text])).toEqual([
      ["juiz", "Um agente de fora («agente-x») terminou de mexer no código."],
      ["juiz", "Outro agente entregou o código para entrar no produto."],
      ["condutor", "O condutor moveu um card."],
      ["jido", "Criou um card sozinho."],
      ["jido", "Parei e pedi sua aprovação para propor uma mudança."],
    ]);
    for (const it of items) {
      expect(it.text, it.text).not.toMatch(/cópia de trabalho|sessão|worktree|_|`|\((?:write-board|session|abre sessão|mexe no board)\)/);
      expect(bannedTermsIn(it.text)).toEqual([]);
    }
  });

  it("a linha de um agente de fora diz QUEM, O QUÊ e SOBRE QUAL card (a frase genérica só quando nada se sabe)", () => {
    const items = mergeActivity(
      {
        transitions: [],
        runs: [],
        copilot: [
          // ferramenta nova (fora da tabela): o tipo da ação gravado junto diz o que foi
          jido({ id: "a", text: "Um agente de fora (vigia) executou `tool_nova` (doc-write).", detail: "loja/story-ex9101" }, 1),
          // ferramenta conhecida, card vivo: a linha leva o card
          jido({ id: "b", text: "Um agente de fora (vigia) executou `approve_qa` (write-board).", detail: "loja/story-ex9103" }, 2),
          // nada se sabe (sem classe, card fora do board, id cunhado no lugar do nome): a frase de antes
          jido({ id: "c", text: "Um agente de fora (0d3c9a1e-1111-4222-8333-944445555666) executou `tool_nova`.", detail: "loja/story-ex9999" }, 3),
        ],
      },
      ctx(CARDS),
    );
    expect(items.map((i) => [i.cardTitle, i.text])).toEqual([
      ["Buscar livro por autor", "Um agente de fora («vigia») mexeu num documento do board."],
      ["Cupom no carrinho", "Um agente de fora («vigia») aprovou o teste de um card."],
      [null, "Um agente de fora fez uma ação no board."],
    ]);
    for (const it of items) expect(bannedTermsIn(it.text)).toEqual([]);
    expect(diaryCardOf("loja/story-ex9101", ctx(CARDS))).toEqual({ id: "story-ex9101", title: "Buscar livro por autor" });
    expect(diaryCardOf("loja", ctx(CARDS))).toBeNull();
    expect(diaryCardOf(undefined, ctx(CARDS))).toBeNull();
  });

  it("diaryActor e diaryPlain: sem prefixo de outro agente é o Jido; o texto sem jargão fica como está", () => {
    expect(diaryActor("Organizei a fila.")).toEqual({ who: "jido", text: "Organizei a fila." });
    expect(diaryPlain("Organizei a fila.")).toBe("Organizei a fila.");
    expect(diaryPlain("Um agente de fora (x) abriu uma cópia de trabalho (abre sessão).")).toBe("Um agente de fora (x) começou a mexer no código.");
  });

  it("saltos do motor encadeados no mesmo card viram UMA linha, a do destino final (nunca parece que voltou)", () => {
    const items = mergeActivity(
      {
        transitions: [
          tr({ cardId: "story-ex9101", from: "revisao", to: "revisar-codigo", actor: "system", note: "deploy:already-live" }, 10),
          tr({ cardId: "story-ex9101", from: "revisar-codigo", to: "concluida", actor: "cascade" }, 9),
          // outro card, longe no tempo: não funde
          tr({ cardId: "story-ex9103", from: "desenvolver", to: "revisao", actor: "cascade" }, 120),
          tr({ cardId: "story-ex9103", from: "revisao", to: "concluida", actor: "cascade" }, 60),
        ],
        runs: [],
        copilot: [],
      },
      ctx(CARDS),
    );
    expect(items.map((i) => [i.cardId, i.text])).toEqual([
      ["story-ex9101", "Viu que já estava no ar; foi para No ar."],
      ["story-ex9103", "Seguiu para No ar."],
      ["story-ex9103", "Seguiu para Aprovar entrega."],
    ]);
  });

  it("no máximo 30 linhas, as mais recentes", () => {
    const transitions = Array.from({ length: 50 }, (_, i) => tr({ cardId: "story-ex9101", from: i % 2 ? "enriquecer" : "interview", to: i % 2 ? "interview" : "enriquecer", actor: "human" }, i + 1));
    const items = mergeActivity({ transitions, runs: [], copilot: [] }, ctx(CARDS));
    expect(items).toHaveLength(ACTIVITY_LIMIT);
    expect(items[0].at).toBe(NOW - 60_000);
    expect(items.every((it, i) => i === 0 || items[i - 1].at >= it.at)).toBe(true);
  });

  it("data ilegível é pulada, não derruba a lista", () => {
    const items = mergeActivity({ transitions: [{ ...tr({ cardId: "story-ex9101", to: "interview", actor: "human" }, 1), at: "ontem" }], runs: [], copilot: [jido({ at: "x" }, 1)] }, ctx(CARDS));
    expect(items).toEqual([]);
  });
});

describe("relativeShort — o tempo curto", () => {
  it("agora · N min · N h · ontem · N dias", () => {
    expect(relativeShort(NOW - 20_000, NOW)).toBe("agora");
    expect(relativeShort(NOW + 60_000, NOW)).toBe("agora");
    expect(relativeShort(NOW - 4 * 60_000, NOW)).toBe("4 min");
    expect(relativeShort(NOW - 59 * 60_000, NOW)).toBe("59 min");
    expect(relativeShort(NOW - 2 * 3_600_000, NOW)).toBe("2 h");
    expect(relativeShort(NOW - 30 * 3_600_000, NOW)).toBe("ontem");
    expect(relativeShort(NOW - 3 * 86_400_000, NOW)).toBe("3 dias");
  });
});
