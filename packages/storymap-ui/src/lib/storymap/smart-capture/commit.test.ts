// Unit tests for commitProposalAction — dedup behaviour (AC-1/2/3)
// story-sm-01-dedup-commitproposal
//
// HISTÓRICO (2 reviravoltas, e a 2a é a que vale):
//  1. commitProposalAction IGNORAVA `it.duplicateOf` — criava um card de triagem mesmo quando o LLM sinalizava
//     duplicata. Corrigido honrando o campo: a duplicata resolvida ia para o status "duplicado".
//  2. Essa correção passou do ponto. `duplicado` é TERMINAL, na coluna `archive` — então honrar o campo virou
//     ARQUIVAR o card sozinho: o operador capturava, a UI mostrava o card que seria criado, ele confirmava, e
//     nada aparecia no board. O sistema decidia por ele. (2026-07-13, com uma captura de melhoria no headline
//     deduplicada contra uma story JÁ ENTREGUE.)
//
// A REGRA ATUAL (decisão do operador): duplicata é AVISO, não veredito. O card entra na TRIAGEM carregando a
// suspeita (`duplicateOf` + `needsHumanReview` + warning `duplicate-suspected`, badge "Dup · X"); quem decide
// arquivar é o HUMANO — ou o Jido autônomo — pela ação explícita "Marcar duplicado".
// Um `duplicateOf` que não resolve continua caindo num create normal, sem suspeita.

import { vi, describe, it, expect, beforeEach } from "vitest";

// All vi.mock() calls are hoisted by vitest before imports.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/storymap/repo", () => ({
  readBoardConfig: vi.fn(),
  readCards: vi.fn(),
}));
vi.mock("@/lib/storymap/write", () => ({
  writeCard: vi.fn(),
  deleteCardFile: vi.fn(),
  updateCardOnDisk: vi.fn(),
  writeBoardConfig: vi.fn(),
  // createcard-toctou: pass-through (the real lock just serializes; these tests are single-call).
  withCreateLock: <T>(_boardId: string, fn: () => Promise<T>) => fn(),
}));
vi.mock("@/lib/storymap/runner/engine", () => ({ getRunnerEngine: vi.fn() }));
vi.mock("@/lib/notifications/server/channels/autorun-eval", () => ({
  evaluateAutorunOnEntry: vi.fn(),
}));
// story-cl1mi9: the capture path persists pasted context images to the bug sidecar. Mock the
// (fs) sidecar writer so the unit test can assert the filenames it returns land on the card.
vi.mock("@/lib/storymap/sidecars", () => ({
  writeBugScreenshots: vi.fn(),
}));

import { readBoardConfig, readCards } from "@/lib/storymap/repo";
import { writeCard, updateCardOnDisk } from "@/lib/storymap/write";
import { writeBugScreenshots } from "@/lib/storymap/sidecars";
import { commitProposalAction, createCardAction, setCardLinksAction } from "@/app/actions";
import { guardCaptureIdeas } from "./commit";
import type { BoardConfig, Card } from "@/lib/storymap/types";
import type { CaptureImageInput, ProposedItem } from "./types";

const board: BoardConfig = {
  id: "test-board",
  name: "Test",
  statuses: [
    { id: "triage", name: "Triagem", staging: true },
    { id: "corrigir", name: "Corrigir", gate: "hasBugReport" },
    { id: "duplicado", name: "Duplicado", terminal: true, gate: "hasDuplicateOf" },
  ],
  releases: [],
  personas: [],
  systems: [],
  linkTypes: [],
};

const existingCard: Card = {
  id: "story-canonica",
  type: "story",
  title: "Canônica",
  storyType: "user",
  status: "triage",
  parent: "step-base",
  release: null,
  personas: [],
  systems: [],
  links: [],
  narrative: { role: null, want: null, soThat: null },
  acceptance: [],
  tasks: [],
  rice: { reach: null, impact: null, confidence: null, effort: null },
  kano: null,
  funnelStage: null,
  findings: [],
  created: null,
  updated: null,
  order: 10,
  body: "",
};

/** Backbone mínimo e VÁLIDO para ancorar as fixtures — desde a invariante de hierarquia, um card sem
 *  âncora não é representável, então todo teste precisa de um step (para user story) e de uma user story
 *  (para entrega) que EXISTAM no board. */
const existingActivity: Card = { ...existingCard, id: "act-base", type: "activity", title: "Ação base", storyType: null, parent: null };
const existingStep: Card = { ...existingCard, id: "step-base", type: "step", title: "Passo base", storyType: null, parent: "act-base" };
const BACKBONE = [existingActivity, existingStep];

const mockedReadBoardConfig = vi.mocked(readBoardConfig);
const mockedReadCards = vi.mocked(readCards);
const mockedWriteCard = vi.mocked(writeCard);
const mockedUpdateCardOnDisk = vi.mocked(updateCardOnDisk);
const mockedWriteBugScreenshots = vi.mocked(writeBugScreenshots);

/**
 * TODO card nasce ancorado (a invariante de hierarquia). Os testes DESTE arquivo medem OUTRAS coisas —
 * rota de bug, tasks, OST, imagens, dedup — e escreviam fixtures sem pai só porque era PERMITIDO. Este
 * helper dá a elas uma ÂNCORA válida (o step base para user story, a story canônica para entrega), para
 * cada teste seguir focado no que realmente verifica. Antes ele injetava um `ackUnplaced` — a válvula que
 * foi aposentada justamente por deixar órfão entrar.
 * Os testes DE PLACEMENT (no fim do arquivo) montam os itens à mão — é o que eles medem.
 */
