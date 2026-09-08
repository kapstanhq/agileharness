// worktree-gc — recolhe as ÁRVORES que nenhum dono reclama mais.
//
// Medido no runtime: 11 diretórios em `.worktrees/` para 3 sessões registradas. Quatro `run-*` de runs
// headless que já terminaram, um `gate-*` (a árvore descartável do gate — que tem `cleanupGateStaging`
// em TODOS os caminhos de saída e mesmo assim sobrou, porque um kill no meio não executa `finally`), e
// um `agent-*` registrado no `.git/worktrees` sem pasta no disco.
//
// Não é só disco: cada árvore FANTASMA no registro consumia uma vaga do cap da frota, e em 2026-07-21 o
// cap ficou 4/4 com QUATRO fantasmas — a capacidade inteira travada por entradas cujas pastas já não
// existiam. O auto-cura existe hoje só dentro do `worktree_open`, isto é, só descobre o problema quem
// tenta abrir uma sessão e é recusado.
//
// ESCOPO ESTREITO E FAIL-CLOSED, de propósito. Esta varredura só toca DUAS famílias, e as duas têm dono
// determinístico e ciclo de vida curto:
//   • `gate-<runId>` — a árvore do gate, que só pode existir enquanto a entrada está ATIVA;
//   • `run-<runId>`  — a árvore de um run headless, que só pode existir enquanto o run vive ou a entrada
//                      dele está na fila.
// `agent-*` (sessão) NUNCA é tocada aqui: uma sessão fica horas ociosa entre chamadas por desenho, o
// julgamento dela é outro (heartbeat + atividade da árvore) e o teardown dela é o fail-closed que preserva
// commits. Já ceifamos árvore de agente uma vez; a lição virou regra.
//
// PURO na decisão (a parte que erra caro), IO isolado no runner.

/** Uma árvore vista no disco, já classificada pelo NOME (a única fonte que não depende de estado vivo). */
export interface WorktreeDir {
  /** o nome do diretório dentro de `.worktrees/` (ex.: `gate-abc123`, `run-abc123`) */
  name: string;
  /** caminho absoluto */
  path: string;
}

export type WorktreeGcAction =
  /** árvore do gate sem entrada ATIVA — o gate terminou (ou morreu) e a limpeza dele não rodou */
  | "orphan-gate"
  /** árvore de run sem NENHUMA entrada na fila e sem run vivo — nada vai avançá-la nem limpá-la */
  | "orphan-run"
  /**
   * DIRETÓRIO órfão: a pasta existe mas o git NÃO a conhece como worktree (o registro em
   * `.git/worktrees/<id>` já foi podado). Fora da competência desta varredura, e o rótulo existe para
   * que ela PARE de tentar — ver o incidente no doc de {@link runWorktreeGc}.
   */
  | "orphan-dir"
  /** tem dono (ou não é nossa para julgar) → fica */
  | "keep";

export interface WorktreeGcVerdict {
  name: string;
  path: string;
  action: WorktreeGcAction;
  /** por que — vai para o journal; um recolhimento sem motivo legível é indistinguível de um bug */
  reason: string;
  /** o branch que a árvore tem em check-out (`run/<id>`, `gate/<id>`), derivado do NOME. `null` fora do escopo. */
  branch: string | null;
  /**
   * O conteúdo desta árvore é RECONSTRUÍVEL a partir de outra fonte?
   *
   * É a distinção que decide o que fazer com uma árvore SUJA, e ela não é sobre confiança — é sobre onde
   * o byte existe:
   *   • `gate-<id>` é DERIVADA: o gate a monta do zero (baseline + o patch da entry) e a sujeira dela é
   *     resíduo de execução — snapshot regenerado, saída de teste. Tudo o que ela contém já existe na
   *     entry (branch + baseCommit + pinnedSha), então remover não perde nada.
   *   • `run-<id>` é ORIGINAL: o que o run escreveu e não commitou existe SÓ ali. Sem commit não há
   *     objeto, e `git fsck` não acha o que nunca virou objeto — foi exatamente assim que uma árvore de
   *     sessão levou trabalho embora (incidente 2026-07-27).
   */
  derived: boolean;
}

