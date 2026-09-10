// ATAQUE: o gate de segredo do snapshot EXISTE, tem testes verdes — e nada o executa. Publica-se com a
// suíte verde e sem nenhuma varredura ter acontecido.
//
// Foi o estado medido: `scan-snapshot-secrets` não aparecia no justfile, nem em nenhum hook, nem em
// release.ts / publish-queue.ts / publish-git.ts / entry-effects.ts / deploy.ts. O único chamador era o
// teste do próprio gate — que o invoca DIRETO e por isso é estruturalmente incapaz de falhar por o gate
// estar desligado. Este repositório já pagou por esse padrão (capacidade DECLARADA com zero produtores).
//
// Estes testes são de PRODUTOR: eles não perguntam se o gate funciona (o snapshot-secret-gate.test.ts faz
// isso), perguntam se ALGUÉM o chama. Executam o alvo do justfile de ponta a ponta — nome do alvo, caminho
// do script, passagem de argumentos e propagação do exit code —, então desligar o gate fica vermelho aqui.
//
// ── E O PRÓPRIO TESTE DE PRODUTOR TINHA A MESMA DOENÇA, UMA CAMADA ACIMA ─────────────────────────────
//
// Ele procurava o produtor pelo nome do produtor DESTE monorepo: o alvo do `justfile`. Mas o justfile é
// infra do repositório de origem — enquanto ESTE ARQUIVO viaja. No repo público o
// arquivo morria em ENOENT; e no dia em que alguém "consertasse" o ENOENT com um return, o artefato
// publicado ficaria sem NENHUMA cobrança de que seu CI liga o gate. Capacidade declarada com zero
// produtores, de novo, agora do lado de lá.
//
// O produtor existe: o passo `oss-snapshot-gate` de `.github/workflows/ci.yml`,
// que o próprio comentário do workflow declara ser o equivalente do alvo do justfile, "mantidos em
// sincronia à mão porque `just` não é garantido no runner". Sincronia à mão sem guarda é divergência
// marcada. Então os casos abaixo passam a cobrar de CADA produtor da árvore (`produtoresDaPublicacao()`)
// — enumerados, nunca um nome fixo.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ALVO_DA_PUBLICACAO, GATE_DE_PUBLICACAO, comandoDe, produtoresDaPublicacao, WORKFLOWS_DIR } from "@/lib/storymap/oss-tree";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const GATE_REL = GATE_DE_PUBLICACAO;

/** O passo do CI que roda o gate sobre a árvore inteira. */
const ALVO_PUBLICACAO = ALVO_DA_PUBLICACAO;

// Credencial PLANTADA, montada em pedaços para o literal desta fonte não casar com a regra que ela
// exercita (senão este arquivo trancaria o pre-commit do repositório).
const PLANTADO = ["AK", "IA", "T5RJ7QW2XM9VZBND"].join("");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

let snapshots: string[] = [];

afterEach(() => {
  for (const dir of snapshots) rmSync(dir, { recursive: true, force: true });
  snapshots = [];
});

/** Um snapshot de publicação de mentira: repo git novo (como a extração o monta) com os arquivos dados. */
function snapshot(arquivos: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-snapshot-"));
  snapshots.push(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], { env: GIT_ENV });
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo, "utf8");
  }
  return dir;
}

/** Os produtores do gate de publicação NESTA árvore: cada passo de `.github/workflows/*.yml` que o invoca. */
const PRODUTORES = produtoresDaPublicacao(REPO_ROOT);

