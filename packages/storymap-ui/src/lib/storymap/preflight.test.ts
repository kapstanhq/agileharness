import { describe, it, expect } from "vitest";

import { NAMESPACE_PROBE } from "./runner/autonomy-sandbox";
import { CONTRATO_DE_ENV } from "./env-contract";
import { runPreflight, preflightMessage, type PreflightProbes, type PreflightCheck } from "./preflight";

// O relatório de prontidão. Tudo aqui roda sobre sondas INJETADAS — nada toca o disco, o PATH ou o
// git da máquina que roda a suíte. Ver o cabeçalho de preflight.ts para o porquê do módulo existir.

const RAIZ = "/repo";
const NO_DISCO = [
  "/usr/bin/bun", "/usr/bin/just", "/usr/bin/bwrap", "/usr/bin/socat", "/usr/bin/git",
  "/root/.local/bin/claude",
  `${RAIZ}/storymap/boards/_base/board.yaml`,
  // Os segredos EXISTEM neste fixture: sem eles o check de permissão não teria o que medir, e o
  // teste de frouxidão passaria por vacuidade.
  `${RAIZ}/storymap/.runner/auth-token`,
  `${RAIZ}/storymap/.runner/session-secret`,
  `${RAIZ}/storymap/settings.yaml`,
];

