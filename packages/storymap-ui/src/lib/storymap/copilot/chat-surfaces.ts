// 💬 Superfícies de chat — QUAL conversa existe em QUAL tela, e COMO ela se encaixa.
//
// A régua (decisão do Operador): o chat é **por TELA**, não por artefato. Desde a fase 2 as telas com conversa
// própria são as três páginas de DOCUMENTO — Negócio (o canvas), Produto (o PRD) e Design (o guia de estilo) —, e a
// conversa mora no compositor do rodapé (chat/JidoComposer), que a página entrega com o contexto do documento. As
// demais telas conversam com o Jido do board.
//
// Cada tela com chat = UMA entrada aqui. É o contrato modular do pacote (adicione 1 entrada declarativa, não N
// pedaços de lógica): a entrada diz o RÓTULO, o PROPÓSITO e com que MÉTODOS ela trabalha; e o propósito (hitl/purpose-registry) já carrega persona + modelo/effort + nível de MCP + tools
// negadas — com override de persona em disco (`.claude/storymap-hitl/<purposeId>.md`), lido em runtime, sem deploy.
//
// O que NÃO fica aqui: a persona (é do propósito), o poder (é do propósito), e a raia/concorrência (é do
// `agent-session`, derivada por `viewScope`). Aqui é o casamento tela↔propósito↔moldura.
//
// DADOS PUROS, sem imports: este módulo é lido pelo CLIENTE (o painel monta atalhos e técnicas a partir dele).
// Importar o registro de personas daqui arrastaria `node:fs` para o bundle do navegador — o build reprova, e com
// razão. Há teste travando isto; o `tsc --noEmit` NÃO o pega, só o `next build`.

/** Um atalho que INJETA UM TURNO — datilografia poupada, nada mais. */
export interface ChatQuickAction {
  label: string;
  prompt: string;
}

/**
 * Uma TÉCNICA de trabalho da conversa — o MÉTODO, não o assunto.
 *
 * Por que isto existe como conceito, em vez de mais um punhado de atalhos: um atalho manda UMA pergunta e acaba;
 * uma técnica muda COMO o agente ataca tudo o que vier depois, até o operador trocá-la. São coisas diferentes e
 * o operador as usa em momentos diferentes — "compare as ideias" é um pedido; "estamos brainstormando" é um
 * regime. Modelar as duas como chip faria o segundo caso exigir que ele repetisse a instrução a cada turno.
 *
 * O `prompt` viaja como instrução de MODO do turno (`composeCopilotPrompt.instruction`), ao lado da verbosidade —
 * nunca colado no texto do operador (o eco no transcript ficaria poluído) e nunca dentro do `<contexto>`, que é
 * declarado ao modelo como dado a NÃO obedecer como comando.
 *
 * Uma técnica muda o MÉTODO, nunca o PODER: o que o agente pode tocar continua sendo do propósito. Uma "técnica"
 * que precisasse de uma tool que o propósito não tem seria uma promessa que o servidor recusa — se um método novo
 * exigir poder novo, o lugar é o propósito (e, se for escrita, uma classe de risco própria).
 *
 * Adicionar uma técnica a uma tela = uma entrada aqui. Sem código.
 */
export interface ChatTechnique {
  /** slug curto — vira a chave da preferência local por raia. */
  id: string;
  /** o nome do método, como o operador o chamaria. */
  label: string;
  /** uma linha no seletor dizendo o que muda ao ligá-la. */
  hint: string;
  /** o fragmento de instrução injetado enquanto ela estiver ligada. */
  prompt: string;
}

