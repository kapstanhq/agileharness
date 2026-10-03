// O CRUZAMENTO com as fontes privadas do operador (scripts/oss/derivation-check.mjs): uma frase de um card ou de um
// documento privado que aparece num teste, numa fixture, numa skill ou num documento da árvore pública é cópia — a não
// ser que seja texto da própria ferramenta, que o card guardou. Tudo aqui é inventado: a «fonte privada» é uma pasta
// temporária.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crossCheck, declaredNames, indexPrivate, isDistinctive, parseAccepted, shinglesOf, wordsOf } from "../../../../../scripts/oss/derivation-check.mjs";

const N = 6;
const PRIVATE_SENTENCE = "O atendente responde em até dois minutos durante o horário comercial da loja";

describe("derivation-check — frases em comum com as fontes privadas", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "derivation-"));
    mkdirSync(path.join(dir, "cards"), { recursive: true });
    writeFileSync(path.join(dir, "cards", "story-a.md"), `# Card\n\n${PRIVATE_SENTENCE}.\n\nO run morreu: falha da ferramenta ao gravar o arquivo de saída do passo.\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("as palavras ignoram marcação e caixa; as janelas não atravessam a quebra de linha", () => {
    expect(wordsOf("**O Atendente** responde, `rápido`!")).toEqual(["atendente", "responde", "rápido"]);
    expect(shinglesOf("um dois três quatro\ncinco seis sete oito", 3)).toEqual(["um dois três", "dois três quatro", "cinco seis sete", "seis sete oito"]);
  });

  it("uma janela só de palavras curtas ou de números não prova cópia", () => {
    expect(isDistinctive("de um em uma ou na")).toBe(false);
    expect(isDistinctive("12 34 56 78 90 11")).toBe(false);
    expect(isDistinctive("atendente responde durante horário de loja")).toBe(true);
  });

  it("a frase privada num TESTE é achado; a mesma frase com os substantivos trocados não é vista (o limite declarado)", () => {
    const index = indexPrivate([dir], N);
    const copied = crossCheck([["src/x.test.ts", `it("...", () => expect(t).toBe("${PRIVATE_SENTENCE}"));`]], index, N);
    expect(copied.findings).toHaveLength(1);
    expect(copied.findings[0]).toMatchObject({ file: "src/x.test.ts", line: 1, source: "cards/story-a.md:3" });
    const swapped = crossCheck([["src/x.test.ts", `"O livreiro responde em até cinco minutos durante o expediente normal da livraria"`]], index, N);
    expect(swapped.findings).toEqual([]);
  });

  it("A DIREÇÃO: o que também está no código de execução é texto da ferramenta que o card guardou — não é achado", () => {
    const index = indexPrivate([dir], N);
    const toolText = "O run morreu: falha da ferramenta ao gravar o arquivo de saída do passo.";
    const r = crossCheck(
      [
        ["src/runner/run-death.ts", `const title = "${toolText}";`],
        ["src/runner/run-death.test.ts", `expect(title).toBe("${toolText}");`],
      ],
      index,
      N,
    );
    expect(r.findings).toEqual([]);
    expect(r.own.map((o) => o.file).sort()).toEqual(["src/runner/run-death.test.ts", "src/runner/run-death.ts"]);
  });

  it("a mesma frase SÓ no código de execução não é achado (é a ferramenta falando); em fixture, skill e documento é", () => {
    const index = indexPrivate([dir], N);
    expect(crossCheck([["src/lib/mensagens.ts", `"${PRIVATE_SENTENCE}"`]], index, N).findings).toEqual([]);
    for (const file of ["src/__fixtures__/caso.md", ".claude/skills/harness-x/SKILL.md", "docs/guia.md", "src/items.fixture.ts"]) {
      expect(crossCheck([[file, PRIVATE_SENTENCE]], index, N).findings, file).toHaveLength(1);
    }
  });

  it("o que a própria árvore pública distribui para dentro do alvo sai do índice", () => {
    const index = indexPrivate([dir], N, (file) => file.endsWith("story-a.md"));
    expect(index.size).toBe(0);
  });

  it("os NOMES declarados num board.yaml: personas, sistemas e frases de estratégia — não slugs nem valores curtos", () => {
    const yaml = [
      "name: Loja",
      "personas:",
      "  - id: cliente-fiel",
      "    name: Cliente Fiel de Bairro",
      "systems:",
      "  - name: 'Canal de Atendimento'",
      "positioning: Para quem compra toda semana, a loja que lembra do seu pedido.",
      "statuses:",
      "  - { id: fazendo, name: Fazendo }",
      "label: ok",
    ].join("\n");
    expect(declaredNames(yaml).sort()).toEqual(["Canal de Atendimento", "Cliente Fiel de Bairro", "Para quem compra toda semana, a loja que lembra do seu pedido."]);
  });

  it("os aceitos do operador: `arquivo<TAB>frase`, com comentários e linhas em branco", () => {
    const set = parseAccepted("# conferidos em março\n\nsrc/a.test.ts\tfrase montada em tempo de execução pela ferramenta\nlinha sem tab\n");
    expect([...set]).toEqual(["src/a.test.ts\tfrase montada em tempo de execução pela ferramenta"]);
  });
});
