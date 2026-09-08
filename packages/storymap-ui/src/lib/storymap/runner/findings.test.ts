import { describe, it, expect } from "vitest";
import {
  cardBudgetFindingId,
  codeNotLandedFindingId,
  gateBlockerFindingId,
  loopGuardFindingId,
  mergeBackFailureFindingId,
  parseFindingBatch,
  upsertFindingIfChanged,
  withCardBudgetFinding,
  withCodeNotLandedFinding,
  withDataNotLandedFinding,
  dataNotLandedFindingId,
  withGateBlockerFinding,
  withLoopGuardFinding,
  withMergeBackFailureFinding,
  withPendingEffectFailureFinding,
  pendingEffectFailureFindingId,
  reviewFindingId,
  isMechanismBlockerId,
  liveOpenBlockers,
  secretScanBlockerFindingId,
  supersedeStaleTerminalBlockers,
  withSecretScanBlockerFinding,
  withRunBlockersResolved,
} from "@/lib/storymap/runner/findings";
import type { Finding } from "@/lib/storymap/types";

// Harness #2 — the COOPERATIVE strict validation of a harness-review lens sub-agent's `finding-batch`.
// `parseFindingBatch` is the canonical reference for the authorable Finding shape ({ lens, severity,
// title, detail?, file?, line?, suggestion? } — NO id/status). It fails CLOSED: ok=true only when the
// input parses AND every item validates. This is the STRICT author path — NOT repo.ts's tolerant
// coerceFindings (which is the lenient general read path and is intentionally NOT exercised here).

