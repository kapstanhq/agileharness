import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLISH_BACKOFF,
  PublishBreaker,
  backoffDelayMs,
  classifyPublishFailure,
  diskPublishBreakerStore,
  nextPublishAttempt,
  publishHoldReason,
  publishRetryAt,
  type PublishAttempt,
  type PublishBreakerStore,
} from "./publish-breaker";

// O DISJUNTOR da publicação automática. O incidente clássico (release→deploy→exit 3→revert→release, uma vez por
// minuto por horas, milhares de ciclos) é reproduzido como PROPRIEDADE: sob falha determinística, o número de
// tentativas por dia é pequeno e limitado — não 1.440.

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 29, 2, 0, 0);
const KEY = { board: "armazem", cardId: "story-x" };

class MemStore implements PublishBreakerStore {
  rows: PublishAttempt[] = [];
  async load() {
    return structuredClone(this.rows);
  }
  async persist(rows: PublishAttempt[]) {
    this.rows = structuredClone(rows);
  }
}

describe("classifyPublishFailure / backoffDelayMs", () => {
  it("needs-human, needs-units e needs-proof dependem de ALGUÉM agir; o resto pode passar sozinho", () => {
    expect(classifyPublishFailure("needs-human")).toBe("deterministic");
    expect(classifyPublishFailure("needs-units")).toBe("deterministic");
    expect(classifyPublishFailure("needs-proof")).toBe("deterministic");
    for (const p of ["deploy", "freshness", "release", "deploy-noop", "face-stale", undefined]) {
      expect(classifyPublishFailure(p)).toBe("transient");
    }
  });

  it("transitória: 10 min → 40 min → 2 h 40 → teto de 6 h (e fica no teto)", () => {
    const d = (n: number) => backoffDelayMs("transient", n) / MIN;
    expect([1, 2, 3, 4, 5, 9].map(d)).toEqual([10, 40, 160, 360, 360, 360]);
  });

  it("determinística: sempre 6 h (a causa só muda quando alguém age)", () => {
    expect([1, 2, 3].map((n) => backoffDelayMs("deterministic", n))).toEqual([6 * HOUR, 6 * HOUR, 6 * HOUR]);
  });
});

describe("nextPublishAttempt — a contagem e o limite", () => {
  it("a 1ª falha nasce com consecutive 1, o recuo da classe e guarda fase e exit", () => {
    const a = nextPublishAttempt(undefined, KEY, { phase: "needs-human", exitCode: 3 }, T0);
    expect(a).toEqual({ ...KEY, phase: "needs-human", exitCode: 3, consecutive: 1, lastAt: T0, nextAt: T0 + 6 * HOUR, exhausted: false });
  });

  it("fase ausente vale `deploy` (transitória) e exit ausente vira null", () => {
    expect(nextPublishAttempt(undefined, KEY, {}, T0)).toMatchObject({ phase: "deploy", exitCode: null, nextAt: T0 + 10 * MIN });
  });

  it("FRONTEIRA do limite: transitória esgota na 5ª seguida (não na 4ª); determinística na 3ª (não na 2ª)", () => {
    let t = nextPublishAttempt(undefined, KEY, { phase: "deploy", exitCode: -1 }, T0);
    const seen: boolean[] = [t.exhausted];
    for (let i = 2; i <= 5; i++) {
      t = nextPublishAttempt(t, KEY, { phase: "deploy", exitCode: -1 }, t.lastAt + HOUR);
      seen.push(t.exhausted);
    }
    expect(seen).toEqual([false, false, false, false, true]);
    expect(PUBLISH_BACKOFF.transient.maxConsecutive).toBe(5);

    let d = nextPublishAttempt(undefined, KEY, { phase: "needs-human", exitCode: 3 }, T0);
    const dseen: boolean[] = [d.exhausted];
    for (let i = 2; i <= 3; i++) {
      d = nextPublishAttempt(d, KEY, { phase: "needs-human", exitCode: 3 }, d.lastAt + HOUR);
      dseen.push(d.exhausted);
    }
    expect(dseen).toEqual([false, false, true]);
  });

  it("depois de 24h de silêncio a contagem recomeça; dentro das 24h ela continua", () => {
    const first = nextPublishAttempt(undefined, KEY, { phase: "deploy" }, T0);
    const within = nextPublishAttempt(first, KEY, { phase: "deploy" }, T0 + PUBLISH_BACKOFF.forgetAfterMs);
    expect(within.consecutive).toBe(2);
    const after = nextPublishAttempt(first, KEY, { phase: "deploy" }, T0 + PUBLISH_BACKOFF.forgetAfterMs + 1);
    expect(after.consecutive).toBe(1);
  });

  it("a fase MUDA a classe do recuo: transitória seguida de needs-human passa a esperar 6 h", () => {
    const a = nextPublishAttempt(undefined, KEY, { phase: "deploy" }, T0);
    const b = nextPublishAttempt(a, KEY, { phase: "needs-human", exitCode: 3 }, T0 + 11 * MIN);
    expect(b).toMatchObject({ consecutive: 2, phase: "needs-human", nextAt: T0 + 11 * MIN + 6 * HOUR });
  });
});

