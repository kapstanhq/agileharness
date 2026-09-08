import { describe, expect, it } from "vitest";
import {
  commitIdeaDoc,
  ideaSectionAnchors,
  projectIdeaDoc,
  IDEA_DOC_TYPE,
  IDEA_SECTIONS,
  STATEMENT_BINDING,
} from "./idea-doc";
import { reattachBindings, reattachSections, type DocBlock, type DocModel } from "./doc-model";
import { parseDocMd, serializeDocMd } from "./md-codec";
import type { Card, IdeaFields } from "../types";

function idea(fields: Partial<IdeaFields> = {}, card: Partial<Card> = {}): Card {
  return {
    id: "idea-x",
    type: "idea",
    title: "O selo perde o significado",
    storyType: null,
    status: null,
    parent: null,
    release: null,
    personas: [],
    systems: [],
    links: [],
    acceptance: [],
    tasks: [],
    labels: [],
    body: "",
    order: 0,
    idea: {
      statement: "O selo 'Pra você' aparece em quase todo card e deixa de significar algo.",
      evidence: "3 usuários no suporte disseram que ignoram o selo.",
      status: "exploring",
      ...fields,
    },
    ...card,
  } as unknown as Card;
}

/** Os filhos da seção ligada ao `binding` dado (containment estrutural). */
function runAfter(model: DocModel, binding: string): DocBlock[] {
  const section = model.blocks.find((b) => b.kind === "section" && b.binding === binding);
  return section && section.kind === "section" ? section.body : [];
}

function hasSection(model: DocModel, binding: string): boolean {
  return model.blocks.some((b) => b.kind === "section" && b.binding === binding);
}

describe("idea-doc — projeção", () => {
  it("projeta o enunciado como seção hero WRITE-bound", () => {
    const model = projectIdeaDoc(idea());
    const hero = model.blocks.find((b) => b.kind === "section" && b.binding === STATEMENT_BINDING);
    expect(hero).toBeTruthy();
    expect(JSON.stringify(hero)).toContain("deixa de significar algo");
  });

  it("projeta cada campo OST na sua seção ancorada, e OMITE as vazias", () => {
    const model = projectIdeaDoc(idea({ keyAssumption: "Se o selo for raro, ele volta a ser lido." }));
    expect(runAfter(model, "idea.evidence").length).toBe(1);
    expect(runAfter(model, "idea.keyAssumption").length).toBe(1);
    // successSignal e candidateSolutions estão ausentes → nenhuma caixa fantasma.
    expect(hasSection(model, "idea.successSignal")).toBe(false);
    expect(hasSection(model, "idea.candidateSolutions")).toBe(false);
  });

  it("projeta candidateSolutions como bullets", () => {
    const model = projectIdeaDoc(idea({ candidateSolutions: ["Limitar a 3 por lista", "Trocar por ordenação"] }));
    const run = runAfter(model, "idea.candidateSolutions");
    expect(run.map((b) => b.kind)).toEqual(["bullet", "bullet"]);
  });

  it("mostra o motivo do descarte como PROPRIEDADE (não some no meio do texto)", () => {
    const model = projectIdeaDoc(idea({ status: "discarded", discardReason: "O selo sai inteiro na v2." }));
    const props = model.blocks.find((b) => b.kind === "properties");
    expect(JSON.stringify(props)).toContain("O selo sai inteiro na v2.");
  });
});

describe("idea-doc — andaime do enunciado (scaffold)", () => {
  it("ideia recém-criada (só título) abre com a caixa do enunciado ABERTA", () => {
    const card = idea({ statement: "", evidence: null });
    expect(hasSection(projectIdeaDoc(card), STATEMENT_BINDING)).toBe(false); // leitura: sem ruído
    const editing = projectIdeaDoc(card, { scaffold: true });
    expect(hasSection(editing, STATEMENT_BINDING)).toBe(true); // edição: onde escrever
    // …e com um parágrafo vazio DENTRO: sem filho, a caixa é decorativa (o bloco `section` não tem
    // conteúdo próprio, então o cursor não tem onde pousar e digitar não escreve nada).
    expect(runAfter(editing, STATEMENT_BINDING)).toEqual([
      { kind: "paragraph", id: expect.any(String), text: "" },
    ]);
  });

  it("o andaime NÃO andaima as quatro seções opcionais (isso seria o formulário de volta)", () => {
    const model = projectIdeaDoc(idea({ evidence: null }), { scaffold: true });
    for (const s of IDEA_SECTIONS) expect(hasSection(model, s.binding)).toBe(false);
  });

  it("caixa andaimada e deixada VAZIA não grava nada (a invariante sobrevive ao andaime)", () => {
    const card = idea({ statement: "", evidence: null });
    const out = commitIdeaDoc(projectIdeaDoc(card, { scaffold: true }), card);
    expect(out.changed).toBe(false);
  });

  it("hero VAZIO nunca apaga um enunciado que já existia", () => {
    const card = idea();
    const model = projectIdeaDoc(card, { scaffold: true });
    const hero = model.blocks.find((b) => b.kind === "section" && b.binding === STATEMENT_BINDING)!;
    (hero as Extract<DocBlock, { kind: "section" }>).body = [];
    const out = commitIdeaDoc(model, card);
    expect(out.card.idea?.statement).toBe(card.idea?.statement);
  });
});