const commit: typeof commitProposalAction = (input) =>
  commitProposalAction({
    ...input,
    items: input.items.map((it) => {
      if (it.type !== "story" || it.parent || it.serves) return it;
      const isDelivery = !!it.storyType && it.storyType !== "user";
      return { ...it, parent: isDelivery ? existingCard.id : existingStep.id };
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadBoardConfig.mockResolvedValue(board);
  mockedReadCards.mockResolvedValue([existingCard, ...BACKBONE]);
  mockedWriteCard.mockResolvedValue(undefined);
});

// AC-1 (REESCRITO — 2026-07-13, decisão explícita do operador) — duplicata é AVISO, não VEREDITO.
//
// O AC ANTIGO era: "duplicateOf resolved → creates status:duplicado card, not triage". Isso fazia a captura
// ARQUIVAR o card sozinha (status `duplicado` é terminal, coluna `archive`): o operador capturava uma ideia, a
// UI mostrava o card que seria criado, ele confirmava — e nada aparecia no board. O card existia, invisível, e
// a decisão tinha sido tomada por ele. Aconteceu de verdade com uma captura de melhoria no headline,
// deduplicada contra uma story JÁ ENTREGUE (e melhoria sobre algo entregue não é duplicata dela).
//
// A regra nova, do operador: "duplicação deve ser informada e alertada quando capturo — mas deve partir de
// mim, ou do Jido autônomo, decidir se cancela a captura por ser duplicação ou prossegue."
// Logo: o card entra na Triagem carregando a suspeita; só a ação explícita "Marcar duplicado" o arquiva.
describe("AC-1: duplicateOf resolvido → card entra na TRIAGEM com a suspeita, NUNCA arquivado sozinho", () => {
  const dup: ProposedItem = {
    tempId: "i1",
    type: "story",
    title: "Melhoria no headline",
    rationale: "parece a story já entregue",
    duplicateOf: "story-canonica",
  };

  it("cria na Triagem (NÃO em `duplicado`) carregando duplicateOf + needsHumanReview", async () => {
    const result = await commit({ boardId: "test-board", items: [dup] });

    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    // O REGRESSO que este teste tranca: status "duplicado" = o sistema decidindo pelo humano.
    expect(written.status).not.toBe("duplicado");
    expect(written.status).toBe("triage");
    // a suspeita VIAJA com o card (badge "Dup · X") e o marca para decisão — sem escondê-lo
    expect(written.duplicateOf).toBe("story-canonica");
    expect(written.needsHumanReview).toBe(true);
  });

  it("devolve um warning `duplicate-suspected` para quem chamou (o alerta não se perde)", async () => {
    const result = await commit({ boardId: "test-board", items: [dup] });

    if (!result.ok) throw new Error(result.error);
    const w = result.data!.warnings.find((x) => x.code === "duplicate-suspected");
    expect(w, "a captura precisa AVISAR da suspeita — é o que permite decidir").toBeTruthy();
    expect(w?.tempId).toBe("i1");
    expect(w?.detail).toContain("story-canonica");
  });

  it("o card fica VISÍVEL no board — não vai para a coluna archive", async () => {
    await commit({ boardId: "test-board", items: [dup] });

    const writeCalls = mockedWriteCard.mock.calls as Array<[string, Card]>;
    // `duplicado`/`cancelado`/`arquivados` são tombstones do archive: nenhuma captura pode cair lá sozinha.
    expect(writeCalls.filter(([, c]) => c.status === "duplicado")).toHaveLength(0);
    expect(writeCalls.filter(([, c]) => c.status === "triage")).toHaveLength(1);
  });
});

// AC-2 — duplicateOf aponta para id que NÃO existe no board → cria card normalmente
describe("AC-2: duplicateOf invalid (id not in board) → creates card as normal (triage)", () => {
  it("creates a triage card when duplicateOf does not resolve to an existing id", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Novo item",
      rationale: "ainda não existe",
      duplicateOf: "story-inexistente",
    };

    const result = await commit({ boardId: "test-board", items: [item] });

    expect(result.ok).toBe(true);
    expect(mockedWriteCard).toHaveBeenCalledOnce();
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.status).toBe("triage");
    expect(written.duplicateOf).toBeUndefined();
  });
});

// AC-3 (REESCRITO com o AC-1) — lote misto: 2 normais + 1 suspeito → os 3 na TRIAGEM, o suspeito sinalizado.
// Antes o suspeito ia para `duplicado` e sumia do board; num LOTE isso é ainda pior: o operador aceita 3 cards
// e só 2 aparecem, sem nada dizer qual foi engolido nem por quê.
describe("AC-3: lote misto — 2 normais + 1 suspeito → 3 na Triagem, e SÓ o suspeito é sinalizado", () => {
  it("cria os 3 cards visíveis; nenhum é arquivado sozinho", async () => {
    const items: ProposedItem[] = [
      { tempId: "i1", type: "story", title: "Normal A", rationale: "novo" },
      { tempId: "i2", type: "story", title: "Normal B", rationale: "novo" },
      {
        tempId: "i3",
        type: "story",
        title: "Duplicata",
        rationale: "já existe",
        duplicateOf: "story-canonica",
      },
    ];

    const result = await commit({ boardId: "test-board", items });

    expect(result.ok).toBe(true);
    const calls = mockedWriteCard.mock.calls as Array<[string, Card]>;
    expect(calls).toHaveLength(3);

    const statuses = calls.map(([, c]) => c.status);
    expect(statuses.filter((s) => s === "triage")).toHaveLength(3); // os 3 VISÍVEIS
    expect(statuses.filter((s) => s === "duplicado")).toHaveLength(0); // nenhum engolido

    // a suspeita fica SÓ no card suspeito — os normais não são contaminados
    const dupCard = calls.find(([, c]) => c.title === "Duplicata")?.[1];
    expect(dupCard?.duplicateOf).toBe("story-canonica");
    expect(dupCard?.needsHumanReview).toBe(true);
    const normalA = calls.find(([, c]) => c.title === "Normal A")?.[1];
    expect(normalA?.duplicateOf).toBeFalsy();
    expect(normalA?.needsHumanReview).toBeFalsy();

    // e o aviso identifica exatamente QUAL item — senão o operador não sabe o que decidir
    if (!result.ok) throw new Error(result.error);
    const warns = result.data!.warnings.filter((w) => w.code === "duplicate-suspected");
    expect(warns).toHaveLength(1);
    expect(warns[0].tempId).toBe("i3");
  });
});

