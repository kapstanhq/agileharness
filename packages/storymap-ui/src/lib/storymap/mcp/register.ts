import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpLevel, RiskClass } from "@/lib/storymap/types";
import { guardToolCall } from "./guard";

/**
 * Thin, NON-overloaded wrapper over `McpServer.registerTool`.
 *
 * ROOT CAUSE this fixes: the MCP SDK's `registerTool` has heavily overloaded,
 * deeply-generic signatures. TypeScript re-ran overload resolution + deep generic
 * inference at EVERY one of our 50+ call sites, which made `tsc --noEmit` on
 * storymap-ui take ~520s and then blow the heap (OOM, exit 134 — even at 8 GB).
 * Bisect proof: excluding the mcp module dropped the full typecheck to ~6s.
 *
 * THE FIX: every tool registers through this single helper. The SDK method is
 * accessed via ONE plain call signature (cast), so tsc never does overload
 * resolution for our call sites; the handler's `args` stay fully typed via
 * `z.infer` over the input shape. Runtime behaviour is byte-for-byte identical —
 * `registerTool` is still what runs; only the type-checking path is simplified.
 *
 * It ALSO attaches MCP tool ANNOTATIONS (readOnly/destructive/idempotent/openWorld
 * hints) by tool name, from the central map below — so the consuming agent can tell a
 * safe read from a destructive/production action and behave accordingly, WITHOUT
 * editing every call site (the classification lives in one auditable place).
 */

// MCP standard tool hints (https://modelcontextprotocol.io/docs — ToolAnnotations).
interface ToolHints {
  readOnlyHint?: boolean; // does not modify its environment
  destructiveHint?: boolean; // may perform destructive/irreversible updates
  idempotentHint?: boolean; // repeating with the same args adds no further effect
  openWorldHint?: boolean; // interacts with external entities (internet, prod, GitHub…)
}

// Presets ------------------------------------------------------------------
const RO: ToolHints = { readOnlyHint: true, openWorldHint: false }; // pure read of local state
const RO_EXT: ToolHints = { readOnlyHint: true, openWorldHint: true }; // read of an external system (GCP)
const WRITE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const WRITE_IDEM: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
const DESTRUCTIVE: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };
const EXEC_EXT: ToolHints = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }; // runs a process / hits the network
const DEPLOY: ToolHints = { readOnlyHint: false, destructiveHint: true, openWorldHint: true }; // production, hard to reverse

