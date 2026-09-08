// ATAQUE: uma dependência entra em `node_modules` SEM constar do lockfile — e escapa do SCA inteiro.
//
// Todo scanner popular (npm audit, Dependabot, a maioria dos plugins de CI) lê o LOCKFILE, não a árvore.
// Quem consegue escrever em `node_modules` — um `postinstall` de dependência transitiva, um `bun add`
// desfeito pela metade, um tarball trocado num registry espelhado — planta código que EXECUTA em produção
// e não aparece em relatório nenhum. Não é hipótese: neste checkout há 28 pacotes instalados e ausentes do
// `bun.lock` (medido; detalhe em storymap/boards/storymap/cards/story-0ey41q.md).
//
// O controle: o SBOM é medido na ÁRVORE (resolução de módulo de verdade, subindo os `node_modules` como o
// Node sobe), e o pacote que está no disco e não no lockfile é REPORTADO como divergência — não silenciado.
// Um SBOM derivado do lockfile passaria verde nos dois testes de divergência abaixo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const SBOM = path.join(REPO_ROOT, "scripts/security/generate-sbom.mjs");

let arvores: string[] = [];

afterEach(() => {
  for (const dir of arvores) rmSync(dir, { recursive: true, force: true });
  arvores = [];
});

type Manifesto = Record<string, unknown>;

/** Uma árvore de mentira: pacote-alvo + os pacotes instalados em `node_modules` (hoisted, como o bun faz). */
function arvore(opts: {
  alvo: Manifesto;
  instalados: Record<string, Manifesto>;
  /** Conteúdo do lockfile. Ausente = sem lockfile (o gate tem de dizer isso, não fingir que conferiu). */
  lockfile?: string;
  /** Pacotes aninhados: "a/node_modules/b" → manifesto. */
  aninhados?: Record<string, Manifesto>;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-sbom-"));
  arvores.push(dir);
  const pkgDir = path.join(dir, "packages/alvo");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(opts.alvo, null, 2));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "raiz", private: true }, null, 2));
  for (const [nome, manifesto] of Object.entries(opts.instalados)) {
    const d = path.join(dir, "node_modules", nome);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "package.json"), JSON.stringify(manifesto, null, 2));
  }
  for (const [rel, manifesto] of Object.entries(opts.aninhados ?? {})) {
    const d = path.join(dir, "node_modules", rel);
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "package.json"), JSON.stringify(manifesto, null, 2));
  }
  if (opts.lockfile !== undefined) writeFileSync(path.join(dir, "bun.lock"), opts.lockfile);
  return dir;
}

function sbom(root: string, args: string[] = []) {
  const r = execFileSync(process.execPath, [SBOM, "--root", root, "--pkg", "packages/alvo", ...args], {
    encoding: "utf8",
  });
  return JSON.parse(r);
}

/** Lockfile no formato do bun (JSONC com chaves "name@version"). Só o que o gate precisa ler. */
function bunLock(chaves: string[]): string {
  const pkgs = chaves.map((k) => `    "${k.split("@").slice(0, -1).join("@")}": ["${k}", {}, ""],`).join("\n");
  return `{\n  "lockfileVersion": 1,\n  "packages": {\n${pkgs}\n  }\n}\n`;
}

