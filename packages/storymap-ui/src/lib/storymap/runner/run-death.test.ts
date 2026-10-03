import { describe, expect, it } from "vitest";
import {
  RUN_DEATH_FINDING_ID,
  classifyRunDeath,
  buildRunDeathFinding,
  applyRunDeathFinding,
  applyRunDeathResolved,
  nextRunDeathFinding,
  registerRunDeathFindings,
  restampRunDeathFromEvents,
} from "./run-death";
import { failureOrigin, runDeathRepeats } from "./failure-origin";
import type { Card, Finding } from "@/lib/storymap/types";
import SANDBOX_DENIED from "./__fixtures__/sandbox-denied-finaltexts.json";

// story-ex0068 — a TAXONOMIA DE MORTE conservadora. Toda morte de run deixa um DIAGNÓSTICO durável no
// card (o "resumo da causa" que faltava) + um HINT de classe (infra/test/app) para o operador rotear —
// SEM auto-mover o card (a lição do deploy-revert: auto-rotear congela cards). O modo de morte
// (RunnerFailureReason) já é rico; a CAUSA reusa o classifyFailure(infra|test|app) dormente (4d),
// com um fast-path por reason para os modos que o classificador de mensagem não pega (oom/timeout/error).

describe("classifyRunDeath — reason (+detail) → FailureClass hint", () => {
  it("oom-killed e error são INFRA (recurso/ambiente, não é o código do card)", () => {
    expect(classifyRunDeath("oom-killed")).toBe("infra");
    expect(classifyRunDeath("error")).toBe("infra");
  });

  it("no-op é APP (sucesso-fantasma: a skill alegou pronto sem fazer/avançar)", () => {
    expect(classifyRunDeath("no-op")).toBe("app");
  });

  it("exit reusa o classifyFailure só quando o detail tem sinal REAL de infra/test", () => {
    expect(classifyRunDeath("exit", "Error: Cannot find module 'left-pad-lite'")).toBe("infra");
    expect(classifyRunDeath("exit", "listen EADDRINUSE: address already in use :::3008")).toBe("infra");
    expect(classifyRunDeath("exit", "strict mode violation: getByRole resolved to 3 elements")).toBe("test");
  });

  it("exit sem sinal (só 'exit N') fica UNKNOWN — não inventa 'app' de um código de saída seco", () => {
    expect(classifyRunDeath("exit", "exit 1")).toBeUndefined();
    expect(classifyRunDeath("exit", "morto (SIGKILL)")).toBeUndefined();
    expect(classifyRunDeath("exit")).toBeUndefined();
  });

  it("timeout é ambíguo (processo pendurado) → UNKNOWN, o operador investiga", () => {
    expect(classifyRunDeath("timeout", "sem resposta em 360s")).toBeUndefined();
  });
});

describe("buildRunDeathFinding — diagnóstico durável, high non-blocker, com hint de classe", () => {
  it("é um finding general/high/open idempotente com o modo + detail + failureClass", () => {
    const f = buildRunDeathFinding("oom-killed", "OOM kill no scope — MemoryMax excedido", "infra", "2026-07-08");
    expect(f.id).toBe(RUN_DEATH_FINDING_ID);
    expect(f.lens).toBe("general");
    expect(f.severity).toBe("high"); // operator alert, NÃO blocker (não pode gatear/travar o card)
    expect(f.status).toBe("open");
    expect(f.failureClass).toBe("infra");
    expect(f.title).toMatch(/oom-killed/);
    expect(f.detail).toContain("MemoryMax");
    expect(f.detail).toMatch(/infra/i); // o hint de rota está no texto para o operador
  });

  it("sem failureClass (unknown) NÃO seta o campo e o texto não afirma uma classe", () => {
    const f = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    expect(f.failureClass).toBeUndefined();
    expect(f.detail).toContain("exit 1");
  });
});

const card = (over: Partial<Card> = {}): Card =>
  ({ id: "c1", type: "story", status: "desenvolver", findings: [], ...over }) as Card;

