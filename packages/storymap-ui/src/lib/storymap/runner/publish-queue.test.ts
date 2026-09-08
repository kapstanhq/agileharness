// A fila de publicação — os modos de falha que a desenharam.
//
// Ela é a peça que fecha `worktree → train → stage → [buraco] → main → deploy` para trabalho SEM card.
// Como o efeito dela é "promove e REINICIA o serviço", os testes aqui são quase todos sobre NÃO agir:
// quando o pipeline não está claramente ocioso, quando o conteúdo mudou desde o pedido, e — o pior de
// todos — quando um restart interrompeu uma publicação e um retry ingênuo viraria laço de deploy.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  decidePublish,
  drainDeferred,
  drainPublishQueue,
  enqueuePublish,
  findOpenDuplicate,
  nextWaiting,
  reapInterrupted,
  reapInterruptedAtBoot,
  registerPublishDrainTrigger,
  stalePeers,
  type PublishEffect,
  type PublishQueueStore,
  type PublishRequest,
} from "./publish-queue";
import { pipelineIdle } from "./pipeline-idle";

/** O caso feliz: o código ficou em main. É o único veredito que autoriza o carimbo `published`. */
const LANDED: PublishEffect = { landed: true, deferred: false };

const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  id: "pub-1",
  board: "b",
  requestedSha: "aaaa1111",
  requestedBy: "agent",
  requestedAt: "2026-07-22T10:00:00.000Z",
  allowNewer: false,
  status: "waiting",
  ...over,
});

/** Store em memória — o dreno é testado sem disco e sem git. */
function memStore(initial: PublishRequest[] = []): PublishQueueStore & { rows: PublishRequest[] } {
  const box = {
    rows: [...initial],
    async load() {
      return [...box.rows];
    },
    async persist(rows: PublishRequest[]) {
      box.rows = [...rows];
    },
  };
  return box;
}

const idleYes = async () => ({ idle: true, blockedBy: null });

describe("decidePublish — você escolhe O QUE vai ao ar; a fila escolhe só o QUANDO", () => {
  it("publica quando o staging está no sha pedido", () => {
    expect(decidePublish(req(), { stageSha: "aaaa1111", boardEnabled: true })).toEqual({
      action: "publish",
      sha: "aaaa1111",
    });
  });

  it("SUPERSEDE quando o staging andou — publicar seria entregar outra coisa", () => {
    const d = decidePublish(req(), { stageSha: "bbbb2222", boardEnabled: true });
    expect(d.action).toBe("supersede");
    expect(d.action === "supersede" && d.reason).toMatch(/andou desde o pedido/);
  });

  it("allowNewer é o consentimento EXPLÍCITO de levar junto o que entrou depois", () => {
    expect(decidePublish(req({ allowNewer: true }), { stageSha: "bbbb2222", boardEnabled: true })).toEqual({
      action: "publish",
      sha: "bbbb2222",
    });
  });

  it("board desligado SEGURA (não descarta) — o toggle pode voltar e o pedido continua válido", () => {
    expect(decidePublish(req(), { stageSha: "aaaa1111", boardEnabled: false }).action).toBe("hold");
  });

  it("sha ilegível SEGURA — 'não sei' nunca vira autorização", () => {
    expect(decidePublish(req(), { stageSha: null, boardEnabled: true }).action).toBe("hold");
  });
});

