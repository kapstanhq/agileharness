// F0 / ADR-067 — A SENTINELA DO FALLBACK SILENCIOSO.
//
// Este arquivo existe por causa de um par específico, que o inventário do plano multi-target nomeia como
// o mais perigoso do sistema: **resolução de raiz que nunca falha alto + operação destrutiva sobre o
// resultado**. `findRepoRoot()` caía, sem log, em `resolve(cwd, "..", "..")`; e quem consome o resultado
// inclui os reapers de boot, que rodam `git branch -D` e `git worktree remove --force`. Num checkout sem o
// marcador — o caso de QUALQUER repositório que não seja este monorepo — a ferramenta apontava para o
// diretório PAI e apagava branch lá.
//
// A regressão que estes testes impedem não é hipotética: era o comportamento vigente até F0.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findRepoRoot, RepoRootUnresolvedError, resetRepoRootCache } from "./paths";

const PATHS_SRC = path.join(__dirname, "paths.ts");

/**
 * Todo diretório temporário criado por um teste deste arquivo passa por aqui — e o `afterEach` abaixo
 * o remove. Sem isso cada passada da suíte deixava 5 diretórios órfãos em /tmp, e o portão roda muitas
 * vezes por dia: era a maior fonte isolada das ~84 mil entradas acumuladas lá.
 */
const temporarios: string[] = [];
function tmpDescartavel(prefixo: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefixo));
  temporarios.push(dir);
  return dir;
}