// --- SM-03: storyType routing on the planning path -------------------------
// story-sm-03-bug-routing (#31a) — a bug/chore captured via the PLANNING path
// (usm_capture/harness-story) must NOT auto-enter the build pipeline. A `bug` RESTS in
// triage pre-stamped mode:fix + a minimal bugReport (lane-prep mirroring
// triage/parse.ts:acceptRoute, satisfying the hasBugReport gate); on a human ACCEPT,
// acceptRoute then routes it mode:fix → corrigir. A `chore` is ambiguous → parked in
// triage with needsHumanReview. Both rest in triage exactly like reportIssueAction's
// free-text intake — a freshly captured bug never fires harness-fix on its own (#31a).

describe("AC-1 SM-03: storyType:bug → rests in triage (mode:fix + bugReport pre-staged)", () => {
  it("rests a captured bug in triage with mode:fix and a bugReport from the title (#31a)", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Login quebra no Safari",
      storyType: "bug",
      rationale: "regressão reportada no planejamento",
    };

    const result = await commit({ boardId: "test-board", items: [item] });

    expect(result.ok).toBe(true);
    expect(mockedWriteCard).toHaveBeenCalledOnce();
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    // #31a: a freshly captured bug must NOT auto-fire harness-fix — it rests in triage, gated by a
    // human accept (acceptRoute then routes mode:fix → corrigir). The lane-prep is pre-staged so
    // the later accept is a clean status move.
    expect(written.status).toBe("triage");
    expect(written.mode).toBe("fix");
    expect(written.storyType).toBe("bug");
    expect(written.bugReport?.brief).toBe("Login quebra no Safari");
    expect(written.bugReport?.severity).toBe("medium");
    expect(written.bugReport?.openedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("never auto-enters the build pipeline (not corrigir, not enriquecer, not interview) — it waits in triage (#31a)", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Botão de pagar não responde",
      storyType: "bug",
      rationale: "quebrou em produção",
    };

    await commit({ boardId: "test-board", items: [item] });

    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.status).toBe("triage");
    expect(written.status).not.toBe("corrigir");
    expect(written.status).not.toBe("enriquecer");
    expect(written.status).not.toBe("interview");
  });
});

describe("AC-2 SM-03: storyType:chore → triage parked for human review", () => {
  it("keeps a chore in triage with needsHumanReview:true and no fix mode", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Atualizar deps do storymap-ui",
      storyType: "chore",
      rationale: "manutenção técnica",
    };

    const result = await commit({ boardId: "test-board", items: [item] });

    expect(result.ok).toBe(true);
    expect(mockedWriteCard).toHaveBeenCalledOnce();
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.status).toBe("triage");
    expect(written.needsHumanReview).toBe(true);
    expect(written.mode).toBeUndefined();
    expect(written.bugReport == null).toBe(true);
  });
});

describe("SM-03 regression: a feature story is untouched by the routing branch", () => {
  it("still lands a user story in triage with no mode/bugReport/needsHumanReview", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Ver eventos no feed",
      storyType: "user",
      rationale: "feature de backbone",
    };

    await commit({ boardId: "test-board", items: [item] });

    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.status).toBe("triage");
    expect(written.mode).toBeUndefined();
    expect(written.bugReport == null).toBe(true);
    expect(written.needsHumanReview).toBeFalsy();
  });
});

// REESCRITO com o AC-1: a suspeita de duplicata deixou de ser um `continue` que atropelava a rota do bug.
// Agora ela COMPÕE com ela — o bug suspeito repousa na Triagem com mode:fix + bugReport (como qualquer bug
// capturado, que nunca entra sozinho no pipeline) E carregando a suspeita. O humano decide: aceitar (→ corrigir)
// ou marcar duplicado. Antes o card era arquivado e a rota de bug era simplesmente descartada.
describe("SM-03: um bug suspeito de duplicata compõe as duas coisas — repousa na Triagem, sinalizado", () => {
  it("fica em `triage` com mode:fix + bugReport E a suspeita — nunca arquivado sozinho", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Login quebra no Safari (já reportado)",
      storyType: "bug",
      rationale: "mesma regressão de um card existente",
      duplicateOf: "story-canonica",
    };

    await commit({ boardId: "test-board", items: [item] });

    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.status).toBe("triage"); // e NÃO "duplicado" (o sistema não decide) nem "corrigir" (bug não auto-entra)
    expect(written.duplicateOf).toBe("story-canonica"); // a suspeita sobrevive
    expect(written.needsHumanReview).toBe(true);
    expect(written.mode).toBe("fix"); // a rota de bug não é mais descartada pela dedup
    expect(written.bugReport).toBeTruthy();
  });
});

// --- SM-02: orphan-story hierarchy gate (unplaced auto-routing) -------------
// story-sm-02-orphan-gate — commitProposalAction is the single write path for
// create_card AND usm_capture(apply). A story landing with parent:null must NOT
// be minted as a silent orphan (invisible no mapa); it gets unplaced:true
// so it renders in the "Backlog não-mapeado" lane. A parented story is untouched.

