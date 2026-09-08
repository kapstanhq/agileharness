// Build the prompt that turns free text into a card proposal. The agent gets the
// ENTIRE board context inline (vocab, backbone, existing stories) so it never needs
// to read files, and a strict JSON output contract so parse.ts can consume it.

import { STORY_TYPE_DEFS, type StoryType } from "../frameworks";
import { byOrder } from "../order";
import { entryStatusId } from "../views";
import type { BoardConfig, Card, CardType } from "../types";
import type { CaptureTurn, ProposedItem } from "./types";

/**
 * O board existente como ÁRVORE COMPLETA — atividade → passo → user story → **entregas**.
 *
 * O 4º nível (a prateleira `serves`) e as anotações de tipo/status existem porque sem eles o agente
 * era CEGO justamente para a decisão que mais importa. Cada story saía como `· [story] id — "título"`:
 * ele não distinguia user story de entrega, não sabia se a superfície já tinha sido entregue, e não
 * via que uma story já carregava trabalho pendurado. Resultado observado: para "reagrupar a agenda
 * por dia" ele propôs uma user story IRMÃ e marcou "possível duplicata" — a arquitetura errada com o
 * aviso certo, porque a arquitetura certa (uma entrega sob a story existente) era invisível.
 *
 * O `status` vem anotado só quando é terminal ou de quarentena — o que muda a decisão é "isto já foi
 * entregue?" e "isto ainda nem foi triado?", não a posição exata no pipeline.
 */
function renderBoard(config: BoardConfig, cards: Card[]): string {
  const terminal = new Set(config.statuses.filter((s) => s.terminal).map((s) => s.id));
  const staging = new Set(config.statuses.filter((s) => s.staging).map((s) => s.id));
  const isDelivery = (c: Card) => c.type === "story" && !!c.storyType && c.storyType !== "user";
  const isUserStory = (c: Card) => c.type === "story" && (c.storyType ?? "user") === "user";

  const activities = cards.filter((c) => c.type === "activity").sort(byOrder);
  const stepsOf = (actId: string) =>
    cards.filter((c) => c.type === "step" && c.parent === actId).sort(byOrder);
  const userStoriesOf = (stepId: string) =>
    cards.filter((c) => isUserStory(c) && c.parent === stepId).sort(byOrder);
  /** As entregas atribuídas a um node — o eixo `serves`, com fallback em `parent` (servesTarget). */
  const deliveriesOf = (nodeId: string) =>
    cards.filter((c) => isDelivery(c) && (c.serves ?? c.parent) === nodeId).sort(byOrder);

  /** " · concluída" / " · na triagem" — só o que muda a decisão do agente. */
  const stateNote = (c: Card) =>
    c.status && terminal.has(c.status)
      ? " · JÁ ENTREGUE"
      : c.status && staging.has(c.status)
        ? " · ainda na triagem"
        : "";

  const lines: string[] = [];
  if (activities.length === 0) {
    lines.push("(board ainda sem backbone — você pode propor a primeira atividade/step se fizer sentido)");
  }
  const renderDeliveries = (nodeId: string, indent: string) => {
    for (const d of deliveriesOf(nodeId)) {
      lines.push(`${indent}↳ [entrega:${d.storyType}] ${d.id} — "${d.title}"${stateNote(d)}`);
    }
  };
  for (const a of activities) {
    lines.push(`- [atividade] ${a.id} — "${a.title}"`);
    const steps = stepsOf(a.id);
    if (steps.length === 0) lines.push(`    (sem steps)`);
    for (const s of steps) {
      lines.push(`    - [step] ${s.id} — "${s.title}"`);
      for (const st of userStoriesOf(s.id)) {
        lines.push(`        · [user story] ${st.id} — "${st.title}"${stateNote(st)}`);
        renderDeliveries(st.id, "            ");
      }
      // Entregas legadas penduradas no PRÓPRIO step (anteriores à regra de hierarquia). Mostradas
      // para o agente não as reinventar, marcadas para ele não copiar o padrão.
      renderDeliveries(s.id, "        ");
    }
  }
  // Stories with no step parent (kanban backlog) — also useful for dedup.
  const orphanStories = cards.filter((c) => c.type === "story" && !c.parent && !c.serves).sort(byOrder);
  if (orphanStories.length) {
    lines.push(`- [sem lugar ainda] stories soltas:`);
    for (const st of orphanStories) {
      const kind = isDelivery(st) ? `entrega:${st.storyType}` : "user story";
      lines.push(`    · [${kind}] ${st.id} — "${st.title}"${stateNote(st)}`);
    }
  }
  return lines.join("\n");
}

/**
 * WS-9 (9.3) — OPEN ideas on the bench, so a captured story whose PAIN matches an existing ◆ LINKS
 * to it (`addresses`) instead of spawning a blind parallel artifact. The capture NEVER creates a ◆ (that is
 * the bench's job), but a story it proposes MAY point UP at one. Renders only status:"open" ideas;
 * empty → a note so the agent knows there is nothing to link against.
 */
