// AgileHarness MCP tools — the conversational control surface for the board, exposed to
// the Claude mobile app via a remote custom connector (see app/api/mcp/[secret]/[transport]).
//
// DESIGN: every mutating tool DELEGATES to the existing server actions (app/actions.ts),
// so it inherits the SAME gates (checkGate), the SAME per-card write lock + fresh-disk
// re-read (updateCardOnDisk), the SAME merge that preserves pipeline-owned fields
// (mergeCardOnSave) and the SAME runner engine singleton (in-flight lock + concurrency
// cap + live console + crash-recovery journal). Read tools hit repo.ts directly. This
// module adds only I/O shaping (slim projections, zod input schemas) — no business logic
// is duplicated, so a card moved/run from the phone behaves exactly like the UI does.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defineTool } from "./register";
import { currentMcpActor } from "./actor";
import { docIsCanonical, isPrdSection, prdSectionKeys, readGovernedValue } from "@/lib/storymap/doc/doc-governance";

import { listBoards, readBoardConfig, readCard, readCards } from "@/lib/storymap/repo";
import { registerBoard, setBoardAutorun } from "@/lib/storymap/board-registry";
import { BoardDeployConfigSchema } from "@/lib/storymap/contracts";
import { terminalStatusIds } from "@/lib/storymap/views";
import { liveOpenBlockers } from "@/lib/storymap/runner/findings";
import { servesIsPlacement } from "@/lib/storymap/unplaced";
import { getRunnerRegistry } from "@/lib/storymap/runner/registry";
import { getRunnerEngine } from "@/lib/storymap/runner/engine";
import { getTelemetryStore } from "@/lib/storymap/runner/telemetry";
import { getMergeQueue } from "@/lib/storymap/runner/merge-queue";
import { isLiveMergeStatus } from "@/lib/storymap/runner/merge-status";
import { describeMainRed, readMainRed } from "@/lib/storymap/runner/gate-health";
import { getRunnerJournal } from "@/lib/storymap/runner/journal";
import { getCardClaims, type CardClaim } from "@/lib/storymap/runner/claims";
import { waitForRunCore } from "@/lib/storymap/runner/run-wait";
import { loadRunnerConfig } from "@/lib/storymap/runner/config";
import { resolveHeadroomUrl } from "@/lib/storymap/runner/headroom";
import { detectCycle, topologicalOrder } from "@/lib/storymap/runner/dep-graph";
import type { EnqueueResult } from "@/lib/storymap/runner/types";
import { waitForApprovalDecision } from "@/lib/storymap/approvals";
import {
  answerQuestionAction,
  approveActionRequestAction,
  approveDataDeletionAction,
  approveGovernanceDraftAction,
  approveQaAction,
  approveReviewAction,
  askQuestionsAction,
  rejectActionRequestAction,
  chooseWireframeAction,
  commitProposalAction,
  deleteCardAction,
  deletePersonaAction,
  deleteSystemAction,
  restoreDeletedAction,
  discontinueCardAction,
  getPlanAction,
  getRetirePlanAction,
  getWireframeAction,
  submitDesignFeedbackAction,
  acceptTriageCardAction,
  moveCardAction,
  proposeCardsAction,
  proposeChangeAction,
  refineCardAction,
  rejectGovernanceDraftAction,
  reportBugAction,
  reportIssueAction,
  reviveCardAction,
  runCardSkillAction,
  savePersonaAction,
  saveSystemAction,
  setCardLinksAction,
  setCardRouteAction,
  syncCardAction,
  updateCardAction,
  updateFindingStatusAction,
} from "@/app/actions";
import {
  createIdeaAction,
  generateTasksForIdeaAction,
  appendToIdeaAction,
  updateIdeaAction,
} from "@/app/idea-actions";
import { readDocAction, writeDocSectionAction } from "@/app/doc-actions";
import { appendToVocabAction } from "@/app/vocab-actions";
import { listDocEntries } from "@/lib/storymap/doc/doc-registry";
import { serializeSchemaDoc } from "@/lib/storymap/doc/schema-codec";
import { SIDECAR_KINDS, listGovernanceDrafts, readGovernanceDraft, readStyleGuide, writeSidecarByKind } from "@/lib/storymap/sidecars";
import { wireframeDocTextView } from "@/lib/storymap/design-canvas";
import { PEER_REVIEW_ENABLED } from "@/lib/storymap/copilot/tier";
import { makePeerReviewPort, type PeerReviewRequest } from "@/lib/storymap/runner/peer-review-spawn";
import { governanceConflicts } from "@/lib/storymap/governance";
import { checkAA } from "@/lib/storymap/style-guide";
import { styleGuideDriftAction } from "@/app/design-actions";
import { EFFORT_LEVELS, GOVERNANCE_ARTIFACTS, MODEL_TIERS } from "@/lib/storymap/types";
import { CANVAS_BLOCK_KEYS } from "@/lib/storymap/canvas-blocks";
import type { EffortLevel, ModelTier } from "@/lib/storymap/types";
import { openQuestions } from "@/lib/storymap/questions";
import { PIPELINE_OWNED_FIELDS } from "@/lib/storymap/card-merge";
import {
  BUG_SEVERITY_IDS,
  DISPOSITION_IDS,
  FUNNEL_IDS,
  IMPROVEMENT_KIND_IDS,
  KANO_IDS,
  IDEA_STATUS_IDS,
  REMOVAL_LEVEL_IDS,
  REMOVAL_SCOPE_IDS,
  STORY_TYPE_IDS,
} from "@/lib/storymap/frameworks";
import type {
  BugSeverity,
  Disposition,
  FunnelStage,
  ImprovementKind,
  KanoCategory,
  IdeaStatus,
  RemovalLevel,
  RemovalScope,
  StoryType,
} from "@/lib/storymap/frameworks";
import { FINDING_STATUSES } from "@/lib/storymap/types";
import { resolvedClaudeBin } from "../runner/claude-bin";
import type { Card, FindingStatus, Persona, StatusDef, SystemDef, TriggerId } from "@/lib/storymap/types";
import { triggerForCard } from "@/lib/storymap/skip-routing";
import { REOPEN_DESTINATIONS, type ReopenDestination } from "@/lib/storymap/reopen";
import type { CaptureTurn, ProposedItem } from "@/lib/storymap/smart-capture/types";

// --- result helpers -------------------------------------------------------

const json = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** Enum tuple helper — zod 3 needs a non-empty readonly tuple for z.enum. */
function enumOf<T extends string>(ids: readonly T[]): z.ZodEnum<[T, ...T[]]> {
  return z.enum(ids as unknown as [T, ...T[]]);
}

// --- projections ----------------------------------------------------------

/** Lean card shape for list/move/create results — keeps the connector payload small. */
export function slim(c: Card, isTerminal = false) {
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    status: c.status,
    storyType: c.storyType,
    mode: c.mode ?? null,
    parent: c.parent,
    release: c.release,
    rice: c.rice,
    kano: c.kano,
    funnelStage: c.funnelStage,
    tasks: { done: c.tasks.filter((t) => t.done).length, total: c.tasks.length },
    acceptance: c.acceptance.length,
    openFindings: c.findings.filter((f) => f.status === "open").length,
    // liveOpenBlockers dropa os MECHANISM blockers stale num card terminal (o mesmo backstop de display); sem
    // `isTerminal` é byte-idêntico ao filtro antigo (todo blocker/open), então single-card returns não mudam.
    blockers: liveOpenBlockers(c.findings, isTerminal).length,
  };
}

/**
 * get_card body-cost projection (story-33nwyy). The card's `body` (long accumulated markdown) is the
 * only heavy field; a status/field check in an orchestration session doesn't need it. `verbose:false`
 * (the DEFAULT) DROPS it — keeping every structured control field (status, tasks, acceptance, findings,
 * rice/kano, reviewedAt/qaPassed…) — and leaves a `bodyOmitted` + `bodyChars` marker so the caller knows
 * a body exists and can re-request with `verbose:true`. `verbose:true` returns the card INTACT (the legacy
 * shape). Additive/backward-safe: the param is optional; only the default RESPONSE shape got leaner.
 */
export function projectCardForGet(c: Card, verbose = false) {
  if (verbose) return c;
  const { body, ...rest } = c;
  return { ...rest, bodyOmitted: true as const, bodyChars: body?.length ?? 0 };
}


/**
 * One proposed item, shared by usm_capture's `items` (apply) and `history[].proposal.items`
 * (propose memory). Mirrors smart-capture's ProposedItem — `parent` is an existing card id OR
 * another item's `tempId` (same batch) OR null (unplaced backlog). Defined once so the inline
 * schema stays shallow (the typecheck-OOM mitigation in register.ts is about call-site overload
 * resolution, not schema reuse — a single named shape is cheap to infer).
 */
const proposedItemShape = z.object({
  tempId: z.string().describe("id do item dentro deste lote (ex.: 'i1'), usado em refs de parent"),
  type: z
    .enum(["story", "activity", "step", "idea"])
    .describe("idea = uma DOR/problema (espaço do problema); nasce inerte na bancada de Ideias; a evidência vai no campo body"),
  title: z.string(),
  storyType: enumOf<StoryType>(STORY_TYPE_IDS as StoryType[]).nullable().optional(),
  parent: z.string().nullable().optional().describe("id de card existente OU tempId do mesmo lote OU null"),
  serves: z
    .string()
    .nullable()
    .optional()
    .describe(
      "dual-track: para item de ENTREGA (storyType technical/bug/chore/spike), o node do mapa que ele serve (id de step/activity/user-story OU tempId). Omitir = usa o parent",
    ),
  release: z.string().nullable().optional(),
  personas: z.array(z.string()).optional(),
  systems: z.array(z.string()).optional(),
  rationale: z.string().describe("uma linha: o que este card cobre / por que existe"),
  duplicateOf: z
    .string()
    .nullable()
    .optional()
    .describe(
      "id de card que isto parece duplicar (AVISO). Use só para a MESMA demanda repetida. Se o board já " +
        "tem a story da superfície e isto é trabalho SOBRE ela, não é duplicata: use `serves` (entrega) ou " +
        "`targetCardId` (estender).",
    ),
  targetCardId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "ESTENDER em vez de criar: id de um card EXISTENTE ao qual este item só ACRESCENTA as suas `tasks`. " +
        "Nada é criado; parent/serves/narrativa são ignorados. Alvo inexistente RECUSA o lote (nunca vira " +
        "card novo). Use quando a resposta honesta for 'isto não é um card novo, é mais trabalho naquele'.",
    ),
  narrative: z
    .object({ role: z.string().nullable().optional(), want: z.string().nullable().optional(), soThat: z.string().nullable().optional() })
    .partial()
    .nullable()
    .optional()
    .describe("seed da narrativa (role/want/soThat) — SÓ quando já está no texto-fonte; enrich preenche se ausente. Não infle por padrão."),
  acceptance: z.array(z.string()).optional().describe("seeds de critérios de aceite — SÓ quando já decididos no texto. Texto livre (Gherkin recomendado)."),
  tasks: z
    .array(z.object({ id: z.string().optional(), title: z.string() }))
    .optional()
    .describe("WS7 lote: decomposição PRÉ-SEMEADA de UM card guarda-chuva (vira Card.tasks). Use quando o texto descreve N ajustes/refatorações na MESMA superfície/arquivo → 1 card com N tasks, NÃO N cards. Story-only."),
  body: z.string().optional().describe("contexto/decisões/constraints/valor além do rationale — SÓ quando o texto já trouxe essas decisões"),
  // dual-track OST — SÓ p/ type:story:
  addresses: z.string().nullable().optional().describe("dual-track OST: a idea (DOR) que esta STORY endereça — id de card existente OU tempId de uma idea do MESMO lote. Vira o edge 'addresses' (story→idea). Só p/ type:story."),
  // OST-light — SÓ p/ type:idea:
  candidateSolutions: z.array(z.string()).optional().describe("SÓ type:idea — soluções candidatas (espaço da solução, OST-light)"),
  keyAssumption: z.string().nullable().optional().describe("SÓ type:idea — premissa mais arriscada a validar antes de apostar"),
  successSignal: z.string().nullable().optional().describe("SÓ type:idea — sinal-líder de que a dor está sendo resolvida"),
  valueSize: z.object({ reach: z.number().nullable(), impact: z.number().nullable() }).nullable().optional().describe("SÓ type:idea — dimensionamento de valor da dor (stories herdam)"),
});

// --- enqueue resolution ---------------------------------------------------

/**
 * Resolve the CURRENT-column skill (trigger + StatusDef) + headroom URL a card should be
 * enqueued with — the same resolution `runCardSkillAction` does, factored out so the MCP
 * `enqueue`/`enqueue_batch` tools and `run_skill` share ONE path (no duplicated logic). The
 * runner-enabled gate is checked by the caller (once per tool call, not per card).
 */
async function resolveEnqueueTarget(
  board: string,
  cardId: string,
): Promise<{ ok: true; trigger: TriggerId; def: StatusDef; headroomUrl: string | null } | { ok: false; error: string }> {
  const [config, cards] = await Promise.all([readBoardConfig(board), readCards(board)]);
  const card = cards.find((c) => c.id === cardId);
  if (!card || !card.status) return { ok: false, error: `Card ${board}/${cardId} sem status — mova-o para uma coluna primeiro.` };
  const status = config.statuses.find((s) => s.id === card.status);
  if (!status?.trigger) {
    return { ok: false, error: `A coluna '${card.status}' de ${board}/${cardId} não tem skill (sem trigger) — nada a enfileirar.` };
  }
  // Reabertura R1: a reopened card (reopenPending + mode) enqueues its DEDICATED skill (harness-fix/harness-refine)
  // — resolve the effective trigger so enqueue/run_skill of a reopened card runs the reopen skill, not the
  // column's own (and consumes reopenPending), mirroring the in-process cascade + runCardSkillAction.
  return { ok: true, trigger: triggerForCard(card, status.trigger), def: status, headroomUrl: resolveHeadroomUrl(config, process.env) };
}

// --- registration ---------------------------------------------------------

/**
 * Register every AgileHarness tool on the MCP server. Called once per handler init
 * (the route caches the handler per token, so this runs once per dev-server life).
 */