describe("hierarquia: o commit RECUSA item sem âncora — não existe mais 'backlog não-mapeado'", () => {
  it("TOLERA a story sem âncora — ela nasce na QUARENTENA, que é o que a Triagem É", async () => {
    // A guarda do lote cobra o que a INVARIANTE cobra, nem mais: o card capturado nasce no status de
    // entrada (a lane `staging`), e ali ficar sem lugar é legítimo — a âncora é exigida para SAIR.
    // Cobrar aqui era ser mais estrito que a invariante, e foi o que quebrou a captura de bug.
    const item: ProposedItem = { tempId: "i1", type: "story", title: "Story solta", rationale: "sem pai" };
    const result = await commitProposalAction({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.parent).toBeNull();
  });

  it("aceita a story ancorada num STEP existente", async () => {
    const item: ProposedItem = { tempId: "i1", type: "story", title: "Story parenteada", parent: "step-base", rationale: "tem pai" };
    const result = await commitProposalAction({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.parent).toBe("step-base");
    expect(written.unplaced).toBeUndefined();
  });

  it("recusa a user story pendurada numa ACTIVITY — ela pula o passo (as 9 do censo)", async () => {
    const item: ProposedItem = { tempId: "i1", type: "story", title: "Pulou o passo", parent: "act-base", rationale: "x" };
    const result = await commitProposalAction({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/não é um passo/);
  });

  it("recusa a ENTREGA pendurada num step — ela precisa da story base (as 32 do censo)", async () => {
    const item: ProposedItem = { tempId: "i1", type: "story", storyType: "technical", title: "Entrega solta", parent: "step-base", rationale: "x" };
    const result = await commitProposalAction({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/não é uma user story/);
  });
});

describe("SM-03 guard: the isStory guard keeps a non-story type out of the bug/chore routing", () => {
  it("does not route a malformed activity tagged storyType:bug into corrigir (storyType is stories-only)", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "activity",
      title: "Atividade marcada como bug por engano",
      storyType: "bug",
      rationale: "tipo inválido para storyType",
    };

    await commit({ boardId: "test-board", items: [item] });

    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.status).toBe("triage");
    expect(written.storyType).toBeNull();
    expect(written.mode).toBeUndefined();
    expect(written.bugReport == null).toBe(true);
    expect(written.needsHumanReview).toBeFalsy();
  });
});

// --- createCardAction é o caminho de escrita do "+ Novo item" da UI --------------------------
// O draft do makeDraftCard nasce com parent:null. Antes ele era desviado para o "backlog não-mapeado"
// (unplaced:true); hoje o card sem âncora não é representável, então quem grava é quem decide o pai —
// o desvio sumiu e a recusa vem do chokepoint de escrita.
describe("createCardAction: o draft sem âncora não vira mais órfão", () => {
  const draftStory = (over: Partial<Card>): Card => ({
    id: "story-novo",
    type: "story",
    title: "Novo item",
    storyType: "user",
    status: "triage",
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    narrative: { role: null, want: null, soThat: null },
    acceptance: [],
    tasks: [],
    rice: { reach: null, impact: null, confidence: null, effort: null },
    kano: null,
    funnelStage: null,
    findings: [],
    created: null,
    updated: null,
    order: 10,
    body: "",
    ...over,
  });

  it("não carimba mais `unplaced` — o campo deixou de ser cunhado", async () => {
    const res = await createCardAction({ boardId: "test-board", card: draftStory({ parent: null }) });
    expect(res.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.unplaced).toBeUndefined();
  });

  it("preserva o pai quando o draft já vem ancorado", async () => {
    const res = await createCardAction({ boardId: "test-board", card: draftStory({ parent: "step-base" }) });
    expect(res.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.parent).toBe("step-base");
    expect(written.unplaced).toBeUndefined();
  });

  it("uma activity sem pai é raiz VÁLIDA — segue passando", async () => {
    const res = await createCardAction({
      boardId: "test-board",
      card: draftStory({ id: "act-raiz", type: "activity", storyType: null, parent: null }),
    });
    expect(res.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.unplaced).toBeUndefined();
  });
});

// --- WS-9 (D15): a captured IDEA is NEVER materialized (the ◆ mint is barred at accept) ----------
// Decisão do Operador (ADR-064): a captura estruturada não cunha ideia — ◆ nasce só na bancada. O
// guard (guardCaptureIdeas) IGNORA um item type:"idea" com um warning apontando a bancada;
// nunca lança (retrocompat com sidecars ◆ legados). Só o MATERIALIZAR é barrado — o parse do ◆ continua.
describe("WS-9: a captured idea ◆ does NOT materialize (barred at accept, warned)", () => {
  it("does NOT write a card for a type:idea item — emits an idea-ignored warning instead", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "idea",
      title: "Operador não consegue dirigir o sistema top-down",
      rationale: "dor recorrente",
      body: "8 de 10 sessões o operador editou cards à mão",
    };
    const result = await commit({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(true);
    // no card minted for the ◆ (it was the only item) …
    const wroteIdea = mockedWriteCard.mock.calls.some(([, c]) => (c as Card).type === "idea");
    expect(wroteIdea).toBe(false);
    expect(mockedWriteCard).not.toHaveBeenCalled();
    // … and the human gets a warning pointing at the bench.
    if (!result.ok) throw new Error("expected ok");
    const w = result.data?.warnings ?? [];
    expect(w).toContainEqual(expect.objectContaining({ tempId: "i1", code: "idea-ignored" }));
    expect(w[0].detail).toMatch(/bancada de Ideias/i);
  });

  it("materializes the OTHER items of the batch; only the ◆ is dropped", async () => {
    const items: ProposedItem[] = [
      { tempId: "i1", type: "idea", title: "Dor crua", rationale: "r" },
      { tempId: "i2", type: "story", title: "Trabalho concreto", rationale: "r", parent: "step-base" },
    ];
    const result = await commit({ boardId: "test-board", items });
    expect(result.ok).toBe(true);
    const written = mockedWriteCard.mock.calls.map(([, c]) => c as Card);
    expect(written).toHaveLength(1);
    expect(written[0].type).toBe("story");
    expect(written[0].title).toBe("Trabalho concreto");
    if (!result.ok) throw new Error("expected ok");
    expect(result.data?.warnings).toContainEqual(
      expect.objectContaining({ tempId: "i1", code: "idea-ignored" }),
    );
  });

  it("NEVER throws on a legacy ◆ carrying the full OST-light block (retrocompat) — just ignores it", async () => {
    const item: ProposedItem = {
      tempId: "i1", type: "idea", title: "Dor rica", rationale: "r", body: "evidência",
      candidateSolutions: ["sol A", "sol B"], keyAssumption: "premissa", successSignal: "sinal",
      valueSize: { reach: 500, impact: 3 },
    };
    const result = await commit({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(true);
    expect(mockedWriteCard).not.toHaveBeenCalled();
  });
});

// --- Fatia 3B: a SCOPED capture tags created stories with an `addresses` edge -----------
// generateTasksForIdeaAction scopes the container to an idea; acceptProposalAction
// reads that and passes addressesIdeaId here, so every created STORY traces UP to the pain.
describe("Fatia 3B: addressesIdeaId → created stories trace UP to the idea", () => {
  it("adds an addresses edge to each created STORY when scoped", async () => {
    const items: ProposedItem[] = [
      { tempId: "i1", type: "story", title: "Story A", rationale: "r" },
      { tempId: "i2", type: "story", title: "Story B", rationale: "r" },
    ];
    await commit({ boardId: "test-board", items, addressesIdeaId: "idea-dor-x" });
    const calls = mockedWriteCard.mock.calls as Array<[string, Card]>;
    expect(calls).toHaveLength(2);
    for (const [, c] of calls) {
      expect(c.links).toContainEqual({ rel: "addresses", to: "idea-dor-x" });
    }
  });

  it("does NOT add the edge to a non-story (backbone) item even when scoped", async () => {
    const items: ProposedItem[] = [{ tempId: "i1", type: "activity", title: "Atividade", rationale: "r" }];
    await commit({ boardId: "test-board", items, addressesIdeaId: "idea-dor-x" });
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.links).toEqual([]);
  });

  it("adds no edge when unscoped (a plain free-text capture)", async () => {
    const items: ProposedItem[] = [{ tempId: "i1", type: "story", title: "Story", rationale: "r" }];
    await commit({ boardId: "test-board", items });
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.links).toEqual([]);
  });
});

// --- WS-9: an in-batch ◆ is never minted, so a story that `addresses` it loses the in-batch edge --------
// Post-WS-9 the classification prompt no longer emits ◆, but a LEGACY sidecar may still carry an in-batch
// idea + a story addressing it. The guard ignores the ◆ (→ warning), and the story's `addresses` to
// that ◆ can't resolve (the target is never minted) — it's cleared UP FRONT so it can't hang the readiness
// loop. The batch-level addressesIdeaId path (an EXTERNAL, already-existing idea) is unaffected.
describe("WS-9: per-item `addresses` to an in-batch ◆ (which is now barred) is dropped, not hung", () => {
  it("ignores the in-batch ◆ and creates the story WITHOUT the in-batch addresses edge", async () => {
    const items: ProposedItem[] = [
      { tempId: "i1", type: "idea", title: "A dor", rationale: "r" },
      { tempId: "i2", type: "story", title: "A solução", rationale: "r", parent: "step-base", addresses: "i1" },
    ];
    const result = await commit({ boardId: "test-board", items });
    expect(result.ok).toBe(true);
    const calls = mockedWriteCard.mock.calls as Array<[string, Card]>;
    // ◆ not minted; only the story is written …
    expect(calls.some(([, c]) => c.type === "idea")).toBe(false);
    const story = calls.find(([, c]) => c.type === "story")![1];
    // … and it has NO addresses edge (the in-batch ◆ never resolved) — no forced-created noise either.
    expect(story.links).toEqual([]);
    if (!result.ok) throw new Error("expected ok");
    const warnings = result.data?.warnings ?? [];
    expect(warnings).toContainEqual(expect.objectContaining({ tempId: "i1", code: "idea-ignored" }));
    expect(warnings.some((w) => w.code === "forced-created")).toBe(false);
  });

  it("falls back to the batch-level addressesIdeaId when the story has no per-item addresses", async () => {
    const items: ProposedItem[] = [{ tempId: "i1", type: "story", title: "Solução", rationale: "r" }];
    await commit({ boardId: "test-board", items, addressesIdeaId: "idea-global" });
    const [, story] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(story.links).toContainEqual({ rel: "addresses", to: "idea-global" });
  });

  it("KIND-GUARD: drops a per-item addresses that points at a NON-idea card (story-canonica is a story)", async () => {
    const items: ProposedItem[] = [
      { tempId: "i1", type: "story", title: "Endereça alvo errado", rationale: "r", addresses: "story-canonica" },
    ];
    await commit({ boardId: "test-board", items });
    const [, story] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(story.links).toEqual([]); // story-canonica is type:story, not an idea → no addresses edge
  });
});

// --- setCardLinksAction: graph CRUD guarded by validateLink ----------------------------
describe("setCardLinksAction: link an EXISTING story to its idea, validated", () => {
  const linkBoard: BoardConfig = {
    ...board,
    linkTypes: [{ id: "addresses", name: "Endereça", from: ["story"], to: ["idea"] }],
  };
  const oppCard: Card = { ...existingCard, id: "idea-dor", type: "idea", title: "Dor", storyType: null, status: null };
  const storyCard: Card = { ...existingCard, id: "story-sol", type: "story", title: "Solução" };

  beforeEach(() => {
    mockedReadBoardConfig.mockResolvedValue(linkBoard);
    mockedReadCards.mockResolvedValue([oppCard, storyCard]);
    mockedUpdateCardOnDisk.mockImplementation(async (_b, _id, fn) => fn(storyCard) ?? null);
  });

  it("writes a valid story→idea addresses edge", async () => {
    const r = await setCardLinksAction({ boardId: "test-board", cardId: "story-sol", links: [{ rel: "addresses", to: "idea-dor" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data?.card.links).toEqual([{ rel: "addresses", to: "idea-dor" }]);
  });

  it("rejects an unknown rel and writes nothing", async () => {
    const r = await setCardLinksAction({ boardId: "test-board", cardId: "story-sol", links: [{ rel: "inexistente", to: "idea-dor" }] });
    expect(r.ok).toBe(false);
    expect(mockedUpdateCardOnDisk).not.toHaveBeenCalled();
  });

  it("rejects a missing target and writes nothing", async () => {
    const r = await setCardLinksAction({ boardId: "test-board", cardId: "story-sol", links: [{ rel: "addresses", to: "fantasma" }] });
    expect(r.ok).toBe(false);
    expect(mockedUpdateCardOnDisk).not.toHaveBeenCalled();
  });

  it("rejects inverted ends (idea→story is not a valid addresses edge)", async () => {
    const r = await setCardLinksAction({ boardId: "test-board", cardId: "idea-dor", links: [{ rel: "addresses", to: "story-sol" }] });
    expect(r.ok).toBe(false);
  });
});

// --- story-cl1mi9: pasted context images survive the capture → bug card -----------------
// The smart-capture modal lets the operator paste up to 4 context images (ctrl+v). They rode
// to proposeCardsAction for vision, then were DROPPED at commit: the images never reached
// commitProposalAction and the bug branch hardcoded screenshot:null, so the card landed with
// no visual evidence. commitProposalAction now accepts the attached `images` and, for a
// captured BUG, persists them to the sidecar (writeBugScreenshots) and records the returned
// filenames on bugReport.screenshots (additive — the single `screenshot` stays for reopen).
describe("story-cl1mi9: captured bug retains pasted context images as bugReport.screenshots", () => {
  const IMAGES: CaptureImageInput[] = [
    { name: "ctx-1.png", dataUrl: "data:image/png;base64,AAAA" },
    { name: "ctx-2.png", dataUrl: "data:image/png;base64,BBBB" },
    { name: "ctx-3.png", dataUrl: "data:image/png;base64,CCCC" },
  ];

  it("persists the attached images and sets bugReport.screenshots on the captured bug card", async () => {
    mockedWriteBugScreenshots.mockResolvedValue(["context-1.png", "context-2.png", "context-3.png"]);
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Imagens coladas somem no card",
      storyType: "bug",
      rationale: "regressão com evidência visual",
    };

    const result = await commit({ boardId: "test-board", items: [item], images: IMAGES });

    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    // the primary single-screenshot field stays null (reopen flow / retrocompat) …
    expect(written.bugReport?.screenshot).toBeNull();
    // … and the multi-image evidence lands on the additive array.
    expect(written.bugReport?.screenshots).toEqual(["context-1.png", "context-2.png", "context-3.png"]);
    // persisted to the sidecar under the MINTED card id, from the image data URLs.
    expect(mockedWriteBugScreenshots).toHaveBeenCalledWith("test-board", written.id, [
      "data:image/png;base64,AAAA",
      "data:image/png;base64,BBBB",
      "data:image/png;base64,CCCC",
    ]);
  });

  it("does NOT persist or set screenshots when no images are attached (retrocompat)", async () => {
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Bug sem print",
      storyType: "bug",
      rationale: "sem evidência visual",
    };

    await commit({ boardId: "test-board", items: [item] });

    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.bugReport?.screenshot).toBeNull();
    expect(written.bugReport?.screenshots ?? []).toEqual([]);
    expect(mockedWriteBugScreenshots).not.toHaveBeenCalled();
  });

  it("ignores attached images for a NON-bug captured item (screenshots is bug-only)", async () => {
    mockedWriteBugScreenshots.mockResolvedValue(["context-1.png"]);
    const item: ProposedItem = {
      tempId: "i1",
      type: "story",
      title: "Uma feature qualquer",
      storyType: "user",
      rationale: "não é bug",
    };

    await commit({ boardId: "test-board", items: [item], images: IMAGES });

    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.bugReport == null).toBe(true);
    expect(mockedWriteBugScreenshots).not.toHaveBeenCalled();
  });
});