describe("gate do snapshot — está LIGADO (teste de produtor, story-jxwrsk)", () => {
  it("o gate existe como arquivo — se este caminho mudar, os alvos abaixo mentem", () => {
    expect(existsSync(path.join(REPO_ROOT, GATE_REL))).toBe(true);
  });

  it("ALGUM produtor DESTA árvore invoca o gate (sem isto, nada no repositório o executa)", () => {
    // O teste ENUMERA produtores em vez de grepar um arquivo fixo: se o passo sumir do CI, a lista vem
    // vazia e é aqui que se percebe.
    expect(
      PRODUTORES.length,
      `nenhum produtor chama ${GATE_REL} nesta árvore — o gate voltou a ser capacidade declarada com ` +
        `zero produtores. O produtor é o passo \`${ALVO_PUBLICACAO}\` de ${WORKFLOWS_DIR}/ci.yml.`,
    ).toBeGreaterThan(0);
    for (const p of PRODUTORES) expect(p.corpo, `${p.nome} não invoca o gate`).toContain(GATE_REL);
  });

  it("todo produtor é um passo de .github/workflows — o CI que o GitHub executa", () => {
    expect(PRODUTORES.length, "nenhum workflow invoca o gate de publicação — o repositório ficaria sem produtor").toBeGreaterThan(0);
    for (const p of PRODUTORES) expect(p.nome.startsWith(`${WORKFLOWS_DIR}/`), p.nome).toBe(true);
  });

  it("nenhum produtor recorta a árvore — nesta árvore tudo que existe é o que se publica", () => {
    // Uma lista de exclusão SUBTRAI da varredura arquivos que estão no repositório, e a subtração é
    // invisível (`--fail-on-unscanned` só reprova ponto cego ACIDENTAL). Medido em 2026-08-21 numa
    // árvore que ainda reaplicava a régua da extração: 10 de 1236 rastreados fora — `.github/` inteiro,
    // o `.gitignore`, os quatro documentos de raiz e o golden.
    for (const p of PRODUTORES) {
      expect(p.corpo, `${p.nome} não chama ${GATE_REL}`).toContain(GATE_REL);
      expect(comandoDe(p.corpo), `${p.nome} recorta a árvore que deveria medir inteira`).not.toContain("--exclude-from");
    }
  });

  it("EXECUTA CADA produtor sobre ESTE checkout — a árvore que vai a público está limpa AGORA", () => {
    // O produtor mais forte disponível: a suíte (que o merge gate roda a cada integração) varre a árvore
    // que vai a público. Um segredo commitado em packages/storymap-ui/** ou em .claude/skills/** fica
    // vermelho AQUI, antes de qualquer publicação — e não no dia do push.
    //
    // Roda o comando literal de CADA produtor — o que o CI vai rodar, não uma paráfrase. Um workflow
    // com o caminho errado passa em toda asserção de texto e falha aqui.
    expect(PRODUTORES.length).toBeGreaterThan(0);
    for (const p of PRODUTORES) {
      const [bin, ...args] = p.comando;
      const r = spawnSync(bin, args, { cwd: REPO_ROOT, encoding: "utf8", env: GIT_ENV });
      expect(
        r.status,
        `o gate de publicação reprovou por ${p.nome}. Se é falso-positivo, reconheça em ` +
          `scripts/security/secret-baseline-allowlist.json; se é segredo real, rotacione.\n` +
          `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
      ).toBe(0);
    }
  });
});

describe("escopo por lista de exclusão — o recurso do script, medido num snapshot de mentira", () => {
  it("o mesmo segredo BLOQUEIA na árvore e SAI de escopo quando a lista o exclui", () => {
    const dir = snapshot({
      "privado/prod.ts": `export const k = "${PLANTADO}";\n`,
      "app/index.ts": "export const nome = 'ferramenta';\n",
      "excluir.txt": "/privado/\n",
    });
    const gate = (args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, GATE_REL), dir, "--json", ...args], {
        encoding: "utf8",
        env: GIT_ENV,
      });

    const semEscopo = JSON.parse(gate([]).stdout);
    expect(semEscopo.ok).toBe(false);
    expect(semEscopo.findings.map((f: { file: string }) => f.file)).toContain("privado/prod.ts");

    const comEscopo = JSON.parse(gate(["--exclude-from", path.join(dir, "excluir.txt")]).stdout);
    expect(comEscopo.ok).toBe(true);
    expect(comEscopo.findings).toEqual([]);
    // e o relatório NUNCA deixa um verde escopado passar por verde da árvore inteira
    expect(comEscopo.excludeFrom).toContain("excluir.txt");
    expect(comEscopo.excludedFiles).toBeGreaterThan(0);
  });

  it("uma lista de exclusão inexistente é ERRO (fail-CLOSED), nunca varredura silenciosa da árvore", () => {
    const dir = snapshot({ "privado/prod.ts": `export const k = "${PLANTADO}";\n` });
    const r = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, GATE_REL), dir, "--exclude-from", path.join(dir, "nao-existe.txt")],
      { encoding: "utf8", env: GIT_ENV },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("lista de exclusão");
  });
});

describe("allowlist não vira mute (regressão da máscara sem bytes)", () => {
  it("ATAQUE: reconhecer UM falso-positivo não reconhece de carona o segundo achado do mesmo arquivo", () => {
    // Com a máscara elidindo o valor, dois achados de mesma regra e mesmo comprimento no mesmo arquivo
    // têm hash IGUAL. Se a entrada valesse para todos, excusar o delimitador de um `.env.example`
    // passaria a excusar uma credencial REAL de igual comprimento que aparecesse no mesmo arquivo.
    const outro = ["AK", "IA", "P3ZC8VN5KQ7WYBLD"].join("");
    expect(outro).toHaveLength(PLANTADO.length);
    const dir = snapshot({ "src/config.ts": `const a = "${PLANTADO}";\nconst b = "${outro}";\n` });
    const gate = () =>
      JSON.parse(
        spawnSync(process.execPath, [path.join(REPO_ROOT, GATE_REL), dir, "--json"], {
          encoding: "utf8",
          env: GIT_ENV,
        }).stdout,
      );

    const antes = gate();
    expect(antes.findings).toHaveLength(2);
    const [primeiro, segundo] = antes.findings;
    expect(segundo.hash, "o hash não distingue os dois — é justamente por isso que o consumo importa").toBe(
      primeiro.hash,
    );

    mkdirSync(path.join(dir, "scripts/security"), { recursive: true });
    writeFileSync(
      path.join(dir, "scripts/security/secret-baseline-allowlist.json"),
      JSON.stringify(
        { entries: [{ path: "src/config.ts", rule: primeiro.rule, hash: primeiro.hash, reason: "fp do teste" }] },
        null,
        2,
      ),
      "utf8",
    );

    const depois = gate();
    expect(depois.ok, "a segunda ocorrência tem de continuar bloqueando").toBe(false);
    expect(depois.findings).toHaveLength(1);
    expect(depois.allowlisted).toHaveLength(1);
  });
});
