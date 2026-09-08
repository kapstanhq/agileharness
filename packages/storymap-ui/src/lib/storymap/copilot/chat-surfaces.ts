// 💬 Superfícies de chat — QUAL conversa existe em QUAL tela, e COMO ela se encaixa.
//
// A régua (decisão do Operador, 2026-07-29): o chat é **por TELA**, não por artefato. A tela de Ideias tem UMA
// conversa que enxerga todas as ideias — não uma conversa por ideia. Uma conversa por artefato multiplicaria
// sessões, históricos e processos por algo que o operador nunca pediu para separar; e quem explora uma ideia
// quase sempre está comparando com as outras. É por isso que a tela de DETALHE de uma ideia usa esta MESMA
// entrada: o que muda lá é o CONTEXTO (a ideia em foco entra no bloco de dados), não a conversa.
//
// Cada tela com chat = UMA entrada aqui. É o contrato modular do pacote (adicione 1 entrada declarativa, não N
// pedaços de lógica): a entrada diz o RÓTULO, o PROPÓSITO, como ela ANCORA na tela e com que MÉTODOS ela
// trabalha; e o propósito (hitl/purpose-registry) já carrega persona + modelo/effort + nível de MCP + tools
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

/** Como a conversa se ancora na tela. `rail` = parte do layout, sempre aberta; `drawer` = gaveta sob o topnav. */
export type ChatDockMode = "rail" | "drawer";

export interface ChatSurface {
  /** o id da VIEW (o mesmo vocabulário das rotas/nav: "ideias", "inbox", …). Vira parte da chave da raia. */
  view: string;
  /** rótulo humano da conversa — nome da região para leitores de tela e nome do processo em /processes. */
  label: string;
  /** qual propósito do HITL dá persona + tier + poder a esta conversa. */
  purposeId: string;
  /** uma linha dizendo ao operador o que esta conversa faz por ele (vazio = usa o summary do propósito). */
  blurb?: string;
  /**
   * Como ela ANCORA. `rail` (default) = a conversa é parte do layout da tela: nasce aberta no desktop e o
   * conteúdo divide o espaço com ela. `drawer` = ela abre por cima do conteúdo, ancorada ABAIXO do topnav.
   *
   * A escolha é da TELA, não do componente: numa bancada de exploração a conversa é meio de trabalho e some da
   * vista se for gaveta; numa tela de execução ela é consulta ocasional e roubar largura permanente seria pior.
   * Abaixo do breakpoint do rail as duas viram a mesma coisa (uma folha), porque num celular não há duas colunas.
   */
  dock?: ChatDockMode;
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
  /** Os MÉTODOS de trabalho oferecidos nesta tela (ver {@link ChatTechnique}). Vazio ⇒ sem seletor. */
  techniques?: ChatTechnique[];
}

/**
 * As TÉCNICAS da bancada de Ideias — o repertório de quem explora algo ainda não decidido.
 *
 * Elas cobrem o ciclo inteiro de uma ideia: abrir o leque (brainstorm), ir atrás de evidência (pesquisa), tentar
 * derrubá-la (validação), descer ao mecanismo (aprofundamento) e fechar o escopo (virar tarefa). Cada uma diz ao
 * agente COMO trabalhar; nenhuma lhe dá poder novo — o que ele pode fazer continua sendo do propósito
 * (`idea-explorer`: lê o board e o código, escreve SÓ dentro do documento da ideia).
 */
