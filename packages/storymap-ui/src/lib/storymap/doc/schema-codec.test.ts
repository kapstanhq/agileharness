import { describe, expect, it } from "vitest";
import {
  blockingViolations,
  emptyDocMarkdown,
  orderedSections,
  validateSchema,
  type DocSchema,
} from "./doc-schema";
import {
  appendSectionItem,
  collectSchemaDoc,
  emptySchemaDoc,
  ensureSkeleton,
  parseSchemaBody,
  removeSectionItem,
  schemaDocToModel,
  sectionContent,
  sectionGroups,
  sectionItems,
  serializeSchemaDoc,
  setSectionItems,
  updateSectionItem,
} from "./schema-codec";
import { LEAN_CANVAS_SCHEMA } from "./schemas/lean-canvas";
import { availableViews } from "./view-contracts";
import { boardLayoutFor } from "@/components/doc/views/board-layouts";

const S = LEAN_CANVAS_SCHEMA;

/** Um documento CANÔNICO: título fixo, todas as seções obrigatórias, na ordem do schema. */
const CANONICAL = `# Lean Canvas

## Segmentos de clientes

- Product managers que não programam.
- Fundadores de áreas não-técnicas.

### Early adopters

- Quem já tentou Lovable e travou.

## Problema

### Demanda

- **PM não-técnico** — Ferramentas de IA travam nos últimos 30%.

### Oferta

- **Founder-CTO** — A entrega do time não acelera.

### Alternativas existentes

- Protótipos no Lovable que empacam.

## Proposta de valor única

- Descreva sua ideia e veja-a virar um produto no ar.

### Conceito de alto nível

- Um piloto automático de produto.

## Solução

- Um quadro onde cada ideia vira história, tarefas e código.

## Canais

- Mostrar o produto sendo construído por ele mesmo.

## Fontes de receita

- Assinatura mensal por pessoa.

## Estrutura de custos

- Infra e tokens de agente.

## Métricas-chave

- Ideias que chegam ao ar por semana.

## Vantagem injusta

- nenhuma ainda
`;

const parse = (md: string, fm: Record<string, unknown> = {}) => parseSchemaBody(md, S, fm);

describe("doc-schema — integridade do próprio schema", () => {
  it("o Lean Canvas é um schema bem formado", () => {
    expect(validateSchema(S)).toEqual([]);
  });

  it("toda seção aninhada aponta para um pai que existe e é de nível 2", () => {
    for (const rule of S.sections.filter((s) => s.level === 3)) {
      const parent = S.sections.find((p) => p.key === rule.parent);
      expect(parent, `pai de ${rule.key}`).toBeDefined();
      expect(parent!.level).toBe(2);
    }
  });

  it("recusa um schema com pai inexistente, chave duplicada e nível 3 sem pai", () => {
    const broken: DocSchema = {
      docType: "x",
      title: { kind: "fixed", text: "X" },
      allowFreeTail: false,
      sections: [
        { key: "a", label: "A", level: 2, locked: true, required: true, content: "items", hint: "" },
        { key: "a", label: "A2", level: 2, locked: true, required: true, content: "items", hint: "" },
        { key: "b", label: "B", level: 3, parent: "nao-existe", locked: true, required: false, content: "items", hint: "" },
        { key: "c", label: "C", level: 3, locked: true, required: false, content: "items", hint: "" },
      ],
    };
    const problems = validateSchema(broken);
    expect(problems.join(" | ")).toMatch(/duplicada/);
    expect(problems.join(" | ")).toMatch(/inexistente/);
    expect(problems.join(" | ")).toMatch(/nível 3 sem/);
  });
});

