// Check: block-runtime-board-writes — WS-3.1 (plano storymap-parallel-work, decisão D4).
//
// O QUE FECHA: a metade CROSS-PROCESSO da colisão #2 (2026-07-16, <board>/<card>: dois
// blockers `code-not-landed-*` fechados via triage_finding reabriram sozinhos). O lock de
// `write.ts` (withKeyedLock/updateCardOnDisk) é IN-PROCESS: ele serializa o serviço consigo
// mesmo, e nada mais. Uma sessão de agente que edita `storymap/boards/**` do MESMO checkout
// por fs direto não passa por lock nenhum — é last-writer-wins contra o serviço. Com N
// sessões, é questão de tempo.
//
// A REGRA (D4): o checkout que roda o SERVIÇO tem UM escritor de board-data: o serviço.
// Agentes mutam card/sidecar de lá SÓ pelas superfícies do serviço (MCP/server actions), que
// serializam. Escrita direta de agente ⇒ recusada aqui.
//
// ── QUANDO ESTE HOOK AGE (e por que é quase sempre NO-OP) ───────────────────────────────────
//
// 1. SÓ com serviço VIVO. A detecção do "checkout do serviço" é a presença de
//    `storymap/.runner/service.lock` (escrito no boot por src/instrumentation.ts) COM pid vivo.
//    Sem lock (notebook, dev local, worktree de run/sessão) ⇒ NO-OP: zero atrito.
//    Lock com pid MORTO (crash) ⇒ NO-OP + warning. Isso É o caso de EMERGÊNCIA by design: com o
//    serviço fora do ar não há lock in-process para respeitar, e o Operador precisa editar o
//    card na mão. Serviço morto ⇒ edição manual livre.
// 2. SÓ `storymap/boards/**` daquele checkout. Código, docs, .artifacts — nada disso é board-data.
// 3. NUNCA um run sancionado do engine (G3 — o furo mais perigoso do plano). A lane light INTEIRA
//    (`isCode:false`: harness-capture/style/enrich/grill/interview/tasks/prioritize/plan/ux/ui — ~93%
//    dos runs) roda SEM worktree e edita o checkout runtime POR DESIGN (o settle commita via
//    `commitBoardDataScoped`, worktree.ts:372-399). Um hook que bloqueasse todo processo
//    não-serviço QUEBRARIA o autorun light inteiro. O marcador de isenção é
//    `STORYMAP_AUTORUN_RUN_ID`, que o engine já injeta no env de TODO spawn de run
//    (engine.ts, junto de STORYMAP_AUTORUN_TRIGGER) — o mesmo vetor que o
//    guard-business-intent usa para discriminar run de humano. Uma sessão de agente (tmux,
//    copiloto, spawn interativo) NÃO tem o marcador ⇒ é bloqueada ⇒ usa MCP.
//    Verificado (2026-07-16): engine.ts tem UM ÚNICO spawn de run e o marcador é setado nele
//    INCONDICIONALMENTE — o `isCode` decide só o cwd (worktree ou não), nunca o env. As duas lanes
//    carregam o marcador. engine.test.ts ("injects STORYMAP_AUTORUN_RUN_ID…", story-ns8x0o) já é a
//    guarda de regressão desse vetor.
//    ⚠️ Renomear/remover esse env em engine.ts DESLIGA a isenção e quebra a lane light.
//
// ── LACRE DO `<repo>-stage` (WS-1.6/G1) — NASCE DESLIGADO ───────────────────────────────────
//
// `<repo>-stage` NÃO é "um worktree de self-dev": é o worktree INTERNO e
// PERSISTENTE do merge train (`stageWorktreePath()` = irmão `<repo>-<branch>`,
// merge-queue.ts:461-466, "long-lived, never reaped") — é ONDE o split aplica o código em
// `stage`. Ele NUNCA pode ser removido; o que morre é o USO dele como superfície de EDIÇÃO.
// Ligar o lacre é uma MIGRAÇÃO (WS-9.4) e pede aval do Operador — enquanto ele estiver
// desligado, este bloco é inerte.
//   BOTÃO (ligar):    touch <repo>/storymap/.runner/stage-seal.on
//   BOTÃO (desligar): rm    <repo>/storymap/.runner/stage-seal.on
// O flag mora ao lado do service.lock, NO CHECKOUT DO SERVIÇO (é ele quem define quem é o
// train). Ausente ⇒ desligado (fail-open, como todo este hook).
//
// ── RISCO RESIDUAL QUE ESTE HOOK **NÃO** FECHA (3.4 — honestidade > promessa) ────────────────
//
// - **serviço ↔ run-light concorrentes no MESMO card**: o run light é ISENTO (item 3) e edita o
//   card do checkout runtime por Write/Edit enquanto o serviço/copiloto/humano pode escrever o
//   mesmo card via `updateCardOnDisk`. Isso continua LAST-WRITER-WINS de arquivo. Mitigação (não
//   eliminação): 1 run por card (invariante do engine) + o claim que o engine detém durante
//   QUALQUER run (WS-4.2, ainda NÃO existe quando este hook nasceu) fazem copiloto/steward/
//   MCP-agente não escreverem em card com run em voo; `statusBy/At` (WS-2.3) dá forense se
//   acontecer. Fechar 100% exigiria as ~10 skills light escreverem via MCP em vez de fs —
//   registrado como follow-up (11-autocritica-e-follow-ups.md #2), NÃO feito aqui.
// - **Bash**: `sed`/`>`/`cat` dentro de Bash NÃO passam por este hook (só as tools Write/Edit).
//   Fecha ~95% do caminho real; o resto é fechado por instrução (CLAUDE.md + skills) e auditado
//   pelo carimbo `statusBy` do WS-2.
// - **pid reuse**: o lock guarda pid; um pid reciclado por outro processo poderia parecer vivo.
//   Mitigado no Linux por uma checagem de /proc/<pid>/cmdline (node/next/bun); na dúvida o hook
//   NO-OPa (fail-open — nunca bloqueia por engano).
//
// Interface (auto-descoberta por ../../runner.js):
//   module.exports = { name, test(input) -> null | { rule, message, fix } }
// O par em pre-write/ delega para este arquivo (Write e Edit têm o mesmo `file_path`).

