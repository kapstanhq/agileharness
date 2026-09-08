import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import { SO_DO_UMBRELLA, arvore } from "@/lib/storymap/oss-tree";

// UMA SKILL NÃO PODE MANDAR RODAR UM COMANDO QUE A ÁRVORE DELA NÃO TEM.
//
// O defeito que este guarda existe para pegar (medido em 2026-08-19, na auditoria da extração): sete
// skills mandavam `just advance-card <board> <id>` — o gesto que AVANÇA o card, o coração da cascata
// autônoma — enquanto a régua da extração corta o `justfile` de propósito (ele é infra deste monorepo;
// está declarado em SO_DO_UMBRELLA com esse motivo). No artefato publicado as 23 skills viajavam e sete
// delas instruíam um comando inexistente. E o modo de falha é SILENCIOSO por natureza: quem executa é um
// agente headless dentro de um `Bash`, então o adotante não vê "command not found" — vê o card parado.
//
// A régua: para toda SKILL.md que VIAJA, nenhuma invocação de um executável que a régua não deixa viajar.
// A alternativa a este teste seria lembrar, a cada skill nova, que o justfile fica para trás — e "lembrar"
// já falhou sete vezes no mesmo dia.
//
// EXTRAÇÃO CONSERVADORA, de propósito: as skills são escritas em inglês, onde "just" é advérbio comum
// ("just add", "just the card"). Casar a palavra solta encheria isto de falso positivo e o guarda seria
// afrouxado no primeiro susto. Então só as DUAS notações canônicas de comando contam: linha dentro de
// bloco cercado (```) e trecho em crase (`just <receita>`).

const ROOT = findRepoRoot();
const SKILLS = path.join(ROOT, ".claude", "skills");
const OSSIGNORE = path.join(ROOT, ".ossignore");

/** Os executáveis que a régua NÃO deixa viajar, mapeados do arquivo que os define. */
const EXECUTAVEL_QUE_NAO_VIAJA: Record<string, string> = { justfile: "just" };

/**
 * DÍVIDA DECLARADA, e SÓ ENCOLHE — as receitas do PROJETO que algumas skills ainda chamam pelo nome.
 *
 * Por que elas não foram trocadas junto com o `advance-card`: são DUAS CLASSES diferentes de comando.
 *   · O gesto do PRÓPRIO harness (`advance-card`, subir o board) tem de funcionar em qualquer árvore,
 *     e por isso vira a invocação que viaja — foi o que esta onda fez.
 *   · A receita do PROJETO DO ADOTANTE (rodar os testes dele, deployar o app dele, ler os logs dele)
 *     NÃO tem invocação portátil: `just test-nestify` não vira `bun` nenhum, porque quem sabe como se
 *     testa aquele repositório é o repositório. A saída certa é a skill PERGUNTAR — o board declarar
 *     `commands.test`/`commands.deploy` e a skill ler dali —, e isso é desenho novo, não substituição.
 *
 * Enquanto esse desenho não existe, o número aqui é o teto: nenhuma skill pode ganhar mais uma receita
 * cravada, e uma entrada que zerar tem de SAIR da lista (senão a lista apodrece e para de medir).
 */
const RECEITAS_DO_PROJETO_DECLARADAS: Record<string, number> = {
  "harness-qa": 13,
  "harness-do": 3,
  "harness-ship": 2,
  "harness-tests": 1,
};

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32_000_000 });
}

function skillsNaArvore(): string[] {
  if (!existsSync(SKILLS)) return [];
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(".claude", "skills", d.name, "SKILL.md"))
    .filter((rel) => existsSync(path.join(ROOT, rel)));
}

/** As skills que VIAJAM: as da árvore menos as que a régua exclui (no artefato, a régua já não corta nada). */
function skillsQueViajam(): string[] {
  const todas = skillsNaArvore();
  if (!existsSync(OSSIGNORE)) return todas;
  const excluidas = new Set(
    git(["ls-files", "--cached", "--ignored", `--exclude-from=${OSSIGNORE}`]).split("\n").filter(Boolean),
  );
  return todas.filter((rel) => !excluidas.has(rel));
}

/** As invocações de `<exe> <algo>` nas duas notações canônicas de comando. */
function invocacoes(md: string, exe: string): string[] {
  const achadas: string[] = [];
  let dentroDeBloco = false;
  for (const linha of md.split("\n")) {
    if (linha.trim().startsWith("```")) {
      dentroDeBloco = !dentroDeBloco;
      continue;
    }
    if (dentroDeBloco) {
      const t = linha.trim().replace(/^\$\s+/, "");
      if (new RegExp(`^${exe}\\s+[a-z]`).test(t)) achadas.push(t);
      continue;
    }
    for (const m of linha.matchAll(new RegExp("`" + exe + "\\s+([a-z][\\w-]*)", "g"))) {
      achadas.push(`${exe} ${m[1]}`);
    }
  }
  return achadas;
}