describe("reapInterrupted — a trava contra o LAÇO DE DEPLOY", () => {
  // O deploy reinicia o serviço; um pedido `publishing` sobrevive ao restart. Se o boot o tratasse como
  // "não terminou, tente de novo", publicar reiniciaria, o boot reencontraria o pedido, e assim para
  // sempre. Terminal é a única resposta segura: um restart a menos custa menos que restarts infinitos.
  it("converte `publishing` em `interrupted` (TERMINAL), nunca de volta para waiting", () => {
    const out = reapInterrupted([req({ status: "publishing" })], "2026-07-22T11:00:00.000Z");
    expect(out[0].status).toBe("interrupted");
    expect(out[0].reason).toMatch(/reiniciou durante a publicação/);
  });

  it("não toca em pedido que já é história", () => {
    const rows = [req({ status: "published" }), req({ id: "pub-2", status: "waiting" })];
    expect(reapInterrupted(rows, "x").map((r) => r.status)).toEqual(["published", "waiting"]);
  });

  /**
   * O reap rodava dentro de `store.load()`, "para valer para qualquer leitor". O efeito colateral: durante
   * uma publicação LEGÍTIMA em voo, todo leitor (Entrega, publish_status, o próprio dreno) via
   * `interrupted` + "o serviço reiniciou" — falso, terminal, e não-persistido, então a mentira ia e voltava
   * a cada leitura. A trava contra o laço nunca foi o reap: é `nextWaiting`, que só coleta `waiting`.
   */
  it("o LOAD devolve o disco cru — uma publicação EM VOO não lê como interrompida", async () => {
    const store = memStore([req({ status: "publishing" })]);
    expect((await store.load())[0].status).toBe("publishing");
  });

  it("o reap de BOOT persiste a transição (e é no-op quando não há órfão)", async () => {
    const store = memStore([req({ status: "publishing" }), req({ id: "pub-2", status: "waiting" })]);
    expect(await reapInterruptedAtBoot(store)).toBe(1);
    expect(store.rows.map((r) => r.status)).toEqual(["interrupted", "waiting"]);
    expect(await reapInterruptedAtBoot(store)).toBe(0); // idempotente
  });

  it("um `publishing` esquecido no disco NUNCA é re-publicado, com ou sem reap", () => {
    expect(nextWaiting([req({ status: "publishing" })])).toBeNull();
  });
});

describe("fila — FIFO e idempotência", () => {
  it("drena o mais ANTIGO primeiro", () => {
    const older = req({ id: "old", requestedAt: "2026-07-22T09:00:00.000Z" });
    const newer = req({ id: "new", requestedAt: "2026-07-22T12:00:00.000Z" });
    expect(nextWaiting([newer, older])?.id).toBe("old");
  });

  it("reconhece pedido ABERTO duplicado (board+sha) — re-pedir não gera dois deploys", () => {
    expect(findOpenDuplicate([req()], "b", "aaaa1111")?.id).toBe("pub-1");
    expect(findOpenDuplicate([req({ status: "published" })], "b", "aaaa1111")).toBeNull();
  });
});

// A lacuna que motivou o gatilho: um publish_when_idle pedido com o pipeline JÁ ocioso não gera evento
// de idle (o onIdle só dispara numa TRANSIÇÃO), então sem este nudge o pedido espera um intervalo inteiro
// do sweep (~10min medido 2026-07-24). O enqueue passa a cutucar o dreno na hora.
describe("enqueuePublish — cutuca o dreno no enqueue (fecha a lacuna 'já-ocioso')", () => {
  afterEach(() => registerPublishDrainTrigger(() => {})); // não vaza gatilho de um teste para o outro

  it("cutuca o dreno ao enfileirar um pedido NOVO", async () => {
    let nudges = 0;
    registerPublishDrainTrigger(() => {
      nudges++;
    });
    const store = memStore();
    const { deduped } = await enqueuePublish({ board: "b", requestedSha: "sha1", requestedBy: "x", store, now: () => "t" });
    expect(deduped).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(nudges).toBe(1);
  });

  it("cutuca TAMBÉM no dedup — re-chamar publish_when_idle re-cutuca um pedido ENCALHADO sem empilhar outro", async () => {
    let nudges = 0;
    registerPublishDrainTrigger(() => {
      nudges++;
    });
    const store = memStore([req({ board: "b", requestedSha: "sha1", status: "waiting" })]);
    const { deduped } = await enqueuePublish({ board: "b", requestedSha: "sha1", requestedBy: "x", store, now: () => "t" });
    expect(deduped).toBe(true); // idempotente: não gera um segundo pedido
    expect(store.rows).toHaveLength(1);
    expect(nudges).toBe(1); // mas cutuca o dreno para pegar o que estava parado
  });

  it("o dedup ELEVA o pedido aberto quando o novo pede a válvula de escape", async () => {
    // Sem isto a válvula seria inalcançável justamente onde importa: o pedido travado JÁ existe, então
    // pedir de novo COM override casaria com o duplicado e devolveria a linha antiga, seguindo travada.
    const store = memStore([req({ board: "b", requestedSha: "sha1", status: "waiting" })]);
    const { request, deduped } = await enqueuePublish({
      board: "b",
      requestedSha: "sha1",
      requestedBy: "x",
      overrideEmbargo: true,
      store,
      now: () => "t",
    });
    expect(deduped).toBe(true);
    expect(store.rows).toHaveLength(1);
    expect(request.overrideEmbargo).toBe(true);
    expect(store.rows[0].overrideEmbargo).toBe(true);
  });

  it("o dedup NUNCA revoga uma dispensa já concedida — só sobe, nunca desce", async () => {
    const store = memStore([req({ board: "b", requestedSha: "sha1", status: "waiting", overrideEmbargo: true, allowNewer: true })]);
    const { request } = await enqueuePublish({ board: "b", requestedSha: "sha1", requestedBy: "x", store, now: () => "t" });
    expect(request.overrideEmbargo).toBe(true);
    expect(request.allowNewer).toBe(true);
  });
});

