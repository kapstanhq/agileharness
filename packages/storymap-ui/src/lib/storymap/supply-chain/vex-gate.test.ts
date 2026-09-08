// ATAQUE: lavar uma vulnerabilidade REAL através de um VEX que envelheceu.
//
// VEX é a única saída honesta para o ruído de SBOM (11 dos 45 advisories desta árvore são de pacote
// instalado e não executado — sem disposição, quem clonar o repo vê 45 achados e conclui "abandonado").
// Mas VEX é também a ferramenta perfeita para esconder vulnerabilidade: uma linha de JSON dizendo
// `not_affected` cala qualquer scanner, para sempre, sem ninguém revisar.
//
// As quatro formas de lavagem que estes testes fecham:
//   1. STALENESS — a justificativa era verdadeira quando foi escrita. Alguém muda o código, o pacote
//      ENTRA no caminho de execução, e o `not_affected` continue calando o achado.
//   2. ESCOPO POR PACOTE — suprimir "hono" em vez de "hono + este advisory" faz o advisory NOVO de
//      amanhã nascer suprimido.
//   3. DÍVIDA ETERNA — `affected, vamos mitigar` sem prazo é como dívida vira permanente.
//   4. AFIRMAÇÃO SEM PROVA — `not_affected` sem evidência verificável é opinião com força de gate.
//
// A régua: toda disposição carrega evidência que o gate RE-EXECUTA a cada rodada. Evidência que não
// confere não vira aviso — invalida a disposição e REPROVA (fail-closed). Um VEX que não pode ficar
// desatualizado em silêncio é a diferença entre controle e teatro.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const GATE = path.join(REPO_ROOT, "scripts/security/vex-gate.mjs");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function bancada(arquivos: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ah-vex-"));
  dirs.push(dir);
  for (const [rel, conteudo] of Object.entries(arquivos)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, conteudo, "utf8");
  }
  return dir;
}

type Advisory = {
  id: string;
  severity?: string;
  summary?: string;
  detailsExcerpt?: string;
  components: string[];
  kev?: boolean | null;
  epss?: number | null;
};

function relatorio(advisories: Advisory[]) {
  return {
    target: "alvo@1.0.0",
    closure: { total: 10, runtime: 5, devOnly: 5 },
    vulnerableComponents: [...new Set(advisories.flatMap((a) => a.components))].sort(),
    advisories: advisories.map((a) => ({ severity: "HIGH", kev: false, epss: 0.001, summary: "", ...a })),
    failedBatches: [],
    kevCatalogAvailable: true,
    lockfileDrift: [],
    installDrift: [],
  };
}

/** Roda o gate DE VERDADE (é o binário que o CI do repo OSS invoca). */
function gate(raiz: string, rel: object, vex: object, extra: string[] = []) {
  const relFile = path.join(raiz, "osv.json");
  const vexFile = path.join(raiz, "vex.json");
  writeFileSync(relFile, JSON.stringify(rel), "utf8");
  writeFileSync(vexFile, JSON.stringify(vex), "utf8");
  try {
    const out = execFileSync(
      process.execPath,
      [GATE, "--report", relFile, "--vex", vexFile, "--root", raiz, "--json", ...extra],
      { encoding: "utf8" },
    );
    return { code: 0, veredito: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: err.status ?? -1,
      veredito: err.stdout ? JSON.parse(err.stdout) : null,
      err: err.stderr ?? "",
    };
  }
}

const INVARIANTE = "const wsOwner = dev ? server : new EventEmitter();";

/** Uma disposição `not_affected` cuja prova é um invariante de código — o padrão que o repo usa de fato. */
function statementInvariante(over: Partial<Record<string, unknown>> = {}) {
  return {
    vulnerability: "GHSA-c4j6-fc7j-m34r",
    products: ["pkg:npm/next@14.2.35"],
    status: "not_affected",
    justification: "vulnerable_code_cannot_be_controlled_by_adversary",
    impact_statement: "o app é dono exclusivo do evento upgrade em produção",
    reviewedAt: "2026-07-30",
    evidence: [{ kind: "code_invariant", file: "src/server/main.ts", mustContain: INVARIANTE }],
    ...over,
  };
}