describe("comando de skill × o que a árvore publicada contém", () => {
  it("PREMISSA: a régua declara que o justfile não viaja (senão este guarda não tem o que cobrar)", () => {
    expect(Object.keys(SO_DO_UMBRELLA)).toContain("justfile");
    expect(SO_DO_UMBRELLA.justfile).toMatch(/não viaja|exclui/i);
  });

  /** Quantas invocações não-portáveis cada skill que viaja ainda tem. */
  function contagemPorSkill(): Map<string, string[]> {
    const porSkill = new Map<string, string[]>();
    for (const rel of skillsQueViajam()) {
      const md = readFileSync(path.join(ROOT, rel), "utf8");
      const nome = path.basename(path.dirname(rel));
      for (const [arquivo, exe] of Object.entries(EXECUTAVEL_QUE_NAO_VIAJA)) {
        for (const inv of invocacoes(md, exe)) {
          const lista = porSkill.get(nome) ?? [];
          lista.push(`${rel}: "${inv}" — \`${exe}\` vem de \`${arquivo}\`, que não viaja`);
          porSkill.set(nome, lista);
        }
      }
    }
    return porSkill;
  }

  it("nenhuma skill que VIAJA instrui um executável que a régua deixa para trás", () => {
    const porSkill = contagemPorSkill();
    const violacoes: string[] = [];
    for (const [nome, lista] of porSkill) {
      const teto = RECEITAS_DO_PROJETO_DECLARADAS[nome] ?? 0;
      if (lista.length > teto) violacoes.push(...lista.slice(teto));
    }
    expect(
      violacoes.join("\n"),
      "skill publicada instruindo um comando que não existe na árvore publicada. O agente que a executa " +
        "é headless: a falha não aparece como erro na tela, aparece como card parado. Use a invocação que " +
        "VIAJA (ex.: `bun packages/storymap-ui/scripts/advance-card.ts <board> <id>`, a que o próprio " +
        "script documenta) ou faça a ferramenta viajar.",
    ).toBe("");
  });

  it("a dívida declarada SÓ ENCOLHE — e uma entrada que zerou tem de sair da lista", () => {
    const porSkill = contagemPorSkill();
    const apodrecidas = Object.keys(RECEITAS_DO_PROJETO_DECLARADAS).filter(
      (nome) => (porSkill.get(nome)?.length ?? 0) === 0,
    );
    expect(
      apodrecidas.join(", "),
      "skill declarada na dívida que já não tem receita cravada nenhuma — remova a entrada, senão a " +
        "lista vira teto para uma regressão futura em vez de medida do que falta.",
    ).toBe("");
    const excedidas = Object.entries(RECEITAS_DO_PROJETO_DECLARADAS)
      .filter(([nome, teto]) => (porSkill.get(nome)?.length ?? 0) > teto)
      .map(([nome, teto]) => `${nome}: ${porSkill.get(nome)?.length} > ${teto}`);
    expect(excedidas.join(", "), "a dívida declarada CRESCEU").toBe("");
  });

  it("NÃO-VACUIDADE: a varredura leu skills de verdade, e o extrator de comando ACUSA quando há o que acusar", () => {
    const viajam = skillsQueViajam();
    expect(viajam.length).toBeGreaterThan(15);
    expect(viajam).toContain(path.join(".claude", "skills", "harness-do", "SKILL.md"));

    // Controle do instrumento nas duas notações — e a prova de que o advérbio inglês NÃO conta.
    const md = [
      "```bash",
      "just advance-card acme story-1",
      "```",
      "advance ONLY via `just advance-card`; never hand-edit.",
      "You should just add the field and move on.",
      "Run `bun packages/storymap-ui/scripts/advance-card.ts acme story-1` instead.",
    ].join("\n");
    expect(invocacoes(md, "just")).toEqual(["just advance-card acme story-1", "just advance-card"]);
  });

  // `skipIf`, não um `return` mudo: a suíte roda com `requireAssertions`, e um caso que sai sem
  // afirmar nada é REPROVADO — de propósito. No artefato não há o que cortar (o corte já aconteceu),
  // e um pulo EXPLÍCITO aparece no relatório, enquanto um return silencioso viraria verde de graça.
  it.skipIf(arvore(ROOT) !== "umbrella")(
    "NÃO-VACUIDADE (umbrella): a régua está de fato cortando skills — senão 'o que viaja' seria tudo",
    () => {
      expect(skillsNaArvore().length).toBeGreaterThan(skillsQueViajam().length);
    },
  );
});