function renderOpenIdeas(cards: Card[]): string {
  const open = cards.filter((c) => c.type === "idea" && (c.idea?.status ?? "open") === "open");
  if (!open.length) return "(nenhuma ideia aberta na bancada)";
  return open.map((o) => `- ${o.id} — "${o.idea?.statement?.trim() || o.title}"`).join("\n");
}

function renderVocab(label: string, items: { id: string; name: string; role?: string; kind?: string }[]): string {
  if (!items.length) return `${label}: (nenhum)`;
  const body = items
    .map((i) => `  - ${i.id}: ${i.name}${i.role ? ` — ${i.role}` : i.kind ? ` — ${i.kind}` : ""}`)
    .join("\n");
  return `${label}:\n${body}`;
}

function renderStoryTypes(): string {
  return STORY_TYPE_DEFS.map(
    (s) =>
      `  - ${s.id}: ${s.name} — ${s.short}\n    título nomeia ${s.titleGuide.form} (✓ "${s.titleGuide.good}" · ✗ "${s.titleGuide.bad}")`,
  ).join("\n");
}

function renderHistory(history: CaptureTurn[]): string {
  if (!history.length) return "";
  const blocks = history.map((t, i) => {
    const parts = [`Turno ${i + 1} — pedido/feedback do usuário:\n${t.text}`];
    if (t.proposal) {
      parts.push(
        `Turno ${i + 1} — proposta que você gerou:\n${JSON.stringify(t.proposal, null, 2)}`,
      );
    }
    return parts.join("\n\n");
  });
  return [
    "## Histórico da conversa (você está REFINANDO uma proposta anterior)",
    "Gere a PROPOSTA ATUALIZADA E COMPLETA que incorpora o feedback mais recente — não um diff, não só as mudanças.",
    "",
    blocks.join("\n\n---\n\n"),
    "",
  ].join("\n");
}

/** A "read these images first" block + the matching tools instruction (smart capture is normally a
 *  no-tools one-shot; when the user attached context images we MUST let the agent Read them). */
function renderImages(imagePaths: string[]): { section: string; toolsLine: string } {
  if (!imagePaths.length) {
    return {
      section: "",
      toolsLine: "Você JÁ tem todo o contexto acima. NÃO use ferramentas, NÃO leia arquivos, NÃO peça confirmação.",
    };
  }
  const list = imagePaths.map((p) => `- ${p}`).join("\n");
  return {
    section: [
      "## Imagens de contexto (LEIA cada uma com a ferramenta Read ANTES de responder)",
      "O usuário anexou imagens como contexto visual (prints de tela, esboços, evidências). Use a ferramenta",
      "Read em CADA caminho abaixo, observe o que mostram e incorpore essa evidência na sua interpretação e",
      "no campo body/rationale dos itens (ex.: 'no print, o feed carrega o estado normal antes do curado').",
      list,
      "",
    ].join("\n"),
    toolsLine:
      "Use a ferramenta Read APENAS para ABRIR as imagens de contexto listadas acima; NÃO leia mais nada, NÃO " +
      "peça confirmação. Depois de vê-las, responda IMEDIATAMENTE.",
  };
}

/**
 * Norte do produto — o digest do PRD, que o chamador resolve (`boardStrategy`). Vazio → seção omitida.
 *
 * Antes esta função lia os três campos do `board.yaml` por conta própria, e numa ORDEM diferente da
 * que `priority-context` usava para os MESMOS três campos. Ninguém decidiu isso; foi digitado duas
 * vezes. Hoje a ordem é uma só porque a fonte é uma só.
 */
function renderNorthStar(strategy: string): string {
  const norte = strategy.trim();
  if (!norte) return "";
  return [
    "## Norte do produto (o resultado que a demanda deve mover)",
    ...norte.split("\n").map((l) => `- ${l}`),
    "",
    "",
  ].join("\n");
}

/** Dica de intenção do orquestrador humano (① chips) — um PRIOR forte sobre a natureza da captura. WS-9:
 *  a captura estruturada só classifica DEFEITO ou TRABALHO — dor crua não é opção aqui (vai para a bancada). */
function renderIntentHint(hint?: "story" | "bug" | null): string {
  if (!hint) return "";
  const map = {
    story: "TRABALHO/melhoria a construir → caminho 2 do PASSO 1 (● story; storyType user, salvo indício de enabler técnico)",
    bug: "um DEFEITO/algo quebrado → caminho 1 (● story, storyType bug)",
  } as const;
  return [
    "## Dica do humano (PRIOR forte — o orquestrador marcou a natureza desta captura)",
    `O humano indicou que isto é ${map[hint]}. Siga esse caminho com confidence alta — só DESVIE se houver`,
    "evidência CLARA no texto de outra natureza (e então explique no rationale e baixe a confidence).",
    "",
  ].join("\n");
}

