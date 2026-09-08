// AGENT-REGISTRY declarativo (visão modular B2): a ÚNICA fonte da verdade sobre os atributos de cada
// agente/skill de autorun. Antes esses atributos viviam FRAGMENTADOS em ≥3 Sets/Records no runner
// (CODE_SKILLS em engine.ts, HEAVY_SKILLS em scheduler.ts, FULL_AUTONOMY em engine.ts), mantidos em
// lockstep manual por comentário — uma divergência silenciosa fazia a skill rodar na lane errada ou
// sem a flag certa. Agora há UM Record exaustivo (o compilador força 1 entrada por TriggerId novo) do
// qual TUDO deriva: lane/watchdog (isCode) e permissão (fullAutonomy). Módulo NEUTRO (só importa o
// tipo) para não criar ciclo (engine já importa scheduler). model/effort/maxTurns continuam por-coluna
// no board.yaml (declarativos lá). Próximo passo natural: command (hoje convenção `/<trigger>`) e o
// step→agente (agente atuando em >1 coluna) entram aqui também.

import type { AutonomyTier, TriggerId } from "@/lib/storymap/types";

export interface AgentDef {
  /** diagnostica/escreve código (roda por minutos) → SEM fast-watchdog (engine) E lane HEAVY (scheduler) */
  isCode: boolean;
  /** roda Bash/escreve código → `--dangerously-skip-permissions` (senão `acceptEdits`) */
  fullAutonomy: boolean;
  /**
   * Um run BEM-SUCEDIDO desta skill SEMPRE tira o card da coluna-trigger (pipeline linear de dados).
   * Quando true, o engine trata uma saída LIMPA (exit 0) que NÃO avançou o card como um "sucesso-
   * fantasma" (no-op): a skill alegou sucesso sem fazer nada → o card encalha (sem falha visível +
   * o dedupe do autorun bloqueia o re-disparo). É o espelho do guard falha-fantasma. Só true para as
   * skills de dados que avançam INCONDICIONALMENTE no sucesso (enrich/prioritize/plan/tasks);
   * false para HITL (grill), código com avanço condicional (do/review/qa — encalham legítimo em
   * blocker/red) e skills cujo avanço depende do board/estado (ux/ui/interview/refine/fix/retire/sync).
   */
  advancesOnSuccess: boolean;
  /**
   * Um run BEM-SUCEDIDO desta skill DEVE deixar artefato de CÓDIGO no branch (qualquer path fora de
   * storymap/boards/). Quando true, o engine trata uma saída LIMPA cujo worktree só mudou board data
   * (tipicamente só o flip do card) como "sucesso-fantasma de build" (C2/O3.5, ny4v26): reclassifica
   * como no-op ANTES do teardown — o branch flip-only vira failed/* (não mergeia) e o card fica na
   * coluna onde o trabalho deveria ter acontecido. Só harness-do: review/qa/refine/fix produzem zero
   * código legitimamente.
   */
  requiresCodeArtifacts?: boolean;
  /**
   * story-harness-cc HALF #3: invariantes NÃO-NEGOCIÁVEIS desta skill, injetadas no SYSTEM PROMPT do
   * run (via `--append-system-prompt-file`, não no `-p` do usuário) — assim sobrevivem à compactação de
   * um run longo (a 1ª mensagem de usuário, onde o contexto morava, é sumarizada). Override POR skill;
   * quando ausente, {@link systemPromptFor} aplica {@link CODE_SKILL_INVARIANTS} às code skills (o caso
   * comum) e nada às demais (o contextNote por-app já cobre convenções). Vazio ⇒ sem system prompt próprio.
   */
  systemPrompt?: string;
  /**
   * WS7 (F6) — a skill que PODE processar VÁRIOS cards irmãos num ÚNICO run/worktree/spawn (group-run):
   * cards simples e relacionados no MESMO step viram 1 entrada no merge train em vez de N. Só `harness-do` na
   * v1 (o step de dev); o batch-eligibility helper exige batchable:true + mesmo board/status + isCode +
   * toolkit idêntico + sem depends-on interno ao grupo. Ausente/false ⇒ a skill nunca agrupa (1 card/run).
   */
  batchable?: boolean;
}