describe("publishHoldReason — o que a cascata lê", () => {
  const a = nextPublishAttempt(undefined, KEY, { phase: "needs-human", exitCode: 3 }, T0);

  it("sem registro ⇒ livre", () => {
    expect(publishHoldReason(undefined, T0)).toBeNull();
  });

  it("dentro do recuo ⇒ segura, dizendo quantas vezes, por quê e quando volta — e que o botão sempre passa", () => {
    const r = publishHoldReason(a, T0 + 2 * HOUR)!;
    expect(r).toContain("1× seguidas");
    // reescrito de propósito: o rótulo diz a decisão que espera — não «só o dono publica», que o dono leigo lia
    // como tarefa dele num item que era, na maior parte, lacuna de configuração do sistema
    expect(r).toContain("espera uma decisão do dono");
    expect(r).not.toContain("só o dono publica");
    expect(r).toContain("4 h"); // faltam 4h dos 6h
    expect(r).toContain("«Publicar»");
  });

  it("FRONTEIRA: no instante do vencimento já está livre; 1 ms antes ainda segura", () => {
    expect(publishHoldReason(a, a.nextAt - 1)).not.toBeNull();
    expect(publishHoldReason(a, a.nextAt)).toBeNull();
  });

  it("ESGOTADO segura para sempre (o relógio não o libera) e manda publicar pelo botão", () => {
    const ex: PublishAttempt = { ...a, consecutive: 3, exhausted: true };
    const r = publishHoldReason(ex, ex.nextAt + 30 * 24 * HOUR)!;
    expect(r).toContain("parou de tentar sozinho");
    expect(r).toContain("3× seguidas");
  });

  it("fase sem rótulo cai em «o deploy falhou (exit N)»", () => {
    const x = nextPublishAttempt(undefined, KEY, { phase: "deploy", exitCode: -1 }, T0);
    expect(publishHoldReason(x, T0)).toContain("o deploy falhou (exit -1)");
  });
});

describe("publishRetryAt — quando o sistema tenta de novo sozinho (o Inbox não oferece botão arriscado antes)", () => {
  const a = nextPublishAttempt(undefined, KEY, { phase: "freshness" }, T0);
  it("agendada ⇒ o instante; vencida, esgotada ou sem registro ⇒ null", () => {
    expect(publishRetryAt(a, T0 + MIN)).toBe(T0 + 10 * MIN);
    expect(publishRetryAt(a, T0 + 10 * MIN)).toBeNull();
    expect(publishRetryAt({ ...a, exhausted: true }, T0)).toBeNull();
    expect(publishRetryAt(undefined, T0)).toBeNull();
  });
  it("lido pelo card, através da linha da causa que o segura", async () => {
    const b = new PublishBreaker(new MemStore(), () => T0);
    await b.recordFailure("armazem", "s1", { phase: "freshness", causeKey: "armazem:freshness" });
    await b.recordFailure("armazem", "s2", { phase: "freshness", causeKey: "armazem:freshness" });
    expect(await b.retryAt("armazem", "s2")).toBe(T0 + 10 * MIN);
    expect(await b.retryAt("armazem", "outro")).toBeNull();
  });
});

