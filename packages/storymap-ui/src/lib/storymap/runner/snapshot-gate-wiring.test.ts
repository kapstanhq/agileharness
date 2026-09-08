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
// infra do umbrella e a régua o exclui da extração — enquanto ESTE ARQUIVO viaja. No repo público o
// arquivo morria em ENOENT; e no dia em que alguém "consertasse" o ENOENT com um return, o artefato
// publicado ficaria sem NENHUMA cobrança de que seu CI liga o gate. Capacidade declarada com zero
// produtores, de novo, agora do lado de lá.
//
// O produtor do repo extraído existe e VIAJA: o passo `oss-snapshot-gate` de `oss/ci/workflows/ci.yml`,
// que o próprio comentário do workflow declara ser o equivalente do alvo do justfile, "mantidos em
// sincronia à mão porque `just` não é garantido no runner". Sincronia à mão sem guarda é divergência
// marcada. Então os casos abaixo passam a cobrar de CADA produtor da árvore (`produtoresDaPublicacao()`)
// — o que no umbrella cobre os DOIS, e fecha essa divergência de carona.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ALVO_DA_PUBLICACAO,
  GATE_DE_PUBLICACAO,
  comandoDe,
  produtoresDaPublicacao,
  receitaDoJustfile,
  soDoUmbrella,
} from "@/lib/storymap/oss-tree";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const GATE_REL = GATE_DE_PUBLICACAO;

/** O alvo que roda o gate sobre o ARTEFATO publicado (escopado pela lista de extração). */
const ALVO_PUBLICACAO = ALVO_DA_PUBLICACAO;
/** O alvo que roda o baseline da ÁRVORE INTEIRA (aceita um <dir> — o snapshot já extraído). */
const ALVO_BASELINE = "scan-snapshot-secrets";

/** `null` no repo extraído (o justfile não viaja); LANÇA se sumir do umbrella. */
const JUSTFILE = soDoUmbrella("justfile");

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

let justfile = "";
let snapshots: string[] = [];

beforeAll(async () => {
  justfile = JUSTFILE ? await readFile(JUSTFILE, "utf8") : "";
});

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

