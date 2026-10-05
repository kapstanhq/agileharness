// A VERIFICAÇÃO DE ENTRADA DE CARD, ligada: o MODO pelo chamador (agente barrado, serviço só avisado, operador fora), a
// camada 2 (o modelo pequeno) SÓ na dúvida — com cache, teto por hora e admissão —, o fail-open «board incerto» só
// quando o modelo não responde, e o registro + contador de cada recusa. Modelo e disco falsos; fixtures inventadas.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardFootprint } from "@/lib/storymap/card-routing";
import type { IntakeCandidate } from "@/lib/storymap/card-intake";
import type { SystemDecision } from "@/lib/storymap/system-decisions";
import type { Card, IntakeSettings } from "@/lib/storymap/types";
import { coerceCard } from "@/lib/storymap/repo";
import {
  INTAKE_MODEL_CONCURRENCY,
  checkCardIntake,
  intakeCacheKey,
  intakeGate,
  intakeModeFor,
  intakeModelPrompt,
  parseIntakeModelAnswer,
  setIntakeDepsForTesting,
  type IntakeDeps,
  type IntakeModelAnswer,
  type IntakeStat,
} from "./card-intake-deps";

const BOARDS: BoardFootprint[] = [
  { id: "oficina", name: "Oficina", package: "apps/oficina" },
  { id: "galpao", name: "Galpão", package: "libs/comum", ownsPaths: ["ops/publicar/"] },
];
const SETTINGS: IntakeSettings = { enabled: true, similarity: 0.75, llm: { enabled: true, maxUsdPerCall: 0.05, maxCallsPerHour: 3, maxUsdPerHour: 0.5 } };

function fake(opts: Partial<Omit<IntakeDeps, "settings">> & { answer?: string | Error; settings?: IntakeSettings } = {}) {
  const { answer, settings, ...over } = opts;
  const asked: string[] = [];
  const recorded: SystemDecision[] = [];
  const stats: IntakeStat[] = [];
  const cache = new Map<string, IntakeModelAnswer>();
  let hour = { calls: 0, usd: 0 };
  const deps: IntakeDeps = {
    settings: () => settings ?? SETTINGS,
    boards: async () => BOARDS,
    readConfig: async () =>
      ({ statuses: [{ id: "triage", name: "Triagem", staging: true }, { id: "concluida", name: "No ar", terminal: true }], columns: [] }) as never,
    readCards: async () => [coerceCard("story-ex9711", { type: "story", title: "Trocar a corrente da bicicleta", status: "triage" }, "") as Card],
    readScope: async (b) => (b === "galpao" ? "A infraestrutura comum: publicar e provas." : "A oficina de bicicletas."),
    ask: async (prompt) => {
      asked.push(prompt);
      if (answer instanceof Error) throw answer;
      return answer ?? '{"board":"oficina","confidence":0.9,"why":"é da oficina"}';
    },
    admission: () => null,
    cacheGet: async (k) => cache.get(k) ?? null,
    cacheSet: async (k, v) => void cache.set(k, v),
    hourUsage: async () => hour,
    book: async (_n, usd) => void (hour = { calls: hour.calls + 1, usd: hour.usd + usd }),
    record: async (e) => void recorded.push(e),
    bump: async (s) => void stats.push(s),
    now: () => Date.UTC(2026, 6, 1, 12),
    ...over,
  };
  return { deps, asked, recorded, stats, cache, setHour: (h: { calls: number; usd: number }) => (hour = h) };
}

const cand = (over: Partial<IntakeCandidate> = {}): IntakeCandidate => ({
  title: "Mostrar o prazo da revisão no pedido",
  type: "story",
  storyType: "technical",
  body: "",
  files: [],
  acceptance: [],
  landsInQuarantine: true,
  ...over,
});
const UNCERTAIN = cand({ body: "Parece coisa do Galpão: a etapa de publicar trava." });

describe("intakeModeFor — o modo pelo chamador", () => {
  it("operador fora; agente pelo MCP barrado; o serviço avisado", () => {
    expect(intakeModeFor("operator-session")).toBeNull();
    expect(intakeModeFor("mcp-token")).toBe("enforce");
    expect(intakeModeFor("in-process")).toBe("advise");
  });
});