// WS6 (F5) — provenance (`via`) + structured degradation warnings.
describe("WS6: via provenance + structured warnings", () => {
  it("stamps via='capture' by default on every created card", async () => {
    const item: ProposedItem = { tempId: "i1", type: "story", title: "Nova", rationale: "x" };
    const result = await commit({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.via).toBe("capture");
  });

  it("honors an explicit via (create_card passes 'mcp')", async () => {
    const item: ProposedItem = { tempId: "i1", type: "story", title: "Via MCP", rationale: "x" };
    await commit({ boardId: "test-board", via: "mcp", items: [item] });
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.via).toBe("mcp");
  });

  it("um parent DANGLING recusa o lote — antes degradava para órfão com ack de sistema", async () => {
    const item: ProposedItem = { tempId: "i1", type: "story", title: "Órfã", rationale: "x", parent: "ghost-parent" };
    // Antes: "tentou e errou o id" degradava (unplaced + ack sistêmico + warning), para não derrubar o lote
    // inteiro por um typo do LLM. Com a invariante, esse card não é gravável — deixá-lo nascer só adiaria o
    // erro para a escrita, com metade do lote já criada. Recusa atômica, dizendo QUAL id não resolveu.
    const result = await commitProposalAction({ boardId: "test-board", items: [item] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("ghost-parent");
    expect(mockedWriteCard).not.toHaveBeenCalled();
  });
});

// WS7 (F6) — intake consolidation: an umbrella proposal with tasks → 1 card with N Card.tasks (done:false).
describe("WS7: pre-seeded tasks (umbrella card consolidation)", () => {
  it("maps ProposedItem.tasks → Card.tasks with done:false (gate hasTasks satisfied downstream)", async () => {
    const item: ProposedItem = {
      tempId: "i1", type: "story", title: "Refatorar módulo X", rationale: "3 ajustes na mesma superfície",
      tasks: [{ title: "renomear A" }, { id: "custom", title: "mover B" }, { title: "extrair C" }],
    };
    await commit({ boardId: "test-board", items: [item] });
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.tasks).toHaveLength(3);
    expect(written.tasks.every((t) => t.done === false)).toBe(true);
    expect(written.tasks[0].id).toBe("t1"); // generated
    expect(written.tasks[1].id).toBe("custom"); // preserved
    expect(written.tasks.map((t) => t.title)).toEqual(["renomear A", "mover B", "extrair C"]);
  });

  it("drops empty-title tasks; a non-story item ignores tasks", async () => {
    const item: ProposedItem = {
      tempId: "i1", type: "story", title: "X", rationale: "r", tasks: [{ title: "ok" }, { title: "  " }],
    };
    await commit({ boardId: "test-board", items: [item] });
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.tasks).toHaveLength(1);
  });

  it("1.6 — dedupes ids: an explicit id colliding with a `t{n}` fallback is renumbered (no duplicate ids)", async () => {
    const item: ProposedItem = {
      tempId: "i1", type: "story", title: "X", rationale: "r",
      // task0 explicitly claims "t2"; task1 has no id → its `t{idx+1}` fallback would ALSO be "t2" (collision).
      tasks: [{ id: "t2", title: "A" }, { title: "B" }],
    };
    await commit({ boardId: "test-board", items: [item] });
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    const ids = written.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique — no collision
    expect(ids).toContain("t2"); // the explicit id is kept
    expect(written.tasks.map((t) => t.title)).toEqual(["A", "B"]);
  });
});