// Classification of every registered tool. A name missing here registers with no
// annotation (graceful) — keep this in sync when adding tools.
const TOOL_ANNOTATIONS: Record<string, ToolHints> = {
  // --- reads (board + guide) ---
  mcp_onboarding: RO,
  list_boards: RO,
  list_cards: RO,
  get_card: RO,
  list_statuses: RO,
  get_vocabulary: RO,
  // --- style guide (bloco de Design) — read-only surface; o guia é um documento fonte-da-verdade
  //     autorado pelo humano/agente, sem tool de aprovação/opções.
  get_styleguide: RO,
  styleguide_drift: RO,
  runner_status: RO,
  list_claims: RO, // WS-4.3 — quem está com qual card (reservas vivas); leitura pura, nunca reserva nada
  wait_for_run: RO, // espera bloqueante por conclusão de run (evento, não polling) — story-97gpdm
  wait_for_submit: RO, // espera bloqueante pelo VEREDITO da submissão de uma sessão ao train (story-jseof2)
  // M5 — espera MULTIPLEXADA (runs + submits + sessões). Read: ela só OBSERVA (assina eventos que já
  // existem e lê o retrato em memória do vigia); não move card, não spawna, não escreve nada.
  wait_for_any: RO,
  card_console: RO,
  get_card_wireframes: RO,
  get_card_plan: RO,
  get_card_retire_plan: RO,
  // --- board writes (non-destructive) ---
  // O REGISTRO DE UM BOARD. `WRITE` (⇒ classe derivada `write-board`), e a justificativa é a régua deste
  // arquivo: "a fronteira é o que a chamada EXECUTA". Ela executa um `mkdir` e a criação de um
  // `board.yaml` sob o diretório de dados — não spawna, não alcança rede, não apaga nada.
  //
  // ⚠️ A CONTENÇÃO REAL NÃO É ESTA LINHA, É O ESQUEMA DA TOOL. Um board.yaml pode carregar
  // `orchestrator.riskMatrix`, que o guard relê A CADA CHAMADA — um board registrado com
  // `{run: auto, deploy: auto}` auto-concederia ao próprio agente tudo naquele board, e nem
  // `NEVER_AUTO_RISK_CLASSES` (só cobre run-free/destructive) nem `HUMAN_BOARD_FIELDS` (não lista
  // `orchestrator`) o impediriam. Por isso `orchestrator` e `statuses` NÃO EXISTEM no inputSchema, e
  // `autorunDisabled` não é parâmetro. No dia em que algum deles entrar, esta anotação vira mentira e a
  // classe honesta passa a ser `destructive` (full-only) — pelo mesmo raciocínio que tirou
  // `approve_change` de um `write-board` cosmético.
  register_board: WRITE,
  // ARMAR/DESARMAR o autorun de um board. O preset é EXEC_EXT e a classe derivada é `run` — não
  // `write-board`, embora a chamada só grave uma linha de YAML. A régua deste arquivo é o EFEITO, e o
  // efeito de armar é standing: dali em diante, todo card que entrar numa coluna com trigger spawna um
  // `claude` headless SEM outra chamada. Classificar pelo tamanho da escrita seria classificar pelo
  // mecanismo, o erro que `publish_when_idle` documenta ("classificar pelo efeito, nunca pelo atraso").
  // `run` é montável em `orch` — coerente, porque um token `orch` já pode disparar runs por `enqueue`:
  // armar automatiza uma capacidade que ele tem, não concede uma que ele não tinha. Fica FORA de
  // `write`, que é o token de quem só edita board.
  set_board_autorun: EXEC_EXT,
  create_card: WRITE,
  usm_capture: WRITE, // smart capture: propose (no write) → apply (batch create in Triagem)
  update_card: WRITE_IDEM,
  // (autonomo-liberdade-humana M4, 2026-07-18 — mark_tasks_done APOSENTADO) A tool que flipava `tasks[].done` na
  // mão para cruzar o gate C2 (hasBuildEvidence) foi REMOVIDA para humano E agente: o carimbo manual era um
  // "confie em mim" sem prova, e a evidência aceita agora é (a) a convergência de conteúdo do run
  // (buildEvidence: already-landed, carimbada pelo engine) ou (b) a conclusão real das tasks pelo próprio harness-do.
  // Medição pré-remoção (agent-actions/journal/events, 30d): 0 usos ⇒ a convergência já cobria tudo que rodou.
  approve_qa: WRITE_IDEM, // QA first-class: sets qaPassed/qaRanAt/qaCommit (idempotent by card+args)
  approve_review: WRITE_IDEM, // review first-class (story-740c8g): sets reviewedAt/reviewCommit (idempotent by card+args)
  move_card: WRITE_IDEM,
  choose_wireframe: WRITE_IDEM,
  design_feedback: WRITE, // Canvas v2 — APPENDS uma entrada ao feedback[] do design (não idempotente por args)
  refine_card: WRITE,
  report_bug: WRITE,
  report_issue: WRITE,
  revive_card: WRITE,
  sync_card: WRITE,
  save_persona: WRITE_IDEM,
  save_system: WRITE_IDEM,
  triage_finding: WRITE_IDEM,
  answer_question: WRITE_IDEM, // HITL: marca uma pergunta open→answered (idempotente por id)
  ask_question: WRITE, // HITL: empurra pergunta/diretriz de volta ao loop do agente
  set_card_route: WRITE_IDEM, // 4.2 — rota por-card (skips dispensáveis + tetos): substitui o conjunto (idempotente por args)
  set_card_links: WRITE_IDEM, // grafo tipado do card: substitui o conjunto de links (idempotente por args)
  // WS-3.2 — o par de ESCRITA dos deep reads (get_card_plan/get_card_wireframes): sem ele, a política D4
  // ("board-data do checkout runtime só via serviço") seria incumprível para sidecars. write-board por
  // classe ⇒ montada em `write`/`orch`, nunca acima disso. Substitui o arquivo inteiro ⇒ idempotente por args.
  write_sidecar: WRITE_IDEM,
  // governance (story-w9n03r)
  propose_change: WRITE, // cria um GovernanceDraft para campos owner:human (positioning/businessMetric/desiredOutcome/canvas/releases/personas)
  list_pending_changes: RO, // lista GovernanceDrafts pending (leitura)
  // (autonomo-liberdade-humana M1, 2026-07-18) DISPARA um revisor INDEPENDENTE (spawn headless bounded) para a
  // PRÓPRIA proposta pendente — não aprova nada por si só. Hint EXEC_EXT (spawna um processo); a CLASSE de guarda
  // é `peer-review` via RISK_CLASS_EXCEPTIONS. approve_change/approve_action seguem `destructive` (o proponente
  // nunca se aprova); o par é o caminho independente e fail-closed que os substitui sob o Autônomo.
  request_peer_review: EXEC_EXT,
  run_skill: EXEC_EXT, // spawns a headless `claude` that can touch the world
  enqueue: EXEC_EXT, // enqueues ONE card on the engine → spawns a headless `claude`
  enqueue_batch: EXEC_EXT, // enqueues N cards with a dependency graph → spawns headless `claude`s
  cancel_run: DESTRUCTIVE, // SIGTERM-kills a run's process (+ reaps its worktree) — não-reversível
  resolve_merge: DESTRUCTIVE, // drena/aborta head pausado da merge train — abort apaga o branch run/<id>
  // --- board destructive ---
  // (autonomo-liberdade-humana M2, 2026-07-18) delete_* seguem com o HINT `destructive` (é uma mutação
  // consequente que o cliente MCP deve tratar com cuidado), mas a CLASSE de guarda vira `reversible-delete` via
  // RISK_CLASS_EXCEPTIONS: a exclusão agora é SOFT (move para `.trash/`, GC 7d, `restore_deleted`), então o
  // Autônomo pode montá-la (mesma coreografia de `resolve_merge`: hint destrutivo, classe que reflete a verdade
  // reversível). approve_data_deletion NÃO — é wipe de banco de produção, irreversível, segue `destructive`.
  delete_card: DESTRUCTIVE,
  delete_persona: DESTRUCTIVE,
  delete_system: DESTRUCTIVE,
  restore_deleted: WRITE, // M2 — desfaz um soft-delete: rematerializa o card/persona/system da lixeira (write-board)
  discontinue_card: DESTRUCTIVE, // removes a live feature / archives
  approve_data_deletion: DESTRUCTIVE, // greenlights irreversible data deletion
  // --- dev/ops reads ---
  search_code: RO,
  read_file: RO,
  list_files: RO,
  file_tree: RO,
  git_status: RO,
  git_diff: RO,
  git_log: RO,
  git_show: RO,
  worktree_list: RO, // git worktree list + diagnóstico de órfão (merge-back travado) — story-08969p
  // WS-1 — o ciclo de vida do worktree de SESSÃO. Todas EXEC_EXT (mexem em git de verdade), montadas em
  // `orch`+ pela classe abaixo. NÃO são `run-free`: a assinatura conta a verdade — cada uma recebe um
  // sessionId/cardId e roda git PLUMBING fixo (worktree add / commit+enqueue / rebase / teardown). Não há
  // texto livre para injetar nem shell para abrir; é a mesma natureza de `enqueue`, não a de `run_task`.
  worktree_open: EXEC_EXT,
  worktree_submit: EXEC_EXT,
  worktree_refresh: EXEC_EXT,
  worktree_discard: EXEC_EXT,
  // WS-6.5 — READ-ONLY por construção: só ranqueia cards livres. A exclusão real acontece na AQUISIÇÃO do
  // claim, não aqui — se esta tool reservasse algo, seria um lock fantasma (ver suggest-work.ts).
  suggest_work: RO,
  // WS-6.2 — adoção: só ESCREVE no registro da frota (identidade/papel de um tmux que já existe). Não spawna,
  // não abre worktree, não toca código → `write-board`, não EXEC_EXT.
  adopt_session: WRITE_IDEM,
  deploy_plan: RO, // dry-run
  deploy_status: RO,
  update_status: RO,
  query_errors: RO_EXT,
  ops_health: RO_EXT,
  service_health: RO_EXT, // systemctl is-active + a node-fetch GET (never curl → WAF) — read-only
  // F3 — NÃO é readOnly, e a anotação dizia que era. A listagem carrega a reconciliação da frota
  // (renova heartbeat/claims de quem está vivo, libera os de quem morreu): um cliente que confie no
  // `readOnlyHint` para cachear ou auto-aprovar estaria cacheando uma MUTAÇÃO. O hint agora conta a
  // verdade; a CLASSE segue `read` (RISK_CLASS_EXCEPTIONS) porque a escrita é escrituração interna que
  // chamador nenhum consegue dirigir — e rebaixá-la tiraria a listagem da frota de um token `ro`, que
  // seria remoção de capacidade sem nenhum ganho de contenção.
  claude_sessions: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  wait_for_session_idle: RO, // espera bloqueante até a sessão parar de responder (poll de tela) — story-97gpdm
  claude_capture: RO,
  // M3/M6 — leitura da CONVERSA (transcript do próprio CLI) em vez da tela. Leitura pura de arquivo.
  session_read: RO,
  // M4 — o turno inteiro numa chamada (entrega + espera + lê o delta). ENTREGA TEXTO, então carrega
  // exatamente o poder de `claude_send` e recebe a mesma classe `run-free`: uma chamada = execução
  // arbitrária num pane. Compor duas capacidades numa tool não pode diluir a classe da mais perigosa.
  session_ask: EXEC_EXT,
  // --- dev exec / write ---
  run_check: WRITE_IDEM, // runs tests/build; no product mutation, repeatable
  git_commit_push: EXEC_EXT, // pushes to GitHub (resilient: reconcile+retry on non-ff)
  sync_repo: EXEC_EXT, // fetch + ff/reconcile the checkout with origin (merge, never --force)
  reconcile_stage: EXEC_EXT, // sync/reset the local stage worktree vs main (safe by default; reset guarded)
  claude_send: EXEC_EXT, // 6.5 — SESSION CONTROL: tmux send-keys into ANY session (incl. a full-perm human shell).
  claude_keys: EXEC_EXT, // idem: teclas nomeadas em QUALQUER sessão (vocabulário fechado, sem C-c/C-d/C-z)
  // NOT a benign board write — treat as exec/openWorld so the `write` level EXCLUDES it (a scoped token must
  // never drive/hijack another process). The adversarial review flagged the old `WRITE` annotation as a bypass.
  claude_new: EXEC_EXT, // spawns a claude session
  claude_recycle: EXEC_EXT, // WS-6.3 — spawns a REPLACEMENT claude session for a live agent (same shell reach)
  term_new: EXEC_EXT, // F2 — cria uma sessão tmux raw-shell (cop-*): openWorld & não-readonly → write-EXCLUÍDA
  run_task: EXEC_EXT, // spawns a headless `claude -p` that can touch the world
  // --- production / destructive ops ---
  deploy: DEPLOY,
  update_vps: DEPLOY,
  // Enfileirar uma publicação é `deploy`, não `write`: o efeito final é promote + restart do serviço. O
  // fato de acontecer DEPOIS (na janela de ociosidade) não torna a consequência menos real — classificar
  // pelo efeito, nunca pelo atraso. Idempotente por (board, sha), então DEPLOY_IDEM se existisse; como não
  // existe, DEPLOY é o conservador correto.
  publish_when_idle: DEPLOY,
  publish_status: RO,
  claude_kill: DESTRUCTIVE,
  // 6.5 — complete the map so the McpLevel filter never DEFAULT-DENIES a legit tool (an unannotated tool is
  // excluded below `full`, by design — an unclassified surface must not slip past a scoped token). None of
  // these are destructive/deploy, so all pass the `write` level.
  card_diff: RO,
  accept_triage: WRITE_IDEM, // advances a low-confidence triage card into the pipeline
  create_idea: WRITE,
  update_idea: WRITE_IDEM,
  // A escrita do Explorador. Idempotente no sentido que importa aqui: ela só ACRESCENTA (ver a tool).
  write_idea: WRITE_IDEM,
  // Os DOCUMENTOS de board (markdown como fonte da verdade). `write_doc` é WRITE_IDEM pelo mesmo motivo
  // do `write_idea`: o default é ACRESCENTAR numa seção; `replace` existe, mas é explícito na chamada.
  read_doc: RO,
  write_doc: WRITE_IDEM,
  // A escrita do Arquiteto no vocabulário. WRITE_IDEM pelo mesmo motivo dos dois acima: o default é
  // ACRESCENTAR ao prompt; `replace` existe, mas é explícito na chamada. Leitura é `get_vocabulary` (RO).
  write_vocab: WRITE_IDEM,
  generate_tasks_for_idea: EXEC_EXT, // may spawn/LLM to draft stories for an idea
  // 5.4b — HUMAN-DECISION surfaces: DESTRUCTIVE-preset so levelAllows EXCLUDES them from `write` AND `ro` (full
  // only). A scoped tick must never `propose_change` and then AUTO-APPROVE its own governance edit to board.yaml
  // (the review-flagged self-approval bypass of the HITL). The destructiveHint here encodes "human decides",
  // not "deletes data"; RISK_CLASS_EXCEPTIONS keeps their guard class cosmetic (they're full-only anyway).
  approve_change: DESTRUCTIVE, // applies a governance draft to canonical — a human-owned decision, full-only
  reject_change: DESTRUCTIVE, // discards a governance draft — a human-owned decision, full-only
  // 5.4 — the copiloto's OWN approval-grant surface (approve/reject an ApprovalRequest). Human-only, same lever.
  approve_action: DESTRUCTIVE,
  reject_action: DESTRUCTIVE,
  wait_for_approval: RO, // blocks until a pending ApprovalRequest is decided/expires (event wait, like wait_for_run)
};

