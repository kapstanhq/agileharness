// ── O CONTRATO DE AMBIENTE — o que cada chave SUSTENTA, e o que se desliga em silêncio sem ela ──────
//
// POR QUE ISTO EXISTE. As chaves load-bearing chegam por `.env.local`, que mora na WorkingDirectory do
// serviço e é gitignorado — corretamente, são segredos. Trocar a WorkingDirectory (o cutover da
// inversão) troca o diretório de leitura e NADA MAIS: o arquivo fica para trás, e cada consumidor
// degrada por conta própria, em silêncio. Medido, é isto que se apaga sem um único erro:
//   · o settle do self-deploy nunca autentica → o card fica preso em "Publicando";
//   · a rota de VAPID passa a devolver `publicKey: null` → o operador não consegue nem RE-assinar, e
//     como a inscrição é presa criptograficamente à chave pública, gerar um par novo INVALIDA as
//     antigas em vez de recuperá-las. Ele não percebe que parou: percebe que "o board ficou quieto";
//   · o push do board-data desliga (a leitura exige o literal "1", então "true" também desliga).
//
// Nenhuma dessas falhas grita. É por isso que a resposta certa não é "lembre de copiar o arquivo" — é
// a ferramenta MEDIR e NOMEAR. Este módulo é a tabela; `preflight.ts` é quem a lê.
//
// É PURO de propósito (recebe o env, não o lê): a suíte exercita a ausência sem tocar no ambiente do
// processo, e o mesmo cálculo serve ao preflight e a qualquer chamador futuro.

export interface ChaveDoContrato {
  /** o NOME da variável — nunca o valor, que é segredo. */
  chave: string;
  /** o que deixa de funcionar sem ela, em uma frase, do ponto de vista do OPERADOR. */
  desliga: string;
  /** true quando a degradação é SILENCIOSA — nenhum erro é emitido e o operador só nota pelo efeito. */
  silenciosa: boolean;
}

/**
 * As chaves cuja ausência tem consequência real e que NÃO moram na unit. Não é o catálogo inteiro
 * (`.env.example` é) — é o subconjunto load-bearing, que é o que vale a pena medir.
 */
export const CONTRATO_DE_ENV: readonly ChaveDoContrato[] = [
  {
    chave: "STORYMAP_MCP_TOKEN",
    desliga:
      "o settle do self-deploy não autentica de volta no serviço — o card que disparou o deploy fica " +
      "preso em Publicando até o watchdog escalar",
    silenciosa: true,
  },
  {
    chave: "STORYMAP_VAPID_PUBLIC_KEY",
    desliga:
      "a notificação push para no celular do operador, e a rota de VAPID passa a devolver publicKey " +
      "null — ele não consegue nem re-assinar. Gerar um par NOVO invalida as inscrições antigas em vez " +
      "de recuperá-las: a chave tem de ser a MESMA",
    silenciosa: true,
  },
  {
    chave: "STORYMAP_VAPID_PRIVATE_KEY",
    desliga: "o par de VAPID fica incompleto e o canal de push não arma (o gate exige as duas chaves)",
    silenciosa: true,
  },
  {
    chave: "AGILEHARNESS_PUBLIC_URL",
    desliga: "os links que o serviço emite para fora apontam para o default, não para o endereço público",
    silenciosa: true,
  },
  {
    chave: "STORYMAP_BOARD_AUTOPUSH",
    desliga:
      "o push do board-data para o origin do alvo desliga — e a leitura exige o literal \"1\", então " +
      "um valor plausível como \"true\" desliga do mesmo jeito",
    silenciosa: true,
  },
] as const;

export interface ChaveFaltante extends ChaveDoContrato {
  /** presente mas vazia é diferente de ausente: a primeira costuma ser um arquivo lido pela metade. */
  motivo: "ausente" | "vazia";
}

/**
 * As chaves do contrato que este ambiente não sustenta. PURA: recebe o env, nunca o lê do processo.
 * `STORYMAP_BOARD_AUTOPUSH` é opt-in por desenho, então ausência dela NÃO é falta — só é reportada
 * quando está presente com um valor que o leitor recusa (o caso que engana).
 */
export function chavesFaltantes(env: Record<string, string | undefined>): ChaveFaltante[] {
  const out: ChaveFaltante[] = [];
  for (const c of CONTRATO_DE_ENV) {
    const bruto = env[c.chave];
    if (c.chave === "STORYMAP_BOARD_AUTOPUSH") {
      // opt-in: ausente é uma escolha legítima. Presente-e-não-"1" é a armadilha.
      if (bruto !== undefined && bruto.trim() !== "" && bruto.trim() !== "1") {
        out.push({ ...c, motivo: "vazia" });
      }
      continue;
    }
    if (bruto === undefined) out.push({ ...c, motivo: "ausente" });
    else if (bruto.trim() === "") out.push({ ...c, motivo: "vazia" });
  }
  return out;
}
