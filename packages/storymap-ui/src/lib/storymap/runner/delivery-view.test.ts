import { describe, expect, it } from "vitest";
import {
  belongsToBoard,
  heldRequests,
  holdsPublish,
  isBlocked,
  headOfStaged,
  laneOf,
  openRequests,
  parseStagedLog,
  projectWork,
  requestForStage,
  stagedState,
  stagedTotalOf,
  trainInFlight,
  trainIsMoving,
  workState,
  STAGED_LOG_FORMAT,
} from "./delivery-view";
import { releaseCodePrefixes } from "./release-scope";
import type { DeliveryWork } from "./delivery-view";
import type { FleetRow } from "./fleet-view";
import type { PublishRequest } from "./publish-queue";
import type { MergeQueueStatus } from "./types";

function row(over: Partial<FleetRow> = {}): FleetRow {
  return {
    sessionId: "s1",
    agentId: "s1",
    role: "free",
    task: "trabalho",
    board: null,
    cardId: null,
    cardTitle: null,
    branch: null,
    worktreePath: null,
    model: null,
    spawnedBy: null,
    tmuxSession: null,
    heartbeatAt: "2026-07-28T00:00:00.000Z",
    alive: true,
    processAlive: null,
    contextPct: null,
    suggestRecycle: false,
    claim: null,
    train: null,
    adopted: false,
    warning: null,
    orphanedIntegration: null,
    ...over,
  };
}

const train = (status: MergeQueueStatus) => ({ status, pinnedSha: "abc1234", enqueuedAt: 1 });

function req(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    id: "pub-1",
    board: "storymap",
    requestedSha: "aaa",
    requestedBy: "human",
    requestedAt: "2026-07-28T00:00:00.000Z",
    allowNewer: false,
    status: "waiting",
    ...over,
  };
}

describe("laneOf — em que degrau o trabalho está", () => {
  it("sessão sem entrada no train está EM EDIÇÃO", () => {
    expect(laneOf(row())).toBe("editing");
  });

  it("entrada que o train ainda tem nas mãos (em voo ou parada esperando o operador) fica NO TRAIN", () => {
    for (const s of ["waiting", "gate-running", "merging", "re-driving", "gate-failed", "conflict"] as const) {
      expect(laneOf(row({ train: train(s) }))).toBe("train");
    }
  });

  it("entrada `done` volta a sessão para EM EDIÇÃO — a entrega foi, a sessão fica", () => {
    // Regressão de produção: devolver null aqui apagava da página TODA sessão viva que já tivesse
    // integrado alguma coisa — que em produção é quase toda. A raia nascia vazia com 5 agentes ativos.
    expect(laneOf(row({ train: train("done") }))).toBe("editing");
  });

  it("uma sessão que acabou de integrar continua listada", () => {
    const [w] = projectWork([row({ sessionId: "integrou", agentId: "integrou", train: train("done") })]);
    expect(w).toMatchObject({ key: "integrou", lane: "editing", stuck: false });
  });

  /**
   * O BURACO ENTRE AS DUAS RÉGUAS. `laneOf` mandava para `train` tudo que não fosse `done`, mas a raia do
   * train renderiza só o que `trainInFlight` aprova. A diferença — `failed` e `returned-to-session` — caía
   * no vão: fora de "Em curso" (a raia diz train) e fora de "No train" (o filtro diz que não). Sumia da
   * página. E `returned-to-session` é justamente "isto voltou para VOCÊ", o único estado em que a sessão
   * precisa agir. Havia duas entradas assim no runtime quando isto foi encontrado.
   */
  it("desfecho DEVOLVIDO volta para a sessão — e nunca cai no vão entre as raias", () => {
    for (const s of ["failed", "returned-to-session"] as const) {
      expect(laneOf(row({ train: train(s) }))).toBe("editing");
      expect(trainInFlight(s)).toBe(false); // …e a raia do train continua não o reivindicando
      const [w] = projectWork([row({ sessionId: "devolvida", agentId: "devolvida", train: train(s) })]);
      expect(w).toMatchObject({ lane: "editing", stuck: true }); // visível, e no topo por atenção
    }
  });

  it("as duas réguas são A MESMA — nenhum status pode ficar sem raia", () => {
    const todos: MergeQueueStatus[] = [
      "waiting", "gate-running", "merging", "re-driving", "gate-failed", "conflict", "returned-to-session", "failed", "done",
    ];
    for (const s of todos) {
      expect(laneOf(row({ train: train(s) }))).toBe(trainInFlight(s) ? "train" : "editing");
    }
  });
});

