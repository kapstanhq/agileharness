// O ESCOPO de uma chamada de tool: a pergunta "de QUEM é a governança desta ação?", respondida ANTES de
// qualquer decisão do guard (mcp/guard.ts). Existe porque a resposta tem TRÊS valores, e o guard tratava só dois.
//
// O DEFEITO que originou este arquivo (3ª ocorrência da mesma forma no subsistema — ver as duas anteriores no
// doc-comment de `runner/flags.ts` e no guard de max-turns em `runner/engine.ts`): o guard derivava o board por
// HEURÍSTICA sobre nomes de argumento (`board` | `sessionId` | `runId`) e, quando não achava, RECUSAVA com
// "Refaça com o board". Para uma tool cujo schema não TEM um parâmetro de board, esse conselho é impossível de
// seguir — a capacidade existia, era anunciada, e era estruturalmente inalcançável. Medido: de 94 tools
// registradas, 11 gated não expõem nenhuma chave de escopo; `reconcile_stage` (a cura do stage defasado, que é
// justamente o que destrava um release preso) era uma delas, então o tick autônomo nunca conseguia se
// desatolar sozinho — e a matriz de risco DO BOARD nem chegava a ser lida (sem board, `dispositionFor` cai em
// `defaultDisposition`, então um `merge-resolve: auto` declarado no board.yaml era silenciosamente ignorado).
//
// A CURA é declarar em vez de adivinhar. Toda tool gated cai em exatamente um dos três escopos abaixo, e
// `scope.test.ts` prova por EXAUSTIVIDADE que nenhuma tool nova escapa da classificação — um `defineTool` novo
// que não exponha chave de escopo nem seja declarado aqui REPROVA a suíte. É o mesmo padrão de chokepoint +
// teste de exaustividade que fechou a contenção de MCP: contenção que cada site precisa LEMBRAR de optar é
// contenção que o próximo site vai esquecer.

/** De quem é a governança de uma chamada. */
export type ToolScope =
  /** de um BOARD — a matriz de risco dele decide, e uma aprovação cai no Inbox dele. */
  | { kind: "board"; board: string }
  /** do REPO/serviço (a branch `stage`, a suíte, o systemd) — nenhum board é dono; decide `settings.yaml`. */
  | { kind: "repo" }
  /** board-scoped mas SEM board na chamada — o único caso em que "refaça com o board" é conselho seguível. */
  | { kind: "unscoped" };

/**
 * As tools cuja ação é do REPO, não de um board. Declarar aqui não afrouxa nada: a disposição continua vindo de
 * uma matriz (agora a de `settings.yaml orchestrator.riskMatrix`) e o clamp de `NEVER_AUTO_RISK_CLASSES`
 * continua valendo — `run-free`/`destructive` seguem humano-only por construção, esteja o que estiver escrito
 * em qualquer matriz. O que muda é só ONDE a pergunta é feita, e que a recusa passa a dar um conselho seguível.
 *
 * O critério é o ALVO da ação, não o risco dela: `reconcile_stage` mexe na branch `stage` (uma só no repo),
 * `run_check` roda a suíte do repo, `update_vps` reinicia o serviço, `deploy` publica um PACOTE (`pkg`), e as
 * de shell/sessão (`run_task`, `term_new`, `claude_*`) alcançam a caixa inteira. Nenhuma delas tem um board
 * dono — nem hipoteticamente.
 */