/**
 * A PILHA DE PEDIDOS CONDENADOS (2026-07-28). `findOpenDuplicate` deduplica por (board, sha), então cada
 * submit+publish acrescentava mais um pedido aberto ao MESMO board — todos menos o último já condenados
 * (o dreno os supersedaria por "o staging andou"), e cada um rendendo o SEU banner "Publicação segurada"
 * na Entrega. Medido: dois banners idênticos, ambos insolúveis. O veredito não mudou; ele passou a ser
 * entregue no enqueue, que é quando ele já é conhecido.
 */
describe("enqueuePublish — um board, um pedido aberto", () => {
  afterEach(() => registerPublishDrainTrigger(() => {}));

  it("um pedido NOVO supersede os pedidos abertos de shas antigos do mesmo board", async () => {
    const store = memStore([req({ id: "velho", board: "b", requestedSha: "sha-antigo", status: "waiting" })]);
    const { request, superseded } = await enqueuePublish({
      board: "b",
      requestedSha: "sha-novo",
      requestedBy: "x",
      store,
      now: () => "t",
    });
    expect(superseded).toEqual(["velho"]);
    const velho = store.rows.find((r) => r.id === "velho")!;
    expect(velho.status).toBe("superseded");
    expect(velho.resolvedAt).toBe("t");
    expect(velho.reason).toContain(request.id); // a trilha nomeia quem o substituiu
    expect(store.rows.filter((r) => r.status === "waiting")).toHaveLength(1);
  });

  it("NÃO toca em pedido de OUTRO board — a fila é por board, não global", async () => {
    const store = memStore([req({ id: "outro", board: "outro-board", requestedSha: "sha-x", status: "waiting" })]);
    await enqueuePublish({ board: "b", requestedSha: "sha-novo", requestedBy: "x", store, now: () => "t" });
    expect(store.rows.find((r) => r.id === "outro")!.status).toBe("waiting");
  });

  it("NÃO supersede um `allowNewer` — ele não pediu um sha, pediu 'o que estiver lá'", async () => {
    const store = memStore([req({ id: "flex", board: "b", requestedSha: "sha-antigo", status: "waiting", allowNewer: true })]);
    const { superseded } = await enqueuePublish({ board: "b", requestedSha: "sha-novo", requestedBy: "x", store, now: () => "t" });
    expect(superseded).toEqual([]);
    expect(store.rows.find((r) => r.id === "flex")!.status).toBe("waiting");
  });

  it("NÃO reescreve um pedido em VOO (`publishing`) — seria corrida, não limpeza", async () => {
    const store = memStore([req({ id: "voando", board: "b", requestedSha: "sha-antigo", status: "publishing" })]);
    await enqueuePublish({ board: "b", requestedSha: "sha-novo", requestedBy: "x", store, now: () => "t" });
    expect(store.rows.find((r) => r.id === "voando")!.status).toBe("publishing");
  });
});