describe("headOfStaged — a entrega mais recente NÃO é o sha do branch", () => {
  const d = (sha: string) => ({ sha, subject: "s", at: "2026-07-28T00:00:00.000Z" });

  it("é a primeira da lista (o log vem do mais novo para o mais velho)", () => {
    expect(headOfStaged([d("novo"), d("velho")])).toBe("novo");
    expect(headOfStaged([])).toBeNull();
  });

  /**
   * A ARMADILHA. A listagem usa `--no-merges` (um merge não é uma entrega), então quando o topo do stage
   * é um `Merge branch 'main' into stage` — o caso comum logo depois de uma promoção — nenhum sha listado
   * é igual ao do branch. Comparar `sha === stageSha` deixava "a mais recente" permanentemente falso, e
   * ninguém notava porque o rótulo antigo era o mesmo nas duas pontas.
   */
  it("continua respondendo quando o topo do branch é um MERGE fora da lista", () => {
    const staged = [d("entrega-nova"), d("entrega-velha")];
    const stageSha = "commit-de-merge"; // o topo real do branch, filtrado por --no-merges
    expect(staged.some((s) => s.sha === stageSha)).toBe(false); // a régua antiga não achava ninguém
    expect(headOfStaged(staged)).toBe("entrega-nova");
  });
});

/**
 * O TETO SILENCIOSO. A listagem do stage é capada em 30 (a raia mostra entregas, não o histórico), mas
 * "N entregas ainda não no ar" e o contador da raia liam `staged.length` — acima do teto eles reportavam
 * 30 como se fosse o total. Mesma família do contador de "No ar" (janela truncada apresentada como
 * resposta) e mais cara, porque é o número em cima do qual alguém aperta "Publicar".
 */
describe("stagedTotalOf — o total real, não o tamanho da janela", () => {
  it("usa a contagem do git quando ela é legível", () => {
    expect(stagedTotalOf("47\n", 30)).toBe(47);
    expect(stagedTotalOf("3", 3)).toBe(3);
  });

  it("contagem ilegível cai na lista — sub-reportar é barato, inventar um total não", () => {
    expect(stagedTotalOf(null, 30)).toBe(30);
    expect(stagedTotalOf("", 30)).toBe(30);
    expect(stagedTotalOf("fatal: bad revision", 30)).toBe(30);
  });

  it("contagem MENOR que a lista é incoerente ⇒ vale a lista (as duas leituras discordaram)", () => {
    expect(stagedTotalOf("2", 30)).toBe(30);
  });
});

describe("belongsToBoard — o escopo da página", () => {
  it("o board próprio pertence; outro board não", () => {
    expect(belongsToBoard("storymap", "storymap")).toBe(true);
    expect(belongsToBoard("acme", "storymap")).toBe(false);
  });

  it("SEM board pertence a todos — trabalho de sessão sem card nasce assim, e escondê-lo refaria o vão", () => {
    expect(belongsToBoard(null, "storymap")).toBe(true);
    expect(belongsToBoard("", "storymap")).toBe(true);
    expect(belongsToBoard(undefined, "storymap")).toBe(true);
  });
});

/**
 * O banner nomeia o bloqueador por branch (`agent/<uuid>`); a linha o nomeia pelo título da tarefa. Sem
 * uma chave de junção, a tela dizia "há trabalho VIVO nos mesmos arquivos" logo acima de "nenhum agente
 * trabalhando neste board agora", com a linha que explicava tudo dobrada num bloco recolhido.
 */
describe("holdsPublish — qual LINHA está segurando a publicação", () => {
  const work = (over: Partial<DeliveryWork> = {}) => ({ sessionId: "abc-123", key: "abc-123", ...over }) as DeliveryWork;

  it("casa pelo dono estruturado, não pelo texto do motivo", () => {
    expect(holdsPublish(work(), { heldBy: ["agent/abc-123"] })).toBe(true);
    expect(holdsPublish(work(), { heldBy: ["fila:abc-123"] })).toBe(true);
    expect(holdsPublish(work(), { heldBy: ["agent/outra-sessao"] })).toBe(false);
  });

  it("casa pela identidade do AGENTE — a árvore sobrevive à reciclagem da sessão", () => {
    expect(holdsPublish(work({ sessionId: "nova", key: "agente-1" }), { heldBy: ["agent/agente-1"] })).toBe(true);
  });

  it("sem donos declarados não aponta ninguém (nunca chuta um culpado)", () => {
    expect(holdsPublish(work(), {})).toBe(false);
    expect(holdsPublish(work(), { heldBy: [] })).toBe(false);
  });
});