/**
 * As invariantes que toda CODE skill (isCode) carrega no system prompt por padrão (story-harness-cc #3).
 * São o contrato de comportamento que "desbota" numa sessão longa quando vive só no prompt do usuário —
 * mantê-las no system prompt (re-emitido todo turno) estabiliza o run. Curto de propósito.
 */
export const CODE_SKILL_INVARIANTS =
  "Você é um run de autorun do AgileHarness executando código de forma autônoma. Invariantes inegociáveis: " +
  "(1) NUNCA enfraqueça, pule ou apague uma asserção de teste para fazê-lo passar — conserte a APLICAÇÃO " +
  "(fix-the-app, nunca fix-the-test); (2) fique ESTRITAMENTE no escopo deste card — não refatore código " +
  "não relacionado; (3) rode os testes afetados e garanta-os verdes ANTES de avançar o card; (4) trate os " +
  "critérios de aceite do card como a definição de pronto.";

/**
 * As invariantes da lane LIGHT (`isCode:false`) — as skills cujo produto é board-data (card/sidecar), não
 * código. Antes elas recebiam system prompt NENHUM, e o vácuo custou um run inteiro.
 *
 * O INCIDENTE (2026-07-18, acme/story-tlz0dt). A doutrina D4/WS-3 diz que um agente só muta board-data do
 * checkout de RUNTIME via MCP, "nunca por fs direto" — escrita direta é last-writer-wins contra o serviço.
 * A regra é verdadeira para uma sessão HUMANA/interativa e FALSA para um run do engine, que é isento: o
 * engine injeta `STORYMAP_AUTORUN_RUN_ID` em todo spawn e o hook `block-runtime-board-writes` devolve
 * `null` quando o vê. Só que a isenção era invisível de onde o run lê: a cláusula na raiz não NOMEIA a
 * variável (não dá para se auto-verificar), a versão detalhada mora num CLAUDE.md path-scoped que um run de
 * outro board não abre, e a SKILL.md não menciona nada disso. Um `harness-grill` então inverteu o próprio
 * envelope: abandonou o `Edit` que TINHA (auto-aprovado por acceptEdits, isento do hook) para perseguir um
 * MCP que NÃO tinha, e gastou os turnos restantes pedindo a um humano inexistente uma permissão que ninguém
 * podia conceder. O card não se moveu.
 *
 * A LIÇÃO é de desenho, não de redação: quem CONCEDE a isenção (o engine, que seta a env) é quem deve
 * ANUNCIÁ-LA. Doutrina que o agente precisa procurar em três arquivos é doutrina que ele vai aplicar pela
 * metade; no system prompt ela é re-emitida todo turno e sobrevive à compactação. Agnóstica: fala do
 * harness (board-data, run sancionado), nunca de um app/produto do consumidor.
 */
export const BOARD_DATA_SKILL_INVARIANTS =
  "Você é um run de autorun SANCIONADO do AgileHarness: o engine te deu identidade própria (a env " +
  "STORYMAP_AUTORUN_RUN_ID) e, com ela, o direito de escrever os dados de board deste checkout. " +
  "Invariantes inegociáveis: (1) escreva o card/sidecar DIRETAMENTE com Edit/Write — a regra 'só via MCP' " +
  "vale para sessão humana, NÃO para você, e o hook que a aplica te ISENTA por essa env; (2) você NÃO tem " +
  "servidor MCP algum e não precisa de nenhum — não procure, não peça para montar; (3) rodando headless, " +
  "NÃO existe humano para aprovar nada: nunca termine um turno pedindo permissão ou confirmação. Se algo " +
  "que você quer usar for negado, faça o trabalho pelo caminho que JÁ está autorizado (Read/Grep/Glob/" +
  "Edit/Write); (4) o produto do seu run é a mudança gravada no arquivo — um run que só analisa e não " +
  "escreve é um run perdido.";

/**
 * O registry exaustivo. Adicionar um TriggerId em types.ts FALHA o build aqui até declarar seus
 * atributos — substituindo os Sets que antes esqueciam silenciosamente uma skill nova.
 */
