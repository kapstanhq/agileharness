import { describe, expect, it } from "vitest";
import {
  coerceNoopByItem,
  coerceNoopStreak,
  emptyOrchestratorState,
  rolloverBudget,
  budgetOk,
  leaseHeldByHuman,
  applyTick,
  applyTickOutcome,
  applyLease,
  releaseLease,
  rateWithinLimit,
  applyAction,
  hourKey,
  leaseHeldByTick,
  applyRunResult,
  isAbortiveRun,
  spawnBreakerOpen,
  readOrchestratorState,
  writeOrchestratorState,
  bumpNoopByItem,
  bumpNoopByAttempt,
  clearNoopItem,
  markObservedFact,
  markStewardRearm,
  itemsInNoopBackoff,
  PER_ITEM_NOOP_MAX,
  SPAWN_BREAKER_THRESHOLD,
  SPAWN_BREAKER_BASE_COOLDOWN_MS,
  SPAWN_BREAKER_MAX_COOLDOWN_MS,
  type OrchestratorState,
} from "./orchestrator-state";
import { AUTONOMO_DOCTRINE_VERSION } from "@/lib/storymap/copilot/tier";
import type { OrchestratorSettings } from "@/lib/storymap/types";

const DAY1 = Date.parse("2026-07-10T09:00:00Z");
const DAY2 = Date.parse("2026-07-11T09:00:00Z");
const settings = (over: Partial<OrchestratorSettings> = {}): OrchestratorSettings => ({
  enabled: true,
  tickMinutes: 30,
  budget: { maxTicksPerDay: 3, maxCostPerDay: 5 },
  ...over,
});

describe("orchestrator-state (WS8) — pure budget + lease", () => {
  it("budget rolls over on a new day (counters reset)", () => {
    let s = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous", 2);
    expect(s.budget.ticksToday).toBe(1);
    s = rolloverBudget(s, DAY2);
    expect(s.budget.day).toBe("2026-07-11");
    expect(s.budget.ticksToday).toBe(0);
    expect(s.budget.costToday).toBe(0);
  });

  it("budgetOk: within cap → true; ticks OR cost over cap → false", () => {
    const fresh = emptyOrchestratorState(DAY1);
    expect(budgetOk(fresh, settings(), DAY1)).toBe(true);
    let s = fresh;
    for (let i = 0; i < 3; i++) s = applyTick(s, DAY1, "autonomous");
    expect(budgetOk(s, settings(), DAY1)).toBe(false); // 3 ticks == cap
    // cost cap independently
    const costy = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous", 5);
    expect(budgetOk(costy, settings(), DAY1)).toBe(false);
    // no budget configured → always ok
    expect(budgetOk(s, settings({ budget: undefined }), DAY1)).toBe(true);
  });

  it("leaseHeldByHuman: active paired lease blocks; expired or tick-owned does not", () => {
    const base = emptyOrchestratorState(DAY1);
    const held = applyLease(base, "paired", DAY1, 60_000);
    expect(leaseHeldByHuman(held, DAY1)).toBe(true);
    expect(leaseHeldByHuman(held, DAY1 + 120_000)).toBe(false); // expired
    const tickLease = applyLease(base, "tick", DAY1, 60_000);
    expect(leaseHeldByHuman(tickLease, DAY1)).toBe(false); // tick-owned, not a human
    expect(leaseHeldByHuman(base, DAY1)).toBe(false); // no lease
  });

  it("applyTick stamps mode + lastTickAt and increments the day's counters", () => {
    const s = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous", 1.5);
    expect(s.mode).toBe("autonomous");
    expect(s.lastTickAt).toBe(new Date(DAY1).toISOString());
    expect(s.budget.ticksToday).toBe(1);
    expect(s.budget.costToday).toBe(1.5);
  });

  it("3.5a — applyTick also records lastTick outcome:ran", () => {
    const s = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous");
    expect(s.lastTick).toEqual({ at: new Date(DAY1).toISOString(), outcome: "ran" });
  });

  it("3.5a — applyTickOutcome stamps a STAND-DOWN (skipped + reason) WITHOUT touching budget", () => {
    const base = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous"); // 1 tick consumed
    const skipped = applyTickOutcome(base, DAY2, "skipped", "skipped-no-work");
    expect(skipped.lastTick).toMatchObject({ at: new Date(DAY2).toISOString(), outcome: "skipped", reason: "skipped-no-work" });
    expect(skipped.budget.ticksToday).toBe(base.budget.ticksToday); // a skip never consumes budget
    expect(skipped.lastTickAt).toBe(base.lastTickAt); // and does not move the "last acted" marker
  });

  it("6.4 — releaseLease clears the PAIRED lease (applyLease can only SET one)", () => {
    const held = applyLease(emptyOrchestratorState(DAY1), "paired", DAY1, 60_000);
    expect(held.pairedLease).not.toBeNull();
    expect(releaseLease(held).pairedLease ?? null).toBeNull();
  });

  it("6.4 — applyLease RENEWS (extends) an existing lease past its original expiry", () => {
    const s1 = applyLease(emptyOrchestratorState(DAY1), "paired", DAY1, 60_000);
    const s2 = applyLease(s1, "paired", DAY1 + 30_000, 60_000); // renew 30s in
    expect(new Date(s2.pairedLease!.expiresAt).getTime()).toBe(DAY1 + 30_000 + 60_000);
    expect(leaseHeldByHuman(s2, DAY1 + 80_000)).toBe(true); // still held past the ORIGINAL 60s expiry
  });

  it("WS-4.1 — the two slots are INDEPENDENT: acquiring paired does NOT clear a live tickLease, and vice-versa", () => {
    const withTick = applyLease(emptyOrchestratorState(DAY1), "tick", DAY1, 60_000);
    const withBoth = applyLease(withTick, "paired", DAY1, 60_000); // human pairs while a tick run is in flight
    expect(leaseHeldByTick(withBoth, DAY1)).toBe(true); // tickLease survived the paired acquire (was clobbered pre-WS-4)
    expect(leaseHeldByHuman(withBoth, DAY1)).toBe(true); // paired is also held
    // and the reverse: acquiring the tick lease never touches a live paired lease
    const withPaired = applyLease(emptyOrchestratorState(DAY1), "paired", DAY1, 60_000);
    const both2 = applyLease(withPaired, "tick", DAY1, 60_000);
    expect(leaseHeldByHuman(both2, DAY1)).toBe(true);
    expect(leaseHeldByTick(both2, DAY1)).toBe(true);
  });

  it("WS-4.1 — the anti-two-copilotos trava: human closes the chat with a tick run in flight → runInFlight STILL blocks", () => {
    // The key regression: pre-WS-4 the paired acquire clobbered the tick lease, so release→null let a second
    // copilot spawn while the first was live. Now release clears ONLY pairedLease → tickLease keeps blocking.
    const inFlight = applyLease(emptyOrchestratorState(DAY1), "tick", DAY1, 60_000);
    const paired = applyLease(inFlight, "paired", DAY1, 60_000);
    const closed = releaseLease(paired); // human closes the chat
    expect(leaseHeldByHuman(closed, DAY1)).toBe(false); // paired released
    expect(leaseHeldByTick(closed, DAY1)).toBe(true); // but the in-flight tick STILL holds → no second copiloto
  });

  it("6.4 — anti-noop: an UNCHANGED workSig grows the ran streak; a CHANGED one resets it to 1", () => {
    let s = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous", 0, "sigA");
    expect(s.noop).toEqual({ workSig: "sigA", ranStreak: 1 });
    s = applyTick(s, DAY1, "autonomous", 0, "sigA");
    expect(s.noop).toEqual({ workSig: "sigA", ranStreak: 2 }); // no board progress → streak grows
    s = applyTick(s, DAY1, "autonomous", 0, "sigB");
    expect(s.noop).toEqual({ workSig: "sigB", ranStreak: 1 }); // board changed → reset
  });

  it("6.4 — applyTick WITHOUT a workSig leaves the noop state untouched (legacy callers/tests)", () => {
    const seeded = applyTick(emptyOrchestratorState(DAY1), DAY1, "autonomous", 0, "sigA");
    const next = applyTick(seeded, DAY1, "autonomous"); // no workSig arg
    expect(next.noop).toEqual({ workSig: "sigA", ranStreak: 1 }); // preserved as-is
  });

  it("5.5 — rate limit: within cap until the hourly count hits maxPerHour, then over; a new hour resets", () => {
    const HOUR = 60 * 60 * 1000;
    let s = emptyOrchestratorState(DAY1);
    expect(rateWithinLimit(s, 2, DAY1)).toBe(true); // 0 < 2
    s = applyAction(s, DAY1); // count 1
    expect(rateWithinLimit(s, 2, DAY1)).toBe(true); // 1 < 2
    s = applyAction(s, DAY1); // count 2
    expect(rateWithinLimit(s, 2, DAY1)).toBe(false); // 2 >= 2 → guard degrades auto→ask
    // next hour rolls the bucket over → within limit again
    expect(hourKey(DAY1 + HOUR)).not.toBe(hourKey(DAY1));
    expect(rateWithinLimit(s, 2, DAY1 + HOUR)).toBe(true);
    expect(applyAction(s, DAY1 + HOUR).actions).toEqual({ hourKey: hourKey(DAY1 + HOUR), count: 1 });
  });

  it("5.5 — no cap (undefined/0) disables the limiter (always within)", () => {
    const s = applyAction(applyAction(emptyOrchestratorState(DAY1), DAY1), DAY1); // count 2
    expect(rateWithinLimit(s, undefined, DAY1)).toBe(true);
    expect(rateWithinLimit(s, 0, DAY1)).toBe(true);
  });
});