describe("applyRunDeathFinding — carimba SEM mover o card (conservador)", () => {
  it("faz upsert do finding e PRESERVA o status (não auto-move)", () => {
    const f = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    const out = applyRunDeathFinding(card({ status: "desenvolver" }), f);
    expect(out.status).toBe("desenvolver"); // conservador: nada de auto-rotear
    expect(out.findings).toHaveLength(1);
    expect(out.findings![0].id).toBe(RUN_DEATH_FINDING_ID);
  });

  it("é idempotente por id — re-carimbar REFRESCA em vez de empilhar", () => {
    const f1 = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    const f2 = buildRunDeathFinding("timeout", "sem resposta em 360s", undefined, "2026-07-08");
    let out = applyRunDeathFinding(card(), f1);
    out = applyRunDeathFinding(out, f2);
    expect(out.findings).toHaveLength(1);
    expect(out.findings![0].title).toMatch(/timeout/);
  });

  it("preserva outros findings (não-morte) intactos", () => {
    const other: Finding = { id: "loop-guard-c1", lens: "general", severity: "high", title: "x", status: "open" };
    const f = buildRunDeathFinding("exit", "exit 1", undefined, "2026-07-08");
    const out = applyRunDeathFinding(card({ findings: [other] }), f);
    expect(out.findings).toHaveLength(2);
  });
});

describe("applyRunDeathResolved — limpa o diagnóstico quando o card recupera", () => {
  it("flipa o finding de morte open→fixed ao suceder, sem tocar os outros", () => {
    const death: Finding = { id: RUN_DEATH_FINDING_ID, lens: "general", severity: "high", title: "run morreu: exit", status: "open" };
    const other: Finding = { id: "loop-guard-c1", lens: "general", severity: "high", title: "x", status: "open" };
    const out = applyRunDeathResolved(card({ findings: [death, other] }));
    expect(out.findings!.find((f) => f.id === RUN_DEATH_FINDING_ID)!.status).toBe("fixed");
    expect(out.findings!.find((f) => f.id === "loop-guard-c1")!.status).toBe("open");
  });

  it("no-op quando não há finding de morte (retorna o card equivalente)", () => {
    const out = applyRunDeathResolved(card({ findings: [] }));
    expect(out.findings).toHaveLength(0);
  });
});

// Um card (galpao/story-ex9205) morre 3x como `no-op` porque o SANDBOX recusa todo Bash (apply-seccomp/setgroups),
// e o carimbo dizia «Causa provável: APP … reabra em desenvolver/corrigir». O texto final do agente dizia a causa.
describe("a morte cuja origem é a FERRAMENTA (o texto final do agente) ⇒ infra, nunca «APP»", () => {
  const NOOP_DETAIL = "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)";

  it("classifyRunDeath lê o texto final: assinatura de sandbox ⇒ infra mesmo num no-op", () => {
    for (const r of SANDBOX_DENIED) expect(classifyRunDeath("no-op", NOOP_DETAIL, r.finalText)).toBe("infra");
    // sem a assinatura, o no-op segue sendo APP (sucesso-fantasma) — o fast-path de sempre
    expect(classifyRunDeath("no-op", NOOP_DETAIL, "O card já estava enriquecido; nada a fazer.")).toBe("app");
    expect(classifyRunDeath("exit", "Error: spawn claude ENOENT")).toBe("infra");
  });

  it("os 4 runs em sequência: o mesmo diagnóstico, refrescado, contando a repetição", () => {
    let c = card({ status: "enriquecer" });
    for (const [i, r] of SANDBOX_DENIED.entries()) {
      const f = nextRunDeathFinding(c, { reason: "no-op", detail: NOOP_DETAIL, finalText: r.finalText, today: "2026-03-10" });
      c = applyRunDeathFinding(c, f);
      expect(runDeathRepeats(f.title)).toBe(i + 1);
    }
    expect(c.findings).toHaveLength(1);
    const f = c.findings![0];
    expect(f.failureClass).toBe("infra");
    expect(f.title).toBe("run morreu: no-op · falha da ferramenta (sandbox-seccomp) · 4ª vez seguida");
    expect(f.detail).toMatch(/Origem: a FERRAMENTA/);
    expect(f.detail).toMatch(/apply-seccomp/);
    expect(f.detail).not.toMatch(/reabra em desenvolver/);
    // o leitor do Inbox chega à mesma origem só com o que o item carrega (título + detalhe + classe)
    expect(failureOrigin({ text: f.detail, failureClass: f.failureClass }).origin).toBe("tool");
  });

  it("outra morte (motivo diferente) recomeça a contagem; um diagnóstico já resolvido não conta", () => {
    const sandbox = { reason: "no-op" as const, detail: NOOP_DETAIL, finalText: SANDBOX_DENIED[0].finalText, today: "2026-03-10" };
    let c = applyRunDeathFinding(card(), nextRunDeathFinding(card(), sandbox));
    c = applyRunDeathFinding(c, nextRunDeathFinding(c, sandbox));
    expect(runDeathRepeats(c.findings![0].title)).toBe(2);
    const other = nextRunDeathFinding(c, { reason: "exit", detail: "exit 1", today: "2026-03-10" });
    expect(other.title).toBe("run morreu: exit");
    const resolved = applyRunDeathResolved(c);
    expect(runDeathRepeats(nextRunDeathFinding(resolved, sandbox).title)).toBe(1);
  });

  it("o hook entrega o texto final do run ao carimbo", () => {
    const stamped: Array<string | null | undefined> = [];
    let onComplete!: (ev: { board: string; cardId: string; outcome?: string; result?: { finalText?: string } }) => void;
    registerRunDeathFindings(
      { onComplete: (fn) => ((onComplete = fn), () => {}) },
      { onMergeDone: () => () => {} },
      {
        failures: () => [{ board: "acme", cardId: "story-1", reason: "no-op", detail: NOOP_DETAIL }],
        stamp: (_b, _c, _r, _d, finalText) => void stamped.push(finalText),
        clearDeath: () => {},
        clearBudgetCut: () => {},
      },
    );
    onComplete({ board: "acme", cardId: "story-1", outcome: "no-op", result: { finalText: SANDBOX_DENIED[2].finalText } });
    expect(stamped).toEqual([SANDBOX_DENIED[2].finalText]);
  });
});