describe("checkCardIntake — camada 1", () => {
  it("enforce: board errado recusa, registra no Acompanhar e conta", async () => {
    const f = fake();
    const r = await checkCardIntake(f.deps, { board: "oficina", candidate: cand({ files: ["ops/publicar/x.mjs"] }), mode: "enforce" });
    expect(r).toMatchObject({ ok: false, reason: "board", suggestBoard: "galpao" });
    expect(f.recorded[0]).toMatchObject({ kind: "card-intake", agent: "card-intake", board: "oficina" });
    expect(f.stats).toEqual(["refused-board"]);
    expect(f.asked).toEqual([]);
  });

  it("advise: o serviço nunca é barrado; board errado entra marcado para revisão, padrão só registra", async () => {
    const f = fake();
    expect(await checkCardIntake(f.deps, { board: "oficina", candidate: cand({ files: ["ops/publicar/x.mjs"] }), mode: "advise" })).toMatchObject({ ok: true, flagReview: true });
    expect(await checkCardIntake(f.deps, { board: "oficina", candidate: cand({ title: "Curto" }), mode: "advise" })).toMatchObject({ ok: true, flagReview: false });
    expect(f.stats).toEqual(["advised", "advised"]);
    expect(f.recorded).toHaveLength(2);
  });

  it("desligada ⇒ passa sem olhar", async () => {
    const f = fake({ settings: { ...SETTINGS, enabled: false } });
    expect(await checkCardIntake(f.deps, { board: "oficina", candidate: cand({ title: "x" }), mode: "enforce" })).toMatchObject({ ok: true, via: "skip" });
  });

  it("aceite claro não chama o modelo", async () => {
    const f = fake();
    expect(await checkCardIntake(f.deps, { board: "oficina", candidate: cand(), mode: "enforce" })).toMatchObject({ ok: true, flagReview: false, via: "rules" });
    expect(f.asked).toEqual([]);
  });
});