// ── Wake — o lease do TICK e o custo REAL ────────────────────────────────────────────────────────────────
describe("leaseHeldByTick + applyRunResult", () => {
  const NOW = Date.parse("2026-07-12T10:00:00Z");

  it("o lease do tick bloqueia um segundo run — e EXPIRA (nunca deixa o board preso p/ sempre)", () => {
    const held = applyLease(emptyOrchestratorState(NOW), "tick", NOW, 20 * 60_000);
    expect(leaseHeldByTick(held, NOW)).toBe(true);
    expect(leaseHeldByTick(held, NOW + 21 * 60_000)).toBe(false); // backstop p/ um serviço que caiu no meio
    // um lease de HUMANO não é um run em voo (são donos diferentes — o tick já para pelo leaseHeldByHuman)
    expect(leaseHeldByTick(applyLease(emptyOrchestratorState(NOW), "paired", NOW, 60_000), NOW)).toBe(false);
  });

  it("o run terminou: cobra o custo REAL no budget do dia e solta o lease do tick", () => {
    // o bug: o único caller passava costUSD=0 → costToday nunca crescia → maxCostPerDay era decorativo.
    const running = applyLease(applyTick(emptyOrchestratorState(NOW), NOW, "autonomous"), "tick", NOW, 60_000);
    const done = applyRunResult(running, NOW + 5_000, { costUSD: 0.42, summary: "movi 2 cards", exitCode: 0 });
    expect(done.budget.costToday).toBeCloseTo(0.42);
    expect(done.tickLease ?? null).toBeNull(); // WS-4.1: solta SÓ o tickLease
    expect(done.lastTick?.summary).toBe("movi 2 cards");
    expect(done.lastTick?.outcome).toBe("ran"); // preserva o que o applyTick carimbou
  });

  it("WS-4.1 — applyRunResult solta o tickLease mas PRESERVA um pairedLease vivo (humano segue pareado)", () => {
    const running = applyLease(applyLease(emptyOrchestratorState(NOW), "tick", NOW, 60_000), "paired", NOW, 60_000);
    const done = applyRunResult(running, NOW + 5_000, { costUSD: 0.1, exitCode: 0 });
    expect(done.tickLease ?? null).toBeNull(); // tick run terminou
    expect(leaseHeldByHuman(done, NOW + 5_000)).toBe(true); // o humano continua no comando
  });

  it("custo ausente/inválido não corrompe o budget (saída ilegível ⇒ 0, não NaN)", () => {
    const s = applyRunResult(emptyOrchestratorState(NOW), NOW, { exitCode: 1 });
    expect(s.budget.costToday).toBe(0);
  });

  it("NUNCA solta o lease de um humano pareado (só o do tick)", () => {
    const human = applyLease(emptyOrchestratorState(NOW), "paired", NOW, 60_000);
    expect(leaseHeldByHuman(applyRunResult(human, NOW, { costUSD: 1 }), NOW)).toBe(true); // WS-4.1: pairedLease intocado
  });

  // 2026-07-13 — o spawn morria no arranque (exit 1, $0) e cada morte ENGORDAVA o streak anti-noop, até o guard
  // silenciar os ticks ("minhas últimas tentativas não moveram nada"). A falha ficou escondida atrás de uma
  // mensagem que soava sensata. Um run morto não OLHOU o board — não pode virar evidência de que não há trabalho.
  it("um run que MORREU (exit≠0) zera o streak anti-noop — morte não é 'olhei e não havia nada'", () => {
    const ran = applyTick(emptyOrchestratorState(NOW), NOW, "autonomous", 0, "sig-A");
    expect(ran.noop?.ranStreak).toBe(1);
    const died = applyRunResult(ran, NOW + 1_000, { exitCode: 1 });
    expect(died.noop?.ranStreak).toBe(0); // o próximo tick TENTA de novo em vez de se calar
    expect(died.noop?.workSig).toBe("sig-A"); // ...sem perder a assinatura (o board não mudou)
  });

  it("um run que VIVEU e não moveu nada preserva o streak (o back-off legítimo continua valendo)", () => {
    const ran = applyTick(emptyOrchestratorState(NOW), NOW, "autonomous", 0, "sig-A");
    const ok = applyRunResult(ran, NOW + 1_000, { exitCode: 0, costUSD: 0.1 });
    expect(ok.noop?.ranStreak).toBe(1);
  });
});