export const AGENTS: Record<TriggerId, AgentDef> = {
  "harness-capture": { isCode: false, fullAutonomy: true, advancesOnSuccess: false }, // HITL: gera a proposta no sidecar proposals/<id>.json e PARA em capturando (lane oculta) — o humano aceita no Inbox (NÃO avança)
  "harness-enrich": { isCode: false, fullAutonomy: true, advancesOnSuccess: true }, // fast, renomeia o card .md via Bash; sempre → priorizar
  "harness-grill": { isCode: false, fullAutonomy: false, advancesOnSuccess: false }, // só escreve perguntas, human-in-the-loop (NÃO avança)
  "harness-interview": { isCode: false, fullAutonomy: true, advancesOnSuccess: false }, // avança via advance-card, mas HITL/multi-turno → não força
  "harness-tasks": { isCode: false, fullAutonomy: false, advancesOnSuccess: true }, // só boards de produto (2-step pré-Fase-5); na pipeline canônica o harness-plan decompõe → quebrar-tasks removido
  "harness-prioritize": { isCode: false, fullAutonomy: false, advancesOnSuccess: true }, // sempre → pronta
  "harness-plan": { isCode: false, fullAutonomy: false, advancesOnSuccess: true }, // plano (+ tasks na canônica); board-aware → desenvolver | quebrar-tasks
  "harness-ux": { isCode: false, fullAutonomy: true, advancesOnSuccess: false }, // avança só em coluna autorun; escreve wireframes mesmo sem avançar
  "harness-ui": { isCode: false, fullAutonomy: true, advancesOnSuccess: false }, // idem ux
  "harness-do": { isCode: true, fullAutonomy: true, advancesOnSuccess: false, requiresCodeArtifacts: true, batchable: true }, // pode encalhar legítimo (produz commits/findings próprios); mas um sucesso SEM código é fantasma (C2). WS7: único batchable na v1 (group-run de dev)
  "harness-review": { isCode: true, fullAutonomy: true, advancesOnSuccess: false }, // encalha legítimo em blocker aberto
  "harness-qa": { isCode: true, fullAutonomy: true, advancesOnSuccess: false }, // encalha legítimo em teste vermelho
  "harness-refine": { isCode: true, fullAutonomy: true, advancesOnSuccess: false }, // roteia condicionalmente
  "harness-fix": { isCode: true, fullAutonomy: true, advancesOnSuccess: false }, // roteia condicionalmente
  "harness-retire": { isCode: true, fullAutonomy: true, advancesOnSuccess: false },
  "harness-sync-card": { isCode: true, fullAutonomy: true, advancesOnSuccess: false }, // pode manter o status legítimo (realidade já bate)
  // WS-10/D14 — o JUIZ semântico. COLUMN-LESS: nenhum step do pipeline o dispara (excluído de
  // COLUMN_TRIGGER_IDS; guarda em skill-board-consistency.test) — nasce só da disposição de conflito do
  // train/release, como o redrive nasce do RedriveHandler. isCode: lê/edita código num worktree fresco →
  // lane HEAVY + sem fast-watchdog. advancesOnSuccess:false — ele NÃO tem card para avançar; seu sucesso é
  // o artefato resolvido que RE-ENTRA pelo mecanismo normal (invariante 1). requiresCodeArtifacts fica
  // FORA de propósito: "julgou tudo substantivo e não escreveu nada" é o desfecho CERTO (fail-closed), não
  // um sucesso-fantasma — a guarda C2 puniria exatamente a decisão segura que queremos. Sempre no perfil
  // `mechanical` (D10) — o spawn nomeia sonnet/medium explicitamente (resolution-judge-spawn.ts).
  "harness-resolve": { isCode: true, fullAutonomy: true, advancesOnSuccess: false },
};

const triggers = Object.entries(AGENTS) as [TriggerId, AgentDef][];

/** Triggers que escrevem/diagnosticam código → sem fast-watchdog (engine) + lane HEAVY (scheduler). */
export const CODE_SKILLS: ReadonlySet<TriggerId> = new Set(triggers.filter(([, a]) => a.isCode).map(([t]) => t));