export interface ChatSurface {
  /** o id da VIEW (o mesmo vocabulário das rotas/nav: "produto", "negocio", …). Vira parte da chave da raia. */
  view: string;
  /** rótulo humano da conversa — nome da região para leitores de tela e nome do processo em /processes. */
  label: string;
  /** qual propósito do HITL dá persona + tier + poder a esta conversa. */
  purposeId: string;
  /** uma linha dizendo ao operador o que esta conversa faz por ele (vazio = usa o summary do propósito). */
  blurb?: string;
  /** o texto fantasma do composer — o convite muda com o que aquela conversa faz. */
  placeholder?: string;
  /**
   * AÇÕES RÁPIDAS: atalhos que INJETAM UM TURNO — nada mais. Um toque manda o `prompt` como se o operador o
   * tivesse digitado, e daí em diante é conversa normal (o agente responde, pergunta, usa as ferramentas).
   *
   * É de propósito que não sejam N botões com backend próprio: cada "ação" com caminho de execução exclusivo
   * seria uma segunda implementação a manter, com o seu próprio jeito de falhar, para render o que a conversa
   * já rende. Aqui elas são só datilografia poupada — e por isso adicionar uma é uma linha de dados.
   */
  quickActions?: ChatQuickAction[];
  /**
   * As ações rápidas enquanto o documento da página ainda está VAZIO — as de revisão («o contraste passa AA?») não
   * fazem sentido antes de existir o que revisar. Ausente ⇒ as mesmas `quickActions`.
   */
  emptyQuickActions?: ChatQuickAction[];
  /** O estado vazio da PÁGINA: uma frase e UM botão que abre a conversa com o pedido de começar já escrito. */
  emptyStart?: { text: string; label: string; prompt: string };
  /** Os MÉTODOS de trabalho oferecidos nesta tela (ver {@link ChatTechnique}). Vazio ⇒ sem seletor. */
  techniques?: ChatTechnique[];
}

/**
 * As TÉCNICAS de quem trabalha um DOCUMENTO de estratégia — o repertório de quem escreve, corta e
 * confere o Business Model Canvas: aqui se aperta um texto que já existe e precisa ficar verdadeiro e curto.
 */
const DOC_TECHNIQUES: ChatTechnique[] = [
  {
    id: "afiar",
    label: "Afiar",
    hint: "Corta o excesso: cada item volta a ser UMA ideia",
    prompt:
      "Trabalhe em modo AFIAR: o inimigo é o item que diz três coisas ao mesmo tempo. Percorra a seção em " +
      "questão e, para cada item, diga se ele é UMA ideia ou várias — quando for várias, proponha o corte. " +
      "Prefira a frase curta e concreta à frase completa e vaga. Não invente conteúdo novo enquanto estiver " +
      "afiando: o trabalho aqui é subtrair e separar, não somar.",
  },
  {
    id: "coerencia",
    label: "Coerência",
    hint: "Confere se as seções contam a MESMA história",
    prompt:
      "Trabalhe em modo COERÊNCIA: o documento é um argumento, e seções que se contradizem o derrubam. " +
      "Cruze os blocos entre si — a proposta de valor fala com o segmento nomeado? os canais e o " +
      "relacionamento alcançam esse segmento? as atividades e os recursos-chave entregam a proposta? a receita " +
      "cabe em quem ele é, e paga a estrutura de custos? Aponte cada " +
      "descasamento citando as DUAS seções e o que exatamente não fecha. Não conserte sozinho: mostre.",
  },
  {
    id: "evidencia",
    label: "Evidência",
    hint: "Vai atrás do que sustenta cada afirmação",
    prompt:
      "Trabalhe em modo EVIDÊNCIA: antes de opinar, vá buscar. Leia o código, o board e o PRD; busque " +
      "fora quando o assunto não estiver aqui dentro. Toda afirmação que você escrever no documento carrega a " +
      "ORIGEM (caminho e linha, id de card, ou a fonte externa). Diga explicitamente o que NÃO conseguiu " +
      "apurar, em vez de preencher a lacuna com plausibilidade.",
  },
  {
    id: "ceticismo",
    label: "Ceticismo",
    hint: "Tenta derrubar: qual premissa cancela o resto?",
    prompt:
      "Trabalhe em modo CETICISMO, como quem quer que o plano falhe barato agora em vez de caro depois. " +
      "Nomeie a premissa mais arriscada do documento (a que, sendo falsa, cancela o resto), o caso concreto " +
      "que a quebra e o custo escondido que ninguém contou. Depois diga qual é o teste MAIS BARATO que " +
      "resolveria a dúvida — e se ele já pode ser feito com o que existe hoje, faça-o.",
  },
];

