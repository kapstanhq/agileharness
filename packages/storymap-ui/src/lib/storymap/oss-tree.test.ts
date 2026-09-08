// O guarda do guarda. `oss-tree.ts` é o que autoriza cinco arquivos de teste a tolerar a ausência de um
// arquivo — ou seja, é a única peça desta suíte cujo defeito se manifesta como VERDE. Um bug aqui não
// aparece como falha: aparece como cinco casos que pararam de medir sem ninguém notar.
//
// Por isso ele é cobrado nos DOIS sentidos, e com árvores de mentira montadas no disco para que o caso
// que deveria falhar seja EXECUTADO, não imaginado:
//   · declarado ⇒ EXISTE no umbrella   (declaração morta desliga um guarda de verdade)
//   · declarado ⇒ AUSENTE no artefato  (o lado do dono vazou para o repo público)
//   · umbrella sem o arquivo ⇒ LANÇA   (a regressão que a tolerância não pode esconder)
//   · discriminador de um sinal só ⇒ LANÇA (apagar o extrator não pode desligar a suíte em silêncio)
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALVO_DA_PUBLICACAO,
  GATE_DE_PUBLICACAO,
  OSS_TREE_ROOT,
  SO_DO_UMBRELLA,
  arvore,
  comandoDe,
  produtoresDaPublicacao,
  receitaDoJustfile,
  soDoUmbrella,
  substituicoesDaPublicacao,
} from "./oss-tree";