// ── Incidente 2026-07-13: 19 spawns natimortos (exit 1, $0) comeram os 20 ticks do dia, e o Jido passou a
// responder "parei por budget" — verdadeiro no contador, FALSO na causa. A mentira é o que garantiu que
// ninguém investigasse. Duas peças, que só funcionam JUNTAS: o ESTORNO da reserva (um run que nunca olhou o
// board não é consumo) e o BREAKER (sem ele, o estorno viraria convite a crash-loop infinito).
describe("orchestrator-state — spawn abortivo: estorno + circuit breaker", () => {
  const NOW = Date.parse("2026-07-13T09:00:00Z"); // o dia do incidente
  const spawnAndDie = (s: OrchestratorState, at: number, failure = "exit 1 no arranque") =>
    applyRunResult(applyTick(s, at, "autonomous", 0, "sig-A"), at + 1_000, { exitCode: 1, costUSD: 0, failure });

  it("isAbortiveRun separa 'nunca nasceu' de 'rodou, custou e falhou' — só o 1o é defeito", () => {
    expect(isAbortiveRun({ exitCode: 1, costUSD: 0 })).toBe(true); // morreu no arranque
    expect(isAbortiveRun({ exitCode: 1, costUSD: 2.36 })).toBe(false); // rodou de verdade e falhou no meio
    expect(isAbortiveRun({ exitCode: 0, costUSD: 0 })).toBe(false); // sucesso sem custo reportado
  });

  it("ESTORNA o tick de um run abortivo — o budget do dia não é consumido por um defeito", () => {
    const after = spawnAndDie(emptyOrchestratorState(NOW), NOW);
    expect(after.budget.ticksToday).toBe(0); // reservado no applyTick, estornado aqui
    expect(after.failures?.streak).toBe(1);
  });

  it("um run que EXECUTOU consome o tick normalmente (o estorno não é um buraco no budget)", () => {
    const ran = applyTick(emptyOrchestratorState(NOW), NOW, "autonomous", 0, "sig-A");
    const done = applyRunResult(ran, NOW + 1_000, { exitCode: 0, costUSD: 2.36 });
    expect(done.budget.ticksToday).toBe(1);
    expect(done.budget.costToday).toBeCloseTo(2.36);
  });

  it("um run que rodou, CUSTOU e falhou no meio é cobrado e NÃO abre o breaker (o spawn funciona)", () => {
    const ran = applyTick(emptyOrchestratorState(NOW), NOW, "autonomous", 0, "sig-A");
    const done = applyRunResult(ran, NOW + 1_000, { exitCode: 1, costUSD: 1.5 });
    expect(done.budget.ticksToday).toBe(1); // sem estorno: consumiu recurso de verdade
    expect(done.failures?.streak ?? 0).toBe(0); // não é um defeito de arranque
  });

  it("O DIA REAL: 19 spawns natimortos NÃO esgotam os 20 ticks — e o breaker trava bem antes", () => {
    let s = emptyOrchestratorState(NOW);
    for (let i = 0; i < 19; i++) s = spawnAndDie(s, NOW + i * 60_000);
    expect(s.budget.ticksToday).toBe(0); // ANTES: 19. O board chegava ao fim do dia sem budget nenhum.
    expect(s.failures?.streak).toBe(19);
    expect(spawnBreakerOpen(s, NOW + 19 * 60_000)).toBe(true); // e nem teria chegado a 19 — trava em 3
  });

  it("o breaker abre em SPAWN_BREAKER_THRESHOLD e não antes", () => {
    let s = emptyOrchestratorState(NOW);
    for (let i = 0; i < SPAWN_BREAKER_THRESHOLD - 1; i++) s = spawnAndDie(s, NOW + i * 1_000);
    expect(spawnBreakerOpen(s, NOW)).toBe(false);
    s = spawnAndDie(s, NOW + SPAWN_BREAKER_THRESHOLD * 1_000);
    expect(spawnBreakerOpen(s, NOW + SPAWN_BREAKER_THRESHOLD * 1_000)).toBe(true);
  });

  it("MEIA-ABERTURA: passado o cooldown o breaker libera uma sonda — e o cooldown DOBRA a cada morte", () => {
    let s = emptyOrchestratorState(NOW);
    for (let i = 0; i < SPAWN_BREAKER_THRESHOLD; i++) s = spawnAndDie(s, NOW + i * 1_000);
    const trippedAt = new Date(s.failures!.lastAt).getTime();
    expect(spawnBreakerOpen(s, trippedAt + SPAWN_BREAKER_BASE_COOLDOWN_MS - 1)).toBe(true); // ainda travado
    expect(spawnBreakerOpen(s, trippedAt + SPAWN_BREAKER_BASE_COOLDOWN_MS + 1)).toBe(false); // sonda liberada

    // a sonda também morre → streak cresce e o cooldown dobra (30min → 60min)
    const s2 = spawnAndDie(s, trippedAt + SPAWN_BREAKER_BASE_COOLDOWN_MS + 2);
    const at2 = new Date(s2.failures!.lastAt).getTime();
    expect(spawnBreakerOpen(s2, at2 + SPAWN_BREAKER_BASE_COOLDOWN_MS + 1)).toBe(true); // 30min já não basta
    expect(spawnBreakerOpen(s2, at2 + 2 * SPAWN_BREAKER_BASE_COOLDOWN_MS + 1)).toBe(false);
  });

  it("AUTO-CURA: o primeiro ciclo que SOBREVIVE zera o streak e fecha o breaker", () => {
    let s = emptyOrchestratorState(NOW);
    for (let i = 0; i < 5; i++) s = spawnAndDie(s, NOW + i * 1_000);
    expect(spawnBreakerOpen(s, NOW + 5_000)).toBe(true);

    const revived = applyRunResult(applyTick(s, NOW + 6_000, "autonomous", 0, "sig-A"), NOW + 7_000, {
      exitCode: 0,
      costUSD: 1.2,
    });
    expect(revived.failures?.streak).toBe(0);
    expect(spawnBreakerOpen(revived, NOW + 7_000)).toBe(false); // corrigiu a causa → destravou sozinho
  });

  it("o cooldown tem TETO (não cresce para sempre até o board morrer)", () => {
    let s = emptyOrchestratorState(NOW);
    for (let i = 0; i < 40; i++) s = spawnAndDie(s, NOW + i * 1_000);
    const at = new Date(s.failures!.lastAt).getTime();
    expect(spawnBreakerOpen(s, at + SPAWN_BREAKER_MAX_COOLDOWN_MS + 1)).toBe(false);
  });

  it("o estorno nunca leva o contador a NEGATIVO (estado corrompido / restart no meio do run)", () => {
    const orphan = applyRunResult(emptyOrchestratorState(NOW), NOW, { exitCode: 1, costUSD: 0 });
    expect(orphan.budget.ticksToday).toBe(0);
  });

  it("`failures` sobrevive ao round-trip do estado (o footgun do whitelist de readOrchestratorState)", async () => {
    // Um campo NOVO não whitelistado em readOrchestratorState é descartado a cada leitura — e o breaker
    // nunca abriria. Provado pela porta da frente: escreve e relê.
    const board = `probe-${Math.floor(NOW % 100000)}`;
    let s = emptyOrchestratorState(NOW);
    for (let i = 0; i < SPAWN_BREAKER_THRESHOLD; i++) s = spawnAndDie(s, NOW + i * 1_000);
    await writeOrchestratorState(board, s);
    const back = await readOrchestratorState(board, NOW);
    expect(back.failures?.streak).toBe(SPAWN_BREAKER_THRESHOLD);
  });
});