// O diagnóstico do card foi carimbado ANTES de o carimbo ler o texto final: «run morreu: no-op … Causa provável: APP».
// Sem releitura, ele só mudaria num run novo — que o dono teria de disparar no Inbox. O boot relê pelo log de eventos.
describe("restampRunDeathFromEvents — a releitura dos diagnósticos antigos pelo log de eventos", () => {
  const OLD = buildRunDeathFinding("no-op", "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)", "app", "2026-03-10");
  const ev = (outcome: string, finalText?: string) => ({ board: "galpao", cardId: "story-ex9205", outcome, result: finalText ? { finalText } : undefined });

  it("o caso: 4 no-op do sandbox seguidos ⇒ infra, origem da ferramenta, «4ª vez seguida»", () => {
    const settled = [ev("ok", "pronto"), ...SANDBOX_DENIED.map((r) => ev("no-op", r.finalText))];
    const out = restampRunDeathFromEvents(card({ findings: [OLD] }), settled, "2026-03-11");
    const f = out?.findings?.find((x) => x.id === RUN_DEATH_FINDING_ID);
    expect(f).toMatchObject({ failureClass: "infra", title: "run morreu: no-op · falha da ferramenta (sandbox-seccomp) · 4ª vez seguida" });
  });

  it("nada a reler: já carimbado com a origem, último desfecho sem assinatura, outra morte, ou sem diagnóstico aberto", () => {
    const settled = SANDBOX_DENIED.map((r) => ev("no-op", r.finalText));
    const fresh = restampRunDeathFromEvents(card({ findings: [OLD] }), settled, "2026-03-11")!;
    expect(restampRunDeathFromEvents(fresh, settled, "2026-03-11")).toBeNull();
    expect(restampRunDeathFromEvents(card({ findings: [OLD] }), [...settled, ev("no-op", "nada a fazer")], "2026-03-11")).toBeNull();
    expect(restampRunDeathFromEvents(card({ findings: [buildRunDeathFinding("exit", "exit 1", undefined, "d")] }), settled, "2026-03-11")).toBeNull();
    expect(restampRunDeathFromEvents(card(), settled, "2026-03-11")).toBeNull();
    expect(restampRunDeathFromEvents(card({ findings: [OLD] }), [], "2026-03-11")).toBeNull();
  });
});

