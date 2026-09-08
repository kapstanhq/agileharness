// A sonda de trabalho VIVO que a publicação consulta antes de promover (release.ts `concurrentWork`).
//
// O deploy não fazia parte do pipeline serializado do merge nem tinha guarda de concorrência real. A
// promoção aplica um patch na MESMA árvore de trabalho de `main` que o merge train mexe — a corrida de
// `.git/index.lock` já era coberta pelo `serialCommit` (#37), mas a corrida SEMÂNTICA não: publicar um
// arquivo que outra sessão está reescrevendo naquele instante. A mitigação em uso era humana — uma nota
// de embargo escrita à mão num card — e uma nota só protege o card em que alguém lembrou de escrever.
//
// Esta sonda responde a pergunta certa: QUEM está vivo e em QUAIS arquivos. A decisão de segurar (e a
// interseção com o que a promoção carrega) é de `promoteStageToMain` — aqui é só o informante.
//
// Pura sobre `exec` (como release.ts e a merge queue), então é testável sem runtime nenhum.

import type { ExecFn } from "./worktree";
import type { AgentSession } from "./session-worktree";

/** Um dono de trabalho vivo e os arquivos que ele está tocando agora. */
export interface LiveWork {
  /** quem é — o branch da sessão ou o runId da entrada; precisa ser nomeável para o operador agir */
  owner: string;
  files: string[];
}

/** Uma entrada da fila do train, reduzida ao que a sonda precisa. */
export interface QueuedWork {
  runId: string;
  branch: string;
  baseCommit?: string;
}

const lines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);

/**
 * O sha desta sessão que o train JÁ INTEGROU — a FRONTEIRA de integração dela. Vem do `pinnedSha` da
 * entrada `done` mais recente daquela sessão na merge queue (o chamador projeta o snapshot; este módulo
 * segue sem conhecer o train).
 *
 * É o dado que faltava, e a falta dele custou caro (ver o doc de {@link liveWorkInRepo.integrationRef}).
 * O train PINA o sha no submit e carimba `done` quando ele aterrissa: logo, "o que esta sessão commitou e
 * ainda não integrou" é exatamente `integratedSha..branch` — uma verdade LOCAL à sessão, imune ao que
 * qualquer outra faça com os mesmos arquivos.
 */
export type IntegratedShas = ReadonlyMap<string, string>;

/** O mínimo de uma entrada do train que a fronteira de integração precisa (shape ESTRUTURAL de propósito:
 *  este módulo não importa o train, do mesmo jeito que não importa a sessão inteira). */
export interface IntegratedEntry {
  runId: string;
  status: string;
  pinnedSha?: string;
  mergeEndedAt?: number;
  enqueuedAt?: number;
}

/**
 * PURA — projeta as entradas do train na fronteira de integração de cada sessão: `runId` → o `pinnedSha`
 * da entrada `done` MAIS RECENTE dela. Uma sessão submete várias vezes ao longo da vida; só a última
 * aterrissagem define o que ainda é pendência.
 *
 * Só `done` conta. Uma entrada em voo (`waiting`/`merging`/`gate-running`) ainda não aterrissou nada, e
 * uma que falhou/voltou para a sessão aterrissou MENOS ainda — tratar qualquer uma delas como fronteira
 * apagaria da sonda trabalho que de fato está pendente, que é o erro caro (esta guarda pode adiar uma
 * publicação sem estrago, mas não pode deixar passar uma sobreposição real).
 */
export function integratedShas(entries: readonly IntegratedEntry[]): IntegratedShas {
  const out = new Map<string, { sha: string; at: number }>();
  for (const e of entries) {
    if (e.status !== "done" || !e.pinnedSha) continue;
    const at = e.mergeEndedAt ?? e.enqueuedAt ?? 0;
    const prev = out.get(e.runId);
    if (!prev || at >= prev.at) out.set(e.runId, { sha: e.pinnedSha, at });
  }
  return new Map([...out].map(([id, v]) => [id, v.sha]));
}

/**
 * A base para medir o trabalho COMMITADO ainda não integrado de uma sessão.
 *
 * Prefere a fronteira de integração (`integratedSha`), e só a aceita quando ela é ANCESTRAL do branch —
 * `worktree_refresh` rebasa o branch sobre uma base nova, e depois disso o sha pinado antigo pertence a
 * outra história: `git diff <pinado>..<branch>` devolveria o mundo inteiro. Sem ancestralidade comprovada
 * cai para a base de abertura, que é conservadora (reporta DE MAIS) — a direção segura numa sonda de
 * segurança, onde reportar de menos é o defeito grave.
 */
async function committedWorkBase(
  exec: ExecFn,
  repoRoot: string,
  session: { sessionId: string; agentId?: string; branch: string; baseCommit: string },
  integrated?: IntegratedShas,
): Promise<string> {
  const sha = integrated?.get(session.sessionId) ?? (session.agentId ? integrated?.get(session.agentId) : undefined);
  if (!sha) return session.baseCommit;
  try {
    await exec(`git merge-base --is-ancestor ${JSON.stringify(sha)} ${JSON.stringify(session.branch)}`, {
      cwd: repoRoot,
    });
    return sha; // exit 0 ⇒ o sha integrado está na história deste branch: mede a partir dele
  } catch {
    return session.baseCommit; // rebase/ref sumida ⇒ conservador
  }
}