// autonomy-endgame WS-4.2 — o streak deixou de ser um número e passou a carregar a DOUTRINA sob a qual foi
// tomado (uma desistência sob regra revogada é resíduo, não decisão). `sk` mantém estes testes legíveis: eles
// falam de CONTAGEM, e a doutrina corrente é o pano de fundo. A coerção do formato LEGADO (`number` ⇒
// `doctrine: "pre"`) é testada no seu próprio bloco, na fronteira de LEITURA — que é onde ela acontece.
const sk = (streak: number, doctrine: string = AUTONOMO_DOCTRINE_VERSION) => ({ streak, doctrine });

describe("WS-5.4 — per-item anti-noop streak (noopByItem)", () => {
  const NOW = Date.parse("2026-07-15T12:00:00Z");
  const empty = () => emptyOrchestratorState(NOW);

  it("bumpNoopByItem grows the streak of each still-actionable item (+1 per spawn)", () => {
    let s = empty();
    s = bumpNoopByItem(s, ["a", "b"]);
    expect(s.noopByItem).toEqual({ a: sk(1), b: sk(1) });
    s = bumpNoopByItem(s, ["a", "b"]);
    expect(s.noopByItem).toEqual({ a: sk(2), b: sk(2) });
  });

  it("an item that DISAPPEARS from the actionable set is pruned (its streak resets)", () => {
    let s = bumpNoopByItem(empty(), ["a", "b"]); // {a:1, b:1}
    s = bumpNoopByItem(s, ["a"]); // b progressed/resolved → dropped; a persists
    expect(s.noopByItem).toEqual({ a: sk(2) });
    // b re-appears later → starts fresh at 1 (its streak reset when it left)
    s = bumpNoopByItem(s, ["a", "b"]);
    expect(s.noopByItem).toEqual({ a: sk(3), b: sk(1) });
  });

  it("a spawn with NO actionable ids drops the whole map (everything resolved)", () => {
    const s = bumpNoopByItem(bumpNoopByItem(empty(), ["a"]), []);
    expect(s.noopByItem).toBeUndefined();
  });

  it("itemsInNoopBackoff returns exactly the ids at/over the threshold (default = PER_ITEM_NOOP_MAX)", () => {
    let s = empty();
    s = bumpNoopByItem(s, ["a", "b"]); // 1,1
    expect(itemsInNoopBackoff(s)).toEqual(new Set()); // none reached PER_ITEM_NOOP_MAX (2) yet
    s = bumpNoopByItem(s, ["a", "b"]); // 2,2
    expect(itemsInNoopBackoff(s)).toEqual(new Set(["a", "b"]));
    expect(PER_ITEM_NOOP_MAX).toBe(2);
  });

  it("noopByItem survives the read/write round-trip (whitelist footgun)", async () => {
    const board = `probe-item-${Math.floor(NOW % 100000)}`;
    const s = bumpNoopByItem(bumpNoopByItem(empty(), ["x:stuck:exit"]), ["x:stuck:exit"]); // {…: 2}
    await writeOrchestratorState(board, s);
    const back = await readOrchestratorState(board, NOW);
    expect(back.noopByItem).toEqual({ "x:stuck:exit": sk(2) });
  });
});