// Revisão de um pacote de trabalho: três furos do carimbo, cada um tirava (ou devolvia) uma decisão humana pelo motivo errado.
describe("revisão do pacote — a classe do teto de max-turns, o passo na repetição e a postura sem shell", () => {
  const ENRICH_NOOP = "saída limpa mas o card não avançou de enriquecer — sucesso-fantasma (no-op)";
  const BUILD_NOOP = "saída limpa mas o run não produziu NENHUM artefato de código (só storymap/boards/) — sucesso-fantasma de build (C2/O3.5)";
  // o aviso que autonomy-sandbox.ts escreve para um passo `full` rebaixado neste host (sonda do Bash contido falhando)
  const DOWNGRADED =
    "REBAIXADO full → write: o bubblewrap sobe, mas o Bash do agente não roda dentro dele: o passo de seccomp do CLI cria um user " +
    "namespace aninhado e o kernel o recusa (sh: 1: cannot create /proc/self/setgroups: Permission denied) — tipicamente a restrição " +
    "de userns do AppArmor; o conserto é no host. O run NÃO terá shell; passos que dependem de Bash vão falhar.";

  it("o teto de max-turns que o engine assenta como 'error' NÃO é infra: o card não coube nas voltas, o ambiente não falhou", () => {
    expect(classifyRunDeath("error", "max-turns atingido 3× (teto 3) — card travado, escalando p/ o operador")).toBeUndefined();
    // os outros 'error' seguem infra — e a origem deles é `environment` (failure-origin.ts), que segue o modo do board
    expect(classifyRunDeath("error", "API Error: 529 Overloaded")).toBe("infra");
    const f = nextRunDeathFinding(card(), { reason: "error", detail: "max-turns atingido 3× (teto 3) — card travado, escalando p/ o operador", today: "2026-03-11" });
    expect(f.failureClass).toBeUndefined();
    expect(f.detail).not.toMatch(/INFRA/);
  });

  it("no-op em passos diferentes (o dono moveu o card à mão entre eles) ⇒ a contagem recomeça; no mesmo passo, soma", () => {
    let c = card({ status: "enriquecer" });
    c = applyRunDeathFinding(c, nextRunDeathFinding(c, { reason: "no-op", detail: ENRICH_NOOP, finalText: "o advance falhou", step: "Especificar", today: "2026-03-10" }));
    const moved: Card = { ...c, status: "desenvolver" }; // o dono moveu o card à mão; o diagnóstico seguiu aberto
    const later = nextRunDeathFinding(moved, { reason: "no-op", detail: BUILD_NOOP, finalText: "esqueci de commitar", step: "Desenvolver", today: "2026-10-04" });
    expect(later.title).toBe("run morreu: no-op sem código em «Desenvolver»");
    expect(runDeathRepeats(later.title)).toBe(1);
    // o no-op de avanço e o de build no MESMO passo também são desfechos diferentes
    const advance = nextRunDeathFinding(card(), { reason: "no-op", detail: "saída limpa mas o card não avançou de desenvolver — sucesso-fantasma (no-op)", step: "Desenvolver", today: "2026-10-04" });
    const c2 = applyRunDeathFinding(card(), advance);
    expect(runDeathRepeats(nextRunDeathFinding(c2, { reason: "no-op", detail: BUILD_NOOP, step: "Desenvolver", today: "2026-10-04" }).title)).toBe(1);
    // e o MESMO no-op no MESMO passo soma
    const again = nextRunDeathFinding(c, { reason: "no-op", detail: ENRICH_NOOP, finalText: "de novo", step: "Especificar", today: "2026-03-10" });
    expect(again.title).toBe("run morreu: no-op em «Especificar» · 2ª vez seguida");
  });

  it("o run rodou com a postura REBAIXADA (sem shell): a morte é da FERRAMENTA, mesmo sem o erro do sandbox no texto final", () => {
    const input = { reason: "no-op" as const, detail: ENRICH_NOOP, finalText: "Não tenho Bash aqui, então o advance-card não rodou.", step: "Especificar", today: "2026-03-11" };
    const f = nextRunDeathFinding(card(), { ...input, postureWarn: DOWNGRADED });
    expect(f.failureClass).toBe("infra");
    expect(f.title).toBe("run morreu: no-op em «Especificar» · falha da ferramenta (posture-no-shell)");
    expect(f.detail).toMatch(/sem shell/);
    // o leitor do Inbox chega à origem só com o que o item carrega
    expect(failureOrigin({ text: f.detail, failureClass: f.failureClass }).origin).toBe("tool");
    // não-vácuo: sem o aviso da postura, o mesmo texto final é um no-op de produto
    expect(nextRunDeathFinding(card(), input).failureClass).toBe("app");
  });

  it("o hook entrega ao carimbo o passo (trigger) da falha", () => {
    const stamped: Array<string | null | undefined> = [];
    let onComplete!: (ev: { board: string; cardId: string; trigger?: string; outcome?: string; result?: { finalText?: string } }) => void;
    registerRunDeathFindings(
      { onComplete: (fn) => ((onComplete = fn), () => {}) },
      { onMergeDone: () => () => {} },
      {
        failures: () => [{ board: "acme", cardId: "story-1", trigger: "harness-enrich", reason: "no-op", detail: ENRICH_NOOP }],
        stamp: (_b, _c, _r, _d, _f, trigger) => void stamped.push(trigger),
        clearDeath: () => {},
        clearBudgetCut: () => {},
      },
    );
    onComplete({ board: "acme", cardId: "story-1", trigger: "harness-enrich", outcome: "no-op" });
    expect(stamped).toEqual(["harness-enrich"]);
  });
});