const IDEA_TECHNIQUES: ChatTechnique[] = [
  {
    id: "brainstorm",
    label: "Brainstorm",
    hint: "Abre o leque: várias saídas, sem julgar ainda",
    prompt:
      "Trabalhe em modo BRAINSTORM: divirja antes de convergir. Ofereça várias saídas possíveis (inclusive as " +
      "desconfortáveis e as baratas demais), cada uma em uma linha, sem hierarquizar e sem escolher por mim. " +
      "Não descarte nada por parecer óbvio ou difícil nesta fase — julgar agora mata a opção que só faria " +
      "sentido combinada com outra. Ao fim, aponte quais duas valeria combinar, e por quê.",
  },
  {
    id: "pesquisa",
    label: "Pesquisa",
    hint: "Vai atrás da evidência: código, board, fora",
    prompt:
      "Trabalhe em modo PESQUISA: antes de opinar, vá buscar. Leia o código relevante, o board, e busque fora " +
      "quando o assunto não estiver aqui dentro. Toda afirmação sua nesta resposta precisa carregar a ORIGEM " +
      "(caminho e linha, id de card, ou a fonte externa) — uma frase sem origem vira fato falso amanhã. Diga " +
      "explicitamente o que você NÃO conseguiu apurar, em vez de preencher a lacuna com plausibilidade.",
  },
  {
    id: "validacao",
    label: "Validação",
    hint: "Tenta derrubar: a premissa que, se falsa, cancela tudo",
    prompt:
      "Trabalhe em modo VALIDAÇÃO, como cético: seu trabalho é tentar DERRUBAR a ideia, não melhorá-la. Nomeie " +
      "a premissa mais arriscada (a que, sendo falsa, cancela o resto), o caso concreto que a quebra, e o custo " +
      "escondido que ninguém contou. Depois diga qual é o teste MAIS BARATO que resolveria a dúvida — e se esse " +
      "teste já pode ser feito com o que existe hoje, faça-o.",
  },
  {
    id: "aprofundar",
    label: "Aprofundar",
    hint: "Desce um nível: mecanismo, bordas, o que quebra",
    prompt:
      "Trabalhe em modo APROFUNDAMENTO: pare de descrever e desça ao MECANISMO. Como isso funcionaria de fato, " +
      "peça por peça? Onde exatamente encosta no que já existe? Quais são os estados de borda (vazio, erro, " +
      "concorrência, migração do que já está gravado)? Prefira uma resposta densa sobre um recorte a uma " +
      "resposta rasa sobre tudo — se precisar escolher o recorte, escolha e diga que escolheu.",
  },
  {
    id: "virar-tarefa",
    label: "Virar tarefa",
    hint: "Fecha o escopo: o que virariam as stories — eu decido",
    prompt:
      "Trabalhe em modo FECHAMENTO DE ESCOPO: assuma que a ideia foi aceita e diga em que ela se transforma. " +
      "Proponha as stories de entrega (título + o que fica de fora de cada uma), a ordem entre elas e o que " +
      "precisa estar decidido antes da primeira. Aponte o que AINDA não está claro o bastante para virar tarefa. " +
      "NÃO crie card nenhum: a criação é um gesto meu, pelo botão 'Gerar tarefas' do documento — a sua parte é " +
      "me entregar o recorte pronto para eu conferir e apertar.",
  },
];

/**
 * As TÉCNICAS de quem trabalha um DOCUMENTO de estratégia — o repertório de quem escreve, corta e
 * confere um Lean Canvas. Diferentes das da bancada de Ideias por desenho: lá se explora o que ainda
 * não foi decidido; aqui se aperta um texto que já existe e precisa ficar verdadeiro e curto.
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
      "Cruze as seções entre si — a solução responde ao problema declarado? a proposta de valor fala com o " +
      "segmento nomeado? os canais alcançam esse segmento? a receita cabe em quem ele é? Aponte cada " +
      "descasamento citando as DUAS seções e o que exatamente não fecha. Não conserte sozinho: mostre.",
  },
  {
    id: "evidencia",
    label: "Evidência",
    hint: "Vai atrás do que sustenta cada afirmação",
    prompt:
      "Trabalhe em modo EVIDÊNCIA: antes de opinar, vá buscar. Leia o código, o board e as ideias; busque " +
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
 * As TÉCNICAS de quem trabalha o VOCABULÁRIO — personas e sistemas.
 *
 * O repertório é outro porque o artefato é outro: aqui não se explora (Ideias) nem se aperta um argumento
 * (Canvas) — aqui se escreve o PROMPT que todo run vai adotar depois. Por isso as técnicas atacam as três
 * formas de esse prompt sair errado: ele é genérico (Encarnar), ele é ficção não conferida com o código
 * (Sincronizar), ou ele é a mesma linha escrita duas vezes com nomes diferentes (Distinguir).
 */