const fs = require('fs');
const path = require('path');

/** Env que o engine injeta em TODO spawn de run (engine.ts) — a isenção da lane light (G3). */
const RUN_MARKER_ENV = 'STORYMAP_AUTORUN_RUN_ID';
/** Flag file (ao lado do service.lock, no checkout do serviço) que LIGA o lacre do `<repo>-stage`. */
const STAGE_SEAL_FLAG = ['storymap', '.runner', 'stage-seal.on'];
/** O lock que o serviço escreve no boot: {pid, port, startedAt}. Presença + pid vivo = "aqui roda o serviço". */
const SERVICE_LOCK = ['storymap', '.runner', 'service.lock'];
/** Prefixo (relativo à raiz do checkout) do board-data. */
const BOARD_DATA_PREFIX = 'storymap/boards/';

const MAX_WALK = 40; // teto de subida de diretório — nenhum caminho real chega perto

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Resolve symlinks do ancestral existente mais profundo e re-anexa a cauda inexistente.
 * Um Write cria arquivo NOVO (realpath do alvo falha), e um symlink apontando para dentro do
 * checkout runtime não pode virar bypass. Best-effort: na dúvida devolve o path resolvido.
 */
function realish(abs) {
  let dir = abs;
  const tail = [];
  for (let i = 0; i < MAX_WALK; i++) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
  return abs;
}

/** Raiz do checkout (dir com `.git`, arquivo OU diretório) que contém `abs` — null se nenhuma. */
function checkoutRootFor(abs) {
  let dir = path.dirname(abs);
  for (let i = 0; i < MAX_WALK; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** pid vivo? EPERM = existe mas não é nosso ⇒ vivo. Linux: /proc/<pid>/cmdline mata o falso-positivo de pid reuse. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    if (cmdline && !/node|next|bun/i.test(cmdline)) return false; // pid reciclado por outro processo
  } catch {
    /* sem /proc (não-Linux) ou sem permissão → confia no kill(0) */
  }
  return true;
}

/**
 * O lock VIVO do checkout `root`, ou null. Retorna { state: 'live'|'stale'|'absent', lock }.
 * 'stale' é reportado separadamente de 'absent' só para poder avisar (o efeito é o mesmo: NO-OP).
 */
function serviceLockState(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, ...SERVICE_LOCK), 'utf8');
  } catch {
    return { state: 'absent', lock: null };
  }
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    return { state: 'stale', lock: null }; // lock ilegível = não dá para provar serviço vivo ⇒ não bloqueia
  }
  const pid = Number(lock && lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { state: 'stale', lock };
  return pidAlive(pid) ? { state: 'live', lock } : { state: 'stale', lock };
}

/**
 * Para um worktree LINKADO, a raiz do checkout PRINCIPAL — lida do arquivo `.git`
 * (`gitdir: <main>/.git/worktrees/<nome>`). null quando `root` é um checkout principal
 * (`.git` é diretório) ou o arquivo não tem a forma esperada.
 */