describe("WS-12.1 (D16) — bumpNoopByAttempt: o streak cresce por TENTATIVA, não por presença", () => {
  const NOW = Date.parse("2026-07-16T15:00:00Z");
  const empty = () => emptyOrchestratorState(NOW);
  const attempt = (cards: string[]) => ({ anyMutation: cards.length > 0, attemptedCardIds: new Set(cards) });

  // O estado VIVO de 2026-07-16 (storymap/.runner/orchestrator/acme.json), a fixture da colisão #7.
  const ITEMS = [
    { id: "story-eqpdtz:approval", cardId: "story-eqpdtz" },
    { id: "story-eqpdtz:deploy-failed", cardId: "story-eqpdtz" },
    { id: "story-qb8z2c:approval", cardId: "story-qb8z2c" },
    { id: "story-xfleex:approval", cardId: "story-xfleex" },
  ];

  it("o card TENTADO sobe; o card intocado fica IGUAL (presença não é culpa)", () => {
    const s = bumpNoopByAttempt(empty(), ITEMS, attempt(["story-eqpdtz"]));
    expect(s.noopByItem).toEqual({
      "story-eqpdtz:approval": sk(1), // tentado ⇒ +1
      "story-eqpdtz:deploy-failed": sk(1), // mesmo card ⇒ sobe junto (granularidade por CARD, assumida)
      "story-qb8z2c:approval": sk(0),
      "story-xfleex:approval": sk(0), // NUNCA tentado ⇒ intacto
    });
  });

  it("REPLAY da colisão #7: os itens ruidosos queimam a própria cota e o card limpo continua acionável", () => {
    // 2 runs seguidos que só tentam eqpdtz/qb8z2c — exatamente os deploy-failures espúrios do dia.
    let s = empty();
    s = bumpNoopByAttempt(s, ITEMS, attempt(["story-eqpdtz", "story-qb8z2c"]));
    s = bumpNoopByAttempt(s, ITEMS, attempt(["story-eqpdtz", "story-qb8z2c"]));
    const backoff = itemsInNoopBackoff(s);
    // os ruidosos saem sozinhos (viraram do humano)…
    expect(backoff).toEqual(new Set(["story-eqpdtz:approval", "story-eqpdtz:deploy-failed", "story-qb8z2c:approval"]));
    // …e o card LIMPO, que o Jido nunca tentou, segue acionável ⇒ o tick spawna ⇒ chega ao playbook 8.3.
    expect(backoff.has("story-xfleex:approval")).toBe(false);
    expect(s.noopByItem?.["story-xfleex:approval"]).toEqual(sk(0));
  });

  it("REPLAY do incidente 2026-07-15: run que olha e não muta NADA ⇒ bump GERAL (o no-op segue pego)", () => {
    let s = empty();
    s = bumpNoopByAttempt(s, ITEMS, { anyMutation: false, attemptedCardIds: new Set() });
    expect(s.noopByItem).toEqual({
      "story-eqpdtz:approval": sk(1),
      "story-eqpdtz:deploy-failed": sk(1),
      "story-qb8z2c:approval": sk(1),
      "story-xfleex:approval": sk(1),
    });
    s = bumpNoopByAttempt(s, ITEMS, { anyMutation: false, attemptedCardIds: new Set() });
    expect(itemsInNoopBackoff(s).size).toBe(ITEMS.length); // 2 no-ops ⇒ o loop "olha e não faz nada" fecha
  });

  it("um item que SAIU do set é podado, tenha sido tentado ou não (reset-por-progresso intacto)", () => {
    let s = bumpNoopByAttempt(empty(), ITEMS, attempt(["story-eqpdtz"]));
    s = bumpNoopByAttempt(s, [{ id: "story-xfleex:approval", cardId: "story-xfleex" }], attempt(["story-qb8z2c"]));
    expect(s.noopByItem).toEqual({ "story-xfleex:approval": sk(0) });
  });

  it("sem item acionável nenhum, o mapa inteiro cai (tudo resolvido)", () => {
    const s = bumpNoopByAttempt(bumpNoopByAttempt(empty(), ITEMS, attempt(["story-eqpdtz"])), [], attempt([]));
    expect(s.noopByItem).toBeUndefined();
  });

  it("a mutação que NÃO é atribuível a card (sem cardId) não pune ninguém — nem o bump geral roda", () => {
    const s = bumpNoopByAttempt(empty(), ITEMS, { anyMutation: true, attemptedCardIds: new Set() });
    expect(Object.values(s.noopByItem ?? {}).map((e) => e.streak)).toEqual([0, 0, 0, 0]);
  });
});