describe("projectWork — ordem por atenção", () => {
  it("põe o que PAROU antes do que anda, e o adormecido por último", () => {
    const rows = [
      row({ sessionId: "calma", agentId: "calma", alive: true }),
      row({ sessionId: "dorme", agentId: "dorme", alive: false }),
      row({ sessionId: "anda", agentId: "anda", train: train("gate-running") }),
      row({ sessionId: "parou", agentId: "parou", train: train("conflict") }),
    ];
    expect(projectWork(rows).map((w) => w.key)).toEqual(["parou", "anda", "calma", "dorme"]);
  });

  it("uma integração órfã conta como parada mesmo sem estado ruim no train", () => {
    const rows = [
      row({ sessionId: "ok", agentId: "ok" }),
      row({
        sessionId: "orfa",
        agentId: "orfa",
        orphanedIntegration: { status: "failed", branch: "agent/x", pinnedSha: null, detail: "d" },
      }),
    ];
    const [first] = projectWork(rows);
    expect(first.key).toBe("orfa");
    expect(first.orphaned).toBe(true);
  });

  it("empate de atenção desempata pelo batimento mais recente", () => {
    const rows = [
      row({ sessionId: "velha", agentId: "velha", heartbeatAt: "2026-07-27T10:00:00.000Z" }),
      row({ sessionId: "nova", agentId: "nova", heartbeatAt: "2026-07-27T12:00:00.000Z" }),
    ];
    expect(projectWork(rows).map((w) => w.key)).toEqual(["nova", "velha"]);
  });

  it("marca `stuck` só nos desfechos que pararam fora do stage", () => {
    expect(projectWork([row({ train: train("merging") })])[0].stuck).toBe(false);
    expect(projectWork([row({ train: train("gate-failed") })])[0].stuck).toBe(true);
  });
});

describe("workState — trabalhando × já entregou × resquício", () => {
  const NOW = Date.parse("2026-07-28T12:00:00.000Z");
  const beat = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
  const w = (over: Partial<DeliveryWork>) =>
    ({ pending: null, heartbeatAt: beat(120), train: null, ...over }) as DeliveryWork;

  it("batimento fresco basta — nem pergunta à árvore", () => {
    expect(workState(w({ heartbeatAt: beat(2), pending: false }), NOW)).toBe("working");
  });

  it("árvore suja é trabalho, por mais calada que a sessão esteja", () => {
    expect(workState(w({ pending: true, heartbeatAt: beat(600) }), NOW)).toBe("working");
  });

  it("o train mexendo nela conta como trabalhando", () => {
    expect(workState(w({ pending: false, train: train("merging") }), NOW)).toBe("working");
  });

  it("integrou + árvore limpa + calada = ENTREGOU (a árvore aberta ainda segura publicação)", () => {
    // O caso real: a sessão do vigia de terminais aparecia em "Em curso" 48min depois de publicar.
    expect(workState(w({ pending: false, train: train("done"), heartbeatAt: beat(48) }), NOW)).toBe("delivered");
  });

  it("calada, árvore limpa e sem entrega nenhuma = resquício", () => {
    expect(workState(w({ pending: false, heartbeatAt: beat(300) }), NOW)).toBe("idle");
  });

  it("NÃO SEI sobre a árvore nunca vira 'acabou' — a dúvida pende para trabalhando", () => {
    expect(workState(w({ pending: null, train: train("done"), heartbeatAt: beat(300) }), NOW)).toBe("working");
  });
});

describe("projectWork — a sondagem da árvore chega ao modelo", () => {
  it("mapeia `pending` por sessionId; sem mapa, tudo fica `null` (não sei)", () => {
    const rows = [row({ sessionId: "a", agentId: "a" }), row({ sessionId: "b", agentId: "b" })];
    const semMapa = projectWork(rows);
    expect(semMapa.map((x) => x.pending)).toEqual([null, null]);
    const comMapa = projectWork(rows, new Map([["a", true]]));
    expect(comMapa.find((x) => x.sessionId === "a")!.pending).toBe(true);
    expect(comMapa.find((x) => x.sessionId === "b")!.pending).toBeNull();
  });
});