/** The full prompt for one analyze/refine turn. */
export function buildProposalPrompt(input: {
  config: BoardConfig;
  cards: Card[];
  /**
   * O norte do board (digest do PRD), resolvido pelo chamador — ver `boardStrategy`. OBRIGATÓRIO de
   * propósito: opcional, um chamador que esquecesse produziria uma captura sem norte, calada e com
   * a mesma cara de uma captura correta. Passar `""` é uma decisão; omitir era um acidente.
   */
  strategy: string;
  /** the current free text (first ask) or refine feedback */
  text: string;
  /** completed prior turns (each with its proposal) — empty on the first analyze */
  history?: CaptureTurn[];
  /** absolute paths of context images the user attached — when present, the agent is told to Read them. */
  imagePaths?: string[];
  /** ① dica do humano sobre a natureza (chips): prior forte no PASSO 1. null/omitido = IA decide sozinha.
   *  WS-9: só "story" | "bug" (a captura estruturada não cunha ◆ — dor crua vai para a bancada). */
  intentHint?: "story" | "bug" | null;
}): string {
  const { config, cards, text } = input;
  const history = input.history ?? [];
  const entryStatus = entryStatusId(config) ?? "triage";
  const img = renderImages(input.imagePaths ?? []);

  return `Você é um Product Manager assistente de um board de User Story Mapping (Jeff Patton).
Sua tarefa: ler um TEXTO LIVRE do usuário e PROPOR quais cards criar no board — sem escrever nada.
Outro processo (/harness-enrich) preenche narrativa, critérios de aceite e RICE depois.
EXCEÇÃO: se o texto-fonte JÁ trouxer narrativa (papel/vontade/resultado), aceite ou contexto de decisões,
PROPAGUE esses campos nos itens (narrative/acceptance/body). NÃO invente — só propague o que JÁ está no texto.
Guard de custo: NÃO adicione narrative/acceptance/body se o texto-fonte não os contiver; omitir é sempre correto.

# Board: ${config.name} (id: ${config.id})${config.package ? ` — pacote ${config.package}` : ""}

${renderNorthStar(input.strategy)}## Backbone e stories existentes (reaproveite estes ids como \`parent\`; detecte duplicatas)
${renderBoard(config, cards)}

## Ideias abertas na bancada (o espaço do problema — NÃO crie nenhuma; LIGUE-se a elas)
Se a DOR por trás de uma story que você propor JÁ está enunciada numa destas ◆, aponte \`addresses\` = o id da
ideia (em vez de criar um artefato paralelo cego). Você NUNCA cria/edita ideia aqui.
${renderOpenIdeas(cards)}

## Vocabulário (use SOMENTE estes ids; nunca invente persona/sistema)
${renderVocab("Personas", config.personas)}
${renderVocab("Sistemas", config.systems)}
Releases: ${config.releases.map((r) => `${r.id} (${r.name})`).join(", ") || "(nenhuma)"}

## Tipos de story (campo storyType, só para type=story)
${renderStoryTypes()}

# Modelo do board (Patton + dual-track/OST)
- type "activity" = grande objetivo do usuário (backbone, topo). Raro criar.
- type "step" = tarefa/etapa que compõe uma atividade (parent = uma activity).
- type "story" = unidade de trabalho/feature. **TODA story PRECISA de um lugar no mapa**: \`parent\` = o id de
  um step EXISTENTE, ou o \`tempId\` de um step que VOCÊ propõe neste mesmo lote. \`parent: null\` NÃO é um
  atalho aceitável — é o último recurso, e o commit vai RECUSAR a menos que o humano aceite "sem lugar"
  explicitamente. Se nenhum step existente serve, PROPONHA o backbone (activity/step) junto, no mesmo lote.
  ⚠️ CONSOLIDAÇÃO (WS7 lote — regra dura): se o texto descreve VÁRIOS ajustes/refatorações na MESMA
  superfície/arquivo/componente (ex.: "renomear X, mover Y, extrair Z" no mesmo módulo), proponha UM card
  guarda-chuva com o campo \`tasks: [{title}, …]\` — NÃO N cards separados. N cards similares = N-1 pipelines
  inteiros desperdiçados. Só separe em cards distintos quando são superfícies/objetivos genuinamente diferentes.
- type "idea" (◆ — espaço do problema, OST): você NÃO cria aqui. A captura ESTRUTURADA nunca cunha
  ideia — ela só produz story/step/activity. Ideia nasce na BANCADA de Ideias (um ponto de
  entrada separado e deliberado), quando alguém quer só ENUNCIAR uma dor sem comprometer trabalho. O único elo
  que você pode desenhar com uma ◆ é \`addresses\` numa story (apontar UMA das ideias ABERTAS listadas
  acima, quando a dor daquela story já está enunciada lá).

${renderIntentHint(input.intentHint)}# PASSO 1 (faça ANTES de tudo) — a SUPERFÍCIE já existe no board?
Antes de classificar a natureza, procure na árvore acima a user story que JÁ cobre a tela/fluxo de que o texto
fala. Essa pergunta vem primeiro porque muda a FORMA da resposta, não só o rótulo:

0. **A superfície JÁ TEM user story** (o texto pede MAIS trabalho sobre uma tela/consulta/fluxo que já está
   mapeado) → o trabalho é uma ENTREGA **filha daquela story**, nunca uma story irmã:
   \`{ type:"story", storyType:"technical"|"chore"|"bug", serves:"<id da user story>", parent:null }\`.
   E se o pedido couber inteiro como mais PASSOS DENTRO daquela story (refinos da mesma entrega, sem virar
   um ciclo próprio), prefira **ESTENDER**: \`{ targetCardId:"<id da story>", tasks:[…] }\` — nada é criado,
   as tasks entram no card que já existe. Ex.: a story "Consultar a agenda salva" existe e o texto pede
   "reagrupar por dia, esconder passados, reusar o card da listagem" → isso é trabalho DENTRO dela.
   ⚠️ Este é o caso que mais erra: o sintoma é você querer emitir uma story nova E marcar \`duplicateOf\`.
   Se deu vontade de marcar duplicata, a resposta quase sempre é entrega/estender, não story nova.
1. DEFEITO (algo QUEBRADO — comportamento errado vs. o esperado, erro, crash, regressão, glitch visível: o
   sistema deveria fazer X e faz Y) → 1 ● type:"story", storyType:"bug" (nasce na Triagem). O título nomeia o
   defeito observável. Ex.: "o feed mostra o estado padrão e pisca para o curado", "o backdrop do modal não fecha".
   Se o defeito é numa superfície que já tem user story, ele é uma entrega dela (caso 0): \`serves\`.
2. TRABALHO NOVO (uma capacidade CONCRETA que o board ainda não cobre) → 1–4 ● type:"story" (siga
   Granularidade/Fatia/Título abaixo). Ex.: "adicionar a aba de favoritos no perfil".
Várias coisas independentes no texto → um item por uma, cada uma classificada por este trio.

DOR CRUA (o que NÃO vira card aqui): uma DOR/necessidade do usuário SEM solução conhecida (o PORQUÊ, não o quê) —
"o usuário não consegue rever os eventos que salvou", "as pessoas se perdem no feed". A captura estruturada é para
quem JÁ sabe o que precisa ser feito; dor crua a explorar pertence à BANCADA de Ideias (o ponto de entrada
leve). Então:
- Se o texto tem um ENTREGÁVEL discernível por trás da dor, classifique-o como a story mais próxima
  (user/bug/technical/chore) e registre no \`rationale\` que a certeza é baixa (o humano ajusta na revisão). Se a
  dor coincide com uma ◆ ABERTA da bancada, LIGUE a story a ela por \`addresses\`.
- Se é SÓ dor, sem entregável discernível, NÃO invente um item: em vez do card, emita a nota no \`summary\`
  ("há uma dor crua aqui — registre na bancada de Ideias: «…»"). Um item ◆ que escape será IGNORADO no
  aceite (a captura não cria ideias) — então prefira a nota a um ◆.

FRONTEIRA cinzenta (defeito ↔ percepção): um problema de QUALIDADE PERCEBIDA (lentidão percebida, transição feia,
"parece um bug") pode ser CORRIGIDO como bug OU ser dor crua a explorar. Quando for genuinamente ambíguo, escolha
o tipo MAIS provável de story, mas emita "confidence" ≤ 0.5 e "ambiguous": true — o humano desambigua na revisão
(e pode mandar a dor crua para a bancada). Quando estiver claro, "confidence" ≥ 0.8 e omita "ambiguous".

Regra de ouro do TÍTULO: um título que descreve algo QUEBRADO acontecendo ("o feed pisca") é DEFEITO (story:bug),
NÃO user story; um título de user story descreve uma CAPACIDADE/RESULTADO ("ver favoritos no perfil"). Não se
deixe enganar por verbos de pedido ("precisamos de um jeito de…", "dava pra melhorar"): decida pela NATUREZA
(falta algo vs. está quebrado), não pelo verbo.

> As seções abaixo (Granularidade, Régua da fatia vertical e o contrato de campos de story) valem para QUALQUER
> ● (story), incluindo bug.

# Granularidade — a regra MAIS importante (story ≠ task)
Uma STORY é o MENOR incremento de VALOR observável que vale UM ciclo completo de entrega
(concepção → código → revisão → QA). Ela NÃO é um passo técnico. Cada card vira UM pipeline
inteiro e UM PR; fatiar fino faz N pipelines repetirem o MESMO contexto e, no autorun,
CONFLITAREM ao editar o mesmo arquivo. Na dúvida, MENOS cards.
- NÃO crie card para sub-tarefa técnica de UMA funcionalidade (ex.: "criar a função/action X",
  "adicionar o campo/flag Y", "criar o helper Z", "ligar o botão", "modelar o tipo", "escrever o
  badge"). Isso é TASK — o passo /harness-tasks as gera DEPOIS, DENTRO da story. Pare no nível de story.
- AGRUPE numa MESMA story os itens que: (a) entregam UMA capacidade coesa, (b) tocam a MESMA
  superfície/arquivos, ou (c) são sequenciais/acoplados (um depende do outro). Uma story = 1 PR coeso.
- Só separe em stories DISTINTAS capacidades de fato INDEPENDENTES (superfícies/arquivos distintos,
  cada uma entregável sozinha e com valor próprio).
- IGNORE a forma do texto de entrada: mesmo que o usuário liste passos técnicos ("criar X, depois
  Y, depois Z"), CONSOLIDE-os na story que eles servem — não espelhe a lista 1:1 em cards.
- Sanidade: a grande maioria das capturas dá 1–4 stories. Passou MUITO disso? Você provavelmente
  está fatiando TASKS como cards — reconsolide.
- Exemplos:
  • ❌ "Modelar AgentQuestion" · "Capturar o marcador no output" · "Criar a página de respostas" ·
    "Retomar o run" · "Badge no card"  →  ✅ 1 story "Perguntas do agente para destravar o run".
  • ❌ "Remover RICE do card" · "Adicionar chip de tipo" · "Score no rodapé" · "Busca no mover-para"
    →  ✅ 1 story "Ler o card do Kanban sem ruído" (tudo na mesma superfície; título = intenção, não a tarefa).

# Régua da fatia vertical (sanity check de VALOR — raciocínio, não regra mecânica)
Antes de propor uma story \`user\`, pergunte: "isto é CONSUMÍVEL ponta-a-ponta por um usuário?"
Uma fatia que entrega só UMA camada técnica (só o schema/modelo, só o endpoint/action, só o job, só
uma tela read-only sem dado real) NÃO é uma story de valor — é uma TASK da story que ela serve. Quando
a captura vier fatiada por camada ("modelar X" → "expor X" → "visualizar X"), FUNDA as camadas na única
story de valor ("usar X de ponta a ponta, com o agente/usuário consumindo de verdade") em vez de
espelhá-las como N cards horizontais. Esse foi o erro clássico que motivou esta régua.
NÃO aplique a régua a technical/chore/spike/bug: um enabler de infra (índice, job, migração, worktree)
É uma fatia vertical legítima no eixo Software — não o barre por "não ter tela".

# Regras
- Dor vs. trabalho (dual-track): aplique o PASSO 1 acima. A captura ESTRUTURADA só emite story/step/activity —
  NUNCA ◆ ideia (isso é a bancada). Se o texto é dor crua sem entregável, prefira a NOTA no summary a
  inventar um item. Se a dor coincide com uma ◆ ABERTA da bancada (lista acima), LIGUE a story a ela por
  \`addresses\` (= o id da ideia existente) — preserva o fio de ouro sem duplicar a dor.
- Quebre a demanda em stories por CAPACIDADE/VALOR (ver Granularidade acima); na dúvida, MENOS cards.
- LUGAR NO MAPA (regra dura — a hierarquia tem UMA forma, e cada tipo ancora num lugar diferente):
  • USER STORY (storyType "user") → \`parent\` = o id de um **step**. 1º) encaixe sob um step EXISTENTE (o caso
    normal); 2º) se NENHUM serve, PROPONHA o step (e a activity, se faltar) NESTE MESMO lote e use o \`tempId\`
    dele. Backbone novo é barato.
  • ENTREGA (storyType technical/bug/chore/spike) → \`serves\` = o id da **user story** que ela implementa, e
    \`parent: null\`. **NUNCA pendure entrega num step** — o lote inteiro é recusado. Se a user story que ela
    serve ainda não existe, proponha a user story no mesmo lote e use o \`tempId\` dela em \`serves\`.
  • STEP → \`parent\` = o id de uma **activity**. ACTIVITY → raiz, sem \`parent\`.
  Sem âncora só quando você genuinamente não consegue decidir — e aí DIGA no \`rationale\` por quê (o card cai
  na Triagem esperando a decisão do humano, o que é aceitável mas não é o alvo).
  Atenção: o card do qual esta story parece duplicata pode ele mesmo estar sem lugar — NÃO herde a orfandade
  dele. Decida o lugar pelo CONTEÚDO da story, não pelo vizinho.
- storyType: use "user" por padrão; "technical" p/ infra/enabler, "spike" p/ investigação, "bug" p/ correção, "chore" p/ manutenção.
  ⚠️ O padrão "user" vale para trabalho em superfície NOVA. Se a superfície já tem user story (PASSO 1, caso 0),
  o item é ENTREGA — escolha technical/chore/bug pela natureza, e ancore por \`serves\`.
- serves (dual-track): SÓ para item de ENTREGA (storyType technical/bug/chore/spike) — aponte o id (ou tempId) da USER STORY que esta entrega/ticket implementa, para ela aparecer na prateleira daquela story (uma story tem vários tickets: feature/bug/etc). Omita p/ user stories e backbone.
- targetCardId (ESTENDER em vez de criar): quando o pedido é só MAIS PASSOS dentro de um card que já existe —
  refinos da mesma entrega, que não valem um ciclo próprio —, emita \`{ "tempId":"…", "type":"story",
  "title":"<o que será acrescentado>", "targetCardId":"<id do card existente>", "tasks":[{"title":"…"}, …] }\`.
  Nada é criado: as tasks entram NO card apontado. Use quando a resposta honesta for "isso não é um card novo,
  é mais trabalho naquele". \`parent\`/\`serves\`/narrativa são ignorados neste modo. O alvo tem de ser um id
  EXISTENTE do board (nunca um tempId do lote — estender algo que ainda não existe é criar).
- Título: nomeia a INTENÇÃO/RESULTADO do usuário, NUNCA o mecanismo/solução — siga o guia de título do storyType (seção "Tipos de story" acima). Para storyType "user" não comece com verbo de dev (Criar/Adicionar/Implementar/Refatorar/Redesenhar/Remover/Configurar/Ajustar/Simplificar/Mover). Mesmo que o texto-fonte liste tarefas, retitule para a intenção. ✓ "Ver favoritos no perfil" / ✗ "Adicionar aba de favoritos".
- narrative/acceptance/body: PROPAGUE quando o texto-fonte JÁ trouxer essas informações (narrativa de papel/vontade/resultado, critérios já decididos, contexto/decisões). OMITA quando não estiverem — o /harness-enrich preenche depois. Não invente, não infle.
- personas/systems: liste apenas ids existentes relevantes (pode deixar vazio).
- duplicateOf: use APENAS quando o item é a MESMA demanda já capturada — trabalho que alguém pediria duas vezes.
  Se o board já tem a story da superfície e o texto pede trabalho SOBRE ela, isso NÃO é duplicata: é entrega
  (\`serves\`) ou extensão (\`targetCardId\`) — ver PASSO 1, caso 0. Marcar duplicata e propor a story assim
  mesmo é o pior dos dois mundos: cria o card errado E adia a decisão.
- Voz de marca PT-BR urbano-sofisticada: NUNCA use "rolê/rolês", "zap", "o que rola". Use "evento", "WhatsApp", "o que tem".
- Stories/backbone nascerão no status "${entryStatus}". A captura NÃO cria ideias (type:"idea") — dor crua vai para a bancada de Ideias (ponto de entrada separado).

# Exemplos de classificação (o PASSO 1 em ação)

EXEMPLO A — a entrada é DOR CRUA (sem entregável discernível) → NENHUM item, só a NOTA no summary:
Texto: "O cache de recomendações falha demais e a personalização não acompanha o gosto do usuário — ele vê
eventos repetidos e fora da cara dele. Não sei ainda como resolver."
Saída CORRETA:
{ "summary": "Isto é uma DOR crua de relevância do feed, sem entregável decidido — registre na bancada de Ideias: «Usuário vê eventos repetidos e fora do seu gosto no feed». A captura estruturada não cria ideia.",
  "items": [] }
Saída ERRADA (NÃO faça): um card type:"idea" (a captura não cunha ◆ — seria ignorado no aceite), OU dois
cards type:"story" ("Invalidar cache por usuário", "Ranquear pelos favoritos") espelhando ideias que o texto nem trouxe.

EXEMPLO B — a entrada é TRABALHO já decidido → ● story:
Texto: "Adicionar uma aba de favoritos no perfil para o usuário rever os eventos que salvou."
Saída CORRETA:
{ "summary": "Trabalho de produto concreto: uma capacidade de usuário.",
  "items": [ { "tempId": "i1", "type": "story", "confidence": 0.9, "title": "Rever os eventos favoritados no perfil",
    "storyType": "user", "parent": null, "rationale": "Capacidade de usuário: acessar a lista de favoritos." } ] }

EXEMPLO C — a entrada descreve algo QUEBRADO (estado errado antes de corrigir) → DEFEITO → ● story:bug (fronteira):
Texto: "O feed carrega o estado padrão e só depois pisca para o curado; na listagem aparecem labels 'pra você' que
somem quando a lista normal carrega — parece um bug."
Saída CORRETA (comportamento ERRADO observável → bug, vai para a Triagem; é a fronteira defeito↔dor, então sinalize):
{ "summary": "Defeito de carregamento: o feed mostra o estado errado e pisca para o curado.",
  "items": [ { "tempId": "i1", "type": "story", "storyType": "bug",
    "title": "O feed pisca do estado padrão para o curado durante o carregamento",
    "confidence": 0.5, "ambiguous": true,
    "rationale": "Comportamento errado (estado padrão antes do curado); fronteira defeito↔dor — provável bug.",
    "body": "Evidência: logado, o curado carrega depois do normal; labels 'pra você' aparecem e somem." } ] }
Por que ambiguous: dá para ler como DOR de percepção a explorar (várias soluções de UX). Por isso confidence ≤ 0.5
+ ambiguous:true, em vez de cravar — o humano decide na revisão (e os chips de intenção podem fixar a leitura).

${renderHistory(history)}# Pedido atual do usuário
${text}

${img.section}# Formato da resposta (OBRIGATÓRIO)
${img.toolsLine}
Responda com APENAS um objeto JSON válido (sem texto antes/depois, sem \`\`\` cercas):
{ "summary": "1-2 frases em PT-BR de como você interpretou o pedido", "items": [ ...itens... ] }

Todo item de "items" é uma ● (story) ou backbone (activity/step) — a captura NUNCA emite type:"idea". EM
QUALQUER item inclua "confidence" (0..1 — sua certeza na CLASSIFICAÇÃO do tipo) e, só na fronteira defeito↔percepção,
"ambiguous": true. Contrato de campos:
- type:"story" (o ● — DEFEITO ou TRABALHO) → tempId, type, title (intenção/resultado, nunca o mecanismo),
  storyType ("user" por padrão), rationale, release, personas[], systems[], duplicateOf, e a ÂNCORA conforme o
  tipo: user story ⇒ parent = id/tempId de um STEP, serves = null; entrega (technical/bug/chore/spike) ⇒
  serves = id/tempId da USER STORY que ela implementa, parent = null. Opcionais (inclua SÓ quando o texto-fonte
  já os trouxer; o /harness-enrich preenche depois): narrative {role,want,soThat}, acceptance[], body, tasks[]
  ({id?,title}) — tasks SÓ no card GUARDA-CHUVA de N ajustes na MESMA superfície/arquivo (1 card com N tasks em
  vez de N cards; regra de consolidação acima). E, quando a dor da story já está enunciada numa ◆ ABERTA da
  bancada, addresses = o id daquela ideia existente.
- ESTENDER um card existente (nada é criado) → tempId, type:"story", title (o que será acrescentado),
  targetCardId (id EXISTENTE do board), tasks[] (obrigatório — é o que será acrescentado), rationale.
  Não inclua parent/serves/narrative aqui: eles são ignorados neste modo.
- type:"activity" | "step" → tempId, type, title, parent (activity → null; step → o id/tempId da activity), rationale.
(Se for só dor crua, NÃO emita item — ponha a nota "registre na bancada" no summary. Omita os campos opcionais ausentes.)`;
}