// 6.5 — SERVER-SIDE McpLevel ENFORCEMENT (the containment that makes an autonomous orchestrator token safe).
// route.ts resolves the request's URL token → a McpLevel and stamps it on the server instance HERE, BEFORE the
// tools register; defineTool then SKIPS any tool the level can't mount. Keyed by the server INSTANCE (a WeakMap,
// not a module global) so two concurrent handler builds — a `full` operator token and a scoped `write`
// orchestrator token — never race on a shared level. Absent ⇒ `full` (legacy: no token enforcement, every
// existing client stays full). This is the seam ORCHESTRATOR_ENFORCEMENT.mcpTokenLevelsEnforced gates.
const SERVER_LEVEL = new WeakMap<McpServer, McpLevel>();

/** 6.5 — stamp the authority level for a server instance (route.ts calls this before register*). */
export function setServerLevel(server: McpServer, level: McpLevel): void {
  SERVER_LEVEL.set(server, level);
}

/**
 * F8 — the RISK CLASSES each authority level may MOUNT. This is the whole containment model, in one table.
 * The mount filter used to derive itself from the raw MCP hints (destructiveHint/openWorldHint); those are
 * PROTOCOL hints — too coarse to express "may drive the pipeline, may not open a shell" (both are openWorld).
 * So the dependency is inverted: the filter derives from the RISK CLASS (riskClassForTool), which is now the
 * single source of truth shared with the per-call guard. One table to read, one place to change.
 */
