// O NUCLEO PURO DO ARGV — separado do `main.ts` de proposito.
//
// `main.ts` tem efeito de topo (ele constroi o app do Next e sobe o servidor), entao um teste que o
// IMPORTASSE para exercitar uma funcao pura BOOTARIA o servico — medido: a primeira versao deste
// teste criou um auth-token e comecou o boot so por importar. A base ja separa planejador puro de
// casca impura em todo lugar (planSessionDelivery, gate-core, preflight); aqui nao e diferente.

/**
 * AS FLAGS QUE O ENTRYPOINT RECONHECE — e a razão de a lista ser um VALOR e não prosa.
 *
 * MEDIDO em 2026-08-28, na simulação de onboarding: `node dist/ah-server.mjs --help` — o primeiro
 * gesto de qualquer pessoa diante de um binário — **subia o servidor**. Nesta VPS ele morreu com
 * EADDRINUSE porque a porta já era de produção; numa porta livre teria feito pior, e em silêncio:
 * subir um serviço que ninguém pediu, a partir de um comando que pedia AJUDA.
 *
 * A causa é a mesma classe que esta base trata como fail-closed em toda porta que decide alcance:
 * argumento não reconhecido CAÍA no boot. Agora ele é RECUSADO — e a lista abaixo é o que a recusa
 * e a ajuda imprimem, das duas uma sozinha não pode divergir da outra.
 */
export const FLAGS_CONHECIDAS: ReadonlyArray<{ flag: string; resumo: string }> = [
  { flag: "--preflight", resumo: "relatório de prontidão do host, sem subir o serviço (aceita --json)" },
  { flag: "--generate-mcp-token", resumo: "gera um token MCP forte e IMPRIME — não arma nada" },
  { flag: "--generate-systemd-unit", resumo: "imprime o unit systemd desta máquina (nunca instala)" },
  { flag: "--print-mcp-client-config", resumo: "imprime a config de cliente MCP para esta instalação" },
  { flag: "--generate-mcp-handle", resumo: "emite um handle MCP revogável" },
  { flag: "--list-mcp-handles", resumo: "lista os handles emitidos" },
  { flag: "--revoke-mcp-handle", resumo: "revoga um handle pelo id" },
];

/**
 * MODIFICADORES — flags que qualificam um comando em vez de serem um. Não aparecem na ajuda como
 * comandos porque não são: `--label` sozinho não faz nada.
 *
 * A lista foi LEVANTADA do fonte (todo `valorDaFlag`/`temFlag` do entrypoint), não lembrada — foi
 * exatamente o que a primeira versão errou: ela tratava todo token com `-` como comando e RECUSAVA
 * `--generate-mcp-handle --level full --label "..."`, que é a forma real do comando. Um guard que
 * quebra o caminho legítimo é pior que o footgun que ele fecha.
 */
export const MODIFICADORES: ReadonlyArray<string> = [
  "--json",        // qualifica --preflight
  "--level",       // qualifica --generate-mcp-handle
  "--label",       // idem
  "--credential",  // qualifica --print-mcp-client-config
  "--url",         // idem
  "--unit-name",   // qualifica --generate-systemd-unit
];

/** O texto de `--help`. PURO — o teste o lê sem subir nada. */
export function textoDeAjuda(flags: ReadonlyArray<{ flag: string; resumo: string }> = FLAGS_CONHECIDAS): string {
  const largura = Math.max(...flags.map((f) => f.flag.length));
  const linhas = flags.map((f) => `  ${f.flag.padEnd(largura)}  ${f.resumo}`);
  return [
    "AgileHarness — o servidor do board.",
    "",
    "  node dist/ah-server.mjs               sobe o serviço",
    "  node dist/ah-server.mjs <flag>        roda um comando e SAI, sem subir nada",
    "",
    "Flags:",
    ...linhas,
    "  --help, -h" + " ".repeat(Math.max(1, largura - 9)) + "  esta ajuda",
    "",
    "Ambiente: AGILEHARNESS_PORT (default 3008) · AGILEHARNESS_HOST · AGILEHARNESS_TARGET (a raiz do",
    "repositório que este serviço gerencia) · AGILEHARNESS_ENGINE=off (só serve, sem motor).",
  ].join("\n");
}

/**
 * O veredito sobre o argv, PURO. Três saídas, e a do meio é a que não existia:
 *   - `ajuda`      → imprime e sai 0
 *   - `desconhecida` → RECUSA e sai 2, nomeando o que veio e o que existe. NUNCA sobe o serviço.
 *   - `boot`       → nenhum argumento de comando; segue o caminho normal
 *
 * Só argumentos que COMEÇAM com `--`/`-` contam: o entrypoint é chamado por wrappers que passam
 * caminhos, e recusar um caminho seria trocar um footgun por outro.
 */
export function classificarArgv(
  argv: readonly string[],
  flags: ReadonlyArray<{ flag: string }> = FLAGS_CONHECIDAS,
): { tipo: "boot" } | { tipo: "ajuda" } | { tipo: "desconhecida"; argumentos: string[] } {
  const candidatos = argv.filter((a) => a.startsWith("-"));
  if (candidatos.length === 0) return { tipo: "boot" };
  if (candidatos.some((a) => a === "--help" || a === "-h")) return { tipo: "ajuda" };
  const conhecidas = new Set(flags.map((f) => f.flag));
  const auxiliares = new Set(MODIFICADORES);
  const desconhecidas = candidatos.filter((a) => {
    const nome = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    return !conhecidas.has(nome) && !auxiliares.has(nome);
  });
  return desconhecidas.length > 0 ? { tipo: "desconhecida", argumentos: desconhecidas } : { tipo: "boot" };
}