describe("idea-doc — no-op ≡ no-write (a invariante)", () => {
  it("round-trip sem edição devolve changed:false e o MESMO card", () => {
    const card = idea({
      keyAssumption: "Se o selo for raro, volta a ser lido.",
      successSignal: "Cliques no selo sobem.",
      candidateSolutions: ["Limitar a 3", "Trocar por ordenação"],
    });
    const out = commitIdeaDoc(projectIdeaDoc(card), card);
    expect(out.changed).toBe(false);
    expect(out.card.idea).toEqual(card.idea);
    expect(out.card.body).toBe(card.body);
    expect(out.card.title).toBe(card.title);
  });

  it("preserva os BYTES de um body não-canônico", () => {
    const card = idea({}, { body: "texto   com    espaçamento\n esquisito\n\n\n- item\n" });
    const out = commitIdeaDoc(projectIdeaDoc(card), card);
    expect(out.changed).toBe(false);
    expect(out.card.body).toBe(card.body);
  });

  it("round-trip de ideia MÍNIMA (só statement) não inventa campo nenhum", () => {
    const card = idea({ evidence: null });
    const out = commitIdeaDoc(projectIdeaDoc(card), card);
    expect(out.changed).toBe(false);
    expect(out.card.idea?.keyAssumption).toBeUndefined();
    expect(out.card.idea?.candidateSolutions).toBeUndefined();
  });
});