export const REPO_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  // REGISTRAR UM BOARD é criar um NAMESPACE no diretório de dados — não há board dono, nem
  // hipoteticamente (o board só passa a existir DEPOIS da chamada). Sem esta linha, a tool cairia em
  // `unscoped` e seria recusada com "nomeie o board", que é o conselho impossível de seguir que este
  // arquivo existe para eliminar — e se ela nomeasse o parâmetro `board`, seria pior: o guard leria a
  // matriz de um board inexistente, cairia em `ask` e abriria uma aprovação dentro de um diretório que
  // `listBoards` pula, invisível em qualquer Inbox. Aqui a recusa sob token escopado nomeia a alavanca
  // real (`settings.yaml → orchestrator.riskMatrix.write-board`).
  "register_board",
  "reconcile_stage", // a branch `stage` é UMA no repo (o worktree interno do merge train)
  "run_check", // roda a suíte/build do repo
  "deploy", // publica um PACOTE (`pkg`), não um board
  "update_vps", // auto-cirurgia: rebuild + restart do próprio serviço
  "git_commit_push", // commita/pusha o checkout
  "sync_repo", // fetch + ff/reconcile do checkout
  "claude_send", // send-keys em QUALQUER sessão tmux da caixa
  "claude_keys", // idem: teclas nomeadas em QUALQUER sessão tmux da caixa
  "session_ask", // idem — entrega texto num pane e espera a resposta; o alvo é a caixa, não um board
  "claude_kill", // mata um processo da caixa
  "term_new", // abre um shell na caixa
  "run_task", // spawna um `claude` com Bash pleno na caixa
]);

/** As chaves de argumento das quais um board é derivável — a heurística, agora com um nome e um teste. */
export const SCOPE_ARG_KEYS = ["board", "sessionId", "runId"] as const;

function str(o: unknown, key: string): string | undefined {
  const v = (o as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * O board de um LOTE (`enqueue_batch({cards:[{board,cardId}]})`) — o escopo está no args, só que ANINHADO um
 * nível, e a heurística de chave de topo não o via. Um lote de um board só → esse board. Um lote que CRUZA
 * boards não tem um dono único: devolve undefined (→ `unscoped`), e aí "refaça com o board" volta a ser um
 * conselho honesto (o chamador divide o lote por board).
 */
function boardOfNested(args: unknown): string | undefined {
  const cards = (args as Record<string, unknown> | null | undefined)?.cards;
  if (!Array.isArray(cards) || cards.length === 0) return undefined;
  const boards = new Set<string>();
  for (const c of cards) {
    const b = str(c, "board");
    if (!b) return undefined; // um card sem board ⇒ o lote não é atribuível com segurança
    boards.add(b);
  }
  return boards.size === 1 ? [...boards][0] : undefined;
}

/**
 * O escopo de uma chamada. Precedência: args explícito → identidade que o args CARREGA (sessão/train) → args
 * aninhado (lote) → declaração de repo → `unscoped`.
 *
 * Best-effort e NUNCA lança: uma falha de leitura do registro degrada para "sem board" no caminho quente, e o
 * guard trata `unscoped` de forma conservadora (recusa). Uma sessão SEM board é LEGÍTIMA (ADR-065 admite
 * trabalho `kind: session` sem card), então "não achei" é uma resposta, não um erro.
 */
export async function resolveToolScope(name: string, args: unknown): Promise<ToolScope> {
  const direct = str(args, "board");
  if (direct) return { kind: "board", board: direct };

  const sessionId = str(args, "sessionId");
  if (sessionId) {
    try {
      const { makeSessionStore } = await import("@/lib/storymap/runner/session-worktree");
      const s = (await makeSessionStore().load()).find((x) => x.sessionId === sessionId);
      const b = s?.board?.trim();
      if (b) return { kind: "board", board: b };
    } catch {
      /* degrada para unscoped */
    }
    return { kind: "unscoped" };
  }

  const runId = str(args, "runId");
  if (runId) {
    try {
      const { getMergeQueue } = await import("@/lib/storymap/runner/merge-queue");
      const e = getMergeQueue()
        .getSnapshot()
        .entries.find((x) => x.runId === runId);
      const b = e?.board?.trim();
      if (b) return { kind: "board", board: b };
    } catch {
      /* degrada para unscoped */
    }
    return { kind: "unscoped" };
  }

  const nested = boardOfNested(args);
  if (nested) return { kind: "board", board: nested };

  if (REPO_SCOPED_TOOLS.has(name)) return { kind: "repo" };
  return { kind: "unscoped" };
}