afterEach(() => {
  resetRepoRootCache();
  delete process.env.AGILEHARNESS_TARGET;
  // DEPOIS do restore de cwd/env (que os próprios testes fazem no `finally`): remover antes de um
  // chdir de volta trocaria lixo em /tmp por falha intermitente de escrita.
  while (temporarios.length > 0) {
    const dir = temporarios.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("o fallback silencioso está MORTO (e não pode voltar por descuido)", () => {
  it("a FONTE de paths.ts não contém mais o palpite `cwd/../..`", () => {
    // Asserção sobre a fonte, de propósito: um teste de comportamento pode ser satisfeito por acaso
    // (um cwd que por sorte resolve), mas o literal reintroduzido no código é inequívoco.
    const src = readFileSync(PATHS_SRC, "utf8");
    expect(src).not.toMatch(/resolve\(\s*process\.cwd\(\)\s*,\s*["']\.\.["']\s*,\s*["']\.\.["']\s*\)/);
  });

  it("uma raiz não resolvida LANÇA — e o erro diz onde procurou", () => {
    // Um diretório temporário fora de qualquer repositório: sem `.git`, sem `turbo.json`.
    const orphan = tmpDescartavel("ah-orphan-");
    const prev = process.cwd();
    try {
      process.chdir(orphan);
      resetRepoRootCache();
      expect(() => findRepoRoot()).toThrow(RepoRootUnresolvedError);
      // O erro precisa ser ACIONÁVEL: quem lê tem de saber o que foi procurado e o que declarar.
      try {
        findRepoRoot();
      } catch (err) {
        const msg = String(err);
        expect(msg).toMatch(/turbo\.json|\.git/);
        expect(msg).toMatch(/AGILEHARNESS_TARGET/);
      }
    } finally {
      process.chdir(prev);
      resetRepoRootCache();
    }
  });

  it("NUNCA resolve para o diretório PAI de um órfão — a falha exata que apagava branch alheio", () => {
    const orphan = tmpDescartavel("ah-orphan-");
    const nested = path.join(orphan, "a", "b");
    mkdirSync(nested, { recursive: true });
    const prev = process.cwd();
    try {
      process.chdir(nested);
      resetRepoRootCache();
      let resolved: string | null = null;
      try {
        resolved = findRepoRoot();
      } catch {
        /* esperado */
      }
      expect(resolved).toBeNull(); // e NÃO `orphan/a`, que era o que o fallback devolvia
    } finally {
      process.chdir(prev);
      resetRepoRootCache();
    }
  });
});

describe("declaração explícita vence — e é validada, não confiada", () => {
  it("AGILEHARNESS_TARGET com marcador resolve — a declaração é honrada", () => {
    const target = tmpDescartavel("ah-target-");
    writeFileSync(path.join(target, ".git"), "gitdir: /outro/lugar\n", "utf8"); // worktree linkado: `.git` é ARQUIVO
    process.env.AGILEHARNESS_TARGET = target;
    resetRepoRootCache();
    // realpath: no macOS /tmp é symlink para /private/tmp e o resolve normaliza.
    expect(findRepoRoot()).toBe(path.resolve(target));
  });

  it("AGILEHARNESS_TARGET SEM marcador LANÇA — este teste foi INVERTIDO, e o porquê importa", () => {
    // ⚠ A versão anterior se chamava "resolve mesmo sem marcador nenhum" e AFIRMAVA o comportamento
    // permissivo. Uma revisão mostrou o que isso custava: `AGILEHARNESS_TARGET=<repo>/packages` é um
    // diretório que existe, passava, virava `cachedRoot`, e a partir dali `instrumentation.ts` e
    // `recovery.ts` rodam `git branch -D` e `git worktree remove --force` com cwd nesse caminho — o git
    // resolve para CIMA e as operações atingiriam o repositório PAI.
    //
    // Ou seja: a porta DECLARADA reintroduzia o risco nº 1 que a busca por marcador acabara de fechar,
    // e com um agravante — aqui o operador acredita ter declarado a raiz certa. Uma prova que cimenta
    // a permissividade é pior que a ausência dela, porque dá confiança.
    const target = tmpDescartavel("ah-target-sem-marcador-");
    process.env.AGILEHARNESS_TARGET = target;
    resetRepoRootCache();
    expect(() => findRepoRoot()).toThrow(RepoRootUnresolvedError);
  });

  it("AGILEHARNESS_TARGET inexistente LANÇA em vez de cair na busca", () => {
    // Se um typo no env degradasse para a busca, o operador acharia que declarou a raiz e estaria
    // rodando contra outra — que é a classe inteira que F0 remove.
    process.env.AGILEHARNESS_TARGET = path.join(os.tmpdir(), "nao-existe-ah-" + Date.now());
    resetRepoRootCache();
    expect(() => findRepoRoot()).toThrow(RepoRootUnresolvedError);
  });
});

describe("o módulo de deploy não derruba o boot num alvo que não é este monorepo", () => {
  it("importar product-deploy sem o manifesto da face NÃO lança", async () => {
    // Era um `readFileSync` + `throw` em MODULE LOAD, na cadeia de import do dispatcher: o primeiro erro
    // que qualquer segundo target produzia, antes de qualquer código multi-target rodar.
    const orphan = tmpDescartavel("ah-noface-");
    const prev = process.cwd();
    try {
      process.chdir(orphan);
      resetRepoRootCache();
      const mod = await import("./runner/product-deploy");
      // A propriedade que este teste protege é UMA: o import NÃO derruba o boot. Era um throw em module
      // load, e é o primeiro erro que qualquer segundo alvo produzia.
      expect(mod).toBeTruthy();
      expect(mod.composedFacePrefixes()).toEqual([]);
      // ⚠ E o desfecho é CONSERVADOR, não "não toca". Com a raiz não resolvida o status é `unreadable`
      // (NÃO SABEMOS), e o consumidor assume que o diff toca a face — porque um "não toca" aqui
      // publicaria uma face velha como se estivesse no ar, que é exatamente o buraco que o throw
      // original protegia. A versão anterior deste teste afirmava `false`, e afirmava o buraco.
      expect(mod.composedFaceManifestStatus()).toBe("unreadable");
      expect(mod.touchesComposedFace(["packages/qualquer/web/x.ts"])).toBe(true);
    } finally {
      process.chdir(prev);
      resetRepoRootCache();
    }
  });
});

// ─── O ADOTANTE QUE BAIXOU O ZIP (2026-08-19) ───────────────────────────────────────────────────
//
// Quem clica em "Download ZIP" no GitHub não recebe `.git`; e o artefato publicado também não tem
// `turbo.json` (a régua da extração corta a infra do monorepo). MEDIDO na árvore extraída: a
// ferramenta não subia — e a saída que o PRÓPRIO erro sugeria (`AGILEHARNESS_TARGET=$PWD`, exatamente o
// que o README mandava) falhava igual, porque o caminho declarado é cobrado do mesmo marcador. O
// primeiro contato do projeto era um beco sem saída.
//
// `storymap/boards` fecha o beco sem reabrir o risco que este arquivo inteiro existe para impedir:
// sem `.git` no lugar resolvido, o portão do boot decide INERTE, então nenhuma operação destrutiva de
// git chega a existir sobre essa raiz.
describe("a árvore SEM .git (ZIP baixado) é encontrada pela própria pasta de boards", () => {
  function arvoreDeZip(): string {
    const raiz = tmpDescartavel("ah-zip-");
    mkdirSync(path.join(raiz, "storymap", "boards", "demo"), { recursive: true });
    writeFileSync(path.join(raiz, "storymap", "boards", "demo", "board.yaml"), "id: demo\n");
    mkdirSync(path.join(raiz, "packages", "storymap-ui", "src"), { recursive: true });
    return raiz;
  }

  it("resolve a raiz a partir de dentro do pacote, subindo até `storymap/boards`", () => {
    const raiz = arvoreDeZip();
    const antes = process.cwd();
    try {
      process.chdir(path.join(raiz, "packages", "storymap-ui"));
      resetRepoRootCache();
      // realpath: em macOS /tmp é link para /private/tmp e o cwd volta resolvido.
      expect(realpathSync(findRepoRoot())).toBe(realpathSync(raiz));
    } finally {
      process.chdir(antes);
      resetRepoRootCache();
    }
  });

  it("AGILEHARNESS_TARGET apontando para essa raiz é HONRADO — a saída que o erro sugere funciona", () => {
    const raiz = arvoreDeZip();
    process.env.AGILEHARNESS_TARGET = raiz;
    resetRepoRootCache();
    expect(realpathSync(findRepoRoot())).toBe(realpathSync(raiz));
  });

  it("[ATAQUE] o marcador novo NÃO promove uma SUBPASTA a raiz — a recusa continua de pé", () => {
    // A régua que não pode afrouxar: declarar uma subpasta como alvo é recusado porque as operações de
    // git resolvem para CIMA e atingiriam o repositório de fora. `packages/storymap-ui` não tem
    // `storymap/boards`, então o marcador novo não lhe dá passagem.
    const raiz = arvoreDeZip();
    process.env.AGILEHARNESS_TARGET = path.join(raiz, "packages", "storymap-ui");
    resetRepoRootCache();
    expect(() => findRepoRoot()).toThrow(RepoRootUnresolvedError);
  });

  it("uma árvore sem NENHUM dos três marcadores continua LANÇANDO, com os três nomeados", () => {
    const orfa = tmpDescartavel("ah-orfa-");
    const antes = process.cwd();
    try {
      process.chdir(orfa);
      resetRepoRootCache();
      expect(() => findRepoRoot()).toThrow(/turbo\.json ou \.git ou storymap\/boards/);
    } finally {
      process.chdir(antes);
      resetRepoRootCache();
    }
  });
});