export interface WorktreeGcFacts {
  /** runIds com entrada ATIVA na fila (`waiting`/`gate-running`/`merging`) */
  activeRunIds: ReadonlySet<string>;
  /** runIds com QUALQUER entrada na fila (viva ou terminal) */
  allRunIds: ReadonlySet<string>;
  /** runIds com processo de run VIVO no engine */
  liveRunIds: ReadonlySet<string>;
}

/**
 * Julga UMA árvore. PURA.
 *
 * A assimetria de prova vale aqui como em toda parte deste runner: só um NÃO comprovado libera. Uma
 * árvore cujo nome não casa nenhum padrão conhecido — inclusive `agent-*` — é `keep`, sempre: não saber
 * de quem é jamais pode virar licença para apagar.
 */
export function classifyWorktree(dir: WorktreeDir, facts: WorktreeGcFacts): WorktreeGcVerdict {
  const gate = dir.name.match(/^gate-(.+)$/);
  if (gate) {
    const runId = gate[1];
    const base = { ...dir, branch: `gate/${runId}`, derived: true };
    // Só a entrada ATIVA justifica a árvore do gate: ela nasce quando o gate começa e morre com ele. Uma
    // entrada terminal/parkeada NÃO a justifica — foi exatamente esse caso que sobrou no disco.
    return facts.activeRunIds.has(runId)
      ? { ...base, action: "keep", reason: `entrada ${runId.slice(0, 8)} ATIVA — o gate pode estar rodando` }
      : { ...base, action: "orphan-gate", reason: `sem entrada ativa para ${runId.slice(0, 8)} — a limpeza do gate não rodou` };
  }
  const run = dir.name.match(/^run-(.+)$/);
  if (run) {
    const runId = run[1];
    const base = { ...dir, branch: `run/${runId}`, derived: false };
    if (facts.liveRunIds.has(runId)) return { ...base, action: "keep", reason: `run ${runId.slice(0, 8)} VIVO` };
    // `allRunIds`, não `activeRunIds`: uma entrada PARKEADA ainda pode ser retomada pelo operador, e a
    // árvore é o material de trabalho dela. Só some quando a fila não a conhece de forma nenhuma.
    if (facts.allRunIds.has(runId)) return { ...base, action: "keep", reason: `entrada ${runId.slice(0, 8)} na fila` };
    return { ...base, action: "orphan-run", reason: `nenhum run vivo e nenhuma entrada para ${runId.slice(0, 8)}` };
  }
  return {
    ...dir,
    branch: null,
    derived: false,
    action: "keep",
    reason: "não é árvore de gate nem de run — fora do escopo desta varredura",
  };
}

/** Julga todas. PURA. */
export function classifyWorktrees(dirs: readonly WorktreeDir[], facts: WorktreeGcFacts): WorktreeGcVerdict[] {
  return dirs.map((d) => classifyWorktree(d, facts));
}