const LEVEL_CLASSES: Record<Exclude<McpLevel, "full">, readonly RiskClass[]> = {
  // `idea-write` é a ÚNICA escrita que um token de leitura monta (além do par ask/answer_question). Uma Ideia
  // é um rascunho FORA do pipeline — sem status, sem trigger, sem coluna: escrever nela não move entrega
  // nenhuma. É o que deixa o Explorador (mcpLevel `ro`) redigir no documento sem receber, junto, o poder de
  // mover card e triar. A contenção é estrutural: a tool recusa qualquer card que não seja `type: "idea"`.
  // `doc-write` acompanha `idea-write` pelo mesmo argumento: um DOCUMENTO de board (o Lean Canvas e os
  // próximos) vive fora do pipeline — sem status, sem trigger, sem coluna —, então escrever nele não move
  // entrega nenhuma. É o que deixa uma conversa de tela (mcpLevel `ro`) redigir numa seção sem receber,
  // junto, o poder de mover card, triar e publicar. A contenção é estrutural: a seção tem de existir no
  // schema, o rótulo travado é revalidado na gravação e o frontmatter fica fora do alcance da tool.
  ro: ["read", "idea-write", "doc-write"],
  write: ["read", "idea-write", "doc-write", "write-board"],
  // The AUTONOMOUS ORCHESTRATOR surface: everything the human clicks to move work through the board — run the
  // column's skill, cancel a hung run, unpark the merge train, publish, manage its OWN worktree, REQUEST an
  // independent peer review of its own proposal, and soft-delete board data (reversible) — and nothing else.
  // NOT `run-free` (a prompt/command with full Bash: the one call that would escape every other lock) and NOT
  // `destructive` (kill/approve/wipe: no undo). Both stay `full`-only, i.e. the operator's own token. `session`
  // (ADR-065) is here because this token is MINTED FOR the fleet: without it, the very agent the `orch` token
  // exists to serve cannot open, submit or discard its own worktree. `peer-review` and `reversible-delete`
  // (autonomo-liberdade-humana) are here for the SAME reason `deploy` is — they are bounded and recoverable: a
  // peer review APPROVES NOTHING by itself (an independent blinded spawn does, fail-closed), and a soft-delete
  // has a 7-day undo. The self-approve lock is UNCHANGED: approve_change/approve_action are `destructive`, absent.
  orch: ["read", "idea-write", "doc-write", "write-board", "reversible-delete", "run", "session", "merge-resolve", "peer-review", "deploy"],
};