const VOCAB_TECHNIQUES: ChatTechnique[] = [
  {
    id: "encarnar",
    label: "Encarnar",
    hint: "Fala COMO a persona: o que ela diria, e o que nunca diria",
    prompt:
      "Trabalhe em modo ENCARNAR: pare de descrever a persona por fora e fale de dentro dela. Responda como " +
      "ela responderia — o vocabulário que ela usa, o que a irrita, o que ela nunca diria — e use isso para " +
      "mostrar onde o prompt atual está genérico demais para sustentar a voz. Ao fim, proponha as frases " +
      "concretas que faltam no documento (contexto, job, dor, o que é sucesso), não adjetivos.",
  },
  {
    id: "distinguir",
    label: "Distinguir",
    hint: "Caça a sobreposição: duas linhas que são a mesma coisa",
    prompt:
      "Trabalhe em modo DISTINGUIR: percorra o vocabulário inteiro procurando sobreposição. Duas personas " +
      "que decidem a mesma coisa pelo mesmo motivo são UMA persona com dois nomes; dois sistemas que " +
      "reivindicam a mesma capacidade fazem o agente escolher no escuro. Para cada achado, cite as DUAS " +
      "linhas e diga exatamente o que se sobrepõe e o que de fato as separa (se é que separa). Só aponte — " +
      "juntar, separar ou excluir é decisão minha.",
  },
  {
    id: "sincronizar",
    label: "Sincronizar",
    hint: "Deriva o prompt do CÓDIGO real, não da memória",
    prompt:
      "Trabalhe em modo SINCRONIZAR: o prompt de um sistema tem de descrever o que o código FAZ hoje, não o " +
      "que planejamos. Leia o pacote do board (rotas, handlers, schema, invariantes), e reescreva as " +
      "capacidades e os limites a partir do que você LEU, citando caminho e linha. Aponte o que está no " +
      "documento e não existe mais no código, e o que existe no código e ninguém escreveu aqui. Se não " +
      "conseguiu apurar algo, diga — não preencha a lacuna com plausibilidade.",
  },
  {
    id: "entrevistar",
    label: "Entrevistar",
    hint: "Pergunta o que falta para a persona virar decisão",
    prompt:
      "Trabalhe em modo ENTREVISTAR: você me entrevista, não o contrário. Faça as perguntas que faltam para " +
      "esta persona parar de ser um rótulo — quando ela decide, com quem, com que informação na mão, o que a " +
      "faz desistir, o que ela faz hoje sem o produto. UMA pergunta por vez, começando pela que mais muda o " +
      "resto. Depois de cada resposta minha, escreva no documento o que ficou apurado, com as minhas palavras.",
  },
];