const sondaOk = (cmd: string, args: string[]) => {
  if (cmd === "git" && args.includes("user.name")) return { code: 0, stdout: "Alguém\n", stderr: "" };
  if (cmd === "git" && args.includes("user.email")) return { code: 0, stdout: "a@b.dev\n", stderr: "" };
  if (cmd === "git" && args.includes("ls-files")) return { code: 0, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

/** Um host saudável, e NÃO-root — porque um verde que só vale para root é vacuidade. */
const saudavel = (over: Partial<PreflightProbes> = {}): PreflightProbes => ({
  // As chaves do CONTRATO entram aqui porque um host saudável as sustenta: sem elas o serviço sobe e
  // apaga coisas em silêncio (o settle do self-deploy, o push, o autopush). Uma fixture "saudável" que
  // não as declara mediria um host que na prática está degradado.
  env: {
    PATH: "/usr/bin",
    AGILEHARNESS_CLAUDE: "/root/.local/bin/claude",
    AGILEHARNESS_HOST: "127.0.0.1",
    ...Object.fromEntries(CONTRATO_DE_ENV.map((c) => [c.chave, c.chave === "AGILEHARNESS_BOARD_AUTOPUSH" ? "1" : "x"])),
  },
  exists: (p) => NO_DISCO.includes(p),
  statMode: () => 0o600,
  run: sondaOk,
  repoRoot: RAIZ,
  versions: { node: "22.0.0", bun: "1.3.14" },
  platform: "linux",
  euid: 1000,
  claudeName: "claude",
  envSource: { kind: "servico" as const, pid: 4242 },
  portaOcupada: () => false,
  ...over,
});

const acha = (checks: PreflightCheck[], id: string) => {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`check ausente: ${id}`);
  return c;
};

describe("runPreflight — o host saudável", () => {
  it("[NÃO-VACUIDADE] mede um conjunto real e não reprova nada num host bom", () => {
    const r = runPreflight(saudavel());
    expect(r.checks.length).toBeGreaterThanOrEqual(10);
    expect(r.checks.filter((c) => c.status !== "ok").map((c) => `${c.id}=${c.status}`)).toEqual([]);
    expect(r.worst).toBe("ok");
  });

  it("[NÃO-VACUIDADE] TODO check relata o que mediu, inclusive quando passa", () => {
    // Um relatório que só fala ao reprovar não deixa provar que rodou — a lição que a auditoria de
    // bind já aprendeu e escreveu no próprio código.
    for (const c of runPreflight(saudavel()).checks) {
      expect(c.observed.trim(), `${c.id} passou sem dizer o que mediu`).not.toBe("");
    }
  });

  it("num host saudável a mensagem humana é VAZIA — quem chama imprime o PASS afirmativo", () => {
    expect(preflightMessage(runPreflight(saudavel()))).toBe("");
  });
});

describe("[NÃO-VACUIDADE] sem sonda, nada pode dizer que está saudável", () => {
  it("os checks que DEPENDEM de executar um comando viram `unknown`, nunca `ok`", () => {
    // Esta é a vacuidade exata que este repositório já pagou: `method: "sonda"` carimbado sem que
    // sonda nenhuma tivesse rodado (autonomy-sandbox.ts). Um doutor que não mediu não diz "saudável".
    const r = runPreflight(saudavel({ run: undefined }));
    for (const id of ["sandbox.userns", "git.identity", "runner.notTracked"]) {
      expect(acha(r.checks, id).status, `${id} deveria ser unknown sem sonda`).toBe("unknown");
    }
    expect(r.worst).not.toBe("ok");
  });
});

describe("cada modo de falha, com o conserto NOMEADO", () => {
  it("o claude não resolve — e é o incidente de 2026-08-20 → 26", () => {
    const r = runPreflight(
      saudavel({ env: { PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin" } }),
    );
    const c = acha(r.checks, "host.claude");
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("AGILEHARNESS_CLAUDE");
  });

  it("o claude resolve pelo default — e o `observed` DIZ que não veio do settings.yaml", () => {
    const c = acha(runPreflight(saudavel({ claudeName: undefined })).checks, "host.claude");
    expect(c.status).toBe("ok");
    expect(c.observed).toContain("default");
  });

  it("faltam bwrap/socat — e a sonda de userns NÃO finge ter medido", () => {
    const r = runPreflight(saudavel({ exists: (p) => NO_DISCO.includes(p) && !p.includes("bwrap") }));
    const bins = acha(r.checks, "sandbox.bins");
    expect(bins.status).toBe("missing");
    expect(bins.observed).toContain("bwrap");
    expect(bins.remedy).toContain("bubblewrap");
    expect(acha(r.checks, "sandbox.userns").status).toBe("unknown");
  });

  it("[Ubuntu 23.10+] binários presentes e a sonda FALHA — e o conselho usual é o ERRADO", () => {
    const r = runPreflight(
      saudavel({
        run: (cmd, args) =>
          cmd === NAMESPACE_PROBE[0]
            ? { code: 1, stdout: "", stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted" }
            : sondaOk(cmd, args),
      }),
    );
    const c = acha(r.checks, "sandbox.userns");
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("ERRADO");
    expect(c.remedy).toContain("apparmor_restrict_unprivileged_userns");
  });

  it("[MASCARAMENTO] a sonda passa mas o processo é root ⇒ `degraded`, não `ok`", () => {
    const c = acha(runPreflight(saudavel({ euid: 0 })).checks, "sandbox.userns");
    expect(c.status).toBe("degraded");
    expect(c.remedy).toContain("root");
  });

  it("a identidade do git ausente — o motor commita sozinho", () => {
    const c = acha(
      runPreflight(saudavel({ run: (cmd, args) => (args.includes("user.email") ? { code: 1, stdout: "", stderr: "" } : sondaOk(cmd, args)) })).checks,
      "git.identity",
    );
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("user.email");
  });

  it("a pipeline herdável ausente — a MESMA verdade que register_board recusa, só que antes", () => {
    const c = acha(runPreflight(saudavel({ exists: (p) => NO_DISCO.includes(p) && !p.includes("_base") })).checks, "repo.basePipeline");
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("_base/board.yaml");
  });

  it("[SEGREDO VAZADO] .runner/ versionado exige as DUAS metades", () => {
    const c = acha(
      runPreflight(saudavel({ run: (cmd, args) => (args.includes("ls-files") ? { code: 0, stdout: "storymap/.runner/auth-token\n", stderr: "" } : sondaOk(cmd, args)) })).checks,
      "runner.notTracked",
    );
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("git rm -r --cached");
    // Só a primeira metade deixa o repo com cara de limpo e a credencial ainda válida.
    expect(c.remedy).toContain("ROTACIONE");
  });

  it("segredo legível por outros ⇒ degraded, com o chmod nomeado", () => {
    const c = acha(runPreflight(saudavel({ statMode: () => 0o644 })).checks, "runner.perms");
    expect(c.status).toBe("degraded");
    expect(c.remedy).toContain("chmod 600");
  });

  it("[POSTURA VÁLIDA] a superfície MCP FECHADA é `ok`, não `missing`", () => {
    // Sem token o endpoint responde 404 nu, e token-bootstrap.ts documenta que nada gera um no boot
    // DE PROPÓSITO. Fechado é a postura segura — reportá-la como falta ensinaria o adotante a abrir
    // uma porta que ele talvez não queira.
    // O token é declarado ausente AQUI, e não herdado da fixture: este caso mede a postura FECHADA, e
    // uma fixture que traz credencial mediria a aberta com o nome da fechada.
    const fechada = saudavel();
    const semToken = { ...fechada.env, AGILEHARNESS_MCP_TOKEN: undefined } as Record<string, string | undefined>;
    const c = acha(runPreflight({ ...fechada, env: semToken }).checks, "mcp.surface");
    expect(c.status).toBe("ok");
    expect(c.observed).toContain("FECHADA");
    const armada = acha(runPreflight(saudavel({ env: { PATH: "/usr/bin", AGILEHARNESS_MCP_TOKEN: "x".repeat(43) } })).checks, "mcp.surface");
    expect(armada.observed).toContain("ARMADA");
  });

  it("Node abaixo do piso declarado", () => {
    const c = acha(runPreflight(saudavel({ versions: { node: "18.19.0" } })).checks, "runtime.node");
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("20");
  });

  it("sem raiz de repositório, os checks que dependem dela não são inventados", () => {
    const r = runPreflight(saudavel({ repoRoot: null }));
    expect(acha(r.checks, "repo.root").status).toBe("missing");
    expect(r.checks.find((c) => c.id === "repo.basePipeline")).toBeUndefined();
  });
});

describe("[O INCIDENTE, DE NOVO] de qual ambiente o relatório fala", () => {
  it("medindo o SERVIÇO VIVO, o check é `ok` e nomeia o pid", () => {
    const c = acha(runPreflight(saudavel()).checks, "env.source");
    expect(c.status).toBe("ok");
    expect(c.observed).toContain("4242");
  });

  it("sem serviço vivo, DEGRADA — porque o PATH de um shell mente sobre o do unit", () => {
    // Esta é a diferença entre um doutor que teria pego os seis dias e um que teria dito verde: o
    // shell do dono alcançava `~/.local/bin/claude` o tempo todo; o PATH que o unit FIXA, nunca.
    const c = acha(runPreflight(saudavel({ envSource: undefined })).checks, "env.source");
    expect(c.status).toBe("degraded");
    expect(c.remedy).toContain("systemd");
  });

  it("[REGRESSÃO] o PATH do unit + o claude em ~/.local/bin reprova, mesmo com o binário no disco", () => {
    // O host exato de 2026-08-20: o binário EXISTE, e ainda assim o serviço não o alcança.
    const r = runPreflight(
      saudavel({
        env: { PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin" },
        exists: (p) => p === "/root/.local/bin/claude",
      }),
    );
    expect(acha(r.checks, "host.claude").status).toBe("missing");
  });
});

describe("os checks que faltavam — cada um com o conserto NOMEADO", () => {
  it("[NINGUÉM CONSEGUE ENTRAR] bind fora do loopback sem AGILEHARNESS_PUBLIC_URL", () => {
    // SECURITY.md a chama obrigatória e NADA a checava. O modo de falha é o pior: o serviço sobe,
    // responde, e o login redireciona para localhost — ninguém entra.
    const c = acha(runPreflight(saudavel({ env: { PATH: "/usr/bin", AGILEHARNESS_CLAUDE: "/root/.local/bin/claude", AGILEHARNESS_HOST: "0.0.0.0" } })).checks, "net.publicUrl");
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("AGILEHARNESS_PUBLIC_URL");
  });

  it("em loopback ela NÃO é cobrada — exigir seria ruído", () => {
    expect(acha(runPreflight(saudavel()).checks, "net.publicUrl").status).toBe("ok");
  });

  it("[MUDO] settings.yaml malformado reverte TODOS os botões em silêncio", () => {
    const c = acha(
      runPreflight(saudavel({ run: (cmd, args) => (args.some((a) => a.includes("yaml")) ? { code: 1, stdout: "", stderr: "YAMLParseError: bad indentation" } : sondaOk(cmd, args)) })).checks,
      "config.settings",
    );
    expect(c.status).toBe("missing");
    expect(c.remedy).toContain("defaults");
  });

  it("[POSTURA VÁLIDA] settings.yaml AUSENTE é `ok`, não falta", () => {
    const c = acha(runPreflight(saudavel({ exists: (p) => NO_DISCO.includes(p) && !p.endsWith("settings.yaml") })).checks, "config.settings");
    expect(c.status).toBe("ok");
    expect(c.observed).toContain("defaults");
  });

  it("porta ocupada degrada e explica os dois casos", () => {
    const c = acha(runPreflight(saudavel({ portaOcupada: () => true })).checks, "net.port");
    expect(c.status).toBe("degraded");
    expect(c.remedy).toContain("EADDRINUSE");
  });

  it("sem sonda de porta, `unknown` — nunca um `ok` inventado", () => {
    expect(acha(runPreflight(saudavel({ portaOcupada: undefined })).checks, "net.port").status).toBe("unknown");
  });

  it("o Bun é medido", () => {
    expect(acha(runPreflight(saudavel()).checks, "runtime.bun").status).toBe("ok");
  });
});

describe("[NÃO-VACUIDADE] toda reprovação tem saída", () => {
  it("nenhum check reprova sem NOMEAR o conserto", () => {
    // Um diagnóstico sem saída é fofoca. Varre vários hosts quebrados de uma vez.
    const hosts: PreflightProbes[] = [
      saudavel({ env: { PATH: "/nada" } }),
      saudavel({ run: undefined }),
      saudavel({ euid: 0 }),
      saudavel({ repoRoot: null }),
      saudavel({ versions: { node: "18.0.0" } }),
      saudavel({ statMode: () => 0o666 }),
    ];
    const semSaida: string[] = [];
    let reprovacoes = 0;
    for (const h of hosts) {
      for (const c of runPreflight(h).checks) {
        if (c.status === "ok") continue;
        reprovacoes++;
        if (!c.remedy || !c.remedy.trim()) semSaida.push(c.id);
      }
    }
    expect(reprovacoes, "os hosts quebrados não reprovaram nada — o teste mediria o vazio").toBeGreaterThan(8);
    expect([...new Set(semSaida)]).toEqual([]);
  });

  it("a mensagem humana carrega medição E conserto", () => {
    const msg = preflightMessage(runPreflight(saudavel({ env: { PATH: "/nada" } })));
    expect(msg).toContain("medido:");
    expect(msg).toContain("conserto:");
    expect(msg).toContain("NÃO impede o boot");
  });
});

// ── A CLASSE: o que uma sonda SPAWNADA exige tem de existir na instalação de quem clonou ─────────
//
// Medido num clone limpo do artefato em 2026-08-27, no PRIMEIRO boot: a sonda do `settings.yaml`
// rodava `node -e "require('yaml')…"`, e `yaml` NÃO é dependência declarada. No monorepo de origem
// ela passava — o pacote existe lá por HOISTING de um vizinho. Em toda instalação limpa, isto é, na
// de todo usuário, o `MODULE_NOT_FOUND` era reportado como **"YAML inválido"**: o preflight mandava
// consertar um arquivo que estava correto e afirmava que o motor tinha voltado a todos os defaults.
//
// A guarda mede a CLASSE, não a instância: TODO módulo exigido dentro de um literal que vai ser
// executado noutro processo precisa ser builtin do Node ou dependência DECLARADA. Um teste que só
// travasse `js-yaml` no lugar de `yaml` deixaria a próxima sonda repetir o defeito.
describe("[CLASSE] sonda spawnada só exige builtin ou dependência declarada", () => {
  const BUILTINS = new Set(["fs", "path", "child_process", "os", "crypto", "util", "url"]);

  it("nenhum require de sonda aponta para módulo ausente do package.json", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const path = await import("node:path");

    const raizSrc = path.join(process.cwd(), "src");
    const arquivos: string[] = [];
    const varre = (dir: string): void => {
      for (const nome of readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (statSync(p).isDirectory()) varre(p);
        else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) arquivos.push(p);
      }
    };
    varre(raizSrc);
    expect(arquivos.length, "nenhum fonte varrido — a guarda ficaria vácua").toBeGreaterThan(100);

    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    const declaradas = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);

    const faltando: string[] = [];
    let medidos = 0;
    for (const arquivo of arquivos) {
      const texto = readFileSync(arquivo, "utf8");
      for (const m of texto.matchAll(/require\(\\?['"]([^'"\\)]+)\\?['"]\)/g)) {
        const mod = m[1];
        if (mod.startsWith("node:") || BUILTINS.has(mod)) continue;
        medidos++;
        if (!declaradas.has(mod)) {
          faltando.push(`${path.relative(process.cwd(), arquivo)} → require('${mod}')`);
        }
      }
    }

    // NÃO-VACUIDADE: se o casamento parasse de funcionar, a guarda passaria calada.
    expect(medidos, "nenhum require não-builtin foi medido — o casamento quebrou").toBeGreaterThan(0);
    expect(
      faltando.join("\n"),
      "sonda exige módulo que não é builtin nem dependência declarada — passa aqui por hoisting e QUEBRA no clone de quem instalou",
    ).toBe("");
  });
});

// -- A PORTA: de quem e a linha ------------------------------------------------------------------
//
// MEDIDO em 2026-08-27. Uma instancia de paridade subiu com AGILEHARNESS_PORT=3044 e o relatorio
// disse "127.0.0.1:3008". Nao era defeito da escolha de env — ler o ambiente do SERVICO VIVO e o
// conserto do incidente `spawn claude ENOENT`, e vale. O defeito era a AUSENCIA DE ETIQUETA: a
// unica linha em que essa escolha engana quem sobe uma instancia AO LADO, apresentada como se
// fosse sobre ele. Medicao sobre outro processo, sem dizer, e pior que nenhuma.
describe("net.port declara de QUEM e a porta quando o env medido nao e o deste processo", () => {
  const base = {
    exists: () => true,
    run: () => ({ code: 0, stdout: "", stderr: "" }),
    portaOcupada: () => false,
  };

  it("divergindo: a linha NOMEIA o serviço, a porta propria, e diz que nao e sobre voce", () => {
    const r = runPreflight({
      ...base,
      env: { PATH: "/usr/bin" },
      envDesteProcesso: { AGILEHARNESS_PORT: "3044" },
      envSource: { kind: "servico", pid: 7518 },
      portaOcupada: () => true,
    });
    const porta = r.checks.find((c) => c.id === "net.port");
    expect(porta, "o check de porta sumiu").toBeDefined();
    expect(porta!.observed).toContain("3008");
    expect(porta!.observed, "nao disse que a porta e do servico").toContain("SERVIÇO VIVO");
    expect(porta!.observed).toContain("7518");
    expect(porta!.observed, "nao disse qual e a porta deste processo").toContain("3044");
    expect(porta!.remedy ?? "", "nao avisou que a linha nao e sobre quem le").toContain("NÃO É SOBRE VOCÊ");
  });

  it("[NAO-VACUIDADE] SEM divergencia a etiqueta NAO aparece — senao ela seria ruido constante", () => {
    const r = runPreflight({
      ...base,
      env: { PATH: "/usr/bin", AGILEHARNESS_PORT: "3044" },
      envDesteProcesso: { AGILEHARNESS_PORT: "3044" },
      envSource: { kind: "servico", pid: 7518 },
    });
    const porta = r.checks.find((c) => c.id === "net.port")!;
    expect(porta.observed).toContain("3044");
    expect(porta.observed).not.toContain("SERVIÇO VIVO");
  });

  it("sem o env deste processo, NADA e afirmado sobre divergencia", () => {
    const r = runPreflight({ ...base, env: { PATH: "/usr/bin" }, envSource: { kind: "servico", pid: 7518 } });
    const porta = r.checks.find((c) => c.id === "net.port")!;
    expect(porta.observed).not.toContain("SERVIÇO VIVO");
  });
});

// -- A RAIZ NAO PODE FICAR VERDE QUANDO A RESPOSTA E QUASE CERTAMENTE ERRADA ---------------------
//
// MEDIDO em 2026-08-28, num clone virgem do artefato: o relatorio dizia `ok repo.root
// /root/agileharness` e seguia satisfeito. O clone satisfaz os tres marcadores EM SI MESMO, entao
// sem alvo declarado o `register_board` teria criado um board para a PROPRIA FERRAMENTA — e todo
// passo seguinte teria sucedido contra a arvore errada, em silencio. O SKILL.md avisa; a
// FERRAMENTA nao avisava, e e ela que o adotante executa.
describe("repo.root: o clone da ferramenta sem alvo declarado NAO e verde", () => {
  const base = { exists: () => true, run: () => ({ code: 0, stdout: "", stderr: "" }), portaOcupada: () => false };

  it("[ATAQUE] so os boards de fixture + sem alvo = degradado, e a recusa ENSINA o conserto", () => {
    const r = runPreflight({
      ...base,
      env: { PATH: "/usr/bin" },
      repoRoot: "/root/agileharness",
      boardsNaRaiz: ["_base", "demo", "demo-legado"],
    });
    const c = r.checks.find((x) => x.id === "repo.root")!;
    expect(c.status).toBe("degraded");
    expect(c.remedy ?? "").toContain("AGILEHARNESS_TARGET");
    expect(c.remedy ?? "", "nao nomeou o risco real").toContain("PARA O AGILEHARNESS");
  });

  it("com alvo DECLARADO volta a ser ok — declarar e a resposta, e ela tem de funcionar", () => {
    const r = runPreflight({
      ...base,
      env: { PATH: "/usr/bin", AGILEHARNESS_TARGET: "/root/meu-produto" },
      repoRoot: "/root/meu-produto",
      boardsNaRaiz: ["_base", "demo"],
    });
    expect(r.checks.find((x) => x.id === "repo.root")!.status).toBe("ok");
  });

  it("[NAO-VACUIDADE] uma raiz COM board de produto segue ok — senao o guard puniria o caso legitimo", () => {
    const r = runPreflight({
      ...base,
      env: { PATH: "/usr/bin" },
      repoRoot: "/root/monorepo",
      boardsNaRaiz: ["_base", "demo", "meu-app"],
    });
    expect(r.checks.find((x) => x.id === "repo.root")!.status).toBe("ok");
  });

  it("sem a sonda de boards, NADA e afirmado", () => {
    const r = runPreflight({ ...base, env: { PATH: "/usr/bin" }, repoRoot: "/root/qualquer" });
    expect(r.checks.find((x) => x.id === "repo.root")!.status).toBe("ok");
  });
});

// -- env.source: a armadilha CIRCULAR ------------------------------------------------------------
//
// O item mandava "suba o servico e meca de novo". O adotante subia — na UNICA postura segura para
// uma instancia nova, AGILEHARNESS_ENGINE=off — e continuava degradado, porque a deteccao le o
// service.lock e o motor inerte declara que NAO o escreve. O proprio servico de producao imprime a
// mesma queixa no boot. Item que ninguem consegue satisfazer nao e rigor, e ruido.
describe("env.source: motor inerte e uma TERCEIRA categoria, nao uma pendencia", () => {
  const base = { exists: () => true, run: () => ({ code: 0, stdout: "", stderr: "" }), portaOcupada: () => false };

  it("com motor inerte o item e ok, e DIZ que a ausencia e esperada", () => {
    const r = runPreflight({ ...base, env: { PATH: "/usr/bin" }, motorInerte: true });
    const c = r.checks.find((x) => x.id === "env.source")!;
    expect(c.status).toBe("ok");
    expect(c.observed).toContain("INERTE");
    expect(c.remedy ?? "", "nao disse quando remedir").toContain("ARMAR");
  });

  it("[NAO-VACUIDADE] SEM a declaracao de inercia, o degradado permanece — o aviso original vale", () => {
    const r = runPreflight({ ...base, env: { PATH: "/usr/bin" } });
    expect(r.checks.find((x) => x.id === "env.source")!.status).toBe("degraded");
  });

  it("com servico vivo o veredito continua sendo o do servico", () => {
    const r = runPreflight({
      ...base,
      env: { PATH: "/usr/bin" },
      motorInerte: true,
      envSource: { kind: "servico", pid: 7518 },
    });
    const c = r.checks.find((x) => x.id === "env.source")!;
    expect(c.status).toBe("ok");
    expect(c.observed).toContain("SERVIÇO VIVO");
  });
});

describe("host.unitPaths — a unit que já está quebrada, em silêncio", () => {
  const acha = (r: { checks: PreflightCheck[] }) => r.checks.find((c) => c.id === "host.unitPaths");

  it("não aparece quando nenhuma unit foi lida — ausência de medição não é item", () => {
    expect(acha(runPreflight(saudavel()))).toBeUndefined();
  });

  it("verde quando todo caminho EXIGIDO existe", () => {
    const c = acha(
      runPreflight(saudavel({ unidades: [{ unit: "s.service", caminhos: [`${RAIZ}/pkg`], ausentes: [] }] })),
    );
    expect(c?.status).toBe("ok");
  });

  it("degradado nomeando a unit E o caminho — o operador precisa dos dois para agir", () => {
    const c = acha(
      runPreflight(
        saudavel({
          unidades: [{ unit: "t.timer", caminhos: [`${RAIZ}/bin/sumiu`], ausentes: [`${RAIZ}/bin/sumiu`] }],
        }),
      ),
    );
    expect(c?.status).toBe("degraded");
    expect(c?.observed).toContain("t.timer");
    expect(c?.observed).toContain(`${RAIZ}/bin/sumiu`);
    // O remédio TEM de citar a saída do systemd para ausência legítima — senão o operador "conserta"
    // apagando a diretiva, que é pior que o alarme.
    expect(c?.remedy ?? "").toContain("-");
  });

  it("sonda VELHA (sem o campo) vira `unknown`, nunca `ok`", () => {
    // Um binário antigo servindo um relatório novo: o campo não vem. Chamar isso de aprovado seria
    // afirmar o que ninguém mediu — a forma de falha que este relatório inteiro existe para não ter.
    const c = acha(runPreflight(saudavel({ unidades: [{ unit: "velha.service", caminhos: [`${RAIZ}/x`] }] })));
    expect(c?.status).toBe("unknown");
  });
});