/**
 * Arquivos que um branch mudou desde a base dele. Best-effort: um branch/base que sumiu (sessão
 * descartada no meio, ref colhida) devolve VAZIO em vez de explodir — uma sonda que derruba a publicação
 * ao falhar seria pior que a ausência dela, porque transformaria diagnóstico em indisponibilidade.
 */
async function branchFiles(exec: ExecFn, repoRoot: string, base: string, branch: string): Promise<string[]> {
  try {
    // `--no-renames` porque esta é uma sonda de SEGURANÇA e o rename cria um falso NEGATIVO: com a
    // detecção ligada (o default), o `--name-only` de um `git mv` lista só o caminho NOVO, e o ANTIGO —
    // que a sessão está removendo — some do relatório. A promoção então não vê colisão nenhuma e aplica
    // por cima do arquivo que a outra sessão está apagando. É o mesmo defeito que já mordeu o merge train
    // (Pilotagem→Inbox) e o release (2026-07-27); aqui ele não duplica arquivo, ele CALA a guarda.
    const r = await exec(`git diff --name-only --no-renames ${JSON.stringify(base)}..${JSON.stringify(branch)}`, {
      cwd: repoRoot,
    });
    return lines(r.stdout);
  } catch {
    return [];
  }
}

/**
 * Arquivos SUJOS na árvore da sessão — o caso que mais importa para o embargo e o que um diff de branch
 * NÃO vê: a outra sessão está no meio da reescrita e ainda não commitou nada. `--porcelain` emite
 * `XY <path>` (e `XY <old> -> <new>` num rename).
 *
 * Num rename reportamos AS DUAS pontas, não só o destino. O caminho ANTIGO está sendo REMOVIDO por
 * aquela sessão: uma promoção que o toque colide de verdade — só que, contando apenas o destino, a
 * guarda diria "sem colisão" e deixaria passar. Mesma classe do `--no-renames` acima, mesma direção de
 * erro a evitar: numa sonda de segurança, reportar de menos é o defeito grave; reportar de mais só adia.
 */
async function dirtyFiles(exec: ExecFn, worktreePath: string): Promise<string[]> {
  try {
    const r = await exec(`git status --porcelain`, { cwd: worktreePath });
    return lines(r.stdout).flatMap((l) => {
      const p = l.slice(2).trim();
      const arrow = p.indexOf(" -> ");
      if (arrow < 0) return [p];
      const origem = p.slice(0, arrow).trim();
      const destino = p.slice(arrow + 4).trim();
      // `git status` cita caminhos com espaço/aspas — tira as aspas externas para casar com o pathspec.
      const limpo = (x: string) => (x.startsWith('"') && x.endsWith('"') ? x.slice(1, -1) : x);
      return [limpo(origem), limpo(destino)].filter(Boolean);
    });
  } catch {
    return [];
  }
}

/**
 * Todo o trabalho vivo do repositório, por dono. Junta as DUAS fontes, que não se substituem:
 *   - sessões abertas: o que já commitaram no branch delas MAIS o que está sujo na árvore (não-commitado);
 *   - entradas na fila do train: o que está a caminho de integrar.
 *
 * `excludeSessionId` tira a própria sessão que está publicando — senão toda publicação feita de dentro de
 * uma sessão se auto-bloquearia, e a guarda viraria uma trava permanente em vez de uma proteção.
 */