describe("PublishBreaker — o registro", () => {
  it("recordFailure grava no store; clear remove; holdReason/due leem o estado", async () => {
    const store = new MemStore();
    let now = T0;
    const b = new PublishBreaker(store, () => now);
    await b.recordFailure("armazem", "story-a", { phase: "needs-human", exitCode: 3 });
    await b.flush();
    expect(store.rows).toHaveLength(1);
    expect(await b.holdReason("armazem", "story-a", now + HOUR)).toContain("nova tentativa automática");
    expect(await b.holdReason("armazem", "story-b", now + HOUR)).toBeNull(); // outro card não é afetado
    expect(await b.due(now + HOUR)).toEqual([]);
    expect((await b.due(now + 6 * HOUR)).map((x) => x.cardId)).toEqual(["story-a"]);
    await b.clear("armazem", "story-a");
    await b.flush();
    expect(store.rows).toEqual([]);
    expect(await b.holdReason("armazem", "story-a", now)).toBeNull();
    await b.clear("armazem", "story-a"); // idempotente
  });

  it("due() nunca devolve um esgotado (ele espera o botão, não o relógio)", async () => {
    const b = new PublishBreaker(new MemStore(), () => T0);
    for (let i = 0; i < PUBLISH_BACKOFF.deterministic.maxConsecutive; i++) await b.recordFailure("armazem", "s", { phase: "needs-human", exitCode: 3 });
    expect((await b.snapshot())[0]).toMatchObject({ exhausted: true });
    expect(await b.due(T0 + 365 * 24 * HOUR)).toEqual([]);
  });

  // Reescrito de propósito: o fôlego empurrava `nextAt`, e a reavaliação que ele protegia lia a trava armada e
  // SEGURAVA o card — a re-tentativa automática nunca encaminhava. O fôlego agora é `leaseUntil`: só adia o `due`.
  it("lease adia o VENCIMENTO (due) e nunca o antecipa — mas não segura a cascata que a re-tentativa aciona", async () => {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    await b.recordFailure("armazem", "s", { phase: "deploy" }); // vence em T0+10min
    now = T0 + 10 * MIN;
    await b.lease("armazem", "s", T0 + 30 * MIN);
    expect((await b.snapshot())[0]).toMatchObject({ nextAt: T0 + 10 * MIN, leaseUntil: T0 + 30 * MIN });
    expect(await b.holdReason("armazem", "s", now)).toBeNull(); // a reavaliação ENCAMINHA
    expect(await b.due(now)).toEqual([]); // e a linha não vence de novo no próximo tick
    await b.lease("armazem", "s", T0 + 15 * MIN); // menor que o atual: ignora
    expect((await b.snapshot())[0]!.leaseUntil).toBe(T0 + 30 * MIN);
    expect((await b.due(T0 + 30 * MIN)).map((a) => a.cardId)).toEqual(["s"]);
  });

  it("uma falha gravada durante a carga sobrevive à cópia velha do disco (mescla, não sobrescreve)", async () => {
    const store = new MemStore();
    store.rows = [nextPublishAttempt(undefined, { board: "armazem", cardId: "velho" }, { phase: "deploy" }, T0 - HOUR)];
    const b = new PublishBreaker(store, () => T0);
    await Promise.all([b.recordFailure("armazem", "novo", { phase: "deploy" }), b.ensureLoaded()]);
    expect((await b.snapshot()).map((x) => x.cardId).sort()).toEqual(["novo", "velho"]);
  });
});

