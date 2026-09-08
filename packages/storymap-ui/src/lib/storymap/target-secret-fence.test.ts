// FASE 4 — A CERCA CHEGA NA ÁRVORE DO ALVO.
//
// `oss-secret-hygiene.test.ts` mede a cerca DENTRO do repositório extraído. É o guarda certo para a
// pergunta "o artefato publicado protege a si mesmo?" — e ele não tem como responder a outra
// pergunta, que só existe desde que a ferramenta passou a operar árvore alheia: "o REPOSITÓRIO DO
// ADOTANTE fica protegido?". Sob `STORYMAP_TARGET`, `storymap/.runner/` nasce lá, e lá não há
// `.gitignore` nenhum da nossa parte.
//
// MEDIDO NUM ADOTANTE REAL (teste de adoção, 2026-08-21): um clone virgem de um app Next.js de
// terceiro, um único `--generate-mcp-handle`, e `git status` mostrava `?? storymap/` com
// `mcp-handles.json` dentro — `check-ignore` respondendo que NENHUM padrão o cobria, antes mesmo de
// qualquer serviço subir. O README, na mesma página, convida a versionar `storymap/`.
//
// O QUE ESTE ARQUIVO MEDE, e é diferente de "o arquivo foi escrito": ele cobra do GIT que os cinco
// segredos passem a ser ignorados. Um teste que só verificasse a existência de `storymap/.gitignore`
// passaria com um arquivo vazio.
import { exec as nodeExec } from "node:child_process";
import { promises as fsp, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FENCE_ABRE, ensureTargetFence, resetTargetFenceCache } from "./target-fence";
import { isolatedGitExec } from "./runner/git-test-env";
import { describePosix } from "./runner/test-platform";
import type { ExecFn } from "./runner/worktree";

let exec = promisify(nodeExec) as unknown as ExecFn;

/**
 * Os cinco caminhos que a ferramenta MEDIDAMENTE escreve na árvore do alvo. Se um dia nascer um
 * sexto fora de `.runner/`, é aqui que a lista mente — e é de propósito que ela seja explícita:
 * um teste que derivasse os caminhos da mesma constante que o código usa não mediria nada.
 */
const SEGREDOS = [
  "storymap/.runner/auth-token",
  "storymap/.runner/session-secret",
  "storymap/.runner/mcp-token",
  "storymap/.runner/mcp-handles.json",
  "storymap/.runner/sessions/abc.mcp.json",
];