function mainRootForWorktree(root) {
  const dotGit = path.join(root, '.git');
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (!st.isFile()) return null; // checkout principal
  let content;
  try {
    content = fs.readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+)$/m.exec(content);
  if (!m) return null;
  const gitDir = toPosix(path.resolve(root, m[1].trim()));
  const marker = '/.git/worktrees/';
  const i = gitDir.indexOf(marker);
  if (i === -1) return null;
  return path.resolve(gitDir.slice(0, i));
}

/**
 * `root` é o worktree interno do train do serviço em `mainRoot`? A forma é a de
 * `stageWorktreePath()`: IRMÃO do repo, chamado `<basename(repo)>-<branch>`.
 */
function isTrainStageWorktree(root, mainRoot) {
  if (path.dirname(root) !== path.dirname(mainRoot)) return false;
  return path.basename(root).startsWith(`${path.basename(mainRoot)}-`);
}

function sealEnabled(serviceRoot) {
  return fs.existsSync(path.join(serviceRoot, ...STAGE_SEAL_FLAG));
}

module.exports = {
  name: 'block-runtime-board-writes',
  test(input) {
    try {
      const filePath = input && input.tool_input && input.tool_input.file_path;
      if (!filePath || typeof filePath !== 'string') return null;
      if (!path.isAbsolute(filePath)) return null; // as tools sempre mandam absoluto

      const abs = realish(path.resolve(filePath));
      const root = checkoutRootFor(abs);
      if (!root) return null; // fora de qualquer checkout git → não é board-data nosso

      const rel = toPosix(path.relative(root, abs));

      // ── (A) lacre do worktree interno do train (`<repo>-stage`) — OFF por padrão ─────────
      // ANTES do (B): o lacre cobre a árvore INTEIRA do stage worktree, board-data inclusive. Se o
      // (B) rodasse primeiro, um card dentro do `<repo>-stage` casaria `storymap/boards/**`, não
      // acharia lock ALI (o lock é do checkout do serviço, o irmão) e sairia liberado — furando o
      // lacre exatamente onde a colisão #2 dói. Guarda de regressão: o caso "CARD dentro do worktree
      // do train" em .claude/hooks/tests/block-runtime-board-writes.test.js.
      const mainRoot = mainRootForWorktree(root);
      if (mainRoot && isTrainStageWorktree(root, mainRoot) && serviceLockState(mainRoot).state === 'live' && sealEnabled(mainRoot)) {
        return {
          rule: 'block-runtime-board-writes',
          message:
            `Recusei escrever "${rel}" em ${root} — este é o worktree INTERNO e PERSISTENTE do merge train ` +
            `(stageWorktreePath: é onde o split aplica o código em \`stage\`), não uma superfície de edição.`,
          fix:
            `Peça um worktree de sessão próprio (MCP worktree_open) e integre por worktree_submit. ` +
            `O diretório NUNCA deve ser removido (quebra o train). Desligar o lacre: ` +
            `rm ${path.join(mainRoot, ...STAGE_SEAL_FLAG)}`,
        };
      }

      // ── (B) board-data do checkout que roda o SERVIÇO ────────────────────────────────────
      if (rel.startsWith(BOARD_DATA_PREFIX)) {
        const { state, lock } = serviceLockState(root);
        if (state === 'stale') {
          process.stderr.write(
            `[block-runtime-board-writes] service.lock em ${root} está STALE (pid morto/reciclado/ilegível) — não vou bloquear.\n`,
          );
          return null; // emergência (serviço fora do ar) = edição manual livre, by design
        }
        if (state === 'live') {
          // G3: run sancionado do engine (lane light edita o runtime por design) → permitido.
          if (process.env[RUN_MARKER_ENV]) return null;
          const who = lock && lock.pid ? `pid ${lock.pid}${lock.port ? `, porta ${lock.port}` : ''}` : 'vivo';
          return {
            rule: 'block-runtime-board-writes',
            message:
              `Recusei escrever "${rel}" — este é o checkout RUNTIME do StoryMap (serviço ${who}), ` +
              `e board-data daqui tem UM escritor: o serviço (D4). Escrita direta por fs de agente é ` +
              `last-writer-wins contra ele (o lock de write.ts é in-process).`,
            fix:
              `board-data do checkout runtime é escrito via MCP (update_card / triage_finding / move_card / ` +
              `answer_question / write_sidecar) — nunca fs direto; seu worktree de sessão (worktree_open) pode ` +
              `editar os próprios arquivos normalmente. Emergência: o hook só age com o serviço VIVO.`,
          };
        }
        return null; // sem lock → notebook/worktree/dev local: zero atrito
      }

      return null;
    } catch {
      return null; // qualquer surpresa interna → lenient (nunca bloqueia por bug do hook)
    }
  },
};