describe("idea-doc — commit de edições", () => {
  it("editar o hero grava o statement (write-bound, sem perda)", () => {
    const card = idea();
    const model = projectIdeaDoc(card);
    const hero = model.blocks.find((b) => b.kind === "section" && b.binding === STATEMENT_BINDING)!;
    (hero as Extract<DocBlock, { kind: "section" }>).body = [
      { kind: "paragraph", id: "n1", text: "Enunciado reescrito pelo autor." },
    ];
    const out = commitIdeaDoc(model, card);
    expect(out.changed).toBe(true);
    expect(out.card.idea?.statement).toBe("Enunciado reescrito pelo autor.");
  });

  it("esvaziar uma seção LIMPA o campo (distinto de a seção não existir)", () => {
    const card = idea({ keyAssumption: "premissa antiga" });
    const model = projectIdeaDoc(card);
    const section = model.blocks.find((b) => b.kind === "section" && b.binding === "idea.keyAssumption")!;
    (section as Extract<DocBlock, { kind: "section" }>).body = []; // caixa vazia, mas presente
    const out = commitIdeaDoc(model, card);
    expect(out.changed).toBe(true);
    expect(out.card.idea?.keyAssumption).toBeUndefined();
  });

  it("texto escrito FORA das seções ancoradas vira body livre", () => {
    const card = idea();
    const model = projectIdeaDoc(card);
    model.blocks.push({ kind: "paragraph", id: "z1", text: "Uma nota solta do autor." });
    const out = commitIdeaDoc(model, card);
    expect(out.changed).toBe(true);
    expect(out.card.body).toContain("Uma nota solta do autor.");
    expect(out.card.idea?.statement).toBe(card.idea?.statement);
  });

  it("um heading de MESMO RÓTULO no corpo livre não sequestra a região ligada", () => {
    const card = idea({ candidateSolutions: ["Limitar a 3"] });
    const model = projectIdeaDoc(card);
    const label = IDEA_SECTIONS.find((s) => s.binding === "idea.candidateSolutions")!.label;
    model.blocks.push({ kind: "heading", id: "z1", level: 2, text: label });
    model.blocks.push({ kind: "bullet", id: "z2", text: "item que é do corpo, não da seção" });
    const out = commitIdeaDoc(model, card);
    expect(out.card.idea?.candidateSolutions).toEqual(["Limitar a 3"]);
    expect(out.card.body).toContain("item que é do corpo");
  });

  it("uma caixa DUPLICADA (copiar/colar) não sobrescreve a primeira — vira corpo", () => {
    const card = idea({ keyAssumption: "a premissa real" });
    const model = projectIdeaDoc(card);
    model.blocks.push({
      kind: "section",
      id: "z1",
      label: "A premissa que derruba tudo se for falsa",
      tone: "neutral",
      binding: "idea.keyAssumption",
      body: [{ kind: "paragraph", id: "z2", text: "cópia acidental" }],
    });
    const out = commitIdeaDoc(model, card);
    expect(out.card.idea?.keyAssumption).toBe("a premissa real");
    expect(out.card.body).toContain("cópia acidental");
  });

  it("REGRESSÃO: uma seção ligada NÃO engole o corpo livre que vem depois dela", () => {
    // (definido abaixo do bloco de markdown para manter o par projeção⇄commit junto)
    const card = idea({ evidence: "3 usuários ignoram o selo." }, { body: "Nota longa do autor no corpo.\n" });
    const out = commitIdeaDoc(projectIdeaDoc(card), card);
    expect(out.changed).toBe(false);
    expect(out.card.idea?.evidence).toBe("3 usuários ignoram o selo.");
    expect(out.card.body).toBe(card.body);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A VISÃO MARKDOWN (DocMarkdown → parseDocMd → reattach* → commit). É o caminho mais arriscado do
// subsistema: a fonte não carrega props, então uma região ancorada só continua ancorada se o rótulo
// a reencontrar. Sem isso o texto da região cairia no corpo livre — perda silenciosa de campo.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("idea-doc — ida e volta pela fonte markdown", () => {
  /** O que a tela faz: serializa o documento, deixa editar, e devolve pelo mesmo commit. */
  function throughMarkdown(card: Card, edit: (md: string) => string = (md) => md) {
    const base = projectIdeaDoc(card);
    const anchors = [...base.blocks, ...ideaSectionAnchors()];
    const markdown = edit(serializeDocMd(base, { includeTitle: true }));
    const parsed = parseDocMd(markdown, { docType: IDEA_DOC_TYPE, stripTitle: true });
    const blocks = reattachSections(reattachBindings(parsed.blocks, anchors), anchors);
    return commitIdeaDoc({ docType: IDEA_DOC_TYPE, title: parsed.title, blocks }, card);
  }

  it("no-op ≡ no-write: abrir a fonte e não tocar em nada não muda um byte", () => {
    const card = idea(
      { keyAssumption: "Se o selo for raro, ele volta a ser lido.", candidateSolutions: ["Limitar a 3"] },
      { body: "Nota do autor.\n" },
    );
    const out = throughMarkdown(card);
    expect(out.changed).toBe(false);
    expect(out.card.idea).toEqual(card.idea);
    expect(out.card.body).toBe(card.body);
  });

  it("editar dentro de uma seção escreve no CAMPO, não no corpo", () => {
    const card = idea();
    const out = throughMarkdown(card, (md) =>
      md.replace("3 usuários no suporte disseram que ignoram o selo.", "5 usuários disseram que ignoram o selo."),
    );
    expect(out.card.idea?.evidence).toBe("5 usuários disseram que ignoram o selo.");
    expect(out.card.body).toBe(card.body);
  });

  it("`## Rótulo` (o que se digita, já que a seção LÊ como título) reancora a região", () => {
    const card = idea({ evidence: null });
    const label = IDEA_SECTIONS.find((s) => s.binding === "idea.evidence")!.label;
    const out = throughMarkdown(card, (md) => `${md}\n## ${label}\n\nEvidência escrita na fonte.\n`);
    expect(out.card.idea?.evidence).toBe("Evidência escrita na fonte.");
    // e não vazou para o corpo livre
    expect(out.card.body).not.toContain("Evidência escrita na fonte.");
  });

  it("um heading de rótulo DUPLICADO não sobrescreve a região — vira corpo", () => {
    const card = idea();
    const label = IDEA_SECTIONS.find((s) => s.binding === "idea.evidence")!.label;
    const out = throughMarkdown(card, (md) => `${md}\n## ${label}\n\nsegunda cópia\n`);
    expect(out.card.idea?.evidence).toBe(card.idea?.evidence);
    expect(out.card.body).toContain("segunda cópia");
  });

  it("o `#` de abertura renomeia o documento", () => {
    const card = idea();
    const out = throughMarkdown(card, (md) => md.replace(`# ${card.title}`, "# Outro título"));
    expect(out.card.title).toBe("Outro título");
  });

  it("texto novo fora das seções continua indo para o corpo livre", () => {
    const card = idea();
    const out = throughMarkdown(card, (md) => `${md}\n## Estado atual\n\nUma seção só do corpo.\n`);
    expect(out.card.body).toContain("## Estado atual");
    expect(out.card.body).toContain("Uma seção só do corpo.");
  });
});

describe("idea-doc — regressão de containment", () => {
  it("uma seção ligada NÃO engole o corpo livre que vem depois dela", () => {
    // O bug da 1ª versão (heading + run contígua): o body é projetado depois das seções, então o
    // primeiro parágrafo dele casava a run da última seção de texto e era absorvido — um round-trip
    // movia o body inteiro para dentro da evidência.
    const card = idea({ evidence: "3 usuários ignoram o selo." }, { body: "Nota longa do autor no corpo.\n" });
    const out = commitIdeaDoc(projectIdeaDoc(card), card);
    expect(out.changed).toBe(false);
    expect(out.card.idea?.evidence).toBe("3 usuários ignoram o selo.");
    expect(out.card.body).toBe(card.body);
  });
});