// ── "NENHUM ITEM NASCE SEM LUGAR NO MAPA" (decisão do operador, 2026-07-13) ─────────────────────────────
//
// A política já existia — mas só dentro do `create_card` do MCP. A CAPTURA (modal + usm_capture mode:apply)
// chamava commitProposalAction DIRETO e passava batido: a story órfã era criada em silêncio com `unplaced:
// true` e nenhum aceite, e a decisão de "sem lugar" era empurrada para o pior momento possível — lá adiante,
// quando o gate hasPlacement travasse o card no plano-tecnico e o humano tivesse que ir caçá-lo no drawer.
// Mesma classe do ramo de duplicata: política num caminho, caminho paralelo furando.
//
// A guarda agora mora no CHOKEPOINT de escrita, então todo caller a herda. Escape: `ackUnplaced` — impossível
// por acidente, possível por decisão.
describe("placement: a guarda do lote cobra a INVARIANTE, nem mais nem menos", () => {
  const orfa: ProposedItem = { tempId: "i1", type: "story", title: "Story órfã", rationale: "sem lugar" };

  it("TOLERA a story sem parent nem serves — ela nasce na quarentena (Triagem)", async () => {
    const result = await commitProposalAction({ boardId: "test-board", items: [orfa] });
    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.parent).toBeNull();
  });

  it("RECUSA a âncora QUEBRADA mesmo na quarentena — é dado corrompido, não decisão adiada", async () => {
    const result = await commitProposalAction({
      boardId: "test-board",
      items: [{ ...orfa, parent: "step-fantasma" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("deveria ter recusado");
    expect(result.error).toContain("step-fantasma");
    expect(mockedWriteCard).not.toHaveBeenCalled(); // fail-closed: zero escrita parcial
  });

  it("o erro oferece CANDIDATOS (o humano precisa saber onde encaixar)", async () => {
    mockedReadCards.mockResolvedValue([
      existingCard,
      ...BACKBONE,
      { ...existingCard, id: "step-feed", type: "step", title: "Ver o feed", storyType: null } as Card,
    ]);
    const result = await commitProposalAction({
      boardId: "test-board",
      items: [{ ...orfa, parent: "step-fantasma" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("deveria ter recusado");
    expect(result.error).toContain("step-feed");
  });

  it("ACEITA quando o parent é um step EXISTENTE do board", async () => {
    mockedReadCards.mockResolvedValue([
      existingCard,
      { ...existingCard, id: "step-feed", type: "step", title: "Ver o feed" } as Card,
    ]);
    const result = await commitProposalAction({
      boardId: "test-board",
      items: [{ ...orfa, parent: "step-feed" }],
    });

    expect(result.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.parent).toBe("step-feed");
    expect(written.unplaced).toBeFalsy();
  });

  // O CAMINHO QUE O OPERADOR ESCOLHEU: se nenhum step serve, o agente PROPÕE o backbone no mesmo lote e
  // pendura as stories nele pelo tempId. Sem isto, a regra "nunca sem lugar" travaria toda captura de tema novo.
  it("ACEITA um backbone PROPOSTO no mesmo lote — o parent resolve por tempId", async () => {
    const items: ProposedItem[] = [
      { tempId: "a1", type: "activity", title: "Chegar no app", rationale: "área nova" },
      { tempId: "s1", type: "step", title: "Chegar na home", rationale: "área nova", parent: "a1" },
      { tempId: "i1", type: "story", title: "Ver saudação direta", rationale: "…", parent: "s1" },
    ];

    const result = await commitProposalAction({ boardId: "test-board", items });

    expect(result.ok).toBe(true);
    const calls = mockedWriteCard.mock.calls as Array<[string, Card]>;
    const step = calls.find(([, c]) => c.type === "step")![1];
    const story = calls.find(([, c]) => c.type === "story")![1];
    expect(story.parent).toBe(step.id); // pendurada no step recém-criado, não órfã
    expect(story.unplaced).toBeFalsy();
  });

  it("backbone (activity/step) e idea NÃO precisam de parent — só story pendura", async () => {
    const items: ProposedItem[] = [
      { tempId: "a1", type: "activity", title: "Descobrir eventos", rationale: "topo" },
      { tempId: "o1", type: "idea", title: "Usuário não acha nada", rationale: "dor" },
    ];

    const result = await commitProposalAction({ boardId: "test-board", items });
    expect(result.ok).toBe(true); // não é recusado por falta de lugar
  });

  it("`serves` só ancora ENTREGA — numa user story ele não conta como lugar", async () => {
    mockedReadCards.mockResolvedValue([existingCard, ...BACKBONE]); // story-canonica é a user story servida

    const entrega = await commitProposalAction({
      boardId: "test-board",
      items: [{ ...orfa, storyType: "technical", serves: "story-canonica" }],
    });
    expect(entrega.ok).toBe(true); // entrega se pendura pelo serves

    vi.clearAllMocks();
    mockedReadBoardConfig.mockResolvedValue(board);
    mockedReadCards.mockResolvedValue([existingCard, ...BACKBONE]);
    mockedWriteCard.mockResolvedValue(undefined);

    const userStory = await commitProposalAction({
      boardId: "test-board",
      items: [{ ...orfa, storyType: "user", serves: "story-canonica" }],
    });
    // o commit DESCARTA serves de uma user story → ela fica SEM âncora, e como nasce na quarentena
    // isso é tolerado; o que NÃO acontece é o serves virar o lugar dela.
    expect(userStory.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.serves).toBeUndefined();
    expect(written.parent).toBeNull();
  });
});

describe("placement: ciclo na hierarquia é RECUSADO — nem com aceite (é proposta malformada, não decisão)", () => {
  it("recusa um ciclo direto (a → b → a) sem escrever nada", async () => {
    const items: ProposedItem[] = [
      { tempId: "a", type: "step", title: "Passo A", rationale: "x", parent: "b" },
      { tempId: "b", type: "step", title: "Passo B", rationale: "x", parent: "a" },
    ];

    const result = await commitProposalAction({ boardId: "test-board", items });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("deveria ter recusado");
    expect(result.error).toContain("circular");
    expect(mockedWriteCard).not.toHaveBeenCalled(); // fail-closed: zero escrita parcial
  });

  it("um ciclo é recusado — é proposta malformada, não decisão de lugar", async () => {
    const items: ProposedItem[] = [
      { tempId: "a", type: "story", title: "Story A", rationale: "x", parent: "b" },
      { tempId: "b", type: "step", title: "Passo B", rationale: "x", parent: "a" },
    ];

    const result = await commitProposalAction({ boardId: "test-board", items });

    expect(result.ok).toBe(false);
    expect(mockedWriteCard).not.toHaveBeenCalled();
  });

  it("uma hierarquia ACÍCLICA legítima (step → story) segue passando", async () => {
    const items: ProposedItem[] = [
      { tempId: "a1", type: "activity", title: "Usar o app", rationale: "x" },
      { tempId: "s1", type: "step", title: "Chegar na home", rationale: "área nova", parent: "a1" },
      { tempId: "i1", type: "story", title: "Ver saudação", rationale: "x", parent: "s1" },
    ];

    const result = await commitProposalAction({ boardId: "test-board", items });
    expect(result.ok).toBe(true);
  });
});

// --- WS-9: guardCaptureIdeas (pure) — the belt-and-suspenders split at accept -----------
describe("guardCaptureIdeas (WS-9): bars ◆ from materializing, links kept clean", () => {
  const story = (over: Partial<ProposedItem> & { tempId: string }): ProposedItem => ({
    type: "story",
    title: "T",
    rationale: "r",
    ...over,
  });

  it("passes a batch through UNTOUCHED when there is no ◆ (identity, same reference)", () => {
    const items = [story({ tempId: "i1" }), story({ tempId: "i2" })];
    const out = guardCaptureIdeas(items);
    expect(out.warnings).toEqual([]);
    expect(out.items).toBe(items); // no allocation on the happy path
  });

  it("removes every ◆ and emits one idea-ignored warning per ◆ (with the bench detail)", () => {
    const items: ProposedItem[] = [
      { tempId: "o1", type: "idea", title: "Dor A", rationale: "r" },
      story({ tempId: "i1" }),
      { tempId: "o2", type: "idea", title: "Dor B", rationale: "r" },
    ];
    const out = guardCaptureIdeas(items);
    expect(out.items.map((i) => i.tempId)).toEqual(["i1"]);
    expect(out.warnings).toEqual([
      { tempId: "o1", code: "idea-ignored", detail: expect.stringMatching(/bancada de Ideias/i) },
      { tempId: "o2", code: "idea-ignored", detail: expect.stringMatching(/bancada de Ideias/i) },
    ]);
  });

  it("clears a story `addresses` that points at an in-batch ◆ (the ◆ is barred → can't resolve)", () => {
    const items: ProposedItem[] = [
      { tempId: "o1", type: "idea", title: "Dor", rationale: "r" },
      story({ tempId: "i1", addresses: "o1" }),
    ];
    const out = guardCaptureIdeas(items);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].addresses).toBeNull();
  });

  it("KEEPS a story `addresses` that points at an EXTERNAL (not-in-batch) idea id", () => {
    const items: ProposedItem[] = [
      { tempId: "o1", type: "idea", title: "Dor", rationale: "r" },
      story({ tempId: "i1", addresses: "idea-existente" }),
    ];
    const out = guardCaptureIdeas(items);
    expect(out.items[0].addresses).toBe("idea-existente");
  });
});

// A revisão humana não pode ser cobrada duas vezes. A modal de captura e o aceite do Inbox SÃO a
// tela de revisão — o operador viu tipo, confiança e duplicata, pôde reclassificar, e confirmou.
// Antes, todo chore capturado à mão nascia com `needsHumanReview` e gerava um item de Inbox
// pedindo exatamente o que o operador acabara de fazer.
describe("needsHumanReview: só para o que chegou SEM ninguém olhar", () => {
  const chore: ProposedItem = {
    tempId: "i1",
    type: "story",
    storyType: "chore",
    title: "Reagrupar a agenda por dia",
    rationale: "manutenção da mesma tela",
    parent: existingCard.id,
  };

  it("commit REVISADO por humano não carimba a flag", async () => {
    const r = await commitProposalAction({ boardId: "test-board", items: [chore], humanReviewed: true });
    expect(r.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.needsHumanReview).toBeUndefined();
  });

  it("commit SEM revisão humana (lote aplicado por agente) segue carimbando", async () => {
    const r = await commitProposalAction({ boardId: "test-board", items: [chore] });
    expect(r.ok).toBe(true);
    const [, written] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(written.needsHumanReview).toBe(true);
  });

  it("a SUSPEITA de duplicata viaja sempre; a COBRANÇA só sem revisão humana", async () => {
    // user story ancora num PASSO (o chore acima ancora na story base) — a hierarquia manda em tudo
    const dup: ProposedItem = { ...chore, storyType: "user", parent: existingStep.id, duplicateOf: existingCard.id };

    const revisado = await commitProposalAction({ boardId: "test-board", items: [dup], humanReviewed: true });
    expect(revisado.ok).toBe(true);
    const [, a] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(a.duplicateOf).toBe(existingCard.id); // o badge "Dup · X" continua
    expect(a.needsHumanReview).toBeUndefined(); // mas não pede revisão de novo

    vi.clearAllMocks();
    mockedReadBoardConfig.mockResolvedValue(board);
    mockedReadCards.mockResolvedValue([existingCard, ...BACKBONE]);
    mockedWriteCard.mockResolvedValue(undefined);

    const cru = await commitProposalAction({ boardId: "test-board", items: [dup] });
    expect(cru.ok).toBe(true);
    const [, b] = mockedWriteCard.mock.calls[0] as [string, Card];
    expect(b.needsHumanReview).toBe(true);
  });
});