export async function liveWorkInRepo(deps: {
  exec: ExecFn;
  repoRoot: string;
  sessions: AgentSession[];
  queued: QueuedWork[];
  excludeSessionId?: string;
  /**
   * O HEAD do que JÁ está integrado — o branch/sha de `stage` de onde a promoção parte. Usado como
   * ESTREITAMENTO POR CONTEÚDO: um arquivo cujo conteúdo no branch é IDÊNTICO ao do stage não pode ser
   * trabalho pendente, então sai da lista. Só REMOVE candidatos; nunca adiciona.
   *
   * ⚠️ SOZINHO ELE NÃO BASTA — e a versão anterior deste módulo apostava que sim. O comentário que estava
   * aqui afirmava que "um arquivo em que a sessão só está ATRÁS do stage também some, pois não está no
   * diff-desde-a-base dela". Isso vale quando duas sessões tocam arquivos DISJUNTOS, e é falso exatamente
   * no caso em que o embargo existe para agir: se A e B mudam o MESMO arquivo, o arquivo está no
   * diff-desde-a-base de A **e** diverge do stage (que já carrega o trabalho posterior de B) — a
   * interseção nunca esvazia. O embargo então TRAVA PARA SEMPRE por trabalho que já integrou: medido em
   * 2026-07-28, a sessão cd59d760 (entrada `done`, árvore limpa) segurou a publicação da 266d933b por 33
   * tentativas, e 11 dos 15 pedidos segurados do histórico morreram `superseded` sem nunca publicar.
   *
   * O termo que decide hoje é {@link liveWorkInRepo.integrated}, medido a partir da FRONTEIRA DE
   * INTEGRAÇÃO da própria sessão — verdade local, imune ao que os outros fizerem no mesmo arquivo. Este
   * `integrationRef` permanece porque cobre um caso que a fronteira não vê: código que chegou ao stage
   * por FORA do train (um cherry-pick de resgate, por exemplo) e que, sendo idêntico, também não é
   * pendência. Ausente ⇒ sem o estreitamento, fail-safe (reporta de mais).
   *
   * O trabalho SUJO (não-commitado) segue reportado SEMPRE, sem passar por nenhum destes filtros: é o caso
   * mais forte do embargo e não aparece em diff de branch nenhum.
   */
  integrationRef?: string;
  /**
   * sessionId (ou agentId) → o sha que o train já INTEGROU daquela sessão. Ver {@link IntegratedShas}.
   * Ausente ⇒ mede da base de abertura, o comportamento conservador.
   */
  integrated?: IntegratedShas;
  /**
   * board → prefixo do pacote dele (ex.: `acme` → `packages/acmeapp/`). Usado SÓ para a sessão ADOTADA,
   * que não tem árvore para medir. Injetado para este módulo não conhecer a topologia de boards.
   */
  boardPackage?: (board: string) => string | undefined;
}): Promise<LiveWork[]> {
  const { exec, repoRoot, sessions, queued, excludeSessionId, integrationRef, integrated, boardPackage } = deps;
  const out: LiveWork[] = [];

  for (const s of sessions) {
    if (s.sessionId === excludeSessionId || s.agentId === excludeSessionId) continue;
    // Sessão ADOTADA (WS-6.2): tem visibilidade e claims mas NENHUMA árvore isolada — não há diff nem
    // status para ler, então os arquivos dela são IMENSURÁVEIS. Omiti-la reportaria "nada concorrente"
    // para trabalho que existe, que é pior que não ter guarda: dá falsa garantia exatamente no caso em
    // que alguém está editando sem isolamento. O que ela DECLARA é o board; então o pacote daquele board
    // conta como ocupado — conservador, mas LIMITADO (uma sessão adotada no acme não segura o storymap).
    // Some sozinho conforme o modo adotado é extinto: sem sessão adotada viva, isto nunca dispara.
    if (s.adopted) {
      const pkg = s.board ? boardPackage?.(s.board) : undefined;
      if (pkg) out.push({ owner: `sessão adotada ${s.sessionId.slice(0, 8)} (board ${s.board}, sem árvore isolada)`, files: [pkg] });
      continue;
    }
    const files = new Set<string>();
    if (s.branch && s.baseCommit) {
      // TERMO PRINCIPAL — o que esta sessão commitou DEPOIS da própria fronteira de integração. É uma
      // medida LOCAL: nada do que outra sessão faça nos mesmos arquivos entra nela, e é por isso que ela
      // não latcha (ver o histórico em `integrationRef`). Sessão que submeteu tudo ⇒ conjunto VAZIO.
      const from = await committedWorkBase(
        exec,
        repoRoot,
        { sessionId: s.sessionId, agentId: s.agentId, branch: s.branch, baseCommit: s.baseCommit },
        integrated,
      );
      const pendingSinceIntegration = await branchFiles(exec, repoRoot, from, s.branch);
      if (integrationRef && pendingSinceIntegration.length > 0) {
        // ESTREITAMENTO por conteúdo: quem já é idêntico ao stage (chegou lá por fora do train) não é
        // pendência. Só remove — nunca acrescenta.
        const divergentFromStage = new Set(await branchFiles(exec, repoRoot, integrationRef, s.branch));
        for (const f of pendingSinceIntegration) if (divergentFromStage.has(f)) files.add(f);
      } else {
        for (const f of pendingSinceIntegration) files.add(f);
      }
    }
    if (s.worktreePath) {
      // Sujo (não-commitado) SEMPRE conta: é in-flight de verdade e não aparece em diff de branch nenhum.
      for (const f of await dirtyFiles(exec, s.worktreePath)) files.add(f);
    }
    if (files.size > 0) out.push({ owner: s.branch ?? s.sessionId, files: [...files] });
  }

  for (const q of queued) {
    if (q.runId === excludeSessionId) continue;
    // Sem baseCommit não dá para medir o delta desta entrada. Reportar o branch inteiro seria pior que
    // nada: inflaria a colisão e seguraria publicações sem sobreposição real (a guarda intersecta, mas a
    // MENSAGEM ao operador citaria arquivos que ninguém está mexendo).
    if (!q.baseCommit) continue;
    const files = await branchFiles(exec, repoRoot, q.baseCommit, q.branch);
    if (files.length > 0) out.push({ owner: `fila:${q.runId}`, files });
  }

  return out;
}