describe("schema-codec — as três leis", () => {
  it("LEI 1 (ponto fixo): serialize(parse(x)) devolve os MESMOS bytes", () => {
    const { doc, violations } = parse(CANONICAL);
    expect(violations).toEqual([]);
    expect(serializeSchemaDoc(doc, S)).toBe(CANONICAL);
  });

  it("LEI 1 vale sob repetição — reserializar nunca move mais nada", () => {
    const once = serializeSchemaDoc(parse(CANONICAL).doc, S);
    const twice = serializeSchemaDoc(parse(once).doc, S);
    expect(twice).toBe(once);
  });

  it("LEI 2 (no-op ≡ no-write): o markdown inline sobrevive byte a byte", () => {
    const { doc } = parse(CANONICAL);
    const items = sectionItems(doc, "problem");
    expect(items[0].text).toBe("**PM não-técnico** — Ferramentas de IA travam nos últimos 30%.");
    expect(serializeSchemaDoc(doc, S)).toContain("**PM não-técnico** — Ferramentas de IA travam");
  });

  it("LEI 3 (recusa explícita): conteúdo sem casa vira violação, nunca é dobrado em silêncio", () => {
    const md = CANONICAL.replace("## Solução", "## Seção Inventada\n\n- algo\n\n## Solução");
    const { violations } = parse(md);
    const unknown = violations.filter((v) => v.code === "heading-unknown");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown[0].found).toBe("Seção Inventada");
    expect(blockingViolations(violations).length).toBeGreaterThan(0);
  });
});