/**
 * 6.5/F8 — may a tool be MOUNTED at this authority level? PURE (exported for the enforcement test).
 * - `full` → everything (the operator token).
 * - otherwise → only if the tool's RISK CLASS is in this level's set ({@link LEVEL_CLASSES}); `ro` also keeps
 *   the HITL escalation pair (ask/answer_question), so a read token can still push a question back to a human.
 * DEFAULT-DENY below `full` for an UNANNOTATED tool: an unclassified surface must never slip past a scoped
 * token (register.ts keeps the annotation map complete precisely so this never over-restricts a legit tool).
 */
export function levelAllows(level: McpLevel, name: string, ann: ToolHints | undefined): boolean {
  if (level === "full") return true;
  if (!ann) return false; // unannotated → default-deny below full
  if (level === "ro" && (name === "ask_question" || name === "answer_question")) return true;
  return LEVEL_CLASSES[level].includes(riskClassForTool(name));
}

// F5.2 — exceções NOMINAIS de classe de risco (a classe derivada dos presets não cabe). O guard por chamada
// (5.2) usa riskClassForTool p/ decidir a disposição; a completude é testada (toda tool anotada tem classe).
const RISK_CLASS_EXCEPTIONS: Record<string, RiskClass> = {
  // ADR-066 — escrever DENTRO de um documento de Ideia não é escrever no board: a Ideia vive fora do pipeline
  // (sem status, sem trigger, sem coluna). A classe própria é o que deixa o Explorador redigir com um token de
  // LEITURA, em vez de receber o `write` inteiro (mover card, triar, criar) para escrever um parágrafo.
  write_idea: "idea-write",
  // Escrever numa SEÇÃO de um documento de board — classe própria pelo mesmo motivo do `write_idea`:
  // sem ela a tool cairia no preset de escrita e exigiria o token `write` inteiro (mover card, triar,
  // criar) para acrescentar um parágrafo a um canvas.
  write_doc: "doc-write",
  // Escrever no prompt de uma PERSONA/SISTEMA. Reusa `doc-write` em vez de inventar uma classe nova
  // porque a semântica de risco é a MESMA, item por item: o artefato vive fora do pipeline (sem status,
  // sem trigger, sem coluna), a escrita não move entrega, não cruza gate e não dispara autorun, e a tool
  // é estruturalmente estreita (a linha tem de existir; nome/cor/exclusão fora do alcance). Uma 13ª
  // classe com disposição idêntica seria um segundo nome para a mesma coisa — e cada classe nova traz
  // junto a armadilha do default (`defaultDisposition`) e três `Record<RiskClass,…>` exaustivos a manter.
  // Um board que queira humano no loop declara `doc-write: ask` e a matriz vence — para os dois.
  write_vocab: "doc-write",
  // move benigno é write-board; a escalação run/deploy do ALVO (coluna) vive só no moveCardAction (moveRiskClass).
  move_card: "write-board",
  // F3 — o hint diz "não é readOnly" (é verdade: a listagem reconcilia a frota), mas a CLASSE é `read`
  // porque a escrita é escrituração interna sem canal para o chamador: não há argumento que a dirija, e
  // o que ela decide (quem está vivo) sai do tmux, não do args. Ver o comentário na anotação.
  claude_sessions: "read",

  // ── autonomo-liberdade-humana — as duas classes novas (a mesma coreografia do hint-vs-classe já usada acima) ──
  //   REVERSIBLE-DELETE (M2) — o preset DESTRUCTIVE derivaria `destructive` (never), mas a exclusão virou SOFT
  //   (move para `.trash/`, GC 7d, restore_deleted). A classe reflete a verdade reversível ⇒ montável em `orch`.
  //   O wipe de banco (approve_data_deletion) NÃO está aqui: é irreversível, segue `destructive`.
  delete_card: "reversible-delete",
  delete_persona: "reversible-delete",
  delete_system: "reversible-delete",
  //   PEER-REVIEW (M1) — o preset EXEC_EXT derivaria `run` (que pressupõe (board,cardId)→skill da coluna). Mas
  //   request_peer_review recebe um draftId e DISPARA um revisor independente da INFRA — nem é a skill da coluna
  //   nem aprova por si só. Classe própria `peer-review`: montável em `orch`, mas o que ela executa (o spawn
  //   cegado + a execução da aprovação PELA infra, fail-closed) é o cadeado, não a montagem.
  request_peer_review: "peer-review",

  // ── F8: a linha que separa "acionar o pipeline" de "abrir um shell" ──────────────────────────────────────
  // Os presets do protocolo MCP colocam TUDO isto em openWorld+exec — mas a assinatura conta a verdade:
  //
  //   PIPELINE (classe `run`) — recebe (board, cardId). Roda a skill que o BOARD registrou para a coluna ATUAL
  //   daquele card. Não há texto livre para o agente injetar: o raio de ação é o card + o pipeline do board.
  //   É, literalmente, o botão "Rodar agora" que o humano aperta o dia inteiro.
  run_skill: "run",
  enqueue: "run",
  enqueue_batch: "run",
  // cancel_run mata um run preso — o preset diz DESTRUCTIVE, mas é o CONTRÁRIO de irreversível: é como se
  // DESTRAVA um card (o run é re-enfileirável, a tool é idempotente). Um orquestrador sem isto não desatola
  // nada. Irreversível de verdade é delete_card/claude_kill, que seguem `destructive`.
  cancel_run: "run",
  //
  //   MERGE (classe `merge-resolve`) — desparqueia a train. `abort` preserva o branch como failed/run/<id>
  //   (inspecionável), então o trabalho não evapora.
  resolve_merge: "merge-resolve",
  reconcile_stage: "merge-resolve",
  //
  //   SESSÃO (classe `session`, ADR-065) — o ciclo de vida do worktree da PRÓPRIA sessão. O preset EXEC_EXT
  //   as derivava para `run`, mas a assinatura desmente: `run` é DEFINIDA como "(board, cardId) → a skill da
  //   coluna"; estas recebem um `sessionId` e board NENHUM. O guard então as recusava por falta do board que a
  //   definição da classe pressupõe — recusa que o chamador não tinha como corrigir (não existe param board),
  //   e que deixava a frota do ADR-065 sem conseguir integrar o próprio trabalho. O que elas EXECUTAM (o teste
  //   deste arquivo) é git no branch da própria sessão: não spawnam agente, não publicam, e não pulam o gate —
  //   `submit` só ENFILEIRA, e o train roda a suíte inteira antes de qualquer split.
  worktree_open: "session",
  worktree_submit: "session",
  worktree_refresh: "session",
  worktree_discard: "session",
  //
  //   LIVRE (classe `run-free`) — recebe um PROMPT ou um COMANDO e spawna `claude --dangerously-skip-permissions`
  //   (Bash pleno), ou alcança para fora do board. UMA chamada = execução arbitrária ⇒ contornaria todos os
  //   outros cadeados deste arquivo. NUNCA auto, NUNCA montada abaixo de `full`. É a fronteira.
  run_task: "run-free", // {prompt, cwd, skipPermissions:true} — o vetor canônico
  claude_new: "run-free",
  // WS-6.3 — a ASSINATURA é fechada (só um sessionId; o prompt vem do registro, não do chamador), mas o que
  // ela COLOCA no mundo é o mesmo de claude_new: um Claude interativo com Bash pleno na caixa. A fronteira
  // deste arquivo é o que a chamada EXECUTA, não quão estreito é o argumento — então `run-free`, como a irmã.
  claude_recycle: "run-free",
  claude_send: "run-free", // send-keys em QUALQUER sessão tmux, inclusive um shell humano com permissão total
  claude_keys: "run-free", // MENOS poder que claude_send (não digita texto), mesma superfície: qualquer sessão
  session_ask: "run-free", // = claude_send + espera + leitura; a composição herda a classe da parte mais perigosa
  term_new: "run-free",
  git_commit_push: "run-free",
  sync_repo: "run-free",
  generate_tasks_for_idea: "run-free",
  // update_vps deploya/reinicia o PRÓPRIO serviço em que o Jido roda (auto-cirurgia: derrubaria os runs em
  // voo e a si mesmo no meio do turno). Não é o `deploy` do app do board — esse é a tool `deploy`.
  update_vps: "run-free",

  // Superfícies de DECISÃO HUMANA (5.4b) — `destructive` é a classe HONESTA: uma aprovação é irreversível (não
  // se "des-aprova" um governance draft aplicado nem um ApprovalRequest consumido) e, sobretudo, é o cadeado que
  // impede o tick de PROPOR uma mudança e APROVAR a si mesmo. Antes eram exceções nominais `write-board`, o que
  // era inofensivo só porque o filtro de montagem olhava o destructiveHint; agora que o filtro deriva da CLASSE,
  // uma classe cosmética as MONTARIA no nível `orch` e reabriria o self-approval. A classe agora carrega o peso.
  approve_change: "destructive",
  reject_change: "destructive",
  approve_action: "destructive",
  reject_action: "destructive",
};

