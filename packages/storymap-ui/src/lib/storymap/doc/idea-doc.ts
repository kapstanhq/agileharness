// 💡 idea-doc — projeção bidirecional Idea ⇄ DocModel (docType "idea"), ADR-066.
//
// A IDEIA continua sendo a fonte da verdade (cards/<id>.md via updateCardAction); o doc é a
// SUPERFÍCIE. O que muda em relação ao `card-doc`: lá a narrativa é READ-bound (devolver prosa para
// role/want/soThat seria adivinhação com perda). Aqui os campos OST são TEXTO PURO — uma string
// cada, e `candidateSolutions` uma lista de strings —, então eles voltam sem perda e o documento é
// de fato editável. É isso que faz a Ideia deixar de ser "formulário + um corpo" e virar UM texto.
//
// Regiões:
//   · properties          — espelho read-only (estado da exploração, motivo do descarte)
//   · seção hero          — `statement`, WRITE-bound
//   · 4 headings ancorados — evidence · keyAssumption · successSignal (texto) e candidateSolutions
//                            (lista); cada um possui a RUN CONTÍGUA de blocos logo abaixo de si
//   · tudo o mais         — livre, mapeia 1:1 para `card.body` pelo codec canônico
//
// Invariante (golden em idea-doc.test.ts): **no-op ≡ no-write** — commit(project(idea), idea)
// devolve changed:false e preserva cada byte, inclusive um body NÃO-canônico.

import type { Card, IdeaFields } from "../types";
import { blockIdFactory, type DocBlock, type DocModel, type PropEntry } from "./doc-model";
import { parseDocMd, serializeDocMd } from "./md-codec";

export const IDEA_DOC_TYPE = "idea";

/** Blocos que o editor da Ideia oferece. Exploração é texto longo, lista e imagem (print de bug,
 *  captura de tela de concorrente) — `properties` é da projeção, não do menu. */
export const IDEA_ALLOWED_BLOCKS: DocBlock["kind"][] = [
  "heading",
  "paragraph",
  "bullet",
  "numbered",
  "todo",
  "toggle",
  "quote",
  "code",
  "table",
  "divider",
  "image",
  "section",
];

export const STATEMENT_BINDING = "idea.statement";
export const STATEMENT_LABEL = "A ideia";

/** As seções ancoradas, em ORDEM de projeção. Uma seção nova = UMA entrada aqui (o projetor, o
 *  commit e o menu derivam desta tabela) — nada de quatro cópias da lógica de âncora. */
interface BoundSection {
  binding: string;
  label: string;
  icon: string;
  /** `text` → parágrafos colados; `list` → bullets. */
  kind: "text" | "list";
}

export const IDEA_SECTIONS: BoundSection[] = [
  { binding: "idea.evidence", label: "O que sustenta", icon: "search", kind: "text" },
  { binding: "idea.candidateSolutions", label: "Caminhos possíveis", icon: "git-branch", kind: "list" },
  { binding: "idea.keyAssumption", label: "A premissa que derruba tudo se for falsa", icon: "alert-triangle", kind: "text" },
  { binding: "idea.successSignal", label: "Como saberíamos que deu certo", icon: "target", kind: "text" },
];

const SECTION_BY_BINDING = new Map(IDEA_SECTIONS.map((s) => [s.binding, s] as const));

/**
 * O CATÁLOGO de âncoras da ideia — stubs de TODAS as seções ligadas, inclusive as que a projeção
 * omite por estarem vazias. A projeção só emite a seção que TEM conteúdo (uma caixa vazia era ruído,
 * decisão do ADR-066), e `reattachSections` reancora comparando rótulos com o que existe no modelo
 * original — então, sem este catálogo, escrever `## O que sustenta` na fonte markdown para PREENCHER
 * um campo hoje vazio não teria onde ancorar e o texto cairia no corpo livre. Passe-o junto do
 * modelo projetado (os stubs vão DEPOIS, então uma seção real vence o stub e mantém o tom).
 */