describe("PublishBreaker — uma linha por CAUSA (várias linhas para poucas causas)", () => {
  const NH = { phase: "needs-human", exitCode: 3, causeKey: "armazem:owner:money" };

  it("2 falhas com a mesma causa em 1 h ⇒ UMA tentativa: o 2º card só entra na linha (sem contar, sem empurrar o relógio)", async () => {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    await b.recordFailure("armazem", "story-a", NH);
    now = T0 + HOUR;
    await b.recordFailure("armazem", "story-b", NH);
    const rows = await b.due(T0 + 6 * HOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ causeKey: "armazem:owner:money", consecutive: 1, nextAt: T0 + 6 * HOUR, cardIds: ["story-a", "story-b"] });
    // os dois estão segurados pela MESMA linha
    expect(await b.holdReason("armazem", "story-b", T0 + 2 * HOUR)).toContain("1× seguidas");
    // a visão por card (vigia de parada, varredura de esquecer) vê um registro para cada card
    expect((await b.snapshot()).map((a) => a.cardId).sort()).toEqual(["story-a", "story-b"]);
  });

  it("a falha que chega com o intervalo VENCIDO conta (é a re-tentativa) — e a das caronas logo depois só entra", async () => {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    await b.recordFailure("armazem", "story-a", NH);
    await b.recordFailure("armazem", "story-b", NH);
    now = T0 + 6 * HOUR; // venceu: a re-tentativa leva os dois, o deploy falha de novo para os dois
    await b.recordFailure("armazem", "story-b", NH);
    await b.recordFailure("armazem", "story-a", NH);
    const [row] = await b.due(T0 + 12 * HOUR);
    expect(row).toMatchObject({ consecutive: 2, cardId: "story-b", nextAt: T0 + 12 * HOUR });
  });

  it("a BORDA: causa sumida ⇒ a linha vence AGORA (mesmo esgotada) e devolve os cards que segurava", async () => {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    for (let i = 0; i < PUBLISH_BACKOFF.deterministic.maxConsecutive; i++) {
      await b.recordFailure("armazem", "story-a", NH);
      now += 6 * HOUR;
    }
    await b.recordFailure("armazem", "story-b", NH); // entra na linha esgotada
    expect(await b.due(now)).toEqual([]);
    now += 5 * MIN;
    expect(await b.releaseCause("armazem", "armazem:owner:money", now)).toEqual(["story-a", "story-b"]);
    const [row] = await b.due(now);
    expect(row).toMatchObject({ exhausted: false });
    expect(row.nextAt).toBeLessThanOrEqual(now); // vence agora (nunca adia um relógio que já tinha vencido)
    expect(await b.holdReason("armazem", "story-b", now)).toBeNull();
    expect(await b.releaseCause("armazem", "armazem:outra", now)).toEqual([]);
  });

  // A borda compara duas fontes (o plano de agora e a causa que o revert montou do log). Se elas discordam sempre, a causa
  // é julgada morta a cada janela de re-medição (15 min): sem limite, cada borda tirava o esgotamento e rodava o deploy
  // real de novo — o laço que o disjuntor existe para impedir, só mais lento (revisão do WP2: 20 tentativas em 20 janelas).
  it("a borda CONTA contra o teto e só tira o esgotamento UMA vez: borda em toda janela ⇒ no máximo teto + 1 tentativas", async () => {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    const max = PUBLISH_BACKOFF.deterministic.maxConsecutive;
    await b.recordFailure("armazem", "story-a", NH);
    let attempts = 1;
    for (let window = 0; window < 20; window++) {
      now += 15 * MIN;
      await b.releaseCause("armazem", "armazem:owner:money", now); // a re-medição «viu a causa sumir» de novo
      if ((await b.due(now)).length) {
        attempts++;
        await b.recordFailure("armazem", "story-a", NH); // e o deploy real recusou de novo pela mesma causa
      }
    }
    expect(attempts).toBe(max + 1);
    expect(await b.due(now + 24 * HOUR)).toEqual([]); // esgotada: espera o botão (ou 24 h de silêncio e uma falha nova)
    expect(await b.holdReason("armazem", "story-a", now)).toContain("parou de tentar sozinho");
    // a borda que recusa diz que recusou (null) — diferente de «não há linha» ([])
    expect(await b.releaseCause("armazem", "armazem:owner:money", now)).toBeNull();
    expect(await b.releaseCause("armazem", "armazem:outra", now)).toEqual([]);
  });

  it("o card que muda de causa sai da linha antiga (um card, uma causa); a linha vazia some", async () => {
    const b = new PublishBreaker(new MemStore(), () => T0);
    await b.recordFailure("armazem", "story-a", NH);
    await b.recordFailure("armazem", "story-a", { phase: "needs-units", exitCode: 3, causeKey: "armazem:system" });
    const snap = await b.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ causeKey: "armazem:system", cardId: "story-a" });
  });

  it("a linha antiga POR CARD migra para a causa sem zerar o recuo (o backfill e a 1ª falha pós-atualização)", async () => {
    const store = new MemStore();
    const old = nextPublishAttempt(undefined, { board: "armazem", cardId: "story-a" }, { phase: "needs-human", exitCode: 3 }, T0);
    store.rows = [old];
    const b = new PublishBreaker(store, () => T0 + HOUR);
    await b.adoptCard("armazem", "story-a", "armazem:system", "needs-units");
    await b.adoptCard("armazem", "story-c", "armazem:system", "needs-units"); // sem linha antiga: entra na da causa
    const rows = await b.due(T0 + 6 * HOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ causeKey: "armazem:system", consecutive: 1, nextAt: T0 + 6 * HOUR, cardIds: ["story-a", "story-c"] });
    // card sem linha nenhuma e causa sem linha: nasce segurado (o recuo da classe a partir de agora)
    await b.adoptCard("armazem", "story-z", "armazem:freshness", "freshness");
    expect(await b.holdReason("armazem", "story-z", T0 + HOUR + MIN)).not.toBeNull();
  });

  it("sucesso SOLTA a linha (a causa acabou): o card sai e os outros vencem agora; esquecer tira só o card", async () => {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    for (const c of ["story-a", "story-b", "story-c"]) await b.recordFailure("armazem", c, NH);
    now = T0 + MIN;
    await b.forget("armazem", "story-c"); // saiu do caminho: a causa segue segurando os outros
    expect(await b.holdReason("armazem", "story-b", now)).not.toBeNull();
    await b.clear("armazem", "story-a");
    expect(await b.holdReason("armazem", "story-b", now)).toBeNull();
    expect((await b.due(now)).map((r) => r.cardIds)).toEqual([["story-b"]]);
  });
});