describe("trainIsMoving", () => {
  it("separa o que anda sozinho do que espera alguém", () => {
    expect(trainIsMoving("gate-running")).toBe(true);
    expect(trainIsMoving("merging")).toBe(true);
    expect(trainIsMoving("conflict")).toBe(false);
    expect(trainIsMoving("returned-to-session")).toBe(false);
  });
});

describe("trainInFlight — o que a raia do train mostra", () => {
  it("mostra o que anda e o que está parado esperando o OPERADOR", () => {
    for (const s of ["waiting", "gate-running", "merging", "re-driving", "gate-failed", "conflict"] as const) {
      expect(trainInFlight(s)).toBe(true);
    }
  });

  it("NÃO mostra a história que a fila guarda — `done` e os terminais", () => {
    // Regressão de produção: a raia acumulava um `failed` de 150h e um `returned-to-session` de 106h
    // (sessão dona já morta) e exibia "2" para sempre, com um "Destravar em Processos" que não leva a
    // nada — /processes também não os trata como travados. Um contador que nunca zera não é sinal.
    expect(trainInFlight("done")).toBe(false);
    expect(trainInFlight("failed")).toBe(false);
    expect(trainInFlight("returned-to-session")).toBe(false);
  });

  it("usa a MESMA régua de 'travado' que /processes (gate-failed · conflict)", () => {
    const parked = (["gate-failed", "conflict"] as const).filter((s) => trainInFlight(s) && !trainIsMoving(s));
    expect(parked).toEqual(["gate-failed", "conflict"]);
  });
});

