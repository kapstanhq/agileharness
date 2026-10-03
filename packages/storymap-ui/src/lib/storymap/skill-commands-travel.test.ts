import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";

// UMA SKILL NÃO PODE MANDAR RODAR UM COMANDO QUE A ÁRVORE DELA NÃO TEM.
//
// O defeito que este guarda existe para pegar (medido na auditoria da extração): sete
// skills mandavam `just advance-card <board> <id>` — o gesto que AVANÇA o card, o coração da cascata
// autônoma — enquanto a régua da extração corta o `justfile` de propósito (ele é infra deste monorepo;
// está declarado como infra do repositório de origem, com esse motivo). No artefato publicado as 23 skills viajavam e sete
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

/** Os executáveis que NÃO existem neste repositório (o `justfile` era do repositório de origem). */
const EXECUTAVEL_QUE_NAO_VIAJA: Record<string, string> = { justfile: "just" };

// A DÍVIDA DECLARADA ACABOU. Esta tabela carregava, por skill, quantas receitas do PROJETO (`just test-<pkg>`…) ainda
// estavam cravadas (qa 13, do 3, tests 1) — um teto que só encolhia. Elas foram trocadas por NOMES de check do perfil do
// alvo (`target_profile`), e a régua passou para skill-tooling-neutral.test.ts, que mede o vocabulário inteiro com teto
// ZERO. Aqui o teto é zero também: nenhuma skill instrui um executável que a árvore publicada deixa para trás.

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

/** As skills publicadas são TODAS as da árvore — a segunda árvore saiu (issue #1). */
function skillsQueViajam(): string[] {
  return skillsNaArvore();
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
    for (const lista of porSkill.values()) violacoes.push(...lista);
    expect(
      violacoes.join("\n"),
      "skill publicada instruindo um comando que não existe na árvore publicada. O agente que a executa " +
        "é headless: a falha não aparece como erro na tela, aparece como card parado. Use a invocação que " +
        "VIAJA (ex.: `bun packages/storymap-ui/scripts/advance-card.ts <board> <id>`, a que o próprio " +
        "script documenta) ou faça a ferramenta viajar.",
    ).toBe("");
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

});