export interface WorktreeGcDeps {
  /** os diretórios em `.worktrees/` */
  listDirs: () => Promise<WorktreeDir[]>;
  facts: () => Promise<WorktreeGcFacts>;
  /**
   * O git conhece este caminho como WORKTREE (está em `git worktree list`)?
   *
   * ESTA É A PRIMEIRA PERGUNTA, e ela não estava sendo feita — o que produziu um incidente real em
   * 2026-07-27 (ver {@link runWorktreeGc}). Toda a competência desta varredura pressupõe que o
   * diretório é um worktree: `isDirty` e o resgate rodam `git` DENTRO dele, e se ele não for um
   * worktree o git sobe a hierarquia e responde sobre o REPO PRINCIPAL. As respostas não ficam
   * erradas — ficam sobre outra coisa.
   * AUSENTE ⇒ assume registrado (o comportamento anterior, para o chamador que não sabe perguntar).
   */
  isRegisteredWorktree?: (path: string) => Promise<boolean>;
  /** true quando a árvore tem alteração NÃO commitada — nesse caso ela NUNCA é removida */
  isDirty: (path: string) => Promise<boolean>;
  /** `git worktree remove --force` + `git worktree prune`; devolve se saiu mesmo */
  remove: (path: string) => Promise<boolean>;
  /**
   * COMMITA o que estiver sujo na árvore ANTES de removê-la, preservando o branch (`rescueUncommitted`,
   * worktree.ts). É o que transforma "suja ⇒ intocável para sempre" em "suja ⇒ salva e recolhida".
   *
   * LANÇA quando o commit de resgate falha (ex.: o secret-scan acusou algo) — e essa exceção é a
   * garantia, não um acidente: a árvore é a única cópia daquele byte, então não conseguir salvá-la
   * PROÍBE removê-la. O chamador trata como "preservada".
   * AUSENTE ⇒ nenhum resgate; uma árvore original suja simplesmente fica (o comportamento anterior).
   */
  rescue?: (path: string, branch: string) => Promise<{ rescued: boolean }>;
  /** registra o que foi feito (journal em prod, coletor em teste) */
  journal?: (v: WorktreeGcVerdict & { removed: boolean; rescued?: boolean }) => void | Promise<void>;
  /**
   * Os nomes já registrados NESTE processo. Uma árvore que FICA fica pela vida inteira dela, e o tick
   * roda a cada 2 minutos: sem isto, uma única árvore órfã suja produz ~720 linhas idênticas por dia.
   * É o mesmo problema (e a mesma cura) do `advisedThisRun` do branch-GC, que nasceu de 2480 linhas
   * duplicadas. Só as linhas SEM ação são dedupadas — remoção e resgate são eventos e sempre falam.
   */
  journaledThisRun?: Set<string>;
  /** true ⇒ só observa (o padrão de estreia de toda capacidade destrutiva aqui) */
  dryRun?: boolean;
}

export interface WorktreeGcResult {
  scanned: number;
  removed: number;
  /** árvores ORIGINAIS sujas cujo trabalho foi commitado antes da remoção */
  rescued: number;
  /** árvores preservadas por não ter sido possível salvar o que havia nelas */
  keptDirty: number;
  /** pastas que o git não conhece como worktree — deixadas para um humano, nunca tocadas */
  orphanDirs: number;
}

/**
 * Recolhe as árvores órfãs. Best-effort por contrato: uma falha em qualquer árvore não impede as outras
 * e nunca lança — esta varredura roda dentro do tick de manutenção, e derrubá-lo custaria mais que o
 * disco que ela libera.
 *
 * A trava final é a SUJEIRA: uma árvore com trabalho não commitado NUNCA é removida, mesmo julgada órfã.
 * Órfã diz "ninguém vai avançar isto"; suja diz "há bytes que só existem aqui". A segunda vence.
 *
 * ── INCIDENTE 2026-07-27 — POR QUE A PRIMEIRA PERGUNTA É "ISTO É UM WORKTREE?" ────────────────────
 *
 * A primeira versão desta varredura presumiu que "pasta em `.worktrees/`" == "worktree". As quatro
 * pastas `run-*` do runtime NÃO eram: o registro delas em `.git/worktrees/<id>` já tinha sido podado,
 * então sobraram DIRETÓRIOS simples. E como eles ficam DENTRO do repo, todo `git -C <pasta> …` sobe a
 * hierarquia e responde sobre o REPO PRINCIPAL.
 *
 * O estrago foi exatamente esse deslocamento de sujeito: o resgate rodou `commitAllPending` numa pasta
 * que não era worktree, o git subiu, e o commit — com uma mensagem que promete o branch
 * `failed/run/<id>` — caiu em `main`, carregando a sujeira do checkout de runtime. Nada se perdeu, mas
 * o histórico ganhou um commit que afirma algo falso, e o log da varredura anunciou "trabalho SALVO"
 * com toda a confiança. Medir uma coisa e agir sobre outra: a mesma classe de defeito que este runner
 * documenta em meia dúzia de lugares, cometida aqui.
 *
 * Daí a ordem ser inegociável: **registrado?** → suja? → derivada? Uma pasta não registrada é
 * `orphan-dir` e a varredura NÃO A TOCA: não mede, não resgata, não remove. Removê-la exigiria `rm -rf`
 * (o git recusa: "is not a working tree"), e apagar por fs uma pasta cujo conteúdo o git nunca viu é
 * destruir a única cópia sem nenhuma prova — precisamente o que esta varredura existe para não fazer.
 * Ela é registrada UMA vez e fica para um humano.
 */