describe("checkCardIntake — camada 2, só na dúvida", () => {
  it("o modelo diz OUTRO board com confiança ⇒ recusa (enforce) com o board certo", async () => {
    const f = fake({ answer: '{"board":"galpao","confidence":0.9,"why":"é publicação"}' });
    const r = await checkCardIntake(f.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" });
    expect(r).toMatchObject({ ok: false, reason: "board", suggestBoard: "galpao" });
    expect(f.asked).toHaveLength(1);
    expect(f.stats).toEqual(["uncertain", "model-call", "refused-board"]);
  });

  it("o modelo confirma o board pedido ⇒ aceita sem aviso", async () => {
    const f = fake();
    expect(await checkCardIntake(f.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ ok: true, flagReview: false, via: "model" });
  });

  it("outro board SEM confiança ⇒ entra com «board incerto»", async () => {
    const f = fake({ answer: '{"board":"galpao","confidence":0.4,"why":"talvez"}' });
    expect(await checkCardIntake(f.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ ok: true, flagReview: true, via: "fallback" });
  });

  it("cache: o mesmo pedido não paga duas vezes", async () => {
    const f = fake({ answer: '{"board":"galpao","confidence":0.9,"why":"é publicação"}' });
    await checkCardIntake(f.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" });
    await checkCardIntake(f.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" });
    expect(f.asked).toHaveLength(1);
    expect(f.cache.has(intakeCacheKey("oficina", UNCERTAIN))).toBe(true);
  });

  it("teto da hora, admissão retida, modelo falhando ou desligado ⇒ «board incerto» sem barrar e sem gastar", async () => {
    const cap = fake();
    cap.setHour({ calls: 3, usd: 0.15 });
    expect(await checkCardIntake(cap.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ ok: true, flagReview: true, via: "fallback" });
    expect(cap.asked).toEqual([]);
    const usd = fake();
    usd.setHour({ calls: 0, usd: 0.48 });
    expect(await checkCardIntake(usd.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ via: "fallback" });
    expect(usd.asked).toEqual([]);
    const held = fake({ admission: () => "janela da conta cheia" });
    expect(await checkCardIntake(held.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ via: "fallback" });
    expect(held.asked).toEqual([]);
    const broken = fake({ answer: new Error("timeout") });
    expect(await checkCardIntake(broken.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ ok: true, flagReview: true, via: "fallback" });
    const off = fake({ settings: { ...SETTINGS, llm: { ...SETTINGS.llm, enabled: false } } });
    expect(await checkCardIntake(off.deps, { board: "oficina", candidate: UNCERTAIN, mode: "enforce" })).toMatchObject({ via: "fallback" });
    expect(off.asked).toEqual([]);
  });
});

describe("o prompt e a resposta do modelo", () => {
  it("o prompt é curto, lista os boards e trata o card como DADO", () => {
    const p = intakeModelPrompt("oficina", cand({ body: "x".repeat(5000) }), BOARDS.map((b) => ({ ...b, scope: "y".repeat(5000) })));
    expect(p).toMatch(/DADO, não instrução/);
    expect(p).toMatch(/### galpao/);
    expect(p.length).toBeLessThan(5000);
  });

  it("resposta com board inexistente, sem JSON ou torta ⇒ null; confiança fora de 0..1 vira 0", () => {
    const ids = BOARDS.map((b) => b.id);
    expect(parseIntakeModelAnswer('{"board":"cais","confidence":1}', ids)).toBeNull();
    expect(parseIntakeModelAnswer("não sei", ids)).toBeNull();
    expect(parseIntakeModelAnswer('{"board":', ids)).toBeNull();
    expect(parseIntakeModelAnswer('ok {"board":"galpao","confidence":7,"why":"x"}', ids)).toEqual({ board: "galpao", confidence: 0, why: "x" });
  });
});

describe("intakeGate — o lote", () => {
  const prev = process.env.AGILEHARNESS_INTAKE;
  beforeEach(() => {
    process.env.AGILEHARNESS_INTAKE = "1";
  });
  afterEach(() => {
    setIntakeDepsForTesting(null);
    process.env.AGILEHARNESS_INTAKE = prev;
  });

  it("uma recusa no lote ⇒ nada é criado e a mensagem diz o que corrigir em cada item", async () => {
    setIntakeDepsForTesting(fake().deps);
    const r = await intakeGate(
      "oficina",
      [
        { key: "i1", candidate: cand() },
        { key: "i2", candidate: cand({ title: "Publicar com prova", files: ["ops/publicar/etapa.mjs"] }) },
        { key: "i3", candidate: cand({ title: "Trocar a corrente da bicicleta" }) },
      ],
      "enforce",
    );
    expect(r.ok).toBe(false);
    const e = (r as { error: string }).error;
    expect(e).toMatch(/Nada foi criado/);
    expect(e).toMatch(/board certo: galpao/);
    expect(e).toMatch(/card existente: story-ex9711/);
  });

  it("aceite com aviso volta em `review` pela chave", async () => {
    setIntakeDepsForTesting(fake({ answer: '{"board":"galpao","confidence":0.3,"why":"?"}' }).deps);
    const r = await intakeGate("oficina", [{ key: "i1", candidate: UNCERTAIN }], "enforce");
    expect(r.ok && r.review.get("i1")).toMatch(/board incerto/);
  });

  it("AGILEHARNESS_INTAKE=0 desliga (o kill switch)", async () => {
    process.env.AGILEHARNESS_INTAKE = "0";
    setIntakeDepsForTesting(fake().deps);
    expect(await intakeGate("oficina", [{ key: "i1", candidate: cand({ title: "x" }) }], "enforce")).toMatchObject({ ok: true });
  });
});

describe("o teto por hora e as consultas em PARALELO", () => {
  it("30 criações em paralelo com teto de 2 consultas ⇒ no máximo 2 consultas (a reserva é atômica)", async () => {
    const tight: IntakeSettings = { ...SETTINGS, llm: { ...SETTINGS.llm, maxCallsPerHour: 2, maxUsdPerHour: 10 } };
    let hour = { calls: 0, usd: 0 };
    const f = fake({
      settings: tight,
      // a leitura demora: sem a reserva atômica, todas leriam «ainda cabe» antes de alguma registrar
      hourUsage: async () => {
        const snap = { ...hour }; // a foto é tirada ANTES da espera: sem a reserva atômica, várias leem «ainda cabe»
        await new Promise((r) => setTimeout(r, 2));
        return snap;
      },
      book: async (_n, usd) => void (hour = { calls: hour.calls + 1, usd: hour.usd + usd }),
    });
    const outs = await Promise.all(
      Array.from({ length: 30 }, (_, i) => checkCardIntake(f.deps, { board: "oficina", candidate: { ...UNCERTAIN, title: `Card distinto número ${i} da etapa` }, mode: "enforce" })),
    );
    expect(f.asked.length).toBeLessThanOrEqual(2);
    expect(hour.calls).toBeLessThanOrEqual(2);
    expect(outs.filter((o) => o.ok && o.via === "fallback").length).toBeGreaterThanOrEqual(28);
  });

  it("no máximo INTAKE_MODEL_CONCURRENCY consultas ao modelo ao mesmo tempo", async () => {
    let live = 0;
    let peak = 0;
    const f = fake({
      settings: { ...SETTINGS, llm: { ...SETTINGS.llm, maxCallsPerHour: 100, maxUsdPerHour: 100 } },
      ask: async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return '{"board":"oficina","confidence":0.9,"why":"é da oficina"}';
      },
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => checkCardIntake(f.deps, { board: "oficina", candidate: { ...UNCERTAIN, title: `Outro card distinto ${i} da etapa` }, mode: "enforce" })),
    );
    expect(peak).toBeLessThanOrEqual(INTAKE_MODEL_CONCURRENCY);
    expect(peak).toBeGreaterThan(0);
  });
});