export function registerStorymapTools(server: McpServer): void {
  // ---- READ -------------------------------------------------------------

  defineTool(server,
    "list_boards",
    {
      title: "Listar boards",
      description: "Lista os boards do AgileHarness — um por app deste repositório. COMECE AQUI.",
      inputSchema: {},
    },
    async () => json(await listBoards()),
  );

  // ---- REGISTRO DE BOARD (o onboarding agent-first) ----------------------
  //
  // O ESCOPO desta tool é `repo`, não `board`, e a declaração está em scope.ts. O motivo é o critério
  // que o próprio scope.ts usa — o ALVO da ação: registrar um board CRIA UM NAMESPACE no diretório de
  // dados; não existe board dono, "nem hipoteticamente". Se ela fosse tratada como board-scoped (o que
  // aconteceria automaticamente se o parâmetro se chamasse `board`), sob token escopado o guard leria a
  // matriz de risco de um board que AINDA NÃO EXISTE, cairia em `ask` e abriria uma aprovação dentro do
  // diretório do board inexistente — que `listBoards` pula por não ter yaml, então a aprovação não
  // apareceria em Inbox nenhum. Seria a 4ª ocorrência da "capacidade anunciada e inalcançável" que
  // scope.ts existe para matar. Por isso o parâmetro é `id`, e não `board`: a heurística de `board` no
  // topo do args tem precedência sobre a declaração de repo, e usá-la aqui reabriria o buraco.
  defineTool(server,
    "register_board",
    {
      title: "Registrar um board novo",
      description:
        "Registra um APP NOVO no AgileHarness: cria storymap/boards/<id>/ com um board.yaml que declara " +
        "só os deltas e HERDA a pipeline canônica (status, gates, colunas) do template _base. É o " +
        "caminho de onboarding — use-o antes de create_card quando o app ainda não tem board (confira " +
        "com list_boards). O board nasce DESARMADO (autorunDisabled): entrar numa coluna não dispara " +
        "agente nenhum até que um humano o arme, de propósito. Recusa um id que já existe e um id que " +
        "não seja slug (não higieniza em silêncio). Não aceita, por desenho, a política do orquestrador " +
        "nem a pipeline: a primeira se auto-concederia permissões, a segunda cortaria a herança.",
      inputSchema: {
        id: z
          .string()
          .describe(
            "id do board — slug minúsculo começando por letra (a-z, 0-9, hífen; até 40). Vira o nome do " +
              "diretório em storymap/boards/ e o valor que toda outra tool usa como `board`.",
          ),
        name: z.string().describe("nome legível do board, mostrado na interface (ex.: \"Loja Aurora\")."),
        package: z
          .string()
          .optional()
          .describe(
            "caminho RELATIVO do pacote que este board mapeia (ex.: \"packages/loja\"). Opcional: um board " +
              "de discovery mapeia uma jornada que ainda não tem código. Na dúvida, omita — não adivinhe.",
          ),
        // O CONTRATO REAL viaja no tools/list: este é o mesmo schema que valida um board.yaml no disco,
        // superRefine incluído. Um `kind:"command"` sem `command` é recusado AQUI, e a régua não pode
        // driftar da do repositório porque é literalmente a mesma.
        deploy: BoardDeployConfigSchema.optional().describe(
          "descritor de deploy do app (opcional). `kind:\"command\"` exige `command`; `kind:\"agent\"` exige " +
            "`description`. Omita se ainda não sabe como este app publica.",
        ),
      },
    },
    async ({ id, name, package: pkg, deploy }) => {
      const r = await registerBoard({ id, name, package: pkg, deploy });
      if (!r.ok) return fail(r.error);
      // A resposta é lida pelo LEITOR REAL, não montada pelo escritor: se a herança não tivesse pegado,
      // `statuses` viria vazio e o relatório diria isso — em vez de ecoar o que acabamos de gravar.
      const cfg = await readBoardConfig(r.id).catch(() => null);
      return json({
        ok: true,
        board: r.id,
        path: r.path,
        armed: false,
        statusesHerdados: cfg?.statuses.length ?? 0,
        primeiroStatus: cfg?.statuses[0]?.id ?? null,
        // ⚠️ ESTE TEXTO É INSTRUÇÃO, e uma instrução desatualizada custa mais que a falta dela: a
        // primeira versão mandava o agente EDITAR O YAML À MÃO para armar — conselho que já era falso
        // quando foi escrito, porque `set_board_autorun` existe. Foi o dogfood ponta a ponta que a
        // pegou, não a suíte. Se um dia a alavanca mudar de nome, esta lista muda junto.
        proximosPassos: [
          "leia o resource agileharness://pipeline/base — a pipeline que este board acabou de herdar.",
          "create_card({board, …}) — o card nasce na coluna de entrada.",
          "o board está DESARMADO: nenhuma coluna dispara agente. Para armar: set_board_autorun({board, enabled:true, confirm:<o id do board>}).",
        ],
      });
    },
  );

  // O INTERRUPTOR. Note que aqui o parâmetro se chama `board`, e no `register_board` se chama `id` — a
  // diferença não é descuido, é o escopo: lá o board AINDA NÃO EXISTE (ação de repo, declarada em
  // scope.ts); aqui ele existe, e quem deve governar a chamada é a matriz de risco DELE. Nomear o
  // parâmetro `board` é o que faz `resolveToolScope` entregar a chamada ao dono certo.
  defineTool(server,
    "set_board_autorun",
    {
      title: "Armar / desarmar o autorun de um board",
      description:
        "Liga (arma) ou desliga (desarma) o autorun de um board INTEIRO — a trava `autorunDisabled`. " +
        "Armado, entrar numa coluna com trigger dispara um agente headless que processa o card sozinho; " +
        "desarmado, nada dispara e os cards só andam por run_skill ou pela mão. Um board registrado por " +
        "register_board nasce DESARMADO: esta é a tool que o arma, e é o segundo gesto, deliberado. " +
        "É também o KILL-SWITCH por board: use enabled:false para parar de uma vez o autorun de um board " +
        "que esteja disparando runs indevidos. Idempotente — pedir o estado atual não grava nada.",
      inputSchema: {
        board: z.string().describe("id do board (os válidos vêm de list_boards)"),
        enabled: z
          .boolean()
          .describe(
            "true = ARMAR (as colunas com trigger passam a disparar agentes sozinhas) · false = DESARMAR " +
              "(kill-switch: nada dispara).",
          ),
        confirm: z
          .string()
          .optional()
          .describe(
            "obrigatório APENAS para armar (enabled:true): repita o id do board. Armar autoriza gasto de " +
              "tokens e execução de agentes na máquina de quem hospeda — a confirmação existe para que " +
              "isso nunca seja efeito colateral de uma chamada feita no automático. Desarmar não pede nada.",
          ),
      },
    },
    async ({ board, enabled, confirm }) => {
      // A confirmação guarda só a direção PERIGOSA. Exigi-la para desarmar seria um atrito no caminho do
      // kill-switch — a hora em que atrito é exatamente o que não se pode ter.
      if (enabled && confirm !== board)
        return fail(
          `Para ARMAR o board "${board}" repita o id em \`confirm\`. Armar faz as colunas com trigger ` +
            `dispararem agentes headless sozinhas, o que gasta tokens e roda processos na máquina que ` +
            `hospeda o harness. Desarmar (enabled:false) não exige confirmação.`,
        );
      const r = await setBoardAutorun(board, enabled);
      if (!r.ok) return fail(r.error);
      // Lido do LEITOR, não ecoado do escritor: se a gravação não tivesse pegado, isto denunciaria.
      const cfg = await readBoardConfig(board).catch(() => null);
      return json({
        ok: true,
        board: r.board,
        armed: cfg ? cfg.autorunDisabled !== true : r.armed,
        changed: r.changed,
        colunasQueDisparam: (cfg?.statuses ?? []).filter((s) => s.autorun === true && s.trigger).map((s) => s.id),
      });
    },
  );

  defineTool(server,
    "list_statuses",
    {
      title: "Listar colunas",
      description:
        "Lista as colunas (status) de um board com seu gate, skill (trigger), autorun e se é terminal. " +
        "Use para descobrir os ids de status válidos antes de mover um card.",
      inputSchema: { board: z.string().describe("id do board (os válidos vêm de list_boards)") },
    },
    async ({ board }) => {
      const cfg = await readBoardConfig(board).catch(() => null);
      if (!cfg) return fail(`board não encontrado: ${board}`);
      return json(
        cfg.statuses.map((s) => ({
          id: s.id,
          name: s.name,
          gate: s.gate ?? null,
          trigger: s.trigger ?? null,
          autorun: s.autorun ?? false,
          terminal: s.terminal ?? false,
        })),
      );
    },
  );

  defineTool(server,
    "list_cards",
    {
      title: "Listar cards",
      description:
        "Lista os cards de um board (projeção enxuta). Filtra por status (id da coluna) e/ou texto " +
        "(casa título ou id). Use para responder 'o que tem em desenvolver', 'cards deste board', etc.",
      inputSchema: {
        board: z.string(),
        status: z.string().optional().describe("id da coluna para filtrar, ex.: desenvolver"),
        query: z.string().optional().describe("texto livre que casa título ou id"),
        limit: z.number().int().positive().max(200).optional().describe("padrão 100"),
      },
    },
    async ({ board, status, query, limit }) => {
      let cards = await readCards(board);
      if (!cards.length) {
        const exists = (await listBoards()).some((b) => b.id === board);
        if (!exists) return fail(`board não encontrado: ${board}`);
      }
      if (status) cards = cards.filter((c) => c.status === status);
      if (query) {
        const q = query.toLowerCase();
        cards = cards.filter(
          (c) => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
        );
      }
      const sliced = cards.slice(0, limit ?? 100);
      // audit #11: flag cards a run is actively processing — under worktree isolation their on-disk
      // (main) snapshot is PRE-run (edits land only at the merge-back), so an agent shouldn't act on it.
      const eng = getRunnerEngine();
      // Terminal-aware blocker count: on a terminal card a residual mechanism blocker is stale (liveOpenBlockers).
      // Fail-open if config is unavailable (empty set → raw count, the pre-fix behaviour).
      const config = await readBoardConfig(board).catch(() => null);
      const terminalIds = config ? terminalStatusIds(config) : new Set<string>();
      return json({
        board,
        count: sliced.length,
        total: cards.length,
        cards: sliced.map((c) => {
          const t = terminalIds.has(c.status ?? "");
          return eng.isInFlight(board, c.id) ? { ...slim(c, t), inFlight: true } : slim(c, t);
        }),
      });
    },
  );

  defineTool(server,
    "get_card",
    {
      title: "Detalhar card",
      description:
        "Retorna os campos de controle de um card: narrativa, critérios de aceite, tasks, RICE/KANO/funil, " +
        "findings de code-review, modo de reabertura (refine/fix/retire). Por PADRÃO omite o corpo markdown " +
        "(pesado) — devolve só o marcador bodyOmitted+bodyChars — para checagens repetidas de status numa " +
        "sessão de orquestração não pagarem o custo de token do body toda vez. Passe verbose:true quando " +
        "precisar do corpo completo.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "false/omitido (DEFAULT) = omite o corpo markdown pesado, retornando só os campos estruturados + " +
              "bodyOmitted/bodyChars (barato). true = card completo, incluindo o body (o shape legado).",
          ),
      },
    },
    async ({ board, cardId, verbose }) => {
      const card = await readCard(board, cardId);
      if (!card) return fail(`card não encontrado: ${board}/${cardId}`);
      // story-33nwyy: por padrão (verbose:false) omite o body pesado; verbose:true devolve o card intacto.
      const projected = projectCardForGet(card, verbose ?? false);
      // audit #11: when a run is in flight for this card, the on-disk (main) snapshot above is the state
      // from BEFORE the run — under worktree isolation the skill's edits accumulate in its worktree and
      // reach main only at the merge-back. Surface it so the agent doesn't act on stale data nor clobber
      // the run's pending edits with update_card/move_card.
      if (!getRunnerEngine().isInFlight(board, cardId)) return json(projected);
      const run = getRunnerRegistry().snapshot().running.find((r) => r.board === board && r.cardId === cardId);
      return json({
        ...projected,
        _run: {
          inFlight: true,
          ...(run ? { trigger: run.trigger, ageSec: Math.round((Date.now() - run.startedAt) / 1000), sessionId: run.sessionId } : {}),
          note: "⚠ um run está processando este card num worktree isolado; o estado acima é o de ANTES do run (as edições só chegam em main no settle/merge-back). Acompanhe com runner_status / card_console e evite update_card/move_card até o run terminar.",
        },
      });
    },
  );

  // ---- MOVE / EDIT / CREATE --------------------------------------------

  defineTool(server,
    "move_card",
    {
      title: "Mover card",
      description:
        "Move um card para outra coluna (status) e/ou muda parent/release/ordem. RESPEITA os gates do " +
        "pipeline — se o gate da coluna de destino bloquear, retorna o motivo e não move. Mover para uma " +
        "coluna com autorun dispara a skill automaticamente (cascata), igual à UI.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        status: z.string().optional().describe("id da coluna de destino"),
        parent: z.string().nullable().optional(),
        serves: z
          .string()
          .nullable()
          .optional()
          .describe("dual-track: node do mapa que esta ENTREGA serve (override do parent); '' limpa"),
        release: z.string().nullable().optional(),
        order: z.number().optional(),
      },
    },
    async ({ board, cardId, status, parent, serves, release, order }) => {
      const r = await moveCardAction({ boardId: board, cardId, status, parent, serves, release, order });
      return r.ok ? json({ ok: true, cardId, status: status ?? "(inalterado)" }) : fail(r.error);
    },
  );

  defineTool(server,
    "update_card",
    {
      title: "Editar campos do card",
      description:
        "Edita os campos AUTORAIS de um card (os que o humano escreve: título, narrativa, aceite, " +
        "personas, sistemas, RICE/KANO/funil, corpo). NÃO toca em campos do pipeline " +
        "(findings, wireframe, qa, modo) — esses são das skills. Tentar setar um campo de pipeline " +
        "aqui retorna ERRO explícito (use approve_qa para qa* / deixe o autorun para os demais), em " +
        "vez de ignorar em silêncio. NÃO muda status: setar status aqui retorna erro — use move_card " +
        "(que valida o gate E dispara os efeitos de entrada de coluna: promote-stage/deploy-board + autorun). " +
        "NÃO edita `tasks`: quem as marca é a skill que fez o trabalho (o harness-do marca todas ao terminar). " +
        "Não há carimbo manual: o gate de evidência (hasBuildEvidence) é satisfeito pela conclusão real das " +
        "tasks OU pela convergência de conteúdo (buildEvidence: already-landed), nunca por um flip à mão.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        // Pipeline-owned fields: accepted in the schema ONLY so the handler can REJECT them with an
        // explicit error (a plain z.object would strip unknown keys silently). They are NEVER written.
        ...Object.fromEntries(
          PIPELINE_OWNED_FIELDS.map((f) => [
            f,
            z.unknown().optional().describe("campo do pipeline — somente leitura aqui; setar retorna erro"),
          ]),
        ),
        title: z.string().optional(),
        storyType: enumOf<StoryType>(STORY_TYPE_IDS as StoryType[]).optional(),
        narrative: z
          .object({
            role: z.string().nullable(),
            want: z.string().nullable(),
            soThat: z.string().nullable(),
          })
          .partial()
          .optional()
          .describe("papel/quero/para — a narrativa Connextra da story"),
        acceptance: z.array(z.string()).optional().describe("critérios de aceite (Gherkin recomendado)"),
        personas: z.array(z.string()).optional().describe("ids de personas do board"),
        systems: z.array(z.string()).optional().describe("ids de sistemas do board"),
        rice: z
          .object({
            reach: z.number().nullable(),
            impact: z.number().nullable(),
            confidence: z.number().nullable(),
            effort: z.number().nullable(),
          })
          .partial()
          .optional(),
        kano: enumOf<KanoCategory>(KANO_IDS as KanoCategory[]).nullable().optional(),
        funnelStage: enumOf<FunnelStage>(FUNNEL_IDS as FunnelStage[]).nullable().optional(),
        body: z.string().optional().describe("corpo markdown do card"),
        status: z
          .string()
          .optional()
          .describe(
            "NÃO use aqui — mudança de status é do move_card (que valida o gate E dispara os efeitos onEnter " +
              "promote-stage/deploy-board). Setar aqui retorna erro.",
          ),
      },
    },
    async (input) => {
      // PIPELINE-OWNED FIELDS: update_card never writes them. Instead of stripping them silently
      // (the old behaviour, which led to hand-editing the YAML), REJECT explicitly so the caller
      // knows to use approve_qa (qa*) or to let the autorun cascade own the rest.
      const rejected = PIPELINE_OWNED_FIELDS.filter(
        (f) => (input as Record<string, unknown>)[f] !== undefined,
      );
      if (rejected.length) {
        const hasQa = rejected.some((f) => f.startsWith("qa"));
        return fail(
          `update_card não escreve campos do pipeline (geridos pelas skills): ${rejected.join(", ")}. ` +
            (hasQa ? "Use approve_qa para aprovar/setar qaPassed/qaRanAt/qaCommit. " : "") +
            "Os demais campos do pipeline são escritos pelo autorun (run da skill da coluna), não por edição manual.",
        );
      }
      // story-byel8k: status is NOT authorial — update_card must not write it. The updateCardAction path
      // below validates the gate + fires the autorun cascade, but does NOT fire the onEnter ENTRY_EFFECTS
      // (promote-stage/deploy-board) that move_card fires — so a status write here would drift the card
      // from reality (card marked "No ar"/"concluída" without the code ever being promoted/deployed; the
      // real incident this fixes). Reject explicitly and point to move_card. `status` stays in the schema
      // (not stripped) so the error is LOUD instead of a silent no-op.
      if (input.status !== undefined) {
        return fail(
          "update_card não muda status — use move_card. move_card valida o gate da coluna E dispara os " +
            "efeitos de entrada (onEnter: promote-stage/deploy-board) e o autorun; gravar status aqui " +
            "pularia esses efeitos e divergiria o card da realidade do código. update_card edita só os " +
            "campos autorais (título, narrativa, aceite, personas, sistemas, RICE/KANO/funil, corpo).",
        );
      }
      const current = await readCard(input.board, input.cardId);
      if (!current) return fail(`card não encontrado: ${input.board}/${input.cardId}`);
      // Apply ONLY the whitelisted human-authored fields onto the fresh snapshot.
      // updateCardAction re-reads inside the lock + mergeCardOnSave re-grafts every
      // pipeline-owned field from disk, so nothing here can clobber skill state.
      const next: Card = { ...current };
      if (input.title !== undefined) next.title = input.title;
      if (input.storyType !== undefined) next.storyType = input.storyType;
      if (input.narrative !== undefined) {
        next.narrative = {
          role: input.narrative.role ?? current.narrative.role,
          want: input.narrative.want ?? current.narrative.want,
          soThat: input.narrative.soThat ?? current.narrative.soThat,
        };
      }
      if (input.acceptance !== undefined) next.acceptance = input.acceptance;
      if (input.personas !== undefined) next.personas = input.personas;
      if (input.systems !== undefined) next.systems = input.systems;
      if (input.rice !== undefined) {
        next.rice = {
          reach: input.rice.reach ?? current.rice.reach,
          impact: input.rice.impact ?? current.rice.impact,
          confidence: input.rice.confidence ?? current.rice.confidence,
          effort: input.rice.effort ?? current.rice.effort,
        };
      }
      if (input.kano !== undefined) next.kano = input.kano;
      if (input.funnelStage !== undefined) next.funnelStage = input.funnelStage;
      if (input.body !== undefined) next.body = input.body;
      // status intentionally NOT applied — update_card rejects status above (use move_card). next.status
      // stays === current.status, so updateCardAction sees no status change (no gate/autorun/effects).
      const r = await updateCardAction({ boardId: input.board, card: next });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  // (autonomo-liberdade-humana M4, 2026-07-18) mark_tasks_done APOSENTADO — a tool que flipava `tasks[].done` na
  // mão para cruzar o gate C2 (hasBuildEvidence) foi removida para humano E agente. A evidência aceita agora é a
  // conclusão real das tasks pelo harness-do OU a convergência de conteúdo (buildEvidence: already-landed). Ver o
  // gate hasBuildEvidence (gate-core.js) e o HANDOFF autonomo-liberdade-humana. Resíduo honesto: um card
  // half-landed depende do auto-heal da metade de dados (WS-3); um card sem delta re-roda pelo pipeline.

  defineTool(server,
    "approve_qa",
    {
      title: "Aprovar QA",
      description:
        "Aprova o QA de um card — seta qaPassed/qaRanAt/qaCommit pela MESMA trava de re-leitura fresca do " +
        "disco que as outras ações (sem clobber dos demais campos de pipeline). É O caminho first-class " +
        "para passar o gate hasQaPassed (não edite o YAML à mão). SÓ funciona com o card numa coluna de " +
        "revisão humana (QA / Testes ou Aprovar entrega) — rejeita em colunas de autorun/início para não " +
        "deixar o spec inconsistente. NÃO avança o card: o humano move para Integrar depois. Use qaPassed:false " +
        "para revogar uma aprovação.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        qaPassed: z.boolean().optional().describe("padrão true; false revoga a aprovação"),
        qaRanAt: z.string().nullable().optional().describe("data YYYY-MM-DD da validação (padrão hoje)"),
        qaCommit: z.string().nullable().optional().describe("commit/HEAD que o QA validou"),
        visual: z
          .boolean()
          .optional()
          .describe(
            "você OLHOU a tela renderizada? Grava qaEvidence.visual — a prova que o gate cobra de um card " +
              "cujo diff tocou superfície de UI (um qaPassed vindo só da suíte não prova tela). Omitido ⇒ " +
              "não mexe na evidência existente.",
          ),
        comment: z.string().optional().describe("nota opcional (não persiste no card)"),
      },
    },
    async ({ board, cardId, qaPassed, qaRanAt, qaCommit, visual, comment }) => {
      const r = await approveQaAction({ boardId: board, cardId, qaPassed, qaRanAt, qaCommit, visual, comment });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  defineTool(server,
    "approve_review",
    {
      title: "Aprovar revisão de código",
      description:
        "Aprova a revisão de código de um card SEM re-rodar o harness-review — seta reviewedAt/reviewCommit " +
        "(campos pipeline-owned, que o update_card recusa) pela MESMA trava de re-leitura fresca do disco. " +
        "Use quando um humano já revisou o código com rigor e não vale re-pagar o custo/tempo da skill. " +
        "SIMÉTRICO ao approve_qa, com uma diferença: NÃO destrava gate (não existe gate de review; o gate " +
        "de saída de Revisão de código é hasNoBlockers — resolva blockers com triage_finding) e NÃO avança " +
        "o card, só grava a proveniência do review. SÓ funciona num card em Revisão de código ou nas colunas " +
        "humanas seguintes (QA / Testes, Aprovar entrega) — rejeita colunas upstream/autorun. reviewed:false revoga.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        reviewed: z.boolean().optional().describe("padrão true; false revoga (limpa reviewedAt/reviewCommit)"),
        reviewedAt: z.string().nullable().optional().describe("data YYYY-MM-DD da revisão (padrão hoje)"),
        reviewCommit: z.string().nullable().optional().describe("commit/HEAD que a revisão cobriu"),
        comment: z.string().optional().describe("nota opcional (não persiste no card)"),
      },
    },
    async ({ board, cardId, reviewed, reviewedAt, reviewCommit, comment }) => {
      const r = await approveReviewAction({ boardId: board, cardId, reviewed, reviewedAt, reviewCommit, comment });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  defineTool(server,
    "create_card",
    {
      title: "Criar card",
      description:
        "Cria UM card na Triagem (coluna de entrada/staging) do board. Story por padrão " +
        "(ou type:'idea' para registrar uma DOR/problema, que nasce inerte na bancada de Ideias). " +
        "USE para um item ÚNICO e isolado. ⚠️ NÃO use para capturar um plano completo: para transformar " +
        "um brain-dump em backbone (atividades + steps) + stories parenteadas (≥3 itens ou hierarquia " +
        "activity/step/story), use usm_capture(mode:'propose'→'apply') — create_card cria 1 stub raso por " +
        "chamada e não resolve parents em lote, então N chamadas deixam N stubs órfãos sem hierarquia. " +
        "SM-02: uma STORY criada sem parent é roteada automaticamente para o Backlog não-mapeado (unplaced) — " +
        "fica visível nessa lane do mapa em vez de sumir do backbone; parenteie-a depois (arraste/update_card). " +
        "O card descansa na Triagem (sem autorun) até ser roteado para Enriquecer, de onde a cascata segue; ou mova/rode as skills manualmente.",
      inputSchema: {
        board: z.string(),
        title: z.string(),
        type: z.enum(["story", "activity", "step", "idea"]).optional().describe("padrão story; idea registra uma DOR/problema (nasce inerte na bancada de Ideias)"),
        body: z.string().optional().describe("para type:idea, a evidência/contexto da dor"),
        storyType: enumOf<StoryType>(STORY_TYPE_IDS as StoryType[]).optional(),
        parent: z.string().optional().describe("id de um card pai (activity/step) ou outro card"),
        serves: z
          .string()
          .optional()
          .describe("dual-track: para ENTREGA (technical/bug/chore/spike), o node do mapa que serve"),
        release: z.string().optional(),
        personas: z.array(z.string()).optional(),
        systems: z.array(z.string()).optional(),
      },
    },
    async (a) => {
      const type = a.type ?? "story";
      // Todo card nasce ANCORADO. O antigo `acceptUnplaced` (que criava a story sem lugar com um
      // `unplacedAck`) foi APOSENTADO — era a válvula por onde os órfãos entravam. Este pre-check é a
      // versão RICA do erro: recusa antes de tomar o lock e devolve os candidatos certos POR TIPO
      // (entrega → as user stories; user story → os steps). A garantia dura é o chokepoint de escrita
      // (write.ts → placementViolation), que nenhuma superfície consegue contornar.
      if (type === "story" && !a.parent && !servesIsPlacement(a.storyType, a.serves)) {
        const isDelivery = a.storyType != null && a.storyType !== "user";
        const cards = await readCards(a.board);
        const candidates = cards
          .filter((c) =>
            isDelivery ? c.type === "story" && (c.storyType ?? "user") === "user" : c.type === "step",
          )
          .slice(0, 12)
          .map((c) => `${c.id} (${c.title})`);
        return fail(
          isDelivery
            ? `Entrega sem lugar na hierarquia: defina \`serves\` (ou \`parent\`) apontando para a USER STORY ` +
                `que esta entrega serve. Candidatos: ${candidates.length ? candidates.join("; ") : "(nenhuma user story neste board ainda — crie a story base primeiro, ou use usm_capture para montar o backbone)"}.`
            : `User story sem lugar na hierarquia: defina \`parent\` apontando para o PASSO (step) que ela ` +
                `detalha. Candidatos: ${candidates.length ? candidates.join("; ") : "(nenhum step neste board ainda — monte o backbone com usm_capture)"}.`,
        );
      }
      const r = await commitProposalAction({
        boardId: a.board,
        via: "mcp",
        items: [
          {
            tempId: "mcp1",
            type,
            title: a.title,
            storyType: a.storyType ?? null,
            parent: a.parent ?? null,
            serves: a.serves ?? null,
            release: a.release ?? null,
            personas: a.personas ?? [],
            systems: a.systems ?? [],
            body: a.body,
            rationale: "criado via MCP (celular)",
          },
        ],
      });
      if (!r.ok) return fail(r.error);
      const created = (r.data?.created ?? []).map((c) => slim(c));
      const warnings = r.data?.warnings ?? [];
      // Orphan-stub lint (t6): nudge toward usm_capture when a story is created parentless.
      return json({ created, ...(warnings.length ? { warnings } : {}) });
    },
  );

  defineTool(server,
    "usm_capture",
    {
      title: "Captura inteligente (brain-dump → backbone + stories parenteadas)",
      description:
        "Transforma um TEXTO LIVRE (brain-dump de um plano) em backbone (atividades + steps) + stories " +
        "parenteadas, mapeadas ao vocabulário do board e deduplicadas — em DUAS etapas (propõe → aplica). " +
        "mode:'propose' interpreta o texto e DEVOLVE o plano (com parents/releases sugeridos) SEM gravar " +
        "nada — revise antes. mode:'apply' grava todos os cards hierarquicamente na Triagem (entram no " +
        "pipeline normal). PREFIRA esta tool a N chamadas create_card sempre que houver ≥3 itens ou " +
        "hierarquia activity/step/story: create_card cria 1 stub raso por chamada e não resolve parents " +
        "em lote (vira N órfãos). 'propose' chama o LLM e pode levar alguns segundos.",
      inputSchema: {
        board: z.string(),
        mode: z.enum(["propose", "apply"]),
        text: z.string().optional().describe("texto livre do plano — obrigatório em mode:'propose'"),
        history: z
          .array(
            z.object({
              text: z.string(),
              proposal: z.object({ items: z.array(proposedItemShape), summary: z.string() }).optional(),
            }),
          )
          .optional()
          .describe("turnos anteriores (refinamento) — omita para a primeira proposta"),
        items: z
          .array(proposedItemShape)
          .optional()
          .describe("itens do plano aprovado — obrigatório em mode:'apply'"),
      },
    },
    async ({ board, mode, text, history, items }) => {
      if (mode === "propose") {
        if (!text?.trim()) return fail("text é obrigatório para mode:'propose'.");
        const r = await proposeCardsAction({ boardId: board, text, history: history as CaptureTurn[] | undefined });
        return r.ok ? json(r.data!.proposal) : fail(r.error);
      }
      // mode === "apply"
      if (!items?.length) return fail("items é obrigatório (e não-vazio) para mode:'apply'.");
      const r = await commitProposalAction({ boardId: board, via: "capture", items: items as ProposedItem[] });
      if (!r.ok) return fail(r.error);
      const created = (r.data?.created ?? []).map((c) => slim(c));
      const structuredWarnings = r.data?.warnings ?? []; // WS6 (F5): parent/serves dropped, forced-created
      return json({
        created,
        ...(structuredWarnings.length ? { warnings: structuredWarnings } : {}),
      });
    },
  );

  defineTool(server,
    "report_issue",
    {
      title: "Reportar bug/melhoria (texto livre → triagem)",
      description:
        "Recebe um relato em TEXTO LIVRE (NÃO precisa de cardId). O agente de triagem READ-ONLY classifica intenção " +
        "(feature/bug/melhoria) + tipo + severidade/frequência, deduplica contra os cards do board e cria UM card na " +
        "raia de Triagem — ou, só com alta confiança, marca como duplicado/cancelado. Nada vira trabalho até ser aceito " +
        "(use accept_triage: bug→Corrigir, melhoria→Refinar, feature→Enriquecer). Diferente de report_bug (que reabre " +
        "uma story entregue), aqui o agente decide o que é e por qual lane entra. " +
        "Foco em UM item (bug/ideia singular): para capturar um PLANO completo (vários itens de planejamento com " +
        "hierarquia) de uma vez, prefira usm_capture.",
      inputSchema: {
        board: z.string(),
        text: z.string().describe("o relato livre: o que está quebrado / o que melhorar + contexto"),
      },
    },
    async ({ board, text }) => {
      const r = await reportIssueAction({ boardId: board, text });
      return r.ok
        ? json({ ok: true, card: r.data ? slim(r.data.card) : null, outcome: r.data?.outcome })
        : fail(r.error);
    },
  );

  defineTool(server,
    "accept_triage",
    {
      title: "Aceitar card da Triagem (roteia pela lane do tipo — Opção B)",
      description:
        "Promove um card que está descansando na Triagem PARA o fluxo, roteando pelo TIPO (Opção B): " +
        "bug → Corrigir · melhoria → Refinar · feature → Enriquecer. Os campos de gate (bugReport/refinement) " +
        "já vêm prontos da triagem, então é um move limpo. Use depois de revisar o card na Triagem.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
      },
    },
    async ({ board, cardId }) => {
      const r = await acceptTriageCardAction({ boardId: board, cardId });
      return r.ok ? json({ ok: true, cardId, status: r.data?.status }) : fail(r.error);
    },
  );

  // ---- RUN / SYNC -------------------------------------------------------

  defineTool(server,
    "run_skill",
    {
      title: "Rodar skill da coluna",
      description:
        "Dispara a skill (/harness-*) da COLUNA ATUAL do card — o equivalente ao botão 'Rodar agora'. Roda " +
        "headless na sua máquina via o mesmo engine do autorun (in-flight lock + cap de concorrência + " +
        "console ao vivo). Requer o runner ligado. Acompanhe com runner_status / card_console.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const r = await runCardSkillAction({ boardId: board, cardId });
      return r.ok ? json({ ok: true, trigger: r.data?.trigger }) : fail(r.error);
    },
  );

  defineTool(server,
    "enqueue",
    {
      title: "Enfileirar card (porta única)",
      description:
        "Enfileira UM card via o MESMO engine do autorun (in-flight lock + lanes leve/pesada + worktree " +
        "isolado) — a porta ÚNICA de enfileiramento, idêntica ao run_skill e ao autorun. Roda a skill da " +
        "coluna ATUAL do card. Retorna { id, board, lane, position, estimatedStart, blocked }. Para um lote " +
        "com dependências entre cards, use enqueue_batch. Acompanhe com runner_status / card_console.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      if (!loadRunnerConfig().autorun.enabled) {
        return fail("Runner desligado (Config → autorun, ou AGILEHARNESS_AUTORUN=0). Ligue para enfileirar.");
      }
      const t = await resolveEnqueueTarget(board, cardId);
      if (!t.ok) return fail(t.error);
      const res = getRunnerEngine().enqueueWithDeps(board, cardId, t.trigger, t.def, [], {
        origin: "manual",
        headroomUrl: t.headroomUrl,
      });
      return json(res);
    },
  );

  defineTool(server,
    "enqueue_batch",
    {
      title: "Enfileirar lote com dependências",
      description:
        "Enfileira N cards de uma vez declarando um grafo de dependências. `deps` são arestas " +
        "{ from, to } com chaves 'board/cardId' onde `from` precisa CONCLUIR antes de `to` começar. Valida " +
        "ciclos (rejeita com erro descritivo) e enfileira em ordem topológica: cards sem dependência iniciam " +
        "já; os demais ficam BLOQUEADOS até seus predecessores concluírem — se um predecessor FALHAR, o " +
        "dependente fica em blocked-by-failure (aguarda o operador, não é cancelado). Mesmo engine/worktree/" +
        "lanes do autorun. Retorna { enqueued, blocked, items[] }.",
      inputSchema: {
        cards: z.array(z.object({ board: z.string(), cardId: z.string() })).min(1).describe("os cards do lote"),
        deps: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional()
          .describe("arestas 'board/cardId' → 'board/cardId'; `from` conclui antes de `to` começar"),
      },
    },
    async ({ cards, deps }) => {
      if (!loadRunnerConfig().autorun.enabled) {
        return fail("Runner desligado (Config → autorun, ou AGILEHARNESS_AUTORUN=0). Ligue para enfileirar.");
      }
      const edges = (deps ?? []).map((d) => ({ from: d.from, to: d.to }));
      const keys = cards.map((c) => `${c.board}/${c.cardId}`);
      const keySet = new Set(keys);
      if (keySet.size !== keys.length) return fail("Lote inválido: card duplicado na lista.");
      for (const e of edges) {
        if (!keySet.has(e.from) || !keySet.has(e.to)) {
          return fail(`Dependência referencia um card fora do lote: ${e.from} → ${e.to}`);
        }
      }
      const cycle = detectCycle(keys, edges);
      if (cycle) return fail(`Ciclo detectado no grafo de dependências: ${cycle.join(" → ")}`);

      // Resolve EVERY card's trigger/def first — fail the whole batch on any unresolvable card so we
      // never enqueue a partial lote (transactional intent).
      const targets = new Map<string, { board: string; cardId: string; trigger: TriggerId; def: StatusDef; headroomUrl: string | null }>();
      for (const c of cards) {
        const t = await resolveEnqueueTarget(c.board, c.cardId);
        if (!t.ok) return fail(t.error);
        targets.set(`${c.board}/${c.cardId}`, { board: c.board, cardId: c.cardId, trigger: t.trigger, def: t.def, headroomUrl: t.headroomUrl });
      }

      // Topological order ⇒ predecessors enqueue FIRST, so a dependency is already alive (in-flight or
      // blocked) when its dependent registers — without it, a later card would see an unstarted dep as
      // "already settled" and run too early.
      const order = topologicalOrder(keys, edges);
      const byKey = new Map<string, EnqueueResult>();
      for (const key of order) {
        const tgt = targets.get(key)!;
        const cardDeps = edges.filter((e) => e.to === key).map((e) => e.from);
        byKey.set(
          key,
          getRunnerEngine().enqueueWithDeps(tgt.board, tgt.cardId, tgt.trigger, tgt.def, cardDeps, {
            origin: "manual",
            headroomUrl: tgt.headroomUrl,
          }),
        );
      }

      // Echo results in the caller's INPUT order (topo order is an internal detail).
      const items = keys.map((k) => byKey.get(k)!);
      const enqueued = items.filter((i) => !i.blocked && !i.reason).length;
      const blocked = items.filter((i) => i.blocked).length;
      return json({ enqueued, blocked, items });
    },
  );

  defineTool(server,
    "sync_card",
    {
      title: "Sincronizar card com o código",
      description:
        "Roda /harness-sync-card: reconcilia o card com o estado REAL do código (rotas/componentes/functions " +
        "que existem hoje), atualiza os campos e reposiciona o card pelos fatos. Funciona em qualquer coluna.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const r = await syncCardAction({ boardId: board, cardId });
      return r.ok ? json({ ok: true, trigger: r.data?.trigger }) : fail(r.error);
    },
  );

  // ---- REOPEN (refine / bug / retire) ----------------------------------

  defineTool(server,
    "refine_card",
    {
      title: "Refinar story entregue",
      description:
        "Reabre uma story (em revisão/concluída) para melhoria. Carimba mode:refine + o brief e a pousa na " +
        "COLUNA DE DESTINO escolhida (enriquecer/design-ux/desenvolver) com reopenPending; a cascata roda " +
        "/harness-refine LÁ (override one-shot), que diagnostica o código vivo e respeca o delta. Default design-ux.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        brief: z.string().describe("o que melhorar e por quê (carrega a intensidade: polimento ↔ redesenho)"),
        kinds: z.array(enumOf<ImprovementKind>(IMPROVEMENT_KIND_IDS as ImprovementKind[])).optional(),
        destination: enumOf<ReopenDestination>([...REOPEN_DESTINATIONS] as ReopenDestination[])
          .optional()
          .describe("coluna onde o card reentra: enriquecer (Discovery) | design-ux (Design) | desenvolver. Default design-ux"),
        target: z.string().nullable().optional().describe("rota/tela/componente alvo, se específico"),
      },
    },
    async ({ board, cardId, brief, kinds, destination, target }) => {
      const r = await refineCardAction({
        boardId: board,
        cardId,
        brief,
        kinds: kinds ?? ["ux"],
        destination,
        target: target ?? null,
      });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  defineTool(server,
    "report_bug",
    {
      title: "Reportar bug em story entregue",
      description:
        "Reabre uma story porque QUEBROU. Carimba mode:fix + o relato e a pousa na COLUNA DE DESTINO " +
        "escolhida (desenvolver/design-ux/enriquecer) com reopenPending; a cascata roda /harness-fix LÁ (override " +
        "one-shot), que diagnostica, REPRODUZ o defeito e respeca aceite como esperado×atual. Default desenvolver.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        brief: z.string().describe("o que está quebrado e o contexto"),
        severity: enumOf<BugSeverity>(BUG_SEVERITY_IDS as BugSeverity[]).optional().describe("padrão medium"),
        destination: enumOf<ReopenDestination>([...REOPEN_DESTINATIONS] as ReopenDestination[])
          .optional()
          .describe("coluna onde o card reentra: desenvolver | design-ux (regressão visual) | enriquecer. Default desenvolver"),
        expected: z.string().nullable().optional(),
        actual: z.string().nullable().optional(),
        steps: z.array(z.string()).optional().describe("passos para reproduzir"),
        target: z.string().nullable().optional(),
      },
    },
    async ({ board, cardId, brief, severity, destination, expected, actual, steps, target }) => {
      const r = await reportBugAction({
        boardId: board,
        cardId,
        brief,
        severity: severity ?? "medium",
        destination,
        expected: expected ?? null,
        actual: actual ?? null,
        steps: steps ?? [],
        target: target ?? null,
      });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  defineTool(server,
    "discontinue_card",
    {
      title: "Descontinuar / arquivar story",
      description:
        "Tira uma story do pipeline para o cemitério (arquivados). disposition diz POR QUÊ (postergado é " +
        "revivível; abandonado/descontinuado são definitivos). level diz ATÉ ONDE remover código (sem level " +
        "= nada a remover → vai direto p/ arquivados). 'excluir-tudo' apaga dados e exige aprovação humana " +
        "separada na UI — o MCP não aprova exclusão de dados.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        brief: z.string().describe("motivo da descontinuação"),
        disposition: enumOf<Disposition>(DISPOSITION_IDS as Disposition[]).optional().describe("padrão descontinuado"),
        level: enumOf<RemovalLevel>(REMOVAL_LEVEL_IDS as RemovalLevel[]).nullable().optional(),
        scope: z.array(enumOf<RemovalScope>(REMOVAL_SCOPE_IDS as RemovalScope[])).optional(),
        target: z.string().nullable().optional(),
      },
    },
    async ({ board, cardId, brief, disposition, level, scope, target }) => {
      const r = await discontinueCardAction({
        boardId: board,
        cardId,
        brief,
        disposition: disposition ?? "descontinuado",
        level: level ?? null,
        scope: scope ?? [],
        target: target ?? null,
      });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  // ---- HITL QUESTIONS (perguntas do agente ↔ humano) ------------------

  defineTool(server,
    "answer_question",
    {
      title: "Responder pergunta do agente (HITL)",
      description:
        "Responde UMA pergunta ABERTA que uma skill (ex.: harness-grill) levantou num card: marca open→answered e grava " +
        "a resposta no spec, que a próxima skill (harness-enrich) lê como contexto. Veja as perguntas pendentes em " +
        "get_card (campo questions). Depois de responder todas, mova o card para a próxima coluna (ex.: enriquecer).",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        questionId: z.string().describe("id da pergunta, ex.: q1 (veja em get_card.questions)"),
        answer: z.string().describe("sua resposta — vira contexto para a skill seguinte"),
      },
    },
    async ({ board, cardId, questionId, answer }) => {
      // F6.3 — quem responde via MCP é o AGENTE (copiloto/tick), nunca o humano (o humano usa a UI
      // /perguntas). Carimba answeredBy: "copilot" server-side para a autoria não depender do modelo.
      const r = await answerQuestionAction({ boardId: board, cardId, questionId, answer, answeredBy: "copilot" });
      if (!r.ok) return fail(r.error);
      const open = r.data ? openQuestions(r.data.card) : [];
      return json({ ok: true, answered: questionId, openRemaining: open.length, openIds: open.map((q) => q.id) });
    },
  );

  defineTool(server,
    "ask_question",
    {
      title: "Perguntar de volta ao loop do agente (HITL)",
      description:
        "Adiciona uma ou mais perguntas/diretrizes ABERTAS a um card (HITL) — o operador empurra um follow-up para o " +
        "loop do agente; a próxima skill as lê como contexto. Dedup por texto (não empilha duplicatas).",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        texts: z.array(z.string()).describe("uma ou mais perguntas/diretrizes"),
        askedBy: z.string().optional().describe("quem perguntou (padrão: operator)"),
      },
    },
    async ({ board, cardId, texts, askedBy }) => {
      const r = await askQuestionsAction({ boardId: board, cardId, texts, askedBy });
      if (!r.ok) return fail(r.error);
      const open = r.data ? openQuestions(r.data.card) : [];
      return json({ ok: true, openRemaining: open.length, openIds: open.map((q) => q.id) });
    },
  );

  // ---- F5.4 APPROVAL REQUESTS (o humano concede/nega uma ação `ask` do Jido autônomo) --------------
  // approve_action/reject_action são HUMAN-DECISION (anotadas DESTRUCTIVE → full-only): um agente escopado
  // NUNCA aprova a própria escalação. wait_for_approval é RO (espera bloqueante, gabarito wait_for_run).

  defineTool(server,
    "approve_action",
    {
      title: "Aprovar ação do Jido (HITL)",
      description:
        "Concede um pedido de aprovação PENDENTE que o Jido autônomo levantou (ele tentou uma ação `ask` — " +
        "ex.: mover card p/ uma coluna que dispara um run). Depois de aprovado, o Jido re-tenta a MESMA ação e " +
        "o grant é consumido (uso único). Veja os pendentes no Inbox.",
      inputSchema: { board: z.string(), approvalId: z.string().describe("id do pedido, ex.: apr-…"), note: z.string().optional() },
    },
    async ({ board, approvalId, note }) => {
      const r = await approveActionRequestAction({ boardId: board, approvalId, note });
      return r.ok ? json({ ok: true, approved: approvalId }) : fail(r.error);
    },
  );

  defineTool(server,
    "reject_action",
    {
      title: "Rejeitar ação do Jido (HITL)",
      description: "Nega um pedido de aprovação PENDENTE do Jido autônomo — a ação não roda.",
      inputSchema: { board: z.string(), approvalId: z.string().describe("id do pedido, ex.: apr-…"), note: z.string().optional() },
    },
    async ({ board, approvalId, note }) => {
      const r = await rejectActionRequestAction({ boardId: board, approvalId, note });
      return r.ok ? json({ ok: true, rejected: approvalId }) : fail(r.error);
    },
  );

  defineTool(server,
    "wait_for_approval",
    {
      title: "Esperar decisão de uma aprovação (HITL)",
      description:
        "ESPERA BLOQUEANTE até um pedido de aprovação ser decidido (granted/rejected), expirar, ou o timeout — sem " +
        "spin-wait. O copiloto usa depois de receber um `pendingApproval`: se voltar `granted`, RE-CHAMA a ação " +
        "original com os MESMOS args; se `rejected`/`expired`/timeout, registra e SEGUE (o próximo tick retoma).",
      inputSchema: {
        board: z.string(),
        approvalId: z.string().describe("id do pedido devolvido no pendingApproval"),
        timeoutMs: z.number().int().positive().max(600_000).optional().describe("máx. de espera (padrão 120s, teto 600s)"),
      },
    },
    async ({ board, approvalId, timeoutMs }) => {
      const rec = await waitForApprovalDecision(board, approvalId, { timeoutMs });
      if (!rec) return json({ ok: true, status: "gone", note: "pedido não encontrado (talvez já consumido/removido)" });
      return json({ ok: true, status: rec.status, approvalId, decidedBy: rec.decidedBy, note: rec.note });
    },
  );

  // ---- RUNNER OBSERVABILITY --------------------------------------------

  defineTool(server,
    "publish_when_idle",
    {
      title: "Publicar quando o pipeline ficar ocioso",
      description:
        "Enfileira uma PUBLICAÇÃO (promote do código staged para main + rebuild/restart) para acontecer assim " +
        "que o pipeline ficar ocioso. É o caminho para publicar trabalho de SESSÃO — sem card. O merge train já " +
        "integra trabalho sem card, mas o promote+deploy é efeito de um PASSO do pipeline, e passo quem atravessa " +
        "é card; então trabalho de sessão encalha em `stage` até alguém publicar na mão. QUANDO USAR: você acabou " +
        "de rodar worktree_submit, o train devolveu `done`, e o código precisa ir ao ar. NÃO faça git na mão para " +
        "publicar. O pedido pina o sha do branch de staging que VOCÊ está publicando: se ele andar antes da janela " +
        "de ociosidade, o pedido vira `superseded` (o que iria ao ar não seria mais o que você escolheu) e você " +
        "re-submete olhando o novo estado — a não ser que passe allowNewer. Idempotente por (board, sha): " +
        "re-pedir devolve o pedido já aberto, nunca gera dois deploys. Acompanhe com publish_status. " +
        "Funciona nos DOIS modos de release do board: em `auto` o sistema já pede sozinho (você raramente " +
        "precisa); em `manual` o trabalho acumula e ESTA tool é o pedido — a mesma alavanca do botão " +
        "Publicar da Esteira. É risco `deploy`: num board autônomo, o riskMatrix decide se você pode " +
        "chamá-la sem perguntar.",
      inputSchema: {
        board: z.string().describe("board cujo código staged será publicado"),
        allowNewer: z
          .boolean()
          .optional()
          .describe(
            "publicar mesmo que o branch de staging tenha andado desde o pedido (padrão false). Só use quando " +
              "souber que o trabalho de terceiros que entrou junto também pode ir ao ar.",
          ),
        overrideEmbargo: z
          .boolean()
          .optional()
          .describe(
            "publicar mesmo que a guarda de concorrência acuse trabalho VIVO nos mesmos arquivos (padrão " +
              "false). É a válvula de escape para o caso em que a sessão sobreposta não vai integrar (dona " +
              "sumiu, worktree abandonado) e a publicação ficaria parada para sempre. Não destrói nada da " +
              "outra sessão: o branch e a árvore dela seguem intactos, e o próximo worktree_submit dela " +
              "resolve a divergência pelo 3-way do train. Use com o publish_status na mão, sabendo QUEM está " +
              "sendo passado por cima — o motivo do bloqueio aparece lá.",
          ),
        requestedBy: z.string().optional().describe("quem pediu (sessionId do agente); padrão 'agent'"),
      },
    },
    async ({ board, allowNewer, overrideEmbargo, requestedBy }) => {
      const { enqueuePublish } = await import("@/lib/storymap/runner/publish-queue");
      const { stagingShaOf } = await import("@/lib/storymap/runner/publish-git");
      const { loadRunnerConfig } = await import("@/lib/storymap/runner/config");
      const { mayRequestPublish, publishRefusalReason } = await import("@/lib/storymap/release-policy");
      // NÃO depende do board: pedir publicação é permitido nos dois modos de release — `manual` só
      // significa que ninguém pede POR VOCÊ. Esta tool é classificada como risco `deploy`
      // (mcp/register), então quem decide se o AGENTE pode chamá-la é o riskMatrix do board.
      const autorun = loadRunnerConfig().autorun;
      const machinery = { queueEnabled: !!autorun.publishQueue?.enabled, stagingEnabled: !!autorun.staging?.enabled };
      if (!mayRequestPublish(machinery)) return fail(publishRefusalReason(machinery) ?? "publicação indisponível.");
      const sha = await stagingShaOf(board);
      if (!sha) return fail("não deu para ler o sha do branch de staging — nada foi enfileirado.");
      const { request, deduped } = await enqueuePublish({
        board,
        requestedSha: sha,
        requestedBy: requestedBy ?? "agent",
        allowNewer,
        overrideEmbargo,
      });
      return json({
        ok: true,
        deduped,
        request,
        next: deduped
          ? "já havia um pedido aberto para este board+sha — acompanhe com publish_status"
          : "enfileirado; publica na próxima janela de ociosidade — acompanhe com publish_status",
      });
    },
  );

  defineTool(server,
    "publish_status",
    {
      title: "Estado da fila de publicação",
      description:
        "Os pedidos de publicação (mais novos primeiro) com seu desfecho: `waiting` (esperando ociosidade), " +
        "`published`, `superseded` (o staging andou — re-submeta), `interrupted` (o serviço reiniciou no meio; " +
        "NUNCA re-tentado sozinho, para não virar laço de deploy), `failed`, `cancelled`. Use depois de " +
        "publish_when_idle para saber se subiu. Um pedido SEGURADO continua `waiting` mas traz `reason` " +
        "(por que não publicou — ex.: trabalho vivo nos mesmos arquivos, e de QUEM), `heldSince` e " +
        "`heldCount`: espera longa com contagem alta é BLOQUEIO, não lentidão — aí a saída é integrar o " +
        "trabalho sobreposto ou re-pedir com overrideEmbargo.",
      inputSchema: { limit: z.number().int().positive().max(50).optional().describe("quantos pedidos (padrão 10)") },
    },
    async ({ limit }) => {
      const { listPublishRequests } = await import("@/lib/storymap/runner/publish-queue");
      const rows = await listPublishRequests();
      return json({ ok: true, requests: rows.slice(0, limit ?? 10) });
    },
  );

  defineTool(server,
    "runner_status",
    {
      title: "Status do autorun",
      description:
        "O que o runner está executando AGORA (runs ativos: board/card/skill/início) e as falhas recentes. " +
        "Use para 'o que está rodando', 'travou alguma coisa', etc. Passe board+cardId para também receber o " +
        "HISTÓRICO de telemetria dos últimos runs daquele card (data, duração, turns, tokens, custo, status).",
      inputSchema: {
        board: z.string().optional().describe("id do board — junto com cardId, retorna o histórico do card"),
        cardId: z.string().optional().describe("id do card — junto com board, retorna o histórico de telemetria"),
        limit: z.number().int().positive().max(100).optional().describe("quantos runs históricos (padrão 20)"),
      },
    },
    async ({ board, cardId, limit }) => {
      const snap = getRunnerRegistry().snapshot();
      // merge-train rootcause Front 4 (RC4): expose the merge queue so the Orquestrador (MCP-only) can
      // SEE parked integrations — `runner_status` was running+failures only, so a `gate-failed`/`conflict`
      // entry was invisible (a card stuck out of QA with nothing in runner_status). liveRunIds() ensures
      // the store is loaded before snapshotting. Only LIVE entries (terminal done/failed are noise).
      await getMergeQueue().liveRunIds();
      const mqSnap = getMergeQueue().getSnapshot();
      const base = {
        running: snap.running.map((r) => ({
          board: r.board,
          cardId: r.cardId,
          trigger: r.trigger,
          startedAt: r.startedAt,
          ageSec: Math.round((Date.now() - r.startedAt) / 1000),
          sessionId: r.sessionId,
        })),
        failures: snap.failures.map((f) => ({
          board: f.board,
          cardId: f.cardId,
          trigger: f.trigger,
          reason: f.reason,
          detail: f.detail,
          at: f.at,
        })),
        mergeQueue: mqSnap.entries
          .filter((e) => isLiveMergeStatus(e.status))
          .map((e) => ({
            runId: e.runId,
            board: e.board,
            cardId: e.cardId,
            status: e.status,
            branch: e.branch,
            // parked = aguardando o operador (retry/abort via resolve_merge); NÃO bloqueia mais a fila (drena).
            parked: e.status === "gate-failed" || e.status === "conflict",
            // P-1 — os arquivos que divergiram. Antes o desfecho era "código conflita com stage" e nada
            // mais, então quem lia esta superfície não tinha o que acionar.
            conflictFiles: e.conflict?.files,
          })),
        // P-8 — A MAIN VERMELHA, que o gate sempre mediu e ninguém nunca reportou. Enquanto ela existir,
        // NENHUM card é reprovado por essas falhas (a atribuição as absolve, corretamente) — e por isso
        // mesmo ninguém ficava sabendo. `null` quando a main está verde.
        mainRed: describeMainRed(await readMainRed().catch(() => null)),
      };
      // Backward-compat: without board+cardId the payload is identical to before (running + failures).
      // With both, append the card's telemetry history (AC4) — the durable last-N runs with metrics.
      if (board && cardId) {
        const history = await getTelemetryStore().listByCard(board, cardId, limit ?? 20);
        return json({ ...base, history });
      }
      return json(base);
    },
  );

  defineTool(server,
    "list_claims",
    {
      title: "Quem está com qual card",
      description:
        "As RESERVAS de card vivas (claims): quem (ator) está com qual card, para quê (kind), com que escopo " +
        "(code/board/both) e até quando. Use ANTES de escolher trabalho — pegar um card reservado desperdiça " +
        "tokens e garante conflito na merge train. Um claim NÃO é lock de integridade (quem protege o repo é o " +
        "train + os gates): é reserva anti-desperdício e visibilidade. Reserva EXPIRADA não bloqueia ninguém. " +
        "Passe `released: true` para ver também as reservas recém-liberadas e o motivo (expired/session-died) — " +
        "insumo de diagnóstico quando um card 'travou' e ninguém sabe por quê.",
      inputSchema: {
        board: z.string().optional().describe("id do board — ausente: todos os boards"),
        released: z
          .boolean()
          .optional()
          .describe("true: inclui as reservas já liberadas (com o motivo) além das vivas"),
      },
    },
    async ({ board, released }) => {
      const claims = getCardClaims();
      const now = Date.now();
      const shape = (c: CardClaim) => ({
        board: c.board,
        cardId: c.cardId,
        actor: c.actor,
        kind: c.kind,
        scope: c.scope,
        acquiredAt: c.acquiredAt,
        expiresAt: c.expiresAt,
        // a IDADE é o que o operador/agente realmente lê ("está com esse card há 40min") — sem fazer conta de ISO.
        ageMin: Math.max(0, Math.round((now - Date.parse(c.acquiredAt)) / 60_000)),
        ...(c.note ? { note: c.note } : {}),
        ...(c.released ? { released: c.released, releasedAt: c.releasedAt } : {}),
      });
      const live = (await claims.list(board)).map(shape);
      if (!released) return json({ claims: live });
      return json({ claims: live, releasedClaims: (await claims.listReleased(board)).slice(0, 20).map(shape) });
    },
  );

  defineTool(server,
    "wait_for_run",
    {
      title: "Aguardar conclusão de um run",
      description:
        "BLOQUEIA até o run do card TERMINAR (ou até o timeout) — em vez de repolling manual de " +
        "runner_status/card_console. Se NÃO há run ativo, retorna JÁ o último outcome durável. Devolve " +
        "{state, outcome, waitedMs}: 'completed' (terminou agora — outcome ok/exit/timeout/…), " +
        "'already-idle' (já estava parado) ou 'timeout' (ainda rodando — apenas re-chame para continuar " +
        "esperando). Resolve por evento (conclusão do run OU merge-back), não por polling. Passe board+cardId.",
      inputSchema: {
        board: z.string().describe("id do board"),
        cardId: z.string().describe("id do card"),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600000)
          .optional()
          .describe("teto de espera em ms antes de devolver 'timeout' (padrão 120000, máx 600000)"),
      },
    },
    async ({ board, cardId, timeoutMs }) => {
      const engine = getRunnerEngine();
      const mergeQueue = getMergeQueue();
      // Uma entrada VIVA na merge-queue conta como "ativo" — um run de código já settlou (isInFlight false)
      // mas o trabalho só chega em main no merge-back; sem isto o wait devolveria "já terminou" cedo demais.
      // A régua vem de `merge-status.ts` (havia uma cópia hardcoded dela aqui, e outra 100 linhas acima).
      const hasLiveMerge = () =>
        mergeQueue
          .getSnapshot()
          .entries.some((e) => e.board === board && e.cardId === cardId && isLiveMergeStatus(e.status));
      const latest = await getRunnerJournal().latest(board, cardId).catch(() => undefined);
      let result = await waitForRunCore(
        {
          isActive: () => engine.isInFlight(board, cardId) || hasLiveMerge(),
          latestOutcome: () => latest?.outcome ?? null,
          subscribe: (onDone) => {
            const u1 = engine.onComplete((ev) => {
              if (ev.board === board && ev.cardId === cardId) onDone(ev.outcome ?? null);
            });
            const u2 = mergeQueue.onMergeDone((ev) => {
              if (ev.board === board && ev.cardId === cardId) onDone((ev as { outcome?: string }).outcome ?? null);
            });
            return () => {
              u1();
              u2();
            };
          },
          schedule: (ms, cb) => {
            const t = setTimeout(cb, ms);
            return () => clearTimeout(t);
          },
        },
        Math.min(timeoutMs ?? 120000, 600000),
        () => Date.now(),
      );
      // Um merge-back (onMergeDone) não carrega o outcome do run → releia o journal para o veredito autoritativo.
      if (result.state === "completed" && result.outcome == null) {
        const fresh = await getRunnerJournal().latest(board, cardId).catch(() => undefined);
        result = { ...result, outcome: fresh?.outcome ?? null };
      }
      return json({ board, cardId, ...result });
    },
  );

  defineTool(server,
    "card_console",
    {
      title: "Console de um run",
      description:
        "As últimas linhas do console do run mais recente de um card (o que a skill está fazendo), mais o " +
        "sessionId para `claude --resume`. Use para acompanhar um run disparado por run_skill/sync_card.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        limit: z.number().int().positive().max(500).optional().describe("padrão 80 linhas"),
      },
    },
    async ({ board, cardId, limit }) => {
      const reg = getRunnerRegistry();
      const frames = reg.getLogs(board, cardId);
      const n = limit ?? 80;
      return json({
        board,
        cardId,
        sessionId: reg.lastSessionId(board, cardId) ?? null,
        lineCount: frames.length,
        lines: frames.slice(-n).map((f) => ({ at: f.at, level: f.level, text: f.text })),
      });
    },
  );

  defineTool(server,
    "cancel_run",
    {
      title: "Cancelar run headless",
      description:
        "Aborta o run de um card pelo engine: se está EXECUTANDO, manda SIGTERM no processo (taskkill /T " +
        "no Windows) e — quando isolado — reapa o worktree/branch; se está NA FILA, marca pra cancelar " +
        "limpo quando chegar a vez. Idempotente: um card sem run ativo retorna released:false com nota (não " +
        "é erro). Use quando o runner_status mostrar um run preso e pkill não for uma opção.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const result = await getRunnerEngine().forceRelease(board, cardId);
      return json({ board, cardId, ...result });
    },
  );

  defineTool(server,
    "resolve_merge",
    {
      title: "Resolver entrada PARQUEADA da merge train",
      description:
        "Resolve uma entrada PARQUEADA da fila de merge. Quando o gate de integração reprova (`gate-failed`, " +
        "suíte vermelha) ou o merge conflita (`conflict`), a entrada é PARQUEADA mas NÃO bloqueia mais a fila — " +
        "o train DRENA as demais (parking, sem head-of-line). Ela fica aguardando você: o card não sai de " +
        "revisar-codigo/desenvolver até resolver. SEM runId: lista a fila (cada entrada com `parked`). COM " +
        "runId+action: `gate-failed` aceita `retry` (re-roda o gate) ou `abort`; `conflict` " +
        "aceita `merged` (você integrou na mão) ou `abort`. Funciona em QUALQUER entrada parqueada (não só a " +
        "primeira). Resume sozinho. Idempotente. ⚠️ `abort` PRESERVA o branch com código não-integrado como " +
        "conflicted/run/<id> (inspecionável / recuperável por cherry-pick — WS-2.1); só um branch data-only é " +
        "descartado. O trabalho não-integrado fica fora da main até você recuperá-lo. Veja a fila também em " +
        "runner_status.mergeQueue. Ação `requeue`: re-enfileira uma entry TERMINAL (failed/conflict/done) a " +
        "partir da branch preservada (failed/run|conflicted/run|run) — é a recuperação para trabalho encalhado " +
        "numa branch preservada, inclusive um done MENTIROSO (falso-done: diff vazio por ref renomeada); " +
        "reintegrar um done honesto é no-op (applyPatch idempotente).",
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe("runId/sessionId da entry (== branch run/<id>); omita pra só listar a fila"),
        action: z
          .enum(["retry", "abort", "merged", "requeue"])
          .optional()
          .describe("gate-failed: retry|abort · conflict: merged|abort|requeue · failed/done: requeue"),
      },
    },
    async ({ runId, action }) => {
      const mq = getMergeQueue();
      const view = () =>
        mq
          .getSnapshot()
          .entries.filter((e) => isLiveMergeStatus(e.status))
          .map((e) => ({
            runId: e.runId,
            cardId: e.cardId,
            status: e.status,
            branch: e.branch,
            // parked = aguardando você (retry/abort). Com parking, QUALQUER parqueada é resolvível (não só a 1ª).
            parked: e.status === "gate-failed" || e.status === "conflict",
          }));
      if (!runId) {
        return json({
          queue: view(),
          note: "passe runId + action pra resolver o head represado (gate-failed: retry|abort · conflict: merged|abort)",
        });
      }
      const entry = mq.getSnapshot().entries.find((e) => e.runId === runId);
      if (!entry) return fail(`runId ${runId} não está na fila de merge`);
      // WS-2.4: name WHO aborted in the ledger — a SCOPED token (tick/agent) is not "operador". A `full`
      // token is the human operating the connector by hand → "operador". Kills the incident's mis-attribution.
      const act = currentMcpActor();
      const actorLabel = act && act.level !== "full" ? `agente (${act.tokenEnv ?? "MCP"})` : "operador (via MCP)";
      if (action === "requeue") {
        // Terminal-retry pela MESMA porta da UI (requeueMergeEntryAction): resolve a branch preservada em
        // disco (failed/run|conflicted/run|run) e re-insere `waiting`. Aceita failed/conflict/done — ver
        // isRequeueableStatus para o porquê de `done` (falso-done é recuperável; done honesto é no-op).
        const { requeueMergeEntryAction } = await import("@/app/actions");
        const res = await requeueMergeEntryAction({ runId });
        if (!res.ok || !res.data) return fail(res.ok ? "requeue sem dados" : res.error);
        return json({ resolved: { runId, was: entry.status, action: "requeue", branch: res.data.branch }, queue: view() });
      }
      if (entry.status === "gate-failed") {
        const a = action === "abort" ? "abort" : "retry";
        await mq.resolveGateFailed(runId, a, actorLabel);
        return json({ resolved: { runId, was: "gate-failed", action: a }, queue: view() });
      }
      if (entry.status === "conflict") {
        const a = action === "merged" ? "merged" : "aborted";
        await mq.resolveMergeConflict(runId, a, actorLabel);
        return json({ resolved: { runId, was: "conflict", action: a }, queue: view() });
      }
      return fail(`entry ${runId} está '${entry.status}' — resolve_merge só age numa entrada parqueada (gate-failed|conflict)`);
    },
  );

  defineTool(server,
    "card_diff",
    {
      title: "Diff +/− de um card (board/main + código/stage)",
      description:
        "O impacto de um card no código, de relance: o diff CUMULATIVO reconstruído do histórico git — " +
        "BOARD (na main: narrativa/aceite/tasks/plano/wireframe) + CÓDIGO (na branch stage: o código de " +
        "produto, escopado a packages/), cada lado com +adições/−remoções. O número de CÓDIGO é o IMPACTO " +
        "REAL na aplicação (board é churn de metadados). History-based por convenção de cardId → robusto a " +
        "churn da fila de merge. On-demand (sem custo por-card no board). null = aquele lado ainda não existe.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const { getCardFullDiffAction } = await import("@/app/actions");
      const res = await getCardFullDiffAction({ board, cardId });
      if (!res.ok || !res.data) return fail(res.ok ? "sem dados de diff" : res.error);
      const sum = (p: { additions: number; deletions: number } | null) =>
        p ? { additions: p.additions, deletions: p.deletions } : null;
      return json({
        cardId,
        boardData: sum(res.data.board), // mudanças nos arquivos de board do card (na main)
        code: sum(res.data.code), // código de produto staged em `stage` — o impacto na APLICAÇÃO
      });
    },
  );

  // ---- DEEP READ (sidecars + vocabulary) -------------------------------

  defineTool(server,
    "get_card_plan",
    {
      title: "Ler plano técnico",
      description: "O plano técnico (plans/<id>.md) que /harness-plan escreveu para um card — null se não houver.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const r = await getPlanAction({ boardId: board, cardId });
      return r.ok ? json({ markdown: r.data?.markdown ?? null }) : fail(r.error);
    },
  );

  defineTool(server,
    "get_card_wireframes",
    {
      title: "Ler design (jornada + canvas)",
      description:
        "O design de um card: a jornada (grafo/flow + narrativa), o canvas de artefatos (telas/" +
        "componentes/fluxos/notas — ou as opções legadas), o primário (chosenOptionId) e o feedback[]. " +
        "view 'full' (default) devolve o doc COMPLETO (árvores dsl/graph/html) — é o par de leitura de " +
        "write_sidecar. view 'text' devolve a PROJEÇÃO enxuta (só as projeções `content` derivadas) para " +
        "avaliar/recomendar gastando menos tokens — NUNCA escreva a projeção de volta via write_sidecar " +
        "(destruiria as árvores-fonte).",
      inputSchema: { board: z.string(), cardId: z.string(), view: z.enum(["full", "text"]).optional() },
    },
    async ({ board, cardId, view }) => {
      const r = await getWireframeAction({ boardId: board, cardId });
      if (!r.ok) return fail(r.error);
      const doc = r.data?.doc ?? null;
      if (view === "text" && doc) return json({ doc: wireframeDocTextView(doc), view: "text" });
      return json({ doc });
    },
  );

  defineTool(server,
    "get_card_retire_plan",
    {
      title: "Ler plano de remoção",
      description:
        "O plano de remoção (retire/<id>/plan.md) que /harness-retire escreveu — o que deletar em ordem segura. null se não houver.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const r = await getRetirePlanAction({ boardId: board, cardId });
      return r.ok ? json({ markdown: r.data?.markdown ?? null }) : fail(r.error);
    },
  );

  defineTool(server,
    "get_vocabulary",
    {
      title: "Vocabulário do board",
      description:
        "Personas (com jobs/pains/gains), sistemas e releases do board — o vocabulário fixo que os cards " +
        "referenciam. Use para escolher personas/systems válidos ao criar/editar um card.",
      inputSchema: { board: z.string() },
    },
    async ({ board }) => {
      const cfg = await readBoardConfig(board).catch(() => null);
      if (!cfg) return fail(`board não encontrado: ${board}`);
      return json({ personas: cfg.personas, systems: cfg.systems, releases: cfg.releases });
    },
  );

  // ---- SIDECAR WRITE (WS-3.2 — o par de escrita dos deep reads acima) ---

  defineTool(server,
    "write_sidecar",
    {
      title: "Escrever sidecar de card",
      description:
        "Grava (substitui) um sidecar de card — o conteúdo pesado que mora AO LADO do card: plano técnico " +
        "(plans/<id>.md, markdown), wireframes (wireframes/<id>.json), proposta de captura " +
        "(proposals/<id>.json) ou proposta de guia de estilo (design/proposals/<id>.json). Escrita ATÔMICA " +
        "(temp+rename): nenhum leitor vê meio arquivo. O path é DERIVADO de (board, cardId, kind) — você não " +
        "fornece caminho. Use esta tool em vez de escrever o arquivo por fs quando estiver no checkout do " +
        "SERVIÇO (lá o serviço é o único escritor de board-data); no seu próprio worktree de sessão, editar " +
        "o arquivo direto é normal. board.yaml NÃO é um sidecar: config tem dono humano (propose_change).",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        kind: enumOf<(typeof SIDECAR_KINDS)[number]>(SIDECAR_KINDS),
        content: z.string().describe("o conteúdo COMPLETO do sidecar (markdown para plans, JSON serializado para os demais)"),
      },
    },
    async ({ board, cardId, kind, content }) => {
      const cfg = await readBoardConfig(board).catch(() => null);
      if (!cfg) return fail(`board não encontrado: ${board}`);
      const card = (await readCards(board).catch(() => [])).find((c) => c.id === cardId);
      if (!card) return fail(`card não encontrado: ${cardId} (board ${board})`);
      try {
        const { path: rel, bytes } = await writeSidecarByKind(board, cardId, kind, content);
        return json({ ok: true, board, cardId, kind, path: rel, bytes });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ---- 🟥 STYLE GUIDE (bloco de Design, WS-4) ---------------------------

  defineTool(server,
    "get_styleguide",
    {
      title: "Ler guia de estilo",
      description:
        "Devolve o guia de estilo canônico do board (identidade, princípios, cor, tipografia, " +
        "espaçamento, forma, movimento, voz, anti-padrões, débito conhecido) + o ponteiro " +
        "(versão/hash) + o relatório de contraste AA recomputado (informativo — o guia é um documento " +
        "fonte-da-verdade, não trava nada). doc:null quando o board ainda não tem guia publicado (nunca " +
        "um erro).",
      inputSchema: { board: z.string() },
    },
    async ({ board }) => {
      const cfg = await readBoardConfig(board).catch(() => null);
      if (!cfg) return fail(`board não encontrado: ${board}`);
      const doc = await readStyleGuide(board);
      if (!doc) return json({ board, pointer: cfg.styleGuide ?? null, doc: null, aa: null });
      return json({ board, pointer: cfg.styleGuide ?? null, doc, aa: checkAA(doc) });
    },
  );

  defineTool(server,
    "styleguide_drift",
    {
      title: "Drift guia de estilo ↔ código",
      description:
        "Audita os tokens de cor do guia de estilo publicado contra o CSS real do pacote do board " +
        "(tokenBindings declarados no guia, ou um heurístico de arquivos comuns quando ausentes). " +
        "Report-only (D15) — nunca corrige nada. applicable:false ('não aplicável') quando o board " +
        "não tem package: ou guia publicado — nunca um erro.",
      inputSchema: { board: z.string() },
    },
    async ({ board }) => {
      const r = await styleGuideDriftAction({ boardId: board });
      return r.ok ? json(r.data) : fail(r.error);
    },
  );

  // ---- PIPELINE (unblock gates) ----------------------------------------

  defineTool(server,
    "choose_wireframe",
    {
      title: "Definir design principal",
      description:
        "Define o artefato de tela PRINCIPAL do design (id via get_card_wireframes — vale um artifact " +
        "kind 'screen' do canvas OU uma opção legada) — espelha wireframeChosen no card e destrava o " +
        "gate hasWireframe para o card sair de design.",
      inputSchema: { board: z.string(), cardId: z.string(), optionId: z.string() },
    },
    async ({ board, cardId, optionId }) => {
      const r = await chooseWireframeAction({ boardId: board, cardId, optionId });
      return r.ok ? json({ ok: true, chosen: optionId }) : fail(r.error);
    },
  );

  defineTool(server,
    "design_feedback",
    {
      title: "Feedback de design",
      description:
        "Acrescenta UMA entrada ao feedback do canvas de design (wireframes/<id>.json): um pedido de " +
        "mudança por artefato (artifactId + note), na JORNADA (artifactId 'journey'), no design COMO UM " +
        "TODO (sem artifactId) ou um aprovado explícito (kind 'approve' — o redesenho preserva o alvo " +
        "VERBATIM). Não move o card: o redesenho acontece quando o humano (ou o Autônomo) pede ajuste na " +
        "Inbox, incorporando as entradas não-resolvidas.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        artifactId: z.string().optional().describe("id do artefato (get_card_wireframes); omita para nota geral"),
        note: z.string().optional().describe("o texto do feedback (obrigatório para kind 'change')"),
        kind: z.enum(["change", "approve"]).optional().describe("default 'change'"),
      },
    },
    async ({ board, cardId, artifactId, note, kind }) => {
      const r = await submitDesignFeedbackAction({
        boardId: board,
        cardId,
        artifactId: artifactId ?? null,
        note,
        kind,
        by: "agente",
      });
      return r.ok ? json({ ok: true, id: r.data?.id }) : fail(r.error);
    },
  );

  defineTool(server,
    "triage_finding",
    {
      title: "Triar finding de code-review",
      description:
        "Muda o status de um finding (id via get_card). Resolver todo blocker aberto (fixed/wontfix) " +
        "destrava o gate hasNoBlockers para o card avançar.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        findingId: z.string(),
        status: enumOf<FindingStatus>(FINDING_STATUSES),
      },
    },
    async ({ board, cardId, findingId, status }) => {
      // WS-2 (2.3): carimba by:"copilot" server-side — a autoria não depende do modelo se lembrar de
      // declarar (mesmo padrão do answeredBy em answer_question).
      const r = await updateFindingStatusAction({ boardId: board, cardId, findingId, status, by: "copilot" });
      return r.ok ? json({ ok: true, findingId, status }) : fail(r.error);
    },
  );

  defineTool(server,
    "revive_card",
    {
      title: "Reviver card postergado",
      description:
        "Traz um card POSTERGADO de volta ao pipeline (retorna ao status de origem). Só postergado é " +
        "revivível — abandonado/descontinuado são definitivos.",
      inputSchema: { board: z.string(), cardId: z.string() },
    },
    async ({ board, cardId }) => {
      const r = await reviveCardAction({ boardId: board, cardId });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  // ---- DESTRUCTIVE (guarded — the URL token alone must not nuke data) ---

  defineTool(server,
    "approve_data_deletion",
    {
      title: "Aprovar exclusão de dados (irreversível)",
      description:
        "Aprova a etapa IRREVERSÍVEL de uma descontinuação nível 'excluir-tudo' e RE-RODA /harness-retire para " +
        "apagar os dados de produção. Exige confirm:true. Use com extrema cautela.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        confirm: z.boolean().describe("precisa ser true para executar o apagamento"),
      },
    },
    async ({ board, cardId, confirm }) => {
      if (confirm !== true) {
        return fail("Operação irreversível: passe confirm:true para aprovar o apagamento de dados de produção.");
      }
      const r = await approveDataDeletionAction({ boardId: board, cardId });
      return r.ok ? json({ ok: true, trigger: r.data?.trigger }) : fail(r.error);
    },
  );

  defineTool(server,
    "delete_card",
    {
      title: "Excluir card (soft-delete reversível)",
      description:
        "SOFT-delete: move o card para a lixeira do board (`.trash/`) e limpa referências (parent/links) em " +
        "outros cards. REVERSÍVEL por 7 dias com `restore_deleted` (kind:'card'), depois é coletado. Guard: " +
        "confirmCardId precisa ser EXATAMENTE igual a cardId. Para tirar uma FEATURE de produção (não o registro), " +
        "prefira discontinue_card. Não confunda com exclusão de DADOS DE PRODUÇÃO (approve_data_deletion).",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        confirmCardId: z.string().describe("repita o cardId exatamente para confirmar"),
        reason: z.string().optional().describe("por que excluir — registrado no manifesto da lixeira"),
      },
    },
    async ({ board, cardId, confirmCardId, reason }) => {
      if (confirmCardId !== cardId) {
        return fail(`Confirmação não bate: confirmCardId deve ser exatamente "${cardId}".`);
      }
      const r = await deleteCardAction({ boardId: board, cardId, by: "agent", reason });
      if (!r.ok) return fail(r.error);
      // Deletar não produz mais órfão: a action RECUSA enquanto algum card estiver ancorado neste
      // (reancore primeiro). O que sobra é a limpeza das arestas LATERAIS (`links`) — informativa.
      const unlinked = r.data?.unlinked ?? [];
      return json({
        ok: true,
        deleted: cardId,
        ...(unlinked.length
          ? { note: `${unlinked.length} card(s) tiveram um link para este removido: ${unlinked.join(", ")}.` }
          : {}),
      });
    },
  );

  // ---- VOCABULARY (personas / systems) ---------------------------------

  const personaShape = {
    id: z.string(),
    name: z.string(),
    color: z.string().optional(),
    role: z.string().optional(),
    description: z.string().optional(),
    jobs: z.array(z.string()).optional(),
    pains: z.array(z.string()).optional(),
    gains: z.array(z.string()).optional(),
  };
  const systemShape = {
    id: z.string(),
    name: z.string(),
    color: z.string().optional(),
    description: z.string().optional(),
    kind: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
  };

  defineTool(server,
    "save_persona",
    {
      title: "Criar/editar persona",
      description:
        "Upsert de uma persona no vocabulário do board (cria ou substitui pelo id). Inclua jobs/pains/gains " +
        "(VPC) para enriquecer a priorização das stories que a servem.",
      inputSchema: { board: z.string(), persona: z.object(personaShape) },
    },
    async ({ board, persona }) => {
      const r = await savePersonaAction({ boardId: board, persona: persona as Persona });
      return r.ok ? json({ ok: true, personas: r.data?.config.personas.map((p) => p.id) }) : fail(r.error);
    },
  );

  defineTool(server,
    "delete_persona",
    {
      title: "Excluir persona (soft-delete reversível)",
      description:
        "Remove uma persona do board e tira o id de todo card que a referenciava. SOFT: o objeto vai para a " +
        "lixeira (`.trash/`), restaurável 7 dias com `restore_deleted` (kind:'persona'). Restaurar re-insere a " +
        "persona, mas NÃO re-liga os cards (os refs ficam registrados no manifesto).",
      inputSchema: { board: z.string(), personaId: z.string(), reason: z.string().optional().describe("por que excluir — registrado na lixeira") },
    },
    async ({ board, personaId, reason }) => {
      const r = await deletePersonaAction({ boardId: board, personaId, by: "agent", reason });
      return r.ok ? json({ ok: true, personas: r.data?.config.personas.map((p) => p.id) }) : fail(r.error);
    },
  );

  defineTool(server,
    "save_system",
    {
      title: "Criar/editar sistema",
      description: "Upsert de um sistema/touchpoint no vocabulário do board (cria ou substitui pelo id).",
      inputSchema: { board: z.string(), system: z.object(systemShape) },
    },
    async ({ board, system }) => {
      const r = await saveSystemAction({ boardId: board, system: system as SystemDef });
      return r.ok ? json({ ok: true, systems: r.data?.config.systems.map((s) => s.id) }) : fail(r.error);
    },
  );

  defineTool(server,
    "delete_system",
    {
      title: "Excluir sistema (soft-delete reversível)",
      description:
        "Remove um sistema do board e tira o id de todo card que o referenciava. SOFT: o objeto vai para a " +
        "lixeira (`.trash/`), restaurável 7 dias com `restore_deleted` (kind:'system').",
      inputSchema: { board: z.string(), systemId: z.string(), reason: z.string().optional().describe("por que excluir — registrado na lixeira") },
    },
    async ({ board, systemId, reason }) => {
      const r = await deleteSystemAction({ boardId: board, systemId, by: "agent", reason });
      return r.ok ? json({ ok: true, systems: r.data?.config.systems.map((s) => s.id) }) : fail(r.error);
    },
  );

  // ── autonomo-liberdade-humana M2 — desfazer um soft-delete (a lixeira do board, reversível 7 dias) ──
  defineTool(server,
    "restore_deleted",
    {
      title: "Restaurar item excluído (da lixeira)",
      description:
        "Desfaz um soft-delete de delete_card/delete_persona/delete_system enquanto estiver na lixeira (7 dias). " +
        "Card: traz o `.md` de volta para o board. Persona/system: re-insere o objeto no board.yaml. NÃO re-liga " +
        "os cards que tinham o ref (isso fica registrado no manifesto para você re-ligar se quiser). Sem argumentos " +
        "de kind/id: primeiro liste a lixeira (a UI mostra) — ou tente pelo id que você acabou de excluir.",
      inputSchema: {
        board: z.string(),
        kind: z.enum(["card", "persona", "system"]).describe("o tipo do item excluído"),
        id: z.string().describe("o id do card/persona/system a restaurar"),
      },
    },
    async ({ board, kind, id }) => {
      const r = await restoreDeletedAction({ boardId: board, kind, id });
      return r.ok ? json({ ok: true, restored: { kind, id } }) : fail(r.error);
    },
  );

  // ── Governance (story-w9n03r) — propose_change + list_pending_changes ──────

  defineTool(server,
    "propose_change",
    {
      title: "Propor mudança em campo governado do board",
      description: `Cria um GovernanceDraft para propor alterações nos campos owner:human do board (${GOVERNANCE_ARTIFACTS.join(", ")}) sem tocá-los diretamente. O operador verá a proposta no Inbox (Aprovar / Rejeitar). Use para o PRD, para a escada estratégica LEGADA (positioning, businessMetric, desiredOutcome — hoje absorvida pelo PRD), canvas, canvasTags, releases e personas — NUNCA escreva esses campos diretamente. O 'before' é snapshot automaticamente do canônico atual; você fornece só o 'after'.

FORMATO DO PRD: ele é o documento mais alto do board e o único artefato desta lista que NÃO é campo do board.yaml — mora em storymap/boards/<board>/docs/prd.md. Use artifact:'prd' + field:<CHAVE DA SEÇÃO> (obrigatório) + after:<o markdown do CORPO da seção, sem o título — o rótulo é travado>. Rode read_doc com docType 'prd' antes, para pegar as chaves certas e ver o que já está escrito. Se você é um run headless, este é o SEU caminho: escrever o arquivo direto é bloqueado (o PRD é owner:human).

FORMATO DO CANVAS (Lean Canvas): um bloco NÃO é mais um paragrafão — é uma lista de ITENS. Para mudar um bloco use artifact:'canvas' + field:<chave do bloco> (${CANVAS_BLOCK_KEYS.join(", ")}) e after:{"items":[{"id":"i1","text":"…","tags":["<id de canvasTags>"],"group":"Demanda"}]} — PRESERVE o 'id' dos itens que você mantém (omita em itens novos) e use after:null para limpar o bloco. As TAGS (artifact:'canvasTags', sem field — a lista INTEIRA: [{"id","name","color":"#RRGGBB"}]) são o vocabulário de cores que costura cada item ao seu segmento; um item só pode referenciar uma tag que exista.`,
      inputSchema: {
        board: z.string().describe("Board id (os válidos vêm de list_boards)"),
        reason: z.string().describe("Motivo/contexto da mudança — visível ao operador no cockpit"),
        origin: z.object({
          skill: z.string().optional().describe("Skill ou ferramenta que está propondo"),
          cardId: z.string().optional().describe("Card relacionado, se houver"),
        }).optional(),
        changes: z.array(z.object({
          artifact: z.enum(GOVERNANCE_ARTIFACTS).describe("Campo governado a alterar"),
          field: z.string().optional().describe("Sub-campo. Para o PRD: OBRIGATÓRIO, a chave da SEÇÃO (ex. 'posicionamento', 'escopo'). Para canvas: a chave do bloco, ex. 'problem'. Omita para substituir o artefato inteiro — canvasTags é sempre inteiro)"),
          after: z.any().describe("Valor proposto — o que você quer que vire canônico. PRD: o markdown do CORPO da seção, sem o título (o rótulo é travado). Canvas: {items:[…]} ou null"),
          label: z.string().optional().describe("Label legível para o operador (ex: 'Canvas · Problema')"),
        })).min(1).describe("Mudanças — múltiplas mudanças relacionadas viram 1 decisão (AC6)"),
      },
    },
    async ({ board, reason, origin, changes }) => {
      // snapshot `before` from the live canonical so the agent never has to read it
      const config = await readBoardConfig(board);
      const mappedChanges = await Promise.all(changes.map(async (c) => {
        // O PRD é o artefato governado que NÃO mora no `board.yaml`: o canônico dele é a SEÇÃO do
        // markdown, e `field` é a chave dela. Recusar aqui uma chave inventada (em vez de deixar a
        // proposta nascer e morrer na aprovação) é o que faz o agente corrigir no mesmo turno.
        if (await docIsCanonical(board, c.artifact)) {
          if (c.artifact === "prd" && !isPrdSection(c.field)) {
            throw new Error(
              `Seção desconhecida no PRD: "${c.field ?? "(nenhuma)"}". Uma mudança de PRD precisa de \`field\` com a CHAVE de uma seção. As válidas: ${prdSectionKeys().join(", ")}.`,
            );
          }
          const before = await readGovernedValue(board, c.artifact, c.field, config);
          return { artifact: c.artifact, field: c.field ?? null, before, after: c.after, label: c.label ?? null };
        }
        const current = (config as unknown as Record<string, unknown>)[c.artifact];
        const before = c.field == null
          ? current
          : (current && typeof current === "object" ? (current as Record<string, unknown>)[c.field] : undefined);
        return { artifact: c.artifact, field: c.field ?? null, before, after: c.after, label: c.label ?? null };
      }));
      const r = await proposeChangeAction({ boardId: board, reason, origin: origin ?? null, changes: mappedChanges });
      if (!r.ok) return fail(r.error);
      return json({ ok: true, draftId: r.data?.draftId, message: `Proposta criada — o operador verá no Inbox do board '${board}'.` });
    },
  );

  defineTool(server,
    "list_pending_changes",
    {
      title: "Listar propostas de mudança pendentes",
      description: "Lista todos os GovernanceDrafts com status pending para um board (aguardando decisão do operador no Inbox). Inclui conflitos detectados (before ≠ canônico atual). Leitura — não altera nada.",
      inputSchema: {
        board: z.string().describe("Board id"),
      },
    },
    async ({ board }) => {
      const config = await readBoardConfig(board);
      const drafts = await listGovernanceDrafts(board);
      const pending = drafts
        .filter((d) => d.status === "pending")
        .map((d) => ({
          draftId: d.id,
          reason: d.reason,
          origin: d.origin,
          createdAt: d.createdAt,
          artifacts: [...new Set(d.changes.map((c) => c.field ? `${c.artifact}.${c.field}` : c.artifact))],
          conflicts: governanceConflicts(d, config),
        }));
      return json({ board, count: pending.length, pending });
    },
  );

  // ── Dual-track OST: ideias (espaço do problema) ────────────────────
  defineTool(server,
    "create_idea",
    {
      title: "Criar ideia (documento de exploração)",
      description:
        "Cria uma IDEIA (type:idea) — algo que ainda NÃO foi decidido, de qualquer natureza: uma " +
        "funcionalidade cogitada, a suspeita de um defeito, uma dúvida técnica, um incômodo de " +
        "negócio. A régua (ADR-066): sei o que precisa ser feito? → tarefa (create_card). Preciso " +
        "investigar antes? → ideia. NASCE INERTE fora do pipeline (status nulo, não dispara autorun) " +
        "e amadurece como DOCUMENTO até virar decisão. As tarefas que a executam nascem DEPOIS com " +
        "generate_tasks_for_idea (que as liga por 'addresses'). Diferente de create_card(type:'idea'), " +
        "esta aceita os campos de exploração (candidateSolutions/keyAssumption/successSignal/valueSize).",
      inputSchema: {
        board: z.string(),
        title: z.string().optional().describe("o nome da ideia; na ausência dele o statement vira o título"),
        statement: z.string().optional().describe("a ideia em uma frase (a primeira seção do documento)"),
        evidence: z.string().optional().describe("o que sustenta a ideia — dados, relatos, código lido, evidência de campo"),
        candidateSolutions: z.array(z.string()).optional().describe("soluções candidatas (espaço da solução)"),
        keyAssumption: z.string().optional().describe("premissa mais arriscada a validar antes de apostar"),
        successSignal: z.string().optional().describe("sinal-líder de que a dor está sendo resolvida"),
        valueSize: z.object({ reach: z.number().nullable(), impact: z.number().nullable() }).optional().describe("dimensionamento de valor da dor"),
      },
    },
    async (a) => {
      const r = await createIdeaAction({
        boardId: a.board,
        title: a.title,
        statement: a.statement,
        evidence: a.evidence,
        candidateSolutions: a.candidateSolutions,
        keyAssumption: a.keyAssumption,
        successSignal: a.successSignal,
        valueSize: a.valueSize,
      });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  // ── A escrita do EXPLORADOR no documento (classe `idea-write`) ──────────────────────
  defineTool(server,
    "write_idea",
    {
      title: "Escrever no documento de uma ideia",
      description:
        "ACRESCENTA ao documento de uma IDEIA o que você apurou: uma nota no corpo (markdown, assinada e " +
        "datada) e/ou os campos de exploração (statement, evidence, keyAssumption, successSignal, " +
        "candidateSolutions). É a tool do EXPLORADOR — a única escrita que um token de leitura monta, e ela é " +
        "estreita de propósito: NUNCA apaga (campo vazio é ignorado; a nota é somada ao corpo, nunca " +
        "substitui; caminhos novos são UNIDOS aos existentes) e NÃO alcança status, pai, links, o estado da " +
        "exploração nem o motivo do descarte. Decidir que a ideia virou tarefa — ou que morreu — é gesto do " +
        "humano (generate_tasks_for_idea / update_idea). Recusa qualquer card que não seja type:idea. " +
        "Escreva o que APUROU com a origem (arquivo, comando, fonte); nota sem origem vira fato falso amanhã.",
      inputSchema: {
        board: z.string(),
        cardId: z.string().describe("o id da ideia (idea-…)"),
        note: z.string().optional().describe("markdown a ACRESCENTAR ao corpo do documento"),
        statement: z.string().optional().describe("a ideia em uma frase (só preenche/melhora; vazio não limpa)"),
        evidence: z.string().optional().describe("o que sustenta a ideia — dados, relatos, código lido"),
        keyAssumption: z.string().optional().describe("a premissa que derruba tudo se for falsa"),
        successSignal: z.string().optional().describe("como saberíamos que deu certo"),
        candidateSolutions: z.array(z.string()).optional().describe("caminhos possíveis (UNIDOS aos que já existem)"),
      },
    },
    async (a) => {
      const r = await appendToIdeaAction({
        boardId: a.board,
        cardId: a.cardId,
        note: a.note,
        statement: a.statement,
        evidence: a.evidence,
        keyAssumption: a.keyAssumption,
        successSignal: a.successSignal,
        candidateSolutions: a.candidateSolutions,
      });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  // ── Os DOCUMENTOS de board (markdown como fonte da verdade) ─────────────────────────
  // `read_doc` é `read`; `write_doc` tem classe própria (`doc-write`) pelo mesmo argumento da Ideia:
  // um documento não tem status, trigger nem coluna, então escrever nele não move entrega — e é isso
  // que deixa uma conversa de TELA (token `ro`) redigir sem receber o poder de mover card e publicar.
  defineTool(server,
    "read_doc",
    {
      title: "Ler um documento de board",
      description:
        "Devolve o MARKDOWN de um documento de board (o Lean Canvas e os próximos) — a fonte da verdade dele, " +
        "exatamente como está em disco, mais as seções que o schema declara e o que estiver violando o " +
        "esqueleto. Leia ANTES de escrever: as seções têm chaves fixas, e escrever numa chave que você não " +
        "conferiu é a forma nº1 de errar o lugar. Sem `docType`, lista os documentos que existem.",
      inputSchema: {
        board: z.string(),
        docType: z.string().optional().describe("ex.: lean-canvas. Omita para listar os documentos disponíveis."),
      },
    },
    async (a) => {
      if (!a.docType) {
        return json({
          docs: listDocEntries().map((e) => ({
            docType: e.schema.docType,
            label: e.label,
            sections: e.schema.sections.map((s) => ({ key: s.key, label: s.label, content: s.content, hint: s.hint })),
          })),
        });
      }
      const r = await readDocAction({ boardId: a.board, docType: a.docType });
      if (!r.ok) return fail(r.error);
      const d = r.data!;
      return json({
        docType: a.docType,
        markdown: serializeSchemaDoc(d.doc, listDocEntries().find((e) => e.schema.docType === a.docType)!.schema),
        exists: d.exists,
        violations: d.violations.map((v) => ({ code: v.code, severity: v.severity, section: v.sectionKey, message: v.message })),
      });
    },
  );

  defineTool(server,
    "write_doc",
    {
      title: "Escrever numa seção de um documento de board",
      description:
        "ACRESCENTA (ou, com mode:'replace', reescreve) o conteúdo de UMA seção de um documento de board. " +
        "Estreita de propósito: NÃO alcança o cabeçalho (o que a máquina lê), NÃO renomeia rótulo de seção " +
        "(eles são travados e a gravação revalida), NÃO cria seção fora do schema e NÃO escreve o documento " +
        "inteiro de uma vez. Rode `read_doc` antes para pegar as chaves de seção certas. Numa seção de itens " +
        "mande `items` (um item = UMA ideia, curta); numa de prosa mande `prose`. `group` é a subdivisão " +
        "autoral dentro da seção — use a que já existe no documento em vez de inventar uma paralela.",
      inputSchema: {
        board: z.string(),
        docType: z.string().describe("ex.: lean-canvas"),
        section: z.string().describe("a CHAVE da seção (de read_doc), não o rótulo"),
        items: z
          .array(
            z.object({
              text: z.string().describe("o item — uma ideia por linha"),
              group: z.string().nullish().describe("subdivisão autoral dentro da seção"),
              checked: z.boolean().optional(),
            }),
          )
          .optional(),
        prose: z.string().optional().describe("markdown, para seções de prosa"),
        mode: z.enum(["append", "replace"]).optional().describe("default append; replace reescreve a seção"),
      },
    },
    async (a) => {
      const r = await writeDocSectionAction({
        boardId: a.board,
        docType: a.docType,
        section: a.section,
        items: a.items?.map((i) => ({ text: i.text, group: i.group ?? null, checked: i.checked })),
        prose: a.prose,
        mode: a.mode,
      });
      return r.ok ? json({ ok: true, ...r.data }) : fail(r.error);
    },
  );

  // ── A escrita do ARQUITETO no vocabulário (classe `doc-write`) ──────────────────────
  // Uma persona/sistema é um DOCUMENTO de board como o Canvas: vive fora do pipeline (sem status, sem
  // trigger, sem coluna), então escrever nela não move entrega — o mesmo argumento que deu classe própria
  // ao `write_doc`, e por isso ela reusa essa classe em vez de inventar uma 13ª com a mesma semântica.
  // A contenção é ESTRUTURAL: a linha tem de existir (esta tool nunca cria), o alcance é o prompt + o tipo
  // + o resumo, e nome/cor/exclusão ficam fora do alcance dela. Leia com `get_vocabulary` antes.
  defineTool(server,
    "write_vocab",
    {
      title: "Escrever no prompt de uma persona/sistema",
      description:
        "ACRESCENTA (ou, com mode:'replace', reescreve) o PROMPT de UMA persona ou de UM sistema do board — " +
        "o texto que um agente ADOTA depois ao escrever e construir, e por isso o lugar onde vago custa caro. " +
        "Rode `get_vocabulary` antes para pegar o id certo. Estreita de propósito: NÃO cria nem exclui linha, " +
        "NÃO renomeia, NÃO muda cor, e campo vazio NUNCA limpa nada (é ignorado). `note` acrescenta um bloco " +
        "assinado e datado; `prompt` acrescenta texto cru (ou o substitui inteiro com mode:'replace' — use só " +
        "quando o humano pedir a reescrita). `type` é o tipo que agrupa a lista (persona: \"Segmento de " +
        "mercado\"/\"Interna\"; sistema: Canal/Serviço/UI/Dados/Integração/Infra) e `summary` é a linha de " +
        "resumo que a listagem mostra. Escreva o que APUROU com a origem (arquivo, comando, fonte).",
      inputSchema: {
        board: z.string(),
        kind: z.enum(["persona", "system"]),
        id: z.string().describe("o id da persona/sistema (de get_vocabulary) — tem de já existir"),
        note: z.string().optional().describe("markdown a ACRESCENTAR ao prompt, assinado e datado"),
        prompt: z.string().optional().describe("texto do prompt — acrescentado, ou o novo inteiro com replace"),
        type: z.string().optional().describe("o tipo que agrupa a lista (não limpa quando vazio)"),
        summary: z.string().optional().describe("a linha de resumo da listagem (papel da persona / descrição do sistema)"),
        mode: z.enum(["append", "replace"]).optional().describe("default append; replace reescreve o prompt inteiro"),
      },
    },
    async (a) => {
      const r = await appendToVocabAction({
        boardId: a.board,
        kind: a.kind,
        id: a.id,
        note: a.note,
        prompt: a.prompt,
        type: a.type,
        summary: a.summary,
        mode: a.mode,
      });
      return r.ok ? json({ ok: true, ...r.data }) : fail(r.error);
    },
  );

  defineTool(server,
    "update_idea",
    {
      title: "Editar ideia (◆ — campos OST)",
      description:
        "Edita os campos de uma IDEIA (type:idea): statement, evidence, status (open/exploring/" +
        "addressed) e os OST-light (candidateSolutions/keyAssumption/successSignal/valueSize). Patch cirúrgico — " +
        "campos omitidos preservam o valor anterior. update_card NÃO edita ideia; use esta.",
      inputSchema: {
        board: z.string(),
        cardId: z.string().describe("id da ◆ a editar"),
        statement: z.string().optional(),
        evidence: z.string().nullable().optional(),
        status: enumOf<IdeaStatus>(IDEA_STATUS_IDS as IdeaStatus[]).optional().describe("open | exploring | addressed"),
        candidateSolutions: z.array(z.string()).optional(),
        keyAssumption: z.string().nullable().optional(),
        successSignal: z.string().nullable().optional(),
        valueSize: z.object({ reach: z.number().nullable(), impact: z.number().nullable() }).nullable().optional(),
      },
    },
    async (a) => {
      const r = await updateIdeaAction({
        boardId: a.board,
        cardId: a.cardId,
        statement: a.statement,
        evidence: a.evidence,
        status: a.status,
        candidateSolutions: a.candidateSolutions,
        keyAssumption: a.keyAssumption,
        successSignal: a.successSignal,
        valueSize: a.valueSize,
      });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  defineTool(server,
    "generate_tasks_for_idea",
    {
      title: "Gerar tarefas de uma ideia (Ideia → cards por 'addresses')",
      description:
        "Aciona a fronteira 'Gerar tarefas' (ADR-066): a Ideia PERMANECE viva e dispara uma captura " +
        "ESCOPADA que propõe as user stories de entrega que resolvem a dor. ASSÍNCRONO: cria um container em " +
        "'capturando' (autorun) e a proposta aparece no Inbox; ao aceitar lá, as stories nascem JÁ ligadas por " +
        "'addresses'→esta ideia. Acompanhe com runner_status / list_cards(status:'capturando').",
      inputSchema: {
        board: z.string(),
        cardId: z.string().describe("id da ideia (◆) cujas stories serão geradas"),
      },
    },
    async (a) => {
      const r = await generateTasksForIdeaAction({ boardId: a.board, cardId: a.cardId });
      return r.ok
        ? json({
            ok: true,
            container: r.data ? slim(r.data.card) : null,
            note: "captura escopada disparada (async): revise a proposta no Inbox; aceitar cria as stories com o edge addresses→esta ideia.",
          })
        : fail(r.error);
    },
  );

  // ── Governança: aprovar/rejeitar propostas (fecha o loop do propose_change) ─
  defineTool(server,
    "approve_change",
    {
      title: "Aprovar proposta de governança",
      description:
        "Aprova um GovernanceDraft pendente (de propose_change) — aplica a mudança ao board.yaml canônico " +
        "(positioning/businessMetric/desiredOutcome/canvas/releases/personas) e marca a proposta como aprovada. " +
        "Guard de conflito: se o valor canônico mudou desde a proposta (before ≠ atual), RECUSA (a proposta " +
        "precisa ser refeita). Liste os pendentes com list_pending_changes.",
      inputSchema: {
        board: z.string(),
        draftId: z.string().describe("id do GovernanceDraft pendente (de list_pending_changes)"),
      },
    },
    async ({ board, draftId }) => {
      const r = await approveGovernanceDraftAction({ boardId: board, draftId });
      return r.ok ? json({ ok: true, approved: draftId }) : fail(r.error);
    },
  );

  defineTool(server,
    "reject_change",
    {
      title: "Rejeitar proposta de governança",
      description:
        "Rejeita um GovernanceDraft pendente (de propose_change) — o canônico fica inalterado e a proposta é " +
        "marcada como rejeitada (mantida no audit trail; some do Inbox). Par simétrico de approve_change.",
      inputSchema: {
        board: z.string(),
        draftId: z.string().describe("id do GovernanceDraft pendente a rejeitar"),
      },
    },
    async ({ board, draftId }) => {
      const r = await rejectGovernanceDraftAction({ boardId: board, draftId });
      return r.ok ? json({ ok: true, rejected: draftId }) : fail(r.error);
    },
  );

  // ── autonomo-liberdade-humana M1 — revisão por par: a SUA proposta aprovada por um agente INDEPENDENTE ──
  defineTool(server,
    "request_peer_review",
    {
      title: "Pedir revisão por par da própria proposta de governança",
      description:
        "Para a SUA proposta pendente (um GovernanceDraft de propose_change): em vez de esperar o humano, PEÇA " +
        "revisão por par. A infra spawna um revisor INDEPENDENTE e cegado ao seu raciocínio, que julga o diff " +
        "sozinho. Se ele APROVAR, a mudança é aplicada ao canônico atribuída `peer:<runId>` (o mesmo guard de " +
        "conflito do approve_change vale). Se VETAR — ou o par falhar/estourar tempo — a proposta segue PENDENTE " +
        "para o humano (fail-closed). Você NUNCA aprova a si mesmo: approve_change/approve_action seguem humano-only.",
      inputSchema: {
        board: z.string(),
        draftId: z.string().describe("id do GovernanceDraft pendente (de list_pending_changes) a submeter ao par"),
      },
    },
    async ({ board, draftId }) => {
      // Segundo cadeado de código (além da matriz): uma matriz `peer-review: auto` editada à mão não alcança isto.
      if (!PEER_REVIEW_ENABLED) return fail("Revisão por par está desligada (PEER_REVIEW_ENABLED=false) — a proposta segue para o humano.");
      const draft = await readGovernanceDraft(board, draftId);
      if (!draft) return fail(`Proposta não encontrada: ${draftId}`);
      if (draft.status !== "pending") return fail(`Proposta já ${draft.status === "approved" ? "aprovada" : "rejeitada"} — nada a revisar.`);

      // Contexto OBJETIVO para o par (nunca o `reason` do proponente — isso quebraria a cegueira): o card que
      // motivou a proposta, com seu aceite. É factual, não é o argumento de quem propôs.
      let cardContext: string | undefined;
      const cardId = draft.origin?.cardId;
      if (cardId) {
        const card = await readCard(board, cardId).catch(() => null);
        if (card) cardContext = `Card ${card.id}: ${card.title}\nAceite:\n${(card.acceptance ?? []).map((a) => `- ${a}`).join("\n") || "(sem critérios)"}`;
      }

      const req: PeerReviewRequest = {
        board,
        draftId,
        changes: draft.changes.map((c) => ({ artifact: c.artifact, field: c.field, label: c.label, before: c.before, after: c.after })),
        cardContext,
      };
      const verdict = await makePeerReviewPort({ claudeBin: resolvedClaudeBin({ name: loadRunnerConfig().autorun.claudeBin }) })(req);
      if (verdict.error) return fail(`Revisão por par não concluiu (${verdict.error}) — a proposta segue pendente para o humano.`);
      if (verdict.verdict === "reject") {
        return json({ ok: true, decision: "rejected", by: `peer:${verdict.runId}`, rationale: verdict.rationale ?? null, concerns: verdict.concerns ?? [], message: "O par VETOU a proposta — ela segue pendente para o humano decidir." });
      }
      // approve — a INFRA executa a aprovação (o proponente nunca chama approve_change), atribuída ao par.
      const r = await approveGovernanceDraftAction({ boardId: board, draftId, approvedBy: `peer:${verdict.runId}` });
      if (!r.ok) return fail(`O par aprovou, mas aplicar falhou: ${r.error}`);
      return json({ ok: true, decision: "approved", by: `peer:${verdict.runId}`, rationale: verdict.rationale ?? null, message: "O par aprovou e a mudança foi aplicada ao canônico (atribuída ao par)." });
    },
  );

  // ── Grafo: links tipados (ex.: ligar uma story existente à sua dor) ────────
  defineTool(server,
    "set_card_links",
    {
      title: "Definir os links tipados de um card (grafo)",
      description:
        "SUBSTITUI o conjunto de links tipados de um card. Use para ligar uma STORY já existente à sua DOR " +
        "(ideia): links:[{rel:'addresses', to:'<ideaId>'}]. Outros rels: depends-on/relates-to/blocks/" +
        "serves/targets. Cada link é VALIDADO contra o grafo do board (rel conhecido, destino existente, pontas " +
        "from/to permitidas) — um link inválido é recusado e nada é gravado. Passe o conjunto COMPLETO de links.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        links: z
          .array(z.object({
            rel: z.string().describe("tipo de relação, ex.: 'addresses'"),
            to: z.string().describe("id do card destino"),
          }))
          .describe("o conjunto COMPLETO de links do card (substitui o anterior)"),
      },
    },
    async (a) => {
      const r = await setCardLinksAction({ boardId: a.board, cardId: a.cardId, links: a.links });
      return r.ok ? json({ ok: true, card: r.data ? slim(r.data.card) : null }) : fail(r.error);
    },
  );

  // ── WS4: rota por card (skips dispensáveis + tetos de modelo/effort) ──────────
  defineTool(server,
    "set_card_route",
    {
      title: "Definir a rota (routing) de um card",
      description:
        "Sobrescreve a ROTA por-instância de um card: quais STEPS DISPENSÁVEIS ele pula na cascata + tetos " +
        "de modelo/effort (teto-sob-teto). É o caminho HUMANO para ajustar rota (update_card recusa routing). " +
        "VALIDADO no servidor: só steps marcados `dispensable` podem ser pulados; steps LOAD-BEARING " +
        "(plano-tecnico/desenvolver/revisar-codigo/qa-*) NUNCA — o pedido é recusado com o motivo. Passe o " +
        "conjunto COMPLETO de skips (substitui o anterior); skips vazio + sem tetos/perfil LIMPA a rota. Pular " +
        "'priorizar' sem priorityCall trava no gate de prioridade (fail-closed) — o retorno avisa.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        skips: z.array(z.string()).optional().describe("ids de steps dispensáveis a pular (conjunto COMPLETO; substitui)"),
        profile: z.string().optional().describe("id de um routeProfiles do board (ex.: express), rótulo/traço"),
        modelCap: enumOf(MODEL_TIERS).optional().describe("teto de modelo p/ TODOS os steps"),
        effortCap: enumOf(EFFORT_LEVELS).optional().describe("teto de effort p/ TODOS os steps"),
        rationale: z.string().optional().describe("por que essa rota (traço no histórico)"),
      },
    },
    async (a) => {
      const r = await setCardRouteAction({
        boardId: a.board,
        cardId: a.cardId,
        skips: a.skips,
        profile: a.profile,
        modelCap: a.modelCap,
        effortCap: a.effortCap,
        rationale: a.rationale,
      });
      return r.ok
        ? json({ ok: true, card: r.data ? slim(r.data.card) : null, ...(r.data?.note ? { note: r.data.note } : {}) })
        : fail(r.error);
    },
  );
}
