import { describe, it, expect } from "vitest";

import { HOST_TOOL_ENV } from "./host-tools";
import { CLAUDE_DEFAULT_NAME, ClaudeBinUnavailable, resolveClaudeBinVerdict, resolvedClaudeBin } from "./claude-bin";

// A régua do `claude`: ENDEREÇO (AGILEHARNESS_CLAUDE) > NOME (autorun.claudeBin) > PATH > recusa.
// Ver o cabeçalho de claude-bin.ts para o porquê da separação NOME × ENDEREÇO. Aqui só a árvore de
// decisão — `exists` é injetado, então nada disto toca o disco.

const semDisco = (existentes: string[]) => ({ exists: (p: string) => existentes.includes(p) });

describe("resolveClaudeBinVerdict — ENDEREÇO > NOME > PATH > recusa", () => {
  it("o ENDEREÇO vence o NOME e o PATH", () => {
    const r = resolveClaudeBinVerdict({
      name: "claude",
      env: { AGILEHARNESS_CLAUDE: "/opt/claude/bin/claude", PATH: "/usr/bin" },
      ...semDisco(["/opt/claude/bin/claude", "/usr/bin/claude"]),
    });
    expect(r.ok && r.path).toBe("/opt/claude/bin/claude");
    expect(r.ok && r.via).toBe("declarado");
  });

  it("sem endereço, o NOME NU resolve pelo PATH, na ordem do PATH", () => {
    const r = resolveClaudeBinVerdict({
      env: { PATH: "/primeiro:/segundo" },
      ...semDisco(["/segundo/claude", "/primeiro/claude"]),
    });
    expect(r.ok && r.path).toBe("/primeiro/claude");
    expect(r.ok && r.via).toBe("PATH");
  });

  it("o NOME escolhe QUAL binário procurar — um canary não vira 'claude' em silêncio", () => {
    const r = resolveClaudeBinVerdict({
      name: "claude-canary",
      env: { PATH: "/usr/bin" },
      ...semDisco(["/usr/bin/claude-canary", "/usr/bin/claude"]),
    });
    expect(r.ok && r.path).toBe("/usr/bin/claude-canary");
  });

  it("a recusa NOMEIA o binário procurado, não a chave da ferramenta", () => {
    const r = resolveClaudeBinVerdict({
      name: "claude-canary",
      env: { PATH: "/usr/bin" },
      ...semDisco(["/usr/bin/claude"]),
    });
    expect(r.ok).toBe(false);
    // Sem isto a recusa falaria de `claude` — que EXISTE — e mandaria o operador caçar um ganso.
    expect(!r.ok && r.refusal).toContain("claude-canary");
  });

  it("[FAIL-CLOSED] endereço declarado que não existe RECUSA, e NÃO cai para o PATH", () => {
    // A asserção que carrega o teste é a NEGATIVA: provar que o fallback não aconteceu. Cair seria
    // esconder um erro de digitação atrás de um binário que por acaso funciona.
    const consultados: string[] = [];
    const r = resolveClaudeBinVerdict({
      env: { AGILEHARNESS_CLAUDE: "/opt/errado/claude", PATH: "/usr/bin" },
      exists: (p) => {
        consultados.push(p);
        return p === "/usr/bin/claude";
      },
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain("AGILEHARNESS_CLAUDE");
    expect(consultados).toEqual(["/opt/errado/claude"]);
    expect(consultados).not.toContain("/usr/bin/claude");
  });

  it("endereço relativo é recusado, e a recusa dá o exemplo absoluto", () => {
    const r = resolveClaudeBinVerdict({
      env: { AGILEHARNESS_CLAUDE: "bin/claude", PATH: "/usr/bin" },
      ...semDisco(["/usr/bin/claude"]),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain("não é um caminho absoluto");
  });
});

describe("o NOME que chega ABSOLUTO — compatibilidade preservada, e a recusa honesta", () => {
  it("um nome absoluto que existe é aceito (USM_AUTORUN_CLAUDE_BIN=/opt/... funciona hoje)", () => {
    const r = resolveClaudeBinVerdict({
      name: "/opt/claude-canary/claude",
      env: { PATH: "/usr/bin" },
      ...semDisco(["/opt/claude-canary/claude"]),
    });
    expect(r.ok && r.path).toBe("/opt/claude-canary/claude");
    expect(r.ok && r.via).toBe("declarado");
  });

  it("[HONESTIDADE] nome absoluto inexistente culpa o canal do NOME, não AGILEHARNESS_CLAUDE", () => {
    const r = resolveClaudeBinVerdict({
      name: "/opt/sumiu/claude",
      env: { PATH: "/usr/bin" },
      ...semDisco(["/usr/bin/claude"]),
    });
    expect(r.ok).toBe(false);
    const recusa = !r.ok ? r.refusal : "";
    // Mandar corrigir uma variável que o operador nunca escreveu é como um diagnóstico vira
    // uma caça ao ganso.
    expect(recusa).toContain("autorun.claudeBin");
    expect(recusa).toContain("USM_AUTORUN_CLAUDE_BIN");
    expect(recusa).not.toMatch(/AGILEHARNESS_CLAUDE=".*" foi declarado/);
  });

  it("nome relativo COM separador é recusado — o cwd não é escolha deste módulo", () => {
    const r = resolveClaudeBinVerdict({
      name: "./claude",
      env: { PATH: "/usr/bin" },
      ...semDisco(["/usr/bin/claude"]),
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toContain("caminho relativo");
  });
});

describe("[REGRESSÃO] o incidente de 2026-08-20 → 26", () => {
  it("o PATH fixado pelo unit + o claude em ~/.local/bin RECUSA, em vez de virar ENOENT mudo", () => {
    // Os bytes exatos do incidente: `Environment=PATH=` do storymap.service, e o binário no único
    // lugar que ele não alcança. Antes desta régua isto spawnava `claude` nu e morria com exit 127
    // dentro do console de um card — invisível por seis dias.
    const r = resolveClaudeBinVerdict({
      env: { PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin" },
      ...semDisco(["/root/.local/bin/claude"]),
    });
    expect(r.ok).toBe(false);
    const recusa = !r.ok ? r.refusal : "";
    expect(recusa).toContain(HOST_TOOL_ENV.claude);
    expect(recusa).toContain("claude");
    // A recusa precisa dizer o que PARA, senão ela informa sem orientar.
    expect(recusa).toMatch(/autorun|Jido|orquestrador|agente/i);
  });

  it("declarar o endereço conserta — o mesmo host, com AGILEHARNESS_CLAUDE, resolve", () => {
    const r = resolveClaudeBinVerdict({
      env: {
        PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin",
        AGILEHARNESS_CLAUDE: "/root/.local/bin/claude",
      },
      ...semDisco(["/root/.local/bin/claude"]),
    });
    expect(r.ok && r.path).toBe("/root/.local/bin/claude");
  });
});

describe("resolvedClaudeBin — lança carregando a recusa", () => {
  it("devolve o caminho quando resolve", () => {
    const p = resolvedClaudeBin({ env: { PATH: "/usr/bin" }, ...semDisco(["/usr/bin/claude"]) });
    expect(p).toBe("/usr/bin/claude");
  });

  it("lança ClaudeBinUnavailable, e a recusa viaja em `.refusal`", () => {
    let capturado: unknown;
    try {
      resolvedClaudeBin({ env: { PATH: "/usr/bin" }, ...semDisco([]) });
    } catch (e) {
      capturado = e;
    }
    expect(capturado).toBeInstanceOf(ClaudeBinUnavailable);
    expect((capturado as ClaudeBinUnavailable).refusal).toContain(HOST_TOOL_ENV.claude);
  });
});

describe("não-vacuidade", () => {
  it("o default é o nome nu, e o veredito sem entrada nenhuma ainda decide", () => {
    expect(CLAUDE_DEFAULT_NAME).toBe("claude");
    const r = resolveClaudeBinVerdict({ env: {}, ...semDisco([]) });
    expect(r.ok).toBe(false);
  });

  it("`claude` está no registro das ferramentas do host, ao lado de bun e just", () => {
    expect(HOST_TOOL_ENV.claude).toBe("AGILEHARNESS_CLAUDE");
    expect(Object.keys(HOST_TOOL_ENV).length).toBeGreaterThanOrEqual(3);
  });
});

describe("[REGRESSÃO] o corte da invocação é ANCORADO no binário, não adivinhado por nome", () => {
  it("um canary — nome legítimo pela régua — corta no lugar certo", async () => {
    // ACHADO em 2026-08-26, ao declarar um binário de fixture no setup da suíte. O portão que impede
    // um run de nascer sem a fronteira que anunciou (`assertContainmentReachedCommand`) separa o
    // comando do agente do embrulho do `systemd-run` procurando o ÚLTIMO token cujo basename casa
    // /(^|\/)claude$/. Com um binário chamado de outra coisa esse corte NÃO acontece.
    //
    // CONSEQUÊNCIA REAL, e não hipotética: a régua deste módulo aceita, de propósito, tanto um NOME
    // diferente (`autorun.claudeBin: "claude-canary"`) quanto um ENDEREÇO qualquer
    // (`AGILEHARNESS_CLAUDE=/opt/x/meubin`). As duas configurações são legítimas e as duas fazem o
    // corte falhar — medido: 12 testes do governor reprovaram com "CONTENÇÃO PROMETIDA E AUSENTE DO
    // COMANDO" quando o fixture apontava para um binário chamado `node`.
    //
    // Este teste não conserta o acoplamento; ele o torna VISÍVEL, para que quem mexer no vocabulário
    // de nomes saiba o que mais precisa mudar. O conserto é o portão receber o binário resolvido em
    // vez de reconhecê-lo por nome, e tem custo próprio.
    const { recorteDaInvocacao } = await import("./autonomy-sandbox");

    const embrulhado = ["systemd-run", "--scope", "--collect", "/usr/local/bin/claude", "-p", "--settings", "/x.json"];
    expect(
      recorteDaInvocacao(embrulhado, "/usr/local/bin/claude")[0],
      "com o nome canônico, o corte começa no binário",
    ).toBe("/usr/local/bin/claude");

    const canary = ["systemd-run", "--scope", "--collect", "/opt/x/claude-canary", "-p", "--settings", "/x.json"];
    expect(
      recorteDaInvocacao(canary, "/opt/x/claude-canary")[0],
      "CONSERTADO: com o binário ancorado, um canary corta no lugar certo",
    ).toBe("/opt/x/claude-canary");
  });
});