/** Triggers que rodam com `--dangerously-skip-permissions` (rodam Bash/escrevem código). */
export const FULL_AUTONOMY_SKILLS: ReadonlySet<TriggerId> = new Set(
  triggers.filter(([, a]) => a.fullAutonomy).map(([t]) => t),
);

/**
 * Triggers cujo run bem-sucedido SEMPRE avança o card → uma saída limpa que NÃO avançou é um
 * sucesso-fantasma (no-op). O engine usa isto para reclassificar esse run como falha em vez de "ok".
 */
export const ADVANCE_ON_SUCCESS_SKILLS: ReadonlySet<TriggerId> = new Set(
  triggers.filter(([, a]) => a.advancesOnSuccess).map(([t]) => t),
);

/**
 * Triggers cujo sucesso EXIGE artefato de código no branch (C2/O3.5) — uma saída limpa que só mudou
 * storymap/boards/ é um sucesso-fantasma de build e o engine a reclassifica como no-op.
 */
export const REQUIRES_CODE_ARTIFACTS_SKILLS: ReadonlySet<TriggerId> = new Set(
  triggers.filter(([, a]) => a.requiresCodeArtifacts).map(([t]) => t),
);

/**
 * story-harness-cc HALF #3: the per-skill SYSTEM-PROMPT invariants for a trigger, or null. A skill's
 * explicit {@link AgentDef.systemPrompt} wins; otherwise every CODE skill defaults to
 * {@link CODE_SKILL_INVARIANTS} and non-code skills get null (their app conventions ride in the per-app
 * contextNote already). The engine writes this (joined with the contextNote) to the run's
 * `--append-system-prompt-file`. Pure — exported for tests + the engine.
 */
export function systemPromptFor(trigger: TriggerId): string | null {
  const explicit = AGENTS[trigger]?.systemPrompt;
  if (explicit && explicit.trim()) return explicit.trim();
  // Toda skill registrada carrega invariantes agora. A lane light recebia `null` — e era justamente ela
  // (a que escreve board-data no checkout de runtime) que precisava saber da própria isenção. Um trigger
  // desconhecido segue sem system prompt (fail-open).
  if (!AGENTS[trigger]) return null;
  return CODE_SKILLS.has(trigger) ? CODE_SKILL_INVARIANTS : BOARD_DATA_SKILL_INVARIANTS;
}

// ── TIERS NOMEADOS (story-l9mac9) ────────────────────────────────────────────────────────────────────
// O tier NÃO é atributo novo do AgentDef, e isso é decisão, não economia: `fullAutonomy` já É a declaração
// de privilégio, e um segundo campo ao lado dele viraria par em lockstep manual — exatamente o modo de
// falha que este registry existe para matar (era o que os 3 Sets duplicados faziam). O tier DERIVA dele,
// então não existe estado em que os dois discordem.

/**
 * O tier NOMEADO com que a skill `trigger` spawna. `full` (`Unrestricted`) é PRESERVADO: toda skill que hoje
 * roda com skip-permissions continua nele — nomear não é apertar. Ausente/desconhecido cai no piso (`ro`):
 * um trigger que este registry não conhece não herda privilégio por omissão. Pura — exportada p/ teste.
 */
export function tierOf(trigger: TriggerId): AutonomyTier {
  const a = AGENTS[trigger];
  if (!a) return "ro";
  return a.fullAutonomy ? "full" : "write";
}

// A ordem ORDINAL do tier COMO POSTURA DE SPAWN (privilégio sobre as tools NATIVAS do filho) —
// deliberadamente DIFERENTE da ordem de MCP_LEVELS, e a diferença é o fato interessante: no eixo MCP `orch`
// é MAIS autoridade que `write` (ele move o pipeline inteiro); no eixo NATIVO é MENOS (o tick não tem shell
// nem editor — age por tool MCP). Um teto precisa de UMA ordem, e esta é a do eixo que o teto governa.
const SPAWN_TIER_ORDER: Record<AutonomyTier, number> = { ro: 0, orch: 1, write: 2, full: 3 };

