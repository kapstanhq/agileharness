// ── O BOARD PRÓPRIO DESTA INSTÂNCIA — qual board recebe o feedback sobre a FERRAMENTA ─────────────
//
// POR QUE ISTO EXISTE. Três rotas fixavam o literal `"storymap"` no código: as duas do feedback (o
// catálogo de destinos e o repasse de imagens) e a do headroom, que lia a config daquele board para
// achar a URL do proxy. O comentário dizia «PINNED server-side», e a fixação É correta — um board
// escolhido pelo cliente deixaria um pedido forjado enumerar o backlog de board alheio, ou escrever
// na zona de sidecar dele. O defeito nunca foi fixar; foi fixar **um id que só existe no NOSSO
// alvo**. Numa instalação de qualquer outra pessoa não há board `storymap`, então o catálogo de
// destinos vinha vazio e a config do headroom vinha nula — sem erro, sem aviso, sem explicação.
//
// É a mesma classe que o princípio da ferramenta genérica nomeia: o que é do NOSSO repositório não
// pode viajar dentro do produto. A correção mantém a fixação (server-side, nunca do cliente) e só
// troca a FONTE: uma variável de ambiente, declarada por quem instala.
//
// AUSENTE É UMA RESPOSTA LEGÍTIMA, e é o default: uma instalação nova não tem board próprio até
// dizer que tem. Nesse estado as superfícies que dependem dele se declaram DESLIGADAS em vez de
// apontar para um board inventado — o catálogo de destinos responde vazio, e o headroom passa a
// depender só de `AGILEHARNESS_HEADROOM_URL`, que é a fonte que já vencia a do board de qualquer forma.
//
// PURA (recebe o env, nunca o lê): a suíte exercita presente/ausente/vazio sem tocar no processo.

/** O id do board que representa a operação DESTA instalação, ou null quando não há um declarado. */
export function selfBoardId(env: Record<string, string | undefined> = process.env): string | null {
  const bruto = env.AGILEHARNESS_SELF_BOARD?.trim();
  return bruto ? bruto : null;
}