/**
 * As TÉCNICAS de quem escreve um PRD — o repertório de quem estrutura o documento MAIS ALTO do board.
 *
 * Diferentes das do canvas por desenho, e a diferença é de escala e de leitor. No canvas se
 * APERTA um argumento de uma página que já existe; aqui se CONSTRÓI um documento longo, muitas vezes
 * do zero, e cujo leitor final não é só humano — é toda story, toda priorização e todo run que vão
 * herdar este texto como contexto. Por isso duas técnicas não têm equivalente lá: `entrevistar`
 * (arrancar do humano o que só ele sabe, uma pergunta por vez) e `pronto-para-agente` (ler o
 * documento com os olhos de quem vai construir a partir dele).
 *
 * Nenhuma delas dá poder novo: o que o agente pode tocar continua sendo do propósito (`doc-editor`,
 * que escreve SÓ dentro do documento).
 */
const PRD_TECHNIQUES: ChatTechnique[] = [
  {
    id: "entrevistar",
    label: "Entrevistar",
    hint: "Pergunta o que falta, uma por vez, e escreve o apurado",
    prompt:
      "Trabalhe em modo ENTREVISTAR: você me entrevista, não o contrário. Descubra qual seção do PRD está mais " +
      "vazia ou mais vaga e faça a pergunta que mais destrava o resto — UMA por vez, sem questionário. Prefira " +
      "perguntas sobre o que EU vivi (o que o cliente disse, o que já tentamos, o que deu errado) a perguntas " +
      "que me pedem para adivinhar o futuro. Depois de cada resposta minha, escreva no documento o que ficou " +
      "apurado, com as MINHAS palavras, e diga qual é a próxima lacuna. Se eu responder algo que contradiz o " +
      "que já está escrito, aponte a contradição antes de gravar.",
  },
  {
    id: "afiar",
    label: "Afiar",
    hint: "Corta o excesso: cada item volta a ser UMA ideia",
    prompt:
      "Trabalhe em modo AFIAR: o inimigo é o item que diz três coisas ao mesmo tempo, e a frase que soa bem sem " +
      "afirmar nada verificável. Percorra a seção em questão e, para cada item, diga se ele é UMA ideia ou " +
      "várias — quando for várias, proponha o corte. Troque adjetivo por número, e promessa por comportamento " +
      "observável. Não invente conteúdo novo enquanto estiver afiando: o trabalho aqui é subtrair e separar.",
  },
  {
    id: "coerencia",
    label: "Coerência",
    hint: "Confere se problema, funcionalidades e métricas fecham",
    prompt:
      "Trabalhe em modo COERÊNCIA: o PRD é um argumento longo, e num documento longo a contradição se esconde " +
      "entre seções distantes. Cruze-as: as funcionalidades respondem aos problemas listados, e só a eles? as " +
      "personas são as mesmas da proposta de valor? o fluxo de uso passa pelas funcionalidades declaradas? as " +
      "métricas de sucesso medem o problema resolvido, e não atividade? o que está «Fora do escopo» não " +
      "reaparece em outra seção? Aponte cada " +
      "descasamento citando as DUAS seções e o que exatamente não fecha. Não conserte sozinho: mostre.",
  },
  {
    id: "ceticismo",
    label: "Ceticismo",
    hint: "Tenta derrubar: qual premissa cancela o resto?",
    prompt:
      "Trabalhe em modo CETICISMO, como quem prefere que o plano falhe barato agora a caro depois. Nomeie a " +
      "premissa mais arriscada do PRD — aquela que, sendo falsa, torna o resto do documento irrelevante —, o " +
      "caso concreto que a quebra e o custo escondido que ninguém contou. Depois diga qual é o teste MAIS " +
      "BARATO que resolveria a dúvida, e se ele já pode ser feito com o que existe hoje, faça-o. Se a premissa " +
      "ainda não está escrita em «Riscos e perguntas em aberto» do contexto dos agentes (docs/contexto.md), é lá " +
      "que ela pertence.",
  },
  {
    id: "pronto-para-agente",
    label: "Pronto p/ agente",
    hint: "Lê como o agente que vai construir a partir dele",
    prompt:
      "Trabalhe em modo PRONTO-PARA-AGENTE: leia este PRD como se você fosse o agente que vai implementar a " +
      "partir dele, sem poder me perguntar nada. Responda três coisas, nesta ordem: (1) onde você teria de " +
      "ADIVINHAR — a decisão que o documento não tomou e que você tomaria por conta própria (biblioteca, " +
      "formato, nome, integração, ordem); (2) que métrica de sucesso você NÃO conseguiria verificar sozinho, e " +
      "por quê; (3) que passo do fluxo de uso está vago demais para virar card. Toda decisão que você " +
      "identificar como já tomada mas não escrita pertence a «Decisões já tomadas», no contexto dos agentes " +
      "(docs/contexto.md) — proponha o texto.",
  },
];