/**
 * Aplica um TETO de tier. `cap` ausente/nulo ⇒ devolve `tier` intocado — é o que faz o default de TODO board
 * existente ser o comportamento de hoje. Um teto NUNCA promove: declarar `full` num board não dá shell a uma
 * skill que hoje roda em `acceptEdits` (senão o "piso de segurança" do adotante viraria um elevador de
 * privilégio para quem digitar errado). Pura — exportada p/ teste.
 */
export function capTier(tier: AutonomyTier, cap: AutonomyTier | null | undefined): AutonomyTier {
  if (!cap) return tier;
  return SPAWN_TIER_ORDER[tier] <= SPAWN_TIER_ORDER[cap] ? tier : cap;
}

/**
 * Como uma superfície DECLARA (ou não) a postura de permissão do filho — e a distinção é a parte que
 * importa: **declarar nada não é declarar o piso**. Um spawn sem `--permission-mode` herda o modo do
 * `~/.claude/settings.json` do OPERADOR, que nesta máquina traz `defaultMode: "bypassPermissions"` — o CLI o
 * equipara a skip-permissions. Foi assim que o tick do copiloto nasceu morto por horas (o guard de root
 * derrubando um bypass que ninguém tinha pedido, orchestrator-spawn.ts) e é a MESMA classe do incidente de
 * MCP ambiente ("declarar nada tem de SIGNIFICAR nada", flags.test.ts).
 */
export type TierDeclaration =
  /** emite a postura EXPLICITAMENTE em toda invocação (skip-permissions ou --permission-mode) */
  | "explicit"
  /** só escala para o topo quando o CHAMADOR pede; sem o pedido não emite postura nenhuma (herda o host) */
  | "opt-in"
  /** nunca emite postura — quem decide é o settings do host (hoje, na caixa do dono: bypass ⇒ topo de fato) */
  | "inherited";

/** Uma superfície que spawna o CLI, com o tier que ela herda hoje — o rótulo, não uma restrição nova. */
export interface SpawnSurfaceDef {
  /** path do módulo relativo a `src/`, para a lente de deriva ler a fonte */
  module: string;
  /**
   * F0: módulo ADICIONAL que participa da postura desta superfície. Nasceu quando a tradução
   * postura→flags do autorun saiu do engine para `autonomy-sandbox.ts` — a lente de deriva reprovou na
   * hora (corretamente: a flag mudou de arquivo). Declarar os dois mantém a lente exaustiva em vez de
   * afrouxá-la, que era a alternativa preguiçosa.
   */
  postureModule?: string;
  /** o tier que a superfície carrega; `per-trigger` = decidido por {@link tierOf} (o autorun) */
  tier: AutonomyTier | "per-trigger";
  declaration: TierDeclaration;
  /** por que este tier — em uma linha, para o rótulo não virar número sem sentido */
  note: string;
}

/**
 * O MAPA das superfícies de spawn × tier (story-kqfkoi + l9mac9). É ETIQUETA: nada aqui muda o que uma
 * superfície pode fazer, e o teste que o acompanha (`autonomy-tier.test.ts`) prova que o rótulo casa com as
 * flags REAIS de cada módulo — um dia em que alguém mudar a postura de um spawn sem mexer aqui, a lente
 * reprova. Sem isso, "qual tier o chat do Jido herda?" só se responde lendo 10 arquivos, que é como um
 * downgrade/upgrade silencioso passa.
 */