describe("WS-12.3 (D16) — clearNoopItem: o re-arm zera UM item", () => {
  const NOW = Date.parse("2026-07-16T15:00:00Z");

  it("o item re-armado sai do backoff e volta a ser acionável; os outros ficam", () => {
    const s = { ...emptyOrchestratorState(NOW), noopByItem: { "a:approval": sk(4), "b:approval": sk(2) } };
    const after = clearNoopItem(s, "a:approval");
    expect(after.noopByItem).toEqual({ "b:approval": sk(2) });
    expect(itemsInNoopBackoff(after).has("a:approval")).toBe(false);
  });

  it("re-armar o ÚLTIMO item derruba o mapa; um id inexistente é no-op (idempotente)", () => {
    const s = { ...emptyOrchestratorState(NOW), noopByItem: { "a:approval": sk(4) } };
    expect(clearNoopItem(s, "a:approval").noopByItem).toBeUndefined();
    expect(clearNoopItem(s, "nao-existe")).toBe(s);
    expect(clearNoopItem(emptyOrchestratorState(NOW), "a:approval").noopByItem).toBeUndefined();
  });

  it("o re-arm sobrevive ao round-trip de IO (o próximo tick lê o item já armado)", async () => {
    const board = `probe-rearm-${Math.floor(NOW % 100000)}`;
    await writeOrchestratorState(board, { ...emptyOrchestratorState(NOW), noopByItem: { "a:approval": sk(4), "b:approval": sk(2) } });
    const s = await readOrchestratorState(board, NOW);
    await writeOrchestratorState(board, clearNoopItem(s, "a:approval"));
    expect((await readOrchestratorState(board, NOW)).noopByItem).toEqual({ "b:approval": sk(2) });
  });
});