/** Classe de risco DERIVADA dos presets de anotação (uma fonte). Pura — exportada p/ o guard e o teste. */
function classFromHints(ann: ToolHints | undefined): RiskClass {
  if (!ann) return "write-board"; // não-anotada → conservador (o mount já é default-deny abaixo de full)
  if (ann.readOnlyHint === true) return "read"; // RO / RO_EXT
  if (ann.destructiveHint === true && ann.openWorldHint === true) return "deploy"; // DEPLOY preset
  if (ann.destructiveHint === true) return "destructive"; // DESTRUCTIVE preset
  if (ann.openWorldHint === true) return "run"; // EXEC_EXT preset (spawn/openWorld)
  return "write-board"; // WRITE / WRITE_IDEM
}

/** F5.2 — a classe de risco de UMA tool MCP: exceção nominal, senão derivada dos presets. Pura — p/ o guard. */
export function riskClassForTool(name: string): RiskClass {
  return RISK_CLASS_EXCEPTIONS[name] ?? classFromHints(TOOL_ANNOTATIONS[name]);
}

/** Nomes de todas as tools anotadas — p/ o teste de completude do guard (toda tool tem classe). */
export function annotatedToolNames(): string[] {
  return Object.keys(TOOL_ANNOTATIONS);
}

/**
 * O gêmeo de {@link defineTool} para MCP *resources* — e ele existe pelos MESMOS dois motivos.
 *
 * 1. TIPAGEM: `registerResource` também é sobrecarregado (duas assinaturas: URI string × ResourceTemplate).
 *    Passar por UMA chamada plana (o cast) mantém o tsc longe da resolução de sobrecarga em todo call
 *    site — a mesma razão escrita no cabeçalho deste arquivo, aplicada antes de o problema aparecer.
 *
 * 2. A PEGADINHA DO SDK, MEDIDA: o `contents[].uri` é OBRIGATÓRIO e o SDK **não o preenche** — o
 *    callback tem de escrevê-lo. Esquecê-lo devolve um resource que o cliente não consegue casar com o
 *    que pediu. Aqui o wrapper o preenche a partir da URI registrada, então nenhum call site pode errar.
 *    (Medido também: a chave de registro é a string CRUA, mas a busca da leitura é
 *    `new URL(uri).toString()`. Esquema custom NÃO normaliza; `http(s)://` ganha uma barra final e a
 *    leitura passa a devolver "Resource not found". Por isso o esquema aqui é `agileharness://`.)
 *
 * NÍVEL: um resource é READ-ONLY POR PROTOCOLO — não existe `resources/write`. Por isso ele monta em
 * TODO nível, inclusive `ro`: é a documentação da própria ferramenta, e negá-la a um token de leitura
 * seria remover capacidade sem ganhar contenção. O dia em que um resource devolver DADO DE BOARD (e não
 * o template/estado da instalação), esta decisão precisa ser revista — está escrito aqui para que a
 * revisão aconteça na hora certa.
 */