export function ideaSectionAnchors(): DocBlock[] {
  return [
    { kind: "section", id: "anchor-statement", label: STATEMENT_LABEL, tone: "hero", binding: STATEMENT_BINDING, body: [] },
    ...IDEA_SECTIONS.map(
      (section): DocBlock => ({
        kind: "section",
        id: `anchor-${section.binding}`,
        label: section.label,
        tone: "neutral",
        binding: section.binding,
        body: [],
      }),
    ),
  ];
}

export interface IdeaDocDeps {
  /** Quantas tarefas já endereçam esta ideia (rollup do edge `addresses`). */
  addressedCount?: number;
  /**
   * Projeta a caixa do enunciado mesmo VAZIA (modo edição). Sem isto uma ideia recém-criada abre num
   * documento em branco, sem nenhum lugar visível para escrever a ideia em si — o autor teria de
   * descobrir a aba de Campos. Só o hero é andaimado: andaimar as quatro seções opcionais
   * reconstruiria o formulário de cinco caixas vazias que o ADR-066 justamente desmontou.
   */
  scaffold?: boolean;
}

/** Texto de um campo → blocos de parágrafo (quebra em linha em branco). */
function textToBlocks(value: string, nextId: () => string): DocBlock[] {
  return value
    .split(/\n[ \t]*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((text) => ({ kind: "paragraph", id: nextId(), text }) as DocBlock);
}

/** Blocos de uma run → texto de campo (o inverso exato de textToBlocks). */
function blocksToText(blocks: DocBlock[]): string {
  return blocks
    .map((b) => (b.kind === "paragraph" || b.kind === "quote" || b.kind === "bullet" || b.kind === "numbered" ? b.text : ""))
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function projectIdeaDoc(card: Card, deps: IdeaDocDeps = {}): DocModel {
  const nextId = blockIdFactory();
  const blocks: DocBlock[] = [];
  const idea: IdeaFields = card.idea ?? { statement: "", evidence: null, status: "open" };

  // A "Exploração" NÃO é propriedade daqui: a tela renderiza `IdeaDocActions` logo ACIMA do documento,
  // com os quatro estados como BOTÕES — e este bloco repetia o mesmo fato dois dedos abaixo, em versão
  // read-only. Duas leituras do mesmo dado, uma delas sem afordância, a dois dedos de distância: o
  // operador não sabia qual valia. Ficou a que se pode mexer.
  const entries: PropEntry[] = [];
  if (deps.addressedCount) {
    entries.push({
      key: "addressed",
      label: "Tarefas geradas",
      icon: "list-checks",
      value: { kind: "text", text: String(deps.addressedCount) },
    });
  }
  // O motivo do descarte é PROPRIEDADE, não seção: ele não é material de exploração, é o registro de
  // por que ela parou — e precisa estar visível no topo para ninguém repropor a mesma ideia.
  if (idea.status === "discarded" && idea.discardReason) {
    entries.push({
      key: "discardReason",
      label: "Descartada porque",
      icon: "x-circle",
      value: { kind: "text", text: idea.discardReason },
    });
  }
  // GUARDA o push: sem a linha de status, a ideia comum (nova, nenhuma tarefa gerada, não descartada)
  // fica com `entries: []` — e um bloco de propriedades vazio ainda desenha a faixa e o FILETE de
  // baixo, encostado no filete do próprio IdeaDocActions: duas linhas horizontais com um vão morto no
  // meio. (Fecha também o `serializeDocMd`, que guardava na contagem de BLOCOS e por isso exportava um
  // frontmatter `---\n{}\n---` vazio.)
  if (entries.length) blocks.push({ kind: "properties", id: nextId(), entries });

  // O enunciado — hero WRITE-bound (texto puro volta sem perda, ao contrário da narrativa do card).
  // Vazio + `scaffold` ⇒ caixa aberta esperando escrita; um hero vazio NUNCA apaga o statement
  // anterior no commit (ver `nextStatement`), então andaimar é seguro.
  if (idea.statement.trim() || deps.scaffold) {
    const heroBody = textToBlocks(idea.statement, nextId);
    blocks.push({
      kind: "section",
      id: nextId(),
      label: STATEMENT_LABEL,
      tone: "hero",
      binding: STATEMENT_BINDING,
      // A caixa PRECISA de um parágrafo vazio dentro. O bloco `section` é `content: "none"` — ele
      // desenha só o cabeçalho e os filhos são blocos aninhados; sem nenhum filho o editor não tem
      // onde pôr o cursor e a caixa fica DECORATIVA: clicar e digitar não escreve nada (medido na
      // validação visual — 26 caracteres digitados, zero filhos criados).
      body: heroBody.length ? heroBody : [{ kind: "paragraph", id: nextId(), text: "" }],
    });
  }

  for (const section of IDEA_SECTIONS) {
    const body = sectionBlocks(section, idea, nextId);
    if (!body.length) continue;
    // CONTAINMENT ESTRUTURAL, não posicional. A primeira versão disto usava o padrão do `card-doc`
    // (heading ancorado + a run contígua abaixo) e tinha um bug de perda de dados: o corpo livre é
    // projetado DEPOIS das seções, então o primeiro parágrafo do body casava a run da última seção
    // de texto e era absorvido por ela — um round-trip movia o body inteiro para dentro da
    // evidência. Um `section` carrega os filhos DENTRO de si: não há run para invadir, e o
    // `binding` sobrevive porque section é custom spec (as specs default do BlockNote dropam props).
    blocks.push({
      kind: "section",
      id: nextId(),
      label: section.label,
      tone: "neutral",
      binding: section.binding,
      body,
    });
  }

  const body = parseDocMd(card.body ?? "", { docType: IDEA_DOC_TYPE });
  blocks.push(...reId(body.blocks, nextId));

  return { docType: IDEA_DOC_TYPE, title: card.title ?? "", blocks };
}

function sectionBlocks(section: BoundSection, idea: IdeaFields, nextId: () => string): DocBlock[] {
  if (section.binding === "idea.evidence") return idea.evidence?.trim() ? textToBlocks(idea.evidence, nextId) : [];
  if (section.binding === "idea.keyAssumption")
    return idea.keyAssumption?.trim() ? textToBlocks(idea.keyAssumption, nextId) : [];
  if (section.binding === "idea.successSignal")
    return idea.successSignal?.trim() ? textToBlocks(idea.successSignal, nextId) : [];
  if (section.binding === "idea.candidateSolutions")
    return (idea.candidateSolutions ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => ({ kind: "bullet", id: nextId(), text }) as DocBlock);
  return [];
}

export interface CommitIdeaDocResult {
  card: Card;
  changed: boolean;
}

/**
 * Remonta a Ideia a partir do doc editado. Cada heading ancorado possui a run contígua abaixo dele;
 * o hero possui o `statement`; o resto vira `body`.
 *
 * Regra de âncora (a mesma do card-doc): o `binding` manda; o RÓTULO é só a segunda rede para quando
 * a superfície do editor derrubou o binding do heading (ver reattachBindings), e então SÓ o primeiro
 * heading casando ancora — um corpo que legitimamente contenha "Caminhos possíveis" nunca sequestra
 * a região ligada.
 */
export function commitIdeaDoc(model: DocModel, prev: Card): CommitIdeaDocResult {
  const free: DocBlock[] = [];
  const runs = new Map<string, DocBlock[]>();
  let statement: string | null = null;

  for (const block of model.blocks) {
    if (block.kind === "properties") continue;

    if (block.kind === "section" && block.binding) {
      if (block.binding === STATEMENT_BINDING) {
        statement = blocksToText(block.body);
        continue;
      }
      // Só a PRIMEIRA seção de cada binding manda: se o autor duplicar a caixa (copiar/colar), a
      // cópia vira corpo livre em vez de sobrescrever em silêncio o que a primeira já disse.
      const spec = SECTION_BY_BINDING.get(block.binding);
      if (spec && !runs.has(spec.binding)) {
        runs.set(spec.binding, block.body);
        continue;
      }
    }

    free.push(block);
  }

  const prevIdea: IdeaFields = prev.idea ?? { statement: "", evidence: null, status: "open" };
  // `undefined` = a seção não existe no doc (o autor nunca a abriu) ⇒ PRESERVA o valor anterior.
  // `null` = a seção existe e está vazia ⇒ o autor LIMPOU o campo. Os dois são desfechos diferentes,
  // então nada de `??` aqui — a distinção some com ele.
  const runText = (binding: string): string | null | undefined => {
    const run = runs.get(binding);
    if (run === undefined) return undefined;
    return blocksToText(run) || null;
  };
  const keep = <T,>(next: T | undefined, previous: T): T => (next === undefined ? previous : next);

  const nextStatement = statement === null ? prevIdea.statement : statement || prevIdea.statement;
  const solutionsRun = runs.get("idea.candidateSolutions");
  const nextSolutions =
    solutionsRun === undefined
      ? prevIdea.candidateSolutions ?? []
      : solutionsRun.map((b) => ("text" in b ? String(b.text).trim() : "")).filter(Boolean);

  const idea: IdeaFields = { ...prevIdea, statement: nextStatement };
  idea.evidence = keep(runText("idea.evidence"), prevIdea.evidence ?? null);
  const keyAssumption = keep(runText("idea.keyAssumption"), prevIdea.keyAssumption ?? null);
  const successSignal = keep(runText("idea.successSignal"), prevIdea.successSignal ?? null);
  // Persistência ESPARSA (a mesma de updateIdeaAction/write.ts): campo vazio SAI do bloco em vez de
  // virar `null` no .md — é o que mantém o card enxuto e o diff legível.
  if (keyAssumption) idea.keyAssumption = keyAssumption;
  else delete idea.keyAssumption;
  if (successSignal) idea.successSignal = successSignal;
  else delete idea.successSignal;
  if (nextSolutions.length) idea.candidateSolutions = nextSolutions;
  else delete idea.candidateSolutions;

  const title = model.title.trim() || (prev.title ?? "");
  let body = serializeDocMd({ docType: model.docType, title: "", blocks: free });
  const prevBody = prev.body ?? "";
  if (body !== prevBody) {
    const prevCanonical = serializeDocMd({
      docType: model.docType,
      title: "",
      blocks: parseDocMd(prevBody, { docType: model.docType }).blocks,
    });
    if (prevCanonical === body) body = prevBody;
  }

  // Comparação CAMPO A CAMPO, não JSON.stringify: o stringify depende da ORDEM das chaves, e
  // `delete`+re-atribuição reordena — um round-trip sem edição nenhuma acusaria "mudou" e gravaria
  // por nada, quebrando a invariante no-op ≡ no-write.
  const sameList = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((v, i) => v === b[i]);
  const ideaChanged =
    idea.statement !== prevIdea.statement ||
    (idea.evidence ?? null) !== (prevIdea.evidence ?? null) ||
    (idea.keyAssumption ?? null) !== (prevIdea.keyAssumption ?? null) ||
    (idea.successSignal ?? null) !== (prevIdea.successSignal ?? null) ||
    !sameList(idea.candidateSolutions, prevIdea.candidateSolutions);
  const changed = title !== (prev.title ?? "") || body !== prevBody || ideaChanged;

  return { card: { ...prev, title, body, idea }, changed };
}

function reId(blocks: DocBlock[], nextId: () => string): DocBlock[] {
  return blocks.map((block) => {
    const withId = { ...block, id: nextId() } as DocBlock;
    if (withId.kind === "toggle") withId.children = reId(withId.children, nextId);
    if (withId.kind === "section") withId.body = reId(withId.body, nextId);
    return withId;
  });
}
