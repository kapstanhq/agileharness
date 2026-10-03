// @ts-nocheck
/**
 * ownership — SINGLE SOURCE of the AgileHarness business-intent authorship model.
 * Pure CommonJS with ZERO imports, so it is ISOMORPHIC: the TS app imports it (typed
 * via ownership.d.ts) AND the pre-write/pre-edit guard hook require()s it directly.
 *
 * Three ownership classes:
 *   human      — o PRD (o documento mais alto do board), a escada estratégica legada
 *                (Posicionamento/Métrica/Resultado-alvo), Canvas, personas, releases; only a human
 *                may change these canonically; a run that tries is BLOCKED.
 *   proposable — future artefacts (ideias) that an agent may PROPOSE by writing
 *                to the proposals/ zone (a path-based flag); a human promotes to
 *                canonical. Writes to proposals/ are always allowed.
 *   agent      — story/tasks/code; runs write here freely.
 */

const OWNER = { HUMAN: 'human', PROPOSABLE: 'proposable', AGENT: 'agent' };

/**
 * Top-level keys of board.yaml that only a human may change canonically.
 * Protects the strategy ladder + canvas + vocab fields owned by the human operator.
 */
const HUMAN_BOARD_FIELDS = ['positioning', 'businessMetric', 'desiredOutcome', 'canvas', 'canvasTags', 'releases', 'personas'];

/**
 * Is this file path in the proposals draft zone?
 * Path-based flag: storymap/boards/<board>/proposals/...
 * Pure (no fs).
 */
function isProposalPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const norm = filePath.split('\\').join('/');
  return /storymap\/boards\/[^/]+\/proposals\//i.test(norm);
}

/**
 * Is this a board.yaml path (the canonical file containing human-owned fields)?
 * storymap/boards/<board>/board.yaml
 */
function isBoardYamlPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const norm = filePath.split('\\').join('/');
  return /storymap\/boards\/[^/]+\/board\.yaml$/i.test(norm);
}

/**
 * Is this the PRD of a board? `storymap/boards/<board>/docs/prd.md`.
 *
 * Ele é owner:human pelo mesmo motivo que a escada estratégica que ele absorveu — só que a aposta é
 * MAIOR: o PRD é o documento mais alto do board, e todo card, toda priorização e todo run herdam o
 * texto dele como contexto. Um run que o reescreve muda o norte de tudo que vier depois, e muda
 * calado.
 *
 * A régua cobre o caminho que um run de fato usa: um `harness-*` sancionado edita o checkout de
 * runtime por Write/Edit (é a isenção da lane light), e o hook que chama esta função é o que
 * intercepta isso. A conversa da TELA não passa por aqui — ela escreve pelo servidor (`write_doc` →
 * `writeSchemaDoc`), com o humano olhando. É essa assimetria que dá "o chat escreve, o headless
 * propõe" sem precisar de uma classe de risco nova.
 */
function isPrdDocPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const norm = filePath.split('\\').join('/');
  return /storymap\/boards\/[^/]+\/docs\/prd\.md$/i.test(norm);
}

/**
 * Is this a card path (owner:agent territory)?
 * storymap/boards/<board>/cards/<id>.md
 */
function isCardPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const norm = filePath.split('\\').join('/');
  return /storymap\/boards\/[^/]+\/cards\/[^/]+\.md$/i.test(norm);
}

/**
 * Evaluate whether a write is authorised given the run context.
 *
 * @param {object} params
 * @param {string} params.filePath  - absolute or relative path being written
 * @param {string|null} params.board - board id (informational, for the message)
 * @param {object|null} params.beforeYaml - js-yaml parsed board.yaml BEFORE the write (null = new file)
 * @param {object|null} params.afterYaml  - js-yaml parsed board.yaml AFTER  the write
 * @param {string|null} params.runId      - AGILEHARNESS_AUTORUN_RUN_ID from env
 * @returns {null | { owner: string, fields: string[], message: string, fix: string }}
 *   null  → write is allowed.
 *   object → write is blocked (owner:human violated).
 */
function evaluateOwnerGuard({ filePath, board, beforeYaml, afterYaml, runId }) {
  if (!filePath) return null;

  // proposals/ zone → owner:proposable rascunho → always allow (AC2).
  if (isProposalPath(filePath)) return null;

  // O PRD → owner:human. Bloqueia ANTES do recorte de board.yaml porque ele não é board.yaml: é o
  // documento markdown que absorveu a escada estratégica, e sem esta linha ele cairia no `allow`
  // genérico de "qualquer caminho que não é board.yaml".
  if (isPrdDocPath(filePath)) {
    const runLabel = runId ?? '(unknown run)';
    return {
      owner: OWNER.HUMAN,
      fields: ['prd'],
      message: `run ${runLabel} tentou reescrever o PRD (${filePath}). O PRD é o documento mais alto do board — todo card, toda priorização e todo run herdam o texto dele como contexto, e mudá-lo por um run muda o norte de tudo que vier depois, calado.`,
      fix: `Proponha a mudança com a tool MCP \`propose_change\` (artifact: "prd", field: <chave da seção>) — ela vira um rascunho que o humano aprova no Inbox. Para escrever DIRETO, use a conversa da tela do PRD (/board/<board>/prd), onde o humano está olhando.`,
    };
  }

  // cards/*.md or any non-board path → owner:agent → allow (AC4).
  if (!isBoardYamlPath(filePath)) return null;

  // board.yaml — check whether any human-owned field changed.
  if (!afterYaml || typeof afterYaml !== 'object') return null; // unparseable → lenient

  const before = (beforeYaml && typeof beforeYaml === 'object') ? beforeYaml : {};
  const changedFields = [];

  for (const field of HUMAN_BOARD_FIELDS) {
    const prev = JSON.stringify(before[field] ?? null);
    const next = JSON.stringify(afterYaml[field] ?? null);
    if (prev !== next) changedFields.push(field);
  }

  if (changedFields.length === 0) return null; // only non-human fields changed → allow (AC4-like)

  // A run is trying to change a human-owned field → block (AC1).
  const runLabel = runId ?? '(unknown run)';
  const fieldList = changedFields.join(', ');
  return {
    owner: OWNER.HUMAN,
    fields: changedFields,
    message: `run ${runLabel} tentou modificar campo(s) owner:human em board.yaml: [${fieldList}]. Apenas humanos podem alterar artefatos de intenção de negócio canonicamente.`,
    fix: `Reverta a alteração em [${fieldList}] ou escreva em storymap/boards/<board>/proposals/ (zona de rascunho) se quiser propor uma mudança para aprovação humana.`,
  };
}

module.exports = { OWNER, HUMAN_BOARD_FIELDS, isProposalPath, isBoardYamlPath, isPrdDocPath, isCardPath, evaluateOwnerGuard };