/**
 * As TÉCNICAS de quem escreve um PRD — o repertório de quem estrutura o documento MAIS ALTO do board.
 *
 * Diferentes das do Lean Canvas por desenho, e a diferença é de escala e de leitor. No canvas se
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
    hint: "Confere se escopo, objetivos e problema fecham",
    prompt:
      "Trabalhe em modo COERÊNCIA: o PRD é um argumento longo, e num documento longo a contradição se esconde " +
      "entre seções distantes. Cruze-as: o escopo desta versão entrega o resultado-alvo declarado? a solução " +
      "responde aos problemas listados, e só a eles? o público nomeado é o mesmo do posicionamento? os " +
      "critérios de «Pronto quando» são verificáveis a partir do que está em «Nesta versão»? Aponte cada " +
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
      "ainda não está escrita em «Riscos e perguntas em aberto», é lá que ela pertence.",
  },
  {
    id: "pronto-para-agente",
    label: "Pronto p/ agente",
    hint: "Lê como o agente que vai construir a partir dele",
    prompt:
      "Trabalhe em modo PRONTO-PARA-AGENTE: leia este PRD como se você fosse o agente que vai implementar a " +
      "partir dele, sem poder me perguntar nada. Responda três coisas, nesta ordem: (1) onde você teria de " +
      "ADIVINHAR — a decisão que o documento não tomou e que você tomaria por conta própria (biblioteca, " +
      "formato, nome, integração, ordem); (2) que critério de «Pronto quando» você NÃO conseguiria verificar " +
      "sozinho, e por quê; (3) que jornada está descrita de forma vaga demais para virar backbone. Toda decisão " +
      "que você identificar como já tomada mas não escrita pertence a «Decisões já tomadas» — proponha o texto.",
  },
];

export const CHAT_SURFACES: ChatSurface[] = [
  {
    view: "prd",
    label: "Redator do PRD",
    // O MESMO propósito do canvas, e não um `prd-editor` novo: o poder é idêntico (escreve só dentro
    // do documento, `doc-write` no nível `ro`) e a persona também — apurar, conferir coerência,
    // escrever na seção certa. O que este documento pede de diferente é MÉTODO, e método é o que a
    // técnica declara. Um propósito gêmeo seria um segundo nome para a mesma coisa, com a armadilha
    // de sempre: os dois divergem, e ninguém sabe qual está valendo.
    purposeId: "doc-editor",
    blurb: "Escreve o PRD com você: entrevista, aponta o que falta e confere se o documento fecha.",
    // Rail, como o canvas e a bancada de Ideias: escrever um PRD É a conversa, não uma consulta
    // ocasional. Como gaveta ela sumiria a cada seção aberta.
    dock: "rail",
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
          "Cruze as seções do PRD e aponte os descasamentos: escopo que não entrega o resultado-alvo, solução que " +
          "não responde ao problema, público que muda de uma seção para outra. Cite as duas seções em cada " +
          "achado. Só aponte — corrigir é decisão minha.",
      },
      {
        label: "Começar pelo começo",
        prompt:
          "O PRD ainda está quase vazio. Comece pela seção que mais destrava as outras e me faça UMA pergunta " +
          "por vez para preenchê-la; depois de cada resposta minha, escreva o que ficou apurado no documento e " +
          "siga para a próxima lacuna.",
      },
    ],
  },
  {
    view: "canvas",
    label: "Estrategista",
    purposeId: "doc-editor",
    blurb: "Trabalha o documento com você: apura, confere a coerência entre as seções e escreve no lugar certo.",
    // O canvas é tela de TRABALHO com o agente (como a bancada de Ideias): a conversa é o meio, não uma
    // consulta ocasional. Como gaveta ela sumiria a cada troca de view; ancorada, acompanha o que se lê.
    dock: "rail",
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
          "Cruze as seções do documento e aponte os descasamentos: solução que não responde ao problema, " +
          "proposta de valor que fala com outro segmento, canal que não alcança quem foi nomeado. Cite as " +
          "duas seções em cada achado. Só aponte — corrigir é decisão minha.",
      },
      {
        label: "Investigar no código",
        prompt:
          "Escolha a afirmação do documento que o código pode confirmar ou derrubar e investigue: leia os " +
          "arquivos relevantes e diga o que encontrou, citando caminho e linha. Se o achado sustenta ou " +
          "derruba a afirmação, escreva no documento com a origem.",
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
    view: "ideias",
    label: "Explorador",
    purposeId: "idea-explorer",
    blurb: "Investiga as ideias com você: lê o código e o board, busca fora, e escreve o que apurou.",
    // A bancada de Ideias é uma tela de TRABALHO com o agente: a conversa é o meio, não uma consulta ocasional.
    // Como gaveta ela sumia a cada leitura de uma ideia; ancorada, ela acompanha o que você está lendo.
    dock: "rail",
    placeholder: "Peça uma investigação, uma comparação, um resumo…",
    techniques: IDEA_TECHNIQUES,
    quickActions: [
      {
        label: "O que falta?",
        prompt:
          "Olhe a bancada e escolha a ideia que está mais perto de virar decisão. Diga o que falta nela: a " +
          "pergunta que ninguém fez, o caso que a quebra, o custo escondido. Ainda não escreva no documento.",
      },
      {
        label: "Investigar no código",
        prompt:
          "Escolha a ideia cuja dúvida o código responde e investigue: leia os arquivos relevantes e diga o " +
          "que encontrou, citando caminho e linha. Se o achado sustenta ou derruba a ideia, escreva no " +
          "documento dela com a origem.",
      },
      {
        label: "Tem duplicada?",
        prompt:
          "Compare as ideias da bancada e aponte as que são a mesma coisa dita de dois jeitos, ou as que uma " +
          "engole a outra. Só aponte — juntar ou descartar é decisão minha.",
      },
      {
        label: "Pronta para virar tarefa?",
        prompt:
          "Para cada ideia em 'explorando', diga se ela já tem o que uma tarefa precisa (o que fazer está " +
          "claro? o sucesso é verificável?) ou o que ainda falta apurar. Não crie card nenhum.",
      },
    ],
  },
  {
    view: "vocabulario",
    label: "Arquiteto",
    purposeId: "vocab-architect",
    blurb: "Escreve o vocabulário com você: mantém cada persona distinta e deriva o prompt de um sistema do código.",
    // Tela de TRABALHO com o agente, como Ideias e o Canvas: aqui se REDIGE, e redigir com o agente numa
    // gaveta que fecha a cada linha aberta seria o mesmo defeito que o rail resolveu naquelas duas.
    dock: "rail",
    placeholder: "Peça para encarnar uma persona, apontar sobreposição, sincronizar um sistema…",
    techniques: VOCAB_TECHNIQUES,
    quickActions: [
      {
        label: "Quem está genérico?",
        prompt:
          "Olhe as personas e escolha a que está mais genérica — a que, se um agente a adotasse, escreveria " +
          "igual a qualquer outra. Diga o que exatamente falta nela (contexto de decisão, dor, vocabulário, o " +
          "que é sucesso). Ainda não escreva no documento.",
      },
      {
        label: "Tem sobreposição?",
        prompt:
          "Compare as personas entre si e os sistemas entre si, e aponte as linhas que são a mesma coisa dita " +
          "de dois jeitos — ou aquelas em que uma engole a outra. Cite as duas em cada achado. Só aponte — " +
          "juntar ou excluir é decisão minha.",
      },
      {
        label: "Sincronizar com o código",
        prompt:
          "Escolha o sistema cujo prompt está mais distante do código real e investigue: leia o pacote deste " +
          "board e diga o que encontrou, citando caminho e linha. Depois reescreva as capacidades e os limites " +
          "dele a partir do que você leu.",
      },
      {
        label: "O que ninguém usa?",
        prompt:
          "Liste as personas e os sistemas adotados por ZERO ou por pouquíssimos cards, e para cada um diga " +
          "qual é o caso: falta usá-lo nas stories, ou ele sobra no vocabulário? Não exclua nada.",
      },
    ],
  },
];

const BY_VIEW = new Map(CHAT_SURFACES.map((s) => [s.view, s] as const));

/** A superfície de chat de uma tela — `undefined` quando aquela tela não tem chat (fail-closed no caller). */
export function chatSurfaceFor(view: string): ChatSurface | undefined {
  return BY_VIEW.get(view);
}

/** Como a tela ancora a conversa. Default `rail`: quem declarou um chat numa tela quer a conversa à mão. */
export function chatDockFor(view: string): ChatDockMode {
  return BY_VIEW.get(view)?.dock ?? "rail";
}