describe("schema-codec — travamento do esqueleto", () => {
  it("renomear um heading travado é ERRO (a seção some e a nova não é conhecida)", () => {
    const { violations } = parse(CANONICAL.replace("## Problema", "## Dores"));
    expect(violations.some((v) => v.code === "heading-unknown" && v.found === "Dores")).toBe(true);
    expect(violations.some((v) => v.code === "heading-missing" && v.sectionKey === "problem")).toBe(true);
    expect(blockingViolations(violations).length).toBeGreaterThan(0);
  });

  it("renomear o TÍTULO de um documento de título fixo é ERRO", () => {
    const { violations } = parse(CANONICAL.replace("# Lean Canvas", "# Meu Canvas"));
    const v = violations.find((x) => x.code === "heading-renamed");
    expect(v?.severity).toBe("error");
    expect(v?.found).toBe("Meu Canvas");
  });

  it("seção obrigatória ausente é ERRO e a mensagem ensina a forma exata", () => {
    const md = CANONICAL.replace(/## Vantagem injusta\n\n- nenhuma ainda\n/, "");
    const v = parse(md).violations.find((x) => x.code === "heading-missing" && x.sectionKey === "unfairAdvantage");
    expect(v?.severity).toBe("error");
    expect(v?.message).toContain("## Vantagem injusta");
  });

  it("seção duplicada é ERRO — o segundo bloco não teria para onde ir", () => {
    const md = `${CANONICAL}\n## Canais\n\n- de novo\n`;
    const v = parse(md).violations.find((x) => x.code === "heading-duplicated");
    expect(v?.sectionKey).toBe("channels");
    expect(v?.severity).toBe("error");
  });

  it("fora de ordem é ERRO, e queixa UMA vez (a correção é a mesma para todas)", () => {
    const { violations } = parse(`# Lean Canvas

## Problema

- dor

## Segmentos de clientes

- gente
`);
    const out = violations.filter((v) => v.code === "out-of-order");
    expect(out).toHaveLength(1);
    expect(out[0].sectionKey).toBe("customerSegments");
  });

  it("subseção fora do pai é ERRO e diz para onde ela pertence", () => {
    const md = CANONICAL.replace(
      "## Canais\n\n- Mostrar o produto sendo construído por ele mesmo.",
      "## Canais\n\n### Early adopters\n\n- fora de lugar",
    );
    const v = parse(md).violations.find((x) => x.code === "orphan-subsection");
    expect(v?.sectionKey).toBe("earlyAdopters");
    expect(v?.message).toContain("Segmentos de clientes");
  });
});

describe("schema-codec — forma do conteúdo (avisa, não recusa)", () => {
  it("parágrafo numa seção de itens é AVISO — documento em construção não pode travar o salvamento", () => {
    const md = CANONICAL.replace("- Mostrar o produto sendo construído por ele mesmo.", "Ainda vou listar isso.");
    const { violations } = parse(md);
    const v = violations.find((x) => x.code === "wrong-content-kind" && x.sectionKey === "channels");
    expect(v?.severity).toBe("warning");
    expect(blockingViolations(violations)).toEqual([]);
  });

  it("excesso de itens é AVISO com a contagem real", () => {
    const md = CANONICAL.replace(
      "## Solução\n\n- Um quadro onde cada ideia vira história, tarefas e código.",
      "## Solução\n\n- a\n- b\n- c\n- d",
    );
    const v = parse(md).violations.find((x) => x.code === "too-many-items" && x.sectionKey === "solution");
    expect(v?.severity).toBe("warning");
    expect(v?.message).toContain("hoje tem 4");
  });

  it("frontmatter que não confere é ERRO", () => {
    const { violations } = parse(CANONICAL, { tags: [{ id: "", name: "x" }] });
    const v = violations.find((x) => x.code === "frontmatter-invalid");
    expect(v?.severity).toBe("error");
  });

  it("frontmatter válido passa e round-trippa no cabeçalho", () => {
    const fm = { doc: "lean-canvas", tags: [{ id: "pm", name: "PM não-técnico", color: "#7c3aed" }] };
    const { doc, violations } = parse(CANONICAL, fm);
    expect(violations).toEqual([]);
    const out = serializeSchemaDoc(doc, S);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("id: pm");
    expect(parseSchemaBody(out.split("---\n")[2] ?? "", S, fm).violations).toEqual([]);
  });
});

describe("schema-codec — grupos autorais", () => {
  it("um ### livre dentro de uma seção `groups` é DADO, não violação", () => {
    const { doc, violations } = parse(CANONICAL);
    expect(violations).toEqual([]);
    expect(sectionGroups(doc, "problem")).toEqual(["Demanda", "Oferta"]);
  });

  it("cada item sabe em que grupo está; item antes do primeiro grupo fica sem grupo", () => {
    const md = CANONICAL.replace(
      "## Problema\n\n### Demanda",
      "## Problema\n\n- solto e legítimo\n\n### Demanda",
    );
    const { doc, violations } = parse(md);
    expect(violations).toEqual([]);
    const items = sectionItems(doc, "problem");
    expect(items[0]).toMatchObject({ text: "solto e legítimo", group: null });
    expect(items[1].group).toBe("Demanda");
    expect(items[2].group).toBe("Oferta");
  });

  it("o grupo sobrevive ao round-trip", () => {
    const { doc } = parse(CANONICAL);
    const again = parse(serializeSchemaDoc(doc, S));
    expect(sectionGroups(again.doc, "problem")).toEqual(["Demanda", "Oferta"]);
  });

  it("uma subseção do REGISTRO ganha de um grupo com o mesmo nome (registro primeiro)", () => {
    const { doc } = parse(CANONICAL);
    expect(sectionContent(doc, "existingAlternatives")).toBeDefined();
    expect(sectionGroups(doc, "problem")).not.toContain("Alternativas existentes");
  });
});

describe("schema-codec — esqueleto", () => {
  it("um documento NOVO nasce válido (zero violações)", () => {
    const doc = emptySchemaDoc(S);
    const md = serializeSchemaDoc(doc, S);
    const { violations } = parse(md);
    expect(blockingViolations(violations)).toEqual([]);
  });

  it("emptyDocMarkdown e emptySchemaDoc concordam sobre o esqueleto", () => {
    const fromBlocks = serializeSchemaDoc(emptySchemaDoc(S), S);
    expect(fromBlocks).toBe(emptyDocMarkdown(S));
  });

  it("ensureSkeleton repõe as obrigatórias que faltam, VAZIAS, sem tocar nas existentes", () => {
    const md = `# Lean Canvas

## Problema

- só isto
`;
    const { doc } = parse(md);
    expect(doc.sections).toHaveLength(1);
    const repaired = ensureSkeleton(doc, S);
    expect(repaired.sections.map((s) => s.key)).toEqual(
      orderedSections(S).filter((r) => r.required).map((r) => r.key),
    );
    expect(sectionItems(repaired, "problem")).toHaveLength(1);
  });

  it("ensureSkeleton NÃO roda no salvamento — reparar é gesto explícito", () => {
    // O parse devolve o documento COMO ESTÁ (uma seção), com a violação. Se o parse reparasse,
    // a violação sumiria e o autor perderia a chance de decidir.
    const { doc, violations } = parse("# Lean Canvas\n\n## Problema\n\n- só isto\n");
    expect(doc.sections).toHaveLength(1);
    expect(violations.some((v) => v.code === "heading-missing")).toBe(true);
  });
});

describe("schema-codec — mutação (o caminho ÚNICO de escrita das views)", () => {
  it("appendSectionItem acrescenta ao fim e o documento segue válido", () => {
    const { doc } = parse(CANONICAL);
    const next = appendSectionItem(doc, "channels", { text: "Comunidades de PM", group: null }, S);
    expect(sectionItems(next, "channels").map((i) => i.text)).toEqual([
      "Mostrar o produto sendo construído por ele mesmo.",
      "Comunidades de PM",
    ]);
    expect(blockingViolations(parse(serializeSchemaDoc(next, S)).violations)).toEqual([]);
  });

  it("updateSectionItem reescreve UM item sem tocar nos vizinhos", () => {
    const { doc } = parse(CANONICAL);
    const next = updateSectionItem(doc, "customerSegments", 0, { text: "PMs que não programam" }, S);
    expect(sectionItems(next, "customerSegments").map((i) => i.text)).toEqual([
      "PMs que não programam",
      "Fundadores de áreas não-técnicas.",
    ]);
  });

  it("removeSectionItem remove pelo índice; índice fora da faixa é no-op", () => {
    const { doc } = parse(CANONICAL);
    expect(sectionItems(removeSectionItem(doc, "customerSegments", 0, S), "customerSegments")).toHaveLength(1);
    expect(removeSectionItem(doc, "customerSegments", 99, S)).toBe(doc);
  });

  it("a mutação PRESERVA os grupos autorais e a ordem deles", () => {
    const { doc } = parse(CANONICAL);
    const next = appendSectionItem(doc, "problem", { text: "Terceira dor", group: "Demanda" }, S);
    expect(sectionGroups(next, "problem")).toEqual(["Demanda", "Oferta"]);
    const items = sectionItems(next, "problem");
    expect(items.filter((i) => i.group === "Demanda").map((i) => i.text)).toEqual([
      "**PM não-técnico** — Ferramentas de IA travam nos últimos 30%.",
      "Terceira dor",
    ]);
  });

  it("item sem grupo abre a seção, antes do primeiro grupo", () => {
    const { doc } = parse(CANONICAL);
    const next = appendSectionItem(doc, "problem", { text: "Sem grupo", group: null }, S);
    const md = serializeSchemaDoc(next, S);
    expect(md.indexOf("- Sem grupo")).toBeLessThan(md.indexOf("### Demanda"));
  });

  it("mutar uma seção que o schema não conhece é no-op (nunca inventa seção)", () => {
    const { doc } = parse(CANONICAL);
    expect(appendSectionItem(doc, "naoExiste", { text: "x", group: null }, S)).toBe(doc);
  });

  it("mutar uma seção AUSENTE cria a seção na posição do schema, não no fim", () => {
    const { doc } = parse("# Lean Canvas\n\n## Vantagem injusta\n\n- nenhuma ainda\n");
    const next = appendSectionItem(doc, "problem", { text: "uma dor", group: null }, S);
    expect(next.sections.map((s) => s.key)).toEqual(["problem", "unfairAdvantage"]);
  });

  it("uma seção `checklist` gera caixas, não bullets", () => {
    const checklist: DocSchema = {
      docType: "t",
      title: { kind: "fixed", text: "T" },
      allowFreeTail: false,
      sections: [
        { key: "todo", label: "Tarefas", level: 2, locked: true, required: true, content: "checklist", hint: "" },
      ],
    };
    const doc = emptySchemaDoc(checklist);
    const next = appendSectionItem(doc, "todo", { text: "fazer", group: null, checked: true }, checklist);
    expect(serializeSchemaDoc(next, checklist)).toContain("- [x] fazer");
  });
});

describe("view-contracts — as views se adaptam ao schema, não o contrário", () => {
  it("documento e markdown servem a QUALQUER schema", () => {
    const bare: DocSchema = {
      docType: "bare",
      title: { kind: "authored", hint: "" },
      allowFreeTail: true,
      sections: [],
    };
    expect(availableViews(bare).map((v) => v.id)).toEqual(["documento", "markdown"]);
  });

  it("o Lean Canvas ganha tabela e quadro SEM pedir — só por ter seções com itens", () => {
    expect(availableViews(S).map((v) => v.id)).toEqual(["documento", "markdown", "tabela", "quadro"]);
  });

  it("um schema só de prosa não oferece tabela nem quadro", () => {
    const prose: DocSchema = {
      docType: "prose",
      title: { kind: "fixed", text: "P" },
      allowFreeTail: true,
      sections: [{ key: "a", label: "A", level: 2, locked: true, required: true, content: "prose", hint: "" }],
    };
    expect(availableViews(prose).map((v) => v.id)).toEqual(["documento", "markdown"]);
  });

  it("TESTE DO APAGAMENTO: sem layout declarado o quadro continua servindo", () => {
    // `boardLayoutFor` devolver null é caminho de primeira classe — a view cai no arranjo
    // automático. Se um dia isto quebrar, é porque o layout virou requisito, e aí o
    // desacoplamento morreu.
    expect(boardLayoutFor("um-doctype-sem-layout")).toBeNull();
    expect(availableViews(S).some((v) => v.id === "quadro")).toBe(true);
  });

  it("o layout do Lean Canvas cobre exatamente as seções de nível 2, e nenhuma inventada", () => {
    const layout = boardLayoutFor("lean-canvas")!;
    const topKeys = S.sections.filter((s) => s.level === 2).map((s) => s.key).sort();
    expect(Object.keys(layout.cells).sort()).toEqual(topKeys);
  });
});

describe("schema-codec — a ponte para as views", () => {
  it("schemaDocToModel devolve os headings na ordem do SCHEMA, não na ordem do arquivo", () => {
    const { doc } = parse(`# Lean Canvas

## Canais

- c

## Problema

- p
`);
    const headings = schemaDocToModel(doc, S)
      .blocks.filter((b) => b.kind === "heading")
      .map((b) => (b as { text: string }).text);
    expect(headings).toEqual(["Problema", "Canais"]);
  });

  it("o editor rico volta pelo MESMO caminho do markdown (collectSchemaDoc)", () => {
    const fromText = parse(CANONICAL);
    const fromBlocks = collectSchemaDoc(schemaDocToModel(fromText.doc, S).blocks, S, {
      title: "Lean Canvas",
    });
    expect(fromBlocks.violations).toEqual([]);
    expect(serializeSchemaDoc(fromBlocks.doc, S)).toBe(CANONICAL);
  });

  it("sectionItems ignora divisores e devolve só o que é item", () => {
    const md = CANONICAL.replace("## Canais\n\n- Mostrar", "## Canais\n\n---\n\n- Mostrar");
    const { doc } = parse(md);
    expect(sectionItems(doc, "channels")).toHaveLength(1);
  });
});

describe("checklist — o marcador de estado nunca vive no texto", () => {
  // Defeito REAL, achado usando o produto: o PRD deste board saiu com `- [ ] [ ] …`, duas caixas,
  // uma clicável e outra literal. Ele é silencioso por construção — nada valida o texto de um item,
  // e o round-trip é ESTÁVEL (o texto sujo volta igual), então um teste de ponto fixo passa feliz.
  // Só se vê olhando a tela. Por isso a asserção aqui é sobre o CONTEÚDO da linha, não sobre ida-e-volta.
  const schema: DocSchema = {
    docType: "t",
    title: { kind: "fixed", text: "T" },
    allowFreeTail: false,
    sections: [{ key: "r", label: "R", level: 2, locked: true, required: true, content: "checklist", hint: "h" }],
  };
  const linha = (texto: string, checked?: boolean) => {
    const doc = parseSchemaBody("## R\n", schema, {}).doc;
    const com = setSectionItems(doc, "r", [{ text: texto, group: null, checked }], schema);
    return serializeSchemaDoc(com, schema).split("\n").find((l) => l.startsWith("- ["));
  };

  it("um `[ ]` que veio no texto é REMOVIDO — a sintaxe é da serialização", () => {
    expect(linha("[ ] A premissa.")).toBe("- [ ] A premissa.");
    expect(linha("[ ] A premissa.", false)).toBe("- [ ] A premissa.");
  });

  it("um `[x]` no texto é uma AFIRMAÇÃO de estado — respeitada, não descartada", () => {
    expect(linha("[x] Já resolvido.")).toBe("- [x] Já resolvido.");
    // `checked` explícito continua vencendo: quem passou o campo disse o que queria.
    expect(linha("[x] Já resolvido.", false)).toBe("- [ ] Já resolvido.");
  });

  it("texto limpo não é tocado, e um colchete que NÃO é marcador sobrevive", () => {
    expect(linha("A premissa.")).toBe("- [ ] A premissa.");
    expect(linha("[nota] isto não é marcador")).toBe("- [ ] [nota] isto não é marcador");
  });
});