export async function runWorktreeGc(deps: WorktreeGcDeps): Promise<WorktreeGcResult> {
  const out: WorktreeGcResult = { scanned: 0, removed: 0, rescued: 0, keptDirty: 0, orphanDirs: 0 };
  const journaled = deps.journaledThisRun ?? new Set<string>();
  let dirs: WorktreeDir[];
  let facts: WorktreeGcFacts;
  try {
    [dirs, facts] = await Promise.all([deps.listDirs(), deps.facts()]);
  } catch {
    return out; // não consegui olhar ⇒ não removo nada (jamais o contrário)
  }
  out.scanned = dirs.length;
  /** Uma linha SEM ação (a árvore ficou) fala UMA vez por processo; um evento fala sempre. */
  const record = async (v: WorktreeGcVerdict & { removed: boolean; rescued?: boolean }): Promise<void> => {
    const isEvent = v.removed || v.rescued;
    if (!isEvent) {
      if (journaled.has(v.name)) return;
      journaled.add(v.name);
    }
    await deps.journal?.(v);
  };

  for (const verdict of classifyWorktrees(dirs, facts)) {
    if (verdict.action === "keep") continue;
    // A PRIMEIRA pergunta (ver o incidente no doc acima). Erro de leitura ⇒ trata como NÃO registrado:
    // "não consegui confirmar que é um worktree" jamais pode autorizar rodar git dentro dele.
    if (deps.isRegisteredWorktree && !(await deps.isRegisteredWorktree(verdict.path).catch(() => false))) {
      out.orphanDirs += 1;
      await record({
        ...verdict,
        action: "orphan-dir",
        removed: false,
        reason:
          `${verdict.reason} — MAS o git não a conhece como worktree (registro já podado): é um DIRETÓRIO órfão. ` +
          `Nada é medido, resgatado ou removido aqui — git recusaria, e apagar por fs seria destruir a única ` +
          `cópia sem prova. Decida à mão: rm -rf ${verdict.path}`,
      });
      continue;
    }
    let removed = false;
    let rescued = false;
    try {
      // Erro de leitura conta como SUJA: "não consegui olhar" nunca pode virar "está limpa".
      const dirty = await deps.isDirty(verdict.path).catch(() => true);
      if (dirty && !verdict.derived) {
        // ÁRVORE ORIGINAL SUJA — o byte só existe aqui. Salvar ANTES de remover (commit + branch
        // preservado) é o que impede que "recolher lixo" vire "levar trabalho embora"; e se não der
        // para salvar, não se remove. Sem a dep de resgate, o comportamento antigo: fica.
        if (!deps.rescue) {
          out.keptDirty += 1;
          await record({ ...verdict, removed: false, reason: `${verdict.reason} — árvore SUJA e sem resgate configurado: preservada` });
          continue;
        }
        ({ rescued } = await deps.rescue(verdict.path, verdict.branch ?? ""));
      }
      // Uma árvore DERIVADA suja é removida assim mesmo: a sujeira dela é resíduo de execução, e tudo o
      // que ela continha é reconstruível da entry (ver `derived`). Preservá-la seria guardar lixo com a
      // cerimônia reservada a trabalho.
      if (!deps.dryRun) removed = await deps.remove(verdict.path);
    } catch (err) {
      // O resgate que FALHA (secret-scan, git travado) lança de propósito: a árvore vira intocável.
      out.keptDirty += 1;
      await record({
        ...verdict,
        removed: false,
        reason: `${verdict.reason} — RESGATE FALHOU (${err instanceof Error ? err.message : String(err)}): preservada, é a única cópia`,
      });
      continue;
    }
    if (removed) out.removed += 1;
    if (rescued) out.rescued += 1;
    await record({
      ...verdict,
      removed,
      rescued,
      reason: rescued ? `${verdict.reason} — trabalho não-commitado SALVO no branch antes da remoção` : verdict.reason,
    });
  }
  return out;
}