describe("VEX não pode envelhecer em silêncio (story-5oestw)", () => {
  it("ATAQUE 1: o invariante que justificava o `not_affected` desapareceu — o gate REPROVA, não silencia", () => {
    const rel = relatorio([{ id: "GHSA-c4j6-fc7j-m34r", components: ["next@14.2.35"], epss: 0.38872 }]);
    const vex = { statements: [statementInvariante()] };

    // Com o invariante presente: a disposição vale e o advisory de EPSS 0.39 fica coberto.
    const ok = gate(bancada({ "src/server/main.ts": `x\n${INVARIANTE}\ny\n` }), rel, vex);
    expect(ok.code).toBe(0);
    expect(ok.veredito.notAffected).toContain("GHSA-c4j6-fc7j-m34r");

    // Alguém entrega o servidor REAL ao Next também em produção: o caminho vulnerável volta a existir.
    // A disposição não foi tocada — e é justamente por isso que ela não pode continuar valendo.
    const mau = gate(bancada({ "src/server/main.ts": "const wsOwner = server;\n" }), rel, vex);
    expect(mau.code, "VEX desatualizado tem de REPROVAR (fail-closed), nunca liberar").toBe(2);
    expect(mau.veredito.staleStatements).toHaveLength(1);
    expect(mau.veredito.staleStatements[0].vulnerability).toBe("GHSA-c4j6-fc7j-m34r");
    expect(mau.veredito.notAffected).not.toContain("GHSA-c4j6-fc7j-m34r");
  });

  it("ATAQUE 1b: arquivo da evidência sumiu — some a prova, some a disposição", () => {
    const rel = relatorio([{ id: "GHSA-c4j6-fc7j-m34r", components: ["next@14.2.35"], epss: 0.38872 }]);
    const r = gate(bancada(), rel, { statements: [statementInvariante()] });
    expect(r.code).toBe(2);
    expect(r.veredito.staleStatements[0].reason).toMatch(/arquivo/i);
  });

  it("ATAQUE 2: advisory NOVO de um pacote já disposto NÃO nasce suprimido", () => {
    // A tentação é escrever "hono está fora do caminho de execução, ignore hono". Aí o CVE crítico de
    // amanhã em hono nasce calado. A disposição vale para o PAR (advisory, produto) e nada além.
    const raiz = bancada({ "src/server/main.ts": INVARIANTE });
    const vex = {
      statements: [
        {
          vulnerability: "GHSA-88fw-hqm2-52qc",
          products: ["pkg:npm/hono@4.12.23"],
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          impact_statement: "hono só é importado por examples/ do SDK",
          reviewedAt: "2026-07-30",
          evidence: [{ kind: "code_invariant", file: "src/server/main.ts", mustContain: INVARIANTE }],
        },
      ],
    };
    const rel = relatorio([
      { id: "GHSA-88fw-hqm2-52qc", components: ["hono@4.12.23"], severity: "HIGH" },
      // O novo: mesmo pacote, mesma versão, advisory diferente, e CRÍTICO.
      { id: "GHSA-novo-0000-0000", components: ["hono@4.12.23"], severity: "CRITICAL" },
    ]);
    const r = gate(raiz, rel, vex);
    expect(r.code, "advisory novo e crítico não pode entrar coberto de carona").toBe(2);
    expect(r.veredito.undisposed).toContain("GHSA-novo-0000-0000");
    expect(r.veredito.notAffected).toContain("GHSA-88fw-hqm2-52qc");
  });

  it("ATAQUE 2b: disposição não vaza para OUTRA versão do mesmo pacote", () => {
    // Um bump para uma versão que reintroduz o problema não pode herdar a absolvição da versão anterior.
    const rel = relatorio([{ id: "GHSA-52cp-r559-cp3m", components: ["js-yaml@3.14.2", "js-yaml@9.9.9"] }]);
    const vex = {
      statements: [
        {
          vulnerability: "GHSA-52cp-r559-cp3m",
          products: ["pkg:npm/js-yaml@3.14.2"],
          status: "affected",
          justification: "inline_mitigations_already_exist",
          impact_statement: "teto de bytes antes do parse",
          mitigation: "chokepoint de frontmatter",
          reviewedAt: "2026-07-30",
          expiresAt: "2099-01-01",
        },
      ],
    };
    const r = gate(bancada(), rel, vex, ["--fail-on", "high"]);
    expect(r.veredito.undisposedProducts).toContain("js-yaml@9.9.9");
    expect(r.code).toBe(2);
  });

  it("ATAQUE 3: mitigação VENCIDA reprova — dívida com prazo não vira dívida eterna", () => {
    const rel = relatorio([{ id: "GHSA-52cp-r559-cp3m", components: ["js-yaml@3.14.2"], severity: "HIGH" }]);
    const statement = {
      vulnerability: "GHSA-52cp-r559-cp3m",
      products: ["pkg:npm/js-yaml@3.14.2"],
      status: "affected",
      justification: "inline_mitigations_already_exist",
      impact_statement: "bytes de board não são controlados por atacante hoje",
      mitigation: "teto de 2 MiB antes do parse (frontmatter.ts)",
      reviewedAt: "2026-07-30",
      expiresAt: "2026-12-31",
    };

    const vigente = gate(bancada(), relatorio([...rel.advisories] as Advisory[]), { statements: [statement] }, [
      "--now",
      "2026-08-01",
    ]);
    expect(vigente.code).toBe(0);
    expect(vigente.veredito.mitigated).toContain("GHSA-52cp-r559-cp3m");

    const vencido = gate(bancada(), relatorio([...rel.advisories] as Advisory[]), { statements: [statement] }, [
      "--now",
      "2027-01-01",
    ]);
    expect(vencido.code, "prazo vencido é REPROVA — senão o prazo não era prazo").toBe(2);
    expect(vencido.veredito.expiredStatements).toContain("GHSA-52cp-r559-cp3m");
  });

  it("ATAQUE 3b: `affected` SEM prazo é rejeitado na entrada", () => {
    const rel = relatorio([{ id: "GHSA-52cp-r559-cp3m", components: ["js-yaml@3.14.2"] }]);
    const r = gate(bancada(), rel, {
      statements: [
        {
          vulnerability: "GHSA-52cp-r559-cp3m",
          products: ["pkg:npm/js-yaml@3.14.2"],
          status: "affected",
          justification: "inline_mitigations_already_exist",
          // Tudo o mais é válido de propósito: o ÚNICO defeito é a ausência de prazo.
          impact_statement: "bytes de board não são controlados por atacante hoje",
          mitigation: "teto de bytes antes do parse",
          reviewedAt: "2026-07-30",
        },
      ],
    });
    expect(r.code).toBe(2);
    expect(r.veredito.invalidStatements[0].reason).toMatch(/expiresAt/);
  });

  it("ATAQUE 4: `not_affected` SEM evidência é rejeitado — afirmar não é provar", () => {
    const rel = relatorio([{ id: "GHSA-88fw-hqm2-52qc", components: ["hono@4.12.23"], severity: "CRITICAL" }]);
    const r = gate(bancada(), rel, {
      statements: [
        {
          vulnerability: "GHSA-88fw-hqm2-52qc",
          products: ["pkg:npm/hono@4.12.23"],
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          impact_statement: "confie em mim",
          reviewedAt: "2026-07-30",
          evidence: [],
        },
      ],
    });
    expect(r.code).toBe(2);
    expect(r.veredito.invalidStatements[0].reason).toMatch(/evidência|evidence/i);
  });

  it("a evidência de importadores CONFINADOS reprova quando aparece importador novo fora do escopo", () => {
    // É a prova medida na auditoria: os únicos arquivos que importam `hono` no SDK são `examples/**`. Se um
    // release do SDK passar a importar `hono` no transporte real, o pacote ENTRA no caminho de execução e
    // esta disposição tem de morrer junto.
    const rel = relatorio([{ id: "GHSA-88fw-hqm2-52qc", components: ["hono@4.12.23"], severity: "HIGH" }]);
    const statement = {
      vulnerability: "GHSA-88fw-hqm2-52qc",
      products: ["pkg:npm/hono@4.12.23"],
      status: "not_affected",
      justification: "vulnerable_code_not_in_execute_path",
      impact_statement: "hono é importado só pelos exemplos do SDK",
      reviewedAt: "2026-07-30",
      evidence: [
        {
          kind: "importers_confined_to",
          scanDir: "node_modules/@modelcontextprotocol/sdk/dist",
          specifier: "hono",
          allow: ["examples/"],
        },
      ],
    };

    const limpo = bancada({
      "node_modules/@modelcontextprotocol/sdk/dist/examples/honoDemo.js": 'require("hono");\n',
      "node_modules/@modelcontextprotocol/sdk/dist/server/streamableHttp.js": 'require("@hono/node-server");\n',
    });
    expect(gate(limpo, rel, { statements: [statement] }).code).toBe(0);

    const contaminado = bancada({
      "node_modules/@modelcontextprotocol/sdk/dist/examples/honoDemo.js": 'require("hono");\n',
      "node_modules/@modelcontextprotocol/sdk/dist/server/streamableHttp.js": 'import { Hono } from "hono";\n',
    });
    const r = gate(contaminado, rel, { statements: [statement] });
    expect(r.code).toBe(2);
    expect(r.veredito.staleStatements[0].reason).toContain("server/streamableHttp.js");
  });

  it("advisory de plataforma alheia exige que o advisory AINDA fale daquela plataforma", () => {
    // `@hono/node-server` só é vulnerável em Windows (o host é Linux). Se o advisory for reescrito e a
    // marca de plataforma sair, a premissa mudou e a disposição precisa de nova revisão humana.
    const statement = {
      vulnerability: "GHSA-frvp-7c67-39w9",
      products: ["pkg:npm/@hono/node-server@1.19.14"],
      status: "not_affected",
      justification: "vulnerable_code_cannot_be_controlled_by_adversary",
      impact_statement: "serve-static não é montado e o alvo de deploy é Linux",
      reviewedAt: "2026-07-30",
      evidence: [{ kind: "platform_not_applicable", advisoryMustMention: "Windows", deploymentPlatform: "linux" }],
    };
    const comMarca = relatorio([
      {
        id: "GHSA-frvp-7c67-39w9",
        components: ["@hono/node-server@1.19.14"],
        summary: "Path traversal in serve-static on Windows via encoded backslash",
      },
    ]);
    expect(gate(bancada(), comMarca, { statements: [statement] }).code).toBe(0);

    const semMarca = relatorio([
      { id: "GHSA-frvp-7c67-39w9", components: ["@hono/node-server@1.19.14"], summary: "Path traversal (all hosts)" },
    ]);
    const r = gate(bancada(), semMarca, { statements: [statement] });
    expect(r.code).toBe(2);
    expect(r.veredito.staleStatements[0].reason).toMatch(/Windows/);
  });

  it("KEV e pacote MAL- reprovam SEMPRE — nenhuma disposição os cobre", () => {
    // Exploração ativa registrada (KEV) e pacote malicioso não são caso de análise de alcançabilidade:
    // são caso de tirar da árvore. Deixar VEX cobri-los seria a válvula que anula o gate.
    const raiz = bancada({ "src/server/main.ts": INVARIANTE });
    const rel = relatorio([
      { id: "MAL-2026-0001", components: ["pacote-ruim@1.0.0"], severity: "LOW", epss: 0 },
      { id: "GHSA-kev-0000-0000", components: ["next@14.2.35"], severity: "MODERATE", kev: true },
    ]);
    const vex = {
      statements: [
        {
          vulnerability: "MAL-2026-0001",
          products: ["pkg:npm/pacote-ruim@1.0.0"],
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          impact_statement: "não usamos",
          reviewedAt: "2026-07-30",
          evidence: [{ kind: "code_invariant", file: "src/server/main.ts", mustContain: INVARIANTE }],
        },
        {
          vulnerability: "GHSA-kev-0000-0000",
          products: ["pkg:npm/next@14.2.35"],
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          impact_statement: "não alcançável",
          reviewedAt: "2026-07-30",
          evidence: [{ kind: "code_invariant", file: "src/server/main.ts", mustContain: INVARIANTE }],
        },
      ],
    };
    const r = gate(raiz, rel, vex);
    expect(r.code).toBe(2);
    expect(r.veredito.unsuppressable).toEqual(["GHSA-kev-0000-0000", "MAL-2026-0001"]);
  });

  it("ATAQUE 5: o catálogo KEV não respondeu — o insuprimível NÃO pode virar suprimível em silêncio", () => {
    // A lavagem aqui não passa pelo VEX: passa pela MEDIÇÃO que faltou. O `osv-query` marca `kev: null` em
    // TODO advisory quando o catálogo da CISA cai (rede, 403, mudança de schema) e diz isso no relatório
    // (`kevCatalogAvailable: false`). O gate filtra `kev === true` — logo, sem catálogo, NENHUM advisory é
    // insuprimível e uma disposição comum volta a cobrir exploração ativa registrada. É o mesmo argumento
    // que o próprio gate já aplica a `failedBatches` ("relatório curto por falha de rede é indistinguível de
    // árvore limpa"): medição que não aconteceu reprova, senão o dia da oscilação é o dia em que o controle
    // mais forte do gate desaparece sem ninguém ver.
    const raiz = bancada({ "src/server/main.ts": INVARIANTE });
    const rel = {
      ...relatorio([
        // exatamente o que o osv-query emite sem catálogo: nem `true` nem `false`, DESCONHECIDO.
        { id: "GHSA-kev-0000-0000", components: ["next@14.2.35"], severity: "MODERATE", kev: null },
      ]),
      kevCatalogAvailable: false,
    };
    const vex = {
      statements: [
        {
          vulnerability: "GHSA-kev-0000-0000",
          products: ["pkg:npm/next@14.2.35"],
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          impact_statement: "não alcançável na nossa configuração",
          reviewedAt: "2026-07-30",
          evidence: [{ kind: "code_invariant", file: "src/server/main.ts", mustContain: INVARIANTE }],
        },
      ],
    };
    const r = gate(raiz, rel, vex);
    expect(r.code).toBe(2);
    expect(r.veredito.kevCatalogUnavailable).toBe(true);
    // e o motivo é NOMEADO para o operador (o modo humano, sem --json), não deduzido do exit code
    let humano = "";
    try {
      execFileSync(
        process.execPath,
        [GATE, "--report", path.join(raiz, "osv.json"), "--vex", path.join(raiz, "vex.json"), "--root", raiz],
        { encoding: "utf8" },
      );
    } catch (e) {
      humano = (e as { stderr?: string }).stderr ?? "";
    }
    expect(humano).toMatch(/KEV INDISPONÍVEL/);

    // CONTRAPROVA (o gate não passou a reprovar por qualquer coisa): com o catálogo medido, a MESMA
    // disposição sobre um advisory que NÃO está no KEV segue aprovando.
    const comCatalogo = relatorio([{ id: "GHSA-kev-0000-0000", components: ["next@14.2.35"], severity: "MODERATE", kev: false }]);
    expect(gate(raiz, comCatalogo, vex).code).toBe(0);
  });

  it("ATAQUE 5b: relatório que OMITE a medição do KEV — ausência de prova era lida como prova de ausência", () => {
    // A trava do ATAQUE 5 barrava a NEGATIVA explícita (`kevCatalogAvailable === false`) e nada mais. Um
    // relatório SEM o campo — produtor de versão anterior, arquivo montado à mão, schema do produtor mudado —
    // voltava a aprovar com `kevCatalogUnavailable: false`: o MESMO furo, pela porta mais barata, e sem
    // precisar nem derrubar a rede. A régua honesta é a medição PROVADA, não a ausência de má notícia.
    const raiz = bancada({ "src/server/main.ts": INVARIANTE });
    const semMedicao: Record<string, unknown> = {
      ...relatorio([{ id: "GHSA-kev-0000-0000", components: ["next@14.2.35"], severity: "MODERATE", kev: null }]),
    };
    delete semMedicao.kevCatalogAvailable;
    const vex = { statements: [statementInvariante({ vulnerability: "GHSA-kev-0000-0000" })] };

    const r = gate(raiz, semMedicao, vex);
    expect(r.code, "relatório sem a medição do KEV tem de REPROVAR — senão o insuprimível some em silêncio").toBe(2);
    expect(r.veredito.kevCatalogUnavailable).toBe(true);

    // CONTRAPROVA: com a medição declarada E o advisory medido, a MESMA disposição segue aprovando — a trava
    // pega medição faltante, não qualquer relatório.
    const medido = relatorio([
      { id: "GHSA-kev-0000-0000", components: ["next@14.2.35"], severity: "MODERATE", kev: false },
    ]);
    expect(gate(raiz, medido, vex).code).toBe(0);
  });

  it("ATAQUE 5c: relatório AFIRMA catálogo medido mas deixa o advisory sem medição (`kev: null`)", () => {
    // A garantia do insuprimível é por ADVISORY: o gate barra quem tem `kev === true`. Um relatório que
    // carrega a afirmação global e um `kev` não-booleano diz, no mesmo arquivo, que mediu e que não mediu — e
    // o advisory não medido volta a poder ser calado por disposição comum. Confiar na afirmação global e
    // ignorar o dado é aceitar a palavra do relatório sobre a própria completude.
    const raiz = bancada({ "src/server/main.ts": INVARIANTE });
    const rel = {
      ...relatorio([{ id: "GHSA-kev-0000-0000", components: ["next@14.2.35"], severity: "MODERATE", kev: null }]),
      kevCatalogAvailable: true,
    };
    const r = gate(raiz, rel, { statements: [statementInvariante({ vulnerability: "GHSA-kev-0000-0000" })] });
    expect(r.code, "advisory sem medição de KEV não pode ser coberto por VEX").toBe(2);
    expect(r.veredito.kevUnmeasuredAdvisories).toEqual(["GHSA-kev-0000-0000"]);
  });

  it("emite VEX no vocabulário OpenVEX (o artefato que o adotante consome)", () => {
    const raiz = bancada({ "src/server/main.ts": INVARIANTE });
    const rel = relatorio([{ id: "GHSA-c4j6-fc7j-m34r", components: ["next@14.2.35"], epss: 0.38872 }]);
    const saida = path.join(raiz, "openvex.json");
    const r = gate(raiz, rel, { statements: [statementInvariante()] }, ["--emit-vex", saida]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(execFileSync("cat", [saida], { encoding: "utf8" }));
    expect(doc["@context"]).toContain("openvex");
    expect(doc.statements[0].vulnerability.name).toBe("GHSA-c4j6-fc7j-m34r");
    expect(doc.statements[0].status).toBe("not_affected");
    // O vocabulário de justificativa do OpenVEX é FECHADO — inventar um valor faz o documento ser
    // ignorado em silêncio pelas ferramentas que o consomem, e aí o ruído volta inteiro.
    expect([
      "component_not_present",
      "vulnerable_code_not_present",
      "vulnerable_code_not_in_execute_path",
      "vulnerable_code_cannot_be_controlled_by_adversary",
      "inline_mitigations_already_exist",
    ]).toContain(doc.statements[0].justification);
  });

  it("tipo de evidência DESCONHECIDO é rejeitado — não existe evidência que passa por não ser entendida", () => {
    // O furo clássico: um `kind` com erro de digitação cai no `default` do verificador, ninguém verifica
    // nada, e a disposição vale. Aqui todo tipo não implementado invalida a disposição.
    const rel = relatorio([{ id: "GHSA-88fw-hqm2-52qc", components: ["hono@4.12.23"], severity: "CRITICAL" }]);
    const r = gate(bancada({ "src/server/main.ts": INVARIANTE }), rel, {
      statements: [
        statementInvariante({
          vulnerability: "GHSA-88fw-hqm2-52qc",
          evidence: [{ kind: "confie_em_mim", note: "medido na auditoria" }],
        }),
      ],
    });
    expect(r.code).toBe(2);
    expect(r.veredito.invalidStatements[0].reason).toMatch(/kind|tipo/i);
  });

  it("justificativa fora do vocabulário OpenVEX é rejeitada na entrada", () => {
    const rel = relatorio([{ id: "GHSA-88fw-hqm2-52qc", components: ["hono@4.12.23"] }]);
    const r = gate(bancada({ "x.ts": "y" }), rel, {
      statements: [statementInvariante({ vulnerability: "GHSA-88fw-hqm2-52qc", justification: "nao_usamos_isso" })],
    });
    expect(r.code).toBe(2);
    expect(r.veredito.invalidStatements[0].reason).toMatch(/justification/);
  });
});

describe("o VEX versionado deste repositório confere contra a árvore de HOJE", () => {
  it("todas as disposições versionadas re-verificam (é o produtor: quebrar o invariante fica vermelho aqui)", () => {
    // Este é o teste que faz o VEX ser um controle e não um arquivo: ele roda o gate REAL sobre o
    // `vex-dispositions.json` REAL e a árvore REAL. Editar `main.ts` e derrubar a posse exclusiva do
    // `upgrade` reprova ESTE teste, no merge gate, antes de qualquer publicação.
    const r = execFileSync(process.execPath, [GATE, "--verify-only", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const v = JSON.parse(r);
    expect(v.staleStatements, `disposições desatualizadas: ${JSON.stringify(v.staleStatements)}`).toEqual([]);
    expect(v.invalidStatements, `disposições inválidas: ${JSON.stringify(v.invalidStatements)}`).toEqual([]);
    expect(v.expiredStatements, `mitigações vencidas: ${JSON.stringify(v.expiredStatements)}`).toEqual([]);
  });
});