// autonomy-endgame WS-4 — A DESISTÊNCIA CADUCA QUANDO A RAZÃO DELA É REVOGADA.
//
// O backoff tinha 3 saídas (noop-rearm.ts) e nenhuma cobria o que aconteceu: a REGRA mudou. O tick deferiu
// perguntas sob a doutrina velha; a nova (AUTONOMO_RESOLUTION) shipou; os itens deferidos continuaram presos —
// e a régua escrita EXATAMENTE para decidi-los nunca seria lida contra eles, porque não estavam mais no set.
// O fix não alcançava as vítimas do bug que ele conserta.
describe("WS-4 — o backoff expira quando a DOUTRINA que o causou é revogada", () => {
  const NOW = Date.parse("2026-07-17T12:00:00Z");
  const empty = () => emptyOrchestratorState(NOW);

  it("RESGATE do acme.json vivo: estado legado `{id: 2}` ⇒ lido como doctrine 'pre' ⇒ NÃO está em backoff", async () => {
    // A foto real de 2026-07-17: board autonomous, lastTick "skipped-no-work", US$ 27,16 em 7 ticks, e um
    // item no cap. Escrito no formato LEGADO (number), como o serviço o deixou.
    const board = `probe-ws4-legacy-${Math.floor(NOW % 100000)}`;
    const ITEM = "story-novo-item:b:style-1-ee43c019";
    await writeOrchestratorState(board, {
      ...emptyOrchestratorState(NOW),
      noopByItem: { [ITEM]: 2 } as never, // o shape LEGADO, exatamente como está em disco
    });

    const back = await readOrchestratorState(board, NOW);
    // A coerção acontece na LEITURA — o número vira um streak sob a doutrina "pre"…
    expect(back.noopByItem?.[ITEM]).toEqual({ streak: 2, doctrine: "pre" });
    // …e "pre" nunca é a doutrina viva ⇒ o item VOLTA ao acionável, sozinho, no primeiro tick pós-deploy.
    // A MIGRAÇÃO É O RESGATE: nenhum script, nenhum clique do Operador.
    expect(itemsInNoopBackoff(back).has(ITEM)).toBe(false);
  });

  it("bump sob doutrina NOVA re-arma UMA vez: 2 tentativas a mais, e aí fica em backoff DE NOVO (não oscila)", () => {
    const ITEM = "story-x:approval";
    // Item em backoff sob a doutrina velha.
    let s: OrchestratorState = { ...empty(), noopByItem: { [ITEM]: { streak: 2, doctrine: "v-antiga" } } };
    expect(itemsInNoopBackoff(s).has(ITEM)).toBe(false); // re-armado

    // Duas tentativas sem progresso sob a doutrina NOVA…
    const items = [{ id: ITEM, cardId: "story-x" }];
    const tried = { anyMutation: true, attemptedCardIds: new Set(["story-x"]) };
    s = bumpNoopByAttempt(s, items, tried);
    expect(s.noopByItem?.[ITEM]).toEqual({ streak: 1, doctrine: AUTONOMO_DOCTRINE_VERSION }); // recomeça do zero
    expect(itemsInNoopBackoff(s).has(ITEM)).toBe(false);
    s = bumpNoopByAttempt(s, items, tried);

    // …e ele volta ao backoff, e FICA. O cap não foi afrouxado — foi RE-EMITIDO.
    expect(itemsInNoopBackoff(s).has(ITEM)).toBe(true);
    s = bumpNoopByAttempt(s, items, tried);
    expect(itemsInNoopBackoff(s).has(ITEM)).toBe(true); // não oscila
  });

  it("doutrina ESTÁVEL não re-arma nada: N ticks, o item continua em backoff (o laço de 07-15 NÃO volta)", () => {
    const ITEM = "story-y:approval";
    const items = [{ id: ITEM, cardId: "story-y" }];
    const tried = { anyMutation: true, attemptedCardIds: new Set(["story-y"]) };
    let s: OrchestratorState = empty();
    for (let i = 0; i < 10; i++) s = bumpNoopByAttempt(s, items, tried);
    // Com a doutrina fixa, o comportamento é EXATAMENTE o de hoje: 2 tentativas e pronto, para sempre.
    expect(itemsInNoopBackoff(s).has(ITEM)).toBe(true);
    expect(s.noopByItem?.[ITEM]?.streak).toBe(10);
  });

  it("a versão é LITERAL — não deriva de sha/deploy/data (a armadilha que anularia o WS inteiro)", () => {
    // Derivar a versão de build a transformaria em "todo deploy re-arma tudo" — que é a proposta que
    // noop-rearm.ts JÁ recusou (o board deploya o dia inteiro ⇒ o streak nunca chegaria a 2 ⇒ o laço de
    // 2026-07-15 volta), só que com aparência de rigor. Um literal não tem como variar com o build.
    // pin sincronizado com o valor vigente (tier.ts) — o 2º pin desta constante, ao lado do digest guard em
    // tier.test.ts; o bump de 2026-07-21 (steward-stage-divergente: playbooks de stage↔main divergente +
    // done-que-mente mudam o que o tick FAZ diante de entrega travada) atualizou os dois pins juntos.
    //
    // 2026-08-27.renomeacao-harness — bump de RENOMEAÇÃO: as skills `usm-*` viraram `harness-*` e a
    // doutrina as CITA pelo nome, então os bytes mudaram sem que nenhuma regra de comportamento
    // mudasse. ⚠️ O EFEITO COLATERAL É REAL e está no contrato: bumpar a versão RE-ARMA os itens que
    // o tick havia deferido sob a doutrina anterior. Aqui isso é desperdício, não perigo — o tick
    // re-avalia e defere de novo — mas quem ler um pico de re-avaliação no dia da renomeação deve
    // achar a explicação aqui, e não concluir que a doutrina mudou de opinião.
    expect(AUTONOMO_DOCTRINE_VERSION).toBe("2026-08-27.renomeacao-harness");
    expect(AUTONOMO_DOCTRINE_VERSION).not.toMatch(/[0-9a-f]{7,40}/); // não é sha
    expect(AUTONOMO_DOCTRINE_VERSION).toBe(AUTONOMO_DOCTRINE_VERSION); // estável no processo
  });

  it("entrada corrompida ⇒ o item simplesmente não tem streak (fail-open: fica acionável, nunca preso por lixo)", () => {
    expect(coerceNoopStreak("lixo")).toBeNull();
    expect(coerceNoopStreak({ streak: "dois" })).toBeNull();
    expect(coerceNoopStreak(null)).toBeNull();
    expect(coerceNoopByItem({ a: 3, b: "lixo", c: { streak: 1, doctrine: "v1" } })).toEqual({
      a: { streak: 3, doctrine: "pre" }, // legado coage
      c: { streak: 1, doctrine: "v1" }, // shape novo passa
    }); // `b` some — uma entrada em que não confio é uma entrada que não tenho
  });

  it("as saídas 1 e 2 seguem intactas: progresso poda, e o clearNoopItem humano continua re-armando", () => {
    const items = [{ id: "a:approval", cardId: "a" }];
    let s = bumpNoopByAttempt(empty(), items, { anyMutation: true, attemptedCardIds: new Set(["a"]) });
    // saída 1 — o item sai do set ⇒ podado no rebuild-from-set
    s = bumpNoopByAttempt(s, [], { anyMutation: true, attemptedCardIds: new Set() });
    expect(s.noopByItem).toBeUndefined();
    // saída 2 — o humano re-arma sem justificar nada
    const inBackoff = { ...empty(), noopByItem: { "a:approval": { streak: 9, doctrine: AUTONOMO_DOCTRINE_VERSION } } };
    expect(clearNoopItem(inBackoff, "a:approval").noopByItem).toBeUndefined();
  });
});

