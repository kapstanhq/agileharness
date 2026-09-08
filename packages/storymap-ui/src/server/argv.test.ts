import { describe, expect, it } from "vitest";
import { classificarArgv, textoDeAjuda, FLAGS_CONHECIDAS, MODIFICADORES } from "./argv";

// -- O ENTRYPOINT NAO SOBE SERVIDOR EM CIMA DE UM ENGANO -----------------------------------------
//
// MEDIDO em 2026-08-28, numa simulacao de onboarding: `node dist/ah-server.mjs --help` — o primeiro
// gesto de qualquer pessoa diante de um binario — SUBIA O SERVIDOR. Nesta VPS morreu com EADDRINUSE
// porque a porta ja era de producao. Numa porta livre teria feito pior, e em silencio: subir um
// servico que ninguem pediu, a partir de um comando que pedia AJUDA.
describe("classificarArgv — argumento desconhecido NUNCA vira boot", () => {
  it("[NAO-VACUIDADE] a lista de flags nao e vazia e cada uma tem resumo", () => {
    expect(FLAGS_CONHECIDAS.length).toBeGreaterThan(4);
    for (const f of FLAGS_CONHECIDAS) {
      expect(f.flag.startsWith("--"), f.flag).toBe(true);
      expect(f.resumo.length, `${f.flag} sem resumo`).toBeGreaterThan(10);
    }
  });

  it("sem argumento nenhum, sobe — o caminho normal segue normal", () => {
    expect(classificarArgv([]).tipo).toBe("boot");
  });

  it("um CAMINHO nao e flag: wrappers passam caminhos, e recusa-los trocaria um footgun por outro", () => {
    expect(classificarArgv(["/root/algum/caminho"]).tipo).toBe("boot");
  });

  it("--help e -h pedem AJUDA, nunca boot", () => {
    expect(classificarArgv(["--help"]).tipo).toBe("ajuda");
    expect(classificarArgv(["-h"]).tipo).toBe("ajuda");
  });

  it("[ATAQUE] o argumento desconhecido e RECUSADO e vem NOMEADO", () => {
    const v = classificarArgv(["--halp"]);
    expect(v.tipo).toBe("desconhecida");
    if (v.tipo === "desconhecida") expect(v.argumentos).toEqual(["--halp"]);
  });

  it("toda flag REAL passa — senao a recusa quebraria o que funciona", () => {
    for (const f of FLAGS_CONHECIDAS) {
      expect(classificarArgv([f.flag]).tipo, f.flag).toBe("boot");
    }
    expect(classificarArgv(["--preflight", "--json"]).tipo).toBe("boot");
  });

  it("forma com = tambem e reconhecida", () => {
    expect(classificarArgv(["--revoke-mcp-handle=abc"]).tipo).toBe("boot");
    expect(classificarArgv(["--nao-existe=1"]).tipo).toBe("desconhecida");
  });

  it("a ajuda NOMEIA toda flag conhecida — senao ela mente por omissao", () => {
    const t = textoDeAjuda();
    for (const f of FLAGS_CONHECIDAS) expect(t, `ajuda sem ${f.flag}`).toContain(f.flag);
    expect(t).toContain("--help");
    expect(t).toContain("AGILEHARNESS_PORT");
    expect(t).toContain("STORYMAP_TARGET");
  });
});

// A PRIMEIRA VERSAO DESTE GUARD QUEBROU O CAMINHO LEGITIMO: ela tratava todo token com `-` como
// comando e recusava `--generate-mcp-handle --level full --label "..."`, que e a forma REAL. Um
// guard que quebra o que funciona e pior que o footgun que fecha. A lista de modificadores foi
// LEVANTADA do fonte, e este teste e o que impede ela de envelhecer em silencio.
describe("classificarArgv — os MODIFICADORES nao sao comandos, e nao podem ser recusados", () => {
  it("a forma real do comando de handle passa inteira", () => {
    expect(classificarArgv(["--generate-mcp-handle", "--level", "full", "--label", "conector"]).tipo).toBe("boot");
  });

  it("cada modificador declarado passa junto de um comando", () => {
    for (const m of MODIFICADORES) {
      expect(classificarArgv(["--preflight", m, "x"]).tipo, m).toBe("boot");
    }
  });

  it("[NAO-VACUIDADE] a lista nao e vazia, e um vizinho INVENTADO continua sendo recusado", () => {
    expect(MODIFICADORES.length).toBeGreaterThan(3);
    expect(classificarArgv(["--preflight", "--levelzinho"]).tipo).toBe("desconhecida");
  });
});
