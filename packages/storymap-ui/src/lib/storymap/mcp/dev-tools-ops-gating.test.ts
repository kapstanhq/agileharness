import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDevTools } from "./dev-tools";

// A LISTA PUBLICADA SÓ CONTÉM O QUE FUNCIONA NESTA INSTALAÇÃO.
//
// `query_errors` e `ops_health` chamavam `scripts/ops/error-report.js` — um caminho relativo a um cwd
// que ninguém escolheu, e um arquivo que a extração NÃO leva. As duas apareciam na lista de
// ferramentas de QUALQUER adotante, que as chamava e recebia um erro de execução opaco. Uma tool
// anunciada e inoperante é pior que a ausência dela: custa um ciclo do agente do outro lado para
// descobrir que o problema não é dele — e o pino de proveniência não pega isso, porque a description
// estava impecável.
//
// A régua é a mesma do `update_vps` (onda 2): declarado > PATH > recusa. Aqui, sem declaração, a tool
// nem chega a ser registrada.

function nomesMontados(env: Record<string, string | undefined>): string[] {
  const nomes: string[] = [];
  const server = { registerTool: (name: string) => { nomes.push(name); } } as unknown as McpServer;
  const antes = process.env.AGILEHARNESS_OPS_REPORT_SCRIPT;
  if (env.AGILEHARNESS_OPS_REPORT_SCRIPT === undefined) delete process.env.AGILEHARNESS_OPS_REPORT_SCRIPT;
  else process.env.AGILEHARNESS_OPS_REPORT_SCRIPT = env.AGILEHARNESS_OPS_REPORT_SCRIPT;
  try {
    registerDevTools(server);
  } finally {
    if (antes === undefined) delete process.env.AGILEHARNESS_OPS_REPORT_SCRIPT;
    else process.env.AGILEHARNESS_OPS_REPORT_SCRIPT = antes;
  }
  return nomes;
}

const OPS = ["query_errors", "ops_health"] as const;

describe("as tools de ops só existem quando o script delas é declarado", () => {
  it("SEM declaração elas ficam FORA da lista publicada", () => {
    const nomes = nomesMontados({ AGILEHARNESS_OPS_REPORT_SCRIPT: undefined });
    expect(nomes.length, "nenhuma tool montada — o guarda mediria o vazio").toBeGreaterThan(20);
    for (const t of OPS) expect(nomes, `${t} não pode ser anunciada sem o script que ela chama`).not.toContain(t);
  });

  it("[ATAQUE] declaração RELATIVA não monta nada — o cwd do serviço não é o do operador", () => {
    const nomes = nomesMontados({ AGILEHARNESS_OPS_REPORT_SCRIPT: "scripts/ops/error-report.js" });
    for (const t of OPS) expect(nomes).not.toContain(t);
  });

  it("[ATAQUE] declaração absoluta mas INEXISTENTE não monta nada — declarar não é ter", () => {
    const nomes = nomesMontados({ AGILEHARNESS_OPS_REPORT_SCRIPT: "/opt/nao-existe-de-jeito-nenhum.js" });
    for (const t of OPS) expect(nomes).not.toContain(t);
  });

  it("COM declaração absoluta e existente, as duas montam", () => {
    const nomes = nomesMontados({ AGILEHARNESS_OPS_REPORT_SCRIPT: process.execPath });
    for (const t of OPS) expect(nomes, `${t} deveria montar com o script declarado`).toContain(t);
  });

  it("`service_health` monta SEMPRE — a metade HTTP é portátil, e a unidade é que é declarada", () => {
    // Diferente das outras duas: uma sonda HTTP em loopback funciona em qualquer instalação. O que
    // saiu foi o nome fixo da unidade systemd, que produzia um "inactive" sobre unidade inexistente —
    // um veredito FALSO, não um erro.
    expect(nomesMontados({ AGILEHARNESS_OPS_REPORT_SCRIPT: undefined })).toContain("service_health");
  });
});