describe("parseFindingBatch", () => {
  const validItem = {
    lens: "security" as const,
    severity: "blocker" as const,
    title: "Regra de Firestore permite leitura ampla",
    detail: "A coleção users/ está aberta para qualquer auth != null.",
    file: "firestore.rules",
    line: 42,
    suggestion: "Restringir a request.auth.uid == userId.",
  };

  it("accepts a valid batch (array) → ok:true, items populated", () => {
    const r = parseFindingBatch([validItem, { lens: "perf", severity: "low", title: "re-render evitável" }]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].title).toBe("Regra de Firestore permite leitura ampla");
    expect(r.items[1].lens).toBe("perf");
  });

  it("accepts a valid JSON STRING (a fenced finding-batch block)", () => {
    const r = parseFindingBatch(JSON.stringify([validItem]));
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].severity).toBe("blocker");
  });

  it("accepts an item with only the required fields (optionals omitted)", () => {
    const r = parseFindingBatch([{ lens: "general", severity: "medium", title: "código morto" }]);
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].detail).toBeUndefined();
  });

  it("rejects (ok:false) an invalid lens", () => {
    const r = parseFindingBatch([{ lens: "frontend", severity: "low", title: "x" }]);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.errors[0]).toMatch(/item\[0\]/);
  });

  it("rejects (ok:false) an invalid severity", () => {
    const r = parseFindingBatch([{ lens: "testing", severity: "critical", title: "x" }]);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
  });

  it("rejects (ok:false) an empty title", () => {
    const r = parseFindingBatch([{ lens: "testing", severity: "low", title: "" }]);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
  });

  it("rejects (ok:false) a missing title", () => {
    const r = parseFindingBatch([{ lens: "testing", severity: "low" }]);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
  });

  it("rejects (ok:false) an extra/unknown key (strict)", () => {
    const r = parseFindingBatch([{ ...validItem, status: "open" }]);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.errors[0]).toMatch(/item\[0\]/);
  });

  it("rejects (ok:false) a malformed JSON string", () => {
    const r = parseFindingBatch("[{ not json");
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.errors[0]).toMatch(/JSON inválido/);
  });

  it("rejects (ok:false) a non-array payload", () => {
    const r = parseFindingBatch({ lens: "general", severity: "low", title: "x" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/ARRAY/);
  });

  it("fails CLOSED: one invalid item among valid ones → ok:false (keeps only the valid items)", () => {
    const r = parseFindingBatch([
      validItem,
      { lens: "nope", severity: "low", title: "ruim" },
      { lens: "nextjs", severity: "high", title: "ok" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(2); // the two valid ones survive in `items`
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/item\[1\]/);
  });
});

// ── ADR-063 (4a/4b) operator-guard findings — stable id + NULL-when-unchanged ────────────────────────
// The loop-guard / budget-guard write their finding via updateCardOnDisk; a card write re-triggers the
// fs-watcher → re-eval → the SAME guard. The null-when-unchanged short-circuit is what stops that from
// becoming an infinite write→watch→eval loop, so it is the load-bearing property under test here.
describe("upsertFindingIfChanged — idempotent (null when identical)", () => {
  const f = (over: Partial<Finding> = {}): Finding => ({
    id: "x",
    lens: "general",
    severity: "high",
    title: "t",
    detail: "d",
    status: "open",
    ...over,
  });

  it("APPENDS when the id is absent", () => {
    const out = upsertFindingIfChanged([], f());
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(out![0].id).toBe("x");
  });

  it("returns NULL when a byte-identical finding is already present (no write → no watcher loop)", () => {
    expect(upsertFindingIfChanged([f()], f())).toBeNull();
  });

  it("re-UPSERTS (non-null) when a tracked field changed (e.g. the detail moved on)", () => {
    const out = upsertFindingIfChanged([f({ detail: "old" })], f({ detail: "new" }));
    expect(out).not.toBeNull();
    expect(out![0].detail).toBe("new");
  });

  it("treats absent detail and empty-string detail as equal (no spurious re-write)", () => {
    const a = f({ detail: undefined });
    const b = f({ detail: undefined });
    delete (b as { detail?: string }).detail;
    expect(upsertFindingIfChanged([a], b)).toBeNull();
  });
});

describe("withLoopGuardFinding (ADR-063 4b)", () => {
  it("builds a stable-id, high (NOT blocker) general finding naming the status + run count", () => {
    const out = withLoopGuardFinding([], "story-1", "qa-automatizado", 3);
    expect(out).not.toBeNull();
    const finding = out![0];
    expect(finding.id).toBe(loopGuardFindingId("story-1"));
    expect(finding.id).toBe("loop-guard-story-1");
    expect(finding.severity).toBe("high"); // NOT blocker — must not gate hasNoBlockers/revisao
    expect(finding.lens).toBe("general");
    expect(finding.detail).toMatch(/qa-automatizado/);
    expect(finding.detail).toMatch(/3 vez/);
    expect(finding.detail).toMatch(/USM_AUTORUN_NO_PROGRESS_MAX/); // override hint present
  });

  it("is a NO-OP (null) on the second identical build — the loop-safe idempotency", () => {
    const first = withLoopGuardFinding([], "story-1", "qa-automatizado", 3);
    expect(withLoopGuardFinding(first!, "story-1", "qa-automatizado", 3)).toBeNull();
  });

  it("re-writes (non-null) when the run count advanced (the count is part of the detail)", () => {
    const first = withLoopGuardFinding([], "story-1", "qa-automatizado", 3);
    expect(withLoopGuardFinding(first!, "story-1", "qa-automatizado", 4)).not.toBeNull();
  });
});

describe("withPendingEffectFailureFinding (WS1.4)", () => {
  it("builds a stable-id, high (NOT blocker) general finding naming the effect + error", () => {
    const out = withPendingEffectFailureFinding([], "story-1", "deploy-board", "boom exploded");
    const finding = out[0];
    expect(finding.id).toBe(pendingEffectFailureFindingId("story-1", "deploy-board"));
    expect(finding.id).toBe("pending-effect-story-1-deploy-board");
    expect(finding.severity).toBe("high"); // NOT blocker — the effect is resolved one-shot regardless
    expect(finding.lens).toBe("general");
    expect(finding.detail).toMatch(/deploy-board/);
    expect(finding.detail).toMatch(/boom exploded/);
    expect(finding.status).toBe("open");
  });

  it("is idempotent by id — a re-fire failing again refreshes in place (never stacks)", () => {
    const first = withPendingEffectFailureFinding([], "story-1", "deploy-board", "err A");
    const second = withPendingEffectFailureFinding(first, "story-1", "deploy-board", "err B");
    expect(second).toHaveLength(1);
    expect(second[0].detail).toMatch(/err B/);
  });
});

describe("withCardBudgetFinding (ADR-063 4a)", () => {
  it("builds a stable-id, high general finding naming spent/budget/runs + the override knob", () => {
    const out = withCardBudgetFinding([], "story-1", 15.5, 12, 4);
    expect(out).not.toBeNull();
    const finding = out![0];
    expect(finding.id).toBe(cardBudgetFindingId("story-1"));
    expect(finding.id).toBe("card-budget-story-1");
    expect(finding.severity).toBe("high");
    expect(finding.lens).toBe("general");
    expect(finding.detail).toMatch(/\$15\.50/);
    expect(finding.detail).toMatch(/\$12\.00/);
    expect(finding.detail).toMatch(/USM_AUTORUN_CARD_BUDGET_USD/);
  });

  it("is a NO-OP (null) on the second identical build (spent stable while auto-dispatch is paused)", () => {
    const first = withCardBudgetFinding([], "story-1", 15.5, 12, 4);
    expect(withCardBudgetFinding(first!, "story-1", 15.5, 12, 4)).toBeNull();
  });
});

describe("withMergeBackFailureFinding (story-yy3hds)", () => {
  it("stampa um blocker/general/open que nomeia o worktree e a branch preservados", () => {
    const out = withMergeBackFailureFinding([], "run-a", "/repo/.worktrees/run-run-a", "run/run-a", "EOF in backquote substitution");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(mergeBackFailureFindingId("run-a"));
    expect(out[0].severity).toBe("blocker"); // segura o card no gate hasNoBlockers
    expect(out[0].lens).toBe("general");
    expect(out[0].status).toBe("open");
    expect(out[0].detail).toContain("/repo/.worktrees/run-run-a");
    expect(out[0].detail).toContain("run/run-a");
  });

  it("é idempotente por runId (re-stamp refresca, não duplica)", () => {
    const first = withMergeBackFailureFinding([], "run-a", "/wt", "run/run-a", "d1");
    const again = withMergeBackFailureFinding(first, "run-a", "/wt", "run/run-a", "d2");
    expect(again).toHaveLength(1);
    expect(again[0].detail).toContain("d2");
  });

  it("withRunBlockersResolved resolve o blocker de merge-back de QUALQUER run anterior do card (card-scoped)", () => {
    // O blocker foi stampado pelo run MORTO (run-a). Um run posterior (run-b) integra com sucesso →
    // o caminho de merge-back provou-se são de novo e o board-data novo supersede o worktree
    // preservado. Sem o prefix-match, o id do run morto travaria hasNoBlockers para sempre (audit #6).
    const stamped = withMergeBackFailureFinding([], "run-a", "/wt", "run/run-a", "d");
    const resolved = withRunBlockersResolved(stamped, "run-b");
    expect(resolved[0].status).toBe("fixed");
  });

  it("withRunBlockersResolved segue RUN-scoped para os blockers de gate (não regride o audit #6)", () => {
    // O gate blocker de OUTRO run não é nosso — só o merge-back é card-scoped por design.
    const stamped = withGateBlockerFinding([], "run-a", "gate log");
    const resolved = withRunBlockersResolved(stamped, "run-b");
    expect(resolved[0].id).toBe(gateBlockerFindingId("run-a"));
    expect(resolved[0].status).toBe("open"); // intocado — run-b não é o dono
  });
});

describe("withCodeNotLandedFinding (autonomy-reliability WS-1.2)", () => {
  it("stampa um blocker/general/open que nomeia a branch preservada e o detalhe", () => {
    const out = withCodeNotLandedFinding([], "run-a", "conflicted/run/run-a", "código conflita com stage");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(codeNotLandedFindingId("run-a"));
    expect(out[0].severity).toBe("blocker"); // segura o card no gate hasNoBlockers (não avança fantasma)
    expect(out[0].lens).toBe("general");
    expect(out[0].status).toBe("open");
    expect(out[0].detail).toContain("conflicted/run/run-a");
    expect(out[0].detail).toContain("código conflita com stage");
  });

  it("é opcional no detalhe e idempotente por runId (re-stamp refresca, não duplica)", () => {
    const first = withCodeNotLandedFinding([], "run-a", "run/run-a");
    expect(first[0].detail).toContain("run/run-a");
    const again = withCodeNotLandedFinding(first, "run-a", "conflicted/run/run-a", "d2");
    expect(again).toHaveLength(1);
    expect(again[0].detail).toContain("conflicted/run/run-a");
    expect(again[0].detail).toContain("d2");
  });

  it("withRunBlockersResolved resolve o blocker code-not-landed de QUALQUER run anterior (card-scoped)", () => {
    // Stampado pelo run cuja metade CODE falhou (run-a). Uma integração posterior BEM-SUCEDIDA (o redrive
    // que finalmente aplicou, ou um re-run humano — run-b) prova que o código chegou ao stage → limpa o
    // blocker retroativo; senão o card ficaria travado em revisar-codigo para sempre.
    const stamped = withCodeNotLandedFinding([], "run-a", "conflicted/run/run-a");
    const resolved = withRunBlockersResolved(stamped, "run-b");
    expect(resolved[0].status).toBe("fixed");
  });
});

// autonomy-endgame WS-3.4 — o ESPELHO que faltava. A invariante do train atômico (`dataLanded ⇒ codeStaged`)
// protege contra dados-sem-código, e o irmão acima cobre código-que-não-aterrissou. Ninguém modelou
// código-aterrissou-mas-dados-não: o único detector EXCLUÍA o caso de propósito ("codeStaged true → code is
// safe on stage") — verdadeiro sobre o CÓDIGO, cego sobre o CARD. Resíduo medido: 2 entries presas no runtime
// e um card em `desenvolver` com 6 tasks `false` enquanto a feature ESTAVA staged.
describe("withDataNotLandedFinding (autonomy-endgame WS-3.4)", () => {
  it("stampa um blocker/general/open — o card PRECISA parar: ele está parado, a feature não", () => {
    const out = withDataNotLandedFinding([], "a779b5be", "index.lock");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(dataNotLandedFindingId("a779b5be"));
    expect(out[0].severity).toBe("blocker");
    expect(out[0].lens).toBe("general");
    expect(out[0].status).toBe("open");
    expect(out[0].detail).toContain("index.lock");
  });

  it("o detalhe NOMEIA a recuperação certa e RECUSA a errada (o instinto do operador é o botão de $13)", () => {
    const out = withDataNotLandedFinding([], "a779b5be");
    // Diante de "falhou", o próximo clique é "re-drive" — que re-implementa código já publicado (qb8z2c) e
    // não toca na causa (a falha foi no git apply, não na skill). O texto tem de dizer isso, não só "falhou".
    expect(out[0].detail).toContain("split-a779b5be-data.patch"); // o patch está em disco: retente ELE
    expect(out[0].detail).toMatch(/NÃO re-drivar/);
    expect(out[0].detail).toMatch(/stage/); // e diz que o código está a salvo — o card parou, a feature não
  });

  it("idempotente por runId (re-stamp refresca, não empilha)", () => {
    const first = withDataNotLandedFinding([], "r1", "d1");
    const again = withDataNotLandedFinding(first, "r1", "d2");
    expect(again).toHaveLength(1);
    expect(again[0].detail).toContain("d2");
  });

  it("auto-limpa pela MESMA porta do irmão: uma integração posterior bem-sucedida resolve o blocker", () => {
    // Foi o retry da metade de dados (ou um re-run) que aplicou — o fato que o blocker esperava. Sem isto o
    // card ficaria travado no gate hasNoBlockers para sempre.
    const stamped = withDataNotLandedFinding([], "run-a");
    const resolved = withRunBlockersResolved(stamped, "run-b");
    expect(resolved[0].status).toBe("fixed");
  });
});

// WS-2 (2.3) — o carimbo de autoria numa MUDANÇA de status. Forense: a post-mortem da colisão #2 não
// conseguia responder "quem fechou este finding?" lendo o card. Não participa do merge (pega carona no
// elemento). Os builders continuam PUROS: a data é injetada pelo chamador de IO.
describe("statusBy/statusAt — carimbo de autoria (WS-2 2.3)", () => {
  const stamp = { by: "train:run-b", at: "2026-07-16" };

  it("withRunBlockersResolved carimba quem fechou, e SÓ no finding que ele mudou", () => {
    const existing: Finding[] = [
      ...withCodeNotLandedFinding([], "run-a", "conflicted/run/run-a"),
      { id: "outro", lens: "general", severity: "low", title: "nota do humano", status: "open" },
    ];
    const out = withRunBlockersResolved(existing, "run-b", stamp);
    expect(out[0]).toMatchObject({ status: "fixed", statusBy: "train:run-b", statusAt: "2026-07-16" });
    // o finding que ele NÃO tocou não ganha carimbo (o par só marca uma mudança REAL de status)
    expect(out[1]).not.toHaveProperty("statusBy");
    expect(out[1].status).toBe("open");
  });

  it("sem carimbo (chamador legado) o status muda e os campos seguem esparsos", () => {
    const out = withRunBlockersResolved(withCodeNotLandedFinding([], "run-a", "b"), "run-b");
    expect(out[0].status).toBe("fixed");
    expect(out[0]).not.toHaveProperty("statusBy");
  });

  it("um finding recém-cunhado NÃO é uma mudança de status → nasce sem carimbo", () => {
    expect(withCodeNotLandedFinding([], "run-a", "b")[0]).not.toHaveProperty("statusBy");
    expect(withGateBlockerFinding([], "run-a", "log")[0]).not.toHaveProperty("statusBy");
  });
});

// WS-2 (2.4 / G9) — o merge por id assume que um id nomeia o MESMO fato dos dois lados. Ids de mecanismo
// já são únicos por construção; ids de LENTE cunhados posicionalmente ("f1") colidem entre runs. Este é o
// molde canônico que a prosa do harness-review espelha (cooperativo, como o parseFindingBatch).
describe("reviewFindingId (WS-2 2.4)", () => {
  it("compõe <lens>-<seq>-<proveniência> — dois runs sobre a MESMA lente/seq não colidem", () => {
    expect(reviewFindingId("security", 1, "8b47e6a7f")).toBe("security-1-8b47e6a7f");
    // a colisão que o G9 descreve: mesma lente, mesma posição, runs diferentes → ids diferentes
    expect(reviewFindingId("security", 1, "run-a")).not.toBe(reviewFindingId("security", 1, "run-b"));
  });

  it("normaliza lente/proveniência para um id seguro em yaml/url e trunca o sha longo", () => {
    expect(reviewFindingId("Next.js", 2, "  8B47E6A7F0C1D2E3F4  ")).toBe("next-js-2-8b47e6a7f0c1");
    expect(reviewFindingId("", 1, "run/a")).toBe("general-1-run-a");
  });

  it("sem proveniência cai no par lente-seq (não inventa sufixo vazio pendurado)", () => {
    expect(reviewFindingId("perf", 3, "")).toBe("perf-3");
  });
});

// The stale-"Bloqueio" fix: a card in a TERMINAL status keeps residual MECHANISM blockers (code/data-not-
// landed, merge-back) `open` forever — withRunBlockersResolved only fires on a FUTURE train integration a
// terminal card never gets. isMechanismBlockerId is the shared predicate; supersedeStaleTerminalBlockers
// closes exactly those on terminal entry, and NOTHING else (gate/secret/human/review/deploy-failure).
describe("isMechanismBlockerId — the shared CARD-scoped mechanism-prefix predicate", () => {
  it("matches code/data-not-landed + merge-back ids; rejects gate/secret/review/deploy-failure/arbitrary", () => {
    expect(isMechanismBlockerId(codeNotLandedFindingId("r1"))).toBe(true);
    expect(isMechanismBlockerId(dataNotLandedFindingId("r1"))).toBe(true);
    expect(isMechanismBlockerId(mergeBackFailureFindingId("r1"))).toBe(true);
    expect(isMechanismBlockerId(gateBlockerFindingId("r1"))).toBe(false);
    expect(isMechanismBlockerId(secretScanBlockerFindingId("r1"))).toBe(false);
    expect(isMechanismBlockerId(reviewFindingId("security", 1, "sha"))).toBe(false);
    expect(isMechanismBlockerId("deploy-failure")).toBe(false);
    expect(isMechanismBlockerId("outro")).toBe(false);
  });
});

describe("supersedeStaleTerminalBlockers — terminal entry clears residual mechanism blockers", () => {
  const stamp = { by: "terminal:concluida", at: "2026-07-24" };

  it("flips ALL 3 mechanism prefixes open→fixed, stamped (code/data-not-landed + merge-back)", () => {
    let f: Finding[] = [];
    f = withCodeNotLandedFinding(f, "run-a", "conflicted/run/run-a");
    f = withDataNotLandedFinding(f, "run-b");
    f = withMergeBackFailureFinding(f, "run-c", "/wt", "conflicted/run/run-c", "merge falhou");
    const out = supersedeStaleTerminalBlockers(f, stamp);
    expect(out).not.toBeNull();
    for (const id of [codeNotLandedFindingId("run-a"), dataNotLandedFindingId("run-b"), mergeBackFailureFindingId("run-c")]) {
      expect(out!.find((x) => x.id === id)).toMatchObject({ status: "fixed", statusBy: "terminal:concluida", statusAt: "2026-07-24" });
    }
  });

  it("NEVER touches the run-scoped gate/secret blockers (terminal is no proof a test/secret defect was fixed)", () => {
    let f: Finding[] = [];
    f = withGateBlockerFinding(f, "run-x", "vitest red");
    f = withSecretScanBlockerFinding(f, "run-x", "token vazou");
    f = withCodeNotLandedFinding(f, "run-x", "conflicted/run/run-x"); // a mechanism blocker so the call isn't a no-op
    const out = supersedeStaleTerminalBlockers(f, stamp);
    expect(out!.find((x) => x.id === gateBlockerFindingId("run-x"))?.status).toBe("open");
    expect(out!.find((x) => x.id === secretScanBlockerFindingId("run-x"))?.status).toBe("open");
    expect(out!.find((x) => x.id === codeNotLandedFindingId("run-x"))?.status).toBe("fixed"); // only the mechanism one flipped
  });

  it("NEVER touches a human/review blocker nor a deploy-failure finding (disjoint ids stay open + unstamped)", () => {
    const f: Finding[] = [
      { id: reviewFindingId("security", 1, "sha"), lens: "security", severity: "blocker", title: "authz aberta", status: "open" },
      { id: "deploy-failure", lens: "general", severity: "high", title: "release falhou", status: "open" },
      ...withCodeNotLandedFinding([], "run-a", "conflicted/run/run-a"),
    ];
    const out = supersedeStaleTerminalBlockers(f, stamp);
    expect(out!.find((x) => x.id === reviewFindingId("security", 1, "sha"))).toMatchObject({ status: "open" });
    expect(out!.find((x) => x.id === reviewFindingId("security", 1, "sha"))).not.toHaveProperty("statusBy");
    expect(out!.find((x) => x.id === "deploy-failure")).toMatchObject({ status: "open" });
  });

  it("preserves an operator's wontfix/acknowledged on a mechanism finding (flips only `open`)", () => {
    const wontfixed: Finding[] = withCodeNotLandedFinding([], "run-a", "conflicted/run/run-a").map((x) => ({ ...x, status: "wontfix" as const }));
    expect(supersedeStaleTerminalBlockers(wontfixed, stamp)).toBeNull(); // nothing OPEN → no-op
  });

  it("returns null (skip the write) when there is no open mechanism blocker — loop-safe on terminal re-entry", () => {
    expect(supersedeStaleTerminalBlockers([], stamp)).toBeNull();
    const once = supersedeStaleTerminalBlockers(withCodeNotLandedFinding([], "run-a", "b"), stamp);
    expect(once).not.toBeNull();
    expect(supersedeStaleTerminalBlockers(once!, stamp)).toBeNull(); // a second terminal entry is a no-op
  });

  it("stamps ONLY the findings it changed — a co-resident untouched finding stays unstamped", () => {
    const f: Finding[] = [
      { id: "outro", lens: "general", severity: "low", title: "nota", status: "open" },
      ...withDataNotLandedFinding([], "run-b"),
    ];
    const out = supersedeStaleTerminalBlockers(f, stamp);
    expect(out!.find((x) => x.id === "outro")).not.toHaveProperty("statusBy");
    expect(out!.find((x) => x.id === dataNotLandedFindingId("run-b"))).toMatchObject({ status: "fixed", statusBy: "terminal:concluida" });
  });
});

// The shared READ-surface filter: every blocker surface (Kanban chip, card-document, MCP slim count, step
// rollup) routes through this so a terminal card never shows a stale mechanism blocker — the display backstop
// (covers even the harness-retire route, which archives by writing the .md directly, bypassing the supersede).
describe("liveOpenBlockers — shared terminal-aware blocker read filter", () => {
  it("non-terminal (default): returns EVERY open blocker — byte-identical to the old severity/status filter", () => {
    let f: Finding[] = [];
    f = withCodeNotLandedFinding(f, "run-a", "b"); // mechanism blocker
    f = withGateBlockerFinding(f, "run-x", "red"); // non-mechanism blocker
    f = [...f, { id: "human", lens: "general", severity: "blocker", title: "x", status: "open" }];
    f = [...f, { id: "adv", lens: "general", severity: "low", title: "y", status: "open" }]; // not a blocker
    expect(liveOpenBlockers(f).map((x) => x.id).sort()).toEqual(
      [codeNotLandedFindingId("run-a"), gateBlockerFindingId("run-x"), "human"].sort(),
    );
    expect(liveOpenBlockers(f, false).length).toBe(3);
  });

  it("terminal: DROPS residual mechanism blockers, keeps genuine non-mechanism blockers", () => {
    let f: Finding[] = [];
    f = withCodeNotLandedFinding(f, "run-a", "b");
    f = withDataNotLandedFinding(f, "run-b");
    f = withMergeBackFailureFinding(f, "run-c", "/wt", "br", "d");
    f = withGateBlockerFinding(f, "run-x", "red"); // NON-mechanism → stays actionable even on terminal
    expect(liveOpenBlockers(f, true).map((x) => x.id)).toEqual([gateBlockerFindingId("run-x")]);
  });

  it("ignores non-blocker severities and non-open statuses; handles undefined", () => {
    const f: Finding[] = [
      { id: "code-not-landed-r", lens: "general", severity: "blocker", title: "m", status: "fixed" }, // fixed → out
      { id: "adv", lens: "general", severity: "medium", title: "a", status: "open" }, // not blocker → out
    ];
    expect(liveOpenBlockers(f, false)).toEqual([]);
    expect(liveOpenBlockers(f, true)).toEqual([]);
    expect(liveOpenBlockers(undefined)).toEqual([]);
    expect(liveOpenBlockers(undefined, true)).toEqual([]);
  });
});