const temporarios: string[] = [];
afterEach(() => {
  for (const d of temporarios.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Uma árvore de mentira com o retrato pedido. `extras` planta arquivos relativos à raiz. */
function arvoreFalsa(retrato: "umbrella" | "extraido" | "incoerente", extras: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-oss-tree-"));
  temporarios.push(dir);
  const pacotes = retrato === "umbrella" ? ["storymap-ui", "outro-pacote"] : ["storymap-ui"];
  for (const p of pacotes) mkdirSync(path.join(dir, "packages", p), { recursive: true });
  if (retrato !== "extraido") {
    mkdirSync(path.join(dir, "oss"), { recursive: true });
    writeFileSync(path.join(dir, "oss/extract.sh"), "#!/bin/sh\n");
  }
  for (const [rel, conteudo] of Object.entries(extras)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo);
  }
  return dir;
}

describe("arvore() — dois sinais que têm de concordar", () => {
  it("classifica ESTA árvore sem ambiguidade (e é a árvore que a fonte diz ser)", () => {
    const q = arvore();
    expect(["umbrella", "extraido"]).toContain(q);
    // Não-vacuidade: a raiz resolvida pela fonte é mesmo uma raiz — tem packages/storymap-ui.
    expect(existsSync(path.join(OSS_TREE_ROOT, "packages/storymap-ui"))).toBe(true);
    // …e o veredito bate com o sinal independente do extrator.
    expect(existsSync(path.join(OSS_TREE_ROOT, "oss/extract.sh"))).toBe(q === "umbrella");
  });

  it("umbrella de mentira ⇒ umbrella; artefato de mentira ⇒ extraido", () => {
    expect(arvore(arvoreFalsa("umbrella"))).toBe("umbrella");
    expect(arvore(arvoreFalsa("extraido"))).toBe("extraido");
  });

  it("ATAQUE: apagar o extrator do umbrella LANÇA — não vira 'extraído' em silêncio", () => {
    // Este é o modo de falha que um discriminador de um sinal só teria: `oss/extract.sh` some (ou é
    // renomeado), o umbrella passa a se declarar artefato, e os cinco guardas umbrella-only desligam
    // TODOS de uma vez, verdes. O segundo sinal (packages/ com mais de um pacote) impede isso.
    const meioUmbrella = arvoreFalsa("umbrella");
    rmSync(path.join(meioUmbrella, "oss/extract.sh"));
    expect(() => arvore(meioUmbrella)).toThrow(/INCOERENTE/);
  });

  it("ATAQUE: um artefato que arrastou um segundo pacote também LANÇA", () => {
    const inchado = arvoreFalsa("extraido");
    mkdirSync(path.join(inchado, "packages/nao-devia-viajar"), { recursive: true });
    expect(() => arvore(inchado)).toThrow(/INCOERENTE/);
  });
});

describe("SO_DO_UMBRELLA — os dois sentidos, cobrados na árvore em que se está", () => {
  it("a lista não está vazia e todo motivo é escrito (a lista É o registro da decisão)", () => {
    const entradas = Object.entries(SO_DO_UMBRELLA);
    expect(entradas.length).toBeGreaterThan(0);
    for (const [rel, motivo] of entradas) {
      expect(rel, "caminho relativo à raiz, sem barra inicial").not.toMatch(/^\//);
      expect(motivo.length, `${rel} foi declarado sem motivo escrito`).toBeGreaterThan(40);
    }
  });

  it(
    arvore() === "umbrella"
      ? "[UMBRELLA] declarado ⇒ EXISTE: nenhuma entrada está morta"
      : "[ARTEFATO] declarado ⇒ AUSENTE: nada do lado do dono vazou para o repo público",
    () => {
      const esperaExistir = arvore() === "umbrella";
      const errados = Object.keys(SO_DO_UMBRELLA).filter(
        (rel) => existsSync(path.join(OSS_TREE_ROOT, rel)) !== esperaExistir,
      );
      expect(
        errados,
        esperaExistir
          ? "declarado umbrella-only e ausente DO UMBRELLA: ou o arquivo foi movido (e os testes que " +
              "dependem dele estão medindo outra coisa), ou a declaração morreu e tem de sair da lista"
          : "declarado umbrella-only e PRESENTE no artefato extraído: a régua deixou passar o lado do " +
              "dono. Isto é vazamento, não conveniência — corrija /.ossignore antes de publicar",
      ).toEqual([]);
      // Não-vacuidade: o laço acima varreu a lista de verdade.
      expect(Object.keys(SO_DO_UMBRELLA).length).toBeGreaterThan(0);
    },
  );
});

describe("soDoUmbrella() — ausência decide por árvore, e nunca por silêncio", () => {
  it("no UMBRELLA, arquivo declarado que sumiu LANÇA nomeando o arquivo", () => {
    const semJustfile = arvoreFalsa("umbrella");
    // `[\s\S]*` e não `.*` com a flag `s`: o tsconfig desta suíte tem target ES2017, onde `s` é erro de
    // compilação (TS1501). A exigência é a MESMA — o nome do arquivo E a frase, na ordem, cruzando linhas.
    expect(() => soDoUmbrella("justfile", semJustfile)).toThrow(/justfile[\s\S]*sumiu do UMBRELLA/);
  });

  it("no UMBRELLA, arquivo presente devolve o caminho absoluto", () => {
    const comJustfile = arvoreFalsa("umbrella", { justfile: "alvo:\n  @true\n" });
    expect(soDoUmbrella("justfile", comJustfile)).toBe(path.join(comJustfile, "justfile"));
  });

  it("no ARTEFATO, a mesma ausência devolve null (é o estado correto lá)", () => {
    expect(soDoUmbrella("justfile", arvoreFalsa("extraido"))).toBeNull();
  });

  it("ATAQUE: tolerar a ausência de um caminho NÃO declarado é recusado", () => {
    // Sem isto, `soDoUmbrella("qualquer/coisa")` viraria um `if (!existe) return` com nome bonito, e a
    // lista deixaria de ser o registro completo do que não viaja.
    expect(() => soDoUmbrella("scripts/deploy/qualquer-outro.mjs", arvoreFalsa("extraido"))).toThrow(
      /não está declarado em SO_DO_UMBRELLA/,
    );
  });
});

describe("produtoresDaPublicacao() — o gate tem quem o execute NESTA árvore", () => {
  const produtores = produtoresDaPublicacao();

  it("existe ao menos um produtor, e todos invocam o gate", () => {
    expect(
      produtores.length,
      `nenhum produtor do gate de publicação nesta árvore (${arvore()}). O gate voltou a ser capacidade ` +
        `declarada com zero produtores — ninguém varre a árvore antes de publicá-la.`,
    ).toBeGreaterThan(0);
    for (const p of produtores) expect(p.corpo, `${p.nome} não invoca o gate`).toContain(GATE_DE_PUBLICACAO);
  });

  it("o CI que VIAJA é sempre um dos produtores (é o único do repo público)", () => {
    // Vale nas duas árvores: `oss/ci/workflows/` viaja. Se o passo do workflow perder o gate, o repo
    // extraído nasce sem NENHUM produtor — e o caso acima passaria no umbrella pelo justfile.
    expect(
      produtores.map((p) => p.nome).filter((n) => n.startsWith("oss/ci/workflows/")),
      "nenhum workflow do artefato de CI invoca o gate de publicação",
    ).not.toEqual([]);
  });

  it("cada produtor traz um comando executável de uma linha", () => {
    for (const p of produtores) {
      expect(p.comando.length, `${p.nome} sem comando`).toBeGreaterThan(0);
      expect(p.comando.join(" ")).not.toContain("\n");
      expect(p.comando.join(" ")).not.toContain("{{ARGS}}");
    }
  });
});

describe("substituicoesDaPublicacao() — o que a extração REMOVE do fecho, por árvore", () => {
  it("nesta árvore o conjunto é coerente com o que ela é", () => {
    const subs = substituicoesDaPublicacao();
    if (arvore() === "extraido") {
      // O artefato já tem o override aplicado no package.json: o disco DELE é o fecho publicado, e
      // simular substituição ali subtrairia do gate de licença a única medição que vale.
      expect(subs.size).toBe(0);
      return;
    }
    // No umbrella o conjunto sai de `DA_EXTRACAO`, e todo valor tem de ser um `npm:<stub>` — é o que
    // caracteriza REMOÇÃO. Override que sobe versão não muda quem está no fecho.
    expect(subs.size).toBeGreaterThan(0);
    for (const [nome, valor] of subs) {
      expect(valor, `${nome} entrou como substituição mas não é um override npm:`).toMatch(/^npm:/);
    }
  });

  it("lê o extrator DE VERDADE: só entram os `npm:`, e o nome vem de lá — não de uma lista aqui", () => {
    const raiz = arvoreFalsa("umbrella", {
      "oss/extract.sh":
        "#!/usr/bin/env bash\n" +
        'const DA_EXTRACAO = { postcss: "8.5.26", "algum-pacote": "npm:@favware/skip-dependency@1.2.2" };\n',
    });
    const subs = substituicoesDaPublicacao(raiz);
    expect([...subs.keys()]).toEqual(["algum-pacote"]);
    expect(subs.get("algum-pacote")).toBe("npm:@favware/skip-dependency@1.2.2");
  });

  it("ATAQUE: extrator sem `DA_EXTRACAO` LANÇA — devolver vazio calaria o gate de licença", () => {
    // Vazio em silêncio faria o gate medir a árvore errada e chamar isso de veredito: no umbrella a
    // LGPL do `sharp` reapareceria e o gate reprovaria por um motivo que não é o dele.
    const raiz = arvoreFalsa("umbrella", { "oss/extract.sh": "#!/usr/bin/env bash\necho oi\n" });
    expect(() => substituicoesDaPublicacao(raiz)).toThrow(/DA_EXTRACAO/);
  });
});

describe("os dois extratores de receita (é sobre eles que os testes de produtor asseram)", () => {
  it("receitaDoJustfile pega só o corpo indentado do alvo pedido", () => {
    const jf = ["outro:\n  @echo nao\n", `${ALVO_DA_PUBLICACAO} *ARGS:`, `  @node ${GATE_DE_PUBLICACAO} --x`, "", "depois:", "  @echo nao"].join("\n");
    const corpo = receitaDoJustfile(jf, ALVO_DA_PUBLICACAO);
    expect(corpo).toContain(GATE_DE_PUBLICACAO);
    expect(corpo).not.toContain("echo nao");
    expect(receitaDoJustfile(jf, "alvo-que-nao-existe")).toBe("");
  });

  it("comandoDe desdobra o escalar do YAML e limpa `@`/`{{ARGS}}`", () => {
    expect(comandoDe(["        run: >-", `          node ${GATE_DE_PUBLICACAO}`, "          --exclude-from .ossignore", "          --tracked-only"].join("\n"))).toBe(
      `node ${GATE_DE_PUBLICACAO} --exclude-from .ossignore --tracked-only`,
    );
    expect(comandoDe(`  @node ${GATE_DE_PUBLICACAO} --tracked-only {{ARGS}}`)).toBe(
      `node ${GATE_DE_PUBLICACAO} --tracked-only`,
    );
  });
});