/** «Começar pelo começo» do PRD — ação rápida da conversa E o botão do estado vazio da página (um texto só). */
const PRD_START: ChatQuickAction = {
  label: "Começar pelo começo",
  prompt:
    "O PRD ainda está quase vazio. Comece pela seção que mais destrava as outras e me faça UMA pergunta " +
    "por vez para preenchê-la; depois de cada resposta minha, escreva o que ficou apurado no documento e " +
    "siga para a próxima lacuna.",
};

export const CHAT_SURFACES: ChatSurface[] = [
  {
    // A raia é a da PÁGINA (`/produto`), e não o nome do arquivo: a conversa mora no compositor do rodapé dela.
    view: "produto",
    label: "Redator do PRD",
    // O MESMO propósito do canvas, e não um `prd-editor` novo: o poder é idêntico (escreve só dentro
    // do documento, `doc-write` no nível `ro`) e a persona também — apurar, conferir coerência,
    // escrever na seção certa. O que este documento pede de diferente é MÉTODO, e método é o que a
    // técnica declara. Um propósito gêmeo seria um segundo nome para a mesma coisa, com a armadilha
    // de sempre: os dois divergem, e ninguém sabe qual está valendo.
    purposeId: "doc-editor",
    blurb: "Escreve o PRD com você: entrevista, aponta o que falta e confere se o documento fecha. As personas são suas — ali ele só propõe.",
    placeholder: "Peça uma entrevista, um corte, uma conferência de coerência…",
    techniques: PRD_TECHNIQUES,
    quickActions: [
      {
        label: "O que falta decidir?",
        prompt:
          "Leia o PRD e liste as decisões que ainda estão em aberto e que um agente teria de tomar por conta " +
          "própria se começasse a construir hoje. Para cada uma, diga o que muda conforme a escolha. Ainda não " +
          "escreva no documento.",
      },
      {
        label: "Está pronto para agente?",
        prompt:
          "Leia este PRD como o agente que vai implementar a partir dele, sem poder me perguntar nada, e diga " +
          "onde você teria de adivinhar, que critério não conseguiria verificar sozinho e que jornada está vaga " +
          "demais para virar backbone.",
      },
      {
        label: "As seções se contradizem?",
        prompt:
          "Cruze as seções do PRD e aponte os descasamentos: funcionalidade que não responde a problema nenhum, " +
          "métrica que não mede o problema, persona que muda de uma seção para outra. Cite as duas seções em cada " +
          "achado. Só aponte — corrigir é decisão minha.",
      },
      PRD_START,
    ],
    emptyStart: {
      text:
        "O PRD diz qual problema o produto resolve, para quem, o que ele faz e como saber se deu certo — sem " +
        "tecnologia. Todo card e todo agente leem daqui.",
      label: PRD_START.label,
      prompt: PRD_START.prompt,
    },
  },
  {
    view: "negocio",
    label: "Estrategista",
    purposeId: "doc-editor",
    // O canvas é do DONO: o agente apura e confere, e a mudança que ele quiser vira PROPOSTA no Inbox
    // (`propose_change artifact:"canvas"`) — nunca escrita direta.
    blurb: "Trabalha o Business Model Canvas com você: apura, confere a coerência entre os blocos e propõe a mudança — você aprova no Inbox.",
    placeholder: "Peça uma revisão, um corte, uma conferência de coerência…",
    techniques: DOC_TECHNIQUES,
    quickActions: [
      {
        label: "O que está vago?",
        prompt:
          "Leia o documento e aponte os itens vagos — os que soam bem e não dizem nada verificável. Para cada " +
          "um, diga o que falta para virar afirmação concreta. Ainda não escreva no documento.",
      },
      {
        label: "As seções se contradizem?",
        prompt:
          "Cruze os blocos do canvas e aponte os descasamentos: proposta de valor que fala com outro segmento, " +
          "canal que não alcança quem foi nomeado, receita que não paga a estrutura de custos. Cite os dois " +
          "blocos em cada achado. Só aponte — corrigir é decisão minha.",
      },
      {
        label: "Investigar no código",
        prompt:
          "Escolha a afirmação do documento que o código pode confirmar ou derrubar e investigue: leia os " +
          "arquivos relevantes e diga o que encontrou, citando caminho e linha. Se o achado sustenta ou " +
          "derruba a afirmação, proponha a mudança no bloco certo, com a origem.",
      },
      {
        label: "Qual premissa derruba tudo?",
        prompt:
          "Nomeie a premissa mais arriscada deste documento — a que, sendo falsa, cancela o resto — e diga o " +
          "teste mais barato que a resolveria. Não escreva no documento ainda.",
      },
    ],
  },
  {
    view: "design",
    label: "Assistente do guia",
    purposeId: "doc-editor",
    // O tom (a voz) é da marca, logo do DONO: ali o agente só propõe. Cores, tipografia, estética e componentes
    // ele mantém — sempre conferindo o contraste AA das cores que sugerir.
    blurb: "Mantém o guia de estilo com você: cores, tipografia, estética e componentes. O tom de voz é seu — ali ele só propõe.",
    placeholder: "Peça uma revisão de contraste, um componente novo, uma escala de tipos…",
    quickActions: [
      {
        label: "O contraste passa AA?",
        prompt:
          "Confira cada par de cor do guia (texto sobre fundo, texto sobre a cor de destaque) contra o piso AA de " +
          "4,5:1 e diga quais reprovam, com o número de cada um e a correção mínima que faria passar.",
      },
      {
        label: "O código segue o guia?",
        prompt:
          "Compare as cores e as fontes declaradas no guia com as que o código do produto usa de fato (tokens, " +
          "variáveis CSS, tema) e aponte cada divergência com caminho e linha. Só aponte — corrigir é decisão minha.",
      },
      {
        label: "Que componente falta?",
        prompt:
          "Olhe as telas do produto e liste os componentes que se repetem sem regra no guia (botão, cartão, campo, " +
          "aviso). Para cada um, proponha UMA regra curta de uso. Ainda não escreva no guia.",
      },
    ],
    // guia vazio: revisar contraste/código/componentes não faz sentido antes de existir guia — o começo é escrevê-lo
    emptyQuickActions: [
      {
        label: "Escrever a partir do código",
        prompt:
          "O guia de estilo ainda está vazio. Leia o código do produto (tokens, variáveis CSS, tema, as telas principais) " +
          "e escreva o guia a partir do que ele já usa: cores (conferindo o contraste AA), tipografia, estética e " +
          "componentes, uma seção por vez, citando de onde tirou cada valor. O tom de voz é meu: só me proponha o texto.",
      },
      {
        label: "Escrever a partir de uma referência",
        prompt:
          "O guia de estilo ainda está vazio. Vou te dar uma referência (um site, uma marca, uma imagem). Antes de " +
          "escrever, me pergunte qual é a referência e o que nela eu quero manter; depois escreva cores, tipografia, " +
          "estética e componentes, uma seção por vez. O tom de voz é meu: só me proponha o texto.",
      },
    ],
  },
];

const BY_VIEW = new Map(CHAT_SURFACES.map((s) => [s.view, s] as const));

/** A superfície de chat de uma tela — `undefined` quando aquela tela não tem chat (fail-closed no caller). */
export function chatSurfaceFor(view: string): ChatSurface | undefined {
  return BY_VIEW.get(view);
}