/**
 * The "idea → stories" prompt (synchronous twin of generateTasksForIdeaAction). UNLIKE
 * buildProposalPrompt, this is the WORK path with ZERO dual-track classification: the pain is ALREADY
 * decided (the idea exists), so the agent must NOT re-emit an idea — only the delivery
 * user stories that RESOLVE it. The `addresses` edge to the idea is stamped at commit time
 * (addressesIdeaId), so the agent doesn't need to set it.
 */
export function buildIdeaTasksPrompt(input: {
  config: BoardConfig;
  cards: Card[];
  idea: {
    statement: string;
    candidateSolutions?: string[];
    keyAssumption?: string | null;
    successSignal?: string | null;
  };
}): string {
  const { config, cards, idea } = input;
  const entryStatus = entryStatusId(config) ?? "triage";
  const ctx: string[] = [`Ideia (já explorada, decisão tomada): ${idea.statement}`];
  if (idea.keyAssumption?.trim()) ctx.push(`Premissa-chave a validar: ${idea.keyAssumption.trim()}`);
  if (idea.successSignal?.trim()) ctx.push(`Sinal de sucesso: ${idea.successSignal.trim()}`);
  if (idea.candidateSolutions?.length)
    ctx.push(`Soluções candidatas levantadas: ${idea.candidateSolutions.join("; ")}`);

  return `Você é um Product Manager assistente de um board de User Story Mapping (Jeff Patton).
Sua tarefa: gerar as TAREFAS DE ENTREGA que EXECUTAM uma IDEIA já explorada (um documento que JÁ existe
no board e cuja exploração terminou). Isto é o CAMINHO DO TRABALHO — a decisão já foi tomada, então você
NÃO classifica nada e NÃO cria nenhuma ideia. Emita SOMENTE itens type:"story".

A ideia pode ser de QUALQUER natureza — funcionalidade nova, correção de um defeito, trabalho técnico,
investigação. Deixe a natureza dela escolher o \`storyType\` de cada tarefa (user/technical/bug/chore/spike);
NÃO force tudo a virar user story, e NÃO invente uma user story de fachada só para ter onde pendurar um
trabalho técnico — uma ideia técnica gera \`technical\`/\`chore\` direto (ADR-066 §3).

# Board: ${config.name} (id: ${config.id})${config.package ? ` — pacote ${config.package}` : ""}

## Backbone e stories existentes (reaproveite estes ids como \`parent\`; detecte duplicatas)
${renderBoard(config, cards)}

## Vocabulário (use SOMENTE estes ids; nunca invente persona/sistema)
${renderVocab("Personas", config.personas)}
${renderVocab("Sistemas", config.systems)}
Releases: ${config.releases.map((r) => `${r.id} (${r.name})`).join(", ") || "(nenhuma)"}

## Tipos de story (campo storyType)
${renderStoryTypes()}

# A ideia que estas stories resolvem
${ctx.join("\n")}

# Granularidade — a regra MAIS importante (story ≠ task)
Uma STORY é o MENOR incremento de VALOR observável que vale UM ciclo completo de entrega (concepção → código →
revisão → QA), consumível ponta-a-ponta por um usuário. NÃO é um passo técnico. Cada card vira UM pipeline e UM
PR; fatiar fino faz N pipelines repetirem o mesmo contexto e CONFLITAREM ao editar o mesmo arquivo. Na dúvida,
MENOS stories. NÃO crie card para sub-tarefa técnica (action/campo/helper/botão/tipo) — isso é TASK, gerada
depois por /harness-tasks DENTRO da story. AGRUPE numa story o que entrega uma capacidade coesa, toca a mesma
superfície ou é sequencial/acoplado. As "soluções candidatas" acima são DIREÇÃO, não um mapa 1:1 de stories —
consolide-as nas stories de valor; na grande maioria dos casos dá 1–4 stories.

# Régua da fatia vertical (sanity check de VALOR)
Antes de propor cada story \`user\`, pergunte: "isto é consumível ponta-a-ponta por um usuário?" Uma fatia que
entrega só uma camada técnica (só schema, só endpoint, só job, só tela read-only) NÃO é story — é task. NÃO
aplique a régua a technical/chore/spike/bug (um enabler de infra é fatia vertical legítima no eixo Software).

# Regras
- Emita SOMENTE type:"story" (1–4). NUNCA type:"idea"/"activity"/"step". A dor já existe.
- Título: nomeia a INTENÇÃO/RESULTADO do usuário, NUNCA o mecanismo/solução — siga o guia de título do storyType.
  Para storyType "user" não comece com verbo de dev (Criar/Adicionar/Implementar/Refatorar/Remover/etc).
  ✓ "Ver o feed personalizado sem piscar" / ✗ "Adicionar skeleton no feed".
- storyType: "user" por padrão; "technical" p/ enabler de infra, "spike" p/ investigação, "bug" p/ correção, "chore" p/ manutenção.
- parent: prefira encaixar sob um step/atividade EXISTENTE (use o id). Só proponha um step/atividade NOVO se a dor
  claramente introduz uma área inexistente — e use o \`tempId\` dele como \`parent\`. Pode deixar parent:null (backlog).
- serves: SÓ p/ entrega technical/bug/chore/spike — aponte o id/tempId da user story que ela implementa. Omita p/ user stories.
- narrative/acceptance/body: PROPAGUE só se o contexto da ideia já trouxer; senão OMITA (o /harness-enrich preenche).
- personas/systems: só ids existentes relevantes (pode vazio). duplicateOf: aponte se já existir story igual.
- Voz de marca PT-BR urbano-sofisticada: NUNCA "rolê/zap/o que rola". Stories nascem no status "${entryStatus}".

# Formato da resposta (OBRIGATÓRIO)
Você JÁ tem todo o contexto acima. NÃO use ferramentas, NÃO leia arquivos, NÃO peça confirmação.
Responda com APENAS um objeto JSON válido (sem texto antes/depois, sem \`\`\` cercas):
{ "summary": "1-2 frases em PT-BR de como você quebrou a dor em stories", "items": [ ...só stories... ] }
Cada story: tempId, type:"story", title (intenção/resultado), storyType, parent (id|tempId|null), serves (null
exceto entrega), release, personas[], systems[], rationale, duplicateOf. Opcionais só se já vierem no contexto:
narrative {role,want,soThat}, acceptance[], body. Omita os campos ausentes.`;
}