describePosix("a cerca de segredo chega na árvore do ALVO (fase 4)", () => {
  let tmpRoot: string;
  let repo: string;
  let n = 0;

  const git = async (cmd: string) => (await exec(`git ${cmd}`, { cwd: repo })).stdout.trim();

  /** exit 0 = ignorado · 1 = descoberto · outro = instrumento quebrado (não é resposta). */
  const ignorado = async (rel: string): Promise<boolean> => {
    try {
      await exec(`git check-ignore --no-index -q -- ${rel}`, { cwd: repo });
      return true;
    } catch (e) {
      const st = (e as { code?: number }).code;
      if (st === 1) return false;
      throw new Error(`check-ignore devolveu ${st} para ${rel} — instrumento quebrado, não resposta`);
    }
  };

  beforeEach(async () => {
    resetTargetFenceCache();
    if (!tmpRoot) {
      tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ah-cerca-"));
      exec = isolatedGitExec(exec, tmpRoot);
    }
    // Um repositório NOVO por caso: a cerca é um efeito de escrita única, e casos que a
    // compartilhassem mediriam a ordem em que rodaram.
    repo = path.join(tmpRoot, `adotante-${++n}`);
    await fsp.mkdir(path.join(repo, "src"), { recursive: true });
    await fsp.writeFile(path.join(repo, "src", "app.ts"), "export const a = 1;\n");
    // O `.gitignore` que um `create-next-app` deixa — nada sobre storymap, claro.
    await fsp.writeFile(path.join(repo, ".gitignore"), "node_modules\n.next\n");
    await git("init -q");
    await git("config user.email dev@exemplo.dev");
    await git("config user.name dev");
    await git("add -A");
    await git("commit -q --no-verify -m scaffold");
  });

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("CONTRAPROVA — sem a cerca, os cinco segredos são stageáveis no repo do adotante", async () => {
    for (const s of SEGREDOS) {
      expect(await ignorado(s), `${s} deveria estar DESCOBERTO antes da cerca`).toBe(false);
    }
  });

  it("semeia e o GIT passa a cobrir os cinco — a asserção é o efeito, não o arquivo", async () => {
    const antes = await Promise.all(SEGREDOS.map(ignorado));
    expect(antes, "contraprova dentro do próprio caso").toEqual(SEGREDOS.map(() => false));

    const v = ensureTargetFence({ alvo: repo });
    expect(v.acao).toBe("semeado");

    for (const s of SEGREDOS) {
      expect(await ignorado(s), `${s} deveria estar coberto DEPOIS da cerca`).toBe(true);
    }
  });

  it("não encosta em repositório JÁ coberto — zero churn no umbrella e no repo extraído", async () => {
    // O caso dos dois únicos repositórios que existem hoje: a cerca da raiz já alcança.
    await fsp.appendFile(path.join(repo, ".gitignore"), "storymap/.runner/\n");

    const v = ensureTargetFence({ alvo: repo });

    expect(v.acao).toBe("ja-coberto");
    expect(existsSync(path.join(repo, "storymap", ".gitignore"))).toBe(false);
  });

  it("é idempotente pela SENTINELA e nunca reescreve escolha alheia", async () => {
    ensureTargetFence({ alvo: repo });
    const arquivo = path.join(repo, "storymap", ".gitignore");
    const primeiro = readFileSync(arquivo, "utf8");
    expect(primeiro).toContain(FENCE_ABRE);

    // A segunda passada nem CHEGA à sentinela: a cerca que acabamos de escrever faz a sonda
    // responder "coberto", e o módulo sai antes de tocar em disco. É a rota mais barata, e a que
    // prova que o efeito pretendido aconteceu de verdade.
    resetTargetFenceCache();
    const v2 = ensureTargetFence({ alvo: repo });
    expect(v2.acao).toBe("ja-coberto");
    expect(readFileSync(arquivo, "utf8"), "segunda passada não pode mexer no arquivo").toBe(primeiro);

    // E o caso que importa de verdade: o operador ESVAZIOU o bloco de propósito. A sentinela
    // continua lá; reinserir a regra seria desfazer a decisão dele.
    const esvaziado = primeiro.replace(/^\.runner\/$/m, "# (removido de propósito)");
    await fsp.writeFile(arquivo, esvaziado);
    resetTargetFenceCache();
    const v3 = ensureTargetFence({ alvo: repo });
    expect(v3.acao).toBe("sentinela-presente");
    expect(readFileSync(arquivo, "utf8")).toBe(esvaziado);
  });

  it("preserva o `storymap/.gitignore` que o adotante já tinha — append, nunca reescrita", async () => {
    await fsp.mkdir(path.join(repo, "storymap"), { recursive: true });
    const meu = "# regra do adotante\nrascunhos/\n";
    await fsp.writeFile(path.join(repo, "storymap", ".gitignore"), meu);

    const v = ensureTargetFence({ alvo: repo });
    expect(v).toMatchObject({ acao: "semeado", criouArquivo: false });

    const depois = readFileSync(path.join(repo, "storymap", ".gitignore"), "utf8");
    expect(depois.startsWith(meu), "a regra do adotante tem de continuar no topo, intacta").toBe(true);
    expect(await ignorado("storymap/.runner/auth-token")).toBe(true);
    expect(await ignorado("storymap/rascunhos/x")).toBe(true);
  });

  it("alvo sem git: não escreve nada — não há índice onde vazar", async () => {
    const semGit = path.join(tmpRoot, `zip-${++n}`);
    await fsp.mkdir(semGit, { recursive: true });

    const v = ensureTargetFence({ alvo: semGit });

    expect(v.acao).toBe("sem-git");
    expect(existsSync(path.join(semGit, "storymap", ".gitignore"))).toBe(false);
  });

  it("instrumento quebrado NÃO vira resposta — e nada é escrito por adivinhação", () => {
    const v = ensureTargetFence({
      alvo: repo,
      // O `git` que não executou: sem `status`, o wrapper devolve -1. A lição que custou uma
      // medição inteira nesta casa é que isto NÃO pode ser lido como "não casou".
      sonda: { status: () => -1, saida: () => "" },
    });

    expect(v).toEqual({ acao: "instrumento-quebrado", status: -1 });
    expect(existsSync(path.join(repo, "storymap", ".gitignore"))).toBe(false);
  });

  it("avisa ALTO quando o segredo JÁ está versionado — ignorar depois não destrata", async () => {
    await fsp.mkdir(path.join(repo, "storymap", ".runner"), { recursive: true });
    await fsp.writeFile(path.join(repo, "storymap", ".runner", "auth-token"), "segredo\n");
    await git("add -f storymap/.runner/auth-token");
    await git("commit -q --no-verify -m 'ops'");

    const avisos: string[] = [];
    const v = ensureTargetFence({ alvo: repo, avisar: (m) => avisos.push(m) });

    expect(v.acao).toBe("semeado");
    expect(avisos.join("\n")).toMatch(/JÁ ESTÁ VERSIONADO/);
    expect(avisos.join("\n"), "sem a rotação, o adotante fica com falsa sensação de segurança").toMatch(
      /ROTACIONE/,
    );
    expect(avisos.join("\n")).toMatch(/git rm -r --cached/);
  });
});