/** Roda um alvo do justfile DE VERDADE (é o amarrado que está sob teste, não o script). */
function just(alvo: string, args: string[] = []) {
  const r = spawnSync("just", ["--justfile", JUSTFILE!, "--working-directory", REPO_ROOT, alvo, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** O corpo do alvo, para afirmar SOBRE O AMARRADO sem depender do binário do just. */
const receita = (alvo: string) => receitaDoJustfile(justfile, alvo);

/** Os produtores do gate de publicação NESTA árvore: justfile + workflow no umbrella, só o workflow lá. */
const PRODUTORES = produtoresDaPublicacao(REPO_ROOT);

describe("gate do snapshot — está LIGADO (teste de produtor, story-jxwrsk)", () => {
  it("o gate existe como arquivo — se este caminho mudar, os alvos abaixo mentem", () => {
    expect(existsSync(path.join(REPO_ROOT, GATE_REL))).toBe(true);
  });

  it("ALGUM produtor DESTA árvore invoca o gate (sem isto, nada no repositório o executa)", () => {
    // Vale nas duas árvores, e é a razão de o teste enumerar produtores em vez de grepar o justfile: no
    // repo extraído o justfile não existe e o único produtor é o passo do workflow que viaja.
    expect(
      PRODUTORES.length,
      `nenhum produtor chama ${GATE_REL} nesta árvore — o gate voltou a ser capacidade declarada com ` +
        `zero produtores. No umbrella o produtor é o alvo \`${ALVO_PUBLICACAO}\` do justfile; no repo ` +
        `extraído, o passo homônimo de oss/ci/workflows/ci.yml.`,
    ).toBeGreaterThan(0);
    for (const p of PRODUTORES) expect(p.corpo, `${p.nome} não invoca o gate`).toContain(GATE_REL);
  });

  it("o CI que VIAJA é sempre um dos produtores (é o ÚNICO produtor do repo público)", () => {
    // Sem este caso, o umbrella ficaria verde pelo justfile enquanto o artefato publicado sai sem gate.
    expect(
      PRODUTORES.map((p) => p.nome).filter((n) => n.startsWith("oss/ci/workflows/")),
      "nenhum workflow de oss/ci/ invoca o gate de publicação — o repo extraído nasceria sem produtor",
    ).not.toEqual([]);
  });

  it("cada produtor recorta a ÁRVORE QUE ELE MEDE — o do umbrella escopa, o que VIAJA não", () => {
    // Este caso já cobrou `--exclude-from` de TODO produtor, e estava errado por um degrau: tratava o
    // escopo como propriedade do COMANDO quando ele é propriedade da ÁRVORE MEDIDA. O alvo do justfile
    // mede o monorepo; o passo do workflow, publicado, mede o artefato — onde o corte já aconteceu.
    expect(PRODUTORES.length).toBeGreaterThan(0);
    for (const p of PRODUTORES) {
      expect(p.corpo, `${p.nome} não chama ${GATE_REL}`).toContain(GATE_REL);
    }
    const doJustfile = PRODUTORES.filter((p) => p.nome.startsWith("justfile:"));
    const doWorkflow = PRODUTORES.filter((p) => p.nome.startsWith("oss/ci/workflows/"));

    // O monorepo PRECISA do recorte: sem ele o gate acusa 73 achados de pacotes que nem viajam e nasce
    // permanentemente vermelho — gate que ninguém roda não protege publicação nenhuma. (Vazio no
    // artefato, onde o justfile não existe; quem carrega o caso lá é o bloco do workflow abaixo.)
    for (const p of doJustfile) {
      expect(p.corpo, `${p.nome} sem --exclude-from`).toContain("--exclude-from");
      expect(p.corpo, `${p.nome} não aponta para a régua`).toContain(".ossignore");
    }

    // O que VIAJA não pode carregar a régua do corte: no artefato ela SUBTRAI da varredura arquivos que
    // sobreviveram a ela, e a subtração é invisível (`--fail-on-unscanned` só reprova ponto cego
    // ACIDENTAL). MEDIDO no artefato: 10 de 1236 rastreados fora — `.github/` inteiro, o `.gitignore`,
    // os quatro documentos de raiz e o golden gerado no destino.
    expect(doWorkflow.length, "nenhum passo de workflow invoca o gate — o artefato ficaria sem produtor").toBeGreaterThan(
      0,
    );
    for (const p of doWorkflow) {
      expect(
        comandoDe(p.corpo),
        `${p.nome} publica a régua do CORTE para dentro do repositório já cortado`,
      ).not.toContain("--exclude-from");
    }
  });

  it("EXECUTA CADA produtor sobre ESTE checkout — a árvore que vai a público está limpa AGORA", () => {
    // O produtor mais forte disponível: a suíte (que o merge gate roda a cada integração) varre a árvore
    // que vai a público. Um segredo commitado em packages/storymap-ui/** ou em .claude/skills/** fica
    // vermelho AQUI, antes de qualquer publicação — e não no dia do push.
    //
    // Roda o comando de CADA produtor, não de um: no umbrella isso executa o alvo do justfile E o
    // comando literal que o workflow do repo público vai rodar — que é o que de fato protege a
    // publicação. Um workflow com o caminho errado passa em toda asserção de texto e falha aqui.
    expect(PRODUTORES.length).toBeGreaterThan(0);
    for (const p of PRODUTORES) {
      const [bin, ...args] = p.comando;
      const r = spawnSync(bin, args, { cwd: REPO_ROOT, encoding: "utf8", env: GIT_ENV });
      expect(
        r.status,
        `o gate do artefato OSS reprovou por ${p.nome}. Se o achado é de um arquivo que NÃO viaja, ` +
          `exclua-o em /.ossignore; se é falso-positivo, reconheça em ` +
          `scripts/security/secret-baseline-allowlist.json; se é segredo real, rotacione.\n` +
          `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
      ).toBe(0);
      // O relatório DIZ que houve escopo — cobrado só de quem de fato escopa. Quem escopa é a EXECUÇÃO
      // nesta árvore (`p.comando`), não o texto publicado: no umbrella o pré-voo do passo do workflow
      // recebe o recorte de `produtoresDaPublicacao()`; no artefato ele roda cru, sobre tudo.
      if (p.comando.join(" ").includes("--exclude-from")) {
        expect(r.stdout ?? "", `${p.nome} escopou e não relatou escopo`).toContain("FORA do snapshot");
      }
    }
  });
});

// ── O QUE SÓ O UMBRELLA PODE MEDIR ──────────────────────────────────────────────────────────────────
//
// Três casos abaixo dependem do `justfile` (e do binário `just`), e o justfile não viaja. Ficam num
// `describe.runIf` de propósito, e NÃO num `return` no meio do corpo: um `return` reporta PASSED e o
// relatório do repo extraído passaria a afirmar que mediu o que não mediu. Skip aparece no sumário, e
// `soDoUmbrella("justfile")` já gritou uma vez no console dizendo o que deixou de ser medido e por quê.
//
// O que cada um garante continua coberto no artefato:
//   · a sincronia justfile↔workflow  ⇒ lá só existe um lado, e os 4 casos acima o cobram inteiro;
//   · o baseline sem escopo sobre outra árvore, e o par segredo-plantado/limpo ⇒ executados pelo
//     describe "escopo por lista de exclusão", que chama o script direto e roda nas DUAS árvores.
describe.runIf(JUSTFILE !== null)("amarrado do justfile — só existe no umbrella", () => {
  it("o justfile e o workflow são o MESMO comando — a sincronia 'à mão' fica guardada", () => {
    // O oss/ci/README diz, por escrito, que os dois são "mantidos em sincronia à mão porque `just` não é
    // garantido no runner". Nada cobrava isso: o alvo podia ganhar uma flag e o workflow ficar para trás,
    // e o repo público publicaria com um gate MAIS FRACO que o do monorepo — sem nenhum vermelho.
    const doJustfile = PRODUTORES.filter((p) => p.nome.startsWith("justfile:"));
    const doWorkflow = PRODUTORES.filter((p) => p.nome.startsWith("oss/ci/workflows/"));
    expect(doJustfile.length, "o umbrella tem justfile mas nenhum alvo produtor").toBeGreaterThan(0);
    expect(doWorkflow.length).toBeGreaterThan(0);
    // A sincronia é MÓDULO o recorte: os dois lados medem árvores diferentes, então o `--exclude-from`
    // é a ÚNICA divergência autorizada. Todo o resto — caminho do script, `--tracked-only`,
    // `--fail-on-unscanned`, qualquer flag futura — continua tendo de bater byte a byte.
    const semRecorte = (cmd: string) =>
      cmd
        .replace(/--exclude-from\s+\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    for (const w of doWorkflow) {
      expect(
        semRecorte(comandoDe(w.corpo)),
        `${w.nome} divergiu do alvo do justfile — um dos dois lados ganhou/perdeu flag sozinho`,
      ).toBe(semRecorte(comandoDe(doJustfile[0].corpo)));
    }
    // E a divergência autorizada tem de EXISTIR nos dois sentidos: sem estas duas, `semRecorte` deixaria
    // passar o caso em que os DOIS lados perdem o recorte (ou os dois o ganham) — que é exatamente o
    // defeito que este bloco acabou de consertar, com o sinal trocado.
    expect(comandoDe(doJustfile[0].corpo), "o alvo do justfile perdeu o recorte do monorepo").toContain(
      "--exclude-from",
    );
    for (const w of doWorkflow) {
      expect(comandoDe(w.corpo), `${w.nome} voltou a publicar a régua do corte`).not.toContain("--exclude-from");
    }
  });

  it("o alvo do BASELINE roda o gate sem escopo e aceita um <dir> (o snapshot já extraído)", () => {
    const corpo = receita(ALVO_BASELINE);
    expect(corpo, `alvo ${ALVO_BASELINE} ausente do justfile`).not.toBe("");
    expect(corpo).toContain(GATE_REL);
    expect(corpo).not.toContain("--exclude-from");
    expect(corpo).toContain("{{ARGS}}");
  });

  it("EXECUTA o alvo: um segredo no snapshot REPROVA por `just`, não só por node", () => {
    // A prova de que o amarrado é real: nome do alvo, caminho do script, passagem de argumento e
    // propagação do exit code. Um alvo com o caminho errado passaria nas asserções de texto e falharia
    // aqui. Precisa do binário `just` E do justfile ⇒ umbrella. A MESMA propriedade (segredo plantado
    // reprova com exit 2, nomeando o arquivo) é executada no artefato pelo describe de escopo abaixo.
    const dir = snapshot({ "src/config.ts": `export const cfg = { k: "${PLANTADO}" };\n` });
    const r = just(ALVO_BASELINE, [dir]);
    expect(r.code, `esperava reprovar; saída:\n${r.out}\n${r.err}`).toBe(2);
    expect(r.out).toContain("src/config.ts");
  });

  it("EXECUTA o alvo: snapshot limpo passa (o gate não é um `exit 2` fixo)", () => {
    const dir = snapshot({
      "src/util.ts": "export const sum = (a: number, b: number) => a + b;\n",
      "README.md": "# ferramenta\n",
    });
    const r = just(ALVO_BASELINE, [dir]);
    expect(r.code, `esperava passar; saída:\n${r.out}\n${r.err}`).toBe(0);
  });
});

describe("escopo por lista de exclusão — mede o artefato, e diz que mediu", () => {
  it("o mesmo segredo BLOQUEIA na árvore e SAI de escopo quando a lista o exclui", () => {
    const dir = snapshot({
      "privado/prod.ts": `export const k = "${PLANTADO}";\n`,
      "app/index.ts": "export const nome = 'ferramenta';\n",
      ".ossignore": "/privado/\n",
    });
    const gate = (args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, GATE_REL), dir, "--json", ...args], {
        encoding: "utf8",
        env: GIT_ENV,
      });

    const semEscopo = JSON.parse(gate([]).stdout);
    expect(semEscopo.ok).toBe(false);
    expect(semEscopo.findings.map((f: { file: string }) => f.file)).toContain("privado/prod.ts");

    const comEscopo = JSON.parse(gate(["--exclude-from", path.join(dir, ".ossignore")]).stdout);
    expect(comEscopo.ok).toBe(true);
    expect(comEscopo.findings).toEqual([]);
    // e o relatório NUNCA deixa um verde escopado passar por verde da árvore inteira
    expect(comEscopo.excludeFrom).toContain(".ossignore");
    expect(comEscopo.excludedFiles).toBeGreaterThan(0);
  });

  it("uma lista de exclusão inexistente é ERRO (fail-CLOSED), nunca varredura silenciosa da árvore", () => {
    const dir = snapshot({ "privado/prod.ts": `export const k = "${PLANTADO}";\n` });
    const r = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, GATE_REL), dir, "--exclude-from", path.join(dir, "nao-existe.ossignore")],
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