// deploy-recovered — A MEMÓRIA DO ITEM. O detector de borda de 8.4 lê dois campos novos, e as três operações
// abaixo são o que os mantém vivos. Sem elas o produtor inteiro é decorativo: o bump RECONSTRÓI o mapa (`const
// next = {}`) em dois call-sites, `clearNoopItem` apaga a entrada, e `readOrchestratorState` descarta todo
// campo não-whitelistado — três aniquiladores independentes de qualquer campo novo.
describe("deploy-recovered — a memória por item (baseline + teto) sobrevive ao bump, ao re-arm e ao IO", () => {
  const NOW = Date.parse("2026-07-18T12:00:00Z");
  const empty = () => emptyOrchestratorState(NOW);
  const ITEM = "story-1:approval:release";
  const items = [{ id: ITEM, cardId: "story-1" }];
  const tried = { anyMutation: true, attemptedCardIds: new Set(["story-1"]) };

  it("bump PRESERVA observed/rearmedByStewardAt sob a MESMA doutrina", () => {
    const s: OrchestratorState = {
      ...empty(),
      noopByItem: {
        [ITEM]: { streak: 1, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: false }, rearmedByStewardAt: "2026-07-18T10:00:00Z" },
      },
    };
    const after = bumpNoopByAttempt(s, items, tried);
    expect(after.noopByItem?.[ITEM]).toEqual({
      streak: 2,
      doctrine: AUTONOMO_DOCTRINE_VERSION,
      observed: { deployProven: false },
      rearmedByStewardAt: "2026-07-18T10:00:00Z",
    });
    // …e também no outro call-site (bump-all, o no-op verdadeiro), que reconstrói o mapa do mesmo jeito.
    expect(bumpNoopByItem(s, [ITEM]).noopByItem?.[ITEM]?.observed).toEqual({ deployProven: false });
  });

  it("…e os DESCARTA quando a doutrina muda — o teto é RE-EMITIDO junto com as tentativas", () => {
    const s: OrchestratorState = {
      ...empty(),
      noopByItem: {
        [ITEM]: { streak: 2, doctrine: "v-antiga", observed: { deployProven: true }, rearmedByStewardAt: "2026-07-17T10:00:00Z" },
      },
    };
    // Uma quota re-emitida carregando o carimbo "já re-armei" não seria re-emissão nenhuma.
    expect(bumpNoopByAttempt(s, items, tried).noopByItem?.[ITEM]).toEqual({ streak: 1, doctrine: AUTONOMO_DOCTRINE_VERSION });
  });

  it("markStewardRearm zera o streak e CARIMBA — a entrada NÃO é apagada e o item sai do backoff", () => {
    const s: OrchestratorState = {
      ...empty(),
      noopByItem: { [ITEM]: { streak: 4, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: false } } },
    };
    const after = markStewardRearm(s, ITEM, "2026-07-18T12:00:00Z");
    expect(after.noopByItem?.[ITEM]).toEqual({
      streak: 0,
      doctrine: AUTONOMO_DOCTRINE_VERSION,
      observed: { deployProven: false }, // a baseline sobrevive ao próprio re-arm
      rearmedByStewardAt: "2026-07-18T12:00:00Z",
    });
    expect(itemsInNoopBackoff(after).has(ITEM)).toBe(false);
    // O TETO é a razão de não apagar: apagar levaria junto a prova de que o re-arm aconteceu.
    expect(after.noopByItem?.[ITEM]?.rearmedByStewardAt).toBeTruthy();
  });

  it("markObservedFact grava a baseline sem tocar no streak (observar não é agir)", () => {
    const s: OrchestratorState = { ...empty(), noopByItem: { [ITEM]: { streak: 2, doctrine: AUTONOMO_DOCTRINE_VERSION } } };
    const after = markObservedFact(s, ITEM, false);
    expect(after.noopByItem?.[ITEM]).toEqual({ streak: 2, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: false } });
    expect(itemsInNoopBackoff(after).has(ITEM)).toBe(true); // continua tão preso quanto estava
    // Item sem entrada ganha uma em streak 0 — registrar um fato jamais inventa uma desistência.
    expect(markObservedFact(empty(), ITEM, true).noopByItem?.[ITEM]).toEqual(
      { streak: 0, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: true } },
    );
  });

  it("clearNoopItem (caminho HUMANO) continua apagando a entrada inteira — inclusive o teto", () => {
    // As duas saídas são diferentes DE PROPÓSITO: o humano não deve satisfação à máquina, e esquecer é o
    // ponto. É a máquina que precisa lembrar que já gastou o seu re-arm.
    const s: OrchestratorState = {
      ...empty(),
      noopByItem: { [ITEM]: { streak: 4, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: false }, rearmedByStewardAt: "2026-07-18T10:00:00Z" } },
    };
    expect(clearNoopItem(s, ITEM).noopByItem).toBeUndefined();
  });

  it("coerceNoopStreak faz round-trip dos campos novos e tolera o legado (number e {streak,doctrine})", () => {
    const full = { streak: 2, doctrine: "v1", observed: { deployProven: false }, rearmedByStewardAt: "2026-07-18T10:00:00Z" };
    expect(coerceNoopStreak(full)).toEqual(full);
    // Legado segue coagindo exatamente como antes (os campos novos são opcionais, não obrigatórios).
    expect(coerceNoopStreak(3)).toEqual({ streak: 3, doctrine: "pre" });
    expect(coerceNoopStreak({ streak: 1, doctrine: "v1" })).toEqual({ streak: 1, doctrine: "v1" });
    // Valor de campo novo corrompido é DESCARTADO, nunca adivinhado: uma baseline ausente é fail-closed
    // (8.4 apenas observa), enquanto uma baseline inventada poderia fabricar uma borda.
    expect(coerceNoopStreak({ streak: 1, doctrine: "v1", observed: { deployProven: "sim" }, rearmedByStewardAt: 42 })).toEqual({
      streak: 1,
      doctrine: "v1",
    });
  });

  it("os campos novos sobrevivem ao round-trip de IO (o footgun do serializer que este arquivo documenta)", async () => {
    const board = `probe-recovery-${Math.floor(NOW % 100000)}`;
    const entry = { streak: 2, doctrine: AUTONOMO_DOCTRINE_VERSION, observed: { deployProven: false }, rearmedByStewardAt: "2026-07-18T10:00:00Z" };
    await writeOrchestratorState(board, { ...empty(), noopByItem: { [ITEM]: entry } });
    expect((await readOrchestratorState(board, NOW)).noopByItem?.[ITEM]).toEqual(entry);
  });
});