describe("drainPublishQueue", () => {
  it("fila vazia → não pergunta nem se está ocioso", async () => {
    const idle = vi.fn(idleYes);
    expect(await drainPublishQueue(deps({ store: memStore([]), idle }))).toEqual({ status: "empty" });
    expect(idle).not.toHaveBeenCalled();
  });

  it("pipeline ocupado → NÃO publica, e diz por quê", async () => {
    const publish = vi.fn(async () => LANDED);
    const out = await drainPublishQueue(
      deps({
        store: memStore([req()]),
        idle: async () => ({ idle: false, blockedBy: "um run está em voo/na fila" }),
        publish,
      }),
    );
    expect(out).toEqual({ status: "skipped-busy", blockedBy: "um run está em voo/na fila" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("caminho feliz: publica pelo efeito canônico e marca `published` com o sha", async () => {
    const store = memStore([req()]);
    const publish = vi.fn(async () => LANDED);
    const out = await drainPublishQueue(deps({ store, publish }));
    expect(out).toEqual({ status: "published", id: "pub-1", sha: "aaaa1111" });
    expect(publish).toHaveBeenCalledWith("b", "agent", { overrideEmbargo: undefined });
    expect(store.rows[0]).toMatchObject({ status: "published", publishedSha: "aaaa1111" });
  });

  it("`published` NÃO herda o motivo de 'interrompido' que o reap-on-load carimba na própria linha em voo", async () => {
    // O store REAL roda reapInterrupted em CADA load: ele vê a linha `publishing` que o dreno acabou de
    // marcar e a converte em interrupted + "reiniciou durante a publicação…". O patch final de `published`
    // relê o store (reap) e, sem carimbar a razão, herdava esse texto — 12/12 dos published em prod
    // carregavam a razão de um interrompido que não houve, lendo um SUCESSO como incerteza. Simulamos o reap.
    const INTERRUPT = "o serviço reiniciou durante a publicação (provavelmente o próprio deploy).";
    let rows: PublishRequest[] = [req()];
    const reapingStore: PublishQueueStore = {
      async load() {
        return rows.map((r) => (r.status === "publishing" ? { ...r, status: "interrupted" as const, reason: INTERRUPT } : { ...r }));
      },
      async persist(next) {
        rows = [...next];
      },
    };
    const out = await drainPublishQueue(deps({ store: reapingStore, publish: async () => LANDED }));
    expect(out).toMatchObject({ status: "published" });
    const final = rows.find((r) => r.id === "pub-1");
    expect(final?.status).toBe("published");
    expect(final?.reason).toBeUndefined(); // o published fica LIMPO, sem o texto de interrompido
  });

  it("passa o REQUESTEDBY para o efeito (excludeSessionId) — senão a sessão que publica o próprio trabalho se auto-bloqueia", async () => {
    // A sonda de concorrência da promoção precisa IGNORAR a sessão dona do trabalho staged (é o que vai
    // ao ar). Sem isso, `firePromoteAndDeploy` via `concurrent-work` a cada tick e o pedido nunca aterrissa
    // (o deadlock observado em 2026-07-23 no fluxo submit → publish_when_idle → discard).
    const sid = "44369e5e-2c5a-4467-85ae-a44182441815";
    const store = memStore([req({ requestedBy: sid })]);
    const publish = vi.fn(async () => LANDED);
    await drainPublishQueue(deps({ store, publish }));
    expect(publish).toHaveBeenCalledWith("b", sid, { overrideEmbargo: undefined });
  });

  it("marca `publishing` ANTES de agir — é isso que o reap encontra se o restart nos matar", async () => {
    const store = memStore([req()]);
    let seen: string | undefined;
    await drainPublishQueue(
      deps({
        store,
        publish: async () => {
          seen = store.rows[0].status; // o estado no disco NO MOMENTO da publicação
          return LANDED;
        },
      }),
    );
    expect(seen).toBe("publishing");
  });

  it("staging andou → supersede persistido, e o efeito NUNCA roda", async () => {
    const store = memStore([req()]);
    const publish = vi.fn(async () => LANDED);
    const out = await drainPublishQueue(deps({ store, publish, stageSha: async () => "bbbb2222" }));
    expect(out.status).toBe("superseded");
    expect(publish).not.toHaveBeenCalled();
    expect(store.rows[0].status).toBe("superseded");
  });

  // ── O "publicado" MENTIROSO (2026-07-23) ─────────────────────────────────────────────────────────
  // `publish` era `Promise<void>`, então o dreno só sabia se ela tinha LANÇADO — e o efeito canônico
  // (`firePromoteAndDeploy`) NÃO lança: ele loga a recusa e volta. Aconteceu isto, em produção:
  //   [promote-and-deploy storymap] release falhou (concurrent-work) — deploy suprimido
  //   [harness-publish] {"status":"published","sha":"69aca1e0…"}
  // O pedido virou terminal como `published` com o código fora da main, o serviço nunca reiniciou, e
  // ninguém teve como saber. É a mesma doença que o board já tinha curado nos cards ("No Ar" exige
  // prova), reaparecida na fila.
  it("promote RECUSADO nunca vira `published` — o carimbo exige que o código tenha aterrissado", async () => {
    const store = memStore([req()]);
    const out = await drainPublishQueue(
      deps({ store, publish: async () => ({ landed: false, deferred: false, reason: "apply-failed" }) }),
    );
    expect(out).toMatchObject({ status: "failed", reason: "apply-failed" });
    expect(store.rows[0].status).not.toBe("published");
    expect(store.rows[0]).toMatchObject({ status: "failed", reason: "apply-failed" });
  });

  it("ADIAMENTO (concurrent-work) volta para `waiting` — o próximo tick tenta sozinho", async () => {
    const store = memStore([req()]);
    const out = await drainPublishQueue(
      deps({
        store,
        publish: async () => ({ landed: false, deferred: true, reason: "trabalho vivo nos mesmos arquivos" }),
      }),
    );
    expect(out).toMatchObject({ status: "held", reason: "trabalho vivo nos mesmos arquivos" });
    // NÃO pode ficar em `publishing` (o load seguinte leria como `interrupted`, que é TERMINAL e nunca
    // é re-tentado sozinho) nem virar `failed`: nada quebrou, só não era a hora.
    expect(store.rows[0].status).toBe("waiting");
    expect(store.rows[0].resolvedAt).toBeUndefined();
    // …e o MOTIVO fica gravado. Antes o adiamento zerava `reason`, e o pedido segurado aparecia no
    // publish_status como um `waiting` mudo — a causa só existia no journalctl (2026-07-27: quatro horas
    // de publicação parada lidas como "a fila está lenta").
    expect(store.rows[0].reason).toBe("trabalho vivo nos mesmos arquivos");
    expect(store.rows[0].heldSince).toBeTruthy();
    expect(store.rows[0].heldCount).toBe(1);
  });

  it("adiamentos sucessivos ACUMULAM a contagem e preservam o `heldSince` do primeiro", async () => {
    // "segurado desde 03:08, 160 tentativas" lê-se como TRAVADO; "waiting" lê-se como lento. É a
    // diferença entre o operador agir e o operador esperar.
    const store = memStore([req()]);
    const publish = async () => ({ landed: false, deferred: true, reason: "trabalho vivo" });
    await drainPublishQueue(deps({ store, publish }));
    const first = store.rows[0].heldSince;
    await drainPublishQueue(deps({ store, publish }));
    await drainPublishQueue(deps({ store, publish }));
    expect(store.rows[0].heldCount).toBe(3);
    expect(store.rows[0].heldSince).toBe(first);
  });

  it("o pedido com `overrideEmbargo` leva a dispensa até o efeito — é dele, não do processo", async () => {
    const store = memStore([req({ overrideEmbargo: true })]);
    const publish = vi.fn(async () => LANDED);
    const out = await drainPublishQueue(deps({ store, publish }));
    expect(out).toMatchObject({ status: "published" });
    expect(publish).toHaveBeenCalledWith("b", "agent", { overrideEmbargo: true });
  });

  it("um no-op idempotente ainda é `published` — o código ESTÁ em main", async () => {
    const store = memStore([req()]);
    const out = await drainPublishQueue(
      deps({ store, publish: async () => ({ landed: true, deferred: false, reason: "already-promoted" }) }),
    );
    expect(out).toMatchObject({ status: "published", sha: "aaaa1111" });
  });

  it("falha do efeito vira `failed` com o motivo — não fica preso em publishing", async () => {
    const store = memStore([req()]);
    const out = await drainPublishQueue(
      deps({
        store,
        publish: async () => {
          throw new Error("promote reprovado");
        },
      }),
    );
    expect(out).toMatchObject({ status: "failed", reason: "promote reprovado" });
    expect(store.rows[0]).toMatchObject({ status: "failed", reason: "promote reprovado" });
  });

  it("board desligado → HOLD: continua `waiting` esperando o toggle, mas DIZ que é o toggle", async () => {
    const store = memStore([req()]);
    const out = await drainPublishQueue(deps({ store, boardEnabled: () => false }));
    expect(out.status).toBe("held");
    expect(store.rows[0].status).toBe("waiting"); // o desfecho segue transitório — nada foi resolvido
    expect(store.rows[0].reason).toMatch(/desligada/); // …e a causa é legível sem abrir o journalctl
  });

  it("o HOLD só re-escreve quando o MOTIVO muda — um board desligado não vira uma escrita por tick", async () => {
    const store = memStore([req()]);
    const d = deps({ store, boardEnabled: () => false });
    await drainPublishQueue(d);
    const persist = vi.spyOn(store, "persist");
    await drainPublishQueue(d);
    await drainPublishQueue(d);
    expect(persist).not.toHaveBeenCalled();
  });

  it("drena NO MÁXIMO um por chamada — o restart mataria o segundo no meio de qualquer jeito", async () => {
    const store = memStore([req({ id: "a", requestedAt: "2026-07-22T09:00:00.000Z" }), req({ id: "b2" })]);
    const publish = vi.fn(async () => LANDED);
    await drainPublishQueue(deps({ store, publish }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.rows.find((r) => r.id === "b2")?.status).toBe("waiting");
  });

  // ── head-of-line (2026-07-24): um pedido no TOPO que não publica agora NÃO pode segurar os de baixo ──
  // O dreno olhava só o mais antigo e voltava; com ticks esparsos (on-idle / on-settle / sweep ~10min) um
  // publish_when_idle novo esperava um pedido ALHEIO ser resolvido antes de ser sequer olhado (~8min num
  // board OCIOSO). Agora um tick resolve/pula todos os não-publicáveis e publica UM.
  it("SUPERSEDE no topo não segura um publicável mais novo — os dois resolvem no MESMO tick", async () => {
    const older = req({ id: "old", board: "a", requestedSha: "old-sha", requestedAt: "2026-07-22T09:00:00.000Z" });
    const newer = req({ id: "new", board: "b", requestedSha: "aaaa1111", requestedAt: "2026-07-22T10:00:00.000Z" });
    const store = memStore([older, newer]);
    const publish = vi.fn(async () => LANDED);
    // O staging do board "a" ANDOU (supersede); o do "b" está no sha pedido (publica).
    const stageSha = async (board: string) => (board === "a" ? "moved" : "aaaa1111");
    const out = await drainPublishQueue(deps({ store, publish, stageSha }));
    expect(out).toEqual({ status: "published", id: "new", sha: "aaaa1111" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("b", "agent", { overrideEmbargo: undefined });
    expect(store.rows.find((r) => r.id === "old")?.status).toBe("superseded");
    expect(store.rows.find((r) => r.id === "new")?.status).toBe("published");
  });

  it("HOLD no topo (board desligado) não segura um publicável de OUTRO board", async () => {
    const older = req({ id: "off", board: "a", requestedAt: "2026-07-22T09:00:00.000Z" });
    const newer = req({ id: "on", board: "b", requestedAt: "2026-07-22T10:00:00.000Z" });
    const store = memStore([older, newer]);
    const publish = vi.fn(async () => LANDED);
    const out = await drainPublishQueue(deps({ store, publish, boardEnabled: (b) => b === "b" }));
    expect(out).toMatchObject({ status: "published", id: "on" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.rows.find((r) => r.id === "off")?.status).toBe("waiting"); // hold NÃO persiste
    expect(store.rows.find((r) => r.id === "on")?.status).toBe("published");
  });

  it("ADIAMENTO (concurrent-work) no topo não segura outro board — ele publica; o adiado volta a waiting", async () => {
    const older = req({ id: "busy", board: "a", requestedAt: "2026-07-22T09:00:00.000Z" });
    const newer = req({ id: "free", board: "b", requestedAt: "2026-07-22T10:00:00.000Z" });
    const store = memStore([older, newer]);
    // O board "a" ADIA (trabalho vivo nos mesmos arquivos); o "b" aterrissa.
    const publish = vi.fn(async (board: string) =>
      board === "a" ? { landed: false, deferred: true, reason: "concurrent-work" } : LANDED,
    );
    const out = await drainPublishQueue(deps({ store, publish }));
    expect(out).toMatchObject({ status: "published", id: "free" });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.rows.find((r) => r.id === "busy")?.status).toBe("waiting");
    expect(store.rows.find((r) => r.id === "free")?.status).toBe("published");
  });
});

describe("pipelineIdle — a régua ÚNICA (sweep + publicação)", () => {
  const probes = (inFlight: boolean, live: string[]) => ({
    hasInFlight: () => inFlight,
    liveMergeEntries: async () => live,
  });

  it("ocioso só com engine vazio E train sem entrada viva", async () => {
    expect(await pipelineIdle(probes(false, []))).toEqual({ idle: true, blockedBy: null });
  });

  it("NOMEIA o bloqueador — foi a falta disso que escondeu o bug das 100 entradas terminais", async () => {
    expect((await pipelineIdle(probes(false, ["r1", "r2"]))).blockedBy).toMatch(/merge train com 2 entrada/);
    expect((await pipelineIdle(probes(true, []))).blockedBy).toMatch(/run está em voo/);
  });

  it("sonda quebrada é OCUPADO por default — quem vai reiniciar o serviço não age no escuro", async () => {
    const boom = {
      hasInFlight: () => false,
      liveMergeEntries: async () => {
        throw new Error("git fora do ar");
      },
    };
    const v = await pipelineIdle(boom);
    expect(v.idle).toBe(false);
    expect(v.blockedBy).toMatch(/assumindo ocupado/);
  });

  it("o sweep preserva seu fail-OPEN histórico (trabalho idempotente; não rodar é pior)", async () => {
    const boom = {
      hasInFlight: () => false,
      liveMergeEntries: async () => {
        throw new Error("git fora do ar");
      },
    };
    expect((await pipelineIdle(boom, { onProbeError: "idle" })).idle).toBe(true);
  });
});

/**
 * "33 tentativas" é um número sem EIXO: não distingue "retenta em 15s" de "retenta daqui a 10min", e foi
 * parte do que fazia a Entrega parecer parada com o sistema trabalhando. A ETA vem do CHAMADOR (que tem os
 * timers) e é reestampada a cada adiamento — um `nextAttemptAt` no passado seria pior que nenhum.
 */
describe("nextAttemptAt — a espera passa a ter hora", () => {
  const HELD: PublishEffect = { landed: false, deferred: true, reason: "concurrent-work" };

  it("estampa a ETA em cada adiamento, e a REESTAMPA quando o motivo não mudou", async () => {
    const store = memStore([req({ status: "waiting" })]);
    const d = deps({ store, publish: async () => HELD, retryEtaMs: () => 15_000 });
    await drainPublishQueue(d);
    expect(store.rows[0].nextAttemptAt).toBe("2026-07-22T12:00:15.000Z");
    expect(store.rows[0].heldCount).toBe(1);

    await drainPublishQueue(deps({ ...d, retryEtaMs: () => 600_000 })); // orçamento curto esgotou → sweep
    expect(store.rows[0].nextAttemptAt).toBe("2026-07-22T12:10:00.000Z");
    expect(store.rows[0].heldCount).toBe(2);
  });

  it("sem ETA declarada o campo não existe — prometer hora que ninguém cumpre é pior que não prometer", async () => {
    const store = memStore([req({ status: "waiting" })]);
    await drainPublishQueue(deps({ store, publish: async () => HELD }));
    expect(store.rows[0].nextAttemptAt).toBeUndefined();
  });

  it("publicou ⇒ os campos de ESPERA somem (senão a Entrega mostraria um `published` 'segurado')", async () => {
    const store = memStore([req({ status: "waiting", heldSince: "2026-07-22T11:00:00.000Z", heldCount: 9, nextAttemptAt: "x" })]);
    await drainPublishQueue(deps({ store }));
    expect(store.rows[0].status).toBe("published");
    expect(store.rows[0].heldSince).toBeUndefined();
    expect(store.rows[0].heldCount).toBeUndefined();
    expect(store.rows[0].nextAttemptAt).toBeUndefined();
  });
});

/**
 * A espera longa era invisível fora da página: só descobria as 33 tentativas quem abrisse a Entrega. O
 * aviso dispara na BORDA (lento → bloqueado), uma vez — nunca por tentativa, que seriam dezenas.
 */
describe("onBlocked — o aviso dispara na BORDA, não a cada tentativa", () => {
  const HELD: PublishEffect = { landed: false, deferred: true, reason: "trabalho vivo nos mesmos arquivos" };

  it("silencioso enquanto é só lentidão; avisa UMA vez ao cruzar a régua; cala depois", async () => {
    // A régua (delivery-view isBlocked): >=10min segurado E >=10 adiamentos. Começamos em 9.
    const store = memStore([
      req({ status: "waiting", heldSince: "2026-07-22T11:00:00.000Z", heldCount: 8 }),
    ]);
    const avisos: string[] = [];
    const d = deps({ store, publish: async () => HELD, onBlocked: (r: PublishRequest) => avisos.push(r.id) });

    await drainPublishQueue(d); // heldCount 8 → 9: ainda abaixo da régua
    expect(avisos).toEqual([]);
    await drainPublishQueue(d); // 9 → 10: CRUZA
    expect(avisos).toEqual(["pub-1"]);
    await drainPublishQueue(d); // 10 → 11: já era bloqueio antes, não avisa de novo
    expect(avisos).toEqual(["pub-1"]);
  });

  it("um handler que lança não derruba o dreno — aviso é diagnóstico, não caminho crítico", async () => {
    const store = memStore([req({ status: "waiting", heldSince: "2026-07-22T11:00:00.000Z", heldCount: 9 })]);
    const out = await drainPublishQueue(
      deps({
        store,
        publish: async () => HELD,
        onBlocked: () => {
          throw new Error("canal caiu");
        },
      }),
    );
    expect(out.status).toBe("held");
    expect(store.rows[0].heldCount).toBe(10);
  });
});

describe("stalePeers — quem o pedido novo torna obsoleto", () => {
  it("só `waiting`, só do mesmo board, só de sha diferente, e nunca um allowNewer", () => {
    const rows = [
      req({ id: "mesmo-sha", board: "b", requestedSha: "novo", status: "waiting" }),
      req({ id: "obsoleto", board: "b", requestedSha: "velho", status: "waiting" }),
      req({ id: "outro-board", board: "z", requestedSha: "velho", status: "waiting" }),
      req({ id: "flex", board: "b", requestedSha: "velho", status: "waiting", allowNewer: true }),
      req({ id: "em-voo", board: "b", requestedSha: "velho", status: "publishing" }),
      req({ id: "historia", board: "b", requestedSha: "velho", status: "published" }),
    ];
    expect(stalePeers(rows, "b", "novo").map((r) => r.id)).toEqual(["obsoleto"]);
  });
});

function deps(over: Partial<Parameters<typeof drainPublishQueue>[0]> = {}) {
  return {
    store: memStore(),
    idle: idleYes,
    stageSha: async () => "aaaa1111",
    boardEnabled: () => true,
    publish: async () => LANDED,
    now: () => "2026-07-22T12:00:00.000Z",
    ...over,
  };
}

// drainDeferred — quais desfechos merecem um retry CURTO (em vez de esperar o próximo tick do sweep).
// É o predicado que fecha a lacuna "o gatilho fino disparou cedo demais e nada re-tentou" (2026-07-24).
describe("drainDeferred", () => {
  it("re-tenta em desfechos TRANSITÓRIOS (o trabalho ainda quer publicar)", () => {
    expect(drainDeferred({ status: "skipped-busy", blockedBy: "um run está em voo/na fila" })).toBe(true);
    expect(drainDeferred({ status: "skipped-busy", blockedBy: null })).toBe(true);
    expect(drainDeferred({ status: "held", id: "pub-1", reason: "concurrent-work" })).toBe(true);
  });

  it("NÃO re-tenta em fila vazia nem em desfechos RESOLVIDOS (nada mais a fazer)", () => {
    expect(drainDeferred({ status: "empty" })).toBe(false);
    expect(drainDeferred({ status: "published", id: "pub-1", sha: "aaaa1111" })).toBe(false);
    expect(drainDeferred({ status: "superseded", id: "pub-1", reason: "staging andou" })).toBe(false);
    expect(drainDeferred({ status: "failed", id: "pub-1", reason: "promote lançou" })).toBe(false);
    expect(drainDeferred(null)).toBe(false);
    expect(drainDeferred(undefined)).toBe(false);
  });
});
