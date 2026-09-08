import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@/lib/storymap/paths";
import {
  HOST_TOOL_ENV,
  UPDATE_LOG_ENV,
  UPDATE_SCRIPT_ENV,
  lookupOnPath,
  quotePathForShell,
  resolveHostTool,
  resolveOpsReportScript,
  resolveServiceProbePort,
  resolveServiceUnit,
  resolveUpdateLog,
  resolveUpdateScript,
} from "./host-tools";

// A régua das FERRAMENTAS DO HOST: declarado > PATH > recusa. Ver o cabeçalho de host-tools.ts para o
// porquê. Aqui só a árvore de decisão — `exists` é injetado, então nada disso toca o disco.

const semDisco = (existentes: string[]) => ({ exists: (p: string) => existentes.includes(p) });

describe("resolveHostTool — declarado > PATH > recusa", () => {
  it("a DECLARAÇÃO vence o PATH (mesmo com o PATH tendo um candidato bom)", () => {
    const r = resolveHostTool("bun", {
      env: { AGILEHARNESS_BUN: "/opt/bun/bin/bun", PATH: "/usr/bin" },
      ...semDisco(["/opt/bun/bin/bun", "/usr/bin/bun"]),
    });
    expect(r.ok && r.path).toBe("/opt/bun/bin/bun");
    expect(r.ok && r.via).toBe("declarado");
  });

  it("sem declaração, o PATH resolve — e na ORDEM do PATH, como o shell faria", () => {
    const r = resolveHostTool("just", {
      env: { PATH: "/primeiro:/segundo" },
      ...semDisco(["/segundo/just", "/primeiro/just"]),
    });
    expect(r.ok && r.path).toBe("/primeiro/just");
    expect(r.ok && r.via).toBe("PATH");
  });

  it("[ATAQUE] declarado-mas-inexistente NÃO cai para o PATH — o engano não pode ficar escondido", () => {
    // O modo de falha que este degrau impede: o operador digita o caminho errado, o fallback acha OUTRO
    // binário que por acaso roda, e ele lê "deployou" sem nunca saber que a escolha dele foi ignorada.
    const r = resolveHostTool("bun", {
      env: { AGILEHARNESS_BUN: "/opt/typo/bun", PATH: "/usr/bin" },
      ...semDisco(["/usr/bin/bun"]),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain("/opt/typo/bun");
    expect(!r.ok && r.refusal).toMatch(/declarado mas não existe/);
  });

  it("declaração RELATIVA é recusada — ela se resolveria contra um cwd que ninguém aqui escolhe", () => {
    const r = resolveHostTool("just", { env: { AGILEHARNESS_JUST: "./just" }, ...semDisco(["./just"]) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toMatch(/não é um caminho absoluto/);
  });

  it("sem declaração e sem PATH: a recusa NOMEIA a variável a declarar e o que se perde", () => {
    const r = resolveHostTool("bun", { env: { PATH: "/usr/bin" }, ...semDisco([]) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain(HOST_TOOL_ENV.bun);
    expect(!r.ok && r.refusal).toContain("build:staged"); // o que depende dele
  });

  it("entrada VAZIA do PATH (o `.` implícito do POSIX) não conta — cwd desconhecido não acha root binary", () => {
    expect(lookupOnPath("just", { PATH: ":/usr/bin" }, (p) => p === "just" || p === "/usr/bin/just")).toBe(
      "/usr/bin/just",
    );
  });

  it("PATH ausente não explode — vira recusa", () => {
    const r = resolveHostTool("just", { env: {}, ...semDisco([]) });
    expect(r.ok).toBe(false);
  });
});

describe("quotePathForShell — o caminho embutido no script do self-deploy", () => {
  it("caminho comum sai NU (é o que mantém o script legível e igual ao de antes)", () => {
    expect(quotePathForShell("/root/.bun/bin/bun")).toBe("/root/.bun/bin/bun");
    expect(quotePathForShell("bun")).toBe("bun");
  });
  it("[ATAQUE] caminho com espaço/aspa/cifrão sai CITADO — cru viraria dois argumentos ou expansão", () => {
    expect(quotePathForShell("/opt/my tools/bun")).toBe("'/opt/my tools/bun'");
    expect(quotePathForShell("/opt/$HOME/bun")).toBe("'/opt/$HOME/bun'");
    expect(quotePathForShell("/opt/it's/bun")).toBe(`'/opt/it'\\''s/bun'`);
  });
});

describe("resolveUpdateScript — a tool que roda como ROOT não tem default", () => {
  it("sem declaração RECUSA, e a recusa ensina o que declarar", () => {
    const r = resolveUpdateScript({ env: {}, exists: () => true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain(UPDATE_SCRIPT_ENV);
    expect(!r.ok && r.refusal).toMatch(/não existe default|não há default|não existe um default/);
  });

  it("declarado e existente vira argv `bash <script>` — sem shell, sem interpolação", () => {
    const r = resolveUpdateScript({ env: { [UPDATE_SCRIPT_ENV]: "/srv/update.sh" }, ...semDisco(["/srv/update.sh"]) });
    expect(r.ok && r.argv).toEqual(["bash", "/srv/update.sh"]);
  });

  it("declarado e INEXISTENTE recusa (em vez de mandar o systemd descobrir)", () => {
    const r = resolveUpdateScript({ env: { [UPDATE_SCRIPT_ENV]: "/srv/nao-existe.sh" }, ...semDisco([]) });
    expect(r.ok).toBe(false);
  });

  it("o log é opcional e só absoluto — sem declaração é `null`, e a tool DIZ isso", () => {
    expect(resolveUpdateLog({})).toBeNull();
    expect(resolveUpdateLog({ [UPDATE_LOG_ENV]: "relativo.log" })).toBeNull();
    expect(resolveUpdateLog({ [UPDATE_LOG_ENV]: "/var/log/x.log" })).toBe("/var/log/x.log");
  });
});

// ─── O PRODUTOR: nenhum caminho do HOME de uma pessoa em código executável ───────────────────────
//
// Este é o teste que teria pego os dois defeitos que motivaram o módulo (`/root/.bun/bin/bun` no
// self-deploy e `bash /root/update.sh` na tool MCP). A régua exclui COMENTÁRIO de propósito: o repo
// documenta incidentes com caminhos reais (`/root/.claude/…` na atribuição de processo) e exemplos
// genéricos (`/root/meu-monorepo`), e apagá-los tornaria a documentação pior sem tornar o código mais
// portátil. O que não pode é um caminho desses virar argv, spawn ou script.
describe("[ATAQUE] o motor não conhece o home de ninguém", () => {
  const SRC = path.join(findRepoRoot(), "packages", "storymap-ui", "src");
  const HOME_ALHEIO = /(^|[^A-Za-z0-9_.-])(\/root\/|\/home\/[A-Za-z0-9._-]+\/)/;

  const arquivosDeCodigo = (): string[] => {
    const out: string[] = [];
    const varrer = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const full = path.join(dir, e);
        if (statSync(full).isDirectory()) varrer(full);
        // `.test.ts` fica de fora: um teste PODE citar um caminho absoluto como fixture — é dado de
        // entrada, não endereço que o motor visita.
        else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
      }
    };
    varrer(SRC);
    return out;
  };

  const linhasExecutaveis = (src: string): { n: number; texto: string }[] =>
    src
      .split("\n")
      .map((texto, i) => ({ n: i + 1, texto }))
      .filter(({ texto }) => {
        const t = texto.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      });

  it("nenhuma linha de CÓDIGO em src/ embute um caminho sob /root/ ou /home/<usuário>/", () => {
    const violacoes: string[] = [];
    for (const arquivo of arquivosDeCodigo()) {
      for (const { n, texto } of linhasExecutaveis(readFileSync(arquivo, "utf8"))) {
        if (HOME_ALHEIO.test(texto)) violacoes.push(`${path.relative(SRC, arquivo)}:${n}: ${texto.trim().slice(0, 120)}`);
      }
    }
    expect(
      violacoes.join("\n"),
      "caminho do home de uma pessoa específica em código executável — na máquina de quem clonar ele " +
        "ou não existe (ENOENT no meio de um deploy) ou existe e é OUTRA coisa. Use resolveHostTool()/" +
        "uma declaração de env em vez de um endereço.",
    ).toBe("");
  });

  it("NÃO-VACUIDADE: a varredura leu código de verdade e o padrão ACUSA quando há o que acusar", () => {
    expect(arquivosDeCodigo().length).toBeGreaterThan(200);
    // controle do instrumento: o padrão precisa reprovar a linha que existia até 2026-08.
    expect(HOME_ALHEIO.test('const STAGED_BUILD = "/root/.bun/bin/bun run build:staged";')).toBe(true);
    expect(HOME_ALHEIO.test('["--collect", "--unit", "u", "bash", "/root/update.sh"]')).toBe(true);
    expect(HOME_ALHEIO.test('const x = "/usr/local/bin/bun";')).toBe(false);
  });
});

// ── OPS: o script de erros e a unidade de serviço ────────────────────────────────────────────────
//
// A mesma régua do update script, aplicada às três tools de ops que estavam PUBLICADAS na lista do
// adotante chamando bens da máquina de origem: um script que a extração não leva e uma unidade
// systemd de nome fixo. O produtor mede a recusa, não só o caminho feliz — uma tool que "funciona
// quando declarado" e falha mudo quando não é exatamente o defeito que estamos fechando.
describe("resolveOpsReportScript — declarado, ou a tool nem existe", () => {
  it("sem declaração RECUSA, e a recusa diz o que declarar e qual é o contrato do script", () => {
    const r = resolveOpsReportScript({ env: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("inalcançável");
    expect(r.refusal).toContain("AGILEHARNESS_OPS_REPORT_SCRIPT");
    expect(r.refusal).toContain("--health");
    expect(r.refusal).toContain("query_errors");
  });

  it("[ATAQUE] caminho RELATIVO é recusado — o cwd do serviço não é o do operador", () => {
    const r = resolveOpsReportScript({
      env: { AGILEHARNESS_OPS_REPORT_SCRIPT: "scripts/ops/error-report.js" },
      exists: () => true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toContain("não é um caminho absoluto");
  });

  it("[ATAQUE] absoluto mas INEXISTENTE é recusado — declarar não é ter", () => {
    const r = resolveOpsReportScript({ env: { AGILEHARNESS_OPS_REPORT_SCRIPT: "/opt/nao-existe.js" }, exists: () => false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal).toContain("não existe nesta máquina");
  });

  it("declarado, absoluto e existente: devolve o caminho que vira argv", () => {
    const r = resolveOpsReportScript({ env: { AGILEHARNESS_OPS_REPORT_SCRIPT: "/opt/ops/error-report.js" }, exists: () => true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.script).toBe("/opt/ops/error-report.js");
  });
});

describe("resolveServiceUnit / resolveServiceProbePort", () => {
  it("sem declaração NÃO há unidade — perguntar ao systemd por um nome fixo produzia veredito falso", () => {
    expect(resolveServiceUnit({})).toBeNull();
    expect(resolveServiceUnit({ AGILEHARNESS_SERVICE_UNIT: "   " })).toBeNull();
  });

  it("[ATAQUE] nome com espaço, barra ou cifrão não vira argv de systemctl", () => {
    expect(resolveServiceUnit({ AGILEHARNESS_SERVICE_UNIT: "storymap; rm -rf /" })).toBeNull();
    expect(resolveServiceUnit({ AGILEHARNESS_SERVICE_UNIT: "../../etc/x" })).toBeNull();
    expect(resolveServiceUnit({ AGILEHARNESS_SERVICE_UNIT: "$(id)" })).toBeNull();
    expect(resolveServiceUnit({ AGILEHARNESS_SERVICE_UNIT: "ah@1.service" })).toBe("ah@1.service");
  });

  it("a porta da sonda DERIVA do mesmo par que o servidor lê — o literal não é repetido em dois lugares", () => {
    const main = readFileSync(path.join(process.cwd(), "src/server/main.ts"), "utf8");
    const m = main.match(/const port = Number\([^)]*\)\s*\|\|\s*(\d+)/);
    expect(m, "não achei a porta default no servidor").toBeTruthy();
    expect(resolveServiceProbePort({})).toBe(Number(m![1]));
    expect(resolveServiceProbePort({ PORT: "9999" })).toBe(9999);
    expect(resolveServiceProbePort({ AGILEHARNESS_PORT: "8080", PORT: "9999" })).toBe(8080);
  });
});