describe("SBOM medido na ÁRVORE — o pacote fora do lockfile não escapa (story-5oestw)", () => {
  it("ATAQUE: pacote instalado e AUSENTE do lockfile aparece no SBOM e é reportado como divergência", () => {
    // `implante` está no disco e resolve pelo Node — logo executa. Só não está no lockfile.
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { legitima: "^1.0.0" } },
      instalados: {
        legitima: { name: "legitima", version: "1.2.3", dependencies: { implante: "^9.0.0" } },
        implante: { name: "implante", version: "9.9.9" },
      },
      lockfile: bunLock(["legitima@1.2.3"]),
    });

    const s = sbom(root, ["--summary"]);
    const nomes = s.components.map((c: { name: string }) => c.name);
    expect(nomes, "um SBOM derivado do lockfile não veria `implante`").toContain("implante");
    expect(s.lockfileDrift).toContain("implante@9.9.9");
    expect(s.lockfileDrift).not.toContain("legitima@1.2.3");
  });

  it("SEM lockfile o gate DECLARA que não conferiu — nunca reporta zero divergências", () => {
    // Zero divergências e "não havia com o que comparar" são estados diferentes. Confundi-los é o mesmo
    // erro do gate que libera o que não varreu: confiança falsa no momento em que ela custa.
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { legitima: "^1.0.0" } },
      instalados: { legitima: { name: "legitima", version: "1.2.3" } },
    });
    const s = sbom(root, ["--summary"]);
    expect(s.lockfileCompared).toBe(false);
    expect(s.lockfileDrift).toBeNull();
  });

  it("a resolução sobe os node_modules como o Node sobe — versão ANINHADA vence a hoisted", () => {
    // Sem isto o SBOM reporta a versão errada e o SCA consulta a versão errada: o advisory da versão que
    // realmente executa não é encontrado. É a falha mais silenciosa possível — relatório verde, código velho.
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { a: "^1.0.0" } },
      instalados: {
        a: { name: "a", version: "1.0.0", dependencies: { vuln: "^1.0.0" } },
        vuln: { name: "vuln", version: "2.0.0" },
      },
      aninhados: { "a/node_modules/vuln": { name: "vuln", version: "1.0.1" } },
    });
    const s = sbom(root, ["--summary"]);
    const versoes = s.components
      .filter((c: { name: string }) => c.name === "vuln")
      .map((c: { version: string }) => c.version)
      .sort();
    expect(versoes).toEqual(["1.0.1"]);
  });

  it("dependência DECLARADA e não instalada é `missing`, não omissão silenciosa", () => {
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { fantasma: "^1.0.0" } },
      instalados: {},
    });
    const s = sbom(root, ["--summary"]);
    expect(s.missing).toContain("fantasma");
  });

  it("devDependency do ALVO entra com escopo `optional`; devDependency de TRANSITIVA não entra", () => {
    // O npm não instala devDeps de transitivas — incluí-las inflaria o SBOM com pacotes que não existem no
    // disco e produziria advisories fantasma (o oposto do ruído que este card combate).
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { a: "^1" }, devDependencies: { ferramenta: "^1" } },
      instalados: {
        a: { name: "a", version: "1.0.0", devDependencies: { naoInstalada: "^1" } },
        ferramenta: { name: "ferramenta", version: "3.0.0" },
        naoInstalada: { name: "naoInstalada", version: "1.0.0" },
      },
      lockfile: bunLock(["a@1.0.0", "ferramenta@3.0.0", "naoInstalada@1.0.0"]),
    });
    const s = sbom(root, ["--summary"]);
    const porNome = new Map<string, { name: string; scope: string }>(
      s.components.map((c: { name: string; scope: string }) => [c.name, c]),
    );
    expect(porNome.get("ferramenta")?.scope).toBe("optional");
    expect(porNome.get("a")?.scope).toBe("required");
    expect(porNome.has("naoInstalada")).toBe(false);
  });

  it("o BOM padrão é CycloneDX 1.6 com purl e grafo de dependências (consumível por Grype/Trivy)", () => {
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { "@escopo/a": "^1" } },
      instalados: { "@escopo/a": { name: "@escopo/a", version: "1.0.0", license: "MIT" } },
      lockfile: bunLock(["@escopo/a@1.0.0"]),
    });
    const bom = sbom(root);
    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.6");
    const comp = bom.components.find((c: { name: string }) => c.name === "@escopo/a");
    expect(comp.purl).toBe("pkg:npm/%40escopo/a@1.0.0");
    expect(comp["bom-ref"]).toBe("pkg:npm/%40escopo/a@1.0.0");
    expect(comp.licenses).toEqual([{ license: { id: "MIT" } }]);
    const raiz = bom.dependencies.find((d: { ref: string }) => d.ref === bom.metadata.component["bom-ref"]);
    expect(raiz.dependsOn).toContain("pkg:npm/%40escopo/a@1.0.0");
  });

  it("ATAQUE: pacote plantado em node_modules que NENHUM manifesto declara — invisível ao fecho E ao lockfile", () => {
    // O caso do fecho (teste acima) cobre o pacote que ALGUÉM declara. Este é o outro: o intruso que nada
    // declara. Ele é invisível para os DOIS scanners que as pessoas rodam — não está no lockfile (logo
    // `npm audit` não o vê) e não está no grafo de dependências (logo um SBOM de fecho, inclusive o desta
    // ferramenta, não o vê). Mas está no disco, com código, alcançável por qualquer `require` dinâmico.
    // Medido neste checkout: 50 pacotes instalados no topo estão fora do `bun.lock` — entre eles
    // `just-install@2.0.2`, que este repositório já pagou para descobrir (ele engole o `just` do PATH).
    // O escopo `installDrift` existe para que esse conjunto tenha um lugar onde apareça.
    const root = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: { legitima: "^1.0.0" } },
      instalados: {
        legitima: { name: "legitima", version: "1.2.3" },
        intruso: { name: "intruso", version: "0.0.1" },
      },
      lockfile: bunLock(["legitima@1.2.3"]),
    });

    const s = sbom(root, ["--summary"]);
    expect(s.components.map((c: { name: string }) => c.name)).not.toContain("intruso");
    expect(s.lockfileDrift, "o fecho não o alcança — por isso o escopo do fecho NÃO pode ser a única régua").toEqual(
      [],
    );
    expect(s.installDrift).toContain("intruso@0.0.1");
  });

  it("o pacote de workspace (primeira-parte) não conta como divergência de instalação", () => {
    // Todo pacote do próprio monorepo aparece em `node_modules` por symlink e nunca está no lockfile como
    // versão publicada. Contá-los tornaria a divergência permanentemente ruidosa — e uma métrica sempre
    // vermelha é uma métrica que ninguém lê.
    const dir = arvore({
      alvo: { name: "alvo", version: "1.0.0", dependencies: {} },
      instalados: {},
      lockfile: bunLock([]),
    });
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    mkdirSync(path.join(dir, "packages/interno"), { recursive: true });
    writeFileSync(
      path.join(dir, "packages/interno/package.json"),
      JSON.stringify({ name: "interno", version: "9.9.9" }),
    );
    execFileSync("ln", ["-s", path.join(dir, "packages/interno"), path.join(dir, "node_modules/interno")]);

    const s = sbom(dir, ["--summary"]);
    expect(s.installDrift).toEqual([]);
  });

  it("mede o fecho REAL do storymap-ui neste checkout (é o alvo que o card orça)", () => {
    const s = JSON.parse(
      execFileSync(process.execPath, [SBOM, "--pkg", "packages/storymap-ui", "--summary"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    // Ordem de grandeza medida na auditoria: 744 componentes. Um fecho que despenca para dezenas significa
    // que a resolução parou de subir os node_modules — o SBOM viraria uma lista curta e falsamente limpa.
    expect(s.total).toBeGreaterThan(600);
    expect(s.missing).toEqual([]);
  });
});