describe("store em disco", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "publish-breaker-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trip: o que um processo grava, o seguinte lê (o recuo sobrevive a restart)", async () => {
    const a = new PublishBreaker(diskPublishBreakerStore(dir), () => T0);
    await a.recordFailure("armazem", "s", { phase: "needs-human", exitCode: 3 });
    await a.flush();
    const b = new PublishBreaker(diskPublishBreakerStore(dir), () => T0 + HOUR);
    expect(await b.holdReason("armazem", "s")).toContain("1× seguidas");
  });

  it("a linha da causa (cardIds, causeKey, fôlego) sobrevive ao restart", async () => {
    const a = new PublishBreaker(diskPublishBreakerStore(dir), () => T0);
    await a.recordFailure("armazem", "s1", { phase: "needs-units", exitCode: 3, causeKey: "armazem:system" });
    await a.recordFailure("armazem", "s2", { phase: "needs-units", exitCode: 3, causeKey: "armazem:system" });
    await a.lease("armazem", "s1", T0 + 7 * HOUR);
    await a.flush();
    const b = new PublishBreaker(diskPublishBreakerStore(dir), () => T0 + HOUR);
    expect(await b.holdReason("armazem", "s2")).toContain("trabalho do sistema");
    expect(await b.due(T0 + 6 * HOUR)).toEqual([]); // o fôlego também voltou
  });

  it("versão desconhecida, JSON quebrado e linha inválida valem como vazio — nunca derrubam a cascata", async () => {
    const file = path.join(dir, "deploy-attempts.json");
    writeFileSync(file, JSON.stringify({ version: 99, entries: [{ anything: true }] }));
    expect(await diskPublishBreakerStore(dir).load()).toEqual([]);
    writeFileSync(file, "{ não é json");
    expect(await diskPublishBreakerStore(dir).load()).toEqual([]);
    const good = nextPublishAttempt(undefined, KEY, { phase: "deploy" }, T0);
    writeFileSync(file, JSON.stringify({ version: 1, entries: [good, { board: "x" }] }));
    expect(await diskPublishBreakerStore(dir).load()).toEqual([good]);
  });

  it("carga SÍNCRONA: o que o processo anterior gravou vale já na PRIMEIRA consulta, sem esperar I/O — nenhuma janela sem estado após o boot", async () => {
    const a = new PublishBreaker(diskPublishBreakerStore(dir), () => T0);
    await a.recordFailure("armazem", "s", { phase: "needs-human", exitCode: 3 });
    await a.flush();
    const b = new PublishBreaker(diskPublishBreakerStore(dir), () => T0 + HOUR);
    // resolve em microtasks (nenhum timer/I-O): é isso que a cascata — caminho quente de toda avaliação — precisa
    let resolved = false;
    void b.ensureLoaded().then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(await b.holdReason("armazem", "s")).toContain("1× seguidas");
  });

  it("persist é atômico (sem .tmp sobrando) e grava a versão", async () => {
    const s = diskPublishBreakerStore(dir);
    await s.persist([nextPublishAttempt(undefined, KEY, { phase: "deploy" }, T0)]);
    expect(JSON.parse(readFileSync(path.join(dir, "deploy-attempts.json"), "utf8")).version).toBe(1);
    expect(() => readFileSync(path.join(dir, "deploy-attempts.json.tmp"))).toThrow();
  });
});

