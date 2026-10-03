import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { cardToFrontmatter } from "./write";
import { coerceCard } from "./repo";
import type { Card } from "./types";

// The 3 existing round-trip tests run coerceCard <-> cardToFrontmatter purely in
// MEMORY, skipping matter.stringify + js-yaml entirely. This runs the REAL
// serialization path writeCard/readCards use (matter.stringify → matter → coerceCard)
// WITHOUT touching the filesystem — so it covers the js-yaml date hazard the
// in-memory tests miss, but never pollutes the live (watched) storymap/boards dir.
function roundTrip(card: Card): Card {
  const fm = cardToFrontmatter(card);
  const file = matter.stringify(`\n${(card.body ?? "").trim()}\n`, fm); // exactly what writeCard does
  const { data, content } = matter(file); // exactly what readCards does
  return coerceCard(card.id, data as Record<string, unknown>, content);
}

const card = (data: Record<string, unknown>) => coerceCard("c", { type: "story", ...data }, "");

describe("card serialization round-trip (real gray-matter + js-yaml)", () => {
  it("preserves every human-authored field of a full story", () => {
    const original = card({
      title: "Achar livros do meu autor favorito",
      status: "refinada",
      parent: "step-buscar",
      release: "r1",
      personas: ["leitor"],
      systems: ["checkout"],
      narrative: { role: "Como leitor", want: "quero ver os lançamentos do autor", soThat: "para não perder a próxima leitura" },
      acceptance: ["dado X, quando Y, então Z", "outro critério"],
      tasks: [{ id: "t1", title: "buscar", done: true }, { id: "t2", title: "render", done: false }],
      rice: { reach: 100, impact: 2, confidence: 0.8, effort: 4 },
      kano: "performance",
      funnelStage: "activation",
      order: 30,
    });
    const back = roundTrip({ ...original, body: "Descrição do card." });

    expect(back.title).toBe(original.title);
    expect(back.status).toBe("refinada");
    expect(back.parent).toBe("step-buscar");
    expect(back.release).toBe("r1");
    expect(back.personas).toEqual(["leitor"]);
    expect(back.systems).toEqual(["checkout"]);
    expect(back.narrative).toEqual(original.narrative);
    expect(back.acceptance).toEqual(original.acceptance);
    expect(back.tasks).toEqual(original.tasks);
    expect(back.rice).toEqual(original.rice);
    expect(back.kano).toBe("performance");
    expect(back.funnelStage).toBe("activation");
    expect(back.order).toBe(30);
    expect(back.body).toBe("Descrição do card.");
  });

  it("preserves pipeline-owned fields + normalizes their date fields", () => {
    const original = card({
      status: "revisao",
      techPlanReady: true,
      wireframeChosen: "opt-2",
      findings: [{ id: "f1", lens: "security", severity: "blocker", title: "regra aberta", status: "open" }],
      reviewedAt: "2026-06-01",
      reviewCommit: "abc123",
      qaPassed: true,
      qaRanAt: "2026-06-02",
      qaCommit: "def456",
      commitRange: { base: "base0sha", head: "head9sha" },
      mode: "refine",
      refinement: { brief: "melhorar o header", kinds: ["ux"] },
    });
    const back = roundTrip(original);

    expect(back.techPlanReady).toBe(true);
    expect(back.wireframeChosen).toBe("opt-2");
    expect(back.findings).toHaveLength(1);
    expect(back.findings[0]).toMatchObject({ id: "f1", severity: "blocker", status: "open" });
    expect(back.qaPassed).toBe(true);
    expect(back.mode).toBe("refine");
    expect(back.refinement?.brief).toBe("melhorar o header");
    // SM-05: the nested { base, head } object survives the real js-yaml roundtrip.
    expect(back.commitRange).toEqual({ base: "base0sha", head: "head9sha" });
    // date fields survive as YYYY-MM-DD strings (not Date objects) through js-yaml
    expect(back.reviewedAt).toBe("2026-06-01");
    expect(back.qaRanAt).toBe("2026-06-02");
  });

  it("preserves HITL questions[] (ask + answer) through the real js-yaml roundtrip", () => {
    const original = card({
      status: "grill",
      questions: [
        { id: "q1", text: "Quem é o usuário exato?", askedBy: "harness-grill", askedAt: "2026-06-11", status: "open" },
        { id: "q2", text: "Qual a métrica de sucesso?", askedBy: "harness-grill", askedAt: "2026-06-11", status: "answered", answer: "ativação D1", answeredAt: "2026-06-11" },
      ],
    });
    const back = roundTrip(original);
    expect(back.questions).toHaveLength(2);
    expect(back.questions?.[0]).toEqual({ id: "q1", text: "Quem é o usuário exato?", askedBy: "harness-grill", askedAt: "2026-06-11", status: "open" });
    expect(back.questions?.[1]).toEqual({
      id: "q2",
      text: "Qual a métrica de sucesso?",
      askedBy: "harness-grill",
      askedAt: "2026-06-11",
      status: "answered",
      answer: "ativação D1",
      answeredAt: "2026-06-11",
    });
  });

  it("omits an empty questions[] (sparse — lean cards carry no field)", () => {
    expect(roundTrip(card({ status: "grill" })).questions).toBeUndefined();
  });

  it("F6.3: preserves answeredBy:copilot through the real js-yaml roundtrip; a human answer omits it", () => {
    const original = card({
      status: "grill",
      questions: [
        { id: "q1", text: "O ISBN da edição é o mesmo?", askedBy: "harness-grill", askedAt: "2026-07-10", status: "answered", answer: "sim, idêntico", answeredAt: "2026-07-10", answeredBy: "copilot" },
        { id: "q2", text: "Frete grátis ou cupom na primeira compra?", askedBy: "harness-grill", askedAt: "2026-07-10", status: "answered", answer: "o cupom, que é mais fácil de medir", answeredAt: "2026-07-10" },
      ],
    });
    const back = roundTrip(original);
    // the copilot answer keeps its attribution across write→read (the serializer footgun class)
    expect(back.questions?.[0]).toMatchObject({ id: "q1", status: "answered", answeredBy: "copilot" });
    // the human answer (no answeredBy) never gains the field (stays lean)
    expect(back.questions?.[1]).not.toHaveProperty("answeredBy");
  });

  it("WS-2 (2.3): preserves statusBy/statusAt on a finding through the real js-yaml roundtrip", () => {
    const original = card({
      status: "revisar-codigo",
      findings: [
        // triado por um humano — o par carimbado deve sobreviver a write→read→write
        { id: "code-not-landed-3f9a21d4", lens: "general", severity: "blocker", title: "código não aterrissou", status: "fixed", statusBy: "human", statusAt: "2026-02-18" },
        // auto-resolvido pelo train
        { id: "gate-r1", lens: "testing", severity: "blocker", title: "merge gate falhou", status: "fixed", statusBy: "train:r1", statusAt: "2026-02-18" },
        // nunca triado → segue esparso (não ganha os campos do nada)
        { id: "fresh-review-b71d09e", lens: "general", severity: "low", title: "nota nova", status: "open" },
      ],
    });
    const back = roundTrip(original);

    // statusAt is the js-yaml date hazard: a bare 2026-07-16 parses as a Date, and a raw String() would
    // persist "Thu Jul 16 2026 …" back into the frontmatter (hence toDateString in coerceFindings).
    expect(back.findings[0]).toMatchObject({ status: "fixed", statusBy: "human", statusAt: "2026-02-18" });
    expect(back.findings[1]).toMatchObject({ statusBy: "train:r1", statusAt: "2026-02-18" });
    expect(back.findings[2]).not.toHaveProperty("statusBy");
    expect(back.findings[2]).not.toHaveProperty("statusAt");
    // write→read→write is STABLE (the second pass neither drops nor mutates the stamp)
    expect(roundTrip(back).findings).toEqual(back.findings);
  });

  it("preserva a fase do finding de publicação (deployPhase) — sem ela o Inbox volta a dizer «falhou» a um pedido", () => {
    const original = card({
      status: "release",
      findings: [
        { id: "deploy-failure", lens: "general", severity: "high", title: "Precisa de você", status: "open", deployPhase: "needs-human" },
        { id: "outro", lens: "general", severity: "low", title: "nota", status: "open" },
      ],
    });
    const back = roundTrip(original);
    expect(back.findings[0]).toMatchObject({ id: "deploy-failure", deployPhase: "needs-human" });
    expect(back.findings[1]).not.toHaveProperty("deployPhase");
    // valor fora do vocabulário é descartado na leitura (fica esparso), nunca vira fase inventada
    const raw = "---\nid: c\ntype: story\nstatus: release\nfindings:\n  - id: deploy-failure\n    lens: general\n    severity: high\n    title: x\n    status: open\n    deployPhase: inventada\n---\ncorpo";
    const { data, content } = matter(raw);
    expect(coerceCard("c", data as Record<string, unknown>, content).findings?.[0]).not.toHaveProperty("deployPhase");
  });

  it("preserva a causa estruturada da parada de publicação (deployCause) e descarta forma quebrada", () => {
    const cause = {
      pkg: "armazemweb",
      phase: "needs-units" as const,
      units: ["batch-reports"],
      rules: ["unclassified-unit"],
      ownerClass: null,
      decider: "system" as const,
      causeKey: "armazemweb:unclassified-unit:batch-reports",
      headSha: "abc1234",
      attributedCardIds: ["story-a1"],
    };
    const original = card({
      status: "release",
      findings: [
        { id: "deploy-failure", lens: "general", severity: "high", title: "Publicação parada", status: "open", deployPhase: "needs-units", deployCause: cause },
        { id: "outro", lens: "general", severity: "low", title: "nota", status: "open" },
      ],
    });
    const back = roundTrip(original);
    expect(back.findings[0]).toMatchObject({ deployPhase: "needs-units", deployCause: cause });
    expect(back.findings[1]).not.toHaveProperty("deployCause");
    expect(roundTrip(back).findings).toEqual(back.findings);
    // forma quebrada (sem causeKey / decider fora do vocabulário) é descartada na leitura — nunca meia causa
    const raw = "---\nid: c\ntype: story\nstatus: release\nfindings:\n  - id: deploy-failure\n    lens: general\n    severity: high\n    title: x\n    status: open\n    deployCause:\n      pkg: armazemweb\n      phase: needs-units\n      units: []\n      rules: []\n      ownerClass: null\n      decider: talvez\n      causeKey: k\n---\ncorpo";
    const { data, content } = matter(raw);
    expect(coerceCard("c", data as Record<string, unknown>, content).findings?.[0]).not.toHaveProperty("deployCause");
  });

  it("preserva a marca de «adiado — não agora» (deferred) e descarta forma quebrada", () => {
    const deferred = { reason: "módulo de relatórios fica para o próximo semestre", since: "2026-03-11", reviewOn: "2026-04-30", by: "human", root: "story-ex0010" };
    const back = roundTrip(card({ status: "enriquecer", deferred }));
    expect(back.deferred).toEqual(deferred);
    expect(roundTrip(back).deferred).toEqual(deferred);
    expect(roundTrip(card({ status: "enriquecer" })).deferred).toBeUndefined();
    // sem motivo não existe adiamento (cai na leitura)
    const raw = "---\nid: c\ntype: story\nstatus: enriquecer\ndeferred:\n  since: '2026-03-11'\n  by: human\n---\ncorpo";
    const { data, content } = matter(raw);
    expect(coerceCard("c", data as Record<string, unknown>, content).deferred).toBeUndefined();
  });

  it("drops a half-written commitRange (missing base or head) on read", () => {
    // A malformed range (only `head`) must coerce to undefined, not a broken link.
    const raw = "---\nid: c\ntype: story\nstatus: revisao\ncommitRange:\n  head: onlyhead\n---\ncorpo";
    const { data, content } = matter(raw);
    const c = coerceCard("c", data as Record<string, unknown>, content);
    expect(c.commitRange).toBeUndefined();
  });

  it("SM-04: preserves diffSnapshot { base, mergeCommit } through the real js-yaml roundtrip", () => {
    const original = card({
      status: "concluida",
      diffSnapshot: { base: "base0sha", mergeCommit: "merge9sha" },
    });
    const back = roundTrip(original);
    expect(back.diffSnapshot).toEqual({ base: "base0sha", mergeCommit: "merge9sha" });
  });

  it("SM-04: omits diffSnapshot from the frontmatter when absent (lean write)", () => {
    const fm = cardToFrontmatter(card({ status: "desenvolver" }));
    expect("diffSnapshot" in fm).toBe(false);
  });

  it("dual-track: preserves `serves` on a DELIVERY story through the real js-yaml roundtrip", () => {
    const back = roundTrip(card({ storyType: "technical", parent: "step-x", serves: "step-y" }));
    expect(back.serves).toBe("step-y");
  });

  it("dual-track: omits `serves` from the frontmatter when absent (lean write)", () => {
    const fm = cardToFrontmatter(card({ storyType: "bug", parent: "step-x" }));
    expect("serves" in fm).toBe(false);
  });

  it("dual-track: omits `serves` for a USER story even when set (keyed on current storyType)", () => {
    // A user story is map backbone, never attributed via a shelf — serves must not persist,
    // so a story reclassified delivery→user drops a stale serves on next write.
    const fm = cardToFrontmatter(card({ storyType: "user", parent: "step-x", serves: "step-y" }));
    expect("serves" in fm).toBe(false);
  });

  it("dual-track: a blank/whitespace `serves` coerces to undefined (not a broken link)", () => {
    const raw = "---\nid: c\ntype: story\nstoryType: bug\nstatus: corrigir\nserves: '   '\n---\ncorpo";
    const { data, content } = matter(raw);
    const c = coerceCard("c", data as Record<string, unknown>, content);
    expect(c.serves).toBeUndefined();
  });

  it("SM-04: drops a half-written diffSnapshot (missing base or mergeCommit) on read", () => {
    // Only `mergeCommit` present → coerces to undefined, not a broken half-snapshot.
    const raw =
      "---\nid: c\ntype: story\nstatus: concluida\ndiffSnapshot:\n  mergeCommit: onlymerge\n---\ncorpo";
    const { data, content } = matter(raw);
    const c = coerceCard("c", data as Record<string, unknown>, content);
    expect(c.diffSnapshot).toBeUndefined();
  });

  it("stamps `updated` as a YYYY-MM-DD string on every write", () => {
    const back = roundTrip(card({ status: "rascunho" }));
    expect(back.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("normalizes an UNQUOTED date that js-yaml parses as a Date (the toDateString hazard)", () => {
    // YAML 1.1 parses a bare `2026-06-02` as a JS Date — repo.ts toDateString must
    // bring it back to a YYYY-MM-DD string. This is the single most fragile edge
    // and only manifests through a real js-yaml load (which matter() performs).
    const raw = "---\nid: c\ntype: story\nstatus: refinada\ncreated: 2026-06-02\n---\ncorpo";
    const { data, content } = matter(raw);
    const c = coerceCard("c", data as Record<string, unknown>, content);
    expect(c.created).toBe("2026-06-02");
    expect(typeof c.created).toBe("string");
  });

  // reabertura R1 — the ONE-SHOT override flag MUST survive the REAL write→read path. The first review
  // caught that cardToFrontmatter dropped it: set in memory by the reopen action, then stripped on the
  // first disk write, so the cascade (which reads the card FRESH from disk) never saw it → the override
  // was dead code. This pins the round-trip so the regression can't come back.
  it("reabertura R1: reopenPending:true survives the real serialization round-trip (write→read)", () => {
    const reopened = card({ status: "desenvolver", mode: "fix", reopenPending: true });
    const back = roundTrip(reopened);
    expect(back.reopenPending).toBe(true);
    expect(back.mode).toBe("fix");
  });

  it("reabertura R1: a card WITHOUT reopenPending never emits the key (sparse, like a build card)", () => {
    const fm = cardToFrontmatter(card({ status: "desenvolver", mode: "build" }));
    expect("reopenPending" in fm).toBe(false);
    // and a cleared reopen (the skill's clearReopenPending) round-trips to undefined, not false-stuck
    const back = roundTrip(card({ status: "revisar-codigo", mode: "fix" }));
    expect(back.reopenPending).toBeUndefined();
  });

  // D15 field-drop fix — hasUiSurface/bet/owner lived in the Zod contract + coerceCard but NOT in
  // cardToFrontmatter: harness-enrich wrote them frontmatter-direct and the NEXT app write erased them.
  // These pin the real write→read trip so the serializer-omission class can't silently return.
  it("D15: hasUiSurface survives the round-trip for BOTH values; absent card never emits the key", () => {
    expect(roundTrip(card({ status: "interview", hasUiSurface: true })).hasUiSurface).toBe(true);
    // false is a REAL value (story with no UI surface) — a truthiness emit would drop it
    expect(roundTrip(card({ status: "interview", hasUiSurface: false })).hasUiSurface).toBe(false);
    expect("hasUiSurface" in cardToFrontmatter(card({ status: "interview" }))).toBe(false);
  });

  it("D15: bet + owner survive the real js-yaml round-trip; both stay sparse when absent", () => {
    const back = roundTrip(
      card({
        status: "priorizar",
        owner: "agent",
        bet: {
          assumptions: ["leitores aceitam comprar sem criar conta antes"],
          riskiestAssumption: "eles confiam na nota média mostrada na vitrine",
          experimentStatus: "untested",
        },
      }),
    );
    expect(back.owner).toBe("agent");
    expect(back.bet).toEqual({
      assumptions: ["leitores aceitam comprar sem criar conta antes"],
      riskiestAssumption: "eles confiam na nota média mostrada na vitrine",
      experimentStatus: "untested",
    });
    const fm = cardToFrontmatter(card({ status: "priorizar" }));
    expect("bet" in fm).toBe(false);
    expect("owner" in fm).toBe(false);
    // an assumption-less bet coerces to null on read (coerceBet) → the write side mirrors that: no key
    expect("bet" in cardToFrontmatter(card({ status: "priorizar", bet: { assumptions: [] } }))).toBe(false);
  });
});