export function defineResource(
  server: McpServer,
  name: string,
  uri: string,
  meta: { title: string; description: string; mimeType: string },
  read: () => unknown | Promise<unknown>,
): void {
  const handler = async () => {
    const data = await read();
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return { contents: [{ uri, mimeType: meta.mimeType, text }] };
  };
  (server.registerResource as (n: string, u: string, m: unknown, h: unknown) => unknown)(name, uri, meta, handler);
}

export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  meta: { title: string; description: string; inputSchema: S },
  handler: (args: z.infer<z.ZodObject<S>>, extra?: unknown) => CallToolResult | Promise<CallToolResult>,
): void {
  const annotations = TOOL_ANNOTATIONS[name];
  // 6.5 — the single chokepoint: EVERY tool routes through here, so filtering by level here filters the whole
  // surface. A tool the level can't mount is simply never registered → the client can't even see or call it.
  if (!levelAllows(SERVER_LEVEL.get(server) ?? "full", name, annotations)) return;
  const fullMeta = annotations ? { ...meta, annotations: { title: meta.title, ...annotations } } : meta;
  // F5.2 — wrap EVERY handler with the per-call guard. `cls` is computed once at registration; guardToolCall
  // short-circuits to allow (returns null) for a `full`/internal actor BEFORE any IO, so the human/paired chat
  // pays nothing. A scoped agent's call is consulted against the board riskMatrix at CALL time (never cached):
  // null ⇒ run the real handler; a CallToolResult ⇒ the guard's own reply (pending-approval or refusal).
  const cls = riskClassForTool(name);
  const guarded = async (args: z.infer<z.ZodObject<S>>, extra?: unknown): Promise<CallToolResult> => {
    const intercept = await guardToolCall(name, cls, args);
    return intercept ?? handler(args, extra);
  };
  (server.registerTool as (n: string, m: unknown, h: unknown) => unknown)(name, fullMeta, guarded);
}