/**
 * ② Re-cast: reescrever UM item proposto no FORMATO de outro tipo (o humano corrigiu a classificação).
 * NÃO é label-flip — o conteúdo (title/body/rationale/campos) é reescrito na forma do novo tipo, preservando a
 * substância. One-shot (sem conversa). Devolve {items:[<um item>]} para reusar parseProposal.
 */
export function buildRecastPrompt(input: {
  config: BoardConfig;
  cards: Card[];
  item: ProposedItem;
  toType: CardType;
  toStoryType?: StoryType | null;
  sourceText?: string;
}): string {
  const { config, cards, item, toType, toStoryType, sourceText } = input;
  void cards;
  const target =
    toType === "idea"
      ? "uma IDEIA (◆ — uma DOR/necessidade do usuário, NÃO uma solução)"
      : toType === "story"
        ? `uma STORY (●) com storyType:"${toStoryType ?? "user"}"`
        : `um item type:"${toType}"`;
  const shape =
    toType === "idea"
      ? `title = o enunciado da DOR (nunca a solução); body = evidência + contexto; candidateSolutions = ideias-de-solução (se houver). NÃO inclua storyType/parent/narrative/acceptance.`
      : `title = a INTENÇÃO/RESULTADO (storyType "user") ou o DEFEITO observável (storyType "bug"), nunca o mecanismo; storyType="${toStoryType ?? "user"}". Preserve parent/serves/addresses do item atual quando ainda fizerem sentido.`;

  return `Você re-classifica UM item de uma proposta de captura. O humano decidiu que este item NÃO é o tipo que
você tinha proposto — ele AGORA É ${target}. REESCREVA o conteúdo no FORMATO do novo tipo, preservando a
SUBSTÂNCIA (o problema/capacidade real). Não invente — use o item atual e o texto-fonte.

# Item atual (como foi proposto antes)
${JSON.stringify(item, null, 2)}
${sourceText ? `\n# Texto-fonte original do usuário\n${sourceText}\n` : ""}
## Vocabulário (use SOMENTE estes ids)
${renderVocab("Personas", config.personas)}
${renderVocab("Sistemas", config.systems)}

## Tipos de story (campo storyType)
${renderStoryTypes()}

# Como reescrever para ${target}
- ${shape}
- Mantenha o MESMO tempId ("${item.tempId}").
- Voz PT-BR urbano-sofisticada (NUNCA "rolê/zap/o que rola").

# Formato (OBRIGATÓRIO)
Você JÁ tem todo o contexto. NÃO use ferramentas. Responda com APENAS um JSON (sem texto, sem \`\`\` cercas):
{ "items": [ <o item reescrito, type:"${toType}"> ] }`;
}