describe("a PROPRIEDADE do incidente — a cascata não martela uma publicação que não anda", () => {
  /**
   * Simula a cascata como ela era: a cada minuto ela vê o card em `release` e quer encaminhá-lo. SEM disjuntor cada
   * minuto dispara um deploy (1.440/dia). COM ele, dispara só quando `holdReason` libera — e cada disparo falha.
   */
  async function firesIn(hours: number, phase: string, exitCode: number): Promise<number> {
    let now = T0;
    const b = new PublishBreaker(new MemStore(), () => now);
    let fires = 0;
    for (let minute = 0; minute < hours * 60; minute++, now += MIN) {
      if ((await b.holdReason("armazem", "s", now)) !== null) continue; // a cascata para
      fires++; // a cascata encaminha ⇒ deploy dispara ⇒ falha ⇒ revert registra
      await b.recordFailure("armazem", "s", { phase, exitCode });
    }
    return fires;
  }

  it("falha DETERMINÍSTICA (exit 3 «precisa do dono»): 3 disparos no total, não 1.440 por dia", async () => {
    expect(await firesIn(24, "needs-human", 3)).toBe(PUBLISH_BACKOFF.deterministic.maxConsecutive);
  });

  it("falha TRANSITÓRIA: recua 10→40→160→360 min e PARA no limite, em vez de insistir", async () => {
    expect(await firesIn(24, "deploy", -1)).toBe(PUBLISH_BACKOFF.transient.maxConsecutive);
  });

  it("mesmo depois de dias o esgotado não volta sozinho (só o botão)", async () => {
    expect(await firesIn(24 * 7, "needs-human", 3)).toBe(PUBLISH_BACKOFF.deterministic.maxConsecutive);
  });
});