export const SPAWN_SURFACES: Record<string, SpawnSurfaceDef> = {
  autorunRun: {
    module: "lib/storymap/runner/engine.ts",
    postureModule: "lib/storymap/runner/autonomy-sandbox.ts",
    tier: "per-trigger",
    declaration: "explicit",
    note: "o run de autorun: `full` para as skills que rodam Bash/escrevem código, `write` para as que só editam o card",
  },
  copilotChat: {
    module: "lib/storymap/copilot/protocol.ts",
    tier: "full",
    declaration: "explicit",
    // story-kqfkoi — a declaração desconfortável, e é ela que tem valor: o chat NEGA Write/Edit/NotebookEdit
    // (CHAT_DENIED_TOOLS) mas MANTÉM Bash por decisão do Operador (poder de diagnóstico). Com shell na mão o
    // tier é `full` — a garantia do estado Chat é sobre o BOARD (token MCP `ro`), não sobre o repositório,
    // porque `sed`/`git commit` seguem alcançáveis. Rotular isto `write` seria a etiqueta mentindo.
    note: "chat do Jido: skip-permissions com Write/Edit negadas, mas Bash presente ⇒ o tier é o topo (o deny-list não é fronteira de tier)",
  },
  copilotTick: {
    module: "lib/storymap/runner/orchestrator-spawn.ts",
    tier: "orch",
    declaration: "explicit",
    note: "o tick age por tool MCP: sem shell/editor nativo (Bash/Write/Edit negadas, allowedTools só mcp__storymap)",
  },
  deployAgent: {
    module: "lib/storymap/runner/deploy-agent-spawn.ts",
    tier: "full",
    declaration: "explicit",
    note: "quem deploya precisa de shell; o mandato do produto é que deploy autônomo CONTINUE existindo",
  },
  peerReviewer: {
    module: "lib/storymap/runner/peer-review-spawn.ts",
    // F0 (ADR-067): MIGRADA. Era alcançável EM BANDA — um agente autônomo já contido chama
    // `request_peer_review` e o harness spawnava um agente SEM contenção sobre conteúdo escrito pelo
    // proponente. O tempdir e o env sem token MCP escolhiam onde ele estava e o que ele sabia; nenhum
    // dos dois continha o shell.
    postureModule: "lib/storymap/runner/autonomy-sandbox.ts",
    tier: "full",
    declaration: "explicit",
    note: "escreve o veredito no próprio diretório temporário; a contenção são três camadas — tempdir + env sem token MCP + a postura (sandbox do SO), não o tier",
  },
  conflictJudge: {
    module: "lib/storymap/runner/resolution-judge-spawn.ts",
    // F0 (ADR-067): MIGRADA. Também alcançável EM BANDA: um run CONTIDO produz o diff, o diff diverge,
    // o merge train chama o juiz — sem humano no meio. Era uma porta nomeada para sair da contenção do
    // autorun, sobre o mesmo código que o run acabou de escrever.
    postureModule: "lib/storymap/runner/autonomy-sandbox.ts",
    tier: "full",
    declaration: "explicit",
    note: "resolve conflito editando arquivo no worktree próprio; a contenção é o worktree MAIS a postura (sandbox do SO), não o tier",
  },
  mcpRunTask: {
    module: "lib/storymap/mcp/dev-tools.ts",
    // F0 (ADR-067): MIGRADA. Era a única das sete superfícies alcançável de fora — tool do endpoint
    // MCP, que fica na internet pública por desenho — e por isso a primeira a sair do bypass de
    // permissão. Hoje resolve a postura pelo MESMO caminho do autorun: sandbox do SO quando disponível,
    // recusa em modo `required` sem sandbox, rebaixamento com perda real de Bash em `preferred`.
    postureModule: "lib/storymap/runner/autonomy-sandbox.ts",
    tier: "full",
    declaration: "explicit",
    // (a `note` evita o literal da flag de propósito: ela é DADO, não comentário, e o lint de
    // exaustividade varre o código — citá-la aqui faria este arquivo parecer uma superfície de spawn.)
    note: "`run_task` (classe de risco run-free): topo por default, agora CONTIDO pela postura em vez de comprado com bypass de permissão; a classe segue humano-only na matriz",
  },
  runTerminalResume: {
    module: "app/actions.ts",
    tier: "full",
    declaration: "explicit",
    note: "retomar um run num tmux attachável: mesma postura do run original, atrás da sessão do operador",
  },
  smartCapture: {
    module: "lib/storymap/smart-capture/claude.ts",
    tier: "full",
    declaration: "opt-in",
    note: "extração one-shot sem tools; só escala ao topo quando o chamador pede (`dangerouslySkipPermissions`)",
  },
  sessionSpawn: {
    module: "lib/storymap/runner/session-spawn.ts",
    tier: "full",
    declaration: "inherited",
    note: "sessão tmux interativa: NÃO declara postura — herda o settings do host, que na caixa do dono é bypass (topo de fato)",
  },
};