describe("fila de publicação — o que ainda pode mudar e o que está travado", () => {
  it("openRequests devolve só os estados abertos", () => {
    const rows = [req({ id: "a" }), req({ id: "b", status: "publishing" }), req({ id: "c", status: "published" })];
    expect(openRequests(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("heldRequests exige o carimbo de adiamento — um pedido recém-enfileirado não é 'segurado'", () => {
    const rows = [req({ id: "novo" }), req({ id: "segurado", heldSince: "2026-07-28T00:00:00.000Z" })];
    expect(heldRequests(rows).map((r) => r.id)).toEqual(["segurado"]);
  });

  it("isBlocked: espera longa COM contagem alta é bloqueio; qualquer uma sozinha ainda é lentidão", () => {
    const now = Date.parse("2026-07-28T01:00:00.000Z");
    const heldSince = "2026-07-28T00:00:00.000Z"; // 60 min
    expect(isBlocked(req({ heldSince, heldCount: 50 }), now)).toBe(true);
    expect(isBlocked(req({ heldSince, heldCount: 2 }), now)).toBe(false);
    expect(isBlocked(req({ heldSince: "2026-07-28T00:59:00.000Z", heldCount: 50 }), now)).toBe(false);
    expect(isBlocked(req({ heldCount: 50 }), now)).toBe(false); // sem heldSince = nunca foi adiado
    expect(isBlocked(req({ heldSince, heldCount: 50, status: "published" }), now)).toBe(false);
  });

  it("requestForStage casa por (board, sha) — um pedido de sha antigo não fala pelo stage de agora", () => {
    const rows = [req({ id: "velho", requestedSha: "old" }), req({ id: "atual", requestedSha: "new" })];
    expect(requestForStage(rows, "storymap", "new")?.id).toBe("atual");
    expect(requestForStage(rows, "storymap", "outro")).toBeNull();
    expect(requestForStage(rows, "acme", "new")).toBeNull();
    expect(requestForStage(rows, "storymap", null)).toBeNull();
  });

  it("requestForStage ignora pedido já resolvido (história não oferece botão)", () => {
    const rows = [req({ id: "resolvido", requestedSha: "new", status: "superseded" })];
    expect(requestForStage(rows, "storymap", "new")).toBeNull();
  });
});

describe("parseStagedLog", () => {
  const line = (sha: string, at: string, subject: string) => `${sha} ${at} ${subject}`;

  it("lê sha, data e assunto — com o assunto podendo ter espaços", () => {
    const out = parseStagedLog(
      [
        line("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "2026-07-28T00:10:00-03:00", "usm(sessão): código staged"),
        "",
      ].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      at: "2026-07-28T00:10:00-03:00",
      subject: "usm(sessão): código staged",
    });
  });

  it("extrai a sessão dona quando o assunto a nomeia", () => {
    const out = parseStagedLog(
      line("abc1234", "2026-07-28T00:10:00Z", "usm(sessão): código staged (sessão 2b5cf8d7-6c62-4eb8)"),
    );
    expect(out[0].sessionId).toBe("2b5cf8d7-6c62-4eb8");
  });

  it("sem sessão no assunto, o campo simplesmente não existe", () => {
    const out = parseStagedLog(line("abc1234", "2026-07-28T00:10:00Z", "fix: qualquer coisa"));
    expect(out[0].sessionId).toBeUndefined();
  });

  it("descarta linha malformada sem derrubar a lista", () => {
    const out = parseStagedLog(
      ["lixo sem sha valido aqui", line("abc1234", "2026-07-28T00:10:00Z", "ok"), "   "].join("\n"),
    );
    expect(out.map((d) => d.subject)).toEqual(["ok"]);
  });

  it("o formato declarado é o que o parser espera (sha, data, assunto)", () => {
    expect(STAGED_LOG_FORMAT).toBe("%H %cI %s");
  });
});

describe("releaseCodePrefixes — o escopo que a promoção leva", () => {
  it("sem `package`, cai no prefixo global (legado)", () => {
    expect(releaseCodePrefixes(null, ["packages/"])).toEqual(["packages/"]);
    expect(releaseCodePrefixes({ package: undefined } as never, ["packages/"])).toEqual(["packages/"]);
  });

  it("junta pacote + compartilhados + superfícies, todos com barra final", () => {
    expect(
      releaseCodePrefixes(
        {
          package: "packages/acmeapp",
          sharedPackages: ["packages/acme-shared/"],
          deploy: { surfaces: [{ prefix: "tools/web-terminal" }] },
        } as never,
        ["packages/"],
      ),
    ).toEqual(["packages/acmeapp/", "packages/acme-shared/", "tools/web-terminal/"]);
  });

  it("não deixa a lista global ser mutada por quem a recebe", () => {
    const global = ["packages/"];
    const out = releaseCodePrefixes(null, global);
    out.push("outro/");
    expect(global).toEqual(["packages/"]);
  });
});

// A raia "No stage" faz uma PROMESSA em cada linha. Estes testes pinam quando ela pode fazê-la.
describe("stagedState — a raia não promete publicação que ninguém pediu", () => {
  const st = (o: Partial<Parameters<typeof stagedState>[0]>) =>
    stagedState({ isHead: false, hasRequest: false, held: false, releaseMode: "auto", ...o });

  it("board `manual` sem pedido: PRONTO esperando o clique — não 'agendado', não 'travado'", () => {
    // O defeito que isto tranca: sem pedido não existe próxima publicação, e a raia inteira (topo e
    // carona) anunciava uma. Foi o que fez 7 commits do acme parecerem agendados por 6 dias.
    expect(st({ releaseMode: "manual" })).toBe("awaiting-request");
    expect(st({ releaseMode: "manual", isHead: true })).toBe("awaiting-request");
  });

  it("board `auto` sem pedido: o topo se distingue de quem vai de carona", () => {
    expect(st({ isHead: true })).toBe("head-scheduled");
    expect(st({ isHead: false })).toBe("rides-along");
  });

  it("com pedido aberto o MODO deixa de importar — a máquina que serve é a mesma", () => {
    // É o coração da mudança: `manual` não é um caminho de publicação diferente, é só quem origina.
    for (const releaseMode of ["manual", "auto"] as const) {
      expect(st({ releaseMode, isHead: true, hasRequest: true })).toBe("queued");
      expect(st({ releaseMode, isHead: false, hasRequest: true })).toBe("rides-along");
    }
  });

  it("segurado vence qualquer outra leitura, inclusive um modo que mude por baixo", () => {
    // É o único estado que pede decisão humana; escondê-lo por causa de uma flag de config seria
    // apagar da tela exatamente o que ela existe para mostrar.
    expect(st({ isHead: true, hasRequest: true, held: true })).toBe("held");
    expect(st({ releaseMode: "manual", isHead: true, hasRequest: true, held: true })).toBe("held");
  });
});
